// Rodada em LOTE do importador, em simulacao, sobre uma arvore de backups.
//
//   node scripts/importar/lote.mjs --raiz <pasta com os backups> [--saida <arq.md>]
//
// Serve pra UMA coisa: medir, de uma vez, o que sairia de cada conta antes de
// tocar em banco nenhum. Roda `chatguru.mjs --dry` por conta, junta os relatorios
// e publica uma tabela por conta + os totais.
//
// **Este script NAO grava, e nao tem como gravar.** Nao aceita --url nem --key, e
// recusa rodar sem --dry. O motivo nao e cautela generica: cada conta destas e um
// CLIENTE DIFERENTE, com instalacao e banco proprios. Um lote apontado pra um
// unico destino misturaria a operacao de 33 empresas numa base so — estrago
// irreversivel e sem volta bonita. A carga de verdade e uma conta por vez, com a
// URL e a chave daquele cliente.
//
// O terminal mostra so CONTAGEM. Nome de conta e de empresa e dado de cliente:
// vai pro arquivo de relatorio, que fica na maquina de quem roda.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const RAIZ = arg("raiz");
const LIMITE = Number(arg("limite", 0)) || 0;
const PROFUNDIDADE = Math.max(1, Number(arg("profundidade", 3)) || 3);

if (!RAIZ || flag("help") || flag("ajuda")) {
  console.log(`uso: node scripts/importar/lote.mjs --raiz <pasta com os backups> [--saida <arq.md>]

  --raiz <dir>          pasta que contem as pastas de backup (procura chats_index.json)
  --saida <arq.md>      onde gravar a tabela consolidada (default: <raiz>/_logs/lote-dry-<carimbo>.md)
  --limite <n>          passa --limite pro importador (teste curto: N conversas por conta)
  --profundidade <n>    quantos niveis descer procurando backup (default: 3)
  --dry                 obrigatorio. Este script NAO grava em banco nenhum.`);
  process.exit(RAIZ ? 0 : 2);
}
if (!flag("dry")) {
  console.error(
    "este script e SO de simulacao: rode com --dry.\n\n" +
      "A carga de verdade e uma conta por vez, com a URL e a chave DAQUELE cliente:\n" +
      "  node scripts/importar/chatguru.mjs --pasta <backup da conta> --url ... --key ...\n"
  );
  process.exit(2);
}
for (const proibido of ["url", "key"]) {
  if (process.argv.includes(`--${proibido}`)) {
    console.error(`--${proibido} nao existe aqui: o lote nunca abre conexao com banco.`);
    process.exit(2);
  }
}
if (!fs.existsSync(RAIZ)) {
  console.error(`pasta nao encontrada: ${RAIZ}`);
  process.exit(2);
}

// Backup = pasta que tem chats_index.json. Descer por niveis acha tanto a conta
// solta na raiz quanto as que ficam dentro de uma pasta "clientes/".
function acharBackups(raiz, nivel = 0) {
  const achados = [];
  if (nivel > PROFUNDIDADE) return achados;
  let entradas = [];
  try {
    entradas = fs.readdirSync(raiz, { withFileTypes: true });
  } catch {
    return achados;
  }
  if (entradas.some((e) => e.isFile() && e.name === "chats_index.json")) return [raiz];
  for (const e of entradas) {
    if (!e.isDirectory()) continue;
    // pastas de apoio do proprio backup nao sao contas
    if (["messages", "media", "config", "automacao", ".importacao"].includes(e.name)) continue;
    achados.push(...acharBackups(path.join(raiz, e.name), nivel + 1));
  }
  return achados;
}

const backups = acharBackups(RAIZ).sort();
if (!backups.length) {
  console.error(`nenhum backup encontrado sob ${RAIZ} (procurei chats_index.json em ate ${PROFUNDIDADE} niveis)`);
  process.exit(2);
}

const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
const SAIDA = arg("saida", path.join(RAIZ, "_logs", `lote-dry-${carimbo}.md`));
fs.mkdirSync(path.dirname(SAIDA), { recursive: true });

const n = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("pt-BR"));
const hora = () => new Date().toTimeString().slice(0, 8);
console.log(`[${hora()}] LOTE EM SIMULACAO — ${backups.length} backup(s) sob ${RAIZ}`);

const linhas = [];
const total = {
  conversas_indice: 0,
  conversas: 0,
  entrada: 0,
  saida: 0,
  notas: 0,
  midia: 0,
  midia_bytes: 0,
  descartados: 0,
  ressalvas: 0,
  pendencias: 0,
  erros: 0,
  transmissao: 0,
  segundos: 0,
};
const somaObjetos = { por_status: {}, por_kind: {}, tipos: {}, referencias: {} };
const soma = (alvo, fonte) => {
  for (const [k, v] of Object.entries(fonte || {})) alvo[k] = (alvo[k] || 0) + (Number(v) || 0);
};

for (const pasta of backups) {
  const nome = path.relative(RAIZ, pasta).replace(/\\/g, "/") || path.basename(pasta);
  const trabalho = fs.mkdtempSync(path.join(os.tmpdir(), "lote-dry-"));
  const t0 = Date.now();
  let e = null;
  let erroExecucao = null;
  try {
    const argumentos = [path.join(AQUI, "chatguru.mjs"), "--pasta", pasta, "--dry", "--trabalho", trabalho];
    if (LIMITE) argumentos.push("--limite", String(LIMITE));
    execFileSync(process.execPath, argumentos, { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // exit 1 = rodou e achou erro de leitura; exit 2 = nem rodou. Nos dois casos
    // o relatorio pode existir, e e ele que interessa.
    erroExecucao = String(err?.status ?? err?.message ?? err);
  }
  try {
    const arq = fs.readdirSync(trabalho).find((f) => f.startsWith("relatorio-") && f.endsWith(".json"));
    if (arq) e = JSON.parse(fs.readFileSync(path.join(trabalho, arq), "utf8"));
  } catch {}
  const segundos = (Date.now() - t0) / 1000;

  if (!e) {
    linhas.push({ nome, falhou: erroExecucao || "sem relatorio", segundos });
    console.log(`[${hora()}] ${nome}: NAO MEDIDO (${erroExecucao || "sem relatorio"})`);
    fs.rmSync(trabalho, { recursive: true, force: true });
    continue;
  }

  const desc = e.descartados || {};
  const descartados =
    (desc.sem_data || 0) +
    (desc.apagadas || 0) +
    (desc.sem_conteudo || 0) +
    (desc.duplicadas_no_backup || 0) +
    Object.values(desc.tipo_ignorado || {}).reduce((a, v) => a + v, 0);
  const ressalvas = (e.referencias?.tabela || []).reduce((a, l) => a + (l.ressalvas || 0), 0);

  const l = {
    nome,
    conversas_indice: e.origem?.conversas_no_indice ?? 0,
    conversas: e.mapeado?.conversas ?? 0,
    entrada: e.mapeado?.mensagens_entrada ?? 0,
    saida: e.mapeado?.mensagens_saida ?? 0,
    notas: e.mapeado?.notas_internas ?? 0,
    midia: e.midia?.arquivos ?? 0,
    midia_bytes: e.midia?.bytes ?? 0,
    descartados,
    ressalvas,
    pendencias: (e.pendencias || []).length,
    erros: (e.erros || []).length,
    transmissao: desc.conversas_de_transmissao || 0,
    mais_antiga: e.datas?.mensagem_mais_antiga || null,
    mais_recente: e.datas?.mensagem_mais_recente || null,
    segundos,
  };
  linhas.push(l);

  total.conversas_indice += l.conversas_indice;
  total.conversas += l.conversas;
  total.entrada += l.entrada;
  total.saida += l.saida;
  total.notas += l.notas;
  total.midia += l.midia;
  total.midia_bytes += l.midia_bytes;
  total.descartados += l.descartados;
  total.ressalvas += l.ressalvas;
  total.pendencias += l.pendencias;
  total.erros += l.erros;
  total.transmissao += l.transmissao;
  total.segundos += segundos;

  soma(somaObjetos.por_status, e.conversas_origem?.por_status);
  soma(somaObjetos.por_kind, e.conversas_origem?.por_kind);
  soma(somaObjetos.tipos, e.destino?.por_tipo);
  for (const r of e.referencias?.tabela || []) {
    if (!somaObjetos.referencias[r.tipo])
      somaObjetos.referencias[r.tipo] = { total: 0, com_alvo: 0, resolvido: 0, ambiguo: 0, morto: 0, sem_alvo: 0 };
    const a = somaObjetos.referencias[r.tipo];
    a.total += r.total;
    a.com_alvo += r.com_alvo;
    a.sem_alvo += r.sem_alvo_na_origem;
    a.resolvido += r.por_id + r.por_nome + r.por_posicao;
    a.ambiguo += r.ambiguo;
    a.morto += r.morto;
  }

  console.log(
    `[${hora()}] ${nome}: ${n(l.conversas)} conversas · ${n(l.entrada + l.saida + l.notas)} itens · ` +
      `${n(l.midia)} midias · ${n(l.ressalvas)} ressalvas · ${segundos.toFixed(1)}s`
  );
  fs.rmSync(trabalho, { recursive: true, force: true });
}

// ─── RELATORIO CONSOLIDADO ───────────────────────────────────────────────────
const L = [];
L.push(`# Rodada em lote — SIMULACAO (--dry)`);
L.push("");
L.push(`- **Gerado em:** ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`);
L.push(`- **Raiz:** \`${RAIZ}\``);
L.push(`- **Backups medidos:** ${n(backups.length)}`);
L.push(`- **Tempo total de leitura:** ${(total.segundos / 60).toFixed(1)} min`);
L.push(`- **Nada foi gravado:** este script nao abre conexao com banco em nenhuma circunstancia.`);
L.push("");
L.push(`## Por conta`);
L.push("");
L.push(`| Conta | Conversas no indice | Conversas mapeadas | Recebidas | Enviadas | Anotacoes | Midias | Descartados | Ressalvas | Pendencias | Erros | s |`);
L.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
for (const l of linhas) {
  if (l.falhou) {
    L.push(`| ${l.nome} | — | — | — | — | — | — | — | — | — | **NAO MEDIDO** | ${l.segundos.toFixed(1)} |`);
    continue;
  }
  L.push(
    `| ${l.nome} | ${n(l.conversas_indice)} | ${n(l.conversas)} | ${n(l.entrada)} | ${n(l.saida)} | ` +
      `${n(l.notas)} | ${n(l.midia)} | ${n(l.descartados)} | ${n(l.ressalvas)} | ${n(l.pendencias)} | ${n(l.erros)} | ${l.segundos.toFixed(1)} |`
  );
}
L.push(
  `| **TOTAL** | **${n(total.conversas_indice)}** | **${n(total.conversas)}** | **${n(total.entrada)}** | ` +
    `**${n(total.saida)}** | **${n(total.notas)}** | **${n(total.midia)}** | **${n(total.descartados)}** | ` +
    `**${n(total.ressalvas)}** | **${n(total.pendencias)}** | **${n(total.erros)}** | **${total.segundos.toFixed(0)}** |`
);
L.push("");
L.push(
  `Midia: **${n(total.midia)} mensagem(ns) com arquivo**, ${(total.midia_bytes / 1e9).toFixed(1)} GB (10^9 bytes) somando o ` +
    `tamanho declarado POR MENSAGEM — o mesmo arquivo citado em varias mensagens conta varias vezes, entao ` +
    `este numero NAO e o tamanho do acervo. O total deduplicado por arquivo sai de ` +
    `\`scripts/importar/midia.mjs --dry\`, conta por conta. Listas de transmissao ignoradas: **${n(total.transmissao)}**.`
);
L.push("");
L.push(`## Status na origem (somado)`);
L.push("");
L.push(`| Status | Conversas |`);
L.push(`| --- | ---: |`);
for (const [s, q] of Object.entries(somaObjetos.por_status).sort((a, b) => b[1] - a[1])) L.push(`| ${s} | ${n(q)} |`);
L.push("");
L.push(`Tipos de conversa: ${Object.entries(somaObjetos.por_kind).map(([k, q]) => `${k} (${n(q)})`).join(" · ")}.`);
L.push("");
L.push(`## Tipos de mensagem importados (somado)`);
L.push("");
L.push(`| Tipo | Mensagens |`);
L.push(`| --- | ---: |`);
for (const [t, q] of Object.entries(somaObjetos.tipos).sort((a, b) => b[1] - a[1])) L.push(`| \`${t}\` | ${n(q)} |`);
L.push("");
L.push(`## Referencias (somado)`);
L.push("");
L.push(`| Referencia | Total | Sem alvo | Com alvo | Resolvido | Ambiguo | Morto | Taxa |`);
L.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
for (const [tipo, a] of Object.entries(somaObjetos.referencias).sort((x, y) => y[1].total - x[1].total)) {
  const taxa = a.com_alvo ? `${((a.resolvido * 100) / a.com_alvo).toFixed(1).replace(".", ",")}%` : "—";
  L.push(
    `| ${tipo} | ${n(a.total)} | ${n(a.sem_alvo)} | ${n(a.com_alvo)} | ${n(a.resolvido)} | ${n(a.ambiguo)} | ${n(a.morto)} | ${taxa} |`
  );
}
L.push("");
L.push(`---`);
L.push("");
L.push(
  `A carga de verdade e **uma conta por vez**, com a URL e a chave da instalacao DAQUELE cliente. ` +
    `Este lote existe pra medir antes, nunca pra gravar.`
);

fs.writeFileSync(SAIDA, L.join("\n") + "\n");
fs.writeFileSync(SAIDA.replace(/\.md$/, ".json"), JSON.stringify({ raiz: RAIZ, total, linhas, somaObjetos }, null, 2));

console.log(`\n[${hora()}] TOTAL: ${n(total.conversas)} conversas · ${n(total.entrada + total.saida + total.notas)} itens · ${n(total.midia)} midias`);
console.log(`[${hora()}] ${n(total.ressalvas)} ressalva(s) · ${n(total.pendencias)} pendencia(s) · ${n(total.erros)} erro(s) de leitura`);
console.log(`[${hora()}] relatorio: ${SAIDA}`);
process.exit(0);
