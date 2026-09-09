"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Paperclip, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { CabecalhoTela } from "./ui/tela";
import { POR_PAGINA_MAX, POR_PAGINA_MIN, POR_PAGINA_PADRAO } from "@/lib/anexos";

// BIBLIOTECA DE ANEXOS REUTILIZAVEIS — Frente W, card 86ak85bmw
//
// UM COMPONENTE, DOIS MODOS, de proposito:
//
//   * MODO PAGINA (default) — o acervo: subir, buscar, descrever, etiquetar,
//     apagar. Vive na URL propria `/biblioteca` (app/biblioteca/page.tsx).
//   * MODO SELETOR (`aoEscolher` e/ou `conversa`) — a MESMA lista, compacta,
//     dentro da tela de conversa: procura o material e anexa.
//
// POR QUE UM SO: o criterio de aceite "arquivo da biblioteca pode ser anexado a
// uma conversa" mora na tela de conversa (`app/home.tsx`), que e de OUTRA frente
// nesta onda. Entregar um segundo componente "so pro seletor" seria manter duas
// listas com a mesma busca, a mesma paginacao e os mesmos avisos de migration
// pendente — elas divergem na primeira correcao. Entao a costura que a home
// precisa fazer e de UMA linha:
//
//   <BibliotecaAnexos authedFetch={authedFetch}
//                     conversa={{ canal, chat_id: conversaAberta.chat_id }}
//                     aoFechar={() => setSeletorAberto(false)} />
//
// e o envio sai por `/api/anexos/conversa` (que delega pro /api/send com a
// credencial de quem clicou). NADA aqui envia por conta propria.
//
// A REGRA NAO MORA AQUI. Limites, forma de chave, tipo por mime e a frase de
// impacto do apagar sao funcoes PURAS de `lib/anexos.ts`, provadas sem navegador
// por `node --experimental-strip-types scripts/prova-anexos.ts`. Este arquivo e
// marcacao, estado e chamada de rota.
//
// O QUE A TELA NUNCA FAZ:
//   * nao decide permissao — ela ESCONDE o que a pessoa nao alcanca (o servidor
//     devolve `permissoes` na propria listagem), e a rota negaria de todo jeito;
//   * nao afirma "biblioteca vazia" quando a 0024 nao rodou: `disponivel:false`
//     vira aviso com a frase do servidor;
//   * nao apaga em silencio — apagar passa pelo 409 que LISTA os fluxos afetados,
//     e a segunda confirmacao e um clique separado, com a lista na tela.
//
// A TELA NAO PASSOU POR AJUSTE VISUAL DO ERIC — so componentes e classes que o
// painel ja usa.

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type AnexoTela = {
  id: string;
  chave: string;
  nome: string;
  descricao: string;
  etiquetas: string[];
  arquivo_nome: string;
  mime: string;
  bytes: number | null;
  url: string;
  tipo_envio: string;
  ultimo_uso_em: string | null;
  criado_por: string | null;
  criada_em: string;
  atualizada_em: string;
  atualizado_por: string | null;
  origem: { ferramenta: string; id_original: string | null } | null;
  usado_em_fluxos?: number;
};

type Permissoes = { enviar: boolean; apagar: boolean; descrever: boolean; etiquetar: boolean };

type FluxoAfetadoTela = { slug: string; nome: string; ativo: boolean; passos: { no_id: string }[] };

const CAIXA = "rounded-lg border bg-white px-3 py-2 text-xs outline-none";
const BOTAO = "rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50";
const BOTAO_FRACO = "rounded-lg border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50";

const ROTULO_TIPO: Record<string, string> = {
  image: "imagem",
  audio: "audio",
  video: "video",
  document: "documento",
};

function tamanho(bytes: number | null): string {
  if (!bytes || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function quando(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function Aviso({ texto, tom = "amber" }: { texto: string; tom?: "amber" | "red" | "sky" | "green" }) {
  if (!texto) return null;
  const cor =
    tom === "red"
      ? "border-red-200 bg-red-50 text-red-800"
      : tom === "sky"
        ? "border-sky-200 bg-sky-50 text-sky-800"
        : tom === "green"
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-amber-200 bg-amber-50 text-amber-900";
  return <p className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${cor}`}>{texto}</p>;
}

/** Etiqueta clicavel do filtro. */
function Pilula({
  texto,
  ativa,
  aoClicar,
}: {
  texto: string;
  ativa?: boolean;
  aoClicar?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={aoClicar}
      className={`rounded-full border px-2 py-0.5 text-[11px] ${
        ativa ? "border-primary bg-primary/10 font-medium text-primary" : "hover:bg-muted"
      }`}
    >
      {texto}
    </button>
  );
}

export default function BibliotecaAnexos({
  authedFetch,
  aoSair,
  aoFechar,
  aoEscolher,
  conversa,
}: {
  authedFetch: Fetch;
  /** volta pro painel (modo pagina) */
  aoSair?: () => void;
  /** fecha o seletor (modo seletor) */
  aoFechar?: () => void;
  /** MODO SELETOR: a tela devolve o item escolhido em vez de enviar */
  aoEscolher?: (anexo: AnexoTela) => void;
  /** MODO SELETOR: com a conversa aberta, a tela ANEXA por /api/anexos/conversa */
  conversa?: { canal: string; chat_id: string };
}) {
  const seletor = !!(aoEscolher || conversa);

  const [lista, setLista] = useState<AnexoTela[]>([]);
  const [etiquetas, setEtiquetas] = useState<string[]>([]);
  const [permissoes, setPermissoes] = useState<Permissoes>({
    enviar: false,
    apagar: false,
    descrever: false,
    etiquetar: false,
  });
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState<number>(POR_PAGINA_PADRAO);
  const [porPaginaServidor, setPorPaginaServidor] = useState<number | null>(null);
  const [busca, setBusca] = useState("");
  const [etiqueta, setEtiqueta] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");
  const [disponivel, setDisponivel] = useState(true);
  const [truncado, setTruncado] = useState(false);
  const [padraoSalvo, setPadraoSalvo] = useState<"nao" | "salvando" | "ok" | "sem_permissao">("nao");

  // o item aberto (detalhe/edicao) e o estado do apagar em dois passos
  const [aberto, setAberto] = useState<AnexoTela | null>(null);
  const [rascunho, setRascunho] = useState<{ descricao: string; etiquetas: string }>({ descricao: "", etiquetas: "" });
  const [salvando, setSalvando] = useState(false);
  const [impacto, setImpacto] = useState<{ id: string; resumo: string; fluxos: FluxoAfetadoTela[] } | null>(null);
  const [apagando, setApagando] = useState(false);

  // upload
  const [subindo, setSubindo] = useState(false);
  const [formAberto, setFormAberto] = useState(false);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [nomeNovo, setNomeNovo] = useState("");
  const [chaveNova, setChaveNova] = useState("");
  const [descricaoNova, setDescricaoNova] = useState("");
  const [etiquetasNovas, setEtiquetasNovas] = useState("");
  const inputArquivo = useRef<HTMLInputElement | null>(null);

  // envio pra conversa (modo seletor)
  const [legenda, setLegenda] = useState("");
  const [enviando, setEnviando] = useState("");
  const [enviado, setEnviado] = useState("");

  const carregar = useCallback(
    async (opcoes?: { pagina?: number }) => {
      setCarregando(true);
      setErro("");
      try {
        const p = new URLSearchParams();
        if (busca.trim()) p.set("busca", busca.trim());
        if (etiqueta) p.set("etiqueta", etiqueta);
        p.set("pagina", String(opcoes?.pagina ?? pagina));
        p.set("por_pagina", String(porPagina));
        // a coluna "usado em N fluxos" custa uma leitura da tabela de fluxos: no
        // seletor ela nao serve pra nada (quem anexa nao decide sobre fluxo)
        if (!seletor) p.set("com_uso", "1");
        const r = await authedFetch(`/api/anexos?${p.toString()}`);
        const j = await r.json().catch(() => ({}) as any);
        if (!r.ok) {
          setErro(j?.error || "nao consegui carregar a biblioteca");
          return;
        }
        setLista(Array.isArray(j.anexos) ? j.anexos : []);
        setEtiquetas(Array.isArray(j.etiquetas) ? j.etiquetas : []);
        if (j.permissoes) setPermissoes(j.permissoes);
        setTotal(Number(j.total) || 0);
        setDisponivel(j.disponivel !== false);
        setAviso(j.aviso || "");
        setTruncado(!!j.truncado);
        if (typeof j.por_pagina === "number") {
          setPorPaginaServidor((atual) => (atual === null ? j.por_pagina : atual));
        }
      } catch (e: any) {
        setErro(e?.message === "sem sessao" ? "a sessao expirou — entre no painel de novo" : "falha de rede");
      } finally {
        setCarregando(false);
      }
    },
    [authedFetch, busca, etiqueta, pagina, porPagina, seletor]
  );

  // busca com respiro: digitar 12 letras nao dispara 12 leituras do acervo
  useEffect(() => {
    const t = setTimeout(() => {
      setPagina(1);
      carregar({ pagina: 1 });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busca, etiqueta, porPagina]);

  useEffect(() => {
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagina]);

  const paginas = useMemo(() => Math.max(1, Math.ceil(total / Math.max(1, porPagina))), [total, porPagina]);

  function abrir(a: AnexoTela) {
    setAberto(a);
    setRascunho({ descricao: a.descricao || "", etiquetas: (a.etiquetas || []).join(", ") });
    setImpacto(null);
    setLegenda("");
    setEnviado("");
  }

  async function subir() {
    if (!arquivo) return;
    setSubindo(true);
    setErro("");
    try {
      const fd = new FormData();
      fd.set("arquivo", arquivo);
      if (nomeNovo.trim()) fd.set("nome", nomeNovo.trim());
      if (chaveNova.trim()) fd.set("chave", chaveNova.trim());
      if (descricaoNova.trim()) fd.set("descricao", descricaoNova.trim());
      if (etiquetasNovas.trim()) fd.set("etiquetas", etiquetasNovas.trim());
      const r = await authedFetch("/api/anexos", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}) as any);
      if (!r.ok) {
        setErro(j?.error || "nao consegui subir o arquivo");
        return;
      }
      setFormAberto(false);
      setArquivo(null);
      setNomeNovo("");
      setChaveNova("");
      setDescricaoNova("");
      setEtiquetasNovas("");
      if (inputArquivo.current) inputArquivo.current.value = "";
      setPagina(1);
      await carregar({ pagina: 1 });
    } finally {
      setSubindo(false);
    }
  }

  async function salvarCampos() {
    if (!aberto) return;
    setSalvando(true);
    setErro("");
    try {
      // SO O QUE MUDOU vai no corpo: mandar `etiquetas` sem ter mexido nelas
      // faria a rota RECUSAR o pedido inteiro pra quem so pode descrever (e a
      // recusa inteira e deliberada — ver decidirPatch em lib/anexos.ts).
      const corpo: Record<string, unknown> = { id: aberto.id };
      if (rascunho.descricao !== (aberto.descricao || "")) corpo.descricao = rascunho.descricao;
      const etiquetasRascunho = rascunho.etiquetas
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (etiquetasRascunho.join("|") !== (aberto.etiquetas || []).join("|")) corpo.etiquetas = etiquetasRascunho;
      if (Object.keys(corpo).length === 1) return;
      const r = await authedFetch("/api/anexos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
      });
      const j = await r.json().catch(() => ({}) as any);
      if (!r.ok) {
        setErro(j?.error || "nao consegui salvar");
        return;
      }
      setAberto(j.anexo);
      setLista((atual) => atual.map((x) => (x.id === j.anexo.id ? j.anexo : x)));
      await carregar();
    } finally {
      setSalvando(false);
    }
  }

  /**
   * APAGAR EM DOIS CLIQUES, e o segundo so existe depois de a tela MOSTRAR quais
   * fluxos usam o arquivo. O primeiro clique manda `confirmar=1` e recebe:
   *   204/200 -> nenhum fluxo usa, apagou;
   *   409     -> ha fluxos, com a lista em `usado_por` (nada foi apagado);
   *   503     -> a varredura nao deu pra fazer, e "nao sei" nao apaga.
   */
  async function apagar(a: AnexoTela, ciente: boolean) {
    setApagando(true);
    setErro("");
    try {
      const p = new URLSearchParams({ id: a.id, confirmar: "1" });
      if (ciente) p.set("ciente_fluxos", "1");
      const r = await authedFetch(`/api/anexos?${p.toString()}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}) as any);
      if (r.status === 409) {
        setImpacto({
          id: a.id,
          resumo: j?.detalhe || j?.error || "este arquivo e usado por fluxo de automacao",
          fluxos: Array.isArray(j?.usado_por) ? j.usado_por : [],
        });
        return;
      }
      if (!r.ok) {
        setErro(j?.error || "nao consegui apagar");
        return;
      }
      setImpacto(null);
      setAberto(null);
      if (j?.aviso) setAviso(j.aviso);
      await carregar();
    } finally {
      setApagando(false);
    }
  }

  async function anexarNaConversa(a: AnexoTela) {
    if (aoEscolher) {
      aoEscolher(a);
      return;
    }
    if (!conversa) return;
    setEnviando(a.id);
    setErro("");
    setEnviado("");
    try {
      const r = await authedFetch("/api/anexos/conversa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canal: conversa.canal,
          chat_id: conversa.chat_id,
          chave: a.chave,
          ...(legenda.trim() ? { legenda: legenda.trim() } : {}),
        }),
      });
      const j = await r.json().catch(() => ({}) as any);
      if (!r.ok) {
        // o motivo de /api/send viaja inteiro (janela de 24h, canal so leitura...)
        setErro(j?.error || "o envio recusou o anexo");
        return;
      }
      setEnviado(a.nome);
      setLegenda("");
    } finally {
      setEnviando("");
    }
  }

  /** Guarda o tamanho de pagina como PADRAO da instalacao (exige `automacao`). */
  async function salvarPadraoDePagina() {
    setPadraoSalvo("salvando");
    const r = await authedFetch("/api/admin/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chave: "anexos_por_pagina", valor: porPagina }),
    });
    if (r.status === 403) {
      setPadraoSalvo("sem_permissao");
      return;
    }
    setPadraoSalvo(r.ok ? "ok" : "nao");
    if (r.ok) setPorPaginaServidor(porPagina);
  }

  // ————————————————————————————————————————————————————————— marcacao
  const DESCRICAO =
    "Material que o time reusa: tabela de precos, catalogo, contrato. O mesmo arquivo serve a conversa e ao passo de automacao.";
  const ferramentas = (
    <>
      {/* a busca encolhe com a tela (min 10rem) em vez de fixar 18rem: em 420px o w-72
          vazava pela direita do cabecalho (varredura de 03/09) */}
      <div className="relative min-w-[10rem] flex-1 sm:flex-none">
        <Search className="pointer-events-none absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por nome, chave, descricao ou etiqueta"
          className={`${CAIXA} w-full pl-7 sm:w-72`}
        />
      </div>
      <button type="button" onClick={() => carregar()} className={BOTAO_FRACO} title="atualizar">
        {carregando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      </button>
      {permissoes.enviar && !seletor && (
        <button type="button" onClick={() => setFormAberto((v) => !v)} className={BOTAO}>
          <span className="inline-flex items-center gap-1">
            <Upload className="h-3.5 w-3.5" /> subir arquivo
          </span>
        </button>
      )}
      {seletor && aoFechar && (
        <button type="button" onClick={aoFechar} className={BOTAO_FRACO} title="fechar">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </>
  );
  // Tela propria = cabecalho unico da casa (app/ui/tela.tsx). No modo SELETOR (dentro
  // da conversa ou do editor de fluxo) ela e um painel, nao uma tela: cabecalho leve.
  const cabecalho = seletor ? (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex-1">
        <h1 className="text-sm font-semibold">Biblioteca de anexos</h1>
        <p className="text-[11px] text-muted-foreground">{DESCRICAO}</p>
      </div>
      {ferramentas}
    </div>
  ) : (
    <CabecalhoTela titulo="Biblioteca de anexos" descricao={DESCRICAO} icone={Paperclip} aoVoltar={aoSair} voltarRotulo="Painel">
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">{ferramentas}</div>
    </CabecalhoTela>
  );

  const filtros = (
    <div className="flex flex-wrap items-center gap-1.5">
      {etiquetas.length > 0 && <span className="text-[11px] text-muted-foreground">etiquetas:</span>}
      {etiqueta && <Pilula texto="limpar" aoClicar={() => setEtiqueta("")} />}
      {etiquetas.slice(0, 24).map((e) => (
        <Pilula key={e} texto={e} ativa={etiqueta === e} aoClicar={() => setEtiqueta(etiqueta === e ? "" : e)} />
      ))}
    </div>
  );

  const formulario = formAberto && permissoes.enviar && (
    <section className="space-y-2 rounded-xl border bg-white p-3">
      <h2 className="text-xs font-semibold">Subir arquivo</h2>
      <input
        ref={inputArquivo}
        type="file"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          setArquivo(f);
          if (f && !nomeNovo) setNomeNovo(f.name.replace(/\.[^.]+$/, ""));
        }}
        className={`${CAIXA} w-full`}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <input value={nomeNovo} onChange={(e) => setNomeNovo(e.target.value)} placeholder="Nome (o que o time procura)" className={CAIXA} />
        <input
          value={chaveNova}
          onChange={(e) => setChaveNova(e.target.value)}
          placeholder="Chave (opcional; sai do nome)"
          className={CAIXA}
        />
      </div>
      <input
        value={descricaoNova}
        onChange={(e) => setDescricaoNova(e.target.value)}
        placeholder="Descricao — quando usar este material"
        className={`${CAIXA} w-full`}
      />
      <input
        value={etiquetasNovas}
        onChange={(e) => setEtiquetasNovas(e.target.value)}
        placeholder="Etiquetas separadas por virgula"
        className={`${CAIXA} w-full`}
      />
      <p className="text-[11px] text-muted-foreground">
        A CHAVE e a identidade do arquivo: e ela que o passo de automacao guarda, e ela nao muda quando o arquivo e
        atualizado. Imagem, audio, video e documento; sem SVG e sem pagina web (o armazenamento e publico).
      </p>
      <div className="flex items-center gap-2">
        <button type="button" onClick={subir} disabled={!arquivo || subindo} className={BOTAO}>
          {subindo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "subir"}
        </button>
        <button type="button" onClick={() => setFormAberto(false)} className={BOTAO_FRACO}>
          cancelar
        </button>
      </div>
    </section>
  );

  const tabela = (
    <div className="overflow-x-auto rounded-xl border bg-white">
      <table className="w-full min-w-[720px] text-left text-xs">
        <thead className="border-b bg-muted/40 text-[11px] uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2">arquivo</th>
            <th className="px-3 py-2">chave</th>
            <th className="px-3 py-2">tipo</th>
            <th className="px-3 py-2">tamanho</th>
            {!seletor && <th className="px-3 py-2">fluxos</th>}
            <th className="px-3 py-2">ultimo uso</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {lista.map((a) => (
            <tr key={a.id} className="border-b last:border-0 hover:bg-muted/30">
              <td className="px-3 py-2">
                <button type="button" onClick={() => abrir(a)} className="text-left">
                  <span className="font-medium">{a.nome}</span>
                  <span className="block text-[11px] text-muted-foreground">{a.arquivo_nome}</span>
                </button>
                {a.etiquetas?.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {a.etiquetas.slice(0, 6).map((e) => (
                      <span key={e} className="rounded-full border px-1.5 text-[11px] text-muted-foreground">
                        {e}
                      </span>
                    ))}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-[11px]">{a.chave}</td>
              <td className="px-3 py-2">{ROTULO_TIPO[a.tipo_envio] || a.tipo_envio}</td>
              <td className="px-3 py-2">{tamanho(a.bytes)}</td>
              {!seletor && (
                <td className="px-3 py-2">
                  {/* undefined e "nao sei" (automacao nunca ligada), 0 e "nenhum".
                      A tela nao pode transformar um no outro. */}
                  {a.usado_em_fluxos === undefined ? "—" : a.usado_em_fluxos}
                </td>
              )}
              <td className="px-3 py-2 text-[11px] text-muted-foreground">{quando(a.ultimo_uso_em)}</td>
              <td className="px-3 py-2 text-right">
                {seletor ? (
                  <button
                    type="button"
                    onClick={() => anexarNaConversa(a)}
                    disabled={!!enviando}
                    className={BOTAO}
                    title={aoEscolher ? "escolher" : "anexar nesta conversa"}
                  >
                    {enviando === a.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Paperclip className="h-3.5 w-3.5" /> anexar
                      </span>
                    )}
                  </button>
                ) : (
                  <button type="button" onClick={() => abrir(a)} className={BOTAO_FRACO}>
                    abrir
                  </button>
                )}
              </td>
            </tr>
          ))}
          {!lista.length && (
            <tr>
              <td colSpan={seletor ? 6 : 7} className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                {!disponivel
                  ? "a biblioteca ainda nao esta disponivel nesta instalacao"
                  : busca || etiqueta
                    ? "nenhum arquivo com esse termo"
                    : "nenhum arquivo na biblioteca ainda"}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  const rodape = (
    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
      <span>
        {total} arquivo(s){busca || etiqueta ? " no filtro" : ""} · pagina {pagina} de {paginas}
      </span>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1">
          por pagina
          <select
            value={porPagina}
            onChange={(e) => {
              setPorPagina(Number(e.target.value));
              setPadraoSalvo("nao");
            }}
            className={CAIXA}
          >
            {[POR_PAGINA_MIN, 10, 25, 50, 100, 200, POR_PAGINA_MAX]
              .filter((n, i, arr) => arr.indexOf(n) === i && n >= POR_PAGINA_MIN && n <= POR_PAGINA_MAX)
              .map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
          </select>
        </label>
        {!seletor && porPaginaServidor !== null && porPagina !== porPaginaServidor && (
          <button type="button" onClick={salvarPadraoDePagina} className={BOTAO_FRACO}>
            {padraoSalvo === "salvando" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : padraoSalvo === "ok" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              "salvar como padrao"
            )}
          </button>
        )}
        <button type="button" disabled={pagina <= 1} onClick={() => setPagina((p) => Math.max(1, p - 1))} className={BOTAO_FRACO}>
          anterior
        </button>
        <button
          type="button"
          disabled={pagina >= paginas}
          onClick={() => setPagina((p) => Math.min(paginas, p + 1))}
          className={BOTAO_FRACO}
        >
          proxima
        </button>
      </div>
    </div>
  );

  const detalhe =
    aberto && !seletor ? (
      <section className="space-y-2 rounded-xl border bg-white p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-xs font-semibold">{aberto.nome}</h2>
            <p className="text-[11px] text-muted-foreground">
              <span className="font-mono">{aberto.chave}</span> · {aberto.arquivo_nome} ·{" "}
              {ROTULO_TIPO[aberto.tipo_envio] || aberto.tipo_envio} · {tamanho(aberto.bytes)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              subiu {quando(aberto.criada_em)}
              {aberto.criado_por ? ` por ${aberto.criado_por}` : ""}
              {aberto.origem ? ` · importado de ${aberto.origem.ferramenta}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a href={aberto.url} target="_blank" rel="noreferrer" className={BOTAO_FRACO}>
              abrir arquivo
            </a>
            <button type="button" onClick={() => setAberto(null)} className={BOTAO_FRACO}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <label className="block text-[11px] font-medium">
          Descricao
          <textarea
            value={rascunho.descricao}
            onChange={(e) => setRascunho((r) => ({ ...r, descricao: e.target.value }))}
            disabled={!permissoes.descrever}
            rows={2}
            className={`${CAIXA} mt-1 w-full disabled:bg-muted/40`}
            placeholder={permissoes.descrever ? "Quando usar este material" : "voce nao tem a permissao de descrever"}
          />
        </label>
        <label className="block text-[11px] font-medium">
          Etiquetas (separadas por virgula)
          <input
            value={rascunho.etiquetas}
            onChange={(e) => setRascunho((r) => ({ ...r, etiquetas: e.target.value }))}
            disabled={!permissoes.etiquetar}
            className={`${CAIXA} mt-1 w-full disabled:bg-muted/40`}
            placeholder={permissoes.etiquetar ? "precos, catalogo" : "voce nao tem a permissao de etiquetar"}
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          {(permissoes.descrever || permissoes.etiquetar) && (
            <button type="button" onClick={salvarCampos} disabled={salvando} className={BOTAO}>
              {salvando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "salvar"}
            </button>
          )}
          {permissoes.apagar && (
            <button type="button" onClick={() => apagar(aberto, false)} disabled={apagando} className={BOTAO_FRACO}>
              <span className="inline-flex items-center gap-1 text-red-700">
                <Trash2 className="h-3.5 w-3.5" /> apagar
              </span>
            </button>
          )}
          {aberto.usado_em_fluxos !== undefined && (
            <span className="text-[11px] text-muted-foreground">
              {aberto.usado_em_fluxos} passo(s) de automacao referenciam esta chave
            </span>
          )}
        </div>

        {impacto?.id === aberto.id && (
          <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-[11px] font-semibold text-red-900">{impacto.resumo}</p>
            {impacto.fluxos.length > 0 && (
              <ul className="space-y-0.5 text-[11px] text-red-900">
                {impacto.fluxos.map((f) => (
                  <li key={f.slug}>
                    • {f.nome} <span className="font-mono">({f.slug})</span> — {f.passos?.length ?? 0} passo(s)
                    {f.ativo ? " · LIGADO" : " · desligado"}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-red-900">
              Apagar deixa esses passos sem arquivo: o fluxo passa a FALHAR naquele passo, com o motivo na trilha.
              Troque a referencia nos fluxos antes, ou confirme ciente.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => apagar(aberto, true)}
                disabled={apagando}
                className="rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {apagando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "apagar mesmo assim"}
              </button>
              <button type="button" onClick={() => setImpacto(null)} className={BOTAO_FRACO}>
                cancelar
              </button>
            </div>
          </div>
        )}
      </section>
    ) : null;

  const corpo = (
    <div className="space-y-3">
      {seletor && cabecalho}
      {!disponivel && <Aviso texto={aviso || "a biblioteca depende da migration 0024, que ainda nao rodou"} />}
      {disponivel && aviso && <Aviso texto={aviso} />}
      {truncado && (
        <Aviso texto="o acervo passou do teto que esta tela le de uma vez — use a busca pra chegar no arquivo certo." />
      )}
      {erro && <Aviso texto={erro} tom="red" />}
      {enviado && <Aviso texto={`"${enviado}" foi enviado nesta conversa.`} tom="green" />}
      {formulario}
      {filtros}
      {seletor && conversa && (
        <input
          value={legenda}
          onChange={(e) => setLegenda(e.target.value)}
          placeholder="Legenda (opcional) — vai junto com o arquivo"
          className={`${CAIXA} w-full`}
        />
      )}
      {tabela}
      {rodape}
      {detalhe}
    </div>
  );

  if (seletor) return <div className="space-y-3">{corpo}</div>;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {cabecalho}
      <div className="mx-auto w-full max-w-5xl p-4">{corpo}</div>
    </div>
  );
}
