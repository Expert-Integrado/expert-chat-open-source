// Descadastro (opt-out) — a parte PURA: como se reconhece um pedido de saida.
//
// Nao importa nada (roda em node solto; a prova exercita sem banco).
//
// POR QUE ESTE ARQUIVO E TAO CONSERVADOR (achado ALTO da revisao de 31/08/2026):
// um falso positivo aqui bloqueia a pessoa **global, permanente e
// silenciosamente** — ela nunca mais recebe disparo nenhum e ninguem fica
// sabendo. Numa caixa de atendimento comercial, "cancela minha consulta de
// sexta", "pare de brincadeira, adorei!" e "sair as 18h ta bom?" sao mensagens
// NORMAIS, e a versao anterior deste arquivo bloqueava as tres: bastava a
// mensagem ser curta e COMECAR com o verbo. Ao mesmo tempo, a frase mais comum
// de descadastro de verdade — "nao quero mais receber essas mensagens" —
// escapava, porque nao casava exatamente com nenhum gatilho.
//
// A REGRA, em tres camadas, da mais segura pra menos:
//   1. gatilho de UMA palavra: exige IGUALDADE exata da mensagem inteira;
//   2. frase inequivoca: pode aparecer dentro da mensagem, porque ela propria
//      ja nomeia o canal ("nao quero mais receber", "me tira da lista");
//   3. verbo + OBJETO DE CANAL na mesma mensagem curta ("pare de mandar
//      mensagem"). Verbo sozinho nunca basta — e o que separa "pare de mandar
//      mensagem" de "pare de brincadeira".
//
// E mesmo assim o bloqueio automatico nao e a palavra final: os bloqueios de
// origem `resposta` aparecem na tela pra revisao humana, com a frase que os
// disparou, e podem ser removidos com um clique.

/** Gatilhos de uma palavra — valem SO por igualdade exata da mensagem. */
export const GATILHOS_EXATOS = [
  "pare",
  "parar",
  "sair",
  "stop",
  "cancelar",
  "cancela",
  "descadastrar",
  "descadastro",
  "remover",
  "unsubscribe",
] as const;

/**
 * Frases que ja nomeiam o canal ou a intencao — podem aparecer DENTRO da
 * mensagem, porque nao ha leitura comercial inocente pra elas.
 */
export const FRASES_INEQUIVOCAS = [
  "nao quero mais receber",
  "nao quero receber",
  "nao quero mais mensagens",
  "nao envie mais",
  "nao mande mais",
  "me descadastra",
  "me descadastre",
  "me tira da lista",
  "me tire da lista",
  "me remove da lista",
  "me remova da lista",
  "sair da lista",
  "cancelar inscricao",
  "cancelar a inscricao",
] as const;

/** Frases curtas que valem so por igualdade (ambiguas dentro de frase maior). */
export const FRASES_EXATAS = ["sem interesse", "nao tenho interesse"] as const;

/** Verbos de parada. Sozinhos NAO bastam. */
const VERBOS = [
  "pare",
  "parar",
  "para",
  "cancelar",
  "cancela",
  "cancele",
  "remover",
  "remove",
  "remova",
  "sair",
  "tirar",
  "tira",
  "tire",
] as const;

/**
 * O objeto que transforma o verbo num pedido de descadastro: tem que ser o
 * CANAL, nao qualquer coisa da vida da pessoa (consulta, reuniao, pedido).
 */
const OBJETOS_DE_CANAL = [
  "mensagem",
  "mensagens",
  "lista",
  "receber",
  "enviar",
  "mandar",
  "inscricao",
] as const;

const MAX_PALAVRAS_RAMO_CURTO = 8;

const semAcento = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

const normalizar = (texto: string) =>
  semAcento(texto)
    .replace(/[.!,;:?¡¿"'()\[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * A mensagem do destino e um pedido de descadastro?
 * Devolve a expressao reconhecida (pra gravar o motivo) ou null.
 */
export function pedidoDeDescadastro(texto: unknown): string | null {
  if (typeof texto !== "string") return null;
  const limpo = normalizar(texto);
  if (!limpo) return null;

  // NEGACAO explicita derruba tudo: "nao pare de me mandar novidades" e o
  // oposto de um descadastro, e um `includes` cru erraria isso.
  if (/\b(nao|nunca|jamais)\s+(pare|parar|para|cancele|cancelar|cancela|remova|remover|tire|tirar)\b/.test(limpo)) {
    return null;
  }

  // 1) gatilho de uma palavra: SO igualdade exata
  for (const p of GATILHOS_EXATOS) {
    if (limpo === p) return p;
  }

  // 2) frase exata
  for (const f of FRASES_EXATAS) {
    if (limpo === f) return f;
  }

  // 3) frase inequivoca em qualquer posicao
  for (const f of FRASES_INEQUIVOCAS) {
    if (limpo.includes(f)) return f;
  }

  // 4) verbo + objeto DE CANAL, em mensagem curta
  const palavras = limpo.split(" ");
  if (palavras.length <= MAX_PALAVRAS_RAMO_CURTO) {
    const verbo = VERBOS.find((v) => palavras.includes(v));
    const objeto = OBJETOS_DE_CANAL.find((o) => palavras.includes(o));
    if (verbo && objeto) return `${verbo} + ${objeto}`;
  }

  return null;
}

/** Lista legivel pra tela mostrar o que descadastra sozinho. */
export const PALAVRAS_DESCADASTRO = [
  ...GATILHOS_EXATOS,
  ...FRASES_EXATAS,
  ...FRASES_INEQUIVOCAS,
] as const;
