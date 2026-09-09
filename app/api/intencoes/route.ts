import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, permitido } from "@/lib/perfil";
import { moduloAtivo } from "@/lib/modulos";
import {
  apagarIntencao, listarIntencoes, salvarIntencao, LIMITE_INTENCOES,
} from "@/lib/fluxo/intencoes-db";
import {
  reconhecerIntencoes, LIMIAR_SIMILARIDADE, PONTOS_FRASE_EXATA, PONTOS_PALAVRA_CHAVE,
  PONTOS_SIMILARIDADE, PONTUACAO_MINIMA_PADRAO,
} from "@/lib/fluxo/intencoes";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// INTENCOES (NLU) — card 86ak85nzr.
//
//   GET     lista o catalogo (+ `?texto=` TESTA o reconhecimento, sem gravar nada)
//   POST    cria | edita (com `id`)
//   DELETE  apaga uma intencao, com confirmacao explicita
//
// TRES coisas que esta rota nao faz, e o porque:
//   1. NAO CHAMA SERVICO NENHUM. O reconhecimento e local e deterministico
//      (lib/fluxo/intencoes.ts). Regra dura da casa: nenhuma linha do produto
//      consome API paga por conta propria.
//   2. NAO EXECUTA FLUXO. Intencao e CONDICAO de fluxo; disparar segue em
//      /api/macros e /api/fluxo-fila, que tem preflight, trilha e gate de conversa.
//   3. NAO CRIA TABELA. A 0022 e gesto humano no SQL Editor; sem ela a rota
//      degrada com aviso (lista vazia), nunca 500 — padrao de /api/macros.
//
// AUTORIZACAO: modulo `automacao` ligado + permissao nomeada `automacao` (a mesma
// do editor de fluxos: quem configura automacao configura as intencoes que a
// automacao usa). Nao resolve CANAL de proposito — o catalogo e da instalacao,
// nao de um numero; por isso a rota fica FORA de CANAL_PADRAO_EM.

async function porteiro(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return { erro: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!(await moduloAtivo("automacao"))) {
    return { erro: NextResponse.json({ error: "modulo de automacao desligado nesta instalacao" }, { status: 403 }) };
  }
  const perfil = await getPerfil(user.id);
  if (!permitido(perfil, "automacao")) {
    return { erro: NextResponse.json({ error: "sem permissao de automacao" }, { status: 403 }) };
  }
  return { user, perfil };
}

const semCache = { "Cache-Control": "no-store, max-age=0" } as const;

// A escala vai na resposta pra TELA poder explicar o numero em vez de so mostrar
// um campo "pontuacao minima" que ninguem sabe calibrar.
const ESCALA = {
  palavra_chave: PONTOS_PALAVRA_CHAVE,
  frase_exata: PONTOS_FRASE_EXATA,
  similaridade: PONTOS_SIMILARIDADE,
  minima_padrao: PONTUACAO_MINIMA_PADRAO,
  limiar_similaridade: LIMIAR_SIMILARIDADE,
};

export async function GET(req: NextRequest) {
  const p = await porteiro(req);
  if ("erro" in p) return p.erro;

  const lista = await listarIntencoes();
  if (!lista.ok) {
    // degrada: catalogo vazio + aviso. Conta sem intencao funciona igual, e a
    // tela precisa poder dizer POR QUE esta vazio.
    return NextResponse.json(
      { intencoes: [], aviso: lista.aviso, escala: ESCALA, teto: LIMITE_INTENCOES },
      { headers: semCache }
    );
  }

  // TESTAR sem gravar: `?texto=` pontua o catalogo contra uma frase. E leitura
  // pura (a lib nao toca banco nem rede), e e o que permite calibrar a pontuacao
  // minima sem mandar mensagem pra ninguem.
  const texto = req.nextUrl.searchParams.get("texto");
  const teste =
    texto === null
      ? null
      : {
          texto,
          resultado: reconhecerIntencoes(texto, lista.intencoes.filter((i) => i.ativo)),
        };

  return NextResponse.json(
    {
      intencoes: lista.intencoes,
      truncado: lista.truncado,
      teto: LIMITE_INTENCOES,
      escala: ESCALA,
      ...(teste ? { teste } : {}),
    },
    { headers: semCache }
  );
}

export async function POST(req: NextRequest) {
  const p = await porteiro(req);
  if ("erro" in p) return p.erro;
  const body = await req.json().catch(() => ({} as any));
  const id = typeof body?.id === "string" && body.id.trim() ? body.id.trim() : null;

  const r = await salvarIntencao(
    {
      nome: body?.nome,
      palavras_chave: body?.palavras_chave,
      frases: body?.frases,
      pontuacao_minima: body?.pontuacao_minima,
      ativo: body?.ativo,
    },
    { id: p.user.id, nome: p.user.nome },
    id
  );
  if (!r.ok) {
    // 422 pra conteudo invalido (o mesmo status do /api/fluxos), 409 pra nome
    // repetido, 503 pra indisponibilidade da tabela
    const status = r.erros?.length ? 422 : /ja existe uma intencao/.test(r.aviso) ? 409 : 503;
    return NextResponse.json({ error: r.aviso, ...(r.erros ? { erros: r.erros } : {}) }, { status });
  }
  return NextResponse.json({ ok: true, id: r.id }, { status: id ? 200 : 201 });
}

export async function DELETE(req: NextRequest) {
  const p = await porteiro(req);
  if ("erro" in p) return p.erro;
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id obrigatorio" }, { status: 400 });
  if (url.searchParams.get("confirmar") !== "1") {
    return NextResponse.json({ error: "apagar exige confirmacao explicita" }, { status: 400 });
  }
  // FLUXO QUE USA A INTENCAO nao e consultado aqui de proposito, e a razao esta
  // declarada: a condicao guarda o NOME (o fluxo canonico e portatil e nao carrega
  // uuid), entao apagar nao deixa referencia orfa nem quebra o jsonb — a condicao
  // simplesmente passa a nunca bater, e o simulador mostra isso. Fazer uma
  // varredura por nome em 900 fluxos a cada delete custaria caro e nao evitaria
  // nada: quem quer o inventario tem a vista de intencoes com a contagem de uso.
  const r = await apagarIntencao(id);
  if (!r.ok) return NextResponse.json({ error: r.aviso }, { status: 503 });
  return NextResponse.json({ ok: true, id });
}
