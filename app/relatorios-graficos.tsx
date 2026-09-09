"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  DIAS_PRESET,
  cortarSeries,
  diasAPular,
  duracaoLegivel,
  lerSeries,
  montarBarras,
  montarLinha,
  montarRanking,
  paramsGraficos,
  rotuloDiaLongo,
  rotuloPeriodo,
  type Grafico,
  type SeriesTela,
} from "@/lib/relatorios-tela";
import { BotaoCsv } from "./relatorios-botao-csv";

// GRAFICOS OPERACIONAIS — card 86ak85nz5. Os SEIS graficos, num payload so
// (/api/relatorios/serie faz UMA consulta agregada, nao seis).
//
//   1. novos chats            4. mensagens enviadas por atendente
//   2. novos atendimentos     5. total de chats acumulado
//   3. mensagens enviadas/recebidas   6. tempo de atendimento
//
// ZERO DEPENDENCIA NOVA: barra e <div> com altura em %, linha e um <path> de SVG
// montado por funcao pura. Nao entra recharts/chart.js num painel que hoje tem
// 13 dependencias — biblioteca de grafico e o jeito mais caro de desenhar seis
// series diarias.
//
// AS DUAS CAIXAS SAO INDEPENDENTES (criterio do card): "ignorar sabado" e
// "ignorar domingo" viajam como parametros separados (`ignorar_sabado` /
// `ignorar_domingo`) e nunca pelo atalho `ignorar_fds` — o atalho apagaria a
// diferenca entre "so sabado" e "os dois" na URL que o gestor copia.
//
// PERIODO SEM DADO = GRAFICO VAZIO COM AVISO, NUNCA ERRO. A rota devolve
// `series: null` + `aviso` quando a migration 0013 nao rodou, e serie vazia
// quando o periodo esta zerado; `lerSeries` nunca lanca e cada grafico tem
// estado vazio proprio.

type Resposta = {
  series: SeriesTela;
  fuso: string;
  aviso?: string;
  rotulo?: string;
  periodo?: { dias: number };
};

const ALTURA_LINHA = 120;
const LARGURA_LINHA = 600;

export default function RelatoriosGraficos({
  authedFetch,
  canal,
  rotuloCanal,
  baixarCsv,
  semExportar,
}: {
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
  canal: string;
  rotuloCanal: string;
  baixarCsv: (url: string, fallback: string) => void;
  semExportar: string | null;
}) {
  const [dias, setDias] = useState(30);
  const [ignorarSabado, setIgnorarSabado] = useState(false);
  const [ignorarDomingo, setIgnorarDomingo] = useState(false);
  const [resp, setResp] = useState<Resposta | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const filtro = useMemo(
    () => ({ canal, dias, ignorarSabado, ignorarDomingo }),
    [canal, dias, ignorarSabado, ignorarDomingo]
  );

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await authedFetch(`/api/relatorios/serie?${paramsGraficos(filtro)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "falha ao carregar os graficos");
      setResp({ series: lerSeries(j.series), fuso: String(j.fuso ?? ""), aviso: j.aviso, rotulo: j.rotulo });
    } catch (e: any) {
      setResp(null);
      setErro(e?.message || "falha ao carregar os graficos");
    } finally {
      setCarregando(false);
    }
  }, [authedFetch, filtro]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const pular = diasAPular(ignorarSabado, ignorarDomingo);
  // 2a barreira: a rota ja cortou os baldes. Cortar de novo e idempotente e
  // impede que um payload carregado com outro filtro desenhe sabado numa tela
  // marcada "sem sabado" (a prova cobre a idempotencia).
  const series = useMemo(() => cortarSeries(resp?.series ?? lerSeries(null), pular), [resp, ignorarSabado, ignorarDomingo]);

  const gNovos = montarBarras(series.novos_chats, [{ chave: "n", valor: (p) => p.n }]);
  const gAtend = montarBarras(series.novos_atendimentos, [{ chave: "n", valor: (p) => p.n }]);
  const gMsgs = montarBarras(series.mensagens, [
    { chave: "recebidas", valor: (p) => p.recebidas },
    { chave: "enviadas", valor: (p) => p.enviadas },
  ]);
  const gTempo = montarBarras(series.tempo_atendimento, [{ chave: "media_s", valor: (p) => p.media_s }]);
  const ranking = montarRanking(series.por_usuario);
  const linha = montarLinha(series.acumulado, LARGURA_LINHA, ALTURA_LINHA);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      {/* -------------------------------------------------------- filtros */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3 py-2">
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          Periodo
          <select
            value={dias}
            onChange={(e) => setDias(Number(e.target.value))}
            className="rounded-lg border bg-white px-2 py-1 text-xs outline-none"
          >
            {DIAS_PRESET.map((d) => (
              <option key={d} value={d}>
                {d} dias
              </option>
            ))}
          </select>
        </label>

        {/* caixas SEPARADAS de proposito — operacao que atende no sabado e nao
            no domingo existe, e o atalho de "fim de semana" mentiria pra ela */}
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px]">
          <input type="checkbox" checked={ignorarSabado} onChange={(e) => setIgnorarSabado(e.target.checked)} />
          Ignorar sabado
        </label>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px]">
          <input type="checkbox" checked={ignorarDomingo} onChange={(e) => setIgnorarDomingo(e.target.checked)} />
          Ignorar domingo
        </label>

        <span className="text-[11px] text-muted-foreground">
          {rotuloCanal} — {rotuloPeriodo(dias, resp?.fuso ?? "", pular)}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <BotaoCsv
            semExportar={semExportar}
            onClick={() => baixarCsv(`/api/relatorios/serie?${paramsGraficos(filtro, "csv")}`, `serie-${canal}.csv`)}
          />
          <button onClick={carregar} title="Atualizar" className="rounded p-1.5 text-muted-foreground hover:bg-muted">
            <RefreshCw className={`h-4 w-4 ${carregando ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {erro && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-800">{erro}</div>}
      {resp?.aviso && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-800">{resp.aviso}</div>
      )}

      {/* ------------------------------------------------------- 6 graficos */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Caixa titulo="Novos chats" resumo={`${gNovos.total} no periodo`}>
          <Colunas grafico={gNovos} cores={["bg-primary"]} legenda={(b) => `${b.total}`} />
        </Caixa>

        <Caixa titulo="Novos atendimentos" resumo={`${gAtend.total} no periodo`}>
          <Colunas grafico={gAtend} cores={["bg-sky-400"]} legenda={(b) => `${b.total}`} />
        </Caixa>

        <Caixa
          titulo="Mensagens recebidas e enviadas"
          resumo={`${gMsgs.barras.reduce((a, b) => a + b.partes[0].valor, 0)} recebidas · ${gMsgs.barras.reduce(
            (a, b) => a + b.partes[1].valor,
            0
          )} enviadas`}
        >
          <Colunas
            grafico={gMsgs}
            cores={["bg-primary", "bg-sky-400"]}
            legenda={(b) => `${b.partes[0].valor} rec / ${b.partes[1].valor} env`}
          />
          <Legenda itens={[["bg-primary", "recebidas"], ["bg-sky-400", "enviadas"]]} />
        </Caixa>

        <Caixa titulo="Mensagens enviadas por atendente" resumo={`${series.por_usuario.length} atendente(s)`}>
          {ranking.vazio ? (
            <Vazio />
          ) : (
            <div className="space-y-1.5">
              {ranking.linhas.map((l) => (
                <div key={l.nome} className="flex items-center gap-2 text-[11px]">
                  <span className="w-28 shrink-0 truncate text-muted-foreground" title={l.nome}>
                    {l.nome}
                  </span>
                  <div className="h-3 flex-1 overflow-hidden rounded bg-muted">
                    <div className="h-full bg-primary" style={{ width: `${l.fracao}%` }} />
                  </div>
                  <span className="w-12 shrink-0 text-right font-medium">{l.valor}</span>
                </div>
              ))}
              {ranking.restante > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  e mais {ranking.restante} — exporte o CSV pra lista completa
                </p>
              )}
            </div>
          )}
        </Caixa>

        <Caixa
          titulo="Total de chats acumulado"
          resumo={linha.vazio ? "" : `${linha.pontos[linha.pontos.length - 1].valor} no fim do periodo`}
        >
          {linha.vazio ? (
            <Vazio />
          ) : (
            <>
              {/* a escala NAO comeca no zero: o acumulado parte do que existia
                  antes do periodo, e comecar em zero achataria a curva */}
              <svg
                viewBox={`0 0 ${LARGURA_LINHA} ${ALTURA_LINHA}`}
                preserveAspectRatio="none"
                className="h-32 w-full text-primary"
                role="img"
                aria-label="Total de chats acumulado no periodo"
              >
                <path d={linha.area} className="fill-primary/15" />
                <path d={linha.caminho} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              </svg>
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>
                  {linha.pontos[0].rotulo} · {linha.pontos[0].valor}
                </span>
                <span>
                  {linha.pontos[linha.pontos.length - 1].rotulo} · {linha.pontos[linha.pontos.length - 1].valor}
                </span>
              </div>
            </>
          )}
        </Caixa>

        <Caixa
          titulo="Tempo de atendimento"
          resumo={
            gTempo.vazio
              ? ""
              : `media do periodo: ${duracaoLegivel(
                  series.tempo_atendimento.reduce((a, p) => a + p.media_s * p.n, 0) /
                    Math.max(1, series.tempo_atendimento.reduce((a, p) => a + p.n, 0))
                )}`
          }
        >
          <Colunas
            grafico={gTempo}
            cores={["bg-amber-400"]}
            legenda={(b, i) =>
              `${duracaoLegivel(series.tempo_atendimento[i]?.media_s)} (bruto ${duracaoLegivel(
                series.tempo_atendimento[i]?.media_bruta_s
              )}, ${series.tempo_atendimento[i]?.n ?? 0} conversa(s))`
            }
          />
          {/* o BRUTO fica no tooltip de proposito: e ele que mostra o tamanho da
              mentira que o fim de semana produzia (sexta 18h -> segunda 9h da
              15h uteis, nao 63h) */}
          <p className="text-[11px] text-muted-foreground">
            Tempo entre a 1a mensagem do cliente e a 1a resposta. Com as caixas acima marcadas, as horas do dia
            ignorado saem da conta — passe o mouse na coluna pra ver o valor bruto.
          </p>
        </Caixa>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
function Caixa({ titulo, resumo, children }: { titulo: string; resumo?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border bg-white p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase text-muted-foreground">{titulo}</h3>
        {resumo && <span className="shrink-0 text-[11px] text-muted-foreground">{resumo}</span>}
      </div>
      {children}
    </section>
  );
}

function Vazio() {
  return (
    <p className="px-3 py-8 text-center text-[11px] text-muted-foreground">
      Nenhum dado no periodo escolhido.
    </p>
  );
}

function Legenda({ itens }: { itens: [string, string][] }) {
  return (
    <div className="flex gap-3">
      {itens.map(([cor, rotulo]) => (
        <span key={rotulo} className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span className={`h-2 w-2 rounded-sm ${cor}`} />
          {rotulo}
        </span>
      ))}
    </div>
  );
}

// Colunas verticais. `altura` e % do maior dia (a escala) e `fracao` e % da
// propria coluna (o empilhamento) — as duas contas vivem na lib e sao provadas.
// A coluna e um <button> so pro title virar acessivel no teclado; nao navega.
function Colunas({
  grafico,
  cores,
  legenda,
}: {
  grafico: Grafico;
  cores: string[];
  legenda: (b: Grafico["barras"][number], i: number) => string;
}) {
  if (grafico.vazio) return <Vazio />;
  // periodo longo com muitas colunas: o rotulo do dia sai de N em N pra nao
  // virar uma tarja preta ilegivel
  const passo = Math.ceil(grafico.barras.length / 12);
  return (
    <div>
      <div className="flex h-32 items-end gap-px">
        {grafico.barras.map((b, i) => (
          <div
            key={b.dia}
            title={`${rotuloDiaLongo(b.dia)} — ${legenda(b, i)}`}
            className="flex h-full min-w-[2px] flex-1 flex-col justify-end"
          >
            <div className="flex w-full flex-col-reverse overflow-hidden rounded-t" style={{ height: `${b.altura}%` }}>
              {b.partes.map((p, j) => (
                <div key={p.chave} className={cores[j] || "bg-muted"} style={{ height: `${p.fracao}%` }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-px">
        {grafico.barras.map((b, i) => (
          <span key={b.dia} className="min-w-[2px] flex-1 truncate text-center text-[8px] text-muted-foreground">
            {i % passo === 0 ? b.rotulo : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
