// LISTA DE CONVERSAS ALEM DA JANELA (decisao do Eric, 03/09/2026): a listagem
// `/api/chats` cortava em 600 por canal, CALADA — 95% do acervo do central e 92%
// do apioficial ficavam invisiveis, inclusive 413 conversas nao concluidas (7 com
// mensagem de cliente nao lida). Duas saidas, as duas no SERVIDOR:
//   * BUSCA (`?q=`): nome (contem, sem caixa) OU digitos do numero (>= 3), no
//     acervo inteiro — nao so nas 600 carregadas;
//   * PAGINACAO (`?antes=<last_message_at>`): a proxima pagina de conversas mais
//     antigas que a ultima que a tela ja tem ("Carregar conversas mais antigas").
// Este modulo e PURO (sem banco, sem React): decide padroes, limites e a mescla
// entre a pagina que o poll traz e o que a pessoa ja puxou a mais. Prova em
// scripts/prova-lista-conversas.ts.

/** Tamanho da pagina que o poll da lista traz (o teto historico, mantido). */
export const PAGINA_PADRAO = 600;
export const PAGINA_MIN = 50;
export const PAGINA_MAX = 600;
/** Quantas conversas uma busca no acervo devolve no maximo (por canal). */
export const BUSCA_MAX = 100;
/** Menos que isto de texto util nao vai ao servidor (evita "a" varrer o acervo). */
export const BUSCA_MIN_CHARS = 2;

export function normalizarLimite(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return PAGINA_PADRAO;
  return Math.max(PAGINA_MIN, Math.min(PAGINA_MAX, n));
}

/** So os digitos do texto (mascara, espaco, +55 caem fora). */
export function digitosDe(texto: string): string {
  return (texto || "").replace(/\D/g, "");
}

/**
 * Padrao `%texto%` pro `ilike`, com os coringas do PROPRIO texto escapados.
 * Sem isto, digitar `%` ou `_` no campo vira "qualquer coisa" (ilike com input do
 * usuario vira coringa — licao ja paga no cupom do portal). O `\` tambem, senao
 * ele engoliria o escape seguinte.
 */
export function padraoIlike(texto: string): string {
  const esc = texto.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${esc}%`;
}

export type CriteriosBusca = {
  /** padrao pronto pro `ilike` em `nome`; null = nao buscar por nome */
  nome: string | null;
  /** digitos pra `like` em `chat_id`; null = nao buscar por numero */
  digitos: string | null;
};

/**
 * O que a busca `?q=` procura. Espelha `conversaBateBusca` da tela (nome CONTEM o
 * texto, ou o numero CONTEM os digitos, com >= 3 digitos) — a tela e o servidor
 * tem que concordar, senao o servidor traz o que a tela esconde (ou vice-versa).
 * Devolve null quando o texto e curto demais pra valer uma ida ao acervo.
 */
export function criteriosDeBusca(q: string | null | undefined): CriteriosBusca | null {
  const texto = (q ?? "").trim();
  if (texto.length < BUSCA_MIN_CHARS) return null;
  const digitos = digitosDe(texto);
  return {
    nome: padraoIlike(texto.toLowerCase()),
    digitos: digitos.length >= 3 ? digitos : null,
  };
}

/** `?antes=` valido = ISO que o Date entende; qualquer outra coisa e ignorada. */
export function cursorAntes(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return isNaN(t) ? null : new Date(t).toISOString();
}

type ComOrdem = { uid: string; last_message_at: string | null };

function ordenar<T extends ComOrdem>(lista: T[]): T[] {
  return lista.sort((a, b) => (b.last_message_at || "").localeCompare(a.last_message_at || ""));
}

/**
 * A pagina do poll (`cabeca`) chegou: o que a pessoa puxou A MAIS (paginas antigas,
 * resultados de busca — os uids em `extras`) continua na lista, desde que nao esteja
 * na cabeca (a cabeca e mais fresca e VENCE). Sem isto cada poll de 3s apagaria o
 * que "Carregar mais antigas" trouxe.
 */
export function manterExtras<T extends ComOrdem>(cabeca: T[], anterior: T[], extras: ReadonlySet<string>): T[] {
  const naCabeca = new Set(cabeca.map((c) => c.uid));
  const sobras = anterior.filter((c) => extras.has(c.uid) && !naCabeca.has(c.uid));
  return ordenar([...cabeca, ...sobras]);
}

/**
 * Junta conversas recem-puxadas (busca ou pagina antiga) a lista atual, sem
 * duplicar: o que chegou agora vence a copia antiga do mesmo uid.
 */
export function adicionarExtras<T extends ComOrdem>(atual: T[], novos: T[]): T[] {
  const chegou = new Set(novos.map((c) => c.uid));
  return ordenar([...novos, ...atual.filter((c) => !chegou.has(c.uid))]);
}

/**
 * O cursor da proxima pagina de um canal: a `last_message_at` mais antiga que a
 * lista ja tem daquele canal (conversa sem data nao serve de cursor). null =
 * nao ha de onde paginar (lista vazia ou so sem data).
 */
export function cursorMaisAntigo<T extends { canal: string; last_message_at: string | null }>(
  lista: T[],
  canal: string
): string | null {
  let menor: string | null = null;
  for (const c of lista) {
    if (c.canal !== canal || !c.last_message_at) continue;
    if (menor === null || c.last_message_at < menor) menor = c.last_message_at;
  }
  return menor;
}
