#!/usr/bin/env node
// INGESTAO DA MEMORIA DA CONVERSA (contexto) — card 86ak859vt.
//
// Fecha a pendencia declarada no doc do formato canonico: "nada popula contexto
// ainda; as 4.543 referencias `$variavel` importadas avaliam FALSO (fail-closed)
// e o fluxo para no primeiro no". Enquanto nada popula, 3.895 fluxos importados
// carregam essa ressalva.
//
// ————————————————————————————————————————————————————————————————————————
// LEIA ISTO ANTES DE USAR: **O BACKUP NAO TEM OS VALORES.** (medido 31/08/2026)
//
// Varredura completa do backup de uma conta (19.992 chats no indice + 1,46 GB de
// arquivos de mensagem, mais `config/`, `config-dados/`, `automacao/` e o estado
// do robo):
//
//   - `chats_index.json` tem EXATAMENTE 19 chaves por chat, e nenhuma delas e
//     contexto/variavel/campo personalizado (conferido tambem numa 2a conta, de
//     200.620 chats: mesmas 19 chaves — a lacuna e do coletor, nao da conta);
//   - no arquivo de mensagens, o unico bloco do robo e `bot_response`, com TRES
//     chaves possiveis: `intents_found` (540.061 ocorrencias, 38.977 preenchidas,
//     6 nomes de intencao), `user_entities_found` (540.061 ocorrencias, **todas
//     `{}`** — era o unico candidato a valor extraido) e `dialog_executed`, cujos
//     itens tem UMA chave, `title`. Ou seja: da pra saber QUE dialogo rodou,
//     nunca em quanto ficou a variavel;
//   - busca literal por `"context*"`, `"variav*"`, `"custom_field*"`,
//     `"campos_personalizados"`, `"fields"`, `"info"` como CHAVE de JSON em tudo
//     isso: **zero ocorrencias**.
//
// Consequencia honesta, e ela decide o desenho deste script: **conversa migrada
// comeca com memoria VAZIA, e nao existe jeito de restaurar o estado de dentro do
// backup.** Um script que fingisse restaurar (derivando de `dialog_executed`, por
// exemplo) inventaria estado de atendimento — e estado de menu inventado manda o
// cliente pro ramo errado do fluxo, calado. Nao se chuta memoria.
//
// O QUE DA PRA FAZER, e e o que este script faz — DOIS MODOS:
//
//   1. `--catalogo <pasta-da-conta>`  (nao precisa de banco)
//      Extrai o CATALOGO de variaveis do proprio backup: `automacao/fluxos.json`
//      tem, por dialogo, `contexto: [{variavel, valor}]` — o lado da ESCRITA, que
//      SIM foi capturado. Na conta medida: 380 dos 935 dialogos, **63 nomes
//      distintos** (`URA` 151, `AUTOATENDIMENTO` 105, `AUTOATENDIMENTO_ETAPA` 77,
//      `timer_opcao` 67, `timer` 45, `timer_menu` 38, `UTM Source` 25, ...).
//      Serve pra: validar `$NOME` no editor/simulador em vez de aceitar qualquer
//      coisa, e pra quem conduz a virada saber o que precisa ser semeado.
//      Grava em `mensageria.config` chave `contexto_catalogo` — **sem DDL**, como
//      os `webhooks_saida` da frente F: e catalogo, nao dado de conversa.
//
//   2. `--arquivo <valores.csv|json>`  (o que popula de verdade)
//      Ingere os VALORES de um arquivo que o CLIENTE fornece (export da planilha
//      dele, do CRM, do sistema que de fato conhece o estado). Dois formatos:
//        LARGO : uma linha por conversa, uma COLUNA por variavel
//                telefone,URA,AUTOATENDIMENTO,campanha
//        LONGO : uma linha por par
//                telefone,chave,valor
//      Detectado sozinho (se existir coluna `chave`+`valor`, e longo).
//
// ————————————————————————————————————————————————————————————————————————
// O DEFAULT E O INVENTARIO: GRAVAR EXIGE `--valendo`.
//
// Mesma regra de `midia.mjs`, e pelo mesmo motivo medido na revisao cega dele: o
// modo destrutivo NAO pode ser o que sai de esquecer uma flag. Sem `--valendo`
// este script nao abre conexao nenhuma — le, valida, conta e mostra.
//
// ESCRITA ATOMICA, sempre pela funcao do banco (`mensageria.definir_contexto`,
// migration 0016) e nunca por read-modify-write: duas escritas na mesma conversa
// se apagariam em silencio. O mesmo motivo pelo qual a acao de fluxo usa a RPC.
//
// AUTORIA pela convencao 0006: `p_por_id` NULL + `p_por_nome` preenchido = veio
// de automacao, nao de pessoa. Aqui o nome e o rotulo da importacao.
//
// PRIVACIDADE: o relatorio sai com CONTAGEM e NOME DE VARIAVEL. Valor de contexto
// e dado de cliente ("de que campanha o Joao veio", "em que ponto do menu ele
// esta") — nao vai pro terminal e nao vira fixture do repo.

import fs from "node:fs";
import path from "node:path";

// ─── ARGUMENTOS ──────────────────────────────────────────────────────────────
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const CATALOGO = arg("catalogo");
const ARQUIVO = arg("arquivo");
const URL_BASE = arg("url", process.env.MSG_SUPABASE_URL || "");
const KEY = arg("key", process.env.MSG_SUPABASE_SERVICE_KEY || "");
const SCHEMA = arg("schema", "mensageria");
const CANAL = arg("canal", "central");
const AUTOR = arg("autor", "importacao de contexto");
const COL_CHAT = arg("col-chat");
const VALENDO = flag("valendo");
const PROVA = flag("prova");
const LIMITE = Math.max(0, Number(arg("limite", 0)) || 0);

const USO = `uso (um dos dois modos):

  CATALOGO de variaveis (nao precisa de banco pra ler):
    node scripts/importar/contexto.mjs --catalogo <pasta-da-conta> [--valendo --url <url> --key <key>]

  VALORES por conversa (o arquivo vem do CLIENTE — o backup NAO tem os valores):
    node scripts/importar/contexto.mjs --arquivo <valores.csv|json> [--canal central]
                                       [--valendo --url <url> --key <key>]

  --valendo            GRAVA. Sem ele, nada e gravado e nenhuma conexao e aberta.
  --url / --key        instalacao de destino (ou envs MSG_SUPABASE_URL / MSG_SUPABASE_SERVICE_KEY)
  --canal <id>         canal das conversas do arquivo (default: central)
  --col-chat <nome>    coluna do telefone/chat_id (default: adivinha)
  --autor <texto>      rotulo que fica gravado como autor da escrita
  --limite <n>         processa so as N primeiras linhas (conferencia)
  --prova              roda a prova interna (fixture sintetica, sem arquivo e sem banco)
`;

// ─── REGRAS ESPELHADAS de lib/fluxo/schema.ts ───────────────────────────────
// MUDOU LA, MUDA AQUI (mesma convencao que o cabecalho de `segundosUteis`
// declara entre a versao TS e a SQL). Se a chave que este script grava nao passar
// pela MESMA normalizacao da acao de fluxo, o fluxo grava "URA" e a condicao
// procura "URA " — e o usuario final nao tem como enxergar esse bug.
export const LIMITE_CHAVE_CONTEXTO = 120;
export const LIMITE_VALOR_CONTEXTO = 1000;

/** Espelho de `chaveDeContexto`. Devolve null quando a chave nao serve. */
export function chaveDeContexto(bruto) {
  if (typeof bruto !== "string") return null;
  const chave = bruto.trim();
  if (!chave || chave.length > LIMITE_CHAVE_CONTEXTO) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(chave)) return null;
  return chave;
}

/**
 * Telefone -> chat_id do painel. Espelho ENXUTO de `normalizarTelefone`
 * (lib/disparo/telefone.ts): so digitos, 10 a 15. Grupo entra as-is com o sufixo
 * que o painel usa.
 */
export function paraChatId(bruto) {
  const s = String(bruto ?? "").trim();
  if (!s) return null;
  const g = s.replace(/@g\.us$/i, "-group");
  if (/^\d{15,25}-group$/.test(g)) return g;
  const d = s.replace(/\D/g, "");
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

const semAcento = (s) =>
  String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

// ─── CATALOGO DE VARIAVEIS (modo 1) ─────────────────────────────────────────

/**
 * Extrai o catalogo de `automacao/fluxos.json`. PURA.
 *
 * A chave que interessa e `contexto: [{variavel, valor}]` por dialogo — o lado da
 * ESCRITA. Ele foi capturado; o lado da LEITURA (as condicoes) nao: medido, o
 * campo do formulario de condicao tem so 2 valores distintos em ~925 dialogos,
 * porque o backup guardou o ULTIMO estado do formulario compartilhado do editor,
 * nao a condicao de cada dialogo. Entao o catalogo e do que os fluxos ESCREVEM —
 * e esta dito, pra ninguem apresentar como "todas as variaveis da conta".
 */
export function catalogoDeFluxos(fluxos) {
  const lista = Array.isArray(fluxos) ? fluxos : [];
  const porNome = new Map();
  let comContexto = 0;
  let invalidas = 0;

  for (const f of lista) {
    const ctx = Array.isArray(f?.contexto) ? f.contexto : [];
    if (ctx.length) comContexto++;
    for (const par of ctx) {
      const nome = chaveDeContexto(par?.variavel);
      if (!nome) {
        invalidas++;
        continue;
      }
      const alvo = porNome.get(nome) || { variavel: nome, dialogos: 0, valores_distintos: new Set() };
      alvo.dialogos++;
      // o VALOR aqui e o que o dialogo CONFIGURA (nao o estado de ninguem), entao
      // guardar a contagem de valores distintos e seguro e util: variavel com 2
      // valores e interruptor, com 30 e identificador
      const v = typeof par?.valor === "string" ? par.valor.trim() : "";
      if (v) alvo.valores_distintos.add(v.slice(0, LIMITE_VALOR_CONTEXTO));
      porNome.set(nome, alvo);
    }
  }

  const variaveis = [...porNome.values()]
    .map((v) => ({ variavel: v.variavel, dialogos: v.dialogos, valores_distintos: v.valores_distintos.size }))
    .sort((a, b) => b.dialogos - a.dialogos || a.variavel.localeCompare(b.variavel, "pt-BR"));

  return { variaveis, total_dialogos: lista.length, dialogos_com_contexto: comContexto, invalidas };
}

// ─── VALORES POR CONVERSA (modo 2) ──────────────────────────────────────────

// CSV com aspas duplas; separador , ou ; detectado pela 1a linha. Copia
// deliberada do leitor de `nps.mjs`: extrair pra um modulo compartilhado mexeria
// num script de outro dono no mesmo dia.
export function lerCsv(texto) {
  const primeira = texto.split("\n")[0] || "";
  const sep = (primeira.match(/;/g) || []).length > (primeira.match(/,/g) || []).length ? ";" : ",";
  const linhas = [];
  let campo = "";
  let linha = [];
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else aspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') {
      aspas = true;
      continue;
    }
    if (c === sep) {
      linha.push(campo);
      campo = "";
      continue;
    }
    if (c === "\n") {
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = "";
      continue;
    }
    if (c !== "\r") campo += c;
  }
  if (campo || linha.length) {
    linha.push(campo);
    linhas.push(linha);
  }
  const cab = (linhas.shift() || []).map((h) => h.trim());
  return linhas
    .filter((l) => l.some((v) => String(v).trim()))
    .map((l) => Object.fromEntries(cab.map((h, i) => [h, (l[i] ?? "").trim()])));
}

const NOMES_CHAT = ["telefone", "celular", "whatsapp", "whats", "chat_id", "chat", "contato", "phone", "numero"];

/** Acha a coluna do telefone. PURA. */
export function acharColunaChat(colunas, explicito) {
  if (explicito) return colunas.includes(explicito) ? explicito : null;
  for (const p of NOMES_CHAT) {
    const k = colunas.find((c) => semAcento(c) === p);
    if (k) return k;
  }
  for (const p of NOMES_CHAT) {
    const k = colunas.find((c) => semAcento(c).startsWith(p));
    if (k) return k;
  }
  return null;
}

/** LARGO (coluna por variavel) ou LONGO (chave/valor)? PURA. */
export function formatoDoArquivo(colunas) {
  const norm = colunas.map(semAcento);
  const temChave = norm.some((c) => c === "chave" || c === "variavel" || c === "key");
  const temValor = norm.some((c) => c === "valor" || c === "value");
  return temChave && temValor ? "longo" : "largo";
}

/**
 * Registros -> pares (chat_id, chave, valor). PURA, e e o coracao da ingestao.
 *
 * DUAS RECUSAS que valem mais que a conversao em si:
 *  - **celula VAZIA nao vira contexto vazio.** No avaliador de condicao, chave
 *    AUSENTE e chave com valor "" sao coisas diferentes (`nao_existe` so volta a
 *    valer apagando a chave — regra da frente L). Uma planilha com 40 colunas e
 *    metade em branco gravaria 20 variaveis vazias por conversa, e cada uma
 *    mudaria o ramo do fluxo. Vazio e PULADO, e contado.
 *  - **linha sem telefone valido nao entra**, com o motivo. Contexto gravado no
 *    chat_id errado e memoria de OUTRO cliente.
 */
export function paresDosRegistros(registros, { colChat, formato, limite = 0 }) {
  const pares = [];
  const rejeitadas = [];
  const porVariavel = new Map();
  const conversas = new Set();
  let vazias = 0;
  let chavesInvalidas = 0;
  let valoresLongos = 0;

  const usados = limite > 0 ? registros.slice(0, limite) : registros;
  usados.forEach((r, i) => {
    const linha = i + 2; // +1 do cabecalho, +1 pra contar de 1
    const chatId = paraChatId(r[colChat]);
    if (!chatId) {
      rejeitadas.push({ linha, motivo: "telefone/chat_id invalido ou vazio" });
      return;
    }

    const adiciona = (chaveBruta, valorBruto) => {
      const chave = chaveDeContexto(chaveBruta);
      if (!chave) {
        chavesInvalidas++;
        return;
      }
      const valor = String(valorBruto ?? "");
      // vazio NAO vira contexto (ver o comentario acima)
      if (!valor.trim()) {
        vazias++;
        return;
      }
      if (valor.length > LIMITE_VALOR_CONTEXTO) {
        valoresLongos++;
        rejeitadas.push({ linha, motivo: `valor de "${chave}" acima de ${LIMITE_VALOR_CONTEXTO} caracteres` });
        return;
      }
      pares.push({ chat_id: chatId, chave, valor });
      conversas.add(chatId);
      porVariavel.set(chave, (porVariavel.get(chave) || 0) + 1);
    };

    if (formato === "longo") {
      const kChave = Object.keys(r).find((c) => ["chave", "variavel", "key"].includes(semAcento(c)));
      const kValor = Object.keys(r).find((c) => ["valor", "value"].includes(semAcento(c)));
      adiciona(r[kChave], r[kValor]);
      return;
    }

    for (const [col, v] of Object.entries(r)) {
      if (col === colChat) continue;
      adiciona(col, v);
    }
  });

  return {
    pares,
    rejeitadas,
    conversas: conversas.size,
    por_variavel: [...porVariavel.entries()].sort((a, b) => b[1] - a[1]),
    vazias,
    chaves_invalidas: chavesInvalidas,
    valores_longos: valoresLongos,
  };
}

// ─── PROVA INTERNA ──────────────────────────────────────────────────────────

async function prova() {
  const assert = (await import("node:assert/strict")).default;
  let ok = 0;
  const t = (oque, fn) => {
    fn();
    ok++;
    console.log(`  ok  ${oque}`);
  };

  console.log("\nprova da ingestao de contexto (fixture sintetica; nenhum backup lido, nada gravado)");

  t("chaveDeContexto espelha o schema: apara, recusa vazio, recusa controle e recusa longa", () => {
    assert.equal(chaveDeContexto("  URA  "), "URA");
    assert.equal(chaveDeContexto(""), null);
    assert.equal(chaveDeContexto("   "), null);
    assert.equal(chaveDeContexto("a\nb"), null);
    assert.equal(chaveDeContexto("x".repeat(121)), null);
    assert.equal(chaveDeContexto("x".repeat(120)), "x".repeat(120));
    assert.equal(chaveDeContexto(42), null);
    // nome com espaco e acento VALE (medido no dialeto da origem: `$Reserva confirmada`)
    assert.equal(chaveDeContexto("Reserva confirmada"), "Reserva confirmada");
    assert.equal(chaveDeContexto("UTM Source"), "UTM Source");
  });

  t("paraChatId aceita mascara e grupo, recusa curto/longo e texto", () => {
    assert.equal(paraChatId("+55 (11) 90000-0001"), "5511900000001");
    assert.equal(paraChatId("120363000000000001@g.us"), "120363000000000001-group");
    assert.equal(paraChatId("123"), null);
    assert.equal(paraChatId("sem numero"), null);
    assert.equal(paraChatId(""), null);
    assert.equal(paraChatId(null), null);
  });

  t("catalogo conta dialogos por variavel e valores distintos, e ordena pelo uso", () => {
    const c = catalogoDeFluxos([
      { contexto: [{ variavel: "URA", valor: "MENU" }, { variavel: "timer", valor: "1" }] },
      { contexto: [{ variavel: "URA", valor: "VENDAS" }] },
      { contexto: [{ variavel: "URA", valor: "MENU" }] },
      { contexto: [] },
      { contexto: [{ variavel: "  ", valor: "x" }] },
    ]);
    assert.equal(c.total_dialogos, 5);
    assert.equal(c.dialogos_com_contexto, 4);
    assert.equal(c.invalidas, 1);
    assert.deepEqual(c.variaveis[0], { variavel: "URA", dialogos: 3, valores_distintos: 2 });
    assert.equal(c.variaveis[1].variavel, "timer");
  });

  t("catalogo de entrada torta nao quebra e nao inventa", () => {
    for (const x of [null, undefined, {}, "x", [null, 1, { contexto: "nao e lista" }]]) {
      const c = catalogoDeFluxos(x);
      assert.equal(c.variaveis.length, 0);
    }
  });

  t("formatoDoArquivo detecta LONGO por chave+valor, e cai em LARGO no resto", () => {
    assert.equal(formatoDoArquivo(["telefone", "chave", "valor"]), "longo");
    assert.equal(formatoDoArquivo(["telefone", "variavel", "valor"]), "longo");
    assert.equal(formatoDoArquivo(["telefone", "URA", "campanha"]), "largo");
    // so `chave` sem `valor` NAO e longo (senao uma coluna chamada "chave" com
    // outro sentido viraria par malformado)
    assert.equal(formatoDoArquivo(["telefone", "chave"]), "largo");
  });

  t("acharColunaChat prefere o nome EXATO antes do prefixo", () => {
    assert.equal(acharColunaChat(["Telefone do contato", "telefone"], null), "telefone");
    assert.equal(acharColunaChat(["Celular"], null), "Celular");
    assert.equal(acharColunaChat(["nome", "email"], null), null);
    assert.equal(acharColunaChat(["nome", "email"], "email"), "email");
    assert.equal(acharColunaChat(["nome"], "inexistente"), null);
  });

  const largo = [
    { telefone: "+55 11 90000-0001", URA: "MENU", campanha: "black", vazia: "" },
    { telefone: "5511900000002", URA: "VENDAS", campanha: "", vazia: "" },
    { telefone: "abc", URA: "MENU", campanha: "x", vazia: "" },
  ];

  t("LARGO: cada coluna vira uma variavel, e a coluna do telefone nao vira contexto", () => {
    const r = paresDosRegistros(largo, { colChat: "telefone", formato: "largo" });
    assert.equal(r.conversas, 2);
    assert.deepEqual(
      r.pares.map((p) => `${p.chat_id}:${p.chave}=${p.valor}`),
      ["5511900000001:URA=MENU", "5511900000001:campanha=black", "5511900000002:URA=VENDAS"]
    );
    assert.equal(r.pares.some((p) => p.chave === "telefone"), false);
  });

  t("A RECUSA QUE IMPORTA: celula VAZIA nao vira contexto vazio (ela mudaria o ramo do fluxo)", () => {
    const r = paresDosRegistros(largo, { colChat: "telefone", formato: "largo" });
    // 3 vazias na linha 1+2 (`vazia` x2) + `campanha` da linha 2, e a linha torta
    assert.ok(r.vazias >= 3);
    assert.equal(r.pares.some((p) => p.valor === ""), false);
  });

  t("linha com telefone invalido e REJEITADA com motivo, e nao grava no chat errado", () => {
    const r = paresDosRegistros(largo, { colChat: "telefone", formato: "largo" });
    assert.equal(r.rejeitadas.length, 1);
    assert.match(r.rejeitadas[0].motivo, /telefone/);
    assert.equal(r.rejeitadas[0].linha, 4);
  });

  t("LONGO: uma linha por par", () => {
    const r = paresDosRegistros(
      [
        { telefone: "5511900000001", chave: "URA", valor: "MENU" },
        { telefone: "5511900000001", chave: "campanha", valor: "black" },
      ],
      { colChat: "telefone", formato: "longo" }
    );
    assert.equal(r.pares.length, 2);
    assert.equal(r.conversas, 1);
  });

  t("valor acima do teto e rejeitado com motivo (nao truncado em silencio)", () => {
    const r = paresDosRegistros([{ telefone: "5511900000001", URA: "x".repeat(LIMITE_VALOR_CONTEXTO + 1) }], {
      colChat: "telefone",
      formato: "largo",
    });
    assert.equal(r.pares.length, 0);
    assert.equal(r.valores_longos, 1);
    assert.match(r.rejeitadas[0].motivo, /acima de/);
  });

  t("--limite corta as linhas processadas", () => {
    const r = paresDosRegistros(largo, { colChat: "telefone", formato: "largo", limite: 1 });
    assert.equal(r.conversas, 1);
  });

  t("por_variavel sai ordenado pelo uso (e o que a conferencia da virada le)", () => {
    const r = paresDosRegistros(largo, { colChat: "telefone", formato: "largo" });
    assert.equal(r.por_variavel[0][0], "URA");
    assert.equal(r.por_variavel[0][1], 2);
  });

  t("chave invalida e contada e nao vira par", () => {
    const r = paresDosRegistros([{ telefone: "5511900000001", "": "x", "a\nb": "y", URA: "MENU" }], {
      colChat: "telefone",
      formato: "largo",
    });
    assert.equal(r.chaves_invalidas, 2);
    assert.equal(r.pares.length, 1);
  });

  console.log(`\nTUDO OK — ${ok} checagens, nenhum backup lido, nenhuma conexao aberta.`);
}

// ─── HTTP (so com --valendo) ─────────────────────────────────────────────────

function clienteRest() {
  const base = URL_BASE.replace(/\/+$/, "");
  return async function rest(caminho, opcoes = {}) {
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
    // corpo SEMPRE drenado (`r.text()` ja faz) e nada de `process.exit()` no fim
    // do script: o undici deixa o socket em keep-alive e derrubar o processo com
    // handle em fechamento aborta o node no Windows (a licao que a frente R pagou).
    if (!r.ok) throw new Error(`${r.status} ${caminho}: ${txt.slice(0, 300)}`);
    return txt ? JSON.parse(txt) : null;
  };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  if (PROVA) {
    await prova();
    return;
  }
  if (!CATALOGO && !ARQUIVO) {
    console.error(USO);
    process.exitCode = 2;
    return;
  }
  if (VALENDO && (!URL_BASE || !KEY)) {
    console.error("--valendo exige --url e --key (ou as envs MSG_SUPABASE_URL / MSG_SUPABASE_SERVICE_KEY).\n");
    process.exitCode = 2;
    return;
  }

  // ── modo 1: catalogo
  if (CATALOGO) {
    const arq = fs.existsSync(path.join(CATALOGO, "automacao", "fluxos.json"))
      ? path.join(CATALOGO, "automacao", "fluxos.json")
      : CATALOGO;
    if (!fs.existsSync(arq)) {
      console.error(`nao achei automacao/fluxos.json em ${CATALOGO}.`);
      process.exitCode = 2;
      return;
    }
    let fluxos;
    try {
      fluxos = JSON.parse(fs.readFileSync(arq, "utf8"));
    } catch (e) {
      console.error(`fluxos.json ilegivel: ${e.message}`);
      process.exitCode = 2;
      return;
    }
    const c = catalogoDeFluxos(fluxos);
    console.log(`catalogo de variaveis de contexto — ${path.basename(path.dirname(path.dirname(arq)))}`);
    console.log(
      `dialogos: ${c.total_dialogos} | com contexto: ${c.dialogos_com_contexto} | variaveis distintas: ${c.variaveis.length}${
        c.invalidas ? ` | entradas invalidas: ${c.invalidas}` : ""
      }`
    );
    for (const v of c.variaveis.slice(0, 40)) {
      console.log(`  ${String(v.dialogos).padStart(4)}x  ${v.variavel}  (${v.valores_distintos} valor(es) distinto(s))`);
    }
    if (c.variaveis.length > 40) console.log(`  ... e mais ${c.variaveis.length - 40}`);
    console.log(
      "\nATENCAO: este e o catalogo do que os fluxos ESCREVEM. O lado da LEITURA (as\n" +
        "condicoes) nao foi capturado no backup, e o ESTADO por conversa nao existe la\n" +
        "de forma alguma — conversa migrada comeca com memoria vazia. Ver o cabecalho\n" +
        "deste arquivo."
    );
    if (!VALENDO) {
      console.log("\nsem --valendo: nada gravado, nenhuma conexao aberta.");
      return;
    }
    const rest = clienteRest();
    await rest("config?on_conflict=chave", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([
        {
          chave: "contexto_catalogo",
          valor: {
            gerado_em: new Date().toISOString(),
            origem: "backup: automacao/fluxos.json (lado da ESCRITA dos dialogos)",
            lado_da_leitura_capturado: false,
            estado_por_conversa_no_backup: false,
            dialogos: c.total_dialogos,
            dialogos_com_contexto: c.dialogos_com_contexto,
            variaveis: c.variaveis,
          },
          updated_at: new Date().toISOString(),
        },
      ]),
    });
    console.log(`\nOK — catalogo com ${c.variaveis.length} variavel(is) gravado em config.contexto_catalogo.`);
    return;
  }

  // ── modo 2: valores por conversa
  const ext = path.extname(ARQUIVO).toLowerCase();
  const cru = fs.readFileSync(ARQUIVO, "utf8");
  let registros;
  if (ext === ".json") {
    const j = JSON.parse(cru);
    registros = Array.isArray(j) ? j : Array.isArray(j.contextos) ? j.contextos : Array.isArray(j.data) ? j.data : [];
  } else {
    registros = lerCsv(cru);
  }
  if (!registros.length) {
    console.error("nenhuma linha lida do arquivo (formato inesperado?).");
    process.exitCode = 1;
    return;
  }

  const colunas = Object.keys(registros[0]);
  const colChat = acharColunaChat(colunas, COL_CHAT);
  if (!colChat) {
    console.error(`nao achei a coluna do telefone/chat_id. Colunas do arquivo: ${colunas.join(", ")}`);
    console.error("passe --col-chat <nome>.");
    process.exitCode = 2;
    return;
  }
  const formato = formatoDoArquivo(colunas);
  const r = paresDosRegistros(registros, { colChat, formato, limite: LIMITE });

  console.log(`arquivo: ${path.basename(ARQUIVO)} — ${registros.length} linha(s), formato ${formato.toUpperCase()}`);
  console.log(`coluna do chat: ${colChat} | canal de destino: ${CANAL}`);
  console.log(`pares a gravar: ${r.pares.length} em ${r.conversas} conversa(s)`);
  console.log(
    `descartes: celula vazia ${r.vazias} | chave invalida ${r.chaves_invalidas} | valor longo ${r.valores_longos} | linha rejeitada ${r.rejeitadas.length}`
  );
  for (const [nome, qtd] of r.por_variavel.slice(0, 30)) console.log(`  ${String(qtd).padStart(6)}x  ${nome}`);
  if (r.por_variavel.length > 30) console.log(`  ... e mais ${r.por_variavel.length - 30} variavel(is)`);
  for (const rj of r.rejeitadas.slice(0, 20)) console.log(`  linha ${rj.linha}: ${rj.motivo}`);
  if (r.rejeitadas.length > 20) console.log(`  ... e mais ${r.rejeitadas.length - 20} linha(s) rejeitada(s)`);

  if (!r.pares.length) {
    console.log("\nnada a gravar.");
    return;
  }
  if (!VALENDO) {
    console.log(
      "\nsem --valendo: NADA gravado e nenhuma conexao aberta. Confira as variaveis acima\n" +
        "(especialmente se os nomes batem com o que as condicoes procuram) e rode de novo\n" +
        "com --valendo --url ... --key ..."
    );
    return;
  }

  // GRAVACAO — uma RPC por par, de propostio: a funcao do banco faz a alteracao
  // ATOMICA dentro do jsonb. Um upsert em lote na tabela sobrescreveria o mapa
  // inteiro e apagaria variavel que o motor gravou no meio da importacao.
  const rest = clienteRest();
  let gravados = 0;
  const falhas = [];
  for (const p of r.pares) {
    try {
      await rest("rpc/definir_contexto", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          p_canal: CANAL,
          p_chat_id: p.chat_id,
          p_chave: p.chave,
          p_valor: p.valor,
          // convencao 0006: id NULL + nome preenchido = automacao, nao pessoa
          p_por_id: null,
          p_por_nome: AUTOR,
        }),
      });
      gravados++;
    } catch (e) {
      // falha NAO para a importacao inteira (uma conversa torta nao pode
      // impedir as outras), mas TAMBEM nao passa calada
      falhas.push({ chave: p.chave, erro: String(e?.message || e).slice(0, 160) });
      if (falhas.length > 50) break;
    }
  }

  console.log(`\nOK — ${gravados} par(es) gravado(s) em ${CANAL}.`);
  if (falhas.length) {
    console.log(`FALHAS: ${falhas.length}${falhas.length > 50 ? " (parei em 50)" : ""}`);
    for (const f of falhas.slice(0, 10)) console.log(`  ${f.chave}: ${f.erro}`);
    console.log("\nse o erro fala de funcao/tabela inexistente, a migration 0016 nao foi aplicada nesta instalacao.");
    process.exitCode = 1;
  }
}

await main();
