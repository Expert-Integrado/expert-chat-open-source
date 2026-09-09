import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, permitido } from "@/lib/perfil";
import { msgDb } from "@/lib/mensageria";
import { getConfig, CHAVES_CONFIG, derrubarCacheConfig, validarConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Toggles de automacao do painel — permissao "automacao".
export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!permitido(await getPerfil(user.id), "automacao")) {
    return NextResponse.json({ error: "sem permissao pra configurar automacao" }, { status: 403 });
  }
  return NextResponse.json(await getConfig(), { headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!permitido(await getPerfil(user.id), "automacao")) {
    return NextResponse.json({ error: "sem permissao pra configurar automacao" }, { status: 403 });
  }
  const { chave, valor } = await req.json().catch(() => ({}));
  if (!(CHAVES_CONFIG as string[]).includes(chave)) {
    return NextResponse.json({ error: "chave invalida" }, { status: 400 });
  }
  const valorOk = validarConfig(chave, valor);
  if (valorOk === undefined) {
    return NextResponse.json({ error: "valor invalido pra essa configuracao" }, { status: 400 });
  }
  const { error } = await msgDb()
    .from("config")
    .upsert({ chave, valor: valorOk, updated_at: new Date().toISOString() }, { onConflict: "chave" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  derrubarCacheConfig();
  return NextResponse.json({ ok: true, ...(await getConfig()) });
}
