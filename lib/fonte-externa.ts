import type { CanalDef, FonteCanal } from "./canais";
import { fonteExterna } from "./canais";
import * as ig from "./instagram-agent";
import * as wa from "./whatsapp-agent";

// FONTE EXTERNA = o painel nao e dono das tabelas: conversas e mensagens vivem
// no banco de OUTRO sistema (Instagram Agent, WhatsApp Agent). Este e o UNICO
// lugar que sabe qual adaptador atende cada fonte. As rotas pedem
// `fonteLigada(def)` e recebem as funcoes ja amarradas a conta/instancia do
// canal — nenhuma rota importa lib/instagram-agent.ts ou lib/whatsapp-agent.ts
// direto (scripts/prova-whatsapp-agent.ts varre isso). Fonte nova = um `case`
// aqui e um adaptador; zero toque em rota.
//
// Os formatos abaixo sao os das colunas de mensageria.conversas/mensagens que
// as rotas ja consomem (mesmos nomes) — o adaptador traduz, a rota nao sabe de
// onde veio.

export type ConversaExterna = {
  chat_id: string;
  nome: string;
  is_group: boolean;
  foto_url: string | null;
  foto_wa_url: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  status: string;
  responsavel_id: null;
  responsavel_nome: null;
  responsavel_tipo: null;
  mensagens_nao_lidas: number;
  arquivada: boolean;
  auto_arquivar: boolean;
};

export type MensagemExterna = {
  id: string;
  direcao: string; // "in" | "out" (o adaptador do Instagram tipa como string)
  tipo: string;
  conteudo: string;
  sender_name: string | null;
  sender_phone: string | null;
  status: string | null;
  criada_em: string;
  media_url: string | null;
  media_mime: string | null;
  enviado_por_nome: string | null;
  provider_msg_id: string | null;
  quoted_msg_id: string | null;
  is_deleted: boolean;
  editada_em: string | null;
  reacao: string | null;
  encaminhada: boolean;
};

// o que o painel manda: texto (com assinatura) e, opcionalmente, UMA midia em data URI
export type PedidoEnvio = {
  texto: string;
  quoted: string | null;
  midia?: { tipo: "image" | "audio" | "ptt" | "video" | "document"; dataUri: string; fileName?: string | null };
  // primeiro contato: numero que ainda nao tem chat no agente (exige a instancia)
  allowNew?: boolean;
};

export type MensagemRef = { id: string; chat_id: string; provider_msg_id: string | null; direcao: string; is_deleted: boolean };

export type UltimaExterna = {
  chat_id: string;
  conteudo: string;
  direcao: string;
  enviado_por_nome: string | null;
  criada_em: string;
  is_deleted: boolean;
};

export type HitExterno = {
  id?: string;
  chat_id: string;
  conteudo: string | null;
  direcao: string;
  criada_em: string;
  provider_msg_id?: string | null;
  sender_name: string | null;
  enviado_por_nome: string | null;
};

export type RespostaEnvio =
  | { ok: true; messageId: string }
  | { ok: false; status: number; error: string; detalhe?: unknown };

export type FonteLigada = {
  fonte: FonteCanal;
  listarConversas(): Promise<ConversaExterna[]>;
  ultimasMensagens(): Promise<UltimaExterna[]>;
  conversasPorIds(ids: string[]): Promise<ConversaExterna[]>;
  // null = erro de leitura (a rota devolve 500); [] = conversa sem mensagem
  listarMensagens(chatId: string): Promise<MensagemExterna[] | null>;
  buscarMensagens(q: string): Promise<HitExterno[]>;
  // null = fonte somente leitura (Instagram). O gate de "pode enviar" continua
  // sendo `envioDisponivel` (lib/canais.ts); isto e a execucao.
  enviar: ((chatId: string, pedido: PedidoEnvio) => Promise<RespostaEnvio>) | null;
  // reagir a uma mensagem pelo id dela na fonte; null = fonte sem o gesto
  mensagemPorId: (id: string) => Promise<MensagemRef | null>;
  reagir: ((id: string, emoji: string) => Promise<{ ok: true } | { ok: false; status: number; error: string }>) | null;
};

// A instancia do agente que um canal mostra — pra quem precisa ler o banco do
// agente por outro caminho que nao o adaptador (relatorios). Passa por aqui pra
// nenhum lib importar lib/whatsapp-agent.ts direto (a prova varre).
export async function instanciaDoAgente(c: CanalDef): Promise<{ instance_id: string } | null> {
  if (c.fonte !== "whatsapp-agent" || !wa.waDisponivel()) return null;
  return wa.resolverInstanciaWa(c);
}

// A env da fonte existe nesta instalacao? (decide se o canal entra no seletor)
export function externaDisponivel(c: CanalDef): boolean {
  if (c.fonte === "instagram-agent") return ig.igDisponivel();
  if (c.fonte === "whatsapp-agent") return wa.waDisponivel();
  return false;
}

// O adaptador amarrado a conta/instancia do canal. null = env ausente, canal
// que nao e de fonte externa, ou conta nao conectada no agente — o chamador
// trata como "lista vazia", nunca 500.
export async function fonteLigada(c: CanalDef): Promise<FonteLigada | null> {
  if (!fonteExterna(c) || !externaDisponivel(c)) return null;
  if (c.fonte === "instagram-agent") {
    const conta = await ig.resolverContaIg(c);
    if (!conta) return null;
    return {
      fonte: c.fonte,
      listarConversas: () => ig.listarConversasIg(conta),
      ultimasMensagens: () => ig.ultimasMensagensIg(conta),
      conversasPorIds: (ids) => ig.conversasIgPorIds(conta, ids),
      listarMensagens: (chatId) => ig.listarMensagensIg(conta, chatId),
      buscarMensagens: (q) => ig.buscarMensagensIg(conta, q),
      enviar: null,
      mensagemPorId: async () => null,
      reagir: null,
    };
  }
  if (c.fonte === "whatsapp-agent") {
    const inst = await wa.resolverInstanciaWa(c);
    if (!inst) return null;
    return {
      fonte: c.fonte,
      listarConversas: () => wa.listarConversasWa(inst),
      ultimasMensagens: () => wa.ultimasMensagensWa(inst),
      conversasPorIds: (ids) => wa.conversasWaPorIds(inst, ids),
      listarMensagens: (chatId) => wa.listarMensagensWa(inst, chatId),
      buscarMensagens: (q) => wa.buscarMensagensWa(inst, q),
      enviar: wa.waEnvioDisponivel() ? (chatId, pedido) => wa.enviarWa(inst, c.id, chatId, pedido) : null,
      mensagemPorId: (id) => wa.mensagemWaPorId(inst, id),
      reagir: wa.waEnvioDisponivel() ? (id, emoji) => wa.reagirWa(inst, id, emoji) : null,
    };
  }
  return null;
}
