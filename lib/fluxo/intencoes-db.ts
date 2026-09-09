import { msgDb } from "@/lib/mensageria";
import { validarIntencao, type Intencao } from "@/lib/fluxo/intencoes";

// INTENCOES — camada de BANCO (card 86ak85nzr).
//
// A REGRA e pura e mora em `lib/fluxo/intencoes.ts` (pontuacao, normalizacao,
// validacao). Aqui so tem SQL e degradacao.
//
// DEGRADACAO SEM 500 (mesmo padrao de lib/fluxo/contexto-db.ts e lib/funis-db.ts):
// a migration 0022 e gesto humano no SQL Editor. Enquanto nao rodar, a leitura
// devolve `{ok:false, aviso}` e a escrita devolve erro legivel; a condicao de
// intencao passa a nunca bater (lista vazia), que e o mesmo efeito de uma conta
// sem intencao nenhuma — e conta sem intencao TEM que funcionar (criterio de
// aceite do card).
//
// AUTORIZACAO NAO MORA AQUI: quem chama (rota, motor) ja resolveu usuario e
// escopo. Duplicar criaria um segundo lugar pra regra divergir.

export const AVISO_SEM_TABELA =
  "intencoes indisponiveis nesta instalacao (a migration 0022_intencoes.sql ja foi aplicada?)";

export type Falha = { ok: false; aviso: string };
export type Autor = { id: string | null; nome: string };

const COLS = "id,nome,palavras_chave,frases,pontuacao_minima,ativo,origem_ferramenta,origem_id,atualizada_em,atualizado_por_nome";

// Cada CAUSA ganha o seu texto: acusar "migration nao rodada" em qualquer erro
// manda a pessoa pro lugar errado quando o problema e grant, rede ou coluna.
//   42P01/PGRST205 tabela nao existe | 42703/PGRST204 coluna nao existe
//   (migration antiga) | 42501 permissao (tabela existe, faltou o grant)
const falha = (e: any): Falha => {
  const codigo = String(e?.code ?? "");
  const msg = String(e?.message ?? "");
  if (msg) console.error("intencoes:", codigo ? `${codigo} ${msg}` : msg);
  if (["42P01", "PGRST205", "42703", "PGRST204"].includes(codigo)) return { ok: false, aviso: AVISO_SEM_TABELA };
  if (codigo === "42501") {
    return {
      ok: false,
      aviso: "sem permissao nas intencoes (a tabela existe; falta o grant do service_role da 0022)",
    };
  }
  return {
    ok: false,
    aviso: `nao deu pra falar com as intencoes${codigo ? ` (${codigo})` : ""}: ${msg || "erro sem mensagem"}`,
  };
};

export type LinhaIntencao = Intencao & {
  origem_ferramenta: string | null;
  origem_id: string | null;
  atualizada_em: string | null;
  atualizado_por_nome: string | null;
};

// TETO de leitura: o catalogo medido tem 52 intencoes em 33 contas, mas o
// reconhecimento roda a cada mensagem recebida — um catalogo inflado por
// importacao repetida nao pode virar varredura sem fim. Acima do teto, a rota
// avisa (mesma promessa do `truncado` das outras telas).
export const LIMITE_INTENCOES = 500;

function daLinha(row: any): LinhaIntencao | null {
  const v = validarIntencao({
    id: row?.id,
    nome: row?.nome,
    palavras_chave: Array.isArray(row?.palavras_chave) ? row.palavras_chave : [],
    frases: Array.isArray(row?.frases) ? row.frases : [],
    pontuacao_minima: row?.pontuacao_minima,
    ativo: row?.ativo,
  });
  // Linha que o validador recusa (gravada a mao, ou de uma versao futura) e
  // DESCARTADA da leitura em vez de derrubar a lista: uma intencao torta nao pode
  // apagar as outras 51 da tela. Ela continua no banco pra ser consertada.
  if (!v.ok) {
    console.error("intencoes: linha invalida ignorada", row?.id, v.erros.join(" | "));
    return null;
  }
  return {
    ...v.intencao,
    origem_ferramenta: row?.origem_ferramenta ?? null,
    origem_id: row?.origem_id ?? null,
    atualizada_em: row?.atualizada_em ?? null,
    atualizado_por_nome: row?.atualizado_por_nome ?? null,
  };
}

export async function listarIntencoes(
  opcoes: { somenteAtivas?: boolean } = {}
): Promise<{ ok: true; intencoes: LinhaIntencao[]; truncado: boolean } | Falha> {
  let q = msgDb().from("intencoes").select(COLS).order("nome").limit(LIMITE_INTENCOES + 1);
  if (opcoes.somenteAtivas) q = q.eq("ativo", true);
  const { data, error } = await q;
  if (error) return falha(error);
  const linhas = (data ?? []) as any[];
  return {
    ok: true,
    intencoes: linhas.slice(0, LIMITE_INTENCOES).map(daLinha).filter((x): x is LinhaIntencao => !!x),
    truncado: linhas.length > LIMITE_INTENCOES,
  };
}

export async function salvarIntencao(
  bruto: unknown,
  por: Autor,
  id?: string | null
): Promise<{ ok: true; id: string } | { ok: false; aviso: string; erros?: string[] }> {
  const v = validarIntencao(bruto);
  if (!v.ok) return { ok: false, aviso: "intencao invalida", erros: v.erros };
  const campos = {
    nome: v.intencao.nome,
    palavras_chave: v.intencao.palavras_chave,
    frases: v.intencao.frases,
    pontuacao_minima: v.intencao.pontuacao_minima,
    ativo: v.intencao.ativo,
    atualizada_em: new Date().toISOString(),
    atualizado_por_id: por.id,
    atualizado_por_nome: por.nome,
  };
  const db = msgDb();
  const r = id
    ? await db.from("intencoes").update(campos).eq("id", id).select("id").maybeSingle()
    : await db.from("intencoes").insert(campos).select("id").single();
  if (r.error) {
    // 23505 = o indice unico de NOME. Erro legivel em vez do texto do Postgres:
    // duas intencoes com o mesmo nome fariam a condicao de fluxo apontar pra duas
    // coisas diferentes com o mesmo rotulo na tela.
    if (String((r.error as any).code) === "23505") {
      return { ok: false, aviso: `ja existe uma intencao chamada "${v.intencao.nome}"` };
    }
    const f = falha(r.error);
    return { ok: false, aviso: f.aviso };
  }
  if (!r.data?.id) return { ok: false, aviso: "intencao nao encontrada" };
  return { ok: true, id: r.data.id };
}

export async function apagarIntencao(id: string): Promise<{ ok: true } | Falha> {
  const { error } = await msgDb().from("intencoes").delete().eq("id", id);
  if (error) return falha(error);
  return { ok: true };
}

/**
 * As intencoes reconhecidas num texto — o FATO que a condicao de fluxo consulta.
 *
 * Devolve `{ok:false, aviso}` quando nao deu pra LER o catalogo, e nao uma lista
 * vazia: lista vazia significa "nenhuma intencao bateu", e o avaliador e
 * fail-closed. Confundir as duas faria o macro parar com cara de "a condicao nao
 * bateu" quando ninguem conseguiu olhar (a mesma licao do coletor de contexto).
 *
 * Catalogo VAZIO, isso sim, e `{ok:true, nomes:[]}`: conta sem intencao funciona.
 */
export async function intencoesDoTexto(
  texto: string | null | undefined
): Promise<{ ok: true; nomes: string[] } | Falha> {
  const lista = await listarIntencoes({ somenteAtivas: true });
  if (!lista.ok) return lista;
  if (!lista.intencoes.length) return { ok: true, nomes: [] };
  // import preguicoso pra manter o topo deste arquivo com dependencia so de banco;
  // a lib e pura e nao precisa de nada do Next
  const { intencoesReconhecidas } = await import("@/lib/fluxo/intencoes");
  return { ok: true, nomes: intencoesReconhecidas(texto ?? "", lista.intencoes) };
}
