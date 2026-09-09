// INTENCOES (NLU local) — card 86ak85nzr.
//
// Reconhecer o que a pessoa QUIS dizer por palavras-chave e frases de exemplo,
// com uma pontuacao minima por intencao. Serve de condicao/gatilho de fluxo.
//
// REGRA DURA DA CASA: **nada aqui consome API paga.** O reconhecimento e local,
// deterministico e provavel sem banco, sem rede e sem chave. O gancho pra um
// classificador de IA existe DECLARADO (ver `ClassificadorExterno` no fim do
// arquivo) e nao e chamado por ninguem — quem ligar um dia passa a lista ja
// pontuada e o portao de pontuacao minima continua sendo o mesmo.
//
// Regra deste arquivo: ZERO import, igual `schema.ts`. Roda no Next e em node
// solto (`node scripts/prova-intencoes.ts`).
//
// ---------------------------------------------------------------------------
// A ESCALA DE PONTOS NAO FOI INVENTADA: ela esta ESCRITA na tela da ferramenta
// de origem, e foi lida do HTML capturado nos backups:
//
//   "As intencoes possuem pontuacao minima para serem ativadas.
//    Palavra-chave: 10 pontos. Similaridade com Frase de exemplo: 2 pontos.
//    Frase de exemplo exata: 100 pontos."
//
// E o campo tem `placeholder="Padrao: 2"`. Reproduzir a escala e o que faz a
// intencao IMPORTADA continuar valendo o que valia: medido nos 33 backups, 52
// intencoes / 249 palavras-chave / 431 frases, e a pontuacao minima NAO e sempre
// o default — 23 usam 2, e o resto vai de 8 a 100. Com outra escala, uma intencao
// de minimo 100 (so frase exata) passaria a disparar com uma palavra solta.
// ---------------------------------------------------------------------------

/** palavra-chave encontrada na mensagem */
export const PONTOS_PALAVRA_CHAVE = 10;
/** frase de exemplo IGUAL a mensagem */
export const PONTOS_FRASE_EXATA = 100;
/** frase de exemplo parecida com a mensagem */
export const PONTOS_SIMILARIDADE = 2;
/** o `placeholder="Padrao: 2"` da tela de origem */
export const PONTUACAO_MINIMA_PADRAO = 2;

/**
 * Quanto de uma frase de exemplo precisa aparecer na mensagem pra contar como
 * "parecida".
 *
 * ESTE NUMERO E NOSSO, e a honestidade sobre isso importa: a ferramenta de
 * origem diz que similaridade vale 2 pontos e **nao documenta como mede**. Aqui a
 * medida e explicita e deterministica — a fracao das palavras da FRASE que
 * aparecem na mensagem (palavra de 1 letra nao conta). Meio a meio e o corte:
 * abaixo disso "quero atendimento" casaria com qualquer frase que tenha "quero".
 */
export const LIMIAR_SIMILARIDADE = 0.5;

export const LIMITE_NOME_INTENCAO = 80;
export const LIMITE_TERMO = 120;
export const LIMITE_TERMOS_POR_INTENCAO = 300;
export const LIMITE_PONTUACAO_MINIMA = 1000;
/**
 * Teto do texto que entra na comparacao.
 *
 * Mensagem de WhatsApp e conteudo de TERCEIRO e o casamento roda por intencao x
 * termo: sem teto, um texto de 100 mil caracteres multiplicado pelo catalogo
 * vira trabalho de CPU pago pelo servidor a cada mensagem recebida. 4096 e o
 * mesmo teto de `LIMITE_TEXTO` do schema.
 */
export const LIMITE_TEXTO_ANALISADO = 4096;

// Marcas combinantes por ESCAPE, nunca cruas no fonte (combinante solto morre em
// copia/patch e a classe deixa de casar EM SILENCIO).
const RE_COMBINANTES = new RegExp("[\u0300-\u036f]", "g");

/**
 * Normalizacao unica: sem caixa, sem acento, sem pontuacao, sem espaco duplo.
 *
 * A MESMA funcao vale pra mensagem, pra palavra-chave e pra frase — se cada lado
 * normalizasse diferente, "Não" da frase nunca casaria com "nao" da mensagem, e
 * quem configurou nao teria como enxergar o motivo.
 */
export function normalizarTexto(bruto: unknown): string {
  return String(bruto ?? "")
    .slice(0, LIMITE_TEXTO_ANALISADO)
    .normalize("NFD")
    .replace(RE_COMBINANTES, "")
    .toLowerCase()
    // Pontuacao vira ESPACO (nao vira vazio): "atendente,humano" sao duas
    // palavras, e colar as duas faria o token nao casar com nenhuma.
    // A classe usa propriedade UNICODE (\p{L}\p{N}) em vez de [a-z0-9]: este
    // produto e instalado por qualquer cliente, e um catalogo escrito em alfabeto
    // nao-latino seria zerado por uma classe ASCII — a intencao nunca casaria e
    // ninguem descobriria por que. O acento ja saiu no passo anterior (NFD +
    // corte das marcas combinantes), entao aqui nao entra letra acentuada crua.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(texto: unknown): string[] {
  const n = normalizarTexto(texto);
  return n ? n.split(" ") : [];
}

// ---------------------------------------------------------------- catalogo
export type Intencao = {
  /** identificador (uuid no banco; qualquer texto na prova) */
  id: string;
  nome: string;
  palavras_chave: string[];
  frases: string[];
  /** quanto a mensagem precisa somar pra intencao ser considerada reconhecida */
  pontuacao_minima: number;
  ativo: boolean;
};

export type ResultadoValidacaoIntencao =
  | { ok: true; intencao: Intencao }
  | { ok: false; erros: string[] };

function limpaTermos(bruto: unknown): string[] {
  if (!Array.isArray(bruto)) return [];
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const t of bruto) {
    if (typeof t !== "string") continue;
    const limpo = t.replace(/\s+/g, " ").trim().slice(0, LIMITE_TERMO);
    if (!limpo) continue;
    // dedupe pela forma NORMALIZADA: "Atendente" e "atendente " sao o mesmo
    // termo, e guardar os dois faria a mesma palavra pontuar duas vezes
    const chave = normalizarTexto(limpo);
    if (!chave || vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(limpo);
    if (saida.length >= LIMITE_TERMOS_POR_INTENCAO) break;
  }
  return saida;
}

/**
 * Valida e normaliza uma intencao vinda de qualquer lugar (tela, banco,
 * importacao). Nunca lanca; devolve a lista de erros legivel.
 *
 * **Intencao sem palavra E sem frase e RECUSADA**: ela nao reconheceria nada e
 * ficaria no catalogo parecendo configurada. (Medido: 2 das 52 intencoes da
 * origem nao tem palavra-chave, mas TODAS tem frase — nenhuma e vazia dos dois
 * lados.)
 */
export function validarIntencao(bruto: unknown): ResultadoValidacaoIntencao {
  const erros: string[] = [];
  const b = bruto as any;
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, erros: ["intencao precisa ser um objeto"] };

  const nome = typeof b.nome === "string" ? b.nome.replace(/\s+/g, " ").trim() : "";
  if (!nome) erros.push("nome obrigatorio");
  if (nome.length > LIMITE_NOME_INTENCAO) erros.push(`nome acima de ${LIMITE_NOME_INTENCAO} caracteres`);

  const palavras_chave = limpaTermos(b.palavras_chave);
  const frases = limpaTermos(b.frases);
  if (!palavras_chave.length && !frases.length) {
    erros.push("uma intencao precisa de pelo menos uma palavra-chave ou uma frase de exemplo");
  }

  // pontuacao minima AUSENTE vira o default da origem; pontuacao PRESENTE e
  // ilegivel e ERRO, nunca default em silencio — cair no default de 2 numa
  // intencao configurada com 100 a faria disparar com uma palavra solta.
  let pontuacao_minima = PONTUACAO_MINIMA_PADRAO;
  if (b.pontuacao_minima !== undefined && b.pontuacao_minima !== null && b.pontuacao_minima !== "") {
    const n = Number(b.pontuacao_minima);
    if (!Number.isFinite(n) || n < 1 || n > LIMITE_PONTUACAO_MINIMA) {
      erros.push(`pontuacao_minima precisa ser um numero de 1 a ${LIMITE_PONTUACAO_MINIMA}`);
    } else {
      pontuacao_minima = Math.round(n);
    }
  }

  if (erros.length) return { ok: false, erros };
  return {
    ok: true,
    intencao: {
      id: typeof b.id === "string" && b.id.trim() ? b.id.trim().slice(0, 64) : nome,
      nome,
      palavras_chave,
      frases,
      pontuacao_minima,
      // ausente = ATIVA (o catalogo importado nao tem esse campo)
      ativo: b.ativo === undefined ? true : b.ativo === true,
    },
  };
}

// ------------------------------------------------------------ pontuacao
export type MotivoPonto = {
  /** `palavra_chave` | `frase_exata` | `similaridade` */
  tipo: "palavra_chave" | "frase_exata" | "similaridade";
  /** o termo que pontuou */
  termo: string;
  pontos: number;
};

export type IntencaoPontuada = {
  id: string;
  nome: string;
  pontos: number;
  pontuacao_minima: number;
  reconhecida: boolean;
  /** o que pontuou, pra tela poder EXPLICAR (e nao so mostrar um numero) */
  motivos: MotivoPonto[];
};

/** A frase de exemplo aparece na mensagem? (fracao das palavras da FRASE) */
export function similaridade(frase: string, tokensMensagem: Set<string>): number {
  // palavra de 1 letra fora: "e", "a", "o" apareceriam em quase toda mensagem e
  // inflariam a similaridade de qualquer frase
  const alvo = tokens(frase).filter((t) => t.length > 1);
  if (!alvo.length) return 0;
  let achou = 0;
  for (const t of alvo) if (tokensMensagem.has(t)) achou++;
  return achou / alvo.length;
}

/**
 * Pontua UMA intencao contra uma mensagem. Pura e deterministica: mesma entrada,
 * mesmo numero — e por isso da pra provar sem banco e explicar pra quem configura.
 *
 * A soma NAO e limitada de proposito: duas palavras-chave valem 20, e e assim que
 * a origem descreve. `reconhecida` compara com a pontuacao minima DA INTENCAO.
 */
export function pontuarIntencao(intencao: Intencao, texto: unknown): IntencaoPontuada {
  const normalizada = normalizarTexto(texto);
  const toks = normalizada ? normalizada.split(" ") : [];
  const conjunto = new Set(toks);
  const motivos: MotivoPonto[] = [];
  let pontos = 0;

  if (normalizada) {
    for (const p of intencao.palavras_chave) {
      const alvo = normalizarTexto(p);
      if (!alvo) continue;
      // palavra-chave casa por PALAVRA, nunca por trecho: por trecho, "nao"
      // casaria dentro de "naotenho" e a intencao dispararia por acidente.
      // Chave de varias palavras casa pela sequencia (com fronteira de palavra).
      const casou = alvo.includes(" ")
        ? ` ${normalizada} `.includes(` ${alvo} `)
        : conjunto.has(alvo);
      if (!casou) continue;
      pontos += PONTOS_PALAVRA_CHAVE;
      motivos.push({ tipo: "palavra_chave", termo: p, pontos: PONTOS_PALAVRA_CHAVE });
    }

    for (const f of intencao.frases) {
      const alvo = normalizarTexto(f);
      if (!alvo) continue;
      if (alvo === normalizada) {
        pontos += PONTOS_FRASE_EXATA;
        motivos.push({ tipo: "frase_exata", termo: f, pontos: PONTOS_FRASE_EXATA });
        continue;
      }
      if (similaridade(f, conjunto) >= LIMIAR_SIMILARIDADE) {
        pontos += PONTOS_SIMILARIDADE;
        motivos.push({ tipo: "similaridade", termo: f, pontos: PONTOS_SIMILARIDADE });
      }
    }
  }

  return {
    id: intencao.id,
    nome: intencao.nome,
    pontos,
    pontuacao_minima: intencao.pontuacao_minima,
    reconhecida: pontos >= intencao.pontuacao_minima && pontos > 0,
    motivos,
  };
}

/**
 * Pontua o catalogo inteiro e devolve em ordem DETERMINISTICA: mais pontos
 * primeiro, empate resolvido pelo nome.
 *
 * Ordem estavel importa porque a condicao de fluxo vai perguntar "qual intencao
 * foi reconhecida"; ordem que muda entre chamadas faria o mesmo texto disparar
 * fluxos diferentes.
 *
 * Intencao DESLIGADA nao entra — nem pontuada. Conta sem nenhuma intencao devolve
 * lista vazia e ninguem quebra: **NLU nunca e obrigatoria** (criterio de aceite).
 */
export function reconhecerIntencoes(texto: unknown, catalogo: Iterable<Intencao>): IntencaoPontuada[] {
  const saida: IntencaoPontuada[] = [];
  for (const i of catalogo) {
    if (!i || i.ativo === false) continue;
    saida.push(pontuarIntencao(i, texto));
  }
  return saida.sort((a, b) => b.pontos - a.pontos || a.nome.localeCompare(b.nome));
}

/** Os NOMES das intencoes reconhecidas — e isso que vira fato de condicao. */
export function intencoesReconhecidas(texto: unknown, catalogo: Iterable<Intencao>): string[] {
  return reconhecerIntencoes(texto, catalogo)
    .filter((i) => i.reconhecida)
    .map((i) => i.nome);
}

// ------------------------------------------------------- gancho pra IA
/**
 * GANCHO DECLARADO, NAO LIGADO.
 *
 * O dia em que a instalacao quiser classificar com IA, o classificador entra por
 * aqui: ele recebe o texto e o catalogo e devolve pontos por intencao. **Nada
 * neste repo chama isto**, e a razao e regra da casa: nenhuma linha do produto
 * consome API paga por conta propria — quem contrata o servico e a INSTALACAO, e
 * a chave e dela (o mesmo desenho do gancho de transcricao, `lib/transcricao.ts`).
 *
 * O portao continua sendo a pontuacao minima da intencao: o classificador soma
 * pontos, ele NAO decide sozinho o que foi reconhecido. Assim, ligar IA nao muda
 * o significado do que quem configurou escreveu.
 */
export type ClassificadorExterno = (
  texto: string,
  catalogo: Intencao[]
) => Promise<{ id: string; pontos: number; motivo?: string }[]>;

/**
 * Soma os pontos de um classificador externo aos pontos locais, aplicando o
 * MESMO portao de pontuacao minima. Pura: quem chama o servico e quem tem rede.
 *
 * Ponto externo de intencao que nao esta no catalogo e IGNORADO — servico que
 * inventa rotulo nao cria intencao aqui.
 */
export function combinarComExterno(
  locais: IntencaoPontuada[],
  externos: { id: string; pontos: number; motivo?: string }[]
): IntencaoPontuada[] {
  const porId = new Map(locais.map((l) => [l.id, l]));
  for (const e of externos) {
    const alvo = porId.get(e.id);
    if (!alvo) continue;
    const pontos = Number(e.pontos);
    if (!Number.isFinite(pontos) || pontos <= 0) continue;
    alvo.pontos += Math.round(pontos);
    alvo.motivos.push({ tipo: "similaridade", termo: e.motivo || "classificador externo", pontos: Math.round(pontos) });
    alvo.reconhecida = alvo.pontos >= alvo.pontuacao_minima;
  }
  return [...porId.values()].sort((a, b) => b.pontos - a.pontos || a.nome.localeCompare(b.nome));
}
