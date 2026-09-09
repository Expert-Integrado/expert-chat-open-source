import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { credsZapi, zapiSendText, type ZapiCreds } from "@/lib/zapi";
import { canalPorId, type CanalDef } from "@/lib/canais";
import { getConfig, dentroDoHorario, ConfigAutomacao } from "@/lib/config";
import { parseEvento, reacoesDoEvento, statusGupshup } from "@/lib/gupshup-inbound";
import { gravarMsgGupshup } from "@/lib/sync-apioficial";
import { normalizarEvolution, rotuloEvolution } from "@/lib/evolution-formato";
import { credsEvolution, evoSendText } from "@/lib/evolution";
import { credsGupshup, gsSendText } from "@/lib/gupshup";
import { ehNotaCsat, notaDaMensagem, registrarAvaliacao } from "@/lib/csat";
import { avisarAvaliacao, avisarMensagemRecebida, avisarStatus } from "@/lib/webhooks-saida";
import { aplicarReinicio } from "@/lib/conversa-reinicio";
import { distribuirSeOrfa } from "@/lib/rodizio";
import { respostaZapi } from "@/lib/interativas";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Webhook UNICO dos canais de WhatsApp do painel. URL com ?key= e a
// autenticacao; ?canal=<id> escolhe o canal (default "central"). Cada canal
// grava no PROPRIO par de tabelas, e a FONTE do canal decide o parse:
//
//  - fonte zapi     : formato plano da Z-API — ReceivedCallback (mensagem
//                     recebida E eco de envio, fromMe=true),
//                     MessageStatusCallback (status), DeliveryCallback ignorado.
//  - fonte gupshup  : formato Meta cloud/Gupshup v1 — entrada por parseEvento,
//                     recibo por message-event.
//                     INSTALACAO: apontar o app Gupshup (Callback URL do app na
//                     console, ou POST /app/{appId}/callback) pra
//                     <painel>/api/webhook?key=<WEBHOOK_KEY>&canal=<id>.
//  - fonte evolution: formato aninhado {event, instance, data} — messages.upsert
//                     vira mensagem, messages.update vira ack.
//                     INSTALACAO: POST {base}/webhook/set/{instance} com a mesma
//                     URL (?key=...&canal=<id>) e os eventos MESSAGES_UPSERT +
//                     MESSAGES_UPDATE.
//
// O payload cru sempre vai pra webhook_raw com parse_ok/erro, em qualquer fonte.
export async function POST(req: NextRequest) {
  const keyRecebida = req.nextUrl.searchParams.get("key") || req.headers.get("x-webhook-key") || "";
  if (!seguraIgual(keyRecebida, process.env.WEBHOOK_KEY || "")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const bruto = await req.text();
  if (bruto.length > 2_000_000) {
    return NextResponse.json({ error: "payload muito grande" }, { status: 413 });
  }
  let payload: any = null;
  try {
    payload = JSON.parse(bruto);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Canal de destino: so canal REGISTRADO e ativo recebe.
  const canal = canalPorId(req.nextUrl.searchParams.get("canal") || "central");
  if (!canal || !canal.ativo) {
    return NextResponse.json({ error: "canal desconhecido" }, { status: 404 });
  }

  // Fonte GUPSHUP (API oficial Meta) entra ANTES do bloco de credencial/instanceId
  // da Z-API — instancia/Client-Token nao existem nesse provedor. A 2a barreira
  // aqui e o proprio canal: o app Gupshup so entrega no ?canal= que a instalacao
  // apontou, e o parse ignora payload que nao seja mensagem/recibo conhecido.
  if (canal.fonte === "gupshup") {
    return gravarEResponder(payload, () => ingestGupshup(payload, canal));
  }

  // Fonte EVOLUTION: mesma ideia de 2a barreira da Z-API, com o NOME da
  // instancia (EVOLUTION_<ID>_INSTANCE_ID) no lugar do instanceId. Canal sem
  // credencial = 403 fail-closed (ninguem grava conversa num canal que ainda
  // nao foi cabeado), e um EVOLUTION_<ID>_WEBHOOK_TOKEN configurado vira 3a
  // barreira no header.
  if (canal.fonte === "evolution") {
    const cre = credsEvolution(canal.id);
    if (!cre) {
      return NextResponse.json({ error: "canal sem instancia configurada" }, { status: 403 });
    }
    // A comparacao e OBRIGATORIA, nao "se vier": payload forjado que simplesmente
    // OMITE o campo `instance` nao pode pular a barreira — sem instancia
    // declarada, o evento nao entra.
    if (String(payload?.instance || "") !== cre.instance) {
      return NextResponse.json({ error: "instancia desconhecida" }, { status: 403 });
    }
    // O token vale contra o header `authorization` CRU, do jeito que o
    // webhook/set da Evolution manda: se o servidor foi configurado com
    // "Bearer xyz", a env EVOLUTION_<ID>_WEBHOOK_TOKEN tem que conter
    // "Bearer xyz" inteiro. Comparacao em tempo constante, como a ?key=.
    if (cre.webhookToken && !seguraIgual(req.headers.get("authorization") || "", cre.webhookToken)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return gravarEResponder(payload, () => ingestEvolution(payload, canal));
  }

  if (canal.fonte !== "zapi") {
    return NextResponse.json({ error: "canal desconhecido" }, { status: 404 });
  }

  // 2a barreira: o evento tem que ser da instancia Z-API DESTE canal. Mesmo com a
  // chave vazada, payload forjado de outra instancia nao entra no painel. Canal
  // extra SEM instancia configurada (ZAPI_<ID>_INSTANCE_ID) nao recebe nada —
  // fail-closed: ninguem grava conversa num canal que ainda nao foi cabeado.
  const creds = credsZapi(canal.id);
  const nossa = creds?.instance;
  if (canal.id !== "central" && !nossa) {
    return NextResponse.json({ error: "canal sem instancia configurada" }, { status: 403 });
  }
  if (nossa && payload?.instanceId && String(payload.instanceId) !== nossa) {
    return NextResponse.json({ error: "instancia desconhecida" }, { status: 403 });
  }

  return gravarEResponder(payload, () => ingest(payload, canal, creds));
}

// Roda o parse, guarda o payload CRU em webhook_raw com parse_ok/erro e responde
// 200 mesmo com falha de parse (apos a auth) — provedor que recebe 5xx reenvia
// em loop, e o cru ja esta salvo pra reprocessar depois.
async function gravarEResponder(payload: any, fn: () => Promise<void>) {
  let parseOk = false;
  let erro: string | null = null;
  try {
    await fn();
    parseOk = true;
  } catch (e: any) {
    erro = String(e?.message || e).slice(0, 500);
  }

  await msgDb().from("webhook_raw").insert({ payload, parse_ok: parseOk, erro });
  return NextResponse.json({ ok: true, parsed: parseOk });
}

// comparacao em tempo constante (nao vaza a chave por tempo de resposta)
function seguraIgual(a: string, b: string) {
  if (!b || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  played: 4,
};

// ── fonte GUPSHUP (WhatsApp API oficial, Meta) ──────────────────────────────
// Canal de fonte gupshup apontado DIRETO pro painel. O builtin "apioficial"
// continua entrando pelo sync de public.webhook_events (lib/sync-apioficial.ts);
// os dois caminhos gravam pela MESMA funcao: gravarMsgGupshup.
//
// LIMITE v1 (declarado): canal gupshup NAO roda saudacao, ausencia nem rodizio.
// Elas dependem de envio livre, e a API oficial so aceita mensagem de sessao
// dentro da janela de 24h — automacao que dispara fora dela falharia calada.
// Entra quando houver template aprovado. A NOTA da pesquisa de satisfacao e a
// excecao e JA funciona: ela so existe logo depois de uma mensagem do cliente,
// entao a janela esta aberta por definicao (ver lib/csat.ts).
async function ingestGupshup(p: any, canal: CanalDef) {
  const db = msgDb();
  const T = canal.tabelas;

  // recibo de entrega: promove o status da mensagem que NOS enviamos
  const recibo = statusGupshup(p);
  if (recibo) {
    const { data: rows } = await db
      .from(T.mensagens)
      .select("id,status")
      .in("provider_msg_id", recibo.ids.slice(0, 50));
    for (const row of rows ?? []) {
      // monotonico: o recibo chega fora de ordem — so promove, nunca rebaixa
      if ((STATUS_RANK[recibo.status] ?? 0) > (STATUS_RANK[row.status ?? "pending"] ?? 0)) {
        await db.from(T.mensagens).update({ status: recibo.status }).eq("id", row.id);
      }
    }
    return;
  }

  // reacao recebida (03/09/2026): aplica no ALVO e nao vira mensagem — igual ao
  // ramo Z-API/Evolution. Vem ANTES do parse porque o evento pode ser SO reacao.
  for (const r of reacoesDoEvento(p)) {
    await db.from(T.mensagens).update({ reacao: r.emoji }).eq("provider_msg_id", r.alvo);
  }
  const msgs = parseEvento(p);
  if (!msgs.length) return; // evento sem mensagem (status de app, template, etc.)
  const cfg = await getConfig();
  for (const m of msgs) {
    await gravarMsgGupshup(db, cfg, T, m, {
      canal: canal.id,
      // agradecimento da pesquisa de satisfacao: a janela de 24h esta aberta
      // por definicao (o cliente acabou de mandar a nota)
      responder: async (texto) => {
        const creds = await credsGupshup(canal.id);
        if (creds) await gsSendText(creds, m.chat_id, texto);
      },
    });
  }
}

// ── fonte EVOLUTION (Evolution API v2.3, self-hosted) ───────────────────────
// Payload ANINHADO ({event, instance, data}); a normalizacao pura vive em
// lib/evolution-formato.ts (provada por scripts/prova-webhook-formatos.ts) e
// aqui fica so a gravacao, com a MESMA mecanica do ramo zapi.
//
// LIMITES v1 (declarados):
//  - sem saudacao, ausencia nem rodizio (a NOTA da pesquisa de satisfacao roda:
//    e o par do envio feito em /api/conversa — ver lib/csat.ts);
//  - midia entra com rotulo ([foto]/[audio]/...) e media_url NULL: a Evolution
//    nao manda URL, o arquivo sai por POST chat/getBase64FromMediaMessage —
//    download + bucket ficam pra v2 (mesmo caminho de lib/midia-store.ts);
//  - conversa que chega so como @lid fica gravada como "<digitos>@lid" (a
//    Evolution normalmente ja resolve pelo remoteJidAlt; nao ha resolveLid aqui).
async function ingestEvolution(p: any, canal: CanalDef) {
  const db = msgDb();
  const T = canal.tabelas;
  const ev = normalizarEvolution(p);

  if (ev.kind === "ignorado") return;

  if (ev.kind === "status") {
    for (const id of ev.ids.slice(0, 50)) {
      const { data: row } = await db
        .from(T.mensagens)
        .select("id,status")
        .eq("provider_msg_id", id)
        .maybeSingle();
      // monotonico: o ack chega fora de ordem — so promove, nunca rebaixa
      if (row && (STATUS_RANK[ev.status] ?? 0) > (STATUS_RANK[row.status ?? "pending"] ?? 0)) {
        await db.from(T.mensagens).update({ status: ev.status }).eq("id", row.id);
      }
    }
    return;
  }

  if (ev.kind === "reacao") {
    await db.from(T.mensagens).update({ reacao: ev.emoji }).eq("provider_msg_id", ev.alvo);
    return;
  }

  const nameIsJunk = !ev.chatName || /^[0-9]+$/.test(ev.chatName);
  const preview = ev.conteudo || ev.caption || rotuloEvolution(ev.tipo);
  const previewLinha = `${ev.fromMe ? "Voce: " : ""}${preview}`.slice(0, 140);

  // `status` entra na leitura que ja acontecia: e o "de" do webhook de saida
  // `last_message_at` entra na leitura que ja acontecia: e o carimbo de que a
  // conversa REINICIOU (Frente N) — e ele so existe ANTES do upsert abaixo.
  const { data: convAntes } = await db
    .from(T.conversas)
    .select("chat_id,status,auto_arquivar,mensagens_nao_lidas,aguardando_avaliacao,responsavel_id,responsavel_nome,last_message_at")
    .eq("chat_id", ev.chatId)
    .maybeSingle();

  // NOTA da pesquisa de satisfacao: decidida ANTES das escritas, porque muda o
  // que acontece com a conversa (nao reabre, nao conta nao lida).
  const ehNotaAvaliacao = ehNotaCsat({
    fromMe: ev.fromMe,
    isGroup: ev.isGroup,
    tipo: ev.tipo,
    conteudo: ev.conteudo,
    conversa: convAntes,
  });

  const { error: convErr } = await db.from(T.conversas).upsert(
    {
      chat_id: ev.chatId,
      ...(nameIsJunk ? {} : { nome: ev.chatName }),
      is_group: ev.isGroup,
      canal: `evolution-${canal.id}`,
      last_message_at: ev.ts,
      last_message_preview: previewLinha,
      updated_at: ev.ts,
    },
    { onConflict: "chat_id" }
  );
  if (convErr) throw new Error(`conversa: ${convErr.message}`);

  if (!ev.fromMe && !ehNotaAvaliacao) {
    const cfg = await getConfig();
    // F9: chat com auto_arquivar ligado nunca reabre sozinho
    if (convAntes?.auto_arquivar) {
      await db.from(T.conversas).update({ arquivada: true }).eq("chat_id", ev.chatId);
    } else if (cfg.auto_desarquivar_recebida) {
      await db
        .from(T.conversas)
        .update({ status: "aberto", arquivada: false })
        .eq("chat_id", ev.chatId)
        .or("status.eq.concluido,arquivada.eq.true");
    }
    // inc_nao_lidas (SQL) e fixa na tabela do central; canal Evolution e sempre
    // canal extra, entao o contador sobe direto na tabela dele.
    await db
      .from(T.conversas)
      .update({ mensagens_nao_lidas: (convAntes?.mensagens_nao_lidas ?? 0) + 1 })
      .eq("chat_id", ev.chatId);
    // conversa REINICIADA (Frente N): DEPOIS do bloco de reabrir/desarquivar, e
    // sempre melhor-esforco — status torto nunca impede a mensagem de entrar.
    // O RELOGIO e o carimbo DA MENSAGEM, nunca `Date.now()`: backlog processado
    // tarde mediria uma janela que nunca existiu pro cliente.
    await aplicarReinicio(
      db,
      T,
      cfg,
      { canal: canal.id, chatId: ev.chatId, antes: convAntes, deGrupo: ev.isGroup },
      Date.parse(ev.ts) || Date.now()
    ).catch((e) => console.error("reinicio falhou", { canal: canal.id, chat: ev.chatId, erro: e?.message }));
  }

  const { error: msgErr } = await db.from(T.mensagens).insert({
    chat_id: ev.chatId,
    direcao: ev.fromMe ? "out" : "in",
    tipo: ev.tipo,
    conteudo: ev.conteudo || ev.caption || rotuloEvolution(ev.tipo),
    media_url: null, // v1: sem download de midia (ver LIMITES acima)
    media_mime: ev.mediaMime,
    sender_name: ev.fromMe ? null : ev.senderName,
    sender_phone: ev.fromMe ? null : ev.senderPhone,
    provider_msg_id: ev.providerMsgId,
    quoted_msg_id: ev.quotedMsgId,
    status: ev.fromMe ? "sent" : "received",
    criada_em: ev.ts,
    raw: p,
  });
  // 23505 = eco do proprio envio, que o /api/send ja gravou. Nada a completar
  // aqui (a Evolution nao traz URL de midia) — so nao pode virar erro.
  if (msgErr && !String(msgErr.code).includes("23505")) {
    throw new Error(`mensagem: ${msgErr.message}`);
  }

  // webhook de saida: mesma regra dos outros dois caminhos de ingestao — so
  // mensagem do cliente, so quando entrou de verdade, sempre melhor-esforco.
  if (!ev.fromMe && !msgErr) {
    avisarMensagemRecebida({
      canal: canal.id,
      chatId: ev.chatId,
      tipo: ev.tipo,
      deGrupo: ev.isGroup,
      temMidia: !!ev.mediaMime, // a Evolution nao manda URL; o mime diz que ha arquivo
      providerMsgId: ev.providerMsgId,
      conteudo: ev.conteudo ?? ev.caption,
    });
  }

  // a nota fica gravada DEPOIS da mensagem dela (a conversa mostra o "5" do
  // cliente e o agradecimento em seguida, na ordem em que aconteceram)
  if (ehNotaAvaliacao) {
    const cfg = await getConfig();
    const creds = credsEvolution(canal.id);
    const nota = notaDaMensagem(ev.conteudo)!;
    const gravou = await registrarAvaliacao(db, cfg, T, {
      canal: canal.id,
      chatId: ev.chatId,
      nota,
      conversa: convAntes,
      agradecer: creds ? (texto) => evoSendText(creds, ev.chatId, texto, null) : undefined,
    });
    // so anuncia o que existe no banco (o supabase-js nao lanca: devolve error)
    if (gravou) {
      avisarAvaliacao({
        canal: canal.id,
        chatId: ev.chatId,
        nota,
        atendenteId: convAntes?.responsavel_id,
        atendenteNome: convAntes?.responsavel_nome,
      });
    }
    // a conversa normalmente JA estava concluida aqui: `avisarStatus` engole
    // status reafirmado sozinho
    avisarStatus({
      canal: canal.id,
      chatId: ev.chatId,
      de: convAntes?.status ?? null,
      para: "concluido",
      porNome: "automacao: pesquisa de satisfacao",
      origem: "automacao",
    });
  }
}

// @lid e o "espelho tecnico" do contato: a mesma pessoa chega ora como telefone,
// ora como <numero>@lid, e vira duas conversas. Resolucao em 3 camadas, portada
// do whatsapp-agent (_shared/wa/zapi.ts): cache -> nome do contato -> Z-API.
async function resolveLid(
  db: any,
  T: CanalDef["tabelas"],
  creds: ZapiCreds | null,
  lid: string,
  chatName: string | null
): Promise<string | null> {
  // 1. cache
  const { data: cache } = await db
    .from("lid_mapping")
    .select("phone")
    .eq("lid", lid)
    .maybeSingle();
  if (cache?.phone) return cache.phone;

  // 2. mesmo nome de contato numa conversa que ja tem telefone
  if (chatName && !/@lid$/.test(chatName) && !/^\d+$/.test(chatName)) {
    const { data: iguais } = await db
      .from(T.conversas)
      .select("chat_id")
      .eq("nome", chatName)
      .eq("is_group", false)
      .not("chat_id", "like", "%@lid")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1);
    const cid = iguais?.[0]?.chat_id;
    if (cid && /^\d+$/.test(cid)) {
      await db.from("lid_mapping").upsert({ lid, phone: cid, chat_name: chatName, resolved_via: "nome" });
      return cid;
    }
  }

  // 3. listagem de conversas da Z-API: e a unica fonte que traz phone e lid
  // JUNTOS. Quem acabou de mandar mensagem esta no topo da lista recente, entao
  // a 1a pagina resolve o caso normal com 1 chamada.
  if (!creds) return null;
  const base = `https://api.z-api.io/instances/${creds.instance}/token/${creds.token}`;
  const headers: Record<string, string> = creds.clientToken
    ? { "Client-Token": creds.clientToken }
    : {};
  try {
    const r = await fetch(`${base}/chats?page=1&pageSize=200`, { headers, cache: "no-store" });
    if (r.ok) {
      const lista: any[] = await r.json().catch(() => []);
      const achado = Array.isArray(lista)
        ? lista.find((c) => c?.lid === lid && c?.phone && /^\d+$/.test(String(c.phone)))
        : null;
      if (achado) {
        const nome = achado.name && !/^\d+$/.test(achado.name) ? achado.name : chatName;
        await db.from("lid_mapping").upsert({ lid, phone: String(achado.phone), chat_name: nome, resolved_via: "listagem" });
        return String(achado.phone);
      }
    }
  } catch {
    // segue pro proximo
  }

  // 4. endpoint de contato (funciona quando o contato esta na agenda)
  try {
    const r = await fetch(`${base}/contacts/${encodeURIComponent(lid)}`, { headers, cache: "no-store" });
    if (r.ok) {
      const j: any = await r.json().catch(() => ({}));
      const tel = j?.phone ?? j?.contact?.phone ?? null;
      if (tel && /^\d+$/.test(String(tel))) {
        await db.from("lid_mapping").upsert({ lid, phone: String(tel), chat_name: chatName, resolved_via: "zapi" });
        return String(tel);
      }
    }
  } catch {
    // sem telefone: segue como @lid ate aparecer o vinculo
  }
  return null;
}

async function ingest(p: any, canal: CanalDef, creds: ZapiCreds | null) {
  const db = msgDb();
  const T = canal.tabelas;
  const ehCentral = canal.id === "central";

  if (p?.type === "MessageStatusCallback") {
    const status = { SENT: "sent", RECEIVED: "delivered", READ: "read", PLAYED: "played" }[
      String(p.status || "")
    ];
    // teto no lote: evita 1 payload virar centenas de idas ao banco
    const ids: string[] = (p.ids || (p.id ? [p.id] : [])).slice(0, 50);
    if (!status || !ids.length) return;
    for (const id of ids) {
      const { data: row } = await db
        .from(T.mensagens)
        .select("id,status")
        .eq("provider_msg_id", id)
        .maybeSingle();
      // monotonico: Z-API entrega status fora de ordem — so promove, nunca rebaixa
      if (row && (STATUS_RANK[status] ?? 0) > (STATUS_RANK[row.status ?? "pending"] ?? 0)) {
        await db.from(T.mensagens).update({ status }).eq("id", row.id);
      }
    }
    return;
  }

  if (p?.type !== "ReceivedCallback") return; // DeliveryCallback e demais eventos: ignorar
  if (p.waitingMessage === true) return; // WhatsApp ainda nao decriptou
  if (p.notification) return; // entrada/saida de grupo — sem conteudo de mensagem

  // reacao (emoji numa mensagem): aplica na mensagem alvo, nao vira mensagem nova
  if (p.reaction) {
    const alvo = p.reaction.referencedMessage?.messageId || p.referenceMessageId;
    const emoji = p.reaction.value ?? null;
    if (alvo) {
      await db.from(T.mensagens).update({ reacao: emoji }).eq("provider_msg_id", alvo);
    }
    return;
  }

  // edicao de mensagem (terceiro ou nos editamos por outro app): atualiza o alvo
  if (p.isEdit) {
    const novo = p?.text?.message ?? null;
    if (p.messageId && novo) {
      await db
        .from(T.mensagens)
        .update({ conteudo: novo, editada_em: new Date().toISOString() })
        .eq("provider_msg_id", p.messageId);
    }
    return;
  }

  let chatId = String(p.phone ?? "");
  if (!chatId) throw new Error("ReceivedCallback sem phone");
  const isGroup = Boolean(p.isGroup);
  const fromMe = Boolean(p.fromMe);
  const ts = p.momment ? new Date(Number(p.momment)).toISOString() : new Date().toISOString();

  // FRENTE S (31/08/2026), card 86ak86jvw — A RESPOSTA DE UMA PERGUNTA COM
  // OPCOES CHEGA COMO MENSAGEM NORMAL.
  //
  // Criterio do card, e a leitura certa pra quem atende: "ele escolheu
  // Segunda-feira" e uma frase, tenha vindo de um toque ou da digitacao. Sem
  // isto, a escolha do cliente caia na bolha como "[mensagem]" (tipo `unknown`,
  // conteudo nulo) — o painel registrava que algo chegou e escondia O QUE.
  //
  // As chaves vem da doc oficial da Z-API (pagina "Exemplos de retorno",
  // conferida em 31/08/2026): `listResponseMessage` e `buttonsResponseMessage`
  // no nivel raiz do payload. O parse mora em lib/interativas.ts (puro,
  // provavel em node solto) — aqui e so a costura.
  //
  // `buttonsResponseMessage` e lido mesmo com o painel nao ENVIANDO botao por
  // este canal (a doc da Z-API declara os botoes instaveis): o numero recebe
  // botao de bot de terceiro no mesmo WhatsApp (ver CLAUDE.md, SuperSDR/ChatGuru
  // ativos no numero), e essa escolha tambem precisa aparecer legivel.
  const escolha = respostaZapi(p);

  // tipo + conteudo por tipo de mensagem (espelha zapiExtractMediaInfo do whatsapp-agent)
  const isPtt = p.audio?.ptt === true;
  const tipo = p.text
    ? "text"
    : escolha ? "text"
    : p.image ? "image"
    : p.audio ? (isPtt ? "ptt" : "audio")
    : p.video ? "video"
    : p.document ? "document"
    : p.sticker ? "sticker"
    : p.location ? "location"
    : p.contact ? "contact"
    : p.poll ? "poll"
    : "unknown";
  const caption = p.image?.caption || p.video?.caption || p.document?.caption || null;
  const content: string | null =
    p?.text?.message ??
    // FRENTE S: o TITULO da opcao escolhida e o conteudo da mensagem. Vem depois
    // do texto de proposito — payload com os dois e texto digitado.
    escolha?.texto ??
    (p.location ? JSON.stringify(p.location) : null) ??
    (p.contact ? p.contact.displayName ?? p.contact.vcard ?? null : null) ??
    (p.poll ? p.poll.name ?? null : null) ??
    (p.document ? p.document.fileName ?? null : null) ??
    null;
  const PREVIEW_TIPO: Record<string, string> = {
    image: "[foto]", audio: "[audio]", ptt: "[audio]", video: "[video]",
    document: "[documento]", sticker: "[figurinha]", location: "[localizacao]",
    contact: "[contato]", poll: "[enquete]", unknown: "[mensagem]",
  };
  const preview = content || caption || PREVIEW_TIPO[tipo] || `[${tipo}]`;
  const previewLinha = `${fromMe ? "Voce: " : ""}${preview}`.slice(0, 140);

  // nome lixo (@lid / so digitos) nunca sobrescreve nome bom.
  // Em eco fromMe, senderName e o pushname da NOSSA conta (ex: "Expert
  // Integrado"), nunca o do destinatario — usa-lo batizava a conversa do
  // cliente com o nosso nome E envenenava o resolveLid por nome (incidente
  // 28/08/2026: agendamento do Meeting Hub gravado na conversa errada).
  const chatName = p.chatName || (isGroup || fromMe ? null : p.senderName) || null;
  const nameIsJunk = !chatName || /@lid$/.test(chatName) || /^[0-9]+$/.test(chatName);

  // conversa que chega como @lid: tenta virar o telefone real e, se ja existir
  // uma conversa @lid solta pra essa pessoa, junta as duas.
  if (!isGroup && /@lid$/.test(chatId)) {
    const telefone = await resolveLid(db, T, creds, chatId, nameIsJunk ? null : chatName);
    if (telefone) {
      // merge_lid_chat (SQL) opera nas tabelas do central; em canal extra a
      // conversa @lid antiga fica como esta e as proximas mensagens ja entram
      // no telefone real (v1 — funcao por tabela fica pra quando doer).
      if (ehCentral) await db.rpc("merge_lid_chat", { p_lid: chatId, p_phone: telefone });
      chatId = telefone;
    }
  }

  // estado ANTES do upsert: diz se a conversa e nova (saudacao) e se estava
  // esperando a nota da pesquisa de satisfacao
  // `status` entra na leitura que ja acontecia: e o "de" do webhook de saida
  const { data: convAntes } = await db
    .from(T.conversas)
    // `last_message_at`: carimbo de que a conversa REINICIOU (Frente N) — depois
    // do upsert la embaixo ele ja e "agora", entao le-se aqui ou nunca.
    .select("chat_id,status,aguardando_avaliacao,responsavel_id,responsavel_nome,ultima_auto_msg_em,auto_arquivar,mensagens_nao_lidas,last_message_at")
    .eq("chat_id", chatId)
    .maybeSingle();
  const eraNova = !convAntes;
  const cfg = await getConfig();
  // nota da pesquisa: conversa concluida aguardando avaliacao + cliente mandou so um numero 1-5
  const ehNotaAvaliacao = ehNotaCsat({ fromMe, isGroup, tipo, conteudo: content, conversa: convAntes });

  const { error: convErr } = await db.from(T.conversas).upsert(
    {
      chat_id: chatId,
      ...(nameIsJunk ? {} : { nome: chatName }),
      is_group: isGroup,
      ...(p.photo ? { foto_url: p.photo } : {}),
      canal: `zapi-${canal.id}`,
      last_message_at: ts,
      last_message_preview: previewLinha,
      updated_at: ts,
    },
    { onConflict: "chat_id" }
  );
  if (convErr) throw new Error(`conversa: ${convErr.message}`);

  if (!fromMe && !ehNotaAvaliacao) {
    // cliente escreveu: conversa concluida/arquivada reabre como "aberto" e volta
    // pro topo (igual WhatsApp — mensagem nova desarquiva). Configuravel no admin.
    // (nota da pesquisa NAO reabre o atendimento — tratada mais abaixo)
    // EXCECAO (F9): chat com auto_arquivar ligado NUNCA reabre sozinho — cada
    // mensagem re-afirma arquivada=true (grupo interno fica sempre arquivado).
    if (convAntes?.auto_arquivar) {
      await db.from(T.conversas).update({ arquivada: true }).eq("chat_id", chatId);
    } else if (cfg.auto_desarquivar_recebida) {
      await db
        .from(T.conversas)
        .update({ status: "aberto", arquivada: false })
        .eq("chat_id", chatId)
        .or("status.eq.concluido,arquivada.eq.true");
    }
    // contador de nao lidas (zera quando alguem abre a conversa no painel)
    if (ehCentral) {
      await db.rpc("inc_nao_lidas", { p_chat_id: chatId });
    } else {
      // a funcao SQL e fixa na tabela do central; canal extra incrementa direto
      await db
        .from(T.conversas)
        .update({ mensagens_nao_lidas: (convAntes?.mensagens_nao_lidas ?? 0) + 1 })
        .eq("chat_id", chatId);
    }
    // conversa REINICIADA (Frente N): o cliente voltou depois de a conversa
    // ficar parada. Roda DEPOIS de reabrir/desarquivar (a decisao nao toca em
    // `concluido`). A redistribuicao acontece DENTRO dela (rodizio proprio do
    // reinicio, que nao depende de `auto_distribuir`).
    // O RELOGIO e o carimbo DA MENSAGEM, nunca `Date.now()`: eco/backlog
    // processado tarde mediria uma janela que nunca existiu pro cliente.
    await aplicarReinicio(
      db,
      T,
      cfg,
      { canal: canal.id, chatId, antes: convAntes, deGrupo: isGroup },
      Date.parse(ts) || Date.now()
    ).catch((e) => console.error("reinicio falhou", { canal: canal.id, chat: chatId, erro: e?.message }));
  }

  const mediaUrl =
    p.audio?.audioUrl || p.image?.imageUrl || p.video?.videoUrl ||
    p.document?.documentUrl || p.sticker?.stickerUrl || null;
  const mediaMime =
    p.audio?.mimeType || p.image?.mimeType || p.video?.mimeType ||
    p.document?.mimeType || p.sticker?.mimeType || null;

  const { error: msgErr } = await db.from(T.mensagens).insert({
    chat_id: chatId,
    direcao: fromMe ? "out" : "in",
    tipo,
    conteudo: content || caption || PREVIEW_TIPO[tipo] || `[${tipo}]`,
    media_url: mediaUrl,
    media_mime: mediaMime,
    sender_name: fromMe ? null : p.senderName || null,
    sender_phone: fromMe
      ? null
      : isGroup
        ? p.participantPhone || p.participantLid || null
        : chatId,
    provider_msg_id: p.messageId || null,
    quoted_msg_id: p.referenceMessageId || p.referencedMessage?.messageId || null,
    encaminhada: !!p.forwarded,
    status: fromMe ? "sent" : "received",
    criada_em: ts,
    raw: p,
  });
  // 23505 = eco de envio que o /api/send ja gravou (mesmo provider_msg_id).
  // O eco traz o que o insert nao tinha: a URL PUBLICA da midia (audio gravado
  // no painel ficava como "[audio]" sem player) — completar em vez de descartar.
  if (msgErr && String(msgErr.code).includes("23505")) {
    if (mediaUrl && p.messageId) {
      await db
        .from(T.mensagens)
        .update({ media_url: mediaUrl, media_mime: mediaMime })
        .eq("provider_msg_id", p.messageId)
        .is("media_url", null);
    }
  } else if (msgErr) {
    throw new Error(`mensagem: ${msgErr.message}`);
  }

  // webhook de saida (assinatura por evento, lib/webhooks-saida.ts): so mensagem
  // do CLIENTE, e so quando ela entrou de verdade — 23505 aqui e entrega
  // repetida do provedor e nao pode virar aviso duplicado. Melhor-esforco, sem
  // await: destino fora do ar nao atrasa nem derruba a ingestao.
  if (!fromMe && !msgErr) {
    avisarMensagemRecebida({
      canal: canal.id,
      chatId,
      tipo,
      deGrupo: isGroup,
      temMidia: !!mediaUrl,
      providerMsgId: p.messageId,
      conteudo: content ?? caption,
    });
  }

  // automacoes de entrada (so 1:1, so mensagem do cliente); falha aqui nunca
  // derruba a ingestao da mensagem
  if (!fromMe && !isGroup) {
    await automacoesEntrada(db, cfg, canal, creds, {
      chatId,
      eraNova,
      convAntes,
      ehNotaAvaliacao,
      nota: ehNotaAvaliacao ? notaDaMensagem(content) : null,
    }).catch(() => {});
  }
}

// ── automacoes de entrada: pesquisa de satisfacao, saudacao/ausencia, rodizio ──
async function automacoesEntrada(
  db: any,
  cfg: ConfigAutomacao,
  canal: CanalDef,
  creds: ZapiCreds | null,
  ctx: {
    chatId: string;
    eraNova: boolean;
    convAntes: any;
    ehNotaAvaliacao: boolean;
    nota: number | null;
  }
) {
  const T = canal.tabelas;
  const enviar = async (texto: string) => {
    if (!creds || !texto.trim()) return;
    // o eco do webhook grava a mensagem enviada — aqui so dispara
    await zapiSendText(creds, ctx.chatId, texto.trim(), null);
  };

  // 1) nota da pesquisa de satisfacao: grava, agradece e NAO reabre o atendimento
  if (ctx.ehNotaAvaliacao && ctx.nota) {
    const gravou = await registrarAvaliacao(db, cfg, T, {
      canal: canal.id,
      chatId: ctx.chatId,
      nota: ctx.nota,
      conversa: ctx.convAntes,
      agradecer: enviar,
    });
    // so anuncia o que existe no banco (o supabase-js nao lanca: devolve error)
    if (gravou) {
      avisarAvaliacao({
        canal: canal.id,
        chatId: ctx.chatId,
        nota: ctx.nota,
        atendenteId: ctx.convAntes?.responsavel_id,
        atendenteNome: ctx.convAntes?.responsavel_nome,
      });
    }
    // registrarAvaliacao conclui a conversa sozinha — mas ela normalmente JA
    // estava concluida (a pergunta so sai ao concluir), e `avisarStatus` engole
    // status reafirmado
    avisarStatus({
      canal: canal.id,
      chatId: ctx.chatId,
      de: ctx.convAntes?.status ?? null,
      para: "concluido",
      porNome: "automacao: pesquisa de satisfacao",
      origem: "automacao",
    });
    return; // avaliacao nao dispara saudacao/rodizio
  }

  // 2) fora do horario -> mensagem de ausencia (1x por dia por conversa);
  //    dentro do horario + conversa NOVA -> saudacao
  const dentro = dentroDoHorario(cfg);
  if (!dentro && cfg.msg_ausencia) {
    const ultima = ctx.convAntes?.ultima_auto_msg_em ? new Date(ctx.convAntes.ultima_auto_msg_em).getTime() : 0;
    if (Date.now() - ultima > 24 * 3600 * 1000) {
      await enviar(cfg.msg_ausencia);
      await db.from(T.conversas).update({ ultima_auto_msg_em: new Date().toISOString() }).eq("chat_id", ctx.chatId);
    }
  } else if (dentro && ctx.eraNova && cfg.msg_saudacao) {
    await enviar(cfg.msg_saudacao);
    await db.from(T.conversas).update({ ultima_auto_msg_em: new Date().toISOString() }).eq("chat_id", ctx.chatId);
  }

  // 3) rodizio: conversa sem NENHUM responsavel vai pro atendente online com
  //    menos conversas em andamento (respeitando o teto, se houver).
  //    A ESCOLHA mora em lib/rodizio.ts desde a Frente N — a conversa REINICIADA
  //    usa a mesma, e regra de atribuicao em dois lugares e regra que diverge.
  if (!cfg.auto_distribuir) return;
  await distribuirSeOrfa(db, T, cfg, { canal: canal.id, chatId: ctx.chatId, motivo: "nova" });
}
