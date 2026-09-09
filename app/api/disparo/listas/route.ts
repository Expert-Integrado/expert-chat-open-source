import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { portao, RESP_SEM_TABELA } from "@/lib/disparo/rota";
import {
  consolidar,
  publicoDoCsv,
  publicoDoFiltro,
  publicoDoPipedrive,
  type PublicoResolvido,
} from "@/lib/disparo/publico";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
// 300 desde a origem pipedrive (31/08/2026): a varredura do CRM pagina 500 por
// vez e pode ir a 40 paginas — o mesmo teto que /api/embed/sync usa. As outras
// tres origens nao chegam perto disso.
export const maxDuration = 300;

// LISTAS SALVAS — qualquer selecao vira lista nomeada e reutilizavel.
//
// A lista guarda uma FOTOGRAFIA do publico (itens em jsonb), nao um filtro vivo.
// Decisao: filtro salvo mudaria de tamanho entre a aprovacao e o disparo — quem
// aprovou 400 pessoas nao aprovou as 900 que o mesmo filtro devolve semana que
// vem. Lista e o que a pessoa viu quando salvou.

export async function GET(req: NextRequest) {
  const g = await portao(req);
  if (g instanceof NextResponse) return g;

  const { data, error } = await msgDb()
    .from("campanha_listas")
    .select("id,nome,descricao,total,criado_por_nome,criada_em,atualizada_em")
    .order("criada_em", { ascending: false })
    .limit(200);
  if (error) return RESP_SEM_TABELA();
  return NextResponse.json({ listas: data ?? [] }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function POST(req: NextRequest) {
  const g = await portao(req);
  if (g instanceof NextResponse) return g;
  const { user, perfil } = g;

  const body = await req.json().catch(() => ({}));
  const nome = typeof body?.nome === "string" ? body.nome.trim() : "";
  if (!nome) return NextResponse.json({ error: "de um nome pra lista" }, { status: 400 });

  let publico: PublicoResolvido;
  if (body?.origem === "csv") {
    publico = publicoDoCsv(typeof body.csv === "string" ? body.csv : "");
  } else if (body?.origem === "filtro") {
    publico = await publicoDoFiltro(body.filtro || {}, user, perfil, req);
  } else if (body?.origem === "pipedrive") {
    // "qualquer selecao pode virar lista nomeada e reutilizavel" (criterio do
    // card) vale pro CRM tambem: a lista salva CONGELA o publico daquele
    // momento — o filtro no Pipedrive continua mudando, a lista nao. E isso e a
    // feature, nao limitacao: campanha aprovada em cima de 400 contatos nao pode
    // virar 900 porque alguem mexeu no filtro do CRM no meio.
    const p = await publicoDoPipedrive(body.pipedrive || {});
    // 400 = o PEDIDO esta torto; 501 = nao ha CRM aqui; 502 = o CRM nao respondeu
    if (p.pedidoInvalido) return NextResponse.json({ error: p.erro }, { status: 400 });
    if (p.indisponivel) return NextResponse.json({ error: p.erro }, { status: 501 });
    if (p.erro) return NextResponse.json({ error: p.erro }, { status: 502 });
    publico = p;
  } else if (Array.isArray(body?.itens)) {
    publico = consolidar(
      body.itens.map((i: any) => ({ telefone: i.chat_id || i.telefone, nome: i.nome, variaveis: i.variaveis })),
      "lista"
    );
  } else {
    return NextResponse.json({ error: "informe origem (csv/filtro/pipedrive) ou itens" }, { status: 400 });
  }

  if (!publico.itens.length) {
    return NextResponse.json({ error: "a lista ficaria vazia", detalhe: publico.aviso ?? null }, { status: 400 });
  }

  const { data, error } = await msgDb()
    .from("campanha_listas")
    .insert({
      nome,
      descricao: typeof body?.descricao === "string" ? body.descricao : null,
      itens: publico.itens,
      total: publico.itens.length,
      criado_por_id: user.id,
      criado_por_nome: user.nome,
    })
    .select("id,nome,total,criada_em")
    .single();

  if (error) {
    // nome unico (indice uq_campanha_listas_nome): mensagem legivel em vez de 500
    if ((error as any).code === "23505") {
      return NextResponse.json({ error: "ja existe uma lista com esse nome" }, { status: 409 });
    }
    return RESP_SEM_TABELA();
  }
  return NextResponse.json({
    lista: data,
    invalidos: publico.invalidos.length,
    duplicados: publico.duplicados.length,
  });
}
