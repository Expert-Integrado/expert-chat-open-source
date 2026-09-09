import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { msgDb } from "@/lib/mensageria";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Sininho: notificacoes do proprio usuario (nao lidas + as 20 ultimas lidas).
export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const db = msgDb();
  const [naoLidas, lidas] = await Promise.all([
    db
      .from("notificacoes")
      .select("id,chat_id,titulo,texto,autor_nome,lida,criada_em")
      .eq("user_id", user.id)
      .eq("lida", false)
      .order("criada_em", { ascending: false })
      .limit(50),
    db
      .from("notificacoes")
      .select("id,chat_id,titulo,texto,autor_nome,lida,criada_em")
      .eq("user_id", user.id)
      .eq("lida", true)
      .order("criada_em", { ascending: false })
      .limit(20),
  ]);
  if (naoLidas.error) return NextResponse.json({ error: naoLidas.error.message }, { status: 500 });
  return NextResponse.json(
    { nao_lidas: naoLidas.data ?? [], lidas: lidas.data ?? [] },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

// Marca como lida (ids especificos, ou todas as do usuario sem ids).
export async function PATCH(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { ids } = await req.json().catch(() => ({}));
  let q = msgDb().from("notificacoes").update({ lida: true }).eq("user_id", user.id);
  if (Array.isArray(ids) && ids.length) q = q.in("id", ids.slice(0, 100));
  const { error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
