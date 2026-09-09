import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { ehAdmin, getPerfil, permitido } from "@/lib/perfil";
import { editaPropriaAutorizacao } from "@/lib/permissoes";
import { msgDb } from "@/lib/mensageria";
import { derrubarCacheAcesso, erroDeSchemaAusente, ligarPoliticaDeAcesso } from "@/lib/acesso";
import { fusoDaConfig, getConfig } from "@/lib/config";
import {
  MAX_PERIODOS_POR_DIA,
  janelaBloqueiaSempre,
  resumoJanela,
  validarJanela,
} from "@/lib/janela-acesso";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// JANELA DE ACESSO por usuario (card 86ak858x0) — permissao `gerenciar_usuarios`.
//
//   GET    /api/admin/janela              -> todas as janelas + o fuso vigente
//   POST   /api/admin/janela              -> grava a janela de um usuario
//   DELETE /api/admin/janela?user_id=...  -> remove a janela (volta a entrar sempre)
//
// A ENFORCACAO nao mora aqui: mora na porta (`lib/auth-server.ts`), atravessada
// por TODA rota — fora da janela, a sessao ja aberta para de funcionar no mesmo
// minuto. Esta rota so cadastra.
//
// Sem a migration 0019 a tabela nao existe: GET responde lista vazia com
// `disponivel:false` (nunca 500) e a escrita devolve 400 com a frase certa, em
// vez de fingir que salvou. Padrao da rota de macros antes da 0008.

const AVISO_SEM_TABELA =
  "janela de acesso indisponivel nesta instalacao — rode a migration 0019_seguranca_conta.sql";

// deteccao unica (lib/acesso.ts): codigo do Postgres E do PostgREST, mais a
// mensagem de "schema cache". Duplicar a lista aqui foi o que a revisao pegou —
// PGRST205 e o codigo REAL de "migration nao rodou" numa instalacao Supabase.
const semTabela = erroDeSchemaAusente;

/**
 * NINGUEM EDITA A PROPRIA JANELA (achado de revisao). Mesma classe de furo que
 * `editaPropriaAutorizacao` fecha nas permissoes: quem tem `gerenciar_usuarios`
 * e uma janela apertada simplesmente apagaria a propria janela. Reusa a funcao
 * canonica de lib/permissoes.ts em vez de reimplementar a regra — super admin
 * segue isento (a janela nem o alcanca).
 */
// Recebe o usuario e o perfil JA RESOLVIDOS (correcao da 2a revisao): a versao
// anterior chamava `getUser` + `getPerfil` de novo aqui, e cada POST/DELETE
// atravessava a porta DUAS vezes — validacao de token no auth, leitura de
// perfis, politica de acesso, tudo em dobro, no caminho de quem so queria salvar
// um formulario.
function autoEdicao(
  user: { id: string },
  perfil: Parameters<typeof ehAdmin>[0],
  alvoId: string
) {
  if (
    editaPropriaAutorizacao({
      atorEhAdmin: ehAdmin(perfil),
      atorId: user.id,
      alvoId,
      mexeEmAutorizacao: true,
    })
  ) {
    return NextResponse.json(
      { error: "voce nao pode mexer na sua propria janela de acesso — peca a um super admin" },
      { status: 403 }
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!permitido(await getPerfil(user.id), "gerenciar_usuarios")) {
    return NextResponse.json({ error: "sem permissao pra gerenciar usuarios" }, { status: 403 });
  }
  const cfg = await getConfig();
  const { data, error } = await msgDb()
    .from("acesso_janelas")
    .select("user_id,ativo,dias,definido_por_nome,updated_at");
  if (error) {
    if (semTabela(error)) {
      return NextResponse.json(
        { janelas: [], disponivel: false, aviso: AVISO_SEM_TABELA, fuso: fusoDaConfig(cfg), max_periodos: MAX_PERIODOS_POR_DIA },
        { headers: { "Cache-Control": "no-store, max-age=0" } }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const janelas = (data ?? []).map((r: any) => {
    const j = validarJanela({ ativo: r.ativo, dias: r.dias });
    return {
      user_id: r.user_id,
      ativo: j.ativo,
      dias: j.dias,
      resumo: resumoJanela(j),
      definido_por_nome: r.definido_por_nome || null,
      updated_at: r.updated_at || null,
    };
  });
  return NextResponse.json(
    {
      janelas,
      disponivel: true,
      // a hora da janela vale NESTE fuso; a tela precisa dizer isso ao lado dos
      // campos, senao quem esta em outro fuso configura o turno errado
      fuso: fusoDaConfig(cfg),
      max_periodos: MAX_PERIODOS_POR_DIA,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfilAtor = await getPerfil(user.id);
  if (!permitido(perfilAtor, "gerenciar_usuarios")) {
    return NextResponse.json({ error: "sem permissao pra gerenciar usuarios" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const userId = typeof body?.user_id === "string" ? body.user_id.trim() : "";
  if (!userId) return NextResponse.json({ error: "user_id obrigatorio" }, { status: 400 });
  const recusa = autoEdicao(user, perfilAtor, userId);
  if (recusa) return recusa;

  const janela = validarJanela(body);
  // LOCKOUT POR ACIDENTE DE UI: janela ligada sem nenhum dia barra a pessoa 24/7.
  // O predicado trata isso como fail-closed de proposito (quem grava assim esta
  // dizendo "nao entra"), mas ninguem deve cair nesse estado por ter esquecido de
  // marcar os dias — entao a rota recusa e explica.
  if (janelaBloqueiaSempre(janela)) {
    return NextResponse.json(
      { error: "marque ao menos um dia com horario, ou desligue a janela (ativo:false)" },
      { status: 400 }
    );
  }

  const alvo = await msgDb().from("perfis").select("papel,ativo").eq("user_id", userId).maybeSingle();
  if (alvo.error) return NextResponse.json({ error: alvo.error.message }, { status: 500 });
  // SUPER ADMIN nao e barrado pela janela (lib/acesso.ts, e e o que garante
  // caminho de volta quando a configuracao esta errada). Gravar janela pra ele
  // seria regra INERTE na tela — recusa em vez de mentir.
  if (janela.ativo && alvo.data?.papel === "super_admin") {
    return NextResponse.json(
      { error: "super admin nao e barrado por janela de acesso — mude o papel antes, se e isso que voce quer" },
      { status: 400 }
    );
  }

  const { error } = await msgDb().from("acesso_janelas").upsert(
    {
      user_id: userId,
      ativo: janela.ativo,
      dias: janela.dias,
      definido_por_id: user.id,
      definido_por_nome: user.nome,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) {
    if (semTabela(error)) return NextResponse.json({ error: AVISO_SEM_TABELA }, { status: 400 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  derrubarCacheAcesso();
  // primeira janela desta instalacao LIGA a politica de acesso (ver
  // `politica_acesso_ativa` em lib/config.ts): sem o marcador, a porta nem
  // consulta a tabela — e a janela recem-gravada nao pegaria.
  const avisoPolitica = janela.ativo ? await ligarPoliticaDeAcesso() : null;
  return NextResponse.json({ ok: true, resumo: resumoJanela(janela), aviso: avisoPolitica ?? undefined });
}

export async function DELETE(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfilAtor = await getPerfil(user.id);
  if (!permitido(perfilAtor, "gerenciar_usuarios")) {
    return NextResponse.json({ error: "sem permissao pra gerenciar usuarios" }, { status: 403 });
  }
  const userId = req.nextUrl.searchParams.get("user_id");
  if (!userId) return NextResponse.json({ error: "user_id obrigatorio" }, { status: 400 });
  const recusa = autoEdicao(user, perfilAtor, userId);
  if (recusa) return recusa;
  const { error } = await msgDb().from("acesso_janelas").delete().eq("user_id", userId);
  if (error) {
    if (semTabela(error)) return NextResponse.json({ error: AVISO_SEM_TABELA }, { status: 400 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  derrubarCacheAcesso();
  return NextResponse.json({ ok: true, removida: userId });
}
