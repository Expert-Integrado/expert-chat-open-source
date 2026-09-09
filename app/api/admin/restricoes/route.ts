import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { ehAdmin, getPerfil, permitido, restricaoVazia } from "@/lib/perfil";
import { editaPropriaAutorizacao } from "@/lib/permissoes";
import { msgDb } from "@/lib/mensageria";
import {
  derrubarCacheAcesso,
  erroDeSchemaAusente,
  funisOrfaos,
  ligarPoliticaDeAcesso,
  validarRestricao,
} from "@/lib/acesso";
import { canaisAtivos, canalPorId, canalPublico } from "@/lib/canais";
import { carregarCatalogo } from "@/lib/funis-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// VISIBILIDADE POR FUNIL E POR NUMERO (card 86ak85zm4) — permissao
// `gerenciar_visibilidade`, a mesma da ACL por conversa. Nao e
// `gerenciar_usuarios` de proposito: quem define quem ve o que nao precisa
// poder mexer em papel e senha de ninguem.
//
//   GET    /api/admin/restricoes              -> restricoes + catalogo (canais e funis)
//   POST   /api/admin/restricoes              -> grava a restricao de um usuario
//   DELETE /api/admin/restricoes?user_id=...  -> remove (volta ao modelo de escopo/ACL)
//
// Lista VAZIA numa dimensao = dimensao sem restricao. SEM linha = comportamento
// anterior a esta feature, que e o de toda instalacao existente.
//
// A ENFORCACAO mora no predicado (`conversaVisivel` em lib/visibilidade.ts) e e
// aplicada por `podeVerConversa` e pelas rotas de lista (chats, busca, funis,
// forward). Esta rota so cadastra.

const AVISO_SEM_TABELA =
  "restricao por funil/canal indisponivel nesta instalacao — rode a migration 0019_seguranca_conta.sql";

// deteccao unica (lib/acesso.ts): ver a nota em /api/admin/janela
const semTabela = erroDeSchemaAusente;

// NINGUEM EDITA A PROPRIA RESTRICAO (achado de revisao): sem isto, quem tem
// `gerenciar_visibilidade` e um recorte de funil apenas apagaria o proprio
// recorte. Mesma funcao canonica que fecha o furo nas permissoes.
//
// Esta metade fica SEPARADA da porta de proposito: no POST o alvo vem do CORPO, e
// o corpo so pode ser lido DEPOIS da identidade (ver a nota em `POST`). Entao a
// porta roda sem alvo e esta checagem roda logo depois, com o alvo na mao.
function barraAutoEdicao(perfil: Awaited<ReturnType<typeof getPerfil>>, atorId: string, alvoId: string) {
  if (!editaPropriaAutorizacao({ atorEhAdmin: ehAdmin(perfil), atorId, alvoId, mexeEmAutorizacao: true })) {
    return null;
  }
  return NextResponse.json(
    { error: "voce nao pode mexer na sua propria restricao de visibilidade — peca a um super admin" },
    { status: 403 }
  );
}

/**
 * Identidade + permissao. NAO le o corpo e NAO depende dele — e por isso que o
 * POST consegue chama-la ANTES do `req.json()` (GRAVE D1: corpo consumido nao
 * clona, e o escopo da chave de API fica inerte).
 */
async function autorizado(req: NextRequest, alvoId?: string) {
  const user = await getUser(req);
  if (!user) return { erro: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const perfil = await getPerfil(user.id);
  if (!permitido(perfil, "gerenciar_visibilidade")) {
    return { erro: NextResponse.json({ error: "sem permissao pra definir visibilidade" }, { status: 403 }) };
  }
  const proprio = alvoId ? barraAutoEdicao(perfil, user.id, alvoId) : null;
  if (proprio) return { erro: proprio };
  return { user, perfil };
}

export async function GET(req: NextRequest) {
  const a = await autorizado(req);
  if (a.erro) return a.erro;
  // catalogo pra tela montar as caixas sem inventar id: canais ativos do
  // registro (lib/canais.ts) e funis ativos do banco. Sem a migration 0009 o
  // catalogo de funis vem vazio com aviso — nunca 500.
  const cat = await carregarCatalogo();
  const { data, error } = await msgDb()
    .from("usuario_restricoes")
    .select("user_id,canais,funis,sem_funil,definido_por_nome,updated_at");
  const canais = canaisAtivos().map(canalPublico);
  const funis = cat.ok ? cat.catalogo.map((f) => ({ id: f.id, nome: f.nome })) : [];
  if (error) {
    if (semTabela(error)) {
      return NextResponse.json(
        { restricoes: [], disponivel: false, aviso: AVISO_SEM_TABELA, canais, funis },
        { headers: { "Cache-Control": "no-store, max-age=0" } }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // FUNIL APAGADO: id orfao e ignorado na leitura (lib/acesso.ts) pra nao
  // trancar a pessoa por causa de cadastro apagado — mas alguem tem que ficar
  // sabendo, senao a restricao vai virando fantasma em silencio.
  const orfaos = await funisOrfaos().catch(() => new Map<string, string[]>());
  const restricoes = (data ?? []).map((r: any) => ({
    user_id: r.user_id,
    ...validarRestricao(r),
    funis_orfaos: orfaos.get(r.user_id) ?? [],
    definido_por_nome: r.definido_por_nome || null,
    updated_at: r.updated_at || null,
  }));
  const comOrfao = restricoes.filter((r) => r.funis_orfaos.length);
  return NextResponse.json(
    {
      restricoes,
      disponivel: true,
      canais,
      funis,
      aviso_funis: cat.ok ? null : cat.aviso,
      aviso_orfaos: comOrfao.length
        ? `${comOrfao.length} restricao(oes) apontam pra funil que nao existe mais — o id apagado e IGNORADO (a pessoa nao fica sem ver nada), mas conserte o cadastro`
        : null,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  // A IDENTIDADE VEM ANTES DO CORPO (GRAVE D1, medido de novo na 2a re-revisao:
  // esta rota violava). `getUser` CLONA o pedido pra descobrir de que canal ele
  // fala e comparar com o escopo da chave de API; corpo ja consumido nao clona, o
  // clone lanca "Body is unusable", o catch zera o canal e a comparacao
  // simplesmente PARA DE ACONTECER — sem erro, sem log, sem teste vermelho.
  //
  // O alvo (`user_id`) vem do corpo, entao a porta roda em duas partes: aqui a
  // identidade e a permissao, e `barraAutoEdicao` logo abaixo, com o alvo na mao.
  // Efeito colateral declarado: pedido anonimo sem `user_id` agora leva 401 em vez
  // de 400 — validar corpo antes de saber quem fala era o proprio defeito.
  const a = await autorizado(req);
  if (a.erro) return a.erro;
  const user = a.user!;
  const body = await req.json().catch(() => ({}));
  const userId = typeof body?.user_id === "string" ? body.user_id.trim() : "";
  if (!userId) return NextResponse.json({ error: "user_id obrigatorio" }, { status: 400 });
  const proprio = barraAutoEdicao(a.perfil!, user.id, userId);
  if (proprio) return proprio;

  const restricao = validarRestricao(body);

  // ID INVENTADO E RECUSADO. Sem isto, um canal digitado errado ("centrall")
  // vira restricao que nao casa com nada e a pessoa fica sem ver conversa
  // nenhuma — fail-closed silencioso, o pior tipo: parece bug do painel.
  const canalRuim = restricao.canais.filter((c) => !canalPorId(c));
  if (canalRuim.length) {
    return NextResponse.json({ error: `canal inexistente: ${canalRuim.join(", ")}` }, { status: 400 });
  }
  if (restricao.funis.length) {
    const cat = await carregarCatalogo({ incluirArquivados: true });
    if (!cat.ok) return NextResponse.json({ error: cat.aviso }, { status: 400 });
    const existem = new Set(cat.catalogo.map((f) => f.id));
    const ruins = restricao.funis.filter((f) => !existem.has(f));
    if (ruins.length) {
      return NextResponse.json({ error: `funil inexistente: ${ruins.join(", ")}` }, { status: 400 });
    }
  }

  // SUPER ADMIN nao e restringido (camada 1 de `conversaVisivel`). Gravar aqui
  // seria regra inerte na tela.
  const alvo = await msgDb().from("perfis").select("papel").eq("user_id", userId).maybeSingle();
  if (!restricaoVazia(restricao) && alvo.data?.papel === "super_admin") {
    return NextResponse.json(
      { error: "super admin enxerga a conta inteira por definicao — mude o papel antes, se e isso que voce quer" },
      { status: 400 }
    );
  }

  const { error } = await msgDb().from("usuario_restricoes").upsert(
    {
      user_id: userId,
      canais: restricao.canais,
      funis: restricao.funis,
      sem_funil: restricao.sem_funil,
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
  // primeira restricao desta instalacao LIGA a politica de acesso (o marcador
  // `politica_acesso_ativa`): sem ele, as rotas de lista nem consultam a tabela.
  const avisoPolitica = restricaoVazia(restricao) ? null : await ligarPoliticaDeAcesso();
  return NextResponse.json({ ok: true, restricao, aviso: avisoPolitica ?? undefined });
}

export async function DELETE(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("user_id");
  if (!userId) return NextResponse.json({ error: "user_id obrigatorio" }, { status: 400 });
  const a = await autorizado(req, userId);
  if (a.erro) return a.erro;
  const { error } = await msgDb().from("usuario_restricoes").delete().eq("user_id", userId);
  if (error) {
    if (semTabela(error)) return NextResponse.json({ error: AVISO_SEM_TABELA }, { status: 400 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  derrubarCacheAcesso();
  return NextResponse.json({ ok: true, removida: userId });
}
