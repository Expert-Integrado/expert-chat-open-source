import { corpoReacaoZapi } from "@/lib/reacoes";
import { canalPorId } from "@/lib/canais";
import { qrValido } from "@/lib/canal-conexao";

const BASE = "https://api.z-api.io";

export type ZapiCreds = { instance: string; token: string; clientToken: string };

// Instancia Z-API do numero central (envs CENTRAL_ZAPI_*)
export function credsCentral(): ZapiCreds | null {
  const instance = process.env.CENTRAL_ZAPI_INSTANCE_ID;
  const token = process.env.CENTRAL_ZAPI_TOKEN;
  if (!instance || !token) return null;
  return { instance, token, clientToken: process.env.CENTRAL_ZAPI_CLIENT_TOKEN || "" };
}

// Credenciais Z-API POR CANAL. O "central" segue nas envs historicas
// CENTRAL_ZAPI_*; qualquer OUTRO canal de fonte zapi (2a instancia declarada
// em CANAIS_EXTRA, ex. o numero testador) le
//   ZAPI_<ID_MAIUSCULO>_INSTANCE_ID / ZAPI_<ID>_TOKEN / ZAPI_<ID>_CLIENT_TOKEN
// Sem instancia+token = null (o chamador trata como "canal nao cabeado").
// Nenhum id/numero da empresa aqui — regra BASE do repo.
export function credsZapi(canal: string): ZapiCreds | null {
  if (canal === "central") return credsCentral();
  const def = canalPorId(canal);
  if (!def || def.fonte !== "zapi") return null;
  const p = `ZAPI_${canal.toUpperCase()}_`;
  const instance = process.env[p + "INSTANCE_ID"];
  const token = process.env[p + "TOKEN"];
  if (!instance || !token) return null;
  return { instance, token, clientToken: process.env[p + "CLIENT_TOKEN"] || "" };
}

function urlDe(creds: ZapiCreds, path: string) {
  return `${BASE}/instances/${creds.instance}/token/${creds.token}/${path}`;
}
function headers(creds: ZapiCreds) {
  return {
    "Content-Type": "application/json",
    ...(creds.clientToken ? { "Client-Token": creds.clientToken } : {}),
  };
}

type SendResult = { zaapId?: string; messageId?: string; id?: string };

async function post(creds: ZapiCreds, path: string, body: unknown): Promise<SendResult> {
  const res = await fetch(urlDe(creds, path), {
    method: "POST",
    headers: headers(creds),
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j as any)?.error) {
    throw new Error(`Z-API ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j as SendResult;
}

// quoted = messageId da mensagem sendo respondida (reply/quote)
export function zapiSendText(creds: ZapiCreds, phone: string, message: string, quoted?: string | null) {
  return post(creds, "send-text", { phone, message, ...(quoted ? { messageId: quoted } : {}) });
}

// Envio de midia. `data` = data URI base64 (o painel manda o arquivo inline) ou URL publica.
export function zapiSendMedia(
  creds: ZapiCreds,
  tipo: "image" | "audio" | "ptt" | "video" | "document",
  phone: string,
  data: string,
  opts: { caption?: string; fileName?: string; quoted?: string | null } = {}
) {
  const quotedField = opts.quoted ? { messageId: opts.quoted } : {};
  switch (tipo) {
    case "image":
      return post(creds, "send-image", { phone, image: data, caption: opts.caption || "", ...quotedField });
    case "audio":
      return post(creds, "send-audio", { phone, audio: data, ...quotedField });
    case "ptt":
      return post(creds, "send-audio", { phone, audio: data, waveform: true, ...quotedField });
    case "video":
      return post(creds, "send-video", { phone, video: data, caption: opts.caption || "", ...quotedField });
    case "document": {
      const nome = opts.fileName || "arquivo.pdf";
      const ext = (nome.split(".").pop() || "pdf").toLowerCase().replace(/[^a-z0-9]/g, "") || "pdf";
      const base = nome.toLowerCase().endsWith(`.${ext}`) ? nome.slice(0, -(ext.length + 1)) : nome;
      return post(creds, `send-document/${ext}`, { phone, document: data, fileName: base, ...quotedField });
    }
  }
}

// FRENTE S (31/08/2026), card 86ak86jvw — LISTA DE OPCOES.
//
// SO LISTA passa por aqui, e a ausencia de `send-button-list` e DELIBERADA: a
// propria doc da Z-API ("Funcionamento dos Botoes") declara que "as mensagens
// contendo botoes estao sofrendo uma instabilidade em seu funcionamento" e que o
// resultado depende do tipo de conta e do destino. Mandar por um caminho que o
// fornecedor chama de instavel produz o pior desfecho: a mensagem SAI, o cliente
// nao ve botao, e o atendente espera resposta que nunca vem. Botao neste canal
// cai no fallback de texto numerado (lib/interativas.ts, `planoDeEnvio`).
//
// A lista, sim, e documentada — e NAO funciona em GRUPO, o que tambem sai da doc
// deles e esta tratado no `planoDeEnvio`, nao aqui.
//
// O ENVELOPE mora em lib/interativas.ts (puro, provavel em node solto); esta
// funcao so faz o POST.
export function zapiSendOptionList(creds: ZapiCreds, phone: string, envelope: Record<string, unknown>) {
  // SEM `messageId` (responder-citando) DE PROPOSITO — achado da revisao cega.
  //
  // A doc do `send-option-list` documenta SO `{phone, message, optionList}`. O
  // `messageId` funciona no `send-text`, e a versao anterior desta funcao o
  // repassava aqui por simetria: campo NAO DOCUMENTADO num endpoint que a propria
  // Z-API trata a parte. O risco nao e o quote nao aparecer — e a API recusar a
  // mensagem INTEIRA por causa de um campo extra, e a pergunta nunca chegar ao
  // cliente. Enviar sem citacao e perda conhecida e pequena; enviar e nao chegar
  // e o defeito que o card manda evitar.
  //
  // Pra ligar quote aqui: confirmar na doc oficial que este endpoint aceita
  // `messageId`, e so entao voltar o parametro (a chamada em /api/send passa a
  // ter o `quoted` disponivel).
  return post(creds, "send-option-list", { phone, ...envelope });
}

// Editar mensagem enviada. NAO existe /edit-message nesta conta (devolve
// NOT_FOUND): a edicao e o proprio send-text com `editMessageId` apontando pra
// mensagem original — confirmado ao vivo em producao.
export async function zapiEdit(creds: ZapiCreds, phone: string, messageId: string, message: string) {
  return post(creds, "send-text", { phone, message, editMessageId: messageId });
}

// Encaminhar mensagem: phone = destino, messageId = mensagem original,
// messagePhone = chat onde ela vive. Mesmo contrato que o whatsapp-agent usa;
// o path canonico mudou de forward-message pra forward, entao tenta os dois.
export async function zapiForward(creds: ZapiCreds, phone: string, messageId: string, messagePhone: string) {
  const body = { phone, messageId, messagePhone };
  try {
    return await post(creds, "forward-message", body);
  } catch (e: any) {
    if (!/NOT_FOUND|404/.test(String(e?.message))) throw e;
    return await post(creds, "forward", body);
  }
}

// ——————————————————————————————————— CONEXAO DO NUMERO (card 86ak858mx)
//
// Endpoints NATIVOS da Z-API pra conectar/desconectar um numero. Portados do
// Super Grupos (`supabase/functions/zapi-qr-scanner/index.ts`), que roda isso em
// producao — as 5 acoes de la sao exatamente estas.
//
// FRONTEIRA DE SEGURANCA, e ela e a razao de tudo isto morar no SERVIDOR: a
// credencial (instancia + token + Client-Token) nunca chega ao navegador. O
// navegador pede "o QR do canal X"; quem sabe qual credencial e a do canal X e
// `credsZapi`, no servidor, depois de a rota conferir que quem pediu pode mexer
// naquele canal. O que volta pra tela e imagem e estado — nunca credencial.
//
// Estas chamadas NAO usam o `post` acima de proposito: aquele estoura em
// resposta de erro, e aqui o CORPO do erro e informacao que a tela precisa (a
// Z-API responde `{error: "You are already connected"}` com HTTP 200 em alguns
// casos e com 4xx em outros). Quem traduz e `estadoZapi`/`traduzirErroZapi` em
// lib/canal-conexao.ts.
type RespostaCrua = { status: number; corpo: any };

async function chamarCru(
  creds: ZapiCreds,
  path: string,
  metodo: "GET" | "POST" = "GET"
): Promise<RespostaCrua> {
  const res = await fetch(urlDe(creds, path), {
    method: metodo,
    headers: { ...(creds.clientToken ? { "Client-Token": creds.clientToken } : {}) },
    cache: "no-store",
  });
  const corpo = await res.json().catch(() => ({}));
  return { status: res.status, corpo };
}

/**
 * Estado da instancia: `{connected, smartphoneConnected, error}`.
 * Devolve o CRU — a traducao pro vocabulario do painel e pura (`estadoZapi`).
 */
export function zapiStatus(creds: ZapiCreds): Promise<RespostaCrua> {
  return chamarCru(creds, "status");
}

/**
 * Aparelho conectado: `{phone, name, imgUrl, ...}`. E daqui que sai o NUMERO que
 * a troca de chip confere (`vereditoDaTroca`) — o `/status` nao o traz.
 * Instancia desconectada responde vazio/erro; quem chama trata como "sem numero".
 */
export function zapiDevice(creds: ZapiCreds): Promise<RespostaCrua> {
  return chamarCru(creds, "device");
}

/**
 * QR Code como imagem base64: `{value: "data:image/png;base64,..."}`.
 *
 * Pedir de novo INVALIDA o anterior — e por isso que a rota que chama isto e
 * POST, e nao GET: gerar QR mexe no estado do pareamento no provedor, e chave de
 * API `somente_leitura` nao pode abrir sessao de pareamento em numero da empresa.
 */
export async function zapiQrCode(creds: ZapiCreds): Promise<{ qr: string | null; erro: string | null }> {
  const { status, corpo } = await chamarCru(creds, "qr-code/image");
  const valor = typeof corpo?.value === "string" ? corpo.value.trim() : "";
  if (valor) {
    // a Z-API as vezes devolve so o base64 cru, sem o prefixo de data URI
    const qr = valor.startsWith("data:") ? valor : `data:image/png;base64,${valor}`;
    // CONFERIR ANTES DE DEVOLVER (achado de revisao): este valor vai direto pro
    // `src` de um <img> na tela. `qrValido` (puro) recusa o que nao for
    // data:image/(png|jpeg);base64 — `src` de imagem e superficie de injecao, e o
    // conteudo vem de fora. Fail-closed: valor estranho vira "nao consegui o
    // codigo", nunca um atributo com conteudo arbitrario.
    if (qrValido(qr)) return { qr, erro: null };
    return {
      qr: null,
      erro: "o provedor devolveu algo que nao e uma imagem de QR Code — tente gerar outro",
    };
  }
  const erro = String(corpo?.error ?? corpo?.message ?? "").trim();
  return { qr: null, erro: erro || `Z-API ${status}` };
}

/**
 * Codigo de 8 digitos pra digitar NO CELULAR (alternativa sem camera).
 * `phone` = DDI+DDD+numero, so digitos — a Z-API o recebe no PATH.
 *
 * O numero e validado por `normalizarNumero` (lib/canal-conexao.ts) ANTES de
 * chegar aqui: numero com caractere estranho iria direto pra URL da API.
 */
export async function zapiPhoneCode(
  creds: ZapiCreds,
  telefone: string
): Promise<{ codigo: string | null; erro: string | null }> {
  const { status, corpo } = await chamarCru(creds, `phone-code/${encodeURIComponent(telefone)}`);
  const codigo = String(corpo?.code ?? corpo?.value ?? corpo?.pairingCode ?? "").trim();
  if (codigo) return { codigo, erro: null };
  const erro = String(corpo?.error ?? corpo?.message ?? "").trim();
  return { codigo: null, erro: erro || `Z-API ${status}` };
}

/** Desconecta o chip da instancia (a instancia continua existindo). */
export function zapiDisconnect(creds: ZapiCreds): Promise<RespostaCrua> {
  return chamarCru(creds, "disconnect");
}

/** Reinicia a sessao da instancia — o "tira e poe" de quando o celular travou. */
export function zapiRestart(creds: ZapiCreds): Promise<RespostaCrua> {
  return chamarCru(creds, "restart", "POST");
}

// Apagar mensagem enviada — DELETE /messages?messageId=&phone=&owner=true (confirmado ao vivo).
export async function zapiDelete(creds: ZapiCreds, phone: string, messageId: string, owner = true) {
  const qs = new URLSearchParams({ messageId, phone, owner: String(owner) });
  const res = await fetch(urlDe(creds, `messages?${qs}`), {
    method: "DELETE",
    headers: { ...(creds.clientToken ? { "Client-Token": creds.clientToken } : {}) },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j as any)?.error) {
    throw new Error((j as any)?.message || (j as any)?.error || `Z-API ${res.status}`);
  }
  return j;
}

// REAGIR a uma mensagem (03/09/2026) — POST send-reaction {phone, messageId,
// reaction}. Mesmo contrato que o whatsapp-agent roda em producao (edge
// wa-proxy, acao send-reaction). `reaction: ""` REMOVE a reacao. A doc da Z-API
// pra este endpoint respondia 404 em 03/09/2026 — o contrato veio do cliente que
// ja o usa em producao, nao de chute. O corpo e montado por lib/reacoes.ts (puro,
// provado); aqui so o POST.
export function zapiReact(creds: ZapiCreds, phone: string, messageId: string, reaction: string) {
  return post(creds, "send-reaction", corpoReacaoZapi(phone, messageId, reaction));
}
