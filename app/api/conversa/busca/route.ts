import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, podeVerConversa } from "@/lib/perfil";
import { canalDe } from "@/lib/canal";
import { canalPorId, fonteExterna } from "@/lib/canais";
import { externaDisponivel, fonteLigada } from "@/lib/fonte-externa";
import { restricaoEfetiva } from "@/lib/embed";
import { buscarNaConversa } from "@/lib/tela-conversa-db";
import { MIN_TERMO_BUSCA, MAX_RESULTADOS_BUSCA, trechoDoTermo, casaTermo } from "@/lib/tela-conversa";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// BUSCA DENTRO DE UMA CONVERSA (card 86ak85nyv).
//
//   GET /api/conversa/busca?chat_id=&canal=&q=
//
// POR QUE ROTA PROPRIA, e nao um `chat_id` opcional em /api/busca:
//
//   * /api/busca responde "em QUE CONVERSAS aparece este termo" — agrupa por
//     conversa, corta em 60 hits e devolve nome/foto do contato. A pergunta
//     daqui e outra: "ONDE, nesta conversa, isso foi dito". A resposta e uma
//     lista de MENSAGENS em ordem cronologica, com trecho e ancora pra pular.
//     Uma rota com os dois formatos escondidos atras de um parametro opcional
//     seria duas rotas com um nome.
//   * O escopo tambem e diferente: /api/busca precisa filtrar N conversas
//     contra o predicado de visao (e por isso e caro); aqui a conversa e UMA e
//     `podeVerConversa` resolve tudo numa checagem.
//
// LIMITE DECLARADO (nao e bug escondido): a tela carrega as ULTIMAS 300
// mensagens (/api/messages). A busca varre o BANCO INTEIRO da conversa — entao
// ela acha mensagem que a tela nao tem em maos, e clicar nesse resultado nao
// pula pra lugar nenhum. A rota marca cada achado com `criada_em` e a tela
// avisa quando o alvo esta fora da janela carregada, em vez de fingir que o
// clique nao funcionou.
export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });

  const chatId = req.nextUrl.searchParams.get("chat_id");
  if (!chatId) return NextResponse.json({ error: "chat_id obrigatorio" }, { status: 400 });
  const q = String(req.nextUrl.searchParams.get("q") || "").trim();
  if (q.length < MIN_TERMO_BUSCA) {
    return NextResponse.json({ error: `busca com pelo menos ${MIN_TERMO_BUSCA} letras` }, { status: 400 });
  }
  const canal = canalDe(req);

  if (!(await podeVerConversa(chatId, user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(chatId)) return NextResponse.json({ error: "fora do contexto" }, { status: 403 });

  const def = canalPorId(canal)!;

  // Canal de fonte externa (instagram-agent): as mensagens nao moram no banco
  // do painel. A busca do agente e por CONTA, nao por conversa — entao filtramos
  // o resultado dela pelo chat_id, o que e correto mas nao pagina: quem tiver a
  // conversa gigante ve so os hits que couberam no teto do agente. Declarado
  // aqui em vez de recusado: buscar em 60 mensagens e melhor que nao buscar.
  if (fonteExterna(def)) {
    if (!externaDisponivel(def)) {
      return NextResponse.json({ achados: [], total: 0, aviso: "canal externo indisponivel nesta instalacao" });
    }
    const ext = await fonteLigada(def);
    const hits = ext ? await ext.buscarMensagens(q) : [];
    const daConversa = hits.filter((h: any) => String(h.chat_id) === chatId);
    return NextResponse.json(
      {
        achados: daConversa.slice(0, MAX_RESULTADOS_BUSCA).map((h: any) => ({
          id: String(h.id ?? h.provider_msg_id ?? h.criada_em),
          provider_msg_id: h.provider_msg_id ?? null,
          direcao: h.direcao ?? "in",
          criada_em: h.criada_em,
          autor: h.sender_name ?? h.enviado_por_nome ?? null,
          ...trechoDoTermo(h.conteudo, q),
        })),
        total: daConversa.length,
        truncado: false,
        parcial_fonte_externa: true,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const r = await buscarNaConversa(canal, chatId, q);
  if (!r.ok) return NextResponse.json({ achados: [], total: 0, aviso: r.aviso });

  // O ilike do banco casa por SUBSTRING CRUA; o trecho e o realce da tela saem
  // da comparacao NORMALIZADA (sem acento, sem caixa). Os dois criterios nao sao
  // iguais: "orçamento" no banco nao casa o ilike de "orcamento". Achado que o
  // banco trouxe e que o normalizado nao confirma segue na lista (o banco esta
  // certo, o termo aparece mesmo), so sem realce — descartar seria esconder
  // resultado verdadeiro por causa da diferenca entre os dois criterios.
  const achados = r.achados.map((m) => ({
    id: m.id,
    provider_msg_id: m.provider_msg_id,
    direcao: m.direcao,
    criada_em: m.criada_em,
    autor: m.direcao === "out" ? m.enviado_por_nome : m.sender_name,
    apagada: m.conteudo === null,
    realce: casaTermo(m.conteudo, q),
    ...trechoDoTermo(m.conteudo ?? "[mensagem apagada]", q),
  }));

  return NextResponse.json(
    { achados, total: achados.length, truncado: r.truncado },
    { headers: { "Cache-Control": "no-store" } }
  );
}
