// ANALISADOR da linguagem de condicao do ChatGuru -> condicao canonica.
//
// No ChatGuru a condicao e uma MINI-LINGUAGEM em texto, digitada num campo e
// validada so no servidor deles. Aqui condicao e ESTRUTURA (arvore de
// comparacoes, ver lib/fluxo/schema.ts). Este arquivo e a ponte, e ele existe
// pra que a importacao nunca CHUTE: cada expressao sai como
//
//   convertida  — a arvore representa a expressao inteira, sem perda;
//   ressalva    — converteu, mas tem coisa que quem importa precisa conferir;
//   nao         — NAO converteu, com o motivo apontando o termo que travou.
//
// REGRA-MAE: conversao e TUDO OU NADA por expressao. Um termo que nao tem
// equivalente NAO e descartado pra "aproveitar o resto" — descartar termo de um
// `and` faz a automacao disparar MAIS vezes do que disparava, e descartar de um
// `or` faz disparar menos. Nos dois casos a automacao passa a fazer coisa
// diferente do que a pessoa configurou, em silencio. Entao expressao com termo
// sem equivalente sai INTEIRA como "nao convertida", e o relatorio diz qual
// termo travou — que e a lista do que implementar pra destravar N dialogos.
//
// ================================ FRONTEIRA ================================
// A expressao e DADO DE TERCEIRO (vem do backup de um cliente), nunca
// instrucao: texto entre aspas e valor a comparar, e nada ali autoriza acao
// nenhuma. Valor entra na arvore como STRING literal — nao e interpretado, nao
// vira consulta, nao vira comando.
// ===========================================================================
//
// GRAMATICA MEDIDA no acervo real (33 contas, 7.462 dialogos, 3.305 expressoes):
//
//   expressao  := ou
//   ou         := e ( 'or' e )*
//   e          := unario ( 'and' unario )*
//   unario     := 'not' unario | primario
//   primario   := '(' expressao ')' | comparacao
//   comparacao := referencia [ operador valor ]
//   referencia := '$NOME'  variavel de contexto da conversa (182 distintas)
//               | '!NOME'  propriedade do sistema (21 distintas)
//               | '#NOME'  referencia sem equivalente conhecido (13 distintas)
//               | '@NOME'  campo personalizado do contato (13 distintas)
//   operador   := '==' | '!=' | '<=' | '>=' | '<' | '>'
//   valor      := 'texto entre aspas simples' | numero sem aspas
//
// Detalhes que so aparecem olhando o acervo, e que o parser precisa aguentar:
//   - a expressao vem QUEBRADA EM LINHAS com indentacao (e um textarea de HTML);
//   - nome de variavel aceita espaco, hifen e acento ($Reserva confirmada, $QC-IM);
//   - valor nunca tem apostrofo dentro (0 casos em 3.305) — nao ha escape;
//   - parentese aninha ate 3 niveis;
//   - existe expressao MALFORMADA que o ChatGuru aceitou (`not and $x=='y'`).

// --------------------------------------------------------------- limites
// ESPELHOS de lib/fluxo/schema.ts. Este arquivo e .mjs e nao importa o schema de
// proposito (roda dentro do conversor, em node solto, sem build) — entao os
// tetos vivem em dois lugares e MUDAR LA EXIGE MUDAR AQUI. Sem o espelho, o
// analisador produz condicao que a unica porta de verdade (`validarFluxo`)
// recusa depois, e o diagnostico sai longe da causa.
export const LIMITE_PROFUNDIDADE = 12; // LIMITE_PROFUNDIDADE_CONDICAO
export const LIMITE_TERMOS = 200; // LIMITE_TERMOS_CONDICAO
export const LIMITE_VALOR = 1000; // LIMITE_VALOR_CONDICAO
export const LIMITE_CHAVE = 120; // LIMITE_CHAVE_CONTEXTO
export const LIMITE_TOKENS = 5000;
// nao tem espelho no schema: e limite DE SINTAXE, pra varredura de nome de
// referencia nao virar corrida por uma expressao de entrada gigante
export const LIMITE_NOME_REFERENCIA = 200;

// Propriedades do sistema que VIRAM campo da v1.
const PROPRIEDADES = {
  // a mensagem inteira e igual ao valor
  "!text": { campo: "texto", operador: "igual" },
  // o valor aparece DENTRO da mensagem
  "!word": { campo: "texto", operador: "contem" },
  "!status": { campo: "status", operador: "igual" },
};

// Status do ChatGuru -> status do painel (mesmo mapa do converter-chatguru.mjs;
// sao 5 la e 4 aqui, e o FECHADO/RESOLVIDO colapsam em concluido).
const STATUS_CG = {
  ABERTO: "aberto",
  "EM ATENDIMENTO": "atendimento",
  AGUARDANDO: "aguardando",
  RESOLVIDO: "concluido",
  FECHADO: "concluido",
};

// Propriedades SEM equivalente na v1, com o motivo que vai pro relatorio. O
// texto e o que decide a prioridade do proximo campo a implementar.
const PROPRIEDADES_SEM_EQUIVALENTE = {
  "!current_time": "condicao por HORA do dia; a v1 nao tem campo de horario",
  "!current_date": "condicao por DATA; a v1 nao tem campo de data",
  "!current_hour": "condicao por HORA cheia; a v1 nao tem campo de horario",
  "!current_day_month": "condicao por dia/mes; a v1 nao tem campo de data",
  "!current_day_of_month": "condicao por dia do mes; a v1 nao tem campo de data",
  "!saturday": "condicao por DIA DA SEMANA (sabado); a v1 nao tem campo de data",
  "!sunday": "condicao por DIA DA SEMANA (domingo); a v1 nao tem campo de data",
  "!friday": "condicao por DIA DA SEMANA (sexta); a v1 nao tem campo de data",
  "!missed_call": "condicao por CHAMADA PERDIDA; a v1 nao le tipo de evento do WhatsApp",
  "!msg_image": "condicao por TIPO DE MIDIA (imagem); a v1 so olha o texto da mensagem",
  "!msg_video": "condicao por TIPO DE MIDIA (video); a v1 so olha o texto da mensagem",
  "!msg_audio": "condicao por TIPO DE MIDIA (audio); a v1 so olha o texto da mensagem",
  "!msg_document": "condicao por TIPO DE MIDIA (documento); a v1 so olha o texto da mensagem",
  "!msg_incomplete": "condicao por mensagem incompleta; a v1 nao tem esse sinal",
  "!new_chat": "condicao por CONVERSA NOVA; a v1 nao tem esse sinal",
  "!number_starts_with": "condicao por PREFIXO DO TELEFONE; a v1 nao tem campo de telefone",
  "!contains_email": "condicao por e-mail na mensagem; a v1 nao tem esse sinal",
  "!is_email": "condicao por mensagem ser um e-mail; a v1 nao tem esse sinal",
};

// --------------------------------------------------------------- tokenizer
const OPERADORES = ["==", "!=", "<=", ">=", "<", ">"];
const PARA_REFERENCIA = new Set(["=", "<", ">", "(", ")", "'", "!"]);
const PALAVRAS = new Set(["and", "or", "not"]);
const SIGILOS = new Set(["$", "!", "#", "@"]);
const RE_ESPACO = /\s/;
const ehEspaco = (c) => RE_ESPACO.test(c);
// delimitador que encerra uma palavra solta (conectivo, numero sem aspas)
const FIM_DE_PALAVRA = new Set(["=", "<", ">", "(", ")", "'", "!"]);
const ehFimDePalavra = (c) => FIM_DE_PALAVRA.has(c) || ehEspaco(c);

export function tokenizar(texto) {
  const s = String(texto ?? "");
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (tokens.length >= LIMITE_TOKENS) {
      return { erro: `expressao com mais de ${LIMITE_TOKENS} termos`, tokens };
    }
    if (c === "'") {
      const fim = s.indexOf("'", i + 1);
      // aspas nao fechada e erro de sintaxe, nao "resto do texto e o valor":
      // engolir ate o fim faria uma condicao errada parecer valida
      if (fim < 0) return { erro: "aspas simples aberta e nunca fechada", tokens };
      tokens.push({ t: "valor", v: s.slice(i + 1, fim) });
      i = fim + 1;
      continue;
    }
    if (c === "(" || c === ")") {
      tokens.push({ t: c });
      i++;
      continue;
    }
    const op = OPERADORES.find((o) => s.startsWith(o, i));
    if (op) {
      tokens.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    if (c === "$" || c === "!" || c === "#" || c === "@") {
      // Nome de referencia aceita espaco, hifen e acento ($Reserva confirmada,
      // $QC-IM), entao ele nao para no espaco: para no operador, no parentese,
      // na aspas — ou num espaco seguido de palavra-chave/outra referencia.
      // ATENCAO — esta varredura JA FOI QUADRATICA e travou por 21s numa
      // expressao com 32 mil espacos: a versao antiga fazia `s.slice(j)` +
      // regex + split A CADA espaco. Aqui cada caractere e olhado um numero
      // limitado de vezes: ao achar espaco, o corredor de espacos e pulado de
      // uma vez e a proxima palavra e lida NO LUGAR, sem copiar a string.
      let j = i + 1;
      const teto = Math.min(s.length, i + 1 + LIMITE_NOME_REFERENCIA);
      while (j < teto && !PARA_REFERENCIA.has(s[j])) {
        if (!ehEspaco(s[j])) {
          j++;
          continue;
        }
        let k = j;
        while (k < s.length && ehEspaco(s[k])) k++;
        // fim da expressao, outra referencia ou palavra-chave: o nome acabou
        if (k >= s.length || SIGILOS.has(s[k])) break;
        let f = k;
        while (f < s.length && !ehFimDePalavra(s[f])) f++;
        if (PALAVRAS.has(s.slice(k, f).toLowerCase())) break;
        j = k; // nao era palavra-chave: o nome continua depois do espaco
      }
      // nome comprido demais e recusa EXPLICITA, nunca corte silencioso (nome
      // cortado casaria com a chave errada no contexto da conversa)
      if (j >= teto && j < s.length && !PARA_REFERENCIA.has(s[j]) && !ehEspaco(s[j])) {
        return { erro: `nome de referencia acima de ${LIMITE_NOME_REFERENCIA} caracteres`, tokens };
      }
      const nome = s.slice(i, j).trim();
      if (nome.length <= 1) return { erro: `referencia vazia ("${c}" sem nome)`, tokens };
      tokens.push({ t: "ref", v: nome });
      i = j;
      continue;
    }
    // palavra solta: conectivo, `not`, numero sem aspas ou termo desconhecido
    let j = i;
    while (j < s.length && !/[\s=<>()']/.test(s[j])) j++;
    const palavra = s.slice(i, j);
    const baixa = palavra.toLowerCase();
    if (PALAVRAS.has(baixa)) tokens.push({ t: baixa });
    else if (/^\d+$/.test(palavra)) tokens.push({ t: "valor", v: palavra });
    else tokens.push({ t: "palavra", v: palavra });
    i = j;
  }
  return { tokens };
}

// ------------------------------------------------------------------ parser
// Devolve a arvore BRUTA (ainda na linguagem do ChatGuru): so estrutura, sem
// decidir o que vira campo canonico. Separar as duas fases e o que permite
// dizer "a sintaxe estava certa, mas a propriedade X nao tem equivalente" em
// vez de um "nao entendi" generico.
function analisarSintaxe(tokens) {
  let pos = 0;
  const espiar = () => tokens[pos];
  const consumir = () => tokens[pos++];
  const avisos = [];

  function expressao(profundidade) {
    if (profundidade > LIMITE_PROFUNDIDADE) {
      throw new Error(`condicao com mais de ${LIMITE_PROFUNDIDADE} niveis de parenteses`);
    }
    let esq = termoE(profundidade);
    const partes = [esq];
    let temOu = false;
    while (espiar()?.t === "or") {
      consumir();
      partes.push(termoE(profundidade));
      temOu = true;
    }
    if (!temOu) return esq;
    return { tipo: "ou", condicoes: partes };
  }

  function termoE(profundidade) {
    const partes = [unario(profundidade)];
    while (espiar()?.t === "and") {
      consumir();
      partes.push(unario(profundidade));
    }
    return partes.length === 1 ? partes[0] : { tipo: "e", condicoes: partes };
  }

  function unario(profundidade) {
    if (espiar()?.t === "not") {
      consumir();
      // `not and $x=='y'` existe no acervo (17 expressoes): o ChatGuru aceitou,
      // mas `not` sem operando pode significar duas coisas diferentes. Nao se
      // adivinha — para aqui com o motivo escrito.
      const prox = espiar();
      if (!prox || prox.t === "and" || prox.t === "or" || prox.t === ")") {
        throw new Error("`not` sem termo (expressao malformada na origem)");
      }
      return { tipo: "nao", condicao: unario(profundidade) };
    }
    return primario(profundidade);
  }

  function primario(profundidade) {
    const tk = espiar();
    if (!tk) throw new Error("expressao terminou no meio (faltou um termo)");
    if (tk.t === "(") {
      consumir();
      const dentro = expressao(profundidade + 1);
      if (espiar()?.t !== ")") throw new Error("parentese aberto e nunca fechado");
      consumir();
      return dentro;
    }
    if (tk.t === ")") throw new Error("parentese fechado sem abrir");
    if (tk.t === "and" || tk.t === "or") throw new Error(`conectivo \`${tk.t}\` sem termo a esquerda`);
    if (tk.t === "valor") throw new Error("valor solto, sem referencia pra comparar");
    if (tk.t === "palavra") {
      consumir();
      // `anything_else` (40 expressoes) e o curinga do ChatGuru: ele nao fala
      // sobre a conversa, fala sobre os OUTROS dialogos ("quando mais nenhum
      // casar"). Nao e predicado — nao tem como virar comparacao.
      if (tk.v.toLowerCase() === "anything_else") {
        throw new Error("termo `anything_else` (curinga de 'nenhum outro dialogo casou'): nao e condicao da conversa");
      }
      throw new Error(`termo desconhecido \`${tk.v}\``);
    }
    // referencia
    consumir();
    const prox = espiar();
    if (prox?.t === "op") {
      consumir();
      const val = espiar();
      if (val?.t !== "valor") throw new Error(`operador \`${prox.v}\` sem valor a direita`);
      consumir();
      return { tipo: "termo", ref: tk.v, op: prox.v, valor: val.v };
    }
    return { tipo: "termo", ref: tk.v, op: null, valor: null };
  }

  const arvore = expressao(1);
  if (pos < tokens.length) {
    const sobra = tokens[pos];
    throw new Error(`sobrou termo depois do fim da expressao (${sobra.t === "ref" ? sobra.v : sobra.t})`);
  }
  return { arvore, avisos };
}

// Mistura de `and` e `or` no MESMO nivel, sem parenteses: a arvore muda de
// significado conforme a precedencia, e a do ChatGuru nao esta documentada nem
// da pra medir no backup. Assumimos a convencao usual (`and` mais forte que
// `or`) e AVISAMOS — e o tipo de coisa que, calada, faz a automacao disparar
// pra quem nao devia.
function misturaSemParenteses(tokens) {
  let profundidade = 0;
  const niveis = new Map();
  for (const tk of tokens) {
    if (tk.t === "(") profundidade++;
    else if (tk.t === ")") profundidade--;
    else if (tk.t === "and" || tk.t === "or") {
      const atual = niveis.get(profundidade) ?? new Set();
      atual.add(tk.t);
      niveis.set(profundidade, atual);
    }
  }
  for (const conj of niveis.values()) if (conj.size > 1) return true;
  return false;
}

// ------------------------------------------------------------- traducao
// Arvore bruta -> condicao canonica. Lanca com o motivo no primeiro termo sem
// equivalente (tudo ou nada, ver REGRA-MAE no topo).
function traduzir(no, ressalvas) {
  if (no.tipo === "e" || no.tipo === "ou") {
    return { tipo: no.tipo, condicoes: no.condicoes.map((c) => traduzir(c, ressalvas)) };
  }
  if (no.tipo === "nao") return { tipo: "nao", condicao: traduzir(no.condicao, ressalvas) };

  const { ref, op, valor } = no;
  const sigilo = ref[0];
  const nome = ref.slice(1).trim();

  if (sigilo === "#") {
    throw new Error(
      `referencia \`${ref}\`: no acervo ela nao casa com etiqueta do catalogo nem com titulo de dialogo (provavel opcao de menu/botao do ChatGuru) — sem equivalente conhecido`
    );
  }
  if (sigilo === "@") {
    throw new Error(`campo personalizado do contato (\`${ref}\`): a v1 nao tem campo personalizado como campo de condicao`);
  }

  // TETOS ESPELHADOS DO SCHEMA (ver o topo): recusar aqui faz o motivo apontar a
  // expressao de origem; deixar passar so adia a recusa pro validarFluxo, longe
  // de quem consegue consertar.
  if (valor !== null && String(valor).length > LIMITE_VALOR) {
    throw new Error(`valor com mais de ${LIMITE_VALOR} caracteres`);
  }
  if (sigilo === "$" && nome.length > LIMITE_CHAVE) {
    throw new Error(`nome de variavel de contexto com mais de ${LIMITE_CHAVE} caracteres`);
  }

  if (sigilo === "!") {
    const chave = `!${nome.toLowerCase()}`;
    const semEquivalente = PROPRIEDADES_SEM_EQUIVALENTE[chave];
    if (semEquivalente) throw new Error(`propriedade \`${chave}\`: ${semEquivalente}`);
    const mapa = PROPRIEDADES[chave];
    if (!mapa) throw new Error(`propriedade \`${chave}\` desconhecida no vocabulario medido`);
    if (op === null) throw new Error(`propriedade \`${chave}\` usada sem valor (booleana?), e ela nao e booleana`);
    if (op !== "==" && op !== "!=") {
      throw new Error(`operador \`${op}\` em \`${chave}\`: a v1 so compara igualdade nesse campo`);
    }
    if (chave === "!status") {
      const bruto = String(valor).trim();
      const status = STATUS_CG[bruto.toUpperCase()];
      if (!status) throw new Error(`status \`${bruto}\` nao existe no painel`);
      if (bruto.toUpperCase() === "FECHADO" || bruto.toUpperCase() === "RESOLVIDO") {
        ressalvas.push("status FECHADO/RESOLVIDO viraram o mesmo `concluido` (o ChatGuru tem 5 status, o painel tem 4)");
      }
      return { tipo: "comparacao", campo: "status", operador: op === "==" ? "igual" : "diferente", valor: status };
    }
    if (chave === "!word") {
      ressalvas.push(
        "`!word` virou `texto contem`: o ChatGuru procura a PALAVRA e o painel procura o trecho (com 'oi', 'boi' passa a casar)"
      );
    }
    const operador = op === "==" ? mapa.operador : mapa.operador === "contem" ? "nao_contem" : "diferente";
    if (!String(valor).trim()) throw new Error(`comparacao com valor vazio em \`${chave}\``);
    return { tipo: "comparacao", campo: mapa.campo, operador, valor: String(valor) };
  }

  // $VAR — variavel de contexto da conversa, o caso dominante
  if (!nome) throw new Error("variavel de contexto sem nome");
  if (op === null) {
    throw new Error(`variavel \`$${nome}\` usada sem comparacao; o que o ChatGuru faz nesse caso nao esta documentado`);
  }
  if (op !== "==" && op !== "!=") {
    throw new Error(`operador \`${op}\` em \`$${nome}\`: a v1 compara contexto so por igualdade`);
  }
  const bruto = String(valor);
  if (!bruto.trim()) throw new Error(`comparacao com valor vazio em \`$${nome}\``);
  // ARMADILHA MEDIDA: no ChatGuru variavel nunca definida se compara igual a
  // 'False'/'None' (1.146 dialogos usam 'False' como valor de entrada). Aqui
  // campo AUSENTE e falso pra qualquer comparacao de valor — entao a mesma
  // expressao pode deixar de valer. Converte literal e avisa, porque adivinhar
  // a semantica do avaliador deles seria chute.
  if (/^(false|none)$/i.test(bruto.trim())) {
    ressalvas.push(
      `\`$${nome}=='${bruto}'\` foi convertido LITERALMENTE: no ChatGuru variavel nao definida compara igual a 'False'/'None', e aqui campo ausente e sempre falso — confira se o certo nao e "nao existe"`
    );
  }
  return {
    tipo: "comparacao",
    campo: "contexto",
    chave: nome,
    operador: op === "==" ? "igual" : "diferente",
    valor: bruto,
  };
}

// Profundidade da ARVORE CANONICA — que nao e a dos parenteses: `e`, `ou` e
// `nao` viram nivel no formato canonico, entao `not not not $x=='1'` e fundo sem
// nenhum parentese. E este numero que `validarCondicao` mede; conferir aqui faz
// a recusa sair com o motivo da SINTAXE em vez de estourar depois, longe.
// Quantas COMPARACOES (folhas) a arvore tem. E o outro teto do schema, e ele nao
// aparece na profundidade: 400 comparacoes num `and` unico dao profundidade 2 e
// estouram `LIMITE_TERMOS_CONDICAO` — saiam daqui como "convertida" e morriam
// depois no `validarFluxo`, longe de quem consegue consertar.
export function termosDaCondicao(c) {
  if (!c || typeof c !== "object") return 0;
  if (c.tipo === "e" || c.tipo === "ou") {
    return (c.condicoes ?? []).reduce((soma, f) => soma + termosDaCondicao(f), 0);
  }
  if (c.tipo === "nao") return termosDaCondicao(c.condicao);
  return 1;
}

export function profundidadeDaCondicao(c) {
  if (!c || typeof c !== "object") return 0;
  if (c.tipo === "e" || c.tipo === "ou") {
    return 1 + Math.max(0, ...(c.condicoes ?? []).map(profundidadeDaCondicao));
  }
  if (c.tipo === "nao") return 1 + profundidadeDaCondicao(c.condicao);
  return 1;
}

// ---------------------------------------------------------------- fachada
// Analisa UMA expressao. Nunca lanca: devolve sempre um dos tres estados.
export function analisarCondicao(texto) {
  const cru = String(texto ?? "").trim();
  if (!cru) return { estado: "nao", motivo: "condicao vazia", ressalvas: [], referencias: {} };

  const { tokens, erro } = tokenizar(cru);
  const referencias = contarReferencias(tokens);
  if (erro) return { estado: "nao", motivo: `sintaxe: ${erro}`, ressalvas: [], referencias };

  let arvoreBruta;
  try {
    arvoreBruta = analisarSintaxe(tokens).arvore;
  } catch (e) {
    return { estado: "nao", motivo: `sintaxe: ${e.message}`, ressalvas: [], referencias };
  }

  const ressalvas = [];
  let condicao;
  try {
    condicao = traduzir(arvoreBruta, ressalvas);
  } catch (e) {
    return { estado: "nao", motivo: `sem equivalente na v1: ${e.message}`, ressalvas: [], referencias };
  }

  const termos = termosDaCondicao(condicao);
  if (termos > LIMITE_TERMOS) {
    return {
      estado: "nao",
      motivo: `sem equivalente na v1: a condicao fica com ${termos} comparacoes (o teto e ${LIMITE_TERMOS})`,
      ressalvas: [],
      referencias,
    };
  }

  const fundo = profundidadeDaCondicao(condicao);
  if (fundo > LIMITE_PROFUNDIDADE) {
    return {
      estado: "nao",
      motivo: `sem equivalente na v1: a condicao fica com ${fundo} niveis na arvore canonica (o teto e ${LIMITE_PROFUNDIDADE}; \`e\`, \`ou\` e \`nao\` contam nivel, nao so o parentese)`,
      ressalvas: [],
      referencias,
    };
  }

  if (misturaSemParenteses(tokens)) {
    ressalvas.push(
      "a expressao mistura `and` e `or` sem parenteses: foi lida com `and` mais forte que `or` (convencao usual), e a precedencia do ChatGuru nao e documentada — confira"
    );
  }

  const unicas = [...new Set(ressalvas)];
  return { estado: unicas.length ? "ressalva" : "convertida", condicao, ressalvas: unicas, referencias };
}

// Contagem por TIPO de referencia — e o que o relatorio do dry run precisa pra
// dizer "implementar horario destrava N dialogos".
export function contarReferencias(tokens) {
  const conta = {};
  for (const tk of tokens ?? []) {
    if (tk.t !== "ref") continue;
    const sigilo = tk.v[0];
    const chave =
      sigilo === "$"
        ? "$contexto"
        : sigilo === "!"
          ? `!${tk.v.slice(1).trim().toLowerCase()}`
          : `${sigilo}referencia`;
    conta[chave] = (conta[chave] || 0) + 1;
  }
  return conta;
}

// Condicao de ENTRADA por variavel de contexto (campos `context_variable_name`
// e `context_variable_value` do cabecalho do dialogo): o filtro simples que
// existe ANTES da expressao avancada. 3.423 dos 7.462 dialogos usam.
export function condicaoDeContextoDeEntrada(nome, valor) {
  const chave = String(nome ?? "").trim();
  if (!chave) return null;
  const bruto = String(valor ?? "").trim();
  const ressalvas = [];
  if (!bruto) {
    // nome sem valor: o dialogo exige que a variavel ESTEJA definida
    return { estado: "convertida", condicao: { tipo: "comparacao", campo: "contexto", chave, operador: "existe" }, ressalvas };
  }
  if (/^(false|none)$/i.test(bruto)) {
    ressalvas.push(
      `contexto de entrada \`${chave}='${bruto}'\` convertido LITERALMENTE: no ChatGuru variavel nao definida compara igual a 'False'/'None', e aqui campo ausente e sempre falso — confira se o certo nao e "nao existe"`
    );
  }
  return {
    estado: ressalvas.length ? "ressalva" : "convertida",
    condicao: { tipo: "comparacao", campo: "contexto", chave, operador: "igual", valor: bruto },
    ressalvas,
  };
}
