import { msgDb } from "@/lib/mensageria";
import { tabelas } from "@/lib/canal";
import { canalPorId, envioDisponivel, somenteLeitura } from "@/lib/canais";
import { credsZapi, zapiSendMedia, zapiSendOptionList, zapiSendText } from "@/lib/zapi";
import { credsEvolution, evoSendMedia } from "@/lib/evolution";
import { credsGupshup, gsSendInterativo, gsSendText, janela24h } from "@/lib/gupshup";
// FRENTE W (31/08/2026, card 86ak85bmw) — a acao `anexar_biblioteca`. A REGRA
// (payload, tipo por mime, canal que aceita arquivo) mora em lib/anexos.ts, que
// nao importa nada; o acervo em lib/anexos-db.ts.
import { motivoNaoAnexa, payloadDeEnvio } from "@/lib/anexos";
import { anexoPorChave, registrarEventoAnexo, registrarUso } from "@/lib/anexos-db";
import { getConfig } from "@/lib/config";
import { statusAoResponder, textoComAssinatura } from "@/lib/conversa-automatica";
import {
  motivoParaRecusarPuro, noAtivo, ordemDeExecucao, percorrerMacro, refFormatoOk,
  type Acao, type CampoCondicao, type EfeitoDoNo, type FatosConversa, type Fluxo,
  type ModoExecucao, type No, type PerguntaOpcoes, type ResultadoColeta,
} from "@/lib/fluxo/schema";
import { colherLinhaDeConversa, pedeALinhaDeConversa } from "@/lib/fluxo/coleta";
// FRENTE Y — a REGRA da pergunta com opcoes (tetos do WhatsApp por tipo, plano
// nativo x texto numerado, envelopes por provedor) mora em lib/interativas.ts,
// que nao importa nada e tem prova em node solto. Este arquivo e a fiacao: e o
// unico lugar do motor que pode importar a lib, porque `lib/fluxo/schema.ts` e o
// contrato publico do formato e tem ZERO import de proposito.
import { envelopeGupshup, envelopeZapiLista, validarInterativa } from "@/lib/interativas";
// FRENTE Y (revisao 1) — a DECISAO da pergunta (modo, rota, rotulos gravados) e o
// contrato da saida especial moram em lib puro, pra terem prova de DESFECHO:
// nenhuma prova consegue carregar ESTE arquivo (banco, provedor, config).
import { planoDaPergunta, saidaDaMensagem } from "@/lib/fluxo/pergunta";
import { definirContexto, lerContexto, limparContexto } from "@/lib/fluxo/contexto-db";

// MOTOR DE MACRO (backend puro) — modulo `automacao`.
//
// Executa um fluxo canonico de tipo "macro": lista ordenada de acoes aplicada
// numa conversa aberta, disparada A MAO pelo atendente. Mesma coisa que o
// atendente faria clicando, num clique so.
//
// ================== CONTRATO DE SEGURANCA (leia antes de chamar) ==================
// Este modulo NAO checa permissao, DE PROPOSITO. Ele recebe o usuario JA
// AUTORIZADO por quem chamou (a rota faz getUser + getPerfil + podeVerConversa +
// restricaoEfetiva, exatamente como as rotas de acao individual). Duplicar a
// regra aqui criaria um segundo lugar pra ela divergir — que e como nasce buraco
// de autorizacao. Quem plugar um chamador novo (cron, webhook, MCP) autoriza
// ANTES; nao existe caminho "de sistema" pra ca.
// ==================================================================================
//
// As mecanicas de cada acao sao as MESMAS das rotas equivalentes (/api/send,
// /api/etiquetas, /api/conversa, /api/nota) e conversam com as mesmas libs de
// baixo nivel (lib/zapi, lib/gupshup, lib/config, lib/canal). Elas foram
// escritas aqui em vez de extraidas das rotas por um motivo declarado: a Frente A
// esta editando app/api/send/route.ts no mesmo periodo, e mover aquele corpo
// agora colidiria. PROXIMO PASSO CERTO (nao e paliativo escondido, e divida
// declarada): quando o P1 fechar, /api/send passa a delegar pra `enviarTexto`
// daqui, e as duas pontas passam a ter um dono so.

export const MAX_ESPERA_INLINE_SEG = 15;
// Teto da SOMA das esperas de um macro. O que mata a execucao nao e uma espera
// grande, e o TOTAL: a rota tem maxDuration 60s, entao 5 esperas de 15s (cada
// uma dentro do limite individual) estouram o orcamento e a funcao morre no
// meio — com mensagem ja enviada pro cliente e sem trilha, que so grava no fim.
// 40s deixa reserva pros envios e pra gravacao da trilha.
export const MAX_ESPERA_TOTAL_SEG = 40;

export type UsuarioExecutor = { id: string; nome: string };

export type ContextoExecucao = {
  canal: string;
  chat_id: string;
  /** usuario JA autorizado pelo chamador (ver contrato acima) */
  usuario: UsuarioExecutor;
  /** grava a trilha em mensageria.fluxo_execucoes (default true) */
  trilha?: boolean;
  /**
   * qual fluxo esta rodando. Preenchido por `executarMacro`; serve pra trilha
   * de OUTRAS tabelas identificarem o movimento como vindo de fluxo (ex:
   * mensageria.conversa_funil_eventos guarda fluxo_slug/fluxo_nome).
   */
  fluxo?: { slug: string; nome: string };
  /**
   * uuid da linha em `mensageria.fluxos`. Vai pra coluna `fluxo_id` da trilha —
   * ela existe desde a 0008 e ficava SEMPRE nula, o que quebrava a unica junta
   * estavel entre trilha e fluxo: o `slug` e a identidade publica e pode ser
   * renomeado/reaproveitado, o uuid nao. Opcional porque o chamador pode nao
   * ter lido a linha (conversor, prova).
   */
  fluxo_id?: string | null;
  /**
   * quem mandou rodar (costura da Frente N, 31/08/2026): "manual" = um atendente
   * disparou (macro pela tela/API) e conta como GENTE nas regras de status;
   * "gatilho" = automacao disparou sozinha e conta como ROBO
   * (statusAoResponder + chave auto_atendimento_bot, que nasce desligada).
   * Default "manual" — hoje o unico chamador e /api/macros; o gatilho v2 DEVE
   * passar "gatilho" ao nascer.
   */
  origem?: "manual" | "gatilho";
};

export type StatusPasso = "ok" | "falhou" | "pulado";
export type Passo = {
  no_id: string;
  acao: string;
  status: StatusPasso;
  detalhe?: string;
  /** mensagem que este passo criou (liga mensagem -> execucao na trilha) */
  mensagem_id?: string | null;
};
export type ResultadoExecucao = {
  ok: boolean;
  execucao_id: string;
  passos: Passo[];
  /** preenchido quando o macro nem comecou (preflight) */
  erro?: string;
};

// ---------------------------------------------------------------- preflight
// Recusa ANTES de rodar qualquer acao. Macro pela metade e pior que macro
// recusado: o atendente nao consegue saber o que ja saiu pro cliente.
// A DECISAO e pura e mora em lib/fluxo/schema.ts (`motivoParaRecusarPuro`), que
// nao importa nada e por isso e provavel sem banco e sem env — inclusive a regra
// mais sensivel daqui, a de canal somente leitura recusar por ACAO e nao pelo
// macro inteiro. Esta funcao so RESOLVE as capacidades do canal e delega.
export function motivoParaRecusar(
  fluxo: Fluxo,
  canal: string,
  // MODO importa na DECISAO, nao so na fiacao (Frente P): `inline` nao sabe
  // esperar dias nem parar pra um humano aprovar; `fila` sabe as duas coisas.
  // Default `inline` de proposito — o chamador antigo (/api/macros) continua
  // protegido sem tocar em uma linha dele, inclusive contra a novidade mais
  // perigosa (rodar inline um passo que exige aprovacao).
  modo: ModoExecucao = "inline"
): string | null {
  const puro = motivoParaRecusarPuro(
    fluxo,
    { soLeitura: somenteLeitura(canal), envioCabeado: envioDisponivel(canal) },
    { maxInline: MAX_ESPERA_INLINE_SEG, maxTotal: MAX_ESPERA_TOTAL_SEG },
    { modo }
  );
  // A DECISAO PURA VEM PRIMEIRO de proposito: ela carrega as recusas
  // estruturais (nao e macro, corrente vazia, todos desligados, canal somente
  // leitura, aval no inline). So depois vale a pena falar de teto de plataforma.
  if (puro) return puro;
  // FRENTE Y — teto de PLATAFORMA da pergunta com opcoes. Ele nao cabe no
  // preflight puro (`schema.ts` nao pode importar lib/interativas.ts), e sem ele
  // um passo com 5 botoes passava o preflight e morria NO MEIO do macro, que e
  // exatamente o que o preflight existe pra impedir.
  return motivoDaPerguntaInvalida(fluxo);
}

/**
 * FRENTE Y — a pergunta com opcoes de algum passo nao cabe na plataforma?
 *
 * Devolve o motivo com o NUMERO DO PASSO na frente, porque um macro de 8 passos
 * com "botoes aceitam no maximo 3 opcoes" sem dizer QUAL passo manda o atendente
 * procurar no lugar errado.
 *
 * Passo DESLIGADO nao e motivo de recusa (mesma regra que `motivoParaRecusarPuro`
 * aplica ao resto): ele nao vai executar.
 *
 * O AVISO DE FALLBACK NAO RECUSA. Botao em canal Z-API sai como texto numerado
 * de proposito (a doc deles declara a instabilidade) — recusar ali tiraria do
 * atendente uma pergunta que FUNCIONA, so nao com o desenho de botao.
 */
export function motivoDaPerguntaInvalida(fluxo: Fluxo): string | null {
  for (const no of ordemDeExecucao(fluxo)) {
    if (!noAtivo(no)) continue;
    if (no.acao?.tipo !== "perguntar_opcoes") continue;
    const v = validarInterativa(no.acao.params);
    if (!v.ok) return `no ${no.id}: ${v.erros.join("; ")}`;
  }
  return null;
}

// ------------------------------------------------------------------ helpers
function agora() {
  return new Date().toISOString();
}

async function assinaturaDe(db: any, usuario: UsuarioExecutor, texto: string): Promise<string> {
  // assinatura por usuario, formato UNICO de lib/conversa-automatica (era a 4a
  // copia do "*Nome:*" no repo — costura do merge da Frente N, 31/08/2026)
  if (!texto) return texto;
  const { data } = await db
    .from("perfis")
    .select("assinatura_ativa,assinatura_nome")
    .eq("user_id", usuario.id)
    .maybeSingle();
  return textoComAssinatura(texto, {
    assinatura_ativa: data?.assinatura_ativa,
    assinatura_nome: data?.assinatura_nome,
    nome: usuario.nome,
  });
}

// Espelha as colunas legadas responsavel_* no PRIMEIRO responsavel
// (mesma funcao que /api/conversa mantem).
async function espelharLegado(db: any, canal: string, chatId: string) {
  const T = tabelas(canal);
  const { data } = await db
    .from("conversa_responsaveis")
    .select("tipo,ref_id,nome")
    .eq("chat_id", chatId)
    .eq("canal", canal)
    .order("criado_em", { ascending: true })
    .limit(1);
  const primeiro = data?.[0];
  await db
    .from(T.conversas)
    .update({
      responsavel_id: primeiro?.ref_id ?? null,
      responsavel_nome: primeiro?.nome ?? null,
      responsavel_tipo: primeiro ? primeiro.tipo : null,
    })
    .eq("chat_id", chatId);
}

/**
 * FRENTE W (31/08/2026) — EXTRAIDO de `enviarTexto`, SEM mudar uma linha da
 * regra, pra ter UM dono.
 *
 * Sao os efeitos de "o painel acabou de responder nesta conversa": carimbo de
 * ultima mensagem + previa, status por `statusAoResponder` (gente x robo, costura
 * da Frente N), auto-arquivar e posse. A extracao existe porque a acao
 * `anexar_biblioteca` responde na conversa do MESMO jeito, e a alternativa era
 * uma SEGUNDA copia destas ~40 linhas — regra copiada em dois lugares diverge na
 * primeira mudanca, que e a licao mais repetida deste repo (tres portas de
 * ingestao, quatro copias da assinatura).
 *
 * Devolve o `now` usado no carimbo, pra a linha de mensagem entrar com o MESMO
 * instante (duas chamadas de `agora()` produziriam mensagem com carimbo diferente
 * do da conversa, e a lista ordena por um e a bolha mostra o outro).
 */
// EXPORTADA desde 03/09/2026: `/api/send` passou a delegar pra ela (divida declarada na
// Fundacao do motor, fechada) — a rota do painel, o motor de fluxo e a acao de anexar
// aplicam a MESMA regra de "respondi nesta conversa" a partir de um lugar so.
export async function efeitosDeResposta(
  ctx: ContextoExecucao,
  conversa: { status: string; auto_arquivar?: boolean | null },
  previa: string
): Promise<string> {
  const { canal, chat_id, usuario } = ctx;
  const T = tabelas(canal);
  const db = msgDb();
  const now = agora();
  await db
    .from(T.conversas)
    .update({
      last_message_at: now,
      last_message_preview: previa.slice(0, 140),
      updated_at: now,
    })
    .eq("chat_id", chat_id);

  // responder move pra "em atendimento" e desarquiva (configuravel); chat com
  // auto_arquivar nunca reabre sozinho — mesma regra do /api/send.
  // COSTURA da Frente N (31/08/2026): a decisao gente x robo e de
  // statusAoResponder — macro disparado por atendente (origem "manual", o
  // default) conta como GENTE; fluxo por gatilho (origem "gatilho", v2) conta
  // como ROBO e so move status com a chave auto_atendimento_bot ligada.
  const estavaEncerrada = conversa.status === "concluido";
  const cfg = await getConfig();
  const statusNovo = statusAoResponder(cfg, {
    autor: ctx.origem === "gatilho" ? "bot" : "usuario",
    statusAtual: conversa.status,
  });
  if (conversa.auto_arquivar) {
    await db.from(T.conversas).update({ arquivada: true }).eq("chat_id", chat_id);
  } else if (statusNovo) {
    await db
      .from(T.conversas)
      .update({ status: statusNovo, arquivada: false })
      .eq("chat_id", chat_id)
      .in("status", ["aberto", "concluido", "aguardando"]);
  }

  // posse: sem nenhum responsavel, quem responde assume; conversa encerrada e
  // do pool e passa a ser de quem retomou
  const { data: respAtuais } = await db
    .from("conversa_responsaveis")
    .select("tipo,ref_id")
    .eq("chat_id", chat_id)
    .eq("canal", canal);
  const jaEDono = (respAtuais ?? []).some((r: any) => r.tipo === "usuario" && r.ref_id === usuario.id);
  if (!respAtuais?.length || (estavaEncerrada && !jaEDono)) {
    if (estavaEncerrada && respAtuais?.length) {
      await db.from("conversa_responsaveis").delete().eq("chat_id", chat_id).eq("canal", canal);
    }
    await db.from("conversa_responsaveis").upsert(
      { canal, chat_id, tipo: "usuario", ref_id: usuario.id, nome: usuario.nome },
      { onConflict: "canal,chat_id,tipo,ref_id" }
    );
    await db
      .from(T.conversas)
      .update({ responsavel_id: usuario.id, responsavel_nome: usuario.nome, responsavel_tipo: "usuario" })
      .eq("chat_id", chat_id);
  }
  return now;
}

// ------------------------------------------------------------------- acoes
// Cada helper devolve o detalhe do que fez, ou lanca com mensagem legivel.

/**
 * FRENTE Y — SAIDA QUE NAO E TEXTO SIMPLES, plugada em `enviarTexto`.
 *
 * Cada campo existe porque a alternativa era uma mentira registrada no banco:
 *  - `enviar`  : a porta do provedor (envelope interativo em vez de send-text);
 *  - `previa`  : o `last_message_preview` da lista de conversas;
 *  - `conteudo`: o que fica em `mensagens.conteudo` (a bolha do painel nao
 *                desenha botao — sem as opcoes, o atendente leria a resposta do
 *                cliente sem saber o que foi oferecido);
 *  - `tipo`    : `mensagens.tipo`, no vocabulario do importador;
 *  - `detalhe` : o que a trilha do passo diz que aconteceu.
 *
 * E `especial` tambem DESLIGA A ASSINATURA do atendente, pela mesma razao que
 * `/api/send` desliga: no envelope interativo o corpo tem teto proprio da
 * plataforma (1024 no `body` da lista, 20/24 no cabecalho) e prefixar "*Nome:*"
 * pode estourar esse teto e fazer a Meta recusar a mensagem INTEIRA — a
 * assinatura derrubaria o envio em vez de aparecer.
 */
export type SaidaEspecial = {
  enviar: (fonte: string, creds: any) => Promise<string | null>;
  previa: string;
  conteudo: string;
  tipo: string;
  detalhe: string;
};

/**
 * Manda o texto e devolve o detalhe MAIS o id da linha de mensagem criada.
 *
 * O `mensagem_id` existe pro card 86ak85zn1: e ele que liga MENSAGEM -> EXECUCAO
 * na trilha, e e a unica ponta que permite, olhando uma mensagem na conversa,
 * responder "quem mandou isso foi o fluxo X, no passo Y". Sem ele a trilha diz o
 * que rodou e nao diz o que apareceu na tela do cliente.
 *
 * Falhar em LER o id de volta NAO derruba o envio: a mensagem ja saiu, e trocar
 * "mensagem enviada" por erro faria um macro bem-sucedido parecer quebrado (e, no
 * caso da fila, viraria retentativa — ou seja, mensagem em dobro pro cliente).
 * Sem id, a trilha fica sem o vinculo e esta dito.
 *
 * FRENTE Y — o 3o parametro (`especial`) e o que faz `perguntar_opcoes` reusar
 * ESTA funcao em vez de virar uma segunda copia dela. O comentario de
 * `executarAcao` logo abaixo ja avisava qual seria o custo de duplicar: "duas
 * copias da acao enviar_texto seria a divergencia mais cara possivel". Toda a
 * mecanica que decide a CONVERSA (conversa existe, janela de 24h, status,
 * desarquivar, posse, trilha, linha em `mensagens`) continua num lugar so; o que
 * `especial` troca e SO a porta do provedor e os rotulos do que ficou gravado.
 */
export async function enviarTexto(
  ctx: ContextoExecucao,
  texto: string,
  especial?: SaidaEspecial
): Promise<{ detalhe: string; mensagem_id: string | null }> {
  const { canal, chat_id, usuario } = ctx;
  const T = tabelas(canal);
  const db = msgDb();
  const c = canalPorId(canal);
  if (!c) throw new Error("canal desconhecido");
  if (!envioDisponivel(canal)) throw new Error("envio nao configurado pra este canal");

  // so envia pra conversa que ja existe (mesma trava do /api/send: o numero da
  // empresa nao vira ferramenta de disparo frio)
  const { data: conversa } = await db
    .from(T.conversas)
    .select("chat_id,status,auto_arquivar")
    .eq("chat_id", chat_id)
    .maybeSingle();
  if (!conversa) throw new Error("conversa nao encontrada");

  const fonte = c.fonte;
  if (fonte === "gupshup") {
    const j = await janela24h(chat_id, T.mensagens);
    if (!j.aberta) throw new Error("janela de 24h fechada (fora dela so template aprovado)");
  }
  // FRENTE Y (revisao 1): as CINCO diferencas entre saida especial e texto
  // normal saem de UMA funcao pura (`saidaDaMensagem`), medida por desfecho em
  // scripts/prova-costuras-y.ts. Eram cinco ternarios espalhados por 120 linhas
  // daqui, cada um com a sua mutacao e nenhum alcancavel por prova.
  const saida = saidaDaMensagem(texto, especial);
  const textoEnviar = saida.assinar ? await assinaturaDe(db, usuario, texto) : texto;

  let messageId: string | null = null;
  if (fonte === "gupshup") {
    const creds = await credsGupshup(canal);
    if (!creds) throw new Error("credenciais Gupshup do canal nao configuradas");
    messageId = especial
      ? await especial.enviar(fonte, creds) // FRENTE Y
      : (await gsSendText(creds, chat_id, textoEnviar)).messageId;
  } else if (fonte === "zapi") {
    const creds = credsZapi(canal);
    if (!creds) throw new Error("credenciais Z-API do canal nao configuradas");
    messageId = especial
      ? await especial.enviar(fonte, creds) // FRENTE Y
      : (await zapiSendText(creds, chat_id, textoEnviar, null)).messageId ?? null;
  } else {
    throw new Error(`fonte ${fonte} nao envia`);
  }

  // FRENTE Y: na saida especial a previa vem dela (`[lista] Qual dia?`) — o
  // texto cru diria outra coisa que a mesma mensagem. Os efeitos (carimbo,
  // status, auto-arquivar, posse) sao os MESMOS da extracao da Frente W:
  // `efeitosDeResposta` e o dono unico da regra, a Y so muda a previa.
  const now = await efeitosDeResposta(ctx, conversa, `${usuario.nome}: ${saida.previa}`);

  const { data: linha } = await db
    .from(T.mensagens)
    .insert({
      chat_id,
      direcao: "out",
      // FRENTE Y: `text` no fallback de texto numerado e
      // `interactive_quick_reply`/`interactive_list` no nativo — decidido por
      // `tipoDeMensagem` (lib/interativas.ts), no MESMO vocabulario que o
      // importador reconhece. Gravar "interactive" numa mensagem que saiu como
      // texto faria a galeria e o relatorio afirmarem recurso que nao houve.
      tipo: saida.tipo,
      // `null` = grava o texto que REALMENTE saiu pela porta (o assinado)
      conteudo: saida.conteudo ?? textoEnviar,
      provider_msg_id: messageId,
      status: "sent",
      criada_em: now,
      enviado_por_id: usuario.id,
      enviado_por_nome: usuario.nome,
    })
    .select("id")
    .maybeSingle();

  return {
    detalhe: saida.detalhe,
    mensagem_id: (linha as any)?.id ?? null,
  };
}

/**
 * FRENTE W (31/08/2026, card 86ak85bmw) — MANDA UM ARQUIVO DA BIBLIOTECA.
 *
 * O passo referencia o item por CHAVE (slug portatil), e e o acervo que da a URL:
 * o fluxo NAO carrega endereco de arquivo. Isso e o que faz "manda sempre a
 * versao certa" valer tambem pra automacao — trocar o arquivo do item na
 * biblioteca troca o que os 76 passos importados mandam, sem editar fluxo nenhum.
 *
 * Ela e irma de `enviarTexto` e divide com ela os efeitos de responder
 * (`efeitosDeResposta`) e a mesma trava de conversa existente. As diferencas sao
 * deliberadas:
 *
 *  - NAO LEVA ASSINATURA. Arquivo nao tem corpo de texto pra assinar, e a legenda
 *    e do MATERIAL, nao do atendente (mesmo motivo pelo qual template e mensagem
 *    interativa nao sao assinados).
 *  - CHAVE QUE NAO EXISTE FALHA O PASSO, com o motivo escrito. Nao "pula em
 *    silencio": passo de anexo que nao manda anexo e a mensagem que sai sem o
 *    material — a falha silenciosa que o card existe pra impedir.
 *  - CANAL QUE NAO MANDA ARQUIVO FALHA ANTES DE TENTAR (`motivoNaoAnexa`, a
 *    MESMA funcao da tela e da rota): na API Oficial a v1 manda so texto, e
 *    descobrir isso depois do envio deixaria o macro pela metade.
 */
export async function enviarAnexoDaBiblioteca(
  ctx: ContextoExecucao,
  acao: { anexo: string; legenda?: string }
): Promise<{ detalhe: string; mensagem_id: string | null }> {
  const { canal, chat_id, usuario } = ctx;
  const T = tabelas(canal);
  const db = msgDb();
  const c = canalPorId(canal);
  if (!c) throw new Error("canal desconhecido");

  const motivo = motivoNaoAnexa({
    fonte: c.fonte,
    soLeitura: somenteLeitura(canal),
    envioCabeado: envioDisponivel(canal),
  });
  if (motivo) throw new Error(motivo);

  const leitura = await anexoPorChave(acao.anexo);
  if (!leitura.ok) throw new Error(leitura.aviso);
  if (!leitura.linha) throw new Error(`a biblioteca nao tem arquivo com a chave "${acao.anexo}"`);
  const anexo = leitura.linha;

  // so envia pra conversa que ja existe (mesma trava do /api/send e do
  // enviarTexto: o numero da empresa nao vira ferramenta de disparo frio)
  const { data: conversa } = await db
    .from(T.conversas)
    .select("chat_id,status,auto_arquivar")
    .eq("chat_id", chat_id)
    .maybeSingle();
  if (!conversa) throw new Error("conversa nao encontrada");

  const payload = payloadDeEnvio(
    {
      chave: anexo.chave,
      nome: anexo.nome,
      arquivo_nome: anexo.arquivo_nome,
      mime: anexo.mime,
      url: anexo.url,
    },
    acao.legenda
  );

  let messageId: string | null = null;
  if (c.fonte === "evolution") {
    const creds = credsEvolution(canal);
    if (!creds) throw new Error("credenciais Evolution do canal nao configuradas");
    messageId =
      (
        await evoSendMedia(creds, payload.tipo, chat_id, payload.media, {
          caption: payload.message,
          fileName: payload.file_name,
          mime: anexo.mime,
        })
      ).messageId ?? null;
  } else if (c.fonte === "zapi") {
    const creds = credsZapi(canal);
    if (!creds) throw new Error("credenciais Z-API do canal nao configuradas");
    messageId =
      (
        await zapiSendMedia(creds, payload.tipo, chat_id, payload.media, {
          caption: payload.message,
          fileName: payload.file_name,
        })
      ).messageId ?? null;
  } else {
    // A fonte e NOMEADA, nao presumida. `motivoNaoAnexa` ja barrou tudo que nao e
    // zapi/evolution la em cima, mas essa seguranca mora em outro arquivo: um
    // `else` cru mandaria uma fonte nova pro Z-API com credencial de outro canal.
    // Mesmo tratamento que `enviarTexto` faz ao lado.
    throw new Error(`fonte ${c.fonte} nao envia anexo da biblioteca`);
  }

  const rotulo = payload.message || `[${payload.tipo}] ${anexo.nome}`;
  const now = await efeitosDeResposta(ctx, conversa, `${usuario.nome}: ${rotulo}`);

  const { data: linha } = await db
    .from(T.mensagens)
    .insert({
      chat_id,
      direcao: "out",
      // o vocabulario de tipo do painel (image|audio|video|document), o MESMO que
      // /api/send grava — historico que inventa tipo proprio nao casa com a tela
      tipo: payload.tipo,
      conteudo: rotulo,
      // a URL JA E NOSSA (Storage da instalacao): gravar aqui evita depender do
      // eco do webhook pra bolha mostrar o arquivo
      media_url: anexo.url,
      provider_msg_id: messageId,
      status: "sent",
      criada_em: now,
      enviado_por_id: usuario.id,
      enviado_por_nome: usuario.nome,
    })
    .select("id")
    .maybeSingle();

  // carimbo e trilha do USO sao melhor-esforco: a mensagem ja saiu, e virar erro
  // faria a fila retentar — arquivo em dobro pro cliente
  await registrarUso(anexo.id);
  await registrarEventoAnexo({
    anexo_id: anexo.id,
    chave: anexo.chave,
    nome: anexo.nome,
    tipo: "usado",
    // convencao 0006: id NULL + nome preenchido = automacao, nao pessoa. O nome
    // do atendente que disparou o macro NAO entra aqui de proposito quando a
    // origem e gatilho — trilha que diz "a Ana mandou" pra algo que o robo
    // mandou e trilha que mente.
    autor: ctx.origem === "gatilho" ? { id: null, nome: "Automacao" } : { id: usuario.id, nome: usuario.nome },
    detalhe: { canal, chat_id, tipo_envio: payload.tipo, por: "fluxo", fluxo: ctx.fluxo?.slug ?? null },
  });

  return {
    detalhe: `anexo "${anexo.nome}" enviado (${payload.tipo})`,
    mensagem_id: (linha as any)?.id ?? null,
  };
}

/**
 * FRENTE Y — a acao `perguntar_opcoes`: manda a pergunta com botoes ou lista.
 *
 * TRES DECISOES, e as tres saem do CONTRATO que a Frente S escreveu no CLAUDE.md
 * (secao "CONTRATO do passo interativo de fluxo"):
 *
 *  1. `validarInterativa` E A MESMA FUNCAO da rota `/api/send` e do composer —
 *     nao ha uma segunda regra de tetos aqui. Ela RECUSA, nunca corta: titulo
 *     cortado ao meio faz o cliente escolher outra coisa. O `validarFluxo` (puro,
 *     sem import) ja garantiu o FORMATO; o que se checa aqui e o teto de
 *     PLATAFORMA, que so quem conhece a plataforma sabe.
 *  2. `planoDeEnvio` decide nativo x texto numerado — O PASSO NAO DECIDE POR
 *     PROVEDOR. Botao em canal Z-API cai no fallback porque a doc da Z-API
 *     declara a instabilidade; lista em GRUPO idem. Se a Z-API estabilizar, muda
 *     `planoDeEnvio` e este arquivo nem sabe.
 *  3. O envio passa por `enviarTexto` (com `especial`), entao a pergunta herda
 *     TUDO o que o texto do fluxo ja tem: conversa-existe, janela de 24h,
 *     status/desarquivar, posse, `mensagem_id` na trilha. Caminho paralelo de
 *     envio seria um segundo lugar pra essas travas divergirem.
 */
export async function perguntarOpcoes(
  ctx: ContextoExecucao,
  params: PerguntaOpcoes
): Promise<EfeitoDoNo> {
  const v = validarInterativa(params);
  if (!v.ok) throw new Error(`pergunta com opcoes invalida: ${v.erros.join("; ")}`);
  const msg = v.msg;
  const c = canalPorId(ctx.canal);
  if (!c) throw new Error("canal desconhecido");
  // TODA a decisao (modo, rota, previa, conteudo, tipo, detalhe) vem PRONTA de
  // lib/fluxo/pergunta.ts, que e puro e tem prova de desfecho. Aqui so se
  // despacha — e o despacho e um `switch` sobre a ROTA, nao quatro `if`
  // encadeados em que trocar um `modo === "nativo"` por `true` era invisivel.
  const plano = planoDaPergunta(c.fonte, ctx.chat_id, msg);

  return enviarTexto(ctx, msg.texto, {
    enviar: async (_fonte, creds) => {
      switch (plano.rota) {
        case "gupshup_nativo":
          return (await gsSendInterativo(creds, ctx.chat_id, envelopeGupshup(msg))).messageId ?? null;
        case "zapi_nativo":
          return (await zapiSendOptionList(creds, ctx.chat_id, envelopeZapiLista(msg))).messageId ?? null;
        // FALLBACK: a MESMA pergunta como texto numerado, pela porta de TEXTO do
        // canal — nao existe caminho de envio paralelo aqui.
        case "gupshup_texto":
          return (await gsSendText(creds, ctx.chat_id, plano.numerado)).messageId ?? null;
        case "zapi_texto":
          return (await zapiSendText(creds, ctx.chat_id, plano.numerado, null)).messageId ?? null;
        default:
          // rota null = fonte sem envio interativo cabeado: RECUSA explicita.
          // Hoje inalcancavel (o `else` de `enviarTexto` ja estourou pra fonte
          // desconhecida antes de chegar aqui) — e a rede que segura o dia em
          // que uma fonte nova for cabeada la sem passar por `planoDaPergunta`.
          throw new Error(`fonte ${c.fonte} nao envia pergunta com opcoes`);
      }
    },
    previa: plano.previa,
    conteudo: plano.conteudo,
    tipo: plano.tipo,
    detalhe: plano.detalhe,
  });
}

export async function etiquetar(
  ctx: ContextoExecucao,
  etiquetas: string[],
  modo: "adicionar" | "remover" | "substituir"
): Promise<string> {
  const { canal, chat_id } = ctx;
  const T = tabelas(canal);
  const db = msgDb();

  // etiqueta fora do catalogo ativo NAO entra — mesma regra do /api/etiquetas
  // (criar etiqueta e acao de admin, nunca efeito colateral de macro)
  if (modo !== "remover") {
    const { data: catalogo } = await db.from("etiquetas_catalogo").select("nome").eq("ativo", true);
    const validas = new Set((catalogo ?? []).map((e: any) => e.nome));
    const invalidas = etiquetas.filter((e) => !validas.has(e));
    if (invalidas.length) throw new Error(`etiqueta fora do catalogo: ${invalidas.join(", ")}`);
  }

  const { data: conv } = await db.from(T.conversas).select("etiquetas").eq("chat_id", chat_id).maybeSingle();
  if (!conv) throw new Error("conversa nao encontrada");
  const atuais: string[] = Array.isArray(conv.etiquetas) ? conv.etiquetas.filter((e: any) => typeof e === "string") : [];

  let finais: string[];
  if (modo === "substituir") finais = [...etiquetas];
  else if (modo === "remover") finais = atuais.filter((e) => !etiquetas.includes(e));
  else finais = Array.from(new Set([...atuais, ...etiquetas]));
  finais = finais.slice(0, 30);

  const { error } = await db
    .from(T.conversas)
    .update({ etiquetas: finais, updated_at: agora() })
    .eq("chat_id", chat_id);
  if (error) throw new Error(error.message);
  return `etiquetas (${modo}): ${finais.join(", ") || "nenhuma"}`;
}

export async function mudarStatus(ctx: ContextoExecucao, status: string): Promise<string> {
  const { canal, chat_id, usuario } = ctx;
  const T = tabelas(canal);
  const db = msgDb();
  const now = agora();
  const cfg = await getConfig();

  // autoria da troca de status (migration 0006): id+nome preenchidos = pessoa.
  // O macro e disparado por gente, entao assina a pessoa — nunca "automacao".
  const patch: Record<string, any> = {
    status,
    status_alterado_por_id: usuario.id,
    status_alterado_por_nome: usuario.nome,
    status_alterado_em: now,
    updated_at: now,
  };
  if (status === "concluido") {
    if (cfg.auto_arquivar_concluida) patch.arquivada = true;
    // NAO dispara a pesquisa de satisfacao: CSAT e do encerramento feito na
    // tela (/api/conversa). Macro que quiser perguntar usa enviar_texto —
    // senao um macro de arrumacao em lote viraria enxurrada de CSAT.
  } else {
    const { data: conv } = await db.from(T.conversas).select("auto_arquivar").eq("chat_id", chat_id).maybeSingle();
    if (!conv?.auto_arquivar) patch.arquivada = false;
    patch.aguardando_avaliacao = false;
  }
  const { error } = await db.from(T.conversas).update(patch).eq("chat_id", chat_id);
  if (error) throw new Error(error.message);
  return `status = ${status}`;
}

// Responsavel FANTASMA e o pior efeito colateral possivel deste motor: a
// visibilidade de conversa (lib/perfil.ts) trata "tem responsavel" como filtro —
// conversa SEM responsavel todo mundo ve, mas com um responsavel que nao existe
// ela some do escopo de TODO MUNDO menos do super admin. E a coluna ref_id e
// text, entao o banco aceita qualquer string (o conversor do ChatGuru, por
// exemplo, gera ids sinteticos "chatguru:usuario:<Nome>" de proposito, porque o
// export nao traz id). Fail-closed: id que nao resolve NAO e gravado.
async function refsInvalidos(
  db: any,
  responsaveis: { tipo: "usuario" | "departamento"; id: string; nome: string }[]
): Promise<string[]> {
  const invalidos: string[] = [];
  const usuarios = responsaveis.filter((r) => r.tipo === "usuario");
  const deps = responsaveis.filter((r) => r.tipo === "departamento");

  // id fora do formato uuid nem chega a consultar (pega os ids sinteticos)
  for (const r of responsaveis) {
    if (!refFormatoOk(r.id)) invalidos.push(`${r.tipo}:${r.nome} (id "${r.id}" nao e uuid)`);
  }
  const uOk = usuarios.filter((r) => refFormatoOk(r.id));
  const dOk = deps.filter((r) => refFormatoOk(r.id));

  if (dOk.length) {
    const { data } = await db.from("departamentos").select("id").in("id", dOk.map((r) => r.id));
    const existem = new Set((data ?? []).map((x: any) => x.id));
    for (const r of dOk) if (!existem.has(r.id)) invalidos.push(`departamento:${r.nome} (id nao existe)`);
  }

  if (uOk.length) {
    const { data } = await db.from("perfis").select("user_id").in("user_id", uOk.map((r) => r.id));
    const comPerfil = new Set((data ?? []).map((x: any) => x.user_id));
    // ATENCAO: usuario SEM linha em `perfis` e legitimo (o painel trata como
    // escopo "todas"). Entao quem nao esta em perfis ainda tem uma 2a chance
    // no auth — validar so por perfis recusaria gente de verdade.
    const semPerfil = uOk.filter((r) => !comPerfil.has(r.id));
    if (semPerfil.length) {
      try {
        const { createClient } = await import("@supabase/supabase-js");
        const admin = createClient(process.env.MSG_SUPABASE_URL!, process.env.MSG_SUPABASE_SERVICE_KEY!, {
          auth: { persistSession: false },
        });
        for (const r of semPerfil) {
          const { data: u } = await admin.auth.admin.getUserById(r.id);
          if (!u?.user) invalidos.push(`usuario:${r.nome} (id nao existe)`);
        }
      } catch {
        // sem como confirmar no auth = nao grava (fail-closed)
        for (const r of semPerfil) invalidos.push(`usuario:${r.nome} (nao deu pra confirmar o id)`);
      }
    }
  }
  return invalidos;
}

export async function atribuirResponsavel(
  ctx: ContextoExecucao,
  responsaveis: { tipo: "usuario" | "departamento"; id: string; nome: string }[]
): Promise<string> {
  const { canal, chat_id } = ctx;
  const db = msgDb();

  const invalidos = await refsInvalidos(db, responsaveis);
  if (invalidos.length) {
    throw new Error(
      `responsavel que nao existe no painel: ${invalidos.join("; ")} — fluxo importado precisa casar os nomes com usuario/departamento daqui antes de rodar`
    );
  }

  for (const r of responsaveis) {
    const { error } = await db.from("conversa_responsaveis").upsert(
      { canal, chat_id, tipo: r.tipo, ref_id: r.id, nome: r.nome.slice(0, 120) },
      { onConflict: "canal,chat_id,tipo,ref_id" }
    );
    if (error) throw new Error(error.message);
  }
  await espelharLegado(db, canal, chat_id);
  return `responsaveis: ${responsaveis.map((r) => `${r.tipo}:${r.nome}`).join(", ")}`;
}

export async function notaInterna(ctx: ContextoExecucao, texto: string): Promise<string> {
  const { canal, chat_id, usuario } = ctx;
  const T = tabelas(canal);
  const db = msgDb();
  const { error } = await db.from(T.mensagens).insert({
    chat_id,
    direcao: "interna",
    tipo: "nota",
    conteudo: texto,
    sender_name: usuario.nome,
    enviado_por_id: usuario.id,
    enviado_por_nome: usuario.nome,
    status: "sent",
    criada_em: agora(),
  });
  if (error) throw new Error(error.message);
  // Sem varredura de @mencao (o /api/nota faz): o texto do macro e fixo, e
  // notificar as mesmas pessoas a cada disparo viraria spam de sininho. v2.
  return `anotacao gravada (${texto.length} chars)`;
}

// Mover a conversa de etapa de funil (epico 11). O fluxo referencia funil e
// etapa por NOME — ele e portatil e nao conhece o uuid desta instalacao — e a
// resolucao nome->id acontece em lib/funis-db.ts, sempre DENTRO do funil.
//
// FAIL-CLOSED e FALANTE: nome que nao resolve, etapa arquivada ou instalacao
// sem a migration 0009 fazem o PASSO FALHAR com o motivo escrito (que vai pra
// trilha e pra resposta da rota) — nunca "nao fez nada" em silencio. Como o
// motor para na primeira falha, um macro que dependia da etapa nao segue
// enviando mensagem como se tivesse dado certo.
export async function moverFunil(
  ctx: ContextoExecucao,
  funil: string,
  etapa: string | null
): Promise<string> {
  const { moverConversaPorNome } = await import("@/lib/funis-db");
  const r = await moverConversaPorNome({
    canal: ctx.canal,
    chatId: ctx.chat_id,
    nomeFunil: funil,
    nomeEtapa: etapa,
    // Autoria: quem disparou o macro e PESSOA (id + nome). O fluxo vai junto,
    // entao a trilha do funil mostra "movido pelo fluxo X" mesmo com o macro
    // sendo manual — e quando o gatilho automatico existir (v2), o chamador
    // passa `usuario` de automacao (id null pela convencao da 0006).
    por: { id: ctx.usuario.id || null, nome: ctx.usuario.nome },
    fluxo: ctx.fluxo ? { slug: ctx.fluxo.slug, nome: ctx.fluxo.nome } : null,
  });
  if (!r.ok) throw new Error(r.erro);
  return r.acao === "nada" ? "conversa ja estava nessa etapa" : r.detalhe;
}

// -------------------------------------------------------------- contexto
// A memoria da conversa. `definir_contexto` grava/atualiza um par chave/valor,
// `limpar_contexto` apaga a chave (que e DIFERENTE de gravar vazio: a condicao
// "existe" precisa distinguir "nunca definida" de "definida como vazio").
//
// FAIL-CLOSED e FALANTE, igual mover_funil: instalacao sem a migration 0016 faz
// o PASSO FALHAR com o motivo escrito — que vai pra trilha e pra resposta da
// rota. Nunca "nao fez nada" em silencio, porque o passo seguinte do macro
// costuma depender da variavel que ele acha que gravou.
function autorDoContexto(ctx: ContextoExecucao) {
  return { id: ctx.usuario.id || null, nome: ctx.usuario.nome };
}

// As duas devolvem o mapa NOVO do contexto (a funcao do banco ja o retorna) —
// e e isso que permite uma condicao logo depois decidir com o dado FRESCO, sem
// uma segunda leitura. Ver `percorrerMacro` em lib/fluxo/schema.ts.
export async function gravarContexto(
  ctx: ContextoExecucao,
  chave: string,
  valor: string
): Promise<{ detalhe: string; contexto: Record<string, string> }> {
  const r = await definirContexto(ctx.canal, ctx.chat_id, chave, valor, autorDoContexto(ctx));
  if (!r.ok) throw new Error(r.aviso);
  return { detalhe: `contexto: ${chave} = ${valor.slice(0, 80)}`, contexto: r.dados };
}

export async function apagarContexto(
  ctx: ContextoExecucao,
  chave: string
): Promise<{ detalhe: string; contexto: Record<string, string> }> {
  const r = await limparContexto(ctx.canal, ctx.chat_id, chave, autorDoContexto(ctx));
  if (!r.ok) throw new Error(r.aviso);
  return { detalhe: `contexto: ${chave} apagada`, contexto: r.dados };
}

// ---------------------------------------------------------------- condicao
// Coleta os FATOS da conversa que a condicao precisa — e SO eles. Um macro sem
// condicao nao faz consulta nenhuma; um que so olha contexto nao vai buscar
// etapa de funil.
//
// O que NAO da pra saber vira `indisponiveis`, com o motivo: melhor o passo
// falhar dizendo "nao consegui ler o contexto" do que a condicao dar falso por
// falta de dado e o macro parar como se a condicao tivesse sido avaliada.
// O tipo do resultado da coleta e o do PERCURSO (lib/fluxo/schema.ts): um tipo
// so, pra motor e percurso nao divergirem em silencio.
export type ColetaDeFatos = ResultadoColeta;

export async function coletarFatos(
  ctx: ContextoExecucao,
  campos: Set<CampoCondicao>
): Promise<ColetaDeFatos> {
  const fatos: FatosConversa = {};
  const indisponiveis: Partial<Record<CampoCondicao, string>> = {};
  if (!campos.size) return { fatos, indisponiveis };

  const { canal, chat_id } = ctx;
  const T = tabelas(canal);
  const db = msgDb();
  const tarefas: Promise<void>[] = [];

  // `status`, `etiqueta` e `ficha` (Frente X) saem da MESMA linha da tabela de
  // conversas do canal. Uma leitura so, pelo mesmo motivo que `texto` e `intencao`
  // compartilham a delas: dois SELECT na mesma linha podem pegar estados
  // diferentes se alguem gravar no meio, e ai duas condicoes da MESMA arvore
  // falariam de retratos distintos da conversa.
  //
  // REGRA PRO MERGE — CAMPO NOVO QUE SAIA DESTA LINHA NAO ENTRA AQUI. Ele entra em
  // `CAMPOS_DA_LINHA_DE_CONVERSA` + `coletaDaLinhaDeConversa`
  // (lib/fluxo/coleta.ts), que sao puros e a prova EXECUTA. O instinto manda
  // escrever o ramo novo neste bloco; o git aceita calado e o ramo nasce fora do
  // alcance de qualquer prova — que e exatamente onde o fail-open da `ficha`
  // morava. Este arquivo arrasta banco e provedor e usa alias `@/`: nenhuma prova
  // consegue IMPORTA-LO, entao tudo que decidir aqui so alcanca varredura de
  // token, e varredura pega a REMOCAO da linha, nunca o DESLIGAMENTO dela.
  //
  // O QUE SOBROU AQUI E O LEITOR — o unico pedaco que precisa de banco. Escolher
  // as colunas, entender a resposta e ENCHER os dois mapas e tudo
  // `colherLinhaDeConversa`, provado por desfecho com leitor fake. Nem o derrame
  // ficou: a versao anterior devolvia o resultado e derramava aqui com dois
  // `Object.assign`, e aquelas duas linhas so alcancavam varredura — que reprovava
  // refatoracao inocua e nao pegava desligamento.
  if (pedeALinhaDeConversa(campos)) {
    tarefas.push(
      colherLinhaDeConversa(
        campos,
        async (colunas) => {
          const { data, error } = await db
            .from(T.conversas)
            .select(colunas.join(","))
            .eq("chat_id", chat_id)
            .maybeSingle();
          return { data, erro: error };
        },
        fatos,
        indisponiveis
      )
    );
  }

  // `intencao` sai do MESMO texto de `texto` (a ultima mensagem recebida), entao
  // a leitura e UMA so mesmo quando a condicao pede os dois — ler duas vezes
  // custaria dois SELECT e, pior, poderia ler DUAS mensagens diferentes se uma
  // nova chegasse no meio: a condicao de texto e a de intencao passariam a falar
  // de mensagens distintas.
  const precisaTexto = campos.has("texto") || campos.has("intencao");

  if (precisaTexto) {
    // "texto da mensagem" numa execucao MANUAL e a ultima mensagem RECEBIDA —
    // e o que o atendente tem na frente quando dispara o macro. (No gatilho
    // automatico da v2 sera a mensagem que disparou; o campo e o mesmo.)
    tarefas.push(
      (async () => {
        const { data, error } = await db
          .from(T.mensagens)
          .select("conteudo")
          .eq("chat_id", chat_id)
          .eq("direcao", "in")
          .order("criada_em", { ascending: false })
          .limit(1);
        if (error) {
          if (campos.has("texto")) indisponiveis.texto = error.message;
          if (campos.has("intencao")) indisponiveis.intencao = error.message;
          return;
        }
        const textoLido: string | null = data?.[0]?.conteudo ?? null;
        if (campos.has("texto")) fatos.texto = textoLido;
        if (!campos.has("intencao")) return;

        // RECONHECIMENTO LOCAL, sem API paga: o catalogo vem do banco e a
        // pontuacao e a lib pura (lib/fluxo/intencoes.ts).
        const { intencoesDoTexto } = await import("@/lib/fluxo/intencoes-db");
        const r = await intencoesDoTexto(textoLido);
        // Catalogo que nao deu pra LER e indisponibilidade, nunca "nenhuma
        // intencao bateu": o avaliador e fail-closed, e confundir as duas faria o
        // macro parar com cara de decisao tomada.
        if (!r.ok) indisponiveis.intencao = r.aviso;
        else fatos.intencoes = r.nomes;
      })()
    );
  }

  if (campos.has("contexto")) {
    tarefas.push(
      (async () => {
        const r = await lerContexto(canal, chat_id);
        if (!r.ok) indisponiveis.contexto = r.aviso;
        else fatos.contexto = r.dados;
      })()
    );
  }

  if (campos.has("etapa")) {
    tarefas.push(
      (async () => {
        const { carregarCatalogo, vinculosDaConversa } = await import("@/lib/funis-db");
        const [cat, vin] = await Promise.all([
          carregarCatalogo({ incluirArquivados: true }),
          vinculosDaConversa(canal, chat_id),
        ]);
        if (!cat.ok || !vin.ok) {
          // NUNCA montar o motivo com "||": aviso vazio viraria string vazia, e
          // string vazia e um motivo que o percurso descarta — a condicao
          // rodaria com o fato faltando, decidindo por falso sem avisar.
          indisponiveis.etapa = !cat.ok ? cat.aviso : !vin.ok ? vin.aviso : "nao deu pra ler as etapas da conversa";
          return;
        }
        // id -> nome, resolvido SEMPRE dentro do funil (nome de etapa se repete
        // entre funis; achar por nome solto seria chute)
        const porEtapa = new Map<string, { funil: string; etapa: string }>();
        for (const f of cat.catalogo) {
          for (const e of f.etapas) porEtapa.set(e.id, { funil: f.nome, etapa: e.nome });
        }
        fatos.etapas = vin.vinculos
          .map((v) => porEtapa.get(v.etapa_id))
          .filter((x): x is { funil: string; etapa: string } => !!x);
      })()
    );
  }

  await Promise.all(tarefas);
  return { fatos, indisponiveis };
}

/**
 * Roda UMA acao. Exportada de proposito (Frente P): a FILA
 * (lib/fluxo/fila-db.ts) executa passo a passo e precisa da MESMA mecanica do
 * inline. Duas copias da acao "enviar_texto" — uma pro macro e outra pra fila —
 * seria a divergencia mais caro possivel: o mesmo fluxo se comportaria diferente
 * dependendo de ter atraso ou nao.
 *
 * Lanca com mensagem legivel quando a acao falha (quem chama traduz pra passo
 * `falhou` com o motivo).
 */
export async function executarAcao(ctx: ContextoExecucao, acao: Acao): Promise<EfeitoDoNo> {
  const so = async (p: Promise<string>) => ({ detalhe: await p });
  switch (acao.tipo) {
    case "enviar_texto":
      return enviarTexto(ctx, acao.texto);
    case "etiquetar":
      return so(etiquetar(ctx, acao.etiquetas, acao.modo));
    case "mudar_status":
      return so(mudarStatus(ctx, acao.status));
    case "atribuir_responsavel":
      return so(atribuirResponsavel(ctx, acao.responsaveis));
    case "nota_interna":
      return so(notaInterna(ctx, acao.texto));
    case "mover_funil":
      return so(moverFunil(ctx, acao.funil, acao.etapa));
    case "espera": {
      const seg = Math.min(acao.segundos, MAX_ESPERA_INLINE_SEG);
      await new Promise((r) => setTimeout(r, seg * 1000));
      return { detalhe: `esperou ${seg}s` };
    }
    case "definir_contexto":
      return gravarContexto(ctx, acao.chave, acao.valor);
    case "limpar_contexto":
      return apagarContexto(ctx, acao.chave);
    // FRENTE W (card 86ak85bmw): arquivo da biblioteca. Devolve `mensagem_id`
    // como `enviar_texto`, pra o selo "isto saiu do fluxo X" na bolha valer
    // tambem pro anexo (a trilha da Frente P indexa por mensagem).
    case "anexar_biblioteca":
      return enviarAnexoDaBiblioteca(ctx, acao);
    // FRENTE Y
    case "perguntar_opcoes":
      return perguntarOpcoes(ctx, acao.params);
  }
}

// ---------------------------------------------------------------- trilha
/**
 * UMA linha da trilha, no formato de `mensageria.fluxo_execucoes`.
 *
 * Exportada porque a FILA grava a trilha PASSO A PASSO (ela nao tem um "fim do
 * macro" onde gravar tudo de uma vez), e as duas pontas tem que produzir a MESMA
 * linha. Montar o objeto em dois lugares e como o `origem` ou o `mensagem_id`
 * some de um dos caminhos sem ninguem notar.
 */
export function linhaDeTrilha(
  ctx: ContextoExecucao,
  fluxoSlug: string,
  execucaoId: string,
  passo: Passo
): Record<string, unknown> {
  return {
    fluxo_slug: fluxoSlug,
    // coluna da 0008 que nascia sempre nula: sem ela, fluxo renomeado deixava a
    // trilha antiga sem como voltar pra linha certa
    fluxo_id: ctx.fluxo_id ?? null,
    execucao_id: execucaoId,
    canal: ctx.canal,
    chat_id: ctx.chat_id,
    no_id: passo.no_id,
    acao: passo.acao,
    status: passo.status,
    detalhe: passo.detalhe?.slice(0, 500) ?? null,
    // colunas da 0018. Instalacao sem a migration devolve PGRST204 ("column not
    // found") — quem grava trata e regrava sem elas (ver `inserirTrilha`).
    mensagem_id: passo.mensagem_id ?? null,
    origem: ctx.origem ?? "manual",
    executado_por_id: ctx.usuario.id || null,
    executado_por_nome: ctx.usuario.nome,
  };
}

/** Colunas que so existem depois da 0018. */
const COLS_TRILHA_0018 = ["mensagem_id", "origem"] as const;

/**
 * Insere linhas na trilha tolerando a 0018 ausente.
 *
 * Duas camadas, como `/api/fluxos` faz com a 0015: tenta com as colunas novas e,
 * se o PostgREST reclamar de coluna inexistente, refaz SEM elas. A trilha perde o
 * vinculo com a mensagem — nao perde a trilha.
 */
export async function inserirTrilha(linhas: Record<string, unknown>[]): Promise<void> {
  if (!linhas.length) return;
  const db = msgDb();
  const { error } = await db.from("fluxo_execucoes").insert(linhas);
  if (!error) return;
  const codigo = (error as any)?.code;
  const msg = String((error as any)?.message ?? "");
  const colunaFaltando =
    codigo === "PGRST204" || codigo === "42703" || COLS_TRILHA_0018.some((c) => msg.includes(c));
  if (!colunaFaltando) throw new Error(msg || "nao deu pra gravar a trilha");
  const semNovas = linhas.map((l) => {
    const copia = { ...l };
    for (const c of COLS_TRILHA_0018) delete copia[c];
    return copia;
  });
  const segunda = await db.from("fluxo_execucoes").insert(semNovas);
  if (segunda.error) throw new Error(segunda.error.message);
}

async function gravarTrilha(
  fluxo: Fluxo,
  ctx: ContextoExecucao,
  execucaoId: string,
  passos: Passo[]
): Promise<void> {
  // Trilha e melhor-esforco: a tabela pode nem existir (o DDL da 0008 e gesto
  // humano). Falha aqui NUNCA derruba a execucao — as acoes ja aconteceram.
  try {
    await inserirTrilha(passos.map((p) => linhaDeTrilha(ctx, fluxo.id, execucaoId, p)));
  } catch {
    /* sem trilha, mas o macro rodou */
  }
}

// ---------------------------------------------------------------- executor
export async function executarMacro(fluxo: Fluxo, ctx: ContextoExecucao): Promise<ResultadoExecucao> {
  const execucaoId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const recusa = motivoParaRecusar(fluxo, ctx.canal);
  if (recusa) return { ok: false, execucao_id: execucaoId, passos: [], erro: recusa };

  // o contexto carrega QUAL fluxo esta rodando: trilha de outra tabela (funil)
  // precisa disso pra dizer "quem moveu foi o fluxo X"
  const ctxFluxo: ContextoExecucao = { ...ctx, fluxo: { slug: fluxo.id, nome: fluxo.nome } };

  // O PERCURSO (quem roda, com que fato a condicao decide, onde para) e puro e
  // mora em lib/fluxo/schema.ts. Aqui e a FIACAO: as duas deps de verdade.
  const { ok, passos } = await percorrerMacro(fluxo, {
    coletar: (campos) => coletarFatos(ctxFluxo, new Set(campos)),
    executar: (no) => executarAcao(ctxFluxo, no.acao!),
  });

  if (ctx.trilha !== false) await gravarTrilha(fluxo, ctx, execucaoId, passos);
  return { ok, execucao_id: execucaoId, passos };
}
