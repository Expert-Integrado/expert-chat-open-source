// TEMPLATES DA API OFICIAL, POR NUMERO — REGRA PURA (card 86ak858pa).
//
// Zero import de proposito (como lib/canal-conexao.ts e lib/escopo-chave.ts):
// roda no Next e em node solto — `node scripts/prova-canais-conexao.ts`.
//
// O QUE ESTE ARQUIVO E, E O QUE ELE NAO E
//
// Na API Oficial, iniciar conversa fora da janela de 24h exige template APROVADO
// PELA META, e a aprovacao e por NUMERO REMETENTE — nao por conta. Por isso o
// catalogo pertence ao CANAL: dois numeros Gupshup na mesma instalacao tem listas
// diferentes, e mandar o template do numero A pelo numero B e recusa garantida.
//
// A REGRA E PORTADA, NAO INVENTADA. As validacoes e a leitura do template cru vem
// do Meeting Hub (repo `agenda-hub`), onde cada uma delas custou uma reprovacao
// da Meta ou um 4xx do Gupshup em conta real:
//   src/shared/lib/gupshup-template-rules.ts  (validacao de criacao)
//   src/shared/lib/gupshup-template-parse.ts  (o corpo LIMPO vem de containerMeta)
//   src/shared/lib/broadcast/gupshup-send.ts  (o 202 sem messageId e FALHA)
// Reescrever isso na mao aqui seria repetir as reprovacoes uma a uma. O que muda
// nesta porta: o catalogo e por canal, e o painel guarda um espelho local pra
// poder BARRAR envio antes de gastar chamada no provedor.

// ————————————————————————————————————————————————————————————— estado
//
// Quem aprova esta do lado de fora (Meta). O painel nunca decide status: ele
// LE do provedor e traduz. `desconhecido` existe porque a lista de status da Meta
// cresce — status novo nao pode virar "aprovado" por descuido de mapeamento.
export const STATUS_TEMPLATE = ["aprovado", "em_analise", "recusado", "pausado", "desconhecido"] as const;
export type StatusTemplate = (typeof STATUS_TEMPLATE)[number];

/**
 * Status cru do provedor -> vocabulario do painel.
 *
 * FAIL-CLOSED: o que nao esta no mapa cai em `desconhecido`, e `desconhecido` NAO
 * envia (ver `podeEnviarTemplate`). O contrario — tratar desconhecido como
 * aprovado — trocaria "o painel recusou, sincronize" por "a Meta recusou, e a
 * nota de qualidade do seu WABA caiu".
 */
export function statusCanonico(bruto: unknown): StatusTemplate {
  const s = String(bruto ?? "").trim().toUpperCase();
  if (s === "APPROVED" || s === "ENABLED" || s === "ACTIVE") return "aprovado";
  if (s === "PENDING" || s === "SUBMITTED" || s === "IN_APPEAL" || s === "PENDING_DELETION") {
    return "em_analise";
  }
  if (s === "REJECTED" || s === "FAILED" || s === "DISABLED") return "recusado";
  if (s === "PAUSED" || s === "FLAGGED") return "pausado";
  return "desconhecido";
}

/**
 * Saneador de SAIDA: o valor que o BANCO guarda ja esta no vocabulario do painel.
 *
 * Existe separado de `statusCanonico` de proposito, e a distincao nao e frescura:
 * `statusCanonico("aprovado")` cai em `desconhecido` (ele espera o cru da Meta,
 * em maiuscula), e usar o saneador errado na volta apagaria a aprovacao de TODO
 * template do catalogo — todo envio por template da instalacao passaria a ser
 * recusado. Duas direcoes, dois saneadores.
 */
export function statusDoBanco(bruto: unknown): StatusTemplate {
  const s = String(bruto ?? "").trim().toLowerCase();
  return (STATUS_TEMPLATE as readonly string[]).includes(s) ? (s as StatusTemplate) : "desconhecido";
}

export const ROTULO_STATUS: Record<StatusTemplate, string> = {
  aprovado: "aprovado",
  em_analise: "em analise na Meta",
  recusado: "recusado",
  pausado: "pausado pela Meta",
  desconhecido: "estado desconhecido",
};

export type TemplateCanal = {
  /** id do template no provedor — e ele que vai no envio, nao o nome */
  provider_id: string;
  /** elementName: minusculas, numeros e _ */
  nome: string;
  idioma: string;
  categoria: string;
  status: StatusTemplate;
  /** corpo LIMPO (sem rodape e sem a especificacao dos botoes) */
  corpo: string;
  exemplo: string;
  /** quantas variaveis distintas o corpo usa */
  variaveis: number;
  rodape: string;
  /** "IMAGE" quando o template tem cabecalho de imagem */
  cabecalho: string;
  /** link da arte aprovada — OBRIGATORIO no envio de template de imagem */
  midia_url: string;
  motivo: string;
};

// —————————————————————————————————————————————————————— leitura do cru
/** Quantas variaveis distintas ({{1}}, {{2}}…) o texto usa. */
export function contarVariaveis(corpo: unknown): number {
  const t = String(corpo ?? "");
  return new Set((t.match(/\{\{\s*\d+\s*\}\}/g) ?? []).map((s) => s.replace(/\D/g, ""))).size;
}

/** Numeros de variavel usados, em ordem e sem repetir. */
export function variaveisDoCorpo(corpo: unknown): number[] {
  const achados = (String(corpo ?? "").match(/\{\{\s*\d+\s*\}\}/g) ?? []).map((s) =>
    Number(s.replace(/\D/g, ""))
  );
  return [...new Set(achados)].sort((a, b) => a - b);
}

/**
 * UM template cru do Gupshup -> `TemplateCanal`.
 *
 * O GOTCHA que decide a leitura (medido no app de producao do Meeting Hub em
 * 17/08/2026, 104 templates): o campo `data` do TOPO da resposta NAO e o corpo da
 * mensagem — e uma serializacao do template inteiro, com o rodape e a
 * especificacao dos botoes colados numa string
 * ("...texto | [Garantir minha vaga,https://...]"). De 104 templates, 25 tinham
 * `data` diferente do corpo real e 14 exibiam o markup cru como se fosse texto da
 * mensagem. O corpo LIMPO mora em `containerMeta.data`; o `data` do topo entra so
 * como ultimo recurso, pra template de formato antigo.
 *
 * `containerMeta` chega como STRING com JSON dentro, e cadastro corrompido nao
 * pode derrubar a listagem: o que nao der pra ler sai vazio.
 */
export function lerTemplateGupshup(bruto: unknown): TemplateCanal {
  const t = (bruto && typeof bruto === "object" ? bruto : {}) as Record<string, any>;
  let meta: any = null;
  try {
    meta = t.containerMeta ? JSON.parse(String(t.containerMeta)) : null;
  } catch {
    meta = null;
  }
  const corpo = String(meta?.data ?? meta?.body ?? t.data ?? "").trim();
  const cabecalho = String(t.templateType ?? meta?.templateType ?? "").toUpperCase();
  const ehImagem = cabecalho === "IMAGE";
  return {
    provider_id: String(t.id ?? t.templateId ?? "").trim(),
    nome: String(t.elementName ?? t.name ?? t.id ?? "").trim(),
    idioma: String(t.languageCode ?? t.language ?? "pt_BR").trim() || "pt_BR",
    categoria: String(t.category ?? "").trim(),
    status: statusCanonico(t.status),
    corpo,
    exemplo: String(meta?.sampleText ?? meta?.example ?? "").trim(),
    variaveis: contarVariaveis(corpo),
    rodape: String(meta?.footer ?? "").trim(),
    cabecalho,
    midia_url: ehImagem ? String(meta?.mediaUrl ?? meta?.sampleMedia ?? "").trim() : "",
    motivo: String(t.rejectedReason ?? t.reason ?? "").trim(),
  };
}

// ————————————————————————————————————————————— criacao (pre-validacao)
export type BotaoTemplate = { type: "URL" | "QUICK_REPLY"; text: string; url?: string };

export type NovoTemplate = {
  nome: string;
  categoria: "UTILITY" | "MARKETING" | "AUTHENTICATION";
  /** assunto interno exigido pelo Gupshup (nao aparece pro destinatario) */
  assunto: string;
  corpo: string;
  /** o mesmo corpo com as variaveis trocadas por valores reais (a Meta exige) */
  exemplo: string;
  idioma: string;
  rodape?: string;
  botoes?: BotaoTemplate[];
};

/**
 * Problemas do template ANTES de mandar pra aprovacao (vazio = pode mandar).
 *
 * Cada linha aqui e uma reprovacao da Meta que ja aconteceu de verdade no
 * Meeting Hub. Validar no formulario nao e capricho: template reprovado derruba
 * a nota de qualidade do WABA da empresa, e a nota mexe no limite de disparo.
 * A ordem importa — a primeira mensagem e a que a tela poe em destaque.
 */
export function validarNovoTemplate(t: Partial<NovoTemplate>): string[] {
  const erros: string[] = [];
  const nome = String(t.nome ?? "").trim();
  const corpo = String(t.corpo ?? "").trim();
  const exemplo = String(t.exemplo ?? "").trim();
  const assunto = String(t.assunto ?? "").trim();

  if (!nome) erros.push("De um nome ao template.");
  // o nome vai NA URL do DELETE do provedor: fora deste formato seria path traversal
  else if (!/^[a-z0-9_]+$/.test(nome)) {
    erros.push("O nome so aceita letras minusculas, numeros e underline (sem espacos nem acentos).");
  } else if (nome.length > 512) erros.push("Nome longo demais.");

  if (!["UTILITY", "MARKETING", "AUTHENTICATION"].includes(String(t.categoria ?? ""))) {
    erros.push("Escolha a categoria do template.");
  }
  if (!assunto) erros.push("Preencha o assunto do template (uso interno, nao aparece pro cliente).");
  if (!corpo) erros.push("Escreva o corpo da mensagem.");
  else if (corpo.length > 1024) erros.push("O corpo passa de 1024 caracteres — a Meta recusa.");

  const vars = variaveisDoCorpo(corpo);
  if (vars.length) {
    const enxuto = corpo.replace(/\s+/g, " ").trim();
    if (/^\{\{\s*\d+\s*\}\}/.test(enxuto)) {
      erros.push('A mensagem nao pode COMECAR com variavel — escreva um texto antes (ex.: "Ola, {{1}}").');
    }
    if (/\{\{\s*\d+\s*\}\}$/.test(enxuto)) {
      erros.push('A mensagem nao pode TERMINAR com variavel — escreva um texto depois (ex.: "{{1}}, ate logo!").');
    }
    const esperado = vars.map((_, i) => i + 1);
    if (vars.join(",") !== esperado.join(",")) {
      erros.push(
        `As variaveis devem ser numeradas em sequencia a partir de {{1}} — encontrei ${vars
          .map((v) => `{{${v}}}`)
          .join(", ")}.`
      );
    }
    if (!exemplo) {
      erros.push("Preencha o exemplo — e o corpo com as variaveis trocadas por valores de verdade.");
    } else if (variaveisDoCorpo(exemplo).length) {
      erros.push('O exemplo nao pode conter {{1}} — troque cada variavel por um valor real (ex.: "Ola, Maria").');
    } else if (!exemploBate(corpo, exemplo)) {
      erros.push(
        "O exemplo nao bate com a mensagem — ele precisa ser o MESMO texto, so com as variaveis trocadas por valores reais."
      );
    }
  }

  const botoes = Array.isArray(t.botoes) ? t.botoes : [];
  for (const [i, b] of botoes.entries()) {
    const rot = `Botao ${i + 1}`;
    if (!String(b?.text ?? "").trim()) erros.push(`${rot}: escreva o texto.`);
    else if (String(b.text).length > 25) erros.push(`${rot}: o texto passa de 25 caracteres.`);
    if (b?.type === "URL") {
      const url = String(b.url ?? "").trim();
      if (!url) erros.push(`${rot}: informe a URL.`);
      else if (!/^https?:\/\//i.test(url)) erros.push(`${rot}: a URL precisa comecar com http:// ou https://.`);
    }
  }
  if (botoes.length > 3) erros.push("No maximo 3 botoes por template.");

  const rodape = String(t.rodape ?? "").trim();
  if (rodape.length > 60) erros.push("O rodape passa de 60 caracteres — a Meta recusa.");
  if (rodape && variaveisDoCorpo(rodape).length) {
    erros.push("O rodape nao aceita variavel ({{1}}) — escreva um texto fixo.");
  }
  return erros;
}

/** Os trechos FIXOS do corpo aparecem no exemplo, na ordem? */
export function exemploBate(corpo: string, exemplo: string): boolean {
  const literais = String(corpo)
    .split(/\{\{\s*\d+\s*\}\}/)
    .map((s) => s.trim())
    .filter(Boolean);
  let pos = 0;
  return literais.every((seg) => {
    const i = exemplo.indexOf(seg, pos);
    if (i === -1) return false;
    pos = i + seg.length;
    return true;
  });
}

/** Sugere o exemplo trocando cada {{n}} por um valor genérico. */
export function sugerirExemplo(corpo: string): string {
  const amostras = ["Maria", "10/08/2026", "19:30", "sua empresa"];
  return String(corpo ?? "").replace(
    /\{\{\s*(\d+)\s*\}\}/g,
    (_m, n) => amostras[(Number(n) - 1) % amostras.length]
  );
}

/** Somente os botoes em formato conhecido — botao estranho nao derruba a lista. */
export function botoesValidos(bruto: unknown): BotaoTemplate[] {
  if (!Array.isArray(bruto)) return [];
  const out: BotaoTemplate[] = [];
  for (const b of bruto) {
    const type = String((b as any)?.type ?? "").toUpperCase();
    if (type !== "URL" && type !== "QUICK_REPLY") continue;
    const text = String((b as any)?.text ?? "").trim();
    if (!text) continue;
    out.push(type === "URL" ? { type, text, url: String((b as any)?.url ?? "").trim() } : { type, text });
  }
  return out.slice(0, 3);
}

// ————————————————————————————————————————————————————————— o envio
export type VereditoEnvio = { ok: true } | { ok: false; motivo: string };

/**
 * ESTA e a guarda que o card pede: "envio usando template nao aprovado e
 * recusado, com mensagem compreensivel" — e recusado ANTES da chamada ao
 * provedor.
 *
 * Por que barrar aqui, e nao deixar a Meta barrar: a recusa da Meta chega como
 * codigo, gasta chamada e (em template recusado/pausado) conta contra a nota de
 * qualidade do numero. Barrar antes custa zero e diz o que fazer.
 */
/**
 * A frase do "nao esta no catalogo", num lugar so.
 *
 * Ela e dita em DOIS pontos — aqui e no estreitamento de `decidirEnvioTemplate`,
 * que existe pro compilador. Duas copias da mesma frase divergem sozinhas (licao
 * da casa: o formato da assinatura tinha tres copias no repo).
 */
const FORA_DO_CATALOGO =
  "este template nao esta no catalogo deste numero — sincronize os templates do canal e tente de novo";

export function podeEnviarTemplate(t: TemplateCanal | null | undefined): VereditoEnvio {
  if (!t) return { ok: false, motivo: FORA_DO_CATALOGO };
  if (!t.provider_id) {
    return {
      ok: false,
      motivo: "este template nao tem identificador no provedor — sincronize os templates do canal",
    };
  }
  if (t.status === "aprovado") {
    // CABECALHO DE IMAGEM SEM O LINK DA ARTE = DROP SILENCIOSO (Frente Z).
    //
    // O gotcha ja estava escrito em `corpoEnvioTemplate`: template de imagem exige
    // o `message` com o link, e SEM ele o Gupshup responde 202 e a Meta descarta a
    // entrega em silencio. So que `corpoEnvioTemplate` apenas OMITE o campo quando
    // o link falta — o envio saía mesmo assim, voltava com `messageId`, e o painel
    // gravava na conversa uma mensagem que ninguem recebeu. Mesma familia do "202
    // sem messageId e FALHA": aceito na fila nao e entregue, e o pior desfecho e o
    // que nao acusa erro. `midia_url` vem do espelho e pode chegar vazia (o
    // provedor nem sempre devolve `mediaUrl`/`sampleMedia`), entao a recusa mora
    // aqui, antes da chamada.
    //
    // Fica DEPOIS do status de proposito: pra template recusado/pausado a frase
    // util e a da Meta, nao a do link.
    if (String(t.cabecalho ?? "").toUpperCase() === "IMAGE" && !String(t.midia_url ?? "").trim()) {
      return {
        ok: false,
        motivo:
          `o template "${t.nome}" tem uma imagem no cabecalho e o catalogo deste numero nao guardou o link da ` +
          "arte aprovada — sem esse link o WhatsApp aceita o envio e descarta a entrega sem avisar ninguem. " +
          "Sincronize os templates deste numero; se o link continuar faltando, ele precisa ser publicado no provedor.",
      };
    }
    return { ok: true };
  }
  const detalhe = t.motivo ? ` (${t.motivo.slice(0, 120)})` : "";
  if (t.status === "em_analise") {
    return {
      ok: false,
      motivo: `o template "${t.nome}" ainda esta em analise na Meta — so da pra usar depois da aprovacao`,
    };
  }
  if (t.status === "recusado") {
    return { ok: false, motivo: `o template "${t.nome}" foi recusado pela Meta${detalhe}` };
  }
  if (t.status === "pausado") {
    return {
      ok: false,
      motivo: `o template "${t.nome}" esta pausado pela Meta${detalhe} — ele volta a valer quando a Meta liberar`,
    };
  }
  return {
    ok: false,
    motivo: `nao sei o estado do template "${t.nome}" — sincronize os templates deste numero antes de usar`,
  };
}

/**
 * A numeracao das variaveis do corpo e USAVEL num envio? ({{1}}..{{N}}, sem pular)
 *
 * O DEFEITO QUE ISTO FECHA (medido em 31/08/2026, Frente Z): a validacao de envio
 * contava variaveis DISTINTAS. Um template aprovado com o corpo
 * "Ola {{1}}, sua consulta e dia {{3}}." conta 2, e um pedido com 2 parametros
 * passava. Mas o provedor casa os valores por POSICAO (`params: [a, b]` no corpo do
 * POST), e `renderizarTemplate` casa por NUMERO — entao o painel gravava na
 * conversa "Ola Eric, sua consulta e dia {{3}}." enquanto o segundo valor ia pra
 * outra variavel no lado da Meta. **Tela mentindo, sem erro em lugar nenhum** —
 * exatamente o caso que dói, porque nada falha.
 *
 * `validarNovoTemplate` ja exigia a sequencia na CRIACAO pela tela (bloco F da
 * prova). O que faltava era o ENVIO: template com buraco nao nasce aqui, ele
 * CHEGA — criado no console do Gupshup, importado de outra ferramenta, ou linha
 * escrita a mao no espelho — e o envio e o caminho que a chave de API, o fluxo e
 * qualquer integracao usam.
 *
 * Numeracao contigua a partir de {{1}} e o que faz NUMERO == POSICAO: com ela,
 * `renderizarTemplate` (por numero) e `corpoEnvioTemplate` (por posicao) sao a
 * MESMA leitura, e o que o painel grava e o que o cliente le.
 */
export type VereditoNumeracao = { ok: true; variaveis: number } | { ok: false; motivo: string };

/**
 * TETO DAS VARIAVEIS — o mesmo 50 do CHECK da migration 0023
 * (`ck_canal_templates_variaveis`) e do `Math.min(..., 50)` de `salvarTemplates`.
 *
 * ELE EXISTE AQUI POR UM MOTIVO MEDIDO (2a revisao cega da Frente Z): esta funcao
 * trocou a AUTORIDADE da contagem — antes era a coluna `variaveis` (inteiro, com
 * teto nos dois lados), agora e uma varredura do texto livre do `corpo`, que a
 * 0023 declara `text not null default ''` SEM check de conteudo. O teto nao veio
 * junto, e o numero dentro de `{{...}}` virava o limite de um laco: um corpo com
 * `{{20000000}}` (linha escrita a mao no espelho, ou importada) fazia esta funcao
 * montar 20 milhoes de itens e uma string `motivo` de 256 MB, travando o event
 * loop do painel; com `{{40000000}}`, `RangeError: Invalid string length` NAO
 * TRATADA — e com heap folgado, o processo Node da instalacao MORRIA. A chamada
 * mora fora do `try` de `/api/send`, entao isso nao virava recusa: virava 500 ou
 * o painel inteiro caindo.
 *
 * NAO HA FALSO NEGATIVO — e o argumento NAO e o CHECK do banco (correcao da 3a
 * revisao cega; a frase anterior dizia "o espelho nem conseguiria gravar a coluna,
 * o CHECK da 0023 recusa", e isso e falso por DOIS motivos medidos):
 *
 *   1. o CHECK nunca dispara, porque o CLAMP vem antes dele — `salvarTemplates`
 *      (lib/canais-db.ts) grava `variaveis: Math.min(Math.max(t.variaveis, 0), 50)`,
 *      entao o Postgres so ve valor ja capado;
 *   2. e o corpo perigoso nem precisa de coluna alta: `{{1}} {{20000000}}` tem
 *      `contarVariaveis` = 2 e entra no espelho liso, pelo sync inclusive.
 *
 * O que sustenta a ausencia de falso negativo e o OUTRO argumento, e ele basta: a
 * Meta nao aprova template com mais de 50 variaveis, entao corpo que passa de 50 e
 * cadastro impossivel — e ele chega aqui exatamente pelas rotas que o paragrafo
 * acima ja nomeia (linha escrita a mao no espelho, importador de outra ferramenta).
 * Template legitimo passa — a prova exercita as 50 contiguas, e so 51 e recusado —
 * e o impossivel e RECUSADO com frase curta em vez de derrubar o processo.
 */
export const MAX_VARIAVEIS_TEMPLATE = 50;

/**
 * Lista de variaveis PRA FRASE, com teto proprio.
 *
 * A frase de erro nao pode crescer com o corpo: `motivo` viaja pro JSON da rota,
 * pro log e pra tela. Oito e o suficiente pra alguem consertar o texto — o resto
 * vira contagem.
 */
const VARS_NA_FRASE = 8;
function listarVars(ns: readonly number[]): string {
  const cabe = ns
    .slice(0, VARS_NA_FRASE)
    .map((n) => `{{${n}}}`)
    .join(", ");
  return ns.length > VARS_NA_FRASE ? `${cabe} ... (${ns.length} no total)` : cabe;
}

export function numeracaoDoCorpo(corpo: unknown): VereditoNumeracao {
  const vars = variaveisDoCorpo(corpo);
  if (!vars.length) return { ok: true, variaveis: 0 };
  const fim = vars[vars.length - 1];
  const usadas = listarVars(vars);
  // O TETO VEM ANTES DO LACO, e essa ordem E a correcao: `fim` sai do texto livre
  // do espelho, e e ele que limita o `for` abaixo e o tamanho de `faltando`.
  if (fim > MAX_VARIAVEIS_TEMPLATE) {
    return {
      ok: false,
      motivo:
        `a numeracao das variaveis esta furada — ele usa ${usadas}, e {{${fim}}} passa do limite de ` +
        `${MAX_VARIAVEIS_TEMPLATE} variaveis que a Meta aprova (e que o catalogo deste painel grava). ` +
        "Corrija o texto do template na Meta (as variaveis tem que ser {{1}}, {{2}}, {{3}}... sem pular, " +
        `no maximo ate {{${MAX_VARIAVEIS_TEMPLATE}}}) e sincronize os templates deste numero.`,
    };
  }
  const faltando: number[] = [];
  for (let n = 1; n <= fim; n++) if (!vars.includes(n)) faltando.push(n);
  const foraDaFaixa = vars.some((v) => v < 1);
  if (!faltando.length && !foraDaFaixa) return { ok: true, variaveis: fim };
  const detalhe = foraDaFaixa
    ? `ele usa ${usadas}, e a contagem das variaveis comeca em {{1}}`
    : `ele usa ${usadas} e nao usa ${listarVars(faltando)}`;
  return {
    ok: false,
    motivo:
      `a numeracao das variaveis esta furada — ${detalhe}. ` +
      "Os valores entram na ordem em que voce digita, entao um deles cairia na variavel errada e a " +
      "conversa guardaria um texto diferente do que o cliente recebe. Corrija o texto do template na " +
      "Meta (as variaveis tem que ser {{1}}, {{2}}, {{3}}... sem pular) e sincronize os templates deste numero.",
  };
}

/**
 * POR QUE ESTE TEMPLATE NAO PODE SER ENVIADO — uma frase, ou `null` pra "pode".
 *
 * QUEM CONSOME: o catalogo da tela (`app/admin-canais.tsx`), pra cada linha. A
 * recusa nova nasceu so no caminho do envio, e o template com numeracao furada
 * continuava no catalogo pintado de `aprovado`, verdinho — o operador so descobria
 * quando a mensagem falhasse. Este painel ja condena esse padrao com todas as
 * letras pro `sincronizado_em` ("catalogo velho sem aviso e o mesmo defeito do QR
 * expirado sem aviso"): quem ESCOLHE o template tem que saber da recusa ANTES de
 * escolher.
 *
 * POR QUE E UMA FUNCAO, E NAO UMA EXPRESSAO NO JSX (3a revisao cega da Frente Z):
 * a primeira versao montava isto DENTRO do `map` da tela — a ordem dos dois passos,
 * o gate do `aprovado` e a escolha da frase moravam no componente, e a unica prova
 * possivel era varredura de fonte. Medido: TRES mutacoes passavam com a bateria
 * inteira verde (442 assercoes OK) — o selo atras de um `false &&`, o motivo
 * trocado por string vazia, e a ordem dos dois passos invertida (que faz a tela e a
 * rota contarem historias DIFERENTES pro template com dois defeitos). Regra no JSX
 * nao e exercitavel; funcao pura e. A licao e a mesma que esta frente ja pagou duas
 * vezes: *assertion que casa um nome sobrevive a mutacao; assertion que exercita o
 * fluxo, nao.*
 *
 * A ORDEM AQUI E A ORDEM DA ROTA, e ela e a propria regra: `podeEnviarTemplate`
 * primeiro (catalogo, id no provedor, status, imagem sem o link da arte) e a
 * numeracao depois — igual aos passos 3 e 4 de `decidirEnvioTemplate`, que devolve
 * 409 do status ANTES do 400 da numeracao.
 *
 * E POR ISSO NAO EXISTE UM `if (status === "aprovado")` AQUI: ele seria uma regra
 * PROPRIA da tela, e a promessa desta frente e que a tela nao tem nenhuma. O gate
 * ja esta dentro de `podeEnviarTemplate` — pra template `em_analise`, `recusado`,
 * `pausado` ou `desconhecido` ele devolve a frase do STATUS e a numeracao nem chega
 * a ser lida. Foi assim que a versao no JSX errou: la o `numeracaoDoCorpo(t.corpo)`
 * ficou FORA do gate, e um template `em_analise` com numeracao furada fazia a tela
 * dizer "a numeracao das variaveis esta furada" enquanto a rota diria "ainda esta
 * em analise na Meta".
 *
 * O bloco P.6 da prova nao acredita nesta prosa: ele exercita esta funcao contra
 * fixtures e compara a frase com a que `decidirEnvioTemplate` devolveria pro MESMO
 * template.
 */
export function motivoParaNaoEnviarTemplate(t: TemplateCanal): string | null {
  const envio = podeEnviarTemplate(t);
  if (!envio.ok) return envio.motivo;
  const num = numeracaoDoCorpo(t.corpo);
  return num.ok ? null : num.motivo;
}

/** O template como a rota `/api/canais/templates` devolve pra tela. */
export type TemplateNoCatalogo = TemplateCanal & { rotulo_status?: string };

/** Um paragrafo da linha do catalogo. `tom` escolhe a cor; a tela nao decide nada. */
export type BlocoDaLinha = {
  chave: string;
  tom: "corpo" | "motivo" | "recusa";
  /** rotulo em negrito na frente do texto ("" = sem rotulo) */
  rotulo: string;
  texto: string;
};

/** Uma linha do catalogo, JA DECIDIDA — a tela so desenha isto. */
export type LinhaDoCatalogo<T extends TemplateCanal = TemplateCanal> = {
  chave: string;
  nome: string;
  /** "pt_BR · UTILITY · 2 variavel(is) · com imagem" */
  detalhe: string;
  status: StatusTemplate;
  rotulo: string;
  /** o motivo da recusa, ou `null` — a MESMA frase que a rota devolveria */
  selo: string | null;
  blocos: BlocoDaLinha[];
  template: T;
};

/**
 * O CATALOGO DA TELA COMO DADO — a decisao de renderizacao sai do JSX.
 *
 * POR QUE ISTO EXISTE (4a revisao cega da Frente Z). O selo ja era funcao pura
 * (`motivoParaNaoEnviarTemplate`), mas quem decidia o que DESENHAR com ela era o
 * `map` do componente, e regra dentro de JSX nao e exercitavel em node solto: a
 * unica prova possivel era varredura do fonte da tela, e varredura de fonte foi o
 * que esta onda inteira vem pagando. Agora a linha inteira nasce aqui — nome,
 * detalhe, rotulo do status, selo e os paragrafos — e a tela vira um desenhista:
 * `linhasDoCatalogo(lista).map(...)` e dentro dela `linha.blocos.map(...)`, sem um
 * unico `if` de regra.
 *
 * O QUE ISSO COMPRA, e o que NAO compra (declarado, pra ninguem achar que fechou
 * mais do que fechou):
 *
 *   COMPRA — toda supressao ou troca do selo vira um `selo`/`blocos` diferente do
 *   esperado, e a prova (bloco P.6) pega por COMPORTAMENTO, contra fixtures,
 *   comparando com o que `decidirEnvioTemplate` responderia pro mesmo template.
 *
 *   NAO COMPRA — o desenho em si. Nenhuma prova deste repo renderiza React (o
 *   harness roda `node --experimental-strip-types`, que nem parseia JSX), entao
 *   alguem que ESCREVA uma decisao nova dentro do JSX continua fora do alcance por
 *   comportamento. Isso e regressao implausivel (ver "Modelo de ameaca" no
 *   CLAUDE.md) e o que resta e uma varredura curta, declarada como tal.
 *
 * A MUDANCA VISUAL, NOMEADA (4a revisao cega — antes disso a reversao estava
 * implicita, e o comentario que ela contradiz era explicito). A 1a versao do selo
 * tinha um gate proprio na tela e o comentario dizia com todas as letras: *"e so
 * pra template `aprovado`, porque em analise/recusado/pausado a frase util e a do
 * selo de status, que ja esta ali do lado"*. Esse gate SAIU na 3a revisao — ele era
 * a regra propria da tela que fazia tela e rota contarem historias diferentes pro
 * mesmo template —, e o efeito visual e este: TODO template `em_analise`,
 * `recusado`, `pausado` e `desconhecido` ganha a caixa vermelha, repetindo em prosa
 * o que o rotulo de status diz em duas palavras na mesma linha.
 *
 * ISSO E DELIBERADO, e o argumento e uma invariante que o operador pode aprender:
 * *caixa vermelha existe se e so se a rota recusaria o envio* — logo, AUSENCIA de
 * caixa significa "da pra enviar". Suprimir a caixa em alguns status torna a
 * ausencia ambigua (ou envia, ou nao envia por um motivo que a tela escondeu), que
 * e a propria classe de defeito desta frente (*catalogo velho sem aviso*). O rotulo
 * curto diz o ESTADO; a caixa diz a CONSEQUENCIA, que o rotulo nao diz.
 *
 * O QUE NAO SE REPETE E O `motivo:` DA META: quando a frase do selo ja carrega o
 * motivo que a Meta devolveu (template `recusado`/`pausado`, onde
 * `podeEnviarTemplate` cola o `(motivo)` na frase), o paragrafo `motivo:` separado
 * nao aparece — seria a mesma frase duas vezes na mesma linha. Se o motivo for
 * longo o bastante pra a frase do selo o ter truncado (corte em 120 chars), os dois
 * aparecem: a direcao segura e mostrar demais, nunca esconder o que a Meta disse.
 * A deduplicacao mora AQUI, e nao no JSX, de proposito: e nesta funcao que tela e
 * rota concordam em 17/17 estados, e um `if` na tela reabriria a divergencia que a
 * 3a revisao fechou. O `selo` em si NUNCA e suprimido — so o paragrafo redundante.
 */
export function linhasDoCatalogo<T extends TemplateNoCatalogo>(
  lista: readonly T[] | null | undefined
): LinhaDoCatalogo<T>[] {
  const bruta: readonly T[] = Array.isArray(lista) ? (lista as readonly T[]) : [];
  return bruta.map((t) => {
    const selo = motivoParaNaoEnviarTemplate(t);
    const corpo = String(t.corpo ?? "");
    const motivo = String(t.motivo ?? "").trim();
    const blocos: BlocoDaLinha[] = [];
    if (corpo) blocos.push({ chave: "corpo", tom: "corpo", rotulo: "", texto: corpo });
    if (motivo && !(selo ?? "").includes(motivo)) {
      blocos.push({ chave: "motivo", tom: "motivo", rotulo: "motivo:", texto: motivo });
    }
    if (selo) blocos.push({ chave: "recusa", tom: "recusa", rotulo: "Nao pode ser enviado:", texto: selo });
    const detalhe = [
      String(t.idioma ?? ""),
      String(t.categoria ?? ""),
      `${t.variaveis} variavel(is)`,
      String(t.cabecalho ?? "").toUpperCase() === "IMAGE" ? "com imagem" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      chave: `${t.nome}@${t.idioma}`,
      nome: t.nome,
      detalhe,
      status: t.status,
      rotulo: t.rotulo_status || ROTULO_STATUS[t.status],
      selo,
      blocos,
      template: t,
    };
  });
}

/**
 * Os parametros batem com o template? (numeracao usavel, quantidade exata, nada vazio)
 *
 * Parametro a menos faz a Meta recusar; parametro a mais e ignorado em silencio,
 * e ai a mensagem sai com o texto errado — o segundo caso e o que mais dói,
 * porque nao vira erro em lugar nenhum.
 *
 * A CONTAGEM SAI DO `corpo`, NAO DA COLUNA `variaveis` — e isso e decisao. O
 * `corpo` e o texto que `renderizarTemplate` transforma no que o painel GRAVA na
 * conversa; a coluna `variaveis` e um derivado gravado no espelho (`salvarTemplates`
 * ainda a limita em 50, e linha escrita a mao nao passa pelo sync). Autorizar N
 * parametros por um numero e renderizar por outro texto e como as duas leituras do
 * mesmo corpo que a 3a revisao da Frente U pagou: **quem autoriza tem que ler a
 * MESMA coisa que quem executa.**
 *
 * E O TETO VEIO JUNTO com a autoridade: trocar um inteiro limitado nos dois lados
 * (0..50 no `Math.min` do sync e no CHECK da 0023) por uma varredura de TEXTO LIVRE
 * sem levar o limite foi o GRAVE da 2a revisao desta frente — `numeracaoDoCorpo`
 * agora recusa acima de `MAX_VARIAVEIS_TEMPLATE`, que e o mesmo 50.
 */
export function validarParametros(t: TemplateCanal, params: unknown): { ok: true; params: string[] } | { ok: false; motivo: string } {
  const lista = Array.isArray(params) ? params.map((p) => String(p ?? "")) : [];
  const num = numeracaoDoCorpo(t.corpo);
  if (!num.ok) {
    return { ok: false, motivo: `o template "${t.nome}" nao pode ser enviado: ${num.motivo}` };
  }
  if (lista.length !== num.variaveis) {
    return {
      ok: false,
      motivo:
        num.variaveis === 0
          ? `o template "${t.nome}" nao tem variaveis — nao mande parametros`
          : `o template "${t.nome}" tem ${num.variaveis} variavel(is) e recebeu ${lista.length}`,
    };
  }
  const vazio = lista.findIndex((p) => !p.trim());
  if (vazio >= 0) {
    return { ok: false, motivo: `o valor da variavel {{${vazio + 1}}} esta vazio` };
  }
  // quebra de linha e tabulacao em parametro fazem a Meta recusar o envio inteiro
  const quebra = lista.findIndex((p) => /[\r\n\t]/.test(p));
  if (quebra >= 0) {
    return {
      ok: false,
      motivo: `o valor da variavel {{${quebra + 1}}} tem quebra de linha — a Meta recusa parametro com quebra de linha`,
    };
  }
  return { ok: true, params: lista };
}

/**
 * O texto COMO O CLIENTE VAI RECEBER — pra gravar na conversa e pra pre-visualizar.
 *
 * A mensagem que sai pelo template nao passa pela assinatura do atendente
 * (`textoComAssinatura`): template aprovado nao se altera, e mexer no texto e
 * exatamente o que a Meta recusa. O que o painel grava tem que ser o que chegou.
 */
export function renderizarTemplate(corpo: unknown, params: readonly string[] = []): string {
  return String(corpo ?? "").replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => {
    const v = params[Number(n) - 1];
    return v === undefined ? m : v;
  });
}

/**
 * Corpo do POST de envio de template (form-urlencoded), PURO pra ser provado sem rede.
 *
 * A regra que nao pode se perder (memory `gupshup-template-api` do Meeting Hub,
 * custou horas): template com CABECALHO DE IMAGEM exige tambem
 * `message={"type":"image","image":{"link": ...}}`. Sem o link, o Gupshup responde
 * 202 (aceito) e a Meta DROPA a entrega EM SILENCIO — ninguem recebe nada e o
 * relatorio diz "enviado". E o inverso tambem quebra: mandar `message` de imagem
 * em template de TEXTO faz a Meta recusar o envio inteiro.
 */
export function corpoEnvioTemplate(
  cfg: { source: string; appName?: string },
  destino: string,
  t: { provider_id: string; cabecalho?: string; midia_url?: string },
  params: readonly string[]
): URLSearchParams {
  const form = new URLSearchParams({
    channel: "whatsapp",
    source: String(cfg.source),
    destination: String(destino),
    template: JSON.stringify({ id: t.provider_id, params: [...params] }),
  });
  if (cfg.appName) form.set("src.name", cfg.appName);
  const link = String(t.midia_url ?? "").trim();
  if (String(t.cabecalho ?? "").toUpperCase() === "IMAGE" && link) {
    form.set("message", JSON.stringify({ type: "image", image: { link } }));
  }
  return form;
}

/**
 * A resposta do Gupshup virou mensagem, ou nao?
 *
 * 202 SEM `messageId` e FALHA. 202 quer dizer "aceito na fila", nao "entregue", e
 * sem messageId nao existe como conferir depois se virou mensagem — contar isso
 * como sucesso ja fez relatorio de campanha mentir (Meeting Hub, 08/2026).
 */
export function lerRespostaEnvio(status: number, corpo: unknown): { ok: true; messageId: string } | { ok: false; motivo: string } {
  const messageId = String((corpo as any)?.messageId ?? "").trim();
  if (status >= 200 && status < 300 && messageId) return { ok: true, messageId };
  if (status >= 200 && status < 300) {
    return { ok: false, motivo: `Gupshup ${status} sem messageId (aceito na fila, nao enviado)` };
  }
  const msg = String((corpo as any)?.message ?? (corpo as any)?.error ?? "").trim();
  return { ok: false, motivo: `Gupshup ${status}${msg ? `: ${msg.slice(0, 120)}` : ""}` };
}

// ——————————————————————————————— a DECISAO do envio por template
//
// Isto era um bloco de `if`s dentro de `app/api/send/route.ts`, e a unica prova
// que existia dele era varredura de fonte: "a rota MENCIONA `podeEnviarTemplate`"
// e "o indexOf do gate vem antes do indexOf do envio". A licao da casa e velha e
// custou tres revisoes na Frente U — *assertion que casa um nome sobrevive a
// mutacao (o nome vive no `import`); assertion que exercita o fluxo, nao* — e a
// decisao mais consequente desta rota (mandar ou nao mandar pra Meta, com que
// texto) estava fora do alcance de qualquer prova sem Next.
//
// Agora a decisao inteira e PURA e exercitavel em node solto, e o envio so aceita
// o que saiu dela: `enviarTemplateProvado` recebe `EnvioTemplateProvado`, e o
// `new EnvioProvado` acontece SO nos quatro passos aqui embaixo — nao ha outro
// construtor neste arquivo, e a classe nao e exportada. Isso e a fiacao do CODIGO,
// nao uma trava: quem escreve `as`, `any`, `Object.assign` sobre o prototipo ou
// `JSON.parse` fabrica um sem passar por passo nenhum, e o paragrafo medido logo
// abaixo mostra os quatro caminhos. O absoluto "o unico jeito de nascer um e passar
// pelos quatro passos" estava aqui e era falso; o que vale e a linha do fim deste
// bloco — **o tipo e sinalizacao forte, nao fechadura**.
//
// ATE ONDE O COMPILADOR VAI — MEDIDO, nao afirmado. A coluna "classe #privada" foi
// RE-MEDIDA na 3a revisao cega (`tsc --strict`, um arquivo por caso, fora do repo,
// contra este fonte); a coluna "marca por symbol" e o estado anterior, medido na 2a
// (commit f035ded) e nao reproduzivel hoje — aquele desenho nao existe mais aqui.
//
//   caso                                                 marca por symbol | classe #privada
//   (A) literal com os campos do construtor, SEM `as`         TS2741      |     TS2739
//   (A') o mesmo literal, mas TAMBEM com `provado: true`         —        |     TS2741
//   (B) `{ ...provado, texto: alvo.corpo }`, SEM `as`         COMPILA     |     TS2739
//   (C) o mesmo spread COM `as`                               COMPILA     |     COMPILA
//   (D) literal na mao COM `as`                               COMPILA     |     COMPILA
//   (E) `{} as EnvioTemplateProvado`                          COMPILA     |     COMPILA
//   (F) `Object.assign(Object.create(getPrototypeOf(p)), p, { texto })`  —|     COMPILA
//   (G) `JSON.parse(JSON.stringify({ ...p, texto: cru }))`       —        |     COMPILA
//   (H) o mesmo objeto atravessando uma variavel `any`           —        |     COMPILA
//
// TS2739 e TS2741 sao A MESMA RECUSA com contagem diferente — 2741 e "falta a
// propriedade '#provado'", 2739 e "faltam '#provado' e 'provado'" (o getter). Qual
// dos dois sai depende so de quanto o literal copiou; os dois BARRAM, e a correcao
// desta linha e da 3a revisao: a tabela dizia TS2741 na coluna nova pros casos (A) e
// (B), e o medido nos dois e TS2739.
//
// O CODIGO DEPENDE DA FORMA DA TENTATIVA, e a tabela acima mede uma so (4a revisao
// cega). Os numeros de todas as linhas sao os da forma "variavel ANOTADA"
// (`const x: EnvioTemplateProvado = ...`). Forjado DIRETO no argumento da chamada —
// que e o formato do call site real, `enviarTemplateProvado(creds, destino, {...},
// postar)` — o mesmo literal e o mesmo spread saem como **TS2345** ("argument of
// type ... is not assignable"). Medido nos quatro casos, 01/09/2026. **A RECUSA VALE
// NAS DUAS FORMAS; so a numeracao muda** — nao ha caminho novo aqui, so um numero
// diferente pra quem for conferir.
//
// O caso (B) e o perigoso e foi o que a marca por `unique symbol` deixava passar:
// o spread de um envio legitimo COPIA a propriedade da marca, entao trocar o
// `texto` pelo corpo CRU compilava limpo, sem `as` nenhum e sem nada pra alguem
// notar na revisao. A classe com campo privado (`#provado`) fecha (B), porque `#`
// nao viaja em spread.
//
// O QUE O COMPILADOR **NAO** ENTREGA, em nenhum dos dois desenhos: qualquer coisa
// que largue a checagem estrutural. `as` cede (a asserção de tipo e comparavel nas
// duas direcoes, e `{} as X` atravessa sempre); `any` cede; e (F) e (G) cedem sem
// escrever `as` em lugar nenhum — `Object.assign` sobre o PROTOTIPO do envio
// legitimo devolve algo que o `tsc` ja considera um `EnvioProvado`, e
// `JSON.parse` devolve `any`. **O tipo aqui e sinalizacao forte, nao fechadura** —
// e o `#` fecha o descuido (B), nao a intencao. O que fecha de verdade, e ONDE
// (corrigido na 4a revisao cega): os `params` que chegam ao provedor sao
// COMPORTAMENTO — o bloco P.7 exercita `enviarTemplateProvado` com um postador
// falso e le o JSON que saiu. `textoEnviar` e `conteudo` seguem sendo asseracao de
// FORMA sobre o fonte da rota (bloco J), porque eles moram dentro do handler do
// Next e nenhuma prova deste repo o executa — isso esta declarado la, no bloco.

/**
 * Template + parametros que JA passaram por todos os passos: nome no formato,
 * template no catalogo DESTE canal, status `aprovado`, numeracao usavel e
 * parametros exatos. `texto` e o renderizado — o que o painel grava E o que o
 * cliente le, que com numeracao contigua sao a mesma coisa.
 *
 * A classe NAO e exportada de proposito: `new` so acontece dentro deste arquivo,
 * e so em `decidirEnvioTemplate`. O campo `#provado` nao e lido por ninguem — ele
 * existe pro COMPILADOR, e e o que faz o caso (B) da tabela acima parar.
 */
class EnvioProvado {
  readonly #provado = true;
  readonly alvo: TemplateCanal;
  readonly params: string[];
  readonly texto: string;
  constructor(alvo: TemplateCanal, params: string[], texto: string) {
    this.alvo = alvo;
    this.params = params;
    this.texto = texto;
  }
  /** Existe pra que `#provado` seja lido em algum lugar; ninguem chama. */
  get provado(): boolean {
    return this.#provado;
  }
}

export type EnvioTemplateProvado = EnvioProvado;

/** O catalogo do canal, como `templateDoCanal` (lib/canais-db.ts) devolve. */
export type CatalogoDoCanal = {
  disponivel: boolean;
  aviso: string;
  template: TemplateCanal | null;
};

export type DecisaoEnvioTemplate =
  | { ok: true; envio: EnvioTemplateProvado }
  | { ok: false; status: 400 | 409 | 503; motivo: string };

/**
 * Le `{nome, idioma}` do pedido. Separado porque a rota precisa do nome ANTES da
 * decisao (e ele que vai na consulta ao catalogo) — e um nome fora do formato nao
 * pode nem virar consulta: ele viaja na URL do DELETE do provedor.
 */
export function lerPedidoTemplate(
  pedido: unknown
): { ok: true; nome: string; idioma: string } | { ok: false; motivo: string } {
  const p = (pedido && typeof pedido === "object" ? pedido : {}) as Record<string, unknown>;
  const nome = String(p.nome ?? "").trim().toLowerCase();
  if (!nome || !NOME_TEMPLATE.test(nome)) {
    return { ok: false, motivo: "informe o nome do template (minusculas, numeros e _)" };
  }
  return { ok: true, nome, idioma: String(p.idioma ?? "").trim() };
}

/**
 * O pedido traz template E outra coisa que nao pode viajar junto? (null = so template)
 *
 * O TEXTO LIVRE ja era barrado — template aprovado nao se altera, entao o `message`
 * seria descartado, e descartar em silencio o que o atendente digitou e perda de
 * trabalho sem aviso.
 *
 * A PERGUNTA COM OPCOES nao era (Frente Z), e ela e pior: com `tipo:"interativo"` +
 * `template` no mesmo pedido, o envio saía como TEMPLATE (o ramo do template vem
 * primeiro) e a linha gravada na conversa saía MISTURADA — `tipo` =
 * `interactive_*` e o corpo gravado = o resumo da pergunta que nunca foi enviada,
 * enquanto o preview e o que o cliente leu eram o texto do template. Historico
 * descrevendo uma mensagem que nao existiu, e ninguem recebe erro. Mesmo precedente
 * do 400 de `message` diferente de `interativa.texto`.
 */
export function conflitoComTemplate(pedido: { texto?: string; pergunta?: boolean }): string | null {
  if (pedido?.pergunta) {
    return (
      "escolha um: pergunta com opcoes OU template. Fora da janela de 24h so passa o template aprovado, " +
      "entao as opcoes nao seriam enviadas — e a conversa guardaria uma pergunta que o cliente nunca viu."
    );
  }
  if (String(pedido?.texto ?? "").trim()) {
    return (
      "escolha um: texto livre OU template. O texto do template e o aprovado pela Meta e nao pode ser alterado — " +
      "o que voce digitou nao seria enviado."
    );
  }
  return null;
}

/**
 * TODOS os passos do envio por template, na ordem, com o codigo HTTP de cada
 * recusa. A ordem e fail-closed em cada passo e a ordem e a propria regra:
 *
 *   1. nome no formato                       -> 400
 *   2. catalogo legivel (0023 rodou?)        -> 503  (sem catalogo nao ha como saber
 *      se o template esta aprovado; mandar no escuro aposta a nota de qualidade do
 *      numero da empresa num palpite)
 *   3. status do template (`podeEnviarTemplate`) -> 409
 *   4. numeracao + parametros (`validarParametros`) -> 400
 *
 * O passo 4 e o que a Frente Z acrescentou: ate 31/08/2026 ele conferia so a
 * QUANTIDADE, e template com numeracao furada passava — ver `numeracaoDoCorpo`.
 */
export function decidirEnvioTemplate(pedido: unknown, catalogo: CatalogoDoCanal): DecisaoEnvioTemplate {
  const p = lerPedidoTemplate(pedido);
  if (!p.ok) return { ok: false, status: 400, motivo: p.motivo };
  if (!catalogo || !catalogo.disponivel) {
    return {
      ok: false,
      status: 503,
      motivo:
        String(catalogo?.aviso ?? "").trim() ||
        "nao consegui ler o catalogo de templates deste numero — sincronize os templates do canal",
    };
  }
  const veredito = podeEnviarTemplate(catalogo.template);
  if (!veredito.ok) return { ok: false, status: 409, motivo: veredito.motivo };
  // ESTREITAMENTO, nao cast. Era `catalogo.template as TemplateCanal`, e o cast so
  // era seguro por causa da LINHA DE CIMA: `podeEnviarTemplate(null)` recusa antes.
  // O cast some com a duvida sem responder — quem trocasse a ordem dos dois passos
  // ganhava `TypeError` em producao no lugar de uma recusa.
  //
  // O QUE O ESTREITAMENTO ENTREGA, e o que ele NAO entrega (medido na 3a revisao
  // cega): ele NAO guarda a ordem. A frase anterior aqui dizia "mexeu, `alvo` volta
  // a ser `TemplateCanal | null` e `validarParametros` para de compilar", e isso e
  // falso — arrancando o passo 3 inteiro, `tsc --noEmit` sai **exit 0**, porque o
  // `if (!alvo) return` abaixo estreita localmente. O ganho real e outro e continua
  // valendo: catalogo sem template vira 409 LIMPO em vez de `TypeError`, sem cast e
  // sem `!`. **Quem guarda a ordem e a prova**, por comportamento — arrancar o passo
  // 3 reprova em "PASSO 3 — em analise na Meta: 409" (bloco P.4), medido na mesma
  // rodada. Em runtime, com o passo 3 no lugar, este `if` e inalcancavel.
  const alvo = catalogo.template;
  if (!alvo) return { ok: false, status: 409, motivo: FORA_DO_CATALOGO };
  const par = validarParametros(alvo, (pedido as any)?.params);
  if (!par.ok) return { ok: false, status: 400, motivo: par.motivo };
  return { ok: true, envio: new EnvioProvado(alvo, par.params, renderizarTemplate(alvo.corpo, par.params)) };
}

/** Quem fala com o provedor: `gsEnviarTemplate` (lib/gupshup.ts) tem esta forma. */
export type PostNoProvedor<C> = (creds: C, form: URLSearchParams) => Promise<{ status: number; corpo: unknown }>;

/**
 * O ENVIO do template provado, INTEIRO: monta o corpo do POST, chama o provedor e
 * le a resposta. Sem rede aqui — quem fala com o Gupshup entra por parametro, e e
 * por isso que isto e exercitavel em node solto.
 *
 * POR QUE ISTO SAIU DA ROTA (4a revisao cega). Estas quatro linhas moravam em
 * `enviarTemplate`, dentro de `app/api/send/route.ts`, e la elas eram inalcancaveis
 * por qualquer prova sem Next — o que sobrava era varredura de fonte. O buraco
 * medido: os `params` estavam travados so no NASCIMENTO (`tplEnvio` so nasce do
 * veredito) e na FORMA da chamada; uma linha `form.set("template", JSON.stringify(
 * { id: tpl.alvo.provider_id, params: [] }))` colada logo antes do POST deixava a
 * bateria INTEIRA verde, e o template saía pra Meta sem parametro nenhum. E isso e
 * regressao PLAUSIVEL, nao evasao: mexer no `form` achando que esta ajustando o
 * payload e o gesto mais natural do mundo nesse ponto do codigo.
 *
 * Agora o que chega ao provedor e exercitado por COMPORTAMENTO (bloco P.7 da
 * prova): um `postar` falso guarda o `URLSearchParams` que saiu, e a prova le o
 * JSON `template` de dentro dele. Sobrescrever o `form` aqui reprova.
 *
 * O 202 SEM `messageId` E FALHA, e por isso ele estoura: 202 quer dizer "aceito na
 * fila do provedor", nao "virou mensagem", e sem messageId nao existe como conferir
 * depois. Contar isso como sucesso ja fez relatorio de campanha mentir (Meeting
 * Hub, 08/2026) — a linha sairia com `provider_msg_id: null` e status "sent" pra
 * algo que nunca chegou.
 */
export async function enviarTemplateProvado<C extends { source: string; appName?: string }>(
  creds: C,
  destino: string,
  tpl: EnvioTemplateProvado,
  postar: PostNoProvedor<C>
): Promise<{ messageId: string }> {
  const form = corpoEnvioTemplate(creds, destino, tpl.alvo, tpl.params);
  const r = await postar(creds, form);
  const veredito = lerRespostaEnvio(r.status, r.corpo);
  if (!veredito.ok) throw new Error(veredito.motivo);
  return { messageId: veredito.messageId };
}

// ——————————————————————————————————— a decisao da sincronizacao
//
// Isto era um `if (!lista.length)` no meio de `salvarTemplates` (lib/canais-db.ts),
// e a revisao cega mostrou que a decisao mais consequente do sync estava fora do
// alcance de qualquer prova: quem exercita `salvarTemplates` precisa de banco.
// Extraida, ela e provada em duas linhas — e as duas regras abaixo sao as que
// decidem se um catalogo inteiro sobrevive.
export type DecisaoSync =
  | { acao: "gravar"; lista: TemplateCanal[]; descartados: number }
  | { acao: "nada"; aviso: string };

/**
 * O que fazer com o que o provedor devolveu.
 *
 * DUAS REGRAS, as duas medidas contra o dano que elas evitam:
 *
 *   LISTA VAZIA NAO APAGA NADA. Provedor que responde `[]` por soluco (conta nova
 *   ainda propagando, formato novo que o parser nao leu, app_id errado) esvaziaria
 *   o espelho inteiro — e o espelho e o que AUTORIZA envio por template. Perder um
 *   template novo por uma rodada e barato; derrubar todo o envio por template da
 *   instalacao nao e. Entao: nao grava, devolve aviso, espelho fica como estava.
 *
 *   NOME FORA DO FORMATO E DESCARTADO, nao derruba a rodada. O nome e chave, vira
 *   URL no DELETE do provedor e tem CHECK no banco (0023) — uma linha recusada
 *   pelo Postgres aborta o upsert INTEIRO. Sincronizacao que falha por causa de um
 *   template estranho e pior que uma que ignora aquele template e grava os outros.
 *   `descartados` sai no relato, pra ninguem descobrir isso por ausencia.
 */
export function decidirSincronizacao(listaDoProvedor: readonly TemplateCanal[] | null | undefined): DecisaoSync {
  const bruta = Array.isArray(listaDoProvedor) ? listaDoProvedor : [];
  if (!bruta.length) {
    return {
      acao: "nada",
      aviso:
        "o provedor devolveu ZERO template pra este numero — o catalogo local nao foi mexido " +
        "(lista vazia nao apaga espelho). Confira o app_id do canal no provedor.",
    };
  }
  const lista = bruta.filter((t) => !!t && typeof t.nome === "string" && NOME_TEMPLATE.test(t.nome));
  if (!lista.length) {
    return {
      acao: "nada",
      aviso: "nenhum dos templates do provedor tem nome em formato valido (minusculas, numeros e _)",
    };
  }
  return { acao: "gravar", lista: [...lista], descartados: bruta.length - lista.length };
}

/** Formato do `elementName` no provedor — e o mesmo CHECK da migration 0023. */
export const NOME_TEMPLATE = /^[a-z0-9_]{1,512}$/;

// ————————————————————————————————————————————————————— saldo do canal
export type SaldoCanal = { disponivel: boolean; valor: number | null; moeda: string; aviso: string };

/**
 * Le a carteira do provedor no que ela responder.
 *
 * DECLARADO: diferente das rotas de template (essas sim provadas em conta real no
 * Meeting Hub), a rota de saldo do Gupshup NAO tem prova de producao neste repo.
 * Entao a leitura e TOLERANTE e o fracasso e MUDO: sem numero legivel, a tela diz
 * "saldo indisponivel neste app" em vez de mostrar erro — saldo e informacao de
 * apoio, e uma tela de canal que estoura vermelho por causa dele seria pior que
 * uma tela sem ele.
 */
export function lerSaldo(bruto: unknown): SaldoCanal {
  const b = (bruto && typeof bruto === "object" ? bruto : {}) as Record<string, any>;
  const w = (b.walletResponse && typeof b.walletResponse === "object" ? b.walletResponse : b) as Record<string, any>;
  const cru = w.currentBalance ?? w.balance ?? w.amount ?? null;
  const n = cru == null || cru === "" ? NaN : Number(cru);
  if (!Number.isFinite(n)) {
    return { disponivel: false, valor: null, moeda: "", aviso: "saldo indisponivel neste app" };
  }
  return {
    disponivel: true,
    valor: n,
    moeda: String(w.currency ?? w.currencyCode ?? "USD").trim().toUpperCase(),
    aviso: "",
  };
}
