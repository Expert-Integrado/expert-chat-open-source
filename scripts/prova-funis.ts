// Prova do epico de FUNIS (cards 86ak86k62 e 86ak86kac): regra pura de funil,
// a acao de fluxo `mover_funil`, o conversor de FUNIL do ChatGuru e o
// importador de funis rodando em --dry.
//
// Roda em Node >= 22.6 sem build: `node scripts/prova-funis.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// FIXTURES SAO SINTETICAS. Nenhum funil, dialogo ou conversa de cliente entra
// no repo. O exercicio contra o acervo real e o DRY RUN do conversor e do
// importador, que leem arquivos fora do repo e saem em relatorio de contagem.
//
// O QUE ESTA PROVA **NAO** COBRE (declarado, nao esquecido): o caminho de BANCO
// (lib/funis-db.ts, as rotas /api/funis, /api/admin/funis, /api/conversa/funil e
// a acao `mover_funil` dentro do motor). Eles dependem do Postgres da
// instalacao e do alias `@/` do Next — nenhum dos dois existe em node solto.
// A regra que da pra separar de banco foi separada de proposito (lib/funis.ts)
// e ESTA provada aqui: resolucao de nome, plano de movimento e ordenacao.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  corValida, montarCatalogo, nomeValido, normalizarNome, ordemValida,
  planoDeMovimento, proximaOrdem, resolverEtapa, resolverFunil,
  type FunilCatalogo,
} from "../lib/funis.ts";
import {
  ACOES_SO_DO_PAINEL, ACOES_V1, motivoParaRecusarPuro, validarFluxo,
  type Fluxo,
} from "../lib/fluxo/schema.ts";
import { converterDialogo } from "./fluxo/converter-chatguru.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

// ============================================================ 1) REGRA PURA
// 1.1 comparacao de nome: acento, caixa e espaco nao diferenciam
assert.equal(normalizarNome("  Pós-Venda   ATIVO "), "pos-venda ativo");
assert.equal(normalizarNome("PÓS-VENDA ativo"), normalizarNome("pos-venda   Ativo"));
assert.equal(nomeValido("   "), null, "nome so de espaco nao vale");
assert.equal(nomeValido("x".repeat(300))!.length, 120, "nome corta no limite");
assert.equal(corValida("#aabbcc"), "#AABBCC");
assert.equal(corValida("azul"), null, "cor fora do hex nao entra (o CHECK do banco recusaria)");
assert.equal(corValida(""), null);
assert.equal(ordemValida("3"), 3);
assert.equal(ordemValida("nao e numero", 7), 7);

// 1.2 O CASO QUE DECIDE O DESENHO: o mesmo nome de etapa em dois funis.
// Medido no acervo real (31/08/2026): 11 dos 70 nomes de etapa existem em mais
// de um funil. Resolver por nome solto sortearia o funil.
const catalogo: FunilCatalogo[] = montarCatalogo(
  [
    { id: "F1", nome: "Vendas", ordem: 1, ativo: true },
    { id: "F2", nome: "Pós-venda", ordem: 0, ativo: true },
    { id: "F3", nome: "Antigo", ordem: 2, ativo: false },
  ],
  [
    { id: "E1", funil_id: "F1", nome: "Novo", ordem: 2 },
    { id: "E2", funil_id: "F1", nome: "Fechamento", ordem: 1, cor: "#123456" },
    { id: "E3", funil_id: "F2", nome: "Fechamento", ordem: 1 },
    { id: "E4", funil_id: "F1", nome: "Arquivada", ordem: 3, ativo: false },
    { id: "E5", funil_id: "F3", nome: "Qualquer", ordem: 1 },
  ]
);

assert.deepEqual(catalogo.map((f) => f.nome), ["Pós-venda", "Vendas", "Antigo"], "funis saem na ordem declarada");
assert.deepEqual(
  catalogo.find((f) => f.id === "F1")!.etapas.map((e) => e.nome),
  ["Fechamento", "Novo", "Arquivada"],
  "etapas saem na ordem declarada"
);
assert.equal(catalogo.find((f) => f.id === "F1")!.etapas[0].cor, "#123456", "cor sobrevive normalizada");

{
  const a = resolverEtapa(catalogo, "Vendas", "Fechamento");
  const b = resolverEtapa(catalogo, "pos-venda", "FECHAMENTO");
  assert.ok(a.ok && b.ok);
  assert.equal((a as any).etapa.id, "E2", "Fechamento de Vendas");
  assert.equal((b as any).etapa.id, "E3", "Fechamento de Pos-venda — o funil desambigua");
}

// 1.3 recusas FALANTES (o texto vai pra trilha do fluxo e pro relatorio)
const recusa = (funil: string, etapa: string | null, trecho: string) => {
  const r = resolverEtapa(catalogo, funil, etapa);
  assert.equal(r.ok, false, `esperava recusa por "${trecho}"`);
  assert.ok((r as any).erro.includes(trecho), `erro deveria citar "${trecho}", veio: ${(r as any).erro}`);
};
recusa("Inexistente", "Novo", "nao existe nesta instalacao");
recusa("Antigo", "Qualquer", "esta arquivado");
recusa("Vendas", "Nao Existe", 'nao existe no funil "Vendas"');
recusa("Vendas", "Arquivada", "esta arquivada");
recusa("Vendas", null, "etapa nao informada");
assert.equal(resolverFunil(catalogo, "  vendas "), catalogo.find((f) => f.id === "F1"));
assert.equal(resolverFunil(catalogo, ""), null);

// 1.4 plano de movimento: mover DENTRO de um funil nao mexe nos outros
{
  const atuais = [
    { etapa_id: "E1", funil_id: "F1" },
    { etapa_id: "E3", funil_id: "F2" },
  ];
  const p = planoDeMovimento(atuais, "F1", "E2");
  assert.deepEqual(p.remover, ["E1"], "sai da etapa antiga DO MESMO funil");
  assert.equal(p.inserir, "E2");
  assert.equal(p.acao, "moveu");
  assert.equal(p.anterior, "E1", "trilha sabe de onde veio");
  assert.ok(!p.remover.includes("E3"), "a etapa do OUTRO funil fica intacta (N:N)");
}
{
  const p = planoDeMovimento([{ etapa_id: "E3", funil_id: "F2" }], "F1", "E1");
  assert.deepEqual(p, { remover: [], inserir: "E1", acao: "entrou", anterior: null }, "entrar num funil novo");
}
{
  const p = planoDeMovimento([{ etapa_id: "E1", funil_id: "F1" }], "F1", null);
  assert.deepEqual(p, { remover: ["E1"], inserir: null, acao: "saiu", anterior: "E1" }, "sair do funil");
}
{
  const p = planoDeMovimento([{ etapa_id: "E1", funil_id: "F1" }], "F1", "E1");
  assert.equal(p.acao, "nada", "mover pra onde ja esta nao gera escrita nem evento");
  assert.deepEqual(p.remover, []);
}
{
  // caso REAL do acervo (2 conversas): duas etapas do mesmo funil ao mesmo
  // tempo. Um movimento manual limpa a duplicidade em vez de ignora-la.
  const p = planoDeMovimento(
    [{ etapa_id: "E1", funil_id: "F1" }, { etapa_id: "E2", funil_id: "F1" }],
    "F1",
    "E2"
  );
  assert.deepEqual(p.remover, ["E1"], "sai da etapa sobrando");
  assert.equal(p.inserir, null, "ja estava na etapa alvo: nao reinsere");
  assert.equal(p.acao, "moveu");
}
assert.equal(planoDeMovimento([], "F1", null).acao, "nada", "sair de funil em que nao esta e no-op");
assert.equal(proximaOrdem([{ ordem: 0 }, { ordem: 4 }]), 5);
assert.equal(proximaOrdem([]), 0);

// ================================================== 2) ACAO DE FLUXO
assert.ok((ACOES_V1 as readonly string[]).includes("mover_funil"), "mover_funil e acao da v1");

const macro = (acao: any) => ({
  id: "m1",
  nome: "Macro",
  tipo: "macro",
  versao: 1,
  nos: [{ id: "n1", tipo: "acao", acao }],
});
const falhaAcao = (acao: any, trecho: string) => {
  const r = validarFluxo(macro(acao));
  assert.equal(r.ok, false, `esperava recusa por "${trecho}"`);
  const erros = (r as any).erros.join(" | ");
  assert.ok(erros.includes(trecho), `erro deveria citar "${trecho}", veio: ${erros}`);
};

{
  const r = validarFluxo(macro({ tipo: "mover_funil", funil: "  Vendas ", etapa: " Novo " }));
  assert.equal(r.ok, true, "mover_funil valido");
  assert.deepEqual((r as any).fluxo.nos[0].acao, { tipo: "mover_funil", funil: "Vendas", etapa: "Novo" });
}
{
  const r = validarFluxo(macro({ tipo: "mover_funil", funil: "Vendas", etapa: null }));
  assert.equal(r.ok, true, "etapa null = SAIR do funil, e explicito");
}
falhaAcao({ tipo: "mover_funil", etapa: "Novo" }, "sem nome de funil");
// o silencio aqui apagaria a etapa da conversa achando que estava movendo
falhaAcao({ tipo: "mover_funil", funil: "Vendas" }, "precisa de etapa");
falhaAcao({ tipo: "mover_funil", funil: "Vendas", etapa: "   " }, "etapa vazia");
falhaAcao({ tipo: "mover_funil", funil: "x".repeat(200), etapa: "a" }, "nome de funil acima de");
falhaAcao({ tipo: "mover_funil", funil: "a", etapa: "x".repeat(200) }, "nome de etapa acima de");

// ======================= 2b) PREFLIGHT: canal somente leitura recusa por ACAO
// Esta e a mudanca mais sensivel da frente: ate aqui, canal de fonte externa
// recusava o macro INTEIRO. Agora recusa acao a acao — e o que faz mover de
// etapa funcionar num canal somente leitura (o vinculo mora em tabela do
// painel) sem afrouxar nada pro resto. A decisao e pura de proposito, entao da
// pra prova-la sem banco e sem env.
const LIM = { maxInline: 15, maxTotal: 40 };
const CABEADO = { soLeitura: false, envioCabeado: true };
const SO_LEITURA = { soLeitura: true, envioCabeado: false };
const macroCom = (...acoes: any[]): Fluxo =>
  (validarFluxo({
    id: "m1",
    nome: "Macro",
    tipo: "macro",
    versao: 1,
    nos: acoes.map((acao, i) => ({
      id: `n${i + 1}`,
      tipo: acao.tipo === "espera" ? "espera" : "acao",
      acao,
      ...(i < acoes.length - 1 ? { proximo: `n${i + 2}` } : {}),
    })),
  }) as any).fluxo;

const enviar = { tipo: "enviar_texto", texto: "oi" };
const mover = { tipo: "mover_funil", funil: "Vendas", etapa: "Novo" };
const responsavel = {
  tipo: "atribuir_responsavel",
  responsaveis: [{ tipo: "usuario", id: "11111111-1111-1111-1111-111111111111", nome: "Fulano" }],
};
const etiquetar = { tipo: "etiquetar", etiquetas: ["a"], modo: "adicionar" };
const nota = { tipo: "nota_interna", texto: "x" };
const status = { tipo: "mudar_status", status: "atendimento" };

// as tres acoes do painel passam em canal somente leitura...
for (const acao of [mover, responsavel, { tipo: "espera", segundos: 5 }]) {
  assert.equal(
    motivoParaRecusarPuro(macroCom(acao), SO_LEITURA, LIM),
    null,
    `acao ${(acao as any).tipo} devia rodar em canal somente leitura`
  );
}
// ...e as que mexem na conversa/mensagem do canal NAO passam, dizendo qual foi
for (const acao of [enviar, etiquetar, nota, status]) {
  const m = motivoParaRecusarPuro(macroCom(acao), SO_LEITURA, LIM);
  assert.ok(m && m.includes("somente leitura"), `acao ${(acao as any).tipo} devia ser recusada`);
  assert.ok(m!.includes((acao as any).tipo), `a recusa precisa dizer QUAL acao barrou, veio: ${m}`);
}
// macro misto: basta UMA acao proibida pra recusar o conjunto (nada roda pela metade)
{
  const m = motivoParaRecusarPuro(macroCom(mover, enviar), SO_LEITURA, LIM);
  assert.ok(m && m.includes("enviar_texto"), `esperava recusa citando enviar_texto, veio: ${m}`);
}
// canal normal: tudo isso passa (a regra nova nao pode ter apertado o caso comum)
for (const acao of [enviar, etiquetar, nota, status, mover, responsavel]) {
  assert.equal(motivoParaRecusarPuro(macroCom(acao), CABEADO, LIM), null, `acao ${(acao as any).tipo} em canal normal`);
}
// envio nao cabeado barra so quem envia
assert.ok(
  motivoParaRecusarPuro(macroCom(enviar), { soLeitura: false, envioCabeado: false }, LIM)!.includes(
    "envio nao configurado"
  )
);
assert.equal(motivoParaRecusarPuro(macroCom(mover), { soLeitura: false, envioCabeado: false }, LIM), null);
// e os limites que ja valiam continuam valendo
assert.ok(
  motivoParaRecusarPuro(macroCom({ tipo: "espera", segundos: 3600 }), CABEADO, LIM)!.includes("espera inline")
);
assert.ok(
  motivoParaRecusarPuro(
    macroCom({ tipo: "espera", segundos: 15 }, { tipo: "espera", segundos: 15 }, { tipo: "espera", segundos: 15 }),
    CABEADO,
    LIM
  )!.includes("somam mais de")
);
assert.deepEqual(
  [...ACOES_SO_DO_PAINEL].sort(),
  // contexto entrou em 31/08/2026 (frente L): mora em mensageria.conversa_contexto,
  // chaveada por (canal, chat_id) — memoria do PAINEL, nao escreve na origem
  ["atribuir_responsavel", "definir_contexto", "espera", "limpar_contexto", "mover_funil"],
  "mexeu na lista de acoes so-do-painel? confira canal somente leitura"
);

// ============================================ 3) CONVERSOR (ChatGuru)
// Como a acao FUNIL do ChatGuru e lida (medido em 31/08/2026): UM select
// `steps_ids` POR FUNIL da conta, na ordem do catalogo; o valor e o NOME da
// etapa escolhida. E a POSICAO que diz o funil.
const funisCg = [
  { id: "f1", nome: "Vendas", etapas: [{ id: "e1", nome: "Novo" }, { id: "e2", nome: "Fechamento" }] },
  { id: "f2", nome: "Pós-venda", etapas: [{ id: "e3", nome: "Fechamento" }] },
];
const PLACEHOLDER = "- Selecione a Etapa -";

function dialogoFunil(selects: string[], extras: { nome: string; valor: string }[] = []) {
  return {
    dialogo_id: "d1",
    campos: [
      { nome: "title", valor: "Macro de teste" },
      { nome: "node_type", valor: "Manual" },
      { nome: "action_id", valor: "a1" },
      { nome: "action_type", valor: "FUNIL" },
      ...selects.map((valor) => ({ nome: "steps_ids", valor })),
      ...extras,
    ],
  };
}

{
  // etapa escolhida na posicao do SEGUNDO funil: "Fechamento" e de Pos-venda,
  // nao de Vendas. E o teste que separa "resolvi" de "chutei".
  const r = converterDialogo(dialogoFunil([PLACEHOLDER, "Fechamento"]), { funis: funisCg });
  assert.equal(r.estado, "convertido", `esperava convertido, veio ${r.estado} (${r.motivo || ""})`);
  assert.deepEqual(r.fluxo.nos[0].acao, { tipo: "mover_funil", funil: "Pós-venda", etapa: "Fechamento" });
  assert.equal(validarFluxo(r.fluxo).ok, true, "o fluxo convertido passa no schema canonico");
}
{
  // duas escolhas na mesma acao viram DUAS acoes canonicas
  const r = converterDialogo(dialogoFunil(["Novo", "Fechamento"]), { funis: funisCg });
  assert.equal(r.fluxo.nos.length, 2);
  assert.deepEqual(r.fluxo.nos.map((n: any) => n.acao.funil), ["Vendas", "Pós-venda"]);
}
{
  // funnel_remove traz o ID do funil (resolvido por id, nunca por nome)
  const r = converterDialogo(
    dialogoFunil([PLACEHOLDER, PLACEHOLDER], [{ nome: "funnel_remove", valor: "f1" }]),
    { funis: funisCg }
  );
  assert.deepEqual(r.fluxo.nos[0].acao, { tipo: "mover_funil", funil: "Vendas", etapa: null }, "remocao vira saida do funil");
}
{
  const r = converterDialogo(dialogoFunil([PLACEHOLDER, PLACEHOLDER]), { funis: funisCg });
  assert.equal(r.estado, "nao", "acao FUNIL sem escolha nenhuma nao vira acao");
  assert.ok(r.ressalvas.some((x: string) => x.includes("sem etapa escolhida")), r.ressalvas.join(" | "));
}
{
  // sem catalogo NAO se chuta por nome — vira ressalva
  const r = converterDialogo(dialogoFunil(["Fechamento"]), {});
  assert.equal(r.estado, "nao");
  assert.ok(r.ressalvas.some((x: string) => x.includes("chatlist_funnels.json")), r.ressalvas.join(" | "));
}
{
  // numero de selects diferente do numero de funis: a posicao deixou de
  // identificar o funil, entao converter seria adivinhar
  const r = converterDialogo(dialogoFunil(["Novo", "Fechamento", "Extra"]), { funis: funisCg });
  assert.equal(r.estado, "nao");
  assert.ok(r.ressalvas.some((x: string) => x.includes("posicao deixou de identificar")), r.ressalvas.join(" | "));
}
{
  // etapa escolhida que nao pertence ao funil daquela posicao
  const r = converterDialogo(dialogoFunil(["Fechamento de Pós", PLACEHOLDER]), { funis: funisCg });
  assert.equal(r.estado, "nao");
  assert.ok(r.ressalvas.some((x: string) => x.includes("nao e etapa do funil")), r.ressalvas.join(" | "));
}

// ============================================ 4) IMPORTADOR (--dry)
// Roda a CLI de verdade contra o fixture sintetico e confere as linhas.
{
  const trabalho = fs.mkdtempSync(path.join(os.tmpdir(), "prova-funis-"));
  const dumpArq = path.join(trabalho, "linhas.json");
  const fixture = path.join(AQUI, "importar", "fixture-funis");
  execFileSync(
    process.execPath,
    [
      path.join(AQUI, "importar", "funis.mjs"),
      "--funis", path.join(fixture, "funis-normalizados.json"),
      "--conversas", path.join(fixture, "conversas.json"),
      "--dry",
      "--trabalho", trabalho,
      "--dump", dumpArq,
    ],
    { stdio: "pipe" }
  );
  const arq = fs.readdirSync(trabalho).find((f) => f.startsWith("relatorio-funis-") && f.endsWith(".json"))!;
  const e = JSON.parse(fs.readFileSync(path.join(trabalho, arq), "utf8"));
  const linhas = JSON.parse(fs.readFileSync(dumpArq, "utf8"));

  assert.equal(e.origem.funis, 2, "le os 2 funis do arquivo");
  assert.equal(e.origem.etapas, 3, "le as 3 etapas");
  assert.equal(e.destino.funis_criados, 2);
  assert.equal(e.destino.etapas_criadas, 3);
  assert.equal(e.conversas.lidas, 6);
  assert.equal(e.conversas.com_etapa, 5);
  assert.equal(e.conversas.sem_etapa, 1);
  assert.equal(e.destino.vinculos_gravados, 4, "4 vinculos (uma conversa esta em DOIS funis)");
  assert.deepEqual(
    Object.keys(e.nao_resolvidos).sort(),
    ["Funil | falso\n| coluna | injetada |", "etapa-que-nao-existe"].sort(),
    "o valor que nao casa vira pendencia, nao palpite"
  );

  // COR: entra a valida, a fora do formato nao sobe (o CHECK do banco recusaria
  // o lote inteiro), e etapa sem cor fica sem cor — nada de cor inventada.
  assert.equal(e.origem.etapas_com_cor, 1, "so uma etapa do arquivo tem cor valida");
  assert.equal(e.destino.etapas_com_cor, 1);
  const etapaCriada = (nome: string) => linhas.etapas.find((x: any) => x.acao === "criar" && x.nome === nome);
  assert.equal(etapaCriada("Novo").cor, "#12AB34", "cor valida sobe normalizada");
  assert.ok(!("cor" in etapaCriada("Fechamento")), "cor fora do hex NAO vai pro banco");
  assert.ok(
    e.pendencias.every((p: any) => p.tema !== "cor"),
    "com cor no arquivo, nao ha pendencia de cor"
  );

  const doChat = (id: string) => linhas.vinculos.filter((v: any) => v.chat_id === id);
  assert.equal(doChat("5500900000002").length, 2, "a conversa em 2 funis gera 2 vinculos");
  assert.equal(
    new Set(doChat("5500900000002").map((v: any) => v.funil_id)).size,
    2,
    "e os dois vinculos sao de funis DIFERENTES (o 'Fechamento' de cada um)"
  );
  assert.deepEqual(
    doChat("5500900000003").map((v: any) => v.etapa_id),
    doChat("5500900000002").map((v: any) => v.etapa_id).slice(1),
    "id cru de etapa (nao resolvido no import de conversas) casa pela origem"
  );
  assert.equal(doChat("5500900000001")[0].definido_por_id, null, "importacao assina como automacao (id null)");
  assert.ok(
    String(doChat("5500900000001")[0].definido_por_nome).startsWith("importacao "),
    "com o nome do sistema de origem"
  );

  const md = fs.readFileSync(path.join(trabalho, arq.replace(/\.json$/, ".md")), "utf8");
  assert.ok(md.includes("SIMULACAO (--dry)"), "o relatorio diz em alto e bom som que nada foi gravado");
  assert.ok(!md.includes("undefined"), "o relatorio nao tem buraco");
  assert.ok(!md.includes("5500900000001"), "relatorio nao carrega telefone de conversa");

  // O valor de etapa vem de meta_chatguru = CONTEUDO DE TERCEIRO. Com pipe e
  // quebra de linha crus ele deformaria a tabela — escondendo justamente a
  // pendencia que a tabela existe pra mostrar.
  const linhasTabela = md.split("\n").filter((l) => l.startsWith("| Funil "));
  assert.equal(linhasTabela.length, 1, "o valor hostil ocupa UMA linha da tabela, nao varias");
  assert.ok(linhasTabela[0].includes("\\|"), "o pipe do valor de terceiro sai escapado");
  // conta as colunas REAIS: pipe escapado (\|) e conteudo, nao separador
  const colunas = linhasTabela[0].replace(/\\\|/g, "").split("|").length - 2;
  assert.equal(colunas, 2, `a linha continua com 2 colunas, veio: ${linhasTabela[0]}`);
  assert.ok(!md.includes("| coluna | injetada |"), "nenhuma coluna injetada pelo conteudo de terceiro");
  fs.rmSync(trabalho, { recursive: true, force: true });
}

console.log("prova-funis: OK");
