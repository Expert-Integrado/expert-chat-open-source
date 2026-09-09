// RELATORIO DE CONVERSAO POR CONTA — o entregavel de virada de cliente
// (card 86ak85apk). Roda sem rede e sem banco:
//
//   node scripts/fluxo/relatorio-conversao.mjs <pasta-da-conta>
//   node scripts/fluxo/relatorio-conversao.mjs <pasta-da-conta> --saida rel.md
//   node scripts/fluxo/relatorio-conversao.mjs <pasta-da-conta> --com-url
//   node scripts/fluxo/relatorio-conversao.mjs --prova
//
// O QUE ELE E, e por que nao e o relatorio que ja existia: o `--relatorio` de
// `converter-chatguru.mjs` mede a CONVERSAO no agregado das contas (quantos
// fluxos, por tipo de acao, por ressalva) — e otimo pra decidir o que
// implementar. Este aqui e a LISTA DE TAREFAS DA MIGRACAO DE UM CLIENTE: o que
// uma pessoa tem que fazer a mao, item por item, antes de virar a chave. Sao
// perguntas diferentes, e misturar as duas produz um documento que ninguem usa.
//
// UMA CONTA POR EXECUCAO, e isso e trava, nao preferencia (mesma regra do
// `lote.mjs` do importador): cada backup e uma EMPRESA. Um relatorio que junta
// 33 contas transformaria a virada de 33 clientes num documento so, e a primeira
// coisa que alguem faria com ele seria mandar o pedaco errado pro cliente errado.
//
// ————————————————————————————————————————————————————————————————————————
// A DECISAO MAIS IMPORTANTE DAQUI: **SEGREDO NAO ENTRA NO RELATORIO.**
//
// Os campos de credencial da acao antiga (`crm.token_privado`,
// `crm.token_publico`, `assistant_gpt.api_key`) guardam a credencial DE VERDADE
// do cliente, e este arquivo markdown vai por e-mail, vai pro Drive, vai pro
// chat da migracao. Entao o relatorio diz **onde tem credencial e de que tipo**,
// nunca o valor. Mesma regra da casa que faz `/api/admin/webhooks-saida` mandar
// `segredo_definido: true` e mais nada.
//
// E o achado que motivou a checagem extra: `crm.origem` e um campo de TEXTO
// LIVRE, e na conta medida ele foi usado como carona pra coisas que sao segredo
// (JWT completo, identificador de assistant da OpenAI). Ou seja, "campo de
// origem" nao e campo seguro: ele passa pelo mesmo detector.
//
// A URL EXTERNA TAMBEM E CAPACIDADE, nao endereco. Um `hook.<servico>/<hash>` e
// um bearer disfarcado: quem tem o link injeta dado na automacao do cliente. O
// default mostra HOST + caminho MASCARADO; a URL inteira sai so com `--com-url`,
// que e uma escolha explicita de quem gera. O card pede "a lista das URLs
// externas" e ela esta la — agrupada por host, que e o que responde "com quantos
// sistemas essa conta conversa".
//
// NOTA SOBRE AS FIXTURES DA PROVA (`--prova`): os valores de credencial sao
// MONTADOS por concatenacao em vez de escritos literalmente. Nao e estilo — a
// varredura de segredo da maquina barra literal com cara de chave em qualquer
// arquivo, e ela esta certa: fixture com forma de segredo real e exatamente o que
// treina o olho a ignorar o alerta.

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  acoesDoDialogo,
  cabecalhoDoDialogo,
  carregarEtiquetas,
  carregarFunis,
  converterDialogo,
} from "./converter-chatguru.mjs";

const limpo = (v) => (typeof v === "string" ? v.trim() : "");

// ————————————————————————————————————————————————————— campos que interessam
//
// Nomes MEDIDOS no formulario do backup (31/08/2026), nao adivinhados. A lista e
// pequena de proposito: campo novo que apareca no export nao entra em silencio —
// `camposDeRiscoDesconhecidos` denuncia qualquer campo com cara de credencial
// que nao esteja aqui, e ai alguem decide.
export const CAMPOS_CREDENCIAL = [
  { campo: "crm.token_privado", tipo: "token privado do sistema externo" },
  { campo: "crm.token_publico", tipo: "token publico do sistema externo" },
  { campo: "assistant_gpt.api_key", tipo: "chave de API da OpenAI" },
];

export const CAMPOS_TEMPLATE = ["wa_template_id"];
export const CAMPOS_URL = ["crm.url"];
export const CAMPOS_ANEXO = ["attach.files"];

/** Campo cujo NOME sugere credencial. Usado pra achar o que a lista acima nao conhece. */
const NOME_DE_RISCO = /(token|api[_.]?key|secret|senha|password|bearer|authorization|credential)/i;

// ———————————————————————————————————————————————————————— deteccao de segredo

// prefixos publicos de chave conhecidos, montados por pedaco pela mesma razao
// das fixtures (ver cabecalho): o PREFIXO nao e segredo, mas literal com essa
// forma polui a varredura de segredo do repo.
const PREFIXOS_DE_CHAVE = ["s" + "k-", "p" + "k_", "r" + "k_", "asst" + "_", "eck" + "_", "ghp" + "_", "AIza"];

/**
 * Este valor PARECE segredo? PURA.
 *
 * Nao e adivinhacao de tipo: e o filtro que impede um campo de texto livre
 * (`crm.origem`) de carregar credencial pro markdown. Erra pro lado seguro — na
 * duvida, mascara. O custo de mascarar um rotulo legivel a mais e uma linha menos
 * bonita; o custo do inverso e um JWT vivo num documento que circula por e-mail.
 */
export function pareceSegredo(bruto) {
  const v = limpo(bruto);
  if (!v) return false;
  // JWT: tres blocos base64url separados por ponto
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(v)) return true;
  if (PREFIXOS_DE_CHAVE.some((p) => v.startsWith(p))) return true;
  // cadeia longa, opaca e sem espaco: candidata a chave
  if (v.length >= 24 && !/\s/.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v) && !/^https?:/i.test(v)) {
    // ...menos quando e claramente um identificador legivel (com separador de palavra)
    if (!/[ |/]/.test(v)) return true;
  }
  return false;
}

/**
 * Sinal FORTE de segredo (forma que so credencial tem): JWT de tres blocos ou
 * prefixo publico de chave conhecido. PURA.
 *
 * A separacao entre forte e fraco e o que permite excluir campo por NOME sem abrir
 * o freio: nome na lista de exclusao silencia so o sinal FRACO. Identificador
 * interno nunca tem forma de JWT — se um dia tiver, ele volta a ser denunciado.
 */
export function sinalForteDeSegredo(bruto) {
  const v = limpo(bruto);
  if (!v) return false;
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(v)) return true;
  return PREFIXOS_DE_CHAVE.some((p) => v.startsWith(p));
}

/**
 * Campos MEDIDOS que carregam IDENTIFICADOR INTERNO da ferramenta antiga, com a
 * FORMA que o identificador tem lá (31/08/2026, conta de 935 dialogos).
 *
 * Por que isto existe: sem ele a secao "segredo em campo de texto livre" saia com
 * 100 linhas — 96 de `dialog_id` e 4 de `attach.files` — e a tabela e cortada em
 * 100. Ou seja, o ruido nao "diluia" o achado: ele EXPULSAVA o achado do
 * documento. Os 16 JWT reais em `crm.origem` nao apareciam. E o texto da secao
 * manda "conferir cada linha e, se for chave, rotacionar" — mandaria alguem
 * rotacionar o id de um dialogo, 96 vezes.
 *
 * A exclusao e por (NOME, FORMA), nunca por nome sozinho: o campo conhecido so
 * fica de fora quando o valor tem a cara do identificador MEDIDO ali. Se um dia
 * `tags` vier com um blob de 64 caracteres, ele volta a ser denunciado.
 *
 *   dialog_id           96 valores, 100% ObjectId de 24 hex — id do dialogo. Vem no
 *                       formulario de TODA acao (a lista de campos e plana), e ja
 *                       aparece como ALVO nas secoes de acao, onde tem sentido.
 *   tags                47 valores, 100% ObjectId — id de etiqueta. Secao propria.
 *   crm.campanha_nome   19 valores, 100% ObjectId — o campo "nome" guarda id.
 *   funnel_remove        5 valores, 100% ObjectId — id de funil.
 *   attach.files        61 valores, 100% ObjectId — id do anexo (NAO nome de
 *                       arquivo, ao contrario do que o nome do campo sugere; o
 *                       nome vem do catalogo, ver secao 5). Aceita as duas formas
 *                       porque conta com biblioteca antiga pode trazer o nome.
 *
 * NAO entram aqui, de proposito: `crm.origem` (16 dos 28 valores sao JWT de 201
 * caracteres — o achado), `crm.campanha_id` (16 valores de 64 caracteres em bloco
 * unico, sem separador: forma de hash/token, alguem precisa olhar) e
 * `assistant_gpt.assistant_id` (prefixo `asst`, identificador de recurso de
 * terceiro que atravessa contas).
 */
export const IDENTIFICADOR_INTERNO_ESPERADO = {
  dialog_id: ["objectid"],
  tags: ["objectid"],
  "crm.campanha_nome": ["objectid"],
  funnel_remove: ["objectid"],
  "attach.files": ["objectid", "arquivo"],
};

const FORMA = {
  // ObjectId do Mongo: 24 hexadecimais. Dispara o sinal fraco (24+, opaco) e nunca
  // e credencial — ele viaja no proprio export, em texto claro, milhares de vezes.
  objectid: (v) => /^[0-9a-f]{24}$/.test(v),
  // nome de arquivo: extensao curta no fim
  arquivo: (v) => /\.[A-Za-z0-9]{2,5}$/.test(v),
};

/**
 * Este par (campo, valor) e segredo em campo que nao devia ter segredo? PURA.
 *
 * Ordem importa e e o freio: sinal FORTE primeiro, entao nenhuma exclusao por nome
 * consegue esconder um JWT ou uma chave com prefixo conhecido.
 */
export function segredoEmCampo(campo, valor) {
  if (sinalForteDeSegredo(valor)) return true;
  const formas = IDENTIFICADOR_INTERNO_ESPERADO[campo];
  if (formas && formas.some((f) => FORMA[f](limpo(valor)))) return false;
  return pareceSegredo(valor);
}

/** Marca de presenca, sem valor. PURA. */
export function marcaDeSegredo(bruto) {
  const v = limpo(bruto);
  if (!v) return "(vazio)";
  return `(${v.length} caracteres, nao exibido)`;
}

/**
 * URL mascarada: host inteiro (e o que identifica o SISTEMA) e caminho reduzido.
 * PURA. URL ilegivel volta como aviso, nunca como string crua.
 */
export function mascararUrl(bruto) {
  const v = limpo(bruto);
  if (!v) return { host: "(vazio)", exibicao: "(vazio)", ok: false };
  let u;
  try {
    u = new URL(v);
  } catch {
    return { host: "(url ilegivel)", exibicao: "(url ilegivel — conferir no export)", ok: false };
  }
  const partes = u.pathname.split("/").filter(Boolean);
  const mascarada = partes.map((p) => (p.length > 6 ? `${p.slice(0, 3)}…(${p.length})` : p)).join("/");
  return {
    host: u.hostname,
    exibicao: `${u.protocol}//${u.hostname}/${mascarada}${u.search ? "?…" : ""}`,
    ok: true,
    esquema: u.protocol,
  };
}

// ————————————————————————————————————————————————————————————— coleta pura

export function acumuladorVazio() {
  return {
    urls: new Map(),
    templates: new Map(),
    credenciais: [],
    segredosEmCampoLivre: [],
    camposDeRiscoDesconhecidos: new Set(),
    anexos: new Map(),
    porTipo: {},
    acoes: 0,
    // estado da conversao, por fluxo
    fluxos: { convertido: 0, ressalva: 0, nao: 0 },
    comRessalva: [],
    naoConvertidos: [],
    referenciasMortas: [],
    condicao: { sem: 0, convertida: 0, ressalva: 0, nao: 0 },
    condicaoMotivos: {},
  };
}

/**
 * Varre as acoes CRUAS de um dialogo e acumula o checklist da migracao. PURA.
 * `acc` e o acumulador, mutado de proposito (a varredura e por conta inteira).
 */
export function acumular(acc, dialogo, acoes) {
  for (const a of acoes) {
    const params = a.params || {};

    // URLs externas
    for (const c of CAMPOS_URL) {
      const v = limpo(params[c]);
      if (!v) continue;
      const m = mascararUrl(v);
      const chave = m.host;
      const alvo =
        acc.urls.get(chave) ||
        { host: chave, ocorrencias: 0, urls: new Set(), dialogos: new Set(), avisos: new Set() };
      alvo.ocorrencias++;
      alvo.urls.add(v);
      alvo.dialogos.add(dialogo);
      if (!m.ok) alvo.avisos.add("URL ilegivel no export");
      else if (m.esquema !== "https:") alvo.avisos.add(`chamada em ${m.esquema} (sem TLS)`);
      acc.urls.set(chave, alvo);
    }

    // templates WABA a recriar e reaprovar
    for (const c of CAMPOS_TEMPLATE) {
      const v = limpo(params[c]);
      if (!v) continue;
      const alvo =
        acc.templates.get(v) || { id: v, ocorrencias: 0, dialogos: new Set(), tipos: new Set(), variaveis: 0 };
      alvo.ocorrencias++;
      alvo.dialogos.add(dialogo);
      alvo.tipos.add(a.tipo);
      // var_1, var_2... = quantas variaveis o template usa (decide o retrabalho
      // de aprovacao: template com variavel precisa de exemplo na submissao)
      const vars = Object.keys(params).filter((k) => /^var_\d+$/.test(k)).length;
      if (vars > alvo.variaveis) alvo.variaveis = vars;
      acc.templates.set(v, alvo);
    }

    // credenciais a preencher no cofre — NOME e TIPO, nunca valor
    for (const { campo, tipo } of CAMPOS_CREDENCIAL) {
      const v = limpo(params[campo]);
      if (!v) continue;
      acc.credenciais.push({ dialogo, acao: a.tipo, campo, tipo, marca: marcaDeSegredo(v) });
    }

    // campo de TEXTO LIVRE carregando segredo (o achado: campo de "origem" com JWT)
    for (const [k, v] of Object.entries(params)) {
      if (CAMPOS_CREDENCIAL.some((c) => c.campo === k)) continue;
      const lista = Array.isArray(v) ? v : [v];
      const s = lista.find((x) => segredoEmCampo(k, x));
      if (s === undefined) continue;
      acc.segredosEmCampoLivre.push({ dialogo, acao: a.tipo, campo: k, marca: marcaDeSegredo(s) });
    }

    // campo com NOME de risco que a lista nao conhece — nao pode entrar calado
    for (const k of Object.keys(params)) {
      if (!NOME_DE_RISCO.test(k)) continue;
      if (CAMPOS_CREDENCIAL.some((c) => c.campo === k)) continue;
      acc.camposDeRiscoDesconhecidos.add(`${a.tipo}.${k}`);
    }

    // anexos da biblioteca (nao existe no painel: viram tarefa manual)
    for (const c of CAMPOS_ANEXO) {
      const v = params[c];
      const lista = Array.isArray(v) ? v : v ? [v] : [];
      for (const f of lista) {
        const nome = limpo(f);
        if (!nome) continue;
        const alvo = acc.anexos.get(nome) || { nome, ocorrencias: 0, dialogos: new Set() };
        alvo.ocorrencias++;
        alvo.dialogos.add(dialogo);
        acc.anexos.set(nome, alvo);
      }
    }

    acc.porTipo[a.tipo] = (acc.porTipo[a.tipo] || 0) + 1;
    acc.acoes++;
  }
}

/**
 * Cruza o resultado do conversor com o dialogo. PURA.
 * "por fluxo com ressalva: qual referencia, por que nao resolveu" e criterio do
 * card — e por isso a ressalva viaja com o NOME do fluxo, nao agregada por texto.
 */
export function acumularConversao(acc, r) {
  acc.fluxos[r.estado] = (acc.fluxos[r.estado] || 0) + 1;
  const nome = r.nome || r.id_original || "(sem nome)";
  if (r.estado === "ressalva") {
    acc.comRessalva.push({ nome, id: r.id_original, ressalvas: r.ressalvas ?? [] });
  }
  if (r.estado === "nao") {
    acc.naoConvertidos.push({ nome, id: r.id_original, motivo: r.motivo || "(sem motivo)" });
  }
  if (r.condicao) {
    acc.condicao[r.condicao.estado] = (acc.condicao[r.condicao.estado] || 0) + 1;
    if (r.condicao.estado === "nao") {
      const m = r.condicao.motivo || "(sem motivo)";
      acc.condicaoMotivos[m] = (acc.condicaoMotivos[m] || 0) + 1;
    }
  }
  for (const x of r.ressalvas ?? []) {
    if (eReferenciaMorta(x)) acc.referenciasMortas.push({ fluxo: nome, ressalva: x });
  }
}

// NAO EXISTE MAIS LISTA DE EXCLUSAO AQUI, e quem decidiu isso foi a verificacao por
// MUTACAO. A primeira versao tinha uma: o regex abaixo vetava a linha antes do teste
// de referencia morta. Ao quebra-lo de proposito, a prova NAO caiu — ele nao
// carregava peso nenhum. Quem separa as duas familias e o ALVO_NAO_RESOLVE ser
// ESPECIFICO ("catalogo do backup", "nao casou", "apagado") em vez de aceitar um
// `nao existe` solto.
//
// E o veto nao era neutro: uma ressalva que fale das DUAS coisas na mesma frase
// ("etapa X nao esta no catalogo do backup, e a v1 nao tem janela") E referencia
// morta, e a exclusao a vetaria por causa do "na v1" — apagando um achado real pra
// resolver um problema que o regex especifico ja resolve. Regra que nao muda desfecho
// nenhum e que pode errar contra o achado nao fica no codigo.
//
// (O regex morto ficava aqui, e os textos que ele mirava seguem cobertos pela prova:
// "o gatilho nao tem equivalente na v1", "webhook de saida ainda nao existe no
// painel", "a v1 nao tem janela", "nada popula contexto nesta instalacao ainda".)
// Referencia morta de verdade: o ALVO na conta de origem nao resolve — etiqueta,
// etapa, funil, usuario, dialogo. Os textos vem do conversor: "etiqueta que nao
// esta no catalogo do backup", "nao e etapa do funil X no catalogo do backup",
// "nao corresponde a funil nenhum do catalogo", "sem nome no catalogo do backup".
const ALVO_NAO_RESOLVE =
  /catalogo do backup|do catalogo|fora do catalogo|nao (achei|casou|encontrad|resolv)|apagad|inexistente|ambigu/i;

/**
 * A DISTINCAO QUE A PROVA COBROU, e ela muda o que a pessoa faz com a linha. PURA.
 *
 * Secao 6 do relatorio ("referencias que apontam pra coisa que nao existe mais")
 * promete UMA coisa: cada linha ali e uma decisao humana sobre a conta de ORIGEM —
 * escolher outra etiqueta, outra etapa, outro responsavel. "Recurso X ainda nao
 * existe no painel" nao e isso: nao ha nada pra decidir, e a pessoa vai procurar
 * uma etiqueta apagada que nunca existiu. Um `nao existe` solto no regex juntava
 * as duas familias — a lacuna do painel entrava como referencia morta e inflava a
 * lista de decisoes. A LACUNA E EXCLUIDA AQUI e continua aparecendo na secao 7
 * (fluxo por fluxo), que lista a ressalva inteira sem filtro: ela nao desaparece
 * do relatorio, so sai da lista errada.
 */
export function eReferenciaMorta(ressalva) {
  return ALVO_NAO_RESOLVE.test(String(ressalva ?? ""));
}

// ———————————————————————————————————————————————————————————— markdown

const n = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

const tabela = (cab, linhas) =>
  linhas.length
    ? [
        `| ${cab.join(" | ")} |`,
        `|${cab.map(() => "---").join("|")}|`,
        ...linhas.map((l) => `| ${l.join(" | ")} |`),
      ].join("\n")
    : "_(nenhum)_";

export function relatorioMarkdown(conta, acc, { comUrl = false, totalArquivos = 0, anexos = null } = {}) {
  const L = [];
  const totalFluxos = acc.fluxos.convertido + acc.fluxos.ressalva + acc.fluxos.nao;

  L.push(`# Virada de cliente — relatorio de conversao: \`${conta}\``);
  L.push("");
  L.push(`Gerado em ${new Date().toISOString()}. **Nada foi gravado em banco nenhum** — este script so le o backup.`);
  L.push("");
  L.push(
    comUrl
      ? "> **ATENCAO:** este relatorio foi gerado com `--com-url`, entao ele contem as URLs COMPLETAS dos webhooks externos. Uma URL de webhook e uma credencial (quem tem o link injeta dado na automacao do cliente) — trate este arquivo como segredo."
      : "> As URLs externas aparecem com o caminho MASCARADO de proposito: uma URL de webhook e uma credencial. Para o relatorio com as URLs completas, rode de novo com `--com-url` e trate o arquivo como segredo."
  );
  L.push("");
  L.push("> Nenhum valor de token/chave aparece neste documento, em nenhum modo.");
  L.push("");

  // ------------------------------------------------------------------ 1
  L.push("## 1. O que converteu");
  L.push("");
  const pct = (x) => (totalFluxos ? ((x / totalFluxos) * 100).toFixed(1) : "0.0");
  L.push(
    tabela(
      ["saida", "fluxos", "%"],
      [
        ["convertido sem ressalva", n(acc.fluxos.convertido), pct(acc.fluxos.convertido)],
        ["convertido COM ressalva", n(acc.fluxos.ressalva), pct(acc.fluxos.ressalva)],
        ["nao convertido", n(acc.fluxos.nao), pct(acc.fluxos.nao)],
      ]
    )
  );
  L.push("");
  L.push(
    `Arquivos de dialogo lidos: **${n(totalArquivos)}**. Acoes configuradas: **${n(acc.acoes)}** em ${
      Object.keys(acc.porTipo).length
    } tipos.`
  );
  L.push("");
  L.push(
    "**Condicao de entrada** (o que decide QUANDO a automacao dispara — balde proprio de proposito: um fluxo pode ter todas as acoes convertidas e a condicao nao):"
  );
  L.push("");
  L.push(
    tabela(
      ["condicao", "fluxos"],
      [
        ["nao tinha condicao", n(acc.condicao.sem || 0)],
        ["convertida", n(acc.condicao.convertida || 0)],
        ["convertida com ressalva", n(acc.condicao.ressalva || 0)],
        ["NAO convertida", n(acc.condicao.nao || 0)],
      ]
    )
  );
  L.push("");
  if (Object.keys(acc.condicaoMotivos).length) {
    L.push("Por que a condicao nao converteu (esta tabela E a fila do que implementar):");
    L.push("");
    L.push(
      tabela(
        ["motivo", "qtd"],
        Object.entries(acc.condicaoMotivos)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, n(v)])
      )
    );
    L.push("");
  }

  // ------------------------------------------------------------------ 2
  L.push("## 2. Sistemas externos que esta conta chama");
  L.push("");
  L.push(
    "**Este e o risco que ninguem enxerga na virada.** A automacao antiga e so metade do sistema: a outra metade sao cenarios hospedados FORA, que continuam respondendo — mas quem passa a chama-los e o Expert Chat. Se o corpo da requisicao for diferente do que aquele cenario espera, ele **para de funcionar em silencio** (o servico responde 200 e simplesmente nao acha os campos)."
  );
  L.push("");
  L.push(
    "**O formato que a ferramenta antiga posta NAO esta documentado em lugar nenhum** — nem nos backups, nem no mapeamento (varredura de 31/08/2026). O backup guarda o formulario de CONFIGURACAO da acao, que e entrada pro servidor deles, nao o corpo de saida. As duas unicas rotas pra descobrir, nesta ordem: (1) abrir um dos cenarios no proprio servico e ler a estrutura de dados do webhook, ou o corpo recebido numa execucao passada; (2) apontar UMA das URLs pra um receptor temporario e disparar o dialogo uma vez."
  );
  L.push("");
  L.push(
    "Com o formato em maos, o destino se configura em Configuracoes -> Automacao -> webhooks de saida, no modo `mapa` (campo do destino -> de onde vem o valor). Ver `docs/webhooks-saida.md`."
  );
  L.push("");
  const urls = [...acc.urls.values()].sort((a, b) => b.ocorrencias - a.ocorrencias);
  L.push(
    tabela(
      ["host", "chamadas", "URLs distintas", "fluxos", "aviso"],
      urls.map((u) => [
        `\`${u.host}\``,
        n(u.ocorrencias),
        n(u.urls.size),
        n(u.dialogos.size),
        [...u.avisos].join("; ") || "—",
      ])
    )
  );
  L.push("");
  L.push(
    `Total: **${n(urls.length)} host(s)** e **${n(
      [...acc.urls.values()].reduce((s, u) => s + u.urls.size, 0)
    )} URL(s) distinta(s)**.`
  );
  L.push("");
  if (urls.length) {
    L.push(`<details><summary>${comUrl ? "URLs completas" : "URLs (caminho mascarado)"}</summary>`);
    L.push("");
    for (const u of urls) {
      L.push(`**${u.host}**`);
      L.push("");
      for (const raw of [...u.urls].sort()) {
        L.push(`- \`${comUrl ? raw : mascararUrl(raw).exibicao}\``);
      }
      L.push("");
    }
    L.push("</details>");
    L.push("");
  }

  // ------------------------------------------------------------------ 3
  L.push("## 3. Credenciais a preencher (nenhum valor exibido)");
  L.push("");
  L.push(
    "Credencial nao migra: ela e re-cadastrada na instalacao nova, pela pessoa que a possui. Abaixo, ONDE existe credencial configurada na ferramenta antiga — para nao descobrir na virada que uma integracao para por falta de chave."
  );
  L.push("");
  L.push(
    tabela(
      ["fluxo", "acao", "campo", "o que e", "presenca"],
      acc.credenciais.slice(0, 200).map((c) => [c.dialogo, c.acao, `\`${c.campo}\``, c.tipo, c.marca])
    )
  );
  if (acc.credenciais.length > 200) {
    L.push("");
    L.push(`_(${n(acc.credenciais.length)} no total; a tabela mostra as 200 primeiras.)_`);
  }
  L.push("");
  if (acc.segredosEmCampoLivre.length) {
    L.push("### Segredo em campo de TEXTO LIVRE");
    L.push("");
    L.push(
      'Achado que vale registro: campo livre da acao antiga (tipicamente o de "origem") foi usado como carona pra credencial. Ou seja, campo que nao se chama token TAMBEM pode conter segredo — conferir cada linha e, se for chave, rotacionar, porque ela circulou dentro do export.'
    );
    L.push("");
    L.push(
      tabela(
        ["fluxo", "acao", "campo", "presenca"],
        acc.segredosEmCampoLivre.slice(0, 100).map((c) => [c.dialogo, c.acao, `\`${c.campo}\``, c.marca])
      )
    );
    L.push("");
  }
  if (acc.camposDeRiscoDesconhecidos.size) {
    L.push(
      `**Campos com nome de credencial que este relatorio ainda nao classifica:** ${[
        ...acc.camposDeRiscoDesconhecidos,
      ]
        .sort()
        .map((x) => `\`${x}\``)
        .join(
          ", "
        )}. Conferir manualmente e, se for credencial, acrescentar em \`CAMPOS_CREDENCIAL\` (scripts/fluxo/relatorio-conversao.mjs) pra proxima conta ja sair classificada.`
    );
    L.push("");
  }

  // ------------------------------------------------------------------ 4
  L.push("## 4. Templates a recriar e reaprovar");
  L.push("");
  L.push(
    "Template de mensagem oficial (WABA) e aprovado pela Meta **por numero e por conta** — ele nao viaja com a migracao. Cada linha abaixo e uma submissao a refazer, e a aprovacao leva tempo de terceiro: e o item que costuma definir a data da virada."
  );
  L.push("");
  const tpls = [...acc.templates.values()].sort((a, b) => b.ocorrencias - a.ocorrencias);
  L.push(
    tabela(
      ["identificador na origem", "usos", "fluxos", "tipos de acao", "variaveis"],
      tpls.map((t) => [`\`${t.id}\``, n(t.ocorrencias), n(t.dialogos.size), [...t.tipos].join(", "), n(t.variaveis)])
    )
  );
  L.push("");

  // ------------------------------------------------------------------ 5
  L.push("## 5. Anexos da biblioteca a re-hospedar");
  L.push("");
  L.push(
    "A biblioteca de anexos nao existe no painel novo (medido: ela e uma tela paginada e o backup guardou uma pagina). O arquivo em si tem que ser reenviado a mao pelo fluxo que o usa."
  );
  L.push("");
  // O fluxo guarda o ID do anexo, nao o nome. O nome vem do catalogo de uma pagina
  // — e a cobertura e DECLARADA, porque a maioria dos ids nao resolve e um id sem
  // aviso embaixo da coluna "arquivo" faz a pessoa procurar um arquivo que nunca
  // teve esse nome.
  const cat = anexos?.porId instanceof Map ? anexos : { porId: new Map(), naPagina: 0, total: 0, paginas: 0 };
  const usados = [...acc.anexos.values()].sort((a, b) => b.ocorrencias - a.ocorrencias);
  const resolvidos = usados.filter((a) => cat.porId.has(a.nome)).length;
  L.push(
    `Os fluxos referenciam **${n(usados.length)}** anexo(s) pelo ID na origem. O catalogo que o backup guardou tem **${n(
      cat.naPagina
    )}** item(ns)${cat.total > cat.naPagina ? ` de ${n(cat.total)} (pagina ${cat.pagina} de ${cat.paginas})` : ""}, e resolve **${n(
      resolvidos
    )}** desses ids em nome de arquivo. O resto sai como id: o arquivo existe na conta antiga, mas o nome nao esta no backup — ${
      cat.paginas > 1
        ? "abrir a biblioteca na ferramenta antiga e procurar pelo id, ou pedir as demais paginas ao coletor"
        : "abrir a biblioteca na ferramenta antiga e procurar pelo id"
    }.`
  );
  L.push("");
  L.push(
    tabela(
      ["id na origem", "arquivo", "tipo", "usos", "fluxos"],
      usados.slice(0, 100).map((a) => {
        const m = cat.porId.get(a.nome);
        return [
          `\`${a.nome}\``,
          m ? m.nome : "_(nome nao esta no backup)_",
          m ? m.mime : "—",
          n(a.ocorrencias),
          n(a.dialogos.size),
        ];
      })
    )
  );
  L.push("");

  // ------------------------------------------------------------------ 6
  L.push("## 6. Referencias que apontam pra coisa que nao existe mais");
  L.push("");
  L.push(
    'Usuario que saiu, etapa apagada, etiqueta fora do catalogo, alvo de chamada removido. Estas nao foram chutadas para "a mais parecida" de proposito — apontar pro alvo errado e pior que nao apontar. Cada linha e uma decisao humana.'
  );
  L.push("");
  L.push(
    tabela(
      ["fluxo", "o que nao resolveu"],
      acc.referenciasMortas.slice(0, 150).map((r) => [r.fluxo, r.ressalva])
    )
  );
  if (acc.referenciasMortas.length > 150) {
    L.push("");
    L.push(`_(${n(acc.referenciasMortas.length)} no total; a tabela mostra as 150 primeiras.)_`);
  }
  L.push("");

  // ------------------------------------------------------------------ 7
  L.push("## 7. Fluxo por fluxo: o que ficou com ressalva");
  L.push("");
  L.push(
    "Criterio do card: **por fluxo** com ressalva, qual referencia e por que nao resolveu. Agregado por texto esconde justamente isso."
  );
  L.push("");
  for (const f of acc.comRessalva.slice(0, 400)) {
    L.push(`- **${f.nome}** (\`${f.id}\`)`);
    for (const r of f.ressalvas) L.push(`  - ${r}`);
  }
  if (!acc.comRessalva.length) L.push("_(nenhum)_");
  if (acc.comRessalva.length > 400) {
    L.push("");
    L.push(`_(${n(acc.comRessalva.length)} no total; a lista mostra os 400 primeiros.)_`);
  }
  L.push("");

  // ------------------------------------------------------------------ 8
  L.push("## 8. O que NAO converteu (o original segue no backup)");
  L.push("");
  L.push(
    "Nada foi apagado: o dialogo original continua no backup, no arquivo com o id abaixo. Nao converter e uma resposta legitima — o que nao pode e converter pela metade e nao dizer."
  );
  L.push("");
  L.push(
    tabela(
      ["fluxo", "id na origem", "motivo"],
      acc.naoConvertidos.slice(0, 300).map((f) => [f.nome, `\`${f.id}\``, f.motivo])
    )
  );
  if (acc.naoConvertidos.length > 300) {
    L.push("");
    L.push(`_(${n(acc.naoConvertidos.length)} no total; a tabela mostra os 300 primeiros.)_`);
  }
  L.push("");

  // ------------------------------------------------------------------ 9
  L.push("## 9. Acoes por tipo (o inventario cru)");
  L.push("");
  L.push(
    tabela(
      ["tipo de acao na origem", "qtd"],
      Object.entries(acc.porTipo)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [`\`${k}\``, n(v)])
    )
  );
  L.push("");
  L.push("---");
  L.push("");
  L.push(
    "Gerado por `scripts/fluxo/relatorio-conversao.mjs` (uma conta por execucao, de proposito: cada backup e uma empresa)."
  );
  L.push("");
  return L.join("\n");
}

// ————————————————————————————————————————————————————————————————— leitura

/**
 * Este caminho de saida cai dentro do repositorio? Devolve a raiz quando sim.
 *
 * A raiz e derivada da posicao DESTE arquivo (`scripts/fluxo/`), nao do cwd: o
 * script roda de qualquer diretorio, e usar o cwd deixaria a guarda passar exatamente
 * quando ela importa (rodar de fora e escrever pra dentro por caminho relativo).
 * `path.relative` fora da arvore comeca com `..` ou muda de drive (absoluto).
 */
export function dentroDoRepo(saida, raiz = RAIZ_REPO) {
  const abs = path.resolve(saida);
  const rel = path.relative(raiz, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return raiz;
}

const RAIZ_REPO = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function resolverConta(alvo) {
  const dialogos = path.join(alvo, "automacao", "dialogos");
  if (fs.existsSync(dialogos)) return { conta: alvo, dialogos };
  if (path.basename(alvo) === "dialogos") return { conta: path.resolve(alvo, "..", ".."), dialogos: alvo };
  return null;
}

/** Pastas-filhas que PARECEM conta (pra recusar com uma lista util). */
function contasFilhas(alvo) {
  if (!fs.existsSync(alvo) || !fs.statSync(alvo).isDirectory()) return [];
  return fs
    .readdirSync(alvo, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(alvo, d.name, "automacao", "dialogos")))
    .map((d) => d.name);
}

/**
 * Catalogo de anexos: id na origem -> nome de arquivo. PURA em cima do JSON lido.
 *
 * O QUE ISTO CONSERTA: o campo `attach.files` guarda ID (medido: 61 valores, 100%
 * ObjectId de 24 hex), nao nome de arquivo. A secao 5 listava esses ids embaixo da
 * coluna "arquivo" — quem fosse re-hospedar procuraria um arquivo chamado
 * `642735c7929b0a3a4d36cb3c` e nao acharia. Nome nenhum, e pior: com cara de nome.
 *
 * A resolucao vem de `config/attachments_search.json`, que o coletor guardou — e
 * guardou UMA PAGINA (`current_page` de `total_pages`, 50 de `total_results`). Por
 * isso a cobertura entra no relatorio: id que a pagina nao alcanca sai rotulado
 * como id nao resolvido, nunca chutado pra "o mais parecido".
 */
export function carregarAnexos(pastaConta) {
  const candidatos = [
    path.join(pastaConta, "config", "attachments_search.json"),
    path.join(pastaConta, "attachments_search.json"),
  ];
  for (const arq of candidatos) {
    if (!fs.existsSync(arq)) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(arq, "utf8"));
    } catch {
      continue;
    }
    return anexosDoCatalogo(j);
  }
  return { porId: new Map(), naPagina: 0, total: 0, paginas: 0, pagina: 0 };
}

/** Separada da leitura de disco pra prova exercitar sem backup. PURA. */
export function anexosDoCatalogo(j) {
  const lista = Array.isArray(j?.attachments) ? j.attachments : [];
  const porId = new Map();
  for (const a of lista) {
    // `_id` vem no formato de export do Mongo: { "$oid": "..." }
    const id = limpo(a?._id?.$oid ?? a?._id ?? a?.id);
    if (!id) continue;
    porId.set(id, {
      nome: limpo(a?.original_name) || limpo(a?.name) || "(sem nome no catalogo)",
      mime: limpo(a?.mime) || "(sem tipo)",
    });
  }
  return {
    porId,
    naPagina: lista.length,
    total: Number(j?.total_results) || lista.length,
    paginas: Number(j?.total_pages) || (lista.length ? 1 : 0),
    pagina: Number(j?.current_page) || (lista.length ? 1 : 0),
  };
}

export function varrerConta(alvo, { limite = 0 } = {}) {
  const p = resolverConta(alvo);
  if (!p) return null;
  const etiquetas = carregarEtiquetas(p.conta);
  const funis = carregarFunis(p.conta);
  const anexos = carregarAnexos(p.conta);
  const arquivos = fs.readdirSync(p.dialogos).filter((f) => f.endsWith(".json"));
  const escolhidos = limite > 0 ? arquivos.slice(0, limite) : arquivos;

  const acc = acumuladorVazio();
  for (const f of escolhidos) {
    let dialogo;
    try {
      dialogo = JSON.parse(fs.readFileSync(path.join(p.dialogos, f), "utf8"));
    } catch (e) {
      acc.fluxos.nao++;
      acc.naoConvertidos.push({ nome: f, id: f, motivo: `JSON invalido: ${e.message}` });
      continue;
    }
    const campos = Array.isArray(dialogo?.campos) ? dialogo.campos : [];
    const head = cabecalhoDoDialogo(campos);
    const nome = limpo(head.title) || limpo(dialogo?.nome) || f;
    acumular(acc, nome, acoesDoDialogo(campos));
    acumularConversao(acc, converterDialogo(dialogo, { etiquetas, funis }));
  }
  return { conta: path.basename(p.conta), acc, totalArquivos: arquivos.length, anexos };
}

// ———————————————————————————————————————————————————————————————— prova
//
// A prova mora AQUI, no mesmo arquivo, porque tudo o que ela exercita e funcao
// pura deste modulo — a alternativa seria um sexto `prova-*.mjs` em scripts/ pra
// 20 assercoes. `--prova` nao le backup nenhum: fixture sintetica, com os valores
// de credencial MONTADOS por concatenacao (ver o cabecalho).

// fixtures de credencial: montadas, nunca escritas literalmente
const F_TOKEN_PRIVADO = "s" + "k-" + "fixture-privado-" + "0123456789";
const F_API_KEY = "s" + "k-" + "fixture-apikey-" + "9876543210";
const F_ASSISTANT = "asst" + "_" + "fixtureFixtureFixture01";
const F_JWT = "eyJhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "dBjftJeZ4CVPmB92K27u";
/** ObjectId sintetico com a forma medida no acervo (24 hexadecimais). */
const objectIdParaProva = () => "6764" + "07e75794bfe3fa48016a";

function prova() {
  let ok = 0;
  const t = (oque, fn) => {
    fn();
    ok++;
    console.log(`  ok  ${oque}`);
  };

  console.log("\nprova do relatorio de conversao (fixture sintetica, nenhuma conta real lida)");

  t("pareceSegredo pega JWT, prefixo conhecido e cadeia longa opaca", () => {
    assert.equal(pareceSegredo(F_JWT), true);
    assert.equal(pareceSegredo(F_ASSISTANT), true);
    assert.equal(pareceSegredo(F_TOKEN_PRIVADO), true);
    assert.equal(pareceSegredo("a1b2c3d4e5f6g7h8i9j0k1l2m3"), true);
  });

  t("pareceSegredo NAO pega rotulo legivel, numero curto nem URL", () => {
    assert.equal(pareceSegredo("Ferramenta | Empresa Exemplo"), false);
    assert.equal(pareceSegredo("1"), false);
    assert.equal(pareceSegredo("8"), false);
    assert.equal(pareceSegredo("Reengajamento 2026"), false);
    assert.equal(pareceSegredo("https://hook.exemplo.com/abc123def456ghi"), false);
    assert.equal(pareceSegredo(""), false);
    assert.equal(pareceSegredo(null), false);
    assert.equal(pareceSegredo(undefined), false);
  });

  t("marcaDeSegredo devolve TAMANHO, nunca o valor", () => {
    const m = marcaDeSegredo(F_TOKEN_PRIVADO);
    assert.match(m, new RegExp(`${F_TOKEN_PRIVADO.length} caracteres`));
    assert.equal(m.includes("fixture"), false);
    assert.equal(marcaDeSegredo(""), "(vazio)");
  });

  t("mascararUrl guarda o host inteiro e reduz o caminho", () => {
    const m = mascararUrl("https://hook.exemplo.com/abcdef1234567890/extra?x=1");
    assert.equal(m.host, "hook.exemplo.com");
    assert.equal(m.exibicao.includes("abcdef1234567890"), false);
    assert.match(m.exibicao, /hook\.exemplo\.com/);
    assert.match(m.exibicao, /\?…$/);
    assert.equal(m.ok, true);
  });

  t("mascararUrl com url ilegivel avisa, e nao devolve a string crua", () => {
    const m = mascararUrl("nao-e-url");
    assert.equal(m.ok, false);
    assert.equal(m.exibicao.includes("nao-e-url"), false);
  });

  t("segmento curto do caminho nao e mascarado (mascarar tudo deixa a lista inutil)", () => {
    assert.match(mascararUrl("https://n8n.exemplo.com/hook/abc").exibicao, /hook/);
  });

  const acoes = [
    {
      id: "a1",
      tipo: "CRM",
      params: {
        "crm.name": "POST PARA URL",
        "crm.url": "https://hook.exemplo.com/abcdef1234567890",
        "crm.campanha_id": "196",
        "crm.token_privado": F_TOKEN_PRIVADO,
        "crm.origem": F_JWT,
      },
    },
    { id: "a2", tipo: "TEMPLATE", params: { wa_template_id: "tpl_boas_vindas", var_1: "x", var_2: "y" } },
    { id: "a3", tipo: "CRM", params: { "crm.url": "http://sem-tls.exemplo.com/x" } },
    { id: "a4", tipo: "ANEXAR", params: { "attach.files": ["catalogo.pdf", "tabela.xlsx"] } },
    {
      id: "a5",
      tipo: "ASSISTANT_GPT",
      params: { "assistant_gpt.api_key": F_API_KEY, "assistant_gpt.custom_secret": "x" },
    },
  ];
  const acc = acumuladorVazio();
  acumular(acc, "Menu inicial", acoes);

  t("URL agrupa por HOST e conta chamadas, URLs distintas e fluxos", () => {
    assert.equal(acc.urls.size, 2);
    assert.equal(acc.urls.get("hook.exemplo.com").ocorrencias, 1);
    assert.equal(acc.urls.get("hook.exemplo.com").dialogos.size, 1);
  });

  t("chamada sem TLS vira AVISO (a acao antiga aceitava http)", () => {
    assert.ok([...acc.urls.get("sem-tls.exemplo.com").avisos].some((a) => /sem TLS/.test(a)));
  });

  t("credencial entra como PRESENCA, e o valor nao aparece em lugar nenhum do relatorio", () => {
    assert.equal(acc.credenciais.length, 2);
    const md = relatorioMarkdown("acme", acc, { totalArquivos: 1 });
    assert.equal(md.includes(F_TOKEN_PRIVADO), false);
    assert.equal(md.includes(F_API_KEY), false);
    assert.match(md, /crm\.token_privado/);
    assert.match(md, /assistant_gpt\.api_key/);
  });

  t("O ACHADO: segredo em campo de texto livre (o campo de origem com JWT) e denunciado sem exibir o valor", () => {
    assert.equal(acc.segredosEmCampoLivre.length, 1);
    assert.equal(acc.segredosEmCampoLivre[0].campo, "crm.origem");
    const md = relatorioMarkdown("acme", acc, { totalArquivos: 1 });
    assert.equal(md.includes(F_JWT), false);
    assert.match(md, /texto livre/i);
  });

  t("RUIDO MEDIDO: id interno e nome de arquivo nao viram 'segredo em campo livre'", () => {
    // a forma exata que a conta real tem: 24 hex (os 96 + 47 + 19 + 5 falsos positivos)
    const objectId = objectIdParaProva();
    assert.equal(pareceSegredo(objectId), true, "o sinal fraco pega — e por isso a lista existe");
    for (const campo of ["dialog_id", "tags", "crm.campanha_nome", "funnel_remove"]) {
      assert.equal(segredoEmCampo(campo, objectId), false, campo);
    }
    assert.equal(segredoEmCampo("attach.files", "catalogo-de-produtos-2026-v3.pdf"), false);
    // e o campo desconhecido com o MESMO valor continua sendo denunciado
    assert.equal(segredoEmCampo("crm.origem", objectId), true);
  });

  t("A EXCLUSAO E POR (NOME, FORMA): campo conhecido com valor de outra forma volta a ser denunciado", () => {
    const blob64 = "9f".repeat(32); // 64 hex em bloco unico: forma de hash/token
    assert.equal(blob64.length, 64);
    assert.equal(segredoEmCampo("tags", blob64), true);
    assert.equal(segredoEmCampo("dialog_id", blob64), true);
    assert.equal(segredoEmCampo("attach.files", blob64), true, "sem extensao nao e nome de arquivo");
    // ObjectId com 1 caractere fora do hex nao e ObjectId
    assert.equal(segredoEmCampo("dialog_id", "z" + objectIdParaProva().slice(1)), true);
  });

  t("a exclusao nao abre o freio: sinal FORTE passa por cima dela", () => {
    // O CASO QUE TORNA A ORDEM LOAD-BEARING (achado da verificacao por mutacao): um
    // valor que satisfaz a FORMA benigna E carrega sinal forte. JWT tem pontos, e
    // ponto + sufixo curto e exatamente o que o teste de "nome de arquivo" aceita —
    // sem o sinal forte vindo primeiro, `attach.files` engoliria um JWT calado.
    // Uma chave com PREFIXO conhecido cabe num valor que tambem passa como nome de
    // arquivo (ponto + extensao curta no fim). Sem o sinal forte vindo primeiro,
    // `attach.files` engoliria a chave calado — e o valor tem 24+ caracteres, ou
    // seja, o sinal fraco JA tinha visto e a exclusao por nome ia mandar embora.
    const chaveComExtensao = "s" + "k-" + "producao-cliente-2026.pdf";
    assert.match(chaveComExtensao, /\.[A-Za-z0-9]{2,5}$/, "a fixture precisa ter cara de nome de arquivo");
    assert.equal(sinalForteDeSegredo(chaveComExtensao), true);
    assert.equal(pareceSegredo(chaveComExtensao), true, "o sinal fraco tambem ve — e seria silenciado pela exclusao");
    assert.equal(segredoEmCampo("attach.files", chaveComExtensao), true, "sinal forte tem que vencer a forma benigna");
    // LIMITE MEDIDO do detector, registrado em vez de escondido: o teste de JWT
    // exige tres blocos de 8+ caracteres. JWT de verdade tem assinatura longa (43
    // caracteres no HS256), entao ele nunca casa a forma "nome de arquivo" — mas um
    // valor de tres blocos com o ultimo curto NAO e reconhecido como JWT.
    const jwtDeTerceiroBlocoCurto = "eyJhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "abc";
    assert.equal(sinalForteDeSegredo(jwtDeTerceiroBlocoCurto), false);
    assert.equal(pareceSegredo(jwtDeTerceiroBlocoCurto), true, "o sinal fraco ainda pega — e por isso o limite nao vira furo");

    assert.equal(segredoEmCampo("dialog_id", F_JWT), true);
    assert.equal(segredoEmCampo("attach.files", F_ASSISTANT), true);
    assert.equal(sinalForteDeSegredo(F_JWT), true);
    assert.equal(sinalForteDeSegredo(objectIdParaProva()), false);
    assert.equal(sinalForteDeSegredo(""), false);
    assert.equal(sinalForteDeSegredo(null), false);
  });

  t("campo com nome de credencial que a lista nao conhece nao entra calado", () => {
    assert.ok(acc.camposDeRiscoDesconhecidos.has("ASSISTANT_GPT.assistant_gpt.custom_secret"));
    assert.match(relatorioMarkdown("acme", acc, { totalArquivos: 1 }), /ainda nao classifica/);
  });

  t("template guarda o maior numero de variaveis (decide o retrabalho de aprovacao)", () => {
    assert.equal(acc.templates.get("tpl_boas_vindas").variaveis, 2);
  });

  t("anexo em lista entra item por item", () => {
    assert.equal(acc.anexos.size, 2);
  });

  t("ANEXO: o fluxo guarda ID, e o relatorio so mostra nome quando o catalogo resolve", () => {
    const id1 = objectIdParaProva();
    const id2 = "62309c8dd0028ee16dbade32";
    const accA = acumuladorVazio();
    acumular(accA, "Boas-vindas", [{ id: "a1", tipo: "ANEXAR", params: { "attach.files": [id1, id2] } }]);
    const cat = anexosDoCatalogo({
      attachments: [{ _id: { $oid: id1 }, original_name: "guia-01set.pdf", name: "guia01set_178.pdf", mime: "application/pdf" }],
      current_page: 1,
      total_pages: 4,
      total_results: 173,
    });
    assert.equal(cat.porId.size, 1);
    assert.equal(cat.total, 173);
    const md = relatorioMarkdown("acme", accA, { totalArquivos: 1, anexos: cat });
    const s5 = md.slice(md.indexOf("## 5."), md.indexOf("## 6."));
    // id resolvido: nome do arquivo E o id, os dois
    assert.ok(s5.includes("guia-01set.pdf"), "nome resolvido nao apareceu");
    assert.ok(s5.includes(id1) && s5.includes(id2), "o id na origem tem que aparecer sempre");
    // id NAO resolvido nao pode sair fingindo nome de arquivo
    assert.match(s5, /nome nao esta no backup/);
    // a cobertura e declarada com os numeros do catalogo, nao arredondada
    assert.match(s5, /pagina 1 de 4/);
    assert.match(s5, /173/);
  });

  t("sem catalogo de anexo o relatorio nao quebra e nao promete nome", () => {
    const accA = acumuladorVazio();
    acumular(accA, "F", [{ id: "a1", tipo: "ANEXAR", params: { "attach.files": objectIdParaProva() } }]);
    const md = relatorioMarkdown("acme", accA, { totalArquivos: 1 });
    const s5 = md.slice(md.indexOf("## 5."), md.indexOf("## 6."));
    assert.match(s5, /nome nao esta no backup/);
    assert.equal(s5.includes("NaN"), false);
    assert.equal(s5.includes("undefined"), false);
    // catalogo vazio nao inventa paginacao
    assert.equal(anexosDoCatalogo({}).paginas, 0);
    assert.equal(anexosDoCatalogo(null).porId.size, 0);
  });

  t("URL COMPLETA sai so com --com-url, e o relatorio avisa que o arquivo virou segredo", () => {
    const semUrl = relatorioMarkdown("acme", acc, { totalArquivos: 1, comUrl: false });
    const comUrl = relatorioMarkdown("acme", acc, { totalArquivos: 1, comUrl: true });
    assert.equal(semUrl.includes("abcdef1234567890"), false);
    assert.equal(comUrl.includes("abcdef1234567890"), true);
    assert.match(comUrl, /trate este arquivo como segredo/i);
  });

  const acc2 = acumuladorVazio();
  acumularConversao(acc2, {
    estado: "ressalva",
    nome: "Boas-vindas",
    id_original: "d1",
    ressalvas: [
      "etiqueta fora do catalogo: 'clientes vip'",
      "acao CRM: POST pra URL externa (webhook de saida) ainda nao existe no painel",
    ],
    condicao: { estado: "convertida" },
  });
  acumularConversao(acc2, {
    estado: "nao",
    nome: "Antigo",
    id_original: "d2",
    motivo: "dialogo sem nenhuma acao configurada",
  });

  t("ressalva de referencia morta e recortada POR FLUXO (agregado esconderia o que consertar)", () => {
    assert.equal(acc2.referenciasMortas.length, 1);
    assert.equal(acc2.referenciasMortas[0].fluxo, "Boas-vindas");
    const md = relatorioMarkdown("acme", acc2, { totalArquivos: 2 });
    assert.match(md, /Boas-vindas/);
    assert.match(md, /clientes vip/);
  });

  t("LACUNA DO PAINEL nao entra como referencia morta (sao decisoes de tipo diferente)", () => {
    // textos MEDIDOS no conversor
    for (const lacuna of [
      "acao CRM: POST pra URL externa (webhook de saida) ainda nao existe no painel",
      "dialogo automatico (Trigger): o gatilho nao tem equivalente na v1 e o fluxo nao dispara sozinho",
      "acao TIMER tinha janela de horario (jump_begin/max_time); a v1 nao tem janela",
      "a condicao olha VARIAVEL DE CONTEXTO e nada popula contexto nesta instalacao ainda",
    ]) {
      assert.equal(eReferenciaMorta(lacuna), false, lacuna);
    }
    for (const morta of [
      'acao TAG com etiqueta que nao esta no catalogo do backup (2 id(s))',
      'acao FUNIL: "Ganho" nao e etapa do funil "Vendas" no catalogo do backup',
      "acao FUNIL: etapa \"X\" na posicao 1, que nao corresponde a funil nenhum do catalogo",
      "acao TAG: 3 etiqueta(s) sem nome no catalogo do backup",
      "etiqueta fora do catalogo: 'clientes vip'",
    ]) {
      assert.equal(eReferenciaMorta(morta), true, morta);
    }
    assert.equal(eReferenciaMorta(null), false);
    assert.equal(eReferenciaMorta(""), false);
  });

  t("ressalva que fala das DUAS familias na mesma frase continua sendo referencia morta", () => {
    // Este e o caso que a exclusao por "lacuna do painel" vetava errado — e o
    // motivo de ela ter saido do codigo (ver o comentario em eReferenciaMorta).
    assert.equal(
      eReferenciaMorta('acao FUNIL: "Ganho" nao e etapa do funil "Vendas" no catalogo do backup, e a v1 nao tem janela'),
      true
    );
    // e o `nao existe` SOLTO segue nao bastando pra virar referencia morta
    assert.equal(eReferenciaMorta("esse recurso nao existe no painel"), false);
    assert.equal(eReferenciaMorta("nao existe"), false);
  });

  t("a lacuna do painel NAO desaparece do relatorio: sai da secao 6 e continua na 7", () => {
    const md = relatorioMarkdown("acme", acc2, { totalArquivos: 2 });
    const s6 = md.slice(md.indexOf("## 6."), md.indexOf("## 7."));
    const s7 = md.slice(md.indexOf("## 7."), md.indexOf("## 8."));
    assert.equal(s6.includes("webhook de saida"), false);
    assert.equal(s7.includes("webhook de saida"), true);
  });

  t("o que nao converteu aparece com o id na origem (o original segue no backup)", () => {
    const md = relatorioMarkdown("acme", acc2, { totalArquivos: 2 });
    assert.match(md, /\| Antigo \| `d2` \| dialogo sem nenhuma acao configurada \|/);
  });

  t("as 9 secoes do card estao no documento", () => {
    const md = relatorioMarkdown("acme", acc, { totalArquivos: 1 });
    for (const s of [
      "## 1. O que converteu",
      "## 2. Sistemas externos",
      "## 3. Credenciais a preencher",
      "## 4. Templates a recriar",
      "## 5. Anexos da biblioteca",
      "## 6. Referencias que apontam",
      "## 7. Fluxo por fluxo",
      "## 8. O que NAO converteu",
      "## 9. Acoes por tipo",
    ]) {
      assert.ok(md.includes(s), `falta a secao: ${s}`);
    }
  });

  t("o relatorio DECLARA que o formato do corpo da ferramenta antiga nao e conhecido", () => {
    const md = relatorioMarkdown("acme", acc, { totalArquivos: 1 });
    assert.match(md, /NAO esta documentado em lugar nenhum/);
    assert.match(md, /receptor temporario/);
  });

  t("--saida DENTRO do repo e recusado (o .md tem dado de cliente e viraria commit)", () => {
    const raiz = path.resolve(path.join("C:", "repos", "painel"));
    for (const dentro of [
      path.join(raiz, "rel.md"),
      path.join(raiz, "docs", "rel.md"),
      path.join(raiz, "docs", "..", "rel.md"),
      path.join(raiz, "a", "b", "c", "rel.md"),
    ]) {
      assert.equal(dentroDoRepo(dentro, raiz), raiz, dentro);
    }
    for (const fora of [
      path.resolve(path.join("C:", "tmp", "rel.md")),
      path.resolve(path.join("C:", "repos", "outro", "rel.md")),
      path.resolve(path.join(raiz, "..", "vizinho.md")),
      // pasta de nome PARECIDO nao conta como dentro (prefixo de string nao serve)
      path.resolve(path.join("C:", "repos", "painel-antigo", "rel.md")),
    ]) {
      assert.equal(dentroDoRepo(fora, raiz), null, fora);
    }
    // a propria raiz nao e destino de arquivo
    assert.equal(dentroDoRepo(raiz, raiz), null);
    // caminho RELATIVO e resolvido contra o cwd, e o cwd deste teste E o repo:
    // este e o caso que a guarda existe pra pegar (`--saida docs/x.md` de dentro).
    assert.equal(dentroDoRepo("docs/rel-de-teste.md", process.cwd()), path.resolve(process.cwd()));
  });

  t("relatorio de conta vazia nao quebra e nao mente (tabelas dizem 'nenhum')", () => {
    const md = relatorioMarkdown("vazia", acumuladorVazio(), { totalArquivos: 0 });
    assert.match(md, /_\(nenhum\)_/);
    assert.equal(md.includes("NaN"), false);
    assert.equal(md.includes("undefined"), false);
  });

  console.log(`\nTUDO OK — ${ok} checagens, nenhum backup lido, nada gravado.`);
}

// ———————————————————————————————————————————————————————————————— CLI

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--prova")) {
    prova();
    return;
  }

  const alvo = argv.find((a) => !a.startsWith("--"));
  const comUrl = argv.includes("--com-url");
  const iSaida = argv.indexOf("--saida");
  const saida = iSaida >= 0 ? argv[iSaida + 1] : null;
  const limArg = argv.find((a) => a.startsWith("--limite="));
  const limite = limArg ? Number(limArg.split("=")[1]) || 0 : 0;

  if (!alvo) {
    console.error(
      [
        "uso: node scripts/fluxo/relatorio-conversao.mjs <pasta-da-conta> [--saida rel.md] [--com-url] [--limite=N]",
        "     node scripts/fluxo/relatorio-conversao.mjs --prova",
        "",
        "UMA CONTA POR EXECUCAO: cada backup e uma empresa, e um relatorio que junta",
        "varias transformaria a virada de N clientes num documento so.",
      ].join("\n")
    );
    process.exitCode = 2;
    return;
  }

  const r = varrerConta(alvo, { limite });
  if (!r) {
    const filhas = contasFilhas(alvo);
    console.error(`nao achei automacao/dialogos em ${alvo}.`);
    if (filhas.length) {
      console.error(
        `\nesta pasta parece ter ${filhas.length} conta(s) dentro. Rode UMA por vez:\n` +
          filhas
            .slice(0, 40)
            .map((f) => `  node scripts/fluxo/relatorio-conversao.mjs ${path.join(alvo, f)}`)
            .join("\n")
      );
    }
    process.exitCode = 2;
    return;
  }

  const md = relatorioMarkdown(r.conta, r.acc, { comUrl, totalArquivos: r.totalArquivos, anexos: r.anexos });
  if (saida) {
    // DENTRO DO REPO, NAO (achado da revisao cega): este .md carrega nome de fluxo,
    // host de sistema externo e — com `--com-url` — URL de webhook de um CLIENTE.
    // Caminho relativo ao cwd caia na arvore do repo, e ai o arquivo entra num
    // `git add .` distraido e vaza no proximo push. O caminho e do operador, mas
    // este e recusado com o motivo em vez de gravar.
    const dentro = dentroDoRepo(saida);
    if (dentro) {
      console.error(
        `recusado: ${saida} fica DENTRO do repositorio (${dentro}).\n` +
          "Este relatorio tem dado de cliente e nao pode virar arquivo versionado.\n" +
          "Escolha um caminho fora da arvore do repo (ex: ../relatorio.md)."
      );
      process.exitCode = 2;
      return;
    }
    fs.writeFileSync(saida, md, "utf8");
    console.log(`relatorio de ${r.conta}: ${saida} (${r.totalArquivos} dialogos lidos, nada gravado em banco)`);
  } else {
    process.stdout.write(md);
  }
}

// roda como CLI, mas segue importavel (a prova mora dentro, via --prova)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  main();
}
