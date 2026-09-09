// Envio de UM destino da campanha — a MESMA mecanica canal-aware do painel.
//
// Nada aqui reimplementa provedor: reusa credsZapi/zapiSendText,
// credsGupshup/gsSendText/janela24h e credsEvolution/evoSendText, exatamente
// como /api/send e /api/cron-agendadas fazem. A mensagem sai pelo NUMERO DO
// CANAL da campanha — canal desconhecido, inativo ou sem credencial vira falha
// do destino, NUNCA cai no numero de outro canal (P1, 30/08/2026).
//
// DIFERENCA DELIBERADA em relacao a /api/send: aquela rota so envia pra conversa
// que JA EXISTE (barreira anti-disparo-frio, seguranca 13/08). Aqui o disparo e
// justamente pra lista, entao a conversa e CRIADA quando nao existe. E por isso
// que a porta do disparo e outra (modulo proprio + permissao propria + aprovacao
// por campanha): a barreira que /api/send tem, este caminho troca por aprovacao
// humana explicita.

import { msgDb } from "@/lib/mensageria";
import { canalPorId, envioDisponivel, type CanalDef } from "@/lib/canais";
import { credsZapi, zapiSendText } from "@/lib/zapi";
import { credsGupshup, gsSendText, janela24h } from "@/lib/gupshup";
import { credsEvolution, evoSendText } from "@/lib/evolution";

export type ResultadoEnvio =
  | { ok: true; provider_msg_id: string | null }
  | { ok: false; erro: string; configuracao?: boolean };

/**
 * A campanha PODE sair por este canal?
 *
 * Distingue os dois "nao" que o card 86ak85jek pede separados (decisao 4):
 * falta de CREDENCIAL (so quem administra resolve) e canal somente-leitura.
 * Chamado na hora de tirar a campanha do rascunho — recusar depois, no meio do
 * envio, seria descobrir tarde.
 */
export function motivoCanalNaoEnvia(canalId: string): string | null {
  const def = canalPorId(canalId);
  if (!def) return `canal "${canalId}" nao existe nesta instalacao`;
  if (!def.ativo) return `o canal "${def.rotulo}" esta inativo nesta instalacao`;
  if (!envioDisponivel(canalId)) {
    return `o canal "${def.rotulo}" nao tem credencial de envio configurada — isso e configuracao da instalacao, nao espera`;
  }
  return null;
}

/**
 * Versao ASSINCRONA do guarda — a que o motor usa antes de comecar o lote.
 *
 * Por que existe: `envioDisponivel` tem um fallback historico para o canal
 * `apioficial` (a credencial Gupshup dele pode vir do banco, em
 * `public.connectors`, e a checagem sincrona nao alcanca isso — por isso ela
 * responde `true` sem conferir). Resultado: um canal oficial SEM conector
 * passava pelo guarda sincrono e a campanha ia queimar a fila inteira em N
 * falhas identicas de credencial, em vez de pausar UMA vez por impedimento.
 *
 * Aqui o conector e realmente consultado antes do lote.
 */
export async function motivoCanalNaoEnviaAsync(canalId: string): Promise<string | null> {
  const sincrono = motivoCanalNaoEnvia(canalId);
  if (sincrono) return sincrono;
  const def = canalPorId(canalId)!;
  if (def.fonte === "gupshup") {
    try {
      const creds = await credsGupshup(def.id);
      if (!creds) {
        return `o canal "${def.rotulo}" nao tem conector Gupshup configurado — isso e configuracao da instalacao, nao espera`;
      }
    } catch (e: any) {
      return `nao deu pra conferir as credenciais do canal "${def.rotulo}": ${String(e?.message || e).slice(0, 120)}`;
    }
  }
  return null;
}

/**
 * Envia o texto ja renderizado (variaveis aplicadas) pra UM destino.
 * Nunca lanca: falha vira `{ok:false, erro}` legivel pro relatorio.
 */
export async function enviarDestino(
  canalId: string,
  chatId: string,
  texto: string
): Promise<ResultadoEnvio> {
  const impedimento = motivoCanalNaoEnvia(canalId);
  if (impedimento) return { ok: false, erro: impedimento, configuracao: true };
  const def = canalPorId(canalId)!;

  try {
    if (def.fonte === "gupshup") {
      // API oficial da Meta: fora da janela de 24h so template aprovado passa, e
      // template nao e desta v1. O destino falha com motivo LEGIVEL — quem opera
      // precisa entender que nao e erro do painel, e regra da Meta.
      const j = await janela24h(chatId, def.tabelas.mensagens);
      if (!j.aberta) {
        return {
          ok: false,
          erro: "janela de 24h fechada: no numero da API oficial so da pra escrever quem falou com voce nas ultimas 24h",
        };
      }
      const creds = await credsGupshup(def.id);
      if (!creds) return { ok: false, erro: "credenciais Gupshup do canal ausentes", configuracao: true };
      const r = await gsSendText(creds, chatId, texto);
      return { ok: true, provider_msg_id: r.messageId || null };
    }
    if (def.fonte === "zapi") {
      const creds = credsZapi(def.id);
      if (!creds) return { ok: false, erro: "credenciais Z-API do canal ausentes", configuracao: true };
      const r = await zapiSendText(creds, chatId, texto, null);
      return { ok: true, provider_msg_id: r.messageId || null };
    }
    if (def.fonte === "evolution") {
      const creds = credsEvolution(def.id);
      if (!creds) return { ok: false, erro: "credenciais Evolution do canal ausentes", configuracao: true };
      const r = await evoSendText(creds, chatId, texto, null);
      return { ok: true, provider_msg_id: r.messageId || null };
    }
    return { ok: false, erro: "canal de fonte externa e somente leitura: nao envia", configuracao: true };
  } catch (e: any) {
    return { ok: false, erro: String(e?.message || e).slice(0, 300) };
  }
}

/**
 * Grava a saida nas tabelas do canal: cria a conversa se ela nao existir e
 * insere a mensagem com autoria da CAMPANHA.
 *
 * Autoria segue a convencao da 0006 (CLAUDE.md): `enviado_por_id` NULL com
 * `enviado_por_nome` preenchido = automacao, nao pessoa. Assim a bolha na
 * conversa diz de onde veio, e o relatorio de atendimento nao credita o envio a
 * nenhum atendente.
 */
export async function gravarSaida(opcoes: {
  canal: CanalDef;
  chatId: string;
  nome?: string | null;
  texto: string;
  providerMsgId: string | null;
  campanhaNome: string;
}): Promise<void> {
  const db = msgDb();
  const T = opcoes.canal.tabelas;
  const now = new Date().toISOString();
  const assinatura = `campanha: ${opcoes.campanhaNome}`.slice(0, 120);

  const { data: existente } = await db
    .from(T.conversas)
    .select("chat_id")
    .eq("chat_id", opcoes.chatId)
    .maybeSingle();

  if (!existente) {
    // conversa nova: nome so quando o publico trouxe um (mandar vazio criaria
    // conversa "sem nome" onde o webhook depois poria o pushname real)
    await db.from(T.conversas).upsert(
      {
        chat_id: opcoes.chatId,
        ...(opcoes.nome ? { nome: opcoes.nome } : {}),
        is_group: opcoes.chatId.endsWith("-group"),
        canal: `campanha-${opcoes.canal.id}`,
        last_message_at: now,
        last_message_preview: `${assinatura}: ${opcoes.texto}`.slice(0, 140),
        updated_at: now,
      },
      { onConflict: "chat_id" }
    );
  } else {
    // conversa viva: NAO mexe em nome, status, arquivo nem responsavel — a
    // campanha nao pode rebobinar atendimento em curso. So a previa e a data.
    await db
      .from(T.conversas)
      .update({
        last_message_at: now,
        last_message_preview: `${assinatura}: ${opcoes.texto}`.slice(0, 140),
        updated_at: now,
      })
      .eq("chat_id", opcoes.chatId);
  }

  await db.from(T.mensagens).insert({
    chat_id: opcoes.chatId,
    direcao: "out",
    tipo: "text",
    conteudo: opcoes.texto,
    provider_msg_id: opcoes.providerMsgId,
    status: "sent",
    criada_em: now,
    // convencao 0006: id NULL + nome preenchido = automacao
    enviado_por_id: null,
    enviado_por_nome: assinatura,
  });
}
