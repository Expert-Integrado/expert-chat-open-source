// Regras PURAS do editor/gestao de fluxos (modulo `automacao`, Frente K).
//
// Por que este arquivo existe separado de `lib/fluxo/schema.ts`: o schema e o
// CONTRATO PUBLICO do formato (motor, banco, conversores) e tem dono proprio.
// O que mora aqui e a camada de GESTAO — pasta, busca, grafo de chamadas,
// edicao rapida — que e assunto do painel e nao do formato. Misturar os dois
// faria a tela empurrar campo pra dentro do contrato publico.
//
// Mesma disciplina do schema: ZERO import. Roda no Next e em node solto
// (`node scripts/prova-editor-fluxo.ts`), e por isso nao importa nem tipo.
//
// CONTEUDO DE TERCEIRO: fluxo importado e dado de outra ferramenta (e, no
// limite, de outra empresa). Tudo aqui trata o jsonb como HOSTIL — nunca lanca,
// nunca confia em tipo, e devolve valor saneado. Quem renderiza nao escapa nada
// na mao: React escapa texto sozinho, e a regra do modulo e nunca usar
// dangerouslySetInnerHTML numa superficie que mostra fluxo (a prova verifica).

// ------------------------------------------------------------------ pastas
//
// Pasta e CAMINHO em texto ("CRM / Educacional"), nao tabela. Duas razoes:
//   1. A medicao do card 86ak85a5e mostra a hierarquia ja existindo DENTRO do
//      nome ("CRM | Educacional", "Campanhas | Disparo simples") porque a
//      ferramenta de origem so tem um nivel. Caminho em texto absorve isso na
//      importacao sem tabela nova e sem migration de dados.
//   2. Mover fluxo entre pastas NAO pode mudar comportamento nem quebrar quem
//      chama (criterio de aceite). Com pasta fora do jsonb e sem id proprio,
//      mover e trocar uma string de metadado — nao ha o que quebrar.
//
// A pasta vive em COLUNA (`mensageria.fluxos.pasta`, migration 0015) e nunca
// dentro do jsonb: `validarFluxo` normaliza o fluxo campo a campo e descartaria
// silenciosamente qualquer chave que ela nao conheca.
export const SEPARADOR_PASTA = "/";
export const PROFUNDIDADE_MAX_PASTA = 5;
export const LIMITE_SEGMENTO_PASTA = 60;
export const LIMITE_PASTA = 300;

// Separadores que a ferramenta de origem usa pra fingir hierarquia dentro do
// nome de um grupo plano. Viram nivel de pasta APENAS quando alguem confirma
// (`sugerirHierarquia`), nunca sozinho — criterio de aceite do card.
export const SEPARADORES_SUGESTAO = ["|", ">", "»", "/"];

function ehTexto(v: unknown): v is string {
  return typeof v === "string";
}

// Tira o que quebraria a arvore ou a tela: controle, separador e espaco duplo.
function saneiaSegmento(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITE_SEGMENTO_PASTA);
}

// Caminho normalizado. "" = raiz (fluxo sem pasta). Nunca lanca: entrada
// invalida vira raiz, e nao erro — pasta e organizacao, nao pode impedir de
// gravar o fluxo.
export function normalizarPasta(bruto: unknown): string {
  if (!ehTexto(bruto)) return "";
  const segs = bruto
    .split(SEPARADOR_PASTA)
    .map(saneiaSegmento)
    .filter(Boolean)
    .slice(0, PROFUNDIDADE_MAX_PASTA);
  return segs.join(` ${SEPARADOR_PASTA} `).slice(0, LIMITE_PASTA);
}

export function segmentosPasta(pasta: string): string[] {
  return normalizarPasta(pasta)
    .split(SEPARADOR_PASTA)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function pastaPai(pasta: string): string {
  const segs = segmentosPasta(pasta);
  return segs.length > 1 ? segs.slice(0, -1).join(` ${SEPARADOR_PASTA} `) : "";
}

// Uma pasta CONTEM outra (ou e ela mesma). Comparacao por SEGMENTO, nunca por
// prefixo de string: "Vendas" nao pode conter "Vendas B2B" so porque o texto
// comeca igual — renomear pasta por prefixo cru moveria fluxo de outra arvore.
export function pastaContem(pai: string, filha: string): boolean {
  const a = segmentosPasta(pai);
  const b = segmentosPasta(filha);
  if (!a.length) return true; // raiz contem tudo
  if (b.length < a.length) return false;
  return a.every((s, i) => s === b[i]);
}

// Renomear/mover pasta = reescrever o prefixo de segmentos das filhas.
// Devolve o caminho novo, ou o mesmo caminho quando o fluxo nao esta na arvore.
export function moverPasta(pastaDoFluxo: string, de: string, para: string): string {
  const alvo = segmentosPasta(de);
  if (!alvo.length) return normalizarPasta(pastaDoFluxo);
  if (!pastaContem(de, pastaDoFluxo)) return normalizarPasta(pastaDoFluxo);
  const atual = segmentosPasta(pastaDoFluxo);
  const resto = atual.slice(alvo.length);
  const novo = [...segmentosPasta(para), ...resto];
  return normalizarPasta(novo.join(SEPARADOR_PASTA));
}

export type NoPasta = {
  caminho: string;
  nome: string;
  nivel: number;
  // fluxos DIRETAMENTE nesta pasta
  fluxos: number;
  // fluxos nesta pasta e em toda a subarvore (o numero que a tela mostra
  // quando a pasta esta fechada — sem ele, pasta fechada parece vazia)
  total: number;
  filhas: NoPasta[];
};

// Arvore de pastas a partir dos caminhos usados. Pasta intermediaria que
// ninguem usa direto ("CRM" quando so existe "CRM / SaaS") e CRIADA na arvore:
// sem isso a hierarquia aparece furada na tela.
export function arvoreDePastas(pastas: Iterable<string>): NoPasta[] {
  const contagem = new Map<string, number>();
  const conhecidos = new Set<string>();
  for (const bruta of pastas) {
    const p = normalizarPasta(bruta);
    if (!p) continue;
    contagem.set(p, (contagem.get(p) ?? 0) + 1);
    const segs = segmentosPasta(p);
    for (let i = 1; i <= segs.length; i++) {
      conhecidos.add(segs.slice(0, i).join(` ${SEPARADOR_PASTA} `));
    }
  }

  const nos = new Map<string, NoPasta>();
  for (const caminho of conhecidos) {
    const segs = segmentosPasta(caminho);
    nos.set(caminho, {
      caminho,
      nome: segs[segs.length - 1],
      nivel: segs.length - 1,
      fluxos: contagem.get(caminho) ?? 0,
      total: 0,
      filhas: [],
    });
  }
  const raizes: NoPasta[] = [];
  for (const no of nos.values()) {
    const pai = pastaPai(no.caminho);
    const nPai = pai ? nos.get(pai) : undefined;
    if (nPai) nPai.filhas.push(no);
    else raizes.push(no);
  }
  const ordenar = (lista: NoPasta[]) => {
    lista.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    for (const n of lista) ordenar(n.filhas);
  };
  ordenar(raizes);
  const somar = (n: NoPasta): number => {
    n.total = n.fluxos + n.filhas.reduce((s, f) => s + somar(f), 0);
    return n.total;
  };
  for (const r of raizes) somar(r);
  return raizes;
}

// Sugestao de hierarquia a partir de nome plano com separador improvisado.
// Devolve null quando nao ha o que sugerir. NUNCA e aplicada sozinha: quem
// chama mostra e espera confirmacao (criterio de aceite do card 86ak85a5e).
export function sugerirHierarquia(nomeDoGrupo: unknown): string | null {
  if (!ehTexto(nomeDoGrupo)) return null;
  const bruto = nomeDoGrupo.trim();
  if (!bruto) return null;
  const sep = SEPARADORES_SUGESTAO.find((s) => bruto.includes(s));
  if (!sep) return null;
  const partes = bruto
    .split(sep)
    .map((p) => saneiaSegmento(p))
    .filter(Boolean);
  if (partes.length < 2) return null;
  const sugerida = normalizarPasta(partes.join(SEPARADOR_PASTA));
  const plana = normalizarPasta(bruto);
  return sugerida && sugerida !== plana ? sugerida : null;
}

// ------------------------------------------------------------------- slug
// Espelho do ID_RE de schema.ts (este arquivo nao importa nada de proposito;
// mudou la, muda aqui). Vale pro id do fluxo e pro slug da coluna — os dois
// entram em URL e em filtro de banco, entao formato invalido para ANTES.
const SLUG_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function slugValido(v: unknown): v is string {
  return ehTexto(v) && SLUG_RE.test(v);
}

// Slug a partir do nome digitado. Sem acento, sem espaco, sem surpresa — e
// verificado por slugValido antes de sair daqui.
export function slugDeNome(nome: unknown, sufixo = ""): string {
  const base = (ehTexto(nome) ? nome : "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const s = `${base || "fluxo"}${sufixo ? `-${sufixo}` : ""}`.slice(0, 64);
  return slugValido(s) ? s : "fluxo";
}

// Slug livre dentro de um conjunto ja usado (duplicar fluxo, criar dois com o
// mesmo nome). Determinista: -2, -3, ...
export function slugLivre(nome: unknown, usados: Iterable<string>): string {
  const jaTem = new Set<string>();
  for (const u of usados) if (ehTexto(u)) jaTem.add(u);
  const base = slugDeNome(nome);
  if (!jaTem.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const tent = `${base.slice(0, 60)}-${i}`;
    if (!jaTem.has(tent)) return tent;
  }
  return `${base.slice(0, 55)}-${Date.now().toString(36).slice(-4)}`;
}

// ------------------------------------------------------- nome da COPIA
//
// DUPLICAR FLUXO (card 86ak86jw9): "cria uma copia com o titulo prefixado
// ('Copia de ...'), na mesma pasta, DESLIGADA, com todas as acoes e condicoes".
// O prefixo vai ACENTUADO porque e o texto que o criterio de aceite cita e
// porque nome de fluxo e DADO que a pessoa le e edita — nao e string de UI.
export const PREFIXO_COPIA = "Cópia de ";
// espelho do corte de nome em aplicarPatchNoFluxo (e do que o schema aceita)
export const LIMITE_NOME_FLUXO = 200;

// Marcas combinantes por ESCAPE, nunca cruas no fonte: combinante solto e
// INVISIVEL, morre em copia/patch/normalizacao de editor e a classe deixa de
// casar EM SILENCIO (acento passaria a contar na comparacao). Mesma regra de
// lib/fluxo/variaveis.ts e lib/transcricao.ts.
const RE_COMBINANTES = new RegExp("[\u0300-\u036f]", "g");

// Comparacao de nome pra achar copia repetida: sem caixa, sem acento, sem espaco
// duplo. Sem isso, "Copia de X" e "copia de x" seriam dois nomes "livres" e a
// lista ficaria com duas linhas identicas aos olhos de quem opera.
function nomeComparavel(v: unknown): string {
  return (ehTexto(v) ? v : "")
    .normalize("NFD")
    .replace(RE_COMBINANTES, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Nome da copia, livre entre os nomes que ja existem.
 *
 * Duas decisoes que o card nao decide e o uso real cobra:
 *
 *  1. **O prefixo NAO se acumula.** Duplicar a copia da copia daria
 *     "Copia de Copia de Copia de X" e comeria o nome (o teto e 200 chars); a
 *     informacao "isto e uma copia" ja esta dita uma vez. Copia de copia vira
 *     "Copia de X (2)".
 *  2. **Quem e cortado pelo teto e o NOME, nunca o prefixo nem o numero** — o
 *     marcador e o numero sao justamente o que distingue as linhas na lista.
 */
export function nomeDeCopia(nome: unknown, nomesUsados: Iterable<string> = []): string {
  const jaTem = new Set<string>();
  for (const u of nomesUsados) jaTem.add(nomeComparavel(u));

  let base = (ehTexto(nome) ? nome : "").replace(/\s+/g, " ").trim() || "fluxo";
  // tira os prefixos que ja estao la (1) e o " (N)" do fim, pra numerar a partir
  // do nome de verdade
  // O `prefixoComparavel &&` nao e zelo: `startsWith("")` e sempre verdadeiro, e
  // com prefixo vazio este laco nunca encurtaria a base — laco infinito no
  // servidor. Achado pela bateria de MUTACAO desta frente (a mutacao que zera o
  // prefixo pendurou a prova em vez de reprovar).
  const prefixoComparavel = nomeComparavel(PREFIXO_COPIA);
  while (prefixoComparavel && nomeComparavel(base).startsWith(prefixoComparavel)) {
    base = base.slice(PREFIXO_COPIA.length).trim() || "fluxo";
  }
  base = base.replace(/\s*\((\d{1,3})\)$/, "").trim() || "fluxo";

  const monta = (n: number) => {
    const sufixo = n > 1 ? ` (${n})` : "";
    const espaco = LIMITE_NOME_FLUXO - PREFIXO_COPIA.length - sufixo.length;
    return `${PREFIXO_COPIA}${base.slice(0, Math.max(1, espaco))}${sufixo}`;
  };
  for (let n = 1; n < 1000; n++) {
    const tent = monta(n);
    if (!jaTem.has(nomeComparavel(tent))) return tent;
  }
  return monta(999);
}

// -------------------------------------------------------- busca (ilike)
// GOTCHA que ja custou incidente em outro repo: `%` e `_` digitados pelo
// usuario sao CORINGA no ilike do Postgres. Buscar "10%" sem escapar casa com
// qualquer coisa que comece com 10. Escapar aqui e obrigatorio; a rota usa isto
// antes de montar o filtro.
export function escaparLike(termo: unknown): string {
  if (!ehTexto(termo)) return "";
  return termo.replace(/([\\%_,])/g, "\\$1").trim();
}

// ------------------------------------------------- leitura tolerante do jsonb
// Daqui pra baixo tudo le o fluxo BRUTO (como esta no banco), nao o validado.
// De proposito: a listagem e o mapa precisam mostrar TAMBEM o fluxo que nao
// valida — importado por outra versao do schema, gravado a mao, ou usando uma
// acao que a v1 ainda nao tem. Esconder o invalido faria a tela mentir sobre o
// tamanho da rede justamente pra quem precisa consertar.

function nosBrutos(raw: any): any[] {
  return raw && typeof raw === "object" && Array.isArray(raw.nos) ? raw.nos : [];
}

// CONTRATO DE CHAMADA ENTRE FLUXOS (a aresta do mapa do card 86ak85a40).
//
// ESTADO REAL EM 31/08/2026, medido no repo: `ACOES_V1` (schema.ts) NAO tem
// acao de chamar outro fluxo, e o conversor do ChatGuru registra a acao DIALOGO
// como RESSALVA ("chama outro dialogo (encadeamento); chamar outro fluxo e v2")
// — ou seja, hoje o alvo da chamada nao chega ao banco. O mapa nasce, portanto,
// com as caixas certas e ZERO seta sobre dado importado, e a tela diz isso na
// cara em vez de fingir rede vazia.
//
// O formato abaixo e o contrato contra o qual o mapa ja esta escrito: no dia em
// que a acao existir no schema, a seta aparece sem tocar nesta camada. Aliases
// existem porque outro conversor pode chegar antes da padronizacao.
export const ACOES_CHAMADA = ["chamar_fluxo", "executar_fluxo", "chamar_dialogo", "dialogo"] as const;
const CAMPOS_ALVO = ["fluxo", "slug", "alvo", "destino", "fluxo_slug", "fluxo_id"] as const;

// Slug do fluxo chamado por UMA acao bruta, ou null.
export function alvoDaChamada(acaoBruta: unknown): string | null {
  const a = acaoBruta as any;
  if (!a || typeof a !== "object") return null;
  if (!(ACOES_CHAMADA as readonly string[]).includes(a.tipo)) return null;
  for (const campo of CAMPOS_ALVO) {
    const v = a[campo];
    if (slugValido(v)) return v;
  }
  return null;
}

// Chamadas entre fluxos que a importacao NAO trouxe. Sai das ressalvas, que sao
// o unico rastro que sobra quando o conversor nao consegue representar a acao.
// Diz "aqui saia uma seta", sem inventar pra onde.
//
// CUIDADO COM A PALAVRA "PERDIDA" — medicao da frente-c-motor (31/08/2026) nas
// 3.607 acoes DIALOGO de 33 backups: 2.402 apontam pra um alvo de verdade (pelo
// NOME do dialogo, nunca por id) e 1.205 (33%) sao o placeholder
// "-- SELECIONE O DIALOGO --", ou seja, NUNCA tiveram alvo. Chamar as 1.205 de
// "perda" seria acusar um buraco que nao existe. Enquanto o conversor gravar a
// MESMA ressalva pros dois casos, nao da pra separar, e a unica saida honesta e
// a tela nao afirmar perda — so dizer que a chamada nao veio.
//
// `sem_alvo` ja le o caso separado pra quando o conversor distinguir (a
// resolucao nome -> id e da frente-c e sai junto com o motor v2).
// POR QUE ISTO E BOOLEANO E NAO CONTAGEM — o conversor DEDUPLICA as ressalvas
// dentro de cada fluxo (`ressalvas: Array.from(new Set(ressalvas))` em
// scripts/fluxo/converter-chatguru.mjs). Logo um fluxo com 15 chamadas e um
// fluxo com 1 chamada chegam aqui com a MESMA ressalva unica: "quantas" e
// informacao que nao existe mais no dado. Contar linha de ressalva e chamar
// isso de "N chamadas" seria numero inventado — um fluxo com 15 chamadas
// mostraria "1". Entao o que a tela pode afirmar e PRESENCA.
export type SinalChamadas = {
  /** havia chamada SEM alvo configurado na origem: nunca teve destino */
  sem_alvo: boolean;
  /** havia chamada com alvo real que a importacao nao conseguiu trazer */
  alvo_nomeado: boolean;
};

// Marcadores do caso "nunca teve alvo". A string que o conversor grava hoje e
// "acao DIALOGO sem alvo configurado (nenhum dialogo selecionado no
// formulario): nao havia chamada a trazer" — casa por "sem alvo". A string do
// alvo real ("chama outro dialogo (encadeamento); chamar outro fluxo e v2") nao
// casa com nenhum marcador, e a prova trava as duas.
const MARCA_SEM_ALVO = /sem alvo|nenhum dialogo selecionado|nao configurad|sem destino/i;

export function classificarChamadas(raw: any): SinalChamadas {
  const rs = raw?.origem?.ressalvas;
  if (!Array.isArray(rs)) return { sem_alvo: false, alvo_nomeado: false };
  const daChamada = (rs as unknown[]).filter(
    (r) => ehTexto(r) && /dialogo/i.test(r) && /cham/i.test(r)
  ) as string[];
  return {
    sem_alvo: daChamada.some((r) => MARCA_SEM_ALVO.test(r)),
    alvo_nomeado: daChamada.some((r) => !MARCA_SEM_ALVO.test(r)),
  };
}

// Slugs chamados por este fluxo, sem repeticao e sem auto-chamada.
export function chamadasDoFluxo(raw: any): string[] {
  const proprio = ehTexto(raw?.id) ? raw.id : null;
  const alvos = new Set<string>();
  for (const no of nosBrutos(raw)) {
    const alvo = alvoDaChamada(no?.acao);
    if (alvo && alvo !== proprio) alvos.add(alvo);
  }
  return [...alvos];
}

// Texto pesquisavel do fluxo: nome, descricao, rotulo e o conteudo das acoes.
// E o que atende "busca pelo conteudo dos passos e pelas variaveis usadas" —
// avaliar impacto antes de mudar depende disso.
export function textoDoFluxo(raw: any): string {
  const partes: string[] = [];
  const poe = (v: unknown) => {
    if (ehTexto(v) && v.trim()) partes.push(v);
  };
  poe(raw?.nome);
  poe(raw?.descricao);
  poe(raw?.origem?.id_original);
  for (const no of nosBrutos(raw)) {
    poe(no?.rotulo);
    const a = no?.acao;
    if (!a || typeof a !== "object") continue;
    poe(a.tipo);
    poe(a.texto);
    poe(a.status);
    poe(a.funil);
    poe(a.etapa);
    if (Array.isArray(a.etiquetas)) for (const e of a.etiquetas) poe(e);
    if (Array.isArray(a.responsaveis)) for (const r of a.responsaveis) poe(r?.nome);
    for (const campo of CAMPOS_ALVO) poe(a[campo]);
    for (const r of Array.isArray(no?.ramos) ? no.ramos : []) poe(r?.quando);
  }
  return partes.join(" \n ");
}

function semAcento(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Busca de UM termo. `escopo` decide se olha so o nome ou tambem o conteudo
// dos passos — o card pede as duas, e a de conteudo e cara demais pra ser o
// default silencioso numa conta com centenas de fluxos.
export function casaBusca(
  item: { nome?: unknown; pasta?: unknown; fluxo?: unknown },
  termo: unknown,
  escopo: "nome" | "conteudo" = "nome"
): boolean {
  const t = semAcento(ehTexto(termo) ? termo.trim() : "");
  if (!t) return true;
  const alvo =
    escopo === "conteudo"
      ? `${ehTexto(item.nome) ? item.nome : ""} ${ehTexto(item.pasta) ? item.pasta : ""} ${textoDoFluxo(item.fluxo)}`
      : `${ehTexto(item.nome) ? item.nome : ""} ${ehTexto(item.pasta) ? item.pasta : ""}`;
  return semAcento(alvo).includes(t);
}

// -------------------------------------------------------------- o grafo
export type ItemGrafo = {
  slug: string;
  nome: string;
  pasta: string;
  ativo: boolean;
  // fluxo bruto (jsonb do banco)
  fluxo?: unknown;
};

export type NoGrafo = {
  slug: string;
  nome: string;
  pasta: string;
  ativo: boolean;
  chama: string[];
  // QUEM CHAMA ESTE FLUXO — requisito, nao extra (card 86ak85a40: o fluxo
  // "Manter status resolvido" e chamado 69 vezes; sem esta lista ninguem mexe
  // nele sem medo de quebrar 69 lugares).
  chamado_por: string[];
  // chamadas cujo alvo nao existe na conta (importacao parcial, fluxo apagado)
  alvos_ausentes: string[];
  // presenca de chamada que a importacao nao trouxe (ver classificarChamadas —
  // e booleano de proposito: a ressalva e deduplicada por fluxo, entao
  // "quantas" nao existe no dado)
  chamadas: SinalChamadas;
};

export type Grafo = {
  nos: NoGrafo[];
  // quem ninguem chama: ponto de ENTRADA da rede, e por onde o mapa comeca
  raizes: string[];
  // total de arestas efetivamente conhecidas
  arestas: number;
  // quantos FLUXOS (nao chamadas) tem cada caso. Contar fluxo e o que o dado
  // permite: a ressalva deduplicada nao diz quantas chamadas havia.
  fluxos_com_alvo_nao_trazido: number;
  fluxos_sem_alvo: number;
};

export function montarGrafo(itens: Iterable<ItemGrafo>): Grafo {
  const nos = new Map<string, NoGrafo>();
  for (const it of itens) {
    if (!slugValido(it?.slug)) continue;
    nos.set(it.slug, {
      slug: it.slug,
      nome: ehTexto(it.nome) && it.nome.trim() ? it.nome : it.slug,
      pasta: normalizarPasta(it.pasta),
      ativo: it.ativo !== false,
      chama: [],
      chamado_por: [],
      alvos_ausentes: [],
      chamadas: classificarChamadas(it.fluxo),
    });
  }
  let arestas = 0;
  for (const it of itens) {
    const no = slugValido(it?.slug) ? nos.get(it.slug) : undefined;
    if (!no) continue;
    for (const alvo of chamadasDoFluxo(it.fluxo)) {
      const destino = nos.get(alvo);
      if (!destino) {
        no.alvos_ausentes.push(alvo);
        continue;
      }
      no.chama.push(alvo);
      destino.chamado_por.push(no.slug);
      arestas++;
    }
  }
  const lista = [...nos.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  return {
    nos: lista,
    raizes: lista.filter((n) => !n.chamado_por.length).map((n) => n.slug),
    arestas,
    fluxos_com_alvo_nao_trazido: lista.filter((n) => n.chamadas.alvo_nomeado).length,
    fluxos_sem_alvo: lista.filter((n) => n.chamadas.sem_alvo).length,
  };
}

export type LinhaMapa = { slug: string; nivel: number; repetido: boolean };

// Teto de linhas do mapa. Existe porque a rede real e larga: um fluxo chamado
// por dezenas (o "Manter status resolvido" e chamado 69 vezes) aparece em cada
// ramo que o alcanca, e sem teto o desenho cresce com o numero de CAMINHOS, nao
// de fluxos.
export const LIMITE_LINHAS_MAPA = 3000;
const PROFUNDIDADE_MAX_MAPA = 12;

// Desenho do mapa como LISTA INDENTADA — de proposito, sem biblioteca de grafo.
// A medicao do card diz que a rede e larga e rasa (322 fluxos chamando, 203
// chamados); lista indentada le melhor que canvas nesse formato, sobrevive a
// centenas de itens e nao adiciona dependencia.
//
// DUAS PROTECOES, e a segunda e a que nao e obvia:
//   1. CICLO (A chama B que chama A) e cortado e marcado `repetido`.
//   2. NO ALCANCAVEL POR VARIOS CAMINHOS e expandido UMA vez so. Sem isso o
//      ciclo estaria coberto mas um hub com fan-out ainda explodiria: cada
//      caminho que chega nele reexpandiria a subarvore inteira, e o custo
//      cresceria com o numero de caminhos (combinatorio) dentro de um useMemo
//      na thread principal. Ele reaparece como `repetido`, entao nada
//      desaparece do mapa — so nao e redesenhado embaixo.
export function linhasDoMapa(grafo: Grafo, raiz?: string): LinhaMapa[] {
  const porSlug = new Map(grafo.nos.map((n) => [n.slug, n]));
  const linhas: LinhaMapa[] = [];
  // ja teve a subarvore desenhada (protecao 2)
  const expandido = new Set<string>();
  // ja apareceu em alguma linha — usado pro varredor de orfaos nao reemitir
  const emitidos = new Set<string>();
  const partida = raiz && porSlug.has(raiz) ? [raiz] : grafo.raizes;
  const caminhar = (slug: string, nivel: number, ancestrais: Set<string>) => {
    if (linhas.length >= LIMITE_LINHAS_MAPA) return;
    const no = porSlug.get(slug);
    if (!no) return;
    const emCiclo = ancestrais.has(slug);
    const jaDesenhado = expandido.has(slug);
    linhas.push({ slug, nivel, repetido: emCiclo || jaDesenhado });
    emitidos.add(slug);
    if (emCiclo || jaDesenhado || nivel >= PROFUNDIDADE_MAX_MAPA) return;
    expandido.add(slug);
    const proximos = new Set(ancestrais);
    proximos.add(slug);
    for (const alvo of no.chama) caminhar(alvo, nivel + 1, proximos);
  };
  for (const r of partida) caminhar(r, 0, new Set());
  // Fluxo que so existe dentro de um ciclo nao tem raiz e ficaria FORA do mapa.
  // `emitidos` e alimentado DENTRO de caminhar de proposito: com um retrato
  // tirado antes do laco, o primeiro fluxo de um cluster puxava os outros e
  // eles seriam emitidos de novo na propria iteracao do laco (cluster duplicado).
  for (const n of grafo.nos) {
    if (!emitidos.has(n.slug)) caminhar(n.slug, 0, new Set());
  }
  return linhas;
}

// ------------------------------------------------------- edicao rapida
// Edicao rapida e editor completo escrevem no MESMO modelo (criterio de aceite
// do card 86ak85nzy): o patch e aplicado sobre o fluxo gravado e o resultado
// passa por `validarFluxo` na rota, igual ao save do editor. Nada aqui grava.
export type PatchRapido = {
  nome?: unknown;
  descricao?: unknown;
};

// Devolve uma COPIA do fluxo bruto com nome/descricao trocados. Campo ausente
// no patch nao mexe no valor atual; descricao vazia REMOVE a descricao.
export function aplicarPatchNoFluxo(raw: unknown, patch: PatchRapido): any {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as any) } : {};
  if (patch.nome !== undefined && ehTexto(patch.nome) && patch.nome.trim()) {
    base.nome = patch.nome.trim().slice(0, 200);
  }
  if (patch.descricao !== undefined) {
    const d = ehTexto(patch.descricao) ? patch.descricao.trim() : "";
    if (d) base.descricao = d.slice(0, 1000);
    else delete base.descricao;
  }
  return base;
}

// -------------------------------------------- edicao rapida POR ACAO
//
// Card 86ak85nzy, a parte que a frente K declarou como NAO feita: "na listagem
// de acoes, ligar/desligar uma acao individual, mudar o atraso de execucao e o
// tempo de espera, marcar/desmarcar exige aprovacao". Ela ficou de fora porque o
// schema nao tinha o campo de desligar um passo — hoje tem (`no.desligado`).
//
// As quatro decisoes de desenho, e o que cada uma evita:
//
//  1. **Desligar NAO tira o passo da corrente.** O passo fica no lugar, com o
//     conteudo e o encadeamento intactos, e o motor pula (`noAtivo`, schema.ts).
//     Tirar do encadeamento perderia a posicao e, pra religar, exigiria remontar
//     a sequencia a mao.
//  2. **O ATRASO de uma acao e o no de ESPERA que vem antes dela.** Nao existe
//     campo `atraso_segundos` no no, e nunca existiu: o conversor do ChatGuru
//     transforma `execute_date_*` num no de espera INSERIDO ANTES da acao
//     (CLAUDE.md, secao do motor). Criar um campo paralelo daria dois lugares
//     dizendo a mesma coisa — e um deles ficaria errado.
//  3. **Inserir espera NAO renumera os ids** dos outros passos. O save do editor
//     completo reencadeia (n1..nN) e isso e aceitavel la, porque a tela recarrega;
//     aqui nao da: a fila guarda `no_id` das cadeias JA agendadas, e renumerar
//     faria a regua pendente apontar pro passo errado.
//  4. **Nada aqui grava, e nada aqui valida faixa de valor.** O patch e aplicado
//     sobre o jsonb e o resultado passa por `validarFluxo` na rota — o MESMO
//     portao do editor (criterio de aceite: "edicao rapida e editor completo
//     escrevem no mesmo modelo").
export type PatchPasso = {
  /** liga/desliga o passo (booleano; o schema recusa valor torto) */
  desligado?: unknown;
  /** exige aprovacao humana neste passo */
  aprovacao?: unknown;
  /** tempo de espera DESTE no (so em no de espera) */
  espera_segundos?: unknown;
  /** atraso ANTES desta acao = o no de espera que vem antes dela */
  atraso_segundos?: unknown;
};

export type ResultadoPatchPasso = { ok: true; fluxo: any; mudou: string[] } | { ok: false; erro: string };

function numeroInteiro(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// id livre pra um no NOVO, sem tocar nos ids que ja existem (ver decisao 3).
function idDeNoLivre(nos: any[], prefixo = "espera"): string {
  const usados = new Set(nos.map((n) => (ehTexto(n?.id) ? n.id : "")));
  for (let i = 1; i < 1000; i++) {
    const tent = `${prefixo}-${i}`;
    if (!usados.has(tent)) return tent;
  }
  return `${prefixo}-${Date.now().toString(36).slice(-5)}`;
}

export function aplicarPatchNoPasso(raw: unknown, noId: unknown, patch: PatchPasso): ResultadoPatchPasso {
  if (!slugValido(noId)) return { ok: false, erro: "id de passo invalido" };
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as any) } : null;
  if (!base) return { ok: false, erro: "fluxo ilegivel" };
  const nos = [...nosBrutos(base)];
  // pelo INDICE do primeiro no com este id: fluxo com id repetido (jsonb gravado
  // a mao, importacao de outra versao) nao pode fazer a edicao cair no no errado
  const idx = nos.findIndex((n) => n?.id === noId);
  if (idx < 0) return { ok: false, erro: "passo nao encontrado neste fluxo" };
  const mudou: string[] = [];

  const trocar = (i: number, campos: Record<string, unknown>) => {
    const copia = { ...nos[i] };
    for (const [k, v] of Object.entries(campos)) {
      if (v === undefined) delete copia[k];
      else copia[k] = v;
    }
    nos[i] = copia;
  };

  if (patch.desligado !== undefined) {
    if (typeof patch.desligado !== "boolean") return { ok: false, erro: "desligado precisa ser true ou false" };
    // `false` REMOVE a chave em vez de gravar false: o formato canonico usa
    // ausencia pra dizer "ligado" (mesma convencao da aprovacao), e gravar false
    // encheria o jsonb de campo que nao configura nada.
    trocar(idx, { desligado: patch.desligado ? true : undefined });
    mudou.push(patch.desligado ? "passo desligado" : "passo ligado");
  }

  if (patch.aprovacao !== undefined) {
    if (typeof patch.aprovacao !== "boolean") return { ok: false, erro: "aprovacao precisa ser true ou false" };
    trocar(idx, { aprovacao: patch.aprovacao ? true : undefined });
    mudou.push(patch.aprovacao ? "passa a exigir aprovacao" : "nao exige mais aprovacao");
  }

  if (patch.espera_segundos !== undefined) {
    const seg = numeroInteiro(patch.espera_segundos);
    if (seg === null) return { ok: false, erro: "tempo de espera precisa ser um numero de segundos >= 0" };
    if (nos[idx]?.acao?.tipo !== "espera") {
      return { ok: false, erro: "este passo nao e uma espera — pra atrasar uma acao use o atraso" };
    }
    trocar(idx, { acao: { ...nos[idx].acao, segundos: seg } });
    mudou.push(`espera de ${seg}s`);
  }

  if (patch.atraso_segundos !== undefined) {
    const seg = numeroInteiro(patch.atraso_segundos);
    if (seg === null) return { ok: false, erro: "atraso precisa ser um numero de segundos >= 0" };
    if (nos[idx]?.acao?.tipo === "espera") {
      return { ok: false, erro: "este passo JA e uma espera: mude o tempo dela, nao o atraso" };
    }
    const antes = nos.findIndex((n) => n?.proximo === noId);
    const ehEspera = antes >= 0 && nos[antes]?.acao?.tipo === "espera";
    const primeiro = idx === 0;

    if (ehEspera) {
      if (seg === 0) {
        // atraso zero TIRA a espera da corrente: quem estava antes dela passa a
        // apontar direto pro passo. Deixar uma espera de 0s no meio seria um
        // passo que nao faz nada e ainda aparece na lista.
        const doadorIdx = nos.findIndex((n) => n?.proximo === nos[antes].id);
        const idEspera = nos[antes].id;
        // A ESPERA ESTAVA NA POSICAO 0? Entao tirar a linha do array NAO basta: a
        // corrente comeca em `nos[0]` (ver `ordemDeExecucao`), e quem cair naquela
        // posicao passa a ser o primeiro passo do fluxo. Com o jsonb na ordem da
        // corrente da certo por acidente; com o array FORA de ordem — que o formato
        // permite, e fluxo importado tem — a cabeca virava um no ORFAO, e o fluxo
        // passava a comecar por um passo que ninguem escolheu. Apontado na revisao
        // cega de 31/08/2026. O conserto e explicito: o passo que a espera atrasava
        // assume a posicao 0.
        //
        // A CONDICAO E SO A POSICAO — `doadorIdx` NAO entra nela (re-revisao de
        // 31/08/2026). A versao anterior exigia tambem "ninguem aponta pra espera"
        // (`doadorIdx < 0`), o que parece razoavel — se alguem aponta, a espera nao
        // era cabeca de nada — mas o que decide a cabeca da corrente e a POSICAO no
        // array, nao quem aponta. Com um no ORFAO apontando pra espera que esta em
        // `nos[0]` (`nos = [esp, z, b, c]`, `z.proximo = esp`, `z` fora da corrente),
        // o doador existia, a reposicao nao rodava, e depois do `splice` o array
        // comecava por `z`: a corrente `esp -> b -> c` virava `z -> b -> c` e uma
        // mensagem que ninguem escolheu passava a ser o primeiro passo. O rewire do
        // doador continua acontecendo (ele passa a apontar pro passo, como antes);
        // o que mudou e que a reposicao acontece nos DOIS casos.
        const eraCabeca = antes === 0;
        if (doadorIdx >= 0) trocar(doadorIdx, { proximo: noId });
        nos.splice(antes, 1);
        if (eraCabeca) {
          const novoIdx = nos.findIndex((n) => n?.id === noId);
          if (novoIdx > 0) {
            const [cabeca] = nos.splice(novoIdx, 1);
            nos.unshift(cabeca);
          }
        }
        mudou.push(`sem atraso (a espera ${idEspera} saiu da corrente)`);
      } else {
        trocar(antes, { acao: { ...nos[antes].acao, segundos: seg } });
        mudou.push(`atraso de ${seg}s`);
      }
    } else if (seg > 0) {
      const novo = {
        id: idDeNoLivre(nos),
        tipo: "espera",
        acao: { tipo: "espera", segundos: seg },
        proximo: noId,
      };
      if (antes >= 0) trocar(antes, { proximo: novo.id });
      else if (!primeiro) {
        // sem ninguem apontando pro passo e ele nao e o primeiro: o passo esta
        // FORA da corrente. Atrasar um passo que nao roda seria configuracao
        // invisivel — recusa com o motivo, em vez de gravar algo sem efeito.
        return { ok: false, erro: "este passo esta fora da corrente do fluxo: religue o encadeamento antes de por atraso" };
      }
      // a corrente comeca em `nos[0]` (ver ordemDeExecucao), entao a espera que
      // vem ANTES do primeiro passo tem que ocupar a posicao 0 do array
      nos.splice(idx, 0, novo);
      mudou.push(`atraso de ${seg}s`);
    }
    // seg === 0 sem espera antes: nada a fazer (ja nao havia atraso)
  }

  if (!mudou.length) return { ok: false, erro: "nada pra editar neste passo" };
  base.nos = nos;
  return { ok: true, fluxo: base, mudou };
}

// ---------------------------------------------------- resumo pra tela
export type PassoResumo = {
  id: string;
  ordem: number;
  tipo: string;
  acao: string | null;
  // rotulo curto, ja saneado, pra linha da lista. TEXTO, nunca HTML.
  resumo: string;
  // este passo esta na corrente que executa? no solto existe no formato e NAO
  // roda — quem edita precisa ver isso (schema.ts: ordemDeExecucao)
  na_corrente: boolean;
  alvo: string | null;
  // ---- edicao rapida POR ACAO e VISUALIZACAO rapida (card 86ak85nzy)
  /** o passo esta desligado (fica no lugar e nao roda) */
  desligado: boolean;
  /** este passo exige aprovacao humana */
  aprovacao: boolean;
  /** tempo desta espera, em segundos (null quando o passo nao e espera) */
  espera_segundos: number | null;
  /** atraso ANTES desta acao = a espera que vem antes dela na corrente */
  atraso_segundos: number;
  /**
   * O conteudo INTEIRO do passo, pra "espiar sem entrar no editor" (o
   * `/action/quick_view/` do benchmark). `resumo` e a linha da lista, cortada em
   * 120; este e o texto todo. TEXTO, nunca HTML — quem renderiza e o React.
   */
  conteudo: string | null;
};

function corta(v: unknown, n: number): string {
  const s = ehTexto(v) ? v.replace(/\s+/g, " ").trim() : "";
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

// Uma linha por no, na ordem da corrente e depois os soltos. Le o BRUTO: fluxo
// invalido tambem precisa ser inspecionavel na tela (e o que permite consertar).
export function passosDoFluxo(raw: any): PassoResumo[] {
  const nos = nosBrutos(raw);
  // indice do PRIMEIRO no de cada id. A caminhada e por INDICE, nunca por id:
  // fluxo com id repetido (jsonb gravado a mao, importacao de outra versao) faria
  // o no duplicado sumir da tela justamente no fluxo que precisa ser consertado.
  const porId = new Map<string, number>();
  nos.forEach((n, i) => {
    if (slugValido(n?.id) && !porId.has(n.id)) porId.set(n.id, i);
  });

  const corrente: number[] = [];
  const vistos = new Set<number>();
  let idx: number | undefined = nos.length ? 0 : undefined;
  while (idx !== undefined && idx < nos.length && !vistos.has(idx)) {
    vistos.add(idx);
    corrente.push(idx);
    const no = nos[idx];
    idx = slugValido(no?.proximo) ? porId.get(no.proximo) : undefined;
  }

  const ordenados = [...corrente, ...nos.map((_, i) => i).filter((i) => !vistos.has(i))];

  // atraso de cada passo = a espera IMEDIATAMENTE anterior na corrente. E a
  // mesma leitura que `aplicarPatchNoPasso` escreve, e por isso a lista e a
  // edicao rapida nunca discordam de quanto tempo aquela acao espera.
  const atrasoPorIndice = new Map<number, number>();
  for (let k = 1; k < corrente.length; k++) {
    const anterior = nos[corrente[k - 1]];
    if (anterior?.acao?.tipo !== "espera") continue;
    const seg = Number(anterior.acao.segundos);
    atrasoPorIndice.set(corrente[k], Number.isFinite(seg) ? Math.round(seg) : 0);
  }

  return ordenados.map((indice, i) => {
    const no = nos[indice];
    const a = no?.acao;
    const tipoAcao = ehTexto(a?.tipo) ? a.tipo : null;
    let resumo = "";
    switch (tipoAcao) {
      case "enviar_texto":
        resumo = corta(a.texto, 120);
        break;
      case "nota_interna":
        resumo = corta(a.texto, 120);
        break;
      case "etiquetar":
        resumo = `${corta(a.modo ?? "adicionar", 20)}: ${(Array.isArray(a.etiquetas) ? a.etiquetas : [])
          .filter(ehTexto)
          .map((e: string) => corta(e, 30))
          .join(", ")}`;
        break;
      case "mudar_status":
        resumo = corta(a.status, 30);
        break;
      case "atribuir_responsavel":
        resumo = (Array.isArray(a.responsaveis) ? a.responsaveis : [])
          .map((r: any) => corta(r?.nome ?? r?.id, 40))
          .filter(Boolean)
          .join(", ");
        break;
      case "mover_funil":
        resumo = `${corta(a.funil, 60)} -> ${a.etapa === null ? "(sair do funil)" : corta(a.etapa, 60)}`;
        break;
      case "espera":
        resumo = `${Number.isFinite(Number(a.segundos)) ? Math.round(Number(a.segundos)) : "?"}s`;
        break;
      // acoes de contexto (frente L): resumo legivel em vez de linha vazia
      case "definir_contexto":
        resumo = `${corta(a.chave, 40)} = ${corta(a.valor, 60)}`;
        break;
      case "limpar_contexto":
        resumo = corta(a.chave, 40);
        break;
      // FRENTE W (card 86ak85bmw): sem este verbete o passo de anexo apareceria
      // no editor como linha vazia, e quem edita nao veria QUAL arquivo o fluxo
      // manda — que e a unica coisa que importa nesse passo.
      case "anexar_biblioteca":
        resumo = ehTexto(a.legenda)
          ? `${corta(a.anexo, 60)} — ${corta(a.legenda, 60)}`
          : corta(a.anexo, 60);
        break;
      default:
        resumo = corta(no?.rotulo, 120);
    }
    const alvo = alvoDaChamada(a);
    if (alvo) resumo = resumo || alvo;
    const segEspera = tipoAcao === "espera" ? Number(a?.segundos) : NaN;
    // conteudo completo SO onde ha texto pra espiar; nos outros tipos o `resumo`
    // ja diz tudo (nao ha "conteudo escondido" numa etiqueta)
    const conteudo =
      (tipoAcao === "enviar_texto" || tipoAcao === "nota_interna") && ehTexto(a?.texto)
        ? a.texto.slice(0, 4096)
        : null;
    return {
      id: ehTexto(no?.id) ? corta(no.id, 64) : `(sem id ${i + 1})`,
      ordem: i + 1,
      tipo: ehTexto(no?.tipo) ? corta(no.tipo, 20) : "?",
      acao: tipoAcao,
      resumo,
      na_corrente: vistos.has(indice),
      alvo,
      desligado: no?.desligado === true,
      aprovacao: no?.aprovacao === true,
      espera_segundos: Number.isFinite(segEspera) ? Math.round(segEspera) : null,
      atraso_segundos: atrasoPorIndice.get(indice) ?? 0,
      conteudo,
    };
  });
}

// --------------------------------------------------- montagem de passos
// O caso MAJORITARIO medido no card 86ak85a40: 127 dos 935 dialogos da conta de
// origem tem UM unico
// passo de resposta. Criar isso tem que levar segundos — por isso a tela monta
// a corrente com estas duas funcoes puras e nunca pede id de no pro usuario.

// Reencadeia uma lista de nos numa corrente linear (n1 -> n2 -> ...). E o que
// mantem `proximo` correto depois de adicionar, remover ou reordenar passo.
export function reencadear(nos: any[]): any[] {
  const lista = Array.isArray(nos) ? nos.filter((n) => n && typeof n === "object") : [];
  return lista.map((no, i) => {
    const novo: any = { ...no, id: `n${i + 1}` };
    if (i < lista.length - 1) novo.proximo = `n${i + 2}`;
    else delete novo.proximo;
    return novo;
  });
}

export function moverPasso(nos: any[], de: number, para: number): any[] {
  const lista = Array.isArray(nos) ? [...nos] : [];
  if (de < 0 || de >= lista.length || para < 0 || para >= lista.length || de === para) {
    return reencadear(lista);
  }
  const [item] = lista.splice(de, 1);
  lista.splice(para, 0, item);
  return reencadear(lista);
}

export function removerPasso(nos: any[], indice: number): any[] {
  const lista = Array.isArray(nos) ? [...nos] : [];
  if (indice < 0 || indice >= lista.length) return reencadear(lista);
  lista.splice(indice, 1);
  return reencadear(lista);
}

// Acao NOVA com valores default validos pro tipo — o editor nunca cria um no
// que `validarFluxo` recusaria por campo faltando.
export function acaoPadrao(tipo: string): any | null {
  switch (tipo) {
    case "enviar_texto":
      return { tipo: "enviar_texto", texto: "" };
    case "nota_interna":
      return { tipo: "nota_interna", texto: "" };
    case "etiquetar":
      return { tipo: "etiquetar", etiquetas: [], modo: "adicionar" };
    case "mudar_status":
      return { tipo: "mudar_status", status: "atendimento" };
    case "atribuir_responsavel":
      return { tipo: "atribuir_responsavel", responsaveis: [] };
    case "mover_funil":
      return { tipo: "mover_funil", funil: "", etapa: "" };
    case "espera":
      return { tipo: "espera", segundos: 5 };
    default:
      return null;
  }
}

export function noPadrao(tipo: string): any | null {
  const acao = acaoPadrao(tipo);
  if (!acao) return null;
  return { id: "n1", tipo: tipo === "espera" ? "espera" : "acao", acao };
}
