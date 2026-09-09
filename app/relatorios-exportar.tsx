"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Database, Loader2, RefreshCw } from "lucide-react";
import { BotaoCsv } from "./relatorios-botao-csv";

// EXPORTAR DADOS — card 86ak85bne (delta: "consultas exportaveis de
// mensagens/usuarios/anotacoes/acessos (telas dedicadas)").
//
// A TELA NAO DECIDE NADA. O catalogo, o que cada consulta leva dentro, quem pode
// rodar e o motivo de cada recusa vem TODO da rota (`GET /api/exportar`, regra pura
// em lib/exportacao.ts). Aqui se pinta o que ela mandou. Isso e o oposto do que
// costuma acontecer com tela de exportacao: uma lista escrita a mao no front, que
// oferece o que o servidor recusa e esquece a consulta nova.
//
// TRES COISAS DELIBERADAS:
//
//  1. **Contagem antes do arquivo.** Clicar em "Exportar" sem saber o tamanho e
//     como baixar um anexo sem saber se e 10 KB ou 400 MB. A previa da rota
//     devolve o NUMERO de linhas do recorte (e nunca as linhas — leitura de dado
//     e da tela de conversas, com o gate dela).
//  2. **Acima do teto a tela nao oferece o botao** e diz quanto passou. A rota
//     recusa com 413 de todo jeito; oferecer o botao seria empurrar a pessoa pro
//     erro.
//  3. **Consulta recusada aparece, com o motivo.** Esconder faz a pessoa achar
//     que a exportacao nao existe; a frase da rota diz qual permissao falta ou por
//     que a visao com recorte impede.

type ConsultaTela = {
  id: string;
  titulo: string;
  o_que_sai: string;
  por_canal: boolean;
  por_periodo: boolean;
  colunas: string[];
  disponivel: boolean;
  motivo: string | null;
  migration: string | null;
};

type Previa = { total: number; aviso: string | null; acima_do_teto: boolean; erro?: string };

const PERIODOS = [7, 30, 90, 365];

export default function RelatoriosExportar({
  authedFetch,
  baixarCsv,
}: {
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
  baixarCsv: (url: string, fallback: string) => void;
}) {
  const [consultas, setConsultas] = useState<ConsultaTela[]>([]);
  const [canais, setCanais] = useState<{ id: string; rotulo: string }[]>([]);
  const [canal, setCanal] = useState("");
  const [dias, setDias] = useState(30);
  const [previas, setPrevias] = useState<Record<string, Previa | "carregando">>({});
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const urlDa = useCallback(
    (c: ConsultaTela, formato?: "csv") => {
      const p = new URLSearchParams({ consulta: c.id });
      if (c.por_periodo) p.set("dias", String(dias));
      if (c.por_canal && canal) p.set("canal", canal);
      if (formato) p.set("formato", formato);
      return `/api/exportar?${p.toString()}`;
    },
    [dias, canal]
  );

  const carregarCatalogo = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await authedFetch("/api/exportar");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "falha ao carregar as consultas");
      setConsultas(Array.isArray(j.consultas) ? j.consultas : []);
      setCanais(Array.isArray(j.canais) ? j.canais : []);
    } catch (e: any) {
      setConsultas([]);
      setErro(e?.message || "falha ao carregar as consultas");
    } finally {
      setCarregando(false);
    }
  }, [authedFetch]);

  useEffect(() => {
    carregarCatalogo();
  }, [carregarCatalogo]);

  // a previa e por consulta e por recorte: mudar periodo/canal invalida as antigas
  useEffect(() => {
    setPrevias({});
  }, [dias, canal]);

  const contar = useCallback(
    async (c: ConsultaTela) => {
      setPrevias((p) => ({ ...p, [c.id]: "carregando" }));
      try {
        const r = await authedFetch(urlDa(c));
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          setPrevias((p) => ({
            ...p,
            [c.id]: { total: 0, aviso: null, acima_do_teto: false, erro: j.error || `HTTP ${r.status}` },
          }));
          return;
        }
        setPrevias((p) => ({
          ...p,
          [c.id]: {
            total: Number(j.total) || 0,
            aviso: typeof j.aviso === "string" ? j.aviso : null,
            acima_do_teto: j.acima_do_teto === true,
          },
        }));
      } catch (e: any) {
        setPrevias((p) => ({
          ...p,
          [c.id]: { total: 0, aviso: null, acima_do_teto: false, erro: e?.message || "falha ao contar" },
        }));
      }
    },
    [authedFetch, urlDa]
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3 py-2">
        <Database className="h-4 w-4 shrink-0 text-primary" />
        <select
          value={String(dias)}
          onChange={(e) => setDias(Number(e.target.value))}
          className="rounded-lg border bg-white px-2 py-1.5 text-[11px] outline-none"
        >
          {PERIODOS.map((d) => (
            <option key={d} value={d}>
              ultimos {d} dias
            </option>
          ))}
        </select>
        {canais.length > 1 && (
          <select
            value={canal}
            onChange={(e) => setCanal(e.target.value)}
            className="min-w-0 max-w-[190px] truncate rounded-lg border bg-white px-2 py-1.5 text-[11px] outline-none"
          >
            <option value="">Canal padrao</option>
            {canais.map((c) => (
              <option key={c.id} value={c.id}>
                {c.rotulo}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={carregarCatalogo}
          className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${carregando ? "animate-spin" : ""}`} />
          Atualizar
        </button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        O arquivo sai em CSV com uma linha por registro. Antes de baixar, confira o tamanho: o periodo e o canal do topo
        valem pra consulta que os usa (usuarios do painel, por exemplo, nao tem periodo).
      </p>

      {erro && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">{erro}</div>}

      {consultas.map((c) => {
        const p = previas[c.id];
        const contando = p === "carregando";
        const previa = contando ? null : (p as Previa | undefined);
        return (
          <section key={c.id} className="rounded-lg border bg-white p-3">
            <header className="mb-1 flex flex-wrap items-baseline gap-2">
              <h2 className="text-xs font-semibold">{c.titulo}</h2>
              <span className="text-[11px] text-muted-foreground">
                {c.por_periodo ? `ultimos ${dias} dias` : "sem recorte de periodo"}
                {c.por_canal ? ` · canal ${canal || "padrao"}` : ""}
              </span>
            </header>
            <p className="text-[11px] text-muted-foreground">{c.o_que_sai}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              colunas: <span className="font-mono">{c.colunas.join(", ")}</span>
            </p>

            {!c.disponivel ? (
              <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-muted px-2 py-1.5 text-[11px] text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{c.motivo}</span>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => contar(c)}
                  className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted"
                >
                  {contando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {previa ? "Recontar" : "Quantas linhas?"}
                </button>

                {previa?.erro && <span className="text-[11px] text-amber-700">{previa.erro}</span>}

                {previa && !previa.erro && (
                  <>
                    <span className="text-[11px] tabular-nums">
                      {previa.total.toLocaleString("pt-BR")} linha(s)
                    </span>
                    {previa.acima_do_teto ? (
                      <span className="text-[11px] text-amber-700">{previa.aviso}</span>
                    ) : previa.total === 0 ? (
                      <span className="text-[11px] text-muted-foreground">
                        nada no recorte — o arquivo sairia so com o cabecalho
                      </span>
                    ) : (
                      <BotaoCsv
                        onClick={() => baixarCsv(urlDa(c, "csv"), `${c.id}.csv`)}
                        semExportar={null}
                        rotulo="Baixar CSV"
                      />
                    )}
                  </>
                )}
              </div>
            )}
          </section>
        );
      })}

      {!carregando && !consultas.length && !erro && (
        <p className="text-[11px] text-muted-foreground">nenhuma consulta exportavel nesta instalacao.</p>
      )}
    </div>
  );
}
