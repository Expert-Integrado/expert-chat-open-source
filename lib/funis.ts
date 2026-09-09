// Funil e etapas — REGRA PURA (epico 11, cards 86ak86k62 / 86ak86kac).
//
// Regra deste arquivo: ZERO import, igual `lib/fluxo/schema.ts`. Ele e usado
// pelo Next (com alias @/) E por script solto rodando em Node puro
// (`node scripts/prova-funis.ts`, type stripping nativo) — qualquer dependencia
// quebraria o segundo caso. O que precisa de banco mora em `lib/funis-db.ts`.
//
// Por que a resolucao por NOME existe (e por que ela e cuidadosa):
// o fluxo canonico e PORTATIL entre instalacoes — um fluxo exportado nao pode
// carregar o uuid do funil desta instalacao. Entao a ACAO de fluxo referencia
// funil+etapa por NOME, e e aqui que o nome vira id. A armadilha: nome de etapa
// se REPETE entre funis ("Fechamento" costuma existir em varios) — por isso
// etapa NUNCA e resolvida por nome solto, sempre dentro do funil informado. A
// API do painel (kanban) trabalha por ID, nao por nome.

export const LIMITE_NOME = 120;
export const LIMITE_DESCRICAO = 500;

// Construidos com RegExp(string) pra o arquivo nao carregar literal de
// combinante nem de caractere de controle no meio do codigo.
const ACENTOS = new RegExp("[\\u0300-\\u036f]", "g");
const CONTROLE = new RegExp("[\\u0000-\\u001f\\u007f]", "g");
const ESPACOS = new RegExp("\\s+", "g");

export type EtapaCatalogo = {
  id: string;
  funil_id: string;
  nome: string;
  ordem: number;
  cor: string | null;
  ativo: boolean;
};

export type FunilCatalogo = {
  id: string;
  nome: string;
  ordem: number;
  ativo: boolean;
  etapas: EtapaCatalogo[];
};

// Vinculo conversa->etapa como o banco guarda (mensageria.conversa_funil).
export type Vinculo = { etapa_id: string; funil_id: string };

// ------------------------------------------------------------------- nomes
// Comparacao de nome ignora caixa, acento e espaco duplicado: "Pós-venda" e
// "pos venda" sao o MESMO funil pra quem digitou o fluxo na outra ferramenta.
// (O banco guarda o nome como o usuario escreveu; so a BUSCA e normalizada.)
export function normalizarNome(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD")
    .replace(ACENTOS, "")
    .replace(ESPACOS, " ")
    .trim()
    .toLowerCase();
}

// Nome aceitavel pra funil/etapa, ou null. Tira caractere de controle (byte
// nulo faz o PostgREST recusar a coluna text) e limita o tamanho.
export function nomeValido(v: unknown): string | null {
  const s = String(v ?? "")
    .replace(CONTROLE, " ")
    .replace(ESPACOS, " ")
    .trim();
  if (!s) return null;
  return s.slice(0, LIMITE_NOME);
}

// Cor da etapa: hex de 6 digitos ou nada. Mesma regra do CHECK da migration
// 0009 — o banco e a ultima barreira, mas a rota tem que recusar antes pra o
// erro chegar legivel em vez de virar 500 de constraint.
export function corValida(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  return /^#[0-9A-Fa-f]{6}$/.test(s) ? s.toUpperCase() : null;
}

export function ordemValida(v: unknown, padrao = 0): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return padrao;
  return Math.max(0, Math.min(100000, Math.round(n)));
}

// -------------------------------------------------------------- resolucao
export type ResolucaoEtapa =
  | { ok: true; funil: FunilCatalogo; etapa: EtapaCatalogo }
  | { ok: false; erro: string };

export function resolverFunil(catalogo: FunilCatalogo[], nome: unknown): FunilCatalogo | null {
  const alvo = normalizarNome(nome);
  if (!alvo) return null;
  return catalogo.find((f) => normalizarNome(f.nome) === alvo) ?? null;
}

// Resolve funil+etapa por NOME. Fail-closed e FALANTE: cada recusa diz o
// motivo, porque este texto vai parar na trilha do fluxo e no relatorio do
// importador — "nao deu" sem motivo obriga alguem a adivinhar depois.
export function resolverEtapa(
  catalogo: FunilCatalogo[],
  nomeFunil: unknown,
  nomeEtapa: unknown
): ResolucaoEtapa {
  const funil = resolverFunil(catalogo, nomeFunil);
  if (!funil) return { ok: false, erro: `funil "${String(nomeFunil ?? "")}" nao existe nesta instalacao` };
  if (!funil.ativo) return { ok: false, erro: `funil "${funil.nome}" esta arquivado` };
  const alvo = normalizarNome(nomeEtapa);
  if (!alvo) return { ok: false, erro: `etapa nao informada para o funil "${funil.nome}"` };
  const etapa = funil.etapas.find((e) => normalizarNome(e.nome) === alvo);
  if (!etapa) return { ok: false, erro: `etapa "${String(nomeEtapa)}" nao existe no funil "${funil.nome}"` };
  // Etapa arquivada NAO e ignorada em silencio (criterio do card 86ak86kac):
  // o passo do fluxo falha dizendo isso, e a trilha guarda a frase.
  if (!etapa.ativo) return { ok: false, erro: `etapa "${etapa.nome}" do funil "${funil.nome}" esta arquivada` };
  return { ok: true, funil, etapa };
}

// ---------------------------------------------------------------- movimento
export type AcaoMovimento = "entrou" | "saiu" | "moveu" | "nada";
export type PlanoMovimento = {
  /** etapas (do MESMO funil) das quais a conversa sai */
  remover: string[];
  /** etapa em que a conversa entra; null = so saiu (ou ja estava la) */
  inserir: string | null;
  acao: AcaoMovimento;
  /** etapa anterior DAQUELE funil, pra trilha ("veio de onde") */
  anterior: string | null;
};

// Mover dentro de um funil NAO mexe nos outros funis da conversa (criterio do
// card 86ak86kac): so as etapas do funil alvo entram no plano.
//
// Aceita mais de um vinculo no mesmo funil de proposito — o banco permite (a PK
// e por etapa) e importacao de outra ferramenta pode trazer conversa assim. Um
// movimento manual limpa a duplicidade em vez de fingir que ela nao existe.
export function planoDeMovimento(
  atuais: Vinculo[],
  funilId: string,
  etapaId: string | null
): PlanoMovimento {
  const noFunil = atuais.filter((v) => v.funil_id === funilId).map((v) => v.etapa_id);
  if (!etapaId) {
    return noFunil.length
      ? { remover: noFunil, inserir: null, acao: "saiu", anterior: noFunil[0] }
      : { remover: [], inserir: null, acao: "nada", anterior: null };
  }
  const jaEsta = noFunil.includes(etapaId);
  if (jaEsta && noFunil.length === 1) {
    return { remover: [], inserir: null, acao: "nada", anterior: etapaId };
  }
  const outras = noFunil.filter((e) => e !== etapaId);
  return {
    remover: outras,
    inserir: jaEsta ? null : etapaId,
    acao: noFunil.length ? "moveu" : "entrou",
    anterior: outras[0] ?? (jaEsta ? etapaId : null),
  };
}

// Proxima ordem livre (fim da fila) — usada ao criar funil/etapa.
export function proximaOrdem(lista: { ordem: number }[]): number {
  return lista.reduce((maior, x) => Math.max(maior, ordemValida(x.ordem)), -1) + 1;
}

// Monta o catalogo a partir das duas listas cruas do banco. Puro pra ser
// exercitado sem banco — e pra ordenacao ser UMA so (o quadro e a API leem a
// mesma ordem: `ordem`, com o nome como desempate).
export function montarCatalogo(
  funis: { id: string; nome: string; ordem?: number; ativo?: boolean }[],
  etapas: { id: string; funil_id: string; nome: string; ordem?: number; cor?: string | null; ativo?: boolean }[]
): FunilCatalogo[] {
  const porFunil = new Map<string, EtapaCatalogo[]>();
  for (const e of etapas ?? []) {
    const lista = porFunil.get(e.funil_id) ?? [];
    lista.push({
      id: e.id,
      funil_id: e.funil_id,
      nome: e.nome,
      ordem: ordemValida(e.ordem),
      cor: corValida(e.cor),
      ativo: e.ativo !== false,
    });
    porFunil.set(e.funil_id, lista);
  }
  const cmp = (a: { ordem: number; nome: string }, b: { ordem: number; nome: string }) =>
    a.ordem - b.ordem || a.nome.localeCompare(b.nome);
  return (funis ?? [])
    .map((f) => ({
      id: f.id,
      nome: f.nome,
      ordem: ordemValida(f.ordem),
      ativo: f.ativo !== false,
      etapas: (porFunil.get(f.id) ?? []).sort(cmp),
    }))
    .sort(cmp);
}
