import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { CanalDef } from "./canais";
import type { ConversaExterna, HitExterno, MensagemExterna, RespostaEnvio, UltimaExterna } from "./fonte-externa";
import {
  chaveDaInstancia,
  corpoEnvio,
  escolherInstancia,
  lerRespostaEnvio,
  midiaDe,
  padraoBusca,
  paraConversa,
  paraHit,
  paraMensagem,
  paraUltima,
  rotuloDaInstancia,
  SELECT_CHAT,
  SELECT_HIT,
  SELECT_MENSAGEM,
  SELECT_ULTIMA,
  urlDaMidia,
  type InstanciaWa,
} from "./whatsapp-agent-formato";

// Fonte "whatsapp-agent" (09/09/2026) — o Expert Chat como TELA do WhatsApp
// Agent que o aluno ja tem instalado.
//
// As conversas NAO vivem no banco do painel: vivem no projeto Supabase do agente
// (public.wa_instance / chats / messages / message_media — as MESMAS tabelas que
// as tools `inbox`/`read` do MCP leem). Este adaptador LE direto de la e ENVIA
// pela mcp-api do agente, que aplica as travas dele (voice gate, lock de
// instancia, log) — a mensagem ja nasce no banco dele e aparece aqui no proximo
// polling. Nenhuma tabela nova em nenhum banco; nenhum webhook novo.
//
// Config por env (regra BASE: nada da empresa hardcodado):
//   WA_SUPABASE_URL          = projeto do agente. AUSENTE = o MESMO projeto do
//   WA_SUPABASE_SERVICE_KEY    painel (MSG_SUPABASE_*): a instalacao recomendada
//                              e um Supabase so — o painel no schema `mensageria`,
//                              o agente em `public`, sem colisao.
//   WA_MCP_URL               = https://<ref>.supabase.co/functions/v1/mcp-api
//   WA_MCP_KEY               = a MCP_API_KEY do agente (ou a LOCKED, se o dono
//                              quiser o painel preso a um numero)
// Sem URL+chave do banco a fonte fica desligada (canal fora do seletor, listas
// vazias, nunca 500). Sem WA_MCP_* o canal e somente leitura.
//
// O canal escolhe a instancia pelo campo `conta` (alias ou instance_id) ou pela
// `identidade` (numero); sem os dois, a instancia default do agente
// (lib/whatsapp-agent-formato.ts explica por que difere do Instagram).

const noStoreFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });

function envDb(): { url: string; key: string } | null {
  const url = process.env.WA_SUPABASE_URL || process.env.MSG_SUPABASE_URL;
  const key = process.env.WA_SUPABASE_SERVICE_KEY || process.env.MSG_SUPABASE_SERVICE_KEY;
  return url && key ? { url, key } : null;
}

export function waDisponivel(): boolean {
  return !!envDb();
}

export function waEnvioDisponivel(): boolean {
  return !!(process.env.WA_MCP_URL && process.env.WA_MCP_KEY);
}

let client: SupabaseClient<any, any, any> | null = null;
function waDb(): SupabaseClient<any, any, any> {
  if (!client) {
    const e = envDb()!;
    client = createClient(e.url, e.key, {
      db: { schema: "public" },
      auth: { persistSession: false },
      global: { fetch: noStoreFetch },
    });
  }
  return client;
}

// ---- instancias ----------------------------------------------------------

// NUNCA selecionar auth_token/client_token: o painel so precisa saber QUAL numero e.
const INSTANCIAS_TTL_MS = 5 * 60 * 1000;
let cacheInst: { em: number; lista: InstanciaWa[] } | null = null;

export async function instanciasWa(): Promise<InstanciaWa[]> {
  if (!waDisponivel()) return [];
  if (cacheInst && Date.now() - cacheInst.em < INSTANCIAS_TTL_MS) return cacheInst.lista;
  const { data, error } = await waDb()
    .from("wa_instance")
    .select("instance_id,alias,is_default,is_active,phone_connected")
    .order("created_at", { ascending: true });
  if (error) {
    console.error("whatsapp-agent instancias:", error.message);
    return cacheInst?.lista ?? [];
  }
  cacheInst = { em: Date.now(), lista: (data ?? []) as InstanciaWa[] };
  return cacheInst.lista;
}

export async function resolverInstanciaWa(canal: CanalDef): Promise<InstanciaWa | null> {
  return escolherInstancia(await instanciasWa(), chaveDaInstancia(canal));
}

// ---- conversas -------------------------------------------------------------

// `status@broadcast` e o feed de status do WhatsApp, nao uma conversa
function chatsDa(inst: InstanciaWa) {
  return waDb().from("chats").select(SELECT_CHAT).eq("instance_id", inst.instance_id).neq("chat_id", "status@broadcast");
}

export async function listarConversasWa(inst: InstanciaWa, limite = 600): Promise<ConversaExterna[]> {
  const { data, error } = await chatsDa(inst)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(limite);
  if (error) {
    console.error("whatsapp-agent conversas:", error.message);
    return [];
  }
  return (data ?? []).map(paraConversa);
}

export async function conversasWaPorIds(inst: InstanciaWa, ids: string[]): Promise<ConversaExterna[]> {
  if (!ids.length) return [];
  const { data, error } = await chatsDa(inst).in("chat_id", ids.slice(0, 200));
  if (error) {
    console.error("whatsapp-agent conversas por id:", error.message);
    return [];
  }
  return (data ?? []).map(paraConversa);
}

// Ultimas mensagens do numero inteiro — /api/chats deriva a previa da mensagem
// real (mesmo criterio do canal WhatsApp do painel).
export async function ultimasMensagensWa(inst: InstanciaWa, limite = 1500): Promise<UltimaExterna[]> {
  const { data, error } = await waDb()
    .from("messages")
    .select(SELECT_ULTIMA)
    .eq("instance_id", inst.instance_id)
    .order("message_ts", { ascending: false })
    .limit(limite);
  if (error) {
    console.error("whatsapp-agent ultimas mensagens:", error.message);
    return [];
  }
  return (data ?? []).map(paraUltima);
}

// ---- mensagens de uma conversa ---------------------------------------------

// A midia fica em buckets PRIVADOS do agente (whatsapp-images, whatsapp-audio...):
// URL assinada de 1h, uma chamada por bucket (createSignedUrls), nao por arquivo.
async function assinarMidias(linhas: any[]): Promise<Map<string, string>> {
  const porBucket = new Map<string, string[]>();
  for (const m of linhas) {
    const md = midiaDe(m);
    if (md && md.download_status === "done") porBucket.set(md.storage_bucket, [...(porBucket.get(md.storage_bucket) ?? []), md.storage_path]);
  }
  const urls = new Map<string, string>();
  await Promise.all(
    [...porBucket].map(async ([bucket, paths]) => {
      const { data, error } = await waDb().storage.from(bucket).createSignedUrls(paths, 3600);
      if (error) {
        console.error("whatsapp-agent midia assinada:", bucket, error.message);
        return;
      }
      for (const u of data ?? []) if (u.signedUrl && u.path) urls.set(`${bucket}/${u.path}`, u.signedUrl);
    })
  );
  return urls;
}

// null = erro de leitura (a rota devolve 500); [] = conversa sem mensagem.
export async function listarMensagensWa(inst: InstanciaWa, chatId: string, limite = 300): Promise<MensagemExterna[] | null> {
  const db = waDb();
  const [msgRes, chatRes] = await Promise.all([
    db
      .from("messages")
      .select(SELECT_MENSAGEM)
      .eq("instance_id", inst.instance_id)
      .eq("chat_id", chatId)
      .order("message_ts", { ascending: false })
      .limit(limite),
    db.from("chats").select("chat_name,phone").eq("instance_id", inst.instance_id).eq("chat_id", chatId).maybeSingle(),
  ]);
  if (msgRes.error) {
    console.error("whatsapp-agent mensagens:", msgRes.error.message);
    return null;
  }
  const linhas = msgRes.data ?? [];
  const assinadas = await assinarMidias(linhas);
  const contato = (chatRes.data as any)?.chat_name || (chatRes.data as any)?.phone || chatId;
  const eu = rotuloDaInstancia(inst);
  return linhas.map((m: any) => {
    const md = midiaDe(m);
    return paraMensagem(m, { eu, contato, urlMidia: urlDaMidia(md, md && assinadas.get(`${md.storage_bucket}/${md.storage_path}`)) });
  });
}

// Busca por conteudo (rota /api/busca) — o agente tem indice trigram em content.
export async function buscarMensagensWa(inst: InstanciaWa, q: string, limite = 60): Promise<HitExterno[]> {
  const { data, error } = await waDb()
    .from("messages")
    .select(SELECT_HIT)
    .eq("instance_id", inst.instance_id)
    .ilike("content", padraoBusca(q))
    .order("message_ts", { ascending: false })
    .limit(limite);
  if (error) {
    console.error("whatsapp-agent busca:", error.message);
    return [];
  }
  return (data ?? []).map(paraHit);
}

// ---- envio (pela mcp-api do agente) ----------------------------------------

// A mensagem NAO e gravada aqui: a edge send-message do agente grava no banco
// dele, e o proximo polling de /api/messages ja mostra. Quem atendeu vai na
// assinatura "*Nome:*" do texto (lib/whatsapp-agent-formato.ts le de volta).
export async function enviarTextoWa(inst: InstanciaWa, chatId: string, texto: string, quoted: string | null): Promise<RespostaEnvio> {
  const url = process.env.WA_MCP_URL;
  const key = process.env.WA_MCP_KEY;
  if (!url || !key) return { ok: false, status: 501, error: "envio pelo agente nao configurado (WA_MCP_URL/WA_MCP_KEY)" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-mcp-key": key },
      body: JSON.stringify(corpoEnvio({ chat_id: chatId, texto, instance_id: inst.instance_id, quoted })),
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
    const data = await res.json().catch(() => ({}));
    return lerRespostaEnvio(res.status, data);
  } catch (e: any) {
    console.error("whatsapp-agent envio:", e?.message);
    return { ok: false, status: 502, error: "a mcp-api do agente nao respondeu" };
  }
}
