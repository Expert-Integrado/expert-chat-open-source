// REACAO A MENSAGEM (03/09/2026) — pedido do Eric: "nao tem botao de reagir nas
// mensagens. Tem q ter. Igual no WhatsApp".
//
// Este arquivo e PURO (sem import, sem env, sem banco): a decisao mora aqui e e
// provada em node solto (scripts/prova-reacoes.ts). A rota
// (app/api/mensagem/reacao/route.ts) e a tela (app/home.tsx) so consomem.
//
// O QUE E UMA REACAO NO PAINEL: um emoji pendurado numa mensagem que ja existe —
// nunca vira linha nova em `mensagens`. A coluna `reacao` (text) ja existia no
// schema BASE e ja era preenchida pelo webhook quando o CLIENTE reage; agora o
// atendente tambem escreve nela. Ela guarda a reacao MAIS RECENTE da mensagem:
// reagir de novo troca, string vazia remove (mesma semantica da Z-API e da
// Evolution: `reaction: ""` tira a reacao). Quem reage a uma mensagem do cliente
// somos nos (linha `in`); quem reage a uma mensagem nossa e o cliente (linha
// `out`) — as duas leituras vivem em linhas diferentes e nao colidem. Grupo com N
// reacoes na mesma mensagem mostra a ultima (limite declarado, o mesmo que o
// importador do acervo assumiu).
//
// QUAIS CANAIS: Z-API e Evolution tem o gesto (POST send-reaction e POST
// message/sendReaction). A API oficial via Gupshup v1 (`/wa/api/v1/msg`) NAO
// lista `reaction` entre os tipos de mensagem (doc oficial lida em 03/09/2026:
// text, image, file, audio, video, sticker, list, quick_reply, location,
// contact) — nesse numero a rota responde 403 com o motivo em vez de fingir.
// Canal de fonte externa (instagram-agent) e somente leitura no painel.

export const REACOES_RAPIDAS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

// teto em code units: emoji composto (tom de pele, ZWJ, bandeira) cabe folgado;
// texto colado no lugar do emoji nao
export const TETO_REACAO = 16;

export function suportaReacao(fonte: unknown): boolean {
  return fonte === "zapi" || fonte === "evolution";
}

const MOTIVO_SEM_REACAO: Record<string, string> = {
  gupshup:
    "no numero da API oficial ainda nao da pra reagir (o envio v1 da Gupshup nao tem esse tipo de mensagem)",
  "instagram-agent": "este canal e somente leitura no painel",
  "whatsapp-agent": "reagir pelo WhatsApp Agent ainda nao esta cabeado neste painel (a tool `react` do agente existe; falta o ramo aqui)",
};

export function motivoSemReacao(fonte: unknown): string {
  return MOTIVO_SEM_REACAO[String(fonte)] ?? "este canal nao suporta reagir a mensagem";
}

const segmentador =
  typeof Intl !== "undefined" && typeof (Intl as any).Segmenter === "function"
    ? new (Intl as any).Segmenter("und", { granularity: "grapheme" })
    : null;

// Quantos "caracteres visiveis" o texto tem. "👍🏽" e "❤️" sao UM grafema cada
// (o que a pessoa ve como um emoji), mesmo tendo 2+ code points.
export function contarGrafemas(texto: string): number {
  if (segmentador) {
    let n = 0;
    for (const _ of segmentador.segment(texto)) n++;
    return n;
  }
  return Array.from(texto).length;
}

const PICTOGRAFICO = /\p{Extended_Pictographic}/u;

export type ReacaoValida = { ok: true; emoji: string };
export type ReacaoInvalida = { ok: false; erro: string };

// Vazio = REMOVER a reacao (ok, emoji ""). Qualquer outra coisa tem que ser UM
// emoji: um grafema so, pictografico, dentro do teto. Fail-closed: letra, numero,
// dois emojis, texto — recusa com motivo. Vale na rota (400) e e o que a tela ja
// respeita ao oferecer so a barra de emojis.
export function validarReacao(valor: unknown): ReacaoValida | ReacaoInvalida {
  if (typeof valor !== "string") {
    return { ok: false, erro: "reacao tem que ser um emoji (ou vazio pra remover)" };
  }
  const v = valor.trim();
  if (v === "") return { ok: true, emoji: "" };
  if (v.length > TETO_REACAO) return { ok: false, erro: "reacao muito longa: use um emoji so" };
  if (contarGrafemas(v) !== 1) return { ok: false, erro: "reacao e um emoji so" };
  if (!PICTOGRAFICO.test(v)) return { ok: false, erro: "reacao tem que ser um emoji" };
  return { ok: true, emoji: v };
}

// O que vai pra coluna `reacao`: emoji, ou null quando removida.
export function reacaoGravada(emoji: string): string | null {
  return emoji === "" ? null : emoji;
}

// Z-API: POST send-reaction {phone, messageId, reaction}. Mesmo contrato que o
// whatsapp-agent roda em producao (edge wa-proxy, acao send-reaction).
export function corpoReacaoZapi(phone: string, messageId: string, emoji: string) {
  return { phone, messageId, reaction: emoji };
}

// Evolution: POST message/sendReaction {key: {remoteJid, fromMe, id}, reaction}.
// `fromMe` e da MENSAGEM ALVO (nossa = true, do cliente = false) — e assim que a
// Evolution localiza a mensagem certa; errar o flag reage em mensagem nenhuma.
export function corpoReacaoEvolution(remoteJid: string, messageId: string, fromMe: boolean, emoji: string) {
  return { key: { remoteJid, fromMe, id: messageId }, reaction: emoji };
}

export type MensagemReagivel = {
  provider_msg_id?: string | null;
  is_deleted?: boolean | null;
  interna?: boolean | null;
  direcao?: string | null;
};

// O portao unico da tela e da rota: da pra reagir quando o canal suporta, a
// mensagem existe no WhatsApp (tem id do provedor), nao foi apagada e nao e
// anotacao interna (anotacao nao vai pro WhatsApp — nao ha onde reagir).
export function podeReagir(fonte: unknown, m: MensagemReagivel): boolean {
  if (!suportaReacao(fonte)) return false;
  if (!m.provider_msg_id) return false;
  if (m.is_deleted) return false;
  if (m.interna || m.direcao === "interna") return false;
  return true;
}

// Aplicacao OTIMISTA na lista da tela: troca so a mensagem alvo, sem mutar a
// lista original (o poll seguinte confirma ou corrige).
export function aplicarReacao<T extends { id: string; reacao?: string | null }>(
  msgs: T[],
  id: string,
  emoji: string
): T[] {
  return msgs.map((m) => (m.id === id ? { ...m, reacao: reacaoGravada(emoji) } : m));
}
