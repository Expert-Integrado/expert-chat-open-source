// Prova do passo de re-hospedagem de midia (scripts/importar/midia.mjs).
//
//   node scripts/importar/prova-midia.mjs
//
// Roda a CLI de verdade contra o backup SINTETICO de scripts/importar/fixture-midia
// e contra um armazenamento LOCAL DE MENTIRA (pasta temporaria + prefixo publico
// declarado na linha de comando). Nao toca em bucket, nao toca em banco, nao usa
// rede: `--sem-rede` proibe download, e as URLs do fixture apontam pra um dominio
// inexistente de proposito.
//
// O fixture tem um caso de cada situacao que importa:
//   A  copia local pequena ........................ sobe
//   B  copia local acima do teto .................. pulado e declarado
//   C  sem copia local, com --sem-rede ............ pulado e declarado
//   D  ja re-hospedado numa rodada anterior ....... reusado, sem tocar em nada
//
// E prova as duas coisas que fazem este passo ser retomavel de verdade:
// (1) rodar de novo nao sobe nada outra vez; (2) o caminho no destino sai de um
// hash da URL de origem, entao a segunda passada escreve NO MESMO objeto em vez
// de duplicar 345 GB de acervo com outro nome.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(AQUI, "fixture-midia");
const TRABALHO = fs.mkdtempSync(path.join(os.tmpdir(), "prova-midia-"));
const MOCK = path.join(TRABALHO, "armazenamento-de-mentira");
const BASE_PUBLICA = "http://localhost/mock";

let falhas = 0;
const ok = (cond, oque, detalhe = "") => {
  console.log(`${cond ? "  ok  " : "FALHA "} ${oque}${detalhe ? ` — ${detalhe}` : ""}`);
  if (!cond) falhas++;
};
const igual = (obtido, esperado, oque) =>
  ok(
    JSON.stringify(obtido) === JSON.stringify(esperado),
    oque,
    `esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`
  );

const rodar = (extra, env) => {
  try {
    execFileSync(process.execPath, [path.join(AQUI, "midia.mjs"), "--pasta", FIXTURE, "--trabalho", TRABALHO, ...extra], {
      stdio: "pipe",
      ...(env ? { env } : {}),
    });
  } catch (e) {
    // exit 1 = rodou e teve falha de arquivo; o relatorio e o que interessa
    if (e.status !== 1) throw new Error(`midia.mjs saiu com ${e.status}: ${String(e.stderr || "").slice(0, 400)}`);
  }
  const arqs = fs.readdirSync(TRABALHO).filter((f) => f.startsWith("midia-") && f.endsWith(".json")).sort();
  return JSON.parse(fs.readFileSync(path.join(TRABALHO, arqs[arqs.length - 1]), "utf8"));
};
const arquivosNoMock = () => {
  const fora = [];
  const anda = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) anda(path.join(d, e.name));
      else fora.push(path.join(d, e.name));
    }
  };
  anda(MOCK);
  return fora;
};

console.log("PROVA DA RE-HOSPEDAGEM DE MIDIA (fixture sintetico, armazenamento local)\n");

console.log("-- --dry so inventaria");
const seco = rodar(["--dry"]);
igual(seco.modo, "inventario (--dry)", "o relatorio diz que foi inventario");
igual(seco.inventario.arquivos, 4, "conta os 4 arquivos distintos referenciados");
igual(seco.inventario.bytes_declarados, 162100, "soma o tamanho declarado no backup");
igual(seco.inventario.por_tipo, { image: 1, audio: 1, document: 1, video: 1 }, "e a distribuicao por tipo");
igual(seco.copia_local.existe, 3, "diz quantos ja tem copia local (nao precisariam de download)");
igual(seco.copia_local.falta, 1, "e quantos exigiriam download");
igual(seco.ja_rehospedados_antes, 1, "herda o estado da rodada anterior: 1 ja estava re-hospedado");
igual(seco.resultado, { subidos: 0, reusados: 0, enderecos_reescritos: 0, pulados: 0, falharam: 0 }, "e NAO subiu nada");
igual(arquivosNoMock(), [], "nada foi escrito no destino no modo --dry");

console.log("\n-- rodada 1: sobe o que da, pula o resto e declara o motivo");
const um = rodar(["--valendo", "--sem-rede", "--teto-mb", "0.1", "--destino-local", MOCK, "--url-publica-base", BASE_PUBLICA, "--sem-banco"]);
igual(um.resultado.subidos, 1, "sobe o unico arquivo pequeno com copia local");
igual(um.resultado.reusados, 1, "reusa o que ja estava re-hospedado, sem tocar em rede nem em disco");
igual(um.resultado.pulados, 2, "pula o acima do teto e o que exigiria download");
igual(um.resultado.falharam, 0, "e nao falha nenhum");
igual(um.motivos.acima_do_teto, 1, "o motivo do teto e nomeado");
igual(um.motivos.sem_copia_local_e_sem_rede, 1, "e o de falta de copia local tambem");
igual(um.resultado.enderecos_reescritos, 0, "com --sem-banco nenhum endereco e reescrito");
ok(
  um.pendencias.some((p) => p.tema === "enderecos"),
  "e o relatorio AVISA que os enderecos ficaram sem reescrever, dizendo onde esta o mapa"
);
ok(um.pendencias.some((p) => p.tema === "teto"), "o pulado por teto vira pendencia declarada");

const arquivos1 = arquivosNoMock();
igual(arquivos1.length, 1, "o destino recebeu exatamente 1 arquivo");
ok(/[/\\]central[/\\][0-9a-f]{32}\.jpg$/.test(arquivos1[0]), "com caminho <canal>/<hash>.<ext>", arquivos1[0]);
igual(fs.readFileSync(arquivos1[0]).length, 100, "e o conteudo e o do arquivo local, byte a byte");

const estado = JSON.parse(fs.readFileSync(path.join(TRABALHO, "rehospedagem-estado.json"), "utf8"));
const subidos = Object.entries(estado.subidos);
igual(subidos.length, 2, "o estado guarda os 2 enderecos conhecidos (o novo e o herdado)");
const novo = subidos.find(([de]) => de.includes("A_pequena"));
ok(novo[1].startsWith(`${BASE_PUBLICA}/central/`), "o endereco novo usa o prefixo publico DECLARADO na linha de comando", novo[1]);
igual(Object.keys(estado.ignorados || {}).length, 1, "o que ficou fora por teto e registrado em 'ignorados', com o motivo");

console.log("\n-- rodada 2: retomada nao sobe nada de novo e nao duplica o acervo");
const dois = rodar(["--valendo", "--sem-rede", "--teto-mb", "0.1", "--destino-local", MOCK, "--url-publica-base", BASE_PUBLICA, "--sem-banco"]);
igual(dois.resultado.subidos, 0, "nada sobe outra vez");
igual(dois.resultado.reusados, 2, "os dois ja conhecidos sao reusados do estado");
igual(dois.motivos.reusado_do_estado, 2, "e o motivo e nomeado no relatorio");
const arquivos2 = arquivosNoMock();
igual(arquivos2.length, 1, "o destino continua com 1 arquivo (caminho derivado da URL, nao sorteado)");
igual(arquivos2[0], arquivos1[0], "e e exatamente o MESMO caminho");

console.log("\n-- --recomecar reprocessa, e ainda assim nao duplica");
const tres = rodar([
  "--valendo",
  "--sem-rede",
  "--teto-mb",
  "0.1",
  "--destino-local",
  MOCK,
  "--url-publica-base",
  BASE_PUBLICA,
  "--sem-banco",
  "--recomecar",
]);
igual(tres.ja_rehospedados_antes, 0, "--recomecar ignora o estado");
igual(tres.resultado.subidos, 2, "e sobe os 2 que tem copia local (inclusive o que antes vinha do estado herdado)");
const arquivos3 = arquivosNoMock();
igual(arquivos3.length, 2, "o destino tem 2 objetos: um por URL de origem, nao um por passada");
ok(
  arquivos3.includes(arquivos1[0]),
  "e o objeto da primeira rodada foi REESCRITO no mesmo caminho — nada de segunda copia do mesmo arquivo com outro nome"
);

console.log("\n-- o destino nunca esta embutido no codigo");
let recusou = false;
try {
  execFileSync(
    process.execPath,
    [path.join(AQUI, "midia.mjs"), "--pasta", FIXTURE, "--trabalho", TRABALHO, "--valendo"],
    {
      stdio: "pipe",
      env: { ...process.env, MSG_SUPABASE_URL: "", MSG_SUPABASE_SERVICE_KEY: "" },
    }
  );
} catch (e) {
  recusou = e.status === 2 && String(e.stderr).includes("--url");
}
ok(recusou, "com --valendo, sem destino local e sem url/key no ambiente, o script RECUSA rodar");

console.log("\n-- o modo destrutivo NAO sai de um esquecimento (o default e o inventario)");
// Sem nenhuma flag o script tem que se comportar como --dry. Antes era o
// contrario: esquecer --dry era o caminho pra baixar e subir 345 GB e alterar o
// banco do cliente. A prova roda SEM flag nenhuma, com url/key preenchidos, e
// cobra que nada tenha acontecido.
const semFlag = rodar([]);
igual(semFlag.modo, "inventario (--dry)", "sem flag nenhuma o modo e inventario");
igual(
  semFlag.resultado,
  { subidos: 0, reusados: 0, enderecos_reescritos: 0, pulados: 0, falharam: 0 },
  "e nada foi subido, reusado, reescrito nem pulado"
);
igual(semFlag.reescreve_banco, false, "e o relatorio diz que NAO reescreve banco");

let recusouContradicao = false;
try {
  execFileSync(
    process.execPath,
    [path.join(AQUI, "midia.mjs"), "--pasta", FIXTURE, "--trabalho", TRABALHO, "--dry", "--valendo"],
    { stdio: "pipe" }
  );
} catch (e) {
  recusouContradicao = e.status === 2 && String(e.stderr).includes("contradizem");
}
ok(recusouContradicao, "--dry junto com --valendo e RECUSADO, em vez de um dos dois vencer em silencio");

let recusouSemBase = false;
try {
  execFileSync(
    process.execPath,
    [path.join(AQUI, "midia.mjs"), "--pasta", FIXTURE, "--trabalho", TRABALHO, "--destino-local", MOCK],
    { stdio: "pipe" }
  );
} catch (e) {
  recusouSemBase = e.status === 2 && String(e.stderr).includes("--url-publica-base");
}
ok(recusouSemBase, "e --destino-local sem --url-publica-base tambem: o endereco que iria pro banco tem que ser explicito");

// ─── O GUARDA DO --dry TEM PROVA, NAO PROMESSA ───────────────────────────────
// "o --dry nao abre conexao" era afirmacao sem medida: nada no teste detectaria o
// dia em que uma requisicao escapasse. Aqui um servidor HTTP local de mentira faz
// o papel do destino e CONTA cada requisicao — env envenenada (url e key
// preenchidas, apontando pro servidor) e a cobranca e ZERO requisicao.
console.log("\n-- guarda do --dry: env envenenada e zero requisicao");
const ARQ_PORTA = path.join(TRABALHO, "mock-porta.txt");
const ARQ_REQS = path.join(TRABALHO, "mock-requisicoes.ndjson");
const ARQ_ROTEIRO = path.join(TRABALHO, "mock-roteiro.json");
fs.writeFileSync(ARQ_ROTEIRO, JSON.stringify({}));
fs.writeFileSync(ARQ_REQS, "");
// PROCESSO SEPARADO de proposito: `execFileSync` congela o event loop de quem
// chama, entao um servidor no MESMO processo aceitaria a conexao e nunca
// responderia — a CLI filha esperaria pra sempre.
const servidor = spawn(
  process.execPath,
  [path.join(AQUI, "prova-mock-destino.mjs"), ARQ_PORTA, ARQ_REQS, ARQ_ROTEIRO],
  { stdio: "ignore" }
);
let espera = 0;
while (!fs.existsSync(ARQ_PORTA) && espera < 100) {
  await new Promise((r) => setTimeout(r, 50));
  espera++;
}
// NAO deixar node orfao: se uma assercao adiante lancar, o processo da prova
// morre e o servidor de mentira ficaria vivo segurando uma porta.
// `process.on("exit")` cobre MAIS que try/finally aqui, e por isso foi o
// escolhido: esta prova termina com `process.exit(falhas ? 1 : 0)`, e finally NAO
// roda em process.exit.
const encerrarMock = () => {
  try {
    servidor.kill();
  } catch {
    // ja morreu
  }
};
process.on("exit", encerrarMock);
ok(fs.existsSync(ARQ_PORTA), "o destino de mentira subiu");
const BASE_MOCK = `http://127.0.0.1:${fs.readFileSync(ARQ_PORTA, "utf8").trim()}`;
const requisicoes = () =>
  fs
    .readFileSync(ARQ_REQS, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .map((r) => `${r.metodo} ${r.caminho}`);
const envEnvenenada = {
  ...process.env,
  MSG_SUPABASE_URL: BASE_MOCK,
  MSG_SUPABASE_SERVICE_KEY: "chave-de-mentira",
};

const seco2 = rodar(["--dry"], envEnvenenada);
igual(seco2.modo, "inventario (--dry)", "com url/key no ambiente o --dry continua sendo inventario");
igual(seco2.falhas, [], "e nao reporta falha nenhuma (nao ha rede pra falhar)");
igual(seco2.resultado.falharam, 0, "nem contagem de falha");
igual(requisicoes(), [], "ZERO requisicao chegou ao servidor: o --dry realmente nao abre conexao");

const semFlag2 = rodar([], envEnvenenada);
igual(semFlag2.modo, "inventario (--dry)", "e sem flag nenhuma tambem");
igual(requisicoes(), [], "que tambem nao fez requisicao nenhuma");

// ─── REESCRITA: a falha SAI da lista quando o endereco e reescrito ────────────
console.log("\n-- falha de reescrita nao fica presa no estado pra sempre");
const comBanco = [
  "--valendo",
  "--recomecar",
  "--sem-rede",
  "--teto-mb",
  "0.1",
  "--destino-local",
  MOCK,
  "--url-publica-base",
  BASE_PUBLICA,
];
const quatro = rodar(comBanco, envEnvenenada);
igual(quatro.reescreve_banco, true, "com url/key e sem --sem-banco, a reescrita esta ligada");
igual(quatro.resultado.subidos, 2, "sobe os 2 com copia local");
igual(quatro.resultado.enderecos_reescritos, 2, "e reescreve os 2 enderecos");
ok(
  requisicoes().filter((r) => r.startsWith("PATCH")).length === 2,
  "o servidor recebeu exatamente 2 PATCH (um por arquivo)",
  requisicoes().join(" · ")
);

// injeta a falha que o bug deixava presa: arquivo JA subido cuja reescrita falhou
// numa rodada anterior. Ele entra pelo caminho `reusado`, que nem passa pelo
// delete do upload — se o delete nao existir tambem depois da reescrita, esta
// falha nunca some e o relatorio acusa defeito inexistente pra sempre.
const arqEstado = path.join(TRABALHO, "rehospedagem-estado.json");
const estadoInj = JSON.parse(fs.readFileSync(arqEstado, "utf8"));
const urlReusavel = Object.keys(estadoInj.subidos)[0];
estadoInj.falhas[urlReusavel] = "endereco subiu mas nao foi reescrito: HTTP 500 (falha plantada pela prova)";
fs.writeFileSync(arqEstado, JSON.stringify(estadoInj));

const cinco = rodar(comBanco.filter((f) => f !== "--recomecar"), envEnvenenada);
igual(cinco.resultado.subidos, 0, "a retomada nao sobe nada de novo");
igual(cinco.resultado.reusados, 2, "reusa os 2 do estado");
const estadoDepois = JSON.parse(fs.readFileSync(arqEstado, "utf8"));
igual(
  Object.keys(estadoDepois.falhas || {}),
  [],
  "e a falha PLANTADA saiu da lista, porque o endereco foi reescrito com sucesso"
);

// ─── CHECKPOINT: a trilha de apendice segura a retomada ──────────────────────
console.log("\n-- checkpoint: a trilha protege a retomada e ZERA quando cumpre o papel");
const trilha = path.join(TRABALHO, "rehospedagem-subidos.ndjson");
ok(fs.existsSync(trilha), "a trilha de apendice existe");
// TRUNCADA no fim da rodada, DEPOIS do snapshot forcado: o snapshot ja contem
// tudo que ela guardava. Sem truncar ela e acumulativa entre rodadas — no acervo
// medido (969 mil arquivos) seriam ~190 MB relidos na partida de toda passada
// seguinte pra recuperar exatamente nada.
igual(fs.readFileSync(trilha, "utf8").trim(), "", "e esta VAZIA depois da rodada que fechou o snapshot");

// A APPEND acontece por UPLOAD, NA HORA — e depois de uma rodada limpa a trilha
// esta truncada de proposito, entao ela NAO e observavel no arquivo. O que se
// checa aqui e o fonte: a chamada existe no ponto do upload, e o truncamento vem
// DEPOIS do snapshot forcado. Essa ORDEM e o que garante que nenhum upload fique
// sem registro em nenhum instante — inverter as duas linhas abriria a janela que
// a trilha existe pra fechar.
const fonteMidia = fs.readFileSync(path.join(AQUI, "midia.mjs"), "utf8");
ok(
  /estado\.subidos\[it\.url\] = urlNova;\s*\n\s*anotarSubido\(it\.url, urlNova\);/.test(fonteMidia),
  "a trilha e gravada NA HORA do upload, na linha seguinte ao registro no estado"
);
const posSnapshot = fonteMidia.indexOf("salvarEstado(true);");
const posTrunca = fonteMidia.indexOf("fs.writeFileSync(ARQ_TRILHA, \"\");");
ok(
  posSnapshot > 0 && posTrunca > posSnapshot,
  "e o truncamento da trilha vem DEPOIS do snapshot forcado, nunca antes"
);
// PARADA SECA: reconstitui a trilha como ela fica NO MEIO da rodada (uma linha
// por upload ja feito) e derruba o snapshot. A trilha sozinha tem que evitar o
// re-upload de tudo.
const snapshot = JSON.parse(fs.readFileSync(arqEstado, "utf8"));
fs.writeFileSync(
  trilha,
  Object.entries(snapshot.subidos)
    .map(([de, para]) => JSON.stringify({ de, para }))
    .join("\n") + "\n"
);
fs.rmSync(arqEstado);
const seis = rodar(comBanco.filter((x) => x !== "--recomecar"), envEnvenenada);
igual(seis.resultado.subidos, 0, "sem o snapshot, a trilha sozinha ja evita o re-upload");
igual(seis.resultado.reusados, 2, "os 2 uploads foram recuperados do apendice");

encerrarMock();

console.log("\n-- relatorio em markdown");
const md = fs
  .readdirSync(TRABALHO)
  .filter((f) => f.startsWith("midia-") && f.endsWith(".md"))
  .sort()
  .pop();
const texto = fs.readFileSync(path.join(TRABALHO, md), "utf8");
ok(texto.includes("# Re-hospedagem de midia"), "o markdown foi gerado");
ok(texto.includes("armazenamento de mentira"), "e diz em alto e bom som que o destino era de mentira");
ok(!texto.includes("undefined"), "sem buraco (nenhum 'undefined')");

fs.rmSync(TRABALHO, { recursive: true, force: true });
console.log(`\n${falhas ? `${falhas} FALHA(S)` : "TUDO OK"}`);
process.exit(falhas ? 1 : 0);
