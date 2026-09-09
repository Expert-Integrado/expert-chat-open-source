// FUSO da INSTALACAO (regra BASE: nada assume o fuso de nenhuma empresa).
//
// Por que existe: o painel nasceu formatando hora com o fuso do NAVEGADOR do
// atendente e decidindo "dia" com `toDateString()` — dois atendentes em fusos
// diferentes viam separadores de dia diferentes na MESMA conversa, e o
// `dentroDoHorario` do horario de atendimento era UTC-3 aritmetico (sem horario
// de verao, sem instalacao fora do Brasil).
//
// Duas camadas, nesta ordem de precedencia (a mesma de lib/modulos.ts):
//   1. env `FUSO_INSTALACAO` (ou `NEXT_PUBLIC_FUSO_INSTALACAO`, pro bundle do
//      navegador) — o default de quem INSTALOU;
//   2. `mensageria.config` chave `fuso`, que VENCE a env — a palavra final na
//      instalacao rodando (editavel na aba Automacao do admin).
// Sem nenhuma das duas, vale o DEFAULT DE FABRICA abaixo. Ele e so um default:
// trocar e mudar UM campo, nunca mexer em codigo.
//
// Este arquivo NAO IMPORTA NADA de proposito: so `Intl`, que existe no Node e
// no navegador. Roda no Next (servidor e cliente) e em node solto — e o que a
// prova `scripts/prova-fuso.ts` exercita.

/** Default de FABRICA. E um default, nao uma premissa: config e env vencem. */
export const FUSO_FABRICA = "America/Sao_Paulo";

export type PartesData = {
  ano: number;
  mes: number; // 1-12
  dia: number; // 1-31
  hora: number; // 0-23
  minuto: number;
  segundo: number;
  /** 0=domingo .. 6=sabado, ja no fuso pedido */
  diaSemana: number;
};

const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;

// Intl.DateTimeFormat e caro pra criar; a instalacao usa 1 fuso, entao o cache
// tem 1 entrada na pratica.
const formatadores = new Map<string, Intl.DateTimeFormat>();

/** true so pra IANA timezone que o runtime realmente conhece. */
export function fusoValido(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false; // RangeError: fuso desconhecido
  }
}

/**
 * Fuso vindo de env. `FUSO_INSTALACAO` no servidor;
 * `NEXT_PUBLIC_FUSO_INSTALACAO` tambem vale, porque so ela chega ao bundle do
 * navegador (o cliente recebe o valor de verdade pela rota /api/chats — a env
 * publica e so o palpite do primeiro render).
 */
export function fusoDoEnv(): string | null {
  // `process` nao existe em todo runtime de navegador; nunca deixar quebrar o painel
  const env = typeof process !== "undefined" && process.env ? process.env : ({} as Record<string, string | undefined>);
  for (const v of [env.FUSO_INSTALACAO, env.NEXT_PUBLIC_FUSO_INSTALACAO]) {
    if (fusoValido(v)) return v;
  }
  return null;
}

/**
 * A decisao de fuso, num lugar so: config > env > fabrica.
 * Valor invalido (fuso que o runtime nao conhece, lixo, vazio) e IGNORADO em
 * silencio — instalacao com config errada cai no default, nunca quebra a tela.
 */
export function resolverFuso(daConfig?: unknown): string {
  if (fusoValido(daConfig)) return daConfig;
  return fusoDoEnv() ?? FUSO_FABRICA;
}

function fmt(fuso: string): Intl.DateTimeFormat {
  let f = formatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: fuso,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatadores.set(fuso, f);
  }
  return f;
}

/** Ano/mes/dia/hora/minuto/segundo/dia-da-semana de um instante, no fuso dado. */
export function partesNoFuso(d: Date, fuso: string): PartesData {
  const p: Record<string, string> = {};
  for (const parte of fmt(fuso).formatToParts(d)) p[parte.type] = parte.value;
  const ano = Number(p.year);
  const mes = Number(p.month);
  const dia = Number(p.day);
  // h23 devolve 00-23, mas ha runtime antigo que emite "24" pra meia-noite
  const hora = Number(p.hour) % 24;
  const minuto = Number(p.minute);
  const segundo = Number(p.second);
  // dia da semana SEM depender de locale: monta a data civil como se fosse UTC
  const diaSemana = new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();
  return { ano, mes, dia, hora, minuto, segundo, diaSemana };
}

/**
 * Minutos que separam o fuso do UTC neste instante (ex: -180 em Sao Paulo).
 * Calculado por instante, entao horario de verao entra sozinho — instalacao em
 * Lisboa ou Nova York nao precisa de tabela nenhuma.
 */
export function offsetMinutos(d: Date, fuso: string): number {
  const p = partesNoFuso(d, fuso);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  const semMs = d.getTime() - (d.getTime() % 1000);
  return (comoUtc - semMs) / 60000;
}

/** "YYYY-MM-DD" no fuso — a unidade de "dia" do painel inteiro. */
export function diaNoFuso(d: Date, fuso: string): string {
  const p = partesNoFuso(d, fuso);
  return `${p.ano}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

/** "HH:MM" no fuso. */
export function horaMinutoNoFuso(d: Date, fuso: string): string {
  const p = partesNoFuso(d, fuso);
  return `${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")}`;
}

/** Mesmo DIA DE CALENDARIO no fuso da instalacao (nao "menos de 24h"). */
export function mesmoDiaNoFuso(a: Date, b: Date, fuso: string): boolean {
  return diaNoFuso(a, fuso) === diaNoFuso(b, fuso);
}

/**
 * Janela de horario de atendimento no fuso da instalacao.
 * `dias` = 0(dom)..6(sab); `inicio`/`fim` em "HH:MM". Fim EXCLUSIVO (18:00 ja
 * esta fora), e janela que cruza a meia-noite (22:00 as 06:00) e aceita.
 */
export function dentroDaJanela(
  d: Date,
  fuso: string,
  dias: number[],
  inicio: string,
  fim: string
): boolean {
  if (!HORA_RE.test(inicio) || !HORA_RE.test(fim)) return false;
  const p = partesNoFuso(d, fuso);
  const hm = `${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")}`;
  if (inicio <= fim) {
    // janela normal, dentro do mesmo dia
    return dias.includes(p.diaSemana) && hm >= inicio && hm < fim;
  }
  // vira o dia: a madrugada pertence ao dia ANTERIOR da escala
  if (hm >= inicio) return dias.includes(p.diaSemana);
  if (hm < fim) return dias.includes((p.diaSemana + 6) % 7);
  return false;
}

/** Hora do dia (0-23) no fuso — pra janela simples tipo "so alerta das 9 as 19". */
export function horaNoFuso(d: Date, fuso: string): number {
  return partesNoFuso(d, fuso).hora;
}

// ───────────────────────── formatacao pra humano ver ─────────────────────────

function partesDeIso(iso: string | number | Date, fuso: string): PartesData | null {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return null;
  return partesNoFuso(d, fuso);
}

const dd = (n: number) => String(n).padStart(2, "0");

/** "31/08/26" */
export function formatarData(iso: string | number | Date, fuso: string): string {
  const p = partesDeIso(iso, fuso);
  if (!p) return "";
  return `${dd(p.dia)}/${dd(p.mes)}/${dd(p.ano % 100)}`;
}

/** "14:35" */
export function formatarHora(iso: string | number | Date, fuso: string): string {
  const p = partesDeIso(iso, fuso);
  if (!p) return "";
  return `${dd(p.hora)}:${dd(p.minuto)}`;
}

/** "31/08/26 14:35" */
export function formatarDataHora(iso: string | number | Date, fuso: string): string {
  const p = partesDeIso(iso, fuso);
  if (!p) return "";
  return `${dd(p.dia)}/${dd(p.mes)}/${dd(p.ano % 100)} ${dd(p.hora)}:${dd(p.minuto)}`;
}

/** "Hoje" / "Ontem" / "31/08/26" — o corte de dia e o da INSTALACAO. */
export function rotuloDiaNoFuso(iso: string | number | Date, fuso: string, agora = new Date()): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return "";
  const dia = diaNoFuso(d, fuso);
  if (dia === diaNoFuso(agora, fuso)) return "Hoje";
  if (dia === diaNoFuso(new Date(agora.getTime() - 86400000), fuso)) return "Ontem";
  return formatarData(d, fuso);
}

// ───────────────────── conversao com <input datetime-local> ─────────────────

/**
 * "YYYY-MM-DDTHH:MM" pro `<input type="datetime-local">`, no fuso da instalacao.
 * Sem isto o campo mostra a hora do NAVEGADOR e o atendente em outro fuso agenda
 * pra hora errada.
 */
export function localDeIso(iso: string | number | Date, fuso: string): string {
  const p = partesDeIso(iso, fuso);
  if (!p) return "";
  return `${p.ano}-${dd(p.mes)}-${dd(p.dia)}T${dd(p.hora)}:${dd(p.minuto)}`;
}

/**
 * O caminho de volta: o que o usuario digitou no campo vale como hora LOCAL DA
 * INSTALACAO e vira instante UTC.
 *
 * Nao basta somar o offset uma vez: nos dois dias do ano em que o relogio muda,
 * o offset do palpite nao e o offset do instante certo. O candidato so vale
 * quando e CONSISTENTE consigo mesmo (o offset naquele instante e o mesmo que
 * foi usado pra chega-lo). Dai os dois casos de borda:
 *  - hora AMBIGUA (saida do horario de verao, a hora que acontece duas vezes):
 *    o primeiro candidato ja fecha, e vale a PRIMEIRA ocorrencia;
 *  - hora INEXISTENTE (entrada do verao, a hora que o relogio pula): nenhum
 *    candidato fecha — vale o mais TARDE, ou seja, a hora anda pra frente
 *    (agendar 02:30 num dia sem 02:30 vira 03:30, nunca Invalid Date nem 01:30).
 * Uma tentativa anterior com "duas passadas" caia justamente no 01:30 — a prova
 * `scripts/prova-fuso.ts` pegou.
 */
export function isoDeLocal(local: string, fuso: string): string | null {
  const m = LOCAL_RE.exec(String(local ?? "").trim());
  if (!m) return null;
  const [, Y, M, D, h, mi] = m;
  const civil = Date.UTC(Number(Y), Number(M) - 1, Number(D), Number(h), Number(mi));
  if (isNaN(civil)) return null;
  const off1 = offsetMinutos(new Date(civil), fuso);
  const t1 = civil - off1 * 60000;
  const off2 = offsetMinutos(new Date(t1), fuso);
  if (off2 === off1) return new Date(t1).toISOString(); // caso normal (e o ambiguo)
  const t2 = civil - off2 * 60000;
  if (offsetMinutos(new Date(t2), fuso) === off2) return new Date(t2).toISOString();
  return new Date(Math.max(t1, t2)).toISOString(); // hora inexistente: anda pra frente
}
