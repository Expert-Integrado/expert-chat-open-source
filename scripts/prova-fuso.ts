// Prova do fuso por INSTALACAO (lib/fuso.ts).
// Roda em Node >= 22.6 sem build: `node scripts/prova-fuso.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// Tudo aqui e PURO: nenhuma env de instalacao, nenhum banco, nenhuma empresa.
// Os fusos usados sao propositalmente VARIADOS (America/Sao_Paulo, Europe/Lisbon,
// Pacific/Kiritimati, America/New_York) — a regra e "nada assume o fuso de
// ninguem", e um teste que so olha Brasilia nao prova isso.
import assert from "node:assert/strict";
import {
  FUSO_FABRICA,
  dentroDaJanela,
  diaNoFuso,
  formatarData,
  formatarDataHora,
  formatarHora,
  fusoDoEnv,
  fusoValido,
  horaMinutoNoFuso,
  horaNoFuso,
  isoDeLocal,
  localDeIso,
  mesmoDiaNoFuso,
  offsetMinutos,
  partesNoFuso,
  resolverFuso,
  rotuloDiaNoFuso,
} from "../lib/fuso.ts";

const SP = "America/Sao_Paulo";
const NY = "America/New_York";
const LISBOA = "Europe/Lisbon";
const KIRITIMATI = "Pacific/Kiritimati"; // UTC+14, o fuso mais adiantado do mundo

// ==================================================== 1) VALIDACAO DE FUSO
{
  assert.equal(fusoValido(SP), true);
  assert.equal(fusoValido("Europe/Lisbon"), true);
  assert.equal(fusoValido("UTC"), true);
  assert.equal(fusoValido("America/Nao_Existe"), false, "fuso inventado nao passa");
  assert.equal(fusoValido(""), false);
  assert.equal(fusoValido("   "), false);
  assert.equal(fusoValido(null), false);
  assert.equal(fusoValido(123), false);
  assert.equal(fusoValido({ tz: SP }), false);
}

// ============================================= 2) A DECISAO: config > env > fabrica
{
  delete process.env.FUSO_INSTALACAO;
  delete process.env.NEXT_PUBLIC_FUSO_INSTALACAO;
  assert.equal(fusoDoEnv(), null, "sem env, fusoDoEnv nao inventa nada");
  assert.equal(resolverFuso(undefined), FUSO_FABRICA, "sem nada, vale o default de fabrica");
  assert.equal(FUSO_FABRICA, SP, "o default de fabrica esta documentado como America/Sao_Paulo");

  process.env.FUSO_INSTALACAO = LISBOA;
  assert.equal(fusoDoEnv(), LISBOA);
  assert.equal(resolverFuso(undefined), LISBOA, "env vence a fabrica");
  assert.equal(resolverFuso(""), LISBOA, "config vazia = nao definida: cai na env");
  assert.equal(resolverFuso(NY), NY, "config VENCE a env");
  assert.equal(resolverFuso("America/Nao_Existe"), LISBOA, "config invalida e ignorada, nao quebra");

  process.env.FUSO_INSTALACAO = "lixo/invalido";
  assert.equal(fusoDoEnv(), null, "env invalida nao vale");
  assert.equal(resolverFuso(undefined), FUSO_FABRICA, "env invalida cai na fabrica");

  delete process.env.FUSO_INSTALACAO;
  process.env.NEXT_PUBLIC_FUSO_INSTALACAO = KIRITIMATI;
  assert.equal(fusoDoEnv(), KIRITIMATI, "a env publica (bundle do navegador) tambem vale");
  delete process.env.NEXT_PUBLIC_FUSO_INSTALACAO;
}

// ===================================================== 3) PARTES E OFFSET
{
  // 2026-08-31T02:30:00Z = 30/08 23:30 em Sao Paulo (UTC-3) — dia ANTERIOR
  const d = new Date("2026-08-31T02:30:00.000Z");
  const sp = partesNoFuso(d, SP);
  assert.deepEqual(
    { ano: sp.ano, mes: sp.mes, dia: sp.dia, hora: sp.hora, minuto: sp.minuto },
    { ano: 2026, mes: 8, dia: 30, hora: 23, minuto: 30 }
  );
  assert.equal(sp.diaSemana, 0, "30/08/2026 e domingo");
  assert.equal(offsetMinutos(d, SP), -180, "Sao Paulo = UTC-3 (sem horario de verao desde 2019)");
  assert.equal(diaNoFuso(d, SP), "2026-08-30");
  assert.equal(horaMinutoNoFuso(d, SP), "23:30");
  assert.equal(horaNoFuso(d, SP), 23);

  // o MESMO instante e 30/08 em SP, 31/08 em Lisboa e 16:30 de 31/08 em Kiritimati
  assert.equal(diaNoFuso(d, LISBOA), "2026-08-31", "mesmo instante, outro dia civil");
  assert.equal(diaNoFuso(d, KIRITIMATI), "2026-08-31");
  assert.equal(horaMinutoNoFuso(d, KIRITIMATI), "16:30");
  assert.equal(offsetMinutos(d, KIRITIMATI), 14 * 60);
  // e a virada de MES acontece em dias diferentes conforme o fuso
  const viradaMes = new Date("2026-08-31T11:00:00.000Z");
  assert.equal(diaNoFuso(viradaMes, SP), "2026-08-31", "ainda agosto em Sao Paulo");
  assert.equal(diaNoFuso(viradaMes, KIRITIMATI), "2026-09-01", "ja e setembro em Kiritimati");
  assert.equal(offsetMinutos(d, "UTC"), 0);

  // horario de verao entra sozinho: Nova York muda de -300 pra -240
  assert.equal(offsetMinutos(new Date("2026-01-15T12:00:00Z"), NY), -300, "NY no inverno = UTC-5");
  assert.equal(offsetMinutos(new Date("2026-07-15T12:00:00Z"), NY), -240, "NY no verao = UTC-4");

  // fuso com offset quebrado (meia hora) nao pode ser arredondado
  assert.equal(offsetMinutos(new Date("2026-07-15T12:00:00Z"), "Asia/Kolkata"), 330, "India = UTC+5:30");
  assert.equal(offsetMinutos(new Date("2026-07-15T12:00:00Z"), "Asia/Kathmandu"), 345, "Nepal = UTC+5:45");
}

// ======================================== 4) "MESMO DIA" E O DIA DA INSTALACAO
{
  // 23:30 e 00:30 em Sao Paulo: 1 hora de distancia, DIAS diferentes
  const a = new Date("2026-08-31T02:30:00.000Z"); // 30/08 23:30 SP
  const b = new Date("2026-08-31T03:30:00.000Z"); // 31/08 00:30 SP
  assert.equal(mesmoDiaNoFuso(a, b, SP), false, "1h de diferenca pode ser outro DIA");
  assert.equal(mesmoDiaNoFuso(a, b, LISBOA), true, "e o mesmo dia em Lisboa — o dia e do fuso");

  // 20h de distancia dentro do mesmo dia civil
  const manha = new Date("2026-08-31T03:00:00.000Z"); // 00:00 SP
  const noite = new Date("2026-08-31T23:00:00.000Z"); // 20:00 SP
  assert.equal(mesmoDiaNoFuso(manha, noite, SP), true, "20h de diferenca ainda e o mesmo dia");
}

// ================================== 5) JANELA DE HORARIO DE ATENDIMENTO
{
  const util = [1, 2, 3, 4, 5]; // seg a sex
  // segunda 2026-08-31, 12:00 SP = 15:00Z
  const segMeioDia = new Date("2026-08-31T15:00:00.000Z");
  assert.equal(dentroDaJanela(segMeioDia, SP, util, "09:00", "18:00"), true);
  // o MESMO instante em Kiritimati ja e terca 05:00 — fora da janela
  assert.equal(dentroDaJanela(segMeioDia, KIRITIMATI, util, "09:00", "18:00"), false, "o fuso decide o dia E a hora");

  // borda: inicio inclusivo, fim EXCLUSIVO
  assert.equal(dentroDaJanela(new Date("2026-08-31T12:00:00.000Z"), SP, util, "09:00", "18:00"), true, "09:00 em ponto esta dentro");
  assert.equal(dentroDaJanela(new Date("2026-08-31T21:00:00.000Z"), SP, util, "09:00", "18:00"), false, "18:00 em ponto ja esta fora");
  assert.equal(dentroDaJanela(new Date("2026-08-31T20:59:00.000Z"), SP, util, "09:00", "18:00"), true, "17:59 esta dentro");

  // domingo (2026-08-30) nunca entra numa escala seg-sex
  assert.equal(dentroDaJanela(new Date("2026-08-30T15:00:00.000Z"), SP, util, "09:00", "18:00"), false, "domingo fora da escala");
  assert.equal(dentroDaJanela(new Date("2026-08-30T15:00:00.000Z"), SP, [0], "09:00", "18:00"), true, "escala so-domingo aceita domingo");

  // dias vazio = nunca dentro (escala em branco nao vira 24/7 por acidente)
  assert.equal(dentroDaJanela(segMeioDia, SP, [], "09:00", "18:00"), false);

  // janela que cruza a meia-noite (plantao 22h-06h)
  const segNoite = new Date("2026-09-01T02:00:00.000Z"); // 31/08 23:00 SP (segunda)
  const terMadrugada = new Date("2026-09-01T06:00:00.000Z"); // 01/09 03:00 SP (terca)
  assert.equal(dentroDaJanela(segNoite, SP, [1], "22:00", "06:00"), true, "23h de segunda entra no plantao de segunda");
  assert.equal(dentroDaJanela(terMadrugada, SP, [1], "22:00", "06:00"), true, "a madrugada pertence ao plantao do dia anterior");
  assert.equal(dentroDaJanela(terMadrugada, SP, [2], "22:00", "06:00"), false, "e nao ao plantao do proprio dia");
  assert.equal(dentroDaJanela(new Date("2026-09-01T15:00:00.000Z"), SP, [1], "22:00", "06:00"), false, "meio-dia fora do plantao");

  // hora malformada nao "abre" a janela: fail-closed
  assert.equal(dentroDaJanela(segMeioDia, SP, util, "9h", "18:00"), false);
  assert.equal(dentroDaJanela(segMeioDia, SP, util, "09:00", "25:00"), false);
}

// =============================================== 6) FORMATACAO PRA HUMANO
{
  const d = new Date("2026-08-31T02:30:00.000Z");
  assert.equal(formatarData(d, SP), "30/08/26");
  assert.equal(formatarHora(d, SP), "23:30");
  assert.equal(formatarDataHora(d, SP), "30/08/26 23:30");
  assert.equal(formatarDataHora(d, LISBOA), "31/08/26 03:30", "o mesmo instante, no fuso da instalacao");
  assert.equal(formatarDataHora(d.toISOString(), SP), "30/08/26 23:30", "aceita string ISO");

  // meia-noite sai como 00:00, nunca como 24:00
  assert.equal(formatarHora(new Date("2026-08-31T03:00:00.000Z"), SP), "00:00");

  // data invalida nao vira "Invalid Date" na tela
  assert.equal(formatarDataHora("nao sou data", SP), "");
  assert.equal(formatarData("", SP), "");
  assert.equal(rotuloDiaNoFuso("nao sou data", SP), "");

  // Hoje/Ontem cortados pelo dia da INSTALACAO
  const agora = new Date("2026-08-31T14:00:00.000Z"); // 11:00 SP, segunda
  assert.equal(rotuloDiaNoFuso(new Date("2026-08-31T13:00:00.000Z"), SP, agora), "Hoje");
  assert.equal(rotuloDiaNoFuso(new Date("2026-08-31T02:30:00.000Z"), SP, agora), "Ontem", "23:30 de ontem em SP");
  assert.equal(rotuloDiaNoFuso(new Date("2026-08-31T02:30:00.000Z"), LISBOA, agora), "Hoje", "o mesmo instante e HOJE em Lisboa");
  assert.equal(rotuloDiaNoFuso(new Date("2026-08-29T13:00:00.000Z"), SP, agora), "29/08/26", "anteontem vira data");
}

// ============================= 7) IDA E VOLTA COM O CAMPO datetime-local
{
  // o que o atendente digita vale como hora DA INSTALACAO, nao do navegador dele
  assert.equal(isoDeLocal("2026-08-31T14:30", SP), "2026-08-31T17:30:00.000Z");
  assert.equal(isoDeLocal("2026-08-31T14:30", LISBOA), "2026-08-31T13:30:00.000Z");
  assert.equal(isoDeLocal("2026-08-31T14:30", "UTC"), "2026-08-31T14:30:00.000Z");
  assert.equal(isoDeLocal("2026-01-15T09:00", NY), "2026-01-15T14:00:00.000Z", "NY no inverno (UTC-5)");
  assert.equal(isoDeLocal("2026-07-15T09:00", NY), "2026-07-15T13:00:00.000Z", "NY no verao (UTC-4)");

  assert.equal(isoDeLocal("", SP), null);
  assert.equal(isoDeLocal("31/08/2026 14:30", SP), null, "formato do input e YYYY-MM-DDTHH:MM");
  assert.equal(isoDeLocal(null as any, SP), null);

  // ida e volta fecha em todos os fusos testados
  for (const fuso of [SP, LISBOA, NY, KIRITIMATI, "Asia/Kathmandu", "UTC"]) {
    for (const local of ["2026-01-15T09:00", "2026-07-15T23:59", "2026-11-01T00:00"]) {
      const iso = isoDeLocal(local, fuso)!;
      assert.equal(localDeIso(iso, fuso), local, `ida e volta em ${fuso} pra ${local}`);
    }
  }

  // virada do horario de verao em NY: 08/03/2026 02:00 nao existe (relogio pula
  // pras 03:00). Nao pode virar Invalid Date — cai numa hora real.
  const pulada = isoDeLocal("2026-03-08T02:30", NY);
  assert.ok(pulada && !isNaN(new Date(pulada).getTime()), "hora inexistente ainda produz instante valido");
  assert.equal(localDeIso(pulada!, NY), "2026-03-08T03:30", "a hora que nao existe cai na seguinte");
  assert.equal(pulada, "2026-03-08T07:30:00.000Z");

  // saida do horario de verao em NY: 01/11/2026 01:30 acontece DUAS vezes.
  // Vale a primeira ocorrencia (ainda em EDT, UTC-4).
  const ambigua = isoDeLocal("2026-11-01T01:30", NY);
  assert.equal(ambigua, "2026-11-01T05:30:00.000Z", "hora ambigua = primeira ocorrencia");
  assert.equal(localDeIso(ambigua!, NY), "2026-11-01T01:30", "e ela fecha a ida e volta");
}

console.log("prova-fuso: OK — validacao, precedencia config>env>fabrica, offset com horario de verao, dia/janela por fuso, formatacao e ida-e-volta do datetime-local");
