import { msgDb } from "@/lib/mensageria";
import { chaveDeContexto, normalizarContexto, LIMITE_VALOR_CONTEXTO } from "@/lib/fluxo/schema";

// Contexto da conversa — camada de BANCO (card 86ak859vt).
//
// A memoria do robo: pares chave/valor por (canal, chat_id), que as condicoes
// de fluxo consultam e as acoes `definir_contexto`/`limpar_contexto` gravam.
//
// DEGRADACAO SEM 500 (mesmo padrao de lib/funis-db.ts): a migration 0016 e
// gesto humano no SQL Editor. Enquanto ela nao rodar, `mensageria.conversa_contexto`
// nao existe — leitura devolve `{ok:false, aviso}` e escrita devolve erro
// legivel. Quem chama decide o que fazer; ninguem derruba a tela de atendimento.
//
// AUTORIZACAO NAO MORA AQUI. Quem chama (rota, motor) ja resolveu usuario e
// escopo. Duplicar a checagem criaria um segundo lugar pra ela divergir.

export const AVISO_SEM_TABELA =
  "contexto da conversa indisponivel nesta instalacao (a migration 0016_conversa_contexto.sql ja foi aplicada?)";

export type Falha = { ok: false; aviso: string };
export type Autor = { id: string | null; nome: string };

// O aviso vai PRO PASSO DA TRILHA e pra resposta da rota — ou seja, e o que
// alguem le pra descobrir por que o macro parou. Acusar "migration nao rodada"
// em qualquer erro manda a pessoa pro lugar errado quando o problema e grant,
// rede ou coluna: cada causa ganha o seu texto.
//   42P01 tabela nao existe | 42883/PGRST202 funcao nao existe (falta o
//   `notify pgrst` ou a migration) | 42703 coluna nao existe (migration antiga)
//   42501 permissao (a tabela existe e o grant nao veio)
const falha = (e: any): Falha => {
  const codigo = String(e?.code ?? "");
  const msg = String(e?.message ?? "");
  if (msg) console.error("contexto:", codigo ? `${codigo} ${msg}` : msg);
  if (codigo === "42P01" || codigo === "42883" || codigo === "PGRST202" || codigo === "42703") {
    return { ok: false, aviso: AVISO_SEM_TABELA };
  }
  if (codigo === "42501") {
    return {
      ok: false,
      aviso: "sem permissao no contexto da conversa (a tabela existe; falta o grant do service_role da 0016)",
    };
  }
  return {
    ok: false,
    aviso: `nao deu pra falar com o contexto da conversa${codigo ? ` (${codigo})` : ""}: ${msg || "erro sem mensagem"}`,
  };
};

// ---------------------------------------------------------------- leitura
export async function lerContexto(
  canal: string,
  chatId: string
): Promise<{ ok: true; dados: Record<string, string> } | Falha> {
  const { data, error } = await msgDb()
    .from("conversa_contexto")
    .select("dados")
    .eq("canal", canal)
    .eq("chat_id", chatId)
    .maybeSingle();
  if (error) return falha(error);
  // conversa SEM linha nao e erro: e conversa sem memoria ainda
  return { ok: true, dados: normalizarContexto(data?.dados) };
}

// ---------------------------------------------------------------- escrita
// As duas escritas passam pelas FUNCOES do banco (0016), que fazem a alteracao
// atomica dentro do jsonb. Read-modify-write no cliente perderia variavel em
// silencio quando duas mensagens da mesma conversa chegassem juntas — que e o
// caso normal de menu de atendimento, nao o caso raro.
export async function definirContexto(
  canal: string,
  chatId: string,
  chave: string,
  valor: string,
  por: Autor
): Promise<{ ok: true; dados: Record<string, string> } | Falha> {
  const k = chaveDeContexto(chave);
  if (!k) return { ok: false, aviso: "chave de contexto invalida" };
  if (typeof valor !== "string" || valor.length > LIMITE_VALOR_CONTEXTO) {
    return { ok: false, aviso: `valor de contexto acima de ${LIMITE_VALOR_CONTEXTO} caracteres` };
  }
  const { data, error } = await msgDb().rpc("definir_contexto", {
    p_canal: canal,
    p_chat_id: chatId,
    p_chave: k,
    p_valor: valor,
    p_por_id: por.id,
    p_por_nome: por.nome,
  });
  if (error) return falha(error);
  return { ok: true, dados: normalizarContexto(data) };
}

export async function limparContexto(
  canal: string,
  chatId: string,
  chave: string,
  por: Autor
): Promise<{ ok: true; dados: Record<string, string> } | Falha> {
  const k = chaveDeContexto(chave);
  if (!k) return { ok: false, aviso: "chave de contexto invalida" };
  const { data, error } = await msgDb().rpc("limpar_contexto", {
    p_canal: canal,
    p_chat_id: chatId,
    p_chave: k,
    p_por_id: por.id,
    p_por_nome: por.nome,
  });
  if (error) return falha(error);
  // conversa que nunca teve contexto: a funcao nao atualiza linha nenhuma e
  // devolve vazio. Limpar o que nao existe e sucesso, nao erro.
  return { ok: true, dados: normalizarContexto(data) };
}
