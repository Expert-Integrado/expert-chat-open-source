// Prova das funcoes PURAS de parse dos webhooks dos 3 provedores, sobre os
// payloads de scripts/fixtures/. Roda em Node >= 22.6 sem build, sem rede e sem
// banco: `node scripts/prova-webhook-formatos.ts`
// (type stripping nativo; por isso as libs provadas aqui nao podem importar
// nada com o alias @/ — sao arquivos puros de proposito).
//
// O que NAO esta coberto aqui, e por que: o parse do canal Z-API vive dentro de
// ingest() em app/api/webhook/route.ts, que fala com o banco — nao e funcao pura.
// A fixture da Z-API existe pra travar o CONTRATO que aquele ramo consome
// (os campos que ele le), nao pra exercitar o ramo.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEvento, statusGupshup } from "../lib/gupshup-inbound.ts";
import { ehNotaCsat, notaDaMensagem } from "../lib/csat.ts";
import {
  digitosDoJid,
  ehGrupoJid,
  jidEvolution,
  normalizarEvolution,
  numeroEvolution,
  parseSendResult,
  rotuloEvolution,
  separarDataUri,
} from "../lib/evolution-formato.ts";

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fx = (nome: string) => JSON.parse(readFileSync(dir + nome, "utf8"));

let testes = 0;
function bloco(nome: string, fn: () => void) {
  fn();
  testes++;
  console.log(`ok  ${nome}`);
}

// ── Z-API: contrato do payload que o ramo zapi do webhook consome ────────────
bloco("zapi ReceivedCallback traz os campos que o ingest usa", () => {
  const p = fx("zapi-received.json");
  assert.equal(p.type, "ReceivedCallback");
  assert.equal(typeof p.instanceId, "string", "2a barreira do webhook e o instanceId");
  assert.equal(typeof p.phone, "string");
  assert.equal(typeof p.messageId, "string");
  assert.equal(typeof p.momment, "number");
  assert.equal(p.fromMe, false);
  assert.equal(p.text.message, "bom dia, queria informacao");
});

// ── Gupshup / Meta: parseEvento ─────────────────────────────────────────────
bloco("gupshup v1: mensagem de texto vira MsgNova", () => {
  const [m, ...resto] = parseEvento(fx("gupshup-inbound-v1.json"));
  assert.equal(resto.length, 0, "1 payload = 1 mensagem");
  assert.equal(m.chat_id, "5511922222222");
  assert.equal(m.nome, "Lead Teste");
  assert.equal(m.texto, "quero saber do curso");
  assert.equal(m.tipo, "text");
  assert.equal(m.wamid, "wamid.GUPTESTE1");
});

bloco("meta cloud: midia sem texto vira rotulo legivel", () => {
  const [m] = parseEvento(fx("gupshup-inbound-meta.json"));
  assert.equal(m.chat_id, "5511933333333");
  assert.equal(m.nome, "Lead Meta");
  assert.equal(m.tipo, "image");
  assert.equal(m.texto, "[foto]", "sem legenda, a tela mostra rotulo — nunca vazio");
  assert.equal(m.wamid, "wamid.METATESTE1");
  assert.equal(m.ts, new Date(1756600100 * 1000).toISOString(), "timestamp em segundos");
});

bloco("gupshup: payload que nao e mensagem nao vira mensagem", () => {
  assert.deepEqual(parseEvento(fx("gupshup-message-event.json")), []);
  assert.deepEqual(parseEvento({}), []);
  assert.deepEqual(parseEvento(null), []);
});

bloco("gupshup: chat_id que nao e telefone e descartado", () => {
  const bruto = fx("gupshup-inbound-v1.json");
  bruto.payload.sender.phone = "123"; // curto demais pra ser telefone
  bruto.payload.source = "123";
  assert.deepEqual(parseEvento(bruto), []);
});

// ── Gupshup: recibo de entrega ──────────────────────────────────────────────
bloco("gupshup message-event: recibo tenta os DOIS identificadores", () => {
  const r = statusGupshup(fx("gupshup-message-event.json"));
  assert.ok(r);
  assert.equal(r.status, "delivered");
  assert.deepEqual(r.ids.sort(), ["gs-id-teste-1", "wamid.GUPTESTE1"].sort());
});

bloco("gupshup: status fora da regua nao promove nada", () => {
  const bruto = fx("gupshup-message-event.json");
  for (const t of ["failed", "enqueued", "deleted", ""]) {
    bruto.payload.type = t;
    assert.equal(statusGupshup(bruto), null, `status ${t || "(vazio)"} nao vira promocao`);
  }
  assert.equal(statusGupshup(fx("gupshup-inbound-v1.json")), null, "mensagem nao e recibo");
});

// ── Evolution: helpers de JID ───────────────────────────────────────────────
bloco("evolution: digitos do jid e deteccao de grupo", () => {
  assert.equal(digitosDoJid("5511944444444@s.whatsapp.net"), "5511944444444");
  assert.equal(digitosDoJid("120363000000000000@g.us"), "120363000000000000");
  assert.equal(digitosDoJid(undefined), "");
  assert.equal(ehGrupoJid("120363000000000000@g.us"), true);
  assert.equal(ehGrupoJid("5511944444444@s.whatsapp.net"), false);
  assert.equal(rotuloEvolution("image"), "[foto]");
  assert.equal(rotuloEvolution("coisa-nova"), "[coisa-nova]");
});

// ── Evolution: messages.upsert ──────────────────────────────────────────────
bloco("evolution 1:1: texto recebido", () => {
  const ev = normalizarEvolution(fx("evolution-upsert-1a1.json"));
  assert.equal(ev.kind, "mensagem");
  if (ev.kind !== "mensagem") return;
  assert.equal(ev.chatId, "5511944444444", "1:1 = so digitos");
  assert.equal(ev.isGroup, false);
  assert.equal(ev.fromMe, false);
  assert.equal(ev.chatName, "Contato Evolution");
  assert.equal(ev.senderPhone, "5511944444444");
  assert.equal(ev.tipo, "text");
  assert.equal(ev.conteudo, "bom dia!");
  assert.equal(ev.providerMsgId, "3EB0EVO1");
  assert.equal(ev.ts, new Date(1756600200 * 1000).toISOString());
});

bloco("evolution grupo: chat_id <digitos>-group e citacao preservada", () => {
  const ev = normalizarEvolution(fx("evolution-upsert-grupo.json"));
  assert.equal(ev.kind, "mensagem");
  if (ev.kind !== "mensagem") return;
  assert.equal(ev.isGroup, true);
  assert.equal(ev.chatId, "120363000000000000-group", "formato de grupo do painel");
  assert.ok(!ev.chatId.includes("@"), "nunca guardar o jid cru como chat_id");
  assert.equal(ev.senderPhone, "5511955555555", "quem falou no grupo");
  assert.equal(ev.chatName, null, "pushName em grupo e o participante, nunca o nome do grupo");
  assert.equal(ev.conteudo, "olha isso ai");
  assert.equal(ev.quotedMsgId, "3EB0ANTERIOR");
});

bloco("evolution lid: remoteJidAlt traz o telefone real", () => {
  const ev = normalizarEvolution(fx("evolution-upsert-lid.json"));
  assert.equal(ev.kind, "mensagem");
  if (ev.kind !== "mensagem") return;
  assert.equal(ev.chatId, "5511966666666", "usa remoteJidAlt, nao o @lid");
  assert.equal(ev.tipo, "image");
  assert.equal(ev.caption, "segue o print");
  assert.equal(ev.mediaMime, "image/jpeg");
});

bloco("evolution lid SEM alt: fica @lid, nao vira telefone falso", () => {
  const bruto = fx("evolution-upsert-lid.json");
  delete bruto.data.key.remoteJidAlt;
  const ev = normalizarEvolution(bruto);
  assert.equal(ev.kind, "mensagem");
  if (ev.kind !== "mensagem") return;
  assert.equal(ev.chatId, "199999999999999@lid");
  assert.equal(ev.senderPhone, null);
});

bloco("evolution eco fromMe: pushName NUNCA batiza a conversa", () => {
  const ev = normalizarEvolution(fx("evolution-upsert-eco-frommer.json"));
  assert.equal(ev.kind, "mensagem");
  if (ev.kind !== "mensagem") return;
  assert.equal(ev.fromMe, true);
  assert.equal(ev.chatName, null, "incidente 28/08: pushName do eco e o nome da NOSSA conta");
  assert.equal(ev.chatId, "5511944444444");
});

// ── Evolution: messages.update (ack) ────────────────────────────────────────
bloco("evolution ack: DELIVERY_ACK vira delivered", () => {
  const ev = normalizarEvolution(fx("evolution-update-ack.json"));
  assert.equal(ev.kind, "status");
  if (ev.kind !== "status") return;
  assert.equal(ev.status, "delivered");
  assert.deepEqual(ev.ids, ["3EB0EVO1"], "key.id e keyId sao o mesmo id, sem duplicar");
});

bloco("evolution ack: mapa completo e ack desconhecido ignorado", () => {
  const bruto = fx("evolution-update-ack.json");
  const esperado: Record<string, string> = {
    READ: "read", PLAYED: "read", DELIVERY_ACK: "delivered",
    SERVER_ACK: "sent", PENDING: "sent",
  };
  for (const [ack, status] of Object.entries(esperado)) {
    bruto.data.status = ack;
    const ev = normalizarEvolution(bruto);
    assert.equal(ev.kind === "status" && ev.status, status, `${ack} -> ${status}`);
  }
  bruto.data.status = "ERROR";
  assert.equal(normalizarEvolution(bruto).kind, "ignorado", "ack desconhecido nao mexe em status");
});

bloco("evolution: evento fora do escopo v1 e ignorado, nao erro", () => {
  for (const e of ["connection.update", "contacts.update", "groups.upsert", ""]) {
    assert.equal(normalizarEvolution({ event: e, data: {} }).kind, "ignorado", e || "(sem evento)");
  }
  assert.equal(normalizarEvolution({}).kind, "ignorado");
  assert.equal(
    normalizarEvolution({ event: "messages.upsert", data: { key: {} } }).kind,
    "ignorado",
    "upsert sem remoteJid nao vira conversa"
  );
});

bloco("evolution: reacao aplica no alvo, nao vira mensagem nova", () => {
  const bruto = fx("evolution-upsert-1a1.json");
  bruto.data.message = { reactionMessage: { key: { id: "3EB0ALVO" }, text: "❤️" } };
  bruto.data.messageType = "reactionMessage";
  const ev = normalizarEvolution(bruto);
  assert.equal(ev.kind, "reacao");
  if (ev.kind !== "reacao") return;
  assert.equal(ev.alvo, "3EB0ALVO");
});

bloco("evolution: mensagem efemera e desembrulhada", () => {
  const bruto = fx("evolution-upsert-1a1.json");
  bruto.data.message = { ephemeralMessage: { message: { conversation: "some em 24h" } } };
  const ev = normalizarEvolution(bruto);
  assert.equal(ev.kind === "mensagem" && ev.conteudo, "some em 24h");
});

// ── Evolution: formato de SAIDA (destino, midia, id de retorno) ─────────────
bloco("evolution destino: grupo NUNCA sai com hifen (gotcha do 400)", () => {
  assert.equal(
    numeroEvolution("120363000000000000-group"),
    "120363000000000000",
    "grupo moderno: so digitos"
  );
  assert.equal(
    numeroEvolution("5511944444444-1600000000-group"),
    "55119444444441600000000",
    "grupo antigo: os dois pedacos concatenados, sem hifen"
  );
  assert.equal(numeroEvolution("5511944444444"), "5511944444444");
  assert.equal(numeroEvolution("5511944444444@s.whatsapp.net"), "5511944444444");
  assert.ok(!numeroEvolution("120363000000000000-group").includes("-"));
});

bloco("evolution destino: @lid RECUSADO, nunca vira telefone fabricado", () => {
  // o /api/send barra pelo formato, mas agendadas e CSAT chamam sem validar —
  // a recusa mora na traducao, por onde os 3 passam
  assert.throws(() => numeroEvolution("199999999999999@lid"), /@lid/);
  assert.throws(() => jidEvolution("199999999999999@lid"), /@lid/);
  assert.throws(() => numeroEvolution(""), /sem digitos/);
  assert.throws(() => numeroEvolution("sem-numero-nenhum"), /sem digitos/);
  // e o caminho normal segue passando
  assert.equal(numeroEvolution("5511944444444@s.whatsapp.net"), "5511944444444");
});

bloco("evolution destino: jid completo pras acoes com chave", () => {
  assert.equal(jidEvolution("5511944444444"), "5511944444444@s.whatsapp.net");
  assert.equal(jidEvolution("120363000000000000-group"), "120363000000000000@g.us");
  assert.equal(jidEvolution("120363000000000000@g.us"), "120363000000000000@g.us", "jid ja pronto passa igual");
});

bloco("evolution midia: data URI vira base64 puro + mimetype separado", () => {
  const { conteudo, mime } = separarDataUri("data:image/png;base64,QUJD");
  assert.equal(conteudo, "QUJD", "sem o prefixo, senao o arquivo chega corrompido");
  assert.equal(mime, "image/png");
  const url = separarDataUri("https://exemplo/arquivo.pdf");
  assert.equal(url.conteudo, "https://exemplo/arquivo.pdf", "URL publica passa intacta");
  assert.equal(url.mime, null);
});

bloco("evolution: id de retorno aceita os 3 formatos", () => {
  assert.equal(parseSendResult({ key: { id: "A" }, messageId: "B" }).messageId, "A");
  assert.equal(parseSendResult({ messageId: "B" }).messageId, "B");
  assert.equal(parseSendResult({ id: "C" }).messageId, "C");
  assert.equal(parseSendResult({}).messageId, null);
});

// ── CSAT: a metade da RESPOSTA, compartilhada pelas 3 fontes ────────────────
bloco("csat: so o numero 1-5 sozinho vira nota", () => {
  assert.equal(notaDaMensagem("5"), 5);
  assert.equal(notaDaMensagem(" 3 "), 3, "espaco em volta nao atrapalha");
  assert.equal(notaDaMensagem("1"), 1);
  assert.equal(notaDaMensagem("0"), null, "fora da escala");
  assert.equal(notaDaMensagem("6"), null, "fora da escala");
  assert.equal(notaDaMensagem("5 estrelas"), null, "texto junto = mensagem normal");
  assert.equal(notaDaMensagem("nota 5"), null);
  assert.equal(notaDaMensagem(null), null);
});

bloco("csat: nota so conta do cliente, em 1:1, com a conversa aguardando", () => {
  const base = {
    fromMe: false,
    isGroup: false,
    tipo: "text",
    conteudo: "5",
    conversa: { aguardando_avaliacao: true, responsavel_id: "u1", responsavel_nome: "Atendente" },
  };
  assert.equal(ehNotaCsat(base), true);
  assert.equal(ehNotaCsat({ ...base, fromMe: true }), false, "eco nosso nunca e nota");
  assert.equal(ehNotaCsat({ ...base, isGroup: true }), false, "grupo nao recebe pesquisa");
  assert.equal(ehNotaCsat({ ...base, tipo: "image" }), false, "foto com legenda 5 nao e nota");
  assert.equal(ehNotaCsat({ ...base, conteudo: "5, obrigado" }), false);
  assert.equal(
    ehNotaCsat({ ...base, conversa: { aguardando_avaliacao: false } }),
    false,
    "sem pesquisa pendente, '5' e mensagem normal e reabre o atendimento"
  );
  assert.equal(ehNotaCsat({ ...base, conversa: null }), false, "conversa nova");
});

console.log(`\n${testes} blocos, todos verdes.`);
