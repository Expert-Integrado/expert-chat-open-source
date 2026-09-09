import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { canalDeBody, tabelas } from "@/lib/canal";
import { somenteLeitura } from "@/lib/canais";
import { getUser } from "@/lib/auth-server";
import { getPerfil, permitido } from "@/lib/perfil";
import { derrubarCacheEmbed } from "@/lib/embed";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// Visibilidade e auto-arquivar EM MASSA (F9): aplica a mesma mudanca a uma
// lista de chat_ids de uma vez. Auth: super admin logado OU Bearer
// CHATGURU_SYNC_SECRET (uso via API/script, mesmo segredo do sync).
// Body: { canal?: <id de canal registrado; default "central">, chat_ids: string[],
//         set?: {tipo,id,nome}[]   -> SUBSTITUI a lista de visibilidade
//         add?: {tipo,id,nome}[]   -> acrescenta entradas
//         remove?: {tipo,id}[]     -> tira entradas
//         auto_arquivar?: boolean }
// set/add/remove sao mutuamente combinaveis (set roda primeiro).

type Entrada = { tipo?: string; id?: string; nome?: string };
const TIPOS = ["usuario", "departamento", "contexto"];
const LOTE = 200; // .in() com ids longos de grupo: URL curta

function entradasValidas(lista: unknown): { tipo: string; id: string; nome: string }[] | null {
  if (!Array.isArray(lista)) return null;
  const out: { tipo: string; id: string; nome: string }[] = [];
  for (const e of lista as Entrada[]) {
    if (!e?.id || !TIPOS.includes(String(e?.tipo))) return null;
    out.push({ tipo: String(e.tipo), id: String(e.id), nome: String(e.nome || "?").slice(0, 120) });
  }
  return out;
}

export async function POST(req: NextRequest) {
  // auth: bearer do sync (timing-safe) ou sessao de super admin
  let autorizado = false;
  const segredo = process.env.CHATGURU_SYNC_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (segredo && auth.startsWith("Bearer ")) {
    const recebido = Buffer.from(auth.slice(7));
    const esperado = Buffer.from(segredo);
    if (recebido.length === esperado.length && timingSafeEqual(recebido, esperado)) autorizado = true;
  }
  if (!autorizado) {
    const user = await getUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const perfil = await getPerfil(user.id);
    if (!permitido(perfil, "gerenciar_visibilidade")) {
      return NextResponse.json({ error: "sem permissao pra mudar visibilidade" }, { status: 403 });
    }
    autorizado = true;
  }

  const body = await req.json().catch(() => ({}));
  // canal pela porta da casa (`canalDeBody`), nao por comparacao a mao (3a
  // revisao): a versao antiga — `body?.canal === "apioficial" ? ... : "central"`
  // — ficava invisivel pro escopo por chave, que decide o canal em
  // `lib/escopo-chave.ts` olhando quem importa `canalDe*`. Resultado medido:
  // chave restrita ao apioficial gravava ACL dura no central. De quebra, agora
  // vale pra QUALQUER canal registrado, e as tabelas saem de `tabelas()` em vez
  // do ternario de dois canais, que apontaria pro par errado num canal novo.
  const canal = canalDeBody(body);
  const tabelaConversas = tabelas(canal).conversas;
  const chatIds: string[] = Array.isArray(body?.chat_ids)
    ? Array.from(new Set(body.chat_ids.map((c: unknown) => String(c)).filter(Boolean)))
    : [];
  if (!chatIds.length) {
    return NextResponse.json({ error: "chat_ids obrigatorio (lista nao vazia)" }, { status: 400 });
  }
  if (chatIds.length > 2000) {
    return NextResponse.json({ error: "maximo 2000 chats por chamada" }, { status: 400 });
  }

  const setLista = body?.set !== undefined ? entradasValidas(body.set) : undefined;
  const addLista = body?.add !== undefined ? entradasValidas(body.add) : undefined;
  const removeLista = body?.remove !== undefined ? entradasValidas(body.remove) : undefined;
  if (setLista === null || addLista === null || removeLista === null) {
    return NextResponse.json(
      { error: "entradas invalidas: cada item precisa de tipo (usuario|departamento|contexto) e id" },
      { status: 400 }
    );
  }
  const temVis = setLista !== undefined || addLista !== undefined || removeLista !== undefined;
  const autoArquivar = typeof body?.auto_arquivar === "boolean" ? body.auto_arquivar : undefined;
  if (!temVis && autoArquivar === undefined) {
    return NextResponse.json({ error: "nada a fazer: passe set/add/remove ou auto_arquivar" }, { status: 400 });
  }
  // CANAL SOMENTE LEITURA (fonte externa, ex. instagram-agent) — guard SO neste
  // ramo, e a linha divisoria e a que lib/canais.ts ja escreve: visibilidade mora
  // em tabela do painel chaveada por (canal, chat_id) e funciona pra qualquer
  // canal; `auto_arquivar`/`arquivada` moram na tabela de CONVERSAS do canal, que
  // uma fonte externa nao tem. Sem isto o UPDATE bateria em tabela inexistente e
  // devolveria 500 — 403 explicito e o padrao da casa (/api/nota, /api/etiquetas).
  //
  // Virou possivel agora: esta rota resolvia canal a mao entre dois ids fixos e
  // passou a aceitar QUALQUER canal registrado (`canalDeBody`), fonte externa
  // inclusive.
  if (autoArquivar !== undefined && somenteLeitura(canal)) {
    return NextResponse.json(
      { error: "canal somente leitura: arquivar automatico ainda nao disponivel pra este canal (a visibilidade, sim — mande so set/add/remove)" },
      { status: 403 }
    );
  }

  const db = msgDb();
  // contextos citados precisam existir (nao aceita lixo que silenciaria um grupo)
  const ctxCitados = Array.from(
    new Set(
      [...(setLista ?? []), ...(addLista ?? [])].filter((e) => e.tipo === "contexto").map((e) => e.id)
    )
  );
  if (ctxCitados.length) {
    const { data: existentes } = await db.from("embed_contextos").select("id").in("id", ctxCitados);
    const ok = new Set((existentes ?? []).map((c) => c.id));
    const ruins = ctxCitados.filter((id) => !ok.has(id));
    if (ruins.length) {
      return NextResponse.json({ error: `contexto inexistente: ${ruins.join(", ")}` }, { status: 400 });
    }
  }

  for (let i = 0; i < chatIds.length; i += LOTE) {
    const lote = chatIds.slice(i, i + LOTE);

    if (setLista !== undefined) {
      const del = await db.from("conversa_visibilidade").delete().eq("canal", canal).in("chat_id", lote);
      if (del.error) return NextResponse.json({ error: del.error.message }, { status: 500 });
    }
    const inserir = [...(setLista ?? []), ...(addLista ?? [])];
    if (inserir.length) {
      const linhas = lote.flatMap((chat_id) =>
        inserir.map((e) => ({ canal, chat_id, tipo: e.tipo, ref_id: e.id, nome: e.nome }))
      );
      const ins = await db
        .from("conversa_visibilidade")
        .upsert(linhas, { onConflict: "canal,chat_id,tipo,ref_id" });
      if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });
    }
    if (removeLista?.length) {
      for (const e of removeLista) {
        const del = await db
          .from("conversa_visibilidade")
          .delete()
          .eq("canal", canal)
          .eq("tipo", e.tipo)
          .eq("ref_id", e.id)
          .in("chat_id", lote);
        if (del.error) return NextResponse.json({ error: del.error.message }, { status: 500 });
      }
    }
    if (autoArquivar !== undefined) {
      const patch: Record<string, unknown> = { auto_arquivar: autoArquivar };
      if (autoArquivar) patch.arquivada = true; // ligar a chave ja arquiva
      const up = await db.from(tabelaConversas).update(patch).in("chat_id", lote);
      if (up.error) return NextResponse.json({ error: up.error.message }, { status: 500 });
    }
  }

  // grupos taggeados entram/saem das BUs — derruba o cache dos contextos tocados
  derrubarCacheEmbed();

  return NextResponse.json({ ok: true, chats: chatIds.length, canal });
}
