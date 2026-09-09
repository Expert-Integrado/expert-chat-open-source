import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireUser } from "@/lib/auth-server";
import { idsInativos, fotosDeUsuarios } from "@/lib/perfil";
import { msgDb } from "@/lib/mensageria";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Quem pode ser responsavel por uma conversa: PESSOAS (contas do auth
// compartilhado) e DEPARTAMENTOS (os "grupos" do ChatGuru, tabela propria).
export async function GET(req: NextRequest) {
  if (!(await requireUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const admin = createClient(
    process.env.MSG_SUPABASE_URL!,
    process.env.MSG_SUPABASE_SERVICE_KEY!,
    { auth: { persistSession: false }, global: { fetch: (u: any, i: any) => fetch(u, { ...i, cache: "no-store" }) } }
  );

  const [lista, deps, inativos, fotos] = await Promise.all([
    admin.auth.admin.listUsers({ page: 1, perPage: 200 }),
    msgDb().from("departamentos").select("id,nome").eq("ativo", true).order("nome"),
    idsInativos(),
    // foto do atendente (Meu perfil): mapa vazio se a migration 0011 nao rodou
    fotosDeUsuarios(),
  ]);
  if (lista.error) return NextResponse.json({ error: lista.error.message }, { status: 500 });

  // so id, nome e foto: o painel nao precisa do e-mail de ninguem pra atribuir responsavel
  const users = (lista.data?.users || [])
    .filter((u) => u.email && !u.email.startsWith("teste-painel-") && !inativos.has(u.id))
    .map((u) => ({
      id: u.id,
      nome:
        (u.user_metadata?.nome as string) ||
          (u.user_metadata?.name as string) ||
        (u.user_metadata?.full_name as string) ||
        u.email!.split("@")[0],
      foto_url: fotos[u.id] || null,
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome));

  return NextResponse.json(
    { users, departamentos: deps.data ?? [] },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
