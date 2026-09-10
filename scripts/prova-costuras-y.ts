// Prova das COSTURAS DA ONDA 4 (Frente Y, 31/08/2026) — as tres da tela de
// conversa mais a deriva do passo de fluxo interativo.
//
// Roda em Node >= 22.6 sem build, da RAIZ do repo:
//   node scripts/prova-costuras-y.ts
// (type stripping nativo; `scripts/` fica fora do tsconfig por isso.)
//
// O QUE ESTA PROVA COBRE, e por que ela existe separada:
//
//  1. `lib/tela-composer.ts` — as REGRAS das tres costuras. `app/home.tsx` passa
//     de 7.400 linhas e nao roda em node solto; toda decisao saiu do .tsx.
//  2. As GUARDAS ESTRUTURAIS de `app/home.tsx`, lidas SEM COMENTARIO. Elas nao
//     sao enfeite: as tres costuras sao FIACAO, e fiacao desfeita nao quebra
//     nada — a tela continua compilando, a bateria continua verde e o defeito
//     volta calado (o atendente manda `!nome` cru, o painel de memoria fica
//     vazio em vez de avisar, o composer volta a travar sem saida).
//  3. A DERIVA entre `lib/fluxo/schema.ts` (teto de SANIDADE do jsonb) e
//     `lib/interativas.ts` (teto da PLATAFORMA). Sao dois lugares de proposito, e
//     a direcao e o invariante: schema >= plataforma. Sem esta secao, alguem
//     aperta o schema, o preflight passa a ser codigo morto e a pergunta invalida
//     volta a morrer no meio do fluxo.
//
// Nada de rede e nada de banco. Arquivo NOVO em vez de emenda nas provas das
// outras frentes (W e X mexem em `lib/anexos*` e `lib/campos*` nesta mesma onda):
// o merge tem que ser uniao mecanica.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  avisoDeVariaveis,
  camposDoTemplate,
  motivoDeNaoEnviar,
  chaveNormalizada,
  paresDeContexto,
  pedeTemplate,
  previaDoTemplate,
  problemaDoPar,
  problemaDosParametros,
  respostasDoAtalho,
  templatesEnviaveis,
  textoParaCaixa,
  type RespostaRapida,
} from "../lib/tela-composer.ts";
import {
  LIMITE_CHAVE_CONTEXTO,
  LIMITE_OPCOES_PERGUNTA,
  LIMITE_ROTULO_PERGUNTA,
  LIMITE_TEXTO,
  LIMITE_VALOR_CONTEXTO,
  MIN_OPCOES_PERGUNTA,
  TIPOS_PERGUNTA,
  CAMPOS_SUJOS_POR_ACAO,
  percorrerMacro,
  validarFluxo,
  type CampoCondicao,
  type No,
} from "../lib/fluxo/schema.ts";
// FRENTE Y (revisao 1) — a DECISAO do passo interativo saiu de lib/fluxo/executar.ts
// (que nenhuma prova consegue carregar) pra ca, e por isso ela agora tem desfecho
// medido em vez de grep de forma.
import { ehGrupo, planoDaPergunta, saidaDaMensagem } from "../lib/fluxo/pergunta.ts";
import {
  LIMITE_BOTAO_LISTA,
  LIMITE_DESCRICAO_ITEM,
  LIMITE_RODAPE_INTERATIVA,
  LIMITE_TEXTO_INTERATIVA,
  LIMITE_TITULO_BOTAO,
  LIMITE_TITULO_ITEM,
  MAX_BOTOES,
  MAX_ITENS_LISTA,
  TIPOS_INTERATIVA,
  validarInterativa,
  type Interativa,
} from "../lib/interativas.ts";
import {
  contarVariaveis, podeEnviarTemplate, renderizarTemplate, type TemplateCanal,
} from "../lib/templates-oficial.ts";
import { simularFluxo } from "../lib/fluxo/simulador.ts";
import { ACOES_V1 } from "../lib/fluxo/schema.ts";

let n = 0;
function ok(cond: unknown, msg: string) {
  assert.equal(!!cond, true, msg);
  n += 1;
}
function eq(a: unknown, b: unknown, msg: string) {
  assert.deepEqual(a, b, msg);
  n += 1;
}
const ler = (p: string) => readFileSync(p, "utf8");
/** Tira comentario de linha e de bloco: a guarda e sobre CODIGO, nao sobre o texto. */
const semComentario = (fonte: string) =>
  fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function resposta(p: Partial<RespostaRapida> = {}): RespostaRapida {
  return { id: "r1", atalho: "boas", texto: "Oi !nome, tudo bem?", global: false, ...p };
}

/** Um fluxo minimo com UM passo de pergunta — pra medir o que o SCHEMA aceita. */
function fluxoComPergunta(params: unknown) {
  return validarFluxo({
    id: "y1",
    nome: "pergunta",
    tipo: "gatilho",
    versao: 1,
    nos: [{ id: "n1", tipo: "acao", acao: { tipo: "perguntar_opcoes", params } }],
  });
}

function template(corpo: string, p: Partial<TemplateCanal> = {}): TemplateCanal {
  return {
    provider_id: "prov-1",
    nome: "aviso_consulta",
    idioma: "pt_BR",
    categoria: "UTILITY",
    status: "aprovado",
    corpo,
    exemplo: "",
    variaveis: contarVariaveis(corpo),
    rodape: "",
    cabecalho: "",
    midia_url: "",
    motivo: "",
    ...p,
  };
}

// ════════════ 1) RESPOSTA RAPIDA: a variavel trocada ANTES da caixa ═══════════
// Criterio do card 86ak86jw9. O defeito que existia: os dois caminhos da tela
// (clique na lista e Enter no atalho) faziam `setDraft(r.texto)` — o texto CRU.
{
  eq(
    textoParaCaixa(resposta({ texto_resolvido: "Oi Eric, tudo bem?" })),
    "Oi Eric, tudo bem?",
    "o texto RESOLVIDO vence o cru (e o criterio do card)"
  );
  // O FALLBACK IMPORTA NOS DOIS SENTIDOS: sem ele, a caixa fica VAZIA quando o
  // GET foi feito sem conversa (a carga da abertura do painel) — e perder a
  // resposta rapida inteira e pior que colar o template cru.
  eq(textoParaCaixa(resposta()), "Oi !nome, tudo bem?", "sem resolvido, cai no texto cru (nunca vazio)");
  eq(
    textoParaCaixa(resposta({ texto_resolvido: "" })),
    "Oi !nome, tudo bem?",
    "resolvido vazio nao vira mensagem vazia"
  );
  eq(
    textoParaCaixa(resposta({ texto_resolvido: "   " })),
    "Oi !nome, tudo bem?",
    "resolvido so com espaco tambem cai no fallback"
  );
  eq(
    textoParaCaixa(resposta({ texto_resolvido: 42 as unknown as string })),
    "Oi !nome, tudo bem?",
    "resolvido nao-texto (jsonb devolve numero) nao vira mensagem"
  );
  eq(
    textoParaCaixa(resposta({ texto_resolvido: null as unknown as string })),
    "Oi !nome, tudo bem?",
    "resolvido null nao vira a string \"null\" na cara do cliente"
  );
}

// ════════════ 2) O AVISO e o que faz a substituicao HONESTA ═══════════════════
// A rota troca variavel sem valor por VAZIO (regra da frente T: `!nome` num
// contato sem nome nao pode chegar cru no cliente). Sem aviso, o atendente cola
// "Oi , tudo bem?" e nao ve o buraco.
{
  eq(avisoDeVariaveis(resposta()), null, "sem variavel problematica, ZERO faixa na tela");
  eq(avisoDeVariaveis(resposta({ variaveis_vazias: [], variaveis_nao_resolvidas: [] })), null, "listas vazias tambem nao viram faixa");
  const a1 = avisoDeVariaveis(resposta({ variaveis_vazias: ["!nome"] }));
  ok(a1 && a1.includes("!nome"), "variavel VAZIA e nomeada no aviso");
  ok(a1 && a1.includes("sem valor nesta conversa"), "e dita como \"sem valor nesta conversa\"");
  const a2 = avisoDeVariaveis(resposta({ variaveis_nao_resolvidas: ["$sobra"] }));
  ok(a2 && a2.includes("ficaram no texto"), "variavel DESCONHECIDA e dita como \"ficou no texto\"");
  // As duas classes NAO se juntam: "vazia" e uma variavel que existe e nao tem
  // valor; "nao resolvida" e sobra de outra ferramenta que FICA no texto. Juntar
  // faria o atendente procurar o valor de algo que nao existe neste painel.
  const a3 = avisoDeVariaveis(resposta({ variaveis_vazias: ["!nome"], variaveis_nao_resolvidas: ["$sobra"] }));
  ok(a3 && a3.includes("sem valor nesta conversa") && a3.includes("ficaram no texto"), "as duas classes aparecem SEPARADAS");
  eq(
    avisoDeVariaveis(resposta({ variaveis_vazias: ["", "  ", null as unknown as string] })),
    null,
    "entrada suja da rota nao vira faixa com nome vazio"
  );
}

// ════════════ 3) O FILTRO do atalho — um so pros dois caminhos ════════════════
{
  const lista = [
    resposta({ id: "a", atalho: "boas" }),
    resposta({ id: "b", atalho: "boleto" }),
    resposta({ id: "c", atalho: "horario" }),
  ];
  eq(respostasDoAtalho(lista, "/bo").map((r) => r.id), ["a", "b"], "o prefixo filtra");
  eq(respostasDoAtalho(lista, "/BO").map((r) => r.id), ["a", "b"], "e nao depende de caixa");
  eq(respostasDoAtalho(lista, "/").map((r) => r.id), ["a", "b", "c"], "\"/\" sozinho abre todas");
  eq(respostasDoAtalho(lista, "/zzz").length, 0, "prefixo que nao casa devolve nada (a lista nem abre)");
  // O ENTER USA A PRIMEIRA DA LISTA, e e por isso que a funcao e a MESMA nos dois
  // caminhos: com filtros diferentes, "a primeira" da lista e a do Enter podiam
  // ser respostas DIFERENTES — o atendente le uma e envia outra.
  eq(respostasDoAtalho(lista, "/bo")[0].id, "a", "e a primeira do Enter e a primeira da lista");
  // `%` e `_` (coringa de LIKE) e metacaractere de regex sao TEXTO aqui: o repo
  // ja pagou por input de usuario virando padrao de busca.
  eq(respostasDoAtalho([resposta({ id: "x", atalho: "b_s" })], "/b%").length, 0, "\"%\" nao e coringa");
  eq(respostasDoAtalho([resposta({ id: "x", atalho: "bas" })], "/b_").length, 0, "\"_\" nao e coringa");
  eq(respostasDoAtalho([resposta({ id: "x", atalho: "bas" })], "/b.*").length, 0, "\".*\" nao e regex");
  eq(respostasDoAtalho(Array.from({ length: 30 }, (_, i) => resposta({ id: `i${i}`, atalho: `b${i}` })), "/b").length, 8,
    "a lista tem teto (nao cobre a tela inteira)");
}

// ════════════ 4) MEMORIA DA CONVERSA: o mapa virando lista ════════════════════
{
  eq(paresDeContexto({ b: "2", a: "1" }).map((p) => p.chave), ["a", "b"],
    "ordem ALFABETICA, nao a do jsonb (que muda quando o Postgres reescreve a linha)");
  eq(paresDeContexto({ URA: 3, ativo: true }), [{ chave: "ativo", valor: "true" }, { chave: "URA", valor: "3" }],
    "numero e booleano do jsonb viram texto");
  // A ordem e a de LEITURA HUMANA (localeCompare pt-BR), nao a de codepoint: com
  // `<` cru, TODA chave em maiuscula iria pra frente das minusculas e a lista
  // ficaria em dois blocos — `URA` e `ura_2` longe uma da outra na tela.
  eq(paresDeContexto({ Zebra: "1", ativo: "2" }).map((x) => x.chave), ["ativo", "Zebra"],
    "maiuscula nao vai pra frente da lista (ordem de leitura, nao de codepoint)");
  eq(paresDeContexto({ obj: { a: 1 }, lista: [1], bom: "x" }), [{ chave: "bom", valor: "x" }],
    "objeto e lista NAO entram (virariam \"[object Object]\" na tela)");
  eq(paresDeContexto(null), [], "null nao explode");
  eq(paresDeContexto([1, 2]), [], "array no lugar do mapa nao explode");
  eq(paresDeContexto("x"), [], "texto no lugar do mapa nao explode");
  eq(paresDeContexto({ vazio: "" }), [{ chave: "vazio", valor: "" }],
    "chave com valor VAZIO aparece: ela existe, e a condicao `nao_existe` sabe disso");
}

// ════════════ 5) A REGRA DE GRAVAR — a mesma da rota, antes do clique ═════════
{
  eq(problemaDoPar("URA", "1"), null, "par normal passa");
  eq(problemaDoPar("URA", ""), null, "valor VAZIO e legitimo (marcar a chave sem conteudo)");
  ok(problemaDoPar("   ", "x"), "chave em branco e recusada");
  ok(problemaDoPar("a\nb", "x"), "chave com quebra de linha e recusada");
  ok(problemaDoPar("a".repeat(LIMITE_CHAVE_CONTEXTO + 1), "x"), "chave acima do teto e recusada");
  eq(problemaDoPar("a".repeat(LIMITE_CHAVE_CONTEXTO), "x"), null, "e o teto EXATO passa");
  ok(problemaDoPar("URA", "v".repeat(LIMITE_VALOR_CONTEXTO + 1)), "valor acima do teto e recusado");
  eq(problemaDoPar("URA", "v".repeat(LIMITE_VALOR_CONTEXTO)), null, "e o teto EXATO passa");
  // A tela MOSTRA como a chave vai ficar: gravar "URA " e a condicao procurar
  // "URA" e um defeito invisivel — nada na tela diria por que o fluxo nao casa.
  eq(chaveNormalizada("  URA  "), "URA", "a chave e normalizada (e a tela mostra isso antes de gravar)");
  eq(chaveNormalizada("   "), "", "chave impossivel devolve vazio, nao explode");
  // A NORMALIZACAO E A DO SCHEMA: se ela divergir, a tela promete uma chave e o
  // banco grava outra.
  ok(problemaDoPar(chaveNormalizada("  URA  "), "x") === null, "a chave normalizada passa pela propria regra");
}

// ════════════ 6) TEMPLATE: o sinal e do SERVIDOR ══════════════════════════════
{
  ok(pedeTemplate({ use_template: true }), "o 403 com use_template abre o seletor");
  ok(!pedeTemplate({ use_template: "true" }), "\"true\" texto NAO conta (nao inventar sinal)");
  ok(!pedeTemplate({ use_template: 1 }), "1 nao conta");
  ok(!pedeTemplate({ error: "janela de 24h FECHADA" }), "a FRASE do erro nao abre o seletor — so o campo");
  ok(!pedeTemplate({}), "resposta sem o campo nao abre");
  ok(!pedeTemplate(null), "null nao abre");
  ok(!pedeTemplate("use_template"), "texto solto nao abre");
}

// ════════════ 7) O SELETOR so oferece o que da pra enviar ═════════════════════
{
  const aprovado = template("Ola {{1}}", { nome: "ok_1", status: "aprovado" });
  const analise = template("Ola {{1}}", { nome: "em_fila", status: "em_analise" });
  const recusado = template("Ola {{1}}", { nome: "nao", status: "recusado" });
  const pausado = template("Ola {{1}}", { nome: "pausa", status: "pausado" });
  const semId = template("Ola {{1}}", { nome: "sem_id", status: "aprovado", provider_id: "" });
  eq(
    templatesEnviaveis([aprovado, analise, recusado, pausado, semId]).map((t) => t.nome),
    ["ok_1"],
    "so o APROVADO com identificador no provedor entra no seletor"
  );

  // ─── A TELA NAO TEM REGRA PROPRIA DE ENVIO: ela DELEGA pra `podeEnviarTemplate`.
  //
  // Esta secao cobra a DELEGACAO, nao a lista de casos, e isso e deliberado. A 1a
  // revisao cega achou o template com CABECALHO DE IMAGEM sem `midia_url` (o
  // Gupshup devolve 202, `lerRespostaEnvio` conta como sucesso e a Meta dropa a
  // entrega em silencio) e mandou barra-lo aqui. O caso fecha NA RAIZ, dentro de
  // `podeEnviarTemplate`, e esse fechamento e da FRENTE Z. Fixar a frase da
  // imagem nesta prova amarraria a tela a UMA versao da regra da raiz e quebraria
  // no merge; cobrando a delegacao, a tela aperta junto com a raiz sem alteracao.
  //
  // MAS A FRENTE Z NAO ESTA MERGEADA NESTA ARVORE (branch
  // `frente-z-template-params`, commit 95315f1): aqui `podeEnviarTemplate` AINDA
  // NAO tem a regra da imagem, entao `img_sem_arte` sai na lista de enviaveis dos
  // dois lados e o caso SEGUE PASSANDO. A delegacao, por construcao, nunca acusa
  // isso — as duas pontas concordam. Quem cobra e
  // `scripts/prova-pendencia-z-imagem.ts`, que REPROVA DE PROPOSITO ate o merge e
  // fica verde sozinho quando ele acontecer. Este bloco continua medindo so a
  // delegacao; afrouxar a tela continua sendo pego aqui.
  const todos = [aprovado, analise, recusado, pausado, semId,
    template("Ola {{1}}", { nome: "img_sem_arte", cabecalho: "IMAGE", midia_url: "" }),
    template("Ola {{1}}", { nome: "img_ok", cabecalho: "IMAGE", midia_url: "https://x/y.png" })];
  for (const t of todos) {
    const raiz = podeEnviarTemplate(t);
    const tela = motivoDeNaoEnviar(t);
    eq(tela === null, raiz.ok, `a tela concorda com a raiz sobre "${t.nome}"`);
    if (!raiz.ok) eq(tela, raiz.motivo, `e mostra o motivo EXATO da raiz pra "${t.nome}"`);
  }
  eq(
    templatesEnviaveis(todos).map((t) => t.nome),
    todos.filter((t) => podeEnviarTemplate(t).ok).map((t) => t.nome),
    "o seletor lista exatamente o que a raiz libera — nem mais, nem menos"
  );
  // TODO BARRADO TEM MOTIVO VISIVEL. Barrado sem explicacao e a versao escrita do
  // botao que trava calado; e um motivo vazio faria a lista de baixo mostrar so o
  // nome do template, que e pior que nao mostrar.
  for (const t of todos.filter((x) => !podeEnviarTemplate(x).ok)) {
    const m = motivoDeNaoEnviar(t);
    ok(m && m.trim().length > 10, `o barrado "${t.nome}" aparece com motivo legivel`);
  }
  eq(motivoDeNaoEnviar(null), podeEnviarTemplate(null).ok ? null : podeEnviarTemplate(null).motivo,
    "template nulo tambem cai na regra da raiz, sem explodir");
  eq(templatesEnviaveis(null).length, 0, "catalogo null nao explode");
  eq(templatesEnviaveis([]).length, 0, "catalogo vazio nao explode");

  // CAMPOS: os numeros REAIS do corpo, nao a contagem. A diferenca e o que
  // impede o formulario de desenhar 3 campos pra 2 variaveis.
  eq(camposDoTemplate(template("Ola {{1}}, dia {{2}}")), [1, 2], "dois campos pra duas variaveis");
  eq(camposDoTemplate(template("Ola, tudo bem?")), [], "template sem variavel nao pede campo");
  eq(camposDoTemplate(template("Ola {{1}}, {{1}} de novo")), [1], "variavel repetida e UM campo");
  eq(camposDoTemplate(template("Ola {{1}}, dia {{ 2 }}")), [1, 2], "espaco dentro das chaves nao cria campo a mais");

  // PARAMETROS: a mesma regra da rota.
  const dois = template("Ola {{1}}, dia {{2}}");
  eq(problemaDosParametros(dois, ["Eric", "10/09"]), null, "quantidade exata passa");
  ok(problemaDosParametros(dois, ["Eric"]), "faltando um parametro e recusado");
  ok(problemaDosParametros(dois, ["Eric", "10/09", "sobra"]), "parametro a mais e recusado (a Meta ignora em silencio)");
  ok(problemaDosParametros(dois, ["Eric", "  "]), "parametro vazio e recusado");
  ok(problemaDosParametros(dois, ["Eric", "10/09\ncom quebra"]), "quebra de linha e recusada (a Meta recusa o envio inteiro)");
  const zero = template("Ola, tudo bem?");
  eq(problemaDosParametros(zero, []), null, "template sem variavel envia sem parametro");
  ok(problemaDosParametros(zero, ["sobra"]), "e recusa parametro que ninguem pediu");

  // ─── O ACHADO DESTA FRENTE, medido em 31/08/2026: NUMERACAO COM BURACO.
  // `validarParametros` conta variaveis DISTINTAS e o envio casa por POSICAO.
  // Sem esta trava, o cliente recebe uma coisa e o historico grava outra — sem
  // erro em lugar nenhum.
  const buraco = template("Ola {{1}}, sua consulta e dia {{3}}.", { nome: "gap" });
  eq(buraco.variaveis, 2, "o catalogo conta 2 variaveis distintas no corpo com buraco");
  eq(camposDoTemplate(buraco), [1, 3], "e os numeros REAIS sao 1 e 3");
  eq(
    renderizarTemplate(buraco.corpo, ["Eric", "10/09"]),
    "Ola Eric, sua consulta e dia {{3}}.",
    "o render POSICIONAL deixa {{3}} cru — este e o dano medido"
  );
  const p = problemaDosParametros(buraco, ["Eric", "10/09"]);
  ok(p, "e a tela RECUSA enviar o template com numeracao furada");
  ok(p && p.includes("{{1}}") && p.includes("{{3}}"), "dizendo QUAIS numeros o template usa");
  ok(p && /renumerar/.test(p), "e o que precisa ser feito (renumerar na Meta), sem travar em silencio");
  eq(problemaDosParametros(template("Ola {{2}}"), ["Eric"]), problemaDosParametros(template("Ola {{2}}"), ["Eric"]),
    "a recusa e estavel (mesma entrada, mesma frase)");
  ok(problemaDosParametros(template("Ola {{2}}"), ["Eric"]), "corpo que comeca em {{2}} tambem e recusado");

  // PREVIA: e literalmente o que vai pro historico (mesma `renderizarTemplate`
  // que a rota usa pra gravar). Template, uma vez enviado, nao volta.
  eq(previaDoTemplate(dois, ["Eric", "10/09"]), "Ola Eric, dia 10/09", "a previa e o texto renderizado");
  eq(
    previaDoTemplate(template("Ola {{1}}", { rodape: "Expert Integrado" }), ["Eric"]),
    "Ola Eric\n\nExpert Integrado",
    "e o rodape aprovado entra na previa (o cliente vai ler ele tambem)"
  );
  eq(previaDoTemplate(template("Ola {{1}}"), []), "Ola {{1}}",
    "campo ainda em branco mostra o buraco, nao \"Ola undefined\"");
}

// ════════════ 8) DERIVA: schema (sanidade) x interativas (plataforma) ═════════
// DOIS TETOS EM DOIS LUGARES, de proposito:
//  * `lib/fluxo/schema.ts` nao pode importar NADA (a prova do motor trava
//    `importsDe(schema.ts) === []`) e `validarFluxo` roda tambem em caminhos de
//    LEITURA — recusar ali por regra de plataforma quebraria a leitura de fluxo
//    que ja esta gravado;
//  * a regra da PLATAFORMA (3 botoes, 10 itens, titulo 20/24) e cobrada no
//    PREFLIGHT, antes de o fluxo comecar a rodar.
// A DIRECAO E O INVARIANTE: schema >= plataforma. Apertar o schema abaixo da
// plataforma faz o preflight virar codigo morto e a pergunta invalida voltar a
// morrer no MEIO do fluxo (metade dos passos ja executados).
{
  eq([...TIPOS_PERGUNTA], [...TIPOS_INTERATIVA],
    "os tipos de pergunta do schema sao EXATAMENTE os da plataforma");
  ok(LIMITE_TEXTO >= LIMITE_TEXTO_INTERATIVA,
    "o teto do corpo no schema nao pode ser menor que o da plataforma");
  const rotulos = [LIMITE_TITULO_BOTAO, LIMITE_TITULO_ITEM, LIMITE_DESCRICAO_ITEM, LIMITE_RODAPE_INTERATIVA, LIMITE_BOTAO_LISTA];
  ok(rotulos.every((t) => LIMITE_ROTULO_PERGUNTA >= t),
    `o teto unico de rotulo do schema (${LIMITE_ROTULO_PERGUNTA}) cobre todos os da plataforma (${rotulos.join(", ")})`);
  ok(LIMITE_OPCOES_PERGUNTA >= Math.max(MAX_BOTOES, MAX_ITENS_LISTA),
    "o teto de opcoes do schema cobre o maior teto da plataforma");

  // O MINIMO vai na direcao CONTRARIA (o schema e o portao de fora): se ele
  // exigisse mais opcoes que a plataforma, recusaria fluxo que a plataforma
  // aceita. O minimo da plataforma e MEDIDO, nao lido de constante — em
  // lib/interativas.ts ele e um literal.
  let minPlataforma = 0;
  for (let k = 1; k <= 5; k += 1) {
    const v = validarInterativa({
      tipo: "botoes",
      texto: "escolha",
      opcoes: Array.from({ length: k }, (_, i) => ({ titulo: `op${i + 1}` })),
    });
    if (v.ok) { minPlataforma = k; break; }
  }
  ok(minPlataforma > 0, `o minimo de opcoes da plataforma foi medido (${minPlataforma})`);
  ok(MIN_OPCOES_PERGUNTA <= minPlataforma,
    "e o minimo do schema nao e MAIS exigente que o da plataforma");
  // E O SCHEMA TEM QUE COBRAR O MINIMO DE VERDADE. Pergunta com UMA opcao nao e
  // pergunta: no fallback de texto numerado ela vira "1. Sim" e o cliente fica sem
  // escolha nenhuma. Sem esta assercao, apagar a checagem do schema passava verde.
  ok(!fluxoComPergunta({ tipo: "botoes", texto: "escolha", opcoes: [{ titulo: "so uma" }] }).ok,
    "o schema RECUSA pergunta com uma opcao so");
  ok(!fluxoComPergunta({ tipo: "botoes", texto: "escolha", opcoes: [] }).ok,
    "e recusa pergunta sem opcao nenhuma");
  ok(fluxoComPergunta({ tipo: "botoes", texto: "escolha", opcoes: [{ titulo: "a" }, { titulo: "b" }] }).ok,
    "duas opcoes passam");
  // linha em branco e AUSENCIA (mesma leitura do conversor e do editor novo): duas
  // opcoes mais uma linha vazia continuam sendo duas, nao tres.
  ok(fluxoComPergunta({ tipo: "botoes", texto: "escolha", opcoes: ["a", "   ", "b"] }).ok,
    "opcao em branco no meio nao conta e nao quebra");
  ok(!fluxoComPergunta({ tipo: "botoes", texto: "escolha", opcoes: ["a", "   "] }).ok,
    "mas ela tambem nao COMPLETA o minimo");

  // A PROVA DE QUE O PREFLIGHT E NECESSARIO: existe fluxo que o schema ACEITA e
  // a plataforma RECUSA. Se este par deixar de existir (schema apertado ate a
  // regra da plataforma), a secao acima protege a direcao — e este caso avisa
  // que a divisao de responsabilidade mudou.
  const vinte = Array.from({ length: 20 }, (_, i) => ({ titulo: `op${i + 1}` }));
  const aceito = fluxoComPergunta({ tipo: "botoes", texto: "escolha", opcoes: vinte });
  ok(aceito.ok, `o schema aceita 20 opcoes em botoes (teto de SANIDADE do jsonb) — ${aceito.ok ? "" : aceito.erros.join("; ")}`);
  const negado = validarInterativa({ tipo: "botoes", texto: "escolha", opcoes: vinte });
  ok(!negado.ok, "e a plataforma recusa (3 botoes) — e por isso que o preflight existe");
  const tituloLongo = fluxoComPergunta({
    tipo: "botoes",
    texto: "escolha",
    opcoes: [{ titulo: "a".repeat(60) }, { titulo: "b" }],
  });
  ok(tituloLongo.ok, "o schema aceita rotulo de 60 (sanidade)");
  ok(!validarInterativa({ tipo: "botoes", texto: "escolha", opcoes: [{ titulo: "a".repeat(60) }, { titulo: "b" }] }).ok,
    "e a plataforma recusa (20 no botao)");
}

// ════════════ 9) GUARDAS ESTRUTURAIS de app/home.tsx ══════════════════════════
// Fiacao desfeita nao quebra build nem teste: a tela compila, a bateria fica
// verde e o defeito volta calado. Por isso estas guardas leem CODIGO (comentario
// removido) e cobram a coisa exata que uma refatoracao distraida apaga.
{
  const home = semComentario(ler("app/home.tsx"));

  // ─── resposta rapida (frente T)
  ok(/function aplicarRespostaRapida\(r: RespostaRapida\)/.test(home),
    "existe UM caminho de aplicar resposta rapida");
  ok(/setDraft\(textoParaCaixa\(r\)\)/.test(home),
    "e ele usa textoParaCaixa (o texto ja resolvido), nao o cru");
  ok(/const av = avisoDeVariaveis\(r\);\s*\n\s*if \(av\) setAviso\(av\);/.test(home),
    "o aviso de variavel sobe pro banner (a lista fecha no clique; o risco fica)");
  eq((home.match(/aplicarRespostaRapida\(/g) ?? []).length, 3,
    "aplicarRespostaRapida e definida UMA vez e chamada nos DOIS caminhos (clique e Enter)");
  // O DEFEITO ORIGINAL, nomeado: os dois caminhos faziam setDraft do texto CRU.
  ok(!/setDraft\(r\.texto\)/.test(home), "nenhum caminho manda o texto CRU pra caixa (clique)");
  ok(!/setDraft\(alvo\.texto\)/.test(home), "nem por Enter no atalho");
  ok(/respostasDoAtalho\(respostasRapidas, draft\)/.test(home),
    "o filtro do atalho vem da lib (um so pros dois caminhos)");
  eq((home.match(/respostasDoAtalho\(/g) ?? []).length, 2, "e e o mesmo filtro na lista e no Enter");
  ok(!/r\.atalho\.startsWith\(/.test(home), "o .tsx nao remonta o filtro na mao");
  // SEM ISSO A COSTURA MORRE PARECENDO VIVA: a rota so resolve as variaveis
  // quando recebe canal+chat_id, e a carga da abertura do painel nao tem conversa.
  ok(/carregarRespostasRapidas\(\{ chat_id: c\.chat_id, canal: c\.canal \}\)/.test(home),
    "abrir conversa recarrega as respostas COM a conversa (senao nunca vem resolvido)");
  ok(/chat_id=\$\{encodeURIComponent\(conversa\.chat_id\)\}&canal=\$\{encodeURIComponent\(conversa\.canal\)\}/.test(home),
    "e os dois parametros vao na URL, escapados");

  // ─── memoria da conversa (frente V)
  ok(/abaFicha === "memoria"/.test(home), "a gaveta da ficha tem a aba de memoria");
  ok(/if \(aba === "memoria" && !memoria && active\) carregarMemoria\(active\.chat_id, active\.canal\)/.test(home),
    "que carrega ao ABRIR (nao no poll de 3s)");
  ok(/\/api\/conversa\/contexto\?chat_id=\$\{encodeURIComponent\(chatId\)\}&canal=\$\{encodeURIComponent\(canalDaConversa\)\}/.test(home),
    "o GET leva chat_id e canal escapados");
  // 503 / rede fora NAO pode virar painel vazio: "esta conversa nao tem memoria"
  // e uma AFIRMACAO, e a tela nao pode faze-la quando a verdade e "nao deu pra ler".
  eq((home.match(/aviso: j\.error \|\| "Nao deu pra ler a memoria desta conversa\."/g) ?? []).length, 1,
    "o erro da rota vira AVISO na tela");
  eq((home.match(/aviso: "Nao deu pra ler a memoria desta conversa\."/g) ?? []).length, 1,
    "e a falha de rede tambem (nao fica em \"Carregando...\" pra sempre)");
  // O RENDER, nao so o SETTER. A guarda anterior prendia quem GRAVA o aviso; a
  // mutacao que troca `memoria.aviso ?` por `false ?` no corpo do JSX passava
  // verde e fazia o 503 virar "esta conversa ainda nao tem nenhuma variavel
  // gravada" — a classe "prova de texto nao alcanca o corpo" que o CLAUDE.md
  // nomeia.
  ok(/\) : memoria\.aviso \? \(/.test(home), "o aviso e o que o JSX DECIDE mostrar antes da lista");
  ok(/<p className="text-\[11px\] text-amber-800">\{memoria\.aviso\}<\/p>/.test(home),
    "e o texto que aparece e o da rota");
  ok(/memoria\.pode_editar \? \(/.test(home),
    "o formulario de gravar aparece so quando o SERVIDOR disse pode_editar");
  ok(/\{memoria\.pode_editar && \(/.test(home), "e os botoes por par tambem");
  ok(/editar_contexto/.test(home), "quem nao pode editar le QUAL permissao falta");
  // APAGAR e gesto separado de gravar vazio: so apagando a chave o `nao_existe`
  // das condicoes volta a valer.
  ok(/salvarMemoria\(par\.chave, "", true\)/.test(home), "apagar manda limpar:true");
  ok(/\.\.\.\(limpar \? \{ limpar: true \} : \{ valor \}\)/.test(home),
    "e o corpo do POST manda limpar OU valor, nunca os dois");
  ok(/const problema = problemaDoPar\(chave, valor\);/.test(home),
    "a regra de gravar e checada antes do clique (a mesma da rota)");
  ok(/setMemoria\(\(m\) => \(\{\s*\n\s*pares: paresDeContexto\(j\.contexto\)/.test(home),
    "a tela usa o mapa que a ESCRITA devolveu (nao relê: outra escrita entraria no meio)");
  ok(/chaveNormalizada\(memChave\)/.test(home), "a tela mostra como a chave vai ser gravada");

  // ─── template no composer (frente U)
  ok(/if \(pedeTemplate\(j\)\) \{/.test(home), "o 403 do /api/send passa por pedeTemplate");
  ok(!/j\.use_template/.test(home), "o .tsx nao le o campo na mao (a regra e da lib)");
  ok(/setDraft\(text\);/.test(home), "o texto recusado VOLTA pra caixa (nada de perda silenciosa)");
  ok(/setJanela\(\{ aberta: false, expira_em: null \}\)/.test(home),
    "e a tela passa a concordar com o servidor sobre a janela");
  ok(/setTplAberto\(true\);\s*\n\s*setTplEscolhido\(null\);/.test(home), "o seletor abre limpo");
  // O BANNER PASSOU A TER SAIDA. A frase antiga mandava usar template "fora do
  // painel" — era verdade, e era a costura declarada pela frente U.
  // A FRASE EXATA do banner antigo, nao "fora do painel" solto: essa expressao
  // tambem descreve mensagem enviada pelo APARELHO ("atendimento (fora do
  // painel)" na bolha), que e legitima e nao tem nada a ver com esta costura.
  ok(!/template aprovado \(fora do painel\)/.test(home),
    "o banner nao manda mais resolver o template fora do painel");
  ok(/Escolher template/.test(home), "ele oferece o seletor ali mesmo");
  // DUAS permissoes, e a segunda e a que a rota cobra: `GET /api/canais/templates`
  // e nivel `ler` = `gerenciar_canais`. Gateado so por `enviar`, o botao aparecia
  // pro papel embutido `normal` e o catalogo voltava 403 — o "botao que sempre da
  // 403" que esta mesma prova proibe duas linhas acima.
  ok(/function podeEscolherTemplate\(\): boolean \{/.test(home), "existe UM gate do seletor de template");
  ok(/temPermissao\("enviar"\) &&\s*\n\s*\(temPermissao\("gerenciar_canais"\) \|\| perfil\?\.papel === "super_admin"\)/.test(home),
    "e ele exige ENVIAR e a permissao que a rota do catalogo cobra");
  ok(/\{podeEscolherTemplate\(\) && !modoNota && !tplAberto && \(/.test(home),
    "o botao do banner usa esse gate");
  ok(/if \(pedeTemplate\(j\) && !podeEscolherTemplate\(\)\) \{/.test(home),
    "e quem NAO alcanca o catalogo recebe a frase em vez de um painel que so sabe dar 403");
  eq((home.match(/podeEscolherTemplate\(\)/g) ?? []).length, 3,
    "UM gate so, usado no botao e no 403 (o outro ramo do 403 e o `else` dele)");
  ok(/templatesEnviaveis\(tplCatalogo\)/.test(home), "o seletor lista so os enviaveis");
  // O BARRADO MOSTRA O MOTIVO REAL, vindo da MESMA funcao que decidiu a lista de
  // cima. Com `ROTULO_STATUS` sozinho, um template APROVADO barrado pela raiz (o
  // caso do cabecalho de imagem sem arte, frente Z) aparecia com o motivo
  // "aprovado" — barrado sem explicacao e o botao que trava calado, por escrito.
  ok(/\{motivoDeNaoEnviar\(t\)\}/.test(home), "o barrado traz o motivo de motivoDeNaoEnviar");
  ok(/ROTULO_STATUS\[t\.status\]/.test(home), "com o status junto, como rotulo curto");
  // A PREVIA SO PROMETE A IMAGEM QUANDO HA ARTE. Prometer o que nao sai e a previa
  // mentindo sobre a unica coisa que ela existe pra mostrar.
  ok(/tplEscolhido\.midia_url\.trim\(\)\s*\n?\s*\? "\+ a imagem aprovada junto com o texto\."/.test(home),
    "a previa so promete a imagem quando existe arte no espelho");
  ok(/SEM arte no espelho deste numero — nao vai imagem nenhuma/.test(home),
    "e diz o contrario quando nao existe");
  ok(/setTplParams\(camposDoTemplate\(t\)\.map\(\(\) => ""\)\)/.test(home),
    "um campo por variavel REAL do corpo");
  ok(/const problema = problemaDosParametros\(tplEscolhido, tplParams\)/.test(home),
    "o problema dos parametros e calculado na tela");
  ok(/\{problema && <p className="text-\[11px\] text-red-600">\{problema\}<\/p>\}/.test(home),
    "e MOSTRADO ao lado do botao");
  ok(/disabled=\{sending \|\| !!problema\}/.test(home),
    "o botao trava com o motivo visivel (nunca trava calado)");
  ok(/previaDoTemplate\(tplEscolhido, tplParams\)/.test(home),
    "a previa mostra o que o cliente vai ler (template enviado nao volta)");
  ok(/template: \{ nome: tplEscolhido\.nome, idioma: tplEscolhido\.idioma, params: tplParams \}/.test(home),
    "e o envio manda o contrato que /api/send espera");
  ok(!/<textarea[^>]*tplEscolhido/.test(home), "template aprovado NAO tem caixa de texto livre");

  // ─── entrada de NUMEROS no painel (costura 1 da frente U)
  ok(/visaoPainel === "canais" &&\s*\n\s*!embed &&\s*\n\s*\(temPermissao\("gerenciar_canais"\) \|\| perfil\?\.papel === "super_admin"\)/.test(home),
    "a permissao entra na CONDICAO da visao, nao so no botao");
  ok(/<AdminCanais authedFetch=\{authedFetch\} aoSair=\{\(\) => setVisaoPainel\("conversas"\)\} \/>/.test(home),
    "com o contrato que a frente U escreveu");
  ok(/\{\(temPermissao\("gerenciar_canais"\) \|\| perfil\?\.papel === "super_admin"\) && \(/.test(home),
    "e o mesmo gate no BOTAO (um sem o outro e botao que da 403, ou visao alcancavel por estado)");
  // Revisao de interface 02-03/09/2026: o MESMO gate ganhou dois usos novos — o item
  // "Numeros" do mapa de Configuracoes (tranche 1) e o item "Numeros" do trilho lateral
  // (tranche 2). Sao as mesmas cinco portas pra mesma tela; uma com gate diferente das
  // outras seria porta que da 403 ou porta invisivel pra quem pode entrar.
  eq((home.match(/temPermissao\("gerenciar_canais"\) \|\| perfil\?\.papel === "super_admin"/g) ?? []).length, 5,
    "cinco usos: a visao, o botao dela, o seletor de template, o item do mapa de Configuracoes e o item do trilho");

  // ─── GRAVE 2 da 1a revisao cega: DOIS CONSUMIDORES, DOIS ESTADOS.
  //
  // `respostasRapidas` (composer) precisa da lista COM `texto_resolvido`;
  // `rrCadastro` (Configuracoes) precisa da lista CRUA. Era UM estado so, e criar
  // ou apagar uma resposta rapida com conversa aberta sobrescrevia o do composer
  // com a versao crua — o `/boas` seguinte mandava `!nome` LITERAL pro cliente.
  // O defeito do card 86ak86jw9, reaberto pela porta dos fundos, sem nada na tela
  // dizendo e so "consertavel" trocando de conversa.
  ok(/const \[rrCadastro, setRrCadastro\] = useState<RespostaRapida\[\]>\(\[\]\);/.test(home),
    "o cadastro tem estado PROPRIO");
  ok(/async function carregarCadastroRespostas\(\)/.test(home), "e funcao de carga propria");
  ok(/if \(Array\.isArray\(j\.respostas\)\) setRrCadastro\(j\.respostas\);/.test(home),
    "que escreve SO no estado do cadastro");
  ok(/\{rrCadastro\.map\(\(r\) => \(/.test(home), "a lista do modal le rrCadastro");
  ok(!/\{respostasRapidas\.map\(/.test(home), "e o modal nao le mais o estado do composer");
  ok(!/\{respostasRapidas\.length === 0 &&/.test(home), "nem o vazio dele");
  // As duas escritas (criar e apagar) refazem AS DUAS listas — e a do composer
  // COM a conversa aberta, senao ela voltaria crua justamente pelo caminho que
  // este bloco existe pra fechar.
  eq((home.match(/carregarCadastroRespostas\(\)/g) ?? []).length, 4,
    "criar e apagar recarregam a lista do cadastro (mais definicao e o efeito)");
  eq((home.match(/if \(active\) carregarRespostasRapidas\(\{ chat_id: active\.chat_id, canal: active\.canal \}\)/g) ?? []).length, 2,
    "e as duas refazem a do composer JA resolvida");
  // A JANELA ERA O BURACO (revisao 2). O recorte comecava em
  // `abaConfig === "respostas"` (linha ~1374 da tela) e a chamada CRUA da
  // MONTAGEM estava na ~1339 — FORA da janela, sem guarda nenhuma. Ela pedia a
  // lista sem chat_id/canal e escrevia no estado do COMPOSER; com a rota fria e
  // o atendente abrindo conversa antes de ela voltar, o cru sobrescrevia o
  // resolvido e o `/boas` seguinte mandava `!nome` LITERAL. Agora a guarda vale
  // pro ARQUIVO INTEIRO: nao existe lugar nenhum da tela onde a lista do
  // composer possa ser carregada sem a conversa a que ela pertence.
  eq((home.match(/carregarRespostasRapidas\(\s*\)/g) ?? []).length, 0,
    "nenhuma chamada de carregarRespostasRapidas SEM conversa em NENHUM ponto da tela");

  // ─── MEDIA 3: capacidade e da FONTE, nao do id do canal.
  // Com `canal === "apioficial"` hardcodado, um SEGUNDO numero de API oficial em
  // CANAIS_EXTRA recebia o 403 com use_template, abria o seletor no estado e o
  // painel NUNCA renderizava — texto de volta, aviso "escolha um template" e zero
  // caminho, com `tplAberto` travado em true escondendo o botao do banner.
  ok(/\{tplAberto && fonteDoCanalAtivo\(\) === "gupshup" && \(/.test(home),
    "o painel de template abre pela FONTE");
  ok(/\{fonteDoCanalAtivo\(\) === "gupshup" && janela && !janela\.aberta && \(/.test(home),
    "o banner da janela fechada tambem");
  ok(/\{fonteDoCanalAtivo\(\) === "gupshup" && janela\?\.aberta && janela\.expira_em && \(/.test(home),
    "e o banner da janela aberta");
  ok(/disabled=\{fonteDoCanalAtivo\(\) === "gupshup" && janela !== null && !janela\.aberta && !modoNota\}/.test(home),
    "e a trava da caixa de digitacao");
  ok(!/canal === "apioficial"/.test(home),
    "nenhum id de canal hardcodado decide capacidade nesta tela");

  // ─── BAIXA 6: apagar variavel da memoria e DESTRUTIVO e nao tem desfazer — a
  //     automacao le exatamente aquela chave. Dois passos, como as outras.
  ok(/memApagar === par\.chave \? \(/.test(home), "apagar variavel pede confirmacao");
  ok(/onClick=\{\(\) => setMemApagar\(par\.chave\)\}/.test(home), "o 1o clique so arma");
  ok(/onClick=\{\(\) => \{ setMemApagar\(null\); salvarMemoria\(par\.chave, "", true\); \}\}/.test(home),
    "e o 2o apaga de verdade (ainda com limpar:true)");
  ok(/setMemApagar\(null\);/.test(home.slice(home.indexOf("function abrirConversa"), home.indexOf("function abrirConversa") + 3000)),
    "e a confirmacao armada nao atravessa a troca de conversa");

  // ─── BAIXA 7: o estado de erro tem SAIDA. Rede que cai volta, e sem o botao o
  //     unico jeito de tentar de novo era trocar de conversa e voltar.
  ok(/Tentar de novo/.test(home), "o aviso da memoria tem botao de tentar de novo");
  ok(/onClick=\{\(\) => \{ setMemoria\(null\); if \(active\) carregarMemoria\(active\.chat_id, active\.canal\); \}\}/.test(home),
    "que limpa o estado e recarrega");

  // ─── as tres costuras sao POR CONVERSA: dado da anterior sobrando e pior que
  //     painel vazio (memoria de outro cliente, parametro digitado pra outro).
  for (const zera of ["setMemoria(null)", "setTplAberto(false)", "setTplCatalogo(null)", "setTplEscolhido(null)", "setMemChave(\"\")"]) {
    ok(home.includes(zera), `abrir conversa zera ${zera}`);
  }
}

// ════════════ 10) GUARDAS do passo interativo (lib/fluxo/executar.ts) ═════════
// O passo `perguntar_opcoes` (contrato da frente S) reusa `enviarTexto` de
// proposito: duas copias do caminho de envio e a divergencia mais cara possivel
// (assinatura, dedupe, gravacao da mensagem, preview da conversa).
{
  const exec = semComentario(ler("lib/fluxo/executar.ts"));
  ok(/async function perguntarOpcoes\(/.test(exec), "o passo existe");
  ok(/return enviarTexto\(ctx, msg\.texto, \{/.test(exec),
    "e ele DELEGA pro enviarTexto (um caminho de envio, nao dois)");
  ok(!/async function enviarPergunta\(/.test(exec), "nao ha um segundo caminho de envio paralelo");

  // ─── `executar.ts` OBEDECE A DECISAO PURA, campo a campo.
  //
  // O QUE ESTAS GUARDAS SAO, e o que elas NAO sao. Elas sao de FORMA: prendem uma
  // expressao exata. Isso so vale a pena porque a DECISAO por tras de cada campo
  // deixou de morar aqui — ela e medida por desfecho na secao 11. O que sobra pra
  // este arquivo e obediencia, e uma mutacao aqui e contradicao visivel (o valor
  // pronto ao lado, ignorado), nao uma regra mudando de significado em silencio.
  // Guarda de forma sobre DECISAO foi exatamente o que deixou oito mutacoes
  // passarem na 1a revisao; sobre OBEDIENCIA ela e o instrumento certo.
  ok(/const plano = planoDaPergunta\(c\.fonte, ctx\.chat_id, msg\);/.test(exec),
    "o passo pede o plano pronto (fonte e chat_id crus, sem reimplementar grupo)");
  ok(!/planoDeEnvio\(/.test(exec), "e nao consulta planoDeEnvio por fora do plano");
  ok(!/-group\$/.test(exec), "nem redetecta grupo aqui");
  for (const campo of ["previa: plano.previa", "conteudo: plano.conteudo", "tipo: plano.tipo", "detalhe: plano.detalhe"]) {
    ok(exec.includes(campo), `o passo usa \`${campo}\` do plano, sem recalcular`);
  }
  // O DESPACHO E UM SWITCH SOBRE A ROTA, e cada braco vai pra porta certa. Com
  // quatro `if` encadeados, trocar um `modo === "nativo"` por `true` era invisivel.
  ok(/switch \(plano\.rota\) \{/.test(exec), "o envio despacha pela ROTA do plano");
  for (const [caso, fn] of [
    ["gupshup_nativo", "gsSendInterativo"],
    ["zapi_nativo", "zapiSendOptionList"],
    ["gupshup_texto", "gsSendText"],
    ["zapi_texto", "zapiSendText"],
  ] as const) {
    const trecho = exec.slice(exec.indexOf(`case "${caso}":`));
    ok(trecho.slice(0, 200).includes(fn), `a rota ${caso} chama ${fn}`);
  }
  ok(/default:[\s\S]{0,300}throw new Error\(`fonte \$\{c\.fonte\} nao envia pergunta com opcoes`\)/.test(exec),
    "e rota desconhecida RECUSA (nunca cai num else que usaria a porta do provedor errado)");
  ok(/plano\.numerado/.test(exec) && !/textoNumerado\(/.test(exec),
    "o corpo do fallback vem calculado do plano, uma vez so");

  // ─── `enviarTexto` OBEDECE `saidaDaMensagem` nos cinco pontos.
  ok(/const saida = saidaDaMensagem\(texto, especial\);/.test(exec), "a saida e decidida uma vez");
  ok(/const textoEnviar = saida\.assinar \? await assinaturaDe\(db, usuario, texto\) : texto;/.test(exec),
    "a assinatura obedece `saida.assinar` (assinar a pergunta estoura o teto e a Meta recusa a mensagem inteira)");
  // No merge da onda 5 os efeitos de resposta viraram funcao unica da Frente W
  // (`efeitosDeResposta`); a previa da saida entra por argumento — a propriedade
  // e a mesma (o texto cru nao vira previa), so mudou a costura.
  ok(/efeitosDeResposta\(ctx, conversa, `\$\{usuario\.nome\}: \$\{saida\.previa\}`\)/.test(exec),
    "a previa da lista vem da saida");
  ok(/\n\s*tipo: saida\.tipo,/.test(exec), "o tipo gravado vem da saida");
  ok(/conteudo: saida\.conteudo \?\? textoEnviar,/.test(exec),
    "o conteudo gravado vem da saida (null = o texto que saiu pela porta)");
  ok(/detalhe: saida\.detalhe,/.test(exec), "e o detalhe da trilha tambem");
  ok(!/especial \? especial\./.test(exec), "nenhum ternario `especial ?` sobrou solto no meio da funcao");
  ok(/case "perguntar_opcoes":\s*\n?\s*return perguntarOpcoes\(ctx, acao\.params\);/.test(exec),
    "o switch de acao chama o passo");
  // O PREFLIGHT: recusar a pergunta invalida ANTES de o fluxo comecar. Sem isso o
  // fluxo roda metade dos passos e morre no meio, com o cliente ja mexido.
  ok(/function motivoDaPerguntaInvalida\(/.test(exec), "existe o preflight da pergunta");
  ok(/return motivoDaPerguntaInvalida\(fluxo\);/.test(exec), "e motivoParaRecusar chama ele");
  ok(/validarInterativa\(/.test(exec), "usando a regra da PLATAFORMA (lib/interativas.ts)");
  ok(/if \(!noAtivo\(no\)\) continue;/.test(exec), "o preflight pula passo desligado (nao recusa por passo inativo)");
  // O preflight olha a LISTA, nao o literal `enviar_texto`: com o literal, macro
  // com pergunta em canal sem credencial passava e morria no meio.
  const puro = semComentario(ler("lib/fluxo/schema.ts"));
  ok(/ACOES_QUE_ALCANCAM_CLIENTE\.includes\(no\.acao\.tipo\) && !cap\.envioCabeado/.test(puro),
    "a recusa por canal sem envio olha a LISTA de acoes que alcancam o cliente");
  ok(!/no\.acao\.tipo === "enviar_texto" && !cap\.envioCabeado/.test(puro),
    "e nao o literal enviar_texto (que deixava a pergunta passar)");
}


// ════ 11) A PERGUNTA COM OPCOES, POR DESFECHO (lib/fluxo/pergunta.ts) ════════
//
// Esta secao existe porque a 1a revisao cega mediu o preco de nao ter: a decisao
// do passo morava dentro de `lib/fluxo/executar.ts`, que importa banco, provedor
// e config — nenhuma prova carrega aquele arquivo. Tudo ali estava preso so por
// GREP DE FORMA ("delega pro enviarTexto"), e OITO mutacoes que mudam o que o
// CLIENTE recebe passavam com a bateria verde. Agora a decisao e pura.
{
  const perg = (tipo: "botoes" | "lista", n = 2): Interativa => {
    const v = validarInterativa({
      tipo,
      texto: "Qual dia fica melhor?",
      opcoes: Array.from({ length: n }, (_, i) => ({ titulo: `op${i + 1}` })),
    });
    assert.equal(v.ok, true, "o caso base da secao 11 tem que ser valido");
    return (v as { ok: true; msg: Interativa }).msg;
  };
  const DIRETO = "5511999999999";
  const GRUPO = "120363000000000000-group";

  // ─── quem e GRUPO. Era um regex solto dentro da funcao de envio, e um `false`
  //     digitado no lugar dele nao mudava nada que a bateria enxergasse.
  ok(ehGrupo(GRUPO), "chat_id com sufixo -group e grupo");
  ok(!ehGrupo(DIRETO), "conversa 1:1 nao e");
  ok(!ehGrupo("5511-group-x"), "-group no MEIO do id nao conta");
  ok(!ehGrupo(null), "id ausente nao explode e nao vira grupo");

  // ─── API OFICIAL: os dois formatos sao nativos, inclusive em grupo.
  const g1 = planoDaPergunta("gupshup", DIRETO, perg("botoes"));
  eq(g1.modo, "nativo", "botoes na API oficial saem nativos");
  eq(g1.rota, "gupshup_nativo", "pela porta de interativa da Gupshup");
  eq(g1.tipo, "interactive_quick_reply", "e a linha grava o tipo do recurso que saiu");
  ok(g1.previa.startsWith("[botoes]"), "a previa da barra lateral diz botoes");
  ok(/^pergunta enviada \(botoes, 2 opcoes\)$/.test(g1.detalhe), "e a trilha registra o modo real");
  const g2 = planoDaPergunta("gupshup", GRUPO, perg("lista", 4));
  eq(g2.modo, "nativo", "lista na API oficial sai nativa mesmo em grupo");
  eq(g2.tipo, "interactive_list", "com o tipo de lista");

  // ─── Z-API, BOTOES: a doc do provedor declara que botao vem falhando.
  //     Mutacao que tira `modo === "nativo"` do ramo zapi mandava o botao NATIVO.
  const z1 = planoDaPergunta("zapi", DIRETO, perg("botoes"));
  eq(z1.modo, "texto_numerado", "botoes em numero comum caem no fallback");
  eq(z1.rota, "zapi_texto", "e vao pela porta de TEXTO, nao pela de interativa");
  eq(z1.tipo, "text", "a linha grava `text`, nao um recurso que nao houve");
  ok(z1.previa.startsWith("[pergunta]"), "e a previa nao promete botao");
  ok(/TEXTO NUMERADO/.test(z1.detalhe), "a trilha diz que saiu numerada");
  ok(z1.motivo && /instaveis|falhando/.test(z1.motivo), "com o motivo do provedor junto");

  // ─── Z-API, LISTA: nativa em 1:1, numerada em GRUPO. O `grupo: false` digitado
  //     no lugar da deteccao mandava lista NATIVA pra grupo, que a Z-API declara
  //     que nao funciona — e nada na bateria via.
  const z2 = planoDaPergunta("zapi", DIRETO, perg("lista", 5));
  eq(z2.modo, "nativo", "lista em conversa 1:1 sai nativa no numero comum");
  eq(z2.rota, "zapi_nativo", "pela porta de lista da Z-API");
  const z3 = planoDaPergunta("zapi", GRUPO, perg("lista", 5));
  eq(z3.modo, "texto_numerado", "a MESMA lista em GRUPO cai no fallback");
  eq(z3.rota, "zapi_texto", "e troca de porta junto");
  ok(z3.motivo && /GRUPO/.test(z3.motivo), "com o motivo dizendo que e por ser grupo");

  // ─── FONTE SEM ENVIO INTERATIVO: recusa, nunca um `else` que mandaria texto
  //     pela porta do provedor errado, com credencial de outro provedor.
  const ev = planoDaPergunta("evolution", DIRETO, perg("botoes"));
  eq(ev.rota, null, "fonte sem interativa cabeada nao ganha rota");
  eq(planoDaPergunta("", DIRETO, perg("lista")).rota, null, "fonte vazia idem");

  // ─── O CORPO DO FALLBACK e o mesmo que sai e que fica gravado.
  ok(z1.numerado.includes("1."), "o texto numerado numera as opcoes");
  ok(z1.numerado.includes("Qual dia fica melhor?"), "e carrega a pergunta");
  eq(z1.conteudo, z1.numerado, "no fallback, o que fica gravado E o que saiu");
  ok(g1.conteudo.includes("[botoes de resposta rapida]"),
    "no nativo, o gravado leva o selo do recurso (a bolha mostra as opcoes oferecidas)");
  ok(g1.conteudo.includes("op1") && g1.conteudo.includes("op2"),
    "e as opcoes, senao o historico perde o que foi oferecido");

  // ─── SAIDA ESPECIAL x TEXTO NORMAL: as cinco diferencas, numa funcao so.
  const normal = saidaDaMensagem("Bom dia, tudo bem?");
  ok(normal.assinar, "texto normal do fluxo SEGUE assinado (nada mudou pra ele)");
  eq(normal.tipo, "text", "e grava `text`");
  eq(normal.conteudo, null, "null = grava o texto que saiu pela porta (o assinado)");
  eq(normal.previa, "Bom dia, tudo bem?", "a previa e o proprio texto");
  ok(/^mensagem enviada \(18 chars\)$/.test(normal.detalhe), "e a trilha conta os chars");

  const esp = saidaDaMensagem("Qual dia?", {
    previa: "[lista] Qual dia?", conteudo: "corpo gravado", tipo: "interactive_list", detalhe: "pergunta enviada",
  });
  // ISTO NAO E ESTILO: a assinatura poe `*Nome:*` na frente do corpo, o corpo do
  // interativo tem teto de plataforma (1024 na Meta) e o texto ja passou por
  // `validarInterativa` COM o tamanho final. Assinar depois estoura o teto e a
  // Meta recusa a mensagem INTEIRA — o cliente nao recebe nada e o painel diz
  // "enviado".
  ok(!esp.assinar, "a pergunta com opcoes NAO e assinada");
  eq(esp.previa, "[lista] Qual dia?", "a previa vem da saida especial");
  eq(esp.tipo, "interactive_list", "o tipo tambem");
  eq(esp.conteudo, "corpo gravado", "e o conteudo gravado");
  eq(esp.detalhe, "pergunta enviada", "e o detalhe da trilha");
  eq(saidaDaMensagem("x", null).assinar, true, "especial nulo cai no caminho normal");
}

// ════ 12) A PERGUNTA SUJA O `status` — desfecho, com o executor injetado ═════
//
// `CAMPOS_SUJOS_POR_ACAO` diz quais fatos a acao INVALIDA. A pergunta sai pela
// mesma porta de envio do texto, entao ela move a conversa pra "em atendimento" —
// e uma condicao logo depois tem que decidir pelo valor NOVO. Com a lista vazia,
// a condicao decide em dado velho e o macro para sozinho, com ok:true e sem
// ninguem saber por que (o defeito-mae que a prova de condicao ja documenta).
{
  eq([...(CAMPOS_SUJOS_POR_ACAO.perguntar_opcoes ?? [])], ["status"],
    "perguntar_opcoes suja `status` — ela sai pela mesma porta do envio de texto");

  // A CONDICAO VEM ANTES E DEPOIS, e isso e o que faz a prova MORDER. So depois
  // nao distingue nada: a 1a leitura ja aconteceria com o valor novo e a condicao
  // acertaria mesmo com a lista de sujos vazia. Com uma condicao ANTES existe dado
  // VELHO em cache — e ai a lista de sujos e a unica coisa que faz a 2a decidir
  // certo.
  const nos: No[] = [
    {
      id: "n1", tipo: "condicao", proximo: "n2",
      condicao: { tipo: "comparacao", campo: "status", operador: "igual", valor: "aberto" },
    } as any,
    {
      id: "n2", tipo: "acao", proximo: "n3",
      acao: {
        tipo: "perguntar_opcoes",
        params: { tipo: "botoes", texto: "Qual dia?", opcoes: [{ titulo: "seg" }, { titulo: "ter" }] },
      },
    } as any,
    {
      id: "n3", tipo: "condicao", proximo: "n4",
      condicao: { tipo: "comparacao", campo: "status", operador: "igual", valor: "atendimento" },
    } as any,
    { id: "n4", tipo: "acao", acao: { tipo: "nota_interna", texto: "chegou no fim" } } as any,
  ];
  const r = validarFluxo({ id: "m1", nome: "M", tipo: "macro", versao: 1, nos });
  ok(r.ok, `o macro da secao 12 e valido — ${r.ok ? "" : (r as any).erros.join(" | ")}`);

  // O banco de mentira: a conversa comeca "aberto" e a PERGUNTA a move pra
  // "atendimento", que e o que o envio real faz.
  const banco = { status: "aberto" };
  const lidos: CampoCondicao[][] = [];
  const executados: string[] = [];
  const deps = {
    coletar: async (campos: CampoCondicao[]) => {
      lidos.push([...campos]);
      const fatos: any = {};
      for (const c of campos) if (c === "status") fatos.status = banco.status;
      return { fatos, indisponiveis: {} } as any;
    },
    executar: async (no: No) => {
      executados.push(no.id);
      if (no.acao?.tipo === "perguntar_opcoes") banco.status = "atendimento";
      return { detalhe: "ok" } as any;
    },
  };
  const saiu = await percorrerMacro((r as any).fluxo, deps);
  ok(saiu.ok, "o macro roda inteiro");
  eq(executados, ["n2", "n4"],
    "e CHEGA no passo depois da 2a condicao — ela releu `status` porque a pergunta o sujou");
  eq(lidos.filter((c) => c.includes("status")).length, 2,
    "`status` foi lido DUAS vezes: uma antes da pergunta e outra depois (nao decidiu em dado velho)");
}

// ════ 13) O CAMINHO HUMANO pra criar o passo (app/fluxos/page.tsx) ═══════════
//
// O criterio do card 86ak86jvw e capacidade de PRODUTO. Sem entrada no editor, o
// passo existia no motor e no formato e so um POST na mao criava um — o que nao e
// "o cliente consegue fazer".
{
  const ed = semComentario(ler("app/fluxos/page.tsx"));
  ok(/\{ tipo: "perguntar_opcoes", rotulo: "Perguntar com opcoes" \}/.test(ed),
    "a acao aparece na lista de acoes editaveis");
  ok(/if \(tipo === "perguntar_opcoes"\) \{/.test(ed), "e tem formulario proprio");
  // O PAYLOAD MORA EM `params`: o `set` das outras acoes espalha no TOPO da acao
  // e criaria `acao.texto` solto, que `validarAcao` ignora em silencio — o passo
  // seria salvo sem pergunta nenhuma.
  ok(/onMudar\(\{ \.\.\.acao, params: \{ \.\.\.p, \.\.\.campos \} \}\)/.test(ed),
    "que escreve dentro de `params`, nao no topo da acao");
  // AVISO AO VIVO, nao trava: o schema aceita mais do que a plataforma, e quem
  // recusa e o preflight. Sem isto, o fluxo era salvo e so falhava na frente do
  // cliente.
  ok(/const veredito = validarInterativa\(/.test(ed), "o editor consulta a regra da PLATAFORMA ao vivo");
  ok(/\{!veredito\.ok && \(/.test(ed), "e o aviso aparece QUANDO o veredito reprova (nao e enfeite desligado)");
  ok(/\{veredito\.erros\.join\("; "\)\}/.test(ed), "e mostra o que esta fora do teto enquanto se digita");
  ok(/opcoes: e\.target\.value\.split\("\\n"\)/.test(ed), "uma opcao por linha (colar do bloco de notas funciona)");
}

// ═══════ O SIMULADOR NAO PROMETE UM DESENHO QUE ELE NAO PODE SABER
//
// Quem decide se a pergunta sai como botao, lista nativa ou texto numerado e
// `planoDaPergunta`, e ela depende da FONTE do canal — que o simulador nao
// conhece (ele roda sobre fatos, sem banco e sem env). Dizer 'sairiam botoes' na
// previa e prometer o que o canal pode nao entregar: o gestor testa, le 'botoes',
// publica, e no WhatsApp sai texto numerado.
//
// A mutacao que trocava a frase pela promessa de botoes sobrevivia a bateria
// inteira. Agora o DESFECHO e cobrado, e nao a prosa do comentario.
{
  const fluxo = {
    versao: 1 as const,
    tipo: "macro" as const,
    nos: [
      {
        id: "n1",
        tipo: "acao" as const,
        acao: {
          tipo: "perguntar_opcoes" as const,
          params: { texto: "Qual assunto?", opcoes: ["Suporte", "Financeiro"], tipo: "botoes" as const },
        },
      },
    ],
  } as any;
  const sim = simularFluxo({ fluxo, slug: "s", nome: "n", ativo: true } as any, {} as any);
  const texto = JSON.stringify(sim);
  ok(
    /perguntaria/.test(texto),
    "a previa nomeia a acao de perguntar"
  );
  ok(
    !/sairiam bot|sairiam lista|viraria bot/i.test(texto),
    "e NAO promete o desenho (quem decide botao x lista x texto e a fonte do canal, que o simulador nao ve)"
  );
  ok(
    /pedido: botoes/.test(texto),
    "o que aparece e o tipo PEDIDO, rotulado como pedido"
  );
  // E O SIMULADOR CONTINUA SEM CONHECER CANAL — mas quem trava isso NAO e esta
  // prova. A guarda que morava aqui testava
  // `!/from "@/lib/(canais|mensageria|interativas)/` e era CERIMONIA (achado da
  // revisao 2): `lib/fluxo/` nao usa o alias `@/`. O proprio `pergunta.ts`
  // importa `"../interativas.ts"`, e a mutacao de colar
  // `import { planoDeEnvio } from "../interativas.ts"` no simulador passava
  // VERDE por ela. Guarda que nao pega nada e pior que guarda ausente, porque
  // promete cobertura que nao existe.
  //
  // Quem realmente mata essa mutacao e `scripts/prova-motor-fila.ts` (secao 10,
  // GUARDA DE ARQUITETURA): `assert.deepEqual(importsDe(simulador.ts),
  // ["./schema.ts"])` — lista FECHADA de imports, alias nenhum escapa — mais a
  // varredura de `mensageria`, `executar`, `zapi`, `gupshup` e `fetch(` no
  // texto. Nao se copia a guarda pra ca: duas regras pro mesmo fato e a classe
  // de defeito que esta onda inteira vem pagando (ver a delegacao do
  // `podeEnviarTemplate` na secao 7).
}
// ═══════ O FORMATO CANONICO E DOCUMENTADO: TODA ACAO DA V1 APARECE NO DOC
//
// `docs/fluxo-canonico.md` e o contrato que o conversor do ChatGuru, o editor e o
// motor seguem. Acao que existe no schema e nao esta no doc e acao que ninguem
// sabe usar — e, pior, que a proxima frente reimplementa por nao achar. A mutacao
// que tirava a acao do doc sobrevivia a bateria inteira: o doc nao tinha guarda
// nenhuma. Agora tem, e ela vale pra TODA acao, nao so pra esta frente.
{
  // O doc e o CONTRATO do modulo de automacao e mora no repo interno: a versao
  // publica nao o carrega (ele cita medicao de uma conta real de cliente no
  // benchmark). Sem o arquivo a guarda nao TEM o que ler; ela avisa alto e nao
  // roda, em vez de derrubar a bateria inteira com ENOENT (era o que acontecia
  // no repo publico desde a v1.0.0: esta prova morria antes das secoes seguintes).
  const caminhoDoc = new URL("../docs/fluxo-canonico.md", import.meta.url);
  const doc = existsSync(caminhoDoc) ? readFileSync(caminhoDoc, "utf8") : null;
  // ANCORA ESTRUTURAL, NAO SUBSTRING (correcao da revisao 2). `doc.includes(a)`
  // media "a string existe no arquivo" e nada mais, e duas mutacoes sobreviviam
  // inteiras: (1) APAGAR A LINHA DA TABELA que documenta `espera` — a palavra
  // aparece 15x em prosa portuguesa neste doc ("espera longa", "a espera",
  // "esperar"), entao a guarda era cega justamente pro nome mais parecido com
  // palavra comum; (2) REDUZIR O DOC A CINCO LINHAS com um bloco de codigo
  // listando os 10 nomes soltos — zero documentacao, guarda satisfeita.
  //
  // A ancora agora e a LINHA DA TABELA DE ACOES (a linha que comeca com o nome
  // da acao entre crases numa celula), que so existe se a acao estiver
  // documentada onde o leitor procura. E ALGUMA celula depois do nome tem que
  // dizer alguma coisa: linha esvaziada nao e documento.
  //
  // POR QUE "ALGUMA", E NAO "A ULTIMA" (correcao da re-revisao): cobrar a ULTIMA
  // celula travava o formato da tabela em vez da propriedade. Medido: acrescentar
  // uma coluna curta e legitima (`| na fila? | sim |`) fazia as 10 acoes
  // reprovarem, com a mensagem MENTINDO ("falta LINHA PROPRIA" com a linha ali).
  // Guarda que reprova documentacao correta e afrouxada pelo primeiro que
  // tropeca nela — e ai nao guarda mais nada. A propriedade que importa e "a
  // linha explica a acao em algum lugar", nao "a tabela tem exatamente N colunas".
  const linhaDaAcao = (a: string) =>
    doc
      ?.split("\n")
      .find((l) => new RegExp("^\\|\\s*`" + a + "`\\s*\\|").test(l)) ?? null;
  const semLinha: string[] = [];
  const linhaVazia: string[] = [];
  for (const a of ACOES_V1) {
    const linha = linhaDaAcao(a);
    if (!linha) {
      semLinha.push(a);
      continue;
    }
    const celulas = linha.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
    // celulas[0] e o proprio nome da acao; a explicacao mora em qualquer uma das outras
    if (celulas.length < 2 || !celulas.slice(1).some((c) => c.length >= 10)) linhaVazia.push(a);
  }
  if (doc === null) {
    console.warn("prova-costuras-y: AVISO - docs/fluxo-canonico.md ausente (repo publico); a guarda de documentacao das acoes da v1 NAO rodou.");
  } else {
  ok(
    semLinha.length === 0 && linhaVazia.length === 0,
    `toda acao da v1 tem LINHA PROPRIA e EXPLICADA na tabela de docs/fluxo-canonico.md` +
      ` (sem linha: ${semLinha.join(", ") || "nenhuma"}; linha sem explicacao: ${linhaVazia.join(", ") || "nenhuma"})`
  );
  ok(ACOES_V1.length > 5, `e a lista de acoes foi de fato lida (${ACOES_V1.length} acoes)`);
  }
}
// ═══════ AS DUAS SAIDAS DO PAINEL DE MEMORIA (BAIXAS 6 e 7 da revisao 1)
//
// Sao pequenas e e por isso que precisam de guarda: some no primeiro refactor da
// tela e ninguem nota ate um atendente apagar sem querer a variavel que a
// automacao usa, ou ficar preso num aviso de rede sem jeito de tentar de novo.
{
  const home = readFileSync(new URL("../app/home.tsx", import.meta.url), "utf8");
  const iMem = home.indexOf('abaFicha === "memoria"');
  ok(iMem > 0, "achei o painel de memoria na tela");
  const painel = home.slice(iMem, iMem + 6000);
  // BAIXA 6 — apagar variavel e DOIS passos: o clique arma, o segundo confirma.
  ok(
    /setMemApagar\(/.test(painel),
    "apagar variavel da memoria passa por um estado de confirmacao (nao apaga no primeiro clique)"
  );
  ok(
    /setMemApagar\(null\); salvarMemoria\(par\.chave, "", true\)/.test(painel),
    "e so o passo CONFIRMADO chama o salvar com valor vazio"
  );
  // BAIXA 7 — aviso de leitura falha tem saida: rede que cai volta.
  ok(
    /memoria\.aviso \?/.test(painel),
    "leitura que falhou vira AVISO, nunca \"esta conversa nao tem memoria\""
  );
  ok(
    /Tentar de novo/.test(painel) && /carregarMemoria\(/.test(painel),
    "e o aviso traz o botao que recarrega (sem ele, o unico jeito era trocar de conversa e voltar)"
  );
}
console.log(`prova-costuras-y: OK (${n} checagens)`);
