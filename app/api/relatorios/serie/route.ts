import { NextRequest, NextResponse } from "next/server";
import { sobreporSerie } from "@/lib/relatorios-agente";
import { msgDb } from "@/lib/mensageria";
import { canalPorId, somenteLeitura } from "@/lib/canais";
import { canalDe } from "@/lib/canal";
import { fusoDaConfig, getConfig } from "@/lib/config";
import { acessoRelatorios } from "@/lib/relatorios-acesso";
import {
  acumular,
  csvLinha,
  diasIgnorados,
  erroSeguro,
  filtrarDias,
  funcaoAusente,
  inicioDoDiaLocal,
  nomeArquivoCsv,
} from "@/lib/relatorios";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// GRAFICOS OPERACIONAIS — serie temporal com opcao de IGNORAR FIM DE SEMANA.
//
// Os seis graficos da tela de origem, todos no mesmo payload (uma consulta
// agregada em vez de seis):
//   1. novos_chats            4. por_usuario (mensagens enviadas por atendente)
//   2. novos_atendimentos     5. acumulado (total de chats)
//   3. mensagens (in/out)     6. tempo_atendimento
//
// ?ignorar_sabado=1 e ?ignorar_domingo=1 sao INDEPENDENTES (criterio do card);
// ?ignorar_fds=1 e o atalho pros dois. O que eles fazem:
//   - tiram os BALDES de sabado/domingo das series (filtrarDias, funcao pura);
//   - tiram as HORAS de sabado/domingo do tempo de atendimento
//     (mensageria.segundos_uteis, migration 0013).
// Sem isso, conversa que chega sexta 18h e e respondida segunda 9h vira "63h
// de espera" — numero mentiroso em operacao que nao atende no fim de semana.
//
// Fuso: `fusoDaConfig(cfg)` — config `fuso` > env FUSO_INSTALACAO > fabrica
// (lib/fuso.ts, frente F; a config VENCE a env). A conta pode nao estar em Sao
// Paulo, e dia/semana so fazem sentido no fuso de quem opera. Ler so a env
// (como fazia `fusoInstalacao`) agrupava o "por dia" num fuso e rotulava o
// grafico com outro na instalacao que definiu o fuso PELA TELA — o mapa de
// troca no cabecalho de lib/relatorios.ts pedia justamente esta linha.
//
// GET /api/relatorios/serie?canal=&dias=30&ignorar_fds=1&formato=csv

const AVISO_MIGRATION =
  "serie indisponivel (a migration 0013_relatorios.sql ja foi aplicada nesta instalacao?)";

export async function GET(req: NextRequest) {
  const acesso = await acessoRelatorios(req);
  if (!acesso.ok) return NextResponse.json({ error: acesso.erro }, { status: acesso.status });

  const q = req.nextUrl.searchParams;
  const canal = canalDe(req);
  const def = canalPorId(canal);
  if (!def || somenteLeitura(canal)) {
    return NextResponse.json(
      { canal, series: null, aviso: "canal de fonte externa: sem serie no painel" },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }

  const dias = Math.max(1, Math.min(365, Number(q.get("dias")) || 30));
  const ate = q.get("ate") ? new Date(q.get("ate")!) : new Date();
  const fuso = fusoDaConfig(await getConfig());

  // `dias=30` ANCORADO NA MEIA-NOITE LOCAL (corrigido 31/08/2026, achado da
  // revisao cega). Antes era `agora - 30*24h`, que cai no MEIO de um dia: o
  // banco agrupa por dia local e devolvia 31 baldes pra "ultimos 30 dias", com o
  // primeiro deles cobrindo so as horas depois da hora atual. Efeito na tela: a
  // primeira coluna do grafico sempre parecia um dia fraco (e era um pedaco de
  // dia), e a media do tempo de atendimento carregava esse dia parcial como se
  // fosse inteiro. Agora sao 30 baldes: de hoje-29 as 00:00 ate agora.
  // O ultimo balde segue parcial por natureza — hoje nao terminou —, e isso e
  // esperado; o que era defeito era o balde parcial na PONTA DE TRAS, que
  // ninguem le como "dia incompleto".
  // `?desde=` explicito manda: quem passa data escolheu a borda.
  const desde = q.get("desde")
    ? new Date(q.get("desde")!)
    : inicioDoDiaLocal(new Date(ate.getTime() - (dias - 1) * 86_400_000), fuso);
  if (Number.isNaN(desde.getTime()) || Number.isNaN(ate.getTime()) || ate <= desde) {
    return NextResponse.json({ error: "periodo invalido" }, { status: 400 });
  }

  const pular = diasIgnorados(q);

  const { data, error } = await msgDb().rpc("relatorio_serie", {
    p_canal: canal,
    p_tabela_conversas: def.tabelas.conversas,
    p_tabela_mensagens: def.tabelas.mensagens,
    p_desde: desde.toISOString(),
    p_ate: ate.toISOString(),
    p_fuso: fuso,
    p_pular: pular,
  });
  if (error) {
    // so "funcao nao existe" vira o aviso da migration; o resto e erro de
    // verdade e precisa aparecer como erro, nao como "ainda nao instalou"
    if (funcaoAusente(error)) {
      return NextResponse.json(
        { canal, series: null, aviso: AVISO_MIGRATION },
        { headers: { "Cache-Control": "no-store, max-age=0" } }
      );
    }
    return NextResponse.json({ error: erroSeguro(error) }, { status: 500 });
  }
  if (data?.erro) {
    return NextResponse.json(
      { canal, series: null, aviso: String(data.erro) },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }

  // O banco devolve a serie INTEIRA com o `dow` de cada dia; o corte dos
  // baldes de fim de semana acontece aqui (regra de exibicao num lugar so).
  // canal do agente: mensagens e novos chats vem do banco do agente
  const dados = def.fonte === "whatsapp-agent" ? await sobreporSerie(def, data, desde.toISOString(), ate.toISOString(), fuso) : data;
  type PontoNovos = { dia: string; dow: number; n: number };
  const novosBruto = (dados?.novos_chats ?? []) as PontoNovos[];
  const series = {
    novos_chats: filtrarDias(novosBruto, pular),
    novos_atendimentos: filtrarDias(dados?.novos_atendimentos ?? [], pular),
    mensagens: filtrarDias(dados?.mensagens ?? [], pular),
    por_usuario: dados?.por_usuario ?? [],
    // ACUMULA PRIMEIRO, filtra depois: o total acumulado tem que contar os
    // chats que entraram no fim de semana (eles existem), so nao mostra os
    // baldes de sabado/domingo. Acumular sobre a serie ja filtrada daria uma
    // curva que contradiz o contador de chats do painel.
    acumulado: filtrarDias(acumular(novosBruto, Number(dados?.acumulado_base ?? 0)), pular),
    // media_s = com o fim de semana JA descontado; media_bruta_s = o cru, pra
    // dar pra ver o tamanho da mentira que o fim de semana produzia
    tempo_atendimento: filtrarDias(dados?.tempo_atendimento ?? [], pular),
  };

  const vazio = !series.novos_chats.length && !series.mensagens.length && !series.tempo_atendimento.length;

  if ((q.get("formato") || "").toLowerCase() === "csv") {
    if (!acesso.podeExportar) {
      return NextResponse.json({ error: "sem permissao de exportar" }, { status: 403 });
    }
    return respostaCsv(canal, series);
  }

  return NextResponse.json(
    {
      canal,
      rotulo: def.rotulo,
      periodo: { desde: desde.toISOString(), ate: ate.toISOString(), dias },
      fuso,
      ignorados: pular,
      // periodo sem dado = serie vazia com aviso, nunca erro (criterio do card)
      aviso: vazio ? "nenhum dado no periodo escolhido" : undefined,
      series,
      gerado_em: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

// CSV em streaming: uma linha por DIA com as series diarias lado a lado, e o
// bloco por usuario no fim (dimensao diferente, nao cabe na mesma linha).
function respostaCsv(canal: string, series: any) {
  const enc = new TextEncoder();
  const porDia = new Map<string, Record<string, unknown>>();
  const guarda = (lista: any[], campos: (p: any) => Record<string, unknown>) => {
    for (const p of lista ?? []) {
      const linha = porDia.get(p.dia) ?? { dia: p.dia };
      porDia.set(p.dia, { ...linha, ...campos(p) });
    }
  };
  guarda(series.novos_chats, (p) => ({ novos_chats: p.n }));
  guarda(series.novos_atendimentos, (p) => ({ novos_atendimentos: p.n }));
  guarda(series.mensagens, (p) => ({ recebidas: p.recebidas, enviadas: p.enviadas }));
  guarda(series.acumulado, (p) => ({ acumulado: p.n }));
  guarda(series.tempo_atendimento, (p) => ({
    atendidas: p.n,
    tempo_medio_s: p.media_s,
    tempo_medio_bruto_s: p.media_bruta_s,
  }));

  const cols = [
    "dia",
    "novos_chats",
    "novos_atendimentos",
    "recebidas",
    "enviadas",
    "acumulado",
    "atendidas",
    "tempo_medio_s",
    "tempo_medio_bruto_s",
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (s: string) => controller.enqueue(enc.encode(s));
      push(csvLinha(cols));
      for (const dia of Array.from(porDia.keys()).sort()) {
        const l = porDia.get(dia)!;
        push(csvLinha(cols.map((c) => l[c] ?? "")));
      }
      push(csvLinha([]));
      push(csvLinha(["atendente", "mensagens_enviadas"]));
      for (const u of series.por_usuario ?? []) push(csvLinha([u.nome, u.enviadas]));
      controller.close();
    },
  });
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nomeArquivoCsv("serie-" + canal, new Date().toISOString().slice(0, 10))}"`,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
