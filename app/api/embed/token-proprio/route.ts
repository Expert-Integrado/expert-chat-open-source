import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getConfig } from "@/lib/config";
import { getPerfil } from "@/lib/perfil";
import { msgDb } from "@/lib/mensageria";
import { assinarTokenContexto } from "@/lib/embed";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// vida do token de auto-restricao (turno maior que o do mint servidor-a-servidor:
// aqui e o proprio usuario escolhendo, sem custo de repetir toda hora)
const EXP_SEGUNDOS = 12 * 3600;

// Seletor de visao (BU, 16/08/2026): auto-cunhagem. SEM mint secret — o token
// so RESTRINGE um usuario JA autenticado (2FA mantido); qualquer logado pode
// se auto-restringir a um contexto do widget, nunca ampliar o proprio escopo.
export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const contexto = typeof body?.contexto === "string" ? body.contexto.trim() : "";
  if (!contexto) {
    return NextResponse.json({ error: "contexto obrigatorio" }, { status: 400 });
  }

  // vinculado a BU (e nao super admin): so cunha token de contexto que esteja
  // no proprio vinculo — nao deixa o usuario se auto-restringir a uma visao
  // fora do que o admin liberou (a restricao de servidor ja bloquearia a
  // leitura, mas travar aqui evita token inutil e da erro claro). Usuario
  // vinculado NAO depende do toggle seletor_visao (mesma decisao de
  // /api/embed/contextos: vinculo e restricao dura, o toggle so governa a
  // auto-restricao opcional de quem nao tem vinculo).
  let vinculadoAoContexto = false;
  const perfil = await getPerfil(user.id);
  if (perfil.papel !== "super_admin") {
    const { data: vinculos } = await msgDb()
      .from("perfil_contextos")
      .select("contexto_id")
      .eq("user_id", user.id);
    if (vinculos?.length) {
      if (!vinculos.some((v) => v.contexto_id === contexto)) {
        return NextResponse.json({ error: "fora das suas BUs" }, { status: 403 });
      }
      vinculadoAoContexto = true;
    }
  }

  if (!vinculadoAoContexto) {
    const cfg = await getConfig();
    if (!cfg.seletor_visao) {
      return NextResponse.json({ error: "seletor de visao desligado" }, { status: 403 });
    }
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

  const token = assinarTokenContexto(contexto, EXP_SEGUNDOS);
  const expira_em = new Date(Date.now() + EXP_SEGUNDOS * 1000).toISOString();
  return NextResponse.json({ token, expira_em });
}
