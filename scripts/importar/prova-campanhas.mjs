// Prova do importador de CAMPANHAS — roda a CLI em --dry contra o backup
// SINTETICO de scripts/importar/fixture-campanhas/ e confere o mapeamento
// linha a linha.
//
//   node scripts/importar/prova-campanhas.mjs
//
// Nao toca banco nenhum e nao usa dado de cliente. A fixture tem um caso de cada
// armadilha: coluna em ORDEM DIFERENTE da producao (prova que o casamento e por
// cabecalho), numero com separador de milhar, campanha sem dialogo, campanha
// repetida no proprio backup, linha sem nome e linha sem identificador.
//
// GUARDRAIL provado aqui, e nao so prometido: nenhuma linha gerada pode disparar.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { converter, dataBr, estadoDaOrigem, idsDosLinks, inteiro, mapearColunas } from "./campanhas.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(AQUI, "fixture-campanhas");
const TRABALHO = fs.mkdtempSync(path.join(os.tmpdir(), "prova-campanhas-"));

let falhas = 0;
const ok = (cond, oque, detalhe = "") => {
  console.log(`${cond ? "  ok  " : "FALHA "} ${oque}${detalhe ? ` — ${detalhe}` : ""}`);
  if (!cond) falhas++;
};
const igual = (obtido, esperado, oque) =>
  ok(
    JSON.stringify(obtido) === JSON.stringify(esperado),
    oque,
    JSON.stringify(obtido) === JSON.stringify(esperado)
      ? ""
      : `esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`
  );

console.log("PROVA DO IMPORTADOR DE CAMPANHAS (fixture sintetica, modo --dry)\n");

// ─────────────────────────────────────────────── funcoes puras de leitura
console.log("-- leitura da tabela crua");
igual(
  mapearColunas(["STATUS", "CAMPANHA", "RECIPIENTES"]),
  { nome: 1, status: 0, progresso: -1, destinatarios: 2, fluxo: -1, inicio: -1, criacao: -1 },
  "casa coluna pelo NOME do cabecalho, em qualquer ordem"
);
igual(mapearColunas(["DIÁLOGO"]).fluxo, 0, "cabecalho com acento e casado igual");
igual(inteiro("2.400"), 2400, "numero com separador de milhar vira inteiro");
igual(inteiro(""), null, "celula vazia vira null, nunca 0 (0 destinatarios seria mentira)");
igual(dataBr("24/08/2026 08:34"), "2026-08-24T11:34:00.000Z", "data BR vira ISO tratando BRT como UTC-3");
igual(dataBr(""), null, "data vazia nao vira 1970");
igual(dataBr("qualquer coisa"), null, "data ilegivel nao vira data errada");
igual(
  idsDosLinks(["/campaigns/abc123def456/view", "/chatbot/x1/dialog/deadbeef1234/edit"]),
  { origem_id: "abc123def456", origem_fluxo_id: "deadbeef1234" },
  "extrai id da campanha e do fluxo dos links da linha"
);
igual(idsDosLinks(["/relatorio/x"]), { origem_id: null, origem_fluxo_id: null }, "link que nao e de campanha nao inventa id");

console.log("\n-- estado: registro historico so existe em estado TERMINAL");
igual(estadoDaOrigem("FINALIZADA").estado, "concluida", "FINALIZADA vira concluida");
igual(
  estadoDaOrigem("PAUSADA").estado,
  "concluida",
  "PAUSADA na origem NAO vira pausada aqui (pausada e estado VIVO, que o tick retoma)"
);
igual(estadoDaOrigem("CANCELADA").estado, "cancelada", "CANCELADA vira cancelada");

// ───────────────────────────────────────────────────────── a CLI em --dry
console.log("\n-- CLI em modo --dry (nao abre conexao)");
const DUMP = path.join(TRABALHO, "linhas.json");
const saida = execFileSync(
  process.execPath,
  [path.join(AQUI, "campanhas.mjs"), "--pasta", FIXTURE, "--dry", "--trabalho", TRABALHO, "--dump", DUMP],
  { stdio: "pipe" }
).toString();
ok(saida.includes("campanha(s) mapeada(s)"), "a CLI roda e relata o que mapeou");

const linhas = JSON.parse(fs.readFileSync(DUMP, "utf8")).campanhas;
const arq = fs.readdirSync(TRABALHO).find((f) => f.startsWith("relatorio-campanhas-") && f.endsWith(".json"));
ok(!!arq, "gera o relatorio em json");
const e = JSON.parse(fs.readFileSync(path.join(TRABALHO, arq), "utf8"));

console.log("\n-- contagens");
igual(e.origem.linhas, 6, "le as 6 linhas da fixture");
igual(e.mapeado.campanhas, 3, "mapeia 3 campanhas (as outras 3 sao descartes declarados)");
igual(e.descartados.sem_nome, 1, "descarta a linha sem nome de campanha");
igual(e.descartados.sem_id, 1, "descarta a linha sem identificador na origem");
igual(e.descartados.duplicadas_no_backup, 1, "descarta a campanha repetida dentro do proprio backup");
igual(e.mapeado.destinatarios_somados, 2560, "soma os destinatarios (150 + 2400 + 10)");
// medido no acervo real: TER NOME de fluxo e TER ID do fluxo sao coisas
// diferentes (134 x 87). Contar as duas como uma so faria o relatorio declarar
// "sem fluxo" campanha que tem fluxo sim — so nao tem o link pra ele.
igual(e.mapeado.com_fluxo_nome, 2, "duas campanhas trazem o nome do fluxo");
igual(e.mapeado.com_fluxo_id, 2, "e as mesmas duas trazem o id (ligacao navegavel)");
igual(e.mapeado.sem_fluxo_id, 1, "a terceira nao tem id de fluxo — declarado, nao escondido");
// o status conta as campanhas MAPEADAS, nao as linhas lidas: se contasse a
// repetida, o relatorio somaria 4 no status e declararia 3 mapeadas — um
// relatorio que se contradiz e pior que um numero a menos
igual(e.por_status, { finalizada: 1, pausada: 1, cancelada: 1 }, "o status conta as campanhas mapeadas, e fecha com o total");
igual(
  Object.values(e.por_status).reduce((a, b) => a + b, 0),
  e.mapeado.campanhas,
  "a soma do status bate exatamente com o numero de campanhas mapeadas"
);

console.log("\n-- as linhas que iriam pro banco");
const a1 = linhas.find((l) => l.origem_id === "aaaa000000000000000000a1");
ok(!!a1, "a campanha A foi mapeada");
igual(a1.nome, "Campanha de teste A", "nome vem da coluna CAMPANHA, mesmo ela sendo a 2a");
igual(a1.destinatarios_total, 150, "destinatarios vem da coluna RECIPIENTES, mesmo ela sendo a 3a");
igual(a1.progresso_origem, "100%", "progresso da origem e preservado");
igual(a1.origem_fluxo_id, "cccc000000000000000000c1", "guarda o id do fluxo pra ligacao campanha -> fluxo");
igual(a1.origem_fluxo_nome, "Fluxo de boas-vindas", "e o nome do fluxo, legivel antes de os fluxos existirem");
igual(a1.origem_ferramenta, "chatguru", "carimba a ferramenta de origem");
igual(a1.iniciada_em, "2026-01-02T12:30:00.000Z", "data de inicio convertida de BRT");

console.log("\n-- GUARDRAIL: nada do que entra pode disparar");
ok(
  linhas.every((l) => l.historico === true),
  "TODA campanha importada entra com historico = true"
);
ok(
  linhas.every((l) => ["concluida", "cancelada"].includes(l.estado)),
  "TODA campanha importada entra em estado terminal",
  linhas.map((l) => l.estado).join(",")
);
ok(
  linhas.every((l) => l.mensagem === ""),
  "nenhuma campanha importada ganha corpo de mensagem (inventar texto criaria mensagem que ninguem escreveu)"
);
ok(
  !JSON.stringify(linhas).includes("campanha_destinos") && linhas.every((l) => !l.destinos),
  "nenhuma lista de destinos e criada: nao ha fila pro motor consumir"
);

console.log("\n-- idempotencia");
const dump2 = path.join(TRABALHO, "linhas2.json");
execFileSync(
  process.execPath,
  [path.join(AQUI, "campanhas.mjs"), "--pasta", FIXTURE, "--dry", "--trabalho", TRABALHO, "--dump", dump2],
  { stdio: "pipe" }
);
igual(
  JSON.parse(fs.readFileSync(dump2, "utf8")).campanhas.map((l) => l.origem_id).sort(),
  linhas.map((l) => l.origem_id).sort(),
  "rodar de novo produz exatamente as mesmas linhas (a gravacao casa por origem_ferramenta+origem_id)"
);
igual(new Set(linhas.map((l) => l.origem_id)).size, linhas.length, "nenhum origem_id repetido no lote");

console.log("\n-- relatorio em markdown");
const md = fs.readFileSync(path.join(TRABALHO, arq.replace(/\.json$/, ".md")), "utf8");
ok(md.includes("SIMULACAO (--dry)"), "o markdown diz em alto e bom som que nada foi gravado");
ok(md.includes("nao dispara mensagem em nenhuma condicao"), "o markdown declara o guardrail pra quem le");
ok(!md.includes("undefined"), "o markdown nao tem buraco (nenhum 'undefined')");
ok(
  !md.includes("Campanha de teste A"),
  "sem --detalhe, nome de campanha (dado de cliente) NAO vai pro relatorio"
);

fs.rmSync(TRABALHO, { recursive: true, force: true });
console.log(`\n${falhas ? `${falhas} FALHA(S)` : "TUDO OK"}`);
process.exit(falhas ? 1 : 0);
