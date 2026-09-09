import { NextRequest, NextResponse } from "next/server";
import { zapiEdit, zapiDelete, credsZapi } from "@/lib/zapi";
import { credsEvolution, evoEdit, evoDelete } from "@/lib/evolution";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import { getPerfil, podeVerConversa } from "@/lib/perfil";
import { restricaoEfetiva } from "@/lib/embed";
import { canalDe, canalDeBody, tabelas } from "@/lib/canal";
import { canalPorId } from "@/lib/canais";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Editar (PATCH) e apagar (DELETE) mensagem que NOS enviamos.
// So mensagem propria: o WhatsApp nao deixa mexer em mensagem de terceiro.
// P1 (30/08/2026): canal-aware — a operacao roda na tabela do canal e sai pela
// instancia DO CANAL (Z-API ou Evolution). Fonte Gupshup/externa nao tem
// editar/apagar: a API oficial da Meta nao expoe esses gestos.
async function carregarPropria(db: any, tabela: string, id: string) {
  const { data } = await db
    .from(tabela)
    .select("id,chat_id,direcao,provider_msg_id,tipo,is_deleted")
    .eq("id", id)
    .maybeSingle();
  return data;
}

// Motor de edicao/exclusao do canal; null = canal que nao suporta a operacao
// (fonte Gupshup/externa) ou canal da fonte certa sem credencial (fail-closed:
// nunca cai na instancia de outro numero). Z-API e Evolution tem os dois gestos,
// com endpoints diferentes — cada um traduzido na sua lib.
function motorDoCanal(canal: string) {
  const def = canalPorId(canal);
  if (!def) return null;
  if (def.fonte === "zapi") {
    const creds = credsZapi(canal);
    if (!creds) return null;
    return {
      editar: (chatId: string, msgId: string, texto: string) => zapiEdit(creds, chatId, msgId, texto),
      apagar: (chatId: string, msgId: string) => zapiDelete(creds, chatId, msgId, true),
    };
  }
  if (def.fonte === "evolution") {
    const creds = credsEvolution(canal);
    if (!creds) return null;
    return {
      editar: (chatId: string, msgId: string, texto: string) => evoEdit(creds, chatId, msgId, texto),
      apagar: (chatId: string, msgId: string) => evoDelete(creds, chatId, msgId, true),
    };
  }
  return null;
}

export async function PATCH(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { id, message } = body || {};
  if (!id || typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "id e message obrigatorios" }, { status: 400 });
  }
  const texto = message.trim();
  if (texto.length > 4096) {
    return NextResponse.json({ error: "mensagem muito longa" }, { status: 400 });
  }
  const canal = canalDeBody(body);
  const T = tabelas(canal);

  const db = msgDb();
  const msg = await carregarPropria(db, T.mensagens, String(id));
  if (!msg) return NextResponse.json({ error: "mensagem nao encontrada" }, { status: 404 });
  // mesmo gate de escopo das demais rotas: sem ver a conversa, nao mexe nela
  if (!(await podeVerConversa(msg.chat_id, user, perfil, canal))) {
    return NextResponse.json({ error: "sem acesso a esta conversa" }, { status: 403 });
  }
  if (emb && !emb.permite(msg.chat_id)) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }
  if (msg.direcao !== "out") {
    return NextResponse.json({ error: "so da pra editar mensagem enviada por nos" }, { status: 403 });
  }
  if (!msg.provider_msg_id) {
    return NextResponse.json({ error: "mensagem sem identificador no WhatsApp" }, { status: 409 });
  }
  if (msg.tipo !== "text") {
    return NextResponse.json({ error: "so mensagem de texto pode ser editada" }, { status: 400 });
  }

  const motor = motorDoCanal(canal);
  if (!motor) return NextResponse.json({ error: "este canal nao suporta editar mensagem" }, { status: 403 });

  try {
    await motor.editar(msg.chat_id, msg.provider_msg_id, texto);
  } catch (e: any) {
    console.error("edit falhou", { usuario: user.email, id, erro: e?.message });
    return NextResponse.json(
      { error: "o WhatsApp recusou a edicao (so vale nos primeiros 15 min e em conta com o recurso liberado)" },
      { status: 502 }
    );
  }

  await db
    .from(T.mensagens)
    .update({ conteudo: texto, editada_em: new Date().toISOString() })
    .eq("id", msg.id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id obrigatorio" }, { status: 400 });
  const canal = canalDe(req);
  const T = tabelas(canal);

  const db = msgDb();
  const msg = await carregarPropria(db, T.mensagens, id);
  if (!msg) return NextResponse.json({ error: "mensagem nao encontrada" }, { status: 404 });
  // mesmo gate de escopo das demais rotas: sem ver a conversa, nao mexe nela
  if (!(await podeVerConversa(msg.chat_id, user, perfil, canal))) {
    return NextResponse.json({ error: "sem acesso a esta conversa" }, { status: 403 });
  }
  if (emb && !emb.permite(msg.chat_id)) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }
  if (msg.direcao !== "out") {
    return NextResponse.json({ error: "so da pra apagar mensagem enviada por nos" }, { status: 403 });
  }
  if (!msg.provider_msg_id) {
    return NextResponse.json({ error: "mensagem sem identificador no WhatsApp" }, { status: 409 });
  }

  const motor = motorDoCanal(canal);
  if (!motor) return NextResponse.json({ error: "este canal nao suporta apagar mensagem" }, { status: 403 });

  try {
    await motor.apagar(msg.chat_id, msg.provider_msg_id);
  } catch (e: any) {
    console.error("delete falhou", { usuario: user.email, id, erro: e?.message });
    return NextResponse.json({ error: "o WhatsApp recusou apagar a mensagem" }, { status: 502 });
  }

  // marca como apagada (nao remove a linha: preserva a trilha de quem enviou)
  await db.from(T.mensagens).update({ is_deleted: true }).eq("id", msg.id);
  return NextResponse.json({ ok: true });
}
