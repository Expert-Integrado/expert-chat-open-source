// O RELOGIO da fila de automacao, no fuso da INSTALACAO.
//
// Arquivo separado de `fila-db.ts` por um motivo pratico e nao estetico: o
// `fila-db` arrasta banco e provedor e nao carrega em node solto, entao a
// conversao de fuso — que e a parte mais facil de errar de tudo isto — ficaria
// sem prova nenhuma. Aqui a unica dependencia e `../fuso.ts`, que nao importa
// nada (so `Intl`), e por isso `node scripts/prova-motor-fila.ts` exercita a
// implementacao DE VERDADE, incluindo a virada do horario de verao.
//
// A decisao de fuso NAO se repete aqui: quem resolve config > env > fabrica e
// lib/fuso.ts, e o fuso ja chega resolvido.

import { isoDeLocal, partesNoFuso } from "../fuso.ts";
import type { RelogioFila } from "./fila.ts";

const dd = (n: number) => String(n).padStart(2, "0");

/**
 * `mesmaHoraNoDiaSeguinte` NAO e "somar 86.400.000ms".
 *
 * Nos dois dias do ano em que o relogio muda, somar 24h desloca a HORA DE PAREDE
 * em uma hora: um follow-up marcado pras 09:00 que precisou pular o domingo
 * apareceria as 08:00 (ou 10:00) na segunda, e ninguem entenderia por que. Aqui a
 * volta e pelo calendario CIVIL da instalacao — soma um dia de data e reconstroi
 * o instante com `isoDeLocal`, que ja sabe tratar hora ambigua (fica na primeira
 * ocorrencia) e hora inexistente (anda pra frente).
 *
 * Fallback declarado: se `isoDeLocal` nao resolver (fuso que o runtime nao
 * conhece), vale o +24h. Ele erra uma hora duas vezes por ano; travar a fila sem
 * data seria pior.
 */
export function relogioDoFuso(fuso: string, agora: () => number = () => Date.now()): RelogioFila {
  return {
    agora,
    diaSemana: (ms) => partesNoFuso(new Date(ms), fuso).diaSemana,
    mesmaHoraNoDiaSeguinte: (ms) => {
      const p = partesNoFuso(new Date(ms), fuso);
      // Date.UTC normaliza virada de mes, de ano e ano bissexto
      const civil = new Date(Date.UTC(p.ano, p.mes - 1, p.dia + 1));
      const local =
        `${civil.getUTCFullYear()}-${dd(civil.getUTCMonth() + 1)}-${dd(civil.getUTCDate())}` +
        `T${dd(p.hora)}:${dd(p.minuto)}`;
      const iso = isoDeLocal(local, fuso);
      return iso ? Date.parse(iso) : ms + 86_400_000;
    },
  };
}
