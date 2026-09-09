import { NextRequest, NextResponse } from "next/server";
import { usuarioPorSessao } from "@/lib/auth-server";
import { getPerfil, permitido, ehAdmin, derrubarCachePapeis } from "@/lib/perfil";
import { msgDb } from "@/lib/mensageria";
import {
  PERMISSOES,
  DESCRICAO_PERMISSAO,
  bloqueiaApagarPapel,
  bloqueiaDelegacao,
  validarPermissoes,
  type Permissao,
} from "@/lib/permissoes";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Papeis nomeados (perfis de permissao) — card 86ak858uu.
//
// A ATRIBUICAO de papel a uma pessoa mora em /api/admin/usuarios (e na tela de
// usuarios que ja existe). Aqui e o cadastro dos papeis em si: criar, editar o
// conjunto de permissoes, renomear, desativar.
//
// v1 e API-first de proposito: a tela de admin so ATRIBUI papel, e as quatro
// sementes (Administrador, Supervisor, Atendente, Somente leitura) ja vem na
// migration 0010. Um construtor visual de papel e tela nova e ainda nao foi
// validado com o Eric — ver docs/permissoes.md, secao "Pendencias".
//
// AUTH: `usuarioPorSessao`, NUNCA `getUser` — chave `x-api-key` nao gerencia
// papeis. Mesma razao da gestao de chaves (lib/auth-server.ts): quem redefine o
// que um papel pode redefine a autorizacao da instalacao inteira, e uma chave
// vazada nao pode fazer isso. Difere de /api/admin/usuarios de proposito, que
// segue aceitando chave porque o runbook de frota atribui papel por script.
//
// TETO DE DELEGACAO: quem nao e super admin so mexe em papel cujas permissoes
// (as atuais E as novas) cabem no proprio conjunto efetivo, e nunca no papel que
// ele mesmo usa. Sem isso `gerenciar_usuarios` seria admin total.

function indisponivel() {
  return NextResponse.json(
    { error: "papeis nomeados indisponiveis — rode a migration 0010_papeis.sql" },
    { status: 400 }
  );
}

export async function GET(req: NextRequest) {
  const user = await usuarioPorSessao(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!permitido(await getPerfil(user.id), "gerenciar_usuarios")) {
    return NextResponse.json({ error: "sem permissao pra gerenciar usuarios" }, { status: 403 });
  }
  const { data, error } = await msgDb()
    .from("papeis")
    .select("id,nome,descricao,permissoes,ativo,criado_em")
    .order("nome");
  if (error) return indisponivel();

  // quantas pessoas usam cada papel — sem isso ninguem desativa um papel com
  // seguranca (desativar = tirar acesso de todo mundo que estava nele)
  const { data: usos } = await msgDb().from("perfis").select("papel_id").not("papel_id", "is", null);
  const conta = new Map<string, number>();
  for (const u of usos ?? []) conta.set(u.papel_id as string, (conta.get(u.papel_id as string) || 0) + 1);

  return NextResponse.json(
    {
      papeis: (data ?? []).map((p: any) => ({
        id: p.id,
        nome: p.nome,
        descricao: p.descricao || "",
        ativo: p.ativo !== false,
        permissoes: validarPermissoes(p.permissoes),
        usuarios: conta.get(p.id) || 0,
      })),
      permissoes: PERMISSOES.map((p) => ({ id: p, descricao: DESCRICAO_PERMISSAO[p] })),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

// Cria (sem id) ou edita (com id). Campo ausente na edicao mantem o valor atual.
export async function POST(req: NextRequest) {
  const user = await usuarioPorSessao(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfilAtor = await getPerfil(user.id);
  if (!permitido(perfilAtor, "gerenciar_usuarios")) {
    return NextResponse.json({ error: "sem permissao pra gerenciar usuarios" }, { status: 403 });
  }
  const atorEhAdmin = ehAdmin(perfilAtor);
  const { id, nome, descricao, permissoes, ativo } = await req.json().catch(() => ({}));

  // TETO 1/2 — ninguem edita o papel que ele mesmo usa (seria auto-promocao
  // com um passo a mais), nem um papel mais poderoso que o proprio conjunto.
  if (id && !atorEhAdmin) {
    if (perfilAtor.papel_id && String(id) === perfilAtor.papel_id) {
      return NextResponse.json(
        { error: "voce nao pode editar o proprio perfil de permissoes — peca a um super admin" },
        { status: 403 }
      );
    }
    const { data: atual, error: erroAtual } = await msgDb()
      .from("papeis")
      .select("permissoes")
      .eq("id", String(id))
      .maybeSingle();
    if (erroAtual) return indisponivel();
    if (!atual) return NextResponse.json({ error: "papel inexistente" }, { status: 404 });
    const foraAtual = bloqueiaDelegacao(
      atorEhAdmin,
      perfilAtor.permissoes,
      validarPermissoes((atual as any).permissoes)
    );
    if (foraAtual.length) {
      return NextResponse.json(
        { error: `esse papel tem permissoes que voce nao possui: ${foraAtual.join(", ")}` },
        { status: 403 }
      );
    }
  }

  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (nome !== undefined) {
    const n = String(nome || "").trim().slice(0, 60);
    if (!n) return NextResponse.json({ error: "nome obrigatorio" }, { status: 400 });
    patch.nome = n;
  }
  if (descricao !== undefined) patch.descricao = String(descricao || "").trim().slice(0, 200) || null;
  if (ativo !== undefined) {
    if (typeof ativo !== "boolean") return NextResponse.json({ error: "ativo precisa ser booleano" }, { status: 400 });
    patch.ativo = ativo;
  }
  if (permissoes !== undefined) {
    if (!Array.isArray(permissoes)) {
      return NextResponse.json({ error: "permissoes precisa ser uma lista" }, { status: 400 });
    }
    // recusa permissao inventada em vez de ignorar: aqui e cadastro humano, e
    // engolir um nome errado calado deixaria o admin achando que configurou
    const desconhecidas = permissoes.filter((p: unknown) => !(PERMISSOES as readonly unknown[]).includes(p));
    if (desconhecidas.length) {
      return NextResponse.json(
        { error: `permissao inexistente: ${desconhecidas.join(", ")}` },
        { status: 400 }
      );
    }
    patch.permissoes = validarPermissoes(permissoes);
    // TETO 2/2 — nao da pra colocar num papel permissao que o ator nao tem.
    {
      const fora = bloqueiaDelegacao(atorEhAdmin, perfilAtor.permissoes, patch.permissoes as Permissao[]);
      if (fora.length) {
        return NextResponse.json(
          { error: `voce nao tem essas permissoes pra conceder: ${fora.join(", ")}` },
          { status: 403 }
        );
      }
    }
  }

  if (!id) {
    if (!patch.nome) return NextResponse.json({ error: "nome obrigatorio" }, { status: 400 });
    if (patch.permissoes === undefined) patch.permissoes = [];
    const { data, error } = await msgDb().from("papeis").insert(patch).select("id").single();
    if (error) {
      if (String(error.code) === "23505") {
        return NextResponse.json({ error: "ja existe um papel com esse nome" }, { status: 400 });
      }
      return indisponivel();
    }
    derrubarCachePapeis();
    return NextResponse.json({ ok: true, id: data.id });
  }

  const { error } = await msgDb().from("papeis").update(patch).eq("id", String(id));
  if (error) {
    if (String(error.code) === "23505") {
      return NextResponse.json({ error: "ja existe um papel com esse nome" }, { status: 400 });
    }
    return indisponivel();
  }
  derrubarCachePapeis();
  return NextResponse.json({ ok: true });
}

// Apagar devolve as pessoas ao comportamento embutido (papel_id vira null pelo
// ON DELETE SET NULL da 0010) — nunca as deixa sem autorizacao definida.
// A rota avisa quantas pessoas serao afetadas.
//
// APAGAR E SO DO SUPER ADMIN (fechado 31/08, 3a revisao). Apagar nao e revogar:
// e a unica operacao de papel que AFROUXA autorizacao, entao o teto por
// permissoes do papel — que serve pra editar — nao a torna segura. Dois ataques
// que o teto NAO pegava: apagar o papel "Somente leitura" (permissoes vazias,
// cabem em qualquer teto) promove ao embutido `normal` todo mundo que estava
// nele; e apagar o PROPRIO papel devolve ao ator o embutido MAIS a visao total,
// porque some o teto de escopo e o `escopo_visao=todas` legado da coluna volta
// a valer. Quem tem gerenciar_usuarios e nao e super admin tira acesso com
// `ativo:false`, que e fail-closed.
export async function DELETE(req: NextRequest) {
  const user = await usuarioPorSessao(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfilAtor = await getPerfil(user.id);
  if (!permitido(perfilAtor, "gerenciar_usuarios")) {
    return NextResponse.json({ error: "sem permissao pra gerenciar usuarios" }, { status: 403 });
  }
  if (bloqueiaApagarPapel(ehAdmin(perfilAtor))) {
    return NextResponse.json(
      { error: "somente super admin apaga papel — pra tirar acesso, desative o papel (ativo:false)" },
      { status: 403 }
    );
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id obrigatorio" }, { status: 400 });

  const { data: usos, error: erroUsos } = await msgDb().from("perfis").select("user_id").eq("papel_id", id);
  if (erroUsos) return indisponivel();
  const afetados = (usos ?? []).length;
  if (afetados && req.nextUrl.searchParams.get("confirmar") !== "1") {
    return NextResponse.json(
      {
        error: `${afetados} usuario(s) usam esse papel e voltariam ao padrao do sistema. Repita com confirmar=1, ou desative o papel em vez de apagar.`,
        usuarios: afetados,
      },
      { status: 409 }
    );
  }
  const { error } = await msgDb().from("papeis").delete().eq("id", id);
  if (error) return indisponivel();
  derrubarCachePapeis();
  return NextResponse.json({ ok: true, usuarios_afetados: afetados });
}
