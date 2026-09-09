// Traducao PURA entre o formato da Evolution API (v2.3) e o do painel, nas duas
// direcoes — sem banco, sem env, sem import de rota: da pra provar em Node puro
// (`node scripts/prova-webhook-formatos.ts`). Quem fala HTTP e lib/evolution.ts;
// quem grava e o /api/webhook.
//
// O payload da Evolution e ANINHADO ({event, instance, data}), ao contrario do
// plano da Z-API ({type, phone, text:{message}}). Logica portada do adapter do
// WhatsApp Agent (supabase/functions/_shared/wa/evolution.ts).

// ── SAIDA: endereco do destino ──────────────────────────────────────────────

// GOTCHA PAGO (portado do whatsapp-agent): grupo ANTIGO tem dois dialetos do
// mesmo id — "<criador>-<timestamp>" (jid legado, o formato que o painel guarda
// como chat_id "<digitos>-group") e os mesmos digitos concatenados
// (Evolution/Baileys). Mandar o dialeto COM hifen devolve 400 e a mensagem morre
// sem chegar em ninguem, com o historico local ja marcando "enviada". Por isso
// todo destino vira SO digitos. Grupo moderno ("120363...") e 1:1 passam iguais.
//
// FAIL-CLOSED em @lid: o identificador interno do WhatsApp (<numero>@lid) NAO e
// telefone. Deixar os digitos dele passarem fabricaria um numero que pode
// existir e ser de OUTRA pessoa — a mensagem sairia pro desconhecido errado. O
// /api/send ja barra pelo formato do destino, mas agendadas e a pesquisa de
// satisfacao chamam daqui sem essa validacao: a recusa mora na traducao, que e
// por onde todo mundo passa. Quem chama trata o erro (fila marca "erro",
// automacao e melhor-esforco) — nenhum request cai por causa disso.
export function numeroEvolution(destino: string): string {
  const bruto = String(destino ?? "");
  if (bruto.endsWith("@lid")) {
    throw new Error(
      "destino @lid nao e telefone: a conversa precisa do numero real antes de receber mensagem"
    );
  }
  const digitos = bruto.split("@")[0].replace(/\D/g, "");
  if (!digitos) throw new Error("destino sem digitos");
  return digitos;
}

/** JID completo, pras acoes que exigem a chave da mensagem (editar/apagar). */
export function jidEvolution(destino: string): string {
  const d = String(destino ?? "");
  if (d.endsWith("@g.us") || d.endsWith("@s.whatsapp.net")) return d;
  const digitos = numeroEvolution(d);
  return d.endsWith("-group") ? `${digitos}@g.us` : `${digitos}@s.whatsapp.net`;
}

// O painel manda a midia como data URI ("data:image/png;base64,AAA..."). A
// Evolution espera base64 PURO no campo `media` (ou uma URL publica) e o mime
// separado em `mimetype` — mandar o data URI inteiro faz o arquivo chegar
// corrompido. Separa aqui, uma vez, pros dois caminhos.
export function separarDataUri(dado: string): { conteudo: string; mime: string | null } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dado ?? "");
  if (!m) return { conteudo: dado, mime: null };
  return { conteudo: m[2], mime: m[1] };
}

// id da mensagem no provedor: a Evolution devolve key.id; versoes/rotas
// diferentes ja devolveram messageId ou id soltos — aceitar os tres.
export function parseSendResult(json: any): { messageId: string | null } {
  return { messageId: json?.key?.id ?? json?.messageId ?? json?.id ?? null };
}

// ── ENTRADA: normalizacao do webhook ────────────────────────────────────────

export type EvoMensagem = {
  kind: "mensagem";
  chatId: string;
  isGroup: boolean;
  fromMe: boolean;
  // nome que pode BATIZAR a conversa (so 1:1 recebida — ver comentario abaixo)
  chatName: string | null;
  senderName: string | null;
  senderPhone: string | null;
  providerMsgId: string | null;
  tipo: string;
  conteudo: string | null;
  caption: string | null;
  quotedMsgId: string | null;
  mediaMime: string | null;
  ts: string;
};
export type EvoStatus = { kind: "status"; ids: string[]; status: string };
export type EvoReacao = { kind: "reacao"; alvo: string; emoji: string | null };
export type EvoIgnorado = { kind: "ignorado"; motivo: string };
export type EvoEvento = EvoMensagem | EvoStatus | EvoReacao | EvoIgnorado;

/** So os digitos antes do "@" de um JID; aceita JID ou numero puro. */
export function digitosDoJid(jid: unknown): string {
  return String(jid ?? "").split("@")[0].replace(/\D/g, "");
}
export function ehGrupoJid(jid: unknown): boolean {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

// ack -> status do painel. A Evolution manda o ack cru do Baileys.
const ACK: Record<string, string> = {
  READ: "read",
  PLAYED: "read",
  DELIVERY_ACK: "delivered",
  SERVER_ACK: "sent",
  PENDING: "sent",
};

// rotulo legivel do que nao tem texto (a v1 nao baixa o arquivo — ver LIMITE)
const ROTULO: Record<string, string> = {
  image: "[foto]",
  audio: "[audio]",
  ptt: "[audio]",
  video: "[video]",
  document: "[documento]",
  sticker: "[figurinha]",
  location: "[localizacao]",
  contact: "[contato]",
  poll: "[enquete]",
  unknown: "[mensagem]",
};
export function rotuloEvolution(tipo: string): string {
  return ROTULO[tipo] ?? `[${tipo}]`;
}

// messageType (campo solto do payload) -> tipo do painel. Serve de PLANO B
// quando o objeto message vem num formato que ainda nao conhecemos.
const POR_MESSAGE_TYPE: Record<string, string> = {
  conversation: "text",
  extendedTextMessage: "text",
  imageMessage: "image",
  audioMessage: "audio",
  videoMessage: "video",
  documentMessage: "document",
  documentWithCaptionMessage: "document",
  stickerMessage: "sticker",
  locationMessage: "location",
  contactMessage: "contact",
  contactsArrayMessage: "contact",
  pollCreationMessage: "poll",
};

export function normalizarEvolution(payload: any): EvoEvento {
  const evento: string = payload?.event ?? "";
  const d = payload?.data ?? {};

  // ── ack de entrega/leitura ──
  if (evento === "messages.update") {
    const status = ACK[String(d.status ?? d.update?.status ?? "")];
    const ids = Array.from(
      new Set([d.key?.id, d.keyId].filter((x: any) => typeof x === "string" && x))
    ) as string[];
    if (!status || !ids.length) return { kind: "ignorado", motivo: "update sem status conhecido" };
    return { kind: "status", ids, status };
  }

  if (evento !== "messages.upsert") return { kind: "ignorado", motivo: `evento ${evento || "?"}` };

  const k = d.key ?? {};
  // VANTAGEM DA EVOLUTION sobre a Z-API: quando o WhatsApp entrega a pessoa pelo
  // identificador interno (@lid), o remoteJidAlt ja traz o TELEFONE real — nao
  // precisa da resolucao em 3 camadas que o canal Z-API faz (cache/nome/API).
  const jid: string =
    k.addressingMode === "lid" && k.remoteJidAlt ? k.remoteJidAlt : k.remoteJid ?? "";
  const isGroup = ehGrupoJid(jid);
  const digitos = digitosDoJid(jid);
  if (!digitos) return { kind: "ignorado", motivo: "sem remoteJid" };
  // lid SEM remoteJidAlt nao e telefone: guardar como @lid preserva a verdade
  // (e a conversa nao vira um numero falso). Envio pra @lid ja e barrado no
  // /api/send pelo formato do destino.
  const ehLid = !isGroup && String(jid).endsWith("@lid");
  const chatId = isGroup ? `${digitos}-group` : ehLid ? `${digitos}@lid` : digitos;

  const fromMe = k.fromMe === true;
  // ephemeralMessage = mensagem temporaria: o conteudo real vem embrulhado
  const m: any = d.message?.ephemeralMessage?.message ?? d.message ?? {};

  // reacao (emoji numa mensagem) aplica no ALVO, nao vira mensagem nova
  if (m.reactionMessage) {
    const alvo = m.reactionMessage.key?.id;
    if (!alvo) return { kind: "ignorado", motivo: "reacao sem alvo" };
    return { kind: "reacao", alvo: String(alvo), emoji: m.reactionMessage.text ?? null };
  }
  // protocolMessage = apagar/efemero/sincronizacao — sem conteudo pro painel
  if (m.protocolMessage) return { kind: "ignorado", motivo: "protocolMessage" };

  let tipo = "unknown";
  let conteudo: string | null = null;
  let caption: string | null = null;
  let quotedMsgId: string | null = null;
  let mediaMime: string | null = null;

  if (m.conversation !== undefined || m.extendedTextMessage !== undefined) {
    tipo = "text";
    conteudo = m.conversation ?? m.extendedTextMessage?.text ?? null;
    quotedMsgId = m.extendedTextMessage?.contextInfo?.stanzaId ?? null;
  } else if (m.imageMessage) {
    tipo = "image";
    caption = m.imageMessage.caption ?? null;
    mediaMime = m.imageMessage.mimetype ?? null;
    quotedMsgId = m.imageMessage.contextInfo?.stanzaId ?? null;
  } else if (m.audioMessage) {
    tipo = m.audioMessage.ptt ? "ptt" : "audio";
    mediaMime = m.audioMessage.mimetype ?? null;
    quotedMsgId = m.audioMessage.contextInfo?.stanzaId ?? null;
  } else if (m.videoMessage) {
    tipo = "video";
    caption = m.videoMessage.caption ?? null;
    mediaMime = m.videoMessage.mimetype ?? null;
    quotedMsgId = m.videoMessage.contextInfo?.stanzaId ?? null;
  } else if (m.documentMessage || m.documentWithCaptionMessage) {
    const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage ?? {};
    tipo = "document";
    caption = doc.caption ?? null;
    conteudo = doc.fileName ?? null;
    mediaMime = doc.mimetype ?? null;
    quotedMsgId = doc.contextInfo?.stanzaId ?? null;
  } else if (m.stickerMessage) {
    tipo = "sticker";
    mediaMime = m.stickerMessage.mimetype ?? null;
  } else if (m.locationMessage) {
    tipo = "location";
  } else if (m.contactMessage || m.contactsArrayMessage) {
    tipo = "contact";
    conteudo = m.contactMessage?.displayName ?? null;
  } else {
    tipo = POR_MESSAGE_TYPE[String(d.messageType ?? "")] ?? "unknown";
  }

  const parteBruta =
    k.addressingMode === "lid" && k.participantAlt ? k.participantAlt : k.participant;
  const senderPhone = isGroup ? digitosDoJid(parteBruta) || null : ehLid ? null : chatId;

  return {
    kind: "mensagem",
    chatId,
    isGroup,
    fromMe,
    // pushName e o AUTOR, nunca o chat: em fromMe e o dono da instancia, em
    // grupo e quem falou. Usa-lo como nome do chat batizava a conversa do
    // cliente com o NOSSO nome (mesmo incidente do canal Z-API, 28/08/2026).
    chatName: fromMe || isGroup ? null : d.pushName ?? null,
    senderName: d.pushName ?? null,
    senderPhone,
    providerMsgId: k.id ?? null,
    tipo,
    conteudo,
    caption,
    quotedMsgId,
    mediaMime,
    ts: d.messageTimestamp
      ? new Date(Number(d.messageTimestamp) * 1000).toISOString()
      : new Date().toISOString(),
  };
}
