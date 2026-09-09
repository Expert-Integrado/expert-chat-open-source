import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import { getPerfil, ehAdmin } from "@/lib/perfil";
import { persistirMidia, midiaJaNossa } from "@/lib/midia-store";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// Persistidor de midia de mensagem (25/08/2026): move arquivos de URLs que
// morrem (CDN do WhatsApp, S3 privado do ChatGuru) pro nosso Storage.
// Duas fases por canal, por rodada (cron 10/10min, mesmo padrao de /api/fotos):
// - NOVAS: mensagens das ultimas 24h com media_url externa (pega o fluxo vivo);
// - BACKFILL: cursor descendo do presente ate LIMITE_ANTIGO (as URLs mais
//   velhas que isso ja morreram em massa; o resgate do historico profundo, se
//   um dia valer, e via ChatGuru com cookies).
// Falha de download NAO trava a fila: o cursor avanca e a mensagem fica com a
// URL original (fase novas re-tenta enquanto estiver na janela de 24h).
const TIPOS_MIDIA = "(image,video,audio,document,sticker)";
const LIMITE_ANTIGO = "2026-05-27T00:00:00Z"; // ~90 dias
const LOTE = 8;

function autorizadoPorSegredo(req: NextRequest): boolean {
  const segredo = process.env.CHATGURU_SYNC_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (!segredo || !auth.startsWith("Bearer ")) return false;
  const a = Buffer.from(auth.slice(7));
  const b = Buffer.from(segredo);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Linha = { id: string; chat_id: string; provider_msg_id: string | null; media_url: string; media_mime: string | null; criada_em: string };

async function processarLote(canal: "central" | "apioficial", tabela: string, tConversas: string, fim: number) {
  const db = msgDb();
  const nossa = "%/storage/v1/object/public/midia-mensagens/%";
  const agora = new Date().toISOString();
  const h24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: curRow } = await db.from("config").select("valor").eq("chave", `midia_cursor_${canal}`).maybeSingle();
  const cursor = typeof curRow?.valor === "string" && curRow.valor ? curRow.valor : agora;

  const base = () =>
    db
      .from(tabela)
      .select("id,chat_id,provider_msg_id,media_url,media_mime,criada_em")
      .not("media_url", "is", null)
      .not("media_url", "like", nossa)
      .filter("tipo", "in", TIPOS_MIDIA)
      .order("criada_em", { ascending: false })
      .limit(LOTE);

  const [novas, antigas] = await Promise.all([
    base().gte("criada_em", h24),
    cursor === "fim" ? Promise.resolve({ data: [] as Linha[] }) : base().lt("criada_em", cursor).gte("criada_em", LIMITE_ANTIGO),
  ]);

  const linhas: Linha[] = [];
  const vistos = new Set<string>();
  for (const m of ([...(novas.data ?? []), ...(antigas.data ?? [])] as Linha[])) {
    if (vistos.has(m.id)) continue;
    vistos.add(m.id);
    linhas.push(m);
  }

  // ponte pro resgate do S3 privado do ChatGuru: id do chat la (gravado pelo sync)
  const cgIds = new Map<string, string>();
  {
    const chats = [...new Set(linhas.map((l) => l.chat_id))];
    if (chats.length) {
      const { data } = await db.from(tConversas).select("chat_id,chatguru_chat_id").in("chat_id", chats);
      for (const r of data ?? []) if (r.chatguru_chat_id) cgIds.set(r.chat_id, r.chatguru_chat_id);
    }
  }

  let movidas = 0, falhas = 0;
  for (const m of linhas) {
    if (Date.now() > fim) break;
    const url = await persistirMidia(canal, m.provider_msg_id, m.media_url, m.media_mime, cgIds.get(m.chat_id));
    if (url) {
      await db.from(tabela).update({ media_url: url }).eq("id", m.id);
      movidas++;
    } else falhas++;
  }

  // cursor do backfill avanca mesmo com falha (fila nunca trava); esgotou = 'fim'
  if (cursor !== "fim") {
    const lote = (antigas.data ?? []) as Linha[];
    const novoCursor = lote.length < LOTE ? "fim" : lote[lote.length - 1].criada_em;
    await db
      .from("config")
      .upsert({ chave: `midia_cursor_${canal}`, valor: novoCursor, updated_at: agora }, { onConflict: "chave" });
  }
  return { movidas, falhas, backfill_restante: cursor !== "fim" };
}

export async function POST(req: NextRequest) {
  if (!autorizadoPorSegredo(req)) {
    const user = await getUser(req);
    if (!user || !ehAdmin(await getPerfil(user.id))) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const fim = Date.now() + 50_000;
  const central = await processarLote("central", "mensagens", "conversas", fim);
  const apioficial = await processarLote("apioficial", "mensagens_apioficial", "conversas_apioficial", fim);
  return NextResponse.json({ ok: true, central, apioficial });
}
