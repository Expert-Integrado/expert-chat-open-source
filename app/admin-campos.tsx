"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ListChecks, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { CabecalhoTela } from "./ui/tela";
import {
  DESCRICAO_TIPO,
  TIPOS_CAMPO,
  type CampoFicha,
  type TipoCampo,
} from "@/lib/campos";

// CONSTRUTOR DA FICHA — a tela (Frente X, card 86ak85nxn).
//
// ONDE ELA VIVE: uma VISAO propria, no padrao que a Frente Q deixou escrito em
// `app/admin-acesso.tsx` e a Frente U repetiu em `app/admin-canais.tsx`
// ("relatorio nao e configuracao"; grade grande nao entra num modal de 672px).
// Aqui a razao e a mesma: a aba de Configuracoes ja carrega SEIS abas numa linha
// sem wrap, e um construtor com tipo por campo, lista de opcoes, reordenacao e
// previa de impacto de remocao nao cabe la.
//
// COMO ELA E ALCANCADA HOJE: pela pagina propria `/campos`
// (`app/campos/page.tsx`), que faz o bootstrap de sessao. A entrada DENTRO do
// painel e COSTURA DECLARADA pro coordenador (`app/home.tsx` tem outro dono nesta
// onda) — contrato na secao desta frente no CLAUDE.md. A tela nao fica orfa: ela
// ja abre e funciona na URL propria.
//
// A REGRA NAO MORA AQUI. Tipo, opcoes, colisao de nome, ordem, veredito de
// remocao e plano de renome sao funcoes PURAS em `lib/campos.ts`, provadas sem
// navegador por `node scripts/prova-campos.ts`. Este arquivo desenha e chama a
// rota; TUDO que ele mostra vem do servidor, inclusive o 403.
//
// O QUE ELA NUNCA FAZ, de proposito:
//   * nao remove campo sem MOSTRAR o impacto medido primeiro (o DELETE sem
//     `confirmar=1` e uma PREVIA que nao muda nada);
//   * nao decide permissao: o gate e `gerenciar_campos` na rota;
//   * nao esconde o valor de campo arquivado — quem mostra isso e a ficha da
//     conversa ("valores sem campo", `app/ficha-campos.tsx`).
//
// A TELA NAO PASSOU POR AJUSTE VISUAL DO ERIC — so componentes e classes que o
// painel ja usa.

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

type Impacto = {
  campo: string;
  conversas: number;
  incompleto: boolean;
  por_canal: { canal: string; conversas: number | null }[];
  veredito: { acao: "remover" | "arquivar" | "recusar"; motivo: string };
  renome: { ok: boolean; migrar?: boolean; motivo: string };
};

type Catalogo = {
  campos: CampoFicha[];
  tipos: { tipo: TipoCampo; descricao: string }[];
  tipos_disponiveis: boolean;
  renome_disponivel: boolean;
  colisoes: { chave: string; nomes: string[] }[];
  max_campos: number;
  max_opcoes: number;
  aviso?: string;
  error?: string;
};

const VAZIO: { nome: string; tipo: TipoCampo; obrigatorio: boolean; opcoes: string; descricao: string } = {
  nome: "",
  tipo: "texto",
  obrigatorio: false,
  opcoes: "",
  descricao: "",
};

// `embutido` = desenhada DENTRO de Configuracoes (tranche 2 da revisao de interface, 03/09/2026):
// sem h-screen, sem cabecalho de tela propria — o modal ja tem os dois. A pagina `/campos`
// continua valendo como link direto (nao embutida).
export default function AdminCampos({
  authedFetch,
  aoSair,
  embutido = false,
}: {
  authedFetch: Fetch;
  aoSair?: () => void;
  embutido?: boolean;
}) {
  const [cat, setCat] = useState<Catalogo | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [novo, setNovo] = useState({ ...VAZIO });
  const [editando, setEditando] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState({ ...VAZIO });
  const [impacto, setImpacto] = useState<Impacto | null>(null);
  // qual gesto o cartao de impacto esta esperando confirmar (arquivar tem previa
  // desde a revisao cega; remover sempre teve)
  const [pendente, setPendente] = useState<{ acao: "arquivar"; campo: CampoFicha } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const r = await authedFetch("/api/campos");
      const j: Catalogo = await r.json().catch(() => ({}) as Catalogo);
      if (!r.ok) {
        setErro(j.error || "nao deu pra carregar os campos");
        setCat(null);
      } else {
        setCat(j);
        setErro(null);
      }
    } catch {
      setErro("nao deu pra carregar os campos");
    } finally {
      setCarregando(false);
    }
  }, [authedFetch]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const chamar = async (body: any) => {
    setOcupado(true);
    setErro(null);
    setOk(null);
    try {
      const r = await authedFetch("/api/campos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErro(j.error || "nao deu pra salvar");
        return null;
      }
      await carregar();
      return j;
    } catch {
      setErro("nao deu pra salvar (falha de rede)");
      return null;
    } finally {
      setOcupado(false);
    }
  };

  const opcoesDoTexto = (s: string) =>
    s
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

  const criar = async () => {
    const j = await chamar({
      acao: "criar",
      nome: novo.nome,
      tipo: novo.tipo,
      obrigatorio: novo.obrigatorio,
      opcoes: novo.tipo === "lista" ? opcoesDoTexto(novo.opcoes) : [],
      descricao: novo.descricao || null,
    });
    if (j) {
      setNovo({ ...VAZIO });
      setOk(j.aviso ? `campo criado — ${j.aviso}` : "campo criado");
    }
  };

  const salvarEdicao = async (c: CampoFicha) => {
    const j = await chamar({
      acao: "editar",
      id: c.id,
      nome: rascunho.nome,
      tipo: rascunho.tipo,
      obrigatorio: rascunho.obrigatorio,
      opcoes: rascunho.tipo === "lista" ? opcoesDoTexto(rascunho.opcoes) : [],
      descricao: rascunho.descricao || null,
    });
    if (j) {
      setEditando(null);
      // O RESULTADO DO RENOME VAI NA TELA, com os DOIS numeros. "renomeado" sem
      // dizer quantos valores foram movidos esconderia justamente o conflito
      // (linha que ja tinha valor no nome novo e NAO foi tocada).
      setOk(
        j.renome
          ? `campo salvo — ${j.renome.renomeadas} valor(es) movido(s) pro nome novo${
              j.renome.conflitos ? `, ${j.renome.conflitos} conversa(s) ja tinham valor no nome novo e nao foram tocadas` : ""
            }`
          : "campo salvo"
      );
    }
  };

  const mover = async (c: CampoFicha, delta: number) => {
    if (!cat) return;
    const ativos = cat.campos.filter((x) => x.ativo);
    const i = ativos.findIndex((x) => x.id === c.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ativos.length) return;
    const ordem = ativos.map((x) => x.nome);
    [ordem[i], ordem[j]] = [ordem[j], ordem[i]];
    // A ROTA EXIGE A LISTA COMPLETA (ver `planoDeOrdem`): lista parcial deixaria
    // os que ficaram de fora com uma `ordem` antiga que colide com as novas, e
    // ordem empatada e ficha que embaralha sozinha entre dois carregamentos.
    const r = await chamar({ acao: "reordenar", ordem });
    if (r) setOk("ordem salva");
  };

  // ARQUIVAR E EM DOIS PASSOS, igual ao remover: o 1o pedido volta PREVIA (nao
  // muda nada) com o impacto medido, e a confirmacao sai do mesmo cartao. Antes o
  // numero de conversas afetadas chegava DEPOIS de arquivar — quando ja nao dava
  // pra decidir com ele.
  const arquivar = async (c: CampoFicha, arquivando: boolean, confirmado = false) => {
    const j = await chamar({
      acao: arquivando ? "arquivar" : "reativar",
      id: c.id,
      ...(confirmado ? { confirmar: true } : {}),
    });
    if (!j) return;
    if (j.previa) {
      setImpacto(j.impacto ? { ...j.impacto, campo: c.nome, veredito: j.veredito } : null);
      setPendente({ acao: "arquivar", campo: c });
      return;
    }
    setPendente(null);
    setImpacto(null);
    const n = j.impacto?.conversas ?? 0;
    setOk(
      arquivando
        ? n > 0
          ? `campo arquivado. ${n} conversa(s) tem valor gravado nele: os valores NAO foram apagados e aparecem na ficha como "valores sem campo".`
          : "campo arquivado (nenhuma conversa tinha valor nele)"
        : "campo reativado"
    );
  };

  const pedirImpacto = async (c: CampoFicha) => {
    setOcupado(true);
    setErro(null);
    setOk(null);
    try {
      const r = await authedFetch(`/api/campos?impacto=${encodeURIComponent(c.nome)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setErro(j.error || "nao deu pra medir o impacto");
      else {
        setPendente(null);
        setImpacto(j.impacto);
      }
    } finally {
      setOcupado(false);
    }
  };

  const remover = async (nome: string) => {
    const c = cat?.campos.find((x) => x.nome === nome);
    if (!c) return;
    setOcupado(true);
    setErro(null);
    try {
      const r = await authedFetch(`/api/campos?id=${encodeURIComponent(c.id)}&confirmar=1`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErro(j.error || "o campo nao foi removido");
        return;
      }
      setImpacto(null);
      setPendente(null);
      setOk(`campo "${nome}" removido`);
      await carregar();
    } finally {
      setOcupado(false);
    }
  };

  if (carregando && !cat) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const ativos = cat?.campos.filter((c) => c.ativo) ?? [];
  const arquivados = cat?.campos.filter((c) => !c.ativo) ?? [];

  return (
    <div className={embutido ? "" : "flex h-screen flex-col bg-background"}>
      {!embutido && (
        <CabecalhoTela
          titulo="Campos da ficha"
          descricao="Quais campos a ficha do contato tem, de que tipo e em que ordem. Quem preenche o valor e o atendente, na conversa."
          icone={ListChecks}
          aoVoltar={aoSair}
          voltarRotulo="Painel"
        />
      )}
      <div className={embutido ? "" : "flex-1 overflow-y-auto p-4 md:p-8"}>
      <div className="mx-auto max-w-3xl space-y-5">
        {embutido && (
          <p className="text-xs text-muted-foreground">
            Quais campos a ficha do contato tem, de que tipo e em que ordem. Quem preenche o valor e o atendente,
            na conversa. Arquivar e renomear medem quantas conversas usam o campo antes de aplicar.
          </p>
        )}

        {cat?.aviso && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs leading-snug text-amber-700 dark:text-amber-400">
            {cat.aviso}
          </p>
        )}
        {erro && (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{erro}</span>
          </p>
        )}
        {ok && <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-700 dark:text-emerald-400">{ok}</p>}

        {/* COLISAO QUE JA EXISTE E PENDENCIA, NAO ERRO: o sync do ChatGuru cria
            campo com o rotulo da tela de origem, e ao longo dos anos a mesma coisa
            aparece escrita de formas diferentes. Ela nao virou unique no banco de
            proposito (a migration abortaria em quem ja tem as duas variantes — ver
            o cabecalho da 0025); aparece aqui pra alguem consertar com contexto. */}
        {!!cat?.colisoes.length && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
            <p className="font-semibold">Campos com nomes que so diferem por caixa ou acento</p>
            <p className="leading-snug">
              Eles disputam o mesmo valor na ficha, e a escrita por nome fica ambigua (a rota recusa em vez de
              chutar). Renomeie ou arquive um deles.
            </p>
            <ul className="mt-1 list-inside list-disc">
              {cat.colisoes.map((c) => (
                <li key={c.chave}>{c.nomes.join("  x  ")}</li>
              ))}
            </ul>
          </div>
        )}

        {/* PREVIA DE IMPACTO — o passo que nao muda nada */}
        {impacto && (
          <div className="rounded-lg border p-3 text-xs">
            <p className="font-semibold">
              Impacto de mexer em &quot;{impacto.campo}&quot;
            </p>
            <p className="mt-1 leading-snug">
              {impacto.conversas} conversa(s) com valor gravado
              {impacto.incompleto && " (contagem INCOMPLETA: algum canal nao respondeu)"}
            </p>
            <ul className="mt-1 text-muted-foreground">
              {impacto.por_canal.map((p) => (
                <li key={p.canal}>
                  {p.canal}: {p.conversas === null ? "nao deu pra contar" : p.conversas}
                </li>
              ))}
            </ul>
            <p className="mt-2 leading-snug">{impacto.veredito.motivo}</p>
            <div className="mt-2 flex gap-2">
              {pendente?.acao === "arquivar" ? (
                <button
                  onClick={() => arquivar(pendente.campo, true, true)}
                  disabled={ocupado}
                  className="rounded-lg border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-60"
                >
                  arquivar mesmo assim
                </button>
              ) : (
                impacto.veredito.acao === "remover" && (
                  <button
                    onClick={() => remover(impacto.campo)}
                    disabled={ocupado}
                    className="rounded-lg bg-destructive px-2 py-1 text-[11px] font-medium text-destructive-foreground disabled:opacity-60"
                  >
                    remover mesmo assim
                  </button>
                )
              )}
              <button
                onClick={() => {
                  setImpacto(null);
                  setPendente(null);
                }}
                className="rounded-lg border px-2 py-1 text-[11px] hover:bg-muted"
              >
                {pendente ? "cancelar" : "fechar"}
              </button>
            </div>
          </div>
        )}

        {/* ─────────── lista dos campos ativos */}
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Na ficha ({ativos.length}/{cat?.max_campos ?? 0})
          </h2>
          {!ativos.length && <p className="text-xs text-muted-foreground">Nenhum campo na ficha ainda.</p>}
          {ativos.map((c, i) => (
            <div key={c.id} className="rounded-lg border p-2">
              {editando === c.id ? (
                <div className="space-y-2">
                  <Formulario
                    valor={rascunho}
                    aoMudar={setRascunho}
                    tipos={cat?.tipos ?? []}
                    tiposDisponiveis={!!cat?.tipos_disponiveis}
                    maxOpcoes={cat?.max_opcoes ?? 0}
                  />
                  {/* RENOME COM VALORES: a tela diz ANTES o que vai acontecer.
                      Sem a 0025 a rota RECUSA (renomear sem migrar esconderia o
                      valor de todo mundo) — dizer isso aqui evita o clique que
                      volta 409. */}
                  {rascunho.nome !== c.nome && !cat?.renome_disponivel && (
                    <p className="text-[11px] leading-snug text-amber-700 dark:text-amber-400">
                      Renomear campo COM valor gravado exige a migration 0025 nesta instalacao (ela move o valor pro
                      nome novo). Sem ela, a rota recusa o rename em vez de esconder o valor.
                    </p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => salvarEdicao(c)}
                      disabled={ocupado}
                      className="rounded-lg bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-60"
                    >
                      salvar
                    </button>
                    <button onClick={() => setEditando(null)} className="rounded-lg border px-2 py-1 text-[11px] hover:bg-muted">
                      cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 text-xs">
                    <p className="font-medium">
                      {c.nome}
                      {c.obrigatorio && <span title="obrigatorio"> *</span>}
                      <span className="ml-1 rounded bg-muted px-1 text-[11px]" title={DESCRICAO_TIPO[c.tipo]}>
                        {c.tipo}
                      </span>
                    </p>
                    {c.tipo === "lista" && <p className="text-[11px] text-muted-foreground">opcoes: {c.opcoes.join(", ")}</p>}
                    {c.descricao && <p className="text-[11px] text-muted-foreground">{c.descricao}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => mover(c, -1)}
                      disabled={i === 0 || ocupado}
                      className="rounded border p-1 disabled:opacity-30 hover:bg-muted"
                      title="subir"
                    >
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => mover(c, 1)}
                      disabled={i === ativos.length - 1 || ocupado}
                      className="rounded border p-1 disabled:opacity-30 hover:bg-muted"
                      title="descer"
                    >
                      <ArrowDown className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => {
                        setEditando(c.id);
                        setRascunho({
                          nome: c.nome,
                          tipo: c.tipo,
                          obrigatorio: c.obrigatorio,
                          opcoes: c.opcoes.join("\n"),
                          descricao: c.descricao ?? "",
                        });
                      }}
                      className="rounded border px-2 py-1 text-[11px] hover:bg-muted"
                    >
                      editar
                    </button>
                    <button
                      onClick={() => arquivar(c, true)}
                      disabled={ocupado}
                      className="rounded border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-60"
                      title="tira o campo do formulario e MANTEM os valores"
                    >
                      arquivar
                    </button>
                    <button
                      onClick={() => pedirImpacto(c)}
                      disabled={ocupado}
                      className="rounded border p-1 hover:bg-muted disabled:opacity-60"
                      title="ver o impacto antes de remover"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>

        {/* ─────────── arquivados */}
        {!!arquivados.length && (
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Arquivados ({arquivados.length})
            </h2>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Fora do formulario da ficha. Os valores gravados NAO foram apagados: eles aparecem na conversa como
              &quot;valores sem campo&quot;, e voltam a ser editaveis se o campo for reativado.
            </p>
            {arquivados.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-dashed p-2 text-xs">
                <span className="line-through text-muted-foreground">{c.nome}</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => arquivar(c, false)}
                    disabled={ocupado}
                    className="flex items-center gap-1 rounded border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-60"
                  >
                    <RotateCcw className="h-3 w-3" /> reativar
                  </button>
                  <button
                    onClick={() => pedirImpacto(c)}
                    disabled={ocupado}
                    className="rounded border p-1 hover:bg-muted disabled:opacity-60"
                    title="ver o impacto antes de remover"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* ─────────── novo campo */}
        <section className="space-y-2 rounded-lg border p-3">
          <h2 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Plus className="h-3 w-3" /> campo novo
          </h2>
          <Formulario
            valor={novo}
            aoMudar={setNovo}
            tipos={cat?.tipos ?? []}
            tiposDisponiveis={!!cat?.tipos_disponiveis}
            maxOpcoes={cat?.max_opcoes ?? 0}
          />
          <button
            onClick={criar}
            disabled={ocupado || !novo.nome.trim()}
            className="rounded-lg bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-60"
          >
            criar campo
          </button>
        </section>
      </div>
      </div>
    </div>
  );
}

function Formulario({
  valor,
  aoMudar,
  tipos,
  tiposDisponiveis,
  maxOpcoes,
}: {
  valor: typeof VAZIO;
  aoMudar: (v: typeof VAZIO) => void;
  tipos: { tipo: TipoCampo; descricao: string }[];
  tiposDisponiveis: boolean;
  maxOpcoes: number;
}) {
  const classe = "w-full rounded-lg border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary";
  const lista = tipos.length ? tipos : TIPOS_CAMPO.map((t) => ({ tipo: t, descricao: DESCRICAO_TIPO[t] }));
  return (
    <div className="space-y-2">
      <label className="block text-xs">
        <span className="text-muted-foreground">nome</span>
        <input className={classe} value={valor.nome} onChange={(e) => aoMudar({ ...valor, nome: e.target.value })} />
      </label>
      <label className="block text-xs">
        <span className="text-muted-foreground">tipo</span>
        <select
          className={classe}
          value={valor.tipo}
          disabled={!tiposDisponiveis}
          onChange={(e) => aoMudar({ ...valor, tipo: e.target.value as TipoCampo })}
        >
          {lista.map((t) => (
            <option key={t.tipo} value={t.tipo}>
              {t.tipo}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-muted-foreground">
          {lista.find((t) => t.tipo === valor.tipo)?.descricao}
        </span>
      </label>
      {valor.tipo === "lista" && (
        <label className="block text-xs">
          <span className="text-muted-foreground">opcoes (uma por linha, ate {maxOpcoes})</span>
          <textarea
            className={`${classe} h-20`}
            value={valor.opcoes}
            onChange={(e) => aoMudar({ ...valor, opcoes: e.target.value })}
          />
        </label>
      )}
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={valor.obrigatorio}
          disabled={!tiposDisponiveis}
          onChange={(e) => aoMudar({ ...valor, obrigatorio: e.target.checked })}
        />
        {/* O QUE "OBRIGATORIO" FAZ ESTA ESCRITO NA TELA, porque ele NAO faz o que
            a palavra sugere: nao existe gate de "preencha antes de concluir" (seria
            politica de produto que ninguem decidiu, e travaria milhares de
            conversas importadas sem valor). Interruptor cujo efeito o usuario tem
            que adivinhar e a mesma mentira de interruptor sem efeito. */}
        <span>
          obrigatorio
          <span className="ml-1 text-[11px] text-muted-foreground">
            (destaca a pendencia na ficha e impede ESVAZIAR depois de preenchido; nao bloqueia enviar nem concluir
            conversa)
          </span>
        </span>
      </label>
      <label className="block text-xs">
        <span className="text-muted-foreground">ajuda pro atendente (opcional)</span>
        <input
          className={classe}
          value={valor.descricao}
          disabled={!tiposDisponiveis}
          onChange={(e) => aoMudar({ ...valor, descricao: e.target.value })}
        />
      </label>
      {!tiposDisponiveis && (
        <p className="text-[11px] leading-snug text-amber-700 dark:text-amber-400">
          A migration 0025 nao rodou nesta instalacao: tipo, obrigatorio, opcoes e ajuda NAO gravam. O campo nasce
          como texto livre, e a tela nao finge o contrario.
        </p>
      )}
    </div>
  );
}
