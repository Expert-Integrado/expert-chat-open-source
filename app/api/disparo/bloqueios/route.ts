import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { portao, RESP_SEM_TABELA } from "@/lib/disparo/rota";
import { bloquear, desbloquear } from "@/lib/disparo/bloqueio";
import { PALAVRAS_DESCADASTRO } from "@/lib/disparo/optout";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// LISTA DE BLOQUEIO (opt-out) — o minimo honesto.
//
// GET    = lista quem esta bloqueado (e as palavras que descadastram sozinhas)
// POST   = bloqueia um telefone
// DELETE = desbloqueia (?telefone=)
//
// A lista e consultada em DOIS pontos independentes, os dois fail-closed: na
// montagem do publico e de novo no envio, destino a destino. Ver docs/disparo.md.
//
// Alem do cadastro manual, a lista se alimenta SOZINHA: quando o destino
// responde ao disparo com uma palavra de descadastro (PARE/SAIR/STOP/CANCELAR e
// variantes de lib/disparo/optout.ts), `marcarRespostas` bloqueia na hora e
// marca o destino como optout.

export async function GET(req: NextRequest) {
  const g = await portao(req);
  if (g instanceof NextResponse) return g;

  const { data, error } = await msgDb()
    .from("campanha_bloqueios")
    .select("chave,telefone,origem,motivo,criado_por_nome,criado_em")
    .order("criado_em", { ascending: false })
    .limit(500);
  if (error) return RESP_SEM_TABELA();

  return NextResponse.json(
    {
      bloqueios: data ?? [],
      // a tela mostra isso pra quem opera saber o que descadastra sozinho
      palavras_que_descadastram: [...PALAVRAS_DESCADASTRO],
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  const g = await portao(req);
  if (g instanceof NextResponse) return g;
  const { user } = g;

  const body = await req.json().catch(() => ({}));
  const telefone = body?.telefone;
  if (!telefone) return NextResponse.json({ error: "informe o telefone" }, { status: 400 });

  const r = await bloquear({
    telefone,
    origem: "manual",
    motivo: typeof body?.motivo === "string" ? body.motivo : null,
    usuario: { id: user.id, nome: user.nome },
  });
  if (!r.ok) {
    const invalido = r.erro === "telefone invalido";
    return NextResponse.json({ error: r.erro }, { status: invalido ? 400 : 503 });
  }
  return NextResponse.json({ ok: true, chave: r.chave });
}

export async function DELETE(req: NextRequest) {
  const g = await portao(req);
  if (g instanceof NextResponse) return g;

  const telefone = req.nextUrl.searchParams.get("telefone");
  if (!telefone) return NextResponse.json({ error: "informe o telefone" }, { status: 400 });

  const r = await desbloquear(telefone);
  if (!r.ok) {
    const invalido = r.erro === "telefone invalido";
    return NextResponse.json({ error: r.erro }, { status: invalido ? 400 : 503 });
  }
  return NextResponse.json({ ok: true });
}
