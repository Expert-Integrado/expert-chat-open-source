import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { CanalDef } from "./canais";

// Fonte "instagram-agent" (Central de Atendimento, 28/08/2026).
//
// As DMs do Instagram NAO vivem no banco do painel: vivem no projeto Supabase
// do Instagram Agent (tabelas public.ig_account / ig_chats / ig_messages — as
// MESMAS que a tool `inbox` do MCP le). Este adaptador le direto de la, SOMENTE
// LEITURA, e traduz pro formato que as rotas do painel ja consomem (mesmas
// colunas de conversas/mensagens). Nenhuma tabela nova em nenhum banco.
//
// Config por env (regra BASE: nada da empresa hardcodado):
//   IG_SUPABASE_URL          = https://<ref>.supabase.co do projeto do instagram-agent
//   IG_SUPABASE_SERVICE_KEY  = chave service role desse projeto (RLS bloqueia anon)
// Sem as duas envs a fonte fica desligada: canal Instagram nao entra no seletor
// e as rotas devolvem lista vazia (nunca 500).
//
// O canal escolhe a conta pelo campo `conta` (alias operacional ou @perfil da
// ig_account); sem `conta`, vale a `identidade` (@perfil). Conta nao conectada
// no instagram-agent = canal registrado, mas sem conversas ate alguem conectar.

const noStoreFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });

let client: SupabaseClient<any, any, any> | null = null;

export function igDisponivel(): boolean {
  return !!(process.env.IG_SUPABASE_URL && process.env.IG_SUPABASE_SERVICE_KEY);
}

function igDb(): SupabaseClient<any, any, any> {
  if (!client) {
    client = createClient(process.env.IG_SUPABASE_URL!, process.env.IG_SUPABASE_SERVICE_KEY!, {
      db: { schema: "public" },
      auth: { persistSession: false },
      global: { fetch: noStoreFetch },
    });
  }
  return client;
}

export type ContaIg = {
  ig_user_id: string;
  username: string | null;
  alias: string | null;
  is_default: boolean;
  is_active: boolean;
};

// NUNCA selecionar access_token aqui: o painel so precisa saber QUAL conta e.
const CONTAS_TTL_MS = 5 * 60 * 1000;
let cacheContas: { em: number; lista: ContaIg[] } | null = null;

export async function contasIg(): Promise<ContaIg[]> {
  if (!igDisponivel()) return [];
  if (cacheContas && Date.now() - cacheContas.em < CONTAS_TTL_MS) return cacheContas.lista;
  const { data, error } = await igDb()
    .from("ig_account")
    .select("ig_user_id,username,alias,is_default,is_active")
    .order("connected_at", { ascending: true });
  if (error) {
    console.error("instagram-agent contas:", error.message);
    return cacheContas?.lista ?? [];
  }
  cacheContas = { em: Date.now(), lista: (data ?? []) as ContaIg[] };
  return cacheContas.lista;
}

// Resolve a conta do canal: `conta` (alias ou @perfil) > `identidade` (@perfil).
// Nao cai na conta default de proposito: canal Instagram SEM conta declarada e
// erro de cadastro, e nao pode acabar mostrando a DM de outra conta.
export async function resolverContaIg(canal: CanalDef): Promise<ContaIg | null> {
  const chave = String(canal.conta || canal.identidade || "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
  if (!chave) return null;
  const lista = await contasIg();
  return (
    lista.find(
      (c) =>
        c.is_active &&
        (c.alias?.toLowerCase() === chave || c.username?.toLowerCase() === chave || c.ig_user_id === chave)
    ) ?? null
  );
}

// Rotulo do que a DM manda sem texto (mesma ideia do sync do canal oficial).
const ROTULO_TIPO: Record<string, string> = {
  image: "[foto]",
  video: "[video]",
  audio: "[audio]",
  file: "[arquivo]",
  share: "[compartilhamento]",
  story_mention: "[mencao em story]",
  story_reply: "[resposta a story]",
  reel: "[reel]",
  sticker: "[figurinha]",
  unsupported: "[conteudo sem suporte]",
  deleted: "Mensagem apagada",
};

function rotuloTipo(t: string | null | undefined): string {
  return ROTULO_TIPO[t || ""] ?? `[${t || "mensagem"}]`;
}

// tipo do painel: o front trata text/image/video/audio/document/nota; o resto
// vira texto com rotulo.
function tipoPainel(t: string | null | undefined): string {
  if (t === "file") return "document";
  if (t === "image" || t === "video" || t === "audio" || t === "text") return t;
  return "text";
}

function nomeChat(c: { username: string | null; name: string | null; igsid: string }): string {
  return c.name || (c.username ? `@${c.username}` : c.igsid);
}

// ---- conversas (formato de mensageria.conversas) -------------------------

export type ConversaIg = {
  chat_id: string;
  nome: string;
  is_group: false;
  foto_url: null;
  foto_wa_url: null;
  last_message_at: string | null;
  last_message_preview: string | null;
  status: "aberto";
  responsavel_id: null;
  responsavel_nome: null;
  responsavel_tipo: null;
  mensagens_nao_lidas: number;
  arquivada: false;
  auto_arquivar: false;
};

const SELECT_CHAT = "igsid,username,name,last_message_at,last_received_at,last_sent_at,waiting_reply";

function paraConversa(c: any): ConversaIg {
  return {
    chat_id: c.igsid,
    nome: nomeChat(c),
    is_group: false,
    // a foto de perfil vive em bucket PRIVADO do instagram-agent (URL da Meta
    // expira) — sem URL publica a tela cai nas iniciais, como no ChatGuru
    foto_url: null,
    foto_wa_url: null,
    last_message_at: c.last_message_at,
    last_message_preview: null, // a previa e derivada da ultima mensagem real (rota /api/chats)
    status: "aberto",
    responsavel_id: null,
    responsavel_nome: null,
    responsavel_tipo: null,
    // o banco do Instagram nao tem contador de nao lidas; `waiting_reply`
    // (coluna gerada: ultima mensagem e do lead) e o sinal equivalente
    mensagens_nao_lidas: c.waiting_reply ? 1 : 0,
    arquivada: false,
    auto_arquivar: false,
  };
}

export async function listarConversasIg(conta: ContaIg, limite = 600): Promise<ConversaIg[]> {
  const { data, error } = await igDb()
    .from("ig_chats")
    .select(SELECT_CHAT)
    .eq("ig_user_id", conta.ig_user_id)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(limite);
  if (error) {
    console.error("instagram-agent conversas:", error.message);
    return [];
  }
  return (data ?? []).map(paraConversa);
}

export async function conversasIgPorIds(conta: ContaIg, ids: string[]): Promise<ConversaIg[]> {
  if (!ids.length) return [];
  const { data, error } = await igDb()
    .from("ig_chats")
    .select(SELECT_CHAT)
    .eq("ig_user_id", conta.ig_user_id)
    .in("igsid", ids.slice(0, 200));
  if (error) {
    console.error("instagram-agent conversas por id:", error.message);
    return [];
  }
  return (data ?? []).map(paraConversa);
}

// Ultimas mensagens da conta inteira — a rota /api/chats deriva a previa da
// mensagem real (mesmo criterio do canal WhatsApp).
export async function ultimasMensagensIg(conta: ContaIg, limite = 1500) {
  const { data, error } = await igDb()
    .from("ig_messages")
    .select("igsid,content,message_type,from_me,sent_by_agent_name,message_ts,is_deleted")
    .eq("ig_user_id", conta.ig_user_id)
    .order("message_ts", { ascending: false })
    .limit(limite);
  if (error) {
    console.error("instagram-agent ultimas mensagens:", error.message);
    return [];
  }
  return (data ?? []).map((m: any) => ({
    chat_id: m.igsid,
    conteudo: m.content || rotuloTipo(m.message_type),
    direcao: m.from_me ? "out" : "in",
    enviado_por_nome: m.from_me ? m.sent_by_agent_name || null : null,
    criada_em: m.message_ts,
    is_deleted: !!m.is_deleted,
  }));
}

// ---- mensagens de uma conversa (formato de mensageria.mensagens) ------------

// null = erro de leitura (a rota devolve 500); [] = conversa sem mensagem.
export async function listarMensagensIg(conta: ContaIg, igsid: string, limite = 300) {
  const db = igDb();
  const [msgRes, chatRes] = await Promise.all([
    db
      .from("ig_messages")
      .select("id,mid,from_me,message_type,content,reply_to_mid,is_deleted,send_status,sent_by_agent_name,message_ts")
      .eq("ig_user_id", conta.ig_user_id)
      .eq("igsid", igsid)
      .order("message_ts", { ascending: false })
      .limit(limite),
    db.from("ig_chats").select("igsid,username,name").eq("ig_user_id", conta.ig_user_id).eq("igsid", igsid).maybeSingle(),
  ]);
  if (msgRes.error) {
    console.error("instagram-agent mensagens:", msgRes.error.message);
    return null;
  }
  const contato = chatRes.data ? nomeChat(chatRes.data as any) : igsid;
  const eu = conta.username ? `@${conta.username}` : conta.alias || "Instagram";
  return (msgRes.data ?? []).map((m: any) => ({
    id: m.id,
    direcao: m.from_me ? "out" : "in",
    tipo: tipoPainel(m.message_type),
    conteudo: m.content || rotuloTipo(m.message_type),
    sender_name: m.from_me ? m.sent_by_agent_name || eu : contato,
    sender_phone: null, // Instagram nao expoe telefone
    status: m.send_status,
    criada_em: m.message_ts,
    // midia fica em bucket privado do instagram-agent: v1 mostra o rotulo do tipo
    media_url: null,
    media_mime: null,
    enviado_por_nome: m.from_me ? m.sent_by_agent_name || null : null,
    provider_msg_id: m.mid,
    quoted_msg_id: m.reply_to_mid,
    is_deleted: !!m.is_deleted,
    editada_em: null,
    reacao: null,
    encaminhada: false,
  }));
}

// Busca por conteudo (rota /api/busca) — mesmo formato dos hits do WhatsApp.
export async function buscarMensagensIg(conta: ContaIg, q: string, limite = 60) {
  const { data, error } = await igDb()
    .from("ig_messages")
    .select("igsid,content,from_me,message_ts,sent_by_agent_name")
    .eq("ig_user_id", conta.ig_user_id)
    .ilike("content", `%${q.replace(/[%_]/g, "\\$&")}%`)
    .order("message_ts", { ascending: false })
    .limit(limite);
  if (error) {
    console.error("instagram-agent busca:", error.message);
    return [];
  }
  return (data ?? []).map((m: any) => ({
    chat_id: m.igsid,
    conteudo: m.content,
    direcao: m.from_me ? "out" : "in",
    criada_em: m.message_ts,
    sender_name: m.from_me ? m.sent_by_agent_name || null : null,
    enviado_por_nome: m.from_me ? m.sent_by_agent_name || null : null,
  }));
}
