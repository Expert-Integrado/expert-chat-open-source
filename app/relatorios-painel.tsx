"use client";

import { useCallback, useState } from "react";
import { BarChart3, Loader2 } from "lucide-react";
import { CabecalhoTela } from "./ui/tela";
import type { CanalPublico } from "@/lib/canais";
import { motivoSemExportar, nomeDoContentDisposition, type AlvoConversas } from "@/lib/relatorios-tela";
import { problemaNoCsv } from "@/lib/exportacao";
import RelatorioAtendimento from "./relatorios-atendimento";
import RelatoriosGraficos from "./relatorios-graficos";
import RelatoriosOperacional from "./relatorios-operacional";
import RelatoriosSla from "./relatorios-sla";
import RelatoriosNps from "./relatorios-nps";
import RelatoriosExportar from "./relatorios-exportar";

// TELAS DE RELATORIO — Frente M (cards 86ak85nz5, 86ak85bm3, 86ak85bkh, 86ak85bne).
//
// ONDE ELE VIVE — decisao desta frente: relatorio e uma VISAO do painel
// (app/home.tsx, `visaoPainel: "relatorios"`), irma do quadro de funil, e NAO
// mais uma aba dentro do modal de Configuracoes. A frente J deixou escrito no
// CLAUDE.md que a aba tinha que sair de la: "relatorio nao e configuracao".
// Efeito pratico: cabe em tela cheia (grafico de 90 dias nao entra num modal de
// 2xl), tem canal proprio, e o clique num numero da matriz consegue devolver o
// controle pro painel e filtrar a lista de conversas.
//
// A REGRA NAO MORA AQUI: escala de grafico, corte de dias, alvo do clique e
// validacao do formulario de alerta sao funcoes puras em lib/relatorios-tela.ts,
// provadas sem navegador por `node scripts/prova-telas-relatorios.ts`.
//
// PERMISSAO: o servidor manda (portao unico em lib/relatorios-acesso.ts, 401/403
// por rota). A tela so REFLETE: `relatorios` abre a visao, `relatorios_exportar`
// mostra o botao de CSV, e a aba de alertas de SLA segue a permissao `automacao`
// (ela grava em mensageria.config, que e configuracao de verdade).
//
// A TELA NAO PASSOU POR AJUSTE VISUAL DO ERIC — feita so com os componentes e
// classes que o painel ja usa.

export type Aba = "atendimento" | "graficos" | "operacional" | "sla" | "satisfacao" | "exportar";

export default function RelatoriosPainel({
  authedFetch,
  canais,
  canalInicial,
  podeExportar,
  podeConfigurar,
  ehSuperAdmin,
  departamentos,
  aoSair,
  aoFiltrarConversas,
}: {
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
  canais: CanalPublico[];
  /** canal em foco no painel quando a visao abriu */
  canalInicial: string;
  /** permissao `relatorios_exportar`: sem ela o botao de CSV nem aparece */
  podeExportar: boolean;
  /** permissao `automacao`: a aba de alertas de SLA grava configuracao */
  podeConfigurar: boolean;
  /** o tick/teste de POST /api/relatorios/sla exige super admin (padrao do vigia) */
  ehSuperAdmin: boolean;
  departamentos: { id: string; nome: string }[];
  aoSair: () => void;
  /** clicar num numero da matriz volta pro painel com a lista ja filtrada */
  aoFiltrarConversas: (alvo: AlvoConversas) => void;
}) {
  const [aba, setAba] = useState<Aba>("atendimento");
  const [canal, setCanal] = useState(canalInicial || canais[0]?.id || "central");
  const [baixando, setBaixando] = useState(false);
  const [erroCsv, setErroCsv] = useState<string | null>(null);

  // DOWNLOAD AUTENTICADO: as rotas exigem Bearer, entao um <a href> volta 401
  // (e o navegador mostraria um JSON de erro no lugar do arquivo). Baixa por
  // fetch, entrega como blob e usa o nome que a rota mandou no
  // Content-Disposition. O 403 do servidor continua valendo como ultima
  // palavra — o gate visual e cortesia, nao seguranca.
  const baixarCsv = useCallback(
    async (url: string, fallback: string) => {
      setErroCsv(null);
      setBaixando(true);
      try {
        const r = await authedFetch(url);
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `falha ao exportar (HTTP ${r.status})`);
        }
        const nome = nomeDoContentDisposition(r.headers.get("content-disposition"), fallback);
        const blob = await r.blob();
        // O ARQUIVO PODE VIR AVARIADO COM HTTP 200. O stream do CSV comeca com 200 e
        // so descobre falha (ou short-read) no meio; a marca do problema entra na
        // ULTIMA LINHA do arquivo, nao no cabecalho HTTP — nao existe como virar 500
        // depois do primeiro byte. Sem farejar aqui, o navegador salva a planilha
        // curta em silencio e a pessoa a trata como completa.
        // O arquivo E salvo de todo jeito: ele e a evidencia, e ja carrega a linha
        // que explica. O que muda e o aviso na tela.
        // SO A CAUDA: `blob.text()` no arquivo inteiro materializa dezenas de MB de
        // string na aba (exportacao vai a 50 mil linhas) so pra ler uma linha. A marca
        // e sempre a ULTIMA linha e tem menos de 300 bytes; 4 KB sobram.
        const cauda = await blob.slice(Math.max(0, blob.size - 4096)).text();
        const problema = problemaNoCsv(cauda);
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = nome;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // libera a memoria do blob depois do clique (Safari precisa do atraso)
        setTimeout(() => URL.revokeObjectURL(href), 5_000);
        if (problema) setErroCsv(`O arquivo ${nome} foi salvo, MAS esta incompleto — ${problema}`);
      } catch (e: any) {
        setErroCsv(e?.message || "falha ao exportar");
      } finally {
        setBaixando(false);
      }
    },
    [authedFetch]
  );

  const semExportar = motivoSemExportar(podeExportar);
  // A aba de EXPORTAR aparece so pra quem tem `relatorios_exportar`: ela nao tem
  // nada pra mostrar sem a permissao (todas as consultas voltariam recusadas), e
  // aba vazia com aviso e pior que aba ausente. Ja SATISFACAO aparece pra todo
  // mundo que abre relatorios — ler CSAT/NPS nao exige exportar.
  const abas: [Aba, string][] = [
    ["atendimento", "Atendimento"],
    ["graficos", "Graficos"],
    ["operacional", "Painel operacional"],
    ["satisfacao", "Satisfacao"],
    ...(podeExportar ? ([["exportar", "Exportar dados"]] as [Aba, string][]) : []),
    ...(podeConfigurar ? ([["sla", "Alertas de SLA"]] as [Aba, string][]) : []),
  ];

  return (
    <div className="flex h-screen flex-col bg-background">
      <CabecalhoTela titulo="Relatorios" icone={BarChart3} aoVoltar={aoSair}>
        <div className="flex flex-wrap gap-1">
          {abas.map(([id, rotulo]) => (
            <button
              key={id}
              onClick={() => setAba(id)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${
                aba === id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {rotulo}
            </button>
          ))}
        </div>

        {/* canal: o relatorio de atendimento e a serie sao POR CANAL (as rotas
            conhecem um por vez). O painel operacional varre todos de uma vez,
            entao la o seletor nao vale — e nem aparece. */}
        {(aba === "atendimento" || aba === "graficos") && canais.length > 1 && (
          <select
            value={canal}
            onChange={(e) => setCanal(e.target.value)}
            className="ml-auto min-w-0 max-w-[190px] truncate rounded-lg border bg-white px-2 py-1.5 text-[11px] outline-none"
          >
            {canais.map((c) => (
              <option key={c.id} value={c.id}>
                {c.rotulo}
              </option>
            ))}
          </select>
        )}
        {baixando && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            baixando...
          </span>
        )}
      </CabecalhoTela>

      {erroCsv && (
        <div className="shrink-0 border-b bg-amber-50 px-4 py-2 text-[11px] text-amber-800">{erroCsv}</div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {aba === "atendimento" && (
          <RelatorioAtendimento
            authedFetch={authedFetch}
            canal={canal}
            rotuloCanal={canais.find((c) => c.id === canal)?.rotulo || canal}
            baixarCsv={baixarCsv}
            semExportar={semExportar}
          />
        )}
        {aba === "graficos" && (
          <RelatoriosGraficos
            authedFetch={authedFetch}
            canal={canal}
            rotuloCanal={canais.find((c) => c.id === canal)?.rotulo || canal}
            baixarCsv={baixarCsv}
            semExportar={semExportar}
          />
        )}
        {aba === "operacional" && (
          <RelatoriosOperacional
            authedFetch={authedFetch}
            baixarCsv={baixarCsv}
            semExportar={semExportar}
            aoFiltrarConversas={aoFiltrarConversas}
          />
        )}
        {aba === "satisfacao" && (
          <RelatoriosNps
            authedFetch={authedFetch}
            canais={canais}
            baixarCsv={baixarCsv}
            semExportar={semExportar}
          />
        )}
        {aba === "exportar" && podeExportar && (
          <RelatoriosExportar authedFetch={authedFetch} baixarCsv={baixarCsv} />
        )}
        {aba === "sla" && podeConfigurar && (
          <RelatoriosSla
            authedFetch={authedFetch}
            canais={canais}
            departamentos={departamentos}
            ehSuperAdmin={ehSuperAdmin}
          />
        )}
      </div>
    </div>
  );
}
