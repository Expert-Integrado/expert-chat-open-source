// As DECISOES PURAS do instalador em cima do WhatsApp Agent (`agente.mjs`).
// Sem fs, sem rede, sem env: tudo aqui roda na prova (`agente.mjs --prova`).
//
// O que ele decide: onde procurar a pasta do agente, o que ler do `.env` dele,
// de onde vem a chave da mcp-api, qual chave anon serve, o que escrever no
// `.env.local` sem sobrescrever o que ja existe, e o SQL (escapado) do bearer
// e do primeiro administrador.

import path from "node:path";

// ── .env ────────────────────────────────────────────────────────────────────

/** KEY=VALUE por linha; comentario e vazio ignorados; aspas nas pontas caem. */
export function parseEnv(texto) {
  const out = {};
  for (const bruta of String(texto || "").split(/\r?\n/)) {
    const l = bruta.trim();
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("=");
    if (i <= 0) continue;
    const k = l.slice(0, i).trim().replace(/^export\s+/, "");
    let v = l.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

/** `.env.local` de volta pra texto, uma chave por linha, valor cru (JSON e hex nao tem quebra de linha). */
export function renderEnv(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, " ")}`).join("\n") + "\n";
}

// ── onde esta o agente ──────────────────────────────────────────────────────

/** Pastas candidatas, na ordem em que vale procurar. Quem confere se existe e o IO. */
export function candidatosDePasta(raizPainel, home, explicita) {
  const c = [];
  if (explicita) c.push(path.resolve(explicita));
  c.push(path.resolve(raizPainel, "..", "whatsapp-agent"));
  c.push(path.resolve(home, "whatsapp-agent"));
  return [...new Set(c)];
}

/**
 * O que IDENTIFICA a pasta do agente e o codigo dele (a edge da mcp-api). O
 * `.env` e OUTRA pergunta: pasta certa sem `.env` (agent na VPS, clone fresco)
 * precisa de diagnostico proprio — "nao achei a pasta" mandava a pessoa passar
 * `--agente` com o caminho certo e receber a mesma frase (achado 09/09/2026).
 */
export const MARCA_DO_AGENTE = "supabase/functions/mcp-api/index.ts";
export const ENV_DO_AGENTE = ".env";

/**
 * A chave do banco, na MESMA ordem do `_shared/db-key.ts` do agente: a
 * service_role legada (JWT) pode estar DESABILITADA num projeto migrado — la a
 * chave e a nova (`sb_secret_…`), em `SUPABASE_SECRET_KEYS` (JSON, entrada
 * `default`) ou `SUPABASE_SECRET_KEY`. Exigir so o nome velho recusava um
 * `.env` que tinha a chave certa.
 */
export function chaveDoBanco(envAgente) {
  try {
    const d = JSON.parse(envAgente?.SUPABASE_SECRET_KEYS || "");
    const v = d && typeof d === "object" && !Array.isArray(d) ? String(d.default || "").trim() : "";
    if (v) return { chave: v, fonte: "SUPABASE_SECRET_KEYS" };
  } catch { /* nao e JSON: cai pro proximo */ }
  for (const k of ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    const v = String(envAgente?.[k] || "").trim();
    if (v) return { chave: v, fonte: k };
  }
  return { chave: "", fonte: "none" };
}

/** JWT (`eyJ…`) ou chave nova? O Auth admin so aceita a primeira forma. */
export function ehJwt(chave) {
  return /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(String(chave || ""));
}

/**
 * A chave pro GoTrue admin (criar o 1o usuario). MEDIDO em 09/09/2026 num
 * projeto com a legada desabilitada: a `sb_secret_` E aceita pelo endpoint
 * admin do Auth (o "nao serve como bearer" do db-key.ts do agente vale pro
 * gateway das edge functions com verify_jwt, que parseia o bearer como JWT —
 * o GoTrue valida a chave de servico por outro caminho). O JWT legado, quando
 * existe, continua preferido; e o IO testa a credencial ANTES de pedir senha
 * porque a legada pode estar DESABILITADA num projeto migrado.
 */
export function chaveDoAuth(envAgente) {
  const legada = String(envAgente?.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (ehJwt(legada)) return { chave: legada, jwt: true };
  const db = chaveDoBanco(envAgente).chave;
  return { chave: db, jwt: ehJwt(db) };
}

/**
 * A chave do banco quando o `.env` nao tem nenhuma das tres: a MESMA resposta
 * da Management API que da a anon (`api-keys?reveal=true`) traz a secret do
 * projeto. Com PAT + ref (obrigatorios de todo jeito) ela e derivavel — pedir
 * de novo no `.env` era pedir a mesma informacao duas vezes (sessao vizinha,
 * 09/09/2026). Escolha EXPLICITA: secret nova (`default` primeiro) e, so se
 * o projeto nao tiver nenhuma, a service_role legada. NUNCA a publishable/anon:
 * ela passa no PostgREST como anon e devolveria lista VAZIA em vez de erro — a
 * falha silenciosa.
 */
export function escolherSecret(lista) {
  const arr = Array.isArray(lista) ? lista : [];
  const novas = arr.filter((k) => k?.type === "secret" && typeof k?.api_key === "string" && k.api_key.startsWith("sb_secret_"));
  const nova = novas.find((k) => k.name === "default") ?? novas[0];
  if (nova) return { chave: nova.api_key, fonte: "api-keys (secret nova)" };
  const legada = arr.find((k) => k?.name === "service_role" && ehJwt(k?.api_key));
  if (legada) return { chave: legada.api_key, fonte: "api-keys (service_role legada)" };
  return { chave: "", fonte: "none" };
}

/** O que o `.env` do agente precisa ter pra este instalador andar sozinho: o resto se deriva. */
export const CHAVES_DO_AGENTE = ["SUPABASE_ACCESS_TOKEN", "SUPABASE_PROJECT_REF"];

export function faltamNoAgente(envAgente) {
  return CHAVES_DO_AGENTE.filter((k) => !String(envAgente?.[k] || "").trim());
}

/** ref valido = o subdominio do projeto (20 letras minusculas). */
export function refValido(ref) {
  return /^[a-z]{20}$/.test(String(ref || ""));
}

// ── a chave da mcp-api ──────────────────────────────────────────────────────
//
// O setup do agente gera a MCP_API_KEY e sobe pro cofre das functions — de la
// nao se le de volta. Ela sobrevive em algum destes lugares, nesta ordem:
//   1. `.env.local` do painel (re-execucao)
//   2. `.env` do agente (quando o setup gravou)
//   3. ambiente do shell (o `.mcp.json` do agente le `${MCP_API_KEY}` de la)
//   4. header `x-mcp-key` do servidor `whatsapp-agent` no ~/.claude.json
// Placeholder `${...}` nao e valor. Nada achado = o IO pergunta.
export function escolherChaveMcp(fontes) {
  for (const v of fontes) {
    const s = String(v || "").trim();
    if (s && !/^\$\{.*\}$/.test(s)) return s;
  }
  return null;
}

/** O header do servidor no ~/.claude.json (raiz ou por projeto). */
export function chaveDoClaudeJson(json) {
  const servidores = [json?.mcpServers, ...Object.values(json?.projects ?? {}).map((p) => p?.mcpServers)];
  for (const s of servidores) {
    const h = s?.["whatsapp-agent"]?.headers;
    const v = h?.["x-mcp-key"] ?? h?.["X-MCP-Key"];
    if (v) return v;
  }
  return null;
}

// ── a chave anon (login do painel) ──────────────────────────────────────────
//
// O `.env` do agente guarda a service_role e a secret nova — nenhuma serve no
// navegador. A anon vem da Management API (`/v1/projects/{ref}/api-keys`).
// Preferimos a `anon` legada (JWT): e o formato que o supabase-js desta versao
// usa no login. A `publishable` nova fica como reserva, com aviso.
export function escolherAnon(lista) {
  const arr = Array.isArray(lista) ? lista : [];
  const legada = arr.find((k) => k?.name === "anon" && k?.api_key);
  if (legada) return { chave: legada.api_key, aviso: null };
  const nova = arr.find((k) => k?.type === "publishable" && k?.api_key);
  if (nova) return { chave: nova.api_key, aviso: "projeto sem chave anon legada: usando a publishable — se o login falhar, gere a anon em Settings → API Keys → Legacy" };
  return { chave: null, aviso: "nenhuma chave anon/publishable no projeto" };
}

// ── o .env.local ────────────────────────────────────────────────────────────

/** O canal do agente em CANAIS_EXTRA (sem `conta` = instancia default do agente). */
export function canalDoAgente({ id = "agente", rotulo = "Meu WhatsApp", conta } = {}) {
  return { id, tipo: "whatsapp", dono: "pessoal", rotulo, fonte: "whatsapp-agent", ...(conta ? { conta } : {}), ativo: true };
}

/**
 * O que escrever. REGRA: chave que ja existe no `.env.local` NUNCA e
 * sobrescrita (re-executar o instalador nao pode trocar um segredo que o
 * painel ja usa). `gerar()` e injetado pra prova nao depender de aleatorio.
 */
export function planoEnvLocal({ ref, anon, serviceRole, chaveMcp, canal, atual = {}, gerar }) {
  const url = `https://${ref}.supabase.co`;
  const desejadas = {
    MSG_SUPABASE_URL: url,
    MSG_SUPABASE_SERVICE_KEY: serviceRole,
    NEXT_PUBLIC_AUTH_URL: url,
    NEXT_PUBLIC_AUTH_ANON_KEY: anon,
    WEBHOOK_KEY: gerar(),
    CHATGURU_SYNC_SECRET: gerar(),
    WA_MCP_URL: `${url}/functions/v1/mcp-api`,
    WA_MCP_KEY: chaveMcp,
    CANAIS_EXTRA: JSON.stringify([canal]),
  };
  const novas = {};
  const mantidas = [];
  for (const [k, v] of Object.entries(desejadas)) {
    if (String(atual[k] || "").trim()) mantidas.push(k);
    else if (v) novas[k] = v;
  }
  return { final: { ...atual, ...novas }, novas: Object.keys(novas), mantidas };
}

// ── SQL ─────────────────────────────────────────────────────────────────────

/** literal SQL seguro: aspas simples dobradas, sem quebra de linha */
export function literal(s) {
  return `'${String(s).replace(/'/g, "''").replace(/[\r\n]/g, " ")}'`;
}

export function sqlTickBearer(segredo) {
  return `insert into mensageria.config (chave, valor) values ('tick_bearer', to_jsonb(${literal(segredo)}::text)) on conflict (chave) do update set valor = excluded.valor, updated_at = now();`;
}

export function emailValido(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ""));
}

export function uuidValido(u) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(u || ""));
}

export function sqlIdPorEmail(email) {
  if (!emailValido(email)) throw new Error("e-mail invalido");
  return `select id from auth.users where lower(email) = lower(${literal(email)}) limit 1;`;
}

export function sqlPerfilAdmin(uuid, nome) {
  if (!uuidValido(uuid)) throw new Error("uuid invalido");
  return `insert into mensageria.perfis (user_id, nome, papel, escopo_visao) values (${literal(uuid)}::uuid, ${literal(nome || "Admin")}, 'super_admin', 'todas') on conflict (user_id) do update set papel = 'super_admin', escopo_visao = 'todas';`;
}

/** Extensoes que as rotinas do painel precisam (idempotente; o agente ja liga as duas na 0001 dele). */
export const SQL_EXTENSOES = "create extension if not exists pg_cron; create extension if not exists pg_net;";

/**
 * Os dois buckets PUBLICOS que o painel usa e que migration nenhuma cria (no
 * repo e gesto humano no dashboard): `midia-mensagens` (midia enviada e
 * persistida) e `fotos-perfil` (foto do atendente e do contato). Sem o
 * primeiro, mandar foto pelo canal do agente falha com "nao consegui guardar a
 * midia". Idempotente.
 */
export const BUCKETS_DO_PAINEL = ["midia-mensagens", "fotos-perfil"];
export const SQL_BUCKETS =
  "insert into storage.buckets (id, name, public) values " +
  BUCKETS_DO_PAINEL.map((b) => `('${b}', '${b}', true)`).join(", ") +
  " on conflict (id) do update set public = true;";

// ── quais migrations rodar ──────────────────────────────────────────────────
//
// A sonda por leitura (plano.mjs) foi feita pra CONFERENCIA incremental, e tem
// dois buracos quando vira decisao de aplicar (sessao vizinha, 09/09/2026,
// reproduzido sem banco): migration que so adiciona coluna a tabela ausente sai
// "sem objeto probavel", e migration que so cria funcao sai "nao verificavel"
// com `bloqueia:false` — as duas ficavam FORA do que era aplicado, e a saida
// dizia "pronto" com 7 de 25 faltando.
//
// Regra: instalacao NOVA (schema ausente) = as 25 em ordem, sem sonda. Instalacao
// que ja tem o schema = tudo que a sonda nao PROVOU como aplicada e pendente —
// reaplicar migration idempotente (if not exists / or replace) custa nada;
// nascer sem 7 custa a instalacao.
export function migrationsARodar(avaliadas, novaInstalacao) {
  const ordem = [...avaliadas].sort((a, b) => a.numero - b.numero);
  if (novaInstalacao) return ordem;
  return ordem.filter((a) => a.veredito?.estado !== "aplicada");
}

/** O alerta duro do fim: a conta bate? (o que sobrou ausente/PARCIAL depois de aplicar) */
export function faltandoAposAplicar(avaliadasDepois) {
  return avaliadasDepois.filter((a) => a.veredito?.estado === "ausente" || a.veredito?.estado === "PARCIAL").map((a) => a.arquivo);
}

// ── o schema exposto no PostgREST ───────────────────────────────────────────
//
// O painel INTEIRO fala com o banco por `db: { schema: "mensageria" }`
// (lib/mensageria.ts). O PostgREST so serve schema que esta em `db_schema`
// (Settings → API → Exposed schemas), e um projeto nasce com
// "public,graphql_public". Sem `mensageria` ali, migration aplicada e produto
// que nao sobe — e a sonda deste instalador acusa 18 migrations "ausentes"
// que existem (sessao vizinha, 09/09/2026, medido por SQL).
//
// NUNCA substituir a lista: apagar `public` derruba o agente; `graphql_public`
// idem pro GraphQL. Acrescenta ao fim, idempotente.
//
// SEGURANCA (verificado): expor o schema nao abre nada — em `mensageria` so a
// service_role tem GRANT; anon/authenticated nao tem privilegio em tabela
// nenhuma. Parte das tabelas nao tem RLS e o que as protege e justamente a
// AUSENCIA de GRANT: um `grant ... to anon` futuro derruba isso de uma vez.
export const SCHEMA_DO_PAINEL = "mensageria";

export function dbSchemaComPainel(atual) {
  const lista = String(atual || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (lista.includes(SCHEMA_DO_PAINEL)) return { precisa: false, novo: lista.join(", ") };
  return { precisa: true, novo: [...lista, SCHEMA_DO_PAINEL].join(", ") };
}
