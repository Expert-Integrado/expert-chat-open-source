#!/usr/bin/env node
// INSTALADOR ASSISTIDO da instalacao (card 86ak8b5xb).
//
//   node scripts/instalar/index.mjs                    # confere tudo (nao muda nada)
//   node scripts/instalar/index.mjs --base https://...  # inclui o smoke test
//   node scripts/instalar/index.mjs --log instalacao.md # grava o relatorio
//   node scripts/instalar/index.mjs --envs-vercel       # mostra o diff das envs
//   node scripts/instalar/index.mjs --envs-vercel --valendo   # aplica o diff
//   node scripts/instalar/index.mjs --prova             # prova das decisoes
//
// `--dry` E O DEFAULT e nao precisa ser digitado. O UNICO passo com escrita e
// `--envs-vercel --valendo` (efeito reversivel, em ferramenta nossa). Banco, DDL e
// pg_cron NAO tem caminho de escrita aqui — leia o cabecalho de plano.mjs: e
// desenho, nao pendencia.
//
// O que ele entrega, na ordem em que a instalacao quebra:
//   1. envs        — presenca e forma (valor de segredo nunca e exibido)
//   2. conexao     — a credencial do Supabase realmente abre? (leitura pura)
//   3. migrations  — quais estao aplicadas, quais faltam, quais estao PELA METADE
//   4. bearer+cron — o SQL dos jobs, com o segredo lido de dentro do banco
//   5. envs Vercel — diff entre o que o projeto tem e o que a instalacao precisa
//   6. smoke test  — e o passo 6 recusa 200 onde deveria ter 401
//
// FASE 2 (declarada, nao esquecida): modo pergunta-e-resposta que ESCREVE o
// `.env.local` a partir das respostas; criacao do 1o super admin (hoje e gesto no
// painel do Supabase); e o `--valendo` do pg_cron, que so faz sentido no dia em que
// existir um caminho de escrita auditado pro banco do cliente.

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  CREDENCIAL_POR_FONTE,
  ENVS,
  JOBS_CRON,
  SMOKE,
  conferirEnvs,
  envsDosCanais,
  CANAIS_BUILTIN,
  ressalvaDoBuiltin,
  estadoDaEnv,
  filaDeMigrations,
  jobsNecessarios,
  lerNomeDeMigration,
  marcaDeValor,
  objetosDaMigration,
  prefixoDoCanal,
  sqlDoJob,
  vereditoDaMigration,
  vereditoGeral,
  vereditoSmoke,
} from "./plano.mjs";

const RAIZ = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const L = [];
const linha = (s = "") => {
  L.push(s);
  console.log(s);
};
const passos = [];
const passo = (nome, estado, detalhe) => passos.push({ nome, estado, detalhe });

// ————————————————————————————————————————————————————————————————— HTTP
//
// `redirect: manual` e o corpo DRENADO: CLI que fala HTTP e nao drena o corpo fica
// com o socket aberto e o processo pendurado, e o jeito de nao terminar com
// `process.exit()` (que corta escrita em voo) e nao pendurar nada.
async function pegar(url, opcoes = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(url, { ...opcoes, redirect: "manual", signal: ctrl.signal, cache: "no-store" });
    let corpo = null;
    try {
      corpo = await r.text();
    } catch {
      /* corpo ilegivel nao invalida o status */
    }
    return { status: r.status, corpo, headers: r.headers };
  } catch (e) {
    return { status: null, erro: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// ————————————————————————————————————————————————————————————— 1. envs
function passoEnvs(env) {
  linha("## 1. Variaveis de ambiente");
  linha("");
  const r = conferirEnvs(env);
  linha("| variavel | estado | obrigatoria | o que e |");
  linha("|---|---|---|---|");
  for (const l of r.linhas) {
    const marca = l.estado === "ok" ? (l.segredo ? `ok ${marcaDeValor(env[l.nome], true)}` : "ok") : l.estado;
    linha(`| \`${l.nome}\` | ${marca} | ${l.obrigatoria ? "sim" : "nao"} | ${l.oQueE} |`);
  }
  linha("");
  // canal declarado em CANAIS_EXTRA sem credencial APARECE na tela e NAO ENVIA, sem
  // erro nenhum. Por isso a linha do canal vem antes do veredito das envs.
  for (const p of r.problemas_de_canal ?? []) linha(`**ATENCAO:** ${p}`);
  const doCanal = r.linhas.filter((l) => l.canal);
  if (doCanal.length) {
    const faltando = doCanal.filter((l) => l.grave).map((l) => l.canal);
    const buildinsVazios = [...new Set(doCanal.filter((l) => l.builtin && l.estado !== "ok").map((l) => l.canal))];
    if (faltando.length) {
      linha(
        `**Canal sem credencial:** ${[...new Set(faltando)].join(", ")} — o canal aparece no painel, recebe mensagem e NAO ENVIA, sem erro na tela.`
      );
    } else if (!buildinsVazios.length) {
      // "conferidas" so quando TODAS estao ok: dizer isso com o builtin vazio na
      // linha de baixo e a contradicao que fez o instalador parecer confiavel demais
      linha(`Credenciais de ${new Set(doCanal.map((l) => l.canal)).size} canal(is): conferidas.`);
    }
    // BUILTIN sem credencial nao e erro (o painel sobe, e `apioficial` ainda tem
    // fallback no banco), mas nao pode passar CALADO: e o caso em que a tela OFERECE
    // envio por um canal que ninguem configurou.
    if (buildinsVazios.length) {
      linha(
        `**Confira antes de prometer envio:** canal builtin sem credencial em env: ${buildinsVazios.join(", ")}. Nao barra a subida (\`apioficial\` tem fallback em \`public.connectors\`), mas o painel OFERECE o envio.`
      );
    }
    linha("");
  }
  if (r.pode_subir) {
    passo("envs", "ok", `${r.ok} definida(s), nenhuma obrigatoria faltando`);
    linha(`**${r.ok} env(s) definidas** e nenhuma obrigatoria faltando.`);
  } else {
    passo("envs", "erro", `faltando: ${r.faltando.map((f) => f.nome).join(", ")}`);
    linha(`**FALTA:** ${r.faltando.map((f) => `\`${f.nome}\` (${f.estado})`).join(", ")}`);
    linha("");
    linha(
      "Enquanto uma obrigatoria falta, o painel sobe e falha na primeira acao — nao vale seguir pros proximos passos."
    );
  }
  linha("");
  return r;
}

// —————————————————————————————————————————————————————————— 2. conexao
async function passoConexao(env) {
  linha("## 2. A credencial abre o banco?");
  linha("");
  const url = (env.MSG_SUPABASE_URL || "").replace(/\/+$/, "");
  const key = env.MSG_SUPABASE_SERVICE_KEY || "";
  if (!url || !key) {
    passo("conexao", "erro", "sem URL/chave nao da pra testar");
    linha("_pulado: falta `MSG_SUPABASE_URL` ou `MSG_SUPABASE_SERVICE_KEY`._");
    linha("");
    return null;
  }
  // leitura pura: `limit=0` nao traz linha nenhuma e ainda assim prova acesso
  const r = await pegar(`${url}/rest/v1/config?select=chave&limit=0`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Accept-Profile": "mensageria" },
  });
  if (r.status === 200) {
    passo("conexao", "ok", "service_role le o schema mensageria");
    linha("**ok** — a chave abre o projeto e enxerga o schema `mensageria`.");
  } else if (r.status === 401 || r.status === 403) {
    passo("conexao", "erro", `chave recusada (HTTP ${r.status})`);
    linha(`**chave recusada (HTTP ${r.status}).** E a service_role deste projeto? Ela foi rotacionada?`);
  } else if (r.status === 404 || (r.corpo || "").includes("PGRST205")) {
    passo("conexao", "aviso", "conecta, mas o schema/tabela nao existe (migration 0001 pendente)");
    linha("**conecta, mas nao acha `mensageria.config`** — a migration `0001_schema_completo.sql` ainda nao rodou.");
  } else {
    passo("conexao", "erro", r.status === null ? `sem resposta: ${r.erro}` : `HTTP ${r.status}`);
    linha(r.status === null ? `**sem resposta:** ${r.erro}` : `**HTTP ${r.status}** inesperado.`);
  }
  linha("");
  return { url, key, ok: r.status === 200 };
}

// ——————————————————————————————————————————————————————— 3. migrations
function lerMigrations() {
  const dir = path.join(RAIZ, "supabase", "migrations");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map(lerNomeDeMigration)
    .filter(Boolean)
    .sort((a, b) => a.numero - b.numero)
    .map((m) => ({ ...m, objetos: objetosDaMigration(fs.readFileSync(path.join(dir, m.arquivo), "utf8")) }));
}

/** Sonda de estado: existe esta tabela? esta coluna? Tudo por LEITURA, `limit=0`. */
async function sondar(conexao, migrations) {
  const tabelas = {};
  const colunas = {};
  if (!conexao?.ok) return { tabelas, colunas };
  const pedir = async (tabela, select) => {
    const r = await pegar(`${conexao.url}/rest/v1/${tabela}?select=${encodeURIComponent(select)}&limit=0`, {
      headers: { apikey: conexao.key, Authorization: `Bearer ${conexao.key}`, "Accept-Profile": "mensageria" },
    });
    return r;
  };
  const todasTabelas = [...new Set(migrations.flatMap((m) => m.objetos.tabelas))];
  for (const t of todasTabelas) {
    const r = await pedir(t, "*");
    tabelas[t] = r.status === 200;
  }
  const todasColunas = [...new Set(migrations.flatMap((m) => m.objetos.colunas.map((c) => `${c.tabela}.${c.coluna}`)))];
  for (const chave of todasColunas) {
    const [t, c] = chave.split(".");
    // tabela ausente nao diz nada sobre a coluna: sem a tabela, `undefined`
    // (nao verificavel) em vez de `false` (que viraria PARCIAL mentiroso)
    if (tabelas[t] === false) continue;
    const r = await pedir(t, c);
    colunas[chave] = r.status === 200;
  }
  return { tabelas, colunas };
}

function passoMigrations(migrations, sonda, conexao) {
  linha("## 3. Migrations");
  linha("");
  if (!conexao?.ok) {
    passo("migrations", "aviso", "nao verificadas (sem conexao)");
    linha(`_${migrations.length} arquivo(s) no repo, mas sem conexao nao da pra saber o que ja rodou._`);
    linha("");
    return;
  }
  const avaliadas = migrations.map((m) => ({ ...m, veredito: vereditoDaMigration(m.objetos, sonda) }));
  linha("| # | arquivo | estado | detalhe |");
  linha("|---|---|---|---|");
  for (const a of avaliadas) {
    linha(`| ${String(a.numero).padStart(4, "0")} | \`${a.arquivo}\` | ${a.veredito.estado} | ${a.veredito.detalhe} |`);
  }
  linha("");
  const fila = filaDeMigrations(avaliadas);
  const bloqueiam = fila.filter((f) => f.bloqueia);
  if (!bloqueiam.length) {
    passo("migrations", fila.length ? "aviso" : "ok", fila.length ? `${fila.length} so com funcao, confira a mao` : "todas aplicadas");
    linha(
      fila.length
        ? `**Nenhuma migration faltando.** ${fila.length} arquivo(s) so criam funcao e nao dao pra checar por leitura: ${fila.map((f) => f.arquivo).join(", ")}.`
        : "**Todas as migrations aplicadas.**"
    );
  } else {
    passo("migrations", "erro", `${bloqueiam.length} pendente(s), a partir da ${bloqueiam[0].arquivo}`);
    linha(`**${bloqueiam.length} migration(s) pendente(s).** Cole no SQL Editor do Supabase, NESTA ORDEM:`);
    linha("");
    for (const f of bloqueiam) linha(`${f.numero}. \`${f.caminho}\` — ${f.motivo}`);
    linha("");
    linha(
      "Ordem numerica, sem pular buraco: aplicar fora de ordem produz o erro que ninguem entende depois. Rode este instalador de novo pra confirmar (o passo 3 e a prova: antes e depois medidos)."
    );
    linha("");
    linha("Este instalador NAO executa DDL de proposito — ver o cabecalho de `scripts/instalar/plano.mjs`.");
  }
  linha("");
}

// ————————————————————————————————————————————————————————— 4. cron
async function passoCron(env, conexao, base) {
  linha("## 4. Bearer das rotinas e jobs do pg_cron");
  linha("");
  let modulos = {};
  try {
    modulos = JSON.parse(env.MODULOS || "{}");
  } catch {
    linha("_`MODULOS` nao e JSON valido — tratado como nenhum modulo ligado._");
    linha("");
  }
  const jobs = jobsNecessarios(modulos);
  const desligados = JOBS_CRON.filter((j) => !jobs.includes(j));

  // o bearer TEM que estar no banco: o comando do cron le de la
  let bearerNoBanco = null;
  if (conexao?.ok) {
    const r = await pegar(`${conexao.url}/rest/v1/config?chave=eq.tick_bearer&select=chave`, {
      headers: { apikey: conexao.key, Authorization: `Bearer ${conexao.key}`, "Accept-Profile": "mensageria" },
    });
    if (r.status === 200) bearerNoBanco = (r.corpo || "").includes("tick_bearer");
  }
  if (bearerNoBanco === true) {
    linha("**ok** — `mensageria.config.tick_bearer` existe, entao os jobs conseguem se autenticar.");
    passo("cron", "aviso", "bearer no lugar; criar/conferir os jobs e gesto humano");
  } else if (bearerNoBanco === null) {
    // NAO CHECADO nao pode virar "FALTA": afirmar ausencia sem ter medido e o
    // mesmo erro que este instalador existe pra evitar.
    passo("cron", "aviso", "bearer nao verificado (sem conexao com o banco)");
    linha("_nao deu pra verificar se o bearer esta no banco (passo 2 nao passou). O SQL abaixo vale de todo jeito._");
    linha("");
    linha("Se ainda nao gravou o bearer, cole isto UMA VEZ, com o valor de `CHATGURU_SYNC_SECRET`:");
    linha("");
    linha("```sql");
    linha("insert into mensageria.config (chave, valor) values ('tick_bearer', to_jsonb('COLE_AQUI_O_SEGREDO'::text))");
    linha("  on conflict (chave) do update set valor = excluded.valor, updated_at = now();");
    linha("```");
  } else {
    passo("cron", "erro", "tick_bearer ausente: nenhuma rotina consegue autenticar");
    linha("**FALTA o bearer no banco.** Cole isto UMA VEZ, com o valor de `CHATGURU_SYNC_SECRET`:");
    linha("");
    linha("```sql");
    linha("insert into mensageria.config (chave, valor) values ('tick_bearer', to_jsonb('COLE_AQUI_O_SEGREDO'::text))");
    linha("  on conflict (chave) do update set valor = excluded.valor, updated_at = now();");
    linha("```");
    linha("");
    linha(
      "O segredo vai do seu 1Password direto pro SQL Editor: ele nao passa por este CLI, nao entra em log e nao vira argumento de linha de comando (argumento fica no historico do shell)."
    );
  }
  linha("");
  linha(`Jobs desta instalacao (${jobs.length}):`);
  linha("");
  linha("```sql");
  for (const j of jobs) {
    linha(sqlDoJob(j, base || "https://SUA-INSTALACAO"));
    linha("");
  }
  linha("```");
  linha("");
  if (desligados.length) {
    linha(
      `Fora da lista porque o modulo esta desligado: ${desligados.map((j) => `\`${j.nome}\` (${j.modulo})`).join(", ")}. Ligue o modulo em \`MODULOS\` antes de criar o job — job de modulo desligado roda e nao faz nada.`
    );
    linha("");
  }
  linha(
    "O comando le o bearer de dentro do banco em vez de trazer o valor: `cron.schedule` guarda o comando em TEXTO no catalogo, e bearer digitado ali fica gravado pra sempre. Bearer errado no job = 401 em silencio, e ninguem le o retorno de um cron."
  );
  linha("");
}

// ————————————————————————————————————————————————————— 5. envs na Vercel
async function passoVercel(env, aplicar) {
  linha("## 5. Variaveis no projeto da Vercel");
  linha("");
  const token = env.VERCEL_TOKEN;
  const projeto = env.VERCEL_PROJECT_ID;
  const equipe = env.VERCEL_TEAM_ID ? `?teamId=${env.VERCEL_TEAM_ID}` : "";
  if (!token || !projeto) {
    passo("vercel", "aviso", "nao conferido (sem VERCEL_TOKEN/VERCEL_PROJECT_ID)");
    linha("_pulado: defina `VERCEL_TOKEN` e `VERCEL_PROJECT_ID` no ambiente de quem instala._");
    linha("");
    linha("Estes dois NAO sao envs da instalacao: sao credenciais de quem opera o deploy, e por isso nao estao na tabela do passo 1.");
    linha("");
    return;
  }
  const r = await pegar(`https://api.vercel.com/v9/projects/${projeto}/env${equipe}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status !== 200) {
    passo("vercel", "erro", `a API da Vercel respondeu HTTP ${r.status ?? "sem resposta"}`);
    linha(`**HTTP ${r.status ?? "sem resposta"}** ao listar as envs do projeto. Token com SAML expirado responde 403.`);
    linha("");
    return;
  }
  let remoto = [];
  try {
    remoto = JSON.parse(r.corpo || "{}").envs || [];
  } catch {
    /* tratado abaixo */
  }
  const nomesRemotos = new Set(remoto.map((e) => e.key));
  const precisa = ENVS.filter((d) => d.obrigatoria);
  const faltamLa = precisa.filter((d) => !nomesRemotos.has(d.nome));
  const localTem = (d) => estadoDaEnv(d, env[d.nome]).estado === "ok";
  linha("| variavel | no projeto da Vercel | aqui |");
  linha("|---|---|---|");
  for (const d of ENVS) {
    linha(`| \`${d.nome}\` | ${nomesRemotos.has(d.nome) ? "sim" : "—"} | ${localTem(d) ? "sim" : "—"} |`);
  }
  linha("");
  if (!faltamLa.length) {
    passo("vercel", "ok", "todas as obrigatorias existem no projeto");
    linha("**ok** — todas as obrigatorias existem no projeto.");
    linha("");
    return;
  }
  const posso = faltamLa.filter(localTem);
  linha(`**Faltam no projeto:** ${faltamLa.map((d) => `\`${d.nome}\``).join(", ")}.`);
  linha("");
  if (!aplicar) {
    passo("vercel", "aviso", `${faltamLa.length} faltando no projeto (nada aplicado: modo padrao e conferencia)`);
    linha(
      posso.length
        ? `Este CLI consegue subir ${posso.length} delas (as que existem aqui) com \`--envs-vercel --valendo\`. As outras precisam do valor.`
        : "Nenhuma delas existe aqui, entao nao ha o que subir — defina o valor no ambiente antes."
    );
    linha("");
    return;
  }
  // ---- unico caminho de ESCRITA deste CLI ----
  let subiu = 0;
  const falhas = [];
  for (const d of posso) {
    const r2 = await pegar(`https://api.vercel.com/v10/projects/${projeto}/env${equipe}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        key: d.nome,
        value: env[d.nome],
        type: d.segredo ? "encrypted" : "plain",
        target: ["production", "preview", "development"],
      }),
    });
    if (r2.status === 200 || r2.status === 201) subiu++;
    else falhas.push(`${d.nome} (HTTP ${r2.status ?? "sem resposta"})`);
  }
  passo("vercel", falhas.length ? "erro" : "ok", `${subiu} env(s) criada(s)${falhas.length ? `, ${falhas.length} falharam` : ""}`);
  linha(`**${subiu} env(s) criada(s) no projeto.**${falhas.length ? ` Falharam: ${falhas.join(", ")}.` : ""}`);
  linha("");
  linha(
    "Env nova NAO alcanca o deploy que ja esta no ar: a Vercel injeta variavel no BUILD. Faca um deploy novo depois disto, senao o painel segue com os valores antigos e o instalador diz que esta tudo certo."
  );
  linha("");
}

// ————————————————————————————————————————————————————————— 6. smoke
async function passoSmoke(base) {
  linha("## 6. Smoke test da instalacao no ar");
  linha("");
  if (!base) {
    passo("smoke", "aviso", "nao rodado (sem --base)");
    linha("_pulado: rode com `--base https://sua-instalacao` depois do deploy._");
    linha("");
    return;
  }
  const raiz = base.replace(/\/+$/, "");
  linha("| rota | resultado | o que prova |");
  linha("|---|---|---|");
  let graves = 0;
  let falhas = 0;
  for (const p of SMOKE) {
    const r = await pegar(`${raiz}${p.rota}`, { method: p.metodo });
    const v = vereditoSmoke(p, r.status);
    if (!v.ok) falhas++;
    if (v.grave) graves++;
    linha(`| \`${p.rota}\` | ${v.ok ? "ok" : "FALHA"} — ${v.texto} | ${p.oQueProva} |`);
  }
  linha("");
  if (graves) {
    passo("smoke", "erro", `${graves} rota(s) respondendo 200 SEM LOGIN`);
    linha("**PARE.** Rota protegida respondendo 200 sem login e vazamento, nao 'diferente do esperado'.");
  } else if (falhas) {
    passo("smoke", "erro", `${falhas} rota(s) fora do esperado`);
    linha("**Alguma rota respondeu fora do esperado** — confira se o deploy terminou e se as envs entraram no build.");
  } else {
    passo("smoke", "ok", `${SMOKE.length} rotas conferidas`);
    linha("**ok** — o painel esta no ar e as rotas protegidas recusam quem nao tem login.");
  }
  linha("");
}

// ————————————————————————————————————————————————————————————————— prova
function prova() {
  let ok = 0;
  const t = (oque, fn) => {
    fn();
    ok++;
    console.log(`  ok  ${oque}`);
  };
  console.log("\nprova do instalador (decisao pura, nada tocado)");

  t("env vazia e env com espaco sao DIFERENTES de env ausente (o conserto e outro)", () => {
    const d = { nome: "X", obrigatoria: true };
    assert.equal(estadoDaEnv(d, undefined).estado, "ausente");
    assert.equal(estadoDaEnv(d, "").estado, "ausente");
    assert.equal(estadoDaEnv(d, "   ").estado, "vazia");
    assert.equal(estadoDaEnv(d, " valor ").estado, "com espaco nas pontas");
    assert.equal(estadoDaEnv(d, "valor").estado, "ok");
    // espaco na ponta e SEMPRE grave: falha ao autenticar e o erro nao diz isso
    assert.equal(estadoDaEnv({ nome: "X", obrigatoria: false }, " v ").grave, true);
  });

  t("faltar env obrigatoria impede subir; faltar opcional nao", () => {
    const defs = [
      { nome: "A", obrigatoria: true, oQueE: "a" },
      { nome: "B", obrigatoria: false, oQueE: "b" },
    ];
    assert.equal(conferirEnvs({ A: "1" }, defs).pode_subir, true);
    assert.equal(conferirEnvs({ B: "1" }, defs).pode_subir, false);
    assert.equal(conferirEnvs({ A: "1" }, defs).ok, 1);
  });

  t("VALOR de env nunca vai pro relatorio quando e segredo", () => {
    assert.equal(marcaDeValor("abcdef", true), "(6 caracteres, nao exibido)");
    assert.equal(marcaDeValor("abcdef", false), "abcdef");
    assert.equal(marcaDeValor("", true), "(vazio)");
    assert.equal(marcaDeValor("x".repeat(90), false).endsWith("..."), true);
    // e as envs marcadas como segredo cobrem as que sao segredo de fato
    for (const nome of ["MSG_SUPABASE_SERVICE_KEY", "CHATGURU_SYNC_SECRET", "WEBHOOK_KEY", "CENTRAL_ZAPI_TOKEN"]) {
      assert.equal(ENVS.find((e) => e.nome === nome)?.segredo, true, nome);
    }
    // chave anon e publica por natureza: marcar como segredo seria teatro
    assert.equal(ENVS.find((e) => e.nome === "NEXT_PUBLIC_AUTH_ANON_KEY")?.segredo, false);
  });

  t("A LACUNA DO NUMERO: canal extra ATIVO sem credencial e GRAVE, nao silencio", () => {
    const env = { CANAIS_EXTRA: JSON.stringify([{ id: "vendas", fonte: "zapi", ativo: true }]) };
    const { defs } = envsDosCanais(env);
    const doVendas = defs.filter((d) => d.canal === "vendas");
    assert.deepEqual(
      doVendas.map((d) => d.nome),
      ["ZAPI_VENDAS_INSTANCE_ID", "ZAPI_VENDAS_TOKEN"]
    );
    assert.equal(doVendas.every((d) => d.obrigatoria), true);
    // e o veredito geral das envs muda por causa disso — era o modo de falha:
    // "nenhuma obrigatoria faltando" com o segundo numero incapaz de ENVIAR
    const r = conferirEnvs(env, [{ nome: "A", obrigatoria: true, oQueE: "a" }]);
    assert.equal(r.pode_subir, false);
    assert.ok(r.faltando.some((f) => f.nome === "ZAPI_VENDAS_TOKEN"));
    // com as credenciais no lugar, passa
    const ok2 = conferirEnvs(
      { ...env, ZAPI_VENDAS_INSTANCE_ID: "i", ZAPI_VENDAS_TOKEN: "t" },
      [{ nome: "A", obrigatoria: false, oQueE: "a" }]
    );
    assert.equal(ok2.pode_subir, true);
  });

  t("canal ativo:false nao e cobrado (alarme falso), e fonte externa nao envia", () => {
    const env = {
      CANAIS_EXTRA: JSON.stringify([
        { id: "antigo", fonte: "zapi", ativo: false },
        { id: "insta", fonte: "instagram-agent", ativo: true },
      ]),
    };
    const { defs } = envsDosCanais(env);
    assert.equal(defs.every((d) => !d.obrigatoria), true, "canal desligado nao bloqueia");
    assert.equal(defs.some((d) => d.canal === "antigo"), true, "o canal desligado aparece, so nao e cobrado");
    // pelo CANAL, nao por pedaco do nome: "ZAPI_ANTIGO_INSTANCE_ID" contem "INSTA"
    assert.equal(defs.some((d) => d.canal === "insta"), false, "fonte externa e somente leitura: nao ha envio");
    assert.equal(conferirEnvs(env, []).pode_subir, true);
  });

  t("O CANAL BUILTIN TAMBEM E CONFERIDO: apioficial aparece na lista mesmo sem CANAIS_EXTRA", () => {
    // MEDIA 16 da re-revisao cega. `apioficial` e builtin e `ativo: true` em TODA
    // instalacao, mas as envs dele (GUPSHUP_APIOFICIAL_*) nao estao na lista fixa
    // `ENVS` — e a primeira versao derivava so de CANAIS_EXTRA. Resultado: o painel
    // OFERECIA envio pela API Oficial e o instalador dizia "nenhuma obrigatoria
    // faltando", sem citar a credencial em lugar nenhum.
    const nomes = conferirEnvs({}).linhas.map((l) => l.nome);
    for (const n of ["GUPSHUP_APIOFICIAL_API_KEY", "GUPSHUP_APIOFICIAL_SOURCE_NUMBER"]) {
      assert.ok(nomes.includes(n), `${n} nao e conferida por ninguem`);
    }
    // os dois builtin sao cobertos, cada um com o prefixo da SUA fonte
    for (const b of CANAIS_BUILTIN) {
      const p = prefixoDoCanal(b.id, b.fonte);
      assert.ok(nomes.some((n) => n.startsWith(p)), `${b.id} sem nenhuma env conferida`);
    }
    // NAO bloqueia a subida: `apioficial` tem fallback historico no banco, e uma
    // instalacao que so LE e valida. O ganho e a frase dizer onde olhar.
    assert.equal(conferirEnvs({}, []).pode_subir, true, "builtin sem credencial nao pode barrar a subida");
    const linha = conferirEnvs({}).linhas.find((l) => l.nome === "GUPSHUP_APIOFICIAL_API_KEY");
    assert.equal(linha.obrigatoria, false);
    assert.match(String(linha.oQueE), /fallback historico do banco \(public\.connectors\)/);
    assert.match(String(ressalvaDoBuiltin("central")), /RECEBE e nao ENVIA/);
    // DEDUPE: CENTRAL_ZAPI_* esta na lista fixa E vem do builtin `central`
    const centrais = nomes.filter((n) => n === "CENTRAL_ZAPI_TOKEN");
    assert.equal(centrais.length, 1, "env repetida na conferencia (lista fixa + builtin)");
    // e o segredo continua marcado no derivado
    assert.equal(conferirEnvs({}).linhas.find((l) => l.nome === "GUPSHUP_APIOFICIAL_API_KEY").segredo, true);
    assert.equal(linha.builtin, true, "a conferencia perdeu a marca de builtin (o relatorio nao avisa)");
    // e o DEDUPE FUNDE em vez de descartar (micro-check 31/08): a versao anterior
    // deixava a lista fixa vencer inteira, e com ela `CENTRAL_ZAPI_*` perdia
    // `canal`/`builtin` e saia da cobertura de canal — o passo 1 chegava a afirmar
    // "Credenciais de 1 canal(is): conferidas." com o canal PRINCIPAL vazio
    const central = conferirEnvs({}).linhas.find((l) => l.nome === "CENTRAL_ZAPI_TOKEN");
    assert.equal(central.canal, "central", "CENTRAL_ZAPI_TOKEN fora da cobertura de canal");
    assert.equal(central.builtin, true, "CENTRAL_ZAPI_TOKEN nao e reconhecida como builtin");
    // e o texto continua sendo o da lista FIXA (o dedupe funde, nao troca de dono)
    assert.match(String(central.oQueE), /token da instancia do canal central/);
  });

  t("A AFIRMACAO POSITIVA NAO MENTE: builtin vazio nunca sai como 'conferidas'", () => {
    // micro-check de 31/08/2026. O modo de falha nao era falta de aviso: era um aviso
    // POSITIVO e errado. Com `central` vazio e `apioficial` ok, o passo 1 dizia
    // "Credenciais de 1 canal(is): conferidas." — contando so o canal que estava ok,
    // porque o outro havia sido descartado no dedupe. Aqui se prova pelo DADO que o
    // relatorio le, nos tres estados que a frase distingue.
    const ok = { GUPSHUP_APIOFICIAL_API_KEY: "k", GUPSHUP_APIOFICIAL_SOURCE_NUMBER: "551199" };
    const vazios = (env) => {
      const doCanal = conferirEnvs(env).linhas.filter((l) => l.canal);
      return [...new Set(doCanal.filter((l) => l.builtin && l.estado !== "ok").map((l) => l.canal))].sort();
    };
    // (a) so o apioficial configurado: `central` TEM que aparecer como builtin vazio
    assert.deepEqual(vazios(ok), ["central"], "central vazio ficou invisivel pro relatorio");
    // (b) nada configurado: os dois aparecem
    assert.deepEqual(vazios({}), ["apioficial", "central"]);
    // (c) os dois configurados: a frase positiva fica LIVRE pra sair
    const tudo = { ...ok, CENTRAL_ZAPI_INSTANCE_ID: "i", CENTRAL_ZAPI_TOKEN: "t" };
    assert.deepEqual(vazios(tudo), [], "builtin ok ainda contado como vazio (a frase positiva nunca sairia)");
    // e nenhum desses estados barra a subida: builtin sem credencial e aviso, nao erro
    for (const env of [{}, ok, tudo]) assert.equal(conferirEnvs(env, []).pode_subir, true);
  });

  t("O ESPELHO NAO PODE DERIVAR: CANAIS_BUILTIN conferido contra lib/canais.ts", () => {
    // `CANAIS_BUILTIN` aqui e copia declarada de lib/canais.ts (importar de la criaria
    // ciclo — o proprio `envioDisponivel` registra isso). Copia sem guarda envelhece
    // calada: canal builtin novo no painel, e o instalador continua conferindo dois.
    // Esta prova LE o arquivo de origem — nao edita nada dele.
    const fonte = fs.readFileSync(new URL("../../lib/canais.ts", import.meta.url), "utf8");
    const bloco = fonte.match(/const CANAIS_BUILTIN: CanalDef\[\] = \[([\s\S]*?)\n\];/);
    assert.ok(bloco, "nao achei CANAIS_BUILTIN em lib/canais.ts (o espelho ficou sem guarda)");
    const doPainel = bloco[1]
      .split(/\n\s*\{/)
      .slice(1)
      .map((pedaco) => ({
        id: (pedaco.match(/\bid:\s*"([^"]+)"/) || [])[1],
        fonte: (pedaco.match(/\bfonte:\s*"([^"]+)"/) || [])[1],
        ativo: /\bativo:\s*true/.test(pedaco),
      }));
    assert.ok(doPainel.length > 0, "leitura de lib/canais.ts nao devolveu canal nenhum");
    const chave = (c) => `${c.id}/${c.fonte}/${c.ativo ? "ativo" : "inativo"}`;
    assert.deepEqual(
      CANAIS_BUILTIN.map(chave).sort(),
      doPainel.map(chave).sort(),
      "CANAIS_BUILTIN saiu de sincronia com lib/canais.ts — canal builtin entra nos DOIS lugares"
    );
    // e cada fonte usada precisa ter credencial declarada, senao o canal novo entra
    // no espelho e a conferencia dele nasce vazia sem ninguem notar
    for (const c of CANAIS_BUILTIN) {
      assert.ok(
        Array.isArray(CREDENCIAL_POR_FONTE[c.fonte]) && CREDENCIAL_POR_FONTE[c.fonte].length > 0,
        `fonte "${c.fonte}" sem credencial declarada em CREDENCIAL_POR_FONTE`
      );
    }
  });

  t("prefixo por fonte espelha lib/canais.ts, e `central` e a excecao historica", () => {
    assert.equal(prefixoDoCanal("central", "zapi"), "CENTRAL_ZAPI_");
    assert.equal(prefixoDoCanal("vendas", "zapi"), "ZAPI_VENDAS_");
    assert.equal(prefixoDoCanal("oficial2", "gupshup"), "GUPSHUP_OFICIAL2_");
    assert.equal(prefixoDoCanal("evo", "evolution"), "EVOLUTION_EVO_");
    assert.equal(prefixoDoCanal("x", "instagram-agent"), null);
    // as tres fontes que ENVIAM tem lista de credencial, e nenhuma esta vazia
    for (const [fonte, sufixos] of Object.entries(CREDENCIAL_POR_FONTE)) {
      assert.ok(sufixos.length >= 2, fonte);
    }
  });

  t("CANAIS_EXTRA torto vira PROBLEMA declarado (o painel ignora o canal calado)", () => {
    assert.match(String(envsDosCanais({ CANAIS_EXTRA: "{nao json" }).problemas[0]), /nao e JSON valido/);
    assert.match(String(envsDosCanais({ CANAIS_EXTRA: '{"id":"x"}' }).problemas[0]), /nao e uma lista/);
    assert.match(
      String(envsDosCanais({ CANAIS_EXTRA: '[{"fonte":"zapi"}]' }).problemas[0]),
      /sem .id. ou sem .fonte./
    );
    assert.deepEqual(envsDosCanais({}).problemas, [], "sem CANAIS_EXTRA nao ha problema nenhum");
    // sem CANAIS_EXTRA sobram SO os builtin, e nenhum deles bloqueia a subida
    assert.equal(envsDosCanais({}).defs.every((d) => d.builtin === true && !d.obrigatoria), true);
    // e o problema chega em conferirEnvs, que e o que a tela do CLI le
    assert.equal(conferirEnvs({ CANAIS_EXTRA: "{nao json" }, []).problemas_de_canal.length, 1);
  });

  t("nome de migration: aceita o padrao da casa e recusa o resto", () => {
    assert.deepEqual(lerNomeDeMigration("0013_relatorios.sql"), { numero: 13, rotulo: "relatorios", arquivo: "0013_relatorios.sql" });
    assert.equal(lerNomeDeMigration("readme.md"), null);
    assert.equal(lerNomeDeMigration("13_x.sql"), null);
    assert.equal(lerNomeDeMigration(""), null);
    assert.equal(lerNomeDeMigration(undefined), null);
  });

  t("objetos da migration saem do SQL (lista escrita a mao envelhece calada)", () => {
    const sql = `
      create table if not exists mensageria.zap (id uuid);
      create table if not exists mensageria.zap (id uuid);
      alter table mensageria.perfis add column if not exists papel_id uuid;
      create or replace function mensageria.definir_contexto(p_canal text) returns jsonb as $$ $$;
      create function mensageria.outra() returns void as $$ $$;
      create table publico.fora (id int);
    `;
    const o = objetosDaMigration(sql);
    assert.deepEqual(o.tabelas, ["zap"], "tabela repetida entra uma vez; tabela fora do schema nao entra");
    assert.deepEqual(o.colunas, [{ tabela: "perfis", coluna: "papel_id" }]);
    assert.deepEqual(o.funcoes, ["definir_contexto", "outra"]);
    assert.deepEqual(objetosDaMigration("").tabelas, []);
    assert.deepEqual(objetosDaMigration(null).funcoes, []);
  });

  t("O ESTADO QUE IMPORTA: migration PELA METADE nao se esconde em 'aplicada'", () => {
    const o = { tabelas: ["a"], colunas: [{ tabela: "a", coluna: "nova" }], funcoes: [] };
    assert.equal(vereditoDaMigration(o, { tabelas: { a: true }, colunas: { "a.nova": true } }).estado, "aplicada");
    assert.equal(vereditoDaMigration(o, { tabelas: { a: false }, colunas: {} }).estado, "ausente");
    const parcial = vereditoDaMigration(o, { tabelas: { a: true }, colunas: { "a.nova": false } });
    assert.equal(parcial.estado, "PARCIAL");
    assert.deepEqual(parcial.faltando, ["coluna a.nova"]);
  });

  t("migration que so cria funcao sai 'nao verificavel', nunca 'aplicada'", () => {
    const v = vereditoDaMigration({ tabelas: [], colunas: [], funcoes: ["f"] }, { tabelas: {}, colunas: {} });
    assert.equal(v.estado, "nao verificavel");
    assert.match(v.detalhe, /executa-la/);
    // e sem sonda nenhuma nada vira "aplicada" por otimismo
    assert.equal(vereditoDaMigration({ tabelas: ["a"], colunas: [], funcoes: [] }, {}).estado, "sem objeto probavel");
  });

  t("a fila de migrations sai em ORDEM e nao pula buraco", () => {
    const avaliadas = [
      { numero: 19, arquivo: "0019_a.sql", veredito: { estado: "aplicada", faltando: [] } },
      { numero: 18, arquivo: "0018_b.sql", veredito: { estado: "ausente", faltando: ["tabela x"] } },
      { numero: 13, arquivo: "0013_c.sql", veredito: { estado: "nao verificavel", faltando: [] } },
      { numero: 20, arquivo: "0020_d.sql", veredito: { estado: "PARCIAL", faltando: ["coluna y.z"] } },
    ];
    const fila = filaDeMigrations(avaliadas);
    assert.deepEqual(fila.map((f) => f.numero), [13, 18, 20], "ordem numerica, e a 19 aplicada fica fora");
    assert.equal(fila.find((f) => f.numero === 13).bloqueia, false, "so-funcao nao bloqueia, mas aparece");
    assert.equal(fila.find((f) => f.numero === 18).bloqueia, true);
    assert.match(fila.find((f) => f.numero === 20).motivo, /PELA METADE/);
    assert.match(fila[0].caminho, /^supabase\/migrations\//);
  });

  t("SQL do cron NAO carrega o segredo: ele le de dentro do banco", () => {
    const sql = sqlDoJob(JOBS_CRON[0], "https://painel.exemplo.com/");
    assert.match(sql, /cron\.schedule\('expert_chat_vigia'/);
    assert.match(sql, /from mensageria\.config where chave = 'tick_bearer'/);
    assert.equal(sql.includes("Bearer sk"), false);
    // a barra final da base nao pode virar barra dupla na URL
    assert.match(sql, /url := 'https:\/\/painel\.exemplo\.com\/api\/vigia'/);
    assert.equal(sql.includes("//api/vigia"), false);
  });

  t("job de modulo desligado nao entra na lista (rodaria pra nada)", () => {
    assert.deepEqual(jobsNecessarios({}).map((j) => j.nome), [
      "expert_chat_vigia",
      "expert_chat_tick_agendadas",
      "expert_chat_tick_sla",
    ]);
    assert.equal(jobsNecessarios({ disparo: true, automacao: true }).length, JOBS_CRON.length);
    assert.equal(jobsNecessarios(null).length, 3, "modulos ilegivel = nenhum modulo ligado");
    // todo job diz o que para de funcionar sem ele
    for (const j of JOBS_CRON) assert.ok(j.semEle.length > 15, j.nome);
  });

  t("A GUARDA DO SMOKE: 200 onde se espera 401 e VAZAMENTO, nao 'inesperado'", () => {
    const protegida = SMOKE.find((s) => s.rota === "/api/chats");
    const v = vereditoSmoke(protegida, 200);
    assert.equal(v.ok, false);
    assert.equal(v.grave, true);
    assert.match(v.texto, /SEM LOGIN/);
    assert.equal(vereditoSmoke(protegida, 401).ok, true);
    assert.equal(vereditoSmoke(protegida, 500).grave, false, "500 e falha, nao vazamento");
    assert.equal(vereditoSmoke(protegida, null).ok, false);
    // e a raiz, onde 200 E o esperado, nao vira vazamento
    assert.equal(vereditoSmoke(SMOKE[0], 200).ok, true);
    // nenhuma rota protegida do smoke aceita 200
    for (const s of SMOKE.filter((x) => x.rota.startsWith("/api/"))) {
      assert.equal(s.esperado.includes(200), false, `${s.rota} aceita 200`);
    }
  });

  t("veredito geral: erro manda, aviso nao vira erro, e nada vira 'pronta' por otimismo", () => {
    assert.equal(vereditoGeral([]).estado, "PRONTA");
    assert.equal(vereditoGeral([{ nome: "a", estado: "ok" }]).estado, "PRONTA");
    assert.equal(vereditoGeral([{ nome: "a", estado: "aviso" }]).estado, "PRONTA COM RESSALVA");
    const g = vereditoGeral([{ nome: "a", estado: "aviso" }, { nome: "b", estado: "erro" }]);
    assert.equal(g.estado, "NAO PRONTA");
    assert.equal(g.graves.length, 1);
    assert.equal(g.avisos.length, 1);
  });

  console.log(`\nTUDO OK — ${ok} blocos, nenhuma rede e nenhum banco tocados.`);
}

// ————————————————————————————————————————————————————————————————— CLI
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--prova")) {
    prova();
    return;
  }
  if (argv.includes("--ajuda") || argv.includes("-h")) {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 30).join("\n").replace(/^\/\/ ?/gm, ""));
    return;
  }
  const iBase = argv.indexOf("--base");
  const base = iBase >= 0 ? argv[iBase + 1] : null;
  const iLog = argv.indexOf("--log");
  const log = iLog >= 0 ? argv[iLog + 1] : null;
  const querVercel = argv.includes("--envs-vercel");
  const valendo = argv.includes("--valendo");
  const env = process.env;

  linha(`# Instalacao do Expert Chat — conferencia de ${new Date().toISOString()}`);
  linha("");
  linha(
    valendo && querVercel
      ? "> Modo `--valendo`: as envs que faltam no projeto da Vercel SERAO criadas. Banco, DDL e pg_cron seguem sem caminho de escrita."
      : "> Modo conferencia (padrao): **nada e alterado em lugar nenhum**."
  );
  linha("");

  const envs = passoEnvs(env);
  const conexao = envs.pode_subir ? await passoConexao(env) : (linha("## 2. A credencial abre o banco?\n"), linha("_pulado: resolva o passo 1 primeiro._\n"), null);
  const migrations = lerMigrations();
  const sonda = await sondar(conexao, migrations);
  passoMigrations(migrations, sonda, conexao);
  await passoCron(env, conexao, base);
  if (querVercel) await passoVercel(env, valendo);
  else {
    linha("## 5. Variaveis no projeto da Vercel");
    linha("");
    linha("_pulado: rode com `--envs-vercel` (conferencia) ou `--envs-vercel --valendo` (aplica o que falta)._");
    linha("");
  }
  await passoSmoke(base);

  const geral = vereditoGeral(passos);
  linha("## Veredito");
  linha("");
  linha(`**${geral.estado}** — ${geral.resumo}.`);
  linha("");
  linha("| passo | estado | detalhe |");
  linha("|---|---|---|");
  for (const p of passos) linha(`| ${p.nome} | ${p.estado} | ${p.detalhe} |`);
  linha("");
  linha("Gestos que seguem sendo HUMANOS, por desenho: rodar as migrations no SQL Editor, gravar o bearer no banco, criar os jobs do pg_cron e criar o primeiro super admin. Ver `docs/instalacao.md`.");

  if (log) {
    fs.writeFileSync(log, L.join("\n") + "\n", "utf8");
    console.log(`\nrelatorio gravado em ${log}`);
  }
  // CLI que fala HTTP nao termina com process.exit(): ele cortaria a escrita em voo
  process.exitCode = geral.estado === "NAO PRONTA" ? 1 : 0;
}

main();
