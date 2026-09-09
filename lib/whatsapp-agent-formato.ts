// Traducao PURA entre o banco do WhatsApp Agent e o formato do painel — sem
// banco, sem env, sem import de rota: da pra provar em Node puro
// (`node scripts/prova-whatsapp-agent.ts`). Quem fala com o banco e com a
// mcp-api do agente e lib/whatsapp-agent.ts.
//
// O agente (https://github.com/Expert-Integrado/whatsapp-agent) guarda tudo em
// `public`: wa_instance (um numero por linha), chats, messages, message_media.
// As colunas batem MELHOR com o painel do que as do Instagram: chat_id,
// provider_msg_id, quoted_msg_id, sender_phone e is_group tem os mesmos nomes.
import type { ConversaExterna, HitExterno, MensagemExterna, RespostaEnvio, UltimaExterna } from "./fonte-externa";

// ── instancia (qual numero do agente este canal mostra) ─────────────────────

export type InstanciaWa = {
  instance_id: string;
  alias: string | null;
  is_default: boolean;
  is_active: boolean;
  phone_connected: string | null;
};

// A chave do canal: `conta` (alias ou instance_id) > `identidade` (o numero).
export function chaveDaInstancia(canal: { conta?: string; identidade: string }): string {
  return String(canal.conta || canal.identidade || "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
}

// Sem chave, vale a instancia DEFAULT do agente — e a mesma semantica das tools
// dele (chamada sem `instance` cai na default). Difere do Instagram de
// proposito: la a conta default e "a primeira conectada", aqui e uma escolha
// explicita do dono (migration 0062 do agente). Chave que nao casa = null, e
// nunca cai na default: canal mal cadastrado nao pode mostrar o numero errado.
export function escolherInstancia(lista: InstanciaWa[], chave: string): InstanciaWa | null {
  const ativas = lista.filter((i) => i.is_active);
  if (!chave) return ativas.find((i) => i.is_default) ?? (ativas.length === 1 ? ativas[0] : null);
  const digitos = chave.replace(/\D/g, "");
  return (
    ativas.find(
      (i) =>
        i.alias?.toLowerCase() === chave ||
        i.instance_id.toLowerCase() === chave ||
        (digitos.length >= 10 && (i.phone_connected ?? "").replace(/\D/g, "") === digitos)
    ) ?? null
  );
}

// Como o painel chama o numero nas mensagens enviadas de fora do painel.
export function rotuloDaInstancia(i: InstanciaWa): string {
  return i.alias || i.phone_connected || i.instance_id;
}

// ── tipos de mensagem ───────────────────────────────────────────────────────

// Rotulo do que chega sem texto (mesma ideia do adaptador do Instagram).
const ROTULO_TIPO: Record<string, string> = {
  image: "[foto]",
  video: "[video]",
  audio: "[audio]",
  ptt: "[audio]",
  document: "[documento]",
  sticker: "[figurinha]",
  location: "[localizacao]",
  contact: "[contato]",
  poll: "[enquete]",
  poll_vote: "[voto em enquete]",
  reaction: "[reacao]",
  call: "[chamada]",
  view_once: "[visualizacao unica]",
  buttons: "[botoes]",
  list: "[lista]",
  button_reply: "[resposta de botao]",
  list_reply: "[resposta de lista]",
  interactive: "[interativa]",
  template: "[template]",
  unknown: "[conteudo sem suporte]",
};

export function rotuloTipo(t: string | null | undefined): string {
  return ROTULO_TIPO[t || ""] ?? `[${t || "mensagem"}]`;
}

// tipo do painel: o front trata text/image/video/audio/document/sticker; o
// resto vira texto com rotulo. `ptt` (audio gravado) e audio pra tela.
export function tipoPainel(t: string | null | undefined): string {
  if (t === "ptt") return "audio";
  if (t === "image" || t === "video" || t === "audio" || t === "document" || t === "sticker" || t === "text") return t;
  return "text";
}

// O que a bolha mostra. Audio transcrito pelo agente vem em `content`; foto
// com legenda vem em `caption`; o resto cai no rotulo do tipo.
export function conteudoDe(m: { content?: string | null; caption?: string | null; message_type?: string | null; is_deleted?: boolean | null }): string {
  if (m.is_deleted) return "Mensagem apagada";
  return m.content || m.caption || rotuloTipo(m.message_type);
}

// A assinatura que o painel poe na frente do texto ("*Nome:* ...") e a unica
// pista de QUEM atendeu quando a mensagem saiu por aqui: a mcp-api grava
// `sent_by_agent_name` = AGENT_NAME pra todas. Le o nome de volta.
export const AGENT_NAME = "expert-chat";
export function nomeDaAssinatura(content: string | null | undefined): string | null {
  const m = /^\*([^*\n]{1,60}):\*\s/.exec(content || "");
  return m ? m[1] : null;
}

// quem enviou, pro `enviado_por_nome` (previa da lista e cabecalho da bolha)
export function enviadoPorNome(m: { from_me?: boolean | null; sent_by_agent_name?: string | null; content?: string | null }): string | null {
  if (!m.from_me) return null;
  if (m.sent_by_agent_name === AGENT_NAME) return nomeDaAssinatura(m.content) ?? "Expert Chat";
  return m.sent_by_agent_name || null; // null = digitada no aparelho do dono
}

// ── @lid: a mesma pessoa em dois chats ──────────────────────────────────────
//
// Ponto do Eric na revisao (09/09/2026): o WhatsApp multi-device entrega parte
// do trafego de UM contato num chat `<id>@lid` e parte no chat do telefone. O
// agente guarda os dois e casa-os por `lid_mapping` (lid -> phone, migration
// 0016). A tela precisa de UMA conversa por pessoa: o telefone e o id canonico
// (e pra ele que o envio vai; a mcp-api resolve o @lid sozinha), e as mensagens
// dos dois chats saem juntas, em ordem de tempo.
//
// ponytail: casa pelo `phone` EXATO do mapeamento. Variante do 9o digito (o
// mesmo numero salvo com e sem 9) e um colapso a mais que o agente faz em
// `pickPhoneChat`; entra aqui quando alguem medir que acontece no painel.

export type MapaLid = { paraPhone: Map<string, string>; paraLids: Map<string, string[]> };

export function mapaLid(rows: { lid: string; phone: string }[]): MapaLid {
  const paraPhone = new Map<string, string>();
  const paraLids = new Map<string, string[]>();
  for (const r of rows) {
    if (!r?.lid || !r?.phone) continue;
    paraPhone.set(r.lid, r.phone);
    paraLids.set(r.phone, [...(paraLids.get(r.phone) ?? []), r.lid]);
  }
  return { paraPhone, paraLids };
}

export const MAPA_VAZIO: MapaLid = { paraPhone: new Map(), paraLids: new Map() };

// o id que a tela usa: @lid mapeado vira o telefone; o resto passa igual
export function canonico(chatId: string, mapa: MapaLid): string {
  return mapa.paraPhone.get(chatId) ?? chatId;
}

// todos os chat_ids do agente que compoem UMA conversa da tela
export function idsDaConversa(chatId: string, mapa: MapaLid): string[] {
  const c = canonico(chatId, mapa);
  return [...new Set([c, ...(mapa.paraLids.get(c) ?? []), chatId])];
}

const NOME_LIXO = /^\d+(@lid)?$/;

// Funde os gemeos numa linha so. Vence a identidade do telefone (chat_id e
// nome); do @lid entram o que o telefone nao tem (nome, foto) e o que for mais
// recente (last_message_at); "nao lida" e OR. Ordem de entrada preservada.
export function fundirGemeos(conversas: ConversaExterna[], mapa: MapaLid): ConversaExterna[] {
  if (!mapa.paraPhone.size) return conversas;
  const porId = new Map<string, ConversaExterna>();
  const ordem: string[] = [];
  for (const c of conversas) {
    const id = canonico(c.chat_id, mapa);
    const ehLid = id !== c.chat_id;
    const atual = porId.get(id);
    if (!atual) {
      porId.set(id, ehLid ? { ...c, chat_id: id, nome: NOME_LIXO.test(c.nome) ? id : c.nome } : c);
      ordem.push(id);
      continue;
    }
    const maisNovo = (c.last_message_at || "") > (atual.last_message_at || "");
    porId.set(id, {
      ...atual,
      nome: NOME_LIXO.test(atual.nome) && !NOME_LIXO.test(c.nome) ? c.nome : atual.nome,
      foto_wa_url: atual.foto_wa_url || c.foto_wa_url,
      last_message_at: maisNovo ? c.last_message_at : atual.last_message_at,
      mensagens_nao_lidas: Math.max(atual.mensagens_nao_lidas, c.mensagens_nao_lidas),
    });
  }
  return ordem.map((id) => porId.get(id)!);
}

// ── conversas (formato de mensageria.conversas) ─────────────────────────────

export const SELECT_CHAT =
  "chat_id,chat_name,phone,is_group,profile_thumbnail,last_message_at,last_received_at,last_sent_at,waiting_on";

export function paraConversa(c: any): ConversaExterna {
  return {
    chat_id: c.chat_id,
    nome: c.chat_name || c.phone || c.chat_id,
    is_group: !!c.is_group,
    foto_url: null,
    // a miniatura que o agente guarda e a URL do provedor (https, publica, expira
    // sozinha) — a tela cai nas iniciais quando ela morre, como no canal principal
    foto_wa_url: c.profile_thumbnail || null,
    last_message_at: c.last_message_at,
    last_message_preview: null, // derivada da ultima mensagem real (rota /api/chats)
    // status "aberto" sempre, como no Instagram: o `resolved_at` do agente e do
    // DONO do numero (a triagem dele), nao do atendimento. Mapear pra "concluido"
    // e um passo depois, quando a linha de estado do painel existir.
    status: "aberto",
    responsavel_id: null,
    responsavel_nome: null,
    responsavel_tipo: null,
    // o agente nao conta nao lidas; `waiting_on = 'me'` (coluna gerada: a ultima
    // mensagem e do contato) e o sinal equivalente — mesmo criterio do Instagram
    mensagens_nao_lidas: c.waiting_on === "me" ? 1 : 0,
    arquivada: false,
    auto_arquivar: false,
  };
}

// ── mensagens (formato de mensageria.mensagens) ─────────────────────────────

export const SELECT_MENSAGEM =
  "id,provider_msg_id,chat_id,from_me,sender_phone,sender_name,message_type,content,caption,quoted_msg_id," +
  "is_forwarded,is_edited,is_deleted,message_ts,send_status,sent_by_agent_name," +
  "message_media(mime_type,storage_bucket,storage_path,download_status,original_url)";

export type MidiaWa = {
  mime_type: string | null;
  storage_bucket: string;
  storage_path: string;
  download_status: string;
  original_url: string | null;
};

export function midiaDe(m: any): MidiaWa | null {
  const md = m?.message_media;
  const uma = Array.isArray(md) ? md[0] : md;
  return uma && uma.storage_path ? (uma as MidiaWa) : null;
}

// URL que a tela consegue abrir: a assinada do Storage quando o agente ja
// baixou; senao a original do provedor (pode ter expirado — melhor que nada).
export function urlDaMidia(md: MidiaWa | null, assinada: string | null | undefined): string | null {
  if (!md) return null;
  if (md.download_status === "done" && assinada) return assinada;
  return md.original_url || null;
}

export function paraMensagem(
  m: any,
  ctx: { eu: string; contato: string; urlMidia: string | null }
): MensagemExterna {
  const md = midiaDe(m);
  return {
    id: m.id,
    direcao: m.from_me ? "out" : "in",
    tipo: tipoPainel(m.message_type),
    conteudo: conteudoDe(m),
    // em grupo, quem falou e o participante (nome do agente ou o telefone);
    // em 1:1 e o contato; o que saiu leva o nome de quem mandou
    sender_name: m.from_me
      ? m.sent_by_agent_name === AGENT_NAME
        ? nomeDaAssinatura(m.content) ?? ctx.eu
        : m.sent_by_agent_name || ctx.eu
      : m.sender_name || (m.sender_phone && m.sender_phone !== m.chat_id ? m.sender_phone : ctx.contato),
    sender_phone: m.from_me ? null : m.sender_phone ?? null,
    status: m.send_status ?? null,
    criada_em: m.message_ts,
    media_url: ctx.urlMidia,
    media_mime: md?.mime_type ?? null,
    enviado_por_nome: enviadoPorNome(m),
    provider_msg_id: m.provider_msg_id,
    quoted_msg_id: m.quoted_msg_id ?? null,
    is_deleted: !!m.is_deleted,
    // o agente guarda so a flag; a tela so precisa saber que houve edicao
    editada_em: m.is_edited ? m.message_ts : null,
    reacao: null,
    encaminhada: !!m.is_forwarded,
  };
}

export const SELECT_ULTIMA = "chat_id,content,caption,message_type,from_me,sent_by_agent_name,message_ts,is_deleted";

export function paraUltima(m: any): UltimaExterna {
  return {
    chat_id: m.chat_id,
    conteudo: conteudoDe(m),
    direcao: m.from_me ? "out" : "in",
    enviado_por_nome: enviadoPorNome(m),
    criada_em: m.message_ts,
    is_deleted: !!m.is_deleted,
  };
}

export const SELECT_HIT = "id,chat_id,content,from_me,message_ts,sent_by_agent_name,provider_msg_id";

export function paraHit(m: any): HitExterno {
  return {
    id: m.id,
    chat_id: m.chat_id,
    conteudo: m.content,
    direcao: m.from_me ? "out" : "in",
    criada_em: m.message_ts,
    provider_msg_id: m.provider_msg_id ?? null,
    sender_name: enviadoPorNome(m),
    enviado_por_nome: enviadoPorNome(m),
  };
}

// termo de busca: `%`/`_` sao curinga do ilike — escapa como o adaptador do IG
export function padraoBusca(q: string): string {
  return `%${q.replace(/[%_]/g, "\\$&")}%`;
}

// ── envio pela mcp-api do agente ────────────────────────────────────────────

// Destino no dialeto do agente: telefone, grupo (`@g.us` ou `-group`) ou @lid.
// Diferente do DESTINO_VALIDO de /api/send (que nao conhece `@g.us`/`@lid`):
// aqui quem resolve o destino e o `resolveChat` da mcp-api, e ele aceita os tres.
export const DESTINO_WA_AGENT = /^(\d{10,15}|\d{10,25}@g\.us|\d{10,25}-group|\d{10,25}@lid)$/;

// A chamada e o formato LEGADO { action, params } da mcp-api (o mesmo que o
// JSON-RPC tools/call executa por baixo). Cada campo tem motivo:
//   confirmed: true            — o gate de confirmacao e pra AGENTE; aqui um humano
//                                ja apertou "enviar"
//   force_send_after_inbound   — a trava "inbound recente sem resposta" existe pra
//                                agente nao atropelar o dono; atendente RESPONDENDO
//                                e exatamente esse caso
//   humanize: false            — o delay de digitacao e teatro pra agente; o
//                                atendente ja digitou de verdade (e a rota tem 60s)
//   agent_name                 — carimbo fixo; quem atendeu vai na assinatura do
//                                texto (ver nomeDaAssinatura)
//   instance                   — o numero do canal, nunca "o default"
// O voice gate do agente NAO e desligado: se a instancia esta em modo block e o
// texto viola regra hard, a resposta vem `blocked` e a rota devolve 403 com as
// violacoes — e a trava do dono valendo tambem pro painel, de proposito.
export function corpoEnvio(p: { chat_id: string; texto: string; instance_id: string; quoted?: string | null }) {
  return {
    action: "send",
    params: {
      to: p.chat_id,
      content: p.texto,
      type: "text",
      confirmed: true,
      force_send_after_inbound: true,
      humanize: false,
      agent_name: AGENT_NAME,
      instance: p.instance_id,
      ...(p.quoted ? { reply_to: p.quoted } : {}),
    },
  };
}

// O que a mcp-api devolve, traduzido pro status HTTP da rota. Fail-closed: so
// `ok:true` COM id de mensagem vira sucesso; qualquer outra forma e erro
// declarado (nunca "ok" com a mensagem parada no agente).
export function lerRespostaEnvio(status: number, data: any): RespostaEnvio {
  if (status === 401 || status === 403) {
    return { ok: false, status: 502, error: "a mcp-api do agente recusou a credencial (WA_MCP_KEY)" };
  }
  if (data?.blocked && data?.reason === "voice_gate") {
    return {
      ok: false,
      status: 403,
      error: "texto recusado pelo voice guide do agente — ajuste e envie de novo",
      detalhe: data.violations ?? null,
    };
  }
  if (data?.blocked) {
    return { ok: false, status: 409, error: `envio bloqueado pelo agente (${data.reason || "confirmacao pendente"})` };
  }
  if (data?.ambiguous) {
    return { ok: false, status: 409, error: "o agente achou 2+ conversas pra este destino — abra a conversa pelo agente" };
  }
  const id = data?.provider_msg_id || data?.message_id;
  if (status < 400 && data?.ok === true && id) return { ok: true, messageId: String(id) };
  return { ok: false, status: 502, error: String(data?.error || `mcp-api respondeu ${status}`) };
}
