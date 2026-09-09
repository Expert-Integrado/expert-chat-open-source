#!/usr/bin/env node
// Importar a CONFIGURACAO que sobrou: respostas rapidas e biblioteca de anexos.
//
//   node scripts/importar/config-restante.mjs --pasta <backup> --dry
//   node scripts/importar/config-restante.mjs --pasta <backup> --url ... --key ...
//
// O que ja entrou por outros passos, e por isso NAO se repete aqui:
//   - etiquetas (catalogo + a marcacao de cada conversa) .... chatguru.mjs
//   - usuarios/autoria historica ............................ chatguru.mjs (mapa de nomes em config)
//   - funis e etapas, e a etapa de cada conversa ............ funis.mjs (2o passo)
//   - fluxos/dialogos do chatbot ............................ scripts/fluxo/converter-chatguru.mjs
//   - campanhas historicas ................................. campanhas.mjs
//   - pesquisas de NPS ..................................... nps.mjs
//
// O que ESTE passo traz:
//   - RESPOSTAS RAPIDAS. Elas nao vem em JSON no backup: a unica copia e a TELA
//     salva (`tela_quick_answers.html` / `screen_quick_answers.html`), onde atalho
//     e texto estao nos atributos do formulario. Sao lidas dali e entram em
//     `mensageria.respostas_rapidas` como respostas GLOBAIS (dono_id null), que e
//     o equivalente certo: no ChatGuru elas sao da conta, nao de uma pessoa.
//   - BIBLIOTECA DE ANEXOS. Aqui ela e MEDIDA (quantos, que tipos, quanto pesa) e
//     o inventario e gravado num arquivo. ATUALIZADO EM 31/08/2026 (Frente W): o
//     painel PASSOU A TER biblioteca de anexos (migration 0024, tela /biblioteca,
//     acao de fluxo `anexar_biblioteca`), e quem IMPORTA o acervo — re-hospedando
//     o arquivo e reescrevendo o endereco — e `scripts/importar/anexos.mjs`. Este
//     passo continua sendo o INVENTARIO (o numero na mesa), nao a importacao.
//     ATENCAO: a tela de anexos e PAGINADA e o backup guardou uma pagina. O tamanho
//     que vale e `total_results` do proprio JSON, nunca `attachments.length` —
//     medido nos 33 backups: 795 itens capturados contra 3.287 declarados, com 11
//     contas cortadas. Inventario incompleto entra rotulado como PARCIAL.
//
// Idempotencia: (origem_ferramenta, origem_id) na resposta rapida — exige a
// migration `supabase/migrations/0020_respostas_rapidas_origem.sql` aplicada.
// Sem ela o script PARA antes de gravar, em vez de duplicar as respostas.

import fs from "node:fs";
import path from "node:path";

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
const TRABALHO = arg("trabalho", PASTA ? path.join(PASTA, ".importacao") : "");
const DUMP = arg("dump");

if (!PASTA || flag("help") || flag("ajuda")) {
  console.log(`uso: node scripts/importar/config-restante.mjs --pasta <backup> [--dry]

  --pasta <dir>          pasta do backup (obrigatoria)
  --dry                  simula: NAO abre conexao e nao grava nada
  --url <url> --key <k>  projeto da instalacao (ou envs MSG_SUPABASE_URL / MSG_SUPABASE_SERVICE_KEY)
  --schema <nome>        schema no banco (default: mensageria)
  --origem-sistema <s>   rotulo gravado em origem_ferramenta (default: chatguru)
  --trabalho <dir>       onde ficam inventario e relatorio (default: <pasta>/.importacao)
  --dump <arq>           so com --dry: grava as linhas que seriam inseridas`);
  process.exit(PASTA ? 0 : 2);
}
if (!fs.existsSync(PASTA)) {
  console.error(`pasta nao encontrada: ${PASTA}`);
  process.exit(2);
}
if (!DRY && (!URL_BASE || !KEY)) {
  console.error("sem --dry e obrigatorio informar --url e --key (ou as envs equivalentes).");
  process.exit(2);
}

const hora = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(`[${hora()}]`, ...a);
const lerJson = (p, padrao = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return padrao;
  }
};
const achar = (nomes) => {
  for (const nome of nomes) {
    for (const p of [path.join(PASTA, "config", nome), path.join(PASTA, nome)]) {
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
};

fs.mkdirSync(TRABALHO, { recursive: true });

// ─── RESPOSTAS RAPIDAS: ler da TELA SALVA ────────────────────────────────────
// A entidade nao aparece em nenhum JSON do backup. Na tela, cada resposta e um
// par de campos que compartilham o mesmo `data-quick-id`:
//   <input ... data-quick-id="ID" value="ATALHO" class="... quick_shortcut">
//   <textarea class="... quick_text" data-quick-id="ID">TEXTO</textarea>
const ENTIDADES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
const decodificar = (s) =>
  String(s ?? "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e) => ENTIDADES[e] ?? _)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

function lerRespostasRapidas(html) {
  const porId = new Map();
  const reAtalho = /<input[^>]*\bdata-quick-id="([^"]+)"[^>]*\bvalue="([^"]*)"[^>]*\bclass="[^"]*quick_shortcut[^"]*"[^>]*>/gi;
  for (const m of html.matchAll(reAtalho)) {
    const [, id, atalho] = m;
    if (!porId.has(id)) porId.set(id, { id, atalho: decodificar(atalho), texto: null });
    else porId.get(id).atalho = decodificar(atalho);
  }
  const reTexto = /<textarea[^>]*\bclass="[^"]*quick_text[^"]*"[^>]*\bdata-quick-id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/gi;
  for (const m of html.matchAll(reTexto)) {
    const [, id, texto] = m;
    if (!porId.has(id)) porId.set(id, { id, atalho: null, texto: decodificar(texto) });
    else porId.get(id).texto = decodificar(texto);
  }
  return [...porId.values()];
}

// O painel valida o atalho como ^[a-z0-9_-]{1,30}$ (app/api/respostas-rapidas).
// O ChatGuru aceita acento, maiuscula, espaco e barra. Normalizar e obrigatorio,
// e a normalizacao pode COLIDIR — duas respostas viram o mesmo atalho. Colisao
// NAO e resolvida no chute: a primeira fica, as outras viram ressalva com o
// atalho original preservado no relatorio, pra decisao humana.
// A classe de marcas combinantes vai por ESCAPE, nunca por caractere cru no
// fonte: combinante solto no arquivo desaparece em copia/patch/heredoc e a
// classe passa a nao casar com nada EM SILENCIO (o atalho com acento deixaria
// de ser normalizado e a rota do painel recusaria a linha).
const RE_COMBINANTES = new RegExp("[\\u0300-\\u036f]", "g");
function normalizarAtalho(bruto) {
  const base = String(bruto ?? "")
    .normalize("NFD")
    .replace(RE_COMBINANTES, "")
    .toLowerCase()
    .replace(/^\//, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return base;
}

// Variavel do ChatGuru e chave-unica ({Nome}, {PRIMEIRO_NOME_LEAD}). Ela e
// GRAVADA como esta — quem resolve e a LEITURA, na hora em que o atendente usa o
// atalho (lib/fluxo/variaveis.ts, frente T): o formato antigo so e interpretado
// em resposta com origem de importacao, e o que nao resolve fica literal na tela
// pra alguem consertar. Contar aqui continua valendo: e o numero que diz quanto
// texto da conta antiga depende disso. (O disparo em massa tem sintaxe propria e
// anterior, {{nome}} — nao foi unificada, ver docs/variaveis.md.)
const RE_VARIAVEL = /\{[A-Za-z_][A-Za-z0-9_ ]{0,40}\}/g;

// ─── RELATORIO ───────────────────────────────────────────────────────────────
const rel = {
  gerado_em: new Date().toISOString(),
  pasta: PASTA,
  schema: SCHEMA,
  modo: DRY ? "dry" : "gravacao",
  destino_host: URL_BASE ? (() => { try { return new URL(URL_BASE).host; } catch { return "(url invalida)"; } })() : null,
  respostas_rapidas: {
    encontradas: 0,
    prontas: 0,
    sem_texto: 0,
    sem_atalho: 0,
    atalhos_normalizados: 0,
    colisoes: [], // colisao ENTRE as respostas do backup, depois de normalizar
    colisoes_no_destino: [], // atalho que JA existe na instalacao com outra origem

    com_variavel: 0,
    variaveis_distintas: [],
    acima_do_limite_da_tela: 0,
    gravadas: null,
  },
  anexos: {
    encontrados: 0, // o que o arquivo do backup TEM (a fatia capturada)
    total_na_origem: null, // o que a origem DIZ que existe (total_results)
    paginas_na_origem: null,
    pagina_capturada: null,
    parcial: false,
    bytes: 0,
    por_mime: {},
    com_etiqueta: 0,
    inventario_em: null,
  },
  ja_importado_por_outro_passo: {},
  pendencias: [],
  erros: [],
};
const pend = (tema, detalhe) => rel.pendencias.push({ tema, detalhe });

// ─── LEITURA ─────────────────────────────────────────────────────────────────
log(`=== CONFIGURACAO RESTANTE${DRY ? "  [DRY RUN]" : ""}`);
log(`origem: ${PASTA}`);

const arqQuick = achar(["tela_quick_answers.html", "screen_quick_answers.html"]);
let linhasRespostas = [];
if (!arqQuick) {
  pend(
    "respostas rapidas",
    "o backup nao tem a tela de respostas rapidas (tela_quick_answers.html / screen_quick_answers.html). " +
      "Nada a importar aqui; se a conta tinha respostas rapidas, elas nao foram capturadas."
  );
} else {
  const html = fs.readFileSync(arqQuick, "utf8");
  const brutas = lerRespostasRapidas(html);
  rel.respostas_rapidas.encontradas = brutas.length;

  const usados = new Map(); // atalho normalizado -> id que ficou com ele
  const variaveis = new Set();
  for (const r of brutas) {
    const texto = String(r.texto ?? "").trim();
    if (!texto) {
      rel.respostas_rapidas.sem_texto++;
      continue;
    }
    const atalhoBruto = String(r.atalho ?? "").trim();
    const atalho = normalizarAtalho(atalhoBruto);
    if (!atalho) {
      rel.respostas_rapidas.sem_atalho++;
      continue;
    }
    if (atalho !== atalhoBruto.replace(/^\//, "")) rel.respostas_rapidas.atalhos_normalizados++;
    if (usados.has(atalho)) {
      rel.respostas_rapidas.colisoes.push({ atalho, original: atalhoBruto, ficou_com: usados.get(atalho) });
      continue;
    }
    usados.set(atalho, r.id);

    const achadas = texto.match(RE_VARIAVEL) || [];
    if (achadas.length) {
      rel.respostas_rapidas.com_variavel++;
      for (const v of achadas) variaveis.add(v);
    }
    if (texto.length > 2000) rel.respostas_rapidas.acima_do_limite_da_tela++;

    linhasRespostas.push({
      atalho,
      texto,
      // GLOBAL: no ChatGuru a resposta rapida e da conta, nao de uma pessoa.
      // dono_id null e exatamente isso no painel (e so admin gerencia).
      dono_id: null,
      origem_ferramenta: ORIGEM,
      origem_id: String(r.id),
    });
  }
  rel.respostas_rapidas.prontas = linhasRespostas.length;
  rel.respostas_rapidas.variaveis_distintas = [...variaveis].sort();

  log(`respostas rapidas: ${rel.respostas_rapidas.encontradas} na tela, ${rel.respostas_rapidas.prontas} prontas`);

  if (rel.respostas_rapidas.colisoes.length)
    pend(
      "respostas rapidas",
      `${rel.respostas_rapidas.colisoes.length} atalho(s) colidiram depois da normalizacao (o painel aceita so ` +
        `minusculas, digitos, - e _, ate 30 caracteres). A PRIMEIRA fica; as outras NAO entram, e o atalho ` +
        `original de cada uma esta no json deste relatorio pra decisao humana — renomear no painel e um clique, ` +
        `sobrescrever no chute perderia texto.`
    );
  if (rel.respostas_rapidas.com_variavel)
    pend(
      "respostas rapidas",
      `${rel.respostas_rapidas.com_variavel} resposta(s) usam variavel do sistema antigo ` +
        `(${rel.respostas_rapidas.variaveis_distintas.slice(0, 8).join(", ")}${
          rel.respostas_rapidas.variaveis_distintas.length > 8 ? ", ..." : ""
        }). O texto entra COMO ESTA (a chave crua fica gravada) e quem substitui e a LEITURA: desde a frente T ` +
        `(card 86ak86jw9) o painel resolve variavel de resposta rapida no momento em que o atendente usa o ` +
        `atalho, e o formato antigo e tratado justamente nas respostas com origem de importacao — ` +
        `PRIMEIRO_NOME_LEAD, NOME_LEAD, TELEFONE_LEAD e DAY_GREETING viram propriedade daqui, e as outras sao ` +
        `procuradas como campo da ficha (docs/variaveis.md). O que nao resolver fica LITERAL na tela de ` +
        `proposito: o atendente ve o resto da migracao e conserta o texto. Nada sai sem alguem olhar — a ` +
        `resposta cai no rascunho, nunca no envio.`
    );
  if (rel.respostas_rapidas.acima_do_limite_da_tela)
    pend(
      "respostas rapidas",
      `${rel.respostas_rapidas.acima_do_limite_da_tela} resposta(s) tem mais de 2.000 caracteres. Entram ` +
        `INTEIRAS (a coluna e text, sem limite), mas o formulario do painel recusa salvar acima disso: editar ` +
        `essas pela tela vai exigir encurtar.`
    );
  if (rel.respostas_rapidas.sem_texto || rel.respostas_rapidas.sem_atalho)
    pend(
      "respostas rapidas",
      `${rel.respostas_rapidas.sem_texto} sem texto e ${rel.respostas_rapidas.sem_atalho} sem atalho utilizavel ` +
        `nao entraram (nao ha o que gravar).`
    );
}

// ─── BIBLIOTECA DE ANEXOS ────────────────────────────────────────────────────
const arqAnexos = achar(["attachments_search.json", "xhr_GET__attachments_search.json"]);
if (!arqAnexos) {
  pend("anexos", "o backup nao tem attachments_search.json — a biblioteca de anexos nao foi capturada.");
} else {
  const j = lerJson(arqAnexos, {});
  const lista = Array.isArray(j) ? j : j.attachments || [];
  // A TELA DE ANEXOS E PAGINADA, e o backup capturou UMA pagina. O JSON diz isso
  // na cara — `total_results` e `total_pages` — e ignorar esses dois campos fazia
  // o relatorio publicar a FATIA como se fosse o acervo (medido nos 33 backups:
  // 795 capturados contra 3.287 que a origem declara; 11 contas cortadas). Numero
  // errado num inventario e pior que numero ausente: a decisao de produto sobre
  // construir a biblioteca de anexos seria tomada em cima de 1/4 do tamanho real.
  const totalOrigem = Number(Array.isArray(j) ? NaN : j.total_results);
  rel.anexos.total_na_origem = Number.isFinite(totalOrigem) ? totalOrigem : null;
  rel.anexos.paginas_na_origem = Number.isFinite(Number(j?.total_pages)) ? Number(j.total_pages) : null;
  rel.anexos.pagina_capturada = Number.isFinite(Number(j?.current_page)) ? Number(j.current_page) : null;
  const inventario = [];
  for (const a of lista) {
    rel.anexos.encontrados++;
    rel.anexos.bytes += Number(a?.size) > 0 ? Number(a.size) : 0;
    const mime = String(a?.mime || "(sem mime)");
    rel.anexos.por_mime[mime] = (rel.anexos.por_mime[mime] || 0) + 1;
    if ((a?.tags || []).length) rel.anexos.com_etiqueta++;
    const rel_ = a?.path_relative ? String(a.path_relative).replace(/\/$/, "") : null;
    inventario.push({
      origem_id: a?._id?.$oid || a?._id || null,
      nome: a?.original_name || a?.name || null,
      arquivo: a?.name || null,
      mime: a?.mime || null,
      bytes: Number(a?.size) || null,
      etiquetas: a?.tags || [],
      criado_em: a?.created?.$date || a?.created || null,
      url: rel_ && a?.name ? `${rel_}/${a.name}` : null,
      // a descricao e o TEXTO que acompanhava o envio do anexo: e conteudo, e
      // some junto se ninguem levar
      tem_descricao: !!String(a?.description || "").trim(),
    });
  }
  // PARCIAL = o arquivo tem menos itens do que a origem declara. O tamanho REAL
  // que vale pra decisao e `total_na_origem`; `encontrados` passa a ser o que foi
  // INVENTARIADO, e os dois viajam separados justamente pra ninguem somar a fatia
  // achando que somou o acervo.
  rel.anexos.parcial =
    rel.anexos.total_na_origem !== null && rel.anexos.encontrados < rel.anexos.total_na_origem;
  const tamanhoReal = rel.anexos.total_na_origem ?? rel.anexos.encontrados;

  const arqInv = path.join(TRABALHO, "anexos-biblioteca.json");
  fs.writeFileSync(
    arqInv,
    JSON.stringify(
      {
        gerado_em: rel.gerado_em,
        parcial: rel.anexos.parcial,
        total_na_origem: rel.anexos.total_na_origem,
        paginas_na_origem: rel.anexos.paginas_na_origem,
        pagina_capturada: rel.anexos.pagina_capturada,
        inventariados: inventario.length,
        anexos: inventario,
      },
      null,
      2
    )
  );
  rel.anexos.inventario_em = arqInv;
  log(
    `biblioteca de anexos: ${rel.anexos.encontrados} inventariado(s)` +
      (rel.anexos.parcial ? ` de ${tamanhoReal} que a origem declara (INVENTARIO PARCIAL)` : "") +
      `, inventario em ${arqInv}`
  );

  if (tamanhoReal)
    pend(
      "anexos",
      `**${tamanhoReal} anexo(s) de biblioteca na origem** (o que a tela declara em \`total_results\`), dos quais ` +
        `${rel.anexos.encontrados} estao inventariados aqui — ${(rel.anexos.bytes / 1e6).toFixed(1)} MB somados ` +
        `SO nos inventariados, ${rel.anexos.com_etiqueta} com etiqueta. O painel TEM biblioteca de anexos desde ` +
        `31/08/2026 (tabela \`mensageria.anexos\`, tela /biblioteca e a acao de fluxo \`anexar_biblioteca\`), e ` +
        `quem importa o acervo e **scripts/importar/anexos.mjs** — ele re-hospeda o arquivo e grava o endereco NOVO, ` +
        `porque o endereco do fornecedor morre com a conta. Nada e inventado aqui: o inventario (nome, mime, ` +
        `tamanho, etiquetas, data e endereco) fica em ${arqInv}. Rodar o passo de anexos ANTES da conversao dos ` +
        `fluxos: e o mapa dele que faz a acao ANEXAR dos dialogos virar passo em vez de ressalva.`
    );
  if (rel.anexos.parcial)
    pend(
      "anexos (captura incompleta)",
      `o export capturou SO a pagina ${rel.anexos.pagina_capturada ?? "1"} de ` +
        `${rel.anexos.paginas_na_origem ?? "?"} da tela de anexos: ${rel.anexos.encontrados} de ` +
        `${rel.anexos.total_na_origem} itens. Os ${rel.anexos.total_na_origem - rel.anexos.encontrados} restantes ` +
        `NAO estao no backup — nao ha o que inventariar deles aqui. Pra fechar o inventario e preciso voltar na ` +
        `origem (enquanto houver acesso) e capturar as paginas seguintes de \`/attachments/search\`; o tamanho que ` +
        `vale pra decisao de produto e ${rel.anexos.total_na_origem}, nao ${rel.anexos.encontrados}.`
    );
}

// ─── VERIFY: o que outro passo ja trouxe ─────────────────────────────────────
// Existe pra que ninguem importe duas vezes por achar que "faltou".
const tags = lerJson(achar(["chatlist_tags.json"]), []) || [];
const funis = lerJson(achar(["chatlist_funnels.json"]), []) || [];
const ug = lerJson(achar(["users_and_groups.json"]), {}) || {};
rel.ja_importado_por_outro_passo = {
  etiquetas_no_catalogo: Array.isArray(tags) ? tags.length : 0,
  funis: Array.isArray(funis) ? funis.length : 0,
  etapas_de_funil: (Array.isArray(funis) ? funis : []).reduce((a, f) => a + (f.steps || []).length, 0),
  usuarios: (ug.users || []).length,
  departamentos: (ug.groups || []).length,
  quem_traz: {
    etiquetas: "chatguru.mjs (catalogo + marcacao na conversa)",
    funis: "funis.mjs (2o passo, exige migration 0009)",
    usuarios: "chatguru.mjs (mapa de nomes em config; NAO cria login)",
    fluxos: "scripts/fluxo/converter-chatguru.mjs",
    campanhas: "campanhas.mjs",
    nps: "nps.mjs",
  },
};

// ─── GRAVACAO ────────────────────────────────────────────────────────────────
// CORPO DE RESPOSTA NAO LIDO SEGURA O SOCKET no undici — convencao ja registrada
// neste repo (`r.body?.cancel()` no helper de webhooks de saida). Numa CLI que
// termina com `process.exit`, isso nao e so vazamento: o handle em fechamento faz
// o Node abortar com assertion de libuv no Windows (aconteceu nesta sessao, e o
// stack nao aponta pra causa nenhuma). Com `Prefer: return=minimal` o corpo nunca
// e lido no caminho de sucesso, entao a drenagem tem que ser explicita.
const drenar = async (r) => {
  try {
    await r.body?.cancel();
  } catch {
    // socket ja fechado: nada a fazer
  }
};

const cabecalhos = () => ({
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
  "Content-Profile": SCHEMA,
  "Accept-Profile": SCHEMA,
});

if (DRY) {
  rel.respostas_rapidas.gravadas = null;
  if (DUMP) {
    fs.writeFileSync(DUMP, JSON.stringify({ respostas_rapidas: linhasRespostas }, null, 2));
    log(`linhas que seriam inseridas gravadas em ${DUMP}`);
  }
} else if (linhasRespostas.length) {
  // A migration 0020 e pre-condicao: sem as colunas de origem, o upsert nao tem
  // chave e reimportar DUPLICA. Melhor parar aqui e pedir a DDL do que deixar a
  // instalacao com duas copias de cada resposta rapida.
  let temColunas = false;
  try {
    const r = await fetch(`${URL_BASE}/rest/v1/respostas_rapidas?select=origem_ferramenta,origem_id&limit=1`, {
      headers: cabecalhos(),
    });
    temColunas = r.ok;
    await drenar(r);
    if (!r.ok) rel.erros.push(`respostas_rapidas sem colunas de origem: HTTP ${r.status}`);
  } catch (e) {
    rel.erros.push(`nao consegui conferir as colunas de origem: ${e.message}`);
  }
  if (!temColunas) {
    pend(
      "migration",
      "a tabela respostas_rapidas ainda nao tem as colunas origem_ferramenta/origem_id. Aplique " +
        "supabase/migrations/0020_respostas_rapidas_origem.sql no SQL Editor e rode de novo. Sem elas nao ha " +
        "chave de idempotencia, e reimportar duplicaria as respostas."
    );
    log("PARANDO antes de gravar: falta a migration 0020 (ver pendencias no relatorio)");
  } else {
    // COLISAO CONTRA O QUE JA EXISTE NO DESTINO. A chave de idempotencia e
    // (origem_ferramenta, origem_id) — ela protege contra reimportar a MESMA
    // resposta, e nao contra pisar numa resposta que alguem criou NA TELA com o
    // mesmo atalho. A tabela tem `atalho` unico por dono no painel; sem esta
    // conferencia o POST ou explodia com 23505 (derrubando o lote inteiro por
    // causa de uma linha) ou, pior, o atalho "/oi" que a equipe ja usa passaria a
    // apontar pro texto do sistema antigo sem ninguem pedir. Colidente NAO entra:
    // vira ressalva com o atalho, e renomear no painel e um clique.
    let atalhosDoDestino = null; // null = nao consegui ler
    try {
      const r = await fetch(
        `${URL_BASE}/rest/v1/respostas_rapidas?select=atalho,origem_ferramenta,origem_id&dono_id=is.null`,
        { headers: cabecalhos() }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      atalhosDoDestino = new Map();
      for (const l of await r.json()) {
        if (l?.atalho) atalhosDoDestino.set(String(l.atalho), `${l.origem_ferramenta ?? ""}|${l.origem_id ?? ""}`);
      }
    } catch (e) {
      // Ler o destino e pre-condicao pra nao pisar em dado vivo: se a leitura
      // falha, NAO se grava no escuro.
      rel.erros.push(`nao consegui ler os atalhos globais que ja existem no destino: ${e.message}`);
      log(`PARANDO antes de gravar: nao consegui ler os atalhos do destino (${e.message})`);
    }

    if (atalhosDoDestino) {
      const nossa = (l) => `${l.origem_ferramenta ?? ""}|${l.origem_id ?? ""}`;
      const aGravar = [];
      for (const l of linhasRespostas) {
        const dono = atalhosDoDestino.get(l.atalho);
        // mesma origem = e a NOSSA linha de uma passada anterior: upsert atualiza.
        if (dono !== undefined && dono !== nossa(l)) {
          rel.respostas_rapidas.colisoes_no_destino.push({ atalho: l.atalho, origem_id: l.origem_id });
          continue;
        }
        aGravar.push(l);
      }
      if (rel.respostas_rapidas.colisoes_no_destino.length)
        pend(
          "respostas rapidas",
          `${rel.respostas_rapidas.colisoes_no_destino.length} atalho(s) JA EXISTEM no destino com outra origem ` +
            `(criados na tela, ou por outra ferramenta) e NAO foram gravados: gravar sobrescreveria o texto que a ` +
            `equipe usa hoje. Os atalhos estao no json deste relatorio, em ` +
            `\`respostas_rapidas.colisoes_no_destino\` — renomear um dos dois no painel e um clique, e rodar de ` +
            `novo traz o que faltou.`
        );

      try {
        if (aGravar.length) {
          const r = await fetch(
            `${URL_BASE}/rest/v1/respostas_rapidas?on_conflict=origem_ferramenta,origem_id`,
            {
              method: "POST",
              headers: { ...cabecalhos(), Prefer: "resolution=merge-duplicates,return=minimal" },
              body: JSON.stringify(aGravar),
            }
          );
          if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
          await drenar(r);
        }
        rel.respostas_rapidas.gravadas = aGravar.length;
        log(
          `respostas rapidas gravadas: ${aGravar.length}` +
            (rel.respostas_rapidas.colisoes_no_destino.length
              ? ` (${rel.respostas_rapidas.colisoes_no_destino.length} nao entraram: atalho ja usado no destino)`
              : "")
        );
      } catch (e) {
        rel.erros.push(`respostas_rapidas: ${e.message}`);
        log(`ERRO ao gravar respostas rapidas: ${e.message}`);
      }
    }
  }
}

// ─── SAIDA ───────────────────────────────────────────────────────────────────
const n = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("pt-BR"));
const rr = rel.respostas_rapidas;
const L = [];
L.push(`# Configuracao restante — respostas rapidas e biblioteca de anexos`);
L.push("");
L.push(`- **Gerado em:** ${rel.gerado_em.replace("T", " ").slice(0, 19)} UTC`);
L.push(`- **Modo:** ${DRY ? "SIMULACAO (--dry) — nenhuma conexao foi aberta e nada foi gravado" : rel.modo}`);
L.push(`- **Origem:** \`${rel.pasta}\``);
L.push(`- **Destino:** ${rel.destino_host ? `\`${rel.destino_host}\` · schema \`${rel.schema}\`` : `schema \`${rel.schema}\` (sem destino: simulacao)`}`);
L.push("");
L.push(`## Respostas rapidas`);
L.push("");
L.push(`| Item | Qtd |`);
L.push(`| --- | ---: |`);
L.push(`| Encontradas na tela salva | ${n(rr.encontradas)} |`);
L.push(`| Prontas pra entrar | ${n(rr.prontas)} |`);
L.push(`| Gravadas | ${rr.gravadas === null ? (DRY ? "— (simulacao)" : "—") : n(rr.gravadas)} |`);
L.push(`| Atalhos que precisaram ser normalizados | ${n(rr.atalhos_normalizados)} |`);
L.push(`| Atalhos que colidiram entre si (nao entraram) | ${n(rr.colisoes.length)} |`);
L.push(`| Atalhos que ja existiam no destino (nao entraram) | ${DRY ? "— (simulacao: destino nao foi lido)" : n(rr.colisoes_no_destino.length)} |`);
L.push(`| Com variavel do sistema antigo | ${n(rr.com_variavel)} |`);
L.push(`| Texto acima de 2.000 caracteres | ${n(rr.acima_do_limite_da_tela)} |`);
L.push(`| Sem texto / sem atalho | ${n(rr.sem_texto)} / ${n(rr.sem_atalho)} |`);
L.push("");
L.push(`Entram como respostas **globais** (\`dono_id\` null): no sistema antigo elas sao da conta, nao de uma pessoa.`);
L.push("");
if (rr.variaveis_distintas.length) {
  L.push(`Variaveis encontradas: ${rr.variaveis_distintas.map((v) => `\`${v}\``).join(" · ")}.`);
  L.push("");
}
L.push(`## Biblioteca de anexos`);
L.push("");
L.push(`| Item | Valor |`);
L.push(`| --- | ---: |`);
L.push(`| **Anexos na biblioteca (declarado pela origem)** | ${n(rel.anexos.total_na_origem ?? rel.anexos.encontrados)} |`);
L.push(`| Inventariados aqui (o que o backup capturou) | ${n(rel.anexos.encontrados)} |`);
L.push(`| Paginas da tela na origem / capturada | ${n(rel.anexos.paginas_na_origem)} / ${n(rel.anexos.pagina_capturada)} |`);
L.push(`| Tamanho somado **dos inventariados** | ${(rel.anexos.bytes / 1e6).toFixed(1)} MB (10^6 bytes) |`);
L.push(`| Com etiqueta (dos inventariados) | ${n(rel.anexos.com_etiqueta)} |`);
L.push("");
if (rel.anexos.parcial) {
  L.push(
    `> **INVENTARIO PARCIAL.** A tela de anexos e paginada e o backup guardou so uma pagina: ` +
      `${n(rel.anexos.encontrados)} de ${n(rel.anexos.total_na_origem)}. O numero que vale pra decidir se a ` +
      `biblioteca de anexos vira feature e o DECLARADO pela origem, nao o inventariado.`
  );
  L.push("");
}
const mimesAnexo = Object.entries(rel.anexos.por_mime).sort((a, b) => b[1] - a[1]).slice(0, 12);
if (mimesAnexo.length) {
  L.push(`| Mime | Anexos |`);
  L.push(`| --- | ---: |`);
  for (const [m, q] of mimesAnexo) L.push(`| \`${m}\` | ${n(q)} |`);
  L.push("");
}
L.push(`## Ja trazido por outro passo (nao repetir aqui)`);
L.push("");
L.push(`| Entidade | No backup | Quem traz |`);
L.push(`| --- | ---: | --- |`);
const ja = rel.ja_importado_por_outro_passo;
L.push(`| Etiquetas (catalogo) | ${n(ja.etiquetas_no_catalogo)} | ${ja.quem_traz.etiquetas} |`);
L.push(`| Funis | ${n(ja.funis)} | ${ja.quem_traz.funis} |`);
L.push(`| Etapas de funil | ${n(ja.etapas_de_funil)} | ${ja.quem_traz.funis} |`);
L.push(`| Usuarios | ${n(ja.usuarios)} | ${ja.quem_traz.usuarios} |`);
L.push(`| Departamentos | ${n(ja.departamentos)} | ${ja.quem_traz.usuarios} |`);
L.push("");
L.push(`## Pendencias`);
L.push("");
if (!rel.pendencias.length) L.push(`Nenhuma.`);
else for (const p of rel.pendencias) L.push(`- **${p.tema}:** ${p.detalhe}`);
L.push("");
if (rel.erros.length) {
  L.push(`## Erros`);
  L.push("");
  for (const x of rel.erros) L.push(`- ${x}`);
  L.push("");
}

const carimbo = rel.gerado_em.replace(/[:.]/g, "-");
const arqJson = path.join(TRABALHO, `config-restante-${carimbo}.json`);
const arqMd = arg("relatorio", path.join(TRABALHO, `config-restante-${carimbo}.md`));
fs.writeFileSync(arqJson, JSON.stringify(rel, null, 2));
fs.writeFileSync(arqMd, L.join("\n") + "\n");

log(`FIM — ${rr.prontas} resposta(s) rapida(s) · ${rel.anexos.encontrados} anexo(s) inventariado(s)`);
log(`relatorio: ${arqMd}`);
if (DRY) log("MODO DRY: nenhuma conexao foi aberta e nada foi gravado.");
// `process.exitCode`, NAO `process.exit()`. Depois de uma requisicao HTTP o
// undici deixa o socket em keep-alive, e derrubar o processo com um handle em
// fechamento faz o Node abortar no Windows com "Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING), src\\win\\async.c" — exit code 3221226505,
// e um stack que nao aponta pra causa nenhuma. Aconteceu nesta sessao, no caminho
// que le os atalhos do destino e depois grava. Assim o codigo de saida e o mesmo e
// o Node encerra sozinho quando o socket fecha.
process.exitCode = rel.erros.length ? 1 : 0;
