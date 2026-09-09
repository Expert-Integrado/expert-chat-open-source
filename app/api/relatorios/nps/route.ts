import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { acessoRelatorios } from "@/lib/relatorios-acesso";
import { csvLinha, erroSeguro, funcaoAusente, nomeArquivoCsv } from "@/lib/relatorios";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// SATISFACAO — CSAT proprio do painel + NPS historico importado (Frente J).
//
// Sao coisas DIFERENTES e nao se misturam num numero so:
// - CSAT (mensageria.avaliacoes): a pesquisa que ESTE painel envia ao concluir
//   atendimento. Escala 1 a 5, media simples.
// - NPS (mensageria.nps_respostas): respostas ja coletadas em OUTRA ferramenta,
//   guardadas como dado historico de cliente. Escala 0 a 10, calculo por
//   promotor/neutro/detrator.
//
// Decisao registrada no card: NPS entra como DADO, nao como funcionalidade —
// nao ha envio, regua nem pesquisa nova aqui. O uso real medido na ferramenta
// de origem foi baixo (1,45% de taxa de resposta), e isso nao justifica
// construir o produto antes do que ja tem uso comprovado.
// ATENCAO ao ler o card: os "415" de la sao a coluna ENVIADO, nao respostas.
//
// GET /api/relatorios/nps?canal=&dias=365&formato=csv

const AVISO_MIGRATION =
  "NPS historico indisponivel (a migration 0013_relatorios.sql ja foi aplicada nesta instalacao?)";

function faixaNps(notas: number[]) {
  const promotores = notas.filter((n) => n >= 9).length;
  const neutros = notas.filter((n) => n >= 7 && n <= 8).length;
  const detratores = notas.filter((n) => n <= 6).length;
  const total = notas.length;
  return {
    total,
    promotores,
    neutros,
    detratores,
    // NPS = %promotores - %detratores, de -100 a 100
    score: total ? Math.round(((promotores - detratores) / total) * 100) : null,
    media: total ? Number((notas.reduce((a, b) => a + b, 0) / total).toFixed(2)) : null,
  };
}

function distribuicao(notas: number[]): Record<string, number> {
  const d: Record<string, number> = {};
  for (const n of notas) d[String(n)] = (d[String(n)] ?? 0) + 1;
  return d;
}

export async function GET(req: NextRequest) {
  const acesso = await acessoRelatorios(req);
  if (!acesso.ok) return NextResponse.json({ error: acesso.erro }, { status: acesso.status });

  const q = req.nextUrl.searchParams;
  const canal = q.get("canal");
  const dias = Math.max(1, Math.min(3650, Number(q.get("dias")) || 365));
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();

  // ---- CSAT proprio (1 a 5) ------------------------------------------------
  let csatQ = msgDb().from("avaliacoes").select("nota,canal").gte("criada_em", desde).limit(50_000);
  if (canal) csatQ = csatQ.eq("canal", canal);
  const { data: csatRows, error: csatErr } = await csatQ;
  const csatNotas = (csatRows ?? []).map((r) => Number(r.nota)).filter((n) => Number.isFinite(n));
  const csat = {
    total: csatNotas.length,
    media: csatNotas.length ? Number((csatNotas.reduce((a, b) => a + b, 0) / csatNotas.length).toFixed(2)) : null,
    escala: "1-5",
    distribuicao: distribuicao(csatNotas),
    erro: csatErr ? "avaliacoes indisponivel" : undefined,
  };

  // ---- NPS historico (0 a 10) ---------------------------------------------
  let nps: any = { importado: false, aviso: AVISO_MIGRATION };
  const { data: pesquisas, error: pErr } = await msgDb()
    .from("nps_pesquisas")
    .select("id,nome,origem,ativa,importada_em")
    .order("importada_em", { ascending: false })
    .limit(100);
  if (!pErr) {
    // o PERIODO tem que valer aqui tambem: sem este filtro o corpo saia com
    // `dias: 30` e um NPS calculado sobre o historico INTEIRO — dois numeros
    // que se contradizem na mesma resposta.
    let rQ = msgDb()
      .from("nps_respostas")
      .select("pesquisa_id,nota,canal,chat_id")
      .gte("respondida_em", desde)
      .limit(50_000);
    if (canal) rQ = rQ.eq("canal", canal);
    const { data: respostas, error: rErr } = await rQ;
    if (rErr) {
      nps = funcaoAusente(rErr) ? { importado: false, aviso: AVISO_MIGRATION } : { importado: false, erro: erroSeguro(rErr) };
    } else {
      const linhas = respostas ?? [];
      const notas = linhas.map((r) => Number(r.nota)).filter((n) => Number.isFinite(n));
      nps = {
        importado: true,
        escala: "0-10",
        // sem pesquisa importada nesta instalacao a resposta e honesta: zero,
        // nao "NPS 0" (que seria um numero inventado)
        pesquisas: (pesquisas ?? []).map((p) => {
          const dela = linhas.filter((r) => r.pesquisa_id === p.id).map((r) => Number(r.nota));
          return { ...p, respostas: dela.length, ...faixaNps(dela.filter((n) => Number.isFinite(n))) };
        }),
        geral: { ...faixaNps(notas), distribuicao: distribuicao(notas) },
        // quantas respostas ficaram ligadas a uma conversa do painel
        ligadas_a_conversa: linhas.filter((r) => r.chat_id).length,
      };
      // resposta importada SEM data cai fora do filtro de periodo. Nao pode
      // sumir calada: quem importou historico de outra ferramenta muitas vezes
      // nao tem a data, e veria o NPS "zerar" sem entender por que.
      let semDataQ = msgDb()
        .from("nps_respostas")
        .select("id", { count: "exact", head: true })
        .is("respondida_em", null);
      if (canal) semDataQ = semDataQ.eq("canal", canal);
      const { count: semData } = await semDataQ;
      nps.periodo_dias = dias;
      nps.fora_do_periodo_sem_data = semData ?? 0;

      if (!linhas.length) {
        nps.aviso = semData
          ? `nenhuma resposta de NPS com data dentro dos ultimos ${dias} dias (${semData} resposta(s) importada(s) sem data ficaram de fora — aumente ?dias= ou reimporte com a coluna de data)`
          : "nenhuma resposta de NPS importada nesta instalacao";
      }
    }
  }

  const corpo = { canal: canal ?? "todos", dias, csat, nps, gerado_em: new Date().toISOString() };

  if ((q.get("formato") || "").toLowerCase() === "csv") {
    if (!acesso.podeExportar) {
      return NextResponse.json({ error: "sem permissao de exportar" }, { status: 403 });
    }
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const push = (s: string) => controller.enqueue(enc.encode(s));
        push(csvLinha(["indicador", "escala", "total", "media", "score", "promotores", "neutros", "detratores"]));
        push(csvLinha(["CSAT", csat.escala, csat.total, csat.media ?? "", "", "", "", ""]));
        if (nps.importado) {
          const g = nps.geral;
          push(csvLinha(["NPS", nps.escala, g.total, g.media ?? "", g.score ?? "", g.promotores, g.neutros, g.detratores]));
          for (const p of nps.pesquisas ?? []) {
            push(csvLinha([`NPS: ${p.nome}`, nps.escala, p.total, p.media ?? "", p.score ?? "", p.promotores, p.neutros, p.detratores]));
          }
        }
        push(csvLinha([]));
        push(csvLinha(["nota_csat", "quantidade"]));
        for (const [k, v] of Object.entries(csat.distribuicao)) push(csvLinha([k, v]));
        controller.close();
      },
    });
    return new NextResponse(stream, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${nomeArquivoCsv("satisfacao", new Date().toISOString().slice(0, 10))}"`,
        "Cache-Control": "no-store, max-age=0",
      },
    });
  }

  return NextResponse.json(corpo, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
