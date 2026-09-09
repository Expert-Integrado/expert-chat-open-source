// Prova do resolvedor de referencias (scripts/importar/resolver.mjs).
//
//   node scripts/importar/prova-resolver.mjs
//
// Modulo puro: nada aqui le arquivo nem abre conexao. Os casos sao os que
// custaram incidente ou medicao no material real:
//
//   - id do Mongo em dois formatos ("abc..." e {$oid}) — o segundo fazia o
//     responsavel desaparecer;
//   - nome com espaco duplo, espaco no fim, caixa trocada e acento — o cadastro
//     de origem nunca teve padronizacao ("Ana souza");
//   - nome que se repete em DOIS escopos: sem escopo, a resposta honesta e
//     AMBIGUO, nunca "morto" (esconder a ambiguidade e pior que declara-la);
//   - placeholder de formulario nao escolhido: 1.205 das 3.607 acoes DIALOGO dos
//     33 backups. NAO e perda — contar como perda inventa problema;
//   - e a regra que nao se negocia: ambiguo e morto NAO resolvem. Nada de
//     "parecido", prefixo ou distancia de edicao.

import {
  normalizar,
  ehPlaceholder,
  idDeOrigem,
  ehObjectId,
  ehRessalva,
  resolvido,
  novoIndice,
  resolver,
  novoPlacar,
  tabelaMarkdown,
} from "./resolver.mjs";

let falhas = 0;
const ok = (cond, oque, detalhe = "") => {
  console.log(`${cond ? "  ok  " : "FALHA "} ${oque}${detalhe ? ` — ${detalhe}` : ""}`);
  if (!cond) falhas++;
};
const igual = (obtido, esperado, oque) =>
  ok(
    JSON.stringify(obtido) === JSON.stringify(esperado),
    oque,
    `esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`
  );

console.log("PROVA DO RESOLVEDOR DE REFERENCIAS\n");

console.log("-- normalizacao");
igual(normalizar("  Ana   SOUZA  "), "ana souza", "caixa, espaco duplo e espaco nas pontas");
igual(normalizar("Ação  Ç"), "acao c", "acento sai da chave de comparacao");
igual(normalizar(null), "", "nulo vira string vazia, sem estourar");
ok(normalizar("Ana Souza") === normalizar("ana souza "), "as duas grafias dao a MESMA chave");
ok(normalizar("Ana Souza") !== normalizar("Ana Souza Lima"), "nome parecido NAO da a mesma chave");

console.log("\n-- id de origem nos dois formatos");
igual(idDeOrigem("62a122fe497e6238f36f3c23"), "62a122fe497e6238f36f3c23", "id em string");
igual(idDeOrigem({ $oid: "62a122fe497e6238f36f3c23" }), "62a122fe497e6238f36f3c23", "id em {$oid}");
igual(idDeOrigem(null), null, "nulo continua nulo");
ok(ehObjectId({ $oid: "62a122fe497e6238f36f3c23" }), "reconhece ObjectId dentro de {$oid}");
ok(!ehObjectId("Menu Inicial"), "e nome de dialogo nao e ObjectId");

console.log("\n-- placeholder nao e perda");
ok(ehPlaceholder("-- SELECIONE O DIÁLOGO --"), "o placeholder do formulario de origem e reconhecido");
ok(ehPlaceholder("- Selecione a Etapa -"), "idem pro de etapa");
ok(ehPlaceholder(""), "vazio tambem");
ok(!ehPlaceholder("Menu Inicial"), "nome de verdade nao e placeholder");

const catalogo = [
  { id_origem: "d1", nome: "Menu Inicial", escopo: "bot-a" },
  { id_origem: "d2", nome: "menu  inicial ", escopo: "bot-b" }, // MESMO nome, outro escopo
  { id_origem: "d3", nome: "Boas Vindas", escopo: "bot-a", ordem: 1 },
  { id_origem: "d4", nome: "Fechamento", escopo: "bot-a", ordem: 2 },
];
const ix = novoIndice(catalogo);

console.log("\n-- resolucao por id (o casamento mais forte)");
const porId = resolver(ix, { $oid: "d1" });
igual(porId.estado, "id", "id em {$oid} resolve");
igual(porId.item.nome, "Menu Inicial", "e devolve o item certo");

console.log("\n-- resolucao por nome, dentro do escopo");
const noEscopo = resolver(ix, "menu inicial", { escopo: "bot-a" });
igual(noEscopo.estado, "nome", "nome sujo casa com o do catalogo dentro do escopo");
igual(noEscopo.item.id, "d1", "e casa com o do escopo pedido, nao com o do outro chatbot");

console.log("\n-- o mesmo nome em dois escopos, consultado SEM escopo");
const semEscopo = resolver(ix, "Menu Inicial");
igual(semEscopo.estado, "ambiguo", "a resposta e AMBIGUO (declarar), nao 'morto' (esconder)");
igual(semEscopo.candidatos.length, 2, "e os dois candidatos vem junto, pra revisao humana");
ok(semEscopo.item === null, "ambiguo NAO devolve item: nada de escolher um no chute");

console.log("\n-- alvo que nao existe");
const morto = resolver(ix, "Dialogo Que Foi Apagado");
igual(morto.estado, "morto", "alvo inexistente vira morto");
ok(morto.item === null, "e tambem nao devolve item");

console.log("\n-- posicao: caminho de reimportacao, e so quando pedido");
igual(resolver(ix, "Nome Editado No Painel", { escopo: "bot-a" }).estado, "morto", "sem pedir posicao, morre");
igual(
  resolver(ix, "Nome Editado No Painel", { escopo: "bot-a", porPosicao: 2 }).estado,
  "posicao",
  "com a posicao, reencontra a etapa cujo nome mudou"
);
igual(
  resolver(ix, "Nome Editado", { escopo: "bot-a", porPosicao: 2 }).item.nome,
  "Fechamento",
  "e devolve a etapa daquela posicao"
);
igual(
  resolver(ix, "Nome Editado", { escopo: "bot-b", porPosicao: 2 }).estado,
  "morto",
  "posicao vale DENTRO do escopo: a 2a etapa de outro funil nao serve"
);

console.log("\n-- nada de 'parecido'");
igual(resolver(ix, "Menu").estado, "morto", "prefixo nao resolve");
igual(resolver(ix, "Menu Iniciall").estado, "morto", "erro de digitacao nao resolve");
igual(resolver(ix, "Boas Vindas!").estado, "morto", "pontuacao a mais nao resolve");

console.log("\n-- classificacao de ressalva");
ok(ehRessalva({ estado: "ambiguo" }) && ehRessalva({ estado: "morto" }), "ambiguo e morto SAO ressalva");
ok(!ehRessalva({ estado: "vazio" }), "placeholder NAO e ressalva");
ok(resolvido({ estado: "id" }) && resolvido({ estado: "nome" }) && resolvido({ estado: "posicao" }), "os tres caminhos contam como resolvido");
ok(!resolvido({ estado: "ambiguo" }), "ambiguo nao conta como resolvido");

console.log("\n-- placar e taxas");
const placar = novoPlacar();
placar.resolverE("dialogo", ix, { $oid: "d1" });
placar.resolverE("dialogo", ix, "menu inicial", { escopo: "bot-a" });
placar.resolverE("dialogo", ix, "Menu Inicial"); // ambiguo
placar.resolverE("dialogo", ix, "Apagado"); // morto
placar.resolverE("dialogo", ix, "-- SELECIONE O DIÁLOGO --"); // sem alvo
const linha = placar.tabela()[0];
igual(linha.total, 5, "conta as 5 referencias vistas");
igual(linha.sem_alvo_na_origem, 1, "o placeholder e contado separado");
igual(linha.com_alvo, 4, "e sai do denominador");
igual(linha.taxa_resolvido, 50, "2 de 4 resolveram = 50%");
igual(linha.ressalvas, 2, "1 ambiguo + 1 morto = 2 ressalvas");
const r = placar.ressalvas().dialogo;
igual(r.amostra_morto, ["Apagado"], "a amostra guarda o valor morto pra revisao");
igual(r.amostra_ambiguo[0].candidatos, ["Menu Inicial", "menu  inicial "], "e os candidatos do ambiguo");

console.log("\n-- tabela em markdown");
const md = tabelaMarkdown(placar.tabela());
ok(md.includes("| dialogo |"), "renderiza a linha do tipo");
ok(md.includes("50%"), "com a taxa");
ok(!md.includes("undefined"), "sem buraco");
ok(tabelaMarkdown([]).includes("nenhuma referencia"), "e diz claramente quando nao houve referencia nenhuma");

console.log(`\n${falhas ? `${falhas} FALHA(S)` : "TUDO OK"}`);
process.exit(falhas ? 1 : 0);
