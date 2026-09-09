// Comportamentos AUTOMATICOS da conversa (Frente N, 31/08/2026):
// quando a conversa e considerada REINICIADA, que status ela assume a cada
// evento, quem pode mexer nesse status (gente x robo), como se monta a
// assinatura do atendente e o que o MODO SUPERVISOR muda no contador de nao
// lidas.
//
// Este arquivo NAO importa NADA de proposito (mesma convencao de
// lib/fluxo/schema.ts, lib/kanban.ts e lib/perfil-conta.ts): roda dentro do
// Next e em `node` solto, e e por isso que da pra provar cada regra sem banco e
// sem navegador (`node scripts/prova-conversa-automatica.ts`).
//
// Regra da casa (REGRA Nº1): tudo aqui e BASE — nada da Expert, nenhum numero,
// nenhum nome. Toda decisao vem da configuracao da INSTALACAO.

// ---------------------------------------------------------------- reinicio

/** Default de fabrica: 30 minutos sem atividade e a conversa "reiniciou". */
export const MINUTOS_REINICIO_PADRAO = 30;

/** Teto do campo na config (24h). Acima disso, "reinicio" perde sentido. */
export const MINUTOS_REINICIO_MAX = 1440;

/**
 * O recorte da config que estas regras leem. Tipo ESTRUTURAL de proposito: quem
 * chama passa o `ConfigAutomacao` inteiro (lib/config.ts) e este arquivo segue
 * sem import.
 */
export type RegrasConversa = {
  /** minutos sem atividade ate considerar a conversa reiniciada; 0 = desligado */
  reinicio_minutos: number;
  /** conversa reiniciada volta pra "aberto" */
  reinicio_marcar_aberto: boolean;
  /** conversa reiniciada volta pro rodizio automatico */
  reinicio_redelegar: boolean;
  /** ao reiniciar, tira os responsaveis atuais ANTES de redelegar */
  reinicio_remover_delegados: boolean;
  /** responder move a conversa pra "em atendimento" (o USUARIO respondendo) */
  auto_atendimento_ao_responder: boolean;
  /** o BOT/automacao respondendo tambem move pra "em atendimento" */
  auto_atendimento_bot: boolean;
};

/**
 * Ha quanto tempo essa conversa esta parada, em minutos. `null` quando nao da
 * pra saber (conversa nova, carimbo ausente ou ilegivel) — e "nao da pra saber"
 * NUNCA vira "faz muito tempo": inventar idade aqui reiniciaria conversa que
 * acabou de comecar.
 */
export function minutosParada(ultimaAtividadeEm: unknown, agora: Date | number = Date.now()): number | null {
  if (typeof ultimaAtividadeEm !== "string" && !(ultimaAtividadeEm instanceof Date)) return null;
  const t = ultimaAtividadeEm instanceof Date ? ultimaAtividadeEm.getTime() : Date.parse(ultimaAtividadeEm);
  if (!Number.isFinite(t)) return null;
  const ref = agora instanceof Date ? agora.getTime() : agora;
  if (!Number.isFinite(ref)) return null;
  const min = (ref - t) / 60000;
  // carimbo no FUTURO (relogio do provedor adiantado) conta como 0, nunca
  // negativo: conversa que acabou de receber mensagem nao esta parada.
  return min < 0 ? 0 : min;
}

/**
 * A conversa REINICIOU? Verdadeiro so quando ha carimbo de atividade anterior E
 * ele e mais velho que a janela configurada.
 *
 * Conversa NOVA (sem carimbo) nao e reinicio — e comeco, e quem trata isso e a
 * saudacao. `minutos <= 0` desliga a regra inteira.
 */
export function conversaReiniciada(
  ultimaAtividadeEm: unknown,
  minutos: number,
  agora: Date | number = Date.now()
): boolean {
  if (!Number.isFinite(minutos) || minutos <= 0) return false;
  const parada = minutosParada(ultimaAtividadeEm, agora);
  if (parada === null) return false;
  return parada >= minutos;
}

/** Status que o painel conhece. Nao existe outro — ver `decidirReinicio`. */
export const STATUS_CONVERSA = ["aberto", "atendimento", "aguardando", "concluido"] as const;
export type StatusConversa = (typeof STATUS_CONVERSA)[number];

export type DecisaoReinicio = {
  /** a conversa passou da janela de inatividade */
  reiniciada: boolean;
  /** status a gravar, ou null pra nao mexer no status */
  status: StatusConversa | null;
  /**
   * acionar o rodizio nesta conversa — INDEPENDENTE de `auto_distribuir`.
   * Reiniciar e evento proprio: a instalacao pode querer distribuir o retorno do
   * cliente sem ligar o rodizio pra toda conversa nova.
   */
  redistribuir: boolean;
  /**
   * trocar o responsavel atual por outro. Nunca "soltar e rezar": quem aplica
   * escolhe o substituto ANTES de apagar, e sem substituto nao apaga nada.
   */
  removerDelegados: boolean;
};

/**
 * O que fazer quando o CLIENTE escreve numa conversa que existia.
 *
 * Decisoes desta frente, todas deliberadas:
 *
 * 1. **`concluido` nao e tocado aqui.** Reabrir conversa concluida e o trabalho
 *    do `auto_desarquivar_recebida` (que o admin pode ter DESLIGADO de
 *    proposito). Se o reinicio mexesse em `concluido`, ligar "marcar aberto no
 *    reinicio" desfaria em silencio a outra decisao do admin.
 * 2. **`aberto` nao vira update.** Gravar o mesmo valor gastaria escrita e, pior,
 *    emitiria `status_alterado` de uma transicao que nao houve (licao paga pelo
 *    webhook de saida da Frente F).
 * 3. **Quem reinicia e a conversa parada em `atendimento`/`aguardando`**: o
 *    cliente voltou depois de a janela vencer, entao aquele atendimento acabou
 *    e a conversa volta pra fila como `aberto`.
 * 4. **`redistribuir` e o gate de verdade** (`reinicio_redelegar`): ligado, o
 *    reinicio aciona o rodizio nesta conversa mesmo com `auto_distribuir`
 *    DESLIGADO — quem quer distribuir o RETORNO do cliente nao e obrigado a
 *    distribuir tambem toda conversa nova.
 * 5. **`removerDelegados` exige as DUAS chaves** (`reinicio_redelegar` e
 *    `reinicio_remover_delegados`): trocar o responsavel sem redelegar deixaria a
 *    conversa orfa por configuracao meio-preenchida. E trocar SO acontece com
 *    substituto na mao — a parte "junta" mora em lib/rodizio.ts.
 */
export function decidirReinicio(
  cfg: RegrasConversa,
  ctx: { statusAtual?: string | null; ultimaAtividadeEm?: unknown },
  agora: Date | number = Date.now()
): DecisaoReinicio {
  const reiniciada = conversaReiniciada(ctx.ultimaAtividadeEm, cfg.reinicio_minutos, agora);
  if (!reiniciada) return { reiniciada: false, status: null, redistribuir: false, removerDelegados: false };
  const atual = ctx.statusAtual ?? null;
  const podeVirarAberto = atual === "atendimento" || atual === "aguardando";
  return {
    reiniciada: true,
    status: cfg.reinicio_marcar_aberto && podeVirarAberto ? "aberto" : null,
    redistribuir: cfg.reinicio_redelegar,
    removerDelegados: cfg.reinicio_redelegar && cfg.reinicio_remover_delegados,
  };
}

// ------------------------------------------------- status ao responder

/** Quem escreveu a mensagem de saida. */
export type AutorResposta = "usuario" | "bot";

/**
 * Status que a conversa assume quando alguem do NOSSO lado responde — ou `null`
 * pra nao mexer.
 *
 * A separacao gente x robo e o coracao do card: o painel ja movia pra
 * "em atendimento" toda vez que uma mensagem saia, INCLUSIVE quando quem
 * respondeu foi o motor de fluxo. Robo marcando "em atendimento" sequestra a
 * fila humana: a conversa sai da lista de quem esta esperando atendimento sem
 * nenhum atendente ter olhado nela. Por isso o robo tem chave PROPRIA, e ela
 * nasce DESLIGADA.
 */
export function statusAoResponder(
  cfg: RegrasConversa,
  ctx: { autor: AutorResposta; statusAtual?: string | null }
): StatusConversa | null {
  const ligado = ctx.autor === "bot" ? cfg.auto_atendimento_bot : cfg.auto_atendimento_ao_responder;
  if (!ligado) return null;
  const atual = ctx.statusAtual ?? null;
  // "atendimento" ja e o destino: reafirmar nao e transicao.
  if (atual === "atendimento") return null;
  return "atendimento";
}

// ------------------------------------------------------------- assinatura

/** Teto do nome de exibicao (espelha LIMITE_ASSINATURA de lib/perfil-conta.ts). */
export const LIMITE_ASSINATURA_NOME = 60;

/**
 * Nome pronto pra ir dentro do `*...:*`, ou "" quando nao ha nome usavel.
 *
 * O nome vem de campo DIGITADO (perfil, nome da conta), e o destino e um formato
 * com marcacao: `*Nome:*` + quebra de linha. Entao duas coisas sao neutralizadas
 * ANTES de montar:
 *
 *  - **quebra de linha e tabulacao** (`\r`, `\n`, `\t`) viram espaco: nome com
 *    Enter no meio partia a linha da assinatura e o negrito vazava pro corpo da
 *    mensagem;
 *  - **`* _ ~`** saem fora: sao os marcadores de negrito/italico/riscado do
 *    WhatsApp, e um asterisco no nome fecha o negrito no lugar errado — o
 *    cliente recebia a mensagem com formatacao embaralhada.
 *
 * Espaco repetido colapsa, e o corte de 60 vem DEPOIS da limpeza (cortar antes
 * podia deixar so lixo dentro do teto).
 */
export function nomeDeAssinatura(...candidatos: (string | null | undefined)[]): string {
  for (const bruto of candidatos) {
    if (typeof bruto !== "string") continue;
    const limpo = bruto
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[*_~]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, LIMITE_ASSINATURA_NOME)
      .trim();
    if (limpo) return limpo;
  }
  return "";
}

/**
 * O texto que SAI quando a assinatura do atendente esta ligada.
 *
 * Formato unico: `*Nome:*` em negrito do WhatsApp, quebra de linha, texto. Havia
 * TRES copias desta linha no repo (envio do painel, mensagem agendada e motor de
 * fluxo) — copia de formato divergindo sozinha e o defeito que esta funcao evita.
 *
 * Assinatura e de GENTE: quem chama e o ponto de envio do painel. Disparo em
 * massa (lib/disparo) e ENCAMINHAR (/api/forward) NAO passam por aqui de
 * proposito, e mensagem de automacao segue a convencao da casa
 * (`enviado_por_id` NULL com nome preenchido).
 *
 * Os candidatos sao tentados EM ORDEM e o primeiro que sobrar limpo ganha: nome
 * de exibicao so-de-espacos (ou so-de-asteriscos) cai no proximo candidato em
 * vez de fazer a mensagem sair sem assinatura em silencio.
 *
 * Sem nome usavel nenhum, devolve o texto CRU — assinar com "undefined:" seria
 * pior que nao assinar.
 */
export function montarAssinatura(
  texto: string,
  nomes: { assinatura_nome?: string | null; nome?: string | null; fallback?: string | null }
): string {
  if (!texto) return texto;
  const nome = nomeDeAssinatura(nomes.assinatura_nome, nomes.nome, nomes.fallback);
  if (!nome) return texto;
  return `*${nome}:*\n${texto}`;
}

/** Decide se assina e ja devolve o texto pronto pro provedor. */
export function textoComAssinatura(
  texto: string,
  ass: {
    assinatura_ativa?: boolean | null;
    assinatura_nome?: string | null;
    nome?: string | null;
    /** ultimo recurso do chamador (ex: rotulo generico da fila de agendadas) */
    fallback?: string | null;
  }
): string {
  if (ass?.assinatura_ativa !== true) return texto;
  return montarAssinatura(texto, ass);
}

// --------------------------------------------------------- modo supervisor

/**
 * As preferencias que o modo supervisor usa. Tipo estrutural: as chaves de
 * verdade moram em `Preferencias` (lib/perfil-conta.ts), gravadas em
 * `perfis.preferencias` (migration 0011).
 */
export type PrefsSupervisor = {
  supervisor?: boolean | null;
  supervisor_responder_zera?: boolean | null;
};

/**
 * Abrir a conversa marca como lida?
 *
 * Supervisor LE a conversa sem consumir o "nao lida" do time: ele acompanha o
 * atendimento alheio, e cada conversa que ele abre desapareceria da fila de quem
 * precisa responder.
 */
export function abrirMarcaLida(prefs: PrefsSupervisor | null | undefined): boolean {
  return prefs?.supervisor !== true;
}

/**
 * Responder zera o contador?
 *
 * Pra quem NAO e supervisor a pergunta e teorica (abrir a conversa ja zerou);
 * pra supervisor, e a unica porta que sobra — e por isso nasce LIGADA: quem
 * respondeu leu.
 */
export function responderZeraNaoLidas(prefs: PrefsSupervisor | null | undefined): boolean {
  if (prefs?.supervisor !== true) return true;
  return prefs?.supervisor_responder_zera !== false;
}
