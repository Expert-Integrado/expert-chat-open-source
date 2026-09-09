import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, podeVerConversa } from "@/lib/perfil";
import { canalDe } from "@/lib/canal";
import { canalPorId, fonteExterna } from "@/lib/canais";
import { restricaoEfetiva } from "@/lib/embed";
import {
  historicoStatus,
  historicoTransferencia,
  historicoAvaliacoes,
  midiaDaConversa,
  estadoDoRobo,
  historicoRobo,
} from "@/lib/tela-conversa-db";
import { linhaDoTempoStatus, linhaDoTempoTransferencia, agruparMidia } from "@/lib/tela-conversa";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// OS HISTORICOS DA CONVERSA — cards 86ak85nx0 (status, NPS/avaliacoes, midia) e
// 86ak85nwu (transferencia).
//
//   GET /api/conversa/historicos?chat_id=&canal=&tipo=status|avaliacoes|midia|transferencias
//
// UMA ROTA COM `tipo`, e nao quatro rotas: os quatro paineis vivem no MESMO
// lugar da tela (as abas da ficha), pedem exatamente a MESMA autorizacao
// (podeVerConversa + contexto de embed) e sao carregados um por vez, quando a
// aba abre. Quatro arquivos repetiriam quatro vezes o mesmo preambulo de
// autorizacao — que e o jeito conhecido de uma delas divergir das outras.
//
// SEM A MIGRATION 0017: status e transferencias respondem lista vazia COM
// `aviso` (nunca 500). Avaliacoes e midia nao dependem da 0017 e funcionam
// desde ja — as tabelas `avaliacoes` (0001) e `nps_respostas` (0013) existem.
//
// Vazio CALADO seria pior que erro: "essa conversa nunca mudou de status" e uma
// afirmacao, e a tela nao pode fazer essa afirmacao quando a verdade e "a
// trilha nao existe nesta instalacao".

// `robo` nao e historico, e mora aqui de propostio: e o unico outro dado POR
// CONVERSA que a tela precisa ler ao abrir, com exatamente a mesma autorizacao.
// A alternativa era acrescentar `bot_ativo` ao select de /api/chats — que e a
// listagem de TODAS as conversas, no caminho de polling do painel, e que
// responderia 42703 e derrubaria a lista inteira em instalacao sem a 0017. Uma
// leitura a mais ao abrir a conversa e barata; a lista quebrada nao e.
const TIPOS = ["status", "avaliacoes", "midia", "transferencias", "robo"] as const;
type Tipo = (typeof TIPOS)[number];

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });

  const chatId = req.nextUrl.searchParams.get("chat_id");
  if (!chatId) return NextResponse.json({ error: "chat_id obrigatorio" }, { status: 400 });
  const tipo = String(req.nextUrl.searchParams.get("tipo") || "") as Tipo;
  if (!TIPOS.includes(tipo)) {
    return NextResponse.json({ error: `tipo invalido (use ${TIPOS.join(" | ")})` }, { status: 400 });
  }
  const canal = canalDe(req);

  if (!(await podeVerConversa(chatId, user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(chatId)) return NextResponse.json({ error: "fora do contexto" }, { status: 403 });

  const semCache = { headers: { "Cache-Control": "no-store" } };
  const def = canalPorId(canal)!;
  const externo = fonteExterna(def);

  if (tipo === "robo") {
    // canal de fonte externa nao tem conversa no banco do painel: o robo nao
    // age la, e a tela esconde o botao em vez de mostrar um que nao faz nada
    if (externo) return NextResponse.json({ disponivel: false, bot_ativo: true, eventos: [] }, semCache);
    const [r, hist] = await Promise.all([estadoDoRobo(canal, chatId), historicoRobo(canal, chatId)]);
    // a trilha do robo vive na tabela de eventos de status com `origem: "robo"`
    // — mesma classe de defeito, mesma trilha. A leitura filtra por origem, e a
    // linha do tempo de status filtra esses eventos FORA (senao poluem a
    // medicao de permanencia por status).
    // trilha indisponivel devolve o AVISO, como as outras abas: lista vazia
    // calada afirmaria "ninguem nunca mexeu no robo desta conversa", que e
    // exatamente o que a tela nao sabe quando a leitura falhou.
    return NextResponse.json(
      {
        ...r,
        eventos: hist.ok ? hist.eventos : [],
        ...(hist.ok ? {} : { aviso: [r.aviso, hist.aviso].filter(Boolean).join(" · ") }),
      },
      semCache
    );
  }

  if (tipo === "status") {
    // Canal de fonte externa nao tem linha de conversa no painel, entao nao tem
    // troca de status feita AQUI — e a trilha e do painel, nao da fonte.
    if (externo) {
      return NextResponse.json(
        { linhas: [], resumo: [], aviso: "status nao se aplica a canal de fonte externa (somente leitura)" },
        semCache
      );
    }
    const r = await historicoStatus(canal, chatId);
    if (!r.ok) {
      return NextResponse.json({ linhas: [], resumo: [], resumo_parcial: false, aviso: r.aviso }, semCache);
    }
    // `truncado` entra no calculo: o resumo "tempo em cada status" soma o que
    // veio, e numa conversa com mais trocas que o teto isso NAO e o total.
    // `linhaDoTempoStatus` devolve `resumo_parcial` e a tela rotula em vez de
    // apresentar a fatia como se fosse a conta fechada.
    return NextResponse.json({ ...linhaDoTempoStatus(r.eventos, { truncado: r.truncado }), truncado: r.truncado }, semCache);
  }

  if (tipo === "transferencias") {
    const r = await historicoTransferencia(canal, chatId);
    if (!r.ok) return NextResponse.json({ linhas: [], truncado: false, aviso: r.aviso }, semCache);
    return NextResponse.json(
      { linhas: linhaDoTempoTransferencia(r.eventos), truncado: r.truncado },
      semCache
    );
  }

  if (tipo === "avaliacoes") {
    const r = await historicoAvaliacoes(canal, chatId);
    return NextResponse.json(
      { csat: r.csat, nps: r.nps, avisos: r.avisos },
      semCache
    );
  }

  // midia
  if (externo) {
    return NextResponse.json(
      { abas: { media: [], document: [], sticker: [] }, truncado: false, aviso: "galeria de midia ainda nao disponivel neste canal" },
      semCache
    );
  }
  const r = await midiaDaConversa(canal, chatId);
  if (!r.ok) {
    return NextResponse.json(
      { abas: { media: [], document: [], sticker: [] }, truncado: false, aviso: r.aviso },
      semCache
    );
  }
  return NextResponse.json({ abas: agruparMidia(r.itens), truncado: r.truncado }, semCache);
}
