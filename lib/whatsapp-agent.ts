import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { CanalDef } from "./canais";
import type { ConversaExterna, HitExterno, MensagemExterna, MensagemRef, PedidoEnvio, RespostaEnvio, UltimaExterna } from "./fonte-externa";
import { msgDb } from "./mensageria";
import { BUCKET_MIDIA } from "./midia-store";
import { separarDataUri } from "./evolution-formato";
import {
  caminhoMidia,
  canonico,
  corpoReacao,
  lerRespostaReacao,
  reacoesPorMensagem,
  chaveDaInstancia,
  corpoEnvio,
  escolherInstancia,
  fundirGemeos,
  idsDaConversa,
  lerRespostaEnvio,
  MAPA_VAZIO,
  mapaLid,
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
  type MapaLid,
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

// ---- @lid -> telefone (lid_mapping do agente) --------------------------------

// A tabela e pequena (centenas de linhas) e muda devagar: cache por instancia.
const LID_TTL_MS = 5 * 60 * 1000;
const cacheLid = new Map<string, { em: number; mapa: MapaLid }>();

async function mapaLidWa(inst: InstanciaWa): Promise<MapaLid> {
  const c = cacheLid.get(inst.instance_id);
  if (c && Date.now() - c.em < LID_TTL_MS) return c.mapa;
  const { data, error } = await waDb().from("lid_mapping").select("lid,phone").eq("instance_id", inst.instance_id);
  if (error) {
    console.error("whatsapp-agent lid_mapping:", error.message);
    return c?.mapa ?? MAPA_VAZIO; // fail open: sem mapa a lista sai sem fundir, nunca vazia
  }
  const mapa = mapaLid((data ?? []) as any[]);
  cacheLid.set(inst.instance_id, { em: Date.now(), mapa });
  return mapa;
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
  return fundirGemeos((data ?? []).map(paraConversa), await mapaLidWa(inst));
}

export async function conversasWaPorIds(inst: InstanciaWa, ids: string[]): Promise<ConversaExterna[]> {
  if (!ids.length) return [];
  const mapa = await mapaLidWa(inst);
  // o painel pede pelo id canonico (telefone); o agente pode ter a linha so no @lid
  const todos = [...new Set(ids.slice(0, 200).flatMap((id) => idsDaConversa(id, mapa)))];
  const { data, error } = await chatsDa(inst).in("chat_id", todos);
  if (error) {
    console.error("whatsapp-agent conversas por id:", error.message);
    return [];
  }
  return fundirGemeos((data ?? []).map(paraConversa), mapa);
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
  const mapa = await mapaLidWa(inst);
  return (data ?? []).map((m: any) => ({ ...paraUltima(m), chat_id: canonico(m.chat_id, mapa) }));
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
  // a conversa da tela = o chat do telefone + os @lid mapeados pra ele
  const ids = idsDaConversa(chatId, await mapaLidWa(inst));
  const [msgRes, chatRes] = await Promise.all([
    db
      .from("messages")
      .select(SELECT_MENSAGEM)
      .eq("instance_id", inst.instance_id)
      .in("chat_id", ids)
      .order("message_ts", { ascending: false })
      .limit(limite),
    db.from("chats").select("chat_id,chat_name,phone").eq("instance_id", inst.instance_id).in("chat_id", ids),
  ]);
  if (msgRes.error) {
    console.error("whatsapp-agent mensagens:", msgRes.error.message);
    return null;
  }
  const linhas = msgRes.data ?? [];
  const [assinadas, reacoes] = await Promise.all([assinarMidias(linhas), reacoesDe(inst, linhas)]);
  const linhasChat = (chatRes.data ?? []) as any[];
  const contato =
    linhasChat.map((c) => c.chat_name).find((n) => n && !/^\d+(@lid)?$/.test(n)) ||
    linhasChat.map((c) => c.phone).find(Boolean) ||
    chatId;
  const eu = rotuloDaInstancia(inst);
  return linhas.map((m: any) => {
    const md = midiaDe(m);
    const linha = paraMensagem(m, { eu, contato, urlMidia: urlDaMidia(md, md && assinadas.get(`${md.storage_bucket}/${md.storage_path}`)) });
    return { ...linha, reacao: reacoes.get(m.provider_msg_id) ?? null };
  });
}

// A reacao vive em message_reactions (o eco do webhook grava a nossa e a do
// contato). UMA consulta pelos provider_msg_id da pagina.
async function reacoesDe(inst: InstanciaWa, linhas: any[]): Promise<Map<string, string>> {
  const ids = linhas.map((m) => m.provider_msg_id).filter(Boolean);
  if (!ids.length) return new Map();
  const { data, error } = await waDb()
    .from("message_reactions")
    .select("target_msg_id,emoji,reacted_at")
    .eq("instance_id", inst.instance_id)
    .in("target_msg_id", ids);
  if (error) {
    console.error("whatsapp-agent reacoes:", error.message);
    return new Map();
  }
  return reacoesPorMensagem((data ?? []) as any[]);
}

// Uma mensagem pelo id do agente — o que a rota de reacao precisa pros gates.
export async function mensagemWaPorId(inst: InstanciaWa, id: string): Promise<MensagemRef | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data, error } = await waDb()
    .from("messages")
    .select("id,chat_id,provider_msg_id,from_me,is_deleted")
    .eq("instance_id", inst.instance_id)
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return { id: data.id, chat_id: canonico(data.chat_id, await mapaLidWa(inst)), provider_msg_id: data.provider_msg_id, direcao: data.from_me ? "out" : "in", is_deleted: !!data.is_deleted };
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
  const mapa = await mapaLidWa(inst);
  return (data ?? []).map((m: any) => ({ ...paraHit(m), chat_id: canonico(m.chat_id, mapa) }));
}

// ---- envio (pela mcp-api do agente) ----------------------------------------

async function mcpApi(corpo: unknown): Promise<{ status: number; data: any } | null> {
  const url = process.env.WA_MCP_URL;
  const key = process.env.WA_MCP_KEY;
  if (!url || !key) return null;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-mcp-key": key },
    body: JSON.stringify(corpo),
    cache: "no-store",
    signal: AbortSignal.timeout(45_000),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// Midia do painel (base64) vira URL publica no bucket de midia do painel — a
// mcp-api so aceita URL. Mesmo bucket do persistidor (lib/midia-store.ts).
async function subirMidia(canalId: string, midia: NonNullable<PedidoEnvio["midia"]>): Promise<string> {
  const { conteudo, mime } = separarDataUri(midia.dataUri);
  const bytes = Buffer.from(conteudo, "base64");
  if (!bytes.length) throw new Error("midia vazia");
  const { caminho, contentType } = caminhoMidia({ canal: canalId, tipo: midia.tipo, mime, fileName: midia.fileName, id: crypto.randomUUID() });
  const { error } = await msgDb().storage.from(BUCKET_MIDIA).upload(caminho, bytes, { contentType, upsert: false });
  if (error) throw new Error(`upload da midia: ${error.message}`);
  return `${process.env.MSG_SUPABASE_URL}/storage/v1/object/public/${BUCKET_MIDIA}/${caminho}`;
}

// A mensagem NAO e gravada aqui: a edge send-message do agente grava no banco
// dele, e o proximo polling de /api/messages ja mostra. Quem atendeu vai na
// assinatura "*Nome:*" do texto (lib/whatsapp-agent-formato.ts le de volta).
export async function enviarWa(inst: InstanciaWa, canalId: string, chatId: string, pedido: PedidoEnvio): Promise<RespostaEnvio> {
  try {
    const mediaUrl = pedido.midia ? await subirMidia(canalId, pedido.midia) : null;
    const r = await mcpApi(
      corpoEnvio({
        chat_id: chatId,
        texto: pedido.texto,
        instance_id: inst.instance_id,
        quoted: pedido.quoted,
        tipo: pedido.midia?.tipo ?? "text",
        mediaUrl,
        fileName: pedido.midia?.fileName ?? null,
      })
    );
    if (!r) return { ok: false, status: 501, error: "envio pelo agente nao configurado (WA_MCP_URL/WA_MCP_KEY)" };
    return lerRespostaEnvio(r.status, r.data);
  } catch (e: any) {
    console.error("whatsapp-agent envio:", e?.message);
    return { ok: false, status: 502, error: e?.message?.startsWith("upload") ? "nao consegui guardar a midia pra enviar" : "a mcp-api do agente nao respondeu" };
  }
}

// Reacao pela tool `react` da mcp-api (message_id = id da mensagem no agente).
// O eco do webhook grava em message_reactions, e a proxima leitura mostra.
export async function reagirWa(inst: InstanciaWa, messageId: string, emoji: string) {
  void inst; // a instancia vem da propria mensagem no agente
  try {
    const r = await mcpApi(corpoReacao(messageId, emoji));
    if (!r) return { ok: false as const, status: 501, error: "envio pelo agente nao configurado (WA_MCP_URL/WA_MCP_KEY)" };
    return lerRespostaReacao(r.status, r.data);
  } catch (e: any) {
    console.error("whatsapp-agent reacao:", e?.message);
    return { ok: false as const, status: 502, error: "a mcp-api do agente nao respondeu" };
  }
}
