import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { canalPorId, canaisAtivos, somenteLeitura } from "@/lib/canais";
import { acessoRelatorios } from "@/lib/relatorios-acesso";
import {
  csvLinha,
  erroSeguro,
  funcaoAusente,
  montarMatriz,
  nomeArquivoCsv,
  type Matriz,
} from "@/lib/relatorios";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// PAINEL OPERACIONAL — matriz departamento/usuario x status (Frente J).
//
// A tela que o gestor abre de manha. A linha "sem responsavel" e a mais
// importante: e o trabalho que nao e responsabilidade de ninguem, e vem
// separada da matriz de proposito (destaque, nao "mais uma linha").
//
// O numero tem que BATER com a caixa de entrada no mesmo instante — por isso
// le ao vivo, conta com o mesmo recorte da lista (arquivada fora, salvo
// ?arquivadas=1) e nao guarda agregado nenhum.
//
// GET /api/relatorios/operacional?canal=central|todos&arquivadas=0&formato=csv
//
// Consulta AGREGADA no banco (mensageria.relatorio_operacional, migration
// 0013): traz group-by, nunca 12 mil linhas pro Node. O pivo da matriz e
// funcao pura em lib/relatorios.ts (provada sem banco).

const AVISO_MIGRATION =
  "relatorio operacional indisponivel (a migration 0013_relatorios.sql ja foi aplicada nesta instalacao?)";

type BlocoCanal = { canal: string; rotulo: string; matriz: Matriz | null; aviso?: string; erro?: string };

async function matrizDoCanal(canalId: string, incluirArquivadas: boolean): Promise<BlocoCanal> {
  const def = canalPorId(canalId);
  const rotulo = def?.rotulo || canalId;
  // canal de fonte externa (Instagram Agent) nao tem tabela de conversa no
  // banco do painel — nao ha o que contar aqui, e isso nao e erro
  if (!def || somenteLeitura(canalId)) {
    return { canal: canalId, rotulo, matriz: null, aviso: "canal de fonte externa: sem matriz no painel" };
  }
  const { data, error } = await msgDb().rpc("relatorio_operacional", {
    p_canal: canalId,
    p_tabela: def.tabelas.conversas,
    p_incluir_arquivadas: incluirArquivadas,
  });
  // so "funcao nao existe" e falta de migration; qualquer outro erro (permissao,
  // timeout, tipo) tem que aparecer como erro, senao manda o operador procurar
  // no lugar errado
  if (error) {
    return {
      canal: canalId,
      rotulo,
      matriz: null,
      ...(funcaoAusente(error) ? { aviso: AVISO_MIGRATION } : { erro: erroSeguro(error) }),
    };
  }
  if (data?.erro) return { canal: canalId, rotulo, matriz: null, aviso: String(data.erro) };
  return { canal: canalId, rotulo, matriz: montarMatriz(data ?? {}) };
}

// Presenca da equipe: volume de trabalho ao lado de quem esta na tela.
// `visto_em` ja e carimbado pelo painel; online = visto nos ultimos 5 min.
async function presenca() {
  const { data, error } = await msgDb()
    .from("perfis")
    .select("user_id,nome,visto_em,papel")
    .eq("ativo", true)
    .order("visto_em", { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) return [];
  const corte = Date.now() - 5 * 60_000;
  return (data ?? [])
    // contas de teste do E2E ficam fora dos seletores do painel; aqui tambem
    .filter((p) => !String(p.nome ?? "").toLowerCase().startsWith("teste-painel-"))
    .map((p) => ({
      user_id: p.user_id,
      nome: p.nome || "(sem nome)",
      papel: p.papel,
      visto_em: p.visto_em,
      online: !!p.visto_em && new Date(p.visto_em).getTime() > corte,
    }));
}

export async function GET(req: NextRequest) {
  const acesso = await acessoRelatorios(req);
  if (!acesso.ok) return NextResponse.json({ error: acesso.erro }, { status: acesso.status });

  const q = req.nextUrl.searchParams;
  const pedido = q.get("canal");
  const incluirArquivadas = ["1", "true"].includes((q.get("arquivadas") || "").toLowerCase());
  const alvos =
    !pedido || pedido === "todos"
      ? canaisAtivos().map((c) => c.id)
      : [canalPorId(pedido)?.id].filter((x): x is string => !!x);
  if (!alvos.length) return NextResponse.json({ error: "canal desconhecido" }, { status: 400 });

  const [blocos, equipe] = await Promise.all([
    Promise.all(alvos.map((c) => matrizDoCanal(c, incluirArquivadas))),
    presenca(),
  ]);

  const formato = (q.get("formato") || "json").toLowerCase();
  if (formato === "csv") {
    if (!acesso.podeExportar) {
      return NextResponse.json({ error: "sem permissao de exportar" }, { status: 403 });
    }
    return respostaCsv(blocos, incluirArquivadas);
  }

  return NextResponse.json(
    {
      gerado_em: new Date().toISOString(),
      incluir_arquivadas: incluirArquivadas,
      canais: blocos,
      // resumo de cabecalho por canal (o gestor le isto antes da matriz)
      totais_por_canal: blocos.map((b) => ({
        canal: b.canal,
        rotulo: b.rotulo,
        totais: b.matriz?.totais ?? null,
        total_geral: b.matriz?.total_geral ?? null,
        sem_dono_total: b.matriz?.sem_dono.total ?? null,
      })),
      presenca: equipe,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

// CSV em streaming: 1 linha por (canal, dono), colunas de status ao lado.
// Streaming simples — a matriz e pequena, mas o caminho e o mesmo dos
// relatorios grandes e evita montar string gigante em memoria.
function respostaCsv(blocos: BlocoCanal[], incluirArquivadas: boolean) {
  // uniao dos status vistos, pra tabela unica com as mesmas colunas
  const status = Array.from(new Set(blocos.flatMap((b) => b.matriz?.status ?? [])));
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (s: string) => controller.enqueue(enc.encode(s));
      push(csvLinha(["canal", "tipo", "nome", ...status, "total"]));
      for (const b of blocos) {
        if (!b.matriz) {
          push(csvLinha([b.rotulo, b.erro ? "erro" : "aviso", b.erro ?? b.aviso ?? "sem dado"]));
          continue;
        }
        const linha = (l: { tipo: string; nome: string; contagens: Record<string, number>; total: number }) =>
          push(csvLinha([b.rotulo, l.tipo, l.nome, ...status.map((s) => l.contagens[s] ?? 0), l.total]));
        linha(b.matriz.sem_dono);
        for (const l of b.matriz.linhas) linha(l);
        push(
          csvLinha([
            b.rotulo,
            "TOTAL",
            "(cabecalho — conversa conta 1x)",
            ...status.map((s) => b.matriz!.totais[s] ?? 0),
            b.matriz.total_geral,
          ])
        );
      }
      controller.close();
    },
  });
  const dia = new Date().toISOString().slice(0, 10);
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nomeArquivoCsv("operacional", dia + (incluirArquivadas ? "-com-arquivadas" : ""))}"`,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
