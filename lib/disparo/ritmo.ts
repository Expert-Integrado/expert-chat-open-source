// Ritmo do disparo — a DECISAO de quem sai agora, isolada em funcao PURA.
//
// Este arquivo nao importa nada e nao toca rede nem banco de proposito: e o que
// permite provar o motor de disparo sem mandar UMA mensagem sequer (regra da
// casa nesta frente — nenhum disparo real no desenvolvimento). A rota de tick
// (app/api/cron-disparo) so junta os numeros do banco, chama `decidirEnvios` e
// executa o que ela mandar.
//
// Tres freios, todos aplicados ANTES do primeiro envio da rodada:
//   1. LOTE        — quantos destinos no maximo esta chamada processa;
//   2. INTERVALO   — espera minima entre dois envios da mesma campanha;
//   3. TETO DIARIO — quantos envios o canal (o "chip") aguenta por dia, somando
//                    TODAS as campanhas que saem por ele.
//
// O teto e por CANAL e nao por campanha porque quem queima e o numero: duas
// campanhas de 200 no mesmo chip somam 400 no mesmo dia, e o WhatsApp conta o
// numero, nao a campanha.

import { inicioDoDia as inicioDoDiaFuso, segundosAteVirarODia as ateVirarFuso } from "./fuso.ts";

export type ConfigRitmo = {
  /** maximo de destinos processados por chamada do tick */
  lote: number;
  /** espera minima entre dois envios da mesma campanha */
  intervalo_s: number;
  /** teto de envios por dia pelo canal, somando todas as campanhas */
  teto_por_numero_dia: number;
};

export type EstadoRitmo = {
  /** quantos destinos pendentes a campanha ainda tem */
  pendentes: number;
  /** quantos envios ja sairam por este canal no dia corrente (todas as campanhas) */
  enviados_hoje_no_canal: number;
  /** instante do ultimo envio DESTA campanha (null = ainda nao enviou nada) */
  ultimo_envio_em: string | Date | null;
};

export type Decisao = {
  /** quantos destinos processar AGORA */
  enviar: number;
  /** quando faz sentido chamar o tick de novo (segundos); 0 = pode ja */
  esperar_s: number;
  /** a fila acabou: a campanha pode ser concluida */
  encerrar: boolean;
  /** motivo legivel de nao ter enviado tudo (aparece na tela e no relatorio) */
  motivo: string | null;
  /**
   * Motivo estrutural, pra tela decidir o que dizer:
   *  - "teto_diario": o chip bateu o limite do dia (espera virar o dia)
   *  - "intervalo": ritmo, so esperar
   *  - "lote": ha mais fila do que cabe nesta chamada (segue no proximo tick)
   *  - "fila_vazia": acabou
   */
  causa: "ok" | "lote" | "intervalo" | "teto_diario" | "fila_vazia";
};

const inteiro = (v: unknown, padrao: number, min: number, max: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao;
};

/** Normaliza a config de ritmo vinda do banco/tela pros limites da migration. */
export function normalizarRitmo(bruto: Partial<ConfigRitmo> | null | undefined): ConfigRitmo {
  return {
    lote: inteiro(bruto?.lote, 40, 1, 200),
    intervalo_s: inteiro(bruto?.intervalo_s, 5, 0, 3600),
    teto_por_numero_dia: inteiro(bruto?.teto_por_numero_dia, 300, 1, 100000),
  };
}

/**
 * Quantos destinos saem AGORA — e, se nao saem todos, por que.
 *
 * Ordem dos freios importa: o teto diario e checado ANTES do intervalo porque
 * "o chip bateu o limite" e uma resposta diferente de "espera 5 segundos" —
 * quem opera precisa saber que o disparo so continua amanha, e nao ficar
 * apertando atualizar (a licao 4 do card: distinguir sem capacidade de sem
 * credencial vale tambem pra distinguir os tipos de espera).
 */
export function decidirEnvios(config: ConfigRitmo, estado: EstadoRitmo, agora: Date = new Date()): Decisao {
  const c = normalizarRitmo(config);
  const pendentes = Math.max(0, Math.floor(estado.pendentes) || 0);

  if (pendentes === 0) {
    return { enviar: 0, esperar_s: 0, encerrar: true, motivo: null, causa: "fila_vazia" };
  }

  // ---- freio 1: teto diario do canal
  const jaHoje = Math.max(0, Math.floor(estado.enviados_hoje_no_canal) || 0);
  const folga = c.teto_por_numero_dia - jaHoje;
  if (folga <= 0) {
    return {
      enviar: 0,
      esperar_s: segundosAteVirarODia(agora),
      encerrar: false,
      motivo: `teto diario do canal atingido (${jaHoje}/${c.teto_por_numero_dia}) — o disparo continua quando o dia virar`,
      causa: "teto_diario",
    };
  }

  // ---- freio 2: intervalo entre envios
  if (estado.ultimo_envio_em) {
    const t = new Date(estado.ultimo_envio_em);
    if (!isNaN(t.getTime())) {
      const decorrido = (agora.getTime() - t.getTime()) / 1000;
      const falta = c.intervalo_s - decorrido;
      if (falta > 0) {
        return {
          enviar: 0,
          esperar_s: Math.ceil(falta),
          encerrar: false,
          motivo: `respeitando o intervalo de ${c.intervalo_s}s entre envios`,
          causa: "intervalo",
        };
      }
    }
  }

  // ---- freio 3: lote
  const enviar = Math.min(pendentes, c.lote, folga);
  const sobra = pendentes - enviar;
  return {
    enviar,
    esperar_s: sobra > 0 ? c.intervalo_s : 0,
    encerrar: false,
    motivo:
      sobra > 0
        ? enviar === folga && folga < c.lote
          ? `restam ${sobra}: o canal so tem folga pra ${folga} hoje`
          : `restam ${sobra} para as proximas rodadas`
        : null,
    causa: sobra > 0 ? (enviar === folga && folga < c.lote ? "teto_diario" : "lote") : "ok",
  };
}

/**
 * Segundos ate a virada do dia NO FUSO DA INSTALACAO.
 *
 * Antes esta funcao cravava UTC-3. O painel e instalado por cada cliente: o teto
 * diario tem que virar no dia DELE, nao no de quem escreveu o codigo. O fuso vem
 * de lib/disparo/fuso.ts (env FUSO_HORARIO) — ver a costura declarada la.
 */
export function segundosAteVirarODia(agora: Date, fuso?: string): number {
  return ateVirarFuso(agora, fuso);
}

/** Comeco do dia corrente no fuso da instalacao, em ISO — janela do teto diario. */
export function inicioDoDia(agora: Date = new Date(), fuso?: string): string {
  return inicioDoDiaFuso(agora, fuso);
}

/**
 * Estimativa de duracao ANTES de disparar (criterio 7 do card 86ak85jek).
 * Conta os freios de ritmo E o teto diario: um publico de 5.000 com teto de 300
 * por dia nao leva horas, leva mais de duas semanas — e quem aprova precisa ver
 * isso na tela, nao descobrir depois.
 */
export function estimarDuracao(
  total: number,
  config: ConfigRitmo,
  folgaHoje?: number
): { segundos: number; dias: number; texto: string } {
  const c = normalizarRitmo(config);
  const n = Math.max(0, Math.floor(total) || 0);
  if (n === 0) return { segundos: 0, dias: 0, texto: "sem destinos" };

  const hoje = Math.max(0, Math.min(n, folgaHoje === undefined ? c.teto_por_numero_dia : folgaHoje));
  const resto = n - hoje;
  const diasExtras = resto > 0 ? Math.ceil(resto / c.teto_por_numero_dia) : 0;
  // dentro de um dia, o custo e o intervalo entre envios
  const segundosHoje = Math.max(0, hoje - 1) * c.intervalo_s;
  const segundos = segundosHoje + diasExtras * 86400;

  const texto = diasExtras
    ? `~${diasExtras + 1} dia(s), limitado pelo teto de ${c.teto_por_numero_dia}/dia do canal`
    : humanizar(segundosHoje);
  return { segundos, dias: diasExtras, texto };
}

function humanizar(segundos: number): string {
  if (segundos < 60) return `~${Math.max(1, Math.round(segundos))} segundo(s)`;
  if (segundos < 3600) return `~${Math.round(segundos / 60)} minuto(s)`;
  return `~${(segundos / 3600).toFixed(1)} hora(s)`;
}
