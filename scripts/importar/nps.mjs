#!/usr/bin/env node
// Importador de PESQUISAS DE SATISFACAO (NPS) historicas para uma instalacao
// do Expert Chat.
//
// Le um arquivo exportado da sua ferramenta antiga e grava as respostas em
// `mensageria.nps_pesquisas` / `mensageria.nps_respostas` (migration 0013).
// Nada aqui e especifico de uma empresa nem de uma ferramenta: o arquivo, a
// URL, a chave, o nome da pesquisa e o canal vem todos por argumento/env.
//
//   node scripts/importar/nps.mjs --arquivo <respostas.csv> --pesquisa "NPS" \
//     --url https://<projeto>.supabase.co --key <service_role> [--dry]
//
// Formatos aceitos (detectados pela extensao):
//   .csv   — a 1a linha e o cabecalho (separador , ou ; detectado sozinho)
//   .json  — array de objetos
//   .html  — a 1a <table> da pagina; a 1a linha vira cabecalho. Serve pra
//            quando a unica copia que sobrou e a TELA salva, e nao o export.
//
// O NPS entra como DADO HISTORICO, nao como funcionalidade: o painel nao envia
// pesquisa de NPS nem calcula regua — so guarda e mostra o que voce ja coletou.
// A pesquisa de satisfacao PROPRIA do painel (CSAT 1-5) e outra coisa e vive em
// `mensageria.avaliacoes`; as duas nunca se misturam num numero so.
//
// Idempotente: a resposta deduplica no BANCO por (origem, origem_id) — rodar de
// novo nunca duplica. Sem id na origem, o script deriva um id estavel do
// conteudo da propria linha.
//
// A chave NUNCA aparece em log. Prefira passar por ambiente
// (MSG_SUPABASE_URL / MSG_SUPABASE_SERVICE_KEY).
//
// PRIVACIDADE: o relatorio sai so com CONTAGEM. Resposta de pesquisa e dado de
// cliente — nao vira texto no terminal nem fixture do repo.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ─── ARGUMENTOS ──────────────────────────────────────────────────────────────
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const ARQUIVO = arg("arquivo");
const URL_BASE = arg("url", process.env.MSG_SUPABASE_URL || "");
const KEY = arg("key", process.env.MSG_SUPABASE_SERVICE_KEY || "");
const SCHEMA = arg("schema", "mensageria");
const CANAL = arg("canal", "central");
const PESQUISA = arg("pesquisa");
const ORIGEM = arg("origem", "importado");
const ORIGEM_ID = arg("origem-id");
const ESCALA_MAX = Math.max(1, Number(arg("escala-max", 10)) || 10);
const DRY = flag("dry");
const SEM_VINCULO = flag("sem-vinculo");
// nomes de coluna, quando o palpite automatico nao acertar
const COL = {
  nota: arg("col-nota"),
  comentario: arg("col-comentario"),
  data: arg("col-data"),
  chat: arg("col-chat"),
  pesquisa: arg("col-pesquisa"),
  id: arg("col-id"),
};

const USO = `uso: node scripts/importar/nps.mjs --arquivo <respostas.csv|json|html> \\
       --pesquisa "<nome da pesquisa>" --url <url> --key <service_role> [--dry]

  --arquivo <path>     export da ferramenta antiga (.csv, .json ou .html)
  --pesquisa <nome>    nome da pesquisa (se o arquivo nao tiver coluna propria)
  --url <url>          URL do projeto Supabase/PostgREST  (ou env MSG_SUPABASE_URL)
  --key <chave>        chave service_role da instalacao   (ou env MSG_SUPABASE_SERVICE_KEY)
  --dry                simula: NAO abre conexao nenhuma, so le e conta
  --origem <nome>      de qual ferramenta veio (default: importado)
  --origem-id <id>     id da pesquisa na ferramenta de origem (ajuda o dedupe)
  --canal <id>         canal pra vincular a conversa de origem (default: central)
  --escala-max <n>     maior nota possivel na origem (default: 10)
  --sem-vinculo        nao tenta ligar a resposta a uma conversa do painel
  --col-nota <nome>    nome da coluna da nota        (default: adivinha)
  --col-comentario <n> nome da coluna do comentario  (default: adivinha)
  --col-data <nome>    nome da coluna da data        (default: adivinha)
  --col-chat <nome>    coluna com telefone/chat      (default: adivinha)
  --col-pesquisa <n>   coluna com o nome da pesquisa (default: --pesquisa)
  --col-id <nome>      coluna com o id da resposta   (default: deriva do conteudo)`;

if (!ARQUIVO || flag("help") || flag("h")) {
  console.log(USO);
  process.exit(ARQUIVO ? 0 : 1);
}
if (!fs.existsSync(ARQUIVO)) {
  console.error(`arquivo nao encontrado: ${ARQUIVO}`);
  process.exit(1);
}
if (!DRY && (!URL_BASE || !KEY)) {
  console.error("faltou --url/--key (ou MSG_SUPABASE_URL/MSG_SUPABASE_SERVICE_KEY). Use --dry pra so conferir.");
  process.exit(1);
}

// ─── LEITURA ─────────────────────────────────────────────────────────────────
// CSV com aspas duplas, separador , ou ; detectado pela 1a linha.
function lerCsv(texto) {
  const sep = (texto.split("\n")[0].match(/;/g) || []).length > (texto.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  const linhas = [];
  let campo = "";
  let linha = [];
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') { aspas = true; continue; }
    if (c === sep) { linha.push(campo); campo = ""; continue; }
    if (c === "\n") { linha.push(campo); linhas.push(linha); linha = []; campo = ""; continue; }
    if (c !== "\r") campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  const cab = (linhas.shift() || []).map((h) => h.trim());
  return linhas
    .filter((l) => l.some((v) => String(v).trim()))
    .map((l) => Object.fromEntries(cab.map((h, i) => [h, (l[i] ?? "").trim()])));
}

// 1a <table> da pagina; 1a linha = cabecalho. Leitor generico de propósito:
// serve pra qualquer tela salva, nao pra um painel especifico.
function lerHtml(texto) {
  const tabela = texto.match(/<table[\s\S]*?<\/table>/i);
  if (!tabela) return [];
  const linhas = [...tabela[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) =>
    [...m[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) =>
      c[1]
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim()
    )
  );
  const cab = (linhas.shift() || []).map((h) => h.replace(/:$/, "").trim());
  return linhas.filter((l) => l.length && l.some(Boolean)).map((l) => Object.fromEntries(cab.map((h, i) => [h, l[i] ?? ""])));
}

const ext = path.extname(ARQUIVO).toLowerCase();
const cru = fs.readFileSync(ARQUIVO, "utf8");
let registros;
if (ext === ".json") {
  const j = JSON.parse(cru);
  registros = Array.isArray(j) ? j : Array.isArray(j.respostas) ? j.respostas : Array.isArray(j.data) ? j.data : [];
} else if (ext === ".html" || ext === ".htm") {
  registros = lerHtml(cru);
} else {
  registros = lerCsv(cru);
}
if (!registros.length) {
  console.error("nenhuma linha lida do arquivo (formato inesperado?).");
  process.exit(1);
}

// ─── MAPEAMENTO DE COLUNA ────────────────────────────────────────────────────
const chaves = Object.keys(registros[0]);
const semAcento = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// acha a 1a coluna cujo nome bate com um dos padroes, ignorando acento/caixa
function acha(explicito, padroes) {
  if (explicito) return chaves.includes(explicito) ? explicito : null;
  for (const p of padroes) {
    const k = chaves.find((c) => semAcento(c) === p || semAcento(c).startsWith(p));
    if (k) return k;
  }
  return null;
}
const kNota = acha(COL.nota, ["nota", "score", "rating", "avaliacao", "value", "valor"]);
const kComentario = acha(COL.comentario, ["comentario", "comment", "observacao", "feedback"]);
const kData = acha(COL.data, ["respondido em", "respondida", "respondido", "data", "criado em", "created"]);
const kChat = acha(COL.chat, ["telefone", "phone", "chat_id", "nome do chat", "chat", "contato", "whatsapp"]);
const kPesquisa = acha(COL.pesquisa, ["pesquisa", "survey", "metrica", "nps"]);
const kId = acha(COL.id, ["id", "_id", "resposta_id"]);

if (!kNota) {
  console.error(`nao achei a coluna da NOTA. Colunas do arquivo: ${chaves.join(", ")}`);
  console.error("passe --col-nota <nome>.");
  process.exit(1);
}
if (!kPesquisa && !PESQUISA) {
  console.error("o arquivo nao tem coluna de pesquisa: passe --pesquisa \"<nome>\".");
  process.exit(1);
}

// ─── NORMALIZACAO ────────────────────────────────────────────────────────────
// aceita ISO e o formato dd/mm/aa(aa) hh:mm que telas costumam exportar
function paraIso(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{2,4})(?:[ ,]+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (br) {
    const ano = br[3].length === 2 ? 2000 + Number(br[3]) : Number(br[3]);
    const d = new Date(Date.UTC(ano, Number(br[2]) - 1, Number(br[1]), Number(br[4] ?? 0), Number(br[5] ?? 0), Number(br[6] ?? 0)));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// so vira vinculo o que PARECE telefone: nome de contato nao e chat_id
function paraChatId(v) {
  const so = String(v ?? "").replace(/\D/g, "");
  return so.length >= 10 && so.length <= 15 ? so : null;
}

function idEstavel(r, nota, quando, pesquisa) {
  return crypto
    .createHash("sha1")
    .update([pesquisa, nota, quando ?? "", r[kChat] ?? "", r[kComentario] ?? ""].join("|"))
    .digest("hex")
    .slice(0, 32);
}

const porPesquisa = new Map();
let semNota = 0;
let foraDaEscala = 0;
let semData = 0;
let comVinculo = 0;

for (const r of registros) {
  const nomePesq = (kPesquisa ? String(r[kPesquisa] ?? "").trim() : "") || PESQUISA;
  if (!nomePesq) continue;
  const bruta = String(r[kNota] ?? "").trim().replace(",", ".");
  if (!bruta || /^(n\/d|nd|-|)$/i.test(bruta)) { semNota++; continue; }
  const nota = Math.round(Number(bruta));
  if (!Number.isFinite(nota) || nota < 0 || nota > ESCALA_MAX) { foraDaEscala++; continue; }
  const quando = kData ? paraIso(r[kData]) : null;
  if (kData && !quando) semData++;
  const chatId = !SEM_VINCULO && kChat ? paraChatId(r[kChat]) : null;
  if (chatId) comVinculo++;
  const comentario = kComentario ? String(r[kComentario] ?? "").trim() : "";

  if (!porPesquisa.has(nomePesq)) porPesquisa.set(nomePesq, []);
  porPesquisa.get(nomePesq).push({
    nota,
    comentario: comentario && !/^n\/d$/i.test(comentario) ? comentario : null,
    respondida_em: quando,
    canal: chatId ? CANAL : null,
    chat_id: chatId,
    origem: ORIGEM,
    origem_id: kId && r[kId] ? String(r[kId]) : idEstavel(r, nota, quando, nomePesq),
  });
}

// ─── RELATORIO (so contagem — resposta de pesquisa e dado de cliente) ────────
const totalValidas = [...porPesquisa.values()].reduce((a, l) => a + l.length, 0);
console.log(`arquivo: ${path.basename(ARQUIVO)} (${ext.slice(1) || "csv"}) — ${registros.length} linha(s) lida(s)`);
console.log(`colunas: nota=${kNota} comentario=${kComentario ?? "-"} data=${kData ?? "-"} chat=${kChat ?? "-"}`);
console.log(`respostas validas: ${totalValidas}${semNota ? ` | sem nota: ${semNota}` : ""}${foraDaEscala ? ` | fora da escala 0-${ESCALA_MAX}: ${foraDaEscala}` : ""}${semData ? ` | data ilegivel: ${semData}` : ""}`);
console.log(`vinculadas a uma conversa: ${comVinculo}`);
for (const [nome, lista] of porPesquisa) {
  const prom = lista.filter((r) => r.nota >= 9).length;
  const det = lista.filter((r) => r.nota <= 6).length;
  const score = lista.length ? Math.round(((prom - det) / lista.length) * 100) : null;
  console.log(`  - "${nome}": ${lista.length} resposta(s) | promotores ${prom} | detratores ${det} | NPS ${score}`);
}
if (!totalValidas) {
  console.log("\nnada a importar.");
  process.exit(0);
}
if (DRY) {
  console.log("\n--dry: nenhuma conexao foi aberta e nada foi gravado.");
  process.exit(0);
}

// ─── GRAVACAO ────────────────────────────────────────────────────────────────
const base = URL_BASE.replace(/\/+$/, "");
async function rest(caminho, opcoes = {}) {
  const r = await fetch(`${base}/rest/v1/${caminho}`, {
    ...opcoes,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "Accept-Profile": SCHEMA,
      "Content-Profile": SCHEMA,
      ...(opcoes.headers || {}),
    },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${caminho}: ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : null;
}

// `origem_id` e NOT NULL no banco de proposito: o indice de dedupe e TOTAL,
// porque o PostgREST recusa `on_conflict` sobre indice PARCIAL (42P10 — o
// mesmo gotcha que ja custou caro no dedupe de mensagem). Quando a origem nao
// da id proprio, derivamos um estavel do nome: legivel na frente, hash atras
// pra dois nomes diferentes nunca colidirem depois do corte.
function idDaPesquisa(nome) {
  if (porPesquisa.size === 1 && ORIGEM_ID) return ORIGEM_ID;
  const slug = String(nome)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const hash = crypto.createHash("sha1").update(nome).digest("hex").slice(0, 8);
  return `${slug || "pesquisa"}-${hash}`;
}

let gravadas = 0;
for (const [nome, lista] of porPesquisa) {
  // procura pela MESMA chave do indice unico (origem, origem_id) — procurar
  // pelo nome criaria uma pesquisa nova toda vez que alguem renomeasse
  const origemId = idDaPesquisa(nome);
  let pesquisaId = null;
  const achadas = await rest(
    `nps_pesquisas?select=id&origem=eq.${encodeURIComponent(ORIGEM)}&origem_id=eq.${encodeURIComponent(origemId)}&limit=1`
  );
  if (achadas?.length) pesquisaId = achadas[0].id;
  if (!pesquisaId) {
    const nova = await rest("nps_pesquisas", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{ origem: ORIGEM, origem_id: origemId, nome, ativa: false }]),
    });
    pesquisaId = nova?.[0]?.id;
  }
  if (!pesquisaId) throw new Error(`nao consegui criar/achar a pesquisa "${nome}"`);

  // respostas: o BANCO deduplica por (origem, origem_id) — rodar de novo nao duplica
  for (let i = 0; i < lista.length; i += 500) {
    const lote = lista.slice(i, i + 500).map((r) => ({ ...r, pesquisa_id: pesquisaId }));
    const entrou = await rest("nps_respostas?on_conflict=origem,origem_id", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify(lote),
    });
    gravadas += entrou?.length ?? 0;
  }
}

console.log(`\nOK — ${gravadas} resposta(s) NOVA(s) gravada(s) (as repetidas o banco ignorou).`);
console.log("Confira em GET /api/relatorios/nps do seu painel.");
