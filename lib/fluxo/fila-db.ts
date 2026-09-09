// A FIACAO da fila de execucao adiada: banco, fuso e provedor.
//
// Frente P, 31/08/2026. A DECISAO toda mora em `lib/fluxo/fila.ts` (puro, porta
// injetada, provavel em node solto). Este arquivo praticamente nao decide nada:
// ele monta a `PortaFila` que fala com o Postgres e com as acoes do motor, e
// obedece. E o que permite provar a corrida entre dois ticks em memoria.
//
// ================== CONTRATO DE SEGURANCA (leia antes de chamar) ==================
// Igual ao motor inline (lib/fluxo/executar.ts): este modulo NAO checa permissao.
// Quem ENFILEIRA autoriza ANTES (a rota faz getUser + getPerfil + podeVerConversa
// + restricaoEfetiva, exatamente como /api/macros), e o usuario autorizado fica
// GRAVADO na linha da fila — o tick roda em nome dele, dias depois, sem
// reautorizar. Consequencia declarada: tirar a permissao de alguem NAO cancela o
// que ele ja enfileirou; cancelar e gesto explicito (`cancelarCadeia`). O tick em
// si e autorizado pela rota (bearer do cron OU admin), como o do disparo.
// ==================================================================================
//
// DEGRADACAO: sem a migration 0018 (gesto humano, como sempre), TODA funcao daqui
// devolve `{ disponivel: false, aviso }` em vez de 500 — mesma promessa de
// /api/macros antes da 0008.

import { msgDb } from "@/lib/mensageria";
import { getConfig, fusoDaConfig } from "@/lib/config";
import { relogioDoFuso } from "@/lib/fluxo/fila-relogio";
import {
  coletarFatos,
  executarAcao,
  inserirTrilha,
  linhaDeTrilha,
  motivoParaRecusar,
  type ContextoExecucao,
} from "@/lib/fluxo/executar";
import {
  assinaturaDoNo,
  avaliarNoDeCondicao,
  executarTickFila,
  motivoParaNaoEnfileirar,
  ESTADOS_VIVOS,
  LIMITE_RESERVA_MS,
  PASSOS_POR_TICK,
  proximoPasso,
  type EstadoFila,
  type ItemFila,
  type PortaFila,
  type ProximoPasso,
  type RelogioFila,
  type ResultadoNoFila,
  type ResumoTickFila,
} from "@/lib/fluxo/fila";
import {
  limitesDoFluxo,
  ordemDeExecucao,
  validarFluxo,
  type Fluxo,
  type No,
} from "@/lib/fluxo/schema";

/** Orcamento de tempo da rodada (maxDuration da rota do tick e 60s). */
const ORCAMENTO_MS = 45_000;

const COLS_FILA =
  "id,execucao_id,fluxo_id,fluxo_slug,canal,chat_id,no_id,estado,disponivel_em,origem," +
  "usuario_id,usuario_nome,tentativas,reservado_em,erro,aviso,aprovacao_no_id,aprovacao_decisao," +
  "aprovacao_assinatura,aprovado_por_id,aprovado_por_nome,aprovado_em,aprovado_via," +
  "criada_em,atualizada_em";

export const AVISO_SEM_MIGRATION =
  "fila de automacao indisponivel (a migration 0018 ja foi aplicada nesta instalacao?)";

const agoraIso = () => new Date().toISOString();

/** Erro de tabela/coluna ausente — a 0018 nao rodou nesta instalacao. */
function semTabela(error: unknown): boolean {
  const codigo = (error as any)?.code;
  return codigo === "42P01" || codigo === "PGRST205" || codigo === "42501" || codigo === "PGRST204";
}

/** Violacao do indice unico parcial `uq_fluxo_fila_viva`. */
function jaExisteViva(error: unknown): boolean {
  return (error as any)?.code === "23505";
}

// ------------------------------------------------------------------ relogio
// O relogio mora em `lib/fluxo/fila-relogio.ts` (importa SO lib/fuso.ts) pra
// poder ser provado em node solto — a conversao de fuso e a parte mais facil de
// errar aqui. Re-exportado pra quem so conhece este arquivo nao precisar saber.
export { relogioDoFuso } from "@/lib/fluxo/fila-relogio";

export async function fusoDaInstalacao(): Promise<string> {
  return fusoDaConfig(await getConfig());
}

// ------------------------------------------------------------- enfileirar

export type ResultadoEnfileirar =
  | { ok: true; execucao_id: string; item_id: string; primeiro_no: string; disponivel_em: string }
  | { ok: false; erro: string; http: number };

/**
 * Coloca um fluxo na fila pra rodar nesta conversa.
 *
 * ORDEM DAS CHECAGENS, e cada uma tem um motivo:
 *  1. PREFLIGHT do canal e das acoes (modo `fila`): macro pela metade e pior que
 *     macro recusado, e isso vale em dobro aqui — na fila a mensagem sairia dias
 *     depois, sem ninguem olhando.
 *  2. LIMITES por conversa (`maximo_por_conversa`, `intervalo_minimo_segundos`).
 *  3. O INSERT, protegido pelo indice unico parcial: a checagem de "ja tem cadeia
 *     viva" da passo 2 e read-then-write e cabe uma corrida no meio; o 23505 do
 *     banco fecha a janela e vira a MESMA mensagem.
 */
export async function enfileirarFluxo(
  fluxo: Fluxo,
  ctx: ContextoExecucao
): Promise<ResultadoEnfileirar> {
  const recusa = motivoParaRecusar(fluxo, ctx.canal, "fila");
  if (recusa) return { ok: false, erro: recusa, http: 400 };

  const fuso = await fusoDaInstalacao();
  const relogio = relogioDoFuso(fuso);

  // o PRIMEIRO passo ja nasce com a hora marcada: um fluxo que comeca com espera
  // de 2 dias nao ocupa a fila hoje, ele dorme
  const primeiro = proximoPasso(fluxo, null, relogio.agora(), relogio);
  if (!primeiro) {
    return { ok: false, erro: "o fluxo nao tem nenhum passo executavel na corrente", http: 400 };
  }

  const limites = limitesDoFluxo(fluxo);
  const precisaHistorico = limites.maximo_por_conversa !== null || limites.intervalo_minimo_segundos > 0;
  const hist = await historicoDaConversa(fluxo.id, ctx.canal, ctx.chat_id, precisaHistorico);
  if (!hist.ok) return { ok: false, erro: hist.erro, http: hist.http };
  const motivo = motivoParaNaoEnfileirar(limites, hist.historico, relogio.agora());
  if (motivo) return { ok: false, erro: motivo, http: 409 };

  const execucaoId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const { data, error } = await msgDb()
    .from("fluxo_fila")
    .insert({
      execucao_id: execucaoId,
      fluxo_id: ctx.fluxo_id ?? null,
      fluxo_slug: fluxo.id,
      canal: ctx.canal,
      chat_id: ctx.chat_id,
      no_id: primeiro.no_id,
      estado: "agendado",
      disponivel_em: new Date(primeiro.disponivel_em).toISOString(),
      origem: ctx.origem ?? "manual",
      usuario_id: ctx.usuario.id || null,
      usuario_nome: ctx.usuario.nome,
    })
    .select("id,disponivel_em")
    .maybeSingle();

  if (error) {
    if (jaExisteViva(error)) {
      return {
        ok: false,
        erro: "este fluxo ja esta em andamento nesta conversa (cancele a execucao anterior pra rodar de novo)",
        http: 409,
      };
    }
    if (semTabela(error)) return { ok: false, erro: AVISO_SEM_MIGRATION, http: 503 };
    return { ok: false, erro: "nao deu pra enfileirar a execucao", http: 503 };
  }

  return {
    ok: true,
    execucao_id: execucaoId,
    item_id: (data as any)?.id,
    primeiro_no: primeiro.no_id,
    disponivel_em: (data as any)?.disponivel_em ?? new Date(primeiro.disponivel_em).toISOString(),
  };
}

/**
 * Historico desta conversa com ESTE fluxo, pros limites.
 *
 * FAIL-CLOSED: quando os limites estao configurados e a consulta falha, NAO
 * enfileira. Limite que desaparece quando o banco tosse nao e limite — e a mesma
 * licao do teto diario do disparo ("freio que falha aberto nao e freio"). Quando
 * o fluxo NAO tem limite nenhum, a consulta de contagem nem acontece; so a de
 * cadeia viva, que e barata e obrigatoria.
 */
async function historicoDaConversa(
  slug: string,
  canal: string,
  chatId: string,
  precisaContagem: boolean
): Promise<
  | { ok: true; historico: { execucoes: number; ultima_em: string | null; viva: boolean } }
  | { ok: false; erro: string; http: number }
> {
  const db = msgDb();
  const vivas = await db
    .from("fluxo_fila")
    .select("id", { count: "exact", head: true })
    .eq("fluxo_slug", slug)
    .eq("canal", canal)
    .eq("chat_id", chatId)
    .in("estado", ESTADOS_VIVOS as unknown as string[]);
  if (vivas.error) {
    if (semTabela(vivas.error)) return { ok: false, erro: AVISO_SEM_MIGRATION, http: 503 };
    return { ok: false, erro: "nao deu pra conferir se este fluxo ja esta rodando nesta conversa", http: 503 };
  }
  const viva = (vivas.count ?? 0) > 0;
  if (!precisaContagem) return { ok: true, historico: { execucoes: 0, ultima_em: null, viva } };

  // A CONTAGEM SAI DA TRILHA (`fluxo_execucoes`), NAO DA FILA — corrigido na
  // revisao cega de 31/08/2026, e a diferenca e de comportamento, nao de estilo.
  //
  // Contar linhas da FILA contava ENFILEIRAMENTO. Cadeia CANCELADA antes do
  // primeiro passo, e cadeia que morreu sem efeito nenhum, gastavam cota de um
  // limite que existe pra limitar o que o CLIENTE RECEBE. No caso real medido —
  // `maximo_por_conversa: 1`, os 79 dialogos tipo saudacao — um unico
  // cancelamento queimava a cota e a saudacao nunca mais saia naquela conversa,
  // sem ninguem entender por que.
  //
  // A trilha tem linha quando um passo foi PROCESSADO — e `status = "ok"` e o que
  // separa "o cliente recebeu" de "nada saiu". Entao:
  //   - `execucoes`  = quantos `execucao_id` DISTINTOS com passo `ok` deste fluxo
  //     nesta conversa;
  //   - `ultima_em`  = carimbo do ULTIMO PASSO REAL (nao do enfileiramento: numa
  //     regua que comeca com espera de 2 dias, o intervalo minimo "passava" antes
  //     de o primeiro passo sequer rodar).
  //
  // O FILTRO `status = "ok"` E CORRECAO DE UM DEFEITO QUE EU MESMO INTRODUZI no
  // card do passo desligado (86ak85nzy), apontado na revisao cega: a trilha passou
  // a receber linha `pulado`, e sem filtro ela contava igual a um envio. Ou seja:
  // desligar um passo QUEIMAVA a cota de `maximo_por_conversa` sem o cliente
  // receber nada — exatamente o defeito que este bloco existe pra evitar (o caso
  // medido: `maximo_por_conversa: 1` nos 79 dialogos de saudacao, e um cancelamento
  // fazia a saudacao nunca mais sair). `falhou` e `parou` entram no mesmo raciocinio
  // e ja estavam sendo contados: passo que falhou nao entregou mensagem nenhuma.
  //
  // O erro segue ASSIMETRICO DO JEITO CERTO: trilha perdida (ela e melhor-esforco)
  // subestima e deixa rodar de novo, nunca trava a conversa pra sempre.
  //
  // O preco: a trilha e melhor-esforco (ela pode falhar sem derrubar a execucao),
  // entao trilha perdida SUBESTIMA a contagem. Isso e assimetrico do jeito certo —
  // erra pra deixar rodar de novo, nunca pra travar a conversa pra sempre. E erro
  // de LEITURA continua fail-closed (nao enfileira).
  //
  // PostgREST nao tem DISTINCT: lemos os ids com teto e contamos em memoria. Teto
  // alto de proposito (`maximo_por_conversa` chega a 9998); batendo no teto,
  // qualquer limite configurado ja foi alcancado de longe.
  const TETO_IDS = 2000;
  const [linhas, ultima] = await Promise.all([
    db
      .from("fluxo_execucoes")
      .select("execucao_id")
      .eq("fluxo_slug", slug)
      .eq("canal", canal)
      .eq("chat_id", chatId)
      .eq("status", "ok")
      .limit(TETO_IDS),
    db
      .from("fluxo_execucoes")
      .select("criada_em")
      .eq("fluxo_slug", slug)
      .eq("canal", canal)
      .eq("chat_id", chatId)
      .eq("status", "ok")
      .order("criada_em", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (linhas.error || ultima.error) {
    return {
      ok: false,
      erro: "nao deu pra apurar os limites por conversa deste fluxo — nao enfileirei (o limite falha FECHADO)",
      http: 503,
    };
  }
  const distintas = new Set(((linhas.data ?? []) as any[]).map((l) => l.execucao_id));
  return {
    ok: true,
    historico: {
      execucoes: distintas.size,
      ultima_em: (ultima.data as any)?.criada_em ?? null,
      viva,
    },
  };
}

// --------------------------------------------------------------- a porta

function itemDaLinha(row: any): ItemFila {
  return {
    id: row.id,
    execucao_id: row.execucao_id,
    fluxo_slug: row.fluxo_slug,
    fluxo_id: row.fluxo_id ?? null,
    canal: row.canal,
    chat_id: row.chat_id,
    no_id: row.no_id,
    estado: row.estado,
    disponivel_em: row.disponivel_em,
    origem: row.origem === "gatilho" ? "gatilho" : "manual",
    usuario_id: row.usuario_id ?? null,
    usuario_nome: row.usuario_nome ?? null,
    tentativas: row.tentativas ?? 0,
    reservado_em: row.reservado_em ?? null,
    aprovacao_no_id: row.aprovacao_no_id ?? null,
    aprovacao_decisao: row.aprovacao_decisao ?? null,
    aprovacao_assinatura: row.aprovacao_assinatura ?? null,
    // desde quando a linha esta como esta — pra cadeia parada em aval, e desde
    // quando ela espera (a passada de expiracao le daqui)
    atualizada_em: row.atualizada_em ?? null,
  };
}

/**
 * Contexto de execucao a partir da linha da fila.
 *
 * `origem` vem da LINHA e nao de um default: e ela que decide gente x robo no
 * status da conversa (`statusAoResponder` + chave `auto_atendimento_bot`, Frente
 * N). Uma cadeia enfileirada por gatilho conta como ROBO mesmo tendo sido gravada
 * em nome de um usuario — quem apertou o botao naquele passo foi a automacao.
 *
 * `trilha: false` porque a fila grava a trilha PASSO A PASSO (nao existe "fim do
 * macro" aqui) — deixar o executor gravar tambem duplicaria cada linha.
 */
function ctxDoItem(item: ItemFila, fluxo: Fluxo): ContextoExecucao {
  return {
    canal: item.canal,
    chat_id: item.chat_id,
    usuario: { id: item.usuario_id ?? "", nome: item.usuario_nome ?? "automacao" },
    trilha: false,
    fluxo: { slug: fluxo.id, nome: fluxo.nome },
    // o uuid vem da LINHA da fila (gravado no enfileirar) e desce pra trilha
    fluxo_id: item.fluxo_id ?? null,
    origem: item.origem,
  };
}

/**
 * Devolve pra fila as reservas orfas (tick que morreu no meio do passo).
 *
 * O `.or(... is.null ...)` NAO e zelo: sem ele havia um estado ABSORVENTE. Um
 * caminho antigo devolvia a reserva limpando `reservado_em` mas deixando o estado
 * em `executando`; a linha ficava `executando` + carimbo NULO, e um filtro
 * `.lt("reservado_em", limite)` nunca casa com NULL — a cadeia congelava pra
 * sempre, sem erro, sem log e sem jeito de destravar pela tela. Hoje o caminho que
 * criava isso nao existe mais (ver `devolverReserva`), mas a varredura cobre a
 * linha que ja tenha ficado assim em producao, e cobre qualquer caminho futuro que
 * esqueca o carimbo. Reserva sem carimbo e reserva podre — a mesma regra que
 * `reservaExpirada` ja aplicava no lado puro.
 */
export async function liberarReservasOrfas(): Promise<number> {
  const limite = new Date(Date.now() - LIMITE_RESERVA_MS).toISOString();
  const { data, error } = await msgDb()
    .from("fluxo_fila")
    .update({ estado: "agendado", reservado_em: null, atualizada_em: agoraIso() })
    .eq("estado", "executando")
    .or(`reservado_em.is.null,reservado_em.lt.${limite}`)
    .select("id");
  if (error) return 0;
  return (data ?? []).length;
}

async function montarPorta(relogio: RelogioFila): Promise<PortaFila> {
  const db = msgDb();
  // cache de fluxo POR RODADA: uma fila com 20 passos da mesma regua leria o
  // mesmo jsonb 20 vezes
  const cache = new Map<string, { fluxo: Fluxo; ativo: boolean } | null>();

  return {
    async candidatos(limite) {
      // ORDEM: `disponivel_em` PRIMEIRO (FIFO por hora), depois canal/chat/criacao
      // pra desempatar. A ordem segue TOTAL e deterministica — e isso que faz dois
      // ticks escolherem o MESMO item por conversa e colidirem no claim (licao do
      // rodizio da Frente N) — mas quem chega antes na fila sai antes.
      // A versao anterior ordenava por canal antes da hora, e isso atendia a fila
      // por ordem ALFABETICA de conversa: com fila maior que o teto da rodada, o
      // passo das 08:00 de um chat "z..." ficava atras de tudo e podia nao rodar
      // nunca. De quebra, agora o indice `idx_fluxo_fila_tick (estado,
      // disponivel_em)` da 0018 serve esta consulta em vez de ser ignorado.
      const { data, error } = await db
        .from("fluxo_fila")
        .select(COLS_FILA)
        .eq("estado", "agendado")
        .lte("disponivel_em", agoraIso())
        .order("disponivel_em", { ascending: true })
        .order("canal", { ascending: true })
        .order("chat_id", { ascending: true })
        .order("criada_em", { ascending: true })
        .limit(limite);
      if (error) return [];
      return (data ?? []).map(itemDaLinha);
    },

    async reservar(item) {
      // CLAIM ATOMICO: so roda o que este UPDATE devolver. Dois ticks
      // simultaneos — exatamente um vence.
      const { data } = await db
        .from("fluxo_fila")
        .update({ estado: "executando", reservado_em: agoraIso(), atualizada_em: agoraIso() })
        .eq("id", item.id)
        .eq("estado", "agendado")
        .select(COLS_FILA);
      const linha = (data ?? [])[0];
      return linha ? itemDaLinha(linha) : null;
    },

    // As cadeias PARADAS em aval. Sem `disponivel_em` no filtro: elas nao estao
    // esperando hora, estao esperando gente — e o tick so mexe nelas quando o
    // passo do aval foi desligado (a decisao mora em `fila.ts`). Ordem
    // deterministica pelo mesmo motivo do laco principal: dois ticks escolhem o
    // MESMO item por conversa e colidem no claim.
    async candidatosAguardandoAval(limite) {
      const { data, error } = await db
        .from("fluxo_fila")
        .select(COLS_FILA)
        .eq("estado", "aguardando_aprovacao")
        .order("atualizada_em", { ascending: true })
        .order("canal", { ascending: true })
        .order("chat_id", { ascending: true })
        .limit(limite);
      if (error) return [];
      return (data ?? []).map(itemDaLinha);
    },

    async reservarAguardandoAval(item) {
      // O `eq("estado", "aguardando_aprovacao")` E a trava: se alguem aprovou,
      // recusou ou cancelou entre a leitura e agora, o update nao casa e este tick
      // nao toca na cadeia — a decisao humana vence sempre.
      const { data } = await db
        .from("fluxo_fila")
        .update({ estado: "executando", reservado_em: agoraIso(), atualizada_em: agoraIso() })
        .eq("id", item.id)
        .eq("estado", "aguardando_aprovacao")
        .select(COLS_FILA);
      const linha = (data ?? [])[0];
      return linha ? itemDaLinha(linha) : null;
    },

    async carregarFluxo(slug) {
      if (cache.has(slug)) return cache.get(slug)!;
      const { data, error } = await db
        .from("fluxos")
        .select("fluxo,ativo")
        .eq("slug", slug)
        .maybeSingle();
      let resultado: { fluxo: Fluxo; ativo: boolean } | null = null;
      if (!error && data) {
        const v = validarFluxo((data as any).fluxo);
        // fluxo que virou invalido depois de gravado (importacao, edicao por
        // fora): a cadeia falha com motivo, nunca roda "o que ainda da"
        if (v.ok) resultado = { fluxo: v.fluxo, ativo: (data as any).ativo !== false };
      }
      cache.set(slug, resultado);
      return resultado;
    },

    async estadoAtual(item) {
      const { data, error } = await db.from("fluxo_fila").select("estado").eq("id", item.id).maybeSingle();
      // ERRO DE LEITURA e "nao sei", nao "cancelado" — a distincao existe porque as
      // consequencias sao opostas. Tratado como cancelado, o passo era abandonado E
      // a reserva ficava `executando` com carimbo nulo, fora do alcance da
      // varredura de orfas: uma piscada do banco congelava a regua pra sempre.
      if (error) return { ok: false as const, erro: error.message || "leitura da fila falhou" };
      // linha que SUMIU e diferente: isso nao volta, e nada mais pode rodar nela.
      if (!data) return { ok: true as const, estado: "cancelado" };
      return { ok: true as const, estado: (data as any).estado };
    },

    async jaExecutado(item, no) {
      // IDEMPOTENCIA: a trilha ja tem passo EXECUTADO COM SUCESSO pra
      // (execucao_id, no_id)? Entao o efeito ja saiu e o tick anterior morreu na
      // janela entre gravar a trilha e avancar o `no_id`.
      //
      // `.eq("status", "ok")` NAO E DETALHE — sem ele esta consulta contava
      // QUALQUER linha do par (execucao_id, no_id), e a trilha tem mais de um tipo
      // de linha pro MESMO par. Dois estragos, os dois silenciosos:
      //
      //  - `pulado`: e a linha que `pararParaAprovacao` grava quando a cadeia para
      //    pra esperar aval. Depois de APROVADO, o tick perguntava "ja rodou?",
      //    achava a linha da parada e AVANCAVA sem executar: 100% das aprovacoes
      //    viravam mensagem que nunca sai — o oposto exato do que aprovar significa;
      //  - `falhou`: a linha da tentativa que deu erro. Contada aqui, o retry virava
      //    SKIP e `MAX_TENTATIVAS_PASSO` + o recuo progressivo eram codigo morto.
      //
      // O fake da prova (scripts/prova-motor-fila.ts) sempre teve a semantica certa
      // (`t.status === "ok"`); era a fiacao que divergia — por isso agora existe
      // assertion de FONTE exigindo este `.eq` aqui.
      const { count, error } = await db
        .from("fluxo_execucoes")
        .select("id", { count: "exact", head: true })
        .eq("execucao_id", item.execucao_id)
        .eq("no_id", no.id)
        .eq("status", "ok");
      // erro de leitura devolve FALSE (re-executa). A garantia declarada e
      // at-least-once: pular um passo que talvez nao tenha rodado deixaria o
      // cliente sem a mensagem, em silencio — pior que a duplicata que esta
      // checagem existe pra evitar na maioria dos casos.
      if (error) return false;
      return (count ?? 0) > 0;
    },

    async executarNo(item, no) {
      const carregado = cache.get(item.fluxo_slug);
      const fluxo = carregado?.fluxo;
      if (!fluxo) return { status: "falhou", acao: "?", detalhe: "fluxo indisponivel no meio da execucao" };
      const ctx = ctxDoItem(item, fluxo);

      if (no.tipo === "condicao") {
        // CONDICAO REAVALIADA AGORA, com o dado de hoje — nunca com o do
        // agendamento (docs/mapa/04 secao 6)
        const r = await avaliarNoDeCondicao(no, (campos) => coletarFatos(ctx, new Set(campos)));
        if (r.status === "falhou") return { status: "falhou", acao: "condicao", detalhe: r.detalhe };
        return { status: r.segue ? "ok" : "parou", acao: "condicao", detalhe: r.detalhe };
      }
      if (!no.acao) return { status: "falhou", acao: no.tipo, detalhe: `no de tipo ${no.tipo} sem acao` };
      try {
        const efeito = await executarAcao(ctx, no.acao);
        return {
          status: "ok",
          acao: no.acao.tipo,
          detalhe: efeito.detalhe,
          mensagem_id: efeito.mensagem_id ?? null,
        };
      } catch (e: any) {
        return { status: "falhou", acao: no.acao.tipo, detalhe: e?.message || "falha" };
      }
    },

    async registrarPasso(item, no, r) {
      const carregado = cache.get(item.fluxo_slug);
      if (!carregado) return;
      const ctx = ctxDoItem(item, carregado.fluxo);
      try {
        await inserirTrilha([
          linhaDeTrilha(ctx, item.fluxo_slug, item.execucao_id, {
            no_id: no.id,
            acao: r.acao,
            // "parou" na fila e a condicao falsa: no percurso inline isso e um
            // passo `ok` com o detalhe explicando. Manter o MESMO vocabulario na
            // trilha, senao o mesmo evento aparece de dois jeitos.
            // `pulado` NAO pode virar `ok`: a trilha diria que o passo rodou, e a
            // idempotencia (`jaExecutado`, que filtra status=ok) passaria a tratar
            // passo religado como ja executado.
            status: r.status === "falhou" ? "falhou" : r.status === "pulado" ? "pulado" : "ok",
            detalhe: r.detalhe,
            mensagem_id: r.mensagem_id ?? null,
          }),
        ]);
      } catch {
        /* sem trilha, mas o passo rodou */
      }
    },

    async pararParaAprovacao(item, no, motivo) {
      await db
        .from("fluxo_fila")
        .update({
          estado: "aguardando_aprovacao",
          aprovacao_no_id: no.id,
          // limpa decisao antiga: a decisao e POR PASSO e por CONTEUDO. Um
          // "aprovado" que sobrasse do passo anterior — ou da versao anterior
          // DESTE passo, antes de alguem edita-lo — liberaria este sem ninguem
          // olhar.
          aprovacao_decisao: null,
          aprovacao_assinatura: null,
          aprovado_por_id: null,
          aprovado_por_nome: null,
          aprovado_em: null,
          aprovado_via: null,
          // AVISO, nao ERRO: parar pra esperar aval e comportamento normal do fluxo.
          // Escrito em `erro`, isto pintava de vermelho na tela E apagava a ultima
          // falha real da cadeia — que e a informacao que alguem ia querer ler.
          aviso: motivo.slice(0, 500),
          reservado_em: null,
          atualizada_em: agoraIso(),
        })
        .eq("id", item.id)
        .eq("estado", "executando");

      // A PARADA VAI PRA TRILHA. Sem esta linha, "aprovei e o passo voltou a pedir
      // aval" e um mistero pro supervisor: nada em lugar nenhum diria que o fluxo
      // foi editado no meio. Melhor-esforco, como toda gravacao de trilha.
      const carregado = cache.get(item.fluxo_slug);
      if (!carregado) return;
      try {
        await inserirTrilha([
          linhaDeTrilha(ctxDoItem(item, carregado.fluxo), item.fluxo_slug, item.execucao_id, {
            no_id: no.id,
            acao: no.acao?.tipo ?? no.tipo,
            // `pulado`: o passo NAO rodou. Marcar `ok` faria a trilha dizer que a
            // acao aconteceu, e `falhou` acusaria defeito onde houve espera.
            status: "pulado",
            detalhe: motivo,
          }),
        ]);
      } catch {
        /* sem trilha, mas a cadeia parou certo */
      }
    },

    async agendar(item, prox) {
      await db
        .from("fluxo_fila")
        .update({
          no_id: prox.no_id,
          estado: "agendado",
          disponivel_em: new Date(prox.disponivel_em).toISOString(),
          tentativas: 0,
          reservado_em: null,
          erro: null,
          aviso: null,
          atualizada_em: agoraIso(),
        })
        .eq("id", item.id)
        .eq("estado", "executando");
    },

    async encerrar(item, estado, motivo) {
      await db
        .from("fluxo_fila")
        .update({
          estado,
          erro: motivo ? motivo.slice(0, 500) : null,
          // a cadeia acabou: o aviso de "esperando aval" nao faz mais sentido
          // (mesma limpeza que `cancelarCadeia` faz — vale pro aval EXPIRADO)
          aviso: null,
          reservado_em: null,
          atualizada_em: agoraIso(),
        })
        .eq("id", item.id)
        // GUARDA DE ESTADO em todo update, igual ao disparo: sem `.eq`, uma cadeia
        // CANCELADA no meio do passo voltaria a `concluido` e o cancelamento
        // sumiria do registro.
        .eq("estado", "executando");
    },

    async reagendarPorFalha(item, tentativas, erro, quando) {
      await db
        .from("fluxo_fila")
        .update({
          estado: "agendado",
          tentativas,
          erro: erro.slice(0, 500),
          disponivel_em: new Date(quando).toISOString(),
          reservado_em: null,
          atualizada_em: agoraIso(),
        })
        .eq("id", item.id)
        .eq("estado", "executando");
    },

    async devolverReserva(item, opcoes) {
      // `limparCarimbo: false` = NAO MEXE NA LINHA. E o caso do erro de leitura:
      // como nao se sabe o que aconteceu, o carimbo tem que continuar de pe pra a
      // varredura de orfas retomar em 5 min. Era exatamente aqui que a cadeia
      // congelava — limpava o carimbo e deixava o estado `executando`, um estado
      // que nada mais alcancava.
      if (!opcoes.limparCarimbo) return;
      await db
        .from("fluxo_fila")
        .update({ reservado_em: null, atualizada_em: agoraIso() })
        .eq("id", item.id)
        .eq("estado", "executando");
      // NAO volta pra `agendado` de proposito: quem interrompeu (cancelar,
      // recusar) JA gravou o estado dele, e sobrescrever aqui apagaria a decisao.
    },

    relogio,
  };
}

// ---------------------------------------------------------------- o tick

export type ResultadoTick =
  | ({ ok: true; orfas: number } & ResumoTickFila)
  | { ok: false; erro: string };

export async function processarTickFluxos(): Promise<ResultadoTick> {
  // a tabela existe? uma leitura barata evita 500 quando a 0018 nao rodou
  const sonda = await msgDb().from("fluxo_fila").select("id", { count: "exact", head: true }).limit(1);
  if (sonda.error) {
    return { ok: false, erro: semTabela(sonda.error) ? AVISO_SEM_MIGRATION : "fila indisponivel" };
  }

  const orfas = await liberarReservasOrfas();
  const cfg = await getConfig();
  const porta = await montarPorta(relogioDoFuso(fusoDaConfig(cfg)));
  const resumo = await executarTickFila(porta, {
    passos: PASSOS_POR_TICK,
    orcamentoMs: ORCAMENTO_MS,
    // 0 = nunca expira (default); a instalacao muda em Configuracoes > Regras automaticas
    aprovacaoExpiraHoras: cfg.aprovacao_expira_horas,
  });
  return { ok: true, orfas, ...resumo };
}

// ------------------------------------------------------- leitura pra tela

export type ItemFilaTela = ItemFila & {
  fluxo_nome: string | null;
  criada_em: string;
  atualizada_em: string;
  erro: string | null;
  /** por que esta parada SEM erro (hoje: o motivo da parada pra aval) */
  aviso: string | null;
  aprovado_por_nome: string | null;
  aprovado_em: string | null;
};

export type Listagem =
  | { ok: true; itens: ItemFilaTela[] }
  | { ok: false; aviso: string };

/**
 * Lista a fila. Sem filtro, traz o que esta VIVO (o que uma pessoa pode agir
 * sobre) — cadeia concluida vira historico e sai por `estados` explicito, senao a
 * tela de aprovacao nasceria com mil linhas de coisa ja resolvida.
 */
export async function listarFila(filtro: {
  canal?: string;
  chat_id?: string;
  estados?: EstadoFila[];
  limite?: number;
}): Promise<Listagem> {
  const db = msgDb();
  let q = db
    .from("fluxo_fila")
    .select(COLS_FILA)
    .order("disponivel_em", { ascending: true })
    .limit(Math.min(500, Math.max(1, filtro.limite ?? 200)));
  if (filtro.canal) q = q.eq("canal", filtro.canal);
  if (filtro.chat_id) q = q.eq("chat_id", filtro.chat_id);
  q = q.in("estado", (filtro.estados?.length ? filtro.estados : ESTADOS_VIVOS) as unknown as string[]);

  const { data, error } = await q;
  if (error) return { ok: false, aviso: semTabela(error) ? AVISO_SEM_MIGRATION : "fila indisponivel" };

  const linhas = (data ?? []) as any[];
  // nome do fluxo pra tela: a fila guarda o SLUG (identidade estavel), o nome
  // muda. Ler os nomes num lote so.
  const slugs = [...new Set(linhas.map((l) => l.fluxo_slug))];
  const nomes = new Map<string, string>();
  if (slugs.length) {
    const { data: fx } = await db.from("fluxos").select("slug,nome").in("slug", slugs.slice(0, 200));
    for (const f of fx ?? []) nomes.set((f as any).slug, (f as any).nome);
  }

  return {
    ok: true,
    itens: linhas.map((l) => ({
      ...itemDaLinha(l),
      fluxo_nome: nomes.get(l.fluxo_slug) ?? null,
      criada_em: l.criada_em,
      atualizada_em: l.atualizada_em,
      erro: l.erro ?? null,
      aviso: l.aviso ?? null,
      aprovado_por_nome: l.aprovado_por_nome ?? null,
      aprovado_em: l.aprovado_em ?? null,
    })),
  };
}

// ------------------------------------------------------------- aprovacao

/**
 * A assinatura do no em que a cadeia parou — o que a aprovacao vai carimbar.
 *
 * Melhor-esforco por decisao: qualquer tropeco (fila indisponivel, fluxo apagado,
 * passo que saiu da corrente depois de uma edicao) devolve `null`, e null e
 * tratado como DIVERGENTE por `precisaAprovacao`. Ou seja: o pior caso e o passo
 * parar pra pedir aval outra vez, nunca mandar mensagem sem aval.
 */
async function assinaturaAprovada(itemId: string): Promise<string | null> {
  try {
    const db = msgDb();
    const { data: linha, error } = await db
      .from("fluxo_fila")
      .select("fluxo_slug,aprovacao_no_id,no_id")
      .eq("id", itemId)
      .maybeSingle();
    if (error || !linha) return null;
    const l = linha as any;
    const alvo: string | null = l.aprovacao_no_id ?? l.no_id ?? null;
    if (!alvo) return null;

    const { data: fx, error: e2 } = await db
      .from("fluxos")
      .select("fluxo")
      .eq("slug", l.fluxo_slug)
      .maybeSingle();
    if (e2 || !fx) return null;
    const v = validarFluxo((fx as any).fluxo);
    if (!v.ok) return null;
    // busca na CORRENTE, nao em `fluxo.nos`: passo orfao (fora do encadeamento) nao
    // roda, e assinar um no que o tick nunca vai executar seria carimbo morto.
    const no = ordemDeExecucao(v.fluxo).find((n) => n.id === alvo);
    return no ? assinaturaDoNo(no) : null;
  } catch {
    return null;
  }
}

export type ResultadoDecisao =
  | { ok: true; estado: EstadoFila; disponivel_em: string | null }
  | { ok: false; erro: string; http: number };

/**
 * Aprova ou recusa o passo em que a cadeia parou.
 *
 * QUEM APROVOU FICA GRAVADO — e o criterio de aceite do card. E a decisao e
 * carimbada no PASSO (`aprovacao_no_id` ja esta na linha): aprovar aqui libera o
 * passo que pediu aval, nunca o proximo que tambem pedir.
 *
 * O update leva `.eq("estado", "aguardando_aprovacao")`: dois supervisores
 * clicando juntos, ou um clique depois de o tick ter mexido na linha, nao gravam
 * duas decisoes — o segundo recebe 409 em vez de sobrescrever o primeiro.
 *
 * A APROVACAO CARIMBA O CONTEUDO, nao so o endereco do passo: junto da decisao vai
 * a `aprovacao_assinatura` (impressao digital do no, `assinaturaDoNo`). Editar o
 * passo depois muda a assinatura, e o tick para pra pedir aval de novo em vez de
 * mandar pro cliente um texto que ninguem leu. Se nao der pra calcular a
 * assinatura agora (fluxo ilegivel, passo que saiu da corrente), a decisao e
 * gravada SEM ela — e `precisaAprovacao` trata assinatura ausente como
 * divergente, ou seja, o passo vai parar de novo. Fail-closed nas duas pontas.
 *
 * A VIA da decisao tambem fica gravada (`aprovado_via: "sessao"`). Hoje o gate esta
 * na rota, que recusa chave de API; a coluna e o que permite PROVAR isso na
 * auditoria depois, sem depender de alguem lembrar que a regra existia.
 */
export async function decidirAprovacao(
  itemId: string,
  decisao: "aprovado" | "recusado",
  quem: { id: string; nome: string },
  via: "sessao" = "sessao"
): Promise<ResultadoDecisao> {
  const db = msgDb();
  const agora = agoraIso();
  const assinatura = decisao === "aprovado" ? await assinaturaAprovada(itemId) : null;
  const patch: Record<string, unknown> =
    decisao === "aprovado"
      ? {
          estado: "agendado",
          aprovacao_decisao: "aprovado",
          // libera pra JA: quem aprovou acabou de olhar, e reagendar pro futuro
          // faria a aprovacao parecer que nao pegou
          disponivel_em: agora,
          aprovacao_assinatura: assinatura,
          erro: null,
          // a espera acabou: o aviso "parado esperando aval" sai junto
          aviso: null,
        }
      : {
          estado: "recusado",
          aprovacao_decisao: "recusado",
          aprovacao_assinatura: null,
          erro: `aprovacao recusada por ${quem.nome}`,
        };

  const { data, error } = await db
    .from("fluxo_fila")
    .update({
      ...patch,
      aprovado_por_id: quem.id || null,
      aprovado_por_nome: quem.nome,
      aprovado_em: agora,
      aprovado_via: via,
      atualizada_em: agora,
    })
    .eq("id", itemId)
    .eq("estado", "aguardando_aprovacao")
    .select("estado,disponivel_em");

  if (error) {
    if (semTabela(error)) return { ok: false, erro: AVISO_SEM_MIGRATION, http: 503 };
    return { ok: false, erro: "nao deu pra registrar a decisao", http: 503 };
  }
  const linha = (data ?? [])[0] as any;
  if (!linha) {
    return {
      ok: false,
      erro:
        "esta execucao nao esta mais esperando aprovacao: alguem decidiu antes de voce, " +
        "ela foi cancelada, ou ela acabou de mudar de estado (o tick a pegou enquanto " +
        "voce decidia) — recarregue a fila pra ver como ela esta agora",
      http: 409,
    };
  }
  return { ok: true, estado: linha.estado, disponivel_em: linha.disponivel_em ?? null };
}

/**
 * Cancela uma cadeia. Vale em qualquer estado VIVO — inclusive
 * `aguardando_aprovacao` (desistir de aprovar e cancelar) e `executando` (o tick
 * releu o estado e para no passo seguinte).
 */
export async function cancelarCadeia(
  itemId: string,
  quem: { id: string; nome: string }
): Promise<{ ok: true } | { ok: false; erro: string; http: number }> {
  const { data, error } = await msgDb()
    .from("fluxo_fila")
    .update({
      estado: "cancelado",
      erro: `cancelada por ${quem.nome}`,
      // a cadeia acabou: aviso de "esperando aval" nao faz mais sentido
      aviso: null,
      reservado_em: null,
      atualizada_em: agoraIso(),
    })
    .eq("id", itemId)
    .in("estado", ESTADOS_VIVOS as unknown as string[])
    .select("id");
  if (error) {
    if (semTabela(error)) return { ok: false, erro: AVISO_SEM_MIGRATION, http: 503 };
    return { ok: false, erro: "nao deu pra cancelar", http: 503 };
  }
  if (!(data ?? []).length) {
    return { ok: false, erro: "esta execucao ja terminou (nada pra cancelar)", http: 409 };
  }
  return { ok: true };
}

// --------------------------------------------- trilha por conversa (card 3)

export type PassoTrilha = {
  execucao_id: string;
  fluxo_slug: string;
  fluxo_nome: string | null;
  no_id: string | null;
  acao: string | null;
  status: string;
  detalhe: string | null;
  mensagem_id: string | null;
  origem: string | null;
  executado_por_nome: string | null;
  criada_em: string;
};

export type ExecucaoTrilha = {
  execucao_id: string;
  fluxo_slug: string;
  fluxo_nome: string | null;
  origem: string | null;
  comecou_em: string;
  terminou_em: string;
  status: "ok" | "falhou";
  passos: PassoTrilha[];
};

/** O que a tela da conversa precisa pra pintar o selo ao lado da mensagem. */
export type VinculoMensagem = {
  execucao_id: string;
  fluxo_slug: string;
  fluxo_nome: string | null;
  no_id: string | null;
};

export type Trilha =
  | {
      ok: true;
      /** um item por EXECUCAO, com os passos dentro (a pergunta e "o que rodou aqui") */
      execucoes: ExecucaoTrilha[];
      /** mensagem_id -> execucao, o indice que a tela da conversa usa */
      por_mensagem: Record<string, VinculoMensagem>;
      /** a coluna mensagem_id existe? (false = 0018 nao aplicada) */
      vinculo_disponivel: boolean;
    }
  | { ok: false; aviso: string };

const COLS_TRILHA =
  "execucao_id,fluxo_slug,no_id,acao,status,detalhe,executado_por_nome,criada_em,mensagem_id,origem";
const COLS_TRILHA_ANTIGA =
  "execucao_id,fluxo_slug,no_id,acao,status,detalhe,executado_por_nome,criada_em";

/**
 * A TRILHA DE AUTOMACAO DE UMA CONVERSA (card 86ak85zn1).
 *
 * Entrega a CONSULTA pronta, nao a tela: `app/home.tsx` tem outro dono nesta onda
 * (a Frente O esta nela). A costura de UI esta declarada no CLAUDE.md e vai por
 * card — quem plugar consome `por_mensagem[<id da mensagem>]` pra pintar o selo
 * "isto foi o fluxo X" ao lado da mensagem, e `execucoes` pra abrir o historico.
 *
 * Degrada em DUAS camadas, como /api/fluxos faz com a 0015: sem a 0018 a coluna
 * `mensagem_id` nao existe, a leitura e refeita sem ela e `vinculo_disponivel`
 * volta `false` — some o VINCULO, nao a trilha.
 */
export async function trilhaDaConversa(
  canal: string,
  chatId: string,
  limite = 200
): Promise<Trilha> {
  const db = msgDb();
  const ler = (cols: string) =>
    db
      .from("fluxo_execucoes")
      .select(cols)
      .eq("canal", canal)
      .eq("chat_id", chatId)
      .order("criada_em", { ascending: false })
      .limit(Math.min(500, Math.max(1, limite)));

  let vinculo = true;
  let { data, error } = await ler(COLS_TRILHA);
  if (error && ((error as any).code === "42703" || (error as any).code === "PGRST204")) {
    vinculo = false;
    ({ data, error } = await ler(COLS_TRILHA_ANTIGA));
  }
  if (error) {
    return {
      ok: false,
      aviso: "trilha de automacao indisponivel (as migrations 0008 e 0018 ja foram aplicadas nesta instalacao?)",
    };
  }

  const linhas = ((data ?? []) as any[]).map(
    (l): PassoTrilha => ({
      execucao_id: l.execucao_id,
      fluxo_slug: l.fluxo_slug,
      fluxo_nome: null,
      no_id: l.no_id ?? null,
      acao: l.acao ?? null,
      status: l.status,
      detalhe: l.detalhe ?? null,
      mensagem_id: l.mensagem_id ?? null,
      origem: l.origem ?? null,
      executado_por_nome: l.executado_por_nome ?? null,
      criada_em: l.criada_em,
    })
  );

  const slugs = [...new Set(linhas.map((l) => l.fluxo_slug))];
  const nomes = new Map<string, string>();
  if (slugs.length) {
    const { data: fx } = await db.from("fluxos").select("slug,nome").in("slug", slugs.slice(0, 200));
    for (const f of fx ?? []) nomes.set((f as any).slug, (f as any).nome);
  }
  for (const l of linhas) l.fluxo_nome = nomes.get(l.fluxo_slug) ?? null;

  const grupos = new Map<string, PassoTrilha[]>();
  for (const l of linhas) {
    const atual = grupos.get(l.execucao_id);
    if (atual) atual.push(l);
    else grupos.set(l.execucao_id, [l]);
  }

  const execucoes = [...grupos.entries()].map(([execucao_id, passos]) => {
    // as linhas vem da mais nova pra mais velha; dentro da execucao a ordem que
    // interessa e a de EXECUCAO
    const ordenados = [...passos].sort((a, b) => a.criada_em.localeCompare(b.criada_em));
    return {
      execucao_id,
      fluxo_slug: ordenados[0].fluxo_slug,
      fluxo_nome: ordenados[0].fluxo_nome,
      origem: ordenados.find((p) => p.origem)?.origem ?? null,
      comecou_em: ordenados[0].criada_em,
      terminou_em: ordenados[ordenados.length - 1].criada_em,
      status: ordenados.some((p) => p.status === "falhou") ? ("falhou" as const) : ("ok" as const),
      passos: ordenados,
    };
  });

  const por_mensagem: Record<string, VinculoMensagem> = {};
  for (const l of linhas) {
    if (!l.mensagem_id) continue;
    // primeira ocorrencia ganha: a mensagem e criada por UM passo
    if (por_mensagem[l.mensagem_id]) continue;
    por_mensagem[l.mensagem_id] = {
      execucao_id: l.execucao_id,
      fluxo_slug: l.fluxo_slug,
      fluxo_nome: l.fluxo_nome,
      no_id: l.no_id,
    };
  }

  return { ok: true, execucoes, por_mensagem, vinculo_disponivel: vinculo };
}

export type { No, ProximoPasso, ResultadoNoFila };
