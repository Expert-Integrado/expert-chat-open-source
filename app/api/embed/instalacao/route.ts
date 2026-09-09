import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil } from "@/lib/perfil";
import { msgDb } from "@/lib/mensageria";
import { assinarTokenContexto } from "@/lib/embed";
import extensaoOficial from "@/lib/extensao-oficial.json";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Tela "Instalar widget" (Eric 02/09/2026, card 86akaap3m): o admin escolhe a forma de
// exibicao e o contexto e recebe o codigo pronto pra colar no software hospedeiro. O
// front nao tem como saber tres coisas que so o servidor ve — esta rota entrega as tres:
//   1. quais origens JA podem emoldurar o /widget (EMBED_FRAME_ANCESTORS e env de BUILD do
//      next.config.mjs: mudar exige redeploy, e a tela precisa dizer isso com todas as letras);
//   2. se a cunhagem de token esta configurada (EMBED_MINT_SECRET / EMBED_JWT_SECRET presentes,
//      nunca os valores);
//   3. a lista de contextos ATIVOS — independente do toggle `seletor_visao`, porque aqui e o
//      admin instalando o widget em outro sistema, nao um usuario se auto-restringindo.
// So super_admin: instalar o painel em outro software e configuracao da INSTALACAO.

const TETO_DIAS = 90;

async function superAdmin(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return { erro: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const perfil = await getPerfil(user.id);
  if (perfil.papel !== "super_admin") {
    return { erro: NextResponse.json({ error: "so super admin instala o widget" }, { status: 403 }) };
  }
  return { user };
}

// A extensao oficial do Chrome entra sempre: o next.config.mjs a inclui na CSP por padrao
// (mesma fonte, lib/extensao-oficial.json), entao a tela tem que mostrar a mesma lista.
function origensLiberadas(): string[] {
  const daEnv = (process.env.EMBED_FRAME_ANCESTORS || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...daEnv, extensaoOficial.origem])];
}

export async function GET(req: NextRequest) {
  const g = await superAdmin(req);
  if ("erro" in g) return g.erro;

  const { data: contextos } = await msgDb()
    .from("embed_contextos")
    .select("id,nome,filtro")
    .eq("ativo", true)
    .order("nome");

  // URL publica do painel = a origem que atendeu este request (atras do proxy da Vercel o
  // host certo vem em x-forwarded-host). E o que o snippet vai apontar.
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const painel_url = host ? `${proto}://${host}` : "";

  return NextResponse.json(
    {
      painel_url,
      origens_liberadas: origensLiberadas(),
      mint_configurado: !!process.env.EMBED_MINT_SECRET,
      jwt_configurado: !!process.env.EMBED_JWT_SECRET,
      teto_dias: TETO_DIAS,
      contextos: (contextos ?? []).map((c) => ({
        id: c.id,
        nome: c.nome,
        filtro_tipo: (c.filtro as { tipo?: string } | null)?.tipo ?? null,
      })),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

// Cunha um token de contexto de LONGA duracao pra colar no snippet (link fixo do hospedeiro
// que nao tem backend pra cunhar por sessao, favorito, extensao do Chrome). Seguro porque o
// token so RESTRINGE um usuario ja logado com 2FA — vazou = ve MENOS, nunca mais. O segredo
// de mint (EMBED_MINT_SECRET) nunca sai do servidor: quem autoriza aqui e a sessao do admin.
export async function POST(req: NextRequest) {
  const g = await superAdmin(req);
  if ("erro" in g) return g.erro;
  if (!process.env.EMBED_JWT_SECRET) {
    return NextResponse.json({ error: "EMBED_JWT_SECRET nao configurado nesta instalacao" }, { status: 501 });
  }
  const body = await req.json().catch(() => ({}));
  const contexto = typeof body?.contexto === "string" ? body.contexto.trim() : "";
  if (!contexto) return NextResponse.json({ error: "contexto obrigatorio" }, { status: 400 });

  const { data: row } = await msgDb()
    .from("embed_contextos")
    .select("id")
    .eq("id", contexto)
    .eq("ativo", true)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "contexto inexistente ou inativo" }, { status: 404 });

  const dias = Number(body?.dias);
  const diasOk = Number.isFinite(dias) && dias >= 1 ? Math.min(Math.floor(dias), TETO_DIAS) : TETO_DIAS;
  const token = assinarTokenContexto(contexto, diasOk * 86400);
  const expira_em = new Date(Date.now() + diasOk * 86400 * 1000).toISOString();
  return NextResponse.json({ token, expira_em, dias: diasOk });
}
