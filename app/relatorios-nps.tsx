"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Smile } from "lucide-react";
import type { CanalPublico } from "@/lib/canais";
import {
  avisosDaSatisfacao,
  barrasDaDistribuicao,
  classificacaoNps,
  lerSatisfacao,
  type SatisfacaoTela,
} from "@/lib/relatorios-tela";
import { BotaoCsv } from "./relatorios-botao-csv";

// SATISFACAO: CSAT do painel + NPS importado — card 86ak85bne (delta declarado
// no comentario: "tela de leitura do NPS tambem pendente, a rota existe").
//
// ARQUIVO PROPRIO, fora da home: mesma decisao da Frente M pras outras telas de
// relatorio (a home ja e o maior arquivo do repo e tem outro dono nesta onda).
//
// A REGRA NAO MORA AQUI: leitura do corpo, classificacao do score, barras da
// distribuicao e as frases de aviso sao funcoes puras em lib/relatorios-tela.ts,
// provadas por `node scripts/prova-telas-relatorios.ts` sem navegador.
//
// TRES COISAS QUE ESTA TELA FAZ DE PROPOSITO, porque sao os jeitos de ler o
// numero errado:
//
//  1. **Nao soma CSAT com NPS.** Escalas diferentes (1-5 e 0-10), origens
//     diferentes (este painel e a ferramenta antiga), perguntas diferentes. Um
//     "indice de satisfacao" juntando os dois seria um numero que nao existe.
//  2. **Diz que o NPS e HISTORICO, nao pesquisa viva.** Nada aqui envia NPS: a
//     decisao registrada no card e que NPS entra como DADO (o uso medido na
//     origem foi 1,45% de taxa de resposta). Uma tela bonita de NPS sem essa
//     frase faz o gestor esperar respostas novas que nunca vao chegar.
//  3. **Mostra nota zerada como barra vazia, nao como nota ausente.** "Ninguem
//     deu 0" e informacao; nota faltando no grafico e ambiguidade.
//
// NAO PASSOU POR AJUSTE VISUAL DO ERIC — so componentes e classes que o painel
// ja usa.

const PERIODOS: { dias: number; rotulo: string }[] = [
  { dias: 30, rotulo: "30 dias" },
  { dias: 90, rotulo: "90 dias" },
  { dias: 365, rotulo: "12 meses" },
  { dias: 3650, rotulo: "tudo" },
];

const TOM: Record<string, string> = {
  cinza: "text-muted-foreground",
  vermelho: "text-red-600",
  amarelo: "text-amber-600",
  verde: "text-emerald-600",
};

const COR_BARRA: Record<string, string> = {
  detrator: "bg-red-400",
  neutro: "bg-amber-400",
  promotor: "bg-emerald-400",
};

export default function RelatoriosNps({
  authedFetch,
  canais,
  baixarCsv,
  semExportar,
}: {
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
  canais: CanalPublico[];
  baixarCsv: (url: string, fallback: string) => void;
  semExportar: string | null;
}) {
  // "todos" e o default de proposito: NPS importado muitas vezes nao tem canal
  // (veio de planilha), e abrir filtrado por um canal esconderia o historico.
  const [canal, setCanal] = useState("");
  const [dias, setDias] = useState(365);
  const [dados, setDados] = useState<SatisfacaoTela | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const url = `/api/relatorios/nps?dias=${dias}${canal ? `&canal=${encodeURIComponent(canal)}` : ""}`;

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await authedFetch(url);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "falha ao carregar a satisfacao");
      setDados(lerSatisfacao(j));
    } catch (e: any) {
      setDados(null);
      setErro(e?.message || "falha ao carregar a satisfacao");
    } finally {
      setCarregando(false);
    }
  }, [authedFetch, url]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const avisos = dados ? avisosDaSatisfacao(dados) : [];
  const classe = dados ? classificacaoNps(dados.nps.geral.score) : null;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3 py-2">
        <Smile className="h-4 w-4 shrink-0 text-primary" />
        <select
          value={String(dias)}
          onChange={(e) => setDias(Number(e.target.value))}
          className="rounded-lg border bg-white px-2 py-1.5 text-[11px] outline-none"
        >
          {PERIODOS.map((p) => (
            <option key={p.dias} value={p.dias}>
              {p.rotulo}
            </option>
          ))}
        </select>
        {canais.length > 1 && (
          <select
            value={canal}
            onChange={(e) => setCanal(e.target.value)}
            className="min-w-0 max-w-[190px] truncate rounded-lg border bg-white px-2 py-1.5 text-[11px] outline-none"
          >
            <option value="">Todos os canais</option>
            {canais.map((c) => (
              <option key={c.id} value={c.id}>
                {c.rotulo}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={carregar}
          className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${carregando ? "animate-spin" : ""}`} />
          Atualizar
        </button>
        <div className="ml-auto">
          <BotaoCsv onClick={() => baixarCsv(`${url}&formato=csv`, "satisfacao.csv")} semExportar={semExportar} />
        </div>
      </div>

      {erro && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">{erro}</div>}

      {avisos.map((a, i) => (
        <div key={i} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          {a}
        </div>
      ))}

      {dados && (
        <>
          {/* ---- CSAT: a pesquisa que ESTE painel envia ---- */}
          <section className="rounded-lg border bg-white p-3">
            <header className="mb-2 flex flex-wrap items-baseline gap-2">
              <h2 className="text-xs font-semibold">Pesquisa deste painel (CSAT)</h2>
              <span className="text-[11px] text-muted-foreground">
                escala {dados.csat.escala} · enviada ao concluir o atendimento · {dados.csat.total} resposta(s) no periodo
              </span>
            </header>
            {dados.csat.total === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                nenhuma resposta no periodo. O painel envia a pesquisa ao concluir atendimento — sem conclusao no
                periodo, nao ha resposta.
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-6">
                <div>
                  <div className="text-2xl font-semibold tabular-nums">{dados.csat.media ?? "—"}</div>
                  <div className="text-[11px] text-muted-foreground">media de {dados.csat.total} resposta(s)</div>
                </div>
                <div className="min-w-[200px] flex-1 space-y-1">
                  {barrasDaDistribuicao(dados.csat.distribuicao, dados.csat.escala).map((b) => (
                    <div key={b.nota} className="flex items-center gap-2 text-[11px]">
                      <span className="w-3 text-right tabular-nums text-muted-foreground">{b.nota}</span>
                      <span className="h-2 flex-1 overflow-hidden rounded bg-muted">
                        <span className="block h-full bg-primary/60" style={{ width: `${b.proporcao * 100}%` }} />
                      </span>
                      <span className="w-8 tabular-nums text-muted-foreground">{b.quantidade}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* ---- NPS: historico importado, NAO pesquisa viva ---- */}
          <section className="rounded-lg border bg-white p-3">
            <header className="mb-2 flex flex-wrap items-baseline gap-2">
              <h2 className="text-xs font-semibold">NPS historico (importado)</h2>
              <span className="text-[11px] text-muted-foreground">
                escala {dados.nps.escala} · dado trazido da ferramenta anterior
              </span>
            </header>
            <p className="mb-3 text-[11px] text-muted-foreground">
              Este painel <strong>nao envia</strong> pesquisa de NPS: o que esta aqui foi coletado antes, em outra
              ferramenta, e importado como historico. Numero novo so aparece com uma importacao nova.
            </p>

            {!dados.nps.importado || dados.nps.geral.total === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                nenhuma resposta de NPS no periodo escolhido.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-6">
                  <div>
                    <div className={`text-2xl font-semibold tabular-nums ${TOM[classe?.tom ?? "cinza"]}`}>
                      {dados.nps.geral.score ?? "—"}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      NPS ({classe?.rotulo}) · media {dados.nps.geral.media ?? "—"}
                    </div>
                  </div>
                  <div className="flex gap-4 text-[11px]">
                    <span className="text-emerald-600">
                      promotores <strong className="tabular-nums">{dados.nps.geral.promotores}</strong>
                    </span>
                    <span className="text-amber-600">
                      neutros <strong className="tabular-nums">{dados.nps.geral.neutros}</strong>
                    </span>
                    <span className="text-red-600">
                      detratores <strong className="tabular-nums">{dados.nps.geral.detratores}</strong>
                    </span>
                    <span className="text-muted-foreground">
                      total <strong className="tabular-nums">{dados.nps.geral.total}</strong>
                    </span>
                  </div>
                </div>

                <div className="mt-3 space-y-1">
                  {barrasDaDistribuicao(dados.nps.geral.distribuicao, dados.nps.escala).map((b) => (
                    <div key={b.nota} className="flex items-center gap-2 text-[11px]">
                      <span className="w-4 text-right tabular-nums text-muted-foreground">{b.nota}</span>
                      <span className="h-2 flex-1 overflow-hidden rounded bg-muted">
                        <span
                          className={`block h-full ${COR_BARRA[b.classe ?? ""] ?? "bg-primary/60"}`}
                          style={{ width: `${b.proporcao * 100}%` }}
                        />
                      </span>
                      <span className="w-8 tabular-nums text-muted-foreground">{b.quantidade}</span>
                    </div>
                  ))}
                </div>

                {dados.nps.pesquisas.length > 0 && (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead className="text-[11px] uppercase text-muted-foreground">
                        <tr className="border-b">
                          <th className="py-1 pr-2 text-left font-medium">pesquisa</th>
                          <th className="py-1 pr-2 text-left font-medium">origem</th>
                          <th className="py-1 pr-2 text-right font-medium">respostas</th>
                          <th className="py-1 pr-2 text-right font-medium">NPS</th>
                          <th className="py-1 pr-2 text-right font-medium">media</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dados.nps.pesquisas.map((p) => (
                          <tr key={p.id} className="border-b last:border-0">
                            <td className="py-1 pr-2">{p.nome}</td>
                            <td className="py-1 pr-2 text-muted-foreground">{p.origem || "—"}</td>
                            <td className="py-1 pr-2 text-right tabular-nums">{p.total}</td>
                            <td className="py-1 pr-2 text-right tabular-nums">{p.score ?? "—"}</td>
                            <td className="py-1 pr-2 text-right tabular-nums">{p.media ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Pesquisa com 0 resposta no periodo aparece na lista mesmo assim: ela existe na instalacao, e
                      esconde-la faria parecer que nao foi importada.
                    </p>
                  </div>
                )}

                <p className="mt-3 text-[11px] text-muted-foreground">
                  {dados.nps.ligadas_a_conversa} de {dados.nps.geral.total} resposta(s) estao ligadas a uma conversa
                  deste painel.
                </p>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
