// A leitura PURA do catalogo de anexos da origem, e a chave que cada item recebe.
//
// SEPARADO DA CLI (`anexos.mjs`) de proposito: e isto que a prova precisa
// exercitar sem tocar em disco, em rede nem em argv — e e daqui que o CONVERSOR de
// dialogos tira a mesma nocao de chave. Zero import de node: funcao pura, entrada
// JSON, saida objeto.
//
// COPIA DELIBERADA DE `lib/anexos.ts` (a regra da chave). O painel calcula a chave
// em TypeScript; este lado tem que rodar onde o Node nao le TypeScript. Copia sem
// prova e copia que diverge, entao a divergencia e travada por assertion:
// `scripts/prova-anexos.ts` importa AS DUAS PONTAS e compara sobre uma lista de
// nomes hostis (acento, emoji, espaco, ponto, caixa, nome so de simbolo, nome
// gigante). Mesmo padrao que `ALCANCAM_CLIENTE` do conversor de fluxos ja usa.

export const LIMITE_CHAVE = 60;
const RE_CHAVE = /^[a-z0-9][a-z0-9_-]{0,59}$/;

// As marcas combinantes vao por CODIGO, nunca como caractere literal: marca
// literal no fonte e invisivel no editor e some numa conversao de encoding,
// levando a normalizacao com ela (mesma nota de lib/anexos.ts).
const MARCAS = new RegExp("[\\u0300-\\u036f]", "g");
const semAcento = (t) => String(t).normalize("NFD").replace(MARCAS, "");

/** A chave e a identidade PORTATIL do item — o que o passo de automacao guarda. */
export function chaveDeAnexo(bruto) {
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

/**
 * Duas linhas do catalogo podem gerar a MESMA chave ("Tabela.pdf" e "tabela.PDF").
 * A segunda ganha sufixo na ORDEM DO CATALOGO — determinismo importa mais que
 * beleza: e o mapa emitido que o conversor de fluxos vai ler, e rodar duas vezes
 * tem que dar a mesma chave pro mesmo item.
 *
 * Sem chave possivel (nome so de simbolo), devolve null e o item cai fora com
 * motivo declarado: chave sorteada seria um item que ninguem acha na busca e que o
 * fluxo referencia por um nome que nao significa nada.
 */
export function chaveUnica(nome, usadas) {
  const base = chaveDeAnexo(nome);
  if (!base) return null;
  if (!usadas.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const sufixo = `-${i}`;
    const tentativa = `${base.slice(0, LIMITE_CHAVE - sufixo.length)}${sufixo}`;
    if (!usadas.has(tentativa) && RE_CHAVE.test(tentativa)) return tentativa;
  }
  return null;
}

// MIME/EXTENSAO QUE NAO PODEM ENTRAR: o bucket e PUBLICO e o Storage serve o
// objeto com o Content-Type que a importacao mandar. SVG e HTML sao script
// executavel no dominio da instalacao — recusados por mime E por extensao, os
// dois, porque o catalogo do fornecedor as vezes traz `application/octet-stream`
// num .svg.
//
// ESTA E A PRIMEIRA PENEIRA, NAO A DECISAO. Ela roda na leitura do CATALOGO, onde
// so existe o que a origem declarou, e serve pra nem baixar o que ja se assume
// script. Quem DECIDE e `marcacaoNoInicio` (mais abaixo neste arquivo), aplicada
// em `anexos.mjs` com os BYTES na mao — depois do download e ANTES do upload —,
// que e a mesma trava da tela (`assinaturaDeArquivo`, lib/anexos.ts).
//
// O que estava escrito aqui — "os bytes ainda nao estao na mao quando o item e
// triado, entao a triagem e por tipo declarado" — era a justificativa FALSA que
// segurou o defeito: os bytes chegam sim, e agora sao cheirados. Comentario errado
// e pior que comentario ausente, e este ficou de pe ate depois do proprio conserto.
const MIME_RECUSADO = /^(image\/svg|text\/html|application\/xhtml)/i;
const EXT_RECUSADA = /\.(svg|svgz|html?|xhtml|js|mjs|mhtml)$/i;

const limpo = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Etiquetas do item, com DEDUPE POR FORMA NORMALIZADA — a mesma regra de
 * `etiquetasDeAnexo` (lib/anexos.ts): "Comercial" e "comercial" sao a MESMA
 * etiqueta pra quem filtra, e o texto que fica e o PRIMEIRO que apareceu.
 *
 * Terceira copia deliberada deste arquivo, travada pela mesma prova: sem ela, um
 * item da conta medida entrava na biblioteca com a etiqueta repetida em duas
 * caixas, e o filtro da tela mostraria as duas.
 */
export function etiquetasDoCatalogo(bruto, limite = 20) {
  const vistas = new Set();
  const saida = [];
  for (const item of Array.isArray(bruto) ? bruto : []) {
    const texto = limpo(item).replace(/\s{2,}/g, " ");
    if (!texto) continue;
    const forma = semAcento(texto).toLowerCase();
    if (vistas.has(forma)) continue;
    vistas.add(forma);
    saida.push(texto);
    if (saida.length >= limite) break;
  }
  return saida;
}

/**
 * Le o `attachments_search.json` da origem e devolve os itens JA com chave,
 * endereco de origem e motivo de recusa quando houver.
 *
 * A LEITURA E A MESMA de `config-restante.mjs` (que ja inventaria este arquivo):
 * id, nome, mime, bytes, etiquetas, descricao e a URL montada como
 * `path_relative` + `/` + `name`.
 *
 * O TAMANHO REAL VIAJA SEPARADO do capturado, e isso nao e detalhe: a tela de
 * anexos da origem e PAGINADA e o backup guardou UMA pagina (medido nos 33
 * backups: 795 capturados contra 3.287 declarados). Somar a fatia achando que
 * somou o acervo foi o defeito que a Frente R corrigiu no inventario — aqui ele
 * nao pode voltar, porque um mapa "completo" que nao esta faria o conversor
 * transformar "nao capturado" em "nao existe".
 */
export function inventarioDeAnexos(j) {
  const lista = Array.isArray(j) ? j : Array.isArray(j?.attachments) ? j.attachments : [];
  const totalOrigem = Number(Array.isArray(j) ? NaN : j?.total_results);
  const itens = [];
  const usadas = new Set();
  for (const a of lista) {
    const origem_id = limpo(a?._id?.$oid ?? a?._id ?? a?.id);
    const arquivo = limpo(a?.name);
    const nome = limpo(a?.original_name) || arquivo;
    const base = a?.path_relative ? String(a.path_relative).replace(/\/+$/, "") : "";
    const url = base && arquivo ? `${base}/${arquivo}` : "";
    const mime = limpo(a?.mime);
    const bytes = Number(a?.size) > 0 ? Number(a.size) : null;
    const etiquetas = etiquetasDoCatalogo(a?.tags);
    // a descricao do catalogo e o TEXTO que acompanhava o envio: conteudo real, e
    // some junto se ninguem levar
    const descricao = limpo(a?.description);
    let motivo = null;
    if (!origem_id) motivo = "item sem id na origem (nao da pra importar sem identidade)";
    else if (!nome) motivo = "item sem nome nem nome de arquivo";
    else if (!url) motivo = "item sem endereco de origem (path_relative ou name faltando)";
    else if (MIME_RECUSADO.test(mime) || EXT_RECUSADA.test(arquivo)) {
      motivo =
        `tipo recusado de proposito (${mime || "sem mime"}, ${arquivo}): ` +
        `svg/html no armazenamento publico e script no dominio da instalacao`;
    }
    const chave = motivo ? null : chaveUnica(nome, usadas);
    if (!motivo && !chave) motivo = `nao da pra montar chave a partir do nome ("${nome.slice(0, 30)}")`;
    if (chave) usadas.add(chave);
    itens.push({ origem_id, nome, arquivo, mime, bytes, etiquetas, descricao, url, chave, motivo });
  }
  const capturados = lista.length;
  const total_na_origem = Number.isFinite(totalOrigem) ? totalOrigem : null;
  return {
    itens,
    capturados,
    total_na_origem,
    parcial: total_na_origem !== null && capturados < total_na_origem,
    paginas: Number(j?.total_pages) || (capturados ? 1 : 0),
    pagina: Number(j?.current_page) || (capturados ? 1 : 0),
  };
}

/**
 * DE QUEM E A CHAVE, antes de qualquer upload — decisao PURA.
 *
 * O caminho do objeto no bucket e deterministico (`biblioteca/<chave>.<ext>`) e a
 * subida e upsert. Entao esta funcao decide, com o que ja existe no painel, se
 * escrever naquele caminho reescreve o arquivo do PROPRIO item (reimportacao, que
 * e a idempotencia do passo) ou o de OUTRO item (que seria trocar, em silencio, o
 * material que N fluxos ja mandam pro cliente).
 *
 * `dono` = a linha que ja ocupa a chave (`{origem_ferramenta, origem_id}`), ou
 * null/undefined quando a chave esta livre. `donos` ILEGIVEL nao chega aqui: quem
 * chama trata "nao consegui ler" como motivo pra nao subir NADA, nunca como livre.
 *
 * Devolve "livre" | "meu" | "de_outro".
 */
export function donoDaChave(dono, { origem, origem_id }) {
  if (!dono) return "livre";
  const mesmaOrigem = dono.origem_ferramenta === origem;
  // origem_id nulo dos dois lados NAO e igualdade: linha sem origem_id e a que a
  // TELA criou, e ela nunca e "minha".
  const mesmoItem =
    dono.origem_id != null && origem_id != null && String(dono.origem_id) === String(origem_id);
  return mesmaOrigem && mesmoItem ? "meu" : "de_outro";
}

/**
 * OS BYTES COMECAM COM MARCACAO (`<`)? — a MESMA trava que a tela aplica.
 *
 * O importador tinha os bytes na mao e triava so pelo tipo DECLARADO pela origem,
 * enquanto a tela decide pela assinatura. Duas portas pro MESMO bucket publico com
 * confianca diferente: bastava a origem declarar `application/pdf` num arquivo que
 * e `<svg>`/`<html>` pra ele ir parar numa URL publica do dominio da instalacao —
 * que e o caso que `lib/anexos.ts` recusa de proposito (XSS hospedado por nos).
 *
 * Esta e a trava MINIMA e suficiente: pula BOM e espaco em branco e olha se o
 * primeiro caractere de conteudo e `<`. E o mesmo criterio de
 * `comecaComSinalDeMarcacao` no painel, e a prova compara as duas em cima dos
 * MESMOS bytes (paridade por comportamento, nao por texto).
 *
 * ESTREITAMENTO DECLARADO: XML legitimo como MATERIAL (um `.xml` de catalogo, um
 * `.svg` de logo) era importavel antes e nao e mais — todo arquivo que comeca com
 * `<` cai aqui. O painel NUNCA aceitou esses arquivos, entao isto e convergencia
 * de proposito com a tela, nao regressao: o acervo importado passa a ter
 * exatamente o que a tela deixaria subir.
 */
export function marcacaoNoInicio(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3; // BOM UTF-8
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  return b[i] === 0x3c;
}
