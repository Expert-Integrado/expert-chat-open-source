import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, permitido } from "@/lib/perfil";
import { sincronizarChatGuru } from "@/lib/chatguru-sync";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// Botao "Sincronizar ChatGuru" (canal API oficial) — super admin dispara a
// varredura completa; o cron do banco (pg_cron, 1x/min) chama com o segredo
// proprio e roda o modo enxuto (so conversas com novidade no ChatGuru).
// Desde 25/08/2026 cobre os DOIS aparelhos: oficial (mensagens+notas+atributos)
// e central (SO atributos+notas — mensagens do central chegam pela Z-API).
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const segredo = process.env.CHATGURU_SYNC_SECRET;
  if (segredo && auth === `Bearer ${segredo}`) {
    const resultado = await sincronizarChatGuru(45000, true);
    if (!resultado.ok) return NextResponse.json({ error: resultado.erro, ...resultado }, { status: 502 });
    return NextResponse.json(resultado);
  }

  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!permitido(await getPerfil(user.id), "gerenciar_canais")) {
    return NextResponse.json({ error: "sem permissao pra sincronizar canais" }, { status: 403 });
  }
  const resultado = await sincronizarChatGuru();
  if (!resultado.ok) return NextResponse.json({ error: resultado.erro, ...resultado }, { status: 502 });
  return NextResponse.json(resultado);
}
