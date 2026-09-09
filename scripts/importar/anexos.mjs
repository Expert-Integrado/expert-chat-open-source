#!/usr/bin/env node
// Importar a BIBLIOTECA DE ANEXOS: re-hospedar o arquivo e gravar o acervo.
//
// PASSO SEPARADO, e pelo mesmo motivo do `midia.mjs`: os enderecos dos anexos
// apontam pro armazenamento do fornecedor e **morrem com a conta**. Um acervo
// importado com o endereco antigo e um acervo que para de funcionar no dia em que
// o contrato acaba — e pior que nao importar, porque o fluxo de automacao passa a
// mandar link morto pro cliente sem ninguem perceber.
//
//   # 1) inventario: quantos anexos, que tipos, quanto pesa (NAO baixa, NAO sobe)
//   node scripts/importar/anexos.mjs --pasta <backup>
//
//   # 2) prova de ponta a ponta contra armazenamento LOCAL DE MENTIRA, sem banco
//   node scripts/importar/anexos.mjs --pasta <backup> --valendo --sem-banco \
//     --destino-local /tmp/mock --url-publica-base http://localhost/mock \
//     --pasta-arquivos <dir com os bytes> --sem-rede
//
//   # 3) valendo (storage e banco do CLIENTE, vindos de env)
//   export MSG_SUPABASE_URL=... MSG_SUPABASE_SERVICE_KEY=... MSG_STORAGE_BUCKET=midia-mensagens
//   node scripts/importar/anexos.mjs --pasta <backup> --valendo
//
// O DEFAULT E O INVENTARIO. Subir e gravar exige `--valendo` escrito na mao —
// mesma regra do lote.mjs e do midia.mjs.
//
// ORDEM NA MIGRACAO (importa, e esta declarada no CLAUDE.md): este passo roda
// ANTES da conversao dos fluxos. Ele emite `anexos-chaves.json` (id na origem ->
// chave no painel), e e esse mapa que faz o conversor de dialogos emitir o passo
// `anexar_biblioteca` em vez de uma ressalva. Sem o mapa, a acao ANEXAR dos
// dialogos continua virando ressalva — nunca chute.
//
// O QUE ESTE PASSO NAO FAZ:
//   * nao cria tabela nem bucket (DDL e gesto humano: migration 0024);
//   * nao inventa endereco: arquivo que nao subiu NAO vira linha na biblioteca.
//     Aqui isto e diferente da midia das mensagens, onde a linha ja existe e
//     manter o endereco antigo preserva o registro do que existia. Linha de
//     biblioteca com URL morta seria material que o fluxo manda e o cliente nao
//     abre;
//   * nao adivinha o que o backup nao tem: a tela de anexos da origem e PAGINADA,
//     e o backup guardou uma pagina (medido: 795 capturados de 3.287 declarados em
//     33 contas). O relatorio declara PARCIAL com os dois numeros separados.

import fs from "node:fs";
import path from "node:path";
import { drenar, extensaoDe, subirParaLocal, subirParaStorage } from "./rehospedagem.mjs";
import { donoDaChave, inventarioDeAnexos, marcacaoNoInicio } from "./anexos-catalogo.mjs";

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
const BUCKET = arg("bucket", process.env.MSG_STORAGE_BUCKET || "midia-mensagens");
const PREFIXO = arg("prefixo", "biblioteca");
const VALENDO = flag("valendo");
const DRY = !VALENDO;
const SEM_BANCO = flag("sem-banco");
const SEM_REDE = flag("sem-rede");
const DESTINO_LOCAL = arg("destino-local");
const URL_PUBLICA_BASE = arg("url-publica-base");
const PASTA_ARQUIVOS = arg("pasta-arquivos");
const AMOSTRA = Number(arg("amostra", 0)) || 0;
const TETO_MB = Number(arg("teto-mb", 25)) || 25;
const TETO = TETO_MB * 1024 * 1024;
const TRABALHO = arg("trabalho", PASTA ? path.join(PASTA, ".importacao") : "");
// as LINHAS que iriam pro banco, escritas num JSON pra conferir campo a campo
// (mesmo recurso do chatguru.mjs e do intencoes.mjs)
const DUMP = arg("dump");
const ORIGEM = arg("origem", "chatguru");

const USO = `uso: node scripts/importar/anexos.mjs --pasta <backup> [--valendo]

  --pasta <dir>             pasta do backup (obrigatoria)
  (sem --valendo)           DEFAULT: SO INVENTARIA — conta, tipos, tamanho e as chaves que SERIAM criadas.
  --valendo                 baixa, sobe e grava o acervo. E o unico jeito de fazer efeito.
  --amostra <n>             processa so os N primeiros anexos (prova curta)
  --teto-mb <n>             anexo maior que isso e pulado e declarado (default: 25)
  --sem-rede                proibe download: usa so os bytes que estao em --pasta-arquivos
  --pasta-arquivos <dir>    onde estao os bytes ja baixados (nome do arquivo na origem)
  --sem-banco               sobe os arquivos mas NAO grava linha na biblioteca
  --destino-local <dir>     armazenamento LOCAL DE MENTIRA em vez do Storage (para prova)
  --url-publica-base <url>  prefixo publico do destino local (obrigatorio com --destino-local)
  --bucket <nome>           bucket do Storage (default: env MSG_STORAGE_BUCKET ou midia-mensagens)
  --prefixo <dir>           prefixo dentro do bucket (default: biblioteca — o mesmo que o painel usa)
  --schema <nome>           schema no banco (default: mensageria)
  --url <url> --key <k>     projeto do CLIENTE (ou envs MSG_SUPABASE_URL / MSG_SUPABASE_SERVICE_KEY)
  --origem <nome>           rotulo de origem gravado na linha (default: chatguru)
  --dump <arq>              escreve num JSON as linhas exatas que entrariam na biblioteca
  --trabalho <dir>          onde ficam mapa e relatorio (default: <pasta>/.importacao)`;

if (!PASTA || flag("help") || flag("ajuda")) {
  console.log(USO);
  process.exit(PASTA ? 0 : 2);
}
if (!fs.existsSync(PASTA)) {
  console.error(`pasta nao encontrada: ${PASTA}`);
  process.exit(2);
}
if (DESTINO_LOCAL && !URL_PUBLICA_BASE) {
  console.error("--destino-local exige --url-publica-base (o endereco que iria pro banco tem que ser explicito).");
  process.exit(2);
}
if (!DRY && !DESTINO_LOCAL && (!URL_BASE || !KEY)) {
  console.error(
    "sem --destino-local e obrigatorio informar --url e --key (ou as envs equivalentes).\n" +
      "O destino NUNCA e embutido no codigo: ele vem do ambiente de quem roda.\n"
  );
  process.exit(2);
}
if (!DRY && !SEM_BANCO && (!URL_BASE || !KEY)) {
  console.error("pra gravar a biblioteca preciso de --url e --key (ou --sem-banco).");
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
const limpo = (v) => (typeof v === "string" ? v.trim() : "");

fs.mkdirSync(TRABALHO, { recursive: true });

// A CHAVE E A LEITURA DO CATALOGO moram em `anexos-catalogo.mjs` (puras, sem
// disco/rede/argv): e o que a prova exercita direto e o que o conversor de
// dialogos reusa. Aqui fica so a CLI — bytes, destino, banco e relatorio.

function acharCatalogo(pasta) {
  const candidatos = [
    path.join(pasta, "config", "attachments_search.json"),
    path.join(pasta, "config", "xhr_GET__attachments_search.json"),
    path.join(pasta, "attachments_search.json"),
  ];
  return candidatos.find((p) => fs.existsSync(p)) || null;
}

// ─── DESTINO ─────────────────────────────────────────────────────────────────
//
// O CAMINHO NO BUCKET E O MESMO QUE O PAINEL USA: `biblioteca/<chave>.<ext>`
// (`caminhoDoAnexo`, que mora em lib/anexos.ts desde a extracao do arquivo puro;
// lib/anexos-db.ts so re-exporta). Nao e detalhe, e e uma faca de dois gumes:
// com o caminho igual, reimportar o MESMO item reescreve o MESMO objeto em vez de
// duplicar 345 GB de acervo — mas uma chave que ja pertence a OUTRO item
// sobrescreveria o arquivo vivo que os fluxos mandam pro cliente. Por isso este
// passo le, ANTES de subir, quem ja e dono de cada chave (`donosDasChaves`), e
// trata "nao consegui ler" como motivo pra nao subir nada.
function caminhoDoAnexo(chave, ext) {
  return `${String(PREFIXO).replace(/\/+$/, "")}/${chave}.${ext}`;
}

async function baixar(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) {
    await drenar(r);
    throw new Error(`download HTTP ${r.status}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return buf;
}

function bytesLocais(item) {
  if (!PASTA_ARQUIVOS) return null;
  // o nome na origem primeiro (e o que o coletor guardaria), depois o nome
  // "humano" — nunca uma busca difusa: arquivo errado com nome parecido seria o
  // material errado indo pro cliente
  for (const nome of [item.arquivo, item.nome].filter(Boolean)) {
    const p = path.join(PASTA_ARQUIVOS, nome);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

const cabecalhos = () => ({
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
  "Accept-Profile": SCHEMA,
  "Content-Profile": SCHEMA,
});

/**
 * UPSERT por (origem_ferramenta, origem_id) — a idempotencia deste passo.
 *
 * O indice e TOTAL de proposito na 0024 (indice PARCIAL nao serve de destino de
 * `on_conflict`: o PostgREST devolve 42P10). Rodar duas vezes atualiza a mesma
 * linha em vez de duplicar o acervo.
 *
 * 23505 pode acontecer mesmo assim, por OUTRA restricao: `uq_anexos_chave`. Isso
 * significa que a chave ja existe no painel apontando pra outro item (alguem subiu
 * pela tela com o mesmo nome). Nesse caso a linha NAO e sobrescrita — vira
 * pendencia com nome, como no importador de intencoes.
 */
async function gravarLinha(linha) {
  const alvo = `${URL_BASE}/rest/v1/anexos?on_conflict=origem_ferramenta,origem_id`;
  const r = await fetch(alvo, {
    method: "POST",
    headers: { ...cabecalhos(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([linha]),
  });
  if (r.ok) {
    await drenar(r);
    return { ok: true };
  }
  const txt = await r.text();
  if (/23505|duplicate key/i.test(txt)) {
    return { ok: false, conflito: true, erro: `a chave "${linha.chave}" ja existe no painel apontando pra outro item` };
  }
  return { ok: false, erro: `HTTP ${r.status} ${txt.slice(0, 200)}` };
}

/**
 * Teto da leitura das chaves do destino. 3.287 anexos em 33 contas medidas (153 na
 * maior) — o teto e mais de 100x a maior. Ele nao esta aqui pra caber na memoria e
 * sim pra dar um NUMERO a "li tudo": acima dele o passo prefere abortar a supor.
 */
const TETO_CHAVES = 20000;

/**
 * QUEM E O DONO DE CADA CHAVE QUE JA EXISTE NO PAINEL — lido UMA vez, antes de
 * qualquer upload.
 *
 * Existe porque o caminho do objeto e o MESMO do painel (`biblioteca/<chave>.<ext>`)
 * e a subida e upsert: sem esta leitura, reimportar numa instalacao onde alguem
 * ja subiu aquela chave pela tela SOBRESCREVIA o arquivo vivo — e so depois o
 * insert falhava com 23505 e virava a pendencia `chave_ja_existe_no_painel`. A
 * linha nao era sobrescrita; o arquivo era, e nenhum relatorio dizia isso.
 *
 * LEITURA CORTADA E LEITURA ILEGIVEL, e isto foi o achado da re-revisao: a versao
 * anterior pedia `&limit=100000` numa requisicao so e confiava no que voltasse. O
 * PostgREST honra o `db-max-rows` DO SERVIDOR — a resposta vem cortada em silencio,
 * com 200 e sem erro nenhum. As chaves que ficaram de fora liam como "livre" e o
 * objeto vivo era sobrescrito: exatamente o estado que esta funcao existe pra
 * impedir, tendo como unico sinal o 23505 tardio do insert.
 *
 * Entao a leitura tem que se PROVAR completa, pelo idioma que ja existe no repo
 * (`listarAnexos` em lib/anexos-db.ts le `limite + 1` e devolve `truncado`): pede
 * `TETO_CHAVES + 1` E pede a CONTAGEM (`Prefer: count=exact`), e so aceita quando o
 * total que o destino declara no `Content-Range` bate com o que chegou. Destino que
 * nao declara total = nao da pra provar = trata como cortada.
 *
 * Devolve `{ ok: false, motivo, detalhe }` quando nao deu pra ler OU quando a
 * leitura veio cortada. Quem chama trata os dois como "nao sei", nunca como "esta
 * livre".
 */
async function donosDasChaves() {
  const alvo = `${URL_BASE}/rest/v1/anexos?select=chave,origem_ferramenta,origem_id&limit=${TETO_CHAVES + 1}`;
  const ilegivel = (detalhe) => ({ ok: false, motivo: "chaves_do_painel_ilegiveis", detalhe });
  const cortada = (detalhe) => ({ ok: false, motivo: "chaves_do_painel_truncadas", detalhe });
  try {
    const r = await fetch(alvo, { headers: { ...cabecalhos(), Prefer: "count=exact" } });
    if (!r.ok) {
      await drenar(r);
      return ilegivel(`o destino respondeu HTTP ${r.status} ao listar as chaves que ja existem`);
    }
    // o cabecalho e lido ANTES do corpo de proposito: `.json()` consome a resposta
    const faixa = r.headers.get("content-range") || "";
    const linhas = await r.json();
    if (!Array.isArray(linhas)) return ilegivel("a lista de chaves nao veio como lista");
    const declarado = /\/(\d+)\s*$/.exec(faixa);
    if (!declarado) {
      return cortada(
        `o destino nao disse quantas chaves existem (Content-Range: ${faixa || "ausente"}), entao nao da pra ` +
          `provar que a leitura veio inteira — e leitura cortada le chave OCUPADA como livre`
      );
    }
    const total = Number(declarado[1]);
    if (total > linhas.length) {
      return cortada(
        `o destino declara ${total} chave(s) e a resposta trouxe ${linhas.length}: a leitura foi CORTADA ` +
          `(o teto de linhas e do servidor, db-max-rows). As chaves que faltaram leriam como livres`
      );
    }
    if (linhas.length > TETO_CHAVES) {
      return cortada(`o acervo do destino passa do teto de ${TETO_CHAVES} chaves que este passo confere de uma vez`);
    }
    const m = new Map();
    for (const l of linhas) {
      if (l && typeof l.chave === "string") {
        m.set(l.chave, { origem_ferramenta: l.origem_ferramenta ?? null, origem_id: l.origem_id ?? null });
      }
    }
    return { ok: true, donos: m };
  } catch (e) {
    return ilegivel(`nao deu pra falar com o destino: ${String(e.message).slice(0, 160)}`);
  }
}

// ─── RELATORIO ───────────────────────────────────────────────────────────────
const rel = {
  gerado_em: new Date().toISOString(),
  pasta: PASTA,
  origem: ORIGEM,
  bucket: DESTINO_LOCAL ? `(local de mentira: ${DESTINO_LOCAL})` : BUCKET,
  prefixo: PREFIXO,
  modo: DRY ? "inventario (default)" : DESTINO_LOCAL ? "prova em armazenamento local" : "importacao",
  destino_host: URL_BASE
    ? (() => {
        try {
          return new URL(URL_BASE).host;
        } catch {
          return "(url invalida)";
        }
      })()
    : null,
  grava_banco: !DRY && !SEM_BANCO && !!URL_BASE && !!KEY,
  catalogo: { arquivo: null, capturados: 0, total_na_origem: null, parcial: false, pagina: 0, paginas: 0 },
  inventario: { por_mime: {}, bytes_declarados: 0, com_etiqueta: 0, com_descricao: 0 },
  resultado: { subidos: 0, gravados: 0, pulados: 0, falharam: 0, reusados: 0 },
  motivos: {},
  chaves: {},
  falhas: [],
  pendencias: [],
};
const pend = (tema, detalhe) => rel.pendencias.push({ tema, detalhe });
const motivo = (m) => (rel.motivos[m] = (rel.motivos[m] || 0) + 1);

// ─── EXECUCAO ────────────────────────────────────────────────────────────────
log(`=== BIBLIOTECA DE ANEXOS — ${rel.modo}`);
log(`origem: ${PASTA}`);
if (DESTINO_LOCAL) log(`destino: pasta LOCAL ${DESTINO_LOCAL} (armazenamento de mentira, declarado)`);
else if (!DRY) log(`destino: ${rel.destino_host} · bucket ${BUCKET} · prefixo ${PREFIXO}/`);

const arqCatalogo = acharCatalogo(PASTA);
if (!arqCatalogo) {
  console.error(
    `o backup nao tem config/attachments_search.json — sem o catalogo nao existe biblioteca a importar.\n` +
      `(o inventario de ${path.join(PASTA, "config")} e o que o coletor guardou da tela de anexos)`
  );
  process.exit(2);
}
const inv = inventarioDeAnexos(lerJson(arqCatalogo, {}));
rel.catalogo = {
  arquivo: arqCatalogo,
  capturados: inv.capturados,
  total_na_origem: inv.total_na_origem,
  parcial: inv.total_na_origem !== null && inv.capturados < inv.total_na_origem,
  pagina: inv.pagina,
  paginas: inv.paginas,
};
for (const it of inv.itens) {
  const mm = it.mime || "(sem mime)";
  rel.inventario.por_mime[mm] = (rel.inventario.por_mime[mm] || 0) + 1;
  rel.inventario.bytes_declarados += it.bytes || 0;
  if (it.etiquetas.length) rel.inventario.com_etiqueta++;
  if (it.descricao) rel.inventario.com_descricao++;
}

log(
  `catalogo: ${inv.capturados} anexo(s) capturado(s)` +
    (rel.catalogo.parcial ? ` de ${inv.total_na_origem} que a origem declara (PARCIAL, pagina ${inv.pagina} de ${inv.paginas})` : "") +
    ` · ${(rel.inventario.bytes_declarados / 1e6).toFixed(1)} MB declarados`
);

if (rel.catalogo.parcial) {
  pend(
    "catalogo parcial",
    `o backup guardou ${inv.capturados} de ${inv.total_na_origem} anexos que a origem declara (pagina ${inv.pagina} de ${inv.paginas}). ` +
      `Os que faltam NAO estao aqui pra importar: pedir as demais paginas ao coletor, ou subir o material pela tela ` +
      `da biblioteca. Fluxo que referencia anexo fora desta pagina continua saindo como ressalva na conversao.`
  );
}

const fila = AMOSTRA ? inv.itens.slice(0, AMOSTRA) : inv.itens;
const mapa = {};
const linhas = [];

if (DRY) {
  for (const it of fila) {
    if (it.motivo) {
      rel.resultado.pulados++;
      motivo(it.motivo.slice(0, 60));
      continue;
    }
    mapa[it.origem_id] = { chave: it.chave, nome: it.nome, arquivo: it.arquivo, mime: it.mime };
  }
  pend(
    "inventario",
    `sem --valendo nada foi baixado, subido ou gravado: ${fila.length} item(ns) lidos, ` +
      `${Object.keys(mapa).length} com chave montada e ${rel.resultado.pulados} fora (motivos no relatorio).`
  );
} else {
  // QUEM JA OCUPA CADA CHAVE, antes de encostar no Storage. So faz sentido quando
  // existe painel do outro lado: com --sem-banco ou --destino-local nao ha linha
  // pra colidir, e o objeto vai pra um lugar de mentira.
  let donos = null;
  let abortado = false;
  const CONFERE_CHAVES = !SEM_BANCO && !DESTINO_LOCAL && !!URL_BASE && !!KEY;
  if (CONFERE_CHAVES) {
    const leitura = await donosDasChaves();
    if (leitura.ok) donos = leitura.donos;
    else {
      // FAIL-CLOSED: "nao consegui ler" nao e "esta livre" — e "li so um pedaco"
      // tambem nao. Subir aqui reescreveria, em silencio, o arquivo que N fluxos
      // mandam pro cliente.
      rel.resultado.falharam++;
      motivo(leitura.motivo);
      rel.falhas.push({ origem_id: null, nome: null, motivo: leitura.detalhe });
      pend(
        "chaves_nao_conferidas",
        `nao consegui conferir as chaves que ja existem no painel (${leitura.detalhe}), entao NADA foi subido ` +
          "nem gravado: sem essa leitura INTEIRA, uma chave repetida sobrescreveria o arquivo que os fluxos " +
          "ja mandam pro cliente. Confira a conexao com o banco (e o teto de linhas do PostgREST) e rode de novo."
      );
      abortado = true;
    }
  }

  // fila vazia quando a conferencia de chaves abortou: o relatorio e o exit 1 saem
  // pelo caminho normal la embaixo, sem nada ter sido subido.
  const paraProcessar = abortado ? [] : fila;
  log(`processando ${paraProcessar.length} anexo(s)${AMOSTRA ? ` (--amostra ${AMOSTRA})` : ""}`);
  for (const it of paraProcessar) {
    if (it.motivo) {
      rel.resultado.pulados++;
      motivo(it.motivo.slice(0, 60));
      rel.falhas.push({ origem_id: it.origem_id, nome: it.nome, motivo: it.motivo });
      continue;
    }
    if ((it.bytes || 0) > TETO) {
      rel.resultado.pulados++;
      motivo("acima_do_teto");
      rel.falhas.push({ origem_id: it.origem_id, nome: it.nome, motivo: `acima do teto de ${TETO_MB} MB` });
      continue;
    }

    // 1) A CHAVE JA E DE ALGUEM? Antes do download e antes do upload.
    //
    // Reimportar o MESMO item (mesma origem + mesmo id) reescreve o mesmo objeto
    // de proposito — e a idempotencia do passo. O que NAO pode e escrever por
    // cima da chave de OUTRO item: o arquivo trocaria embaixo dos fluxos que ja
    // o referenciam, e so o insert reclamaria depois, tarde demais.
    if (donos) {
      const de = donoDaChave(donos.get(it.chave), { origem: ORIGEM, origem_id: it.origem_id });
      if (de === "de_outro") {
        rel.resultado.pulados++;
        motivo("chave_ja_existe_no_painel");
        rel.falhas.push({
          origem_id: it.origem_id,
          nome: it.nome,
          motivo: `a chave "${it.chave}" ja existe no painel apontando pra outro item — nada foi subido nem gravado`,
        });
        continue;
      }
    }

    // 2) BYTES: copia local primeiro, download so se preciso.
    let corpo = null;
    const local = bytesLocais(it);
    try {
      if (local) {
        const tam = fs.statSync(local).size;
        if (tam > TETO) {
          rel.resultado.pulados++;
          motivo("acima_do_teto");
          rel.falhas.push({ origem_id: it.origem_id, nome: it.nome, motivo: `acima do teto (${tam} bytes)` });
          continue;
        }
        corpo = fs.readFileSync(local);
      } else if (SEM_REDE) {
        rel.resultado.pulados++;
        motivo("sem_copia_local_e_sem_rede");
        rel.falhas.push({ origem_id: it.origem_id, nome: it.nome, motivo: "sem copia local e --sem-rede" });
        continue;
      } else {
        corpo = await baixar(it.url);
        if (corpo.length > TETO) {
          rel.resultado.pulados++;
          motivo("acima_do_teto");
          rel.falhas.push({ origem_id: it.origem_id, nome: it.nome, motivo: `acima do teto (${corpo.length} bytes)` });
          continue;
        }
      }
    } catch (e) {
      rel.resultado.falharam++;
      motivo("download_falhou");
      rel.falhas.push({ origem_id: it.origem_id, nome: it.nome, motivo: String(e.message).slice(0, 200) });
      continue;
    }

    // 2b) OS BYTES DESMENTEM O TIPO DECLARADO?
    //
    // A origem declara o mime; ela pode declarar errado, e o destino e um bucket
    // PUBLICO cuja URL vai pro WhatsApp do cliente. `<svg>`/`<html>` carregam
    // script, entao a tela ja os recusa pelos BYTES — aqui vale a mesma regra, e
    // agora ela vale porque os bytes ESTAO na mao (o `corpo` acima), nao depois.
    if (marcacaoNoInicio(corpo)) {
      rel.resultado.pulados++;
      motivo("bytes_de_marcacao");
      rel.falhas.push({
        origem_id: it.origem_id,
        nome: it.nome,
        motivo: `os bytes comecam com marcacao (svg/html/xml) apesar do tipo declarado "${it.mime || "sem mime"}" — recusado no armazenamento publico`,
      });
      continue;
    }
    // 3) SOBE. O caminho e o mesmo do painel, entao repetir a rodada sobrescreve
    //    o MESMO objeto em vez de duplicar o acervo.
    const ext = extensaoDe(it.arquivo || it.url, it.mime);
    const caminho = caminhoDoAnexo(it.chave, ext);
    let urlNova = null;
    try {
      urlNova = DESTINO_LOCAL
        ? subirParaLocal({ destinoLocal: DESTINO_LOCAL, urlPublicaBase: URL_PUBLICA_BASE, caminho, corpo })
        : await subirParaStorage({
            urlBase: URL_BASE,
            key: KEY,
            bucket: BUCKET,
            schema: SCHEMA,
            caminho,
            corpo,
            mime: it.mime || "application/octet-stream",
          });
      rel.resultado.subidos++;
    } catch (e) {
      rel.resultado.falharam++;
      motivo("upload_falhou");
      rel.falhas.push({ origem_id: it.origem_id, nome: it.nome, motivo: String(e.message).slice(0, 200) });
      continue;
    }

    mapa[it.origem_id] = { chave: it.chave, nome: it.nome, arquivo: it.arquivo, mime: it.mime, url: urlNova };

    // 4) A LINHA — com o endereco NOVO. Nunca o do fornecedor.
    //
    // Ela e montada SEMPRE, mesmo com --sem-banco: e ela que o --dump escreve, e
    // foi assim que a prova passou a alcancar o campo `url`. Antes a linha so
    // existia dentro do ramo que grava, e uma mutacao que devolvia o endereco do
    // fornecedor pro banco passava verde na bateria (medido).
    {
      const linha = {
        chave: it.chave,
        nome: it.nome.slice(0, 120),
        descricao: it.descricao ? it.descricao.slice(0, 1000) : null,
        etiquetas: it.etiquetas,
        arquivo_nome: (it.arquivo || `${it.chave}.${ext}`).slice(0, 120),
        mime: it.mime || "application/octet-stream",
        bytes: corpo.length,
        url: urlNova,
        origem_ferramenta: ORIGEM,
        origem_id: it.origem_id,
        criado_por_nome: `importacao ${ORIGEM}`,
      };
      linhas.push(linha);
      if (!SEM_BANCO) {
        const g = await gravarLinha(linha);
        if (g.ok) rel.resultado.gravados++;
        else {
          rel.resultado.falharam++;
          motivo(g.conflito ? "chave_ja_existe_no_painel" : "insert_falhou");
          rel.falhas.push({ origem_id: it.origem_id, nome: it.nome, motivo: g.erro });
        }
      }
    }
  }
}

if (DUMP) {
  fs.mkdirSync(path.dirname(path.resolve(DUMP)), { recursive: true });
  fs.writeFileSync(DUMP, JSON.stringify({ anexos: linhas }, null, 2));
  log(`linhas gravadas em ${DUMP}`);
}

// ─── MAPA id -> chave (o que faz o conversor de fluxos emitir o passo) ───────
rel.chaves = { itens: Object.keys(mapa).length };
const arqMapa = path.join(TRABALHO, "anexos-chaves.json");
fs.writeFileSync(
  arqMapa,
  JSON.stringify(
    {
      gerado_em: rel.gerado_em,
      origem: ORIGEM,
      modo: rel.modo,
      // o conversor precisa saber se o mapa esta INCOMPLETO: com catalogo parcial,
      // id que nao esta aqui NAO significa "nao existe" — significa "nao capturado"
      parcial: rel.catalogo.parcial,
      capturados: rel.catalogo.capturados,
      total_na_origem: rel.catalogo.total_na_origem,
      anexos: mapa,
    },
    null,
    2
  )
);
// COPIA NA PASTA DO BACKUP: e ali que o conversor de dialogos procura sozinho
// (`carregarAnexosChaves`), do mesmo jeito que ele acha `config/chatlist_tags.json`.
// Sem esta copia, quem roda a conversao teria que lembrar de passar um caminho.
const arqMapaBackup = path.join(PASTA, "config", "anexos-chaves.json");
try {
  fs.mkdirSync(path.dirname(arqMapaBackup), { recursive: true });
  fs.copyFileSync(arqMapa, arqMapaBackup);
  rel.chaves.copia_no_backup = arqMapaBackup;
} catch (e) {
  pend("mapa", `nao consegui copiar o mapa pra ${arqMapaBackup} (${String(e.message).slice(0, 120)}) — passe o arquivo ao conversor a mao.`);
}
log(`mapa id->chave: ${rel.chaves.itens} item(ns) em ${arqMapa}`);

if (!DRY && rel.resultado.gravados) {
  pend(
    "conversao dos fluxos",
    `agora rode a conversao dos dialogos: com este mapa presente, a acao ANEXAR passa a virar o passo ` +
      `anexar_biblioteca em vez de ressalva. Anexo fora do mapa continua saindo como ressalva (nunca chute).`
  );
}
if (!DRY && !SEM_BANCO && !rel.resultado.gravados && rel.resultado.subidos) {
  pend("banco", "arquivos subiram mas nenhuma linha foi gravada — conferir se a migration 0024 rodou nesta instalacao.");
}

const arqRel = path.join(TRABALHO, `anexos-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`);
fs.writeFileSync(arqRel, JSON.stringify(rel, null, 2));
log(
  `resultado: ${rel.resultado.subidos} subido(s), ${rel.resultado.gravados} gravado(s), ` +
    `${rel.resultado.pulados} pulado(s), ${rel.resultado.falharam} com falha`
);
log(`relatorio em ${arqRel}`);
for (const p of rel.pendencias) log(`pendencia [${p.tema}] ${p.detalhe}`);

// exit 1 quando algo falhou: quem chama em script quer saber sem ler o json
process.exitCode = rel.resultado.falharam ? 1 : 0;
