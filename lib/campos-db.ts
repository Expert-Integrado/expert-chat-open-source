// A FIACAO do construtor de ficha (Frente X, card 86ak85nxn).
//
// A DECISAO mora em `lib/campos.ts` (puro, roda em node solto). Aqui esta o que
// exige banco: ler o catalogo com degradacao, contar o impacto de remover um
// campo, migrar os valores num renome e gravar.
//
// DEGRADACAO EM DUAS CAMADAS, o padrao que a 0015 estabeleceu em `/api/fluxos`:
// as colunas do construtor (`tipo`, `obrigatorio`, `opcoes`, `descricao`) sao da
// 0025, que e gesto humano. Enquanto ela nao rodar, a leitura detecta 42703 /
// PGRST204, refaz o select SEM as colunas novas e devolve
// `tipos_disponiveis: false` — some o TIPO, nao o campo. Re-testa a cada 60s: no
// minuto seguinte a migration rodar, passa a valer sem redeploy.
import { msgDb } from "@/lib/mensageria";
import { fonteExterna, listarCanais } from "@/lib/canais";
import {
  campoDaLinha,
  medirImpacto,
  migrarRenome,
  type CampoFicha,
  type ImpactoCampo,
  type RespostaMigracao,
  type ResultadoRenome,
  contagemDaResposta,
  nomeCabeNoCaminhoJsonb,
  catalogoLido,
  falhaDeLeitura,
  type CatalogoCampos,
} from "@/lib/campos";

export type { ResultadoRenome, CatalogoCampos };

const COLS_NOVAS = "id,nome,ordem,ativo,tipo,obrigatorio,opcoes,descricao,atualizado_em";
const COLS_BASE = "id,nome,ordem,ativo";
// 42703 coluna inexistente (Postgres) | PGRST204 coluna fora do schema cache
// (PostgREST logo depois do DDL, antes do notify)
const COL_INEXISTENTE = ["42703", "PGRST204"];
// RPC INDISPONIVEL: a 0025 nao rodou (PGRST202 = funcao fora do schema cache,
// 42883 = funcao inexistente) OU rodou sem o par `grant execute` (42501 =
// permission denied for function). Os tres tem o MESMO efeito pra quem usa — a
// funcao nao esta chamavel — e por isso caem no mesmo latch.
//
// O 42501 esta aqui porque ele quase escapou: a primeira versao da 0025 tinha o
// `revoke ... from public` sem o `grant ... to service_role`, e `revoke` tira de
// TODO MUNDO. Nessa situacao a chamada volta 42501, `semRpc` NAO era marcado,
// `renome_disponivel` continuava `true` e a tela prometia um renome que a rota
// devolvia como 502 com a mensagem crua do Postgres. A migration foi corrigida;
// o codigo trata o caso mesmo assim, porque instalacao antiga (ou um `revoke`
// manual de alguem) reproduz exatamente isso.
const RPC_AUSENTE = ["PGRST202", "42883", "42501"];

const JANELA_RETESTE_MS = 60_000;
let semColunas = 0;
let semRpc = 0;

const colunasOk = () => Date.now() - semColunas > JANELA_RETESTE_MS;
const rpcOk = () => Date.now() - semRpc > JANELA_RETESTE_MS;

/**
 * A FORMA do catalogo (`CatalogoCampos`, `legivel`, `renome_disponivel`, o aviso
 * da 0025) mora em `lib/campos.ts` — ver `falhaDeLeitura` e `catalogoLido` la.
 *
 * Ela SAIU daqui na re-revisao cega de 31/08/2026 por um motivo medido: enquanto
 * os dois objetos eram literais dentro desta funcao, a unica prova possivel era
 * varredura de texto, e trocar `legivel: false` por `true` (ou pendurar
 * `|| true` no `renome_disponivel`) sobrevivia a bateria inteira. Aqui ficou so o
 * EXECUTOR: falar com o banco e entregar o que mediu.
 */

/**
 * O catalogo, ordenado como a ficha aparece.
 *
 * Le TODOS os campos (ativos e arquivados), e isso e requisito: o construtor
 * precisa mostrar o arquivado pra alguem poder trazer de volta, e a ficha precisa
 * saber que um valor orfao pertence a um campo arquivado — nao a "nenhum campo".
 */
export async function lerCatalogo(): Promise<CatalogoCampos> {
  const db = msgDb();
  const usar = colunasOk();
  // A lista de colunas e decidida em runtime (a 0025 pode nao ter rodado), e o
  // supabase-js infere o tipo do retorno a partir do LITERAL do select — com uma
  // string dinamica ele devolve `ParserError`. Mesmo desenho de
  // `/api/respostas-rapidas`: um montador que recebe `cols: string` e o cast na
  // saida, que e onde `campoDaLinha` sanea cada linha de todo jeito.
  const monta = (cols: string) => db.from("campos_personalizados").select(cols).order("ordem");
  let { data, error } = await monta(usar ? COLS_NOVAS : COLS_BASE);
  if (error && usar && COL_INEXISTENTE.includes(String((error as any).code))) {
    semColunas = Date.now();
    ({ data, error } = await monta(COLS_BASE));
  }
  if (error) {
    // LISTA VAZIA COM AVISO, nunca 500 — e nunca lista vazia CALADA: "esta
    // instalacao nao tem campo nenhum" e uma AFIRMACAO, e a tela nao pode
    // faze-la quando a verdade e "nao deu pra ler o catalogo". A FORMA da recusa
    // e decidida em lib/campos.ts (pura e provada por desfecho).
    return falhaDeLeitura(error.message);
  }
  const campos = ((data ?? []) as unknown as Record<string, unknown>[])
    .map((l) => campoDaLinha(l))
    .filter((c): c is CampoFicha => !!c)
    // ORDEM ESTAVEL: `ordem` empata (o default e 999 e o sync cria varios em
    // 900+), e ordem que empata e ordem que o banco resolve como quiser — a ficha
    // embaralharia sozinha entre dois carregamentos. Nome desempata.
    .sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, "pt-BR"));
  return catalogoLido(campos, colunasOk(), rpcOk());
}

/** So os campos ativos, na ordem da ficha. */
export async function lerCatalogoAtivo(): Promise<CatalogoCampos> {
  const c = await lerCatalogo();
  return { ...c, campos: c.campos.filter((x) => x.ativo) };
}

/**
 * Quantas conversas tem valor gravado neste campo — POR CANAL, e com o
 * denominador escrito.
 *
 * POR QUE VARRE TODOS OS CANAIS: o catalogo e da INSTALACAO (uma linha em
 * `campos_personalizados`, sem coluna de canal), mas o VALOR mora na tabela de
 * conversas de CADA canal (`conversas`, `conversas_apioficial`,
 * `conversas_<extra>`). Contar so o canal em foco daria um impacto menor que o
 * real, e o numero que a tela mostra antes de remover um campo e justamente o que
 * impede a remocao no escuro.
 *
 * A DECISAO NAO MORA AQUI: a travessia (o que fazer com canal que nao respondeu,
 * com lista vazia, com resposta torta) e `medirImpacto` em `lib/campos.ts`, que
 * roda na prova com um fake no lugar do banco. O que fica aqui e o EXECUTOR:
 * contar UM canal. Enquanto a regra morava dentro desta funcao, a unica prova
 * possivel era varredura de texto — e um `?? 0` no lugar do `null` desligava o
 * freio da remocao com a bateria verde.
 */
export async function impactoDoCampo(nome: string): Promise<ImpactoCampo> {
  return medirImpacto(canaisDaFicha(), (canal) => contarCampoNoCanal(canal, nome));
}

/**
 * OS CANAIS QUE TEM FICHA — o denominador das DUAS travessias (impacto e renome) e
 * do efeito injetado da rota de arquivamento.
 *
 * Canal de fonte externa (instagram-agent) nao tem tabela de conversa no painel:
 * a ficha dele nao existe, entao nao ha valor pra contar la. Incluir o canal na
 * varredura produziria `null` (tabela ausente) e o impacto sairia INCOMPLETO pra
 * sempre, travando toda remocao de campo da instalacao.
 *
 * O FILTRO MORA AQUI, UMA VEZ. Ele era copiado nas duas travessias, e a prova
 * precisava CONTAR as ocorrencias no arquivo pra pegar a remocao de UMA delas
 * (medido na revisao cega). Com uma origem so, tirar o filtro quebra as duas de
 * uma vez — e a guarda volta a falar de propriedade, nao de aritmetica de texto.
 *
 * LISTA VAZIA NAO E "zero valor gravado": quem trata isso e `medirImpacto`
 * (lib/campos.ts, puro), que devolve `incompleto: true` — nada medido tem que
 * RECUSAR. Por isso nao ha `?? [algum canal]` em lugar nenhum aqui.
 */
function canaisComFicha() {
  return listarCanais().filter((c) => !fonteExterna(c));
}

/** os ids dos canais varridos — o `canais` do efeito de arquivamento */
export function canaisDaFicha(): string[] {
  return canaisComFicha().map((c) => c.id);
}

/** a tabela de conversas de um canal varrido; `""` = canal que nao tem ficha */
function tabelaDoCanal(canal: string): string {
  return canaisComFicha().find((c) => c.id === canal)?.tabelas.conversas ?? "";
}

/**
 * EXECUTOR de UM canal, endereçado por ID DE CANAL (e nao por nome de tabela): e
 * a forma que o efeito injetado da rota de arquivamento usa. Canal desconhecido,
 * ou canal sem tabela de conversas, vira `null` = "nao sei" — nunca zero.
 */
export async function contarCampoNoCanal(canal: string, nome: string): Promise<number | null> {
  return contarNoCanal(tabelaDoCanal(canal), nome);
}

/** EXECUTOR de UM canal: a RPC da 0025, com a leitura direta como reserva. */
async function contarNoCanal(tabela: string, nome: string): Promise<number | null> {
  if (!tabela) return null;
  if (!rpcOk()) return contarPorLeitura(tabela, nome);
  const { data, error } = await msgDb().rpc("contar_valores_campo", { p_tabela: tabela, p_nome: nome });
  if (error) {
    if (RPC_AUSENTE.includes(String((error as any).code))) semRpc = Date.now();
    else console.error("impactoDoCampo rpc:", error.message);
    return contarPorLeitura(tabela, nome);
  }
  // A funcao devolve NULL (nao 0) pra tabela que ela nao valida — e `null` aqui
  // significa "nao deu pra contar", que RECUSA a remocao. A decisao mora em
  // `contagemDaResposta` (lib/campos.ts, pura e provada): trocar isto por `0` aqui
  // fazia o painel dizer "nenhuma conversa usa" depois de uma consulta que nem
  // respondeu, e a bateria inteira continuava verde.
  return contagemDaResposta(data);
}

/**
 * Contagem SEM a 0025, pelo PostgREST.
 *
 * O filtro por chave de jsonb no PostgREST monta o caminho na URL
 * (`ficha->>Nome=not.is.null`), e o nome do campo e TEXTO ESCOLHIDO POR GENTE —
 * com ponto, com virgula, com parentese. Caminho que nao casa devolveria erro (e
 * `null`, que RECUSA a remocao) em vez de contar errado, o que e o desfecho certo:
 * na duvida, nao remove. Nome com caractere que o caminho nao aceita vira `null`
 * ANTES da chamada, com o mesmo efeito e sem gastar request.
 */
async function contarPorLeitura(tabela: string, nome: string): Promise<number | null> {
  if (!nomeCabeNoCaminhoJsonb(nome)) return null;
  const { count, error } = await msgDb()
    .from(tabela)
    .select("chat_id", { count: "exact", head: true })
    .not(`ficha->>${nome}`, "is", null)
    .neq(`ficha->>${nome}`, "");
  if (error) console.error("contarPorLeitura:", error.message);
  // mesma decisao do caminho da RPC, no mesmo lugar: erro, ausencia e resposta que
  // nao e numero sao TODOS "nao sei", nunca zero.
  return contagemDaResposta(count, error);
}

/**
 * Move o valor de `de` pra `para` em TODOS os canais.
 *
 * A DECISAO da travessia — sequencial, para no primeiro canal que falhar, falha
 * parcial DECLARADA e quem chama nao troca o nome no catalogo — e `migrarRenome`
 * em `lib/campos.ts`, provada com executor injetado. O que fica aqui e o
 * EXECUTOR: migrar UM canal pela funcao da 0025.
 */
export async function renomearValores(de: string, para: string): Promise<ResultadoRenome> {
  if (!rpcOk()) return { ok: false, motivo: "a funcao de renome (migration 0025) nao esta disponivel nesta instalacao" };
  return migrarRenome(canaisDaFicha(), async (canal) => {
    const tabela = tabelaDoCanal(canal);
    if (!tabela) return { ok: false, motivo: "canal sem tabela de conversas" };
    const { data, error } = await msgDb().rpc("renomear_campo_ficha", { p_tabela: tabela, p_de: de, p_para: para });
    if (error) {
      if (RPC_AUSENTE.includes(String((error as any).code))) semRpc = Date.now();
      return { ok: false, motivo: error.message };
    }
    return data as RespostaMigracao;
  });
}

export type Gravacao = { ok: true } | { ok: false; motivo: string; status: number };

/** Escreve a definicao de um campo. Coluna ausente = 400 explicito, nunca 500. */
export async function gravarCampo(
  id: string | null,
  patch: Record<string, unknown>,
  comColunasNovas: boolean
): Promise<{ ok: true; id: string } | { ok: false; motivo: string; status: number }> {
  const db = msgDb();
  const corpo = { ...patch };
  if (!comColunasNovas) {
    // A 0025 nao rodou: grava SO o que a tabela tem. E a resposta da rota diz o
    // que NAO entrou — "salvei" pra um tipo que nao foi gravado e a mentira que
    // faz o admin sair achando que a ficha esta tipada.
    delete corpo.tipo;
    delete corpo.obrigatorio;
    delete corpo.opcoes;
    delete corpo.descricao;
    delete corpo.atualizado_em;
  }
  if (id) {
    const { error } = await db.from("campos_personalizados").update(corpo).eq("id", id);
    if (error) return { ok: false, motivo: error.message, status: erroDeColuna(error) ? 400 : 500 };
    return { ok: true, id };
  }
  const { data, error } = await db.from("campos_personalizados").insert(corpo).select("id").single();
  if (error) {
    // 23505 = a UNIQUE por nome exato da 0001. Ela e a corrida que a checagem em
    // codigo nao fecha (dois administradores criando o mesmo campo no mesmo
    // segundo leem o catalogo sem o outro).
    if (String((error as any).code) === "23505") {
      return { ok: false, motivo: "ja existe um campo com esse nome", status: 409 };
    }
    return { ok: false, motivo: error.message, status: erroDeColuna(error) ? 400 : 500 };
  }
  return { ok: true, id: String(data.id) };
}

export async function apagarCampo(id: string): Promise<Gravacao> {
  const { error } = await msgDb().from("campos_personalizados").delete().eq("id", id);
  if (error) return { ok: false, motivo: error.message, status: 500 };
  return { ok: true };
}

export async function gravarOrdens(ordens: { id: string; ordem: number }[]): Promise<Gravacao> {
  const db = msgDb();
  for (const o of ordens) {
    const { error } = await db.from("campos_personalizados").update({ ordem: o.ordem }).eq("id", o.id);
    if (error) return { ok: false, motivo: error.message, status: 500 };
  }
  return { ok: true };
}

function erroDeColuna(error: any): boolean {
  if (COL_INEXISTENTE.includes(String(error?.code))) {
    semColunas = Date.now();
    return true;
  }
  return false;
}

// ─────────────────────────────────────── valores da ficha de UMA conversa

export type LeituraFicha =
  | { ok: true; ficha: Record<string, unknown> }
  | { ok: false; motivo: string; status: number };

export async function lerFichaDaConversa(tabelaConversas: string, chatId: string): Promise<LeituraFicha> {
  const { data, error } = await msgDb().from(tabelaConversas).select("ficha").eq("chat_id", chatId).maybeSingle();
  if (error) return { ok: false, motivo: error.message, status: 500 };
  if (!data) return { ok: false, motivo: "conversa nao encontrada", status: 404 };
  const f = (data as any).ficha;
  return { ok: true, ficha: f && typeof f === "object" && !Array.isArray(f) ? f : {} };
}

export async function gravarFichaDaConversa(
  tabelaConversas: string,
  chatId: string,
  ficha: Record<string, unknown>
): Promise<Gravacao> {
  const { error } = await msgDb()
    .from(tabelaConversas)
    .update({ ficha, updated_at: new Date().toISOString() })
    .eq("chat_id", chatId);
  if (error) return { ok: false, motivo: error.message, status: 500 };
  return { ok: true };
}
