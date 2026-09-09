// Prova das MENSAGENS INTERATIVAS (Frente S, card 86ak86jvw): botoes de
// resposta rapida, lista de opcoes, o plano por provedor e o recebimento da
// resposta.
// Roda em Node >= 22.6 sem build: `node scripts/prova-interativas.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// Nada de rede aqui: os ENVELOPES sao montados por funcao pura em
// lib/interativas.ts justamente pra terem prova. As guardas estruturais da
// secao 6 leem os arquivos de provedor e da rota — sem elas, uma mutacao no
// `fetch` passaria com a bateria verde (licao da fase 3 da Frente P).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LIMITE_DESCRICAO_ITEM,
  LIMITE_TEXTO_INTERATIVA,
  LIMITE_TEXTO_SAIDA,
  LIMITE_TITULO_BOTAO,
  LIMITE_TITULO_ITEM,
  MAX_BOTOES,
  MAX_ITENS_LISTA,
  TIPOS_INTERATIVA,
  ehTipoInterativa,
  envelopeGupshup,
  envelopeZapiLista,
  limiteTituloMensagem,
  limiteTituloOpcao,
  maxOpcoes,
  planoDeEnvio,
  previaDoEnviado,
  respostaZapi,
  resumoDoEnviado,
  textoNumerado,
  tipoDeMensagem,
  validarInterativa,
  type Interativa,
} from "../lib/interativas.ts";
import { parseEvento } from "../lib/gupshup-inbound.ts";

let n = 0;
function ok(cond: unknown, msg: string) {
  assert.equal(!!cond, true, msg);
  n += 1;
}
function eq(a: unknown, b: unknown, msg: string) {
  assert.deepEqual(a, b, msg);
  n += 1;
}
/** valida e devolve a msg; explode se o caso deveria ser valido */
function bom(bruto: unknown, msg: string): Interativa {
  const v = validarInterativa(bruto);
  assert.equal(v.ok, true, `${msg} — erros: ${v.ok ? "" : v.erros.join("; ")}`);
  n += 1;
  return (v as { ok: true; msg: Interativa }).msg;
}
/** valida e devolve os erros; explode se o caso deveria ser recusado */
function ruim(bruto: unknown, msg: string): string[] {
  const v = validarInterativa(bruto);
  assert.equal(v.ok, false, msg);
  n += 1;
  return (v as { ok: false; erros: string[] }).erros;
}

const BOTOES = { tipo: "botoes", texto: "Qual horario prefere?", opcoes: ["Manha", "Tarde"] };
const LISTA = {
  tipo: "lista",
  titulo: "Agenda",
  texto: "Escolha o dia",
  rodape: "Ate 18h",
  botao_lista: "Ver dias",
  opcoes: [
    { titulo: "Segunda", descricao: "manha livre" },
    { titulo: "Terca" },
    { titulo: "Quarta" },
  ],
};

// ============================================ 1) VALIDACAO NA ENTRADA

// 1.1 os dois formatos basicos passam, e a opcao pode vir como string simples
{
  const b = bom(BOTOES, "botoes com 2 opcoes e valido");
  eq(b.opcoes, [{ titulo: "Manha" }, { titulo: "Tarde" }], "string vira {titulo}");
  eq(b.tipo, "botoes", "o tipo sobrevive");
  const l = bom(LISTA, "lista com 3 opcoes e valida");
  eq(l.botao_lista, "Ver dias", "o rotulo do botao da lista sobrevive");
  eq(l.opcoes[0].descricao, "manha livre", "a descricao da opcao sobrevive");
}

// 1.2 a LISTA tem descricao por opcao; o BOTAO nao tem onde mostrar, e ela e
//     descartada em vez de virar erro (o formulario e o mesmo pros dois)
{
  const b = bom({ ...BOTOES, opcoes: [{ titulo: "A", descricao: "x" }, { titulo: "B" }] }, "botao com descricao passa");
  eq(b.opcoes[0], { titulo: "A" }, "a descricao nao vai pro botao");
}

// 1.3 lista SEM rotulo de botao ganha default. Lista sem botao nao abre no
//     celular do cliente — mandar vazio deixaria a mensagem inutil.
{
  const l = bom({ ...LISTA, botao_lista: "" }, "lista sem rotulo de botao passa");
  eq(l.botao_lista, "Ver opcoes", "com default");
  const b = bom({ ...BOTOES, botao_lista: "ignorado" }, "botoes aceitam o campo");
  eq(b.botao_lista, undefined, "mas nao guardam rotulo de lista");
}

// 1.4 menos de 2 opcoes nao e pergunta com opcoes
{
  ok(ruim({ ...BOTOES, opcoes: ["so uma"] }, "1 opcao e recusada").some((e) => /pelo menos 2/.test(e)),
    "e o motivo diz quantas faltam");
  ruim({ ...BOTOES, opcoes: [] }, "zero opcao e recusada");
  ruim({ ...BOTOES, opcoes: "Manha" }, "opcoes que nao e lista e recusada");
}

// 1.5 OS TETOS DO WHATSAPP: 3 botoes, 10 itens de lista. Medidos na doc da
//     Gupshup em 31/08/2026 ("Up to 3 options are supported" / ate 10 itens).
{
  eq(MAX_BOTOES, 3, "3 botoes");
  eq(MAX_ITENS_LISTA, 10, "10 itens de lista");
  eq(maxOpcoes("botoes"), 3, "maxOpcoes concorda");
  eq(maxOpcoes("lista"), 10, "idem pra lista");
  bom({ ...BOTOES, opcoes: ["a", "b", "c"] }, "3 botoes passam");
  const e4 = ruim({ ...BOTOES, opcoes: ["a", "b", "c", "d"] }, "4 botoes sao recusados");
  ok(e4.some((x) => /use lista/.test(x)), "e a mensagem manda usar LISTA (conserto na mao do usuario)");
  bom({ ...LISTA, opcoes: Array.from({ length: 10 }, (_, i) => ({ titulo: `op${i}` })) }, "10 itens passam");
  ruim({ ...LISTA, opcoes: Array.from({ length: 11 }, (_, i) => ({ titulo: `op${i}` })) }, "11 itens sao recusados");
}

// 1.6 CORTE SILENCIOSO NAO EXISTE: campo grande demais e RECUSADO com o motivo.
//     O WhatsApp corta o excedente sem avisar, e opcao com titulo cortado ao
//     meio faz o cliente escolher outra coisa.
{
  eq(limiteTituloOpcao("botoes"), LIMITE_TITULO_BOTAO, "botao: 20");
  eq(limiteTituloOpcao("lista"), LIMITE_TITULO_ITEM, "lista: 24");
  const gigante = "x".repeat(LIMITE_TITULO_BOTAO + 1);
  ruim({ ...BOTOES, opcoes: [gigante, "ok"] }, "titulo de botao de 21 chars e recusado");
  bom({ ...BOTOES, opcoes: ["x".repeat(LIMITE_TITULO_BOTAO), "ok"] }, "20 chars passa");
  // 21 chars em LISTA passa (o teto la e 24) — os dois tetos sao diferentes de
  // verdade, nao um numero copiado
  bom({ ...LISTA, opcoes: [{ titulo: gigante }, { titulo: "ok" }] }, "21 chars passa na lista");
  ruim({ ...LISTA, opcoes: [{ titulo: "x".repeat(LIMITE_TITULO_ITEM + 1) }, { titulo: "ok" }] },
    "25 chars e recusado na lista");
  ruim({ ...LISTA, opcoes: [{ titulo: "a", descricao: "d".repeat(LIMITE_DESCRICAO_ITEM + 1) }, { titulo: "b" }] },
    "descricao de 73 chars e recusada");
  ruim({ ...BOTOES, texto: "t".repeat(LIMITE_TEXTO_INTERATIVA + 1) }, "pergunta de 1025 chars e recusada");
  ruim({ ...LISTA, titulo: "t".repeat(61) }, "titulo de 61 chars e recusado");
  ruim({ ...LISTA, rodape: "r".repeat(61) }, "rodape de 61 chars e recusado");
  ruim({ ...LISTA, botao_lista: "b".repeat(21) }, "rotulo de botao de 21 chars e recusado");
}

// 1.7 pergunta VAZIA e recusada (a mensagem seria so um menu sem contexto)
{
  ruim({ ...BOTOES, texto: "" }, "texto vazio e recusado");
  ruim({ ...BOTOES, texto: "   " }, "texto so com espacos e recusado");
}

// 1.8 OPCAO REPETIDA E RECUSADA, e este e o caso que morde de verdade: a
//     resposta do cliente chega pelo TITULO (`selectedRowTitle` na Z-API,
//     `button_reply.title` na Meta). Com dois titulos iguais nao ha como saber
//     qual ele apertou, e o fluxo ramificaria errado.
{
  const e = ruim({ ...BOTOES, opcoes: ["Manha", "manha"] }, "opcao repetida (ignorando caixa) e recusada");
  ok(e.some((x) => /ambigua/.test(x)), "e o motivo explica por que");
  bom({ ...BOTOES, opcoes: ["Manha", "Manha cedo"] }, "titulo parecido mas diferente passa");
}

// 1.9 linha em BRANCO do formulario nao e erro, e ausencia
{
  const b = bom({ ...BOTOES, opcoes: ["A", "", "  ", "B"] }, "linhas vazias sao ignoradas");
  eq(b.opcoes.length, 2, "sobram as duas de verdade");
}

// 1.10 tipo invalido / corpo torto param na porta
{
  ruim(null, "null e recusado");
  ruim("texto", "string e recusada");
  ruim([], "array e recusado");
  ruim({ texto: "x", opcoes: ["a", "b"] }, "sem tipo e recusado");
  ruim({ tipo: "carrossel", texto: "x", opcoes: ["a", "b"] }, "tipo desconhecido e recusado");
  for (const t of TIPOS_INTERATIVA) eq(ehTipoInterativa(t), true, `tipo valido: ${t}`);
  for (const t of [null, 1, "BOTOES", ""]) eq(ehTipoInterativa(t), false, `tipo invalido: ${String(t)}`);
}

// ==================================== 2) O PLANO POR PROVEDOR (o coracao)

// 2.1 API oficial (gupshup): os DOIS formatos nativos. Medido na doc:
//     `type:"quick_reply"` e `type:"list"`.
{
  eq(planoDeEnvio("gupshup", "botoes"), { modo: "nativo", motivo: null }, "botoes nativos na API oficial");
  eq(planoDeEnvio("gupshup", "lista"), { modo: "nativo", motivo: null }, "lista nativa na API oficial");
  eq(planoDeEnvio("gupshup", "lista", { grupo: true }).modo, "nativo", "grupo nao muda a API oficial");
}

// 2.2 Z-API: LISTA nativa em 1:1. `send-option-list` e documentada sem ressalva
//     de instabilidade — dizer que a Z-API "nao suporta lista" seria inverter um
//     fato, e o fallback tem que ser reservado pro que de fato nao passa.
{
  eq(planoDeEnvio("zapi", "lista"), { modo: "nativo", motivo: null }, "lista nativa no Z-API 1:1");
}

// 2.3 Z-API + BOTOES = TEXTO NUMERADO, e o motivo cita a instabilidade que a
//     PROPRIA doc da Z-API declara. Mandar por um caminho que o fornecedor chama
//     de instavel produz o pior desfecho: a mensagem sai, o cliente nao ve botao,
//     e o atendente espera resposta que nunca vem.
{
  const p = planoDeEnvio("zapi", "botoes");
  eq(p.modo, "texto_numerado", "botao no Z-API nao sai como botao");
  ok(p.motivo && /instav|instab/i.test(p.motivo), "e o motivo cita a instabilidade declarada");
  ok(p.motivo && /API oficial/i.test(p.motivo), "e aponta o caminho que funciona");
}

// 2.4 Z-API + LISTA + GRUPO = texto numerado. A doc da Z-API diz que a lista de
//     opcoes "nao funciona mais em grupos".
{
  const p = planoDeEnvio("zapi", "lista", { grupo: true });
  eq(p.modo, "texto_numerado", "lista em grupo cai no fallback");
  ok(p.motivo && /GRUPO|grupo/.test(p.motivo), "com o motivo escrito");
}

// 2.5 fonte sem interativa cabeada: fallback com motivo que diz o que FALTA —
//     nunca "o provedor nao suporta", que seria afirmar coisa nao medida
{
  for (const fonte of ["evolution", "instagram-agent", "whatsapp-agent", "fonte-nova-qualquer"]) {
    const p = planoDeEnvio(fonte, "lista");
    eq(p.modo, "texto_numerado", `${fonte} cai no fallback`);
    ok(p.motivo && /cabead/.test(p.motivo), `${fonte}: o motivo diz que falta cabeamento, nao que o provedor recusa`);
  }
}

// 2.6 TODO fallback tem motivo; todo nativo NAO tem. Sem essa invariante, um
//     fallback silencioso faria a tela dizer "enviei botoes" pra um cliente que
//     recebeu texto.
{
  for (const fonte of ["gupshup", "zapi", "evolution", "xpto"]) {
    for (const tipo of TIPOS_INTERATIVA) {
      for (const grupo of [false, true]) {
        const p = planoDeEnvio(fonte, tipo, { grupo });
        if (p.modo === "nativo") eq(p.motivo, null, `nativo nao carrega motivo (${fonte}/${tipo})`);
        else ok(p.motivo && p.motivo.length > 20, `fallback sempre explica (${fonte}/${tipo}/grupo=${grupo})`);
      }
    }
  }
}

// ================================= 3) AS RENDERIZACOES (texto e registro)

// 3.1 texto numerado: titulo em negrito, corpo, opcoes numeradas, rodape e a
//     instrucao de como responder
{
  const t = textoNumerado(bom(LISTA, "lista valida"));
  ok(/\*Agenda\*/.test(t), "titulo em negrito");
  ok(/Escolha o dia/.test(t), "o corpo aparece");
  ok(/1\. Segunda/.test(t) && /2\. Terca/.test(t) && /3\. Quarta/.test(t), "as opcoes sao numeradas em ordem");
  ok(/manha livre/.test(t), "a descricao da opcao desce junto");
  ok(/Ate 18h/.test(t), "o rodape aparece");
  ok(/Responda com o numero da opcao \(1 a 3\)/.test(t), "e a instrucao diz o intervalo real");
}

// 3.2 com 2 opcoes a instrucao e mais natural ("1 ou 2")
{
  ok(/Responda com 1 ou 2\./.test(textoNumerado(bom(BOTOES, "botoes"))), "duas opcoes: 1 ou 2");
}

// 3.3 `instrucao: false` tira a linha de "responda com o numero" — e o que vai
//     no REGISTRO do modo nativo, onde o cliente apertou um botao. Dizer que ele
//     deveria digitar um numero descreveria um atendimento que nao aconteceu.
{
  const t = textoNumerado(bom(BOTOES, "botoes"), { instrucao: false });
  ok(!/Responda com/.test(t), "sem a instrucao");
  ok(/1\. Manha/.test(t), "mas com as opcoes");
}

// 3.4 O REGISTRO leva as OPCOES mesmo no modo nativo. Requisito de operacao: a
//     bolha do painel nao desenha botao, e sem as opcoes o atendente leria a
//     resposta do cliente sem saber o que foi oferecido.
{
  const b = bom(BOTOES, "botoes");
  const nativo = resumoDoEnviado(b, "nativo");
  ok(/\[botoes de resposta rapida\]/.test(nativo), "o selo diz que saiu como botao");
  ok(/1\. Manha/.test(nativo), "e as opcoes ficam gravadas");
  ok(!/Responda com/.test(nativo), "sem instrucao de digitar numero (o cliente tocou)");
  const fallback = resumoDoEnviado(b, "texto_numerado");
  ok(!/\[botoes/.test(fallback), "no fallback nao ha selo de botao");
  ok(/Responda com 1 ou 2/.test(fallback), "e o registro e IGUAL ao que o cliente recebeu");
  const l = resumoDoEnviado(bom(LISTA, "lista"), "nativo");
  ok(/\[lista de opcoes\]/.test(l), "a lista tem selo proprio");
}

// 3.5 O TIPO da linha em `mensagens`: vocabulario IGUAL ao do importador
//     (`interactive_quick_reply` / `interactive_list`, os tipos que o acervo ja
//     tem). Nome novo faria a mesma coisa ter dois nomes no banco e qualquer
//     contagem por tipo passaria a mentir.
{
  eq(tipoDeMensagem(bom(BOTOES, "b"), "nativo"), "interactive_quick_reply", "botao nativo");
  eq(tipoDeMensagem(bom(LISTA, "l"), "nativo"), "interactive_list", "lista nativa");
  // no fallback o tipo e `text`: foi literalmente um texto que saiu. Gravar
  // "interactive" afirmaria um recurso que o cliente nunca viu.
  eq(tipoDeMensagem(bom(BOTOES, "b"), "texto_numerado"), "text", "fallback e text");
  eq(tipoDeMensagem(bom(LISTA, "l"), "texto_numerado"), "text", "idem pra lista");
  // e o vocabulario e o MESMO que o importador reconhece
  const importador = readFileSync("scripts/importar/chatguru.mjs", "utf8");
  ok(/interactive_quick_reply/.test(importador), "o importador conhece interactive_quick_reply");
  ok(/interactive_list/.test(importador), "e interactive_list");
}

// 3.6 a previa da lista de conversas cabe na coluna e diz o formato
{
  const p = previaDoEnviado(bom(BOTOES, "b"));
  ok(/^\[botoes\]/.test(p), "a previa marca o formato");
  ok(p.length <= 140, "e cabe no teto da coluna");
  ok(previaDoEnviado(bom({ ...LISTA, texto: "x".repeat(1000) }, "lista longa")).length <= 140, "texto longo e cortado");
}

// 3.7 o texto numerado NUNCA passa do teto de /api/send, nem no pior caso
//     permitido pelos tetos de entrada
{
  const pior = bom(
    {
      tipo: "lista",
      // 24 e o teto do titulo NA LISTA (limiteTituloMensagem) — era 60 aqui, e o
      // 60 nunca foi valido de verdade: o envelope cortava em 24 caladamente.
      titulo: "t".repeat(LIMITE_TITULO_ITEM),
      texto: "c".repeat(LIMITE_TEXTO_INTERATIVA),
      rodape: "r".repeat(60),
      opcoes: Array.from({ length: 10 }, (_, i) => ({
        titulo: `${i}`.padEnd(LIMITE_TITULO_ITEM, "o"),
        descricao: "d".repeat(LIMITE_DESCRICAO_ITEM),
      })),
    },
    "o maior caso valido possivel"
  );
  ok(textoNumerado(pior).length <= LIMITE_TEXTO_SAIDA, "o pior caso valido cabe no teto de envio");
}

// ==================================== 4) ENVELOPES (o que vai pro provedor)

// 4.1 Gupshup quick_reply
{
  const e = envelopeGupshup(bom(BOTOES, "b")) as any;
  eq(e.type, "quick_reply", "o tipo da Gupshup");
  eq(e.content.type, "text", "conteudo de texto");
  eq(e.content.text, "Qual horario prefere?", "a pergunta vai no content.text");
  eq(e.options.length, 2, "duas opcoes");
  // `postbackText` = o titulo: e o que volta no inbound. Igualar os dois faz a
  // resposta do botao ser indistinguivel de alguem digitando a opcao — que e
  // exatamente o "roteado como mensagem normal" do card.
  eq(e.options[0], { type: "text", title: "Manha", postbackText: "Manha" }, "postbackText = titulo");
}

// 4.2 Gupshup list
{
  const e = envelopeGupshup(bom(LISTA, "l")) as any;
  eq(e.type, "list", "o tipo da Gupshup");
  eq(e.title, "Agenda", "titulo");
  eq(e.body, "Escolha o dia", "corpo");
  eq(e.footer, "Ate 18h", "rodape");
  eq(e.globalButtons, [{ type: "text", title: "Ver dias" }], "o botao que abre a lista");
  eq(e.items.length, 1, "UMA secao (o formato canonico daqui nao tem grupo de opcoes)");
  eq(e.items[0].options.length, 3, "com as tres opcoes dentro");
  eq(e.items[0].options[0].description, "manha livre", "a descricao vai pro campo certo");
  ok(!("description" in e.items[0].options[1]), "opcao sem descricao nao manda o campo vazio");
}

// 4.3 campo ausente nao viaja como vazio (envelope enxuto e o que o provedor
//     valida melhor)
{
  const e = envelopeGupshup(bom({ tipo: "botoes", texto: "q", opcoes: ["a", "b"] }, "sem titulo/rodape")) as any;
  ok(!("header" in e.content), "sem titulo, sem header");
  ok(!("caption" in e.content), "sem rodape, sem caption");
}

// 4.4 Z-API option list
{
  const e = envelopeZapiLista(bom(LISTA, "l")) as any;
  ok(/Escolha o dia/.test(e.message), "a pergunta vai em `message`");
  // o envelope da Z-API nao tem rodape: em vez de descartar em silencio, ele
  // desce colado no corpo — texto que o cliente le e melhor que texto que evapora
  ok(/Ate 18h/.test(e.message), "e o rodape desce junto em vez de evaporar");
  eq(e.optionList.title, "Agenda", "titulo dentro de optionList");
  eq(e.optionList.buttonLabel, "Ver dias", "o rotulo do botao");
  eq(e.optionList.options.map((o: any) => o.id), ["1", "2", "3"], "id estavel e legivel por posicao");
  eq(e.optionList.options[0].title, "Segunda", "titulo da opcao");
  eq(e.optionList.options[0].description, "manha livre", "descricao da opcao");
}

// 4.5 lista sem titulo ganha rotulo generico em vez de campo vazio (o provedor
//     exige o campo)
{
  const e = envelopeZapiLista(bom({ tipo: "lista", texto: "q", opcoes: ["a", "b"] }, "lista minima")) as any;
  eq(e.optionList.title, "Opcoes", "titulo generico");
  eq(e.optionList.buttonLabel, "Ver opcoes", "rotulo de botao default");
}

// ============================ 5) O RECEBIMENTO (resposta como mensagem normal)

// 5.1 Z-API listResponseMessage — chaves da doc oficial ("Exemplos de retorno")
{
  const r = respostaZapi({
    listResponseMessage: { message: "Segunda", title: "Agenda", selectedRowId: "1", selectedRowTitle: "Segunda" },
  });
  eq(r, { texto: "Segunda", id: "1" }, "o titulo escolhido e o texto da mensagem");
}

// 5.2 o TITULO vence a `message` (a `message` da Z-API as vezes traz o texto da
//     pergunta, nao a escolha)
{
  const r = respostaZapi({
    listResponseMessage: { message: "Escolha o dia", selectedRowTitle: "Terca", selectedRowId: "2" },
  });
  eq(r!.texto, "Terca", "o selectedRowTitle manda");
}

// 5.3 Z-API buttonsResponseMessage — lido MESMO com o painel nao enviando botao
//     por esse canal: o numero recebe botao de bot de terceiro (SuperSDR/ChatGuru
//     ativos no mesmo WhatsApp, ver CLAUDE.md) e a escolha caia como "[mensagem]"
{
  eq(respostaZapi({ buttonsResponseMessage: { buttonId: "b1", message: "Sim" } }), { texto: "Sim", id: "b1" },
    "resposta de botao vira texto");
}

// 5.4 payload sem resposta interativa devolve null (nao pode "achar" escolha
//     onde nao houve)
{
  eq(respostaZapi({ text: { message: "oi" } }), null, "texto normal nao e escolha");
  eq(respostaZapi({}), null, "payload vazio");
  eq(respostaZapi(null), null, "payload nulo");
  eq(respostaZapi({ listResponseMessage: {} }), null, "lista sem titulo nem message: nada");
  eq(respostaZapi({ buttonsResponseMessage: { buttonId: "b1" } }), null, "botao sem texto: nada");
  eq(respostaZapi({ listResponseMessage: { selectedRowTitle: "   " } }), null, "titulo em branco nao vira escolha");
}

// 5.5 API oficial, formato Meta cloud: JA funcionava (o ramo estava certo desde a
//     Frente F). A prova trava isso pra nao regredir.
{
  const evs = parseEvento({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: "Cliente" }, wa_id: "5511999999999" }],
              messages: [
                { from: "5511999999999", id: "wamid.1", type: "interactive",
                  interactive: { list_reply: { id: "1", title: "Segunda" } }, timestamp: "1756600000" },
                { from: "5511999999999", id: "wamid.2", type: "interactive",
                  interactive: { button_reply: { id: "b1", title: "Sim" } }, timestamp: "1756600001" },
              ],
            },
          },
        ],
      },
    ],
  });
  eq(evs.length, 2, "os dois eventos entram");
  eq(evs[0].texto, "Segunda", "list_reply vira o titulo");
  eq(evs[0].tipo, "text", "e roteia como TEXTO (mensagem normal)");
  eq(evs[1].texto, "Sim", "button_reply vira o titulo");
  eq(evs[1].tipo, "text", "tambem como texto");
}

// 5.6 formato Gupshup v1: a escolha aparece em vez de "[button_reply]".
//     HONESTIDADE: a forma exata do inbound interativo do v1 nao deu pra
//     confirmar na doc oficial em 31/08/2026 (paginas 404), entao a leitura e
//     tolerante — e sem campo legivel ela MANTEM o rotulo, nunca fabrica texto.
{
  const comTitulo = parseEvento({
    type: "message",
    payload: { id: "g1", type: "button_reply", sender: { phone: "5511988887777", name: "C" },
      payload: { id: "1", title: "Manha" } },
  });
  eq(comTitulo[0].texto, "Manha", "com titulo, a escolha aparece");
  eq(comTitulo[0].tipo, "text", "e roteia como texto");

  const comPostback = parseEvento({
    type: "message",
    payload: { id: "g2", type: "list_reply", sender: { phone: "5511988887777" },
      payload: { postbackText: "Terca" } },
  });
  eq(comPostback[0].texto, "Terca", "postbackText tambem serve");

  const semNada = parseEvento({
    type: "message",
    payload: { id: "g3", type: "button_reply", sender: { phone: "5511988887777" }, payload: {} },
  });
  eq(semNada[0].texto, "[button_reply]", "sem campo legivel, o rotulo antigo FICA — nada e inventado");
  eq(semNada[0].tipo, "button_reply", "e o tipo cru fica, pra nao afirmar que era texto");

  // nao-regressao: texto normal do v1 continua igual
  const texto = parseEvento({
    type: "message",
    payload: { id: "g4", type: "text", sender: { phone: "5511988887777" }, payload: { text: "oi" } },
  });
  eq(texto[0].texto, "oi", "texto normal intacto");
  eq(texto[0].tipo, "text", "tipo intacto");
}

// ============================== 6) GUARDAS ESTRUTURAIS (provedor e rota)

const ler = (p: string) => readFileSync(p, "utf8");

/**
 * O ramo interativo de /api/send: do `if (vInter?.ok && plano)` ate o `} else {`
 * que abre o ramo NORMAL (texto/midia). O corte usa o comentario `// FALLBACK:`
 * como ancora do meio porque o `else if` interno tem a mesma forma que o externo
 * — cortar no primeiro `} else {` pegaria o pedaco errado. Nada de `\n` nos
 * marcadores: o repo esta em autocrlf e o arquivo pode chegar com CRLF.
 */
function ramoInterativo(src: string): string {
  const i0 = src.indexOf("if (vInter?.ok && plano)");
  const iFb = src.indexOf("// FALLBACK:", i0);
  const fim = src.indexOf("} else {", iFb);
  assert.equal(i0 > 0 && iFb > i0 && fim > iFb, true, "o ramo interativo de /api/send foi localizado");
  n += 1;
  return src.slice(i0, fim);
}
/** So o pedaco do FALLBACK (do comentario ate o fim do ramo interativo). */
function ramoFallback(src: string): string {
  const r = ramoInterativo(src);
  return r.slice(r.indexOf("// FALLBACK:"));
}

// 6.1 A AUSENCIA DE `send-button-list` E DELIBERADA. Se alguem "consertar" isso
//     ligando o endpoint, a mensagem passa a sair por um caminho que a propria
//     doc da Z-API chama de instavel: o cliente nao ve botao e o atendente
//     espera resposta que nunca vem.
{
  const zapi = ler("lib/zapi.ts");
  ok(/send-option-list/.test(zapi), "a Z-API manda LISTA por send-option-list");
  ok(!/send-button-list/.test(zapi.replace(/\/\/.*$/gm, "")), "e NAO existe chamada a send-button-list");
  ok(/instabilidade/.test(zapi), "com o motivo escrito no arquivo");
}

// 6.2 o ENVELOPE nao mora dentro do `fetch` — e o que permite ele ter prova
{
  const zapi = ler("lib/zapi.ts");
  const gup = ler("lib/gupshup.ts");
  ok(/envelope: Record<string, unknown>/.test(zapi), "zapiSendOptionList recebe o envelope pronto");
  ok(/envelope: Record<string, unknown>/.test(gup), "gsSendInterativo tambem");
  ok(!/optionList:/.test(zapi), "e nenhum dos dois monta optionList por dentro");
  ok(!/globalButtons/.test(gup), "nem globalButtons");
}

// 6.3 a ROTA valida ANTES de tocar o banco (jsonb validado na entrada)
{
  const send = ler("app/api/send/route.ts");
  const iValida = send.indexOf("validarInterativa(interativa)");
  const iBanco = send.indexOf("const db = msgDb()");
  ok(iValida > 0 && iBanco > 0, "os dois pontos existem");
  ok(iValida < iBanco, "a validacao vem ANTES de qualquer consulta");
}

// 6.4 a rota devolve o PLANO. Sem isso a tela nao poderia dizer que a pergunta
//     saiu como texto numerado — e "enviei botoes" pra quem recebeu texto e
//     exatamente a mentira que o campo existe pra impedir.
{
  const send = ler("app/api/send/route.ts");
  ok(/modo: plano\.modo/.test(send), "o modo volta na resposta");
  ok(/motivo_modo: plano\.motivo/.test(send), "e o motivo junto");
}

// 6.5 a interativa NAO passa pelo caminho de midia (que a API oficial recusa) e
//     nao e assinada (a assinatura estouraria o teto do envelope e a Meta
//     recusaria a mensagem inteira)
{
  const send = ler("app/api/send/route.ts");
  ok(/!ehMidia && !ehInterativa && !text/.test(send), "interativa nao cai em 'mensagem vazia'");
  ok(!/textoEnviar/.test(ramoInterativo(send)), "e o ramo interativo nao usa o texto assinado");
}

// 6.6 o fallback sai pela porta de TEXTO NORMAL do canal — nao existe segundo
//     caminho de envio (o que vale pro texto vale aqui: janela de 24h, quote)
{
  const bloco = ramoFallback(ler("app/api/send/route.ts"));
  ok(/gsSendText\(/.test(bloco) && /zapiSendText\(/.test(bloco) && /evoSendText\(/.test(bloco),
    "o fallback usa as tres funcoes de texto que ja existiam");
  ok(!/zapiSendMedia|evoSendMedia|gsSendInterativo|zapiSendOptionList/.test(bloco),
    "e nao inventa uma segunda porta de envio");
}

// 6.7 a COSTURA no webhook Z-API existe e esta na ordem certa.
//
// `respostaZapi` e pura e tem prova (secao 5), mas ela nao serve de nada se o
// webhook nao a chamar — e "sem selo" e indistinguivel de "nao houve escolha",
// ou seja o erro nunca apareceria. Duas propriedades travadas:
//   (a) o TEXTO DIGITADO vence a escolha (payload com os dois e texto de gente);
//   (b) o tipo vira `text`, senao a bolha continuaria mostrando "[mensagem]".
{
  const wh = ler("app/api/webhook/route.ts");
  ok(/respostaZapi\(p\)/.test(wh), "o webhook chama respostaZapi");
  const iTexto = wh.indexOf("p?.text?.message ??");
  const iEscolha = wh.indexOf("escolha?.texto ??");
  ok(iTexto > 0 && iEscolha > iTexto, "o texto digitado vem ANTES da escolha na cadeia de conteudo");
  ok(/: escolha \? "text"/.test(wh), "e a escolha roteia como tipo `text` (mensagem normal)");
}

// 6.8 o inbound Gupshup v1 NAO fabrica titulo. Sem campo legivel, o rotulo
//     antigo fica — inventar texto de escolha seria inverter um fato sobre o que
//     o cliente disse, e a forma exata desse payload nao deu pra confirmar na
//     doc oficial (paginas 404 em 31/08/2026).
{
  const gi = ler("lib/gupshup-inbound.ts");
  ok(/FRENTE S/.test(gi), "o toque esta marcado como FRENTE S (o merge precisa ver)");
  ok(/nao deu pra confirmar na doc oficial|404/.test(gi), "e a limitacao da fonte esta declarada no codigo");
  ok(/escolha ??/.test(gi.replace(/\?\?/g, "??")), "a escolha entra na cadeia com fallback");
}

// 6.9 A TELA usa as MESMAS funcoes da rota, e mostra o plano ANTES do clique.
//
// Nao e duplicacao de regra: e a mesma regra chamada duas vezes. O que a prova
// trava e a tela nao ter uma segunda opiniao — um `if (tipo === "botoes" &&
// canal === "central")` escrito no .tsx divergiria da rota no primeiro provedor
// novo, e o atendente veria "enviar botoes" pra um canal que manda texto.
{
  const src = ler("app/home.tsx");
  // A checagem e por REGIAO, nao pelo arquivo inteiro: `validarInterativa`
  // aparece duas vezes (no envio e na previa do formulario) e um teste global
  // ficaria verde com UMA das duas estragada — foi o que uma mutacao mostrou.
  const envia = src.slice(src.indexOf("async function enviarInterativa"), src.indexOf("async function encaminhar"));
  ok(/const v = validarInterativa\(rascunhoInterativo\(\)\);/.test(envia),
    "o ENVIO valida com validarInterativa antes de chamar a rota");
  const iValida = envia.indexOf("validarInterativa");
  const iFetch = envia.indexOf("authedFetch(\"/api/send\"");
  ok(iValida > 0 && iFetch > iValida, "e valida ANTES do fetch, nao depois");
  // e a PREVIA do formulario tambem chama a lib — o atendente ve o erro e o
  // plano de envio antes de clicar, nao como 400 depois
  const previa = src.slice(src.indexOf("{interAberto && (() => {"));
  ok(/const v = validarInterativa\(rascunhoInterativo\(\)\);/.test(previa),
    "a PREVIA do formulario tambem valida com a lib");
  ok(/planoDeEnvio\(fonteDoCanalAtivo\(\)/.test(previa), "e resolve o plano com planoDeEnvio");
  ok(/maxOpcoes\(interTipo\)/.test(previa) && /limiteTituloOpcao\(interTipo\)/.test(previa),
    "os tetos do formulario vem da lib, nao de numero escrito no .tsx");
  ok(/\{plano\.motivo\}/.test(previa), "o motivo do fallback aparece ANTES do clique");
  ok(/j\.modo === "texto_numerado"/.test(src), "e o modo que o SERVIDOR devolveu e o que a tela relata");
}

// 6.10 O gate de MIDIA e por FONTE do canal, nao por id de canal built-in.
//
// Era `canal === "central"` no clipe e no microfone: uma 2a instancia Z-API
// declarada em CANAIS_EXTRA (o caso que a P1 abriu) ficava sem os dois botoes
// SUPORTANDO os dois envios. Regra BASE do repo: id de canal nao decide
// comportamento.
{
  const src = ler("app/home.tsx");
  ok(/midiaDoCanalAtivo\(\)\.pode/.test(src), "os botoes de arquivo e microfone gateiam por capacidade");
  // A varredura tira os COMENTARIOS antes de olhar: o comentario que explica a
  // troca cita o `canal === "central"` que foi removido, e sem essa limpeza a
  // prova reprovaria por causa da propria explicacao. Sobram as duas ocorrencias
  // legitimas (editar/apagar mensagem), que vivem na LISTA e nao no composer.
  const composer = src
    .slice(src.indexOf("<footer className=\"relative flex items-center gap-2"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
  ok(!/canal === "central"/.test(composer), "e nao existe mais `canal === \"central\"` no composer");
}

// 6.11 AUDIO: parar a gravacao NAO ENVIA — vira previa (card 86ak86jx2).
//
// Antes desta frente o `onstop` chamava /api/send direto: tosse, cachorro ou
// frase errada chegavam ao cliente sem ninguem revisar, e audio nao se edita
// depois de enviado.
{
  const src = ler("app/home.tsx");
  const iStop = src.indexOf("rec.onstop = () =>");
  const iFimStop = src.indexOf("gravadorRef.current = rec;", iStop);
  ok(iStop > 0 && iFimStop > iStop, "o onstop foi localizado");
  const onstop = src.slice(iStop, iFimStop);
  ok(!/\/api\/send/.test(onstop), "parar a gravacao NAO envia");
  ok(/setAudioPronto\(/.test(onstop), "e vira previa");
  ok(/URL\.revokeObjectURL/.test(src), "a previa descartada solta o blob (senao vaza memoria por gravacao)");
  // envio falho MANTEM a previa: descartar apagaria a gravacao por causa de um
  // erro de rede, e audio nao se refaz igual
  // fecha em `rascunhoInterativo` (a proxima funcao declarada): ir ate
  // `encaminhar` engoliria o envio da interativa e mediria a ordem errada
  const enviar = src.slice(src.indexOf("async function enviarAudioPronto"), src.indexOf("function rascunhoInterativo"));
  const iErro = enviar.indexOf("Falha ao enviar audio");
  const iDescarta = enviar.indexOf("descartarAudio()");
  ok(iErro > 0 && iDescarta > iErro, "no caminho de erro a previa NAO e descartada");
}

// ———————————————————————————————————————————————————————————————————————————
// 6.12 O QUE A REVISAO CEGA ACHOU — as cinco propriedades que passaram verdes.
{
  // (a) TITULO POR TIPO, e o envelope SEM CORTE.
  //
  // A validacao cobrava 60 e o envelope cortava em 20 (header do quick_reply) e
  // 24 (titulo da secao da list): titulo de 40 PASSAVA e saia cortado ao meio.
  eq(limiteTituloMensagem("botoes"), 20, "titulo de mensagem com botoes: teto 20");
  eq(limiteTituloMensagem("lista"), 24, "titulo de mensagem com lista: teto 24");
  ok(ruim({ ...BOTOES, titulo: "t".repeat(21) }, "titulo de 21 em botoes e RECUSADO")
      .join(" ").includes("titulo passa de 20"), "com o teto de 20 no motivo");
  ok(ruim({ ...LISTA, titulo: "t".repeat(25) }, "titulo de 25 em lista e RECUSADO")
      .join(" ").includes("titulo passa de 24"), "com o teto de 24 no motivo");
  bom({ ...BOTOES, titulo: "t".repeat(20) }, "exatamente 20 passa em botoes");
  bom({ ...LISTA, titulo: "t".repeat(24) }, "exatamente 24 passa em lista");

  // e o envelope entrega o que foi validado, SEM slice: corte que sobrou no
  // envelope e corte silencioso — o cliente le uma frase que ninguem escreveu
  const inter = ler("lib/interativas.ts");
  const envelopes = inter.slice(inter.indexOf("export function envelopeGupshup"));
  ok(!/\.slice\(/.test(envelopes), "nenhum envelope corta campo em silencio");
  // prova de comportamento, nao so de texto: o titulo chega inteiro
  {
    const mb = bom({ ...BOTOES, titulo: "t".repeat(20) }, "fixture: titulo no teto (botoes)");
    eq((envelopeGupshup(mb) as any).content.header, "t".repeat(20), "o header sai com o titulo inteiro");
    const ml = bom({ ...LISTA, titulo: "t".repeat(24) }, "fixture: titulo no teto (lista)");
    eq((envelopeGupshup(ml) as any).items[0].title, "t".repeat(24), "o titulo da secao sai inteiro");
    eq((envelopeZapiLista(ml) as any).optionList.title, "t".repeat(24), "e na Z-API tambem");
  }
}

{
  // (b) A PREVIA NAO PROMETE BOTAO QUANDO SAIU TEXTO.
  //
  // No fallback saiu texto numerado; rotular "[botoes]" na sidebar faria a lista
  // de conversas afirmar um recurso que o cliente nao recebeu — a mesma mentira
  // que `tipoDeMensagem` evita ao gravar `text` no banco.
  const v = bom(BOTOES, "fixture da previa (botoes)");
  ok(previaDoEnviado(v, "nativo").startsWith("[botoes]"), "no nativo a previa diz [botoes]");
  ok(!previaDoEnviado(v, "texto_numerado").includes("[botoes]"),
    "no fallback a previa NAO diz [botoes]");
  eq(tipoDeMensagem(v, "texto_numerado"), "text", "e o tipo gravado tambem e text");
  // as duas fontes contam a MESMA historia
  const vl = bom(LISTA, "fixture da previa (lista)");
  ok(!previaDoEnviado(vl, "texto_numerado").includes("[lista]"), "idem pra lista");

  // e a rota passa o modo (sem isso a assinatura nova nao muda nada na pratica)
  const send = ler("app/api/send/route.ts");
  ok(/previaDoEnviado\(vInter\.msg, plano\.modo\)/.test(send), "a rota passa o modo pra previa");
}

{
  // (c) `message` DIVERGENTE da pergunta = 400, nunca descarte silencioso.
  //
  // O corpo que sai e `interativa.texto`; um `message` diferente era jogado fora
  // e o chamador recebia 200 — bug que so aparece do lado do cliente.
  const send = ler("app/api/send/route.ts");
  ok(/text !== vInter\.msg\.texto/.test(send), "a rota compara os dois campos");
  const iCheck = send.indexOf("text !== vInter.msg.texto");
  const iEnvio = send.indexOf("const plano =");
  ok(iCheck > 0 && iEnvio > iCheck, "e recusa ANTES de montar o plano de envio");
}

{
  // (d) Z-API `send-option-list` NAO leva campo nao documentado.
  //
  // `messageId` (quote) funciona no send-text e foi repassado aqui por simetria.
  // O risco nao e o quote nao aparecer: e a API recusar a mensagem INTEIRA por
  // causa do campo extra, e a pergunta nunca chegar ao cliente.
  const zapi = ler("lib/zapi.ts");
  const fn = zapi.slice(zapi.indexOf("export function zapiSendOptionList"));
  const corpo = fn.slice(0, fn.indexOf("\n}"));
  // olha a CHAMADA, nao a prosa: o comentario que explica a ausencia cita o
  // proprio `messageId`, e varrer o corpo inteiro reprovaria pela explicacao
  const chamada = corpo.split("\n").filter((l) => l.includes("return post(")).join("\n");
  ok(chamada.length > 0, "a chamada do send-option-list foi localizada");
  ok(!/messageId/.test(chamada), "zapiSendOptionList nao manda messageId");
  ok(/SEM `messageId`/.test(corpo), "e a ausencia esta explicada (pra ninguem 'consertar' depois)");
}

{
  // (e) O FORMULARIO da interativa nao se sabota.
  //
  // Dois defeitos de UX que a revisao achou: clicar na caixa da pergunta fechava
  // o painel (a pergunta E o texto da caixa), e Enter com o painel aberto enviava
  // a pergunta CRUA, sem opcao nenhuma — pior que nao enviar, porque parece
  // enviado e o menu nunca chegou.
  const home = ler("app/home.tsx");
  ok(/onClick=\{\(e\) => \{ if \(interAberto\) e\.stopPropagation\(\); \}\}/.test(home),
    "clicar na caixa da mensagem NAO fecha o painel de opcoes");
  ok(/if \(interAberto && !modoNota && !editando\) \{ enviarInterativa\(\); return; \}/.test(home),
    "Enter com o painel aberto manda a pergunta COM as opcoes");
  // e o Enter da interativa vem ANTES do send() normal
  const iInter = home.indexOf("enviarInterativa(); return;");
  const iSend = home.indexOf("send();", iInter);
  ok(iInter > 0 && iSend > iInter, "e essa checagem vem antes do send() de texto");

  // o motivo do gate de midia APARECE (era calculado e nunca renderizado)
  ok(/onClick=\{\(\) => setAviso\(midiaDoCanalAtivo\(\)\.motivo!\)\}/.test(home),
    "o motivo de nao poder anexar/gravar e mostravel pro atendente");
  ok(/!midiaDoCanalAtivo\(\)\.pode && midiaDoCanalAtivo\(\)\.motivo/.test(home),
    "e so aparece quando ha motivo de verdade");

  // o blob: e revogado pela REF, nao dentro do updater do setState (updater de
  // componente desmontado nao roda — o vazamento ficava justo no caso coberto)
  ok(/URL\.revokeObjectURL\(audioUrlRef\.current\)/.test(home), "o revoke usa a ref");
  const limpeza = home.slice(home.indexOf("if (relogioGrav.current) clearInterval(relogioGrav.current);"));
  ok(!/setAudioPronto\(\(a\) => \{/.test(limpeza.slice(0, 400)),
    "e a limpeza do unmount NAO depende de updater de setState");

  // a tela manda SO o campo que mudou no PATCH (senao o 400 "nada pra mudar" da
  // rota e codigo morto e "atualizado" passa a ser dito sem nada ter mudado)
  ok(/if \(texto !== agendadaEdit\.origTexto\.trim\(\)\) patch\.texto = texto;/.test(home),
    "o PATCH da tela leva o texto so quando ele mudou");
  ok(/if \(agendadaEdit\.quando !== agendadaEdit\.origQuando\) patch\.enviar_em = enviarEm;/.test(home),
    "e o horario so quando ele mudou");
}

console.log(`prova-interativas: OK (${n} checagens)`);
