// Banco da FILA DE ATENDIMENTO (Frente S, card 86ak85nxx).
//
// A REGRA nao mora aqui: ela vive em `lib/fila-atendimento.ts`, que nao importa
// nada e roda em node solto (`node scripts/prova-fila-atendimento.ts`). Este
// arquivo e a FIACAO — le e grava, e traduz falha de banco em desfecho que o
// chamador consegue tratar sem inventar comportamento.
//
// DEGRADACAO EM DUAS CAMADAS, o padrao da casa (0015 em /api/fluxos, 0017 em
// /api/chats):
//
//   1. `migration_pendente` — a 0021 nao rodou nesta instalacao. Isso NAO e
//      falha: e "a fila nunca foi configurada aqui". Ninguem pode ter saido da
//      fila sem a tabela existir, entao o efeito correto e "todos dentro", com
//      aviso na rota. Detectado por `erroDeSchemaAusente` (lib/acesso.ts), que
//      ja carrega a lista de codigos do PostgREST e o cinto da mensagem.
//
//   2. `indisponivel` — erro de leitura DE VERDADE (rede, permissao, timeout).
//      Aqui o desfecho e o oposto: com o modulo LIGADO e a leitura falhando,
//      **nao se distribui**. Nao e rigor por rigor — e a licao que este repo
//      pagou duas vezes (teto diario do disparo, opt-out do iniciar conversa):
//      freio que falha aberto nao e freio. E o custo do fail-closed aqui e
//      BAIXO e visivel: a conversa fica sem responsavel, e conversa sem
//      responsavel e visivel pra instalacao inteira (lib/visibilidade.ts) e
//      aparece no painel operacional. Nada se perde; alguem pega na mao.
//      O contrario (distribuir no escuro) entregaria conversa pra quem tinha
//      dito que nao podia atender, em silencio — que e exatamente o que a
//      feature existe pra impedir.

import { msgDb } from "@/lib/mensageria";
import { erroDeSchemaAusente } from "@/lib/acesso";
import {
  aplicarAcao,
  normalizarEstado,
  type AcaoFila,
  type EstadoFila,
} from "@/lib/fila-atendimento";

const COLUNAS = "user_id,dentro,pular_vez,pular_desde,atualizado_em,atualizado_por_nome";

export const AVISO_SEM_MIGRATION =
  "fila de atendimento nao instalada nesta instalacao (a migration 0021 ja foi aplicada?) — enquanto isso, todo mundo conta como dentro da fila";

export type LeituraFila =
  | { ok: true; estados: Map<string, EstadoFila> }
  /** a 0021 nao rodou: trate como "ninguem tem estado" e mostre o aviso */
  | { ok: false; migration_pendente: true; aviso: string }
  /** erro de leitura real: com o modulo ligado, NAO distribua */
  | { ok: false; migration_pendente: false; aviso: string };

function falha(erro: any, o_que: string): LeituraFila {
  if (erroDeSchemaAusente(erro)) {
    return { ok: false, migration_pendente: true, aviso: AVISO_SEM_MIGRATION };
  }
  // a mensagem do Postgres NAO vai pro cliente (regra da casa): log aqui,
  // rotulo fixo pra fora.
  console.error(`fila-atendimento (${o_que}):`, erro?.code, erro?.message);
  return { ok: false, migration_pendente: false, aviso: "fila de atendimento indisponivel agora" };
}

function mapear(linhas: any[]): Map<string, EstadoFila> {
  const out = new Map<string, EstadoFila>();
  for (const l of linhas ?? []) {
    const e = normalizarEstado(l);
    if (e) out.set(e.user_id, e);
  }
  return out;
}

/** Estado de TODA a fila (poucas linhas: so quem tem estado gravado). */
export async function lerFila(): Promise<LeituraFila> {
  const { data, error } = await msgDb().from("atendente_fila").select(COLUNAS);
  if (error) return falha(error, "ler fila");
  return { ok: true, estados: mapear(data ?? []) };
}

/**
 * Estado de um recorte de pessoas. O rodizio usa esta: ele ja sabe o ranking, e
 * pedir a tabela inteira seria trazer linha de quem nem e candidato.
 */
export async function lerFilaDe(userIds: readonly string[]): Promise<LeituraFila> {
  if (!userIds.length) return { ok: true, estados: new Map() };
  const { data, error } = await msgDb().from("atendente_fila").select(COLUNAS).in("user_id", userIds);
  if (error) return falha(error, "ler fila de");
  return { ok: true, estados: mapear(data ?? []) };
}

export type GravacaoFila =
  | { ok: true; estado: EstadoFila }
  | { ok: false; migration_pendente: boolean; aviso: string };

/**
 * Aplica um gesto da PESSOA (entrar/sair/pular/voltar).
 *
 * Le o estado atual antes de aplicar porque a decisao e uma transicao, nao um
 * valor absoluto: "pular" so vale pra quem esta dentro, e "sair" limpa o pulo.
 * Mandar o valor final calculado no cliente deixaria a regra na tela — e a regra
 * mora em `lib/fila-atendimento.ts`.
 */
export async function aplicarGesto(
  user: { id: string; nome: string },
  acao: AcaoFila,
  agora = new Date()
): Promise<GravacaoFila> {
  const atual = await lerFilaDe([user.id]);
  if (!atual.ok) return { ok: false, migration_pendente: atual.migration_pendente, aviso: atual.aviso };
  const base = atual.estados.get(user.id) ?? {
    user_id: user.id,
    dentro: true,
    pular_vez: false,
    pular_desde: null,
  };
  const novo = aplicarAcao(base, acao, agora.toISOString());
  const { error } = await msgDb()
    .from("atendente_fila")
    .upsert(
      {
        user_id: novo.user_id,
        dentro: novo.dentro,
        pular_vez: novo.pular_vez,
        pular_desde: novo.pular_desde,
        atualizado_em: agora.toISOString(),
        atualizado_por_id: user.id,
        atualizado_por_nome: user.nome,
      },
      { onConflict: "user_id" }
    );
  if (error) {
    const f = falha(error, "gravar gesto");
    return { ok: false, migration_pendente: f.ok === false && f.migration_pendente, aviso: f.ok === false ? f.aviso : "" };
  }
  return { ok: true, estado: novo };
}

/**
 * Consome os pulos que a rodada gastou (a vez daquelas pessoas chegou e passou).
 *
 * MELHOR-ESFORCO de proposito, e com um detalhe que decide o comportamento: o
 * update leva `.eq("pular_vez", true)`. Sem essa guarda, um consumo que chegasse
 * atrasado apagaria um pulo NOVO que a pessoa marcou no meio — ela clicaria
 * "pular a vez" e receberia conversa mesmo assim, sem explicacao.
 *
 * A autoria segue a convencao da 0006 com `id` NULL: quem consumiu o pulo nao
 * foi uma pessoa, foi a distribuicao. Escrever o nome de um atendente ali faria
 * a trilha dizer que alguem mexeu na fila de outro.
 */
export async function consumirPulos(userIds: readonly string[], agora = new Date()): Promise<void> {
  if (!userIds.length) return;
  try {
    const { error } = await msgDb()
      .from("atendente_fila")
      .update({
        pular_vez: false,
        pular_desde: null,
        atualizado_em: agora.toISOString(),
        atualizado_por_id: null,
        atualizado_por_nome: "Distribuicao automatica",
      })
      .in("user_id", userIds)
      .eq("pular_vez", true);
    if (error && !erroDeSchemaAusente(error)) {
      console.error("fila-atendimento (consumir pulos):", error.code, error.message);
    }
  } catch (e: any) {
    console.error("fila-atendimento (consumir pulos):", e?.message ?? e);
  }
}
