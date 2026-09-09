#!/usr/bin/env node
// Re-hospedar a midia das mensagens e reescrever os enderecos.
//
// PASSO SEPARADO do importador de conversas, e de proposito: as URLs de midia do
// ChatGuru apontam pro S3 do fornecedor e **morrem com a conta**. Toda mensagem
// com arquivo precisa apontar pro arquivo re-hospedado na instalacao do cliente,
// e essa traducao e parte da migracao — nao um passo manual depois.
//
//   # 1) inventario: quanto tem, de que tipo, quanto pesa (NAO baixa, NAO sobe)
//   node scripts/importar/midia.mjs --pasta <backup>
//
//   # 2) prova de ponta a ponta contra armazenamento LOCAL DE MENTIRA
//   node scripts/importar/midia.mjs --pasta <backup> --valendo --amostra 20 \
//     --destino-local /tmp/mock-storage --url-publica-base http://localhost/mock --sem-banco
//
//   # 3) valendo (storage e banco do CLIENTE, vindos de env)
//   export MSG_SUPABASE_URL=... MSG_SUPABASE_SERVICE_KEY=... MSG_STORAGE_BUCKET=midia-mensagens
//   node scripts/importar/midia.mjs --pasta <backup> --valendo
//
// O DEFAULT E O INVENTARIO. Baixar, subir e reescrever endereco exige `--valendo`
// escrito na mao — mesma regra do lote.mjs. Esquecer uma flag nao pode ser o
// caminho pra mover 345 GB e alterar o banco de um cliente.
//
// COMO A RETOMADA FUNCIONA (o requisito que nao e opcional):
//   - o estado vive em `rehospedagem-estado.json` — o MESMO formato que o robo de
//     resgate ja deixou nos backups ({subidos: {urlAntiga: urlNova}, falhas}).
//     Ele e LIDO da pasta do backup na partida, entao arquivo ja re-hospedado
//     antes nao e baixado nem subido de novo (na conta da Expert sao 71.437 de
//     71.483 arquivos ja prontos);
//   - o caminho no destino e DERIVADO da URL de origem (sha256), nunca sorteado:
//     rodar duas vezes escreve no mesmo objeto em vez de duplicar o acervo;
//   - falha de um arquivo nao derruba a rodada: vai pra lista de falhas com o
//     motivo, e a proxima passada tenta so essas.
//
// O QUE ESTE PASSO NAO FAZ: nao cria bucket, nao cria tabela, nao apaga arquivo
// na origem, e nao inventa endereco. Arquivo que nao subiu mantem o endereco
// antigo (que e o registro do que existia ali) e aparece no relatorio de falhas.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { urlDoArquivo } from "./referencias.mjs";
// As pecas de re-hospedagem moram em rehospedagem.mjs desde a Frente W: o passo
// da biblioteca de anexos precisa das MESMAS (caminho derivado, x-upsert, corpo
// drenado, extensao da URL antes do mime), e duas copias divergem na primeira
// correcao. Comportamento daqui inalterado — prova-midia.mjs roda a CLI de
// verdade e continua verde.
import {
  cabecalhosRest,
  caminhoDerivado,
  drenar,
  extensaoDe,
  nomeLocalEsperado,
  subirParaLocal as subirParaLocalCompartilhado,
  subirParaStorage as subirParaStorageCompartilhado,
} from "./rehospedagem.mjs";

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
const BUCKET = arg("bucket", process.env.MSG_STORAGE_BUCKET || "midia-mensagens");
// O DEFAULT E NAO FAZER NADA. Antes bastava esquecer `--dry` pra este comando
// comecar a baixar e subir 345 GB e a reescrever endereco no banco do cliente —
// o modo destrutivo era o que saia de um typo. Invertido pra seguir o mesmo padrao
// do lote.mjs: gravar exige `--valendo`, escrito na mao, sempre.
const VALENDO = flag("valendo");
const DRY = !VALENDO;
const SEM_BANCO = flag("sem-banco");
const DESTINO_LOCAL = arg("destino-local");
const URL_PUBLICA_BASE = arg("url-publica-base");
const AMOSTRA = Number(arg("amostra", 0)) || 0;
const TETO_MB = Number(arg("teto-mb", 25)) || 25;
const TETO = TETO_MB * 1024 * 1024;
const TRABALHO = arg("trabalho", PASTA ? path.join(PASTA, ".importacao") : "");
const RECOMECAR = flag("recomecar");
const SEM_REDE = flag("sem-rede");

const USO = `uso: node scripts/importar/midia.mjs --pasta <backup> [--valendo]

  --pasta <dir>             pasta do backup (obrigatoria)
  (sem --valendo)           DEFAULT: SO INVENTARIA — conta, tamanho e tipos. Nao baixa, nao sobe, nao grava.
  --valendo                 baixa, sobe e reescreve endereco. E o unico jeito de fazer efeito.
  --dry                     explicita o default (aceito por compatibilidade; nao pode vir com --valendo)
  --amostra <n>             processa so os N primeiros arquivos (prova curta)
  --teto-mb <n>             arquivo maior que isso e pulado e reportado (default: 25)
  --sem-rede                proibe download: usa so o que ja esta na pasta media/ do backup
  --canal <id>              canal das mensagens (default: central)
  --schema <nome>           schema no banco (default: mensageria)
  --bucket <nome>           bucket do Storage (default: env MSG_STORAGE_BUCKET ou midia-mensagens)
  --url <url> --key <k>     projeto do CLIENTE (ou envs MSG_SUPABASE_URL / MSG_SUPABASE_SERVICE_KEY)
  --sem-banco               sobe os arquivos mas NAO reescreve endereco no banco
  --destino-local <dir>     armazenamento LOCAL DE MENTIRA em vez do Storage (para prova)
  --url-publica-base <url>  prefixo publico do destino local (obrigatorio com --destino-local)
  --trabalho <dir>          onde ficam estado e relatorio (default: <pasta>/.importacao)
  --recomecar               ignora o estado e reprocessa tudo (o caminho derivado segura)`;

if (!PASTA || flag("help") || flag("ajuda")) {
  console.log(USO);
  process.exit(PASTA ? 0 : 2);
}
if (!fs.existsSync(PASTA)) {
  console.error(`pasta nao encontrada: ${PASTA}`);
  process.exit(2);
}
if (flag("dry") && VALENDO) {
  console.error("--dry e --valendo se contradizem: escolha um. (sem nenhum dos dois, o default e --dry)");
  process.exit(2);
}
if (DESTINO_LOCAL && !URL_PUBLICA_BASE) {
  console.error("--destino-local exige --url-publica-base (o endereco que iria pro banco tem que ser explicito).");
  process.exit(2);
}
if (!DRY && !DESTINO_LOCAL && (!URL_BASE || !KEY)) {
  console.error(
    "sem --dry e sem --destino-local e obrigatorio informar --url e --key (ou as envs equivalentes).\n" +
      "O destino NUNCA e embutido no codigo: ele vem do ambiente de quem roda.\n"
  );
  process.exit(2);
}
if (!DRY && !SEM_BANCO && !DESTINO_LOCAL && (!URL_BASE || !KEY)) {
  console.error("pra reescrever o endereco no banco preciso de --url e --key.");
  process.exit(2);
}

const T =
  CANAL === "central"
    ? { mensagens: "mensagens" }
    : CANAL === "apioficial"
      ? { mensagens: "mensagens_apioficial" }
      : { mensagens: `mensagens_${CANAL}` };

const hora = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(`[${hora()}]`, ...a);
const lerJson = (p, padrao = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return padrao;
  }
};

fs.mkdirSync(TRABALHO, { recursive: true });

// ─── CAMINHO NO DESTINO, DERIVADO DA URL ─────────────────────────────────────
// Sorteio (uuid, timestamp) faria a segunda passada subir tudo de novo com outro
// nome — 345 GB duplicados. O caminho sai de um hash da URL de origem: mesma
// origem, mesmo destino, sempre.
function chaveDestino(url, mime, canal = CANAL) {
  return caminhoDerivado(url, mime, canal);
}

// ─── ESTADO (retomada + idempotencia) ────────────────────────────────────────
// Formato identico ao que o resgate ja deixou no backup, pra que o trabalho ja
// feito seja aproveitado em vez de refeito.
const ARQ_ESTADO = path.join(TRABALHO, "rehospedagem-estado.json");
const ESTADO_HERDADO = path.join(PASTA, "rehospedagem-estado.json");
// TRILHA DE APENDICE (uma linha por arquivo subido, gravada NA HORA). Existe por
// um motivo aritmetico: o acervo medido chega a 942 mil arquivos, o snapshot
// completo em JSON cresce com o total ja feito, e reescrever esse arquivo inteiro
// a cada 200 uploads e trabalho quadratico — no fim da rodada o checkpoint custa
// mais que o upload. Pior: entre dois snapshots, uma parada (Ctrl+C, queda de
// rede, fim de sessao) descartava ate 199 uploads que JA estavam no storage, e a
// rodada seguinte os subia de novo. Agora o snapshot e por TEMPO (barato e raro) e
// o que garante a retomada exata e o apendice, que nunca reescreve nada.
const ARQ_TRILHA = path.join(TRABALHO, "rehospedagem-subidos.ndjson");

function lerEstado() {
  const vazio = { subidos: {}, falhas: {}, ignorados: {} };
  if (RECOMECAR) return vazio;
  const meu = lerJson(ARQ_ESTADO, null);
  const base = meu
    ? { ...vazio, ...meu, subidos: meu.subidos || {}, falhas: meu.falhas || {}, ignorados: meu.ignorados || {} }
    : (() => {
        const herdado = lerJson(ESTADO_HERDADO, null);
        if (herdado?.subidos) {
          log(`estado herdado do backup: ${Object.keys(herdado.subidos).length} arquivo(s) ja re-hospedados antes`);
          return { ...vazio, subidos: herdado.subidos, falhas: herdado.falhas || {} };
        }
        return vazio;
      })();
  // a trilha VENCE o snapshot: ela e mais nova por construcao
  if (fs.existsSync(ARQ_TRILHA)) {
    let recuperados = 0;
    for (const linha of fs.readFileSync(ARQ_TRILHA, "utf8").split("\n")) {
      if (!linha.trim()) continue;
      try {
        const { de, para } = JSON.parse(linha);
        if (de && para && !base.subidos[de]) {
          base.subidos[de] = para;
          recuperados++;
        }
      } catch {
        // linha cortada no meio por uma parada seca: e o unico dano possivel
        // deste formato, e ele custa UM arquivo re-enviado (o caminho e derivado
        // da URL, entao re-enviar sobrescreve o mesmo objeto).
      }
    }
    if (recuperados) log(`trilha de apendice: ${recuperados} upload(s) recuperados que o snapshot nao tinha`);
  }
  return base;
}
const estado = lerEstado();
if (RECOMECAR && fs.existsSync(ARQ_TRILHA)) fs.rmSync(ARQ_TRILHA);

// grava UMA linha, na hora do sucesso: custo constante, nada a reescrever
let trilhaFalhou = null;
const anotarSubido = (de, para) => {
  if (DRY) return;
  try {
    fs.appendFileSync(ARQ_TRILHA, `${JSON.stringify({ de, para })}\n`);
  } catch (e) {
    // trilha e rede de seguranca, nao pre-condicao: perder o apendice custa
    // re-upload, e derrubar a rodada por causa dele custa a rodada inteira.
    trilhaFalhou = String(e.message).slice(0, 160);
  }
};

let ultimoSnapshot = 0;
const INTERVALO_SNAPSHOT_MS = 15000;
const salvarEstado = (forcar = false) => {
  if (DRY) return;
  if (!forcar && Date.now() - ultimoSnapshot < INTERVALO_SNAPSHOT_MS) return;
  ultimoSnapshot = Date.now();
  const tmp = `${ARQ_ESTADO}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(estado));
  fs.renameSync(tmp, ARQ_ESTADO);
};

// ─── INVENTARIO DA MIDIA ─────────────────────────────────────────────────────
// Duas fontes, na ordem: `media-lista.json` (o resgate ja normalizou tipo, mime e
// conversa) e, quando ele nao existe, uma passada pelos arquivos de mensagem.
//
// `urlDoArquivo` vem de `referencias.mjs` de proposito: e a MESMA funcao que o
// importador de conversas usa pra gravar `media_url`. Aqui a reescrita procura a
// linha por `media_url=eq.<url>`, entao uma copia local que divergisse um dia
// (barra no fim, fallback de path_absolute) subiria o arquivo e nunca acharia a
// mensagem — sem erro em lugar nenhum.

const TIPO_POR_MIME = (mime) => {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return m.includes("webp") ? "sticker" : "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "document";
};

function inventariar(pasta) {
  const porUrl = new Map();
  const lista = lerJson(path.join(pasta, "media-lista.json"), null);
  if (Array.isArray(lista) && lista.length) {
    for (const m of lista) {
      if (!m?.media_url || porUrl.has(m.media_url)) continue;
      porUrl.set(m.media_url, {
        url: m.media_url,
        mime: m.media_mime || null,
        tipo: m.tipo || TIPO_POR_MIME(m.media_mime),
        chat_id: m.chat_id || null,
        bytes: null,
      });
    }
  } else {
    const dir = path.join(pasta, "messages");
    const arquivos = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
    for (const f of arquivos) {
      const bruto = lerJson(path.join(dir, f), null);
      if (!bruto) continue;
      for (const item of bruto.messages_and_notes || []) {
        const a = item?.m?.file;
        if (!a) continue;
        const url = urlDoArquivo(a);
        if (!url || porUrl.has(url)) continue;
        porUrl.set(url, {
          url,
          mime: a.mime || null,
          tipo: TIPO_POR_MIME(a.mime),
          chat_id: bruto.chat_id || null,
          bytes: Number(a.size) > 0 ? Number(a.size) : null,
        });
      }
    }
  }
  // tamanho declarado pelo resgate (url -> bytes), quando existir
  const tamanhos = lerJson(path.join(pasta, "media-estado.json"), null);
  if (tamanhos && typeof tamanhos === "object") {
    for (const [u, b] of Object.entries(tamanhos)) {
      const it = porUrl.get(u);
      if (it && Number(b) > 0) it.bytes = Number(b);
    }
  }
  return [...porUrl.values()];
}

// ─── DESTINO ─────────────────────────────────────────────────────────────────
// Corpo de resposta nao lido segura o socket no undici, e aqui sao DUAS
// requisicoes por arquivo (upload + reescrita) vezes centenas de milhares de
// arquivos — `drenar` (rehospedagem.mjs) e o que impede o `process.exit` de
// abortar no fim de uma carga bem-sucedida. Ver o comentario do `process.exitCode`
// no fim do arquivo.

const cabecalhos = () => cabecalhosRest({ key: KEY, schema: SCHEMA });

async function subirParaStorage(chave, corpo, mime) {
  return subirParaStorageCompartilhado({
    urlBase: URL_BASE,
    key: KEY,
    bucket: BUCKET,
    schema: SCHEMA,
    caminho: chave,
    corpo,
    mime,
  });
}

function subirParaLocal(chave, corpo) {
  return subirParaLocalCompartilhado({
    destinoLocal: DESTINO_LOCAL,
    urlPublicaBase: URL_PUBLICA_BASE,
    caminho: chave,
    corpo,
  });
}

// PATCH por URL antiga: e o unico jeito de dar um endereco NOVO e DIFERENTE pra
// cada arquivo. Uma requisicao por arquivo — a mesma ordem de grandeza do upload.
async function reescreverEndereco(urlAntiga, urlNova) {
  const alvo = `${URL_BASE}/rest/v1/${T.mensagens}?media_url=eq.${encodeURIComponent(urlAntiga)}`;
  const r = await fetch(alvo, {
    method: "PATCH",
    headers: { ...cabecalhos(), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ media_url: urlNova }),
  });
  if (!r.ok) throw new Error(`${T.mensagens}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  await drenar(r);
}

// ─── RELATORIO ───────────────────────────────────────────────────────────────
const rel = {
  gerado_em: new Date().toISOString(),
  pasta: PASTA,
  canal: CANAL,
  bucket: DESTINO_LOCAL ? `(local de mentira: ${DESTINO_LOCAL})` : BUCKET,
  modo: DRY ? "inventario (--dry)" : DESTINO_LOCAL ? "prova em armazenamento local" : "re-hospedagem",
  destino_host: URL_BASE ? (() => { try { return new URL(URL_BASE).host; } catch { return "(url invalida)"; } })() : null,
  reescreve_banco: !DRY && !SEM_BANCO && !!URL_BASE && !!KEY,
  inventario: { arquivos: 0, bytes_declarados: 0, por_tipo: {}, por_mime: {}, sem_tamanho: 0 },
  ja_rehospedados_antes: Object.keys(estado.subidos).length,
  copia_local: { existe: 0, falta: 0 },
  resultado: { subidos: 0, reusados: 0, enderecos_reescritos: 0, pulados: 0, falharam: 0 },
  motivos: {},
  falhas: [],
  pendencias: [],
};
const pend = (tema, detalhe) => rel.pendencias.push({ tema, detalhe });
const motivo = (m) => (rel.motivos[m] = (rel.motivos[m] || 0) + 1);

// ─── EXECUCAO ────────────────────────────────────────────────────────────────
log(`=== RE-HOSPEDAGEM DE MIDIA — ${rel.modo}`);
log(`origem: ${PASTA}`);
if (DESTINO_LOCAL) log(`destino: pasta LOCAL ${DESTINO_LOCAL} (armazenamento de mentira, declarado)`);
else if (!DRY) log(`destino: ${rel.destino_host} · bucket ${BUCKET}`);

const todos = inventariar(PASTA);
for (const it of todos) {
  rel.inventario.arquivos++;
  rel.inventario.bytes_declarados += it.bytes || 0;
  if (!it.bytes) rel.inventario.sem_tamanho++;
  rel.inventario.por_tipo[it.tipo] = (rel.inventario.por_tipo[it.tipo] || 0) + 1;
  const mm = it.mime || "(sem mime)";
  rel.inventario.por_mime[mm] = (rel.inventario.por_mime[mm] || 0) + 1;
}
const dirMedia = path.join(PASTA, "media");
const temMedia = fs.existsSync(dirMedia);
for (const it of todos) {
  it.local = temMedia ? path.join(dirMedia, nomeLocalEsperado(it.url, it.tipo, it.mime)) : null;
  it.temLocal = !!(it.local && fs.existsSync(it.local));
  if (it.temLocal) rel.copia_local.existe++;
  else rel.copia_local.falta++;
}

log(
  `inventario: ${rel.inventario.arquivos} arquivo(s) · ${(rel.inventario.bytes_declarados / 1e9).toFixed(2)} GB (10^9 bytes) declarados · ` +
    `copia local presente em ${rel.copia_local.existe}`
);

if (DRY) {
  pend(
    "inventario",
    `--dry NAO baixou e NAO subiu nada: so contou. ${rel.inventario.arquivos} arquivo(s), ` +
      `${(rel.inventario.bytes_declarados / 1e9).toFixed(2)} GB (10^9 bytes) pelo tamanho declarado no backup ` +
      `(${rel.inventario.sem_tamanho} sem tamanho conhecido). ${rel.ja_rehospedados_antes} ja constam como ` +
      `re-hospedados no estado herdado.`
  );
} else {
  const fila = AMOSTRA ? todos.slice(0, AMOSTRA) : todos;
  log(`processando ${fila.length} arquivo(s)${AMOSTRA ? ` (--amostra ${AMOSTRA})` : ""}`);
  let feitos = 0;
  for (const it of fila) {
    feitos++;
    if (feitos % 200 === 0) log(`... ${feitos}/${fila.length}`);
    salvarEstado(); // por TEMPO (>=15s), nao por contagem — ver ARQ_TRILHA
    // 1) ja re-hospedado antes: reusa o endereco e nao toca em rede
    const jaTem = estado.subidos[it.url];
    let urlNova = jaTem || null;
    if (jaTem) {
      rel.resultado.reusados++;
      motivo("reusado_do_estado");
    } else {
      // 2) corpo do arquivo: copia local primeiro, download so se preciso
      let corpo = null;
      if (it.temLocal) {
        const tam = fs.statSync(it.local).size;
        if (tam > TETO) {
          rel.resultado.pulados++;
          motivo("acima_do_teto");
          estado.ignorados[it.url] = `acima do teto de ${TETO_MB} MB (${tam} bytes)`;
          continue;
        }
        corpo = fs.readFileSync(it.local);
      } else if (SEM_REDE) {
        rel.resultado.pulados++;
        motivo("sem_copia_local_e_sem_rede");
        continue;
      } else if ((it.bytes || 0) > TETO) {
        rel.resultado.pulados++;
        motivo("acima_do_teto");
        estado.ignorados[it.url] = `acima do teto de ${TETO_MB} MB (${it.bytes} bytes declarados)`;
        continue;
      } else {
        try {
          const r = await fetch(it.url);
          if (!r.ok) throw new Error(`origem HTTP ${r.status}`);
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > TETO) {
            rel.resultado.pulados++;
            motivo("acima_do_teto");
            estado.ignorados[it.url] = `acima do teto de ${TETO_MB} MB (${buf.length} bytes baixados)`;
            continue;
          }
          corpo = buf;
        } catch (e) {
          rel.resultado.falharam++;
          motivo("download_falhou");
          estado.falhas[it.url] = String(e.message).slice(0, 200);
          if (rel.falhas.length < 50) rel.falhas.push({ etapa: "download", motivo: String(e.message).slice(0, 200) });
          continue;
        }
      }

      // 3) sobe (storage do cliente, ou a pasta local declarada da prova)
      const chave = chaveDestino(it.url, it.mime);
      try {
        urlNova = DESTINO_LOCAL
          ? subirParaLocal(chave, corpo)
          : await subirParaStorage(chave, corpo, it.mime);
        estado.subidos[it.url] = urlNova;
        anotarSubido(it.url, urlNova);
        delete estado.falhas[it.url];
        rel.resultado.subidos++;
      } catch (e) {
        rel.resultado.falharam++;
        motivo("upload_falhou");
        estado.falhas[it.url] = String(e.message).slice(0, 200);
        if (rel.falhas.length < 50) rel.falhas.push({ etapa: "upload", motivo: String(e.message).slice(0, 200) });
        continue;
      }
    }

    // 4) reescreve o endereco na mensagem ja importada
    if (rel.reescreve_banco && urlNova) {
      try {
        await reescreverEndereco(it.url, urlNova);
        rel.resultado.enderecos_reescritos++;
        // A falha desta etapa e gravada em `estado.falhas` ("subiu mas nao foi
        // reescrito"), e SO aqui ela sai. Sem este delete, a lista de falhas nunca
        // esvaziava no caso mais comum de retomada — arquivo ja subido (`jaTem`,
        // que nem passa pelo delete do upload) cuja reescrita falhou antes. Efeito:
        // o relatorio da rodada seguinte acusava falha de um endereco que ACABOU de
        // ser reescrito, e a operacao ficava perseguindo defeito inexistente.
        delete estado.falhas[it.url];
      } catch (e) {
        rel.resultado.falharam++;
        motivo("reescrita_falhou");
        estado.falhas[it.url] = `endereco subiu mas nao foi reescrito: ${String(e.message).slice(0, 160)}`;
        if (rel.falhas.length < 50) rel.falhas.push({ etapa: "reescrita", motivo: String(e.message).slice(0, 200) });
      }
    }
  }
  salvarEstado(true);
  // TRILHA CUMPRIU O PAPEL: o snapshot forcado acima ja contem tudo que ela
  // guardava, entao ela pode ir a zero. Sem truncar, ela e ACUMULATIVA entre
  // rodadas — no acervo medido (969 mil arquivos) seriam ~190 MB relidos e
  // reparseados na partida de toda passada seguinte, pra recuperar exatamente
  // nada. Trunca DEPOIS do snapshot, nunca antes: a ordem e o que garante que
  // nenhum upload fique sem registro em nenhum instante.
  if (!trilhaFalhou && fs.existsSync(ARQ_TRILHA)) {
    try {
      fs.writeFileSync(ARQ_TRILHA, "");
    } catch {
      // trilha grande de sobra nao e erro: a proxima partida so le a mais.
    }
  }

  if (trilhaFalhou)
    pend(
      "trilha",
      `nao consegui gravar a trilha de apendice (${ARQ_TRILHA}): ${trilhaFalhou}. Os uploads valeram e o ` +
        `snapshot foi salvo; o que se perde e a retomada FINA — uma parada seca pode custar a re-subida dos ` +
        `arquivos feitos depois do ultimo snapshot (o caminho no destino e derivado da URL, entao re-subir ` +
        `sobrescreve o mesmo objeto e nao duplica nada).`
    );
  if (!rel.reescreve_banco)
    pend(
      "enderecos",
      `os arquivos foram para o destino, mas o endereco NAO foi reescrito no banco ` +
        `(${SEM_BANCO ? "--sem-banco" : "sem --url/--key"}). O mapa endereco antigo -> novo esta em ` +
        `${ARQ_ESTADO}: rodar de novo com --url e --key aplica a reescrita sem subir nada outra vez.`
    );
  if (rel.resultado.falharam)
    pend(
      "falhas",
      `${rel.resultado.falharam} arquivo(s) falharam e mantiveram o endereco antigo (que e o registro do que ` +
        `existia ali). Estao listados em ${ARQ_ESTADO} sob "falhas" — rodar de novo tenta so esses.`
    );
  if (rel.resultado.pulados)
    pend(
      "teto",
      `${rel.resultado.pulados} arquivo(s) foram pulados (acima do teto de ${TETO_MB} MB, ou sem copia local com ` +
        `--sem-rede). Ficam em "ignorados" no estado; pra trazer, subir o teto com --teto-mb.`
    );
}

// ─── SAIDA ───────────────────────────────────────────────────────────────────
const carimbo = rel.gerado_em.replace(/[:.]/g, "-");
const arqJson = path.join(TRABALHO, `midia-${carimbo}.json`);
const arqMd = arg("relatorio", path.join(TRABALHO, `midia-${carimbo}.md`));

const n = (v) => Number(v || 0).toLocaleString("pt-BR");
const L = [];
L.push(`# Re-hospedagem de midia — ${rel.modo}`);
L.push("");
L.push(`- **Gerado em:** ${rel.gerado_em.replace("T", " ").slice(0, 19)} UTC`);
L.push(`- **Origem:** \`${rel.pasta}\``);
L.push(`- **Destino:** ${DESTINO_LOCAL ? `pasta local \`${DESTINO_LOCAL}\` (armazenamento de mentira)` : DRY ? "nenhum (inventario)" : `\`${rel.destino_host}\` · bucket \`${BUCKET}\``}`);
L.push(`- **Reescreve endereco no banco:** ${rel.reescreve_banco ? `sim (\`${SCHEMA}.${T.mensagens}\`)` : "nao"}`);
L.push("");
L.push(`## Inventario`);
L.push("");
L.push(`| Item | Valor |`);
L.push(`| --- | ---: |`);
L.push(`| Arquivos distintos referenciados | ${n(rel.inventario.arquivos)} |`);
L.push(`| Tamanho declarado no backup | ${(rel.inventario.bytes_declarados / 1e9).toFixed(2)} GB (10^9 bytes) |`);
L.push(`| Sem tamanho conhecido | ${n(rel.inventario.sem_tamanho)} |`);
L.push(`| Com copia na pasta media/ do backup | ${n(rel.copia_local.existe)} |`);
L.push(`| Sem copia local (exigiriam download) | ${n(rel.copia_local.falta)} |`);
L.push(`| Ja re-hospedados antes (estado herdado) | ${n(rel.ja_rehospedados_antes)} |`);
L.push("");
L.push(`Por tipo: ${Object.entries(rel.inventario.por_tipo).sort((a, b) => b[1] - a[1]).map(([t, q]) => `${t} (${n(q)})`).join(" · ") || "—"}.`);
L.push("");
const mimes = Object.entries(rel.inventario.por_mime).sort((a, b) => b[1] - a[1]).slice(0, 15);
if (mimes.length) {
  L.push(`| Mime | Arquivos |`);
  L.push(`| --- | ---: |`);
  for (const [m, q] of mimes) L.push(`| \`${m}\` | ${n(q)} |`);
  L.push("");
}
if (!DRY) {
  L.push(`## Resultado`);
  L.push("");
  L.push(`| Item | Arquivos |`);
  L.push(`| --- | ---: |`);
  L.push(`| Subidos nesta passada | ${n(rel.resultado.subidos)} |`);
  L.push(`| Reusados do estado (nao subiram de novo) | ${n(rel.resultado.reusados)} |`);
  L.push(`| Enderecos reescritos na mensagem | ${n(rel.resultado.enderecos_reescritos)} |`);
  L.push(`| Pulados | ${n(rel.resultado.pulados)} |`);
  L.push(`| Falharam | ${n(rel.resultado.falharam)} |`);
  L.push("");
  const mot = Object.entries(rel.motivos);
  if (mot.length) {
    L.push(`Motivos: ${mot.map(([m, q]) => `${m} (${n(q)})`).join(" · ")}.`);
    L.push("");
  }
  if (rel.falhas.length) {
    L.push(`Amostra de falhas (ate 50):`);
    L.push("");
    for (const f of rel.falhas) L.push(`- \`${f.etapa}\`: ${f.motivo}`);
    L.push("");
  }
}
L.push(`## Pendencias`);
L.push("");
if (!rel.pendencias.length) L.push(`Nenhuma.`);
else for (const p of rel.pendencias) L.push(`- **${p.tema}:** ${p.detalhe}`);
L.push("");
L.push(`---`);
L.push("");
L.push(
  `Retomada: o estado fica em \`${ARQ_ESTADO}\` e o caminho no destino e derivado da URL de origem (sha256), ` +
    `entao rodar de novo continua de onde parou e nunca duplica o acervo.`
);

fs.writeFileSync(arqJson, JSON.stringify(rel, null, 2));
fs.writeFileSync(arqMd, L.join("\n") + "\n");

log(
  DRY
    ? `INVENTARIO: ${n(rel.inventario.arquivos)} arquivo(s) · ${(rel.inventario.bytes_declarados / 1e9).toFixed(2)} GB (10^9 bytes) declarados`
    : `FIM — ${n(rel.resultado.subidos)} subido(s) · ${n(rel.resultado.reusados)} reusado(s) · ` +
        `${n(rel.resultado.enderecos_reescritos)} endereco(s) reescrito(s) · ${n(rel.resultado.falharam)} falha(s)`
);
log(`relatorio: ${arqMd}`);
if (DRY) log("MODO DRY: nada foi baixado, subido ou gravado.");
// `process.exitCode`, NAO `process.exit()`: sao duas requisicoes por arquivo
// (upload + reescrita) vezes centenas de milhares de arquivos, e derrubar o
// processo com socket em keep-alive faz o Node abortar no Windows com `Assertion
// failed: !(handle->flags & UV_HANDLE_CLOSING), src\\win\\async.c` (exit
// 3221226505). Numa carga real de 345 GB isso significa o operador lendo "falhou"
// numa re-hospedagem que terminou certa — e possivelmente rodando tudo de novo.
process.exitCode = rel.resultado.falharam ? 1 : 0;
