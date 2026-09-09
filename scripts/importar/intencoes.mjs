#!/usr/bin/env node
// Importador do CATALOGO DE INTENCOES (NLU) do ChatGuru para uma instalacao do
// Expert Chat. Mesmo padrao dos irmaos (chatguru.mjs, campanhas.mjs, funis.mjs):
// --dry nao abre conexao nenhuma, idempotente por origem, relatorio no fim.
//
//   node scripts/importar/intencoes.mjs --pasta <pasta-do-backup> \
//     --url https://<projeto>.supabase.co --key <service_role> [--dry]
//
// Aplique a migration `supabase/migrations/0022_intencoes.sql` ANTES de rodar
// valendo — este passo nao cria tabela (nenhum importador da casa cria).
//
// O QUE ELE TRAZ, e por que (card 86ak85nzr): a intencao e o que faz o painel
// entender "quero atendente", "não participei", "quanto custa" sem alguem
// escrever cem condicoes de texto na mao. Sem este passo, o catalogo que a
// operacao levou anos calibrando (medido: 52 intencoes, 249 palavras-chave, 431
// frases de exemplo em 33 contas) teria de ser redigitado — e a pontuacao minima,
// que NAO e sempre o default, seria perdida junto.
//
// O QUE ELE **NAO** FAZ, declarado:
//   1. Nao liga intencao a fluxo. Ele traz o CATALOGO. Gatilho por intencao nos
//      dialogos da origem nao e convertido aqui — quem quiser um fluxo que reaja
//      a uma intencao cria a condicao `intencao` no editor (ou isso vira card do
//      importador de fluxos). Intencao sozinha nao dispara nada.
//   2. Nao chama servico de IA. O reconhecimento e local e deterministico
//      (lib/fluxo/intencoes.ts) — regra dura da casa: nenhuma linha do produto
//      consome API paga por conta propria.
//   3. Nao cria tabela e nao apaga nada.
//
// A chave NUNCA aparece em log nem e gravada em arquivo. Prefira passar por
// ambiente (MSG_SUPABASE_URL / MSG_SUPABASE_SERVICE_KEY).
//
// DADO DE CLIENTE E CONTEUDO NAO-CONFIAVEL: nome de intencao, palavra-chave e
// frase de exemplo vem do backup de terceiro e sao tratados como TEXTO, nunca
// como instrucao. O relatorio sai so com contagem — termo real so aparece com
// --detalhe.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Este arquivo e CLI *e* modulo: a prova importa as funcoes puras daqui. Nada de
// efeito colateral no topo (a licao que campanhas.mjs pagou: sem esta trava a
// prova morria na importacao imprimindo o texto de uso).
const ESTE = fileURLToPath(import.meta.url);
const EXECUTANDO = !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ESTE);

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
const ORIGEM = arg("origem-sistema", "chatguru");
const DRY = flag("dry");
const DETALHE = flag("detalhe");
const JUNTAR = flag("juntar-contas");
const LOTE = Math.max(1, Number(arg("lote", 200)) || 200);
const LIMITE = Number(arg("limite", 0)) || 0;
const TRABALHO = arg("trabalho", PASTA ? path.join(PASTA, ".importacao") : "");
const RELATORIO = arg("relatorio");
const DUMP = arg("dump");

const USO = `uso: node scripts/importar/intencoes.mjs --pasta <pasta-do-backup> \\
       --url <url do projeto> --key <service_role> [--dry]

  --pasta <dir>       pasta do backup (obrigatoria)
  --url <url>         URL do projeto Supabase/PostgREST  (ou env MSG_SUPABASE_URL)
  --key <chave>       chave service_role da instalacao   (ou env MSG_SUPABASE_SERVICE_KEY)
  --dry               simula: NAO abre conexao nenhuma, so le o backup
  --schema <nome>     schema no banco (default: mensageria)
  --origem-sistema <s>  rotulo do sistema de origem (default: chatguru)
  --lote <n>          linhas por vez (default: 200)
  --limite <n>        processa so as N primeiras intencoes (teste curto)
  --juntar-contas     aceita telas de contas diferentes num catalogo unico (leia o aviso!)
  --detalhe           inclui nomes e termos no relatorio (DADO DE CLIENTE!)
  --dump <arquivo>    so com --dry: grava as linhas exatas que entrariam
  --relatorio <arq>   caminho do relatorio em Markdown`;

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
}

const hora = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(`[${hora()}]`, ...a);

// ─── ONDE MORA O DADO ────────────────────────────────────────────────────────
// A tela de intencoes de cada chatbot, capturada como HTML:
//   <conta>/automacao/bot_<botId>_intents.html
// (existe um `.json` ao lado, e ele NAO serve: e a tabela RENDERIZADA, o texto
// visivel vem cortado — medido: "Nao tenho nenhuma ex" no lugar de "...nenhuma
// experiencia" — e a pontuacao minima nem aparece, porque mora no `value` de um
// <input>. Ler o HTML pelos ATRIBUTOS e o que traz o dado inteiro.)
export function acharArquivosIntents(pasta) {
  const achados = [];
  const visitar = (dir, nivel) => {
    if (nivel > 5) return;
    let itens;
    try {
      itens = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of itens) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (it.name === "node_modules" || it.name.startsWith(".")) continue;
        visitar(p, nivel + 1);
      } else if (/_intents\.html$/i.test(it.name)) {
        achados.push(p);
      }
    }
  };
  visitar(pasta, 0);
  return achados.sort();
}

// ─── PARSER (PURO) ───────────────────────────────────────────────────────────
// Casar por ATRIBUTO NOMEADO, nunca por posicao: a tela da origem pode reordenar
// atributo (`data-keyword` antes ou depois de `data-intent-id`) sem mudar nada
// visualmente, e um regex que exige a ordem devolveria ZERO termo em silencio —
// a importacao "daria certo" com o catalogo vazio.
const RE_TAG_KEYWORD = /<i\b[^>]*\bkeyword_delete\b[^>]*>/gi;
const RE_TAG_EXAMPLE = /<i\b[^>]*\bexample_delete\b[^>]*>/gi;
const RE_TAG_MIN = /<input\b[^>]*\bintent_min_points\b[^>]*>/gi;
const RE_LINK_NOME = /<a\b[^>]*href="\/chatbot\/([a-f0-9]{6,})\/intent\/([a-f0-9]{6,})\/edit"[^>]*>([\s\S]*?)<\/a>/gi;

/** Le um atributo de uma tag crua. Aceita aspas dupla ou simples. */
export function atributo(tag, nome) {
  const re = new RegExp(`\\b${nome}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return m[2] !== undefined ? m[2] : m[3];
}

const ENTIDADES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#34": '"',
};

/** Desfaz entidade HTML no texto vindo dos atributos. */
export function texto(bruto) {
  return String(bruto ?? "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (todo, ent) => {
      const k = ent.toLowerCase();
      if (ENTIDADES[k] !== undefined) return ENTIDADES[k];
      if (k[0] === "#") {
        const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : todo;
      }
      return todo;
    })
    .replace(/\s+/g, " ")
    .trim();
}

const semTags = (s) => String(s ?? "").replace(/<[^>]*>/g, " ");

/**
 * Converte UMA tela de intencoes em intencoes cruas. PURO — a prova usa isto.
 *
 * A pontuacao minima sai do `value` do <input class="intent_min_points">. Se o
 * atributo nao existir (campo em branco na origem), fica `null` e o destino
 * aplica o default 2 — que e literalmente o `placeholder="Padrao: 2"` da tela.
 * Value ILEGIVEL (texto onde deveria haver numero) NAO cai no default em
 * silencio: vira pendencia no relatorio. Medido: 0 casos nos 54 backups, mas
 * cair no default de 2 numa intencao configurada com 100 a faria disparar com
 * uma palavra solta — o silencio e que e caro, nao o caso.
 */
export function converterTela(html, opcoes = {}) {
  const arquivo = opcoes.arquivo || null;
  const conta = opcoes.conta || null;
  const kwPorId = new Map();
  const exPorId = new Map();
  const minPorId = new Map();
  const minIlegivel = [];

  for (const [re, destino] of [
    [RE_TAG_KEYWORD, kwPorId],
    [RE_TAG_EXAMPLE, exPorId],
  ]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html))) {
      const id = atributo(m[0], "data-intent-id");
      const valor = texto(atributo(m[0], destino === kwPorId ? "data-keyword" : "data-example"));
      if (!id || !valor) continue;
      if (!destino.has(id)) destino.set(id, []);
      destino.get(id).push(valor);
    }
  }

  RE_TAG_MIN.lastIndex = 0;
  let m;
  while ((m = RE_TAG_MIN.exec(html))) {
    const id = atributo(m[0], "data-intent-id");
    if (!id) continue;
    const cru = atributo(m[0], "value");
    if (cru === null || String(cru).trim() === "") {
      minPorId.set(id, null); // campo em branco: o destino aplica o default
      continue;
    }
    const n = Number(String(cru).trim());
    if (!Number.isFinite(n) || n < 1 || n > 1000 || Math.round(n) !== n) {
      minPorId.set(id, null);
      minIlegivel.push({ intencao_id: id, valor_na_origem: String(cru).slice(0, 40) });
      continue;
    }
    minPorId.set(id, n);
  }

  const cruas = [];
  RE_LINK_NOME.lastIndex = 0;
  const vistos = new Set();
  while ((m = RE_LINK_NOME.exec(html))) {
    const [, bot_id, intencao_id, nomeCru] = m;
    if (vistos.has(intencao_id)) continue; // a tela repete o link em alguns temas
    vistos.add(intencao_id);
    const nome = texto(semTags(nomeCru));
    cruas.push({
      nome,
      bot_id,
      intencao_id,
      palavras_chave: kwPorId.get(intencao_id) || [],
      frases: exPorId.get(intencao_id) || [],
      pontuacao_minima: minPorId.has(intencao_id) ? minPorId.get(intencao_id) : null,
      arquivo,
      conta,
    });
  }

  return { cruas, minIlegivel };
}

// ─── CONSOLIDACAO (PURO) ─────────────────────────────────────────────────────
// Normaliza pra comparar nome e termo: sem caixa, sem acento, sem pontuacao.
// Marcas combinantes por ESCAPE, nunca cruas no fonte (combinante solto morre em
// copia/patch e a classe deixa de casar EM SILENCIO).
const RE_COMBINANTES = new RegExp("[\u0300-\u036f]", "g");
export const normalizar = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(RE_COMBINANTES, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export const PONTUACAO_MINIMA_PADRAO = 2;

/**
 * Junta as intencoes de TODAS as telas num catalogo unico da instalacao.
 *
 * O PROBLEMA REAL, medido: na origem a intencao pertence a UM chatbot, e aqui o
 * catalogo e da INSTALACAO (`uq_intencoes_nome on (lower(nome))`) — 8 nomes se
 * repetem dentro da mesma conta e **5 deles com pontuacao minima diferente**. Na
 * propria conta de quem escreveu isto: "atendente" com minimo 2 num bot e 20 no
 * outro; "participei" com 10 e 2.
 *
 * A regra, e ela e uma DECISAO declarada (nao ha resposta unica):
 *   - termos sao UNIDOS (uniao de palavras-chave e de frases): nenhum termo que a
 *     operacao escreveu e jogado fora;
 *   - a pontuacao minima que fica e a **mais ALTA**, ou seja a que dispara MENOS.
 *     Ficar com a mais baixa faria a intencao disparar em mensagem que a origem
 *     NAO fazia disparar — inventar disparo e pior que deixar de disparar, porque
 *     o disparo que falta aparece na primeira conversa e o que sobra some no meio
 *     de mil atendimentos.
 * Todo caso desses sai no relatorio como PENDENCIA, com os dois valores e os
 * bots, pra quem configurou ajustar na tela de Intencoes.
 */
export function consolidar(cruas, opcoes = {}) {
  const est = {
    origem: { telas: opcoes.telas || 0, intencoes: cruas.length },
    catalogo: { intencoes: 0, palavras_chave: 0, frases: 0 },
    por_minimo: {},
    descartadas: { sem_nome: 0, sem_termo: 0, sem_id: 0 },
    unidas: [],
    minimo_em_conflito: [],
    minimo_ilegivel: [],
    // Palavra-chave de UMA letra casa com quase toda mensagem (a origem da 10
    // pontos por palavra-chave achada). Medido na conta real: "o", "n" e "9" sao
    // palavras-chave de verdade no acervo — "n" e legitimo (e como gente escreve
    // "nao"), "o" faria a intencao disparar em praticamente tudo. Nao da pra
    // adivinhar qual e qual, entao a regra e: importar FIEL e RELATAR. Cortar por
    // conta propria apagaria o "n" que a operacao usa de verdade; nao contar
    // deixaria a intencao disparando em tudo com a culpa caindo no painel novo.
    palavras_de_uma_letra: [],
    detalhe: [],
  };

  const porNome = new Map();
  const cru = opcoes.limite ? cruas.slice(0, opcoes.limite) : cruas;

  for (const c of cru) {
    if (!c.nome) {
      est.descartadas.sem_nome++;
      continue;
    }
    if (!c.intencao_id) {
      // sem id da origem nao da pra ser idempotente: reimportar duplicaria
      est.descartadas.sem_id++;
      continue;
    }
    const palavras = dedupe(c.palavras_chave);
    const frases = dedupe(c.frases);
    if (!palavras.length && !frases.length) {
      // intencao vazia dos dois lados nao reconheceria nada e ficaria no catalogo
      // parecendo configurada (o `validarIntencao` da lib recusa igual)
      est.descartadas.sem_termo++;
      continue;
    }

    const chave = normalizar(c.nome);
    const existente = porNome.get(chave);
    if (!existente) {
      porNome.set(chave, {
        nome: c.nome,
        palavras_chave: palavras,
        frases,
        pontuacao_minima: c.pontuacao_minima,
        origem_id: c.intencao_id,
        origem_bot_id: c.bot_id,
        origens: [{ bot_id: c.bot_id, intencao_id: c.intencao_id, pontuacao_minima: c.pontuacao_minima }],
      });
      continue;
    }

    existente.palavras_chave = dedupe([...existente.palavras_chave, ...palavras]);
    existente.frases = dedupe([...existente.frases, ...frases]);
    existente.origens.push({
      bot_id: c.bot_id,
      intencao_id: c.intencao_id,
      pontuacao_minima: c.pontuacao_minima,
    });
    const antes = existente.pontuacao_minima ?? PONTUACAO_MINIMA_PADRAO;
    const agora = c.pontuacao_minima ?? PONTUACAO_MINIMA_PADRAO;
    // a que dispara MENOS ganha (ver o bloco de comentario da funcao)
    if (antes !== agora) existente.pontuacao_minima = Math.max(antes, agora);
  }

  // O conflito e UM por NOME, calculado no fim. Empilhar uma linha por FUSAO (o
  // que a primeira versao fazia) enche o relatorio de linhas quase iguais com a
  // lista de valores crescendo — medido no acervo real: 17 linhas de pendencia
  // para 6 nomes, uma delas listando "20, 2, 20, 20, 2, 20, 20, 2, 2, 2, 2, 2, 2,
  // 20, 2". Ilegivel e ninguem confere o que nao consegue ler.
  const linhas = [];
  for (const [chave, v] of porNome) {
    if (v.origens.length < 2) continue;
    const valores = v.origens.map((o) => o.pontuacao_minima ?? PONTUACAO_MINIMA_PADRAO);
    est.unidas.push({ nome_normalizado: chave, nome: v.nome, origens: v.origens.length });
    if (new Set(valores).size > 1) {
      est.minimo_em_conflito.push({
        nome_normalizado: chave,
        nome: v.nome,
        valores: [...new Set(valores)].sort((a, b) => a - b),
        escolhido: v.pontuacao_minima ?? PONTUACAO_MINIMA_PADRAO,
        bots: [...new Set(v.origens.map((o) => o.bot_id))],
      });
    }
  }

  for (const v of [...porNome.values()].sort((a, b) => a.nome.localeCompare(b.nome))) {
    const minimo = v.pontuacao_minima ?? PONTUACAO_MINIMA_PADRAO;
    est.catalogo.intencoes++;
    est.catalogo.palavras_chave += v.palavras_chave.length;
    est.catalogo.frases += v.frases.length;
    est.por_minimo[String(minimo)] = (est.por_minimo[String(minimo)] || 0) + 1;
    const curtas = v.palavras_chave.filter((t) => normalizar(t).length === 1);
    if (curtas.length) est.palavras_de_uma_letra.push({ nome: v.nome, termos: curtas, pontuacao_minima: minimo });
    if (opcoes.detalhe) {
      est.detalhe.push({
        nome: v.nome,
        pontuacao_minima: minimo,
        palavras_chave: v.palavras_chave,
        frases: v.frases,
      });
    }
    linhas.push({
      nome: v.nome,
      palavras_chave: v.palavras_chave,
      frases: v.frases,
      pontuacao_minima: minimo,
      // O catalogo importado entra ATIVO, e isso e seguro: intencao sozinha nao
      // dispara nada. Ela so passa a valer quando um fluxo tiver uma condicao
      // `intencao` que a cite — e o reconhecimento so roda quando alguma condicao
      // pede o campo (ver lib/fluxo/executar.ts).
      ativo: true,
      origem_ferramenta: opcoes.origem || "chatguru",
      origem_id: v.origem_id,
    });
  }

  return { linhas, estatisticas: est };
}

/**
 * Dedupe pela forma NORMALIZADA, preservando a escrita original da primeira.
 *
 * As MESMAS regras de `limpaTermos` em lib/fluxo/intencoes.ts — de proposito, e a
 * prova compara as duas. Se o importador fosse mais permissivo (aceitar numero,
 * nao cortar em 120, nao respeitar o teto), o termo entraria aqui e o
 * `validarIntencao` do destino o descartaria depois: termo perdido em SILENCIO,
 * com o relatorio da importacao jurando que ele entrou.
 */
export function dedupe(lista) {
  const vistos = new Set();
  const saida = [];
  for (const t of Array.isArray(lista) ? lista : []) {
    if (typeof t !== "string") continue;
    const limpo = t.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!limpo) continue;
    const chave = normalizar(limpo);
    if (!chave || vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(limpo);
    if (saida.length >= 300) break; // o mesmo teto de LIMITE_TERMOS_POR_INTENCAO
  }
  return saida;
}

// ─── EXECUCAO ────────────────────────────────────────────────────────────────
const contaDoArquivo = (pasta, arquivo) => {
  const rel = path.relative(pasta, arquivo).split(/[\\/]/);
  return rel[0] === "clientes" && rel[1] ? rel[1] : rel[0] || null;
};

async function principal() {
  const arquivos = acharArquivosIntents(PASTA);
  if (!arquivos.length) {
    console.error(
      `nao achei nenhuma tela de intencoes em "${PASTA}".\n` +
        `procurei por arquivos terminando em "_intents.html" (o padrao do backup: ` +
        `<conta>/automacao/bot_<id>_intents.html).`
    );
    process.exit(2);
  }
  log(`${arquivos.length} tela(s) de intencoes`);

  const cruas = [];
  const ilegiveis = [];
  const lidos = [];
  for (const a of arquivos) {
    let html;
    try {
      html = fs.readFileSync(a, "utf8");
    } catch (e) {
      console.error(`nao consegui ler ${a}: ${e.message}`);
      continue;
    }
    const r = converterTela(html, { arquivo: path.basename(a), conta: contaDoArquivo(PASTA, a) });
    cruas.push(...r.cruas);
    ilegiveis.push(...r.minIlegivel);
    lidos.push({ arquivo: path.basename(a), conta: contaDoArquivo(PASTA, a), intencoes: r.cruas.length });
  }

  // TRAVA QUE NASCEU DE UM SUSTO REAL: rodado por engano contra a pasta que
  // guarda o backup de VARIAS contas, o passo juntou 52 intencoes de 33 empresas
  // diferentes num catalogo unico de 19 — a palavra-chave de uma empresa passando
  // a valer na instalacao de outra. Nao e "so um numero errado no relatorio": e
  // dado de um cliente entrando no painel de outro.
  //
  // A pasta certa e a da SUA conta (a que tem `automacao/` dentro), e ai existe
  // uma unica conta e nada disto dispara. `--juntar-contas` e a saida explicita
  // pra quem de fato tem a propria conta espalhada em subpastas.
  const contas = [...new Set(lidos.map((l) => l.conta).filter(Boolean))].sort();
  if (contas.length > 1 && !JUNTAR) {
    console.error(
      `esta pasta tem tela de intencao de ${contas.length} contas diferentes:\n` +
        contas.map((c) => `  - ${c}`).join("\n") +
        `\n\nJuntar tudo criaria UM catalogo com as palavras-chave de todas elas — o termo de\n` +
        `uma empresa passaria a valer na instalacao de outra. Aponte --pasta para a pasta da\n` +
        `SUA conta (a que tem "automacao/" dentro), uma por vez.\n\n` +
        `Se estas subpastas sao todas da mesma conta, repita com --juntar-contas.`
    );
    process.exit(2);
  }

  const { linhas, estatisticas } = consolidar(cruas, {
    telas: arquivos.length,
    limite: LIMITE,
    detalhe: DETALHE,
    origem: ORIGEM,
  });
  estatisticas.minimo_ilegivel = ilegiveis;
  estatisticas.telas = lidos;
  estatisticas.contas = contas;

  log(`${estatisticas.catalogo.intencoes} intencao(oes) no catalogo consolidado`);

  if (DUMP && DRY) {
    fs.mkdirSync(path.dirname(path.resolve(DUMP)), { recursive: true });
    fs.writeFileSync(DUMP, JSON.stringify({ intencoes: linhas }, null, 2));
    log(`linhas gravadas em ${DUMP}`);
  }

  if (!DRY) {
    const cabecalhos = {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "Accept-Profile": SCHEMA,
      "Content-Profile": SCHEMA,
    };
    const alvo = `${URL_BASE}/rest/v1/intencoes?on_conflict=origem_ferramenta,origem_id`;
    const enviar = (corpo) =>
      fetch(alvo, {
        method: "POST",
        headers: { ...cabecalhos, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(corpo),
      });

    let gravadas = 0;
    const recusadas = [];
    for (let i = 0; i < linhas.length; i += LOTE) {
      const fatia = linhas.slice(i, i + LOTE);
      const r = await enviar(fatia);
      if (r.ok) {
        gravadas += fatia.length;
        log(`gravadas ${gravadas}/${linhas.length}`);
        continue;
      }
      const txt = await r.text();
      // 23505 = unique violation. `uq_intencoes_nome` e por NOME: se alguem ja
      // criou (ou renomeou) uma intencao com o mesmo nome na tela, o lote inteiro
      // e recusado pelo Postgres. Cair fora aqui perderia as outras 199 linhas
      // boas do lote, entao o lote e reenviado LINHA POR LINHA e cada recusa vira
      // pendencia com nome — nada e sobrescrito no chute.
      if (!/23505|duplicate key/i.test(txt)) {
        console.error(`HTTP ${r.status} ao gravar intencoes: ${txt.slice(0, 300)}`);
        process.exit(1);
      }
      log(`lote com nome repetido: reenviando ${fatia.length} linha(s) uma a uma`);
      for (const linha of fatia) {
        const r1 = await enviar([linha]);
        if (r1.ok) {
          gravadas++;
          continue;
        }
        const t1 = await r1.text();
        if (/23505|duplicate key/i.test(t1)) {
          recusadas.push({ nome: linha.nome, motivo: "ja existe uma intencao com este nome no painel" });
        } else {
          console.error(`HTTP ${r1.status} ao gravar "${linha.nome}": ${t1.slice(0, 200)}`);
          process.exit(1);
        }
      }
    }
    estatisticas.destino = { intencoes_gravadas: gravadas, recusadas };
  }

  // ─── RELATORIO ──────────────────────────────────────────────────────────
  const e = estatisticas;
  const L = [];
  L.push(`# Relatorio de importacao de intencoes`);
  L.push("");
  if (DRY) L.push(`> **SIMULACAO (--dry)** — nenhuma conexao foi aberta e nada foi gravado.`);
  L.push("");
  L.push(`| Item | Valor |`);
  L.push(`| --- | --- |`);
  L.push(`| Telas de intencao lidas | ${e.origem.telas} |`);
  L.push(`| Contas de origem | ${(e.contas || []).length || 1} |`);
  L.push(`| Intencoes encontradas na origem | ${e.origem.intencoes} |`);
  L.push(`| Intencoes no catalogo consolidado | ${e.catalogo.intencoes} |`);
  L.push(`| Palavras-chave | ${e.catalogo.palavras_chave} |`);
  L.push(`| Frases de exemplo | ${e.catalogo.frases} |`);
  if (e.destino) L.push(`| Gravadas no banco | ${e.destino.intencoes_gravadas} |`);
  L.push("");
  L.push(`## Pontuacao minima do catalogo`);
  L.push("");
  L.push(`Quanto a mensagem precisa somar pra intencao valer. A escala vem da propria`);
  L.push(`ferramenta de origem: **palavra-chave = 10**, **frase de exemplo igual = 100**,`);
  L.push(`**frase parecida = 2**. Campo em branco na origem = **${PONTUACAO_MINIMA_PADRAO}** (o padrao dela).`);
  L.push("");
  L.push(`| Pontuacao minima | Intencoes |`);
  L.push(`| --- | --- |`);
  for (const [k, v] of Object.entries(e.por_minimo).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    L.push(`| ${k} | ${v} |`);
  }
  L.push("");
  L.push(`## O que NAO entrou`);
  L.push("");
  L.push(`| Motivo | Intencoes |`);
  L.push(`| --- | --- |`);
  L.push(`| Sem nome | ${e.descartadas.sem_nome} |`);
  L.push(`| Sem palavra-chave E sem frase (nao reconheceria nada) | ${e.descartadas.sem_termo} |`);
  L.push(`| Sem identificador na origem (impediria reimportar sem duplicar) | ${e.descartadas.sem_id} |`);
  if (e.destino?.recusadas?.length) {
    L.push(`| Nome ja usado por uma intencao do painel | ${e.destino.recusadas.length} |`);
  }
  L.push("");

  const temPendencia =
    e.minimo_em_conflito.length ||
    e.minimo_ilegivel.length ||
    e.palavras_de_uma_letra?.length ||
    e.destino?.recusadas?.length;
  if (temPendencia) {
    L.push(`## Pendencias — precisam da sua decisao`);
    L.push("");
  }
  if (e.minimo_em_conflito.length) {
    L.push(`### Mesmo nome em bots diferentes, com pontuacao minima diferente`);
    L.push("");
    L.push(`No sistema antigo a intencao pertencia a UM chatbot; aqui o catalogo e da`);
    L.push(`instalacao inteira (um nome, uma intencao). Onde o mesmo nome aparecia em mais`);
    L.push(`de um bot, as palavras-chave e as frases foram **unidas** (nenhum termo seu foi`);
    L.push(`jogado fora) e ficou a pontuacao minima **mais alta** — a que dispara **menos**.`);
    L.push(`Isso e de proposito: e melhor deixar de disparar (voce ve na primeira conversa)`);
    L.push(`do que passar a disparar onde a origem nao disparava (isso some no meio de mil`);
    L.push(`atendimentos). Confira estas na tela **Intencoes** e ajuste se quiser:`);
    L.push("");
    L.push(`| Intencao | Valores na origem | Ficou com |`);
    L.push(`| --- | --- | --- |`);
    for (const c of e.minimo_em_conflito) {
      L.push(`| ${DETALHE ? c.nome : "(use --detalhe)"} | ${c.valores.join(", ")} | ${c.escolhido} |`);
    }
    L.push("");
  }
  if (e.palavras_de_uma_letra?.length) {
    L.push(`### Palavra-chave de uma letra so`);
    L.push("");
    L.push(`Uma palavra-chave de uma letra e encontrada em quase toda mensagem, e cada`);
    L.push(`palavra-chave encontrada vale 10 pontos — entao a intencao pode passar a valer`);
    L.push(`sempre. Elas foram importadas **como estavam** (algumas sao legitimas: "n" e como`);
    L.push(`gente escreve "nao"), mas vale conferir estas na tela **Intencoes**, sobretudo`);
    L.push(`quando a pontuacao minima for baixa:`);
    L.push("");
    L.push(`| Intencao | Pontuacao minima | Palavras de uma letra |`);
    L.push(`| --- | --- | --- |`);
    for (const c of e.palavras_de_uma_letra) {
      L.push(`| ${DETALHE ? c.nome : "(use --detalhe)"} | ${c.pontuacao_minima} | ${DETALHE ? c.termos.join(", ") : c.termos.length} |`);
    }
    L.push("");
  }
  if (e.minimo_ilegivel.length) {
    L.push(`### Pontuacao minima ilegivel na origem`);
    L.push("");
    L.push(`Estas vieram com um valor que nao e um numero de 1 a 1000 no campo de pontuacao.`);
    L.push(`Elas entraram com o padrao ${PONTUACAO_MINIMA_PADRAO}, **mas confira**: se a original era alta, ela vai`);
    L.push(`passar a disparar com uma palavra solta.`);
    L.push("");
    for (const c of e.minimo_ilegivel) L.push(`- intencao \`${c.intencao_id}\`: valor "${c.valor_na_origem}"`);
    L.push("");
  }
  if (e.destino?.recusadas?.length) {
    L.push(`### Nome ja usado no painel`);
    L.push("");
    L.push(`Nada foi sobrescrito. Renomeie no painel (ou na origem) e rode de novo:`);
    L.push("");
    for (const c of e.destino.recusadas) L.push(`- ${c.nome}`);
    L.push("");
  }

  L.push(`## Importante`);
  L.push("");
  L.push(`**Intencao sozinha nao dispara nada.** Ela e uma condicao disponivel: passa a`);
  L.push(`valer quando um fluxo tiver um passo de condicao com o campo **intencao**. Este`);
  L.push(`passo traz o CATALOGO — ligar intencao a fluxo continua sendo escolha de quem`);
  L.push(`configura, na tela de Fluxos.`);
  L.push("");
  L.push(`O reconhecimento e **local**: acontece dentro da sua instalacao, por palavra-chave`);
  L.push(`e frase de exemplo, sem mandar o texto das suas conversas para servico nenhum e`);
  L.push(`**sem custo por mensagem**.`);
  L.push("");
  L.push(`Rodar de novo e seguro: a intencao e reconhecida pelo identificador que ela tinha`);
  L.push(`na origem, entao a segunda execucao **atualiza** em vez de duplicar. Se voce`);
  L.push(`editou os termos no painel, rodar de novo devolve os termos da origem — e o que`);
  L.push(`"reimportar" significa.`);
  if (DETALHE && e.detalhe.length) {
    L.push("");
    L.push(`## Catalogo (--detalhe)`);
    L.push("");
    for (const d of e.detalhe) {
      L.push(`### ${d.nome} (minimo ${d.pontuacao_minima})`);
      L.push("");
      L.push(`- palavras-chave (${d.palavras_chave.length}): ${d.palavras_chave.join(" | ") || "(nenhuma)"}`);
      L.push(`- frases (${d.frases.length}): ${d.frases.join(" | ") || "(nenhuma)"}`);
      L.push("");
    }
  }

  const md = L.join("\n");
  const destino =
    RELATORIO || path.join(TRABALHO || path.join(PASTA, ".importacao"), `relatorio-intencoes-${Date.now()}.md`);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, md);
  fs.writeFileSync(destino.replace(/\.md$/, ".json"), JSON.stringify(estatisticas, null, 2));
  log(`relatorio: ${destino}`);
}

if (EXECUTANDO) {
  principal().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
