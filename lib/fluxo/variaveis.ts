// VARIAVEIS DE TEXTO — a sintaxe unica do painel (Frente T, card 86ak86jw9).
//
// Uma sintaxe so, aprendida uma vez, valendo em resposta rapida e no texto de
// fluxo: `!prop` pra propriedade da conversa/contato/atendente e `$var` pra
// variavel de contexto da conversa (a mesma memoria que a condicao de fluxo le,
// `mensageria.conversa_contexto`). O criterio de aceite do card e explicito
// nisso: "a sintaxe e a mesma do motor de automacao e esta documentada num so
// lugar" — o lugar e `docs/variaveis.md`, e a implementacao e este arquivo.
//
// Regra deste arquivo: ZERO import, igual `schema.ts` e `editor.ts`. Ele roda no
// Next e em node solto (`node scripts/prova-variaveis.ts`). Consequencia de
// desenho, nao acidente: ele NAO le banco, NAO sabe hora e NAO conhece fuso —
// quem tem essas coisas monta o mapa de valores e passa pra ca. E o que permite
// provar a substituicao inteira sem banco, sem env e sem relogio.
//
// TEXTO, NUNCA HTML: a saida vai pra um <textarea>/<input> e pro corpo da
// mensagem. Nada aqui escapa nem interpreta marcacao — quem renderiza e o React,
// que escapa sozinho.

// ---------------------------------------------------------------- catalogo
//
// As PROPRIEDADES da v1. Cada uma tem verbete porque o verbete e o que a tela
// mostra pro atendente (e o que a doc reaproveita) — catalogo sem verbete vira
// lista de palavra mágica que ninguem sabe usar.
export const PROPS_VARIAVEL: Readonly<Record<string, string>> = {
  nome: "Nome do contato, como esta na conversa",
  primeiro_nome: "Primeira palavra do nome do contato",
  telefone: "Telefone (ou identificador) da conversa",
  atendente: "Nome de quem esta usando a resposta agora",
  // MEDIDO, nao inventado: `{DAY_GREETING}` e a 2a variavel mais usada nas
  // respostas rapidas dos backups (12 ocorrencias em 177 respostas, 32 contas).
  // Sem ela, a resposta importada perderia a saudacao e o atendente teria que
  // reescrever a frase. O VALOR vem de fora (depende do fuso da INSTALACAO).
  saudacao: "Bom dia / Boa tarde / Boa noite, pela hora da instalacao",
};

// Marcas combinantes (acento) por ESCAPE, nunca cruas no fonte: combinante
// solto desaparece em copia/patch/heredoc e a classe passa a nao casar com nada
// EM SILENCIO — gotcha ja pago em scripts/importar/config-restante.mjs.
const RE_COMBINANTES = new RegExp("[\u0300-\u036f]", "g");

/** Prefixo das propriedades que vem da FICHA: `!campo.<chave>`. */
export const PREFIXO_CAMPO = "campo.";

/**
 * Campo personalizado alcancado por chave NORMALIZADA.
 *
 * A ficha guarda o nome como a pessoa escreveu ("Nome da empresa", "CNPJ"), e
 * nome com espaco e acento nao cabe num token de variavel. Entao a variavel usa
 * a forma normalizada (`!campo.nome_da_empresa`) e o casamento e feito contra a
 * mesma normalizacao das chaves da ficha. Sem isso, metade dos campos da conta
 * seria inalcancavel.
 */
export function chaveNormalizadaDeCampo(bruto: unknown): string {
  return String(bruto ?? "")
    .normalize("NFD")
    .replace(RE_COMBINANTES, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Token de propriedade: `!nome`, `!primeiro_nome`, `!campo.cnpj`.
//
// O `!` solto do texto normal NAO e tocado: o token so vale quando o que vem
// depois dele casa com uma propriedade CONHECIDA (ou com a forma
// `campo.<chave>`). E por isso que "Fechado!" e "corre!!!" atravessam intactos —
// nao ha escape a aprender, o que importa e o catalogo.
const RE_PROP = /!([A-Za-z0-9_]+(?:\.[A-Za-z0-9_-]+)?)/g;

// Token de contexto: `$chave` e `${chave com espaco}`.
//
// A forma com chaves existe porque chave de contexto aceita espaco, hifen e
// acento (medido no dialeto de origem: `$Reserva confirmada`, `$QC-IM`), e sem
// delimitador nao ha como saber onde a chave termina.
//
// A CHAVE NUA NAO PODE COMECAR COM DIGITO, e isto foi defeito pego pela propria
// prova: com `[A-Za-z0-9_-]`, o preco "$50" virava a variavel `$50` e a mensagem
// saia como "o outro ." — texto que estava certo, quebrado em silencio por causa
// de dinheiro escrito com o sinal junto. Comecar por letra/underscore cobre o
// dialeto inteiro que existe de verdade, e quem tiver mesmo uma chave que comeca
// com numero escreve `${50}` — delimitado, ou seja, dito de proposito.
const RE_CTX = /\$(?:\{([^}\n]{1,120})\}|([A-Za-z_][A-Za-z0-9_-]{0,119}))/g;

// Variavel do sistema ANTIGO, no formato `{CHAVE}`. So e olhada quando quem
// chama pede (`legado: true`) — ver `substituirVariaveis`.
const RE_LEGADO = /\{([A-Za-z_][A-Za-z0-9_ ]{0,40})\}/g;

/**
 * UMA VARREDURA SO, e isto foi defeito pego pela propria prova.
 *
 * A primeira versao fazia tres `replace` em sequencia (prop, contexto, legado), e
 * o valor inserido pelo primeiro era LIDO pelo segundo: um contato chamado
 * `!telefone $URA` — nome vem do WhatsApp ou da ficha importada, ou seja, e
 * conteudo de TERCEIRO — fazia a resposta cuspir o valor de uma variavel de
 * contexto que ninguem pediu. Com uma alternancia unica, o que entra no lugar de
 * um token nunca volta a ser examinado, e nao existe substituicao em cascata.
 *
 * A ordem das alternativas importa: `${...}` antes de `$nua` (senao a nua casaria
 * o comeco de uma chave delimitada).
 */
const RE_TODAS = new RegExp(
  `${RE_PROP.source}|${RE_CTX.source}|${RE_LEGADO.source}`,
  "g"
);
// grupos de RE_TODAS: 1 = prop, 2 = contexto {delimitado}, 3 = contexto nu, 4 = legado

/**
 * Variavel do sistema antigo -> propriedade daqui.
 *
 * MEDIDO nos 32 backups com a tela de respostas rapidas capturada (177
 * respostas): `{PRIMEIRO_NOME_LEAD}` 42x, `{DAY_GREETING}` 12x,
 * `{TELEFONE_LEAD}` 3x, `{NOME_LEAD}` 1x. As outras que aparecem
 * (`{Empresa}` 4x, `{Email}` 4x, `{CNPJ}` 2x) NAO sao
 * variaveis de sistema: sao campos da ficha, e por isso caem no caminho de
 * campo personalizado em vez de virar entrada aqui.
 */
export const ALIAS_LEGADO: Readonly<Record<string, string>> = {
  primeiro_nome_lead: "primeiro_nome",
  nome_lead: "nome",
  telefone_lead: "telefone",
  day_greeting: "saudacao",
};

// ------------------------------------------------------------------ valores
/**
 * O mapa de valores que a substituicao consome. Tudo opcional de proposito:
 * quem chama passa o que conseguiu ler, e o que faltar vira vazio (criterio de
 * aceite do card) — nunca o nome da variavel na cara do cliente.
 */
export type ValoresVariavel = {
  nome?: string | null;
  telefone?: string | null;
  atendente?: string | null;
  /** "Bom dia" / "Boa tarde" / "Boa noite" — quem sabe a hora e o fuso calcula */
  saudacao?: string | null;
  /** campos da ficha, com a chave COMO ESTA gravada (a normalizacao e feita aqui) */
  campos?: Record<string, unknown> | null;
  /** contexto da conversa (mensageria.conversa_contexto) */
  contexto?: Record<string, string> | null;
};

/**
 * Primeiro nome a partir do nome completo.
 *
 * Nome de contato de WhatsApp vem como a pessoa (ou a agenda) escreveu: com
 * emoji, com sobrenome, com empresa depois de um hifen. Aqui o corte e simples e
 * previsivel — a primeira palavra —, porque adivinhar mais que isso erra em
 * nome composto e o atendente ainda pode editar antes de enviar.
 */
export function primeiroNome(nome: unknown): string {
  const s = String(nome ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.split(" ")[0];
}

/**
 * Saudacao pela HORA (0-23). Pura: quem converte instante+fuso em hora local e
 * quem chama (`lib/fuso.ts` no servidor). Faixas declaradas: 5-11 bom dia,
 * 12-17 boa tarde, o resto boa noite.
 */
export function saudacaoDaHora(hora: number): string {
  const h = Number.isFinite(hora) ? Math.floor(hora) : 12;
  if (h >= 5 && h < 12) return "Bom dia";
  if (h >= 12 && h < 18) return "Boa tarde";
  return "Boa noite";
}

/** Valor de UMA propriedade. `null` = a propriedade nao existe no catalogo. */
export function valorDaProp(prop: string, valores: ValoresVariavel): string | null {
  const p = prop.toLowerCase();
  if (p.startsWith(PREFIXO_CAMPO)) {
    const alvo = chaveNormalizadaDeCampo(p.slice(PREFIXO_CAMPO.length));
    if (!alvo) return null;
    const campos = valores.campos;
    if (!campos || typeof campos !== "object") return "";
    for (const [k, v] of Object.entries(campos)) {
      if (chaveNormalizadaDeCampo(k) !== alvo) continue;
      // ficha e jsonb: numero e booleano viram texto; objeto/lista NAO viram
      // "[object Object]" na cara do cliente — viram vazio.
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      return "";
    }
    return ""; // forma conhecida, valor ausente = vazio (criterio de aceite)
  }
  switch (p) {
    case "nome":
      return String(valores.nome ?? "").trim();
    case "primeiro_nome":
      return primeiroNome(valores.nome);
    case "telefone":
      return String(valores.telefone ?? "").trim();
    case "atendente":
      return String(valores.atendente ?? "").trim();
    case "saudacao":
      return String(valores.saudacao ?? "").trim();
    default:
      return null;
  }
}

// ------------------------------------------------------------- inventario
export type UsoVariavel = {
  /** o token como esta escrito no texto */
  token: string;
  /** `prop` | `contexto` | `legado` */
  forma: "prop" | "contexto" | "legado";
  /** propriedade (prop/legado) ou chave (contexto) */
  alvo: string;
};

/**
 * As variaveis de um texto, na ordem em que aparecem, sem repetir.
 *
 * Serve a tela (mostrar "esta resposta usa nome e telefone") e a rota (saber
 * quais fatos vale a pena ir buscar). NAO decide nada sobre valor.
 */
export function variaveisDoTexto(texto: unknown, opcoes: { legado?: boolean } = {}): UsoVariavel[] {
  const t = typeof texto === "string" ? texto : "";
  const vistos = new Set<string>();
  const saida: UsoVariavel[] = [];
  // Uma passada, ordem POSICIONAL: e a mesma varredura que a substituicao faz,
  // entao inventario e resultado nunca discordam sobre o que e variavel.
  for (const m of t.matchAll(RE_TODAS)) {
    const uso = classificar(m, !!opcoes.legado);
    if (!uso) continue;
    const chave = `${uso.forma}:${uso.alvo}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(uso);
  }
  return saida;
}

// Le UM casamento de RE_TODAS. `null` = nao e variavel (token fora do catalogo,
// ou legado com o legado desligado) e por isso o texto fica como esta.
function classificar(m: RegExpMatchArray, legado: boolean): UsoVariavel | null {
  const [inteiro, prop, ctxDelimitado, ctxNu, antigo] = m;
  if (prop !== undefined) {
    const alvo = prop.toLowerCase();
    return conhecida(alvo) ? { token: inteiro, forma: "prop", alvo } : null;
  }
  if (ctxDelimitado !== undefined || ctxNu !== undefined) {
    const alvo = (ctxDelimitado ?? ctxNu ?? "").trim();
    return alvo ? { token: inteiro, forma: "contexto", alvo } : null;
  }
  if (antigo !== undefined && legado) return { token: inteiro, forma: "legado", alvo: antigo.trim() };
  return null;
}

function conhecida(prop: string): boolean {
  const p = prop.toLowerCase();
  if (p.startsWith(PREFIXO_CAMPO)) return !!chaveNormalizadaDeCampo(p.slice(PREFIXO_CAMPO.length));
  return Object.prototype.hasOwnProperty.call(PROPS_VARIAVEL, p);
}

// ---------------------------------------------------------- substituicao
export type ResultadoSubstituicao = {
  /** o texto pronto pra caixa de mensagem */
  texto: string;
  /** variaveis que foram trocadas por um valor NAO vazio */
  preenchidas: string[];
  /** variaveis conhecidas que ficaram vazias (o campo nao tem valor nesta conversa) */
  vazias: string[];
  /** tokens do sistema antigo que ninguem soube resolver — ficam LITERAIS no texto */
  nao_resolvidos: string[];
};

/**
 * Substitui as variaveis de um texto.
 *
 * As tres regras, e o motivo de cada uma:
 *
 *  1. **Variavel conhecida sem valor vira VAZIO, nunca o nome dela.** Criterio de
 *     aceite do card, e a razao e obvia do lado do cliente: receber "Oi !nome" e
 *     pior que receber "Oi".
 *  2. **Token desconhecido na sintaxe daqui fica INTACTO.** `!` e `$` aparecem em
 *     texto normal ("Fechado!", "R$ 200"), e comer isso estragaria mensagem que
 *     estava certa. O catalogo e o que decide o que e variavel.
 *  3. **O formato do sistema ANTIGO (`{CHAVE}`) so e olhado com `legado: true`, e
 *     o que nao resolve fica LITERAL** — assimetria proposital em relacao a regra
 *     1. `{...}` nao e sintaxe daqui: apagar calado o que sobrou da importacao
 *     esconderia justamente o texto que alguem precisa consertar. Aparecendo na
 *     tela, o atendente ve e corrige. Por isso a rota liga o legado SO em
 *     resposta que veio de importacao.
 *
 * Nao lanca nunca: texto que nao e string vira "".
 */
export function substituirVariaveis(
  texto: unknown,
  valores: ValoresVariavel,
  opcoes: { legado?: boolean } = {}
): ResultadoSubstituicao {
  const preenchidas: string[] = [];
  const vazias: string[] = [];
  const naoResolvidos: string[] = [];
  const marcar = (rotulo: string, valor: string) => {
    if (valor) {
      if (!preenchidas.includes(rotulo)) preenchidas.push(rotulo);
    } else if (!vazias.includes(rotulo)) vazias.push(rotulo);
  };
  const legado = !!opcoes.legado;
  const t = typeof texto === "string" ? texto : "";

  // UMA passada: o valor que entra no lugar de um token nunca volta a ser lido
  // (ver RE_TODAS). Sem isso, nome de contato — conteudo de TERCEIRO — podia
  // trazer o valor de uma variavel de contexto que ninguem pediu.
  const saida = t.replace(RE_TODAS, (...args: any[]) => {
    const m = args.slice(0, 5) as unknown as RegExpMatchArray;
    const uso = classificar(m, legado);
    const inteiro = String(args[0]);
    if (!uso) return inteiro;

    if (uso.forma === "prop") {
      const v = valorDaProp(uso.alvo, valores) ?? "";
      marcar(`!${uso.alvo}`, v);
      return v;
    }

    if (uso.forma === "contexto") {
      // A chave casa por igualdade EXATA — a mesma regra da condicao de fluxo
      // (docs/fluxo-canonico.md). Normalizar aqui e nao la faria a resposta
      // rapida achar uma variavel que a condicao do fluxo nao acha.
      const mapa = valores.contexto;
      const tem = !!mapa && Object.prototype.hasOwnProperty.call(mapa, uso.alvo);
      const v = tem ? String((mapa as Record<string, string>)[uso.alvo] ?? "") : "";
      marcar(`$${uso.alvo}`, v);
      return v;
    }

    // legado do sistema antigo: {PRIMEIRO_NOME_LEAD}, {Empresa}
    const alvo = chaveNormalizadaDeCampo(uso.alvo);
    const prop = ALIAS_LEGADO[alvo];
    if (prop) {
      const v = valorDaProp(prop, valores) ?? "";
      marcar(inteiro, v);
      return v;
    }
    // nao e variavel de sistema: pode ser campo da ficha ({Empresa}, {CNPJ}).
    // So substitui quando o campo EXISTE com valor — senao o token fica visivel,
    // que e o que faz alguem consertar o texto importado.
    const vCampo = valorDaProp(`${PREFIXO_CAMPO}${alvo}`, valores);
    if (vCampo) {
      marcar(inteiro, vCampo);
      return vCampo;
    }
    if (!naoResolvidos.includes(inteiro)) naoResolvidos.push(inteiro);
    return inteiro;
  });

  return { texto: saida, preenchidas, vazias, nao_resolvidos: naoResolvidos };
}

/**
 * Ajuda de tela: a lista de variaveis disponiveis, ja com verbete e com os
 * campos da ficha desta instalacao. E o que a tela mostra num "?" ao lado da
 * caixa de texto — sem isso, a sintaxe existe e ninguem descobre.
 */
export function catalogoDeVariaveis(camposDaFicha: Iterable<string> = []): {
  token: string;
  verbete: string;
}[] {
  const saida = Object.entries(PROPS_VARIAVEL).map(([p, verbete]) => ({ token: `!${p}`, verbete }));
  const vistos = new Set<string>();
  for (const nome of camposDaFicha) {
    const chave = chaveNormalizadaDeCampo(nome);
    if (!chave || vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push({ token: `!${PREFIXO_CAMPO}${chave}`, verbete: `Campo da ficha: ${String(nome)}` });
  }
  saida.push({
    token: "$variavel",
    verbete: "Variavel de contexto da conversa (a mesma que a condicao de fluxo le). Use ${com espaco} quando a chave tiver espaco.",
  });
  return saida;
}
