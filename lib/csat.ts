// Pesquisa de satisfacao (CSAT) — o lado da RESPOSTA.
//
// O ciclo tem duas metades em arquivos diferentes, e por isso ja nasceu torto uma
// vez: /api/conversa ENVIA a pergunta ao concluir a conversa e marca
// `aguardando_avaliacao = true`; o WEBHOOK e quem reconhece o "5" que o cliente
// responde, grava em `avaliacoes` e desmarca a espera. Fonte que so tem a
// primeira metade deixa a conversa marcada PRA SEMPRE — e como a pergunta so sai
// quando `aguardando_avaliacao` esta false, aquela conversa nunca mais recebe
// CSAT. Foi o que aconteceu com os canais Gupshup e Evolution.
//
// Este arquivo e a metade da resposta, uma vez so, pras tres fontes (zapi,
// gupshup, evolution). Sem import nenhum de proposito: as funcoes de decisao sao
// puras e provadas em Node puro (scripts/prova-webhook-formatos.ts); quem fala
// com o banco recebe o `db` pronto.

export type ConversaCsat =
  | {
      aguardando_avaliacao?: boolean | null;
      responsavel_id?: string | null;
      responsavel_nome?: string | null;
    }
  | null
  | undefined;

/** A nota, quando a mensagem inteira e um numero de 1 a 5. Senao, null. */
export function notaDaMensagem(texto: string | null | undefined): number | null {
  const t = String(texto ?? "");
  return /^\s*[1-5]\s*$/.test(t) ? Number(t.trim()) : null;
}

// So conta como nota a mensagem que o CLIENTE mandou (nunca o nosso eco), em
// conversa 1:1 (grupo nao recebe pesquisa), quando a conversa esta esperando a
// avaliacao e o texto e so o numero. Qualquer outra coisa e mensagem normal — e
// reabre o atendimento, como qualquer mensagem.
export function ehNotaCsat(args: {
  fromMe: boolean;
  isGroup: boolean;
  tipo: string;
  conteudo: string | null;
  conversa: ConversaCsat;
}): boolean {
  return (
    !args.fromMe &&
    !args.isGroup &&
    !!args.conversa?.aguardando_avaliacao &&
    args.tipo === "text" &&
    notaDaMensagem(args.conteudo) !== null
  );
}

export const MSG_AGRADECIMENTO = "Obrigado pela avaliação!";

// Grava a nota, encerra a espera e agradece. A conversa fica CONCLUIDA: a nota
// nao reabre atendimento (quem respondeu a pesquisa nao esta pedindo ajuda).
// O agradecimento e melhor-esforco — provedor fora do ar nao pode custar a nota
// que o cliente ja deu.
//
// DEVOLVE se a nota entrou de verdade. O supabase-js NAO lanca: ele devolve
// `{ error }`, e descartar esse error fazia a funcao parecer bem-sucedida com o
// insert recusado (tabela sem grant, constraint, banco fora do ar). Quem avisa
// sistema de fora precisa saber disso — anunciar avaliacao que nao existe no
// banco e pior que nao anunciar. A conversa fecha do mesmo jeito: a espera nao
// pode ficar pendurada pra sempre so porque a linha de avaliacao falhou.
export async function registrarAvaliacao(
  db: any,
  cfg: { auto_arquivar_concluida: boolean },
  T: { conversas: string; mensagens: string },
  p: {
    canal: string;
    chatId: string;
    nota: number;
    conversa: ConversaCsat;
    agradecer?: (texto: string) => Promise<unknown>;
  }
): Promise<boolean> {
  const { error: notaErr } = await db.from("avaliacoes").insert({
    canal: p.canal,
    chat_id: p.chatId,
    nota: p.nota,
    atendente_id: p.conversa?.responsavel_id || null,
    atendente_nome: p.conversa?.responsavel_nome || null,
  });
  await db
    .from(T.conversas)
    .update({
      aguardando_avaliacao: false,
      status: "concluido",
      // Conclusao AUTOMATICA (0006): id nulo + nome preenchido e a assinatura do
      // sistema. Sem isto, "sem autor" ficaria ambiguo entre automacao e linha
      // anterior a coluna existir — e a auditoria precisa saber que aqui nenhum
      // atendente encerrou nada.
      status_alterado_por_id: null,
      status_alterado_por_nome: "automacao: pesquisa de satisfacao",
      status_alterado_em: new Date().toISOString(),
      ...(cfg.auto_arquivar_concluida ? { arquivada: true } : {}),
    })
    .eq("chat_id", p.chatId);

  if (p.agradecer) {
    try {
      await p.agradecer(MSG_AGRADECIMENTO);
    } catch {
      // nota ja esta gravada; falha no agradecimento nao desfaz nada
    }
  }
  return !notaErr;
}
