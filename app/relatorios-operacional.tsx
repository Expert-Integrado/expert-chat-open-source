"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  alvoDaCelula,
  celulaNavegavel,
  lerOperacional,
  linhasParaDesenho,
  type AlvoConversas,
  type BlocoOperacional,
  type LinhaMatriz,
} from "@/lib/relatorios-tela";
import { BotaoCsv } from "./relatorios-botao-csv";

// PAINEL OPERACIONAL — card 86ak85bm3. A tela que o gestor abre de manha:
// matriz departamento/atendente x status, com totais.
//
// A LINHA "SEM RESPONSAVEL" VEM PRIMEIRO E EM DESTAQUE, nao no meio da matriz.
// E o trabalho que nao e responsabilidade de ninguem — a rota ja devolve ela
// separada (`sem_dono`) exatamente por isso, e a tela nao a rebaixa a "mais uma
// linha". Ela aparece MESMO ZERADA: "0 sem responsavel" e informacao; linha
// ausente faz o gestor procurar.
//
// CLICAR NO NUMERO ABRE A LISTA FILTRADA. O painel ja tem a mecanica (filtro de
// status + filtro de responsavel, que casa por id contra conversa_responsaveis e
// aceita "none" pra sem-dono), entao o clique devolve o controle pra home em vez
// de inventar uma segunda listagem. Celula ZERADA nao navega — levar pra uma
// lista vazia parece tela quebrada.
//
// SOMA DAS LINHAS > TOTAL DO CABECALHO e ESPERADO: conversa com N responsaveis
// conta em CADA linha (mesma regra da ferramenta de origem). O cabecalho e a
// verdade, e a tela diz isso em uma linha em vez de deixar o gestor somar e
// desconfiar do relatorio.

type Presenca = { user_id: string; nome: string; papel: string; visto_em: string | null; online: boolean };

const ROTULO_STATUS: Record<string, string> = {
  aberto: "Em aberto",
  atendimento: "Em atendimento",
  aguardando: "Aguardando",
  concluido: "Concluidas",
};

const ROTULO_TIPO: Record<string, string> = {
  departamento: "Departamento",
  usuario: "Atendente",
  sem_dono: "",
};

export default function RelatoriosOperacional({
  authedFetch,
  baixarCsv,
  semExportar,
  aoFiltrarConversas,
}: {
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
  baixarCsv: (url: string, fallback: string) => void;
  semExportar: string | null;
  aoFiltrarConversas: (alvo: AlvoConversas) => void;
}) {
  const [arquivadas, setArquivadas] = useState(false);
  const [blocos, setBlocos] = useState<BlocoOperacional[]>([]);
  const [presenca, setPresenca] = useState<Presenca[]>([]);
  const [geradoEm, setGeradoEm] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await authedFetch(`/api/relatorios/operacional?canal=todos&arquivadas=${arquivadas ? 1 : 0}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "falha ao carregar o painel operacional");
      setBlocos(lerOperacional(j));
      setPresenca(Array.isArray(j.presenca) ? j.presenca : []);
      setGeradoEm(typeof j.gerado_em === "string" ? j.gerado_em : null);
    } catch (e: any) {
      setBlocos([]);
      setErro(e?.message || "falha ao carregar o painel operacional");
    } finally {
      setCarregando(false);
    }
  }, [authedFetch, arquivadas]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const online = presenca.filter((p) => p.online);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3 py-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px]">
          <input type="checkbox" checked={arquivadas} onChange={(e) => setArquivadas(e.target.checked)} />
          Incluir arquivadas
        </label>
        <span className="text-[11px] text-muted-foreground">
          Leitura ao vivo — o numero bate com a caixa de entrada neste instante
          {geradoEm ? ` (${new Date(geradoEm).toLocaleTimeString()})` : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <BotaoCsv
            semExportar={semExportar}
            onClick={() =>
              baixarCsv(
                `/api/relatorios/operacional?canal=todos&arquivadas=${arquivadas ? 1 : 0}&formato=csv`,
                "operacional.csv"
              )
            }
          />
          <button onClick={carregar} title="Atualizar" className="rounded p-1.5 text-muted-foreground hover:bg-muted">
            <RefreshCw className={`h-4 w-4 ${carregando ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {erro && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-800">{erro}</div>}

      {!blocos.length && !carregando && !erro && (
        <p className="text-xs text-muted-foreground">Nenhum canal com matriz pra mostrar.</p>
      )}

      {blocos.map((b) => (
        <section key={b.canal} className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase text-muted-foreground">{b.rotulo}</h3>

          {b.aviso && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-800">{b.aviso}</div>
          )}
          {b.erro && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-[11px] text-red-800">{b.erro}</div>
          )}

          {b.matriz && (
            <div className="overflow-x-auto rounded-lg border bg-white">
              <table className="w-full min-w-[560px] text-xs">
                <thead>
                  <tr className="border-b text-[11px] uppercase text-muted-foreground">
                    <th className="px-3 py-2 text-left font-semibold">Responsavel</th>
                    {b.matriz.status.map((s) => (
                      <th key={s} className="px-2 py-2 text-right font-semibold">
                        {ROTULO_STATUS[s] || s}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {linhasParaDesenho(b.matriz).map((l) => (
                    <Linha
                      key={`${l.tipo}:${l.ref_id}`}
                      linha={l}
                      status={b.matriz!.status}
                      canal={b.canal}
                      arquivadas={arquivadas}
                      aoFiltrar={aoFiltrarConversas}
                    />
                  ))}
                </tbody>
                <tfoot>
                  {/* CABECALHO da conta: aqui cada conversa vale 1. E a linha que
                      bate com a caixa de entrada. */}
                  <tr className="border-t bg-muted/50 font-semibold">
                    <td className="px-3 py-2">Total do canal</td>
                    {b.matriz.status.map((s) => (
                      <td key={s} className="px-2 py-2 text-right">
                        <Celula
                          valor={b.matriz!.totais[s] ?? 0}
                          onClick={() => aoFiltrarConversas(alvoDaCelula(b.canal, null, s, arquivadas))}
                        />
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right">{b.matriz.total_geral}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {b.matriz && !!b.matriz.linhas.length && (
            <p className="text-[11px] text-muted-foreground">
              Conversa com mais de um responsavel conta na linha de cada um — por isso a soma das linhas pode passar
              do total do canal. O total e a verdade. Clique num numero pra abrir a lista de conversas correspondente.
            </p>
          )}
          {b.matriz && (
            <p className="text-[11px] text-muted-foreground">
              LIMITE CONHECIDO: a matriz conta no banco (o acervo inteiro), e a lista de conversas do painel mostra
              as mais recentes ate o teto do servidor. Em base grande, a lista aberta pelo clique pode trazer menos
              linhas do que o numero clicado.
            </p>
          )}
        </section>
      ))}

      {/* presenca da equipe: volume de trabalho ao lado de quem esta na tela */}
      {!!presenca.length && (
        <section className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase text-muted-foreground">
            Equipe na tela ({online.length} de {presenca.length})
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {presenca.map((p) => (
              <span
                key={p.user_id}
                title={p.visto_em ? `visto em ${new Date(p.visto_em).toLocaleString()}` : "sem registro de acesso"}
                className={`rounded-full px-2 py-0.5 text-[11px] ${
                  p.online ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground"
                }`}
              >
                {p.nome}
              </span>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">Online = visto no painel nos ultimos 5 minutos.</p>
        </section>
      )}
    </div>
  );
}

function Linha({
  linha,
  status,
  canal,
  arquivadas,
  aoFiltrar,
}: {
  linha: LinhaMatriz;
  status: string[];
  canal: string;
  /** viaja no alvo: o numero clicado e a lista tem que contar a MESMA coisa */
  arquivadas: boolean;
  aoFiltrar: (alvo: AlvoConversas) => void;
}) {
  const semDono = linha.tipo === "sem_dono";
  return (
    <tr className={`border-b last:border-0 ${semDono ? "bg-amber-50/60" : ""}`}>
      <td className="px-3 py-2">
        <span className={semDono ? "font-semibold text-amber-800" : ""}>{linha.nome}</span>
        {!semDono && (
          <span className="ml-1.5 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
            {ROTULO_TIPO[linha.tipo]}
          </span>
        )}
      </td>
      {status.map((s) => (
        <td key={s} className="px-2 py-2 text-right">
          <Celula
            valor={linha.contagens[s] ?? 0}
            onClick={() => aoFiltrar(alvoDaCelula(canal, linha, s, arquivadas))}
            destaque={semDono}
          />
        </td>
      ))}
      <td className="px-3 py-2 text-right font-medium">
        <Celula
          valor={linha.total}
          onClick={() => aoFiltrar(alvoDaCelula(canal, linha, null, arquivadas))}
          destaque={semDono}
        />
      </td>
    </tr>
  );
}

function Celula({ valor, onClick, destaque }: { valor: number; onClick: () => void; destaque?: boolean }) {
  // zero nao e clicavel: abrir uma lista vazia parece tela quebrada
  if (!celulaNavegavel(valor)) return <span className="text-muted-foreground">0</span>;
  return (
    <button
      onClick={onClick}
      title="Abrir a lista de conversas com este recorte"
      className={`rounded px-1 underline decoration-dotted underline-offset-2 hover:bg-muted ${
        destaque ? "font-semibold text-amber-800" : ""
      }`}
    >
      {valor}
    </button>
  );
}
