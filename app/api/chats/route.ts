import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { getUser, respostaSemAcesso } from "@/lib/auth-server";
import { canalPermitido, restricaoDeConversas, restricaoEmLote } from "@/lib/acesso";
import { fotoPublica } from "@/lib/foto";
import { getPerfil, contextoVisao, conversaVisivel, Responsavel, VisibilidadeEntry } from "@/lib/perfil";
import { canalDe, tabelas } from "@/lib/canal";
import { canalPorId, canaisAtivos, canalPublico, fonteExterna } from "@/lib/canais";
import { externaDisponivel, fonteLigada } from "@/lib/fonte-externa";
import { estadosDe } from "@/lib/estado-externo";
import { sincronizarApioficial } from "@/lib/sync-apioficial";
import { fusoDaConfig, getConfig } from "@/lib/config";
import { restricaoEfetiva, vinculosBu } from "@/lib/embed";
import { BUSCA_MAX, criteriosDeBusca, cursorAntes, normalizarLimite, PAGINA_PADRAO } from "@/lib/lista-conversas";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// COLUNAS DA 0017 NA LISTAGEM (`inicio_estado`) — degradacao em duas camadas.
// A migration e gesto humano: pedir a coluna numa instalacao que nao rodou
// derrubaria a listagem INTEIRA. Entao a leitura tenta com a coluna, e o
// 42703/PGRST204 desliga o campo por 60s e refaz sem ele. Re-testa depois: a
// migration passa a valer sem redeploy.
const COL_INEXISTENTE = ["42703", "PGRST204"];
const RETESTE_MS = 60_000;
let inicio0017 = true;
let inicio0017Em = 0;
function COLUNAS_CONVERSA() {
  if (!inicio0017 && Date.now() - inicio0017Em > RETESTE_MS) inicio0017 = true;
  const base =
    "chat_id,nome,is_group,foto_url,foto_wa_url,last_message_at,last_message_preview,status,responsavel_id,responsavel_nome,responsavel_tipo,mensagens_nao_lidas,arquivada,auto_arquivar";
  return inicio0017 ? `${base},inicio_estado` : base;
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) {
    // 403 com o MOTIVO quando a credencial e valida e foi a POLITICA que barrou
    // (janela de acesso, dispositivo revogado, escopo da chave). Esta e a
    // primeira rota que a tela chama depois do login, entao e por aqui que a
    // pessoa barrada descobre o porque. Ver `respostaSemAcesso`.
    return respostaSemAcesso(req);
  }
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") {
    return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  }
  const db = msgDb();
  const canal = canalDe(req);
  const T = tabelas(canal);
  const def = canalPorId(canal)!;
  const ctx = await contextoVisao(user, perfil);

  // conversas + ultimas mensagens vem do banco do painel (WhatsApp) OU da fonte
  // externa (instagram-agent / whatsapp-agent, via lib/fonte-externa.ts). Daqui pra
  // baixo a rota e a MESMA: responsaveis, visibilidade, escopo e previa moram no painel.
  // ALEM DA JANELA (decisao do Eric, 03/09/2026 — lib/lista-conversas.ts): a
  // listagem cortava em 600 por canal, calada, e 95% do acervo ficava invisivel.
  //   ?q=      busca no ACERVO por nome (contem) ou digitos do numero (>= 3)
  //   ?antes=  proxima pagina: conversas mais antigas que esta last_message_at
  //   ?limite= tamanho da pagina (50..600; default 600 = o teto historico)
  // `tem_mais` na resposta diz se ainda ha conversa mais antiga que a ultima
  // devolvida — e o que acende o "Carregar conversas mais antigas" na tela.
  const busca = criteriosDeBusca(req.nextUrl.searchParams.get("q"));
  const antes = cursorAntes(req.nextUrl.searchParams.get("antes"));
  const limite = busca ? BUSCA_MAX : normalizarLimite(req.nextUrl.searchParams.get("limite") ?? PAGINA_PADRAO);

  let conversas: any[] = [];
  let ultimas: any[] = [];
  let temMais = false;
  if (fonteExterna(def)) {
    // sem env ou conta nao conectada no agente: o canal existe, lista vazia — nunca 500
    // (fonte externa nao pagina nem busca: a lista dela ja e o que o agente devolve)
    const ext = await fonteLigada(def);
    if (ext) [conversas, ultimas] = await Promise.all([ext.listarConversas(), ext.ultimasMensagens()]);
    // o ESTADO (status, arquivo, responsavel legado) e do painel; o conteudo e do agente
    const estados = await estadosDe(canal, conversas.map((c) => c.chat_id));
    conversas = conversas.map((c) => {
      const e = estados.get(c.chat_id);
      return e ? { ...c, status: e.status, arquivada: e.arquivada, auto_arquivar: e.auto_arquivar, responsavel_id: e.responsavel_id, responsavel_nome: e.responsavel_nome, responsavel_tipo: e.responsavel_tipo } : c;
    });
  } else {
    // canal oficial: materializa a entrada nova (Gupshup -> webhook_events) antes de listar
    if (canal === "apioficial") await sincronizarApioficial();
    // UMA consulta base; a busca por nome e a por numero saem em consultas
    // separadas e sao juntadas aqui (sem `.or()` montado por string: o texto e do
    // usuario e virgula/parentese quebrariam a sintaxe do PostgREST).
    const consulta = (cols: string, criterio?: "nome" | "digitos") => {
      let q = db.from(T.conversas).select(cols);
      if (antes) q = q.lt("last_message_at", antes);
      if (busca && criterio === "nome") q = q.ilike("nome", busca.nome!);
      if (busca && criterio === "digitos") q = q.like("chat_id", `%${busca.digitos}%`);
      return q.order("last_message_at", { ascending: false, nullsFirst: false }).limit(limite);
    };
    const lerConversas = async (cols: string) => {
      if (!busca) return consulta(cols);
      const partes = await Promise.all([
        consulta(cols, "nome"),
        ...(busca.digitos ? [consulta(cols, "digitos")] : []),
      ]);
      const erro = partes.find((p) => p.error);
      if (erro) return erro;
      const vistos = new Set<string>();
      const juntos: any[] = [];
      for (const p of partes)
        for (const c of (p.data ?? []) as any[]) {
          if (vistos.has(c.chat_id)) continue;
          vistos.add(c.chat_id);
          juntos.push(c);
        }
      juntos.sort((a, b) => (b.last_message_at || "").localeCompare(a.last_message_at || ""));
      return { data: juntos.slice(0, limite), error: null } as any;
    };
    const [convRes, msgRes] = await Promise.all([
      lerConversas(COLUNAS_CONVERSA()),
      // previa DERIVADA da mensagem real: o valor gravado pode envelhecer quando
      // uma mensagem e apagada. O gravado fica de reserva pras conversas antigas
      // (importadas da listagem Z-API, que nao tem mensagem no nosso banco).
      db
        .from(T.mensagens)
        .select("chat_id,conteudo,direcao,enviado_por_nome,criada_em,is_deleted")
        // anotacao interna (ChatGuru/painel) nao e mensagem: nao pode virar previa
        .neq("direcao", "interna")
        .order("criada_em", { ascending: false })
        .limit(1500),
    ]);
    if (convRes.error) {
      // `inicio_estado` e coluna da 0017, e a migration e gesto humano: numa
      // instalacao que ainda nao rodou, pedi-la derrubaria a LISTAGEM INTEIRA
      // (42703/PGRST204). Aqui a falha de coluna faz UMA nova leitura sem ela e
      // desliga o campo por 60s — o painel abre igual, so sem o selo de "nao
      // enviada". Padrao de /api/fluxos com as colunas da 0015.
      if (COL_INEXISTENTE.includes(String(convRes.error.code ?? "")) && inicio0017) {
        inicio0017 = false;
        inicio0017Em = Date.now();
        const retry = await lerConversas(COLUNAS_CONVERSA());
        if (retry.error) {
          console.error("chats:", retry.error.message);
          return NextResponse.json({ error: "falha ao carregar conversas" }, { status: 500 });
        }
        conversas = retry.data ?? [];
        ultimas = msgRes.data ?? [];
      } else {
        console.error("chats:", convRes.error.message);
        return NextResponse.json({ error: "falha ao carregar conversas" }, { status: 500 });
      }
    } else {
      conversas = convRes.data ?? [];
      ultimas = msgRes.data ?? [];
    }
    // pagina cheia = provavelmente ha mais (a busca nao pagina: ela ja e um recorte)
    temMais = !busca && conversas.length >= limite;
  }

  // responsaveis SO das conversas listadas, em lotes de 200 ids (o antigo
  // limit global de 4000 truncava CALADO — o canal central passou de 8k linhas
  // e conversa COM dono parecia sem dono, fail-open pra escopo proprias/depto)
  const idsListados = conversas.map((c) => c.chat_id);
  const lotesResp = [];
  const lotesVis = [];
  for (let i = 0; i < idsListados.length; i += 200) {
    lotesResp.push(
      db
        .from("conversa_responsaveis")
        .select("chat_id,tipo,ref_id,nome")
        .eq("canal", canal)
        .in("chat_id", idsListados.slice(i, i + 200))
        .order("criado_em", { ascending: true })
    );
    // ACL fixa por chat (F9), mesma janela e mesmo padrao de lote
    lotesVis.push(
      db
        .from("conversa_visibilidade")
        .select("chat_id,tipo,ref_id,nome")
        .eq("canal", canal)
        .in("chat_id", idsListados.slice(i, i + 200))
        .order("criado_em", { ascending: true })
    );
  }
  const [respLotes, visLotes, vinculos, restr] = await Promise.all([
    Promise.all(lotesResp),
    Promise.all(lotesVis),
    vinculosBu(user.id, perfil.papel === "super_admin"),
    // RESTRICAO por funil/canal (Frente Q, card 86ak85zm4). `null` = ninguem
    // restringe esta pessoa, e o predicado se comporta como antes da feature.
    restricaoEmLote(
      user.id,
      perfil.papel === "super_admin",
      idsListados.map((chatId) => ({ canal, chatId }))
    ),
  ]);
  const respRes = { data: respLotes.flatMap((r) => r.data ?? []) };

  const visPorChat = new Map<string, { tipo: string; id: string; nome: string }[]>();
  for (const v of visLotes.flatMap((r) => r.data ?? [])) {
    const l = visPorChat.get(v.chat_id) || [];
    l.push({ tipo: v.tipo, id: v.ref_id, nome: v.nome });
    visPorChat.set(v.chat_id, l);
  }

  const derivado: Record<string, { texto: string; ts: string }> = {};
  for (const m of ultimas) {
    if (derivado[m.chat_id]) continue;
    const quem = m.direcao === "out" ? `${m.enviado_por_nome || "Voce"}: ` : "";
    // a assinatura "*Nome:*" ja vai no corpo da enviada — na previa ela duplicaria o nome
    const corpo = m.is_deleted
      ? "Mensagem apagada"
      : (m.conteudo ?? "").replace(/^\*[^*\n]{1,60}:\*\s*/, "");
    derivado[m.chat_id] = { texto: `${quem}${corpo}`.slice(0, 140), ts: m.criada_em };
  }

  // responsaveis N:N por conversa (varias pessoas E departamentos juntos)
  const respPorChat = new Map<string, { tipo: string; id: string; nome: string }[]>();
  for (const r of respRes.data ?? []) {
    const l = respPorChat.get(r.chat_id) || [];
    l.push({ tipo: r.tipo, id: r.ref_id, nome: r.nome });
    respPorChat.set(r.chat_id, l);
  }

  // escopo de visao (proprias/departamento/todas) definido pelo super admin;
  // contexto de embed e INTERSECAO com esse escopo, nunca substituto
  const visiveis = conversas.filter(
    (c) =>
      conversaVisivel(
        (respPorChat.get(c.chat_id) || []).map((r) => ({ tipo: r.tipo, ref_id: r.id })) as Responsavel[],
        user,
        perfil,
        ctx,
        c.status,
        (visPorChat.get(c.chat_id) || []).map((v) => ({ tipo: v.tipo, ref_id: v.id })) as VisibilidadeEntry[],
        vinculos,
        restr?.para(canal, c.chat_id)
      ) && (!emb || emb.permite(c.chat_id))
  );

  const chats = visiveis.map((c) => {
    const d = derivado[c.chat_id];
    return {
      // canal de origem: a UI junta N canais numa lista so e precisa saber de
      // onde veio cada conversa (identidade composta canal+chat_id)
      canal,
      chat_id: c.chat_id,
      chat_name: c.nome,
      is_group: c.is_group,
      // Instagram nao tem telefone: chat_id la e o IGSID do interlocutor
      phone: def.tipo === "whatsapp" ? c.chat_id : null,
      // foto do WhatsApp primeiro; a do ChatGuru so serve se for publica
      profile_thumbnail: fotoPublica(c.foto_wa_url) || fotoPublica(c.foto_url),
      last_message_at: d?.ts ?? c.last_message_at,
      preview: d?.texto ?? c.last_message_preview,
      status: c.status || "aberto",
      responsaveis: respPorChat.get(c.chat_id) || [],
      // legado: nome importado do ChatGuru sem conta no painel (sem id resolvido)
      responsavel_nome: c.responsavel_nome,
      responsavel_id: c.responsavel_id,
      nao_lidas: c.mensagens_nao_lidas || 0,
      arquivada: !!c.arquivada,
      auto_arquivar: !!c.auto_arquivar,
      // 0017: conversa aberta pelo painel cujo envio FALHOU. Sem isto na lista, a
      // linha aparece igual a qualquer outra e ninguem descobre que a mensagem
      // nao saiu. `null` (nao ausente) quando a instalacao nao tem a coluna:
      // o front trata null como "sem selo", e o campo existe sempre.
      inicio_estado: c.inicio_estado ?? null,
      visibilidade: visPorChat.get(c.chat_id) || [],
    };
  });

  chats.sort((a, b) => (b.last_message_at || "").localeCompare(a.last_message_at || ""));

  // o cliente aplica o desligamento por inatividade com esse valor (0 = nunca);
  // canal_oficial diz se o seletor de numero aparece (conector Gupshup presente)
  // `fuso` vai junto porque a UI formata TODA hora e decide "Hoje/Ontem" com ele:
  // sem isso o painel usaria o fuso do navegador de cada atendente, e dois
  // atendentes veriam separadores de dia diferentes na MESMA conversa.
  const cfg = await getConfig();
  const { auto_logout_minutos } = cfg;
  const fuso = fusoDaConfig(cfg);
  const { credsGupshup } = await import("@/lib/gupshup");
  const canal_oficial = !!(await credsGupshup().catch(() => null));
  // canais = registro completo pro seletor multi-canal (lib/canais.ts); o
  // apioficial so entra quando o conector Gupshup existe (mesma regra do flag
  // legado canal_oficial, que segue na resposta pra UI atual)
  // canal de fonte externa so entra quando a env da fonte existe (mesma logica)
  // RESTRICAO POR NUMERO na TELA (Frente Q): o seletor nao pode oferecer canal
  // que a pessoa nao alcanca. O gate de verdade e o predicado acima (a lista de
  // conversas do canal proibido ja sai vazia); esconder aqui evita a tela
  // mentir, oferecendo um numero que devolve nada.
  const restricaoCanais = await restricaoDeConversas(user.id, perfil.papel === "super_admin");
  const canais = canaisAtivos()
    .filter((c) => c.id !== "apioficial" || canal_oficial)
    .filter((c) => !fonteExterna(c) || externaDisponivel(c))
    .filter((c) => canalPermitido(restricaoCanais, c.id))
    .map(canalPublico);
  return NextResponse.json(
    {
      chats,
      auto_logout_minutos,
      canal_oficial,
      canais,
      fuso,
      // paginacao/busca no acervo (03/09/2026): o que a tela precisa pra decidir
      // se oferece "mais antigas" e pra saber que recorte esta resposta e
      tem_mais: temMais,
      pagina: { q: busca ? req.nextUrl.searchParams.get("q") : null, antes, limite },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
