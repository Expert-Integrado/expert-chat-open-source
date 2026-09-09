"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Search, Send, Users, MessageSquare, Check, CheckCheck, LogOut,
  Paperclip, Mic, Smile, MoreVertical, Reply, Pencil, Trash2, X, Square, MapPin, Clock,
  Archive, ArchiveRestore, Forward, Settings, Bell, Plus, Moon, Sun, StickyNote, RefreshCw, Lock,
  KeyRound, Copy, HelpCircle, Columns3, BarChart3, ShieldCheck,
  Bot, BotOff, History, Star, Images, FileText, Sticker, ArrowRightLeft, MessageSquarePlus, Download,
  Workflow,
  // FRENTE S (31/08/2026): fila de atendimento, pular a vez e pergunta com opcoes
  UserCheck, SkipForward, ListChecks,
  // FRENTE Y (31/08/2026): numeros (canais), memoria da conversa e template
  Smartphone, Braces, FileCheck2,
  // MODO ESTREITO (02/09/2026, widget embutido): voltar da conversa pra lista
  ArrowLeft,
  // FILTROS RECOLHIDOS (02/09/2026): as 4 caixas de filtro atras de um botao
  SlidersHorizontal,
  // REACAO (03/09/2026): reagir a mensagem com emoji, como no WhatsApp
  SmilePlus,
} from "lucide-react";
import {
  ABAS_MIDIA, MAX_DESTINOS_FORWARD, MIN_TERMO_BUSCA, ROTULO_ABA_MIDIA, TETO_INICIOS_POR_HORA,
  formatarDuracao, seloDeFluxo, type AbaMidia, type LinhaStatus, type LinhaTransferencia,
  type ResumoStatus, type VinculoFluxo,
} from "@/lib/tela-conversa";
import KanbanQuadro from "./kanban-quadro";
import ConversaHistoricos from "./conversa-historicos";
import RelatoriosPainel from "./relatorios-painel";
import AdminAcesso from "./admin-acesso";
// FRENTE Y — a tela de NUMEROS ja existia e ja funcionava em `/canais`; o que
// faltava era a entrada DENTRO do painel. O contrato veio escrito pela frente U
// (CLAUDE.md, "COSTURAS DECLARADAS"): `visaoPainel: "canais"` renderizando
// <AdminCanais authedFetch aoSair />. A pagina propria continua valendo como link
// direto, igual /widget — nao foi removida.
import AdminCanais from "./admin-canais";
import AdminCampos from "./admin-campos";
import FichaCampos from "./ficha-campos";
import MinhaChaveEscopo, { corpoEscopoProprio, type RecursoCatalogo } from "./minha-chave-escopo";
import { validarEscopoChave, type EscopoChave } from "@/lib/escopo-chave";
import type { AlvoConversas } from "@/lib/relatorios-tela";
// FRENTE S (31/08/2026): as REGRAS moram nas libs puras; estes .tsx so desenham.
import type { AcaoFila, SituacaoFila } from "@/lib/fila-atendimento";
import {
  limiteTituloOpcao,
  maxOpcoes,
  planoDeEnvio,
  validarInterativa,
  type TipoInterativa,
} from "@/lib/interativas";
// FRENTE Y (31/08/2026): as tres costuras da tela de conversa. A REGRA de cada
// uma mora em lib/tela-composer.ts (puro, `node scripts/prova-costuras-y.ts`);
// aqui e marcacao, estado e fetch.
import {
  avisoDeVariaveis, camposDoTemplate, chaveNormalizada, paresDeContexto, pedeTemplate,
  motivoDeNaoEnviar, previaDoTemplate, problemaDoPar, problemaDosParametros, respostasDoAtalho,
  templatesEnviaveis, textoParaCaixa, type ParContexto, type RespostaRapida,
} from "@/lib/tela-composer";
import { ROTULO_STATUS, type TemplateCanal } from "@/lib/templates-oficial";

const FAQ_URL = "https://expert-integrado.github.io/chat-ajuda/";
// A URL do MCP e a DESTA instalacao (abertura open source, 02/09/2026): chumbar
// o dominio da Expert fazia toda instalacao de aluno ensinar o comando errado.
// So roda no client (o comando aparece em modal), entao window sempre existe
// na hora do uso; o guard e pro prerender do Next.
const mcpUrl = () =>
  typeof window === "undefined" ? "/api/mcp/mcp" : `${window.location.origin}/api/mcp/mcp`;
const comandoMcp = (chave: string) =>
  `claude mcp add --transport http expert-chat ${mcpUrl()} --header "x-api-key: ${chave}"`;
import { authClient } from "@/lib/auth-client";
import type { Session } from "@supabase/supabase-js";
import type { CanalPublico } from "@/lib/canais";
import {
  acharChat, agruparPorCanal, canaisParaCarregar, filtrarPorCanal, gruposDoSeletor, juntarChats, rotuloDoCanal,
} from "@/lib/canais-front";
import { adicionarExtras, criteriosDeBusca, cursorMaisAntigo, manterExtras } from "@/lib/lista-conversas";
import { REACOES_RAPIDAS, aplicarReacao, podeReagir } from "@/lib/reacoes";
import {
  FUSO_FABRICA, formatarData, formatarDataHora, formatarHora, fusoDoEnv, fusoValido, isoDeLocal,
  localDeIso, mesmoDiaNoFuso, partesNoFuso, rotuloDiaNoFuso,
} from "@/lib/fuso";

// marca do painel — configuravel por env (open source: cada empresa poe a sua)
const NOME_PAINEL = process.env.NEXT_PUBLIC_NOME_PAINEL || "Central de Atendimento";
// subtitulo ANTES da 1a resposta de /api/chats — depois vem do registro de canais (lib/canais.ts)
const SUBTITULO_CENTRAL = process.env.NEXT_PUBLIC_SUBTITULO || "WhatsApp da empresa";
const DICA_LOGIN = process.env.NEXT_PUBLIC_DICA_LOGIN || "Entre com a conta criada pelo administrador.";
// seletor de visao (BU): chave do localStorage que guarda a visao escolhida
// {contexto, token, expira_em} — mesmo shape devolvido por /api/embed/token-proprio
const VISAO_STORAGE_KEY = "chat-visao";

type ChatResp = { tipo: "usuario" | "departamento"; id: string; nome: string };
// visibilidade admite BU (contexto) alem de pessoa/departamento — shape irmao do ChatResp
type VisResp = { tipo: "usuario" | "departamento" | "contexto"; id: string; nome: string };
type Chat = {
  chat_id: string;
  chat_name: string | null;
  is_group: boolean;
  phone: string | null;
  profile_thumbnail: string | null;
  last_message_at: string | null;
  preview: string | null;
  status: StatusAtendimento;
  responsaveis: ChatResp[];
  // legado: nome importado do ChatGuru sem conta no painel
  responsavel_id: string | null;
  responsavel_nome: string | null;
  nao_lidas: number;
  arquivada: boolean;
  // arquivamento automatico e restricao de visibilidade (16/08/2026, so super admin mexe)
  auto_arquivar: boolean;
  // 0017 (Frente O): conversa aberta pelo painel — "reservado" | "enviado" |
  // "falha_envio". Ausente quando a instalacao nao rodou a migration.
  inicio_estado?: string | null;
  visibilidade: VisResp[];
  // lista unica multi-canal (28/08/2026): canal de origem e identidade composta
  // canal:chat_id — o mesmo telefone pode existir em 2 canais (lib/canais-front.ts)
  canal: string;
  uid: string;
};

type Usuario = { id: string; nome: string; email?: string; foto_url?: string | null };
type Departamento = { id: string; nome: string };
// preferencias de aviso do proprio usuario (Meu perfil) — so existe chave pra
// aviso que o painel emite de verdade (bip do sininho e aviso do navegador)
// (espelho de lib/perfil-conta.ts — mudou la, muda aqui). `supervisor` e o modo
// de quem ACOMPANHA o atendimento: abrir a conversa nao a marca como lida.
type Preferencias = {
  som: boolean;
  desktop: boolean;
  supervisor: boolean;
  supervisor_responder_zera: boolean;
};
const PREFERENCIAS_PADRAO: Preferencias = {
  som: true,
  desktop: false,
  supervisor: false,
  supervisor_responder_zera: true,
};
type PerfilFront = {
  id?: string;
  papel: "super_admin" | "normal";
  // PERMISSOES EFETIVAS calculadas pelo servidor (papel nomeado + excecoes).
  // A tela REFLETE isto; o servidor segue sendo a fonte da verdade (403 na
  // rota). Ausente = resposta antiga: o fallback e o papel base.
  permissoes?: string[];
  // MODULOS ligados nesta instalacao (automacao, disparo, fila_atendimento), lidos pelo
  // servidor (lib/modulos.ts). Ausente = resposta antiga: a tela volta a aprender pelo 403.
  modulos?: Partial<Record<"automacao" | "disparo" | "fila_atendimento", boolean>>;
  escopo_visao: "proprias" | "departamento" | "todas";
  tema: "claro" | "escuro";
  nome: string;
  email: string | null;
  departamentos?: string[];
  foto_url?: string | null;
  preferencias?: Preferencias;
  assinatura_ativa?: boolean;
  assinatura_nome?: string;
  // false = migration 0011 ainda nao rodou nesta instalacao
  perfil_conta_disponivel?: boolean;
  // true = a leitura do perfil falhou: o que esta na tela e default, nao o gravado
  perfil_conta_erro?: boolean;
};
type AdminUsuario = Usuario & {
  foto_url?: string | null;
  papel: string; escopo_visao: string; ativo: boolean;
  assinatura_ativa: boolean; assinatura_nome: string;
  // modo supervisor por pessoa (Frente N): mora em perfis.preferencias (0011)
  supervisor?: boolean;
  supervisor_responder_zera?: boolean;
  departamentos: string[];
  // permissao por BU (16/08/2026): ids de embed_contextos vinculados; vazio = sem restricao
  contextos: string[];
  // papel NOMEADO (31/08/2026); null = segue o padrao do sistema pelo campo papel
  papel_id?: string | null;
  // ajuste individual: permissao -> true (concede) | false (revoga). A tela
  // DESTACA isso de proposito — excecao tem que ser visivel, nunca o jeito normal.
  permissoes_excecao?: Record<string, boolean>;
};
type AdminPapel = { id: string; nome: string; descricao: string; ativo: boolean; permissoes: string[] };
type AdminDep = {
  id: string; nome: string; ativo: boolean; escopo_visao: string | null;
  membros: { id: string; nome: string }[];
};
type CfgAuto = {
  auto_arquivar_concluida: boolean;
  auto_desarquivar_recebida: boolean;
  auto_atendimento_ao_responder: boolean;
  // existe no servidor mas NAO tem interruptor nesta tela: o motor de fluxo
  // ainda nao le essa chave (costura do coordenador, no merge) — ver CLAUDE.md
  auto_atendimento_bot: boolean;
  reinicio_minutos: number;
  reinicio_marcar_aberto: boolean;
  reinicio_redelegar: boolean;
  reinicio_remover_delegados: boolean;
  auto_logout_minutos: number;
  // horas ate uma aprovacao pendente da fila de automacao EXPIRAR; 0 = nunca
  aprovacao_expira_horas: number;
  exigir_2fa: boolean;
  auto_distribuir: boolean;
  teto_por_atendente: number;
  fuso: string;
  horario_dias: number[];
  horario_inicio: string;
  horario_fim: string;
  msg_saudacao: string;
  msg_ausencia: string;
  csat_ativo: boolean;
  csat_msg: string;
  seletor_visao: boolean;
  vigia_ativo: boolean;
  vigia_tg_chat_id: string;
  vigia_assinatura: string;
};
// Destino do webhook de saida como a TELA o conhece: sem segredo, so o flag de
// que existe um (o GET de /api/admin/webhooks-saida nunca devolve o valor).
type DestinoWebhook = {
  nome: string;
  url: string;
  eventos: string[];
  ativo: boolean;
  incluir_conteudo: boolean;
  segredo_definido?: boolean;
  /** so no formulario: segredo NOVO digitado agora (undefined = mantem o atual) */
  segredo?: string;
};
const EVENTOS_WEBHOOK = ["mensagem_recebida", "status_alterado", "conversa_concluida", "avaliacao_registrada"];
type Notif = {
  id: string; chat_id: string | null; titulo: string; texto: string | null;
  autor_nome: string | null; lida: boolean; criada_em: string;
};
// seletor de visao (BU): restricao que o proprio usuario logado escolheu na
// tela cheia — mesmo mecanismo do widget, so que auto-cunhado (token-proprio)
type Visao = { contexto: string; token: string; expira_em: string };

// bip curto de notificacao (WebAudio — nada de arquivo externo)
function apitar() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const tocar = (freq: number, t0: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.001, ctx.currentTime + t0);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t0 + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + t0);
      osc.stop(ctx.currentTime + t0 + 0.3);
    };
    tocar(880, 0);
    tocar(1174, 0.18);
    setTimeout(() => ctx.close(), 800);
  } catch {}
}

// Aviso na AREA DE TRABALHO (Notification API do proprio navegador), ligado por
// preferencia em Meu perfil. So dispara com a aba em segundo plano: com o painel
// na frente o sininho ja esta a vista, e aviso duplicado vira barulho.
// NAO e push com o navegador fechado — isso exigiria service worker e web-push,
// que este painel ainda nao tem (gotcha registrado no CLAUDE.md).
function avisarNaAreaDeTrabalho(n?: { titulo?: string | null; texto?: string | null }) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (typeof document !== "undefined" && !document.hidden) return;
    new Notification(n?.titulo || "Nova notificacao", {
      body: (n?.texto || "").slice(0, 180) || undefined,
      tag: "expert-chat-sininho",
    });
  } catch {}
}

type StatusAtendimento = "aberto" | "atendimento" | "concluido" | "aguardando";

// Filtro da lista e do encaminhar: a conversa bate se o NOME contem o texto OU se
// o NUMERO (chat_id) contem os digitos digitados. Texto vazio bate sempre.
function conversaBateBusca(c: { chat_name?: string | null; chat_id: string }, texto: string): boolean {
  const q = texto.trim().toLowerCase();
  if (!q) return true;
  if ((c.chat_name || "").toLowerCase().includes(q)) return true;
  const digitos = q.replace(/\D/g, "");
  return digitos.length >= 3 && c.chat_id.replace(/\D/g, "").includes(digitos);
}

const STATUS_INFO: Record<StatusAtendimento, { label: string; curto: string; dot: string; pill: string }> = {
  aberto: { label: "Em aberto", curto: "ABERTO", dot: "bg-red-500", pill: "bg-red-100 text-red-700" },
  atendimento: { label: "Em atendimento", curto: "EM ATEND.", dot: "bg-sky-500", pill: "bg-sky-100 text-sky-700" },
  concluido: { label: "Concluido", curto: "CONCLUIDO", dot: "bg-green-500", pill: "bg-green-100 text-green-700" },
  aguardando: { label: "Aguardando", curto: "AGUARD.", dot: "bg-amber-400", pill: "bg-amber-100 text-amber-700" },
};

type Msg = {
  id: string;
  direction: "sent" | "received";
  from_me: boolean;
  message_type: string;
  content: string | null;
  caption: string | null;
  sender_name: string | null;
  sender_phone: string | null;
  send_status: string | null;
  message_ts: string;
  media_url?: string | null;
  media_mime?: string | null;
  enviado_por_id?: string | null;
  enviado_por_nome?: string | null;
  provider_msg_id?: string | null;
  quoted_msg_id?: string | null;
  is_deleted?: boolean;
  editada_em?: string | null;
  reacao?: string | null;
  encaminhada?: boolean;
  interna?: boolean;
};

type TempMsg = { key: string; content: string; ts: string };

type Ficha = {
  chat_id: string;
  nome: string | null;
  is_group: boolean;
  status: string;
  responsavel_nome: string | null;
  etiquetas: string[];
  arquivado: boolean;
  ficha: Record<string, string>;
  campos_padrao?: string[];
  enriquecido_em: string | null;
  notas: { id: string; texto: string; autor: string | null; criada_em: string }[];
};

// ── FRENTE S (31/08/2026): o que as rotas desta frente devolvem ─────────────
/** GET /api/fila-atendimento — meu estado + o painel do time (so pra gestor). */
type FilaFront = {
  modulo_ativo: boolean;
  migration_pendente?: boolean;
  /** o FREIO esta engatado (a tabela da fila nao pode ser lida): distribuicao parada */
  fila_indisponivel?: boolean;
  aviso?: string | null;
  pode_ver_time?: boolean;
  eu: { user_id: string; situacao: SituacaoFila; pulou_desde: string | null; frase: string } | null;
  painel: {
    linhas: { user_id: string; nome: string; situacao: SituacaoFila; pulou_desde: string | null; online: boolean }[];
    contagem: Record<SituacaoFila, number>;
  } | null;
};
/**
 * GET /api/fluxo-fila?canal=&chat_id= — a fila de automacao DESTA conversa.
 * A rota e da Frente P e nao mudou: esta frente so a consome de dentro da
 * conversa, que e onde o atendente trabalha.
 */
type AutoConversa = {
  itens: {
    id: string;
    estado: string;
    fluxo_slug: string;
    fluxo_nome: string | null;
    disponivel_em: string;
    no_id: string;
    origem: string;
    usuario_nome: string | null;
    aviso: string | null;
    erro: string | null;
  }[];
  pode_aprovar: boolean;
  pode_cancelar: boolean;
  aviso?: string | null;
};

// ── FRENTE O: o que as rotas da tela de conversa devolvem ───────────────────
// Um achado da busca escopada. `trecho` ja vem recortado em volta da ocorrencia
// (lib/tela-conversa.ts faz o recorte, com o cuidado do indice em texto
// acentuado); a tela so desenha os "..." das pontas.
type AchadoConversa = {
  id: string;
  provider_msg_id: string | null;
  direcao: string;
  criada_em: string;
  autor: string | null;
  apagada?: boolean;
  realce?: boolean;
  trecho: string;
  cortou_inicio: boolean;
  cortou_fim: boolean;
};
type EstadoRobo = {
  disponivel: boolean;
  bot_ativo: boolean;
  alterado_por_nome?: string | null;
  alterado_em?: string | null;
  aviso?: string;
  /** trilha do liga/desliga (vem da tabela de eventos de status, origem "robo") */
  eventos?: { id: string; status: string; por_nome: string | null; criada_em: string }[];
};
type HistAvaliacoes = {
  csat: { id: string; nota: number; atendente_nome: string | null; criada_em: string }[];
  nps: {
    id: string;
    nota: number | null;
    comentario: string | null;
    respondida_em: string | null;
    pesquisa_nome: string | null;
    origem: string;
  }[];
  avisos: string[];
};
type ItemMidiaFront = {
  id: string;
  provider_msg_id: string | null;
  tipo: string;
  mime: string | null;
  url: string | null;
  legenda: string | null;
  criada_em: string;
  direcao: string;
};
type HistMidia = {
  abas: Record<AbaMidia, ItemMidiaFront[]>;
  truncado: boolean;
  aviso?: string;
};

const EMOJIS = ["😀","😁","😂","🤣","😊","😍","😉","😎","🤔","😅","🙏","👍","👎","👏","🙌","💪","🔥","✨","🎉","❤️","💚","💙","✅","❌","⚠️","📌","📎","📅","⏰","💰","📈","🚀","👀","🤝","😢","😡","🥳","🤗","😴","🍀"];

// ─────────────────────────── HORA: fuso da INSTALACAO ───────────────────────
//
// Tudo que a tela mostra como hora, e todo corte de "dia", sai no fuso da
// INSTALACAO — nunca no do navegador de quem esta olhando. Sem isso, dois
// atendentes em fusos diferentes viam separadores de dia diferentes na MESMA
// conversa, e a hora da bolha discordava do relatorio (que agrupa no banco).
//
// O valor vem da rota /api/chats (config > env > fabrica, lib/fuso.ts) e fica
// AQUI, num modulo que so o cliente carrega — variavel mutavel de modulo no
// servidor seria compartilhada entre requests de instalacoes diferentes.
// Ate a 1a resposta chegar, vale a env publica (ou a fabrica).
let FUSO_UI = fusoDoEnv() ?? FUSO_FABRICA;
function definirFusoUi(tz: unknown) {
  if (fusoValido(tz)) FUSO_UI = tz;
}

// divisor de dia no fluxo de mensagens (Hoje / Ontem / 13/08/26)
function rotuloDia(iso: string) {
  return rotuloDiaNoFuso(iso, FUSO_UI);
}

function dataHoraCompleta(iso: string) {
  return formatarDataHora(iso, FUSO_UI);
}

function fmtTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  // hoje mostra a hora; qualquer outro dia mostra a data
  if (mesmoDiaNoFuso(d, new Date(), FUSO_UI)) return formatarHora(d, FUSO_UI);
  const p = partesNoFuso(d, FUSO_UI);
  return `${String(p.dia).padStart(2, "0")}/${String(p.mes).padStart(2, "0")}`;
}

function initials(name: string) {
  return name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

// Avatar de ATENDENTE (pessoa do time): foto quando existe, iniciais quando nao.
// Um so componente pra todo canto que mostra quem atende — trocar a foto no Meu
// perfil aparece em todos de uma vez. `tamanho` sao as classes de tamanho do
// Tailwind (o mesmo desenho redondo que a lista de conversas ja usa).
function AvatarPessoa({ nome, foto, tamanho = "h-8 w-8", texto = "text-xs" }: {
  nome: string; foto?: string | null; tamanho?: string; texto?: string;
}) {
  const url = urlSegura(foto || undefined);
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className={`${tamanho} shrink-0 rounded-full object-cover`} />;
  }
  return (
    <span className={`${tamanho} ${texto} flex shrink-0 items-center justify-center rounded-full bg-primary/15 font-semibold text-primary`}>
      {initials(nome || "?")}
    </span>
  );
}

function msgText(m: Msg) {
  let t = m.content || m.caption || `[${m.message_type}]`;
  // o ChatGuru grava o atendente como "*Nome:*" no inicio do texto; ja mostramos
  // "Enviada por Nome" fora da bolha, entao tiramos o prefixo pra nao duplicar.
  if (m.from_me && m.enviado_por_nome) {
    t = t.replace(/^\*[^*\n]{2,60}:\*\s*\n?/, "").replace(/^[^:\n]{2,60}:\s*\n/, "");
  }
  return t;
}

// url de midia vem de terceiro: so https passa (bloqueia javascript:/data: em href)
function urlSegura(u: string | null | undefined) {
  if (!u) return null;
  try {
    return new URL(u).protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

// URL e telefone viram link; nunca innerHTML (texto de terceiro e hostil).
function linkificar(texto: string, chave: string): React.ReactNode[] {
  const partes: React.ReactNode[] = [];
  const regex = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
  let ultimo = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = regex.exec(texto))) {
    if (m.index > ultimo) partes.push(texto.slice(ultimo, m.index));
    const bruto = m[0].replace(/[.,;:)\]]+$/, "");
    const href = bruto.startsWith("http") ? bruto : `https://${bruto}`;
    partes.push(
      <a key={`${chave}l${i++}`} href={href} target="_blank" rel="noreferrer noopener"
        className="text-sky-700 underline underline-offset-2 hover:text-sky-900"
        onClick={(e) => e.stopPropagation()}>
        {bruto}
      </a>
    );
    ultimo = m.index + bruto.length;
  }
  if (ultimo < texto.length) partes.push(texto.slice(ultimo));
  return partes;
}

// Formatacao estilo WhatsApp: *negrito* _italico_ ~riscado~ ```mono``` `mono`.
// Recursivo pra permitir aninhamento; folhas passam por linkificar.
function formatar(texto: string, chave = "f"): React.ReactNode[] {
  const regras: { re: RegExp; render: (interno: React.ReactNode[], k: string) => React.ReactNode }[] = [
    { re: /```([\s\S]+?)```/, render: (i, k) => <code key={k} className="rounded bg-black/10 px-1 font-mono text-[0.85em]">{i}</code> },
    { re: /`([^`\n]+)`/, render: (i, k) => <code key={k} className="rounded bg-black/10 px-1 font-mono text-[0.85em]">{i}</code> },
    { re: /\*([^*\n]+)\*/, render: (i, k) => <strong key={k}>{i}</strong> },
    { re: /_([^_\n]+)_/, render: (i, k) => <em key={k}>{i}</em> },
    { re: /~([^~\n]+)~/, render: (i, k) => <s key={k}>{i}</s> },
  ];
  let melhor: { idx: number; len: number; grupo: string; render: (i: React.ReactNode[], k: string) => React.ReactNode } | null = null;
  for (const { re, render } of regras) {
    const m = re.exec(texto);
    if (m && (melhor === null || m.index < melhor.idx)) {
      melhor = { idx: m.index, len: m[0].length, grupo: m[1], render };
    }
  }
  if (!melhor) return linkificar(texto, chave);
  const antes = texto.slice(0, melhor.idx);
  const depois = texto.slice(melhor.idx + melhor.len);
  return [
    ...linkificar(antes, `${chave}a`),
    melhor.render(formatar(melhor.grupo, `${chave}i`), `${chave}m`),
    ...formatar(depois, `${chave}d`),
  ];
}

function ComTexto({ texto }: { texto: string }) {
  return <p className="whitespace-pre-wrap break-words">{formatar(texto)}</p>;
}

function Login() {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(false);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setCarregando(true);
    setErro("");
    const { error } = await authClient.auth.signInWithPassword({ email, password: senha });
    if (error) {
      setErro("Login invalido.");
      setCarregando(false);
      return;
    }
    // ─── FRENTE Q (31/08/2026), toque 1 de 3 da leva de SEGURANCA em app/home.tsx ───
    // A senha esta certa e o auth deixou entrar — mas quem decide se a pessoa
    // USA o painel agora e a politica de acesso do servidor (janela de horario,
    // dispositivo revogado). O login acontece direto no auth compartilhado, sem
    // handler nosso, entao e aqui que se pergunta: `/api/acesso` responde
    // `{ permitido, bloqueios }` pra propria conta.
    //
    // So age quando a resposta e OK e diz `permitido: false`. Qualquer outro
    // desfecho (401 de 2FA pendente, rede fora, rota ausente num deploy antigo)
    // segue o fluxo normal — este teste nao pode virar porta que tranca sozinha.
    try {
      const { data } = await authClient.auth.getSession();
      const token = data.session?.access_token;
      if (token) {
        const r = await fetch("/api/acesso", { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) {
          const j = await r.json().catch(() => null);
          if (j && j.permitido === false) {
            setErro(j.bloqueios?.[0] || "Seu acesso ao painel esta bloqueado agora.");
            // sessao local descartada pra nao cair num painel que nao carrega.
            // `scope: "local"` e obrigatorio: o default do auth-js e GLOBAL e
            // deslogaria a pessoa de TODOS os apps deste mesmo login (gotcha da
            // Frente G) — barrar no Expert Chat nao derruba o Meeting Hub.
            await authClient.auth.signOut({ scope: "local" });
            setCarregando(false);
            return;
          }
        }
      }
    } catch {}
    setCarregando(false);
  }

  return (
    <div className="flex h-screen items-center justify-center bg-muted">
      <form onSubmit={entrar} className="w-[340px] rounded-xl border bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold">{NOME_PAINEL}</h1>
        <p className="mb-4 text-xs text-muted-foreground">{DICA_LOGIN}</p>
        <input type="email" required placeholder="E-mail" autoComplete="email"
          className="mb-2 w-full rounded-lg border px-3 py-2 text-sm outline-none"
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <input type="password" required placeholder="Senha" autoComplete="current-password"
          className="mb-3 w-full rounded-lg border px-3 py-2 text-sm outline-none"
          value={senha} onChange={(e) => setSenha(e.target.value)} />
        {erro && <p className="mb-2 text-xs text-red-600">{erro}</p>}
        <button type="submit" disabled={carregando}
          className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {carregando ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </div>
  );
}

// Tela do codigo do 2FA: aparece depois da senha pra quem tem fator cadastrado.
function DesafioMfa({ aoEntrar }: { aoEntrar: () => void }) {
  const [codigo, setCodigo] = useState("");
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(false);
  async function verificar(e: React.FormEvent) {
    e.preventDefault();
    setCarregando(true);
    setErro("");
    try {
      const { data: fs } = await authClient.auth.mfa.listFactors();
      const fator = fs?.totp?.find((f) => f.status === "verified") || fs?.totp?.[0];
      if (!fator) throw new Error("sem fator");
      const { data: ch, error: e1 } = await authClient.auth.mfa.challenge({ factorId: fator.id });
      if (e1 || !ch) throw e1 || new Error("challenge");
      const { error: e2 } = await authClient.auth.mfa.verify({
        factorId: fator.id,
        challengeId: ch.id,
        code: codigo.trim(),
      });
      if (e2) throw e2;
      aoEntrar();
    } catch {
      setErro("Codigo invalido. Confira no app autenticador e tente de novo.");
    }
    setCarregando(false);
  }
  return (
    <div className="flex h-screen items-center justify-center bg-muted">
      <form onSubmit={verificar} className="w-[340px] rounded-xl border bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold">Verificacao em duas etapas</h1>
        <p className="mb-4 text-xs text-muted-foreground">
          Digite o codigo de 6 digitos do seu app autenticador.
        </p>
        <input
          inputMode="numeric" autoComplete="one-time-code" required placeholder="000000" maxLength={6}
          className="mb-3 w-full rounded-lg border px-3 py-2 text-center text-lg tracking-[0.4em] outline-none"
          value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ""))} autoFocus
        />
        {erro && <p className="mb-2 text-xs text-red-600">{erro}</p>}
        <button type="submit" disabled={carregando || codigo.length < 6}
          className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {carregando ? "Conferindo..." : "Entrar"}
        </button>
        <button type="button" onClick={() => authClient.auth.signOut()}
          className="mt-2 w-full rounded-lg border py-2 text-xs text-muted-foreground hover:bg-muted">
          Sair e voltar pro login
        </button>
      </form>
    </div>
  );
}

// Cadastro FORCADO do 2FA (admin ligou "exigir de todos"): sem confirmar o
// codigo do app autenticador, nao entra no painel.
function CadastroMfa({ aoConcluir }: { aoConcluir: () => void }) {
  const [enrol, setEnrol] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [codigo, setCodigo] = useState("");
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(false);

  useEffect(() => {
    (async () => {
      // limpa cadastro pela metade e comeca um novo
      const { data: fs } = await authClient.auth.mfa.listFactors();
      for (const f of (fs?.all ?? []).filter((f) => f.status === "unverified")) {
        await authClient.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
      }
      const { data, error } = await authClient.auth.mfa.enroll({ factorType: "totp", friendlyName: "app-autenticador" });
      if (error || !data) {
        setErro("Falha ao preparar o 2FA. Recarregue a pagina.");
        return;
      }
      const totp = (data as any).totp || {};
      setEnrol({ factorId: data.id, qr: totp.qr_code || "", secret: totp.secret || "" });
    })();
  }, []);

  async function confirmar(e: React.FormEvent) {
    e.preventDefault();
    if (!enrol) return;
    setCarregando(true);
    setErro("");
    try {
      const { data: ch, error: e1 } = await authClient.auth.mfa.challenge({ factorId: enrol.factorId });
      if (e1 || !ch) throw e1 || new Error("challenge");
      const { error: e2 } = await authClient.auth.mfa.verify({
        factorId: enrol.factorId,
        challengeId: ch.id,
        code: codigo.trim(),
      });
      if (e2) throw e2;
      aoConcluir();
    } catch {
      setErro("Codigo invalido. Confira no app e tente de novo.");
    }
    setCarregando(false);
  }

  return (
    <div className="flex h-screen items-center justify-center bg-muted">
      <form onSubmit={confirmar} className="w-[380px] rounded-xl border bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold">Configure a verificacao em duas etapas</h1>
        <p className="mb-3 text-xs text-muted-foreground">
          O acesso ao painel exige 2FA. Escaneie o QR no app autenticador (Google Authenticator,
          1Password, Authy...) e confirme com o codigo de 6 digitos.
        </p>
        {enrol?.qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={enrol.qr} alt="QR do 2FA" className="mx-auto mb-2 h-44 w-44 rounded bg-white p-1" />
        ) : (
          <p className="mb-2 text-center text-xs text-muted-foreground">Gerando QR...</p>
        )}
        {enrol?.secret && (
          <p className="mb-3 break-all text-center text-[11px] text-muted-foreground">
            Sem camera? Digite a chave no app: <code>{enrol.secret}</code>
          </p>
        )}
        <input
          inputMode="numeric" autoComplete="one-time-code" required placeholder="000000" maxLength={6}
          className="mb-3 w-full rounded-lg border px-3 py-2 text-center text-lg tracking-[0.4em] outline-none"
          value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ""))}
        />
        {erro && <p className="mb-2 text-xs text-red-600">{erro}</p>}
        <button type="submit" disabled={carregando || codigo.length < 6 || !enrol}
          className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {carregando ? "Confirmando..." : "Ativar e entrar"}
        </button>
        <button type="button" onClick={() => authClient.auth.signOut()}
          className="mt-2 w-full rounded-lg border py-2 text-xs text-muted-foreground hover:bg-muted">
          Sair e voltar pro login
        </button>
      </form>
    </div>
  );
}

export default function Home({ embed = false, ctxToken = "" }: { embed?: boolean; ctxToken?: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [mfaPendente, setMfaPendente] = useState(false);
  const [mfaCadastro, setMfaCadastro] = useState(false);
  const sessionRef = useRef<Session | null>(null);
  if (session && !sessionRef.current) sessionRef.current = session;
  if (!session) sessionRef.current = null;

  useEffect(() => {
    authClient.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = authClient.auth.onAuthStateChange((_e, s) => {
      // o token renovado vai pro ref (usado nos fetches) SEM trocar o estado:
      // trocar o objeto session a cada refresh reiniciava os efeitos e a tela
      // piscava/recarregava do nada a cada ~1h
      sessionRef.current = s;
      setSession((prev) => (prev?.user?.id === s?.user?.id && !!prev === !!s ? prev : s));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const [chats, setChats] = useState<Chat[]>([]);
  const [active, setActive] = useState<Chat | null>(null);
  const [users, setUsers] = useState<Usuario[]>([]);
  const [departamentos, setDepartamentos] = useState<Departamento[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [temp, setTemp] = useState<TempMsg[]>([]);
  const [filter, setFilter] = useState("");
  const [buscaResultados, setBuscaResultados] = useState<
    null | { canal: string; chat_id: string; chat_name: string; is_group: boolean; trecho: string; de: string | null; quando: string }[]
  >(null);
  const [buscando, setBuscando] = useState(false);
  // multi-selecao: mistura pessoas, departamentos e "none" (sem responsavel)
  const [filtroResps, setFiltroResps] = useState<string[]>([]);
  // "sem responsavel" tem DUAS definicoes neste painel: a matriz do relatorio
  // usa ausencia de linha na N:N (conversa_responsaveis), e o filtro da lista
  // exige TAMBEM `responsavel_id` nulo — a coluna que o CLAUDE.md descreve como
  // "espelho legado do 1o responsavel". Conversa importada com nome no espelho e
  // nada na N:N conta no relatorio e desaparecia da lista, fazendo o clique na
  // celula abrir menos linhas que o numero. Quando o filtro vem do RELATORIO, a
  // N:N governa. Alterar a definicao global seria mexer na tela de conversas,
  // que nao e desta frente.
  const [filtroRespNnPura, setFiltroRespNnPura] = useState(false);
  const [filtroRespAberto, setFiltroRespAberto] = useState(false);
  const [filtroStatus, setFiltroStatus] = useState("");
  const [filtroLida, setFiltroLida] = useState("");
  const [verArquivadas, setVerArquivadas] = useState(false);
  // ALEM DA JANELA (03/09/2026, lib/lista-conversas.ts): o poll traz a pagina mais
  // recente de cada canal (600); o que a pessoa puxou A MAIS — paginas antigas e
  // resultados da busca no acervo — fica registrado aqui pelo uid, e cada poll
  // preserva esses itens (`manterExtras`) em vez de apaga-los.
  const extrasRef = useRef<Set<string>>(new Set());
  const [temMaisAntigas, setTemMaisAntigas] = useState<Record<string, boolean>>({});
  const [carregandoMais, setCarregandoMais] = useState(false);
  const [buscandoAcervo, setBuscandoAcervo] = useState(false);
  const buscaAcervoSeq = useRef(0);
  const [fotosQuebradas, setFotosQuebradas] = useState<Record<string, true>>({});
  const marcarFotoQuebrada = (url: string) => setFotosQuebradas((f) => ({ ...f, [url]: true }));
  const fotoOk = (url: string | null | undefined) => (url && !fotosQuebradas[url] ? url : null);
  const [draft, setDraft] = useState("");
  // respostas rapidas ("/atalho") e mensagens agendadas da conversa aberta
  // FRENTE Y: o tipo veio pra lib (RespostaRapida) porque agora ele carrega
  // `texto_resolvido` e as listas de variavel vazia / nao reconhecida — os campos
  // que a rota da frente T ja devolvia e que a caixa de digitacao ignorava.
  // FRENTE Y (revisao 1) — DOIS estados, e a separacao e o conserto de um GRAVE.
  //
  // Era UM estado servindo dois consumidores com formatos DIFERENTES: o composer
  // precisa da lista COM `texto_resolvido` (o GET com chat_id+canal), o cadastro
  // em Configuracoes pede a lista CRUA (nao tem conversa). Cada vez que alguem
  // criava ou apagava uma resposta rapida com uma conversa aberta, o cadastro
  // sobrescrevia o estado do composer com a versao crua — e o `/boas` seguinte
  // mandava `!nome` LITERAL pro cliente. Exatamente o defeito do card 86ak86jw9
  // que esta frente fechou, reaberto pela porta dos fundos, sem nada na tela
  // dizendo, e so "consertavel" trocando de conversa.
  const [respostasRapidas, setRespostasRapidas] = useState<RespostaRapida[]>([]);
  const [rrCadastro, setRrCadastro] = useState<RespostaRapida[]>([]);
  // `status` vem do select da rota e ENTRA no estado (correcao da 2a revisao): a
  // rota reserva a linha como `enviando` antes de mandar, e sem este campo a tela
  // desenhava a linha reservada como agendamento futuro, com Editar e Cancelar que
  // so podiam voltar 400. Ver a faixa das agendadas.
  const [agendadas, setAgendadas] = useState<
    { id: string; texto: string; enviar_em: string; status?: string; criado_por_nome: string | null }[]
  >([]);
  const [agendarAberto, setAgendarAberto] = useState(false);
  const [agendarQuando, setAgendarQuando] = useState("");
  // ─── FRENTE S (31/08/2026) — EDITAR a agendada antes de sair (card 86ak85nyj).
  // Cancelar ja existia; editar nao. `null` = ninguem esta editando.
  // `orig*` = o que estava gravado quando o formulario abriu. Sem isso a tela nao
  // sabe o que MUDOU e mandaria os dois campos sempre (ver salvarAgendadaEditada).
  const [agendadaEdit, setAgendadaEdit] = useState<{
    id: string; texto: string; quando: string; origTexto: string; origQuando: string;
  } | null>(null);
  // ─── FRENTE S — pendencias de AUTOMACAO nesta conversa (card 86ak85nyj):
  // o que a automacao esta esperando alguem aprovar, e o que ja saiu da mao mas
  // ainda nao foi enviado. Vem de /api/fluxo-fila?canal=&chat_id= (Frente P).
  const [autoConversa, setAutoConversa] = useState<AutoConversa | null>(null);
  // ─── FRENTE S — FILA DE ATENDIMENTO (card 86ak85nxx).
  const [fila, setFila] = useState<FilaFront | null>(null);
  const [filaAberta, setFilaAberta] = useState(false);
  // ─── FRENTE S — pergunta com OPCOES pelo composer (card 86ak86jvw).
  const [interAberto, setInterAberto] = useState(false);
  const [interTipo, setInterTipo] = useState<"botoes" | "lista">("botoes");
  const [interOpcoes, setInterOpcoes] = useState<string[]>(["", ""]);
  const [interBotaoLista, setInterBotaoLista] = useState("Ver opcoes");
  // ─── FRENTE Y — TEMPLATE NO COMPOSER (costura da frente U, card 86ak858pa).
  //
  // O seletor SO abre com o sinal do servidor: `/api/send` responde 403 com
  // `use_template: true` quando a janela de 24h fechou no numero de API Oficial.
  // Deduzir pela tela ("canal e apioficial e a janela parece fechada") ofereceria
  // template em caso que a rota aceitaria — e o backend e a fonte da verdade da
  // janela (ele mede pela ultima mensagem RECEBIDA no banco, a tela nao).
  //
  // `catalogo: null` = nao carregou ainda. `aviso` e o motivo de a lista estar
  // vazia (0023 pendente, canal sem credencial, catalogo nunca sincronizado) —
  // lista vazia sem explicacao faria o atendente procurar um botao que nao existe.
  const [tplAberto, setTplAberto] = useState(false);
  const [tplCatalogo, setTplCatalogo] = useState<TemplateCanal[] | null>(null);
  const [tplAviso, setTplAviso] = useState<string | null>(null);
  const [tplEscolhido, setTplEscolhido] = useState<TemplateCanal | null>(null);
  const [tplParams, setTplParams] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [respondendo, setRespondendo] = useState<Msg | null>(null);
  const [editando, setEditando] = useState<Msg | null>(null);
  const [menuMsg, setMenuMsg] = useState<string | null>(null);
  // REACAO (03/09/2026): id da mensagem com a barra de emojis aberta
  const [reagindo, setReagindo] = useState<string | null>(null);
  const [emojiAberto, setEmojiAberto] = useState(false);
  const [gravando, setGravando] = useState(false);
  // ─── FRENTE S — AUDIO com contador e PREVIA (card 86ak86jx2).
  // O que existia: clicar gravava e o `onstop` ENVIAVA na hora. Faltavam os dois
  // criterios do card — "contador de tempo visivel durante a gravacao" e "ouvir
  // a previa, regravar, enviar ou descartar antes de QUALQUER envio". Enviar na
  // parada e o defeito que doi na operacao: tosse, cachorro ou frase errada
  // chegavam ao cliente sem ninguem poder revisar.
  const [gravSeg, setGravSeg] = useState(0);
  const [audioPronto, setAudioPronto] = useState<{ url: string; blob: Blob; seg: number } | null>(null);
  const relogioGrav = useRef<ReturnType<typeof setInterval> | null>(null);
  // FRENTE S: espelho do `blob:` vigente. A limpeza do unmount NAO pode ler o
  // estado por `setAudioPronto(fn)` — o React descarta atualizacao de componente
  // desmontado, entao o revoke ficava pendurado numa funcao que pode nao rodar, e
  // o blob vazava justo no caso que o efeito existe pra cobrir (correcao da
  // revisao cega). Ref e leitura sincrona e sempre atual.
  const audioUrlRef = useRef<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // ─── FRENTE Q (31/08/2026), toque 2 de 3 da leva de SEGURANCA em app/home.tsx ───
  // ultima frase de bloqueio de acesso ja avisada: o poll (3-6s) nao pode
  // reabrir o mesmo aviso a cada rodada. Par do toque 3 (loadChats).
  const ultimoBloqueio = useRef<string | null>(null);
  const [encaminhando, setEncaminhando] = useState<Msg | null>(null);
  const [destinosFwd, setDestinosFwd] = useState<string[]>([]);
  const [buscaFwd, setBuscaFwd] = useState("");
  const [enviandoFwd, setEnviandoFwd] = useState(false);
  const [perfil, setPerfil] = useState<PerfilFront | null>(null);
  // VISAO do painel: a lista de conversas de sempre, ou o quadro (kanban) de
  // funil em tela cheia. O quadro e uma visao daqui, nao uma pagina propria —
  // assim ele herda sessao, MFA, canais e o `authedFetch`, e clicar num cartao
  // e um clique (`abrirConversa`), nao uma navegacao. Decisao no CLAUDE.md.
  // "relatorios" (Frente M): a tela de relatorios saiu do modal Configuracoes e
  // virou visao propria — relatorio nao e configuracao, e grafico de 90 dias nao
  // cabe num modal.
  // "acesso" (Frente Q): janela de acesso, dispositivos, recorte por funil/canal
  // e escopo das chaves de API. Visao propria pelo mesmo motivo dos relatorios —
  // a barra de abas do modal de Configuracoes ja carrega seis abas numa linha, e
  // grade de 7 dias x 2 periodos nao cabe num modal de 672px. A ENTRADA fica no
  // modal (aba Usuarios e permissoes) e no painel de cada pessoa.
  // "canais" (Frente Y, costura declarada pela frente U): conectar numero por QR
  // ou codigo, trocar de chip preservando o historico e o catalogo de template do
  // numero. Visao propria pelo MESMO motivo das duas irmas — QR em tela com
  // polling, trilha do canal e catalogo de template nao caberiam numa setima aba
  // do modal de Configuracoes.
  const [visaoPainel, setVisaoPainel] = useState<
    "conversas" | "quadro" | "relatorios" | "acesso" | "canais"
  >("conversas");
  // abre a visao de acesso ja com esta pessoa escolhida (atalho do painel dela)
  const [acessoDe, setAcessoDe] = useState<string>("");
  const [configAberta, setConfigAberta] = useState(false);
  const [abaConfig, setAbaConfig] = useState<"conta" | "respostas" | "usuarios" | "departamentos" | "automacao" | "fichacfg" | "campos" | "instalar">("conta");
  // busca no mapa de Configuracoes (tranche 2 da revisao de interface, 03/09/2026)
  const [buscaConfig, setBuscaConfig] = useState("");
  const [rrAtalho, setRrAtalho] = useState("");
  const [rrTexto, setRrTexto] = useState("");
  const [rrGlobal, setRrGlobal] = useState(false);
  const [cfgAuto, setCfgAuto] = useState<CfgAuto | null>(null);
  const [webhooks, setWebhooks] = useState<DestinoWebhook[] | null>(null);
  const [adminUsuarios, setAdminUsuarios] = useState<AdminUsuario[]>([]);
  const [usuarioAberto, setUsuarioAberto] = useState<AdminUsuario | null>(null);
  const [adminDeps, setAdminDeps] = useState<AdminDep[]>([]);
  // troca da propria senha (Meu perfil): exige a senha ATUAL e confirmacao da nova
  const [senhaAtual, setSenhaAtual] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const [confirmaSenha, setConfirmaSenha] = useState("");
  const [salvandoSenha, setSalvandoSenha] = useState(false);
  const [senhaMsg, setSenhaMsg] = useState<string | null>(null);
  const [senhaOk, setSenhaOk] = useState(false);
  // foto e preferencias de aviso (Meu perfil)
  const [fotoMsg, setFotoMsg] = useState<string | null>(null);
  const [enviandoFoto, setEnviandoFoto] = useState(false);
  const inputFoto = useRef<HTMLInputElement | null>(null);
  const [prefMsg, setPrefMsg] = useState<string | null>(null);
  const [assinaturaNome, setAssinaturaNome] = useState("");
  // 2FA da propria conta (Minha conta)
  const [mfaTem, setMfaTem] = useState<boolean | null>(null);
  const [mfaEnrol, setMfaEnrol] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [mfaCod, setMfaCod] = useState("");
  const [mfaMsg, setMfaMsg] = useState<string | null>(null);
  // chave de API pessoal (MCP): autoatendimento na aba Minha conta
  const [minhasChaves, setMinhasChaves] = useState<
    {
      id: string; nome: string; criado_em: string; ultimo_uso_em: string | null;
      // Frente Q: o recorte da chave e o rastro do ultimo uso. Campos opcionais
      // de proposito — sem a 0019 a rota cai no select antigo e eles nao vem.
      escopo_resumo?: string; expira_em?: string | null; expirada?: boolean;
      ultimo_uso_ip?: string | null; ultimo_uso_ua?: string | null;
    }[] | null
  >(null);
  // recorte da chave NOVA (Frente Q). `ignorar_janela` nao existe aqui: e a
  // unica dimensao que afrouxa e vive so no caminho de super admin.
  const [escopoNova, setEscopoNova] = useState<EscopoChave>(validarEscopoChave({}));
  const [prazoNova, setPrazoNova] = useState("");
  const [recursosChave, setRecursosChave] = useState<RecursoCatalogo[]>([]);
  const [escopoChaveOk, setEscopoChaveOk] = useState(true);
  const [chaveNova, setChaveNova] = useState<{ chave: string; nome: string } | null>(null);
  const [chaveNome, setChaveNome] = useState("");
  const [chaveMsg, setChaveMsg] = useState<string | null>(null);
  const [chaveCopiada, setChaveCopiada] = useState(false);
  const [keyCopiada, setKeyCopiada] = useState(false);
  const [gerandoChave, setGerandoChave] = useState(false);
  const [novoDep, setNovoDep] = useState("");
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [sinoAberto, setSinoAberto] = useState(false);
  const naoLidasAntes = useRef(-1);
  // preferencia de aviso lida DENTRO do poll: sem ref, o intervalo ficaria com o
  // valor da primeira renderizacao e o interruptor so valeria depois do F5
  const prefsRef = useRef<Preferencias>(PREFERENCIAS_PADRAO);
  const [fichaEdit, setFichaEdit] = useState<Record<string, string> | null>(null);
  const [novaNota, setNovaNota] = useState("");
  const [salvandoNota, setSalvandoNota] = useState(false);
  const [menuPerfil, setMenuPerfil] = useState(false);
  const [catalogoEtiquetas, setCatalogoEtiquetas] = useState<string[]>([]);
  const [modoNota, setModoNota] = useState(false);
  const [filtroTipo, setFiltroTipo] = useState("");
  // canal DA CONVERSA ABERTA (contexto das acoes por conversa: mensagens, ficha,
  // agendadas, envio). Desde 28/08/2026 a lista e multi-canal: quem escolhe o que
  // aparece e o filtro `filtroCanal`; `canal` acompanha a conversa ativa.
  const [canal, setCanal] = useState<string>("central");
  const canalRef = useRef<string>("central");
  // registro publico dos canais (vem em /api/chats) + filtro da lista ("" = todos)
  const [canais, setCanais] = useState<CanalPublico[]>([]);
  const canaisRef = useRef<CanalPublico[]>([]);
  const [filtroCanal, setFiltroCanal] = useState("");
  // polls concorrentes: so a resposta mais recente escreve na lista
  const loadSeq = useRef(0);
  // seletor de visao (BU): so na tela cheia; no embed o token da URL ja trava
  const [visao, setVisao] = useState<Visao | null>(null);
  const [visoes, setVisoes] = useState<{ id: string; nome: string }[]>([]);
  const visaoRef = useRef<Visao | null>(null);
  // fallback do catalogo de BUs pro select de visibilidade da ficha/massa quando
  // o proprio super admin nao tem o seletor de visao ligado (visoes fica vazio)
  const [visBuFallback, setVisBuFallback] = useState<{ id: string; nome: string }[] | null>(null);
  // selecao em massa (so super admin, so fora do embed): visibilidade + auto-arquivar
  const [modoSelecao, setModoSelecao] = useState(false);
  const [selecionados, setSelecionados] = useState<string[]>([]);
  // MODO ESTREITO (02/09/2026): abaixo de `md` as ferramentas do composer moram
  // atras de um "+" e as acoes secundarias do cabecalho atras de um "⋮".
  const [maisComposerAberto, setMaisComposerAberto] = useState(false);
  const [maisHeaderAberto, setMaisHeaderAberto] = useState(false);
  // FOTO AMPLIADA (Eric, 02/09/2026): clicar na foto do contato abre a imagem
  // grande por cima de tudo (cabecalho e ficha); Esc ou clique fora fecha.
  const [fotoAmpliada, setFotoAmpliada] = useState<string | null>(null);
  useEffect(() => {
    if (!fotoAmpliada) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setFotoAmpliada(null); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [fotoAmpliada]);
  // FILTROS RECOLHIDOS (Eric, 02/09/2026): as quatro caixas (status, responsavel,
  // leitura, tipo) numa linha de 340px viravam "Status: to | Respons... | Tipo: tod"
  // em QUALQUER largura. Ficam atras de um botao ao lado da busca; a bolinha diz
  // quantos filtros estao ativos enquanto recolhidos.
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const filtrosAtivos =
    [filtroStatus, filtroLida, filtroTipo].filter(Boolean).length + (filtroResps.length ? 1 : 0);
  // Largura da JANELA (nao da coluna): decide so TEXTO que nao da pra trocar por
  // CSS — o placeholder da caixa de mensagem. Mesmo corte `lg` do composer inline.
  const [larguraLg, setLarguraLg] = useState(true);
  useEffect(() => {
    const m = window.matchMedia("(min-width: 1024px)");
    const aplicar = () => setLarguraLg(m.matches);
    aplicar();
    m.addEventListener("change", aplicar);
    return () => m.removeEventListener("change", aplicar);
  }, []);
  const [painelVisMassa, setPainelVisMassa] = useState(false);
  const [visMassaModo, setVisMassaModo] = useState<"set" | "add">("set");
  const [visMassaItens, setVisMassaItens] = useState<VisResp[]>([]);
  const [aplicandoMassa, setAplicandoMassa] = useState(false);
  // tela "Instalar widget" (Eric 02/09/2026, card 86akaap3m): forma de exibicao + contexto +
  // codigo pronto. O que o front nao sabe (origens liberadas, cunhagem configurada, contextos
  // ativos) vem de GET /api/embed/instalacao; o token de longa duracao, do POST na mesma rota.
  type InstalacaoInfo = {
    painel_url: string;
    origens_liberadas: string[];
    mint_configurado: boolean;
    jwt_configurado: boolean;
    teto_dias: number;
    contextos: { id: string; nome: string; filtro_tipo: string | null }[];
  };
  const [instInfo, setInstInfo] = useState<InstalacaoInfo | null>(null);
  const [instErro, setInstErro] = useState<string | null>(null);
  const [instForma, setInstForma] = useState<"balao" | "tela" | "lateral">("tela");
  const [instContexto, setInstContexto] = useState("");
  const [instDias, setInstDias] = useState(90);
  const [instToken, setInstToken] = useState<{ token: string; expira_em: string } | null>(null);
  const [instOrigem, setInstOrigem] = useState("");
  const [instJsx, setInstJsx] = useState(false);
  const [instCopiado, setInstCopiado] = useState<string | null>(null);
  // permissao por BU (16/08/2026): usuario vinculado pelo admin — a restricao ja
  // e travada no SERVIDOR (independe do que o select mostra); isso aqui e so
  // pra UI avisar ("Minhas" em vez de "Todas") e travar o select com 1 BU so
  const [visaoVinculada, setVisaoVinculada] = useState(false);
  // desligamento por inatividade (valor vem do admin via /api/chats; 0 = nunca)
  const autoLogoutMinRef = useRef(0);
  const ultimaAtividadeRef = useRef(Date.now());
  canalRef.current = canal;
  const [janela, setJanela] = useState<{ aberta: boolean; expira_em: string | null } | null>(null);
  const [sincronizando, setSincronizando] = useState(false);

  async function sincronizarChatGuru() {
    if (sincronizando) return;
    setSincronizando(true);
    try {
      const r = await authedFetch("/api/sync-chatguru", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setAviso(j.error || "Falha na sincronizacao");
      else
        setAviso(
          j.mensagens_novas
            ? `Sincronizado: ${j.mensagens_novas} mensagem(ns) nova(s) em ${j.conversas_com_novidade} conversa(s).`
            : `Sincronizado: nada novo (${j.conversas_verificadas} conversas conferidas).`
        );
      loadChats();
      if (activeRef.current) loadMsgs(activeRef.current);
    } finally {
      setSincronizando(false);
    }
  }
  const [fichaCfg, setFichaCfg] = useState<{ campos: any[]; etiquetas: any[] } | null>(null);
  const [novoCampoCatalogo, setNovoCampoCatalogo] = useState("");
  const [novaEtiquetaCatalogo, setNovaEtiquetaCatalogo] = useState("");
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [fichaAberta, setFichaAberta] = useState(false);
  // FRENTE O — a tela de conversa: kit de acoes e historicos.
  // As abas de historico moram na MESMA gaveta da ficha (nao numa quinta
  // coluna): a ficha ja e o lugar de "tudo sobre esta conversa", ja tem o
  // fechamento e o scroll, e abrir um painel novo por historico deixaria a
  // conversa com 4 colunas em tela de notebook.
  // FRENTE Y: "memoria" entra na MESMA gaveta (costura declarada pela frente V).
  // A memoria da conversa e "tudo sobre esta conversa" tanto quanto a ficha e os
  // historicos; painel novo por dado seria a quinta coluna que a frente O ja
  // recusou.
  const [abaFicha, setAbaFicha] = useState<
    "dados" | "notas" | "status" | "avaliacoes" | "midia" | "transferencias" | "memoria"
  >("dados");
  // ─── FRENTE Y: MEMORIA DA CONVERSA (costura da frente V, card 86ak859vt) ────
  // `null` = ainda nao carregou. `pode_editar` vem do SERVIDOR (regra da casa: a
  // tela reflete, nao adivinha) — sem ele a tela ofereceria um campo que devolve
  // 403. `aviso` guarda a frase do 503 (migration 0016 pendente, grant, rede):
  // lista vazia calada AFIRMARIA que a conversa nao tem memoria, e essa afirmacao
  // a tela nao pode fazer quando a verdade e "nao deu pra ler".
  const [memoria, setMemoria] = useState<{
    pares: ParContexto[];
    pode_editar: boolean;
    aviso: string | null;
  } | null>(null);
  const [memChave, setMemChave] = useState("");
  const [memValor, setMemValor] = useState("");
  const [memSalvando, setMemSalvando] = useState(false);
  // FRENTE Y (revisao 1): apagar variavel e destrutivo e nao tem desfazer —
  // a automacao le exatamente isto. Dois passos, como as outras destrutivas.
  const [memApagar, setMemApagar] = useState<string | null>(null);
  const [memErro, setMemErro] = useState<string | null>(null);
  // busca DENTRO da conversa (nao confundir com a busca global da barra lateral)
  const [buscaConversa, setBuscaConversa] = useState<string | null>(null);
  const [achadosConversa, setAchadosConversa] = useState<AchadoConversa[] | null>(null);
  const [buscandoConversa, setBuscandoConversa] = useState(false);
  const [avisoBuscaConversa, setAvisoBuscaConversa] = useState<string | null>(null);
  // robo por conversa
  const [robo, setRobo] = useState<EstadoRobo | null>(null);
  // mapa `id da mensagem -> fluxo que a produziu`, da trilha da Frente P. null =
  // nao carregou (ou nao ha permissao): sem selo, sem aviso — e METADADO.
  const [vincFluxo, setVincFluxo] = useState<Record<string, VinculoFluxo> | null>(null);
  // historicos (carregados por demanda, quando a aba abre)
  const [histStatus, setHistStatus] = useState<{
    linhas: LinhaStatus[];
    resumo: ResumoStatus[];
    resumo_parcial?: boolean;
    truncado?: boolean;
    aviso?: string;
  } | null>(null);
  const [histTransf, setHistTransf] = useState<{
    linhas: LinhaTransferencia[];
    truncado?: boolean;
    aviso?: string;
  } | null>(null);
  const [histAval, setHistAval] = useState<HistAvaliacoes | null>(null);
  const [histMidia, setHistMidia] = useState<HistMidia | null>(null);
  const [abaMidia, setAbaMidia] = useState<AbaMidia>("media");
  // iniciar conversa nova
  const [novaConversaAberta, setNovaConversaAberta] = useState(false);
  // por qual NUMERO a conversa sai. Comeca no canal em foco, mas e escolhivel:
  // numa instalacao multi-numero, "sai pelo que estava aberto" e a receita pra
  // abordar um cliente pelo numero errado.
  const [novoCanal, setNovoCanal] = useState<string | null>(null);
  const [novoNumero, setNovoNumero] = useState("");
  const [novoNome, setNovoNome] = useState("");
  const [novoTexto, setNovoTexto] = useState("");
  const [novoConfirmado, setNovoConfirmado] = useState(false);
  const [iniciando, setIniciando] = useState(false);
  const [erroNova, setErroNova] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputArquivo = useRef<HTMLInputElement>(null);
  const gravadorRef = useRef<MediaRecorder | null>(null);
  const activeRef = useRef<Chat | null>(null);
  activeRef.current = active;

  const scrollDown = () =>
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 60);

  const authedFetch = useCallback((url: string, init?: RequestInit) => {
    const token = sessionRef.current?.access_token;
    // deslogado no meio de um poll: nao bater na API so pra colecionar 401
    if (!token) return Promise.reject(new Error("sem sessao"));
    return fetch(url, {
      ...init,
      cache: "no-store",
      headers: {
        ...(init?.headers || {}),
        Authorization: `Bearer ${token}`,
        // contexto selado que o servidor intersecta com o escopo normal: no
        // embed vem da URL (manda); na tela cheia, da visao que o usuario escolheu
        ...(ctxToken
          ? { "x-embed-token": ctxToken }
          : visaoRef.current
            ? { "x-embed-token": visaoRef.current.token }
            : {}),
      },
    });
  }, [ctxToken]);

  const loadChats = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      // lista UNICA multi-canal: busca todos os canais conhecidos em paralelo e
      // junta (lib/canais-front.ts). Antes da 1a resposta so o central e
      // conhecido; a resposta traz o registro `canais` e o recarregamento
      // imediato abaixo ja cobre os demais.
      const ids = canaisParaCarregar(canaisRef.current, embed);
      const respostas = await Promise.all(ids.map((id) => authedFetch(`/api/chats?canal=${id}`)));
      // token da visao venceu ou o contexto saiu do ar NO MEIO da sessao
      // (aba de plantao aberta > 12h): re-cunha em silencio; se nao der,
      // cai pra "Todas" com aviso — sem isso o poll congela em 401 pra sempre
      if (respostas.some((r) => r.status === 401) && !ctxToken && visaoRef.current) {
        const ctx = visaoRef.current.contexto;
        visaoRef.current = null;
        let renovada: Visao | null = null;
        try {
          const m = await authedFetch("/api/embed/token-proprio", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contexto: ctx }),
          });
          const t = await m.json();
          if (m.ok && t.token) renovada = { contexto: ctx, token: t.token, expira_em: t.expira_em };
        } catch {}
        visaoRef.current = renovada;
        setVisao(renovada);
        try {
          if (renovada) localStorage.setItem(VISAO_STORAGE_KEY, JSON.stringify(renovada));
          else localStorage.removeItem(VISAO_STORAGE_KEY);
        } catch {}
        if (!renovada) setAviso("A visao selecionada foi desativada — mostrando todas as conversas.");
        setTimeout(loadChats, 0);
        return;
      }
      // ─── FRENTE Q (31/08/2026), toque 3 de 3 da leva de SEGURANCA em app/home.tsx ───
      // A politica de acesso (janela de horario, dispositivo revogado, escopo da
      // chave) barra no SERVIDOR e responde 403 com `sem_acesso: true` e o
      // motivo em `error`. Sem estas linhas o painel abria VAZIO, sem dizer
      // nada — a pessoa fora do horario via uma lista sem conversa nenhuma e
      // concluia que o sistema quebrou.
      const bloqueada = respostas.find((r) => r.status === 403 || r.status === 401);
      if (bloqueada) {
        const j = await bloqueada.json().catch(() => null);
        // so avisa quando a MENSAGEM MUDOU: o poll roda a cada 3-6s e reabrir o
        // mesmo aviso deixava o usuario sem conseguir fecha-lo. Fechar e a
        // mesma causa continuar = fica fechado; causa NOVA volta a avisar.
        if (j?.sem_acesso && j?.error && ultimoBloqueio.current !== j.error) {
          ultimoBloqueio.current = j.error;
          setAviso(j.error);
        }
      } else {
        ultimoBloqueio.current = null;
      }
      const corpos: any[] = await Promise.all(respostas.map((r) => (r.ok ? r.json().catch(() => null) : null)));
      if (seq !== loadSeq.current) return; // ja saiu um poll mais novo
      // canal que falhou nesta rodada mantem o que ja estava na tela (um 500
      // passageiro de um canal nao apaga a lista dele)
      setChats((prev) =>
        // a cabeca de cada canal vence; o que a pessoa puxou a mais (paginas
        // antigas, busca no acervo) sobrevive ao poll — lib/lista-conversas.ts
        manterExtras(
          juntarChats(
            ids.map((id, i) =>
              Array.isArray(corpos[i]?.chats)
                ? { canal: id, chats: corpos[i].chats as Omit<Chat, "canal" | "uid">[] }
                : { canal: id, chats: prev.filter((c) => c.canal === id) }
            )
          ),
          prev,
          extrasRef.current
        )
      );
      // "tem mais antigas" por canal: so quando a resposta desse canal chegou
      setTemMaisAntigas((prev) => {
        const prox = { ...prev };
        ids.forEach((id, i) => {
          if (corpos[i] && typeof corpos[i].tem_mais === "boolean" && !(id in prox)) prox[id] = corpos[i].tem_mais;
        });
        return prox;
      });
      const meta = corpos.find((j) => j && Array.isArray(j.canais)) || corpos.find(Boolean);
      if (meta && typeof meta.auto_logout_minutos === "number") autoLogoutMinRef.current = meta.auto_logout_minutos;
      // fuso da instalacao: passa a valer pra toda hora exibida daqui pra frente
      if (meta) definirFusoUi(meta.fuso);
      if (meta && Array.isArray(meta.canais)) {
        const novos = meta.canais as CanalPublico[];
        const antes = canaisRef.current.map((c) => c.id).join(",");
        canaisRef.current = novos;
        setCanais(novos);
        // filtro apontando pra canal que saiu do registro volta pra "todos"
        setFiltroCanal((f) => (f && !novos.some((c) => c.id === f) ? "" : f));
        // descobriu canal novo (1a carga, ou canal ligado no servidor): recarrega
        // ja, senao a lista fica 6s so com o que esta rodada buscou
        const proximos = canaisParaCarregar(novos, embed).join(",");
        if (novos.map((c) => c.id).join(",") !== antes && proximos !== ids.join(",")) setTimeout(loadChats, 0);
      }
    } catch {}
  }, [authedFetch, ctxToken, embed]);

  // BUSCA NO ACERVO (03/09/2026): texto na caixa da lista vai ao servidor (debounce
  // de 350ms) e varre o canal INTEIRO por nome ou numero — nao so as 600 do poll.
  // O que voltar entra na lista como extra (sobrevive ao poll) e passa pelo mesmo
  // filtro local `conversaBateBusca`, entao a tela nunca mostra o que nao bate.
  // Enter continua sendo a busca nas MENSAGENS (/api/busca), que e outra coisa.
  useEffect(() => {
    const criterios = criteriosDeBusca(filter);
    if (!criterios) {
      setBuscandoAcervo(false);
      return;
    }
    const seq = ++buscaAcervoSeq.current;
    setBuscandoAcervo(true);
    const timer = setTimeout(async () => {
      try {
        const ids = filtroCanal ? [filtroCanal] : canaisParaCarregar(canaisRef.current, embed);
        const respostas = await Promise.all(
          ids.map((id) => authedFetch(`/api/chats?canal=${id}&q=${encodeURIComponent(filter)}`))
        );
        const corpos: any[] = await Promise.all(respostas.map((r) => (r.ok ? r.json().catch(() => null) : null)));
        if (seq !== buscaAcervoSeq.current) return; // a pessoa continuou digitando
        const achados = juntarChats(
          ids.map((id, i) => ({
            canal: id,
            chats: (Array.isArray(corpos[i]?.chats) ? corpos[i].chats : []) as Omit<Chat, "canal" | "uid">[],
          }))
        ) as Chat[];
        for (const c of achados) extrasRef.current.add(c.uid);
        if (achados.length) setChats((prev) => adicionarExtras(prev, achados));
      } catch {
        // busca no acervo e complemento: falhar nela nao pode derrubar a lista
      } finally {
        if (seq === buscaAcervoSeq.current) setBuscandoAcervo(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [filter, filtroCanal, embed, authedFetch]);

  // seletor de visao: aplica (estado + ref + localStorage) e recarrega a lista
  const aplicarVisao = useCallback((v: Visao | null) => {
    visaoRef.current = v;
    setVisao(v);
    try {
      if (v) localStorage.setItem(VISAO_STORAGE_KEY, JSON.stringify(v));
      else localStorage.removeItem(VISAO_STORAGE_KEY);
    } catch {}
  }, []);

  const trocarVisao = useCallback(async (contexto: string | null) => {
    if (!contexto) {
      aplicarVisao(null);
      setTimeout(loadChats, 0);
      return;
    }
    try {
      const r = await authedFetch("/api/embed/token-proprio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contexto }),
      });
      const j = await r.json();
      if (!r.ok || !j.token) throw new Error(j.error || "falha ao trocar visao");
      aplicarVisao({ contexto, token: j.token, expira_em: j.expira_em });
      setTimeout(loadChats, 0);
    } catch {
      aplicarVisao(null);
      setAviso("Nao deu pra ativar essa visao agora.");
      setTimeout(loadChats, 0);
    }
  }, [authedFetch, aplicarVisao, loadChats]);

  // carrega as visoes disponiveis e restaura a escolhida (re-cunha se venceu)
  useEffect(() => {
    if (!session || embed) return;
    // parte SINCRONA primeiro: a visao salva entra no ref ANTES do efeito de
    // polling disparar o primeiro loadChats (efeitos rodam na ordem; sem isso a
    // 1a lista do login sai sem o recorte — achado da revisao adversarial)
    let salvoOk: Visao | null = null;
    try {
      const salvo = localStorage.getItem(VISAO_STORAGE_KEY);
      if (salvo) salvoOk = JSON.parse(salvo) as Visao;
      if (salvoOk && (!salvoOk.contexto || !salvoOk.token)) salvoOk = null;
    } catch {
      // JSON corrompido: limpa pra nao repetir o erro em todo load
      try { localStorage.removeItem(VISAO_STORAGE_KEY); } catch {}
    }
    if (salvoOk && new Date(salvoOk.expira_em).getTime() - Date.now() > 60_000) {
      visaoRef.current = salvoOk;
      setVisao(salvoOk);
    }
    (async () => {
      try {
        const r = await authedFetch("/api/embed/contextos");
        const j = await r.json();
        const lista = j?.habilitado && Array.isArray(j.contextos) ? j.contextos : [];
        setVisoes(lista);
        setVisaoVinculada(!!j?.vinculado);
        if (!lista.length) { aplicarVisao(null); return; }
        if (!salvoOk) return;
        if (!lista.some((c: { id: string }) => c.id === salvoOk.contexto)) { aplicarVisao(null); setTimeout(loadChats, 0); return; }
        if (new Date(salvoOk.expira_em).getTime() - Date.now() <= 60_000) {
          trocarVisao(salvoOk.contexto); // venceu: re-cunha em silencio
        }
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, embed]);

  // catalogo de BUs pro select de Visibilidade (ficha + selecao em massa): so
  // busca se o super admin nao tem o seletor de visao ligado (visoes vazio) —
  // e so 1 vez, o resultado fica em cache no proprio state
  useEffect(() => {
    if (perfil?.papel !== "super_admin" || visoes.length || visBuFallback !== null) return;
    authedFetch("/api/embed/contextos")
      .then((r) => r.json())
      .then((j) => setVisBuFallback(Array.isArray(j?.contextos) ? j.contextos : []))
      .catch(() => setVisBuFallback([]));
  }, [perfil, visoes, visBuFallback, authedFetch]);

  const loadMsgs = useCallback(async (chat: Chat) => {
    try {
      const r = await authedFetch(`/api/messages?chat_id=${encodeURIComponent(chat.chat_id)}&canal=${chat.canal}`);
      // conversa fora do escopo do usuario (ex: deep link): fecha em vez de pollar 403 pra sempre
      if (r.status === 403 && activeRef.current?.uid === chat.uid) {
        setActive(null);
        setAviso("Essa conversa esta fora do seu escopo de atendimento.");
        return;
      }
      const j = await r.json();
      if (j.messages && activeRef.current?.uid === chat.uid) {
        setMsgs((prev) => {
          if (prev.length !== j.messages.length) scrollDown();
          return j.messages;
        });
        if (j.foto_url) {
          setActive((a) =>
            a && a.uid === chat.uid && a.profile_thumbnail !== j.foto_url
              ? { ...a, profile_thumbnail: j.foto_url } : a
          );
          setChats((cs) =>
            cs.map((c) => (c.uid === chat.uid ? { ...c, profile_thumbnail: j.foto_url } : c))
          );
        }
        setTemp((t) =>
          t.filter((tm) => !j.messages.some((m: Msg) => m.from_me && msgText(m) === tm.content))
        );
        // janela de 24h (so vem no canal apioficial)
        setJanela(j.janela ?? null);
      }
    } catch {}
  }, [authedFetch]);

  useEffect(() => {
    if (!session) return;
    loadChats();
    authedFetch("/api/users")
      .then((r) => r.json())
      .then((j) => {
        if (j.users) setUsers(j.users);
        if (j.departamentos) setDepartamentos(j.departamentos);
      })
      .catch(() => {});
    authedFetch("/api/etiquetas")
      .then((r) => r.json())
      .then((j) => Array.isArray(j.etiquetas) && setCatalogoEtiquetas(j.etiquetas))
      .catch(() => {});
    // FRENTE Y (revisao 2) — AQUI NAO SE CARREGA RESPOSTA RAPIDA. A carga da
    // MONTAGEM era a GRAVE 1 por uma terceira porta: ela pedia a lista CRUA (sem
    // chat_id/canal) e escrevia no estado do COMPOSER, que so e lido com conversa
    // aberta (`respostasDoAtalho`, no clique e no Enter do atalho). Nao havia
    // sequenciamento nenhum — nada como o `loadSeq` do `loadChats` — entao com a
    // rota fria (1-3s no primeiro acesso) e o atendente abrindo uma conversa em
    // 800ms, a resposta COM conversa voltava primeiro e a da montagem chegava
    // depois, sobrescrevendo o resolvido pelo cru: o `/boas` seguinte mandava
    // `!nome` LITERAL pro cliente. A lista do composer nasce com a CONVERSA
    // (`abrirChat`), que e o unico momento em que ela tem significado; a do
    // cadastro tem estado e carga proprios (`rrCadastro`).
    // FRENTE S — a FILA DE ATENDIMENTO carrega UMA VEZ por sessao aberta, nao no
    // poll de 6s. A situacao da pessoa na fila so muda quando ELA clica (ou
    // quando o rodizio consome o pulo dela), e uma consulta a cada 6s por
    // atendente pagaria um SELECT eterno pra pintar algo que quase nunca muda —
    // o mesmo critério que manteve a trilha de fluxo fora do poll (Frente O).
    carregarFila();
    const t = setInterval(loadChats, 6000);
    // ...e reconfere a cada 60s (correcao da 2a revisao). Carregar SO na abertura
    // deixava a faixa de "distribuicao parada" invisivel pra quem ja estava com a
    // aba aberta — justamente o plantao que precisa saber. 60s (nao 6s) porque o
    // que se quer alcancar aqui e uma indisponibilidade, que dura minutos: e 1
    // request por minuto por atendente, nao 10.
    const tf = setInterval(carregarFila, 60_000);
    return () => { clearInterval(t); clearInterval(tf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadChats, session, authedFetch]);

  // FRENTE S — limpeza do gravador de audio. Sair da pagina (ou trocar de
  // conversa) com uma previa pendente vazaria o `blob:` e, pior, deixaria o
  // relogio da gravacao rodando pra sempre.
  useEffect(() => {
    return () => {
      if (relogioGrav.current) clearInterval(relogioGrav.current);
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, []);

  // estado do 2FA carrega sempre que a aba Minha conta abre (qualquer caminho)
  useEffect(() => {
    if (configAberta && abaConfig === "conta") { carregarMfa(); carregarMinhasChaves(); }
    // FRENTE Y (revisao 1): a aba de cadastro carrega a SUA lista, nunca a do composer
    if (configAberta && abaConfig === "respostas") carregarCadastroRespostas();
    // tela "Instalar widget" (02/09/2026): le origens liberadas, contextos e se a cunhagem existe
    if (configAberta && abaConfig === "instalar") carregarInstalacao();
    // modal fechou (por qualquer caminho): apaga o plaintext da chave da memoria
    if (!configAberta) limparEstadoChave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configAberta, abaConfig]);

  // 2FA: quem tem fator cai na tela do codigo; sem fator com exigencia ligada
  // cai no cadastro forcado. Sessao ja em aal2 passa direto.
  useEffect(() => {
    if (!session) {
      setMfaPendente(false);
      setMfaCadastro(false);
      return;
    }
    (async () => {
      try {
        const [{ data: aal }, pol] = (await Promise.all([
          authClient.auth.mfa.getAuthenticatorAssuranceLevel(),
          authedFetch("/api/politica").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
        ])) as [Awaited<ReturnType<typeof authClient.auth.mfa.getAuthenticatorAssuranceLevel>>, { exigir_2fa?: boolean; tem_fator?: boolean }];
        if (aal?.currentLevel === "aal2") {
          setMfaPendente(false);
          setMfaCadastro(false);
          return;
        }
        if (pol?.tem_fator || aal?.nextLevel === "aal2") setMfaPendente(true);
        else if (pol?.exigir_2fa) setMfaCadastro(true);
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // mensagens agendadas da conversa aberta
  useEffect(() => {
    setAgendadas([]);
    setAgendarAberto(false);
    if (active?.chat_id) carregarAgendadas(active.chat_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.chat_id, canal]);

  // desliga sozinho depois de X minutos sem uso (X definido pelo admin);
  // embutido no widget quem governa a sessao e o hospedeiro, entao NAO desliga sozinho
  useEffect(() => {
    if (!session || embed) return;
    const marcar = () => { ultimaAtividadeRef.current = Date.now(); };
    const eventos: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "wheel", "touchstart", "mousemove"];
    eventos.forEach((e) => window.addEventListener(e, marcar, { passive: true }));
    const relogio = setInterval(() => {
      const min = autoLogoutMinRef.current;
      if (!min) return;
      if (Date.now() - ultimaAtividadeRef.current >= min * 60_000) {
        authClient.auth.signOut();
      }
    }, 15_000);
    return () => {
      eventos.forEach((e) => window.removeEventListener(e, marcar));
      clearInterval(relogio);
    };
  }, [session, embed]);

  // preferencia de aviso sempre fresca pro poll do sininho
  useEffect(() => {
    prefsRef.current = perfil?.preferencias || PREFERENCIAS_PADRAO;
  }, [perfil?.preferencias]);

  // perfil (papel/escopo/tema) + tema aplicado na raiz
  useEffect(() => {
    if (!session) return;
    authedFetch("/api/perfil")
      .then((r) => r.json())
      .then((p) => {
        if (p?.id) {
          setPerfil(p);
          setAssinaturaNome(p.assinatura_nome || "");
          document.documentElement.classList.toggle("dark", p.tema === "escuro");
          // as paginas irmas (/fluxos, /disparo, /biblioteca, /campos) nao carregam o perfil:
          // o tema fica em localStorage e o layout raiz aplica antes da 1a pintura
          try { localStorage.setItem("tema", p.tema === "escuro" ? "escuro" : "claro"); } catch { /* storage bloqueado */ }
        }
      })
      .catch(() => {});
  }, [session, authedFetch]);

  // sininho: poll das notificacoes; chegou nao lida NOVA = avisa.
  // COMO avisa e preferencia do usuario (Meu perfil): som liga/desliga o bip e
  // desktop liga o aviso do navegador (so com a aba em segundo plano — com a
  // aba na frente o sininho ja esta visivel). Sem preferencia gravada valem os
  // defaults (som ligado, desktop desligado), que e como o painel sempre foi.
  useEffect(() => {
    if (!session) return;
    const buscar = async () => {
      try {
        const r = await authedFetch("/api/notificacoes");
        const j = await r.json();
        if (!Array.isArray(j.nao_lidas)) return;
        const todas: Notif[] = [...j.nao_lidas, ...(j.lidas || [])];
        setNotifs(todas);
        const qtd = j.nao_lidas.length;
        if (naoLidasAntes.current >= 0 && qtd > naoLidasAntes.current) {
          const prefs = prefsRef.current;
          if (prefs.som) apitar();
          if (prefs.desktop) avisarNaAreaDeTrabalho(j.nao_lidas[0]);
        }
        naoLidasAntes.current = qtd;
      } catch {}
    };
    buscar();
    const t = setInterval(buscar, 8000);
    return () => clearInterval(t);
  }, [session, authedFetch]);

  async function trocarTema(tema: "claro" | "escuro") {
    setPerfil((p) => (p ? { ...p, tema } : p));
    document.documentElement.classList.toggle("dark", tema === "escuro");
    try { localStorage.setItem("tema", tema); } catch { /* storage bloqueado */ }
    await authedFetch("/api/perfil", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tema }),
    }).catch(() => {});
  }

  // Foto de quem ENVIOU a mensagem (trilha de auditoria mensagens.enviado_por_id).
  // Sem id (mensagem antiga ou envio fora do painel) ou sem foto = iniciais.
  function fotoDoAtendente(id?: string | null): string | null {
    if (!id) return null;
    if (id === perfil?.id) return perfil?.foto_url || null;
    return users.find((u) => u.id === id)?.foto_url || null;
  }

  // Abre a tela "Meu perfil" sempre limpa: senha digitada, recado de erro e
  // chave de API nao podem sobrar visiveis de uma abertura pra outra.
  function abrirMeuPerfil() {
    setMenuPerfil(false);
    setConfigAberta(true);
    setAbaConfig("conta");
    setSenhaAtual("");
    setNovaSenha("");
    setConfirmaSenha("");
    setSenhaOk(false);
    setSenhaMsg(null);
    setFotoMsg(null);
    setPrefMsg(null);
    setAssinaturaNome(perfil?.assinatura_nome || "");
    setMfaMsg(null);
    limparEstadoChave();
    carregarMfa();
  }

  // Troca de senha pela rota do painel: o servidor confere a senha ATUAL antes
  // de gravar (fail-closed). A conferencia local aqui e so pra dar erro na hora
  // — quem decide e o servidor.
  async function trocarSenha() {
    setSenhaOk(false);
    if (!senhaAtual) return setSenhaMsg("Informe a senha atual.");
    if (novaSenha.length < 8) return setSenhaMsg("A nova senha precisa de pelo menos 8 caracteres.");
    if (novaSenha === senhaAtual) return setSenhaMsg("A nova senha precisa ser diferente da atual.");
    if (novaSenha !== confirmaSenha) return setSenhaMsg("A confirmacao nao bate com a nova senha.");
    setSalvandoSenha(true);
    setSenhaMsg(null);
    try {
      const r = await authedFetch("/api/perfil/senha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senha_atual: senhaAtual, senha_nova: novaSenha }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setSenhaMsg(j.error || "Nao consegui trocar a senha. Tente de novo.");
        return;
      }
      setSenhaAtual("");
      setNovaSenha("");
      setConfirmaSenha("");
      setSenhaOk(true);
      setSenhaMsg("Senha alterada. Vale pra todos os apps que usam este mesmo login.");
    } catch {
      setSenhaMsg("Nao consegui falar com o servidor. Tente de novo.");
    } finally {
      setSalvandoSenha(false);
    }
  }

  // Foto do atendente: sobe pro painel e passa a aparecer onde o painel mostra
  // quem atende (rodape, lista de pessoas, autoria da mensagem).
  async function enviarFoto(arquivo: File) {
    setFotoMsg(null);
    if (arquivo.size > 2 * 1024 * 1024) {
      setFotoMsg("A imagem precisa ter no maximo 2 MB.");
      return;
    }
    setEnviandoFoto(true);
    try {
      const form = new FormData();
      form.append("arquivo", arquivo);
      const r = await authedFetch("/api/perfil/foto", { method: "POST", body: form });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setFotoMsg(j.error || "Nao consegui salvar a foto.");
        return;
      }
      setPerfil((p) => (p ? { ...p, foto_url: j.foto_url } : p));
      setFotoMsg("Foto atualizada.");
      recarregarUsuarios();
    } catch {
      setFotoMsg("Nao consegui falar com o servidor. Tente de novo.");
    } finally {
      setEnviandoFoto(false);
      if (inputFoto.current) inputFoto.current.value = "";
    }
  }

  async function removerFoto() {
    setFotoMsg(null);
    setEnviandoFoto(true);
    try {
      const r = await authedFetch("/api/perfil/foto", { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setFotoMsg(j.error || "Nao consegui remover a foto.");
        return;
      }
      setPerfil((p) => (p ? { ...p, foto_url: null } : p));
      setFotoMsg("Foto removida — voltou a mostrar suas iniciais.");
      recarregarUsuarios();
    } catch {
      setFotoMsg("Nao consegui falar com o servidor. Tente de novo.");
    } finally {
      setEnviandoFoto(false);
    }
  }

  // recarrega o cadastro de pessoas pra foto nova aparecer nos outros lugares
  // sem precisar recarregar a pagina
  function recarregarUsuarios() {
    authedFetch("/api/users")
      .then((r) => r.json())
      .then((j) => { if (j.users) setUsers(j.users); })
      .catch(() => {});
  }

  // Preferencia de aviso. O aviso de desktop depende de permissao do NAVEGADOR:
  // pedimos a permissao antes de gravar, e se a pessoa negar nao gravamos
  // "ligado" (interruptor ligado sem permissao seria mentira na tela).
  async function trocarPreferencia(chave: keyof Preferencias, valor: boolean) {
    setPrefMsg(null);
    if (chave === "desktop" && valor) {
      if (typeof Notification === "undefined") {
        setPrefMsg("Este navegador nao mostra aviso de area de trabalho.");
        return;
      }
      let permissao = Notification.permission;
      if (permissao === "default") permissao = await Notification.requestPermission().catch(() => "denied" as NotificationPermission);
      if (permissao !== "granted") {
        setPrefMsg("O navegador nao autorizou o aviso. Libere a notificacao deste site e tente de novo.");
        return;
      }
    }
    const anterior = perfil?.preferencias || PREFERENCIAS_PADRAO;
    const novo = { ...anterior, [chave]: valor };
    setPerfil((p) => (p ? { ...p, preferencias: novo } : p));
    const r = await authedFetch("/api/perfil", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferencias: { [chave]: valor } }),
    }).catch(() => null);
    if (!r || !r.ok) {
      // nao consegui gravar: volta o interruptor pro que o servidor tem
      setPerfil((p) => (p ? { ...p, preferencias: anterior } : p));
      const j = r ? await r.json().catch(() => ({})) : {};
      setPrefMsg((j as any).error || "Nao consegui salvar a preferencia.");
    }
  }

  // Assinatura nas mensagens: autoatendimento (o super admin tambem mexe nisso
  // na aba Usuarios, mas ninguem precisa dele pra ligar a propria).
  async function trocarAssinatura(patch: { assinatura_ativa?: boolean; assinatura_nome?: string }) {
    setPrefMsg(null);
    const anterior = { assinatura_ativa: perfil?.assinatura_ativa, assinatura_nome: perfil?.assinatura_nome };
    setPerfil((p) => (p ? { ...p, ...patch } : p));
    const r = await authedFetch("/api/perfil", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => null);
    if (!r || !r.ok) {
      setPerfil((p) => (p ? { ...p, ...anterior } : p));
      const j = r ? await r.json().catch(() => ({})) : {};
      setPrefMsg((j as any).error || "Nao consegui salvar a assinatura.");
    }
  }

  // catalogo de papeis nomeados; papeisOn=false quando a migration 0010 nao rodou
  const [adminPapeis, setAdminPapeis] = useState<AdminPapel[]>([]);
  const [papeisOn, setPapeisOn] = useState(false);

  async function carregarAdmin() {
    try {
      const [ru, rd, rc, rf, rw] = await Promise.all([
        authedFetch("/api/admin/usuarios"),
        authedFetch("/api/admin/departamentos"),
        authedFetch("/api/admin/config"),
        authedFetch("/api/admin/ficha-config"),
        authedFetch("/api/admin/webhooks-saida"),
      ]);
      const ju = await ru.json();
      const jd = await rd.json();
      const jc = await rc.json();
      const jf = await rf.json();
      const jw = await rw.json().catch(() => ({}));
      if (ju.usuarios) setAdminUsuarios(ju.usuarios);
      setPapeisOn(ju.papeis_disponiveis === true);
      if (Array.isArray(ju.papeis)) setAdminPapeis(ju.papeis);
      if (jd.departamentos) setAdminDeps(jd.departamentos);
      if (typeof jc.auto_arquivar_concluida === "boolean") setCfgAuto(jc);
      if (jf.campos) setFichaCfg(jf);
      // destinos do webhook de saida: o segredo NUNCA vem no GET (so o flag
      // segredo_definido), entao a tela nunca tem o valor pra vazar
      if (Array.isArray(jw?.destinos)) setWebhooks(jw.destinos);
      // catalogo de BUs pro checkbox "BUs visiveis" do popup de usuario: reusa
      // a lista ja carregada pro proprio seletor de visao; se o admin nao tem
      // o seletor ligado pra si mesmo (visoes vazio), busca direto
      if (!visoes.length) {
        authedFetch("/api/embed/contextos")
          .then((r) => r.json())
          .then((j) => Array.isArray(j?.contextos) && setVisoes(j.contextos))
          .catch(() => {});
      }
    } catch {}
  }

  async function salvarCatalogo(payload: { tipo: "campo" | "etiqueta"; id?: string; nome?: string; ativo?: boolean }) {
    const r = await authedFetch("/api/admin/ficha-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) setAviso((await r.json().catch(() => ({}))).error || "Falha ao salvar catalogo");
    setNovoCampoCatalogo("");
    setNovaEtiquetaCatalogo("");
    carregarAdmin();
    // atualiza o seletor da ficha na hora
    authedFetch("/api/etiquetas").then((r2) => r2.json())
      .then((j) => Array.isArray(j.etiquetas) && setCatalogoEtiquetas(j.etiquetas)).catch(() => {});
    if (active) carregarFicha(active.chat_id);
  }

  async function buscarMensagens() {
    const q = filter.trim();
    if (q.length < 3) {
      setAviso("Busca nas mensagens: use pelo menos 3 letras.");
      return;
    }
    setBuscando(true);
    setBuscaResultados([]);
    try {
      // varre os canais em foco: o filtrado, ou todos os conhecidos (1 request por canal)
      const ids = filtroCanal ? [filtroCanal] : canaisParaCarregar(canaisRef.current, embed);
      const rs = await Promise.all(ids.map((id) => authedFetch(`/api/busca?q=${encodeURIComponent(q)}&canal=${id}`)));
      const js: any[] = await Promise.all(rs.map((r) => r.json().catch(() => ({}))));
      const iErro = rs.findIndex((r) => !r.ok);
      if (iErro >= 0) setAviso(js[iErro]?.error || "Falha na busca");
      const achados = ids.flatMap((id, i) =>
        rs[i].ok ? ((js[i]?.resultados || []) as any[]).map((x) => ({ ...x, canal: id })) : []
      );
      achados.sort((a, b) => (b.quando || "").localeCompare(a.quando || ""));
      setBuscaResultados(achados);
    } catch {
      setAviso("Falha na busca");
    }
    setBuscando(false);
  }

  // Clique num numero da matriz do painel operacional: volta pra lista de
  // conversas com o MESMO recorte da celula. Reusa os filtros que o painel ja
  // tem (status + responsavel, que casa por id contra conversa_responsaveis e
  // aceita "none" pra sem-dono) em vez de inventar uma segunda listagem.
  function filtrarConversasDoRelatorio(alvo: AlvoConversas) {
    setVisaoPainel("conversas");
    // ARQUIVADAS vem no alvo: a matriz e contada com ou sem arquivadas conforme
    // a caixa da tela de relatorio, e a lista tem o botao Arquivados dela. Fixar
    // `false` aqui fazia o numero contado COM arquivadas abrir uma lista SEM
    // elas — 12 no relatorio, 4 na lista, e o gestor deixa de confiar nos dois.
    setVerArquivadas(alvo.arquivadas);
    setBuscaResultados(null);
    setFilter("");
    if (alvo.canal && canais.some((c) => c.id === alvo.canal)) setFiltroCanal(alvo.canal);
    setFiltroStatus(alvo.status || "");
    setFiltroResps(alvo.resp ? [alvo.resp] : []);
    // "sem dono" do relatorio = ausencia na N:N (a definicao da matriz), sem
    // exigir o espelho legado `responsavel_id` nulo
    setFiltroRespNnPura(alvo.resp === "none");
    setFiltroLida("");
    setFiltroTipo("");
  }

  /**
   * FRENTE Y — VARIAVEL EM RESPOSTA RAPIDA (costura da frente T, card 86ak86jw9).
   *
   * A rota substitui `!nome`, `!telefone`, `!campo.<x>`, `$variavel` e as irmas
   * QUANDO recebe `canal` + `chat_id` — e devolve o resultado em
   * `texto_resolvido`. Sem passar a conversa, ela responde a lista CRUA (que e o
   * certo pra tela de CADASTRO: la o atendente tem que ver o template).
   *
   * Por isso esta funcao recebe a conversa e e chamada DE NOVO ao abrir cada
   * conversa: o valor resolvido e de UMA conversa, e reaproveitar o de outra
   * mandaria o nome do cliente errado pro cliente certo.
   *
   * `conversa` e OBRIGATORIA, e isso e o portao — nao estilo. O estado que ela
   * alimenta (`respostasRapidas`) so e lido dentro do composer, que so existe com
   * conversa aberta; a versao anterior aceitava o argumento opcional e uma
   * chamada sem conversa na montagem do painel gravava a lista CRUA nesse estado,
   * fazendo o proximo `/atalho` mandar `!nome` LITERAL pro cliente. Com o
   * parametro obrigatorio, reintroduzir aquela chamada — em qualquer parafrase —
   * deixa de compilar, em vez de depender de a prova adivinhar a forma que o
   * autor escreveu. Quem precisa da lista crua e a tela de CADASTRO, e ela tem
   * funcao propria: `carregarCadastroRespostas`.
   *
   * A substituicao acontece na LEITURA, nao na gravacao (decisao da frente T):
   * resposta rapida guardada ja resolvida ficaria com o dado de UMA conversa.
   */
  async function carregarRespostasRapidas(conversa: { chat_id: string; canal: string }) {
    try {
      const url = `/api/respostas-rapidas?chat_id=${encodeURIComponent(conversa.chat_id)}&canal=${encodeURIComponent(conversa.canal)}`;
      const j = await (await authedFetch(url)).json();
      if (Array.isArray(j.respostas)) setRespostasRapidas(j.respostas);
    } catch {}
  }

  /**
   * FRENTE Y (revisao 1) — a lista do CADASTRO (Configuracoes -> Respostas).
   *
   * Funcao propria, estado proprio: aqui a lista e CRUA de proposito (mostrar
   * `Oi !nome` e o certo — e o texto que a pessoa esta editando). Escrever no
   * estado do composer a partir daqui era o GRAVE descrito em `rrCadastro`.
   */
  async function carregarCadastroRespostas() {
    try {
      const j = await (await authedFetch("/api/respostas-rapidas")).json();
      if (Array.isArray(j.respostas)) setRrCadastro(j.respostas);
    } catch {}
  }

  /**
   * FRENTE Y — A RESPOSTA RAPIDA ENTRANDO NA CAIXA (costura da frente T).
   *
   * UMA funcao pros DOIS caminhos (o clique na lista e o Enter no atalho) porque
   * eles JA tinham divergido: os dois faziam `setDraft(r.texto)` — o texto CRU,
   * com `!nome` na cara do cliente — e qualquer correcao em um so deixaria o
   * outro quebrado. O criterio do card e "substituida ANTES de aparecer na
   * caixa", e `textoParaCaixa` e quem decide (lib/tela-composer.ts).
   *
   * O AVISO SOBE PRO BANNER, nao fica so na lista: a lista FECHA no clique, e o
   * momento em que a informacao importa e o segundo seguinte — quando a pessoa
   * vai apertar enviar com "Oi , tudo bem?" na tela sem saber por que o nome
   * ficou em branco.
   */
  function aplicarRespostaRapida(r: RespostaRapida) {
    setDraft(textoParaCaixa(r));
    const av = avisoDeVariaveis(r);
    if (av) setAviso(av);
  }

  /**
   * FRENTE Y — MEMORIA DA CONVERSA (costura da frente V, card 86ak859vt).
   *
   * O 503 da rota (migration 0016 pendente, grant, rede) NAO vira painel vazio: a
   * frase vem pra tela. "Esta conversa nao tem memoria" e uma AFIRMACAO, e a tela
   * nao pode faze-la quando a verdade e "nao deu pra ler" — mesma regra que os
   * historicos da frente O ja seguem.
   *
   * Falha de REDE tambem chega como aviso (nao como painel vazio e nao como null
   * eterno): sem isso, a aba ficaria em "Carregando..." pra sempre.
   */
  async function carregarMemoria(chatId: string, canalDaConversa: string) {
    setMemErro(null);
    try {
      const r = await authedFetch(
        `/api/conversa/contexto?chat_id=${encodeURIComponent(chatId)}&canal=${encodeURIComponent(canalDaConversa)}`
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMemoria({ pares: [], pode_editar: false, aviso: j.error || "Nao deu pra ler a memoria desta conversa." });
        return;
      }
      setMemoria({ pares: paresDeContexto(j.contexto), pode_editar: j.pode_editar === true, aviso: null });
    } catch {
      setMemoria({ pares: [], pode_editar: false, aviso: "Nao deu pra ler a memoria desta conversa." });
    }
  }

  /**
   * Grava ou apaga UMA variavel da conversa.
   *
   * `limpar` e gesto SEPARADO de "gravar vazio", e a diferenca e semantica: so
   * apagando a chave o `nao_existe` das condicoes volta a valer (regra do
   * avaliador da frente L). Um botao que fizesse as duas coisas apagaria essa
   * diferenca sem ninguem perceber.
   *
   * A resposta da rota TRAZ o mapa novo, e a tela usa ELE em vez de recarregar: a
   * escrita passa pelas funcoes ATOMICAS do banco, entao o que voltou e o estado
   * real depois desta gravacao — reler abriria janela pra outra escrita entrar no
   * meio e a tela mostrar um retrato que nao e o efeito deste clique.
   */
  async function salvarMemoria(chave: string, valor: string, limpar = false) {
    if (!active || memSalvando) return;
    setMemErro(null);
    if (!limpar) {
      // A MESMA regra da rota, chamada antes do clique: o erro aparece no
      // formulario em vez de voltar como 400 depois de a pessoa escrever tudo.
      const problema = problemaDoPar(chave, valor);
      if (problema) { setMemErro(problema); return; }
    }
    setMemSalvando(true);
    try {
      const r = await authedFetch("/api/conversa/contexto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: active.chat_id,
          canal,
          chave,
          ...(limpar ? { limpar: true } : { valor }),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMemErro(j.error || "Nao deu pra gravar");
        return;
      }
      setMemoria((m) => ({
        pares: paresDeContexto(j.contexto),
        pode_editar: m?.pode_editar ?? true,
        aviso: null,
      }));
      if (!limpar) { setMemChave(""); setMemValor(""); }
    } catch {
      setMemErro("Nao deu pra gravar");
    } finally {
      setMemSalvando(false);
    }
  }

  /**
   * FRENTE Y — o CATALOGO de template do numero (costura da frente U).
   *
   * Carregado SOB DEMANDA (quando a janela de 24h fecha e o composer oferece o
   * seletor), nunca no poll: o catalogo e um espelho que so muda quando alguem
   * clica em Sincronizar na tela de numeros, e a propria frente U decidiu que
   * sincronizar e gesto explicito porque custa chamada ao provedor.
   *
   * `GET /api/canais/templates` exige a permissao `gerenciar_canais` — que um
   * ATENDENTE tipicamente nao tem. Entao o 403 nao e erro: e "voce nao pode ver o
   * catalogo", e a frase manda pedir a quem cuida dos numeros em vez de pintar
   * falha de sistema. TODO caminho ruim vira `tplAviso`, nunca faixa vermelha: a
   * conversa nao pode ficar pior por causa de um seletor auxiliar.
   */
  async function carregarTemplates(canalDaConversa: string) {
    setTplAviso(null);
    try {
      const r = await authedFetch(`/api/canais/templates?canal=${encodeURIComponent(canalDaConversa)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setTplCatalogo([]);
        setTplAviso(
          r.status === 403
            ? "Voce nao tem permissao pra ver o catalogo de templates deste numero — peca a quem cuida dos numeros."
            : j.error || "Nao deu pra ler o catalogo de templates."
        );
        return;
      }
      const lista = Array.isArray(j.templates) ? (j.templates as TemplateCanal[]) : [];
      setTplCatalogo(lista);
      // O AVISO DA ROTA VEM PRIMEIRO (0023 pendente, canal sem credencial): ele
      // explica a lista vazia. So depois vale falar de "nenhum aprovado".
      if (j.aviso) setTplAviso(String(j.aviso));
      else if (!templatesEnviaveis(lista).length) {
        setTplAviso(
          lista.length
            ? "Nenhum template deste numero esta APROVADO ainda — os que estao em analise ou recusados nao podem ser enviados."
            : "Este numero nao tem template no catalogo. Quem cuida dos numeros precisa sincronizar (tela de Numeros)."
        );
      }
    } catch {
      setTplCatalogo([]);
      setTplAviso("Nao deu pra ler o catalogo de templates.");
    }
  }

  /**
   * Envia a mensagem POR TEMPLATE — o unico caminho fora da janela de 24h.
   *
   * `template` no corpo e o contrato que a frente U cabeou em `/api/send`: a rota
   * confere que o template esta no catalogo DAQUELE canal, que o status e
   * `aprovado` e que a contagem de parametros bate EXATAMENTE (a menos a Meta
   * recusa; a mais ela ignora em silencio e a mensagem sai errada sem erro em
   * lugar nenhum). Nada disso e reimplementado aqui: `problemaDosParametros`
   * chama a MESMA `validarParametros` da rota, so pra o erro aparecer antes.
   */
  async function enviarTemplate() {
    if (!active || !tplEscolhido || sending) return;
    const problema = problemaDosParametros(tplEscolhido, tplParams);
    if (problema) { setTplAviso(problema); return; }
    setSending(true);
    try {
      const r = await authedFetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: active.chat_id,
          canal,
          template: { nome: tplEscolhido.nome, idioma: tplEscolhido.idioma, params: tplParams },
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setTplAviso(j.error || "Falha ao enviar o template");
        return;
      }
      setTplAberto(false);
      setTplEscolhido(null);
      setTplParams([]);
      setAviso("Template enviado.");
    } catch {
      setTplAviso("Falha ao enviar o template");
    } finally {
      setSending(false);
      loadMsgs(active);
    }
  }

  async function carregarAgendadas(chatId: string) {
    try {
      const j = await (await authedFetch(`/api/agendadas?chat_id=${encodeURIComponent(chatId)}&canal=${canalRef.current}`)).json();
      if (Array.isArray(j.agendadas)) setAgendadas(j.agendadas);
    } catch {}
  }

  async function agendarMensagem() {
    if (!active || !draft.trim() || !agendarQuando) return;
    // o que o atendente digitou vale como hora DA INSTALACAO. Com `new Date(...)`
    // o campo era lido no fuso do NAVEGADOR: quem estivesse em outro fuso
    // agendava pra hora errada sem nenhum aviso na tela.
    const enviarEm = isoDeLocal(agendarQuando, FUSO_UI);
    if (!enviarEm) {
      setAviso("Data/hora invalida");
      return;
    }
    const r = await authedFetch("/api/agendadas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: active.chat_id,
        canal,
        texto: draft.trim(),
        enviar_em: enviarEm,
      }),
    });
    if (!r.ok) {
      setAviso((await r.json().catch(() => ({}))).error || "Falha ao agendar");
      return;
    }
    setDraft("");
    setAgendarAberto(false);
    setAviso("Mensagem agendada.");
    carregarAgendadas(active.chat_id);
  }

  async function cancelarAgendada(id: string) {
    const r = await authedFetch(`/api/agendadas?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) setAviso((await r.json().catch(() => ({}))).error || "Falha ao cancelar");
    if (active) carregarAgendadas(active.chat_id);
  }

  // ───────────── FRENTE S: EDITAR a agendada antes de sair (card 86ak85nyj) ────
  //
  // PATCH e nao "cancela e cria de novo": entre o cancelar e o criar existe uma
  // janela em que a mensagem NAO esta agendada, e se o segundo pedido falhar o
  // atendente sai achando que so mudou o horario e o cliente nunca recebe nada.
  async function salvarAgendadaEditada() {
    if (!agendadaEdit) return;
    const texto = agendadaEdit.texto.trim();
    if (!texto) {
      setAviso("A mensagem agendada nao pode ficar vazia.");
      return;
    }
    const enviarEm = isoDeLocal(agendadaEdit.quando, FUSO_UI);
    if (!enviarEm) {
      setAviso("Data/hora invalida");
      return;
    }
    // SO O QUE MUDOU vai no corpo (correcao da revisao cega).
    //
    // Mandando os dois campos sempre, o PATCH nunca cai no ramo "nada pra mudar"
    // — a recusa existe justamente pra tela nao dizer "atualizado" quando nada
    // foi alterado, e mandar tudo transformava aquele 400 em codigo morto. De
    // quebra, editar SO o horario para de reescrever o texto (e vice-versa), o
    // que importa quando duas pessoas mexem na mesma agendada.
    const patch: { id: string; texto?: string; enviar_em?: string } = { id: agendadaEdit.id };
    if (texto !== agendadaEdit.origTexto.trim()) patch.texto = texto;
    if (agendadaEdit.quando !== agendadaEdit.origQuando) patch.enviar_em = enviarEm;
    if (patch.texto === undefined && patch.enviar_em === undefined) {
      // resolvido NA TELA: nem chega a bater na rota pra ouvir "nada pra mudar".
      setAgendadaEdit(null);
      setAviso("Nada mudou nesse agendamento.");
      return;
    }
    const r = await authedFetch("/api/agendadas", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      setAviso((await r.json().catch(() => ({}))).error || "Falha ao salvar a alteracao");
      return;
    }
    setAgendadaEdit(null);
    setAviso("Agendamento atualizado.");
    if (active) carregarAgendadas(active.chat_id);
  }

  // ────── FRENTE S: pendencias de AUTOMACAO nesta conversa (card 86ak85nyj) ───
  //
  // A fila e a aprovacao JA EXISTEM (Frente P: /api/fluxo-fila). O que faltava
  // era a SUPERFICIE onde o atendente trabalha: ele nao vai abrir a tela /fluxos
  // pra descobrir que a automacao esta esperando aval nesta conversa.
  //
  // TODO CAMINHO RUIM E SILENCIOSO, igual ao selo de fluxo da Frente O: modulo
  // desligado, 403, migration pendente, rede fora — nada disso pode piorar a
  // conversa por causa de um painel auxiliar. Some o painel, nao aparece erro.
  // "aprendeu que o modulo de automacao esta desligado" — vive a sessao inteira (ref, nao
  // state: nao redesenha nada) e e lido por carregarAutoConversa e carregarVinculoFluxo.
  const automacaoDesligadaRef = useRef(false);
  async function moduloDesligado(r: Response): Promise<boolean> {
    try {
      const j = await r.clone().json();
      return typeof j?.error === "string" && /desligad/i.test(j.error);
    } catch {
      return false;
    }
  }

  async function carregarAutoConversa(chatId: string, canalDaConversa: string) {
    // modulo de automacao DESLIGADO nesta instalacao: a 1a resposta 403 desarma as chamadas
    // seguintes da sessao (eram 2 GETs e 4 erros de console por conversa aberta — ruido
    // anotado na homologacao de 02/09/2026). O front nao conhece o estado do modulo; em vez
    // de mais uma rota, ele aprende com a primeira recusa. Recarregar a pagina reavalia.
    if (automacaoDesligadaRef.current) {
      setAutoConversa(null);
      return;
    }
    try {
      const r = await authedFetch(
        `/api/fluxo-fila?canal=${encodeURIComponent(canalDaConversa)}&chat_id=${encodeURIComponent(chatId)}`
      );
      if (!r.ok) {
        if (r.status === 403 && (await moduloDesligado(r))) automacaoDesligadaRef.current = true;
        setAutoConversa(null);
        return;
      }
      const j = await r.json();
      if (!Array.isArray(j.itens)) {
        setAutoConversa(null);
        return;
      }
      setAutoConversa({
        itens: j.itens,
        pode_aprovar: j.pode_aprovar === true,
        pode_cancelar: j.pode_cancelar === true,
        aviso: j.aviso ?? null,
      });
    } catch {
      setAutoConversa(null);
    }
  }

  /**
   * Aprovar, recusar ou cancelar um item da fila DESTA conversa.
   *
   * O botao so aparece com `pode_aprovar`/`pode_cancelar` da propria rota — a
   * tela nao adivinha permissao (regra da casa: o servidor manda, a tela
   * reflete). Erro VOLTA NA TELA, ao contrario da carga: aqui houve um clique, e
   * clique que nao fez nada em silencio e o pior desfecho possivel.
   */
  async function decidirAuto(id: string, acao: "aprovar" | "recusar" | "cancelar") {
    if (!active) return;
    const r = await authedFetch("/api/fluxo-fila", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acao, id }),
    });
    if (!r.ok) {
      setAviso((await r.json().catch(() => ({}))).error || `Falha ao ${acao}`);
    } else {
      setAviso(
        acao === "aprovar"
          ? "Aprovado — a mensagem sai na proxima rodada da fila."
          : acao === "recusar"
          ? "Recusado. A automacao para nesta conversa."
          : "Automacao cancelada nesta conversa."
      );
    }
    carregarAutoConversa(active.chat_id, canalRef.current);
    // aprovar pode fazer a mensagem sair: recarregar o historico e mais honesto
    // que deixar a tela contar so metade do que aconteceu
    loadMsgs(active);
  }

  // ─────────── FRENTE S: FILA DE ATENDIMENTO (card 86ak85nxx) ─────────────────
  //
  // A rota responde 200 com `modulo_ativo: false` quando o modulo esta desligado
  // (o normal), e ai o controle nem e desenhado. Sem esse desenho, um 403 por
  // carregamento viraria barulho no log de toda instalacao que nao ligou a fila.
  // Funcao declarada (nao useCallback) de proposito: ela e chamada de dentro do
  // efeito de abertura, que roda ANTES desta linha no arquivo — a mesma forma que
  // `carregarRespostasRapidas` e as irmas dela ja usam aqui.
  async function carregarFila() {
    try {
      const r = await authedFetch("/api/fila-atendimento");
      if (!r.ok) {
        setFila(null);
        return;
      }
      setFila(await r.json());
    } catch {
      setFila(null);
    }
  }

  async function gestoFila(acao: AcaoFila) {
    const r = await authedFetch("/api/fila-atendimento", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acao }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setAviso(j.error || "Falha ao mudar sua situacao na fila");
      return;
    }
    // GESTO INERTE tem resposta 200 com `nada_mudou` — e a tela DIZ isso. Clique
    // que "funciona" e nao muda nada e pior que botao ausente.
    if (j.nada_mudou) setAviso(j.nada_mudou);
    else if (j.eu?.frase) setAviso(j.eu.frase);
    carregarFila();
  }

  async function carregarMfa() {
    try {
      const { data } = await authClient.auth.mfa.listFactors();
      setMfaTem(!!data?.totp?.some((f) => f.status === "verified"));
    } catch {
      setMfaTem(false);
    }
  }

  // some com o plaintext e mensagens da chave — chamado ao fechar/abrir o modal
  // pra chave nunca reaparecer numa tela compartilhada depois.
  function limparEstadoChave() {
    setChaveNova(null);
    setChaveMsg(null);
    setChaveCopiada(false);
    setKeyCopiada(false);
    setChaveNome("");
    // o recorte tambem volta ao default (chave nova nasce sem recorte, que e o
    // comportamento de sempre) — senao a escolha da chave anterior vaza pra proxima
    setEscopoNova(validarEscopoChave({}));
    setPrazoNova("");
  }

  async function carregarMinhasChaves() {
    try {
      const r = await authedFetch("/api/minha-chave");
      const j = await r.json();
      if (!r.ok || !Array.isArray(j.chaves)) {
        setChaveMsg("Nao consegui carregar suas chaves — tente reabrir esta aba.");
        return; // mantem o estado anterior; NAO afirma "nenhuma chave"
      }
      setMinhasChaves(j.chaves);
      if (Array.isArray(j.recursos)) setRecursosChave(j.recursos);
      setEscopoChaveOk(j.escopo_disponivel !== false);
    } catch {
      setChaveMsg("Nao consegui carregar suas chaves — tente reabrir esta aba.");
    }
  }

  async function gerarMinhaChave() {
    if (gerandoChave) return;
    setGerandoChave(true);
    setChaveMsg(null);
    setChaveCopiada(false);
    try {
      const r = await authedFetch("/api/minha-chave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: chaveNome.trim() || undefined,
          // so manda recorte quando a instalacao suporta (sem a 0019 a rota
          // RECUSA o pedido com escopo, em vez de entregar chave aberta)
          ...(escopoChaveOk ? { escopo: corpoEscopoProprio(escopoNova), expira_em: prazoNova || null } : {}),
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.chave) {
        setChaveMsg(j.error || "Falha ao gerar a chave. Tente de novo.");
        return;
      }
      setChaveNova({ chave: j.chave, nome: j.nome });
      setChaveNome("");
      carregarMinhasChaves();
    } catch {
      setChaveMsg("Falha ao gerar a chave. Tente de novo.");
    } finally {
      setGerandoChave(false);
    }
  }

  async function revogarMinhaChave(id: string, nome: string) {
    if (!window.confirm(`Revogar a chave "${nome}"? O agente que usa essa chave para de funcionar na hora (some em ate 1 min).`)) return;
    setChaveMsg(null);
    try {
      const r = await authedFetch(`/api/minha-chave?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) {
        setChaveMsg(j.error || "Falha ao revogar.");
        return;
      }
      if (chaveNova) limparEstadoChave(); // se acabou de gerar, some com o banner
      carregarMinhasChaves();
    } catch {
      setChaveMsg("Falha ao revogar.");
    }
  }

  async function comecar2fa() {
    setMfaMsg(null);
    // limpa cadastro pela metade (fator nao confirmado) antes de comecar de novo
    const { data: fs } = await authClient.auth.mfa.listFactors();
    for (const f of (fs?.all ?? []).filter((f) => f.status === "unverified")) {
      await authClient.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
    }
    const { data, error } = await authClient.auth.mfa.enroll({ factorType: "totp", friendlyName: "app-autenticador" });
    if (error || !data) {
      setMfaMsg("Falha ao iniciar o 2FA. Tente de novo.");
      return;
    }
    const totp = (data as any).totp || {};
    setMfaEnrol({ factorId: data.id, qr: totp.qr_code || "", secret: totp.secret || "" });
  }

  async function confirmar2fa() {
    if (!mfaEnrol) return;
    setMfaMsg(null);
    const { data: ch, error: e1 } = await authClient.auth.mfa.challenge({ factorId: mfaEnrol.factorId });
    if (e1 || !ch) {
      setMfaMsg("Falha ao conferir o codigo. Tente de novo.");
      return;
    }
    const { error } = await authClient.auth.mfa.verify({
      factorId: mfaEnrol.factorId,
      challengeId: ch.id,
      code: mfaCod.trim(),
    });
    if (error) {
      setMfaMsg("Codigo invalido — confira no app e tente de novo.");
      return;
    }
    setMfaEnrol(null);
    setMfaCod("");
    setMfaMsg("2FA ativado. A partir do proximo login o painel pede o codigo.");
    carregarMfa();
  }

  async function desativar2fa() {
    if (!confirm("Desativar a verificacao em duas etapas desta conta?")) return;
    setMfaMsg(null);
    const { data: fs } = await authClient.auth.mfa.listFactors();
    for (const f of fs?.totp ?? []) {
      const { error } = await authClient.auth.mfa.unenroll({ factorId: f.id });
      if (error) {
        setMfaMsg("Nao deu pra desativar: saia e entre de novo (com o codigo) e tente aqui outra vez.");
        return;
      }
    }
    setMfaMsg("2FA desativado.");
    carregarMfa();
  }

  async function trocarConfigAuto(chave: keyof CfgAuto, valor: CfgAuto[keyof CfgAuto]) {
    setCfgAuto((c) => (c ? { ...c, [chave]: valor } : c));
    const r = await authedFetch("/api/admin/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chave, valor }),
    });
    if (!r.ok) {
      setAviso((await r.json().catch(() => ({}))).error || "Falha ao salvar configuracao");
      carregarAdmin();
    }
  }

  // Salva a lista INTEIRA de destinos de webhook (a rota substitui de uma vez).
  // Item sem `segredo` mantem o que ja estava gravado — a tela nunca teve o valor.
  //
  // A tela sempre muda; a GRAVACAO espera toda linha ter URL. Sem isso, o
  // "Adicionar destino" (que nasce em branco) faria a rota recusar a lista
  // inteira e a linha nova sumiria antes de o admin conseguir digitar nela.
  async function salvarWebhooks(lista: DestinoWebhook[]) {
    const anterior = webhooks;
    setWebhooks(lista);
    if (!lista.every((d) => d.url.trim())) return;
    const r = await authedFetch("/api/admin/webhooks-saida", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destinos: lista.map((d) => ({
          nome: d.nome,
          url: d.url,
          eventos: d.eventos,
          ativo: d.ativo,
          incluir_conteudo: d.incluir_conteudo,
          ...(typeof d.segredo === "string" ? { segredo: d.segredo } : {}),
        })),
      }),
    });
    if (!r.ok) {
      setAviso((await r.json().catch(() => ({}))).error || "Falha ao salvar webhooks de saida");
      setWebhooks(anterior); // nao deixar a tela mostrar o que o servidor recusou
      return;
    }
    const j = await r.json().catch(() => ({}));
    if (Array.isArray(j?.destinos)) setWebhooks(j.destinos);
  }

  async function salvarEtiquetas(lista: string[]) {
    if (!active) return;
    setFicha((f) => (f ? { ...f, etiquetas: lista } : f));
    const r = await authedFetch("/api/etiquetas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: active.chat_id, etiquetas: lista, canal }),
    });
    if (!r.ok) {
      setAviso((await r.json().catch(() => ({}))).error || "Falha ao salvar etiquetas");
      carregarFicha(active.chat_id);
    }
  }

  async function salvarUsuario(u: AdminUsuario, patch: Partial<AdminUsuario>) {
    const novo = { ...u, ...patch };
    setAdminUsuarios((list) => list.map((x) => (x.id === u.id ? novo : x)));
    setUsuarioAberto((atual) => (atual?.id === u.id ? novo : atual));
    const r = await authedFetch("/api/admin/usuarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: u.id,
        nome: u.nome,
        // papel base so vai no corpo quando MUDOU: reenviar o valor atual faz
        // o servidor recusar (so super admin troca papel base) e paralisaria
        // saves que nao tem nada a ver com papel.
        ...(patch.papel !== undefined ? { papel: novo.papel } : {}),
        escopo_visao: novo.escopo_visao,
        ...(typeof patch.ativo === "boolean" ? { ativo: patch.ativo } : {}),
        ...(typeof patch.assinatura_ativa === "boolean" ? { assinatura_ativa: patch.assinatura_ativa } : {}),
        ...(typeof patch.assinatura_nome === "string" ? { assinatura_nome: patch.assinatura_nome } : {}),
        // modo supervisor: so vai no corpo quando MUDOU (a rota faz merge no
        // jsonb de preferencias — reenviar o valor atual seria escrita a esmo)
        ...(typeof patch.supervisor === "boolean" ? { supervisor: patch.supervisor } : {}),
        ...(typeof patch.supervisor_responder_zera === "boolean"
          ? { supervisor_responder_zera: patch.supervisor_responder_zera }
          : {}),
        ...(Array.isArray(patch.contextos) ? { contextos: patch.contextos } : {}),
        ...(patch.papel_id !== undefined ? { papel_id: patch.papel_id } : {}),
        ...(patch.permissoes_excecao !== undefined ? { permissoes_excecao: patch.permissoes_excecao } : {}),
      }),
    });
    if (!r.ok) {
      setAviso((await r.json().catch(() => ({}))).error || "Falha ao salvar usuario");
      carregarAdmin();
    }
  }

  async function salvarDepartamento(payload: {
    id?: string;
    nome?: string;
    ativo?: boolean;
    escopo_visao?: string | null;
    add_user_id?: string;
    add_user_nome?: string;
    remove_user_id?: string;
  }) {
    const r = await authedFetch("/api/admin/departamentos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) setAviso((await r.json().catch(() => ({}))).error || "Falha no departamento");
    setNovoDep("");
    carregarAdmin();
    // atualiza tambem o seletor de responsavel
    authedFetch("/api/users").then((r2) => r2.json()).then((j) => {
      if (j.departamentos) setDepartamentos(j.departamentos);
    }).catch(() => {});
  }

  async function abrirNotificacao(n: Notif) {
    setSinoAberto(false);
    await authedFetch("/api/notificacoes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [n.id] }),
    }).catch(() => {});
    setNotifs((ns) => ns.map((x) => (x.id === n.id ? { ...x, lida: true } : x)));
    naoLidasAntes.current = Math.max(0, naoLidasAntes.current - 1);
    // notificacao ainda nao traz canal: prefere o canal da conversa aberta
    const c = n.chat_id ? acharChat(chats, n.chat_id, null, canalRef.current) : undefined;
    if (c) {
      abrirConversa(c);
      setFichaAberta(true);
      setAbaFicha("notas");
    }
  }

  async function salvarFicha() {
    if (!active || !fichaEdit) return;
    // so VALORES dos campos padrao (valor vazio limpa o campo)
    const r = await authedFetch("/api/ficha", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: active.chat_id, ficha: fichaEdit, canal }),
    });
    if (!r.ok) setAviso((await r.json().catch(() => ({}))).error || "Falha ao salvar ficha");
    setFichaEdit(null);
    carregarFicha(active.chat_id);
  }

  async function enviarNota() {
    if (!active || !novaNota.trim() || salvandoNota) return;
    setSalvandoNota(true);
    try {
      const r = await authedFetch("/api/nota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: active.chat_id, texto: novaNota.trim(), canal }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setAviso(j.error || "Falha ao salvar anotacao");
      else {
        setNovaNota("");
        if (j.mencionados?.length) setAviso(`Anotacao salva. Notifiquei: ${j.mencionados.join(", ")}.`);
        carregarFicha(active.chat_id);
      }
    } finally {
      setSalvandoNota(false);
    }
  }

  // deep link: ?chat=<id> abre a conversa direto (link compartilhavel)
  const abriuPelaUrl = useRef(false);
  useEffect(() => {
    if (abriuPelaUrl.current || !chats.length) return;
    const params = new URLSearchParams(window.location.search);
    const alvo = params.get("chat");
    if (!alvo) return;
    // link novo traz &canal=; link antigo (so ?chat=) cai na 1a conversa com esse id
    const c = acharChat(chats, alvo, params.get("canal"));
    if (c) {
      abriuPelaUrl.current = true;
      abrirConversa(c, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats]);

  useEffect(() => {
    if (!active) return;
    const atual = chats.find((c) => c.uid === active.uid);
    if (
      atual &&
      (atual.status !== active.status ||
        JSON.stringify(atual.responsaveis) !== JSON.stringify(active.responsaveis) ||
        atual.arquivada !== active.arquivada ||
        atual.auto_arquivar !== active.auto_arquivar ||
        JSON.stringify(atual.visibilidade) !== JSON.stringify(active.visibilidade) ||
        (atual.profile_thumbnail && atual.profile_thumbnail !== active.profile_thumbnail))
    ) {
      setActive((a) =>
        a && a.uid === atual.uid
          ? {
              ...a,
              status: atual.status,
              responsaveis: atual.responsaveis,
              responsavel_id: atual.responsavel_id,
              responsavel_nome: atual.responsavel_nome,
              arquivada: atual.arquivada,
              auto_arquivar: atual.auto_arquivar,
              visibilidade: atual.visibilidade,
              profile_thumbnail: atual.profile_thumbnail ?? a.profile_thumbnail,
            }
          : a
      );
    }
  }, [chats, active]);

  const carregarFicha = useCallback(async (chatId: string) => {
    try {
      const r = await authedFetch(`/api/ficha?chat_id=${encodeURIComponent(chatId)}&canal=${canalRef.current}`);
      const j = await r.json();
      if (!j.error) setFicha(j);
    } catch {}
  }, [authedFetch]);

  function abrirConversa(c: Chat, trocarUrl = true) {
    // canal acompanha a conversa: as rotas por conversa (mensagens, ficha,
    // agendadas, envio) leem canal/canalRef — ajustar ANTES de setActive
    setCanal(c.canal);
    canalRef.current = c.canal;
    setActive(c);
    setRespondendo(null);
    setEditando(null);
    setMenuMsg(null);
    setFicha(null);
    // FRENTE O: tudo que e POR CONVERSA zera junto. Historico da conversa
    // anterior sobrando na gaveta seria pior que gaveta vazia — a pessoa leria a
    // trilha de outro cliente achando que e deste.
    setBuscaConversa(null);
    setAchadosConversa(null);
    setAvisoBuscaConversa(null);
    setHistStatus(null);
    setHistTransf(null);
    setHistAval(null);
    setHistMidia(null);
    setAbaMidia("media");
    setAbaFicha("dados");
    setRobo(null);
    setVincFluxo(null);
    // FRENTE S — o que e POR CONVERSA zera junto (mesma regra da Frente O):
    // pendencia de aprovacao de OUTRO cliente sobrando no painel faria o
    // atendente aprovar uma mensagem que nao e desta conversa.
    setAutoConversa(null);
    setAgendadaEdit(null);
    setInterAberto(false);
    setInterOpcoes(["", ""]);
    // FRENTE Y — as tres costuras tambem sao POR CONVERSA, e nas tres o dado da
    // conversa anterior sobrando seria pior que painel vazio:
    //  * MEMORIA: a variavel `URA` de outro cliente na tela, e um clique em
    //    Apagar mexendo na conversa errada;
    //  * TEMPLATE: seletor aberto com o parametro que a pessoa digitou pra outro
    //    cliente — e template, uma vez enviado, nao volta;
    //  * RESPOSTA RAPIDA: `texto_resolvido` carrega o NOME do contato, entao a
    //    lista da conversa anterior mandaria o nome do cliente errado pro certo.
    setMemoria(null);
    setMemApagar(null);
    setMemChave("");
    setMemValor("");
    setMemErro(null);
    setTplAberto(false);
    setTplEscolhido(null);
    setTplParams([]);
    setTplCatalogo(null);
    setTplAviso(null);
    carregarRespostasRapidas({ chat_id: c.chat_id, canal: c.canal });
    // previa de audio nao viaja entre conversas: enviar pro cliente errado um
    // audio gravado pra outro e o tipo de erro que nao tem desfazer
    descartarAudio();
    carregarRobo(c.chat_id, c.canal);
    // GATE ANTES DE BATER NA ROTA: o modulo de automacao nasce DESLIGADO e a rota
    // exige `automacao` OU `aprovar_automacao`. Sem esta checagem, o atendente da
    // instalacao tipica levava um 403 a cada clique em conversa — barulho no log
    // de quem cuida da instalacao pra pintar um selo que ele nunca veria.
    // MODULO DESLIGADO = NAO PERGUNTA (revisao de interface, 03/09/2026): o perfil
    // agora traz `modulos` do servidor, entao a instalacao tipica (automacao
    // desligada) nao dispara NENHUMA chamada a /fluxo-fila — zero 403 no console.
    // `modulos` ausente (servidor antigo) cai no comportamento anterior: aprende
    // pela 1a recusa (automacaoDesligadaRef).
    if (
      perfil?.modulos?.automacao !== false &&
      (temPermissao("automacao") || temPermissao("aprovar_automacao"))
    ) {
      // FRENTE S — a fila de automacao DESTA conversa (o que espera aval e o que
      // ainda vai sair). MESMO gate, mesma rota, mesma razao: sem ele, seria um
      // 403 por clique em conversa pra todo atendente da instalacao tipica, que
      // nasce com o modulo de automacao DESLIGADO.
      //
      // SEQUENCIAL de proposito (02/09/2026): as duas chamadas batem em /fluxo-fila.
      // Em paralelo, no PRIMEIRO clique da sessao as duas saem antes de qualquer uma
      // aprender que o modulo esta desligado — 2 recusas so na largada, e ainda 2 por
      // conversa nova ate o ref armar. Rodando a fila primeiro e o selo DEPOIS que ela
      // resolve, a fila arma `automacaoDesligadaRef` e o selo ja pula: 1 recusa na vida
      // da sessao, zero nas conversas seguintes.
      void carregarAutoConversa(c.chat_id, c.canal).then(() => carregarVinculoFluxo(c.chat_id, c.canal));
    } else {
      setAutoConversa(null);
      setVincFluxo(null);
    }
    carregarFicha(c.chat_id);
    if (trocarUrl) {
      const u = new URL(window.location.href);
      u.searchParams.set("chat", c.chat_id);
      u.searchParams.set("canal", c.canal);
      window.history.replaceState(null, "", u.toString());
    }
    // MODO SUPERVISOR: abrir a conversa NAO consome o "nao lida" do time. Quem
    // decide de verdade e o SERVIDOR (a rota le a preferencia gravada); aqui a
    // tela so evita zerar o contador na cara do usuario pra depois o proximo
    // polling trazer o numero de volta.
    if (c.nao_lidas > 0 && !prefsRef.current.supervisor) {
      setChats((cs) => cs.map((x) => (x.uid === c.uid ? { ...x, nao_lidas: 0 } : x)));
      authedFetch("/api/conversa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `marcar_lida_por_abertura`, nao `marcar_lida`: abrir e efeito colateral
        // de LER, e a rota respeita o modo supervisor. `marcar_lida` continua
        // sendo a intencao explicita (botao, tool do MCP) e sempre obedecida.
        // c.canal, nao o estado `canal`: aqui ele ainda e o da conversa anterior
        body: JSON.stringify({ chat_id: c.chat_id, marcar_lida_por_abertura: true, canal: c.canal }),
      }).catch(() => {});
    }
  }

  // clicar no nome de quem escreveu no grupo: vai pra conversa 1:1 dessa pessoa
  function abrirPessoa(telefone: string | null) {
    if (!telefone) return;
    const so = telefone.replace(/\D/g, "");
    // 1:1 da pessoa no MESMO canal do grupo (o telefone pode existir tambem em outro canal)
    const c = acharChat(chats, so, null, canalRef.current) ?? acharChat(chats, telefone, null, canalRef.current);
    if (c) abrirConversa(c);
    else setAviso("Ainda nao existe conversa individual com essa pessoa no painel.");
  }

  useEffect(() => {
    // mensagem nova NA conversa aberta: so zera o contador — nada de reabrir a
    // conversa (reabrir limpava as mensagens e a tela piscava a cada recebimento)
    if (!active) return;
    const atual = chats.find((c) => c.uid === active.uid);
    // (modo supervisor: mensagem nova na conversa aberta tambem nao zera —
    // supervisor acompanha sem consumir a fila. Ver `abrirConversa`.)
    if (atual && atual.nao_lidas > 0 && !prefsRef.current.supervisor) {
      setChats((cs) => cs.map((x) => (x.uid === atual.uid ? { ...x, nao_lidas: 0 } : x)));
      authedFetch("/api/conversa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: atual.chat_id, marcar_lida_por_abertura: true, canal: atual.canal }),
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats]);

  // responsaveis: VARIAS pessoas e departamentos ao mesmo tempo (N:N)
  async function mudarResponsavel(op: "add" | "remove", tipo: "usuario" | "departamento", id: string, nome?: string) {
    if (!active) return;
    const alvo = active.chat_id;
    const alvoUid = active.uid;
    const body =
      op === "add"
        ? { chat_id: alvo, canal, add_responsavel: { tipo, id, nome } }
        : { chat_id: alvo, canal, remove_responsavel: { tipo, id } };
    try {
      const r = await authedFetch("/api/conversa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setAviso(j.error || "Falha ao mudar responsavel");
      const responsaveis: ChatResp[] = j.responsaveis || [];
      setActive((a) => (a && a.uid === alvoUid ? { ...a, responsaveis } : a));
      setChats((cs) => cs.map((c) => (c.uid === alvoUid ? { ...c, responsaveis } : c)));
    } catch {}
  }

  function adicionarResponsavel(valor: string) {
    if (!valor) return;
    const [tipo, id] = valor.split(":");
    const lista = tipo === "dep" ? departamentos : users;
    const alvo = lista.find((x) => x.id === id);
    if (alvo) mudarResponsavel("add", tipo === "dep" ? "departamento" : "usuario", alvo.id, alvo.nome);
  }

  // visibilidade: mesma mecanica do responsavel, mas admite BU (tipo "contexto")
  // e so o super admin pode mexer (o servidor valida de novo)
  async function mudarVisibilidade(op: "add" | "remove", tipo: "usuario" | "departamento" | "contexto", id: string, nome?: string) {
    if (!active) return;
    const alvo = active.chat_id;
    const alvoUid = active.uid;
    const body =
      op === "add"
        ? { chat_id: alvo, canal, add_visibilidade: { tipo, id, nome } }
        : { chat_id: alvo, canal, remove_visibilidade: { tipo, id } };
    try {
      const r = await authedFetch("/api/conversa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setAviso(j.error || "Falha ao mudar visibilidade");
      const visibilidade: VisResp[] = j.visibilidade || [];
      setActive((a) => (a && a.uid === alvoUid ? { ...a, visibilidade } : a));
      setChats((cs) => cs.map((c) => (c.uid === alvoUid ? { ...c, visibilidade } : c)));
    } catch {}
  }

  function adicionarVisibilidade(valor: string) {
    if (!valor) return;
    const [tipo, id] = valor.split(":");
    if (tipo === "bu") {
      const alvo = (visoes.length ? visoes : visBuFallback || []).find((x) => x.id === id);
      if (alvo) mudarVisibilidade("add", "contexto", alvo.id, alvo.nome);
      return;
    }
    const lista = tipo === "dep" ? departamentos : users;
    const alvo = lista.find((x) => x.id === id);
    if (alvo) mudarVisibilidade("add", tipo === "dep" ? "departamento" : "usuario", alvo.id, alvo.nome);
  }

  async function atualizarConversa(patch: { status?: StatusAtendimento; arquivada?: boolean }) {
    if (!active) return;
    const alvo = active.chat_id;
    const alvoUid = active.uid;
    // retrato do que vai mudar, pra DESFAZER na tela se o servidor recusar
    const antes: { status?: StatusAtendimento; arquivada?: boolean } = {};
    if (patch.status !== undefined) antes.status = active.status;
    if (patch.arquivada !== undefined) antes.arquivada = active.arquivada;
    setActive((a) => (a ? { ...a, ...patch } : a));
    setChats((cs) => cs.map((c) => (c.uid === alvoUid ? { ...c, ...patch } : c)));
    const r = await authedFetch("/api/conversa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: alvo, canal, ...patch }),
    }).catch(() => null);
    if (!r || !r.ok) {
      // TELA OTIMISTA NAO PODE MENTIR (achado do teste funcional de 02/09/2026):
      // com a migration 0006 faltando em producao, este POST devolvia 500 e o
      // `.catch(() => {})` engolia — o atendente via o status trocado, recarregava
      // e ele voltava. Agora desfaz na tela e avisa com o motivo do servidor.
      const j = r ? await r.json().catch(() => ({})) : {};
      setActive((a) => (a && a.uid === alvoUid ? { ...a, ...antes } : a));
      setChats((cs) => cs.map((c) => (c.uid === alvoUid ? { ...c, ...antes } : c)));
      setAviso(j.error || "Nao consegui salvar a alteracao da conversa. Tente de novo.");
      return;
    }
    // trocar status muda a trilha: o painel de historico aberto ficaria velho
    if (patch.status !== undefined) setHistStatus(null);
    // POLL EM VOO COM DADO VELHO: a resposta de um /api/chats que saiu ANTES do
    // POST chegava depois do otimista, e o efeito de sincronia (chats -> active)
    // devolvia o estado antigo por um ciclo — clicar "Desarquivar" e o botao
    // continuar "Desarquivar" (medido na homologacao em producao, 02/09/2026).
    // Recarregar aqui avanca o `loadSeq`; a resposta atrasada e descartada pelo
    // proprio loadChats e a lista volta com o que o servidor gravou.
    void loadChats();
  }

  // ───────────────────── FRENTE O: busca DENTRO da conversa ─────────────────
  async function rodarBuscaConversa(termo: string) {
    if (!active) return;
    const q = termo.trim();
    if (q.length < MIN_TERMO_BUSCA) {
      setAchadosConversa(null);
      setAvisoBuscaConversa(null);
      return;
    }
    setBuscandoConversa(true);
    setAvisoBuscaConversa(null);
    const alvoUid = active.uid;
    try {
      const r = await authedFetch(
        `/api/conversa/busca?chat_id=${encodeURIComponent(active.chat_id)}&canal=${active.canal}&q=${encodeURIComponent(q)}`
      );
      const j = await r.json().catch(() => ({}));
      // a pessoa pode ter trocado de conversa enquanto a busca voltava: jogar o
      // resultado na conversa errada e pior que nao mostrar resultado nenhum
      if (activeRef.current?.uid !== alvoUid) return;
      if (!r.ok) {
        setAchadosConversa([]);
        setAvisoBuscaConversa(j.error || "Falha ao buscar");
        return;
      }
      setAchadosConversa(j.achados || []);
      const avisos: string[] = [];
      if (j.aviso) avisos.push(j.aviso);
      if (j.truncado) avisos.push("mostrando os resultados mais recentes — refine o termo pra ver o resto");
      if (j.parcial_fonte_externa) avisos.push("neste canal a busca e parcial (vem da fonte externa)");
      setAvisoBuscaConversa(avisos.join(" · ") || null);
    } catch {
      if (activeRef.current?.uid === alvoUid) setAvisoBuscaConversa("Falha ao buscar");
    } finally {
      setBuscandoConversa(false);
    }
  }

  /**
   * Rola ate a mensagem do resultado.
   *
   * LIMITE DECLARADO NA CARA DO USUARIO: a tela carrega as ultimas 300
   * mensagens (/api/messages), e a busca varre o banco INTEIRO da conversa —
   * entao ela acha mensagem que a tela nao tem em maos. Quando o alvo nao esta
   * carregado, o aviso diz isso, em vez de o clique simplesmente nao fazer nada
   * (clique morto parece bug).
   */
  function pularParaMensagem(id: string) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) {
      setAvisoBuscaConversa("essa mensagem e antiga e ainda nao esta carregada na tela (o painel abre as ultimas 300)");
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // realce temporario: sem ele a pessoa rola ate o lugar e nao sabe qual bolha
    // era o resultado
    el.classList.add("ring-2", "ring-primary");
    setTimeout(() => el.classList.remove("ring-2", "ring-primary"), 2000);
  }

  /**
   * A TRILHA DA CONVERSA ABERTA, uma vez por conversa (costura com a Frente P).
   *
   * NAO ENTRA NO POLL de 3s do `loadMsgs` de proposito: o vinculo mensagem->fluxo
   * nao muda pra mensagem que ja existe, e mensagem NOVA que sai de fluxo aparece
   * com selo na proxima conversa aberta. Um poll a mais aqui custaria uma consulta
   * de trilha a cada 3 segundos por atendente com a tela aberta, pra pintar um
   * selo que quase nunca muda.
   *
   * Silencioso em TODO caminho ruim: 403 (a rota exige `automacao` ou
   * `aprovar_automacao`), modulo de automacao desligado, instalacao sem a 0018
   * (`vinculo_disponivel: false`), rede caindo. Selo e metadado — a ausencia dele
   * nao pode virar erro na tela nem esconder a conversa.
   */
  const carregarVinculoFluxo = useCallback(
    async (chatId: string, canalDoChat: string) => {
      // mesmo desarme de carregarAutoConversa: modulo desligado = nao pergunta de novo
      if (automacaoDesligadaRef.current) return setVincFluxo(null);
      try {
        const r = await authedFetch(
          `/api/fluxo-fila?trilha=1&chat_id=${encodeURIComponent(chatId)}&canal=${canalDoChat}`
        );
        if (!r.ok) {
          if (r.status === 403 && (await moduloDesligado(r))) automacaoDesligadaRef.current = true;
          return setVincFluxo(null);
        }
        const j = await r.json().catch(() => ({}));
        setVincFluxo(j?.por_mensagem && typeof j.por_mensagem === "object" ? j.por_mensagem : null);
      } catch {
        setVincFluxo(null);
      }
    },
    [authedFetch]
  );

  // ───────────────────────── FRENTE O: robo por conversa ────────────────────
  const carregarRobo = useCallback(
    async (chatId: string, canalDoChat: string) => {
      try {
        const r = await authedFetch(
          `/api/conversa/historicos?tipo=robo&chat_id=${encodeURIComponent(chatId)}&canal=${canalDoChat}`
        );
        const j = await r.json().catch(() => ({}));
        setRobo(r.ok ? j : { disponivel: false, bot_ativo: true });
      } catch {
        setRobo({ disponivel: false, bot_ativo: true });
      }
    },
    [authedFetch]
  );

  async function alternarRobo() {
    if (!active || !robo?.disponivel) return;
    const alvo = active.chat_id;
    const novo = !robo.bot_ativo;
    const anterior = robo;
    setRobo({ ...robo, bot_ativo: novo });
    try {
      const r = await authedFetch("/api/conversa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: alvo, canal, bot_ativo: novo }),
      });
      const j = await r.json().catch(() => ({}));
      // `aviso_bot` = o pedido nao gravou (migration/grant). Voltar o botao e
      // OBRIGATORIO: interruptor que ficou na posicao nova sem ter gravado faz a
      // pessoa sair achando que desligou a automacao.
      if (!r.ok || j.aviso_bot) {
        setRobo(anterior);
        setAviso(j.aviso_bot || j.error || "Nao deu pra mudar o robo desta conversa");
      } else {
        // o liga/desliga grava na MESMA tabela de eventos do status (mesma classe
        // de defeito, mesma trilha): o painel de historico aberto ficaria sem o
        // evento novo, e a trilha do proprio robo tambem.
        setHistStatus(null);
        carregarRobo(alvo, canal);
      }
    } catch {
      setRobo(anterior);
      setAviso("Nao deu pra mudar o robo desta conversa");
    }
  }

  // ─────────────────── FRENTE O: historicos (carga por demanda) ─────────────
  async function carregarHistorico(tipo: "status" | "avaliacoes" | "midia" | "transferencias") {
    if (!active) return;
    const alvoUid = active.uid;
    const url = `/api/conversa/historicos?tipo=${tipo}&chat_id=${encodeURIComponent(active.chat_id)}&canal=${active.canal}`;
    try {
      const r = await authedFetch(url);
      const j = await r.json().catch(() => ({}));
      if (activeRef.current?.uid !== alvoUid) return;
      if (!r.ok) {
        const aviso = j.error || "Falha ao carregar";
        if (tipo === "status") setHistStatus({ linhas: [], resumo: [], resumo_parcial: false, aviso });
        if (tipo === "transferencias") setHistTransf({ linhas: [], aviso });
        if (tipo === "avaliacoes") setHistAval({ csat: [], nps: [], avisos: [aviso] });
        if (tipo === "midia") setHistMidia({ abas: { media: [], document: [], sticker: [] }, truncado: false, aviso });
        return;
      }
      if (tipo === "status") setHistStatus(j);
      if (tipo === "transferencias") setHistTransf(j);
      if (tipo === "avaliacoes") setHistAval(j);
      if (tipo === "midia") setHistMidia(j);
    } catch {
      /* silencioso: o painel mostra "carregando" e a pessoa pode reabrir a aba */
    }
  }

  function abrirAbaFicha(aba: typeof abaFicha) {
    setAbaFicha(aba);
    if (aba === "status" && !histStatus) carregarHistorico("status");
    if (aba === "transferencias" && !histTransf) carregarHistorico("transferencias");
    if (aba === "avaliacoes" && !histAval) carregarHistorico("avaliacoes");
    if (aba === "midia" && !histMidia) carregarHistorico("midia");
    // FRENTE Y — a memoria carrega ao ABRIR a aba, igual aos historicos. Nao entra
    // na abertura da conversa nem no poll de 3s: e um SELECT por conversa pra
    // pintar um dado que quase nunca muda, e o mesmo critério manteve a trilha de
    // fluxo (frente O) e a fila de atendimento (frente S) fora do poll.
    if (aba === "memoria" && !memoria && active) carregarMemoria(active.chat_id, active.canal);
  }

  // ───────────────────── FRENTE O: iniciar conversa nova ────────────────────
  async function iniciarConversa() {
    if (iniciando) return;
    setErroNova(null);
    setIniciando(true);
    try {
      const canalEscolhido = canalDoInicio();
      const r = await authedFetch("/api/conversa/iniciar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canal: canalEscolhido,
          telefone: novoNumero,
          nome: novoNome.trim() || undefined,
          texto: novoTexto,
          // o `true` sai DAQUI, do gesto de quem marcou a caixa na tela — nao de
          // default, nao de inferencia. A rota recusa sem ele.
          confirmado: novoConfirmado,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && j.chat_id) {
        // conversa que ja existe nao e "iniciar": e abrir. Nada foi enviado.
        const existente = acharChat(chats, j.chat_id, canalEscolhido);
        setErroNova(null);
        setNovaConversaAberta(false);
        limparNovaConversa();
        if (existente) abrirConversa(existente);
        else setAviso("Essa conversa ja existe — ela deve aparecer na lista no proximo carregamento.");
        return;
      }
      if (r.status === 207) {
        // A MENSAGEM SAIU e o painel nao registrou. Nao e sucesso e nao e falha:
        // fechar o modal com "erro" faria a pessoa mandar de novo pro cliente.
        setNovaConversaAberta(false);
        limparNovaConversa();
        setAviso(
          `${j.error || "A mensagem foi enviada, mas o painel nao registrou a conversa."} ${
            Array.isArray(j.detalhes) ? `(${j.detalhes.join("; ")})` : ""
          }`.trim()
        );
        await loadChats();
        return;
      }
      if (!r.ok || !j.ok) {
        setErroNova(j.error || "Nao deu pra iniciar a conversa");
        return;
      }
      const nomeNovo = novoNome.trim();
      setNovaConversaAberta(false);
      limparNovaConversa();
      // TRAVA QUE NAO VALE TEM QUE SER DECLARADA. Silencio aqui faria a pessoa
      // achar que existe teto por hora e descadastro sendo respeitados quando a
      // instalacao nem tem as tabelas.
      const inertes: string[] = [];
      if (j.teto_ativo === false) inertes.push("o limite por hora (falta a migration 0017)");
      if (j.optout_ativo === false) inertes.push("o respeito ao descadastro (falta a migration 0012)");
      if (j.registro_parcial) inertes.push("o registro de quem abriu a conversa");
      if (inertes.length) {
        setAviso(`Conversa iniciada. ATENCAO — nesta instalacao ainda nao vale: ${inertes.join("; ")}.`);
      }
      await loadChats();
      // O botao diz "Enviar e ABRIR conversa" — entao abre. Ate 02/09/2026 so
      // recarregava a lista e a pessoa ficava com "Escolha uma conversa ao lado",
      // procurando a conversa nova no topo (visto na homologacao em producao).
      // Mesmo desenho do quadro: monta o minimo pra abrir; a lista recem-carregada
      // e o poll completam os campos em seguida.
      const chatIdNovo: string | undefined = typeof j.chat_id === "string" ? j.chat_id : undefined;
      if (chatIdNovo) {
        setVisaoPainel("conversas");
        abrirConversa({
          chat_id: chatIdNovo,
          chat_name: nomeNovo || null,
          is_group: false,
          phone: null,
          profile_thumbnail: null,
          last_message_at: null,
          preview: null,
          status: "atendimento",
          responsaveis: [],
          responsavel_id: null,
          responsavel_nome: null,
          nao_lidas: 0,
          arquivada: false,
          auto_arquivar: false,
          visibilidade: [],
          canal: canalEscolhido,
          uid: `${canalEscolhido}:${chatIdNovo}`,
        });
      } else if (!inertes.length) {
        setAviso("Conversa iniciada — ela aparece na lista no proximo carregamento.");
      }
    } catch {
      setErroNova("Nao deu pra iniciar a conversa");
    } finally {
      setIniciando(false);
    }
  }

  /**
   * Os numeros por onde da pra ABRIR conversa.
   *
   * Fora da lista, e por que: canal de fonte externa nao envia; e o canal
   * OFICIAL da Meta exige template aprovado fora da janela de 24h — e a janela
   * de quem nunca falou com a empresa esta, por definicao, fechada. Oferecer
   * essas opcoes seria oferecer um caminho que sempre recusa.
   */
  function canaisParaIniciar() {
    return canais.filter(
      (c) =>
        c.ativo && c.tipo === "whatsapp" && c.fonte !== "instagram-agent" && c.fonte !== "whatsapp-agent" && c.fonte !== "gupshup"
    );
  }

  /**
   * O numero de saida efetivo do modal.
   *
   * UMA fonte de verdade pro que o seletor MOSTRA e pro que o POST MANDA. Com
   * dois calculos (um no `value` do select, outro no corpo do pedido), abrir o
   * modal com um canal de Instagram em foco mostraria o numero A e enviaria pelo
   * Instagram — 403 sem a pessoa entender por que.
   */
  function canalDoInicio() {
    const candidatos = canaisParaIniciar();
    if (novoCanal && candidatos.some((c) => c.id === novoCanal)) return novoCanal;
    if (candidatos.some((c) => c.id === canal)) return canal;
    return candidatos[0]?.id ?? canal;
  }

  function limparNovaConversa() {
    setNovoCanal(null);
    setNovoNumero("");
    setNovoNome("");
    setNovoTexto("");
    setNovoConfirmado(false);
    setErroNova(null);
  }

  // auto-arquivar: liga junto com arquivada=true (o servidor faz o mesmo no banco);
  // desliga so tira o auto-arquivar, o arquivado manual continua igual
  async function mudarAutoArquivar(ligar: boolean) {
    if (!active) return;
    const alvo = active.chat_id;
    const alvoUid = active.uid;
    const anterior = { auto_arquivar: active.auto_arquivar, arquivada: active.arquivada };
    const novo = ligar ? { auto_arquivar: true, arquivada: true } : { auto_arquivar: false };
    setActive((a) => (a && a.uid === alvoUid ? { ...a, ...novo } : a));
    setChats((cs) => cs.map((c) => (c.uid === alvoUid ? { ...c, ...novo } : c)));
    try {
      const r = await authedFetch("/api/conversa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: alvo, canal, auto_arquivar: ligar }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setAviso(j.error || "Falha ao mudar arquivamento automatico");
        setActive((a) => (a && a.uid === alvoUid ? { ...a, ...anterior } : a));
        setChats((cs) => cs.map((c) => (c.uid === alvoUid ? { ...c, ...anterior } : c)));
      } else {
        // mesmo motivo de atualizarConversa: descarta poll em voo com dado velho
        void loadChats();
      }
    } catch {
      setAviso("Falha ao mudar arquivamento automatico");
      setActive((a) => (a && a.uid === alvoUid ? { ...a, ...anterior } : a));
      setChats((cs) => cs.map((c) => (c.uid === alvoUid ? { ...c, ...anterior } : c)));
    }
  }

  // selecao em massa: aplica visibilidade/auto-arquivar a varios chats de uma vez
  // selecionados guarda o uid (canal:chat_id) — a selecao pode misturar canais
  function alternarSelecionado(uid: string) {
    setSelecionados((s) => (s.includes(uid) ? s.filter((x) => x !== uid) : [...s, uid]));
  }

  function sairDoModoSelecao() {
    setModoSelecao(false);
    setSelecionados([]);
    setPainelVisMassa(false);
    setVisMassaItens([]);
  }

  async function aplicarAutoArquivarMassa(ligar: boolean) {
    if (!selecionados.length || aplicandoMassa) return;
    setAplicandoMassa(true);
    try {
      // a API e por canal: 1 request por canal presente na selecao
      const rs = await Promise.all(agruparPorCanal(chats, selecionados).map((g) =>
        authedFetch("/api/visibilidade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ canal: g.canal, chat_ids: g.chat_ids, auto_arquivar: ligar }),
        })
      ));
      const falha = rs.find((r) => !r.ok);
      const j = falha ? await falha.json().catch(() => ({})) : {};
      if (falha) setAviso(j.error || "Falha ao mudar arquivamento automatico em massa");
      else {
        setAviso(`Arquivamento automatico ${ligar ? "ligado" : "desligado"} em ${selecionados.length} conversa(s).`);
        sairDoModoSelecao();
        loadChats();
      }
    } catch {
      setAviso("Falha ao mudar arquivamento automatico em massa");
    } finally {
      setAplicandoMassa(false);
    }
  }

  // ACOES EM MASSA (Eric 17/08/2026; Brain u3fywq0dftur sub 9): status, responsavel e
  // arquivar pra N conversas de uma vez — POST /api/conversa/massa (so super admin), 1 request
  // por canal presente na selecao; o servidor aplica uma a uma com a mesma trilha da acao
  // unitaria e devolve quantas aplicou.
  async function aplicarMassa(acao: Record<string, unknown>, rotulo: string) {
    if (!selecionados.length || aplicandoMassa) return;
    setAplicandoMassa(true);
    try {
      const rs = await Promise.all(agruparPorCanal(chats, selecionados).map((g) =>
        authedFetch("/api/conversa/massa", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ canal: g.canal, chat_ids: g.chat_ids, ...acao }),
        }).then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) as { error?: string; aplicadas?: number; falhas?: unknown[] } }))
      ));
      const falha = rs.find((r) => !r.ok);
      if (falha) setAviso(falha.j.error || "Falha na acao em massa");
      else {
        const aplicadas = rs.reduce((n, r) => n + (Number(r.j.aplicadas) || 0), 0);
        const falhas = rs.reduce((n, r) => n + (Array.isArray(r.j.falhas) ? r.j.falhas.length : 0), 0);
        setAviso(`${rotulo} ${aplicadas} conversa(s)${falhas ? ` — ${falhas} nao aplicada(s)` : ""}.`);
        sairDoModoSelecao();
        loadChats();
      }
    } catch {
      setAviso("Falha na acao em massa");
    } finally {
      setAplicandoMassa(false);
    }
  }

  // ───────────── tela "Instalar widget" (02/09/2026) ─────────────
  async function carregarInstalacao() {
    setInstErro(null);
    try {
      const r = await authedFetch("/api/embed/instalacao");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setInstInfo(null);
        setInstErro(j.error || "Nao consegui ler os dados da instalacao.");
        return;
      }
      setInstInfo(j);
    } catch {
      setInstInfo(null);
      setInstErro("Nao consegui ler os dados da instalacao.");
    }
  }

  async function gerarTokenInstalacao() {
    if (!instContexto) return;
    const r = await authedFetch("/api/embed/instalacao", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contexto: instContexto, dias: instDias }),
    }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) return setAviso(j.error || "Nao consegui gerar o token.");
    setInstToken({ token: j.token, expira_em: j.expira_em });
  }

  function copiarInstalacao(texto: string, chave: string) {
    navigator.clipboard
      ?.writeText(texto)
      .then(() => {
        setInstCopiado(chave);
        setTimeout(() => setInstCopiado(null), 1500);
      })
      .catch(() => setAviso("Nao consegui copiar — selecione o texto e copie na mao."));
  }

  // URL do widget que o snippet aponta. Sem contexto = o usuario ve o escopo normal dele
  // (o painel inteiro que o papel permite, dentro da moldura). Com token = recorte.
  function urlWidgetInstalacao(): string {
    const base = (instInfo?.painel_url || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");
    return `${base}/widget${instToken?.token ? `?ctx=${instToken.token}` : ""}`;
  }

  // Os 3 jeitos validados no Portal do Aluno (02/09/2026). HTML/JS puro, sem dependencia,
  // pra colar em qualquer sistema; a versao React e o mesmo iframe em JSX.
  function snippetInstalacao(): string {
    const url = urlWidgetInstalacao();
    const allow = 'allow="clipboard-write; microphone"';
    if (instForma === "tela") {
      if (instJsx) {
        return `<iframe\n  src="${url}"\n  title="Atendimento"\n  allow="clipboard-write; microphone"\n  style={{ width: "100%", height: "100vh", border: 0, display: "block" }}\n/>`;
      }
      return `<iframe src="${url}" title="Atendimento" ${allow}\n  style="width:100%;height:100vh;border:0;display:block"></iframe>`;
    }
    if (instForma === "balao") {
      return [
        `<!-- Expert Chat: balao flutuante que abre o atendimento -->`,
        `<div id="ec-widget" style="position:fixed;right:20px;bottom:20px;z-index:9999">`,
        `  <iframe id="ec-frame" src="${url}" title="Atendimento" ${allow}`,
        `    style="display:none;width:400px;height:620px;max-width:calc(100vw - 40px);max-height:calc(100vh - 100px);border:0;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);margin-bottom:12px;background:#fff"></iframe>`,
        `  <button id="ec-abrir" type="button" aria-label="Abrir atendimento" aria-expanded="false"`,
        `    style="display:block;margin-left:auto;width:56px;height:56px;border:0;border-radius:50%;background:#128c7e;color:#fff;font-size:24px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3)">&#128172;</button>`,
        `</div>`,
        `<script>`,
        `  (function () {`,
        `    var f = document.getElementById("ec-frame"), b = document.getElementById("ec-abrir");`,
        `    b.addEventListener("click", function () {`,
        `      var aberto = f.style.display !== "none";`,
        `      f.style.display = aberto ? "none" : "block";`,
        `      b.setAttribute("aria-expanded", String(!aberto));`,
        `    });`,
        `  })();`,
        `</script>`,
      ].join("\n");
    }
    return [
      `<!-- Expert Chat: painel lateral que desliza da direita -->`,
      `<div id="ec-lateral" style="position:fixed;top:0;right:0;height:100vh;z-index:9999;transform:translateX(460px);transition:transform .25s">`,
      `  <button id="ec-lateral-btn" type="button" aria-label="Abrir atendimento" aria-expanded="false"`,
      `    style="position:absolute;left:-40px;top:50%;transform:translateY(-50%);width:40px;height:130px;border:0;border-radius:8px 0 0 8px;background:#128c7e;color:#fff;cursor:pointer;writing-mode:vertical-rl;font:600 13px sans-serif;letter-spacing:.5px">Atendimento</button>`,
      `  <iframe src="${url}" title="Atendimento" ${allow}`,
      `    style="width:460px;max-width:100vw;height:100vh;border:0;border-left:1px solid #ddd;background:#fff"></iframe>`,
      `</div>`,
      `<script>`,
      `  (function () {`,
      `    var p = document.getElementById("ec-lateral"), b = document.getElementById("ec-lateral-btn"), aberto = false;`,
      `    b.addEventListener("click", function () {`,
      `      aberto = !aberto;`,
      `      p.style.transform = aberto ? "translateX(0)" : "translateX(460px)";`,
      `      b.setAttribute("aria-expanded", String(aberto));`,
      `    });`,
      `  })();`,
      `</script>`,
    ].join("\n");
  }

  // a origem que o hospedeiro precisa ter em EMBED_FRAME_ANCESTORS: so esquema + host (+porta)
  function origemNormalizada(entrada: string): string | null {
    try {
      const u = new URL(entrada.trim());
      return u.origin;
    } catch {
      return null;
    }
  }

  async function aplicarVisibilidadeMassa() {
    if (!selecionados.length || aplicandoMassa) return;
    if (visMassaModo === "add" && !visMassaItens.length) return;
    setAplicandoMassa(true);
    try {
      // a API e por canal: 1 request por canal presente na selecao
      const rs = await Promise.all(agruparPorCanal(chats, selecionados).map((g) => {
        const body: { canal: string; chat_ids: string[]; set?: VisResp[]; add?: VisResp[] } = {
          canal: g.canal, chat_ids: g.chat_ids,
        };
        if (visMassaModo === "set") body.set = visMassaItens;
        else body.add = visMassaItens;
        return authedFetch("/api/visibilidade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }));
      const falha = rs.find((r) => !r.ok);
      const j = falha ? await falha.json().catch(() => ({})) : {};
      if (falha) setAviso(j.error || "Falha ao mudar visibilidade em massa");
      else {
        setAviso(`Visibilidade atualizada em ${selecionados.length} conversa(s).`);
        sairDoModoSelecao();
        loadChats();
      }
    } catch {
      setAviso("Falha ao mudar visibilidade em massa");
    } finally {
      setAplicandoMassa(false);
    }
  }

  useEffect(() => {
    // sem sessao = sem poll (deslogar mata o timer em vez de virar 401 em loop).
    // Chaveado pelo uid (canal:chat_id, string), nao pelo objeto: mudanca de
    // status ou de responsavel atualiza o objeto active e NAO pode limpar/
    // recarregar a tela; o mesmo telefone em outro canal E outra conversa.
    const chat = activeRef.current;
    if (!chat || !session) return;
    setMsgs([]);
    setTemp([]);
    loadMsgs(chat);
    scrollDown();
    const t = setInterval(() => loadMsgs(chat), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.uid, loadMsgs, session]);

  async function send() {
    if (!active || !draft.trim() || sending) return;
    const text = draft.trim();

    // modo anotacao: grava nota interna (nao vai pro WhatsApp) e aparece no fluxo
    if (modoNota && !editando) {
      setSending(true);
      setDraft("");
      try {
        const r = await authedFetch("/api/nota", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: active.chat_id, texto: text, canal }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) setAviso(j.error || "Falha ao salvar anotacao");
        else if (j.mencionados?.length) setAviso(`Anotacao salva. Notifiquei: ${j.mencionados.join(", ")}.`);
      } finally {
        setSending(false);
        loadMsgs(active);
        carregarFicha(active.chat_id);
        scrollDown();
      }
      return;
    }

    if (editando) {
      setSending(true);
      const alvo = editando;
      setEditando(null);
      setDraft("");
      const r = await authedFetch("/api/mensagem", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: alvo.id, message: text }),
      });
      if (!r.ok) setAviso((await r.json().catch(() => ({}))).error || "Falha ao editar");
      else setMsgs((ms) => ms.map((m) => (m.id === alvo.id ? { ...m, content: text, editada_em: new Date().toISOString() } : m)));
      setSending(false);
      loadMsgs(active);
      return;
    }

    const quoted = respondendo?.provider_msg_id || null;
    setSending(true);
    setDraft("");
    setRespondendo(null);
    // responder desarquiva e poe em atendimento (o servidor faz o mesmo) — SALVO
    // se o chat tem auto-arquivar ligado: nesse caso ele fica sempre arquivado
    if (!active.auto_arquivar && (active.arquivada || active.status !== "atendimento")) {
      const alvo = active.chat_id;
      const alvoUid = active.uid;
      const novo = { arquivada: false, status: "atendimento" as StatusAtendimento };
      setActive((a) => (a && a.uid === alvoUid ? { ...a, ...novo } : a));
      setChats((cs) => cs.map((c) => (c.uid === alvoUid ? { ...c, ...novo } : c)));
    }
    setTemp((t) => [...t, { key: `tmp-${Date.now()}`, content: text, ts: new Date().toISOString() }]);
    scrollDown();
    try {
      const r = await authedFetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: active.chat_id, message: text, quoted_msg_id: quoted, canal }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setTemp((t) => t.filter((tm) => tm.content !== text));
        // FRENTE Y — A JANELA FECHOU: OFERECER O TEMPLATE, nao so avisar (costura
        // da frente U, card 86ak858pa). O sinal vem do SERVIDOR (`use_template`),
        // nunca de deducao da tela: e ele quem mede a janela pela ultima mensagem
        // RECEBIDA no banco, e a tela pode estar com o estado velho — que e
        // justamente o caso em que este 403 aparece com o banner verde na tela.
        if (pedeTemplate(j) && !podeEscolherTemplate()) {
          // FRENTE Y (revisao 1): sem `gerenciar_canais` o catalogo volta 403.
          // Abrir um painel que so sabe mostrar erro seria pior que nao abrir —
          // a frase diz o que aconteceu E o que fazer, que e o caminho real.
          setDraft(text);
          setJanela({ aberta: false, expira_em: null });
          setAviso(
            "Fora da janela de 24h so sai template aprovado, e escolher template exige a permissao " +
              "de gerenciar canais — peca a quem cuida dos numeros."
          );
        } else if (pedeTemplate(j)) {
          // O TEXTO VOLTA PRA CAIXA. Ele nao foi enviado, e engolir o que a pessoa
          // escreveu por causa de uma recusa e perda de trabalho sem aviso — mesmo
          // que o template nao aceite esse texto, ela precisa dele pra copiar,
          // decidir e escolher o template que diz a mesma coisa.
          setDraft(text);
          // A TELA PASSA A CONCORDAR COM O SERVIDOR: o banner verde de "janela
          // aberta ate ..." estava mentindo, e deixa-lo ali com o seletor de
          // template aberto embaixo seria contradicao na mesma tela.
          setJanela({ aberta: false, expira_em: null });
          setTplAberto(true);
          setTplEscolhido(null);
          setTplParams([]);
          setTplAviso(null);
          carregarTemplates(canal);
          setAviso(j.error || "Janela de 24h fechada — escolha um template aprovado.");
        } else {
          setAviso(`Falha no envio: ${j.error || r.status}`);
        }
      }
    } finally {
      setSending(false);
    }
  }

  // arquivo -> data URI base64 (a Z-API aceita e o painel nao precisa de bucket)
  function paraDataUri(file: File): Promise<string> {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
  }

  async function enviarArquivo(file: File) {
    if (!active || sending) return;
    if (file.size > 14_000_000) {
      setAviso("Arquivo acima de 14 MB — o WhatsApp recusa.");
      return;
    }
    const tipo = file.type.startsWith("image/")
      ? "image"
      : file.type.startsWith("video/")
      ? "video"
      : file.type.startsWith("audio/")
      ? "audio"
      : "document";
    setSending(true);
    setTemp((t) => [...t, { key: `tmp-${Date.now()}`, content: `[enviando ${file.name}]`, ts: new Date().toISOString() }]);
    scrollDown();
    try {
      const data = await paraDataUri(file);
      const r = await authedFetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: active.chat_id,
          canal,
          tipo,
          media: data,
          file_name: file.name,
          message: draft.trim() || "",
          quoted_msg_id: respondendo?.provider_msg_id || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setAviso(`Falha ao enviar arquivo: ${j.error || r.status}`);
      }
      setDraft("");
      setRespondendo(null);
    } catch {
      setAviso("Nao consegui ler o arquivo.");
    } finally {
      setTemp([]);
      setSending(false);
      loadMsgs(active);
    }
  }

  // ─────────── FRENTE S: AUDIO com contador e PREVIA (card 86ak86jx2) ─────────
  //
  // O QUE JA EXISTIA (verificado no codigo antes de escrever uma linha):
  // MediaRecorder no composer, envio como `ptt` por /api/send (com `waveform` na
  // Z-API, o que da o play nativo do WhatsApp) e o tratamento de microfone
  // negado por CAUSA, com o conserto escrito. Nada disso foi refeito.
  //
  // O DELTA sao os dois criterios do card que faltavam:
  //   1. CONTADOR de tempo visivel durante a gravacao;
  //   2. PREVIA antes de QUALQUER envio — ouvir, regravar, enviar ou descartar.
  //
  // O (2) e o que doi na operacao: antes, parar a gravacao ENVIAVA na hora, e
  // tosse, cachorro ou frase errada chegavam ao cliente sem ninguem revisar.
  // Audio nao se edita depois de enviado; a unica chance de conserto e antes.
  function pararRelogioGrav() {
    if (relogioGrav.current) clearInterval(relogioGrav.current);
    relogioGrav.current = null;
  }

  /** Solta o `blob:` da previa. Sem isso, cada gravacao descartada vaza memoria. */
  function descartarAudio() {
    // revoke pela REF (sincrono, fora do updater): o updater de setState e o
    // lugar errado pra efeito colateral — ele pode rodar duas vezes em StrictMode
    // e nao roda em componente desmontado.
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setAudioPronto(null);
  }

  async function alternarGravacao() {
    if (gravando) {
      gravadorRef.current?.stop();
      return;
    }
    if (!active) return;
    // gravar de novo joga fora a previa anterior — duas previas na tela nao
    // existem, e a antiga viraria audio enviado por engano
    descartarAudio();
    // contexto sem mediaDevices (http, iframe, navegador antigo) nao tem como gravar
    if (!navigator.mediaDevices?.getUserMedia) {
      setAviso("Este navegador nao permite gravar audio aqui. Abra o painel direto no Chrome (https).");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const pedacos: BlobPart[] = [];
      const t0 = Date.now();
      rec.ondataavailable = (e) => e.data.size && pedacos.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        pararRelogioGrav();
        setGravando(false);
        const blob = new Blob(pedacos, { type: rec.mimeType || "audio/webm" });
        const seg = Math.max(1, Math.round((Date.now() - t0) / 1000));
        if (blob.size < 1200) {
          // clique sem querer: nao vira previa nem aviso de erro
          setGravSeg(0);
          return;
        }
        // NAO ENVIA: vira PREVIA. O envio e um segundo gesto, explicito.
        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;
        setAudioPronto({ url, blob, seg });
      };
      gravadorRef.current = rec;
      rec.start();
      setGravando(true);
      setGravSeg(0);
      pararRelogioGrav();
      relogioGrav.current = setInterval(() => setGravSeg(Math.round((Date.now() - t0) / 1000)), 250);
    } catch (e: any) {
      // cada causa tem um conserto diferente — dizer exatamente o que fazer
      const nome = e?.name || "";
      if (nome === "NotAllowedError" || nome === "PermissionDeniedError") {
        setAviso(
          "Microfone bloqueado. RECARREGUE a pagina (F5) e tente de novo — o Chrome vai pedir permissao. Se seguir bloqueado: cadeado ao lado do endereco > Permissoes do site > Microfone > Permitir."
        );
      } else if (nome === "NotFoundError" || nome === "DevicesNotFoundError") {
        setAviso("Nenhum microfone encontrado neste computador.");
      } else if (nome === "NotReadableError" || nome === "TrackStartError") {
        setAviso("O microfone esta em uso por outro programa (Zoom/Meet/etc). Feche-o e tente de novo.");
      } else {
        setAviso(`Nao consegui acessar o microfone (${nome || "erro desconhecido"}).`);
      }
      // falha ao ABRIR o microfone tem que zerar o estado de gravacao, senao o
      // botao fica vermelho pulsando pra uma gravacao que nunca comecou
      pararRelogioGrav();
      setGravando(false);
    }
  }

  /** Envia a previa como mensagem de VOZ (`ptt` — o formato com play nativo). */
  async function enviarAudioPronto() {
    if (!audioPronto || !active || sending) return;
    setSending(true);
    setTemp((t) => [...t, { key: `tmp-${Date.now()}`, content: "[enviando audio]", ts: new Date().toISOString() }]);
    scrollDown();
    try {
      const data = await paraDataUri(new File([audioPronto.blob], "audio.ogg", { type: audioPronto.blob.type }));
      const r = await authedFetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: active.chat_id,
          canal,
          tipo: "ptt",
          media: data,
          quoted_msg_id: respondendo?.provider_msg_id || null,
        }),
      });
      if (!r.ok) {
        setAviso((await r.json().catch(() => ({}))).error || "Falha ao enviar audio");
        // A PREVIA FICA quando o envio falha. Descartar aqui apagaria a gravacao
        // que o atendente acabou de fazer por causa de um erro de rede — e audio
        // nao se refaz igual.
        return;
      }
      setRespondendo(null);
      descartarAudio();
    } catch {
      setAviso("Nao consegui preparar o audio pra envio.");
    } finally {
      setTemp([]);
      setSending(false);
      loadMsgs(active);
    }
  }

  // ────── FRENTE S: pergunta com OPCOES pelo composer (card 86ak86jvw) ────────
  //
  // A REGRA (formato, tetos do WhatsApp, plano por provedor, fallback de texto
  // numerado) mora em lib/interativas.ts, que tem prova em node solto. Esta
  // funcao so monta o pedido e mostra o que o servidor respondeu.
  function rascunhoInterativo() {
    return {
      tipo: interTipo,
      texto: draft.trim(),
      opcoes: interOpcoes.map((t) => t.trim()).filter(Boolean),
      ...(interTipo === "lista" ? { botao_lista: interBotaoLista } : {}),
    };
  }

  /**
   * A fonte do canal ABERTO. Vazia quando o registro ainda nao chegou (`/api/chats`
   * manda `canais` na primeira resposta) — e ai o certo e ESCONDER o botao, nunca
   * chutar uma fonte: chutar "zapi" faria o botao aparecer num canal de API
   * oficial e devolver 400 no clique.
   */
  function fonteDoCanalAtivo(): string {
    return canais.find((c) => c.id === canal)?.fonte || "";
  }

  /**
   * FRENTE Y (revisao 1) — esta pessoa consegue MESMO abrir o seletor de template?
   *
   * Sao DUAS permissoes e elas nao sao a mesma: `enviar` manda a mensagem, e
   * `gerenciar_canais` e o que `GET /api/canais/templates` cobra (nivel `ler` em
   * PERM_POR_NIVEL_CANAL). O papel embutido `normal` tem a primeira e nao tem a
   * segunda — oferecer o botao a ele e prometer um catalogo que volta 403.
   */
  function podeEscolherTemplate(): boolean {
    return (
      temPermissao("enviar") &&
      (temPermissao("gerenciar_canais") || perfil?.papel === "super_admin")
    );
  }

  /**
   * FRENTE S — este canal aceita ARQUIVO e AUDIO por /api/send?
   *
   * ISTO CORRIGE UM `canal === "central"` HARDCODADO que gateava o clipe e o
   * microfone. Era um literal de canal built-in decidindo capacidade: uma
   * SEGUNDA instancia Z-API declarada em `CANAIS_EXTRA` (o caso que a P1 abriu)
   * ficava sem clipe e sem microfone mesmo suportando os dois. A capacidade e da
   * FONTE, nao do id do canal — e a regra BASE do repo diz que id de canal nao
   * decide comportamento.
   *
   * `gupshup` fica de fora com motivo VERDADEIRO: /api/send recusa midia nesse
   * canal (v1 e so texto). A API da Gupshup DOCUMENTA envio de audio por URL, e
   * ligar isso exigiria subir o arquivo pro bucket antes de enviar — caminho de
   * midia de SAIDA que nao existe no painel e que nao e desta frente.
   */
  function midiaDoCanalAtivo(): { pode: boolean; motivo: string | null } {
    const f = fonteDoCanalAtivo();
    if (f === "zapi" || f === "evolution") return { pode: true, motivo: null };
    if (f === "gupshup") {
      return {
        pode: false,
        motivo: "Neste numero (API oficial) o painel manda so TEXTO por enquanto — audio e arquivo saem pelo outro numero.",
      };
    }
    return { pode: false, motivo: null };
  }

  /** mm:ss — o contador da gravacao e a duracao da previa */
  function relogioAudio(seg: number): string {
    const m = Math.floor(seg / 60);
    const s = seg % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  async function enviarInterativa() {
    if (!active || sending) return;
    // VALIDA NA TELA com a MESMA funcao que a rota usa. Nao e duplicacao de
    // regra: e a mesma regra, chamada duas vezes. O ganho e o erro aparecer no
    // formulario em vez de voltar como 400 depois do clique.
    const v = validarInterativa(rascunhoInterativo());
    if (!v.ok) {
      setAviso(v.erros.join(" · "));
      return;
    }
    setSending(true);
    try {
      const r = await authedFetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: active.chat_id,
          canal,
          tipo: "interativo",
          interativa: v.msg,
          quoted_msg_id: respondendo?.provider_msg_id || null,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setAviso(j.erros?.length ? j.erros.join(" · ") : j.error || "Falha ao enviar a pergunta");
        return;
      }
      // O MODO VOLTA DO SERVIDOR e e ele que a tela mostra. Dizer "enviei
      // botoes" pra um cliente que recebeu texto numerado seria a mentira que o
      // campo `motivo_modo` existe pra impedir.
      setAviso(
        j.modo === "texto_numerado"
          ? `Enviado como texto numerado. ${j.motivo_modo || ""}`.trim()
          : interTipo === "botoes"
          ? "Pergunta enviada com botoes."
          : "Pergunta enviada como lista de opcoes."
      );
      setDraft("");
      setInterAberto(false);
      setInterOpcoes(["", ""]);
      setRespondendo(null);
    } finally {
      setSending(false);
      loadMsgs(active);
    }
  }

  async function encaminhar() {
    if (!encaminhando?.provider_msg_id || !active || !destinosFwd.length) return;
    setEnviandoFwd(true);
    try {
      const r = await authedFetch("/api/forward", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: active.chat_id,
          provider_msg_id: encaminhando.provider_msg_id,
          destinos: destinosFwd,
          canal,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setAviso(j.error || "Falha ao encaminhar");
      } else {
        const n = j.enviados?.length ?? 0;
        setAviso(
          j.falhas?.length
            ? `Encaminhada pra ${n} conversa(s); ${j.falhas.length} falhou(aram) (${j.falhas[0]?.erro || "erro"}).`
            : `Encaminhada pra ${n} conversa(s).`
        );
        setEncaminhando(null);
        setDestinosFwd([]);
        setBuscaFwd("");
      }
      loadChats();
      loadMsgs(active);
    } finally {
      setEnviandoFwd(false);
    }
  }

  async function apagarMensagem(m: Msg) {
    if (!confirm("Apagar esta mensagem pra todo mundo?")) return;
    setMenuMsg(null);
    const r = await authedFetch(`/api/mensagem?id=${encodeURIComponent(m.id)}`, { method: "DELETE" });
    if (!r.ok) setAviso((await r.json().catch(() => ({}))).error || "Falha ao apagar");
    else setMsgs((ms) => ms.map((x) => (x.id === m.id ? { ...x, is_deleted: true } : x)));
    if (active) loadMsgs(active);
  }

  // REAGIR (03/09/2026): emoji pendurado na mensagem, como no WhatsApp — pedido do
  // Eric ("nao tem botao de reagir. Tem q ter"). Otimista na tela (aplicarReacao,
  // lib/reacoes.ts); o servidor manda pro provedor e grava na coluna `reacao`;
  // recusa desfaz e avisa. Vazio remove.
  async function reagir(m: Msg, emoji: string) {
    setReagindo(null);
    setMenuMsg(null);
    const antes = msgs;
    setMsgs((ms) => aplicarReacao(ms, m.id, emoji));
    const r = await authedFetch("/api/mensagem/reacao", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: m.id, emoji, canal }),
    });
    if (!r.ok) {
      setAviso((await r.json().catch(() => ({}))).error || "Falha ao reagir");
      setMsgs(antes);
    }
    if (active) loadMsgs(active);
  }

  // PAGINA ANTERIOR (03/09/2026): quais canais em foco ainda tem conversa mais antiga
  // que a ultima carregada — e o que acende o botao no fim da lista.
  const canaisComMaisAntigas = (filtroCanal ? [filtroCanal] : canaisParaCarregar(canais, embed)).filter(
    (id) => temMaisAntigas[id]
  );
  async function carregarMaisAntigas() {
    if (carregandoMais) return;
    setCarregandoMais(true);
    try {
      const resultados = await Promise.all(
        canaisComMaisAntigas.map(async (id) => {
          const antes = cursorMaisAntigo(chats, id);
          if (!antes) return { id, chats: [] as Omit<Chat, "canal" | "uid">[], tem_mais: false };
          const r = await authedFetch(`/api/chats?canal=${id}&antes=${encodeURIComponent(antes)}&limite=300`);
          const j = r.ok ? await r.json().catch(() => null) : null;
          return {
            id,
            chats: (Array.isArray(j?.chats) ? j.chats : []) as Omit<Chat, "canal" | "uid">[],
            tem_mais: !!j?.tem_mais,
          };
        })
      );
      const novos = juntarChats(resultados.map((x) => ({ canal: x.id, chats: x.chats }))) as Chat[];
      for (const c of novos) extrasRef.current.add(c.uid);
      if (novos.length) setChats((prev) => adicionarExtras(prev, novos));
      setTemMaisAntigas((prev) => {
        const prox = { ...prev };
        for (const x of resultados) prox[x.id] = x.tem_mais;
        return prox;
      });
    } catch {
      setAviso("Nao deu pra carregar as conversas mais antigas agora.");
    } finally {
      setCarregandoMais(false);
    }
  }

  // lista em foco = canal filtrado ("" = todos os canais) — contagem e lista partem dela
  const chatsEmFoco = filtrarPorCanal(chats, filtroCanal);
  const gruposCanais = gruposDoSeletor(canais);
  const arquivadasQtd = chatsEmFoco.filter((c) => c.arquivada).length;

  // pessoas do ChatGuru sem conta no painel, mas presentes nas conversas —
  // entram no filtro pra da pra achar as conversas delas
  const respSemConta = (() => {
    const m = new Map<string, string>();
    for (const c of chats)
      for (const r of c.responsaveis || [])
        if (r.tipo === "usuario" && !users.some((u) => u.id === r.id)) m.set(r.id, r.nome);
    return Array.from(m.entries())
      .map(([id, nome]) => ({ id, nome }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  })();
  const alternarFiltroResp = (id: string) => {
    // mexeu no filtro na mao: volta pra definicao da LISTA (com o espelho legado)
    setFiltroRespNnPura(false);
    setFiltroResps((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  };

  const visible = chatsEmFoco.filter((c) => {
    // por padrao a lista mostra so ativas; o botao Arquivados inverte. COM texto na
    // busca a divisao cai: quem digita um numero ou nome quer ACHAR a conversa, e ate
    // 02/09/2026 a arquivada nao aparecia (homologacao: numero recem-arquivado devolvia
    // lista vazia enquanto a busca por conteudo, server-side, achava). O cabecalho da
    // conversa aberta ja diz "Desarquivar", entao a pessoa sabe onde ela estava.
    if (!filter.trim() && c.arquivada !== verArquivadas) return false;
    // nome OU numero — ate 02/09/2026 era `chat_name || chat_id`, entao contato COM
    // nome nunca era achado pelo numero (homologacao em producao: buscar o numero
    // da conversa recem-criada devolvia lista vazia). Numero compara so digitos,
    // pra "11 90000-0000" colado com mascara tambem achar.
    if (!conversaBateBusca(c, filter)) return false;
    if (filtroStatus && c.status !== filtroStatus) return false;
    if (filtroResps.length) {
      const ids = (c.responsaveis || []).map((r) => r.id);
      const semResp = ids.length === 0 && (filtroRespNnPura || !c.responsavel_id);
      const bate =
        (filtroResps.includes("none") && semResp) || ids.some((id) => filtroResps.includes(id));
      if (!bate) return false;
    }
    if (filtroLida === "nao" && c.nao_lidas === 0) return false;
    if (filtroLida === "lida" && c.nao_lidas > 0) return false;
    if (filtroTipo === "grupo" && !c.is_group) return false;
    if (filtroTipo === "privada" && c.is_group) return false;
    return true;
  });

  const porProviderId: Record<string, Msg> = {};
  for (const m of msgs) if (m.provider_msg_id) porProviderId[m.provider_msg_id] = m;

  // corpo da bolha: player/imagem/video/documento/local; texto com link clicavel
  function MsgBody({ m }: { m: Msg }) {
    if (m.is_deleted) {
      return <p className="italic text-muted-foreground">mensagem apagada</p>;
    }
    const texto = msgText(m);
    const placeholder = /^\[.*\]$/.test(texto);
    const media = fotoOk(urlSegura(m.media_url));

    if (m.message_type === "location" && m.content) {
      try {
        const loc = JSON.parse(m.content);
        const q = `${loc.latitude},${loc.longitude}`;
        return (
          <a href={`https://www.google.com/maps/search/?api=1&query=${q}`} target="_blank" rel="noreferrer"
             className="flex items-center gap-1.5 text-sky-700 underline">
            <MapPin className="h-4 w-4" />
            {loc.name || loc.address || "Ver localizacao no mapa"}
          </a>
        );
      } catch {}
    }
    if (media) {
      if (m.message_type === "audio" || m.message_type === "ptt") {
        // preload=metadata mostra a duracao sem tocar; audio gravado (webm/ogg de
        // MediaRecorder) vem sem duracao no cabecalho — o seek gigante forca o
        // navegador a calcular e o timeupdate devolve o cursor pro inicio.
        return (
          <audio
            controls
            preload="metadata"
            src={media}
            className="max-w-[280px]"
            onLoadedMetadata={(e) => {
              const a = e.currentTarget;
              if (!isFinite(a.duration) || a.duration === 0) {
                const volta = () => {
                  a.currentTime = 0;
                  a.removeEventListener("timeupdate", volta);
                };
                a.addEventListener("timeupdate", volta);
                a.currentTime = 1e7;
              }
            }}
          />
        );
      }
      if (m.message_type === "image" || m.message_type === "sticker") {
        return (
          <a href={media} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={media} alt="" onError={() => marcarFotoQuebrada(media)} className="max-h-64 max-w-full rounded" />
            {!placeholder && <ComTexto texto={texto} />}
          </a>
        );
      }
      if (m.message_type === "video") {
        return (
          <div>
            <video controls preload="none" src={media} className="max-h-64 max-w-full rounded" />
            {!placeholder && <ComTexto texto={texto} />}
          </div>
        );
      }
      return (
        <a href={media} target="_blank" rel="noreferrer" className="underline" onClick={(e) => e.stopPropagation()}>
          {placeholder ? "Abrir arquivo" : texto}
        </a>
      );
    }
    return <ComTexto texto={texto} />;
  }

  // PERMISSAO NA TELA (Frente M): o servidor manda (403 na rota) e a tela so
  // reflete. Lista ausente = resposta antiga do /api/perfil: cai no papel base,
  // que era o comportamento de antes. Nao inverter — ler o papel PRIMEIRO
  // esconderia o relatorio de quem tem papel nomeado com a permissao.
  const temPermissao = (p: string) =>
    (perfil?.permissoes ?? []).includes(p) || (!perfil?.permissoes && perfil?.papel === "super_admin");
  // busca do mapa de Configuracoes: compara sem acento e sem caixa (quem digita "usuários"
  // tem que achar "Usuarios e permissoes")
  const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const casaBuscaConfig = (rotulo: string) =>
    !buscaConfig.trim() || semAcento(rotulo).includes(semAcento(buscaConfig.trim()));
  // DIVIDA DECLARADA FECHADA (tranche 2, 03/09/2026): a tela decidia por `papel ===
  // "super_admin"` e MENTIA pra quem tem papel nomeado (um Supervisor com `automacao`
  // nao via "Regras automaticas" que a rota deixa ele abrir). Agora cada item e aba do
  // mapa reflete a permissao que a ROTA cobra (gerenciar_usuarios, gerenciar_etiquetas,
  // gerenciar_campos, automacao, gerenciar_canais) — o servidor segue sendo a fonte da
  // verdade (403); a tela so para de esconder. Instalar widget e Disparo em massa
  // continuam do super admin (decisao de instalacao, nao de papel).
  const podeAdministrar =
    temPermissao("gerenciar_usuarios") || temPermissao("automacao") || temPermissao("gerenciar_etiquetas");
  // Configuracoes e o mapa de TODO MUNDO (Minha conta, Respostas rapidas, Biblioteca);
  // abre na primeira aba que a pessoa administra, ou na conta dela.
  function abrirConfiguracoes() {
    setMenuPerfil(false);
    setConfigAberta(true);
    setAbaConfig(temPermissao("gerenciar_usuarios") ? "usuarios" : temPermissao("automacao") ? "automacao" : "conta");
    setSenhaMsg(null);
    // as abas de admin dependem deste carregamento; quem nao administra nada nao bate
    // nas 5 rotas de admin so pra colecionar 403. (Sem escrever o prefixo com asterisco
    // aqui: as provas tiram comentario de bloco por regex e um "/" + "*" solto engole
    // 10 mil caracteres do arquivo — prova-costuras-y ficou vermelha por isso em 03/09.)
    if (podeAdministrar) carregarAdmin();
  }

  if (!authReady) return null;
  if (!session) return <Login />;
  // Depois do 2FA (desafio ou cadastro forcado) o token vira aal2 — mas o `session`
  // de ESTADO nao troca no refresh (de proposito, ver onAuthStateChange), entao os
  // efeitos de pos-login que rodaram em aal1 e levaram 401 (perfil, politica,
  // usuarios...) nunca rodariam de novo: rodape "..."/"Usuario", super_admin sem as
  // abas de admin, tema e preferencias ignorados ate recarregar a pagina (medido em
  // producao 02/09/2026, logando com 2FA). Troca o objeto UMA vez, aqui, pra esses
  // efeitos reiniciarem com o token novo — e o unico momento em que reiniciar e o
  // comportamento desejado (a tela esta saindo do formulario do codigo).
  async function concluirMfa(qual: "desafio" | "cadastro") {
    try {
      const { data } = await authClient.auth.getSession();
      if (data.session) { sessionRef.current = data.session; setSession({ ...data.session }); }
    } catch {}
    if (qual === "desafio") setMfaPendente(false); else setMfaCadastro(false);
  }
  if (mfaPendente) return <DesafioMfa aoEntrar={() => { void concluirMfa("desafio"); }} />;
  if (mfaCadastro) return <CadastroMfa aoConcluir={() => { void concluirMfa("cadastro"); }} />;

  // ───── TRILHO ESQUERDO (tranche 2 da revisao de interface, 03/09/2026) ─────
  // Padrao de mercado (Intercom Inbox, Chatwoot, Front, Zendesk): coluna fina com ICONE +
  // ROTULO pra trocar de area — Conversas, Quadro, Relatorios, Numeros, Automacao,
  // Configuracoes. Antes esses destinos eram 5 icones sem rotulo no cabecalho da lista
  // (dependiam de hover pra dizer o que sao — achado 7 do doc). O trilho:
  //   * so de `md` pra cima e fora do embed — abaixo disso a lista precisa da largura
  //     inteira e os icones do cabecalho continuam la (md:hidden neles);
  //   * fica de pe TAMBEM nas visoes de tela cheia (quadro, relatorios, numeros, acesso),
  //     por isso elas passam por `comTrilho(...)` — trilho que some quando a pessoa
  //     troca de area nao e trilho, e um botao;
  //   * a permissao entra na CONDICAO de cada item, igual aos botoes que ele substitui.
  // `comTrilho` e funcao, nao componente: componente definido aqui dentro teria
  // identidade nova a cada render e remontaria a visao (e o poll de 3s re-renderiza).
  // `titulo` = o mesmo title dos botoes do cabecalho que o trilho substitui: e o contrato
  // dos scripts de homologacao (button[title='Quadro de funil'] etc.) — e o tooltip.
  const itensTrilho: { id: typeof visaoPainel | "automacao" | "config"; rotulo: string; titulo?: string; Icone: typeof MessageSquare; agir: () => void; href?: string }[] = [
    { id: "conversas", rotulo: "Conversas", Icone: MessageSquare, agir: () => setVisaoPainel("conversas") },
    { id: "quadro", rotulo: "Quadro", titulo: "Quadro de funil", Icone: Columns3, agir: () => setVisaoPainel("quadro") },
    ...(temPermissao("relatorios")
      ? [{ id: "relatorios" as const, rotulo: "Relatorios", Icone: BarChart3, agir: () => setVisaoPainel("relatorios") }] : []),
    ...(temPermissao("gerenciar_canais") || perfil?.papel === "super_admin"
      ? [{ id: "canais" as const, rotulo: "Numeros", titulo: "Numeros (conexao, troca de chip e templates)", Icone: Smartphone, agir: () => setVisaoPainel("canais") }] : []),
    ...(perfil?.papel === "super_admin"
      ? [{ id: "automacao" as const, rotulo: "Automacao", Icone: Workflow, agir: () => { window.location.href = "/fluxos"; }, href: "/fluxos" }] : []),
    { id: "config", rotulo: "Configuracoes", Icone: Settings, agir: abrirConfiguracoes },
  ];
  const trilho = !embed && (
    <nav aria-label="Navegacao principal"
      className="hidden w-[84px] shrink-0 flex-col items-stretch gap-0.5 border-r bg-white px-1.5 py-2 md:flex">
      {itensTrilho.map((it) => {
        const ativo = it.id === visaoPainel || (it.id === "config" && configAberta);
        const classe = `flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] font-medium leading-tight ${
          ativo ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`;
        return it.href ? (
          <a key={it.id} href={it.href} className={classe} title={`${it.rotulo} (abre em tela propria)`}>
            <it.Icone className="h-5 w-5" />
            <span className="max-w-full truncate">{it.rotulo}</span>
          </a>
        ) : (
          <button key={it.id} type="button" onClick={(e) => { e.stopPropagation(); it.agir(); }}
            title={it.titulo ?? it.rotulo} aria-label={it.titulo ?? it.rotulo}
            aria-current={ativo ? "page" : undefined} className={classe}>
            <it.Icone className="h-5 w-5" />
            <span className="max-w-full truncate">{it.rotulo}</span>
          </button>
        );
      })}
    </nav>
  );
  const comTrilho = (conteudo: React.ReactNode) => (
    <div className="flex h-screen">
      {trilho}
      <div className="min-w-0 flex-1">{conteudo}</div>
    </div>
  );

  // QUADRO (kanban) em tela cheia. Fica DEPOIS das guardas de sessao/MFA (a
  // visao herda o login do painel) e antes do layout de 3 colunas: um quadro
  // espremido em 2/3 da tela nao serve pra funil com 8 etapas.
  if (visaoPainel === "quadro" && !embed) {
    return comTrilho(
      <KanbanQuadro
        authedFetch={authedFetch}
        canais={canais}
        usuarioNome={perfil?.nome || ""}
        aoSair={() => setVisaoPainel("conversas")}
        aoAbrirConversa={(canalCartao, chatId) => {
          // a conversa quase sempre esta na lista ja carregada; quando nao esta
          // (o quadro alcanca conversa fora da janela da listagem), monta-se o
          // minimo pra abrir — as rotas por conversa leem chat_id + canal, e a
          // ficha e as mensagens vem do servidor logo em seguida.
          const achado = chats.find((c) => c.uid === `${canalCartao}:${chatId}`);
          const alvo: Chat = achado ?? {
            chat_id: chatId,
            chat_name: null,
            is_group: false,
            phone: null,
            profile_thumbnail: null,
            last_message_at: null,
            preview: null,
            status: "aberto",
            responsaveis: [],
            responsavel_id: null,
            responsavel_nome: null,
            nao_lidas: 0,
            arquivada: false,
            auto_arquivar: false,
            visibilidade: [],
            canal: canalCartao,
            uid: `${canalCartao}:${chatId}`,
          };
          setVisaoPainel("conversas");
          abrirConversa(alvo);
        }}
      />
    );
  }

  // RELATORIOS em tela cheia (Frente M). Mesmo lugar do quadro: depois das
  // guardas de sessao/MFA e antes do layout de 3 colunas. A permissao entra na
  // CONDICAO (nao so no botao): sem ela a visao nao renderiza nem por deep-link
  // de estado, e as rotas negariam com 403 de todo jeito.
  // ACESSO E SEGURANCA em tela cheia (Frente Q). Mesmo lugar das outras visoes:
  // depois das guardas de sessao/MFA. A permissao entra na CONDICAO, nao so no
  // botao — sem nenhuma das tres, a visao nao renderiza nem por estado, e as
  // rotas negariam com 403 de todo jeito.
  if (
    visaoPainel === "acesso" &&
    !embed &&
    (temPermissao("gerenciar_usuarios") || temPermissao("gerenciar_visibilidade") || perfil?.papel === "super_admin")
  ) {
    return comTrilho(
      <AdminAcesso
        authedFetch={authedFetch}
        usuarios={adminUsuarios.map((u) => ({
          id: u.id,
          nome: u.nome,
          papel: u.papel,
          ativo: u.ativo !== false,
        }))}
        canais={canais}
        meuId={session?.user?.id || ""}
        podeGerenciarUsuarios={temPermissao("gerenciar_usuarios")}
        podeGerenciarVisibilidade={temPermissao("gerenciar_visibilidade")}
        ehSuperAdmin={perfil?.papel === "super_admin"}
        usuarioInicial={acessoDe}
        aoSair={() => { setAcessoDe(""); setVisaoPainel("conversas"); }}
      />
    );
  }

  // NUMEROS (canais) em tela cheia — FRENTE Y, costura declarada pela frente U.
  // A PERMISSAO ENTRA NA CONDICAO, nao so no botao (contrato dela, e a mesma
  // disciplina das irmas): sem ela a visao nao renderiza nem por estado, e as
  // rotas de /api/canais negariam com 403 de todo jeito.
  if (
    visaoPainel === "canais" &&
    !embed &&
    (temPermissao("gerenciar_canais") || perfil?.papel === "super_admin")
  ) {
    return comTrilho(<AdminCanais authedFetch={authedFetch} aoSair={() => setVisaoPainel("conversas")} />);
  }

  if (visaoPainel === "relatorios" && !embed && temPermissao("relatorios")) {
    return comTrilho(
      <RelatoriosPainel
        authedFetch={authedFetch}
        canais={canais}
        canalInicial={filtroCanal || canal}
        podeExportar={temPermissao("relatorios_exportar")}
        podeConfigurar={temPermissao("automacao")}
        ehSuperAdmin={perfil?.papel === "super_admin"}
        departamentos={departamentos}
        aoSair={() => setVisaoPainel("conversas")}
        aoFiltrarConversas={filtrarConversasDoRelatorio}
      />
    );
  }

  return (
    // FRENTE S: `filaAberta` e `interAberto` entram na MESMA lista de popovers
    // que fecham no clique fora. Fora dela, o painel da fila ficaria aberto por
    // cima da lista de conversas sem porta de saida obvia.
    <div className="flex h-screen" onClick={() => { setMenuMsg(null); setReagindo(null); setEmojiAberto(false); setSinoAberto(false); setMenuPerfil(false); setFilaAberta(false); setInterAberto(false); setMaisComposerAberto(false); setMaisHeaderAberto(false); }}>
      {trilho}
      {/* MODO ESTREITO (02/09/2026): abaixo de `md` (o widget embutido em balao/
          painel lateral tem 400-460px) lista e conversa viram PILHA — a lista
          ocupa a largura toda e some quando uma conversa abre; o header da
          conversa ganha o botao de voltar. Nada muda de `md` pra cima. */}
      <aside className={`${active ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-r bg-white md:w-[340px]`}>
        <div className="border-b p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="min-w-0 flex-1">
              {/* uma linha so: nome longo (ex.: "Chat Expert Integrado") quebrava em duas e
                  empurrava a barra de icones — auditoria de interface 02/09/2026 */}
              <h1 className="truncate text-base font-semibold" title={NOME_PAINEL}>{NOME_PAINEL}</h1>
              <p className="text-[11px] text-muted-foreground">
                {filtroCanal
                  ? canais.find((c) => c.id === filtroCanal)?.subtitulo || rotuloDoCanal(canais, filtroCanal)
                  : canais.length > 1
                    ? `Todos os canais (${canais.length})`
                    : canais[0]?.subtitulo || SUBTITULO_CENTRAL}
              </p>
            </div>
            {/* barra do atendente. No widget embutido so fica o INICIAR CONVERSA
                (abrir conversa com numero novo e gesto de uso diario — pedido do
                Eric, 02/09/2026); fila, quadro, relatorios, numeros e sino seguem
                escondidos no embed (docs/embed-widget-estrategia.md, F5). */}
            <div className="flex items-center gap-1">
              {/* FRENTE O — INICIAR CONVERSA. Fica aqui, na barra da LISTA (nao
                  no cabecalho de uma conversa): abrir conversa e um gesto sobre
                  a caixa de entrada, nao sobre um atendimento em curso.
                  So pra quem pode enviar — botao que sempre da 403 e pior que
                  botao ausente. */}
              {temPermissao("iniciar_conversa") && !!canaisParaIniciar().length && (
                <button
                  title="Iniciar conversa com um numero novo"
                  aria-label="Iniciar conversa"
                  onClick={(e) => {
                    e.stopPropagation();
                    limparNovaConversa();
                    setNovaConversaAberta(true);
                  }}
                  className="rounded p-1 text-muted-foreground hover:bg-muted"
                >
                  <MessageSquarePlus className="h-4 w-4" />
                </button>
              )}
              {!embed && (<>
              {/* ─── FRENTE S (31/08/2026) — FILA DE ATENDIMENTO (card 86ak85nxx).
                  Fica na BARRA DO ATENDENTE, irma do sino: "estou disponivel pra
                  receber conversa nova?" e uma afirmacao sobre a caixa de
                  entrada, nao sobre um atendimento em curso.
                  So aparece quando o modulo esta LIGADO (a rota responde
                  `modulo_ativo: false` e o controle nem e desenhado) — o modulo
                  nasce desligado, e interruptor pra feature que a instalacao nao
                  usa e ruido na tela. */}
              {fila?.modulo_ativo && fila.eu && (
                <div className="relative">
                  <button
                    title={fila.eu.frase}
                    aria-label="Minha situacao na fila de atendimento"
                    onClick={(e) => { e.stopPropagation(); setFilaAberta((v) => !v); }}
                    className={`relative rounded p-1 hover:bg-muted ${
                      fila.eu.situacao === "fora"
                        ? "text-red-600"
                        : fila.eu.situacao === "pulou"
                        ? "text-amber-600"
                        : "text-muted-foreground"
                    }`}
                  >
                    {fila.eu.situacao === "pulou" ? <SkipForward className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                  </button>
                  {filaAberta && (
                    <div onClick={(e) => e.stopPropagation()}
                      className="absolute right-0 top-7 z-40 max-h-96 w-80 overflow-y-auto rounded-lg border bg-white shadow-lg">
                      <div className="border-b px-3 py-2 text-xs font-semibold">Fila de atendimento</div>
                      <div className="space-y-2 px-3 py-2">
                        <p className="text-[11px] text-muted-foreground">{fila.eu.frase}</p>
                        {/* A 0021 pendente NAO e erro: ninguem pode ter saido da
                            fila sem a tabela existir, entao "todos dentro" e a
                            verdade. A tela diz isso em vez de fingir que o
                            controle funciona. */}
                        {fila.aviso && (
                          <p className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">{fila.aviso}</p>
                        )}
                        <div className="flex flex-wrap gap-1.5">
                          {fila.eu.situacao === "fora" ? (
                            <button onClick={() => gestoFila("entrar")}
                              className="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-medium text-white">
                              Entrar na fila
                            </button>
                          ) : (
                            <button onClick={() => gestoFila("sair")}
                              className="rounded-lg border px-2.5 py-1 text-[11px] hover:bg-muted">
                              Sair da fila
                            </button>
                          )}
                          {fila.eu.situacao === "pulou" ? (
                            <button onClick={() => gestoFila("voltar")}
                              className="rounded-lg border px-2.5 py-1 text-[11px] hover:bg-muted">
                              Cancelar o pulo
                            </button>
                          ) : (
                            <button onClick={() => gestoFila("pular")} disabled={fila.eu.situacao === "fora"}
                              title="Passa a sua proxima vez sem sair da fila"
                              className="rounded-lg border px-2.5 py-1 text-[11px] hover:bg-muted disabled:opacity-40">
                              Pular a vez
                            </button>
                          )}
                        </div>
                        {/* O pulo EXPIRA (12h) — e a tela diz isso junto com a
                            hora em que foi marcado. Trava com prazo escondido e
                            trava que surpreende. */}
                        {fila.eu.situacao === "pulou" && fila.eu.pulou_desde && (
                          <p className="text-[11px] text-muted-foreground">
                            Marcado em {dataHoraCompleta(fila.eu.pulou_desde)}. A marca vale por 12h ou ate a sua vez chegar.
                          </p>
                        )}
                      </div>
                      {/* PAINEL DO GESTOR (criterio do card): quem esta na fila,
                          quem esta fora e quem pulou. So pra quem gerencia
                          usuarios — a lista diz o nome de quem nao esta
                          disponivel, e isso e informacao de gestao. */}
                      {fila.painel && (
                        <div className="border-t">
                          <p className="px-3 pt-2 text-[11px] font-semibold uppercase text-muted-foreground">
                            Time — {fila.painel.contagem.dentro} na fila · {fila.painel.contagem.pulou} pulando ·{" "}
                            {fila.painel.contagem.fora} fora
                          </p>
                          <div className="px-3 pb-2">
                            {fila.painel.linhas.map((l) => (
                              <div key={l.user_id} className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
                                <span className="truncate">
                                  {l.nome}
                                  {!l.online && <span className="text-muted-foreground"> · offline</span>}
                                </span>
                                <span className={
                                  l.situacao === "fora" ? "shrink-0 text-red-600"
                                  : l.situacao === "pulou" ? "shrink-0 text-amber-600"
                                  : "shrink-0 text-emerald-600"
                                }>
                                  {l.situacao === "fora" ? "fora" : l.situacao === "pulou" ? "pulou" : "na fila"}
                                </span>
                              </div>
                            ))}
                            {!fila.painel.linhas.length && (
                              <p className="py-1 text-[11px] text-muted-foreground">Nenhum usuario ativo cadastrado.</p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {/* porta do quadro (kanban) de funil — irma do sino, mesmo desenho
                  de botao-icone. So aparece fora do widget embutido: o embed e
                  uma conversa dentro de outro sistema, nao o painel inteiro. */}
              {/* de `md` pra cima estes 4 destinos moram no TRILHO esquerdo, com rotulo
                  (tranche 2, 03/09/2026); aqui ficam so no modo estreito, sem trilho */}
              <button title="Quadro de funil" aria-label="Quadro de funil"
                onClick={(e) => { e.stopPropagation(); setVisaoPainel("quadro"); }}
                className="rounded p-1 text-muted-foreground hover:bg-muted md:hidden">
                <Columns3 className="h-4 w-4" />
              </button>
              {/* porta dos RELATORIOS (Frente M) — irma do quadro e do sino. So
                  pra quem tem a permissao `relatorios`: botao que sempre da 403
                  e pior que botao ausente. */}
              {temPermissao("relatorios") && (
                <button title="Relatorios" aria-label="Relatorios"
                  onClick={(e) => { e.stopPropagation(); setVisaoPainel("relatorios"); }}
                  className="rounded p-1 text-muted-foreground hover:bg-muted md:hidden">
                  <BarChart3 className="h-4 w-4" />
                </button>
              )}
              {/* FRENTE Y — porta dos NUMEROS (conectar por QR, trocar de chip,
                  templates). Irma do quadro e dos relatorios, com o gate que a
                  frente U escreveu no contrato: `gerenciar_canais` OU super
                  admin. Botao que sempre da 403 e pior que botao ausente. A tela
                  segue alcancavel por `/canais` como link direto. */}
              {(temPermissao("gerenciar_canais") || perfil?.papel === "super_admin") && (
                <button title="Numeros (conexao, troca de chip e templates)" aria-label="Numeros"
                  onClick={(e) => { e.stopPropagation(); setVisaoPainel("canais"); }}
                  className="rounded p-1 text-muted-foreground hover:bg-muted md:hidden">
                  <Smartphone className="h-4 w-4" />
                </button>
              )}
              {/* porta unica da administracao — antes so pelo menu do avatar, no rodape
                  (auditoria de interface 02/09/2026) */}
              {(
                <button title="Configuracoes" aria-label="Configuracoes"
                  onClick={(e) => { e.stopPropagation(); abrirConfiguracoes(); }}
                  className="rounded p-1 text-muted-foreground hover:bg-muted md:hidden">
                  <Settings className="h-4 w-4" />
                </button>
              )}
              <div className="relative">
                <button title="Notificacoes" aria-label="Notificacoes"
                  onClick={(e) => { e.stopPropagation(); setSinoAberto((v) => !v); }}
                  className="relative rounded p-1 text-muted-foreground hover:bg-muted">
                  <Bell className="h-4 w-4" />
                  {notifs.filter((n) => !n.lida).length > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-0.5 text-[10px] font-bold text-white">
                      {notifs.filter((n) => !n.lida).length}
                    </span>
                  )}
                </button>
                {sinoAberto && (
                  <div onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-7 z-40 max-h-80 w-72 overflow-y-auto rounded-lg border bg-white shadow-lg">
                    <div className="flex items-center justify-between border-b px-3 py-2 text-xs font-semibold">
                      Notificacoes
                      {notifs.some((n) => !n.lida) && (
                        <button className="text-[11px] font-normal text-primary hover:underline"
                          onClick={async () => {
                            await authedFetch("/api/notificacoes", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
                            setNotifs((ns) => ns.map((x) => ({ ...x, lida: true })));
                            naoLidasAntes.current = 0;
                          }}>
                          marcar todas lidas
                        </button>
                      )}
                    </div>
                    {!notifs.length && <p className="px-3 py-4 text-xs text-muted-foreground">Nenhuma notificacao.</p>}
                    {notifs.map((n) => (
                      <button key={n.id} onClick={() => abrirNotificacao(n)}
                        className={`block w-full border-b px-3 py-2 text-left text-xs hover:bg-muted ${n.lida ? "opacity-60" : ""}`}>
                        <span className="flex items-start gap-1.5">
                          {!n.lida && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />}
                          <span className="min-w-0">
                            <span className="block font-medium">{n.titulo}</span>
                            {n.texto && <span className="line-clamp-2 text-muted-foreground">{n.texto}</span>}
                            <span className="text-[11px] text-muted-foreground">{dataHoraCompleta(n.criada_em)}</span>
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              </>)}
            </div>
          </div>
          {/* linha unica e compacta de filtragem (pedido do Eric 16/08): canal e
              visao (BU) dividem a MESMA linha — cada um so aparece quando existe;
              nada disso aparece no widget embutido. Desde 28/08 o canal e um
              FILTRO sobre a lista unica (todos os canais juntos), agrupado por
              dono: canais da empresa separados dos pessoais */}
          {!embed && (canais.length > 1 || visoes.length > 0) && (
          <div className="mb-2 flex items-stretch gap-1">
            {canais.length > 1 && (
              <select
                value={filtroCanal}
                onChange={(e) => setFiltroCanal(e.target.value)}
                title="Canal: mostra so as conversas desse numero/perfil"
                className={`min-w-0 flex-1 truncate rounded-lg border bg-muted px-1.5 py-1 text-[11px] font-medium ${filtroCanal ? "border-primary text-primary" : ""}`}
              >
                <option value="">Todos os canais</option>
                {gruposCanais.empresa.length && gruposCanais.pessoal.length ? (
                  <>
                    <optgroup label="Empresa">
                      {gruposCanais.empresa.map((c) => <option key={c.id} value={c.id}>{c.rotulo}</option>)}
                    </optgroup>
                    <optgroup label="Pessoal">
                      {gruposCanais.pessoal.map((c) => <option key={c.id} value={c.id}>{c.rotulo}</option>)}
                    </optgroup>
                  </>
                ) : (
                  canais.map((c) => <option key={c.id} value={c.id}>{c.rotulo}</option>)
                )}
              </select>
            )}
            {visoes.length > 0 && visaoVinculada && visoes.length === 1 ? (
              // vinculado a 1 BU so: auto-restricao redundante mas visivel —
              // o servidor ja trava sozinho, isso e so pra mostrar pro atendente
              <select
                disabled
                value={visoes[0].id}
                title="Sua visao esta travada pelo admin"
                className={`${canais.length > 1 ? "w-[42%]" : "w-full"} cursor-not-allowed rounded-lg border bg-muted px-1.5 py-1 text-[11px] font-medium opacity-70`}
              >
                <option value={visoes[0].id}>{visoes[0].nome}</option>
              </select>
            ) : visoes.length > 0 ? (
              <select
                value={visao?.contexto || ""}
                onChange={(e) => trocarVisao(e.target.value || null)}
                title="Visao: recorte da lista por contexto"
                className={`${canais.length > 1 ? "w-[42%]" : "w-full"} rounded-lg border bg-muted px-1.5 py-1 text-[11px] font-medium`}
              >
                {/* vinculado a BU: "Todas" vira "Minhas" — o servidor ja restringe
                    a uniao dos vinculos mesmo sem token de embed selecionado */}
                <option value="">{visaoVinculada ? "Minhas" : "Todas"}</option>
                {visoes.map((v) => (
                  <option key={v.id} value={v.id}>{v.nome}</option>
                ))}
              </select>
            ) : null}
          </div>
          )}
          {(filtroCanal || canal) === "apioficial" && temPermissao("gerenciar_canais") && (
            <button
              onClick={sincronizarChatGuru}
              disabled={sincronizando}
              title="Puxa do ChatGuru o que o webhook nao entrega (ex: mensagens enviadas por la)"
              className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${sincronizando ? "animate-spin" : ""}`} />
              {sincronizando ? "Sincronizando com o ChatGuru..." : "Sincronizar ChatGuru"}
            </button>
          )}
          <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input className="w-full bg-transparent text-sm outline-none"
              placeholder="Buscar conversa (Enter busca nas mensagens)"
              value={filter} onChange={(e) => { setFilter(e.target.value); if (!e.target.value) setBuscaResultados(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") buscarMensagens(); }} />
            {buscaResultados !== null && (
              <button onClick={() => setBuscaResultados(null)} className="shrink-0 rounded p-0.5 hover:bg-black/10"
                title="Fechar busca nas mensagens">
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
            <button type="button" onClick={() => setFiltrosAbertos((v) => !v)}
              title={filtrosAbertos ? "Esconder filtros" : "Filtros da lista"}
              aria-expanded={filtrosAbertos}
              className={`relative shrink-0 rounded p-0.5 hover:bg-black/10 ${filtrosAbertos || filtrosAtivos ? "text-primary" : "text-muted-foreground"}`}>
              <SlidersHorizontal className="h-4 w-4" />
              {filtrosAtivos > 0 && (
                <span className="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-primary px-0.5 text-[10px] font-bold text-white">
                  {filtrosAtivos}
                </span>
              )}
            </button>
          </div>
          <button
            onClick={() => setVerArquivadas((v) => !v)}
            className={`mt-2 flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-medium ${
              verArquivadas ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            <span className="flex items-center gap-2">
              <Archive className="h-4 w-4" />
              {verArquivadas ? "Voltar as conversas ativas" : "Arquivados"}
            </span>
            {!verArquivadas && arquivadasQtd > 0 && (
              <span className="rounded-full bg-white px-1.5 py-0.5 text-[11px] font-bold text-muted-foreground">
                {arquivadasQtd}
              </span>
            )}
          </button>
          {filtrosAbertos && (
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <select value={filtroStatus} onChange={(e) => setFiltroStatus(e.target.value)}
              className="min-w-0 rounded-lg border bg-white px-1.5 py-1 text-[11px] outline-none">
              <option value="">Status: todos</option>
              <option value="aberto">Em aberto</option>
              <option value="atendimento">Em atendimento</option>
              <option value="aguardando">Aguardando</option>
              <option value="concluido">Concluido</option>
            </select>
            <div className="relative min-w-0 flex-1">
              <button
                onClick={() => setFiltroRespAberto((v) => !v)}
                className={`w-full truncate rounded-lg border px-1.5 py-1 text-left text-[11px] outline-none ${
                  filtroResps.length ? "border-primary bg-primary/10 font-medium text-primary" : "bg-white"
                }`}
              >
                {filtroResps.length ? `Resp: ${filtroResps.length}` : "Responsavel: todos"}
              </button>
              {filtroRespAberto && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setFiltroRespAberto(false)} />
                  <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-56 overflow-y-auto rounded-lg border bg-white p-2 text-[11px] shadow-lg">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase text-muted-foreground">
                        Marque quantos quiser
                      </span>
                      {filtroResps.length > 0 && (
                        <button onClick={() => { setFiltroResps([]); setFiltroRespNnPura(false); }} className="text-[11px] font-medium text-primary hover:underline">
                          Limpar
                        </button>
                      )}
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted">
                      <input type="checkbox" checked={filtroResps.includes("none")} onChange={() => alternarFiltroResp("none")} />
                      Sem responsavel
                    </label>
                    <p className="mt-1 px-1 text-[11px] font-semibold uppercase text-muted-foreground">Departamentos</p>
                    {departamentos.map((d) => (
                      <label key={d.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted">
                        <input type="checkbox" checked={filtroResps.includes(d.id)} onChange={() => alternarFiltroResp(d.id)} />
                        <span className="truncate">{d.nome}</span>
                      </label>
                    ))}
                    <p className="mt-1 px-1 text-[11px] font-semibold uppercase text-muted-foreground">Pessoas</p>
                    {users.map((u) => (
                      <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted">
                        <input type="checkbox" checked={filtroResps.includes(u.id)} onChange={() => alternarFiltroResp(u.id)} />
                        <AvatarPessoa nome={u.nome} foto={u.foto_url} tamanho="h-5 w-5" texto="text-[10px]" />
                        <span className="truncate">{u.nome}</span>
                      </label>
                    ))}
                    {respSemConta.map((u) => (
                      <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted">
                        <input type="checkbox" checked={filtroResps.includes(u.id)} onChange={() => alternarFiltroResp(u.id)} />
                        <span className="truncate text-muted-foreground">{u.nome}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
            <select value={filtroLida} onChange={(e) => setFiltroLida(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border bg-white px-1.5 py-1 text-[11px] outline-none">
              <option value="">Todas</option>
              <option value="nao">Nao lidas</option>
              <option value="lida">Lidas</option>
            </select>
            <select value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border bg-white px-1.5 py-1 text-[11px] outline-none">
              <option value="">Tipo: todos</option>
              <option value="privada">Conversas</option>
              <option value="grupo">Grupos</option>
            </select>
          </div>
          )}
          {/* selecao em massa (visibilidade/auto-arquivar): so super admin, so tela cheia */}
          {!embed && perfil?.papel === "super_admin" && (
            <button
              onClick={() => (modoSelecao ? sairDoModoSelecao() : setModoSelecao(true))}
              className={`mt-1.5 w-full rounded-lg border px-2 py-1 text-[11px] font-medium ${
                modoSelecao ? "border-primary bg-primary/10 text-primary" : "bg-white text-muted-foreground hover:bg-muted"}`}
            >
              {modoSelecao ? "Cancelar selecao" : "Selecionar"}
            </button>
          )}
        </div>
        {/* ─── FRENTE S (31/08/2026) — A FILA CAIU, E ISSO APARECE.
            Achado da revisao cega: com o modulo LIGADO e a tabela ilegivel, o
            rodizio recusa distribuir (`fila_indisponivel`, freio que nao falha
            aberto) e ninguem na tela ficava sabendo — conversa nova entrava sem
            responsavel e a operacao acharia que "parou de chegar". A faixa fica
            no TOPO DA LISTA, que e onde a conversa orfa aparece.
            A 0021 pendente e caso DIFERENTE e nao leva faixa vermelha: nesse caso
            o rodizio distribui normalmente (ninguem pode ter saido de uma fila
            cuja tabela nao existe) — o painel da fila ja explica isso em ambar. */}
        {fila?.modulo_ativo && fila.fila_indisponivel && (
          <div className="border-b border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-800">
            <span className="font-semibold">Fila de atendimento indisponivel.</span>{" "}
            Conversa nova NAO esta sendo distribuida automaticamente — ela chega sem responsavel e fica
            visivel pra todos. Assuma manualmente enquanto isso.
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {buscaResultados !== null && (
            <div>
              <p className="border-b px-3 py-2 text-[11px] font-semibold uppercase text-muted-foreground">
                {buscando ? "Buscando nas mensagens..." : `${buscaResultados.length} mensagem(ns) encontrada(s)`}
              </p>
              {buscaResultados.map((r, i) => (
                <button key={`${r.chat_id}-${i}`}
                  onClick={() => {
                    const alvo = acharChat(chats, r.chat_id, r.canal);
                    if (alvo) { abrirConversa(alvo); }
                    else setAviso("Conversa fora da lista atual — limpe filtros e tente de novo.");
                  }}
                  className="block w-full border-b px-3 py-2.5 text-left hover:bg-muted">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="truncate text-xs font-medium">{r.chat_name}</span>
                      {canais.length > 1 && (
                        <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] font-medium text-muted-foreground">
                          {rotuloDoCanal(canais, r.canal)}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{fmtTime(r.quando)}</span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {r.de ? `${r.de}: ` : ""}{r.trecho}
                  </p>
                </button>
              ))}
            </div>
          )}
          {buscaResultados === null && visible.map((c) => (
            <button key={c.uid}
              onClick={() => (modoSelecao ? alternarSelecionado(c.uid) : abrirConversa(c))}
              className={`flex w-full items-center gap-3 border-b px-3 py-3 text-left hover:bg-muted ${
                active?.uid === c.uid ? "bg-accent" : ""}`}>
              {modoSelecao && (
                <input type="checkbox" checked={selecionados.includes(c.uid)} readOnly
                  className="pointer-events-none h-4 w-4 shrink-0" />
              )}
              {fotoOk(c.profile_thumbnail) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.profile_thumbnail!} alt="" onError={() => marcarFotoQuebrada(c.profile_thumbnail!)}
                  className="h-11 w-11 shrink-0 rounded-full object-cover" />
              ) : (
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                  {c.is_group ? <Users className="h-5 w-5" /> : initials(c.chat_name || c.chat_id)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <span className="flex items-center gap-1">
                  <span className="truncate text-sm font-medium">{c.chat_name || c.chat_id}</span>
                  {canais.length > 1 && (
                    <span title={`Canal: ${rotuloDoCanal(canais, c.canal)}`}
                      className="shrink-0 rounded bg-muted px-1 py-px text-[10px] font-medium text-muted-foreground">
                      {rotuloDoCanal(canais, c.canal)}
                    </span>
                  )}
                  {c.auto_arquivar && (
                    <span title="Arquivamento automatico" className="shrink-0">
                      <Archive className="h-2.5 w-2.5 text-muted-foreground" />
                    </span>
                  )}
                  {(c.visibilidade?.length ?? 0) > 0 && (
                    <span title="Visibilidade restrita" className="shrink-0">
                      <Lock className="h-2.5 w-2.5 text-muted-foreground" />
                    </span>
                  )}
                  {/* 0017 (Frente O): conversa que o painel abriu e o provedor
                      recusou. Sem o selo, a linha e indistinguivel de conversa
                      normal — e a mensagem nunca chegou ao cliente. */}
                  {c.inicio_estado === "falha_envio" && (
                    <span
                      title="A primeira mensagem desta conversa nao foi enviada — o provedor recusou"
                      className="shrink-0 rounded bg-red-100 px-1 py-0.5 text-[8px] font-bold text-red-700"
                    >
                      NAO ENVIADA
                    </span>
                  )}
                  {/* `reservado` = envio EM CURSO (ou reserva orfa que a 0017
                      ainda vai varrer aos 10min). Sem este selo o estado
                      intermediario ficava invisivel, e a conversa aparecia como
                      normal antes de existir mensagem nenhuma. */}
                  {c.inicio_estado === "reservado" && (
                    <span
                      title="A primeira mensagem desta conversa esta sendo enviada"
                      className="shrink-0 rounded bg-amber-100 px-1 py-0.5 text-[8px] font-bold text-amber-700"
                    >
                      ENVIANDO
                    </span>
                  )}
                </span>
                <p className="truncate text-xs text-muted-foreground">{c.preview}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_INFO[c.status]?.pill || "bg-red-100 text-red-700"}`}>
                  {STATUS_INFO[c.status]?.curto || "ABERTO"}
                </span>
                <div className="flex items-center gap-1.5">
                  {c.nao_lidas > 0 && (
                    <span className="min-w-[20px] rounded-full bg-red-500 px-1.5 py-0.5 text-center text-[11px] font-bold leading-none text-white">
                      {c.nao_lidas > 99 ? "99+" : c.nao_lidas}
                    </span>
                  )}
                  <span className="text-[11px] text-muted-foreground">{fmtTime(c.last_message_at)}</span>
                </div>
              </div>
            </button>
          ))}
          {/* ALEM DA JANELA (03/09/2026): com texto na busca, o servidor varre o acervo
              inteiro (nome ou numero) e o que achar entra na lista; sem texto, a
              pessoa puxa a proxima pagina de conversas mais antigas do(s) canal(is)
              em foco. "Carregando conversas..." so vale ANTES da 1a resposta — a
              lista vazia por causa da busca diz isso, em vez de fingir que carrega. */}
          {buscaResultados === null && !visible.length && (
            <p className="p-6 text-center text-sm text-muted-foreground" role="status">
              {!chats.length
                ? "Carregando conversas..."
                : buscandoAcervo
                  ? "Buscando no acervo..."
                  : filter.trim()
                    ? "Nenhuma conversa com esse nome ou numero."
                    : "Nenhuma conversa aqui."}
            </p>
          )}
          {buscaResultados === null && !!visible.length && filter.trim() && buscandoAcervo && (
            <p className="px-3 py-2 text-center text-[11px] text-muted-foreground" role="status">Buscando no acervo...</p>
          )}
          {buscaResultados === null && !filter.trim() && canaisComMaisAntigas.length > 0 && (
            <button
              type="button"
              onClick={carregarMaisAntigas}
              disabled={carregandoMais}
              className="m-2 flex w-[calc(100%-1rem)] items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-60"
            >
              {carregandoMais ? "Carregando mais antigas..." : "Carregar conversas mais antigas"}
            </button>
          )}
        </div>

        {/* barra fixa da selecao em massa: visibilidade e auto-arquivar pra N chats de uma vez */}
        {modoSelecao && (
          <div className="border-t bg-white p-2 text-xs">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="font-medium">{selecionados.length} selecionado(s)</span>
              <button onClick={sairDoModoSelecao} className="text-[11px] text-muted-foreground hover:underline">
                Cancelar
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button disabled={!selecionados.length}
                onClick={() => setPainelVisMassa((v) => !v)}
                className={`rounded-lg border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50 ${
                  painelVisMassa ? "border-primary bg-primary/10 text-primary" : ""}`}>
                Visibilidade
              </button>
              <button disabled={!selecionados.length || aplicandoMassa}
                onClick={() => aplicarAutoArquivarMassa(true)}
                className="rounded-lg border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50">
                Auto-arq. ON
              </button>
              <button disabled={!selecionados.length || aplicandoMassa}
                onClick={() => aplicarAutoArquivarMassa(false)}
                className="rounded-lg border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50">
                Auto-arq. OFF
              </button>
              {/* ACOES EM MASSA (Eric 17/08/2026): status, responsavel e arquivo pra N conversas */}
              <button disabled={!selecionados.length || aplicandoMassa}
                onClick={() => aplicarMassa({ arquivada: true }, "Arquivadas:")}
                className="rounded-lg border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50">
                Arquivar
              </button>
              <button disabled={!selecionados.length || aplicandoMassa}
                onClick={() => aplicarMassa({ arquivada: false }, "Desarquivadas:")}
                className="rounded-lg border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50">
                Desarquivar
              </button>
              <select value="" disabled={!selecionados.length || aplicandoMassa} title="Mudar o status das selecionadas"
                onChange={(e) => { const v = e.target.value; if (v) aplicarMassa({ status: v }, `Status "${STATUS_INFO[v as StatusAtendimento]?.label || v}" em`); }}
                className="rounded-lg border bg-white px-2 py-1 text-[11px] font-medium outline-none disabled:opacity-50">
                <option value="">Status...</option>
                <option value="aberto">Em aberto</option>
                <option value="atendimento">Em atendimento</option>
                <option value="aguardando">Aguardando</option>
                <option value="concluido">Concluido</option>
              </select>
              <select value="" disabled={!selecionados.length || aplicandoMassa} title="Atribuir responsavel as selecionadas"
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  if (v === "none") return void aplicarMassa({ limpar_responsaveis: true }, "Responsaveis removidos de");
                  const [tipo, id] = v.split(":");
                  const lista = tipo === "dep" ? departamentos : users;
                  const alvo = lista.find((x) => x.id === id);
                  if (!alvo) return;
                  aplicarMassa(
                    { add_responsavel: { tipo: tipo === "dep" ? "departamento" : "usuario", id: alvo.id, nome: alvo.nome } },
                    `${alvo.nome} atribuido(a) em`
                  );
                }}
                className="max-w-[170px] rounded-lg border bg-white px-2 py-1 text-[11px] font-medium outline-none disabled:opacity-50">
                <option value="">Responsavel...</option>
                <option value="none">Tirar todos os responsaveis</option>
                {departamentos.map((d) => (
                  <option key={`dep:${d.id}`} value={`dep:${d.id}`}>{d.nome} (departamento)</option>
                ))}
                {users.map((u) => (
                  <option key={`usr:${u.id}`} value={`usr:${u.id}`}>{u.nome}</option>
                ))}
              </select>
            </div>

            {painelVisMassa && (
              <div className="mt-2 space-y-1.5 rounded-lg border bg-muted p-2">
                <div className="flex gap-1 rounded-lg bg-white p-0.5">
                  {(["set", "add"] as const).map((m) => (
                    <button key={m} onClick={() => setVisMassaModo(m)}
                      className={`flex-1 rounded-md px-1.5 py-1 text-[11px] font-medium ${
                        visMassaModo === m ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
                      {m === "set" ? "Substituir" : "Adicionar"}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1">
                  {!visMassaItens.length && <span className="text-[11px] text-muted-foreground">Nenhum item</span>}
                  {visMassaItens.map((v) => (
                    <span key={`${v.tipo}:${v.id}`}
                      className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                        v.tipo === "departamento" ? "bg-violet-100 text-violet-700"
                        : v.tipo === "contexto" ? "bg-amber-100 text-amber-700"
                        : "bg-primary/10 text-primary"}`}>
                      {v.nome}
                      <button
                        onClick={() => setVisMassaItens((its) => its.filter((x) => !(x.tipo === v.tipo && x.id === v.id)))}
                        className="rounded-full hover:bg-black/10">
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
                <select
                  value=""
                  onChange={(e) => {
                    const [tipo, id] = e.target.value.split(":");
                    if (!tipo) return;
                    const listaBu = visoes.length ? visoes : visBuFallback || [];
                    const lista = tipo === "bu" ? listaBu : tipo === "dep" ? departamentos : users;
                    const alvo = lista.find((x) => x.id === id);
                    if (!alvo) return;
                    const vtipo: VisResp["tipo"] = tipo === "bu" ? "contexto" : tipo === "dep" ? "departamento" : "usuario";
                    setVisMassaItens((its) =>
                      its.some((x) => x.tipo === vtipo && x.id === alvo.id) ? its : [...its, { tipo: vtipo, id: alvo.id, nome: alvo.nome }]
                    );
                  }}
                  className="w-full rounded-lg border bg-white px-2 py-1 text-[11px] outline-none"
                >
                  <option value="">+ adicionar (BU, departamento ou pessoa)</option>
                  <optgroup label="BUs">
                    {(visoes.length ? visoes : visBuFallback || []).map((v) => <option key={v.id} value={`bu:${v.id}`}>{v.nome}</option>)}
                  </optgroup>
                  <optgroup label="Departamentos">
                    {departamentos.map((d) => <option key={d.id} value={`dep:${d.id}`}>{d.nome}</option>)}
                  </optgroup>
                  <optgroup label="Pessoas">
                    {users.map((u) => <option key={u.id} value={`usr:${u.id}`}>{u.nome}</option>)}
                  </optgroup>
                </select>
                <p className="text-[11px] text-muted-foreground">
                  Vazio = todos veem. Substituir troca a lista inteira; adicionar so acrescenta.
                </p>
                <button
                  onClick={aplicarVisibilidadeMassa}
                  disabled={aplicandoMassa || (visMassaModo === "add" && !visMassaItens.length)}
                  className="w-full rounded-lg bg-primary px-2 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
                >
                  Aplicar a {selecionados.length} conversa(s)
                </button>
              </div>
            )}
          </div>
        )}

        {/* perfil no rodape esquerdo (estilo ChatGuru); config so pra admin.
            Some no widget embutido: sem ele os modais de config/admin/relatorio
            ficam inacessiveis (nada mais abre setConfigAberta). */}
        {!embed && (
        <div className="relative border-t bg-white px-3 py-2">
          {menuPerfil && (
            <div onClick={(e) => e.stopPropagation()}
              className="absolute bottom-12 left-3 z-40 w-56 overflow-hidden rounded-lg border bg-white text-xs shadow-lg">
              {/* tema direto no menu do usuario */}
              <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="text-muted-foreground">Tema</span>
                <div className="flex gap-1">
                  <button title="Tema claro" onClick={() => trocarTema("claro")}
                    className={`rounded-md border p-1.5 ${perfil?.tema !== "escuro" ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}>
                    <Sun className="h-3.5 w-3.5" />
                  </button>
                  <button title="Tema escuro" onClick={() => trocarTema("escuro")}
                    className={`rounded-md border p-1.5 ${perfil?.tema === "escuro" ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}>
                    <Moon className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <button
                onClick={abrirMeuPerfil}
                className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted">
                <Users className="h-3.5 w-3.5" /> Meu perfil
              </button>
              <a href={FAQ_URL} target="_blank" rel="noreferrer noopener"
                onClick={() => setMenuPerfil(false)}
                className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted">
                <HelpCircle className="h-3.5 w-3.5" /> Ajuda (FAQ)
              </a>
              <button
                onClick={abrirConfiguracoes}
                className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted">
                <Settings className="h-3.5 w-3.5" /> Configuracoes
              </button>
              <button onClick={() => authClient.auth.signOut()}
                className="flex w-full items-center gap-2 px-3 py-2 text-red-600 hover:bg-red-50">
                <LogOut className="h-3.5 w-3.5" /> Sair
              </button>
            </div>
          )}
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuPerfil((v) => !v); }}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-muted"
              title="Perfil"
            >
              <AvatarPessoa nome={perfil?.nome || "?"} foto={perfil?.foto_url} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{perfil?.nome || "..."}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {perfil?.papel === "super_admin" ? "Super admin" : perfil?.departamentos?.length ? perfil.departamentos.join(", ") : "Usuario"}
                </span>
              </span>
              <MoreVertical className="h-4 w-4 text-muted-foreground" />
            </button>
            <a href={FAQ_URL} target="_blank" rel="noreferrer noopener"
              onClick={(e) => e.stopPropagation()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-primary"
              title="Ajuda (FAQ) — como usar o painel">
              <HelpCircle className="h-4.5 w-4.5" />
            </a>
          </div>
        </div>
        )}
        {/* EMBED (conferencia 3 de docs/embed-widget-estrategia.md, 02/09/2026): a moldura
            mostra so o uso diario — a ponte barata pra ninguem se sentir trancado e este link. */}
        {embed && (
          <div className="border-t bg-white px-3 py-1.5 text-[11px] text-muted-foreground">
            <a href="/" target="_blank" rel="noreferrer noopener" className="hover:text-primary hover:underline">
              Abrir o painel completo em outra aba
            </a>
          </div>
        )}
      </aside>

      <main className={`${active ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col bg-[#efeae2]`}>
        {active ? (
          <>
            {/* BREAKPOINTS EM CASCATA (medido 02/09/2026): `md` (768) so decide as
                DUAS COLUNAS; o cabecalho e o composer olham pra `lg` (1024) e o
                responsavel inline pra `xl` (1280), porque a coluna da conversa e
                viewport - 340px — em 800px de janela o main tem 460px e o
                cabecalho de desktop (527px de acoes) vazava 155px pra fora. */}
            <header className="relative flex items-center gap-2 border-b bg-white px-3 py-3 lg:gap-3 lg:px-4">
              <button
                onClick={() => setActive(null)}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted md:hidden"
                title="Voltar pra lista"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              {fotoOk(urlSegura(active.profile_thumbnail)) ? (
                <button type="button" title="Ampliar foto"
                  onClick={(e) => { e.stopPropagation(); setFotoAmpliada(active.profile_thumbnail!); }}
                  className="shrink-0 rounded-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={active.profile_thumbnail!} alt="" onError={() => marcarFotoQuebrada(active.profile_thumbnail!)}
                    className="h-10 w-10 rounded-full object-cover" />
                </button>
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                  {active.is_group ? <Users className="h-4 w-4" /> : active.chat_name ? initials(active.chat_name) : <MessageSquare className="h-4 w-4" />}
                </div>
              )}
              <button
                onClick={() => { setFichaAberta((v) => !v); if (!ficha) carregarFicha(active.chat_id); }}
                className="min-w-0 flex-1 rounded px-1 py-0.5 text-left hover:bg-muted"
                title="Ver ficha do contato"
              >
                <p className="truncate text-sm font-semibold">{active.chat_name || active.chat_id}</p>
                {/* o id (telefone ou id de grupo) so cabe de `lg` pra cima — em 400px
                    ele quebrava em duas linhas por baixo dos botoes */}
                <p className="hidden truncate text-[11px] text-muted-foreground lg:block">{active.chat_id}</p>
              </button>
              <div className="flex shrink-0 items-center gap-1.5 lg:gap-2">
                <span className={`hidden h-2.5 w-2.5 rounded-full lg:block ${STATUS_INFO[active.status]?.dot || "bg-red-500"}`} />
                {/* FRENTE O — buscar DENTRO da conversa. Abre a faixa de busca
                    logo abaixo do cabecalho; fechar limpa o resultado. */}
                <button
                  onClick={() => {
                    if (buscaConversa === null) setBuscaConversa("");
                    else {
                      setBuscaConversa(null);
                      setAchadosConversa(null);
                      setAvisoBuscaConversa(null);
                    }
                  }}
                  title="Buscar nesta conversa"
                  className={`rounded p-1.5 hover:bg-muted ${buscaConversa !== null ? "bg-muted text-primary" : "text-muted-foreground"}`}
                >
                  <Search className="h-4 w-4" />
                </button>
                {/* FRENTE O — robo por conversa. So aparece quando a instalacao
                    tem a coluna (migration 0017): botao que aceita o clique e
                    nao grava e pior que botao ausente — a pessoa sairia achando
                    que desligou a automacao. */}
                {robo?.disponivel && (
                  <button
                    onClick={alternarRobo}
                    title={
                      robo.bot_ativo
                        ? "A automacao pode agir sozinha nesta conversa — clique pra desligar"
                        : `Automacao DESLIGADA nesta conversa${robo.alterado_por_nome ? ` (por ${robo.alterado_por_nome})` : ""} — clique pra ligar. Macro disparado a mao continua funcionando.`
                    }
                    className={`hidden rounded p-1.5 lg:block ${robo.bot_ativo ? "text-muted-foreground hover:bg-muted" : "bg-amber-100 text-amber-700 hover:bg-amber-200"}`}
                  >
                    {robo.bot_ativo ? <Bot className="h-4 w-4" /> : <BotOff className="h-4 w-4" />}
                  </button>
                )}
                <button
                  onClick={() => atualizarConversa({ arquivada: !active.arquivada })}
                  title={active.arquivada ? "Desarquivar conversa" : "Arquivar conversa"}
                  className="hidden rounded p-1.5 text-muted-foreground hover:bg-muted lg:block"
                >
                  {active.arquivada ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                </button>
                <select value={active.status}
                  onChange={(e) => atualizarConversa({ status: e.target.value as StatusAtendimento })}
                  className={`max-w-[124px] rounded-lg border px-2 py-1.5 text-xs font-medium outline-none lg:max-w-none ${STATUS_INFO[active.status]?.pill || ""}`}>
                  <option value="aberto">Em aberto</option>
                  <option value="atendimento">Em atendimento</option>
                  <option value="aguardando">Aguardando</option>
                  <option value="concluido">Concluido</option>
                </select>
                {/* MODO ESTREITO: as acoes secundarias (robo, arquivar, responsavel)
                    moram atras de um "⋮" — no cabecalho de 400px elas se
                    sobrepunham ao nome do contato. Robo e arquivar saem do menu em
                    `lg` (ja estao inline); o responsavel so em `xl` — por isso o
                    "⋮" vive ate `xl`, e entre `lg` e `xl` ele so tem o responsavel. */}
                <button
                  onClick={(e) => { e.stopPropagation(); setMaisHeaderAberto((v) => !v); }}
                  title="Mais acoes"
                  className={`rounded p-1.5 xl:hidden ${maisHeaderAberto ? "bg-muted text-primary" : "text-muted-foreground hover:bg-muted"}`}
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
                {maisHeaderAberto && (
                  <div onClick={(e) => e.stopPropagation()}
                    className="absolute right-2 top-full z-30 mt-1 w-56 overflow-hidden rounded-xl border bg-white py-1 text-sm shadow-lg xl:hidden">
                    {robo?.disponivel && (
                      <button onClick={() => { alternarRobo(); setMaisHeaderAberto(false); }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted lg:hidden">
                        {robo.bot_ativo ? <Bot className="h-4 w-4" /> : <BotOff className="h-4 w-4 text-amber-700" />}
                        {robo.bot_ativo ? "Desligar automacao aqui" : "Ligar automacao aqui"}
                      </button>
                    )}
                    <button onClick={() => { atualizarConversa({ arquivada: !active.arquivada }); setMaisHeaderAberto(false); }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted lg:hidden">
                      {active.arquivada ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                      {active.arquivada ? "Desarquivar conversa" : "Arquivar conversa"}
                    </button>
                    <button onClick={() => { setFichaAberta(true); setAbaFicha("dados"); if (!ficha) carregarFicha(active.chat_id); setMaisHeaderAberto(false); }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted">
                      <UserCheck className="h-4 w-4" />
                      <span className="truncate">
                        {(active.responsaveis?.length || 0) > 0
                          ? `Responsavel: ${active.responsaveis.map((r) => r.nome).join(", ")}`
                          : "Definir responsavel"}
                      </span>
                    </button>
                  </div>
                )}
                {/* etiqueta UNICA com todos os responsaveis (virgula); gerenciar = ficha.
                    Com a ficha ABERTA a etiqueta e o "+ responsavel" somem mesmo em `xl`:
                    a ficha ja mostra e gerencia os responsaveis, e a coluna da conversa
                    cai pra 600px em 1280 — medido, os dois inline vazavam 15px. */}
                {(active.responsaveis?.length || 0) > 0 && (
                  <button
                    onClick={() => { setFichaAberta(true); setAbaFicha("dados"); }}
                    title={`Responsaveis: ${active.responsaveis.map((r) => r.nome).join(", ")} — clique pra gerenciar`}
                    className={`${fichaAberta ? "hidden" : "hidden xl:block"} max-w-[260px] truncate rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/20`}
                  >
                    {active.responsaveis.map((r) => r.nome).join(", ")}
                  </button>
                )}
                <select value=""
                  onChange={(e) => adicionarResponsavel(e.target.value)}
                  className={`${fichaAberta ? "hidden" : "hidden xl:block"} max-w-[140px] rounded-lg border bg-muted px-2 py-1.5 text-xs outline-none`}>
                  <option value="">+ responsavel</option>
                  <optgroup label="Departamentos">
                    {departamentos
                      .filter((d) => !active.responsaveis?.some((r) => r.tipo === "departamento" && r.id === d.id))
                      .map((d) => <option key={d.id} value={`dep:${d.id}`}>{d.nome}</option>)}
                  </optgroup>
                  <optgroup label="Pessoas">
                    {users
                      .filter((u) => !active.responsaveis?.some((r) => r.tipo === "usuario" && r.id === u.id))
                      .map((u) => <option key={u.id} value={`usr:${u.id}`}>{u.nome}</option>)}
                  </optgroup>
                </select>
              </div>
            </header>

            {/* FRENTE O — faixa de busca DENTRO da conversa.
                A busca vai ao BANCO (todas as mensagens da conversa), nao ao que
                a tela tem em maos: por isso ela acha coisa antiga que o clique
                de "pular" nao alcanca, e por isso o aviso existe. */}
            {buscaConversa !== null && (
              <div className="border-b bg-white px-4 py-2">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    rodarBuscaConversa(buscaConversa);
                  }}
                  className="flex items-center gap-2"
                >
                  <div className="flex flex-1 items-center gap-2 rounded-lg bg-muted px-3 py-1.5">
                    <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <input
                      autoFocus
                      value={buscaConversa}
                      onChange={(e) => setBuscaConversa(e.target.value)}
                      placeholder={`Buscar nesta conversa (min. ${MIN_TERMO_BUSCA} letras)`}
                      className="w-full bg-transparent text-sm outline-none"
                    />
                    {buscaConversa && (
                      <button
                        type="button"
                        onClick={() => {
                          setBuscaConversa("");
                          setAchadosConversa(null);
                          setAvisoBuscaConversa(null);
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:bg-white"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <button
                    type="submit"
                    disabled={buscandoConversa || buscaConversa.trim().length < MIN_TERMO_BUSCA}
                    className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {buscandoConversa ? "Buscando..." : "Buscar"}
                  </button>
                </form>
                {avisoBuscaConversa && (
                  <p className="mt-1.5 text-[11px] text-amber-700">{avisoBuscaConversa}</p>
                )}
                {achadosConversa && (
                  <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border">
                    {!achadosConversa.length ? (
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        Nada encontrado nesta conversa.
                      </p>
                    ) : (
                      <>
                        <p className="border-b bg-muted/50 px-3 py-1 text-[11px] font-medium text-muted-foreground">
                          {achadosConversa.length} mensagem(ns)
                        </p>
                        {achadosConversa.map((a) => (
                          <button
                            key={a.id}
                            onClick={() => pularParaMensagem(a.id)}
                            className="flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted"
                          >
                            <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                              <span>{dataHoraCompleta(a.criada_em)}</span>
                              {a.autor && <span className="truncate">· {a.autor}</span>}
                              {a.direcao === "interna" && <span className="text-amber-700">· anotacao</span>}
                              {a.apagada && <span className="text-red-600">· apagada</span>}
                            </span>
                            <span className="line-clamp-2 text-xs">
                              {a.cortou_inicio && "..."}
                              {a.trecho}
                              {a.cortou_fim && "..."}
                            </span>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex-1 space-y-1.5 overflow-y-auto px-6 py-4">
              {msgs.map((m, idx) => {
                const citada = m.quoted_msg_id ? porProviderId[m.quoted_msg_id] : null;
                const podeMexer = canal === "central" && m.from_me && !m.is_deleted && m.provider_msg_id;
                const reagivel = podeReagir(fonteDoCanalAtivo(), m);
                const anterior = idx > 0 ? msgs[idx - 1] : null;
                // o corte de dia e o da INSTALACAO (era o do navegador, via
                // toDateString): o divisor tem que cair no mesmo lugar pra todo
                // mundo do time, e casar com o rotulo Hoje/Ontem logo abaixo
                const mudouDia =
                  !anterior || !mesmoDiaNoFuso(new Date(anterior.message_ts), new Date(m.message_ts), FUSO_UI);
                // anotacao interna: card amarelo no fluxo (nao e mensagem do WhatsApp)
                if (m.interna) {
                  return (
                    <div key={m.id}>
                      {mudouDia && (
                        <div className="my-3 flex justify-center">
                          <span className="rounded-full bg-white/80 px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
                            {rotuloDia(m.message_ts)}
                          </span>
                        </div>
                      )}
                      <div className="my-1 flex justify-center">
                        {/* mesma ancora da bolha: a busca escopada acha anotacao
                            interna tambem, e o clique tem que pousar nela */}
                        <div id={`msg-${m.id}`} className="max-w-[70%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs shadow-sm">
                          <p className="mb-0.5 font-semibold text-amber-800">
                            Anotacao — {m.enviado_por_nome || m.sender_name || "sistema"}
                          </p>
                          <p className="whitespace-pre-wrap break-words">{m.content}</p>
                          <p className="mt-0.5 text-right text-[11px] text-amber-800/70">{fmtTime(m.message_ts)}</p>
                        </div>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={m.id}>
                  {mudouDia && (
                    <div className="my-3 flex justify-center">
                      <span className="rounded-full bg-white/80 px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
                        {rotuloDia(m.message_ts)}
                      </span>
                    </div>
                  )}
                  <div className={`group flex ${m.from_me ? "justify-end" : "justify-start"}`}>
                    {/* `id` na BOLHA (Frente O): e a ancora do "pular pra
                        mensagem" da busca escopada e da galeria de midia. Fica na
                        bolha, e nao no wrapper do dia, pra o realce cercar a
                        mensagem e nao o separador de data. */}
                    <div
                      id={`msg-${m.id}`}
                      className={`relative max-w-[65%] rounded-lg px-3 py-1.5 text-sm shadow-sm transition-shadow ${
                        m.from_me ? "bg-[#d9fdd3]" : "bg-white"}`}
                    >
                      {active.is_group && !m.from_me && (
                        <button
                          onClick={(e) => { e.stopPropagation(); abrirPessoa(m.sender_phone); }}
                          className="text-[11px] font-semibold text-primary hover:underline"
                          title="Abrir conversa individual com essa pessoa"
                        >
                          {m.sender_name || m.sender_phone || ""}
                        </button>
                      )}
                      {citada && (
                        <div className="mb-1 border-l-2 border-primary/60 bg-black/5 px-2 py-1 text-[11px] text-muted-foreground">
                          <span className="block font-medium">
                            {citada.from_me ? (citada.enviado_por_nome || "Voce") : (citada.sender_name || "Contato")}
                          </span>
                          <span className="line-clamp-2">{msgText(citada)}</span>
                        </div>
                      )}
                      {m.encaminhada && !m.is_deleted && (
                        <p className="flex items-center gap-1 text-[11px] italic text-muted-foreground">
                          <Forward className="h-3 w-3" /> Encaminhada
                        </p>
                      )}
                      <MsgBody m={m} />
                      {m.reacao && (
                        <button
                          type="button"
                          title={reagivel ? "Trocar ou remover a reacao" : "Reacao"}
                          onClick={(e) => { e.stopPropagation(); if (reagivel) { setMenuMsg(null); setReagindo(reagindo === m.id ? null : m.id); } }}
                          className="absolute -bottom-2 right-2 rounded-full bg-white px-1 text-xs shadow"
                        >
                          {m.reacao}
                        </button>
                      )}
                      {/* SELO DO FLUXO (costura com a Frente P): esta mensagem saiu
                          de uma automacao. O atendente que le a conversa nao tem
                          como saber disso — a bolha e identica a uma digitada por
                          gente, e sem o selo ele responde por cima da regua. O
                          `title` diz o slug pra quem vai desligar o fluxo. */}
                      {(() => {
                        const selo = seloDeFluxo(vincFluxo, m);
                        if (!selo) return null;
                        return (
                          <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Workflow className="h-2.5 w-2.5 shrink-0" />
                            <span className="truncate" title={`Fluxo: ${selo.fluxo_slug || selo.rotulo}`}>
                              enviada pelo fluxo {selo.rotulo}
                            </span>
                          </div>
                        );
                      })()}
                      <div className="mt-0.5 flex items-center justify-end gap-1">
                        {m.editada_em && <span className="text-[11px] text-muted-foreground">editada</span>}
                        <span className="text-[11px] text-muted-foreground">{fmtTime(m.message_ts)}</span>
                        {m.from_me && (m.send_status === "read" ? (
                          <CheckCheck className="h-3.5 w-3.5 text-sky-500" />
                        ) : m.send_status === "delivered" ? (
                          <CheckCheck className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <Check className="h-3.5 w-3.5 text-muted-foreground" />
                        ))}
                      </div>

                      <button
                        onClick={(e) => { e.stopPropagation(); setMenuMsg(menuMsg === m.id ? null : m.id); }}
                        className={`absolute top-1 ${m.from_me ? "-left-7" : "-right-7"} rounded-full p-1 text-muted-foreground opacity-0 hover:bg-black/10 group-hover:opacity-100`}
                        title="Opcoes"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>
                      {/* REAGIR (03/09/2026): icone no hover ao lado de "Opcoes" e a barra
                          de emojis rapidos acima da bolha (abaixo, na 1a mensagem, pra
                          nao ser cortada pelo topo da lista). `podeReagir` decide se o
                          canal e a mensagem aceitam; o servidor confere de novo. */}
                      {reagivel && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setMenuMsg(null); setReagindo(reagindo === m.id ? null : m.id); }}
                          className={`absolute top-1 ${m.from_me ? "-left-14" : "-right-14"} rounded-full p-1 text-muted-foreground opacity-0 hover:bg-black/10 group-hover:opacity-100`}
                          title="Reagir"
                        >
                          <SmilePlus className="h-4 w-4" />
                        </button>
                      )}
                      {reagindo === m.id && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          role="group"
                          aria-label="Reagir a esta mensagem"
                          className={`absolute ${idx === 0 ? "-bottom-10" : "-top-10"} z-20 flex items-center gap-0.5 rounded-full border bg-white px-1.5 py-1 shadow-lg ${m.from_me ? "right-0" : "left-0"}`}
                        >
                          {REACOES_RAPIDAS.map((e) => (
                            <button
                              key={e}
                              type="button"
                              onClick={() => reagir(m, e)}
                              title={`Reagir com ${e}`}
                              className={`rounded-full px-1 text-lg leading-none transition-transform hover:scale-125 hover:bg-muted ${m.reacao === e ? "bg-muted" : ""}`}
                            >
                              {e}
                            </button>
                          ))}
                          {m.reacao && (
                            <button
                              type="button"
                              onClick={() => reagir(m, "")}
                              title="Remover reacao"
                              className="ml-0.5 rounded-full p-1 text-muted-foreground hover:bg-muted"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                      {menuMsg === m.id && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className={`absolute top-7 z-20 w-56 overflow-hidden rounded-lg border bg-white text-xs shadow-lg ${m.from_me ? "-left-56" : "-right-56"}`}
                        >
                          <div className="border-b bg-muted/60 px-3 py-2">
                            <p className="flex items-center gap-2 font-semibold text-foreground">
                              {m.from_me && m.enviado_por_nome && (
                                <AvatarPessoa nome={m.enviado_por_nome} foto={fotoDoAtendente(m.enviado_por_id)}
                                  tamanho="h-6 w-6" texto="text-[10px]" />
                              )}
                              <span className="min-w-0 break-words">
                                {m.from_me
                                  ? `Enviada por ${m.enviado_por_nome || "atendimento (fora do painel)"}`
                                  : `De ${m.sender_name || m.sender_phone || "contato"}`}
                              </span>
                            </p>
                            <p className="text-[11px] text-muted-foreground">{dataHoraCompleta(m.message_ts)}</p>
                            {!m.from_me && m.sender_phone && (
                              <p className="text-[11px] text-muted-foreground">{m.sender_phone}</p>
                            )}
                          </div>
                          <button onClick={() => { setRespondendo(m); setEditando(null); setMenuMsg(null); }}
                            className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted">
                            <Reply className="h-3.5 w-3.5" /> Responder
                          </button>
                          {reagivel && (
                            <button onClick={() => { setMenuMsg(null); setReagindo(m.id); }}
                              className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted">
                              <SmilePlus className="h-3.5 w-3.5" /> Reagir
                            </button>
                          )}
                          {m.provider_msg_id && !m.is_deleted && (canal === "central" || m.message_type === "text") && (
                            <button onClick={() => { setEncaminhando(m); setDestinosFwd([]); setBuscaFwd(""); setMenuMsg(null); }}
                              className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted">
                              <Forward className="h-3.5 w-3.5" /> Encaminhar
                            </button>
                          )}
                          {podeMexer && m.message_type === "text" && (
                            <button onClick={() => { setEditando(m); setRespondendo(null); setDraft(msgText(m)); setMenuMsg(null); }}
                              className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted">
                              <Pencil className="h-3.5 w-3.5" /> Editar
                            </button>
                          )}
                          {podeMexer && (
                            <button onClick={() => apagarMensagem(m)}
                              className="flex w-full items-center gap-2 px-3 py-2 text-red-600 hover:bg-red-50">
                              <Trash2 className="h-3.5 w-3.5" /> Apagar
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  </div>
                );
              })}
              {temp.map((tm) => (
                <div key={tm.key} className="flex justify-end">
                  <div className="max-w-[65%] rounded-lg bg-[#d9fdd3] px-3 py-1.5 text-sm opacity-70 shadow-sm">
                    <p className="whitespace-pre-wrap break-words">{tm.content}</p>
                    <div className="mt-0.5 flex items-center justify-end gap-1">
                      <span className="text-[11px] text-muted-foreground">{fmtTime(tm.ts)}</span>
                      <Check className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {(respondendo || editando) && (
              <div className="flex items-center gap-2 border-t bg-white px-4 py-2">
                <div className="min-w-0 flex-1 border-l-2 border-primary pl-2 text-xs">
                  <span className="font-medium text-primary">
                    {editando ? "Editando sua mensagem" : `Respondendo ${respondendo?.from_me ? "voce mesmo" : (respondendo?.sender_name || "contato")}`}
                  </span>
                  <p className="truncate text-muted-foreground">{msgText((editando || respondendo)!)}</p>
                </div>
                <button onClick={() => { setRespondendo(null); setEditando(null); setDraft(""); }}
                  className="rounded p-1 text-muted-foreground hover:bg-muted">
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {aviso && (
              <div className="flex items-center justify-between gap-2 border-t bg-amber-50 px-4 py-2 text-xs text-amber-800">
                <span>{aviso}</span>
                <button onClick={() => setAviso(null)} className="rounded p-1 hover:bg-amber-100">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* FRENTE Y — o banner da janela fechada PASSOU A TER SAIDA.
                A frase antiga mandava "use um template aprovado (fora do painel)":
                era verdade e era o defeito que a frente U declarou como costura —
                a tela sabia o que fazer, dizia o que fazer, e nao deixava fazer.
                O botao aparece so pra quem pode ENVIAR: o resto veria um caminho
                que a rota ia negar. */}
            {fonteDoCanalAtivo() === "gupshup" && janela && !janela.aberta && (
              <div className="flex items-center justify-between gap-3 border-t bg-red-50 px-4 py-2 text-xs text-red-700">
                <span>
                  Janela de 24h FECHADA — a API oficial so deixa responder ate 24h depois da ultima
                  mensagem DO CLIENTE. Pra puxar assunto, use um template aprovado.
                </span>
                {/* FRENTE Y (revisao 1) — DUAS permissoes, e a segunda e a que a
                    rota cobra de verdade: `GET /api/canais/templates` e nivel
                    `ler`, que em lib/permissoes.ts significa `gerenciar_canais`.
                    Gateado so por `enviar`, o botao aparecia pro papel `normal`
                    (que nao tem `gerenciar_canais`) e o catalogo voltava 403 —
                    o "botao que sempre da 403" que a propria prova desta frente
                    proibe. Quem nao alcanca o catalogo le a frase no aviso.
                    O conserto de verdade (quem pode ENVIAR poder LER o catalogo
                    do numero que atende) mexe em rota de outra frente e esta
                    declarado no CLAUDE.md como card. */}
                {podeEscolherTemplate() && !modoNota && !tplAberto && (
                  <button
                    onClick={() => {
                      setTplAberto(true);
                      setTplEscolhido(null);
                      setTplParams([]);
                      setTplAviso(null);
                      carregarTemplates(canal);
                    }}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-300 bg-white px-2.5 py-1 font-medium hover:bg-red-100">
                    <FileCheck2 className="h-3.5 w-3.5" /> Escolher template
                  </button>
                )}
              </div>
            )}
            {fonteDoCanalAtivo() === "gupshup" && janela?.aberta && janela.expira_em && (
              <div className="border-t bg-green-50 px-4 py-1.5 text-[11px] text-green-700">
                Janela aberta ate {dataHoraCompleta(janela.expira_em)} (24h apos a ultima mensagem do cliente).
              </div>
            )}

            {/* ─── FRENTE Y — SELETOR DE TEMPLATE (costura da frente U, card
                86ak858pa). Fica ACIMA do composer, no fluxo, e nao como popover
                flutuante: a caixa de digitacao esta DESABILITADA quando a janela
                fechou, entao este painel e o unico caminho de envio que existe
                naquele momento — esconder ele atras de um popover que fecha no
                clique de fora seria tirar o unico caminho.

                TEMPLATE APROVADO NAO SE EDITA: o atendente nao escreve a
                mensagem, ele preenche os buracos de um texto que a Meta aprovou.
                Por isso o painel e previa + campos, nunca um textarea. */}
            {/* FRENTE Y (revisao 1) — a capacidade e da FONTE, nao do id do canal.
                Com `canal === "apioficial"` hardcodado, um SEGUNDO numero de API
                oficial declarado em CANAIS_EXTRA recebia o 403 com use_template,
                abria o seletor no estado... e o painel nunca renderizava: o
                atendente ficava com o texto de volta, o aviso "escolha um
                template" e ZERO caminho — alem de `tplAberto` travado em true
                escondendo o botao do banner. Mesma correcao que a frente S pagou
                em `midiaDoCanalAtivo`. */}
            {tplAberto && fonteDoCanalAtivo() === "gupshup" && (
              <div className="space-y-2 border-t bg-slate-50 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
                    <FileCheck2 className="h-3.5 w-3.5" /> Enviar por template aprovado
                  </p>
                  <button onClick={() => { setTplAberto(false); setTplEscolhido(null); setTplParams([]); }}
                    title="Fechar" className="rounded p-1 text-muted-foreground hover:bg-muted">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {tplAviso && (
                  <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                    {tplAviso}
                  </p>
                )}
                {tplCatalogo === null ? (
                  <p className="text-xs text-muted-foreground">Carregando os templates deste numero...</p>
                ) : !tplEscolhido ? (
                  (() => {
                    const enviaveis = templatesEnviaveis(tplCatalogo);
                    const barrados = tplCatalogo.filter((t) => !enviaveis.includes(t));
                    return (
                      <div className="space-y-1.5">
                        {enviaveis.map((t) => (
                          <button key={t.provider_id || t.nome}
                            onClick={() => {
                              setTplEscolhido(t);
                              // um campo por variavel REAL do corpo ({{1}} e {{3}}
                              // sem {{2}} sao DOIS campos, nao tres)
                              setTplParams(camposDoTemplate(t).map(() => ""));
                              setTplAviso(null);
                            }}
                            className="block w-full rounded-lg border bg-white px-3 py-2 text-left hover:bg-muted">
                            <span className="flex items-baseline gap-2">
                              <span className="shrink-0 font-mono text-xs font-semibold text-primary">{t.nome}</span>
                              <span className="shrink-0 text-[11px] uppercase text-muted-foreground">{t.categoria}</span>
                            </span>
                            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                              {t.corpo.slice(0, 110)}
                            </span>
                          </button>
                        ))}
                        {/* OS BARRADOS APARECEM, com o motivo REAL. Sumir com eles
                            faria o atendente procurar "aquele template que existe" e
                            nao achar. O motivo vem de `motivoDeNaoEnviar`, a MESMA
                            funcao que decidiu a lista de cima: com `ROTULO_STATUS`
                            aqui, um template APROVADO barrado por falta da arte
                            aparecia com o motivo "aprovado" — barrado sem explicacao
                            e a versao escrita do botao que trava calado. */}
                        {barrados.length > 0 && (
                          <div className="space-y-1 border-t pt-1.5">
                            {barrados.map((t) => (
                              <p key={t.provider_id || t.nome} className="text-[11px] text-muted-foreground">
                                <span className="font-mono">{t.nome}</span>{" "}
                                <span className="uppercase">({ROTULO_STATUS[t.status] ?? t.status})</span> —{" "}
                                {motivoDeNaoEnviar(t)}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()
                ) : (
                  (() => {
                    const campos = camposDoTemplate(tplEscolhido);
                    const problema = problemaDosParametros(tplEscolhido, tplParams);
                    return (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-mono text-xs font-semibold text-primary">{tplEscolhido.nome}</p>
                          <button onClick={() => { setTplEscolhido(null); setTplParams([]); setTplAviso(null); }}
                            className="text-[11px] text-muted-foreground underline">
                            escolher outro
                          </button>
                        </div>
                        {campos.map((n, i) => (
                          <label key={n} className="block">
                            <span className="text-[11px] font-semibold uppercase text-muted-foreground">
                              {`{{${n}}}`}
                            </span>
                            <input value={tplParams[i] ?? ""}
                              onChange={(e) =>
                                setTplParams((ps) => {
                                  const novo = [...ps];
                                  novo[i] = e.target.value;
                                  return novo;
                                })
                              }
                              className="w-full rounded-lg border bg-white px-2 py-1.5 text-xs outline-none" />
                          </label>
                        ))}
                        {/* A PREVIA E LITERALMENTE O QUE VAI PRO HISTORICO:
                            `previaDoTemplate` usa a mesma `renderizarTemplate` que a
                            rota usa pra gravar o conteudo da mensagem. Template, uma
                            vez enviado, nao volta. */}
                        <div className="rounded-lg border bg-white px-3 py-2">
                          <p className="text-[11px] font-semibold uppercase text-muted-foreground">
                            O cliente vai ler
                          </p>
                          <p className="mt-0.5 whitespace-pre-wrap break-words text-xs">
                            {previaDoTemplate(tplEscolhido, tplParams)}
                          </p>
                          {/* FRENTE Y (revisao 1) — A PREVIA SO PROMETE A IMAGEM
                              QUANDO HA ARTE PRA MANDAR. `corpoEnvioTemplate` so
                              inclui o `message` da imagem quando `midia_url`
                              existe; sem ele nao vai imagem nenhuma, e prometer
                              na tela o que nao sai e a previa mentindo sobre a
                              unica coisa que ela existe pra mostrar. Quem vai
                              RECUSAR o envio e `podeEnviarTemplate`, na raiz —
                              mas so DEPOIS do merge da frente Z: nesta branch a
                              raiz ainda libera, e esta previa e a unica coisa
                              que avisa. Ver `scripts/prova-pendencia-z-imagem.ts`. */}
                          {tplEscolhido.cabecalho.toUpperCase() === "IMAGE" && (
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              {tplEscolhido.midia_url.trim()
                                ? "+ a imagem aprovada junto com o texto."
                                : "cabecalho de imagem SEM arte no espelho deste numero — nao vai imagem nenhuma."}
                            </p>
                          )}
                        </div>
                        {/* O MOTIVO FICA AO LADO DO BOTAO DESABILITADO. Botao que
                            trava sem dizer por que e o defeito que a casa proibe; e
                            a regra e a MESMA `validarParametros` da rota, entao o
                            erro nao aparece so depois do envio. */}
                        {problema && <p className="text-[11px] text-red-600">{problema}</p>}
                        <button onClick={enviarTemplate} disabled={sending || !!problema}
                          className="w-full rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                          {sending ? "Enviando..." : "Enviar template"}
                        </button>
                      </div>
                    );
                  })()
                )}
              </div>
            )}

            {agendadas.length > 0 && (
              <div className="space-y-0.5 border-t bg-sky-100 px-4 py-1.5 text-[11px] text-sky-700">
                {agendadas.map((a) => (
                  <div key={a.id}>
                    <div className="flex items-center justify-between gap-2">
                      {/* SAINDO AGORA vs AGENDADA (correcao da 2a revisao).
                          A linha que o cron reservou (`enviando`) NAO e um
                          agendamento futuro: mostrar "Agendada pra <hora que ja
                          passou>" faz o atendente achar que da tempo de mexer, e
                          os dois botoes ali so podiam voltar 400. Sem hora, e sem
                          botao, porque nao ha nada a fazer com ela. */}
                      {a.status === "enviando" ? (
                        <span className="truncate font-medium">
                          Saindo agora{a.criado_por_nome ? ` (${a.criado_por_nome})` : ""}: {a.texto.slice(0, 60)}
                        </span>
                      ) : (
                        <span className="truncate">
                          Agendada pra {dataHoraCompleta(a.enviar_em)}
                          {a.criado_por_nome ? ` por ${a.criado_por_nome}` : ""}: {a.texto.slice(0, 60)}
                        </span>
                      )}
                      <span className="flex shrink-0 gap-2">
                        {/* FRENTE S (card 86ak85nyj) — EDITAR antes de sair. O
                            criterio do card pede "editar OU cancelar"; so
                            cancelar existia, e o conserto na mao era cancelar e
                            reescrever tudo de novo. Os dois botoes valem SO
                            enquanto a linha esta pendente. */}
                        {a.status !== "enviando" && (<>
                        <button
                          onClick={() =>
                            setAgendadaEdit(
                              agendadaEdit?.id === a.id
                                ? null
                                : {
                                    id: a.id,
                                    texto: a.texto,
                                    quando: localDeIso(a.enviar_em, FUSO_UI),
                                    origTexto: a.texto,
                                    origQuando: localDeIso(a.enviar_em, FUSO_UI),
                                  }
                            )
                          }
                          className="font-medium hover:underline"
                        >
                          {agendadaEdit?.id === a.id ? "Fechar" : "Editar"}
                        </button>
                        <button onClick={() => cancelarAgendada(a.id)} className="font-medium hover:underline">
                          Cancelar
                        </button>
                        </>)}
                      </span>
                    </div>
                    {a.status !== "enviando" && agendadaEdit?.id === a.id && (
                      <div className="my-1 space-y-1.5 rounded-lg border border-sky-300 bg-white p-2">
                        <textarea rows={2} value={agendadaEdit.texto}
                          onChange={(e) => setAgendadaEdit({ ...agendadaEdit, texto: e.target.value })}
                          className="w-full resize-none rounded border bg-white px-2 py-1 text-xs text-foreground outline-none" />
                        <div className="flex items-center gap-2">
                          <input type="datetime-local" value={agendadaEdit.quando}
                            onChange={(e) => setAgendadaEdit({ ...agendadaEdit, quando: e.target.value })}
                            className="rounded border bg-white px-2 py-1 text-xs text-foreground outline-none" />
                          {/* o campo nao mostra fuso: dizer qual e evita o
                              atendente em outro fuso achar que agendou no
                              relogio DELE (mesma razao do formulario de criar) */}
                          <span className="text-[11px] text-muted-foreground">Horario de {FUSO_UI.replace(/_/g, " ")}.</span>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={salvarAgendadaEditada} disabled={!agendadaEdit.texto.trim()}
                            className="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50">
                            Salvar
                          </button>
                          <button onClick={() => setAgendadaEdit(null)}
                            className="rounded-lg border px-2.5 py-1 text-[11px] text-foreground hover:bg-muted">
                            Descartar mudancas
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* ─── FRENTE S (31/08/2026) — A AUTOMACAO NESTA CONVERSA (card 86ak85nyj).
                O QUE JA EXISTIA: a fila, a aprovacao humana por passo, a
                assinatura do conteudo aprovado e a tela /fluxos -> "Fila e
                aprovacoes" (Frente P). O que faltava era ESTA superficie: o
                atendente nao vai abrir a tela de automacao pra descobrir que o
                robo esta esperando aval NESTA conversa.
                Os botoes obedecem `pode_aprovar`/`pode_cancelar` que a PROPRIA
                rota devolve (aprovar exige `aprovar_automacao` e sessao de
                login — chave de API nao aprova) — a tela nao adivinha permissao. */}
            {autoConversa && autoConversa.itens.length > 0 && (() => {
              const parados = autoConversa.itens.filter((i) => i.estado === "aguardando_aprovacao");
              const naFila = autoConversa.itens.filter((i) => i.estado === "agendado" || i.estado === "executando");
              if (!parados.length && !naFila.length) return null;
              return (
                <div className="space-y-1 border-t bg-violet-50 px-4 py-1.5 text-[11px] text-violet-800">
                  {parados.map((i) => (
                    <div key={i.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">
                        <strong>Esperando aprovacao</strong> — fluxo {i.fluxo_nome || i.fluxo_slug}
                        {i.usuario_nome ? ` (posto por ${i.usuario_nome})` : ""}
                        {i.aviso ? `: ${i.aviso}` : ""}
                      </span>
                      <span className="flex shrink-0 gap-2">
                        {autoConversa.pode_aprovar ? (
                          <>
                            <button onClick={() => decidirAuto(i.id, "aprovar")} className="font-medium hover:underline">
                              Aprovar
                            </button>
                            <button onClick={() => decidirAuto(i.id, "recusar")} className="font-medium hover:underline">
                              Recusar
                            </button>
                          </>
                        ) : (
                          // Botao que sempre devolve 403 e pior que botao
                          // ausente — a linha diz QUAL permissao falta em vez de
                          // convidar o clique.
                          <span className="text-violet-600">precisa da permissao de aprovar automacao</span>
                        )}
                        {autoConversa.pode_cancelar && (
                          <button onClick={() => decidirAuto(i.id, "cancelar")} className="font-medium hover:underline">
                            Cancelar
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                  {naFila.map((i) => (
                    <div key={i.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">
                        Na fila de envio — fluxo {i.fluxo_nome || i.fluxo_slug}, previsto pra{" "}
                        {dataHoraCompleta(i.disponivel_em)}
                        {i.estado === "executando" ? " (rodando agora)" : ""}
                        {i.erro ? ` · ultima falha: ${i.erro}` : ""}
                      </span>
                      {autoConversa.pode_cancelar && (
                        <button onClick={() => decidirAuto(i.id, "cancelar")} className="shrink-0 font-medium hover:underline">
                          Cancelar
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* ─── FRENTE S (31/08/2026) — AUDIO: contador e previa (card 86ak86jx2).
                Os dois criterios do card que faltavam. O contador existe porque
                gravar sem ver o tempo produz audio de 4 minutos que ninguem
                ouve; a previa existe porque audio nao se edita depois de
                enviado, e antes desta frente PARAR a gravacao ja ENVIAVA. */}
            {/* Enquanto GRAVA nao ha faixa (Eric, 02/09/2026: "duas linhas escrito,
                fica feio — so o microfone vermelho ja resolvia"). O contador do
                card continua visivel: mora ao lado do botao vermelho, no rodape. */}
            {audioPronto && !gravando && (
              <div className="flex flex-wrap items-center gap-2 border-t bg-emerald-50 px-4 py-1.5 text-[11px] text-emerald-800">
                <span className="font-medium">Audio de {relogioAudio(audioPronto.seg)}</span>
                {/* player nativo: zero dependencia nova pra ouvir um blob local */}
                <audio src={audioPronto.url} controls className="h-7 max-w-[220px]" />
                <button onClick={enviarAudioPronto} disabled={sending}
                  className="rounded-lg bg-primary px-2.5 py-1 font-medium text-white disabled:opacity-50">
                  Enviar
                </button>
                <button onClick={alternarGravacao} disabled={sending}
                  className="rounded-lg border border-emerald-300 bg-white px-2.5 py-1 hover:bg-emerald-100 disabled:opacity-50">
                  Regravar
                </button>
                <button onClick={descartarAudio} disabled={sending}
                  className="rounded-lg border border-emerald-300 bg-white px-2.5 py-1 hover:bg-emerald-100 disabled:opacity-50">
                  Descartar
                </button>
              </div>
            )}

            <footer className="relative flex items-center gap-2 border-t bg-white px-4 py-3">
              {draft.startsWith("/") && !modoNota && !editando && (() => {
                // FRENTE Y — o filtro saiu do .tsx (lib/tela-composer.ts): e a MESMA
                // funcao que o Enter usa, entao a lista e o atalho nao podem mais
                // discordar de qual resposta e "a primeira".
                const ops = respostasDoAtalho(respostasRapidas, draft);
                return ops.length ? (
                  <div className="absolute bottom-16 left-4 z-20 w-[420px] max-w-[85%] overflow-hidden rounded-xl border bg-white shadow-lg">
                    <p className="border-b px-3 py-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
                      Respostas rapidas — Enter usa a primeira
                    </p>
                    {ops.map((r) => {
                      // A PREVIA MOSTRA O TEXTO JA RESOLVIDO. Mostrar o cru aqui e
                      // colar o resolvido faria a lista mentir sobre o que vai
                      // acontecer — o atendente escolhe pelo que le.
                      const previa = textoParaCaixa(r);
                      const av = avisoDeVariaveis(r);
                      return (
                        <button key={r.id} onClick={() => aplicarRespostaRapida(r)}
                          className="block w-full px-3 py-2 text-left hover:bg-muted">
                          <span className="flex items-baseline gap-2">
                            <span className="shrink-0 text-xs font-semibold text-primary">/{r.atalho}</span>
                            <span className="truncate text-xs text-muted-foreground">{previa.slice(0, 90)}</span>
                          </span>
                          {av && <span className="mt-0.5 block text-[11px] text-amber-700">{av}</span>}
                        </button>
                      );
                    })}
                  </div>
                ) : null;
              })()}
              {agendarAberto && (
                <div onClick={(e) => e.stopPropagation()}
                  className="absolute bottom-16 right-4 z-20 w-72 space-y-2 rounded-xl border bg-white p-3 shadow-lg">
                  <p className="text-[11px] font-semibold uppercase text-muted-foreground">Enviar esta mensagem em:</p>
                  <input type="datetime-local" value={agendarQuando} onChange={(e) => setAgendarQuando(e.target.value)}
                    className="w-full rounded-lg border bg-white px-2 py-1.5 text-xs outline-none" />
                  {/* o campo nao mostra fuso nenhum: dizer qual e evita o atendente
                      em outro fuso achar que agendou no relogio DELE */}
                  <p className="text-[11px] text-muted-foreground">Horario de {FUSO_UI.replace(/_/g, " ")}.</p>
                  <div className="flex gap-2">
                    <button onClick={agendarMensagem} disabled={!draft.trim() || !agendarQuando}
                      className="flex-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                      Agendar
                    </button>
                    <button onClick={() => setAgendarAberto(false)}
                      className="rounded-lg border px-3 py-1.5 text-xs hover:bg-muted">
                      Fechar
                    </button>
                  </div>
                  {!draft.trim() && <p className="text-[11px] text-muted-foreground">Escreva a mensagem no campo antes.</p>}
                </div>
              )}
              {/* ─── FRENTE S (31/08/2026) — PERGUNTA COM OPCOES (card 86ak86jvw).
                  O formulario nao guarda regra: os tetos e o plano de envio vem
                  de lib/interativas.ts (as MESMAS funcoes que a rota chama), e o
                  aviso do fallback aparece ANTES do clique. */}
              {interAberto && (() => {
                const plano = planoDeEnvio(fonteDoCanalAtivo(), interTipo, { grupo: !!active?.chat_id?.endsWith("-group") });
                const teto = maxOpcoes(interTipo);
                const limOp = limiteTituloOpcao(interTipo);
                const v = validarInterativa(rascunhoInterativo());
                return (
                  <div onClick={(e) => e.stopPropagation()}
                    className="absolute bottom-16 right-4 z-20 w-96 space-y-2 rounded-xl border bg-white p-3 shadow-lg">
                    <p className="text-[11px] font-semibold uppercase text-muted-foreground">Perguntar com opcoes</p>
                    <div className="flex gap-1">
                      {(["botoes", "lista"] as TipoInterativa[]).map((t) => (
                        <button key={t}
                          onClick={() => {
                            setInterTipo(t);
                            // trocar de tipo NAO apaga o que a pessoa digitou;
                            // so corta o excedente quando o teto novo e menor
                            setInterOpcoes((ops) => ops.slice(0, maxOpcoes(t)));
                          }}
                          className={`flex-1 rounded-lg border px-2 py-1 text-[11px] ${
                            interTipo === t ? "border-violet-500 bg-violet-50 font-medium text-violet-700" : "hover:bg-muted"
                          }`}>
                          {t === "botoes" ? `Botoes (ate ${maxOpcoes("botoes")})` : `Lista (ate ${maxOpcoes("lista")})`}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      A pergunta e o texto da caixa de mensagem. As opcoes vao abaixo.
                    </p>
                    {interOpcoes.map((op, i) => (
                      <div key={i} className="flex items-center gap-1">
                        <span className="w-4 shrink-0 text-[11px] text-muted-foreground">{i + 1}.</span>
                        <input value={op} maxLength={limOp}
                          onChange={(e) => setInterOpcoes((ops) => ops.map((o, k) => (k === i ? e.target.value : o)))}
                          placeholder={`Opcao ${i + 1} (ate ${limOp} caracteres)`}
                          className="flex-1 rounded-lg border bg-white px-2 py-1 text-xs outline-none" />
                        {interOpcoes.length > 2 && (
                          <button onClick={() => setInterOpcoes((ops) => ops.filter((_, k) => k !== i))}
                            title="Tirar esta opcao" className="rounded p-1 text-muted-foreground hover:bg-muted">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                    {interOpcoes.length < teto && (
                      <button onClick={() => setInterOpcoes((ops) => [...ops, ""])}
                        className="text-[11px] font-medium text-primary hover:underline">
                        + opcao
                      </button>
                    )}
                    {interTipo === "lista" && (
                      <input value={interBotaoLista} maxLength={20} onChange={(e) => setInterBotaoLista(e.target.value)}
                        placeholder="Texto do botao que abre a lista"
                        className="w-full rounded-lg border bg-white px-2 py-1 text-xs outline-none" />
                    )}
                    {/* O PLANO APARECE ANTES DO CLIQUE. Sem isto, o atendente
                        clicaria "enviar botoes" e o cliente receberia texto
                        numerado sem ninguem avisar — e no Z-API isso e a REGRA,
                        nao a excecao (a doc deles declara os botoes instaveis). */}
                    {plano.modo === "texto_numerado" && plano.motivo && (
                      <p className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">{plano.motivo}</p>
                    )}
                    {!v.ok && (draft.trim() || interOpcoes.some((o) => o.trim())) && (
                      <p className="text-[11px] text-red-600">{v.erros.join(" · ")}</p>
                    )}
                    <div className="flex gap-2">
                      <button onClick={enviarInterativa} disabled={sending || !v.ok}
                        className="flex-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                        {plano.modo === "nativo" ? "Enviar pergunta" : "Enviar como texto numerado"}
                      </button>
                      <button onClick={() => setInterAberto(false)}
                        className="rounded-lg border px-3 py-1.5 text-xs hover:bg-muted">
                        Fechar
                      </button>
                    </div>
                  </div>
                );
              })()}
              {emojiAberto && (
                <div onClick={(e) => e.stopPropagation()}
                  className="absolute bottom-16 left-4 z-20 grid w-72 grid-cols-8 gap-1 rounded-xl border bg-white p-2 shadow-lg">
                  {EMOJIS.map((e) => (
                    <button key={e} onClick={() => setDraft((d) => d + e)}
                      className="rounded p-1 text-lg hover:bg-muted">{e}</button>
                  ))}
                </div>
              )}
              {/* MODO ESTREITO: as cinco ferramentas (emoji, anexo, pergunta com
                  opcoes, anotacao, agendar) moram atras de um "+" que expande um
                  painel — cinco botoes inline deixavam a caixa de texto com 60px
                  em 400px. De `lg` pra cima continuam inline, como sempre (em
                  `md` a coluna da conversa ainda tem 428-683px — cinco botoes
                  inline deixavam 148px pra caixa de texto numa janela de 800). */}
              <button onClick={(e) => { e.stopPropagation(); setMaisComposerAberto((v) => !v); }}
                title="Mais opcoes"
                className={`shrink-0 rounded-full p-2 lg:hidden ${maisComposerAberto ? "bg-muted text-primary" : "text-muted-foreground hover:bg-muted"}`}>
                <Plus className={`h-5 w-5 transition-transform ${maisComposerAberto ? "rotate-45" : ""}`} />
              </button>
              <div onClick={(e) => { if (maisComposerAberto) e.stopPropagation(); }}
                className={maisComposerAberto
                  ? "absolute bottom-16 left-3 z-20 flex min-w-[220px] flex-col gap-0.5 rounded-xl border bg-white p-1.5 shadow-lg lg:static lg:min-w-0 lg:flex-row lg:items-center lg:gap-0 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none"
                  : "hidden lg:flex lg:items-center"}>
              <button onClick={(e) => { e.stopPropagation(); setEmojiAberto((v) => !v); }}
                title="Emoji" className="flex items-center gap-2 rounded-full p-2 text-muted-foreground hover:bg-muted">
                <Smile className="h-5 w-5" />
                <span className="text-sm lg:hidden">Emoji</span>
              </button>
              {/* FRENTE S: a capacidade e da FONTE do canal, nao do id dele
                  (era `canal === "central"`, e uma 2a instancia Z-API de
                  CANAIS_EXTRA ficava sem clipe suportando arquivo). */}
              {midiaDoCanalAtivo().pode && (<><input ref={inputArquivo} type="file" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) enviarArquivo(f); e.target.value = ""; }} />
              <button onClick={() => inputArquivo.current?.click()} disabled={sending}
                title="Anexar arquivo" className="flex items-center gap-2 rounded-full p-2 text-muted-foreground hover:bg-muted disabled:opacity-40">
                <Paperclip className="h-5 w-5" />
                <span className="text-sm lg:hidden">Anexar arquivo</span>
              </button></>)}
              {/* FRENTE S — O MOTIVO APARECE (correcao da revisao cega).
                  O `motivo` era calculado e nunca renderizado: no canal da API
                  oficial o clipe e o microfone simplesmente DESAPARECIAM, e sumir
                  sem explicacao le-se como painel quebrado ("cade o clipe?"). O
                  CLAUDE.md promete "escondido com motivo verdadeiro" — sem isto a
                  promessa era so metade. Clicar mostra a frase; o hover tambem. */}
              {!midiaDoCanalAtivo().pode && midiaDoCanalAtivo().motivo && (
                <button type="button" title={midiaDoCanalAtivo().motivo!}
                  onClick={() => setAviso(midiaDoCanalAtivo().motivo!)}
                  aria-label="Por que nao da pra anexar arquivo ou gravar audio aqui"
                  className="rounded-full p-2 text-muted-foreground/50 hover:bg-muted hover:text-muted-foreground">
                  <Paperclip className="h-5 w-5 rotate-45" />
                </button>
              )}
              {/* ─── FRENTE S (31/08/2026) — PERGUNTA COM OPCOES (card 86ak86jvw).
                  So pra quem pode enviar, e nunca no modo anotacao/edicao (uma
                  anotacao interna com botoes nao faz sentido: ela nao vai pro
                  cliente). */}
              {!modoNota && !editando && temPermissao("enviar") && (
                <button onClick={(e) => { e.stopPropagation(); setInterAberto((v) => !v); }}
                  title="Perguntar com opcoes (botoes ou lista)"
                  className={`flex items-center gap-2 rounded-full p-2 ${interAberto ? "bg-violet-500 text-white" : "text-muted-foreground hover:bg-muted"}`}>
                  <ListChecks className="h-5 w-5" />
                  <span className="text-sm lg:hidden">Pergunta com opcoes</span>
                </button>
              )}
              <button onClick={() => setModoNota((v) => !v)}
                title={modoNota ? "Voltar pra mensagem normal" : "Anotacao interna (nao vai pro WhatsApp)"}
                className={`flex items-center gap-2 rounded-full p-2 ${modoNota ? "bg-amber-400 text-white" : "text-muted-foreground hover:bg-muted"}`}>
                <StickyNote className="h-5 w-5" />
                <span className="text-sm lg:hidden">{modoNota ? "Voltar pra mensagem" : "Anotacao interna"}</span>
              </button>
              {/* semente do campo de agendamento: daqui a 1h no fuso DA INSTALACAO
                  (era o getTimezoneOffset do navegador) — o que o campo mostra e o
                  que agendarMensagem le tem que falar do mesmo relogio */}
              {!modoNota && !editando && (
                <button onClick={(e) => { e.stopPropagation(); setAgendarAberto((v) => !v); if (!agendarQuando) setAgendarQuando(localDeIso(Date.now() + 3600_000, FUSO_UI)); }}
                  title="Agendar envio desta mensagem"
                  className={`flex items-center gap-2 rounded-full p-2 ${agendarAberto ? "bg-sky-500 text-white" : "text-muted-foreground hover:bg-muted"}`}>
                  <Clock className="h-5 w-5" />
                  <span className="text-sm lg:hidden">Agendar envio</span>
                </button>
              )}
              </div>
              {/* placeholder CURTO em janela estreita (Eric, 02/09/2026): o texto
                  longo quebrava em duas linhas numa caixa de 250px e parecia
                  "um monte de coisa escrita". O atalho "/" continua valendo. */}
              <textarea rows={1}
                className={`max-h-32 min-h-[40px] flex-1 resize-none rounded-lg px-3 py-2 text-sm outline-none ${modoNota ? "bg-amber-50 placeholder:text-amber-700/60" : "bg-muted"}`}
                placeholder={larguraLg
                  ? (editando ? "Edite a mensagem e envie" : modoNota ? "Anotacao interna (nao vai pro WhatsApp) — @Nome marca alguem" : "Digite uma mensagem (\"/\" abre as respostas rapidas)")
                  : (editando ? "Edite e envie" : modoNota ? "Anotacao interna" : "Mensagem")}
                value={draft} onChange={(e) => setDraft(e.target.value)}
                disabled={fonteDoCanalAtivo() === "gupshup" && janela !== null && !janela.aberta && !modoNota}
                // FRENTE S: clicar na caixa NAO fecha o painel de opcoes. A
                // pergunta da interativa E este texto, entao o fluxo natural
                // (abrir o painel, clicar aqui, digitar a pergunta) fechava o
                // painel no clique e apagava o trabalho — achado da revisao.
                onClick={(e) => { if (interAberto) e.stopPropagation(); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    // PAINEL DE OPCOES ABERTO: Enter manda a PERGUNTA COM OPCOES.
                    // Antes caia no `send()` de baixo e o cliente recebia a
                    // pergunta CRUA, sem opcao nenhuma — pior que nao enviar,
                    // porque parece enviado e o menu nunca chegou.
                    if (interAberto && !modoNota && !editando) { enviarInterativa(); return; }
                    // "/" com atalho na lista: Enter aplica a primeira em vez de enviar.
                    // FRENTE Y — `respostasDoAtalho` e o MESMO filtro da lista, e
                    // `aplicarRespostaRapida` e o MESMO caminho do clique: era aqui
                    // que o `!nome` cru chegava na caixa por Enter mesmo depois de a
                    // lista ter sido corrigida.
                    if (draft.startsWith("/") && !modoNota && !editando) {
                      const alvo = respostasDoAtalho(respostasRapidas, draft)[0];
                      if (alvo) { aplicarRespostaRapida(alvo); return; }
                    }
                    send();
                  }
                }} />
              {/* FRENTE S — GRAVAR AUDIO (card 86ak86jx2).
                  Tres mudancas em relacao ao que existia:
                  (a) o gate e a CAPACIDADE DA FONTE, nao `canal === "central"`;
                  (b) exige a permissao `enviar` (criterio do card) — o servidor
                      ja recusava, mas botao que sempre da 403 e pior que ausente;
                  (c) parar NAO ENVIA MAIS: vira previa (a barra logo acima). */}
              {midiaDoCanalAtivo().pode && temPermissao("enviar") && (<>
              {gravando && (
                <span className="shrink-0 text-xs font-medium tabular-nums text-red-600" title="Tempo gravado">
                  {relogioAudio(gravSeg)}
                </span>
              )}
              <button onClick={alternarGravacao} disabled={sending}
                title={gravando ? "Parar a gravacao (voce ouve antes de enviar)" : "Gravar audio"}
                className={`rounded-full p-2 disabled:opacity-40 ${gravando ? "animate-pulse bg-red-500 text-white" : "text-muted-foreground hover:bg-muted"}`}>
                {gravando ? <Square className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              </button></>)}
              <button onClick={send} disabled={sending || !draft.trim()}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40">
                <Send className="h-4 w-4" />
              </button>
            </footer>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <MessageSquare className="h-10 w-10" />
            <p className="text-sm">Escolha uma conversa ao lado</p>
          </div>
        )}
      </main>

      {/* foto ampliada: por cima de tudo, em qualquer largura e em qualquer modo */}
      {fotoAmpliada && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setFotoAmpliada(null)}>
          <button type="button" onClick={() => setFotoAmpliada(null)} title="Fechar"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20">
            <X className="h-5 w-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={fotoAmpliada} alt="" onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
        </div>
      )}

      {/* ficha do contato: abre clicando no nome no cabecalho da conversa.
          Abaixo de `md` cobre a tela; de `md` a `xl` e uma gaveta de 340px por
          cima da conversa (estatica ela roubava 340px de uma coluna que em 800px
          de janela ja so tinha 460, sobrando 120px pra ler mensagem); a partir de
          `xl` (main >= 600px com ela aberta) vira a terceira coluna de sempre. */}
      {active && fichaAberta && (
        <aside className="fixed inset-0 z-30 flex w-full flex-col bg-white md:inset-y-0 md:left-auto md:right-0 md:w-[340px] md:border-l md:shadow-2xl xl:static xl:z-auto xl:shrink-0 xl:shadow-none">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <p className="text-sm font-semibold">Ficha do contato</p>
            <button onClick={() => setFichaAberta(false)} className="rounded p-1 text-muted-foreground hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* FRENTE O — as abas de historico entram AQUI, na gaveta que ja
              existe. As duas primeiras seguem por texto (sao as do dia a dia);
              as quatro de historico sao icone com title, senao 6 rotulos em
              340px viram duas linhas de texto ilegivel. */}
          <div className="flex border-b text-xs">
            {(["dados", "notas"] as const).map((aba) => (
              <button key={aba} onClick={() => abrirAbaFicha(aba)}
                className={`flex-1 py-2 font-medium ${abaFicha === aba ? "border-b-2 border-primary text-primary" : "text-muted-foreground hover:bg-muted"}`}>
                {aba === "dados" ? "Dados" : `Anotacoes${ficha?.notas?.length ? ` (${ficha.notas.length})` : ""}`}
              </button>
            ))}
            {(
              [
                { id: "status", Icone: History, titulo: "Historico de status (com tempo em cada um)" },
                { id: "transferencias", Icone: ArrowRightLeft, titulo: "Historico de transferencia: quem passou pra quem" },
                { id: "avaliacoes", Icone: Star, titulo: "Avaliacoes e NPS deste contato" },
                { id: "midia", Icone: Images, titulo: "Arquivos trocados nesta conversa" },
                // FRENTE Y — MEMORIA DA CONVERSA (costura da frente V). Icone com
                // `title`, como as quatro irmas: sete rotulos de texto em 340px
                // viram duas linhas ilegiveis (decisao da frente O, mantida).
                { id: "memoria", Icone: Braces, titulo: "Memoria da conversa: o que a automacao lembra daqui" },
              ] as const
            ).map(({ id, Icone, titulo }) => (
              <button
                key={id}
                onClick={() => abrirAbaFicha(id)}
                title={titulo}
                className={`flex flex-1 items-center justify-center py-2 ${abaFicha === id ? "border-b-2 border-primary text-primary" : "text-muted-foreground hover:bg-muted"}`}
              >
                <Icone className="h-4 w-4" />
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4 text-sm">
            {/* FRENTE O — os historicos vem ANTES do gate `!ficha`: eles nao
                dependem da ficha, e travar a trilha de status atras do
                carregamento da ficha faria o painel esperar por um dado que ele
                nao usa. */}
            {/* ─── FRENTE Y — MEMORIA DA CONVERSA (costura da frente V, card
                86ak859vt). Vem ANTES do gate `!ficha` pelo mesmo motivo dos
                historicos: ela nao depende da ficha, e travar a memoria atras do
                carregamento da ficha faria o painel esperar por um dado que ele
                nao usa. */}
            {abaFicha === "memoria" ? (
              <div className="space-y-3">
                <p className="text-[11px] text-muted-foreground">
                  O que a automacao GRAVOU nesta conversa (o menu em que o cliente parou, a resposta
                  que ele deu). As condicoes dos fluxos leem exatamente isto.
                </p>
                {!memoria ? (
                  <p className="text-xs text-muted-foreground">Carregando...</p>
                ) : memoria.aviso ? (
                  // AVISO AMBAR, nao lista vazia: "esta conversa nao tem memoria" e
                  // uma AFIRMACAO, e a tela nao pode faze-la quando a verdade e "nao
                  // deu pra ler" (migration 0016 pendente, grant, rede fora).
                  // COM SAIDA (revisao 1): rede que cai volta, e sem o botao o unico
                  // jeito de tentar de novo era trocar de conversa e voltar.
                  <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
                    <p className="text-[11px] text-amber-800">{memoria.aviso}</p>
                    <button
                      onClick={() => { setMemoria(null); if (active) carregarMemoria(active.chat_id, active.canal); }}
                      className="rounded-lg border border-amber-400 bg-white px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100">
                      Tentar de novo
                    </button>
                  </div>
                ) : (
                  <>
                    {!memoria.pares.length && (
                      <p className="rounded-lg border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
                        Esta conversa ainda nao tem nenhuma variavel gravada.
                      </p>
                    )}
                    {memoria.pares.map((par) => (
                      <div key={par.chave} className="rounded-lg border px-3 py-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="break-all font-mono text-[11px] font-semibold text-primary">{par.chave}</p>
                            <p className="mt-0.5 whitespace-pre-wrap break-words text-xs">
                              {par.valor.trim() ? par.valor : <span className="text-muted-foreground">(vazio)</span>}
                            </p>
                          </div>
                          {memoria.pode_editar && (
                            <div className="flex shrink-0 gap-1">
                              <button
                                title="Editar este valor"
                                disabled={memSalvando}
                                onClick={() => { setMemChave(par.chave); setMemValor(par.valor); setMemErro(null); }}
                                className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40">
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              {/* APAGAR e gesto SEPARADO de "gravar vazio", e a
                                  diferenca e semantica: so apagando a chave o
                                  `nao_existe` das condicoes volta a valer.
                                  DOIS PASSOS (revisao 1): nao ha desfazer, e a
                                  automacao le exatamente esta chave. */}
                              {memApagar === par.chave ? (
                                <>
                                  <button
                                    title="Confirmar: apagar esta variavel"
                                    disabled={memSalvando}
                                    onClick={() => { setMemApagar(null); salvarMemoria(par.chave, "", true); }}
                                    className="rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-medium text-white disabled:opacity-40">
                                    Apagar
                                  </button>
                                  <button
                                    title="Cancelar"
                                    onClick={() => setMemApagar(null)}
                                    className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted">
                                    Cancelar
                                  </button>
                                </>
                              ) : (
                                <button
                                  title="Apagar esta variavel (diferente de gravar vazio)"
                                  disabled={memSalvando}
                                  onClick={() => setMemApagar(par.chave)}
                                  className="rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600 disabled:opacity-40">
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {/* O SERVIDOR MANDA E A TELA REFLETE: sem `editar_contexto` o
                        formulario nem aparece, e a frase diz QUAL permissao falta —
                        campo que devolve 403 no clique e pior que campo ausente. */}
                    {memoria.pode_editar ? (
                      <div className="space-y-2 border-t pt-3">
                        <p className="text-[11px] font-semibold uppercase text-muted-foreground">
                          Gravar / trocar uma variavel
                        </p>
                        <input value={memChave} onChange={(e) => setMemChave(e.target.value)}
                          placeholder="nome da variavel (ex: URA)" maxLength={200}
                          className="w-full rounded-lg border bg-white px-2 py-1.5 font-mono text-xs outline-none" />
                        {/* A CHAVE E NORMALIZADA ANTES DE GRAVAR (a mesma funcao do
                            schema). Mostrar como ela VAI FICAR evita o bug invisivel
                            de gravar "URA " e a condicao procurar "URA". */}
                        {memChave.trim() !== chaveNormalizada(memChave) && !!chaveNormalizada(memChave) && (
                          <p className="text-[11px] text-muted-foreground">
                            vai ser gravada como <span className="font-mono">{chaveNormalizada(memChave)}</span>
                          </p>
                        )}
                        <textarea rows={2} value={memValor} onChange={(e) => setMemValor(e.target.value)}
                          placeholder="valor (pode ficar vazio: marca a chave sem conteudo)"
                          className="w-full resize-none rounded-lg border bg-white px-2 py-1.5 text-xs outline-none" />
                        {memErro && <p className="text-[11px] text-red-600">{memErro}</p>}
                        <button
                          onClick={() => salvarMemoria(memChave, memValor)}
                          disabled={memSalvando || !memChave.trim()}
                          className="w-full rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                          {memSalvando ? "Gravando..." : "Gravar"}
                        </button>
                      </div>
                    ) : (
                      <p className="border-t pt-3 text-[11px] text-muted-foreground">
                        Voce ve a memoria, mas nao pode editar: falta a permissao
                        <span className="font-mono"> editar_contexto</span> (marcar na tela de papeis).
                      </p>
                    )}
                  </>
                )}
              </div>
            ) : abaFicha === "status" || abaFicha === "transferencias" || abaFicha === "avaliacoes" || abaFicha === "midia" ? (
              <ConversaHistoricos
                aba={abaFicha}
                status={histStatus}
                transferencias={histTransf}
                avaliacoes={histAval}
                midia={histMidia}
                abaMidia={abaMidia}
                onAbaMidia={setAbaMidia}
                onPular={pularParaMensagem}
                fmtDataHora={dataHoraCompleta}
                urlSegura={urlSegura}
              />
            ) : !ficha ? (
              <p className="text-xs text-muted-foreground">Carregando...</p>
            ) : abaFicha === "dados" ? (
              <div className="space-y-4">
                <div className="flex flex-col items-center gap-2 border-b pb-4 text-center">
                  {fotoOk(urlSegura(active.profile_thumbnail)) ? (
                    <button type="button" title="Ampliar foto" onClick={() => setFotoAmpliada(active.profile_thumbnail!)}
                      className="rounded-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={active.profile_thumbnail!} alt="" className="h-16 w-16 rounded-full object-cover" />
                    </button>
                  ) : (
                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/15 text-lg font-semibold text-primary">
                      {ficha.is_group ? <Users className="h-6 w-6" /> : initials(ficha.nome || ficha.chat_id)}
                    </div>
                  )}
                  <div>
                    <p className="font-semibold">{ficha.nome || ficha.chat_id}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {ficha.is_group ? `Grupo (${ficha.chat_id})` : ficha.chat_id}
                    </p>
                  </div>
                </div>

                {/* mesmos controles do cabecalho: mexer aqui muda o atendimento */}
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Status do atendimento</p>
                  <select
                    value={active.status}
                    onChange={(e) => atualizarConversa({ status: e.target.value as StatusAtendimento })}
                    className={`w-full rounded-lg border px-2 py-1.5 text-xs font-medium outline-none ${STATUS_INFO[active.status]?.pill || ""}`}
                  >
                    <option value="aberto">Em aberto</option>
                    <option value="atendimento">Em atendimento</option>
                    <option value="aguardando">Aguardando</option>
                    <option value="concluido">Concluido</option>
                  </select>
                </div>

                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Responsaveis</p>
                  <div className="mb-1.5 flex flex-wrap gap-1">
                    {!(active.responsaveis || []).length && (
                      <span className="text-[11px] text-muted-foreground">Sem responsavel</span>
                    )}
                    {(active.responsaveis || []).map((r) => (
                      <span key={`${r.tipo}:${r.id}`}
                        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${r.tipo === "departamento" ? "bg-violet-100 text-violet-700" : "bg-primary/10 text-primary"}`}>
                        {r.nome}
                        <button title="Remover responsavel"
                          onClick={() => mudarResponsavel("remove", r.tipo, r.id)}
                          className="rounded-full hover:bg-black/10">
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                  <select
                    value=""
                    onChange={(e) => adicionarResponsavel(e.target.value)}
                    className="w-full rounded-lg border bg-muted px-2 py-1.5 text-xs outline-none"
                  >
                    <option value="">+ adicionar responsavel (pessoa ou departamento)</option>
                    <optgroup label="Departamentos">
                      {departamentos
                        .filter((d) => !active.responsaveis?.some((r) => r.tipo === "departamento" && r.id === d.id))
                        .map((d) => <option key={d.id} value={`dep:${d.id}`}>{d.nome}</option>)}
                    </optgroup>
                    <optgroup label="Pessoas">
                      {users
                        .filter((u) => !active.responsaveis?.some((r) => r.tipo === "usuario" && r.id === u.id))
                        .map((u) => <option key={u.id} value={`usr:${u.id}`}>{u.nome}</option>)}
                    </optgroup>
                  </select>
                  {!active.responsaveis?.length && !active.responsavel_id && active.responsavel_nome && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Atendente do ChatGuru sem conta no painel: {active.responsavel_nome}
                    </p>
                  )}
                </div>

                {perfil?.papel === "super_admin" && (
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Visibilidade</p>
                  <div className="mb-1.5 flex flex-wrap gap-1">
                    {!(active.visibilidade || []).length && (
                      <span className="text-[11px] text-muted-foreground">Todos veem</span>
                    )}
                    {(active.visibilidade || []).map((v) => (
                      <span key={`${v.tipo}:${v.id}`}
                        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                          v.tipo === "departamento" ? "bg-violet-100 text-violet-700"
                          : v.tipo === "contexto" ? "bg-amber-100 text-amber-700"
                          : "bg-primary/10 text-primary"}`}>
                        {v.nome}
                        <button title="Remover da visibilidade"
                          onClick={() => mudarVisibilidade("remove", v.tipo, v.id)}
                          className="rounded-full hover:bg-black/10">
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                  <select
                    value=""
                    onChange={(e) => adicionarVisibilidade(e.target.value)}
                    className="w-full rounded-lg border bg-muted px-2 py-1.5 text-xs outline-none"
                  >
                    <option value="">+ restringir visibilidade (BU, departamento ou pessoa)</option>
                    <optgroup label="BUs">
                      {(visoes.length ? visoes : visBuFallback || [])
                        .filter((v) => !active.visibilidade?.some((x) => x.tipo === "contexto" && x.id === v.id))
                        .map((v) => <option key={v.id} value={`bu:${v.id}`}>{v.nome}</option>)}
                    </optgroup>
                    <optgroup label="Departamentos">
                      {departamentos
                        .filter((d) => !active.visibilidade?.some((v) => v.tipo === "departamento" && v.id === d.id))
                        .map((d) => <option key={d.id} value={`dep:${d.id}`}>{d.nome}</option>)}
                    </optgroup>
                    <optgroup label="Pessoas">
                      {users
                        .filter((u) => !active.visibilidade?.some((v) => v.tipo === "usuario" && v.id === u.id))
                        .map((u) => <option key={u.id} value={`usr:${u.id}`}>{u.nome}</option>)}
                    </optgroup>
                  </select>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Vazio = todos veem. Com itens, so quem esta na lista ve (a pessoa, o departamento ou quem tem a BU). O responsavel atual sempre ve.
                  </p>
                </div>
                )}

                {perfil?.papel === "super_admin" && (
                <div>
                  <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-2 py-1.5">
                    <span className="min-w-0">
                      <span className="text-[11px] font-semibold uppercase text-muted-foreground">Arquivamento automatico</span>
                      <p className="text-[11px] text-muted-foreground">
                        Este chat fica sempre arquivado: mensagem nova nao o desarquiva.
                      </p>
                    </span>
                    <input type="checkbox" checked={!!active.auto_arquivar}
                      onChange={(e) => mudarAutoArquivar(e.target.checked)}
                      className="shrink-0" />
                  </label>
                </div>
                )}

                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Etiquetas</p>
                  <div className="flex flex-wrap items-center gap-1">
                    {ficha.etiquetas.map((t) => (
                      <span key={t} className="flex items-center gap-1 rounded bg-sky-100 px-2 py-0.5 text-[11px] text-sky-800">
                        {t}
                        <button title="Tirar etiqueta desta conversa"
                          onClick={() => salvarEtiquetas(ficha.etiquetas.filter((x) => x !== t))}
                          className="rounded-full hover:bg-sky-200">
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                  {/* aplicar so etiqueta do CATALOGO — criar etiqueta nova e acao de admin */}
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) salvarEtiquetas(Array.from(new Set([...ficha.etiquetas, e.target.value])));
                    }}
                    className="mt-1.5 w-full rounded border bg-white px-2 py-1 text-[11px] outline-none"
                  >
                    <option value="">+ aplicar etiqueta do catalogo</option>
                    {catalogoEtiquetas
                      .filter((e) => !ficha.etiquetas.includes(e))
                      .map((e) => <option key={e} value={e}>{e}</option>)}
                  </select>
                </div>

                {/* FICHA TIPADA (costura 2 da Frente X, feita na tranche 2 — 03/09/2026): o
                    componente le /api/campos/valores e desenha cada campo pelo TIPO do
                    construtor (lista e sim/nao viram select, obrigatorio marca pendencia,
                    valor fora do formato aparece em vez de sumir, valor sem campo fica
                    visivel). Antes a ficha desenhava `campos_padrao` como texto livre e o
                    que o construtor definia nao chegava aqui. */}
                {active && (
                  <FichaCampos
                    authedFetch={authedFetch}
                    canal={active.canal}
                    chatId={active.chat_id}
                    aoSalvar={() => carregarFicha(active.chat_id)}
                  />
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-lg border p-2">
                  <textarea
                    value={novaNota}
                    onChange={(e) => setNovaNota(e.target.value)}
                    placeholder="Nova anotacao interna (nao vai pro WhatsApp). Use @Nome pra marcar alguem do time."
                    rows={3}
                    className="w-full resize-none bg-transparent text-xs outline-none"
                  />
                  <div className="flex justify-end">
                    <button onClick={enviarNota} disabled={!novaNota.trim() || salvandoNota}
                      className="rounded bg-primary px-3 py-1 text-[11px] font-medium text-white disabled:opacity-50">
                      {salvandoNota ? "Salvando..." : "Salvar anotacao"}
                    </button>
                  </div>
                </div>
                {!ficha.notas.length && (
                  <p className="text-xs text-muted-foreground">Nenhuma anotacao nesta conversa.</p>
                )}
                {ficha.notas.map((n) => (
                  <div key={n.id} className="rounded-lg border bg-amber-50/60 p-2">
                    <p className="whitespace-pre-wrap break-words text-xs">{n.texto}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {n.autor || "sistema"} — {dataHoraCompleta(n.criada_em)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      )}

      {configAberta && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 md:p-6"
          onClick={() => setConfigAberta(false)}>
          <div onClick={(e) => e.stopPropagation()}
            className="flex h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-xl md:h-[85vh]">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <p className="flex items-center gap-2 text-sm font-semibold"><Settings className="h-4 w-4" /> Configuracoes</p>
              <button onClick={() => setConfigAberta(false)} className="rounded p-1 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* AUDITORIA DE INTERFACE (02/09/2026, docs/revisao-interface-2026-09-02.md): as 7 abas
                em linha nao cabiam (rotulo em duas linhas, corte em tela estreita) e metade da
                administracao vivia fora daqui — visoes (Numeros, Relatorios, Acesso) e paginas
                (/fluxos, /disparo, /biblioteca, /campos) sem porta no painel. Agora e UM mapa:
                navegacao agrupada a esquerda (faixa rolavel em tela estreita), com as abas deste
                modal e as telas proprias lado a lado. Ids das abas e o rotulo "Instalar widget"
                (que o homologar.py clica) nao mudaram. */}
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              <nav aria-label="Secoes das configuracoes"
                className="flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-2 text-xs md:w-56 md:flex-col md:gap-0 md:overflow-y-auto md:border-b-0 md:border-r md:px-2 md:py-3">
                {/* BUSCA NO MAPA (tranche 2, 03/09/2026): o mapa passou de 15 itens; digitar filtra
                    os rotulos. So de md pra cima — na faixa rolavel estreita a lista inteira ja
                    cabe num deslize e a caixa roubaria a largura. */}
                <label className="mb-2 hidden items-center gap-1.5 rounded-lg bg-muted px-2 py-1.5 md:flex">
                  <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <input value={buscaConfig} onChange={(e) => setBuscaConfig(e.target.value)}
                    placeholder="Buscar nas configuracoes" aria-label="Buscar nas configuracoes"
                    className="w-full bg-transparent text-xs outline-none" />
                </label>
                {(() => { const grupos = ([
                  { titulo: "Pessoal", itens: [{ aba: "conta", rotulo: "Minha conta" }] },
                  { titulo: "Atendimento", itens: [
                    { aba: "respostas", rotulo: "Respostas rapidas" },
                    ...(temPermissao("automacao") ? [{ aba: "automacao", rotulo: "Regras automaticas" }] : []),
                    ...(temPermissao("gerenciar_etiquetas") ? [{ aba: "fichacfg", rotulo: "Etiquetas" }] : []),
                    ...(temPermissao("gerenciar_campos") ? [{ aba: "campos", rotulo: "Campos da ficha" }] : []),
                    { href: "/biblioteca", rotulo: "Biblioteca de anexos" },
                  ] },
                  { titulo: "Equipe e acesso", itens: [
                    ...(temPermissao("gerenciar_usuarios") ? [
                      { aba: "usuarios", rotulo: "Usuarios e permissoes" },
                      { aba: "departamentos", rotulo: "Departamentos" },
                    ] : []),
                    ...(temPermissao("gerenciar_usuarios") || temPermissao("gerenciar_visibilidade") || perfil?.papel === "super_admin"
                      ? [{ abrir: () => { setConfigAberta(false); setAcessoDe(""); setVisaoPainel("acesso"); }, rotulo: "Acesso e seguranca" }] : []),
                  ] },
                  { titulo: "Canais, automacao e dados", itens: [
                    ...((temPermissao("gerenciar_canais") || perfil?.papel === "super_admin")
                      ? [{ abrir: () => { setConfigAberta(false); setVisaoPainel("canais"); }, rotulo: "Numeros (conexao e templates)" }] : []),
                    // modulo desligado continua no mapa (a pessoa precisa achar onde fica
                    // pra pedir pra ligar), mas o rotulo diz o estado — link que abre uma
                    // tela "desligado" sem aviso e o que faz o mapa parecer quebrado
                    ...(temPermissao("automacao")
                      ? [{ href: "/fluxos", rotulo: "Fluxos de automacao", desligado: perfil?.modulos?.automacao === false }] : []),
                    ...(perfil?.papel === "super_admin"
                      ? [{ href: "/disparo", rotulo: "Disparo em massa", desligado: perfil?.modulos?.disparo === false }] : []),
                    ...(temPermissao("relatorios")
                      ? [{ abrir: () => { setConfigAberta(false); setVisaoPainel("relatorios"); }, rotulo: "Relatorios" }] : []),
                  ] },
                  ...(perfil?.papel === "super_admin" ? [{ titulo: "Instalacao", itens: [{ aba: "instalar", rotulo: "Instalar widget" }] }] : []),
                ] as { titulo: string; itens: ({ rotulo: string; desligado?: boolean } & ({ aba: typeof abaConfig } | { href: string } | { abrir: () => void }))[] }[])
                  .map((g) => ({ ...g, itens: g.itens.filter((it) => casaBuscaConfig(it.rotulo)) }))
                  .filter((g) => g.itens.length > 0);
                return grupos.length ? grupos.map((g) => (
                    <div key={g.titulo} className="flex shrink-0 gap-1 md:mb-3 md:block">
                      <p className="hidden px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground md:block">{g.titulo}</p>
                      {g.itens.map((it) => {
                        const base = "flex shrink-0 items-center whitespace-nowrap rounded-lg px-3 py-1.5 text-left font-medium md:w-full";
                        if ("aba" in it) {
                          return (
                            <button key={it.rotulo}
                              onClick={() => {
                                setAbaConfig(it.aba);
                                // as abas de admin dependem do carregamento que antes so o menu do perfil fazia
                                if (["usuarios", "departamentos", "fichacfg", "automacao"].includes(it.aba)) carregarAdmin();
                              }}
                              className={`${base} ${abaConfig === it.aba ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}>
                              {it.rotulo}
                            </button>
                          );
                        }
                        if ("href" in it) {
                          return (
                            <a key={it.rotulo} href={it.href} title="Abre em tela propria"
                              className={`${base} text-muted-foreground hover:bg-muted`}>
                              {it.rotulo}
                              {it.desligado && (
                                <span className="ml-1.5 rounded bg-muted px-1.5 py-px text-[11px] font-normal text-muted-foreground">desligado</span>
                              )}
                            </a>
                          );
                        }
                        return (
                          <button key={it.rotulo} onClick={it.abrir} title="Abre em tela propria"
                            className={`${base} text-muted-foreground hover:bg-muted`}>
                            {it.rotulo}
                          </button>
                        );
                      })}
                    </div>
                  )) : (
                    <p className="px-3 py-2 text-xs text-muted-foreground">Nada com esse nome nas configuracoes.</p>
                  ); })()}
              </nav>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
              {abaConfig === "conta" && (
                <div className="max-w-md space-y-5">
                  {perfil?.perfil_conta_disponivel === false && (
                    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-900">
                      Foto e preferencias de aviso ainda nao estao disponiveis nesta instalacao:
                      falta rodar a migration <code>0011_perfil_preferencias.sql</code> no banco.
                      Troca de senha e assinatura funcionam normalmente.
                    </div>
                  )}
                  {perfil?.perfil_conta_erro && (
                    <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-[11px] text-red-800">
                      Nao consegui carregar suas preferencias agora — o que aparece abaixo e o padrao,
                      nao o que voce tem gravado. Nada sera salvo ate a leitura voltar: recarregue a
                      pagina daqui a pouco.
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <AvatarPessoa nome={perfil?.nome || "?"} foto={perfil?.foto_url} tamanho="h-16 w-16" texto="text-lg" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{perfil?.nome}</p>
                      <p className="truncate text-xs text-muted-foreground">{perfil?.email}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {perfil?.papel === "super_admin" ? "Super admin" : "Usuario"} — ve{" "}
                        {perfil?.escopo_visao === "todas" ? "todas as conversas"
                          : perfil?.escopo_visao === "departamento" ? "as conversas do departamento"
                          : "somente as proprias conversas"}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <input ref={inputFoto} type="file" accept="image/jpeg,image/png,image/webp"
                          className="hidden"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) enviarFoto(f); }} />
                        <button onClick={() => inputFoto.current?.click()} disabled={enviandoFoto}
                          className="rounded-lg border px-2.5 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50">
                          {enviandoFoto ? "Enviando..." : perfil?.foto_url ? "Trocar foto" : "Escolher foto"}
                        </button>
                        {perfil?.foto_url && (
                          <button onClick={removerFoto} disabled={enviandoFoto}
                            className="text-[11px] text-red-600 underline underline-offset-2 disabled:opacity-50">
                            remover
                          </button>
                        )}
                        <span className="text-[11px] text-muted-foreground">JPG, PNG ou WEBP, ate 2 MB</span>
                      </div>
                      {fotoMsg && <p className="mt-1 text-[11px] text-muted-foreground">{fotoMsg}</p>}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Alterar senha</p>
                    <div className="space-y-2">
                      <input type="password" value={senhaAtual} onChange={(e) => { setSenhaAtual(e.target.value); setSenhaOk(false); }}
                        autoComplete="current-password" placeholder="Senha atual"
                        className="w-full rounded-lg border bg-white px-3 py-2 text-xs outline-none" />
                      <input type="password" value={novaSenha} onChange={(e) => { setNovaSenha(e.target.value); setSenhaOk(false); }}
                        autoComplete="new-password" placeholder="Nova senha (min. 8)"
                        className="w-full rounded-lg border bg-white px-3 py-2 text-xs outline-none" />
                      <div className="flex gap-2">
                        <input type="password" value={confirmaSenha} onChange={(e) => { setConfirmaSenha(e.target.value); setSenhaOk(false); }}
                          autoComplete="new-password" placeholder="Repita a nova senha"
                          onKeyDown={(e) => { if (e.key === "Enter") trocarSenha(); }}
                          className="flex-1 rounded-lg border bg-white px-3 py-2 text-xs outline-none" />
                        <button onClick={trocarSenha} disabled={salvandoSenha || !senhaAtual || !novaSenha || !confirmaSenha}
                          className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white disabled:opacity-50">
                          {salvandoSenha ? "Salvando..." : "Salvar"}
                        </button>
                      </div>
                    </div>
                    {senhaMsg && (
                      <p className={`mt-1 text-[11px] ${senhaOk ? "text-emerald-700" : "text-red-600"}`}>{senhaMsg}</p>
                    )}
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      A senha vale pra todos os apps que usam este mesmo login.
                    </p>
                  </div>
                  <div>
                    <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
                      <Bell className="h-3.5 w-3.5" /> Avisos
                    </p>
                    <div className="space-y-2">
                      <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
                        <span>
                          <span className="block text-xs font-medium">Som do sininho</span>
                          <span className="block text-[11px] text-muted-foreground">
                            Um bip curto quando chega notificacao nova (mencao numa anotacao, conversa atribuida a voce).
                          </span>
                        </span>
                        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0"
                          checked={(perfil?.preferencias || PREFERENCIAS_PADRAO).som}
                          disabled={perfil?.perfil_conta_disponivel === false}
                          onChange={(e) => trocarPreferencia("som", e.target.checked)} />
                      </label>
                      <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
                        <span>
                          <span className="block text-xs font-medium">Aviso na area de trabalho</span>
                          <span className="block text-[11px] text-muted-foreground">
                            Aparece so com esta aba em segundo plano, e depende de o navegador autorizar.
                            Nao funciona com o navegador fechado.
                          </span>
                        </span>
                        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0"
                          checked={(perfil?.preferencias || PREFERENCIAS_PADRAO).desktop}
                          disabled={perfil?.perfil_conta_disponivel === false}
                          onChange={(e) => trocarPreferencia("desktop", e.target.checked)} />
                      </label>
                    </div>
                    {prefMsg && <p className="mt-1 text-[11px] text-red-600">{prefMsg}</p>}
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Modo supervisor</p>
                    <div className="space-y-2">
                      <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
                        <span>
                          <span className="block text-xs font-medium">Abrir conversa nao marca como lida</span>
                          <span className="block text-[11px] text-muted-foreground">
                            Pra quem acompanha o atendimento dos outros: as conversas que voce abre continuam
                            marcadas como nao lidas pro time.
                          </span>
                        </span>
                        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0"
                          checked={(perfil?.preferencias || PREFERENCIAS_PADRAO).supervisor}
                          disabled={perfil?.perfil_conta_disponivel === false}
                          onChange={(e) => trocarPreferencia("supervisor", e.target.checked)} />
                      </label>
                      {(perfil?.preferencias || PREFERENCIAS_PADRAO).supervisor && (
                        <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
                          <span>
                            <span className="block text-xs font-medium">Responder zera o contador</span>
                            <span className="block text-[11px] text-muted-foreground">
                              Se voce responder a conversa, ela deixa de aparecer como nao lida. Desligado, o
                              contador so cai quando outra pessoa abrir a conversa.
                            </span>
                          </span>
                          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0"
                            checked={(perfil?.preferencias || PREFERENCIAS_PADRAO).supervisor_responder_zera}
                            disabled={perfil?.perfil_conta_disponivel === false}
                            onChange={(e) => trocarPreferencia("supervisor_responder_zera", e.target.checked)} />
                        </label>
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Assinatura nas mensagens</p>
                    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
                      <span>
                        <span className="block text-xs font-medium">Assinar com meu nome</span>
                        <span className="block text-[11px] text-muted-foreground">
                          O nome sai em negrito na frente de toda mensagem que voce enviar.
                        </span>
                      </span>
                      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0"
                        checked={perfil?.assinatura_ativa === true}
                        onChange={(e) => trocarAssinatura({ assinatura_ativa: e.target.checked })} />
                    </label>
                    {perfil?.assinatura_ativa && (
                      <input value={assinaturaNome} maxLength={60}
                        onChange={(e) => setAssinaturaNome(e.target.value)}
                        onBlur={() => {
                          const v = assinaturaNome.trim();
                          if (v !== (perfil?.assinatura_nome || "")) trocarAssinatura({ assinatura_nome: v });
                        }}
                        placeholder={perfil?.nome || "Nome que aparece"}
                        className="mt-2 w-full rounded-lg border bg-white px-3 py-2 text-xs outline-none" />
                    )}
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">
                      Verificacao em duas etapas (2FA)
                    </p>
                    {mfaTem === null ? (
                      <p className="text-xs text-muted-foreground">Carregando...</p>
                    ) : mfaTem ? (
                      <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                        <p className="text-xs">
                          <strong>Ativa.</strong> O login deste painel pede o codigo do app autenticador.
                        </p>
                        <button onClick={desativar2fa}
                          className="shrink-0 rounded-lg bg-red-100 px-3 py-1.5 text-[11px] font-medium text-red-700 hover:opacity-80">
                          Desativar
                        </button>
                      </div>
                    ) : mfaEnrol ? (
                      <div className="space-y-2 rounded-lg border p-3">
                        <p className="text-xs">
                          Escaneie o QR no app autenticador (Google Authenticator, 1Password, Authy...) e
                          digite o codigo de 6 digitos pra confirmar:
                        </p>
                        {mfaEnrol.qr && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={mfaEnrol.qr} alt="QR do 2FA" className="h-40 w-40 rounded bg-white p-1" />
                        )}
                        <p className="break-all text-[11px] text-muted-foreground">
                          Sem camera? Digite a chave no app: <code>{mfaEnrol.secret}</code>
                        </p>
                        <div className="flex gap-2">
                          <input value={mfaCod} onChange={(e) => setMfaCod(e.target.value.replace(/\D/g, ""))}
                            inputMode="numeric" maxLength={6} placeholder="Codigo de 6 digitos"
                            className="flex-1 rounded-lg border bg-white px-3 py-2 text-xs outline-none" />
                          <button onClick={confirmar2fa} disabled={mfaCod.length < 6}
                            className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white disabled:opacity-50">
                            Confirmar
                          </button>
                          <button onClick={() => { setMfaEnrol(null); setMfaCod(""); }}
                            className="rounded-lg border px-3 py-2 text-xs hover:bg-muted">
                            Cancelar
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                        <p className="text-xs text-muted-foreground">
                          Desativada. Ative pra exigir um codigo do celular alem da senha.
                        </p>
                        <button onClick={comecar2fa}
                          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90">
                          Ativar 2FA
                        </button>
                      </div>
                    )}
                    {mfaMsg && <p className="mt-1 text-[11px] text-muted-foreground">{mfaMsg}</p>}
                  </div>
                  <div>
                    <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
                      <KeyRound className="h-3.5 w-3.5" /> Chave de agente de IA (MCP)
                    </p>
                    <p className="mb-2 text-[11px] text-muted-foreground">
                      Deixa o seu Claude operar este painel com as suas permissoes — nada alem do
                      que voce ja ve aqui. Nao precisa instalar nada: gere a chave, copie o comando
                      e cole no Claude.{" "}
                      <a href="https://expert-integrado.github.io/expert-chat-mcp/" target="_blank"
                        rel="noreferrer noopener" className="underline underline-offset-2">
                        Como funciona
                      </a>
                    </p>
                    {chaveNova && (
                      <div className="mb-2 space-y-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3">
                        <p className="text-[11px] font-medium text-emerald-900">
                          Chave gerada ({chaveNova.nome}). Copie o comando abaixo e cole no Claude — aparece uma vez so:
                        </p>
                        <div className="flex items-start gap-2">
                          <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1.5 text-[11px] leading-relaxed">
                            {comandoMcp(chaveNova.chave)}
                          </code>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(comandoMcp(chaveNova.chave)).then(() => setChaveCopiada(true)).catch(() => {});
                            }}
                            className="flex shrink-0 items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-medium text-white hover:opacity-90">
                            <Copy className="h-3 w-3" /> {chaveCopiada ? "Copiado" : "Copiar comando"}
                          </button>
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-emerald-800">
                          <span className="shrink-0">so a chave:</span>
                          <code className="min-w-0 flex-1 break-all rounded bg-white/70 px-1.5 py-1">{chaveNova.chave}</code>
                          <button
                            onClick={() => { navigator.clipboard.writeText(chaveNova.chave).then(() => setKeyCopiada(true)).catch(() => {}); }}
                            className="shrink-0 underline underline-offset-2">
                            {keyCopiada ? "copiada" : "copiar"}
                          </button>
                        </div>
                        <button onClick={() => { setChaveNova(null); setChaveCopiada(false); setKeyCopiada(false); }}
                          className="text-[11px] text-emerald-800 underline underline-offset-2">
                          Ja copiei, pode esconder
                        </button>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <input value={chaveNome} onChange={(e) => setChaveNome(e.target.value)} maxLength={60}
                        placeholder="Nome da chave (ex: meu notebook)"
                        className="flex-1 rounded-lg border bg-white px-3 py-2 text-xs outline-none" />
                      <button onClick={gerarMinhaChave} disabled={gerandoChave}
                        className="shrink-0 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50">
                        {gerandoChave ? "Gerando..." : "Gerar chave"}
                      </button>
                    </div>
                    <MinhaChaveEscopo
                      recursos={recursosChave}
                      canais={canais}
                      escopo={escopoNova}
                      prazo={prazoNova}
                      aoMudarEscopo={setEscopoNova}
                      aoMudarPrazo={setPrazoNova}
                      desabilitado={!escopoChaveOk}
                    />
                    {chaveMsg && <p className="mt-1 text-[11px] text-red-600">{chaveMsg}</p>}
                    {minhasChaves === null ? (
                      <p className="mt-2 text-xs text-muted-foreground">Carregando...</p>
                    ) : minhasChaves.length === 0 ? (
                      <p className="mt-2 text-[11px] text-muted-foreground">Voce ainda nao tem chave ativa.</p>
                    ) : (
                      <div className="mt-2 space-y-1.5">
                        {minhasChaves.map((c) => (
                          <div key={c.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                            <div className="min-w-0">
                              <p className="truncate text-xs font-medium">{c.nome}</p>
                              <p className="text-[11px] text-muted-foreground">
                                criada em {formatarData(c.criado_em, FUSO_UI)}
                                {c.ultimo_uso_em
                                  ? ` — ultimo uso ${dataHoraCompleta(c.ultimo_uso_em)}`
                                  : " — nunca usada"}
                                {c.ultimo_uso_ip ? ` (de ${c.ultimo_uso_ip})` : ""}
                              </p>
                              {/* FRENTE Q: o RECORTE da chave, na linha dela. Sem
                                  isto a pessoa nao tem como saber o que a chave
                                  alcanca — e chave restrita que parece aberta faz
                                  o dono achar que o agente esta quebrado. */}
                              {c.escopo_resumo && (
                                <p className="text-[11px] text-muted-foreground">
                                  alcance: {c.escopo_resumo}
                                  {c.expira_em ? ` — prazo ${String(c.expira_em).slice(0, 10)}` : ""}
                                  {c.expirada ? " (vencida)" : ""}
                                </p>
                              )}
                            </div>
                            <button onClick={() => revogarMinhaChave(c.id, c.nome)}
                              className="shrink-0 rounded-lg bg-red-100 px-3 py-1.5 text-[11px] font-medium text-red-700 hover:opacity-80">
                              Revogar
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {abaConfig === "respostas" && (
                <div className="max-w-lg space-y-3">
                  <p className="text-[11px] text-muted-foreground">
                    Digite <code>/</code> no campo de mensagem pra usar. As suas so voce ve;
                    as globais valem pra equipe inteira{perfil?.papel === "super_admin" ? "" : " (so o super admin cria globais)"}.
                  </p>
                  <div className="space-y-2 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">/</span>
                      <input value={rrAtalho} onChange={(e) => setRrAtalho(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
                        placeholder="atalho (ex: saudacao)" maxLength={30}
                        className="flex-1 rounded-lg border bg-white px-2 py-1.5 text-xs outline-none" />
                      {perfil?.papel === "super_admin" && (
                        <label className="flex shrink-0 items-center gap-1.5 text-[11px]">
                          <input type="checkbox" checked={rrGlobal} onChange={(e) => setRrGlobal(e.target.checked)} />
                          global (equipe toda)
                        </label>
                      )}
                    </div>
                    <textarea value={rrTexto} onChange={(e) => setRrTexto(e.target.value)} rows={3} maxLength={2000}
                      placeholder="Texto completo da resposta"
                      className="w-full resize-none rounded-lg border bg-white px-2 py-1.5 text-xs outline-none" />
                    <button
                      onClick={async () => {
                        const r = await authedFetch("/api/respostas-rapidas", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ atalho: rrAtalho, texto: rrTexto, global: rrGlobal }),
                        });
                        if (!r.ok) setAviso((await r.json().catch(() => ({}))).error || "Falha ao criar resposta");
                        else {
                          setRrAtalho(""); setRrTexto(""); setRrGlobal(false);
                          // recarrega a lista DO CADASTRO; a do composer se refaz
                          // ao abrir a conversa, ja com as variaveis resolvidas
                          carregarCadastroRespostas();
                          if (active) carregarRespostasRapidas({ chat_id: active.chat_id, canal: active.canal });
                        }
                      }}
                      disabled={!rrAtalho || !rrTexto.trim()}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                      Criar resposta rapida
                    </button>
                  </div>
                  <div className="divide-y rounded-lg border">
                    {rrCadastro.length === 0 && (
                      <p className="px-3 py-3 text-xs text-muted-foreground">Nenhuma resposta rapida ainda.</p>
                    )}
                    {rrCadastro.map((r) => (
                      <div key={r.id} className="flex items-start justify-between gap-2 px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-primary">
                            /{r.atalho}
                            {r.global && <span className="ml-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">GLOBAL</span>}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">{r.texto.slice(0, 120)}</p>
                        </div>
                        {(!r.global || perfil?.papel === "super_admin") && (
                          <button
                            onClick={async () => {
                              const rr = await authedFetch(`/api/respostas-rapidas?id=${r.id}`, { method: "DELETE" });
                              if (!rr.ok) setAviso("Falha ao apagar");
                              carregarCadastroRespostas();
                              if (active) carregarRespostasRapidas({ chat_id: active.chat_id, canal: active.canal });
                            }}
                            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {abaConfig === "usuarios" && temPermissao("gerenciar_usuarios") && (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground">
                    Clique numa pessoa pra abrir as opcoes dela: papel, o que ela ve, assinatura nas
                    mensagens e acesso. Quem esta em cada departamento se gerencia na aba Departamentos.
                  </p>
                  {/* FRENTE Q — entrada da visao de acesso e seguranca (janela de
                      horario, dispositivos, recorte por funil/canal e escopo das
                      chaves). Tela cheia, nao aba: ver o cabecalho de
                      app/admin-acesso.tsx. */}
                  <button
                    onClick={() => { setConfigAberta(false); setAcessoDe(""); setVisaoPainel("acesso"); }}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left hover:bg-muted">
                    <span>
                      <span className="flex items-center gap-1.5 text-xs font-medium">
                        <ShieldCheck className="h-3.5 w-3.5" /> Acesso e seguranca
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        Horario em que cada pessoa entra, de onde ela acessa, recorte por numero e
                        funil, e o alcance das chaves de agente.
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] text-primary">abrir</span>
                  </button>
                  <div className="divide-y rounded-lg border">
                    {adminUsuarios.map((u) => (
                      <button key={u.id} onClick={() => setUsuarioAberto(u)}
                        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted ${
                          u.ativo === false ? "opacity-50" : ""}`}>
                        <AvatarPessoa nome={u.nome} foto={u.foto_url} tamanho="h-9 w-9" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium">{u.nome}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{u.email}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {u.papel === "super_admin" && (
                            <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">ADMIN</span>
                          )}
                          {u.assinatura_ativa && (
                            <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-bold text-green-700">ASSINATURA</span>
                          )}
                          {u.ativo === false && (
                            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">DESATIVADO</span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {abaConfig === "departamentos" && temPermissao("gerenciar_usuarios") && (
                <div className="max-w-md space-y-3">
                  <div className="flex gap-2">
                    <input value={novoDep} onChange={(e) => setNovoDep(e.target.value)}
                      placeholder="Novo departamento"
                      className="flex-1 rounded-lg border bg-white px-3 py-2 text-xs outline-none" />
                    <button onClick={() => novoDep.trim() && salvarDepartamento({ nome: novoDep })}
                      disabled={!novoDep.trim()}
                      className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white disabled:opacity-50">
                      Criar
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Uma pessoa pode estar em varios departamentos — adicione ela em cada um.
                  </p>
                  {adminDeps.map((d) => (
                    <div key={d.id} className="rounded-lg border px-3 py-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className={`font-medium ${d.ativo ? "" : "text-muted-foreground line-through"}`}>{d.nome}</span>
                        <button onClick={() => salvarDepartamento({ id: d.id, ativo: !d.ativo })}
                          className="text-[11px] text-primary hover:underline">
                          {d.ativo ? "Desativar" : "Reativar"}
                        </button>
                      </div>
                      {d.ativo && (
                        <div className="mt-2 flex items-center gap-2">
                          <span className="text-[11px] uppercase text-muted-foreground">Visao do departamento</span>
                          <select
                            value={d.escopo_visao || ""}
                            onChange={(e) => salvarDepartamento({ id: d.id, escopo_visao: e.target.value || null })}
                            className="rounded border bg-white px-1.5 py-0.5 text-[11px] outline-none"
                            title="Regra que vale pra TODOS os membros deste departamento (substitui a individual)"
                          >
                            <option value="">Cada membro usa a propria</option>
                            <option value="todas">Todas as conversas</option>
                            <option value="departamento">Do departamento</option>
                            <option value="proprias">Somente as proprias</option>
                          </select>
                        </div>
                      )}
                      {d.ativo && (
                        <div className="mt-2 flex flex-wrap items-center gap-1">
                          {d.membros.map((m) => (
                            <span key={m.id} className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                              {m.nome}
                              <button title={`Tirar ${m.nome} de ${d.nome}`}
                                onClick={() => salvarDepartamento({ id: d.id, remove_user_id: m.id })}
                                className="rounded-full hover:bg-primary/20">
                                <X className="h-3 w-3" />
                              </button>
                            </span>
                          ))}
                          <select
                            value=""
                            onChange={(e) => {
                              const u = adminUsuarios.find((x) => x.id === e.target.value);
                              if (u) salvarDepartamento({ id: d.id, add_user_id: u.id, add_user_nome: u.nome });
                            }}
                            className="rounded border bg-white px-1.5 py-0.5 text-[11px] outline-none"
                          >
                            <option value="">+ adicionar pessoa</option>
                            {adminUsuarios
                              .filter((u) => !d.membros.some((m) => m.id === u.id))
                              .map((u) => (
                                <option key={u.id} value={u.id}>{u.nome}</option>
                              ))}
                          </select>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {abaConfig === "fichacfg" && temPermissao("gerenciar_etiquetas") && (
                <div className="max-w-md">
                  {/* TRANCHE 2 (03/09/2026): a metade "Campos da ficha" desta aba saiu — ela so
                      criava/reativava e mandava pra /campos pro resto (duas telas pra uma coisa).
                      O construtor inteiro agora e a aba "Campos da ficha", ao lado. Aqui ficou so
                      o catalogo de etiquetas. */}
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold uppercase text-muted-foreground">Etiquetas (catalogo unico)</p>
                    <p className="text-[11px] text-muted-foreground">
                      Etiqueta e o marcador livre da conversa (segmento, campanha, situacao). Campo da ficha
                      e outra coisa: dado estruturado do contato — mora em{" "}
                      <button type="button" onClick={() => setAbaConfig("campos")} className="text-primary underline">
                        Campos da ficha
                      </button>.
                    </p>
                    <div className="flex gap-2">
                      <input value={novaEtiquetaCatalogo} onChange={(e) => setNovaEtiquetaCatalogo(e.target.value)}
                        placeholder="Nova etiqueta"
                        className="flex-1 rounded-lg border bg-white px-3 py-1.5 text-xs outline-none" />
                      <button onClick={() => novaEtiquetaCatalogo.trim() && salvarCatalogo({ tipo: "etiqueta", nome: novaEtiquetaCatalogo })}
                        disabled={!novaEtiquetaCatalogo.trim()}
                        className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                        Criar
                      </button>
                    </div>
                    <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                      {(fichaCfg?.etiquetas || []).map((c: any) => (
                        <div key={c.id} className="flex items-center justify-between rounded border px-2 py-1 text-xs">
                          <span className={c.ativo ? "" : "text-muted-foreground line-through"}>{c.nome}</span>
                          <button onClick={() => salvarCatalogo({ tipo: "etiqueta", id: c.id, ativo: !c.ativo })}
                            className="text-[11px] text-primary hover:underline">
                            {c.ativo ? "Remover" : "Reativar"}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* CAMPOS DA FICHA (tranche 2, 03/09/2026): o construtor inteiro (criar, tipar,
                  reordenar, arquivar com impacto medido) mora AQUI, no mapa; a aba antiga so
                  criava/reativava e mandava pra /campos pro resto — duas telas pra uma coisa.
                  /campos continua valendo como link direto. */}
              {abaConfig === "campos" && temPermissao("gerenciar_campos") && (
                <AdminCampos authedFetch={authedFetch} embutido />
              )}

              {/* ───── INSTALAR WIDGET (Eric 02/09/2026, card 86akaap3m) ─────
                  Quem instala o painel dentro de outro software escolhe a forma, o recorte e
                  recebe o codigo pronto. Regra da casa: o widget e o USO DIARIO (conversa que a
                  pessoa enxerga); configuracao, automacao e usuarios ficam so nesta tela cheia. */}
              {abaConfig === "instalar" && perfil?.papel === "super_admin" && (
                <div className="max-w-xl space-y-5">
                  {instErro && (
                    <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-[11px] text-red-800">{instErro}</div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    O widget e a tela de <strong>atendimento do dia a dia</strong> dentro de outro sistema
                    (portal, CRM, intranet). A pessoa loga com o mesmo usuario e 2FA e ve o que o papel
                    dela permite — configuracao, automacao e usuarios continuam so aqui.
                  </p>

                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold">1. Onde o widget vai ficar</h3>
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        ["tela", "Modulo em tela cheia", "ocupa a pagina inteira do sistema (o que o Portal do Aluno usa)"],
                        ["balao", "Balao flutuante", "botao redondo no canto que abre uma janela de 400x620"],
                        ["lateral", "Painel lateral", "aba na borda direita que desliza um painel de 460px"],
                      ] as const).map(([id, titulo, desc]) => (
                        <button key={id} type="button" onClick={() => setInstForma(id)}
                          className={`rounded-lg border p-2 text-left text-[11px] ${instForma === id ? "border-primary bg-primary/10" : "hover:bg-muted"}`}>
                          <span className="block font-medium">{titulo}</span>
                          <span className="block text-muted-foreground">{desc}</span>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold">2. O que a pessoa ve la dentro</h3>
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <select value={instContexto} onChange={(e) => { setInstContexto(e.target.value); setInstToken(null); }}
                        className="min-w-[220px] rounded-lg border bg-white px-2 py-1 outline-none">
                        <option value="">Tudo que o usuario ja pode ver (sem recorte)</option>
                        {(instInfo?.contextos || []).map((c) => (
                          <option key={c.id} value={c.id}>{c.nome} ({c.id})</option>
                        ))}
                      </select>
                      {instContexto && (
                        <>
                          <label className="flex items-center gap-1">
                            valido por
                            <input type="number" min={1} max={instInfo?.teto_dias || 90} value={instDias}
                              onChange={(e) => setInstDias(Math.max(1, Math.min(instInfo?.teto_dias || 90, Number(e.target.value) || 1)))}
                              className="w-14 rounded-lg border px-1.5 py-1 outline-none" />
                            dia(s)
                          </label>
                          <button type="button" onClick={gerarTokenInstalacao} disabled={instInfo?.jwt_configurado === false}
                            className="rounded-lg bg-primary px-3 py-1 font-medium text-primary-foreground disabled:opacity-50">
                            Gerar token de recorte
                          </button>
                        </>
                      )}
                    </div>
                    {instContexto && instInfo?.jwt_configurado === false && (
                      <p className="text-[11px] text-amber-800">
                        Esta instalacao nao tem <code>EMBED_JWT_SECRET</code> configurado — sem ele nao existe recorte por contexto.
                      </p>
                    )}
                    {instContexto && instToken && (
                      <p className="text-[11px] text-muted-foreground">
                        Token gerado, valido ate {new Date(instToken.expira_em).toLocaleDateString("pt-BR")}. Ele so
                        <strong> restringe</strong> quem ja esta logado — quem tiver o link ve MENOS, nunca mais. Ja esta dentro do codigo abaixo.
                      </p>
                    )}
                    {!instContexto && (
                      <p className="text-[11px] text-muted-foreground">
                        Sem recorte, a pessoa ve dentro do widget as mesmas conversas que ve aqui. Pra limitar a uma
                        area (BU), escolha um contexto: os contextos nascem no cadastro de visao por area.
                      </p>
                    )}
                    {instInfo?.mint_configurado && (
                      <details className="text-[11px] text-muted-foreground">
                        <summary className="cursor-pointer">Hospedeiro com backend? Cunhe o token por sessao, servidor a servidor</summary>
                        <pre className="mt-1 overflow-x-auto rounded-lg bg-muted p-2 text-[11px]">{`curl -X POST ${(instInfo?.painel_url || "").replace(/\/$/, "")}/api/embed/token \\\n  -H "Authorization: Bearer $EMBED_MINT_SECRET" \\\n  -H "Content-Type: application/json" \\\n  -d '{"contexto":"${instContexto || "<id-do-contexto>"}"}'`}</pre>
                        <p className="mt-1">Resposta: <code>{`{ token, expira_em }`}</code> (8h por padrao; <code>dias</code> no corpo estende ate {instInfo?.teto_dias || 90}). O segredo mora so no servidor do hospedeiro.</p>
                      </details>
                    )}
                  </section>

                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold">3. Libere o site que vai hospedar</h3>
                    <input value={instOrigem} onChange={(e) => setInstOrigem(e.target.value)} placeholder="https://app.suaempresa.com.br"
                      className="w-full rounded-lg border px-2 py-1 text-[11px] outline-none" />
                    {(() => {
                      const origem = origemNormalizada(instOrigem);
                      const liberadas = instInfo?.origens_liberadas || [];
                      if (!instOrigem.trim()) {
                        return (
                          <p className="text-[11px] text-muted-foreground">
                            Hoje podem emoldurar o widget: {liberadas.length ? liberadas.map((o) => <code key={o} className="mr-1">{o}</code>) : <em>nenhum site (o widget so abre direto)</em>}.
                          </p>
                        );
                      }
                      if (!origem) return <p className="text-[11px] text-red-700">Endereco invalido — cole a URL completa, com https://</p>;
                      const ok = liberadas.includes(origem);
                      return (
                        <div className={`rounded-lg border p-2 text-[11px] ${ok ? "border-green-300 bg-green-50 text-green-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
                          {ok ? (
                            <>A origem <code>{origem}</code> ja esta liberada. Pode colar o codigo.</>
                          ) : (
                            <>
                              <code>{origem}</code> ainda <strong>nao</strong> pode emoldurar o widget. Acrescente essa origem a
                              variavel <code>EMBED_FRAME_ANCESTORS</code> (separada por espaco das que ja existem) e
                              <strong> publique de novo</strong> — e configuracao de build, nao muda em tempo real. Depois confira:
                              <pre className="mt-1 overflow-x-auto rounded bg-white/70 p-1.5 text-[11px]">{`curl -sI ${(instInfo?.painel_url || "").replace(/\/$/, "")}/widget | grep -i content-security-policy`}</pre>
                            </>
                          )}
                        </div>
                      );
                    })()}
                  </section>

                  <section className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold">4. Cole no seu sistema</h3>
                      <div className="flex items-center gap-2 text-[11px]">
                        {instForma === "tela" && (
                          <button type="button" onClick={() => setInstJsx((v) => !v)} className="rounded-lg border px-2 py-0.5 hover:bg-muted">
                            {instJsx ? "ver HTML" : "ver React (JSX)"}
                          </button>
                        )}
                        <button type="button" onClick={() => copiarInstalacao(snippetInstalacao(), "snippet")}
                          className="flex items-center gap-1 rounded-lg bg-primary px-2 py-0.5 font-medium text-primary-foreground">
                          <Copy className="h-3 w-3" /> {instCopiado === "snippet" ? "Copiado" : "Copiar codigo"}
                        </button>
                      </div>
                    </div>
                    <pre data-testid="snippet-instalar" className="max-h-64 overflow-auto rounded-lg bg-muted p-2 text-[11px] leading-relaxed">{snippetInstalacao()}</pre>
                    <p className="text-[11px] text-muted-foreground">
                      Endereco do widget: <code>{urlWidgetInstalacao().slice(0, 80)}{urlWidgetInstalacao().length > 80 ? "..." : ""}</code>
                      <button type="button" onClick={() => copiarInstalacao(urlWidgetInstalacao(), "url")} className="ml-2 underline">
                        {instCopiado === "url" ? "copiado" : "copiar so o endereco"}
                      </button>
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Extensao do Chrome, favorito ou app de desktop: use so o endereco acima — e a mesma tela, o mesmo banco.
                    </p>
                  </section>
                </div>
              )}
              {abaConfig === "automacao" && temPermissao("automacao") && (
                <div className="max-w-lg space-y-3">
                  <p className="text-[11px] text-muted-foreground">
                    Regras automaticas do fluxo de atendimento — valem pro painel inteiro.
                  </p>
                  {/* AVISO DE VERSAO (Eric, 09/09/2026): o modulo de automacoes por FLUXO
                      (menu Automacao, /fluxos) e outra coisa que estas regras: nasce
                      desligado (lib/modulos.ts) e ainda nao foi validado em operacao real.
                      Quem for instalar/ligar precisa ler a recomendacao AQUI, na
                      configuracao — nao existe tela pra ligar (env MODULOS ou SQL). */}
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                    <p className="font-medium">
                      Modulo de automacoes por fluxo:{" "}
                      {perfil?.modulos?.automacao ? "LIGADO nesta instalacao" : "desligado de fabrica nesta versao"}.
                    </p>
                    <p className="mt-0.5">
                      Ele ainda esta em validacao e nao e uma versao estavel. Recomendacao: nao ligue
                      ate a versao estavel sair{perfil?.modulos?.automacao ? "; como ja esta ligado, use so em teste, nunca no atendimento real" : ""}.
                      Quem quiser testar liga pela variavel MODULOS ou pela chave modulos da config (ver README).
                      As regras desta aba nao dependem desse modulo.
                    </p>
                  </div>
                  {cfgAuto === null ? (
                    <p className="text-xs text-muted-foreground">Carregando...</p>
                  ) : (
                    ([
                      ["auto_arquivar_concluida", "Conversa concluida e arquivada automaticamente"],
                      ["auto_desarquivar_recebida", "Mensagem recebida desarquiva e reabre a conversa (concluida vira Em aberto)"],
                      ["auto_atendimento_ao_responder", "Responder uma conversa move ela pra Em atendimento"],
                      // `auto_atendimento_bot` NAO entra nesta lista: a chave existe no
                      // servidor mas o motor de fluxo ainda nao a le, e interruptor que
                      // nao muda nada e mentira na tela. Exposta de novo quando a costura
                      // do motor entrar (coordenador, no merge) — ver CLAUDE.md.
                      ["exigir_2fa", "Exigir verificacao em duas etapas (2FA) de todo mundo no login"],
                      ["auto_distribuir", "Conversa nova sem responsavel entra no rodizio automatico (entre quem esta online)"],
                      ["csat_ativo", "Concluir atendimento envia pesquisa de satisfacao (cliente responde nota 1 a 5)"],
                      ["seletor_visao", "Seletor de visao: time pode restringir a propria lista a um contexto (ex: so alunos)"],
                    ] as [keyof CfgAuto, string][]).map(([chave, rotulo]) => (
                      <div key={chave} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                        <span className="text-xs">{rotulo}</span>
                        <div className="flex shrink-0 gap-1">
                          <button
                            onClick={() => trocarConfigAuto(chave, true)}
                            className={`rounded-l-lg border px-3 py-1 text-[11px] font-medium ${cfgAuto[chave] ? "border-primary bg-primary text-white" : "hover:bg-muted"}`}
                          >
                            Sim
                          </button>
                          <button
                            onClick={() => trocarConfigAuto(chave, false)}
                            className={`-ml-1 rounded-r-lg border px-3 py-1 text-[11px] font-medium ${!cfgAuto[chave] ? "border-red-500 bg-red-500 text-white" : "hover:bg-muted"}`}
                          >
                            Nao
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                  {cfgAuto !== null && (
                    <>
                    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                      <div>
                        <span className="text-xs">Desligar sessao automaticamente apos X minutos sem usar</span>
                        <p className="text-[11px] text-muted-foreground">0 = nunca desliga. Vale pra todo mundo.</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <input
                          key={`alm-${cfgAuto.auto_logout_minutos}`}
                          type="number" min={0} max={1440}
                          defaultValue={cfgAuto.auto_logout_minutos}
                          onBlur={(e) => {
                            const n = Math.max(0, Math.min(1440, Math.round(Number(e.target.value) || 0)));
                            if (n !== cfgAuto.auto_logout_minutos) trocarConfigAuto("auto_logout_minutos", n);
                          }}
                          className="w-20 rounded-lg border bg-white px-2 py-1 text-right text-xs outline-none"
                        />
                        <span className="text-[11px] text-muted-foreground">min</span>
                      </div>
                    </div>

                    {/* APROVACAO PENDENTE EXPIRA (decisao do Eric, 03/09/2026: a instalacao
                        escolhe se expira e em quanto tempo). 0 mantem o comportamento
                        antigo: a cadeia espera gente pra sempre. */}
                    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                      <div>
                        <span className="text-xs">Aprovacao pendente na fila de automacao expira depois de X horas</span>
                        <p className="text-[11px] text-muted-foreground">
                          0 = nunca expira. Passou do prazo sem ninguem aprovar: a execucao e cancelada, fica
                          registrada como expirada na fila e nada e enviado.
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <input
                          key={`aeh-${cfgAuto.aprovacao_expira_horas}`}
                          type="number" min={0} max={720}
                          defaultValue={cfgAuto.aprovacao_expira_horas ?? 0}
                          onBlur={(e) => {
                            const n = Math.max(0, Math.min(720, Math.round(Number(e.target.value) || 0)));
                            if (n !== (cfgAuto.aprovacao_expira_horas ?? 0)) trocarConfigAuto("aprovacao_expira_horas", n);
                          }}
                          aria-label="Horas ate a aprovacao pendente expirar"
                          className="w-20 rounded-lg border bg-white px-2 py-1 text-right text-xs outline-none"
                        />
                        <span className="text-[11px] text-muted-foreground">h</span>
                      </div>
                    </div>

                    {/* CONVERSA REINICIADA: a janela vem PRIMEIRO porque as chaves
                        abaixo so existem por causa dela — com 0 minuto nada disso
                        acontece, e ai elas aparecem desabilitadas em vez de
                        aparecerem ligadas sem efeito. */}
                    <div className="space-y-2 rounded-lg border px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <span className="text-xs font-medium">Considerar a conversa REINICIADA depois de X minutos parada</span>
                          <p className="text-[11px] text-muted-foreground">
                            O cliente voltou depois desse tempo sem nenhuma mensagem = atendimento novo.
                            0 = nunca considerar reiniciada (e as chaves abaixo ficam sem efeito).
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <input
                            key={`rein-${cfgAuto.reinicio_minutos}`}
                            type="number" min={0} max={1440}
                            defaultValue={cfgAuto.reinicio_minutos}
                            onBlur={(e) => {
                              const n = Math.max(0, Math.min(1440, Math.round(Number(e.target.value) || 0)));
                              if (n !== cfgAuto.reinicio_minutos) trocarConfigAuto("reinicio_minutos", n);
                            }}
                            className="w-20 rounded-lg border bg-white px-2 py-1 text-right text-xs outline-none"
                          />
                          <span className="text-[11px] text-muted-foreground">min</span>
                        </div>
                      </div>
                      {([
                        [
                          "reinicio_marcar_aberto",
                          "Conversa reiniciada volta pra Em aberto",
                          "So sai de Em atendimento / Aguardando. Conversa concluida continua concluida (quem reabre ela e a chave de mensagem recebida, mais acima).",
                          false,
                        ],
                        [
                          "reinicio_redelegar",
                          "Conversa reiniciada entra no rodizio",
                          "Distribui o retorno do cliente pro atendente online com menos conversas, mesmo com o rodizio de conversa nova desligado. Conversa que ja tem responsavel so muda de mao com a chave abaixo. Nao vale em grupo nem no numero da API oficial (nao ha rodizio ali).",
                          false,
                        ],
                        [
                          "reinicio_remover_delegados",
                          "... e troca o responsavel atual pelo novo",
                          "ATENCAO: tira a conversa de quem estava atendendo e passa pra outra pessoa, que recebe o aviso no sininho. So acontece com atendente online disponivel — sem substituto ninguem e removido, porque conversa sem responsavel fica visivel pra instalacao inteira. Quem perdeu a conversa pode deixar de ve-la, se a visao dele for restrita.",
                          true,
                        ],
                      ] as [keyof CfgAuto, string, string, boolean][]).map(([chave, rotulo, ajuda, dependeRedelegar]) => {
                        const travado =
                          cfgAuto.reinicio_minutos === 0 || (dependeRedelegar && !cfgAuto.reinicio_redelegar);
                        return (
                          <div
                            key={chave}
                            className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${travado ? "opacity-50" : ""}`}
                          >
                            <div>
                              <span className="text-xs">{rotulo}</span>
                              <p className="text-[11px] text-muted-foreground">{ajuda}</p>
                            </div>
                            <div className="flex shrink-0 gap-1">
                              <button
                                disabled={travado}
                                onClick={() => trocarConfigAuto(chave, true)}
                                className={`rounded-l-lg border px-3 py-1 text-[11px] font-medium disabled:cursor-not-allowed ${cfgAuto[chave] ? "border-primary bg-primary text-white" : "hover:bg-muted"}`}
                              >
                                Sim
                              </button>
                              <button
                                disabled={travado}
                                onClick={async () => {
                                  await trocarConfigAuto(chave, false);
                                  // desligar "entra no rodizio" desliga TAMBEM a
                                  // troca de responsavel: deixar a chave
                                  // dependente gravada como `true` faria ela
                                  // ressuscitar sozinha no dia em que alguem
                                  // religasse o rodizio — e o efeito dela e
                                  // tirar conversa de atendente. Estado dormente
                                  // nao volta sem o admin ver.
                                  if (chave === "reinicio_redelegar" && cfgAuto.reinicio_remover_delegados) {
                                    await trocarConfigAuto("reinicio_remover_delegados", false);
                                  }
                                }}
                                className={`-ml-1 rounded-r-lg border px-3 py-1 text-[11px] font-medium disabled:cursor-not-allowed ${!cfgAuto[chave] ? "border-red-500 bg-red-500 text-white" : "hover:bg-muted"}`}
                              >
                                Nao
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                      <div>
                        <span className="text-xs">Teto de conversas em andamento por atendente no rodizio</span>
                        <p className="text-[11px] text-muted-foreground">0 = sem teto.</p>
                      </div>
                      <input
                        key={`teto-${cfgAuto.teto_por_atendente}`}
                        type="number" min={0} max={100}
                        defaultValue={cfgAuto.teto_por_atendente}
                        onBlur={(e) => {
                          const n = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
                          if (n !== cfgAuto.teto_por_atendente) trocarConfigAuto("teto_por_atendente", n);
                        }}
                        className="w-20 shrink-0 rounded-lg border bg-white px-2 py-1 text-right text-xs outline-none"
                      />
                    </div>

                    <div className="space-y-2 rounded-lg border px-3 py-2.5">
                      <div>
                        <span className="text-xs font-medium">Fuso horario desta instalacao</span>
                        <p className="text-[11px] text-muted-foreground">
                          Vale pra TUDO: hora das mensagens, corte de Hoje/Ontem, horario de atendimento,
                          agendamento e relatorio. Formato IANA (ex: America/Sao_Paulo, America/Recife,
                          Europe/Lisbon). Vazio = usa o padrao de quem instalou.
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <input
                          key={`fuso-${cfgAuto.fuso}`}
                          defaultValue={cfgAuto.fuso}
                          placeholder={FUSO_UI}
                          list="fusos-comuns"
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v === cfgAuto.fuso) return;
                            // fuso que o navegador nao conhece nem chega a viajar:
                            // o servidor recusaria igual, mas o aviso na hora e melhor
                            if (v && !fusoValido(v)) {
                              setAviso(`Fuso horario desconhecido: ${v}`);
                              e.target.value = cfgAuto.fuso;
                              return;
                            }
                            trocarConfigAuto("fuso", v);
                          }}
                          className="w-56 rounded-lg border bg-white px-2 py-1 text-xs outline-none"
                        />
                        <datalist id="fusos-comuns">
                          {["America/Sao_Paulo", "America/Recife", "America/Manaus", "America/Belem",
                            "America/Cuiaba", "America/Rio_Branco", "America/New_York", "Europe/Lisbon", "UTC"].map((tz) => (
                            <option key={tz} value={tz} />
                          ))}
                        </datalist>
                        <span className="text-[11px] text-muted-foreground">
                          em uso agora: {FUSO_UI.replace(/_/g, " ")}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2 rounded-lg border px-3 py-2.5">
                      <span className="text-xs font-medium">Horario de atendimento</span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"].map((rot, dia) => (
                          <button key={dia}
                            onClick={() => {
                              const tem = cfgAuto.horario_dias.includes(dia);
                              trocarConfigAuto(
                                "horario_dias",
                                tem ? cfgAuto.horario_dias.filter((d) => d !== dia) : [...cfgAuto.horario_dias, dia].sort()
                              );
                            }}
                            className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium ${
                              cfgAuto.horario_dias.includes(dia) ? "border-primary bg-primary text-white" : "hover:bg-muted"}`}>
                            {rot}
                          </button>
                        ))}
                        <span className="ml-2 text-[11px] text-muted-foreground">das</span>
                        <input type="time" key={`hi-${cfgAuto.horario_inicio}`} defaultValue={cfgAuto.horario_inicio}
                          onBlur={(e) => e.target.value && e.target.value !== cfgAuto.horario_inicio && trocarConfigAuto("horario_inicio", e.target.value)}
                          className="rounded-lg border bg-white px-2 py-1 text-xs outline-none" />
                        <span className="text-[11px] text-muted-foreground">as</span>
                        <input type="time" key={`hf-${cfgAuto.horario_fim}`} defaultValue={cfgAuto.horario_fim}
                          onBlur={(e) => e.target.value && e.target.value !== cfgAuto.horario_fim && trocarConfigAuto("horario_fim", e.target.value)}
                          className="rounded-lg border bg-white px-2 py-1 text-xs outline-none" />
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Usado pelas mensagens automaticas abaixo (canal principal), no fuso configurado acima.
                      </p>
                    </div>

                    {([
                      ["msg_saudacao", "Mensagem de SAUDACAO (primeira mensagem de um contato novo, dentro do horario)", "Vazio = nao envia."],
                      ["msg_ausencia", "Mensagem de AUSENCIA (mensagem recebida fora do horario; no maximo 1 por dia por conversa)", "Vazio = nao envia."],
                      ["csat_msg", "Pergunta da pesquisa de satisfacao (enviada ao concluir, quando a pesquisa esta ligada)", "O cliente responde so o numero (1 a 5)."],
                    ] as [keyof CfgAuto, string, string][]).map(([chave, rotulo, dica]) => (
                      <div key={chave} className="space-y-1 rounded-lg border px-3 py-2.5">
                        <span className="text-xs font-medium">{rotulo}</span>
                        <textarea
                          key={`${chave}-${String(cfgAuto[chave]).length}`}
                          rows={2} maxLength={1000}
                          defaultValue={String(cfgAuto[chave] || "")}
                          onBlur={(e) => {
                            if (e.target.value !== cfgAuto[chave]) trocarConfigAuto(chave, e.target.value);
                          }}
                          className="w-full resize-none rounded-lg border bg-white px-2 py-1.5 text-xs outline-none"
                        />
                        <p className="text-[11px] text-muted-foreground">{dica}</p>
                      </div>
                    ))}

                    <div className="space-y-2 rounded-lg border px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <span className="text-xs font-medium">Vigia do canal</span>
                          <p className="text-[11px] text-muted-foreground">
                            Checa a cada minuto se o numero esta conectado e se as mensagens estao chegando; avisa no Telegram quando algo cai (e quando volta).
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <button
                            onClick={() => trocarConfigAuto("vigia_ativo", true)}
                            className={`rounded-l-lg border px-3 py-1 text-[11px] font-medium ${cfgAuto.vigia_ativo ? "border-primary bg-primary text-white" : "hover:bg-muted"}`}
                          >
                            Sim
                          </button>
                          <button
                            onClick={() => trocarConfigAuto("vigia_ativo", false)}
                            className={`-ml-1 rounded-r-lg border px-3 py-1 text-[11px] font-medium ${!cfgAuto.vigia_ativo ? "border-red-500 bg-red-500 text-white" : "hover:bg-muted"}`}
                          >
                            Nao
                          </button>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-muted-foreground">Avisar no Telegram (ID do chat)</span>
                        <input
                          key={`vtg-${cfgAuto.vigia_tg_chat_id}`}
                          defaultValue={cfgAuto.vigia_tg_chat_id}
                          placeholder="padrao da instalacao"
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v !== cfgAuto.vigia_tg_chat_id) trocarConfigAuto("vigia_tg_chat_id", v);
                          }}
                          className="w-40 rounded-lg border bg-white px-2 py-1 text-xs outline-none"
                        />
                        <span className="text-[11px] text-muted-foreground">assinatura</span>
                        <input
                          key={`vas-${cfgAuto.vigia_assinatura}`}
                          defaultValue={cfgAuto.vigia_assinatura}
                          maxLength={120}
                          onBlur={(e) => {
                            if (e.target.value !== cfgAuto.vigia_assinatura) trocarConfigAuto("vigia_assinatura", e.target.value);
                          }}
                          className="w-48 rounded-lg border bg-white px-2 py-1 text-xs outline-none"
                        />
                        <button
                          onClick={async () => {
                            const r = await authedFetch("/api/vigia?teste=1", { method: "POST" });
                            const j = await r.json().catch(() => ({}));
                            setAviso(
                              r.ok && j.destinos_ok > 0
                                ? "Aviso de teste enviado — confere no Telegram."
                                : `Teste falhou (${j.destinos_ok ?? 0}/${j.destinos_total ?? 0} destinos) — confere o ID do chat.`
                            );
                          }}
                          className="rounded-lg border px-3 py-1 text-[11px] font-medium hover:bg-muted"
                        >
                          Enviar aviso de teste
                        </button>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        ID vazio = usa o destino padrao da instalacao. Desligar para os avisos, mas nao apaga nada.
                      </p>
                    </div>

                    {/* WEBHOOKS DE SAIDA — avisa um sistema de fora a cada evento
                        da conversa, sem precisar montar fluxo. Formato do corpo,
                        assinatura e limites: docs/webhooks-saida.md */}
                    <div className="space-y-2 rounded-lg border px-3 py-2.5">
                      <div>
                        <span className="text-xs font-medium">Webhooks de saida</span>
                        <p className="text-[11px] text-muted-foreground">
                          Avisa um sistema de fora (CRM, ERP, automacao) toda vez que um evento acontece numa
                          conversa. Cada destino recebe so os eventos que voce marcar. Muda em ate 30s.
                        </p>
                      </div>

                      {(webhooks ?? []).map((d, i) => {
                        const trocar = (novo: Partial<DestinoWebhook>) =>
                          salvarWebhooks((webhooks ?? []).map((x, j) => (j === i ? { ...x, ...novo } : x)));
                        return (
                          <div key={i} className="space-y-1.5 rounded-lg border px-2.5 py-2">
                            <div className="flex items-center gap-1.5">
                              <input
                                key={`whn-${i}-${d.nome}`}
                                defaultValue={d.nome}
                                placeholder="nome (so pra voce)"
                                maxLength={80}
                                onBlur={(e) => e.target.value !== d.nome && trocar({ nome: e.target.value })}
                                className="w-32 shrink-0 rounded-lg border bg-white px-2 py-1 text-xs outline-none"
                              />
                              <input
                                key={`whu-${i}-${d.url}`}
                                defaultValue={d.url}
                                placeholder="https://sistema.exemplo/hook"
                                onBlur={(e) => e.target.value.trim() !== d.url && trocar({ url: e.target.value.trim() })}
                                className="min-w-0 flex-1 rounded-lg border bg-white px-2 py-1 text-xs outline-none"
                              />
                              <button
                                onClick={() => trocar({ ativo: !d.ativo })}
                                title={d.ativo ? "Recebendo" : "Desligado"}
                                className={`shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium ${
                                  d.ativo ? "border-primary bg-primary text-white" : "text-muted-foreground"}`}
                              >
                                {d.ativo ? "Ativo" : "Off"}
                              </button>
                              <button
                                onClick={() => salvarWebhooks((webhooks ?? []).filter((_, j) => j !== i))}
                                title="Remover destino"
                                className="shrink-0 rounded-lg border px-2 py-1 text-[11px] text-red-500 hover:bg-muted"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>

                            <div className="flex flex-wrap items-center gap-1">
                              {EVENTOS_WEBHOOK.map((ev) => {
                                const tem = d.eventos.includes(ev);
                                return (
                                  <button
                                    key={ev}
                                    onClick={() =>
                                      trocar({ eventos: tem ? d.eventos.filter((x) => x !== ev) : [...d.eventos, ev] })
                                    }
                                    className={`rounded-lg border px-2 py-0.5 text-[11px] font-medium ${
                                      tem ? "border-primary bg-primary text-white" : "hover:bg-muted"}`}
                                  >
                                    {ev.replace(/_/g, " ")}
                                  </button>
                                );
                              })}
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5">
                              <input
                                type="password"
                                key={`whs-${i}`}
                                placeholder={d.segredo_definido ? "segredo guardado (digite pra trocar)" : "segredo (assina o envio)"}
                                onBlur={(e) => {
                                  // campo em branco NAO apaga: o segredo nunca vem
                                  // do servidor, entao "vazio" e o estado normal da tela
                                  if (e.target.value) {
                                    trocar({ segredo: e.target.value });
                                    e.target.value = "";
                                  }
                                }}
                                className="w-56 rounded-lg border bg-white px-2 py-1 text-xs outline-none"
                              />
                              {d.segredo_definido && (
                                <button
                                  onClick={() => trocar({ segredo: "" })}
                                  className="rounded-lg border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
                                >
                                  apagar segredo
                                </button>
                              )}
                              <button
                                onClick={() => trocar({ incluir_conteudo: !d.incluir_conteudo })}
                                className={`rounded-lg border px-2 py-1 text-[11px] font-medium ${
                                  d.incluir_conteudo ? "border-amber-500 bg-amber-500 text-white" : "hover:bg-muted"}`}
                              >
                                {d.incluir_conteudo ? "envia o texto da mensagem" : "sem o texto da mensagem"}
                              </button>
                            </div>
                          </div>
                        );
                      })}

                      <button
                        onClick={() =>
                          salvarWebhooks([
                            ...(webhooks ?? []),
                            { nome: "", url: "", eventos: [], ativo: true, incluir_conteudo: false, segredo: "" },
                          ])
                        }
                        className="rounded-lg border px-3 py-1 text-[11px] font-medium hover:bg-muted"
                      >
                        Adicionar destino
                      </button>
                      <p className="text-[11px] text-muted-foreground">
                        So https. Sem segredo, o destino nao consegue provar que a chamada veio daqui.
                        &quot;Envia o texto da mensagem&quot; tira o conteudo das conversas de dentro desta instalacao —
                        deixe desligado se o outro sistema so precisa saber que algo aconteceu.
                      </p>
                    </div>
                    </>
                  )}
                </div>
              )}
            </div>
            </div>
          </div>
        </div>
      )}

      {usuarioAberto && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setUsuarioAberto(null)}>
          <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center gap-3">
              <AvatarPessoa nome={usuarioAberto.nome} foto={usuarioAberto.foto_url} tamanho="h-11 w-11" texto="text-sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{usuarioAberto.nome}</p>
                <p className="truncate text-[11px] text-muted-foreground">{usuarioAberto.email}</p>
              </div>
              <button onClick={() => setUsuarioAberto(null)} className="rounded-full p-1.5 hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Papel</p>
                <select value={usuarioAberto.papel}
                  onChange={(e) => salvarUsuario(usuarioAberto, { papel: e.target.value })}
                  className="w-full rounded-lg border bg-white px-2 py-1.5 outline-none">
                  <option value="normal">Usuario</option>
                  <option value="super_admin">Super admin</option>
                </select>
              </div>

              {/* Perfil de permissoes (papel nomeado). So aparece quando a
                  migration 0010 rodou; sem ela a tela segue como sempre foi. */}
              {papeisOn && usuarioAberto.papel !== "super_admin" && (
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">
                    Perfil de permissoes
                  </p>
                  <select
                    value={usuarioAberto.papel_id || ""}
                    onChange={(e) =>
                      salvarUsuario(usuarioAberto, { papel_id: e.target.value || null })
                    }
                    className="w-full rounded-lg border bg-white px-2 py-1.5 outline-none"
                  >
                    <option value="">Padrao do sistema</option>
                    {adminPapeis
                      .filter((p) => p.ativo || p.id === usuarioAberto.papel_id)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.nome}
                          {p.ativo ? "" : " (desativado)"}
                        </option>
                      ))}
                  </select>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {(() => {
                      const papel = adminPapeis.find((p) => p.id === usuarioAberto.papel_id);
                      if (!papel) return "Sem perfil: a pessoa atende (envia, conclui, agenda) e nao administra nada.";
                      if (!papel.ativo) return "Perfil DESATIVADO — a pessoa esta sem permissao nenhuma ate voltar a ativar ou trocar de perfil.";
                      return papel.permissoes.length
                        ? "Pode: " + papel.permissoes.join(", ")
                        : "Este perfil nao permite nenhuma acao (somente leitura).";
                    })()}
                  </p>
                  {/* Excecao individual DESTACADA — o card pede que o ajuste
                      caixa-a-caixa apareca, pra nunca virar o jeito normal de
                      configurar. Editar excecao e por API (/api/admin/usuarios). */}
                  {usuarioAberto.permissoes_excecao &&
                    Object.keys(usuarioAberto.permissoes_excecao).length > 0 && (
                      <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
                        <span className="font-semibold">Ajuste individual nesta pessoa:</span>{" "}
                        {Object.entries(usuarioAberto.permissoes_excecao)
                          .map(([k, v]) => (v ? "+" : "-") + k)
                          .join(", ")}
                      </div>
                    )}
                </div>
              )}

              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Ve quais conversas</p>
                <select value={usuarioAberto.escopo_visao}
                  onChange={(e) => salvarUsuario(usuarioAberto, { escopo_visao: e.target.value })}
                  className="w-full rounded-lg border bg-white px-2 py-1.5 outline-none">
                  <option value="todas">Todas</option>
                  <option value="departamento">Do departamento</option>
                  <option value="proprias">Somente as proprias</option>
                </select>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Conversa sem responsavel aparece pra todo mundo. Regra de departamento vale por cima da individual.
                </p>
              </div>

              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Departamentos</p>
                <p className="text-muted-foreground">
                  {usuarioAberto.departamentos?.length ? usuarioAberto.departamentos.join(", ") : "Nenhum"}
                  <span className="text-[11px]"> — se gerencia na aba Departamentos</span>
                </p>
              </div>

              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">BUs visiveis</p>
                <p className="mb-1.5 text-[11px] text-muted-foreground">
                  Nenhuma marcada = sem restricao (segue a regra "Ve quais conversas" acima). Marcada
                  = so enxerga a uniao das BUs escolhidas — travado no servidor, vale em toda tela.
                </p>
                {visoes.length ? (
                  <div className="space-y-1 rounded-lg border p-2">
                    {visoes.map((v) => {
                      const marcado = (usuarioAberto.contextos || []).includes(v.id);
                      return (
                        <label key={v.id} className="flex cursor-pointer items-center gap-2 text-[11px]">
                          <input
                            type="checkbox"
                            checked={marcado}
                            onChange={(e) => {
                              const atual = usuarioAberto.contextos || [];
                              const novos = e.target.checked
                                ? [...atual, v.id]
                                : atual.filter((id) => id !== v.id);
                              salvarUsuario(usuarioAberto, { contextos: novos });
                            }}
                          />
                          {v.nome}
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">Nenhuma BU cadastrada (widget embutido).</p>
                )}
                {usuarioAberto.papel === "super_admin" && (usuarioAberto.contextos || []).length > 0 && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Super admin nunca e restringido — o vinculo fica salvo mas sem efeito.
                  </p>
                )}
              </div>

              <div className="rounded-lg border px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">Assinatura nas mensagens</p>
                    <p className="text-[11px] text-muted-foreground">
                      O nome sai em negrito na frente de toda mensagem enviada, como no ChatGuru.
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button onClick={() => salvarUsuario(usuarioAberto, { assinatura_ativa: true })}
                      className={`rounded-l-lg border px-3 py-1 text-[11px] font-medium ${usuarioAberto.assinatura_ativa ? "border-primary bg-primary text-white" : "hover:bg-muted"}`}>
                      Sim
                    </button>
                    <button onClick={() => salvarUsuario(usuarioAberto, { assinatura_ativa: false })}
                      className={`-ml-1 rounded-r-lg border px-3 py-1 text-[11px] font-medium ${!usuarioAberto.assinatura_ativa ? "border-red-500 bg-red-500 text-white" : "hover:bg-muted"}`}>
                      Nao
                    </button>
                  </div>
                </div>
                {usuarioAberto.assinatura_ativa && (
                  <div className="mt-2">
                    <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Nome que aparece</p>
                    <input key={usuarioAberto.id} defaultValue={usuarioAberto.assinatura_nome || usuarioAberto.nome}
                      maxLength={60}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v !== (usuarioAberto.assinatura_nome || "")) salvarUsuario(usuarioAberto, { assinatura_nome: v });
                      }}
                      className="w-full rounded-lg border bg-white px-2 py-1.5 outline-none"
                      placeholder={usuarioAberto.nome} />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Previa: <strong>{(usuarioAberto.assinatura_nome || usuarioAberto.nome) + ":"}</strong> mensagem...
                    </p>
                  </div>
                )}
              </div>

              <div className="rounded-lg border px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">Modo supervisor</p>
                    <p className="text-[11px] text-muted-foreground">
                      Abrir uma conversa nao marca ela como lida — quem acompanha o atendimento nao
                      consome a fila do time.
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button onClick={() => salvarUsuario(usuarioAberto, { supervisor: true })}
                      className={`rounded-l-lg border px-3 py-1 text-[11px] font-medium ${usuarioAberto.supervisor ? "border-primary bg-primary text-white" : "hover:bg-muted"}`}>
                      Sim
                    </button>
                    <button onClick={() => salvarUsuario(usuarioAberto, { supervisor: false })}
                      className={`-ml-1 rounded-r-lg border px-3 py-1 text-[11px] font-medium ${!usuarioAberto.supervisor ? "border-red-500 bg-red-500 text-white" : "hover:bg-muted"}`}>
                      Nao
                    </button>
                  </div>
                </div>
                {usuarioAberto.supervisor && (
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <p className="text-[11px] text-muted-foreground">
                      Responder a conversa zera o contador de nao lidas.
                    </p>
                    <div className="flex shrink-0 gap-1">
                      <button onClick={() => salvarUsuario(usuarioAberto, { supervisor_responder_zera: true })}
                        className={`rounded-l-lg border px-3 py-1 text-[11px] font-medium ${usuarioAberto.supervisor_responder_zera !== false ? "border-primary bg-primary text-white" : "hover:bg-muted"}`}>
                        Sim
                      </button>
                      <button onClick={() => salvarUsuario(usuarioAberto, { supervisor_responder_zera: false })}
                        className={`-ml-1 rounded-r-lg border px-3 py-1 text-[11px] font-medium ${usuarioAberto.supervisor_responder_zera === false ? "border-red-500 bg-red-500 text-white" : "hover:bg-muted"}`}>
                        Nao
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* FRENTE Q — atalho: abre a visao de acesso ja nesta pessoa. */}
              <button
                onClick={() => { setAcessoDe(usuarioAberto.id); setUsuarioAberto(null); setConfigAberta(false); setVisaoPainel("acesso"); }}
                className="flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left hover:bg-muted">
                <div>
                  <p className="font-medium">Acesso e seguranca</p>
                  <p className="text-[11px] text-muted-foreground">
                    Janela de horario, dispositivos e recorte por numero/funil desta pessoa.
                  </p>
                </div>
                <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>

              {usuarioAberto.id !== session?.user?.id && (
                <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                  <div>
                    <p className="font-medium">Acesso ao painel</p>
                    <p className="text-[11px] text-muted-foreground">
                      Desativar corta o acesso na hora; da pra reativar depois.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      if (usuarioAberto.ativo === false) return salvarUsuario(usuarioAberto, { ativo: true });
                      if (confirm(`Desativar ${usuarioAberto.nome}? A pessoa perde o acesso ao painel na hora.`))
                        salvarUsuario(usuarioAberto, { ativo: false });
                    }}
                    className={`shrink-0 rounded-lg px-3 py-1.5 text-[11px] font-medium ${
                      usuarioAberto.ativo === false
                        ? "bg-green-100 text-green-700 hover:opacity-80"
                        : "bg-red-100 text-red-700 hover:opacity-80"
                    }`}>
                    {usuarioAberto.ativo === false ? "Reativar" : "Desativar"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* FRENTE O — INICIAR CONVERSA NOVA.
          O painel tem uma trava explicita contra disparo frio (/api/send recusa
          conversa que nao existe). Este modal e a excecao a ela, e por isso ele
          e desenhado como CONSENTIMENTO: um numero por vez, primeira mensagem
          obrigatoria e a caixa de "eu tenho autorizacao" — que e de onde sai o
          `confirmado: true` que a rota exige. Sem a caixa marcada o botao nao
          habilita, e mesmo se habilitasse a rota recusaria. */}
      {novaConversaAberta && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => { setNovaConversaAberta(false); limparNovaConversa(); }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-xl bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <MessageSquarePlus className="h-4 w-4" /> Iniciar conversa
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Sai por {rotuloDoCanal(canais, canalDoInicio())}
                </p>
              </div>
              <button onClick={() => { setNovaConversaAberta(false); limparNovaConversa(); }}
                className="rounded p-1 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {/* seletor de NUMERO DE SAIDA — so aparece quando ha mais de um
                  candidato. Fora da lista: canal de fonte externa (nao envia) e
                  canal oficial da Meta, que exige template aprovado fora da
                  janela de 24h e por definicao NAO inicia conversa. Melhor
                  esconder a opcao que oferecer um caminho que sempre da 403. */}
              {(() => {
                const candidatos = canaisParaIniciar();
                if (candidatos.length < 2) return null;
                return (
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground">Enviar pelo numero</label>
                    <select
                      value={canalDoInicio()}
                      onChange={(e) => setNovoCanal(e.target.value)}
                      className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none focus:border-primary"
                    >
                      {candidatos.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.rotulo}
                          {c.identidade ? ` — ${c.identidade}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })()}
              <div>
                <label className="text-[11px] font-medium text-muted-foreground">Numero com DDI e DDD</label>
                <input
                  autoFocus
                  value={novoNumero}
                  onChange={(e) => setNovoNumero(e.target.value)}
                  placeholder="55 11 90000-0000"
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Aceita com mascara. Grupo nao entra por aqui.
                </p>
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground">Nome (opcional)</label>
                <input
                  value={novoNome}
                  onChange={(e) => setNovoNome(e.target.value)}
                  placeholder="como a pessoa aparece na lista"
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground">Primeira mensagem</label>
                <textarea
                  value={novoTexto}
                  onChange={(e) => setNovoTexto(e.target.value)}
                  rows={4}
                  placeholder="Escreva a mensagem que abre a conversa."
                  className="mt-1 w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </div>

              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5">
                <input
                  type="checkbox"
                  checked={novoConfirmado}
                  onChange={(e) => setNovoConfirmado(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0"
                />
                <span className="text-[11px] text-amber-900">
                  Confirmo que tenho autorizacao pra falar com esse numero. Isso e um contato individual,
                  nao campanha — pra falar com muita gente use o disparo, que tem descadastro e ritmo.
                </span>
              </label>

              <p className="text-[11px] text-muted-foreground">
                Limite de {TETO_INICIOS_POR_HORA} conversas novas por hora, por pessoa. Numero que pediu
                descadastro e recusado.
              </p>

              {erroNova && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700">
                  {erroNova}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
              <button
                onClick={() => { setNovaConversaAberta(false); limparNovaConversa(); }}
                className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </button>
              <button
                onClick={iniciarConversa}
                disabled={iniciando || !novoConfirmado || !novoNumero.trim() || !novoTexto.trim()}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                {iniciando ? "Enviando..." : "Enviar e abrir conversa"}
              </button>
            </div>
          </div>
        </div>
      )}

      {encaminhando && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => { setEncaminhando(null); setDestinosFwd([]); }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <p className="text-sm font-semibold">Encaminhar mensagem</p>
                <p className="max-w-[300px] truncate text-xs text-muted-foreground">{msgText(encaminhando)}</p>
              </div>
              <button onClick={() => { setEncaminhando(null); setDestinosFwd([]); }}
                className="rounded p-1 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="border-b px-4 py-2">
              <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5">
                <Search className="h-4 w-4 text-muted-foreground" />
                <input
                  autoFocus
                  value={buscaFwd}
                  onChange={(e) => setBuscaFwd(e.target.value)}
                  placeholder="Buscar conversa ou grupo"
                  className="w-full bg-transparent text-sm outline-none"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {chats
                // encaminhar e dentro do MESMO canal da mensagem (a rota envia pelo numero do canal)
                .filter((c) => c.canal === active?.canal)
                .filter((c) => {
                  const q = buscaFwd.trim().toLowerCase();
                  if (!q) return true;
                  return conversaBateBusca(c, q);
                })
                .slice(0, 80)
                .map((c) => {
                  const marcado = destinosFwd.includes(c.chat_id);
                  // teto vem de lib/tela-conversa.ts, a MESMA constante que a
                  // rota usa: estava escrito 5 aqui, 5 no rodape e 5 na rota
                  const cheio = !marcado && destinosFwd.length >= MAX_DESTINOS_FORWARD;
                  return (
                    <button
                      key={c.uid}
                      disabled={cheio}
                      onClick={() =>
                        setDestinosFwd((d) =>
                          marcado ? d.filter((x) => x !== c.chat_id) : [...d, c.chat_id]
                        )
                      }
                      className={`flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-muted ${cheio ? "opacity-40" : ""}`}
                    >
                      <span className={`flex h-4 w-4 items-center justify-center rounded border ${marcado ? "border-primary bg-primary text-white" : "border-muted-foreground/40"}`}>
                        {marcado && <Check className="h-3 w-3" />}
                      </span>
                      {fotoOk(c.profile_thumbnail) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.profile_thumbnail!} alt="" onError={() => marcarFotoQuebrada(c.profile_thumbnail!)}
                          className="h-8 w-8 rounded-full object-cover" />
                      ) : (
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                          {c.is_group ? <Users className="h-4 w-4" /> : initials(c.chat_name || "?")}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm">{c.chat_name || c.chat_id}</span>
                    </button>
                  );
                })}
            </div>
            <div className="flex items-center justify-between border-t px-4 py-3">
              <span className="text-xs text-muted-foreground">
                {destinosFwd.length}/{MAX_DESTINOS_FORWARD} selecionada(s)
              </span>
              <button
                onClick={encaminhar}
                disabled={!destinosFwd.length || enviandoFwd}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                <Forward className="h-4 w-4" />
                {enviandoFwd ? "Encaminhando..." : `Encaminhar${destinosFwd.length ? ` (${destinosFwd.length})` : ""}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
