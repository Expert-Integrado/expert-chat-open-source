#!/usr/bin/env node
// Importador de historico do ChatGuru para uma instalacao do Expert Chat.
//
// Le uma PASTA DE BACKUP exportada do painel ChatGuru e grava no Postgres da
// instalacao (via PostgREST/Supabase do proprio cliente). Nada aqui e especifico
// de uma empresa: a pasta, a URL, a chave e o canal vem todos por argumento/env.
//
//   node scripts/importar/chatguru.mjs --pasta <pasta-do-backup> \
//     --url https://<projeto>.supabase.co --key <service_role> [--dry]
//
// Idempotente e retomavel:
//   - mensagem deduplica no BANCO por `provider_msg_id` (indice unico + PostgREST
//     `on_conflict` com `resolution=ignore-duplicates`) — rodar de novo nunca duplica;
//   - conversa faz upsert por `chat_id` (merge-duplicates);
//   - checkpoint LOCAL na pasta de trabalho: conversa ja concluida e pulada.
//
// A chave NUNCA aparece em log nem e gravada em arquivo. Prefira passar por
// ambiente (MSG_SUPABASE_URL / MSG_SUPABASE_SERVICE_KEY) em vez de linha de comando.
//
// O que este importador NAO faz (limites conhecidos da v1, no README):
//   - nao cria tabela nenhuma (DDL e gesto humano no SQL editor);
//   - nao cria conta de login pra atendente antigo (so preserva o NOME da autoria);
//   - nao sobe os arquivos de midia baixados no backup (precisam de bucket do cliente);
//   - nao importa funis/etapas: eles saem normalizados em `funis-normalizados.json`
//     e entram no banco pelo SEGUNDO passo, `scripts/importar/funis.mjs`.

import fs from "node:fs";
import path from "node:path";
import { renderRelatorio } from "./relatorio.mjs";
import {
  acharConfig,
  indicesDoBackup,
  resolverEtiqueta,
  resolverUsuario,
  resolverDepartamento,
  resolverEtapa,
  resolverAutorNota,
  ehAutorDeSistema,
  novoPlacar,
  urlDoArquivo,
} from "./referencias.mjs";

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
// A coluna `conversas.canal` guarda o ROTULO de origem (de onde a linha veio),
// no formato fonte-id — o webhook grava `zapi-<id>`. O historico importado veio
// do ChatGuru, entao o default e `chatguru-<id>`; nao e o id do canal cru, que
// serve pra rotear tabela.
const ROTULO_CANAL = arg("rotulo-canal", `chatguru-${arg("canal", "central")}`);
const DRY = flag("dry");
const SO_CONFIG = flag("so-config");
const LOTE = Math.max(1, Number(arg("lote", 500)) || 500);
const LIMITE = Number(arg("limite", 0)) || 0;
const TRABALHO = arg("trabalho", PASTA ? path.join(PASTA, ".importacao") : "");
const RECOMECAR = flag("recomecar");
// So em --dry: escreve num arquivo as linhas exatas que seriam gravadas. Serve
// pra conferir o mapeamento campo a campo antes de deixar o script tocar o banco.
const DUMP = arg("dump");

const USO = `uso: node scripts/importar/chatguru.mjs --pasta <pasta-do-backup> \\
       --url <url do projeto> --key <service_role> [--dry] [--so-config]

  --pasta <dir>      pasta do backup (obrigatoria)
  --url <url>        URL do projeto Supabase/PostgREST   (ou env MSG_SUPABASE_URL)
  --key <chave>      chave service_role da instalacao    (ou env MSG_SUPABASE_SERVICE_KEY)
  --dry              simula: NAO abre conexao nenhuma, so le o backup e gera relatorio
  --so-config        importa so o catalogo (etiquetas + autoria), sem mensagens
  --canal <id>       canal de destino (default: central)
  --schema <nome>    schema no banco (default: mensageria)
  --lote <n>         tamanho do lote de insercao (default: 500)
  --limite <n>       processa so as N primeiras conversas (teste curto)
  --trabalho <dir>   pasta de checkpoint/relatorio (default: <pasta>/.importacao)
  --recomecar        ignora o checkpoint e repassa tudo (o dedupe segura)`;

if (!PASTA || flag("ajuda") || flag("help")) {
  console.log(USO);
  process.exit(PASTA ? 0 : 2);
}
if (!fs.existsSync(PASTA)) {
  console.error(`pasta nao encontrada: ${PASTA}`);
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

// Par de tabelas do canal. Os dois built-in tem nome proprio; canal extra segue a
// convencao do painel (conversas_<id>/mensagens_<id>, criadas pelo DDL do canal).
const T =
  CANAL === "central"
    ? { conversas: "conversas", mensagens: "mensagens" }
    : CANAL === "apioficial"
      ? { conversas: "conversas_apioficial", mensagens: "mensagens_apioficial" }
      : { conversas: `conversas_${CANAL}`, mensagens: `mensagens_${CANAL}` };

const hora = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(`[${hora()}]`, ...a);

// ─── HELPERS DE LEITURA DO BACKUP ────────────────────────────────────────────
const lerJson = (p, padrao = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return padrao;
  }
};
const dt = (v) => {
  const bruto = v && typeof v === "object" && v.$date ? v.$date : v;
  if (!bruto) return null;
  // o backup mistura ISO ("2025-05-13T02:37:02Z") e o formato do painel
  // ("2025-05-13 02:37:02.160000"), que e UTC sem sufixo.
  const txt = typeof bruto === "string" && bruto.includes(" ") && !bruto.endsWith("Z")
    ? `${bruto.replace(" ", "T")}Z`
    : bruto;
  const d = new Date(txt);
  return isNaN(d) ? null : d.toISOString();
};
const oid = (v) => (v && typeof v === "object" && v.$oid ? v.$oid : typeof v === "string" ? v : null);

// Corte SEGURO: slice(0,n) corta por unidade UTF-16 e parte emoji no meio, deixando
// um surrogate orfao — o corpo vira UTF-8 invalido e o PostgREST devolve PGRST102
// "Empty or invalid json". Byte nulo tambem e recusado em coluna text.
function corta(s, n) {
  const limpo = String(s ?? "")
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  const chars = [...limpo];
  if (chars.length <= n) return limpo;
  if (n >= TETO_CONTEUDO) textosTruncados++; // so conta corpo de mensagem, nao nome/rotulo
  return chars.slice(0, n).join("");
}

// A coluna `conteudo` e text sem limite no Postgres; este teto e so barreira
// contra payload absurdo, e alto de proposito — cortar mensagem de cliente e
// perda silenciosa de historico. O que for cortado aparece no relatorio.
const TETO_CONTEUDO = 100000;
let textosTruncados = 0;

// anotacao interna vem com HTML do editor do painel de origem
function limparHtml(s) {
  return String(s ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── MAPEAMENTO ORIGEM -> SCHEMA DO PAINEL ───────────────────────────────────
// Estes nomes de coluna sao os do painel (migration 0001). Mudar aqui sem olhar
// o schema quebra so na GRAVACAO — o dry run nao percebe.
const TIPO = {
  chat: "text",
  image: "image",
  video: "video",
  audio: "audio",
  ptt: "audio",
  document: "document",
  sticker: "sticker",
  location: "location",
  vcard: "contact",
  multi_vcard: "contact",
};
// Tipo que o painel NAO tem, mas cujo CONTEUDO e texto que o cliente leu de
// verdade: entra como texto e a perda de estrutura (botoes, lista, cartao de
// produto) vai contada pro relatorio. Virar "unknown" seria pior — "unknown" diz
// "nao sei o que e isso", e aqui a gente sabe: e uma mensagem de texto com
// enfeite que o painel ainda nao desenha.
const TIPO_DEGRADADO = {
  template: "text", // texto de template WABA aprovado — ganha o qualificador por_template
  interactive_list: "text",
  interactive_quick_reply: "text",
  interactive_product: "text",
  order: "text",
  product: "text",
};

// Mensagem que o CLIENTE apagou pra todos. O painel tem coluna pra isso
// (`is_deleted`) e mascara a bolha como "Mensagem apagada", exatamente como faz
// com a mensagem apagada ao vivo pelo webhook. Descartar apagaria da linha do
// tempo o fato de que existiu mensagem ali — some um turno da conversa.
const APAGADA_NA_ORIGEM = new Set(["revoked"]);

// Descartados de proposito: nao tem conteudo nenhum pra mostrar.
//   ciphertext   — mensagem que nunca foi decifrada
//   call_log     — registro de chamada
//   notification — aviso do proprio WhatsApp (entrou/saiu do grupo)
const IGNORADOS = new Set(["ciphertext", "call_log", "notification"]);

// ack do WhatsApp: e a UNICA fonte de estado de entrega na origem, e o painel
// tem o mesmo vocabulario (sent/delivered/read/played, monotonico). Sem esta
// traducao as 638 mil saidas entravam todas como "sent" — o selo de lido, que a
// origem sabia, era jogado fora.
const ACK = { 0: "sent", 1: "sent", 2: "delivered", 3: "read", 4: "played" };

// Vocabulario que o painel entende de verdade: `app/home.tsx` desenha 2 tiques
// azuis pra "read", 2 cinzas pra "delivered" e 1 pra qualquer outra coisa. A
// origem tem valores que nao existem aqui ("processed", "processed_pass" — o
// chatbot dela processou a mensagem, o que nao e estado de ENTREGA). Sem esta
// peneira eles iriam pra coluna e ficariam parecendo estado de entrega valido
// pra quem consultar o banco depois.
const ENTREGA = new Set(["sent", "delivered", "read", "played", "error"]);
const STATUS = {
  ABERTO: "aberto",
  "EM ATENDIMENTO": "atendimento",
  AGUARDANDO: "aguardando",
  RESOLVIDO: "concluido",
  FECHADO: "concluido",
};

// UM criterio so de "isto e um grupo", usado tanto pelo chat_id quanto pela
// coluna is_group — dois criterios diferentes davam chat_id terminando em
// -group com is_group: false.
const ehGrupo = (c) => c.kind === "group" || /@g\.us/.test(String(c.wa_chat_id || ""));

// O painel usa o formato de chat_id do provedor WhatsApp: grupo termina em "-group".
// Manter o hifen interno do id de grupo antigo (<numero>-<timestamp>) — trocar por
// so-digitos gera um chat_id que nao casa com o que o webhook grava.
function chatIdPainel(c) {
  const wa = String(c.wa_chat_id || c.id || "").replace(/@.*$/, "");
  return ehGrupo(c) && !wa.endsWith("-group") ? `${wa}-group` : wa;
}

// Vocabulario do painel pro corpo de mensagem que so tem midia (o webhook usa
// exatamente estes rotulos) — o tipo cru da origem ("ptt") nao aparece pro usuario.
const ROTULO_TIPO = {
  image: "[foto]",
  audio: "[audio]",
  video: "[video]",
  document: "[documento]",
  sticker: "[figurinha]",
  location: "[localizacao]",
  contact: "[contato]",
  text: "[mensagem]",
  unknown: "[mensagem]",
};

// ─── O QUE A MENSAGEM CARREGA ALEM DO TEXTO ──────────────────────────────────
// O modulo 7 lista o que precisa sobreviver: "identificador, ordem temporal,
// conteudo, tipo, arquivo, citacao/resposta, reacoes, edicoes, estado de
// entrega, erro, e os marcadores de automacao". As quatro do meio existem na
// origem (medido: 14.515 mensagens com citacao, 21.209 com reacao, 79.379 com
// bloco de edicao, 78.619 com marca de encaminhamento na amostra de 85 mil) e
// tinham coluna no painel — estavam sendo largadas na leitura.

// A coluna `reacao` do painel guarda UMA marca; a origem guarda a lista, com
// autor e data. Fica a mais RECENTE, que e a que estava na tela.
function reacaoDe(m) {
  const lista = (Array.isArray(m.reactions) ? m.reactions : []).filter((r) => r && r.reaction);
  if (!lista.length) return null;
  const ultima = lista.reduce((a, b) => (String(dt(b.date) || "") > String(dt(a.date) || "") ? b : a));
  return corta(ultima.reaction, 16) || null;
}

// `edits` e uma lista de {date, old_text}. O painel guarda so QUANDO foi editada.
function editadaEm(m) {
  const datas = (Array.isArray(m.edits) ? m.edits : []).map((e) => dt(e?.date)).filter(Boolean).sort();
  return datas.length ? datas[datas.length - 1] : null;
}

// Os qualificadores que EXISTEM de verdade na origem, e so eles. O modulo 7 e
// explicito: mensagem enviada nao guarda quem enviou, e o que da pra preservar
// sem inventar autor e `por_template` e `do_aparelho`. Vao em `raw` SO quando
// sao verdade — 1,2 milhao de linhas com um jsonb constante e peso morto.
// `processador` entra so quando nao e zero (medido: 68% e zero) e `erro` so
// quando a origem marcou o envio como falho (2,1%).
function qualificadores(m) {
  const q = {};
  if (m.is_template === true) q.por_template = true;
  if (m.from_device === true) q.do_aparelho = true;
  const p = Number(m.processor);
  if (Number.isFinite(p) && p > 0) q.processador = p;
  if (String(m.status) === "error") {
    const erro = corta(m.error_details_translated || m.error_details || "", 300);
    if (erro) q.erro = erro;
    else q.erro = "erro sem detalhe na origem";
  }
  if (m.campaign_id) q.campanha_origem_id = oid(m.campaign_id);
  return Object.keys(q).length ? q : null;
}

// A URL do arquivo vem de `referencias.mjs` (fonte unica; a copia local daqui era
// gemea da de midia.mjs e as duas TINHAM que concordar byte a byte).

// Texto que passou por conversao errada de charset chega com "Ã©", "â€œ" ou o
// losango de substituicao. Nao da pra desfazer com seguranca em cima de 1,2 milhao
// de mensagens — chute de charset estraga o que estava certo. A regra e: NAO
// mexer, so CONTAR e declarar.
//
// GOTCHA que a revisao cega pegou: a versao anterior prometia "â€œ" no comentario
// e NAO pegava. Mojibake tem DUAS caras, e elas diferem no segundo byte:
//   - lido como ISO-8859-1: E2 80 9C -> "â" + U+0080 + U+009C (controles);
//   - lido como CP1252 (o caso comum no Windows): 0x80 nao e controle, e "€"
//     (U+20AC), e 0x9C e "œ" (U+0153) — nada disso cai em -.
// Entao a classe do segundo/terceiro caractere cobre os altos do CP1252 TAMBEM.
// Escapes, nunca caractere cru: combinante/controle solto no fonte desaparece em
// copia, patch e heredoc, e a deteccao morre calada.
const CP1252_ALTOS =
  "\\u20AC\\u201A\\u0192\\u201E\\u2026\\u2020\\u2021\\u02C6\\u2030\\u0160\\u2039\\u0152\\u017D" +
  "\\u2018\\u2019\\u201C\\u201D\\u2022\\u2013\\u2014\\u02DC\\u2122\\u0161\\u203A\\u0153\\u017E\\u0178";
// Formato LONGO de identificador de mensagem do WhatsApp, como a citacao as vezes
// o traz: "<fromMe>_<jid>_<hex>". O jid nunca tem `_` (medido na conta INTEIRA da
// Expert: 0 caso ambiguo em 133.682 citacoes), entao o hex final e o que sobra
// depois do segundo separador.
const RE_ID_LONGO = new RegExp("^(?:true|false)_[^_]+_(.+)$");

// OS ALTOS DO CP1252 SO ENTRAM NO RAMO DO "â" — e isso custou um falso positivo
// na re-revisao. No ramo do "Ã" eles marcavam texto CERTO: `“MAÇÃ”` e `A IRMÃ—`
// sao "Ã" legitimo seguido de aspa curva ou travessao, ambos altos do CP1252.
// Falso positivo aqui e caro porque a metrica existe pra dizer "quanto do acervo
// chegou corrompido" — inflar ela manda o operador procurar defeito que nao ha.
// A perda aceita e o mojibake CP1252 de LETRA MAIUSCULA acentuada (`Ã` + `€` pra
// "À"), que e raro e nao vale o preco.
// No ramo do "â" nao ha esse risco: "â" seguido de DOIS altos consecutivos nao
// acontece em texto de verdade.
const ENCODING_SUSPEITO = new RegExp(
  [
    "\\uFFFD", // losango de substituicao: byte que nem virou caractere
    "\\u00C3[\\u0080-\\u00BF]", // C3 xx -> "Ã?" (letra acentuada latina)
    `\\u00E2[\\u0080-\\u009F${CP1252_ALTOS}][\\u0080-\\u009F${CP1252_ALTOS}]`, // E2 80 xx -> aspa/travessao
  ].join("|")
);

// ─── ESTATISTICAS (viram o relatorio de validacao) ───────────────────────────
const est = {
  gerado_em: new Date().toISOString(),
  pasta: PASTA,
  canal: CANAL,
  schema: SCHEMA,
  tabelas: T,
  modo: DRY ? "dry" : SO_CONFIG ? "gravacao (so config)" : "gravacao",
  destino_host: URL_BASE ? (() => { try { return new URL(URL_BASE).host; } catch { return "(url invalida)"; } })() : null,
  origem: {},
  destino: {
    gravado: { conversas: 0, mensagens: 0 },
    perdidos_em_lote_falhado: 0,
    // conversa que JA existia no painel e teve dado vivo protegido do upsert
    preservado_do_painel: { nome: 0, foto_url: 0, responsavel_nome: 0, etiquetas_unidas: 0 },
  },
  datas: {},
  descartados: {
    sem_data: 0,
    tipo_ignorado: {},
    apagadas: 0,
    sem_conteudo: 0,
    duplicadas_no_backup: 0,
    conversas_colapsadas: 0,
    midia_sem_url: 0,
    conversas_de_transmissao: 0,
    itens_em_conversas_de_transmissao: 0,
  },
  // O que a origem sabia e o painel agora tambem sabe. Sem estes numeros, "o
  // historico veio inteiro" e opiniao.
  preservados: {
    citacao: 0,
    // citacao cujo alvo NAO entrou no import (conferido dentro da conversa)
    citacao_com_alvo_fora_do_import: 0,
    // citacao que veio no formato longo e foi recasada com o id nu da mensagem
    citacao_recasada_por_formato: 0,
    // hex final que casaria com 2+ mensagens da conversa: fica como veio
    citacao_com_hex_ambiguo: 0,
    reacao: 0,
    editada: 0,
    encaminhada: 0,
    apagada_marcada: 0,
    por_template: 0,
    do_aparelho: 0,
    com_erro_de_envio: 0,
    estado_de_entrega: {},
    estado_de_entrega_sem_traducao: {},
    tipos_degradados: {},
  },
  // Retrato da ORIGEM ao nivel de conversa: e aqui que se prova (ou se derruba)
  // a leitura de que "arquivado = encerrado".
  conversas_origem: {
    por_kind: {},
    por_status: {},
    status_nulo: 0,
    status_sem_traducao: {},
    arquivadas: 0,
    arquivada_x_status: {},
    delegacao_multipla_usuarios: 0,
    delegacao_multipla_departamentos: 0,
    em_mais_de_uma_etapa: 0,
  },
  midia: { arquivos: 0, bytes: 0, por_tipo: {}, por_mime: {}, sem_url: 0 },
  avisos: { textos_truncados: 0, textos_com_encoding_suspeito: 0 },
  orfaos: {
    arquivos_sem_chat_no_indice: 0,
    chats_sem_arquivo_de_mensagens: 0,
    etiquetas_fora_do_catalogo: [],
    etiquetas_normalizadas: 0,
    anotacoes_assinadas_pelo_robo: 0,
    autores_desconhecidos: 0,
    envios_sem_autor_na_origem: 0,
    tipos_sem_traducao: {},
    etapas_de_funil_desconhecidas: [],
    // delegado/etapa que o resolvedor NAO casou com um alvo unico. Sao os mesmos
    // casos que aparecem como ressalva na tabela de referencias; aqui ficam
    // contados do lado do DADO GRAVADO, que e o que o operador precisa conferir.
    delegados_nao_resolvidos: 0,
    etapas_nao_resolvidas: 0,
  },
  pendencias: [],
  erros: [],
};
const pend = (tema, detalhe) => est.pendencias.push({ tema, detalhe });

// ─── CLIENTE POSTGREST ───────────────────────────────────────────────────────
// CORPO NAO LIDO SEGURA O SOCKET no undici, e este script faz DEZENAS DE MILHARES
// de requisicoes numa carga real (um POST por lote de mensagens, um por lote de
// conversas, mais o `contar` de cada tabela). Com `Prefer: return=minimal` o corpo
// nunca e lido no caminho de sucesso, e o `contar` le so o cabecalho
// `content-range` — os dois deixavam corpo pendurado. No fim, `process.exit` com
// handle em fechamento faz o Node abortar no Windows com assertion de libuv
// (exit 3221226505): a carga TERMINA CERTA e o operador le "falhou".
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

async function gravar(tabela, linhas, conflito, resolucao = "ignore-duplicates") {
  if (!linhas.length) return 0;
  if (DRY) return linhas.length;
  const r = await fetch(`${URL_BASE}/rest/v1/${tabela}?on_conflict=${conflito}`, {
    method: "POST",
    headers: { ...cabecalhos(), Prefer: `resolution=${resolucao},return=minimal` },
    body: JSON.stringify(linhas),
  });
  if (!r.ok) {
    const corpo = (await r.text()).slice(0, 300);
    throw new Error(`${tabela}: HTTP ${r.status} ${corpo}`);
  }
  await drenar(r);
  return linhas.length;
}

// contagem exata de uma tabela do destino (pra comparar origem x destino de verdade)
async function contar(tabela) {
  if (DRY) return null;
  try {
    const r = await fetch(`${URL_BASE}/rest/v1/${tabela}?select=*&limit=1`, {
      method: "GET",
      headers: { ...cabecalhos(), Prefer: "count=exact", Range: "0-0" },
    });
    const cr = r.headers.get("content-range");
    // a resposta traz UMA linha no corpo (`limit=1`) que ninguem le: so o
    // cabecalho interessa. Sem drenar, cada `contar` deixa um socket pendurado.
    await drenar(r);
    const total = cr && cr.includes("/") ? Number(cr.split("/")[1]) : null;
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

// ─── CHECKPOINT LOCAL (na pasta de trabalho, nunca num caminho fixo) ─────────
const VERSAO_CHECKPOINT = 1;
const ARQ_CHECKPOINT = path.join(TRABALHO, "checkpoint.json");
const ARQ_TRAVA = path.join(TRABALHO, "rodando.lock");
fs.mkdirSync(TRABALHO, { recursive: true });

function lerCheckpoint() {
  const zerado = { versao: VERSAO_CHECKPOINT, canal: CANAL, feitos: {}, iniciado: new Date().toISOString() };
  if (RECOMECAR || DRY || !fs.existsSync(ARQ_CHECKPOINT)) return zerado;
  const cp = lerJson(ARQ_CHECKPOINT, null);
  if (!cp || cp.versao !== VERSAO_CHECKPOINT || cp.canal !== CANAL) {
    log("checkpoint de outra versao/canal — repassando tudo (o dedupe segura)");
    return zerado;
  }
  return cp;
}
// Grava em arquivo temporario e renomeia: queda de energia no meio do write
// deixaria um checkpoint truncado, e checkpoint corrompido faz a retomada
// reimportar tudo (ou, pior, parar no meio).
const salvarCheckpoint = (cp) => {
  if (DRY) return;
  const tmp = `${ARQ_CHECKPOINT}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cp));
  fs.renameSync(tmp, ARQ_CHECKPOINT);
};

// Trava de execucao unica: duas copias no mesmo checkpoint marcam conversa como
// pronta sem terem gravado tudo.
function pegarTrava() {
  if (DRY) return;
  if (fs.existsSync(ARQ_TRAVA)) {
    const dono = lerJson(ARQ_TRAVA, {});
    let vivo = false;
    try { process.kill(dono.pid, 0); vivo = true; } catch {}
    if (vivo && dono.pid !== process.pid) {
      console.error(`\nJa existe uma importacao rodando nesta pasta (processo ${dono.pid}, desde ${dono.desde}).`);
      console.error(`Se tiver certeza de que morreu, apague: ${ARQ_TRAVA}\n`);
      process.exit(1);
    }
  }
  fs.writeFileSync(ARQ_TRAVA, JSON.stringify({ pid: process.pid, desde: new Date().toISOString() }));
  const soltar = () => { try { fs.unlinkSync(ARQ_TRAVA); } catch {} };
  process.on("exit", soltar);
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { soltar(); process.exit(130); });
}

// ─── 1) CONFIG DA CONTA (etiquetas, autoria, funis) ──────────────────────────
// O arquivo de config vem ora em `config/`, ora solto na raiz do backup — os 33
// backups tem as duas formas. `acharConfig` olha nos dois lugares; apontar so
// pra um deixava o catalogo vazio EM SILENCIO, e catalogo vazio faz toda
// etiqueta virar "fora do catalogo".
const cfgEtiquetas = lerJson(acharConfig(PASTA, "chatlist_tags.json"), []) || [];
const cfgFunis = lerJson(acharConfig(PASTA, "chatlist_funnels.json"), []) || [];
const cfgUsuarios = lerJson(acharConfig(PASTA, "users_and_groups.json"), {}) || {};

// Indices e placar de REFERENCIAS (modulo unico, scripts/importar/resolver.mjs).
// Tudo que aponta pra outra entidade — etiqueta, usuario delegado, departamento
// delegado, etapa de funil, autor de anotacao — passa por aqui, e o que nao
// resolve com UM alvo vira ressalva declarada em vez de chute.
const ix = indicesDoBackup(PASTA, { dialogos: false });
const placar = novoPlacar();

// mapa id -> nome do atendente. Serve SO pra preservar a autoria historica das
// mensagens; nenhuma conta de login e criada por este script.
const AUTORES = {};
for (const u of cfgUsuarios.users || []) {
  const id = oid(u._id) || u.id;
  if (id && (u.name || u.email)) AUTORES[id] = corta(u.name || u.email, 120);
}
for (const g of cfgUsuarios.groups || []) {
  const id = oid(g._id) || g.id;
  if (id && g.name) AUTORES[id] = corta(g.name, 120);
}

// catalogo de etiquetas: nomes vindos do arquivo de configuracao
const catalogo = new Set();
for (const t of cfgEtiquetas) {
  const nome = corta(typeof t === "string" ? t : t.text || t.name || "", 100).trim();
  if (nome) catalogo.add(nome);
}
const etiquetasDoArquivo = new Set(catalogo);

// Cor da etapa: o painel tem a coluna (hex #RRGGBB, com CHECK no banco), mas o
// export do ChatGuru so traz id e nome — varridos os backups disponiveis, NENHUMA
// etapa veio com cor. Entao lemos a cor QUANDO ela existir, tolerando os nomes de
// campo mais provaveis e o hex de 3 digitos, e nao inventamos cor quando nao vem:
// etapa sem cor fica NULL e a tela escolhe o default. Prometer cor que a origem
// nao tem seria pior que nao ter.
const corDaEtapa = (s) => {
  const bruto = String(s?.color ?? s?.cor ?? s?.bg_color ?? s?.background ?? "").trim();
  if (!bruto) return null;
  const hex = bruto.startsWith("#") ? bruto : `#${bruto}`;
  if (/^#[0-9A-Fa-f]{6}$/.test(hex)) return hex.toUpperCase();
  // #abc -> #AABBCC
  if (/^#[0-9A-Fa-f]{3}$/.test(hex)) {
    return `#${hex.slice(1).split("").map((c) => c + c).join("")}`.toUpperCase();
  }
  return null; // formato que o CHECK do banco recusaria nao sobe
};

// funis normalizados (viram arquivo; quem grava no banco e o 2o passo, funis.mjs)
const funisNormalizados = (Array.isArray(cfgFunis) ? cfgFunis : []).map((f) => ({
  id_origem: f.id,
  nome: corta(f.name || "", 200),
  etapas: (f.steps || []).map((s, i) => ({
    id_origem: s.id,
    nome: corta(s.name || "", 200),
    ordem: i + 1,
    ...(corDaEtapa(s) ? { cor: corDaEtapa(s) } : {}),
  })),
}));
// NAO existe um mapa id -> "Funil / Etapa" aqui, e a ausencia e proposital: esse
// mapa existia, so conhecia id, e era ELE que a linha de conversa usava enquanto o
// placar media por outra rota. Quem precisa do rotulo pede ao resolvedor
// (`resolverEtapa(...).item` + `ref.funil_nome`), que e a unica fonte.

est.origem.etiquetas_no_catalogo = etiquetasDoArquivo.size;
est.origem.usuarios = Object.keys(AUTORES).length;
est.origem.funis = funisNormalizados.length;
est.origem.etapas_de_funil = funisNormalizados.reduce((a, f) => a + f.etapas.length, 0);
est.origem.etapas_com_cor = funisNormalizados.reduce((a, f) => a + f.etapas.filter((s) => s.cor).length, 0);

// Medido nos 33 backups: 6 contas nao tem chatlist_funnels.json e 4 nao tem
// chatlist_tags.json. Nao e defeito do importador — e o que a exportacao trouxe;
// o que nao pode e passar calado.
if (!acharConfig(PASTA, "chatlist_tags.json"))
  pend("etiquetas", "o backup nao tem chatlist_tags.json — o catalogo sai so das etiquetas usadas nas conversas");
if (!acharConfig(PASTA, "chatlist_funnels.json"))
  pend("funis", "o backup nao tem chatlist_funnels.json — nenhum funil normalizado");
if (!acharConfig(PASTA, "users_and_groups.json"))
  pend("autoria", "o backup nao tem users_and_groups.json — mensagens enviadas ficam sem nome de autor");

// ─── 2) INDICE DE CONVERSAS ──────────────────────────────────────────────────
const indice = lerJson(path.join(PASTA, "chats_index.json"), null);
if (!indice || !Array.isArray(indice.chats)) {
  console.error(`nao consegui ler ${path.join(PASTA, "chats_index.json")} — a pasta e mesmo um backup do ChatGuru?`);
  process.exit(2);
}
const chats = LIMITE ? indice.chats.slice(0, LIMITE) : indice.chats;
est.origem.conversas_no_indice = indice.chats.length;
est.origem.conversas_processadas = chats.length;
est.origem.ativos = indice.total_ativos ?? null;
est.origem.arquivados = indice.total_arquivados ?? null;

const porIdOrigem = new Map(); // id do ChatGuru -> registro do indice
for (const c of chats) porIdOrigem.set(c.id, c);

// ─── 3) LOOP PRINCIPAL ───────────────────────────────────────────────────────
log(`=== IMPORTACAO CHATGURU -> ${SCHEMA}.${T.conversas}/${T.mensagens} (canal ${CANAL})${DRY ? "  [DRY RUN]" : ""}`);
log(`origem: ${PASTA}`);
if (!DRY) log(`destino: ${est.destino_host}`);
log(`conversas no indice: ${indice.chats.length}${LIMITE ? ` (processando ${chats.length} por --limite)` : ""}`);

pegarTrava();
const cp = lerCheckpoint();

// contagem do destino ANTES (pra medir o que de fato entrou)
est.destino.antes = SO_CONFIG || DRY
  ? null
  : { conversas: await contar(T.conversas), mensagens: await contar(T.mensagens) };

// --- config primeiro: catalogo de etiquetas + autoria historica
const dirMensagens = path.join(PASTA, "messages");
const arquivos = fs.existsSync(dirMensagens) ? fs.readdirSync(dirMensagens).filter((f) => f.endsWith(".json")) : [];
est.origem.arquivos_de_mensagens = arquivos.length;

// Uma passada pelo indice de conversas que faz duas coisas: monta o catalogo de
// etiquetas (as do arquivo E as usadas) e MEDE a origem — e a medicao que sustenta
// as decisoes do relatorio, em vez de deixa-las como opiniao.
const usadas = new Set();
// texto da etiqueta como veio -> nome que vale no painel (o do catalogo quando
// o resolvedor casou; o proprio texto quando nao existe catalogo pra ela)
const canonicoEtiqueta = new Map();
// id da conversa na origem -> referencias JA RESOLVIDAS (nomes de responsavel e
// rotulos "Funil / Etapa"). E o que a linha de conversa consome no loop principal:
// resolver duas vezes duplicaria o placar, e resolver por outra rota foi o defeito.
const resolvidoPorChat = new Map();
const co = est.conversas_origem;
for (const c of chats) {
  const kind = String(c.kind || "(sem kind)");
  co.por_kind[kind] = (co.por_kind[kind] || 0) + 1;

  const bruto = c.status === null || c.status === undefined || c.status === "" ? null : String(c.status);
  const rotuloStatus = bruto ?? "(nulo)";
  co.por_status[rotuloStatus] = (co.por_status[rotuloStatus] || 0) + 1;
  if (bruto === null) co.status_nulo++;
  else if (!STATUS[bruto.toUpperCase()]) co.status_sem_traducao[bruto] = (co.status_sem_traducao[bruto] || 0) + 1;

  if (c.archived) co.arquivadas++;
  const cruz = `${c.archived ? "arquivada" : "ativa"} x ${rotuloStatus}`;
  co.arquivada_x_status[cruz] = (co.arquivada_x_status[cruz] || 0) + 1;

  if ((c.users_delegated_ids || []).length > 1) co.delegacao_multipla_usuarios++;
  if ((c.groups_delegated_ids || []).length > 1) co.delegacao_multipla_departamentos++;
  if ((c.funnel_steps_ids || []).length > 1) co.em_mais_de_uma_etapa++;

  for (const t of c.tags || []) {
    const nome = corta(typeof t === "string" ? t : t.text || t.name || "", 100).trim();
    if (!nome) continue;
    // ETIQUETA VEM DENORMALIZADA E SEM ID: a unica chave e o texto, e ao longo
    // dos anos a mesma etiqueta aparece escrita de formas diferentes. Quando o
    // resolvedor acha a do catalogo, quem vale e o nome do CATALOGO — senao
    // "cliente" e "Cliente" viram duas etiquetas diferentes no painel novo, que
    // e exatamente a armadilha que o modulo 7 descreve.
    const r = resolverEtiqueta(ix, placar, nome);
    const canonico = r.item ? corta(r.item.nome, 100).trim() || nome : nome;
    canonicoEtiqueta.set(nome, canonico);
    if (canonico !== nome) est.orfaos.etiquetas_normalizadas++;
    usadas.add(canonico);
    if (!r.item && !est.orfaos.etiquetas_fora_do_catalogo.includes(nome))
      est.orfaos.etiquetas_fora_do_catalogo.push(nome);
  }
  // O QUE ENTRA NO BANCO SAI DAQUI, do MESMO resolvedor que mede — nao de uma
  // segunda rota paralela. Custou uma reprovacao em revisao cega: o placar
  // resolvia delegacao e etapa por id -> nome -> posicao, enquanto a linha de
  // conversa era montada com `AUTORES[oid(id)]` e `nomeEtapa.get(id)`, dois mapas
  // que SO conhecem id. Nos 33 backups medidos os dois caminhos concordam (133.371
  // de 133.373 usuarios e 263.331 de 263.331 etapas casam por id), mas concordar
  // hoje nao e garantia: no backup que trouxesse o ROTULO no lugar do id, o placar
  // diria "resolvido por nome" e o banco receberia delegacao VAZIA e etapa sem o
  // prefixo do funil — o que faz `funis.mjs` nao casar. Uma rota so, e a medida
  // passa a falar do dado gravado.
  const resolvidos = { responsaveis: [], responsaveis_mortos: [], etapas: [], etapas_mortas: [] };
  for (const u of c.users_delegated_ids || []) {
    const r = resolverUsuario(ix, placar, u);
    if (r.item?.nome) resolvidos.responsaveis.push(corta(r.item.nome, 120));
    else {
      resolvidos.responsaveis_mortos.push(String(oid(u) ?? u));
      est.orfaos.delegados_nao_resolvidos++;
    }
  }
  for (const g of c.groups_delegated_ids || []) {
    const r = resolverDepartamento(ix, placar, g);
    if (r.item?.nome) resolvidos.responsaveis.push(corta(r.item.nome, 120));
    else {
      resolvidos.responsaveis_mortos.push(String(oid(g) ?? g));
      est.orfaos.delegados_nao_resolvidos++;
    }
  }
  for (const s of c.funnel_steps_ids || []) {
    const r = resolverEtapa(ix, placar, s);
    // O rotulo tem que sair no formato que `funis.mjs` casa: "Funil / Etapa".
    // O funil vem do indice (`funil_nome`), nunca de um segundo mapa.
    const funil = r.item?.ref?.funil_nome;
    if (r.item?.nome && funil) resolvidos.etapas.push(`${funil} / ${r.item.nome}`);
    else {
      // valor CRU so aqui, e contado: funis.mjs ainda casa etapa por id de origem,
      // entao o id preserva a chance de ligacao — o que ele nao pode e passar por
      // rotulo resolvido.
      // MESMA normalizacao da linha de cima (`String(oid(s) ?? s)`): a referencia
      // chega ora como string, ora como `{$oid}`. Empurrar o valor CRU aqui fazia
      // o dedupe por `includes` comparar objeto com string — dois formatos do
      // MESMO id viravam duas entradas, e um objeto no relatorio sai como
      // "[object Object]" em vez do identificador que o operador precisa buscar.
      const idEtapa = String(oid(s) ?? s);
      resolvidos.etapas.push(idEtapa);
      est.orfaos.etapas_nao_resolvidas++;
      if (!est.orfaos.etapas_de_funil_desconhecidas.includes(idEtapa))
        est.orfaos.etapas_de_funil_desconhecidas.push(idEtapa);
    }
  }
  resolvidoPorChat.set(c.id, resolvidos);
}
// ARQUIVADO NAO E DESCARTE. Na conta da Expert 19.295 das 19.992 conversas estao
// arquivadas, e o cruzamento arquivada x status mostra por que: 99,94% delas
// estao em RESOLVIDO ou FECHADO — a conta arquiva sozinha ao encerrar. Importador
// que tratasse arquivado como lixo jogaria fora a operacao inteira. Aqui elas
// entram com `arquivada: true` e o status que a origem deu; o relatorio publica o
// cruzamento pra que a leitura seja conferivel, nao acreditada.
if (co.arquivadas) {
  const encerradas = Object.entries(co.arquivada_x_status)
    .filter(([k]) => k.startsWith("arquivada x") && /RESOLVIDO|FECHADO/i.test(k))
    .reduce((a, [, v]) => a + v, 0);
  const abertasArquivadas = co.arquivadas - encerradas;
  pend(
    "conversas arquivadas",
    `${co.arquivadas} conversa(s) chegam arquivadas e TODAS entram (arquivado na origem significa encerrado, ` +
      `nao descarte): ${encerradas} tem status de encerramento e ${abertasArquivadas} estao arquivadas SEM ` +
      `estar encerradas — essas ficam com o status que a origem deu, sem correcao nossa. Ver o cruzamento ` +
      `"arquivada x status" no relatorio.`
  );
}
if (co.status_nulo)
  pend(
    "status",
    `${co.status_nulo} conversa(s) tem status nulo na origem e entram como "aberto"; o valor original ` +
      `fica em meta_chatguru.status_original (null), pra que a decisao seja rastreavel.`
  );
if (Object.keys(co.status_sem_traducao).length)
  pend(
    "status",
    `status da origem sem traducao no painel: ${Object.entries(co.status_sem_traducao)
      .map(([k, v]) => `${k} (${v})`)
      .join(", ")}. Entram como "aberto" — conferir antes de liberar a conta.`
  );
// DELEGACAO E LISTA, e essa lista NAO vira responsavel no painel de proposito.
// A pendencia sai tambem com UM delegado nao resolvido — nao so com delegacao
// multipla: um delegado que nao casa com ninguem e responsavel que DESAPARECE da
// ficha, e sair calado e o que faz o operador descobrir depois do corte.
if (
  co.delegacao_multipla_usuarios ||
  co.delegacao_multipla_departamentos ||
  est.orfaos.delegados_nao_resolvidos
)
  pend(
    "responsaveis",
    (est.orfaos.delegados_nao_resolvidos
      ? `${est.orfaos.delegados_nao_resolvidos} delegado(s) NAO casaram com nenhum usuario/departamento da lista ` +
        `exportada e por isso nao viraram nome na ficha — o identificador cru fica em ` +
        `meta_chatguru.responsaveis_nao_resolvidos, pra revisao. `
      : "") +
      `${co.delegacao_multipla_usuarios} conversa(s) tem mais de um usuario delegado e ` +
      `${co.delegacao_multipla_departamentos} mais de um departamento. A lista INTEIRA e preservada em ` +
      `meta_chatguru.responsaveis (nada e perdido), e a coluna responsavel_nome recebe o primeiro como ` +
      `espelho legado. A tabela conversa_responsaveis NAO e escrita pelo importador: ela liga responsavel ` +
      `por id de USUARIO DO PAINEL, e atendente historico nao tem conta — gravar id que nao existe deixaria ` +
      `a conversa invisivel pra quem tem escopo restrito (conversa sem responsavel e visivel pra todos). ` +
      `Religar responsavel e passo humano, depois de criar as contas.`
  );
if (co.em_mais_de_uma_etapa)
  pend(
    "funis",
    `${co.em_mais_de_uma_etapa} conversa(s) estao em mais de uma etapa de funil ao mesmo tempo. Todas as ` +
      `etapas viajam em meta_chatguru.funil_etapas; quem as grava em conversa_funil e o segundo passo (funis.mjs).`
  );
if (est.orfaos.etapas_nao_resolvidas)
  pend(
    "funis",
    `${est.orfaos.etapas_nao_resolvidas} referencia(s) de etapa nao casaram com o catalogo de funis exportado. ` +
      `Elas viajam em meta_chatguru.funil_etapas com o IDENTIFICADOR CRU no lugar do rotulo "Funil / Etapa" — ` +
      `o funis.mjs ainda tenta casar por identificador de origem, entao a ligacao nao esta perdida; o que falta ` +
      `e o catalogo. Se o backup nao tiver chatlist_funnels.json completo, reexportar antes do corte.`
  );

// o painel so aceita etiqueta que existe no catalogo: sobem as do arquivo E as usadas
for (const n of usadas) catalogo.add(n);
est.origem.etiquetas_usadas_em_conversas = usadas.size;
// so vira numero depois que o POST responder OK; falha deixa null e o relatorio
// mostra "falhou" em vez de um OK mentiroso
est.destino.etiquetas_catalogo = null;
est.destino.autores = null;

if (est.orfaos.etiquetas_fora_do_catalogo.length)
  pend(
    "etiquetas",
    `${est.orfaos.etiquetas_fora_do_catalogo.length} etiqueta(s) aparecem em conversas mas nao estao no catalogo exportado; entram no catalogo mesmo assim pra nao perder a marcacao (revisar e desativar as indesejadas nas Configuracoes)`
  );

try {
  const n = await gravar(
    "etiquetas_catalogo",
    [...catalogo].map((nome) => ({ nome, ativo: true })),
    "nome",
    "ignore-duplicates"
  );
  est.destino.etiquetas_catalogo = n;
  log(`catalogo de etiquetas: ${n} nome(s)`);
} catch (e) {
  est.erros.push(`etiquetas_catalogo: ${e.message}`);
  log(`ERRO no catalogo de etiquetas: ${e.message}`);
}

// autoria historica: fica guardada na tabela generica de config da instalacao.
// NAO cria conta de login — e so o mapa que o relatorio e o painel usam pra
// mostrar quem era quem no sistema antigo.
try {
  await gravar(
    "config",
    [
      {
        chave: "importacao_chatguru_autores",
        valor: { importado_em: new Date().toISOString(), canal: CANAL, autores: AUTORES },
        updated_at: new Date().toISOString(),
      },
    ],
    "chave",
    "merge-duplicates"
  );
  est.destino.autores = Object.keys(AUTORES).length;
  log(`autoria historica: ${est.destino.autores} nome(s)`);
} catch (e) {
  est.erros.push(`config/autores: ${e.message}`);
  log(`ERRO ao gravar a autoria historica: ${e.message}`);
}

// funis: nao ha tabela no painel. Sai arquivo normalizado + pendencia + DDL proposto.
const arqFunis = path.join(TRABALHO, "funis-normalizados.json");
fs.writeFileSync(arqFunis, JSON.stringify({ gerado_em: est.gerado_em, canal: CANAL, funis: funisNormalizados }, null, 2));
est.destino.funis_arquivo = arqFunis;
if (funisNormalizados.length)
  pend(
    "funis",
    `${funisNormalizados.length} funil(is) e ${est.origem.etapas_de_funil} etapa(s) ficaram normalizados em ${arqFunis}: quem os grava no banco e o SEGUNDO passo, "node scripts/importar/funis.mjs --pasta <esta pasta>" (exige a migration supabase/migrations/0009_funis.sql aplicada — rodar DDL e gesto humano do dono do banco).`
  );

if (SO_CONFIG) {
  log("--so-config: parando antes das mensagens");
} else {
  // --- mensagens e conversas
  let bufMsgs = [];
  let bufConversas = [];
  let pendentes = []; // chats cujas linhas ainda nao foram descarregadas
  // contagem = so o que foi gravado de fato (sobe no flush bem-sucedido)
  const contagem = { conversas: 0, entrada: 0, saida: 0, notas: 0, puladas: 0, midia: 0 };
  // mapeado = o que a leitura do backup produziu, tenha ido pro banco ou nao
  const mapeado = { conversas: 0, entrada: 0, saida: 0, notas: 0, midia: 0 };
  const dump = { conversas: [], mensagens: [] };
  const porTipo = {};
  let maisAntiga = null;
  let maisRecente = null;
  let itensLidos = 0; // tudo que o backup tem, antes de qualquer filtro

  // Estado ATUAL das conversas no destino. Sem isto o upsert rebobina conversa
  // viva pro passado: um atendimento em andamento voltaria pra "aberto" e o topo
  // da lista pularia pra data do backup.
  const estadoNoDestino = async (chatIds) => {
    const mapa = new Map();
    if (DRY || !chatIds.length) return mapa;
    // fatia pequena de proposito: `in.()` com lote inteiro estoura a URL do PostgREST
    for (let i = 0; i < chatIds.length; i += 100) {
      const lista = chatIds.slice(i, i + 100).map((id) => `"${String(id).replace(/"/g, '""')}"`).join(",");
      const r = await fetch(
        `${URL_BASE}/rest/v1/${T.conversas}?select=chat_id,last_message_at,nome,foto_url,etiquetas,` +
          `responsavel_id,responsavel_nome&chat_id=in.(${encodeURIComponent(lista)})`,
        { headers: cabecalhos() }
      );
      if (!r.ok) throw new Error(`leitura de ${T.conversas}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      for (const linha of await r.json()) mapa.set(linha.chat_id, linha);
    }
    return mapa;
  };

  // O mesmo telefone aparece mais de uma vez no indice (entrada ativa e
  // arquivada). Mandar as duas no MESMO upsert e erro 21000 do Postgres
  // ("ON CONFLICT nao pode afetar a linha duas vezes"), que derruba o lote
  // inteiro toda vez. Colapsa antes, ficando com a conversa mais recente.
  const colapsarPorChatId = (linhas) => {
    const porChat = new Map();
    for (const l of linhas) {
      const atual = porChat.get(l.chat_id);
      if (!atual || String(l.last_message_at || "") > String(atual.last_message_at || "")) porChat.set(l.chat_id, l);
    }
    est.descartados.conversas_colapsadas += linhas.length - porChat.size;
    return [...porChat.values()];
  };

  // O que NAO pode pisar em dado vivo do painel quando a conversa ja existe la.
  //
  // A regra que a revisao cega cobrou: o upsert e `merge-duplicates`, entao TODA
  // chave presente SOBRESCREVE o destino. Numa re-execucao (retomada, correcao,
  // segunda leva do backup) isso apagava trabalho humano feito depois da primeira
  // carga — etiqueta posta na ficha, nome corrigido, responsavel de verdade. Nada
  // disso e "dado do backup vencendo": e o backup, que e mais VELHO, vencendo o
  // painel, que e o presente.
  //
  // Criterio por campo (e por que este e nao "sempre omitir"):
  //   nome / foto_url / responsavel_nome -> o backup so preenche o que esta VAZIO
  //     no destino. Assim a primeira carga sobre uma conversa que a Z-API criou
  //     sem nome ainda funciona, e a segunda nao desfaz correcao nenhuma.
  //   etiquetas -> UNIAO com o destino, nunca substituicao: a etiqueta historica
  //     tem que entrar E a que a equipe adicionou tem que ficar. Uniao identica ao
  //     destino nem viaja (menos chave = menos grupo no `porAssinatura`).
  //   responsavel_nome tambem cede quando existe `responsavel_id`: id preenchido
  //     significa responsavel DE VERDADE, com conta no painel — o espelho legado
  //     do atendente historico nao passa na frente dele.
  const vazio = (v) => v === null || v === undefined || String(v).trim() === "";
  const ajustarAoDestino = (linha, destino) => {
    if (!destino) return linha; // conversa nova: entra inteira
    const ajustada = { ...linha };
    // atendimento e arquivo sao estado VIVO — o backup nao manda neles
    delete ajustada.status;
    delete ajustada.arquivada;
    delete ajustada.created_at;
    delete ajustada.canal; // rotulo de origem ja definido por quem criou a linha

    if ("nome" in ajustada && !vazio(destino.nome)) {
      delete ajustada.nome;
      est.destino.preservado_do_painel.nome++;
    }
    if ("foto_url" in ajustada && !vazio(destino.foto_url)) {
      delete ajustada.foto_url;
      est.destino.preservado_do_painel.foto_url++;
    }
    if ("responsavel_nome" in ajustada && (!vazio(destino.responsavel_nome) || !vazio(destino.responsavel_id))) {
      delete ajustada.responsavel_nome;
      est.destino.preservado_do_painel.responsavel_nome++;
    }
    if ("etiquetas" in ajustada) {
      const doDestino = Array.isArray(destino.etiquetas)
        ? destino.etiquetas.map((t) => String(t)).filter(Boolean)
        : [];
      // destino primeiro: a ordem que a equipe ve na ficha nao embaralha
      const uniao = [...new Set([...doDestino, ...ajustada.etiquetas])];
      if (uniao.length === doDestino.length && uniao.every((t, i) => t === doDestino[i])) {
        delete ajustada.etiquetas; // nada a acrescentar
      } else {
        if (doDestino.length) est.destino.preservado_do_painel.etiquetas_unidas++;
        ajustada.etiquetas = uniao;
      }
    }

    const maisNovo =
      linha.last_message_at && (!destino.last_message_at || linha.last_message_at > destino.last_message_at);
    if (!maisNovo) {
      delete ajustada.last_message_at;
      delete ajustada.last_message_preview;
      delete ajustada.updated_at;
    }
    return ajustada;
  };

  // O PostgREST recusa lote com objetos de CHAVES DIFERENTES: devolve 400 "All
  // object keys must match" e o lote inteiro morre. E a linha de conversa tem
  // chave variavel de proposito — chave AUSENTE preserva o dado vivo do painel,
  // chave com null o apagaria — entao duas conversas do mesmo lote quase nunca
  // tem o mesmo conjunto de chaves. A saida e agrupar por assinatura de chaves e
  // mandar um POST por grupo: mantem a semantica de omissao E o lote grande.
  // (Erro que so aparece na GRAVACAO: o dry run nao monta requisicao nenhuma.)
  const porAssinatura = (linhas) => {
    const grupos = new Map();
    for (const l of linhas) {
      const k = Object.keys(l).sort().join("|");
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(l);
    }
    return [...grupos.values()];
  };

  const descarregar = async () => {
    if (bufMsgs.length) {
      for (let i = 0; i < bufMsgs.length; i += LOTE) {
        const fatia = bufMsgs.slice(i, i + LOTE);
        for (const grupo of porAssinatura(fatia)) {
          await gravar(T.mensagens, grupo, "provider_msg_id", "ignore-duplicates");
        }
        if (DUMP) dump.mensagens.push(...fatia);
      }
      bufMsgs = [];
    }
    if (bufConversas.length) {
      const linhas = colapsarPorChatId(bufConversas);
      for (let i = 0; i < linhas.length; i += LOTE) {
        const fatia = linhas.slice(i, i + LOTE);
        const destino = await estadoNoDestino(fatia.map((l) => l.chat_id));
        const prontas = fatia.map((l) => ajustarAoDestino(l, destino.get(l.chat_id)));
        for (const grupo of porAssinatura(prontas)) {
          await gravar(T.conversas, grupo, "chat_id", "merge-duplicates");
        }
        if (DUMP) dump.conversas.push(...prontas);
        est.destino.gravado.conversas += fatia.length;
      }
      bufConversas = [];
    }
    // so agora as conversas do bloco viram "feitas" — se cair antes, repassa.
    // As contagens tambem so sobem aqui: lote que falhou nao vira "gravado".
    for (const p of pendentes) {
      cp.feitos[p.idOrigem] = p.linhas;
      contagem.entrada += p.entrada;
      contagem.saida += p.saida;
      contagem.notas += p.notas;
      contagem.midia += p.midia;
      contagem.conversas++;
      est.destino.gravado.mensagens += p.linhas;
    }
    pendentes = [];
    salvarCheckpoint(cp);
  };

  const comArquivo = new Set();

  for (const f of arquivos) {
    // Com --limite, o que esta fora do recorte pode ser descartado SEM abrir o
    // arquivo (o nome do arquivo e o id da conversa). Sem esse atalho, um teste
    // curto de 3 conversas ainda parsearia os 200 mil arquivos da conta —
    // medido: minutos de espera pra uma conferencia que deveria ser instantanea.
    // Sem --limite nada e pulado por nome: e a passada completa que detecta o
    // arquivo orfao, cujo chat_id interno pode nao casar com o nome do arquivo.
    if (LIMITE && !porIdOrigem.has(f.replace(/\.json$/, ""))) continue;
    const bruto = lerJson(path.join(dirMensagens, f), null);
    if (!bruto) { est.erros.push(`arquivo ilegivel: ${f}`); continue; }
    const idOrigem = bruto.chat_id || f.replace(/\.json$/, "");
    comArquivo.add(idOrigem);
    const c = porIdOrigem.get(idOrigem);
    if (!c) {
      // arquivo de conversa que nao esta no indice processado: no modo --limite isso
      // e esperado; sem --limite e orfao de verdade
      if (!LIMITE) est.orfaos.arquivos_sem_chat_no_indice++;
      continue;
    }
    if (cp.feitos[idOrigem] !== undefined) { contagem.puladas++; continue; }

    // CONVERSA DE TRANSMISSAO (lista de difusao) nao e conversa com ninguem, e o
    // `wa_chat_id` dela nao e telefone: e um TIMESTAMP unix (1685887687 =
    // 04/06/2023). Importar viraria um "contato" com numero falso no painel, e
    // quem respondesse ali mandaria mensagem pra um numero que nao existe.
    // Entao nao entra — e o relatorio diz quantas eram e quantos itens tinham,
    // pra que a ausencia seja declarada, nunca silenciosa.
    if (String(c.kind) === "broadcast") {
      est.descartados.conversas_de_transmissao++;
      est.descartados.itens_em_conversas_de_transmissao += (bruto.messages_and_notes || []).length;
      continue;
    }

    const chatId = chatIdPainel(c);
    if (!chatId) { est.erros.push(`conversa sem identificador utilizavel: ${idOrigem}`); continue; }
    const grupo = ehGrupo(c);

    const linhas = [];
    let indiceItem = -1;
    let midiaNaConversa = 0;
    for (const item of bruto.messages_and_notes || []) {
      indiceItem++;
      itensLidos++;
      if (item.type === "note") {
        const n = item.n || {};
        const texto = corta(limparHtml(n.text), TETO_CONTEUDO);
        if (!texto) { est.descartados.sem_conteudo++; continue; }
        const quando = dt(item.date) || dt(n.date);
        if (!quando) { est.descartados.sem_data++; continue; }
        // AUTOR DE ANOTACAO E TEXTO LIVRE, nunca identificador. Sao 72 nomes
        // distintos na conta da Expert: "Chatbot" assina 92%, 11 casam com
        // usuario ativo e 60 nao casam com ninguem (gente que saiu). O resolvedor
        // faz o casamento por nome normalizado — "Ana souza" acha "Ana Souza" —
        // e nome ambiguo/morto vira RESSALVA no relatorio. O que NUNCA acontece:
        // perder o texto do autor. Nao casou = a anotacao guarda o nome como
        // veio, e a ressalva diz que ele nao tem dono no cadastro novo.
        let autor = null;
        if (n.author !== undefined && n.author !== null && String(n.author) !== "") {
          // "Chatbot" assina 92% das anotacoes na conta da Expert: nao e gente,
          // e nao ha usuario pra casar. Conta separado pra que a taxa de
          // casamento fale das PESSOAS, que e onde mora o trabalho de revisao.
          if (ehAutorDeSistema(n.author)) est.orfaos.anotacoes_assinadas_pelo_robo++;
          const r = resolverAutorNota(ix, placar, n.author);
          autor = r.item ? corta(r.item.nome, 120) : corta(n.author, 120) || null;
          // id de 24 hex que nao casou nao e nome de gente: nao serve de autoria
          if (!r.item && /^[a-f0-9]{24}$/i.test(String(n.author))) autor = null;
        }
        if (!autor) est.orfaos.autores_desconhecidos++;
        // As chaves desta linha tem que ser IDENTICAS as da linha de mensagem:
        // anotacao e mensagem vao no MESMO lote de insercao, e o PostgREST
        // recusa lote com objetos de chaves diferentes ("All object keys must
        // match") — o lote inteiro morreria com 400 na primeira gravacao de
        // verdade. Aqui faltava `enviado_por_id` e sobrariam as colunas novas.
        linhas.push({
          chat_id: chatId,
          direcao: "interna",
          tipo: "nota",
          conteudo: texto,
          sender_name: autor,
          sender_phone: null,
          provider_msg_id: `cgnota:${n.id || `${idOrigem}:${quando}:${indiceItem}`}`,
          status: "interna",
          criada_em: quando,
          enviado_por_id: null,
          enviado_por_nome: autor,
          media_url: null,
          media_mime: null,
          quoted_msg_id: null,
          reacao: null,
          editada_em: null,
          encaminhada: false,
          is_deleted: false,
          raw: null,
        });
        continue;
      }

      const m = item.m || {};
      // `deleted`/`hide` = a propria origem esconde o item (nunca foi visivel).
      // Diferente de `type: revoked`, que e mensagem que EXISTIU e o cliente
      // apagou pra todos — essa entra marcada, logo abaixo.
      if (m.deleted || m.hide) { est.descartados.apagadas++; continue; }
      if (IGNORADOS.has(m.type)) {
        est.descartados.tipo_ignorado[m.type] = (est.descartados.tipo_ignorado[m.type] || 0) + 1;
        continue;
      }
      const revogada = APAGADA_NA_ORIGEM.has(m.type);
      const degradado = !revogada && !TIPO[m.type] && TIPO_DEGRADADO[m.type] ? m.type : null;
      const tipo = revogada ? "text" : TIPO[m.type] || TIPO_DEGRADADO[m.type] || "unknown";
      if (degradado)
        est.preservados.tipos_degradados[degradado] = (est.preservados.tipos_degradados[degradado] || 0) + 1;
      if (tipo === "unknown")
        est.orfaos.tipos_sem_traducao[m.type] = (est.orfaos.tipos_sem_traducao[m.type] || 0) + 1;
      const quando = dt(m.timestamp) || dt(m.created) || dt(m.send_date);
      if (!quando) { est.descartados.sem_data++; continue; }

      const arquivo = m.file || null;
      // URL de terceiro so entra se for https (o painel bloqueia o resto na renderizacao)
      const mediaUrl = urlDoArquivo(arquivo);
      if (arquivo && !mediaUrl) { est.descartados.midia_sem_url++; est.midia.sem_url++; }
      if (mediaUrl) {
        midiaNaConversa++;
        // Inventario da midia: e o insumo do passo de re-hospedagem (midia.mjs).
        est.midia.arquivos++;
        est.midia.bytes += Number(arquivo?.size) > 0 ? Number(arquivo.size) : 0;
        est.midia.por_tipo[tipo] = (est.midia.por_tipo[tipo] || 0) + 1;
        const mime = String(arquivo?.mime || "(sem mime)");
        est.midia.por_mime[mime] = (est.midia.por_mime[mime] || 0) + 1;
      }

      const texto = m.text && m.text !== m.type ? m.text : arquivo?.caption || null;
      const saiu = !!m.is_out;
      const idAutor = saiu ? oid(m.author) : null;
      const autor = idAutor ? AUTORES[idAutor] || null : null;
      // duas causas MUITO diferentes: envio de robo/campanha (nunca teve autor na
      // origem) x atendente que existiu e nao veio na exportacao de usuarios.
      if (saiu && !idAutor) est.orfaos.envios_sem_autor_na_origem++;
      else if (saiu && !autor) est.orfaos.autores_desconhecidos++;
      const remetente = String(m.wa_sender_id || "").replace(/@.*$/, "");

      porTipo[tipo] = (porTipo[tipo] || 0) + 1;

      // o que a mensagem carrega alem do texto
      const citada = m.quotes_wa_message_id ? corta(m.quotes_wa_message_id, 200) : null;
      const reacao = reacaoDe(m);
      const editada = editadaEm(m);
      const encaminhada = m.is_forwarded === true;
      const extra = qualificadores(m);
      // Estado de entrega: o ack do WhatsApp e a unica fonte real. `error` vence
      // o ack (mensagem que falhou nao "foi lida"), e mensagem recebida usa o
      // vocabulario do painel.
      const estadoBruto = saiu
        ? String(m.status) === "error"
          ? "error"
          : ACK[Number(m.ack)] || m.status || "sent"
        : "received";
      const estado = saiu && !ENTREGA.has(estadoBruto) ? "sent" : estadoBruto;
      if (estado !== estadoBruto)
        est.preservados.estado_de_entrega_sem_traducao[estadoBruto] =
          (est.preservados.estado_de_entrega_sem_traducao[estadoBruto] || 0) + 1;

      if (texto && ENCODING_SUSPEITO.test(String(texto))) est.avisos.textos_com_encoding_suspeito++;

      linhas.push({
        chat_id: chatId,
        direcao: saiu ? "out" : "in",
        tipo,
        // Mensagem apagada pra todos nao tem texto pra mostrar: entra sem
        // conteudo e o painel desenha a bolha mascarada por causa de is_deleted.
        conteudo: revogada ? null : corta(texto || ROTULO_TIPO[tipo] || "[mensagem]", TETO_CONTEUDO),
        sender_name: saiu ? null : corta(m.sender_name || "", 120) || null,
        sender_phone: saiu ? null : (grupo ? remetente || null : chatId),
        // Sem wa_message_id e sem _id o fallback TEM que continuar unico: um id
        // constante colapsaria todas essas mensagens numa linha so, em silencio,
        // porque o dedupe do banco e por provider_msg_id.
        provider_msg_id: m.wa_message_id || `cg:${oid(m._id) || `${idOrigem}:${quando}:${indiceItem}`}`,
        status: estado,
        criada_em: quando,
        // autoria historica do time; o id fica NULL de proposito (nao ha conta de login)
        enviado_por_id: null,
        enviado_por_nome: autor,
        media_url: mediaUrl,
        media_mime: (arquivo && arquivo.mime) || null,
        // A citacao viaja pelo id do WhatsApp, que e o mesmo que o painel usa em
        // provider_msg_id — entao o "responder a" continua apontando pra
        // mensagem certa depois da importacao.
        quoted_msg_id: citada,
        reacao,
        editada_em: editada,
        encaminhada,
        is_deleted: revogada,
        raw: extra,
      });
    }

    // o backup repete mensagem entre paginas: deduplica antes de mandar
    const unicas = new Map();
    for (const l of linhas) if (l.provider_msg_id) unicas.set(l.provider_msg_id, l);
    const finais = [...unicas.values()];
    est.descartados.duplicadas_no_backup += linhas.length - finais.length;

    // A CITACAO VEM EM DOIS FORMATOS, E O IDENTIFICADOR DA MENSAGEM EM UM SO.
    // Na conta da Expert TODO `wa_message_id` e o hex nu ("3EB0..."), zero
    // prefixado (amostra de 600 conversas, 132.052 mensagens) — mas parte das
    // citacoes vem no formato longo "false_<jid>_<hex>", e comparar cru fazia
    // essas entrarem com `quoted_msg_id` que nao casa com NENHUM
    // `provider_msg_id` do painel: a bolha "responder a" apontava pro vazio de uma
    // mensagem que ESTA importada ali do lado.
    //
    // NUMEROS DA CONTA INTEIRA, medidos por ESTE codigo (nao por amostra), 31/08:
    //   133.682 citacoes
    //    18.015 RECUPERADAS pelo recasamento (13,5%) — o que o fix salva
    //    45.684 ORFAS DE ORIGEM (34,2%) — a mensagem citada nao esta no backup,
    //           nao tem conserto e nao e efeito do formato
    //         0 ambiguas
    // Somar as duas em um numero so inflaria o ganho do fix em ~3,5x; sao coisas
    // diferentes e o relatorio publica as duas em linhas separadas.
    // O recasamento e EXATO, nunca palpite: so vale quando o hex final aponta pra
    // UMA unica mensagem da conversa (na conta inteira, 0 caso ambiguo). Hex que
    // casa com duas fica como veio e e contado.
    const porHexDaConversa = new Map();
    for (const l of finais) {
      if (!l.provider_msg_id) continue;
      const m = RE_ID_LONGO.exec(l.provider_msg_id);
      const hex = m ? m[1] : l.provider_msg_id;
      if (!porHexDaConversa.has(hex)) porHexDaConversa.set(hex, []);
      porHexDaConversa.get(hex).push(l.provider_msg_id);
    }
    for (const l of finais) {
      if (!l.quoted_msg_id || unicas.has(l.quoted_msg_id)) continue;
      const m = RE_ID_LONGO.exec(l.quoted_msg_id);
      const hex = m ? m[1] : l.quoted_msg_id;
      const cand = porHexDaConversa.get(hex);
      // AUTORREFERENCIA: se o unico candidato e a PROPRIA mensagem, recasar faria
      // a bolha responder a si mesma — laco visual, e uma "recuperacao" contada
      // como sucesso. Acontece quando o export traz a citacao no formato longo do
      // proprio id (mensagem que cita a si mesma nao existe no WhatsApp, mas dado
      // de export torto existe). Fica como veio e nao entra na contagem.
      if (cand && cand.length === 1 && cand[0] !== l.provider_msg_id) {
        l.quoted_msg_id = cand[0];
        est.preservados.citacao_recasada_por_formato++;
      } else if (cand && cand.length > 1) {
        est.preservados.citacao_com_hex_ambiguo++;
      }
    }

    // tally DESTA conversa: so vira contagem quando o lote for gravado com sucesso
    const tally = { idOrigem, linhas: finais.length, entrada: 0, saida: 0, notas: 0, midia: midiaNaConversa };
    // As contagens do que foi PRESERVADO saem daqui, DEPOIS do dedupe: contar na
    // leitura inflava o numero com a mensagem que o backup repete entre paginas.
    for (const l of finais) {
      if (l.direcao === "interna") tally.notas++;
      else if (l.direcao === "out") tally.saida++;
      else tally.entrada++;
      if (!maisAntiga || l.criada_em < maisAntiga) maisAntiga = l.criada_em;
      if (!maisRecente || l.criada_em > maisRecente) maisRecente = l.criada_em;
      if (l.direcao === "interna") continue;
      const pr = est.preservados;
      if (l.quoted_msg_id) {
        pr.citacao++;
        // CITACAO ORFA. `quoted_msg_id` aponta pro `provider_msg_id` da mensagem
        // respondida, e o conjunto do que ENTROU esta na mao aqui (`unicas`). Se o
        // alvo nao entrou — porque era de um tipo ignorado, foi descartado por
        // falta de data/conteudo, ou simplesmente nao veio no export — a bolha do
        // painel mostra "responder a" apontando pro vazio. Nao ha o que consertar
        // (a mensagem citada nao existe no backup): o que nao pode e passar
        // calado, entao isto e CONTADO e declarado.
        // ESCOPO: a conferencia e DENTRO da conversa, que e onde o WhatsApp
        // permite citar. Um conjunto global dos 18,6 milhoes de identificadores
        // nao caberia em memoria na rodada em lote.
        if (!unicas.has(l.quoted_msg_id)) pr.citacao_com_alvo_fora_do_import++;
      }
      if (l.reacao) pr.reacao++;
      if (l.editada_em) pr.editada++;
      if (l.encaminhada) pr.encaminhada++;
      if (l.is_deleted) pr.apagada_marcada++;
      if (l.raw?.por_template) pr.por_template++;
      if (l.raw?.do_aparelho) pr.do_aparelho++;
      if (l.raw?.erro) pr.com_erro_de_envio++;
      pr.estado_de_entrega[l.status] = (pr.estado_de_entrega[l.status] || 0) + 1;
    }

    const doWhats = finais.filter((l) => l.direcao !== "interna");
    const ultima = (doWhats.length ? doWhats : finais).reduce(
      (a, b) => (a.criada_em > b.criada_em ? a : b),
      { criada_em: "", conteudo: "", direcao: "" }
    );
    // Delegacao e etapa vem do RESOLVEDOR (uma passada, no bloco de medicao) —
    // e nao de um mapa proprio. Os ids de delegacao chegam ora como string, ora
    // como {$oid}, e o `idDeOrigem` do resolvedor ja trata os dois.
    const ref = resolvidoPorChat.get(c.id) || {
      responsaveis: [],
      responsaveis_mortos: [],
      etapas: [],
      etapas_mortas: [],
    };
    const responsaveis = ref.responsaveis;
    const etiquetasDaConversa = [
      ...new Set(
        (c.tags || [])
          .map((t) => corta(typeof t === "string" ? t : t.text || t.name || "", 100).trim())
          .filter(Boolean)
          // nome do catalogo quando o resolvedor casou (ver canonicoEtiqueta)
          .map((n) => canonicoEtiqueta.get(n) || n)
      ),
    ];

    // Chave AUSENTE e diferente de chave com null: com merge-duplicates, mandar
    // null apaga o dado vivo do painel (nome vindo do WhatsApp, foto, responsavel
    // de verdade). O que o backup nao tem, o importador nao manda.
    const nome = c.name ? corta(c.name, 200) : null;
    const foto = /^https:\/\//.test(String(c.picture || "")) ? c.picture : null;
    bufConversas.push({
      chat_id: chatId,
      is_group: grupo,
      canal: ROTULO_CANAL,
      status: STATUS[String(c.status || "").toUpperCase()] || "aberto",
      arquivada: !!c.archived,
      ...(nome ? { nome } : {}),
      ...(foto ? { foto_url: foto } : {}),
      ...(responsaveis[0] ? { responsavel_nome: responsaveis[0] } : {}),
      ...(etiquetasDaConversa.length ? { etiquetas: etiquetasDaConversa } : {}),
      meta_chatguru: {
        chat_id_origem: c.id,
        status_original: c.status || null,
        etiquetas: etiquetasDaConversa,
        funil_etapas: ref.etapas,
        responsaveis,
        // Delegado que NAO resolveu viaja aqui, cru e separado: `responsaveis` e o
        // que tem nome de gente e vai pro espelho legado; um ObjectId gravado em
        // `responsavel_nome` apareceria na ficha como se fosse o nome do atendente
        // — e essa coluna e o UNICO registro de quem atendeu (a origem esta sendo
        // desligada). Nada e perdido: o id fica no meta e no relatorio.
        ...(ref.responsaveis_mortos.length ? { responsaveis_nao_resolvidos: ref.responsaveis_mortos } : {}),
        arquivado: !!c.archived,
      },
      created_at: dt(c.created) || undefined,
      last_message_at: ultima.criada_em || null,
      // Se a ultima da conversa foi apagada pra todos, o preview nao pode ficar
      // vazio (viraria "Voce: " pelado na lista): usa a mesma mascara do painel.
      last_message_preview: corta(
        `${ultima.direcao === "out" ? "Voce: " : ""}${ultima.conteudo || (ultima.is_deleted ? "Mensagem apagada" : "")}`,
        140
      ),
      updated_at: ultima.criada_em || new Date().toISOString(),
    });
    mapeado.conversas++;
    mapeado.entrada += tally.entrada;
    mapeado.saida += tally.saida;
    mapeado.notas += tally.notas;
    mapeado.midia += tally.midia;
    bufMsgs.push(...finais);
    pendentes.push(tally);

    if (bufMsgs.length >= LOTE) {
      try {
        await descarregar();
      } catch (e) {
        est.erros.push(e.message);
        log(`ERRO ao gravar lote: ${e.message}`);
        // lote perdido nao conta como gravado e nao entra no checkpoint:
        // a proxima passada tenta de novo
        est.destino.perdidos_em_lote_falhado += pendentes.reduce((a, p) => a + p.linhas, 0);
        bufMsgs = []; bufConversas = []; pendentes = [];
      }
    }
    if (mapeado.conversas % 200 === 0) log(`... ${mapeado.conversas} conversas lidas`);
  }

  try {
    await descarregar();
  } catch (e) {
    est.erros.push(e.message);
    log(`ERRO ao gravar lote final: ${e.message}`);
    est.destino.perdidos_em_lote_falhado += pendentes.reduce((a, p) => a + p.linhas, 0);
  }

  for (const c of chats) if (!comArquivo.has(c.id)) est.orfaos.chats_sem_arquivo_de_mensagens++;

  // MAPEADO = o que a leitura produziu. GRAVADO = o que sobreviveu ao flush.
  // Os dois so divergem quando um lote falha, e essa diferenca fica visivel.
  est.mapeado = {
    conversas: mapeado.conversas,
    mensagens_entrada: mapeado.entrada,
    mensagens_saida: mapeado.saida,
    notas_internas: mapeado.notas,
    mensagens_total: mapeado.entrada + mapeado.saida + mapeado.notas,
    com_midia: mapeado.midia,
  };
  est.destino.conversas = contagem.conversas;
  est.destino.mensagens_entrada = contagem.entrada;
  est.destino.mensagens_saida = contagem.saida;
  est.destino.notas_internas = contagem.notas;
  est.destino.mensagens_total = contagem.entrada + contagem.saida + contagem.notas;
  est.destino.com_midia = contagem.midia;
  est.destino.conversas_puladas_pelo_checkpoint = contagem.puladas;
  est.destino.por_tipo = porTipo;
  est.datas.mensagem_mais_antiga = maisAntiga;
  est.datas.mensagem_mais_recente = maisRecente;
  // Contado direto na leitura, nao deduzido das somas. NAO inclui conversa
  // pulada pelo checkpoint (numa retomada, so o que foi relido entra aqui) —
  // por isso o relatorio chama esta linha de "lidos nesta passada", nao "no
  // backup": numa 2a passada os dois numeros sao legitimamente diferentes.
  est.origem.itens_lidos_nesta_passada = itensLidos;
  est.origem.passada_completa = contagem.puladas === 0;

  if (DUMP) {
    fs.writeFileSync(DUMP, JSON.stringify(dump, null, 2));
    log(`linhas mapeadas gravadas em ${DUMP}`);
  }

  if (est.midia.arquivos)
    pend(
      "midia",
      `${est.midia.arquivos} mensagem(ns) apontam pra arquivo hospedado no S3 do fornecedor antigo ` +
        `(${(est.midia.bytes / 1e9).toFixed(2)} GB somando o tamanho declarado POR MENSAGEM — o mesmo arquivo ` +
        `citado em varias mensagens conta varias vezes; o total deduplicado por arquivo sai no inventario do ` +
        `passo de midia). ESSES ENDERECOS MORREM COM ` +
        `A CONTA: a re-hospedagem e o passo separado "node scripts/importar/midia.mjs --pasta <esta pasta>", ` +
        `que baixa, sobe pro storage da instalacao e reescreve o endereco na mensagem ja importada. Rodar ` +
        `depois desta importacao.`
    );
  if (est.descartados.midia_sem_url)
    pend(
      "midia",
      `${est.descartados.midia_sem_url} mensagem(ns) tem arquivo no backup mas sem URL utilizavel (nem ` +
        `path_relative nem path_absolute em https). A mensagem entra com o texto e sem o arquivo; se o arquivo ` +
        `existir na pasta media/ do backup, o passo de re-hospedagem consegue recupera-lo pelo nome.`
    );
  if (est.descartados.conversas_de_transmissao)
    pend(
      "conversas de transmissao",
      `${est.descartados.conversas_de_transmissao} lista(s) de transmissao (kind "broadcast", ` +
        `${est.descartados.itens_em_conversas_de_transmissao} itens) NAO foram importadas de proposito: o ` +
        `identificador delas na origem e um timestamp, nao um telefone, e viraria um contato falso no painel ` +
        `— com risco de alguem responder e o envio sair pra um numero que nao existe. Se o historico de ` +
        `transmissao for necessario, ele e material de campanha (campanhas.mjs), nao de conversa.`
    );
  if (est.preservados.citacao_com_alvo_fora_do_import)
    pend(
      "citacoes",
      `ORFAS DE ORIGEM: ${est.preservados.citacao_com_alvo_fora_do_import} de ${est.preservados.citacao} ` +
        `citacao(oes) apontam pra uma mensagem que NAO esta neste backup — no painel a bolha "responder a" fica ` +
        `sem alvo. Nao ha o que consertar aqui: a mensagem citada nao foi exportada (a paginacao da origem nao ` +
        `desceu tao fundo). A mensagem que cita entra normalmente. Numero SEPARADO, e nao parte dessas: ` +
        `${est.preservados.citacao_recasada_por_formato} citacao(oes) vinham no formato longo ` +
        `("false_<numero>_<id>") e foram RECUPERADAS pelo recasamento com o identificador nu que a mensagem alvo ` +
        `carrega — essas apontam certo e ja nao contam como orfas.` +
        (est.preservados.citacao_com_hex_ambiguo
          ? ` ${est.preservados.citacao_com_hex_ambiguo} ficaram como vieram por identificador ambiguo (duas ` +
            `mensagens da mesma conversa com o mesmo id final): recasar seria palpite.`
          : "")
    );
  if (est.preservados.apagada_marcada)
    pend(
      "mensagens apagadas",
      `${est.preservados.apagada_marcada} mensagem(ns) foram apagadas pra todos na origem e entram MARCADAS ` +
        `(is_deleted), aparecendo como "Mensagem apagada" — igual ao que o painel faz com apagada ao vivo. ` +
        `O texto nao existe mais em lugar nenhum; o que se preserva e o fato de que houve mensagem ali.`
    );
  if (Object.keys(est.preservados.tipos_degradados).length)
    pend(
      "tipos de mensagem",
      `tipo(s) sem equivalente no painel que entram como TEXTO, perdendo a estrutura: ${Object.entries(
        est.preservados.tipos_degradados
      )
        .map(([k, v]) => `${k} (${v})`)
        .join(", ")}. O texto que o cliente leu e preservado; o que se perde e o enfeite (botao, lista, cartao).`
    );
  if (est.avisos.textos_com_encoding_suspeito)
    pend(
      "encoding",
      `${est.avisos.textos_com_encoding_suspeito} mensagem(ns) tem sinal de charset trocado no proprio backup ` +
        `("Ã©", "â€œ", losango de substituicao). O importador NAO tenta consertar: chute de charset estraga o ` +
        `texto que estava certo. Entram como estao, e ficam localizaveis pela busca por esses sinais.`
    );
  if (est.orfaos.autores_desconhecidos)
    pend(
      "autoria",
      `${est.orfaos.autores_desconhecidos} envio(s) tem autor registrado na origem, mas esse id nao aparece na lista de usuarios exportada — normalmente e atendente que saiu da conta antes do backup. A mensagem entra normalmente, so sem o nome. Pra recuperar: reexporte a lista de usuarios no sistema antigo (se ainda tiver acesso) e rode a importacao de novo com --recomecar.`
    );
  if (est.orfaos.envios_sem_autor_na_origem)
    pend(
      "autoria",
      `${est.orfaos.envios_sem_autor_na_origem} envio(s) nunca tiveram autor na origem — sao disparos de robo/campanha do sistema antigo. Aparecem no painel como "atendimento (fora do painel)", que e o comportamento correto.`
    );
  if (est.orfaos.chats_sem_arquivo_de_mensagens)
    pend(
      "conversas",
      `${est.orfaos.chats_sem_arquivo_de_mensagens} conversa(s) do indice nao tem arquivo de mensagens no backup — nao entraram. Reexportar essas conversas na origem antes do corte, se ainda houver acesso.`
    );
}

// contagem do destino DEPOIS
if (!DRY && !SO_CONFIG) {
  est.destino.depois = { conversas: await contar(T.conversas), mensagens: await contar(T.mensagens) };
  if (est.destino.antes && est.destino.depois) {
    est.destino.entraram = {
      conversas: (est.destino.depois.conversas ?? 0) - (est.destino.antes.conversas ?? 0),
      mensagens: (est.destino.depois.mensagens ?? 0) - (est.destino.antes.mensagens ?? 0),
    };
  }
}

// ─── 4) RELATORIO ────────────────────────────────────────────────────────────
est.avisos.textos_truncados = textosTruncados;

// Taxas de resolucao de referencia, por tipo. Ambiguo e morto ja sao ressalva
// declarada dentro do resolvedor; aqui elas viram numero no relatorio e uma
// pendencia por tipo, com amostra dos valores que nao casaram.
// Em --dry `gravado` seria "o que SERIA gravado" — e um campo chamado "gravado"
// com numero diferente de zero num relatorio de simulacao e exatamente o tipo de
// coisa que alguem le fora de contexto e acredita. O markdown ja escondia; aqui o
// json passa a dizer null, que nao mente em nenhuma leitura. O que a simulacao
// produziu esta em `mapeado`, com esse nome.
if (DRY) est.destino.gravado = null;

est.referencias = { tabela: placar.tabela(), ressalvas: placar.ressalvas() };
for (const l of est.referencias.tabela) {
  if (!l.ressalvas) continue;
  pend(
    "referencias",
    `${l.tipo}: ${l.ressalvas} de ${l.com_alvo} referencia(s) com alvo nao resolveram ` +
      `(${l.ambiguo} nome ambiguo, ${l.morto} alvo inexistente no catalogo exportado) — ` +
      `taxa resolvida ${l.taxa_resolvido}%. Nada foi adivinhado: ver a amostra em ` +
      `referencias.ressalvas no json deste relatorio.`
  );
}
const carimbo = est.gerado_em.replace(/[:.]/g, "-");
const arqDados = path.join(TRABALHO, `relatorio-${carimbo}.json`);
const arqMd = arg("relatorio", path.join(TRABALHO, `relatorio-${carimbo}.md`));
fs.writeFileSync(arqDados, JSON.stringify(est, null, 2));
fs.writeFileSync(arqMd, renderRelatorio(est));

log(
  `FIM — ${est.destino.conversas ?? 0} conversas · ${est.destino.mensagens_entrada ?? 0} recebidas · ` +
    `${est.destino.mensagens_saida ?? 0} enviadas · ${est.destino.notas_internas ?? 0} anotacoes`
);
if (est.erros.length) log(`${est.erros.length} erro(s) — ver o relatorio`);
log(`relatorio: ${arqMd}`);
if (DRY) log("MODO DRY: nenhuma conexao foi aberta e nada foi gravado — tire o --dry pra importar de verdade");
// `process.exitCode`, NAO `process.exit()`: este script termina depois de dezenas
// de milhares de requisicoes, e derrubar o processo com socket em keep-alive faz o
// Node abortar no Windows com `Assertion failed: !(handle->flags &
// UV_HANDLE_CLOSING), src\\win\\async.c` (exit 3221226505). O codigo de saida e o
// mesmo; a diferenca e que o Node encerra sozinho quando o socket fecha, em vez de
// transformar uma carga bem-sucedida num "falhou" na tela do operador.
process.exitCode = est.erros.length ? 1 : 0;
