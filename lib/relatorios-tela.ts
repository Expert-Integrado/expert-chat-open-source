// Telas de relatorio — a REGRA DE EXIBICAO, pura (Frente M, 31/08/2026).
//
// Este arquivo importa SO o miolo puro da Frente J (`./relatorios.ts`, que nao
// importa nada) — de proposito. O efeito e que ele roda no Next E em node solto,
// que e a prova: `node scripts/prova-telas-relatorios.ts`. Nada de React, nada
// de fetch, nada de banco aqui.
//
// Divisao de trabalho da frente:
//   banco AGREGA  ->  rota SERVE (lib/relatorios.ts pivota/corta)  ->  ESTE
//   arquivo transforma em barra/linha/celula  ->  app/relatorios-*.tsx desenha.
//
// Por que a montagem do grafico e pura: um grafico errado nao levanta excecao,
// ele so mente na tela. Escala, empilhamento, escala do acumulado e "periodo sem
// dado" sao exatamente o tipo de conta que precisa de prova, e provar isso com
// navegador seria caro e frouxo.
//
// LEITURA DEFENSIVA e requisito, nao zelo: a rota responde `series: null` com
// aviso quando a migration 0013 nao rodou, e responde serie vazia quando o
// periodo nao tem dado. O criterio do card e "grafico vazio com aviso, NUNCA
// erro" — entao nenhuma funcao daqui pode lancar por causa de payload torto.

import { diaDaSemanaDaData, filtrarDias, type LinhaMatriz, type Matriz } from "./relatorios.ts";
import { MAX_ALERTAS } from "./alertas-sla.ts";

// ---------------------------------------------------------------------------
// 1. Payload da rota /api/relatorios/serie
// ---------------------------------------------------------------------------
export type PontoN = { dia: string; dow?: number; n: number };
export type PontoMsgs = { dia: string; dow?: number; recebidas: number; enviadas: number };
export type PontoTempo = { dia: string; dow?: number; n: number; media_s: number; media_bruta_s: number };
export type PorUsuario = { nome: string; enviadas: number };

export type SeriesTela = {
  novos_chats: PontoN[];
  novos_atendimentos: PontoN[];
  mensagens: PontoMsgs[];
  por_usuario: PorUsuario[];
  acumulado: PontoN[];
  tempo_atendimento: PontoTempo[];
};

export const SERIES_VAZIAS: SeriesTela = {
  novos_chats: [],
  novos_atendimentos: [],
  mensagens: [],
  por_usuario: [],
  acumulado: [],
  tempo_atendimento: [],
};

const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function lista(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

// Ponto sem `dia` valido e DESCARTADO: sem a data nao ha barra, e desenhar uma
// coluna sem rotulo e pior que nao desenhar.
function pontosN(v: unknown): PontoN[] {
  return lista(v)
    .filter((p) => p && typeof p.dia === "string" && DIA_RE.test(p.dia))
    .map((p) => ({ dia: p.dia as string, dow: typeof p.dow === "number" ? p.dow : undefined, n: num(p.n) }));
}

/** Le o `series` da rota sem NUNCA lancar. Campo ausente/torto = lista vazia. */
export function lerSeries(bruto: unknown): SeriesTela {
  const b = (bruto && typeof bruto === "object" ? bruto : {}) as Record<string, unknown>;
  return {
    novos_chats: pontosN(b.novos_chats),
    novos_atendimentos: pontosN(b.novos_atendimentos),
    mensagens: lista(b.mensagens)
      .filter((p) => p && typeof p.dia === "string" && DIA_RE.test(p.dia))
      .map((p) => ({
        dia: p.dia as string,
        dow: typeof p.dow === "number" ? p.dow : undefined,
        recebidas: num(p.recebidas),
        enviadas: num(p.enviadas),
      })),
    por_usuario: lista(b.por_usuario)
      .filter((u) => u && (typeof u.nome === "string" || u.nome === null))
      .map((u) => ({ nome: String(u.nome ?? "(sem registro)"), enviadas: num(u.enviadas) }))
      .sort((a, b2) => b2.enviadas - a.enviadas || a.nome.localeCompare(b2.nome)),
    acumulado: pontosN(b.acumulado),
    tempo_atendimento: lista(b.tempo_atendimento)
      .filter((p) => p && typeof p.dia === "string" && DIA_RE.test(p.dia))
      .map((p) => ({
        dia: p.dia as string,
        dow: typeof p.dow === "number" ? p.dow : undefined,
        n: num(p.n),
        media_s: num(p.media_s),
        media_bruta_s: num(p.media_bruta_s),
      })),
  };
}

// ---------------------------------------------------------------------------
// 2. Corte dos dias ignorados (defesa em profundidade)
// ---------------------------------------------------------------------------
// A ROTA ja aplica `filtrarDias` — este corte na tela e a 2a barreira, e existe
// por um motivo concreto: o `acumulado` da rota tem que ser acumulado ANTES do
// corte (senao a curva contradiz o contador de chats), e um payload guardado em
// cache/estado do cliente com filtro diferente do que a tela mostra AGORA
// desenharia sabado numa tela marcada "sem sabado". Aplicar de novo e idempotente.
export function cortarSeries(s: SeriesTela, pular: number[]): SeriesTela {
  if (!pular?.length) return s;
  return {
    novos_chats: filtrarDias(s.novos_chats, pular),
    novos_atendimentos: filtrarDias(s.novos_atendimentos, pular),
    mensagens: filtrarDias(s.mensagens, pular),
    // por_usuario nao tem dimensao de DIA (e agregado do periodo inteiro):
    // cortar aqui seria inventar um recorte que o banco nao fez.
    por_usuario: s.por_usuario,
    acumulado: filtrarDias(s.acumulado, pular),
    tempo_atendimento: filtrarDias(s.tempo_atendimento, pular),
  };
}

/** Dias da semana a pular, a partir das DUAS caixas independentes da tela. */
export function diasAPular(ignorarSabado: boolean, ignorarDomingo: boolean): number[] {
  const out: number[] = [];
  if (ignorarDomingo) out.push(0);
  if (ignorarSabado) out.push(6);
  return out;
}

// ---------------------------------------------------------------------------
// 3. Filtro da tela -> query da rota
// ---------------------------------------------------------------------------
export const DIAS_PRESET = [7, 14, 30, 60, 90, 180, 365] as const;

export type FiltroGraficos = {
  canal: string;
  dias: number;
  ignorarSabado: boolean;
  ignorarDomingo: boolean;
};

export const FILTRO_PADRAO: FiltroGraficos = {
  canal: "central",
  dias: 30,
  ignorarSabado: false,
  ignorarDomingo: false,
};

// As duas caixas viajam SEPARADAS (`ignorar_sabado` / `ignorar_domingo`), nunca
// pelo atalho `ignorar_fds`: o atalho existe pra quem chama a API na mao, e usar
// ele aqui apagaria a diferenca entre "so sabado" e "os dois" na URL.
export function paramsGraficos(f: FiltroGraficos, formato?: "csv"): string {
  const p: string[] = [];
  const canal = /^[a-z][a-z0-9_]{1,30}$/.test(f.canal) ? f.canal : "central";
  p.push(`canal=${encodeURIComponent(canal)}`);
  const dias = Math.max(1, Math.min(365, Math.round(num(f.dias) || 30)));
  p.push(`dias=${dias}`);
  if (f.ignorarSabado) p.push("ignorar_sabado=1");
  if (f.ignorarDomingo) p.push("ignorar_domingo=1");
  if (formato) p.push(`formato=${formato}`);
  return p.join("&");
}

// ---------------------------------------------------------------------------
// 4. Barras (colunas verticais empilhadas)
// ---------------------------------------------------------------------------
export type ParteBarra = { chave: string; valor: number; fracao: number };
export type Barra = { dia: string; rotulo: string; total: number; altura: number; partes: ParteBarra[] };
export type Grafico = { barras: Barra[]; maximo: number; total: number; vazio: boolean };

export type CampoBarra<T> = { chave: string; valor: (p: T) => number };

// `altura` = % do MAIOR dia do periodo (a escala do grafico).
// `parte.fracao` = % DA PROPRIA barra (o empilhamento dentro da coluna).
// Duas unidades diferentes de proposito: misturar as duas foi o jeito classico
// de desenhar empilhado errado.
export function montarBarras<T extends { dia: string }>(pontos: T[], campos: CampoBarra<T>[]): Grafico {
  const barras: Barra[] = [];
  let maximo = 0;
  let total = 0;
  for (const p of pontos ?? []) {
    const partes = campos.map((c) => ({ chave: c.chave, valor: Math.max(0, num(c.valor(p))), fracao: 0 }));
    const soma = partes.reduce((a, x) => a + x.valor, 0);
    for (const parte of partes) parte.fracao = soma > 0 ? (parte.valor / soma) * 100 : 0;
    barras.push({ dia: p.dia, rotulo: rotuloDia(p.dia), total: soma, altura: 0, partes });
    if (soma > maximo) maximo = soma;
    total += soma;
  }
  // escala minima 1: dividir por zero num periodo todo zerado daria NaN% de
  // altura e o navegador desenharia a coluna inteira (grafico "cheio de nada")
  const escala = maximo || 1;
  for (const b of barras) b.altura = (b.total / escala) * 100;
  return { barras, maximo, total, vazio: !barras.length || total === 0 };
}

// ---------------------------------------------------------------------------
// 5. Linha (total acumulado)
// ---------------------------------------------------------------------------
export type Ponto2D = { dia: string; rotulo: string; valor: number; x: number; y: number };
export type GraficoLinha = {
  pontos: Ponto2D[];
  caminho: string; // path da linha (`d` do <path>)
  area: string; // mesmo caminho fechado embaixo, pro preenchimento
  piso: number;
  teto: number;
  vazio: boolean;
};

// O acumulado NAO comeca no zero (ele parte do que existia antes do periodo),
// entao a escala vai de piso a teto e nao de 0 a max — comecar em zero achataria
// a curva a ponto de esconder o crescimento do mes inteiro.
export function montarLinha(
  pontos: { dia: string; n: number }[],
  largura: number,
  altura: number
): GraficoLinha {
  const lst = (pontos ?? []).filter((p) => p && DIA_RE.test(String(p.dia)));
  if (!lst.length) {
    return { pontos: [], caminho: "", area: "", piso: 0, teto: 0, vazio: true };
  }
  const valores = lst.map((p) => num(p.n));
  let piso = Math.min(...valores);
  let teto = Math.max(...valores);
  if (teto === piso) {
    // serie plana: sem faixa nao ha onde desenhar. Abre 1 unidade pra cada lado
    // e a linha sai no MEIO do grafico, que e a leitura honesta de "nao mudou".
    piso -= 1;
    teto += 1;
  }
  const faixa = teto - piso;
  const passo = lst.length > 1 ? largura / (lst.length - 1) : 0;
  const p2d: Ponto2D[] = lst.map((p, i) => {
    const valor = num(p.n);
    return {
      dia: p.dia,
      rotulo: rotuloDia(p.dia),
      valor,
      x: lst.length > 1 ? i * passo : largura / 2,
      // y invertido: 0 e o TOPO no sistema de coordenadas do SVG
      y: altura - ((valor - piso) / faixa) * altura,
    };
  });
  const caminho = p2d.map((p, i) => `${i ? "L" : "M"}${arred(p.x)} ${arred(p.y)}`).join(" ");
  const area = `${caminho} L${arred(p2d[p2d.length - 1].x)} ${altura} L${arred(p2d[0].x)} ${altura} Z`;
  return { pontos: p2d, caminho, area, piso, teto, vazio: false };
}

function arred(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// 6. Ranking (mensagens por atendente)
// ---------------------------------------------------------------------------
export type LinhaRanking = { nome: string; valor: number; fracao: number };

export function montarRanking(itens: { nome: string; enviadas: number }[], teto = 20): {
  linhas: LinhaRanking[];
  restante: number;
  vazio: boolean;
} {
  const ordenado = (itens ?? [])
    .map((i) => ({ nome: String(i?.nome ?? "(sem registro)"), valor: Math.max(0, num(i?.enviadas)) }))
    .sort((a, b) => b.valor - a.valor || a.nome.localeCompare(b.nome));
  const maior = ordenado.reduce((m, i) => Math.max(m, i.valor), 0) || 1;
  const visiveis = ordenado.slice(0, Math.max(1, teto));
  return {
    linhas: visiveis.map((i) => ({ ...i, fracao: (i.valor / maior) * 100 })),
    restante: Math.max(0, ordenado.length - visiveis.length),
    vazio: !ordenado.length || ordenado.every((i) => i.valor === 0),
  };
}

// ---------------------------------------------------------------------------
// 7. Rotulos
// ---------------------------------------------------------------------------
const DOW_CURTO = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];

/** "2026-08-29" -> "29/08". A data ja vem no fuso da instalacao (nao converter). */
export function rotuloDia(dia: string): string {
  return DIA_RE.test(dia) ? `${dia.slice(8, 10)}/${dia.slice(5, 7)}` : String(dia ?? "");
}

/** "2026-08-29" -> "sab, 29/08/2026" (tooltip da barra). */
export function rotuloDiaLongo(dia: string): string {
  if (!DIA_RE.test(dia)) return String(dia ?? "");
  const dow = diaDaSemanaDaData(dia);
  const nome = dow >= 0 && dow <= 6 ? `${DOW_CURTO[dow]}, ` : "";
  return `${nome}${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}`;
}

/** Duracao legivel a partir de segundos. `null` vira "-", nunca "0s". */
export function duracaoLegivel(seg: number | null | undefined): string {
  if (seg === null || seg === undefined || !Number.isFinite(Number(seg))) return "-";
  const s = Math.max(0, Math.round(Number(seg)));
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h}h ${min % 60}min` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

// Frase do periodo, com o FUSO no rotulo (criterio do card): sem ele, "29/08"
// e ambiguo pra quem opera em outro fuso que o da instalacao.
export function rotuloPeriodo(dias: number, fuso: string, pular: number[]): string {
  const partes = [`ultimos ${Math.max(1, Math.round(num(dias) || 1))} dias`];
  if (fuso) partes.push(`fuso ${fuso}`);
  const set = new Set(pular ?? []);
  if (set.size === 2) partes.push("sem sabado e domingo");
  else if (set.has(6)) partes.push("sem sabado");
  else if (set.has(0)) partes.push("sem domingo");
  return partes.join(" — ");
}

// ---------------------------------------------------------------------------
// 8. Painel operacional: matriz e o clique que navega
// ---------------------------------------------------------------------------
export type BlocoOperacional = { canal: string; rotulo: string; matriz: Matriz | null; aviso?: string; erro?: string };

/** Le `canais` da rota /api/relatorios/operacional sem lancar. */
export function lerOperacional(bruto: unknown): BlocoOperacional[] {
  return lista((bruto as any)?.canais).map((b) => ({
    canal: String(b?.canal ?? ""),
    rotulo: String(b?.rotulo ?? b?.canal ?? ""),
    // a rota manda a matriz JA pivotada; passar de novo por montarMatriz seria
    // refazer a conta na tela e abrir espaco pra duas verdades
    matriz: b?.matriz && typeof b.matriz === "object" ? (b.matriz as Matriz) : null,
    aviso: typeof b?.aviso === "string" ? b.aviso : undefined,
    erro: typeof b?.erro === "string" ? b.erro : undefined,
  }));
}

/** Ordem de desenho: "sem responsavel" PRIMEIRO, depois a matriz. */
export function linhasParaDesenho(m: Matriz | null): LinhaMatriz[] {
  if (!m) return [];
  // a linha de sem-dono entra mesmo zerada: "0 sem responsavel" e informacao
  // (o gestor procura essa linha), diferente de linha ausente
  return [m.sem_dono, ...m.linhas];
}

// O que o clique num numero da matriz manda pra lista de conversas.
// `resp: "none"` e o valor que o filtro de responsavel do painel usa pra "sem
// responsavel"; `null` = nao filtrar por responsavel (celula de TOTAL).
//
// `arquivadas` VIAJA JUNTO (achado da revisao cega, 31/08/2026): a matriz e
// contada com ou sem arquivadas conforme a caixa da tela, e a lista tem o botao
// Arquivados dela. Sem propagar, clicar num numero contado COM arquivadas abria
// a lista SEM elas — o gestor ve 12 no relatorio, 4 na lista, e passa a nao
// confiar em nenhum dos dois. Numero clicado e lista tem que contar a mesma coisa.
export type AlvoConversas = {
  canal: string;
  status: string | null;
  resp: string | null;
  arquivadas: boolean;
};

export function alvoDaCelula(
  canal: string,
  linha: LinhaMatriz | null,
  status: string | null,
  arquivadas = false
): AlvoConversas {
  const resp = !linha ? null : linha.tipo === "sem_dono" ? "none" : linha.ref_id || null;
  return { canal, status: status || null, resp, arquivadas };
}

/** Celula com zero nao navega: filtrar pra uma lista vazia parece tela quebrada. */
export function celulaNavegavel(valor: number): boolean {
  return num(valor) > 0;
}

// Por que o alvo serve pros DOIS tipos de dono: o filtro de responsavel da lista
// casa por id contra `conversa_responsaveis`, e ali moram tanto user_id quanto
// id de departamento — o mesmo campo. Nao ha conversao a fazer.

// ---------------------------------------------------------------------------
// 9. Formulario dos alertas de SLA
// ---------------------------------------------------------------------------
// O SHAPE gravado e o de `normalizarAlertas` (lib/alertas-sla.ts) — a validacao
// aqui existe pra a tela nunca mandar item que aquela funcao DESCARTA em
// silencio. Se mandasse, a tela diria "salvei" e o alerta simplesmente nao
// existiria. Prova: `normalizarAlertas([rascunhoParaAlerta(r)])` devolve
// exatamente 1 item, com os campos que a tela mostrou.

export const STATUS_ALERTA = ["aberto", "atendimento", "aguardando", "concluido"] as const;
export const SEM_DONO_ALERTA = "__sem_dono__";

export const IDADES_ALERTA = [
  { min: 60, rotulo: "1 hora" },
  { min: 240, rotulo: "4 horas" },
  { min: 1440, rotulo: "1 dia" },
  { min: 2880, rotulo: "2 dias" },
  { min: 4320, rotulo: "3 dias" },
  { min: 10080, rotulo: "7 dias" },
  { min: 43200, rotulo: "30 dias" },
] as const;

export type RascunhoAlerta = {
  nome: string;
  status: string[];
  departamento: string; // "" | uuid | "__sem_dono__"
  idade_min: number; // minutos sem interacao
  horarios: string[]; // ["08:00", "14:00"]
  canal: string; // "" = todos os canais ativos
  limite: number;
  ativo: boolean;
  destinoTipo: "" | "telegram" | "webhook"; // "" = destino padrao da instalacao
  destinoChatId: string;
  destinoAssinatura: string;
  destinoUrl: string;
  // headers/body de um destino webhook configurado FORA da tela: preservados
  // as-is. Reenviar o alerta sem eles apagaria a autenticacao do destino de
  // alguem em silencio — a tela nao edita o que nao entende, mas nao destroi.
  destinoExtra: Record<string, unknown>;
};

export const RASCUNHO_VAZIO: RascunhoAlerta = {
  nome: "",
  status: [],
  departamento: "",
  idade_min: 1440,
  horarios: ["08:00"],
  canal: "",
  limite: 50,
  ativo: false,
  destinoTipo: "",
  destinoChatId: "",
  destinoAssinatura: "",
  destinoUrl: "",
  destinoExtra: {},
};

const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CANAL_RE = /^[a-z][a-z0-9_]{1,30}$/;
const CHAT_ID_RE = /^-?\d{1,20}$/;
const URL_RE = /^https:\/\/\S+$/;

export function alertaParaRascunho(bruto: unknown): RascunhoAlerta {
  const a = (bruto && typeof bruto === "object" ? bruto : {}) as Record<string, any>;
  const d = a.destino && typeof a.destino === "object" ? a.destino : null;
  const extra: Record<string, unknown> = {};
  if (d && d.tipo === "webhook") {
    if (d.headers && typeof d.headers === "object") extra.headers = d.headers;
    if (d.body !== undefined) extra.body = d.body;
  }
  return {
    nome: typeof a.nome === "string" ? a.nome : "",
    status: lista(a.filtro?.status).filter((s) => typeof s === "string"),
    departamento: typeof a.filtro?.departamento === "string" ? a.filtro.departamento : "",
    idade_min: num(a.filtro?.idade_min),
    horarios: lista(a.horarios).filter((h) => typeof h === "string"),
    canal: typeof a.canal === "string" && a.canal ? a.canal : "",
    limite: num(a.limite) || 50,
    ativo: a.ativo === true,
    destinoTipo: d?.tipo === "telegram" || d?.tipo === "webhook" ? d.tipo : "",
    destinoChatId: typeof d?.chat_id === "string" ? d.chat_id : "",
    destinoAssinatura: typeof d?.assinatura === "string" ? d.assinatura : "",
    destinoUrl: typeof d?.url === "string" ? d.url : "",
    destinoExtra: extra,
  };
}

/**
 * O que impede este rascunho de virar alerta gravado. Lista VAZIA = pode salvar.
 * Cada item aqui casa com uma regra de `normalizarAlertas` que descartaria o
 * alerta sem dizer nada.
 */
export function problemasDoRascunho(r: RascunhoAlerta, outrosNomes: string[] = []): string[] {
  const p: string[] = [];

  // TETO DE 50 (MAX_ALERTAS em lib/alertas-sla.ts). `normalizarAlertas` para de
  // ler no 51o item e o resto DESAPARECE em silencio. Sem esta checagem a tela
  // caia no aviso generico "revise nome, horario e destino" pra um alerta em que
  // nada disso estava errado — mandando o operador procurar no lugar errado.
  // `outrosNomes` ja e a contagem dos OUTROS alertas: ao editar um existente ele
  // vem com 49 e a edicao passa, como tem que ser.
  if ((outrosNomes ?? []).length >= MAX_ALERTAS) {
    p.push(`Maximo de ${MAX_ALERTAS} alertas nesta instalacao — apague um antes de criar outro.`);
  }

  const nome = (r?.nome ?? "").trim();
  if (!nome) p.push("De um nome ao alerta — e por ele que o painel evita repetir o mesmo aviso no dia.");
  else if (nome.length > 120) p.push("O nome tem no maximo 120 caracteres.");
  else if ((outrosNomes ?? []).some((n) => n.trim() === nome)) {
    p.push("Ja existe um alerta com esse nome (o nome e a chave que evita aviso repetido).");
  }

  const horarios = (r?.horarios ?? []).map((h) => (h ?? "").trim()).filter(Boolean);
  if (!horarios.length) p.push("Escolha pelo menos um horario — alerta sem horario nunca dispara.");
  else if (horarios.some((h) => !HORA_RE.test(h))) p.push("Horario invalido: use HH:MM em 24 horas (ex: 08:00, 14:30).");

  if (r?.canal && !CANAL_RE.test(r.canal)) p.push("Canal invalido.");

  if (r?.destinoTipo === "telegram" && !CHAT_ID_RE.test((r.destinoChatId ?? "").trim())) {
    p.push("Informe o chat_id do Telegram (so numeros, com sinal opcional).");
  }
  if (r?.destinoTipo === "webhook" && !URL_RE.test((r.destinoUrl ?? "").trim())) {
    p.push("A URL do webhook precisa comecar com https:// (o alerta carrega dado de cliente).");
  }
  return p;
}

/** Rascunho -> item da config `alertas_sla`, no shape que normalizarAlertas le. */
export function rascunhoParaAlerta(r: RascunhoAlerta): Record<string, unknown> {
  const status = Array.from(new Set((r?.status ?? []).filter((s) => typeof s === "string" && s)));
  let destino: Record<string, unknown> | null = null;
  if (r?.destinoTipo === "telegram") {
    destino = {
      tipo: "telegram",
      chat_id: (r.destinoChatId ?? "").trim(),
      ...((r.destinoAssinatura ?? "").trim() ? { assinatura: r.destinoAssinatura.trim() } : {}),
    };
  } else if (r?.destinoTipo === "webhook") {
    destino = { tipo: "webhook", url: (r.destinoUrl ?? "").trim(), ...(r.destinoExtra ?? {}) };
  }
  return {
    nome: (r?.nome ?? "").trim(),
    filtro: {
      status: status.length ? status : null,
      departamento: (r?.departamento ?? "").trim() || null,
      idade_min: Math.max(0, Math.round(num(r?.idade_min))),
    },
    horarios: Array.from(new Set((r?.horarios ?? []).map((h) => (h ?? "").trim()).filter(Boolean))).sort(),
    ...(destino ? { destino } : {}),
    ...(r?.canal ? { canal: r.canal } : {}),
    limite: Math.max(1, Math.min(200, Math.round(num(r?.limite) || 50))),
    ativo: r?.ativo === true,
  };
}

/**
 * Alertas que a gravacao ENGOLIU. `normalizarAlertas` descarta item torto em
 * silencio (fail-closed, e esta certo); sem esta conferencia a tela diria
 * "salvei" e o alerta nao existiria. Compara por nome, que e a chave.
 */
export function nomesPerdidos(enviados: unknown, gravados: unknown): string[] {
  const nomes = (v: unknown) =>
    lista(v)
      .map((a) => (typeof a?.nome === "string" ? a.nome.trim() : ""))
      .filter(Boolean);
  const vivos = new Set(nomes(gravados));
  return nomes(enviados).filter((n) => !vivos.has(n));
}

// ---------------------------------------------------------------------------
// 9b. Escrita concorrente na config (lost update)
// ---------------------------------------------------------------------------
// `alertas_sla` e UMA chave com a lista INTEIRA: gravar e sobrescrever tudo.
// Dois admins na tela ao mesmo tempo = o ultimo a salvar apaga o alerta que o
// outro criou no meio, sem erro nenhum na tela (achado da revisao cega,
// 31/08/2026). A rota nao tem versao/etag, entao a deteccao mora aqui: a tela
// guarda o RETRATO de que partiu, re-le a config antes de gravar e compara.
//
// Por que comparar retrato e nao contar itens: trocar um alerta por outro mantem
// a contagem e muda o conteudo. E por que normalizar antes de comparar: a ordem
// das chaves do JSON e o `undefined` de campo opcional variam sem o dado variar,
// e isso daria falso positivo em toda gravacao.
export function retratoDeAlertas(alertas: unknown): string {
  return JSON.stringify(
    lista(alertas).map((a: any) => ({
      nome: typeof a?.nome === "string" ? a.nome.trim() : "",
      ativo: a?.ativo === true,
      horarios: Array.from(new Set(lista(a?.horarios).filter((h) => typeof h === "string"))).sort(),
      canal: typeof a?.canal === "string" ? a.canal : null,
      limite: num(a?.limite),
      filtro: {
        status: Array.from(new Set(lista(a?.filtro?.status).filter((s) => typeof s === "string"))).sort(),
        departamento: typeof a?.filtro?.departamento === "string" ? a.filtro.departamento : null,
        idade_min: num(a?.filtro?.idade_min),
      },
      destino: a?.destino ? JSON.stringify(a.destino, Object.keys(a.destino).sort()) : null,
    }))
  );
}

/** `true` = alguem mexeu na config desde o retrato: a tela recusa em vez de sobrescrever. */
export function configMudouPorFora(retrato: string, atual: unknown): boolean {
  return retrato !== retratoDeAlertas(atual);
}

// ---------------------------------------------------------------------------
// 9c. Selects: valor gravado que nao esta nas opcoes
// ---------------------------------------------------------------------------
// Um `<select>` cujo `value` nao casa com nenhuma `<option>` renderiza EM BRANCO
// — e, pior, o primeiro save "conserta" pro valor da primeira opcao sem ninguem
// pedir. Acontece de verdade: idade 720 (12h) posta na config pela API, canal
// desativado, departamento apagado, status novo. A opcao sintetica deixa o valor
// VISIVEL e preserva quem escolheu por fora.
export type Opcao = { valor: string; rotulo: string; sintetica?: boolean };

export function garantirOpcao(opcoes: Opcao[], atual: string, rotulador?: (v: string) => string): Opcao[] {
  const v = (atual ?? "").toString();
  if (!v || opcoes.some((o) => o.valor === v)) return opcoes;
  return [...opcoes, { valor: v, rotulo: `${rotulador ? rotulador(v) : v} (definido fora da tela)`, sintetica: true }];
}

/** Status do alerta pra tela: os canonicos + o que estiver gravado fora da lista. */
export function statusParaTela(selecionados: string[]): Opcao[] {
  const base: Opcao[] = STATUS_ALERTA.map((s) => ({ valor: s, rotulo: s }));
  const extras = (selecionados ?? [])
    .filter((s) => typeof s === "string" && s && !(STATUS_ALERTA as readonly string[]).includes(s))
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .map((s) => ({ valor: s, rotulo: `${s} (definido fora da tela)`, sintetica: true }));
  return [...base, ...extras];
}

/** Rotulo de minutos pro select de idade ("12h", "3 dias"). */
export function rotuloIdade(min: number): string {
  const conhecida = IDADES_ALERTA.find((i) => i.min === Number(min));
  return conhecida ? conhecida.rotulo : duracaoLegivel(Number(min) * 60);
}

/** Resumo do filtro em uma linha, pra listagem ("aguardando, sem dono, 3 dias"). */
export function resumoDoFiltro(
  r: RascunhoAlerta,
  nomeDoDepartamento: (id: string) => string | null
): string {
  const partes: string[] = [];
  if (r.status.length) partes.push(r.status.join(" ou "));
  else partes.push("qualquer status");
  if (r.departamento === SEM_DONO_ALERTA) partes.push("sem responsavel");
  else if (r.departamento) partes.push(nomeDoDepartamento(r.departamento) || "departamento");
  if (r.idade_min > 0) partes.push(`parada ha ${duracaoLegivel(r.idade_min * 60)}`);
  return partes.join(" · ");
}

// ---------------------------------------------------------------------------
// 10. Download de CSV autenticado
// ---------------------------------------------------------------------------
// As rotas exigem Bearer, entao um <a href> simples volta 401: o arquivo e
// baixado por fetch e entregue como blob. O nome do arquivo vem do
// Content-Disposition que a rota manda (ela ja sanitiza), com fallback local.
export function nomeDoContentDisposition(cabecalho: string | null, fallback: string): string {
  if (!cabecalho) return fallback;
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)"?/i.exec(cabecalho);
  const bruto = m ? decodeURIComponent(m[1].trim()) : "";
  // nunca confiar no nome pra montar caminho: so o basename, e so o alfabeto do
  // proprio gerador de nome da rota (lib/relatorios.nomeArquivoCsv)
  const limpo = bruto
    .replace(/^.*[\\/]/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return limpo || fallback;
}

// Motivo pra o botao de exportar nem aparecer. `null` = pode exportar.
// A rota JA nega com 403 — a tela nao pode oferecer botao que sempre falha.
export function motivoSemExportar(podeExportar: boolean): string | null {
  return podeExportar ? null : "Exportar CSV exige a permissao 'relatorios_exportar' (fale com o administrador).";
}

// ---------------------------------------------------------------------------
// 11. Satisfacao: CSAT do painel + NPS importado (Frente V, card 86ak85bne)
// ---------------------------------------------------------------------------
// SAO DUAS COISAS E A TELA NUNCA AS SOMA. A rota /api/relatorios/nps ja deixa
// isso claro no corpo (dois blocos, escalas diferentes: CSAT 1-5 do painel, NPS
// 0-10 importado de outra ferramenta) e a tela repete a separacao visualmente.
// Somar as duas daria um numero que nao existe em lugar nenhum.

export type FaixaNps = {
  total: number;
  promotores: number;
  neutros: number;
  detratores: number;
  score: number | null;
  media: number | null;
};

export type SatisfacaoTela = {
  csat: { total: number; media: number | null; escala: string; distribuicao: Record<string, number>; erro?: string };
  nps: {
    importado: boolean;
    escala: string;
    geral: FaixaNps & { distribuicao: Record<string, number> };
    pesquisas: (FaixaNps & { id: string; nome: string; origem: string | null; respostas: number })[];
    ligadas_a_conversa: number;
    fora_do_periodo_sem_data: number;
    aviso: string | null;
  };
  dias: number;
  canal: string;
};

const faixaVazia = (): FaixaNps => ({ total: 0, promotores: 0, neutros: 0, detratores: 0, score: null, media: null });
// `num` (secao 1) ja e o "numero ou 0" defensivo deste arquivo — reusado aqui de
// proposito: dois normalizadores de numero no mesmo modulo divergem na primeira
// vez que alguem ajusta um deles.
const numOuNulo = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : num(v));

function faixaDoBruto(o: any): FaixaNps {
  if (!o || typeof o !== "object") return faixaVazia();
  return {
    total: num(o.total),
    promotores: num(o.promotores),
    neutros: num(o.neutros),
    detratores: num(o.detratores),
    // score PODE ser 0 legitimamente (metade promotor, metade detrator): `null`
    // significa "nao ha resposta", e a tela mostra as duas coisas diferente.
    score: numOuNulo(o.score),
    media: numOuNulo(o.media),
  };
}

function distribuicaoDoBruto(o: unknown): Record<string, number> {
  const d: Record<string, number> = {};
  if (!o || typeof o !== "object") return d;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) d[k] = num(v);
  return d;
}

/** Corpo da rota -> forma da tela. Tolerante: rota degradada nao quebra a tela. */
export function lerSatisfacao(bruto: unknown): SatisfacaoTela {
  const b = (bruto ?? {}) as any;
  const nps = b.nps ?? {};
  return {
    csat: {
      total: num(b.csat?.total),
      media: numOuNulo(b.csat?.media),
      escala: typeof b.csat?.escala === "string" ? b.csat.escala : "1-5",
      distribuicao: distribuicaoDoBruto(b.csat?.distribuicao),
      erro: typeof b.csat?.erro === "string" ? b.csat.erro : undefined,
    },
    nps: {
      importado: nps.importado === true,
      escala: typeof nps.escala === "string" ? nps.escala : "0-10",
      geral: { ...faixaDoBruto(nps.geral), distribuicao: distribuicaoDoBruto(nps.geral?.distribuicao) },
      pesquisas: (Array.isArray(nps.pesquisas) ? nps.pesquisas : []).map((p: any) => ({
        id: String(p?.id ?? ""),
        nome: String(p?.nome ?? "(sem nome)"),
        origem: typeof p?.origem === "string" ? p.origem : null,
        respostas: num(p?.respostas),
        ...faixaDoBruto(p),
      })),
      ligadas_a_conversa: num(nps.ligadas_a_conversa),
      fora_do_periodo_sem_data: num(nps.fora_do_periodo_sem_data),
      aviso: typeof nps.aviso === "string" ? nps.aviso : null,
    },
    dias: num(b.dias) || 365,
    canal: typeof b.canal === "string" ? b.canal : "todos",
  };
}

/**
 * Classificacao do NPS em palavra. As faixas sao as do mercado (critico < 0,
 * aperfeicoamento 0-49, qualidade 50-74, excelencia 75+) e existem pra tela nao
 * mostrar so um numero de -100 a 100, que ninguem interpreta sem tabela ao lado.
 * `null` (nenhuma resposta) NAO vira "critico" — vira "sem resposta".
 */
export function classificacaoNps(score: number | null): { rotulo: string; tom: "cinza" | "vermelho" | "amarelo" | "verde" } {
  if (score === null || !Number.isFinite(score)) return { rotulo: "sem resposta", tom: "cinza" };
  if (score < 0) return { rotulo: "zona critica", tom: "vermelho" };
  if (score < 50) return { rotulo: "zona de aperfeicoamento", tom: "amarelo" };
  if (score < 75) return { rotulo: "zona de qualidade", tom: "verde" };
  return { rotulo: "zona de excelencia", tom: "verde" };
}

/**
 * Barras da distribuicao, com TODA nota da escala presente — inclusive as
 * zeradas. Nota ausente do grafico faz o gestor achar que ninguem deu 0; nota
 * com barra vazia mostra que ninguem deu 0. Sao leituras diferentes.
 */
export function barrasDaDistribuicao(
  distribuicao: Record<string, number>,
  escala: string
): { nota: number; quantidade: number; proporcao: number; classe: "detrator" | "neutro" | "promotor" | null }[] {
  const [de, ate] = escala === "1-5" ? [1, 5] : [0, 10];
  const notas: number[] = [];
  for (let i = de; i <= ate; i++) notas.push(i);
  const maior = Math.max(1, ...notas.map((n) => num(distribuicao[String(n)])));
  return notas.map((n) => ({
    nota: n,
    quantidade: num(distribuicao[String(n)]),
    proporcao: num(distribuicao[String(n)]) / maior,
    classe: escala === "1-5" ? null : n >= 9 ? "promotor" : n >= 7 ? "neutro" : "detrator",
  }));
}

/**
 * O que a tela de satisfacao precisa AVISAR, em ordem de importancia. Cada frase
 * corresponde a um jeito de ler o numero errado — e a rota ja manda os dados que
 * as produzem; o que faltava era alguem transformar em frase.
 */
export function avisosDaSatisfacao(s: SatisfacaoTela): string[] {
  const av: string[] = [];
  if (s.csat.erro) av.push(`CSAT indisponivel: ${s.csat.erro}`);
  if (!s.nps.importado) {
    av.push(
      s.nps.aviso ||
        "NPS historico nao importado nesta instalacao — a tela mostra so o CSAT que este painel coleta."
    );
  } else if (s.nps.aviso) {
    av.push(s.nps.aviso);
  }
  if (s.nps.fora_do_periodo_sem_data > 0) {
    av.push(
      `${s.nps.fora_do_periodo_sem_data} resposta(s) de NPS foram importadas SEM data e ficam fora de qualquer periodo — elas nao entram em nenhum numero desta tela.`
    );
  }
  if (s.nps.importado && s.nps.geral.total > 0 && s.nps.ligadas_a_conversa === 0) {
    av.push(
      "nenhuma resposta de NPS esta ligada a uma conversa do painel: o historico veio da ferramenta antiga sem o telefone, entao nao da pra abrir a conversa de quem respondeu."
    );
  }
  return av;
}

export type { LinhaMatriz, Matriz };
