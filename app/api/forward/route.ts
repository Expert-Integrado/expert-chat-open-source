import { NextRequest, NextResponse } from "next/server";
import { zapiForward, credsZapi } from "@/lib/zapi";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import {
  getPerfil, contextoVisao, conversaVisivel, permitido, restricaoAplicadaNaConversa,
  Responsavel, VisibilidadeEntry,
} from "@/lib/perfil";
import { restricaoEmLote } from "@/lib/acesso";
import { getConfig } from "@/lib/config";
import { restricaoEfetiva, vinculosBu } from "@/lib/embed";
import { credsGupshup, gsSendText, janela24h } from "@/lib/gupshup";
import { MAX_DESTINOS_FORWARD } from "@/lib/tela-conversa";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

const DESTINO_VALIDO = /^(\d{10,15}|\d{15,25}-group)$/;
// mesmo teto do WhatsApp: encaminhar e gesto de conversa, nao ferramenta de
// disparo. O numero mora em lib/tela-conversa.ts porque a TELA tambem precisa
// dele (desabilita a caixa no limite e escreve "N/5"): estava escrito em tres
// lugares, e teto duplicado e teto que diverge.
const MAX_DESTINOS = MAX_DESTINOS_FORWARD;

// Encaminha uma mensagem existente pra ate 5 conversas (igual WhatsApp).
// A Z-API replica o conteudo original (texto ou midia) e o destinatario ve o
// selo "Encaminhada". Cada destino precisa ser conversa que ja existe no painel.
export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") {
    return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const { chat_id, provider_msg_id, destinos } = body || {};

  if (!chat_id || !provider_msg_id || !Array.isArray(destinos) || !destinos.length) {
    return NextResponse.json({ error: "chat_id, provider_msg_id e destinos sao obrigatorios" }, { status: 400 });
  }
  const alvos: string[] = Array.from(new Set(destinos.map(String))).slice(0, MAX_DESTINOS);
  if (alvos.some((d) => !DESTINO_VALIDO.test(d))) {
    return NextResponse.json({ error: "destino invalido" }, { status: 400 });
  }

  // P1 (30/08/2026): o encaminhamento sai pelo NUMERO DO CANAL da conversa.
  // Canal registrado mas sem envio cabeado nunca cai no caminho de outro numero.
  const { canalDeBody } = await import("@/lib/canal");
  const { envioDisponivel, canalPorId } = await import("@/lib/canais");
  const canal = canalDeBody(body);
  const def = canalPorId(canal)!;
  if (!envioDisponivel(canal)) {
    return NextResponse.json({ error: "envio nao configurado pra este canal" }, { status: 403 });
  }
  // Fonte Gupshup nao tem encaminhamento nativo (limite do WhatsApp Business):
  // reenviamos o TEXTO como copia, so pra destino com a janela de 24h aberta.
  // Midia fica de fora (v1 do canal envia so texto).
  if (def.fonte === "gupshup") {
    return forwardGupshup(user, perfil, emb, alvos, String(chat_id), String(provider_msg_id), canal, def.tabelas);
  }
  // Fonte Evolution: a API v2.3 NAO tem endpoint de forward (confirmado na
  // collection oficial). Reenviar-como-copia, como no canal oficial, e possivel
  // e fica pra v2 — ate la a recusa e explicita, e nao um "encaminhado" que
  // nunca chegou. Quem precisa agora copia o texto e manda pelo composer.
  if (def.fonte === "evolution") {
    return NextResponse.json(
      { error: "este numero nao encaminha mensagem (a API dele nao tem esse recurso) — copie o texto e envie" },
      { status: 403 }
    );
  }

  const creds = credsZapi(canal);
  if (!creds) {
    return NextResponse.json({ error: "credenciais Z-API do canal nao configuradas" }, { status: 501 });
  }
  const T = def.tabelas;
  const db = msgDb();

  // a mensagem original tem que existir na conversa de origem
  const { data: original } = await db
    .from(T.mensagens)
    .select("tipo,conteudo,media_url,media_mime")
    .eq("chat_id", String(chat_id))
    .eq("provider_msg_id", String(provider_msg_id))
    .maybeSingle();
  if (!original) {
    return NextResponse.json({ error: "mensagem original nao encontrada" }, { status: 404 });
  }

  // encaminhar E envio: mesma permissao do /api/send
  if (!permitido(perfil, "enviar")) {
    return NextResponse.json({ error: "sem permissao pra enviar mensagem" }, { status: 403 });
  }
  // mesmo criterio do /api/send: so conversa existente (nada de disparo frio)
  // e dentro do escopo de visao do usuario (origem e destinos)
  const ctx = await contextoVisao(user, perfil);
  const cfg = await getConfig();
  if (!(await podeVer(String(chat_id)))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  const vinculos = await vinculosBu(user.id, perfil.papel === "super_admin");
  const { data: existentes } = await db
    .from(T.conversas)
    .select("chat_id,status,auto_arquivar")
    .in("chat_id", alvos);
  const [{ data: respAlvos }, { data: visAlvos }] = await Promise.all([
    db.from("conversa_responsaveis").select("chat_id,tipo,ref_id").eq("canal", canal).in("chat_id", alvos),
    db.from("conversa_visibilidade").select("chat_id,tipo,ref_id").eq("canal", canal).in("chat_id", alvos),
  ]);
  const respPorChat = new Map<string, Responsavel[]>();
  for (const r of respAlvos ?? []) {
    const l = respPorChat.get(r.chat_id) || [];
    l.push({ tipo: r.tipo, ref_id: r.ref_id } as Responsavel);
    respPorChat.set(r.chat_id, l);
  }
  const visPorChat = new Map<string, VisibilidadeEntry[]>();
  for (const v of visAlvos ?? []) {
    const l = visPorChat.get(v.chat_id) || [];
    l.push({ tipo: v.tipo, ref_id: v.ref_id } as VisibilidadeEntry);
    visPorChat.set(v.chat_id, l);
  }
  // lista de destinos: escopo normal E contexto de embed (intersecao, nunca substituto)
  // RESTRICAO por funil/canal (Frente Q): encaminhar e ENVIO, entao o destino
  // passa pelo mesmo recorte da leitura — nao existe "escrever onde nao se le".
  const restr = await restricaoEmLote(
    user.id,
    perfil.papel === "super_admin",
    (existentes ?? []).map((c) => ({ canal, chatId: c.chat_id as string }))
  );
  const validos = new Set(
    (existentes ?? [])
      .filter((c) =>
        conversaVisivel(
          respPorChat.get(c.chat_id) || [],
          user,
          perfil,
          ctx,
          c.status,
          visPorChat.get(c.chat_id) || [],
          vinculos,
          restr?.para(canal, c.chat_id)
        )
      )
      .map((c) => c.chat_id)
  );
  const autoArquivarPorChat = new Map((existentes ?? []).map((c) => [c.chat_id, !!c.auto_arquivar]));

  async function podeVer(id: string) {
    const [{ data: rows }, { data: conv }, { data: visRows }] = await Promise.all([
      db.from("conversa_responsaveis").select("tipo,ref_id").eq("chat_id", id).eq("canal", canal),
      db.from(T.conversas).select("status").eq("chat_id", id).maybeSingle(),
      db.from("conversa_visibilidade").select("tipo,ref_id").eq("chat_id", id).eq("canal", canal),
    ]);
    return conversaVisivel(
      (rows ?? []) as Responsavel[],
      user!,
      perfil,
      ctx,
      conv?.status ?? null,
      (visRows ?? []) as VisibilidadeEntry[],
      vinculos,
      await restricaoAplicadaNaConversa(user!.id, canal, id)
    );
  }

  const ok: string[] = [];
  const falhas: { destino: string; erro: string }[] = [];
  const now = new Date().toISOString();
  const preview = `${user.nome}: ${original.conteudo ?? "[midia]"}`.slice(0, 140);

  for (const destino of alvos) {
    if (!validos.has(destino)) {
      falhas.push({ destino, erro: "conversa nao existe no painel" });
      continue;
    }
    // destino avulso fora do contexto de embed: bloqueado mesmo sendo conversa valida
    if (emb && !emb.permite(destino)) {
      falhas.push({ destino, erro: "destino fora do contexto" });
      continue;
    }
    try {
      const sent = await zapiForward(creds, destino, String(provider_msg_id), String(chat_id));
      await db.from(T.mensagens).insert({
        chat_id: destino,
        direcao: "out",
        tipo: original.tipo,
        conteudo: original.conteudo,
        media_url: original.media_url,
        media_mime: original.media_mime,
        provider_msg_id: sent.messageId || null,
        encaminhada: true,
        status: "sent",
        criada_em: now,
        enviado_por_id: user.id,
        enviado_por_nome: user.nome,
      });
      // mesma regra do envio: vai pro topo, vira atendimento (configuravel), assume se nao tem dono
      await db
        .from(T.conversas)
        .update({ last_message_at: now, last_message_preview: preview, updated_at: now })
        .eq("chat_id", destino);
      if (autoArquivarPorChat.get(destino)) {
        // chat com auto-arquivar: cada evento re-afirma o arquivo, nunca reabre
        await db.from(T.conversas).update({ arquivada: true }).eq("chat_id", destino);
      } else if (cfg.auto_atendimento_ao_responder) {
        await db
          .from(T.conversas)
          .update({ status: "atendimento", arquivada: false })
          .eq("chat_id", destino)
          .in("status", ["aberto", "concluido", "aguardando"]);
      }
      const { count } = await db
        .from("conversa_responsaveis")
        .select("chat_id", { count: "exact", head: true })
        .eq("chat_id", destino)
        .eq("canal", canal);
      if (!count) {
        await db.from("conversa_responsaveis").upsert(
          { canal, chat_id: destino, tipo: "usuario", ref_id: user.id, nome: user.nome },
          { onConflict: "canal,chat_id,tipo,ref_id" }
        );
      }
      ok.push(destino);
    } catch (e: any) {
      console.error("forward falhou", { usuario: user.email, destino, erro: e?.message });
      falhas.push({ destino, erro: "falha ao encaminhar" });
    }
  }

  return NextResponse.json({ ok: true, enviados: ok, falhas });
}

// Canal API OFICIAL: "reenviar como copia" — o WhatsApp Business nao tem
// encaminhamento nativo, entao replicamos o TEXTO num envio de sessao, que a
// Meta so aceita com a janela de 24h do destino aberta. Midia fica de fora
// (v1 do canal envia so texto). Permissoes identicas ao ramo central, com as
// tabelas/canal do oficial.
async function forwardGupshup(
  user: NonNullable<Awaited<ReturnType<typeof getUser>>>,
  perfil: Awaited<ReturnType<typeof getPerfil>>,
  emb: any,
  alvos: string[],
  chatId: string,
  providerMsgId: string,
  canal: string,
  T: { conversas: string; mensagens: string }
) {
  const creds = await credsGupshup(canal);
  if (!creds) return NextResponse.json({ error: "canal sem credenciais Gupshup" }, { status: 501 });
  const db = msgDb();

  const { data: original } = await db
    .from(T.mensagens)
    .select("tipo,conteudo,media_url")
    .eq("chat_id", chatId)
    .eq("provider_msg_id", providerMsgId)
    .maybeSingle();
  if (!original) return NextResponse.json({ error: "mensagem original nao encontrada" }, { status: 404 });
  if (original.media_url || !original.conteudo || /^\[[^\]]*\]$/.test(original.conteudo.trim())) {
    return NextResponse.json(
      { error: "no canal oficial so texto pode ser reenviado (limite do WhatsApp Business)" },
      { status: 400 }
    );
  }

  const ctx = await contextoVisao(user, perfil);
  const vinculos = await vinculosBu(user.id, perfil.papel === "super_admin");
  const cfg = await getConfig();

  const visivel = async (id: string) => {
    const [{ data: rows }, { data: conv }, { data: visRows }] = await Promise.all([
      db.from("conversa_responsaveis").select("tipo,ref_id").eq("chat_id", id).eq("canal", canal),
      db.from(T.conversas).select("status,auto_arquivar").eq("chat_id", id).maybeSingle(),
      db.from("conversa_visibilidade").select("tipo,ref_id").eq("chat_id", id).eq("canal", canal),
    ]);
    if (!conv) return null;
    const ok = conversaVisivel(
      (rows ?? []) as Responsavel[],
      user,
      perfil,
      ctx,
      conv.status ?? null,
      (visRows ?? []) as VisibilidadeEntry[],
      vinculos,
      await restricaoAplicadaNaConversa(user.id, canal, id)
    );
    return ok ? conv : null;
  };

  if (!(await visivel(chatId))) return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });

  const ok: string[] = [];
  const falhas: { destino: string; erro: string }[] = [];
  const now = new Date().toISOString();
  const preview = `${user.nome}: ${original.conteudo}`.slice(0, 140);

  for (const destino of alvos) {
    const conv = await visivel(destino);
    if (!conv) {
      falhas.push({ destino, erro: "conversa nao existe no painel" });
      continue;
    }
    if (emb && !emb.permite(destino)) {
      falhas.push({ destino, erro: "destino fora do contexto" });
      continue;
    }
    const jan = await janela24h(destino, T.mensagens);
    if (!jan.aberta) {
      falhas.push({ destino, erro: "janela de 24h fechada" });
      continue;
    }
    try {
      const sent = await gsSendText(creds, destino, original.conteudo);
      await db.from(T.mensagens).insert({
        chat_id: destino,
        direcao: "out",
        tipo: "text",
        conteudo: original.conteudo,
        provider_msg_id: sent.messageId || null,
        encaminhada: true,
        status: "sent",
        criada_em: now,
        enviado_por_id: user.id,
        enviado_por_nome: user.nome,
      });
      await db
        .from(T.conversas)
        .update({ last_message_at: now, last_message_preview: preview, updated_at: now })
        .eq("chat_id", destino);
      if (conv.auto_arquivar) {
        await db.from(T.conversas).update({ arquivada: true }).eq("chat_id", destino);
      } else if (cfg.auto_atendimento_ao_responder) {
        await db
          .from(T.conversas)
          .update({ status: "atendimento", arquivada: false })
          .eq("chat_id", destino)
          .in("status", ["aberto", "concluido", "aguardando"]);
      }
      const { count } = await db
        .from("conversa_responsaveis")
        .select("chat_id", { count: "exact", head: true })
        .eq("chat_id", destino)
        .eq("canal", canal);
      if (!count) {
        await db.from("conversa_responsaveis").upsert(
          { canal, chat_id: destino, tipo: "usuario", ref_id: user.id, nome: user.nome },
          { onConflict: "canal,chat_id,tipo,ref_id" }
        );
      }
      ok.push(destino);
    } catch (e: any) {
      console.error("forward oficial falhou", { usuario: user.email, destino, erro: e?.message });
      falhas.push({ destino, erro: "falha ao reenviar" });
    }
  }
  return NextResponse.json({ ok: true, enviados: ok, falhas });
}
