// FILA DE EXECUCAO ADIADA do motor de automacao — o PROTOCOLO, sem banco.
//
// Frente P, 31/08/2026. Card 86ak859wr (fila/atraso/fim de semana/limites) e
// 86ak859xn (aprovacao humana).
//
// Este arquivo importa SO `./schema.ts` (que nao importa nada) de proposito: ele
// descreve o protocolo do tick contra uma PORTA injetada, e por isso a corrida
// entre dois ticks pode ser provada em memoria, sem banco e sem mandar mensagem
// nenhuma (`node scripts/prova-motor-fila.ts`). O especificador com extensao
// (`./schema.ts`) e o que faz o mesmo arquivo carregar no Next e em node solto —
// `allowImportingTsExtensions` ja esta ligado no tsconfig (Frente H).
//
// O PADRAO DO CLAIM E COPIADO de `lib/disparo/lote.ts`, NAO importado: as duas
// filas resolvem o mesmo problema (dois ticks na mesma fila) e as duas vao
// evoluir por motivos diferentes (destino de campanha x passo de fluxo). Importar
// uma da outra amarraria o motor de automacao ao modulo de disparo, que a
// instalacao pode nem ter ligado.
//
// ================= O QUE ESTA FILA RESOLVE, E O QUE ELA NAO FAZ =================
//
// RESOLVE:
//   1. ESPERA DE VERDADE. O motor inline faz `setTimeout` de ate 15s dentro da
//      requisicao. A regua importada tem atraso de DIAS (medido: 274 das 2.473
//      acoes do ChatGuru tem atraso, 7 delas acima de 1 dia). Aqui o relogio e o
//      banco: `disponivel_em` no futuro, e um tick pega quando a hora chega.
//   2. PULAR FIM DE SEMANA (`jump_weekend`, 26 acoes medidas), no fuso da
//      INSTALACAO — nunca no fuso do servidor.
//   3. LIMITES POR CONVERSA (`max_executions_per_chat`,
//      `seconds_between_executions`), conferidos ao ENFILEIRAR.
//   4. APROVACAO HUMANA (`need_approval`, 52 acoes medidas): a cadeia PARA no
//      passo e fica esperando alguem aprovar ou recusar.
//   5. IDEMPOTENCIA sob dois ticks concorrentes: claim atomico
//      `agendado -> executando`; so roda o que o update devolveu.
//   6. FILA POR CONVERSA: dois passos da MESMA conversa nunca rodam ao mesmo
//      tempo, e rodam na ordem.
//
// NAO FAZ (fronteira declarada da frente):
//   - GATILHO por mensagem recebida. Nada aqui decide "esta mensagem dispara o
//     fluxo X" — isso e o motor v2. A fila e alimentada por quem ENFILEIRA
//     (`/api/fluxo-fila`, e amanha o gatilho v2).
//   - CANCELAR passo pendente porque o cliente escreveu de novo. A pergunta esta
//     aberta em docs/mapa/04 (secao 6) e a decisao e de produto: a fila expoe o
//     cancelamento EXPLICITO (`cancelado`) e nao inventa politica.
//   - RAMIFICACAO. Condicao no macro segue decidindo "segue ou para", igual ao
//     inline.

import {
  alcancaCliente,
  avaliarCondicao,
  camposDaCondicao,
  noAtivo,
  ordemDeExecucao,
  type CampoCondicao,
  type Fluxo,
  type LimitesFluxo,
  type No,
  type ResultadoColeta,
} from "./schema.ts";

// -------------------------------------------------------------- constantes

/**
 * Reserva orfa: o tick morreu no meio do passo (deploy, timeout da funcao). Ate
 * este limite ninguem mexe; passado ele, a linha volta pra `agendado`.
 *
 * 5 min e o mesmo numero do disparo, e pelo mesmo motivo: e maior que qualquer
 * `maxDuration` de rota (60s) com folga de sobra, entao devolver a reserva nunca
 * corre em paralelo com o tick que ainda esta rodando de verdade.
 */
export const LIMITE_RESERVA_MS = 5 * 60 * 1000;

/** Tentativas de UM passo antes de a cadeia ser marcada como falhada. */
export const MAX_TENTATIVAS_PASSO = 3;

/**
 * Quantos passos um tick processa por rodada. O orcamento de tempo tambem corta
 * (ORCAMENTO_MS no chamador), mas o teto de itens evita que uma fila gigante faca
 * a rodada varrer 10 mil linhas pra descobrir que nao dava tempo.
 */
export const PASSOS_POR_TICK = 25;

export const ESTADOS_FILA = [
  // esperando a hora (`disponivel_em`) — o estado normal
  "agendado",
  // parado esperando gente aprovar ou recusar
  "aguardando_aprovacao",
  // um tick reservou e esta rodando o passo agora
  "executando",
  // a corrente terminou (fim do fluxo, ou condicao falsa que para o macro)
  "concluido",
  // um passo falhou depois das tentativas
  "falhou",
  // alguem cancelou a cadeia
  "cancelado",
  // alguem RECUSOU o passo de aprovacao: a cadeia para e fica dito quem recusou
  "recusado",
] as const;
export type EstadoFila = (typeof ESTADOS_FILA)[number];

/** Estados em que a cadeia ainda pode andar. */
export const ESTADOS_VIVOS: readonly EstadoFila[] = ["agendado", "aguardando_aprovacao", "executando"];

export function estadoFilaValido(v: unknown): v is EstadoFila {
  return typeof v === "string" && (ESTADOS_FILA as readonly string[]).includes(v);
}

// ------------------------------------------------------------------- tipos

/**
 * UMA linha da fila = UMA cadeia em andamento. Ela ANDA (o `no_id` avanca) em vez
 * de virar N linhas, por dois motivos: cancelar e um update so, e o claim atomico
 * de uma linha unica ja serializa a cadeia inteira.
 */
export type ItemFila = {
  id: string;
  /** agrupa a cadeia na trilha (`fluxo_execucoes.execucao_id`) */
  execucao_id: string;
  fluxo_slug: string;
  /** uuid da linha em `mensageria.fluxos` — desce pra coluna fluxo_id da trilha */
  fluxo_id?: string | null;
  canal: string;
  chat_id: string;
  /** o proximo no a executar */
  no_id: string;
  estado: EstadoFila;
  /** quando este passo pode rodar (ISO) */
  disponivel_em: string;
  /** "manual" (atendente mandou) ou "gatilho" (automacao) — vai pro ContextoExecucao */
  origem: "manual" | "gatilho";
  usuario_id: string | null;
  usuario_nome: string | null;
  tentativas: number | null;
  reservado_em?: string | null;
  /** aprovacao JA decidida pra ESTE no (a decisao e por passo, nao pela cadeia) */
  aprovacao_no_id?: string | null;
  aprovacao_decisao?: "aprovado" | "recusado" | null;
  /**
   * assinatura do CONTEUDO do no no momento da decisao. Sem ela, aprovar "mando
   * o orcamento de R$ 5.000" e depois editar o texto pra outra coisa faria o
   * passo sair com a aprovacao de um conteudo que ninguem viu — a aprovacao
   * valeria pelo ENDERECO do passo, nao pelo que ele faz.
   */
  aprovacao_assinatura?: string | null;
  /**
   * `fluxo_fila.atualizada_em` (ISO): desde quando a linha esta no estado atual.
   * Pra cadeia parada em `aguardando_aprovacao` e desde quando ela ESPERA — e o
   * que a passada de expiracao compara com `aprovacaoExpiraHoras`.
   */
  atualizada_em?: string | null;
};

// `pulado` = o passo nao rodou e a cadeia SEGUE (hoje: passo desligado). Nao e
// "parou" (que e a condicao falsa encerrando o macro) nem "falhou".
export type StatusPassoFila = "ok" | "falhou" | "parou" | "pulado";

/** O que aconteceu ao rodar UM no. Nunca lanca — a porta traduz erro em `falhou`. */
export type ResultadoNoFila = {
  status: StatusPassoFila;
  /** rotulo da acao (ou "condicao") pra trilha */
  acao: string;
  detalhe: string;
  /** mensagem criada pelo passo (liga mensagem -> execucao) */
  mensagem_id?: string | null;
};

/**
 * O RELOGIO da instalacao. Injetado porque "que dia da semana e" depende do FUSO
 * DA INSTALACAO (lib/fuso.ts) e "que hora e" depende do tick — as duas coisas que
 * uma prova precisa controlar.
 *
 * `mesmaHoraNoDiaSeguinte` existe em vez de "somar 86.400.000ms" de proposito:
 * nos dois dias do ano em que o relogio muda, somar 24h desloca a hora de parede
 * em 1h. Quem implementa de verdade converte pro civil da instalacao, soma UM dia
 * de calendario e volta (lib/fuso.ts `partesNoFuso` + `isoDeLocal`), entao um
 * follow-up marcado pras 09:00 continua as 09:00 depois de pular o domingo.
 */
export type RelogioFila = {
  agora(): number;
  /** 0=domingo .. 6=sabado, no fuso da INSTALACAO */
  diaSemana(ms: number): number;
  mesmaHoraNoDiaSeguinte(ms: number): number;
};

// ------------------------------------------------------- decisoes puras

/** A reserva ficou orfa? (tick morreu no meio do passo) */
export function reservaExpirada(
  reservadoEm: string | number | Date | null | undefined,
  agora: number,
  limiteMs: number = LIMITE_RESERVA_MS
): boolean {
  if (!reservadoEm) return true; // reserva sem carimbo e reserva podre
  const t = new Date(reservadoEm as any).getTime();
  if (isNaN(t)) return true;
  return agora - t > limiteMs;
}

/** A cadeia ainda autoriza continuar? (releitura de estado = interrupcao) */
export function deveInterromper(estadoAtual: string): { parar: boolean; motivo: string | null } {
  if (estadoAtual === "agendado" || estadoAtual === "executando") return { parar: false, motivo: null };
  if (estadoAtual === "cancelado") return { parar: true, motivo: "a execucao foi cancelada" };
  if (estadoAtual === "recusado") return { parar: true, motivo: "a aprovacao foi recusada" };
  if (estadoAtual === "concluido") return { parar: true, motivo: "a execucao ja terminou" };
  if (estadoAtual === "falhou") return { parar: true, motivo: "a execucao ja falhou" };
  if (estadoAtual === "aguardando_aprovacao") return { parar: true, motivo: "esperando aprovacao" };
  return { parar: true, motivo: `estado desconhecido na fila ("${estadoAtual}")` };
}

/**
 * Empurra o instante pra fora do fim de semana, no fuso da INSTALACAO.
 *
 * O requisito, medido: "um seguimento agendado pra 48 horas depois numa sexta nao
 * pode cair no domingo". A regra e portanto sobre O DIA, nao sobre horas uteis:
 * sabado e domingo somem, a HORA DE PAREDE fica igual e o passo cai na segunda.
 *
 * DECISAO DECLARADA (nao havia dado que decidisse): a espera nao "conta so dias
 * uteis". 48h de sexta 10:00 dariam domingo 10:00, e o resultado e segunda 10:00 —
 * nao terca. Somar as horas do fim de semana por cima seria inventar semantica
 * que o dado nao sustenta, e faria a mesma regua chegar em dias diferentes
 * dependendo do dia em que comecou.
 *
 * O laco tem teto de 7 voltas: com um relogio de mentira que sempre devolva
 * sabado (ou um fuso torto), sem teto isto seria laco infinito no servidor.
 */
export function pularFimDeSemana(ms: number, relogio: RelogioFila): number {
  let t = ms;
  for (let i = 0; i < 7; i++) {
    const d = relogio.diaSemana(t);
    if (d !== 0 && d !== 6) return t;
    t = relogio.mesmaHoraNoDiaSeguinte(t);
  }
  return t;
}

/**
 * Quando um passo com `segundos` de atraso fica disponivel.
 * Atraso 0 = agora (e "pular fim de semana" com atraso 0 ainda vale: o passo
 * seguinte de uma regua nao deve cair no sabado so porque a espera era curta).
 */
export function instanteDoPasso(
  base: number,
  segundos: number,
  opcoes: { pularFimDeSemana?: boolean },
  relogio: RelogioFila
): number {
  const seg = Number.isFinite(segundos) && segundos > 0 ? Math.round(segundos) : 0;
  const alvo = base + seg * 1000;
  return opcoes.pularFimDeSemana ? pularFimDeSemana(alvo, relogio) : alvo;
}

export type ProximoPasso = {
  no_id: string;
  /** instante (ms) em que o passo pode rodar */
  disponivel_em: number;
  /** atraso acumulado pelos nos de espera que ficaram no caminho */
  esperou_segundos: number;
  /** true se algum no de espera do caminho pediu pra pular o fim de semana */
  pulou_fim_de_semana: boolean;
};

/**
 * O PROXIMO PASSO da corrente, JA com a hora marcada.
 *
 * Aqui esta a decisao que faz a fila existir: **o no de `espera` nunca e
 * EXECUTADO, ele e CONSUMIDO no agendamento**. Uma espera de 3 dias nao vira um
 * passo que dorme 3 dias — vira `disponivel_em = agora + 3 dias` do passo
 * SEGUINTE. Consequencias boas de graca: nada fica preso ocupando a fila, o
 * cancelamento durante a espera e imediato, e a condicao seguinte e reavaliada na
 * HORA de executar (recomendacao de docs/mapa/04 secao 6), nunca no agendamento.
 *
 * `de` = id do no que ACABOU de rodar; `null` = comecar do inicio da corrente.
 * Devolve `null` quando a corrente terminou.
 */
export function proximoPasso(
  fluxo: Fluxo,
  de: string | null,
  base: number,
  relogio: RelogioFila
): ProximoPasso | null {
  const corrente = ordemDeExecucao(fluxo);
  let i = 0;
  if (de !== null) {
    const pos = corrente.findIndex((n) => n.id === de);
    // no que nao esta na corrente (fluxo editado no meio da execucao) NAO vira
    // "comeca de novo": isso reenviaria a corrente inteira pro cliente. A cadeia
    // termina, e quem le a trilha ve onde parou.
    if (pos < 0) return null;
    i = pos + 1;
  }

  let quando = base;
  let esperou = 0;
  let pulou = false;
  for (; i < corrente.length; i++) {
    const no = corrente[i];
    // PASSO DESLIGADO nao roda e nao espera: a cadeia passa por cima dele. Se a
    // espera desligada contasse, o atraso continuaria valendo pra um relogio que
    // alguem tirou de servico.
    if (!noAtivo(no)) continue;
    if (no.acao?.tipo === "espera") {
      const pular = no.acao.pular_fim_de_semana === true;
      quando = instanteDoPasso(quando, no.acao.segundos, { pularFimDeSemana: pular }, relogio);
      esperou += no.acao.segundos;
      pulou = pulou || pular;
      continue;
    }
    return { no_id: no.id, disponivel_em: quando, esperou_segundos: esperou, pulou_fim_de_semana: pulou };
  }
  // a corrente acabou em espera: nada mais pra executar (a espera nao e efeito
  // nenhum sozinha, entao concluir aqui e honesto)
  return null;
}

// ------------------------------------------------------ assinatura do no
/**
 * Impressao digital do CONTEUDO de um no.
 *
 * Existe porque aprovacao que carimba so o ENDERECO do passo (`no_id`) e
 * contornavel com uma edicao: aprovo "mando o orcamento de R$ 5.000", troco o
 * texto do passo, e o que sai pro cliente e outra coisa — com aval de ninguem.
 * Aqui a decisao carimba o que foi APROVADO; divergiu, pede aval de novo.
 *
 * Duas escolhas declaradas:
 *  - **JSON canonico** (chaves ordenadas, recursivo): `{a:1,b:2}` e `{b:2,a:1}`
 *    tem que dar a MESMA assinatura, senao reordenar o jsonb no banco (coisa que
 *    `validarFluxo` faz ao normalizar) pediria aprovacao de novo sem nada ter
 *    mudado de verdade;
 *  - **hash proprio (FNV-1a de 64 bits em duas metades), nao `crypto`**: este
 *    arquivo importa SO o schema, de proposito, pra fila ser provada em node
 *    solto. E o uso aqui nao e criptografico — nao ha adversario tentando forjar
 *    colisao, o que se quer e detectar EDICAO. Se um dia precisar resistir a
 *    ataque, a troca e pra sha256 no lado da fiacao, nao aqui.
 *
 * O `no.aprovacao` entra na assinatura junto: tirar a exigencia de aval TAMBEM e
 * uma mudanca do passo.
 */
export function jsonCanonico(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(jsonCanonico).join(",")}]`;
  const chaves = Object.keys(v as Record<string, unknown>).sort();
  return `{${chaves
    .map((k) => `${JSON.stringify(k)}:${jsonCanonico((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export function assinaturaDoNo(no: No): string {
  const texto = jsonCanonico(no);
  // FNV-1a, duas passadas com offsets diferentes = 64 bits em hex. Suficiente pra
  // "isto mudou?" e sem dependencia nenhuma.
  const fnv = (semente: number) => {
    let h = semente >>> 0;
    for (let i = 0; i < texto.length; i++) {
      h ^= texto.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return `${fnv(0x811c9dc5)}${fnv(0x9dc5811c)}`;
}

/**
 * O passo precisa de aval humano AGORA?
 *
 * A primeira pergunta e se o aval VALE neste passo: aprovacao so e honrada onde a
 * acao alcanca o CLIENTE (`alcancaCliente`, schema.ts). Parar uma cadeia pra
 * alguem aprovar uma NOTA INTERNA nao protege ninguem e enche a fila de aprovacao
 * de coisa que o cliente nem ve — e fila cheia de ruido faz o supervisor aprovar
 * em massa sem ler, que e o fim do portao. A mesma regra vale no preflight inline,
 * de proposito: regra honrada num caminho e ignorada no outro e pior que as duas
 * escolhas.
 */
export function precisaAprovacao(
  no: No,
  item: Pick<ItemFila, "aprovacao_no_id" | "aprovacao_decisao" | "aprovacao_assinatura">
): boolean {
  if (no.aprovacao !== true || !alcancaCliente(no)) return false;
  // a decisao vale pro no em que ela foi tomada, NUNCA pra cadeia. Sem isso, um
  // "aprovar" no passo 2 liberaria em silencio o passo 5, que tambem pedia aval.
  if (item.aprovacao_no_id !== no.id || item.aprovacao_decisao !== "aprovado") return true;
  // e vale pro CONTEUDO que foi aprovado. Assinatura ausente (decisao gravada por
  // uma versao anterior, ou que nao deu pra calcular) conta como DIVERGENTE:
  // fail-closed — pedir aval de novo incomoda, mandar sem aval nao volta.
  return item.aprovacao_assinatura !== assinaturaDoNo(no);
}

/** Por que este passo esta parando pra aval — e a linha que vai pra trilha. */
export function motivoDaParadaParaAval(
  no: No,
  item: Pick<ItemFila, "aprovacao_no_id" | "aprovacao_decisao" | "aprovacao_assinatura">
): string {
  if (item.aprovacao_no_id === no.id && item.aprovacao_decisao === "aprovado") {
    // OS DOIS CASOS SAO DIFERENTES PRA QUEM LE, e a mensagem tem que dizer qual e.
    // Sem assinatura nenhuma, ninguem editou nada: a decisao foi tomada por uma
    // versao do painel que ainda nao carimbava o conteudo. Dizer "o passo foi
    // editado" ali manda o supervisor procurar um culpado que nao existe — e da
    // impressao de que o fluxo foi mexido pelas costas dele.
    if (!item.aprovacao_assinatura) {
      return "aprovacao registrada antes desta atualizacao do painel (sem carimbo do conteudo): aprove de novo pra confirmar o que vai sair";
    }
    return "o passo foi EDITADO depois da aprovacao: precisa de aval de novo";
  }
  if (item.aprovacao_no_id === no.id && item.aprovacao_decisao === "recusado") {
    return "aprovacao recusada anteriormente neste passo: precisa de aval de novo";
  }
  return "passo exige aprovacao humana: parado esperando aval";
}

// ------------------------------------------------------ limites por conversa

/**
 * O historico desta conversa com ESTE fluxo. Quem le do banco e a fiacao; a
 * decisao e aqui.
 */
export type HistoricoConversa = {
  /**
   * Quantas execucoes deste fluxo **efetivamente rodaram** nesta conversa.
   *
   * Contar ENFILEIRAMENTO era errado nas duas pontas: cadeia CANCELADA antes do
   * primeiro passo, e cadeia que falhou no preflight sem efeito nenhum, gastavam
   * cota de um limite que existe pra limitar o que o cliente RECEBE. Com
   * `maximo_por_conversa: 1` — o caso real, 79 dialogos medidos, tipo a saudacao —
   * um cancelamento queimava a unica execucao e a saudacao nunca mais saia.
   * A fonte agora e a trilha (`fluxo_execucoes`): linha lá existe se, e somente
   * se, um passo executou.
   */
  execucoes: number;
  /**
   * Instante ISO do ULTIMO PASSO REAL (nao do enfileiramento).
   *
   * O anti-repique pergunta "quanto tempo desde a ultima vez que este fluxo agiu
   * nesta conversa". Medir por `criada_em` da linha da fila contava do momento em
   * que a cadeia foi ENFILEIRADA — numa regua que comeca com espera de 2 dias, o
   * intervalo ja tinha "passado" antes de o primeiro passo sequer rodar.
   */
  ultima_em: string | null;
  /** ja existe cadeia VIVA deste fluxo nesta conversa? */
  viva: boolean;
};

/**
 * Pode enfileirar? Devolve o motivo da recusa, ou null.
 *
 * FAIL-CLOSED DE PROPOSITO na cadeia viva: enfileirar o MESMO fluxo duas vezes na
 * mesma conversa e o jeito mais facil de mandar a regua em dobro pro cliente.
 * Quem quiser rodar de novo cancela a anterior — explicito.
 */
export function motivoParaNaoEnfileirar(
  limites: LimitesFluxo,
  historico: HistoricoConversa,
  agora: number
): string | null {
  if (historico.viva) {
    return "este fluxo ja esta em andamento nesta conversa (cancele a execucao anterior pra rodar de novo)";
  }
  const max = limites.maximo_por_conversa;
  if (max !== null && Number.isFinite(max) && historico.execucoes >= max) {
    return `limite de ${max} execucao(oes) por conversa ja alcancado (${historico.execucoes})`;
  }
  const intervalo = limites.intervalo_minimo_segundos;
  if (intervalo > 0 && historico.ultima_em) {
    const t = Date.parse(historico.ultima_em);
    // carimbo ilegivel NAO libera o anti-repique: sem saber quando foi a ultima,
    // a resposta honesta e "nao agora" (freio que falha aberto nao e freio).
    if (!Number.isFinite(t)) {
      return "nao deu pra ler quando este fluxo rodou nesta conversa (o anti-repique falha FECHADO)";
    }
    const faltam = Math.ceil((t + intervalo * 1000 - agora) / 1000);
    if (faltam > 0) {
      return `anti-repique: faltam ${faltam}s pro intervalo minimo de ${intervalo}s entre execucoes nesta conversa`;
    }
  }
  return null;
}

// --------------------------------------------------------- a porta do tick

export type PortaFila = {
  /**
   * Itens que ja podem rodar, ORDENADOS de forma deterministica.
   *
   * A ordem contratada e `disponivel_em, canal, chat_id, criada_em`, e nesta
   * ordem por dois motivos que se somam:
   *  - **FIFO POR HORA primeiro**: ordenar por canal antes da hora fazia a fila
   *     atender por ordem ALFABETICA de conversa. Com fila maior que o teto da
   *     rodada, o passo agendado pra 08:00 de um chat "z..." ficava atras de tudo
   *     e podia nao rodar nunca — regua atrasada por causa do nome do canal;
   *  - **determinismo mantido**: a ordem segue TOTAL (a hora empata, o resto
   *     desempata), e e isso que faz dois ticks concorrentes escolherem o MESMO
   *     item por conversa e colidirem no claim.
   * De quebra o indice `idx_fluxo_fila_tick (estado, disponivel_em)` da 0018
   * passa a servir a consulta em vez de ser ignorado.
   */
  candidatos(limite: number): Promise<ItemFila[]>;
  /**
   * As cadeias PARADAS esperando aval.
   *
   * Elas nao entram em `candidatos` (que le so `agendado`) de proposito: enquanto
   * o passo pede aval, ninguem mexe nelas. Mas existe UM caso em que a espera
   * perdeu sentido e ninguem libera — o passo do aval foi DESLIGADO. Quem desliga
   * um passo pela listagem esta dizendo "nao faca este"; a cadeia parada nele
   * ficava esperando uma aprovacao que ninguem mais quer dar, e o unico jeito de
   * solta-la era APROVAR o passo que acabou de ser desligado. Defeito apontado na
   * revisao cega de 31/08/2026.
   */
  candidatosAguardandoAval(limite: number): Promise<ItemFila[]>;
  /** Claim atomico `agendado -> executando`. Devolve o item se ESTE tick pegou. */
  reservar(item: ItemFila): Promise<ItemFila | null>;
  /**
   * Claim atomico `aguardando_aprovacao -> executando`.
   *
   * Separado de `reservar` porque o estado de PARTIDA e outro, e e o estado de
   * partida que faz o claim ser seguro: se alguem aprovou (ou recusou, ou
   * cancelou) na janela entre a leitura e agora, o update nao casa e este tick
   * nao mexe na cadeia.
   */
  reservarAguardandoAval(item: ItemFila): Promise<ItemFila | null>;
  /** O fluxo gravado. `null` = fluxo apagado/ilegivel/desligado. */
  carregarFluxo(slug: string): Promise<{ fluxo: Fluxo; ativo: boolean } | null>;
  /**
   * Estado ATUAL da cadeia, relido antes de executar (interrupcao).
   *
   * O resultado e DISCRIMINADO de proposito. Antes isto devolvia `string` e a
   * fiacao respondia "cancelado" quando a LEITURA falhava — fail-closed correto
   * na intencao (nao enviar sem saber), errado no efeito: a cadeia era tratada
   * como cancelada, a reserva era devolvida com o carimbo nulo e a linha ficava
   * `executando` com `reservado_em = null` PARA SEMPRE (o varredor de orfas so
   * olhava carimbo velho, nao nulo). Uma piscada do banco congelava a regua.
   * Agora "nao deu pra ler" e um caso proprio: nada executa, e o carimbo FICA,
   * pra varredura de orfas retomar em 5 min.
   */
  estadoAtual(item: ItemFila): Promise<{ ok: true; estado: string } | { ok: false; erro: string }>;
  /**
   * Este passo JA rodou nesta execucao? (idempotencia)
   *
   * Fecha a janela do crash ENTRE o efeito e o avanco da cadeia: o tick manda a
   * mensagem, grava a trilha e morre antes de gravar o proximo `no_id`; a reserva
   * fica orfa, volta pra fila e o passo rodaria de novo — mensagem em dobro pro
   * cliente. A trilha ja tem `(execucao_id, no_id)`, entao a pergunta e barata.
   *
   * Erro de leitura devolve `false` (re-executa), NAO `true`: a garantia
   * declarada e at-least-once. Devolver `true` num erro pularia um passo que
   * nunca rodou, e o cliente ficaria sem a mensagem — silenciosamente.
   */
  jaExecutado(item: ItemFila, no: No): Promise<boolean>;
  /** Roda o no (acao ou condicao). NUNCA lanca. */
  executarNo(item: ItemFila, no: No): Promise<ResultadoNoFila>;
  /** Grava a linha da trilha (`fluxo_execucoes`). Melhor-esforco. */
  registrarPasso(item: ItemFila, no: No, r: ResultadoNoFila): Promise<void>;
  /** Para a cadeia esperando aval, com o motivo (que vai pra trilha). */
  pararParaAprovacao(item: ItemFila, no: No, motivo: string): Promise<void>;
  /** Avanca a cadeia pro proximo passo com a hora marcada. */
  agendar(item: ItemFila, proximo: ProximoPasso): Promise<void>;
  /**
   * Encerra a cadeia (`concluido` | `falhou` | `cancelado`). `cancelado` e o
   * desfecho do aval que EXPIROU: ninguem decidiu, nada saiu — nao e conclusao
   * nem falha, e a tela da fila precisa mostrar isso como "nao aconteceu".
   */
  encerrar(item: ItemFila, estado: "concluido" | "falhou" | "cancelado", motivo: string | null): Promise<void>;
  /** Conta tentativa e devolve pra `agendado` (falha transitoria). */
  reagendarPorFalha(item: ItemFila, tentativas: number, erro: string, quando: number): Promise<void>;
  /**
   * Devolve a reserva sem contar tentativa (interrupcao).
   *
   * `limparCarimbo: false` = nao mexe em `reservado_em`. E o caso do erro de
   * LEITURA: como nao se sabe o que aconteceu, o carimbo tem que ficar de pe pra
   * a varredura de orfas retomar sozinha. Limpar ali era o que congelava a cadeia.
   */
  devolverReserva(item: ItemFila, opcoes: { limparCarimbo: boolean }): Promise<void>;
  relogio: RelogioFila;
};

export type ResumoTickFila = {
  passos: number;
  concluidas: number;
  aguardando_aprovacao: number;
  /** cadeias soltas porque o passo do aval foi desligado */
  liberadas_de_aval: number;
  /** cadeias canceladas porque o aval nao veio dentro de `aprovacaoExpiraHoras` */
  expiradas_de_aval: number;
  falhas: number;
  /** claims perdidos pra outro tick */
  perdidos: number;
  /** conversas puladas porque outro passo da MESMA conversa estava correndo */
  conversas_ocupadas: number;
  interrompidos: number;
  /** passos que a trilha mostrou JA executados: a cadeia so avancou (idempotencia) */
  repetidos: number;
  motivo: string | null;
};

const chaveConversa = (i: ItemFila) => `${i.canal}\u0000${i.chat_id}`;

/**
 * UMA rodada do tick.
 *
 * FILA POR CONVERSA, e a mecanica e a mesma licao do rodizio: ordem
 * DETERMINISTICA nos candidatos + so o PRIMEIRO item de cada conversa por rodada.
 * Dois ticks concorrentes olham a mesma lista, escolhem o MESMO item pra cada
 * conversa e colidem no claim atomico — exatamente um vence. E quem PERDE o claim
 * marca a conversa como ocupada e nao tenta o item seguinte dela: sem isso, o
 * perdedor pularia pro passo 2 enquanto o vencedor roda o passo 1, e a ordem
 * dentro da conversa (que e a razao da fila) iria embora.
 */
export async function executarTickFila(
  porta: PortaFila,
  opcoes: {
    passos?: number;
    orcamentoMs?: number;
    /**
     * Horas que uma cadeia parada em aval espera antes de EXPIRAR (config
     * `aprovacao_expira_horas`). 0/ausente = nunca — o comportamento de antes.
     */
    aprovacaoExpiraHoras?: number;
  } = {}
): Promise<ResumoTickFila> {
  const r: ResumoTickFila = {
    passos: 0,
    concluidas: 0,
    aguardando_aprovacao: 0,
    liberadas_de_aval: 0,
    expiradas_de_aval: 0,
    falhas: 0,
    perdidos: 0,
    conversas_ocupadas: 0,
    interrompidos: 0,
    repetidos: 0,
    motivo: null,
  };
  const teto = Math.max(0, Math.floor(opcoes.passos ?? PASSOS_POR_TICK));
  if (teto === 0) return r;
  const orcamento = opcoes.orcamentoMs ?? 45_000;
  const comeco = porta.relogio.agora();

  const candidatos = await porta.candidatos(teto * 2);
  const tratadas = new Set<string>();

  for (const item of candidatos) {
    if (r.passos >= teto) {
      r.motivo = r.motivo ?? "teto de passos da rodada: o resto sai no proximo tick";
      break;
    }
    if (porta.relogio.agora() - comeco > orcamento) {
      r.motivo = r.motivo ?? "orcamento da rodada esgotado: o resto sai no proximo tick";
      break;
    }
    const conversa = chaveConversa(item);
    if (tratadas.has(conversa)) {
      r.conversas_ocupadas++;
      continue;
    }

    // CLAIM ATOMICO. So roda o que o update devolveu.
    const meu = await porta.reservar(item);
    // a conversa sai de circulacao nesta rodada de qualquer jeito: se pegamos, e
    // porque vamos rodar; se perdemos, e porque OUTRO tick esta rodando nela.
    tratadas.add(conversa);
    if (!meu) {
      r.perdidos++;
      continue;
    }

    const fim = await rodarUmPasso(porta, meu, r);
    if (fim) r.motivo = r.motivo ?? fim;
  }

  await liberarParadasEmAvalDesligado(porta, r, teto, tratadas, comeco, orcamento, opcoes.aprovacaoExpiraHoras ?? 0);
  return r;
}

/**
 * O aval desta parada ja passou do prazo? PURA, pra prova em node solto.
 *
 * `horas <= 0` = nunca expira (a instalacao nao ligou a regra). Carimbo ausente ou
 * ilegivel = NAO expira: a parada sem data e um dado que nao se conhece, e cancelar
 * uma cadeia por um dado que nao se conhece seria decidir no escuro — ela fica
 * esperando gente, que era o que fazia antes desta regra existir.
 */
export function avalExpirou(
  atualizadaEm: string | number | Date | null | undefined,
  horas: number,
  agora: number
): boolean {
  if (!horas || horas <= 0) return false;
  if (!atualizadaEm) return false;
  const t = new Date(atualizadaEm as any).getTime();
  if (isNaN(t)) return false;
  return agora - t > horas * 3_600_000;
}

/**
 * Solta as cadeias que ficaram paradas esperando aval de um passo que foi
 * DESLIGADO depois.
 *
 * POR QUE E UMA PASSADA SEPARADA e nao um ramo do `rodarUmPasso`: o caminho normal
 * relê o estado e `deveInterromper("aguardando_aprovacao")` manda PARAR — e esta
 * certo, e o que impede o tick de atropelar uma decisao humana pendente. O ramo do
 * passo desligado vinha DEPOIS dessa parada, entao nunca alcancava justamente quem
 * estava bloqueado. Mexer em `deveInterromper` pra "deixar passar" abriria a porta
 * pra executar passo com aval pendente; uma passada com escopo proprio, que so
 * age quando o no NAO esta mais ativo, resolve sem tocar no portao.
 *
 * O QUE ELA NAO FAZ, de proposito: aval REMOVIDO (o passo segue ligado, so nao
 * pede mais aprovacao) nao e tratado aqui — nesse caso a cadeia nao esta presa,
 * porque aprovar continua sendo um gesto que existe e faz sentido. So o passo
 * desligado cria a situacao sem saida.
 *
 * ELA VIVE DENTRO DO ORCAMENTO DA RODADA, e isso e correcao de um defeito real
 * (revisao cega de 31/08/2026): a passada nascia FORA do relogio do tick, entao com
 * o orcamento ja estourado ela ainda fazia 1 consulta e ate `teto * 2` voltas de
 * `carregarFluxo` + reserva + trilha + agendamento por cima. **O tick e
 * COMPARTILHADO com outras frentes** (o mesmo cron chama o motor inteiro): estourar
 * o tempo aqui nao atrasa "a nossa parte", atrasa o processo que hospeda todo mundo.
 * Duas guardas, e as duas sao necessarias: uma ANTES da consulta (orcamento estourado
 * nao paga nem a leitura) e o `break` no laco, igual ao laco principal (o orcamento
 * pode acabar NO MEIO da passada — cada volta faz 4 idas ao banco). Nada e perdido:
 * a cadeia parada em aval nao tem hora pra correr, e a proxima rodada a pega.
 */
async function liberarParadasEmAvalDesligado(
  porta: PortaFila,
  r: ResumoTickFila,
  teto: number,
  tratadas: Set<string>,
  comeco: number,
  orcamento: number,
  aprovacaoExpiraHoras: number = 0
): Promise<void> {
  if (porta.relogio.agora() - comeco > orcamento) {
    r.motivo = r.motivo ?? "orcamento da rodada esgotado antes da passada de aval desligado: ela sai no proximo tick";
    return;
  }
  let paradas: ItemFila[] = [];
  try {
    paradas = await porta.candidatosAguardandoAval(teto * 2);
  } catch {
    return; // nao dar pra ler as paradas nao pode derrubar o tick
  }
  for (const item of paradas) {
    if (porta.relogio.agora() - comeco > orcamento) {
      r.motivo = r.motivo ?? "orcamento da rodada esgotado: as paradas em aval restantes saem no proximo tick";
      break;
    }
    const conversa = chaveConversa(item);
    if (tratadas.has(conversa)) continue; // um item por conversa por rodada, igual ao laco principal
    // FLUXO DESLIGADO OU APAGADO: mesmo defeito do passo desligado, um nivel
    // acima — e este o caminho normal NAO cuida, porque ele so olha `agendado`.
    // Desligar o fluxo inteiro e um "nao faca isto" ainda mais forte que desligar
    // um passo; deixar a cadeia esperando um aval que ninguem vai dar seria
    // incoerente. Descoberto pela mutacao ao provar o item 6.
    const carregado = await porta.carregarFluxo(item.fluxo_slug);
    if (!carregado || !carregado.ativo) {
      const meu = await porta.reservarAguardandoAval(item);
      tratadas.add(conversa);
      if (!meu) {
        r.perdidos++;
        continue;
      }
      await porta.encerrar(
        meu,
        "concluido",
        carregado
          ? "o fluxo foi desligado: a execucao que esperava aprovacao para aqui"
          : `o fluxo "${meu.fluxo_slug}" nao esta mais disponivel: a execucao que esperava aprovacao para aqui`
      );
      r.concluidas++;
      continue;
    }
    // AVAL EXPIRADO (config `aprovacao_expira_horas`, decisao do Eric 03/09/2026):
    // a cadeia esperou mais que o prazo da instalacao e ninguem decidiu. Ela e
    // CANCELADA (nao "concluida": nada do que ela ia fazer aconteceu, e nao
    // "falhou": nao houve erro), com o motivo na linha pra tela da fila mostrar.
    // Vem DEPOIS do fluxo desligado (esse encerra por motivo mais forte) e ANTES
    // do passo desligado — e o mesmo claim atomico dos outros ramos: se alguem
    // aprovou no ultimo segundo, o update nao casa e a decisao humana vence.
    if (avalExpirou(item.atualizada_em, aprovacaoExpiraHoras, porta.relogio.agora())) {
      const meu = await porta.reservarAguardandoAval(item);
      tratadas.add(conversa);
      if (!meu) {
        r.perdidos++;
        continue;
      }
      await porta.encerrar(
        meu,
        "cancelado",
        `a aprovacao nao veio em ${aprovacaoExpiraHoras}h: a execucao expirou e nada foi enviado`
      );
      r.expiradas_de_aval++;
      continue;
    }
    const no = ordemDeExecucao(carregado.fluxo).find((n) => n.id === item.no_id);
    // No FORA da corrente tambem prende a cadeia, e o motivo e o mesmo (alguem
    // editou o fluxo depois de a regua parar) — entao ele conta como "nao roda
    // mais" e a cadeia e liberada igual.
    if (no && noAtivo(no)) continue; // ainda pede aval de verdade: nao e da nossa conta

    const meu = await porta.reservarAguardandoAval(item);
    tratadas.add(conversa);
    if (!meu) {
      r.perdidos++; // alguem aprovou/recusou/cancelou na janela: o certo e nao mexer
      continue;
    }
    if (!no) {
      await porta.encerrar(
        meu,
        "falhou",
        `o passo "${meu.no_id}" esperava aprovacao e nao esta mais na corrente do fluxo (foi apagado ou tirado do encadeamento)`
      );
      r.falhas++;
      continue;
    }
    await porta.registrarPasso(meu, no, {
      status: "pulado",
      acao: no.acao?.tipo ?? (no.tipo === "condicao" ? "condicao" : "?"),
      detalhe: "passo desligado enquanto a cadeia esperava aprovacao: pulado, e a cadeia segue",
    });
    const prox = proximoPasso(carregado.fluxo, no.id, porta.relogio.agora(), porta.relogio);
    if (!prox) {
      await porta.encerrar(meu, "concluido", "o passo que esperava aprovacao foi desligado e era o ultimo: cadeia encerrada");
      r.concluidas++;
      continue;
    }
    await porta.agendar(meu, prox);
    r.liberadas_de_aval++;
  }
}

/**
 * Um passo: valida o fluxo, confere interrupcao, aplica o portao de aprovacao,
 * executa, grava a trilha e agenda o proximo. Nunca lanca.
 */
async function rodarUmPasso(porta: PortaFila, item: ItemFila, r: ResumoTickFila): Promise<string | null> {
  // INTERRUPCAO: o estado e RELIDO depois do claim. Cancelar/recusar entre a
  // leitura dos candidatos e agora para aqui, e a reserva volta pra fila.
  const leitura = await porta.estadoAtual(item);
  if (!leitura.ok) {
    // NAO E CANCELAMENTO, e "nao sei". Nada executa (fail-closed no efeito) e o
    // CARIMBO FICA: a varredura de orfas retoma esta linha em 5 min. Tratar isto
    // como cancelado — e limpar o carimbo — congelava a cadeia pra sempre.
    await porta.devolverReserva(item, { limparCarimbo: false });
    r.interrompidos++;
    return `nao deu pra reler o estado da execucao (${leitura.erro}) — a reserva volta pela varredura de orfas`;
  }
  // `executando` e o proprio claim desta rodada — nao e interrupcao
  if (leitura.estado !== "executando") {
    const parada = deveInterromper(leitura.estado);
    if (parada.parar) {
      await porta.devolverReserva(item, { limparCarimbo: true });
      r.interrompidos++;
      return parada.motivo;
    }
  }

  const carregado = await porta.carregarFluxo(item.fluxo_slug);
  if (!carregado) {
    await porta.encerrar(item, "falhou", `o fluxo "${item.fluxo_slug}" nao esta mais disponivel nesta instalacao`);
    r.falhas++;
    return null;
  }
  if (!carregado.ativo) {
    // DESLIGAR O FLUXO PARA A REGUA. Se a cadeia continuasse, desligar um fluxo
    // nao pararia o que ele ja tem agendado — e desligar existe justamente pra
    // isso. Encerra como concluido (nao e falha: alguem decidiu desligar).
    await porta.encerrar(item, "concluido", "o fluxo foi desligado: a execucao pendente para aqui");
    r.concluidas++;
    return null;
  }

  const fluxo = carregado.fluxo;
  // BUSCA NA CORRENTE, nunca em `fluxo.nos`. O invariante do formato e que no fora
  // da corrente NAO RODA (`ordemDeExecucao`) — e `fluxo.nos.find` furava
  // exatamente isso: bastava editar o fluxo desligando um passo do encadeamento
  // (`proximo`) pra que a cadeia ja agendada continuasse executando um no que a
  // tela mostra como fora do caminho. Quem tira o passo da corrente espera que ele
  // pare de rodar.
  const no = ordemDeExecucao(fluxo).find((n) => n.id === item.no_id);
  if (!no) {
    await porta.encerrar(
      item,
      "falhou",
      `o passo "${item.no_id}" nao esta mais na corrente do fluxo (ele foi apagado ou tirado do encadeamento durante a execucao)`
    );
    r.falhas++;
    return null;
  }

  // PASSO DESLIGADO DEPOIS DE AGENDADO: nao executa, e a cadeia SEGUE.
  //
  // Este e o caso de quem desliga um passo pela listagem enquanto a regua ja esta
  // na fila. Falhar aqui mataria os passos seguintes — e desligar UM aviso de uma
  // sequencia quer dizer "nao faca este", nunca "cancele o resto". A linha vai
  // pra trilha como `pulado`, com o motivo, senao o passo desaparece sem rastro.
  if (!noAtivo(no)) {
    await porta.registrarPasso(item, no, {
      status: "pulado",
      acao: no.acao?.tipo ?? (no.tipo === "condicao" ? "condicao" : "?"),
      detalhe: "passo desligado depois de a cadeia ser agendada: pulado",
    });
    const prox = proximoPasso(fluxo, no.id, porta.relogio.agora(), porta.relogio);
    if (!prox) {
      await porta.encerrar(item, "concluido", "o ultimo passo esta desligado: cadeia encerrada sem efeito");
      r.concluidas++;
      return null;
    }
    await porta.agendar(item, prox);
    return null;
  }

  // PORTAO DE APROVACAO — antes de qualquer efeito, e ANTES da idempotencia: um
  // passo que pede aval nunca deve ser "pulado por ja ter rodado" sem alguem ter
  // olhado a decisao.
  if (precisaAprovacao(no, item)) {
    await porta.pararParaAprovacao(item, no, motivoDaParadaParaAval(no, item));
    r.aguardando_aprovacao++;
    return null;
  }

  // IDEMPOTENCIA: a trilha ja registra este passo desta execucao? Entao o efeito
  // JA saiu e o que faltou foi so avancar a cadeia (o tick anterior morreu na
  // janela entre os dois). Avanca sem reexecutar.
  if (await porta.jaExecutado(item, no)) {
    r.repetidos++;
    const prox = proximoPasso(fluxo, no.id, porta.relogio.agora(), porta.relogio);
    if (!prox) {
      await porta.encerrar(item, "concluido", "o ultimo passo ja constava na trilha: cadeia encerrada sem repetir o efeito");
      r.concluidas++;
      return null;
    }
    await porta.agendar(item, prox);
    return null;
  }

  const resultado = await porta.executarNo(item, no);
  r.passos++;
  await porta.registrarPasso(item, no, resultado);

  if (resultado.status === "falhou") {
    const tentativas = Math.max(0, Math.floor(Number(item.tentativas) || 0)) + 1;
    if (tentativas >= MAX_TENTATIVAS_PASSO) {
      await porta.encerrar(
        item,
        "falhou",
        `${resultado.detalhe} (desistiu apos ${tentativas} tentativa(s) no passo ${no.id})`
      );
      r.falhas++;
      return null;
    }
    // recuo progressivo: 1min, 2min... A falha pode ser do provedor, e repetir na
    // mesma hora costuma repetir o mesmo erro.
    const quando = porta.relogio.agora() + tentativas * 60_000;
    await porta.reagendarPorFalha(item, tentativas, resultado.detalhe, quando);
    return null;
  }

  if (resultado.status === "parou") {
    // condicao falsa: o macro termina AQUI, sem erro (mesma semantica do inline)
    await porta.encerrar(item, "concluido", resultado.detalhe);
    r.concluidas++;
    return null;
  }

  const prox = proximoPasso(fluxo, no.id, porta.relogio.agora(), porta.relogio);
  if (!prox) {
    await porta.encerrar(item, "concluido", null);
    r.concluidas++;
    return null;
  }
  await porta.agendar(item, prox);
  return null;
}

// ------------------------------------------------- avaliacao de condicao na fila
// A condicao e reavaliada NA HORA DE EXECUTAR (nunca no agendamento) — e a
// recomendacao de docs/mapa/04 secao 6 e o comportamento que menos surpreende
// quem opera: uma regua de 2 dias com "se ainda estiver aberta" tem que olhar a
// conversa de HOJE, nao a de anteontem.
//
// Puro de proposito: quem tem banco e a porta (`coletar`), a DECISAO e aqui.

export type ResultadoCondicaoFila =
  | { status: "ok"; segue: boolean; detalhe: string }
  | { status: "falhou"; detalhe: string };

export async function avaliarNoDeCondicao(
  no: No,
  coletar: (campos: CampoCondicao[]) => Promise<ResultadoColeta>
): Promise<ResultadoCondicaoFila> {
  if (!no.condicao) return { status: "falhou", detalhe: "no de condicao sem condicao" };
  const campos = [...camposDaCondicao(no.condicao)];
  const { fatos, indisponiveis } = await coletar(campos);
  // Fato que nao deu pra LER nao vira "condicao falsa" — mesma regra do percurso
  // inline: silenciar faria a regua parar com cara de decisao tomada.
  const faltando = campos.map((c) => indisponiveis[c]).filter((m) => m !== undefined);
  if (faltando.length) return { status: "falhou", detalhe: faltando[0]! };
  const bateu = avaliarCondicao(no.condicao, fatos);
  return {
    status: "ok",
    segue: bateu,
    detalhe: bateu ? "condicao verdadeira: segue" : "condicao falsa: a execucao para aqui",
  };
}
