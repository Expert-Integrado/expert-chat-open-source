import { createHash } from "node:crypto";
import { msgDb } from "@/lib/mensageria";

// Midia de MENSAGEM permanente (decisao Eric 25/08/2026, mesmo racional das
// fotos de perfil): os arquivos chegam em URLs que morrem — CDN do WhatsApp
// expira e o S3 do ChatGuru (zapguruusers.s3) e privado, 403 SEMPRE, com ou
// sem cookies (medido 25/08 a noite; a medicao anterior "abre com cookie" era
// de outro arquivo e estava errada). O resgate certo e o mesmo que o painel
// do ChatGuru usa: GET /attachments/message/download/<oid-da-mensagem> com os
// cookies da sessao devolve uma URL S3 ASSINADA temporaria, que baixa 200.
// O oid vem do messages2 do chat (casado por wa_message_id = provider_msg_id);
// o id do chat no ChatGuru fica em conversas.chatguru_chat_id (o sync grava).
const BUCKET = "midia-mensagens";
export { BUCKET as BUCKET_MIDIA };
const MAX_BYTES = 45 * 1024 * 1024; // bucket aceita 50MB; folga pra nao estourar
const TIMEOUT_MS = 20_000;

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/3gpp": "3gp",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr",
  "application/pdf": "pdf",
};

let cookiesCache: { valor: string | null; em: number } | null = null;
async function cookiesChatGuru(): Promise<string | null> {
  if (cookiesCache && Date.now() - cookiesCache.em < 10 * 60 * 1000) return cookiesCache.valor;
  const { data } = await msgDb().from("config").select("valor").eq("chave", "chatguru_cookies").maybeSingle();
  const valor = typeof data?.valor === "string" && data.valor.length > 10 ? data.valor : null;
  cookiesCache = { valor, em: Date.now() };
  return valor;
}

async function fetchComTimeout(url: string, headers: Record<string, string> = {}): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { headers, cache: "no-store", signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// wa_message_id -> oid interno do ChatGuru, por chat. A pagina do messages2 e
// CUMULATIVA (page/N = ultimas N*20 mensagens), entao 2 tentativas cobrem ate
// 500 mensagens. Cache por chat dentro da instancia (uma rodada do cron).
const oidCache = new Map<string, Map<string, string>>();
async function mapaOidsDoChat(cgChatId: string, ck: string): Promise<Map<string, string>> {
  const pronto = oidCache.get(cgChatId);
  if (pronto) return pronto;
  const base = process.env.CHATGURU_BASE_URL || "";
  const mapa = new Map<string, string>();
  for (const pagina of [5, 25]) {
    const r = await fetchComTimeout(`${base}/messages2/${cgChatId}/page/${pagina}`, {
      cookie: ck,
      "x-requested-with": "XMLHttpRequest",
    });
    if (!r?.ok) break;
    const j: any = await r.json().catch(() => ({}));
    const itens: any[] = j.messages_and_notes || [];
    for (const x of itens) {
      const m = x?.m;
      if (x?.type === "message" && m?.wa_message_id && m?._id?.$oid && m?.file) {
        mapa.set(String(m.wa_message_id), String(m._id.$oid));
      }
    }
    if (itens.length < pagina * 20) break; // chat inteiro ja veio
  }
  oidCache.set(cgChatId, mapa);
  return mapa;
}

// Arquivo no S3 privado do ChatGuru: troca (chat, wa_message_id) por uma URL
// assinada temporaria — o mesmo endpoint que o painel deles usa.
async function urlAssinadaChatGuru(cgChatId: string, providerMsgId: string): Promise<string | null> {
  const ck = await cookiesChatGuru();
  const base = process.env.CHATGURU_BASE_URL || "";
  if (!ck || !base) return null;
  const oid = (await mapaOidsDoChat(cgChatId, ck)).get(providerMsgId);
  if (!oid) return null;
  const r = await fetchComTimeout(`${base}/attachments/message/download/${oid}`, {
    cookie: ck,
    "x-requested-with": "XMLHttpRequest",
  });
  if (!r?.ok) return null;
  const url = (await r.text()).trim();
  return /^https:\/\//.test(url) ? url : null;
}

// Baixa a midia da URL original e guarda no Storage. Retorna a URL publica
// permanente, ou null quando nao da (404/expirada, grande demais, timeout) —
// quem chama decide manter a URL antiga.
export async function persistirMidia(
  canal: "central" | "apioficial",
  providerMsgId: string | null,
  urlOrigem: string,
  mime?: string | null,
  chatguruChatId?: string | null
): Promise<string | null> {
  try {
    const u = new URL(urlOrigem);
    if (u.protocol !== "https:") return null;
    let urlDownload = urlOrigem;
    if (u.host.includes("zapguruusers.s3")) {
      if (!chatguruChatId || !providerMsgId) return null;
      const assinada = await urlAssinadaChatGuru(chatguruChatId, providerMsgId);
      if (!assinada) return null;
      urlDownload = assinada;
    }
    const r = await fetchComTimeout(urlDownload);
    if (!r?.ok) return null;
    const bytes = Buffer.from(await r.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) return null;

    const contentType = (mime || r.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
    const extUrl = (u.pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase();
    const ext = EXT[contentType] || extUrl || "bin";
    // nome deterministico: mesma mensagem re-processada sobrescreve o mesmo arquivo
    const chave = createHash("sha1").update(providerMsgId || urlOrigem).digest("hex").slice(0, 24);
    const path = `${canal}/${chave}.${ext}`;

    const { error } = await msgDb().storage.from(BUCKET).upload(path, bytes, {
      contentType,
      upsert: true,
    });
    if (error) return null;
    return `${process.env.MSG_SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  } catch {
    return null;
  }
}

// URL ja e do nosso Storage? (nao ha o que re-processar)
export function midiaJaNossa(url: string | null | undefined): boolean {
  return !!url && url.includes(`/storage/v1/object/public/${BUCKET}/`);
}
