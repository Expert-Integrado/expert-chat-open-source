import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { assinarTokenContexto } from "@/lib/embed";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// vida default do token de contexto (turno). O chamador pode pedir mais via
// body.dias (teto 90) — ok porque o token so RESTRINGE um usuario ja logado
// (2FA), nunca autentica sozinho; validade longa serve pro link fixo/favorito.
const EXP_SEGUNDOS = 8 * 3600;
const TETO_DIAS = 90;

// Cunhagem servidor-a-servidor (Bearer EMBED_MINT_SECRET, comparacao em tempo
// constante) do token de contexto que o hospedeiro (portal, eventos, Super
// SDR admin...) acopla no widget via header x-embed-token.
export async function POST(req: NextRequest) {
  const secret = process.env.EMBED_MINT_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "EMBED_MINT_SECRET nao configurado" }, { status: 501 });
  }

  const auth = req.headers.get("authorization") || "";
  const recebido = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7) : "");
  const esperado = Buffer.from(secret);
  const bearerOk = recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
  if (!bearerOk) {
    return NextResponse.json({ error: "bearer invalido" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const contexto = typeof body?.contexto === "string" ? body.contexto.trim() : "";
  if (!contexto) {
    return NextResponse.json({ error: "contexto obrigatorio" }, { status: 400 });
  }

  const { data: row } = await msgDb()
    .from("embed_contextos")
    .select("id")
    .eq("id", contexto)
    .eq("ativo", true)
    .maybeSingle();
  if (!row) {
    return NextResponse.json({ error: "contexto inexistente ou inativo" }, { status: 404 });
  }

  const dias = Number(body?.dias);
  const expSegundos =
    Number.isFinite(dias) && dias >= 1 ? Math.min(Math.floor(dias), TETO_DIAS) * 86400 : EXP_SEGUNDOS;

  const token = assinarTokenContexto(contexto, expSegundos);
  const expira_em = new Date(Date.now() + expSegundos * 1000).toISOString();
  return NextResponse.json({ token, expira_em });
}
