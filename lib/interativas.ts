// MENSAGENS INTERATIVAS — botoes de resposta rapida e lista de opcoes.
// Frente S, card 86ak86jvw (item 27 do benchmark, `docs/benchmark-chatguru.md`).
//
// Este arquivo e PURO: nao importa NADA. Roda no Next e em node solto
// (`node scripts/prova-interativas.ts`), mesma convencao de lib/permissoes.ts,
// lib/fluxo/schema.ts e lib/escopo-chave.ts.
//
// ————————————————————————————————————————————————————————————————————————
// O FORMATO CANONICO E DAQUI, e ele e PORTATIL de proposito.
//
// Uma pergunta com opcoes e a MESMA coisa nos dois provedores; o que muda e o
// envelope. Entao a decisao (o que e valido, quantas opcoes cabem, o que fazer
// quando o provedor nao da conta) mora aqui, e cada provedor so traduz. Sem
// isso, a regra nasceria copiada em lib/zapi.ts e lib/gupshup.ts e divergiria no
// primeiro provedor novo — e este repo ja escreveu isso em tres lugares uma vez
// (a assinatura do atendente, ver CLAUDE.md).
//
// ————————————————————————————————————————————————————————————————————————
// OS LIMITES SAO DO WHATSAPP, e foram MEDIDOS NA DOC OFICIAL em 31/08/2026 —
// nao chutados:
//
//   Gupshup (canal de API oficial), POST /wa/api/v1/msg:
//     `type: "quick_reply"` — "Up to 3 options are supported"; titulo da opcao
//        max 20 chars; `content.header` max 20; `caption` max 60.
//     `type: "list"` — ate 10 itens; `title` max 60; `body` max 1024;
//        `footer` max 60; `globalButtons[].title` max 20; opcao `title` max 24 e
//        `description` max 72.
//
//   Z-API, `send-option-list`: a doc traz o corpo
//     `{phone, message, optionList:{title, buttonLabel, options:[{title,
//     description, id}]}}` e o aviso "A funcionalidade de lista de opcoes nao
//     funciona mais em grupos". Ela NAO documenta tetos numericos — entao os
//     tetos aplicados aqui sao os do WhatsApp (os mesmos que a Gupshup
//     documenta), e nao uma invencao nossa: o limite mora na plataforma, nao no
//     intermediario.
//
// ————————————————————————————————————————————————————————————————————————
// A DECISAO MAIS IMPORTANTE: BOTAO NO Z-API NAO SAI COMO BOTAO.
//
// A Z-API tem `send-button-list`, mas a doc DELA declara, na pagina
// "Funcionamento dos Botoes": "Nas ultimas semanas as mensagens contendo botoes
// estao sofrendo uma instabilidade em seu funcionamento" e que o resultado
// depende do tipo de conta e do destino, com aviso de que "futuras atualizacoes
// do WhatsApp podem causar instabilidades nessa funcionalidade".
//
// Mandar por um caminho que o proprio fornecedor chama de instavel produziria o
// pior desfecho possivel: a mensagem SAI, o cliente nao ve botao nenhum, e o
// atendente fica esperando uma resposta que nunca vem. Entao aqui botao no Z-API
// cai no fallback que o proprio card pede — a mesma pergunta como TEXTO
// NUMERADO — com o motivo escrito na cara de quem enviou.
//
// LISTA no Z-API, sim: `send-option-list` e documentada sem ressalva de
// instabilidade. So nao em GRUPO, e a propria doc diz isso — em grupo, fallback.
//
// Regra geral da casa que isto obedece: **o que o provedor nao suporta e
// declarado e recusado com mensagem honesta, nunca enviado quebrado.**

export const TIPOS_INTERATIVA = ["botoes", "lista"] as const;
export type TipoInterativa = (typeof TIPOS_INTERATIVA)[number];

export type OpcaoInterativa = {
  titulo: string;
  /** so a LISTA tem descricao por opcao (botao nao tem onde mostrar) */
  descricao?: string;
};

export type Interativa = {
  tipo: TipoInterativa;
  /** o corpo da pergunta */
  texto: string;
  /** cabecalho — so a lista tem lugar pra ele */
  titulo?: string;
  rodape?: string;
  /** rotulo do botao que ABRE a lista (a lista nao aparece sozinha) */
  botao_lista?: string;
  opcoes: OpcaoInterativa[];
};

// —————————————————————————————————————————————————————————————— limites
export const MAX_BOTOES = 3;
export const MAX_ITENS_LISTA = 10;
export const LIMITE_TITULO_BOTAO = 20;
export const LIMITE_TITULO_ITEM = 24;
export const LIMITE_DESCRICAO_ITEM = 72;
export const LIMITE_TEXTO_INTERATIVA = 1024;
export const LIMITE_RODAPE_INTERATIVA = 60;
export const LIMITE_BOTAO_LISTA = 20;
/** espelho de LIMITE_TEXTO em lib/fluxo/schema.ts e do teto de /api/send */
export const LIMITE_TEXTO_SAIDA = 4096;

export function maxOpcoes(tipo: TipoInterativa): number {
  return tipo === "botoes" ? MAX_BOTOES : MAX_ITENS_LISTA;
}
export function limiteTituloOpcao(tipo: TipoInterativa): number {
  return tipo === "botoes" ? LIMITE_TITULO_BOTAO : LIMITE_TITULO_ITEM;
}

/**
 * Teto do TITULO DA MENSAGEM (o cabecalho), POR TIPO.
 *
 * FRENTE S, correcao da revisao cega: a validacao cobrava um teto UNICO de 60 e
 * o envelope da Gupshup CORTAVA o mesmo campo em 20 (header do `quick_reply`) e
 * em 24 (titulo da secao da `list`). Ou seja,
 * um titulo de 40 caracteres PASSAVA e saia cortado ao meio pro cliente — o
 * corte silencioso que esta lib existe pra nao fazer.
 *
 * Os numeros sao os que o envelope efetivamente honra por tipo. Sao mais
 * conservadores que o teto de header da Meta (60): a escolha da casa e RECUSAR e
 * deixar a pessoa reescrever, nunca entregar frase cortada. Quem quiser afrouxar
 * muda AQUI, num lugar so, e a validacao e o envelope andam juntos.
 */
export function limiteTituloMensagem(tipo: TipoInterativa): number {
  return tipo === "botoes" ? LIMITE_TITULO_BOTAO : LIMITE_TITULO_ITEM;
}

export function ehTipoInterativa(v: unknown): v is TipoInterativa {
  return typeof v === "string" && (TIPOS_INTERATIVA as readonly string[]).includes(v);
}

const texto = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export type Validacao = { ok: true; msg: Interativa } | { ok: false; erros: string[] };

/**
 * VALIDA E NORMALIZA na ENTRADA (regra da casa pra jsonb: validar na entrada, e
 * nao na hora de usar). Corte silencioso nao existe aqui: campo grande demais e
 * RECUSADO com o motivo, porque o WhatsApp corta o excedente sem avisar — e uma
 * opcao com o titulo cortado ao meio faz o cliente escolher outra coisa.
 */
export function validarInterativa(bruto: unknown): Validacao {
  const erros: string[] = [];
  const b = bruto && typeof bruto === "object" && !Array.isArray(bruto) ? (bruto as any) : null;
  if (!b) return { ok: false, erros: ["mensagem interativa ausente ou fora do formato"] };

  const tipo = b.tipo;
  if (!ehTipoInterativa(tipo)) {
    return { ok: false, erros: [`tipo invalido (use ${TIPOS_INTERATIVA.join(" ou ")})`] };
  }

  const corpo = texto(b.texto);
  if (!corpo) erros.push("a pergunta (texto) e obrigatoria");
  if (corpo.length > LIMITE_TEXTO_INTERATIVA) {
    erros.push(`a pergunta passa de ${LIMITE_TEXTO_INTERATIVA} caracteres`);
  }

  const titulo = texto(b.titulo);
  // POR TIPO (ver limiteTituloMensagem): e o teto que o envelope honra de fato.
  const limTituloMsg = limiteTituloMensagem(tipo);
  if (titulo.length > limTituloMsg) {
    erros.push(`o titulo passa de ${limTituloMsg} caracteres`);
  }
  const rodape = texto(b.rodape);
  if (rodape.length > LIMITE_RODAPE_INTERATIVA) {
    erros.push(`o rodape passa de ${LIMITE_RODAPE_INTERATIVA} caracteres`);
  }
  // O botao que ABRE a lista tem default: lista sem rotulo de botao nao abre no
  // celular do cliente, e mandar vazio deixaria a mensagem inutil.
  const botaoLista = texto(b.botao_lista) || "Ver opcoes";
  if (tipo === "lista" && botaoLista.length > LIMITE_BOTAO_LISTA) {
    erros.push(`o rotulo do botao da lista passa de ${LIMITE_BOTAO_LISTA} caracteres`);
  }

  const brutas: unknown[] = Array.isArray(b.opcoes) ? b.opcoes : [];
  const teto = maxOpcoes(tipo);
  const limTitulo = limiteTituloOpcao(tipo);
  const opcoes: OpcaoInterativa[] = [];
  const vistas = new Set<string>();
  for (const o of brutas) {
    const t = typeof o === "string" ? o.trim() : texto((o as any)?.titulo);
    if (!t) continue; // linha em branco do formulario nao e erro, e ausencia
    if (t.length > limTitulo) {
      erros.push(`a opcao "${t.slice(0, 24)}..." passa de ${limTitulo} caracteres`);
      continue;
    }
    // OPCAO REPETIDA E RECUSADA, e nao e preciosismo: a resposta do cliente
    // chega como o TITULO escolhido (Z-API: `selectedRowTitle`; Meta:
    // `interactive.button_reply.title`). Com dois titulos iguais nao ha como
    // saber qual ele apertou — e um menu ambiguo faz o fluxo ramificar errado.
    const chave = t.toLowerCase();
    if (vistas.has(chave)) {
      erros.push(`a opcao "${t}" esta repetida (a resposta chega pelo TITULO: repetida fica ambigua)`);
      continue;
    }
    vistas.add(chave);
    const d = tipo === "lista" ? texto((o as any)?.descricao) : "";
    if (d.length > LIMITE_DESCRICAO_ITEM) {
      erros.push(`a descricao da opcao "${t}" passa de ${LIMITE_DESCRICAO_ITEM} caracteres`);
      continue;
    }
    opcoes.push(d ? { titulo: t, descricao: d } : { titulo: t });
  }
  if (opcoes.length < 2) erros.push("uma pergunta com opcoes precisa de pelo menos 2");
  if (opcoes.length > teto) {
    erros.push(
      tipo === "botoes"
        ? `botoes de resposta rapida aceitam no maximo ${MAX_BOTOES} opcoes (o limite e do WhatsApp) — com mais que isso, use lista`
        : `a lista de opcoes aceita no maximo ${MAX_ITENS_LISTA} (o limite e do WhatsApp)`
    );
  }

  if (erros.length) return { ok: false, erros };
  return {
    ok: true,
    msg: {
      tipo,
      texto: corpo,
      ...(titulo ? { titulo } : {}),
      ...(rodape ? { rodape } : {}),
      ...(tipo === "lista" ? { botao_lista: botaoLista } : {}),
      opcoes,
    },
  };
}

// ————————————————————————————————————————————————— o plano por provedor

export type ModoInterativa = "nativo" | "texto_numerado";
export type PlanoInterativa = {
  modo: ModoInterativa;
  /** por que caiu no fallback — vai pra tela e pro relato de quem enviou */
  motivo: string | null;
};

/**
 * COMO esta pergunta vai sair neste canal.
 *
 * `fonte` e a do registro de canais (lib/canais.ts). O fallback NUNCA e
 * silencioso: `motivo` e obrigatorio quando o modo nao e nativo, e a tela mostra
 * antes de enviar.
 */
export function planoDeEnvio(
  fonte: string,
  tipo: TipoInterativa,
  ctx: { grupo?: boolean } = {}
): PlanoInterativa {
  if (fonte === "gupshup") {
    // API oficial da Meta: os dois formatos sao cidadaos de primeira classe
    // (`type:"quick_reply"` e `type:"list"` na doc da Gupshup).
    return { modo: "nativo", motivo: null };
  }
  if (fonte === "zapi") {
    if (tipo === "botoes") {
      return {
        modo: "texto_numerado",
        motivo:
          "neste numero (WhatsApp comum, nao a API oficial) os BOTOES sao instaveis — a propria doc da Z-API " +
          "avisa que mensagens com botoes vem falhando. A pergunta vai como texto numerado pra nao sair quebrada; " +
          "pra botao de verdade, use o numero da API oficial.",
      };
    }
    if (ctx.grupo) {
      return {
        modo: "texto_numerado",
        motivo: "lista de opcoes nao funciona em GRUPO neste numero (limitacao declarada pela Z-API) — vai como texto numerado.",
      };
    }
    return { modo: "nativo", motivo: null };
  }
  // Evolution e qualquer fonte nova: nada de interativa cabeado aqui. Fallback
  // honesto, e o motivo diz o que falta — nunca "o provedor nao suporta", que
  // seria afirmar coisa que nao foi medida.
  return {
    modo: "texto_numerado",
    motivo: `envio interativo nao esta cabeado pra canal de fonte "${fonte}" — a pergunta vai como texto numerado.`,
  };
}

// ————————————————————————————————————————————————————— as renderizacoes

/**
 * A pergunta como TEXTO NUMERADO — e o que de fato vai pro cliente no fallback
 * (criterio do card: "recebe a mesma pergunta como texto numerado, sem quebrar
 * o fluxo").
 *
 * `instrucao: false` produz a versao pro REGISTRO (o que vai na bolha do
 * painel), sem a linha "responda com o numero" — no modo nativo o cliente
 * apertou um botao, e mandar a tela dizer que ele deveria digitar um numero
 * seria descrever um atendimento que nao aconteceu.
 */
export function textoNumerado(msg: Interativa, opts: { instrucao?: boolean } = {}): string {
  const partes: string[] = [];
  if (msg.titulo) partes.push(`*${msg.titulo}*`);
  partes.push(msg.texto);
  const linhas = msg.opcoes.map((o, i) => {
    const cabeca = `${i + 1}. ${o.titulo}`;
    return o.descricao ? `${cabeca}\n   ${o.descricao}` : cabeca;
  });
  partes.push(linhas.join("\n"));
  if (msg.rodape) partes.push(msg.rodape);
  if (opts.instrucao !== false) {
    partes.push(
      msg.opcoes.length === 2
        ? "Responda com 1 ou 2."
        : `Responda com o numero da opcao (1 a ${msg.opcoes.length}).`
    );
  }
  // Corte defensivo. Os tetos de `validarInterativa` (1024 + 60 + 60 +
  // 10x(24+72)) nao alcancam 4096, entao isto nao morde hoje — existe pra o dia
  // em que um teto subir e ninguem lembrar do teto de /api/send.
  return partes.join("\n\n").slice(0, LIMITE_TEXTO_SAIDA);
}

/**
 * O que fica GRAVADO em `mensagens.conteudo`.
 *
 * As opcoes entram no registro mesmo no modo nativo, e isso e requisito de
 * operacao, nao enfeite: a bolha do painel nao desenha botao, e sem as opcoes o
 * atendente leria a resposta do cliente ("Segunda-feira", ou pior, "2") sem
 * saber o que foi oferecido. Guardar so a pergunta esconderia metade da
 * conversa de quem vai atender.
 */
export function resumoDoEnviado(msg: Interativa, modo: ModoInterativa): string {
  const corpo = textoNumerado(msg, { instrucao: modo === "texto_numerado" });
  if (modo === "texto_numerado") return corpo;
  const selo = msg.tipo === "botoes" ? "[botoes de resposta rapida]" : "[lista de opcoes]";
  return `${selo}\n${corpo}`;
}

/**
 * O valor de `mensagens.tipo`.
 *
 * VOCABULARIO DELIBERADAMENTE IGUAL AO DO IMPORTADOR: `interactive_quick_reply`
 * e `interactive_list` sao os tipos que `scripts/importar/chatguru.mjs` ja
 * reconhece no acervo (349 e 26 mensagens medidas na conta). Inventar um nome
 * novo aqui faria a MESMA coisa ter dois nomes no banco, e qualquer contagem por
 * tipo passaria a mentir.
 *
 * No fallback o tipo e `text`, porque foi literalmente um texto que saiu —
 * gravar "interactive" numa mensagem que foi texto numerado faria a galeria e o
 * relatorio afirmarem um recurso que o cliente nunca viu.
 */
export function tipoDeMensagem(msg: Interativa, modo: ModoInterativa): string {
  if (modo === "texto_numerado") return "text";
  return msg.tipo === "botoes" ? "interactive_quick_reply" : "interactive_list";
}

/**
 * Previa curta pra lista de conversas (o `last_message_preview`).
 *
 * O MODO E OBRIGATORIO (correcao da revisao cega): no fallback saiu TEXTO
 * NUMERADO, e rotular de "[botoes]" faria a sidebar prometer um recurso que o
 * cliente nao recebeu — a mesma mentira que `tipoDeMensagem` evita ao gravar
 * `text` no banco. Duas fontes contando historias diferentes sobre a MESMA
 * mensagem e pior que nao ter rotulo nenhum.
 */
export function previaDoEnviado(msg: Interativa, modo: ModoInterativa): string {
  const rotulo = modo === "texto_numerado" ? "[pergunta]" : msg.tipo === "botoes" ? "[botoes]" : "[lista]";
  return `${rotulo} ${msg.texto}`.slice(0, 140);
}

// ——————————————————————————————————————————————————— envelopes de provedor
//
// Os dois montadores ficam AQUI (puros, provaveis em node solto) e os arquivos
// de provedor so fazem o POST. Se o envelope morasse dentro do `fetch`, a unica
// forma de prova seria rede — e a prova viraria "confia".

/** Corpo do `message` da Gupshup (`type: "quick_reply"` | `"list"`). */
export function envelopeGupshup(msg: Interativa): Record<string, unknown> {
  if (msg.tipo === "botoes") {
    return {
      type: "quick_reply",
      content: {
        type: "text",
        ...(msg.titulo ? { header: msg.titulo } : {}),
        text: msg.texto,
        ...(msg.rodape ? { caption: msg.rodape } : {}),
      },
      // `postbackText` = o titulo: e o que volta no inbound, e igualar os dois
      // faz a resposta do botao ser indistinguivel de alguem digitando a opcao —
      // que e exatamente o que o card pede ("roteado como mensagem normal").
      options: msg.opcoes.map((o) => ({ type: "text", title: o.titulo, postbackText: o.titulo })),
    };
  }
  return {
    type: "list",
    ...(msg.titulo ? { title: msg.titulo } : {}),
    body: msg.texto,
    ...(msg.rodape ? { footer: msg.rodape } : {}),
    globalButtons: [{ type: "text", title: msg.botao_lista || "Ver opcoes" }],
    // UMA secao. Secao e agrupamento visual, e o formato canonico daqui nao tem
    // grupo de opcoes — inventar um exigiria o campo no formato, e formato novo
    // e decisao de quem e dono do schema de fluxo, nao desta funcao.
    items: [
      {
        title: msg.titulo || "Opcoes",
        options: msg.opcoes.map((o) => ({
          type: "text",
          title: o.titulo,
          ...(o.descricao ? { description: o.descricao } : {}),
          postbackText: o.titulo,
        })),
      },
    ],
  };
}

/** Corpo do `send-option-list` da Z-API (so LISTA; botao nao passa por aqui). */
export function envelopeZapiLista(msg: Interativa): Record<string, unknown> {
  return {
    // A Z-API manda o corpo em `message` e o cabecalho dentro de
    // `optionList.title`. Rodape nao existe nesse envelope: em vez de descartar
    // em silencio, ele desce colado no corpo — texto que o cliente le e melhor
    // que texto que evapora.
    message: msg.rodape ? `${msg.texto}\n\n${msg.rodape}` : msg.texto,
    optionList: {
      title: msg.titulo || "Opcoes",
      buttonLabel: msg.botao_lista || "Ver opcoes",
      options: msg.opcoes.map((o, i) => ({
        // `id` estavel e legivel: e ele que volta em `selectedRowId`. Sem id, a
        // unica pista da escolha seria o titulo — e titulo muda quando alguem
        // edita o menu.
        id: String(i + 1),
        title: o.titulo,
        ...(o.descricao ? { description: o.descricao } : {}),
      })),
    },
  };
}

// ————————————————————————————————————————————————— o RECEBIMENTO da resposta
//
// A resposta do cliente tem que chegar ao painel como MENSAGEM NORMAL (criterio
// do card). Nao ha bolha especial e nao deve haver: pra quem atende, "ele
// escolheu Segunda-feira" e uma frase, independente de ter vindo de um toque ou
// da digitacao.

export type RespostaInterativa = { texto: string; id: string | null } | null;

/**
 * A escolha do cliente num payload Z-API (`ReceivedCallback`).
 *
 * As chaves vem da doc oficial (conferida em 31/08/2026, pagina "Exemplos de
 * retorno"): `listResponseMessage {message, title, selectedRowId,
 * selectedRowTitle}` e `buttonsResponseMessage {buttonId, message}`.
 *
 * `buttonsResponseMessage` e lido mesmo com o painel nao ENVIANDO botoes por
 * este canal: o numero pode receber botao de outro sistema (no acervo da conta
 * existe bot de terceiro no mesmo numero — ver CLAUDE.md), e nesse caso a
 * escolha chegava como "[mensagem]" na bolha.
 */
export function respostaZapi(p: any): RespostaInterativa {
  const lista = p?.listResponseMessage;
  if (lista) {
    const t = texto(lista.selectedRowTitle) || texto(lista.message) || texto(lista.title);
    if (t) return { texto: t, id: texto(lista.selectedRowId) || null };
  }
  const botao = p?.buttonsResponseMessage;
  if (botao) {
    const t = texto(botao.message);
    if (t) return { texto: t, id: texto(botao.buttonId) || null };
  }
  return null;
}
