// A DECISAO da recusa: qual frase, e qual status HTTP. Arquivo PURO (importa so
// outro modulo puro, por caminho relativo com extensao) — logo roda em `node`
// solto e e provado por `node scripts/prova-seguranca-conta.ts`.
//
// POR QUE ISTO SAIU DE lib/auth-server.ts (3a revisao da Frente Q, item 7):
// a prova do "oraculo fechado" era TAUTOLOGIA. Ela afirmava que as tres recusas
// de credencial (inexistente, revogada, expirada) tem a mesma frase porque as
// tres usavam a mesma constante — e nao exercitava nem o predicado que escolhe a
// recusa, nem o `{status, error}` que sai na resposta. A prova nao consegue
// importar `lib/auth-server.ts` (ele puxa o cliente do Supabase e
// aliases `@/`, que o node solto nao resolve; `next/server` nao e o obstaculo), entao o unico jeito honesto de
// travar o invariante era mover a DECISAO pra ca. O auth-server segue dono da
// porta; daqui sai so o veredito, e ele o embala em NextResponse.
import { chaveExpirada } from "./escopo-chave.ts";

/**
 * Marcador interno de "nao ha identidade aqui" (401, nao 403).
 *
 * Vive colado na frase, num prefixo que NUNCA pode aparecer num motivo de
 * verdade (bytes de controle) — e por isso e removido antes de qualquer coisa
 * chegar ao cliente. Escrito como escape `\u0000` e nao como byte literal: byte
 * nulo no arquivo faz o PostgREST recusar a coluna text e some em diff.
 */
export const SEM_IDENTIDADE = "\u0000sem_identidade\u0000";

/**
 * A frase UNICA de "esta chave nao serve".
 *
 * ORACULO FECHADO: chave inexistente, chave revogada e chave expirada respondem
 * a MESMA coisa, com o MESMO status. Diferenciar deixava quem tem uma chave
 * vazada descobrir, pela frase, que a chave existia e foi revogada — ou seja,
 * confirmava que o palpite estava certo. Motivo ESPECIFICO existe so pra chave
 * VALIDA barrada por escopo, onde nao ha o que confirmar (o portador ja provou
 * ter a chave).
 */
export const MOTIVO_CHAVE_SEM_ACESSO = "chave de API invalida, expirada ou sem acesso";

/** Marca uma frase como recusa SEM identidade. */
export function marcarSemIdentidade(motivo: string): string {
  return `${SEM_IDENTIDADE}${motivo}`;
}

/** Esta recusa e de credencial que nao resolve? */
export function ehSemIdentidade(bruto: string | null | undefined): boolean {
  return typeof bruto === "string" && bruto.startsWith(SEM_IDENTIDADE);
}

/** A frase, sem o marcador — o que pode chegar ao cliente. */
export function motivoLimpo(bruto: string | null | undefined): string | null {
  if (typeof bruto !== "string" || !bruto) return null;
  return bruto.startsWith(SEM_IDENTIDADE) ? bruto.slice(SEM_IDENTIDADE.length) : bruto;
}

export type ChaveViva = { revogada: boolean; expiraEm: string | Date | null };
export type LinhaDeChave = ChaveViva | null;

/** A recusa de chave, pronta e marcada. UMA constante pros tres casos: e o que
 *  faz a frase unica ser estrutural, e nao uma promessa de comentario. */
export const RECUSA_CHAVE = marcarSemIdentidade(MOTIVO_CHAVE_SEM_ACESSO);

/**
 * A chave resolve? Devolve a recusa JA MARCADA, ou null se a chave serve.
 *
 * Os tres casos (inexistente, revogada, expirada) passam por aqui — nao existe
 * outro caminho no auth-server que recuse credencial de chave.
 */
export function recusaDaChave(linha: LinhaDeChave, agora?: Date): string | null {
  if (!linha || linha.revogada || chaveExpirada(linha.expiraEm, agora)) return RECUSA_CHAVE;
  return null;
}

/**
 * O MESMO veredito, em forma de guard — e o que a porta usa, porque depois de
 * passar ela precisa que o TypeScript saiba que a linha nao e nula.
 */
export function chaveServe<T extends ChaveViva>(linha: T | null, agora?: Date): linha is T {
  return recusaDaChave(linha, agora) === null;
}

export type RespostaRecusa = { status: number; error: string; sem_acesso?: true };

/**
 * O corpo e o status da resposta de "sem acesso".
 *
 *  - sem motivo registrado: 401 seco (a porta recusou e ninguem explicou).
 *  - credencial que nao resolve: 401 — nao ha identidade nenhuma.
 *  - credencial VALIDA barrada pela politica (janela, dispositivo, escopo): 403
 *    — "eu sei quem voce e, e a politica te barrou"; nao adianta tentar de novo
 *    com outra senha.
 */
export function respostaDaRecusa(bruto: string | null | undefined): RespostaRecusa {
  if (typeof bruto !== "string" || !bruto) return { status: 401, error: "unauthorized" };
  if (bruto.startsWith(SEM_IDENTIDADE)) {
    return { status: 401, error: bruto.slice(SEM_IDENTIDADE.length), sem_acesso: true };
  }
  return { status: 403, error: bruto, sem_acesso: true };
}
