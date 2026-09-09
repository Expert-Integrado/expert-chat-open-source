import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Politica de acesso pro fluxo de login. NAO passa pelo getUser de proposito:
// quem ainda esta no meio do 2FA (token de senha pura) precisa saber se o
// cadastro e obrigatorio — o gate normal devolveria 401 antes disso.
// So valida que o token e de um usuario real e devolve flags nao-sensiveis.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supa = createClient(process.env.NEXT_PUBLIC_AUTH_URL!, process.env.NEXT_PUBLIC_AUTH_ANON_KEY!, {
    auth: { persistSession: false },
    global: { fetch: (u: any, i: any) => fetch(u, { ...i, cache: "no-store" }) },
  });
  const { data, error } = await supa.auth.getUser(token);
  if (error || !data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { exigir_2fa } = await getConfig();
  const tem_fator = ((data.user as any).factors ?? []).some((f: any) => f.status === "verified");
  return NextResponse.json(
    { exigir_2fa, tem_fator },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
