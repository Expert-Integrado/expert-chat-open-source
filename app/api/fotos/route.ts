import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import { getPerfil, ehAdmin } from "@/lib/perfil";
import { credsCentral } from "@/lib/zapi";
import { guardarFotoPermanente, linkCdnValido } from "@/lib/foto-store";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// Renovador de fotos de perfil (canal central/Z-API). A URL que o WhatsApp da
// EXPIRA em dias — foto renovada so ao abrir a conversa (rota messages) deixava
// a LISTA cheia de avatar morto, principalmente grupos (que ninguem "abre").
// Este endpoint renova em LOTE as fotos mais velhas das conversas RELEVANTES
// (grupo nao arquivado, ou contato com movimento em 90 dias) e roda por cron
// (pg_cron, mesmo padrao do sync do ChatGuru) — a cada rodada, as N mais velhas.
// Desde 25/08/2026 a imagem e salva PERMANENTE no Storage (lib/foto-store):
// a renovacao periodica existe so pra capturar foto TROCADA, nao pra manter
// link vivo — se a Z-API falhar num ciclo, a foto guardada continua no ar.
const TTL_MS = 3 * 24 * 60 * 60 * 1000; // renovar o que tem mais de 3 dias
const LOTE = 40; // por rodada — Z-API aguenta; o cron compensa no volume

function autorizadoPorSegredo(req: NextRequest): boolean {
  const segredo = process.env.CHATGURU_SYNC_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (!segredo || !auth.startsWith("Bearer ")) return false;
  const a = Buffer.from(auth.slice(7));
  const b = Buffer.from(segredo);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!autorizadoPorSegredo(req)) {
    const user = await getUser(req);
    if (!user || !ehAdmin(await getPerfil(user.id))) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const creds = credsCentral();
  if (!creds) return NextResponse.json({ error: "Z-API central sem credenciais" }, { status: 500 });

  const db = msgDb();
  const corte = new Date(Date.now() - TTL_MS).toISOString();
  const ativoDesde = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // candidatas: foto vencida (ou nunca buscada), grupo nao arquivado OU contato
  // com movimento em 90d — mais velha primeiro (null vem antes)
  const { data: rows, error } = await db
    .from("conversas")
    .select("chat_id,is_group,foto_wa_em,last_message_at,arquivada")
    .or(`foto_wa_em.is.null,foto_wa_em.lt.${corte}`)
    .or(`is_group.eq.true,last_message_at.gte.${ativoDesde}`)
    .eq("arquivada", false)
    .order("foto_wa_em", { ascending: true, nullsFirst: true })
    .limit(LOTE);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let renovadas = 0, semFoto = 0, falhas = 0;
  for (const c of rows ?? []) {
    try {
      const r = await fetch(
        `https://api.z-api.io/instances/${creds.instance}/token/${creds.token}/profile-picture?phone=${encodeURIComponent(c.chat_id)}`,
        { headers: creds.clientToken ? { "Client-Token": creds.clientToken } : ({} as Record<string, string>), cache: "no-store" }
      );
      if (!r.ok) { falhas++; continue; }
      const j: any = await r.json().catch(() => ({}));
      const link = linkCdnValido(j?.link ?? j?.profilePicture);
      // carimba foto_wa_em SEMPRE (pra fila andar); nunca apaga foto boa
      const patch: Record<string, any> = { foto_wa_em: new Date().toISOString() };
      if (link) {
        // salva a imagem no Storage (URL nossa, permanente); CDN so como fallback
        const nossa = await guardarFotoPermanente(db, c.chat_id, link);
        patch.foto_wa_url = nossa || link;
        renovadas++;
      } else semFoto++;
      await db.from("conversas").update(patch).eq("chat_id", c.chat_id);
    } catch {
      falhas++;
    }
  }
  return NextResponse.json({ ok: true, candidatas: rows?.length ?? 0, renovadas, sem_foto: semFoto, falhas });
}
