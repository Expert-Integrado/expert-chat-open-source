// Resolvedor de REFERENCIAS da importacao — modulo unico.
//
// O backup do ChatGuru aponta pras proprias entidades de tres jeitos diferentes,
// e cada um erra de um jeito:
//
//   por ID          etiqueta nao tem id nenhum; etapa de funil tem; delegacao de
//                   usuario/departamento tem (ora string, ora {$oid});
//   por NOME        autor de anotacao e TEXTO LIVRE; alvo de acao DIALOGO e o
//                   NOME do dialogo ("Menu Inicial | ..."), nunca o id — medido
//                   em 3.607 acoes dos 33 backups: 0 ObjectId, 2.402 nomes,
//                   1.205 placeholder;
//   por POSICAO     etapa de funil ja importada e reencontrada pela ordem quando
//                   o nome foi editado no painel depois.
//
// A REGRA DA CASA, que este modulo existe pra impor: nome que casa com UM alvo
// resolve; nome AMBIGUO (casa com 2+) e alvo MORTO (nao casa com ninguem) viram
// RESSALVA DECLARADA, nunca chute. Apontar a referencia pro alvo errado e pior
// que nao ter a referencia — quem revisa uma ressalva conserta em 1 minuto, quem
// herda um chute errado descobre em producao.
//
// Taxa medida pela frente C na referencia mais dificil (DIALOGO por nome, dentro
// da conta): 95,8% unico | 2,2% ambiguo | 1,9% morto. Este modulo generaliza o
// mecanismo pros outros tipos e mede a taxa de CADA um.
//
// Modulo PURO: nao le arquivo, nao abre conexao, nao tem estado global. Da pra
// provar em node solto (scripts/importar/prova-resolver.mjs).

// ─── NORMALIZACAO ────────────────────────────────────────────────────────────
// O cadastro de origem nunca teve padronizacao: "Ana souza", nome com espaco
// sobrando no fim, ESPACO DUPLO no meio, acento inconsistente. A chave de
// comparacao tira tudo isso — e SO a chave: o nome original viaja intacto pro
// relatorio, porque e ele que o humano reconhece na revisao.
export const normalizar = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // acento
    .replace(/[\u200b-\u200d\ufeff]/g, "") // espaco de largura zero (cola em copy/paste)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// Valor que o formulario de origem grava quando NADA foi escolhido. Nao e perda:
// nunca teve alvo. Contar placeholder como "referencia perdida" inventa problema.
export const PLACEHOLDERS = new Set(
  [
    "- selecione -",
    "-- selecione o dialogo --",
    "- selecione a etapa -",
    "- selecione o funil -",
    "selecione",
    "nenhum",
    "none",
    "null",
    "undefined",
  ].map(normalizar)
);

export const ehPlaceholder = (v) => {
  const n = normalizar(v);
  return !n || PLACEHOLDERS.has(n);
};

// id do Mongo vem ora "abc..." ora {$oid:"abc..."} — sem passar por aqui, o
// segundo formato simplesmente desaparecia (foi o bug do responsavel sumido).
export const idDeOrigem = (v) =>
  v && typeof v === "object" && v.$oid ? String(v.$oid) : v === null || v === undefined ? null : String(v);

export const ehObjectId = (v) => /^[a-f0-9]{24}$/i.test(String(idDeOrigem(v) ?? ""));

// ─── ESTADOS ─────────────────────────────────────────────────────────────────
// "vazio" NAO e ressalva (nunca houve alvo). "ambiguo" e "morto" SAO.
export const ESTADOS = ["id", "nome", "posicao", "vazio", "ambiguo", "morto"];
export const ehRessalva = (r) => r?.estado === "ambiguo" || r?.estado === "morto";
export const resolvido = (r) => r?.estado === "id" || r?.estado === "nome" || r?.estado === "posicao";

// ─── INDICE ──────────────────────────────────────────────────────────────────
// Um indice por TIPO de entidade (etiqueta, usuario, departamento, funil, etapa,
// dialogo). O ESCOPO e o que impede o casamento errado entre contas/chatbots: no
// ChatGuru dois dialogos podem ter o mesmo titulo em chatbots diferentes, e duas
// etapas o mesmo nome em funis diferentes. Sem escopo, "unico" mente.
//
//   itens:  lista de objetos do CATALOGO de destino (ou da origem normalizada)
//   id:     como tirar o identificador de origem do item (default: item.id_origem ?? item.id)
//   nome:   como tirar o nome legivel (default: item.nome ?? item.name ?? item.text)
//   escopo: como tirar o escopo (default: item.escopo ?? null) — chave opaca
//   ordem:  posicao dentro do escopo (default: item.ordem ?? null)
export function novoIndice(itens, opcoes = {}) {
  const pegarId = opcoes.id || ((x) => idDeOrigem(x?.id_origem ?? x?.id ?? null));
  const pegarNome = opcoes.nome || ((x) => x?.nome ?? x?.name ?? x?.text ?? "");
  const pegarEscopo = opcoes.escopo || ((x) => x?.escopo ?? null);
  const pegarOrdem = opcoes.ordem || ((x) => (Number.isFinite(x?.ordem) ? x.ordem : null));

  const porId = new Map();
  const porNome = new Map(); // "escopo nome" -> [item, ...]
  // Mesmo nome IGNORANDO escopo: consulta sem escopo tem que devolver AMBIGUO
  // quando o nome se repete em dois escopos, nunca morto -- que seria a mentira
  // confortavel (esconde a ambiguidade em vez de declarar).
  const porNomeTodos = new Map(); // nome -> [item, ...]
  const porOrdem = new Map(); // "escopo ordem" -> [item, ...]
  const todos = [];

  const chave = (escopo, resto) => `${escopo ?? ""} ${resto}`;

  for (const bruto of Array.isArray(itens) ? itens : []) {
    if (!bruto) continue;
    const item = {
      ref: bruto,
      id: pegarId(bruto),
      nome: String(pegarNome(bruto) ?? ""),
      escopo: pegarEscopo(bruto),
      ordem: pegarOrdem(bruto),
    };
    todos.push(item);
    if (item.id) {
      // id repetido no catalogo e defeito do catalogo, nao do valor consultado:
      // fica o primeiro e o placar do chamador ve a duplicata como ambiguidade
      // se algum dia ela for consultada por nome.
      if (!porId.has(item.id)) porId.set(item.id, item);
    }
    const nn = normalizar(item.nome);
    if (nn) {
      const k = chave(item.escopo, nn);
      if (!porNome.has(k)) porNome.set(k, []);
      porNome.get(k).push(item);
      if (!porNomeTodos.has(nn)) porNomeTodos.set(nn, []);
      porNomeTodos.get(nn).push(item);
    }
    if (item.ordem !== null) {
      const k = chave(item.escopo, `#${item.ordem}`);
      if (!porOrdem.has(k)) porOrdem.set(k, []);
      porOrdem.get(k).push(item);
    }
  }

  return { porId, porNome, porNomeTodos, porOrdem, todos, chave };
}

// ─── RESOLUCAO ───────────────────────────────────────────────────────────────
// Ordem de tentativa, da mais forte pra mais fraca:
//   1. id de origem       — identidade de verdade, nunca ambigua
//   2. nome normalizado   — dentro do escopo; 2+ candidatos = AMBIGUO
//   3. posicao            — so quando explicitamente pedida (etapa de funil)
//
// Nao existe passo 4. Semelhanca de nome ("Ana souza" ~ "Ana Souza Lima"),
// prefixo, distancia de edicao: NADA disso entra. Foi decisao registrada — o
// cadastro de origem e sujo o suficiente pra que "parecido" acerte errado.
export function resolver(indice, valor, opcoes = {}) {
  const { escopo = null, porPosicao = null, aceitarId = true } = opcoes;
  if (ehPlaceholder(valor) && porPosicao === null) return { estado: "vazio", item: null, candidatos: [] };

  const cru = idDeOrigem(valor);

  if (aceitarId && cru && indice.porId.has(cru)) {
    return { estado: "id", item: indice.porId.get(cru), candidatos: [] };
  }

  const nn = normalizar(cru);
  if (nn) {
    // escopo primeiro (o casamento mais forte); depois o indice sem escopo,
    // que e onde a repeticao entre escopos aparece como ambiguidade honesta.
    const tentativas = escopo === null ? [] : [indice.porNome.get(indice.chave(escopo, nn))];
    tentativas.push(indice.porNomeTodos.get(nn));
    for (const achados of tentativas) {
      if (!achados || !achados.length) continue;
      if (achados.length === 1) return { estado: "nome", item: achados[0], candidatos: achados };
      return { estado: "ambiguo", item: null, candidatos: achados };
    }
  }

  if (porPosicao !== null && Number.isFinite(porPosicao)) {
    const achados = indice.porOrdem.get(indice.chave(escopo, `#${porPosicao}`));
    if (achados && achados.length === 1) return { estado: "posicao", item: achados[0], candidatos: achados };
    if (achados && achados.length > 1) return { estado: "ambiguo", item: null, candidatos: achados };
  }

  // Valor que EXISTE na origem e nao casa com nada no destino. Aqui mora o
  // "1,9% alvo morto": dialogo apagado depois de a acao ter sido criada.
  return { estado: "morto", item: null, candidatos: [] };
}

// ─── PLACAR (as taxas por tipo de referencia) ────────────────────────────────
// O relatorio da migracao precisa responder, por TIPO: quantas referencias
// existiam, quantas resolveram e por qual caminho, e QUAIS ficaram de ressalva.
// A amostra de ressalva e limitada porque nome de pessoa e dado de cliente: o
// terminal ve so contagem, o arquivo de relatorio ve os nomes.
export function novoPlacar({ amostraPorTipo = 25 } = {}) {
  const tipos = new Map();
  const zero = () => ({
    total: 0,
    id: 0,
    nome: 0,
    posicao: 0,
    vazio: 0,
    ambiguo: 0,
    morto: 0,
    amostra_ambiguo: [],
    amostra_morto: [],
  });

  return {
    registrar(tipo, resultado, valorOriginal) {
      if (!tipos.has(tipo)) tipos.set(tipo, zero());
      const t = tipos.get(tipo);
      t.total++;
      const e = resultado?.estado || "morto";
      t[e] = (t[e] || 0) + 1;
      if (e === "ambiguo" && t.amostra_ambiguo.length < amostraPorTipo) {
        t.amostra_ambiguo.push({
          valor: String(idDeOrigem(valorOriginal) ?? ""),
          candidatos: (resultado.candidatos || []).map((c) => c.nome).slice(0, 5),
        });
      }
      if (e === "morto" && t.amostra_morto.length < amostraPorTipo) {
        t.amostra_morto.push(String(idDeOrigem(valorOriginal) ?? ""));
      }
      return resultado;
    },

    // atalho: resolve E registra numa chamada
    resolverE(tipo, indice, valor, opcoes) {
      return this.registrar(tipo, resolver(indice, valor, opcoes), valor);
    },

    // taxa calculada sobre as referencias que TINHAM alvo (exclui placeholder):
    // contar placeholder no denominador afunda a taxa com nao-problema.
    tabela() {
      const linhas = [];
      for (const [tipo, t] of [...tipos.entries()].sort((a, b) => b[1].total - a[1].total)) {
        const comAlvo = t.total - t.vazio;
        const ok = t.id + t.nome + t.posicao;
        const pct = (v) => (comAlvo ? Number(((v * 100) / comAlvo).toFixed(1)) : null);
        linhas.push({
          tipo,
          total: t.total,
          sem_alvo_na_origem: t.vazio,
          com_alvo: comAlvo,
          por_id: t.id,
          por_nome: t.nome,
          por_posicao: t.posicao,
          ambiguo: t.ambiguo,
          morto: t.morto,
          taxa_resolvido: pct(ok),
          taxa_ambiguo: pct(t.ambiguo),
          taxa_morto: pct(t.morto),
          ressalvas: t.ambiguo + t.morto,
        });
      }
      return linhas;
    },

    ressalvas() {
      const fora = {};
      for (const [tipo, t] of tipos.entries()) {
        if (!t.ambiguo && !t.morto) continue;
        fora[tipo] = {
          ambiguo: t.ambiguo,
          morto: t.morto,
          amostra_ambiguo: t.amostra_ambiguo,
          amostra_morto: t.amostra_morto,
        };
      }
      return fora;
    },

    vazio() {
      return tipos.size === 0;
    },
  };
}

// ─── TABELA EM MARKDOWN (entra no relatorio da importacao) ───────────────────
export function tabelaMarkdown(linhas) {
  if (!linhas.length) return "_nenhuma referencia para resolver nesta rodada._\n";
  const n = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("pt-BR"));
  const p = (v) => (v === null || v === undefined ? "—" : `${String(v).replace(".", ",")}%`);
  const L = [
    "| Referencia | Total | Sem alvo | Com alvo | Por id | Por nome | Por posicao | Ambiguo | Morto | Resolvido |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const l of linhas) {
    L.push(
      `| ${l.tipo} | ${n(l.total)} | ${n(l.sem_alvo_na_origem)} | ${n(l.com_alvo)} | ${n(l.por_id)} | ` +
        `${n(l.por_nome)} | ${n(l.por_posicao)} | ${n(l.ambiguo)} | ${n(l.morto)} | ${p(l.taxa_resolvido)} |`
    );
  }
  return L.join("\n") + "\n";
}
