// Prova do importador de INTENCOES — roda a CLI em --dry contra o backup
// SINTETICO de scripts/importar/fixture-intencoes/ e confere o mapeamento termo a
// termo.
//
//   node scripts/importar/prova-intencoes.mjs
//
// Nao toca banco nenhum e nao usa dado de cliente. A fixture tem uma armadilha
// por intencao: atributo em ORDEM INVERTIDA e com aspas simples (prova que o
// casamento e por atributo NOMEADO), entidade html no nome e no termo, campo de
// pontuacao VAZIO, campo de pontuacao ILEGIVEL, intencao sem termo nenhum, link
// sem nome, termo repetido variando a caixa, termo gigante, e — o caso que a
// medicao no acervo real revelou — o MESMO nome em dois chatbots com pontuacao
// minima DIFERENTE (medido: 8 nomes repetidos na mesma conta, 5 com minimo
// diferente).
//
// O QUE ESTA PROVA GARANTE, ALEM DO MAPEAMENTO: que a consolidacao nunca faz uma
// intencao disparar MAIS do que a origem fazia, e que nenhum termo escrito pela
// operacao e jogado fora em silencio.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acharArquivosIntents, atributo, consolidar, converterTela, dedupe, normalizar, texto,
  PONTUACAO_MINIMA_PADRAO,
} from "./intencoes.mjs";
// A lib do PRODUTO: a prova fecha o circuito e confere que a intencao importada
// reconhece de verdade a frase que a origem tinha como exemplo.
import { pontuarIntencao, validarIntencao } from "../../lib/fluxo/intencoes.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(AQUI, "fixture-intencoes");
const TRABALHO = fs.mkdtempSync(path.join(os.tmpdir(), "prova-intencoes-"));

let falhas = 0;
const ok = (cond, oque, detalhe = "") => {
  console.log(`${cond ? "  ok  " : "FALHA "} ${oque}${detalhe ? ` — ${detalhe}` : ""}`);
  if (!cond) falhas++;
};
const igual = (obtido, esperado, oque) => {
  const bate = JSON.stringify(obtido) === JSON.stringify(esperado);
  ok(bate, oque, bate ? "" : `esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`);
};

console.log("PROVA DO IMPORTADOR DE INTENCOES (fixture sintetica, modo --dry)\n");

// ────────────────────────────────────────────────────── funcoes puras
console.log("-- leitura de atributo e de texto");
const tag = `<i data-bot-id="b1" data-keyword='pre&#231;o' data-intent-id="i1" class="keyword_delete"></i>`;
igual(atributo(tag, "data-intent-id"), "i1", "le atributo em qualquer POSICAO da tag");
igual(atributo(tag, "data-keyword"), "pre&#231;o", "le atributo com aspas SIMPLES");
igual(atributo(tag, "data-nao-existe"), null, "atributo ausente devolve null (nunca string vazia)");
igual(texto("pre&#231;o &amp; valor"), "preço & valor", "desfaz entidade numerica e nomeada");
igual(texto("  sim,   consegui  "), "sim, consegui", "espaco duplicado colapsa");
igual(texto("&quot;valor&quot;"), '"valor"', "aspas escapadas voltam a ser aspas");
igual(texto("&naoexiste; fim"), "&naoexiste; fim", "entidade desconhecida fica como esta (nao chuta)");
igual(normalizar("Pre&ccedil;o"), "pre ccedil o", "normalizar NAO desfaz entidade: quem desfaz e texto()");
igual(normalizar("Preço & Valor"), "preco valor", "normalizar tira caixa, acento e pontuacao");
igual(dedupe(["Atendente", "atendente ", "ATENDENTE", "humano"]), ["Atendente", "humano"], "dedupe pela forma normalizada, preservando a 1a escrita");
igual(dedupe(["x".repeat(200)])[0].length, 120, "termo gigante e cortado no mesmo limite da lib");
igual(dedupe(["", "   ", null, 42]), [], "lixo nao vira termo (as MESMAS regras da lib do produto: numero nao e termo)");
igual(dedupe(Array.from({ length: 400 }, (_, k) => `t${k}`)).length, 300, "o mesmo teto de termos da lib");

// ────────────────────────────────────────────────────── a tela crua
console.log("\n-- parser de uma tela");
const arquivos = acharArquivosIntents(FIXTURE);
igual(arquivos.length, 2, "acha as duas telas de intencao da fixture");
ok(arquivos.every((a) => a.endsWith("_intents.html")), "so pega arquivo de intencao");

const telaA = converterTela(fs.readFileSync(arquivos[0], "utf8"), { arquivo: "a", conta: "acme" });
igual(telaA.cruas.length, 5, "5 intencoes na primeira tela (inclusive as que nao vao entrar)");
const a1 = telaA.cruas.find((c) => c.nome === "Atendente");
igual(a1.pontuacao_minima, 2, "pontuacao minima sai do value do input");
igual(a1.palavras_chave, ["atendente", "Humano", "humano"], "todas as palavras da tela, ainda sem dedupe (isso e da consolidacao)");
igual(a1.frases, ["Falar com humano"], "a frase de exemplo vem do data-example");
igual(a1.bot_id, "aaaa1111aaaa1111aaaa1111", "guarda o bot de origem");
const a2 = telaA.cruas.find((c) => c.nome === "Preço & valor");
ok(!!a2, "nome com entidade html volta legivel");
igual(a2.pontuacao_minima, null, "campo de pontuacao VAZIO vira null (o destino aplica o padrao)");
igual(a2.frases, ['Qual o "valor" disso?'], "frase com aspas escapadas volta inteira");
igual(telaA.minIlegivel.length, 1, "pontuacao ilegivel e REGISTRADA, nao vira default em silencio");
igual(telaA.minIlegivel[0].valor_na_origem, "dois", "o relatorio mostra o valor que estava na origem");
igual(telaA.cruas.find((c) => c.nome === "So frase").pontuacao_minima, null, "ilegivel tambem vira null");

const telaB = converterTela(fs.readFileSync(arquivos[1], "utf8"), { arquivo: "b", conta: "acme" });
const b3 = telaB.cruas.find((c) => c.nome === "Frase exata");
igual(b3.pontuacao_minima, 100, "minimo 100 lido de tag com atributos em ORDEM INVERTIDA");
igual(b3.palavras_chave.length, 1, "atributo com ASPAS SIMPLES e ordem invertida tambem e lido");
igual(b3.frases, ["sim, consegui participar"], "espaco duplicado da frase colapsa");

// ────────────────────────────────────────────────────── consolidacao
console.log("\n-- consolidacao das duas telas num catalogo da instalacao");
const { linhas, estatisticas: est } = consolidar([...telaA.cruas, ...telaB.cruas], { telas: 2, origem: "chatguru" });

igual(est.origem.intencoes, 8, "8 intencoes vieram das duas telas");
igual(est.catalogo.intencoes, 4, "4 sobrevivem no catalogo (2 pares unidos, 2 descartadas)");
igual(linhas.map((l) => l.nome), ["Atendente", "Frase exata", "Preço & valor", "So frase"], "ordem deterministica por nome");
igual(est.descartadas, { sem_nome: 1, sem_termo: 1, sem_id: 0 }, "o que nao entrou esta CONTADO, nunca sumido");
// intencao sem id de origem nao chega pelo parser (o link E o id), mas chega de
// quem monta na mao. Sem id nao ha idempotencia: reimportar duplicaria o catalogo.
const semId = consolidar([{ nome: "Sem id", intencao_id: "", bot_id: "b", palavras_chave: ["x"], frases: [] }], {});
igual(semId.linhas.length, 0, "intencao sem id de origem NAO entra");
igual(semId.estatisticas.descartadas.sem_id, 1, "e o descarte esta contado");

const atendente = linhas.find((l) => l.nome === "Atendente");
igual(
  atendente.palavras_chave,
  ["atendente", "Humano", "especialista"],
  "termos dos DOIS bots se unem, sem repetir (nenhum termo da operacao e jogado fora)"
);
igual(atendente.frases.length, 2, "as frases dos dois bots tambem se unem");
igual(atendente.pontuacao_minima, 20, "com minimos 2 e 20, fica o mais ALTO — o que dispara MENOS");
igual(est.minimo_em_conflito.length, 1, "o conflito vira PENDENCIA, nunca decisao silenciosa");
igual(est.minimo_em_conflito[0].nome, "Atendente", "a pendencia nomeia a intencao");
igual(est.minimo_em_conflito[0].valores, [2, 20], "a pendencia mostra os dois valores da origem");
igual(est.minimo_em_conflito[0].escolhido, 20, "e diz com qual ficou");
igual(est.minimo_em_conflito[0].bots.length, 2, "e de quais bots vieram");

// Defeito real: a 1a versao empilhava uma pendencia por FUSAO, e o mesmo nome
// unido N vezes gerava N linhas com a lista de valores crescendo — 17 linhas pra 6
// nomes no acervo real, uma com "20, 2, 20, 20, 2, 20, 20, 2, 2, 2, 2, 2, 2, 20,
// 2". Relatorio ilegivel nao e conferido por ninguem.
const tresBots = [
  { nome: "Repetida", intencao_id: "r1", bot_id: "b1", palavras_chave: ["um"], frases: [], pontuacao_minima: 2 },
  { nome: "repetida", intencao_id: "r2", bot_id: "b2", palavras_chave: ["dois"], frases: [], pontuacao_minima: 20 },
  { nome: "REPETIDA", intencao_id: "r3", bot_id: "b3", palavras_chave: ["tres"], frases: [], pontuacao_minima: 2 },
  { nome: "REPETIDA ", intencao_id: "r4", bot_id: "b4", palavras_chave: ["quatro"], frases: [], pontuacao_minima: 20 },
];
const tri = consolidar(tresBots, {});
igual(tri.linhas.length, 1, "quatro bots, um nome: uma intencao no catalogo");
igual(tri.estatisticas.minimo_em_conflito.length, 1, "e UMA pendencia, nao uma por fusao");
igual(tri.estatisticas.minimo_em_conflito[0].valores, [2, 20], "valores sem repetir e em ordem");
igual(tri.estatisticas.minimo_em_conflito[0].bots, ["b1", "b2", "b3", "b4"], "todos os bots envolvidos, sem repetir");
igual(tri.linhas[0].palavras_chave, ["um", "dois", "tres", "quatro"], "nenhum termo dos quatro bots e perdido");
igual(tri.estatisticas.unidas.length, 1, "uma uniao registrada por NOME");

console.log("\n-- palavra-chave de uma letra: importada fiel, mas RELATADA");
const curtinha = consolidar(
  [{ nome: "Negativo", intencao_id: "c1", bot_id: "b1", palavras_chave: ["n", "nao"], frases: [], pontuacao_minima: 2 }],
  {}
);
igual(curtinha.linhas[0].palavras_chave, ["n", "nao"], 'o "n" NAO e cortado: e como gente escreve "nao"');
igual(curtinha.estatisticas.palavras_de_uma_letra.length, 1, "mas entra no relatorio pra conferencia");
igual(curtinha.estatisticas.palavras_de_uma_letra[0].termos, ["n"], "com o termo e a pontuacao minima ao lado");
igual(
  consolidar([{ nome: "Limpa", intencao_id: "c2", bot_id: "b1", palavras_chave: ["preco"], frases: [], pontuacao_minima: 2 }], {})
    .estatisticas.palavras_de_uma_letra.length,
  0,
  "quem nao tem palavra curta nao gera pendencia (a pendencia so aparece quando existe)"
);

const preco = linhas.find((l) => l.nome === "Preço & valor");
igual(preco.pontuacao_minima, PONTUACAO_MINIMA_PADRAO, "campo em branco cai no padrao da origem (2)");
igual(preco.palavras_chave, ["preço", "valor"], "nome igual DEPOIS de normalizar tambem une");
igual(est.unidas.length, 2, "as duas unioes estao registradas");
ok(
  !est.minimo_em_conflito.some((c) => c.nome_normalizado === "preco valor"),
  "uniao com minimo EFETIVO igual (vazio x 2) nao vira pendencia: nao ha nada pra decidir"
);

igual(linhas.find((l) => l.nome === "So frase").pontuacao_minima, PONTUACAO_MINIMA_PADRAO, "ilegivel cai no padrao");
igual(linhas.find((l) => l.nome === "Frase exata").palavras_chave[0].length, 120, "termo gigante entra cortado");
igual(est.por_minimo, { 2: 2, 20: 1, 100: 1 }, "a distribuicao de pontuacao minima e reportada");
igual(est.catalogo.palavras_chave, 6, "total de palavras-chave do catalogo");
igual(est.catalogo.frases, 7, "total de frases do catalogo");

console.log("\n-- forma da linha que vai pro banco");
ok(linhas.every((l) => l.origem_ferramenta === "chatguru" && /^[a-f0-9]{6,}$/.test(l.origem_id)), "toda linha tem origem (e por isso reimportar atualiza em vez de duplicar)");
igual(new Set(linhas.map((l) => l.origem_id)).size, linhas.length, "nenhum origem_id repetido no lote");
igual(new Set(linhas.map((l) => normalizar(l.nome))).size, linhas.length, "nenhum nome repetido (uq_intencoes_nome nao seria violada por este lote)");
ok(linhas.every((l) => l.ativo === true), "o catalogo entra ativo — intencao sozinha nao dispara nada");
ok(
  linhas.every((l) => Number.isInteger(l.pontuacao_minima) && l.pontuacao_minima >= 1 && l.pontuacao_minima <= 1000),
  "toda pontuacao minima cabe no CHECK da migration 0022"
);
ok(
  linhas.every((l) => !("id" in l) && !("criada_em" in l)),
  "o importador nao inventa id nem data: quem gera e o banco"
);
igual(consolidar([...telaA.cruas, ...telaB.cruas], { limite: 1 }).linhas.length, 1, "--limite corta o trabalho");

console.log("\n-- a linha importada realmente reconhece (fecha o circuito com a lib do produto)");
for (const l of linhas) {
  const v = validarIntencao(l);
  ok(v.ok, `"${l.nome}" passa pelo validarIntencao da lib`, v.ok ? "" : v.erros.join(" | "));
}
const vAt = validarIntencao(atendente);
ok(pontuarIntencao(vAt.intencao, "quero falar com um especialista").reconhecida, "a frase de exemplo da origem dispara a intencao importada");
ok(!pontuarIntencao(vAt.intencao, "bom dia, tudo bem?").reconhecida, "mensagem sem relacao NAO dispara");
ok(
  !pontuarIntencao(vAt.intencao, "quero um atendente").reconhecida,
  "e o minimo 20 e obedecido: uma palavra solta (10 pontos) nao basta — se a uniao tivesse ficado com o minimo 2, aqui disparava"
);

// ────────────────────────────────────────────────────── a CLI de verdade
console.log("\n-- a CLI em --dry");
const dump = path.join(TRABALHO, "dump.json");
const saida = execFileSync(
  process.execPath,
  [
    path.join(AQUI, "intencoes.mjs"),
    "--pasta", FIXTURE,
    "--dry",
    "--trabalho", TRABALHO,
    "--dump", dump,
  ],
  { encoding: "utf8" }
);
ok(/2 tela\(s\)/.test(saida), "a CLI conta as telas lidas");
ok(/4 intencao/.test(saida), "a CLI conta o catalogo consolidado");
ok(!/service_role|apikey|Bearer/i.test(saida), "a saida nao vaza nada de credencial");

const doDump = JSON.parse(fs.readFileSync(dump, "utf8")).intencoes;
igual(doDump.map((l) => l.nome), linhas.map((l) => l.nome), "o dump da CLI bate com a consolidacao pura");

const arqJson = fs.readdirSync(TRABALHO).find((f) => f.endsWith(".json") && f.startsWith("relatorio-"));
ok(!!arqJson, "a CLI escreve o relatorio em json ao lado do markdown");
const md = fs.readFileSync(path.join(TRABALHO, arqJson.replace(/\.json$/, ".md")), "utf8");
ok(md.includes("SIMULACAO (--dry)"), "o markdown diz em alto e bom som que nada foi gravado");
ok(md.includes("Intencao sozinha nao dispara nada"), "o markdown declara pra quem le que o catalogo por si nao age");
ok(md.includes("sem custo por mensagem"), "e que o reconhecimento e local (nada de API paga)");
ok(md.includes("Pendencias"), "as pendencias aparecem no relatorio");
ok(md.includes("mais alta"), "a decisao da uniao (fica o minimo mais alto) esta EXPLICADA, nao so aplicada");
ok(!md.includes("undefined"), "o markdown nao tem buraco (nenhum 'undefined')");
ok(!md.includes("NaN"), "nenhum numero quebrado no relatorio");
ok(!md.includes("Atendente"), "sem --detalhe, nome de intencao (dado de cliente) NAO vai pro relatorio");

console.log("\n-- --detalhe e o unico jeito de ver termo de cliente");
const T2 = fs.mkdtempSync(path.join(os.tmpdir(), "prova-intencoes-d-"));
execFileSync(
  process.execPath,
  [path.join(AQUI, "intencoes.mjs"), "--pasta", FIXTURE, "--dry", "--detalhe", "--trabalho", T2],
  { encoding: "utf8" }
);
const arq2 = fs.readdirSync(T2).find((f) => f.endsWith(".md"));
const md2 = fs.readFileSync(path.join(T2, arq2), "utf8");
ok(md2.includes("Atendente"), "com --detalhe o nome aparece");
ok(md2.includes("especialista"), "com --detalhe os termos aparecem, pra conferencia termo a termo");
fs.rmSync(T2, { recursive: true, force: true });

console.log("\n-- a CLI se recusa a gravar sem destino");
let recusou = false;
try {
  execFileSync(process.execPath, [path.join(AQUI, "intencoes.mjs"), "--pasta", FIXTURE], {
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, MSG_SUPABASE_URL: "", MSG_SUPABASE_SERVICE_KEY: "" },
  });
} catch (e) {
  recusou = e.status === 2 && /obrigatorio informar --url e --key/.test(String(e.stderr || ""));
}
ok(recusou, "sem --dry e sem --url/--key: sai com erro, nunca grava as cegas");

console.log("\n-- a trava de CONTAS MISTURADAS (o susto que virou guardrail)");
// Rodado por engano contra a pasta que guarda o backup de VARIAS empresas, o
// passo juntava as intencoes de todas num catalogo unico — a palavra-chave de uma
// empresa passando a valer na instalacao de outra. Medido no acervo real: 54
// telas de 33 contas viravam UM catalogo de 19 intencoes.
const MISTO = fs.mkdtempSync(path.join(os.tmpdir(), "prova-intencoes-misto-"));
for (const conta of ["empresa-a", "empresa-b"]) {
  const dir = path.join(MISTO, conta, "automacao");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(arquivos[0], path.join(dir, path.basename(arquivos[0])));
}
let recusouMisto = false;
let mensagemMisto = "";
try {
  execFileSync(process.execPath, [path.join(AQUI, "intencoes.mjs"), "--pasta", MISTO, "--dry"], {
    encoding: "utf8",
    stdio: "pipe",
  });
} catch (e) {
  mensagemMisto = String(e.stderr || "");
  recusouMisto = e.status === 2;
}
ok(recusouMisto, "pasta com telas de contas DIFERENTES: para com erro, nao junta catalogo de duas empresas");
ok(/empresa-a[\s\S]*empresa-b/.test(mensagemMisto), "a mensagem lista as contas encontradas");
ok(/--pasta para a pasta da\s*\n?\s*SUA conta/.test(mensagemMisto), "e diz o que fazer (apontar pra propria conta)");

const saidaJunta = execFileSync(
  process.execPath,
  [path.join(AQUI, "intencoes.mjs"), "--pasta", MISTO, "--dry", "--juntar-contas", "--trabalho", MISTO],
  { encoding: "utf8" }
);
ok(/2 tela\(s\)/.test(saidaJunta), "--juntar-contas e a saida EXPLICITA pra quem tem a propria conta em subpastas");
const mdJunta = fs.readFileSync(path.join(MISTO, fs.readdirSync(MISTO).find((f) => f.endsWith(".md"))), "utf8");
ok(/\| Contas de origem \| 2 \|/.test(mdJunta), "e o relatorio DIZ que veio de 2 contas (nunca esconde)");
fs.rmSync(MISTO, { recursive: true, force: true });

// uma conta so (a pasta certa: <conta>/automacao/) nao dispara a trava
const UMA = fs.mkdtempSync(path.join(os.tmpdir(), "prova-intencoes-uma-"));
fs.mkdirSync(path.join(UMA, "automacao"), { recursive: true });
fs.copyFileSync(arquivos[0], path.join(UMA, "automacao", path.basename(arquivos[0])));
const saidaUma = execFileSync(
  process.execPath,
  [path.join(AQUI, "intencoes.mjs"), "--pasta", UMA, "--dry", "--trabalho", UMA],
  { encoding: "utf8" }
);
ok(/1 tela\(s\)/.test(saidaUma), "apontando pra pasta da propria conta, roda sem pedir flag nenhuma");
fs.rmSync(UMA, { recursive: true, force: true });

let semPasta = false;
let msgSemPasta = "";
try {
  execFileSync(process.execPath, [path.join(AQUI, "intencoes.mjs"), "--pasta", path.join(TRABALHO, "nao-existe"), "--dry"], {
    encoding: "utf8",
    stdio: "pipe",
  });
} catch (e) {
  semPasta = e.status === 2;
  msgSemPasta = String(e.stderr || "");
}
ok(semPasta, "pasta que nao existe para com erro claro");
ok(/pasta nao encontrada/.test(msgSemPasta), "e a mensagem diz QUAL foi o problema (nao 'nao achei tela nenhuma')");

// ────────────────────────────────────── o caminho de GRAVACAO, de verdade
// Sem isto, tres coisas eram afirmacao sem prova: (1) que --dry nao abre conexao;
// (2) que nome repetido no destino NAO derruba o lote inteiro; (3) que erro que
// nao e nome repetido PARA em vez de ser engolido. Nenhuma exige banco — um
// destino HTTP local em PROCESSO SEPARADO resolve (no mesmo processo nao
// funciona: execFileSync congela o event loop de quem chama).
console.log("\n-- o caminho de gravacao contra um destino de mentira");
const ARQ_PORTA = path.join(TRABALHO, "mock-porta.txt");
const ARQ_REQS = path.join(TRABALHO, "mock-requisicoes.ndjson");
const ARQ_ROTEIRO = path.join(TRABALHO, "mock-roteiro.json");
fs.writeFileSync(ARQ_REQS, "");
const roteiro = (r) => fs.writeFileSync(ARQ_ROTEIRO, JSON.stringify(r));
roteiro({});
const servidor = spawn(
  process.execPath,
  [path.join(AQUI, "prova-mock-destino.mjs"), ARQ_PORTA, ARQ_REQS, ARQ_ROTEIRO],
  { stdio: "ignore" }
);
// NAO deixar node orfao segurando porta se uma assercao adiante lancar. `exit`
// cobre mais que finally: esta prova termina com process.exit.
process.on("exit", () => {
  try {
    servidor.kill();
  } catch {
    // ja morreu
  }
});
let espera = 0;
while (!fs.existsSync(ARQ_PORTA) && espera < 100) {
  await new Promise((r) => setTimeout(r, 50));
  espera++;
}
ok(fs.existsSync(ARQ_PORTA), "o destino de mentira subiu");
const BASE = `http://127.0.0.1:${fs.readFileSync(ARQ_PORTA, "utf8").trim()}`;
const reqs = () =>
  fs
    .readFileSync(ARQ_REQS, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const rodar = (extra, roteiroNovo) => {
  if (roteiroNovo) roteiro(roteiroNovo);
  fs.writeFileSync(ARQ_REQS, "");
  try {
    const out = execFileSync(
      process.execPath,
      [path.join(AQUI, "intencoes.mjs"), "--pasta", FIXTURE, "--trabalho", TRABALHO, ...extra],
      { encoding: "utf8", stdio: "pipe", env: { ...process.env, MSG_SUPABASE_URL: BASE, MSG_SUPABASE_SERVICE_KEY: "chave-de-mentira" } }
    );
    return { status: 0, out };
  } catch (e) {
    return { status: e.status, out: String(e.stdout || ""), erro: String(e.stderr || "") };
  }
};

const seco = rodar(["--dry"]);
igual(seco.status, 0, "--dry roda sem erro");
igual(reqs().length, 0, "--dry NAO abre conexao nenhuma, mesmo com url e chave no ambiente");

const gravou = rodar([], { post_status: 201 });
igual(gravou.status, 0, "valendo: grava e termina bem");
const posts = reqs().filter((r) => r.metodo === "POST");
igual(posts.length, 1, "as 4 linhas vao num lote so");
ok(posts[0].caminho.endsWith("/rest/v1/intencoes"), "grava na tabela intencoes");
ok(
  posts[0].consulta.includes("on_conflict=origem_ferramenta,origem_id"),
  "com on_conflict pela origem — e o que faz reimportar ATUALIZAR em vez de duplicar"
);
igual(JSON.parse(posts[0].corpo).length, 4, "as 4 intencoes do catalogo no corpo");
ok(!/create table|alter table/i.test(posts[0].corpo), "nao manda DDL disfarcada de dado");
ok(/gravadas 4\/4/.test(gravou.out), "a saida diz quantas gravou");

const repetido = rodar([], {
  post_status: 409,
  post_corpo: JSON.stringify({ code: "23505", message: 'duplicate key value violates unique constraint "uq_intencoes_nome"' }),
});
igual(repetido.status, 0, "nome repetido no destino NAO derruba a execucao");
igual(
  reqs().filter((r) => r.metodo === "POST").length,
  5,
  "o lote recusado e reenviado LINHA POR LINHA (1 lote + 4 linhas) — as boas nao sao perdidas junto"
);
const arqRep = fs
  .readdirSync(TRABALHO)
  .filter((f) => f.startsWith("relatorio-") && f.endsWith(".md"))
  .sort()
  .pop();
const mdRep = fs.readFileSync(path.join(TRABALHO, arqRep), "utf8");
ok(mdRep.includes("Nome ja usado no painel"), "as recusadas viram pendencia nomeada no relatorio");
ok(mdRep.includes("Nada foi sobrescrito"), "e o relatorio diz que nada foi sobrescrito");

const outroErro = rodar([], { post_status: 500, post_corpo: JSON.stringify({ message: "boom" }) });
igual(outroErro.status, 1, "erro que NAO e nome repetido para a execucao (nunca e engolido)");
ok(/HTTP 500/.test(outroErro.erro), "e o status aparece no erro");
ok(!/chave-de-mentira/.test(outroErro.erro + outroErro.out), "a chave nao aparece em log nem em erro");

// ────────────────────────────────────────────────────── arquitetura
console.log("\n-- guardas de arquitetura");
const fonte = fs.readFileSync(path.join(AQUI, "intencoes.mjs"), "utf8");
ok(!/create\s+table|alter\s+table|drop\s+/i.test(fonte), "o importador NAO cria nem altera tabela");
ok(!/delete|truncate/i.test(fonte.replace(/keyword_delete|example_delete|intent_delete/g, "")), "o importador nao apaga nada");
ok(!/openai|anthropic|generativelanguage|gpt-/i.test(fonte), "nenhuma chamada a servico de IA");
ok(/console\.error\(`HTTP \$\{r\.status\}/.test(fonte), "erro de HTTP e reportado com o status, nao engolido");
ok(/23505/.test(fonte), "nome repetido no destino tem tratamento nomeado (nao derruba o lote inteiro)");
const RE_COMBINANTE_CRUA = new RegExp("[\u0300-\u036f]");
assert.equal(RE_COMBINANTE_CRUA.test(fonte), false, "marca combinante CRUA no fonte: ela morre em copia/patch e a classe deixa de casar em silencio");
ok(true, "nenhuma marca combinante crua no fonte");

fs.rmSync(TRABALHO, { recursive: true, force: true });
console.log(`\n${falhas ? `${falhas} FALHA(S)` : "TUDO OK"}`);
process.exit(falhas ? 1 : 0);
