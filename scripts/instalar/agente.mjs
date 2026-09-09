#!/usr/bin/env node
// INSTALADOR EM CIMA DO WHATSAPP AGENT — o painel como tela do agente que voce ja tem.
//
//   node scripts/instalar/agente.mjs                       # confere e mostra o plano (nao muda nada)
//   node scripts/instalar/agente.mjs --valendo             # aplica: migrations, .env.local, bearer
//   node scripts/instalar/agente.mjs --valendo --admin-email voce@empresa.com   # + primeiro admin (pede a senha)
//   node scripts/instalar/agente.mjs --agente ../caminho/do/whatsapp-agent      # se a pasta nao for achada
//   node scripts/instalar/agente.mjs --mcp-key <MCP_API_KEY>                    # se a chave nao for achada
//   node scripts/instalar/agente.mjs --prova
//
// De onde vem cada coisa: do `.env` que o setup do agente deixou na pasta dele
// (PAT, ref do projeto, service_role). A anon vem da Management API; as
// migrations do painel rodam pela MESMA API (`/database/query`), no MESMO projeto
// — o painel vive no schema `mensageria`, o agente em `public`. Nenhum segredo e
// impresso. Decisoes puras em agente-plano.mjs.
//
// POR QUE ESTE ARQUIVO RODA MIGRATION, se o `index.mjs` se recusa: la e instalacao
// em cliente, onde DDL sem alguem lendo e risco. Aqui quem instala ja rodou
// `supabase db push` do agente no proprio projeto e quer o painel em cima — o
// gesto humano ja aconteceu. O modo padrao continua sendo conferencia.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import assert from "node:assert/strict";
import {
  BUCKETS_DO_PAINEL, CHAVES_DO_AGENTE, ENV_DO_AGENTE, MARCA_DO_AGENTE, SQL_BUCKETS, SQL_EXTENSOES, candidatosDePasta, canalDoAgente, chaveDoAuth,
  chaveDoBanco, chaveDoClaudeJson, ehJwt, emailValido, escolherAnon, escolherChaveMcp, escolherSecret, faltamNoAgente,
  faltandoAposAplicar, literal, migrationsARodar, parseEnv, planoEnvLocal, refValido,
  renderEnv, sqlIdPorEmail, sqlPerfilAdmin, sqlTickBearer, uuidValido,
} from "./agente-plano.mjs";
import { lerNomeDeMigration, objetosDaMigration, vereditoDaMigration } from "./plano.mjs";

const RAIZ = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const MGMT = "https://api.supabase.com";
const log = (s = "") => console.log(s);

async function http(url, opcoes = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const r = await fetch(url, { ...opcoes, signal: ctrl.signal, cache: "no-store" });
    const texto = await r.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(texto); } catch { /* texto cru */ }
    return { status: r.status, json, texto };
  } finally { clearTimeout(t); }
}

function mgmt(pat) {
  return async (caminho, metodo = "GET", corpo) =>
    http(`${MGMT}${caminho}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
      ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    });
}

// SQL pela Management API. Erro vira excecao com a mensagem do Postgres (sem o SQL).
async function sql(api, ref, query) {
  const r = await api(`/v1/projects/${ref}/database/query`, "POST", { query });
  if (r.status >= 400) throw new Error(`SQL falhou (HTTP ${r.status}): ${r.json?.message || r.texto.slice(0, 300)}`);
  return r.json;
}

function perguntarOculto(pergunta) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const w = rl._writeToOutput;
    rl.question(pergunta, (v) => { rl.close(); process.stdout.write("\n"); res(v.trim()); });
    rl._writeToOutput = (s) => { if (/\n|\r/.test(s) || s === pergunta) w.call(rl, s); };
  });
}

function acharPastaDoAgente(explicita) {
  for (const c of candidatosDePasta(RAIZ, os.homedir(), explicita)) {
    if (fs.existsSync(path.join(c, MARCA_DO_AGENTE))) return c;
  }
  return null;
}

function lerJsonSeguro(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

async function sondar(url, key, migrations) {
  const tabelas = {}; const colunas = {};
  const pedir = (t, sel) => http(`${url}/rest/v1/${t}?select=${encodeURIComponent(sel)}&limit=0`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Accept-Profile": "mensageria" },
  });
  for (const t of [...new Set(migrations.flatMap((m) => m.objetos.tabelas))]) tabelas[t] = (await pedir(t, "*")).status === 200;
  for (const ch of [...new Set(migrations.flatMap((m) => m.objetos.colunas.map((c) => `${c.tabela}.${c.coluna}`)))]) {
    const [t, c] = ch.split(".");
    if (tabelas[t] === false) continue;
    colunas[ch] = (await pedir(t, c)).status === 200;
  }
  return { tabelas, colunas };
}

function lerMigrations() {
  const dir = path.join(RAIZ, "supabase", "migrations");
  return fs.readdirSync(dir).map(lerNomeDeMigration).filter(Boolean).sort((a, b) => a.numero - b.numero)
    .map((m) => ({ ...m, sql: fs.readFileSync(path.join(dir, m.arquivo), "utf8") }))
    .map((m) => ({ ...m, objetos: objetosDaMigration(m.sql) }));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--prova")) return prova();
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const valendo = argv.includes("--valendo");
  log(`# Expert Chat em cima do WhatsApp Agent — ${valendo ? "APLICANDO" : "conferencia (nada e alterado)"}`);
  log("");

  // 1. a pasta e o .env do agente
  const pasta = acharPastaDoAgente(arg("--agente"));
  if (!pasta) { log(`**Nao achei a pasta do WhatsApp Agent** (a que tem \`${MARCA_DO_AGENTE}\`). Passe \`--agente <caminho>\`.`); process.exitCode = 1; return; }
  const envPath = path.join(pasta, ENV_DO_AGENTE);
  if (!fs.existsSync(envPath)) {
    log(`**Achei o agente em \`${pasta}\`, mas ele nao tem \`.env\`.** E nele que o setup do agente guarda o ref do projeto (SUPABASE_PROJECT_REF), o PAT (SUPABASE_ACCESS_TOKEN) e a chave do banco (SUPABASE_SECRET_KEY ou a legada SUPABASE_SERVICE_ROLE_KEY). Agent rodando na VPS ou clone novo: crie o \`.env\` com essas tres, ou rode o \`/setup\` do agente.`);
    process.exitCode = 1; return;
  }
  const envAgente = parseEnv(fs.readFileSync(envPath, "utf8"));
  const faltam = faltamNoAgente(envAgente);
  if (faltam.length) { log(`**O .env do agente em ${pasta} nao tem:** ${faltam.join(", ")}. Reabra o setup do agente pra completar.`); process.exitCode = 1; return; }
  const ref = envAgente.SUPABASE_PROJECT_REF;
  if (!refValido(ref)) { log("**SUPABASE_PROJECT_REF com forma inesperada** (esperado: 20 letras)."); process.exitCode = 1; return; }
  const pat = envAgente.SUPABASE_ACCESS_TOKEN;
  const url = `https://${ref}.supabase.co`;
  log(`1. Agente em \`${pasta}\` — projeto \`${ref}\`.`);

  // 2. chaves do projeto pela Management API: a anon (login) e, se o .env nao
  //    tiver, a do banco. A do Auth admin e outra pergunta (ver passo 7).
  const api = mgmt(pat);
  const rk = await api(`/v1/projects/${ref}/api-keys?reveal=true`);
  if (rk.status === 401 || rk.status === 403) { log("**O PAT do agente (SUPABASE_ACCESS_TOKEN) foi recusado pela Management API.** Gere outro em Account → Access Tokens e atualize o .env do agente."); process.exitCode = 1; return; }
  const anon = escolherAnon(rk.json);
  if (!anon.chave) { log(`**${anon.aviso}**`); process.exitCode = 1; return; }
  // chave do banco (DB/Storage): .env na ordem do db-key.ts do agente, senao a secret do projeto
  const banco = chaveDoBanco(envAgente).chave ? chaveDoBanco(envAgente) : escolherSecret(rk.json);
  const serviceRole = banco.chave;
  if (!serviceRole) { log("**Nao achei chave do banco** nem no .env do agente nem nas api-keys do projeto (nem secret nova, nem service_role legada). Gere uma secret em Settings → API Keys e rode de novo."); process.exitCode = 1; return; }
  // Auth admin: JWT legado do .env; senao o service_role do projeto, se existir; senao a do banco
  const doEnv = chaveDoAuth(envAgente);
  const legadaDoProjeto = (Array.isArray(rk.json) ? rk.json : []).find((k) => k?.name === "service_role" && ehJwt(k?.api_key))?.api_key;
  const auth = doEnv.jwt ? doEnv : legadaDoProjeto ? { chave: legadaDoProjeto, jwt: true } : { chave: serviceRole, jwt: ehJwt(serviceRole) };
  log(`2. Chaves do projeto: anon ok${anon.aviso ? ` (${anon.aviso})` : ""}; banco via ${banco.fonte}${ehJwt(serviceRole) ? " (legada, JWT)" : " (nova)"}.`);

  // 3. a chave da mcp-api
  const envLocalPath = path.join(RAIZ, ".env.local");
  const atual = fs.existsSync(envLocalPath) ? parseEnv(fs.readFileSync(envLocalPath, "utf8")) : {};
  let chaveMcp = escolherChaveMcp([
    arg("--mcp-key"), atual.WA_MCP_KEY, envAgente.MCP_API_KEY, process.env.MCP_API_KEY,
    chaveDoClaudeJson(lerJsonSeguro(path.join(os.homedir(), ".claude.json"))),
  ]);
  if (!chaveMcp && valendo && process.stdin.isTTY) chaveMcp = await perguntarOculto("Cole a MCP_API_KEY do agente (nao aparece na tela): ");
  if (!chaveMcp) { log("**Nao achei a MCP_API_KEY do agente** (a que vai no header x-mcp-key). Passe `--mcp-key <valor>`, ou rode com `--valendo` num terminal pra eu perguntar."); if (valendo) { process.exitCode = 1; return; } }
  else log("3. Chave da mcp-api: ok.");

  // 4. migrations do painel (schema mensageria). Instalacao NOVA = as 25 em
  //    ordem, sem sonda; instalacao existente = tudo que a sonda nao provou como
  //    aplicada (ver migrationsARodar em agente-plano.mjs pra saber por que).
  const migrations = lerMigrations();
  const cabecalho = { apikey: serviceRole, Authorization: `Bearer ${serviceRole}`, "Accept-Profile": "mensageria" };
  const temSchema = (await http(`${url}/rest/v1/config?select=chave&limit=0`, { headers: cabecalho })).status === 200;
  const avaliar = async () => {
    const sonda = await sondar(url, serviceRole, migrations);
    return migrations.map((m) => ({ ...m, veredito: vereditoDaMigration(m.objetos, sonda) }));
  };
  const pendentes = migrationsARodar(temSchema ? await avaliar() : migrations, !temSchema);
  log(`4. Migrations do painel: ${migrations.length} no repo, ${pendentes.length} a aplicar${temSchema ? "" : " (instalacao nova: schema mensageria sera criado, todas em ordem)"}.`);
  if (valendo && pendentes.length) {
    await sql(api, ref, SQL_EXTENSOES);
    let aplicadas = 0;
    for (const m of pendentes) {
      process.stdout.write(`   aplicando ${m.arquivo} ... `);
      await sql(api, ref, m.sql);
      aplicadas++;
      log("ok");
    }
    // O ALERTA DURO: depois de aplicar, a sonda nao pode achar nada ausente ou
    // pela metade. Saida de sucesso igual a saida com migration faltando e o
    // pior estado possivel (o painel degrada com aviso discreto).
    const faltando = faltandoAposAplicar(await avaliar());
    if (faltando.length) { log(`**PAROU: ${aplicadas} aplicada(s), mas a conferencia ainda acha faltando: ${faltando.join(", ")}.** Nao siga; olhe o SQL Editor.`); process.exitCode = 1; return; }
    log(`   ${aplicadas} de ${migrations.length} aplicada(s); conferencia depois: nada ausente nem pela metade.`);
  }

  // 4b. buckets publicos do painel (midia enviada, fotos) — migration nenhuma cria
  log(`4b. Buckets publicos ${BUCKETS_DO_PAINEL.join(" e ")}: ${valendo ? "garantidos." : "serao garantidos."}`);
  if (valendo) await sql(api, ref, SQL_BUCKETS);

  // 5. .env.local — nunca sobrescreve chave existente
  const plano = planoEnvLocal({ ref, anon: anon.chave, serviceRole, chaveMcp: chaveMcp || "", canal: canalDoAgente({ id: arg("--canal-id") || "agente", rotulo: arg("--rotulo") || "Meu WhatsApp", conta: arg("--conta") || undefined }), atual, gerar: () => crypto.randomBytes(32).toString("hex") });
  log(`5. .env.local: ${plano.novas.length} chave(s) a escrever${plano.mantidas.length ? `, ${plano.mantidas.length} ja existente(s) mantida(s)` : ""}: ${plano.novas.join(", ") || "nada"}.`);
  if (valendo && plano.novas.length) fs.writeFileSync(envLocalPath, renderEnv(plano.final), { mode: 0o600 });

  // 6. bearer das rotinas dentro do banco (mesmo segredo do CHATGURU_SYNC_SECRET)
  log("6. Senha das rotinas (tick_bearer) em mensageria.config: " + (valendo ? "gravada." : "sera gravada."));
  if (valendo) await sql(api, ref, sqlTickBearer(plano.final.CHATGURU_SYNC_SECRET));

  // 7. primeiro administrador (so com --admin-email)
  const email = arg("--admin-email");
  if (email) {
    if (!emailValido(email)) { log("**--admin-email invalido.**"); process.exitCode = 1; return; }
    const achado = valendo ? await sql(api, ref, sqlIdPorEmail(email)) : [];
    let uuid = achado?.[0]?.id ?? null;
    // O GoTrue admin exige JWT: a chave nova (`sb_secret_`) passa no DB e no
    // Storage e leva 401 aqui. Sem JWT no .env, testa ANTES de pedir senha —
    // e, no 401, o gesto vira "crie o usuario no dashboard e rode de novo" (o
    // perfil super_admin e feito por SQL, que nao depende dessa chave).
    // Testa SEMPRE antes de pedir senha: a chave nova pode nao passar, e a
    // legada pode estar DESABILITADA (projeto migrado) mesmo aparecendo na lista.
    if (valendo && !uuid) {
      const teste = await http(`${url}/auth/v1/admin/users?per_page=1`, { headers: { apikey: auth.chave, Authorization: `Bearer ${auth.chave}` } });
      if (teste.status === 401 || teste.status === 403) {
        log(`7. Administrador: a credencial disponivel (${auth.jwt ? "service_role legada, provavelmente desabilitada" : "chave nova sb_secret_"}) nao e aceita pelo Auth admin (HTTP ${teste.status}). **Crie o usuario no dashboard** (Authentication → Users → Add user: ${email} + senha) e rode este comando de novo: o perfil super_admin e feito por SQL e nao precisa dessa chave.`);
        process.exitCode = 2; return;
      }
    }
    if (valendo && !uuid) {
      const senha = arg("--admin-senha") || (process.stdin.isTTY ? await perguntarOculto(`Senha para ${email} (nao aparece na tela, minimo 8): `) : "");
      if (senha.length < 8) { log("**Senha curta demais (minimo 8).**"); process.exitCode = 1; return; }
      const r = await http(`${url}/auth/v1/admin/users`, {
        method: "POST",
        headers: { apikey: auth.chave, Authorization: `Bearer ${auth.chave}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: senha, email_confirm: true }),
      });
      if (r.status >= 400 || !uuidValido(r.json?.id)) { log(`**Falha ao criar o usuario (HTTP ${r.status}):** ${r.json?.msg || r.json?.message || r.texto.slice(0, 200)}`); process.exitCode = 1; return; }
      uuid = r.json.id;
    }
    if (valendo) await sql(api, ref, sqlPerfilAdmin(uuid, email.split("@")[0]));
    log(`7. Administrador ${email}: ${valendo ? (achado?.[0] ? "ja existia no Auth, perfil super_admin garantido." : "criado e promovido a super_admin.") : "sera criado (ou promovido, se ja existir)."}`);
  } else log("7. Administrador: pulado (passe `--admin-email voce@empresa.com`).");

  log("");
  if (!valendo) log("Nada foi alterado. Rode de novo com `--valendo` pra aplicar.");
  else log("Pronto. Agora: `npm run dev` → http://localhost:3000 → login → canal \"Meu WhatsApp\" no seletor. Deploy e rotinas (cron): `node scripts/instalar/index.mjs --envs-vercel --valendo` e o SQL que o conferidor imprime.");
}

function prova() {
  let n = 0;
  const t = (nome, fn) => { fn(); n++; console.log("ok -", nome); };
  t("parseEnv: comentario, export, aspas e = no valor", () => {
    const e = parseEnv('# c\nexport A=1\nB="x=y"\nC=\'z\'\nD=\n\nsem_igual');
    assert.deepEqual(e, { A: "1", B: "x=y", C: "z", D: "" });
  });
  t("renderEnv volta pra texto que parseEnv le igual (ida e volta)", () => {
    const o = { A: "1", CANAIS_EXTRA: '[{"id":"agente"}]', X: "com espaco" };
    assert.deepEqual(parseEnv(renderEnv(o)), o);
  });
  t("pasta do agente: explicita primeiro, depois irma, depois home", () => {
    const c = candidatosDePasta("/r/painel", "/home/u", "/x/ag");
    assert.equal(c[0], path.resolve("/x/ag"));
    assert.equal(c[1], path.resolve("/r/whatsapp-agent"));
    assert.equal(c[2], path.resolve("/home/u/whatsapp-agent"));
    assert.equal(candidatosDePasta("/r/painel", "/home/u").length, 2);
  });
  t(".env do agente: faltando chave e ref torto sao recusados; a chave do banco tem 3 nomes", () => {
    assert.deepEqual(faltamNoAgente({ SUPABASE_PROJECT_REF: "a" }), ["SUPABASE_ACCESS_TOKEN"], "so PAT e ref sao obrigatorios: a chave do banco se deriva");
    const base = Object.fromEntries(CHAVES_DO_AGENTE.map((k) => [k, "v"]));
    assert.equal(faltamNoAgente(base).length, 0);
    // a secret do projeto pelas api-keys: nova primeiro (default), legada so sem nova, publishable NUNCA
    assert.deepEqual(escolherSecret([{ type: "publishable", api_key: "sb_publishable_x" }, { type: "secret", name: "outra", api_key: "sb_secret_o" }, { type: "secret", name: "default", api_key: "sb_secret_d" }, { name: "service_role", type: "legacy", api_key: "eyJa.b.c" }]), { chave: "sb_secret_d", fonte: "api-keys (secret nova)" });
    assert.deepEqual(escolherSecret([{ name: "anon", api_key: "eyJx.y.z" }, { name: "service_role", api_key: "eyJa.b.c" }]).chave, "eyJa.b.c", "sem nova: a legada");
    assert.equal(escolherSecret([{ type: "publishable", api_key: "sb_publishable_x" }, { name: "anon", api_key: "eyJx.y.z" }]).fonte, "none", "publishable/anon nunca viram chave do banco");
    assert.equal(escolherSecret(null).fonte, "none");
    // mesma ordem do db-key.ts do agente
    assert.deepEqual(chaveDoBanco({ SUPABASE_SECRET_KEYS: '{"default":"D"}', SUPABASE_SECRET_KEY: "S", SUPABASE_SERVICE_ROLE_KEY: "eyJ.a.b" }), { chave: "D", fonte: "SUPABASE_SECRET_KEYS" });
    assert.deepEqual(chaveDoBanco({ SUPABASE_SECRET_KEYS: "{nao json", SUPABASE_SECRET_KEY: "S" }), { chave: "S", fonte: "SUPABASE_SECRET_KEY" }, "dicionario torto nao derruba: cai pro proximo");
    assert.equal(chaveDoBanco({}).fonte, "none");
    // Auth admin: JWT legado quando existe; senao a do banco, marcada como nao-JWT
    assert.equal(ehJwt("eyJhbGci.eyJyb2xl.abc-_"), true);
    assert.equal(ehJwt("sb_secret_abc"), false);
    assert.deepEqual(chaveDoAuth({ SUPABASE_SECRET_KEY: "sb_secret_x", SUPABASE_SERVICE_ROLE_KEY: "eyJa.b.c" }), { chave: "eyJa.b.c", jwt: true });
    assert.deepEqual(chaveDoAuth({ SUPABASE_SECRET_KEY: "sb_secret_x" }), { chave: "sb_secret_x", jwt: false });
    assert.equal(refValido("abcdefghijklmnopqrst"), true);
    assert.equal(refValido("ABC"), false);
  });
  t("chave da mcp-api: primeira fonte real; placeholder ${} nao conta; nada = null", () => {
    assert.equal(escolherChaveMcp(["", "${MCP_API_KEY}", " k1 ", "k2"]), "k1");
    assert.equal(escolherChaveMcp([null, undefined, "${X}"]), null);
    assert.equal(chaveDoClaudeJson({ projects: { "/p": { mcpServers: { "whatsapp-agent": { headers: { "x-mcp-key": "h" } } } } } }), "h");
    assert.equal(chaveDoClaudeJson({}), null);
  });
  t("anon: legada antes da publishable, e aviso quando so ha a nova", () => {
    assert.equal(escolherAnon([{ name: "service_role", api_key: "s" }, { name: "anon", api_key: "a" }]).chave, "a");
    const nova = escolherAnon([{ type: "publishable", api_key: "p" }]);
    assert.equal(nova.chave, "p"); assert.match(nova.aviso, /publishable/);
    assert.equal(escolherAnon(null).chave, null);
  });
  t(".env.local: chave existente NUNCA e sobrescrita; o resto entra derivado do ref", () => {
    const p = planoEnvLocal({ ref: "abcdefghijklmnopqrst", anon: "A", serviceRole: "S", chaveMcp: "M", canal: canalDoAgente(), atual: { WEBHOOK_KEY: "velha" }, gerar: () => "GERADO" });
    assert.equal(p.final.WEBHOOK_KEY, "velha");
    assert.deepEqual(p.mantidas, ["WEBHOOK_KEY"]);
    assert.equal(p.final.CHATGURU_SYNC_SECRET, "GERADO");
    assert.equal(p.final.MSG_SUPABASE_URL, "https://abcdefghijklmnopqrst.supabase.co");
    assert.equal(p.final.WA_MCP_URL, "https://abcdefghijklmnopqrst.supabase.co/functions/v1/mcp-api");
    assert.deepEqual(JSON.parse(p.final.CANAIS_EXTRA)[0], { id: "agente", tipo: "whatsapp", dono: "pessoal", rotulo: "Meu WhatsApp", fonte: "whatsapp-agent", ativo: true });
    assert.equal("conta" in canalDoAgente(), false, "sem conta = instancia default do agente");
    assert.equal(canalDoAgente({ conta: "profissional" }).conta, "profissional");
    assert.ok(!("WA_MCP_KEY" in planoEnvLocal({ ref: "abcdefghijklmnopqrst", anon: "A", serviceRole: "S", chaveMcp: "", canal: canalDoAgente(), gerar: () => "g" }).final), "chave vazia nao vira linha vazia");
  });
  t("migrations: instalacao nova roda as 25; incremental roda tudo que nao esta PROVADO aplicado (o bug dos 7)", () => {
    // reproducao da sessao vizinha: banco vazio, sonda diz `false` pra toda tabela
    const arqs = fs.readdirSync(path.join(RAIZ, "supabase", "migrations")).map(lerNomeDeMigration).filter(Boolean);
    const objetos = Object.fromEntries(arqs.map((a) => [a.arquivo, objetosDaMigration(fs.readFileSync(path.join(RAIZ, "supabase", "migrations", a.arquivo), "utf8"))]));
    const sonda = { tabelas: {}, colunas: {} };
    for (const a of arqs) for (const t of objetos[a.arquivo].tabelas) sonda.tabelas[t] = false;
    const aval = arqs.map((a) => ({ ...a, veredito: vereditoDaMigration(objetos[a.arquivo], sonda) }));
    assert.equal(migrationsARodar(aval, true).length, arqs.length, "instalacao nova: TODAS, sem sonda");
    assert.equal(migrationsARodar(aval, false).length, arqs.length, "incremental com banco vazio: TODAS tambem (nada esta provado aplicado)");
    assert.deepEqual(migrationsARodar(aval, true).map((a) => a.numero), arqs.map((a) => a.numero).sort((x, y) => x - y), "em ordem numerica");
    // incremental de verdade: so o que a sonda provou fica de fora
    const meio = aval.map((a, i) => ({ ...a, veredito: i < 5 ? { estado: "aplicada" } : a.veredito }));
    assert.equal(migrationsARodar(meio, false).length, arqs.length - 5);
    assert.ok(migrationsARodar(meio, false).some((a) => a.veredito.estado === "sem objeto probavel" || a.veredito.estado === "nao verificavel"), "so-coluna e so-funcao ENTRAM (era o que sumia)");
    assert.deepEqual(faltandoAposAplicar([{ arquivo: "a", veredito: { estado: "aplicada" } }, { arquivo: "b", veredito: { estado: "PARCIAL" } }, { arquivo: "c", veredito: { estado: "nao verificavel" } }]), ["b"], "so-funcao nao e prova de falta; PARCIAL e");
  });

  t("SQL: aspas escapadas, e-mail/uuid validados antes de virar query", () => {
    assert.equal(literal("o'x\ny"), "'o''x y'");
    assert.match(sqlTickBearer("s'1"), /'s''1'/);
    assert.throws(() => sqlIdPorEmail("nao-email"));
    assert.match(sqlIdPorEmail("a@b.co"), /lower\('a@b.co'\)/);
    assert.throws(() => sqlPerfilAdmin("123"));
    assert.match(sqlPerfilAdmin("6f1e4c1a-1b2c-4d3e-8f9a-0b1c2d3e4f5a", "x"), /super_admin/);
    assert.match(SQL_EXTENSOES, /pg_cron/);
    assert.match(SQL_BUCKETS, /\('midia-mensagens', 'midia-mensagens', true\)/);
    assert.match(SQL_BUCKETS, /on conflict \(id\) do update set public = true/, "bucket que ja existe privado vira publico, nao erro");
  });
  console.log(`\nagente --prova: ${n} blocos OK`);
}

main().catch((e) => { console.error("\nFALHOU:", e.message); process.exitCode = 1; });
