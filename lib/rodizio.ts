// RODIZIO de conversa: escolhe o atendente online com menos conversas em
// andamento e atribui a conversa a ele.
//
// EXTRAIDO de `automacoesEntrada` (app/api/webhook/route.ts) na Frente N, sem
// mudar a regra: ate aqui o rodizio existia SO pra conversa nova chegando pelo
// webhook Z-API, e a conversa REINICIADA precisa da mesma escolha. Regra de
// atribuicao em dois lugares e regra que diverge — entao ela passou a morar num
// lugar so, e o webhook chama daqui.
//
// O que NAO mudou: candidato = perfil ativo visto nos ultimos 5 minutos; carga =
// conversas em andamento atribuidas a ele; teto por atendente vindo da config;
// vence a menor carga.
//
// Regra da casa (REGRA Nº1): nada da Expert aqui — a lista de atendentes e a
// config sao da INSTALACAO.

// FRENTE S (31/08/2026), card 86ak85nxx — FILA DE ATENDIMENTO.
//
// Dois acrescimos aqui, os dois declarados no CLAUDE.md:
//
//  1. A FILA FILTRA os candidatos. O criterio de escolha continua sendo o que
//     este arquivo sempre teve (menor carga, desempate deterministico por
//     `user_id`); a fila apenas tira do ranking quem esta FORA e quem PULOU a
//     vez. Trocar o criterio por round-robin estrito seria mudanca silenciosa
//     de comportamento de feature que ja roda em producao. O modulo
//     `fila_atendimento` nasce DESLIGADO, e desligado nem se le a tabela.
//
//  2. A TRILHA DE TRANSFERENCIA passou a ser gravada (era divida DECLARADA da
//     Frente O: "lib/rodizio.ts escreve em conversa_responsaveis e NAO chama
//     registrarEventoResponsavel"). Criterio do card: "toda distribuicao feita
//     pela fila gera evento no historico de transferencia" — e nao daria pra
//     honrar isso deixando a distribuicao normal sem trilha, senao o historico
//     teria buraco justo onde o robo agiu.
import { canalPorId } from "@/lib/canais";
import { getModulosDetalhado } from "@/lib/modulos";
import { escolherNaFila, situacao, type EstadoFila } from "@/lib/fila-atendimento";
import { consumirPulos, lerFilaDe } from "@/lib/fila-atendimento-db";
import { registrarEventoResponsavel } from "@/lib/tela-conversa-db";

/** Minutos de "online": perfil sem `visto_em` recente nao recebe conversa. */
const JANELA_ONLINE_MS = 5 * 60_000;

/** Status que contam como conversa EM ANDAMENTO na carga do atendente. */
const STATUS_EM_ANDAMENTO = ["aberto", "atendimento", "aguardando"];

export type Atendente = { user_id: string; nome: string };

/** Por que o rodizio nao rodou — vira log, nunca erro. */
export type MotivoSemRodizio =
  | "canal_sem_rodizio"
  | "grupo"
  | "ninguem_online"
  | "todos_no_teto"
  | "ja_tem_dono"
  // ——— FRENTE S: motivos que so existem com o modulo `fila_atendimento` ligado
  /** todos os candidatos estao FORA da fila (criterio do card: a conversa NAO se
   *  perde — ela fica sem responsavel, visivel pra instalacao inteira). */
  | "fila_vazia"
  /** os disponiveis pularam a vez; os pulos foram consumidos e a proxima cai pra eles */
  | "todos_pularam"
  /** a fila esta LIGADA e nao deu pra ler o estado dela: nao se distribui no
   *  escuro (freio que falha aberto nao e freio). Nada se perde — a conversa
   *  fica sem responsavel e aparece pra todos. */
  | "fila_indisponivel";

/**
 * O canal tem rodizio?
 *
 * Hoje SO a fonte `zapi` — e o unico caminho de ingestao onde o rodizio roda
 * (`automacoesEntrada`). Nao e limitacao tecnica desta funcao (ela e agnostica
 * de canal: le `perfis` e `conversa_responsaveis`), e sim recusa deliberada de
 * ligar distribuicao automatica num canal que nunca teve — mudanca de
 * comportamento de canal e decisao de produto, nao efeito colateral de frente.
 *
 * Quem plugar rodizio numa fonte nova (evolution, gupshup) amplia esta lista
 * JUNTO com o gancho na ingestao daquela fonte.
 */
export function canalTemRodizio(canal: string): boolean {
  return canalPorId(canal)?.fonte === "zapi";
}

/**
 * Escolhe quem recebe a conversa, ou o motivo de nao ter escolhido.
 *
 * `excluir` tira candidatos da disputa — usado pela redistribuicao do reinicio
 * pra nao "trocar" o responsavel por ele mesmo (delete + insert + aviso, tudo
 * pra nada).
 */
export async function escolherAtendente(
  db: any,
  T: { conversas: string },
  cfg: { teto_por_atendente: number },
  ctx: { canal: string; excluir?: string[] }
): Promise<{ atendente: Atendente; via_fila?: boolean } | { motivo: MotivoSemRodizio }> {
  const corte = new Date(Date.now() - JANELA_ONLINE_MS).toISOString();
  const { data: online } = await db
    .from("perfis")
    .select("user_id,nome,ativo,visto_em")
    .gte("visto_em", corte)
    // ORDEM DETERMINISTICA (revisao 31/08/2026): o desempate de carga IGUAL nao
    // pode depender da ordem que o banco resolveu devolver. Duas passadas em
    // corrida (duas mensagens do cliente no mesmo instante, ou dois ticks)
    // escolhiam pessoas DIFERENTES e criavam dois donos pra mesma conversa; com
    // ordem estavel elas escolhem a MESMA pessoa e colidem no onConflict do
    // upsert, que e idempotente.
    .order("user_id", { ascending: true });
  const fora = new Set(ctx.excluir ?? []);
  const candidatos = (online ?? []).filter((p: any) => p.ativo !== false && !fora.has(p.user_id));
  if (!candidatos.length) return { motivo: "ninguem_online" };

  // carga atual: conversas em andamento atribuidas a cada candidato
  const ids = candidatos.map((c: any) => c.user_id);
  const { data: vinculos } = await db
    .from("conversa_responsaveis")
    .select("ref_id,chat_id")
    .eq("canal", ctx.canal)
    .eq("tipo", "usuario")
    .in("ref_id", ids);
  const chatsAtivos = new Set<string>();
  {
    const chats = Array.from(new Set((vinculos ?? []).map((v: any) => v.chat_id)));
    for (let i = 0; i < chats.length; i += 200) {
      const { data } = await db
        .from(T.conversas)
        .select("chat_id")
        .in("chat_id", chats.slice(i, i + 200))
        .in("status", STATUS_EM_ANDAMENTO);
      for (const c of data ?? []) chatsAtivos.add(c.chat_id);
    }
  }
  const carga = new Map<string, number>(ids.map((id: string) => [id, 0]));
  for (const v of vinculos ?? []) {
    if (chatsAtivos.has(v.chat_id)) carga.set(v.ref_id, (carga.get(v.ref_id) || 0) + 1);
  }
  const aptos = candidatos
    .map((c: any) => ({ ...c, carga: carga.get(c.user_id) || 0 }))
    .filter((c: any) => !cfg.teto_por_atendente || c.carga < cfg.teto_por_atendente)
    .sort((a: any, b: any) => a.carga - b.carga);
  if (!aptos.length) return { motivo: "todos_no_teto" };

  // ——— FRENTE S: a FILA DE ATENDIMENTO entra aqui, e SO aqui.
  //
  // `aptos` ja e o RANKING (menor carga, desempate por user_id — o `.order` do
  // select acima garante a ordem estavel do empate). A fila nao reordena nada:
  // ela anda por esse ranking e devolve o primeiro que esta disponivel.
  //
  // A FLAG e lida com o desfecho da leitura, nao so com o valor — mas o FREIO
  // depende das DUAS coisas: falhou E o valor conhecido dizia LIGADO.
  //
  // A 1a correcao recusava com `if (flag.falhou)` sozinho, ANTES de olhar se o
  // modulo esta ligado, e isso era pior que o furo original: um timeout no SELECT
  // de `config` parava a distribuicao automatica de TODA instalacao — inclusive
  // as que nunca ligaram a fila, que hoje sao 100% delas. Freio de uma feature
  // desligada nao pode frear a operacao de quem nao usa a feature.
  //
  // `flag.mapa` numa falha e o ULTIMO valor lido com sucesso (ou a env), nunca o
  // default cego — quem garante isso e lib/modulos.ts. Entao:
  //   modulo nunca ligado + falha  -> `filaLigada` false -> distribui como antes
  //                                   (equivalencia byte a byte pra quem nao usa)
  //   modulo ligado + falha        -> recusa, que e o caso que o freio existe pra
  //                                   cobrir (a conversa cairia em quem saiu)
  //
  // E FALTAVA UMA LINHA nessa tabela (achado da 3a revisao): PROCESSO FRIO.
  // `ultimoBom` e estado de processo — numa instancia serverless que acabou de
  // subir ele e `null`, entao "o valor conhecido dizia desligado" nao existe: nao
  // ha valor conhecido NENHUM. Numa instalacao que ligou a fila POR CONFIG (nao
  // por env), instancia nova + blip de banco dava `filaLigada` false e a conversa
  // ia justamente pra quem tinha saido da fila. Nesse caso a gente vai PERGUNTAR
  // A QUEM SABE: a propria `atendente_fila`.
  const flag = await getModulosDetalhado();
  let filaLigada = flag.mapa.fila_atendimento === true;
  if (flag.falhou && filaLigada) return { motivo: "fila_indisponivel" };
  let estados = new Map<string, EstadoFila>();
  // a sonda do processo frio, quando roda e da certo, JA traz os estados: sem esta
  // marca o bloco de baixo leria a mesma tabela outra vez (o caso comum e mapa
  // vazio, que `estados.size` nao distingue de "nao lido").
  let jaLeu = false;
  if (flag.falhou && flag.sem_valor_conhecido) {
    // Leitura minuscula e SO neste caminho raro (flag ilegivel + processo frio).
    // O criterio e o que da pra PROVAR seguro:
    //   tabela ausente            -> ninguem pode ter saido de uma fila que nao
    //                                existe -> distribuir e identico a fila ligada
    //   ninguem marcado fora      -> a fila, ligada ou nao, deixaria todos
    //                                receberem -> distribuir e identico
    //   alguem marcado fora/pulou -> a fila esta EM USO de verdade, e nao da pra
    //                                saber se o modulo esta ligado: recusa
    //   leitura tambem falhou     -> nao sei nada sobre nada: recusa. A conversa
    //                                fica orfa e VISIVEL (motivo nomeado), que e a
    //                                politica da casa — melhor que cair em quem
    //                                pediu pra sair.
    const sonda = await lerFilaDe(aptos.map((c: any) => c.user_id));
    if (!sonda.ok) {
      if (!sonda.migration_pendente) return { motivo: "fila_indisponivel" };
    } else {
      const agora = Date.now();
      const alguemFora = [...sonda.estados.values()].some((e) => situacao(e, agora) !== "dentro");
      if (alguemFora) return { motivo: "fila_indisponivel" };
      // ninguem fora: seguir com os estados JA LIDOS (nao le duas vezes) e tratar
      // a fila como ligada — com todo mundo dentro, os dois caminhos dao o mesmo
      // escolhido, e assim um pulo vigente ainda seria respeitado se aparecesse.
      estados = sonda.estados;
      filaLigada = true;
      jaLeu = true;
    }
  }
  if (filaLigada && !jaLeu) {
    const leitura = await lerFilaDe(aptos.map((c: any) => c.user_id));
    if (!leitura.ok) {
      // migration 0021 pendente NAO e falha: ninguem pode ter saido da fila sem
      // a tabela existir, entao "todos dentro" e a verdade. Erro de leitura DE
      // VERDADE nao distribui (ver o cabecalho de lib/fila-atendimento-db.ts).
      if (!leitura.migration_pendente) return { motivo: "fila_indisponivel" };
    } else {
      estados = leitura.estados;
    }
  }
  const r = escolherNaFila(
    aptos.map((c: any) => c.user_id as string),
    estados,
    Date.now(),
    { ativo: filaLigada }
  );
  // Os pulos consumidos sao gravados MESMO quando ninguem foi escolhido: a vez
  // daquelas pessoas chegou e passou, e a proxima conversa e delas. Nao esperar
  // (`await`) aqui deixaria o consumo morrer com o congelamento do serverless na
  // resposta, e o pulo valeria pra sempre — a pessoa nunca mais receberia nada.
  if (r.pulos_consumidos.length) await consumirPulos(r.pulos_consumidos);
  if (!r.escolhido) {
    return { motivo: r.motivo === "sem_candidato" ? "todos_no_teto" : r.motivo! };
  }
  const escolhido = aptos.find((c: any) => c.user_id === r.escolhido)!;
  return {
    atendente: { user_id: escolhido.user_id, nome: escolhido.nome || "Atendente" },
    via_fila: r.via_fila,
  };
}

/** Aviso do sininho — texto proprio por motivo, nunca "conversa nova" pra tudo. */
const TITULO: Record<"nova" | "reinicio", string> = {
  nova: "Conversa nova atribuida a voce (rodizio automatico)",
  reinicio: "Conversa reiniciada atribuida a voce (rodizio automatico)",
};

/**
 * Atribui a conversa ao atendente escolhido.
 *
 * `substituir` = os `ref_id` que a redistribuicao leu e vai TROCAR. A remocao e a
 * atribuicao saem JUNTAS, nesta ordem, e o delete e condicionado exatamente a
 * esses ids (`.in("ref_id", ...)`): quem foi atribuido no meio da operacao por
 * outra porta NAO e apagado por engano. Sem substituto na mao ninguem chega
 * aqui — quem decide isso e `redistribuir`.
 */
export async function atribuir(
  db: any,
  T: { conversas: string },
  ctx: {
    canal: string;
    chatId: string;
    atendente: Atendente;
    motivo: "nova" | "reinicio";
    substituir?: string[];
    /** a FILA de atendimento decidiu (modulo ligado)? muda so a `origem` da trilha */
    viaFila?: boolean;
  }
): Promise<void> {
  const { canal, chatId, atendente } = ctx;
  // FRENTE S — ORIGEM da trilha. O vocabulario de `origem` em
  // conversa_responsavel_eventos e texto livre no banco (0017, sem CHECK); os
  // valores em uso sao "inicio", "gatilho", "robo", e a propria 0017 pediu
  // "rodizio"/"reinicio" pra esta costura. "fila" existe pra o historico dizer
  // QUAL mecanismo decidiu — o card cobra a trilha da FILA, e um evento que diz
  // so "rodizio" nao responde "por que caiu pra essa pessoa e nao pra aquela".
  const origem = ctx.motivo === "reinicio" ? "reinicio" : ctx.viaFila ? "fila" : "rodizio";
  // A automacao assina com id NULL + nome preenchido (convencao da 0006).
  const por = { id: null as string | null, nome: "Distribuicao automatica" };

  if (ctx.substituir?.length) {
    // NOME LIDO ANTES DO DELETE (regra da casa, Frente O): depois do delete a
    // linha nao existe e a trilha ficaria com um uuid cru. Nome congelado no
    // evento e o que faz a trilha ser legivel anos depois, com o usuario ja
    // desligado da empresa.
    const { data: saindo } = await db
      .from("conversa_responsaveis")
      .select("tipo,ref_id,nome")
      .eq("canal", canal)
      .eq("chat_id", chatId)
      .in("ref_id", ctx.substituir);
    await db
      .from("conversa_responsaveis")
      .delete()
      .eq("canal", canal)
      .eq("chat_id", chatId)
      .in("ref_id", ctx.substituir);
    for (const s of saindo ?? []) {
      await registrarEventoResponsavel({
        canal,
        chatId,
        acao: "removido",
        tipo: s.tipo,
        refId: s.ref_id,
        refNome: s.nome ?? null,
        por,
        origem,
      });
    }
  }
  await db.from("conversa_responsaveis").upsert(
    { canal, chat_id: chatId, tipo: "usuario", ref_id: atendente.user_id, nome: atendente.nome },
    { onConflict: "canal,chat_id,tipo,ref_id" }
  );
  // FRENTE S — a trilha da ATRIBUICAO. `await` de proposito: em serverless o
  // processo congela na resposta, e promessa solta morre no meio da insercao —
  // trilha que grava "as vezes" e pior que trilha que nao existe (licao da
  // Frente O). O melhor-esforco mora DENTRO de registrarEventoResponsavel, que
  // engole a excecao e nao derruba a atribuicao: distribuir importa mais que
  // registrar, mas registrar nao e opcional por descuido.
  await registrarEventoResponsavel({
    canal,
    chatId,
    acao: "atribuido",
    tipo: "usuario",
    refId: atendente.user_id,
    refNome: atendente.nome,
    por,
    origem,
  });
  // Colunas legadas espelham o 1o responsavel.
  //
  // TROCA (substituir preenchido = havia vinculo N:N lido): o espelho PASSA a
  // apontar pro novo dono, senao a ficha mostra quem saiu.
  //
  // ATRIBUICAO de conversa sem dono: so escreve quando o espelho esta REALMENTE
  // vazio — `responsavel_id` NULL **e** `responsavel_nome` vazio. A guarda do
  // nome existe por uma invariante do acervo importado: conversa vinda do
  // ChatGuru tem `responsavel_nome` preenchido com o atendente de LA e nenhuma
  // linha em `conversa_responsaveis` (a pessoa nao tem conta no painel). Com so
  // `.is("responsavel_id", null)`, o rodizio sobrescrevia esse nome e apagava o
  // UNICO registro de quem atendeu aquele cliente — dado que nao volta, porque a
  // origem esta sendo desligada. O vinculo N:N novo entra de qualquer forma (o
  // upsert acima), entao ninguem fica sem responsavel de verdade: o que se
  // preserva e a trilha historica na coluna legada.
  const patchEspelho = {
    responsavel_id: atendente.user_id,
    responsavel_nome: atendente.nome,
    responsavel_tipo: "usuario",
  };
  if (ctx.substituir?.length) {
    await db.from(T.conversas).update(patchEspelho).eq("chat_id", chatId);
  } else {
    await db
      .from(T.conversas)
      .update(patchEspelho)
      .eq("chat_id", chatId)
      .is("responsavel_id", null)
      // duas guardas simples em vez de um `or` com string vazia: filtro que o
      // PostgREST pode interpretar torto aqui erraria em silencio, e este e o
      // ponto que protege dado que nao volta. Nome gravado como "" (nunca visto
      // no acervo — o importador grava nome ou NULL) so deixa o espelho legado
      // desatualizado por uma rodada; `espelharLegado` (/api/conversa) corrige
      // na primeira mudanca de responsavel pela tela.
      .is("responsavel_nome", null);
  }
  // DEDUPE do aviso (melhor-esforco, sem constraint nova): duas passadas em
  // corrida escolhem a MESMA pessoa (a ordem dos candidatos e deterministica) e
  // colidem no onConflict do upsert — mas `notificacoes` e insert puro, e o
  // atendente receberia o sininho duas vezes pela mesma atribuicao. Uma leitura
  // curta basta; se ela falhar, o aviso sai (avisar 2x e menos grave que nao
  // avisar).
  const desde = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data: repetida } = await db
    .from("notificacoes")
    .select("id")
    .eq("user_id", atendente.user_id)
    .eq("canal", canal)
    .eq("chat_id", chatId)
    .eq("titulo", TITULO[ctx.motivo])
    .gte("criada_em", desde)
    .limit(1);
  if (!repetida?.length) {
    await db.from("notificacoes").insert({
      user_id: atendente.user_id,
      canal,
      chat_id: chatId,
      titulo: TITULO[ctx.motivo],
      texto: null,
      autor_nome: "Distribuicao automatica",
    });
  }
}

/**
 * Rodizio completo pra conversa SEM responsavel (o caminho historico da conversa
 * nova). Nao faz nada se a conversa ja tem responsavel — quem responde primeiro
 * assume, e o rodizio nao empilha um segundo dono.
 */
export async function distribuirSeOrfa(
  db: any,
  T: { conversas: string },
  cfg: { teto_por_atendente: number },
  ctx: { canal: string; chatId: string; motivo: "nova" | "reinicio" }
): Promise<Atendente | MotivoSemRodizio> {
  const { count } = await db
    .from("conversa_responsaveis")
    .select("chat_id", { count: "exact", head: true })
    .eq("canal", ctx.canal)
    .eq("chat_id", ctx.chatId);
  if (count) return "ja_tem_dono";
  const r = await escolherAtendente(db, T, cfg, { canal: ctx.canal });
  if ("motivo" in r) return r.motivo;
  await atribuir(db, T, { ...ctx, atendente: r.atendente, viaFila: r.via_fila });
  return r.atendente;
}
