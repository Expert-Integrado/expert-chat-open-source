// Parse PURO dos payloads que a Gupshup/Meta entrega — sem banco, sem env, sem
// import de rota: da pra provar em Node puro (`node scripts/prova-webhook-formatos.ts`).
//
// Duas portas de entrada usam este arquivo:
//  - lib/sync-apioficial.ts (builtin apioficial: a Gupshup entrega no webhook do
//    hub de agendamento, que guarda o payload cru em public.webhook_events);
//  - app/api/webhook/route.ts (canal de fonte gupshup apontado DIRETO pro painel).
//
// Dois formatos convivem: Meta cloud (entry[].changes[].value.messages[]) e
// Gupshup v1 ({type:'message', payload:{...}}).

export type MsgNova = {
  chat_id: string;
  nome: string | null;
  texto: string | null;
  tipo: string;
  wamid: string | null;
  ts: string;
};

// rotulos legiveis pro que a API oficial manda sem texto (era "[unsupported]" na tela)
const ROTULO: Record<string, string> = {
  unsupported: "[conteudo sem suporte na API oficial]",
  reaction: "[reacao]",
  location: "[localizacao]",
  contacts: "[contato]",
  sticker: "[figurinha]",
  order: "[pedido]",
  poll: "[enquete]",
};

export function parseEvento(payload: any): MsgNova[] {
  const out: MsgNova[] = [];
  // formato Meta cloud (entry[].changes[].value.messages[])
  for (const entry of payload?.entry ?? []) {
    for (const ch of entry?.changes ?? []) {
      const v = ch?.value;
      if (!v?.messages) continue;
      const nome = v.contacts?.[0]?.profile?.name ?? null;
      for (const m of v.messages) {
        // reacao (emoji numa mensagem) NAO vira mensagem: quem a aplica no alvo e
        // `reacoesDoEvento`, chamado pelas duas portas de entrada ANTES deste parse
        // (03/09/2026 — antes disto ela entrava como bolha "[reacao]" sem alvo)
        if (m?.type === "reaction") continue;
        const ehMidia = !!(m.image || m.audio || m.video || m.document || m.sticker);
        const textoReal =
          m.text?.body ??
          m.button?.text ??
          m.interactive?.button_reply?.title ??
          m.interactive?.list_reply?.title ??
          null;
        out.push({
          chat_id: String(m.from || v.contacts?.[0]?.wa_id || ""),
          nome,
          texto:
            textoReal ??
            (m.image ? "[foto]" : m.audio ? "[audio]" : m.video ? "[video]" : m.document ? "[documento]"
              : m.sticker ? "[figurinha]" : ROTULO[m.type] ?? null),
          // botao/resposta interativa com texto legivel e texto pro painel
          tipo: ehMidia ? m.type || "unknown" : textoReal ? "text" : m.type || "unknown",
          wamid: m.id || null,
          ts: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
        });
      }
    }
  }
  // formato Gupshup v1 ({type:'message', payload:{sender.phone, payload.text}})
  if (payload?.type === "message" && payload?.payload) {
    const p = payload.payload;
    const chat = String(p.sender?.phone || p.source || "");
    if (chat) {
      // ——— FRENTE S (31/08/2026), card 86ak86jvw — RESPOSTA DE PERGUNTA COM
      // OPCOES (botao / lista) chega como MENSAGEM NORMAL.
      //
      // O ramo Meta cloud logo acima ja resolvia isto (`interactive.button_reply
      // .title` / `list_reply.title`, chaves da doc da Meta). O ramo Gupshup v1
      // nao: a escolha caia como `[button_reply]` na bolha, ou seja o painel
      // dizia que algo chegou e escondia O QUE.
      //
      // HONESTIDADE SOBRE A FONTE: a forma exata do inbound interativo do v1
      // NAO deu pra confirmar na doc oficial em 31/08/2026 (as paginas de
      // inbound respondem 404). Entao a leitura e TOLERANTE e nao inventa: ela
      // tenta os campos candidatos e, se nenhum trouxer texto, MANTEM o rotulo
      // `[tipo]` que ja saia — nunca fabrica um titulo. Se um dia a doc voltar
      // (ou um payload real aparecer), a unica coisa a fazer aqui e conferir os
      // nomes; o comportamento sem eles ja e o certo.
      const escolha =
        typeof p.payload?.title === "string" && p.payload.title.trim()
          ? p.payload.title.trim()
          : typeof p.payload?.postbackText === "string" && p.payload.postbackText.trim()
          ? p.payload.postbackText.trim()
          : null;
      const texto =
        p.payload?.text ?? p.payload?.caption ?? escolha ?? (p.type && p.type !== "text" ? `[${p.type}]` : null);
      out.push({
        chat_id: chat,
        nome: p.sender?.name ?? null,
        texto,
        // resposta de opcao com texto legivel e TEXTO pro painel — o mesmo
        // criterio do ramo Meta cloud, que ja fazia isso.
        tipo: p.type === "text" || (escolha && texto === escolha) ? "text" : p.type || "unknown",
        wamid: p.id || payload.messageId || null,
        ts: new Date().toISOString(),
      });
    }
  }
  return out.filter((m) => /^\d{10,15}$/.test(m.chat_id));
}

// Recibo de entrega da Gupshup: {type:"message-event", payload:{type, id, gsId}}.
// `id` e `gsId` sao os DOIS identificadores possiveis da mesma mensagem (o envio
// devolve um, o recibo pode citar o outro) — quem grava tenta os dois.
// Status fora da regua (failed, enqueued, deleted) volta null: nao rebaixa nada.
export function statusGupshup(payload: any): { ids: string[]; status: string } | null {
  if (payload?.type !== "message-event") return null;
  const p = payload.payload ?? {};
  const status = { sent: "sent", delivered: "delivered", read: "read" }[String(p.type || "")];
  if (!status) return null;
  const ids = Array.from(
    new Set([p.gsId, p.id, payload.messageId].filter((x: any) => typeof x === "string" && x))
  ) as string[];
  if (!ids.length) return null;
  return { ids, status };
}

// REACAO RECEBIDA pela API oficial (formato Meta cloud): `{type: "reaction",
// reaction: {message_id, emoji}}`. Aplica no ALVO (coluna `reacao` da mensagem
// citada), nao vira mensagem nova — mesma mecanica do ramo Z-API e Evolution do
// webhook. Remocao chega SEM `emoji` e vira null. Puro: provado em
// scripts/prova-reacoes.ts. O formato Gupshup v1 nao tem forma confirmada na doc
// pra reacao recebida (03/09/2026) — ali o rotulo "[reacao]" segue como fallback
// honesto em vez de chutar campos.
export type ReacaoRecebida = { alvo: string; emoji: string | null };

export function reacoesDoEvento(payload: any): ReacaoRecebida[] {
  const out: ReacaoRecebida[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const ch of entry?.changes ?? []) {
      for (const m of ch?.value?.messages ?? []) {
        if (m?.type !== "reaction") continue;
        const alvo = m.reaction?.message_id;
        if (typeof alvo !== "string" || !alvo) continue;
        const emoji = typeof m.reaction?.emoji === "string" && m.reaction.emoji ? m.reaction.emoji : null;
        out.push({ alvo, emoji });
      }
    }
  }
  return out;
}
