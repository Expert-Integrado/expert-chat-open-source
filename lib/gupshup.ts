import { msgDb, pubDb } from "@/lib/mensageria";

// Canal WhatsApp API OFICIAL (Meta) via Gupshup — PLUGAVEL POR CANAL (P1 30/08/2026).
// Credencial por canal, produto BASE (N numeros Gupshup por instalacao):
//   GUPSHUP_<ID_MAIUSCULO>_API_KEY / _SOURCE_NUMBER / _APP_NAME / _APP_ID
// Fallback historico SO do builtin "apioficial": conector gravado em
// public.connectors (a instalacao da Expert compartilha o conector do hub de
// agendamento). Instalacao de cliente usa as envs — nada hardcodado.
// Convencao de envs espelhada em lib/canais.ts (envioDisponivel).
export type GupshupCreds = { apiKey: string; source: string; appName: string; appId: string };

const cache = new Map<string, { creds: GupshupCreds; em: number }>();

export async function credsGupshup(canal: string = "apioficial"): Promise<GupshupCreds | null> {
  const hit = cache.get(canal);
  if (hit && Date.now() - hit.em < 10 * 60 * 1000) return hit.creds;

  const p = `GUPSHUP_${canal.toUpperCase()}_`;
  const apiKey = process.env[p + "API_KEY"];
  const source = process.env[p + "SOURCE_NUMBER"];
  if (apiKey && source) {
    const creds = {
      apiKey,
      source: String(source),
      appName: process.env[p + "APP_NAME"] || "",
      appId: process.env[p + "APP_ID"] || "",
    };
    cache.set(canal, { creds, em: Date.now() });
    return creds;
  }
  // canal gupshup extra sem env = nao cabeado (fail-closed: nunca cai no
  // numero de outro canal). So o builtin apioficial tem o fallback do banco.
  if (canal !== "apioficial") return null;

  const { data } = await pubDb()
    .from("connectors")
    .select("kind,config")
    .ilike("kind", "%gupshup%")
    .limit(1)
    .maybeSingle();
  const cfg: any = data?.config || {};
  if (!cfg.api_key || !cfg.source_number) return null;
  const creds = {
    apiKey: cfg.api_key,
    source: String(cfg.source_number),
    appName: cfg.app_name || "",
    appId: cfg.app_id || "",
  };
  cache.set(canal, { creds, em: Date.now() });
  return creds;
}

// Janela de 24h da API oficial: aberta enquanto a ULTIMA mensagem RECEBIDA do
// contato tem menos de 24h. Fechada = so template aprovado (enviado fora do
// painel). A tabela e a do CANAL (multi-numero); default = builtin apioficial.
export async function janela24h(
  chatId: string,
  tabelaMensagens: string = "mensagens_apioficial"
): Promise<{ aberta: boolean; expira_em: string | null }> {
  const { data } = await msgDb()
    .from(tabelaMensagens)
    .select("criada_em")
    .eq("chat_id", chatId)
    .eq("direcao", "in")
    .order("criada_em", { ascending: false })
    .limit(1);
  const ultima = data?.[0]?.criada_em;
  if (!ultima) return { aberta: false, expira_em: null };
  const expira = new Date(new Date(ultima).getTime() + 24 * 60 * 60 * 1000);
  return { aberta: expira.getTime() > Date.now(), expira_em: expira.toISOString() };
}

// ————————————————————————— TEMPLATES POR NUMERO (card 86ak858pa)
//
// Na API Oficial, iniciar conversa fora da janela de 24h exige template APROVADO
// e a aprovacao e por NUMERO REMETENTE. Por isso tudo aqui recebe `creds` do
// CANAL: dois numeros Gupshup na mesma instalacao tem catalogos diferentes.
//
// AS ROTAS SAO PROVADAS EM CONTA REAL, nao deduzidas: vem do Meeting Hub
// (`agenda-hub`, src/shared/actions/gupshup.ts), com os gotchas medidos la em
// 17/08/2026 anotados em cada funcao. A REGRA (validacao, leitura do cru,
// permissao de envio) mora em lib/templates-oficial.ts, puro e provado.
//
// O `appId` e obrigatorio pra falar de template (o envio de sessao usa `source` +
// `src.name`; o catalogo usa `/wa/app/{appId}/template`). Instalacao sem
// GUPSHUP_<ID>_APP_ID nao consegue administrar template — e a rota diz isso, em
// vez de estourar 404 do provedor na cara do usuario.
const API_APP = "https://api.gupshup.io/wa/app";

export function faltaAppId(creds: GupshupCreds): boolean {
  return !String(creds.appId || "").trim();
}

/** Lista CRUA dos templates do app. A traducao e `lerTemplateGupshup` (pura). */
export async function gsListarTemplates(
  creds: GupshupCreds
): Promise<{ ok: true; lista: any[] } | { ok: false; motivo: string }> {
  if (faltaAppId(creds)) {
    return { ok: false, motivo: "este numero nao tem app_id do Gupshup configurado na instalacao" };
  }
  try {
    const r = await fetch(`${API_APP}/${encodeURIComponent(creds.appId)}/template`, {
      headers: { apikey: creds.apiKey },
      cache: "no-store",
    });
    const j: any = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, motivo: `Gupshup ${r.status}` };
    // o corpo vem como {templates:[...]} ou {data:[...]} dependendo da conta
    const lista = (j?.templates ?? j?.data ?? []) as any[];
    return { ok: true, lista: Array.isArray(lista) ? lista : [] };
  } catch {
    return { ok: false, motivo: "nao consegui falar com o Gupshup agora" };
  }
}

/**
 * Manda um template PRA APROVACAO. Nasce PENDING; quem aprova e a Meta (minutos
 * a 24h) e o veredito so aparece depois de SINCRONIZAR.
 *
 * GOTCHAS medidos no Meeting Hub, e cada um custou um 4xx:
 *  - endpoint no SINGULAR (`/template`); `/templates` devolve 404;
 *  - `example` e obrigatorio quando ha variavel (a Meta le o exemplo pra
 *    entender o template) e `enableSample=true` vai junto;
 *  - arte NOVA (arquivo do computador) NAO passa por aqui: as rotas de upload do
 *    api.gupshup.io devolvem 404 e a documentada e do partner.gupshup.io, que
 *    responde 401 com a credencial do app. Subir arte nova segue pelo console do
 *    Gupshup; daqui da pra REAPROVEITAR o handle de uma arte ja aprovada.
 */
export async function gsCriarTemplate(
  creds: GupshupCreds,
  t: {
    nome: string;
    idioma: string;
    categoria: string;
    assunto: string;
    corpo: string;
    exemplo: string;
    rodape?: string;
    botoes?: Array<{ type: string; text: string; url?: string }>;
    midiaId?: string;
  }
): Promise<{ ok: true; providerId: string; status: string } | { ok: false; motivo: string }> {
  if (faltaAppId(creds)) {
    return { ok: false, motivo: "este numero nao tem app_id do Gupshup configurado na instalacao" };
  }
  const midiaId = String(t.midiaId || "").trim();
  const form = new URLSearchParams({
    elementName: t.nome,
    languageCode: t.idioma || "pt_BR",
    category: t.categoria,
    templateType: midiaId ? "IMAGE" : "TEXT",
    vertical: t.assunto,
    content: t.corpo,
    example: t.exemplo || t.corpo,
    enableSample: "true",
  });
  if (t.botoes?.length) form.set("buttons", JSON.stringify(t.botoes));
  if (t.rodape?.trim()) form.set("footer", t.rodape.trim());
  // com templateType=IMAGE e sem o handle da arte, o Gupshup recusa
  if (midiaId) form.set("exampleMedia", midiaId);

  try {
    const r = await fetch(`${API_APP}/${encodeURIComponent(creds.appId)}/template`, {
      method: "POST",
      headers: { apikey: creds.apiKey, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      cache: "no-store",
    });
    const j: any = await r.json().catch(() => null);
    if (!r.ok || j?.status === "error") {
      const msg = String(j?.message?.message ?? j?.message ?? j?.error ?? `Gupshup ${r.status}`);
      // traduz o que mais aparece — mensagem crua de API na cara do usuario nao ajuda ninguem
      if (/already exist|duplicate/i.test(msg)) {
        return { ok: false, motivo: "ja existe um template com esse nome neste numero. Escolha outro." };
      }
      if (/start or end/i.test(msg)) {
        return { ok: false, motivo: "a Meta recusou: a mensagem nao pode comecar nem terminar com variavel." };
      }
      return { ok: false, motivo: msg.slice(0, 200) };
    }
    const tpl: any = j?.template ?? j?.data ?? {};
    return {
      ok: true,
      providerId: String(tpl.id ?? tpl.templateId ?? ""),
      status: String(tpl.status ?? "PENDING"),
    };
  } catch {
    return { ok: false, motivo: "nao consegui falar com o Gupshup agora" };
  }
}

/**
 * Apaga o template DE VERDADE: sai do app e da Meta, e nao volta.
 *
 * A rota e por NOME (`elementName`), nao por id — provado no Meeting Hub em
 * 17/08/2026 (por id a mesma rota nao reconhece). O formato do nome e conferido
 * pelo chamador (`/^[a-z0-9_]+$/`, em lib/templates-oficial.ts): o nome vai NA
 * URL da API, e nome livre ali seria path traversal.
 */
export async function gsApagarTemplate(
  creds: GupshupCreds,
  nome: string
): Promise<{ ok: true } | { ok: false; motivo: string }> {
  if (faltaAppId(creds)) {
    return { ok: false, motivo: "este numero nao tem app_id do Gupshup configurado na instalacao" };
  }
  try {
    const r = await fetch(
      `${API_APP}/${encodeURIComponent(creds.appId)}/template/${encodeURIComponent(nome)}`,
      { method: "DELETE", headers: { apikey: creds.apiKey }, cache: "no-store" }
    );
    const j: any = await r.json().catch(() => null);
    if (!r.ok || j?.status === "error") {
      const msg = String(j?.message?.message ?? j?.message ?? `Gupshup ${r.status}`);
      return { ok: false, motivo: msg.slice(0, 200) };
    }
    return { ok: true };
  } catch {
    return { ok: false, motivo: "nao consegui falar com o Gupshup agora" };
  }
}

/**
 * Envia UM template — o unico caminho de mensagem fora da janela de 24h.
 * O corpo do POST e montado por `corpoEnvioTemplate` (puro, com o gotcha da
 * imagem) e a resposta e lida por `lerRespostaEnvio` (202 sem messageId = falha).
 */
export async function gsEnviarTemplate(
  creds: GupshupCreds,
  form: URLSearchParams
): Promise<{ status: number; corpo: any }> {
  const r = await fetch("https://api.gupshup.io/wa/api/v1/template/msg", {
    method: "POST",
    headers: { apikey: creds.apiKey, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    cache: "no-store",
  });
  const corpo = await r.json().catch(() => ({}));
  return { status: r.status, corpo };
}

/**
 * Saldo da carteira do provedor.
 *
 * DECLARADO, pra ninguem confundir com as rotas de template acima: esta rota NAO
 * tem prova de producao neste repo (nem no Meeting Hub). Ela vai como
 * melhor-esforco e o fracasso e MUDO — `lerSaldo` devolve "saldo indisponivel" e
 * a tela do canal segue funcionando. Nunca estoura.
 */
export async function gsSaldo(creds: GupshupCreds): Promise<any | null> {
  try {
    const r = await fetch("https://api.gupshup.io/wa/api/v1/wallet/balance", {
      headers: { apikey: creds.apiKey },
      cache: "no-store",
    });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch {
    return null;
  }
}

// Envio de texto livre (mensagem de sessao). So funciona com a janela aberta —
// a Meta recusa fora dela; quem valida antes e o /api/send.
export async function gsSendText(creds: GupshupCreds, destino: string, texto: string): Promise<{ messageId: string | null }> {
  const body = new URLSearchParams({
    channel: "whatsapp",
    source: creds.source,
    destination: destino,
    "src.name": creds.appName,
    message: JSON.stringify({ type: "text", text: texto }),
  });
  const r = await fetch("https://api.gupshup.io/wa/api/v1/msg", {
    method: "POST",
    headers: { apikey: creds.apiKey, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.status === "error") {
    throw new Error(`Gupshup ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return { messageId: j.messageId || null };
}

// FRENTE S (31/08/2026), card 86ak86jvw — MENSAGEM INTERATIVA (botoes e lista).
//
// Mesmo endpoint e mesma forma de `gsSendText`: o que muda e o JSON do campo
// `message`, que aqui vem pronto de lib/interativas.ts (`envelopeGupshup`,
// puro e provavel em node solto — se o envelope morasse dentro deste `fetch`, a
// unica prova possivel seria rede).
//
// A API oficial da Meta trata os dois formatos como cidadaos de primeira classe
// (`type: "quick_reply"`, ate 3 opcoes; `type: "list"`, ate 10) — os tetos estao
// em lib/interativas.ts com a fonte anotada.
//
// JANELA DE 24h: interativa e mensagem de SESSAO, exatamente como texto livre.
// Quem confere a janela e /api/send, antes de chegar aqui — a checagem nao se
// repete nesta camada de proposito (regra em dois lugares e regra que diverge).
export async function gsSendInterativo(
  creds: GupshupCreds,
  destino: string,
  envelope: Record<string, unknown>
): Promise<{ messageId: string | null }> {
  const body = new URLSearchParams({
    channel: "whatsapp",
    source: creds.source,
    destination: destino,
    "src.name": creds.appName,
    message: JSON.stringify(envelope),
  });
  const r = await fetch("https://api.gupshup.io/wa/api/v1/msg", {
    method: "POST",
    headers: { apikey: creds.apiKey, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.status === "error") {
    throw new Error(`Gupshup ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return { messageId: j.messageId || null };
}
