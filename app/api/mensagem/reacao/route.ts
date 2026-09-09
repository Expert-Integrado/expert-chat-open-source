import { NextRequest, NextResponse } from "next/server";
import { zapiReact, credsZapi } from "@/lib/zapi";
import { credsEvolution, evoReact } from "@/lib/evolution";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import { getPerfil, podeVerConversa, permitido } from "@/lib/perfil";
import { restricaoEfetiva } from "@/lib/embed";
import { canalDeBody, tabelas } from "@/lib/canal";
import { canalPorId } from "@/lib/canais";
import { motivoSemReacao, podeReagir, reacaoGravada, suportaReacao, validarReacao } from "@/lib/reacoes";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// REAGIR a uma mensagem (03/09/2026) — POST {id, emoji, canal}. Emoji vazio REMOVE.
//
// A DECISAO (o que e reacao valida, quais canais suportam, o corpo que vai pro
// provedor, o portao) mora em lib/reacoes.ts, puro e provado em node solto. Aqui
// e so a porta: identidade, escopo, permissao, envio, gravacao.
//
// Mesmos gates de editar/apagar (app/api/mensagem/route.ts), com duas diferencas
// deliberadas: (1) reagir vale pra mensagem NOSSA e do CLIENTE — o WhatsApp deixa
// reagir a qualquer mensagem da conversa, ao contrario de editar/apagar; (2) exige
// a permissao `enviar`, porque a reacao SAI pelo numero da empresa e o cliente a
// ve — e um envio, ainda que sem texto.
//
// Motor por FONTE do canal; null = canal sem o gesto (Gupshup/externa) ou canal
// da fonte certa sem credencial (fail-closed: nunca cai na instancia de outro
// numero, mesma regra de /api/send e /api/mensagem).
function motorDeReacao(canal: string) {
  const def = canalPorId(canal);
  if (!def) return null;
  if (def.fonte === "zapi") {
    const creds = credsZapi(canal);
    if (!creds) return null;
    return (chatId: string, msgId: string, _fromMe: boolean, emoji: string) => zapiReact(creds, chatId, msgId, emoji);
  }
  if (def.fonte === "evolution") {
    const creds = credsEvolution(canal);
    if (!creds) return null;
    return (chatId: string, msgId: string, fromMe: boolean, emoji: string) =>
      evoReact(creds, chatId, msgId, fromMe, emoji);
  }
  return null;
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { id, emoji } = body || {};
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "id obrigatorio" }, { status: 400 });
  }
  // validado na ENTRADA (regra da casa): pedido torto nao chega a tocar o banco
  const v = validarReacao(emoji);
  if (!v.ok) return NextResponse.json({ error: v.erro }, { status: 400 });

  const canal = canalDeBody(body);
  const def = canalPorId(canal);
  if (!def) return NextResponse.json({ error: "canal nao registrado" }, { status: 404 });
  const T = tabelas(canal);

  const db = msgDb();
  const { data: msg } = await db
    .from(T.mensagens)
    .select("id,chat_id,direcao,provider_msg_id,is_deleted")
    .eq("id", id)
    .maybeSingle();
  if (!msg) return NextResponse.json({ error: "mensagem nao encontrada" }, { status: 404 });
  // mesmo gate de escopo das demais rotas: sem ver a conversa, nao mexe nela
  if (!(await podeVerConversa(msg.chat_id, user, perfil, canal))) {
    return NextResponse.json({ error: "sem acesso a esta conversa" }, { status: 403 });
  }
  if (emb && !emb.permite(msg.chat_id)) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }
  // a reacao sai pelo numero da empresa e o cliente a ve: e envio
  if (!permitido(perfil, "enviar")) {
    return NextResponse.json({ error: "sem permissao pra enviar (reagir sai pelo WhatsApp)" }, { status: 403 });
  }
  if (!suportaReacao(def.fonte)) {
    return NextResponse.json({ error: motivoSemReacao(def.fonte) }, { status: 403 });
  }
  if (msg.direcao === "interna") {
    return NextResponse.json({ error: "anotacao interna nao vai pro WhatsApp — nao ha onde reagir" }, { status: 400 });
  }
  if (msg.is_deleted) {
    return NextResponse.json({ error: "mensagem apagada" }, { status: 409 });
  }
  if (!msg.provider_msg_id) {
    return NextResponse.json({ error: "mensagem sem identificador no WhatsApp" }, { status: 409 });
  }
  // o portao unico da lib fecha por ultimo (fail-closed): se um dia a regra
  // ganhar um criterio novo, a rota o herda sem precisar de mais um `if` aqui
  if (!podeReagir(def.fonte, msg)) {
    return NextResponse.json({ error: "nao da pra reagir a esta mensagem" }, { status: 409 });
  }

  const motor = motorDeReacao(canal);
  if (!motor) {
    return NextResponse.json({ error: "credenciais do canal nao configuradas" }, { status: 501 });
  }

  try {
    await motor(msg.chat_id, msg.provider_msg_id, msg.direcao === "out", v.emoji);
  } catch (e: any) {
    console.error("reacao falhou", { usuario: user.email, id, erro: e?.message });
    return NextResponse.json({ error: "o WhatsApp recusou a reacao" }, { status: 502 });
  }

  const reacao = reacaoGravada(v.emoji);
  await db.from(T.mensagens).update({ reacao }).eq("id", msg.id);
  return NextResponse.json({ ok: true, reacao });
}
