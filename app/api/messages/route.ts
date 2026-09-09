import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import { credsCentral } from "@/lib/zapi";
import { fotoPublica } from "@/lib/foto";
import { getPerfil, podeVerConversa } from "@/lib/perfil";
import { canalDe, tabelas } from "@/lib/canal";
import { canalPorId, fonteExterna } from "@/lib/canais";
import { fonteLigada } from "@/lib/fonte-externa";
import { sincronizarApioficial } from "@/lib/sync-apioficial";
import { janela24h } from "@/lib/gupshup";
import { restricaoEfetiva } from "@/lib/embed";
import { guardarFotoPermanente, linkCdnValido } from "@/lib/foto-store";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const FOTO_TTL_MS = 7 * 24 * 60 * 60 * 1000; // rechecagem: captura foto TROCADA

// Busca a foto de perfil so quando falta ou esta velha (a rota e chamada em
// polling; sem o corte de validade seria 1 chamada ao provider a cada 3s).
async function atualizaFoto(db: any, chatId: string) {
  // foto_wa_url e a foto do WhatsApp (nossa); foto_url pertence a importacao do
  // ChatGuru, que sobrescreve com URL de bucket privado — por isso a coluna separada.
  const { data: c } = await db
    .from("conversas")
    .select("foto_wa_url,foto_wa_em")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (!c) return null;
  const fresca = c.foto_wa_em && Date.now() - new Date(c.foto_wa_em).getTime() < FOTO_TTL_MS;
  if (c.foto_wa_url && fresca) return c.foto_wa_url;

  const creds = credsCentral();
  if (!creds) return c.foto_url ?? null;
  try {
    const r = await fetch(
      `https://api.z-api.io/instances/${creds.instance}/token/${creds.token}/profile-picture?phone=${encodeURIComponent(chatId)}`,
      {
        headers: creds.clientToken ? { "Client-Token": creds.clientToken } : ({} as Record<string, string>),
        cache: "no-store",
      }
    );
    if (r.ok) {
      const j: any = await r.json().catch(() => ({}));
      const link = linkCdnValido(j?.link ?? j?.profilePicture);
      // NUNCA apagar foto boa: o endpoint as vezes responde 200 sem link
      // (rate limit / contato sem foto visivel) e isso zerava o avatar.
      const patch: Record<string, any> = { foto_wa_em: new Date().toISOString() };
      let urlFinal: string | null = null;
      if (link) {
        // guarda a imagem no Storage (URL permanente, lib/foto-store);
        // o link do CDN — que expira — fica so como fallback
        urlFinal = (await guardarFotoPermanente(db, chatId, link)) || link;
        patch.foto_wa_url = urlFinal;
      }
      await db.from("conversas").update(patch).eq("chat_id", chatId);
      return urlFinal || c.foto_wa_url || null;
    }
  } catch {
    // sem foto: a tela cai nas iniciais
  }
  return c.foto_wa_url ?? null;
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") {
    return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  }
  const chatId = req.nextUrl.searchParams.get("chat_id");
  if (!chatId) {
    return NextResponse.json({ error: "chat_id obrigatorio" }, { status: 400 });
  }
  const canal = canalDe(req);
  const T = tabelas(canal);
  if (!(await podeVerConversa(chatId, user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(chatId)) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }
  const db = msgDb();
  const def = canalPorId(canal)!;

  let linhas: any[] = [];
  let foto: string | null = null;
  let janela: Awaited<ReturnType<typeof janela24h>> | null = null;
  if (fonteExterna(def)) {
    // fonte externa (instagram-agent / whatsapp-agent): as mensagens vem do banco
    // do agente, ja nas colunas do painel; sem foto de perfil e sem janela de 24h
    const ext = await fonteLigada(def);
    const externas = ext ? await ext.listarMensagens(chatId) : [];
    if (externas === null) return NextResponse.json({ error: "falha ao carregar mensagens" }, { status: 500 });
    linhas = externas;
  } else {
    if (canal === "apioficial") await sincronizarApioficial();
    const [msgRes, fotoDb, janelaDb] = await Promise.all([
      db
        .from(T.mensagens)
        .select(
          "id,direcao,tipo,conteudo,sender_name,sender_phone,status,criada_em,media_url,media_mime,enviado_por_id,enviado_por_nome,provider_msg_id,quoted_msg_id,is_deleted,editada_em,reacao,encaminhada"
        )
        .eq("chat_id", chatId)
        // nota interna ENTRA no fluxo (card amarelo, estilo ChatGuru) — o front
        // renderiza diferente pela flag `interna`
        .order("criada_em", { ascending: false })
        .limit(300),
      // foto de perfil via Z-API so existe no canal central
      canal === "central" ? atualizaFoto(db, chatId) : Promise.resolve(null),
      canal === "apioficial" ? janela24h(chatId) : Promise.resolve(null),
    ]);
    if (msgRes.error) {
      console.error("messages:", msgRes.error.message);
      return NextResponse.json({ error: "falha ao carregar mensagens" }, { status: 500 });
    }
    linhas = msgRes.data ?? [];
    foto = fotoDb;
    janela = janelaDb;
  }

  const messages = linhas
    .map((m) => ({
      id: m.id,
      direction: m.direcao === "out" ? "sent" : "received",
      from_me: m.direcao === "out",
      message_type: m.tipo,
      content: m.conteudo,
      caption: null,
      sender_name: m.sender_name,
      sender_phone: m.sender_phone,
      send_status: m.status,
      message_ts: m.criada_em,
      media_url: m.media_url,
      media_mime: m.media_mime,
      // enviado_por_id existe desde a trilha de auditoria (0001); o front usa
      // pra achar a FOTO do atendente que mandou (Meu perfil)
      enviado_por_id: m.enviado_por_id ?? null,
      enviado_por_nome: m.enviado_por_nome,
      provider_msg_id: m.provider_msg_id,
      quoted_msg_id: m.quoted_msg_id,
      is_deleted: m.is_deleted,
      editada_em: m.editada_em,
      reacao: m.reacao,
      encaminhada: m.encaminhada,
      interna: m.direcao === "interna",
    }))
    .reverse();

  return NextResponse.json(
    { messages, foto_url: fotoPublica(foto), janela },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
