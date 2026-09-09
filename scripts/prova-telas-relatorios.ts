// Prova das TELAS de relatorio — Frente M (cards 86ak85nz5, 86ak85bm3,
// 86ak85bkh, 86ak85bne).
//
// Roda em Node >= 22.6 sem build: `node scripts/prova-telas-relatorios.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// FIXTURES SAO SINTETICAS. Nenhum nome de cliente, telefone, chat_id ou destino
// real entra no repo — mesma regra do resto das provas deste projeto.
//
// O QUE ESTA PROVA COBRE (lib/relatorios-tela.ts, puro):
//   1. leitura defensiva do payload da rota (nada lanca, nem com payload torto)
//   2. montagem das barras: escala, empilhamento e periodo zerado
//   3. a linha do acumulado: escala piso/teto, serie plana e 1 ponto so
//   4. corte dos dias ignorados nas DUAS caixas independentes
//   5. a query da rota (sabado e domingo viajam separados)
//   6. matriz: ordem de desenho com sem-dono primeiro e o alvo do clique
//   7. formulario do alerta de SLA: o que a tela recusa e o ROUND-TRIP contra
//      normalizarAlertas (o item que a tela grava tem que sobreviver a ela)
//   8. rotulos, duracao legivel e nome do arquivo do CSV
//
// O QUE ELA **NAO** COBRE (declarado, nao esquecido): o React de
// app/relatorios-*.tsx (precisa de navegador), as funcoes SQL da 0013 (precisam
// do Postgres da instalacao) e o gate de permissao das rotas (ja coberto por
// scripts/prova-permissoes.ts). O que dava pra separar de tela e de banco foi
// separado de proposito e ESTA provado aqui.
import assert from "node:assert/strict";
import {
  DIAS_PRESET,
  FILTRO_PADRAO,
  IDADES_ALERTA,
  RASCUNHO_VAZIO,
  SEM_DONO_ALERTA,
  alertaParaRascunho,
  alvoDaCelula,
  celulaNavegavel,
  configMudouPorFora,
  cortarSeries,
  diasAPular,
  garantirOpcao,
  duracaoLegivel,
  lerOperacional,
  lerSeries,
  linhasParaDesenho,
  montarBarras,
  montarLinha,
  montarRanking,
  motivoSemExportar,
  nomeDoContentDisposition,
  nomesPerdidos,
  paramsGraficos,
  problemasDoRascunho,
  rascunhoParaAlerta,
  resumoDoFiltro,
  retratoDeAlertas,
  rotuloDia,
  rotuloIdade,
  statusParaTela,
  rotuloDiaLongo,
  rotuloPeriodo,
  avisosDaSatisfacao,
  barrasDaDistribuicao,
  classificacaoNps,
  lerSatisfacao,
  type RascunhoAlerta,
} from "../lib/relatorios-tela.ts";
import { diaLocal, inicioDoDiaLocal, montarMatriz } from "../lib/relatorios.ts";
import { MAX_ALERTAS, normalizarAlertas } from "../lib/alertas-sla.ts";

let checagens = 0;
function ok(cond: unknown, msg: string) {
  assert.ok(cond, msg);
  checagens++;
}
function igual(a: unknown, b: unknown, msg: string) {
  assert.deepEqual(a, b, msg);
  checagens++;
}

// ===========================================================================
// 1. Leitura defensiva do payload
// ===========================================================================
// A rota devolve `series: null` quando a migration 0013 nao rodou, e serie
// vazia quando o periodo nao tem dado. O criterio do card e "grafico vazio com
// aviso, NUNCA erro": nada aqui pode lancar.
for (const torto of [null, undefined, 0, "", [], "texto", { series: 1 }, { novos_chats: "x" }]) {
  const s = lerSeries(torto);
  igual(s.novos_chats, [], `payload torto (${JSON.stringify(torto)}) vira serie vazia`);
  igual(s.por_usuario, [], "por_usuario tambem");
}

// ponto sem `dia` valido e descartado (coluna sem rotulo e pior que nao desenhar)
const lidas = lerSeries({
  novos_chats: [{ dia: "2026-08-27", dow: 4, n: 3 }, { dia: "ontem", n: 9 }, { n: 1 }, null],
  mensagens: [{ dia: "2026-08-27", dow: 4, recebidas: "5", enviadas: 2 }],
  por_usuario: [{ nome: "Ana", enviadas: 2 }, { nome: null, enviadas: 7 }],
  tempo_atendimento: [{ dia: "2026-08-27", n: 2, media_s: 900, media_bruta_s: 5400 }],
});
igual(lidas.novos_chats.length, 1, "so o ponto com dia valido sobrevive");
igual(lidas.mensagens[0].recebidas, 5, "numero em texto e coagido, nao descartado");
igual(lidas.por_usuario[0].nome, "(sem registro)", "nome nulo do banco vira rotulo, nao vazio");
igual(lidas.por_usuario[0].enviadas, 7, "ranking sai ordenado por volume");
igual(lidas.tempo_atendimento[0].media_bruta_s, 5400, "o tempo BRUTO vem junto (o tamanho da mentira do fds)");

// ===========================================================================
// 2. Barras: escala e empilhamento
// ===========================================================================
const MSGS = [
  { dia: "2026-08-24", dow: 1, recebidas: 10, enviadas: 30 }, // total 40 (maior)
  { dia: "2026-08-25", dow: 2, recebidas: 5, enviadas: 5 }, // total 10
  { dia: "2026-08-26", dow: 3, recebidas: 0, enviadas: 0 }, // total 0
];
const g = montarBarras(MSGS, [
  { chave: "recebidas", valor: (p) => p.recebidas },
  { chave: "enviadas", valor: (p) => p.enviadas },
]);
igual(g.maximo, 40, "o maximo e o maior TOTAL do dia, nao o maior campo");
igual(g.total, 50, "total do periodo");
igual(g.barras[0].altura, 100, "o dia maior ocupa a altura toda");
igual(g.barras[1].altura, 25, "10 de 40 = 25% da altura");
igual(g.barras[2].altura, 0, "dia zerado nao desenha coluna");
// DUAS unidades diferentes de proposito: altura e % do grafico, fracao e % da barra
igual(g.barras[0].partes[0].fracao, 25, "10 de 40 dentro da propria barra = 25%");
igual(g.barras[0].partes[1].fracao, 75, "e 30 de 40 = 75% (o empilhamento fecha em 100)");
igual(g.barras[2].partes[0].fracao, 0, "barra zerada nao divide por zero");
ok(!g.vazio, "periodo com dado nao e vazio");
igual(g.barras[0].rotulo, "24/08", "rotulo curto da coluna");

// periodo SEM DADO: `vazio` e o que a tela usa pra mostrar o aviso em vez de erro
const gVazio = montarBarras([], [{ chave: "n", valor: (p: any) => p.n }]);
ok(gVazio.vazio, "serie sem ponto = grafico vazio");
igual(gVazio.maximo, 0, "maximo 0 (a escala minima 1 e interna, nao mentira no relatorio)");
const gZerado = montarBarras([{ dia: "2026-08-24", n: 0 }], [{ chave: "n", valor: (p: any) => p.n }]);
ok(gZerado.vazio, "periodo com dias que existem mas somam zero TAMBEM e vazio pra tela");
ok(Number.isFinite(gZerado.barras[0].altura), "e a altura segue finita (sem divisao por zero)");

// valor negativo (dado sujo) nao vira barra pra cima do eixo
const gNeg = montarBarras([{ dia: "2026-08-24", n: -5 }], [{ chave: "n", valor: (p: any) => p.n }]);
igual(gNeg.barras[0].total, 0, "valor negativo e aparado em zero");

// ===========================================================================
// 3. Linha do acumulado
// ===========================================================================
// O acumulado parte do que existia ANTES do periodo: comecar a escala no zero
// achataria a curva e esconderia o crescimento do mes inteiro.
const linha = montarLinha(
  [
    { dia: "2026-08-24", n: 1000 },
    { dia: "2026-08-25", n: 1010 },
    { dia: "2026-08-26", n: 1030 },
  ],
  300,
  100
);
igual(linha.piso, 1000, "piso = menor valor da serie, nao zero");
igual(linha.teto, 1030, "teto = maior valor");
igual(linha.pontos[0].y, 100, "o menor valor fica na base do grafico");
igual(linha.pontos[2].y, 0, "o maior valor fica no topo");
igual(linha.pontos[0].x, 0, "primeiro ponto na borda esquerda");
igual(linha.pontos[2].x, 300, "ultimo ponto na borda direita");
ok(linha.caminho.startsWith("M0 100 L"), "o caminho comeca com M e segue em L");
ok(linha.area.endsWith("Z"), "a area fecha o caminho");
ok(!linha.vazio, "serie com pontos nao e vazia");

const plana = montarLinha([{ dia: "2026-08-24", n: 7 }, { dia: "2026-08-25", n: 7 }], 200, 100);
igual(plana.piso, 6, "serie plana abre 1 unidade pra baixo");
igual(plana.teto, 8, "e 1 pra cima");
igual(plana.pontos[0].y, 50, "a linha plana sai no MEIO — leitura honesta de 'nao mudou'");
ok(plana.pontos.every((p) => Number.isFinite(p.y)), "nenhum NaN na serie plana");

const umPonto = montarLinha([{ dia: "2026-08-24", n: 5 }], 200, 100);
igual(umPonto.pontos[0].x, 100, "com 1 ponto so, ele vai pro centro (nao divide por zero)");
ok(montarLinha([], 200, 100).vazio, "serie vazia = linha vazia com aviso");
ok(montarLinha([{ dia: "x", n: 1 } as any], 200, 100).vazio, "ponto sem data valida nao desenha linha");

// ===========================================================================
// 4. Corte dos dias ignorados — as duas caixas sao INDEPENDENTES
// ===========================================================================
igual(diasAPular(false, false), [], "nenhuma caixa marcada = nao pula nada");
igual(diasAPular(true, false), [6], "so sabado");
igual(diasAPular(false, true), [0], "so domingo");
igual(diasAPular(true, true), [0, 6], "as duas");

const SEMANA = [
  { dia: "2026-08-28", dow: 5, n: 5 }, // sexta
  { dia: "2026-08-29", dow: 6, n: 1 }, // sabado
  { dia: "2026-08-30", dow: 0, n: 2 }, // domingo
  { dia: "2026-08-31", dow: 1, n: 7 }, // segunda
];
const serie = lerSeries({ novos_chats: SEMANA, acumulado: SEMANA, mensagens: [], por_usuario: [{ nome: "Ana", enviadas: 3 }] });
igual(cortarSeries(serie, [6]).novos_chats.map((p) => p.dia), ["2026-08-28", "2026-08-30", "2026-08-31"], "sabado sai");
igual(cortarSeries(serie, [0]).novos_chats.map((p) => p.dia), ["2026-08-28", "2026-08-29", "2026-08-31"], "domingo sai");
igual(cortarSeries(serie, [0, 6]).novos_chats.map((p) => p.dia), ["2026-08-28", "2026-08-31"], "os dois saem");
igual(cortarSeries(serie, []).novos_chats.length, 4, "sem pular, nada e cortado");
// por_usuario e agregado do periodo inteiro (nao tem dimensao de dia): cortar ali
// seria inventar um recorte que o banco nao fez
igual(cortarSeries(serie, [0, 6]).por_usuario.length, 1, "o ranking por atendente nao e cortado por dia");
// idempotente: a rota ja cortou; a 2a passada na tela nao pode remover mais nada
const cortadoUmaVez = cortarSeries(serie, [0, 6]);
igual(cortarSeries(cortadoUmaVez, [0, 6]).novos_chats.length, 2, "cortar de novo e idempotente");
// ponto SEM dow (payload antigo): o dia deriva a partir da propria data
const semDow = lerSeries({ novos_chats: [{ dia: "2026-08-29", n: 1 }, { dia: "2026-08-31", n: 2 }] });
igual(cortarSeries(semDow, [6]).novos_chats.map((p) => p.dia), ["2026-08-31"], "sem dow, o corte deriva da data");

// ===========================================================================
// 5. Query da rota
// ===========================================================================
igual(paramsGraficos(FILTRO_PADRAO), "canal=central&dias=30", "padrao: nenhum ignorar na URL");
igual(
  paramsGraficos({ canal: "apioficial", dias: 7, ignorarSabado: true, ignorarDomingo: false }),
  "canal=apioficial&dias=7&ignorar_sabado=1",
  "so sabado — nunca o atalho ignorar_fds, que apagaria a diferenca"
);
igual(
  paramsGraficos({ canal: "central", dias: 90, ignorarSabado: true, ignorarDomingo: true }, "csv"),
  "canal=central&dias=90&ignorar_sabado=1&ignorar_domingo=1&formato=csv",
  "as duas caixas viajam separadas + formato"
);
igual(paramsGraficos({ ...FILTRO_PADRAO, dias: 9999 }), "canal=central&dias=365", "dias e aparado no teto da rota");
igual(paramsGraficos({ ...FILTRO_PADRAO, dias: 0 }), "canal=central&dias=30", "dias 0 cai no padrao");
igual(
  paramsGraficos({ ...FILTRO_PADRAO, canal: "Central; drop" }),
  "canal=central&dias=30",
  "canal fora do formato do registro nao vai pra URL"
);
ok(DIAS_PRESET.includes(30 as any), "30 dias e um dos presets oferecidos");

// ===========================================================================
// 6. Matriz do painel operacional e o clique que navega
// ===========================================================================
const matriz = montarMatriz({
  linhas: [
    { tipo: "departamento", ref_id: "dep-1", nome: "Suporte", status: "aberto", n: 4 },
    { tipo: "departamento", ref_id: "dep-1", nome: "Suporte", status: "concluido", n: 9 },
    { tipo: "usuario", ref_id: "user-1", nome: "Ana", status: "atendimento", n: 2 },
  ],
  sem_dono: [{ status: "aberto", n: 3 }],
  totais: [
    { status: "aberto", n: 7 },
    { status: "atendimento", n: 2 },
    { status: "concluido", n: 9 },
  ],
});
const desenho = linhasParaDesenho(matriz);
igual(desenho[0].tipo, "sem_dono", "sem-dono e a PRIMEIRA linha desenhada (destaque, nao 'mais uma')");
igual(desenho[0].total, 3, "e traz a contagem propria");
igual(desenho.length, 3, "depois vem a matriz");
igual(desenho[1].tipo, "departamento", "departamento antes de usuario");
igual(linhasParaDesenho(null), [], "sem matriz (migration pendente) nao desenha linha nenhuma");

// sem-dono zerado ainda aparece: "0 sem responsavel" e informacao, linha ausente nao
const semDonoZero = montarMatriz({ linhas: [], sem_dono: [], totais: [{ status: "aberto", n: 1 }] });
igual(linhasParaDesenho(semDonoZero)[0].tipo, "sem_dono", "a linha de sem-dono aparece mesmo zerada");

igual(
  alvoDaCelula("central", desenho[0], "aberto"),
  { canal: "central", status: "aberto", resp: "none", arquivadas: false },
  "clique na celula de sem-dono filtra por 'sem responsavel'"
);
igual(
  alvoDaCelula("central", desenho[1], "concluido"),
  { canal: "central", status: "concluido", resp: "dep-1", arquivadas: false },
  "clique no departamento leva o id do departamento (o mesmo campo que a lista casa)"
);
igual(
  alvoDaCelula("apioficial", desenho[2], null),
  { canal: "apioficial", status: null, resp: "user-1", arquivadas: false },
  "clique no TOTAL da linha filtra so por dono"
);
igual(
  alvoDaCelula("central", null, "aberto"),
  { canal: "central", status: "aberto", resp: null, arquivadas: false },
  "clique no total da COLUNA filtra so por status"
);
// ITEM 5 da revisao cega: "incluir arquivadas" VIAJA no alvo. Sem isso o numero
// contado COM arquivadas abria a lista SEM elas — 12 no relatorio, 4 na lista, e
// o gestor deixa de confiar nos dois.
igual(
  alvoDaCelula("central", desenho[0], "aberto", true),
  { canal: "central", status: "aberto", resp: "none", arquivadas: true },
  "a caixa 'incluir arquivadas' chega na lista de conversas"
);
igual(
  alvoDaCelula("central", null, null, true),
  { canal: "central", status: null, resp: null, arquivadas: true },
  "e vale tambem no total do canal"
);

ok(celulaNavegavel(3), "celula com conversa navega");
ok(!celulaNavegavel(0), "celula zerada NAO navega — filtrar pra lista vazia parece tela quebrada");

// leitura defensiva da rota do operacional
igual(lerOperacional(null), [], "payload nulo do operacional = nenhum bloco");
const blocos = lerOperacional({
  canais: [
    { canal: "central", rotulo: "Principal", matriz: { status: [], sem_dono: {}, linhas: [], totais: {}, total_geral: 0 } },
    { canal: "ig", rotulo: "Instagram", matriz: null, aviso: "canal de fonte externa: sem matriz no painel" },
    { canal: "x", matriz: null, erro: "falha ao consultar o relatorio (codigo 42501)" },
  ],
});
igual(blocos.length, 3, "tres blocos lidos");
ok(blocos[1].aviso && !blocos[1].erro, "aviso de canal externo nao e erro");
ok(blocos[2].erro, "erro real chega como erro (e nao como 'falta migration')");
igual(blocos[2].rotulo, "x", "bloco sem rotulo cai no id do canal");

// ===========================================================================
// 7. Formulario dos alertas de SLA
// ===========================================================================
const base: RascunhoAlerta = {
  ...RASCUNHO_VAZIO,
  nome: "Implementacao sem contato por 3 dias",
  status: ["aguardando"],
  departamento: SEM_DONO_ALERTA,
  idade_min: 4320,
  horarios: ["08:00", "14:00"],
};
igual(problemasDoRascunho(base), [], "rascunho completo nao tem problema");

// cada recusa aqui casa com uma regra de normalizarAlertas que DESCARTARIA o item
ok(problemasDoRascunho({ ...base, nome: "  " }).length === 1, "nome vazio e recusado na tela");
ok(problemasDoRascunho({ ...base, horarios: [] }).length === 1, "alerta sem horario e recusado");
ok(problemasDoRascunho({ ...base, horarios: ["24:00"] }).length === 1, "24:00 nao existe");
ok(problemasDoRascunho({ ...base, horarios: ["8:00"] }).length === 1, "hora sem zero a esquerda e recusada");
ok(problemasDoRascunho({ ...base, canal: "Central" }).length === 1, "canal fora do formato e recusado");
ok(
  problemasDoRascunho({ ...base, destinoTipo: "telegram", destinoChatId: "abc" }).length === 1,
  "chat_id nao numerico e recusado"
);
igual(problemasDoRascunho({ ...base, destinoTipo: "telegram", destinoChatId: "-1002" }), [], "chat_id negativo vale (grupo)");
ok(
  problemasDoRascunho({ ...base, destinoTipo: "webhook", destinoUrl: "http://exemplo.test/x" }).length === 1,
  "webhook http:// e recusado — alerta carrega dado de cliente"
);
igual(problemasDoRascunho({ ...base, destinoTipo: "webhook", destinoUrl: "https://exemplo.test/x" }), [], "https vale");
ok(
  problemasDoRascunho(base, ["Implementacao sem contato por 3 dias"]).length === 1,
  "nome repetido e recusado (o nome e a chave do dedupe diario)"
);
igual(problemasDoRascunho(base, ["Outro alerta"]), [], "nome de OUTRO alerta nao atrapalha");
ok(problemasDoRascunho({ ...base, nome: "x".repeat(121) }).length === 1, "nome acima de 120 e recusado na tela");

// ---- ROUND-TRIP: o item que a tela grava tem que SOBREVIVER a normalizarAlertas
// (esta e a prova que importa: normalizarAlertas descarta em silencio, e sem ela
// a tela diria "salvei" pra um alerta que nao existe)
function roundTrip(r: RascunhoAlerta) {
  const gravado = normalizarAlertas([rascunhoParaAlerta(r)]);
  ok(gravado.length === 1, `alerta "${r.nome}" sobrevive a normalizarAlertas`);
  return gravado[0];
}
const rt = roundTrip(base);
igual(rt.nome, base.nome, "nome preservado");
igual(rt.filtro.status, ["aguardando"], "status preservado");
igual(rt.filtro.departamento, SEM_DONO_ALERTA, "o marcador de sem-dono chega intacto");
igual(rt.filtro.idade_min, 4320, "idade em minutos preservada");
igual(rt.horarios, ["08:00", "14:00"], "horarios preservados e ordenados");
igual(rt.canal, null, "canal vazio = todos os canais ativos");
igual(rt.destino, null, "sem destino proprio = destino padrao da instalacao");
igual(rt.ativo, false, "alerta nasce DESLIGADO — so dispara quando alguem liga de proposito");
igual(rt.limite, 50, "limite default");

const rtTg = roundTrip({ ...base, nome: "Com telegram", destinoTipo: "telegram", destinoChatId: " -1002 ", destinoAssinatura: "SLA" });
igual(rtTg.destino, { tipo: "telegram", chat_id: "-1002", assinatura: "SLA" }, "destino telegram round-trip com trim");
const rtSemAssin = roundTrip({ ...base, nome: "Sem assinatura", destinoTipo: "telegram", destinoChatId: "10" });
igual(rtSemAssin.destino, { tipo: "telegram", chat_id: "10" }, "assinatura vazia nao vira campo vazio");

// destino webhook configurado FORA da tela: headers/body PRESERVADOS.
// Reenviar o alerta sem eles apagaria a autenticacao do destino em silencio.
const doBanco = {
  nome: "Vem do banco",
  filtro: { status: ["aberto"], departamento: null, idade_min: 60 },
  horarios: ["09:30"],
  destino: { tipo: "webhook", url: "https://exemplo.test/sla", headers: { "x-token": "abc" }, body: { a: 1 } },
  canal: "central",
  limite: 20,
  ativo: true,
};
const rascunhoDoBanco = alertaParaRascunho(doBanco);
igual(rascunhoDoBanco.destinoTipo, "webhook", "tipo lido do banco");
igual(rascunhoDoBanco.destinoUrl, "https://exemplo.test/sla", "url lida");
igual(rascunhoDoBanco.destinoExtra, { headers: { "x-token": "abc" }, body: { a: 1 } }, "headers/body guardados intactos");
igual(rascunhoDoBanco.ativo, true, "estado ligado preservado na leitura");
const voltou = roundTrip(rascunhoDoBanco);
igual(
  voltou.destino,
  { tipo: "webhook", url: "https://exemplo.test/sla", headers: { "x-token": "abc" }, body: { a: 1 } },
  "editar o alerta na tela NAO apaga o header de autenticacao do destino"
);
igual(voltou.canal, "central", "canal preservado");
igual(voltou.limite, 20, "limite preservado");
igual(voltou.ativo, true, "e o alerta continua ligado depois de editar outra coisa");

// leitura de lixo nao lanca
for (const torto of [null, undefined, 0, "x", [], { destino: "x" }]) {
  const r = alertaParaRascunho(torto);
  igual(r.nome, "", `alertaParaRascunho(${JSON.stringify(torto)}) devolve rascunho vazio`);
  igual(r.destinoTipo, "", "sem destino");
}

// ---- a conferencia depois de gravar
igual(
  nomesPerdidos([{ nome: "A" }, { nome: "B" }], [{ nome: "A" }]),
  ["B"],
  "alerta engolido pela normalizacao e DENUNCIADO (a tela nao pode dizer 'salvei')"
);
igual(nomesPerdidos([{ nome: "A" }], [{ nome: "A" }]), [], "nada perdido = nada a avisar");
igual(nomesPerdidos(null, null), [], "payload nulo nao lanca");
igual(nomesPerdidos([{ nome: " A " }], [{ nome: "A" }]), [], "comparacao por nome ignora espaco nas pontas");

// ---- resumo do filtro na listagem
const nomeDep = (id: string) => (id === "dep-1" ? "Suporte" : null);
igual(
  resumoDoFiltro({ ...base, departamento: "dep-1" }, nomeDep),
  "aguardando · Suporte · parada ha 3d",
  "resumo legivel do filtro"
);
igual(
  resumoDoFiltro({ ...RASCUNHO_VAZIO, idade_min: 0 }, nomeDep),
  "qualquer status",
  "sem status e sem idade, o resumo diz 'qualquer status' em vez de ficar vazio"
);
igual(
  resumoDoFiltro({ ...base, departamento: "dep-desconhecido" }, nomeDep),
  "aguardando · departamento · parada ha 3d",
  "departamento apagado nao vira id cru na tela"
);

// ===========================================================================
// 8. Rotulos, duracao e nome do arquivo
// ===========================================================================
igual(rotuloDia("2026-08-29"), "29/08", "rotulo curto");
igual(rotuloDia("qualquer coisa"), "qualquer coisa", "data invalida nao lanca");
igual(rotuloDiaLongo("2026-08-29"), "sab, 29/08/2026", "rotulo longo com o dia da semana");
igual(rotuloDiaLongo("2026-08-31"), "seg, 31/08/2026", "e a segunda seguinte");

igual(duracaoLegivel(null), "-", "sem medida = '-', nunca '0s'");
igual(duracaoLegivel(undefined), "-", "idem pra undefined");
igual(duracaoLegivel(NaN), "-", "NaN tambem");
igual(duracaoLegivel(45), "45s", "segundos");
igual(duracaoLegivel(600), "10min", "minutos");
igual(duracaoLegivel(3600), "1h", "hora cheia sem ' 0min'");
igual(duracaoLegivel(5400), "1h 30min", "hora e minuto");
igual(duracaoLegivel(54000), "15h", "as 15h uteis de sexta 18h -> segunda 9h");
igual(duracaoLegivel(226800), "2d 15h", "dias e horas");
igual(duracaoLegivel(172800), "2d", "dia cheio sem ' 0h'");

igual(
  rotuloPeriodo(30, "America/Recife", []),
  "ultimos 30 dias — fuso America/Recife",
  "o FUSO da instalacao entra no rotulo (criterio do card)"
);
igual(rotuloPeriodo(7, "America/Sao_Paulo", [6]), "ultimos 7 dias — fuso America/Sao_Paulo — sem sabado", "so sabado");
igual(rotuloPeriodo(7, "America/Sao_Paulo", [0]), "ultimos 7 dias — fuso America/Sao_Paulo — sem domingo", "so domingo");
igual(rotuloPeriodo(7, "", [0, 6]), "ultimos 7 dias — sem sabado e domingo", "sem fuso conhecido, o rotulo omite (nao chuta)");

igual(
  nomeDoContentDisposition('attachment; filename="serie-central-2026-08-31.csv"', "x.csv"),
  "serie-central-2026-08-31.csv",
  "nome do arquivo vem do cabecalho da rota"
);
igual(nomeDoContentDisposition(null, "relatorio.csv"), "relatorio.csv", "sem cabecalho, cai no fallback");
igual(
  nomeDoContentDisposition('attachment; filename="../../etc/passwd"', "relatorio.csv"),
  "passwd",
  "nome nunca monta caminho — so o basename, e so o alfabeto do gerador da rota"
);
igual(
  nomeDoContentDisposition('attachment; filename="rela<>torio.csv"', "x.csv"),
  "rela-torio.csv",
  "caractere fora do alfabeto do gerador e trocado, nunca repassado ao disco"
);
igual(nomeDoContentDisposition('attachment; filename=""', "relatorio.csv"), "relatorio.csv", "nome vazio cai no fallback");

igual(motivoSemExportar(true), null, "com permissao, nada a avisar");
ok(String(motivoSemExportar(false)).includes("relatorios_exportar"), "sem permissao, a tela diz QUAL permissao falta");

// ===========================================================================
// 9. Escrita concorrente na config (item 3 da revisao cega)
// ===========================================================================
// `alertas_sla` e UMA chave com a lista inteira: gravar sobrescreve tudo. Dois
// admins na tela = o ultimo a salvar apaga o alerta que o outro criou no meio,
// sem erro nenhum na tela. A rota nao tem versao/etag: a deteccao e por retrato.
const listaA = [rascunhoParaAlerta(base)];
const retA = retratoDeAlertas(listaA);
ok(!configMudouPorFora(retA, listaA), "config identica nao acusa mudanca");
ok(
  configMudouPorFora(retA, [...listaA, rascunhoParaAlerta({ ...base, nome: "criado por outro admin" })]),
  "alerta que apareceu no meio e DETECTADO (era o lost update)"
);
ok(configMudouPorFora(retA, []), "alerta apagado por fora tambem e detectado");
// trocar um alerta por outro MANTEM a contagem: por isso a comparacao e por
// retrato e nao por `length`
ok(
  configMudouPorFora(retA, [rascunhoParaAlerta({ ...base, nome: "outro alerta" })]),
  "substituicao (mesma contagem, conteudo diferente) e detectada"
);
ok(
  configMudouPorFora(retA, [rascunhoParaAlerta({ ...base, ativo: true })]),
  "alerta que alguem LIGOU por fora e detectado"
);
// ...e o que NAO pode acusar, senao toda gravacao daria falso positivo:
igual(
  retratoDeAlertas([{ nome: "A", ativo: false, horarios: ["08:00"], filtro: { idade_min: 60 } }]),
  retratoDeAlertas([{ filtro: { idade_min: 60, status: undefined }, horarios: ["08:00"], ativo: false, nome: "A" }]),
  "ordem das chaves e campo opcional ausente NAO viram falso positivo"
);
igual(
  retratoDeAlertas([{ nome: "A", horarios: ["14:00", "08:00"], filtro: {} }]),
  retratoDeAlertas([{ nome: "A", horarios: ["08:00", "14:00"], filtro: {} }]),
  "ordem dos horarios tambem nao"
);
igual(retratoDeAlertas(null), retratoDeAlertas([]), "payload nulo e lista vazia dao o mesmo retrato");

// ===========================================================================
// 10. Teto de 50 alertas (item 4 da revisao cega)
// ===========================================================================
// `normalizarAlertas` para de ler no 51o item e o resto DESAPARECE. Sem esta
// checagem a tela caia no aviso generico "revise nome, horario e destino" — pra
// um alerta em que nada disso estava errado.
const cinquenta = Array.from({ length: MAX_ALERTAS }, (_, i) => `alerta ${i}`);
const problemasNo51 = problemasDoRascunho({ ...base, nome: "o 51o" }, cinquenta);
ok(problemasNo51.length === 1, "criar o 51o alerta e bloqueado");
ok(String(problemasNo51[0]).includes(String(MAX_ALERTAS)), "e a mensagem diz o teto, nao manda revisar horario");
igual(problemasDoRascunho({ ...base, nome: "o 50o" }, cinquenta.slice(0, MAX_ALERTAS - 1)), [], "o 50o passa");
// EDITAR um dos 50 existentes tem que passar: `outrosNomes` exclui o proprio
igual(
  problemasDoRascunho(base, cinquenta.slice(0, MAX_ALERTAS - 1)),
  [],
  "editar alerta existente com a lista cheia NAO e bloqueado"
);
ok(
  problemasDoRascunho({ ...base, nome: "", horarios: [] }, cinquenta).length === 3,
  "teto, nome e horario aparecem juntos quando os tres estao errados"
);

// ===========================================================================
// 11. Select com valor gravado fora das opcoes (item 6 da revisao cega)
// ===========================================================================
// <select> com value que nao casa com option nenhuma renderiza EM BRANCO, e o
// primeiro save "conserta" pro valor da primeira opcao sem ninguem pedir.
const OPC = [
  { valor: "a", rotulo: "Alfa" },
  { valor: "b", rotulo: "Beta" },
];
igual(garantirOpcao(OPC, "a"), OPC, "valor que existe nao cria opcao nova");
igual(garantirOpcao(OPC, ""), OPC, "valor vazio (= 'qualquer') nao cria opcao");
const comSintetica = garantirOpcao(OPC, "zzz");
igual(comSintetica.length, 3, "valor desconhecido ganha opcao propria");
igual(comSintetica[2].valor, "zzz", "com o valor gravado preservado");
ok(comSintetica[2].sintetica === true, "marcada como sintetica pra tela destacar");
ok(String(comSintetica[2].rotulo).includes("definido fora da tela"), "e o rotulo explica de onde veio");
// idade posta pela API (720 = 12h) nao esta nos presets
const idade720 = garantirOpcao(
  IDADES_ALERTA.map((i) => ({ valor: String(i.min), rotulo: i.rotulo })),
  "720",
  (v) => rotuloIdade(Number(v))
);
ok(idade720.some((o) => o.valor === "720" && o.rotulo.startsWith("12h")), "12h aparece legivel, nao como 720 cru");
igual(rotuloIdade(4320), "3 dias", "preset conhecido usa o rotulo do preset");
igual(rotuloIdade(720), "12h", "fora do preset, a duracao e formatada");

igual(statusParaTela([]).length, 4, "sem nada selecionado, so os 4 canonicos");
const comEstranho = statusParaTela(["aberto", "em_negociacao"]);
igual(comEstranho.length, 5, "status desconhecido entra na lista");
ok(comEstranho[4].sintetica === true, "marcado como sintetico");
igual(comEstranho[4].valor, "em_negociacao", "com o valor gravado preservado");
igual(statusParaTela(["aberto", "aberto"]).length, 4, "canonico repetido nao duplica");
igual(statusParaTela(["x", "x"]).length, 5, "desconhecido repetido tambem nao duplica");

// ===========================================================================
// 12. Janela ancorada na meia-noite local (item 8 da revisao cega)
// ===========================================================================
// A rota fazia `agora - dias*24h`, que cai no MEIO de um dia: o banco agrupa por
// dia local e devolvia 31 baldes pra "ultimos 30 dias", o primeiro cobrindo so
// as horas depois da hora atual. A primeira coluna do grafico sempre parecia um
// dia fraco — e era um pedaco de dia. Aqui se prova a aritmetica que a rota usa.
function baldesDe(dias: number, agoraIso: string, fuso: string): number {
  const ate = new Date(agoraIso);
  const desde = inicioDoDiaLocal(new Date(ate.getTime() - (dias - 1) * 86_400_000), fuso);
  const vistos = new Set<string>();
  for (let t = desde.getTime(); t < ate.getTime(); t += 3_600_000) vistos.add(diaLocal(new Date(t), fuso));
  return vistos.size;
}
const FUSO_T = "America/Sao_Paulo";
igual(baldesDe(30, "2026-08-31T17:30:00.000Z", FUSO_T), 30, "30 dias = 30 baldes (era 31)");
igual(baldesDe(7, "2026-08-31T17:30:00.000Z", FUSO_T), 7, "7 dias = 7 baldes");
igual(baldesDe(1, "2026-08-31T17:30:00.000Z", FUSO_T), 1, "1 dia = so hoje");
// a hora em que o relatorio foi aberto nao pode mudar a contagem — era
// exatamente isso que quebrava antes
for (const hora of ["03:10", "12:00", "23:50"]) {
  igual(baldesDe(30, `2026-08-31T${hora}:00.000Z`, FUSO_T), 30, `contagem estavel as ${hora}Z`);
}
igual(baldesDe(30, "2026-08-31T17:30:00.000Z", "Asia/Tokyo"), 30, "vale em fuso a frente do UTC");
igual(baldesDe(30, "2026-08-31T02:00:00.000Z", "America/Los_Angeles"), 30, "e atras do UTC");

// ===========================================================================
igual(montarRanking([]).vazio, true, "ranking sem atendente e vazio");
const rank = montarRanking([{ nome: "Ana", enviadas: 10 }, { nome: "Bia", enviadas: 5 }], 1);
igual(rank.linhas.length, 1, "o teto do ranking corta");
igual(rank.restante, 1, "e diz quantos ficaram de fora (nunca esconde calado)");
igual(rank.linhas[0].fracao, 100, "a barra do maior ocupa a linha toda");

// ===========================================================================
// 11. Tela de satisfacao: CSAT do painel + NPS importado (Frente V, 86ak85bne)
// ===========================================================================

// leitura defensiva: rota degradada, corpo vazio, corpo torto — nada lanca
for (const bruto of [null, undefined, {}, { nps: null }, { csat: "nao e objeto" }, { nps: { geral: 7 } }]) {
  const s = lerSatisfacao(bruto);
  ok(s.csat.total === 0 && s.nps.geral.total === 0, "satisfacao tolera corpo torto sem lancar");
  igual(s.nps.importado, false, "sem bloco de NPS = nao importado");
}

const corpoNps = {
  canal: "central",
  dias: 365,
  csat: { total: 3, media: 4.33, escala: "1-5", distribuicao: { "4": 2, "5": 1 } },
  nps: {
    importado: true,
    escala: "0-10",
    geral: { total: 4, promotores: 2, neutros: 1, detratores: 1, score: 25, media: 8, distribuicao: { "6": 1, "8": 1, "9": 1, "10": 1 } },
    pesquisas: [
      { id: "p1", nome: "Pos-atendimento 2025", origem: "chatguru", respostas: 4, total: 4, promotores: 2, neutros: 1, detratores: 1, score: 25, media: 8 },
      { id: "p2", nome: "Piloto", origem: null, respostas: 0, total: 0, promotores: 0, neutros: 0, detratores: 0, score: null, media: null },
    ],
    ligadas_a_conversa: 0,
    fora_do_periodo_sem_data: 12,
  },
};
const sat = lerSatisfacao(corpoNps);
igual(sat.nps.importado, true, "NPS importado e lido como importado");
igual(sat.nps.geral.score, 25, "score do NPS chega inteiro");
igual(sat.nps.pesquisas.length, 2, "pesquisa com 0 resposta NAO e escondida (ela existe na instalacao)");
igual(sat.nps.pesquisas[1].score, null, "pesquisa sem resposta tem score nulo, nao zero");
igual(sat.csat.media, 4.33, "media do CSAT nao e arredondada pela tela");

// SCORE 0 e NULL sao coisas diferentes, e a tela mostra diferente
igual(classificacaoNps(null).rotulo, "sem resposta", "score nulo = sem resposta");
igual(classificacaoNps(0).rotulo, "zona de aperfeicoamento", "score ZERO e um numero real, nao 'sem resposta'");
igual(classificacaoNps(-10).tom, "vermelho", "score negativo e zona critica");
igual(classificacaoNps(49).rotulo, "zona de aperfeicoamento", "49 ainda e aperfeicoamento");
igual(classificacaoNps(50).rotulo, "zona de qualidade", "50 vira qualidade");
igual(classificacaoNps(75).rotulo, "zona de excelencia", "75 vira excelencia");
igual(classificacaoNps(Number.NaN).rotulo, "sem resposta", "NaN nao vira zona critica");

// barras: TODA nota da escala aparece, inclusive a zerada
const barras = barrasDaDistribuicao(corpoNps.nps.geral.distribuicao, "0-10");
igual(barras.length, 11, "escala 0-10 = 11 barras, com as zeradas");
igual(barras[0].nota, 0, "a barra do 0 existe (ausencia esconderia 'ninguem deu 0')");
igual(barras[0].quantidade, 0, "e ela vale zero");
igual(barras[0].classe, "detrator", "0 e detrator");
igual(barras[8].classe, "neutro", "8 e neutro");
igual(barras[9].classe, "promotor", "9 e promotor");
igual(barras[10].proporcao, 1, "a maior barra ocupa a linha toda");
igual(barrasDaDistribuicao({}, "1-5").length, 5, "escala do CSAT = 5 barras");
igual(barrasDaDistribuicao({}, "1-5")[0].nota, 1, "CSAT comeca no 1, nao no 0");
igual(barrasDaDistribuicao({}, "1-5")[0].classe, null, "CSAT nao tem promotor/detrator");
ok(
  barrasDaDistribuicao({}, "0-10").every((b) => Number.isFinite(b.proporcao)),
  "distribuicao vazia nao gera divisao por zero"
);

// os avisos: cada frase corresponde a um jeito de ler o numero errado
const av = avisosDaSatisfacao(sat);
ok(av.some((x) => x.includes("SEM data")), "resposta importada sem data e denunciada (ela nao entra em periodo nenhum)");
ok(av.some((x) => x.includes("nenhuma resposta de NPS esta ligada")), "NPS sem telefone: nao da pra abrir a conversa");
ok(
  avisosDaSatisfacao(lerSatisfacao({})).some((x) => x.includes("nao importado")),
  "sem NPS a tela diz que a instalacao nao importou (em vez de mostrar 0)"
);
ok(
  avisosDaSatisfacao(lerSatisfacao({ csat: { erro: "avaliacoes indisponivel" } })).some((x) => x.includes("CSAT indisponivel")),
  "CSAT degradado aparece como aviso, nao como zero"
);
// instalacao saudavel (NPS ligado a conversa, sem resposta orfa) nao inventa aviso
igual(
  avisosDaSatisfacao(
    lerSatisfacao({
      csat: { total: 1, media: 5, escala: "1-5", distribuicao: { "5": 1 } },
      nps: { importado: true, escala: "0-10", geral: { total: 1, promotores: 1, score: 100, media: 10 }, pesquisas: [], ligadas_a_conversa: 1, fora_do_periodo_sem_data: 0 },
    })
  ),
  [],
  "instalacao sem problema nenhum nao gera aviso (aviso sempre = aviso ignorado)"
);

console.log(
  `OK — prova-telas-relatorios: ${checagens} checagens (graficos, matriz, alertas de SLA, rotulos,\n  CSV, escrita concorrente, teto de 50, opcao sintetica, janela ancorada e satisfacao CSAT/NPS).`
);
console.log(
  "NAO coberto aqui: o React de app/relatorios-*.tsx (exige navegador), as funcoes da 0013 (exigem Postgres) e o gate das rotas (scripts/prova-permissoes.ts)."
);
