#!/usr/bin/env node
// Importador de FUNIS, ETAPAS e a etapa de cada conversa, para uma instalacao
// do Expert Chat. Segundo passo da importacao: o `chatguru.mjs` traz conversas
// e mensagens e deixa os funis normalizados num arquivo; este script carrega
// esse arquivo no banco e liga cada conversa a sua etapa.
//
//   node scripts/importar/funis.mjs --pasta <pasta-do-backup> \
//     --url https://<projeto>.supabase.co --key <service_role> [--dry]
//
// De onde vem cada coisa:
//   - FUNIS e ETAPAS: `funis-normalizados.json` (saida do chatguru.mjs, na
//     pasta de trabalho da importacao) — id de origem, nome e ordem.
//   - ETAPA DE CADA CONVERSA: da coluna `conversas.meta_chatguru.funil_etapas`
//     das conversas JA IMPORTADAS, no formato "Funil / Etapa". Ou seja: este
//     script nao volta ao backup pra isso, ele le o que ja esta no banco.
//     Em --dry (sem conexao) da pra apontar um arquivo com o mesmo formato:
//     `--conversas arq.json` = [{chat_id, meta_chatguru:{funil_etapas:[...]}}].
//
// IDEMPOTENTE de tres jeitos, e nenhum deles pisa em trabalho humano:
//   1. funil/etapa ja importados (mesmo origem_sistema+origem_conta_id+origem_id)
//      sao REUSADOS, nunca reescritos — quem renomeou no painel continua com o
//      nome dele;
//   2. funil/etapa com o MESMO NOME criados a mao sao ADOTADOS (ganham o
//      carimbo de origem) em vez de virar duplicata;
//   3. vinculo conversa->etapa entra com `on_conflict` + ignore-duplicates.
//
// O QUE ELE NAO FAZ: nao cria tabela (a DDL e `supabase/migrations/0009_funis.sql`,
// gesto humano no SQL editor), nao apaga etapa de conversa que ja existia no
// painel, e nao inventa etapa por semelhanca de nome — o que nao casar aparece
// no relatorio como pendencia.
//
// PRIVACIDADE: o relatorio sai com CONTAGEM e nome de funil/etapa. Nunca com
// chat_id (telefone de cliente) — dado de conversa e conteudo de terceiro.

import fs from "node:fs";
import path from "node:path";

// ─── ARGUMENTOS ──────────────────────────────────────────────────────────────
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const PASTA = arg("pasta");
const TRABALHO = arg("trabalho", PASTA ? path.join(PASTA, ".importacao") : "");
const ARQ_FUNIS = arg("funis", TRABALHO ? path.join(TRABALHO, "funis-normalizados.json") : "");
const ARQ_CONVERSAS = arg("conversas");
const URL_BASE = arg("url", process.env.MSG_SUPABASE_URL || "");
const KEY = arg("key", process.env.MSG_SUPABASE_SERVICE_KEY || "");
const SCHEMA = arg("schema", "mensageria");
const CANAL = arg("canal", "central");
const ORIGEM_SISTEMA = arg("origem-sistema", "chatguru");
const DRY = flag("dry");
const DUMP = arg("dump");
const LIMITE = Number(arg("limite", 0)) || 0;

const USO = `uso: node scripts/importar/funis.mjs --pasta <pasta-do-backup> \\
       --url <url do projeto> --key <service_role> [--dry]

  --pasta <dir>         pasta do backup (de onde sai a pasta de trabalho)
  --funis <arq>         funis-normalizados.json (default: <pasta>/.importacao/funis-normalizados.json)
  --conversas <arq>     em --dry: arquivo com [{chat_id, meta_chatguru}] em vez do banco
  --url <url>           URL do projeto Supabase/PostgREST   (ou env MSG_SUPABASE_URL)
  --key <chave>         chave service_role da instalacao    (ou env MSG_SUPABASE_SERVICE_KEY)
  --dry                 simula: NAO abre conexao nenhuma, so le e gera relatorio
  --canal <id>          canal das conversas (default: central)
  --origem-sistema <s>  rotulo do sistema de origem (default: chatguru)
  --origem-conta <id>   conta/aparelho de origem (default: o campo "canal" do arquivo de funis)
  --schema <nome>       schema no banco (default: mensageria)
  --limite <n>          processa so as N primeiras conversas (teste curto)
  --trabalho <dir>      pasta de relatorio (default: <pasta>/.importacao)
  --dump <arq>          em --dry: grava as linhas que seriam enviadas`;

if (flag("ajuda") || flag("help") || (!ARQ_FUNIS && !PASTA)) {
  console.log(USO);
  process.exit(ARQ_FUNIS || PASTA ? 0 : 2);
}
if (!fs.existsSync(ARQ_FUNIS)) {
  console.error(`arquivo de funis nao encontrado: ${ARQ_FUNIS}\n`);
  console.log(USO);
  process.exit(2);
}
if (!DRY && (!URL_BASE || !KEY)) {
  console.error("sem --dry e obrigatorio informar --url e --key (ou as envs equivalentes).\n");
  console.log(USO);
  process.exit(2);
}
if (!/^[a-z][a-z0-9_]{1,30}$/.test(CANAL)) {
  console.error(`id de canal invalido: ${CANAL} (use minusculas, digitos e _)`);
  process.exit(2);
}

const TAB_CONVERSAS =
  CANAL === "central" ? "conversas" : CANAL === "apioficial" ? "conversas_apioficial" : `conversas_${CANAL}`;

const hora = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(`[${hora()}]`, ...a);

// ─── COMPARACAO DE NOME ──────────────────────────────────────────────────────
// MESMO criterio de lib/funis.ts (acento, caixa e espaco nao diferenciam). Dois
// criterios diferentes fariam o importador adotar um funil e o motor de fluxo
// achar outro. Aqui e JS puro de proposito: o script nao depende de build.
const ACENTOS = new RegExp("[\\u0300-\\u036f]", "g");
const ESPACOS = new RegExp("\\s+", "g");
export const normalizarNome = (v) =>
  String(v ?? "")
    .normalize("NFD")
    .replace(ACENTOS, "")
    .replace(ESPACOS, " ")
    .trim()
    .toLowerCase();

// A etapa de cada conversa foi gravada como "Funil / Etapa" (o importador de
// conversas resolveu o id pelo catalogo do backup). Quando NAO deu pra
// resolver, ficou o id cru — os dois casos sao tratados.
export const chaveFunilEtapa = (funil, etapa) => `${normalizarNome(funil)} / ${normalizarNome(etapa)}`;

// ─── ARQUIVO DE FUNIS ────────────────────────────────────────────────────────
// Cor da etapa: hex #RRGGBB ou nada. MESMA regra do CHECK da 0009 e de
// lib/funis.ts — cor fora do formato nao sobe (o banco recusaria o lote inteiro).
export const corValida = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  return /^#[0-9A-Fa-f]{6}$/.test(s) ? s.toUpperCase() : null;
};

const brutoFunis = JSON.parse(fs.readFileSync(ARQ_FUNIS, "utf8"));
const funisArquivo = Array.isArray(brutoFunis?.funis) ? brutoFunis.funis : Array.isArray(brutoFunis) ? brutoFunis : [];
const ORIGEM_CONTA = arg("origem-conta", String(brutoFunis?.canal ?? CANAL));

const est = {
  gerado_em: new Date().toISOString(),
  modo: DRY ? "dry" : "gravacao",
  canal: CANAL,
  schema: SCHEMA,
  arquivo_funis: ARQ_FUNIS,
  origem: {
    sistema: ORIGEM_SISTEMA,
    conta: ORIGEM_CONTA,
    funis: funisArquivo.length,
    etapas: 0,
    etapas_com_cor: 0,
  },
  destino: {
    funis_criados: 0,
    funis_adotados: 0,
    funis_ja_importados: 0,
    etapas_criadas: 0,
    etapas_adotadas: 0,
    etapas_ja_importadas: 0,
    etapas_com_cor: 0,
    cores_carimbadas: 0,
    vinculos_gravados: 0,
  },
  conversas: { lidas: 0, com_etapa: 0, sem_etapa: 0, vinculos_mapeados: 0 },
  pendencias: [],
  nao_resolvidos: {},
  erros: [],
};
const pend = (t, m) => est.pendencias.push({ tema: t, mensagem: m });
for (const f of funisArquivo) {
  est.origem.etapas += (f.etapas || []).length;
  est.origem.etapas_com_cor += (f.etapas || []).filter((s) => corValida(s?.cor)).length;
}
if (est.origem.etapas && !est.origem.etapas_com_cor) {
  pend(
    "cor",
    "nenhuma etapa do arquivo traz cor — o export do ChatGuru so tem id e nome. As etapas entram sem cor e a cor pode ser escolhida no painel depois (reimportar nao apaga a escolha)."
  );
}

if (!funisArquivo.length) {
  pend("funis", `o arquivo ${ARQ_FUNIS} nao tem funil nenhum — nada a importar`);
}

// ─── ACESSO AO BANCO (PostgREST direto, sem dependencia) ─────────────────────
const cabecalhos = () => ({
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
  "Accept-Profile": SCHEMA,
  "Content-Profile": SCHEMA,
});

async function buscar(caminho) {
  if (DRY) return [];
  const r = await fetch(`${URL_BASE}/rest/v1/${caminho}`, { headers: cabecalhos() });
  if (!r.ok) {
    const corpo = (await r.text()).slice(0, 300);
    // 42P01 = tabela nao existe: a migration 0009 nao rodou nesta instalacao
    throw new Error(`GET ${caminho}: HTTP ${r.status} ${corpo}`);
  }
  return r.json();
}

async function inserir(tabela, linhas, conflito, resolucao = "ignore-duplicates") {
  if (!linhas.length) return [];
  if (DRY) return linhas;
  const r = await fetch(`${URL_BASE}/rest/v1/${tabela}${conflito ? `?on_conflict=${conflito}` : ""}`, {
    method: "POST",
    headers: { ...cabecalhos(), Prefer: `resolution=${resolucao},return=representation` },
    body: JSON.stringify(linhas),
  });
  if (!r.ok) {
    const corpo = (await r.text()).slice(0, 300);
    throw new Error(`${tabela}: HTTP ${r.status} ${corpo}`);
  }
  return r.json();
}

async function atualizar(tabela, filtro, patch) {
  if (DRY) return;
  const r = await fetch(`${URL_BASE}/rest/v1/${tabela}?${filtro}`, {
    method: "PATCH",
    headers: { ...cabecalhos(), Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`PATCH ${tabela}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

// ─── PLANO: o que criar, o que adotar, o que ja existe ───────────────────────
// Puro pra poder ser exercitado sem banco (a prova roda a CLI em --dry, mas
// esta funcao e o coracao e vale ler sozinha).
export function planejarFunis(funisArquivo, funisNoBanco, etapasNoBanco, origem) {
  const porOrigemFunil = new Map();
  const porNomeFunil = new Map();
  for (const f of funisNoBanco) {
    if (f.origem_sistema === origem.sistema && f.origem_conta_id === origem.conta && f.origem_id) {
      porOrigemFunil.set(String(f.origem_id), f);
    }
    porNomeFunil.set(normalizarNome(f.nome), f);
  }
  const etapasDoFunil = new Map();
  for (const e of etapasNoBanco) {
    const l = etapasDoFunil.get(e.funil_id) ?? [];
    l.push(e);
    etapasDoFunil.set(e.funil_id, l);
  }

  const plano = { criarFunis: [], adotarFunis: [], reusarFunis: [], etapasPorFunilOrigem: new Map() };
  for (const f of funisArquivo) {
    const nome = String(f.nome ?? "").trim();
    if (!nome) continue;
    const jaImportado = porOrigemFunil.get(String(f.id_origem ?? ""));
    const mesmoNome = porNomeFunil.get(normalizarNome(nome));
    if (jaImportado) plano.reusarFunis.push({ arquivo: f, banco: jaImportado });
    else if (mesmoNome) plano.adotarFunis.push({ arquivo: f, banco: mesmoNome });
    else plano.criarFunis.push(f);
    plano.etapasPorFunilOrigem.set(String(f.id_origem ?? nome), {
      funil: f,
      banco: jaImportado || mesmoNome || null,
      etapasBanco: jaImportado || mesmoNome ? etapasDoFunil.get((jaImportado || mesmoNome).id) ?? [] : [],
    });
  }
  return plano;
}

// ─── EXECUCAO ────────────────────────────────────────────────────────────────
const dump = { funis: [], etapas: [], vinculos: [] };

async function main() {
  log(`funis: ${est.origem.funis} funil(is) e ${est.origem.etapas} etapa(s) em ${path.basename(ARQ_FUNIS)}`);
  if (DRY) log("MODO --dry: nenhuma conexao sera aberta e nada sera gravado");

  // 1) o que ja existe no destino
  let funisBanco = [];
  let etapasBanco = [];
  try {
    funisBanco = await buscar("funis?select=id,nome,ativo,origem_sistema,origem_conta_id,origem_id&limit=1000");
    etapasBanco = await buscar("funil_etapas?select=id,funil_id,nome,ordem,ativo,origem_sistema,origem_conta_id,origem_id&limit=5000");
  } catch (e) {
    est.erros.push(`leitura de funis: ${e.message}`);
    pend(
      "migration",
      "nao consegui ler mensageria.funis — a migration supabase/migrations/0009_funis.sql ja foi aplicada nesta instalacao? (rodar e gesto humano no SQL editor)"
    );
    relatorio();
    process.exit(1);
  }

  const plano = planejarFunis(funisArquivo, funisBanco, etapasBanco, {
    sistema: ORIGEM_SISTEMA,
    conta: ORIGEM_CONTA,
  });
  est.destino.funis_ja_importados = plano.reusarFunis.length;

  // 2) criar os funis que faltam
  const idPorOrigemFunil = new Map();
  for (const { arquivo, banco } of plano.reusarFunis) idPorOrigemFunil.set(String(arquivo.id_origem), banco.id);
  for (const { arquivo, banco } of plano.adotarFunis) {
    idPorOrigemFunil.set(String(arquivo.id_origem), banco.id);
    est.destino.funis_adotados++;
    dump.funis.push({ acao: "adotar", id: banco.id, nome: banco.nome, origem_id: arquivo.id_origem });
    // adotar = carimbar a origem no que ja existia, pra reimportar nao duplicar
    if (!banco.origem_id) {
      await atualizar(
        "funis",
        `id=eq.${banco.id}`,
        { origem_sistema: ORIGEM_SISTEMA, origem_conta_id: ORIGEM_CONTA, origem_id: String(arquivo.id_origem) }
      );
    }
  }
  if (plano.criarFunis.length) {
    const linhas = plano.criarFunis.map((f, i) => ({
      nome: String(f.nome).slice(0, 120),
      ordem: i,
      ativo: true,
      origem_sistema: ORIGEM_SISTEMA,
      origem_conta_id: ORIGEM_CONTA,
      origem_id: String(f.id_origem ?? ""),
    }));
    dump.funis.push(...linhas.map((l) => ({ acao: "criar", ...l })));
    const criados = await inserir("funis", linhas, "origem_sistema,origem_conta_id,origem_id");
    est.destino.funis_criados = criados.length;
    for (const c of criados) if (c.origem_id) idPorOrigemFunil.set(String(c.origem_id), c.id);
    if (DRY) for (const f of plano.criarFunis) idPorOrigemFunil.set(String(f.id_origem), `(novo:${f.id_origem})`);
    log(`funis criados: ${criados.length}`);
  }

  // 3) etapas de cada funil
  const idPorOrigemEtapa = new Map(); // origem_id da etapa -> {etapa_id, funil_id}
  const chavePorEtapaId = new Map(); // "funil / etapa" normalizado -> {etapa_id, funil_id}
  for (const f of funisArquivo) {
    const funilId = idPorOrigemFunil.get(String(f.id_origem));
    if (!funilId) continue;
    const info = plano.etapasPorFunilOrigem.get(String(f.id_origem ?? f.nome));
    const existentes = info?.etapasBanco ?? [];
    const porOrigem = new Map(
      existentes
        .filter((e) => e.origem_sistema === ORIGEM_SISTEMA && e.origem_conta_id === ORIGEM_CONTA && e.origem_id)
        .map((e) => [String(e.origem_id), e])
    );
    const porNome = new Map(existentes.map((e) => [normalizarNome(e.nome), e]));

    const novas = [];
    for (const s of f.etapas || []) {
      const nome = String(s.nome ?? "").trim();
      if (!nome) continue;
      const ja = porOrigem.get(String(s.id_origem ?? ""));
      const mesmoNome = porNome.get(normalizarNome(nome));
      const chave = chaveFunilEtapa(f.nome, nome);
      if (ja) {
        est.destino.etapas_ja_importadas++;
        idPorOrigemEtapa.set(String(s.id_origem), { etapa_id: ja.id, funil_id: funilId });
        chavePorEtapaId.set(chave, { etapa_id: ja.id, funil_id: funilId });
      } else if (mesmoNome) {
        est.destino.etapas_adotadas++;
        idPorOrigemEtapa.set(String(s.id_origem), { etapa_id: mesmoNome.id, funil_id: funilId });
        chavePorEtapaId.set(chave, { etapa_id: mesmoNome.id, funil_id: funilId });
        dump.etapas.push({ acao: "adotar", id: mesmoNome.id, nome, funil: f.nome });
        const patch = {};
        if (!mesmoNome.origem_id) {
          Object.assign(patch, {
            origem_sistema: ORIGEM_SISTEMA,
            origem_conta_id: ORIGEM_CONTA,
            origem_id: String(s.id_origem ?? ""),
          });
        }
        // cor so entra em etapa que ainda NAO tem cor: quem escolheu a cor no
        // painel nao pode ver a reimportacao desfazer a escolha dele
        if (corValida(s.cor) && !mesmoNome.cor) {
          patch.cor = corValida(s.cor);
          est.destino.cores_carimbadas++;
        }
        if (Object.keys(patch).length) await atualizar("funil_etapas", `id=eq.${mesmoNome.id}`, patch);
      } else {
        const cor = corValida(s.cor);
        if (cor) est.destino.etapas_com_cor++;
        novas.push({
          funil_id: funilId,
          nome: nome.slice(0, 120),
          ordem: Number.isFinite(Number(s.ordem)) ? Number(s.ordem) : novas.length,
          ativo: true,
          ...(cor ? { cor } : {}),
          origem_sistema: ORIGEM_SISTEMA,
          origem_conta_id: ORIGEM_CONTA,
          origem_id: String(s.id_origem ?? ""),
        });
      }
    }
    if (novas.length) {
      dump.etapas.push(...novas.map((l) => ({ acao: "criar", funil: f.nome, ...l })));
      const criadas = await inserir("funil_etapas", novas, "origem_sistema,origem_conta_id,origem_id");
      est.destino.etapas_criadas += criadas.length;
      for (const c of criadas) {
        idPorOrigemEtapa.set(String(c.origem_id), { etapa_id: c.id, funil_id: funilId });
      }
      if (DRY) {
        for (const n of novas) {
          const alvo = { etapa_id: `(nova:${n.origem_id})`, funil_id: funilId };
          idPorOrigemEtapa.set(String(n.origem_id), alvo);
          chavePorEtapaId.set(chaveFunilEtapa(f.nome, n.nome), alvo);
        }
      } else {
        for (const c of criadas) chavePorEtapaId.set(chaveFunilEtapa(f.nome, c.nome), { etapa_id: c.id, funil_id: funilId });
      }
    }
  }
  log(
    `etapas: ${est.destino.etapas_criadas} criada(s), ${est.destino.etapas_adotadas} adotada(s), ${est.destino.etapas_ja_importadas} ja importada(s)`
  );

  // 4) etapa de cada conversa
  const conversas = await lerConversas();
  est.conversas.lidas = conversas.length;
  const vinculos = [];
  for (const c of conversas) {
    const lista = c?.meta_chatguru?.funil_etapas;
    if (!Array.isArray(lista) || !lista.length) {
      est.conversas.sem_etapa++;
      continue;
    }
    est.conversas.com_etapa++;
    for (const valor of lista) {
      const texto = String(valor ?? "").trim();
      if (!texto) continue;
      // "Funil / Etapa" (resolvido no import de conversas) OU o id cru da etapa
      // (quando o catalogo do backup nao tinha aquele id). Os dois resolvem
      // por CHAVE EXATA — nunca por semelhanca de nome.
      const porTexto = chavePorEtapaId.get(normalizarChaveTexto(texto));
      const porId = idPorOrigemEtapa.get(texto);
      const alvo = porTexto || porId;
      if (!alvo) {
        est.nao_resolvidos[texto] = (est.nao_resolvidos[texto] || 0) + 1;
        continue;
      }
      est.conversas.vinculos_mapeados++;
      vinculos.push({
        canal: CANAL,
        chat_id: c.chat_id,
        etapa_id: alvo.etapa_id,
        funil_id: alvo.funil_id,
        // autoria de AUTOMACAO (id NULL + nome), convencao da migration 0006
        definido_por_id: null,
        definido_por_nome: `importacao ${ORIGEM_SISTEMA}`,
      });
    }
  }

  // Grava em lotes pequenos de proposito: uma linha ruim (etapa que sumiu no
  // meio da rodada, por exemplo) derruba so o lote dela, e o relatorio diz qual.
  // ATENCAO ao que NAO acontece aqui: `conversa_funil` nao tem FK pra conversas
  // — a chave e (canal, chat_id), pra valer em qualquer canal, inclusive os de
  // fonte externa, que nao tem linha de conversa no banco do painel. Ou seja,
  // vinculo de conversa que nao existe entra sem reclamar; quem barra chat_id
  // arbitrario e a rota (/api/conversa/funil), nao o banco. Aqui os chat_id vem
  // das conversas JA importadas, entao o caso nao aparece.
  for (let i = 0; i < vinculos.length; i += 200) {
    const lote = vinculos.slice(i, i + 200);
    try {
      const gravados = await inserir("conversa_funil", lote, "canal,chat_id,etapa_id");
      est.destino.vinculos_gravados += DRY ? lote.length : gravados.length;
    } catch (e) {
      est.erros.push(`vinculos (lote ${i / 200 + 1}): ${e.message}`);
    }
  }
  // o dump so e escrito quando o operador pede --dump (e o arquivo pode conter
  // chat_id = telefone; por isso ele nao entra no relatorio, que e publicavel)
  dump.vinculos = vinculos;
  log(`vinculos conversa->etapa: ${est.destino.vinculos_gravados}`);

  const naoResolvidos = Object.keys(est.nao_resolvidos).length;
  if (naoResolvidos) {
    pend(
      "etapas",
      `${naoResolvidos} valor(es) de etapa em conversas nao casaram com nenhum funil/etapa importado (ficaram sem vinculo, nada foi adivinhado por semelhanca)`
    );
  }
  relatorio();
}

function normalizarChaveTexto(texto) {
  // "Funil / Etapa" com o mesmo criterio de comparacao das duas pontas
  const partes = String(texto).split(" / ");
  if (partes.length < 2) return normalizarNome(texto);
  const etapa = partes.pop();
  return chaveFunilEtapa(partes.join(" / "), etapa);
}

async function lerConversas() {
  if (ARQ_CONVERSAS) {
    const bruto = JSON.parse(fs.readFileSync(ARQ_CONVERSAS, "utf8"));
    const lista = Array.isArray(bruto) ? bruto : Array.isArray(bruto?.conversas) ? bruto.conversas : [];
    return LIMITE ? lista.slice(0, LIMITE) : lista;
  }
  if (DRY) {
    pend(
      "conversas",
      "--dry sem --conversas: o script nao abre conexao, entao nenhuma etapa de conversa foi avaliada (funis e etapas acima seguem valendo)"
    );
    return [];
  }
  const todas = [];
  const passo = 1000;
  for (let offset = 0; ; offset += passo) {
    const pagina = await buscar(
      `${TAB_CONVERSAS}?select=chat_id,meta_chatguru&meta_chatguru=not.is.null&limit=${passo}&offset=${offset}`
    );
    todas.push(...pagina);
    if (pagina.length < passo) break;
    if (LIMITE && todas.length >= LIMITE) break;
  }
  return LIMITE ? todas.slice(0, LIMITE) : todas;
}

// ─── RELATORIO ───────────────────────────────────────────────────────────────
// Texto que vai pra celula de tabela vem de `meta_chatguru` — CONTEUDO DE
// TERCEIRO. Um "|" quebra a tabela, uma quebra de linha quebra a linha, e
// backtick/marcacao viram formatacao inventada. Escapa e limita o tamanho:
// relatorio deformado esconde exatamente a pendencia que ele existe pra mostrar.
export function paraCelula(v, max = 120) {
  const texto = String(v ?? "")
    .replace(new RegExp("[\\u0000-\\u001f\\u007f]", "g"), " ")
    .replace(new RegExp("\\|", "g"), "\\|")
    .replace(new RegExp("\\s+", "g"), " ")
    .trim();
  if (!texto) return "(vazio)";
  return texto.length > max ? `${texto.slice(0, max)}…` : texto;
}

function relatorio() {
  const linhas = [];
  linhas.push("# Relatorio de importacao de funis");
  linhas.push("");
  if (DRY) linhas.push("> **SIMULACAO (--dry)** — nenhuma conexao foi aberta e nada foi gravado.");
  linhas.push("");
  linhas.push(`- gerado em: ${est.gerado_em}`);
  linhas.push(`- arquivo de funis: ${est.arquivo_funis}`);
  linhas.push(`- canal de destino: ${est.canal} (tabela de conversas: ${TAB_CONVERSAS})`);
  linhas.push(`- origem: sistema \`${ORIGEM_SISTEMA}\`, conta \`${ORIGEM_CONTA}\``);
  linhas.push("");
  linhas.push("| origem | qtd |");
  linhas.push("|---|---:|");
  linhas.push(`| funis no arquivo | ${est.origem.funis} |`);
  linhas.push(`| etapas no arquivo | ${est.origem.etapas} |`);
  linhas.push(`| etapas com cor na origem | ${est.origem.etapas_com_cor} |`);
  linhas.push("");
  linhas.push("| destino | qtd |");
  linhas.push("|---|---:|");
  linhas.push(`| funis criados | ${est.destino.funis_criados} |`);
  linhas.push(`| funis adotados (mesmo nome, ja existiam) | ${est.destino.funis_adotados} |`);
  linhas.push(`| funis ja importados antes | ${est.destino.funis_ja_importados} |`);
  linhas.push(`| etapas criadas | ${est.destino.etapas_criadas} |`);
  linhas.push(`| etapas adotadas | ${est.destino.etapas_adotadas} |`);
  linhas.push(`| etapas ja importadas antes | ${est.destino.etapas_ja_importadas} |`);
  linhas.push(`| etapas criadas com cor | ${est.destino.etapas_com_cor} |`);
  linhas.push(`| cores carimbadas em etapa que estava sem | ${est.destino.cores_carimbadas} |`);
  linhas.push(`| vinculos conversa -> etapa | ${est.destino.vinculos_gravados} |`);
  linhas.push("");
  linhas.push("| conversas | qtd |");
  linhas.push("|---|---:|");
  linhas.push(`| lidas | ${est.conversas.lidas} |`);
  linhas.push(`| com etapa na origem | ${est.conversas.com_etapa} |`);
  linhas.push(`| sem etapa | ${est.conversas.sem_etapa} |`);
  linhas.push(`| vinculos mapeados | ${est.conversas.vinculos_mapeados} |`);
  linhas.push("");
  const nr = Object.entries(est.nao_resolvidos).sort((a, b) => b[1] - a[1]);
  if (nr.length) {
    linhas.push("## Valores de etapa que nao casaram");
    linhas.push("");
    linhas.push("| valor na conversa | conversas |");
    linhas.push("|---|---:|");
    for (const [k, v] of nr.slice(0, 40)) linhas.push(`| ${paraCelula(k)} | ${v} |`);
    linhas.push("");
  }
  if (est.pendencias.length) {
    linhas.push("## Pendencias");
    linhas.push("");
    for (const p of est.pendencias) linhas.push(`- **${p.tema}**: ${p.mensagem}`);
    linhas.push("");
  }
  if (est.erros.length) {
    linhas.push("## Erros");
    linhas.push("");
    for (const e of est.erros) linhas.push(`- ${e}`);
    linhas.push("");
  }
  const md = linhas.join("\n");

  if (TRABALHO) {
    fs.mkdirSync(TRABALHO, { recursive: true });
    const base = path.join(TRABALHO, `relatorio-funis-${est.gerado_em.replace(/[:.]/g, "-")}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify(est, null, 2));
    fs.writeFileSync(`${base}.md`, md);
    log(`relatorio em ${base}.md`);
  } else {
    console.log(`\n${md}`);
  }
  if (DUMP) {
    fs.writeFileSync(DUMP, JSON.stringify(dump, null, 2));
    log(`linhas simuladas em ${DUMP}`);
  }
}

// so roda o CLI quando ESTE arquivo e o programa
if (process.argv[1]?.replace(/\\/g, "/").endsWith("importar/funis.mjs")) {
  main().catch((e) => {
    console.error(`falhou: ${e.message}`);
    est.erros.push(e.message);
    relatorio();
    process.exit(1);
  });
}
