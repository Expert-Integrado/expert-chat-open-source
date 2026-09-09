// Aplicacao no BANCO da decisao de conversa REINICIADA (Frente N, 31/08/2026).
//
// A DECISAO e pura e mora em lib/conversa-automatica.ts (provada em node solto).
// Aqui fica so o efeito colateral — e ele mora em UM lugar de proposito: a
// ingestao tem TRES portas (webhook Z-API, webhook Evolution, sync da API
// oficial) e regra copiada em tres portas diverge na primeira porta nova
// (licao paga pelo webhook de saida da Frente F e pelo `respondeu` do disparo).

import {
  decidirReinicio,
  type DecisaoReinicio,
  type RegrasConversa,
} from "@/lib/conversa-automatica";
import { atribuir, canalTemRodizio, escolherAtendente, type MotivoSemRodizio } from "@/lib/rodizio";

/** O que a ingestao ja leu da conversa ANTES de reescrever a linha. */
export type ConversaAntes = {
  status?: string | null;
  /** carimbo da ultima atividade, lido ANTES do upsert que o sobrescreve */
  last_message_at?: string | null;
} | null;

export type ResultadoReinicio = DecisaoReinicio & {
  /** quem passou a ser responsavel pela conversa, se houve redistribuicao */
  redelegadoPara?: string;
  /** por que o rodizio nao rodou (vira log, nunca erro) */
  semRodizio?: MotivoSemRodizio;
};

/**
 * Aplica o reinicio na conversa que acabou de receber mensagem do CLIENTE.
 *
 * Chamar SEMPRE depois do bloco de desarquivar/reabrir: a conversa concluida que
 * reabre por `auto_desarquivar_recebida` ja vira `aberto` la, e o reinicio nao
 * toca em `concluido` (ver `decidirReinicio`).
 *
 * IMPORTANTE — dois valores que o chamador TEM que passar certos:
 *
 *  - `antes.last_message_at` = o valor lido ANTES do upsert da mensagem nova.
 *    Depois do upsert o carimbo ja e "agora" e nenhuma conversa reiniciaria.
 *  - `agora` = o carimbo DA MENSAGEM, nao o relogio do servidor. Backlog
 *    processado tarde (mensagem de sabado materializada na segunda) mediria uma
 *    janela de 48h que nunca existiu pro cliente, e reiniciaria conversa que
 *    teve ida-e-volta em 2 minutos.
 *
 * Autoria da troca de status (convencao da migration 0006): automacao assina com
 * `status_alterado_por_id` NULL e nome preenchido — nunca como pessoa.
 *
 * Falha aqui NUNCA derruba a ingestao: o chamador engole (a mensagem do cliente
 * entrar vale mais que o status ficar certo) — mas o chamador LOGA, senao a
 * regra pode estar morta em producao sem ninguem saber.
 */
export async function aplicarReinicio(
  db: any,
  T: { conversas: string },
  cfg: RegrasConversa & { teto_por_atendente: number },
  ctx: { canal: string; chatId: string; antes: ConversaAntes; deGrupo?: boolean },
  agora: Date | number
): Promise<ResultadoReinicio> {
  const d = decidirReinicio(cfg, {
    statusAtual: ctx.antes?.status ?? null,
    ultimaAtividadeEm: ctx.antes?.last_message_at ?? null,
  }, agora);
  const saida: ResultadoReinicio = { ...d };
  if (!d.reiniciada) return saida;

  const iso = new Date(typeof agora === "number" ? agora : agora.getTime()).toISOString();

  if (d.status) {
    await db
      .from(T.conversas)
      .update({
        status: d.status,
        status_alterado_por_id: null,
        status_alterado_por_nome: "automacao: conversa reiniciada",
        status_alterado_em: iso,
        updated_at: iso,
      })
      .eq("chat_id", ctx.chatId)
      // guarda contra corrida: so grava se o status ainda e o que a decisao viu.
      // Duas mensagens do cliente no mesmo segundo nao podem gravar duas vezes.
      .eq("status", ctx.antes?.status ?? "");
  }

  if (!d.redistribuir) return saida;

  // (c) SEM RODIZIO POSSIVEL, o reinicio nao solta ninguem. Grupo nao tem
  // atendente de rodizio (o rodizio historico so roda em 1:1) e canal de fonte
  // sem rodizio nao tem pra quem redelegar — soltar ali seria orfanar a conversa
  // e chamar isso de "redistribuicao".
  if (ctx.deGrupo) {
    saida.semRodizio = "grupo";
    return saida;
  }
  if (!canalTemRodizio(ctx.canal)) {
    saida.semRodizio = "canal_sem_rodizio";
    return saida;
  }

  const { data: atuais } = await db
    .from("conversa_responsaveis")
    .select("ref_id,tipo")
    .eq("canal", ctx.canal)
    .eq("chat_id", ctx.chatId);
  const idsAtuais: string[] = (atuais ?? []).map((r: any) => r.ref_id);
  const usuariosAtuais: string[] = (atuais ?? [])
    .filter((r: any) => r.tipo === "usuario")
    .map((r: any) => r.ref_id);

  // Conversa que JA tem dono so troca de mao com `reinicio_remover_delegados`
  // ligado. Sem essa chave, redelegar significa "distribua o retorno do cliente
  // se ninguem estiver com ela" — nunca tirar a conversa de quem esta atendendo.
  if (idsAtuais.length && !d.removerDelegados) {
    saida.removerDelegados = false;
    saida.semRodizio = "ja_tem_dono";
    return saida;
  }

  // (b) ESCOLHER ANTES DE APAGAR. Sem substituto, nao se solta ninguem: freio
  // que falha aberto nao e freio, e "deleta e reza" deixaria a conversa orfa
  // exatamente quando nao ha atendente pra assumir.
  //
  // (Conversa IMPORTADA do ChatGuru chega aqui com `idsAtuais` vazio e
  // `responsavel_nome` preenchido — o atendente de la, que nao tem conta no
  // painel. Quem protege esse nome de ser sobrescrito e o espelho legado de
  // `atribuir`, em lib/rodizio.ts.)
  const r = await escolherAtendente(db, T, cfg, {
    canal: ctx.canal,
    // nao "trocar" o responsavel por ele mesmo: delete + insert + aviso pra nada
    excluir: usuariosAtuais,
  });
  if ("motivo" in r) {
    saida.removerDelegados = false;
    saida.semRodizio = r.motivo;
    return saida;
  }

  // remocao e reatribuicao JUNTAS, e o delete condicionado aos ids que acabamos
  // de ler (`.in("ref_id", ...)`): responsavel adicionado no meio por outra
  // porta nao e apagado por engano.
  await atribuir(db, T, {
    canal: ctx.canal,
    chatId: ctx.chatId,
    atendente: r.atendente,
    motivo: "reinicio",
    substituir: idsAtuais,
  });
  saida.removerDelegados = idsAtuais.length > 0;
  saida.redelegadoPara = r.atendente.nome;
  return saida;
}
