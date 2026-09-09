// Prova das INTENCOES (NLU local) — card 86ak85nzr.
// Roda em Node >= 22.6 sem build: `node scripts/prova-intencoes.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// O que esta prova garante, em uma linha cada:
//   - a escala de pontos e a MEDIDA na ferramenta de origem (10 / 2 / 100, minimo 2);
//   - palavra-chave casa por PALAVRA, nunca por trecho ("nao" nao casa em "naotenho");
//   - a pontuacao minima decide, e intencao de minimo alto NAO dispara com palavra solta;
//   - conta SEM intencao funciona (NLU nunca e obrigatoria);
//   - intencao importada preserva palavras, frases e pontuacao;
//   - o reconhecimento e DETERMINISTICO e a ordem e estavel;
//   - nada consome API paga: a lib nao importa nada e o gancho externo nao e chamado;
//   - a condicao de fluxo `intencao` avalia como campo MULTIVALOR e fail-closed.
//
// FIXTURES SAO SINTETICAS no formato da origem — nenhum dado de cliente entra no
// repo (mesma regra das outras provas do modulo).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  combinarComExterno, intencoesReconhecidas, LIMIAR_SIMILARIDADE, LIMITE_TERMOS_POR_INTENCAO,
  LIMITE_TEXTO_ANALISADO, normalizarTexto, PONTOS_FRASE_EXATA, PONTOS_PALAVRA_CHAVE,
  PONTOS_SIMILARIDADE, PONTUACAO_MINIMA_PADRAO, pontuarIntencao, reconhecerIntencoes,
  similaridade, tokens, validarIntencao, type Intencao,
} from "../lib/fluxo/intencoes.ts";
import {
  avaliarCondicao, validarFluxo, validarCondicao, CAMPOS_CONDICAO, CAMPOS_CONDICAO_SO_DO_PAINEL,
} from "../lib/fluxo/schema.ts";

let feitos = 0;
const t = (nome: string, fn: () => void) => {
  fn();
  feitos++;
  console.log(`  ok  ${nome}`);
};

const criar = (bruto: unknown): Intencao => {
  const v = validarIntencao(bruto);
  assert.equal(v.ok, true, v.ok ? "" : v.erros.join(" | "));
  return (v as { ok: true; intencao: Intencao }).intencao;
};

// A intencao "Atendente" no MESMO formato da tela de origem (palavras e frases
// como aparecem la, sem dado de cliente).
const ATENDENTE = criar({
  id: "i1",
  nome: "Atendente",
  palavras_chave: ["atendente", "humano", "especialista", "atendimento", "pessoa"],
  frases: ["Falar com humano", "Quero atendimento humano", "Falar com especialista"],
});
const PARTICIPEI = criar({
  id: "i2",
  nome: "Participei",
  palavras_chave: ["participei", "sim", "fui"],
  frases: ["sim, consegui participar", "participei sim"],
  pontuacao_minima: 100,
});

// ==================================================== 1) A ESCALA DA ORIGEM
console.log("\n1) a escala de pontos e a MEDIDA na ferramenta de origem");

t("10 por palavra-chave, 100 por frase exata, 2 por frase parecida, minimo padrao 2", () => {
  // Escrito na propria tela de origem (lido do HTML capturado): "Palavra-Chave:
  // 10 pontos. Similaridade com Frase de exemplo: 2 pontos. Frase de exemplo
  // exata: 100 pontos." E o campo tem placeholder "Padrao: 2".
  assert.equal(PONTOS_PALAVRA_CHAVE, 10);
  assert.equal(PONTOS_FRASE_EXATA, 100);
  assert.equal(PONTOS_SIMILARIDADE, 2);
  assert.equal(PONTUACAO_MINIMA_PADRAO, 2);
});

t("uma palavra-chave = 10 pontos, e duas somam 20", () => {
  assert.equal(pontuarIntencao(ATENDENTE, "quero um atendente").pontos, PONTOS_PALAVRA_CHAVE);
  const duas = pontuarIntencao(ATENDENTE, "atendente e especialista");
  assert.equal(duas.pontos, 2 * PONTOS_PALAVRA_CHAVE, "a soma nao e limitada: e assim que a origem descreve");
  assert.deepEqual(duas.motivos.map((m) => m.termo), ["atendente", "especialista"]);
});

t("frase de exemplo IGUAL vale 100 (mesmo com caixa e acento diferentes)", () => {
  const r = pontuarIntencao(ATENDENTE, "  FALAR COM HUMANO!  ");
  const exata = r.motivos.find((m) => m.tipo === "frase_exata");
  assert.ok(exata, "a frase igual tem que pontuar como exata");
  assert.equal(exata!.pontos, PONTOS_FRASE_EXATA);
  // "humano" tambem e palavra-chave: as duas coisas pontuam, e e isso que a
  // escala da origem descreve
  assert.ok(r.pontos >= PONTOS_FRASE_EXATA);
});

t("frase PARECIDA vale 2, e o limiar esta declarado", () => {
  const so = criar({ id: "i3", nome: "So frase", frases: ["quero cancelar minha assinatura agora"] });
  const parecida = pontuarIntencao(so, "quero cancelar minha assinatura");
  assert.equal(parecida.pontos, PONTOS_SIMILARIDADE);
  assert.equal(parecida.motivos[0].tipo, "similaridade");
  // abaixo do limiar nao pontua
  assert.equal(pontuarIntencao(so, "quero saber o horario").pontos, 0);
  assert.equal(LIMIAR_SIMILARIDADE, 0.5, "o numero e NOSSO e esta declarado (a origem nao documenta)");
});

t("palavra de UMA letra nao infla similaridade", () => {
  const i = criar({ id: "i4", nome: "Curta", frases: ["a b c quero cancelar"] });
  // "a b c" apareceria em quase toda mensagem; sem o corte, qualquer texto
  // pontuaria por similaridade
  assert.equal(pontuarIntencao(i, "a b c").pontos, 0);
  assert.equal(similaridade("a b c quero cancelar", new Set(["a", "b", "c"])), 0);
});

// ======================================== 2) O QUE NAO PODE CASAR POR ACIDENTE
console.log("\n2) casamento por PALAVRA, nunca por trecho");

t('"nao" nao casa dentro de "naotenho" (nem "sim" dentro de "simples")', () => {
  const negativo = criar({ id: "i5", nome: "Negativo", palavras_chave: ["nao", "n"] });
  assert.equal(pontuarIntencao(negativo, "naotenho interesse").pontos, 0);
  assert.equal(pontuarIntencao(negativo, "nao tenho interesse").pontos, PONTOS_PALAVRA_CHAVE);
  assert.equal(pontuarIntencao(PARTICIPEI, "e simples assim").pontos, 0, '"sim" dentro de "simples" nao conta');
});

t("palavra-chave de VARIAS palavras casa pela sequencia, com fronteira", () => {
  const i = criar({ id: "i6", nome: "Segunda via", palavras_chave: ["segunda via"] });
  assert.equal(pontuarIntencao(i, "quero a segunda via do boleto").pontos, PONTOS_PALAVRA_CHAVE);
  assert.equal(pontuarIntencao(i, "segunda-feira via email").pontos, 0, "as duas palavras existem, a sequencia nao");
  // a sequencia aparece como TRECHO, e mesmo assim nao pode pontuar: sem fronteira
  // de palavra, quem pede "segunda via do boleto" e quem conta da "segunda
  // viagem" cairiam no mesmo fluxo
  assert.equal(pontuarIntencao(i, "marquei a segunda viagem").pontos, 0);
  assert.equal(pontuarIntencao(i, "segunda via").pontos, PONTOS_PALAVRA_CHAVE, "a mensagem inteira tambem casa");
});

t("acento, caixa e pontuacao nao atrapalham (uma normalizacao pros dois lados)", () => {
  const i = criar({ id: "i7", nome: "Nao participei", palavras_chave: ["não"], frases: ["não consegui entrar no evento"] });
  assert.equal(pontuarIntencao(i, "NAO, obrigado").pontos, PONTOS_PALAVRA_CHAVE);
  assert.equal(normalizarTexto("Não, consegui!"), "nao consegui");
  assert.deepEqual(tokens("Olá,  mundo!"), ["ola", "mundo"]);
});

t("catalogo em alfabeto NAO-LATINO tambem casa (o produto e instalado por qualquer cliente)", () => {
  // Uma classe ASCII (`[^a-z0-9]`) zeraria estes termos: a intencao nunca casaria
  // e ninguem descobriria por que — o campo continuaria preenchido na tela.
  const cirilico = criar({ nome: "Suporte RU", palavras_chave: ["помощь"], frases: ["нужна помощь"] });
  assert.equal(pontuarIntencao(cirilico, "Здравствуйте, нужна помощь!").reconhecida, true);
  const chines = criar({ nome: "Suporte ZH", palavras_chave: ["客服"] });
  assert.equal(pontuarIntencao(chines, "我要找 客服").pontos, PONTOS_PALAVRA_CHAVE);
  assert.deepEqual(tokens("нужна, помощь!"), ["нужна", "помощь"]);
});

t("texto vazio (ou que nao e texto) nao reconhece nada e nao quebra", () => {
  for (const bruto of ["", "   ", null, undefined, 42, {}, []]) {
    const r = pontuarIntencao(ATENDENTE, bruto as any);
    assert.equal(r.pontos, 0);
    assert.equal(r.reconhecida, false);
  }
});

// ================================================= 3) A PONTUACAO MINIMA
console.log("\n3) a pontuacao minima e quem decide");

t("minimo 100 (so frase exata) NAO dispara com palavra solta — o caso medido", () => {
  // Medido nos 33 backups: das 52 intencoes, 23 usam o minimo 2 e o resto vai de
  // 8 a 100. Uma intencao de minimo 100 configurada de proposito nao pode passar
  // a disparar com uma palavra qualquer — e o que aconteceria com outra escala.
  const so1 = pontuarIntencao(PARTICIPEI, "sim");
  assert.ok(so1.pontos >= PONTOS_PALAVRA_CHAVE, "a palavra 'sim' pontua");
  assert.ok(so1.pontos < PONTOS_FRASE_EXATA, "e continua longe do minimo 100");
  assert.equal(so1.reconhecida, false, "sem a frase exata a intencao nao dispara");

  const exata = pontuarIntencao(PARTICIPEI, "participei sim");
  assert.ok(exata.pontos >= PONTOS_FRASE_EXATA);
  assert.equal(exata.reconhecida, true);
});

t("minimo padrao 2: uma frase parecida ja reconhece", () => {
  const i = criar({ id: "i8", nome: "Preco", frases: ["quanto custa o plano mensal"] });
  assert.equal(i.pontuacao_minima, PONTUACAO_MINIMA_PADRAO);
  assert.equal(pontuarIntencao(i, "quanto custa o plano").reconhecida, true);
});

t("pontos ZERO nunca e 'reconhecida' — nem com minimo 1, nem com minimo 0", () => {
  const i = criar({ id: "i9", nome: "Zero", palavras_chave: ["xyz"], pontuacao_minima: 1 });
  const r = pontuarIntencao(i, "nada a ver");
  assert.equal(r.pontos, 0);
  assert.equal(r.reconhecida, false, "minimo 1 nao pode transformar 'nao achei nada' em reconhecida");

  // Minimo 0 nao passa por `validarIntencao` (que exige 1..1000) nem pelo CHECK da
  // 0022, MAS a pontuacao e usada como LIB por quem monta o objeto na mao — e uma
  // linha antiga, um patch de importacao, um teste de alguem. Com minimo 0 e sem a
  // guarda, "0 pontos" viraria "intencao reconhecida" e o fluxo dispararia em
  // TODA mensagem, inclusive nas que nao tem nada a ver.
  const naMao: Intencao = {
    id: "i9b", nome: "Minimo zero", palavras_chave: ["xyz"], frases: [], pontuacao_minima: 0, ativo: true,
  };
  assert.equal(pontuarIntencao(naMao, "nada a ver").reconhecida, false);
  assert.deepEqual(intencoesReconhecidas("nada a ver", [naMao]), []);
});

// ======================================================== 4) VALIDACAO
console.log("\n4) validacao: sem chute e sem intencao inutil no catalogo");

t("intencao SEM palavra e SEM frase e recusada", () => {
  const v = validarIntencao({ nome: "Vazia" });
  assert.equal(v.ok, false);
  assert.match((v as any).erros.join(" "), /palavra-chave ou uma frase/);
});

t("nome obrigatorio, e nome com espaco duplo e normalizado", () => {
  assert.equal(validarIntencao({ palavras_chave: ["x"] }).ok, false);
  assert.equal(criar({ nome: "  Falar   com   humano ", palavras_chave: ["x"] }).nome, "Falar com humano");
});

t("pontuacao minima ILEGIVEL e erro, nunca default em silencio", () => {
  const v = validarIntencao({ nome: "X", palavras_chave: ["x"], pontuacao_minima: "muito" });
  assert.equal(v.ok, false, "cair no default de 2 numa intencao de minimo 100 a faria disparar com palavra solta");
  assert.match((v as any).erros.join(" "), /pontuacao_minima/);
  assert.equal(validarIntencao({ nome: "X", palavras_chave: ["x"], pontuacao_minima: 0 }).ok, false);
  // AUSENTE (ou vazio, que e o que a tela de origem manda) cai no default
  assert.equal(criar({ nome: "X", palavras_chave: ["x"] }).pontuacao_minima, PONTUACAO_MINIMA_PADRAO);
  assert.equal(criar({ nome: "Y", palavras_chave: ["x"], pontuacao_minima: "" }).pontuacao_minima, PONTUACAO_MINIMA_PADRAO);
});

t("termo repetido (variando caixa/espaco) entra UMA vez", () => {
  const i = criar({ nome: "Dedupe", palavras_chave: ["Atendente", "atendente ", "ATENDENTE", "humano"] });
  assert.deepEqual(i.palavras_chave, ["Atendente", "humano"], "guardar os dois faria a palavra pontuar duas vezes");
  assert.equal(pontuarIntencao(i, "quero atendente").pontos, PONTOS_PALAVRA_CHAVE);
});

t("lixo na lista de termos nao vira termo, e o teto e respeitado", () => {
  const i = criar({
    nome: "Suja",
    palavras_chave: ["ok", "", "   ", null, 42, {}, "x".repeat(500)],
    frases: Array.from({ length: LIMITE_TERMOS_POR_INTENCAO + 50 }, (_, k) => `frase ${k}`),
  });
  assert.deepEqual(i.palavras_chave, ["ok", "x".repeat(120)], "lixo fora, e o termo comprido cortado no limite");
  assert.equal(i.frases.length, LIMITE_TERMOS_POR_INTENCAO);
});

// ================================================ 5) CATALOGO E ORDEM
console.log("\n5) catalogo: ordem estavel, desligada fora, conta vazia funciona");

t("CONTA SEM INTENCAO funciona — NLU nunca e obrigatoria (criterio de aceite)", () => {
  assert.deepEqual(reconhecerIntencoes("qualquer coisa", []), []);
  assert.deepEqual(intencoesReconhecidas("qualquer coisa", []), []);
});

t("intencao DESLIGADA nao entra nem pontuada", () => {
  const off = criar({ nome: "Desligada", palavras_chave: ["atendente"], ativo: false });
  const r = reconhecerIntencoes("quero atendente", [ATENDENTE, off]);
  assert.deepEqual(r.map((x) => x.nome), ["Atendente"]);
});

t("ordem DETERMINISTICA: pontos desc, empate pelo nome", () => {
  const a = criar({ id: "a", nome: "Zebra", palavras_chave: ["oi"] });
  const b = criar({ id: "b", nome: "Alfa", palavras_chave: ["oi"] });
  const c = criar({ id: "c", nome: "Muitos", palavras_chave: ["oi", "tudo", "bem"] });
  const r = reconhecerIntencoes("oi, tudo bem", [a, b, c]);
  assert.deepEqual(r.map((x) => x.nome), ["Muitos", "Alfa", "Zebra"]);
  // duas chamadas seguidas dao a MESMA ordem (ordem instavel faria o mesmo texto
  // disparar fluxos diferentes)
  assert.deepEqual(reconhecerIntencoes("oi, tudo bem", [a, b, c]).map((x) => x.nome), r.map((x) => x.nome));
});

t("intencoesReconhecidas devolve so as que bateram o minimo", () => {
  assert.deepEqual(intencoesReconhecidas("quero atendente", [ATENDENTE, PARTICIPEI]), ["Atendente"]);
  assert.deepEqual(intencoesReconhecidas("participei sim", [ATENDENTE, PARTICIPEI]), ["Participei"]);
});

// ============================================== 6) IMPORTACAO PRESERVA
console.log("\n6) intencao importada preserva palavras, frases e pontuacao");

t("o formato que o importador monta sobrevive a validacao, sem perda", () => {
  // no formato exato que scripts/importar/intencoes.mjs produz
  const bruta = {
    nome: "Nao_participei",
    palavras_chave: ["não", "negativo", "no", "nops", "n", "nao"],
    frases: ["não consegui", "não deu", "nao rolou"],
    pontuacao_minima: 20,
  };
  const i = criar(bruta);
  assert.equal(i.pontuacao_minima, 20, "a pontuacao configurada na origem NAO pode cair no default");
  assert.deepEqual(i.frases, bruta.frases, "as frases entram como estao (acento incluido)");
  // "não" e "nao" sao o MESMO termo depois de normalizar: entra uma vez
  assert.deepEqual(i.palavras_chave, ["não", "negativo", "no", "nops", "n"]);
  assert.equal(pontuarIntencao(i, "nao deu").reconhecida, true);
});

// ============================== 7) CONDICAO DE FLUXO (a ligacao com o epico 4)
console.log("\n7) a intencao como CONDICAO de fluxo");

t("`intencao` e campo de condicao valido e multivalor", () => {
  assert.ok((CAMPOS_CONDICAO as readonly string[]).includes("intencao"));
  const v = validarCondicao({ tipo: "comparacao", campo: "intencao", operador: "igual", valor: "Atendente" });
  assert.equal(v.ok, true);
  const c = (v as any).condicao;
  // casa por EXISTENCIA no positivo
  assert.equal(avaliarCondicao(c, { intencoes: ["Participei", "Atendente"] }), true);
  assert.equal(avaliarCondicao(c, { intencoes: ["Participei"] }), false);
});

t("`intencao` NAO e campo so-do-painel: ela sai do TEXTO recebido", () => {
  // Se entrasse em CAMPOS_CONDICAO_SO_DO_PAINEL, um fluxo de GATILHO com condicao
  // de intencao seria recusado pelo validador — e gatilho por intencao e
  // exatamente o uso do card.
  assert.equal((CAMPOS_CONDICAO_SO_DO_PAINEL as readonly string[]).includes("intencao"), false);
  const r = validarFluxo({
    id: "g",
    nome: "Gatilho por intencao",
    tipo: "gatilho",
    versao: 1,
    nos: [
      {
        id: "n1",
        tipo: "condicao",
        condicao: { tipo: "comparacao", campo: "intencao", operador: "igual", valor: "Atendente" },
        proximo: "n2",
      },
      { id: "n2", tipo: "acao", acao: { tipo: "mudar_status", status: "atendimento" } },
    ],
  });
  assert.equal(r.ok, true, r.ok ? "" : (r as any).erros.join(" | "));
});

t("fail-closed: campo AUSENTE derruba comparacao de valor", () => {
  const c = (validarCondicao({ tipo: "comparacao", campo: "intencao", operador: "igual", valor: "Atendente" }) as any)
    .condicao;
  assert.equal(avaliarCondicao(c, {}), false, "ninguem reconheceu nada: a condicao nao pode dar verdadeiro");
  const dif = (
    validarCondicao({ tipo: "comparacao", campo: "intencao", operador: "diferente", valor: "Atendente" }) as any
  ).condicao;
  assert.equal(avaliarCondicao(dif, {}), false, "`diferente` tambem e fail-closed (regra 2 do avaliador)");
  const existe = (validarCondicao({ tipo: "comparacao", campo: "intencao", operador: "existe" }) as any).condicao;
  assert.equal(avaliarCondicao(existe, { intencoes: [] }), false);
  assert.equal(avaliarCondicao(existe, { intencoes: ["Atendente"] }), true);
});

t("negativo casa por AUSENCIA (como pessoa le 'nao pediu atendente')", () => {
  const c = (
    validarCondicao({ tipo: "comparacao", campo: "intencao", operador: "nao_contem", valor: "atendente" }) as any
  ).condicao;
  assert.equal(avaliarCondicao(c, { intencoes: ["Participei"] }), true);
  assert.equal(avaliarCondicao(c, { intencoes: ["Atendente"] }), false);
});

t("um fluxo com condicao de intencao valida pelo portao unico", () => {
  const r = validarFluxo({
    id: "f",
    nome: "Encaminha pra humano",
    tipo: "macro",
    versao: 1,
    nos: [
      {
        id: "n1",
        tipo: "condicao",
        condicao: { tipo: "comparacao", campo: "intencao", operador: "igual", valor: "Atendente" },
        proximo: "n2",
      },
      { id: "n2", tipo: "acao", acao: { tipo: "mudar_status", status: "atendimento" } },
    ],
  });
  assert.equal(r.ok, true, r.ok ? "" : (r as any).erros.join(" | "));
});

// =========================================== 8) NADA DE API PAGA, E O GANCHO
console.log("\n8) o gancho de IA existe DECLARADO e nao e chamado");

t("a lib de intencoes nao importa NADA (nem rede, nem chave, nem banco)", () => {
  const src = readFileSync(new URL("../lib/fluxo/intencoes.ts", import.meta.url), "utf8");
  assert.equal(/^\s*import\s/m.test(src), false, "a lib tem que continuar sem import");
  assert.equal(/fetch\(|process\.env|require\(/.test(src), false, "nem fetch, nem env, nem require");
});

t("nenhum arquivo desta frente chama servico de IA por conta propria", () => {
  for (const rel of [
    "../lib/fluxo/intencoes.ts",
    "../lib/fluxo/intencoes-db.ts",
    "../app/api/intencoes/route.ts",
  ]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.equal(
      /api\.openai|anthropic|api\.anthropic|generativelanguage|gpt-|OPENAI_API_KEY|ANTHROPIC_API_KEY/i.test(src),
      false,
      `${rel}: regra dura da casa — nada de API paga por conta propria`
    );
    assert.equal(/create\s+table|alter\s+table|drop\s+table/i.test(src), false, `${rel}: codigo nao cria tabela`);
  }
});

// quanto "sim" vale LOCALMENTE contra a intencao de minimo 100
const BASE_SIM = reconhecerIntencoes("sim", [PARTICIPEI])[0].pontos;

t("o classificador externo SOMA pontos e nao contorna a pontuacao minima", () => {
  assert.equal(reconhecerIntencoes("sim", [PARTICIPEI])[0].reconhecida, false, `${BASE_SIM} pontos, minimo 100`);
  const pouco = combinarComExterno(reconhecerIntencoes("sim", [PARTICIPEI]), [{ id: "i2", pontos: 50 }]);
  assert.equal(pouco[0].pontos, BASE_SIM + 50);
  assert.equal(pouco[0].reconhecida, false, "ainda nao alcanca 100: o portao continua sendo o minimo da intencao");
  const muito = combinarComExterno(reconhecerIntencoes("sim", [PARTICIPEI]), [{ id: "i2", pontos: 95, motivo: "IA" }]);
  assert.equal(muito[0].reconhecida, true);
  assert.ok(muito[0].motivos.some((m) => m.termo === "IA"), "o motivo do externo fica visivel");
});

t("ponto externo de intencao FORA do catalogo e ignorado", () => {
  const r = combinarComExterno(reconhecerIntencoes("sim", [PARTICIPEI]), [
    { id: "inventada", pontos: 999 },
    { id: "i2", pontos: -5 },
    { id: "i2", pontos: NaN as any },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].pontos, BASE_SIM, "servico que inventa rotulo (ou ponto torto) nao muda nada");
  assert.equal(r[0].reconhecida, false);
});

// ============================================================ 9) HOSTIL
console.log("\n9) mensagem hostil: teto e custo");

t("texto gigante e cortado no teto e nao trava o servidor", () => {
  const gigante = "atendente ".repeat(50_000);
  const inicio = Date.now();
  const r = pontuarIntencao(ATENDENTE, gigante);
  const ms = Date.now() - inicio;
  assert.equal(normalizarTexto(gigante).length <= LIMITE_TEXTO_ANALISADO, true);
  assert.ok(r.pontos > 0);
  assert.ok(ms < 2000, `pontuar levou ${ms}ms`);
});

t("catalogo grande com texto grande continua barato", () => {
  const catalogo = Array.from({ length: 200 }, (_, k) =>
    criar({ id: `g${k}`, nome: `Intencao ${k}`, palavras_chave: [`termo${k}`, "atendente"] })
  );
  const inicio = Date.now();
  const r = reconhecerIntencoes("x ".repeat(2000) + " atendente", catalogo);
  const ms = Date.now() - inicio;
  assert.equal(r.length, 200);
  assert.ok(ms < 2000, `catalogo de 200 levou ${ms}ms`);
});

t("termo que vira vazio depois de normalizar nao pontua com tudo", () => {
  // um termo feito so de pontuacao normalizaria pra "" — e trecho "" casaria com
  // QUALQUER mensagem (a mesma armadilha do `contem ""` da condicao)
  const i = criar({ nome: "So pontuacao", palavras_chave: ["ok"], frases: ["!!!", "???"] });
  assert.equal(i.frases.length, 0, "termo que normaliza pra vazio nem entra no catalogo");
  assert.equal(pontuarIntencao(i, "qualquer coisa").pontos, 0);
});

console.log(`\nPROVA DAS INTENCOES OK — ${feitos} casos\n`);
