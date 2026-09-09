// Janela de acesso por usuario — REGRA PURA (card 86ak858x0).
//
// O QUE E: o admin diz em QUE DIAS e em QUE HORAS cada pessoa pode usar o
// painel. Ate DOIS periodos por dia, porque o segundo existe pro intervalo de
// almoco (medido na ferramenta que este painel substitui: `d{dia}_p1_from/to`
// e `d{dia}_p2_from/to`, um par por turno — docs/mapa/03-usuarios-permissoes.md).
//
// RETROCOMPATIBILIDADE E REQUISITO: quem NAO tem janela configurada entra
// sempre. Toda instalacao existente esta nesse estado, e ela nao pode mudar de
// comportamento no dia do deploy. Por isso `null` e `ativo:false` liberam.
//
// FAIL-CLOSED onde importa: janela LIGADA com a grade vazia nao libera nada.
// Quem ligou a janela e nao marcou dia nenhum esta dizendo "esta pessoa nao
// entra" — e a rota de gravacao recusa esse estado com mensagem clara, entao
// ninguem cai nele por acidente de UI.
//
// Este arquivo importa SO `./fuso.ts` (que por sua vez nao importa nada), com
// o especificador de extensao explicito — a licenca `allowImportingTsExtensions`
// que a Frente H ligou no tsconfig existe pra isto: o modulo roda no Next E em
// node solto (`node scripts/prova-seguranca-conta.ts`), sem build.

import { partesNoFuso } from "./fuso.ts";

/** Um turno. `de` inclusivo, `ate` EXCLUSIVO (18:00 ja esta fora) — mesma
 *  convencao do `dentroDaJanela` do horario de atendimento em lib/fuso.ts. */
export type Periodo = { de: string; ate: string };

export type JanelaAcesso = {
  /** false = janela desligada (a linha existe, mas a pessoa entra sempre). */
  ativo: boolean;
  /** dia 0(dom)..6(sab) -> ate 2 periodos. Dia AUSENTE = dia sem acesso. */
  dias: Record<number, Periodo[]>;
};

export const MAX_PERIODOS_POR_DIA = 2;

// Construido com RegExp(string) pela mesma razao de lib/funis.ts: nada de
// literal exotico no meio do codigo.
const HORA_RE = new RegExp("^([01][0-9]|2[0-3]):[0-5][0-9]$");

export const NOME_DIA = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"] as const;

/** "HH:MM" de verdade (00:00 a 23:59). Comparavel como string, de proposito. */
export function horaValida(v: unknown): v is string {
  return typeof v === "string" && HORA_RE.test(v);
}

const hhmm = (hora: number, minuto: number) =>
  `${String(hora).padStart(2, "0")}:${String(minuto).padStart(2, "0")}`;

// ————————————————————————————————————————————————————————— saneamento
//
// O jsonb do banco e livre e o corpo da rota vem do front: nada aqui confia no
// formato. Chave/valor que nao entende e DESCARTADO em silencio (mesmo espirito
// de lib/permissoes.ts e lib/modulos.ts), e o que sobra sai ORDENADO — assim a
// gravacao e a tela nao dependem da ordem de digitacao.
//
// Formato aceito em `dias`: mapa "0".."6" -> lista de periodos, cada periodo
// como {de,ate} ou como par ["08:00","12:00"]. O segundo formato existe porque
// e o que cabe melhor num jsonb enxuto e no export da outra ferramenta.
function periodoValido(bruto: unknown): Periodo | null {
  let de: unknown;
  let ate: unknown;
  if (Array.isArray(bruto)) {
    [de, ate] = bruto;
  } else if (bruto && typeof bruto === "object") {
    de = (bruto as any).de;
    ate = (bruto as any).ate;
  }
  if (!horaValida(de) || !horaValida(ate)) return null;
  // periodo de duracao zero nao e janela: seria "aberto das 8 as 8". Recusado
  // aqui em vez de virar um dia que nunca libera e ninguem entende.
  if (de === ate) return null;
  return { de, ate };
}

export function validarJanela(bruto: unknown): JanelaAcesso {
  const vazia: JanelaAcesso = { ativo: false, dias: {} };
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return vazia;
  const b = bruto as Record<string, unknown>;
  const dias: Record<number, Periodo[]> = {};
  const cru = b.dias && typeof b.dias === "object" && !Array.isArray(b.dias) ? (b.dias as Record<string, unknown>) : {};
  for (let d = 0; d <= 6; d++) {
    const lista = cru[String(d)];
    if (!Array.isArray(lista)) continue;
    const periodos: Periodo[] = [];
    for (const p of lista) {
      const ok = periodoValido(p);
      if (ok) periodos.push(ok);
      if (periodos.length >= MAX_PERIODOS_POR_DIA) break;
    }
    // dia sem periodo valido nao entra: assim `janelaVazia` consegue enxergar
    // "grade vazia" mesmo quando o front mandou {"1":[]}
    if (periodos.length) {
      periodos.sort((a, c) => a.de.localeCompare(c.de));
      dias[d] = periodos;
    }
  }
  return { ativo: b.ativo === true, dias };
}

/** Nao restringe NADA — sem linha ou janela desligada. Janela ligada sempre
 *  restringe (pela grade, ou barrando tudo quando a grade esta vazia). */
export function janelaVazia(j: JanelaAcesso | null | undefined): boolean {
  return !j || !j.ativo;
}

/** Janela LIGADA e sem dia nenhum — estado que barra sempre. A rota de
 *  gravacao recusa isto de proposito (lockout por acidente de UI). */
export function janelaBloqueiaSempre(j: JanelaAcesso | null | undefined): boolean {
  return !!j && j.ativo && !Object.keys(j.dias).length;
}

// ——————————————————————————————————————————————————————————— a decisao
//
// Recebe as PARTES ja no fuso da instalacao (dia da semana, hora, minuto) em
// vez de um Date: mantem a funcao trivialmente provavel e deixa a conta de fuso
// num lugar so (lib/fuso.ts). `acessoPermitido` abaixo faz as duas coisas
// juntas, e e o que o servidor chama.
export type PartesLocais = { diaSemana: number; hora: number; minuto: number };

export function dentroDaJanela(j: JanelaAcesso | null | undefined, p: PartesLocais): boolean {
  // sem linha, ou janela desligada = entra sempre (retrocompatibilidade)
  if (!j || !j.ativo) return true;
  const diasMarcados = Object.keys(j.dias);
  if (!diasMarcados.length) return false; // ligada e vazia = ninguem entra
  const hm = hhmm(p.hora, p.minuto);

  // 1) periodos que COMECAM no dia de hoje
  for (const per of j.dias[p.diaSemana] ?? []) {
    if (per.de <= per.ate) {
      if (hm >= per.de && hm < per.ate) return true;
    } else if (hm >= per.de) {
      // periodo que VIRA A MEIA-NOITE (22:00 -> 06:00): a parte de hoje vai do
      // `de` ate 23:59; a madrugada e conferida no passo 2, no dia seguinte.
      return true;
    }
  }

  // 2) madrugada que PERTENCE a escala de ONTEM (o turno da noite que atravessou)
  const ontem = (p.diaSemana + 6) % 7;
  for (const per of j.dias[ontem] ?? []) {
    if (per.de > per.ate && hm < per.ate) return true;
  }

  return false;
}

/** A decisao com o instante real: parte do UTC e resolve no fuso da INSTALACAO. */
export function acessoPermitido(
  j: JanelaAcesso | null | undefined,
  agora: Date,
  fuso: string
): boolean {
  if (!j || !j.ativo) return true;
  const p = partesNoFuso(agora, fuso);
  return dentroDaJanela(j, { diaSemana: p.diaSemana, hora: p.hora, minuto: p.minuto });
}

/** Texto curto pro admin e pra mensagem de recusa. Nunca vazio quando ha janela. */
export function resumoJanela(j: JanelaAcesso | null | undefined): string {
  if (!j || !j.ativo) return "sem janela de acesso (entra sempre)";
  const partes: string[] = [];
  for (let d = 0; d <= 6; d++) {
    const per = j.dias[d];
    if (!per?.length) continue;
    partes.push(`${NOME_DIA[d]} ${per.map((p) => `${p.de}-${p.ate}`).join(" e ")}`);
  }
  return partes.length ? partes.join("; ") : "janela ligada sem nenhum dia liberado";
}

/** A frase que o usuario barrado ve. Sem detalhe de outra pessoa, so a dele. */
export function motivoForaDaJanela(j: JanelaAcesso | null | undefined): string {
  return `fora da janela de acesso liberada pra sua conta (${resumoJanela(j)})`;
}
