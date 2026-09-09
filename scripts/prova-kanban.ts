// Prova do QUADRO (kanban) de conversas por funil — card 86ak86k7g.
//
// Roda em Node >= 22.6 sem build: `node scripts/prova-kanban.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// FIXTURES SAO SINTETICAS. Nenhum funil, conversa, telefone ou nome de cliente
// entra no repo — mesma regra do resto das provas deste projeto.
//
// O QUE ESTA PROVA COBRE: a regra pura do quadro (lib/kanban.ts) — montagem das
// colunas, a coluna sintetica "fora do quadro", filtros, ordenacao, a fatia da
// rolagem e o par aplicar/desfazer do arrastar-e-soltar otimista, incluindo os
// dois achados da revisao cega (31/08/2026): rollback de movimento velho nao
// pode passar por cima de um movimento mais novo que gravou (7b), e nem
// aplicar nem desfazer podem mentir no metadado do vinculo (7c).
//
// O QUE ELA **NAO** COBRE (declarado, nao esquecido): o React de
// app/kanban-quadro.tsx e o recorte de escopo da rota /api/funis. O primeiro
// precisa de navegador; o segundo precisa do Postgres da instalacao e do alias
// `@/` do Next — nenhum dos dois existe em node solto. O que dava pra separar
// de tela e de banco foi separado de proposito e ESTA provado aqui.
import assert from "node:assert/strict";
import {
  COLUNA_FORA, aplicarMovimento, cartaoPassa, desfazerMovimento, funilSelecionado,
  montarQuadro, movimentoValido, normalizar, opcoesDoFunil, rotuloResponsavel, uidDe,
  type CardConversa, type FunilQuadro, type VinculoQuadro,
} from "../lib/kanban.ts";

// ============================================================== fixtures
const FUNIL_A: FunilQuadro = {
  id: "f-a",
  nome: "Comercial",
  ordem: 1,
  etapas: [
    // fora de ordem de proposito: quem monta o quadro e quem ordena
    { id: "e-a3", funil_id: "f-a", nome: "Fechado", ordem: 3, cor: "#00AA55" },
    { id: "e-a1", funil_id: "f-a", nome: "Novo", ordem: 1, cor: null },
    { id: "e-a2", funil_id: "f-a", nome: "Proposta", ordem: 2, cor: "#3355FF" },
  ],
};
const FUNIL_B: FunilQuadro = {
  id: "f-b",
  nome: "Atendimento",
  ordem: 0,
  etapas: [{ id: "e-b1", funil_id: "f-b", nome: "Triagem", ordem: 1, cor: null }],
};

const v = (chat: string, funil: string, etapa: string, canal = "central"): VinculoQuadro => ({
  canal,
  chat_id: chat,
  funil_id: funil,
  etapa_id: etapa,
  atualizado_em: "2026-08-30T10:00:00.000Z",
  definido_por_nome: "Fulano",
});

const card = (chat: string, extra: Partial<CardConversa> = {}): CardConversa => ({
  canal: "central",
  chat_id: chat,
  nome: `Contato ${chat}`,
  foto: null,
  preview: "ultima mensagem",
  last_message_at: "2026-08-30T09:00:00.000Z",
  status: "aberto",
  etiquetas: [],
  responsaveis: [],
  ...extra,
});

// ====================================================== 1) selecao de funil
{
  assert.equal(funilSelecionado([], null), null, "catalogo vazio nao inventa funil");
  // sem pedido: o de menor ordem, nao o primeiro da lista
  assert.equal(funilSelecionado([FUNIL_A, FUNIL_B], null)!.id, "f-b");
  assert.equal(funilSelecionado([FUNIL_A, FUNIL_B], "f-a")!.id, "f-a");
  // id que nao existe (URL velha, localStorage de outra instalacao) nao pode
  // travar a tela nem abrir um funil "fantasma": cai no padrao
  assert.equal(funilSelecionado([FUNIL_A, FUNIL_B], "f-zzz")!.id, "f-b");
}

// ======================================================= 2) montar colunas
{
  const vinculos = [
    v("11", "f-a", "e-a2"),
    v("22", "f-a", "e-a1"),
    v("33", "f-b", "e-b1"), // outro funil: NAO entra neste quadro
    v("44", "f-a", "e-a2"),
  ];
  const cards = [card("11"), card("22"), card("33"), card("44")];
  const cols = montarQuadro({ funil: FUNIL_A, vinculos, cards });

  assert.deepEqual(cols.map((c) => c.nome), ["Novo", "Proposta", "Fechado"], "colunas na ordem da etapa");
  assert.equal(cols[0].total, 1);
  assert.equal(cols[1].total, 2, "duas conversas na mesma etapa");
  assert.equal(cols[2].total, 0, "etapa vazia continua desenhada");
  assert.ok(!cols.some((c) => c.cartoes.some((x) => x.chat_id === "33")), "conversa de outro funil fica fora");

  // N:N: a mesma conversa em dois funis aparece nos DOIS quadros
  const colsB = montarQuadro({ funil: FUNIL_B, vinculos: [...vinculos, v("11", "f-b", "e-b1")], cards });
  assert.equal(colsB[0].total, 2);
  assert.ok(colsB[0].cartoes.some((c) => c.chat_id === "11"));

  // funil nulo (nenhum funil cadastrado) = quadro vazio, sem estourar
  assert.deepEqual(montarQuadro({ funil: null, vinculos, cards }), []);
}

// ============================== 3) cartao sem dado NAO some (divida do escopo)
{
  // vinculo visivel cujo `card` nao veio (conversa fora do lote, canal sem
  // linha no painel): mostrar o identificador e melhor que esconder a conversa
  const cols = montarQuadro({ funil: FUNIL_A, vinculos: [v("99", "f-a", "e-a1")], cards: [] });
  assert.equal(cols[0].total, 1);
  assert.equal(cols[0].cartoes[0].nome, "99", "sem dado de cartao, o nome cai no chat_id");
  assert.deepEqual(cols[0].cartoes[0].etiquetas, []);
}

// ================================= 4) DIVIDA: etapa arquivada x vinculo vivo
{
  const fora = [
    { funil: "Comercial", etapa: "Etapa antiga", motivo: "etapa arquivada", conversas: 7 },
    { funil: null, etapa: null, motivo: "estrutura apagada", conversas: 2 },
  ];
  const cols = montarQuadro({ funil: FUNIL_A, vinculos: [v("11", "f-a", "e-a1")], cards: [card("11")], fora });
  const ultima = cols[cols.length - 1];
  assert.equal(ultima.etapa_id, COLUNA_FORA, "a coluna sintetica e a ultima");
  assert.equal(ultima.sintetica, true);
  assert.equal(ultima.total, 9, "soma as conversas presas em estrutura arquivada");
  assert.equal(ultima.cartoes.length, 0, "a rota manda so a contagem: sem chat_id, sem vazamento");

  // sem conversa presa, a coluna nao aparece (nao poluir o quadro do dia a dia)
  const limpo = montarQuadro({ funil: FUNIL_A, vinculos: [], cards: [], fora: [] });
  assert.ok(!limpo.some((c) => c.sintetica));
  const zerado = montarQuadro({
    funil: FUNIL_A, vinculos: [], cards: [],
    fora: [{ funil: "x", etapa: "y", motivo: "etapa arquivada", conversas: 0 }],
  });
  assert.ok(!zerado.some((c) => c.sintetica), "contagem zero nao vira coluna");
}

// ================================================== 5) ordenacao e rolagem
{
  const vinculos = Array.from({ length: 120 }, (_, i) => v(`c${i}`, "f-a", "e-a1"));
  const cards = vinculos.map((x, i) =>
    card(x.chat_id, { last_message_at: `2026-08-${String(10 + (i % 20)).padStart(2, "0")}T10:00:00.000Z` })
  );
  const cols = montarQuadro({ funil: FUNIL_A, vinculos, cards });
  assert.equal(cols[0].total, 120, "o cabecalho conta TUDO");
  assert.equal(cols[0].cartoes.length, 30, "o corpo carrega a primeira fatia");
  // mais recente primeiro
  const ts = cols[0].cartoes.map((c) => c.last_message_at!);
  assert.deepEqual(ts, [...ts].sort().reverse(), "cartao mais recente no topo");

  // rolar carrega mais SO daquela coluna
  const mais = montarQuadro({ funil: FUNIL_A, vinculos, cards, visiveisPorColuna: { "e-a1": 60 } });
  assert.equal(mais[0].cartoes.length, 60);
  assert.equal(mais[0].total, 120, "carregar mais nao muda o total");
}

// ========================================================== 6) filtros
{
  const vinculos = [v("11", "f-a", "e-a1"), v("22", "f-a", "e-a1"), v("33", "f-a", "e-a1", "apioficial")];
  const cards = [
    card("11", { nome: "Ana Pérez", etiquetas: ["VIP"], responsaveis: [{ tipo: "usuario", id: "u1", nome: "Bia" }] }),
    card("22", { nome: "Bruno", etiquetas: ["frio"], responsaveis: [{ tipo: "usuario", id: "u2", nome: "Caio" }] }),
    { ...card("33", { nome: "Carla" }), canal: "apioficial" },
  ];
  const q = (filtro: any) => montarQuadro({ funil: FUNIL_A, vinculos, cards, filtro })[0];

  assert.equal(q({}).total, 3, "sem filtro, tudo passa");
  assert.equal(q({ responsavel: "u1" }).total, 1);
  assert.equal(q({ etiqueta: "vip" }).total, 1, "etiqueta casa sem ligar pra caixa");
  assert.equal(q({ busca: "perez" }).total, 1, "busca ignora acento");
  assert.equal(q({ busca: "PÉREZ" }).total, 1);
  assert.equal(q({ busca: "22" }).total, 1, "busca casa o chat_id (quem digita numero quer a conversa)");
  assert.equal(q({ canal: "apioficial" }).total, 1, "filtro por canal");
  assert.equal(q({ responsavel: "u1", etiqueta: "frio" }).total, 0, "filtros se somam (E, nao OU)");
  assert.equal(q({ busca: "   " }).total, 3, "busca so com espaco nao filtra nada");

  // o total da coluna respeita o filtro: cabecalho nao pode contar quem sumiu
  assert.equal(q({ responsavel: "u1" }).cartoes.length, 1);

  assert.equal(cartaoPassa({ ...cards[0], uid: "x", etapa_id: "", funil_id: "", atualizado_em: null } as any, {}), true);
}

// ============================ 7) arrastar: otimista + rollback (o coracao)
{
  let vinculos = [v("11", "f-a", "e-a1"), v("11", "f-b", "e-b1"), v("22", "f-a", "e-a1")];
  const mov = { uid: uidDe("central", "11"), canal: "central", chat_id: "11", funil_id: "f-a", de: "e-a1", para: "e-a2" };

  assert.equal(movimentoValido(mov), true);
  assert.equal(movimentoValido({ de: "e-a1", para: "e-a1" }), false, "soltar na propria coluna nao vira requisicao");
  assert.equal(movimentoValido({ de: "e-a1", para: COLUNA_FORA }), false, "coluna sintetica nao recebe cartao");
  assert.equal(movimentoValido({ de: null, para: "" }), false);

  const depois = aplicarMovimento(vinculos, mov);
  const doFunilA = depois.filter((x) => x.chat_id === "11" && x.funil_id === "f-a");
  assert.equal(doFunilA.length, 1, "dentro do funil a conversa fica em UMA etapa");
  assert.equal(doFunilA[0].etapa_id, "e-a2");
  assert.ok(
    depois.some((x) => x.chat_id === "11" && x.funil_id === "f-b" && x.etapa_id === "e-b1"),
    "mover num funil NAO mexe nos outros funis da conversa"
  );
  assert.ok(depois.some((x) => x.chat_id === "22" && x.etapa_id === "e-a1"), "as outras conversas ficam paradas");

  // o POST falhou: a tela volta exatamente ao que era
  const revertido = desfazerMovimento(depois, mov);
  const voltou = revertido.filter((x) => x.chat_id === "11" && x.funil_id === "f-a");
  assert.equal(voltou.length, 1);
  assert.equal(voltou[0].etapa_id, "e-a1", "rollback devolve a etapa de origem");
  assert.equal(revertido.length, vinculos.length, "rollback nao inventa nem perde vinculo");

  // conversa que NAO estava no funil (entrou arrastando da coluna "sem etapa"):
  // desfazer tem que APAGAR o vinculo, nao criar um com etapa nula
  const entrada = { uid: uidDe("central", "77"), canal: "central", chat_id: "77", funil_id: "f-a", de: null, para: "e-a1" };
  const comNovo = aplicarMovimento(vinculos, entrada);
  assert.equal(comNovo.length, vinculos.length + 1);
  const semNovo = desfazerMovimento(comNovo, entrada);
  assert.ok(!semNovo.some((x) => x.chat_id === "77"), "rollback de entrada remove o vinculo");
  assert.equal(semNovo.length, vinculos.length);

  // o quadro montado DEPOIS do movimento otimista ja mostra o cartao no lugar novo
  const cols = montarQuadro({ funil: FUNIL_A, vinculos: depois, cards: [card("11"), card("22")] });
  assert.equal(cols[0].total, 1, "saiu de Novo");
  assert.equal(cols[1].total, 1, "chegou em Proposta");
  assert.equal(cols[1].cartoes[0].chat_id, "11");
}

// ================== 7b) MOVIMENTO MAIS NOVO VENCE (achado da revisao cega)
{
  // Sequencia real: o atendente arrasta A->B, a rede demora; ele arrasta B->C e
  // ESSE grava; so entao o primeiro POST volta com erro. Desfazer o primeiro
  // levaria a tela pra A enquanto o servidor tem C — divergencia silenciosa, o
  // pior desfecho: ninguem ve, e o quadro passa a mentir.
  const vinculos = [v("11", "f-a", "e-a1")];
  const mAB = { uid: uidDe("central", "11"), canal: "central", chat_id: "11", funil_id: "f-a", de: "e-a1", para: "e-a2" };
  const mBC = { uid: uidDe("central", "11"), canal: "central", chat_id: "11", funil_id: "f-a", de: "e-a2", para: "e-a3" };

  const emB = aplicarMovimento(vinculos, mAB);
  const emC = aplicarMovimento(emB, mBC);
  assert.equal(emC.find((x) => x.funil_id === "f-a")!.etapa_id, "e-a3");

  const aposFalhaDoPrimeiro = desfazerMovimento(emC, mAB);
  assert.equal(
    aposFalhaDoPrimeiro.find((x) => x.funil_id === "f-a")!.etapa_id,
    "e-a3",
    "rollback do movimento VELHO nao pode arrastar o cartao de volta por cima do novo"
  );
  assert.equal(aposFalhaDoPrimeiro.length, emC.length, "e nao remove nada");

  // ja o rollback do movimento MAIS NOVO continua funcionando normalmente
  const revertidoBC = desfazerMovimento(emC, mBC);
  assert.equal(revertidoBC.find((x) => x.funil_id === "f-a")!.etapa_id, "e-a2");

  // conversa que sumiu do funil no meio (outra aba tirou dela): nada a desfazer
  assert.deepEqual(desfazerMovimento([], mAB), [], "sem vinculo, o rollback nao inventa um");
}

// ============== 7c) metadado nao mente (achado da revisao cega)
{
  const original = {
    ...v("11", "f-a", "e-a1"),
    atualizado_em: "2026-08-01T08:00:00.000Z",
    definido_por_nome: "Quem moveu antes",
  };
  const mov = {
    uid: uidDe("central", "11"), canal: "central", chat_id: "11", funil_id: "f-a",
    de: "e-a1", para: "e-a2",
    deAtualizadoEm: original.atualizado_em,
    deDefinidoPorNome: original.definido_por_nome,
    porNome: "Quem move agora",
  };

  // aplicar carimba QUEM MOVE AGORA — herdar o autor antigo creditaria a
  // mudanca a quem mexeu da vez passada
  const depois = aplicarMovimento([original], mov, "2026-08-31T22:00:00.000Z");
  const novo = depois.find((x) => x.funil_id === "f-a")!;
  assert.equal(novo.definido_por_nome, "Quem move agora");
  assert.equal(novo.atualizado_em, "2026-08-31T22:00:00.000Z");

  // desfazer RESTAURA o metadado original: renovar `atualizado_em` faria o
  // cartao subir pro topo da coluna por um movimento que nao aconteceu
  const revertido = desfazerMovimento(depois, mov);
  const voltou = revertido.find((x) => x.funil_id === "f-a")!;
  assert.equal(voltou.etapa_id, "e-a1");
  assert.equal(voltou.atualizado_em, "2026-08-01T08:00:00.000Z", "rollback devolve a data original");
  assert.equal(voltou.definido_por_nome, "Quem moveu antes", "rollback devolve o autor original");

  // e a ordenacao confirma: depois do rollback o cartao volta pro lugar de
  // antes na coluna, sem furar a fila
  const outro = { ...v("22", "f-a", "e-a1"), atualizado_em: "2026-08-15T10:00:00.000Z" };
  const colsRevertido = montarQuadro({
    funil: FUNIL_A,
    vinculos: [...revertido, outro],
    cards: [card("11", { last_message_at: null }), card("22", { last_message_at: null })],
  });
  assert.deepEqual(
    colsRevertido[0].cartoes.map((c) => c.chat_id),
    ["22", "11"],
    "cartao revertido nao rouba o topo da coluna"
  );
  assert.equal(colsRevertido[0].cartoes[1].definido_por_nome, "Quem moveu antes");
}

// ===================================== 8) opcoes de filtro e rotulo do cartao
{
  const vinculos = [v("11", "f-a", "e-a1"), v("22", "f-a", "e-a2")];
  const cards = [
    card("11", { etiquetas: ["VIP", "urgente"], responsaveis: [{ tipo: "usuario", id: "u1", nome: "Bia" }] }),
    card("22", { etiquetas: ["VIP"], responsaveis: [{ tipo: "usuario", id: "u2", nome: "Ana" }, { tipo: "depto", id: "d1", nome: "Suporte" }] }),
  ];
  const op = opcoesDoFunil({ funil: FUNIL_A, vinculos, cards });
  assert.deepEqual(op.etiquetas, ["urgente", "VIP"].sort((a, b) => a.localeCompare(b)), "etiquetas unicas e ordenadas");
  // DEPARTAMENTO tambem e responsavel (conversa_responsaveis guarda os dois
  // tipos): filtrar o quadro por "Suporte" e caso de uso real do gestor, entao
  // ele entra na lista de opcoes junto com as pessoas.
  assert.deepEqual(op.responsaveis.map((r) => r.nome), ["Ana", "Bia", "Suporte"], "pessoas E departamentos, ordenados");

  // as opcoes saem do funil ABERTO: cartao que so existe em outro funil nao
  // pode povoar o seletor deste quadro (o filtro nao acharia nada)
  const opB = opcoesDoFunil({
    funil: FUNIL_B,
    vinculos: [...vinculos, v("88", "f-b", "e-b1")],
    cards: [...cards, card("88", { etiquetas: ["so-do-b"], responsaveis: [{ tipo: "usuario", id: "u9", nome: "Zeca" }] })],
  });
  assert.deepEqual(opB.etiquetas, ["so-do-b"], "etiqueta de outro funil fica fora");
  assert.deepEqual(opB.responsaveis.map((r) => r.nome), ["Zeca"]);
  assert.deepEqual(opcoesDoFunil({ funil: null, vinculos, cards }), { etiquetas: [], responsaveis: [] });

  // card sem vinculo nenhum (conversa que saiu do funil) nao entra nas opcoes
  const opOrfa = opcoesDoFunil({ funil: FUNIL_A, vinculos: [], cards });
  assert.deepEqual(opOrfa, { etiquetas: [], responsaveis: [] });
  assert.equal(
    montarQuadro({ funil: FUNIL_A, vinculos, cards, filtro: { responsavel: "d1" } })[1].total,
    1,
    "da pra filtrar o quadro por departamento"
  );

  assert.equal(rotuloResponsavel({ responsaveis: [] }), null, "sem dono, sem rotulo");
  assert.equal(rotuloResponsavel({ responsaveis: [{ nome: "Bia" }] }), "Bia");
  assert.equal(rotuloResponsavel({ responsaveis: [{ nome: "Ana" }, { nome: "Suporte" }] }), "Ana +1");
}

// ============================================================ 9) normalizar
{
  assert.equal(normalizar("  Pós-Venda   ATIVO "), "pos-venda ativo");
  assert.equal(normalizar(null), "");
  assert.equal(normalizar(undefined), "");
  assert.equal(uidDe("central", "5511"), "central:5511");
}

console.log(
  "prova-kanban: OK — colunas, fora-do-quadro, filtros, rolagem, arrastar, rollback " +
    "(movimento mais novo vence), metadado do rollback e opcoes por funil"
);
