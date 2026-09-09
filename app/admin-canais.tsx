"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Loader2,
  Phone,
  QrCode,
  RefreshCw,
  Smartphone,
  Trash2,
  Unplug,
} from "lucide-react";
import { CabecalhoTela, EstadoVazio } from "./ui/tela";
import {
  linhasDoCatalogo,
  type StatusTemplate,
  type TemplateCanal,
} from "@/lib/templates-oficial";
import {
  descreverEvento,
  deveRenovarQr,
  formatarNumero,
  normalizarNumero,
  qrExpirado,
  rotuloIdadeQr,
  validarTroca,
  type EstadoConexao,
  type EventoCanal,
  type TrocaPendente,
} from "@/lib/canal-conexao";

// TELA DE NUMEROS (canais) — Frente U, 31/08/2026
//   card 86ak858mx  conectar por QR Code e por codigo de 8 digitos
//   card 86ak858nx  trocar o numero preservando o historico
//   card 86ak858pa  templates de mensagem por numero (API Oficial)
//
// ONDE ELA VIVE, e por que aqui: uma VISAO propria, no padrao que a Frente Q
// deixou escrito em `app/admin-acesso.tsx` ("relatorio nao e configuracao", e
// grade grande nao entra em modal de 672px). Esta tela tem QR em tela, estado de
// conexao com polling, trilha do canal e catalogo de template — nada disso cabe
// numa setima aba do modal de Configuracoes.
//
// COMO ELA E ALCANCADA HOJE: pela pagina propria `/canais` (`app/canais/page.tsx`),
// que faz o bootstrap de sessao e monta este componente. A entrada DENTRO do
// painel (um item no menu, do lado de "Acesso e seguranca") e COSTURA DECLARADA
// pro coordenador: `app/home.tsx` pertence a outra frente nesta onda, e o contrato
// e o mesmo do irmao — `visaoPainel: "canais"` renderizando <AdminCanais
// authedFetch={authedFetch} aoSair={...} />. Enquanto isso nao acontece, a tela
// nao fica orfa: ela ja abre e funciona na URL propria.
//
// A REGRA NAO MORA AQUI. Idade do QR, comparacao de numero, validacao da troca e
// tudo de template sao funcoes PURAS em `lib/canal-conexao.ts` e
// `lib/templates-oficial.ts`, provadas sem navegador por
// `node scripts/prova-canais-conexao.ts`. Este arquivo e marcacao, estado e
// polling.
//
// O QUE A TELA NUNCA FAZ, de proposito:
//   * nao guarda nem exibe credencial — o servidor devolve so a MARCA da
//     instancia (4 primeiros e 4 ultimos digitos);
//   * nao carimba a hora do QR: o carimbo vem do SERVIDOR (`qr_em`), porque
//     relogio errado de navegador e uma das causas do chamado "escaneei e nao
//     funcionou";
//   * nao decide permissao: aba/botao que a pessoa nao alcanca some, mas a rota
//     negaria de todo jeito.
//
// A TELA NAO PASSOU POR AJUSTE VISUAL DO ERIC — so componentes e classes que o
// painel ja usa.

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

type CanalTela = {
  id: string;
  rotulo: string;
  subtitulo: string;
  identidade: string;
  fonte: string;
  dono: string;
  ativo: boolean;
  envio_cabeado: boolean;
  conexao_aqui: boolean;
  conexao_motivo: string;
  tem_templates: boolean;
};

const CAIXA = "rounded-lg border bg-white px-3 py-2 text-xs outline-none";
const BOTAO = "rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50";
const BOTAO_FRACO = "rounded-lg border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50";

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

function Bloco({ titulo, children, acao }: { titulo: string; children: React.ReactNode; acao?: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold">{titulo}</h2>
        {acao}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/** A bolinha de estado. Cor vem da SITUACAO, nunca de "conectado" sozinho: ficar
 *  verde com o celular fora do ar esconderia o unico problema que o cliente
 *  consegue resolver sozinho. */
function Farol({ estado }: { estado: EstadoConexao | null }) {
  const cor =
    !estado || estado.situacao === "desconhecido"
      ? "bg-slate-300"
      : estado.situacao === "conectado"
        ? "bg-emerald-500"
        : estado.situacao === "sem_celular"
          ? "bg-amber-500"
          : "bg-red-500";
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${cor}`} />;
}

// A ROUPA de cada paragrafo da linha do template. Quem decide QUAIS paragrafos
// existem e `linhasDoCatalogo` (lib/templates-oficial.ts); aqui so mora a cor.
const TOM_DO_BLOCO: Record<"corpo" | "motivo" | "recusa", string> = {
  corpo: "whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground",
  motivo: "text-[11px] text-red-700",
  recusa: "rounded border border-red-200 bg-red-50 px-1.5 py-1 text-[11px] leading-relaxed text-red-800",
};

const CORES_STATUS: Record<StatusTemplate, string> = {
  aprovado: "bg-emerald-50 text-emerald-700 border-emerald-200",
  em_analise: "bg-amber-50 text-amber-800 border-amber-200",
  recusado: "bg-red-50 text-red-700 border-red-200",
  pausado: "bg-orange-50 text-orange-700 border-orange-200",
  desconhecido: "bg-slate-50 text-slate-600 border-slate-200",
};

export default function AdminCanais({ authedFetch, aoSair }: { authedFetch: Fetch; aoSair: () => void }) {
  const [canais, setCanais] = useState<CanalTela[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erroGeral, setErroGeral] = useState("");
  const [sel, setSel] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await authedFetch("/api/canais?todos=1");
        if (r.status === 403) {
          setErroGeral("Voce nao tem permissao pra administrar os numeros desta instalacao.");
          return;
        }
        const j = await r.json().catch(() => ({}));
        const lista: CanalTela[] = j?.canais ?? [];
        setCanais(lista);
        setSel((s) => s || lista[0]?.id || "");
      } catch {
        setErroGeral("Nao consegui carregar os numeros agora.");
      } finally {
        setCarregando(false);
      }
    })();
  }, [authedFetch]);

  const canal = canais.find((c) => c.id === sel) || null;

  return (
    <div className="flex h-screen flex-col bg-background">
      <CabecalhoTela
        titulo="Numeros"
        descricao="Conexao de cada numero, troca de chip e templates da API oficial"
        icone={Phone}
        aoVoltar={aoSair}
      />

      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {carregando && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> carregando os numeros...
            </p>
          )}
          <Aviso texto={erroGeral} tom="red" />

          {!carregando && !erroGeral && canais.length === 0 && (
            <EstadoVazio
              icone={Phone}
              titulo="Nenhum numero registrado nesta instalacao"
              texto="Numero novo entra pela configuracao da instalacao (env CANAIS_EXTRA) e aparece aqui pra conectar."
            />
          )}

          {canais.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {canais.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSel(c.id)}
                  className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                    sel === c.id ? "border-primary bg-primary/5 text-primary" : "hover:bg-muted"
                  }`}>
                  {c.rotulo}
                  {!c.ativo && <span className="ml-1 text-[11px] text-muted-foreground">(desligado)</span>}
                </button>
              ))}
            </div>
          )}

          {canal && <PainelDoCanal key={canal.id} canal={canal} authedFetch={authedFetch} />}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════ o painel de UM numero
function PainelDoCanal({ canal, authedFetch }: { canal: CanalTela; authedFetch: Fetch }) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border bg-white p-3">
        <p className="text-sm font-semibold">{canal.rotulo}</p>
        <p className="text-[11px] text-muted-foreground">
          {canal.subtitulo || "—"} · provedor {canal.fonte} · {canal.dono === "pessoal" ? "pessoal" : "da empresa"}
        </p>
        {!canal.envio_cabeado && (
          <div className="mt-2">
            <Aviso texto="Este numero nao tem credencial de envio configurada nesta instalacao: ele aparece na lista, mas nao envia mensagem." />
          </div>
        )}
      </div>

      {canal.conexao_aqui ? (
        <Conexao canal={canal} authedFetch={authedFetch} />
      ) : (
        <Bloco titulo="Conexao">
          <Aviso tom="sky" texto={canal.conexao_motivo} />
        </Bloco>
      )}

      {canal.tem_templates && <Templates canal={canal} authedFetch={authedFetch} />}
    </div>
  );
}

// ════════════════════════════════════ conexao + troca de numero
type CorpoConexao = {
  estado: EstadoConexao;
  instancia: string;
  instancia_anterior: string | null;
  numero_gravado: string | null;
  troca_pendente: TrocaPendente | null;
  troca: { acao: string; aviso: string | null } | null;
  disponivel: boolean;
  aviso: string;
  qr?: string | null;
  qr_em?: string | null;
  erro_qr?: string;
  codigo?: string | null;
  codigo_em?: string | null;
  erro_codigo?: string;
  erro_acao?: string;
  concluida?: boolean;
  aviso_troca?: string;
  aviso_numero?: string;
  // chip DIFERENTE conectado SEM ninguem ter aberto troca — a tela poe isso em
  // destaque, porque o painel passou a atender por outro numero
  numero_trocado_sem_troca?: { de: string | null; para: string };
};

function Conexao({ canal, authedFetch }: { canal: CanalTela; authedFetch: Fetch }) {
  const [c, setC] = useState<CorpoConexao | null>(null);
  const [qr, setQr] = useState<{ img: string; em: string } | null>(null);
  const [codigo, setCodigo] = useState<{ valor: string; em: string } | null>(null);
  const [telefone, setTelefone] = useState("");
  const [modo, setModo] = useState<"" | "qr" | "codigo">("");
  const [msg, setMsg] = useState("");
  const [erro, setErro] = useState("");
  const [ocupado, setOcupado] = useState(false);
  // AVISO EM DESTAQUE, e ele nao desaparece com o proximo polling: chip trocado
  // fora do fluxo de troca e a coisa mais importante que esta tela tem pra dizer,
  // e ate a revisao ela nao dizia nada (o numero mudava sozinho no rodape).
  const [trocaSelvagem, setTrocaSelvagem] = useState<{ de: string | null; para: string } | null>(null);
  // D5: engolir 429 sem contar congelaria a tela pra sempre num 429 que NAO e o
  // nosso piso (proxy, WAF, gateway). A partir do 3o seguido a tela diz que parou
  // de atualizar — em ambar, porque nao ha nada pra a pessoa decidir.
  const [semAtualizar, setSemAtualizar] = useState(0);
  // aviso LEVE (ambar): fato que a pessoa precisa saber e que nao e erro nem
  // sucesso. Nasceu do 429 no clique de "conferir agora" — ver `agir`.
  const [avisoLeve, setAvisoLeve] = useState("");
  // relogio proprio SO pra a frase "gerado ha Ns" mudar sozinha; o carimbo em si
  // e do servidor (`qr_em`), nunca deste tique
  const [tique, setTique] = useState(0);
  const modoRef = useRef(modo);
  modoRef.current = modo;

  const post = useCallback(
    async (acao: string, extra: Record<string, unknown> = {}) => {
      const r = await authedFetch("/api/canais/conexao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canal: canal.id, acao, ...extra }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // o status viaja no erro porque nem toda recusa e digna de tela vermelha:
        // o 429 do piso de chamadas (INTERVALO_ACAO) e uma rajada nossa, nao um
        // problema do numero — ver o polling de ESTADO abaixo
        const e = new Error(j?.error || `erro ${r.status}`) as Error & {
          status?: number;
          retry_em?: number;
        };
        e.status = r.status;
        // o 429 do piso diz em quantos segundos vale tentar de novo — a tela repete
        // esse numero pra a pessoa em vez de dizer "espere um pouco"
        if (typeof j?.retry_em === "number") e.retry_em = j.retry_em;
        throw e;
      }
      return j as CorpoConexao;
    },
    [authedFetch, canal.id]
  );

  // ——— polling do ESTADO: e ele que conclui a troca de chip no servidor, e e
  // ele que fecha o modal sozinho quando conecta (o card e explicito: "o usuario
  // nao clica em confirmar"). Roda mais rapido com o modal aberto.
  useEffect(() => {
    let vivo = true;
    let timer: any;
    const rodar = async () => {
      try {
        const j = await post("estado");
        if (!vivo) return;
        setC(j);
        setErro("");
        setSemAtualizar(0);
        if (j.numero_trocado_sem_troca) setTrocaSelvagem(j.numero_trocado_sem_troca);
        if (j.concluida) {
          setMsg("Troca concluida: o numero novo esta conectado e o historico continua no mesmo canal.");
          setModo("");
          setQr(null);
          setCodigo(null);
        } else if (j.estado.conectado && modoRef.current) {
          // conectou com o modal aberto: fecha sozinho
          setModo("");
          setQr(null);
          setCodigo(null);
          if (!j.troca_pendente) setMsg("Numero conectado.");
        }
      } catch (e: any) {
        if (!vivo) return;
        // 429 aqui e, quase sempre, duas abas do MESMO canal caindo dentro do piso
        // de 1s: nao e erro pra mostrar, mantem o ultimo estado conhecido e tenta no
        // proximo ciclo (pintar vermelho inventaria um problema no numero do
        // cliente). MAS engolir INCONDICIONALMENTE congela a tela: um 429 que vem de
        // proxy/WAF/gateway nunca passa, e a pessoa ficaria olhando um estado velho
        // achando que e o de agora. Entao conta-se: 3 seguidos e a tela avisa.
        if (e?.status === 429) setSemAtualizar((n) => n + 1);
        else setErro(String(e?.message || e));
      }
      if (vivo) timer = setTimeout(rodar, modoRef.current ? 3500 : 15000);
    };
    rodar();
    return () => {
      vivo = false;
      clearTimeout(timer);
    };
  }, [post]);

  // ——— O QR: acorda a cada 2s, mas SO PEDE quando o atual venceu.
  //
  // O card fala em "polling do QR a cada ~4s". Ao pe da letra isso e ERRADO, e o
  // motivo e mecanico: **pedir um QR novo INVALIDA o anterior** no provedor. Com um
  // pedido a cada 4s e um codigo que vale ~20s, quatro de cada cinco imagens que a
  // pessoa ve morrem antes de ela terminar de apontar a camera — o cliente escaneia
  // um codigo que o NOSSO polling acabou de matar, e o sintoma e exatamente o
  // chamado que este card existe pra resolver.
  //
  // Entao a cadencia e: acordar rapido (pra trocar a imagem no segundo em que ela
  // vence) e pedir SO quando `deveRenovarQr` disser que venceu. Quem roda a cada
  // poucos segundos e o polling de ESTADO, que e barato e nao mexe no pareamento.
  const qrRef = useRef<{ img: string; em: string } | null>(null);
  qrRef.current = qr;

  // D3 — A TRAVA E UM REF, e nao o estado `ocupado`, porque ela tem que valer NO
  // MESMO TICK. A corrida que existia: o botao "gerar um codigo novo" zerava o QR
  // local (certo: o proprio pedido invalida o codigo que esta na tela) e so depois
  // esperava a resposta. Nesse meio, `qrRef` estava null, o poller acordava,
  // `deveRenovarQr(undefined)` dava true e disparava um SEGUNDO pedido com o
  // primeiro em voo — que ou toma 429 do piso (vermelho logo depois do clique) ou,
  // em outra aba, invalida o QR debaixo da camera do cliente. Ou seja: o clique de
  // "quero outro codigo" recriava exatamente o bug que a cadencia veio matar.
  const pedindoQr = useRef(false);

  const pedirQr = useCallback(
    async (manual: boolean) => {
      if (pedindoQr.current) {
        // BOTAO QUE NAO RESPONDE PARECE BOTAO QUEBRADO (achado de revisao). Desistir
        // do pedido novo e certo — o que esta em voo ja vai trazer um codigo — mas
        // descartar o CLIQUE em silencio faz a pessoa clicar de novo, e o defeito
        // percebido passa a ser nosso. So no clique manual: no pedido automatico
        // nao ha ninguem esperando resposta.
        if (manual) setAvisoLeve("Ja estou gerando um codigo novo — ele aparece em instantes.");
        return;
      }
      pedindoQr.current = true;
      // no pedido MANUAL o QR sai da tela antes da resposta: ele acabou de ser
      // invalidado pelo proprio pedido, e deixa-lo na frente convida a escanear
      // codigo morto. No pedido automatico nao se apaga nada — o QR velho fica
      // valendo ate o novo chegar.
      if (manual) {
        setAvisoLeve("");
        setQr(null);
      }
      try {
        const j = await post("qr");
        setC(j);
        if (j.qr && j.qr_em) {
          setQr({ img: j.qr, em: j.qr_em });
          setAvisoLeve("");
        } else if (j.erro_qr) setErro(j.erro_qr);
      } catch (e: any) {
        // O 429 DO PISO DO QR, nos dois lados — o mesmo raciocinio do `estado` (D4),
        // que a revisao anterior aplicou so lá. `INTERVALO_ACAO.qr` e 2,5s e o piso e
        // ALCANCAVEL sem ninguem errar nada: duas abas do mesmo canal com o modal
        // aberto, por azar de fase, caem dentro dele. Pintar vermelho ali inventa
        // problema num numero que esta perfeito. Ambar, com o prazo real, e o codigo
        // novo chega no proximo ciclo (2s) sozinho.
        //
        // E este 429 NAO conta em `semAtualizar` (D5), de proposito: aquele contador
        // fala do polling de ESTADO e a frase dele e "o que esta na tela pode estar
        // velho" — dizer isso por causa do piso do QR seria mentir sobre o estado do
        // numero, que continua sendo lido no ciclo de 3,5s.
        if (e?.status === 429) {
          setAvisoLeve(
            `Pedido de codigo muito seguido neste numero. O proximo sai em ${e?.retry_em ?? "alguns"}s.`
          );
        } else setErro(String(e?.message || e));
      } finally {
        pedindoQr.current = false;
      }
    },
    [post]
  );

  useEffect(() => {
    if (modo !== "qr") return;
    let vivo = true;
    let timer: any;
    const rodar = async () => {
      // a MESMA funcao pura que decide a frase de idade decide o pedido: duas
      // respostas pra "este QR ainda vale?" divergiriam sozinhas. E a trava de
      // `pedirQr` garante que um pedido manual em voo nao ganhe um irmao daqui.
      if (deveRenovarQr(qrRef.current?.em)) await pedirQr(false);
      if (vivo) timer = setTimeout(rodar, 2000);
    };
    rodar();
    return () => {
      vivo = false;
      clearTimeout(timer);
    };
  }, [modo, pedirQr]);

  // tique de 1s pra a idade do QR contar na tela
  useEffect(() => {
    if (!qr) return;
    const t = setInterval(() => setTique((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [qr]);

  const agir = async (acao: string, extra?: Record<string, unknown>) => {
    setOcupado(true);
    setErro("");
    setMsg("");
    setAvisoLeve("");
    try {
      const j = await post(acao, extra);
      setC(j);
      if (j.erro_acao) setErro(j.erro_acao);
      if (acao === "qr") {
        if (j.qr && j.qr_em) setQr({ img: j.qr, em: j.qr_em });
        else if (j.erro_qr) setErro(j.erro_qr);
      }
      if (acao === "codigo") {
        if (j.codigo) setCodigo({ valor: j.codigo, em: j.codigo_em ?? new Date().toISOString() });
        else if (j.erro_codigo) setErro(j.erro_codigo);
      }
      if (acao === "desconectar") setMsg("Numero desconectado. O historico das conversas continua aqui.");
      setSemAtualizar(0);
      setAvisoLeve("");
    } catch (e: any) {
      // D4: o botao "conferir agora" e a MESMA acao `estado` do poller, e por isso
      // pega o mesmo 429 do piso — clicar duas vezes rapido pintava vermelho. Aqui,
      // diferente do poller, a pessoa CLICOU e merece resposta: frase neutra em
      // ambar dizendo que o estado acabou de ser conferido, nunca erro.
      if (acao === "estado" && e?.status === 429) {
        // NAO dizer "ja esta atualizado": pode ter sido a OUTRA aba que atualizou,
        // e afirmar isso seria inventar. Diz o fato — pedido muito seguido — e
        // conta pro aviso de teimosia (D5).
        setAvisoLeve(`Pedido muito seguido neste numero. Espere ${e?.retry_em ?? "alguns"}s e clique de novo.`);
        setSemAtualizar((n) => n + 1);
      } else setErro(String(e?.message || e));
    } finally {
      setOcupado(false);
    }
  };

  const estado = c?.estado ?? null;
  const pend = c?.troca_pendente ?? null;
  const expirado = qr ? qrExpirado(qr.em) : false;

  return (
    <>
      <Bloco
        titulo="Conexao"
        acao={
          <button className={BOTAO_FRACO} disabled={ocupado} onClick={() => agir("estado")}>
            <RefreshCw className="mr-1 inline h-3 w-3" /> conferir agora
          </button>
        }>
        <div className="flex items-center gap-2 text-xs">
          <Farol estado={estado} />
          <span className="font-medium">{estado?.detalhe ?? "consultando o provedor..."}</span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          numero conectado: <span className="font-medium">{estado?.numero ? formatarNumero(estado.numero) : "—"}</span>
          {c?.numero_gravado && !estado?.numero && (
            <> · ultimo conhecido: {formatarNumero(c.numero_gravado)}</>
          )}
          {" · "}instancia {c?.instancia ?? "—"}
        </p>
        {c && c.instancia_anterior && c.instancia_anterior !== c.instancia && (
          <Aviso
            texto={`A instalacao apontou este numero pra outra instancia do provedor (antes: ${c.instancia_anterior}). Isso ficou registrado no historico do canal.`}
          />
        )}
        {c && !c.disponivel && <Aviso texto={c.aviso} />}
        {c?.aviso_numero && <Aviso texto={c.aviso_numero} />}
        {/* CHIP TROCADO FORA DO FLUXO DE TROCA — o aviso mais forte desta tela.
            Ate a revisao cega isso era SILENCIOSO: alguem lia o QR com outro chip,
            o painel reescrevia o numero do canal e a unica pista era o campo
            mudando sozinho. Quem opera precisa saber que o atendimento passou a
            sair por outro numero, e que isso NAO foi uma troca declarada. */}
        {trocaSelvagem && (
          <div className="rounded-lg border-2 border-red-300 bg-red-50 px-3 py-2">
            <p className="text-xs font-semibold text-red-900">
              O numero deste canal mudou FORA do fluxo de troca
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-red-800">
              {trocaSelvagem.de ? `Ele era ${formatarNumero(trocaSelvagem.de)} e agora e ` : "Agora e "}
              {formatarNumero(trocaSelvagem.para)}. Alguem conectou outro chip direto, sem abrir troca — as conversas
              antigas continuam aqui, mas o atendimento passou a sair por este numero novo. Se nao foi proposital,
              desconecte e conecte o chip certo; se foi, esta tudo registrado no historico abaixo.
            </p>
            <button className={`${BOTAO_FRACO} mt-2 bg-white`} onClick={() => setTrocaSelvagem(null)}>
              entendi
            </button>
          </div>
        )}
        {semAtualizar >= 3 && (
          <Aviso
            texto={
              "Nao consegui atualizar o estado deste numero nas ultimas tentativas (o servidor esta pedindo pra esperar). " +
              "O que aparece acima pode estar velho — recarregue a pagina em alguns instantes."
            }
          />
        )}
        <Aviso texto={avisoLeve} />
        <Aviso texto={erro} tom="red" />
        <Aviso texto={msg} tom="green" />

        <div className="flex flex-wrap gap-1.5 pt-1">
          {!estado?.conectado && (
            <>
              <button className={BOTAO} onClick={() => { setModo("qr"); setErro(""); setMsg(""); }}>
                <QrCode className="mr-1 inline h-3.5 w-3.5" /> Conectar por QR Code
              </button>
              <button className={BOTAO_FRACO} onClick={() => { setModo("codigo"); setErro(""); setMsg(""); }}>
                <Smartphone className="mr-1 inline h-3.5 w-3.5" /> Nao tenho camera: usar codigo
              </button>
            </>
          )}
          {estado?.conectado && (
            <button className={BOTAO_FRACO} disabled={ocupado} onClick={() => agir("desconectar")}>
              <Unplug className="mr-1 inline h-3.5 w-3.5" /> Desconectar
            </button>
          )}
          <button className={BOTAO_FRACO} disabled={ocupado} onClick={() => agir("reiniciar")}>
            <RefreshCw className="mr-1 inline h-3.5 w-3.5" /> Reiniciar a conexao
          </button>
        </div>

        {/* ——— QR na tela, com a IDADE em voz alta */}
        {modo === "qr" && (
          <div className="mt-2 rounded-lg border bg-muted/30 p-3">
            <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
              No celular do numero: WhatsApp &gt; Configuracoes &gt; Aparelhos conectados &gt; Conectar um aparelho. Aponte a
              camera pro codigo abaixo.
            </p>
            {qr ? (
              <div className="flex flex-col items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qr.img}
                  alt="QR Code para conectar o numero"
                  className={`h-52 w-52 rounded bg-white ${expirado ? "opacity-40" : ""}`}
                />
                <p className={`text-[11px] ${expirado ? "font-medium text-amber-700" : "text-muted-foreground"}`}>
                  {/* a frase e a MESMA funcao pura provada; `tique` so faz ela recontar */}
                  <span data-tique={tique}>{rotuloIdadeQr(qr.em)}</span>
                </p>
              </div>
            ) : (
              <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> pedindo o codigo ao provedor...
              </p>
            )}
            <div className="mt-2 flex gap-1.5">
              <button className={BOTAO_FRACO} onClick={() => { setModo(""); setQr(null); }}>
                fechar
              </button>
              <button
                className={BOTAO_FRACO}
                disabled={ocupado}
                onClick={() => {
                  // pedido MANUAL: forca, sem esperar o vencimento. E o caminho do
                  // "escaneei com o numero errado" do card — o usuario pede outro
                  // explicitamente. Passa por `pedirQr` (e nao por `agir`) porque e
                  // la que mora a trava contra o poller disparar um segundo pedido.
                  void pedirQr(true);
                }}>
                gerar um codigo novo
              </button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              Escaneou com o numero errado? A tela avisa quando o chip conectado nao e o que voce declarou — e ai basta
              desconectar e ler o codigo com o aparelho certo.
            </p>
          </div>
        )}

        {/* ——— codigo de 8 digitos (alternativa sem camera) */}
        {modo === "codigo" && (
          <div className="mt-2 space-y-2 rounded-lg border bg-muted/30 p-3">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Informe o numero do aparelho (com DDI e DDD). O WhatsApp dele vai pedir um codigo de 8 digitos: digite o
              que aparecer aqui.
            </p>
            <div className="flex flex-wrap gap-1.5">
              <input
                className={CAIXA}
                placeholder="5511912345678"
                value={telefone}
                onChange={(e) => setTelefone(e.target.value)}
              />
              <button
                className={BOTAO}
                disabled={ocupado || !normalizarNumero(telefone)}
                onClick={() => agir("codigo", { telefone })}>
                pedir o codigo
              </button>
              <button className={BOTAO_FRACO} onClick={() => { setModo(""); setCodigo(null); }}>
                fechar
              </button>
            </div>
            {codigo && (
              <div className="rounded-lg border bg-white px-3 py-2 text-center">
                <p className="font-mono text-xl tracking-[0.3em]">{codigo.valor}</p>
                <p className="text-[11px] text-muted-foreground">digite este codigo no celular</p>
              </div>
            )}
          </div>
        )}
      </Bloco>

      <Numero canal={canal} authedFetch={authedFetch} pendente={pend} avisoTroca={c?.troca?.aviso ?? c?.aviso_troca ?? null} />
    </>
  );
}

// ═════════════════════════════════════ numero atual, troca e trilha
function Numero({
  canal,
  authedFetch,
  pendente,
  avisoTroca,
}: {
  canal: CanalTela;
  authedFetch: Fetch;
  pendente: TrocaPendente | null;
  avisoTroca: string | null;
}) {
  const [dados, setDados] = useState<{
    numero: string | null;
    identidade_configurada: string;
    historico: (EventoCanal & { texto: string })[];
    disponivel: boolean;
    aviso: string;
  } | null>(null);
  const [novo, setNovo] = useState("");
  const [consentimento, setConsentimento] = useState(false);
  const [erro, setErro] = useState("");
  const [msg, setMsg] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const r = await authedFetch(`/api/canais/numero?canal=${encodeURIComponent(canal.id)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErro(j?.error || `erro ${r.status}`);
        return;
      }
      setDados(j);
    } catch {
      setErro("nao consegui ler o numero deste canal agora");
    }
  }, [authedFetch, canal.id]);

  useEffect(() => {
    carregar();
    // recarrega quando a pendencia muda de estado (abriu, cancelou, concluiu):
    // a trilha ganhou linha nova e o numero pode ter mudado
  }, [carregar, pendente?.numero_novo, pendente?.iniciada_em]);

  // os MESMOS erros que a rota devolve, mostrados ANTES do clique — o botao so
  // habilita quando a regra pura aprova (validarTroca)
  const errosForm = validarTroca({
    numero_novo: novo,
    consentimento,
    numero_atual: dados?.numero ?? null,
  });

  const abrir = async () => {
    setOcupado(true);
    setErro("");
    setMsg("");
    try {
      const r = await authedFetch("/api/canais/numero", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canal: canal.id, numero_novo: novo, consentimento }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErro(j?.error || `erro ${r.status}`);
        return;
      }
      setMsg(j?.proximo_passo || "troca aberta");
      setNovo("");
      setConsentimento(false);
      await carregar();
    } finally {
      setOcupado(false);
    }
  };

  const cancelar = async () => {
    setOcupado(true);
    setErro("");
    setMsg("");
    try {
      const r = await authedFetch(`/api/canais/numero?canal=${encodeURIComponent(canal.id)}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErro(j?.error || `erro ${r.status}`);
        return;
      }
      setMsg("Troca cancelada. O canal segue com o numero atual.");
      await carregar();
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Bloco titulo="Numero do canal">
      <p className="text-[11px] text-muted-foreground">
        numero atual: <span className="font-medium">{dados?.numero ? formatarNumero(dados.numero) : "—"}</span>
        {dados?.identidade_configurada && <> · rotulo na configuracao: {dados.identidade_configurada}</>}
      </p>
      <Aviso
        tom="sky"
        texto="Trocar o chip NAO cria canal novo: o identificador do canal e o mesmo, e por isso todas as conversas e mensagens antigas continuam aqui."
      />
      {dados && !dados.disponivel && <Aviso texto={dados.aviso} />}
      <Aviso texto={erro} tom="red" />
      <Aviso texto={msg} tom="green" />

      {pendente ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-medium text-amber-900">
            Troca em andamento para {formatarNumero(pendente.numero_novo)}
          </p>
          <p className="mt-0.5 text-[11px] text-amber-800">
            aberta por {pendente.iniciada_por_nome || "alguem"}
            {pendente.numero_anterior && <> · saindo de {formatarNumero(pendente.numero_anterior)}</>}
          </p>
          {avisoTroca && <p className="mt-1.5 text-[11px] font-medium leading-relaxed text-amber-900">{avisoTroca}</p>}
          <button className={`${BOTAO_FRACO} mt-2 bg-white`} disabled={ocupado} onClick={cancelar}>
            cancelar a troca
          </button>
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-xs font-medium">Trocar o numero deste canal</p>
          <input
            className={`${CAIXA} w-full`}
            placeholder="numero novo com DDI e DDD (ex.: 5511912345678)"
            value={novo}
            onChange={(e) => setNovo(e.target.value)}
          />
          <label className="flex items-start gap-2 text-[11px] leading-relaxed">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={consentimento}
              onChange={(e) => setConsentimento(e.target.checked)}
            />
            <span>
              Entendi que o canal para de atender ate o chip novo conectar, e que vou precisar ler um QR Code (ou usar o
              codigo de 8 digitos) com o aparelho novo na mao.
            </span>
          </label>
          {novo.trim() && errosForm.length > 0 && (
            <p className="text-[11px] text-amber-800">{errosForm[0].texto}</p>
          )}
          <button className={BOTAO} disabled={ocupado || errosForm.length > 0} onClick={abrir}>
            abrir a troca
          </button>
        </div>
      )}

      {dados?.historico?.length ? (
        <div className="pt-1">
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">Historico do numero</p>
          <ul className="space-y-1">
            {dados.historico.map((ev, i) => (
              <li key={i} className="flex items-baseline gap-2 text-[11px]">
                <span className="shrink-0 text-muted-foreground">
                  {ev.criada_em ? new Date(ev.criada_em).toLocaleString("pt-BR") : ""}
                </span>
                {/* a frase vem do servidor, mas `descreverEvento` e a MESMA funcao
                    pura: linha sem `texto` (resposta antiga em cache) nao fica muda */}
                <span>{ev.texto || descreverEvento(ev)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">Nenhum evento registrado neste numero ainda.</p>
      )}
    </Bloco>
  );
}

// ══════════════════════════════════════ templates da API Oficial
function Templates({ canal, authedFetch }: { canal: CanalTela; authedFetch: Fetch }) {
  const [lista, setLista] = useState<(TemplateCanal & { rotulo_status?: string })[]>([]);
  const [saldo, setSaldo] = useState<{ disponivel: boolean; valor: number | null; moeda: string; aviso: string } | null>(null);
  const [sinc, setSinc] = useState<string | null>(null);
  const [cabeado, setCabeado] = useState(true);
  const [aviso, setAviso] = useState("");
  const [erro, setErro] = useState("");
  const [msg, setMsg] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [abrindoForm, setAbrindoForm] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const r = await authedFetch(`/api/canais/templates?canal=${encodeURIComponent(canal.id)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErro(j?.error || `erro ${r.status}`);
        return;
      }
      setLista(j?.templates ?? []);
      setSaldo(j?.saldo ?? null);
      setSinc(j?.sincronizado_em ?? null);
      setCabeado(!!j?.cabeado && !!j?.app_configurado);
      setAviso(j?.aviso || "");
    } catch {
      setErro("nao consegui ler o catalogo de templates agora");
    }
  }, [authedFetch, canal.id]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const sincronizar = async () => {
    setOcupado(true);
    setErro("");
    setMsg("");
    try {
      const r = await authedFetch("/api/canais/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canal: canal.id, acao: "sincronizar" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErro(j?.error || `erro ${r.status}`);
        return;
      }
      if (j?.ok === false) setAviso(j?.aviso || "");
      else setMsg(`Catalogo atualizado: ${j?.gravados ?? 0} template(s), ${j?.removidos ?? 0} removido(s).`);
      await carregar();
    } finally {
      setOcupado(false);
    }
  };

  const apagar = async (t: TemplateCanal) => {
    // apagar template SOME da Meta e nao volta: confirmacao explicita, no padrao
    // das acoes destrutivas do painel
    if (!window.confirm(`Apagar o template "${t.nome}"? Ele sai do provedor e da Meta, e nao volta.`)) return;
    setOcupado(true);
    setErro("");
    setMsg("");
    try {
      const url = `/api/canais/templates?canal=${encodeURIComponent(canal.id)}&nome=${encodeURIComponent(t.nome)}&idioma=${encodeURIComponent(t.idioma)}`;
      const r = await authedFetch(url, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErro(j?.error || `erro ${r.status}`);
        return;
      }
      setMsg(`Template "${t.nome}" apagado.`);
      await carregar();
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Bloco
      titulo="Templates da API Oficial"
      acao={
        <div className="flex gap-1.5">
          <button className={BOTAO_FRACO} disabled={ocupado || !cabeado} onClick={sincronizar}>
            {ocupado ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 inline h-3 w-3" />}
            Sincronizar
          </button>
          <button className={BOTAO} disabled={!cabeado} onClick={() => setAbrindoForm((v) => !v)}>
            Novo template
          </button>
        </div>
      }>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Fora da janela de 24 horas, este numero so envia template APROVADO pela Meta — e a aprovacao e por numero, nao
        por conta. Quem aprova esta do lado de fora: o estado abaixo vem do provedor, e so muda quando voce sincroniza.
      </p>
      <p className="text-[11px] text-muted-foreground">
        {sinc ? `catalogo sincronizado em ${new Date(sinc).toLocaleString("pt-BR")}` : "catalogo nunca sincronizado"}
        {saldo && (
          <> · saldo: {saldo.disponivel ? `${saldo.valor} ${saldo.moeda}` : saldo.aviso}</>
        )}
      </p>
      {!cabeado && (
        <Aviso texto="Este numero nao tem credencial completa de API Oficial na instalacao (api key, numero de origem e app id). Sem ela nao da pra sincronizar nem criar template." />
      )}
      <Aviso texto={aviso} />
      <Aviso texto={erro} tom="red" />
      <Aviso texto={msg} tom="green" />

      {abrindoForm && (
        <NovoTemplate
          canal={canal.id}
          authedFetch={authedFetch}
          aoFechar={() => setAbrindoForm(false)}
          aoCriar={async (frase) => {
            setMsg(frase);
            setAbrindoForm(false);
            await carregar();
          }}
        />
      )}

      {lista.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Nenhum template no catalogo deste numero. Clique em Sincronizar pra buscar os que ja existem no provedor.
        </p>
      ) : (
        // ZERO DECISAO AQUI. Cada linha (nome, detalhe, rotulo do status, selo de
        // recusa e os paragrafos) nasce PRONTA em `linhasDoCatalogo`
        // (lib/templates-oficial.ts, pura), exercitada contra fixtures no bloco P.6
        // da prova contra o que `decidirEnvioTemplate` responderia pro MESMO
        // template. Este `map` so desenha — se voltar a existir um `if` de regra
        // aqui, ele sai do alcance de qualquer prova deste repo (nenhuma renderiza
        // React) e volta a valer so por varredura de fonte, que e o que esta onda
        // inteira pagou. Ver "Modelo de ameaca" no CLAUDE.md.
        <ul className="space-y-1.5">
          {linhasDoCatalogo(lista).map((linha) => (
            <li key={linha.chave} className="rounded-lg border p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{linha.nome}</p>
                  <p className="text-[11px] text-muted-foreground">{linha.detalhe}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${CORES_STATUS[linha.status]}`}>
                    {linha.rotulo}
                  </span>
                  <button
                    className="rounded p-1 text-muted-foreground hover:bg-muted"
                    title="Apagar no provedor"
                    disabled={ocupado || !cabeado}
                    onClick={() => apagar(linha.template)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {linha.blocos.map((b) => (
                <p key={b.chave} className={`mt-1 ${TOM_DO_BLOCO[b.tom]}`}>
                  {b.rotulo && <span className="font-medium">{b.rotulo} </span>}
                  {b.texto}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
    </Bloco>
  );
}

function NovoTemplate({
  canal,
  authedFetch,
  aoFechar,
  aoCriar,
}: {
  canal: string;
  authedFetch: Fetch;
  aoFechar: () => void;
  aoCriar: (frase: string) => void | Promise<void>;
}) {
  const [f, setF] = useState({
    nome: "",
    categoria: "UTILITY",
    assunto: "",
    corpo: "",
    exemplo: "",
    rodape: "",
  });
  const [erros, setErros] = useState<string[]>([]);
  const [ocupado, setOcupado] = useState(false);

  const enviar = async () => {
    setOcupado(true);
    setErros([]);
    try {
      const r = await authedFetch("/api/canais/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canal, acao: "criar", ...f }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // O SERVIDOR MANDA na validacao: a mesma regra pura roda nas duas pontas,
        // e a tela mostra a lista que a ROTA devolveu — nao a que ela mesma
        // calculou. Regra em dois lugares diverge; a resposta e a fonte.
        setErros(j?.erros?.length ? j.erros : [j?.error || `erro ${r.status}`]);
        if (j?.exemplo_sugerido) setF((v) => ({ ...v, exemplo: j.exemplo_sugerido }));
        return;
      }
      await aoCriar(j?.proximo_passo || "template enviado pra aprovacao");
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <p className="text-xs font-medium">Novo template</p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        <input
          className={CAIXA}
          placeholder="nome_do_template (minusculas, _ )"
          value={f.nome}
          onChange={(e) => setF({ ...f, nome: e.target.value.toLowerCase() })}
        />
        <select className={CAIXA} value={f.categoria} onChange={(e) => setF({ ...f, categoria: e.target.value })}>
          <option value="UTILITY">Utilidade (aviso, confirmacao)</option>
          <option value="MARKETING">Marketing (oferta, convite)</option>
          <option value="AUTHENTICATION">Autenticacao (codigo)</option>
        </select>
      </div>
      <input
        className={`${CAIXA} w-full`}
        placeholder="assunto interno (nao aparece pro cliente)"
        value={f.assunto}
        onChange={(e) => setF({ ...f, assunto: e.target.value })}
      />
      <textarea
        className={`${CAIXA} h-20 w-full`}
        placeholder="Corpo: use {{1}}, {{2}} pras variaveis. Nao pode comecar nem terminar com variavel."
        value={f.corpo}
        onChange={(e) => setF({ ...f, corpo: e.target.value })}
      />
      <textarea
        className={`${CAIXA} h-16 w-full`}
        placeholder="Exemplo: o MESMO texto, com as variaveis trocadas por valores reais (a Meta le isto)"
        value={f.exemplo}
        onChange={(e) => setF({ ...f, exemplo: e.target.value })}
      />
      <input
        className={`${CAIXA} w-full`}
        placeholder="rodape (opcional, ate 60 caracteres, sem variavel)"
        value={f.rodape}
        onChange={(e) => setF({ ...f, rodape: e.target.value })}
      />
      {erros.length > 0 && (
        <ul className="space-y-0.5">
          {erros.map((e, i) => (
            <li key={i} className="text-[11px] text-red-700">
              {e}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        O template nasce em analise e so pode ser usado depois que a Meta aprovar (de minutos a 24h). Volte aqui e
        clique em Sincronizar pra ver o veredito.
      </p>
      <div className="flex gap-1.5">
        <button className={BOTAO} disabled={ocupado} onClick={enviar}>
          {ocupado ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : <Check className="mr-1 inline h-3 w-3" />}
          mandar pra aprovacao
        </button>
        <button className={BOTAO_FRACO} onClick={aoFechar}>
          cancelar
        </button>
      </div>
    </div>
  );
}
