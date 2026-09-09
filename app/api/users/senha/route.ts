import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { usuarioPorSessao } from "@/lib/auth-server";
import { getPerfil, ehAdmin } from "@/lib/perfil";
import { gerarSenhaTemporaria } from "@/lib/perfil-conta";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// REDEFINIR A SENHA DE OUTRA PESSOA (09/09/2026) — POST {user_id}.
//
// O caminho pra quem esqueceu a senha e o link por e-mail (tela de login,
// "Esqueci minha senha"), mas ele depende de SMTP configurado no projeto de
// auth, e instalacao nova raramente tem. Este e o caminho que nao depende de
// e-mail: o super admin gera uma senha TEMPORARIA, passa pra pessoa por outro
// canal, e ela troca em Meu perfil (que exige a senha atual — a temporaria).
//
// Fail-closed em tres portas: so SESSAO de login (chave de API vazada nao
// redefine senha de ninguem), so super_admin, e a senha nunca e escolhida pelo
// chamador — e gerada aqui e devolvida UMA vez. Mesmo projeto de auth do
// painel (a rota /api/users ja assume isso pra listar as pessoas).
export async function POST(req: NextRequest) {
  const user = await usuarioPorSessao(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  if (!ehAdmin(perfil)) return NextResponse.json({ error: "so super admin redefine senha" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const userId = typeof body?.user_id === "string" ? body.user_id : "";
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return NextResponse.json({ error: "user_id invalido" }, { status: 400 });

  const senha = gerarSenhaTemporaria(randomBytes(16));
  const admin = createClient(process.env.MSG_SUPABASE_URL!, process.env.MSG_SUPABASE_SERVICE_KEY!, {
    auth: { persistSession: false },
    global: { fetch: (u: any, i: any) => fetch(u, { ...i, cache: "no-store" }) },
  });
  const { data, error } = await admin.auth.admin.updateUserById(userId, { password: senha });
  if (error || !data?.user) {
    console.error("redefinir senha falhou", { por: user.email, alvo: userId, erro: error?.message });
    return NextResponse.json({ error: "nao consegui redefinir: a pessoa existe no projeto de login do painel?" }, { status: 502 });
  }
  console.log("senha redefinida", { por: user.email, alvo: data.user.email });
  return NextResponse.json({ ok: true, email: data.user.email, senha_temporaria: senha });
}
