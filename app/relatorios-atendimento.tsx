"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { duracaoLegivel, montarBarras, montarRanking } from "@/lib/relatorios-tela";
import { BotaoCsv } from "./relatorios-botao-csv";

// RELATORIO DE ATENDIMENTO — card 86ak85bne (o botao de exportar).
//
// Este painel EXISTIA dentro do modal Configuracoes -> aba "Relatorio"
// (app/home.tsx). Ele foi movido pra ca inteiro, pelos motivos que a frente J
// deixou escritos no CLAUDE.md: relatorio nao e configuracao. O que mudou de
// verdade: ganhou o botao Exportar CSV com gate pela permissao PROPRIA
// `relatorios_exportar`, seletor de canal no cabecalho (antes era "filtre outro
// canal na tela principal") e o fuso no rotulo.
//
// A rota /api/relatorio ja aceita ?formato=csv e ja NEGA com 403 sem a
// permissao — o gate visual existe pra a tela nao oferecer botao que falha.

type Dados = {
  por_status?: Record<string, number>;
  primeira_resposta_media_s?: number | null;
  csat_media?: number | null;
  csat_total?: number | null;
  por_dia?: { dia: string; recebidas: number; enviadas: number }[];
  por_atendente?: { nome: string; enviadas: number }[];
  fuso?: string;
  dias?: number;
  error?: string;
};

const STATUS: [string, string][] = [
  ["aberto", "Em aberto"],
  ["atendimento", "Em atendimento"],
  ["aguardando", "Aguardando"],
  ["concluido", "Concluidas"],
];

export default function RelatorioAtendimento({
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
  const [dias, setDias] = useState(14);
  const [dados, setDados] = useState<Dados | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await authedFetch(`/api/relatorio?canal=${encodeURIComponent(canal)}&dias=${dias}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "falha ao carregar o relatorio");
      setDados(j);
    } catch (e: any) {
      setDados(null);
      setErro(e?.message || "falha ao carregar o relatorio");
    } finally {
      setCarregando(false);
    }
  }, [authedFetch, canal, dias]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const grafico = montarBarras(dados?.por_dia ?? [], [
    { chave: "recebidas", valor: (p) => p.recebidas },
    { chave: "enviadas", valor: (p) => p.enviadas },
  ]);
  const ranking = montarRanking(dados?.por_atendente ?? []);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          Canal <b>{rotuloCanal}</b>
          {/* fuso VAZIO = a rota caiu no caminho antigo (migration 0014 nao
              rodou): o "por dia" nao esta no fuso da instalacao, e dizer isso e
              melhor que rotular o grafico errado */}
          {dados?.fuso ? ` — fuso ${dados.fuso}` : dados ? " — fuso da instalacao indisponivel no agrupamento por dia" : ""}
        </p>
        <div className="flex items-center gap-2">
          <select
            value={dias}
            onChange={(e) => setDias(Number(e.target.value))}
            className="rounded-lg border bg-white px-2 py-1 text-xs outline-none"
          >
            <option value={7}>7 dias</option>
            <option value={14}>14 dias</option>
            <option value={30}>30 dias</option>
            <option value={90}>90 dias</option>
          </select>
          <BotaoCsv
            semExportar={semExportar}
            onClick={() =>
              baixarCsv(
                `/api/relatorio?canal=${encodeURIComponent(canal)}&dias=${dias}&formato=csv`,
                `atendimento-${canal}.csv`
              )
            }
          />
          <button onClick={carregar} title="Atualizar" className="rounded p-1.5 text-muted-foreground hover:bg-muted">
            <RefreshCw className={`h-4 w-4 ${carregando ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {erro && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-800">{erro}</div>}

      {!dados ? (
        <p className="text-xs text-muted-foreground">{carregando ? "Carregando..." : "Sem dado pra mostrar."}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {STATUS.map(([k, rot]) => (
              <div key={k} className="rounded-lg border bg-white px-3 py-2 text-center">
                <p className="text-lg font-semibold">{dados.por_status?.[k] ?? 0}</p>
                <p className="text-[11px] text-muted-foreground">{rot}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded-lg border bg-white px-3 py-2 text-center">
              <p className="text-lg font-semibold">{duracaoLegivel(dados.primeira_resposta_media_s)}</p>
              <p className="text-[11px] text-muted-foreground">Tempo medio da 1a resposta</p>
            </div>
            <div className="rounded-lg border bg-white px-3 py-2 text-center">
              <p className="text-lg font-semibold">{dados.csat_media != null ? `${dados.csat_media} / 5` : "-"}</p>
              <p className="text-[11px] text-muted-foreground">
                Satisfacao ({dados.csat_total || 0} avaliacao(oes))
              </p>
            </div>
          </div>

          <section>
            <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Mensagens por dia</p>
            {grafico.vazio ? (
              <p className="rounded-lg border bg-white px-3 py-6 text-center text-[11px] text-muted-foreground">
                Nenhuma mensagem no periodo escolhido.
              </p>
            ) : (
              <div className="space-y-1 rounded-lg border bg-white p-3">
                {grafico.barras.map((b) => (
                  <div key={b.dia} className="flex items-center gap-2 text-[11px]">
                    <span className="w-14 shrink-0 text-muted-foreground">{b.rotulo}</span>
                    <div className="flex h-3 flex-1 overflow-hidden rounded bg-muted">
                      {/* a barra usa a altura (% do maior dia) como LARGURA e as
                          fracoes internas pro empilhamento — duas unidades
                          diferentes, calculadas na lib e provadas */}
                      <div className="flex h-full overflow-hidden" style={{ width: `${b.altura}%` }}>
                        <div className="bg-primary" style={{ width: `${b.partes[0].fracao}%` }} />
                        <div className="bg-sky-400" style={{ width: `${b.partes[1].fracao}%` }} />
                      </div>
                    </div>
                    <span className="w-24 shrink-0 text-right text-muted-foreground">
                      {b.partes[0].valor} rec / {b.partes[1].valor} env
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">
              Mensagens enviadas por atendente
            </p>
            {ranking.vazio ? (
              <p className="rounded-lg border bg-white px-3 py-6 text-center text-[11px] text-muted-foreground">
                Nenhum envio no periodo escolhido.
              </p>
            ) : (
              <div className="divide-y rounded-lg border bg-white">
                {ranking.linhas.map((l) => (
                  <div key={l.nome} className="flex items-center justify-between px-3 py-1.5 text-xs">
                    <span className="truncate">{l.nome}</span>
                    <span className="font-medium">{l.valor}</span>
                  </div>
                ))}
                {ranking.restante > 0 && (
                  <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
                    e mais {ranking.restante} — exporte o CSV pra lista completa
                  </p>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
