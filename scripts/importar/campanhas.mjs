#!/usr/bin/env node
// Importador de CAMPANHAS historicas do ChatGuru para uma instalacao do
// Expert Chat. Mesmo padrao da CLI de historico (scripts/importar/chatguru.mjs):
// --dry nao abre conexao nenhuma, idempotente por origem, relatorio no fim.
//
//   node scripts/importar/campanhas.mjs --pasta <pasta-do-backup> \
//     --url https://<projeto>.supabase.co --key <service_role> [--dry]
//
// O QUE ESTE IMPORTADOR TRAZ, e por que (card 86ak85bez): campanha do sistema
// antigo vira DADO, nunca funcionalidade. Sem o conceito, as conversas de
// transmissao ficam sem tipo, os webhooks externos que carregam id e nome de
// campanha passam a receber campo vazio, e os relatorios de origem de
// atendimento ficam errados sem ninguem perceber.
//
// GUARDRAIL, e nao e so promessa de codigo: toda campanha entra com
// `historico = true` e estado `concluida`/`cancelada`. O CHECK
// `campanhas_historico_nunca_dispara` da migration 0012 impede que uma linha
// historica exista em estado vivo — nem UPDATE manual no SQL Editor coloca ela
// pra rodar. E ela nunca ganha linha em `campanha_destinos`, entao nao ha fila
// pra motor nenhum consumir.
//
// A chave NUNCA aparece em log nem e gravada em arquivo. Prefira passar por
// ambiente (MSG_SUPABASE_URL / MSG_SUPABASE_SERVICE_KEY).
//
// DADO DE CLIENTE E CONTEUDO NAO-CONFIAVEL: nome de campanha e de dialogo vem do
// backup de terceiro e e tratado como TEXTO, nunca como instrucao. O relatorio
// sai so com contagem — nome de campanha real so aparece com --detalhe.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Este arquivo e CLI *e* modulo: a prova (prova-campanhas.mjs) importa as
// funcoes puras daqui. Por isso nada de efeito colateral no topo — validar
// argumento e sair com erro so pode acontecer quando ele e EXECUTADO.
// (a primeira versao nao tinha esta trava e a prova morria na importacao,
// imprimindo o texto de uso em vez de rodar os testes)
const ESTE = fileURLToPath(import.meta.url);
const EXECUTANDO = !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ESTE);

/** Encerra so quando rodando como CLI; importado, apenas segue. */
function sairSeCli(codigo, mensagem, paraStderr = true) {
  if (!EXECUTANDO) return;
  if (mensagem) (paraStderr ? console.error : console.log)(mensagem);
  process.exit(codigo);
}

// ─── ARGUMENTOS ──────────────────────────────────────────────────────────────
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const PASTA = arg("pasta");
const URL_BASE = arg("url", process.env.MSG_SUPABASE_URL || "");
const KEY = arg("key", process.env.MSG_SUPABASE_SERVICE_KEY || "");
const SCHEMA = arg("schema", "mensageria");
const CANAL = arg("canal", "central");
const DRY = flag("dry");
const DETALHE = flag("detalhe");
const LOTE = Math.max(1, Number(arg("lote", 200)) || 200);
const LIMITE = Number(arg("limite", 0)) || 0;
const TRABALHO = arg("trabalho", PASTA ? path.join(PASTA, ".importacao") : "");
const RELATORIO = arg("relatorio");
const DUMP = arg("dump");

const USO = `uso: node scripts/importar/campanhas.mjs --pasta <pasta-do-backup> \\
       --url <url do projeto> --key <service_role> [--dry]

  --pasta <dir>      pasta do backup (obrigatoria)
  --url <url>        URL do projeto Supabase/PostgREST   (ou env MSG_SUPABASE_URL)
  --key <chave>      chave service_role da instalacao    (ou env MSG_SUPABASE_SERVICE_KEY)
  --dry              simula: NAO abre conexao nenhuma, so le o backup
  --canal <id>       canal de destino das campanhas (default: central)
  --schema <nome>    schema no banco (default: mensageria)
  --lote <n>         linhas por vez (default: 200)
  --limite <n>       processa so as N primeiras campanhas (teste curto)
  --detalhe          inclui nomes de campanha no relatorio (dado de cliente!)
  --dump <arquivo>   so com --dry: grava as linhas exatas que entrariam
  --relatorio <arq>  caminho do relatorio em Markdown`;

if (EXECUTANDO) {
  if (!PASTA || flag("ajuda") || flag("help")) {
    console.log(USO);
    process.exit(PASTA ? 0 : 2);
  }
  if (!fs.existsSync(PASTA)) sairSeCli(2, `pasta nao encontrada: ${PASTA}`);
  if (!DRY && (!URL_BASE || !KEY)) {
    console.error("sem --dry e obrigatorio informar --url e --key (ou as envs equivalentes).\n");
    console.log(USO);
    process.exit(2);
  }
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(CANAL)) sairSeCli(2, `id de canal invalido: ${CANAL}`);
}

const hora = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(`[${hora()}]`, ...a);

// ─── LEITURA DO BACKUP ───────────────────────────────────────────────────────
// ONDE MORA: `config-dados/campanhas.json`, que e a captura da tela /campaigns
// do painel. O formato e uma TABELA renderizada:
//   { rota, capturado_em, tabelas: [{ cabecalho: [...], linhas: [{celulas, links}] }] }
// O cabecalho medido: CAMPANHA, STATUS, PROGRESSO, RECIPIENTES, DIALOGO,
// DATA INICIO, DATA CRIACAO (a 8a celula e a coluna de acoes, sempre vazia).
//
// Por que ler pelo CABECALHO e nao por posicao fixa: a tela do painel de origem
// pode ganhar coluna, e casar por indice cru transformaria "progresso" em
// "destinatarios" sem ninguem notar. Coluna que nao for encontrada vira null
// declarado no relatorio, nunca um valor errado.
export function acharCampanhasJson(pasta) {
  const candidatos = [
    path.join(pasta, "config-dados", "campanhas.json"),
    path.join(pasta, "campanhas.json"),
    path.join(pasta, "config", "campanhas.json"),
    path.join(pasta, "campaigns", "campanhas.json"),
    path.join(pasta, "campaigns.json"),
  ];
  return candidatos.find((c) => fs.existsSync(c)) || null;
}

const COLUNAS = {
  nome: ["campanha", "nome", "campaign", "name"],
  status: ["status", "situacao"],
  progresso: ["progresso", "progress"],
  destinatarios: ["recipientes", "destinatarios", "recipients", "contatos"],
  fluxo: ["dialogo", "dialog", "fluxo", "chatbot"],
  inicio: ["data inicio", "data de inicio", "inicio", "start"],
  criacao: ["data criacao", "data de criacao", "criacao", "created"],
};

const semAcento = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

export function mapearColunas(cabecalho) {
  const norm = (cabecalho || []).map(semAcento);
  const mapa = {};
  for (const [campo, nomes] of Object.entries(COLUNAS)) {
    mapa[campo] = norm.findIndex((c) => nomes.includes(c));
  }
  return mapa;
}

/** "24/08/2026 08:34" (BRT) -> ISO. Formato do painel de origem. */
export function dataBr(txt) {
  const m = String(txt || "").match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, d, mes, a, h = "00", min = "00", s = "00"] = m;
  // o painel de origem mostra horario de Brasilia (UTC-3)
  const iso = `${a}-${mes}-${d}T${h}:${min}:${s}.000-03:00`;
  const dt = new Date(iso);
  return isNaN(dt) ? null : dt.toISOString();
}

/** id da campanha e do dialogo saem dos LINKS da linha (/campaigns/<id>/view). */
export function idsDosLinks(links) {
  const arr = Array.isArray(links) ? links : [];
  const campanha = arr.map((l) => String(l).match(/\/campaigns\/([a-f0-9]{8,})\b/i)).find(Boolean);
  const dialogo = arr.map((l) => String(l).match(/\/dialog\/([a-f0-9]{8,})\b/i)).find(Boolean);
  return { origem_id: campanha ? campanha[1] : null, origem_fluxo_id: dialogo ? dialogo[1] : null };
}

// FINALIZADA/PAUSADA sao os dois estados medidos no acervo. Os dois viram estado
// TERMINAL: campanha importada nao volta a rodar, e "pausada" no sistema antigo
// nao pode virar "pausada" aqui — aqui pausada e um estado VIVO, que o tick
// aceita retomar. Registro historico nao tem estado vivo, ponto.
export function estadoDaOrigem(status) {
  const s = semAcento(status);
  if (s.includes("cancel")) return { estado: "cancelada", origem: s };
  // finalizada, pausada, e qualquer outra: registro concluido
  return { estado: "concluida", origem: s };
}

export function inteiro(txt) {
  const n = parseInt(String(txt ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

/** Converte a tabela crua em linhas prontas pro banco. PURO — a prova usa isto. */
export function converter(json, opcoes = {}) {
  const canal = opcoes.canal || "central";
  const tabela = json?.tabelas?.[0];
  const est = {
    origem: { arquivo: opcoes.arquivo || null, capturado_em: json?.capturado_em || null, linhas: 0 },
    // DUAS medidas diferentes de "tem fluxo", e confundi-las mente (medido no
    // acervo real em 31/08/2026): as 134 campanhas trazem o NOME do dialogo na
    // coluna, mas so 87 trazem o LINK com o id. Contar so o link faria o
    // relatorio dizer "47 sem fluxo" onde na verdade nenhuma esta sem fluxo —
    // o que falta em 47 delas e o identificador que torna a ligacao NAVEGAVEL.
    mapeado: {
      campanhas: 0,
      destinatarios_somados: 0,
      com_fluxo_nome: 0,
      com_fluxo_id: 0,
      sem_fluxo_id: 0,
    },
    por_status: {},
    descartados: { sem_nome: 0, sem_id: 0, duplicadas_no_backup: 0 },
    colunas_ausentes: [],
    nomes: [],
  };
  if (!tabela?.linhas?.length) {
    est.colunas_ausentes.push("tabela de campanhas nao encontrada no arquivo");
    return { linhas: [], estatisticas: est };
  }

  const mapa = mapearColunas(tabela.cabecalho);
  for (const [campo, idx] of Object.entries(mapa)) {
    if (idx < 0) est.colunas_ausentes.push(campo);
  }

  const linhas = [];
  const vistos = new Set();
  const cru = opcoes.limite ? tabela.linhas.slice(0, opcoes.limite) : tabela.linhas;
  est.origem.linhas = cru.length;

  for (const l of cru) {
    const c = l?.celulas || [];
    const pega = (campo) => (mapa[campo] >= 0 ? String(c[mapa[campo]] ?? "").trim() : "");

    const nome = pega("nome");
    if (!nome) {
      est.descartados.sem_nome++;
      continue;
    }
    const { origem_id, origem_fluxo_id } = idsDosLinks(l?.links);
    if (!origem_id) {
      // sem id da origem nao da pra ser idempotente: reimportar duplicaria
      est.descartados.sem_id++;
      continue;
    }
    if (vistos.has(origem_id)) {
      est.descartados.duplicadas_no_backup++;
      continue;
    }
    vistos.add(origem_id);

    const statusTxt = pega("status");
    const { estado } = estadoDaOrigem(statusTxt);
    const destinatarios = inteiro(pega("destinatarios"));

    est.por_status[semAcento(statusTxt) || "(vazio)"] =
      (est.por_status[semAcento(statusTxt) || "(vazio)"] || 0) + 1;
    est.mapeado.campanhas++;
    if (destinatarios) est.mapeado.destinatarios_somados += destinatarios;
    if (pega("fluxo")) est.mapeado.com_fluxo_nome++;
    if (origem_fluxo_id) est.mapeado.com_fluxo_id++;
    else est.mapeado.sem_fluxo_id++;
    if (opcoes.detalhe) est.nomes.push(nome);

    linhas.push({
      nome,
      canal,
      // registro historico nao tem corpo de mensagem: o texto vivia no dialogo,
      // que veio pelo importador de fluxos. Deixar vazio e honesto; inventar
      // texto aqui criaria mensagem que ninguem escreveu.
      mensagem: "",
      estado,
      historico: true,
      destinatarios_total: destinatarios,
      progresso_origem: pega("progresso") || null,
      origem_ferramenta: "chatguru",
      origem_id,
      origem_fluxo_id,
      // nome do dialogo como aparece na origem: e o que torna a ligacao
      // campanha -> fluxo legivel mesmo antes de os fluxos serem importados
      origem_fluxo_nome: pega("fluxo") || null,
      iniciada_em: dataBr(pega("inicio")),
      criada_em: dataBr(pega("criacao")) || undefined,
      concluida_em: dataBr(pega("inicio")),
    });
  }

  return { linhas, estatisticas: est };
}

// ─── EXECUCAO ────────────────────────────────────────────────────────────────
// (nao roda quando o arquivo e importado — a prova importa as funcoes puras)

async function principal() {
  const arquivo = acharCampanhasJson(PASTA);
  if (!arquivo) {
    console.error(
      `nao achei o arquivo de campanhas em "${PASTA}".\n` +
        `procurei por: config-dados/campanhas.json, campanhas.json, config/campanhas.json, campaigns/campanhas.json`
    );
    process.exit(2);
  }
  log(`lendo ${path.basename(arquivo)}`);

  let json;
  try {
    json = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  } catch (e) {
    console.error(`nao consegui ler ${arquivo}: ${e.message}`);
    process.exit(2);
  }

  const { linhas, estatisticas } = converter(json, {
    canal: CANAL,
    limite: LIMITE,
    detalhe: DETALHE,
    arquivo: path.basename(arquivo),
  });

  log(`${estatisticas.mapeado.campanhas} campanha(s) mapeada(s)`);

  if (DUMP && DRY) {
    fs.mkdirSync(path.dirname(path.resolve(DUMP)), { recursive: true });
    fs.writeFileSync(DUMP, JSON.stringify({ campanhas: linhas }, null, 2));
    log(`linhas gravadas em ${DUMP}`);
  }

  if (!DRY) {
    const cabecalhos = () => ({
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "Accept-Profile": SCHEMA,
      "Content-Profile": SCHEMA,
    });
    let gravadas = 0;
    for (let i = 0; i < linhas.length; i += LOTE) {
      const fatia = linhas.slice(i, i + LOTE);
      const r = await fetch(`${URL_BASE}/rest/v1/campanhas?on_conflict=origem_ferramenta,origem_id`, {
        method: "POST",
        headers: { ...cabecalhos(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(fatia),
      });
      if (!r.ok) {
        const txt = await r.text();
        console.error(`HTTP ${r.status} ao gravar campanhas: ${txt.slice(0, 300)}`);
        process.exit(1);
      }
      gravadas += fatia.length;
      log(`gravadas ${gravadas}/${linhas.length}`);
    }
    estatisticas.destino = { campanhas_gravadas: gravadas };
  }

  // ─── RELATORIO ──────────────────────────────────────────────────────────
  const L = [];
  L.push(`# Relatorio de importacao de campanhas`);
  L.push("");
  if (DRY) L.push(`> **SIMULACAO (--dry)** — nenhuma conexao foi aberta e nada foi gravado.`);
  L.push("");
  L.push(`| Item | Valor |`);
  L.push(`| --- | --- |`);
  L.push(`| Arquivo lido | ${estatisticas.origem.arquivo} |`);
  L.push(`| Capturado em | ${estatisticas.origem.capturado_em || "(nao informado)"} |`);
  L.push(`| Linhas na origem | ${estatisticas.origem.linhas} |`);
  L.push(`| Campanhas mapeadas | ${estatisticas.mapeado.campanhas} |`);
  L.push(`| Destinatarios somados | ${estatisticas.mapeado.destinatarios_somados} |`);
  L.push(`| Com nome do fluxo | ${estatisticas.mapeado.com_fluxo_nome} |`);
  L.push(`| Com id do fluxo (ligacao navegavel) | ${estatisticas.mapeado.com_fluxo_id} |`);
  L.push(`| Sem id do fluxo (nome preservado, ligacao nao navegavel) | ${estatisticas.mapeado.sem_fluxo_id} |`);
  if (estatisticas.destino) L.push(`| Gravadas no banco | ${estatisticas.destino.campanhas_gravadas} |`);
  L.push("");
  L.push(`## Status na origem`);
  L.push("");
  L.push(`| Status | Campanhas |`);
  L.push(`| --- | --- |`);
  for (const [k, v] of Object.entries(estatisticas.por_status)) L.push(`| ${k} | ${v} |`);
  L.push("");
  L.push(`## O que NAO entrou`);
  L.push("");
  L.push(`| Motivo | Linhas |`);
  L.push(`| --- | --- |`);
  L.push(`| Sem nome de campanha | ${estatisticas.descartados.sem_nome} |`);
  L.push(`| Sem identificador na origem (impediria reimportar sem duplicar) | ${estatisticas.descartados.sem_id} |`);
  L.push(`| Repetidas dentro do proprio backup | ${estatisticas.descartados.duplicadas_no_backup} |`);
  L.push("");
  if (estatisticas.colunas_ausentes.length) {
    L.push(`## Pendencias`);
    L.push("");
    L.push(`Colunas que nao foram encontradas no cabecalho da origem (entraram como vazio):`);
    L.push("");
    for (const c of estatisticas.colunas_ausentes) L.push(`- ${c}`);
    L.push("");
  }
  L.push(`## Importante`);
  L.push("");
  L.push(`Toda campanha importada e **registro historico**: entra com \`historico = true\` e em estado`);
  L.push(`terminal, nao ganha lista de destinos e **nao dispara mensagem em nenhuma condicao**. A trava`);
  L.push(`nao e so do importador — e um CHECK do banco (migration 0012).`);
  L.push("");
  L.push(`A ligacao campanha -> fluxo fica em \`origem_fluxo_id\`, que casa com \`fluxos.origem_id\``);
  L.push(`gravado pelo importador de fluxos. Importar os fluxos antes ou depois tanto faz: a ligacao`);
  L.push(`e resolvida na leitura, nao por chave estrangeira.`);
  if (estatisticas.mapeado.sem_fluxo_id) {
    L.push("");
    L.push(
      `Atencao: ${estatisticas.mapeado.sem_fluxo_id} campanha(s) trazem o NOME do fluxo mas nao o ` +
        `identificador dele (a origem so publica o link do dialogo em parte das linhas). O nome fica ` +
        `guardado e legivel; o que essas campanhas nao terao e o clique que leva ao fluxo.`
    );
  }
  if (DETALHE && estatisticas.nomes.length) {
    L.push("");
    L.push(`## Campanhas (--detalhe)`);
    L.push("");
    for (const n of estatisticas.nomes) L.push(`- ${n}`);
  }

  const md = L.join("\n");
  const destino =
    RELATORIO ||
    path.join(TRABALHO || path.join(PASTA, ".importacao"), `relatorio-campanhas-${Date.now()}.md`);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, md);
  fs.writeFileSync(destino.replace(/\.md$/, ".json"), JSON.stringify(estatisticas, null, 2));
  log(`relatorio: ${destino}`);
}

if (EXECUTANDO) {
  principal().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
