// BIBLIOTECA DE ANEXOS REUTILIZAVEIS — as regras (Frente W, card 86ak85bmw).
//
// Este arquivo e PURO de proposito: ZERO import, nem de tipo. Mesma convencao de
// lib/permissoes.ts, lib/fluxo/schema.ts e lib/perfil-conta.ts — a regra roda no
// Next E em node solto (`node scripts/prova-anexos.ts`), e e isso que permite
// provar por COMPORTAMENTO o que decide seguranca em vez de por leitura de
// arquivo. Quem toca aqui, mantem assim.
//
// O QUE A BIBLIOTECA E: o acervo de arquivos DA INSTALACAO (apresentacao, guia,
// tabela de preco) que o atendente manda sem procurar no computador — e que o
// FLUXO de automacao referencia por `chave`. Na conta medida, 56 anexos sao
// referenciados diretamente por fluxos (76 ocorrencias nas acoes): a biblioteca
// nao e conveniencia de tela, e pre-requisito pra aqueles fluxos converterem.
//
// TRES DECISOES QUE ATRAVESSAM O ARQUIVO INTEIRO:
//
//  1. O TIPO SAI DOS BYTES, NUNCA DO CLIENTE. O bucket e PUBLICO (o mesmo padrao
//     da foto de perfil, Frente G): um `.svg` ou `.html` guardado ali e XSS
//     hospedado no dominio da instalacao. `validarArquivo` sniffa a assinatura e
//     o mime DECLARADO so desempata familia (zip -> docx/xlsx/pptx), nunca
//     concede.
//  2. A REFERENCIA DO FLUXO VAI POR `chave`, NUNCA POR uuid. O formato canonico
//     de fluxo e PORTATIL entre instalacoes (`mover_funil` ja vai por nome pelo
//     mesmo motivo). Um fluxo exportado e importado noutra instalacao continua
//     apontando pro item certo se a chave existir la; com uuid, apontaria pro
//     vazio — e o pior: em silencio.
//  3. QUEM DECIDE SE PODE, DECIDE AQUI. Os tres portoes que mordem
//     (`decidirPatch`, `decidirExclusao`, `validarArquivo`) sao funcoes puras com
//     resultado discriminado, porque decisao escondida dentro de rota que fala
//     com banco e decisao que prova nenhuma alcanca — licao ja paga neste repo
//     (Frente V: "prova de texto nao alcanca o corpo").

// ————————————————————————————————————————————————————————————————— limites
export const LIMITE_CHAVE = 60;
export const LIMITE_NOME = 120;
export const LIMITE_DESCRICAO = 1000;
export const LIMITE_ETIQUETAS = 20;
export const LIMITE_ETIQUETA = 40;
export const LIMITE_ARQUIVO_NOME = 120;
/** legenda que acompanha o anexo no envio (mesmo teto do caption do provedor) */
export const LIMITE_LEGENDA = 1024;
/**
 * Teto por arquivo: 25 MB.
 *
 * Ele NAO e o teto do WhatsApp (documento vai a 100 MB) nem do bucket (50 MB). O
 * gargalo real e o upload atravessando a rota serverless — o corpo inteiro e
 * bufferizado em memoria antes de subir pro Storage, como na foto de perfil. 25
 * MB cobre apresentacao, catalogo e tabela, que e o uso medido; passar disso pede
 * upload direto pro Storage com URL assinada, que e outra entrega (declarada).
 */
export const LIMITE_BYTES = 25 * 1024 * 1024;

/**
 * QUANTOS ITENS POR PAGINA — configuravel, com os limites do card.
 *
 * A conta de referencia usa 50, e o card manda aceitar de 4 a 300. O default e
 * 50 pra a instalacao nova se comportar como a conta que serviu de medida.
 * `clamp` em vez de recusa no LEITOR (a config e validada na entrada por
 * lib/config.ts): valor torto que chegou de outra porta nao pode derrubar a
 * listagem, e uma pagina de 10 mil itens derruba a tela e o banco junto.
 */
export const POR_PAGINA_PADRAO = 50;
export const POR_PAGINA_MIN = 4;
export const POR_PAGINA_MAX = 300;

export function porPaginaValido(bruto: unknown, padrao: number = POR_PAGINA_PADRAO): number {
  const n = Number(bruto);
  if (!Number.isFinite(n)) return padrao;
  const inteiro = Math.round(n);
  if (inteiro < POR_PAGINA_MIN) return POR_PAGINA_MIN;
  if (inteiro > POR_PAGINA_MAX) return POR_PAGINA_MAX;
  return inteiro;
}

// —————————————————————————————————————————————————————— chave, nome, texto
/**
 * A chave e a identidade PORTATIL (ver decisao 2 no topo). Formato igual ao
 * atalho de resposta rapida (`^[a-z0-9_-]{1,30}$` na rota daquela) com um teto
 * maior, porque nome de material e mais longo que atalho de digitacao.
 *
 * NORMALIZA em vez de recusar o que da pra consertar (acento, espaco, caixa):
 * quem digita "Tabela de Preços 2026" quer `tabela-de-precos-2026`, e recusar
 * isso faria a tela pedir slug a mao. O que NAO se conserta e o vazio.
 */
const RE_CHAVE = /^[a-z0-9][a-z0-9_-]{0,59}$/;

export function chaveDeAnexo(bruto: unknown): string | null {
  if (typeof bruto !== "string") return null;
  const limpa = semAcento(bruto)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+/, "")
    .replace(/[-_]+$/, "")
    .slice(0, LIMITE_CHAVE)
    // o corte pode ter deixado um separador na ponta
    .replace(/[-_]+$/, "");
  return RE_CHAVE.test(limpa) ? limpa : null;
}

export function chaveJaValida(bruto: unknown): boolean {
  return typeof bruto === "string" && RE_CHAVE.test(bruto);
}

export function nomeDeAnexo(bruto: unknown): string | null {
  if (typeof bruto !== "string") return null;
  // \r\n\t viram espaco: nome com Enter parte a linha na tela e no `title` da
  // bolha (mesma licao do `nomeDeAssinatura`, Frente N)
  const nome = bruto.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, LIMITE_NOME);
  return nome || null;
}

/**
 * Descricao: VAZIO e legitimo (limpar a descricao e um gesto), texto que nao e
 * texto nao e. Por isso o resultado e discriminado — `null` significaria as duas
 * coisas ao mesmo tempo, e a rota nao teria como distinguir "apagou" de "mandou
 * um numero".
 */
export type CampoTexto = { ok: true; valor: string } | { ok: false; erro: string };

export function descricaoDeAnexo(bruto: unknown): CampoTexto {
  if (typeof bruto !== "string") return { ok: false, erro: "a descricao precisa ser texto" };
  const valor = bruto.replace(/\r\n/g, "\n").trim();
  if (valor.length > LIMITE_DESCRICAO) {
    return { ok: false, erro: `a descricao passa de ${LIMITE_DESCRICAO} caracteres` };
  }
  return { ok: true, valor };
}

export type CampoEtiquetas = { ok: true; etiquetas: string[] } | { ok: false; erro: string };

/**
 * Etiquetas da BIBLIOTECA — nao sao as etiquetas de conversa (catalogo, tabela e
 * proposito diferentes; misturar faria etiquetar um arquivo mexer no filtro da
 * caixa de entrada). Lista vazia e legitima (desetiquetar).
 *
 * DEDUPE POR FORMA NORMALIZADA e a parte que importa: "Comercial" e "comercial"
 * sao a MESMA etiqueta pra quem filtra, e deixar as duas entrarem repete o
 * defeito medido na importacao de etiquetas de conversa (catalogo de 35, 76
 * textos distintos usados). O texto que fica e o PRIMEIRO que apareceu — quem
 * digitou escolheu a caixa.
 */
export function etiquetasDeAnexo(bruto: unknown): CampoEtiquetas {
  if (!Array.isArray(bruto)) return { ok: false, erro: "etiquetas precisam vir em lista" };
  const vistas = new Set<string>();
  const etiquetas: string[] = [];
  for (const item of bruto) {
    if (typeof item !== "string") continue;
    const texto = item.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!texto) continue;
    if (texto.length > LIMITE_ETIQUETA) {
      return { ok: false, erro: `etiqueta acima de ${LIMITE_ETIQUETA} caracteres: "${texto.slice(0, 20)}..."` };
    }
    const forma = normalizarBusca(texto);
    if (vistas.has(forma)) continue;
    vistas.add(forma);
    etiquetas.push(texto);
  }
  if (etiquetas.length > LIMITE_ETIQUETAS) {
    return { ok: false, erro: `no maximo ${LIMITE_ETIQUETAS} etiquetas por arquivo` };
  }
  return { ok: true, etiquetas };
}

export function legendaDeAnexo(bruto: unknown): CampoTexto {
  if (bruto === undefined || bruto === null) return { ok: true, valor: "" };
  if (typeof bruto !== "string") return { ok: false, erro: "a legenda precisa ser texto" };
  const valor = bruto.replace(/\r\n/g, "\n").trim();
  if (valor.length > LIMITE_LEGENDA) {
    return { ok: false, erro: `a legenda passa de ${LIMITE_LEGENDA} caracteres` };
  }
  return { ok: true, valor };
}

// —————————————————————————————————————————————————————————————— busca
/**
 * Forma comparavel de um texto: sem acento, sem caixa, sem espaco duplo.
 *
 * A BUSCA DA BIBLIOTECA E EM MEMORIA, e isso e escolha declarada: o acervo
 * medido e de 3.287 itens em 33 contas (153 na maior), entao a lista inteira cabe
 * numa resposta e o filtro acento-insensivel roda aqui. Filtrar no banco com
 * `ilike` traria o defeito que este repo ja documentou duas vezes — `ilike` NAO
 * ignora acento (sem `unaccent`), e quem digita "orcamento" nao acharia
 * "orçamento". Se um dia um acervo grande aparecer, o caminho e paginar no banco
 * E declarar que a busca passa a ser sensivel a acento; nao e trocar em silencio.
 */
export function normalizarBusca(texto: unknown): string {
  return semAcento(String(texto ?? ""))
    .toLowerCase()
    .replace(/\s{2,}/g, " ")
    .trim();
}

function semAcento(texto: string): string {
  // NFD + corte das marcas combinantes, escritas por CODIGO (̀-ͯ) e
  // nao como caractere literal: marca combinante literal no fonte e invisivel no
  // editor e some numa conversao de encoding, levando a normalizacao com ela.
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export type AnexoBusca = {
  chave: string;
  nome: string;
  descricao?: string | null;
  etiquetas?: string[] | null;
  arquivo_nome?: string | null;
};

/** O termo casa em nome, chave, descricao, nome do arquivo ou etiqueta. */
export function casaBuscaAnexo(anexo: AnexoBusca, termo: unknown): boolean {
  const t = normalizarBusca(termo);
  if (!t) return true;
  const campos = [anexo.nome, anexo.chave, anexo.descricao, anexo.arquivo_nome, ...(anexo.etiquetas ?? [])];
  return campos.some((c) => c && normalizarBusca(c).includes(t));
}

/** Filtro da tela: termo (opcional) E etiqueta (opcional) — os dois sao E, nunca OU. */
export function filtrarAnexos<T extends AnexoBusca>(
  lista: readonly T[],
  filtro: { termo?: unknown; etiqueta?: unknown } = {}
): T[] {
  const etq = normalizarBusca(filtro.etiqueta);
  return lista.filter((a) => {
    if (!casaBuscaAnexo(a, filtro.termo)) return false;
    if (!etq) return true;
    return (a.etiquetas ?? []).some((e) => normalizarBusca(e) === etq);
  });
}

/** Catalogo de etiquetas em uso, com contagem — a tela oferece filtro por ele. */
export function etiquetasEmUso(lista: readonly AnexoBusca[]): { etiqueta: string; itens: number }[] {
  const mapa = new Map<string, { etiqueta: string; itens: number }>();
  for (const a of lista) {
    for (const e of a.etiquetas ?? []) {
      const forma = normalizarBusca(e);
      if (!forma) continue;
      const atual = mapa.get(forma);
      if (atual) atual.itens++;
      else mapa.set(forma, { etiqueta: e, itens: 1 });
    }
  }
  return [...mapa.values()].sort((a, b) => b.itens - a.itens || a.etiqueta.localeCompare(b.etiqueta));
}

// ——————————————————————————————————————————————— tipo do arquivo e do envio
/**
 * TIPO DE ENVIO — o vocabulario de `/api/send` (`image|audio|video|document`),
 * derivado do mime. NAO e coluna no banco de proposito: coluna derivada
 * envelhece, e bastaria um UPDATE no mime sem o irmao pra a biblioteca mandar um
 * PDF como se fosse foto.
 *
 * `ptt` NAO entra: ele e audio gravado na hora pelo atendente (waveform, play
 * nativo). Audio de biblioteca e arquivo, e mandar como ptt faria o cliente ver
 * um "recado de voz" que ninguem gravou.
 */
export type TipoEnvioAnexo = "image" | "audio" | "video" | "document";

export function tipoDeEnvio(mime: unknown): TipoEnvioAnexo {
  const m = String(mime ?? "").toLowerCase().split(";")[0].trim();
  // figurinha e webp, mas webp de biblioteca e IMAGEM: quem sobe um banner .webp
  // nao quer que ele chegue como sticker
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "document";
}

export const EXT_POR_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "application/zip": "zip",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
};

export function extensaoDe(nome: unknown, mime: unknown): string {
  const daUrl = String(nome ?? "").split("?")[0].split("#")[0].split("/").pop() || "";
  const m = daUrl.match(/\.([a-z0-9]{2,5})$/i);
  if (m) return m[1].toLowerCase();
  return EXT_POR_MIME[String(mime ?? "").toLowerCase().split(";")[0].trim()] || "bin";
}

/**
 * Familias que a biblioteca aceita, e o mime que fica gravado.
 *
 * As duas familias SEM assinatura propria (zip e OLE2) usam o mime DECLARADO
 * apenas pra escolher DENTRO da familia — docx, xlsx e pptx sao todos
 * `PK\x03\x04`, e nao ha como distinguir por bytes sem abrir o pacote. Declarado
 * fora da lista cai no mime generico da familia; ele nunca amplia o que passa.
 */
const ZIP_DECLARAVEIS = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
]);
const OLE_DECLARAVEIS = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);
const TEXTO_DECLARAVEIS = new Set(["text/plain", "text/csv"]);

export type AssinaturaArquivo = { mime: string; ext: string; familia: string };

function comeca(bytes: Uint8Array, ...assinatura: number[]): boolean {
  if (bytes.length < assinatura.length) return false;
  return assinatura.every((b, i) => bytes[i] === b);
}

function texto(bytes: Uint8Array, inicio: number, valor: string): boolean {
  if (bytes.length < inicio + valor.length) return false;
  for (let i = 0; i < valor.length; i++) if (bytes[inicio + i] !== valor.charCodeAt(i)) return false;
  return true;
}

/**
 * O TIPO SAI DOS BYTES. O content-type do cliente nao decide nada (mesma regra
 * da foto de perfil, Frente G) — e aqui ela vale dobrado: o bucket e PUBLICO e a
 * URL vai pro WhatsApp do cliente final.
 */
export function assinaturaDeArquivo(bytes: Uint8Array, mimeDeclarado?: unknown): AssinaturaArquivo | null {
  const dec = String(mimeDeclarado ?? "").toLowerCase().split(";")[0].trim();
  if (texto(bytes, 0, "%PDF-")) return { mime: "application/pdf", ext: "pdf", familia: "pdf" };
  if (comeca(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return { mime: "image/png", ext: "png", familia: "imagem" };
  if (comeca(bytes, 0xff, 0xd8, 0xff)) return { mime: "image/jpeg", ext: "jpg", familia: "imagem" };
  if (texto(bytes, 0, "GIF87a") || texto(bytes, 0, "GIF89a"))
    return { mime: "image/gif", ext: "gif", familia: "imagem" };
  if (texto(bytes, 0, "RIFF") && texto(bytes, 8, "WEBP"))
    return { mime: "image/webp", ext: "webp", familia: "imagem" };
  if (texto(bytes, 4, "ftyp")) {
    // ftypM4A = audio; o resto da familia ISO-BMFF entra como video (mp4/3gp)
    if (texto(bytes, 8, "M4A")) return { mime: "audio/mp4", ext: "m4a", familia: "audio" };
    return { mime: "video/mp4", ext: "mp4", familia: "video" };
  }
  if (texto(bytes, 0, "OggS")) return { mime: "audio/ogg", ext: "ogg", familia: "audio" };
  if (texto(bytes, 0, "ID3") || comeca(bytes, 0xff, 0xfb) || comeca(bytes, 0xff, 0xf3) || comeca(bytes, 0xff, 0xf2))
    return { mime: "audio/mpeg", ext: "mp3", familia: "audio" };
  if (comeca(bytes, 0x50, 0x4b, 0x03, 0x04) || comeca(bytes, 0x50, 0x4b, 0x05, 0x06)) {
    const mime = ZIP_DECLARAVEIS.has(dec) ? dec : "application/zip";
    return { mime, ext: EXT_POR_MIME[mime] || "zip", familia: "pacote" };
  }
  if (comeca(bytes, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    const mime = OLE_DECLARAVEIS.has(dec) ? dec : "application/msword";
    return { mime, ext: EXT_POR_MIME[mime] || "doc", familia: "office-antigo" };
  }
  // TEXTO nao tem assinatura, e e por isso que ele e o unico caso em que o mime
  // declarado abre porta — com DUAS travas: (a) declarado tem que estar na lista;
  // (b) o conteudo nao pode COMECAR COM `<`. Sem a segunda, um `.html` (ou um
  // `.svg`, que e XML) entra como "texto simples" e passa a morar numa URL
  // publica do dominio da instalacao — que e XSS hospedado por nos.
  if (TEXTO_DECLARAVEIS.has(dec) && !comecaComSinalDeMarcacao(bytes) && pareceTexto(bytes)) {
    return { mime: dec, ext: EXT_POR_MIME[dec] || "txt", familia: "texto" };
  }
  return null;
}

function comecaComSinalDeMarcacao(bytes: Uint8Array): boolean {
  let i = 0;
  // BOM UTF-8
  if (comeca(bytes, 0xef, 0xbb, 0xbf)) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  return bytes[i] === 0x3c; // '<'
}

function pareceTexto(bytes: Uint8Array): boolean {
  const amostra = Math.min(bytes.length, 2048);
  if (!amostra) return false;
  for (let i = 0; i < amostra; i++) {
    const b = bytes[i];
    // byte de controle (menos \t \n \r) = binario se passando por texto
    if (b === 0) return false;
    if (b < 0x09) return false;
    if (b > 0x0d && b < 0x20) return false;
  }
  return true;
}

/** Nome que CHEGA no cliente. Nunca caminho, nunca controle, sempre com a extensao do tipo REAL. */
export function nomeDeArquivo(bruto: unknown, ext: string): string {
  const cru = String(bruto ?? "")
    // separador de caminho e o que transforma nome de arquivo em travessia de
    // diretorio quando alguem usa este nome pra montar caminho
    .replace(/[\\/]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const base = cru.replace(/\.[a-z0-9]{1,5}$/i, "").slice(0, LIMITE_ARQUIVO_NOME - (ext.length + 1)) || "arquivo";
  return `${base}.${ext}`;
}

export type ProblemaArquivo = { ok: false; erro: string };
export type ArquivoAceito = {
  ok: true;
  mime: string;
  ext: string;
  familia: string;
  arquivo_nome: string;
  bytes: number;
};

/**
 * O PORTAO DO UPLOAD. Discriminado e puro: a prova exercita o DESFECHO, com bytes
 * hostis (svg com nome .pdf, html com mime text/plain, executavel) em vez de ler
 * o arquivo da rota procurando uma frase.
 */
export function validarArquivo(entrada: {
  bytes: Uint8Array;
  nome?: unknown;
  mime?: unknown;
}): ArquivoAceito | ProblemaArquivo {
  const bytes = entrada.bytes;
  if (!bytes || !bytes.length) return { ok: false, erro: "arquivo vazio" };
  if (bytes.length > LIMITE_BYTES) {
    return { ok: false, erro: `o arquivo passa de ${Math.round(LIMITE_BYTES / (1024 * 1024))} MB` };
  }
  const assinatura = assinaturaDeArquivo(bytes, entrada.mime);
  if (!assinatura) {
    return {
      ok: false,
      erro:
        "tipo de arquivo nao aceito na biblioteca. Passam PDF, imagem (png/jpg/webp/gif), video mp4, audio (ogg/mp3/m4a), " +
        "documento do Office (docx/xlsx/pptx/doc/xls/ppt), zip e texto (txt/csv). Pagina web e imagem SVG sao recusadas de " +
        "proposito: o arquivo fica numa URL publica da instalacao, e as duas carregam script.",
    };
  }
  return {
    ok: true,
    mime: assinatura.mime,
    ext: assinatura.ext,
    familia: assinatura.familia,
    arquivo_nome: nomeDeArquivo(entrada.nome, assinatura.ext),
    bytes: bytes.length,
  };
}

// ——————————————————————————————————————————————————————— anexar a conversa
export type AnexoParaEnvio = {
  chave: string;
  nome: string;
  arquivo_nome: string;
  mime: string;
  url: string;
};

/** URL de anexo: so https. Mesma regra do `urlSegura()` do painel e dos webhooks de saida. */
export function urlDeAnexoValida(bruto: unknown): string | null {
  if (typeof bruto !== "string") return null;
  const u = bruto.trim();
  if (!/^https:\/\/[^\s"'<>]+$/i.test(u)) return null;
  return u;
}

/**
 * O PREFIXO DA BIBLIOTECA DENTRO DO BUCKET — uma definicao so, e ela mora AQUI.
 *
 * Ele vive no arquivo puro (e nao em `lib/anexos-db.ts`, onde nasceu) por um
 * motivo medido: enquanto o prefixo era ARGUMENTO, quem compunha podia passar
 * `"conversas"` no lugar dele e a bateria inteira ficava verde — e o `tsc`
 * tambem, porque os dois parametros eram `string`. O dano e o que a trava existe
 * pra impedir: o DELETE da biblioteca alcancando midia de CONVERSA. Aqui dentro
 * ele deixa de ser argumento e passa a ser CONSTANTE do modulo: nao ha o que
 * passar errado, e o que sobra e provado por comportamento (`prova-anexos` D.13).
 */
export const PREFIXO_ANEXOS = "biblioteca";

/**
 * Caminho do objeto pra subida: `biblioteca/<chave>.<ext>`.
 *
 * DETERMINISTICO E LEGIVEL de proposito: trocar o arquivo de um item reescreve o
 * MESMO objeto (upsert), entao "manda sempre a versao certa" nao deixa versao
 * velha viva no bucket com URL propria. A frescura do cache e resolvida pelo
 * `?v=<hash8>` da URL, exatamente como a foto de perfil faz.
 *
 * Mora ao lado de `caminhoDeAnexoNaUrl` DE PROPOSITO: subir num prefixo e apagar
 * noutro seria arquivo orfao no bucket publico, e as duas pontas usam a MESMA
 * constante. O ida-e-volta e provado por comportamento (`prova-anexos` D.13b).
 */
export function caminhoDoAnexo(chave: string, ext: string): string {
  return `${PREFIXO_ANEXOS}/${chave}.${ext}`;
}

/**
 * A trava do prefixo, sem prefixo pra passar.
 *
 * NAO E EXPORTADA de proposito: exportada, ela reabre a porta que a extracao
 * fechou — qualquer chamador poderia passar `"conversas"` e o apagar da
 * biblioteca voltaria a alcancar midia de conversa, sem `tsc` vermelho. O unico
 * caminho publico e `caminhoDeAnexoNaUrl`, que crava o prefixo desta casa.
 */
function caminhoDentroDoBucket(url: unknown, bucket: string, prefixo: string): string | null {
  const u = urlDeAnexoValida(url);
  if (!u) return null;
  const marca = `/storage/v1/object/public/${bucket}/`;
  const i = u.indexOf(marca);
  if (i < 0) return null;
  const caminho = u.slice(i + marca.length).split("?")[0];
  return caminho.startsWith(`${prefixo}/`) ? caminho : null;
}

/**
 * O CAMINHO DENTRO DO BUCKET, derivado da URL gravada — e a trava do prefixo.
 *
 * Serve pro apagar: e por aqui que se descobre QUAL objeto remover a partir da
 * linha. A trava importa mais do que parece — uma linha da biblioteca com `url`
 * editada no banco (por engano ou de proposito) apontando pra outro lugar do
 * MESMO bucket faria o apagar de um item da biblioteca remover MIDIA DE CONVERSA.
 * Por isso so o nosso prefixo vale; qualquer outro caminho devolve null e o
 * arquivo simplesmente nao e tocado.
 *
 * O `bucket` continua ARGUMENTO porque ele e da INSTALACAO (`MSG_STORAGE_BUCKET`)
 * e ler env aqui levaria env pro bundle do cliente — e porque errar o bucket e
 * FAIL-SAFE, nao fail-open: URL que nao casa a marca devolve null e nada e
 * apagado (provado, D.13). Errar o PREFIXO e que era fail-open; por isso ele nao
 * e mais argumento de ninguem.
 *
 * Pura de proposito: assim ela e provada por COMPORTAMENTO, com URL de verdade,
 * sem banco e sem o `@/lib` que a bateria nao resolve.
 */
export function caminhoDeAnexoNaUrl(url: unknown, bucket: string): string | null {
  return caminhoDentroDoBucket(url, bucket, PREFIXO_ANEXOS);
}
export type PayloadEnvioAnexo = {
  tipo: TipoEnvioAnexo;
  media: string;
  file_name: string;
  message?: string;
};

/**
 * O CORPO DE `/api/send`, montado em UM lugar so.
 *
 * Ele e compartilhado pela tela, pela rota de anexar e pelo passo de fluxo de
 * proposito: com duas montagens, a legenda (ou o nome do arquivo) sairia diferente
 * dependendo de quem mandou, e a mesma biblioteca entregaria dois resultados. O
 * `media` e a URL PUBLICA da instalacao — o provedor baixa dela, entao o painel
 * nao re-sobe 25 MB a cada envio.
 */
export function payloadDeEnvio(anexo: AnexoParaEnvio, legenda?: string): PayloadEnvioAnexo {
  const tipo = tipoDeEnvio(anexo.mime);
  const base: PayloadEnvioAnexo = { tipo, media: anexo.url, file_name: anexo.arquivo_nome };
  const texto = (legenda ?? "").trim();
  if (texto) base.message = texto.slice(0, LIMITE_LEGENDA);
  return base;
}

/**
 * Este canal aceita ANEXO da biblioteca? Devolve o motivo (frase pro usuario) ou
 * null quando aceita.
 *
 * A decisao e por CAPACIDADE DA FONTE, nunca por id de canal — a licao que a
 * Frente S pagou no clipe e no microfone (`canal === "central"` escrito na tela
 * deixava uma 2a instancia Z-API sem os botoes, suportando os dois envios).
 */
export function motivoNaoAnexa(cap: { fonte: string; soLeitura?: boolean; envioCabeado?: boolean }): string | null {
  if (cap.soLeitura) {
    return "este numero e somente leitura no painel: da pra ler a conversa, nao pra enviar arquivo nela";
  }
  if (cap.envioCabeado === false) {
    return "o envio deste numero nao esta configurado nesta instalacao";
  }
  if (cap.fonte === "gupshup") {
    // v1 do canal oficial e SO TEXTO (a propria /api/send responde 400 pra midia
    // ali). Dizer isso ANTES do clique e a diferenca entre "o painel explicou" e
    // "o painel errou".
    return "no numero da API Oficial o painel ainda manda so texto — anexo da biblioteca sai pelos numeros de conversa livre";
  }
  if (cap.fonte !== "zapi" && cap.fonte !== "evolution") {
    return `o painel ainda nao manda arquivo por um numero de fonte ${cap.fonte}`;
  }
  return null;
}

// ————————————————————————————————————————— quem usa este anexo (fluxos)
/**
 * As chaves de anexo que UM fluxo referencia, lidas por FORMA.
 *
 * POR FORMA, NUNCA POR BUSCA DE FRASE: procurar a chave dentro do jsonb como
 * texto casaria com o TEXTO de uma mensagem que por acaso cita "tabela-precos",
 * e o gestor veria um fluxo na lista de impacto que nao tem anexo nenhum —
 * "importar nao e chamar", a licao que este repo escreveu no editor de fluxos. O
 * caminho e o mesmo do editor: caminhar os nos e ler `acao.tipo`.
 *
 * TOLERANTE A JSONB TORTO de proposito (fluxo pode ter vindo de importacao): no
 * ilegivel e IGNORADO, e nunca estoura — a lista de impacto que quebra por causa
 * de um fluxo torto e exatamente a que impede de apagar o anexo.
 */
export const ACAO_ANEXO = "anexar_biblioteca";

export type ReferenciaDeFluxo = {
  no_id: string;
  chave: string;
  desligado: boolean;
};

export function referenciasDeAnexoNoFluxo(bruto: unknown): ReferenciaDeFluxo[] {
  const fluxo = bruto as any;
  const nos = Array.isArray(fluxo?.nos) ? fluxo.nos : [];
  const achadas: ReferenciaDeFluxo[] = [];
  for (let i = 0; i < nos.length; i++) {
    const no = nos[i];
    const acao = no?.acao;
    if (!acao || typeof acao !== "object") continue;
    if (acao.tipo !== ACAO_ANEXO) continue;
    const chave = typeof acao.anexo === "string" ? acao.anexo.trim().toLowerCase() : "";
    if (!chave) continue;
    achadas.push({
      no_id: typeof no?.id === "string" && no.id ? no.id.slice(0, 64) : `(sem id ${i + 1})`,
      chave,
      // passo DESLIGADO nao roda hoje, e ainda assim entra na lista de impacto:
      // referencia que nao roda hoje quebra o fluxo no dia em que alguem religar
      // o passo, e o gestor tem que decidir sabendo disso.
      desligado: no?.desligado === true,
    });
  }
  return achadas;
}

export type LinhaFluxo = { slug: string; nome?: string | null; ativo?: boolean; fluxo: unknown };

export type FluxoAfetado = {
  slug: string;
  nome: string;
  ativo: boolean;
  passos: { no_id: string; desligado: boolean }[];
};

/** Os fluxos que referenciam ESTA chave — a lista que o apagar mostra antes de confirmar. */
export function fluxosQueUsamAnexo(linhas: readonly LinhaFluxo[], chave: unknown): FluxoAfetado[] {
  const alvo = typeof chave === "string" ? chave.trim().toLowerCase() : "";
  if (!alvo) return [];
  const saida: FluxoAfetado[] = [];
  for (const linha of linhas) {
    const passos = referenciasDeAnexoNoFluxo(linha.fluxo)
      .filter((r) => r.chave === alvo)
      .map((r) => ({ no_id: r.no_id, desligado: r.desligado }));
    if (!passos.length) continue;
    saida.push({
      slug: linha.slug,
      nome: (linha.nome ?? linha.slug) || linha.slug,
      ativo: linha.ativo !== false,
      passos,
    });
  }
  return saida;
}

/** Quantos fluxos usam CADA chave — a coluna "usado em N fluxos" da listagem. */
export function usoPorChave(linhas: readonly LinhaFluxo[]): Record<string, number> {
  const conta: Record<string, number> = Object.create(null);
  for (const linha of linhas) {
    const chaves = new Set(referenciasDeAnexoNoFluxo(linha.fluxo).map((r) => r.chave));
    for (const c of chaves) conta[c] = (conta[c] || 0) + 1;
  }
  return conta;
}

/**
 * O erro da leitura dos FLUXOS virou qual fato? PURA — e e a superficie mais
 * perigosa desta frente, pelo mesmo motivo do `estadoDaAcl` da Frente V: aqui
 * "sem_tabela" e o UNICO valor que LIBERA o apagar sem lista de impacto.
 *
 * `42P01` = a tabela `mensageria.fluxos` NAO EXISTE nesta instalacao (a 0008 e
 * gesto humano e pode nunca ter sido rodada — o modulo de automacao nasce
 * desligado). Sem tabela de fluxos, nenhum fluxo pode referenciar anexo nenhum:
 * a lista de impacto e VAZIA de verdade, e recusar o apagar pra sempre seria
 * trancar a biblioteca por causa de uma feature que a instalacao nao usa.
 *
 * QUALQUER OUTRO CODIGO RECUSA, e `PGRST205` esta entre eles de proposito: ele e
 * o estado TRANSITORIO do PostgREST logo depois de um DDL ("could not find the
 * table in the schema cache") — aceita-lo como tabela ausente faria o apagar
 * ignorar a lista de fluxos justamente nos segundos em que alguem esta mexendo no
 * schema. Cache, coluna ausente (`42703`), permissao e rede sao "nao deu pra
 * ler", que RECUSA. O custo de recusar e "tente de novo"; o custo de liberar e
 * fluxo mudo na frente do cliente.
 */
export function estadoDaLeituraDeFluxos(
  error: { code?: string | null } | null | undefined
): "ok" | "sem_tabela" | "ilegivel" {
  if (!error) return "ok";
  return String(error.code ?? "") === "42P01" ? "sem_tabela" : "ilegivel";
}

export type LeituraDeFluxos = {
  linhas?: readonly LinhaFluxo[] | null;
  error?: { code?: string | null; message?: string | null } | null;
  /** true = a leitura bateu no teto e NAO viu o acervo inteiro */
  truncado?: boolean;
};

export type VarreduraDeFluxos =
  | { ok: true; afetados: FluxoAfetado[]; sem_tabela_de_fluxos: boolean }
  | { ok: false; aviso: string };

/**
 * Quais fluxos usam esta chave? O EXECUTOR ENTRA POR PARAMETRO.
 *
 * A injecao e pelo motivo que este repo escreveu em letras garrafais na Frente V:
 * *decisao que so tem prova de texto esta a uma linha de ser desligada*. Enquanto
 * esta decisao morasse dentro da rota, a prova seria varredura de arquivo — e um
 * `return { ok: true, afetados: [] }` acrescentado no meio do helper devolveria o
 * apagar silencioso com a bateria verde. Com o executor injetado, a prova
 * exercita os quatro desfechos (ok, sem tabela, ilegivel, estouro) com fake no
 * lugar do banco, e a mutacao morre.
 *
 * TRUNCADO RECUSA: se a leitura bateu no teto, existe fluxo que ela nao viu — e
 * "nao vi" nao pode virar "nao usa" na porta de um gesto destrutivo.
 */
export async function varrerFluxosQueUsam(
  chave: unknown,
  ler: () => PromiseLike<LeituraDeFluxos>
): Promise<VarreduraDeFluxos> {
  let r: LeituraDeFluxos | null = null;
  try {
    r = await ler();
  } catch (e: any) {
    return { ok: false, aviso: `falha ao ler os fluxos: ${String(e?.message ?? e).slice(0, 200)}` };
  }
  const estado = estadoDaLeituraDeFluxos(r?.error);
  if (estado === "sem_tabela") return { ok: true, afetados: [], sem_tabela_de_fluxos: true };
  if (estado === "ilegivel") {
    return {
      ok: false,
      aviso: `nao deu pra ler os fluxos desta instalacao (${String(r?.error?.code ?? "erro")})`,
    };
  }
  if (r?.truncado) {
    return {
      ok: false,
      aviso: "a lista de fluxos veio CORTADA pelo teto de leitura, entao nao da pra afirmar quem usa este arquivo",
    };
  }
  return { ok: true, afetados: fluxosQueUsamAnexo(r?.linhas ?? [], chave), sem_tabela_de_fluxos: false };
}

/** A frase que a tela mostra antes de confirmar o apagar. Sem numero inventado. */
export function resumoDoImpacto(afetados: readonly FluxoAfetado[]): string {
  if (!afetados.length) return "nenhum fluxo de automacao referencia este arquivo";
  const passos = afetados.reduce((n, f) => n + f.passos.length, 0);
  const ativos = afetados.filter((f) => f.ativo).length;
  const nomes = afetados.slice(0, 3).map((f) => f.nome).join(", ");
  const resto = afetados.length > 3 ? ` e mais ${afetados.length - 3}` : "";
  return (
    `${afetados.length} fluxo(s) referenciam este arquivo em ${passos} passo(s) — ${ativos} deles estao LIGADOS. ` +
    `Apagar deixa esses passos sem arquivo: ${nomes}${resto}.`
  );
}

// ——————————————————————————————————————————————————————— os dois portoes
/**
 * AS QUATRO PERMISSOES SAO SEPARADAS, e este e o portao que faz isso valer.
 *
 * O card e explicito: enviar, apagar, descrever e etiquetar sao permissoes
 * distintas (a ferramenta de origem tem quatro caixas dedicadas — sinal de que o
 * acervo e gerido por mais de uma pessoa, nao pasta pessoal). O jeito de essa
 * separacao virar mentira e o PATCH: um pedido `{descricao, etiquetas}` de quem
 * so pode etiquetar gravaria a descricao de carona.
 *
 * DECIDE ANTES DE ESCREVER: o resultado traz SO os campos autorizados e, se
 * qualquer campo pedido nao for autorizado, RECUSA o pedido inteiro. Efeito
 * parcial com resposta de recusa e a pior combinacao possivel (licao da Frente O,
 * gate do robo rodando depois dos efeitos) — e gravar metade calado seria pior
 * ainda.
 */
export type PedidoPatch = { descricao?: unknown; etiquetas?: unknown };
export type PermissoesAnexos = {
  descrever: boolean;
  etiquetar: boolean;
};
export type DecisaoPatch =
  | { ok: true; campos: { descricao?: string; etiquetas?: string[] } }
  | { ok: false; status: number; erro: string };

export function decidirPatch(pedido: PedidoPatch, perm: PermissoesAnexos): DecisaoPatch {
  const pedeDescricao = pedido.descricao !== undefined;
  const pedeEtiquetas = pedido.etiquetas !== undefined;
  if (!pedeDescricao && !pedeEtiquetas) {
    // "salvei" sem nada pra salvar e a mentira que faz a pessoa ir embora
    // achando que trocou algo (licao do PATCH de agendadas, Frente S)
    return { ok: false, status: 400, erro: "nada pra mudar: mande `descricao` ou `etiquetas`" };
  }
  if (pedeDescricao && !perm.descrever) {
    return { ok: false, status: 403, erro: "voce nao tem a permissao de DESCREVER arquivo da biblioteca" };
  }
  if (pedeEtiquetas && !perm.etiquetar) {
    return { ok: false, status: 403, erro: "voce nao tem a permissao de ETIQUETAR arquivo da biblioteca" };
  }
  const campos: { descricao?: string; etiquetas?: string[] } = {};
  if (pedeDescricao) {
    const d = descricaoDeAnexo(pedido.descricao);
    if (!d.ok) return { ok: false, status: 400, erro: d.erro };
    campos.descricao = d.valor;
  }
  if (pedeEtiquetas) {
    const e = etiquetasDeAnexo(pedido.etiquetas);
    if (!e.ok) return { ok: false, status: 400, erro: e.erro };
    campos.etiquetas = e.etiquetas;
  }
  return { ok: true, campos };
}

/**
 * APAGAR NUNCA E SILENCIOSO — o criterio de aceite do card, virado em portao.
 *
 * Duas confirmacoes DIFERENTES, e elas nao se substituem:
 *   `confirmar`      = "eu quis apagar" (protege do clique/curl distraido);
 *   `ciente_fluxos`  = "eu vi a lista de fluxos que vao ficar sem arquivo".
 * O modelo e o DELETE de `/api/fluxos`, que ja para em 409 com a lista de quem
 * chama o fluxo. Aqui o dano e o mesmo: o passo continua no fluxo, a mensagem
 * continua saindo, e o arquivo simplesmente nao vai — falha silenciosa na frente
 * do cliente final.
 *
 * FAIL-CLOSED NA IGNORANCIA: se a varredura de fluxos NAO puder ser feita
 * (migration do motor pendente, banco fora), o apagar RECUSA. "Nao sei se algum
 * fluxo usa" nao pode virar "nenhum fluxo usa" — foi assim que este repo
 * descreveu o pior tipo de fail-open.
 */
export type DecisaoExclusao = { ok: true } | { ok: false; status: number; erro: string; detalhe?: string };

export function decidirExclusao(entrada: {
  confirmar: boolean;
  ciente_fluxos: boolean;
  varredura: { ok: true; afetados: readonly FluxoAfetado[] } | { ok: false; aviso: string };
}): DecisaoExclusao {
  if (!entrada.confirmar) {
    return { ok: false, status: 400, erro: "apagar exige confirmacao explicita" };
  }
  if (!entrada.varredura.ok) {
    return {
      ok: false,
      status: 503,
      erro: "nao deu pra conferir quais fluxos usam este arquivo, e por isso o apagar foi recusado",
      detalhe: entrada.varredura.aviso,
    };
  }
  const afetados = entrada.varredura.afetados;
  if (afetados.length && !entrada.ciente_fluxos) {
    return {
      ok: false,
      status: 409,
      erro: "arquivo referenciado por fluxo de automacao",
      detalhe: resumoDoImpacto(afetados),
    };
  }
  return { ok: true };
}
