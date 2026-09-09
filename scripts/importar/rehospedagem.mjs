// RE-HOSPEDAGEM: as pecas que os DOIS passos de importacao compartilham.
//
// POR QUE ESTE ARQUIVO EXISTE (Frente W, 31/08/2026): a re-hospedagem nasceu em
// `midia.mjs` (Frente R) resolvendo a midia das MENSAGENS, e a biblioteca de
// anexos precisa exatamente da mesma mecanica — o endereco do fornecedor morre com
// a conta, entao o arquivo tem que ser baixado, subido pro Storage da instalacao e
// o endereco reescrito. Copiar as funcoes pro segundo passo seria copiar tambem os
// quatro detalhes que doem: o caminho DERIVADO (nunca sorteado), o `x-upsert`, o
// corpo de resposta DRENADO e a extensao que sai da URL antes do mime.
//
// `midia.mjs` continua sendo o dono do assunto "midia das mensagens" e nao mudou
// de comportamento: ele importa daqui as mesmas funcoes que tinha dentro. A prova
// dele (`node scripts/importar/prova-midia.mjs`, que roda a CLI de verdade contra
// backup sintetico e armazenamento local de mentira) e o que garante isso.
//
// TUDO AQUI E SEM ESTADO: nenhuma funcao le variavel de modulo, env nem argv. Quem
// chama passa destino, credencial e bucket. Assim o mesmo codigo serve o passo da
// midia (bucket da instalacao) e o da biblioteca (prefixo `biblioteca/`), e a
// prova exercita as duas sem ambiente nenhum.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Extensao por mime — a tabela medida nos backups, nao a tabela completa da IANA. */
export const EXT_POR_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
};

/**
 * Extensao de um arquivo: a da URL vence a do mime.
 *
 * A ordem nao e estilo. O mime do backup e o que o fornecedor DECLAROU e erra
 * (`application/octet-stream` em pdf, `audio/ogg` em opus); o nome do arquivo na
 * URL e o que o cliente reconhece. Sem nenhum dos dois, `bin` — nunca chutar
 * extensao, porque extensao errada faz o navegador do cliente baixar em vez de
 * abrir.
 */
export function extensaoDe(url, mime) {
  const daUrl = String(url || "").split("?")[0].split("#")[0].split("/").pop() || "";
  const m = daUrl.match(/\.([a-z0-9]{2,5})$/i);
  if (m) return m[1].toLowerCase();
  return EXT_POR_MIME[String(mime || "").toLowerCase()] || "bin";
}

/**
 * Caminho no destino, DERIVADO da origem.
 *
 * Sorteio (uuid, timestamp) faria a segunda passada subir tudo de novo com outro
 * nome — 345 GB duplicados no acervo medido. O caminho sai de um hash da chave de
 * origem: mesma origem, mesmo destino, sempre. `prefixo` separa os assuntos
 * (canal da mensagem, `biblioteca/`).
 */
export function caminhoDerivado(origem, mime, prefixo) {
  const h = crypto.createHash("sha256").update(String(origem)).digest("hex").slice(0, 32);
  const p = String(prefixo || "").replace(/\/+$/, "");
  return `${p ? `${p}/` : ""}${h}.${extensaoDe(origem, mime)}`;
}

/**
 * Nome que o robo de resgate usou na pasta `media/` do backup:
 * `<tipo>_<sha1(url) 20 primeiros hex>.<ext>`. Confirmado nos backups em disco.
 */
export function nomeLocalEsperado(url, tipo, mime) {
  const h = crypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 20);
  return `${tipo || "arquivo"}_${h}.${extensaoDe(url, mime)}`;
}

/**
 * Drena o corpo da resposta.
 *
 * Corpo nao lido segura o socket no undici, e sao DUAS requisicoes por arquivo
 * (upload + reescrita) vezes centenas de milhares de arquivos: sem isto, o
 * `process.exit` aborta no fim de uma carga BEM-SUCEDIDA.
 */
export const drenar = async (r) => {
  try {
    await r.body?.cancel();
  } catch {
    // socket ja fechado: nada a fazer
  }
};

/** Cabecalhos do PostgREST do projeto de destino (schema explicito nos dois sentidos). */
export function cabecalhosRest({ key, schema = "mensageria" }) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Profile": schema,
    "Accept-Profile": schema,
  };
}

/** O endereco publico de um objeto do bucket. UM lugar so monta esta string. */
export function urlPublica({ urlBase, bucket, caminho }) {
  return `${String(urlBase).replace(/\/$/, "")}/storage/v1/object/public/${bucket}/${caminho}`;
}

/**
 * Sobe UM arquivo pro Storage e devolve o endereco publico.
 *
 * `x-upsert` esta ligado de proposito: o caminho e derivado da origem, entao
 * reenviar e o MESMO arquivo — e uma rodada interrompida tem que poder repetir o
 * upload sem colecionar 409.
 */
export async function subirParaStorage({ urlBase, key, bucket, caminho, corpo, mime, schema = "mensageria" }) {
  const r = await fetch(`${String(urlBase).replace(/\/$/, "")}/storage/v1/object/${bucket}/${caminho}`, {
    method: "POST",
    headers: {
      ...cabecalhosRest({ key, schema }),
      "Content-Type": mime || "application/octet-stream",
      "x-upsert": "true",
    },
    body: corpo,
  });
  if (!r.ok) throw new Error(`storage HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  await drenar(r);
  return urlPublica({ urlBase, bucket, caminho });
}

/**
 * Armazenamento LOCAL DE MENTIRA (prova de ponta a ponta sem tocar em bucket).
 *
 * O prefixo publico e OBRIGATORIO e vem de quem chama: o endereco que iria pro
 * banco nao pode ser inventado aqui nem "adivinhado" a partir da pasta.
 */
export function subirParaLocal({ destinoLocal, urlPublicaBase, caminho, corpo }) {
  const destino = path.join(destinoLocal, caminho);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, corpo);
  return `${String(urlPublicaBase).replace(/\/$/, "")}/${caminho}`;
}
