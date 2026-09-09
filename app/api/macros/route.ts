import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import { getPerfil, permitido, podeVerConversa } from "@/lib/perfil";
import { canalDe, canalDeBody } from "@/lib/canal";
import { canalPorId } from "@/lib/canais";
import { restricaoEfetiva } from "@/lib/embed";
import { moduloAtivo } from "@/lib/modulos";
import { validarFluxo, acoesDoFluxo, type Fluxo } from "@/lib/fluxo/schema";
import { executarMacro, motivoParaRecusar } from "@/lib/fluxo/executar";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
// macro com espera inline (ate 15s) + varios envios cabe folgado aqui
export const maxDuration = 60;

// MACROS — modulo `automacao` (desligado por default na instalacao).
//
// GET  = lista os macros disponiveis
// POST = executa UM macro numa conversa
//
// Superficie de propósito minima: e backend. A tela do macro (botao na conversa)
// e outra etapa, com validacao visual do Eric.

async function moduloLigado() {
  return moduloAtivo("automacao");
}

const RESP_MODULO_OFF = () =>
  NextResponse.json({ error: "modulo de automacao desligado nesta instalacao" }, { status: 403 });

function resumo(fluxo: Fluxo) {
  return {
    slug: fluxo.id,
    nome: fluxo.nome,
    descricao: fluxo.descricao ?? null,
    // o que o macro faz, na ordem — o suficiente pra tela mostrar antes de disparar.
    // FILTRA no sem acao: no de condicao/gatilho existe no formato (fluxo de tipo
    // "gatilho") e nao carrega acao. Sem o filtro, UMA linha com jsonb de tipo
    // divergente da coluna derruba o GET inteiro pra todo mundo com 500 — numa
    // rota que promete justamente nunca dar 500.
    acoes: acoesDoFluxo(fluxo),
    origem: fluxo.origem ?? null,
  };
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await moduloLigado())) return RESP_MODULO_OFF();

  const canal = canalDe(req);
  // ENFILEIRAR exige a permissao `enviar` na rota da fila (POST /api/fluxo-fila).
  // Sem consultar isso aqui, a tela ofereceria "rodar pela fila" pra quem vai
  // receber 403 no clique — botao que existe e nao funciona e pior que botao
  // ausente. `enviar` e a mesma permissao que ja governa o POST deste arquivo.
  const podeEnviar = permitido(await getPerfil(user.id), "enviar");
  // tabela `fluxos` pode nao existir ainda (a 0008 e gesto humano no SQL Editor):
  // lista vazia com aviso, nunca 500
  const { data, error } = await msgDb()
    .from("fluxos")
    .select("slug,nome,tipo,fluxo")
    .eq("tipo", "macro")
    .eq("ativo", true)
    .order("nome");
  if (error) {
    return NextResponse.json(
      { macros: [], aviso: "nenhum fluxo disponivel (a migration 0008 ja foi aplicada nesta instalacao?)" },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }

  const macros: any[] = [];
  for (const row of data ?? []) {
    // Cada linha e isolada: linha ruim vira ITEM MARCADO, nunca excecao. Esta
    // rota le jsonb que pode ter sido gravado por importacao, por outra versao
    // do schema ou a mao — assumir que o conteudo bate com a coluna e o jeito
    // de transformar 1 linha ruim em 500 pra todo mundo.
    try {
      const v = validarFluxo(row.fluxo);
      if (!v.ok) {
        macros.push({ slug: row.slug, nome: row.nome, invalido: true, erros: v.erros.slice(0, 5) });
        continue;
      }
      // coluna diz uma coisa e o jsonb diz outra: a linha esta inconsistente e
      // NAO pode ser oferecida como macro (o motor recusaria depois, mas o
      // resumo ja teria mentido sobre o que ela faz)
      if (v.fluxo.tipo !== row.tipo) {
        macros.push({
          slug: row.slug,
          nome: row.nome,
          invalido: true,
          erros: [`coluna tipo='${row.tipo}' mas o fluxo gravado e do tipo '${v.fluxo.tipo}'`],
        });
        continue;
      }
      const indisponivel = motivoParaRecusar(v.fluxo, canal);
      // Frente P (31/08/2026): macro recusado no INLINE nao e necessariamente
      // macro impossivel — espera longa e passo com aprovacao rodam pela FILA
      // (POST /api/fluxo-fila, acao "enfileirar"). Sem este campo a tela mostraria
      // "indisponivel" pro fluxo que tem, sim, um caminho — e a regua importada
      // com atraso de dias e justamente esse caso.
      const podeEnfileirar =
        indisponivel && podeEnviar ? motivoParaRecusar(v.fluxo, canal, "fila") === null : false;
      macros.push({ ...resumo(v.fluxo), indisponivel, pode_enfileirar: podeEnfileirar });
    } catch (e: any) {
      console.error("macro ilegivel na listagem", { slug: row?.slug, erro: e?.message });
      macros.push({ slug: row?.slug ?? null, nome: row?.nome ?? null, invalido: true, erros: ["fluxo ilegivel"] });
    }
  }
  return NextResponse.json({ macros }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await moduloLigado())) return RESP_MODULO_OFF();

  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { slug, chat_id } = body || {};
  // canalDeBody cai no "central" quando nao reconhece o canal — fallback seguro
  // pra LEITURA, perigoso aqui: um typo no canal rodaria a corrente inteira
  // (mensagem inclusive) no numero principal. Num macro isso e explicito ou nada.
  if (body?.canal !== undefined) {
    const c = canalPorId(body.canal);
    if (!c || !c.ativo) {
      return NextResponse.json({ error: "canal desconhecido ou inativo" }, { status: 400 });
    }
  }
  const canal = canalDeBody(body);
  if (!slug || typeof slug !== "string") {
    return NextResponse.json({ error: "slug do macro obrigatorio" }, { status: 400 });
  }
  if (!chat_id || typeof chat_id !== "string") {
    return NextResponse.json({ error: "chat_id obrigatorio" }, { status: 400 });
  }

  // AUTORIZACAO acontece AQUI, e so aqui: o motor (lib/fluxo/executar.ts) recebe
  // o usuario ja autorizado e nao repete nenhuma checagem — regra em dois
  // lugares e regra que diverge.
  if (!(await podeVerConversa(chat_id, user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(chat_id)) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }

  const { data: row, error } = await msgDb()
    .from("fluxos")
    .select("id,slug,fluxo,ativo")
    .eq("slug", slug)
    .eq("tipo", "macro")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "fluxos indisponiveis nesta instalacao" }, { status: 503 });
  }
  if (!row || !row.ativo) return NextResponse.json({ error: "macro nao encontrado" }, { status: 404 });

  const v = validarFluxo(row.fluxo);
  if (!v.ok) {
    console.error("macro invalido no banco", { slug, erros: v.erros });
    return NextResponse.json({ error: "macro invalido (fora do formato canonico)" }, { status: 422 });
  }

  const resultado = await executarMacro(v.fluxo, {
    canal,
    chat_id,
    usuario: { id: user.id, nome: user.nome },
  });

  // recusado no preflight = 400 (nada rodou); falha no meio = 207 (parte rodou,
  // e o cliente PRECISA ver quais passos sairam pro cliente final)
  const http = resultado.erro ? 400 : resultado.ok ? 200 : 207;
  return NextResponse.json(resultado, { status: http });
}
