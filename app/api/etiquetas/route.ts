import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import { getPerfil, podeVerConversa } from "@/lib/perfil";
import { canalDeBody, tabelas } from "@/lib/canal";
import { somenteLeitura } from "@/lib/canais";
import { restricaoEfetiva } from "@/lib/embed";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Catalogo de etiquetas ATIVAS (definido pelo super admin nas Configuracoes).
export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data, error } = await msgDb()
    .from("etiquetas_catalogo")
    .select("nome")
    .eq("ativo", true)
    .order("nome");
  if (error) return NextResponse.json({ error: "falha ao carregar etiquetas" }, { status: 500 });
  return NextResponse.json(
    { etiquetas: (data ?? []).map((e) => e.nome) },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

// Aplica/remove etiquetas numa conversa. SO aceita etiqueta do catalogo ativo —
// criar etiqueta nova e acao de admin (tela de Configuracoes), nunca daqui.
export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  const bodyE = await req.json().catch(() => ({}));
  const { chat_id, etiquetas } = bodyE;
  const canal = canalDeBody(bodyE);
  const T = tabelas(canal);
  if (!chat_id || !Array.isArray(etiquetas)) {
    return NextResponse.json({ error: "chat_id e etiquetas (lista) sao obrigatorios" }, { status: 400 });
  }
  if (!(await podeVerConversa(String(chat_id), user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(String(chat_id))) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }
  // fonte externa (instagram-agent): etiqueta mora na linha da conversa do painel,
  // que este canal nao tem — 403 explicito em vez de 500
  if (somenteLeitura(canal)) {
    return NextResponse.json(
      { error: "canal somente leitura: etiquetas ainda nao disponiveis pra este canal" },
      { status: 403 }
    );
  }
  const db = msgDb();
  const { data: catalogo } = await db.from("etiquetas_catalogo").select("nome").eq("ativo", true);
  const validas = new Set((catalogo ?? []).map((e) => e.nome));

  const limpas = Array.from(
    new Set(etiquetas.filter((e: unknown) => typeof e === "string").map((e: string) => e.trim()).filter(Boolean))
  ).slice(0, 30);
  const invalidas = limpas.filter((e) => !validas.has(e));
  if (invalidas.length) {
    return NextResponse.json(
      { error: `etiqueta fora do catalogo: ${invalidas.join(", ")} (admin cria em Configuracoes)` },
      { status: 400 }
    );
  }

  const { error } = await db
    .from(T.conversas)
    .update({ etiquetas: limpas, updated_at: new Date().toISOString() })
    .eq("chat_id", String(chat_id));
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, etiquetas: limpas });
}
