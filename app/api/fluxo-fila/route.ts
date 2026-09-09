import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { getUser, identidadePorApiKey } from "@/lib/auth-server";
import { getPerfil, permitido, podeVerConversa } from "@/lib/perfil";
import { canalDe, canalDeBody } from "@/lib/canal";
import { canalPorId } from "@/lib/canais";
import { restricaoEfetiva } from "@/lib/embed";
import { moduloAtivo } from "@/lib/modulos";
import { validarFluxo } from "@/lib/fluxo/schema";
import type { Permissao } from "@/lib/permissoes";
import type { Perfil } from "@/lib/perfil";
import {
  cancelarCadeia,
  decidirAprovacao,
  enfileirarFluxo,
  fusoDaInstalacao,
  listarFila,
  trilhaDaConversa,
} from "@/lib/fluxo/fila-db";
import { ESTADOS_FILA, estadoFilaValido, type EstadoFila } from "@/lib/fluxo/fila";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// FILA DE AUTOMACAO — enfileirar, aprovar/recusar, cancelar e consultar a trilha.
// Frente P, 31/08/2026. Cards 86ak859wr, 86ak859xn e 86ak85zn1.
//
//   GET  ?estados=...            a fila (default: so o que esta VIVO)
//   GET  ?canal=&chat_id=        a fila DAQUELA conversa
//   GET  ?trilha=1&canal=&chat_id=   o que a automacao ja fez naquela conversa
//   POST { acao: "enfileirar" }  roda um fluxo COM atraso/aprovacao nesta conversa
//   POST { acao: "aprovar" | "recusar" }  decide o passo parado
//   POST { acao: "cancelar" }    para a cadeia
//
// PERMISSAO POR ACAO, e a divisao importa — cada gesto aqui e de uma natureza
// diferente, e uma permissao unica pra todos eles erra nas duas pontas:
//
//  - **enfileirar** e **cancelar** exigem `enviar`. Enfileirar E DISPARAR (a
//    mensagem sai pro cliente, so mais tarde); exigir `automacao` — a permissao de
//    CONFIGURAR automacao — tirava do atendente comum o direito de rodar uma regua
//    na propria conversa, coisa que ele ja faz a mao com macro. E cancelar tem que
//    ser MAIS facil que enfileirar, nunca mais dificil: quem pode iniciar a regua
//    precisa poder parar a regua que ele mesmo iniciou.
//  - **aprovar / recusar** exigem `aprovar_automacao`, permissao propria e
//    separada de `automacao` (quem escreve o fluxo nao e necessariamente quem
//    responde pelo que sai). Casa com a `CHATBOT.APPROVE` da ferramenta de origem.
//  - **ler a fila / a trilha** aceita `automacao` OU `aprovar_automacao`: quem
//    configura precisa ver o que esta rodando, e quem aprova precisa ver a fila
//    pra achar o que aprovar.
//
// GATE DE CONVERSA EM TODA ACAO, sem excecao: `podeVerConversa` + `restricaoEfetiva`,
// exatamente como /api/macros. Permissao nomeada diz O QUE a pessoa pode fazer; o
// gate de conversa diz ONDE. Aprovar, recusar e cancelar mexem em mensagem que vai
// pra uma conversa especifica — quem nao enxerga aquela conversa nao decide nela,
// mesmo com `aprovar_automacao` no papel.
//
// APROVACAO NAO ACEITA CHAVE DE API. Aprovar existe pra que uma PESSOA responda
// pelo que a automacao vai mandar; se um agente com `x-api-key` pudesse aprovar, o
// robo estaria aprovando o que existe justamente pra ser aprovado por humano — o
// campo viraria enfeite. Enfileirar e cancelar seguem valendo por chave (sao gestos
// de operacao, e o gate e `enviar`).
//
// AUTORIZACAO MORA AQUI, e so aqui. `lib/fluxo/fila-db.ts` recebe o usuario JA
// autorizado e grava quem foi na linha da fila; o tick roda em nome dele depois,
// sem reautorizar. Consequencia declarada no CLAUDE.md: tirar permissao de alguem
// NAO cancela o que ele enfileirou — cancelar e gesto explicito.

async function porteiro(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return { erro: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!(await moduloAtivo("automacao"))) {
    return {
      erro: NextResponse.json({ error: "modulo de automacao desligado nesta instalacao" }, { status: 403 }),
    };
  }
  const perfil = await getPerfil(user.id);
  return { user, perfil };
}

/** Tem ALGUMA das permissoes pedidas? (ou-logico, pra leitura de fila) */
function temAlguma(perfil: Perfil, ...quais: Permissao[]): boolean {
  return quais.some((p) => permitido(perfil, p));
}

const semCache = { "Cache-Control": "no-store, max-age=0" } as const;

function estadosPedidos(bruto: string | null): EstadoFila[] | undefined {
  if (!bruto) return undefined;
  const pedidos = bruto
    .split(",")
    .map((s) => s.trim())
    .filter(estadoFilaValido);
  return pedidos.length ? pedidos : undefined;
}

// ------------------------------------------------------------------- GET
export async function GET(req: NextRequest) {
  const p = await porteiro(req);
  if ("erro" in p) return p.erro;
  const { user, perfil } = p;

  if (!temAlguma(perfil, "automacao", "aprovar_automacao")) {
    return NextResponse.json({ error: "sem permissao de automacao" }, { status: 403 });
  }

  const url = new URL(req.url);
  const chatId = url.searchParams.get("chat_id");
  const canal = canalDe(req);
  const fuso = await fusoDaInstalacao();

  // Restricao de contexto (embed/vinculo) e resolvida SEMPRE, com ou sem chat_id:
  // sem chat_id a lista atravessa conversas, e e exatamente ai que ela precisa ser
  // recortada. Antes isto so era consultado quando havia chat_id — quem abrisse a
  // fila inteira de dentro de um embed via a fila da conta.
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });

  // Conversa informada = GATE DE CONVERSA tambem na leitura. Sem isto, quem tem a
  // permissao `automacao` mas escopo restrito leria, pela trilha, o TEXTO de
  // mensagem de conversa fora do escopo dele (o `detalhe` do passo carrega o
  // resumo da acao). A permissao de automacao e sobre AUTOMACAO, nao sobre as
  // conversas dos outros.
  if (chatId) {
    if (!(await podeVerConversa(chatId, user, perfil, canal))) {
      return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
    }
    if (emb && !emb.permite(chatId)) {
      return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
    }
  }

  if (url.searchParams.get("trilha") === "1") {
    if (!chatId) {
      return NextResponse.json({ error: "chat_id obrigatorio pra ler a trilha" }, { status: 400 });
    }
    const t = await trilhaDaConversa(canal, chatId);
    if (!t.ok) {
      // nunca 500: trilha indisponivel devolve vazio com aviso (promessa de
      // /api/macros e /api/fluxos)
      return NextResponse.json(
        { execucoes: [], por_mensagem: {}, vinculo_disponivel: false, aviso: t.aviso, fuso },
        { headers: semCache }
      );
    }
    return NextResponse.json({ ...t, fuso }, { headers: semCache });
  }

  const lista = await listarFila({
    canal: chatId ? canal : undefined,
    chat_id: chatId ?? undefined,
    estados: estadosPedidos(url.searchParams.get("estados")),
  });
  if (!lista.ok) {
    return NextResponse.json({ itens: [], aviso: lista.aviso, fuso }, { headers: semCache });
  }

  // Sem chat_id, a lista atravessa conversas — entao ela e FILTRADA pelo escopo de
  // quem pediu. Fazer isso na memoria (e nao no SQL) e o padrao do repo:
  // `podeVerConversa` mora em lib/perfil.ts e conhece visibilidade, departamento e
  // responsavel; reimplementar isso em filtro de PostgREST seria a segunda copia
  // da regra de visibilidade — e a que ia divergir.
  let itens = lista.itens;
  if (!chatId) {
    const permitidos: typeof itens = [];
    for (const i of itens) {
      if (emb && !emb.permite(i.chat_id)) continue;
      if (await podeVerConversa(i.chat_id, user, perfil, i.canal)) permitidos.push(i);
    }
    itens = permitidos;
  }

  return NextResponse.json(
    {
      itens,
      estados_possiveis: ESTADOS_FILA,
      aguardando_aprovacao: itens.filter((i) => i.estado === "aguardando_aprovacao").length,
      // a tela precisa saber se ESTE usuario decide, ou se ele so esta olhando —
      // botao que existe e devolve 403 e pior que botao ausente
      pode_aprovar: permitido(perfil, "aprovar_automacao") && !identidadePorApiKey(req),
      pode_cancelar: permitido(perfil, "enviar"),
      // rodar o tick a mao e da permissao de AUTOMACAO (e a mesma da rota do cron):
      // quem so aprova nao precisa do botao, e botao que devolve 403 e pior que nenhum
      pode_rodar_tick: permitido(perfil, "automacao"),
      fuso,
    },
    { headers: semCache }
  );
}

// ------------------------------------------------------------------ POST
export async function POST(req: NextRequest) {
  const p = await porteiro(req);
  if ("erro" in p) return p.erro;
  const { user, perfil } = p;

  const body = await req.json().catch(() => ({} as any));
  const acao = typeof body?.acao === "string" ? body.acao : "";
  const quem = { id: user.id, nome: user.nome };

  /**
   * Le a conversa do item e aplica o gate de conversa. Um lugar so pras tres acoes
   * que agem sobre um item existente (aprovar, recusar, cancelar) — a copia dessa
   * checagem em cada ramo era o jeito mais facil de esquecer `restricaoEfetiva` em
   * um deles.
   */
  async function itemNoMeuEscopo(id: string) {
    const { data: linha, error } = await msgDb()
      .from("fluxo_fila")
      .select("canal,chat_id")
      .eq("id", id)
      .maybeSingle();
    if (error) {
      return { erro: NextResponse.json({ error: "fila indisponivel nesta instalacao" }, { status: 503 }) };
    }
    if (!linha) {
      return { erro: NextResponse.json({ error: "item da fila nao encontrado" }, { status: 404 }) };
    }
    const canalItem = (linha as any).canal as string;
    const chatItem = (linha as any).chat_id as string;
    if (!(await podeVerConversa(chatItem, user, perfil, canalItem))) {
      return { erro: NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 }) };
    }
    const emb = await restricaoEfetiva(req, user, perfil);
    if (emb === "invalido") {
      return { erro: NextResponse.json({ error: "contexto invalido" }, { status: 401 }) };
    }
    if (emb && !emb.permite(chatItem)) {
      return { erro: NextResponse.json({ error: "fora do contexto" }, { status: 403 }) };
    }
    return { canal: canalItem, chat_id: chatItem };
  }

  // --------------------------------------------------- aprovar / recusar
  if (acao === "aprovar" || acao === "recusar") {
    // ROBO NAO APROVA O QUE EXISTE PRA HUMANO APROVAR. A checagem vem ANTES da
    // permissao de proposito: a mensagem tem que dizer que o problema e a VIA, nao
    // o papel — senao alguem "resolve" dando `aprovar_automacao` pra chave de API.
    if (identidadePorApiKey(req)) {
      return NextResponse.json(
        {
          error:
            "aprovacao exige sessao de login: chave de API nao aprova automacao " +
            "(o passo pediu aval HUMANO — aprove no painel)",
        },
        { status: 403 }
      );
    }
    if (!permitido(perfil, "aprovar_automacao")) {
      return NextResponse.json({ error: "sem permissao pra aprovar automacao" }, { status: 403 });
    }

    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id do item da fila obrigatorio" }, { status: 400 });

    // GATE DE CONVERSA tambem aqui: aprovar libera uma MENSAGEM pro cliente. Quem
    // nao pode ver aquela conversa nao decide o que sai nela.
    const escopo = await itemNoMeuEscopo(id);
    if ("erro" in escopo) return escopo.erro;

    const r = await decidirAprovacao(id, acao === "aprovar" ? "aprovado" : "recusado", quem, "sessao");
    if (!r.ok) return NextResponse.json({ error: r.erro }, { status: r.http });
    return NextResponse.json({ ...r, aprovado_por: quem.nome, aprovado_via: "sessao" });
  }

  // ------------------------------------------------------------- cancelar
  if (acao === "cancelar") {
    if (!permitido(perfil, "enviar")) {
      return NextResponse.json({ error: "sem permissao de envio" }, { status: 403 });
    }
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id do item da fila obrigatorio" }, { status: 400 });

    const escopo = await itemNoMeuEscopo(id);
    if ("erro" in escopo) return escopo.erro;

    const r = await cancelarCadeia(id, quem);
    if (!r.ok) return NextResponse.json({ error: r.erro }, { status: r.http });
    return NextResponse.json({ ok: true, cancelada_por: quem.nome });
  }

  // ----------------------------------------------------------- enfileirar
  if (acao === "enfileirar") {
    if (!permitido(perfil, "enviar")) {
      return NextResponse.json({ error: "sem permissao de envio" }, { status: 403 });
    }
    const slug = typeof body?.slug === "string" ? body.slug : "";
    const chatId = typeof body?.chat_id === "string" ? body.chat_id : "";
    if (!slug) return NextResponse.json({ error: "slug do fluxo obrigatorio" }, { status: 400 });
    if (!chatId) return NextResponse.json({ error: "chat_id obrigatorio" }, { status: 400 });

    // canal EXPLICITO ou nada, mesma trava do /api/macros: `canalDeBody` cai no
    // "central" quando nao reconhece, e um typo faria a regua inteira rodar no
    // numero principal.
    if (body?.canal !== undefined) {
      const c = canalPorId(body.canal);
      if (!c || !c.ativo) {
        return NextResponse.json({ error: "canal desconhecido ou inativo" }, { status: 400 });
      }
    }
    const canal = canalDeBody(body);

    const emb = await restricaoEfetiva(req, user, perfil);
    if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
    if (!(await podeVerConversa(chatId, user, perfil, canal))) {
      return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
    }
    if (emb && !emb.permite(chatId)) {
      return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
    }

    const { data: row, error } = await msgDb()
      .from("fluxos")
      .select("id,slug,fluxo,ativo")
      .eq("slug", slug)
      .maybeSingle();
    if (error) return NextResponse.json({ error: "fluxos indisponiveis nesta instalacao" }, { status: 503 });
    if (!row || (row as any).ativo === false) {
      return NextResponse.json({ error: "fluxo nao encontrado ou desligado" }, { status: 404 });
    }
    const v = validarFluxo((row as any).fluxo);
    if (!v.ok) {
      return NextResponse.json(
        { error: "fluxo invalido (fora do formato canonico)", erros: v.erros.slice(0, 5) },
        { status: 422 }
      );
    }

    // ORIGEM: enfileirar pela API e gesto de GENTE, entao "manual" e o default —
    // e isso decide gente x robo no status da conversa (Frente N). O gatilho v2,
    // quando nascer, passa "gatilho" e obedece `auto_atendimento_bot`. Aceitar
    // "gatilho" aqui por parametro seria dar ao cliente da API o poder de mentir
    // sobre quem disparou; so quem tem permissao de automacao consegue, e mesmo
    // assim fica gravado quem foi.
    const r = await enfileirarFluxo(v.fluxo, {
      canal,
      chat_id: chatId,
      usuario: quem,
      origem: "manual",
      fluxo_id: (row as any).id ?? null,
    });
    if (!r.ok) return NextResponse.json({ error: r.erro }, { status: r.http });
    return NextResponse.json(r, { status: 201 });
  }

  return NextResponse.json({ error: "acao desconhecida" }, { status: 400 });
}
