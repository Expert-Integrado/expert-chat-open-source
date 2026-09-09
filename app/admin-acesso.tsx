"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, KeyRound, Laptop, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { CabecalhoTela } from "./ui/tela";
import type { CanalPublico } from "@/lib/canais";
import {
  DIAS_SEMANA,
  DIAS_UTEIS,
  alternar,
  avisoEscopoAberto,
  avisoSemFunilInerte,
  copiarLinha,
  corpoDoEscopoAdmin,
  errosDaGrade,
  explicarRestricao,
  gradeParaJanela,
  gradeVazia,
  janelaParaGrade,
  nomeDoDia,
  resumoDaGrade,
  rotuloDispositivo,
  rotuloEscopo,
  tempoRelativo,
  type Grade,
} from "@/lib/tela-acesso";
import { validarEscopoChave, type EscopoChave } from "@/lib/escopo-chave";
import type { RestricaoUsuario } from "@/lib/visibilidade";

// TELAS DE ACESSO E SEGURANCA — Frente Q (cards 86ak858x0 janela, 86ak85917
// dispositivos, 86ak85zm4 visibilidade por funil/canal, 86ak85899 escopo de chave).
//
// ONDE ELE VIVE — decisao desta frente, no padrao que a Frente M deixou escrito:
// e uma VISAO do painel (`app/home.tsx`, `visaoPainel: "acesso"`), irma do quadro
// e dos relatorios, e nao mais uma aba dentro do modal de Configuracoes. Dois
// motivos concretos:
//   1. a barra de abas do modal ja carrega SEIS abas numa linha sem wrap dentro
//      de um `max-w-2xl` — a setima nao cabe;
//   2. grade de 7 dias x 2 periodos, inventario de dispositivos e tabela de
//      chaves com escopo nao entram num modal de 672px (foi o mesmo argumento
//      que tirou relatorio de la).
// A ENTRADA continua sendo o modal de Configuracoes, na aba "Usuarios e
// permissoes", que e onde o admin ja esta quando pensa nisso.
//
// A REGRA NAO MORA AQUI: conversao da grade, erros de formulario, rotulo de
// dispositivo, tempo relativo e o texto que explica a restricao sao funcoes
// PURAS em `lib/tela-acesso.ts`, provadas sem navegador por
// `node scripts/prova-tela-acesso.ts`. Este arquivo e marcacao e estado.
//
// PERMISSAO: o servidor manda; a tela so REFLETE (mesma nota de
// relatorios-painel.tsx). Janela e dispositivos pedem `gerenciar_usuarios`,
// visibilidade pede `gerenciar_visibilidade` (de proposito outra: quem define
// quem ve o que nao precisa mexer em papel e senha), e chaves de API e SO super
// admin — exatamente o que cada rota exige. Aba que a pessoa nao alcanca nao
// aparece, e mesmo que aparecesse a rota responderia 403.
//
// MIGRATION 0019: cada rota responde `disponivel:false` + `aviso` quando a tabela
// nao existe, em vez de 500. A tela mostra o aviso e desabilita a escrita — nunca
// finge que salvou.
//
// A TELA NAO PASSOU POR AJUSTE VISUAL DO ERIC — feita so com os componentes e
// classes que o painel ja usa.

type Aba = "janela" | "dispositivos" | "visibilidade" | "chaves" | "senha";

export type UsuarioAcesso = {
  id: string;
  nome: string;
  papel: string;
  ativo: boolean;
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// ————————————————————————————————————————————————————————— pecas comuns
const CAIXA = "rounded-lg border bg-white px-3 py-2 text-xs outline-none";
const BOTAO = "rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50";
const BOTAO_FRACO = "rounded-lg border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50";

function Aviso({ texto, tom = "amber" }: { texto: string; tom?: "amber" | "red" | "sky" }) {
  const cor =
    tom === "red"
      ? "border-red-300 bg-red-50 text-red-900"
      : tom === "sky"
        ? "border-sky-300 bg-sky-50 text-sky-900"
        : "border-amber-300 bg-amber-50 text-amber-900";
  return <p className={`rounded-lg border p-3 text-[11px] ${cor}`}>{texto}</p>;
}

function SeletorPessoa({
  usuarios,
  valor,
  aoTrocar,
  rotulo = "Pessoa",
}: {
  usuarios: UsuarioAcesso[];
  valor: string;
  aoTrocar: (id: string) => void;
  rotulo?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-[11px] font-semibold uppercase text-muted-foreground">{rotulo}</span>
      <select value={valor} onChange={(e) => aoTrocar(e.target.value)} className={`${CAIXA} min-w-[240px]`}>
        <option value="">— escolha —</option>
        {usuarios.map((u) => (
          <option key={u.id} value={u.id}>
            {u.nome}
            {u.ativo === false ? " (desativado)" : ""}
            {u.papel === "super_admin" ? " — super admin" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

// ═══════════════════════════════════════════════════════ 1) JANELA DE ACESSO
type RespostaJanela = {
  janelas?: { user_id: string; ativo: boolean; dias: Record<number, { de: string; ate: string }[]>; resumo: string; definido_por_nome: string | null; updated_at: string | null }[];
  disponivel?: boolean;
  aviso?: string;
  fuso?: string;
  error?: string;
};

function TelaJanela({ authedFetch, usuarios, meuId, alvoInicial }: { authedFetch: Fetch; usuarios: UsuarioAcesso[]; meuId: string; alvoInicial: string }) {
  const [dados, setDados] = useState<RespostaJanela | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [alvo, setAlvo] = useState(alvoInicial);
  const [grade, setGrade] = useState<Grade>(gradeVazia());
  const [ativo, setAtivo] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [ok, setOk] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const r = await authedFetch("/api/admin/janela");
      const j: RespostaJanela = await r.json();
      if (!r.ok) {
        setErro(j.error || "Nao consegui carregar as janelas.");
        return; // NAO zera o que ja estava na tela
      }
      setDados(j);
    } catch {
      setErro("Nao consegui carregar as janelas — tente de novo.");
    }
  }, [authedFetch]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // troca de pessoa: carrega a janela dela no formulario
  useEffect(() => {
    const linha = dados?.janelas?.find((x) => x.user_id === alvo);
    setGrade(janelaParaGrade(linha ? { ativo: linha.ativo, dias: linha.dias } : null));
    setAtivo(!!linha?.ativo);
    setOk(null);
  }, [alvo, dados]);

  const pessoa = usuarios.find((u) => u.id === alvo);
  const disponivel = dados?.disponivel !== false;
  const erros = errosDaGrade(grade, ativo);
  // as duas recusas que a ROTA faz — a tela explica ANTES de deixar tentar
  const ehEu = !!alvo && alvo === meuId;
  const ehSuper = pessoa?.papel === "super_admin";
  const travado = ehEu || (ehSuper && ativo) || !disponivel;

  async function salvar() {
    if (!alvo || salvando) return;
    setSalvando(true);
    setErro(null);
    setOk(null);
    try {
      const janela = gradeParaJanela(grade, ativo);
      const r = await authedFetch("/api/admin/janela", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: alvo, ativo: janela.ativo, dias: janela.dias }),
      });
      const j = await r.json();
      if (!r.ok) {
        setErro(j.error || "Falha ao salvar.");
        return;
      }
      setOk(j.aviso ? `Salvo. ${j.aviso}` : `Salvo: ${j.resumo || resumoDaGrade(grade, ativo)}`);
      carregar();
    } catch {
      setErro("Falha ao salvar — tente de novo.");
    } finally {
      setSalvando(false);
    }
  }

  async function remover() {
    if (!alvo || salvando) return;
    if (!window.confirm(`Remover a janela de ${pessoa?.nome || "esta pessoa"}? Ela volta a entrar em qualquer horario.`)) return;
    setSalvando(true);
    setErro(null);
    setOk(null);
    try {
      const r = await authedFetch(`/api/admin/janela?user_id=${encodeURIComponent(alvo)}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) {
        setErro(j.error || "Falha ao remover.");
        return;
      }
      setOk("Janela removida — a pessoa entra em qualquer horario.");
      carregar();
    } catch {
      setErro("Falha ao remover — tente de novo.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="space-y-3">
      {dados?.aviso && <Aviso texto={dados.aviso} />}
      <p className="text-[11px] text-muted-foreground">
        Dia e horario em que a pessoa consegue usar o painel. Fora da janela, a sessao dela para de
        funcionar no mesmo minuto — nao e so a tela de login.{" "}
        {dados?.fuso ? (
          <>
            Os horarios valem no fuso <strong>{dados.fuso}</strong>.
          </>
        ) : null}{" "}
        Sem janela cadastrada, a pessoa entra sempre (e o estado de todo mundo hoje).
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <SeletorPessoa usuarios={usuarios} valor={alvo} aoTrocar={setAlvo} />
        {!!alvo && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={ativo}
              onChange={(e) => setAtivo(e.target.checked)}
              disabled={!disponivel || ehEu || ehSuper}
            />
            Janela ligada
          </label>
        )}
      </div>

      {!alvo && <p className="text-[11px] text-muted-foreground">Escolha uma pessoa pra ver ou definir a janela dela.</p>}

      {!!alvo && ehEu && (
        <Aviso
          tom="sky"
          texto="Voce nao pode mexer na sua propria janela de acesso — quem faz isso e outro super admin. E a mesma trava que existe nas permissoes: ninguem afrouxa o proprio acesso."
        />
      )}
      {!!alvo && ehSuper && (
        <Aviso texto="Super admin nunca e barrado por janela de acesso (e o que garante caminho de volta quando a configuracao esta errada). Gravar uma janela aqui seria uma regra que nao faz nada — mude o papel primeiro, se e isso que voce quer." />
      )}

      {!!alvo && (
        <>
          <div className="divide-y rounded-lg border">
            {DIAS_SEMANA.map((dia) => {
              const linha = grade[dia];
              return (
                <div key={dia} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <label className="flex w-32 shrink-0 items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={linha.marcado}
                      disabled={travado}
                      onChange={(e) => {
                        const nova = grade.map((l, i) => (i === dia ? { ...l, periodos: l.periodos.map((p) => ({ ...p })) } : l));
                        nova[dia].marcado = e.target.checked;
                        setGrade(nova);
                      }}
                    />
                    <span className="font-medium">{nomeDoDia(dia)}</span>
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    {linha.periodos.map((p, idx) => (
                      <span key={idx} className="flex items-center gap-1 text-[11px]">
                        {idx > 0 && <span className="mr-1 text-muted-foreground">e</span>}
                        <input
                          type="time"
                          value={p.de}
                          disabled={travado || !linha.marcado}
                          onChange={(e) => {
                            const nova = grade.map((l, i) => (i === dia ? { ...l, periodos: l.periodos.map((x) => ({ ...x })) } : l));
                            nova[dia].periodos[idx].de = e.target.value;
                            setGrade(nova);
                          }}
                          className="rounded border bg-white px-1.5 py-1 outline-none disabled:opacity-50"
                        />
                        <span className="text-muted-foreground">as</span>
                        <input
                          type="time"
                          value={p.ate}
                          disabled={travado || !linha.marcado}
                          onChange={(e) => {
                            const nova = grade.map((l, i) => (i === dia ? { ...l, periodos: l.periodos.map((x) => ({ ...x })) } : l));
                            nova[dia].periodos[idx].ate = e.target.value;
                            setGrade(nova);
                          }}
                          className="rounded border bg-white px-1.5 py-1 outline-none disabled:opacity-50"
                        />
                      </span>
                    ))}
                  </div>
                  {dia === 1 && (
                    <button
                      type="button"
                      disabled={travado}
                      onClick={() => setGrade(copiarLinha(grade, 1, DIAS_UTEIS))}
                      className="ml-auto text-[11px] text-primary hover:underline disabled:opacity-50">
                      copiar pra segunda a sexta
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-[11px] text-muted-foreground">
            Dois periodos por dia dao conta do intervalo de almoco. Horario que passa da meia-noite
            vale: <code>22:00 as 02:00</code> na sexta libera a madrugada de sabado.
          </p>

          <p className="text-xs">
            <span className="text-[11px] font-semibold uppercase text-muted-foreground">Resumo</span>{" "}
            {resumoDaGrade(grade, ativo)}
          </p>

          {erros.map((e) => (
            <p key={e} className="text-[11px] text-red-600">
              {e}
            </p>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={salvar} disabled={travado || salvando || erros.length > 0} className={BOTAO}>
              {salvando ? "Salvando..." : "Salvar janela"}
            </button>
            <button onClick={remover} disabled={ehEu || salvando || !disponivel} className={BOTAO_FRACO}>
              Remover janela
            </button>
          </div>
        </>
      )}

      {erro && <p className="text-[11px] text-red-600">{erro}</p>}
      {ok && <p className="text-[11px] text-emerald-700">{ok}</p>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════ 2) DISPOSITIVOS
type Dispositivo = {
  id: string;
  user_id: string;
  impressao: string;
  navegador: string | null;
  sistema: string | null;
  rotulo: string | null;
  robo: boolean | null;
  ip_ultimo: string | null;
  ip_interno: boolean;
  primeiro_acesso_em: string | null;
  visto_em: string | null;
  revogado: boolean;
  revogado_em: string | null;
  revogado_por_nome: string | null;
};

function TelaDispositivos({ authedFetch, usuarios, meuId, alvoInicial }: { authedFetch: Fetch; usuarios: UsuarioAcesso[]; meuId: string; alvoInicial: string }) {
  const [lista, setLista] = useState<Dispositivo[] | null>(null);
  const [limite, setLimite] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [disponivel, setDisponivel] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [filtro, setFiltro] = useState(alvoInicial);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const carregar = useCallback(
    async (userId: string) => {
      setErro(null);
      try {
        const url = userId ? `/api/admin/dispositivos?user_id=${encodeURIComponent(userId)}` : "/api/admin/dispositivos";
        const r = await authedFetch(url);
        const j = await r.json();
        if (!r.ok) {
          setErro(j.error || "Nao consegui carregar os dispositivos.");
          return;
        }
        setLista(j.dispositivos ?? []);
        setLimite(j.limite_honesto ?? null);
        setAviso(j.aviso ?? null);
        setDisponivel(j.disponivel !== false);
      } catch {
        setErro("Nao consegui carregar os dispositivos — tente de novo.");
      }
    },
    [authedFetch]
  );

  useEffect(() => {
    carregar(filtro);
  }, [carregar, filtro]);

  const nomeDe = (id: string) => usuarios.find((u) => u.id === id)?.nome || "(pessoa removida)";

  async function mexer(d: Dispositivo, revogar: boolean) {
    if (ocupado) return;
    if (revogar && !window.confirm(`Revogar o acesso de ${rotuloDispositivo(d)} (${nomeDe(d.user_id)})?`)) return;
    setOcupado(d.id);
    setErro(null);
    try {
      const r = await authedFetch("/api/admin/dispositivos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: d.id, revogar }),
      });
      const j = await r.json();
      if (!r.ok) {
        setErro(j.error || "Falha ao mudar o dispositivo.");
        return;
      }
      carregar(filtro);
    } catch {
      setErro("Falha ao mudar o dispositivo — tente de novo.");
    } finally {
      setOcupado(null);
    }
  }

  async function apagar(d: Dispositivo) {
    if (ocupado) return;
    if (!window.confirm("Apagar esta linha do inventario? Ela volta a aparecer no proximo acesso da pessoa — isso e limpeza de lista, nao revogacao.")) return;
    setOcupado(d.id);
    setErro(null);
    try {
      const r = await authedFetch(`/api/admin/dispositivos?id=${encodeURIComponent(d.id)}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) {
        setErro(j.error || "Falha ao apagar a linha.");
        return;
      }
      carregar(filtro);
    } catch {
      setErro("Falha ao apagar a linha — tente de novo.");
    } finally {
      setOcupado(null);
    }
  }

  return (
    <div className="space-y-3">
      {aviso && <Aviso texto={aviso} />}
      <p className="text-[11px] text-muted-foreground">
        De onde cada pessoa acessa este painel. O registro e nosso: a porta carimba o acesso a cada
        request, com primeiro acesso, ultimo acesso e o IP real.
      </p>
      {limite && <Aviso texto={limite} />}

      <div className="flex flex-wrap items-center gap-3">
        <SeletorPessoa usuarios={usuarios} valor={filtro} aoTrocar={setFiltro} rotulo="Filtrar por" />
        {!!filtro && (
          <button onClick={() => setFiltro("")} className="text-[11px] text-primary hover:underline">
            ver de todo mundo
          </button>
        )}
      </div>

      {lista === null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando...
        </p>
      ) : lista.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {disponivel ? "Nenhum acesso registrado ainda." : "Sem inventario nesta instalacao."}
        </p>
      ) : (
        <div className="divide-y rounded-lg border">
          {lista.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <Laptop className={`h-4 w-4 shrink-0 ${d.revogado ? "text-red-500" : "text-muted-foreground"}`} />
              <div className="min-w-0 flex-1">
                <p className={`truncate text-xs font-medium ${d.revogado ? "text-muted-foreground line-through" : ""}`}>
                  {rotuloDispositivo(d)}
                  <span className="ml-2 font-normal text-[11px] text-muted-foreground">#{d.impressao}</span>
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {nomeDe(d.user_id)}
                  {" — visto "}
                  {tempoRelativo(d.visto_em) || "nunca"}
                  {d.ip_ultimo ? (
                    <>
                      {" — IP "}
                      {d.ip_ultimo}
                      {d.ip_interno ? " (rede interna: nao identifica de onde a pessoa acessou)" : ""}
                    </>
                  ) : null}
                </p>
                {d.revogado && (
                  <p className="text-[11px] text-red-700">
                    revogado {tempoRelativo(d.revogado_em) || ""}
                    {d.revogado_por_nome ? ` por ${d.revogado_por_nome}` : ""}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {d.robo && (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">ROBO</span>
                )}
                {d.revogado ? (
                  <button
                    onClick={() => mexer(d, false)}
                    disabled={ocupado === d.id || !disponivel}
                    className="rounded-lg bg-green-100 px-3 py-1.5 text-[11px] font-medium text-green-700 hover:opacity-80 disabled:opacity-50">
                    Devolver acesso
                  </button>
                ) : (
                  <button
                    onClick={() => mexer(d, true)}
                    disabled={ocupado === d.id || !disponivel || d.user_id === meuId}
                    title={d.user_id === meuId ? "Voce nao revoga os seus proprios dispositivos" : undefined}
                    className="rounded-lg bg-red-100 px-3 py-1.5 text-[11px] font-medium text-red-700 hover:opacity-80 disabled:opacity-50">
                    Revogar
                  </button>
                )}
                {!d.revogado && (
                  <button
                    onClick={() => apagar(d)}
                    disabled={ocupado === d.id || !disponivel}
                    title="Apagar a linha do inventario (nao revoga: volta no proximo acesso)"
                    className="rounded p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-50">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {erro && <p className="text-[11px] text-red-600">{erro}</p>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════ 3) VISIBILIDADE
type LinhaRestricao = RestricaoUsuario & {
  user_id: string;
  funis_orfaos: string[];
  definido_por_nome: string | null;
  updated_at: string | null;
};

function TelaVisibilidade({ authedFetch, usuarios, meuId, alvoInicial }: { authedFetch: Fetch; usuarios: UsuarioAcesso[]; meuId: string; alvoInicial: string }) {
  const [restricoes, setRestricoes] = useState<LinhaRestricao[] | null>(null);
  const [canais, setCanais] = useState<CanalPublico[]>([]);
  const [funis, setFunis] = useState<{ id: string; nome: string }[]>([]);
  const [avisos, setAvisos] = useState<{ orfaos?: string | null; funis?: string | null; tabela?: string | null }>({});
  const [disponivel, setDisponivel] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [alvo, setAlvo] = useState(alvoInicial);
  const [sel, setSel] = useState<RestricaoUsuario>({ canais: [], funis: [], sem_funil: false });
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const r = await authedFetch("/api/admin/restricoes");
      const j = await r.json();
      if (!r.ok) {
        setErro(j.error || "Nao consegui carregar as restricoes.");
        return;
      }
      setRestricoes(j.restricoes ?? []);
      setCanais(j.canais ?? []);
      setFunis(j.funis ?? []);
      setAvisos({ orfaos: j.aviso_orfaos, funis: j.aviso_funis, tabela: j.aviso });
      setDisponivel(j.disponivel !== false);
    } catch {
      setErro("Nao consegui carregar as restricoes — tente de novo.");
    }
  }, [authedFetch]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  useEffect(() => {
    const linha = restricoes?.find((x) => x.user_id === alvo);
    setSel({
      canais: linha?.canais ?? [],
      funis: linha?.funis ?? [],
      sem_funil: !!linha?.sem_funil,
    });
    setOk(null);
  }, [alvo, restricoes]);

  const pessoa = usuarios.find((u) => u.id === alvo);
  const linhaAtual = restricoes?.find((x) => x.user_id === alvo);
  const ehEu = !!alvo && alvo === meuId;
  const ehSuper = pessoa?.papel === "super_admin";
  const temRecorte = !!sel.canais.length || !!sel.funis.length;
  const travado = ehEu || (ehSuper && temRecorte) || !disponivel;
  const nomesCanais = Object.fromEntries(canais.map((c) => [c.id, c.rotulo]));
  const nomesFunis = Object.fromEntries(funis.map((f) => [f.id, f.nome]));
  const inerte = avisoSemFunilInerte(sel);

  async function salvar() {
    if (!alvo || salvando) return;
    setSalvando(true);
    setErro(null);
    setOk(null);
    try {
      const r = await authedFetch("/api/admin/restricoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: alvo, canais: sel.canais, funis: sel.funis, sem_funil: sel.sem_funil }),
      });
      const j = await r.json();
      if (!r.ok) {
        setErro(j.error || "Falha ao salvar.");
        return;
      }
      setOk(j.aviso ? `Salvo. ${j.aviso}` : "Salvo.");
      carregar();
    } catch {
      setErro("Falha ao salvar — tente de novo.");
    } finally {
      setSalvando(false);
    }
  }

  async function remover() {
    if (!alvo || salvando) return;
    if (!window.confirm(`Remover o recorte de ${pessoa?.nome || "esta pessoa"}? Ela volta a seguir as regras normais do painel.`)) return;
    setSalvando(true);
    setErro(null);
    setOk(null);
    try {
      const r = await authedFetch(`/api/admin/restricoes?user_id=${encodeURIComponent(alvo)}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) {
        setErro(j.error || "Falha ao remover.");
        return;
      }
      setOk("Recorte removido.");
      carregar();
    } catch {
      setErro("Falha ao remover — tente de novo.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="space-y-3">
      {avisos.tabela && <Aviso texto={avisos.tabela} />}
      {avisos.orfaos && <Aviso texto={avisos.orfaos} />}
      {avisos.funis && <Aviso texto={avisos.funis} />}
      <p className="text-[11px] text-muted-foreground">
        Recorte por numero e por funil, por cima das regras que a pessoa ja tem. Nada marcado numa
        coluna = aquela coluna fica livre. Sem recorte nenhum = comportamento de hoje.
      </p>

      <SeletorPessoa usuarios={usuarios} valor={alvo} aoTrocar={setAlvo} />

      {!alvo && <p className="text-[11px] text-muted-foreground">Escolha uma pessoa pra ver ou definir o recorte dela.</p>}

      {!!alvo && ehEu && (
        <Aviso tom="sky" texto="Voce nao pode mexer no seu proprio recorte de visibilidade — peca a um super admin." />
      )}
      {!!alvo && ehSuper && (
        <Aviso texto="Super admin enxerga a conta inteira por definicao — um recorte aqui nao faria nada. Mude o papel primeiro, se e isso que voce quer." />
      )}

      {!!alvo && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <p className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">Numeros (canais)</p>
              {canais.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">Nenhum canal ativo.</p>
              ) : (
                <div className="space-y-1.5">
                  {canais.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        disabled={travado}
                        checked={sel.canais.includes(c.id)}
                        onChange={() => setSel({ ...sel, canais: alternar(sel.canais, c.id) })}
                      />
                      {c.rotulo}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-lg border p-3">
              <p className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">Funis</p>
              {funis.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">Nenhum funil cadastrado.</p>
              ) : (
                <div className="max-h-48 space-y-1.5 overflow-y-auto">
                  {funis.map((f) => (
                    <label key={f.id} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        disabled={travado}
                        checked={sel.funis.includes(f.id)}
                        onChange={() => setSel({ ...sel, funis: alternar(sel.funis, f.id) })}
                      />
                      {f.nome}
                    </label>
                  ))}
                </div>
              )}
              <label className="mt-2 flex items-start gap-2 border-t pt-2 text-xs">
                <input
                  type="checkbox"
                  disabled={travado}
                  checked={sel.sem_funil}
                  onChange={(e) => setSel({ ...sel, sem_funil: e.target.checked })}
                />
                <span>
                  Ve tambem as conversas que ainda nao estao em funil nenhum
                  <span className="block text-[11px] text-muted-foreground">
                    Numa base real isso e muita conversa — sem esta caixa, a pessoa so ve o que ja
                    entrou nos funis escolhidos.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {inerte && <Aviso texto={inerte} />}
          {!!linhaAtual?.funis_orfaos.length && (
            <Aviso
              texto={`Este recorte aponta pra ${linhaAtual.funis_orfaos.length} funil(is) que nao existe(m) mais. O id apagado e ignorado — a pessoa nao fica sem ver nada —, mas vale limpar a selecao.`}
            />
          )}

          <p className="rounded-lg bg-muted px-3 py-2 text-[11px]">
            {explicarRestricao(sel, { canais: nomesCanais, funis: nomesFunis })}
          </p>

          {!!linhaAtual?.definido_por_nome && (
            <p className="text-[11px] text-muted-foreground">
              Definido por {linhaAtual.definido_por_nome}
              {linhaAtual.updated_at ? ` — ${tempoRelativo(linhaAtual.updated_at) || ""}` : ""}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={salvar} disabled={travado || salvando} className={BOTAO}>
              {salvando ? "Salvando..." : "Salvar recorte"}
            </button>
            <button onClick={remover} disabled={ehEu || salvando || !disponivel} className={BOTAO_FRACO}>
              Remover recorte
            </button>
          </div>
        </>
      )}

      {erro && <p className="text-[11px] text-red-600">{erro}</p>}
      {ok && <p className="text-[11px] text-emerald-700">{ok}</p>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════ 4) CHAVES DE API
type Chave = {
  id: string;
  user_id: string;
  nome: string;
  tipo?: string | null;
  rotulo?: string | null;
  escopo?: unknown;
  escopo_resumo?: string;
  expira_em?: string | null;
  expirada?: boolean;
  revogada?: boolean;
  valendo?: boolean;
  criado_em: string;
  ultimo_uso_em?: string | null;
  ultimo_uso_ip?: string | null;
  ultimo_uso_ua?: string | null;
};

function TelaChaves({ authedFetch, usuarios, canais }: { authedFetch: Fetch; usuarios: UsuarioAcesso[]; canais: CanalPublico[] }) {
  const [chaves, setChaves] = useState<Chave[] | null>(null);
  const [recursos, setRecursos] = useState<{ id: string; descricao: string }[]>([]);
  const [escopoOk, setEscopoOk] = useState(true);
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [abertaId, setAbertaId] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState<EscopoChave>(validarEscopoChave({}));
  const [prazo, setPrazo] = useState("");
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const r = await authedFetch("/api/admin/api-keys");
      const j = await r.json();
      if (!r.ok) {
        setErro(j.error || "Nao consegui carregar as chaves.");
        return;
      }
      setChaves(j.chaves ?? []);
      setRecursos(j.recursos ?? []);
      setEscopoOk(j.escopo_disponivel !== false);
      setAviso(j.aviso ?? null);
    } catch {
      setErro("Nao consegui carregar as chaves — tente de novo.");
    }
  }, [authedFetch]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const nomeDe = (id: string) => usuarios.find((u) => u.id === id)?.nome || "(pessoa removida)";

  function abrir(c: Chave) {
    setAbertaId(c.id);
    setRascunho(validarEscopoChave(c.escopo));
    setPrazo(c.expira_em ? String(c.expira_em).slice(0, 10) : "");
    setOk(null);
    setErro(null);
  }

  async function salvar(c: Chave) {
    if (salvando) return;
    setSalvando(true);
    setErro(null);
    setOk(null);
    try {
      const r = await authedFetch("/api/admin/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: c.id,
          // ignorar_janela vai EXPLICITO: a rota sanea o corpo e campo ausente
          // conta como false — sem isso, mexer no canal de uma chave de robo
          // noturno apagaria o privilegio em silencio (ver lib/tela-acesso.ts).
          escopo: corpoDoEscopoAdmin(rascunho),
          expira_em: prazo ? prazo : null,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setErro(j.error || "Falha ao salvar o escopo.");
        return;
      }
      setOk(`Escopo salvo: ${j.escopo_resumo || rotuloEscopo(rascunho)}`);
      setAbertaId(null);
      carregar();
    } catch {
      setErro("Falha ao salvar o escopo — tente de novo.");
    } finally {
      setSalvando(false);
    }
  }

  async function revogar(c: Chave) {
    if (salvando) return;
    if (!window.confirm(`Revogar a chave "${c.nome}" de ${nomeDe(c.user_id)}? O agente que usa essa chave para de funcionar na hora.`)) return;
    setSalvando(true);
    setErro(null);
    try {
      const r = await authedFetch(`/api/admin/api-keys?id=${encodeURIComponent(c.id)}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) {
        setErro(j.error || "Falha ao revogar.");
        return;
      }
      carregar();
    } catch {
      setErro("Falha ao revogar — tente de novo.");
    } finally {
      setSalvando(false);
    }
  }

  const avisoAberto = avisoEscopoAberto(rascunho);

  return (
    <div className="space-y-3">
      {aviso && <Aviso texto={aviso} />}
      <p className="text-[11px] text-muted-foreground">
        Chaves de agente (MCP) de todas as pessoas. O escopo so APERTA: a chave nunca alcanca mais do
        que o dono dela. Trocar o escopo NAO troca o segredo — o agente continua funcionando com a
        mesma chave, com o recorte novo valendo na hora.
      </p>
      <p className="text-[11px] text-muted-foreground">
        Cada pessoa gera a propria chave em <strong>Configuracoes &gt; Minha conta</strong>. Aqui da
        pra apertar o recorte, marcar prazo e revogar.
      </p>

      {chaves === null ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando...
        </p>
      ) : chaves.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">Nenhuma chave criada.</p>
      ) : (
        <div className="space-y-2">
          {chaves.map((c) => (
            <div key={c.id} className="rounded-lg border">
              <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <KeyRound className={`h-4 w-4 shrink-0 ${c.valendo === false ? "text-muted-foreground" : "text-muted-foreground"}`} />
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-xs font-medium ${c.valendo === false ? "text-muted-foreground line-through" : ""}`}>
                    {c.nome} <span className="font-normal text-[11px] text-muted-foreground">— {nomeDe(c.user_id)}</span>
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {c.escopo_resumo || "sem recorte"}
                    {c.ultimo_uso_em ? ` — usada ${tempoRelativo(c.ultimo_uso_em) || ""}` : " — nunca usada"}
                    {c.ultimo_uso_ip ? ` de ${c.ultimo_uso_ip}` : ""}
                  </p>
                  {c.expira_em && (
                    <p className="text-[11px] text-muted-foreground">
                      prazo: {String(c.expira_em).slice(0, 10)}
                      {c.expirada ? " (vencida)" : ""}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {c.revogada && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">REVOGADA</span>}
                  {c.expirada && !c.revogada && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">VENCIDA</span>
                  )}
                  {c.valendo && <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-bold text-green-700">VALENDO</span>}
                  {!c.revogada && (
                    <>
                      <button
                        onClick={() => (abertaId === c.id ? setAbertaId(null) : abrir(c))}
                        disabled={!escopoOk}
                        title={escopoOk ? undefined : "escopo indisponivel nesta instalacao"}
                        className={BOTAO_FRACO}>
                        {abertaId === c.id ? "Fechar" : "Escopo"}
                      </button>
                      <button
                        onClick={() => revogar(c)}
                        disabled={salvando}
                        className="rounded-lg bg-red-100 px-3 py-1.5 text-[11px] font-medium text-red-700 hover:opacity-80 disabled:opacity-50">
                        Revogar
                      </button>
                    </>
                  )}
                </div>
              </div>

              {abertaId === c.id && (
                <div className="space-y-3 border-t bg-muted/30 px-3 py-3">
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={rascunho.somente_leitura}
                      onChange={(e) => setRascunho({ ...rascunho, somente_leitura: e.target.checked })}
                    />
                    Somente leitura (recusa tudo que muda estado)
                  </label>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <p className="mb-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
                        Recursos {rascunho.recursos.length === 0 ? "(nada marcado = todos)" : ""}
                      </p>
                      <div className="max-h-44 space-y-1 overflow-y-auto">
                        {recursos.map((r) => (
                          <label key={r.id} className="flex items-start gap-2 text-[11px]" title={r.descricao}>
                            <input
                              type="checkbox"
                              checked={(rascunho.recursos as string[]).includes(r.id)}
                              onChange={() =>
                                setRascunho(
                                  validarEscopoChave({
                                    ...rascunho,
                                    recursos: alternar(rascunho.recursos, r.id),
                                  })
                                )
                              }
                            />
                            <span>
                              {r.id}
                              <span className="block text-[11px] text-muted-foreground">{r.descricao}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="mb-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
                        Numeros {rascunho.canais.length === 0 ? "(nada marcado = todos)" : ""}
                      </p>
                      <div className="space-y-1">
                        {canais.map((canal) => (
                          <label key={canal.id} className="flex items-center gap-2 text-[11px]">
                            <input
                              type="checkbox"
                              checked={rascunho.canais.includes(canal.id)}
                              onChange={() => setRascunho({ ...rascunho, canais: alternar(rascunho.canais, canal.id) })}
                            />
                            {canal.rotulo}
                          </label>
                        ))}
                      </div>
                      <p className="mt-2 text-[11px] font-semibold uppercase text-muted-foreground">Prazo</p>
                      <input
                        type="date"
                        value={prazo}
                        onChange={(e) => setPrazo(e.target.value)}
                        className="mt-1 rounded border bg-white px-2 py-1 text-[11px] outline-none"
                      />
                      <p className="mt-0.5 text-[11px] text-muted-foreground">Vazio = sem prazo.</p>
                    </div>
                  </div>

                  <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900">
                    <input
                      type="checkbox"
                      checked={rascunho.ignorar_janela}
                      onChange={(e) => setRascunho({ ...rascunho, ignorar_janela: e.target.checked })}
                    />
                    <span>
                      Esta chave trabalha FORA da janela de acesso do dono (robo noturno)
                      <span className="block text-[11px]">
                        E a unica opcao aqui que AFROUXA, e por isso so aparece pra super admin. A
                        pessoa nao consegue marcar isso na propria chave.
                      </span>
                    </span>
                  </label>

                  {avisoAberto && <Aviso texto={avisoAberto} />}
                  <p className="text-[11px]">
                    <span className="text-[11px] font-semibold uppercase text-muted-foreground">Vai ficar</span>{" "}
                    {rotuloEscopo(rascunho)}
                  </p>

                  <div className="flex items-center gap-2">
                    <button onClick={() => salvar(c)} disabled={salvando} className={BOTAO}>
                      {salvando ? "Salvando..." : "Salvar escopo"}
                    </button>
                    <button onClick={() => setAbertaId(null)} className={BOTAO_FRACO}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {erro && <p className="text-[11px] text-red-600">{erro}</p>}
      {ok && <p className="text-[11px] text-emerald-700">{ok}</p>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════ A VISAO
// ═══════════════════════════════════════════════════════ 5) REDEFINIR SENHA
//
// O caminho SEM e-mail pra quem esqueceu a senha: o super admin gera uma senha
// temporaria (a rota escolhe, ninguem digita), mostra UMA vez, e a pessoa troca
// em Meu perfil. O link por e-mail ("Esqueci minha senha", na tela de login)
// continua existindo — mas depende de SMTP no projeto de auth.
function TelaSenha({ authedFetch, usuarios, meuId, alvoInicial }: { authedFetch: Fetch; usuarios: UsuarioAcesso[]; meuId: string; alvoInicial: string }) {
  const [alvo, setAlvo] = useState(alvoInicial);
  const [gerando, setGerando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<{ email: string; senha: string } | null>(null);
  const pessoa = usuarios.find((u) => u.id === alvo);

  async function gerar() {
    if (!alvo) return;
    if (!window.confirm(`Gerar uma senha temporaria para ${pessoa?.nome ?? "esta pessoa"}? A senha atual dela deixa de valer na hora.`)) return;
    setGerando(true);
    setErro(null);
    setResultado(null);
    try {
      const r = await authedFetch("/api/users/senha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: alvo }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setErro(j.error || `erro ${r.status}`);
      else setResultado({ email: j.email, senha: j.senha_temporaria });
    } catch {
      setErro("sem resposta do painel");
    } finally {
      setGerando(false);
    }
  }

  return (
    <div className="space-y-3">
      <Aviso tom="sky" texto="A senha temporaria aparece UMA vez, so aqui. Passe pra pessoa por outro canal e peca pra ela trocar em Meu perfil (a troca exige a senha atual, que sera esta)." />
      <div className="flex flex-wrap items-end gap-2">
        <SeletorPessoa usuarios={usuarios} valor={alvo} aoTrocar={setAlvo} />
        <button className={BOTAO} disabled={!alvo || gerando} onClick={gerar}>
          {gerando ? "Gerando..." : "Gerar senha temporaria"}
        </button>
      </div>
      {alvo === meuId && <Aviso texto="E a sua propria conta: prefira trocar em Meu perfil, que pede a senha atual." />}
      {erro && <Aviso tom="red" texto={erro} />}
      {resultado && (
        <div className="rounded-lg border bg-white p-3 text-xs">
          <p className="mb-1 text-muted-foreground">Senha temporaria de {resultado.email}:</p>
          <p className="select-all font-mono text-base">{resultado.senha}</p>
        </div>
      )}
    </div>
  );
}

export default function AdminAcesso({
  authedFetch,
  usuarios,
  canais,
  meuId,
  podeGerenciarUsuarios,
  podeGerenciarVisibilidade,
  ehSuperAdmin,
  usuarioInicial = "",
  aoSair,
}: {
  authedFetch: Fetch;
  usuarios: UsuarioAcesso[];
  canais: CanalPublico[];
  meuId: string;
  /** permissao `gerenciar_usuarios`: janela e dispositivos */
  podeGerenciarUsuarios: boolean;
  /** permissao `gerenciar_visibilidade`: recorte por funil/canal */
  podeGerenciarVisibilidade: boolean;
  /** chaves de API sao SO super admin (a rota recusa o resto) */
  ehSuperAdmin: boolean;
  /** abre ja com esta pessoa escolhida (o atalho vem do painel da pessoa) */
  usuarioInicial?: string | null;
  aoSair: () => void;
}) {
  const abas: [Aba, string][] = [
    ...((podeGerenciarUsuarios ? [["janela", "Janela de acesso"], ["dispositivos", "Dispositivos"]] : []) as [Aba, string][]),
    ...((podeGerenciarVisibilidade ? [["visibilidade", "Visibilidade"]] : []) as [Aba, string][]),
    ...((ehSuperAdmin ? [["chaves", "Chaves de API"], ["senha", "Redefinir senha"]] : []) as [Aba, string][]),
  ];
  const [aba, setAba] = useState<Aba>(abas[0]?.[0] ?? "janela");
  const alvoInicial = usuarioInicial || "";

  return (
    <div className="flex h-screen flex-col bg-background">
      <CabecalhoTela
        titulo="Acesso e seguranca"
        descricao="Janela de acesso, dispositivos e sessoes, visibilidade e chaves de API"
        icone={ShieldCheck}
        aoVoltar={aoSair}
      />

      {abas.length === 0 ? (
        <div className="p-4">
          <Aviso tom="sky" texto="Voce nao tem permissao pra nenhuma das telas de acesso." />
        </div>
      ) : (
        <>
          <div className="flex border-b text-xs">
            {abas.map(([id, rotulo]) => (
              <button
                key={id}
                onClick={() => setAba(id)}
                className={`flex items-center gap-1.5 px-4 py-2 font-medium ${
                  aba === id ? "border-b-2 border-primary text-primary" : "text-muted-foreground hover:bg-muted"
                }`}>
                {id === "janela" && <Clock className="h-3.5 w-3.5" />}
                {id === "dispositivos" && <Laptop className="h-3.5 w-3.5" />}
                {id === "chaves" && <KeyRound className="h-3.5 w-3.5" />}
                {rotulo}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            <div className="mx-auto max-w-3xl space-y-3">
              {usuarios.length === 0 && aba !== "chaves" && (
                <Aviso
                  tom="sky"
                  texto="A lista de pessoas nao carregou nesta sessao. Abra Configuracoes > Usuarios e permissoes uma vez e volte — e de la que o painel carrega os nomes."
                />
              )}
              {aba === "janela" && podeGerenciarUsuarios && (
                <TelaJanela authedFetch={authedFetch} usuarios={usuarios} meuId={meuId} alvoInicial={alvoInicial} />
              )}
              {aba === "dispositivos" && podeGerenciarUsuarios && (
                <TelaDispositivos authedFetch={authedFetch} usuarios={usuarios} meuId={meuId} alvoInicial={alvoInicial} />
              )}
              {aba === "visibilidade" && podeGerenciarVisibilidade && (
                <TelaVisibilidade authedFetch={authedFetch} usuarios={usuarios} meuId={meuId} alvoInicial={alvoInicial} />
              )}
              {aba === "senha" && ehSuperAdmin && (
                <TelaSenha authedFetch={authedFetch} usuarios={usuarios} meuId={meuId} alvoInicial={alvoInicial} />
              )}
              {aba === "chaves" && ehSuperAdmin && (
                <TelaChaves authedFetch={authedFetch} usuarios={usuarios} canais={canais} />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
