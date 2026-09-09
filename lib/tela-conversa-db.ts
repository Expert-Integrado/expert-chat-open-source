import { msgDb } from "@/lib/mensageria";
import { tabelas, Canal } from "@/lib/canal";
import { somenteLeitura } from "@/lib/canais";
import {
  padraoParaIlike,
  casaTermo,
  MAX_RESULTADOS_BUSCA,
  botLigado,
  ORIGEM_ROBO,
  STATUS_ROBO_LIGADO,
  STATUS_ROBO_DESLIGADO,
  ItemMidia,
  EventoStatus,
  EventoResponsavel,
} from "@/lib/tela-conversa";

// Tela de conversa — camada de BANCO (cards 86ak85nyv, 86ak85nx0, 86ak85nwu).
//
// A DECISAO mora em lib/tela-conversa.ts (puro, sem import, provavel em node
// solto). Aqui e so fiacao: ler e gravar. Mesma divisao de funis/funis-db e de
// fluxo/schema + fluxo/contexto-db.
//
// AUTORIZACAO NAO MORA AQUI. Quem chama (a rota) ja resolveu usuario, escopo e
// permissao. Duplicar a checagem criaria um segundo lugar pra ela divergir —
// mesma regra que lib/fluxo/executar.ts declara no topo dele.
//
// DEGRADACAO SEM 500 (padrao de lib/funis-db.ts e lib/fluxo/contexto-db.ts): a
// migration 0017 e gesto humano no SQL Editor. Enquanto nao rodar:
//   * historico responde lista vazia COM aviso (nunca 500, nunca lista vazia
//     silenciosa — vazio calado parece "essa conversa nunca mudou de status");
//   * a trilha nao grava e o efeito principal (trocar status, atribuir
//     responsavel) acontece igual: trilha e melhor-esforco, atendimento nao;
//   * o robo continua LIGADO (default seguro de `botLigado`).

// 42P01 tabela nao existe | 42703 coluna nao existe (migration antiga)
// PGRST204 = o PostgREST nao conhece a COLUNA que o insert/upsert mandou (ele
//   valida contra o cache de schema ANTES de falar com o Postgres, entao coluna
//   nova sem `notify pgrst` da esse codigo e nao 42703)
// PGRST202 = funcao nao encontrada (RPC sem a migration ou sem reload)
// 42883 = funcao inexistente pelo lado do Postgres
// 42501 permissao (a tabela existe e o grant nao veio)
const SEM_ESTRUTURA = ["42P01", "42703", "PGRST204", "PGRST202", "42883"];

// SO "a funcao nao existe". Usado onde degradar significa ABRIR UMA TRAVA (a
// reserva do teto): ali, coluna faltando ou tabela faltando NAO pode virar
// "segue sem teto" — tem que recusar. Ver `reservarInicio`.
const SEM_RPC = ["PGRST202", "42883"];

export const AVISO_SEM_0017 =
  "historico indisponivel nesta instalacao (a migration 0017_tela_conversa.sql ja foi aplicada?)";

export type Falha = { ok: false; aviso: string };
export type Autor = { id: string | null; nome: string };

function aviso(e: any, oque: string): Falha {
  const codigo = String(e?.code ?? "");
  const msg = String(e?.message ?? "");
  if (msg) console.error(`tela-conversa (${oque}):`, codigo ? `${codigo} ${msg}` : msg);
  if (SEM_ESTRUTURA.includes(codigo)) return { ok: false, aviso: AVISO_SEM_0017 };
  if (codigo === "42501") {
    return {
      ok: false,
      aviso: `sem permissao no ${oque} (a tabela existe; falta o grant do service_role da 0017)`,
    };
  }
  return { ok: false, aviso: `nao deu pra ler o ${oque}${codigo ? ` (${codigo})` : ""}: ${msg || "erro sem mensagem"}` };
}

// ===========================================================================
// Robô por conversa
// ===========================================================================

/**
 * A conversa aceita automacao?
 *
 * ESTA E A LEITURA QUE O MOTOR VAI CONSUMIR (costura declarada no CLAUDE.md):
 * quem escrever o caminho de gatilho chama isto e passa o resultado pra
 * `motivoBotDesligado` de lib/tela-conversa.ts. Nao mexemos em
 * lib/fluxo/executar.ts — ele tem outro dono nesta onda.
 *
 * NUNCA lanca e NUNCA devolve `false` por falha: coluna ausente, canal de fonte
 * externa (que nao tem linha de conversa no painel) e erro de rede caem todos
 * em `true`, que e o comportamento historico do painel. Desligar a automacao da
 * instalacao por causa de uma leitura que falhou seria uma pane silenciosa.
 */
export async function botAtivoDaConversa(canal: Canal, chatId: string): Promise<boolean> {
  if (somenteLeitura(canal)) return true;
  try {
    const T = tabelas(canal);
    const { data, error } = await msgDb()
      .from(T.conversas)
      .select("bot_ativo")
      .eq("chat_id", chatId)
      .maybeSingle();
    if (error) {
      if (!SEM_ESTRUTURA.includes(String(error.code ?? ""))) {
        console.error("tela-conversa (bot_ativo):", error.code, error.message);
      }
      return true;
    }
    return botLigado(data?.bot_ativo);
  } catch {
    return true;
  }
}

/**
 * O estado do robo PRA TELA: o valor mais quem mexeu e quando.
 *
 * `disponivel: false` quando a 0017 nao rodou. A tela usa isso pra ESCONDER o
 * botao em vez de desenhar um interruptor que nao grava nada — botao travado
 * parece app quebrado, e um que aceita o clique e nao guarda e pior: a pessoa
 * sai achando que desligou a automacao.
 */
export async function estadoDoRobo(
  canal: Canal,
  chatId: string
): Promise<{
  disponivel: boolean;
  bot_ativo: boolean;
  alterado_por_nome?: string | null;
  alterado_em?: string | null;
  aviso?: string;
}> {
  if (somenteLeitura(canal)) return { disponivel: false, bot_ativo: true };
  const T = tabelas(canal);
  const { data, error } = await msgDb()
    .from(T.conversas)
    .select("bot_ativo,bot_alterado_por_nome,bot_alterado_em")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (error) {
    const f = aviso(error, "robo da conversa");
    return { disponivel: false, bot_ativo: true, aviso: f.aviso };
  }
  return {
    disponivel: true,
    bot_ativo: botLigado(data?.bot_ativo),
    alterado_por_nome: data?.bot_alterado_por_nome ?? null,
    alterado_em: data?.bot_alterado_em ?? null,
  };
}

/**
 * Liga/desliga o robo na conversa.
 *
 * UPDATE SEPARADO do patch principal de /api/conversa, de propostio: sem a 0017
 * a coluna nao existe e o PostgREST recusa o UPDATE INTEIRO com 42703. Se
 * `bot_ativo` entrasse no mesmo patch de status/arquivo, uma instalacao sem a
 * migration perderia a capacidade de concluir conversa — a feature nova
 * quebrando a antiga. Aqui a falha fica contida: devolve aviso, o resto do
 * patch segue.
 */
export async function definirBotAtivo(
  canal: Canal,
  chatId: string,
  ativo: boolean,
  por: Autor
): Promise<{ ok: true; bot_ativo: boolean } | Falha> {
  if (somenteLeitura(canal)) {
    return { ok: false, aviso: "canal somente leitura: a conversa nao mora no banco do painel" };
  }
  const T = tabelas(canal);
  const { error } = await msgDb()
    .from(T.conversas)
    .update({
      bot_ativo: ativo,
      bot_alterado_por_id: por.id,
      bot_alterado_por_nome: por.nome,
      bot_alterado_em: new Date().toISOString(),
    })
    .eq("chat_id", chatId);
  if (error) return aviso(error, "robo da conversa");
  return { ok: true, bot_ativo: ativo };
}

// ===========================================================================
// Trilha de status
// ===========================================================================

/**
 * Grava um evento de troca de status.
 *
 * MELHOR-ESFORCO por decisao: nunca lanca e nunca impede o efeito principal.
 * Um destino de trilha indisponivel nao pode travar o atendente que esta
 * concluindo a conversa de um cliente — mesma politica do webhook de saida
 * (lib/webhooks-saida.ts). MAS quem chama DEVE dar `await`: em serverless o
 * processo congela na resposta, e promessa solta some no meio da insercao —
 * gravar as vezes e pior que nao gravar.
 *
 * PASSA PELA FUNCAO DO BANCO (`mensageria.registrar_status_evento`), nao por
 * insert direto — achado da revisao cega (31/08/2026). Antes o codigo lia o
 * ultimo evento, calculava a duracao em JavaScript e depois inseria: duplo
 * clique em "concluir" (ou dois atendentes juntos) fazia as duas chamadas lerem
 * o MESMO ultimo evento e gravarem a MESMA duracao — permanencia DOBRADA no
 * resumo, indo pra relatorio de tempo de atendimento com cara de real. Na
 * funcao, o `max(criada_em)` e lido dentro da instrucao que insere.
 *
 * `marcoAnterior` e o fallback usado SO quando a conversa nao tem evento
 * anterior: ali o marco vem de `conversas.status_alterado_em` (coluna da 0006)
 * ou do `created_at`, e quem sabe disso e a rota. Sem nenhum dos dois a duracao
 * fica NULL e a tela mostra "sem medicao" em vez de numero inventado.
 */
export async function registrarEventoStatus(opcoes: {
  canal: Canal;
  chatId: string;
  status: string;
  statusAnterior: string | null;
  marcoAnterior?: unknown;
  por: Autor;
  origem: string;
  fluxo?: { slug: string; nome: string } | null;
}): Promise<void> {
  try {
    const marco =
      typeof opcoes.marcoAnterior === "string" && opcoes.marcoAnterior ? opcoes.marcoAnterior : null;
    const { error } = await msgDb().rpc("registrar_status_evento", {
      p_canal: opcoes.canal,
      p_chat_id: opcoes.chatId,
      p_status: opcoes.status,
      p_anterior: opcoes.statusAnterior,
      p_marco: marco,
      p_por_id: opcoes.por.id,
      p_por_nome: opcoes.por.nome,
      p_origem: opcoes.origem,
      p_fluxo_slug: opcoes.fluxo?.slug ?? null,
      p_fluxo_nome: opcoes.fluxo?.nome ?? null,
    });
    if (error && !SEM_ESTRUTURA.includes(String(error.code ?? ""))) {
      console.error("tela-conversa (trilha status):", error.code, error.message);
    }
  } catch (e: any) {
    console.error("tela-conversa (trilha status):", e?.message ?? e);
  }
}

/**
 * Registra o liga/desliga do robo NA TRILHA DE STATUS.
 *
 * MESMA TABELA, de propostio: "mudar estado da conversa sem guardar quem
 * mudou" e exatamente o defeito que a 0006 fechou pro status e que o toggle do
 * robo reintroduzia. Criar uma terceira tabela pra dois valores booleanos
 * pagaria uma migration e uma leitura a mais pra guardar a mesma forma de dado.
 *
 * A distincao mora em `origem: "robo"`, e ela e LOAD-BEARING: a linha do tempo
 * de status e o "tempo em cada status" FILTRAM esses eventos fora
 * (`ehEventoRobo` em lib/tela-conversa.ts, e a propria funcao do banco os ignora
 * ao procurar o marco de permanencia). Sem o filtro, ligar o robo apareceria
 * entre "aberto" e "concluido" e a medicao de permanencia passaria a contar
 * tempo desde o ultimo clique no robo.
 */
export async function registrarEventoRobo(opcoes: {
  canal: Canal;
  chatId: string;
  ativo: boolean;
  por: Autor;
}): Promise<void> {
  await registrarEventoStatus({
    canal: opcoes.canal,
    chatId: opcoes.chatId,
    status: opcoes.ativo ? STATUS_ROBO_LIGADO : STATUS_ROBO_DESLIGADO,
    statusAnterior: opcoes.ativo ? STATUS_ROBO_DESLIGADO : STATUS_ROBO_LIGADO,
    por: opcoes.por,
    origem: ORIGEM_ROBO,
  });
}

/**
 * O historico de status pra tela.
 *
 * `truncado` NAO e enfeite: o resumo "tempo em cada status" soma o que veio, e
 * numa conversa com mais trocas que o teto ele estaria mostrando um TOTAL que e
 * so a fatia recente. Quem consome marca "parcial" (ver `linhaDoTempoStatus`).
 * Devolver a fatia sem o sinal seria mentir com numero.
 *
 * Eventos de robo (`origem = "robo"`) vem na consulta e sao filtrados pela regra
 * pura — filtrar no banco faria o teto de 200 ser gasto por eles sem que a tela
 * soubesse.
 */
export async function historicoStatus(
  canal: Canal,
  chatId: string,
  limite = 200
): Promise<{ ok: true; eventos: EventoStatus[]; truncado: boolean } | Falha> {
  const teto = Math.min(Math.max(1, limite), 500);
  const { data, error } = await msgDb()
    .from("conversa_status_eventos")
    .select("id,status,status_anterior,duracao_seg,por_id,por_nome,origem,fluxo_nome,criada_em")
    .eq("canal", canal)
    .eq("chat_id", chatId)
    // O ROBO SAI NA CONSULTA, nao so no filtro puro (achado da re-revisao). Com
    // o filtro apenas em JavaScript, 200 cliques no robo consumiam o teto
    // inteiro e a linha do tempo REAL chegava vazia — a aba mostraria "nenhuma
    // troca de status" numa conversa cheia de trocas. Filtrando aqui, o teto
    // conta o que a aba desenha e `truncado` fala do que ela mostra.
    // (a leitura `tipo=robo` tem o `.eq` complementar, em `historicoRobo`)
    //
    // `.or(is.null, neq)` e NAO `.neq` seco: em SQL `NULL <> 'robo'` avalia pra
    // NULL, entao um `.neq` sozinho descartaria todo evento com `origem` nula —
    // que e exatamente o caso do que outros caminhos vao gravar quando a costura
    // pendente entrar sem passar `origem`. Perder evento por causa de NULL e o
    // tipo de filtro que parece funcionar e esconde dado.
    .or(`origem.is.null,origem.neq.${ORIGEM_ROBO}`)
    .order("criada_em", { ascending: false })
    .limit(teto);
  if (error) return aviso(error, "historico de status");
  const linhas = (data ?? []) as EventoStatus[];
  return { ok: true, eventos: linhas, truncado: linhas.length >= teto };
}

/** O liga/desliga do robo, lido da trilha de status (so `origem = robo`). */
export async function historicoRobo(
  canal: Canal,
  chatId: string,
  limite = 30
): Promise<{ ok: true; eventos: EventoStatus[] } | Falha> {
  const { data, error } = await msgDb()
    .from("conversa_status_eventos")
    .select("id,status,status_anterior,duracao_seg,por_id,por_nome,origem,fluxo_nome,criada_em")
    .eq("canal", canal)
    .eq("chat_id", chatId)
    .eq("origem", ORIGEM_ROBO)
    .order("criada_em", { ascending: false })
    .limit(Math.min(Math.max(1, limite), 100));
  if (error) return aviso(error, "historico do robo");
  return { ok: true, eventos: (data ?? []) as EventoStatus[] };
}

// ===========================================================================
// Trilha de transferência (responsável)
// ===========================================================================

/**
 * Grava um evento de atribuicao/remocao de responsavel. Melhor-esforco, mesma
 * politica da trilha de status.
 *
 * COBERTURA (atualizada pela FRENTE S, 31/08/2026): chamam isto o
 * POST /api/conversa e o `lib/rodizio.ts` — a distribuicao automatica passou a
 * gravar trilha, fechando a divida que este comentario declarava.
 *
 * `origem` EM USO hoje, quatro valores: "painel" (gesto de gente na tela, o que
 * /api/conversa grava), "reinicio" e "rodizio" (distribuicao automatica) e
 * "fila" (distribuicao automatica com o modulo `fila_atendimento` ligado — valor
 * ACRESCENTADO pela Frente S; a 0017 documenta a lista como
 * 'painel' | 'rodizio' | 'gatilho' | 'reinicio' | 'importacao' | ..., aberta).
 *
 * ATENCAO pra quem acrescentar valor: `app/conversa-historicos.tsx` imprime a
 * origem CRUA na linha do historico (` · fila`), sem tabela de verbete. Entao o
 * valor precisa ser uma palavra que faca sentido pro ATENDENTE lendo a tela —
 * nao um codigo interno.
 *
 * AINDA NAO chamam: `lib/fluxo/executar.ts` e `lib/conversa-reinicio.ts`, que
 * tambem escrevem em `conversa_responsaveis` — arquivos de outros donos nesta
 * onda. A costura e uma linha em cada, com `origem` "gatilho" / "reinicio" e
 * `por` = a convencao da 0006 (id NULL + nome = automacao).
 */
export async function registrarEventoResponsavel(opcoes: {
  canal: Canal;
  chatId: string;
  acao: "atribuido" | "removido";
  tipo: string;
  refId: string;
  refNome?: string | null;
  por: Autor;
  origem: string;
  fluxo?: { slug: string; nome: string } | null;
}): Promise<void> {
  try {
    const { error } = await msgDb().from("conversa_responsavel_eventos").insert({
      canal: opcoes.canal,
      chat_id: opcoes.chatId,
      acao: opcoes.acao,
      tipo: opcoes.tipo,
      ref_id: opcoes.refId,
      ref_nome: opcoes.refNome ?? null,
      por_id: opcoes.por.id,
      por_nome: opcoes.por.nome,
      origem: opcoes.origem,
      fluxo_slug: opcoes.fluxo?.slug ?? null,
      fluxo_nome: opcoes.fluxo?.nome ?? null,
    });
    if (error && !SEM_ESTRUTURA.includes(String(error.code ?? ""))) {
      console.error("tela-conversa (trilha responsavel):", error.code, error.message);
    }
  } catch (e: any) {
    console.error("tela-conversa (trilha responsavel):", e?.message ?? e);
  }
}

export async function historicoTransferencia(
  canal: Canal,
  chatId: string,
  limite = 200
): Promise<{ ok: true; eventos: EventoResponsavel[]; truncado: boolean } | Falha> {
  const teto = Math.min(Math.max(1, limite), 500);
  const { data, error } = await msgDb()
    .from("conversa_responsavel_eventos")
    .select("id,acao,tipo,ref_id,ref_nome,por_id,por_nome,origem,fluxo_nome,criada_em")
    .eq("canal", canal)
    .eq("chat_id", chatId)
    .order("criada_em", { ascending: false })
    .limit(teto);
  if (error) return aviso(error, "historico de transferencia");
  const linhas = (data ?? []) as EventoResponsavel[];
  // trilha cortada tem que DIZER que foi cortada: "essa conversa passou por 3
  // pessoas" e uma afirmacao, e ela e falsa quando existem 400 eventos e vieram 200
  return { ok: true, eventos: linhas, truncado: linhas.length >= teto };
}

// ===========================================================================
// Avaliações (CSAT) e NPS
// ===========================================================================

export type ItemCsat = {
  id: string;
  nota: number;
  atendente_nome: string | null;
  criada_em: string;
};
export type ItemNps = {
  id: string;
  nota: number | null;
  comentario: string | null;
  respondida_em: string | null;
  pesquisa_nome: string | null;
  origem: string;
};

/**
 * As DUAS fontes de avaliacao da conversa, lidas juntas mas NUNCA misturadas.
 *
 * `mensageria.avaliacoes` (0001) e o CSAT do proprio painel: nota 1-5 que o
 * cliente responde depois da pesquisa de satisfacao pos-conclusao. Tem
 * atendente atribuido.
 *
 * `mensageria.nps_respostas` (0013) e NPS IMPORTADO de outra ferramenta: escala
 * diferente, com comentario, pertencendo a uma PESQUISA nomeada.
 *
 * Somar as duas medias daria um numero que nao significa nada — escalas
 * diferentes, perguntas diferentes, momentos diferentes. Por isso a rota e a
 * tela mostram as duas listas lado a lado, e nenhuma media combinada existe.
 */
export async function historicoAvaliacoes(
  canal: Canal,
  chatId: string
): Promise<{ csat: ItemCsat[]; nps: ItemNps[]; avisos: string[] }> {
  const db = msgDb();
  const avisos: string[] = [];

  const [csatR, npsR] = await Promise.all([
    db
      .from("avaliacoes")
      .select("id,nota,atendente_nome,criada_em")
      .eq("canal", canal)
      .eq("chat_id", chatId)
      .order("criada_em", { ascending: false })
      .limit(100),
    db
      .from("nps_respostas")
      .select("id,nota,comentario,respondida_em,origem,pesquisa_id")
      .eq("canal", canal)
      .eq("chat_id", chatId)
      .order("respondida_em", { ascending: false })
      .limit(100),
  ]);

  if (csatR.error) avisos.push(aviso(csatR.error, "historico de avaliacoes").aviso);
  if (npsR.error) {
    // sem a 0013 a tabela de NPS nao existe: aviso, nunca 500 (o CSAT ainda vem)
    avisos.push(
      SEM_ESTRUTURA.includes(String(npsR.error.code ?? ""))
        ? "NPS indisponivel nesta instalacao (a migration 0013_relatorios.sql ja foi aplicada?)"
        : aviso(npsR.error, "historico de NPS").aviso
    );
  }

  // nome da pesquisa: uma consulta pros ids que apareceram, nao uma por resposta
  const linhasNps = (npsR.data ?? []) as any[];
  const nomePorPesquisa = new Map<string, string>();
  const ids = Array.from(new Set(linhasNps.map((r) => r.pesquisa_id).filter(Boolean)));
  if (ids.length) {
    const { data: pesquisas } = await db.from("nps_pesquisas").select("id,nome").in("id", ids);
    for (const p of pesquisas ?? []) nomePorPesquisa.set(p.id, p.nome);
  }

  return {
    csat: (csatR.data ?? []) as ItemCsat[],
    nps: linhasNps.map((r) => ({
      id: r.id,
      nota: r.nota,
      comentario: r.comentario,
      respondida_em: r.respondida_em,
      pesquisa_nome: nomePorPesquisa.get(r.pesquisa_id) ?? null,
      origem: r.origem,
    })),
    avisos,
  };
}

// ===========================================================================
// Mídia da conversa
// ===========================================================================

/**
 * Os anexos da conversa, do mais novo pro mais velho.
 *
 * FILTRA POR `media_url` NAO NULO, e nao por lista de tipos. Motivo: tipo de
 * mensagem depende do provedor (o dicionario do mapa lista 16 tipos so no
 * ChatGuru, e cada canal novo traz os seus), e uma lista fixa de tipos deixaria
 * anexo de fora em silencio a cada canal novo. Quem decide a ABA e
 * `abaDaMidia`, que sabe cair pro mime e, no limite, pro balde de documento.
 *
 * `is_deleted` fica FORA: mensagem apagada na conversa nao pode reaparecer pela
 * galeria — seria uma porta lateral pro que a operacao mandou apagar.
 * `direcao: "interna"` tambem fica fora: anotacao nao e mensagem trocada.
 */
export async function midiaDaConversa(
  canal: Canal,
  chatId: string,
  limite = 300
): Promise<{ ok: true; itens: ItemMidia[]; truncado: boolean } | Falha> {
  const T = tabelas(canal);
  const teto = Math.min(Math.max(1, limite), 500);
  const { data, error } = await msgDb()
    .from(T.mensagens)
    .select("id,provider_msg_id,tipo,media_mime,media_url,conteudo,criada_em,direcao")
    .eq("chat_id", chatId)
    .not("media_url", "is", null)
    .eq("is_deleted", false)
    .neq("direcao", "interna")
    .order("criada_em", { ascending: false })
    .limit(teto);
  if (error) return aviso(error, "historico de midia");
  const linhas = data ?? [];
  return {
    ok: true,
    itens: linhas.map((m: any) => ({
      id: m.id,
      provider_msg_id: m.provider_msg_id,
      tipo: m.tipo,
      mime: m.media_mime,
      url: m.media_url,
      // a legenda do anexo mora em `conteudo` (nao ha coluna propria no 0001)
      legenda: m.conteudo,
      criada_em: m.criada_em,
      direcao: m.direcao,
    })),
    truncado: linhas.length >= teto,
  };
}

// ===========================================================================
// Busca dentro da conversa
// ===========================================================================

export type AchadoBusca = {
  id: string;
  provider_msg_id: string | null;
  conteudo: string | null;
  direcao: string;
  criada_em: string;
  sender_name: string | null;
  enviado_por_nome: string | null;
};

/**
 * Procura o termo nas mensagens de UMA conversa.
 *
 * O `%` e o `_` do termo digitado passam por `escaparIlike` — sem isso quem
 * digita "10%" recebe qualquer mensagem com "10" e acha que a busca esta
 * quebrada (gotcha da casa, ja pago em outro produto).
 *
 * Anotacao interna ENTRA na busca (ao contrario da galeria de midia): quem
 * procura "o combinado com o financeiro" quer achar a anotacao onde isso foi
 * registrado, e ela e visivel pra quem abre a conversa de todo jeito. Mensagem
 * apagada tambem entra, com a marca — "achei e esta apagada" e informacao;
 * "nao achei" seria mentira.
 */
export async function buscarNaConversa(
  canal: Canal,
  chatId: string,
  termo: string,
  limite = MAX_RESULTADOS_BUSCA
): Promise<{ ok: true; achados: AchadoBusca[]; truncado: boolean } | Falha> {
  const T = tabelas(canal);
  const teto = Math.min(Math.max(1, limite), MAX_RESULTADOS_BUSCA);
  // `*` nao da pra escapar no filtro ilike do PostgREST (ele troca por `%` antes
  // do banco, inclusive depois da barra). Entao o banco recebe o maior pedaco do
  // termo LIVRE de `*` — superset garantido — e o filtro literal roda aqui.
  const padrao = padraoParaIlike(termo);
  if (!padrao.ok) return { ok: false, aviso: padrao.erro };
  // quando vamos filtrar em JS, pedimos MAIS linhas ao banco: senao o teto do
  // superset viraria o teto do resultado final e a busca perderia achado real
  const tetoBanco = padrao.filtrar ? Math.min(teto * 5, MAX_RESULTADOS_BUSCA * 5) : teto;
  // UM `.ilike()` POR PEDACO. O PostgREST junta filtros repetidos com AND, e
  // cada pedaco extra aperta o superset: buscar `*Nome:*` manda so "Nome:", mas
  // `bom*dia` passa a exigir "bom" E "dia" no banco em vez de trazer tudo que
  // tem o maior dos dois pra jogar fora no JavaScript.
  let consulta = msgDb()
    .from(T.mensagens)
    .select("id,provider_msg_id,conteudo,direcao,criada_em,sender_name,enviado_por_nome,is_deleted")
    .eq("chat_id", chatId);
  for (const p of padrao.patterns) consulta = consulta.ilike("conteudo", `%${p}%`);
  const { data, error } = await consulta
    .order("criada_em", { ascending: false })
    .limit(tetoBanco);
  if (error) return aviso(error, "busca na conversa");
  const brutas = data ?? [];
  // `casaTermo` e substring literal normalizada: exige o termo INTEIRO (com os
  // `*`), entao nao entra falso positivo do superset.
  const linhas = padrao.filtrar
    ? brutas.filter((m: any) => casaTermo(m.conteudo, termo)).slice(0, teto)
    : brutas;
  return {
    ok: true,
    achados: linhas.map((m: any) => ({
      id: m.id,
      provider_msg_id: m.provider_msg_id,
      conteudo: m.is_deleted ? null : m.conteudo,
      direcao: m.direcao,
      criada_em: m.criada_em,
      sender_name: m.sender_name,
      enviado_por_nome: m.enviado_por_nome,
    })),
    // truncado fala do que o BANCO cortou: com filtro em JS, o corte que importa
    // e o do superset (se ele encheu, pode haver achado real que nao veio)
    truncado: padrao.filtrar ? brutas.length >= tetoBanco : linhas.length >= teto,
  };
}

// ===========================================================================
// Iniciar conversa: RESERVA ATOMICA (o teto que nao vaza em corrida)
// ===========================================================================

export type Reserva =
  | { estado: "reservado" }
  | { estado: "ja_existe" }
  | { estado: "teto"; na_ultima_hora: number }
  /** a estrutura da 0017 nao existe: o teto NAO vale, e quem chama declara isso */
  | { estado: "sem_0017" }
  /** falha transiente (rede, permissao, banco fora): quem chama RECUSA, nao segue */
  | { estado: "erro"; aviso: string };

/**
 * Reserva a conversa nova ANTES do envio, contando o teto na MESMA instrucao.
 *
 * ACHADO GRAVE DA REVISAO CEGA (31/08/2026). A v1 fazia
 * `contar() -> if (>=20) 429 -> enviar()`: entre a contagem e o envio nao havia
 * nada, entao N chamadas paralelas liam a MESMA contagem e todas passavam. Um
 * teto que so vale quando ninguem esta com pressa nao e teto — e sob pressa
 * (script, agente, aba duplicada) que ele precisava valer.
 *
 * Agora a decisao mora em `mensageria.reservar_inicio` (0017), que conta e
 * insere numa unica instrucao. A linha nasce com `inicio_estado = 'reservado'` e
 * `encerrarReserva` a fecha como 'enviado' ou 'falha_envio'.
 *
 * ISSO INVERTE a ordem "envia primeiro, grava depois" que a v1 declarava. O
 * motivo dela — nao deixar CONVERSA FANTASMA na caixa do time — continua
 * valendo, e a resposta e o `inicio_estado`: estado visivel ("a mensagem nao
 * saiu, e por que") nao e fantasma.
 *
 * FAIL-CLOSED em erro transiente, de propostio: `sem_0017` degrada (a coluna nao
 * existe, o teto nao pode valer, e a rota diz isso); qualquer OUTRA falha vira
 * `erro` e a rota RECUSA sem enviar. Tratar rede fora como "pode enviar"
 * transformaria um blip de banco em janela de disparo sem teto.
 */
export async function reservarInicio(opcoes: {
  canal: Canal;
  chatId: string;
  userId: string;
  userNome: string;
  nome?: string | null;
  teto: number;
}): Promise<Reserva> {
  const T = tabelas(opcoes.canal);
  try {
    const { data, error } = await msgDb().rpc("reservar_inicio", {
      p_tabela: T.conversas,
      p_canal: opcoes.canal,
      p_chat_id: opcoes.chatId,
      p_user_id: opcoes.userId,
      p_user_nome: opcoes.userNome,
      p_nome: opcoes.nome ?? null,
      p_teto: opcoes.teto,
    });
    if (error) {
      // LISTA PROPRIA, MAIS ESTREITA QUE `SEM_ESTRUTURA` (achado da re-revisao).
      // Aqui "degradar" significa ENVIAR SEM TETO, entao so a ausencia da
      // FUNCAO justifica isso. `42P01`/`42703`/`PGRST204` vindos daqui querem
      // dizer outra coisa — tipicamente canal de `CANAIS_EXTRA` cuja tabela nao
      // tem as colunas da 0017 — e ali a resposta certa e RECUSAR, nao abrir o
      // teto. Com a lista larga, esse canal enviava sem limite nenhum.
      if (SEM_RPC.includes(String(error.code ?? ""))) return { estado: "sem_0017" };
      const f = aviso(error, "reserva de conversa nova");
      return { estado: "erro", aviso: f.aviso };
    }
    const estado = String((data as any)?.estado ?? "");
    if (estado === "reservado") return { estado: "reservado" };
    if (estado === "ja_existe") return { estado: "ja_existe" };
    if (estado === "teto") {
      return { estado: "teto", na_ultima_hora: Number((data as any)?.na_ultima_hora ?? 0) };
    }
    // a funcao valida tabela/chat_id e devolve {estado:'erro',motivo}. Nao e
    // degradacao: e pedido torto, e a rota tem que recusar.
    return { estado: "erro", aviso: String((data as any)?.motivo || "reserva recusada pelo banco") };
  } catch (e: any) {
    console.error("tela-conversa (reserva de inicio):", e?.message ?? e);
    return { estado: "erro", aviso: "nao deu pra reservar a conversa nova" };
  }
}

/**
 * Fecha o ciclo da reserva: 'enviado' quando o provedor confirmou,
 * 'falha_envio' quando recusou.
 *
 * Melhor-esforco no LOG, mas o chamador precisa saber se pegou: uma reserva que
 * fica presa em 'reservado' aparece na lista sem dizer se a mensagem saiu, e e
 * exatamente a ambiguidade que o campo existe pra matar.
 */
export async function encerrarReserva(
  canal: Canal,
  chatId: string,
  estado: "enviado" | "falha_envio",
  /**
   * Motivo CURTO e FIXO, escolhido pela rota. Vai virar a previa da conversa na
   * lista ("nao enviada: <motivo>"), entao NUNCA passe a mensagem do provedor
   * aqui: ela e conteudo de terceiro e este repo ja teve incidente de texto de
   * fora chegando a tela.
   */
  motivo?: string
): Promise<boolean> {
  const T = tabelas(canal);
  try {
    const { data, error } = await msgDb().rpc("encerrar_reserva_inicio", {
      p_tabela: T.conversas,
      p_chat_id: chatId,
      p_estado: estado,
      p_motivo: motivo ?? null,
    });
    if (error) {
      console.error("tela-conversa (encerrar reserva):", error.code, error.message);
      return false;
    }
    return data === true;
  } catch (e: any) {
    console.error("tela-conversa (encerrar reserva):", e?.message ?? e);
    return false;
  }
}

/**
 * Desfaz a reserva quando o pedido morre ANTES de tentar o provedor (ex: o
 * numero esta na lista de descadastro, descoberto depois da reserva).
 *
 * Apaga a linha em vez de marcar 'falha_envio': aqui NADA foi tentado, e deixar
 * uma conversa na caixa do time pra um contato que nunca foi contatado poluiria
 * a lista com um atendimento que nao existe. `inicio_estado = 'reservado'` no
 * where garante que so a propria reserva e apagada — nunca uma conversa viva.
 */
export async function desfazerReserva(canal: Canal, chatId: string): Promise<void> {
  const T = tabelas(canal);
  try {
    const { error } = await msgDb()
      .from(T.conversas)
      .delete()
      .eq("chat_id", chatId)
      .eq("inicio_estado", "reservado");
    if (error) console.error("tela-conversa (desfazer reserva):", error.code, error.message);
  } catch (e: any) {
    console.error("tela-conversa (desfazer reserva):", e?.message ?? e);
  }
}

/**
 * O descadastro (opt-out) esta DISPONIVEL nesta instalacao?
 *
 * TRI-ESTADO porque `estaBloqueado` (lib/disparo/bloqueio.ts) devolve `false`
 * tanto pra "esse numero pode receber" quanto pra "a tabela da 0012 nao existe".
 * Sao coisas opostas: na segunda, a checagem de opt-out da rota de iniciar
 * conversa e INERTE — ela passa todo mundo — e a tela precisa dizer isso, com o
 * mesmo aviso amarelo do teto. Silencio ali seria a pessoa achar que o
 * descadastro esta sendo respeitado.
 */
export async function optOutDisponivel(): Promise<boolean> {
  try {
    const { error } = await msgDb().from("campanha_bloqueios").select("chave").limit(1);
    if (!error) return true;
    if (SEM_ESTRUTURA.includes(String(error.code ?? ""))) return false;
    console.error("tela-conversa (opt-out):", error.code, error.message);
    return false;
  } catch {
    return false;
  }
}
