"use client";

// EDITOR DE FLUXOS — tela propria do modulo `automacao` (Frente K, 31/08/2026).
//
// ===================================================================
// AJUSTE VISUAL DO ERIC DE DIA — esta tela e nova e ainda NAO passou pela
// validacao visual. A mecanica esta fechada e provada; o acabamento (espaco,
// densidade, hierarquia tipografica) e o que fica pra ele calibrar.
// ===================================================================
//
// POR QUE ESTA TELA E ASSIM, em duas linhas: o fluxo da operacao medida e
// MINUSCULO (241 tem 1 acao; o maior tem 15) e o que e grande e a REDE (414
// chamadas entre fluxos). Canvas de caixinhas por acao teria duas caixas e
// nenhuma utilidade. Entao o nivel 1 e o mapa da REDE e o nivel 2 e uma lista
// curta e ordenada de passos. Sem biblioteca de grafo: lista indentada le
// melhor numa rede larga e rasa, e sobrevive a centenas de itens.
//
// SEGURANCA: fluxo pode ser conteudo de TERCEIRO (importado de outra
// ferramenta, de outra empresa). Nada aqui vira HTML — todo parametro de acao
// e renderizado como TEXTO, e React escapa. Nao existe dangerouslySetInnerHTML
// nesta arvore, e a prova (scripts/prova-editor-fluxo.ts) reprova se aparecer.
// Esta tela tambem NAO EXECUTA fluxo: disparar e so por /api/macros, onde
// moram o preflight e a confirmacao.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Copy, FolderTree,
  GitBranch, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, Workflow, X,
} from "lucide-react";
import { CabecalhoTela } from "../ui/tela";
import { formatarDataHora, resolverFuso } from "@/lib/fuso";
import { authClient } from "@/lib/auth-client";
import type { Session } from "@supabase/supabase-js";
import {
  arvoreDePastas, linhasDoMapa, moverPasso, noPadrao, normalizarPasta, reencadear, removerPasso,
  type Grafo, type NoGrafo, type NoPasta,
} from "@/lib/fluxo/editor";
// A LISTA VEM DO SCHEMA, nao de uma copia aqui: aprovacao so vale onde a acao
// alcanca o cliente, e tela dizendo uma coisa e motor fazendo outra e o defeito que
// mais custa confianca numa tela de automacao.
import { ACOES_QUE_ALCANCAM_CLIENTE } from "@/lib/fluxo/schema";
// FRENTE Y (revisao 1) — a regra de PLATAFORMA da pergunta (3 botoes, 10 itens,
// titulo 20/24) mora aqui e o editor a consulta AO VIVO. O schema deixa passar
// ate 20 opcoes (teto de sanidade do jsonb); quem recusa e o preflight, na hora
// de rodar. Sem este aviso, o fluxo era salvo e so falhava na frente do cliente.
import { validarInterativa } from "@/lib/interativas";

const NOME_PAINEL = process.env.NEXT_PUBLIC_NOME_PAINEL || "Central de Atendimento";

type FluxoItem = {
  slug: string;
  nome: string;
  tipo: string;
  ativo: boolean;
  pasta: string;
  descricao?: string | null;
  origem: { ferramenta: string; id_original: string | null } | null;
  invalido: boolean;
  erros: string[];
  passos: number;
  acoes: string[];
  chama: number;
  chamado_por: number;
  chamadas: { sem_alvo: boolean; alvo_nomeado: boolean };
  atualizada_em: string | null;
  atualizado_por: string | null;
};

type PassoDetalhe = {
  id: string;
  ordem: number;
  tipo: string;
  acao: string | null;
  resumo: string;
  na_corrente: boolean;
  alvo: string | null;
  // edicao rapida POR ACAO + visualizacao rapida (card 86ak85nzy)
  desligado: boolean;
  aprovacao: boolean;
  espera_segundos: number | null;
  atraso_segundos: number;
  conteudo: string | null;
};

type Detalhe = FluxoItem & {
  fluxo: any;
  passos_detalhe: PassoDetalhe[];
  chama: any;
  chamado_por: any;
  alvos_ausentes: string[];
};

const ACOES_EDITAVEIS = [
  { tipo: "enviar_texto", rotulo: "Responder" },
  { tipo: "nota_interna", rotulo: "Nota interna" },
  { tipo: "etiquetar", rotulo: "Etiquetar" },
  { tipo: "mudar_status", rotulo: "Mudar status" },
  { tipo: "atribuir_responsavel", rotulo: "Atribuir responsavel" },
  { tipo: "mover_funil", rotulo: "Mover no funil" },
  // FRENTE Y (revisao 1): sem esta linha o passo de pergunta existia no motor e
  // no formato, mas NAO tinha caminho humano — so POST na mao criava um. O card
  // 86ak86jvw cobra capacidade de produto, nao so a acao no schema.
  { tipo: "perguntar_opcoes", rotulo: "Perguntar com opcoes" },
  { tipo: "espera", rotulo: "Esperar" },
];
const ROTULO_ACAO: Record<string, string> = Object.fromEntries(
  ACOES_EDITAVEIS.map((a) => [a.tipo, a.rotulo])
);
const STATUS = ["aberto", "atendimento", "concluido", "aguardando"];

// ---------------------------------------------------------------- Frente P
// Duas vistas novas na MESMA tela, e nao duas paginas: as duas falam do mesmo
// objeto (o fluxo) e a pessoa alterna entre "editar" e "testar / liberar" sem
// perder o contexto. `app/home.tsx` NAO foi tocado (outro dono nesta onda).
type Vista = "lista" | "mapa" | "simulador" | "fila" | "intencoes";

const ROTULO_VISTA: Record<Vista, string> = {
  lista: "Fluxos",
  mapa: "Mapa da rede",
  simulador: "Simulador",
  fila: "Fila e aprovacoes",
  intencoes: "Intencoes",
};

type ItemFila = {
  id: string;
  execucao_id: string;
  fluxo_slug: string;
  fluxo_nome: string | null;
  canal: string;
  chat_id: string;
  no_id: string;
  estado: string;
  disponivel_em: string;
  origem: string;
  usuario_nome: string | null;
  tentativas: number | null;
  erro: string | null;
  /** parada SEM erro (hoje: o motivo de estar esperando aval) — nunca vermelho */
  aviso: string | null;
  aprovado_por_nome: string | null;
  aprovado_em: string | null;
  criada_em: string;
};

type PassoSimulado = {
  no_id: string;
  acao: string;
  situacao: "rodaria" | "parou" | "pulado" | "desligado";
  detalhe: string;
  atraso_segundos: number;
  aprovacao: boolean;
};

type FluxoSimulado = {
  slug: string;
  nome: string;
  tipo: string;
  ativo: boolean;
  elegivel: boolean;
  motivo: string;
  responderia: boolean;
  textos: string[];
  passos: PassoSimulado[];
  ressalvas: string[];
};

type Simulacao = {
  fluxos: FluxoSimulado[];
  elegiveis: number;
  primeiro: string | null;
  criterio_de_ordem: string;
  ressalvas: string[];
};

/** "2 dias", "5 min", "na hora" — atraso pra gente ler, nunca em segundos crus. */
function atrasoLegivel(seg: number): string {
  if (!seg) return "na hora";
  if (seg < 60) return `${seg}s depois`;
  if (seg < 3600) return `${Math.round(seg / 60)} min depois`;
  if (seg < 86400) return `${Math.round(seg / 3600)}h depois`;
  const dias = Math.round(seg / 86400);
  return `${dias} dia${dias === 1 ? "" : "s"} depois`;
}

const ROTULO_ESTADO_FILA: Record<string, string> = {
  agendado: "Agendado",
  aguardando_aprovacao: "Esperando aprovacao",
  executando: "Rodando agora",
  concluido: "Concluido",
  falhou: "Falhou",
  cancelado: "Cancelado",
  recusado: "Recusado",
};

// Estados em que a cadeia AINDA ANDA — e portanto pode ser cancelada. `executando`
// entra na lista de proposito: uma cadeia reservada por um tick que morreu no meio
// ficava "rodando agora" por 5 minutos sem botao nenhum, e era exatamente quando o
// supervisor mais queria parar a regua. Cancelar em `executando` nao interrompe o
// passo que ja saiu (mensagem enviada nao volta): o tick releu o estado e para no
// passo SEGUINTE.
const ESTADOS_VIVOS_TELA = ["agendado", "aguardando_aprovacao", "executando"];

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ------------------------------------------------- limites do fluxo, na tela
//
// A TELA guarda os dois campos SEMPRE preenchidos (com null e 0 pro "sem limite"),
// e o que vai pro jsonb e so o que configura algo de verdade. Manter na tela um
// `limites?: {...}` opcional obrigaria cada input a lidar com "o objeto ainda nao
// existe" — e e assim que nasce o campo que perde o que a pessoa digitou.
type LimitesEdit = {
  maximo_por_conversa: number | null;
  intervalo_minimo_segundos: number;
};

const LIMITES_VAZIOS: LimitesEdit = { maximo_por_conversa: null, intervalo_minimo_segundos: 0 };

// teto do schema (lib/fluxo/schema.ts): 9998 execucoes e 30 dias de anti-repique.
// Repetidos aqui como NUMERO porque esta tela nao importa o schema; o servidor
// recusa o que passar disso, e a mensagem de erro aparece no painel de salvar.
const MAX_POR_CONVERSA_TELA = 9998;
const MAX_INTERVALO_SEG_TELA = 30 * 24 * 3600;

function limitesDaTela(bruto: unknown): LimitesEdit {
  const l = (bruto ?? {}) as any;
  const max = Number(l.maximo_por_conversa);
  const intervalo = Number(l.intervalo_minimo_segundos);
  return {
    maximo_por_conversa: Number.isInteger(max) && max > 0 ? max : null,
    intervalo_minimo_segundos: Number.isFinite(intervalo) && intervalo > 0 ? Math.round(intervalo) : 0,
  };
}

function limitesParaGravar(l: LimitesEdit): LimitesEdit | null {
  const semNada = l.maximo_por_conversa === null && l.intervalo_minimo_segundos === 0;
  return semNada ? null : l;
}

function BlocoLimites({
  limites,
  mexer,
}: {
  limites: LimitesEdit;
  mexer: (patch: Partial<LimitesEdit>) => void;
}) {
  const comTeto = limites.maximo_por_conversa !== null;
  const classe = "w-24 rounded border px-2 py-1 text-xs outline-none";
  return (
    <div className="mt-3 rounded-lg border bg-white p-2">
      <p className="text-[11px] font-medium text-muted-foreground">
        Limites por conversa (valem quando o fluxo roda pela fila)
      </p>
      <label className="mt-1.5 flex items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          checked={comTeto}
          onChange={(e) => mexer({ maximo_por_conversa: e.target.checked ? 1 : null })}
        />
        <span>rodar no maximo</span>
        <input
          type="number"
          min={1}
          max={MAX_POR_CONVERSA_TELA}
          disabled={!comTeto}
          value={comTeto ? limites.maximo_por_conversa ?? 1 : ""}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            mexer({ maximo_por_conversa: Number.isFinite(n) && n > 0 ? n : 1 });
          }}
          className={`${classe} disabled:opacity-50`}
        />
        <span className="text-muted-foreground">vez(es) na mesma conversa</span>
      </label>
      <label className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
        <span>esperar no minimo</span>
        <input
          type="number"
          min={0}
          max={MAX_INTERVALO_SEG_TELA}
          value={limites.intervalo_minimo_segundos}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            mexer({ intervalo_minimo_segundos: Number.isFinite(n) && n > 0 ? n : 0 });
          }}
          className={classe}
        />
        <span className="text-muted-foreground">
          segundos entre duas execucoes ({atrasoLegivel(limites.intervalo_minimo_segundos)}; 0 = sem
          anti-repique)
        </span>
      </label>
      {/* O que o limite CONTA e o que ja rodou de verdade, nao o que foi
          enfileirado: cadeia cancelada antes do primeiro passo nao queima cota. Sem
          esta linha, "rodar no maximo 1 vez" parecia gasto depois de um
          cancelamento e ninguem entendia por que o fluxo nao rodava mais. */}
      <p className="mt-1 text-[11px] text-muted-foreground">
        A contagem usa as execucoes que realmente rodaram (cancelada antes do primeiro passo nao
        conta), e o intervalo e medido do ULTIMO passo executado.
      </p>
    </div>
  );
}

export default function PaginaFluxos() {
  const [sessao, setSessao] = useState<Session | null>(null);
  const [pronto, setPronto] = useState(false);
  const sessaoRef = useRef<Session | null>(null);
  sessaoRef.current = sessao;

  useEffect(() => {
    authClient.auth.getSession().then(({ data }) => {
      setSessao(data.session);
      setPronto(true);
    });
    const { data: sub } = authClient.auth.onAuthStateChange((_e, s) => setSessao(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const api = useCallback((url: string, init?: RequestInit) => {
    const token = sessaoRef.current?.access_token;
    if (!token) return Promise.reject(new Error("sem sessao"));
    return fetch(url, {
      ...init,
      cache: "no-store",
      headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` },
    });
  }, []);

  if (!pronto) return <Centro>carregando...</Centro>;
  if (!sessao) return <TelaLogin />;
  return <Editor api={api} />;
}

function Centro({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">{children}</div>
  );
}

function TelaLogin() {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [indo, setIndo] = useState(false);
  return (
    <div className="flex h-screen items-center justify-center bg-background p-4">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setIndo(true);
          setErro("");
          const { error } = await authClient.auth.signInWithPassword({ email, password: senha });
          if (error) setErro("E-mail ou senha invalidos.");
          setIndo(false);
        }}
        className="w-full max-w-sm rounded-xl border bg-white p-6 shadow-sm"
      >
        <h1 className="mb-1 text-lg font-semibold">Automacoes</h1>
        <p className="mb-4 text-xs text-muted-foreground">{NOME_PAINEL} — entre com a sua conta.</p>
        <input
          type="email" required placeholder="E-mail" autoComplete="email"
          className="mb-2 w-full rounded-lg border px-3 py-2 text-sm outline-none"
          value={email} onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password" required placeholder="Senha" autoComplete="current-password"
          className="mb-3 w-full rounded-lg border px-3 py-2 text-sm outline-none"
          value={senha} onChange={(e) => setSenha(e.target.value)}
        />
        {erro && <p className="mb-2 text-xs text-red-600">{erro}</p>}
        <button
          type="submit" disabled={indo}
          className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {indo ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </div>
  );
}

// ============================================================== o editor
function Editor({ api }: { api: (url: string, init?: RequestInit) => Promise<Response> }) {
  const [lista, setLista] = useState<FluxoItem[]>([]);
  const [grafo, setGrafo] = useState<Grafo | null>(null);
  const [aviso, setAviso] = useState("");
  const [bloqueio, setBloqueio] = useState("");
  const [pastasOk, setPastasOk] = useState(true);
  const [carregando, setCarregando] = useState(true);
  const [truncado, setTruncado] = useState(false);
  const [totalLido, setTotalLido] = useState<number | null>(null);

  const [busca, setBusca] = useState("");
  const [escopo, setEscopo] = useState<"nome" | "conteudo">("nome");
  const [pastaSel, setPastaSel] = useState("");
  const [abertas, setAbertas] = useState<Set<string>>(new Set());
  const [vista, setVista] = useState<Vista>("lista");

  const [sel, setSel] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<Detalhe | null>(null);
  const [nosEdit, setNosEdit] = useState<any[]>([]);
  // LIMITES do fluxo (por conversa) vivem FORA dos nos — sao campo do fluxo, nao de
  // passo — entao precisam de estado proprio. Sem isto o editor gravava
  // `...detalhe.fluxo` intacto e limite so podia nascer pela importacao: quem
  // quisesse por teto num fluxo feito na mao tinha que editar jsonb no banco.
  const [limitesEdit, setLimitesEdit] = useState<LimitesEdit>(LIMITES_VAZIOS);
  const [sujo, setSujo] = useState(false);
  const [errosSave, setErrosSave] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const params = new URLSearchParams();
      if (busca) params.set("q", busca);
      params.set("escopo", escopo);
      if (pastaSel) params.set("pasta", pastaSel);
      // O grafo e uma segunda leitura da conta inteira: so vale a pena quando a
      // tela realmente usa (o mapa, ou o nome de quem chama no painel aberto).
      // A listagem NAO depende dele — as contagens dela vem da propria rota.
      const precisaGrafo = vista === "mapa" || !!sel;
      const [rl, rg] = await Promise.all([
        api(`/api/fluxos?${params}`),
        precisaGrafo ? api("/api/fluxos?grafo=1") : Promise.resolve(null),
      ]);
      if (rl.status === 403) {
        const j = await rl.json().catch(() => ({}));
        setBloqueio(j.error || "sem acesso ao modulo de automacao");
        setLista([]);
        return;
      }
      setBloqueio("");
      const jl = await rl.json();
      setLista(jl.fluxos ?? []);
      setAviso(jl.aviso ?? "");
      setPastasOk(jl.pastas_disponiveis !== false);
      // teto do servidor: a tela NAO pode mostrar lista cortada com cara de
      // completa (mesma regra do quadro de funil)
      setTruncado(!!jl.truncado);
      setTotalLido(typeof jl.total === "number" ? jl.total : null);
      if (rg?.ok) {
        const jg = await rg.json();
        if (jg.nos)
          setGrafo({
            nos: jg.nos,
            raizes: jg.raizes,
            arestas: jg.arestas,
            fluxos_com_alvo_nao_trazido: jg.fluxos_com_alvo_nao_trazido ?? 0,
            fluxos_sem_alvo: jg.fluxos_sem_alvo ?? 0,
          });
      }
    } catch {
      setAviso("nao foi possivel carregar os fluxos agora");
    } finally {
      setCarregando(false);
    }
  }, [api, busca, escopo, pastaSel, vista, sel]);

  // busca com respiro: nao dispara request por tecla
  useEffect(() => {
    const t = setTimeout(carregar, busca ? 300 : 0);
    return () => clearTimeout(t);
  }, [carregar, busca]);

  const abrir = useCallback(
    async (slug: string) => {
      setSel(slug);
      setDetalhe(null);
      setErrosSave([]);
      setSujo(false);
      const r = await api(`/api/fluxos?slug=${encodeURIComponent(slug)}`);
      if (!r.ok) return;
      const j: Detalhe = await r.json();
      setDetalhe(j);
      setNosEdit(Array.isArray(j.fluxo?.nos) ? JSON.parse(JSON.stringify(j.fluxo.nos)) : []);
      setLimitesEdit(limitesDaTela(j.fluxo?.limites));
    },
    [api]
  );

  const arvore = useMemo(() => arvoreDePastas(lista.map((f) => f.pasta)), [lista]);

  const salvar = async () => {
    if (!detalhe) return;
    setSalvando(true);
    setErrosSave([]);
    try {
      const corpo: any = { ...detalhe.fluxo, id: detalhe.slug, nos: reencadear(nosEdit) };
      // "sem limite" e a AUSENCIA do campo, nao um objeto com zeros: gravar
      // `{maximo_por_conversa: null, intervalo_minimo_segundos: 0}` em todo fluxo
      // encheria o jsonb de configuracao que nao configura nada, e depois ninguem
      // saberia dizer se aquele fluxo teve limite pensado ou herdou o padrao.
      const paraGravar = limitesParaGravar(limitesEdit);
      if (paraGravar) corpo.limites = paraGravar;
      else delete corpo.limites;
      const r = await api("/api/fluxos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          acao: "salvar",
          slug: detalhe.slug,
          atualizada_em: detalhe.atualizada_em,
          fluxo: corpo,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) {
        // NAO gravou: outra pessoa salvou no meio. As alteracoes ficam na tela
        // (sujo continua true) pra nao perder o trabalho de quem digitou.
        setErrosSave([j.detalhe || "alguem salvou antes de voce — recarregue antes de gravar"]);
        return;
      }
      if (!r.ok) {
        // FLUXO INVALIDO NAO GRAVA: os erros aparecem, e nada foi escrito
        setErrosSave(j.erros?.length ? j.erros : [j.error || "nao foi possivel gravar"]);
        return;
      }
      setSujo(false);
      await carregar();
      await abrir(detalhe.slug);
    } finally {
      setSalvando(false);
    }
  };

  const mexer = (fn: (nos: any[]) => any[]) => {
    setNosEdit((n) => fn(n));
    setSujo(true);
    setErrosSave([]);
  };

  const mexerLimites = (patch: Partial<LimitesEdit>) => {
    setLimitesEdit((l) => ({ ...l, ...patch }));
    setSujo(true);
    setErrosSave([]);
  };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Cabecalho
        vista={vista} setVista={setVista} carregando={carregando} recarregar={carregar}
        total={lista.length} grafo={grafo} totalLido={totalLido} truncado={truncado}
      />

      {/* AVISO DE VERSAO (Eric, 09/09/2026): o modulo `automacao` nasce desligado
          (lib/modulos.ts) e AINDA NAO FOI VALIDADO em operacao real. Quem chegou aqui
          ligou o modulo por conta propria — a recomendacao fica na tela ate uma versao
          marcada como estavel. Tirar este aviso e decisao de release, nao de tela. */}
      <p className="flex gap-1.5 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          <strong>Modulo em validacao.</strong> As automacoes por fluxo ainda nao sao uma versao
          estavel: recomendamos <strong>nao ligar este modulo</strong> em uma instalacao nova ate a
          versao estavel sair e, se ja ligou, usar so em teste, nunca no atendimento real.
        </span>
      </p>

      {bloqueio ? (
        <Centro>{bloqueio}</Centro>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* -------- coluna 1: pastas -------- */}
          <aside className="hidden w-60 shrink-0 flex-col border-r bg-white/60 md:flex">
            <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
              <FolderTree className="h-3.5 w-3.5" /> Pastas
            </div>
            {!pastasOk && (
              <p className="border-b bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                Organizacao em pastas indisponivel: a migration 0015 ainda nao foi aplicada nesta
                instalacao. Os fluxos continuam todos aqui.
              </p>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <ItemPasta
                rotulo="Todos os fluxos" caminho="" nivel={0} total={lista.length}
                sel={pastaSel} onSel={setPastaSel} abertas={abertas} setAbertas={setAbertas} filhas={[]}
              />
              {arvore.map((n) => (
                <RamoPasta
                  key={n.caminho} no={n} sel={pastaSel} onSel={setPastaSel}
                  abertas={abertas} setAbertas={setAbertas}
                />
              ))}
            </div>
          </aside>

          {/* -------- coluna 2: lista ou mapa -------- */}
          <section className="flex min-w-0 flex-1 flex-col border-r">
            <BarraBusca
              busca={busca} setBusca={setBusca} escopo={escopo} setEscopo={setEscopo}
              api={api} recarregar={carregar} pastaSel={pastaSel}
            />
            {aviso && (
              <p className="border-b bg-amber-50 px-3 py-2 text-xs text-amber-800">{aviso}</p>
            )}
            {/* LISTA CORTADA NUNCA PARECE COMPLETA: sem este aviso, a busca
                responderia "nenhum fluxo" por um fluxo que existe mas ficou
                fora do teto de leitura. */}
            {truncado && (
              <p className="flex gap-1.5 border-b bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Esta instalacao tem mais fluxos do que esta tela le de uma vez. A lista e a busca
                  cobrem os primeiros {totalLido ?? 0} — use a busca ou entre numa pasta pra
                  alcancar o resto.
                </span>
              </p>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {vista === "mapa" ? (
                <Mapa grafo={grafo} sel={sel} onAbrir={abrir} />
              ) : vista === "simulador" ? (
                <Simulador api={api} onAbrir={abrir} />
              ) : vista === "fila" ? (
                <FilaEAprovacoes api={api} onAbrir={abrir} />
              ) : vista === "intencoes" ? (
                <Intencoes api={api} />
              ) : (
                <Listagem
                  lista={lista} sel={sel} onAbrir={abrir} api={api} recarregar={carregar}
                  pastasOk={pastasOk} carregando={carregando}
                />
              )}
            </div>
          </section>

          {/* -------- coluna 3: passos do fluxo (nivel 2) -------- */}
          <section className="hidden w-[26rem] shrink-0 flex-col overflow-y-auto bg-white/60 lg:flex">
            {!sel ? (
              <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
                Escolha um fluxo pra ver e editar os passos.
              </div>
            ) : !detalhe ? (
              <Centro>abrindo...</Centro>
            ) : (
              <PainelPassos
                detalhe={detalhe} nos={nosEdit} mexer={mexer} sujo={sujo} salvar={salvar}
                salvando={salvando} erros={errosSave} onAbrir={abrir} grafo={grafo}
                limites={limitesEdit} mexerLimites={mexerLimites}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Cabecalho({
  vista, setVista, carregando, recarregar, total, grafo, totalLido, truncado,
}: {
  vista: Vista;
  setVista: (v: Vista) => void;
  carregando: boolean;
  recarregar: () => void;
  total: number;
  grafo: Grafo | null;
  totalLido: number | null;
  truncado: boolean;
}) {
  return (
    <CabecalhoTela
      titulo="Fluxos de automacao"
      descricao="Fluxos, mapa de chamadas, simulador e a fila de execucoes e aprovacoes"
      icone={Workflow}
      aoVoltar={() => { window.location.href = "/"; }}
      voltarRotulo="Painel"
    >
      {/* as 4 vistas nao cabem em 420px lado a lado (varredura de 03/09: vazavam 78px pela
          direita e "Mapa da rede" quebrava em 3 linhas) — a faixa rola de lado e cada aba
          fica numa linha so; o cabecalho ja poe a faixa na linha de baixo abaixo de `md` */}
      <div className="flex max-w-full shrink-0 overflow-x-auto rounded-lg border p-0.5 text-xs">
        {(["lista", "mapa", "simulador", "fila"] as const).map((v) => (
          <button
            key={v} onClick={() => setVista(v)}
            className={cx(
              "shrink-0 whitespace-nowrap rounded px-3 py-1",
              vista === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-black/5"
            )}
          >
            {ROTULO_VISTA[v]}
          </button>
        ))}
      </div>
      <span className="text-xs text-muted-foreground">
        {/* mostrando X de Y: com filtro ou busca, "X fluxos" sozinho parece o
            tamanho da conta e nao e */}
        {totalLido !== null && total !== totalLido
          ? `${total} de ${totalLido}${truncado ? "+" : ""} fluxos`
          : `${total}${truncado ? "+" : ""} fluxo${total === 1 ? "" : "s"}`}
        {grafo ? ` · ${grafo.arestas} chamada${grafo.arestas === 1 ? "" : "s"}` : ""}
      </span>
      <button
        onClick={recarregar}
        className="ml-auto rounded-lg p-1.5 text-muted-foreground hover:bg-black/5"
        title="Recarregar"
      >
        {carregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      </button>
    </CabecalhoTela>
  );
}

// ------------------------------------------------------------- pastas
function RamoPasta({
  no, sel, onSel, abertas, setAbertas,
}: {
  no: NoPasta;
  sel: string;
  onSel: (c: string) => void;
  abertas: Set<string>;
  setAbertas: (s: Set<string>) => void;
}) {
  const aberta = abertas.has(no.caminho);
  return (
    <>
      <ItemPasta
        rotulo={no.nome} caminho={no.caminho} nivel={no.nivel} total={no.total}
        sel={sel} onSel={onSel} abertas={abertas} setAbertas={setAbertas} filhas={no.filhas}
      />
      {aberta &&
        no.filhas.map((f) => (
          <RamoPasta key={f.caminho} no={f} sel={sel} onSel={onSel} abertas={abertas} setAbertas={setAbertas} />
        ))}
    </>
  );
}

function ItemPasta({
  rotulo, caminho, nivel, total, sel, onSel, abertas, setAbertas, filhas,
}: {
  rotulo: string;
  caminho: string;
  nivel: number;
  total: number;
  sel: string;
  onSel: (c: string) => void;
  abertas: Set<string>;
  setAbertas: (s: Set<string>) => void;
  filhas: NoPasta[];
}) {
  const aberta = abertas.has(caminho);
  return (
    <div
      className={cx(
        "flex items-center gap-1 rounded-lg px-2 py-1 text-xs",
        sel === caminho ? "bg-primary/10 font-medium" : "hover:bg-black/5"
      )}
      style={{ paddingLeft: 8 + nivel * 12 }}
    >
      {filhas.length ? (
        <button
          onClick={() => {
            const n = new Set(abertas);
            if (aberta) n.delete(caminho);
            else n.add(caminho);
            setAbertas(n);
          }}
          className="rounded p-0.5 hover:bg-black/10"
          title={aberta ? "Fechar" : "Abrir"}
        >
          {aberta ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
      ) : (
        <span className="w-4" />
      )}
      <button onClick={() => onSel(caminho)} className="min-w-0 flex-1 truncate text-left">
        {rotulo}
      </button>
      {/* pasta fechada mostra o total da SUBARVORE: sem isso ela parece vazia */}
      <span className="shrink-0 text-[11px] text-muted-foreground">{total}</span>
    </div>
  );
}

// ------------------------------------------------------------- busca
function BarraBusca({
  busca, setBusca, escopo, setEscopo, api, recarregar, pastaSel,
}: {
  busca: string;
  setBusca: (v: string) => void;
  escopo: "nome" | "conteudo";
  setEscopo: (v: "nome" | "conteudo") => void;
  api: (url: string, init?: RequestInit) => Promise<Response>;
  recarregar: () => void;
  pastaSel: string;
}) {
  const [criando, setCriando] = useState(false);
  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={busca} onChange={(e) => setBusca(e.target.value)}
            placeholder={escopo === "nome" ? "Buscar por nome ou pasta" : "Buscar no conteudo dos passos"}
            className="w-full rounded-lg border py-1.5 pl-7 pr-2 text-xs outline-none"
          />
        </div>
        <select
          value={escopo} onChange={(e) => setEscopo(e.target.value as any)}
          className="rounded-lg border px-2 py-1.5 text-xs outline-none"
          title="Onde procurar"
        >
          <option value="nome">Nome</option>
          <option value="conteudo">Conteudo</option>
        </select>
        <button
          onClick={() => setCriando(true)}
          className="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground"
        >
          <Plus className="h-3.5 w-3.5" /> Novo
        </button>
      </div>
      {criando && (
        <FormNovo api={api} pasta={pastaSel} onPronto={() => { setCriando(false); recarregar(); }} onCancelar={() => setCriando(false)} />
      )}
    </>
  );
}

// O caso majoritario medido: fluxo de UM passo de resposta. Criar isso tem que
// levar segundos — por isso o formulario e nome + mensagem, e nada mais.
function FormNovo({
  api, pasta, onPronto, onCancelar,
}: {
  api: (url: string, init?: RequestInit) => Promise<Response>;
  pasta: string;
  onPronto: () => void;
  onCancelar: () => void;
}) {
  const [nome, setNome] = useState("");
  const [texto, setTexto] = useState("");
  const [erro, setErro] = useState("");
  const [indo, setIndo] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setIndo(true);
        setErro("");
        const r = await api("/api/fluxos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acao: "criar", nome, texto, pasta }),
        });
        const j = await r.json().catch(() => ({}));
        setIndo(false);
        if (!r.ok) return setErro(j.erros?.join(" | ") || j.error || "nao foi possivel criar");
        onPronto();
      }}
      className="border-b bg-black/5 p-3"
    >
      <div className="mb-2 flex items-center gap-2">
        <input
          autoFocus required value={nome} onChange={(e) => setNome(e.target.value)}
          placeholder="Nome do fluxo"
          className="min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-xs outline-none"
        />
        <button type="button" onClick={onCancelar} className="rounded p-1 hover:bg-black/10">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <textarea
        required value={texto} onChange={(e) => setTexto(e.target.value)}
        placeholder="Mensagem do primeiro passo"
        rows={2}
        className="mb-2 w-full rounded-lg border px-2 py-1.5 text-xs outline-none"
      />
      {erro && <p className="mb-2 text-[11px] text-red-600">{erro}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit" disabled={indo}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
        >
          {indo ? "Criando..." : "Criar fluxo"}
        </button>
        <span className="text-[11px] text-muted-foreground">
          Nasce desligado{pasta ? ` em "${pasta}"` : ""}. Voce liga quando quiser.
        </span>
      </div>
    </form>
  );
}

// --------------------------------------------------------- listagem
function Listagem({
  lista, sel, onAbrir, api, recarregar, pastasOk, carregando,
}: {
  lista: FluxoItem[];
  sel: string | null;
  onAbrir: (slug: string) => void;
  api: (url: string, init?: RequestInit) => Promise<Response>;
  recarregar: () => void;
  pastasOk: boolean;
  carregando: boolean;
}) {
  if (!lista.length) {
    return (
      <p className="p-6 text-center text-xs text-muted-foreground">
        {carregando ? "carregando..." : "Nenhum fluxo por aqui."}
      </p>
    );
  }
  return (
    <ul className="divide-y">
      {lista.map((f) => (
        <LinhaFluxo
          key={f.slug} f={f} sel={sel === f.slug} onAbrir={onAbrir} api={api}
          recarregar={recarregar} pastasOk={pastasOk}
        />
      ))}
    </ul>
  );
}

function LinhaFluxo({
  f, sel, onAbrir, api, recarregar, pastasOk,
}: {
  f: FluxoItem;
  sel: boolean;
  onAbrir: (slug: string) => void;
  api: (url: string, init?: RequestInit) => Promise<Response>;
  recarregar: () => void;
  pastasOk: boolean;
}) {
  const [editando, setEditando] = useState(false);
  const [passosAbertos, setPassosAbertos] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState("");

  // EDICAO RAPIDA (card 86ak85nzy): renomear, mudar pasta e ligar/desligar sem
  // abrir o editor. Escreve na MESMA rota e passa pelo MESMO validarFluxo.
  const patch = async (corpo: Record<string, unknown>) => {
    setOcupado(true);
    setErro("");
    const r = await api("/api/fluxos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // atualizada_em = guarda de edicao concorrente: se alguem gravou depois
      // que esta linha foi lida, a rota responde 409 em vez de sobrescrever
      body: JSON.stringify({ acao: "rapida", slug: f.slug, atualizada_em: f.atualizada_em, ...corpo }),
    });
    const j = await r.json().catch(() => ({}));
    setOcupado(false);
    if (r.status === 409) {
      setErro(j.detalhe || "alguem salvou antes de voce — recarregue");
      recarregar();
      return false;
    }
    if (!r.ok) {
      setErro(j.erros?.join(" | ") || j.error || "nao foi possivel gravar");
      return false;
    }
    recarregar();
    return true;
  };

  return (
    <li className={cx("px-3 py-2", sel && "bg-primary/5")}>
      <div className="flex items-start gap-2">
        <button
          onClick={() => onAbrir(f.slug)}
          className="min-w-0 flex-1 text-left"
          title="Abrir os passos"
        >
          <div className="flex items-center gap-1.5">
            <span className={cx("truncate text-sm", !f.ativo && "text-muted-foreground line-through")}>
              {f.nome}
            </span>
            {f.invalido && (
              <span
                className="flex items-center gap-0.5 rounded bg-red-100 px-1 py-0.5 text-[11px] text-red-700"
                title={f.erros.join(" | ")}
              >
                <AlertTriangle className="h-2.5 w-2.5" /> fora do formato
              </span>
            )}
            {f.origem && (
              <span className="rounded bg-sky-100 px-1 py-0.5 text-[11px] text-sky-700">
                {f.origem.ferramenta}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            {f.pasta && <span className="truncate">{f.pasta}</span>}
            <span>{f.passos} passo{f.passos === 1 ? "" : "s"}</span>
            {f.chamado_por > 0 && (
              <span className="text-amber-700" title="Outros fluxos chamam este">
                chamado por {f.chamado_por}
              </span>
            )}
            {f.chama > 0 && <span>chama {f.chama}</span>}
            {/* SEM NUMERO de proposito: o conversor deduplica a ressalva por
                fluxo, entao "quantas chamadas" nao existe no dado — um fluxo
                com 15 chamadas chegaria como 1. Presenca e o que da pra afirmar. */}
            {f.chamadas?.alvo_nomeado && (
              <span
                className="text-amber-700"
                title="Este fluxo chama outro fluxo, e a importacao nao trouxe o destino. A seta aparece no mapa quando a acao de chamada existir no formato."
              >
                chama outro fluxo (destino nao trazido)
              </span>
            )}
            {f.chamadas?.sem_alvo && (
              <span
                className="text-muted-foreground"
                title="Havia uma chamada sem nenhum destino escolhido na ferramenta de origem. Nao e perda: essa chamada nunca teve para onde ir."
              >
                chamada sem destino configurado
              </span>
            )}
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          <Interruptor ligado={f.ativo} ocupado={ocupado} onMudar={(v) => patch({ ativo: v })} />
          {/* EDICAO RAPIDA POR ACAO (card 86ak85nzy): abre a lista de passos aqui
              mesmo. Ligar/desligar um passo, mudar atraso e espera, marcar aval e
              espiar o conteudo — sem entrar no editor. */}
          <button
            onClick={() => setPassosAbertos((v) => !v)}
            className={cx(
              "rounded p-1 hover:bg-black/5",
              passosAbertos ? "text-primary" : "text-muted-foreground"
            )}
            title="Ver e ajustar os passos aqui mesmo"
          >
            {passosAbertos ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => setEditando((v) => !v)}
            className="rounded p-1 text-muted-foreground hover:bg-black/5"
            title="Editar aqui mesmo"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <BotaoDuplicar slug={f.slug} api={api} recarregar={recarregar} onErro={setErro} />
          <BotaoApagar f={f} api={api} recarregar={recarregar} />
        </div>
      </div>

      {erro && <p className="mt-1 text-[11px] text-red-600">{erro}</p>}
      {editando && (
        <EdicaoRapida
          f={f} pastasOk={pastasOk} ocupado={ocupado}
          onGravar={async (c) => {
            if (await patch(c)) setEditando(false);
          }}
          onCancelar={() => setEditando(false)}
        />
      )}
      {passosAbertos && <PassosRapidos f={f} api={api} recarregar={recarregar} />}
    </li>
  );
}

// ------------------------------------------- edicao rapida POR ACAO (86ak85nzy)
//
// A listagem de ACOES dentro da listagem de fluxos. Cada linha grava sozinha, na
// hora, pela acao `passo` da rota — que passa pelo MESMO validarFluxo do editor.
//
// Duas coisas que esta tela faz de proposito:
//   - guarda o `atualizada_em` NOVO que a rota devolve. Sem isso, desligar dois
//     passos seguidos levaria 409 no segundo (a guarda de edicao concorrente
//     acusaria a PROPRIA edicao anterior);
//   - nao recarrega a lista inteira a cada clique: a resposta ja traz os passos
//     atualizados. Recarregar fecharia o painel na mao de quem esta ajustando.
function PassosRapidos({
  f, api, recarregar,
}: {
  f: FluxoItem;
  api: (url: string, init?: RequestInit) => Promise<Response>;
  recarregar: () => void;
}) {
  const [passos, setPassos] = useState<PassoDetalhe[] | null>(null);
  const [marca, setMarca] = useState<string | null>(f.atualizada_em);
  const [avalQueBloqueia, setAvalQueBloqueia] = useState<string[]>([]);
  const [erro, setErro] = useState("");
  const [ocupado, setOcupado] = useState("");
  const [espiando, setEspiando] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const r = await api(`/api/fluxos?slug=${encodeURIComponent(f.slug)}`);
      const j = await r.json().catch(() => ({}) as any);
      if (!vivo) return;
      if (!r.ok) {
        setErro(j.error || "nao foi possivel ler os passos");
        setPassos([]);
        return;
      }
      setPassos(j.passos_detalhe ?? []);
      setMarca(j.atualizada_em ?? null);
      setAvalQueBloqueia(j.aval_que_bloqueia ?? []);
    })();
    return () => {
      vivo = false;
    };
  }, [api, f.slug]);

  const mexer = async (noId: string, corpo: Record<string, unknown>) => {
    setOcupado(noId);
    setErro("");
    const r = await api("/api/fluxos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acao: "passo", slug: f.slug, no_id: noId, atualizada_em: marca, ...corpo }),
    });
    const j = await r.json().catch(() => ({}) as any);
    setOcupado("");
    if (r.status === 409) {
      setErro(j.detalhe || "alguem salvou antes de voce — recarregue");
      recarregar();
      return;
    }
    if (!r.ok) {
      setErro(j.erros?.length ? j.erros.join(" | ") : j.error || "nao foi possivel gravar");
      return;
    }
    setPassos(j.passos_detalhe ?? []);
    setMarca(j.atualizada_em ?? marca);
    setAvalQueBloqueia(j.aval_que_bloqueia ?? []);
  };

  if (!passos) return <p className="mt-2 text-[11px] text-muted-foreground">lendo os passos...</p>;

  return (
    <div className="mt-2 rounded-lg border bg-white/70 p-2">
      {erro && <p className="mb-1 text-[11px] text-red-600">{erro}</p>}
      {!passos.length && <p className="text-[11px] text-muted-foreground">Este fluxo nao tem passo legivel.</p>}
      <ul className="space-y-1.5">
        {passos.map((p) => {
          const ehEspera = p.acao === "espera";
          const avalVale = avalQueBloqueia.includes(p.id);
          return (
            <li key={p.id} className="rounded border px-2 py-1.5">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 w-4 shrink-0 text-[11px] text-muted-foreground">{p.ordem}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={cx("text-xs font-medium", p.desligado && "text-muted-foreground line-through")}>
                      {ROTULO_ACAO[p.acao ?? ""] ?? p.acao ?? p.tipo}
                    </span>
                    {!p.na_corrente && (
                      <span
                        className="rounded bg-black/10 px-1 py-0.5 text-[11px] text-muted-foreground"
                        title="Este passo esta fora do encadeamento: ele nao roda"
                      >
                        fora da corrente
                      </span>
                    )}
                    {p.atraso_segundos > 0 && !ehEspera && (
                      <span className="text-[11px] text-muted-foreground">
                        depois de {atrasoLegivel(p.atraso_segundos)}
                      </span>
                    )}
                    {p.aprovacao && (
                      <span
                        className={cx(
                          "rounded px-1 py-0.5 text-[11px]",
                          avalVale ? "bg-amber-100 text-amber-800" : "bg-black/10 text-muted-foreground"
                        )}
                        title={
                          avalVale
                            ? "Este passo para esperando aprovacao humana (e o fluxo roda pela fila)"
                            : "A marca esta gravada, mas aqui ela nao bloqueia: aprovacao so vale onde a acao fala com o cliente"
                        }
                      >
                        {avalVale ? "exige aprovacao" : "aval marcado (nao bloqueia)"}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">{p.resumo}</p>

                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {ehEspera ? (
                      <CampoSegundos
                        rotulo="Espera"
                        valor={p.espera_segundos ?? 0}
                        ocupado={ocupado === p.id}
                        onGravar={(seg) => mexer(p.id, { espera_segundos: seg })}
                      />
                    ) : (
                      <CampoSegundos
                        rotulo="Atraso"
                        valor={p.atraso_segundos}
                        ocupado={ocupado === p.id}
                        onGravar={(seg) => mexer(p.id, { atraso_segundos: seg })}
                      />
                    )}
                    {!ehEspera && (
                      <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={p.aprovacao}
                          disabled={ocupado === p.id}
                          onChange={(e) => mexer(p.id, { aprovacao: e.target.checked })}
                        />
                        exige aprovacao
                      </label>
                    )}
                    {p.conteudo !== null && (
                      <button
                        onClick={() => setEspiando((v) => (v === p.id ? null : p.id))}
                        className="text-[11px] text-primary hover:underline"
                      >
                        {espiando === p.id ? "esconder" : "espiar conteudo"}
                      </button>
                    )}
                  </div>

                  {espiando === p.id && p.conteudo !== null && (
                    // TEXTO, nunca HTML: fluxo pode ser conteudo de terceiro
                    // (importado). O React escapa; nada de dangerouslySetInnerHTML.
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-2 text-[11px]">
                      {p.conteudo}
                    </pre>
                  )}
                </div>
                <div
                  className="shrink-0 pt-0.5"
                  title={p.desligado ? "Passo desligado — clique pra ligar" : "Passo ligado — clique pra desligar"}
                >
                  <Interruptor
                    ligado={!p.desligado}
                    ocupado={ocupado === p.id}
                    onMudar={(v) => mexer(p.id, { desligado: !v })}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Passo desligado fica no lugar e nao roda. O atraso de uma acao e a espera que vem antes dela —
        mudar aqui e a mesma coisa que mexer nela no editor.
      </p>
    </div>
  );
}

// ------------------------------------------------ INTENCOES (card 86ak85nzr)
//
// Tres colunas, igual a tela da ferramenta de origem: intencao · palavras-chave ·
// frases de exemplo, mais a PONTUACAO MINIMA. E um testador em cima, porque
// pontuacao minima sem como experimentar e campo que ninguem sabe calibrar.
//
// DIMENSIONAMENTO HONESTO (medido nos 33 backups): 52 intencoes em anos de uso.
// Isto e paridade de MIGRACAO, nao recurso central — a tela e simples de
// proposito e conta sem intencao nenhuma funciona igual.
type IntencaoItem = {
  id: string;
  nome: string;
  palavras_chave: string[];
  frases: string[];
  pontuacao_minima: number;
  ativo: boolean;
  origem_ferramenta: string | null;
  atualizado_por_nome: string | null;
};

type MotivoPontoTela = { tipo: string; termo: string; pontos: number };
type IntencaoPontuadaTela = {
  id: string;
  nome: string;
  pontos: number;
  pontuacao_minima: number;
  reconhecida: boolean;
  motivos: MotivoPontoTela[];
};

type Escala = {
  palavra_chave: number;
  frase_exata: number;
  similaridade: number;
  minima_padrao: number;
  limiar_similaridade: number;
};

function Intencoes({ api }: { api: (url: string, init?: RequestInit) => Promise<Response> }) {
  const [itens, setItens] = useState<IntencaoItem[]>([]);
  const [escala, setEscala] = useState<Escala | null>(null);
  const [aviso, setAviso] = useState("");
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [editando, setEditando] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);
  const [teste, setTeste] = useState("");
  const [resultado, setResultado] = useState<IntencaoPontuadaTela[] | null>(null);

  const carregar = useCallback(
    async (texto?: string) => {
      setCarregando(true);
      try {
        const qs = texto ? `?texto=${encodeURIComponent(texto)}` : "";
        const r = await api(`/api/intencoes${qs}`);
        const j = await r.json().catch(() => ({}) as any);
        if (!r.ok) {
          setErro(j.error || "nao foi possivel ler as intencoes");
          setItens([]);
          return;
        }
        setErro("");
        setItens(j.intencoes ?? []);
        setEscala(j.escala ?? null);
        setAviso(j.aviso ?? "");
        setResultado(j.teste?.resultado ?? null);
      } finally {
        setCarregando(false);
      }
    },
    [api]
  );

  useEffect(() => {
    carregar();
  }, [carregar]);

  const gravar = async (corpo: Record<string, unknown>, id?: string | null) => {
    const r = await api("/api/intencoes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...corpo, ...(id ? { id } : {}) }),
    });
    const j = await r.json().catch(() => ({}) as any);
    if (!r.ok) {
      setErro(j.erros?.length ? j.erros.join(" | ") : j.error || "nao foi possivel gravar");
      return false;
    }
    setErro("");
    await carregar(teste || undefined);
    return true;
  };

  return (
    <div className="p-3">
      {aviso && <p className="mb-2 rounded bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">{aviso}</p>}
      {erro && <p className="mb-2 text-[11px] text-red-600">{erro}</p>}

      {/* TESTADOR: pontua o catalogo contra uma frase, sem gravar e sem enviar
          nada. E leitura pura — o reconhecimento e local (zero API paga). */}
      <div className="mb-3 rounded-lg border bg-white/70 p-2">
        <label className="text-[11px] font-medium text-muted-foreground">
          Testar uma mensagem
          <div className="mt-1 flex gap-1.5">
            <input
              value={teste}
              onChange={(e) => setTeste(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") carregar(teste || undefined);
              }}
              placeholder="quero falar com um atendente"
              className="min-w-0 flex-1 rounded border px-2 py-1 text-xs outline-none"
            />
            <button
              onClick={() => carregar(teste || undefined)}
              className="rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
            >
              Testar
            </button>
          </div>
        </label>
        {escala && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Palavra-chave {escala.palavra_chave} pontos · frase de exemplo igual {escala.frase_exata} ·
            frase parecida {escala.similaridade}. A intencao e reconhecida quando soma a pontuacao minima
            dela (padrao {escala.minima_padrao}).
          </p>
        )}
        {resultado && (
          <ul className="mt-2 space-y-1">
            {!resultado.length && <li className="text-[11px] text-muted-foreground">Nenhuma intencao cadastrada.</li>}
            {resultado.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span
                  className={cx(
                    "rounded px-1 py-0.5",
                    r.reconhecida ? "bg-emerald-100 text-emerald-800" : "bg-black/10 text-muted-foreground"
                  )}
                >
                  {r.pontos} / {r.pontuacao_minima}
                </span>
                <span className={cx(r.reconhecida && "font-medium")}>{r.nome}</span>
                {/* POR QUE pontuou: numero sem explicacao nao ensina a calibrar */}
                {r.motivos.slice(0, 4).map((m, i) => (
                  <span key={i} className="text-muted-foreground">
                    {m.tipo === "frase_exata" ? "frase exata" : m.tipo === "similaridade" ? "parecida" : "palavra"}:{" "}
                    {m.termo} (+{m.pontos})
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {carregando ? "carregando..." : `${itens.length} intencao(oes)`}
        </span>
        <button
          onClick={() => setCriando((v) => !v)}
          className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground"
        >
          <Plus className="h-3 w-3" /> Nova intencao
        </button>
      </div>

      {criando && (
        <FormIntencao
          escala={escala}
          onGravar={async (c) => {
            if (await gravar(c)) setCriando(false);
          }}
          onCancelar={() => setCriando(false)}
        />
      )}

      <ul className="space-y-1.5">
        {itens.map((i) =>
          editando === i.id ? (
            <li key={i.id}>
              <FormIntencao
                inicial={i}
                escala={escala}
                onGravar={async (c) => {
                  if (await gravar(c, i.id)) setEditando(null);
                }}
                onCancelar={() => setEditando(null)}
              />
            </li>
          ) : (
            <li key={i.id} className="rounded border bg-white/70 px-2 py-1.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={cx("text-sm", !i.ativo && "text-muted-foreground line-through")}>{i.nome}</span>
                    <span className="rounded bg-black/10 px-1 py-0.5 text-[11px] text-muted-foreground">
                      minimo {i.pontuacao_minima}
                    </span>
                    {i.origem_ferramenta && (
                      <span className="rounded bg-sky-100 px-1 py-0.5 text-[11px] text-sky-700">
                        {i.origem_ferramenta}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    <span className="font-medium">Palavras:</span>{" "}
                    {i.palavras_chave.length ? i.palavras_chave.join(" · ") : "(nenhuma)"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    <span className="font-medium">Frases:</span>{" "}
                    {i.frases.length ? i.frases.join(" · ") : "(nenhuma)"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Interruptor ligado={i.ativo} ocupado={false} onMudar={(v) => gravar({ ...i, ativo: v }, i.id)} />
                  <button
                    onClick={() => setEditando(i.id)}
                    className="rounded p-1 text-muted-foreground hover:bg-black/5"
                    title="Editar"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <BotaoApagarIntencao id={i.id} nome={i.nome} api={api} recarregar={() => carregar(teste || undefined)} />
                </div>
              </div>
            </li>
          )
        )}
      </ul>
      {!carregando && !itens.length && (
        <p className="p-4 text-center text-xs text-muted-foreground">
          Nenhuma intencao por aqui — e isso nao atrapalha nada: a automacao funciona sem NLU. Intencao serve
          pra um fluxo reagir ao que a pessoa quis dizer, em vez de a palavra exata.
        </p>
      )}
    </div>
  );
}

function FormIntencao({
  inicial, escala, onGravar, onCancelar,
}: {
  inicial?: IntencaoItem;
  escala: Escala | null;
  onGravar: (c: Record<string, unknown>) => void;
  onCancelar: () => void;
}) {
  const [nome, setNome] = useState(inicial?.nome ?? "");
  // uma por linha: colar uma lista de palavras e o gesto real de quem migra
  const [palavras, setPalavras] = useState((inicial?.palavras_chave ?? []).join("\n"));
  const [frases, setFrases] = useState((inicial?.frases ?? []).join("\n"));
  const [minimo, setMinimo] = useState(String(inicial?.pontuacao_minima ?? escala?.minima_padrao ?? 2));
  const linhas = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);
  return (
    <div className="mb-2 rounded-lg border bg-black/5 p-2">
      <div className="grid gap-1.5 sm:grid-cols-2">
        <label className="text-[11px] text-muted-foreground">
          Nome da intencao
          <input
            value={nome} onChange={(e) => setNome(e.target.value)}
            className="mt-0.5 w-full rounded border px-2 py-1 text-xs outline-none"
          />
        </label>
        <label className="text-[11px] text-muted-foreground">
          Pontuacao minima
          <input
            value={minimo} onChange={(e) => setMinimo(e.target.value)} inputMode="numeric"
            className="mt-0.5 w-full rounded border px-2 py-1 text-xs outline-none"
          />
        </label>
      </div>
      <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
        <label className="text-[11px] text-muted-foreground">
          Palavras-chave (uma por linha)
          <textarea
            value={palavras} onChange={(e) => setPalavras(e.target.value)} rows={4}
            className="mt-0.5 w-full rounded border px-2 py-1 text-xs outline-none"
          />
        </label>
        <label className="text-[11px] text-muted-foreground">
          Frases de exemplo (uma por linha)
          <textarea
            value={frases} onChange={(e) => setFrases(e.target.value)} rows={4}
            className="mt-0.5 w-full rounded border px-2 py-1 text-xs outline-none"
          />
        </label>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() =>
            onGravar({
              nome,
              palavras_chave: linhas(palavras),
              frases: linhas(frases),
              pontuacao_minima: Number(minimo),
              ativo: inicial?.ativo ?? true,
            })
          }
          className="rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
        >
          Gravar
        </button>
        <button onClick={onCancelar} className="text-xs text-muted-foreground hover:underline">
          Cancelar
        </button>
      </div>
    </div>
  );
}

function BotaoApagarIntencao({
  id, nome, api, recarregar,
}: {
  id: string;
  nome: string;
  api: (url: string, init?: RequestInit) => Promise<Response>;
  recarregar: () => void;
}) {
  const [confirma, setConfirma] = useState(false);
  if (!confirma) {
    return (
      <button
        onClick={() => setConfirma(true)}
        className="rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600"
        title="Apagar"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[11px]">
      <span className="text-muted-foreground">apagar {nome}?</span>
      <button
        onClick={async () => {
          await api(`/api/intencoes?id=${encodeURIComponent(id)}&confirmar=1`, { method: "DELETE" });
          setConfirma(false);
          recarregar();
        }}
        className="rounded bg-red-600 px-1.5 py-0.5 text-white"
      >
        sim
      </button>
      <button onClick={() => setConfirma(false)} className="text-muted-foreground hover:underline">
        nao
      </button>
    </span>
  );
}

// Segundos com um botao de gravar: campo que grava a cada tecla mandaria um POST
// por digito (e "30" passaria por "3" no caminho, ou seja, gravaria um atraso que
// ninguem pediu).
function CampoSegundos({
  rotulo, valor, ocupado, onGravar,
}: {
  rotulo: string;
  valor: number;
  ocupado: boolean;
  onGravar: (seg: number) => void;
}) {
  const [txt, setTxt] = useState(String(valor));
  useEffect(() => {
    setTxt(String(valor));
  }, [valor]);
  const n = Number(txt);
  const valido = Number.isFinite(n) && n >= 0;
  const mudou = valido && Math.round(n) !== valor;
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
      {rotulo}
      <input
        value={txt}
        onChange={(e) => setTxt(e.target.value)}
        inputMode="numeric"
        className={cx("w-16 rounded border px-1 py-0.5 text-[11px] outline-none", !valido && "border-red-400")}
      />
      s
      {mudou && (
        <button
          disabled={ocupado}
          onClick={() => onGravar(Math.round(n))}
          className="rounded bg-primary px-1.5 py-0.5 text-[11px] font-medium text-primary-foreground disabled:opacity-60"
        >
          gravar
        </button>
      )}
      {valor > 0 && !mudou && <span className="text-[11px]">({atrasoLegivel(valor)})</span>}
    </span>
  );
}

function Interruptor({
  ligado, ocupado, onMudar,
}: {
  ligado: boolean;
  ocupado: boolean;
  onMudar: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onMudar(!ligado)}
      disabled={ocupado}
      title={ligado ? "Ativo — clique pra desligar" : "Desligado — clique pra ligar"}
      className={cx(
        "relative h-4 w-7 shrink-0 rounded-full transition-colors disabled:opacity-50",
        ligado ? "bg-primary" : "bg-black/20"
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all",
          ligado ? "left-3.5" : "left-0.5"
        )}
      />
    </button>
  );
}

function EdicaoRapida({
  f, pastasOk, ocupado, onGravar, onCancelar,
}: {
  f: FluxoItem;
  pastasOk: boolean;
  ocupado: boolean;
  onGravar: (c: Record<string, unknown>) => void;
  onCancelar: () => void;
}) {
  const [nome, setNome] = useState(f.nome);
  const [descricao, setDescricao] = useState(f.descricao ?? "");
  const [pasta, setPasta] = useState(f.pasta);
  return (
    <div className="mt-2 rounded-lg border bg-black/5 p-2">
      <div className="mb-1.5 grid gap-1.5 sm:grid-cols-2">
        <label className="text-[11px] text-muted-foreground">
          Nome
          <input
            value={nome} onChange={(e) => setNome(e.target.value)}
            className="mt-0.5 w-full rounded border px-2 py-1 text-xs outline-none"
          />
        </label>
        <label className="text-[11px] text-muted-foreground">
          Pasta {pastasOk ? "" : "(indisponivel sem a migration 0015)"}
          <input
            value={pasta} onChange={(e) => setPasta(e.target.value)} disabled={!pastasOk}
            placeholder="CRM / Educacional"
            className="mt-0.5 w-full rounded border px-2 py-1 text-xs outline-none disabled:opacity-50"
          />
        </label>
      </div>
      <label className="text-[11px] text-muted-foreground">
        Descricao
        <input
          value={descricao} onChange={(e) => setDescricao(e.target.value)}
          className="mt-0.5 w-full rounded border px-2 py-1 text-xs outline-none"
        />
      </label>
      {pasta !== normalizarPasta(pasta) && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Vai ser gravado como: {normalizarPasta(pasta) || "(raiz)"}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={ocupado}
          onClick={() => onGravar({ nome, descricao, ...(pastasOk ? { pasta } : {}) })}
          className="rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-60"
        >
          Gravar
        </button>
        <button onClick={onCancelar} className="text-xs text-muted-foreground hover:underline">
          Cancelar
        </button>
      </div>
    </div>
  );
}

function BotaoDuplicar({
  slug, api, recarregar, onErro,
}: {
  slug: string;
  api: (url: string, init?: RequestInit) => Promise<Response>;
  recarregar: () => void;
  onErro: (msg: string) => void;
}) {
  const [indo, setIndo] = useState(false);
  return (
    <button
      disabled={indo}
      onClick={async () => {
        setIndo(true);
        onErro("");
        // A RESPOSTA E LIDA, e isso nao e zelo: a rota recusa duplicar fluxo que
        // esta fora do formato canonico (422) e responde 503 sem a migration.
        // Ignorando o corpo, o clique "funcionava" e a copia simplesmente nao
        // aparecia — o pior desfecho possivel pra quem esta organizando fluxo.
        const r = await api("/api/fluxos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acao: "duplicar", slug }),
        });
        const j = await r.json().catch(() => ({}) as any);
        setIndo(false);
        if (!r.ok) {
          onErro(j.erros?.length ? `${j.error}: ${j.erros.join(" | ")}` : j.error || "nao foi possivel duplicar");
          return;
        }
        recarregar();
      }}
      className="rounded p-1 text-muted-foreground hover:bg-black/5"
      title="Duplicar (a copia nasce desligada, na mesma pasta, com os mesmos passos)"
    >
      <Copy className="h-3.5 w-3.5" />
    </button>
  );
}

// Apagar SEMPRE confirma. E quando o servidor devolve 409 (fluxo importado, ou
// fluxo que outros chamam), o aviso do servidor aparece e exige um segundo OK —
// fluxo importado nunca some sem aviso.
function BotaoApagar({
  f, api, recarregar,
}: {
  f: FluxoItem;
  api: (url: string, init?: RequestInit) => Promise<Response>;
  recarregar: () => void;
}) {
  const [passo, setPasso] = useState<"fechado" | "confirma">("fechado");
  const [alerta, setAlerta] = useState<{ texto: string; importado: boolean; chamadas: boolean } | null>(null);
  const [indo, setIndo] = useState(false);

  const apagar = async (cientes: { importado?: boolean; chamadas?: boolean }) => {
    setIndo(true);
    const p = new URLSearchParams({ slug: f.slug, confirmar: "1" });
    if (cientes.importado) p.set("ciente_importado", "1");
    if (cientes.chamadas) p.set("ciente_chamadas", "1");
    const r = await api(`/api/fluxos?${p}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    setIndo(false);
    if (r.status === 409) {
      setAlerta({
        texto: j.detalhe || j.error || "",
        importado: cientes.importado || j.error === "fluxo importado",
        chamadas: cientes.chamadas || j.error === "fluxo chamado por outros",
      });
      return;
    }
    setPasso("fechado");
    setAlerta(null);
    recarregar();
  };

  return (
    <>
      <button
        onClick={() => setPasso("confirma")}
        className="rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600"
        title="Apagar"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      {passo === "confirma" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl border bg-white p-4 shadow-lg">
            <h2 className="mb-1 text-sm font-semibold">Apagar &quot;{f.nome}&quot;?</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Isso remove o fluxo desta instalacao. A trilha do que ja rodou continua guardada.
            </p>
            {alerta && (
              <p className="mb-3 flex gap-1.5 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>{alerta.texto}</span>
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => { setPasso("fechado"); setAlerta(null); }}
                className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-black/5"
              >
                Cancelar
              </button>
              <button
                disabled={indo}
                onClick={() => apagar({ importado: alerta?.importado, chamadas: alerta?.chamadas })}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
              >
                {alerta ? "Apagar mesmo assim" : "Apagar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------- NIVEL 1: mapa da rede
function Mapa({
  grafo, sel, onAbrir,
}: {
  grafo: Grafo | null;
  sel: string | null;
  onAbrir: (slug: string) => void;
}) {
  const linhas = useMemo(() => (grafo ? linhasDoMapa(grafo) : []), [grafo]);
  const porSlug = useMemo(
    () => new Map((grafo?.nos ?? []).map((n: NoGrafo) => [n.slug, n])),
    [grafo]
  );
  if (!grafo) return <p className="p-6 text-center text-xs text-muted-foreground">carregando o mapa...</p>;

  return (
    <div className="p-3">
      {grafo.arestas === 0 && (
        <div className="mb-3 rounded-lg border bg-amber-50 p-3 text-xs text-amber-800">
          <p className="mb-1 font-medium">Nenhuma chamada entre fluxos foi encontrada.</p>
          <p>
            O formato canonico ainda nao tem a acao de chamar outro fluxo, e a importacao registra
            essas chamadas como ressalva — o destino nao chega ao banco.
            {grafo.fluxos_com_alvo_nao_trazido > 0 && (
              <>
                {" "}
                Nesta instalacao, <strong>{grafo.fluxos_com_alvo_nao_trazido}</strong> fluxo(s)
                chamam outro fluxo com destino que a importacao nao trouxe
                {grafo.fluxos_sem_alvo > 0 && (
                  <> e {grafo.fluxos_sem_alvo} tem chamada que nunca teve destino configurado</>
                )}
                . Sao fluxos, nao chamadas: a importacao guarda uma ressalva por fluxo, entao
                &quot;quantas chamadas&quot; nao esta no dado.
              </>
            )}{" "}
            O mapa passa a desenhar as setas sozinho quando a acao existir — e, pela medicao feita
            no acervo de origem, deve alcancar cerca de 96% das chamadas reais; o resto e nome
            ambiguo ou alvo ja apagado, que vira ressalva em vez de chute.
          </p>
        </div>
      )}
      <ul className="space-y-0.5">
        {linhas.map((l, i) => {
          const n = porSlug.get(l.slug);
          if (!n) return null;
          return (
            <li key={`${l.slug}-${i}`} style={{ paddingLeft: l.nivel * 18 }}>
              <button
                onClick={() => onAbrir(l.slug)}
                className={cx(
                  "flex w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-left text-xs",
                  sel === l.slug ? "border-primary bg-primary/10" : "bg-white hover:bg-black/5",
                  !n.ativo && "opacity-60"
                )}
              >
                {l.nivel > 0 && <span className="text-muted-foreground">&rarr;</span>}
                <span className={cx("truncate", !n.ativo && "line-through")}>{n.nome}</span>
                {n.chamado_por.length > 0 && (
                  <span className="shrink-0 rounded bg-amber-100 px-1 text-[11px] text-amber-800">
                    {n.chamado_por.length} chamam
                  </span>
                )}
                {l.repetido && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">(ja aparece acima)</span>
                )}
                {n.alvos_ausentes.length > 0 && (
                  <span
                    className="shrink-0 rounded bg-red-100 px-1 text-[11px] text-red-700"
                    title={n.alvos_ausentes.join(", ")}
                  >
                    {n.alvos_ausentes.length} destino(s) sem fluxo
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------- NIVEL 2: passos do fluxo
function PainelPassos({
  detalhe, nos, mexer, sujo, salvar, salvando, erros, onAbrir, grafo, limites, mexerLimites,
}: {
  detalhe: Detalhe;
  nos: any[];
  mexer: (fn: (nos: any[]) => any[]) => void;
  sujo: boolean;
  salvar: () => void;
  salvando: boolean;
  erros: string[];
  onAbrir: (slug: string) => void;
  grafo: Grafo | null;
  limites: LimitesEdit;
  mexerLimites: (patch: Partial<LimitesEdit>) => void;
}) {
  const [novo, setNovo] = useState("enviar_texto");
  const chamadores: string[] = Array.isArray(detalhe.chamado_por) ? detalhe.chamado_por : [];
  const nomeDe = (slug: string) => grafo?.nos.find((n) => n.slug === slug)?.nome ?? slug;

  const trocar = (i: number, acao: any) =>
    mexer((ns) => ns.map((n, j) => (j === i ? { ...n, acao } : n)));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{detalhe.nome}</h2>
          <span className="rounded bg-black/5 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {detalhe.tipo}
          </span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {detalhe.pasta || "(sem pasta)"} · {detalhe.slug}
          {detalhe.atualizado_por ? ` · alterado por ${detalhe.atualizado_por}` : ""}
        </p>
      </div>

      {/* QUEM CHAMA ESTE FLUXO — requisito, nao extra */}
      {chamadores.length > 0 && (
        <div className="border-b bg-amber-50/60 px-3 py-2">
          <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-amber-800">
            <GitBranch className="h-3 w-3" /> {chamadores.length} fluxo(s) chamam este
          </p>
          <div className="flex flex-wrap gap-1">
            {chamadores.slice(0, 20).map((s) => (
              <button
                key={s} onClick={() => onAbrir(s)}
                className="rounded bg-white px-1.5 py-0.5 text-[11px] hover:bg-black/5"
              >
                {nomeDe(s)}
              </button>
            ))}
            {chamadores.length > 20 && (
              <span className="text-[11px] text-muted-foreground">+{chamadores.length - 20}</span>
            )}
          </div>
        </div>
      )}

      {detalhe.invalido && (
        <div className="border-b bg-red-100 px-3 py-2 text-[11px] text-red-700">
          <p className="font-medium">Este fluxo esta fora do formato canonico.</p>
          <ul className="mt-0.5 list-disc pl-4">
            {detalhe.erros.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!nos.length && (
          <p className="mb-2 text-xs text-muted-foreground">Nenhum passo ainda. Adicione o primeiro.</p>
        )}
        <ol className="space-y-2">
          {nos.map((no, i) => (
            <li key={i} className="rounded-lg border bg-white p-2">
              <div className="mb-1.5 flex items-center gap-1.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/5 text-[11px] font-medium">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {ROTULO_ACAO[no?.acao?.tipo] ?? no?.acao?.tipo ?? no?.tipo ?? "passo"}
                </span>
                <button
                  onClick={() => mexer((ns) => moverPasso(ns, i, i - 1))}
                  disabled={i === 0}
                  className="rounded p-0.5 text-muted-foreground hover:bg-black/5 disabled:opacity-30"
                  title="Subir"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => mexer((ns) => moverPasso(ns, i, i + 1))}
                  disabled={i === nos.length - 1}
                  className="rounded p-0.5 text-muted-foreground hover:bg-black/5 disabled:opacity-30"
                  title="Descer"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => mexer((ns) => removerPasso(ns, i))}
                  className="rounded p-0.5 text-muted-foreground hover:bg-red-50 hover:text-red-600"
                  title="Remover passo"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <CamposDaAcao acao={no?.acao} onMudar={(a) => trocar(i, a)} />
              {/* APROVACAO E DO PASSO, nao do fluxo: e o passo que manda a mensagem
                  que alguem quer conferir antes. E ela SO APARECE onde a acao fala
                  com o cliente — aprovar nota interna, etiqueta ou status nao protege
                  ninguem (nada sai pra fora, e tudo ali e reversivel) e enchia a fila
                  de aprovacao de ruido. Marcar aqui faz a cadeia PARAR neste ponto e
                  esperar aval na aba "Fila e aprovacoes" — e, por consequencia, este
                  fluxo deixa de rodar como macro instantaneo. O aviso aparece na hora
                  de marcar, senao a pessoa marca o checkbox e o botao do macro fica
                  "indisponivel" sem explicacao. */}
              {ACOES_QUE_ALCANCAM_CLIENTE.includes(no?.acao?.tipo) ? (
                <label className="mt-1.5 flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={no?.aprovacao === true}
                    onChange={(e) =>
                      mexer((ns) =>
                        ns.map((n, j) => {
                          if (j !== i) return n;
                          const copia = { ...n };
                          if (e.target.checked) copia.aprovacao = true;
                          else delete copia.aprovacao;
                          return copia;
                        })
                      )
                    }
                  />
                  <span>
                    exige aprovacao humana antes de rodar este passo
                    {no?.aprovacao === true && (
                      <span className="block text-[11px] text-amber-700">
                        com isto o fluxo roda pela FILA (nao mais como macro instantaneo) e para
                        aqui ate alguem com permissao de aprovar decidir
                      </span>
                    )}
                  </span>
                </label>
              ) : (
                no?.aprovacao === true && (
                  // marca que veio da importacao num passo interno: ela NAO bloqueia,
                  // e ficar calado sobre isso deixaria a pessoa achando que o passo
                  // esta protegido por um aval que nunca vai ser pedido
                  <p className="mt-1.5 text-[11px] text-amber-800">
                    Este passo esta marcado como &quot;exige aprovacao&quot;, mas a acao dele nao
                    fala com o cliente — a marca NAO bloqueia nada aqui.{" "}
                    <button
                      onClick={() =>
                        mexer((ns) =>
                          ns.map((n, j) => {
                            if (j !== i) return n;
                            const copia = { ...n };
                            delete copia.aprovacao;
                            return copia;
                          })
                        )
                      }
                      className="underline"
                    >
                      tirar a marca
                    </button>
                  </p>
                )
              )}
            </li>
          ))}
        </ol>

        <BlocoLimites limites={limites} mexer={mexerLimites} />

        <div className="mt-3 flex items-center gap-2">
          <select
            value={novo} onChange={(e) => setNovo(e.target.value)}
            className="rounded-lg border px-2 py-1.5 text-xs outline-none"
          >
            {ACOES_EDITAVEIS.map((a) => (
              <option key={a.tipo} value={a.tipo}>{a.rotulo}</option>
            ))}
          </select>
          <button
            onClick={() => mexer((ns) => reencadear([...ns, noPadrao(novo)].filter(Boolean)))}
            className="flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-black/5"
          >
            <Plus className="h-3.5 w-3.5" /> Adicionar passo
          </button>
        </div>
      </div>

      <div className="border-t bg-white px-3 py-2">
        {erros.length > 0 && (
          <div className="mb-2 rounded-lg bg-red-100 p-2 text-[11px] text-red-700">
            <p className="font-medium">Nao gravei — o fluxo ficaria invalido:</p>
            <ul className="mt-0.5 list-disc pl-4">
              {erros.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={salvar} disabled={!sujo || salvando}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {salvando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Salvar fluxo
          </button>
          <span className="text-[11px] text-muted-foreground">
            {sujo ? "alteracoes nao salvas" : "tudo salvo"}
          </span>
        </div>
      </div>
    </div>
  );
}

// Campos por TIPO de acao. Todo valor sai como TEXTO em input — parametro de
// fluxo importado nunca e interpretado como marcacao.
function CamposDaAcao({ acao, onMudar }: { acao: any; onMudar: (a: any) => void }) {
  const tipo = acao?.tipo;
  const set = (campos: Record<string, unknown>) => onMudar({ ...acao, ...campos });
  const classe = "w-full rounded border px-2 py-1 text-xs outline-none";

  if (tipo === "enviar_texto" || tipo === "nota_interna") {
    return (
      <textarea
        rows={3} value={typeof acao.texto === "string" ? acao.texto : ""}
        onChange={(e) => set({ texto: e.target.value })}
        placeholder={tipo === "enviar_texto" ? "Mensagem que vai pro cliente" : "Anotacao interna"}
        className={classe}
      />
    );
  }
  if (tipo === "etiquetar") {
    const etiquetas = Array.isArray(acao.etiquetas) ? acao.etiquetas : [];
    return (
      <div className="grid gap-1.5 sm:grid-cols-[1fr,auto]">
        <input
          value={etiquetas.join(", ")}
          onChange={(e) =>
            set({ etiquetas: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })
          }
          placeholder="etiquetas separadas por virgula"
          className={classe}
        />
        <select value={acao.modo ?? "adicionar"} onChange={(e) => set({ modo: e.target.value })} className={classe}>
          <option value="adicionar">adicionar</option>
          <option value="remover">remover</option>
          <option value="substituir">substituir</option>
        </select>
      </div>
    );
  }
  // FRENTE Y (revisao 1) — PERGUNTAR COM OPCOES.
  //
  // O payload mora em `params` (contrato da frente S), entao aqui NAO se usa o
  // `set` das outras acoes — ele espalha no topo da acao e criaria
  // `acao.texto` solto, que `validarAcao` ignora.
  //
  // UMA OPCAO POR LINHA, e linha em branco e AUSENCIA (mesma leitura do schema e
  // do conversor). Colar uma lista do bloco de notas tem que funcionar.
  if (tipo === "perguntar_opcoes") {
    const p = acao.params && typeof acao.params === "object" ? acao.params : {};
    const setP = (campos: Record<string, unknown>) => onMudar({ ...acao, params: { ...p, ...campos } });
    const opcoes: string[] = Array.isArray(p.opcoes)
      ? p.opcoes.map((o: any) => (typeof o === "string" ? o : String(o?.titulo ?? "")))
      : [];
    const tipoPergunta = p.tipo === "lista" ? "lista" : "botoes";
    // AVISO AO VIVO, nao trava: o schema aceita mais do que a plataforma, e quem
    // recusa e o preflight. Melhor a pessoa ver o teto enquanto digita do que o
    // fluxo ser salvo e morrer no meio, com o cliente ja mexido.
    const veredito = validarInterativa({ ...p, tipo: tipoPergunta, opcoes: opcoes.filter((o) => o.trim()) });
    return (
      <div className="grid gap-1.5">
        <div className="flex items-center gap-2">
          <select value={tipoPergunta} onChange={(e) => setP({ tipo: e.target.value })} className={`${classe} w-40`}>
            <option value="botoes">botoes (ate 3)</option>
            <option value="lista">lista (ate 10)</option>
          </select>
          <span className="text-[11px] text-muted-foreground">
            em numero comum (nao a API oficial) a pergunta sai como TEXTO NUMERADO — o cliente responde
            digitando o numero, e o fluxo casa pelo titulo
          </span>
        </div>
        <textarea
          rows={2} value={typeof p.texto === "string" ? p.texto : ""}
          onChange={(e) => setP({ texto: e.target.value })}
          placeholder="A pergunta que o cliente vai ler" className={classe}
        />
        <textarea
          rows={4} value={opcoes.join("\n")}
          onChange={(e) => setP({ opcoes: e.target.value.split("\n") })}
          placeholder={"Uma opcao por linha\nEx: Quero agendar\nEx: So tirar duvida"}
          className={`${classe} font-mono`}
        />
        <div className="grid gap-1.5 sm:grid-cols-2">
          <input
            value={typeof p.titulo === "string" ? p.titulo : ""}
            onChange={(e) => setP({ titulo: e.target.value })}
            placeholder="Titulo (opcional)" className={classe}
          />
          <input
            value={typeof p.rodape === "string" ? p.rodape : ""}
            onChange={(e) => setP({ rodape: e.target.value })}
            placeholder="Rodape (opcional)" className={classe}
          />
        </div>
        {tipoPergunta === "lista" && (
          <input
            value={typeof p.botao_lista === "string" ? p.botao_lista : ""}
            onChange={(e) => setP({ botao_lista: e.target.value })}
            placeholder='Texto do botao que abre a lista (opcional, ex: "Ver opcoes")' className={classe}
          />
        )}
        {!veredito.ok && (
          <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
            {veredito.erros.join("; ")}
          </p>
        )}
      </div>
    );
  }
  if (tipo === "mudar_status") {
    return (
      <select value={acao.status ?? "atendimento"} onChange={(e) => set({ status: e.target.value })} className={classe}>
        {STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    );
  }
  if (tipo === "espera") {
    return (
      <div className="grid gap-1.5">
        <div className="flex items-center gap-2">
          <input
            type="number" min={0} value={Number(acao.segundos) || 0}
            onChange={(e) => set({ segundos: Number(e.target.value) })}
            className={`${classe} w-28`}
          />
          <span className="text-[11px] text-muted-foreground">
            segundos ({atrasoLegivel(Number(acao.segundos) || 0)}) — acima de 15s o fluxo roda pela
            FILA, nao como macro instantaneo
          </span>
        </div>
        {/* PULAR FIM DE SEMANA e da ESPERA, nao do fluxo: numa regua com varias
            esperas, so algumas fazem sentido cair em dia util (o "cobra em 2 dias"
            sim; o "5 minutos depois" nao). O dado da ferramenta de origem tambem
            vinha assim, por espera. E e sobre o DIA, nao sobre horario comercial:
            48h de sexta 10:00 caem na segunda 10:00. */}
        <label className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={acao.pular_fim_de_semana === true}
            onChange={(e) => {
              const proximo = { ...acao };
              if (e.target.checked) proximo.pular_fim_de_semana = true;
              else delete proximo.pular_fim_de_semana;
              onMudar(proximo);
            }}
          />
          <span>
            se a espera terminar num sabado ou domingo, adiar pro dia util seguinte (mesma hora)
          </span>
        </label>
      </div>
    );
  }
  if (tipo === "mover_funil") {
    const sair = acao.etapa === null;
    return (
      <div className="grid gap-1.5">
        <input
          value={typeof acao.funil === "string" ? acao.funil : ""}
          onChange={(e) => set({ funil: e.target.value })}
          placeholder="Nome do funil" className={classe}
        />
        <div className="flex items-center gap-2">
          <input
            value={sair ? "" : typeof acao.etapa === "string" ? acao.etapa : ""}
            onChange={(e) => set({ etapa: e.target.value })}
            disabled={sair} placeholder="Nome da etapa"
            className={`${classe} disabled:opacity-50`}
          />
          <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <input
              type="checkbox" checked={sair}
              onChange={(e) => set({ etapa: e.target.checked ? null : "" })}
            />
            sair do funil
          </label>
        </div>
      </div>
    );
  }
  if (tipo === "atribuir_responsavel") {
    const resp = Array.isArray(acao.responsaveis) ? acao.responsaveis : [];
    return (
      <div className="grid gap-1.5">
        {resp.map((r: any, i: number) => (
          <div key={i} className="flex items-center gap-1.5">
            <select
              value={r?.tipo === "departamento" ? "departamento" : "usuario"}
              onChange={(e) =>
                set({ responsaveis: resp.map((x: any, j: number) => (j === i ? { ...x, tipo: e.target.value } : x)) })
              }
              className={`${classe} w-32`}
            >
              <option value="usuario">usuario</option>
              <option value="departamento">departamento</option>
            </select>
            <input
              value={typeof r?.nome === "string" ? r.nome : ""}
              onChange={(e) =>
                set({ responsaveis: resp.map((x: any, j: number) => (j === i ? { ...x, nome: e.target.value } : x)) })
              }
              placeholder="nome" className={classe}
            />
            <input
              value={typeof r?.id === "string" ? r.id : ""}
              onChange={(e) =>
                set({ responsaveis: resp.map((x: any, j: number) => (j === i ? { ...x, id: e.target.value } : x)) })
              }
              placeholder="id (uuid do painel)" className={classe}
            />
            <button
              onClick={() => set({ responsaveis: resp.filter((_: any, j: number) => j !== i) })}
              className="rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600"
              title="Remover"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button
          onClick={() => set({ responsaveis: [...resp, { tipo: "usuario", id: "", nome: "" }] })}
          className="w-fit rounded border px-2 py-1 text-[11px] hover:bg-black/5"
        >
          + responsavel
        </button>
        <p className="text-[11px] text-muted-foreground">
          O id tem que ser o do painel (uuid). Fluxo importado costuma trazer id sintetico, e o
          motor recusa antes de rodar — casar aqui evita responsavel fantasma.
        </p>
      </div>
    );
  }
  // acao que o editor ainda nao sabe montar (ex.: chamada entre fluxos, que o
  // schema ainda nao tem): mostra como TEXTO, sem deixar editar no escuro.
  return (
    <p className="rounded bg-black/5 p-1.5 text-[11px] text-muted-foreground">
      Acao &quot;{String(tipo ?? "?")}&quot; ainda nao tem formulario nesta tela. O passo continua
      guardado como esta — editar aqui poderia perder informacao.
    </p>
  );
}

// ==========================================================================
// SIMULADOR (Frente P, card 86ak85a69) — "o que aconteceria com esta mensagem".
//
// TELA MINIMA de proposito: o valor esta na RESPOSTA, nao no formulario. Um campo
// de texto, tres campos opcionais de fato e a lista do que cada fluxo faria.
//
// ELA NAO ENVIA NADA, e isso e estrutural, nao promessa: a rota e um GET
// (`/api/fluxos?simular=1`) e a avaliacao mora em `lib/fluxo/simulador.ts`, que
// nao importa banco nem provedor. Nao existe caminho daqui pro cliente final.
// ==========================================================================
function Simulador({
  api,
  onAbrir,
}: {
  api: (url: string, init?: RequestInit) => Promise<Response>;
  onAbrir: (slug: string) => void;
}) {
  const [texto, setTexto] = useState("");
  const [status, setStatus] = useState("");
  const [etiquetas, setEtiquetas] = useState("");
  const [contexto, setContexto] = useState("");
  const [r, setR] = useState<Simulacao | null>(null);
  const [invalidos, setInvalidos] = useState<{ slug: string; nome: string }[]>([]);
  const [erro, setErro] = useState("");
  const [indo, setIndo] = useState(false);
  const [soElegiveis, setSoElegiveis] = useState(true);

  const simular = async () => {
    setIndo(true);
    setErro("");
    try {
      const p = new URLSearchParams({ simular: "1", texto });
      if (status) p.set("status", status);
      if (etiquetas.trim()) p.set("etiquetas", etiquetas.trim());
      if (contexto.trim()) p.set("contexto", contexto.trim());
      const resp = await api(`/api/fluxos?${p.toString()}`);
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setErro(j.error || "nao deu pra simular");
        setR(null);
        return;
      }
      setR(j.simulacao ?? null);
      setInvalidos(j.invalidos ?? []);
    } finally {
      setIndo(false);
    }
  };

  const mostrados = r
    ? soElegiveis
      ? r.fluxos.filter((f) => f.elegivel || f.responderia)
      : r.fluxos
    : [];

  return (
    <div className="space-y-3 p-3">
      <div className="rounded-lg border bg-white p-3">
        <p className="mb-2 text-xs text-muted-foreground">
          Escreva a mensagem que o cliente mandaria. Nada e enviado: isto so avalia as condicoes dos
          fluxos e mostra o que cada um faria.
        </p>
        <textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder="Ex: oi, quero saber o preco"
          rows={2}
          className="w-full rounded border px-2 py-1.5 text-sm"
        />
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <label className="text-[11px] text-muted-foreground">
            Status da conversa
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="mt-0.5 w-full rounded border px-2 py-1 text-xs"
            >
              <option value="">nao informar</option>
              {STATUS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-muted-foreground">
            Etiquetas (separadas por virgula)
            <input
              value={etiquetas}
              onChange={(e) => setEtiquetas(e.target.value)}
              placeholder="Cliente VIP, Aluno"
              className="mt-0.5 w-full rounded border px-2 py-1 text-xs"
            />
          </label>
          <label className="text-[11px] text-muted-foreground">
            Variaveis da conversa (JSON)
            <input
              value={contexto}
              onChange={(e) => setContexto(e.target.value)}
              placeholder={'{"URA":"MENU"}'}
              className="mt-0.5 w-full rounded border px-2 py-1 font-mono text-xs"
            />
          </label>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={simular}
            disabled={indo || !texto.trim()}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {indo ? "Simulando..." : "Simular"}
          </button>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={soElegiveis}
              onChange={(e) => setSoElegiveis(e.target.checked)}
            />
            mostrar so os que disparariam
          </label>
        </div>
        {erro && <p className="mt-2 text-xs text-red-700">{erro}</p>}
      </div>

      {r && (
        <>
          <div className="rounded-lg border bg-white p-3 text-xs">
            <p className="font-medium">
              {r.elegiveis === 0
                ? "Nenhum fluxo dispararia com esta mensagem."
                : `${r.elegiveis} fluxo(s) disparariam.`}
              {r.primeiro && (
                <>
                  {" "}
                  O primeiro a responder seria{" "}
                  <button onClick={() => onAbrir(r.primeiro!)} className="underline">
                    {r.fluxos.find((f) => f.slug === r.primeiro)?.nome ?? r.primeiro}
                  </button>
                  .
                </>
              )}
            </p>
            {/* O CRITERIO DE ORDEM VAI NA CARA: "o primeiro" aqui NAO e prioridade
                configurada, e quem le precisa saber disso antes de tomar decisao em
                cima do resultado. */}
            <p className="mt-1 text-[11px] text-muted-foreground">Ordem: {r.criterio_de_ordem}</p>
            {r.ressalvas.map((x, i) => (
              <p key={i} className="mt-1 flex gap-1.5 text-[11px] text-amber-800">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{x}</span>
              </p>
            ))}
            {invalidos.length > 0 && (
              <p className="mt-1 text-[11px] text-amber-800">
                Fora do formato canonico (nao simulados): {invalidos.map((x) => x.nome).join(", ")}
              </p>
            )}
          </div>

          {mostrados.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              Nada a mostrar com este filtro. Desmarque &quot;mostrar so os que disparariam&quot; pra
              ver por que cada fluxo ficou de fora.
            </p>
          ) : (
            mostrados.map((f) => (
              <div key={f.slug} className="rounded-lg border bg-white p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => onAbrir(f.slug)} className="text-sm font-medium underline">
                    {f.nome}
                  </button>
                  <span
                    className={cx(
                      "rounded px-1.5 py-0.5 text-[11px] font-medium",
                      f.responderia
                        ? "bg-emerald-100 text-emerald-800"
                        : f.elegivel
                          ? "bg-sky-100 text-sky-800"
                          : "bg-black/5 text-muted-foreground"
                    )}
                  >
                    {f.responderia
                      ? "responderia"
                      : f.elegivel
                        ? "dispararia (sem responder)"
                        : "nao dispararia"}
                  </span>
                  {!f.ativo && (
                    <span className="rounded bg-black/5 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      desligado
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{f.motivo}</p>
                <ol className="mt-2 space-y-1">
                  {f.passos.map((p) => (
                    <li key={p.no_id} className="flex gap-2 text-xs">
                      <span
                        className={cx(
                          "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                          p.situacao === "rodaria"
                            ? "bg-emerald-500"
                            : p.situacao === "parou"
                              ? "bg-amber-500"
                              : "bg-black/20"
                        )}
                      />
                      <span
                        className={cx(
                          "min-w-0",
                          (p.situacao === "pulado" || p.situacao === "desligado") && "text-muted-foreground",
                          p.situacao === "desligado" && "line-through"
                        )}
                      >
                        <span className="font-medium">{ROTULO_ACAO[p.acao] ?? p.acao}</span>
                        {p.atraso_segundos > 0 && (
                          <span className="ml-1 text-[11px] text-muted-foreground">
                            ({atrasoLegivel(p.atraso_segundos)})
                          </span>
                        )}
                        {p.aprovacao && (
                          <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[11px] text-amber-800">
                            pede aprovacao
                          </span>
                        )}
                        <span className="block break-words text-[11px] text-muted-foreground">
                          {p.detalhe}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}

// ==========================================================================
// FILA E APROVACOES (Frente P, cards 86ak859wr e 86ak859xn) — TELA MINIMA.
//
// Ela responde tres perguntas, e so essas: o que esta agendado, o que esta travado
// esperando alguem, e quem decidiu o que. Aprovar e recusar sao os dois botoes; o
// resto e leitura.
//
// A TELA NAO FAZ A FILA ANDAR: quem anda e o tick (`POST /api/cron-fluxos`, chamado
// pelo pg_cron). O botao "rodar o tick agora" existe pra dar pra testar a regua
// inteira sem esperar o relogio — e ele bate na MESMA rota autorizada, nunca num
// caminho proprio.
// ==========================================================================
function FilaEAprovacoes({
  api,
  onAbrir,
}: {
  api: (url: string, init?: RequestInit) => Promise<Response>;
  onAbrir: (slug: string) => void;
}) {
  const [itens, setItens] = useState<ItemFila[]>([]);
  const [aviso, setAviso] = useState("");
  const [fuso, setFuso] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState("");
  const [historico, setHistorico] = useState(false);
  const [tick, setTick] = useState("");
  // quem PODE decidir e quem PODE cancelar vem da rota (permissoes diferentes:
  // `aprovar_automacao` e `enviar`). Comeca fechado: enquanto nao chegou resposta,
  // nao mostrar botao que talvez nao seja dele.
  const [podeAprovar, setPodeAprovar] = useState(false);
  const [podeCancelar, setPodeCancelar] = useState(false);
  const [podeRodarTick, setPodeRodarTick] = useState(false);

  const carregar = useCallback(
    async (verHistorico: boolean) => {
      setCarregando(true);
      setErro("");
      try {
        const p = new URLSearchParams();
        if (verHistorico) p.set("estados", "concluido,falhou,cancelado,recusado");
        const r = await api(`/api/fluxo-fila${p.toString() ? `?${p.toString()}` : ""}`);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          setErro(j.error || "nao deu pra ler a fila");
          setItens([]);
          return;
        }
        setItens(j.itens ?? []);
        setAviso(j.aviso ?? "");
        setFuso(j.fuso ?? "");
        setPodeAprovar(j.pode_aprovar === true);
        setPodeCancelar(j.pode_cancelar === true);
        setPodeRodarTick(j.pode_rodar_tick === true);
      } finally {
        setCarregando(false);
      }
    },
    [api]
  );

  useEffect(() => {
    void carregar(historico);
  }, [carregar, historico]);

  const agir = async (id: string, acao: "aprovar" | "recusar" | "cancelar") => {
    setOcupado(id);
    setErro("");
    try {
      const r = await api("/api/fluxo-fila", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acao, id }),
      });
      const j = await r.json().catch(() => ({}));
      // 409 = alguem decidiu antes de voce. A mensagem VEM DO SERVIDOR: e ele que
      // sabe o que aconteceu de verdade, e recarregar sozinho esconderia o motivo.
      if (!r.ok) setErro(j.error || "nao deu pra registrar");
      await carregar(historico);
    } finally {
      setOcupado(null);
    }
  };

  const rodarTick = async () => {
    setTick("rodando...");
    const r = await api("/api/cron-fluxos", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    setTick(
      r.ok
        ? `${j.passos ?? 0} passo(s), ${j.concluidas ?? 0} concluida(s), ${
            j.aguardando_aprovacao ?? 0
          } esperando aval`
        : j.erro || j.error || "o tick nao rodou"
    );
    await carregar(historico);
  };

  const esperando = itens.filter((i) => i.estado === "aguardando_aprovacao");
  const travadas = itens.filter((i) => i.estado === "executando");

  // HORA NO FUSO DA INSTALACAO, nunca no do navegador. O fuso vem da ROTA (a
  // decisao config > env > fabrica mora no servidor); `resolverFuso` so cobre o
  // instante entre abrir a tela e a resposta chegar. Sem isto, dois atendentes em
  // fusos diferentes leriam horas diferentes pro MESMO passo agendado — o defeito
  // que a Frente F pagou na tela de conversa.
  const quando = (iso: string) => formatarDataHora(iso, resolverFuso(fuso)) || iso;

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          onClick={() => setHistorico(false)}
          className={cx("rounded-lg border px-2.5 py-1", !historico && "bg-primary text-primary-foreground")}
        >
          Em andamento
        </button>
        <button
          onClick={() => setHistorico(true)}
          className={cx("rounded-lg border px-2.5 py-1", historico && "bg-primary text-primary-foreground")}
        >
          Historico
        </button>
        <button onClick={() => void carregar(historico)} className="rounded-lg border px-2.5 py-1">
          {carregando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Recarregar"}
        </button>
        {podeRodarTick && (
          <button
            onClick={rodarTick}
            className="rounded-lg border px-2.5 py-1"
            title="processa agora os passos cuja hora chegou"
          >
            Rodar o tick agora
          </button>
        )}
        {tick && <span className="text-[11px] text-muted-foreground">{tick}</span>}
        {fuso && <span className="ml-auto text-[11px] text-muted-foreground">horarios em {fuso}</span>}
      </div>

      {aviso && (
        <p className="flex gap-1.5 rounded-lg border bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{aviso}</span>
        </p>
      )}
      {erro && <p className="rounded-lg border bg-red-50 px-3 py-2 text-xs text-red-800">{erro}</p>}

      {!historico && travadas.length > 0 && (
        <p className="rounded-lg border bg-sky-50 px-3 py-2 text-xs text-sky-900">
          {travadas.length} execucao(oes) em andamento agora. Se alguma ficar presa nisso por mais
          de 5 minutos, o proprio tick a devolve pra fila — e o botao de cancelar tambem funciona
          nelas (a cadeia para no passo seguinte).
        </p>
      )}
      {!historico && esperando.length > 0 && (
        <p className="rounded-lg border bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {esperando.length} execucao(oes) parada(s) esperando aprovacao. Enquanto ninguem decidir,
          nada sai pro cliente.
        </p>
      )}

      {itens.length === 0 && !carregando ? (
        <p className="p-3 text-xs text-muted-foreground">
          {historico
            ? "Nenhuma execucao encerrada por aqui ainda."
            : "Nada agendado. Fluxo com atraso ou com passo de aprovacao aparece nesta lista."}
        </p>
      ) : (
        itens.map((i) => (
          <div key={i.id} className="rounded-lg border bg-white p-3">
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => onAbrir(i.fluxo_slug)} className="text-sm font-medium underline">
                {i.fluxo_nome ?? i.fluxo_slug}
              </button>
              <span
                className={cx(
                  "rounded px-1.5 py-0.5 text-[11px] font-medium",
                  i.estado === "aguardando_aprovacao"
                    ? "bg-amber-100 text-amber-800"
                    : i.estado === "falhou" || i.estado === "recusado"
                      ? "bg-red-100 text-red-800"
                      : i.estado === "concluido"
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-sky-100 text-sky-800"
                )}
              >
                {ROTULO_ESTADO_FILA[i.estado] ?? i.estado}
              </span>
              <span className="rounded bg-black/5 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {i.origem === "gatilho" ? "automacao" : "disparado por gente"}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              conversa {i.chat_id} · canal {i.canal} · passo {i.no_id}
              {i.tentativas ? ` · ${i.tentativas} tentativa(s)` : ""}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {i.estado === "agendado" ? "roda em " : "hora marcada: "}
              {quando(i.disponivel_em)}
              {i.usuario_nome ? ` · em nome de ${i.usuario_nome}` : ""}
            </p>
            {i.aprovado_por_nome && (
              <p className="text-[11px] text-muted-foreground">
                decidido por {i.aprovado_por_nome}
                {i.aprovado_em ? ` em ${quando(i.aprovado_em)}` : ""}
              </p>
            )}
            {/* AVISO e ERRO tem PESOS diferentes e cores diferentes. Parar pra
                esperar aval e comportamento normal do fluxo — pintar de vermelho
                fazia a fila parecer cheia de defeito, e escrever o motivo da parada
                no campo de erro apagava a ultima falha real da cadeia. */}
            {i.aviso && <p className="mt-1 break-words text-[11px] text-amber-800">{i.aviso}</p>}
            {i.erro && <p className="mt-1 break-words text-[11px] text-red-700">{i.erro}</p>}

            {i.estado === "aguardando_aprovacao" && podeAprovar && (
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => agir(i.id, "aprovar")}
                  disabled={ocupado === i.id}
                  className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" /> Aprovar
                </button>
                <button
                  onClick={() => agir(i.id, "recusar")}
                  disabled={ocupado === i.id}
                  className="flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" /> Recusar
                </button>
              </div>
            )}
            {i.estado === "aguardando_aprovacao" && !podeAprovar && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                voce nao tem permissao pra decidir este passo (quem tem: papel com &quot;aprovar
                automacao&quot;).
              </p>
            )}
            {ESTADOS_VIVOS_TELA.includes(i.estado) && podeCancelar && (
              <button
                onClick={() => agir(i.id, "cancelar")}
                disabled={ocupado === i.id}
                className="mt-2 text-[11px] text-muted-foreground underline disabled:opacity-50"
                title={
                  i.estado === "executando"
                    ? "a cadeia para no proximo passo (o passo que esta rodando agora termina)"
                    : undefined
                }
              >
                cancelar esta execucao
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
