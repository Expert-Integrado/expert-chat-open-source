// Dispositivo de acesso — REGRA PURA (card 86ak85917).
//
// POR QUE ISTO EXISTE, e o VERIFY que decidiu o desenho (31/08/2026):
// o auth deste painel e o GoTrue do Supabase, compartilhado com os outros apps
// do pool. Medido no `@supabase/auth-js` 2.112.3 instalado aqui (a superficie
// inteira de `GoTrueAdminApi`): `signOut`, `inviteUserByEmail`, `generateLink`,
// `createUser`, `listUsers`, `getUserById`, `updateUserById`, `deleteUser` e o
// sub-objeto `mfa` (`listFactors`) — e NENHUM listador de SESSOES. `signOut`
// exige o JWT do
// proprio usuario (que o admin nao tem) e, no default, e GLOBAL: revoga TODOS
// os refresh tokens da pessoa em TODOS os apps do pool. Esse foi o gotcha pago
// pela Frente G na troca de senha (`signOut({scope:"local"})`), e ele decide
// aqui tambem: **este painel nao chama signOut de terceiro**.
//
// Consequencia: "de onde cada pessoa acessa" e registro NOSSO, alimentado a
// cada request autenticado. Um DISPOSITIVO e (pessoa + navegador/sistema), com
// primeiro acesso, ultimo acesso e ultimo IP.
//
// LIMITE HONESTO, declarado porque muda o que a revogacao significa: a
// impressao digital sai do `user-agent`, que e texto que o CLIENTE escolhe.
// Revogar um dispositivo faz ESTE painel recusar quem chega com aquela
// assinatura — e uma tranca de porta, nao criptografia: quem controla o cliente
// pode mudar o user-agent e voltar como dispositivo novo. A revogacao DURA
// continua sendo desativar a pessoa (`ativo:false`), que bane no GoTrue e vale
// pro pool inteiro. A tela tem que dizer isso com essas palavras.
//
// Zero import de proposito: roda no Next e em node solto.

export type Dispositivo = {
  /** navegador reconhecido, ou "desconhecido" */
  navegador: string;
  /** sistema operacional reconhecido, ou "desconhecido" */
  sistema: string;
  /** true quando o user-agent parece robo/CLI, nao navegador de gente */
  robo: boolean;
  /** "Chrome no Windows" — o que a tela mostra */
  rotulo: string;
};

const DESCONHECIDO = "desconhecido";

// Ordem importa: Edge tambem diz "Chrome"; Chrome tambem diz "Safari".
const NAVEGADORES: ReadonlyArray<[string, string]> = [
  ["edg/", "Edge"],
  ["opr/", "Opera"],
  ["yabrowser", "Yandex"],
  ["firefox/", "Firefox"],
  ["chrome/", "Chrome"],
  ["crios/", "Chrome"],
  ["safari/", "Safari"],
];

const SISTEMAS: ReadonlyArray<[string, string]> = [
  ["windows nt", "Windows"],
  ["iphone", "iPhone"],
  ["ipad", "iPad"],
  ["android", "Android"],
  ["mac os x", "macOS"],
  ["cros", "ChromeOS"],
  ["linux", "Linux"],
];

// Cliente que nao e navegador de gente. Serve pra tela nao chamar um script de
// "dispositivo do Joao" — e pra ninguem confundir chave de API com sessao.
const ROBOS = ["curl/", "wget/", "python-requests", "node-fetch", "undici", "axios", "postman", "insomnia", "go-http-client", "okhttp", "claude", "bot"];

function achar(ua: string, tabela: ReadonlyArray<[string, string]>): string {
  for (const [agulha, nome] of tabela) if (ua.includes(agulha)) return nome;
  return DESCONHECIDO;
}

/** Le o user-agent. Nunca lanca, nunca devolve vazio. */
export function lerUserAgent(bruto: unknown): Dispositivo {
  const ua = (typeof bruto === "string" ? bruto : "").toLowerCase().slice(0, 400);
  if (!ua) {
    return { navegador: DESCONHECIDO, sistema: DESCONHECIDO, robo: false, rotulo: "cliente sem identificacao" };
  }
  const robo = ROBOS.some((r) => ua.includes(r));
  const navegador = robo ? DESCONHECIDO : achar(ua, NAVEGADORES);
  const sistema = achar(ua, SISTEMAS);
  let rotulo: string;
  if (robo) rotulo = "programa (nao e navegador)";
  else if (navegador === DESCONHECIDO && sistema === DESCONHECIDO) rotulo = "cliente nao reconhecido";
  else if (sistema === DESCONHECIDO) rotulo = navegador;
  else if (navegador === DESCONHECIDO) rotulo = sistema;
  else rotulo = `${navegador} no ${sistema}`;
  return { navegador, sistema, robo, rotulo };
}

/**
 * Texto ESTAVEL que identifica o dispositivo, pra virar hash.
 *
 * Nao e o user-agent cru de proposito: versao de navegador muda a cada semana e
 * cada atualizacao do Chrome criaria um "dispositivo novo" na lista, enchendo a
 * tela de linhas mortas. Entao a chave e (navegador, sistema) — o que a pessoa
 * reconhece ("meu Chrome no Windows"). O user-agent cru fica gravado na linha,
 * pra auditoria.
 */
export function assinaturaDispositivo(ua: unknown): string {
  const d = lerUserAgent(ua);
  return `${d.navegador}|${d.sistema}|${d.robo ? "robo" : "navegador"}`;
}

/**
 * IP REAL do cliente, antes do proxy.
 *
 * Vem do modulo 3 do mapa, secao 5: na ferramenta que este painel substitui a
 * coluna de IP dos 41 dispositivos nasceu inutil porque registrava o endereco
 * INTERNO do proxy (10.244.x.x), nao o do usuario. Na Vercel o real e o
 * PRIMEIRO de `x-forwarded-for`; `x-real-ip` e a reserva.
 *
 * Endereco privado e devolvido do mesmo jeito (nao inventamos dado), mas
 * `ipPrivado` deixa a tela avisar que aquela linha nao serve pra rastrear.
 */
export function ipDoCliente(cabecalhos: {
  forwardedFor?: string | null;
  realIp?: string | null;
}): string | null {
  const ff = (cabecalhos.forwardedFor || "").split(",")[0].trim();
  const bruto = ff || (cabecalhos.realIp || "").trim();
  if (!bruto) return null;
  // IPv6 entre colchetes com porta, e IPv4 com porta
  const limpo = bruto.replace(/^\[|\]$/g, "").replace(/:\d+$/, (m) => (bruto.includes(".") ? "" : m));
  return limpo.slice(0, 64) || null;
}

const PRIVADOS = [
  new RegExp("^10\\."),
  new RegExp("^127\\."),
  new RegExp("^192\\.168\\."),
  new RegExp("^172\\.(1[6-9]|2[0-9]|3[01])\\."),
  new RegExp("^169\\.254\\."),
  new RegExp("^::1$"),
  new RegExp("^f[cd]", "i"),
];

/** true = endereco de rede interna: registra, mas nao rastreia ninguem. */
export function ipPrivado(ip: unknown): boolean {
  if (typeof ip !== "string" || !ip) return false;
  return PRIVADOS.some((r) => r.test(ip));
}
