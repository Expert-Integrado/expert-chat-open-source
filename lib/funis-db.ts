import { msgDb } from "@/lib/mensageria";
import {
  montarCatalogo, planoDeMovimento, resolverEtapa, resolverFunil,
  type FunilCatalogo, type PlanoMovimento, type Vinculo,
} from "@/lib/funis";

// Funil e etapas — camada de BANCO (a regra pura mora em lib/funis.ts).
//
// DEGRADACAO SEM 500 (padrao da rota de macros): a migration 0009 e gesto
// humano no SQL Editor. Enquanto ela nao rodar, `mensageria.funis` nao existe e
// TODA leitura daqui devolve `{ ok: false, aviso }` — a rota responde lista
// vazia com aviso, nunca 500. Escrita devolve erro legivel pelo mesmo motivo.
//
// AUTORIZACAO NAO MORA AQUI. Quem chama (rota) ja resolveu usuario, escopo e
// contexto — mesma regra do motor de fluxo (lib/fluxo/executar.ts). Duplicar a
// checagem criaria um segundo lugar pra ela divergir.

export const AVISO_SEM_TABELA =
  "funis indisponiveis nesta instalacao (a migration 0009_funis.sql ja foi aplicada?)";

export type Autor = {
  /** id do usuario; NULL quando quem moveu foi automacao (convencao da 0006) */
  id: string | null;
  nome: string;
};
export type OrigemFluxo = { slug: string; nome: string } | null;

export type LinhaVinculo = {
  canal: string;
  chat_id: string;
  funil_id: string;
  etapa_id: string;
  definido_por_nome: string | null;
  atualizado_em: string | null;
};

export type Falha = { ok: false; aviso: string };
const falha = (e: any): Falha => {
  // 42P01 = tabela nao existe; qualquer outro erro tambem vira aviso legivel
  // (a rota de funil nunca pode derrubar a tela de atendimento)
  if (e?.message) console.error("funis:", e.message);
  return { ok: false, aviso: AVISO_SEM_TABELA };
};

// --------------------------------------------------------------- catalogo
export async function carregarCatalogo(
  opts: { incluirArquivados?: boolean } = {}
): Promise<{ ok: true; catalogo: FunilCatalogo[] } | Falha> {
  const db = msgDb();
  let qFunis = db.from("funis").select("id,nome,ordem,ativo,descricao,origem_sistema,origem_id");
  let qEtapas = db.from("funil_etapas").select("id,funil_id,nome,ordem,cor,ativo,origem_sistema,origem_id");
  if (!opts.incluirArquivados) {
    qFunis = qFunis.eq("ativo", true);
    qEtapas = qEtapas.eq("ativo", true);
  }
  const [f, e] = await Promise.all([qFunis, qEtapas]);
  if (f.error) return falha(f.error);
  if (e.error) return falha(e.error);
  return { ok: true, catalogo: montarCatalogo(f.data ?? [], e.data ?? []) };
}

// ---------------------------------------------------------------- leitura
export async function vinculosDaConversa(
  canal: string,
  chatId: string
): Promise<{ ok: true; vinculos: LinhaVinculo[] } | Falha> {
  const { data, error } = await msgDb()
    .from("conversa_funil")
    .select("canal,chat_id,funil_id,etapa_id,definido_por_nome,atualizado_em")
    .eq("canal", canal)
    .eq("chat_id", chatId);
  if (error) return falha(error);
  return { ok: true, vinculos: (data ?? []) as LinhaVinculo[] };
}

// Vinculos de VARIAS conversas de uma vez — e o que o quadro (kanban) precisa.
// Teto explicito: a rota diz na resposta quando truncou, em vez de mostrar um
// quadro incompleto com cara de completo (licao do `.limit(600)` da listagem).
export async function vinculosPorCanais(
  canais: string[],
  teto = 5000
): Promise<{ ok: true; vinculos: LinhaVinculo[]; truncado: boolean } | Falha> {
  const { data, error } = await msgDb()
    .from("conversa_funil")
    .select("canal,chat_id,funil_id,etapa_id,definido_por_nome,atualizado_em")
    .in("canal", canais)
    .order("atualizado_em", { ascending: false })
    .limit(teto);
  if (error) return falha(error);
  const vinculos = (data ?? []) as LinhaVinculo[];
  return { ok: true, vinculos, truncado: vinculos.length >= teto };
}

// Quantas conversas em cada etapa, numa consulta so. Uma contagem por etapa
// seriam 70 requisicoes na conta medida — este caminho le a coluna e conta em
// memoria, com teto declarado (a resposta diz `truncado`, em vez de mostrar
// numero menor com cara de exato).
export async function contagemPorEtapa(
  teto = 20000
): Promise<{ porEtapa: Record<string, number>; truncado: boolean }> {
  const { data, error } = await msgDb().from("conversa_funil").select("etapa_id").limit(teto);
  if (error) return { porEtapa: {}, truncado: false };
  const porEtapa: Record<string, number> = {};
  for (const v of data ?? []) porEtapa[(v as any).etapa_id] = (porEtapa[(v as any).etapa_id] ?? 0) + 1;
  return { porEtapa, truncado: (data ?? []).length >= teto };
}

export async function contarNaEtapa(etapaId: string): Promise<number | null> {
  const { count, error } = await msgDb()
    .from("conversa_funil")
    .select("etapa_id", { count: "exact", head: true })
    .eq("etapa_id", etapaId);
  if (error) return null;
  return count ?? 0;
}

export async function historicoDaConversa(canal: string, chatId: string, limite = 50) {
  const { data, error } = await msgDb()
    .from("conversa_funil_eventos")
    .select("acao,funil_id,funil_nome,etapa_id,etapa_nome,etapa_anterior_nome,por_id,por_nome,fluxo_nome,criada_em")
    .eq("canal", canal)
    .eq("chat_id", chatId)
    .order("criada_em", { ascending: false })
    .limit(Math.min(200, Math.max(1, limite)));
  if (error) return [];
  return data ?? [];
}

// ---------------------------------------------------------------- trilha
// Melhor-esforco: o movimento JA aconteceu quando esta funcao roda. Falhar aqui
// nao pode desfazer nem mascarar o movimento — some a trilha, fica o log.
async function gravarEvento(linha: Record<string, any>) {
  try {
    const { error } = await msgDb().from("conversa_funil_eventos").insert(linha);
    if (error) console.error("funis/trilha:", error.message);
  } catch (e: any) {
    console.error("funis/trilha:", e?.message || e);
  }
}

// -------------------------------------------------------------- movimento
export type ResultadoMovimento =
  | { ok: true; acao: PlanoMovimento["acao"]; detalhe: string; vinculos: LinhaVinculo[] }
  | { ok: false; erro: string };

/**
 * Move a conversa para uma etapa (ou tira dela, com `etapaId = null`) DENTRO de
 * um funil, sem tocar nos outros funis da conversa. Grava a trilha com autor.
 *
 * Nao checa permissao (ver cabecalho): o chamador ja autorizou.
 */
export async function moverConversa(args: {
  canal: string;
  chatId: string;
  funilId: string;
  etapaId: string | null;
  por: Autor;
  fluxo?: OrigemFluxo;
}): Promise<ResultadoMovimento> {
  const { canal, chatId, funilId, etapaId, por, fluxo = null } = args;
  const db = msgDb();

  // Estrutura primeiro: funil/etapa tem que existir E estar ativa. Mover pra
  // etapa arquivada e recusado com o motivo — nunca em silencio.
  const cat = await carregarCatalogo({ incluirArquivados: true });
  if (!cat.ok) return { ok: false, erro: cat.aviso };
  const funil = cat.catalogo.find((f) => f.id === funilId);
  if (!funil) return { ok: false, erro: "funil nao encontrado" };
  const etapa = etapaId ? funil.etapas.find((e) => e.id === etapaId) : null;
  if (etapaId && !etapa) return { ok: false, erro: "etapa nao encontrada neste funil" };
  if (etapa && !etapa.ativo) return { ok: false, erro: `etapa "${etapa.nome}" esta arquivada` };
  if (etapa && !funil.ativo) return { ok: false, erro: `funil "${funil.nome}" esta arquivado` };

  const atuaisRes = await vinculosDaConversa(canal, chatId);
  if (!atuaisRes.ok) return { ok: false, erro: atuaisRes.aviso };
  const atuais: Vinculo[] = atuaisRes.vinculos.map((v) => ({ etapa_id: v.etapa_id, funil_id: v.funil_id }));
  const plano = planoDeMovimento(atuais, funilId, etapaId);

  if (plano.acao === "nada") {
    return { ok: true, acao: "nada", detalhe: "conversa ja estava nessa etapa", vinculos: atuaisRes.vinculos };
  }

  const agora = new Date().toISOString();
  if (plano.remover.length) {
    const { error } = await db
      .from("conversa_funil")
      .delete()
      .eq("canal", canal)
      .eq("chat_id", chatId)
      .in("etapa_id", plano.remover);
    if (error) return { ok: false, erro: error.message };
  }
  if (plano.inserir) {
    const { error } = await db.from("conversa_funil").upsert(
      {
        canal,
        chat_id: chatId,
        etapa_id: plano.inserir,
        funil_id: funilId,
        definido_por_id: por.id,
        definido_por_nome: por.nome.slice(0, 120),
        fluxo_slug: fluxo?.slug ?? null,
        atualizado_em: agora,
      },
      { onConflict: "canal,chat_id,etapa_id" }
    );
    if (error) return { ok: false, erro: error.message };
  }

  const anterior = plano.anterior ? funil.etapas.find((e) => e.id === plano.anterior) : null;
  await gravarEvento({
    canal,
    chat_id: chatId,
    funil_id: funilId,
    funil_nome: funil.nome,
    etapa_id: etapa?.id ?? null,
    etapa_nome: etapa?.nome ?? null,
    etapa_anterior_id: anterior?.id ?? null,
    etapa_anterior_nome: anterior?.nome ?? null,
    acao: plano.acao,
    por_id: por.id,
    por_nome: por.nome.slice(0, 120),
    fluxo_slug: fluxo?.slug ?? null,
    fluxo_nome: fluxo?.nome ?? null,
    criada_em: agora,
  });

  const depois = await vinculosDaConversa(canal, chatId);
  const detalhe = etapa
    ? `${funil.nome} / ${etapa.nome}${anterior ? ` (era ${anterior.nome})` : ""}`
    : `saiu do funil ${funil.nome}`;
  return { ok: true, acao: plano.acao, detalhe, vinculos: depois.ok ? depois.vinculos : [] };
}

/**
 * Mesma coisa, mas resolvendo funil+etapa por NOME — e o caminho do MOTOR DE
 * FLUXO, que e portatil entre instalacoes e nao conhece os uuid daqui.
 * `nomeEtapa = null` tira a conversa do funil.
 */
export async function moverConversaPorNome(args: {
  canal: string;
  chatId: string;
  nomeFunil: string;
  nomeEtapa: string | null;
  por: Autor;
  fluxo?: OrigemFluxo;
}): Promise<ResultadoMovimento> {
  const cat = await carregarCatalogo({ incluirArquivados: true });
  if (!cat.ok) return { ok: false, erro: cat.aviso };

  // "sair do funil" so precisa achar o funil; a igualdade de nome (acento,
  // caixa, espaco) e a MESMA funcao pura usada na resolucao de etapa — dois
  // criterios de igualdade seria a receita pra o fluxo achar um funil e o
  // importador achar outro.
  if (args.nomeEtapa === null) {
    const alvo = resolverFunil(cat.catalogo, args.nomeFunil);
    if (!alvo) return { ok: false, erro: `funil "${args.nomeFunil}" nao existe nesta instalacao` };
    return moverConversa({ ...args, funilId: alvo.id, etapaId: null });
  }

  const r = resolverEtapa(cat.catalogo, args.nomeFunil, args.nomeEtapa);
  if (!r.ok) return { ok: false, erro: r.erro };
  return moverConversa({ ...args, funilId: r.funil.id, etapaId: r.etapa.id });
}
