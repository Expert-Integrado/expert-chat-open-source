// Prova das funcoes puras dos relatorios operacionais (Frente J).
// Roda em Node >= 22.6 sem build e SEM BANCO: `node scripts/prova-relatorios.ts`
// (type stripping nativo; os `import type` das libs sao apagados, entao o
// alias @/ nao precisa existir em runtime).
//
// O que esta prova cobre: matriz departamento x status, avaliacao de alerta
// agendado, serializacao CSV e o pulo de fim de semana. O que ela NAO cobre e
// declarado no fim.
import assert from "node:assert/strict";
import {
  acumular,
  csvCampo,
  diaDaSemanaDaData,
  diaDaSemanaLocal,
  diaLocal,
  diasIgnorados,
  erroSeguro,
  filtrarDias,
  funcaoAusente,
  horaLocal,
  montarMatriz,
  nomeArquivoCsv,
  paraCsv,
  segundosUteis,
} from "../lib/relatorios.ts";
import {
  alertasDevidos,
  chaveDisparo,
  esperaLegivel,
  normalizarAlertas,
  podarEstado,
  textoAlerta,
} from "../lib/alertas-sla.ts";

const SP = "America/Sao_Paulo";
const H = 3600;
// 2026-08-28 = sexta | 29 = sabado | 30 = domingo | 31 = segunda
const sexta18 = new Date("2026-08-28T21:00:00Z"); // 18:00 BRT
const domingo12 = new Date("2026-08-30T15:00:00Z"); // 12:00 BRT
const segunda09 = new Date("2026-08-31T12:00:00Z"); // 09:00 BRT

// ===========================================================================
// 1) Datas no fuso da instalacao
// ===========================================================================
assert.equal(diaDaSemanaLocal(sexta18, SP), 5, "28/08/2026 e sexta");
assert.equal(diaDaSemanaLocal(segunda09, SP), 1, "31/08/2026 e segunda");
assert.equal(diaLocal(sexta18, SP), "2026-08-28");
assert.equal(horaLocal(sexta18, SP), "18:00");
// meia-noite BRT e 03:00Z: o dia LOCAL nao e o dia UTC
assert.equal(diaLocal(new Date("2026-08-29T01:00:00Z"), SP), "2026-08-28", "22:00 BRT ainda e dia 28");
assert.equal(diaLocal(new Date("2026-08-29T01:00:00Z"), "UTC"), "2026-08-29", "em UTC ja virou dia 29");

// ===========================================================================
// 2) segundosUteis — o coracao do "ignorar sabado/domingo"
// ===========================================================================
// sexta 18h -> segunda 9h: 63h no relogio, 15h uteis. E o caso do card.
assert.equal(segundosUteis(sexta18, segunda09, SP, []), 63 * H, "sem pular nada, 63h corridas");
assert.equal(segundosUteis(sexta18, segunda09, SP, [0, 6]), 15 * H, "sexta 18h -> segunda 9h = 15h uteis");

// sabado e domingo sao INDEPENDENTES (criterio do card): o mesmo intervalo da
// numero DIFERENTE conforme qual caixinha esta marcada
assert.equal(segundosUteis(sexta18, domingo12, SP, []), 42 * H);
assert.equal(segundosUteis(sexta18, domingo12, SP, [6]), 18 * H, "so ignorando sabado: 6h sexta + 12h domingo");
assert.equal(segundosUteis(sexta18, domingo12, SP, [0]), 30 * H, "so ignorando domingo: 6h sexta + 24h sabado");
assert.equal(segundosUteis(sexta18, domingo12, SP, [0, 6]), 6 * H, "ignorando os dois: so as 6h de sexta");

// intervalo inteiro dentro de dia ignorado = zero
const sab10 = new Date("2026-08-29T13:00:00Z");
const sab18 = new Date("2026-08-29T21:00:00Z");
assert.equal(segundosUteis(sab10, sab18, SP, [6]), 0, "8h de sabado somem inteiras");
assert.equal(segundosUteis(sab10, sab18, SP, [0]), 8 * H, "ignorar domingo nao mexe no sabado");

// bordas
assert.equal(segundosUteis(segunda09, sexta18, SP, [0, 6]), 0, "fim antes do inicio = 0");
assert.equal(segundosUteis(sexta18, sexta18, SP, [0, 6]), 0, "intervalo nulo = 0");

// o FUSO decide de quem e o dia: 22:00 de sexta em Sao Paulo ja e sabado em UTC
const sexta22 = new Date("2026-08-29T01:00:00Z");
const sexta23 = new Date("2026-08-29T02:00:00Z");
assert.equal(segundosUteis(sexta22, sexta23, SP, [6]), 1 * H, "em Sao Paulo ainda e sexta: a hora conta");
assert.equal(segundosUteis(sexta22, sexta23, "UTC", [6]), 0, "em UTC ja e sabado: a hora sai da conta");

// ===========================================================================
// 3) diasIgnorados — as duas caixinhas e o atalho
// ===========================================================================
const p = (qs: string) => diasIgnorados(new URLSearchParams(qs));
assert.deepEqual(p(""), [], "sem parametro, nada e ignorado");
assert.deepEqual(p("ignorar_sabado=1"), [6]);
assert.deepEqual(p("ignorar_domingo=1"), [0]);
assert.deepEqual(p("ignorar_sabado=1&ignorar_domingo=1"), [0, 6]);
assert.deepEqual(p("ignorar_fds=1"), [0, 6], "o atalho liga os dois");
assert.deepEqual(p("ignorar_sabado=0"), [], "valor falso nao liga");

// ===========================================================================
// 4) Matriz departamento/usuario x status
// ===========================================================================
const matriz = montarMatriz({
  linhas: [
    { tipo: "departamento", ref_id: "d1", nome: "Comercial", status: "aberto", n: 31 },
    { tipo: "departamento", ref_id: "d1", nome: "Comercial", status: "atendimento", n: 90 },
    { tipo: "departamento", ref_id: "d1", nome: "Comercial", status: "aguardando", n: 46 },
    { tipo: "departamento", ref_id: "d2", nome: "Suporte", status: "aberto", n: 5 },
    { tipo: "departamento", ref_id: "d2", nome: "Suporte", status: "atendimento", n: 11 },
    { tipo: "usuario", ref_id: "u1", nome: "Atendente A", status: "atendimento", n: 7 },
    { tipo: "contexto", ref_id: "x", nome: "ruido", status: "aberto", n: 999 },
  ],
  sem_dono: [
    { status: "aberto", n: 37 },
    { status: "atendimento", n: 2 },
    { status: "aguardando", n: 1 },
  ],
  totais: [
    { status: "aberto", n: 144 },
    { status: "atendimento", n: 274 },
    { status: "aguardando", n: 173 },
  ],
});

assert.deepEqual(matriz.status.slice(0, 4), ["aberto", "atendimento", "aguardando", "concluido"], "ordem canonica");
// a linha que o gestor procura primeiro NAO e uma linha comum da matriz
assert.equal(matriz.sem_dono.total, 40, "sem responsavel soma 40");
assert.ok(
  !matriz.linhas.some((l) => l.tipo === "sem_dono"),
  "sem responsavel sai destacado, fora da lista de donos"
);
assert.equal(matriz.linhas.length, 3, "tipo desconhecido (contexto) e descartado");
assert.equal(matriz.linhas[0].nome, "Comercial", "departamento primeiro, maior carga no topo");
assert.equal(matriz.linhas[0].total, 167);
assert.equal(matriz.linhas[1].nome, "Suporte");
assert.equal(matriz.linhas[2].tipo, "usuario", "usuario depois de departamento");
assert.equal(matriz.linhas[0].contagens.concluido, 0, "coluna sem dado vem zerada, nao ausente");
// o cabecalho e a verdade: conta a conversa UMA vez, mesmo com N responsaveis
assert.equal(matriz.totais.aberto, 144);
assert.equal(matriz.total_geral, 591);
assert.deepEqual(montarMatriz({}).linhas, [], "payload vazio nao quebra");
assert.equal(montarMatriz({}).sem_dono.total, 0);

// status fora da lista canonica aparece como coluna extra, no fim
const extra = montarMatriz({ totais: [{ status: "pausado", n: 3 }] });
assert.equal(extra.status[extra.status.length - 1], "pausado");

// ===========================================================================
// 5) Series: pulo de balde e acumulado
// ===========================================================================
const serie = [
  { dia: "2026-08-28", dow: 5, n: 10 },
  { dia: "2026-08-29", dow: 6, n: 1 },
  { dia: "2026-08-30", dow: 0, n: 0 },
  { dia: "2026-08-31", dow: 1, n: 8 },
];
assert.equal(filtrarDias(serie, []).length, 4, "sem pular, serie inteira");
assert.deepEqual(filtrarDias(serie, [6]).map((x) => x.dia), ["2026-08-28", "2026-08-30", "2026-08-31"]);
assert.deepEqual(filtrarDias(serie, [0, 6]).map((x) => x.dia), ["2026-08-28", "2026-08-31"]);
// data local nao vira instante: derivar o dia da semana convertendo fuso daria
// o dia ERRADO em fuso longe de UTC (Auckland, Honolulu)
assert.equal(diaDaSemanaDaData("2026-08-29"), 6, "29/08/2026 e sabado, em qualquer fuso");
assert.equal(diaDaSemanaDaData("2026-08-31"), 1);
assert.equal(diaDaSemanaDaData("nao-e-data"), -1, "data torta nao vira dia da semana valido");
// sem `dow` no payload, deriva do proprio dia
assert.deepEqual(
  filtrarDias([{ dia: "2026-08-29" }, { dia: "2026-08-31" }], [6]).map((x) => x.dia),
  ["2026-08-31"]
);
// ACUMULADO: acumula sobre a serie COMPLETA e so depois descarta os baldes.
// O sabado trouxe 1 chat: ele existe, entra no total, e so nao aparece como
// balde. Segunda tem que fechar 119 (100 + 10 + 1 + 0 + 8).
const acumuladoCerto = filtrarDias(acumular(serie, 100), [0, 6]);
assert.deepEqual(
  acumuladoCerto.map((x) => ({ dia: x.dia, n: x.n })),
  [
    { dia: "2026-08-28", n: 110 },
    { dia: "2026-08-31", n: 119 },
  ],
  "o chat que entrou no sabado conta no total acumulado, mesmo com o balde escondido"
);
// a ordem inversa (filtrar e depois acumular) produz um total que nunca existiu
assert.equal(
  acumular(filtrarDias(serie, [0, 6]), 100).at(-1)!.n,
  118,
  "ordem trocada perde o chat do sabado — este numero e o BUG, registrado pra nao voltar"
);
// acumular preserva os campos da entrada (o `dow` inclusive), senao filtrarDias
// depois nao teria por onde decidir
assert.equal(acumular(serie, 0)[1].dow, 6);

// ===========================================================================
// 5b) Erro de RPC: so "funcao nao existe" pode virar "rodou a migration?"
// ===========================================================================
assert.equal(funcaoAusente({ code: "42883" }), true, "Postgres: function does not exist");
assert.equal(funcaoAusente({ code: "PGRST202" }), true, "PostgREST nao achou a funcao no schema cache");
assert.equal(funcaoAusente({ code: "57014" }), false, "timeout NAO e migration faltando");
assert.equal(funcaoAusente({ code: "42501" }), false, "permissao negada NAO e migration faltando");
assert.equal(funcaoAusente({ code: "PGRST203" }), false, "funcao ambigua (overload) e outro problema");
assert.equal(funcaoAusente(null), false);
assert.equal(funcaoAusente({}), false);
// mensagem pro cliente carrega o CODIGO, nunca o texto do Postgres (que traz
// SQL, nome de coluna e as vezes valor de linha)
const msgErro = erroSeguro({ code: "57014" });
assert.ok(msgErro.includes("57014"), "o codigo aparece, pra dar pra diagnosticar");
assert.ok(!/select|from|mensageria/i.test(msgErro), "nada de SQL/schema vazando pro cliente");
assert.ok(!erroSeguro({}).includes("undefined"), "sem codigo, a frase ainda fica legivel");

// ===========================================================================
// 6) CSV — escape e neutralizacao de formula
// ===========================================================================
assert.equal(csvCampo("simples"), "simples");
assert.equal(csvCampo(null), "");
assert.equal(csvCampo('diz "oi"'), '"diz ""oi"""');
assert.equal(csvCampo("a,b"), '"a,b"');
assert.equal(csvCampo("linha1\nlinha2"), '"linha1\nlinha2"');
assert.equal(csvCampo("a;b"), '"a;b"', "ponto e virgula tambem escapa (Excel pt-BR)");
// nome de contato vindo de terceiro nao pode virar formula no Excel/Sheets
assert.equal(csvCampo("=CMD()"), "'=CMD()");
assert.equal(csvCampo("+55 11 90000-0000"), "'+55 11 90000-0000");
assert.equal(csvCampo("@fulano"), "'@fulano");
assert.equal(csvCampo("-5"), "'-5");
assert.equal(
  paraCsv([{ titulo: "nome", valor: (l: any) => l.n }, { titulo: "qtd", valor: (l: any) => l.q }], [{ n: "a,b", q: 2 }]),
  'nome,qtd\r\n"a,b",2\r\n'
);
assert.equal(nomeArquivoCsv("serie-central", "2026-08-31"), "serie-central-2026-08-31.csv");
assert.equal(nomeArquivoCsv("../../etc/passwd", "x"), "etc-passwd-x.csv", "nome de arquivo sanitizado");

// ===========================================================================
// 7) Alertas de SLA — validacao da consulta salva
// ===========================================================================
const brutos = [
  {
    nome: "Sem contato ha 3 dias",
    filtro: { status: ["aguardando"], departamento: "dep-1", idade_min: 4320 },
    horarios: ["08:00"],
    ativo: true,
  },
  { nome: "Fila B sem interacao ha 7 dias", filtro: { idade_min: 10080 }, horarios: ["14:00", "08:00"] },
  { nome: "sem horario", filtro: {}, horarios: [], ativo: true },
  { nome: "horario torto", filtro: {}, horarios: ["25:00", "8:0"], ativo: true },
  { nome: "Sem contato ha 3 dias", filtro: {}, horarios: ["09:00"], ativo: true },
  { nome: "", horarios: ["09:00"] },
  "lixo",
  {
    nome: "webhook inseguro",
    horarios: ["09:00"],
    destino: { tipo: "webhook", url: "http://interno/alerta" },
    ativo: true,
  },
];
const alertas = normalizarAlertas(brutos);
assert.equal(alertas.length, 3, "descarta sem nome, sem horario, horario invalido, duplicado e lixo");
assert.equal(alertas[0].nome, "Sem contato ha 3 dias");
assert.equal(alertas[0].filtro.idade_min, 4320, "idade_min em MINUTOS (3 dias)");
assert.deepEqual(alertas[0].filtro.status, ["aguardando"]);
assert.equal(alertas[0].ativo, true);
assert.deepEqual(alertas[1].horarios, ["08:00", "14:00"], "horarios normalizados e ordenados");
assert.equal(alertas[1].ativo, false, "sem `ativo: true` explicito, o alerta nasce DESLIGADO");
assert.equal(alertas[1].filtro.status, null, "sem status = todos os status");
assert.equal(alertas[2].destino, null, "webhook http (nao https) e recusado — carrega dado de cliente");
assert.deepEqual(normalizarAlertas("nada"), []);
assert.deepEqual(normalizarAlertas(null), []);
// destino valido passa
assert.deepEqual(
  normalizarAlertas([
    { nome: "x", horarios: ["08:00"], ativo: true, destino: { tipo: "telegram", chat_id: "-1001" } },
  ])[0].destino,
  { tipo: "telegram", chat_id: "-1001" }
);

// ===========================================================================
// 8) Alertas de SLA — "esta na hora?"
// ===========================================================================
const cfg = normalizarAlertas([
  { nome: "manha", horarios: ["08:00"], filtro: { idade_min: 1440 }, ativo: true },
  { nome: "duas vezes", horarios: ["08:00", "14:00"], filtro: {}, ativo: true },
  { nome: "desligado", horarios: ["08:00"], filtro: {}, ativo: false },
]);
const HOJE = "2026-08-31";
const nomes = (hora: string, estado = {}) =>
  alertasDevidos(cfg, hora, HOJE, estado).map((d) => `${d.alerta.nome}@${d.horario}`);

assert.deepEqual(nomes("07:59"), [], "antes da hora nao dispara");
assert.deepEqual(nomes("08:00"), ["manha@08:00", "duas vezes@08:00"], "na hora exata dispara; desligado nunca");
assert.deepEqual(nomes("08:45"), ["manha@08:00", "duas vezes@08:00"], "atrasado dentro da tolerancia ainda sai");
assert.deepEqual(nomes("09:30"), [], "passou da janela: pula pro dia seguinte, nao dispara as 23h");
assert.deepEqual(nomes("14:10"), ["duas vezes@14:00"], "o segundo horario do mesmo alerta e independente");

// dedupe: ja saiu hoje neste horario, nao repete
const estado = { [chaveDisparo("manha", "08:00", HOJE)]: "2026-08-31T11:00:00Z" };
assert.deepEqual(nomes("08:30", estado), ["duas vezes@08:00"]);
// mesmo horario, dia seguinte: sai de novo
assert.deepEqual(
  alertasDevidos(cfg, "08:00", "2026-09-01", estado).map((d) => d.alerta.nome),
  ["manha", "duas vezes"]
);

// poda do estado: so os dias vivos sobrevivem (config nao vira log infinito)
const sujo = {
  [chaveDisparo("a", "08:00", "2026-08-31")]: "x",
  [chaveDisparo("a", "08:00", "2026-07-01")]: "x",
};
assert.deepEqual(Object.keys(podarEstado(sujo, ["2026-08-31", "2026-08-30"])), ["a|08:00|2026-08-31"]);

// ===========================================================================
// 9) Texto do alerta
// ===========================================================================
const agora = new Date("2026-08-31T12:00:00Z");
assert.equal(esperaLegivel("2026-08-31T11:20:00Z", agora), "40min");
assert.equal(esperaLegivel("2026-08-31T07:00:00Z", agora), "5h");
assert.equal(esperaLegivel("2026-08-28T08:00:00Z", agora), "3d 4h");
assert.equal(esperaLegivel(null, agora), "sem registro");
const texto = textoAlerta(
  cfg[0],
  "central",
  20,
  Array.from({ length: 16 }, (_, i) => ({
    chat_id: `55119${i}`,
    nome: `Contato ${i}`,
    status: "aguardando",
    last_message_at: "2026-08-28T08:00:00Z",
  })),
  agora,
  esperaLegivel
);
assert.ok(texto.startsWith("manha — 20 conversa(s) [central]"), "cabecalho traz o total real");
assert.equal(texto.split("\n").length, 17, "lista no maximo 15 + cabecalho + rodape");
assert.ok(texto.includes("... e mais 5"), "o que nao coube vira contagem, nao lista gigante");
assert.ok(texto.includes("parada ha 3d 4h"));

console.log("OK — prova-relatorios: matriz, alertas de SLA, CSV e pulo de fim de semana.");
console.log(
  "NAO coberto aqui (exige banco): mensageria.segundos_uteis (espelho SQL de segundosUteis)," +
    " relatorio_operacional, relatorio_serie e sla_conversas — provas contra a instalacao."
);
