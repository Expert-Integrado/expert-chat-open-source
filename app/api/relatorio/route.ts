import { NextRequest, NextResponse } from "next/server";
import { canalDe } from "@/lib/canal";
import { canalPorId, fonteExterna } from "@/lib/canais";
import { sobreporAtendimento } from "@/lib/relatorios-agente";
import { msgDb } from "@/lib/mensageria";
import { fusoDaConfig, getConfig } from "@/lib/config";
import { acessoRelatorios } from "@/lib/relatorios-acesso";
import { csvLinha, diasIgnorados, filtrarDias, nomeArquivoCsv } from "@/lib/relatorios";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Relatorio de atendimento (agregado no banco, RPC relatorio_atendimento).
// Permissao "relatorios" (portao unico em lib/relatorios-acesso.ts); exportar
// CSV exige a permissao PROPRIA `relatorios_exportar` — tirar dado de cliente
// do sistema nao e a mesma permissao de olhar a tela.
//
// COSTURA DO MERGE (31/08/2026, frentes F + J): a RPC de 3 argumentos
// (migration 0014, JA RODADA) agrupa o "por dia" no fuso da instalacao; a de 2
// tem America/Sao_Paulo cravado. A rota tenta a nova e cai na antiga enquanto
// a migration nao tiver sido rodada — em vez de dar 500.
export async function GET(req: NextRequest) {
  const acesso = await acessoRelatorios(req);
  if (!acesso.ok) return NextResponse.json({ error: acesso.erro }, { status: acesso.status });

  const q = req.nextUrl.searchParams;
  const canal = canalDe(req);
  const dias = Math.max(1, Math.min(90, Number(q.get("dias")) || 14));
  const pular = diasIgnorados(q);
  const fuso = fusoDaConfig(await getConfig());
  const db = msgDb();

  let { data, error } = await db.rpc("relatorio_atendimento", { p_canal: canal, p_dias: dias, p_tz: fuso });
  let fusoAplicado = fuso;
  if (error) {
    ({ data, error } = await db.rpc("relatorio_atendimento", { p_canal: canal, p_dias: dias }));
    // sem a migration 0014, o "por dia" nao esta no fuso da instalacao: dizer
    // isso e melhor que rotular errado o grafico
    if (!error) fusoAplicado = "";
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // corte de BALDE (dias ignorados) sobre a serie que o banco devolveu; o
  // desconto de HORAS no tempo de atendimento vive em /api/relatorios/serie
  // canal do agente: a funcao SQL nao enxerga as mensagens (moram no banco do
  // agente) — os numeros de mensagem sao lidos de la e sobrepostos aqui
  const defRel = canalPorId(canal);
  if (defRel && fonteExterna(defRel) && defRel.fonte === "whatsapp-agent") {
    data = await sobreporAtendimento(defRel, data, dias, fusoAplicado || fuso);
  }
  const porDia = filtrarDias(((data as any)?.por_dia ?? []) as { dia: string }[], pular);
  const corpo = {
    canal,
    dias,
    ...data,
    por_dia: porDia,
    ignorados: pular,
    // quem manda no rotulo e o fuso que o BANCO realmente usou (a funcao de 3
    // args devolve o dela); vazio = caminho antigo, sem fuso da instalacao
    fuso: (data as any)?.fuso ?? fusoAplicado,
  };

  if ((q.get("formato") || "").toLowerCase() === "csv") {
    if (!acesso.podeExportar) {
      return NextResponse.json({ error: "sem permissao de exportar" }, { status: 403 });
    }
    return respostaCsv(canal, corpo);
  }

  return NextResponse.json(corpo, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

// CSV em streaming, em tres blocos (resumo, dia a dia, atendente) — o mesmo
// arquivo que o gestor abre no Excel pra trabalhar fora do sistema.
function respostaCsv(canal: string, corpo: any) {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (s: string) => controller.enqueue(enc.encode(s));
      push(csvLinha(["bloco", "chave", "valor"]));
      for (const [k, v] of Object.entries(corpo.por_status ?? {})) push(csvLinha(["status", k, v]));
      push(csvLinha(["resumo", "primeira_resposta_media_s", corpo.primeira_resposta_media_s ?? ""]));
      push(csvLinha(["resumo", "csat_media", corpo.csat_media ?? ""]));
      push(csvLinha(["resumo", "csat_total", corpo.csat_total ?? ""]));
      push(csvLinha([]));
      push(csvLinha(["dia", "recebidas", "enviadas"]));
      for (const d of corpo.por_dia ?? []) push(csvLinha([d.dia, d.recebidas, d.enviadas]));
      push(csvLinha([]));
      push(csvLinha(["atendente", "mensagens_enviadas"]));
      for (const a of corpo.por_atendente ?? []) push(csvLinha([a.nome, a.enviadas]));
      controller.close();
    },
  });
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nomeArquivoCsv("atendimento-" + canal, new Date().toISOString().slice(0, 10))}"`,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
