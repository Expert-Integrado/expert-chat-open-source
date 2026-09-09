// Prova das VARIAVEIS DE TEXTO (Frente T, card 86ak86jw9).
// Roda em Node >= 22.6 sem build: `node scripts/prova-variaveis.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// O que esta prova garante, em uma linha cada:
//   - a substituicao troca `!prop`, `!campo.x` e `$var` por valor REAL;
//   - variavel conhecida sem valor vira VAZIO, nunca o nome dela (criterio de aceite);
//   - `!` e `$` de texto normal nao sao comidos (nao ha escape a aprender);
//   - a chave de contexto casa por igualdade EXATA — a MESMA regra da condicao de fluxo;
//   - o formato do sistema antigo (`{CHAVE}`) so e olhado com `legado: true`, e o
//     que nao resolve fica LITERAL pra alguem consertar;
//   - texto hostil (jsonb de terceiro, chave `__proto__`, texto gigante) nao quebra
//     nem vaza objeto na cara do cliente;
//   - a lib e PURA: nenhum import, nem de tipo.
//
// FIXTURES SAO SINTETICAS: nenhum dado de cliente entra no repo (mesma regra das
// outras provas do modulo).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALIAS_LEGADO, catalogoDeVariaveis, chaveNormalizadaDeCampo, PREFIXO_CAMPO, PROPS_VARIAVEL,
  primeiroNome, saudacaoDaHora, substituirVariaveis, valorDaProp, variaveisDoTexto,
} from "../lib/fluxo/variaveis.ts";

let feitos = 0;
const t = (nome: string, fn: () => void) => {
  fn();
  feitos++;
  console.log(`  ok  ${nome}`);
};

// Conversa sintetica: nome com sobrenome, ficha com campo acentuado e de espaco,
// contexto com chave de espaco (o dialeto de origem aceita).
const VALORES = {
  nome: "Maria Aparecida Souza",
  telefone: "5511999990000",
  atendente: "Joana",
  saudacao: "Boa tarde",
  campos: { "Nome da empresa": "Padaria Céu Azul", CNPJ: "12.345.678/0001-90", Parcelas: 3, Ativo: true, vazio: "" },
  contexto: { URA: "MENU", "Reserva confirmada": "sim" },
};

// ============================================================ 1) SUBSTITUICAO
console.log("\n1) substituicao: o que o atendente ve na caixa de texto");

t("propriedade simples e primeiro nome", () => {
  const r = substituirVariaveis("!saudacao, !primeiro_nome! Falo com !nome?", VALORES);
  assert.equal(r.texto, "Boa tarde, Maria! Falo com Maria Aparecida Souza?");
  assert.deepEqual(r.preenchidas, ["!saudacao", "!primeiro_nome", "!nome"]);
});

t("telefone e atendente", () => {
  const r = substituirVariaveis("Aqui e !atendente. Confirma o !telefone?", VALORES);
  assert.equal(r.texto, "Aqui e Joana. Confirma o 5511999990000?");
});

t("campo da ficha por chave normalizada (acento e espaco)", () => {
  const r = substituirVariaveis("Empresa: !campo.nome_da_empresa / CNPJ !campo.cnpj", VALORES);
  assert.equal(r.texto, "Empresa: Padaria Céu Azul / CNPJ 12.345.678/0001-90");
});

t("campo numerico e booleano viram texto; objeto NUNCA vira [object Object]", () => {
  assert.equal(substituirVariaveis("!campo.parcelas x", VALORES).texto, "3 x");
  assert.equal(substituirVariaveis("!campo.ativo", VALORES).texto, "true");
  const comObjeto = { campos: { Endereco: { rua: "x" }, Lista: [1, 2] } };
  const r = substituirVariaveis("[!campo.endereco][!campo.lista]", comObjeto);
  assert.equal(r.texto, "[][]", "estrutura vira vazio, nao serializacao");
});

t("variavel de contexto: $chave e ${chave com espaco}", () => {
  const r = substituirVariaveis("URA=$URA, reserva=${Reserva confirmada}", VALORES);
  assert.equal(r.texto, "URA=MENU, reserva=sim");
});

// ===================================================== 2) O CRITERIO DE ACEITE
console.log("\n2) sem valor vira VAZIO, nunca o nome da variavel");

t("propriedade conhecida sem valor: sai vazia e fica registrada", () => {
  const r = substituirVariaveis("Oi !nome, tudo bem?", { nome: "" });
  assert.equal(r.texto, "Oi , tudo bem?");
  assert.ok(!r.texto.includes("!nome"), "o nome da variavel NAO pode chegar ao cliente");
  assert.deepEqual(r.vazias, ["!nome"]);
});

t("campo da ficha que nao existe: forma conhecida, valor vazio", () => {
  const r = substituirVariaveis("CPF: !campo.cpf.", VALORES);
  assert.equal(r.texto, "CPF: .");
  assert.deepEqual(r.vazias, ["!campo.cpf"]);
});

t("campo da ficha com valor em branco conta como VAZIA, nao como preenchida", () => {
  const r = substituirVariaveis("[!campo.vazio]", VALORES);
  assert.equal(r.texto, "[]");
  assert.deepEqual(r.vazias, ["!campo.vazio"]);
  assert.deepEqual(r.preenchidas, []);
});

t("contexto ausente vira vazio (o mesmo fail-closed da condicao de fluxo)", () => {
  const r = substituirVariaveis("valor=$naoexiste.", VALORES);
  assert.equal(r.texto, "valor=.");
  assert.deepEqual(r.vazias, ["$naoexiste"]);
});

// ============================================== 3) TEXTO NORMAL FICA INTACTO
console.log("\n3) `!` e `$` de texto normal nao sao comidos");

t("exclamacao e preco atravessam sem mudanca", () => {
  const texto = "Fechado! Corre!!! O plano custa R$ 200 e o outro $50. 50% off!";
  assert.equal(substituirVariaveis(texto, VALORES).texto, texto);
});

t("propriedade fora do catalogo fica literal (nao inventa variavel)", () => {
  const r = substituirVariaveis("!cpf e !nome_completo ficam; !nome vai", VALORES);
  assert.equal(r.texto, "!cpf e !nome_completo ficam; Maria Aparecida Souza vai");
});

t("`!campo.` sem chave nenhuma nao e variavel", () => {
  assert.equal(substituirVariaveis("!campo. e !campo.__", VALORES).texto, "!campo. e !campo.__");
});

// ========================================== 4) A REGRA EXATA DA CHAVE DE CONTEXTO
console.log("\n4) chave de contexto casa por igualdade EXATA");

t("caixa diferente NAO casa — a mesma regra que a condicao de fluxo usa", () => {
  // Se aqui normalizasse, a resposta rapida acharia uma variavel que a condicao
  // do fluxo (docs/fluxo-canonico.md: chave por igualdade exata) nao acha, e o
  // atendente veria dois comportamentos pra mesma sintaxe.
  const r = substituirVariaveis("$ura|$URA", VALORES);
  assert.equal(r.texto, "|MENU");
  // E o caso que separa "igualdade exata" de "casou pela versao minuscula": duas
  // chaves que diferem SO na caixa sao duas variaveis, e cada token pega a sua.
  const duas = { contexto: { URA: "MAIUSCULA", ura: "minuscula" } };
  assert.equal(substituirVariaveis("$URA/$ura", duas).texto, "MAIUSCULA/minuscula");
});

t("chave `__proto__` do jsonb e chave como outra qualquer", () => {
  const mapa = Object.create(null);
  mapa["__proto__"] = "valor herdado nao";
  const r = substituirVariaveis("${__proto__}", { contexto: mapa });
  assert.equal(r.texto, "valor herdado nao");
});

t("mapa que chegou como objeto literal nao le do prototipo", () => {
  const r = substituirVariaveis("[$constructor]", { contexto: {} as any });
  assert.equal(r.texto, "[]", "funcao herdada NAO pode virar valor de variavel");
});

// ================================================= 5) LEGADO DA IMPORTACAO
console.log("\n5) `{CHAVE}` do sistema antigo: opt-in, e o que nao resolve fica visivel");

t("sem `legado`, o texto importado atravessa intacto", () => {
  const texto = "Oi {PRIMEIRO_NOME_LEAD}, {DAY_GREETING}!";
  assert.equal(substituirVariaveis(texto, VALORES).texto, texto);
});

t("com `legado`, as variaveis medidas resolvem", () => {
  const r = substituirVariaveis(
    "{DAY_GREETING}, {PRIMEIRO_NOME_LEAD}! Seu telefone e {TELEFONE_LEAD} e o nome {NOME_LEAD}.",
    VALORES,
    { legado: true }
  );
  assert.equal(r.texto, "Boa tarde, Maria! Seu telefone e 5511999990000 e o nome Maria Aparecida Souza.");
});

t("`{Empresa}`/`{CNPJ}` caem no campo da ficha (nao sao variavel de sistema)", () => {
  const r = substituirVariaveis("{Nome da empresa} - {CNPJ}", VALORES, { legado: true });
  assert.equal(r.texto, "Padaria Céu Azul - 12.345.678/0001-90");
});

t("legado que ninguem resolve fica LITERAL e vai pra lista", () => {
  const r = substituirVariaveis("veja {CHAT_LINK} e {MSG_TEXT}", VALORES, { legado: true });
  assert.equal(r.texto, "veja {CHAT_LINK} e {MSG_TEXT}");
  assert.deepEqual(r.nao_resolvidos, ["{CHAT_LINK}", "{MSG_TEXT}"]);
});

t("todo alias do legado aponta pra propriedade que EXISTE no catalogo", () => {
  for (const [de, para] of Object.entries(ALIAS_LEGADO)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(PROPS_VARIAVEL, para),
      `alias ${de} aponta pra ${para}, que nao esta em PROPS_VARIAVEL`
    );
  }
});

// ========================================================== 6) INVENTARIO
console.log("\n6) inventario de variaveis (o que a tela e a rota consomem)");

t("lista na ordem do TEXTO, sem repetir, e ignora token desconhecido", () => {
  const usos = variaveisDoTexto("!nome !nome $URA !cpf !campo.cnpj ${a b}");
  assert.deepEqual(
    usos.map((u) => `${u.forma}:${u.alvo}`),
    ["prop:nome", "contexto:URA", "prop:campo.cnpj", "contexto:a b"],
    "ordem POSICIONAL: e a mesma varredura da substituicao, entao inventario e resultado nao discordam"
  );
});

t("legado so aparece no inventario quando pedido", () => {
  assert.equal(variaveisDoTexto("{PRIMEIRO_NOME_LEAD}").length, 0);
  assert.equal(variaveisDoTexto("{PRIMEIRO_NOME_LEAD}", { legado: true }).length, 1);
});

t("catalogo de ajuda traz as props, os campos da instalacao e o contexto", () => {
  const cat = catalogoDeVariaveis(["Nome da empresa", "CNPJ", "CNPJ"]);
  const tokens = cat.map((c) => c.token);
  for (const p of Object.keys(PROPS_VARIAVEL)) assert.ok(tokens.includes(`!${p}`), `falta !${p}`);
  assert.ok(tokens.includes(`!${PREFIXO_CAMPO}nome_da_empresa`));
  assert.equal(tokens.filter((x) => x === `!${PREFIXO_CAMPO}cnpj`).length, 1, "campo repetido entra uma vez");
  assert.ok(tokens.includes("$variavel"));
  for (const c of cat) assert.ok(c.verbete.length > 10, `verbete fraco em ${c.token}`);
});

// ============================================================== 7) HOSTIL
console.log("\n7) entrada hostil e borda");

t("nao lanca com entrada que nao e texto", () => {
  for (const bruto of [null, undefined, 42, {}, [], true]) {
    const r = substituirVariaveis(bruto as any, VALORES);
    assert.equal(r.texto, "");
  }
});

t("valores ausentes por completo: tudo vira vazio, nada quebra", () => {
  const r = substituirVariaveis("!nome/!telefone/!campo.x/$y", {});
  assert.equal(r.texto, "///");
});

t("texto gigante nao trava (o tokenizer e linear)", () => {
  const grande = "a !nome ".repeat(20_000);
  const inicio = Date.now();
  const r = substituirVariaveis(grande, VALORES);
  const ms = Date.now() - inicio;
  assert.ok(r.texto.includes("Maria Aparecida Souza"));
  assert.ok(ms < 3000, `substituicao levou ${ms}ms — devia ser linear`);
});

t("valor da variavel NAO e reinterpretado (nada de substituicao em cascata)", () => {
  // Um contato chamado "!telefone" (ou uma ficha vinda de importacao) nao pode
  // fazer a variavel virar outra variavel: `String.replace` com funcao nao
  // reprocessa a saida, e esta prova trava isso.
  const r = substituirVariaveis("Oi !nome", { nome: "!telefone $URA", telefone: "999", contexto: { URA: "MENU" } });
  assert.equal(r.texto, "Oi !telefone $URA");
});

t("chave normalizada de campo: acento, espaco, borda", () => {
  assert.equal(chaveNormalizadaDeCampo("Nome da Empresa"), "nome_da_empresa");
  assert.equal(chaveNormalizadaDeCampo("Endereço "), "endereco");
  assert.equal(chaveNormalizadaDeCampo("---"), "");
  assert.equal(chaveNormalizadaDeCampo(null), "");
  assert.equal(chaveNormalizadaDeCampo(7), "7");
});

t("primeiro nome e saudacao por hora", () => {
  assert.equal(primeiroNome("  Maria   Aparecida "), "Maria");
  assert.equal(primeiroNome(""), "");
  assert.equal(primeiroNome(null), "");
  assert.equal(saudacaoDaHora(5), "Bom dia");
  assert.equal(saudacaoDaHora(11), "Bom dia");
  assert.equal(saudacaoDaHora(12), "Boa tarde");
  assert.equal(saudacaoDaHora(17), "Boa tarde");
  assert.equal(saudacaoDaHora(18), "Boa noite");
  assert.equal(saudacaoDaHora(4), "Boa noite");
  assert.equal(saudacaoDaHora(NaN), "Boa tarde", "hora ilegivel nao quebra a saudacao");
});

t("propriedade desconhecida devolve null (e por isso fica literal no texto)", () => {
  assert.equal(valorDaProp("cpf", VALORES), null);
  assert.equal(valorDaProp("NOME", VALORES), "Maria Aparecida Souza", "prop e case-insensitive");
});

// ======================================================== 8) ARQUITETURA
console.log("\n8) guardas de arquitetura");

t("lib/fluxo/variaveis.ts nao importa NADA (roda em node solto)", () => {
  const src = readFileSync(new URL("../lib/fluxo/variaveis.ts", import.meta.url), "utf8");
  assert.equal(/^\s*import\s/m.test(src), false, "a lib de variaveis tem que continuar sem import");
  assert.equal(/require\(/.test(src), false);
});

t("a rota de respostas rapidas nao monta HTML nem executa DDL", () => {
  const src = readFileSync(new URL("../app/api/respostas-rapidas/route.ts", import.meta.url), "utf8");
  assert.equal(/dangerouslySetInnerHTML/.test(src), false);
  assert.equal(/create\s+table|alter\s+table|drop\s+table/i.test(src), false);
});

t("a rota resolve canal por canalDe (e por isso esta em CANAL_PADRAO_EM)", () => {
  // A varredura de scripts/prova-seguranca-conta.ts cobra a entrada EXATA na
  // tabela pra rota que resolve canal. Esta assercao e o lembrete no lugar certo:
  // se alguem tirar o canalDe daqui, a entrada da tabela vira verbete morto.
  const src = readFileSync(new URL("../app/api/respostas-rapidas/route.ts", import.meta.url), "utf8");
  assert.equal(/\bcanalDe\b/.test(src), true);
  const escopo = readFileSync(new URL("../lib/escopo-chave.ts", import.meta.url), "utf8");
  assert.ok(
    /\["\/api\/respostas-rapidas", \["GET"\]\]/.test(escopo),
    "falta a entrada de /api/respostas-rapidas (GET) em CANAL_PADRAO_EM"
  );
});

console.log(`\nPROVA DAS VARIAVEIS OK — ${feitos} casos\n`);
