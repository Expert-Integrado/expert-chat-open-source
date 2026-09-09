import { createHash } from "node:crypto";
import { msgDb } from "@/lib/mensageria";
import { erroDeSchemaAusente } from "@/lib/acesso";
import {
  ACAO_ANEXO,
  PREFIXO_ANEXOS,
  caminhoDoAnexo,
  extensaoDe,
  caminhoDeAnexoNaUrl,
  varrerFluxosQueUsam,
  type FluxoAfetado,
  type LinhaFluxo,
  type VarreduraDeFluxos,
} from "@/lib/anexos";

// O PREFIXO E O CAMINHO DE SUBIDA MORAM NO ARQUIVO PURO e sao re-exportados aqui
// pra quem ja os importava daqui. Nao redefinir: prefixo escrito a mao em dois
// lugares e o comeco de duas verdades diferentes — subir num e apagar noutro.
export { PREFIXO_ANEXOS, caminhoDoAnexo };

// BIBLIOTECA DE ANEXOS — a camada de banco e de Storage (Frente W, 86ak85bmw).
//
// A REGRA NAO MORA AQUI: quem decide o que passa e `lib/anexos.ts`, que nao
// importa nada e roda em node solto. Este arquivo e I/O — le, grava, sobe e
// apaga — e a unica coisa que ele decide sozinho e como DEGRADAR quando a
// migration 0024 nao rodou.
//
// DEGRADACAO, o padrao da casa (mesma promessa de /api/macros e /api/fluxos):
// tabela ausente devolve `{ok:false, aviso}` e a rota responde lista vazia com o
// aviso, ou 503 na escrita — NUNCA 500 e NUNCA 200 fingindo que salvou.
// Re-testa a cada 60s: no minuto seguinte a migration rodar, a biblioteca passa
// a valer sem redeploy.

/**
 * O BUCKET E O QUE A INSTALACAO JA TEM.
 *
 * `midia-mensagens` (publico, criado pra midia de conversa) com o prefixo
 * `biblioteca/`. Bucket novo por instalacao seria mais um gesto manual — e o
 * gesto manual que ninguem faz e a feature que nasce quebrada. E o mesmo
 * raciocinio que fez a foto do atendente reusar `fotos-perfil` no prefixo
 * `usuarios/` (Frente G).
 *
 * Ele e PUBLICO por necessidade, nao por descuido: a URL vai pro provedor, que
 * baixa o arquivo pra entregar no WhatsApp do cliente. Por isso o portao de tipo
 * (`validarArquivo`) recusa SVG e pagina web — os dois carregam script e ficariam
 * hospedados no dominio da instalacao.
 */
export const BUCKET_ANEXOS = process.env.MSG_STORAGE_BUCKET || "midia-mensagens";

const COL_INEXISTENTE = "42703";
/** teto de leitura do acervo. 3.287 itens em 33 contas medidas (153 na maior). */
export const LIMITE_ACERVO = 2000;
/**
 * Teto da varredura de fluxos. O MESMO numero de `/api/fluxos`
 * (`LIMITE_VARREDURA`), e nao por acaso: a conta medida tem 935 DIALOGOS na origem
 * (o numero e do ChatGuru, nao de linhas em `mensageria.fluxos`) e as duas
 * telas precisam contar a MESMA coisa. Se a leitura bater no teto, a varredura
 * devolve `truncado` e o apagar RECUSA (ver `varrerFluxosQueUsam`).
 */
export const LIMITE_VARREDURA_FLUXOS = 2000;

const COLS =
  "id,chave,nome,descricao,etiquetas,arquivo_nome,mime,bytes,url,ultimo_uso_em," +
  "criado_por_id,criado_por_nome,atualizado_por_id,atualizado_por_nome,criada_em,atualizada_em," +
  "origem_ferramenta,origem_id";

export type LinhaAnexo = {
  id: string;
  chave: string;
  nome: string;
  descricao: string | null;
  etiquetas: string[] | null;
  arquivo_nome: string;
  mime: string;
  bytes: number | null;
  url: string;
  ultimo_uso_em: string | null;
  criado_por_id: string | null;
  criado_por_nome: string | null;
  atualizado_por_id: string | null;
  atualizado_por_nome: string | null;
  criada_em: string;
  atualizada_em: string;
  origem_ferramenta: string | null;
  origem_id: string | null;
};

export type Leitura =
  | { ok: true; linhas: LinhaAnexo[]; truncado: boolean }
  | { ok: false; aviso: string };

const AVISO_SEM_0024 =
  "biblioteca de anexos indisponivel: falta rodar a migration 0024 nesta instalacao";

// marca de "sem a 0024", re-testada a cada 60s (padrao de /api/fluxos e
// /api/perfil): a migration e gesto humano e pode rodar a qualquer momento.
let marcaSem0024 = 0;
export function bibliotecaIndisponivel(): boolean {
  return Date.now() - marcaSem0024 < 60_000;
}
function anotarAusencia(erro: any): boolean {
  if (erroDeSchemaAusente(erro) || String(erro?.code) === COL_INEXISTENTE) {
    marcaSem0024 = Date.now();
    return true;
  }
  return false;
}

function normalizarLinha(row: any): LinhaAnexo {
  return {
    ...row,
    // jsonb livre: lista torta no banco nao pode derrubar a listagem inteira
    etiquetas: Array.isArray(row?.etiquetas) ? row.etiquetas.filter((e: unknown) => typeof e === "string") : [],
  } as LinhaAnexo;
}

/** O acervo inteiro (com teto). A busca e o filtro rodam em memoria — ver lib/anexos.ts. */
export async function listarAnexos(limite = LIMITE_ACERVO): Promise<Leitura> {
  const { data, error } = await msgDb()
    .from("anexos")
    .select(COLS)
    .order("criada_em", { ascending: false })
    .limit(limite + 1);
  if (error) {
    anotarAusencia(error);
    console.error("anexos/listar:", error.message);
    return { ok: false, aviso: AVISO_SEM_0024 };
  }
  const linhas = (data ?? []).map(normalizarLinha);
  return { ok: true, linhas: linhas.slice(0, limite), truncado: linhas.length > limite };
}

export type LeituraUm = { ok: true; linha: LinhaAnexo | null } | { ok: false; aviso: string };

async function um(coluna: "id" | "chave", valor: string): Promise<LeituraUm> {
  const { data, error } = await msgDb().from("anexos").select(COLS).eq(coluna, valor).maybeSingle();
  if (error) {
    anotarAusencia(error);
    console.error("anexos/um:", error.message);
    return { ok: false, aviso: AVISO_SEM_0024 };
  }
  return { ok: true, linha: data ? normalizarLinha(data) : null };
}

export const anexoPorId = (id: string) => um("id", id);
export const anexoPorChave = (chave: string) => um("chave", chave);

// ————————————————————————————————————————————————————————————— Storage
// O CAMINHO DO OBJETO PRA SUBIDA (`biblioteca/<chave>.<ext>`) vem de
// `lib/anexos.ts` (`caminhoDoAnexo`, re-exportado la em cima) e e re-exportado
// daqui pra quem ja o importava.
//
// A IMPORTACAO USA ESTE MESMO CAMINHO — `scripts/importar/anexos.mjs` define a
// sua propria copia de `caminhoDoAnexo(chave, ext)`, identica. NAO existe assertion
// de PARIDADE travando as duas (a 4a re-revisao mediu, e a frase que estava aqui
// afirmava isso): o que existe sao DOIS PINOS INDEPENDENTES no mesmo literal —
// `prova-anexos` (a de `lib/`) sobre `caminhoDoAnexo`, e
// `scripts/importar/prova-anexos.mjs` fixando `biblioteca/<chave>.<ext>` no destino
// do mock. Divergir as duas copias exige quebrar os dois pinos, mas nenhum dos dois
// compara uma com a outra. NAO e `sha256(url de origem)` como o comentario
// daqui ja afirmou: aquela e a convencao do passo de MIDIA (Frente R), outra
// coisa. A diferenca importa porque as duas portas escrevem no MESMO objeto: por
// isso a tela e o importador conferem a chave ANTES de subir, e nenhum dos dois
// trata "nao consegui ler" como "a chave esta livre".
//
// Trocar o arquivo de um item ja usado por fluxos NAO tem porta hoje — nem aqui,
// nem no PATCH (que so mexe em descricao e etiquetas). Se um dia tiver, e rota
// propria, com a mesma varredura de fluxos afetados que o apagar faz: trocar o
// material de N fluxos e tao irreversivel quanto apagar.

export function urlPublicaDoAnexo(caminho: string, versao: string): string | null {
  const base = process.env.MSG_SUPABASE_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/storage/v1/object/public/${BUCKET_ANEXOS}/${caminho}?v=${versao}`;
}

/** O caminho DENTRO do bucket, derivado da URL gravada (serve pra tela e pra importacao). */
export function caminhoDaUrl(url: unknown): string | null {
  // A decisao inteira — inclusive a trava do prefixo, que impede o apagar da
  // biblioteca alcancar midia de conversa — mora em lib/anexos.ts, PURA e provada
  // com URL de verdade. Daqui so entra o BUCKET desta instalacao, e ele e o
  // argumento seguro de errar: bucket trocado nao casa a marca da URL, devolve
  // null e nada e apagado. O prefixo, que era o argumento perigoso, deixou de ser
  // argumento (constante do modulo puro) — nao ha mais o que passar errado.
  return caminhoDeAnexoNaUrl(url, BUCKET_ANEXOS);
}

export type Subida = { ok: true; url: string; caminho: string } | { ok: false; erro: string };

export async function subirAnexo(
  bytes: Uint8Array,
  dados: { chave: string; ext: string; mime: string }
): Promise<Subida> {
  const caminho = caminhoDoAnexo(dados.chave, dados.ext);
  const { error } = await msgDb().storage.from(BUCKET_ANEXOS).upload(caminho, bytes, {
    contentType: dados.mime,
    upsert: true,
  });
  if (error) {
    console.error("anexos/subir:", error.message);
    return {
      ok: false,
      erro: `nao consegui guardar o arquivo. Confira se o bucket publico '${BUCKET_ANEXOS}' existe nesta instalacao.`,
    };
  }
  const versao = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const url = urlPublicaDoAnexo(caminho, versao);
  if (!url) return { ok: false, erro: "Storage nao configurado nesta instalacao (falta MSG_SUPABASE_URL)." };
  return { ok: true, url, caminho };
}

/** Remove o objeto. Melhor-esforco: quem chama DIZ na resposta quando falhou. */
export async function removerArquivoDoAnexo(url: unknown): Promise<boolean> {
  const caminho = caminhoDaUrl(url);
  if (!caminho) return false;
  try {
    const { error } = await msgDb().storage.from(BUCKET_ANEXOS).remove([caminho]);
    if (error) {
      console.error("anexos/remover-arquivo:", error.message);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error("anexos/remover-arquivo:", e?.message ?? e);
    return false;
  }
}

// —————————————————————————————————————————————————————————— escrita
export type Autor = { id: string | null; nome: string };

export type Gravacao = { ok: true; linha: LinhaAnexo } | { ok: false; status: number; erro: string };

export async function criarAnexo(dados: {
  chave: string;
  nome: string;
  descricao: string;
  etiquetas: string[];
  arquivo_nome: string;
  mime: string;
  bytes: number;
  url: string;
  autor: Autor;
}): Promise<Gravacao> {
  const agora = new Date().toISOString();
  const { data, error } = await msgDb()
    .from("anexos")
    .insert({
      chave: dados.chave,
      nome: dados.nome,
      descricao: dados.descricao || null,
      etiquetas: dados.etiquetas,
      arquivo_nome: dados.arquivo_nome,
      mime: dados.mime,
      bytes: dados.bytes,
      url: dados.url,
      criado_por_id: dados.autor.id,
      criado_por_nome: dados.autor.nome,
      atualizado_por_id: dados.autor.id,
      atualizado_por_nome: dados.autor.nome,
      criada_em: agora,
      atualizada_em: agora,
    })
    .select(COLS)
    .maybeSingle();
  if (error) {
    if (anotarAusencia(error)) return { ok: false, status: 503, erro: AVISO_SEM_0024 };
    // 23505 = a chave ja existe. A tela oferece outra; a rota nao "conserta"
    // sozinha acrescentando -2, porque a chave e a identidade que o FLUXO
    // referencia e escolher por conta propria produziria a chave que ninguem
    // configurou.
    if (String((error as any).code) === "23505") {
      return { ok: false, status: 409, erro: `ja existe um arquivo com a chave "${dados.chave}"` };
    }
    console.error("anexos/criar:", error.message);
    return { ok: false, status: 500, erro: "nao consegui gravar o arquivo na biblioteca" };
  }
  if (!data) return { ok: false, status: 500, erro: "nao consegui gravar o arquivo na biblioteca" };
  return { ok: true, linha: normalizarLinha(data) };
}

export async function atualizarAnexo(
  id: string,
  campos: { descricao?: string; etiquetas?: string[] },
  autor: Autor
): Promise<Gravacao> {
  const patch: Record<string, unknown> = {
    atualizado_por_id: autor.id,
    atualizado_por_nome: autor.nome,
    atualizada_em: new Date().toISOString(),
  };
  // CAMPO AUSENTE MANTEM O VALOR GRAVADO (PATCH por campo, o padrao que a Frente S
  // deixou nas agendadas e a Frente Q no escopo de chave): mandar `descricao:
  // null` de brinde apagaria a descricao de quem so quis etiquetar.
  if (campos.descricao !== undefined) patch.descricao = campos.descricao || null;
  if (campos.etiquetas !== undefined) patch.etiquetas = campos.etiquetas;

  const { data, error } = await msgDb().from("anexos").update(patch).eq("id", id).select(COLS).maybeSingle();
  if (error) {
    if (anotarAusencia(error)) return { ok: false, status: 503, erro: AVISO_SEM_0024 };
    console.error("anexos/atualizar:", error.message);
    return { ok: false, status: 500, erro: "nao consegui salvar a alteracao" };
  }
  if (!data) return { ok: false, status: 404, erro: "arquivo nao encontrado" };
  return { ok: true, linha: normalizarLinha(data) };
}

export type Exclusao =
  | { ok: true; arquivo_removido: boolean }
  | { ok: false; status: number; erro: string };

/**
 * Apaga a LINHA e depois o ARQUIVO, nesta ordem.
 *
 * A ordem e decisao: linha apontando pra objeto que nao existe mais e PIOR que
 * objeto orfao no bucket — o fluxo continua mandando o anexo e o cliente recebe
 * um link morto, sem erro em lugar nenhum. Objeto orfao e um arquivo a mais no
 * bucket, alcancavel so por quem ja tinha o link.
 *
 * Falha na remocao do objeto NAO derruba o apagar, e a resposta DIZ isso
 * (`arquivo_removido:false`): esconder faria o admin achar que o material saiu do
 * ar quando ele continua acessivel por quem tem a URL.
 */
export async function apagarAnexo(linha: LinhaAnexo): Promise<Exclusao> {
  const { error } = await msgDb().from("anexos").delete().eq("id", linha.id);
  if (error) {
    if (anotarAusencia(error)) return { ok: false, status: 503, erro: AVISO_SEM_0024 };
    console.error("anexos/apagar:", error.message);
    return { ok: false, status: 500, erro: "nao consegui apagar o arquivo da biblioteca" };
  }
  const arquivo_removido = await removerArquivoDoAnexo(linha.url);
  return { ok: true, arquivo_removido };
}

/**
 * Carimba o ultimo uso. MELHOR-ESFORCO de proposito: ele acontece DEPOIS de a
 * mensagem sair, e virar erro faria um envio bem-sucedido parecer falha (no caso
 * da fila, viraria retentativa — mensagem em dobro pro cliente, a licao que
 * `enviarTexto` ja carrega).
 */
export async function registrarUso(id: string): Promise<void> {
  const { error } = await msgDb()
    .from("anexos")
    .update({ ultimo_uso_em: new Date().toISOString() })
    .eq("id", id);
  if (error) console.error("anexos/uso:", error.message);
}

/** Trilha append-only. Melhor-esforco COM await (promessa solta morre em serverless). */
export async function registrarEventoAnexo(evento: {
  anexo_id: string | null;
  chave: string | null;
  nome: string | null;
  tipo: "criado" | "descrito" | "etiquetado" | "apagado" | "usado";
  autor: Autor;
  detalhe?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { error } = await msgDb().from("anexo_eventos").insert({
      anexo_id: evento.anexo_id,
      chave: evento.chave,
      nome: evento.nome,
      tipo: evento.tipo,
      autor_id: evento.autor.id,
      autor_nome: evento.autor.nome,
      detalhe: evento.detalhe ?? {},
    });
    if (error) console.error("anexos/trilha:", error.message);
  } catch (e: any) {
    console.error("anexos/trilha:", e?.message ?? e);
  }
}

export type EventoAnexo = {
  id: number;
  tipo: string;
  chave: string | null;
  nome: string | null;
  autor_nome: string | null;
  detalhe: Record<string, unknown>;
  criada_em: string;
};

export async function trilhaDoAnexo(
  id: string,
  limite = 50
): Promise<{ ok: true; eventos: EventoAnexo[] } | { ok: false; aviso: string }> {
  const { data, error } = await msgDb()
    .from("anexo_eventos")
    .select("id,tipo,chave,nome,autor_nome,detalhe,criada_em")
    .eq("anexo_id", id)
    .order("criada_em", { ascending: false })
    .limit(limite);
  if (error) {
    anotarAusencia(error);
    return { ok: false, aviso: AVISO_SEM_0024 };
  }
  return { ok: true, eventos: (data ?? []) as EventoAnexo[] };
}

// ——————————————————————————————————— quem usa este anexo (fluxos)
/**
 * O EXECUTOR da varredura de fluxos — a funcao que `varrerFluxosQueUsam`
 * (lib/anexos.ts, pura) recebe por parametro. Aqui so tem I/O: le a tabela de
 * fluxos com teto e devolve linha + erro + `truncado`. Quem DECIDE o que cada
 * desfecho significa (inclusive que `42P01` libera e `PGRST205` recusa) e a
 * funcao pura, que a prova exercita com fake.
 *
 * Le `nos` INTEIRO de proposito: a referencia e lida por FORMA (caminhando os nos
 * e olhando `acao.tipo`), nunca por busca de texto no jsonb — procurar a chave
 * como texto casaria com o CONTEUDO de uma mensagem que por acaso cita o slug, e
 * o gestor veria na lista de impacto um fluxo que nao tem anexo nenhum.
 */
export function lerFluxosDaInstalacao() {
  return async () => {
    const { data, error } = await msgDb()
      .from("fluxos")
      .select("slug,nome,ativo,fluxo")
      .limit(LIMITE_VARREDURA_FLUXOS + 1);
    if (error) return { error: { code: (error as any).code, message: error.message } };
    const linhas = (data ?? []) as unknown as LinhaFluxo[];
    return {
      linhas: linhas.slice(0, LIMITE_VARREDURA_FLUXOS),
      truncado: linhas.length > LIMITE_VARREDURA_FLUXOS,
    };
  };
}

export function varrerFluxos(chave: string): Promise<VarreduraDeFluxos> {
  return varrerFluxosQueUsam(chave, lerFluxosDaInstalacao());
}

/** Uso por chave pra listagem ("usado em N fluxos"). Falha vira `null` — a tela omite a coluna. */
export async function usoDeAnexosPorFluxo(): Promise<Record<string, number> | null> {
  const r = await lerFluxosDaInstalacao()();
  if ((r as any).error) return null;
  const { usoPorChave } = await import("@/lib/anexos");
  return usoPorChave(((r as any).linhas ?? []) as LinhaFluxo[]);
}

/** O tipo da acao de fluxo que referencia a biblioteca, reexportado pra rota nao reimportar. */
export { ACAO_ANEXO, extensaoDe };
export type { FluxoAfetado };
