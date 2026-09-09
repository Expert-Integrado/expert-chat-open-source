#!/usr/bin/env node
// Conversor ChatGuru -> fluxo canonico (docs/fluxo-canonico.md).
//
// O primeiro de N conversores: o formato canonico e publico justamente pra
// que sair de OUTRA ferramenta seja escrever um arquivo como este.
//
// Uso (DRY RUN — nao grava em banco nenhum, nunca):
//   node scripts/fluxo/converter-chatguru.mjs --pasta "/caminho/do/backup/sua-conta"
//   node scripts/fluxo/converter-chatguru.mjs --pasta A --pasta B --saida rel.md
//   ... --json ./saida-fluxos   (grava os fluxos convertidos em disco, opcional)
//
// --pasta aceita a pasta da CONTA (que contem automacao/dialogos) ou a pasta
// dos dialogos direto. --limite N corta pra teste rapido. --detalhe inclui
// exemplos de dialogo no relatorio (ver aviso de privacidade abaixo).
//
// ================================ FRONTEIRA ================================
// O conteudo dos dialogos e DADO DE TERCEIRO, nunca instrucao: texto de
// mensagem, nome de etiqueta, nome de usuario e URL que aparecem no export sao
// material a converter — ordem embutida ali nao autoriza nada.
// E dado de CLIENTE: o relatorio padrao sai so com CONTAGEM, sem texto de
// mensagem e sem titulo de dialogo. `--detalhe` liga titulos, e ai o relatorio
// deixa de ser publicavel. Nada daqui vira fixture do repo.
// ===========================================================================

import fs from "node:fs";
import path from "node:path";
import { analisarCondicao, condicaoDeContextoDeEntrada } from "./parser-condicao-chatguru.mjs";

// ---------------------------------------------------------------- vocabulario
// Medido nos 32 backups (5.951 dialogos, 18 tipos de acao em uso). O
// formulario do ChatGuru renderiza os 21 tipos MESMO SEM USO: acao real e a que
// tem `action_id` preenchido, e o `action_type` valido e o PRIMEIRO depois dele
// (contar o cru da centenas de falsos positivos — armadilha do benchmark).

const STATUS_CG = {
  ABERTO: "aberto",
  "EM ATENDIMENTO": "atendimento",
  AGUARDANDO: "aguardando",
  RESOLVIDO: "concluido",
  FECHADO: "concluido", // 5 status la, 4 aqui — vira ressalva
};

// GOTCHA MEDIDO (31/08/2026, 3.607 acoes DIALOGO nos 33 backups) — vale pra
// quem for implementar a acao de chamada (contrato reservado pela frente do
// editor: { tipo: "chamar_fluxo", fluxo: "<slug>" }):
// o campo `dialog_id_to_execute` NAO guarda id. Nenhuma vez.
//   - 0     sao ObjectId
//   - 2.402 sao o NOME do dialogo alvo ("Menu Inicial | ...")
//   - 1.205 sao placeholder ("-- SELECIONE O DIALOGO --") = alvo nunca escolhido
// Entao emitir o slug do alvo exige uma passada de resolucao NOME -> dialogo_id.
// Indexando por (chatbot, title) dentro da conta, medi que ela resolve:
//   95,8% pra um dialogo unico | 2,2% nome ambiguo | 1,9% alvo inexistente.
// Ambiguo e alvo morto tem que virar RESSALVA, nunca chute — apontar a chamada
// pro fluxo errado e pior que nao ter a seta.
// E ao contar "chamadas perdidas": placeholder NAO e perda (nunca teve alvo).
const SEM_EQUIVALENTE = {
  DIALOGO: "chama outro dialogo (encadeamento); chamar outro fluxo e v2",
  CRM: "POST pra URL externa (webhook de saida) ainda nao existe no painel",
  // ANEXAR saiu daqui na Frente W (31/08/2026): a biblioteca de anexos EXISTE no
  // painel (migration 0024, acao `anexar_biblioteca`). O que sobra sem equivalente
  // e o caso em que o ARQUIVO nao foi importado — e isso e ressalva com motivo
  // NOMEADO no case "ANEXAR", nao um verbete generico aqui.
  TEMPLATE: "dispara template WABA aprovado; envio de template ainda nao e acao de fluxo",
  TEMPLATE_MIDIA: "template WABA com midia; envio de template ainda nao e acao de fluxo",
  LEITURA: "marca chat lido/nao lido; ainda nao e acao da v1",
  ENCAMINHAR: "encaminha a conversa; ainda nao e acao da v1",
  CUSTOMFIELD: "grava campo personalizado; ainda nao e acao da v1",
  NPS: "dispara pesquisa NPS; o painel tem CSAT, nao NPS gerenciado",
  INTERACTIVE_LIST: "mensagem com lista interativa; so texto na v1",
  INTERACTIVE_QUICK_REPLY: "mensagem com botoes; so texto na v1",
  INTERACTIVE_PRODUCT: "mensagem de produto; so texto na v1",
  TEMPLATE_LOCATION: "template de localizacao; so texto na v1",
  RENAME_CHAT: "renomeia o chat; ainda nao e acao da v1",
  ASSISTANT_GPT: "chama assistant da OpenAI; o agente que conversa e outro produto",
};

const PLACEHOLDERS = new Set(["- Selecione -", "- SELECIONE -", "-- SELECIONE O DIÁLOGO --", "- Selecione a Etapa -"]);

const limpo = (v) => (typeof v === "string" ? v.trim() : "");
const vazio = (v) => !limpo(v) || PLACEHOLDERS.has(limpo(v));

// ------------------------------------------------------------------- parser
// Fatiar a lista plana de campos do formulario nas acoes REAIS.
export function acoesDoDialogo(campos) {
  const acoes = [];
  const lista = Array.isArray(campos) ? campos : [];
  for (let i = 0; i < lista.length; i++) {
    if (lista[i]?.nome !== "action_id" || !limpo(lista[i]?.valor)) continue;
    // o action_type valido e o PRIMEIRO depois do action_id preenchido
    let tipo = null;
    let j = i + 1;
    for (; j < lista.length; j++) {
      if (lista[j]?.nome === "action_type") {
        tipo = limpo(lista[j].valor);
        break;
      }
      if (lista[j]?.nome === "action_id") break;
    }
    if (!tipo) continue;
    // os campos da acao vao ate o proximo action_id/action_type
    const params = {};
    for (let k = j + 1; k < lista.length; k++) {
      const n = lista[k]?.nome;
      if (n === "action_id" || n === "action_type") break;
      if (!n) continue;
      // campo repetido (ex: steps_ids) vira lista
      if (n in params) params[n] = [].concat(params[n], lista[k].valor);
      else params[n] = lista[k].valor;
    }
    acoes.push({ id: limpo(lista[i].valor), tipo, params });
  }
  return acoes;
}

export function cabecalhoDoDialogo(campos) {
  const lista = Array.isArray(campos) ? campos : [];
  const fim = lista.findIndex((c) => c?.nome === "action_id" && limpo(c?.valor));
  const head = {};
  for (const c of lista.slice(0, fim < 0 ? lista.length : fim)) {
    if (c?.nome && !(c.nome in head)) head[c.nome] = c.valor;
  }
  return head;
}

/**
 * Flag booleana do export, com FALHA FECHADA.
 *
 * O ChatGuru grava "True" (Python) e o campo so aparece quando marcado (checkbox
 * desmarcado nao e submetido). Mas `limpo()` devolve "" pra tudo que nao e string:
 * um export que trouxesse `true` (boolean do JSON) ou `1` (number) — coisa que muda
 * com a versao do painel, e que ninguem controla daqui — virava `false` em silencio
 * e a exigencia de aval SUMIA sem ressalva. Freio que falha aberto nao e freio.
 *
 * Entao: boolean e number sao entendidos; valor PRESENTE mas irreconhecivel conta
 * como LIGADO e sai com ressalva (quem le decide, mas ninguem perde a marca).
 * Ausente ou vazio segue valendo `false` — ai nao ha o que interpretar.
 *
 * Devolve `{ ligada, estranho, bruto }` em vez de um booleano porque a ressalva e
 * do CHAMADOR: so ele sabe de qual acao esta falando.
 */
function flagDeAcao(v) {
  if (v === undefined || v === null) return { ligada: false, estranho: false };
  if (typeof v === "boolean") return { ligada: v, estranho: false };
  if (typeof v === "number") return { ligada: Number.isFinite(v) && v !== 0, estranho: false };
  const t = limpo(v).toLowerCase();
  if (!t) return { ligada: false, estranho: false };
  if (/^(true|1|sim|yes|on|t)$/.test(t)) return { ligada: true, estranho: false };
  if (/^(false|0|nao|n[ãa]o|no|off|f)$/.test(t)) return { ligada: false, estranho: false };
  // inclui o caso do campo REPETIDO (que o parser transforma em lista): duas marcas
  // no mesmo bloco viram "true,true" aqui, e isso e "presente e ilegivel", nao "nao".
  return { ligada: true, estranho: true, bruto: t.slice(0, 40) };
}

/**
 * Acoes canonicas que ALCANCAM O CLIENTE.
 *
 * COPIA DELIBERADA de `ACOES_QUE_ALCANCAM_CLIENTE` (lib/fluxo/schema.ts): este
 * script tem que rodar mesmo onde o Node nao le TypeScript (ele so importa o schema
 * dinamicamente, na passada --json, e avisa quando nao consegue). A divergencia
 * entre as duas listas e travada por assertion na prova (scripts/prova-fluxo.ts),
 * que importa as duas pontas e compara.
 */
// FRENTE Y (31/08/2026): `perguntar_opcoes` entrou na lista do schema. Ela NAO e
// emitida por este conversor (nao existe acao equivalente no export do ChatGuru),
// entao a linha aqui e so paridade — e paridade e o que a assertion cobra.
export const ALCANCAM_CLIENTE = ["enviar_texto", "anexar_biblioteca", "perguntar_opcoes"];

// Sentinelas de "sem limite" do ChatGuru: 999 e 9999 sao os valores de fabrica da
// tela, nao limite que alguem escolheu. Medido nos 33 backups: 3.484 dialogos com
// 9999 e 2.024 com 999 — tratar isso como teto real faria a v1 recusar execucao numa
// conversa depois de 999 mensagens por causa de um default.
//
// IGUALDADE, nunca `< 999`: com o teste por faixa, todo valor de 1000 a 9998 caia no
// mesmo balde da sentinela e era DESCARTADO em silencio — mas 1000, 2000, 5000 e
// limite DIGITADO por alguem, e a unica leitura honesta e honrar (com ressalva, ja
// que o numero e alto o bastante pra ser suspeito de tentativa de "sem limite").
const SENTINELAS_SEM_LIMITE = new Set([999, 9999]);
// teto do schema (LIMITE_MAXIMO_POR_CONVERSA): acima disso `validarFluxo` recusaria
// o fluxo INTEIRO por causa de um limite — melhor nao aplicar o limite e dizer.
const TETO_MAXIMO_POR_CONVERSA = 9998;

/**
 * Numero de um campo do export — irmao do `flagDeAcao`, e pelo MESMO motivo.
 *
 * `limpo()` devolve "" pra tudo que nao e string, e `Number("")` e 0: um campo
 * numerico que chegasse como NUMBER (JSON de outra versao do painel, export
 * re-serializado, script de terceiro) virava ZERO em silencio. Duas perdas caladas
 * que isso causava:
 *   - atraso: `execute_date_days: 2` (number) fazia o no de ESPERA nao nascer, e a
 *     regua de 2 dias passava a mandar tudo na hora;
 *   - limite: `max_executions_per_chat: 5` (number) virava `null`, ou seja "sem
 *     limite" — o oposto do que estava configurado.
 *
 * Regra: number e string numerica valem; ausente/vazio vale 0 (nao ha o que
 * interpretar); PRESENTE mas ilegivel devolve 0 **e avisa** (`estranho`), porque
 * chutar em cima de valor que ninguem entende e como perder o valor.
 */
function numeroDoCampo(v) {
  if (v === undefined || v === null) return { n: 0, estranho: false };
  if (typeof v === "number") {
    return Number.isFinite(v) ? { n: v, estranho: false } : { n: 0, estranho: true, bruto: String(v) };
  }
  const t = limpo(v);
  if (!t) return { n: 0, estranho: false };
  // aceita "2", " 2 ", "2.0" e "2,5" (virgula decimal aparece em campo digitado)
  const x = Number(t.replace(",", "."));
  if (Number.isFinite(x)) return { n: x, estranho: false };
  return { n: 0, estranho: true, bruto: t.slice(0, 40) };
}

/**
 * Atraso da acao, em segundos (dias/horas/min/seg + execution_delay).
 *
 * `ressalvas` e `contexto` entram porque valor ilegivel NAO pode sumir calado: o
 * atraso e o que separa "regua de 2 dias" de "tudo na mesma hora".
 */
function atrasoSegundos(p, ressalvas = [], contexto = "") {
  const n = (v, campo) => {
    const r = numeroDoCampo(v);
    if (r.estranho) {
      ressalvas.push(
        `${contexto ? `acao ${contexto}: ` : ""}valor irreconhecivel no atraso (${campo} = "${r.bruto}") — tratado como 0; conferir`
      );
    }
    return r.n > 0 ? r.n : 0;
  };
  return (
    n(p.execute_date_days, "dias") * 86400 +
    n(p.execute_date_hours, "horas") * 3600 +
    n(p.execute_date_minutes, "minutos") * 60 +
    n(p.execute_date_seconds, "segundos") +
    n(p.execution_delay, "execution_delay")
  );
}

// "NORMAL - Concierge | ADMIN - Barbara" -> ["Concierge", "Barbara"]
function nomesSeparados(v) {
  return String(v ?? "")
    .split("|")
    .map((s) => s.trim().replace(/^(ADMIN|NORMAL|SUPERVISOR)\s*-\s*/i, "").trim())
    .filter(Boolean);
}

/**
 * Item da biblioteca por NOME DE ARQUIVO, e SO quando o nome e unico no mapa.
 *
 * Devolve o item, `null` (nao achou) ou a marca "ambiguo". Duas linhas com o
 * mesmo nome existem de verdade no acervo medido (o importador desempata a CHAVE
 * com sufixo, mas o NOME continua repetido) — e escolher uma delas mandaria o
 * material errado pro cliente.
 */
function resolverAnexoPorNome(ctx, valor) {
  // O PONTO E ESCAPADO. Sem a barra ele e metacaractere e a guarda casa
  // QUALQUER texto com 2-5 alfanumericos no fim — "catalogo", "Tabela de Precos"
  // e ate um ObjectId de 24 hex passavam. A metade "so quando parece nome de
  // arquivo" da guarda era inerte (medido na revisao cega da Frente W).
  if (!/\.[A-Za-z0-9]{2,5}$/.test(String(valor))) return null;
  const alvo = String(valor).trim().toLowerCase();
  let achado = null;
  for (const item of ctx.anexos.values()) {
    if (String(item?.nome ?? "").trim().toLowerCase() !== alvo) continue;
    if (achado) return "ambiguo";
    achado = item;
  }
  return achado;
}

// ---------------------------------------------------------------- conversao
// Traduz UMA acao do ChatGuru. Devolve {acao} ou {ressalva}.
function converterAcao(a, ctx) {
  const p = a.params || {};
  switch (a.tipo) {
    case "RESPONDER": {
      const texto = limpo(p["reply.text"]);
      if (!texto) return { ressalva: "acao RESPONDER sem texto (so midia ou vazia)" };
      if (texto.length > 4096) return { ressalva: "acao RESPONDER com texto acima de 4096 caracteres" };
      return { acao: { tipo: "enviar_texto", texto } };
    }
    case "ANOTAÇÃO": {
      const texto = limpo(p.note_text);
      if (!texto) return { ressalva: "acao ANOTACAO sem texto" };
      return { acao: { tipo: "nota_interna", texto: texto.slice(0, 4000) } };
    }
    case "STATUS": {
      const bruto = limpo(p["status.status"]);
      if (vazio(bruto)) return { ressalva: "acao STATUS sem status escolhido" };
      const status = STATUS_CG[bruto];
      if (!status) return { ressalva: `acao STATUS com valor desconhecido (${bruto})` };
      const acao = { tipo: "mudar_status", status };
      if (bruto === "FECHADO") {
        return { acao, ressalva: "status FECHADO virou concluido (o ChatGuru tem 5 status, o painel tem 4)" };
      }
      return { acao };
    }
    case "TAG": {
      const ids = [].concat(p.tags ?? []).map(limpo).filter(Boolean);
      if (!ids.length) return { ressalva: "acao TAG sem etiqueta escolhida" };
      const nomes = [];
      const naoResolvidos = [];
      for (const id of ids) {
        const nome = ctx.etiquetas?.get(id);
        if (nome) nomes.push(nome);
        else naoResolvidos.push(id);
      }
      if (!nomes.length) {
        return { ressalva: `acao TAG com etiqueta que nao esta no catalogo do backup (${naoResolvidos.length} id(s))` };
      }
      const acao = { tipo: "etiquetar", etiquetas: nomes.slice(0, 30), modo: "adicionar" };
      if (naoResolvidos.length) {
        return { acao, ressalva: `acao TAG: ${naoResolvidos.length} etiqueta(s) sem nome no catalogo do backup` };
      }
      return { acao };
    }
    case "DELEGAR": {
      const users = nomesSeparados(p["delegate.users"]);
      const groups = nomesSeparados(p["delegate.groups"]);
      if (!users.length && !groups.length) return { ressalva: "acao DELEGAR sem usuario nem departamento" };
      const responsaveis = [
        ...users.map((n) => ({ tipo: "usuario", id: `chatguru:usuario:${n}`, nome: n })),
        ...groups.map((n) => ({ tipo: "departamento", id: `chatguru:departamento:${n}`, nome: n })),
      ];
      // O export so traz NOME de quem atende; o painel atribui por id. O fluxo
      // converte, mas nao pode ser ligado sem casar os nomes com as contas de la.
      const ressalvas = [
        "acao DELEGAR veio por NOME (o export nao traz id): casar com usuario/departamento do painel antes de ativar",
      ];
      if (limpo(p["delegate.remove_other_users"]) || limpo(p["delegate.remove_other_groups"])) {
        ressalvas.push("acao DELEGAR removia os outros responsaveis; a v1 so ACRESCENTA responsavel");
      }
      return { acao: { tipo: "atribuir_responsavel", responsaveis }, ressalvas };
    }
    case "FUNIL": {
      // COMO A ACAO DE FUNIL E LIDA (medido no acervo real em 31/08/2026):
      // o formulario do ChatGuru renderiza UM select `steps_ids` POR FUNIL da
      // conta, na MESMA ORDEM de config/chatlist_funnels.json — 16 funis, 16
      // selects em toda acao FUNIL. O valor do select e o NOME da etapa
      // escolhida (ou o placeholder "- Selecione a Etapa -").
      //
      // Isso e o que desarma a armadilha do card (11 dos 70 nomes de etapa
      // existem em mais de um funil): a POSICAO diz o funil, e o nome so e
      // procurado DENTRO dele. Conferido nas 151 acoes FUNIL da conta: 64
      // selecoes, 64 casaram por posicao — nenhum chute por nome solto.
      //
      // `funnel_remove` traz o ID do funil do qual o chat sai (resolvido por
      // id, nunca por nome).
      if (!ctx.funis?.length) {
        return { ressalva: "acao FUNIL: o backup nao tem config/chatlist_funnels.json — sem o catalogo nao da pra saber qual funil/etapa (nao se chuta por nome)" };
      }
      const selects = [].concat(p.steps_ids ?? []).map(limpo);
      if (selects.length && selects.length !== ctx.funis.length) {
        return {
          ressalva: `acao FUNIL: o formulario trouxe ${selects.length} campo(s) de etapa e a conta tem ${ctx.funis.length} funil(is) — a posicao deixou de identificar o funil, nao da pra converter sem chutar`,
        };
      }
      const acoes = [];
      const ressalvas = [];
      selects.forEach((valor, i) => {
        if (vazio(valor)) return;
        const funil = ctx.funis[i];
        const etapa = (funil?.etapas ?? []).find((e) => e.nome === valor);
        if (!funil) {
          ressalvas.push(`acao FUNIL: etapa "${valor}" na posicao ${i + 1}, que nao corresponde a funil nenhum do catalogo`);
          return;
        }
        if (!etapa) {
          ressalvas.push(`acao FUNIL: "${valor}" nao e etapa do funil "${funil.nome}" no catalogo do backup`);
          return;
        }
        acoes.push({ tipo: "mover_funil", funil: funil.nome, etapa: etapa.nome });
      });
      for (const id of [].concat(p.funnel_remove ?? []).map(limpo).filter(Boolean)) {
        const funil = ctx.funis.find((f) => f.id === id);
        if (!funil) {
          ressalvas.push(`acao FUNIL: remocao referencia funil id ${id}, que nao esta no catalogo do backup`);
          continue;
        }
        acoes.push({ tipo: "mover_funil", funil: funil.nome, etapa: null });
      }
      if (!acoes.length) {
        return {
          ressalva: ressalvas[0] || "acao FUNIL sem etapa escolhida (o formulario renderiza os selects mesmo sem uso)",
        };
      }
      return { acoes, ...(ressalvas.length ? { ressalvas } : {}) };
    }
    case "ANEXAR": {
      // FRENTE W (31/08/2026) — a acao que faltava pra 76 ocorrencias medidas nos
      // dialogos deixarem de virar ressalva.
      //
      // O CAMPO GUARDA ID, NAO NOME (medido: 61 valores em `attach.files`, 100%
      // ObjectId de 24 hex). O painel referencia o item pela CHAVE portatil, entao
      // a conversao depende do mapa id -> chave que o passo de importacao dos
      // anexos emite (`config/anexos-chaves.json`, escrito por
      // scripts/importar/anexos.mjs). Ordem da migracao: anexos ANTES dos fluxos.
      //
      // POR QUE NAO DERIVAR A CHAVE AQUI: a chave sai do NOME do arquivo, e o nome
      // mora no catalogo da biblioteca — que o backup guardou PELA METADE (uma
      // pagina). Derivar do id daria uma chave que nao existe no painel, e o passo
      // convertido apontaria pra um arquivo inexistente: o fluxo rodaria e FALHARIA
      // no cliente. Ressalva com o id na mao e pior de ler e melhor de confiar.
      const ids = [].concat(p["attach.files"] ?? []).map(limpo).filter(Boolean);
      if (!ids.length) return { ressalva: "acao ANEXAR sem arquivo escolhido" };
      if (!ctx.anexos?.size) {
        return {
          ressalva:
            `acao ANEXAR: ${ids.length} arquivo(s), e o mapa de anexos nao esta neste backup — ` +
            "rodar scripts/importar/anexos.mjs (ele grava config/anexos-chaves.json) e converter de novo",
        };
      }
      const acoes = [];
      const ressalvas = [];
      for (const id of ids) {
        // O VALOR PODE SER NOME DE ARQUIVO, nao id: a medicao aceita as duas formas
        // ("conta com biblioteca antiga pode trazer o nome"). Por id e exato; por
        // NOME so quando o nome identifica UM item, nunca no chute — nome repetido
        // vira ressalva, a mesma disciplina do case FUNIL.
        const item = ctx.anexos.get(id) ?? resolverAnexoPorNome(ctx, id);
        if (item === "ambiguo") {
          ressalvas.push(
            `acao ANEXAR: "${id}" e nome de arquivo e o mapa tem mais de um item com esse nome — apontar o passo pelo item certo na tela da biblioteca`
          );
          continue;
        }
        if (!item?.chave) {
          // NAO ESTA NO MAPA. Com catalogo parcial isto significa "nao capturado",
          // nao "nao existe" — e a frase diz qual dos dois, porque a acao do dono do
          // fluxo e diferente em cada caso.
          ressalvas.push(
            `acao ANEXAR: o arquivo ${id} nao esta no mapa de anexos importados` +
              (ctx.anexosParcial
                ? " (o catalogo capturado e PARCIAL: pedir as demais paginas ao coletor ou subir o material pela tela da biblioteca)"
                : " (subir o material pela tela da biblioteca e apontar o passo pra ele)")
          );
          continue;
        }
        acoes.push({ tipo: "anexar_biblioteca", anexo: item.chave });
      }
      if (!acoes.length) return { ressalva: ressalvas[0] || "acao ANEXAR sem arquivo que exista na biblioteca" };
      // SEM LEGENDA: o unico campo MEDIDO desta acao e `attach.files` (61 valores
      // nos backups). O passo do painel aceita `legenda`, e deixar de preencher e
      // deliberado — inventar um campo de origem que ninguem mediu seria colocar
      // texto no envio ao cliente sem ter visto esse texto em lugar nenhum.
      return { acoes, ...(ressalvas.length ? { ressalvas } : {}) };
    }
    case "DIALOGO": {
      // Duas situacoes MUITO diferentes que davam a mesma ressalva ate 31/08:
      //   (a) alvo nunca escolhido (placeholder) — 1.205 no acervo. Nao ha
      //       chamada nenhuma pra trazer: isso NAO e perda de importacao.
      //   (b) alvo nomeado — 2.402. Aqui existe aresta de verdade esperando a
      //       acao de chamada (e a passada nome -> id descrita no topo).
      // Quem le a ressalva depois (mapa da rede de fluxos) precisa separar os
      // dois, senao a tela acusa perda que nunca houve — em 1/3 dos casos.
      if (vazio(p.dialog_id_to_execute)) {
        return { ressalva: "acao DIALOGO sem alvo configurado (nenhum dialogo selecionado no formulario): nao havia chamada a trazer" };
      }
      return { ressalva: `acao DIALOGO: ${SEM_EQUIVALENTE.DIALOGO}` };
    }
    default: {
      const motivo = SEM_EQUIVALENTE[a.tipo] || "tipo de acao desconhecido no vocabulario medido";
      return { ressalva: `acao ${a.tipo}: ${motivo}` };
    }
  }
}

// Converte UM dialogo. Devolve {estado, fluxo?, ressalvas[], motivo?}.
// estado: "convertido" | "ressalva" | "nao"
export function converterDialogo(dialogo, ctx = {}) {
  const campos = dialogo?.campos;
  const idOriginal = limpo(dialogo?.dialogo_id) || limpo(dialogo?.id) || "sem-id";
  if (!Array.isArray(campos) || !campos.length) {
    return { estado: "nao", id_original: idOriginal, motivo: "arquivo sem campos de formulario" };
  }
  const head = cabecalhoDoDialogo(campos);
  const nodeType = limpo(head.node_type);
  const manual = /^Manual/i.test(nodeType);
  const brutas = acoesDoDialogo(campos);
  if (!brutas.length) {
    // `manual` vai junto: sem ele o dialogo cairia no balde "automatico" do
    // consolidado e o recorte de macro sairia errado por alguns diálogos
    return { estado: "nao", id_original: idOriginal, motivo: "dialogo sem nenhuma acao configurada", manual };
  }

  const ressalvas = [];
  const acoes = [];
  // Paralelo a `acoes`: quais delas viram no que EXIGE aval humano. A marca nao
  // pode viajar dentro da acao porque `aprovacao` e campo do NO, nao da acao (o
  // schema recusaria a acao com campo estranho) — e o indice tem que ser mantido
  // aqui porque o no de espera entra no meio do array e desloca tudo.
  const aprovacaoPorAcao = [];
  const tiposConvertidos = [];
  const tiposRessalvados = [];

  for (const a of brutas) {
    const atraso = atrasoSegundos(a.params || {}, ressalvas, a.tipo);
    // "pular fim de semana" e "precisa de aprovacao" sao da ACAO no ChatGuru, e
    // continuam sendo aqui: numa regua com varias esperas, so algumas caem em dia
    // util, e numa cadeia com vários envios so alguns pedem aval.
    const flagFds = flagDeAcao(a.params?.jump_weekend);
    const flagAval = flagDeAcao(a.params?.need_approval);
    const fimDeSemana = flagFds.ligada;
    const precisaAval = flagAval.ligada;
    if (flagFds.estranho) {
      ressalvas.push(
        `acao ${a.tipo}: valor irreconhecivel em "pular fim de semana" ("${flagFds.bruto}") — tratado como LIGADO; conferir`
      );
    }
    if (flagAval.estranho) {
      ressalvas.push(
        `acao ${a.tipo}: valor irreconhecivel em "precisa de aprovacao" ("${flagAval.bruto}") — tratado como LIGADO; conferir`
      );
    }
    const r = converterAcao(a, ctx);
    // uma acao da origem pode virar MAIS DE UMA acao canonica (ex: FUNIL com
    // etapa escolhida em dois funis diferentes). O tipo de origem entra uma
    // vez so na contagem — senao o relatorio deixa de fechar com o export.
    const novas = r.acoes ?? (r.acao ? [r.acao] : []);
    if (novas.length) {
      let esperaCriada = false;
      if (atraso > 0) {
        if (atraso > 30 * 24 * 3600) {
          ressalvas.push(`acao ${a.tipo} tinha atraso de ${atraso}s (acima de 30 dias); atraso descartado`);
        } else {
          // `pular_fim_de_semana` mora NA ESPERA (schema): e a espera que termina
          // num sabado e precisa ser adiada pro dia util seguinte.
          acoes.push({ tipo: "espera", segundos: atraso, ...(fimDeSemana ? { pular_fim_de_semana: true } : {}) });
          aprovacaoPorAcao.push(false);
          esperaCriada = true;
        }
      }
      // A MARCA DE AVAL SO VAI ONDE A ACAO FALA COM O CLIENTE.
      //
      // Medido nos 33 backups: 796 dos 837 nos com `need_approval` eram NOTA
      // INTERNA. Marcar todos travava 631 macros que hoje rodam num clique (macro
      // com aval nao roda inline) e enchia a fila de aprovacao de anotacao que o
      // cliente nem ve — e fila cheia de ruido faz o supervisor aprovar em massa sem
      // ler, que e o fim do portao. Aprovar existe pra conferir o que SAI: nota,
      // etiqueta, status e funil sao internos e reversiveis.
      //
      // O que se perde fica DITO na ressalva, nunca em silencio.
      const foraDoCliente = new Set();
      for (const nova of novas) {
        const vale = precisaAval && ALCANCAM_CLIENTE.includes(nova.tipo);
        acoes.push(nova);
        aprovacaoPorAcao.push(vale);
        if (precisaAval && !vale) foraDoCliente.add(nova.tipo);
      }
      if (foraDoCliente.size) {
        ressalvas.push(
          `acao ${a.tipo} exigia aprovacao humana, mas ${[...foraDoCliente].join("/")} nao fala com o cliente: a exigencia NAO foi aplicada (aprovacao vale pra mensagem que sai, nao pra passo interno)`
        );
      }
      tiposConvertidos.push(a.tipo);
      // Marca de fim de semana SEM espera pra adiar nao tem onde ser aplicada — e
      // isso e diferente de "nao existe na v1": o que se perde e o caso "se for
      // sabado agora, espera segunda", que o painel nao tem. Fica dito.
      if (fimDeSemana && !esperaCriada) {
        ressalvas.push(
          `acao ${a.tipo} tinha "pular fim de semana" sem atraso a adiar; a v1 so adia espera, entao a marca nao foi aplicada`
        );
      }
    } else {
      tiposRessalvados.push(a.tipo);
      if (precisaAval) {
        // a acao NAO entrou, e a exigencia de aval morre com ela. Sem esta linha, um
        // dialogo perderia em silencio justamente o passo que alguem queria conferir.
        ressalvas.push(`acao ${a.tipo} exigia aprovacao humana e nao foi convertida; a exigencia se perdeu junto`);
      }
    }
    if (r.ressalva) ressalvas.push(r.ressalva);
    for (const x of r.ressalvas ?? []) ressalvas.push(x);
    // janela de horario da acao (so entre X e Y) nao existe na v1
    if (!vazio(a.params?.jump_begin_time) || !vazio(a.params?.jump_max_time)) {
      ressalvas.push(`acao ${a.tipo} tinha janela de horario (jump_begin/max_time); a v1 nao tem janela`);
    }
  }

  if (!acoes.length) {
    // nada aproveitavel: o motivo mais util e o tipo que dominava o dialogo
    const conta = {};
    for (const t of tiposRessalvados) conta[t] = (conta[t] || 0) + 1;
    const dominante = Object.entries(conta).sort((a, b) => b[1] - a[1])[0];
    return {
      estado: "nao",
      id_original: idOriginal,
      motivo: dominante
        ? `nenhuma acao com equivalente na v1 (predominante: ${dominante[0]})`
        : "nenhuma acao com equivalente na v1",
      // MESMO nome do caso convertido: o consolidado conta as acoes destes
      // dialogos tambem, senao o total de acoes do relatorio fica menor que a
      // realidade (e a conta nao fecha com o export bruto)
      tipos_ressalvados: tiposRessalvados,
      ressalvas: Array.from(new Set(ressalvas)),
      manual,
    };
  }

  // Gatilho e condicao: nada disso existe na v1. Dialogo AUTOMATICO importa
  // como lista de acoes e NAO dispara sozinho — tem que ficar dito.
  if (!manual) {
    ressalvas.push(
      `dialogo automatico (${nodeType || "sem node_type"}): o gatilho nao tem equivalente na v1 e o fluxo nao dispara sozinho`
    );
  }
  // LIMITES POR CONVERSA — os dois campos de cabecalho que, ate 31/08/2026, so
  // viravam ressalva "nao e aplicado na v1". Agora sao aplicados: o campo
  // `limites` existe no schema e a fila o obedece.
  //
  // Vale pra dialogo MANUAL tambem, nao so pro automatico: o campo esta preenchido
  // nos 7.462 dialogos medidos, e um macro rodado pela fila obedece o mesmo teto
  // que a ferramenta de origem aplicava. (Na execucao INLINE o limite nao entra —
  // macro instantaneo nao passa pela fila; isso esta declarado no doc.)
  const limites = limitesDoCabecalho(head, ressalvas);
  // MACRO COM PASSO DE APROVACAO NAO RODA COMO MACRO. O preflight inline recusa
  // (macro instantaneo nao tem onde parar pra esperar humano), entao ele passa a
  // rodar SO pela fila. Medido nos 33 backups: 631 macros nesta situacao, quase
  // todos por causa de nota interna. Quem importar precisa saber ANTES de ligar,
  // senao o botao do macro aparece "indisponivel" sem explicacao.
  if (manual && aprovacaoPorAcao.some((x) => x === true)) {
    ressalvas.push(
      "tem passo que exige aprovacao humana: este fluxo NAO roda mais como macro instantaneo, e sim pela fila (enfileirar + aprovar)"
    );
  }
  // CONDICAO DE ENTRADA. Sao duas no ChatGuru e elas somam: o filtro simples
  // por variavel de contexto (`context_variable_name/value`) e a expressao
  // avancada (`conditions_advanced`). Quem traduz e o analisador — e ele nunca
  // chuta: o que nao tem equivalente vira ressalva com o motivo, e a condicao
  // NAO entra pela metade (ver a regra-mae no parser).
  const condicao = condicaoDoDialogo(head, ressalvas);

  const nome = limpo(head.title) || limpo(dialogo?.nome) || `dialogo ${idOriginal}`;
  // ATENCAO, JA CUSTOU UM NUMERO ERRADO NUMA TELA (31/08/2026):
  // `ressalvas` e um CONJUNTO de avisos distintos, nao um log de ocorrencias.
  // Um fluxo com 15 chamadas perdidas e um com 1 saem daqui com a MESMA linha
  // unica. Entao esta lista sustenta PRESENCA ("este fluxo perdeu chamada"),
  // nunca CONTAGEM ("perdeu N chamadas") — quem somar linha de ressalva pra
  // contar acoes vai publicar um numero inventado, e pior: com cara de preciso.
  // Quem precisa de volume conta FLUXOS com a ressalva, ou reconta as acoes
  // direto do export. A deduplicacao e proposital (15 linhas iguais no
  // origem.ressalvas so poluiriam) e NAO deve ser removida pra virar contador.
  const unicas = Array.from(new Set(ressalvas));
  const fluxo = montarFluxo(
    {
      id: `cg-${idOriginal}`,
      nome: nome.slice(0, 200),
      tipo: manual ? "macro" : "gatilho",
      origem: { ferramenta: "chatguru", id_original: idOriginal, ressalvas: unicas },
      condicao: condicao.condicao,
      limites,
    },
    acoes,
    { aprovacao: aprovacaoPorAcao }
  );

  return {
    estado: unicas.length ? "ressalva" : "convertido",
    id_original: idOriginal,
    nome,
    fluxo,
    ressalvas: unicas,
    tipos_convertidos: tiposConvertidos,
    tipos_ressalvados: tiposRessalvados,
    condicao,
    manual,
  };
}

// junta as partes numa condicao so (mesma regra do fim de condicaoDoDialogo)
const condicaoDe = (partes) => (partes.length === 1 ? partes[0] : { tipo: "e", condicoes: partes });

// A condicao consulta variavel de contexto em algum ponto da arvore?
function leContexto(c) {
  if (!c || typeof c !== "object") return false;
  if (c.tipo === "e" || c.tipo === "ou") return (c.condicoes ?? []).some(leContexto);
  if (c.tipo === "nao") return leContexto(c.condicao);
  return c.campo === "contexto";
}

// As duas condicoes de entrada do dialogo -> UMA condicao canonica.
// Devolve {estado, condicao?, motivo?, referencias} e EMPILHA as ressalvas na
// lista do dialogo. `estado`:
//   "sem"        — o dialogo nao tinha condicao nenhuma;
//   "convertida" — virou estrutura inteira, sem perda;
//   "ressalva"   — virou estrutura, mas tem coisa a conferir;
//   "nao"        — NAO virou: o fluxo importa as ACOES sem a condicao, e a
//                  ressalva diz isso na cara (importar acao achando que a
//                  condicao veio junto e o jeito de a automacao disparar pra
//                  quem nao devia).
export function condicaoDoDialogo(head, ressalvas) {
  const partes = [];
  const referencias = {};
  let houveFalha = null;

  const entrada = condicaoDeContextoDeEntrada(head?.context_variable_name, head?.context_variable_value);
  if (entrada) {
    partes.push(entrada.condicao);
    for (const r of entrada.ressalvas) ressalvas.push(r);
  }

  let ressalvasDaCondicao = entrada?.ressalvas.length ?? 0;
  const bruta = limpo(head?.conditions_advanced);
  if (bruta) {
    const a = analisarCondicao(bruta);
    Object.assign(referencias, a.referencias);
    if (a.estado === "nao") {
      houveFalha = a.motivo;
      // a condicao de entrada por variavel, se existia, cai JUNTO: guardar so
      // metade do filtro deixaria o fluxo mais permissivo do que o original
      ressalvas.push(
        `condicao avancada NAO convertida (${a.motivo}) — o fluxo traz as ACOES, mas SEM condicao nenhuma${
          entrada ? " (nem a de variavel de contexto, que caiu junto)" : ""
        }: conferir antes de ligar`
      );
    } else {
      partes.push(a.condicao);
      ressalvasDaCondicao += a.ressalvas.length;
      for (const r of a.ressalvas) ressalvas.push(r);
    }
  }

  const assure = limpo(head?.assure_context_condition_before_execution) || "(vazio)";

  // AS RESSALVAS ABAIXO SO VALEM SE A CONDICAO ENTROU NO FLUXO. Elas ficavam
  // ANTES deste return e por isso saiam em 115 fluxos que foram gravados SEM no
  // de condicao — dizendo "a condicao foi prefixada de todo jeito" e "o fluxo vai
  // parar no primeiro no" de um fluxo que executa tudo. Ressalva que descreve
  // outro fluxo e pior que ressalva nenhuma: manda conferir o que nao existe.
  if (houveFalha) return { estado: "nao", motivo: houveFalha, referencias, assure };
  if (!partes.length) return { estado: "sem", referencias, assure };
  // ================== `assure_context_condition_before_execution` ==================
  // Campo do cabecalho que existe em TODOS os 7.462 dialogos medidos: 1.213 "Sim"
  // e 6.249 "Nao". O nome sugere "garantir a condicao de contexto ANTES de
  // executar" — o que, se for isso, muda de lado quem manda: com "Nao", a
  // condicao poderia ser so filtro do GATILHO e nao ser conferida na execucao.
  //
  // NAO ESTA DOCUMENTADO e nao da pra medir no backup (a tela do ChatGuru no
  // backup nao carrega o avaliador — conferido). Entao o conversor NAO decide:
  // ele prefixa a condicao de todo jeito (fiel ao que esta escrito no dialogo) e
  // DIZ que fez isso. Entre os dialogos MANUAIS com condicao, 1.140 sao "Sim" e
  // 1.337 sao "Nao" — se a leitura provavel estiver certa, sao 1.337 macros que
  // passariam a parar onde antes rodavam. Ficar calado aqui seria justamente o
  // erro que a regra-mae deste arquivo proibe.
  ressalvas.push(
    `campo \`assure_context_condition_before_execution\` = "${assure}": a semantica dele NAO esta documentada e a condicao foi prefixada no fluxo de todo jeito — se ele significar "nao conferir a condicao na execucao", este fluxo passa a PARAR onde antes rodava. Conferir antes de ligar`
  );

  // ================== NADA POPULA O CONTEXTO AINDA ==================
  // Medido nos 33 backups: dos 19 tipos de acao do ChatGuru em uso, NENHUM grava
  // variavel de contexto — o que enche `$URA`, `$AUTOATENDIMENTO` etc. la nao
  // esta no dialogo, e portanto nao chega pela importacao. Do lado do painel, a
  // acao `definir_contexto` existe, mas fluxo IMPORTADO nunca a tem.
  // Consequencia pratica: condicao sobre contexto e fail-closed, ou seja, avalia
  // FALSO enquanto ninguem povoar a variavel — e um fluxo importado com essa
  // condicao nunca passa do primeiro no. Isso precisa estar escrito no fluxo, nao
  // so no doc: quem liga o fluxo le a ressalva, nao o repositorio.
  if (leContexto(condicaoDe(partes))) {
    ressalvas.push(
      "a condicao olha VARIAVEL DE CONTEXTO e nada popula contexto nesta instalacao ainda (nenhuma acao do ChatGuru grava contexto, e fluxo importado nao tem `definir_contexto`): a condicao vai dar FALSO e o fluxo vai parar no primeiro no ate existir ingestao de contexto"
    );
  }

  // as duas condicoes do ChatGuru sao cumulativas: as duas tem que valer
  const condicao = condicaoDe(partes);
  // o estado sai do que ESTAS duas produziram — olhar a lista do dialogo aqui
  // misturaria com ressalva de acao
  return { estado: ressalvasDaCondicao ? "ressalva" : "convertida", condicao, referencias, assure };
}

// Encadeia acoes numa corrente linear (mesma regra do fluxoLinear do schema TS;
// aqui em JS puro pra este script nao depender de build).
//
// `base.condicao` (opcional) entra como PRIMEIRO no da corrente: no ChatGuru a
// condicao e de ENTRADA (o dialogo so roda se ela valer), e no formato canonico
// isso e exatamente um no de condicao na frente — verdadeira segue pras acoes,
// falsa para ali.
/**
 * Traduz os limites por conversa do cabecalho do dialogo. Devolve `null` quando
 * nao ha limite nenhum a declarar (e ai o campo NAO e emitido: fluxo sem limite e
 * fluxo sem a chave, nao fluxo com zeros).
 */
export function limitesDoCabecalho(head, ressalvas = []) {
  const limites = {};
  const bruto = numeroDoCampo(head.max_executions_per_chat);
  if (bruto.estranho) {
    ressalvas.push(
      `valor irreconhecivel no limite de execucoes por chat ("${bruto.bruto}") — limite nao aplicado; conferir`
    );
  }
  const maxExec = bruto.n;
  if (Number.isFinite(maxExec) && maxExec > 0 && !SENTINELAS_SEM_LIMITE.has(Math.round(maxExec))) {
    const n = Math.round(maxExec);
    if (n <= TETO_MAXIMO_POR_CONVERSA) {
      limites.maximo_por_conversa = n;
      // numero alto o bastante pra ser um "sem limite" mal escrito: honra e avisa,
      // em vez de escolher no lugar de quem configurou
      if (n >= 1000) {
        ressalvas.push(
          `limite de ${n} execucoes por chat foi honrado como limite REAL (999 e 9999 sao os valores de fabrica de "sem limite"; este nao e) — conferir se era isso`
        );
      }
    } else {
      ressalvas.push(
        `limite de ${n} execucoes por chat esta acima do teto da v1 (${TETO_MAXIMO_POR_CONVERSA}); limite nao aplicado`
      );
    }
  }
  const brutoEntre = numeroDoCampo(head.seconds_between_execution);
  if (brutoEntre.estranho) {
    ressalvas.push(
      `valor irreconhecivel no intervalo minimo entre execucoes ("${brutoEntre.bruto}") — intervalo nao aplicado; conferir`
    );
  }
  const entre = brutoEntre.n;
  const TETO_INTERVALO = 30 * 24 * 3600;
  if (Number.isFinite(entre) && entre > 0) {
    if (entre <= TETO_INTERVALO) limites.intervalo_minimo_segundos = Math.round(entre);
    else
      ressalvas.push(
        `intervalo minimo de ${entre}s entre execucoes esta acima do teto da v1 (30 dias); intervalo nao aplicado`
      );
  }
  return Object.keys(limites).length ? limites : null;
}

export function montarFluxo(base, acoes, opcoes = {}) {
  const deslocamento = base.condicao ? 1 : 0;
  // `aprovacao` alinhado por INDICE com `acoes` (ver converterDialogo). Array
  // ausente = nenhum passo pede aval, que e o caso da maioria.
  const aprovacao = Array.isArray(opcoes.aprovacao) ? opcoes.aprovacao : [];
  const nos = acoes.map((acao, i) => ({
    id: `n${i + 1 + deslocamento}`,
    tipo: acao.tipo === "espera" ? "espera" : "acao",
    acao,
    // espera NUNCA carrega aval: ela e consumida no agendamento (nao executa), e
    // aprovacao em no que nao executa seria carimbo morto
    ...(aprovacao[i] === true && acao.tipo !== "espera" ? { aprovacao: true } : {}),
    ...(i < acoes.length - 1 ? { proximo: `n${i + 2 + deslocamento}` } : {}),
  }));
  if (base.condicao) {
    nos.unshift({
      id: "n1",
      tipo: "condicao",
      condicao: base.condicao,
      rotulo: "condicao de entrada (ChatGuru)",
      ...(nos.length ? { proximo: "n2" } : {}),
    });
  }
  return {
    id: base.id,
    nome: base.nome,
    tipo: base.tipo ?? "macro",
    versao: 1,
    nos,
    ...(base.limites ? { limites: base.limites } : {}),
    ...(base.origem ? { origem: base.origem } : {}),
  };
}

// Marcas das ressalvas que SO fazem sentido quando a condicao entrou no fluxo.
// Sao texto longo e mudam com o tempo, entao o filtro casa por um pedaco estavel
// — e as duas pontas (quem escreve, quem tira) usam a MESMA constante.
export const MARCA_RESSALVA_ASSURE = "assure_context_condition_before_execution";
export const MARCA_RESSALVA_CONTEXTO_INERTE = "nada popula contexto";

// O MESMO fluxo sem o no de condicao de entrada. Usado quando o schema recusa o
// fluxo POR CAUSA da condicao: as acoes convertidas continuam valendo, e a
// ressalva registra o que ficou de fora.
//
// SOBRE A ARESTA que apontava pro no de condicao: ela NAO e removida, e hoje
// isso e inocuo por construcao — a condicao de entrada e sempre o PRIMEIRO no da
// corrente (ver montarFluxo), entao ninguem aponta pra ela; o que ela apontava
// (`proximo`) vira a nova entrada, porque a entrada e o primeiro item de `nos`.
// Se algum dia a condicao passar a nascer no MEIO da corrente, esta funcao vira
// fail-closed do jeito certo: `validarFluxo` recusa `proximo` apontando pra no
// inexistente, e o fluxo cai no balde "recusado" em vez de ser gravado com a
// corrente partida em silencio.
//
// Os ids dos nos nao sao renumerados de proposito — id de no e opaco, e
// renumerar mudaria a referencia da trilha de execucao de quem ja rodou.
export function semCondicaoDeEntrada(fluxo, erros = []) {
  const nos = (fluxo.nos ?? []).filter((n) => n?.tipo !== "condicao");
  if (nos.length === (fluxo.nos ?? []).length) return fluxo; // nao havia condicao
  const motivo = (erros[0] || "o schema recusou a condicao").slice(0, 200);
  const ressalvas = Array.from(
    new Set([
      // as ressalvas que FALAM da condicao saem junto com ela: sem isto o fluxo
      // sairia dizendo "a condicao foi prefixada" e "vai parar no primeiro no"
      // logo depois de a condicao ter sido tirada
      ...(fluxo.origem?.ressalvas ?? []).filter(
        (r) => !r.includes(MARCA_RESSALVA_ASSURE) && !r.includes(MARCA_RESSALVA_CONTEXTO_INERTE)
      ),
      `a condicao de entrada NAO entrou no fluxo (${motivo}) — as acoes foram importadas, a condicao nao: conferir antes de ligar`,
    ])
  );
  return {
    ...fluxo,
    nos,
    ...(fluxo.origem ? { origem: { ...fluxo.origem, ressalvas } } : {}),
  };
}

// Nome de arquivo SEGURO pra saida do --json.
// O id do fluxo deriva do `dialogo_id` do JSON de terceiro; jogado direto num
// path.join, um "../" escreve FORA da pasta de saida. basename corta o caminho
// e o filtro corta o resto (inclusive ":" , que o schema aceita no id mas o
// Windows nao aceita em nome de arquivo).
export function nomeArquivoSeguro(conta, fluxoId) {
  const limpar = (s) => path.basename(String(s ?? "")).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "sem-nome";
  return `${limpar(conta)}__${limpar(fluxoId)}.json`;
}

// --------------------------------------------------------------- leitura
export function carregarEtiquetas(pastaConta) {
  const p = path.join(pastaConta, "config", "chatlist_tags.json");
  const mapa = new Map();
  try {
    for (const t of JSON.parse(fs.readFileSync(p, "utf8"))) {
      if (t?.id && typeof t?.text === "string") mapa.set(String(t.id), t.text.trim());
    }
  } catch {
    /* sem catalogo: TAG vira ressalva, e o relatorio mostra isso */
  }
  return mapa;
}

/**
 * Mapa id na origem -> chave no painel, escrito pelo passo de importacao dos
 * anexos (`scripts/importar/anexos.mjs`). SEM ele a acao ANEXAR vira ressalva:
 * chave chutada apontaria pra arquivo que nao existe, e o fluxo falharia no
 * cliente em vez de na conversao.
 *
 * `parcial` viaja junto porque a frase da ressalva muda: id fora de um mapa
 * PARCIAL e "nao capturado" (pedir as demais paginas), id fora de um mapa
 * completo e "nao existe" (subir pela tela).
 */
export function carregarAnexosChaves(pastaConta) {
  const p = path.join(pastaConta, "config", "anexos-chaves.json");
  const mapa = new Map();
  let parcial = false;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    parcial = !!j?.parcial;
    for (const [id, v] of Object.entries(j?.anexos ?? {})) {
      const chave = typeof v === "string" ? v : limpo(v?.chave);
      if (id && chave) mapa.set(String(id), { chave, nome: limpo(v?.nome) || chave });
    }
  } catch {
    /* sem mapa: ANEXAR vira ressalva, e o relatorio mostra isso */
  }
  return { mapa, parcial };
}

// Catalogo de funis da conta, NA ORDEM DO ARQUIVO — a ordem E informacao: e ela
// que identifica o funil de cada select `steps_ids` da acao FUNIL (ver o case
// "FUNIL" acima). Reordenar esta lista quebraria a conversao em silencio.
export function carregarFunis(pastaConta) {
  const p = path.join(pastaConta, "config", "chatlist_funnels.json");
  try {
    const bruto = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!Array.isArray(bruto)) return [];
    return bruto.map((f) => ({
      id: String(f?.id ?? ""),
      nome: String(f?.name ?? "").trim(),
      etapas: (Array.isArray(f?.steps) ? f.steps : []).map((s) => ({
        id: String(s?.id ?? ""),
        nome: String(s?.name ?? "").trim(),
      })),
    }));
  } catch {
    /* sem catalogo: FUNIL vira ressalva, e o relatorio mostra isso */
    return [];
  }
}

function resolverPastas(alvo) {
  const dialogos = path.join(alvo, "automacao", "dialogos");
  if (fs.existsSync(dialogos)) return { conta: alvo, dialogos };
  if (path.basename(alvo) === "dialogos") return { conta: path.resolve(alvo, "..", ".."), dialogos: alvo };
  return null;
}

export function converterPasta(alvo, { limite = 0 } = {}) {
  const p = resolverPastas(alvo);
  if (!p) return { erro: `nao achei automacao/dialogos em ${alvo}`, conta: path.basename(alvo), resultados: [] };
  const etiquetas = carregarEtiquetas(p.conta);
  const funis = carregarFunis(p.conta);
  const anexos = carregarAnexosChaves(p.conta);
  const arquivos = fs.readdirSync(p.dialogos).filter((f) => f.endsWith(".json"));
  const escolhidos = limite > 0 ? arquivos.slice(0, limite) : arquivos;
  const resultados = [];
  for (const f of escolhidos) {
    let dialogo;
    try {
      dialogo = JSON.parse(fs.readFileSync(path.join(p.dialogos, f), "utf8"));
    } catch (e) {
      resultados.push({ estado: "nao", id_original: f, motivo: `JSON invalido: ${e.message}` });
      continue;
    }
    resultados.push(
      converterDialogo(dialogo, { etiquetas, funis, anexos: anexos.mapa, anexosParcial: anexos.parcial })
    );
  }
  return { conta: path.basename(p.conta), total_arquivos: arquivos.length, resultados };
}

// ------------------------------------------------------------- relatorio
export function consolidar(pastas) {
  const total = { convertido: 0, ressalva: 0, nao: 0 };
  // Recorte que decide a v1: MACRO (node_type Manual) e o que o motor executa
  // hoje. Misturar com dialogo automatico esconde o numero — todo automatico
  // carrega a ressalva "nao dispara sozinho", que e verdade sobre o GATILHO,
  // nao sobre as acoes.
  const macro = { convertido: 0, ressalva: 0, nao: 0 };
  const auto = { convertido: 0, ressalva: 0, nao: 0 };
  const porTipoConvertido = {};
  const porTipoRessalvado = {};
  const motivos = {};
  const ressalvas = {};
  const contas = [];
  // condicao tem baldes PROPRIOS: um dialogo pode ter todas as acoes
  // convertidas e a condicao nao — e e a condicao que decide QUANDO a
  // automacao dispara. Misturar os dois numeros esconderia justamente isso.
  const condicao = { sem: 0, convertida: 0, ressalva: 0, nao: 0, gravada_sem_condicao: 0 };
  const condicaoMotivos = {};
  const condicaoReferencias = {};
  // contagem do campo `assure_context_condition_before_execution`, cruzada com
  // manual/automatico: e o numero que decide o tamanho do risco descrito na
  // ressalva desse campo (ver condicaoDoDialogo)
  const condicaoAssure = {};
  for (const r of pastas) {
    const c = { conta: r.conta, convertido: 0, ressalva: 0, nao: 0, total: r.resultados.length, erro: r.erro };
    for (const d of r.resultados) {
      total[d.estado]++;
      c[d.estado]++;
      (d.manual ? macro : auto)[d.estado]++;
      for (const t of d.tipos_convertidos ?? []) porTipoConvertido[t] = (porTipoConvertido[t] || 0) + 1;
      for (const t of d.tipos_ressalvados ?? []) porTipoRessalvado[t] = (porTipoRessalvado[t] || 0) + 1;
      if (d.estado === "nao") motivos[d.motivo] = (motivos[d.motivo] || 0) + 1;
      for (const x of d.ressalvas ?? []) ressalvas[x] = (ressalvas[x] || 0) + 1;
      if (d.condicao) {
        condicao[d.condicao.estado]++;
        if (d.condicao.estado === "nao") {
          condicaoMotivos[d.condicao.motivo] = (condicaoMotivos[d.condicao.motivo] || 0) + 1;
        }
        for (const [k, v] of Object.entries(d.condicao.referencias ?? {})) {
          condicaoReferencias[k] = (condicaoReferencias[k] || 0) + v;
        }
        if (d.condicao.gravada_sem_condicao) condicao.gravada_sem_condicao++;
        if (d.condicao.estado !== "sem") {
          const k = `${d.manual ? "macro (Manual)" : "automatico"} + assure="${d.condicao.assure}"`;
          condicaoAssure[k] = (condicaoAssure[k] || 0) + 1;
        }
      }
    }
    contas.push(c);
  }
  return {
    total, macro, auto, contas, porTipoConvertido, porTipoRessalvado, motivos, ressalvas,
    condicao, condicaoMotivos, condicaoReferencias, condicaoAssure,
  };
}

const tabela = (obj, cabecalho, limite = 40) => {
  const linhas = Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limite);
  if (!linhas.length) return "_(nenhum)_\n";
  return [`| ${cabecalho} | qtd |`, "|---|---:|", ...linhas.map(([k, v]) => `| ${k} | ${v} |`)].join("\n") + "\n";
};

export function relatorioMarkdown(cons, { detalhe = false, pastas = [] } = {}) {
  const t = cons.total;
  const n = t.convertido + t.ressalva + t.nao;
  const pct = (x) => (n ? ((x / n) * 100).toFixed(1) : "0.0");
  const out = [];
  out.push("# Conversao ChatGuru -> fluxo canonico (DRY RUN)");
  out.push("");
  out.push(`Gerado em ${new Date().toISOString()} — nada foi gravado em banco nenhum.`);
  out.push("");
  out.push("| saida | dialogos | % |");
  out.push("|---|---:|---:|");
  out.push(`| convertido (sem perda) | ${t.convertido} | ${pct(t.convertido)}% |`);
  out.push(`| com ressalva | ${t.ressalva} | ${pct(t.ressalva)}% |`);
  out.push(`| nao convertido | ${t.nao} | ${pct(t.nao)}% |`);
  out.push(`| **total** | **${n}** | |`);
  out.push("");
  out.push("## Recorte que decide a v1: MACRO x automatico");
  out.push("");
  out.push("O motor v1 executa MACRO (`node_type` Manual). Diálogo automatico converte as");
  out.push("ACOES do mesmo jeito, mas carrega sempre a ressalva de que o GATILHO nao existe");
  out.push("na v1 — por isso o numero geral acima subestima o que ja da pra usar.");
  out.push("");
  const linha = (rot, o) => {
    const s = o.convertido + o.ressalva + o.nao;
    const p = (x) => (s ? ((x / s) * 100).toFixed(1) : "0.0");
    out.push(`| ${rot} | ${s} | ${o.convertido} (${p(o.convertido)}%) | ${o.ressalva} (${p(o.ressalva)}%) | ${o.nao} (${p(o.nao)}%) |`);
  };
  out.push("| recorte | total | convertido | com ressalva | nao convertido |");
  out.push("|---|---:|---:|---:|---:|");
  linha("macro (Manual)", cons.macro);
  linha("automatico (Padrao/Continuo)", cons.auto);
  out.push("");
  out.push("## Por conta");
  out.push("");
  out.push("| conta | total | convertido | ressalva | nao |");
  out.push("|---|---:|---:|---:|---:|");
  for (const c of cons.contas) {
    out.push(`| ${c.conta}${c.erro ? " (erro)" : ""} | ${c.total} | ${c.convertido} | ${c.ressalva} | ${c.nao} |`);
  }
  out.push("");
  out.push("## Acoes CONVERTIDAS, por tipo do ChatGuru");
  out.push("");
  out.push(tabela(cons.porTipoConvertido, "acao"));
  out.push("## Acoes NAO convertidas, por tipo do ChatGuru");
  out.push("");
  out.push(tabela(cons.porTipoRessalvado, "acao"));
  out.push("## Condicao de entrada (o que decide QUANDO a automacao dispara)");
  out.push("");
  out.push("As duas condicoes do ChatGuru — filtro por variavel de contexto e expressao");
  out.push("avancada — viram UMA condicao canonica, no de condicao na frente da corrente.");
  out.push("Conversao e TUDO OU NADA por expressao: termo sem equivalente nao e descartado");
  out.push("pra aproveitar o resto (descartar termo de `and` faz a automacao disparar MAIS");
  out.push("vezes do que disparava, e de `or`, menos — nos dois casos, calada).");
  out.push("");
  out.push("Recorte desta secao: os dialogos que geraram fluxo. Dialogo sem nenhuma acao");
  out.push("com equivalente nao entra aqui (nao ha fluxo pra pendurar a condicao).");
  out.push("");
  const cd = cons.condicao;
  const somaCond = cd.convertida + cd.ressalva + cd.nao;
  const pc = (x) => (somaCond ? ((x / somaCond) * 100).toFixed(1) : "0.0");
  out.push("| saida da condicao | dialogos | % dos que TEM condicao |");
  out.push("|---|---:|---:|");
  out.push(`| convertida (sem perda) | ${cd.convertida} | ${pc(cd.convertida)}% |`);
  out.push(`| com ressalva | ${cd.ressalva} | ${pc(cd.ressalva)}% |`);
  out.push(`| nao convertida | ${cd.nao} | ${pc(cd.nao)}% |`);
  out.push(`| **com condicao** | **${somaCond}** | |`);
  out.push(`| sem condicao nenhuma | ${cd.sem} | |`);
  if (cd.gravada_sem_condicao) {
    // so aparece quando --json rodou: e a passada que valida contra o schema
    out.push(
      `| _(dos acima)_ gravado SEM a condicao porque o schema a recusou | ${cd.gravada_sem_condicao} | |`
    );
  }
  out.push("");
  out.push("### Por que a condicao nao converteu");
  out.push("");
  out.push("Esta tabela E a fila do que implementar: cada linha diz quantos dialogos");
  out.push("destravam quando aquele campo existir.");
  out.push("");
  out.push(tabela(cons.condicaoMotivos, "motivo", 25));
  out.push("### `assure_context_condition_before_execution` — campo NAO documentado");
  out.push("");
  out.push("Existe em todos os dialogos e o nome sugere \"garantir a condicao de contexto ANTES");
  out.push("de executar\". A semantica nao esta documentada e nao da pra medir no backup, entao");
  out.push("o conversor prefixa a condicao de todo jeito e marca RESSALVA em cada dialogo. Se");
  out.push("o campo significar \"nao conferir a condicao na execucao\", as linhas com");
  out.push("`assure=\"Nao\"` sao fluxos que passariam a PARAR onde antes rodavam.");
  out.push("");
  out.push(tabela(cons.condicaoAssure, "recorte", 10));
  out.push("### Referencias usadas nas expressoes");
  out.push("");
  out.push(tabela(cons.condicaoReferencias, "referencia", 25));
  out.push("## Ressalvas mais comuns");
  out.push("");
  out.push(tabela(cons.ressalvas, "ressalva", 25));
  out.push("## Motivos de nao conversao");
  out.push("");
  out.push(tabela(cons.motivos, "motivo", 25));
  if (detalhe) {
    out.push("> ATENCAO: gerado com --detalhe; contem titulo de dialogo de cliente. Nao publicar.");
    out.push("");
    for (const r of pastas) {
      out.push(`### ${r.conta}`);
      for (const d of r.resultados.slice(0, 40)) {
        out.push(`- [${d.estado}] ${d.nome || d.id_original}${d.motivo ? " — " + d.motivo : ""}`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------- CLI
function args(argv) {
  const o = { pastas: [], limite: 0, saida: null, json: null, detalhe: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pasta") o.pastas.push(argv[++i]);
    else if (a === "--limite") o.limite = Number(argv[++i]) || 0;
    else if (a === "--saida") o.saida = argv[++i];
    else if (a === "--json") o.json = argv[++i];
    else if (a === "--detalhe") o.detalhe = true;
  }
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (!o.pastas.length) {
    console.error("uso: node scripts/fluxo/converter-chatguru.mjs --pasta <pasta da conta> [--pasta ...] [--limite N] [--saida rel.md] [--json dir] [--detalhe]");
    process.exit(2);
  }
  const pastas = o.pastas.map((p) => converterPasta(p, { limite: o.limite }));
  for (const p of pastas) if (p.erro) console.error("aviso:", p.erro);
  // O relatorio e montado DEPOIS da passada --json de proposito: e ela que
  // descobre quais fluxos o schema recusou por causa da condicao e foram
  // regravados sem ela. Sem essa ordem, o numero so existiria no stderr — e
  // stderr nao e relatorio: ninguem o le depois.
  if (o.json) {
    fs.mkdirSync(o.json, { recursive: true });
    // Valida com o schema canonico ANTES de gravar (o proprio
    // docs/fluxo-canonico.md manda: o conversor classifica rodando validarFluxo).
    // Import dinamico: quando o Node nao souber ler .ts, avisa e nao grava —
    // gravar sem validar seria pior que nao gravar.
    let validarFluxo = null;
    try {
      ({ validarFluxo } = await import("../../lib/fluxo/schema.ts"));
    } catch (e) {
      console.error(`[json] ABORTADO: nao consegui carregar o schema pra validar (${e.message})`);
      return;
    }
    let gravados = 0;
    let recusados = 0;
    let semCondicao = 0;
    for (const p of pastas) {
      for (const d of p.resultados) {
        if (!d.fluxo) continue;
        let v = validarFluxo(d.fluxo);
        if (!v.ok) {
          // A CONDICAO NAO DERRUBA O DIALOGO. Se o fluxo passa a valer quando a
          // condicao de entrada sai, a recusa era SO dela: grava o fluxo com as
          // ACOES (que o atendente ja pode usar) e diz na ressalva que a
          // condicao ficou de fora. Perder as acoes por causa da condicao seria
          // jogar fora o que converteu.
          const tentativa = validarFluxo(semCondicaoDeEntrada(d.fluxo, v.erros));
          if (tentativa.ok) {
            fs.writeFileSync(
              path.join(o.json, nomeArquivoSeguro(p.conta, tentativa.fluxo.id)),
              JSON.stringify(tentativa.fluxo, null, 1)
            );
            gravados++;
            semCondicao++;
            // fica no resultado pro consolidado contar (o relatorio sai depois)
            if (d.condicao) d.condicao.gravada_sem_condicao = true;
            console.error(`[json] ${d.id_original}: gravado SEM a condicao (${v.erros[0]})`);
            continue;
          }
          recusados++;
          console.error(`[json] recusado ${d.id_original}: ${v.erros.slice(0, 3).join(" | ")}`);
          continue;
        }
        fs.writeFileSync(path.join(o.json, nomeArquivoSeguro(p.conta, d.fluxo.id)), JSON.stringify(v.fluxo, null, 1));
        gravados++;
      }
    }
    console.error(
      `[json] ${gravados} fluxo(s) em ${o.json}` +
        (semCondicao ? ` (${semCondicao} sem a condicao)` : "") +
        (recusados ? ` (${recusados} recusado(s) pelo schema)` : "")
    );
  }
  const cons = consolidar(pastas);
  const md = relatorioMarkdown(cons, { detalhe: o.detalhe, pastas });

  if (o.saida) {
    fs.writeFileSync(o.saida, md);
    console.error(`[saida] relatorio em ${o.saida}`);
  } else {
    console.log(md);
  }
}

// so roda o CLI quando ESTE arquivo e o programa; importado (prova, outro
// script) exporta as funcoes e nao executa nada
if (process.argv[1]?.replace(/\\/g, "/").endsWith("converter-chatguru.mjs")) {
  main();
}
