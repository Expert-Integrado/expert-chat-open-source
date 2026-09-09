// Prova das regras do editor/gestao de fluxos (Frente K).
// Roda em Node >= 22.6 sem build: `node scripts/prova-editor-fluxo.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// O que esta prova garante, em uma linha cada:
//   - pasta e caminho saneado, e mover/renomear pasta nunca pega arvore vizinha;
//   - o grafo responde "quem chama este fluxo" (o requisito do card, nao um extra);
//   - o mapa corta ciclo em vez de laco infinito, e nao esconde fluxo nenhum;
//   - o que o editor monta SEMPRE passa por validarFluxo (o mesmo portao do save);
//   - fluxo invalido/hostil continua inspecionavel, sem excecao e sem HTML cru.
//
// FIXTURES SAO SINTETICAS: nenhum dialogo de cliente entra no repo (mesma regra
// de scripts/prova-fluxo.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  acaoPadrao, alvoDaChamada, arvoreDePastas, aplicarPatchNoFluxo, casaBusca, chamadasDoFluxo,
  classificarChamadas, escaparLike, LIMITE_LINHAS_MAPA, LIMITE_NOME_FLUXO, linhasDoMapa, montarGrafo, moverPasso,
  moverPasta, noPadrao, nomeDeCopia, normalizarPasta, pastaContem, pastaPai, passosDoFluxo, PREFIXO_COPIA,
  reencadear, removerPasso, segmentosPasta, aplicarPatchNoPasso,
  slugDeNome, slugLivre, slugValido, sugerirHierarquia, textoDoFluxo,
} from "../lib/fluxo/editor.ts";
import {
  acoesDoFluxo, esperaTotalSegundos, nosComAvalQueImporta, ordemDeExecucao, passosQueRodam,
  validarFluxo, type Fluxo,
} from "../lib/fluxo/schema.ts";

let feitos = 0;
const t = (nome: string, fn: () => void) => {
  fn();
  feitos++;
  console.log(`  ok  ${nome}`);
};

const ok = (r: ReturnType<typeof validarFluxo>): Fluxo => {
  assert.equal(r.ok, true, "esperava fluxo valido, veio: " + (r.ok ? "" : r.erros.join(" | ")));
  return (r as { ok: true; fluxo: Fluxo }).fluxo;
};

// ==================================================================== 1) PASTAS
console.log("\n1) pastas aninhaveis");

t("normaliza caminho: espaco, vazio e separador solto", () => {
  assert.equal(normalizarPasta("  CRM /  Educacional  "), "CRM / Educacional");
  assert.equal(normalizarPasta("CRM //  / SaaS"), "CRM / SaaS");
  assert.equal(normalizarPasta("   "), "", "so espaco vira raiz");
  assert.equal(normalizarPasta(null), "", "entrada invalida vira raiz, nunca erro");
  assert.equal(normalizarPasta(42), "");
});

t("caractere de controle no nome da pasta nao sobrevive", () => {
  const bruta = `CRM ${String.fromCharCode(9)}${String.fromCharCode(7)}/ Educacional${String.fromCharCode(0)}`;
  const suja = normalizarPasta(bruta);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(suja), `sobrou controle: ${JSON.stringify(suja)}`);
  assert.equal(suja, "CRM / Educacional");
});

t("profundidade e tamanho tem teto", () => {
  const funda = normalizarPasta("a/b/c/d/e/f/g/h");
  assert.equal(segmentosPasta(funda).length, 5, "teto de 5 niveis");
  const longa = normalizarPasta("x".repeat(200));
  assert.ok(longa.length <= 60, "segmento cortado no limite");
});

t("pastaContem compara SEGMENTO, nunca prefixo de texto", () => {
  assert.equal(pastaContem("Vendas", "Vendas / B2B"), true);
  assert.equal(
    pastaContem("Vendas", "Vendas B2B"),
    false,
    "prefixo de string nao pode arrastar arvore vizinha"
  );
  assert.equal(pastaContem("", "qualquer / coisa"), true, "raiz contem tudo");
  assert.equal(pastaContem("Vendas / B2B", "Vendas"), false);
});

t("renomear/mover pasta reescreve so a subarvore certa", () => {
  assert.equal(moverPasta("CRM / SaaS", "CRM", "Comercial"), "Comercial / SaaS");
  assert.equal(moverPasta("CRM / SaaS / Ativo", "CRM / SaaS", "Ativos"), "Ativos / Ativo");
  assert.equal(
    moverPasta("CRM Antigo / SaaS", "CRM", "Comercial"),
    "CRM Antigo / SaaS",
    "pasta de nome parecido fica onde estava"
  );
  assert.equal(moverPasta("Solta", "CRM", "Comercial"), "Solta");
  assert.equal(pastaPai("CRM / SaaS / Ativo"), "CRM / SaaS");
  assert.equal(pastaPai("CRM"), "");
});

t("arvore cria pasta intermediaria e conta a subarvore", () => {
  const arv = arvoreDePastas(["CRM / SaaS", "CRM / SaaS", "CRM / Educacional", "Campanhas"]);
  const crm = arv.find((n) => n.caminho === "CRM")!;
  assert.ok(crm, "pasta intermediaria CRM existe mesmo sem fluxo direto");
  assert.equal(crm.fluxos, 0, "nenhum fluxo mora direto em CRM");
  assert.equal(crm.total, 3, "pasta fechada mostra o total da subarvore");
  assert.equal(crm.filhas.length, 2);
  assert.equal(crm.filhas.find((f) => f.nome === "SaaS")!.fluxos, 2);
  assert.equal(arv.find((n) => n.caminho === "Campanhas")!.total, 1);
});

t("hierarquia por separador e SUGESTAO, nunca aplicada sozinha", () => {
  assert.equal(sugerirHierarquia("CRM | Educacional"), "CRM / Educacional");
  assert.equal(sugerirHierarquia("Campanhas > Disparo simples"), "Campanhas / Disparo simples");
  assert.equal(sugerirHierarquia("Boas-vindas"), null, "sem separador, nada a sugerir");
  assert.equal(sugerirHierarquia(""), null);
  assert.equal(sugerirHierarquia(null), null);
  // a funcao SO devolve texto: quem aplica e a tela, depois do humano confirmar
});

// ===================================================================== 2) SLUG
console.log("\n2) slug e busca");

t("slug gerado e sempre valido, mesmo de nome hostil", () => {
  assert.equal(slugDeNome("Saudação Inicial!"), "saudacao-inicial");
  assert.equal(slugDeNome("   "), "fluxo", "nome vazio nao gera slug vazio");
  assert.equal(slugDeNome("../../etc/passwd"), "etc-passwd", "travessia de caminho nao sobrevive");
  assert.ok(slugValido(slugDeNome("<script>alert(1)</script>")), "slug de nome com HTML segue valido");
  assert.ok(slugValido(slugDeNome("x".repeat(300))), "nome enorme cabe no limite");
  assert.equal(slugValido("nao vale espaco"), false);
  assert.equal(slugValido("../fuga"), false, "id/slug com barra e recusado antes de virar URL");
});

t("slug livre nao colide ao duplicar", () => {
  const usados = ["boas-vindas", "boas-vindas-2"];
  assert.equal(slugLivre("Boas-vindas", usados), "boas-vindas-3");
  assert.equal(slugLivre("Outro", usados), "outro");
});

t("escaparLike neutraliza coringa digitado (% e _)", () => {
  assert.equal(escaparLike("10%"), "10\\%", "% digitado nao pode virar coringa");
  assert.equal(escaparLike("nome_x"), "nome\\_x");
  assert.equal(escaparLike("a,b"), "a\\,b", "virgula quebraria a lista do filtro");
  assert.equal(escaparLike(null), "");
});

t("busca por nome e busca por CONTEUDO dos passos", () => {
  const item = {
    nome: "Menu URA",
    pasta: "CRM / SaaS",
    fluxo: {
      id: "menu",
      nos: [{ id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "Digite $URA para seguir" } }],
    },
  };
  assert.equal(casaBusca(item, "menu"), true);
  assert.equal(casaBusca(item, "MENU"), true, "busca ignora caixa");
  assert.equal(casaBusca(item, "saas"), true, "acha pelo caminho da pasta");
  assert.equal(casaBusca(item, "$URA", "nome"), false, "conteudo nao entra na busca por nome");
  assert.equal(casaBusca(item, "$URA", "conteudo"), true, "variavel usada e encontrada no conteudo");
  assert.equal(casaBusca(item, "", "nome"), true, "termo vazio nao filtra nada");
  assert.ok(textoDoFluxo(item.fluxo).includes("Digite $URA"));
});

// ==================================================================== 3) GRAFO
console.log("\n3) mapa da rede (nivel 1)");

const fluxoQueChama = (id: string, alvos: string[]) => ({
  id,
  nome: id,
  tipo: "gatilho",
  versao: 1,
  nos: alvos.map((a, i) => ({
    id: `n${i + 1}`,
    tipo: "acao",
    acao: { tipo: "chamar_fluxo", fluxo: a },
    ...(i < alvos.length - 1 ? { proximo: `n${i + 2}` } : {}),
  })),
});

t("alvo da chamada e lido de forma tolerante, e so se for slug valido", () => {
  assert.equal(alvoDaChamada({ tipo: "chamar_fluxo", fluxo: "menu" }), "menu");
  assert.equal(alvoDaChamada({ tipo: "dialogo", alvo: "menu" }), "menu", "alias de outro conversor");
  assert.equal(alvoDaChamada({ tipo: "enviar_texto", texto: "menu" }), null, "acao que nao e chamada");
  assert.equal(alvoDaChamada({ tipo: "chamar_fluxo", fluxo: "../fuga" }), null, "alvo invalido nao vira aresta");
  assert.equal(alvoDaChamada(null), null);
  assert.equal(alvoDaChamada("texto solto"), null);
});

t("chamadas do fluxo: sem repeticao e sem auto-chamada", () => {
  const f = fluxoQueChama("a", ["b", "b", "a", "c"]);
  assert.deepEqual(chamadasDoFluxo(f), ["b", "c"]);
  assert.deepEqual(chamadasDoFluxo({}), [], "fluxo sem nos nao explode");
  assert.deepEqual(chamadasDoFluxo(null), []);
});

// AS DUAS STRINGS EXATAS que scripts/fluxo/converter-chatguru.mjs grava na
// ressalva. Copiadas do conversor (frente-c), NAO adivinhadas — e o unico jeito
// de esta prova falhar se alguem mudar o texto de la e criar colisao entre os
// dois casos.
const RESSALVA_SEM_ALVO =
  "acao DIALOGO sem alvo configurado (nenhum dialogo selecionado no formulario): nao havia chamada a trazer";
const RESSALVA_ALVO_NOMEADO =
  "acao DIALOGO: chama outro dialogo (encadeamento); chamar outro fluxo e v2";

const comRessalva = (id: string, ressalvas: string[]) => ({
  id, nos: [],
  origem: { ferramenta: "chatguru", id_original: "x", ressalvas },
});

t("chamada com alvo real: presenca marcada, sem inventar aresta", () => {
  const f = comRessalva("a", [RESSALVA_ALVO_NOMEADO]);
  const c = classificarChamadas(f);
  assert.equal(c.alvo_nomeado, true, "havia chamada com alvo de verdade");
  assert.equal(c.sem_alvo, false, "e nao pode ser confundida com 'nunca teve alvo'");
  assert.deepEqual(chamadasDoFluxo(f), [], "nao trazida NAO vira aresta chutada");
  assert.deepEqual(classificarChamadas({ id: "a", nos: [] }), { sem_alvo: false, alvo_nomeado: false });
});

t("chamada SEM ALVO nunca e contada como perda", () => {
  // Medicao da frente-c (31/08/2026, 33 backups): das 3.607 acoes DIALOGO,
  // 1.205 (33%) sao o placeholder "-- SELECIONE O DIALOGO --" e NUNCA tiveram
  // destino. Tratar isso como perda acusaria um buraco que nao existe.
  const c = classificarChamadas(comRessalva("a", [RESSALVA_SEM_ALVO]));
  assert.equal(c.sem_alvo, true);
  assert.equal(c.alvo_nomeado, false, "placeholder NAO e aresta real esperando a acao");
});

t("as duas strings do conversor nao colidem", () => {
  // se o texto de uma passar a casar com o marcador da outra, o numero da tela
  // inverte de sentido em silencio — por isso isto e assercao, nao observacao
  const so1 = classificarChamadas(comRessalva("a", [RESSALVA_SEM_ALVO]));
  const so2 = classificarChamadas(comRessalva("b", [RESSALVA_ALVO_NOMEADO]));
  assert.deepEqual(so1, { sem_alvo: true, alvo_nomeado: false });
  assert.deepEqual(so2, { sem_alvo: false, alvo_nomeado: true });

  // um fluxo pode ter os DOIS casos (a frente-c mediu a sobreposicao)
  const ambos = classificarChamadas(comRessalva("c", [RESSALVA_SEM_ALVO, RESSALVA_ALVO_NOMEADO]));
  assert.deepEqual(ambos, { sem_alvo: true, alvo_nomeado: true });
});

t("o grafo conta FLUXOS, nunca chamadas", () => {
  // a ressalva e deduplicada por fluxo (Array.from(new Set(...)) no conversor):
  // um fluxo com 15 chamadas chega com UMA ressalva. Entao somar ressalva e
  // chamar de "N chamadas" seria numero inventado.
  const g = montarGrafo([
    { slug: "a", nome: "A", pasta: "", ativo: true, fluxo: comRessalva("a", [RESSALVA_ALVO_NOMEADO]) },
    { slug: "b", nome: "B", pasta: "", ativo: true, fluxo: comRessalva("b", [RESSALVA_ALVO_NOMEADO, RESSALVA_SEM_ALVO]) },
    { slug: "c", nome: "C", pasta: "", ativo: true, fluxo: comRessalva("c", [RESSALVA_SEM_ALVO]) },
    { slug: "d", nome: "D", pasta: "", ativo: true, fluxo: { id: "d", nos: [] } },
  ]);
  assert.equal(g.fluxos_com_alvo_nao_trazido, 2, "A e B");
  assert.equal(g.fluxos_sem_alvo, 2, "B e C");
  assert.equal(g.arestas, 0, "nenhuma aresta real ainda");
});

t("a tela nao afirma PERDA de chamada", () => {
  const src = readFileSync(new URL("../app/fluxos/page.tsx", import.meta.url), "utf8");
  assert.equal(
    /perdida\(s\)|chamadas perdidas/i.test(src),
    false,
    "33% das chamadas do acervo nunca tiveram alvo: a tela diz 'nao trazida', nunca 'perdida'"
  );
});

t("QUEM CHAMA ESTE FLUXO — a lista que o card exige", () => {
  const chamadores = Array.from({ length: 69 }, (_, i) => ({
    slug: `c${i + 1}`,
    nome: `Chamador ${i + 1}`,
    pasta: "",
    ativo: true,
    fluxo: fluxoQueChama(`c${i + 1}`, ["manter-resolvido"]),
  }));
  const g = montarGrafo([
    ...chamadores,
    { slug: "manter-resolvido", nome: "Manter status resolvido", pasta: "", ativo: true, fluxo: { id: "manter-resolvido", nos: [] } },
  ]);
  const alvo = g.nos.find((n) => n.slug === "manter-resolvido")!;
  assert.equal(alvo.chamado_por.length, 69, "quem mexe neste fluxo precisa ver os 69 lugares");
  assert.equal(g.arestas, 69);
  assert.ok(!g.raizes.includes("manter-resolvido"), "fluxo chamado nao e raiz");
  assert.equal(g.raizes.length, 69, "os 69 chamadores sao pontos de entrada");
});

t("alvo inexistente vira pendencia declarada, nao aresta fantasma", () => {
  const g = montarGrafo([
    { slug: "a", nome: "A", pasta: "", ativo: true, fluxo: fluxoQueChama("a", ["sumiu"]) },
  ]);
  assert.deepEqual(g.nos[0].alvos_ausentes, ["sumiu"]);
  assert.equal(g.arestas, 0);
});

t("hub alcancavel por varios caminhos e expandido UMA vez", () => {
  // Sem isto, o ciclo estaria coberto e o hub ainda explodiria: cada caminho
  // que chega nele reexpandiria a subarvore, com custo no numero de CAMINHOS.
  // Na rede medida existe fluxo chamado por 69 lugares.
  const itens = [
    { slug: "r1", nome: "R1", pasta: "", ativo: true, fluxo: fluxoQueChama("r1", ["hub"]) },
    { slug: "r2", nome: "R2", pasta: "", ativo: true, fluxo: fluxoQueChama("r2", ["hub"]) },
    { slug: "r3", nome: "R3", pasta: "", ativo: true, fluxo: fluxoQueChama("r3", ["hub"]) },
    { slug: "hub", nome: "Hub", pasta: "", ativo: true, fluxo: fluxoQueChama("hub", ["f1", "f2"]) },
    { slug: "f1", nome: "F1", pasta: "", ativo: true, fluxo: { id: "f1", nos: [] } },
    { slug: "f2", nome: "F2", pasta: "", ativo: true, fluxo: { id: "f2", nos: [] } },
  ];
  const linhas = linhasDoMapa(montarGrafo(itens));
  const hubs = linhas.filter((l) => l.slug === "hub");
  assert.equal(hubs.length, 3, "o hub aparece embaixo de cada um dos 3 chamadores");
  assert.equal(hubs.filter((h) => !h.repetido).length, 1, "mas so UM deles e o expandido");
  assert.equal(hubs.filter((h) => h.repetido).length, 2, "os outros dois vem marcados como repetido");
  // a subarvore do hub (f1, f2) foi desenhada uma vez so
  assert.equal(linhas.filter((l) => l.slug === "f1").length, 1, "f1 nao foi redesenhado por caminho");
  assert.equal(linhas.filter((l) => l.slug === "f2").length, 1);
  // e nada desapareceu
  for (const it of itens) {
    assert.ok(linhas.some((l) => l.slug === it.slug), `${it.slug} sumiu do mapa`);
  }
});

t("cluster dentro de ciclo nao e emitido duas vezes", () => {
  // O laco de orfaos usava um RETRATO de `vistos` tirado antes dele: o primeiro
  // fluxo do cluster puxava os outros, e eles eram emitidos de novo na propria
  // iteracao do laco.
  const g = montarGrafo([
    { slug: "a", nome: "A", pasta: "", ativo: true, fluxo: fluxoQueChama("a", ["b"]) },
    { slug: "b", nome: "B", pasta: "", ativo: true, fluxo: fluxoQueChama("b", ["c"]) },
    { slug: "c", nome: "C", pasta: "", ativo: true, fluxo: fluxoQueChama("c", ["a"]) },
  ]);
  assert.deepEqual(g.raizes, [], "ciclo fechado nao tem raiz nenhuma");
  const linhas = linhasDoMapa(g);
  for (const s of ["a", "b", "c"]) {
    const vezes = linhas.filter((l) => l.slug === s && !l.repetido).length;
    assert.equal(vezes, 1, `${s} deveria ser expandido exatamente 1 vez, veio ${vezes}`);
  }
});

t("mapa tem teto de linhas", () => {
  // cadeia longa: o teto corta antes de virar desenho impagavel
  const itens = Array.from({ length: 60 }, (_, i) => ({
    slug: `n${i}`, nome: `N${i}`, pasta: "", ativo: true,
    fluxo: fluxoQueChama(`n${i}`, i < 59 ? [`n${i + 1}`] : []),
  }));
  const linhas = linhasDoMapa(montarGrafo(itens));
  assert.ok(linhas.length <= LIMITE_LINHAS_MAPA, "respeita o teto");
  assert.ok(linhas.length > 0, "e desenha algo");
  // profundidade tem teto proprio: cadeia de 60 nao desce 60 niveis
  assert.ok(Math.max(...linhas.map((l) => l.nivel)) <= 12, "profundidade limitada");
});

t("mapa corta ciclo e nao esconde fluxo nenhum", () => {
  const g = montarGrafo([
    { slug: "a", nome: "A", pasta: "", ativo: true, fluxo: fluxoQueChama("a", ["b"]) },
    { slug: "b", nome: "B", pasta: "", ativo: true, fluxo: fluxoQueChama("b", ["a"]) },
    { slug: "solto", nome: "Solto", pasta: "", ativo: true, fluxo: { id: "solto", nos: [] } },
  ]);
  const linhas = linhasDoMapa(g);
  assert.ok(linhas.some((l) => l.repetido), "o ciclo aparece marcado como repetido");
  const slugs = new Set(linhas.map((l) => l.slug));
  for (const s of ["a", "b", "solto"]) {
    assert.ok(slugs.has(s), `fluxo ${s} sumiu do mapa`);
  }
  assert.ok(linhas.length < 50, "ciclo cortado, nunca laco infinito");
});

// =============================================================== 4) PASSOS
console.log("\n4) painel de passos (nivel 2)");

t("passos saem na ORDEM da corrente, e o no solto fica marcado", () => {
  const raw = {
    id: "f",
    nome: "F",
    tipo: "macro",
    versao: 1,
    nos: [
      { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "Oi" }, proximo: "n2" },
      { id: "n2", tipo: "espera", acao: { tipo: "espera", segundos: 5 } },
      { id: "orfao", tipo: "acao", acao: { tipo: "mudar_status", status: "concluido" } },
    ],
  };
  const passos = passosDoFluxo(raw);
  assert.deepEqual(passos.map((p) => p.id), ["n1", "n2", "orfao"]);
  assert.equal(passos[0].na_corrente, true);
  assert.equal(passos[2].na_corrente, false, "no fora da corrente NAO roda — a tela tem que dizer");
  assert.equal(passos[0].resumo, "Oi");
  assert.equal(passos[1].resumo, "5s");
});

t("resumo cobre cada tipo de acao, sempre TEXTO", () => {
  const passos = passosDoFluxo({
    id: "f",
    nos: [
      { id: "n1", tipo: "acao", acao: { tipo: "etiquetar", etiquetas: ["vip"], modo: "adicionar" }, proximo: "n2" },
      { id: "n2", tipo: "acao", acao: { tipo: "mover_funil", funil: "Vendas", etapa: null }, proximo: "n3" },
      { id: "n3", tipo: "acao", acao: { tipo: "atribuir_responsavel", responsaveis: [{ tipo: "usuario", id: "u1", nome: "Ana" }] } },
    ],
  });
  assert.ok(passos[0].resumo.includes("vip"));
  assert.ok(passos[1].resumo.includes("(sair do funil)"), "sair do funil e explicito na tela");
  assert.equal(passos[2].resumo, "Ana");
  for (const p of passos) assert.equal(typeof p.resumo, "string");
});

t("fluxo HOSTIL/invalido continua inspecionavel, sem excecao", () => {
  const hostil = {
    id: "x",
    nos: [
      { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "<img src=x onerror=alert(1)>" } },
      { id: 42, tipo: null, acao: "nao sou objeto" },
      null,
      { id: "n1", tipo: "acao", acao: { tipo: "danca" } },
    ],
  };
  const passos = passosDoFluxo(hostil);
  assert.equal(passos.length, 4, "toda linha aparece, inclusive a quebrada");
  assert.ok(
    passos[0].resumo.includes("<img"),
    "o texto perigoso e mostrado como TEXTO (React escapa); nunca vira HTML"
  );
  assert.equal(passos[1].id.startsWith("(sem id"), true);
  assert.equal(validarFluxo(hostil).ok, false, "e de fato invalido — e mesmo assim da pra olhar");
});

t("nos e fluxo nulos nao derrubam a tela", () => {
  assert.deepEqual(passosDoFluxo(null), []);
  assert.deepEqual(passosDoFluxo({ nos: "nao sou lista" }), []);
});

// ======================================== 5) MONTAGEM — o mesmo portao do save
console.log("\n5) montar/editar passo, com validarFluxo como portao unico");

const macroDe = (nos: any[]) => ({ id: "m1", nome: "Macro", tipo: "macro", versao: 1, nos });

t("o caso majoritario: 1 passo de resposta monta e valida", () => {
  const no = noPadrao("enviar_texto")!;
  no.acao.texto = "Oi!";
  const f = ok(validarFluxo(macroDe(reencadear([no]))));
  assert.equal(f.nos.length, 1);
  assert.equal(f.nos[0].proximo, undefined, "passo unico nao aponta pra lugar nenhum");
});

t("adicionar, reordenar e remover mantem a corrente valida", () => {
  const nos = reencadear([
    { tipo: "acao", acao: { tipo: "enviar_texto", texto: "um" } },
    { tipo: "acao", acao: { tipo: "enviar_texto", texto: "dois" } },
    { tipo: "acao", acao: { tipo: "enviar_texto", texto: "tres" } },
  ]);
  assert.deepEqual(nos.map((n) => n.id), ["n1", "n2", "n3"]);
  assert.equal(nos[2].proximo, undefined, "o ultimo encerra a corrente");

  const movido = moverPasso(nos, 2, 0);
  assert.equal((movido[0].acao as any).texto, "tres", "o passo movido foi pro topo");
  const fm = ok(validarFluxo(macroDe(movido)));
  assert.deepEqual(fm.nos.map((n) => n.id), ["n1", "n2", "n3"], "ids reencadeados, sem buraco");

  const menos = removerPasso(movido, 1);
  assert.equal(menos.length, 2);
  const fr = ok(validarFluxo(macroDe(menos)));
  assert.equal(fr.nos[1].proximo, undefined);
  assert.equal(fr.nos[0].proximo, "n2", "removeu o do meio e a corrente continua ligada");

  // indice fora da faixa nao corrompe nada
  assert.equal(removerPasso(menos, 99).length, 2);
  assert.equal(moverPasso(menos, 0, 99).length, 2);
});

t("toda acao padrao do editor cabe no schema depois de preenchida", () => {
  const preencher: Record<string, (a: any) => void> = {
    enviar_texto: (a) => (a.texto = "oi"),
    nota_interna: (a) => (a.texto = "nota"),
    etiquetar: (a) => (a.etiquetas = ["vip"]),
    mudar_status: () => {},
    atribuir_responsavel: (a) =>
      (a.responsaveis = [{ tipo: "usuario", id: "11111111-1111-1111-1111-111111111111", nome: "Ana" }]),
    mover_funil: (a) => ((a.funil = "Vendas"), (a.etapa = "Novo")),
    espera: () => {},
  };
  for (const [tipo, prep] of Object.entries(preencher)) {
    const no = noPadrao(tipo);
    assert.ok(no, `noPadrao(${tipo}) deveria existir`);
    prep(no!.acao);
    const r = validarFluxo(macroDe(reencadear([no])));
    assert.equal(r.ok, true, `${tipo} nao validou: ${r.ok ? "" : r.erros.join(" | ")}`);
  }
  assert.equal(acaoPadrao("acao_que_nao_existe"), null);
  assert.equal(noPadrao("acao_que_nao_existe"), null);
});

t("edicao rapida escreve no MESMO modelo do editor", () => {
  const base = ok(validarFluxo(macroDe([{ id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "oi" } }])));
  const comDesc = aplicarPatchNoFluxo(base, { nome: "  Novo nome  ", descricao: "explica" });
  const f1 = ok(validarFluxo(comDesc));
  assert.equal(f1.nome, "Novo nome", "nome trimado");
  assert.equal(f1.descricao, "explica");
  assert.deepEqual(f1.nos, base.nos, "edicao rapida nao encosta nos passos");

  const semDesc = ok(validarFluxo(aplicarPatchNoFluxo(comDesc, { descricao: "" })));
  assert.equal(semDesc.descricao, undefined, "descricao vazia REMOVE a descricao");

  const intacto = ok(validarFluxo(aplicarPatchNoFluxo(comDesc, {})));
  assert.equal(intacto.nome, "Novo nome", "campo ausente no patch nao mexe no valor atual");

  // nome vazio nao apaga o nome (o fluxo ficaria invalido no banco)
  const vazio = ok(validarFluxo(aplicarPatchNoFluxo(comDesc, { nome: "   " })));
  assert.equal(vazio.nome, "Novo nome");
});

// ---------------------------------------------------------- DUPLICAR FLUXO
// Card 86ak86jw9: "copia com o titulo prefixado, na mesma pasta, DESLIGADA, com
// todas as acoes e condicoes; ID novo e nada compartilhado com o original".
t("nome da copia: prefixo, sem repetir e sem empilhar prefixo", () => {
  assert.equal(nomeDeCopia("Boas-vindas"), `${PREFIXO_COPIA}Boas-vindas`);
  assert.equal(
    nomeDeCopia("Boas-vindas", [`${PREFIXO_COPIA}Boas-vindas`]),
    `${PREFIXO_COPIA}Boas-vindas (2)`,
    "duplicar duas vezes nao pode dar duas linhas com o MESMO texto na lista"
  );
  assert.equal(
    nomeDeCopia(`${PREFIXO_COPIA}Boas-vindas`, [`${PREFIXO_COPIA}Boas-vindas`]),
    `${PREFIXO_COPIA}Boas-vindas (2)`,
    "copia da copia numera, nao empilha prefixo"
  );
  // comparacao sem caixa e sem acento: "COPIA DE x" ja e a copia de "x"
  assert.equal(
    nomeDeCopia("COPIA DE x", [`${PREFIXO_COPIA}x`, `${PREFIXO_COPIA}x (2)`]),
    `${PREFIXO_COPIA}x (3)`
  );
  assert.equal(nomeDeCopia(""), `${PREFIXO_COPIA}fluxo`, "nome vazio nao gera nome vazio");
  assert.equal(nomeDeCopia(null), `${PREFIXO_COPIA}fluxo`);
});

t("o teto do nome corta o NOME, nunca o prefixo nem o numero", () => {
  const longo = nomeDeCopia("y".repeat(400));
  assert.equal(longo.length, LIMITE_NOME_FLUXO, "cabe no limite que o schema aceita");
  assert.ok(longo.startsWith(PREFIXO_COPIA), "o marcador de copia sobrevive ao corte");
  const numerado = nomeDeCopia("y".repeat(400), [longo]);
  assert.ok(numerado.endsWith(" (2)"), "o numero tambem sobrevive");
  assert.ok(numerado.length <= LIMITE_NOME_FLUXO);
  // e o nome gravado tem que passar pelo portao unico de escrita
  const f = ok(validarFluxo({ ...macroDe([{ id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "oi" } }]), nome: numerado }));
  assert.equal(f.nome, numerado);
});

t("a copia nao COMPARTILHA nada com o original (editar uma nao muda a outra)", () => {
  // O caminho REAL da rota: aplicarPatchNoFluxo(nome) -> id novo -> validarFluxo.
  const original = ok(
    validarFluxo(
      macroDe([
        { id: "n1", tipo: "acao", acao: { tipo: "etiquetar", etiquetas: ["vip", "novo"], modo: "adicionar" } },
        {
          id: "n2",
          tipo: "condicao",
          condicao: { tipo: "e", condicoes: [{ tipo: "comparacao", campo: "status", operador: "igual", valor: "aberto" }] },
          proximo: "n3",
        },
        { id: "n3", tipo: "acao", acao: { tipo: "enviar_texto", texto: "oi" }, aprovacao: true },
      ])
    )
  );
  const bruto = aplicarPatchNoFluxo(original, { nome: nomeDeCopia(original.nome) });
  delete (bruto as any).origem;
  bruto.id = "copia-slug";
  const copia = ok(validarFluxo(bruto));

  assert.equal(copia.id, "copia-slug", "ID novo");
  assert.notEqual(copia.nome, original.nome);
  assert.equal(copia.nos.length, original.nos.length, "todas as acoes e condicoes vieram");
  assert.equal((copia.nos[2] as any).aprovacao, true, "a marca de aprovacao do passo veio junto");
  assert.deepEqual(
    (copia.nos[1] as any).condicao,
    (original.nos[1] as any).condicao,
    "a condicao estruturada veio igual"
  );

  // mexer na copia NAO pode alcancar o original — nem no array de etiquetas, nem
  // na arvore de condicao (as duas estruturas aninhadas do formato)
  (copia.nos[0].acao as any).etiquetas.push("vazou");
  (copia.nos[1] as any).condicao.condicoes[0].valor = "concluido";
  copia.nos.push({ id: "n9", tipo: "acao", acao: { tipo: "enviar_texto", texto: "so na copia" } });
  assert.deepEqual((original.nos[0].acao as any).etiquetas, ["vip", "novo"], "lista de etiquetas nao e compartilhada");
  assert.equal((original.nos[1] as any).condicao.condicoes[0].valor, "aberto", "arvore de condicao nao e compartilhada");
  assert.equal(original.nos.length, 3, "a lista de nos nao e compartilhada");
});


t("patch nao contrabandeia campo pra dentro do fluxo canonico", () => {
  const base = macroDe([{ id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "oi" } }]);
  const sujo = aplicarPatchNoFluxo({ ...base, pasta: "CRM", ativo: false }, { nome: "N" });
  const f = ok(validarFluxo(sujo));
  assert.equal((f as any).pasta, undefined, "pasta mora na COLUNA, nunca no jsonb");
  assert.equal((f as any).ativo, undefined, "ativo idem — validarFluxo descartaria em silencio");
});

// ------------------------------------------- EDICAO RAPIDA POR ACAO (86ak85nzy)
// A parte que a frente K declarou como NAO feita ("o schema nao tem esses
// campos"). Hoje tem `no.desligado`, e o atraso e a espera que vem ANTES da acao.
const macroTresPassos = () =>
  macroDe([
    { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "primeiro" }, proximo: "n2" },
    { id: "n2", tipo: "acao", acao: { tipo: "nota_interna", texto: "nota" }, proximo: "n3" },
    { id: "n3", tipo: "acao", acao: { tipo: "enviar_texto", texto: "ultimo" } },
  ]);

t("desligar e religar um passo: fica no LUGAR, com conteudo e encadeamento", () => {
  const base = ok(validarFluxo(macroTresPassos()));
  const off = aplicarPatchNoPasso(base, "n2", { desligado: true });
  assert.equal(off.ok, true);
  const f = ok(validarFluxo((off as any).fluxo));
  assert.equal(f.nos.length, 3, "desligar NAO tira o passo do fluxo");
  assert.equal(f.nos[1].desligado, true);
  assert.equal(f.nos[0].proximo, "n2", "o encadeamento nao muda");
  assert.equal(f.nos[1].proximo, "n3");
  assert.equal((f.nos[1].acao as any).texto, "nota", "o conteudo continua ali pra religar");

  const on = aplicarPatchNoPasso(f, "n2", { desligado: false });
  // no CRU, antes do schema: a chave tem que SAIR. Gravar `false` "funcionaria"
  // (validarFluxo normaliza), mas encheria o jsonb de campo que nao configura
  // nada — a convencao do formato e ausencia = ligado, igual na aprovacao.
  assert.equal("desligado" in (on as any).fluxo.nos[1], false, "religar REMOVE a chave, nao grava false");
  const f2 = ok(validarFluxo((on as any).fluxo));
  assert.equal(f2.nos[1].desligado, undefined, "e o schema tambem nao guarda false");
});

t("passo desligado nao roda, nao espera e nao conta pra aprovacao", () => {
  const bruto = macroDe([
    { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "vai" }, proximo: "n2" },
    { id: "n2", tipo: "espera", acao: { tipo: "espera", segundos: 600 }, proximo: "n3" },
    { id: "n3", tipo: "acao", acao: { tipo: "enviar_texto", texto: "depois" }, aprovacao: true },
  ]);
  const ligado = ok(validarFluxo(bruto));
  assert.equal(esperaTotalSegundos(ligado), 600);
  assert.deepEqual(nosComAvalQueImporta(ligado), ["n3"]);
  assert.deepEqual(acoesDoFluxo(ligado), ["enviar_texto", "espera", "enviar_texto"]);

  const semEspera = ok(validarFluxo((aplicarPatchNoPasso(ligado, "n2", { desligado: true }) as any).fluxo));
  assert.equal(esperaTotalSegundos(semEspera), 0, "espera desligada nao atrasa mais nada");

  const semAval = ok(validarFluxo((aplicarPatchNoPasso(ligado, "n3", { desligado: true }) as any).fluxo));
  assert.deepEqual(nosComAvalQueImporta(semAval), [], "aval de passo desligado nao trava o inline");
  assert.deepEqual(acoesDoFluxo(semAval), ["enviar_texto", "espera"], "a lista do macro nao promete o que nao sai");
  assert.equal(passosQueRodam(semAval).length, 2);
  assert.equal(ordemDeExecucao(semAval).length, 3, "a corrente inteira continua visivel pro editor");
});

t("atraso de uma acao E a espera que vem antes dela: cria, muda e tira", () => {
  const base = ok(validarFluxo(macroTresPassos()));
  // cria
  const comAtraso = aplicarPatchNoPasso(base, "n2", { atraso_segundos: 300 });
  const f1 = ok(validarFluxo((comAtraso as any).fluxo));
  assert.equal(f1.nos.length, 4, "nasceu um no de espera");
  const espera = f1.nos.find((x) => x.acao?.tipo === "espera")!;
  assert.equal((espera.acao as any).segundos, 300);
  assert.equal(espera.proximo, "n2", "a espera aponta pro passo atrasado");
  assert.equal(f1.nos.find((x) => x.id === "n1")!.proximo, espera.id, "e quem vinha antes aponta pra espera");
  // os ids ANTIGOS nao mudam (a fila guarda no_id de cadeia agendada)
  for (const id of ["n1", "n2", "n3"]) {
    assert.ok(f1.nos.some((x) => x.id === id), `o id ${id} foi renumerado — a regua pendente apontaria pro passo errado`);
  }
  assert.equal(passosDoFluxo(f1).find((x) => x.id === "n2")!.atraso_segundos, 300, "a lista LE o mesmo atraso");

  // muda (nao cria outra espera)
  const f2 = ok(validarFluxo((aplicarPatchNoPasso(f1, "n2", { atraso_segundos: 60 }) as any).fluxo));
  assert.equal(f2.nos.length, 4, "mudar o atraso nao empilha espera");
  assert.equal(f2.nos.filter((x) => x.acao?.tipo === "espera").length, 1);
  assert.equal(passosDoFluxo(f2).find((x) => x.id === "n2")!.atraso_segundos, 60);

  // tira: a espera sai da corrente e quem vinha antes volta a apontar pro passo
  const f3 = ok(validarFluxo((aplicarPatchNoPasso(f2, "n2", { atraso_segundos: 0 }) as any).fluxo));
  assert.equal(f3.nos.length, 3, "atraso zero tira a espera (passo de 0s seria lixo na lista)");
  assert.equal(f3.nos.find((x) => x.id === "n1")!.proximo, "n2");
  assert.equal(ordemDeExecucao(f3).length, 3, "a corrente continua inteira depois de tirar a espera");
});

t("atraso ANTES DO PRIMEIRO passo entra na posicao 0 (a corrente comeca em nos[0])", () => {
  const base = ok(validarFluxo(macroTresPassos()));
  const f = ok(validarFluxo((aplicarPatchNoPasso(base, "n1", { atraso_segundos: 120 }) as any).fluxo));
  assert.equal(f.nos[0].acao?.tipo, "espera", "senao ordemDeExecucao comecaria depois da espera");
  assert.equal(f.nos[0].proximo, "n1");
  const ordem = ordemDeExecucao(f).map((x) => x.id);
  assert.deepEqual(ordem.slice(1), ["n1", "n2", "n3"], "a corrente inteira continua alcancavel");
  assert.equal(esperaTotalSegundos(f), 120);
});

// Apontado na revisao cega de 31/08/2026 (item 11). Tirar a espera da CABECA
// mexia na cabeca da corrente por efeito colateral do `splice`: quem cair na
// posicao 0 passa a ser o primeiro passo. No jsonb ordenado da certo por
// acidente (o passo atrasado e o vizinho de baixo); com o array FORA de ordem —
// que o formato permite e fluxo importado tem — a cabeca virava um no ORFAO.
t("tirar o atraso do PRIMEIRO passo com o array fora de ordem nao troca a cabeca", () => {
  const base = ok(
    validarFluxo(
      macroDe([
        // a corrente e: espera 300s -> n3. `n1` existe no formato e NAO roda.
        { id: "e1", tipo: "espera", acao: { tipo: "espera", segundos: 300 }, proximo: "n3" },
        { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "orfao, fora da corrente" } },
        { id: "n3", tipo: "acao", acao: { tipo: "enviar_texto", texto: "o passo que roda" } },
      ])
    )
  );
  assert.deepEqual(ordemDeExecucao(base).map((x) => x.id), ["e1", "n3"], "premissa: a corrente e e1 -> n3");

  const r = aplicarPatchNoPasso(base, "n3", { atraso_segundos: 0 });
  assert.equal(r.ok, true, "tirar o atraso e operacao legitima");
  const f = ok(validarFluxo((r as any).fluxo));
  assert.equal(f.nos.length, 2, "a espera saiu; o orfao continua no formato");
  assert.equal(f.nos[0].id, "n3", "o passo atrasado assume a posicao 0 (a corrente comeca em nos[0])");
  assert.deepEqual(ordemDeExecucao(f).map((x) => x.id), ["n3"], "o fluxo continua comecando pelo MESMO passo");
  assert.ok(
    !ordemDeExecucao(f).some((x) => x.id === "n1"),
    "o no que ninguem escolheu NAO pode virar o primeiro passo do fluxo"
  );
  assert.equal(esperaTotalSegundos(f), 0);
});

// O IRMAO DO MESMO DEFEITO, apontado na RE-REVISAO de 31/08/2026: a guarda da
// cabeca exigia tambem `doadorIdx < 0` ("ninguem aponta pra espera"). Com um no
// ORFAO apontando pra espera da cabeca, o doador EXISTE, a reposicao nao rodava, e
// o array passava a comecar pelo orfao. O que decide a cabeca da corrente e a
// POSICAO no array (`nos[0]`), nunca quem aponta pra quem.
t("tirar o atraso da cabeca COM doador orfao tambem nao troca a cabeca", () => {
  const base = ok(
    validarFluxo(
      macroDe([
        // corrente: esp(60s) -> b -> c. `z` esta FORA dela e aponta pra espera —
        // situacao que fluxo importado produz (o alvo do `z` foi tirado da corrente
        // depois, e o array nunca foi reordenado).
        { id: "esp", tipo: "espera", acao: { tipo: "espera", segundos: 60 }, proximo: "b" },
        { id: "z", tipo: "acao", acao: { tipo: "enviar_texto", texto: "ninguem escolheu esta" }, proximo: "esp" },
        { id: "b", tipo: "acao", acao: { tipo: "enviar_texto", texto: "o primeiro passo de verdade" }, proximo: "c" },
        { id: "c", tipo: "acao", acao: { tipo: "nota_interna", texto: "fim" } },
      ])
    )
  );
  assert.deepEqual(ordemDeExecucao(base).map((x) => x.id), ["esp", "b", "c"], "premissa: a corrente e esp -> b -> c");

  const r = aplicarPatchNoPasso(base, "b", { atraso_segundos: 0 });
  assert.equal(r.ok, true);
  const f = ok(validarFluxo((r as any).fluxo));
  assert.equal(f.nos.length, 3, "a espera saiu; o orfao continua no formato (nao se apaga passo de ninguem)");
  assert.equal(f.nos[0].id, "b", "o passo que era atrasado assume a posicao 0");
  assert.deepEqual(
    ordemDeExecucao(f).map((x) => x.id),
    ["b", "c"],
    "a corrente segue comecando pelo MESMO passo — sem a correcao virava z -> b -> c"
  );
  assert.ok(
    !ordemDeExecucao(f).some((x) => x.id === "z"),
    "mensagem que ninguem escolheu NAO pode passar a rodar por causa de uma edicao de atraso"
  );
  // o rewire do doador continua acontecendo: ele apontava pra espera que sumiu, e
  // deixar `proximo` apontando pra id inexistente seria fluxo torto de proposito
  assert.equal(f.nos.find((x) => x.id === "z")!.proximo, "b", "o orfao passa a apontar pro passo, como antes apontava pra espera");
  assert.equal(esperaTotalSegundos(f), 0);
});

t("recusas do patch de passo: sem chute e com o motivo escrito", () => {
  const base = ok(validarFluxo(macroTresPassos()));
  const naoExiste = aplicarPatchNoPasso(base, "n9", { desligado: true });
  assert.equal(naoExiste.ok, false);
  assert.match((naoExiste as any).erro, /nao encontrado/);

  assert.equal(aplicarPatchNoPasso(base, "n1", {}).ok, false, "patch vazio nao grava");
  assert.equal(aplicarPatchNoPasso(base, "!!", { desligado: true }).ok, false, "id invalido para antes");
  assert.equal(aplicarPatchNoPasso(null, "n1", { desligado: true }).ok, false, "fluxo ilegivel nao explode");

  const torto = aplicarPatchNoPasso(base, "n1", { desligado: "sim" as any });
  assert.equal(torto.ok, false, "booleano de verdade ou recusa (mesma regra da aprovacao)");
  const negativo = aplicarPatchNoPasso(base, "n1", { atraso_segundos: -5 });
  assert.equal(negativo.ok, false);

  // espera x atraso nao se confundem: cada campo fala do seu no
  const comEspera = ok(
    validarFluxo(
      macroDe([
        { id: "n1", tipo: "espera", acao: { tipo: "espera", segundos: 30 }, proximo: "n2" },
        { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "oi" } },
      ])
    )
  );
  assert.equal(aplicarPatchNoPasso(comEspera, "n1", { atraso_segundos: 10 }).ok, false, "espera nao tem atraso: tem tempo");
  assert.equal(aplicarPatchNoPasso(comEspera, "n2", { espera_segundos: 10 }).ok, false, "acao nao tem tempo de espera");
  const mudouTempo = aplicarPatchNoPasso(comEspera, "n1", { espera_segundos: 45 });
  assert.equal(mudouTempo.ok, true);
  assert.equal(esperaTotalSegundos(ok(validarFluxo((mudouTempo as any).fluxo))), 45);
});

t("passo FORA da corrente nao aceita atraso (configuracao invisivel)", () => {
  const solto = ok(
    validarFluxo(
      macroDe([
        { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "unico" } },
        { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "solto" } },
      ])
    )
  );
  const r = aplicarPatchNoPasso(solto, "n2", { atraso_segundos: 60 });
  assert.equal(r.ok, false);
  assert.match((r as any).erro, /fora da corrente/);
  // mas DESLIGAR um passo solto vale: e o jeito de dizer "esse nao volta"
  assert.equal(aplicarPatchNoPasso(solto, "n2", { desligado: true }).ok, true);
});

t("o patch de passo passa pelo MESMO validarFluxo (portao unico de escrita)", () => {
  // atraso acima do teto do schema (30 dias) tem que ser recusado pelo PORTAO,
  // nao silenciosamente aceito por uma validacao paralela na tela
  const base = ok(validarFluxo(macroTresPassos()));
  const r = aplicarPatchNoPasso(base, "n2", { atraso_segundos: 40 * 24 * 3600 });
  assert.equal(r.ok, true, "o patch e puro: quem julga faixa e o schema");
  const v = validarFluxo((r as any).fluxo);
  assert.equal(v.ok, false, "e o schema RECUSA");
  assert.ok((v as any).erros.join(" ").includes("espera"), (v as any).erros.join(" | "));
});

t("visualizacao rapida: conteudo inteiro do passo, so onde ha texto", () => {
  const texto = "linha 1\nlinha 2 ".padEnd(200, "x");
  const f = ok(
    validarFluxo(
      macroDe([
        { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto }, proximo: "n2" },
        { id: "n2", tipo: "acao", acao: { tipo: "etiquetar", etiquetas: ["vip"], modo: "adicionar" } },
      ])
    )
  );
  const passos = passosDoFluxo(f);
  assert.equal(passos[0].conteudo, texto, "espiar mostra o texto TODO, nao o resumo cortado");
  assert.ok(passos[0].resumo.length <= 123, "e o resumo continua curto pra linha da lista");
  assert.equal(passos[1].conteudo, null, "etiqueta nao tem conteudo escondido pra espiar");
});

// ============================================================ 6) GUARDRAILS
console.log("\n6) guardrails do modulo");

t("editor.ts nao importa nada (roda em node solto)", () => {
  const src = readFileSync(new URL("../lib/fluxo/editor.ts", import.meta.url), "utf8");
  assert.equal(/^\s*import\s/m.test(src), false, "editor.ts tem que continuar sem import");
});

// Comentario que EXPLICA a regra nao pode reprovar no teste da regra — mas o
// teste tambem nao pode ser burlado escrevendo a chamada dentro de um bloco de
// prosa. Entao a checagem roda sobre o CODIGO, com as linhas de comentario fora.
const semComentario = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

// COMBINANTE UNICODE CRU no fonte: a guarda existia so na prova das intencoes e
// por isso nao viu `lib/fluxo/editor.ts:237`, que tinha a classe crua enquanto
// duas outras linhas DO MESMO ARQUIVO ja usavam escape (apontado na revisao cega
// de 31/08/2026). Guarda que cobre um arquivo so nao e guarda, e o efeito do
// defeito e o pior possivel: combinante solto e INVISIVEL, morre em copia/patch e
// a classe deixa de casar EM SILENCIO — acento voltaria a contar na comparacao e
// "Copia de Ação" viraria um nome "livre" ao lado de "Copia de Acao".
t("nenhum arquivo da frente tem marca combinante CRUA no fonte", () => {
  // e ela ESCAPADA aqui tambem, obviamente: uma guarda escrita com combinante
  // cru pararia de casar em silencio no primeiro patch, e a guarda sumiria junto
  // com o defeito que ela procura.
  const RE_COMBINANTE_CRUA = new RegExp("[\u0300-\u036f]");
  const arquivos = [
    "../lib/fluxo/editor.ts",
    "../lib/fluxo/schema.ts",
    "../lib/fluxo/variaveis.ts",
    "../lib/fluxo/intencoes.ts",
    "../lib/fluxo/intencoes-db.ts",
    "../lib/fluxo/fila.ts",
    "../lib/fluxo/fila-db.ts",
    "../lib/fluxo/simulador.ts",
    "../lib/fluxo/executar.ts",
    "../lib/transcricao.ts",
    "../app/fluxos/page.tsx",
    "../app/api/fluxos/route.ts",
    "../app/api/intencoes/route.ts",
    "../app/api/transcricao/route.ts",
    "../app/api/respostas-rapidas/route.ts",
  ];
  let vistos = 0;
  for (const rel of arquivos) {
    let src: string;
    try {
      src = readFileSync(new URL(rel, import.meta.url), "utf8");
    } catch {
      continue; // arquivo de outra etapa/frente que ainda nao existe aqui
    }
    vistos++;
    const linha = src.split("\n").findIndex((l) => RE_COMBINANTE_CRUA.test(l));
    assert.equal(
      linha,
      -1,
      `${rel}:${linha + 1} tem combinante cru — use new RegExp("[\\u0300-\\u036f]", "g")`
    );
  }
  assert.ok(vistos >= 12, `a guarda tem que estar olhando a frente inteira (viu ${vistos})`);
});

t("nenhuma superficie de fluxo usa HTML cru (XSS de fluxo importado)", () => {
  const arquivos = [
    "../lib/fluxo/editor.ts",
    "../app/fluxos/page.tsx",
    "../app/api/fluxos/route.ts",
  ];
  for (const rel of arquivos) {
    let src: string;
    try {
      src = semComentario(readFileSync(new URL(rel, import.meta.url), "utf8"));
    } catch {
      continue; // arquivo ainda nao existe nesta etapa
    }
    assert.equal(
      src.includes("dangerouslySetInnerHTML"),
      false,
      `${rel} nao pode renderizar HTML cru: fluxo e conteudo potencialmente de terceiro`
    );
    assert.equal(src.includes("innerHTML"), false, `${rel}: innerHTML e a mesma porta`);
  }
});

t("nenhum arquivo da frente executa DDL em runtime", () => {
  const arquivos = ["../app/api/fluxos/route.ts", "../app/fluxos/page.tsx"];
  for (const rel of arquivos) {
    let src: string;
    try {
      src = readFileSync(new URL(rel, import.meta.url), "utf8");
    } catch {
      continue;
    }
    assert.equal(
      /create\s+table|alter\s+table|drop\s+table/i.test(src),
      false,
      `${rel}: codigo nunca cria tabela — migration e gesto humano no SQL Editor`
    );
  }
});

// A UNICA mutacao que escapou na 1a rodada deste card: a copia herdando `ativo` do
// original passava verde. E o defeito e real — duplicar pra experimentar e o uso
// normal, e uma copia que nasce LIGADA passa a existir na operacao (mandando
// mensagem pra cliente) sem ninguem ter decidido isso. Os tres pontos que fazem a
// copia ser copia moram na rota, entao a guarda e no trecho do `duplicar`.
t("a COPIA nasce desligada, sem origem herdada e na mesma pasta", () => {
  const src = readFileSync(new URL("../app/api/fluxos/route.ts", import.meta.url), "utf8");
  const i = src.indexOf('if (acao === "duplicar")');
  const fim = src.indexOf("// ---", i + 10);
  assert.ok(i > 0 && fim > i, "achou o trecho do duplicar");
  const trecho = semComentario(src.slice(i, fim));

  assert.ok(/ativo: false/.test(trecho), "COPIA NASCE DESLIGADA: ligar e um clique, mandar mensagem sem querer nao tem desfazer");
  assert.equal(/ativo: true/.test(trecho), false, "e nunca ligada");
  assert.ok(
    /delete bruto\.origem/.test(trecho),
    "a origem do original NAO e herdada: a copia nao veio de importacao nenhuma, e dizer que veio e mentira na rastreabilidade"
  );
  assert.ok(
    /\?\?\s*row\.pasta/.test(trecho),
    "e a copia fica na MESMA pasta do original (achar a copia em outro lugar da lista e o mesmo que perde-la)"
  );
});

console.log(`\nPROVA DO EDITOR OK — ${feitos} casos\n`);
