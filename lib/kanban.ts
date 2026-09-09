// QUADRO (kanban) de conversas por funil — REGRA PURA, zero import.
//
// Mesmo contrato do lib/funis.ts: aqui nao ha banco, nem React, nem `@/`. Roda
// em node solto (`node scripts/prova-kanban.ts`), que e o unico jeito de provar
// arrastar-e-soltar sem navegador: o movimento otimista, o rollback e a
// montagem das colunas sao FUNCOES, e a tela so as chama.
//
// A tela consome `GET /api/funis?com_conversas=1`, que devolve:
//   funis[]           catalogo ATIVO (etapas ativas, ja ordenadas)
//   conversas[]       vinculo conversa->etapa, ja FILTRADO pelo escopo do usuario
//   cards[]           dados de cartao (nome, previa, etiquetas, responsaveis)
//   fora_do_quadro[]  contagem de conversa presa em etapa/funil arquivado
//   truncado          a lista bateu no teto do servidor
//
// DIVIDA TRATADA AQUI (CLAUDE.md, "etapa arquivada x vinculo remanescente"):
// arquivar etapa NAO apaga o vinculo. Quem ignora `fora_do_quadro` faz a
// conversa sumir da tela sem ninguem perceber — que e como trabalho se perde.
// Por isso `montarQuadro` devolve a coluna sintetica FORA_DO_QUADRO junto das
// reais, e ela nao aceita soltar cartao (nao existe etapa de destino).

export const COLUNA_FORA = "__fora_do_quadro__";

export type EtapaQuadro = { id: string; funil_id: string; nome: string; ordem: number; cor: string | null };
export type FunilQuadro = { id: string; nome: string; ordem: number; etapas: EtapaQuadro[] };

/** vinculo conversa->etapa como a rota devolve */
export type VinculoQuadro = {
  canal: string;
  chat_id: string;
  funil_id: string;
  etapa_id: string;
  atualizado_em: string | null;
  definido_por_nome: string | null;
};

/** dados de exibicao do cartao (a rota monta com o MESMO recorte de escopo) */
export type CardConversa = {
  canal: string;
  chat_id: string;
  nome: string | null;
  foto: string | null;
  preview: string | null;
  last_message_at: string | null;
  status: string | null;
  etiquetas: string[];
  responsaveis: { tipo: string; id: string; nome: string }[];
};

export type ForaDoQuadro = {
  funil: string | null;
  etapa: string | null;
  motivo: string;
  conversas: number;
};

/** cartao pronto pra desenhar: vinculo + dados, com a chave composta do painel */
export type CartaoQuadro = {
  /** identidade composta multi-canal, igual `Chat.uid` do painel */
  uid: string;
  canal: string;
  chat_id: string;
  etapa_id: string;
  funil_id: string;
  atualizado_em: string | null;
  /** quem moveu por ultimo — o rollback precisa devolver este valor exato */
  definido_por_nome: string | null;
  nome: string;
  foto: string | null;
  preview: string | null;
  last_message_at: string | null;
  status: string | null;
  etiquetas: string[];
  responsaveis: { tipo: string; id: string; nome: string }[];
};

export type ColunaQuadro = {
  etapa_id: string;
  nome: string;
  cor: string | null;
  /** coluna sintetica de conversa presa em estrutura arquivada: nao recebe cartao */
  sintetica: boolean;
  cartoes: CartaoQuadro[];
  total: number;
};

export const uidDe = (canal: string, chatId: string) => `${canal}:${chatId}`;

// ---------------------------------------------------------------- normalizar
const ACENTOS = new RegExp("[\\u0300-\\u036f]", "g");
const ESPACOS = new RegExp("\\s+", "g");

/** mesma igualdade de nome do lib/funis.ts: acento, caixa e espaco nao contam */
export function normalizar(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD")
    .replace(ACENTOS, "")
    .replace(ESPACOS, " ")
    .trim()
    .toLowerCase();
}

// --------------------------------------------------------------- selecionar
/**
 * Funil que a tela deve abrir: o pedido, se existir e estiver no catalogo;
 * senao o primeiro por ordem. Catalogo vazio devolve null (estado vazio).
 * Nunca devolve funil que nao esta na lista — id vindo de URL/localStorage e
 * DADO, nao verdade.
 */
export function funilSelecionado(funis: FunilQuadro[], pedido?: string | null): FunilQuadro | null {
  if (!funis.length) return null;
  const achado = pedido ? funis.find((f) => f.id === pedido) : null;
  if (achado) return achado;
  return [...funis].sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome))[0];
}

// ------------------------------------------------------------------ filtros
export type FiltroQuadro = {
  /** ref_id de pessoa ou departamento em conversa_responsaveis */
  responsavel?: string | null;
  etiqueta?: string | null;
  busca?: string | null;
  /** "" = todos; senao o id do canal */
  canal?: string | null;
};

/**
 * Filtro do cartao. A busca casa nome E telefone/chat_id (quem procura "5511..."
 * esta procurando a conversa, nao o texto). Sem criterio, tudo passa.
 */
export function cartaoPassa(c: CartaoQuadro, f: FiltroQuadro): boolean {
  if (f.canal && c.canal !== f.canal) return false;
  if (f.responsavel && !c.responsaveis.some((r) => r.id === f.responsavel)) return false;
  if (f.etiqueta && !c.etiquetas.some((e) => normalizar(e) === normalizar(f.etiqueta))) return false;
  const q = normalizar(f.busca);
  if (q) {
    const alvo = `${normalizar(c.nome)} ${c.chat_id.toLowerCase()}`;
    if (!alvo.includes(q)) return false;
  }
  return true;
}

// ------------------------------------------------------------------ montar
/**
 * Monta as colunas do funil escolhido a partir do catalogo + vinculos + cards.
 *
 * - colunas na ORDEM da etapa (a rota ja ordena, mas a tela nao pode depender
 *   disso: quem monta o quadro ordena);
 * - so entram vinculos DO funil pedido — uma conversa em 3 funis aparece em 3
 *   quadros, e mover num nunca mexe nos outros (N:N medido: 1.110 conversas);
 * - cartao sem `card` correspondente ainda aparece, com o chat_id no lugar do
 *   nome. Sumir com ele seria esconder conversa que existe;
 * - `total` e a contagem ANTES do corte por rolagem (o cabecalho da coluna
 *   mostra o numero real, o corpo mostra a fatia carregada).
 */
export function montarQuadro(args: {
  funil: FunilQuadro | null;
  vinculos: VinculoQuadro[];
  cards: CardConversa[];
  fora?: ForaDoQuadro[];
  filtro?: FiltroQuadro;
  /** quantos cartoes por coluna ja carregados (rolagem infinita) */
  visiveisPorColuna?: Record<string, number>;
  paginaInicial?: number;
}): ColunaQuadro[] {
  const { funil, vinculos, cards, fora = [], filtro = {}, visiveisPorColuna = {}, paginaInicial = 30 } = args;
  if (!funil) return [];

  const porChave = new Map<string, CardConversa>();
  for (const c of cards) porChave.set(uidDe(c.canal, c.chat_id), c);

  const cartoes: CartaoQuadro[] = [];
  for (const v of vinculos) {
    if (v.funil_id !== funil.id) continue;
    const uid = uidDe(v.canal, v.chat_id);
    const d = porChave.get(uid);
    cartoes.push({
      uid,
      canal: v.canal,
      chat_id: v.chat_id,
      etapa_id: v.etapa_id,
      funil_id: v.funil_id,
      atualizado_em: v.atualizado_em,
      definido_por_nome: v.definido_por_nome,
      // sem dado de cartao a conversa NAO some: mostra o identificador dela
      nome: d?.nome || v.chat_id,
      foto: d?.foto ?? null,
      preview: d?.preview ?? null,
      last_message_at: d?.last_message_at ?? null,
      status: d?.status ?? null,
      etiquetas: d?.etiquetas ?? [],
      responsaveis: d?.responsaveis ?? [],
    });
  }

  const etapas = [...funil.etapas].sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome));
  const colunas: ColunaQuadro[] = etapas.map((e) => {
    const daEtapa = cartoes
      .filter((c) => c.etapa_id === e.id && cartaoPassa(c, filtro))
      .sort(ordenarCartoes);
    const teto = visiveisPorColuna[e.id] ?? paginaInicial;
    return {
      etapa_id: e.id,
      nome: e.nome,
      cor: e.cor,
      sintetica: false,
      cartoes: daEtapa.slice(0, teto),
      total: daEtapa.length,
    };
  });

  // A coluna que ninguem quer ter, e que precisa existir: conversa presa em
  // etapa/funil arquivado. A rota manda so a CONTAGEM (sem chat_id, pra nao
  // vazar conversa por uma porta lateral) — entao a coluna e um aviso contado,
  // nao uma pilha de cartoes.
  const presas = fora.reduce((s, f) => s + f.conversas, 0);
  if (presas > 0) {
    colunas.push({
      etapa_id: COLUNA_FORA,
      nome: "Fora do quadro",
      cor: null,
      sintetica: true,
      cartoes: [],
      total: presas,
    });
  }
  return colunas;
}

/** mais recente primeiro; empate resolve pelo nome pra ordem nao dancar */
export function ordenarCartoes(a: CartaoQuadro, b: CartaoQuadro): number {
  const ta = a.last_message_at || a.atualizado_em || "";
  const tb = b.last_message_at || b.atualizado_em || "";
  if (ta !== tb) return tb.localeCompare(ta);
  return a.nome.localeCompare(b.nome);
}

// -------------------------------------------------------- movimento otimista
export type Movimento = {
  uid: string;
  canal: string;
  chat_id: string;
  funil_id: string;
  /** etapa antes do arrasto — e o que o rollback usa */
  de: string | null;
  para: string;
  /**
   * Metadado do vinculo ANTES do arrasto. O rollback restaura estes valores em
   * vez de inventar: sem eles, desfazer carimbava "agora" no `atualizado_em` e
   * o cartao subia pro topo da coluna por causa de um movimento que NAO
   * aconteceu — a tela mentindo sobre atividade recente.
   */
  deAtualizadoEm?: string | null;
  deDefinidoPorNome?: string | null;
  /** quem esta movendo: o cartao carimba o autor na hora, sem esperar o servidor */
  porNome?: string | null;
};

/** o mesmo vinculo? (conversa + funil — a etapa e o que muda) */
const mesmoVinculo = (v: VinculoQuadro, m: Movimento) =>
  v.canal === m.canal && v.chat_id === m.chat_id && v.funil_id === m.funil_id;

/**
 * Aplica o movimento na lista de vinculos ANTES do servidor responder (a tela
 * tem que reagir na hora do soltar). Devolve a lista nova; a chamadora guarda o
 * `Movimento` pra desfazer.
 *
 * Regra do funil (igual `planoDeMovimento` do lib/funis.ts): dentro do funil a
 * conversa fica em UMA etapa — mover troca a etapa; os vinculos de OUTROS
 * funis ficam intactos.
 *
 * O carimbo (`quem` e `quando`) e do movimento que esta acontecendo AGORA:
 * herdar o autor do vinculo antigo faria o cartao creditar a mudanca a quem
 * moveu da vez passada. `agora` e injetavel so pra prova.
 */
export function aplicarMovimento(vinculos: VinculoQuadro[], m: Movimento, agora?: string): VinculoQuadro[] {
  return [
    ...vinculos.filter((v) => !mesmoVinculo(v, m)),
    {
      canal: m.canal,
      chat_id: m.chat_id,
      funil_id: m.funil_id,
      etapa_id: m.para,
      atualizado_em: agora ?? new Date().toISOString(),
      definido_por_nome: m.porNome ?? null,
    },
  ];
}

/**
 * Desfaz o movimento quando o POST falha. Volta pra etapa `de` com o metadado
 * que o vinculo tinha; se a conversa nao tinha etapa nenhuma naquele funil
 * (`de: null`), o vinculo some — que era o estado real antes do arrasto.
 *
 * MOVIMENTO MAIS NOVO VENCE: se a conversa ja saiu de `m.para` (o atendente
 * arrastou de novo, e esse segundo movimento GRAVOU), desfazer o primeiro
 * jogaria a tela pra um lugar que o servidor nao tem mais — divergencia
 * silenciosa, o pior desfecho possivel. Nesse caso o rollback nao faz nada.
 */
export function desfazerMovimento(vinculos: VinculoQuadro[], m: Movimento): VinculoQuadro[] {
  const atual = vinculos.find((v) => mesmoVinculo(v, m));
  // o vinculo ja nao esta onde este movimento o colocou: alguem passou na
  // frente (ou ele foi removido). Nao mexer.
  if (!atual || atual.etapa_id !== m.para) return vinculos;

  const fora = vinculos.filter((v) => !mesmoVinculo(v, m));
  if (!m.de) return fora;
  return [
    ...fora,
    {
      canal: m.canal,
      chat_id: m.chat_id,
      funil_id: m.funil_id,
      etapa_id: m.de,
      atualizado_em: m.deAtualizadoEm ?? null,
      definido_por_nome: m.deDefinidoPorNome ?? null,
    },
  ];
}

/**
 * O arrasto vale a pena? Soltar na propria coluna, soltar na coluna sintetica
 * ou soltar sem cartao nao viram requisicao — evita gravar evento de trilha
 * que nao aconteceu.
 */
export function movimentoValido(m: { de: string | null; para: string }): boolean {
  if (!m.para || m.para === COLUNA_FORA) return false;
  return m.de !== m.para;
}

// ------------------------------------------------------------------ opcoes
/**
 * Etiquetas e responsaveis presentes NO funil aberto — alimenta os seletores de
 * filtro. Sao lidos dos `cards` direto, nao de um quadro remontado: montar o
 * quadro inteiro (com ordenacao de milhares de cartoes) so pra colher dois
 * conjuntos custava uma varredura completa a cada mudanca de dados.
 *
 * As opcoes saem do funil ABERTO e sem filtro aplicado — senao escolher um
 * responsavel apagaria os outros nomes da propria lista de onde ele saiu.
 *
 * DEPARTAMENTO tambem entra: `conversa_responsaveis` guarda pessoa e
 * departamento, e filtrar o quadro por "Suporte" e caso de uso do gestor.
 */
export function opcoesDoFunil(args: {
  funil: FunilQuadro | null;
  vinculos: VinculoQuadro[];
  cards: CardConversa[];
}): { etiquetas: string[]; responsaveis: { id: string; nome: string }[] } {
  const { funil, vinculos, cards } = args;
  if (!funil) return { etiquetas: [], responsaveis: [] };

  const noFunil = new Set<string>();
  for (const v of vinculos) if (v.funil_id === funil.id) noFunil.add(uidDe(v.canal, v.chat_id));

  const etiquetas = new Set<string>();
  const resp = new Map<string, string>();
  for (const c of cards) {
    if (!noFunil.has(uidDe(c.canal, c.chat_id))) continue;
    for (const e of c.etiquetas) etiquetas.add(e);
    for (const r of c.responsaveis) resp.set(r.id, r.nome);
  }
  return {
    etiquetas: [...etiquetas].sort((a, b) => a.localeCompare(b)),
    responsaveis: [...resp.entries()].map(([id, nome]) => ({ id, nome })).sort((a, b) => a.nome.localeCompare(b.nome)),
  };
}

/** rotulo curto de responsavel pro cartao (o cartao e pequeno; a ficha tem tudo) */
export function rotuloResponsavel(c: { responsaveis: { nome: string }[] }): string | null {
  if (!c.responsaveis.length) return null;
  const [p, ...resto] = c.responsaveis;
  return resto.length ? `${p.nome} +${resto.length}` : p.nome;
}
