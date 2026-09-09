// Prova da COMPATIBILIDADE DE FORMATO do webhook de saida (card 86ak85apk).
// Roda em Node >= 22.6 sem build, sem rede e sem banco:
// `node scripts/prova-webhook-compat.ts`
//
// O QUE ELA GUARDA (o resto e detalhe):
//  1. destino que JA existe em producao nao muda de corpo — o default e o
//     envelope de sempre, byte a byte;
//  2. o texto da mensagem NAO escapa da flag `incluir_conteudo` por nenhum
//     formato (o mapa e o caminho novo, e era a porta lateral obvia);
//  3. content-type e corpo saem do MESMO calculo (form com cabecalho de JSON e
//     o silencio que a compatibilidade existe pra evitar);
//  4. a assinatura HMAC e do corpo QUE VAI NA REDE, nao do envelope;
//  5. modo `mapa` vazio nao passa por compatibilidade em silencio;
//  6. **nao existe modo "chatguru"** — o corpo da ferramenta antiga nao esta
//     documentado em lugar nenhum, e um modo com esse nome seria chute com
//     carimbo. A prova reprova se alguem inventar um.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CAMINHOS,
  FORMATO_PADRAO,
  MAX_CAMPOS_MAPA,
  MODOS_FORMATO,
  TIPOS_CONTEUDO,
  corpoDeSaida,
  corpoForm,
  corpoObjeto,
  descreverFormato,
  formatoFoiRebaixado,
  resolverCaminho,
  validarFormato,
  type FormatoSaida,
} from "../lib/webhook-formato.ts";
import {
  assinar,
  assinaturaConfere,
  cabecalhos,
  corpoParaDestino,
  montarPayload,
  validarAssinantes,
  type Assinante,
  type Payload,
} from "../lib/webhooks-saida.ts";

let checagens = 0;
const teste = (oque: string, fn: () => void) => {
  fn();
  checagens++;
  console.log(`  ok  ${oque}`);
};

const META = { id: "entrega-1", em: "2026-08-31T12:00:00.000Z" };
const EV = {
  evento: "mensagem_recebida" as const,
  canal: "central",
  chat_id: "5511900000001",
  dados: { tipo: "text", de_grupo: false, tem_midia: false, provider_msg_id: "ABC", tamanho: 8 },
  conteudo: "orcamento",
};

const destino = (formato?: unknown): Assinante =>
  validarAssinantes([
    {
      nome: "cenario externo",
      url: "https://hook.exemplo.com/abc",
      eventos: ["mensagem_recebida"],
      segredo: "s3gr3d0",
      ativo: true,
      ...(formato === undefined ? {} : { formato }),
    },
  ])[0];

// ================================================= 1) O DEFAULT NAO MUDA
console.log("\n1) DEFAULT — destino que ja existe em producao nao muda de corpo");

teste("destino sem `formato` na config nasce no envelope de sempre, em JSON", () => {
  const a = destino();
  assert.deepEqual(a.formato, FORMATO_PADRAO);
});

teste("o corpo do modo expert e IDENTICO ao JSON.stringify(payload) de antes", () => {
  const a = destino();
  const p = montarPayload(EV, a.incluir_conteudo, META);
  const { corpo, contentType } = corpoParaDestino(a, p);
  assert.equal(corpo, JSON.stringify(p));
  assert.equal(contentType, "application/json");
});

teste("assinante gravado ANTES desta feature (formato ausente) continua entregando igual", () => {
  // simula a linha de config que ja existe em producao: sem a chave `formato`
  const [a] = validarAssinantes([
    { nome: "antigo", url: "https://hook.exemplo.com/x", eventos: ["status_alterado"], segredo: "", ativo: true },
  ]);
  const p = montarPayload({ evento: "status_alterado", canal: "central", chat_id: "1", dados: { para: "aberto" } }, false, META);
  assert.equal(corpoParaDestino(a, p).corpo, JSON.stringify(p));
});

// ================================================= 2) PRIVACIDADE
console.log("\n2) PRIVACIDADE — nenhum formato fura a flag `incluir_conteudo`");

teste("sem opt-in, o texto nao esta no payload e o mapa nao tem de onde tirar", () => {
  const a = destino({ modo: "mapa", mapa: { texto: "$conteudo", texto2: "$dados.conteudo" } });
  assert.equal(a.incluir_conteudo, false);
  const p = montarPayload(EV, a.incluir_conteudo, META);
  const obj = corpoObjeto(a.formato, p);
  assert.equal(obj.texto, "");
  assert.equal(obj.texto2, "");
  assert.equal(corpoParaDestino(a, p).corpo.includes("orcamento"), false);
});

teste("COM opt-in o texto sai — a flag e a UNICA chave, e ela funciona nos dois sentidos", () => {
  const a = { ...destino({ modo: "mapa", mapa: { texto: "$conteudo" } }), incluir_conteudo: true };
  const p = montarPayload(EV, true, META);
  assert.equal(corpoObjeto(a.formato, p).texto, "orcamento");
});

teste("modo PLANO tambem respeita a flag (o achatamento nao inventa campo)", () => {
  const a = destino({ modo: "plano" });
  const semFlag = corpoObjeto(a.formato, montarPayload(EV, false, META));
  const comFlag = corpoObjeto(a.formato, montarPayload(EV, true, META));
  assert.equal("conteudo" in semFlag, false);
  assert.equal(comFlag.conteudo, "orcamento");
});

teste("`$conteudo` e APELIDO de `$dados.conteudo` — um portao so, nao dois", () => {
  const p = montarPayload(EV, true, META);
  assert.equal(resolverCaminho("$conteudo", p), resolverCaminho("$dados.conteudo", p));
});

// ================================================= 3) MODO PLANO
console.log("\n3) MODO PLANO — achata UM nivel, e a chave do envelope vence a colisao");

teste("`dados` sobe pra raiz e a chave `dados` desaparece", () => {
  const p = montarPayload(EV, false, META);
  const obj = corpoObjeto(validarFormato({ modo: "plano" }), p);
  assert.equal("dados" in obj, false);
  assert.equal(obj.tipo, "text");
  assert.equal(obj.provider_msg_id, "ABC");
  assert.equal(obj.evento, "mensagem_recebida");
  assert.equal(obj.chat_id, "5511900000001");
});

teste("colisao: `dados.evento` NAO sobrescreve o evento (o destino rotearia a coisa errada)", () => {
  const p = montarPayload({ ...EV, dados: { evento: "outra_coisa", tipo: "text" } }, false, META);
  const obj = corpoObjeto(validarFormato({ modo: "plano" }), p);
  assert.equal(obj.evento, "mensagem_recebida");
});

// ================================================= 4) MODO MAPA
console.log("\n4) MODO MAPA — campo do destino -> caminho ou LITERAL");

teste("caminho resolve do payload; qualquer outra coisa e literal (as constantes da acao antiga)", () => {
  const p = montarPayload(EV, false, META);
  const f = validarFormato({
    modo: "mapa",
    mapa: {
      telefone: "$chat_id",
      // os tres campos que a acao antiga carregava como CONSTANTE configurada
      campanha_id: "196",
      campanha_nome: "Reengajamento",
      origem: "expert-chat",
      tipo_msg: "$dados.tipo",
    },
  });
  assert.deepEqual(corpoObjeto(f, p), {
    telefone: "5511900000001",
    campanha_id: "196",
    campanha_nome: "Reengajamento",
    origem: "expert-chat",
    tipo_msg: "text",
  });
});

teste("caminho DESCONHECIDO resolve vazio — nunca manda a string '$telefone' pro CRM do cliente", () => {
  const p = montarPayload(EV, false, META);
  assert.equal(resolverCaminho("$telefone", p), "");
  assert.equal(resolverCaminho("$dados.", p), "");
  assert.equal(resolverCaminho("$dados.inexistente", p), "");
});

teste("`$dados` inteiro vale (cenario que le o bloco cru)", () => {
  const p = montarPayload(EV, false, META);
  assert.deepEqual(resolverCaminho("$dados", p), p.dados);
});

teste("a lista de caminhos e FECHADA, e todos os declarados resolvem", () => {
  const p = montarPayload(EV, true, META);
  for (const c of CAMINHOS) {
    const v = resolverCaminho(c, p);
    assert.notEqual(v, undefined, c);
  }
});

teste("chave torta, chave de prototipo e valor nao-escalar sao descartados", () => {
  const f = validarFormato({
    modo: "mapa",
    mapa: {
      ok: "$chat_id",
      "chave com espaco": "$canal",
      "chave/barra": "$canal",
      __proto__: "$canal",
      constructor: "$canal",
      objeto: { a: 1 },
      lista: [1, 2],
    },
  });
  assert.deepEqual(Object.keys(f.mapa), ["ok"]);
});

teste("numero e booleano no valor viram literal em texto (a config e jsonb)", () => {
  const f = validarFormato({ modo: "mapa", mapa: { n: 196, b: true } });
  assert.equal(f.mapa.n, "196");
  assert.equal(f.mapa.b, "true");
});

teste("teto de campos do mapa", () => {
  const grande: Record<string, string> = {};
  for (let i = 0; i < MAX_CAMPOS_MAPA + 20; i++) grande[`c${i}`] = "$chat_id";
  assert.equal(Object.keys(validarFormato({ modo: "mapa", mapa: grande }).mapa).length, MAX_CAMPOS_MAPA);
});

teste("o objeto de saida nao carrega prototipo poluido (a chave __proto__ do jsonb)", () => {
  const p = montarPayload(EV, false, META);
  const obj = corpoObjeto(validarFormato({ modo: "plano" }), p);
  assert.equal(Object.prototype.hasOwnProperty.call(obj, "__proto__"), false);
  // e o corpo serializa sem explodir
  assert.doesNotThrow(() => JSON.stringify(obj));
});

// ================================================= 5) CONTENT-TYPE
console.log("\n5) CONTENT-TYPE — sai do MESMO calculo do corpo");

teste("form vira urlencoded, e o cabecalho acompanha", () => {
  const a = destino({ modo: "mapa", tipo_conteudo: "form", mapa: { telefone: "$chat_id", origem: "expert" } });
  const p = montarPayload(EV, false, META);
  const { corpo, contentType } = corpoParaDestino(a, p);
  assert.equal(contentType, "application/x-www-form-urlencoded;charset=UTF-8");
  assert.equal(corpo, "telefone=5511900000001&origem=expert");
  const h = cabecalhos(a, p, corpo, contentType);
  assert.equal(h["content-type"], contentType);
});

teste("GRAVE se invertesse: corpo de form NUNCA sai com cabecalho de JSON", () => {
  const a = destino({ modo: "plano", tipo_conteudo: "form" });
  const p = montarPayload(EV, false, META);
  const { corpo, contentType } = corpoParaDestino(a, p);
  assert.equal(corpo.includes("{"), false, "corpo de form nao e JSON");
  assert.equal(contentType.startsWith("application/x-www-form-urlencoded"), true);
});

teste("objeto/lista dentro do form viram JSON no valor (form nao tem nesting)", () => {
  const s = corpoForm({ dados: { a: 1 }, lista: [1, 2], nulo: null, indef: undefined, n: 3 });
  const q = new URLSearchParams(s);
  assert.equal(q.get("dados"), '{"a":1}');
  assert.equal(q.get("lista"), "[1,2]");
  assert.equal(q.get("nulo"), "");
  assert.equal(q.get("indef"), "");
  assert.equal(q.get("n"), "3");
});

teste("valor com & e = e escapado (senao um campo vira dois)", () => {
  const s = corpoForm({ txt: "a=b&c=d" });
  assert.equal(new URLSearchParams(s).get("txt"), "a=b&c=d");
});

// ================================================= 6) ASSINATURA
console.log("\n6) HMAC — assina o corpo QUE VAI NA REDE, nao o envelope");

teste("a assinatura confere contra o corpo do formato escolhido", () => {
  const a = destino({ modo: "mapa", tipo_conteudo: "form", mapa: { telefone: "$chat_id" } });
  const p = montarPayload(EV, false, META);
  const { corpo, contentType } = corpoParaDestino(a, p);
  const h = cabecalhos(a, p, corpo, contentType);
  assert.equal(assinaturaConfere(a.segredo, corpo, h["x-expert-chat-assinatura"]), true);
});

teste("a assinatura do ENVELOPE nao confere contra o corpo de compatibilidade (era o bug possivel)", () => {
  const a = destino({ modo: "mapa", mapa: { telefone: "$chat_id" } });
  const p = montarPayload(EV, false, META);
  const { corpo } = corpoParaDestino(a, p);
  const assinaturaDoEnvelope = `sha256=${assinar(a.segredo, JSON.stringify(p))}`;
  assert.notEqual(corpo, JSON.stringify(p));
  assert.equal(assinaturaConfere(a.segredo, corpo, assinaturaDoEnvelope), false);
});

teste("sem segredo nao sai cabecalho de assinatura (e nao sai string vazia assinada)", () => {
  const [a] = validarAssinantes([
    { nome: "x", url: "https://hook.exemplo.com/y", eventos: ["mensagem_recebida"], segredo: "", ativo: true },
  ]);
  const p = montarPayload(EV, false, META);
  const { corpo, contentType } = corpoParaDestino(a, p);
  assert.equal("x-expert-chat-assinatura" in cabecalhos(a, p, corpo, contentType), false);
});

// ================================================= 7) CONFIG TORTA
console.log("\n7) CONFIG TORTA — tolera na LEITURA, recusa na GRAVACAO");

teste("modo/tipo desconhecido cai no default (nunca derruba a entrega de quem ja integrou)", () => {
  assert.equal(validarFormato({ modo: "xpto" }).modo, "expert");
  assert.equal(validarFormato({ modo: "plano", tipo_conteudo: "xml" }).tipo_conteudo, "json");
  assert.deepEqual(validarFormato(null), FORMATO_PADRAO);
  assert.deepEqual(validarFormato("plano"), FORMATO_PADRAO);
  assert.deepEqual(validarFormato([1, 2]), FORMATO_PADRAO);
});

teste("mapa VAZIO nao vira compatibilidade: rebaixa pro envelope e DECLARA o rebaixamento", () => {
  assert.equal(validarFormato({ modo: "mapa" }).modo, "expert");
  assert.equal(validarFormato({ modo: "mapa", mapa: {} }).modo, "expert");
  assert.equal(formatoFoiRebaixado({ modo: "mapa", mapa: {} }), true);
  // mapa que so tem chave invalida tambem conta como vazio
  assert.equal(formatoFoiRebaixado({ modo: "mapa", mapa: { "nao vale": "$canal" } }), true);
  // e um mapa de verdade NAO e rebaixado
  assert.equal(formatoFoiRebaixado({ modo: "mapa", mapa: { t: "$chat_id" } }), false);
  assert.equal(formatoFoiRebaixado({ modo: "plano" }), false);
});

teste("o tipo de conteudo sobrevive ao rebaixamento (a pessoa escolheu form de proposito)", () => {
  assert.equal(validarFormato({ modo: "mapa", mapa: {}, tipo_conteudo: "form" }).tipo_conteudo, "form");
});

teste("descreverFormato diz o que o destino vai receber, nos tres modos", () => {
  assert.match(descreverFormato(FORMATO_PADRAO), /envelope padrao/);
  assert.match(descreverFormato(validarFormato({ modo: "plano", tipo_conteudo: "form" })), /achatados.*formulario/);
  const m = descreverFormato(validarFormato({ modo: "mapa", mapa: { telefone: "$chat_id" } }));
  assert.match(m, /mapa declarado com 1 campo/);
  assert.match(m, /telefone/);
});

// ================================================= 8) HONESTIDADE
console.log("\n8) HONESTIDADE — o formato da ferramenta antiga NAO e conhecido");

const FONTE = readFileSync(new URL("../lib/webhook-formato.ts", import.meta.url), "utf8");
const semComentario = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

teste("NAO existe modo 'chatguru' — o corpo deles nao esta documentado, e um modo assim seria chute com carimbo", () => {
  assert.equal((MODOS_FORMATO as readonly string[]).includes("chatguru"), false);
  const codigo = semComentario(FONTE);
  assert.equal(/chatguru/i.test(codigo), false, "apareceu 'chatguru' no CODIGO (nao no comentario)");
});

teste("o arquivo REGISTRA a lacuna e as duas rotas de descoberta (senao alguem chuta o formato depois)", () => {
  assert.match(FONTE, /nao esta registrado em lugar nenhum|nao esta documentado/i);
  assert.match(FONTE, /Make/);
  assert.match(FONTE, /receptor temporario|receptor/i);
});

teste("lib/webhook-formato.ts nao importa nada (roda em node solto, e a decisao fica provavel)", () => {
  const codigo = semComentario(FONTE);
  assert.equal(/^\s*import\s/m.test(codigo), false);
  assert.equal(/\brequire\s*\(/.test(codigo), false);
});

teste("os modos e tipos vem das CONSTANTES (tela montada em lista escrita a mao esquece o proximo)", () => {
  const rota = readFileSync(new URL("../app/api/admin/webhooks-saida/route.ts", import.meta.url), "utf8");
  assert.match(rota, /MODOS_FORMATO/);
  assert.match(rota, /TIPOS_CONTEUDO/);
  assert.match(rota, /CAMINHOS/);
  // e a gravacao RECUSA o rebaixamento em vez de dizer "salvei"
  assert.match(rota, /formatoFoiRebaixado/);
  const i = rota.indexOf("formatoFoiRebaixado");
  const j = rota.indexOf("validarAssinantes(comSegredo)");
  assert.ok(i > 0 && j > i, "a recusa tem que vir ANTES de gravar");
});

teste("TIPOS_CONTEUDO e MODOS_FORMATO nao ficaram vazios (constante vazia passa asserção de forma calada)", () => {
  assert.ok(MODOS_FORMATO.length >= 3);
  assert.ok(TIPOS_CONTEUDO.length >= 2);
  assert.ok(CAMINHOS.length >= 7);
});

// a assinatura de tipo tambem tem que continuar valendo em TS
const _f: FormatoSaida = FORMATO_PADRAO;
const _p: Payload = montarPayload(EV, false, META);
void _f;
void _p;
void corpoDeSaida;

console.log(`\nTUDO OK — ${checagens} checagens. Nenhuma rede tocada, nenhum banco tocado.`);
