// FILA DE ATENDIMENTO — entrar, sair e PULAR A VEZ (Frente S, card 86ak85nxx).
//
// Este arquivo e PURO de proposito: nao importa NADA. Roda no Next e em node
// solto (`node scripts/prova-fila-atendimento.ts`), mesma convencao de
// lib/permissoes.ts, lib/fluxo/schema.ts e lib/escopo-chave.ts.
//
// ————————————————————————————————————————————————————————————————————————
// O QUE ISTO **NAO** E — os tres rodizios do sistema sao distintos e precisam
// continuar distintos (o card abre com essa tabela):
//
//   FILA DE ATENDIMENTO (aqui)   conversa nova entre atendentes DISPONIVEIS
//   Delegacao por automacao      acao `atribuir_responsavel` de um fluxo
//   Rodizio de chips             lib/disparo/ritmo.ts, entre NUMEROS
//
// ————————————————————————————————————————————————————————————————————————
// A DECISAO QUE MANDA NO DESENHO: **a fila FILTRA, ela nao escolhe.**
//
// O painel JA tem distribuicao automatica (`lib/rodizio.ts`: candidato = perfil
// ativo visto nos ultimos 5 min; carga = conversas em andamento; vence a menor
// carga, desempate deterministico por `user_id`). Esta frente NAO troca esse
// criterio por round-robin estrito, e a razao e dupla:
//
//   1. trocar o criterio de uma feature que ja roda em producao seria mudanca
//      SILENCIOSA de comportamento — ninguem pediu, e apareceria como "o painel
//      comecou a distribuir diferente" no dia do deploy;
//   2. "balanceamento por carga" esta em FORA DE ESCOPO no card no sentido de
//      **nao construir**, nao no sentido de **remover o que existe**.
//
// Entao o contrato e: o rodizio entrega o RANKING (a ordem de preferencia que
// ele ja calcula) e este arquivo diz quem daquele ranking esta disponivel.
// "O proximo da fila" = o primeiro do ranking que nao esta fora e nao pulou.
//
// ————————————————————————————————————————————————————————————————————————
// SEM LINHA NA TABELA = **DENTRO** da fila.
//
// Ligar o modulo da CONTROLE, nao muda quem recebe. Se o default fosse "fora",
// ligar o modulo pararia a distribuicao da instalacao inteira até cada pessoa
// clicar em "entrar" — e ninguem saberia por que as conversas pararam de cair.
// Sair da fila e um gesto EXPLICITO, e e ele que grava a linha.
//
// ————————————————————————————————————————————————————————————————————————
// PULAR A VEZ — a semantica exata, porque "rodada seguinte" e ambiguo.
//
// O card diz: "marca 'pular a vez' e volta a receber na rodada seguinte, SEM
// sair da fila". A leitura honesta e literal: a pessoa passa UMA vez, quando a
// vez dela chegar. Por isso o pulo e CONSUMIDO so quando a vez dela de fato
// chega — ou seja, quando ela seria a escolhida (esta na frente do ranking
// entre os disponiveis).
//
// A alternativa (consumir o pulo em toda distribuicao que acontecer) seria
// errada de um jeito difícil de ver: numa operacao movimentada, o pulo de quem
// esta no fim do ranking queimaria em segundos sem que a vez dele tivesse
// chegado — "pular a vez" viraria "esperar dois segundos".
//
// Corolario que a prova trava: quando NINGUEM fica disponivel (todos pularam),
// os pulos de todos os que foram percorridos SAO consumidos. A vez deles chegou
// e passou; a conversa fica sem responsavel (visivel pra instalacao inteira,
// regra de lib/visibilidade.ts) e a proxima cai pra eles.
//
// ————————————————————————————————————————————————————————————————————————
// O PULO EXPIRA, e isso e decisao declarada.
//
// Pulo marcado numa quinta-feira as 18h que ninguem consumiu (ninguem escreveu
// pra empresa a noite) tiraria a pessoa da distribuicao na manha seguinte, sem
// ela lembrar de ter marcado. Depois de `TTL_PULO_MS` o pulo e INERTE — e
// `situacao()` volta a dizer "dentro", entao a tela dela e a do gestor param de
// mostrar "pulou" ao mesmo tempo em que o efeito para. Estado que a tela mostra
// e estado que vale: um sem o outro e a mentira classica de interruptor.

/** Situacao de UMA pessoa na fila, ja resolvida no tempo. */
export type SituacaoFila = "dentro" | "fora" | "pulou";

/** A linha de `mensageria.atendente_fila` (uma por pessoa COM estado gravado). */
export type EstadoFila = {
  user_id: string;
  dentro: boolean;
  pular_vez: boolean;
  /** quando o pulo foi marcado (ISO). null = marcado por uma versao sem carimbo. */
  pular_desde: string | null;
};

/** Depois disso o pulo nao vale mais. Ver o cabecalho. */
export const TTL_PULO_MS = 12 * 60 * 60 * 1000;

export const ACOES_FILA = ["entrar", "sair", "pular", "voltar"] as const;
export type AcaoFila = (typeof ACOES_FILA)[number];

export function ehAcaoFila(v: unknown): v is AcaoFila {
  return typeof v === "string" && (ACOES_FILA as readonly string[]).includes(v);
}

/** O que vale pra quem nunca gravou nada: DENTRO da fila, sem pulo. */
export function estadoPadrao(user_id: string): EstadoFila {
  return { user_id, dentro: true, pular_vez: false, pular_desde: null };
}

/**
 * Sanea uma linha crua (banco ou corpo de rota).
 *
 * `dentro` so sai de `true` com um `false` BOOLEANO de verdade — a string
 * `"false"` e truthy em JavaScript, e aceita-la deixaria alguem fora da fila por
 * um valor torto (defeito ja pago neste repo em `bot_ativo`, ver CLAUDE.md).
 * Mesmo raciocinio no outro sentido pra `pular_vez`: so `true` liga o pulo.
 */
export function normalizarEstado(bruto: unknown, user_id?: string): EstadoFila | null {
  const b = bruto && typeof bruto === "object" && !Array.isArray(bruto) ? (bruto as any) : null;
  const id = typeof b?.user_id === "string" && b.user_id ? b.user_id : user_id;
  if (typeof id !== "string" || !id) return null;
  return {
    user_id: id,
    dentro: b?.dentro === false ? false : true,
    pular_vez: b?.pular_vez === true,
    pular_desde: typeof b?.pular_desde === "string" && b.pular_desde ? b.pular_desde : null,
  };
}

/** O pulo ainda esta valendo neste instante? */
export function puloVigente(e: EstadoFila, agoraMs: number): boolean {
  if (!e.pular_vez) return false;
  if (!e.pular_desde) return true; // sem carimbo, o pulo vale (fail-closed do lado de quem pediu pra passar)
  const t = Date.parse(e.pular_desde);
  // carimbo ILEGIVEL nao apaga o pedido da pessoa: ela marcou "passa a minha
  // vez", e ignorar isso mandaria conversa pra quem disse que nao podia atender.
  if (!Number.isFinite(t)) return true;
  return agoraMs - t < TTL_PULO_MS;
}

/** A situacao que a tela mostra (dela e do gestor) e que o filtro obedece. */
export function situacao(e: EstadoFila, agoraMs: number): SituacaoFila {
  if (!e.dentro) return "fora";
  return puloVigente(e, agoraMs) ? "pulou" : "dentro";
}

/**
 * Aplica um gesto da pessoa. `agoraIso` entra como argumento (nunca
 * `Date.now()` aqui dentro) pra funcao seguir pura e provavel.
 *
 * SAIR limpa o pulo: quem saiu da fila nao "tem uma vez pendente pra pular", e
 * deixar a marca la faria a pessoa voltar pra fila ja pulando a primeira vez
 * sem ter pedido isso.
 */
export function aplicarAcao(e: EstadoFila, acao: AcaoFila, agoraIso: string): EstadoFila {
  switch (acao) {
    case "entrar":
      return { ...e, dentro: true };
    case "sair":
      return { ...e, dentro: false, pular_vez: false, pular_desde: null };
    case "pular":
      // pular exige estar DENTRO — o card e explicito ("sem sair da fila").
      // Marcar pulo em quem esta fora gravaria estado que nao significa nada.
      return e.dentro ? { ...e, pular_vez: true, pular_desde: agoraIso } : e;
    case "voltar":
      return { ...e, pular_vez: false, pular_desde: null };
  }
}

/** Gesto que nao muda nada tem que dizer POR QUE — botao que "funciona" e nao faz nada e pior que botao ausente. */
export function motivoAcaoInerte(e: EstadoFila, acao: AcaoFila, agoraMs: number): string | null {
  const s = situacao(e, agoraMs);
  if (acao === "entrar" && e.dentro) return "voce ja esta na fila";
  if (acao === "sair" && !e.dentro) return "voce ja esta fora da fila";
  if (acao === "pular" && !e.dentro) return "pra pular a vez e preciso estar na fila";
  if (acao === "pular" && s === "pulou") return "sua vez ja esta marcada pra ser pulada";
  if (acao === "voltar" && s !== "pulou") return "voce nao tem vez marcada pra pular";
  return null;
}

// ————————————————————————————————————————————————————————————————— a escolha

export type MotivoSemEscolha =
  /** o rodizio nao trouxe candidato nenhum (ninguem online / todos no teto) */
  | "sem_candidato"
  /** todo mundo do ranking esta FORA da fila */
  | "fila_vazia"
  /** os disponiveis pularam a vez (os pulos foram consumidos) */
  | "todos_pularam";

export type ResultadoFila = {
  /** quem recebe, ou null */
  escolhido: string | null;
  /** pulos que a rodada CONSUMIU (o chamador tem que zerar estes no banco) */
  pulos_consumidos: string[];
  /** quem foi ignorado por estar fora da fila (vira log, nao erro) */
  fora: string[];
  motivo: MotivoSemEscolha | null;
  /** a fila realmente decidiu algo? false = o modulo esta desligado */
  via_fila: boolean;
};

/**
 * Quem, do ranking, recebe a conversa.
 *
 * `ranking` = a ordem de preferencia que `lib/rodizio.ts` ja calcula (menor
 * carga, desempate por `user_id`), JA filtrada pelo teto por atendente.
 *
 * `ativo: false` (modulo desligado) devolve o primeiro do ranking sem tocar em
 * estado nenhum: comportamento IDENTICO ao de antes desta frente. E o que faz
 * "instalacao que nao ligou o modulo nao muda de comportamento" ser verdade em
 * codigo, e nao so no texto.
 */
export function escolherNaFila(
  ranking: readonly string[],
  estados: ReadonlyMap<string, EstadoFila>,
  agoraMs: number,
  opts: { ativo: boolean }
): ResultadoFila {
  if (!opts.ativo) {
    return {
      escolhido: ranking[0] ?? null,
      pulos_consumidos: [],
      fora: [],
      motivo: ranking.length ? null : "sem_candidato",
      via_fila: false,
    };
  }
  const pulos_consumidos: string[] = [];
  const fora: string[] = [];
  for (const uid of ranking) {
    const e = estados.get(uid) ?? estadoPadrao(uid);
    const s = situacao(e, agoraMs);
    if (s === "fora") {
      fora.push(uid);
      continue;
    }
    if (s === "pulou") {
      // A VEZ DELE CHEGOU: o pulo e consumido aqui e so aqui. Ver o cabecalho.
      pulos_consumidos.push(uid);
      continue;
    }
    return { escolhido: uid, pulos_consumidos, fora, motivo: null, via_fila: true };
  }
  const motivo: MotivoSemEscolha = !ranking.length
    ? "sem_candidato"
    : pulos_consumidos.length
    ? "todos_pularam"
    : "fila_vazia";
  return { escolhido: null, pulos_consumidos, fora, motivo, via_fila: true };
}

// ——————————————————————————————————————————————————————— painel do gestor

export type LinhaPainelFila = {
  user_id: string;
  nome: string;
  situacao: SituacaoFila;
  /** desde quando esta pulando (ISO) — null fora do estado "pulou" */
  pulou_desde: string | null;
  /** visto nos ultimos minutos pela presenca do painel */
  online: boolean;
};

/**
 * Monta o painel "quem esta na fila, quem esta fora e quem pulou" (criterio do
 * card). ORDEM ESTAVEL: pulou primeiro, fora depois, dentro por ultimo, e nome
 * como desempate — quem abre isso quer ver primeiro quem NAO vai receber.
 *
 * A lista de pessoas vem de fora (perfis ativos): quem nunca gravou estado
 * aparece como "dentro", que e a verdade — nao aparecer daria a impressao de
 * que a pessoa esta fora da distribuicao.
 */
export function painelDaFila(
  pessoas: ReadonlyArray<{ user_id: string; nome: string; online?: boolean }>,
  estados: ReadonlyMap<string, EstadoFila>,
  agoraMs: number
): LinhaPainelFila[] {
  const peso: Record<SituacaoFila, number> = { pulou: 0, fora: 1, dentro: 2 };
  return pessoas
    .map((p) => {
      const e = estados.get(p.user_id) ?? estadoPadrao(p.user_id);
      const s = situacao(e, agoraMs);
      return {
        user_id: p.user_id,
        nome: p.nome || "Atendente",
        situacao: s,
        pulou_desde: s === "pulou" ? e.pular_desde : null,
        online: p.online === true,
      };
    })
    .sort((a, b) => peso[a.situacao] - peso[b.situacao] || a.nome.localeCompare(b.nome));
}

/** Contagem por situacao, pro cabecalho do painel. */
export function contarFila(linhas: readonly LinhaPainelFila[]): Record<SituacaoFila, number> {
  const out: Record<SituacaoFila, number> = { dentro: 0, fora: 0, pulou: 0 };
  for (const l of linhas) out[l.situacao] += 1;
  return out;
}

/** Frase que a pessoa le no proprio controle. Uma fonte so pras duas telas. */
export function frasePropria(s: SituacaoFila): string {
  if (s === "fora") return "Voce esta FORA da fila — conversa nova nao cai pra voce.";
  if (s === "pulou") return "Sua proxima vez sera PULADA. Voce continua na fila.";
  return "Voce esta na fila e pode receber conversa nova.";
}
