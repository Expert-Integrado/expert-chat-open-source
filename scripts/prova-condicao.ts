// Prova da CONDICAO como estrutura, do ANALISADOR da linguagem do ChatGuru e do
// CONTEXTO da conversa (cards 86ak859v7 e 86ak859vt).
// Roda em Node >= 22.6 sem build: `node scripts/prova-condicao.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// FIXTURES SAO SINTETICAS. As expressoes daqui imitam a SINTAXE medida no
// acervo real, com nomes e valores inventados. Condicao de dialogo de cliente
// NUNCA vira fixture do repo — o exercicio contra o acervo de verdade e o DRY
// RUN do conversor, que le os backups fora do repo e sai em contagem.
import assert from "node:assert/strict";
import {
  avaliarCondicao, camposDaCondicao, chaveDeContexto, chavesDeContextoDoFluxo,
  CAMPOS_SUJOS_POR_ACAO, LIMITE_PROFUNDIDADE_CONDICAO, LIMITE_TERMOS_CONDICAO, LIMITE_VALOR_CONDICAO,
  motivoParaRecusarPuro, percorrerMacro,
  normalizarContexto, validarCondicao, validarFluxo,
  type Condicao, type FatosConversa, type Fluxo,
} from "../lib/fluxo/schema.ts";
import { analisarCondicao, condicaoDeContextoDeEntrada, LIMITE_TOKENS } from "./fluxo/parser-condicao-chatguru.mjs";
import {
  converterDialogo, semCondicaoDeEntrada,
  MARCA_RESSALVA_ASSURE, MARCA_RESSALVA_CONTEXTO_INERTE,
} from "./fluxo/converter-chatguru.mjs";

const cmp = (campo: string, operador: string, extra: any = {}): any => ({ tipo: "comparacao", campo, operador, ...extra });

// ====================================================== 1) SCHEMA DA CONDICAO
// 1.1 comparacao valida de cada campo
{
  for (const c of [
    cmp("texto", "contem", { valor: "promo" }),
    cmp("status", "igual", { valor: "aberto" }),
    cmp("etiqueta", "igual", { valor: "VIP" }),
    cmp("contexto", "igual", { chave: "URA", valor: "MENU" }),
    cmp("contexto", "existe", { chave: "URA" }),
    cmp("etapa", "igual", { funil: "Vendas", valor: "Fechamento" }),
  ]) {
    assert.equal(validarCondicao(c).ok, true, `esperava valida: ${JSON.stringify(c)}`);
  }
}

// 1.2 recusas — cada uma e um jeito de a condicao estar errada
const recusa = (bruto: unknown, trecho: string) => {
  const r = validarCondicao(bruto);
  assert.equal(r.ok, false, `esperava recusa por "${trecho}"`);
  const erros = (r as { ok: false; erros: string[] }).erros.join(" | ");
  assert.ok(erros.includes(trecho), `erro deveria citar "${trecho}", veio: ${erros}`);
};
recusa(null, "condicao precisa ser um objeto");
recusa({ tipo: "talvez" }, "tipo de condicao desconhecido");
recusa(cmp("telefone", "igual", { valor: "x" }), "campo de condicao desconhecido");
recusa(cmp("texto", "parece_com", { valor: "x" }), "operador de condicao desconhecido");
// contexto SEM chave nao e condicao: e pergunta sem sujeito
recusa(cmp("contexto", "igual", { valor: "x" }), "condicao de contexto precisa de chave");
// etapa por nome SOLTO seria chute (nome de etapa se repete entre funis)
recusa(cmp("etapa", "igual", { valor: "Fechamento" }), "condicao de etapa precisa do nome do FUNIL");
// `chave` tem DOIS donos desde a Frente X: `contexto` (variavel da conversa) e
// `ficha` (campo personalizado do contato). A mensagem foi atualizada junto —
// dizer "so contexto" com a ficha usando chave mandaria quem monta condicao
// procurar defeito onde nao ha.
recusa(cmp("texto", "igual", { chave: "x", valor: "y" }), "so condicao de contexto e de ficha usam chave");
recusa(cmp("texto", "igual", { funil: "x", valor: "y" }), "so condicao de etapa usa funil");
recusa(cmp("texto", "existe", { valor: "x" }), "operador existe nao leva valor");
recusa(cmp("texto", "igual", {}), "operador igual precisa de valor");
recusa(cmp("texto", "igual", { valor: "   " }), "use o operador existe/nao_existe");
recusa(cmp("texto", "igual", { valor: "x".repeat(LIMITE_VALOR_CONDICAO + 1) }), "valor de condicao acima de");
recusa({ tipo: "e", condicoes: [] }, 'condicao "e" sem lista');
recusa({ tipo: "nao", condicao: { tipo: "comparacao" } }, "campo de condicao desconhecido");

// 1.3 HOSTIL — arvore fundo demais estoura a pilha do avaliador, entao o schema
// para antes. (LIMITE+2 pra nao depender do off-by-one do contador.)
{
  let fundo: any = cmp("texto", "igual", { valor: "x" });
  for (let i = 0; i < LIMITE_PROFUNDIDADE_CONDICAO + 2; i++) fundo = { tipo: "nao", condicao: fundo };
  recusa(fundo, "niveis de aninhamento");
  // e o que cabe no limite continua valendo
  let ok: any = cmp("texto", "igual", { valor: "x" });
  for (let i = 0; i < 5; i++) ok = { tipo: "nao", condicao: ok };
  assert.equal(validarCondicao(ok).ok, true, "aninhamento dentro do limite e valido");
}

// 1.3b HOSTIL — teto de COMPARACOES vale pra arvore inteira, nao por ramo.
// (Isto ja foi codigo morto: cada recursao recebia um contador novo, e uma
// arvore com 500 comparacoes passava batido.)
{
  const muitas = (n: number) => ({
    tipo: "e",
    condicoes: Array.from({ length: n }, (_, i) => cmp("texto", "igual", { valor: `v${i}` })),
  });
  recusa(muitas(LIMITE_TERMOS_CONDICAO + 300), "condicao com mais de");
  assert.equal(validarCondicao(muitas(LIMITE_TERMOS_CONDICAO)).ok, true, "no limite exato ainda vale");
  // e o teto conta o TOTAL, mesmo espalhado em ramos rasos
  recusa(
    { tipo: "ou", condicoes: [muitas(LIMITE_TERMOS_CONDICAO - 1), muitas(LIMITE_TERMOS_CONDICAO - 1)] },
    "condicao com mais de"
  );
}

// 1.3c valor que normaliza pra VAZIO seria `contem ""` — que casa com qualquer
// texto, ou seja, a condicao viraria sempre-verdadeira
{
  const soMarcas = "\u0301\u0302"; // acentos combinantes soltos
  assert.notEqual(soMarcas.trim(), "", "o valor NAO e vazio antes de normalizar");
  recusa(cmp("texto", "contem", { valor: soMarcas }), "valor vazio — use o operador existe");
}

// 1.4 HOSTIL — valor com cara de injecao continua sendo TEXTO, nunca comando
{
  const veneno = "'); delete from mensageria.conversas; --";
  const r = validarCondicao(cmp("contexto", "igual", { chave: "x", valor: veneno }));
  assert.equal(r.ok, true, "valor estranho e valor, nao erro");
  assert.equal((r as any).condicao.valor, veneno, "o valor entra literal, sem interpretacao");
  // e ele so casa com um fato IGUAL a ele — nao vira coringa
  assert.equal(avaliarCondicao((r as any).condicao, { contexto: { x: veneno } }), true);
  assert.equal(avaliarCondicao((r as any).condicao, { contexto: { x: "qualquer" } }), false);
}

// ========================================================== 2) AVALIADOR
const fatos: FatosConversa = {
  texto: "Quero o Catálogo de Preços",
  status: "aberto",
  etiquetas: ["VIP", "Lead frio"],
  contexto: { URA: "MENU", etapa_menu: "2" },
  etapas: [{ funil: "Vendas", etapa: "Fechamento" }],
};
const av = (c: any, f: FatosConversa = fatos) => {
  const r = validarCondicao(c);
  assert.equal(r.ok, true, "condicao da prova precisa ser valida: " + (r.ok ? "" : (r as any).erros.join(" | ")));
  return avaliarCondicao((r as any).condicao, f);
};

// 2.1 cada campo
assert.equal(av(cmp("texto", "igual", { valor: "Quero o Catálogo de Preços" })), true);
assert.equal(av(cmp("texto", "contem", { valor: "catalogo" })), true, "ignora caixa e acento");
assert.equal(av(cmp("texto", "comeca_com", { valor: "quero" })), true);
assert.equal(av(cmp("texto", "contem", { valor: "boleto" })), false);
assert.equal(av(cmp("status", "igual", { valor: "aberto" })), true);
assert.equal(av(cmp("status", "diferente", { valor: "concluido" })), true);
assert.equal(av(cmp("contexto", "igual", { chave: "URA", valor: "menu" })), true);
assert.equal(av(cmp("contexto", "existe", { chave: "URA" })), true);
assert.equal(av(cmp("contexto", "nao_existe", { chave: "URA" })), false);

// 2.2 campo com VARIOS valores: positivo casa por existencia, negativo por ausencia
assert.equal(av(cmp("etiqueta", "igual", { valor: "VIP" })), true);
assert.equal(av(cmp("etiqueta", "igual", { valor: "Cliente" })), false);
assert.equal(av(cmp("etiqueta", "diferente", { valor: "Cliente" })), true, "nenhuma etiqueta e Cliente");
assert.equal(av(cmp("etiqueta", "diferente", { valor: "VIP" })), false, "uma delas E VIP");
assert.equal(av(cmp("etiqueta", "contem", { valor: "frio" })), true);

// 2.3 etapa e SEMPRE dentro do funil informado
assert.equal(av(cmp("etapa", "igual", { funil: "Vendas", valor: "Fechamento" })), true);
assert.equal(av(cmp("etapa", "igual", { funil: "Suporte", valor: "Fechamento" })), false, "mesmo nome, outro funil");
assert.equal(av(cmp("etapa", "existe", { funil: "Vendas" })), true);
assert.equal(av(cmp("etapa", "existe", { funil: "Suporte" })), false);

// 2.4 FAIL-CLOSED: campo ausente derruba QUALQUER comparacao de valor
{
  const vazio: FatosConversa = {};
  assert.equal(av(cmp("texto", "igual", { valor: "x" }), vazio), false);
  assert.equal(av(cmp("texto", "diferente", { valor: "x" }), vazio), false, "diferente tambem e false sem fato");
  assert.equal(av(cmp("texto", "nao_contem", { valor: "x" }), vazio), false);
  assert.equal(av(cmp("contexto", "igual", { chave: "URA", valor: "x" }), vazio), false);
  assert.equal(av(cmp("etiqueta", "diferente", { valor: "x" }), vazio), false);
  // ... menos as que FALAM de presenca
  assert.equal(av(cmp("contexto", "nao_existe", { chave: "URA" }), vazio), true);
  assert.equal(av(cmp("contexto", "existe", { chave: "URA" }), vazio), false);
  // ... e o `nao` continua sendo a saida: ele nega o RESULTADO
  assert.equal(av({ tipo: "nao", condicao: cmp("contexto", "igual", { chave: "URA", valor: "x" }) }, vazio), true);
  // texto vazio/so espaco conta como AUSENTE (senao "" casaria com contem "")
  assert.equal(av(cmp("texto", "existe", { valor: undefined }), { texto: "   " }), false);
}

// 2.5 matriz E / OU / NAO
{
  const V = cmp("status", "igual", { valor: "aberto" }); // verdadeira nestes fatos
  const F = cmp("status", "igual", { valor: "concluido" }); // falsa
  assert.equal(av({ tipo: "e", condicoes: [V, V] }), true);
  assert.equal(av({ tipo: "e", condicoes: [V, F] }), false);
  assert.equal(av({ tipo: "e", condicoes: [F, F] }), false);
  assert.equal(av({ tipo: "ou", condicoes: [V, F] }), true);
  assert.equal(av({ tipo: "ou", condicoes: [F, F] }), false);
  assert.equal(av({ tipo: "nao", condicao: F }), true);
  assert.equal(av({ tipo: "nao", condicao: V }), false);
  assert.equal(av({ tipo: "nao", condicao: { tipo: "ou", condicoes: [F, F] } }), true);
  // aninhado: (V e (F ou V)) e nao F
  assert.equal(
    av({ tipo: "e", condicoes: [{ tipo: "e", condicoes: [V, { tipo: "ou", condicoes: [F, V] }] }, { tipo: "nao", condicao: F }] }),
    true
  );
}

// 2.6 camposDaCondicao: o motor so busca no banco o fato que a condicao usa
{
  const c = validarCondicao({
    tipo: "e",
    condicoes: [cmp("contexto", "igual", { chave: "a", valor: "1" }), { tipo: "nao", condicao: cmp("etiqueta", "igual", { valor: "x" }) }],
  }) as any;
  assert.deepEqual([...camposDaCondicao(c.condicao)].sort(), ["contexto", "etiqueta"]);
}

// ==================================================== 3) ANALISADOR CHATGURU
// Fixtures SINTETICAS na sintaxe medida (nomes e valores inventados).
const analisa = (txt: string) => analisarCondicao(txt);
const arvore = (txt: string) => {
  const a = analisa(txt);
  assert.notEqual(a.estado, "nao", `esperava converter "${txt}", veio: ${a.motivo}`);
  const v = validarCondicao(a.condicao);
  assert.equal(v.ok, true, `o analisador tem que produzir condicao VALIDA; veio: ${v.ok ? "" : (v as any).erros.join(" | ")}`);
  return a;
};

// 3.1 os casos dominantes do acervo
assert.deepEqual(arvore("$URA=='MENU'").condicao, cmp("contexto", "igual", { chave: "URA", valor: "MENU" }));
assert.deepEqual(arvore("not $lista=='saiu'").condicao, {
  tipo: "nao",
  condicao: cmp("contexto", "igual", { chave: "lista", valor: "saiu" }),
});
assert.deepEqual(arvore("!text=='oi'").condicao, cmp("texto", "igual", { valor: "oi" }));
assert.deepEqual(arvore("!status=='ABERTO'").condicao, cmp("status", "igual", { valor: "aberto" }));
assert.deepEqual(arvore("$x!='1'").condicao, cmp("contexto", "diferente", { chave: "x", valor: "1" }));

// 3.2 a expressao chega QUEBRADA EM LINHAS com indentacao (e um textarea de HTML)
{
  const a = arvore("$URA=='MENU'\n                    and\n                    $etapa=='2'");
  assert.equal((a.condicao as any).tipo, "e");
  assert.equal((a.condicao as any).condicoes.length, 2);
}

// 3.3 nome de variavel com espaco, hifen e acento (existe no acervo)
assert.equal((arvore("$Reserva confirmada=='sim'").condicao as any).chave, "Reserva confirmada");
assert.equal((arvore("$QC-IM=='aluno'").condicao as any).chave, "QC-IM");
assert.equal((arvore("$Categoria_Aluno=='sim'").condicao as any).chave, "Categoria_Aluno");

// 3.4 precedencia e parenteses
{
  // sem parenteses: `and` mais forte que `or` -> ou(a, e(b,c)) — e ISSO gera ressalva
  const a = arvore("$a=='1' or $b=='2' and $c=='3'");
  assert.equal((a.condicao as any).tipo, "ou");
  assert.equal((a.condicao as any).condicoes[1].tipo, "e");
  assert.equal(a.estado, "ressalva");
  assert.ok(a.ressalvas.some((x: string) => x.includes("mistura `and` e `or` sem parenteses")));
  // com parenteses: a estrutura e a que esta escrita, e nao ha ressalva
  const b = arvore("( $a=='1' or $b=='2' ) and $c=='3'");
  assert.equal((b.condicao as any).tipo, "e");
  assert.equal((b.condicao as any).condicoes[0].tipo, "ou");
  assert.equal(b.estado, "convertida");
  // so `and` ou so `or` no mesmo nivel nao e mistura
  assert.equal(analisa("$a=='1' and $b=='2' and $c=='3'").estado, "convertida");
}

// 3.5 aninhamento de verdade (o acervo chega a 3 niveis)
{
  const a = arvore("( ( $a=='1' or $b=='2' ) and ( $c=='3' or $d=='4' ) ) and !text=='x'");
  assert.equal((a.condicao as any).tipo, "e");
}

// 3.6 ressalvas que existem porque a semantica NAO e identica
{
  const a = arvore("!word=='promo'");
  assert.deepEqual(a.condicao, cmp("texto", "contem", { valor: "promo" }));
  assert.ok(a.ressalvas.some((x: string) => x.includes("procura a PALAVRA")), "!word vira contem, e isso e avisado");
  const b = arvore("!status=='FECHADO'");
  assert.deepEqual(b.condicao, cmp("status", "igual", { valor: "concluido" }));
  assert.ok(b.ressalvas.some((x: string) => x.includes("5 status")));
  // ARMADILHA: no ChatGuru variavel nao definida compara igual a 'False'/'None'
  const c = arvore("$URA=='False'");
  assert.equal(c.estado, "ressalva");
  assert.ok(c.ressalvas.some((x: string) => x.includes("nao definida compara igual")));
  assert.ok(arvore("$URA=='None'").ressalvas.length > 0, "'None' cai na mesma armadilha");
}

// 3.7 o que NAO converte — e por que. Conversao e tudo ou nada: um termo sem
// equivalente derruba a expressao INTEIRA (descartar termo mudaria quando a
// automacao dispara, em silencio).
const naoConverte = (txt: string, trecho: string) => {
  const a = analisa(txt);
  assert.equal(a.estado, "nao", `esperava recusa de "${txt}"`);
  assert.ok(a.motivo.includes(trecho), `motivo deveria citar "${trecho}", veio: ${a.motivo}`);
  assert.equal(a.condicao, undefined, "recusada nao produz condicao");
};
naoConverte("!current_time>='18:00'", "HORA do dia");
naoConverte("!saturday", "DIA DA SEMANA");
naoConverte("!missed_call", "CHAMADA PERDIDA");
naoConverte("!msg_image", "TIPO DE MIDIA");
naoConverte("!number_starts_with=='5511'", "PREFIXO DO TELEFONE");
naoConverte("!inventada=='x'", "desconhecida no vocabulario medido");
naoConverte("#Atendente", "sem equivalente conhecido");
naoConverte("@CampoDoContato=='True'", "campo personalizado");
naoConverte("anything_else", "curinga");
naoConverte("$x=='1' and anything_else", "curinga");
// UM termo bom + UM ruim = expressao inteira recusada (a regra-mae)
naoConverte("$URA=='MENU' and !current_time<='08:00'", "HORA do dia");
naoConverte("$URA=='MENU' or !missed_call", "CHAMADA PERDIDA");
// operador de ordem em campo que a v1 tem: recusa em vez de virar igualdade
naoConverte("$idade>='18'", "compara contexto so por igualdade");
naoConverte("!text<='x'", "so compara igualdade nesse campo");
naoConverte("!status=='INVENTADO'", "nao existe no painel");
naoConverte("$semOperador", "sem comparacao");

// 3.8 sintaxe malformada QUE EXISTE NO ACERVO — recusa com motivo, nunca chute
naoConverte("not and $x=='1'", "`not` sem termo");
naoConverte("$x=='1' and", "terminou no meio");
naoConverte("( $x=='1'", "parentese aberto e nunca fechado");
naoConverte("$x=='1' )", "sobrou termo");
naoConverte("$x=='1' $y=='2'", "sobrou termo");
naoConverte("and $x=='1'", "sem termo a esquerda");
naoConverte("'valor solto'", "valor solto");
naoConverte("$x=='aberto", "aspas simples aberta e nunca fechada");
naoConverte("$x==", "sem valor a direita");
naoConverte("$", "referencia vazia");
naoConverte("", "condicao vazia");

// 3.9 HOSTIL — entrada de terceiro nao derruba nem engana o analisador
{
  // injecao: o conteudo entre aspas e VALOR, nunca sintaxe
  const a = arvore("$x=='  ); drop table conversas; --  '");
  assert.equal((a.condicao as any).valor, "  ); drop table conversas; --  ");
  // uma expressao que finge ser duas
  const b = arvore("$x=='1 and $admin==2'");
  assert.equal((b.condicao as any).tipo, "comparacao", "o `and` dentro das aspas nao vira conectivo");
  // aninhamento fundo demais: recusa, nao estouro de pilha
  naoConverte("(".repeat(60) + "$x=='1'" + ")".repeat(60), "niveis de parenteses");
  // expressao gigante: recusa por teto de termos, sem travar
  naoConverte(Array.from({ length: LIMITE_TOKENS }, () => "$x=='1'").join(" and "), "termos");
  // valor gigante: o analisador ESPELHA o teto do schema e recusa com o motivo
  // na expressao de origem (antes ele convertia e a recusa saia longe, no
  // validarFluxo — diagnostico distante de quem consegue consertar)
  naoConverte(`$x=='${"a".repeat(LIMITE_VALOR_CONDICAO + 10)}'`, `valor com mais de ${LIMITE_VALOR_CONDICAO} caracteres`);
  // chave de contexto acima do teto do schema, mesma logica
  naoConverte(`$${"n".repeat(150)}=='1'`, "nome de variavel de contexto com mais de");
  // nome de referencia absurdo e recusa de SINTAXE (a varredura tem teto proprio)
  naoConverte(`$${"n".repeat(400)}=='1'`, "nome de referencia acima de");
  // e o valor que CABE segue convertendo
  assert.equal(analisa(`$x=='${"a".repeat(LIMITE_VALOR_CONDICAO)}'`).estado, "convertida");

  // COMPARACOES: 400 `and` dao profundidade 2 e estouravam o teto de termos do
  // schema — o analisador dizia "convertida" e a recusa vinha depois, longe
  naoConverte(Array.from({ length: 400 }, (_, i) => `$x=='${i}'`).join(" and "), "comparacoes (o teto e");
  assert.equal(
    analisa(Array.from({ length: 100 }, (_, i) => `$x=='${i}'`).join(" and ")).estado,
    "convertida",
    "100 comparacoes cabem"
  );

  // profundidade da ARVORE CANONICA (nao a dos parenteses): `not` empilhado fica
  // fundo sem um parentese sequer, e o analisador recusa antes de o schema ver
  naoConverte("not ".repeat(20) + "$x=='1'", "niveis na arvore canonica");
  assert.equal(analisa("not ".repeat(5) + "$x=='1'").estado, "convertida", "aninhamento dentro do teto vale");

  // VARREDURA LINEAR: esta expressao levava ~21s (a busca do nome de referencia
  // era quadratica — slice+split a cada espaco). Teto generoso pra nao falhar
  // por maquina lenta, mas 32 mil espacos nao podem custar segundos.
  {
    const t0 = Date.now();
    const r = analisa(`$x${" ".repeat(32000)}=='1'`);
    const ms = Date.now() - t0;
    assert.equal(r.estado, "convertida");
    assert.ok(ms < 2000, `32 mil espacos levaram ${ms}ms — a varredura voltou a ser quadratica?`);
  }
}

// 3.10 condicao de ENTRADA por variavel (o filtro simples do cabecalho)
{
  assert.equal(condicaoDeContextoDeEntrada("", "x"), null, "sem nome nao ha condicao");
  const a = condicaoDeContextoDeEntrada("URA", "MENU");
  assert.deepEqual(a.condicao, cmp("contexto", "igual", { chave: "URA", valor: "MENU" }));
  assert.equal(a.estado, "convertida");
  // nome sem valor = "a variavel precisa estar definida"
  assert.deepEqual(condicaoDeContextoDeEntrada("URA", "").condicao, cmp("contexto", "existe", { chave: "URA" }));
  assert.equal(condicaoDeContextoDeEntrada("URA", "False").estado, "ressalva", "'False' cai na armadilha do nao-definido");
}

// ======================================================== 4) CONTEXTO
// 4.1 chave e IDENTIFICADOR: a mesma normalizacao vale pra acao e pra condicao
assert.equal(chaveDeContexto("  URA  "), "URA", "trima");
assert.equal(chaveDeContexto("URA"), "URA");
assert.equal(chaveDeContexto("Reserva confirmada"), "Reserva confirmada", "espaco no meio e legitimo");
assert.equal(chaveDeContexto(""), null);
assert.equal(chaveDeContexto("   "), null);
assert.equal(chaveDeContexto("a".repeat(200)), null);
assert.equal(chaveDeContexto("URA\nadmin"), null, "quebra de linha nao entra em chave");
assert.equal(chaveDeContexto(42 as any), null);

// 4.2 leitura do jsonb: valor de contexto e sempre TEXTO
// (o mapa sai SEM prototipo — ver 4.4 — entao a comparacao e por entradas)
const entradas = (m: Record<string, string>) => Object.entries(m).sort();
assert.deepEqual(entradas(normalizarContexto({ a: "1", b: 2, c: true, d: null, e: { x: 1 }, f: ["y"] })), [
  ["a", "1"],
  ["b", "2"],
  ["c", "true"],
]);
assert.deepEqual(entradas(normalizarContexto(null)), []);
assert.deepEqual(entradas(normalizarContexto("nao sou objeto")), []);
assert.deepEqual(entradas(normalizarContexto([{ a: 1 }])), [], "lista nao e mapa de contexto");
assert.deepEqual(entradas(normalizarContexto({ "  URA  ": "x" })), [["URA", "x"]], "chave normaliza na leitura");

// 4.4 chave "__proto__" e chave como outra qualquer (o mapa nasce sem prototipo).
// Num objeto literal, gravar "__proto__" NAO cria propriedade: a variavel
// sumiria em silencio e a condicao sobre ela daria falso pra sempre.
{
  // JSON.parse e o caminho REAL (e o unico jeito de a chave existir de verdade:
  // num objeto literal, `__proto__:` e sintaxe que troca o prototipo e a chave
  // nem chega a existir). Assim chega o jsonb do banco.
  const m = normalizarContexto(JSON.parse('{"__proto__":"veneno","URA":"MENU"}'));
  assert.equal(m["__proto__"], "veneno", "__proto__ e chave de dado, nao o prototipo");
  assert.equal(m.URA, "MENU");
  assert.equal(av(cmp("contexto", "igual", { chave: "__proto__", valor: "veneno" }), { contexto: m }), true);
}

// 4.5 CHAVE casa por igualdade EXATA (o VALOR e que normaliza)
{
  const f: FatosConversa = { contexto: { URA: "Menu Principal" } };
  assert.equal(av(cmp("contexto", "igual", { chave: "URA", valor: "menu principal" }), f), true, "valor normaliza");
  assert.equal(av(cmp("contexto", "igual", { chave: "ura", valor: "Menu Principal" }), f), false, "chave nao normaliza");
  // fixture como objeto literal: chave herdada do prototipo NAO conta como fato
  assert.equal(av(cmp("contexto", "existe", { chave: "constructor" }), f), false, "propriedade herdada nao e contexto");
}

// 4.3 as acoes de contexto
const macroCom = (...nos: any[]): any => ({ id: "m", nome: "M", tipo: "macro", versao: 1, nos });
const acaoOk = (acao: any) => {
  const r = validarFluxo(macroCom({ id: "n1", tipo: "acao", acao }));
  assert.equal(r.ok, true, "esperava acao valida: " + (r.ok ? "" : (r as any).erros.join(" | ")));
  return (r as any).fluxo.nos[0].acao;
};
assert.deepEqual(acaoOk({ tipo: "definir_contexto", chave: " URA ", valor: "MENU" }), {
  tipo: "definir_contexto",
  chave: "URA",
  valor: "MENU",
});
// valor VAZIO e legitimo (marcar a chave sem conteudo); ausente vira ""
assert.equal(acaoOk({ tipo: "definir_contexto", chave: "URA", valor: "" }).valor, "");
assert.equal(acaoOk({ tipo: "definir_contexto", chave: "URA" }).valor, "");
assert.deepEqual(acaoOk({ tipo: "limpar_contexto", chave: "URA" }), { tipo: "limpar_contexto", chave: "URA" });
{
  const falhou = (acao: any, trecho: string) => {
    const r = validarFluxo(macroCom({ id: "n1", tipo: "acao", acao }));
    assert.equal(r.ok, false, `esperava recusa por "${trecho}"`);
    assert.ok((r as any).erros.join(" | ").includes(trecho), (r as any).erros.join(" | "));
  };
  falhou({ tipo: "definir_contexto", valor: "x" }, "definir_contexto sem chave valida");
  falhou({ tipo: "definir_contexto", chave: "URA", valor: 42 }, "valor que nao e texto");
  falhou({ tipo: "definir_contexto", chave: "URA", valor: "x".repeat(2000) }, "valor de contexto acima de");
  falhou({ tipo: "limpar_contexto", chave: "  " }, "limpar_contexto sem chave valida");
}

// ============================================ 5) NO DE CONDICAO NO FLUXO
// 5.1 macro ACEITA no de condicao estruturada (verdadeira segue, falsa para)
{
  const bruto = macroCom(
    { id: "n1", tipo: "condicao", condicao: cmp("contexto", "igual", { chave: "URA", valor: "MENU" }), proximo: "n2" },
    { id: "n2", tipo: "acao", acao: { tipo: "definir_contexto", chave: "URA", valor: "FIM" } }
  );
  const r = validarFluxo(bruto);
  assert.equal(r.ok, true, r.ok ? "" : (r as any).erros.join(" | "));
  const fluxo = (r as any).fluxo as Fluxo;
  assert.equal(fluxo.nos[0].condicao!.tipo, "comparacao");
  // e o preflight deixa rodar — no de condicao nao executa acao nenhuma
  assert.equal(motivoParaRecusarPuro(fluxo, { soLeitura: false, envioCabeado: true }, { maxInline: 15, maxTotal: 40 }), null);
  // ... inclusive em canal SOMENTE LEITURA: contexto e memoria do painel
  assert.equal(motivoParaRecusarPuro(fluxo, { soLeitura: true, envioCabeado: false }, { maxInline: 15, maxTotal: 40 }), null);
}

// 5.2 macro NAO aceita ramificacao: escolher entre caminhos e fluxo de gatilho (v2)
{
  const r = validarFluxo(
    macroCom(
      { id: "n1", tipo: "condicao", ramos: [{ quando: "sim", proximo: "n2" }] },
      { id: "n2", tipo: "acao", acao: { tipo: "nota_interna", texto: "x" } }
    )
  );
  assert.equal(r.ok, false);
  assert.ok((r as any).erros.join(" | ").includes("macro nao aceita no de tipo condicao"));
}

// 5.3 no de condicao com condicao INVALIDA nao passa pela porta do fluxo
{
  const r = validarFluxo(macroCom({ id: "n1", tipo: "condicao", condicao: cmp("contexto", "igual", { valor: "x" }) }));
  assert.equal(r.ok, false);
  assert.ok((r as any).erros.join(" | ").includes("condicao de contexto precisa de chave"));
}

// 5.4 fluxo de GATILHO segue aceitando ramos, e agora com condicao por ramo
{
  const r = validarFluxo({
    id: "g",
    nome: "G",
    tipo: "gatilho",
    versao: 1,
    nos: [
      {
        id: "n1",
        tipo: "condicao",
        ramos: [{ quando: "vip", condicao: cmp("etiqueta", "igual", { valor: "VIP" }), proximo: "n2" }],
      },
      { id: "n2", tipo: "acao", acao: { tipo: "nota_interna", texto: "x" } },
    ],
  });
  assert.equal(r.ok, true, r.ok ? "" : (r as any).erros.join(" | "));
  // ... e a v1 do motor continua recusando fluxo de gatilho
  assert.ok(
    motivoParaRecusarPuro((r as any).fluxo, { soLeitura: false, envioCabeado: true }, { maxInline: 15, maxTotal: 40 })!
      .includes("v1 executa so fluxo de tipo macro")
  );
}

// 5.5 inventario de variaveis do fluxo (o que a tela mostra sem abrir no a no)
{
  const r = validarFluxo(
    macroCom(
      { id: "n1", tipo: "condicao", condicao: { tipo: "e", condicoes: [cmp("contexto", "igual", { chave: "URA", valor: "M" }), cmp("contexto", "existe", { chave: "campanha" })] }, proximo: "n2" },
      { id: "n2", tipo: "acao", acao: { tipo: "definir_contexto", chave: "etapa", valor: "1" }, proximo: "n3" },
      { id: "n3", tipo: "acao", acao: { tipo: "limpar_contexto", chave: "timer" } }
    )
  );
  assert.deepEqual(chavesDeContextoDoFluxo((r as any).fluxo), { grava: ["etapa", "timer"], le: ["URA", "campanha"] });
}

// ================================================ 6) PERCURSO DO MACRO
// O que o motor DECIDE ao rodar um macro: quem roda, com que fato a condicao
// decide, onde para. Mora em `percorrerMacro` (puro, com deps injetadas) porque
// lib/fluxo/executar.ts importa banco/env/provedor e nao carrega em node solto.
// Aqui as deps sao de mentira e registram o que foram chamadas a fazer.
type Chamada = { coletou: string[][]; executou: string[] };

function depsDeMentira(opts: {
  fatos?: FatosConversa;
  indisponiveis?: Record<string, string>;
  contextoDaAcao?: Record<string, Record<string, string>>;
  falhaEm?: string;
} = {}) {
  const log: Chamada = { coletou: [], executou: [] };
  // o "banco" de mentira: muda quando a acao muda
  const banco: FatosConversa = JSON.parse(JSON.stringify(opts.fatos ?? {}));
  const deps = {
    coletar: async (campos: any[]) => {
      log.coletou.push([...campos].sort());
      const fatos: any = {};
      const indisponiveis: any = {};
      for (const c of campos) {
        if (opts.indisponiveis && c in opts.indisponiveis) {
          indisponiveis[c] = opts.indisponiveis[c];
          continue;
        }
        if (c === "contexto") fatos.contexto = banco.contexto ?? {};
        if (c === "status") fatos.status = banco.status ?? null;
        if (c === "etiqueta") fatos.etiquetas = banco.etiquetas ?? [];
        if (c === "texto") fatos.texto = banco.texto ?? null;
        if (c === "etapa") fatos.etapas = banco.etapas ?? [];
      }
      return { fatos, indisponiveis };
    },
    executar: async (no: any) => {
      const a = no.acao;
      log.executou.push(no.id);
      if (opts.falhaEm === no.id) throw new Error("falha de mentira");
      if (a.tipo === "definir_contexto") {
        banco.contexto = { ...(banco.contexto ?? {}), [a.chave]: a.valor };
        return { detalhe: "gravou", contexto: banco.contexto };
      }
      if (a.tipo === "limpar_contexto") {
        const novo = { ...(banco.contexto ?? {}) };
        delete novo[a.chave];
        banco.contexto = novo;
        return { detalhe: "apagou", contexto: novo };
      }
      if (a.tipo === "mudar_status") banco.status = a.status;
      if (a.tipo === "etiquetar") banco.etiquetas = [...(banco.etiquetas ?? []), ...a.etiquetas];
      return { detalhe: "fez" };
    },
  };
  return { deps, log };
}
const fluxoOk = (nos: any[]): Fluxo => {
  const r = validarFluxo({ id: "m", nome: "M", tipo: "macro", versao: 1, nos });
  assert.equal(r.ok, true, r.ok ? "" : (r as any).erros.join(" | "));
  return (r as any).fluxo;
};

// 6.1 CASO-MAE (o defeito que a revisao cega pegou): grava a variavel e, no
// passo seguinte, a condicao pergunta por ELA. Com os fatos coletados uma vez
// ANTES do laco, a condicao decidia em dado velho e o macro parava sozinho —
// com ok:true e sem ninguem saber por que.
{
  const fluxo = fluxoOk([
    { id: "n1", tipo: "acao", acao: { tipo: "definir_contexto", chave: "URA", valor: "MENU" }, proximo: "n2" },
    { id: "n2", tipo: "condicao", condicao: cmp("contexto", "igual", { chave: "URA", valor: "MENU" }), proximo: "n3" },
    { id: "n3", tipo: "acao", acao: { tipo: "nota_interna", texto: "chegou no fim" } },
  ]);
  const { deps, log } = depsDeMentira({ fatos: { contexto: {} } });
  const r = await percorrerMacro(fluxo, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(log.executou, ["n1", "n3"], "o macro TEM que chegar no n3");
  assert.equal(r.passos[1].detalhe, "condicao verdadeira: segue");
  assert.equal(r.passos.length, 3);
  assert.ok(r.passos.every((p) => p.status === "ok"), "nenhum passo pulado");
}

// 6.1b O CASO-MAE COM MORDIDA NO MECANISMO. O 6.1 sozinho nao distingue "usou o
// mapa devolvido pela acao" de "releu o banco depois" — o dep de mentira acerta
// nos dois casos, porque o banco dele tambem foi mutado. Aqui a condicao vem
// ANTES e DEPOIS do `definir_contexto`, e a assercao e dupla: o macro chega ao
// n4 E o contexto foi lido UMA vez so. Duas leituras significariam que a decisao
// saiu de releitura, nao do valor que a acao devolveu.
{
  const fluxo = fluxoOk([
    { id: "n1", tipo: "condicao", condicao: cmp("contexto", "nao_existe", { chave: "URA" }), proximo: "n2" },
    { id: "n2", tipo: "acao", acao: { tipo: "definir_contexto", chave: "URA", valor: "MENU" }, proximo: "n3" },
    { id: "n3", tipo: "condicao", condicao: cmp("contexto", "igual", { chave: "URA", valor: "MENU" }), proximo: "n4" },
    { id: "n4", tipo: "acao", acao: { tipo: "nota_interna", texto: "chegou no fim" } },
  ]);
  const { deps, log } = depsDeMentira({ fatos: { contexto: {} } });
  const r = await percorrerMacro(fluxo, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(log.executou, ["n2", "n4"], "as duas condicoes tem que passar");
  assert.deepEqual(
    log.coletou,
    [["contexto"]],
    "contexto lido UMA vez: a 2a condicao decidiu pelo mapa que a acao devolveu, nao por releitura"
  );
  assert.equal(r.passos[0].detalhe, "condicao verdadeira: segue");
  assert.equal(r.passos[2].detalhe, "condicao verdadeira: segue");
}

// 6.2 o espelho do caso-mae: limpar a variavel faz a MESMA condicao dar falso
{
  const fluxo = fluxoOk([
    { id: "n1", tipo: "acao", acao: { tipo: "limpar_contexto", chave: "URA" }, proximo: "n2" },
    { id: "n2", tipo: "condicao", condicao: cmp("contexto", "existe", { chave: "URA" }), proximo: "n3" },
    { id: "n3", tipo: "acao", acao: { tipo: "nota_interna", texto: "nao devia chegar" } },
  ]);
  const { deps, log } = depsDeMentira({ fatos: { contexto: { URA: "MENU" } } });
  const r = await percorrerMacro(fluxo, deps);
  assert.equal(r.ok, true, "condicao falsa NAO e falha: o fluxo fez o que mandaram");
  assert.deepEqual(log.executou, ["n1"], "n3 nao roda");
  assert.equal(r.passos[1].detalhe, "condicao falsa: o macro para aqui");
  assert.equal(r.passos[2].status, "pulado");
  assert.equal(r.passos[2].detalhe, "condicao anterior nao bateu");
}

// 6.3 acao que muda a conversa SUJA o campo, e a condicao seguinte RECOLETA
{
  const fluxo = fluxoOk([
    { id: "n1", tipo: "condicao", condicao: cmp("status", "igual", { valor: "aberto" }), proximo: "n2" },
    { id: "n2", tipo: "acao", acao: { tipo: "mudar_status", status: "concluido" }, proximo: "n3" },
    { id: "n3", tipo: "condicao", condicao: cmp("status", "igual", { valor: "concluido" }), proximo: "n4" },
    { id: "n4", tipo: "acao", acao: { tipo: "nota_interna", texto: "fim" } },
  ]);
  const { deps, log } = depsDeMentira({ fatos: { status: "aberto" } });
  const r = await percorrerMacro(fluxo, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(log.executou, ["n2", "n4"]);
  assert.deepEqual(log.coletou, [["status"], ["status"]], "coletou duas vezes: a acao sujou o status");
}

// 6.4 campo que NINGUEM sujou nao e recoletado (uma leitura, nao uma por no)
{
  const fluxo = fluxoOk([
    { id: "n1", tipo: "condicao", condicao: cmp("etiqueta", "igual", { valor: "VIP" }), proximo: "n2" },
    { id: "n2", tipo: "acao", acao: { tipo: "nota_interna", texto: "nota nao mexe em etiqueta" }, proximo: "n3" },
    { id: "n3", tipo: "condicao", condicao: cmp("etiqueta", "igual", { valor: "VIP" }), proximo: "n4" },
    { id: "n4", tipo: "acao", acao: { tipo: "nota_interna", texto: "fim" } },
  ]);
  const { deps, log } = depsDeMentira({ fatos: { etiquetas: ["VIP"] } });
  const r = await percorrerMacro(fluxo, deps);
  assert.equal(r.ok, true);
  assert.equal(log.coletou.length, 1, "nota_interna nao suja etiqueta: uma leitura basta");
}

// 6.5 macro SEM condicao nao consulta nada (coleta e sob demanda)
{
  const fluxo = fluxoOk([{ id: "n1", tipo: "acao", acao: { tipo: "nota_interna", texto: "x" } }]);
  const { deps, log } = depsDeMentira();
  const r = await percorrerMacro(fluxo, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(log.coletou, [], "zero consulta");
}

// 6.6 a condicao pede SO o campo que usa
{
  const fluxo = fluxoOk([
    { id: "n1", tipo: "condicao", condicao: cmp("contexto", "existe", { chave: "URA" }), proximo: "n2" },
    { id: "n2", tipo: "acao", acao: { tipo: "nota_interna", texto: "x" } },
  ]);
  const { deps, log } = depsDeMentira({ fatos: { contexto: { URA: "1" } } });
  await percorrerMacro(fluxo, deps);
  assert.deepEqual(log.coletou, [["contexto"]], "nao busca status/etiqueta/etapa sem precisar");
}

// 6.7 fato que nao deu pra LER faz o passo FALHAR — nunca virar "condicao falsa"
{
  const fluxo = fluxoOk([
    { id: "n1", tipo: "condicao", condicao: cmp("contexto", "igual", { chave: "URA", valor: "MENU" }), proximo: "n2" },
    { id: "n2", tipo: "acao", acao: { tipo: "nota_interna", texto: "x" } },
  ]);
  const { deps, log } = depsDeMentira({ indisponiveis: { contexto: "migration 0016 nao rodou" } });
  const r = await percorrerMacro(fluxo, deps);
  assert.equal(r.ok, false, "indisponibilidade e FALHA, nao decisao");
  assert.equal(r.passos[0].status, "falhou");
  assert.equal(r.passos[0].detalhe, "migration 0016 nao rodou");
  assert.deepEqual(log.executou, [], "nada rodou");
  assert.equal(r.passos[1].detalhe, "passo anterior falhou");
}

// 6.8 motivo de indisponibilidade VAZIO ainda e indisponibilidade
// (com `||` na montagem do motivo, string vazia sumia e a condicao decidia
// por falso com o fato faltando)
{
  const fluxo = fluxoOk([
    { id: "n1", tipo: "condicao", condicao: cmp("etapa", "existe", { funil: "Vendas" }), proximo: "n2" },
    { id: "n2", tipo: "acao", acao: { tipo: "nota_interna", texto: "x" } },
  ]);
  const { deps } = depsDeMentira({ indisponiveis: { etapa: "" } });
  const r = await percorrerMacro(fluxo, deps);
  assert.equal(r.ok, false, "motivo vazio nao pode passar por 'estava tudo bem'");
  assert.equal(r.passos[0].status, "falhou");
}

// 6.9 acao que falha para o macro na hora, e o resto fica pulado
{
  const fluxo = fluxoOk([
    { id: "n1", tipo: "acao", acao: { tipo: "nota_interna", texto: "a" }, proximo: "n2" },
    { id: "n2", tipo: "acao", acao: { tipo: "nota_interna", texto: "b" }, proximo: "n3" },
    { id: "n3", tipo: "acao", acao: { tipo: "nota_interna", texto: "c" } },
  ]);
  const { deps, log } = depsDeMentira({ falhaEm: "n2" });
  const r = await percorrerMacro(fluxo, deps);
  assert.equal(r.ok, false);
  assert.deepEqual(log.executou, ["n1", "n2"]);
  assert.equal(r.passos[1].detalhe, "falha de mentira");
  assert.equal(r.passos[2].status, "pulado");
}

// 6.10 a tabela de campos sujos e o contrato: mexeu nela, mexe aqui
assert.deepEqual(CAMPOS_SUJOS_POR_ACAO.enviar_texto, ["status"], "responder move a conversa pra atendimento");
assert.deepEqual(CAMPOS_SUJOS_POR_ACAO.mudar_status, ["status"]);
assert.deepEqual(CAMPOS_SUJOS_POR_ACAO.etiquetar, ["etiqueta"]);
assert.deepEqual(CAMPOS_SUJOS_POR_ACAO.mover_funil, ["etapa"]);
// contexto NAO entra: as acoes de contexto devolvem o mapa novo
assert.equal(CAMPOS_SUJOS_POR_ACAO.definir_contexto, undefined);
assert.equal(CAMPOS_SUJOS_POR_ACAO.limpar_contexto, undefined);
// `texto` nunca fica sujo: e a ultima mensagem RECEBIDA, e macro nao recebe
assert.ok(
  !Object.values(CAMPOS_SUJOS_POR_ACAO).some((cs) => (cs ?? []).includes("texto")),
  "nenhuma acao de macro muda o texto da ultima mensagem recebida"
);

// 6.11 preflight: canal SOMENTE LEITURA nao tem conversa/mensagem da fonte,
// entao condicao sobre texto/status/etiqueta e recusada ANTES de comecar (senao
// o macro morreria no meio, com acao ja aplicada)
{
  const LIM = { maxInline: 15, maxTotal: 40 };
  const comCondicao = (c: any) =>
    fluxoOk([
      { id: "n1", tipo: "condicao", condicao: c, proximo: "n2" },
      { id: "n2", tipo: "acao", acao: { tipo: "mover_funil", funil: "Vendas", etapa: "Novo" } },
    ]);
  const soLeitura = { soLeitura: true, envioCabeado: false };
  for (const campo of ["texto", "status", "etiqueta"]) {
    const motivo = motivoParaRecusarPuro(comCondicao(cmp(campo, "existe")), soLeitura, LIM);
    assert.ok(motivo?.includes("canal somente leitura"), `esperava recusa por ${campo}, veio: ${motivo}`);
    assert.ok(motivo?.includes(campo), `o motivo diz QUAL campo falta: ${motivo}`);
  }
  // contexto e etapa moram em tabela do painel: continuam valendo
  assert.equal(motivoParaRecusarPuro(comCondicao(cmp("contexto", "existe", { chave: "URA" })), soLeitura, LIM), null);
  assert.equal(motivoParaRecusarPuro(comCondicao(cmp("etapa", "existe", { funil: "Vendas" })), soLeitura, LIM), null);
  // e num canal normal os tres passam
  assert.equal(motivoParaRecusarPuro(comCondicao(cmp("texto", "existe")), { soLeitura: false, envioCabeado: true }, LIM), null);
}

// 6.x PASSO DESLIGADO (Frente T, card 86ak85nzy). O motor pula e SEGUE: desligar
// um aviso do meio de uma sequencia quer dizer "faca o resto", nao "cancele".
{
  const fluxo = fluxoOk([
    { id: "n1", tipo: "acao", acao: { tipo: "nota_interna", texto: "primeiro" }, proximo: "n2" },
    { id: "n2", tipo: "acao", acao: { tipo: "nota_interna", texto: "desligado" }, desligado: true, proximo: "n3" },
    { id: "n3", tipo: "acao", acao: { tipo: "nota_interna", texto: "ultimo" } },
  ]);
  const { deps, log } = depsDeMentira({ fatos: {} });
  const r = await percorrerMacro(fluxo, deps);
  assert.equal(r.ok, true, "passo desligado nao e falha");
  assert.deepEqual(log.executou, ["n1", "n3"], "o passo desligado nao roda e nao para o macro");
  assert.equal(r.passos[1].status, "pulado");
  assert.equal(r.passos[1].detalhe, "passo desligado", "o motivo vai pra trilha: skip invisivel viraria misterio");
}

// 6.x.b CONDICAO desligada nao decide nada — e nem pede fato ao banco. Se ela
// coletasse, um campo indisponivel (canal so-leitura) derrubaria o macro por
// causa de uma condicao que alguem tirou de servico.
{
  const fluxo = fluxoOk([
    {
      id: "n1",
      tipo: "condicao",
      condicao: cmp("status", "igual", { valor: "nunca-igual" }),
      desligado: true,
      proximo: "n2",
    },
    { id: "n2", tipo: "acao", acao: { tipo: "nota_interna", texto: "roda" } },
  ]);
  const { deps, log } = depsDeMentira({ fatos: { status: "aberto" } });
  const r = await percorrerMacro(fluxo, deps);
  assert.equal(r.ok, true);
  assert.deepEqual(log.executou, ["n2"], "a condicao desligada nao para o macro");
  assert.deepEqual(log.coletou, [], "e nao vai buscar fato nenhum");
}

// 6.x.c PREFLIGHT: passo desligado nao pode ser MOTIVO de recusa — e corrente
// inteira desligada e recusa explicita, nunca "rodou sem fazer nada".
{
  const soLeitura = { soLeitura: true, envioCabeado: false };
  const comEnvio = { soLeitura: false, envioCabeado: true };
  const limites = { maxInline: 15, maxTotal: 20 };

  const envioDesligado = fluxoOk([
    { id: "n1", tipo: "acao", acao: { tipo: "mover_funil", funil: "F", etapa: "E" }, proximo: "n2" },
    { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "oi" }, desligado: true },
  ]);
  assert.equal(
    motivoParaRecusarPuro(envioDesligado, soLeitura, limites),
    null,
    "um enviar_texto DESLIGADO nao pode recusar o macro num canal somente leitura"
  );

  const avalDesligado = fluxoOk([
    { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "sensivel" }, aprovacao: true, desligado: true },
  ]);
  assert.equal(
    motivoParaRecusarPuro(avalDesligado, comEnvio, limites),
    "todos os passos deste fluxo estao desligados",
    "corrente inteira desligada: recusa com o motivo, nunca sucesso vazio"
  );

  const esperaLongaDesligada = fluxoOk([
    { id: "n1", tipo: "espera", acao: { tipo: "espera", segundos: 600 }, desligado: true, proximo: "n2" },
    { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "oi" } },
  ]);
  assert.equal(
    motivoParaRecusarPuro(esperaLongaDesligada, comEnvio, limites),
    null,
    "espera desligada nao empurra o macro pra fila"
  );
}

// ============================================= 7) CONVERSOR: as ressalvas
// Fixtures sinteticas na FORMA do formulario do ChatGuru (nomes e textos
// inventados) — nenhum dialogo de cliente entra no repo.
const campo = (nome: string, valor: any) => ({ rotulo: nome, nome, tipo: "text", valor });
const cabecalhoCG = (over: Record<string, string> = {}) => [
  campo("title", over.title ?? "Macro de teste"),
  campo("node_type", over.node_type ?? "Manual (não será executado automaticamente pelo chatbot)"),
  campo("max_executions_per_chat", over.max_executions_per_chat ?? "9999"),
  campo("seconds_between_execution", over.seconds_between_execution ?? "0"),
  campo("assure_context_condition_before_execution", over.assure_context_condition_before_execution ?? "Não"),
  campo("context_variable_name", over.context_variable_name ?? ""),
  campo("context_variable_value", over.context_variable_value ?? ""),
  campo("conditions_advanced", over.conditions_advanced ?? ""),
];
const acaoCG = (id: string, tipo: string, extras: any[] = []) => [
  campo("action_id", id),
  { rotulo: "action_type", nome: "action_type", tipo: "hidden", valor: tipo },
  ...extras,
];
const dialogoCG = (over: Record<string, string>, id = "abc123") => ({
  dialogo_id: id,
  campos: [...cabecalhoCG(over), ...acaoCG("a1", "ANOTAÇÃO", [campo("note_text", "nota")])],
});

// 7.1 `assure_context_condition_before_execution` — campo NAO documentado. TODO
// dialogo com condicao carrega a ressalva, com o valor do campo escrito nela.
{
  for (const valor of ["Sim", "Não"]) {
    const r = converterDialogo(
      dialogoCG({ conditions_advanced: "!status=='ABERTO'", assure_context_condition_before_execution: valor })
    );
    assert.equal(r.estado, "ressalva");
    const dela = r.ressalvas.find((x: string) => x.includes("assure_context_condition_before_execution"));
    assert.ok(dela, `esperava a ressalva do campo assure (valor ${valor})`);
    assert.ok(dela.includes(`"${valor}"`), "a ressalva diz o VALOR do campo: " + dela);
    assert.ok(dela.includes("NAO esta documentada"), "a ressalva assume que a semantica e desconhecida");
    assert.equal(r.condicao.assure, valor, "o valor sai no resultado, pro relatorio contar");
  }
  // dialogo SEM condicao nao carrega a ressalva (o campo nao muda nada ali)
  const semCond = converterDialogo(dialogoCG({}));
  assert.equal(semCond.condicao.estado, "sem");
  assert.ok(!semCond.ressalvas.some((x: string) => x.includes("assure_context_condition")));
}

// 7.1b RESSALVA NAO PODE DESCREVER OUTRO FLUXO. Quando a condicao NAO converte, o
// fluxo e gravado SEM no de condicao e executa tudo — entao as duas ressalvas que
// falam "a condicao foi prefixada" / "vai parar no primeiro no" NAO podem sair.
// Elas ficavam antes do return de falha e saiam em 115 fluxos assim.
{
  // `!inventada` nao existe no vocabulario: a condicao inteira cai
  const r = converterDialogo(dialogoCG({ conditions_advanced: "$URA=='MENU' and !inventada=='x'" }));
  assert.equal(r.condicao.estado, "nao", "a condicao nao converteu");
  assert.equal(r.fluxo.nos.every((n: any) => n.tipo !== "condicao"), true, "o fluxo saiu SEM no de condicao");
  assert.ok(
    r.ressalvas.some((x: string) => x.includes("condicao avancada NAO convertida")),
    "tem que dizer que a condicao nao veio"
  );
  assert.ok(
    !r.ressalvas.some((x: string) => x.includes(MARCA_RESSALVA_ASSURE)),
    "sem no de condicao, a ressalva do assure descreveria um fluxo que nao existe"
  );
  assert.ok(
    !r.ressalvas.some((x: string) => x.includes(MARCA_RESSALVA_CONTEXTO_INERTE)),
    "sem no de condicao, nada 'vai parar no primeiro no'"
  );
  // e a mesma coisa vale pro que FOI gravado no fluxo (origem.ressalvas)
  assert.ok(!r.fluxo.origem.ressalvas.some((x: string) => x.includes(MARCA_RESSALVA_ASSURE)));
}

// 7.2 condicao de CONTEXTO avisa que nada popula contexto nesta instalacao
{
  const r = converterDialogo(dialogoCG({ conditions_advanced: "$URA=='MENU'" }));
  assert.ok(
    r.ressalvas.some((x: string) => x.includes("nada popula contexto")),
    "condicao de contexto tem que avisar que vai dar falso"
  );
  // condicao que NAO olha contexto nao recebe esse aviso
  const semContexto = converterDialogo(dialogoCG({ conditions_advanced: "!status=='ABERTO'" }));
  assert.ok(!semContexto.ressalvas.some((x: string) => x.includes("nada popula contexto")));
}

// 7.3 a condicao NAO derruba o dialogo: fluxo que o schema recusa SO por causa
// dela e regravado sem a condicao, com a ressalva dizendo o que ficou de fora
{
  const comCondicaoRuim: any = {
    id: "cg-1",
    nome: "X",
    tipo: "macro",
    versao: 1,
    origem: {
      ferramenta: "chatguru",
      id_original: "1",
      ressalvas: [
        "ressalva que ja existia",
        `campo \`${MARCA_RESSALVA_ASSURE}\` = "Nao": ...`,
        `a condicao olha VARIAVEL DE CONTEXTO e ${MARCA_RESSALVA_CONTEXTO_INERTE} nesta instalacao ainda`,
      ],
    },
    nos: [
      // condicao de contexto SEM chave: o schema recusa
      { id: "n1", tipo: "condicao", condicao: cmp("contexto", "igual", { valor: "v" }), proximo: "n2" },
      { id: "n2", tipo: "acao", acao: { tipo: "nota_interna", texto: "a" } },
    ],
  };
  const antes = validarFluxo(comCondicaoRuim);
  assert.equal(antes.ok, false, "o fluxo com a condicao ruim e recusado");
  const sem = semCondicaoDeEntrada(comCondicaoRuim, (antes as any).erros);
  const depois = validarFluxo(sem);
  assert.equal(depois.ok, true, "sem a condicao, as ACOES continuam valendo");
  assert.equal((depois as any).fluxo.nos.length, 1);
  const rs = (depois as any).fluxo.origem.ressalvas;
  assert.ok(rs.includes("ressalva que ja existia"), "nao perde as ressalvas anteriores");
  assert.ok(rs.some((x: string) => x.includes("condicao de entrada NAO entrou no fluxo")));
  // e as ressalvas que FALAM da condicao saem junto com ela
  assert.ok(!rs.some((x: string) => x.includes(MARCA_RESSALVA_ASSURE)), "a ressalva do assure sai junto");
  assert.ok(!rs.some((x: string) => x.includes(MARCA_RESSALVA_CONTEXTO_INERTE)), "a do contexto inerte sai junto");
  // fluxo que nao tinha condicao volta identico (funcao idempotente)
  const semNada = { ...comCondicaoRuim, nos: comCondicaoRuim.nos.slice(1) };
  assert.equal(semCondicaoDeEntrada(semNada), semNada);
}

console.log("prova-condicao: OK");
