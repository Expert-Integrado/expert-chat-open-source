import { corpoReacaoEvolution } from "@/lib/reacoes";
import { canalPorId } from "@/lib/canais";
import {
  jidEvolution,
  numeroEvolution,
  parseSendResult,
  separarDataUri,
} from "@/lib/evolution-formato";

// Motor EVOLUTION API (v2.3, self-hosted/Baileys) — 3o provedor do painel, ao
// lado de Z-API e Gupshup. Logica portada do adapter do WhatsApp Agent
// (supabase/functions/_shared/wa/evolution.ts, Deno) pra Next/Node.
//
// Diferencas que importam pra quem le:
//  - host NAO e fixo (cada instalacao roda o proprio servidor) -> base_url por canal;
//  - auth por header `apikey` (a Z-API poe o token na URL);
//  - a instancia vai no FIM do path: {base}/message/sendText/{instance};
//  - destinatario e `number` (so digitos), nao `phone`;
//  - reply e `quoted:{key:{id}}`, nao `messageId`.
//
// Credencial por canal, produto BASE (N numeros por instalacao):
//   EVOLUTION_<ID_MAIUSCULO>_BASE_URL     URL do servidor Evolution da instalacao
//   EVOLUTION_<ID_MAIUSCULO>_INSTANCE_ID  ATENCAO: e o NOME da instancia (o mesmo
//                                         texto que vai no fim do path das
//                                         chamadas e que chega em `instance` no
//                                         webhook), NAO um UUID. O nome da env
//                                         so acompanha a convencao das outras
//                                         fontes; o UUID que a Evolution mostra
//                                         no painel dela nao serve aqui.
//   EVOLUTION_<ID_MAIUSCULO>_API_KEY      apikey do servidor
//   EVOLUTION_<ID_MAIUSCULO>_WEBHOOK_TOKEN (opcional: barreira extra no webhook)
// Sem as tres primeiras = canal nao cabeado (fail-closed; envioDisponivel em
// lib/canais.ts usa a MESMA convencao). Nada da empresa hardcodado aqui.
export type EvolutionCreds = {
  baseUrl: string;
  instance: string;
  apiKey: string;
  webhookToken: string;
};

export function credsEvolution(canal: string): EvolutionCreds | null {
  const def = canalPorId(canal);
  if (!def || def.fonte !== "evolution") return null;
  const p = `EVOLUTION_${canal.toUpperCase()}_`;
  const baseUrl = process.env[p + "BASE_URL"];
  const instance = process.env[p + "INSTANCE_ID"];
  const apiKey = process.env[p + "API_KEY"];
  if (!baseUrl || !instance || !apiKey) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    instance,
    apiKey,
    webhookToken: process.env[p + "WEBHOOK_TOKEN"] || "",
  };
}

// as partes puras (destino, data URI, id de retorno) vivem em evolution-formato.ts
export { jidEvolution, numeroEvolution, parseSendResult, separarDataUri };

function urlDe(creds: EvolutionCreds, path: string) {
  return `${creds.baseUrl}/${path}/${creds.instance}`;
}
function headers(creds: EvolutionCreds) {
  return { "Content-Type": "application/json", apikey: creds.apiKey };
}

async function chamar(
  creds: EvolutionCreds,
  path: string,
  body: unknown,
  method: "POST" | "DELETE" = "POST"
): Promise<{ messageId: string | null }> {
  const res = await fetch(urlDe(creds, path), {
    method,
    headers: headers(creds),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j?.error) {
    throw new Error(`Evolution ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return parseSendResult(j);
}

// reply: a Evolution referencia a mensagem citada por quoted.key.id
function opcoes(quoted?: string | null) {
  return quoted ? { quoted: { key: { id: quoted } } } : {};
}

export function evoSendText(
  creds: EvolutionCreds,
  destino: string,
  texto: string,
  quoted?: string | null
) {
  return chamar(creds, "message/sendText", {
    number: numeroEvolution(destino),
    text: texto,
    ...opcoes(quoted),
  });
}

const MEDIA_TYPE: Record<string, "image" | "video" | "document"> = {
  image: "image",
  video: "video",
  document: "document",
};

export function evoSendMedia(
  creds: EvolutionCreds,
  tipo: "image" | "audio" | "ptt" | "video" | "document" | "gif",
  destino: string,
  dado: string,
  opts: { caption?: string; fileName?: string; mime?: string; quoted?: string | null } = {}
) {
  // FAIL-CLOSED de proposito (portado): a Evolution v2.3 NAO tem endpoint de gif
  // nem gifPlayback. Sem esta recusa, gif cairia no sendText e o destinatario
  // receberia um balao VAZIO com o log dizendo "enviado".
  if (tipo === "gif") {
    throw new Error(
      "Este numero (Evolution) nao envia gif — a API nao tem esse endpoint. Mande como video."
    );
  }
  const number = numeroEvolution(destino);
  const { conteudo, mime } = separarDataUri(dado);
  const mimetype = opts.mime || mime || undefined;

  if (tipo === "audio" || tipo === "ptt") {
    // audio de voz tem endpoint proprio (o sendMedia manda como arquivo comum)
    return chamar(creds, "message/sendWhatsAppAudio", {
      number,
      audio: conteudo,
      ...opcoes(opts.quoted),
    });
  }
  return chamar(creds, "message/sendMedia", {
    number,
    mediatype: MEDIA_TYPE[tipo],
    ...(mimetype ? { mimetype } : {}),
    media: conteudo,
    ...(opts.caption ? { caption: opts.caption } : {}),
    ...(opts.fileName ? { fileName: opts.fileName } : {}),
    ...opcoes(opts.quoted),
  });
}

// Editar mensagem que NOS enviamos (endpoint proprio, diferente da Z-API que
// reusa o send-text com editMessageId).
export function evoEdit(
  creds: EvolutionCreds,
  destino: string,
  messageId: string,
  texto: string
) {
  return chamar(creds, "chat/updateMessage", {
    number: numeroEvolution(destino),
    key: { remoteJid: jidEvolution(destino), fromMe: true, id: messageId },
    text: texto,
  });
}

// Apagar pra todo mundo — DELETE com corpo (o metodo faz parte do contrato).
export function evoDelete(
  creds: EvolutionCreds,
  destino: string,
  messageId: string,
  owner = true
) {
  return chamar(
    creds,
    "chat/deleteMessageForEveryone",
    { id: messageId, remoteJid: jidEvolution(destino), fromMe: owner },
    "DELETE"
  );
}

// REAGIR a uma mensagem (03/09/2026) — POST message/sendReaction
// {key: {remoteJid, fromMe, id}, reaction}. `fromMe` e da mensagem ALVO (nossa =
// true, do cliente = false). `reaction: ""` remove. Corpo em lib/reacoes.ts.
export function evoReact(
  creds: EvolutionCreds,
  destino: string,
  messageId: string,
  fromMe: boolean,
  reaction: string
) {
  return chamar(
    creds,
    "message/sendReaction",
    corpoReacaoEvolution(jidEvolution(destino), messageId, fromMe, reaction)
  );
}
