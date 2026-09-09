import { NextRequest, NextResponse } from "next/server";
import { getUser, usuarioPorSessao } from "@/lib/auth-server";
import { getPerfil, contaDoUsuario } from "@/lib/perfil";
import { msgDb } from "@/lib/mensageria";
import {
  mesclarPreferencias,
  motivoRecusaDeGravacao,
  sanitizarAssinaturaNome,
} from "@/lib/perfil-conta";
import { getModulos } from "@/lib/modulos";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Perfil do proprio usuario: papel, escopo, preferencias e departamentos (N:N).
export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // MODULOS da instalacao viajam junto (revisao de interface, 03/09/2026): a tela
  // deixa de DESCOBRIR por 403 que a automacao esta desligada (eram 2 recusas por
  // sessao no console) e passa a SABER antes de bater na rota. Leitura de flag,
  // nao segredo: o mapa so diz o que a instalacao ligou — as rotas seguem
  // recusando com 403 quem chamar modulo desligado.
  const [perfil, conta, modulos] = await Promise.all([getPerfil(user.id), contaDoUsuario(user.id), getModulos()]);
  const db = msgDb();
  const { data: vinculos } = await db
    .from("departamento_membros")
    .select("departamento_id")
    .eq("user_id", user.id);
  let departamentos: string[] = [];
  if (vinculos?.length) {
    const { data: deps } = await db
      .from("departamentos")
      .select("nome")
      .in("id", vinculos.map((v) => v.departamento_id));
    departamentos = (deps ?? []).map((d) => d.nome).sort();
  }
  return NextResponse.json(
    {
      id: user.id,
      nome: user.nome,
      email: user.email,
      ...perfil,
      // PERMISSOES EFETIVAS pra tela (Frente M, 31/08/2026). O spread acima
      // manda `permissoes` como Set, e Set no JSON vira `{}` — ou seja, a tela
      // nunca teve como refletir a permissao NOMEADA e adivinhava pelo papel
      // (a divida declarada no CLAUDE.md). Aqui vai a lista de verdade.
      // NAO e afrouxamento: o servidor segue sendo a fonte da verdade (403 na
      // rota); isto so para a tela de MENTIR pra quem tem papel nomeado.
      permissoes: Array.from(perfil.permissoes),
      modulos,
      departamentos,
      foto_url: conta.foto_url,
      preferencias: conta.preferencias,
      assinatura_ativa: conta.assinatura_ativa,
      assinatura_nome: conta.assinatura_nome,
      // false = migration 0011 ainda nao rodou nesta instalacao
      perfil_conta_disponivel: conta.disponivel,
      // true = nao consegui LER o perfil agora: o que veio acima e default, nao
      // o gravado — a tela avisa e a escrita fica recusada ate a leitura voltar
      perfil_conta_erro: conta.erroLeitura,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

// So preferencias PROPRIAS: tema, avisos (som/desktop) e a assinatura das
// mensagens. Papel/escopo/ativo NAO entram aqui de proposito — quem muda
// permissao e o super admin, em /api/admin/usuarios. A lista de colunas
// gravadas e uma whitelist explicita: campo que chegar fora dela e ignorado.
//
// Identidade SO por sessao de login (nunca x-api-key), igual senha e foto:
// chave de agente nao mexe na preferencia nem na assinatura do dono.
export async function PATCH(req: NextRequest) {
  const user = await usuarioPorSessao(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { tema, preferencias, assinatura_ativa, assinatura_nome } = body ?? {};

  const patch: Record<string, unknown> = { user_id: user.id, nome: user.nome, updated_at: new Date().toISOString() };
  let mexeuEmAlgo = false;

  if (tema !== undefined) {
    if (!["claro", "escuro"].includes(tema)) {
      return NextResponse.json({ error: "tema invalido" }, { status: 400 });
    }
    patch.tema = tema;
    mexeuEmAlgo = true;
  }

  const querConta = preferencias !== undefined || assinatura_ativa !== undefined || assinatura_nome !== undefined;
  if (querConta) {
    const conta = await contaDoUsuario(user.id);
    const recusa = motivoRecusaDeGravacao(conta);
    // Leitura falhou: o `conta` em maos e DEFAULT, nao o gravado. Mesclar patch
    // sobre default religaria em silencio o que a pessoa tinha desligado —
    // entao NADA e gravado, nem a assinatura, e a tela diz por que.
    if (conta.erroLeitura && recusa) return NextResponse.json({ error: recusa }, { status: 503 });
    if (preferencias !== undefined) {
      // aqui a recusa que sobra e "falta migration" (a assinatura, essa, funciona
      // sem a 0011 — a coluna dela existe desde o inicio)
      if (recusa) return NextResponse.json({ error: recusa }, { status: 503 });
      if (typeof preferencias !== "object" || preferencias === null || Array.isArray(preferencias)) {
        return NextResponse.json({ error: "preferencias invalidas" }, { status: 400 });
      }
      // patch parcial: o que nao veio mantem o valor atual; chave desconhecida e ignorada
      patch.preferencias = mesclarPreferencias(conta.preferencias, preferencias);
      mexeuEmAlgo = true;
    }
    if (assinatura_ativa !== undefined) {
      if (typeof assinatura_ativa !== "boolean") {
        return NextResponse.json({ error: "assinatura_ativa invalida" }, { status: 400 });
      }
      patch.assinatura_ativa = assinatura_ativa;
      mexeuEmAlgo = true;
    }
    if (assinatura_nome !== undefined) {
      patch.assinatura_nome = sanitizarAssinaturaNome(assinatura_nome);
      mexeuEmAlgo = true;
    }
  }

  if (!mexeuEmAlgo) return NextResponse.json({ error: "nada pra salvar" }, { status: 400 });

  const { error } = await msgDb().from("perfis").upsert(patch, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
