// WEBHOOK DE SAIDA por EVENTO (integracao "configura uma vez e recebe sempre").
//
// Nao confundir com a acao `webhook` de dentro de um fluxo (motor de automacao,
// lib/fluxo/): la o cliente DESENHA quando chamar; aqui ele so assina o evento e
// o painel avisa toda vez que acontece, sem fluxo nenhum no meio.
//
// Onde mora a assinatura: `mensageria.config`, chave `webhooks_saida`, valor
// jsonb = lista de destinos. SEM DDL — a tabela config ja existe. Editavel na
// aba Automacao do admin (rota /api/admin/webhooks-saida) ou direto na linha de
// config; o formato esta em `docs/webhooks-saida.md`.
//
// TRES REGRAS DE SEGURANCA que valem pra sempre (isto e SAIDA DE DADOS, ainda
// que a URL venha de um admin):
//  1. so `https:` — sem http, sem esquema exotico, sem credencial embutida na URL;
//  2. NADA no destino, no cabecalho ou na URL e derivado de conteudo de conversa
//     — os cabecalhos sao constantes deste arquivo e o corpo e JSON puro;
//  3. sem seguir redirect (`redirect: "manual"`): destino que responde 302 nao
//     leva o corpo assinado pra outro host.
//
// E a regra de PRIVACIDADE: o texto da mensagem NAO sai por default. Quem quer
// conteudo liga `incluir_conteudo` no proprio destino, e assume isso.
//
// So `node:crypto` no topo (HMAC): as funcoes de decisao sao puras e provadas em
// Node puro por `scripts/prova-webhooks-saida.ts`. Quem fala com o banco usa
// import preguicoso, igual lib/modulos.ts.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
// Especificador COM extensao (`./x.ts`), como lib/janela-acesso.ts e
// lib/recusa.ts: `scripts/prova-webhooks-saida.ts` carrega este arquivo em node
// solto, e o node so resolve caminho relativo com extensao — o alias `@/` daria
// ERR_MODULE_NOT_FOUND e derrubaria uma prova que ja existia. (Custou uma
// quebra: a primeira versao deste import usava `@/lib/webhook-formato`.)
import { FORMATO_PADRAO, corpoDeSaida, validarFormato, type FormatoSaida } from "./webhook-formato.ts";

export const EVENTOS = [
  "mensagem_recebida",
  "status_alterado",
  "conversa_concluida",
  "avaliacao_registrada",
] as const;
export type Evento = (typeof EVENTOS)[number];

export const VERSAO_PAYLOAD = 1;

/** Um destino assinante. `segredo` vazio = entrega sem assinatura (nao recomendado). */
export type Assinante = {
  /** rotulo livre so pra tela do admin; nunca vai no payload */
  nome: string;
  url: string;
  eventos: Evento[];
  segredo: string;
  ativo: boolean;
  /** opt-in explicito pro texto da mensagem sair da instalacao */
  incluir_conteudo: boolean;
  /**
   * COMPATIBILIDADE DE FORMATO (card 86ak85apk). Default = o envelope de sempre,
   * entao TODO destino que ja existe em producao continua recebendo exatamente o
   * que recebia. Ver `lib/webhook-formato.ts` — inclusive o registro de que o
   * corpo da ferramenta antiga NAO esta documentado em lugar nenhum, e por isso
   * aqui existe mapa declarado e nao um "modo chatguru" chutado.
   */
  formato: FormatoSaida;
};

export type Payload = {
  versao: number;
  evento: Evento;
  /** id do DISPARO (nao da mensagem): serve pro destino deduplicar a retentativa */
  id: string;
  em: string;
  canal: string;
  chat_id: string;
  dados: Record<string, unknown>;
};

export type EventoBruto = {
  evento: Evento;
  canal: string;
  chat_id: string;
  dados?: Record<string, unknown>;
  /** texto da mensagem — so chega ao destino que pediu `incluir_conteudo` */
  conteudo?: string | null;
};

// cabecalhos: CONSTANTES. Nenhum valor daqui sai de conteudo de conversa.
export const CAB_EVENTO = "x-expert-chat-evento";
export const CAB_ENTREGA = "x-expert-chat-entrega";
export const CAB_ASSINATURA = "x-expert-chat-assinatura";

export const TIMEOUT_MS = 5000;
/** 1 retentativa: entrega e melhor-esforco, nao fila durvel (ver docs). */
export const TENTATIVAS = 2;
const MAX_CONTEUDO = 4096;
const MAX_DESTINOS = 20;

export function eventoConhecido(nome: unknown): nome is Evento {
  return typeof nome === "string" && (EVENTOS as readonly string[]).includes(nome);
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Endereco IPv4 literal em faixa privada, reservada ou de loopback. PURA.
 *
 * Defesa em profundidade: a URL vem de um super admin, entao isto nao e a
 * barreira principal — mas um destino apontando pra `169.254.169.254`
 * (metadados da nuvem) ou pra `127.0.0.1` transforma o painel em ferramenta de
 * varredura da rede interna de quem o hospeda. Nao ha caso de uso legitimo de
 * webhook `https` pra IP literal dessas faixas.
 */
export function ipReservado(host: string): boolean {
  const m = IPV4.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((n) => Number(n) > 255)) return true; // nem e IP valido
  if (a === 0 || a === 127) return true; // "este host" e loopback
  if (a === 10) return true; // privada
  if (a === 172 && b >= 16 && b <= 31) return true; // privada
  if (a === 192 && b === 168) return true; // privada
  if (a === 169 && b === 254) return true; // link-local (metadados de nuvem)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF/TEST-NET-1
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true; // benchmark/TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast e reservado (inclui 255.255.255.255)
  return false;
}

/**
 * URL de destino aceitavel. So https, so host de verdade, sem usuario/senha
 * embutidos (credencial na URL vaza em log de proxy) e sem IP literal de rede
 * interna.
 */
export function urlAceita(bruto: unknown): boolean {
  if (typeof bruto !== "string" || bruto.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(bruto.trim());
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  // IPv6 literal chega como "[...]": recusado inteiro. Nenhum webhook publico
  // legitimo e endereçado assim, e enumerar as faixas do IPv6 aqui seria pior
  // que fechar a porta.
  if (u.hostname.startsWith("[")) return false;
  if (ipReservado(u.hostname)) return false;
  return !!u.hostname && u.hostname.includes(".");
}

/**
 * Normaliza a lista vinda do banco/admin. PURA — e o que a prova exercita.
 * Destino invalido e DESCARTADO em silencio (lixo na config nunca vira entrega
 * pra lugar nenhum, e nunca derruba o painel). Evento desconhecido some da lista
 * do destino; destino que ficou sem evento nenhum nao entrega nada.
 */
export function validarAssinantes(bruto: unknown): Assinante[] {
  if (!Array.isArray(bruto)) return [];
  const out: Assinante[] = [];
  for (const item of bruto.slice(0, MAX_DESTINOS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    if (!urlAceita(o.url)) continue;
    const eventos = Array.isArray(o.eventos)
      ? Array.from(new Set(o.eventos.filter(eventoConhecido)))
      : [];
    out.push({
      nome: typeof o.nome === "string" ? o.nome.slice(0, 80) : "",
      url: String(o.url).trim(),
      eventos,
      segredo: typeof o.segredo === "string" ? o.segredo.slice(0, 200) : "",
      // ativo default TRUE (quem cadastrou quer receber); so `false` de verdade desliga
      ativo: o.ativo !== false,
      // conteudo default FALSE: privacidade nao se liga por acidente de tipo
      incluir_conteudo: o.incluir_conteudo === true,
      // formato torto cai no envelope de sempre (nunca derruba a entrega): o
      // destino continua recebendo o que sempre recebeu, que e o desfecho menos
      // surpreendente pra quem ja integrou
      formato: validarFormato(o.formato),
    });
  }
  return out;
}

/** Quem recebe este evento agora: ativo + inscrito. PURA. */
export function destinosDoEvento(assinantes: Assinante[], evento: Evento): Assinante[] {
  return assinantes.filter((a) => a.ativo && a.eventos.includes(evento));
}

/**
 * Monta o corpo. PURA — e aqui que mora a regra de privacidade: o texto da
 * mensagem so entra quando o destino pediu.
 */
export function montarPayload(
  ev: EventoBruto,
  incluirConteudo: boolean,
  meta: { id: string; em: string }
): Payload {
  const dados: Record<string, unknown> = { ...(ev.dados ?? {}) };
  // `conteudo` nunca entra por dados: quem manda e sempre o campo dedicado + a flag
  delete dados.conteudo;
  if (incluirConteudo && typeof ev.conteudo === "string") {
    dados.conteudo = ev.conteudo.slice(0, MAX_CONTEUDO);
  }
  return {
    versao: VERSAO_PAYLOAD,
    evento: ev.evento,
    id: meta.id,
    em: meta.em,
    canal: ev.canal,
    chat_id: ev.chat_id,
    dados,
  };
}

/** HMAC sha256 do CORPO CRU, em hex. O cabecalho vai como `sha256=<hex>`. */
export function assinar(segredo: string, corpo: string): string {
  return createHmac("sha256", segredo).update(corpo, "utf8").digest("hex");
}

/**
 * Conferencia da assinatura, em tempo constante — existe pra quem escrever o
 * RECEPTOR (e pra prova). Comparar com `===` vazaria o segredo por tempo.
 */
export function assinaturaConfere(segredo: string, corpo: string, cabecalho: string): boolean {
  const esperado = `sha256=${assinar(segredo, corpo)}`;
  const a = Buffer.from(esperado, "utf8");
  const b = Buffer.from(String(cabecalho ?? ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Cabecalhos da entrega. PURA — e o que prova que nada daqui vem da conversa.
 *
 * `contentType` vem de `corpoDeSaida` e nao de uma constante: destino que recebe
 * `application/json` com corpo de formulario e o MESMO silencio que a
 * compatibilidade existe pra evitar (o outro lado responde 200 e nao le nada).
 * Cabecalho e corpo saem sempre do mesmo calculo — ver `corpoParaDestino`.
 */
export function cabecalhos(
  a: Assinante,
  payload: Payload,
  corpo: string,
  contentType = "application/json"
): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": contentType,
    "user-agent": "expert-chat-webhook/1",
    [CAB_EVENTO]: payload.evento,
    [CAB_ENTREGA]: payload.id,
  };
  if (a.segredo) h[CAB_ASSINATURA] = `sha256=${assinar(a.segredo, corpo)}`;
  return h;
}

/**
 * Corpo + content-type de UM destino. PURA, e ponto unico de proposito.
 *
 * A assinatura HMAC continua sendo do corpo CRU que vai na rede (`cabecalhos`
 * recebe a mesma string): assinar o envelope e mandar outro formato faria toda
 * conferencia do lado do cliente falhar — silenciosamente, porque quem
 * implementa receptor quase sempre loga a falha e segue.
 */
export function corpoParaDestino(a: Assinante, payload: Payload): { corpo: string; contentType: string } {
  return corpoDeSaida(a.formato ?? FORMATO_PADRAO, payload);
}

// ─────────────────────────── leitura da configuracao ───────────────────────────

// cache curto, mesmo padrao do getConfig/getModulos: a rota de ingestao nao pode
// pagar um SELECT por mensagem.
let cache: { lista: Assinante[]; ts: number } | null = null;

export async function getAssinantes(): Promise<Assinante[]> {
  if (cache && Date.now() - cache.ts < 30_000) return cache.lista;
  let lista: Assinante[] = [];
  try {
    const { msgDb } = await import("@/lib/mensageria");
    const { data } = await msgDb().from("config").select("valor").eq("chave", "webhooks_saida").maybeSingle();
    lista = validarAssinantes(data?.valor);
  } catch {
    // banco fora do ar nao pode INVENTAR destino — lista vazia, ninguem recebe
    lista = [];
  }
  cache = { lista, ts: Date.now() };
  return lista;
}

export function derrubarCacheWebhooks() {
  cache = null;
}

// ──────────────────────────────── entrega ────────────────────────────────

/**
 * Uma entrega: POST assinado, timeout curto e UMA retentativa.
 * Exportada porque e a mecanica que a prova exercita com `fetch` de mentira —
 * sem isso, "nao segue redirect" e "nao repete 4xx" seriam so comentario.
 */
export async function entregar(a: Assinante, payload: Payload): Promise<void> {
  const { corpo, contentType } = corpoParaDestino(a, payload);
  const headers = cabecalhos(a, payload, corpo, contentType);
  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(a.url, {
        method: "POST",
        headers,
        body: corpo,
        // sem seguir redirect: 3xx nao leva o corpo assinado pra outro host
        redirect: "manual",
        cache: "no-store",
        signal: ctrl.signal,
      });
      // A RESPOSTA do destino nao interessa (isto e aviso, nao consulta), mas
      // corpo nao lido deixa o socket preso ate o GC no undici — em serverless
      // isso vira conexao vazando a cada mensagem recebida. Descartar
      // explicitamente, em TODO desfecho, inclusive antes da retentativa.
      await r.body?.cancel().catch(() => {});
      // 4xx e problema do destino (rota errada, assinatura recusada): repetir so
      // gasta. 5xx e timeout sao transitorios — dai a unica retentativa.
      if (r.status < 500) return;
    } catch {
      // rede/timeout: cai na retentativa (ou termina em silencio)
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Emite pra todos os destinos inscritos. NUNCA lanca.
 * Chame com `void dispararWebhooks(...)` DEPOIS do efeito principal: a entrega e
 * melhor-esforco e nao pode atrasar nem derrubar a rota (nem a ingestao de
 * mensagem, nem a conclusao de uma conversa).
 */
export async function emitirWebhooks(ev: EventoBruto): Promise<void> {
  const destinos = destinosDoEvento(await getAssinantes(), ev.evento);
  if (!destinos.length) return;
  const meta = { id: randomUUID(), em: new Date().toISOString() };
  await Promise.all(
    destinos.map((a) => entregar(a, montarPayload(ev, a.incluir_conteudo, meta)).catch(() => {}))
  );
}

/** Versao fire-and-forget: dispara e devolve na hora, engolindo qualquer falha. */
export function dispararWebhooks(ev: EventoBruto): void {
  void emitirWebhooks(ev).catch(() => {});
}

// ───────────────── avisos tipados (os pontos de emissao chamam estes) ─────────
//
// Por que nao montar o objeto na mao em cada rota: a ingestao tem TRES caminhos
// (zapi, gupshup, evolution) e a conclusao tem DOIS (painel e automacao da
// pesquisa). Payload montado a mao em cinco lugares diverge — e o cliente do
// outro lado quebra sem ninguem ver. Aqui o formato de cada evento existe uma
// vez so.

/** Mensagem do cliente entrou. `conteudo` so viaja pra quem pediu opt-in. */
export function avisarMensagemRecebida(p: {
  canal: string;
  chatId: string;
  tipo: string;
  deGrupo: boolean;
  temMidia: boolean;
  providerMsgId?: string | null;
  conteudo?: string | null;
}): void {
  dispararWebhooks({
    evento: "mensagem_recebida",
    canal: p.canal,
    chat_id: p.chatId,
    dados: {
      tipo: p.tipo,
      de_grupo: p.deGrupo,
      tem_midia: p.temMidia,
      provider_msg_id: p.providerMsgId ?? null,
      // tamanho em vez do texto: da pra medir sem expor o que foi dito
      tamanho: typeof p.conteudo === "string" ? p.conteudo.length : 0,
    },
    conteudo: p.conteudo ?? null,
  });
}

/** Cliente respondeu a pesquisa de satisfacao. */
export function avisarAvaliacao(p: {
  canal: string;
  chatId: string;
  nota: number;
  atendenteId?: string | null;
  atendenteNome?: string | null;
}): void {
  dispararWebhooks({
    evento: "avaliacao_registrada",
    canal: p.canal,
    chat_id: p.chatId,
    dados: {
      nota: p.nota,
      atendente_id: p.atendenteId ?? null,
      atendente_nome: p.atendenteNome ?? null,
    },
  });
}

/**
 * Quais eventos uma troca de status gera. PURA.
 * Concluir dispara os DOIS: quem so quer o encerramento assina
 * `conversa_concluida`; quem quer toda transicao assina `status_alterado`.
 */
export function eventosDeStatus(para: string): Evento[] {
  return para === "concluido" ? ["status_alterado", "conversa_concluida"] : ["status_alterado"];
}

/**
 * So avisa quando o status REALMENTE mudou. PURA.
 * Status reafirmado (gravar "concluido" numa conversa ja concluida) nao e
 * transicao: pra quem recebe, seria um encerramento que nao aconteceu.
 */
export function statusMudou(de: string | null | undefined, para: string): boolean {
  return (de ?? null) !== para;
}

/**
 * Status da conversa mudou. `origem`: quem mexeu — o painel ou uma automacao.
 *
 * `de` e OBRIGATORIO de proposito (aceita null pra conversa que nao existia):
 * a guarda de "mudou mesmo" mora AQUI, e nao em cada chamador, porque a versao
 * anterior deixava cada ponto de emissao lembrar dela — e os tres caminhos de
 * ingestao esqueceram. A resposta da pesquisa de satisfacao re-grava
 * "concluido" numa conversa JA concluida: sem esta guarda, o CRM do cliente
 * contava o encerramento duas vezes.
 */
export function avisarStatus(p: {
  canal: string;
  chatId: string;
  de: string | null;
  para: string;
  porId?: string | null;
  porNome?: string | null;
  origem: "painel" | "automacao";
}): void {
  if (!statusMudou(p.de, p.para)) return;
  const base = {
    canal: p.canal,
    chat_id: p.chatId,
    dados: {
      de: p.de ?? null,
      para: p.para,
      por_id: p.porId ?? null,
      por_nome: p.porNome ?? null,
      origem: p.origem,
    },
  };
  for (const evento of eventosDeStatus(p.para)) dispararWebhooks({ ...base, evento });
}
