// Prova do MOTOR DE FILA + SIMULADOR — Frente P, 31/08/2026.
// Roda em Node >= 22.6 sem build: `node scripts/prova-motor-fila.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// REGRA DA CASA NESTA FRENTE: nada aqui abre rede, nada aqui toca banco, nada
// aqui manda mensagem. A fila decide QUANDO e SE um passo roda; essa decisao e
// funcao pura contra uma porta injetada (lib/fluxo/fila.ts), exatamente pra poder
// ser provada assim — inclusive a corrida entre dois ticks, que e o defeito mais
// caro possivel numa fila que manda mensagem pro cliente.
//
// O que esta prova NAO prova, e esta dito: que o Postgres honra o update
// condicional do claim (garantia do banco, nao do nosso codigo) e o fan-out de SQL
// de `coletarFatos` (exige banco).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assinaturaDoNo,
  avaliarNoDeCondicao,
  deveInterromper,
  estadoFilaValido,
  executarTickFila,
  instanteDoPasso,
  jsonCanonico,
  motivoDaParadaParaAval,
  motivoParaNaoEnfileirar,
  precisaAprovacao,
  proximoPasso,
  pularFimDeSemana,
  reservaExpirada,
  ESTADOS_FILA,
  ESTADOS_VIVOS,
  MAX_TENTATIVAS_PASSO,
  type ItemFila,
  type PortaFila,
  type RelogioFila,
  type ResultadoNoFila,
} from "../lib/fluxo/fila.ts";
import { relogioDoFuso } from "../lib/fluxo/fila-relogio.ts";
import {
  alcancaCliente,
  fluxoLinear,
  limitesDoFluxo,
  motivoParaRecusarPuro,
  nosComAprovacao,
  nosComAvalQueImporta,
  ACOES_QUE_ALCANCAM_CLIENTE,
  validarFluxo,
  LIMITE_ESPERA_SEG,
  LIMITE_INTERVALO_MINIMO_SEG,
  LIMITE_MAXIMO_POR_CONVERSA,
  type Acao,
  type Fluxo,
  type No,
} from "../lib/fluxo/schema.ts";
import {
  condicaoDeEntrada,
  efeitoPrevisto,
  simularFluxo,
  simularMensagem,
  type EntradaSimulacao,
} from "../lib/fluxo/simulador.ts";

let checagens = 0;
const teste = (oque: string, fn: () => void) => {
  fn();
  checagens++;
  console.log(`  ok  ${oque}`);
};
const testeAsync = async (oque: string, fn: () => Promise<void>) => {
  await fn();
  checagens++;
  console.log(`  ok  ${oque}`);
};

const CAP = { soLeitura: false, envioCabeado: true };
const LIM_INLINE = { maxInline: 15, maxTotal: 40 };

// relogio de MENTIRA, em UTC, pro que precisa de controle total
function relogioFake(agora: number): RelogioFila {
  return {
    agora: () => agora,
    diaSemana: (ms) => new Date(ms).getUTCDay(),
    mesmaHoraNoDiaSeguinte: (ms) => ms + 86_400_000,
  };
}

const valido = (bruto: unknown): Fluxo => {
  const v = validarFluxo(bruto);
  assert.ok(v.ok, `fluxo deveria ser valido: ${v.ok ? "" : v.erros.join("; ")}`);
  return (v as { ok: true; fluxo: Fluxo }).fluxo;
};

// ============================================ 1) SCHEMA — os campos novos
console.log("\n1) SCHEMA — atraso com fim de semana, aprovacao e limites por conversa");

teste("espera aceita pular_fim_de_semana e o campo sobrevive a validacao", () => {
  const f = valido(
    fluxoLinear({ id: "f", nome: "F" }, [
      { tipo: "espera", segundos: 172800, pular_fim_de_semana: true } as Acao,
      { tipo: "enviar_texto", texto: "oi" },
    ])
  );
  const espera = f.nos.find((n) => n.acao?.tipo === "espera")!;
  assert.equal((espera.acao as any).pular_fim_de_semana, true);
});

teste("pular_fim_de_semana FALSO nao vira chave no jsonb (nada de flag fantasma)", () => {
  const f = valido(
    fluxoLinear({ id: "f", nome: "F" }, [{ tipo: "espera", segundos: 10, pular_fim_de_semana: false } as Acao])
  );
  assert.equal("pular_fim_de_semana" in (f.nos[0].acao as any), false);
});

teste('pular_fim_de_semana em TEXTO ("true") e RECUSADO, nunca normalizado', () => {
  // "true" em texto e o caso classico de jsonb vindo de importacao. Normalizar por
  // truthy ligaria a regra sem ninguem pedir; e um 0 a desligaria. Nos dois casos
  // o efeito e a mensagem cair (ou nao) no sabado do cliente.
  const torto = validarFluxo({
    id: "f",
    nome: "F",
    tipo: "macro",
    versao: 1,
    nos: [{ id: "n1", tipo: "espera", acao: { tipo: "espera", segundos: 10, pular_fim_de_semana: "true" } }],
  });
  assert.equal(torto.ok, false);
  assert.match((torto as any).erros.join(" "), /pular_fim_de_semana precisa ser true ou false/);
});

teste('desligado em TEXTO ("sim") e RECUSADO, igual a aprovacao', () => {
  // Mesma disciplina, e o motivo e simetrico: um valor torto poderia DESLIGAR um
  // passo que hoje roda (a mensagem para de sair sem ninguem saber) ou LIGAR de
  // volta um passo que alguem desligou de proposito. Nao ha default seguro.
  const torto = validarFluxo({
    id: "f",
    nome: "F",
    tipo: "macro",
    versao: 1,
    nos: [{ id: "n1", tipo: "acao", desligado: "sim", acao: { tipo: "enviar_texto", texto: "x" } }],
  });
  assert.equal(torto.ok, false);
  assert.match((torto as any).erros.join(" "), /desligado precisa ser true ou false/);

  const zero = validarFluxo({
    id: "f",
    nome: "F",
    tipo: "macro",
    versao: 1,
    nos: [{ id: "n1", tipo: "acao", desligado: 0, acao: { tipo: "enviar_texto", texto: "x" } }],
  });
  assert.equal(zero.ok, false, "0 nao pode virar 'ligado' por truthy");
});

teste("desligado FALSO nao vira chave no jsonb (nada de flag fantasma)", () => {
  const f = valido({
    id: "f",
    nome: "F",
    tipo: "macro",
    versao: 1,
    nos: [{ id: "n1", tipo: "acao", desligado: false, acao: { tipo: "enviar_texto", texto: "x" } }],
  });
  assert.equal("desligado" in (f.nos[0] as any), false);
});

teste("no com aprovacao: true valida, e nosComAprovacao lista o passo", () => {
  const f = valido({
    id: "f",
    nome: "F",
    tipo: "macro",
    versao: 1,
    nos: [
      { id: "n1", tipo: "acao", acao: { tipo: "nota_interna", texto: "conferir" }, proximo: "n2" },
      { id: "n2", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "proposta" } },
    ],
  });
  assert.deepEqual(nosComAprovacao(f), ["n2"]);
});

teste("aprovacao em texto e RECUSADA: nao existe default seguro pra adivinhar", () => {
  const v = validarFluxo({
    id: "f",
    nome: "F",
    tipo: "macro",
    versao: 1,
    nos: [{ id: "n1", tipo: "acao", aprovacao: "sim", acao: { tipo: "enviar_texto", texto: "x" } }],
  });
  assert.equal(v.ok, false);
  assert.match((v as any).erros.join(" "), /aprovacao precisa ser true ou false/);
});

teste("no FORA da corrente que pede aval nao faz o fluxo pedir aval", () => {
  // n2 existe no fluxo mas ninguem aponta pra ele: nao roda, entao nao pede nada
  const f = valido({
    id: "f",
    nome: "F",
    tipo: "macro",
    versao: 1,
    nos: [
      { id: "n1", tipo: "acao", acao: { tipo: "nota_interna", texto: "a" } },
      { id: "n2", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "b" } },
    ],
  });
  assert.deepEqual(nosComAprovacao(f), []);
});

teste("limites por conversa: 999/9999 nao existem aqui — null e 'sem limite'", () => {
  const semLimite = valido(fluxoLinear({ id: "f", nome: "F" }, [{ tipo: "nota_interna", texto: "x" }]));
  assert.deepEqual(limitesDoFluxo(semLimite), { maximo_por_conversa: null, intervalo_minimo_segundos: 0 });

  const comLimite = valido({
    ...fluxoLinear({ id: "g", nome: "G" }, [{ tipo: "nota_interna", texto: "x" }]),
    limites: { maximo_por_conversa: 1, intervalo_minimo_segundos: 300 },
  });
  assert.deepEqual(limitesDoFluxo(comLimite), { maximo_por_conversa: 1, intervalo_minimo_segundos: 300 });
});

teste("limite torto e ERRO, nunca 'sem limite' em silencio", () => {
  for (const limites of [
    { maximo_por_conversa: 0 },
    { maximo_por_conversa: LIMITE_MAXIMO_POR_CONVERSA + 1 },
    { maximo_por_conversa: 1.5 },
    { intervalo_minimo_segundos: -1 },
    { intervalo_minimo_segundos: LIMITE_INTERVALO_MINIMO_SEG + 1 },
    "nao sou objeto",
  ]) {
    const v = validarFluxo({
      ...fluxoLinear({ id: "f", nome: "F" }, [{ tipo: "nota_interna", texto: "x" }]),
      limites,
    });
    assert.equal(v.ok, false, `limites ${JSON.stringify(limites)} deveria ser recusado`);
  }
});

teste("maximo_por_conversa: null e explicito e VALIDO (sem limite escrito de proposito)", () => {
  const f = valido({
    ...fluxoLinear({ id: "f", nome: "F" }, [{ tipo: "nota_interna", texto: "x" }]),
    limites: { maximo_por_conversa: null, intervalo_minimo_segundos: 0 },
  });
  assert.equal(limitesDoFluxo(f).maximo_por_conversa, null);
});

// ==================================== 2) PREFLIGHT — o modo muda a decisao
console.log("\n2) PREFLIGHT — inline x fila (a diferenca e de CAPACIDADE, nao de gosto)");

const FLUXO_LONGO = valido(
  fluxoLinear({ id: "regua", nome: "Regua" }, [
    { tipo: "enviar_texto", texto: "oi" },
    { tipo: "espera", segundos: 2 * 86400 },
    { tipo: "enviar_texto", texto: "e ai, conseguiu ver?" },
  ])
);
const FLUXO_COM_AVAL = valido({
  id: "proposta",
  nome: "Proposta",
  tipo: "macro",
  versao: 1,
  nos: [
    { id: "n1", tipo: "acao", acao: { tipo: "nota_interna", texto: "revisar" }, proximo: "n2" },
    { id: "n2", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "segue a proposta" } },
  ],
});

teste("INLINE recusa espera de 2 dias e manda pra fila NA MENSAGEM", () => {
  const m = motivoParaRecusarPuro(FLUXO_LONGO, CAP, LIM_INLINE, { modo: "inline" });
  assert.ok(m);
  assert.match(m!, /FILA/);
});

teste("FILA aceita a mesma espera de 2 dias (e o proposito dela)", () => {
  assert.equal(motivoParaRecusarPuro(FLUXO_LONGO, CAP, LIM_INLINE, { modo: "fila" }), null);
});

teste("GRAVE: INLINE recusa fluxo com passo de aprovacao — senao a aprovacao era contornavel", () => {
  const m = motivoParaRecusarPuro(FLUXO_COM_AVAL, CAP, LIM_INLINE, { modo: "inline" });
  assert.ok(m, "rodar inline um passo que exige aval mandaria a mensagem sem ninguem aprovar");
  assert.match(m!, /aprovacao humana/);
});

teste("FILA aceita fluxo com aprovacao (ela sabe parar e esperar)", () => {
  assert.equal(motivoParaRecusarPuro(FLUXO_COM_AVAL, CAP, LIM_INLINE, { modo: "fila" }), null);
});

teste("o modo DEFAULT e inline: chamador antigo (/api/macros) segue protegido sem mudar", () => {
  assert.equal(
    motivoParaRecusarPuro(FLUXO_COM_AVAL, CAP, LIM_INLINE),
    motivoParaRecusarPuro(FLUXO_COM_AVAL, CAP, LIM_INLINE, { modo: "inline" })
  );
});

teste("a FILA nao afrouxa as OUTRAS recusas: canal so-leitura continua barrando envio", () => {
  const m = motivoParaRecusarPuro(FLUXO_LONGO, { soLeitura: true, envioCabeado: true }, LIM_INLINE, {
    modo: "fila",
  });
  assert.match(m!, /somente leitura/);
});

teste("a FILA nao afrouxa 'envio nao configurado' (o relogio nao cria credencial)", () => {
  const m = motivoParaRecusarPuro(FLUXO_LONGO, { soLeitura: false, envioCabeado: false }, LIM_INLINE, {
    modo: "fila",
  });
  assert.match(m!, /envio nao configurado/);
});

teste("a FILA continua recusando fluxo de tipo gatilho (motor v2)", () => {
  const g = valido({ ...FLUXO_LONGO, id: "g", tipo: "gatilho" });
  assert.match(motivoParaRecusarPuro(g, CAP, LIM_INLINE, { modo: "fila" })!, /tipo macro/);
});

// ==================================== 3) O RELOGIO — atraso e fim de semana
console.log("\n3) RELOGIO — atraso, pular fim de semana e a virada do horario de verao");

// 2026-09-03 e uma QUINTA (UTC). Sabado = 05, domingo = 06, segunda = 07.
const QUINTA = Date.parse("2026-09-03T12:00:00.000Z");
const SEXTA = Date.parse("2026-09-04T10:00:00.000Z");

teste("atraso simples soma segundos e nao mexe em dia nenhum", () => {
  const r = relogioFake(QUINTA);
  assert.equal(instanteDoPasso(QUINTA, 3600, {}, r), QUINTA + 3_600_000);
});

teste("48h a partir de SEXTA cairiam no domingo — pular_fim_de_semana joga pra SEGUNDA", () => {
  const r = relogioFake(SEXTA);
  const semPular = instanteDoPasso(SEXTA, 48 * 3600, {}, r);
  assert.equal(new Date(semPular).getUTCDay(), 0, "sem a regra, cai no domingo");
  const pulando = instanteDoPasso(SEXTA, 48 * 3600, { pularFimDeSemana: true }, r);
  assert.equal(new Date(pulando).getUTCDay(), 1, "com a regra, cai na segunda");
  // a HORA DE PAREDE nao muda: o requisito e sobre o DIA
  assert.equal(new Date(pulando).getUTCHours(), new Date(semPular).getUTCHours());
});

teste("cair no SABADO tambem anda dois dias, ate a segunda", () => {
  const r = relogioFake(SEXTA);
  const t = instanteDoPasso(SEXTA, 24 * 3600, { pularFimDeSemana: true }, r);
  assert.equal(new Date(t).getUTCDay(), 1);
});

teste("atraso ZERO com pular_fim_de_semana ainda vale (passo de sabado vai pra segunda)", () => {
  const sabado = Date.parse("2026-09-05T09:00:00.000Z");
  const t = instanteDoPasso(sabado, 0, { pularFimDeSemana: true }, relogioFake(sabado));
  assert.equal(new Date(t).getUTCDay(), 1);
});

teste("dia util nao e empurrado por pular_fim_de_semana (a regra so tira sabado/domingo)", () => {
  const t = instanteDoPasso(QUINTA, 3600, { pularFimDeSemana: true }, relogioFake(QUINTA));
  assert.equal(t, QUINTA + 3_600_000);
});

teste("relogio TORTO (sempre sabado) nao vira laco infinito: o teto de 7 voltas corta", () => {
  const sempreSabado: RelogioFila = {
    agora: () => 0,
    diaSemana: () => 6,
    mesmaHoraNoDiaSeguinte: (ms) => ms + 86_400_000,
  };
  const t = pularFimDeSemana(1000, sempreSabado);
  assert.equal(t, 1000 + 7 * 86_400_000, "para depois de 7 tentativas em vez de travar o servidor");
});

// O RELOGIO DE VERDADE (lib/fluxo/fila-relogio.ts + lib/fuso.ts). Sao Paulo nao
// tem mais horario de verao; Nova York tem — e instalacao fora do Brasil e caso
// previsto pela REGRA Nº1 (nada assume o fuso de nenhuma empresa).
teste("relogio real: dia da semana sai no fuso da INSTALACAO, nao no do servidor", () => {
  // 2026-09-06T02:00Z e DOMINGO em UTC e ainda SABADO em Sao Paulo (UTC-3)
  const instante = Date.parse("2026-09-06T02:00:00.000Z");
  assert.equal(relogioDoFuso("America/Sao_Paulo").diaSemana(instante), 6, "sabado em Sao Paulo");
  assert.equal(new Date(instante).getUTCDay(), 0, "domingo em UTC");
});

teste("relogio real: pular um dia PRESERVA a hora de parede na virada do verao", () => {
  // Nova York entra no horario de verao em 08/03/2026 (2:00 -> 3:00).
  // 07/03 as 09:00 local + 1 dia tem que dar 08/03 as 09:00 LOCAL — e nao 08:00,
  // que e o que "somar 86.400.000ms" produziria.
  const fuso = "America/New_York";
  const r = relogioDoFuso(fuso);
  const antes = Date.parse("2026-03-07T14:00:00.000Z"); // 09:00 EST
  const depois = r.mesmaHoraNoDiaSeguinte(antes);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: fuso,
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  });
  const partes = Object.fromEntries(fmt.formatToParts(new Date(depois)).map((p) => [p.type, p.value]));
  assert.equal(partes.hour, "09", "a hora de parede tem que continuar 09");
  assert.equal(partes.day, "08");
  assert.notEqual(depois, antes + 86_400_000, "somar 24h aqui erraria em 1h");
});

teste("relogio real: virada de MES e de ANO nao quebram o +1 dia", () => {
  const r = relogioDoFuso("America/Sao_Paulo");
  const reveillon = Date.parse("2026-12-31T15:00:00.000Z"); // 12:00 BRT
  const dia = r.diaSemana(r.mesmaHoraNoDiaSeguinte(reveillon));
  assert.ok(dia >= 0 && dia <= 6);
  assert.equal(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(
      new Date(r.mesmaHoraNoDiaSeguinte(reveillon))
    ),
    "2027-01-01"
  );
});

// ================================ 4) AGENDAMENTO — a espera nao e executada
console.log("\n4) AGENDAMENTO — o no de espera e CONSUMIDO, nunca executado");

teste("primeiro passo de um fluxo que comeca com espera JA nasce com a hora marcada", () => {
  const f = valido(
    fluxoLinear({ id: "f", nome: "F" }, [
      { tipo: "espera", segundos: 86400 },
      { tipo: "enviar_texto", texto: "amanha" },
    ])
  );
  const p = proximoPasso(f, null, QUINTA, relogioFake(QUINTA))!;
  assert.equal(p.no_id, "n2", "a espera nao e um passo executavel: o primeiro passo e o que vem depois");
  assert.equal(p.disponivel_em, QUINTA + 86_400_000);
  assert.equal(p.esperou_segundos, 86400);
});

teste("esperas SEGUIDAS somam (regua importada empilha atraso)", () => {
  const f = valido(
    fluxoLinear({ id: "f", nome: "F" }, [
      { tipo: "espera", segundos: 3600 },
      { tipo: "espera", segundos: 1800 },
      { tipo: "nota_interna", texto: "x" },
    ])
  );
  const p = proximoPasso(f, null, QUINTA, relogioFake(QUINTA))!;
  assert.equal(p.esperou_segundos, 5400);
  assert.equal(p.disponivel_em, QUINTA + 5_400_000);
});

teste("passo sem espera antes fica disponivel AGORA", () => {
  const f = valido(
    fluxoLinear({ id: "f", nome: "F" }, [
      { tipo: "nota_interna", texto: "a" },
      { tipo: "enviar_texto", texto: "b" },
    ])
  );
  const p = proximoPasso(f, "n1", QUINTA, relogioFake(QUINTA))!;
  assert.equal(p.no_id, "n2");
  assert.equal(p.disponivel_em, QUINTA);
  assert.equal(p.esperou_segundos, 0);
});

teste("corrente que TERMINA em espera nao agenda nada (espera sozinha nao e efeito)", () => {
  const f = valido(
    fluxoLinear({ id: "f", nome: "F" }, [
      { tipo: "nota_interna", texto: "a" },
      { tipo: "espera", segundos: 60 },
    ])
  );
  assert.equal(proximoPasso(f, "n1", QUINTA, relogioFake(QUINTA)), null);
});

teste("fim da corrente devolve null", () => {
  const f = valido(fluxoLinear({ id: "f", nome: "F" }, [{ tipo: "nota_interna", texto: "a" }]));
  assert.equal(proximoPasso(f, "n1", QUINTA, relogioFake(QUINTA)), null);
});

teste("no que SAIU da corrente (fluxo editado no meio) encerra — nunca reinicia a corrente", () => {
  const f = valido(
    fluxoLinear({ id: "f", nome: "F" }, [
      { tipo: "enviar_texto", texto: "a" },
      { tipo: "enviar_texto", texto: "b" },
    ])
  );
  assert.equal(
    proximoPasso(f, "no-que-nao-existe-mais", QUINTA, relogioFake(QUINTA)),
    null,
    "recomecar aqui reenviaria a corrente inteira pro cliente"
  );
});

teste("espera de 30 dias (o teto do schema) cabe no agendamento sem perda", () => {
  const f = valido(
    fluxoLinear({ id: "f", nome: "F" }, [
      { tipo: "espera", segundos: LIMITE_ESPERA_SEG },
      { tipo: "nota_interna", texto: "x" },
    ])
  );
  const p = proximoPasso(f, null, QUINTA, relogioFake(QUINTA))!;
  assert.equal(p.disponivel_em, QUINTA + LIMITE_ESPERA_SEG * 1000);
});

teste("PASSO DESLIGADO: a cadeia passa por cima dele, e espera desligada nao atrasa", () => {
  const f = valido({
    id: "f",
    nome: "F",
    tipo: "macro",
    versao: 1,
    nos: [
      { id: "n1", tipo: "acao", acao: { tipo: "nota_interna", texto: "a" }, proximo: "n2" },
      { id: "n2", tipo: "espera", acao: { tipo: "espera", segundos: 86400 }, desligado: true, proximo: "n3" },
      { id: "n3", tipo: "acao", acao: { tipo: "enviar_texto", texto: "b" }, desligado: true, proximo: "n4" },
      { id: "n4", tipo: "acao", acao: { tipo: "enviar_texto", texto: "c" } },
    ],
  });
  const p = proximoPasso(f, "n1", QUINTA, relogioFake(QUINTA))!;
  assert.equal(p.no_id, "n4", "n2 e n3 estao desligados: o proximo passo e o n4");
  assert.equal(p.disponivel_em, QUINTA, "espera DESLIGADA nao marca hora nenhuma");
  assert.equal(p.esperou_segundos, 0);
});

teste("corrente que so tem passo desligado depois do atual: nada mais a agendar", () => {
  const f = valido({
    id: "f",
    nome: "F",
    tipo: "macro",
    versao: 1,
    nos: [
      { id: "n1", tipo: "acao", acao: { tipo: "nota_interna", texto: "a" }, proximo: "n2" },
      { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "b" }, desligado: true },
    ],
  });
  assert.equal(proximoPasso(f, "n1", QUINTA, relogioFake(QUINTA)), null);
});

teste("no de CONDICAO e passo executavel: ele nao e pulado no agendamento", () => {
  const f = valido({
    id: "f",
    nome: "F",
    tipo: "macro",
    versao: 1,
    nos: [
      { id: "n1", tipo: "acao", acao: { tipo: "nota_interna", texto: "a" }, proximo: "n2" },
      {
        id: "n2",
        tipo: "condicao",
        condicao: { tipo: "comparacao", campo: "status", operador: "igual", valor: "aberto" },
        proximo: "n3",
      },
      { id: "n3", tipo: "acao", acao: { tipo: "enviar_texto", texto: "b" } },
    ],
  });
  assert.equal(proximoPasso(f, "n1", QUINTA, relogioFake(QUINTA))!.no_id, "n2");
});

// ================================= 5) LIMITES POR CONVERSA (anti-repique)
console.log("\n5) LIMITES POR CONVERSA — maximo e anti-repique, os dois fail-closed");

const SEM_LIMITE = { maximo_por_conversa: null, intervalo_minimo_segundos: 0 };
const AGORA_L = Date.parse("2026-08-31T12:00:00.000Z");

teste("sem limite e sem cadeia viva: enfileira", () => {
  assert.equal(
    motivoParaNaoEnfileirar(SEM_LIMITE, { execucoes: 999, ultima_em: null, viva: false }, AGORA_L),
    null
  );
});

teste("CADEIA VIVA barra sempre — e o que impede a regua sair em dobro", () => {
  const m = motivoParaNaoEnfileirar(SEM_LIMITE, { execucoes: 0, ultima_em: null, viva: true }, AGORA_L);
  assert.match(m!, /ja esta em andamento/);
});

teste("maximo_por_conversa = 1 barra a segunda (a saudacao que roda uma vez)", () => {
  const lim = { maximo_por_conversa: 1, intervalo_minimo_segundos: 0 };
  assert.equal(motivoParaNaoEnfileirar(lim, { execucoes: 0, ultima_em: null, viva: false }, AGORA_L), null);
  assert.match(
    motivoParaNaoEnfileirar(lim, { execucoes: 1, ultima_em: null, viva: false }, AGORA_L)!,
    /limite de 1 execucao/
  );
});

teste("anti-repique de 5 min: dentro da janela barra e DIZ quantos segundos faltam", () => {
  const lim = { maximo_por_conversa: null, intervalo_minimo_segundos: 300 };
  const ha1min = new Date(AGORA_L - 60_000).toISOString();
  const m = motivoParaNaoEnfileirar(lim, { execucoes: 1, ultima_em: ha1min, viva: false }, AGORA_L);
  assert.match(m!, /faltam 240s/);
});

teste("anti-repique: passada a janela, libera", () => {
  const lim = { maximo_por_conversa: null, intervalo_minimo_segundos: 300 };
  const ha10min = new Date(AGORA_L - 600_000).toISOString();
  assert.equal(motivoParaNaoEnfileirar(lim, { execucoes: 1, ultima_em: ha10min, viva: false }, AGORA_L), null);
});

teste("FAIL-CLOSED: carimbo ilegivel NAO libera o anti-repique", () => {
  const lim = { maximo_por_conversa: null, intervalo_minimo_segundos: 300 };
  const m = motivoParaNaoEnfileirar(lim, { execucoes: 1, ultima_em: "isso nao e data", viva: false }, AGORA_L);
  assert.ok(m, "freio que falha aberto nao e freio");
  assert.match(m!, /falha FECHADO/);
});

teste("anti-repique DESLIGADO (0s) nao consulta carimbo nenhum", () => {
  assert.equal(
    motivoParaNaoEnfileirar(SEM_LIMITE, { execucoes: 5, ultima_em: "lixo", viva: false }, AGORA_L),
    null
  );
});

// O QUE O LIMITE CONTA. `historico` vem da TRILHA (execucoes que rodaram), nao da
// fila (enfileiramentos) — e a diferenca aparece nestes dois casos, que eram bug:
teste("CANCELAR antes do primeiro passo NAO queima a cota de maximo_por_conversa: 1", () => {
  const lim = { maximo_por_conversa: 1, intervalo_minimo_segundos: 0 };
  // a cadeia anterior existiu e foi cancelada: a trilha nao tem passo nenhum
  assert.equal(
    motivoParaNaoEnfileirar(lim, { execucoes: 0, ultima_em: null, viva: false }, AGORA_L),
    null,
    "contar enfileiramento fazia a saudacao nunca mais sair depois de um cancelamento"
  );
});

teste("o intervalo e medido do ULTIMO PASSO, nao do enfileiramento", () => {
  const lim = { maximo_por_conversa: null, intervalo_minimo_segundos: 3600 };
  // regua enfileirada ha 2 dias, mas cujo ultimo passo real rodou ha 1 minuto
  const ha1min = new Date(AGORA_L - 60_000).toISOString();
  const m = motivoParaNaoEnfileirar(lim, { execucoes: 1, ultima_em: ha1min, viva: false }, AGORA_L);
  assert.ok(m, "medir por criada_em daria o intervalo como cumprido antes de o passo rodar");
  assert.match(m!, /faltam 3540s/);
});

// ============================================ 6) APROVACAO — decisao POR PASSO
console.log("\n6) APROVACAO — a decisao vale pro PASSO, nunca pra cadeia");

const noAval: No = { id: "n2", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "x" } };
const noSemAval: No = { id: "n3", tipo: "acao", acao: { tipo: "enviar_texto", texto: "y" } };

/** carimbo de uma decisao: passo, veredito e a assinatura do conteudo aprovado */
const carimbo = (
  no_id: string | null,
  decisao: "aprovado" | "recusado" | null,
  assinatura: string | null = null
) => ({ aprovacao_no_id: no_id, aprovacao_decisao: decisao, aprovacao_assinatura: assinatura });

teste("passo sem aprovacao nunca para", () => {
  assert.equal(precisaAprovacao(noSemAval, carimbo(null, null)), false);
});

teste("passo com aprovacao e sem decisao para", () => {
  assert.equal(precisaAprovacao(noAval, carimbo(null, null)), true);
});

teste("aprovado NAQUELE passo e NAQUELE conteudo libera aquele passo", () => {
  assert.equal(precisaAprovacao(noAval, carimbo("n2", "aprovado", assinaturaDoNo(noAval))), false);
});

teste("GRAVE: aprovar o passo 2 NAO libera o passo 5 que tambem pede aval", () => {
  const n5: No = { id: "n5", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "z" } };
  assert.equal(
    precisaAprovacao(n5, carimbo("n2", "aprovado", assinaturaDoNo(noAval))),
    true,
    "senao um 'aprovar' liberaria em silencio todo o resto da regua"
  );
});

teste("decisao RECUSADA nao libera (a cadeia ja deveria estar parada, e o portao segura)", () => {
  assert.equal(precisaAprovacao(noAval, carimbo("n2", "recusado", assinaturaDoNo(noAval))), true);
});

// -------------------------------------------- a aprovacao carimba o CONTEUDO
//
// O defeito que isto fecha: aprovo "manda o orcamento de R$ 5.000", edito o texto
// do passo, e o que sai pro cliente e outra coisa com aval de ninguem. A decisao
// guarda a impressao digital do no; divergiu, pede aval de novo.

teste("GRAVE: EDITAR o passo depois de aprovado faz o portao pedir aval de novo", () => {
  const antes = assinaturaDoNo(noAval);
  const editado: No = { ...noAval, acao: { tipo: "enviar_texto", texto: "outro texto" } };
  assert.notEqual(assinaturaDoNo(editado), antes, "assinatura tem que mudar quando o texto muda");
  assert.equal(
    precisaAprovacao(editado, carimbo("n2", "aprovado", antes)),
    true,
    "aprovacao de um conteudo nao vale pro conteudo novo"
  );
  assert.match(motivoDaParadaParaAval(editado, carimbo("n2", "aprovado", antes)), /EDITADO/);
});

teste("assinatura AUSENTE conta como divergente (fail-closed)", () => {
  assert.equal(
    precisaAprovacao(noAval, carimbo("n2", "aprovado", null)),
    true,
    "decisao gravada por versao anterior nao pode liberar envio sem aval"
  );
});

teste("tirar a exigencia de aval TAMBEM muda a assinatura (nao e so o texto)", () => {
  const semExigencia: No = { ...noAval };
  delete (semExigencia as any).aprovacao;
  assert.notEqual(assinaturaDoNo(semExigencia), assinaturaDoNo(noAval));
});

teste("REORDENAR as chaves do jsonb NAO muda a assinatura (senao pediria aval a cada save)", () => {
  const a: No = { id: "n2", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "x" } };
  const b: any = { acao: { texto: "x", tipo: "enviar_texto" }, aprovacao: true, tipo: "acao", id: "n2" };
  assert.equal(assinaturaDoNo(a), assinaturaDoNo(b as No));
  assert.equal(jsonCanonico({ a: 1, b: [2, { d: 4, c: 3 }] }), jsonCanonico({ b: [2, { c: 3, d: 4 }] , a: 1 }));
});

teste("o motivo da parada distingue: primeira vez, editado, recusado antes, e SEM CARIMBO", () => {
  assert.match(motivoDaParadaParaAval(noAval, carimbo(null, null)), /exige aprovacao humana/);
  assert.match(motivoDaParadaParaAval(noAval, carimbo("n2", "recusado")), /recusada anteriormente/);
  // OS DOIS CASOS DE "aprovado mas a assinatura nao serve" NAO PODEM DAR A MESMA
  // FRASE: sem carimbo nenhum, ninguem editou nada — dizer "o passo foi editado"
  // manda o supervisor procurar um culpado que nao existe.
  const semCarimbo = motivoDaParadaParaAval(noAval, carimbo("n2", "aprovado", null));
  assert.match(semCarimbo, /antes desta atualizacao/);
  assert.equal(/EDITADO/.test(semCarimbo), false, "sem assinatura nao e edicao");
  const editado: No = { ...noAval, acao: { tipo: "enviar_texto", texto: "outro" } };
  assert.match(motivoDaParadaParaAval(editado, carimbo("n2", "aprovado", assinaturaDoNo(noAval))), /EDITADO/);
});

// ------------------- APROVACAO SO VALE ONDE A ACAO ALCANCA O CLIENTE
//
// Medido na importacao: 796 dos 837 nos com aval eram NOTA INTERNA, e honrar todos
// matava 631 macros que rodam num clique. Aprovar existe pra conferir o que SAI;
// nota, etiqueta, status e funil sao internos e reversiveis. A regra vale nos DOIS
// caminhos (inline e fila) — regra honrada num e ignorada no outro e pior que as
// duas escolhas.
const noAvalInterno: No = {
  id: "n2",
  tipo: "acao",
  aprovacao: true,
  acao: { tipo: "nota_interna", texto: "conferir" },
};

// FRENTE W (31/08/2026): `anexar_biblioteca` entrou na lista, e ela e a razao pela
// qual a lista existe — mandar ARQUIVO pro cliente e o passo mais irreversivel do
// motor (tabela de preco velha, contrato errado, foto do cliente errado). Se a
// acao ficasse fora, o `aprovacao: true` que o dono do fluxo marcou seria IGNORADO
// nos dois caminhos (a fila deixaria passar e o inline aceitaria rodar sem gente).
// A prova nao confere so a lista: confere o COMPORTAMENTO dos dois lados.
const noAvalAnexo: No = {
  id: "n4",
  tipo: "acao",
  aprovacao: true,
  acao: { tipo: "anexar_biblioteca", anexo: "tabela-precos" },
};

teste("a lista de acoes que alcancam o cliente e a fonte unica (enviar_texto, anexar_biblioteca, perguntar_opcoes)", () => {
  // FRENTE Y (31/08/2026): `perguntar_opcoes` entrou na lista porque a pergunta
  // CHEGA no celular do cliente — logo o aval humano vale nela e o modo inline
  // recusa fluxo que pede aprovacao num passo desses. A assercao continua fixando
  // a lista INTEIRA de proposito: e ela que decide onde a aprovacao morde, e uma
  // acao nova entrando aqui sem ninguem pensar mudaria o portao em silencio.
  assert.deepEqual([...ACOES_QUE_ALCANCAM_CLIENTE], ["enviar_texto", "anexar_biblioteca", "perguntar_opcoes"]);
  assert.equal(alcancaCliente(noAval), true);
  assert.equal(alcancaCliente(noAvalAnexo), true);
  assert.equal(alcancaCliente(noAvalInterno), false);
});

teste("aval em ANEXAR_BIBLIOTECA para a cadeia (arquivo pro cliente e o passo menos reversivel)", () => {
  assert.equal(precisaAprovacao(noAvalAnexo, carimbo(null, null)), true);
});

teste("INLINE recusa aval em ANEXAR_BIBLIOTECA (nao existe aprovar sem fila)", () => {
  const comAvalAnexo = valido({
    id: "so-anexo",
    nome: "Anexo com aval",
    tipo: "macro",
    versao: 1,
    nos: [{ id: "n1", tipo: "acao", aprovacao: true, acao: { tipo: "anexar_biblioteca", anexo: "tabela-precos" } }],
  });
  assert.match(
    String(motivoParaRecusarPuro(comAvalAnexo, CAP, LIM_INLINE, { modo: "inline" })),
    /aprova/i
  );
});

teste("aval em NOTA INTERNA nao para a cadeia (nada sai pro cliente ali)", () => {
  assert.equal(precisaAprovacao(noAvalInterno, carimbo(null, null)), false);
});

teste("aval em ENVIAR_TEXTO para, sempre (os avais que importam continuam valendo)", () => {
  assert.equal(precisaAprovacao(noAval, carimbo(null, null)), true);
});

teste("INLINE recusa aval em mensagem, NAO recusa aval em passo interno", () => {
  const comAvalInterno = valido({
    id: "so-nota",
    nome: "Nota com aval",
    tipo: "macro",
    versao: 1,
    nos: [{ id: "n1", tipo: "acao", aprovacao: true, acao: { tipo: "nota_interna", texto: "x" } }],
  });
  assert.equal(
    motivoParaRecusarPuro(comAvalInterno, CAP, LIM_INLINE, { modo: "inline" }),
    null,
    "eram 631 macros importados mortos por um checkbox em nota interna"
  );
  assert.ok(
    motivoParaRecusarPuro(FLUXO_COM_AVAL, CAP, LIM_INLINE, { modo: "inline" }),
    "aval em mensagem pro cliente segue barrando o inline"
  );
});

teste("nosComAprovacao mostra o CAMPO; nosComAvalQueImporta mostra o que BLOQUEIA", () => {
  const misto = valido({
    id: "misto",
    nome: "Misto",
    tipo: "macro",
    versao: 1,
    nos: [
      { id: "n1", tipo: "acao", aprovacao: true, acao: { tipo: "nota_interna", texto: "x" }, proximo: "n2" },
      { id: "n2", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "y" } },
    ],
  });
  assert.deepEqual(nosComAprovacao(misto), ["n1", "n2"], "o campo gravado nao e apagado do fluxo");
  assert.deepEqual(nosComAvalQueImporta(misto), ["n2"], "so o passo que fala com o cliente bloqueia");
});

// ================================== 7) ESTADO — vocabulario e interrupcao
console.log("\n7) ESTADO da cadeia — interrupcao e reserva orfa");

teste("os 7 estados sao os 7, e ESTADOS_VIVOS e subconjunto deles", () => {
  assert.equal(ESTADOS_FILA.length, 7);
  for (const e of ESTADOS_VIVOS) assert.ok((ESTADOS_FILA as readonly string[]).includes(e));
  assert.equal(estadoFilaValido("agendado"), true);
  assert.equal(estadoFilaValido("qualquer coisa"), false);
});

teste("agendado/executando seguem; cancelado, recusado, concluido e falhou PARAM", () => {
  assert.equal(deveInterromper("agendado").parar, false);
  assert.equal(deveInterromper("executando").parar, false);
  for (const e of ["cancelado", "recusado", "concluido", "falhou", "aguardando_aprovacao"]) {
    assert.equal(deveInterromper(e).parar, true, `${e} tem que parar`);
    assert.ok(deveInterromper(e).motivo, `${e} tem que dizer por que`);
  }
});

teste("estado desconhecido PARA (fail-closed) em vez de seguir enviando", () => {
  const d = deveInterromper("estadoInventado");
  assert.equal(d.parar, true);
  assert.match(d.motivo!, /desconhecido/);
});

teste("reserva SEM carimbo conta como orfa (reserva sem carimbo e reserva podre)", () => {
  assert.equal(reservaExpirada(null, Date.now()), true);
  assert.equal(reservaExpirada("nao sou data", Date.now()), true);
});

teste("reserva recente NAO e orfa; reserva velha e", () => {
  const agora = Date.now();
  assert.equal(reservaExpirada(new Date(agora - 1000).toISOString(), agora), false);
  assert.equal(reservaExpirada(new Date(agora - 10 * 60_000).toISOString(), agora), true);
});

// ============================== 8) O TICK — a corrida entre dois ticks
//
// A porta abaixo e um banco EM MEMORIA que honra o mesmo contrato do Postgres:
// `reservar` faz check-and-set SEM await no meio, exatamente como um
// `update ... where id=? and estado='agendado'` — quem chegar depois nao pega
// nada. Os dois ticks rodam concorrentes de verdade (Promise.all) e se intercalam
// nos await de execucao.
console.log("\n8) TICK — claim atomico, fila por conversa, interrupcao e retry");

type LinhaFila = {
  id: string;
  execucao_id: string;
  fluxo_slug: string;
  canal: string;
  chat_id: string;
  no_id: string;
  estado: string;
  disponivel_em: number;
  origem: "manual" | "gatilho";
  tentativas: number;
  reservado_em: string | null;
  aprovacao_no_id: string | null;
  aprovacao_decisao: "aprovado" | "recusado" | null;
  aprovacao_assinatura: string | null;
  erro: string | null;
  ordem: number;
  /**
   * `fluxo_fila.atualizada_em` — a coluna pela qual a fiacao ordena as paradas em
   * aval (`.order("atualizada_em", { ascending: true })`). Ela existe aqui porque
   * FAKE DESALINHADO DA FIACAO E PROVA QUE NAO PROVA: o fake ordenava por
   * canal/chat_id e a consulta de verdade ordena por hora de atualizacao, entao
   * qualquer teste sobre QUEM a passada de aval pega primeiro media a ordem errada
   * (apontado na re-revisao de 31/08/2026). Vem do `ordem` por default, ou seja a
   * ordem de insercao — que e o que uma fila real produz.
   */
  atualizada_em: number;
};

const FLUXO_TICK = valido(
  fluxoLinear({ id: "regua", nome: "Regua" }, [
    { tipo: "enviar_texto", texto: "1" },
    { tipo: "enviar_texto", texto: "2" },
    { tipo: "enviar_texto", texto: "3" },
  ])
);

function criarBanco(
  cadeias: { chat: string; canal?: string; no?: string; em?: number; fluxo?: string; atualizada?: number }[]
) {
  let n = 0;
  const linhas: LinhaFila[] = cadeias.map((c) => ({
    id: `i${++n}`,
    execucao_id: `e${n}`,
    fluxo_slug: c.fluxo ?? "regua",
    canal: c.canal ?? "central",
    chat_id: c.chat,
    no_id: c.no ?? "n1",
    estado: "agendado",
    disponivel_em: c.em ?? 0,
    origem: "gatilho",
    tentativas: 0,
    reservado_em: null,
    aprovacao_no_id: null,
    aprovacao_decisao: null,
    aprovacao_assinatura: null,
    erro: null,
    ordem: n,
    atualizada_em: c.atualizada ?? n,
  }));
  return {
    linhas,
    fluxos: new Map<string, { fluxo: Fluxo; ativo: boolean }>([["regua", { fluxo: FLUXO_TICK, ativo: true }]]),
    /** quantas vezes CADA (item, no) foi realmente executado */
    execucoes: new Map<string, number>(),
    // a trilha e `fluxo_execucoes`: e ELA que responde "este passo desta execucao
    // ja rodou?" (idempotencia). Por isso guarda `exec`, nao so o id do item.
    trilha: [] as { item: string; exec: string; no: string; status: string }[],
  };
}
type Banco = ReturnType<typeof criarBanco>;

function criarPorta(
  banco: Banco,
  extra: {
    resultado?: (item: ItemFila, no: No) => ResultadoNoFila;
    duranteExecucao?: () => void;
    agora?: () => number;
    /** simula uma PISCADA do banco na releitura do estado (nao e cancelamento) */
    falharLeituraDeEstado?: boolean;
  } = {}
): PortaFila {
  const relogio: RelogioFila = {
    agora: extra.agora ?? (() => Date.now()),
    diaSemana: (ms) => new Date(ms).getUTCDay(),
    mesmaHoraNoDiaSeguinte: (ms) => ms + 86_400_000,
  };
  const paraItem = (l: LinhaFila): ItemFila => ({
    id: l.id,
    execucao_id: l.execucao_id,
    fluxo_slug: l.fluxo_slug,
    canal: l.canal,
    chat_id: l.chat_id,
    no_id: l.no_id,
    estado: l.estado as any,
    disponivel_em: new Date(l.disponivel_em).toISOString(),
    origem: l.origem,
    usuario_id: null,
    usuario_nome: "automacao",
    tentativas: l.tentativas,
    reservado_em: l.reservado_em,
    aprovacao_no_id: l.aprovacao_no_id,
    aprovacao_decisao: l.aprovacao_decisao,
    aprovacao_assinatura: l.aprovacao_assinatura,
    fluxo_id: null,
    // a fiacao le `atualizada_em` da linha (ISO); e o carimbo que a expiracao de
    // aval compara com o relogio
    atualizada_em: new Date(l.atualizada_em).toISOString(),
  });

  return {
    async candidatos(limite) {
      // MESMA ORDEM do SQL da fiacao: disponivel_em PRIMEIRO, depois canal,
      // chat_id, criada_em. A hora vem na frente porque a fila e FIFO por HORA:
      // ordenar por canal antes fazia a fila atender por ordem alfabetica de
      // conversa, e com fila maior que o teto da rodada o passo das 08:00 de um
      // chat "z..." podia nao rodar nunca. O resto da ordem existe pro desempate
      // ser TOTAL — e e isso que faz dois ticks colidirem no mesmo item.
      return banco.linhas
        .filter((l) => l.estado === "agendado" && l.disponivel_em <= relogio.agora())
        .sort(
          (a, b) =>
            a.disponivel_em - b.disponivel_em ||
            a.canal.localeCompare(b.canal) ||
            a.chat_id.localeCompare(b.chat_id) ||
            a.ordem - b.ordem
        )
        .slice(0, limite)
        .map(paraItem);
    },

    // As cadeias PARADAS em aval. Sem filtro de hora de DISPONIBILIDADE: elas nao
    // esperam hora, esperam gente.
    //
    // MESMA ORDEM DA FIACAO: `atualizada_em` ASC primeiro, depois canal e chat_id
    // (fila-db.ts, `candidatosAguardandoAval`). A ordem aqui NAO e detalhe de
    // fixture: a janela e `limite = teto * 2`, entao e ela que decide QUEM entra na
    // janela quando ha mais paradas que o teto — a mais ANTIGA primeiro, que e a
    // que esta esperando ha mais tempo. O fake ordenava por canal/chat_id, ou seja
    // media a ordem ALFABETICA da conversa: o defeito exato que a ordem da consulta
    // de candidatos existe pra nao ter (secao FIFO POR HORA). Desalinhamento
    // apontado na re-revisao de 31/08/2026; a guarda de FONTE na secao 11 e o que
    // impede as duas pontas de divergirem de novo.
    async candidatosAguardandoAval(limite) {
      return banco.linhas
        .filter((l) => l.estado === "aguardando_aprovacao")
        .sort(
          (a, b) =>
            a.atualizada_em - b.atualizada_em ||
            a.canal.localeCompare(b.canal) ||
            a.chat_id.localeCompare(b.chat_id)
        )
        .slice(0, limite)
        .map(paraItem);
    },

    async reservarAguardandoAval(item) {
      // o estado de PARTIDA e a trava: decisao humana na janela vence
      const l = banco.linhas.find((x) => x.id === item.id && x.estado === "aguardando_aprovacao");
      if (!l) return null;
      l.estado = "executando";
      l.reservado_em = relogio.agora();
      // TODO update de estado da fiacao carimba `atualizada_em` (fila-db.ts) — e e
      // essa coluna que ordena a janela das paradas em aval
      l.atualizada_em = relogio.agora();
      return paraItem(l);
    },
    async reservar(item) {
      // CHECK-AND-SET sem await no meio = o mesmo contrato do update condicional
      const l = banco.linhas.find((x) => x.id === item.id);
      if (!l || l.estado !== "agendado") return null;
      l.estado = "executando";
      l.reservado_em = new Date().toISOString();
      l.atualizada_em = relogio.agora();
      return paraItem(l);
    },
    async carregarFluxo(slug) {
      return banco.fluxos.get(slug) ?? null;
    },
    async estadoAtual(item) {
      // PISCADA DO BANCO != CANCELAMENTO. O erro de leitura tem caso proprio: nada
      // executa e o carimbo da reserva FICA de pe (a varredura de orfas retoma).
      if (extra.falharLeituraDeEstado) return { ok: false, erro: "conexao caiu" };
      const l = banco.linhas.find((x) => x.id === item.id);
      // linha que desapareceu e um fato conhecido: nao existe mais, para.
      return { ok: true, estado: l?.estado ?? "cancelado" };
    },
    async jaExecutado(item, no) {
      return banco.trilha.some((t) => t.exec === item.execucao_id && t.no === no.id && t.status === "ok");
    },
    async executarNo(item, no) {
      // ponto de intercalacao real entre os dois ticks
      await new Promise((r) => setTimeout(r, 1));
      extra.duranteExecucao?.();
      const chave = `${item.id}:${no.id}`;
      banco.execucoes.set(chave, (banco.execucoes.get(chave) || 0) + 1);
      return extra.resultado
        ? extra.resultado(item, no)
        : { status: "ok", acao: no.acao?.tipo ?? no.tipo, detalhe: "feito" };
    },
    async registrarPasso(item, no, r) {
      banco.trilha.push({ item: item.id, exec: item.execucao_id, no: no.id, status: r.status });
    },
    async pararParaAprovacao(item, no, motivo) {
      const l = banco.linhas.find((x) => x.id === item.id)!;
      if (l.estado !== "executando") return;
      l.estado = "aguardando_aprovacao";
      l.aprovacao_no_id = no.id;
      // decisao E assinatura antigas saem juntas: a decisao vale por passo E por
      // conteudo, e um "aprovado" residual liberaria este passo sem ninguem olhar
      l.aprovacao_decisao = null;
      l.aprovacao_assinatura = null;
      l.erro = motivo;
      l.reservado_em = null;
      l.atualizada_em = relogio.agora();
      banco.trilha.push({ item: item.id, exec: item.execucao_id, no: no.id, status: "pulado" });
    },
    async agendar(item, prox) {
      const l = banco.linhas.find((x) => x.id === item.id)!;
      if (l.estado !== "executando") return;
      l.no_id = prox.no_id;
      l.estado = "agendado";
      l.disponivel_em = prox.disponivel_em;
      l.tentativas = 0;
      l.reservado_em = null;
      l.erro = null;
      l.atualizada_em = relogio.agora();
    },
    async encerrar(item, estado, motivo) {
      const l = banco.linhas.find((x) => x.id === item.id)!;
      if (l.estado !== "executando") return; // GUARDA DE ESTADO
      l.estado = estado;
      l.erro = motivo;
      l.reservado_em = null;
      l.atualizada_em = relogio.agora();
    },
    async reagendarPorFalha(item, tentativas, erro, quando) {
      const l = banco.linhas.find((x) => x.id === item.id)!;
      if (l.estado !== "executando") return;
      l.estado = "agendado";
      l.tentativas = tentativas;
      l.erro = erro;
      l.disponivel_em = quando;
      l.reservado_em = null;
      l.atualizada_em = relogio.agora();
    },
    async devolverReserva(item, opcoes) {
      const l = banco.linhas.find((x) => x.id === item.id)!;
      if (l.estado !== "executando") return;
      // `limparCarimbo: false` = erro de LEITURA: o carimbo tem que ficar de pe,
      // senao a linha fica `executando` com `reservado_em` nulo pra sempre (o
      // varredor de orfas so olhava carimbo VELHO, nao nulo) e a regua congela.
      if (opcoes.limparCarimbo) l.reservado_em = null;
    },
    relogio,
  };
}

await (async () => {
  // ------------------------------------------------- a corrida propriamente dita
  {
    const banco = criarBanco([{ chat: "c1" }, { chat: "c2" }, { chat: "c3" }, { chat: "c4" }]);
    const [a, b] = await Promise.all([
      executarTickFila(criarPorta(banco), { passos: 10 }),
      executarTickFila(criarPorta(banco), { passos: 10 }),
    ]);

    await testeAsync("CORRIDA: nenhum passo e executado duas vezes", async () => {
      const dobrados = [...banco.execucoes.entries()].filter(([, n]) => n > 1);
      assert.deepEqual(dobrados, [], `passos executados mais de uma vez: ${JSON.stringify(dobrados)}`);
    });

    await testeAsync("CORRIDA: as 4 conversas andaram exatamente um passo, somando os dois ticks", async () => {
      assert.equal(a.passos + b.passos, 4);
      assert.equal(banco.linhas.filter((l) => l.no_id === "n2").length, 4);
    });

    await testeAsync("CORRIDA: quem perdeu o claim contabiliza a perda e nao executa", async () => {
      assert.ok(a.perdidos + b.perdidos > 0, "com 2 ticks na mesma fila alguem tem que perder claim");
    });

    await testeAsync("CORRIDA: nenhuma linha fica presa em 'executando'", async () => {
      assert.equal(banco.linhas.filter((l) => l.estado === "executando").length, 0);
    });
  }

  // ------------------------------------------------------- fila POR CONVERSA
  {
    // duas cadeias na MESMA conversa: so uma anda por rodada, e e a mais antiga
    const banco = criarBanco([{ chat: "c1" }, { chat: "c1" }]);
    const r = await executarTickFila(criarPorta(banco), { passos: 10 });

    await testeAsync("FILA POR CONVERSA: dois passos da mesma conversa nao rodam na mesma rodada", async () => {
      assert.equal(r.passos, 1);
      assert.equal(r.conversas_ocupadas, 1);
    });

    await testeAsync("FILA POR CONVERSA: a mais ANTIGA anda primeiro (ordem deterministica)", async () => {
      assert.equal(banco.linhas[0].no_id, "n2", "a cadeia i1 e a que devia andar");
      assert.equal(banco.linhas[1].no_id, "n1");
    });
  }

  {
    // dois ticks + duas cadeias na MESMA conversa: quem PERDE o claim nao pode
    // pular pra segunda cadeia daquela conversa
    const banco = criarBanco([{ chat: "c1" }, { chat: "c1" }]);
    const [a, b] = await Promise.all([
      executarTickFila(criarPorta(banco), { passos: 10 }),
      executarTickFila(criarPorta(banco), { passos: 10 }),
    ]);
    await testeAsync("FILA POR CONVERSA sob corrida: o tick que perdeu NAO pega a 2a cadeia da conversa", async () => {
      assert.equal(a.passos + b.passos, 1, "a conversa toda anda um passo por rodada, mesmo com 2 ticks");
      assert.equal(a.perdidos + b.perdidos, 1);
    });
  }

  // ------------------------------- passo DESLIGADO depois de a cadeia ser agendada
  {
    // A cadeia esta parada no n2 e alguem desliga o n2 pela listagem. O passo NAO
    // roda e a cadeia SEGUE: desligar um aviso do meio da regua quer dizer "nao
    // faca este", nunca "cancele o resto" — que e o que aconteceria se isso
    // caisse no ramo de "passo fora da corrente" (que encerra como falha).
    const banco = criarBanco([{ chat: "c1", no: "n2" }]);
    const comDesligado = valido({
      id: "regua",
      nome: "Regua",
      tipo: "macro",
      versao: 1,
      nos: [
        { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "1" }, proximo: "n2" },
        { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "2" }, desligado: true, proximo: "n3" },
        { id: "n3", tipo: "acao", acao: { tipo: "enviar_texto", texto: "3" } },
      ],
    });
    banco.fluxos.set("regua", { fluxo: comDesligado, ativo: true });
    const r = await executarTickFila(criarPorta(banco), { passos: 10 });

    await testeAsync("TICK: passo desligado no meio da regua nao executa e nao derruba a cadeia", async () => {
      assert.equal(r.passos, 0, "nenhum efeito saiu neste tick");
      assert.equal(banco.execucoes.size, 0, "e o passo desligado nao foi executado");
      assert.equal(banco.linhas[0].estado, "agendado", "a cadeia continua viva");
      assert.equal(banco.linhas[0].no_id, "n3", "e avancou pro passo seguinte");
    });

    await testeAsync("TICK: o pulo vai pra trilha como `pulado` (nunca como `ok`)", async () => {
      assert.deepEqual(
        banco.trilha.map((t) => `${t.no}:${t.status}`),
        ["n2:pulado"],
        "gravar `ok` faria a idempotencia tratar passo religado como ja executado"
      );
    });

    await testeAsync("TICK: religar o passo depois nao e barrado pela trilha do pulo", async () => {
      // a idempotencia so conta linha `ok` — e por isso o passo religado ainda roda
      assert.equal(
        banco.trilha.some((t) => t.status === "ok"),
        false
      );
    });
  }

  {
    // ULTIMO passo desligado: a cadeia CONCLUI (nao fica presa esperando um passo
    // que nunca vai rodar)
    const banco = criarBanco([{ chat: "c1", no: "n3" }]);
    banco.fluxos.set("regua", {
      fluxo: valido({
        id: "regua",
        nome: "Regua",
        tipo: "macro",
        versao: 1,
        nos: [
          { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "1" }, proximo: "n2" },
          { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "2" }, proximo: "n3" },
          { id: "n3", tipo: "acao", acao: { tipo: "enviar_texto", texto: "3" }, desligado: true },
        ],
      }),
      ativo: true,
    });
    await executarTickFila(criarPorta(banco), { passos: 10 });
    await testeAsync("TICK: ultimo passo desligado ENCERRA a cadeia (nao fica presa)", async () => {
      assert.equal(banco.linhas[0].estado, "concluido");
    });
  }

  // ------------------------------------------------------------- ate o fim
  {
    const banco = criarBanco([{ chat: "c1" }]);
    for (let i = 0; i < 5; i++) await executarTickFila(criarPorta(banco), { passos: 10 });
    await testeAsync("a cadeia caminha n1 -> n2 -> n3 e CONCLUI (um passo por rodada)", async () => {
      assert.equal(banco.linhas[0].estado, "concluido");
      assert.deepEqual(
        banco.trilha.map((t) => t.no),
        ["n1", "n2", "n3"]
      );
    });
  }

  // ------------------------------------------------------------ interrupcao
  {
    const banco = criarBanco([{ chat: "c1" }]);
    // cancelado ENTRE a leitura dos candidatos e o claim: o claim falha
    const porta = criarPorta(banco);
    const original = porta.candidatos.bind(porta);
    porta.candidatos = async (n) => {
      const lista = await original(n);
      banco.linhas[0].estado = "cancelado";
      return lista;
    };
    const r = await executarTickFila(porta, { passos: 10 });
    await testeAsync("INTERRUPCAO: cancelar antes do claim faz o tick nao executar nada", async () => {
      assert.equal(r.passos, 0);
      assert.equal(r.perdidos, 1);
      assert.equal(banco.linhas[0].estado, "cancelado");
    });
  }

  {
    const banco = criarBanco([{ chat: "c1" }]);
    // cancelado DEPOIS do claim, antes de executar: a releitura de estado pega
    const porta = criarPorta(banco);
    const originalReservar = porta.reservar.bind(porta);
    porta.reservar = async (item) => {
      const meu = await originalReservar(item);
      if (meu) banco.linhas[0].estado = "cancelado";
      return meu;
    };
    const r = await executarTickFila(porta, { passos: 10 });
    await testeAsync("INTERRUPCAO: cancelar DEPOIS do claim tambem para (o estado e relido)", async () => {
      assert.equal(r.passos, 0);
      assert.equal(r.interrompidos, 1);
      assert.match(r.motivo!, /cancelada/);
      assert.equal(banco.linhas[0].estado, "cancelado", "o cancelamento nao e sobrescrito");
    });
  }

  // ------------------------------------------------------------- aprovacao
  {
    const fluxoAval = valido({
      id: "regua",
      nome: "Com aval",
      tipo: "macro",
      versao: 1,
      nos: [
        { id: "n1", tipo: "acao", acao: { tipo: "nota_interna", texto: "revisar" }, proximo: "n2" },
        { id: "n2", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "proposta" } },
      ],
    });
    const banco = criarBanco([{ chat: "c1" }]);
    banco.fluxos.set("regua", { fluxo: fluxoAval, ativo: true });

    await executarTickFila(criarPorta(banco), { passos: 10 });
    await executarTickFila(criarPorta(banco), { passos: 10 });

    await testeAsync("APROVACAO: a cadeia PARA no passo que pede aval, sem executar a acao", async () => {
      assert.equal(banco.linhas[0].estado, "aguardando_aprovacao");
      assert.equal(banco.linhas[0].aprovacao_no_id, "n2");
      assert.equal(banco.execucoes.get("i1:n2"), undefined, "a mensagem NAO saiu");
    });

    await testeAsync("APROVACAO: um tick novo nao ressuscita a cadeia parada esperando aval", async () => {
      const r = await executarTickFila(criarPorta(banco), { passos: 10 });
      assert.equal(r.passos, 0);
      assert.equal(banco.execucoes.get("i1:n2"), undefined);
    });

    await testeAsync("APROVACAO sem ASSINATURA nao libera: a cadeia volta a esperar aval", async () => {
      // decisao gravada por uma versao anterior (sem carimbo de conteudo). Podia ser
      // tambem "nao deu pra calcular a assinatura" — o efeito e o mesmo, de proposito.
      banco.linhas[0].estado = "agendado";
      banco.linhas[0].aprovacao_decisao = "aprovado";
      banco.linhas[0].aprovacao_assinatura = null;
      banco.linhas[0].disponivel_em = 0;
      const r = await executarTickFila(criarPorta(banco), { passos: 10 });
      assert.equal(r.passos, 0, "fail-closed: sem carimbo de conteudo, nada sai");
      assert.equal(banco.execucoes.get("i1:n2"), undefined);
      assert.equal(banco.linhas[0].estado, "aguardando_aprovacao");
    });

    // ---------------------------------------------------------------------
    // DESLIGAR O PASSO SOLTA A REGUA PARADA NELE (defeito da revisao cega de
    // 31/08/2026): `deveInterromper("aguardando_aprovacao")` manda PARAR — e esta
    // certo — entao o ramo do passo desligado nunca alcancava quem estava
    // bloqueado. Quem desliga um passo esta dizendo "nao faca este"; a cadeia
    // ficava esperando uma aprovacao que ninguem mais quer dar, e o unico jeito de
    // solta-la era APROVAR o passo que acabou de ser desligado.
    await testeAsync("AVAL + DESLIGADO: desligar o passo LIBERA a cadeia parada nele", async () => {
      const fluxo = valido({
        id: "regua-aval-off",
        nome: "R",
        tipo: "macro",
        versao: 1,
        nos: [
          { id: "n1", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "proposta" }, proximo: "n2" },
          { id: "n2", tipo: "acao", acao: { tipo: "nota_interna", texto: "depois" } },
        ],
      });
      const b = criarBanco([{ chat: "c9", fluxo: "regua-aval-off", no: "n1" }]);
      b.fluxos.set("regua-aval-off", { fluxo, ativo: true });

      await executarTickFila(criarPorta(b), { passos: 10 });
      assert.equal(b.linhas[0].estado, "aguardando_aprovacao", "primeiro para no aval");
      assert.equal(b.execucoes.get("i1:n1"), undefined, "e a mensagem nao saiu");

      // agora alguem desliga o passo pela listagem
      const desligado = valido({
        ...fluxo,
        nos: [{ ...fluxo.nos[0], desligado: true }, fluxo.nos[1]],
      });
      b.fluxos.set("regua-aval-off", { fluxo: desligado, ativo: true });

      const r = await executarTickFila(criarPorta(b), { passos: 10 });
      assert.equal(r.liberadas_de_aval, 1, "a cadeia foi liberada");
      assert.equal(b.execucoes.get("i1:n1"), undefined, "SEM enviar a mensagem que estava esperando aval");
      // TODAS as linhas de n1 sao `pulado` — e a contagem importa: `pararParaAprovacao`
      // ja grava uma, entao olhar so a PRIMEIRA nao enxergaria a linha da liberacao
      // (foi assim que a mutacao "status ok na liberacao" passou cega na 1a rodada)
      const deN1 = b.trilha.filter((t) => t.no === "n1");
      assert.equal(deN1.length, 2, "a parada pro aval e a liberacao, cada uma com sua linha");
      assert.ok(deN1.every((t) => t.status === "pulado"), "nenhuma delas conta como envio (senao queima cota)");
      assert.equal(b.linhas[0].no_id, "n2", "e a cadeia avancou pro passo seguinte");
      assert.equal(b.linhas[0].estado, "agendado");
    });

    await testeAsync("AVAL + DESLIGADO: se era o ULTIMO passo, a cadeia encerra", async () => {
      const fluxo = valido({
        id: "so-aval",
        nome: "R",
        tipo: "macro",
        versao: 1,
        nos: [
          { id: "n1", tipo: "acao", acao: { tipo: "nota_interna", texto: "antes" }, proximo: "n2" },
          { id: "n2", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "fim" } },
        ],
      });
      const b = criarBanco([{ chat: "c10", fluxo: "so-aval" }]);
      b.fluxos.set("so-aval", { fluxo, ativo: true });
      await executarTickFila(criarPorta(b), { passos: 10 });
      await executarTickFila(criarPorta(b), { passos: 10 });
      assert.equal(b.linhas[0].estado, "aguardando_aprovacao");

      b.fluxos.set("so-aval", {
        fluxo: valido({ ...fluxo, nos: [fluxo.nos[0], { ...fluxo.nos[1], desligado: true }] }),
        ativo: true,
      });
      const r = await executarTickFila(criarPorta(b), { passos: 10 });
      assert.equal(r.concluidas, 1);
      assert.equal(b.linhas[0].estado, "concluido");
      assert.equal(b.execucoes.get("i1:n2"), undefined, "e a mensagem nunca saiu");
    });

    await testeAsync("AVAL LIGADO nao e tocado: o tick nao atropela decisao humana pendente", async () => {
      const fluxo = valido({
        id: "aval-vivo",
        nome: "R",
        tipo: "macro",
        versao: 1,
        nos: [{ id: "n1", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "x" } }],
      });
      const b = criarBanco([{ chat: "c11", fluxo: "aval-vivo" }]);
      b.fluxos.set("aval-vivo", { fluxo, ativo: true });
      await executarTickFila(criarPorta(b), { passos: 10 });
      assert.equal(b.linhas[0].estado, "aguardando_aprovacao");

      const r = await executarTickFila(criarPorta(b), { passos: 10 });
      assert.equal(r.liberadas_de_aval, 0, "passo ligado: a passada de liberacao nao mexe");
      assert.equal(b.linhas[0].estado, "aguardando_aprovacao", "continua esperando gente");
      assert.equal(b.execucoes.get("i1:n1"), undefined);
    });

    await testeAsync("AVAL + passo TIRADO da corrente: a cadeia nao fica presa (falha com o motivo)", async () => {
      const fluxo = valido({
        id: "aval-orfao",
        nome: "R",
        tipo: "macro",
        versao: 1,
        nos: [
          { id: "n1", tipo: "acao", acao: { tipo: "nota_interna", texto: "a" }, proximo: "n2" },
          { id: "n2", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "b" } },
        ],
      });
      const b = criarBanco([{ chat: "c12", fluxo: "aval-orfao" }]);
      b.fluxos.set("aval-orfao", { fluxo, ativo: true });
      await executarTickFila(criarPorta(b), { passos: 10 });
      await executarTickFila(criarPorta(b), { passos: 10 });
      assert.equal(b.linhas[0].estado, "aguardando_aprovacao");

      // n2 sai da corrente (n1 deixa de apontar pra ele)
      b.fluxos.set("aval-orfao", {
        fluxo: valido({
          ...fluxo,
          nos: [{ id: "n1", tipo: "acao", acao: { tipo: "nota_interna", texto: "a" } }],
        }),
        ativo: true,
      });
      await executarTickFila(criarPorta(b), { passos: 10 });
      assert.equal(b.linhas[0].estado, "falhou", "presa pra sempre nao e opcao: falha com motivo legivel");
      assert.match(String(b.linhas[0].erro), /nao esta mais na corrente/);
    });

    await testeAsync("FLUXO desligado tambem solta a cadeia parada em aval", async () => {
      // um nivel acima do passo desligado, e o caminho normal NAO cobre: ele so
      // olha `agendado`. Desligar o fluxo inteiro e um "nao faca isto" mais forte
      // ainda; a cadeia nao pode ficar esperando um aval que ninguem vai dar.
      const fluxo = valido({
        id: "aval-fluxo-off",
        nome: "R",
        tipo: "macro",
        versao: 1,
        nos: [{ id: "n1", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "x" } }],
      });
      const b = criarBanco([{ chat: "c13", fluxo: "aval-fluxo-off" }]);
      b.fluxos.set("aval-fluxo-off", { fluxo, ativo: true });
      await executarTickFila(criarPorta(b), { passos: 10 });
      assert.equal(b.linhas[0].estado, "aguardando_aprovacao");

      b.fluxos.set("aval-fluxo-off", { fluxo, ativo: false });
      const r = await executarTickFila(criarPorta(b), { passos: 10 });
      assert.equal(r.concluidas, 1);
      assert.equal(b.linhas[0].estado, "concluido");
      assert.match(String(b.linhas[0].erro), /fluxo foi desligado/);
      assert.equal(b.execucoes.get("i1:n1"), undefined, "e a mensagem nunca saiu");
    });

    await testeAsync("FLUXO APAGADO tambem solta (e diz que o fluxo nao existe mais)", async () => {
      const fluxo = valido({
        id: "aval-fluxo-sumiu",
        nome: "R",
        tipo: "macro",
        versao: 1,
        nos: [{ id: "n1", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "x" } }],
      });
      const b = criarBanco([{ chat: "c14", fluxo: "aval-fluxo-sumiu" }]);
      b.fluxos.set("aval-fluxo-sumiu", { fluxo, ativo: true });
      await executarTickFila(criarPorta(b), { passos: 10 });
      assert.equal(b.linhas[0].estado, "aguardando_aprovacao");

      b.fluxos.delete("aval-fluxo-sumiu");
      await executarTickFila(criarPorta(b), { passos: 10 });
      assert.equal(b.linhas[0].estado, "concluido");
      assert.match(String(b.linhas[0].erro), /nao esta mais disponivel/);
    });

    // ---------------------------------------------------------------------
    // A PASSADA DE AVAL DESLIGADO VIVE DENTRO DO ORCAMENTO DA RODADA.
    //
    // Defeito da re-revisao de 31/08/2026: ela nascia FORA do relogio do tick.
    // Com o orcamento ja estourado, ainda fazia 1 consulta e ate `teto * 2` voltas
    // de carregarFluxo + reserva + trilha + agendamento por cima — e o tick e
    // COMPARTILHADO (o mesmo cron roda o motor inteiro), entao o tempo gasto aqui
    // e tempo tirado de outra frente, nao "da nossa parte".
    //
    // As DUAS guardas tem prova propria porque uma nao cobre a outra: o `break` do
    // laco nao impede a consulta, e a guarda de entrada nao impede o orcamento de
    // acabar NO MEIO da passada. Cada uma morre por mutacao separada.
    const fluxoAvalOff = (id: string) =>
      valido({
        id,
        nome: "R",
        tipo: "macro",
        versao: 1,
        nos: [
          {
            id: "n1",
            tipo: "acao",
            aprovacao: true,
            desligado: true,
            acao: { tipo: "enviar_texto", texto: "proposta" },
            proximo: "n2",
          },
          { id: "n2", tipo: "acao", acao: { tipo: "nota_interna", texto: "depois" } },
        ],
      });

    await testeAsync("ORCAMENTO: estourado no laco principal, a passada de aval nem CONSULTA", async () => {
      // c20 roda normal (e o que queima o relogio, como um tick lento de verdade);
      // c21 esta parada num passo que JA foi desligado — ou seja, seria liberada se
      // a passada rodasse. O certo e ela sair no proximo tick.
      const b = criarBanco([
        { chat: "c20" },
        { chat: "c21", fluxo: "orc-off-a", no: "n1" },
      ]);
      b.fluxos.set("orc-off-a", { fluxo: fluxoAvalOff("orc-off-a"), ativo: true });
      b.linhas[1].estado = "aguardando_aprovacao";
      b.linhas[1].aprovacao_no_id = "n1";

      let agora = 0;
      const porta = criarPorta(b, { agora: () => agora });
      let consultas = 0;
      const lerParadas = porta.candidatosAguardandoAval.bind(porta);
      porta.candidatosAguardandoAval = async (n) => {
        consultas++;
        return lerParadas(n);
      };
      const carregar = porta.carregarFluxo.bind(porta);
      porta.carregarFluxo = async (slug) => {
        agora += 60_000; // o passo do laco principal levou mais que o orcamento
        return carregar(slug);
      };

      const r = await executarTickFila(porta, { passos: 10 });
      assert.equal(consultas, 0, "orcamento estourado nao paga nem a LEITURA das paradas");
      assert.equal(r.liberadas_de_aval, 0);
      assert.equal(b.linhas[1].estado, "aguardando_aprovacao", "nada foi perdido: sai no proximo tick");
      assert.match(String(r.motivo), /orcamento/, "e a rodada diz por que parou");
    });

    await testeAsync("ORCAMENTO: se acaba NO MEIO da passada, ela para no item seguinte", async () => {
      // as duas cadeias estao paradas em passo desligado, em conversas diferentes:
      // sem o break, as DUAS seriam liberadas nesta rodada.
      const b = criarBanco([
        { chat: "c22", fluxo: "orc-off-b", no: "n1", atualizada: 1 },
        { chat: "c23", fluxo: "orc-off-b", no: "n1", atualizada: 2 },
      ]);
      b.fluxos.set("orc-off-b", { fluxo: fluxoAvalOff("orc-off-b"), ativo: true });
      for (const l of b.linhas) {
        l.estado = "aguardando_aprovacao";
        l.aprovacao_no_id = "n1";
      }

      let agora = 0;
      const porta = criarPorta(b, { agora: () => agora });
      const carregar = porta.carregarFluxo.bind(porta);
      porta.carregarFluxo = async (slug) => {
        agora += 60_000; // cada volta da passada custa mais que o orcamento inteiro
        return carregar(slug);
      };

      const r = await executarTickFila(porta, { passos: 10 });
      assert.equal(r.liberadas_de_aval, 1, "UMA por rodada: o orcamento acabou depois da primeira");
      assert.equal(b.linhas[0].no_id, "n2", "a mais antiga andou");
      assert.equal(b.linhas[0].estado, "agendado");
      assert.equal(b.linhas[1].estado, "aguardando_aprovacao", "a segunda ficou intacta pro proximo tick");
      assert.equal(b.execucoes.get("i2:n1"), undefined, "e nada foi executado por ela");
      assert.match(String(r.motivo), /orcamento/);
    });

    await testeAsync("a passada de aval pega a parada MAIS ANTIGA primeiro (atualizada_em ASC)", async () => {
      // A janela e `teto * 2`: com mais paradas que o teto, a ordem decide QUEM
      // entra nela. `atualizada_em` ASC = quem espera ha mais tempo. Ordenar por
      // canal/chat_id (como o fake fazia antes desta correcao) atenderia por ordem
      // ALFABETICA da conversa — o mesmo defeito que a ordem dos candidatos existe
      // pra nao ter. O `zz` esta parado ha MAIS tempo que o `aa` de proposito.
      const b = criarBanco([
        { chat: "zz-antiga", fluxo: "orc-off-c", no: "n1", atualizada: 10 },
        { chat: "aa-recente", fluxo: "orc-off-c", no: "n1", atualizada: 20 },
      ]);
      b.fluxos.set("orc-off-c", { fluxo: fluxoAvalOff("orc-off-c"), ativo: true });
      for (const l of b.linhas) {
        l.estado = "aguardando_aprovacao";
        l.aprovacao_no_id = "n1";
      }
      const porta = criarPorta(b, { agora: () => 0 });
      const vistos: string[] = [];
      const lerParadas = porta.candidatosAguardandoAval.bind(porta);
      porta.candidatosAguardandoAval = async (n) => {
        const itens = await lerParadas(n);
        vistos.push(...itens.map((i) => i.chat_id));
        return itens;
      };
      await executarTickFila(porta, { passos: 10 });
      assert.deepEqual(vistos, ["zz-antiga", "aa-recente"], "a mais antiga vem primeiro, nao a alfabeticamente menor");
    });

    // ─── EXPIRACAO DO AVAL (config `aprovacao_expira_horas`, decisao do Eric 03/09/2026)
    // O passo do aval segue LIGADO (a passada de "desligado" nao mexeria nele): o
    // unico motivo pra cadeia sair da espera e o prazo da instalacao.
    const fluxoAvalOn = (id: string) =>
      valido({
        id,
        nome: "R",
        tipo: "macro",
        versao: 1,
        nos: [
          { id: "n1", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "proposta" }, proximo: "n2" },
          { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "2" } },
        ],
      });
    const H = 3_600_000;

    await testeAsync("EXPIRACAO: com 0 horas (default) a parada em aval fica esperando gente, por mais velha que seja", async () => {
      const b = criarBanco([{ chat: "c30", fluxo: "exp-a", no: "n1", atualizada: 0 }]);
      b.fluxos.set("exp-a", { fluxo: fluxoAvalOn("exp-a"), ativo: true });
      b.linhas[0].estado = "aguardando_aprovacao";
      b.linhas[0].aprovacao_no_id = "n1";
      const r = await executarTickFila(criarPorta(b, { agora: () => 100 * 24 * H }), { passos: 10 });
      assert.equal(r.expiradas_de_aval, 0);
      assert.equal(b.linhas[0].estado, "aguardando_aprovacao", "sem prazo configurado nada expira");
      const r2 = await executarTickFila(criarPorta(b, { agora: () => 100 * 24 * H }), { passos: 10, aprovacaoExpiraHoras: 0 });
      assert.equal(r2.expiradas_de_aval, 0, "0 explicito = nunca, igual ao ausente");
    });

    await testeAsync("EXPIRACAO: parada ha MAIS que o prazo e CANCELADA com o motivo, e nada e executado", async () => {
      const b = criarBanco([{ chat: "c31", fluxo: "exp-b", no: "n1", atualizada: 0 }]);
      b.fluxos.set("exp-b", { fluxo: fluxoAvalOn("exp-b"), ativo: true });
      b.linhas[0].estado = "aguardando_aprovacao";
      b.linhas[0].aprovacao_no_id = "n1";
      const r = await executarTickFila(criarPorta(b, { agora: () => 25 * H }), { passos: 10, aprovacaoExpiraHoras: 24 });
      assert.equal(r.expiradas_de_aval, 1);
      assert.equal(b.linhas[0].estado, "cancelado", "expirou = cancelada (nao concluida, nao falhou)");
      assert.match(String(b.linhas[0].erro), /expirou/, "o motivo fica na linha, pra tela da fila");
      assert.match(String(b.linhas[0].erro), /24h/, "e diz qual era o prazo");
      assert.equal(b.execucoes.get("i1:n1"), undefined, "o passo que esperava aval NAO rodou");
      assert.equal(b.execucoes.get("i1:n2"), undefined, "e a cadeia nao seguiu adiante");
    });

    await testeAsync("EXPIRACAO: parada ha MENOS que o prazo fica intacta (e a que passou, nao)", async () => {
      const b = criarBanco([
        { chat: "c32", fluxo: "exp-c", no: "n1", atualizada: 0 },
        { chat: "c33", fluxo: "exp-c", no: "n1", atualizada: 20 * H },
      ]);
      b.fluxos.set("exp-c", { fluxo: fluxoAvalOn("exp-c"), ativo: true });
      for (const l of b.linhas) {
        l.estado = "aguardando_aprovacao";
        l.aprovacao_no_id = "n1";
      }
      const r = await executarTickFila(criarPorta(b, { agora: () => 25 * H }), { passos: 10, aprovacaoExpiraHoras: 24 });
      assert.equal(r.expiradas_de_aval, 1, "so a que passou de 24h");
      assert.equal(b.linhas[0].estado, "cancelado");
      assert.equal(b.linhas[1].estado, "aguardando_aprovacao", "5h de espera com prazo de 24h = segue esperando");
    });

    await testeAsync("EXPIRACAO: decisao humana na janela vence (o claim nao casa, nada e cancelado)", async () => {
      const b = criarBanco([{ chat: "c34", fluxo: "exp-d", no: "n1", atualizada: 0 }]);
      b.fluxos.set("exp-d", { fluxo: fluxoAvalOn("exp-d"), ativo: true });
      b.linhas[0].estado = "aguardando_aprovacao";
      b.linhas[0].aprovacao_no_id = "n1";
      const porta = criarPorta(b, { agora: () => 25 * H });
      const ler = porta.candidatosAguardandoAval.bind(porta);
      porta.candidatosAguardandoAval = async (n) => {
        const itens = await ler(n);
        // alguem aprovou ENTRE a leitura e o claim: a linha volta pra agendado
        b.linhas[0].estado = "agendado";
        b.linhas[0].aprovacao_decisao = "aprovado";
        return itens;
      };
      const r = await executarTickFila(porta, { passos: 10, aprovacaoExpiraHoras: 24 });
      assert.equal(r.expiradas_de_aval, 0);
      assert.equal(b.linhas[0].estado, "agendado", "a decisao humana ficou de pe");
      assert.equal(r.perdidos >= 1, true, "e a rodada registra que perdeu o claim");
    });

    await testeAsync("APROVACAO: aprovado COM a assinatura do conteudo, o passo roda no tick seguinte", async () => {
      // e exatamente o que `decidirAprovacao` grava: volta pra agendado com a
      // decisao NO PASSO e a assinatura DO CONTEUDO que foi aprovado
      const n2 = fluxoAval.nos.find((n) => n.id === "n2")!;
      banco.linhas[0].estado = "agendado";
      banco.linhas[0].aprovacao_decisao = "aprovado";
      banco.linhas[0].aprovacao_assinatura = assinaturaDoNo(n2);
      banco.linhas[0].disponivel_em = 0;
      const r = await executarTickFila(criarPorta(banco), { passos: 10 });
      assert.equal(r.passos, 1);
      assert.equal(banco.execucoes.get("i1:n2"), 1);
      assert.equal(banco.linhas[0].estado, "concluido");
    });

    await testeAsync("APROVACAO: EDITAR o passo depois do aval faz a cadeia parar de novo", async () => {
      const n2 = fluxoAval.nos.find((n) => n.id === "n2")!;
      const banco2 = criarBanco([{ chat: "c9", no: "n2" }]);
      banco2.fluxos.set("regua", { fluxo: fluxoAval, ativo: true });
      banco2.linhas[0].aprovacao_no_id = "n2";
      banco2.linhas[0].aprovacao_decisao = "aprovado";
      banco2.linhas[0].aprovacao_assinatura = assinaturaDoNo(n2);
      // ... e alguem edita o texto do passo aprovado
      const editado = valido({
        ...fluxoAval,
        nos: fluxoAval.nos.map((n) =>
          n.id === "n2" ? { ...n, acao: { tipo: "enviar_texto", texto: "OUTRO texto" } } : n
        ),
      });
      banco2.fluxos.set("regua", { fluxo: editado, ativo: true });
      const r = await executarTickFila(criarPorta(banco2), { passos: 10 });
      assert.equal(r.passos, 0, "o cliente nao pode receber texto que ninguem aprovou");
      assert.equal(banco2.linhas[0].estado, "aguardando_aprovacao");
      assert.equal(banco2.linhas[0].aprovacao_decisao, null, "a decisao antiga tem que ser limpa");
      assert.equal(banco2.linhas[0].aprovacao_assinatura, null);
      assert.match(banco2.linhas[0].erro!, /EDITADO/);
      // e a PARADA vai pra trilha como `pulado`: senao "aprovei e voltou a pedir
      // aval" seria um misterio pro supervisor
      assert.deepEqual(
        banco2.trilha.map((t) => t.status),
        ["pulado"]
      );
    });
  }

  // ------------------------------------------------------------------ retry
  {
    const banco = criarBanco([{ chat: "c1" }]);
    let vezes = 0;
    const porta = () =>
      criarPorta(banco, {
        resultado: () => {
          vezes++;
          return { status: "falhou", acao: "enviar_texto", detalhe: "provedor fora do ar" };
        },
      });

    await executarTickFila(porta(), { passos: 10 });
    await testeAsync("RETRY: falha transitoria conta tentativa e REAGENDA (nao queima o passo)", async () => {
      assert.equal(banco.linhas[0].estado, "agendado");
      assert.equal(banco.linhas[0].tentativas, 1);
      assert.ok(banco.linhas[0].disponivel_em > 0, "reagendou pro futuro, com recuo");
    });

    await testeAsync(`RETRY: depois de ${MAX_TENTATIVAS_PASSO} tentativas a cadeia FALHA com o motivo`, async () => {
      for (let i = 0; i < MAX_TENTATIVAS_PASSO + 2; i++) {
        banco.linhas[0].disponivel_em = 0;
        await executarTickFila(porta(), { passos: 10 });
      }
      assert.equal(banco.linhas[0].estado, "falhou");
      assert.match(banco.linhas[0].erro!, /desistiu apos/);
      assert.equal(vezes, MAX_TENTATIVAS_PASSO, "nao insiste pra sempre");
    });
  }

  // --------------------------------------------------- fluxo sumiu / desligado
  {
    const banco = criarBanco([{ chat: "c1" }]);
    banco.fluxos.clear();
    await executarTickFila(criarPorta(banco), { passos: 10 });
    await testeAsync("fluxo APAGADO: a cadeia falha com motivo legivel, nao fica presa", async () => {
      assert.equal(banco.linhas[0].estado, "falhou");
      assert.match(banco.linhas[0].erro!, /nao esta mais disponivel/);
    });
  }
  {
    const banco = criarBanco([{ chat: "c1" }]);
    banco.fluxos.set("regua", { fluxo: FLUXO_TICK, ativo: false });
    await executarTickFila(criarPorta(banco), { passos: 10 });
    await testeAsync("DESLIGAR o fluxo PARA a regua pendente (desligar existe pra isso)", async () => {
      assert.equal(banco.linhas[0].estado, "concluido");
      assert.match(banco.linhas[0].erro!, /desligado/);
      assert.equal(banco.execucoes.size, 0, "nenhum passo rodou");
    });
  }

  // ------------------------------------------------------- passo que sumiu
  {
    const banco = criarBanco([{ chat: "c1", no: "no-inexistente" }]);
    await executarTickFila(criarPorta(banco), { passos: 10 });
    await testeAsync("passo apagado do fluxo no meio da execucao: falha dizendo o que aconteceu", async () => {
      assert.equal(banco.linhas[0].estado, "falhou");
      assert.match(banco.linhas[0].erro!, /nao esta mais na corrente/);
      assert.match(banco.linhas[0].erro!, /durante a execucao/);
    });
  }

  // ------------------------------------------------------------ condicao falsa
  {
    const fluxoCond = valido({
      id: "regua",
      nome: "Com condicao",
      tipo: "macro",
      versao: 1,
      nos: [
        {
          id: "n1",
          tipo: "condicao",
          condicao: { tipo: "comparacao", campo: "status", operador: "igual", valor: "aberto" },
          proximo: "n2",
        },
        { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "oi" } },
      ],
    });
    const banco = criarBanco([{ chat: "c1" }]);
    banco.fluxos.set("regua", { fluxo: fluxoCond, ativo: true });
    await executarTickFila(
      criarPorta(banco, { resultado: () => ({ status: "parou", acao: "condicao", detalhe: "condicao falsa" }) }),
      { passos: 10 }
    );
    await testeAsync("condicao FALSA conclui a cadeia sem erro (mesma semantica do inline)", async () => {
      assert.equal(banco.linhas[0].estado, "concluido");
      assert.equal(banco.execucoes.get("i1:n2"), undefined);
      // e na trilha isso e um passo `ok`, nao um `falhou` — vocabulario unico
      assert.deepEqual(banco.trilha, [{ item: "i1", exec: "e1", no: "n1", status: "parou" }]);
    });
  }

  // -------------------------------------------------------- tetos da rodada
  {
    const banco = criarBanco(
      Array.from({ length: 6 }, (_, i) => ({ chat: `c${i}` }))
    );
    const r = await executarTickFila(criarPorta(banco), { passos: 2 });
    await testeAsync("o tick respeita o teto de passos da rodada (o resto sai no proximo)", async () => {
      assert.equal(r.passos, 2);
      assert.match(r.motivo!, /teto de passos/);
      assert.equal(banco.linhas.filter((l) => l.no_id === "n1").length, 4);
    });
  }

  {
    const banco = criarBanco([{ chat: "c1" }, { chat: "c2" }]);
    let t = 0;
    const r = await executarTickFila(criarPorta(banco, { agora: () => (t += 100_000) }), {
      passos: 10,
      orcamentoMs: 1,
    });
    await testeAsync("o tick respeita o ORCAMENTO de tempo e diz que o resto sai depois", async () => {
      assert.ok(r.passos < 2);
      assert.match(r.motivo!, /orcamento/);
    });
  }

  {
    const banco = criarBanco([{ chat: "c1" }]);
    banco.linhas[0].disponivel_em = Date.now() + 86_400_000;
    const r = await executarTickFila(criarPorta(banco), { passos: 10 });
    await testeAsync("passo com a hora NO FUTURO nao e pego pelo tick (a espera de verdade)", async () => {
      assert.equal(r.passos, 0);
      assert.equal(banco.linhas[0].no_id, "n1");
    });
  }

  // ------------------------------------- FIFO POR HORA (a ordem dos candidatos)
  //
  // O defeito: ordenar por canal/chat antes da hora fazia a fila atender por ordem
  // ALFABETICA de conversa. Com fila maior que o teto da rodada, o passo agendado
  // pra 08:00 de um chat "z..." ficava atras de tudo e podia nao rodar nunca.
  {
    const agora = Date.now();
    const banco = criarBanco([
      { chat: "zzz-atrasado", em: agora - 3_600_000 },
      { chat: "aaa-recente", em: agora - 1_000 },
    ]);
    const r = await executarTickFila(criarPorta(banco), { passos: 1 });
    await testeAsync("FIFO POR HORA: quem esperava mais tempo roda primeiro, mesmo com chat_id 'maior'", async () => {
      assert.equal(r.passos, 1);
      assert.equal(banco.linhas[0].no_id, "n2", "o item de 1h atras tinha que ser o escolhido");
      assert.equal(banco.linhas[1].no_id, "n1", "o recente espera o proximo tick");
    });
  }

  // --------------------------------- PASSO FORA DA CORRENTE nao executa
  //
  // Tirar um passo do encadeamento (`proximo`) e como desliga-lo na tela. O passo
  // continua no `nos` do fluxo — e `fluxo.nos.find` o executava mesmo assim, numa
  // cadeia ja agendada. Quem tira o passo da corrente espera que ele PARE de rodar.
  {
    const foraDaCorrente = valido({
      id: "regua",
      nome: "Regua com passo solto",
      tipo: "macro",
      versao: 1,
      nos: [
        { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "1" } },
        // n9 existe, mas NINGUEM aponta pra ele: esta fora da corrente
        { id: "n9", tipo: "acao", acao: { tipo: "enviar_texto", texto: "orfao" } },
      ],
    });
    const banco = criarBanco([{ chat: "c1", no: "n9" }]);
    banco.fluxos.set("regua", { fluxo: foraDaCorrente, ativo: true });
    const r = await executarTickFila(criarPorta(banco), { passos: 10 });
    await testeAsync("GRAVE: passo FORA da corrente NAO executa — a cadeia falha e diz por que", async () => {
      assert.equal(r.passos, 0, "nao pode sair mensagem de passo que a tela mostra como desligado");
      assert.equal(banco.execucoes.size, 0);
      assert.equal(banco.linhas[0].estado, "falhou");
      assert.match(banco.linhas[0].erro!, /nao esta mais na corrente/);
    });
  }

  // -------------------- IDEMPOTENCIA: crash entre o envio e o avanco da cadeia
  //
  // O tick manda a mensagem, grava a trilha e morre antes de gravar o proximo
  // `no_id`. A reserva fica orfa, volta pra fila — e o passo rodaria DE NOVO.
  // A trilha ja tem `(execucao_id, no_id)`: a pergunta e barata e fecha a janela.
  {
    const banco = criarBanco([{ chat: "c1" }]);
    // simula o crash: a trilha JA tem o passo n1 desta execucao, mas a linha
    // continua apontando pra n1 (o avanco nunca foi gravado)
    banco.trilha.push({ item: "i1", exec: "e1", no: "n1", status: "ok" });
    const r = await executarTickFila(criarPorta(banco), { passos: 10 });
    await testeAsync("IDEMPOTENCIA: passo que ja consta na trilha NAO reexecuta — a cadeia so avanca", async () => {
      assert.equal(banco.execucoes.size, 0, "mensagem em dobro pro cliente e o defeito mais caro daqui");
      assert.equal(r.repetidos, 1);
      assert.equal(r.passos, 0, "passo pulado nao conta como passo executado");
      assert.equal(banco.linhas[0].no_id, "n2", "a cadeia tem que ANDAR, senao trava pra sempre");
      assert.equal(banco.linhas[0].estado, "agendado");
    });
  }

  {
    // ultimo passo da corrente ja na trilha: encerra sem repetir o efeito
    const banco = criarBanco([{ chat: "c1", no: "n3" }]);
    banco.trilha.push({ item: "i1", exec: "e1", no: "n3", status: "ok" });
    await executarTickFila(criarPorta(banco), { passos: 10 });
    await testeAsync("IDEMPOTENCIA no ULTIMO passo: encerra concluido sem repetir o envio", async () => {
      assert.equal(banco.execucoes.size, 0);
      assert.equal(banco.linhas[0].estado, "concluido");
      assert.match(banco.linhas[0].erro!, /ja constava na trilha/);
    });
  }

  {
    // passo que FALHOU na trilha nao conta como executado: falha se repete de
    // proposito (o retry existe justamente pra isso)
    const banco = criarBanco([{ chat: "c1" }]);
    banco.trilha.push({ item: "i1", exec: "e1", no: "n1", status: "falhou" });
    const r = await executarTickFila(criarPorta(banco), { passos: 10 });
    await testeAsync("trilha com status FALHOU nao bloqueia a nova tentativa", async () => {
      assert.equal(r.passos, 1);
      assert.equal(banco.execucoes.get("i1:n1"), 1);
    });
  }

  {
    // a trilha de OUTRA execucao (mesma conversa, cadeia nova) nao pula nada
    const banco = criarBanco([{ chat: "c1" }]);
    banco.trilha.push({ item: "i0", exec: "e-antiga", no: "n1", status: "ok" });
    const r = await executarTickFila(criarPorta(banco), { passos: 10 });
    await testeAsync("idempotencia e por EXECUCAO: rodada anterior da mesma conversa nao pula o passo", async () => {
      assert.equal(r.passos, 1);
      assert.equal(banco.execucoes.get("i1:n1"), 1);
    });
  }

  // ---------------- AVAL EM PASSO INTERNO NAO PARA A CADEIA (fim a fim)
  {
    const comNotaMarcada = valido({
      id: "regua",
      nome: "Nota marcada por engano",
      tipo: "macro",
      versao: 1,
      nos: [
        // marca que veio da importacao: 796 dos 837 nos com aval eram nota interna
        { id: "n1", tipo: "acao", aprovacao: true, acao: { tipo: "nota_interna", texto: "conferir" }, proximo: "n2" },
        { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "oi" } },
      ],
    });
    const banco = criarBanco([{ chat: "c1" }]);
    banco.fluxos.set("regua", { fluxo: comNotaMarcada, ativo: true });
    const r1 = await executarTickFila(criarPorta(banco), { passos: 10 });
    await testeAsync("aval em NOTA INTERNA nao para a cadeia no tick (e nao vai pra fila de aval)", async () => {
      assert.equal(r1.aguardando_aprovacao, 0, "aprovar nota interna nao protege ninguem e polui a fila");
      assert.equal(r1.passos, 1);
      assert.equal(banco.execucoes.get("i1:n1"), 1, "a nota foi gravada, sem esperar aval");
      assert.equal(banco.linhas[0].estado, "agendado");
      assert.equal(banco.linhas[0].no_id, "n2");
    });
  }

  // ------------------- ERRO DE LEITURA DE ESTADO != CADEIA CANCELADA
  //
  // Uma piscada do banco na releitura congelava a cadeia PARA SEMPRE: era tratada
  // como cancelamento, a reserva era devolvida com o carimbo NULO, e a linha ficava
  // `executando` com `reservado_em = null` — estado que a varredura de orfas (que
  // olha carimbo VELHO) nunca retomava.
  {
    const banco = criarBanco([{ chat: "c1" }]);
    const r = await executarTickFila(criarPorta(banco, { falharLeituraDeEstado: true }), { passos: 10 });
    await testeAsync("GRAVE: erro de leitura do estado nao executa NADA e NAO limpa o carimbo", async () => {
      assert.equal(r.passos, 0, "fail-closed no efeito: sem saber o estado, nada sai");
      assert.equal(r.interrompidos, 1);
      assert.match(r.motivo!, /nao deu pra reler/);
      assert.equal(banco.linhas[0].estado, "executando");
      assert.ok(banco.linhas[0].reservado_em, "o carimbo FICA — e a varredura de orfas que retoma");
      assert.equal(banco.linhas[0].no_id, "n1", "a cadeia nao andou nem foi encerrada");
    });
  }

  // ----------------------------------------------- avaliacao de condicao na fila
  await testeAsync("condicao na fila e avaliada com o fato de AGORA e pede so o campo que usa", async () => {
    const pedidos: string[][] = [];
    const r = await avaliarNoDeCondicao(
      {
        id: "n1",
        tipo: "condicao",
        condicao: { tipo: "comparacao", campo: "etiqueta", operador: "contem", valor: "vip" },
      },
      async (campos) => {
        pedidos.push(campos);
        return { fatos: { etiquetas: ["Cliente VIP"] }, indisponiveis: {} };
      }
    );
    assert.deepEqual(pedidos, [["etiqueta"]], "nao busca status/texto/etapa que a condicao nao usa");
    assert.equal(r.status, "ok");
    assert.equal((r as any).segue, true, "comparacao ignora caixa e acento");
  });

  await testeAsync("fato INDISPONIVEL faz o passo FALHAR, nunca 'condicao falsa'", async () => {
    const r = await avaliarNoDeCondicao(
      {
        id: "n1",
        tipo: "condicao",
        condicao: { tipo: "comparacao", campo: "contexto", operador: "existe", chave: "URA" },
      },
      async () => ({ fatos: {}, indisponiveis: { contexto: "migration 0016 nao aplicada" } })
    );
    assert.equal(r.status, "falhou");
    assert.match(r.detalhe, /0016/);
  });

  await testeAsync("no de condicao SEM condicao falha em vez de deixar passar", async () => {
    const r = await avaliarNoDeCondicao({ id: "n1", tipo: "condicao" }, async () => ({
      fatos: {},
      indisponiveis: {},
    }));
    assert.equal(r.status, "falhou");
  });
})();

// ==================================================== 9) SIMULADOR (seco)
console.log("\n9) SIMULADOR — o que aconteceria, sem enviar nada");

const gatilhoOi = valido({
  id: "saudacao",
  nome: "Saudacao",
  tipo: "gatilho",
  versao: 1,
  nos: [
    {
      id: "n1",
      tipo: "condicao",
      condicao: { tipo: "comparacao", campo: "texto", operador: "contem", valor: "oi" },
      proximo: "n2",
    },
    { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "Ola! Como posso ajudar?" }, proximo: "n3" },
    { id: "n3", tipo: "acao", acao: { tipo: "definir_contexto", chave: "URA", valor: "MENU" } },
  ],
});

const entradaDe = (f: Fluxo, ativo = true): EntradaSimulacao => ({
  slug: f.id,
  nome: f.nome,
  ativo,
  fluxo: f,
});

teste("mensagem que casa a condicao de entrada: o fluxo RESPONDERIA, com o texto na mao", () => {
  const s = simularFluxo(entradaDe(gatilhoOi), { texto: "Oi, bom dia" });
  assert.equal(s.elegivel, true);
  assert.equal(s.responderia, true);
  assert.deepEqual(s.textos, ["Ola! Como posso ajudar?"]);
  assert.equal(s.passos.filter((p) => p.situacao === "rodaria").length, 3);
});

teste("mensagem que NAO casa: para no primeiro passo, e os seguintes saem como pulados", () => {
  const s = simularFluxo(entradaDe(gatilhoOi), { texto: "quero cancelar" });
  assert.equal(s.elegivel, false);
  assert.equal(s.responderia, false);
  assert.deepEqual(s.textos, []);
  assert.equal(s.passos[0].situacao, "parou");
  assert.equal(s.passos[1].situacao, "pulado");
  assert.match(s.motivo, /nao bateu/);
});

teste("MACRO nao concorre pela mensagem, e o motivo diz isso em portugues", () => {
  const macro = valido(fluxoLinear({ id: "m", nome: "M" }, [{ tipo: "enviar_texto", texto: "x" }]));
  const s = simularFluxo(entradaDe(macro), { texto: "qualquer coisa" });
  assert.equal(s.elegivel, false);
  assert.equal(s.responderia, false);
  assert.match(s.motivo, /atendente dispara/);
  // mas os passos APARECEM: quem clica no macro quer saber o que ele faria
  assert.equal(s.passos[0].situacao, "rodaria");
});

teste("fluxo DESLIGADO nunca e elegivel, e o motivo e o desligamento", () => {
  const s = simularFluxo(entradaDe(gatilhoOi, false), { texto: "oi" });
  assert.equal(s.elegivel, false);
  assert.match(s.motivo, /DESLIGADO/);
});

teste("gatilho SEM condicao de entrada dispara pra qualquer mensagem, e diz isso", () => {
  const semCond = valido({
    ...fluxoLinear({ id: "s", nome: "S" }, [{ tipo: "enviar_texto", texto: "sempre" }]),
    tipo: "gatilho",
  });
  const s = simularFluxo(entradaDe(semCond), { texto: "tanto faz" });
  assert.equal(s.elegivel, true);
  assert.match(s.motivo, /sem condicao de entrada/);
});

teste("condicao no MEIO do fluxo nao e condicao de ENTRADA (senao o fluxo pareceria nao disparar)", () => {
  const meio = valido({
    id: "m",
    nome: "M",
    tipo: "gatilho",
    versao: 1,
    nos: [
      { id: "n1", tipo: "acao", acao: { tipo: "nota_interna", texto: "chegou" }, proximo: "n2" },
      {
        id: "n2",
        tipo: "condicao",
        condicao: { tipo: "comparacao", campo: "status", operador: "igual", valor: "aberto" },
        proximo: "n3",
      },
      { id: "n3", tipo: "acao", acao: { tipo: "enviar_texto", texto: "oi" } },
    ],
  });
  assert.equal(condicaoDeEntrada(meio), null);
  const s = simularFluxo(entradaDe(meio), { texto: "x", status: "concluido" });
  assert.equal(s.elegivel, true, "ele dispara: a checagem dele e de continuar, nao de disparar");
  assert.equal(s.responderia, false, "mas nao responde, porque a condicao do meio nao bateu");
});

teste("O CASO-MAE: definir_contexto seguido de condicao sobre a MESMA chave simula VERDADEIRO", () => {
  // Este e o defeito que a revisao cega pegou no motor de verdade (condicao
  // decidindo em dado velho). Se o simulador nao aplicasse o efeito previsto, ele
  // mostraria o fluxo parando — e mandaria a pessoa consertar um fluxo correto.
  const f = valido({
    id: "menu",
    nome: "Menu",
    tipo: "gatilho",
    versao: 1,
    nos: [
      { id: "n1", tipo: "acao", acao: { tipo: "definir_contexto", chave: "URA", valor: "MENU" }, proximo: "n2" },
      {
        id: "n2",
        tipo: "condicao",
        condicao: { tipo: "comparacao", campo: "contexto", operador: "igual", chave: "URA", valor: "MENU" },
        proximo: "n3",
      },
      { id: "n3", tipo: "acao", acao: { tipo: "enviar_texto", texto: "1) Vendas 2) Suporte" } },
    ],
  });
  const s = simularFluxo(entradaDe(f), { texto: "oi" });
  assert.deepEqual(s.textos, ["1) Vendas 2) Suporte"]);
});

teste("limpar_contexto APAGA a chave (nao grava vazio): o nao_existe volta a valer", () => {
  const fatos = efeitoPrevisto({ contexto: { URA: "MENU" } }, { tipo: "limpar_contexto", chave: "URA" });
  assert.equal("URA" in (fatos.contexto ?? {}), false);
});

teste("efeito previsto: etiquetar/mudar_status/mover_funil mexem nos fatos como na vida real", () => {
  let f = efeitoPrevisto({ etiquetas: ["a"] }, { tipo: "etiquetar", etiquetas: ["b"], modo: "adicionar" });
  assert.deepEqual(f.etiquetas, ["a", "b"]);
  f = efeitoPrevisto(f, { tipo: "etiquetar", etiquetas: ["a"], modo: "remover" });
  assert.deepEqual(f.etiquetas, ["b"]);
  f = efeitoPrevisto(f, { tipo: "etiquetar", etiquetas: ["z"], modo: "substituir" });
  assert.deepEqual(f.etiquetas, ["z"]);

  f = efeitoPrevisto({}, { tipo: "mudar_status", status: "concluido" });
  assert.equal(f.status, "concluido");

  f = efeitoPrevisto(
    { etapas: [{ funil: "Vendas", etapa: "Novo" }, { funil: "CS", etapa: "Ativo" }] },
    { tipo: "mover_funil", funil: "Vendas", etapa: "Proposta" }
  );
  assert.deepEqual(f.etapas, [{ funil: "CS", etapa: "Ativo" }, { funil: "Vendas", etapa: "Proposta" }]);

  f = efeitoPrevisto(f, { tipo: "mover_funil", funil: "CS", etapa: null });
  assert.deepEqual(f.etapas, [{ funil: "Vendas", etapa: "Proposta" }]);
});

teste("efeito previsto NAO muda os fatos originais (a simulacao nao contamina o chamador)", () => {
  const original = { etiquetas: ["a"], contexto: { k: "v" } };
  efeitoPrevisto(original, { tipo: "etiquetar", etiquetas: ["b"], modo: "adicionar" });
  assert.deepEqual(original.etiquetas, ["a"]);
});

teste("passo com espera aparece com o ATRASO acumulado (a regua fica visivel na tela)", () => {
  const f = valido({
    ...fluxoLinear({ id: "r", nome: "R" }, [
      { tipo: "enviar_texto", texto: "agora" },
      { tipo: "espera", segundos: 172800 },
      { tipo: "enviar_texto", texto: "depois" },
    ]),
    tipo: "gatilho",
  });
  const s = simularFluxo(entradaDe(f), { texto: "oi" });
  const ultimo = s.passos[s.passos.length - 1];
  assert.equal(ultimo.atraso_segundos, 172800);
  assert.equal(s.passos[0].atraso_segundos, 0);
});

teste("passo que pede APROVACAO aparece como parada, e o resto sai como pendente do aval", () => {
  const f = valido({
    id: "p",
    nome: "P",
    tipo: "gatilho",
    versao: 1,
    nos: [
      { id: "n1", tipo: "acao", aprovacao: true, acao: { tipo: "enviar_texto", texto: "proposta" }, proximo: "n2" },
      { id: "n2", tipo: "acao", acao: { tipo: "nota_interna", texto: "enviada" } },
    ],
  });
  const s = simularFluxo(entradaDe(f), { texto: "oi" });
  assert.equal(s.passos[0].aprovacao, true);
  assert.equal(s.passos[0].situacao, "parou");
  assert.match(s.passos[0].detalhe, /PARARIA esperando aprovacao/);
  assert.deepEqual(s.textos, [], "o texto NAO sairia sem o aval");
  assert.equal(s.responderia, false);
  assert.match(s.passos[1].detalhe, /aprovacao do passo anterior/);
});

teste("varios elegiveis: o simulador NAO inventa vencedor — ele diz o criterio", () => {
  const a = valido({ ...gatilhoOi, id: "a", nome: "A" });
  const b = valido({ ...gatilhoOi, id: "b", nome: "B" });
  const r = simularMensagem([entradaDe(a), entradaDe(b)], { texto: "oi" }, ["texto"]);
  assert.equal(r.elegiveis, 2);
  assert.equal(r.primeiro, "a", "o primeiro e o primeiro DA ORDEM RECEBIDA");
  assert.match(r.criterio_de_ordem, /Prioridade entre fluxos elegiveis ainda NAO existe/);
  assert.ok(r.ressalvas.some((x) => /2 fluxos responderiam/.test(x)));
});

teste("campo de condicao NAO informado sai como ressalva (fail-closed nao pode parecer 'nao dispara')", () => {
  const f = valido({
    id: "e",
    nome: "E",
    tipo: "gatilho",
    versao: 1,
    nos: [
      {
        id: "n1",
        tipo: "condicao",
        condicao: { tipo: "comparacao", campo: "etapa", operador: "igual", funil: "Vendas", valor: "Novo" },
        proximo: "n2",
      },
      { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "x" } },
    ],
  });
  const r = simularMensagem([entradaDe(f)], { texto: "oi" }, ["texto"]);
  assert.equal(r.fluxos[0].elegivel, false);
  assert.ok(
    r.ressalvas.some((x) => /etapa/.test(x) && /AUSENTES/.test(x)),
    "quem le tem que saber que faltou informar a etapa"
  );
});

teste("responder carrega a ressalva honesta sobre o status (a config nao e chutada)", () => {
  const s = simularFluxo(entradaDe(gatilhoOi), { texto: "oi" });
  assert.ok(s.ressalvas.some((x) => /Em atendimento/.test(x)));
  // e a ressalva nao se repete por mensagem enviada
  assert.equal(new Set(s.ressalvas).size, s.ressalvas.length);
});

// ================================= 10) GUARDA DE ARQUITETURA (o que a prova trava)
console.log("\n10) GUARDA DE ARQUITETURA — o que nao pode voltar a importar");

const leia = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const importsDe = (fonte: string) =>
  [...fonte.matchAll(/^\s*import[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);

teste("lib/fluxo/fila.ts importa SO ./schema.ts (senao a corrida perde a prova)", () => {
  assert.deepEqual(importsDe(leia("../lib/fluxo/fila.ts")), ["./schema.ts"]);
});

teste("lib/fluxo/simulador.ts importa SO ./schema.ts — ZERO caminho pra enviar mensagem", () => {
  const fonte = leia("../lib/fluxo/simulador.ts");
  assert.deepEqual(importsDe(fonte), ["./schema.ts"]);
  for (const proibido of ["mensageria", "executar", "zapi", "gupshup", "fetch("]) {
    assert.equal(fonte.includes(proibido), false, `simulador NAO pode referenciar ${proibido}`);
  }
});

teste("lib/fluxo/schema.ts continua com ZERO import (contrato publico do formato)", () => {
  assert.deepEqual(importsDe(leia("../lib/fluxo/schema.ts")), []);
});

teste("lib/fluxo/fila-relogio.ts importa so lib/fuso.ts e o tipo da fila", () => {
  assert.deepEqual(importsDe(leia("../lib/fluxo/fila-relogio.ts")), ["../fuso.ts", "./fila.ts"]);
});

teste("a fila NAO importa lib/disparo (o padrao do claim e copiado, nao acoplado)", () => {
  // A checagem e sobre IMPORT, nao sobre mencao: `fila.ts` CITA lote.ts num
  // comentario de proposito, pra quem for mexer saber de onde o protocolo veio.
  // Comparar o texto cru transformaria a documentacao honesta em reprovacao.
  for (const arquivo of ["../lib/fluxo/fila.ts", "../lib/fluxo/fila-db.ts", "../lib/fluxo/simulador.ts"]) {
    const alvos = importsDe(leia(arquivo));
    assert.equal(
      alvos.some((a) => a.includes("disparo")),
      false,
      `${arquivo} nao pode depender do modulo de disparo (a instalacao pode nao te-lo ligado)`
    );
  }
});

// A guarda de HTML cru (`dangerouslySetInnerHTML`/`innerHTML`) nas superficies de
// fluxo NAO e refeita aqui: ela ja existe em `scripts/prova-editor-fluxo.ts`, que
// cobre `app/fluxos/page.tsx` e `app/api/fluxos/route.ts` — os dois arquivos que
// esta frente tambem mexeu. Duas copias da mesma regra e uma copia que diverge; a
// prova daquela frente continua rodando na bateria.

/** Tira comentario de linha e de bloco: a guarda e sobre CODIGO, nao sobre o texto. */
const semComentario = (fonte: string) =>
  fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// A COTA CONTA SO O QUE O CLIENTE RECEBEU. Defeito que EU introduzi no card do
// passo desligado (86ak85nzy) e que a revisao cega pegou: a trilha passou a
// receber linha `pulado`, e a contagem de `maximo_por_conversa` nao filtrava
// status — desligar um passo QUEIMAVA a cota sem o cliente receber nada, que e
// exatamente o defeito que aquele bloco existe pra evitar (o caso medido:
// `maximo_por_conversa: 1` nos 79 dialogos de saudacao, e um cancelamento fazia a
// saudacao nunca mais sair naquela conversa).
//
// Guarda de FONTE por necessidade: a contagem e uma consulta PostgREST, e provar o
// numero exigiria banco. A guarda cobra a coisa exata que uma refatoracao
// distraida desfaz — e cobra nas DUAS leituras (contagem e `ultima_em`), porque
// filtrar so uma deixaria o intervalo minimo contando passo que nao saiu.
teste("a cota por conversa conta so passo com status ok (passo pulado nao queima cota)", () => {
  const fonte = semComentario(leia("../lib/fluxo/fila-db.ts"));
  // SO a funcao que apura os limites: `jaExecutado` tambem filtra status ok, por
  // outro motivo (idempotencia), e contar o arquivo inteiro faria a guarda passar
  // mesmo com a cota desfiltrada.
  const i = fonte.indexOf("async function historicoDaConversa");
  const fim = fonte.indexOf("function itemDaLinha", i);
  assert.ok(i > 0 && fim > i, "achou a funcao que apura os limites por conversa");
  const apuracao = fonte.slice(i, fim);
  assert.equal(
    (apuracao.match(/\.eq\("status", "ok"\)/g) || []).length,
    2,
    "as DUAS leituras da trilha (contagem de execucoes e ultima_em) filtram status ok — filtrar so uma deixaria o intervalo minimo contando passo que nao saiu"
  );
  assert.ok(/fluxo_execucoes/.test(apuracao), "e a apuracao continua saindo da TRILHA, nao da fila");
});

teste("a migration 0018 nao e executada por codigo nenhum (DDL e gesto humano)", () => {
  for (const arquivo of [
    "../lib/fluxo/fila.ts",
    "../lib/fluxo/fila-db.ts",
    "../app/api/fluxo-fila/route.ts",
    "../app/api/cron-fluxos/route.ts",
  ]) {
    const fonte = semComentario(leia(arquivo));
    assert.equal(/create\s+(table|index)/i.test(fonte), false, `${arquivo} nao pode criar tabela nem indice`);
    assert.equal(/alter\s+table/i.test(fonte), false, `${arquivo} nao pode alterar tabela`);
  }
});

teste("todo update de estado da fila leva GUARDA DE ESTADO (.eq('estado', ...))", () => {
  // Licao paga no disparo: sem a guarda, o update final gravava `concluida` POR
  // CIMA de `cancelada` e o cancelamento sumia do registro. Aqui a conta e simples:
  // cada `.update(` da fila tem que ter um `.eq("estado"` ou um `.in("estado"` por
  // perto.
  const fonte = semComentario(leia("../lib/fluxo/fila-db.ts"));
  const blocos = fonte.split(/\.from\("fluxo_fila"\)/).slice(1);
  const updates = blocos.filter((b) => /^\s*\n?\s*\.update\(/.test(b) || b.slice(0, 400).includes(".update("));
  assert.ok(updates.length >= 6, `esperava varios updates na fila, achei ${updates.length}`);
  for (const b of updates) {
    const trecho = b.slice(0, 1200);
    assert.ok(
      /\.eq\("estado"/.test(trecho) || /\.in\("estado"/.test(trecho),
      `update de fluxo_fila sem guarda de estado:\n${trecho.slice(0, 200)}`
    );
  }
});

// ============================ 11) A FIACAO ESTA FIADA (mutation testing na mao)
//
// POR QUE ESTA SECAO EXISTE, e ela e a licao mais caras desta frente: a lib PURA
// (`fila.ts`) esta presa por prova de comportamento — mudar uma decisao la derruba a
// bateria. A FIACAO (`fila-db.ts`) nao estava presa por NADA: a re-revisao provou por
// mutacao que era possivel apagar um filtro da consulta e a bateria inteira seguir
// verde, porque o fake da porta implementava a semantica CERTA enquanto o SQL de
// verdade fazia outra coisa. Foi exatamente assim que passou o defeito que fazia 100%
// das aprovacoes nunca enviarem (o `jaExecutado` contando linha `pulado`).
//
// Prova de comportamento contra o Postgres exige banco, e esta frente nao tem banco.
// O que da pra travar sem banco e o TEXTO da consulta — no mesmo espirito da guarda
// `.eq("estado")` que ja existe acima. E pouco, e e honesto: cada assertion aqui
// corresponde a um defeito que JA aconteceu, nao a um estilo preferido.
console.log("\n11) FIACAO — os filtros do SQL que a prova pura nao alcanca");

{
  const fiacao = semComentario(leia("../lib/fluxo/fila-db.ts"));

  /** o corpo de uma funcao da fiacao, do nome dela ate a proxima na mesma coluna */
  const corpoDe = (nome: string) => {
    const i = fiacao.indexOf(nome);
    assert.ok(i > 0, `nao achei ${nome} em fila-db.ts`);
    return fiacao.slice(i, i + 1400);
  };

  teste("jaExecutado filtra status 'ok' — linha 'pulado'/'falhou' NAO conta como executado", () => {
    const corpo = corpoDe("async jaExecutado");
    assert.match(
      corpo,
      /\.eq\("status",\s*"ok"\)/,
      "sem isto, a linha 'pulado' que a PARADA PRA APROVACAO grava faz o passo aprovado " +
        "ser pulado (a mensagem nunca sai) e a linha 'falhou' transforma retry em skip"
    );
  });

  teste("a varredura de orfas alcanca reserva com carimbo NULO", () => {
    const corpo = corpoDe("export async function liberarReservasOrfas");
    assert.match(
      corpo,
      /reservado_em\.is\.null/,
      "carimbo nulo em linha `executando` e o estado que uma piscada do banco deixava para tras: " +
        "sem este termo, a cadeia ficava congelada pra sempre fora do alcance da varredura"
    );
    assert.match(corpo, /reservado_em\.lt\./, "e a reserva VELHA continua sendo o caso normal");
  });

  teste("candidatos ordena por disponivel_em PRIMEIRO (FIFO por hora)", () => {
    const corpo = corpoDe("async candidatos");
    const ordens = [...corpo.matchAll(/\.order\("([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(ordens.length >= 3, `esperava varios .order, achei ${ordens.length}`);
    assert.equal(
      ordens[0],
      "disponivel_em",
      "ordenar por canal/chat antes da hora faz a fila atender por ordem ALFABETICA de conversa"
    );
  });

  teste("candidatosAguardandoAval ordena por atualizada_em PRIMEIRO (a parada mais ANTIGA)", () => {
    // A guarda irma da de cima, e ela existe por um motivo medido na re-revisao de
    // 31/08/2026: o FAKE da porta ordenava por canal/chat_id enquanto esta consulta
    // ordena por hora de atualizacao. Fake desalinhado da fiacao e prova que mede a
    // ordem ERRADA — e a janela e `teto * 2`, entao e a ordem que decide quem entra
    // nela quando ha mais paradas que o teto. Por hora de atualizacao, quem espera
    // ha mais tempo sai primeiro; por canal/chat_id, sairia quem tem o nome
    // alfabeticamente menor (o mesmo defeito que a ordem dos candidatos evita).
    const corpo = corpoDe("async candidatosAguardandoAval");
    const ordens = [...corpo.matchAll(/\.order\("([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(ordens.length >= 1, `esperava .order na consulta das paradas, achei ${ordens.length}`);
    assert.equal(
      ordens[0],
      "atualizada_em",
      "a parada mais ANTIGA e a que ja esperou mais: ordenar por canal/chat antes disso atende por ordem alfabetica"
    );
    assert.match(corpo, /\.eq\("estado",\s*"aguardando_aprovacao"\)/, "e ela le SO as paradas em aval");
  });

  teste("estadoAtual tem caminho de ERRO proprio (ok:false), nao devolve 'cancelado'", () => {
    const corpo = corpoDe("async estadoAtual");
    assert.match(corpo, /ok:\s*false/, "erro de leitura tratado como cancelamento congelava a cadeia");
    assert.match(corpo, /if\s*\(error\)/, "o erro tem que ser TESTADO, nao ignorado");
  });

  teste("a parada pra aval escreve em `aviso`, nunca em `erro`", () => {
    const corpo = corpoDe("async pararParaAprovacao");
    assert.match(corpo, /aviso:\s*motivo/, "esperar aval nao e erro: a tela pinta erro de vermelho");
    assert.equal(
      /erro:\s*motivo/.test(corpo),
      false,
      "escrever o motivo da parada em `erro` apagava a ultima falha real da cadeia"
    );
  });
}

{
  const rota = semComentario(leia("../app/api/fluxo-fila/route.ts"));
  const ramoDeAprovar = rota.slice(
    rota.indexOf('acao === "aprovar"'),
    rota.indexOf('acao === "cancelar"')
  );

  teste("o ramo aprovar/recusar recusa CHAVE DE API (robo nao aprova)", () => {
    assert.ok(ramoDeAprovar.length > 100, "nao achei o ramo de aprovar na rota");
    assert.match(
      ramoDeAprovar,
      /identidadePorApiKey\(req\)/,
      "aprovar existe pra uma PESSOA responder pelo que sai; chave de API aprovando torna o campo enfeite"
    );
    assert.match(ramoDeAprovar, /aprovar_automacao/, "e a permissao propria continua sendo exigida");
  });
}

console.log(`\n=== ${checagens} checagens, todas passaram ===\n`);
