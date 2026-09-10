// INSTALADOR ASSISTIDO — o miolo PURO (card 86ak8b5xb).
//
// Este arquivo nao le disco, nao fala rede e nao importa nada: recebe dado e
// devolve decisao, pra tudo poder ser provado sem instalacao nenhuma
// (`node scripts/instalar/index.mjs --prova`). O I/O mora no index.mjs.
//
// ————————————————————————————————————————————————————————————————————————
// A DECISAO QUE DEFINE ESTE INSTALADOR: ele NAO roda DDL.
//
// O card pede "roda migrations 0001-0024 com prova". A regra-mae do repo diz o
// contrario, e ela ganha: **codigo nunca cria tabela — migration e gesto humano no
// SQL Editor**. Nao e formalidade. Um instalador que executa DDL com a
// service_role guardada num CLI:
//   - faz `drop function` e `alter column set default` num banco de PRODUCAO do
//     cliente sem ninguem olhando a saida;
//   - transforma "rodei o instalador" em "alguem, em algum momento, aplicou algo"
//     — e migration aplicada pela metade e o pior estado possivel (a rota degrada,
//     o dono acha que instalou);
//   - exige a service_role no ambiente de quem instala, que e exatamente a chave
//     que nao deveria sair do painel.
//
// O que ele faz no lugar, e o que o card realmente precisa: **PROVA de estado**.
// Ele descobre, por leitura, quais migrations ja estao aplicadas, e entrega a lista
// ORDENADA do que falta, com caminho de arquivo, pra colar no SQL Editor. Depois
// re-checa. A "prova" do card e isso: antes e depois medidos, nao um "ok" de log.
//
// Vale o mesmo pros jobs de pg_cron: o SQL sai pronto pra colar, com o segredo
// lido DE DENTRO do banco (nunca digitado no CLI), porque `cron.schedule` guarda
// o comando em texto e um bearer digitado ali fica gravado no catalogo.
//
// ————————————————————————————————————————————————————————————————————————
// `--dry` E O DEFAULT, e o unico passo que aceita `--valendo` e o das envs da
// Vercel (efeito externo reversivel, em ferramenta nossa). Banco, DDL e cron nao
// tem caminho de escrita neste CLI — nao e "ainda nao implementado", e desenho.

// ————————————————————————————————————————————————————————————————————— envs
//
// Lista MEDIDA por varredura de `process.env` no repo (31/08/2026), classificada
// pelo que a instalacao quebra sem ela. `obrigatoria` = o painel nao sobe ou nao
// autentica; o resto tem fabrica ou desliga um recurso.
export const ENVS = [
  { nome: "MSG_SUPABASE_URL", obrigatoria: true, oQueE: "URL do projeto Supabase que guarda as conversas.", segredo: false },
  { nome: "MSG_SUPABASE_SERVICE_KEY", obrigatoria: true, oQueE: "service_role do MESMO projeto. Nunca vai pro navegador.", segredo: true },
  { nome: "NEXT_PUBLIC_AUTH_URL", obrigatoria: true, oQueE: "URL do Supabase que faz o LOGIN (pode ser o mesmo projeto).", segredo: false },
  { nome: "NEXT_PUBLIC_AUTH_ANON_KEY", obrigatoria: true, oQueE: "chave anon do projeto de login. Publica por natureza.", segredo: false },
  { nome: "CHATGURU_SYNC_SECRET", obrigatoria: true, oQueE: "bearer dos ticks (vigia, disparo, agendadas, fluxos, SLA). Sem ele nenhuma rotina roda.", segredo: true },
  { nome: "WEBHOOK_KEY", obrigatoria: true, oQueE: "chave do webhook de ENTRADA (?key=). Sem ela o painel nao recebe mensagem.", segredo: true },
  { nome: "NEXT_PUBLIC_NOME_PAINEL", obrigatoria: false, oQueE: "nome que aparece na tela. Sem isso fica o nome de fabrica.", segredo: false },
  { nome: "FUSO_INSTALACAO", obrigatoria: false, oQueE: "fuso dos relatorios (ex: America/Sao_Paulo). Fabrica: ver lib/fuso.ts.", segredo: false },
  { nome: "MODULOS", obrigatoria: false, oQueE: 'JSON de modulos, ex {"automacao":true}. Fabrica: automacao e disparo DESLIGADOS.', segredo: false },
  { nome: "CANAL_CENTRAL_IDENTIDADE", obrigatoria: false, oQueE: "numero/identidade do canal principal, so pra exibicao.", segredo: false },
  { nome: "CENTRAL_ZAPI_INSTANCE_ID", obrigatoria: false, oQueE: "instancia do provedor do canal central. Sem ela o canal nao ENVIA.", segredo: false },
  { nome: "CENTRAL_ZAPI_TOKEN", obrigatoria: false, oQueE: "token da instancia do canal central.", segredo: true },
  { nome: "CENTRAL_ZAPI_CLIENT_TOKEN", obrigatoria: false, oQueE: "client-token da conta do provedor.", segredo: true },
  { nome: "CANAIS_EXTRA", obrigatoria: false, oQueE: "JSON de canais adicionais (API oficial, 2o numero, canal do WhatsApp Agent).", segredo: false },
  { nome: "WA_MCP_URL", obrigatoria: false, oQueE: "mcp-api do WhatsApp Agent (canal fonte whatsapp-agent). Sem ela o canal do agente e so leitura.", segredo: false },
  { nome: "WA_MCP_KEY", obrigatoria: false, oQueE: "MCP_API_KEY do agente. Sem ela o canal do agente e so leitura.", segredo: true },
  { nome: "MSG_STORAGE_BUCKET", obrigatoria: false, oQueE: "bucket de midia. Sem ele a midia nao e re-hospedada.", segredo: false },
  { nome: "EMBED_JWT_SECRET", obrigatoria: false, oQueE: "segredo do widget embutido. So se a instalacao usa embed.", segredo: true },
  { nome: "EMBED_MINT_SECRET", obrigatoria: false, oQueE: "segredo pra emitir contexto do embed.", segredo: true },
  { nome: "PIPEDRIVE_API_TOKEN", obrigatoria: false, oQueE: "token do CRM. Sem ele a fonte 'filtro do Pipedrive' fica invisivel no disparo.", segredo: true },
  { nome: "VIGIA_ALERTAS", obrigatoria: false, oQueE: "destino dos alertas do vigia.", segredo: false },
];

// ————————————————————————————————————————————— envs DOS CANAIS DECLARADOS
//
// A METADE DO "PLUGAR NUMERO" QUE FALTAVA (achado da revisao cega, 31/08/2026).
// A lista `ENVS` acima e fixa e so conhece o canal `central`. Uma instalacao com um
// segundo numero declara o canal em `CANAIS_EXTRA` (JSON) e as credenciais dele vao
// em envs com PREFIXO derivado do id — `ZAPI_<ID>_TOKEN`, `GUPSHUP_<ID>_API_KEY`...
// Sem derivar isso, o instalador dizia "nenhuma obrigatoria faltando" com o segundo
// canal SEM credencial: ele aparece na tela, recebe mensagem e **nao envia**, calado.
//
// A convencao de prefixo e espelho de `envioDisponivel` em lib/canais.ts — mudou la,
// muda aqui. Copiada em vez de importada de proposito: este arquivo nao importa nada
// (e `lib/canais.ts` e do dono da Frente U, fora do alcance desta frente).
export const CREDENCIAL_POR_FONTE = {
  zapi: ["INSTANCE_ID", "TOKEN"],
  gupshup: ["API_KEY", "SOURCE_NUMBER"],
  evolution: ["BASE_URL", "INSTANCE_ID", "API_KEY"],
};

// Os canais BUILT-IN, que existem em TODA instalacao (espelho de CANAIS_BUILTIN em
// lib/canais.ts). Entraram aqui na re-revisao cega de 31/08/2026: a primeira versao
// derivava so de `CANAIS_EXTRA`, e por isso `apioficial` — builtin, `ativo: true`
// sempre — nao era conferido por NINGUEM. `GUPSHUP_APIOFICIAL_API_KEY` e
// `_SOURCE_NUMBER` nao estao na lista fixa `ENVS`, entao o instalador dizia "nenhuma
// obrigatoria faltando" numa instalacao onde a API Oficial aparece na tela de envio.
//
// `obrigatoria: false` nos dois, e por motivos DIFERENTES:
//  - `central`: o painel sobe e RECEBE sem credencial de envio (e a instalacao que
//    so le ainda e valida);
//  - `apioficial`: `envioDisponivel` tem fallback historico no banco
//    (`public.connectors`), entao a env faltando NAO prova que o envio esta quebrado.
//    O que se ganha aqui e a env aparecer na conferencia com a frase que diz onde
//    olhar — antes ela nao aparecia de forma alguma.
export const CANAIS_BUILTIN = [
  { id: "central", fonte: "zapi", ativo: true },
  { id: "apioficial", fonte: "gupshup", ativo: true },
];

/** A frase que explica por que a env do builtin nao e obrigatoria. PURA. */
export function ressalvaDoBuiltin(id) {
  if (id === "apioficial") {
    return 'canal builtin "apioficial" (gupshup). Sem esta env o envio cai no fallback historico do banco (public.connectors) — confira ali antes de concluir que esta quebrado.';
  }
  return `canal builtin "${id}". Sem esta env o canal RECEBE e nao ENVIA.`;
}

/** Prefixo das envs de um canal. PURA. `central` e a excecao historica. */
export function prefixoDoCanal(id, fonte) {
  if (fonte === "zapi") return id === "central" ? "CENTRAL_ZAPI_" : `ZAPI_${String(id).toUpperCase()}_`;
  if (fonte === "gupshup") return `GUPSHUP_${String(id).toUpperCase()}_`;
  if (fonte === "evolution") return `EVOLUTION_${String(id).toUpperCase()}_`;
  return null;
}

/**
 * As envs que os canais DECLARADOS nesta instalacao exigem. PURA.
 *
 * Canal `ativo: false` entra como NAO obrigatorio: ele esta desligado de proposito,
 * e cobrar credencial de canal desligado e alarme falso. Canal ATIVO sem credencial
 * e grave — e o modo de falha silencioso que motivou isto.
 *
 * `CANAIS_EXTRA` ilegivel nao derruba nada (mesmo comportamento de lib/canais.ts):
 * devolve a lacuna como aviso proprio, porque JSON torto ali faz o painel ignorar o
 * canal inteiro sem dizer.
 */
export function envsDosCanais(env) {
  const defs = [];
  const problemas = [];
  // 1) os builtin, que existem sempre (nao dependem de CANAIS_EXTRA)
  for (const b of CANAIS_BUILTIN) {
    const p = prefixoDoCanal(b.id, b.fonte);
    for (const sufixo of CREDENCIAL_POR_FONTE[b.fonte]) {
      defs.push({
        nome: p + sufixo,
        obrigatoria: false,
        oQueE: ressalvaDoBuiltin(b.id),
        segredo: /TOKEN|API_KEY/.test(sufixo),
        canal: b.id,
        builtin: true,
      });
    }
  }
  // 2) os declarados em CANAIS_EXTRA
  let extra = [];
  const raw = env?.CANAIS_EXTRA;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) extra = arr;
      else problemas.push("CANAIS_EXTRA nao e uma lista JSON — o painel ignora TODOS os canais extra");
    } catch {
      problemas.push("CANAIS_EXTRA nao e JSON valido — o painel ignora TODOS os canais extra, calado");
    }
  }
  for (const c of extra) {
    const id = typeof c?.id === "string" ? c.id.trim() : "";
    const fonte = typeof c?.fonte === "string" ? c.fonte.trim() : "";
    if (!id || !fonte) {
      problemas.push("canal em CANAIS_EXTRA sem `id` ou sem `fonte` — o painel descarta esse canal");
      continue;
    }
    const ativo = c?.ativo === true;
    // canal do WhatsApp Agent envia pela mcp-api: as duas envs sao GLOBAIS (nao
    // tem prefixo por canal) e ficam obrigatorias quando o canal esta ativo
    if (fonte === "whatsapp-agent") {
      for (const nome of ["WA_MCP_URL", "WA_MCP_KEY"]) {
        defs.push({ nome, obrigatoria: ativo, oQueE: ativo ? `envio do canal "${id}" pela mcp-api do agente. Sem ela o canal APARECE e NAO ENVIA.` : `envio do canal "${id}", que esta ativo:false — nao cobrada.`, segredo: nome === "WA_MCP_KEY", canal: id });
      }
      continue;
    }
    // fonte externa instagram-agent e SOMENTE LEITURA: nao envia, entao nao
    // tem credencial de envio pra cobrar
    if (!(fonte in CREDENCIAL_POR_FONTE)) continue;
    const p = prefixoDoCanal(id, fonte);
    for (const sufixo of CREDENCIAL_POR_FONTE[fonte]) {
      defs.push({
        nome: p + sufixo,
        obrigatoria: ativo,
        oQueE: ativo
          ? `credencial do canal "${id}" (${fonte}). Sem ela o canal APARECE e NAO ENVIA, sem erro na tela.`
          : `credencial do canal "${id}" (${fonte}), que esta ativo:false — nao cobrada.`,
        segredo: /TOKEN|API_KEY/.test(sufixo),
        canal: id,
      });
    }
  }
  return { defs, problemas };
}

/**
 * Estado de UMA env. PURA.
 *
 * "definida" nao e "!== undefined": env com string vazia e o erro classico de
 * painel de deploy (a variavel existe, o valor nao), e ela quebra igual a ausente
 * — precisa aparecer diferente de "faltando", porque o conserto e outro.
 */
export function estadoDaEnv(def, valor) {
  const bruto = typeof valor === "string" ? valor : valor === undefined || valor === null ? "" : String(valor);
  const v = bruto.trim();
  if (!bruto) return { nome: def.nome, estado: "ausente", grave: def.obrigatoria };
  if (!v) return { nome: def.nome, estado: "vazia", grave: def.obrigatoria };
  if (bruto !== v) return { nome: def.nome, estado: "com espaco nas pontas", grave: true, tamanho: bruto.length };
  return { nome: def.nome, estado: "ok", grave: false, tamanho: v.length };
}

/**
 * As envs do ambiente, classificadas. PURA. Valor NENHUM aparece na saida.
 *
 * A lista fixa e SOMADA as envs dos canais (builtin + `CANAIS_EXTRA`) — sem isso o
 * segundo numero passa como "nada faltando" e nao envia (ver `envsDosCanais`).
 *
 * DEDUPE por nome, com a lista FIXA vencendo NO TEXTO: `CENTRAL_ZAPI_*` esta nos dois
 * lugares (escrita a mao em `ENVS` e derivada do builtin `central`), e sem dedupe a
 * conferencia imprimiria a mesma env duas vezes com frases diferentes.
 *
 * Mas dedupe DESCARTANDO a def derivada mentia (micro-check de 31/08/2026): junto com
 * a linha repetida ia embora o `canal`/`builtin` que so a derivada carrega, e
 * `CENTRAL_ZAPI_*` saia da cobertura de canal inteira. Com o `central` vazio e o
 * `apioficial` ok, o passo 1 imprimia "Credenciais de 1 canal(is): conferidas." — uma
 * afirmacao POSITIVA e errada, no canal principal da instalacao. Agora o dedupe
 * FUNDE: texto e obrigatoriedade da lista fixa, `canal`/`builtin` da derivada.
 */
export function conferirEnvs(env, defs = ENVS) {
  const canais = envsDosCanais(env);
  const derivada = new Map(canais.defs.map((d) => [d.nome, d]));
  const jaTem = new Set(defs.map((d) => d.nome));
  const todas = [
    ...defs.map((d) => {
      const dela = derivada.get(d.nome);
      if (!dela) return d;
      return { ...d, canal: d.canal ?? dela.canal, builtin: d.builtin ?? dela.builtin };
    }),
    ...canais.defs.filter((d) => !jaTem.has(d.nome)),
  ];
  const linhas = todas.map((d) => ({
    ...estadoDaEnv(d, env?.[d.nome]),
    obrigatoria: d.obrigatoria,
    oQueE: d.oQueE,
    segredo: d.segredo,
    canal: d.canal,
    builtin: d.builtin === true,
  }));
  return {
    linhas,
    problemas_de_canal: canais.problemas,
    faltando: linhas.filter((l) => l.grave),
    ok: linhas.filter((l) => l.estado === "ok").length,
    // env com espaco na ponta e sempre grave, obrigatoria ou nao: ela FALHA na
    // hora de assinar/autenticar e o erro nao diz isso em lugar nenhum
    pode_subir: linhas.filter((l) => l.grave).length === 0,
  };
}

// ———————————————————————————————————————————————————————————— migrations
//
// A lista NAO e escrita a mao: vem dos arquivos de supabase/migrations. Lista
// escrita a mao envelhece calada — a migration 21 nasce e o instalador continua
// jurando que a instalacao esta completa.

/** Numero e nome de um arquivo de migration. PURA. `null` = nao e migration. */
export function lerNomeDeMigration(arquivo) {
  const m = /^(\d{4})_([a-z0-9_]+)\.sql$/i.exec(String(arquivo || ""));
  if (!m) return null;
  return { numero: Number(m[1]), rotulo: m[2], arquivo: String(arquivo) };
}

/**
 * O que UMA migration cria, extraido do SQL. PURA.
 *
 * Serve pra PROVAR estado por leitura: tabela e coluna sao probaveis pelo
 * PostgREST sem executar nada. Funcao NAO e — probar funcao exigiria chama-la, e
 * chamar funcao de relatorio num banco de producao e leitura pesada por
 * curiosidade. Entao funcao entra na contagem e sai declarada como nao verificada:
 * um relatorio que diz "verifiquei o que da" vale mais que um que finge cobertura.
 */
export function objetosDaMigration(sql) {
  const s = String(sql || "");
  const tabelas = [];
  const colunas = [];
  const funcoes = [];
  const reTab = /create\s+table\s+if\s+not\s+exists\s+mensageria\.([a-z0-9_]+)/gi;
  for (let m; (m = reTab.exec(s)); ) if (!tabelas.includes(m[1])) tabelas.push(m[1]);
  // `alter table X add column if not exists Y tipo` — o jeito que a casa adiciona
  const reCol = /alter\s+table\s+(?:only\s+)?mensageria\.([a-z0-9_]+)\s+add\s+column\s+if\s+not\s+exists\s+([a-z0-9_]+)/gi;
  for (let m; (m = reCol.exec(s)); ) colunas.push({ tabela: m[1], coluna: m[2] });
  const reFn = /create\s+(?:or\s+replace\s+)?function\s+mensageria\.([a-z0-9_]+)\s*\(/gi;
  for (let m; (m = reFn.exec(s)); ) if (!funcoes.includes(m[1])) funcoes.push(m[1]);
  return { tabelas, colunas, funcoes };
}

/**
 * Veredito de UMA migration a partir do que a sonda achou. PURA.
 *
 * Tres estados, e o terceiro e o que importa: PARCIAL. Migration meio aplicada
 * (tabela criada, coluna nova nao) e o estado que faz a rota degradar em silencio,
 * e "aplicada / nao aplicada" nao tem onde por isso. Quem instala precisa ver
 * PARCIAL na cara pra ir olhar.
 */
export function vereditoDaMigration(objetos, sonda) {
  const alvos = [
    ...objetos.tabelas.map((t) => ({ chave: `tabela ${t}`, presente: sonda?.tabelas?.[t] })),
    ...objetos.colunas.map((c) => ({ chave: `coluna ${c.tabela}.${c.coluna}`, presente: sonda?.colunas?.[`${c.tabela}.${c.coluna}`] })),
  ];
  const verificaveis = alvos.filter((a) => a.presente !== undefined);
  const presentes = verificaveis.filter((a) => a.presente === true);
  const ausentes = verificaveis.filter((a) => a.presente === false);
  if (!verificaveis.length) {
    return {
      estado: objetos.funcoes.length ? "nao verificavel" : "sem objeto probavel",
      detalhe: objetos.funcoes.length
        ? `so cria funcao (${objetos.funcoes.length}): checar funcao exigiria executa-la`
        : "nada probavel por leitura neste arquivo",
      faltando: [],
    };
  }
  if (!ausentes.length) return { estado: "aplicada", detalhe: `${presentes.length} objeto(s) conferido(s)`, faltando: [] };
  if (!presentes.length) return { estado: "ausente", detalhe: `${ausentes.length} objeto(s) nao existem`, faltando: ausentes.map((a) => a.chave) };
  return {
    estado: "PARCIAL",
    detalhe: `${presentes.length} presente(s) e ${ausentes.length} faltando — migration aplicada pela metade`,
    faltando: ausentes.map((a) => a.chave),
  };
}

/**
 * A fila do que colar no SQL Editor, em ordem. PURA.
 *
 * Ordem NUMERICA sempre, e sem pular buraco: se a 0018 falta e a 0019 esta
 * aplicada, as duas entram na lista (a 0018 primeiro), porque aplicar fora de
 * ordem e o que produz o erro que ninguem entende depois. Migration nao
 * verificavel entra como "confira" — nunca sai da lista calada.
 */
export function filaDeMigrations(avaliadas) {
  const pendentes = avaliadas
    .filter((a) => a.veredito.estado === "ausente" || a.veredito.estado === "PARCIAL" || a.veredito.estado === "nao verificavel")
    .sort((a, b) => a.numero - b.numero);
  return pendentes.map((a) => ({
    arquivo: a.arquivo,
    numero: a.numero,
    caminho: `supabase/migrations/${a.arquivo}`,
    motivo:
      a.veredito.estado === "nao verificavel"
        ? "confira manualmente (so cria funcao)"
        : a.veredito.estado === "PARCIAL"
          ? `APLICADA PELA METADE: falta ${a.veredito.faltando.join(", ")}`
          : "nao aplicada",
    bloqueia: a.veredito.estado !== "nao verificavel",
  }));
}

// ——————————————————————————————————————————————————————————————— pg_cron
//
// Os jobs que a instalacao precisa, e o que cada um deixa de funcionar sem ele.
// Derivado das rotas que existem no repo (app/api/cron-*, /api/vigia,
// /api/relatorios/sla) — todas autenticam pelo MESMO bearer
// (`CHATGURU_SYNC_SECRET`), o que e o motivo de o segredo ser lido de dentro do
// banco em vez de digitado: um bearer errado num job faz a rotina falhar com 401
// pra sempre, e ninguem olha o retorno de um cron.
export const JOBS_CRON = [
  { nome: "expert_chat_vigia", rota: "/api/vigia", cron: "*/10 * * * *", semEle: "ninguem e avisado quando um canal cai." },
  { nome: "expert_chat_tick_disparo", rota: "/api/cron-disparo", cron: "* * * * *", semEle: "campanha criada nunca sai da fila.", modulo: "disparo" },
  { nome: "expert_chat_tick_agendadas", rota: "/api/cron-agendadas", cron: "* * * * *", semEle: "mensagem agendada nunca e enviada." },
  { nome: "expert_chat_tick_fluxos", rota: "/api/cron-fluxos", cron: "* * * * *", semEle: "fluxo enfileirado nunca executa.", modulo: "automacao" },
  { nome: "expert_chat_tick_sla", rota: "/api/relatorios/sla", cron: "*/15 * * * *", semEle: "alerta de SLA nunca dispara." },
];

/**
 * SQL de um job. PURO, e o segredo NUNCA aparece: o comando le
 * `mensageria.config` dentro do proprio banco. Se o valor nao estiver la, o job
 * falha ANTES de chamar a rota — melhor que gravar um bearer errado no catalogo do
 * cron, onde ele fica em texto pra sempre.
 */
export function sqlDoJob(job, base) {
  const url = `${String(base || "").replace(/\/+$/, "")}${job.rota}`;
  return [
    `-- ${job.nome}: ${job.cron}. Sem ele: ${job.semEle}`,
    `select cron.schedule('${job.nome}', '${job.cron}', $$`,
    `  select net.http_post(`,
    `    url := '${url}',`,
    `    headers := jsonb_build_object(`,
    `      'Content-Type', 'application/json',`,
    `      'Authorization', 'Bearer ' || (select valor #>> '{}' from mensageria.config where chave = 'tick_bearer')`,
    `    ),`,
    `    body := '{}'::jsonb`,
    `  );`,
    `$$);`,
  ].join("\n");
}

/** Os jobs que ESTA instalacao precisa, dado o mapa de modulos. PURA. */
export function jobsNecessarios(modulos) {
  return JOBS_CRON.filter((j) => !j.modulo || modulos?.[j.modulo] === true);
}

// ——————————————————————————————————————————————————————————— smoke test
//
// O que se testa DEPOIS de instalar, e o criterio de cada um. Nota o que NAO
// esta aqui: nenhuma checagem "200 = funcionou". Rota protegida devolvendo 200 sem
// login e a falha mais grave possivel, e um smoke test que comemora 200 nao veria.
export const SMOKE = [
  { rota: "/", metodo: "GET", esperado: [200], oQueProva: "o painel sobe e serve a tela de login." },
  { rota: "/api/chats", metodo: "GET", esperado: [401], oQueProva: "rota de conversas EXIGE login (200 aqui seria vazamento)." },
  { rota: "/api/exportar", metodo: "GET", esperado: [401], oQueProva: "exportacao de dados exige login." },
  { rota: "/api/admin/usuarios", metodo: "GET", esperado: [401], oQueProva: "administracao exige login." },
  // MEDIDO em producao (31/08/2026): estas duas sao POST-only, e um GET aqui volta
  // 405 — que nao prova NADA sobre autenticacao (o 405 sai antes do gate). O
  // metodo certo, sem credencial nenhuma, tem que bater no gate e ser recusado.
  // Nenhuma das duas produz efeito antes de autenticar, entao chamar e seguro.
  { rota: "/api/vigia", metodo: "POST", esperado: [401, 403], oQueProva: "tick recusa quem nao tem o bearer." },
  { rota: "/api/webhook", metodo: "POST", esperado: [401, 403], oQueProva: "webhook de entrada recusa sem a chave (`?key=`)." },
];

/** Veredito de um passo do smoke. PURO. */
export function vereditoSmoke(passo, status) {
  if (status === null || status === undefined) return { ok: false, texto: "sem resposta (o painel esta no ar?)" };
  if (passo.esperado.includes(status)) return { ok: true, texto: `HTTP ${status}` };
  // 200 onde se esperava 401 nao e "diferente do esperado": e vazamento
  const grave = status === 200 && !passo.esperado.includes(200);
  return {
    ok: false,
    grave,
    texto: grave
      ? `HTTP 200 SEM LOGIN — rota aberta. PARE a instalacao e confira o deploy (esperado ${passo.esperado.join(" ou ")}).`
      : `HTTP ${status}, esperado ${passo.esperado.join(" ou ")}`,
  };
}

// ————————————————————————————————————————————————————————————— relatorio

/** O veredito geral. PURO. Ordem: o que impede subir vem primeiro. */
export function vereditoGeral(passos) {
  const graves = passos.filter((p) => p.estado === "erro");
  const avisos = passos.filter((p) => p.estado === "aviso");
  if (graves.length) return { estado: "NAO PRONTA", resumo: `${graves.length} passo(s) impedem a operacao`, graves, avisos };
  if (avisos.length) return { estado: "PRONTA COM RESSALVA", resumo: `${avisos.length} passo(s) precisam de gesto humano`, graves, avisos };
  return { estado: "PRONTA", resumo: "todos os passos conferidos", graves, avisos };
}

/** Marca de presenca de segredo: TAMANHO, nunca valor. PURA. */
export function marcaDeValor(v, segredo) {
  const s = typeof v === "string" ? v : "";
  if (!s) return "(vazio)";
  return segredo ? `(${s.length} caracteres, nao exibido)` : s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
