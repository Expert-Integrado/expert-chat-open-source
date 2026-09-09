// TRANSCRICAO DE AUDIO — card 86ak85ny7.
//
// O que o atendente quer: LER o que o cliente falou no audio, sem ouvir cada um,
// e poder BUSCAR por texto o que foi dito em audio.
//
// ---------------------------------------------------------------------------
// ESTE ARQUIVO E SO O GANCHO. Ele nao transcreve nada e nao escolhe fornecedor.
//
// REGRA DURA DA CASA: **nenhuma linha do produto consome API paga por conta
// propria.** Quem contrata o servico de transcricao e a INSTALACAO, a chave e
// dela, e sem servico configurado o recurso fica DESLIGADO e INVISIVEL — a rota
// responde `disponivel: false` e a tela nao mostra botao nenhum. Nao existe
// default embutido, nao existe fornecedor "nosso", e nao existe caminho em que o
// painel chame um servico que o dono nao configurou.
//
// COMO A INSTALACAO CONFIGURA (duas camadas, e a assimetria e de proposito):
//   1. env `TRANSCRICAO_URL` + `TRANSCRICAO_CHAVE` — e o que LIGA o recurso.
//   2. `mensageria.config` chave `transcricao` (jsonb) — pode DESLIGAR
//      (`{"ligada": false}`) e pode trocar a URL, mas **nunca traz a chave**.
//
// Por que a chave so vem de env, e isso e decisao com motivo: a linha de config
// e lida pelo painel e a aba de Automacao do admin edita config — chave de
// servico numa tabela com tela e vazamento esperando acontecer (print de tela,
// sessao compartilhada, dump de suporte). E a assimetria da uma propriedade que
// vale ouro: **a config sozinha NUNCA consegue fazer o painel comecar a chamar um
// servico pago** (ela nao tem chave pra isso) — ela so consegue PARAR, e parar
// sem deploy e exatamente o que se quer quando o servico comeca a falhar ou a
// custar caro.
//
// ---------------------------------------------------------------------------
// O FORMATO DA ANOTACAO NAO FOI INVENTADO: foi lido do acervo real da conta
// (backup do ChatGuru, conferido em 31/08/2026). A transcricao **nao** fica na
// mensagem de audio — ela vira uma ANOTACAO INTERNA, assim:
//
//   { type: "note", n: { text: "Conteudo do audio enviado em 17/10/24 as 15:58:
//                                \n\n<texto>", author: "Chatbot" } }
//
// Sao 9.176 anotacoes dessas na conta (8,4% de TODAS as anotacoes), de 36.330
// audios (`audio` 18.965 + `ptt` 17.365) — 25% transcritos. Nao e recurso de
// nicho, e o time ja le nesse formato ha anos.
//
// Por que esse desenho e bom e vale copiar: a transcricao fica na trilha INTERNA,
// visivel pro time, sem poluir a conversa que o cliente enxerga. E, por ser
// anotacao, ja entra na busca e no relatorio de anotacoes de graca — sem coluna
// nova, sem tela nova, sem indice novo.
//
// ---------------------------------------------------------------------------
// Regra deste arquivo: UM import so — `urlAceita` de lib/webhooks-saida.ts, a
// porta de URL de saida ja endurecida e provada do repo (ver
// `urlDeServicoValida` abaixo). Fora dele, nada: a lib segue rodando em node
// solto (`node scripts/prova-transcricao.ts`), sem rede, sem env e sem banco.

import { urlAceita } from "./webhooks-saida.ts";

/**
 * Nome que assina a anotacao.
 *
 * A origem assinava `"Chatbot"`. Aqui NAO: no painel nao existe chatbot nenhum
 * assinando isso, e um nome que descreve o que fez e o que permite ao atendente
 * saber em um relance que a nota e de maquina. Consequencia declarada: a trilha
 * fica com DOIS nomes — as 9.176 anotacoes importadas seguem assinadas
 * "Chatbot", porque historico nao se reescreve, e as novas saem com este nome.
 *
 * Convencao de autoria da casa (migration 0006): `enviado_por_id` NULL com
 * `enviado_por_nome` PREENCHIDO = automacao. E por isso que a nota de
 * transcricao nunca leva id de usuario: nenhum atendente escreveu aquilo, e
 * pendurar a nota no id de quem clicou faria o painel dizer que uma pessoa
 * escreveu um texto que ela nao escreveu.
 */
export const AUTOR_TRANSCRICAO = "Transcricao automatica";

/**
 * Tipos de mensagem que sao audio no acervo.
 *
 * `audio` e `ptt` sao DIFERENTES de proposito (arquivo de audio enviado x audio
 * gravado na hora) e os dois contam: medido, sao 18.965 + 17.365. Deixar `ptt`
 * de fora perderia quase metade dos audios — e sao justamente os gravados na
 * hora, os que mais precisam de transcricao.
 */
export const TIPOS_DE_AUDIO: readonly string[] = ["audio", "ptt", "voice"];

/** Teto do texto que a transcricao pode gravar (o mesmo teto do /api/nota). */
export const LIMITE_TEXTO_TRANSCRICAO = 4000;

/** Quanto esperar o servico da instalacao antes de desistir. */
export const TIMEOUT_MS = 120_000;

export type ConfigTranscricao = {
  /** endereco do servico DA INSTALACAO (nunca um default nosso) */
  url: string;
  /** chave do servico DA INSTALACAO — so de env, nunca de banco */
  chave: string;
  /** desligada pela config (kill switch sem deploy) */
  ligada: boolean;
};

const texto = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * URL de servico aceitavel — a MESMA porta dos webhooks de saida.
 *
 * Reescrita depois da revisao cega de 31/08/2026, e a licao vale pro repo: a
 * primeira versao tinha validador PROPRIO (`^https?://...`) e por isso aceitava
 * `http://` (a chave viajaria em texto claro, colhivel por MITM), credencial
 * embutida na URL (vaza em log de proxy), IPv6 literal, `127.0.0.1` e
 * `169.254.169.254` — metadados de nuvem. Com a URL podendo vir de
 * `mensageria.config`, isso era SSRF com chave paga a tiracolo.
 *
 * O repo JA tinha a porta endurecida e provada (`lib/webhooks-saida.ts`:
 * `urlAceita` + `ipReservado` com 10 faixas). Segundo validador de URL no mesmo
 * repo e um dialeto que apodrece: o que endurece num nao endurece no outro. Aqui
 * ha um `import` — o unico deste arquivo — e ele e de proposito: mais vale
 * compartilhar a regra do que manter a lib "sem import nenhum".
 *
 * CONSEQUENCIA DECLARADA: **so https**. Servico de transcricao rodando na rede
 * da instalacao precisa de https (proxy reverso ou tunel), e nao e purismo — e
 * que a chave da instalacao vai no cabecalho desta chamada.
 */
export function urlDeServicoValida(bruto: unknown): boolean {
  return urlAceita(texto(bruto));
}

/** Le a parte da configuracao que pode vir do BANCO. Puro. */
export function validarConfigDeBanco(bruto: unknown): { url?: string; ligada?: boolean } {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return {};
  const b = bruto as Record<string, unknown>;
  const out: { url?: string; ligada?: boolean } = {};
  // Booleano de VERDADE: "false" (string), 0 ou "nao" nao mexem no estado. Um
  // valor torto aqui nao pode nem ligar por engano nem desligar por engano.
  if (typeof b.ligada === "boolean") out.ligada = b.ligada;
  if (urlDeServicoValida(b.url)) out.url = texto(b.url);
  // `chave` no banco e IGNORADA de proposito, e o silencio aqui e a decisao:
  // aceitar a chave da linha de config abriria a porta pra configurar um servico
  // pago por SQL/tela, que e exatamente o que esta regra impede.
  return out;
}

/** Junta env + banco. Puro: quem le o banco e quem tem banco. */
export function resolverConfig(
  env: Record<string, string | undefined>,
  doBanco: unknown
): ConfigTranscricao {
  const urlEnv = urlDeServicoValida(env.TRANSCRICAO_URL) ? texto(env.TRANSCRICAO_URL) : "";
  const chave = texto(env.TRANSCRICAO_CHAVE);
  const banco = validarConfigDeBanco(doBanco);
  return {
    url: banco.url || urlEnv,
    chave,
    ligada: banco.ligada === undefined ? true : banco.ligada,
  };
}

/**
 * O recurso esta disponivel nesta instalacao?
 *
 * Exige as TRES coisas: url, chave e nao-desligada. Sem qualquer uma delas o
 * recurso e invisivel — e e assim que "instalacao que nao contratou nada" se
 * comporta sem ninguem precisar desligar nada.
 */
export function disponivel(cfg: ConfigTranscricao): boolean {
  return !!cfg.url && !!cfg.chave && cfg.ligada === true;
}

// ------------------------------------------------------ a nota, no formato
const doisDigitos = (n: number) => String(n).padStart(2, "0");

/**
 * Ciclo h24 -> h23: a hora "24" e meia-noite, e meia-noite se escreve "00".
 *
 * Exportada de proposito, ainda que minuscula: no runtime desta maquina o
 * formatador ja devolve "00" e a linha ficaria como codigo que a prova nao
 * alcanca — e regra defensiva que ninguem consegue exercitar e regra que
 * apodrece sem aviso. Como funcao, ela e provada direto.
 */
export function normalizarHora24(h: unknown): string {
  const s = String(h ?? "");
  return s === "24" ? "00" : s;
}

/**
 * "17/10/24 as 15:58" — a data do AUDIO no fuso da instalacao.
 *
 * O fuso importa e nao e detalhe: no acervo, o audio de `18:58:07Z` virou
 * "15:58" na anotacao (Brasilia). Gravar em UTC faria toda anotacao antiga e
 * toda nova discordarem em 3 horas, e quem le a trilha nao tem como saber qual
 * das duas esta certa.
 *
 * `Intl` e do runtime (nao e import): a funcao segue pura e provavel em node
 * solto. Fuso que o runtime nao conhece cai em UTC em vez de lancar — uma
 * anotacao com hora em UTC ainda e util; uma excecao aqui derrubaria a nota
 * inteira depois de o servico ja ter sido pago.
 */
export function dataDaNota(quando: Date | string | number, fuso = "America/Sao_Paulo"): string {
  const d = quando instanceof Date ? quando : new Date(quando);
  if (!Number.isFinite(d.getTime())) return "";
  let partes: Record<string, string> = {};
  try {
    const f = new Intl.DateTimeFormat("pt-BR", {
      timeZone: fuso,
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      // `hourCycle: "h23"` e nao `hour12: false`: com `hour12: false` parte das
      // versoes de ICU devolve o ciclo h24, em que meia-noite e "24" — e
      // "18/10/24 as 24:00" e uma hora que nao existe. O ciclo pedido pelo nome
      // e o conserto de raiz; `normalizarHora24` abaixo e o cinto, pro runtime
      // que ignorar o pedido.
      hourCycle: "h23",
    });
    for (const p of f.formatToParts(d)) partes[p.type] = p.value;
  } catch {
    partes = {
      day: doisDigitos(d.getUTCDate()),
      month: doisDigitos(d.getUTCMonth() + 1),
      year: doisDigitos(d.getUTCFullYear() % 100),
      hour: doisDigitos(d.getUTCHours()),
      minute: doisDigitos(d.getUTCMinutes()),
    };
  }
  if (!partes.day) return "";
  const hora = normalizarHora24(partes.hour);
  return `${partes.day}/${partes.month}/${partes.year} às ${hora}:${partes.minute}`;
}

/**
 * O PREFIXO da anotacao, sem o texto: `Conteudo do audio enviado em <data>:`,
 * com os acentos EXATOS da origem (conferido byte a byte contra o acervo, e a
 * prova cobra isso). Mudar a grafia criaria duas familias de nota na mesma
 * trilha e quebraria a busca de quem procura pelo texto que conhece ha anos.
 *
 * Ele nao contem `%` nem `_` — o que importa porque a rota usa este prefixo num
 * `like` pra saber se o audio ja foi transcrito. Como ele e MONTADO aqui (data
 * formatada, nunca texto de usuario), nao ha coringa pra escapar; a prova
 * verifica que continua assim.
 *
 * E ele que identifica a nota como transcricao daquele audio — e por isso e o que a rota usa pra nao transcrever
 * (nem pagar) duas vezes o mesmo audio.
 *
 * Escrito SEM acento de proposito? Nao: com acento, igual a origem. O painel
 * mostra o texto como esta, e o time ja le "Conteudo do audio enviado em ..." ha
 * anos — mudar a grafia criaria duas familias de nota na mesma trilha e
 * quebraria a busca de quem procura pelo texto que conhece.
 */
export function prefixoDaNota(quando: Date | string | number, fuso?: string): string {
  const d = dataDaNota(quando, fuso);
  return d ? `Conteúdo do áudio enviado em ${d}:` : "Conteúdo do áudio:";
}

/** A anotacao completa, no formato que o time ja le. */
export function textoDaNota(quando: Date | string | number, transcrito: unknown, fuso?: string): string {
  const t = String(transcrito ?? "").trim();
  const cabeca = prefixoDaNota(quando, fuso);
  const corpo = t.slice(0, LIMITE_TEXTO_TRANSCRICAO - cabeca.length - 2);
  return `${cabeca}\n\n${corpo}`;
}

// ------------------------------------------------- o que pode ser transcrito
export type MensagemParaTranscrever = {
  id?: string;
  direcao?: string | null;
  tipo?: string | null;
  media_url?: string | null;
  media_mime?: string | null;
  conteudo?: string | null;
  is_deleted?: boolean | null;
  criada_em?: string | null;
};

/**
 * Da pra transcrever esta mensagem? Devolve o MOTIVO quando nao — a rota
 * responde o motivo, e "nada aconteceu" nunca e resposta.
 *
 * `direcao` NAO entra na regra: audio que o atendente mandou tambem e util
 * transcrever (e o que permite buscar depois o que a propria equipe falou), e a
 * origem transcrevia os dois — medido em 31/08/2026 casando a data do prefixo
 * com o audio da mesma pagina: de 25 anotacoes de transcricao conferidas, 20
 * eram de audio recebido e **4 de audio enviado** (2 `audio` + 2 `ptt`).
 * Limitar a `direcao = "in"` teria a cara de economia e seria perda de paridade.
 */
export function motivoParaNaoTranscrever(m: MensagemParaTranscrever | null | undefined): string | null {
  if (!m) return "mensagem nao encontrada";
  if (m.is_deleted === true) return "mensagem apagada";
  const tipo = String(m.tipo || "").toLowerCase();
  if (!TIPOS_DE_AUDIO.includes(tipo)) return `mensagem do tipo "${tipo || "?"}" nao e audio`;
  if (!/^https?:\/\//i.test(String(m.media_url || ""))) return "esta mensagem nao tem arquivo de audio acessivel";
  return null;
}

// ------------------------------------------- a resposta do servico do cliente
/**
 * Le o texto da resposta do servico DA INSTALACAO, aceitando as formas comuns.
 *
 * Tolerante de proposito, e isto e o coracao do "plugavel": o dono da instalacao
 * aponta pro servico que ELE contratou, e cada um responde com um nome de campo
 * diferente (`texto`, `text`, `transcription`, `results[].text`). Exigir UM
 * formato faria o gancho valer so pro fornecedor que eu tivesse escolhido — e
 * escolher fornecedor nao e trabalho deste repo.
 *
 * Devolve "" quando nao acha texto: resposta que nao trouxe transcricao NAO
 * vira nota vazia (o servico foi pago, mas gravar uma nota sem conteudo mentiria
 * pro atendente dizendo que o audio nao tinha nada).
 */
export function textoDaResposta(bruto: unknown): string {
  const limpar = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (typeof bruto === "string") return limpar(bruto);
  if (!bruto || typeof bruto !== "object") return "";
  const b = bruto as Record<string, any>;
  for (const chave of ["texto", "text", "transcription", "transcript", "transcricao", "resultado"]) {
    const v = limpar(b[chave]);
    if (v) return v;
  }
  for (const lista of [b.results, b.segments, b.chunks, b.data]) {
    if (!Array.isArray(lista)) continue;
    const junto = lista
      .map((it) => (typeof it === "string" ? it : limpar(it?.text) || limpar(it?.texto)))
      .filter(Boolean)
      .join(" ")
      .trim();
    if (junto) return junto;
  }
  // aninhado um nivel (`{data:{text:...}}`)
  for (const dentro of [b.data, b.result, b.output]) {
    if (dentro && typeof dentro === "object" && !Array.isArray(dentro)) {
      const v = textoDaResposta(dentro);
      if (v) return v;
    }
  }
  return "";
}

/**
 * Le o corpo da resposta do servico UMA VEZ e devolve a transcricao.
 *
 * Mora aqui, e nao na rota, por causa de um defeito real (revisao cega de
 * 31/08/2026): a rota fazia `await resposta.json().catch(() => null)` e caia em
 * `await resposta.text()`. Isso NUNCA funciona — `.json()` ja consumiu o stream,
 * entao o `.text()` seguinte lanca "Body is unusable". Resultado: todo servico
 * que responde TEXTO PURO (um dos formatos que `textoDaResposta` aceita DE
 * PROPOSITO) levava 422 "sem transcricao", e o fallback parecia estar ali.
 *
 * A ordem certa e a inversa: le TEXTO (uma leitura), tenta JSON por cima. Como
 * funcao, isso e provado com um `Response` de verdade em node solto — enquanto
 * estava embutido na rota, so uma guarda de fonte alcancava.
 */
export async function textoDoCorpo(resposta: { text: () => Promise<string> }): Promise<string> {
  let cru = "";
  try {
    cru = await resposta.text();
  } catch {
    return ""; // corpo ilegivel nao vira nota
  }
  try {
    return textoDaResposta(JSON.parse(cru));
  } catch {
    return textoDaResposta(cru); // nao e JSON: texto puro serve
  }
}

/** O corpo que vai pro servico. Puro — a prova confere campo a campo. */
export function corpoDaChamada(m: MensagemParaTranscrever, opcoes: { idioma?: string } = {}) {
  return {
    // o servico baixa o arquivo pela URL. Mandar a URL (e nao os bytes) e o que
    // mantem o painel fora do caminho do audio: ele nao carrega midia na memoria
    // do processo web nem paga a banda duas vezes.
    url: String(m.media_url || ""),
    mime: String(m.media_mime || "") || undefined,
    idioma: opcoes.idioma || "pt",
  };
}

/**
 * A nota pronta pra gravar. PURA — a rota so entrega isto ao banco.
 *
 * `enviado_por_id: null` + `enviado_por_nome` preenchido = automacao (0006).
 */
export function linhaDaNota(
  chat_id: string,
  quando: Date | string | number,
  transcrito: string,
  fuso?: string,
  /** id da mensagem de audio que esta nota transcreve */
  mensagem_id?: string
) {
  return {
    chat_id: String(chat_id),
    direcao: "interna" as const,
    tipo: "nota" as const,
    conteudo: textoDaNota(quando, transcrito, fuso),
    sender_name: AUTOR_TRANSCRICAO,
    enviado_por_id: null,
    enviado_por_nome: AUTOR_TRANSCRICAO,
    status: "sent" as const,
    // A NOTA APONTA PRA MENSAGEM. Sem isto a unica ligacao era a data no texto,
    // com resolucao de MINUTO — e dois `ptt` no mesmo minuto (ha par identico no
    // acervo importado) ficavam indistinguiveis: o segundo audio recebia a
    // transcricao do primeiro. A coluna `quoted_msg_id` ja existe (zero DDL) e o
    // sentido dela — "esta mensagem se refere aquela" — e exatamente este; e o
    // indice unico parcial da 0022 usa esta coluna pra garantir UMA nota de
    // transcricao por audio, no banco, nao na checagem.
    quoted_msg_id: mensagem_id ? String(mensagem_id) : null,
  };
}
