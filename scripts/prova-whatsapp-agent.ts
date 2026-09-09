// Prova do CANAL DE FONTE whatsapp-agent (09/09/2026) — o Expert Chat como tela
// do WhatsApp Agent que o aluno ja tem.
//
// Roda em Node >= 22.6 sem build: `node scripts/prova-whatsapp-agent.ts`.
//
// O QUE COBRE: a traducao PURA de lib/whatsapp-agent-formato.ts (qual instancia
// o canal mostra, chat -> conversa, message -> mensagem, o corpo do `send` da
// mcp-api e a leitura da resposta dela) e uma varredura LOAD-BEARING: nenhuma
// rota importa o adaptador do Instagram ou do WhatsApp direto — tudo passa por
// lib/fonte-externa.ts, senao a proxima fonte volta a ser 11 rotas de novo.
//
// O QUE NAO COBRE (declarado): o banco do agente de verdade e a mcp-api no ar.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_NAME,
  DESTINO_WA_AGENT,
  chaveDaInstancia,
  conteudoDe,
  corpoEnvio,
  enviadoPorNome,
  escolherInstancia,
  lerRespostaEnvio,
  nomeDaAssinatura,
  padraoBusca,
  paraConversa,
  paraHit,
  paraMensagem,
  paraUltima,
  rotuloTipo,
  tipoPainel,
  urlDaMidia,
  type InstanciaWa,
} from "../lib/whatsapp-agent-formato.ts";

let blocos = 0;
let falhas = 0;
function bloco(nome: string, fn: () => void) {
  try {
    fn();
    blocos++;
    console.log("ok -", nome);
  } catch (e) {
    falhas++;
    console.error("FALHOU -", nome);
    console.error("  ", (e as Error).message);
  }
}

const inst = (p: Partial<InstanciaWa> & { instance_id: string }): InstanciaWa => ({
  alias: null,
  is_default: false,
  is_active: true,
  phone_connected: null,
  ...p,
});

// ── 1. qual numero do agente este canal mostra ───────────────────────────────
bloco("instancia: conta (alias/instance_id) > identidade (numero) > default do agente", () => {
  const lista = [
    inst({ instance_id: "3E0A1", alias: "pessoal", phone_connected: "5511999990001" }),
    inst({ instance_id: "3E0A2", alias: "profissional", is_default: true, phone_connected: "5511999990002" }),
    inst({ instance_id: "3E0A3", alias: "antigo", is_active: false }),
  ];
  assert.equal(chaveDaInstancia({ conta: " Profissional ", identidade: "" }), "profissional");
  assert.equal(chaveDaInstancia({ identidade: "@5511999990001" }), "5511999990001");
  assert.equal(escolherInstancia(lista, "profissional")?.instance_id, "3E0A2", "por alias");
  assert.equal(escolherInstancia(lista, "3e0a1")?.instance_id, "3E0A1", "por instance_id (sem caixa)");
  assert.equal(escolherInstancia(lista, "+55 (11) 99999-0001")?.instance_id, "3E0A1", "por numero, so digitos");
  assert.equal(escolherInstancia(lista, "")?.instance_id, "3E0A2", "sem chave: a DEFAULT do agente");
  assert.equal(escolherInstancia(lista, "antigo"), null, "instancia inativa nao entra");
  assert.equal(escolherInstancia(lista, "inexistente"), null, "chave que nao casa NUNCA cai na default");
  assert.equal(escolherInstancia([lista[0]], "")?.instance_id, "3E0A1", "sem default e UMA ativa: ela");
  assert.equal(escolherInstancia([lista[0], { ...lista[1], is_default: false }], ""), null, "sem default e 2+ ativas: ninguem (ambiguidade nao escolhe)");
});

// ── 2. conversa ──────────────────────────────────────────────────────────────
bloco("chat do agente -> conversa do painel (status aberto, nao lidas = waiting_on)", () => {
  const c = paraConversa({
    chat_id: "5511999990009",
    chat_name: "Fulana",
    phone: "5511999990009",
    is_group: false,
    profile_thumbnail: "https://pps.whatsapp.net/x.jpg",
    last_message_at: "2026-09-09T12:00:00Z",
    waiting_on: "me",
  });
  assert.equal(c.nome, "Fulana");
  assert.equal(c.status, "aberto");
  assert.equal(c.mensagens_nao_lidas, 1, "waiting_on=me: o contato falou por ultimo");
  assert.equal(c.foto_wa_url, "https://pps.whatsapp.net/x.jpg");
  assert.equal(c.last_message_preview, null, "previa e derivada da mensagem real na rota");
  const g = paraConversa({ chat_id: "120363@g.us", chat_name: null, phone: null, is_group: true, waiting_on: "none" });
  assert.equal(g.nome, "120363@g.us", "sem nome cai no chat_id");
  assert.equal(g.is_group, true);
  assert.equal(g.mensagens_nao_lidas, 0);
});

// ── 3. mensagem ──────────────────────────────────────────────────────────────
bloco("tipos: ptt vira audio, sticker fica, o resto vira texto com rotulo", () => {
  assert.equal(tipoPainel("ptt"), "audio");
  assert.equal(tipoPainel("sticker"), "sticker");
  assert.equal(tipoPainel("document"), "document");
  assert.equal(tipoPainel("location"), "text");
  assert.equal(tipoPainel(null), "text");
  assert.equal(rotuloTipo("location"), "[localizacao]");
  assert.equal(rotuloTipo("coisa_nova"), "[coisa_nova]", "tipo desconhecido nao some: vira rotulo");
  assert.equal(conteudoDe({ content: "transcricao do audio", message_type: "ptt" }), "transcricao do audio", "audio transcrito mostra o texto");
  assert.equal(conteudoDe({ content: null, caption: "legenda", message_type: "image" }), "legenda");
  assert.equal(conteudoDe({ content: null, caption: null, message_type: "image" }), "[foto]");
  assert.equal(conteudoDe({ content: "x", is_deleted: true }), "Mensagem apagada");
});

bloco("quem enviou: assinatura do painel > nome do agente > aparelho do dono", () => {
  assert.equal(nomeDaAssinatura("*Maria:* oi"), "Maria");
  assert.equal(nomeDaAssinatura("oi *Maria:*"), null, "so no INICIO");
  assert.equal(enviadoPorNome({ from_me: false, sent_by_agent_name: "x" }), null);
  assert.equal(enviadoPorNome({ from_me: true, sent_by_agent_name: AGENT_NAME, content: "*Maria:* oi" }), "Maria", "mensagem do painel: o nome vem da assinatura");
  assert.equal(enviadoPorNome({ from_me: true, sent_by_agent_name: AGENT_NAME, content: "sem assinatura" }), "Expert Chat");
  assert.equal(enviadoPorNome({ from_me: true, sent_by_agent_name: "claude-code-local" }), "claude-code-local", "mensagem de OUTRO agente leva o nome dele");
  assert.equal(enviadoPorNome({ from_me: true, sent_by_agent_name: null }), null, "digitada no celular: sem nome (a tela mostra 'Voce')");
});

bloco("message -> mensagem do painel, com midia assinada e sender por contexto", () => {
  const ctx = { eu: "profissional", contato: "Fulana", urlMidia: "https://x/assinada" };
  const m = paraMensagem(
    {
      id: "u1", provider_msg_id: "3EB0", chat_id: "5511999990009", from_me: false, sender_phone: "5511999990009", sender_name: null,
      message_type: "image", content: null, caption: "olha", quoted_msg_id: "3EA9", is_forwarded: true, is_edited: false, is_deleted: false,
      message_ts: "2026-09-09T12:00:00Z", send_status: null, sent_by_agent_name: null,
      message_media: [{ mime_type: "image/jpeg", storage_bucket: "whatsapp-images", storage_path: "a/b.jpg", download_status: "done", original_url: "https://prov/x" }],
    },
    ctx
  );
  assert.equal(m.direcao, "in");
  assert.equal(m.tipo, "image");
  assert.equal(m.conteudo, "olha");
  assert.equal(m.sender_name, "Fulana", "1:1 recebida: o contato");
  assert.equal(m.media_url, "https://x/assinada");
  assert.equal(m.media_mime, "image/jpeg");
  assert.equal(m.quoted_msg_id, "3EA9");
  assert.equal(m.encaminhada, true);
  assert.equal(m.editada_em, null);
  const g = paraMensagem({ id: "u2", chat_id: "1@g.us", from_me: false, sender_phone: "5511777", sender_name: "Beltrano", message_type: "text", content: "e ai", message_ts: "t" }, ctx);
  assert.equal(g.sender_name, "Beltrano", "grupo: o participante");
  const s = paraMensagem({ id: "u3", chat_id: "x", from_me: true, sent_by_agent_name: AGENT_NAME, content: "*Maria:* oi", message_type: "text", message_ts: "t", is_edited: true }, ctx);
  assert.equal(s.direcao, "out");
  assert.equal(s.sender_name, "Maria");
  assert.equal(s.enviado_por_nome, "Maria");
  assert.equal(s.editada_em, "t", "editada: a tela so precisa de um carimbo");
  const d = paraMensagem({ id: "u4", chat_id: "x", from_me: true, sent_by_agent_name: null, content: "do celular", message_type: "text", message_ts: "t" }, ctx);
  assert.equal(d.sender_name, "profissional", "do aparelho: o rotulo da instancia");
});

bloco("midia: assinada so quando o agente ja baixou; senao a original; sem midia, nada", () => {
  const md = { mime_type: "audio/ogg", storage_bucket: "whatsapp-audio", storage_path: "p", download_status: "done", original_url: "https://prov/o" };
  assert.equal(urlDaMidia(md, "https://x/s"), "https://x/s");
  assert.equal(urlDaMidia({ ...md, download_status: "pending" }, "https://x/s"), "https://prov/o", "pendente: a original, mesmo com assinada");
  assert.equal(urlDaMidia({ ...md, download_status: "pending", original_url: null }, null), null);
  assert.equal(urlDaMidia(null, "https://x/s"), null);
});

bloco("previa e busca: mesmo formato que a rota ja consome", () => {
  const u = paraUltima({ chat_id: "c", content: null, caption: null, message_type: "ptt", from_me: true, sent_by_agent_name: AGENT_NAME, message_ts: "t", is_deleted: false });
  assert.deepEqual(u, { chat_id: "c", conteudo: "[audio]", direcao: "out", enviado_por_nome: "Expert Chat", criada_em: "t", is_deleted: false });
  const h = paraHit({ id: "i", chat_id: "c", content: "achei", from_me: false, message_ts: "t", sent_by_agent_name: null, provider_msg_id: "p" });
  assert.equal(h.conteudo, "achei");
  assert.equal(h.provider_msg_id, "p");
  assert.equal(padraoBusca("100%_a"), "%100\\%\\_a%", "curinga do ilike escapado");
});

// ── 4. envio pela mcp-api ────────────────────────────────────────────────────
bloco("destino no dialeto do agente: telefone, grupo (@g.us ou -group) e @lid", () => {
  for (const ok of ["5511999990009", "120363426941320160@g.us", "5511999990009-1552265144@g.us".replace("-", ""), "120363426941320160-group", "123456789012345@lid"])
    assert.ok(DESTINO_WA_AGENT.test(ok), ok);
  for (const nao of ["", "abc", "551199", "5511999990009@s.whatsapp.net", "status@broadcast", "x@g.us"])
    assert.ok(!DESTINO_WA_AGENT.test(nao), `recusa ${nao}`);
});

bloco("corpo do send: confirmado, sem teatro de digitacao, forcando o gate de inbound, na instancia do canal", () => {
  const c = corpoEnvio({ chat_id: "5511999990009", texto: "*Maria:* oi", instance_id: "3E0A2", quoted: "3EA9" });
  assert.equal(c.action, "send");
  assert.equal(c.params.to, "5511999990009");
  assert.equal(c.params.type, "text");
  assert.equal(c.params.confirmed, true, "humano ja apertou enviar");
  assert.equal(c.params.force_send_after_inbound, true, "atendente RESPONDENDO e o caso que a trava do agente barraria");
  assert.equal(c.params.humanize, false);
  assert.equal(c.params.agent_name, AGENT_NAME);
  assert.equal(c.params.instance, "3E0A2", "nunca a default: o numero do canal");
  assert.equal(c.params.reply_to, "3EA9");
  assert.ok(!("reply_to" in corpoEnvio({ chat_id: "x", texto: "t", instance_id: "i" }).params), "sem quote nao manda reply_to");
  assert.ok(!("confirmed_voice" in c.params), "o voice gate do agente NAO e bypassado pelo painel");
});

bloco("resposta da mcp-api: so ok+id e sucesso; bloqueio de voz vira 403 com as violacoes", () => {
  assert.deepEqual(lerRespostaEnvio(200, { ok: true, provider_msg_id: "3EB1", message_id: "uuid" }), { ok: true, messageId: "3EB1" });
  assert.deepEqual(lerRespostaEnvio(200, { ok: true, message_id: "uuid" }), { ok: true, messageId: "uuid" });
  const voz = lerRespostaEnvio(200, { ok: false, blocked: true, reason: "voice_gate", violations: [{ rule: "sem girias" }] });
  assert.equal(voz.ok, false);
  if (!voz.ok) {
    assert.equal(voz.status, 403);
    assert.deepEqual(voz.detalhe, [{ rule: "sem girias" }]);
    assert.match(voz.error, /voice guide/);
  }
  const conf = lerRespostaEnvio(200, { blocked: true, needs_confirmation: true });
  assert.equal(conf.ok, false);
  if (!conf.ok) assert.equal(conf.status, 409);
  const amb = lerRespostaEnvio(200, { ok: true, ambiguous: true, candidates: [] });
  assert.equal(amb.ok, false, "ambiguo NAO e sucesso, mesmo com ok:true");
  const cred = lerRespostaEnvio(401, { error: "unauthorized" });
  assert.equal(cred.ok, false);
  if (!cred.ok) assert.match(cred.error, /WA_MCP_KEY/);
  const semId = lerRespostaEnvio(200, { ok: true });
  assert.equal(semId.ok, false, "ok sem id de mensagem e erro declarado, nunca 'enviado'");
  const erro = lerRespostaEnvio(500, { error: "Falha ao criar chat" });
  assert.equal(erro.ok, false);
  if (!erro.ok) assert.equal(erro.error, "Falha ao criar chat");
});

// ── 5. varredura load-bearing ────────────────────────────────────────────────
function arquivos(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) arquivos(p, acc);
    else if (/\.tsx?$/.test(n)) acc.push(p);
  }
  return acc;
}

bloco("rota nenhuma importa adaptador de fonte externa direto: tudo passa por lib/fonte-externa.ts", () => {
  const ofensores = arquivos("app").filter((p) => /from "@\/lib\/(instagram-agent|whatsapp-agent)"/.test(readFileSync(p, "utf8")));
  assert.deepEqual(ofensores, [], "rota importando adaptador direto (use fonteLigada/externaDisponivel)");
  const libs = arquivos("lib").filter((p) => !/fonte-externa\.ts$/.test(p) && /from "\.\/(instagram-agent|whatsapp-agent)"|from "@\/lib\/(instagram-agent|whatsapp-agent)"/.test(readFileSync(p, "utf8")));
  assert.deepEqual(libs, [], "lib importando adaptador direto");
});

bloco("lib/canais.ts: whatsapp-agent e fonte externa (sem linha no painel) E envia (WA_MCP_*)", () => {
  const src = readFileSync("lib/canais.ts", "utf8");
  assert.match(src, /canal\.fonte === "instagram-agent" \|\| canal\.fonte === "whatsapp-agent"/, "fonteExterna cobre as duas");
  assert.match(src, /c\.fonte === "whatsapp-agent"[\s\S]{0,300}WA_MCP_URL && process\.env\.WA_MCP_KEY/, "envioDisponivel liga com WA_MCP_URL+WA_MCP_KEY");
  assert.match(src, /"instagram-agent", "whatsapp-agent"\]/, "a lista FONTES aceita a fonte nova em CANAIS_EXTRA");
});

bloco("/api/send: o ramo do agente vem DEPOIS dos tres gates de permissao e ANTES de tocar o banco do painel", () => {
  const src = readFileSync("app/api/send/route.ts", "utf8");
  const iPerm = src.indexOf('permitido(perfil, "enviar")');
  const iVer = src.indexOf("podeVerConversa(String(chat_id)");
  const iExt = src.indexOf("if (ext?.enviarTexto) {");
  const iDb = src.indexOf("const db = msgDb();");
  assert.ok(iPerm > 0 && iVer > iPerm && iExt > iVer && iDb > iExt, "ordem: permissao -> escopo -> envio externo -> banco do painel");
  assert.match(src, /ext \? DESTINO_WA_AGENT : DESTINO_VALIDO/, "destino validado no dialeto do agente");
  assert.match(src, /ext && \(ehMidia \|\| ehInterativa \|\| template\)/, "midia/interativa/template pelo agente: 400 declarado");
});

bloco("lib/whatsapp-agent.ts: nunca le o token da instancia; midia assinada por bucket", () => {
  const src = readFileSync("lib/whatsapp-agent.ts", "utf8");
  assert.ok(!/auth_token|client_token/.test(src.replace(/\/\/.*$/gm, "")), "select em wa_instance sem credencial");
  assert.match(src, /createSignedUrls\(paths, 3600\)/);
  assert.match(src, /"x-mcp-key": key/, "auth da mcp-api pelo header");
  assert.match(src, /WA_SUPABASE_URL \|\| process\.env\.MSG_SUPABASE_URL/, "um Supabase so: cai no projeto do painel");
});

console.log(`\n${blocos} blocos ok, ${falhas} falhas`);
if (falhas) process.exit(1);
