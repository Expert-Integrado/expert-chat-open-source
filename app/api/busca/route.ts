import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, contextoVisao, conversaVisivel, Responsavel, VisibilidadeEntry } from "@/lib/perfil";
import { canalDe, tabelas } from "@/lib/canal";
import { canalPorId, fonteExterna } from "@/lib/canais";
import { igDisponivel, resolverContaIg, buscarMensagensIg, conversasIgPorIds } from "@/lib/instagram-agent";
import { msgDb } from "@/lib/mensageria";
import { restricaoEfetiva, vinculosBu } from "@/lib/embed";
import { padraoParaIlike, casaTermo } from "@/lib/tela-conversa";
import { restricaoEmLote } from "@/lib/acesso";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Busca por CONTEUDO de mensagem (indice trigram no banco), respeitando o
// escopo de visao do usuario. Devolve conversas + trecho da mensagem que bateu.
export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  const q = String(req.nextUrl.searchParams.get("q") || "").trim();
  if (q.length < 3) return NextResponse.json({ error: "busca com pelo menos 3 letras" }, { status: 400 });
  const canal = canalDe(req);
  const T = tabelas(canal);
  const db = msgDb();
  const def = canalPorId(canal)!;
  // fonte externa (instagram-agent): hits e nomes vem do banco do agente; o escopo
  // de visao (responsaveis/visibilidade) segue no banco do painel, por canal
  const contaIg = fonteExterna(def) && igDisponivel() ? await resolverContaIg(def) : null;

  let hits: any[] = [];
  if (fonteExterna(def)) {
    hits = contaIg ? await buscarMensagensIg(contaIg, q) : [];
  } else {
  // `*` NAO DA PRA ESCAPAR no filtro ilike do PostgREST: ele troca `*` por `%`
  // antes do banco, e troca cegamente (inclusive depois de `\`), entao `\*`
  // viaja como `\%` = percent LITERAL e a busca devolve ZERO. Como `*` e o
  // marcador de negrito do WhatsApp (e a assinatura do painel sai como
  // `*Nome:*`), buscar por ele nao pode devolver zero. O banco recebe o maior
  // pedaco do termo LIVRE de `*` (superset) e o filtro literal roda em JS.
  const padrao = padraoParaIlike(q);
  if (!padrao.ok) return NextResponse.json({ error: padrao.erro }, { status: 400 });
  const TETO_HITS = 60;
  // um `.ilike()` por pedaco livre de `*` — filtros repetidos ANDam no
  // PostgREST, e cada um aperta o superset que o filtro em JS vai receber
  let sel = db
    .from(T.mensagens)
    .select("chat_id,conteudo,direcao,criada_em,sender_name,enviado_por_nome")
    .neq("direcao", "interna");
  for (const p of padrao.patterns) sel = sel.ilike("conteudo", `%${p}%`);
  const { data: hitsDb, error } = await sel
    .order("criada_em", { ascending: false })
    // com filtro em JS, pedir so 60 faria o superset comer a cota do resultado
    .limit(padrao.filtrar ? TETO_HITS * 5 : TETO_HITS);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const brutos = hitsDb ?? [];
  // `casaTermo` exige o termo INTEIRO (com os `*`) como substring normalizada:
  // recall igual ao do banco, zero falso positivo do superset.
  hits = padrao.filtrar
    ? brutos.filter((m: any) => casaTermo(m.conteudo, q)).slice(0, TETO_HITS)
    : brutos;
  }

  const chatIds = Array.from(new Set(hits.map((h) => h.chat_id)));
  if (!chatIds.length) return NextResponse.json({ resultados: [] });

  // escopo de visao: so devolve o que o usuario pode ver
  const [ctx, vinculos, restr, convs, { data: resps }, { data: vis }] = await Promise.all([
    contextoVisao(user, perfil),
    vinculosBu(user.id, perfil.papel === "super_admin"),
    // RESTRICAO por funil/canal (Frente Q): a busca por CONTEUDO e a porta mais
    // barata pra achar conversa alheia, entao ela passa pelo mesmo recorte da
    // listagem. `null` = ninguem restringe, e o predicado age como antes.
    restricaoEmLote(
      user.id,
      perfil.papel === "super_admin",
      chatIds.map((chatId) => ({ canal, chatId }))
    ),
    fonteExterna(def)
      ? contaIg
        ? conversasIgPorIds(contaIg, chatIds)
        : Promise.resolve([] as any[])
      : db
          .from(T.conversas)
          .select("chat_id,nome,is_group,status")
          .in("chat_id", chatIds)
          .then((r) => (r.data ?? []) as any[]),
    db.from("conversa_responsaveis").select("chat_id,tipo,ref_id").eq("canal", canal).in("chat_id", chatIds),
    db.from("conversa_visibilidade").select("chat_id,tipo,ref_id").eq("canal", canal).in("chat_id", chatIds),
  ]);
  const respPorChat = new Map<string, Responsavel[]>();
  for (const r of resps ?? []) {
    const l = respPorChat.get(r.chat_id) || [];
    l.push({ tipo: r.tipo, ref_id: r.ref_id } as Responsavel);
    respPorChat.set(r.chat_id, l);
  }
  const visPorChat = new Map<string, VisibilidadeEntry[]>();
  for (const v of vis ?? []) {
    const l = visPorChat.get(v.chat_id) || [];
    l.push({ tipo: v.tipo, ref_id: v.ref_id } as VisibilidadeEntry);
    visPorChat.set(v.chat_id, l);
  }
  const nomePorChat = new Map((convs ?? []).map((c: any) => [c.chat_id, c]));
  const visiveis = new Set(
    chatIds.filter(
      (id) =>
        conversaVisivel(
          respPorChat.get(id) || [],
          user,
          perfil,
          ctx,
          (nomePorChat.get(id) as any)?.status,
          visPorChat.get(id) || [],
          vinculos,
          restr?.para(canal, id)
        ) && (!emb || emb.permite(id))
    )
  );

  const resultados = hits
    .filter((h) => visiveis.has(h.chat_id))
    .slice(0, 30)
    .map((h) => {
      const c: any = nomePorChat.get(h.chat_id) || {};
      const idx = (h.conteudo || "").toLowerCase().indexOf(q.toLowerCase());
      const ini = Math.max(0, idx - 40);
      return {
        chat_id: h.chat_id,
        chat_name: c.nome || h.chat_id,
        is_group: !!c.is_group,
        trecho: (ini > 0 ? "..." : "") + (h.conteudo || "").slice(ini, ini + 120),
        de: h.direcao === "out" ? h.enviado_por_nome || "Voce" : h.sender_name || null,
        quando: h.criada_em,
      };
    });
  return NextResponse.json({ resultados }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
