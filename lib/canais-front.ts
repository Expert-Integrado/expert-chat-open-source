// Lista UNICA multi-canal (Central de Atendimento, 28/08/2026) — funcoes PURAS
// que o front usa pra juntar, ordenar, filtrar e agrupar conversas de varios
// canais. Sem React, sem fetch, sem env: roda em Node puro (prova em
// scripts/prova-canais-front.ts).
//
// Por que existe: cada canal tem o proprio par de tabelas e o chat_id la e o
// telefone/perfil do CONTATO. O mesmo cliente que falou com 2 numeros da
// empresa aparece nos 2 canais com o MESMO chat_id — juntar tudo numa lista
// exige identidade composta (canal, chat_id), senao key/destaque/selecao/
// updates locais colidem. `uid` e essa identidade.
import type { CanalPublico } from "@/lib/canais";

export type ComCanal = { canal: string; uid: string };

export function chaveChat(canal: string, chatId: string): string {
  return `${canal}:${chatId}`;
}

// Quais canais o front deve buscar: os que o servidor ja informou (registro
// publico devolvido por /api/chats); antes da 1a resposta, so o central. No
// widget embutido fica SO o central: o token de embed permite por telefone e
// misturar canais la mudaria o recorte que o hospedeiro configurou.
export function canaisParaCarregar(conhecidos: Pick<CanalPublico, "id">[], embed: boolean): string[] {
  if (embed || !conhecidos.length) return ["central"];
  return conhecidos.map((c) => c.id);
}

// Junta as respostas por canal numa lista so: cada conversa ganha `canal` e
// `uid`; ordem = ultima mensagem mais recente primeiro (mesma regra que cada
// rota ja aplica dentro do canal, agora ENTRE canais). Conversa sem data vai
// pro fim.
export function juntarChats<T extends { chat_id: string; last_message_at: string | null }>(
  porCanal: { canal: string; chats: T[] }[]
): (T & ComCanal)[] {
  const tudo: (T & ComCanal)[] = [];
  for (const { canal, chats } of porCanal)
    for (const c of chats) tudo.push({ ...c, canal, uid: chaveChat(canal, c.chat_id) });
  tudo.sort((a, b) => (b.last_message_at || "").localeCompare(a.last_message_at || ""));
  return tudo;
}

// "" = todos os canais.
export function filtrarPorCanal<T extends { canal: string }>(chats: T[], filtro: string): T[] {
  return filtro ? chats.filter((c) => c.canal === filtro) : chats;
}

// Acao em massa recebe os uids selecionados e devolve 1 grupo por canal (a API
// e por canal: 1 request pra cada). uid que nao esta mais na lista e ignorado.
export function agruparPorCanal<T extends { chat_id: string } & ComCanal>(
  chats: T[],
  uids: string[]
): { canal: string; chat_ids: string[] }[] {
  const escolhidos = new Set(uids);
  const grupos = new Map<string, string[]>();
  for (const c of chats) {
    if (!escolhidos.has(c.uid)) continue;
    const l = grupos.get(c.canal) || [];
    l.push(c.chat_id);
    grupos.set(c.canal, l);
  }
  return Array.from(grupos.entries()).map(([canal, chat_ids]) => ({ canal, chat_ids }));
}

export function rotuloDoCanal(canais: Pick<CanalPublico, "id" | "rotulo">[], id: string): string {
  return canais.find((c) => c.id === id)?.rotulo || id;
}

// Seletor agrupado por DONO — o que a operacao quer ver separado: o que e canal
// da empresa e o que e canal pessoal do titular da conta.
export function gruposDoSeletor<T extends Pick<CanalPublico, "dono">>(canais: T[]): { empresa: T[]; pessoal: T[] } {
  return {
    empresa: canais.filter((c) => c.dono === "empresa"),
    pessoal: canais.filter((c) => c.dono === "pessoal"),
  };
}

// Acha a conversa pela identidade composta. Sem canal (deep-link antigo so com
// ?chat=, notificacao, clique em membro de grupo) prefere o canal `preferido`
// (normalmente o da conversa aberta); senao a 1a que bater.
export function acharChat<T extends { chat_id: string } & ComCanal>(
  chats: T[],
  chatId: string,
  canal?: string | null,
  preferido?: string | null
): T | undefined {
  if (canal) return chats.find((c) => c.canal === canal && c.chat_id === chatId);
  const candidatos = chats.filter((c) => c.chat_id === chatId);
  if (!candidatos.length) return undefined;
  return (preferido ? candidatos.find((c) => c.canal === preferido) : undefined) || candidatos[0];
}
