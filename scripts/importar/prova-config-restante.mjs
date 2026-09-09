// Prova do passo de configuracao restante (scripts/importar/config-restante.mjs).
//
//   node scripts/importar/prova-config-restante.mjs
//
// Roda a CLI em --dry contra o backup SINTETICO de scripts/importar/fixture-config.
// Nao abre conexao com banco nenhum.
//
// O fixture reproduz o unico jeito que a resposta rapida existe no backup — a
// TELA SALVA, com atalho e texto nos atributos do formulario — e um caso de cada
// armadilha real:
//
//   01  atalho ja valido, texto com variavel do sistema antigo e entidade HTML
//   02  atalho com ACENTO, ESPACO e MAIUSCULA (o painel aceita so [a-z0-9_-])
//   03  atalho que, depois de normalizado, COLIDE com o 02
//   04  textarea vazia
//   05  atalho que nao sobra nada depois de normalizar ("///")
//   06  texto acima do limite do formulario do painel (2.000 caracteres)
//
// E a biblioteca de anexos, que o painel nao tem: o teste e que ela seja MEDIDA e
// declarada como ressalva, com inventario em arquivo — nunca importada em
// silencio pra uma tabela que ninguem le.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(AQUI, "fixture-config");
const TRABALHO = fs.mkdtempSync(path.join(os.tmpdir(), "prova-config-"));
const DUMP = path.join(TRABALHO, "linhas.json");

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

console.log("PROVA DA CONFIGURACAO RESTANTE (fixture sintetico, modo --dry)\n");

execFileSync(
  process.execPath,
  [path.join(AQUI, "config-restante.mjs"), "--pasta", FIXTURE, "--dry", "--trabalho", TRABALHO, "--dump", DUMP],
  { stdio: "pipe" }
);
const arq = fs.readdirSync(TRABALHO).find((f) => f.startsWith("config-restante-") && f.endsWith(".json"));
ok(!!arq, "gera o relatorio em json");
const e = JSON.parse(fs.readFileSync(path.join(TRABALHO, arq), "utf8"));
const linhas = JSON.parse(fs.readFileSync(DUMP, "utf8")).respostas_rapidas;
const porAtalho = (a) => linhas.find((l) => l.atalho === a);
const rr = e.respostas_rapidas;

console.log("-- respostas rapidas: ler da tela salva");
igual(rr.encontradas, 6, "acha as 6 respostas na tela salva (nao existe JSON delas no backup)");
igual(rr.prontas, 3, "3 entram: as outras nao tem texto, nao tem atalho, ou colidem");
igual(rr.gravadas, null, "em --dry nada e gravado");
igual(
  linhas.map((l) => l.atalho).sort(),
  ["iniciar-atendimento", "saudacao-inicial", "texto-longo"],
  "e os atalhos que entram sao exatamente estes"
);

console.log("\n-- o atalho e normalizado pro que o painel aceita");
igual(rr.atalhos_normalizados, 2, "conta os atalhos que precisaram ser reescritos (inclusive o que depois colidiu)");
ok(!!porAtalho("saudacao-inicial"), "\"Saudação Inicial\" vira \"saudacao-inicial\" (sem acento, sem espaco, minusculo)");
ok(
  linhas.every((l) => /^[a-z0-9_-]{1,30}$/.test(l.atalho)),
  "e TODO atalho que entra passa na mesma validacao da rota do painel"
);

console.log("\n-- colisao de atalho nao e resolvida no chute");
igual(rr.colisoes.length, 1, "a colisao e detectada");
igual(rr.colisoes[0].atalho, "saudacao-inicial", "com o atalho que colidiu");
igual(rr.colisoes[0].original, "saudacao  inicial", "e o texto ORIGINAL preservado pra revisao humana");
igual(linhas.filter((l) => l.atalho === "saudacao-inicial").length, 1, "so uma entra");
ok(
  e.pendencias.some((p) => p.tema === "respostas rapidas" && /colidiram/.test(p.detalhe)),
  "e a colisao vira pendencia declarada (renomear no painel e um clique; sobrescrever perderia texto)"
);

console.log("\n-- variavel do sistema antigo: importa e AVISA");
igual(rr.com_variavel, 2, "conta as respostas que usam variavel da ferramenta antiga");
igual(rr.variaveis_distintas, ["{DAY_GREETING}", "{PRIMEIRO_NOME_LEAD}"], "e diz QUAIS variaveis sao");
ok(
  porAtalho("iniciar-atendimento").texto.includes("{PRIMEIRO_NOME_LEAD}"),
  "o texto entra com a variavel COMO ESTA — quem resolve e a leitura (lib/fluxo/variaveis.ts)"
);
ok(
  e.pendencias.some((p) => /origem de importacao/.test(p.detalhe) && /variavel/.test(p.detalhe)),
  "e o relatorio explica que a resolucao acontece na leitura, so em resposta com origem de importacao"
);

console.log("\n-- entidade HTML da tela salva e decodificada");
ok(
  porAtalho("iniciar-atendimento").texto.includes("& obrigado"),
  "\"&amp;\" volta a ser \"&\" (senao o atendente enviaria o codigo da entidade)",
  porAtalho("iniciar-atendimento").texto
);

console.log("\n-- o que nao tem como entrar");
igual(rr.sem_texto, 1, "resposta com textarea vazia nao entra");
igual(rr.sem_atalho, 1, "e nem a que nao sobra atalho nenhum depois de normalizar");
ok(
  e.pendencias.some((p) => /sem texto/.test(p.detalhe)),
  "as duas ausencias sao declaradas, nao silenciosas"
);

console.log("\n-- texto maior que o formulario do painel aceita");
igual(rr.acima_do_limite_da_tela, 1, "conta o texto acima de 2.000 caracteres");
igual(porAtalho("texto-longo").texto.length, 2500, "e o texto entra INTEIRO (a coluna e text, sem limite)");
ok(
  e.pendencias.some((p) => /2\.000 caracteres/.test(p.detalhe)),
  "com a ressalva de que editar pela tela vai exigir encurtar"
);

console.log("\n-- escopo: resposta da conta, nao de uma pessoa");
ok(
  linhas.every((l) => l.dono_id === null),
  "toda resposta entra como GLOBAL (dono_id null), que e o que ela e no sistema antigo"
);

console.log("\n-- idempotencia por origem");
ok(
  linhas.every((l) => l.origem_ferramenta === "chatguru" && /^[a-z0-9]{24}$/.test(l.origem_id)),
  "cada linha carrega (origem_ferramenta, origem_id) — a chave que faz reimportar ATUALIZAR em vez de duplicar"
);
igual(
  new Set(linhas.map((l) => l.origem_id)).size,
  linhas.length,
  "e os ids de origem sao distintos (senao o upsert colapsaria linhas)"
);
const ddl = fs.readFileSync(path.join(AQUI, "..", "..", "supabase", "migrations", "0020_respostas_rapidas_origem.sql"), "utf8");
ok(ddl.includes("add column if not exists origem_ferramenta"), "a migration 0020 cria as colunas de origem");
ok(
  ddl.includes("create unique index if not exists uq_respostas_rapidas_origem") && !/uq_respostas_rapidas_origem[\s\S]{0,200}where /.test(ddl),
  "com indice unico TOTAL, sem `where` — indice parcial faz o PostgREST estourar 42P10 no on_conflict"
);

console.log("\n-- biblioteca de anexos: medida e declarada, nunca inventada");
igual(e.anexos.encontrados, 3, "conta os anexos que o backup capturou");
igual(e.anexos.bytes, 9520000, "soma o tamanho DOS CAPTURADOS");
igual(e.anexos.com_etiqueta, 1, "e quantos tem etiqueta");
igual(e.anexos.por_mime, { "application/pdf": 1, "image/png": 1, "video/mp4": 1 }, "com a distribuicao por mime");
ok(
  // FRENTE W (31/08/2026): a frase mudou porque o FATO mudou — o painel passou a ter
  // biblioteca. O que a pendencia tem que dizer agora e QUEM importa o acervo, e que
  // esse passo roda ANTES da conversao dos fluxos.
  e.pendencias.some((p) => p.tema === "anexos" && /importar\/anexos\.mjs/.test(p.detalhe)),
  "e a ausencia de biblioteca no painel e ressalva DECLARADA, com o numero na mesa"
);

console.log("\n-- A TELA DE ANEXOS E PAGINADA: a fatia nao pode virar o total");
// A revisao cega reprovou exatamente isto: o script publicava `attachments.length`
// como tamanho da biblioteca, ignorando `total_results`. Medido no acervo real:
// 795 capturados contra 3.287 declarados, 11 das 33 contas cortadas.
igual(e.anexos.total_na_origem, 7, "le `total_results`, que e o tamanho REAL da biblioteca");
igual(e.anexos.paginas_na_origem, 3, "e `total_pages`");
igual(e.anexos.pagina_capturada, 1, "e diz QUAL pagina o backup guardou");
igual(e.anexos.parcial, true, "marca o inventario como PARCIAL");
ok(
  e.pendencias.some((p) => p.tema === "anexos (captura incompleta)" && /pagina 1 de 3/.test(p.detalhe)),
  "abre pendencia dizendo que o export capturou so a 1a pagina"
);
ok(
  e.pendencias.some((p) => p.tema === "anexos" && /\*\*7 anexo\(s\)/.test(p.detalhe)),
  "e a pendencia principal publica 7 (o declarado), nunca 3 (a fatia)"
);
const inv = JSON.parse(fs.readFileSync(e.anexos.inventario_em, "utf8"));
igual(inv.parcial, true, "o arquivo de inventario tambem se declara parcial");
igual(inv.total_na_origem, 7, "e carrega o total da origem, pra quem ler so o arquivo nao se enganar");
igual(inv.anexos.length, 3, "o inventario tem o que foi capturado (nada do capturado e perdido)");
igual(
  inv.anexos[0].url,
  "https://armazem.invalido/conta-fixture/attached/guia_123.pdf",
  "com o endereco montado, pra que o passo de midia consiga re-hospedar"
);
ok(inv.anexos[0].tem_descricao === true, "e marca quem tinha texto de acompanhamento (que e conteudo, e sumiria junto)");

console.log("\n-- VERIFY: o que outro passo ja trouxe");
igual(e.ja_importado_por_outro_passo.etiquetas_no_catalogo, 2, "le o catalogo de etiquetas do backup");
igual(e.ja_importado_por_outro_passo.funis, 1, "e os funis");
igual(e.ja_importado_por_outro_passo.etapas_de_funil, 1, "e as etapas");
ok(
  e.ja_importado_por_outro_passo.quem_traz.etiquetas.includes("chatguru.mjs"),
  "e aponta QUEM traz cada uma, pra ninguem importar duas vezes achando que faltou"
);

console.log("\n-- relatorio em markdown");
const md = fs.readFileSync(path.join(TRABALHO, arq.replace(/\.json$/, ".md")), "utf8");
ok(md.includes("# Configuracao restante"), "o markdown foi gerado");
ok(md.includes("SIMULACAO (--dry)"), "e diz que nada foi gravado");
ok(md.includes("INVENTARIO PARCIAL"), "e o markdown avisa na cara que o inventario de anexos esta cortado");
ok(!md.includes("undefined"), "sem buraco (nenhum 'undefined')");

// ═══ DESTINO DE MENTIRA: o que so aparece quando existe um servidor pra falar ══
// Tres coisas que eram AFIRMACAO sem prova ate aqui: (1) o --dry nao abre conexao;
// (2) a pre-condicao da migration 0020 PARA de verdade; (3) atalho que ja existe
// no destino nao e sobrescrito. As tres exigem um destino, e nenhuma exige banco
// de verdade — um servidor HTTP local em PROCESSO SEPARADO resolve (no mesmo
// processo nao funciona: `execFileSync` congela o event loop de quem chama).
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
const BASE = `http://127.0.0.1:${fs.readFileSync(ARQ_PORTA, "utf8").trim()}`;
const zerarReqs = () => fs.writeFileSync(ARQ_REQS, "");
const reqs = () =>
  fs
    .readFileSync(ARQ_REQS, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

const rodarContra = (extra, env) => {
  const trab = fs.mkdtempSync(path.join(os.tmpdir(), "prova-config-r-"));
  try {
    execFileSync(
      process.execPath,
      [path.join(AQUI, "config-restante.mjs"), "--pasta", FIXTURE, "--trabalho", trab, ...extra],
      { stdio: "pipe", env: { ...process.env, ...env } }
    );
  } catch (e) {
    // exit 1 = rodou e registrou erro no relatorio; e isso que a prova le
    if (e.status !== 1) throw new Error(`config-restante saiu com ${e.status}: ${String(e.stderr || "").slice(0, 400)}`);
  }
  const a = fs.readdirSync(trab).find((f) => f.startsWith("config-restante-") && f.endsWith(".json"));
  return JSON.parse(fs.readFileSync(path.join(trab, a), "utf8"));
};

console.log("\n-- guarda do --dry: env envenenada e ZERO requisicao");
zerarReqs();
const seco = rodarContra(["--dry"], { MSG_SUPABASE_URL: BASE, MSG_SUPABASE_SERVICE_KEY: "chave-de-mentira" });
igual(seco.erros, [], "com url e key no ambiente, o --dry nao registra erro nenhum");
igual(seco.respostas_rapidas.gravadas, null, "e nao grava nada");
igual(reqs(), [], "ZERO requisicao chegou ao servidor: o --dry realmente nao abre conexao");

console.log("\n-- pre-condicao da migration 0020: PARA antes de gravar");
zerarReqs();
roteiro({ colunas_de_origem: false });
const semDdl = rodarContra([], { MSG_SUPABASE_URL: BASE, MSG_SUPABASE_SERVICE_KEY: "chave-de-mentira" });
igual(
  reqs().filter((r) => r.metodo === "POST").length,
  0,
  "com o select das colunas de origem respondendo 400, NENHUM POST sai"
);
igual(semDdl.respostas_rapidas.gravadas, null, "e o relatorio nao finge que gravou");
ok(
  semDdl.pendencias.some((p) => p.tema === "migration" && /0020/.test(p.detalhe)),
  "a pendencia diz qual migration aplicar"
);
ok(
  semDdl.erros.some((x) => /sem colunas de origem/.test(x)),
  "e o erro registra o HTTP que veio do destino, em vez de virar sucesso silencioso"
);

console.log("\n-- atalho que JA existe no destino nao e sobrescrito");
zerarReqs();
// "saudacao-inicial" ja existe na instalacao, criado NA TELA (sem origem).
roteiro({ atalhos: [{ atalho: "saudacao-inicial", origem_ferramenta: null, origem_id: null }] });
const comColisao = rodarContra([], { MSG_SUPABASE_URL: BASE, MSG_SUPABASE_SERVICE_KEY: "chave-de-mentira" });
igual(comColisao.respostas_rapidas.colisoes_no_destino.length, 1, "a colisao contra o destino e detectada");
igual(
  comColisao.respostas_rapidas.colisoes_no_destino[0].atalho,
  "saudacao-inicial",
  "com o atalho nomeado pra revisao"
);
igual(comColisao.respostas_rapidas.gravadas, 2, "das 3 prontas, so 2 sao gravadas");
const posts = reqs().filter((r) => r.metodo === "POST");
igual(posts.length, 1, "sai UM post");
const corpo = JSON.parse(posts[0].corpo);
igual(
  corpo.map((l) => l.atalho).sort(),
  ["iniciar-atendimento", "texto-longo"],
  "e o corpo do POST NAO contem o atalho que ja existe no destino"
);
ok(
  comColisao.pendencias.some((p) => /JA EXISTEM no destino/.test(p.detalhe)),
  "e a ressalva explica que gravar sobrescreveria o texto que a equipe usa hoje"
);

console.log("\n-- a MESMA origem nao e colisao: e a nossa linha de uma passada anterior");
zerarReqs();
const origemNossa = linhas.find((l) => l.atalho === "saudacao-inicial").origem_id;
roteiro({ atalhos: [{ atalho: "saudacao-inicial", origem_ferramenta: "chatguru", origem_id: origemNossa }] });
const reimport = rodarContra([], { MSG_SUPABASE_URL: BASE, MSG_SUPABASE_SERVICE_KEY: "chave-de-mentira" });
igual(reimport.respostas_rapidas.colisoes_no_destino.length, 0, "nenhuma colisao");
igual(reimport.respostas_rapidas.gravadas, 3, "as 3 vao pro upsert, que ATUALIZA em vez de duplicar");

console.log("\n-- ler o destino e pre-condicao: leitura que falha NAO grava no escuro");
zerarReqs();
roteiro({ ler_atalhos: false });
const semLeitura = rodarContra([], { MSG_SUPABASE_URL: BASE, MSG_SUPABASE_SERVICE_KEY: "chave-de-mentira" });
igual(
  reqs().filter((r) => r.metodo === "POST").length,
  0,
  "sem conseguir ler os atalhos do destino, nenhum POST sai"
);
igual(semLeitura.respostas_rapidas.gravadas, null, "e o relatorio nao finge que gravou");
ok(
  semLeitura.erros.some((x) => /atalhos globais/.test(x)),
  "com o erro dizendo exatamente o que nao deu pra ler"
);

encerrarMock();

fs.rmSync(TRABALHO, { recursive: true, force: true });
console.log(`\n${falhas ? `${falhas} FALHA(S)` : "TUDO OK"}`);
process.exit(falhas ? 1 : 0);
