// Ciclo de vida da campanha — PURO (nao importa nada; roda em node solto).
//
// Estados: rascunho | agendada | rodando | pausada | concluida | cancelada
//
// A REGRA DE PRODUTO que este arquivo carrega (docs/disparo.md): disparo em
// massa NAO comeca sozinho. A campanha so sai de `rascunho` por acao explicita
// de uma pessoa com permissao de disparo — nao existe caminho automatico de
// rascunho pra rodando, nem por cron, nem por importacao, nem por agendamento.
// O agendamento so vale DEPOIS da aprovacao (rascunho -> agendada e um gesto
// humano; agendada -> rodando e o relogio cumprindo o que a pessoa aprovou).

export const ESTADOS = [
  "rascunho",
  "agendada",
  "rodando",
  "pausada",
  "concluida",
  "cancelada",
] as const;
export type EstadoCampanha = (typeof ESTADOS)[number];

export function estadoValido(v: unknown): v is EstadoCampanha {
  return typeof v === "string" && (ESTADOS as readonly string[]).includes(v);
}

/** Estados a partir dos quais nada mais acontece. */
export const TERMINAIS: EstadoCampanha[] = ["concluida", "cancelada"];

// Transicoes permitidas. `humano` = exige acao explicita de uma pessoa com
// permissao (o tick NUNCA faz essas). As demais o motor pode fazer sozinho.
type Transicao = { de: EstadoCampanha; para: EstadoCampanha; humano: boolean };

const TRANSICOES: Transicao[] = [
  // aprovacao — o gesto que autoriza o disparo. So humano, sempre.
  { de: "rascunho", para: "agendada", humano: true },
  { de: "rascunho", para: "rodando", humano: true },
  // o relogio cumprindo o que ja foi aprovado
  { de: "agendada", para: "rodando", humano: false },
  // pausar/retomar
  { de: "rodando", para: "pausada", humano: true },
  { de: "agendada", para: "pausada", humano: true },
  { de: "pausada", para: "rodando", humano: true },
  // fim natural: a fila acabou
  { de: "rodando", para: "concluida", humano: false },
  // cancelar: de qualquer estado nao-terminal
  { de: "rascunho", para: "cancelada", humano: true },
  { de: "agendada", para: "cancelada", humano: true },
  { de: "rodando", para: "cancelada", humano: true },
  { de: "pausada", para: "cancelada", humano: true },
];

export type Autor = "humano" | "motor";

export type Resultado = { ok: true } | { ok: false; motivo: string };

/**
 * Esta transicao pode acontecer?
 *
 * `historico: true` (campanha importada de outra ferramenta) recusa TUDO: ela e
 * registro, nao campanha. A mesma regra esta no CHECK da migration 0012 — aqui
 * pra dar mensagem legivel, la pra ser inviolavel.
 */
export function podeTransicionar(
  de: unknown,
  para: unknown,
  opcoes: { autor: Autor; historico?: boolean }
): Resultado {
  if (!estadoValido(de)) return { ok: false, motivo: `estado atual desconhecido: ${String(de)}` };
  if (!estadoValido(para)) return { ok: false, motivo: `estado alvo desconhecido: ${String(para)}` };
  if (opcoes.historico) {
    return { ok: false, motivo: "campanha historica e registro importado: nao dispara em nenhuma condicao" };
  }
  if (de === para) return { ok: false, motivo: `a campanha ja esta em "${de}"` };
  if (TERMINAIS.includes(de)) return { ok: false, motivo: `campanha ${de} nao muda mais de estado` };

  const t = TRANSICOES.find((x) => x.de === de && x.para === para);
  if (!t) return { ok: false, motivo: `nao da pra ir de "${de}" para "${para}"` };
  if (t.humano && opcoes.autor !== "humano") {
    return {
      ok: false,
      motivo: `so uma pessoa com permissao de disparo pode levar a campanha de "${de}" para "${para}"`,
    };
  }
  return { ok: true };
}

/** Estados em que o tick tem trabalho a fazer. */
export function aceitaTick(estado: EstadoCampanha): boolean {
  return estado === "rodando" || estado === "agendada";
}

/**
 * O que o tick faz com uma campanha `agendada`: virou a hora?
 * Sem `agendada_para`, campanha agendada NUNCA comeca sozinha (o agendamento e
 * o que autoriza o relogio; sem hora marcada nao ha o que cumprir).
 */
export function horaDeComecar(agendadaPara: string | null | undefined, agora: Date): boolean {
  if (!agendadaPara) return false;
  const t = new Date(agendadaPara);
  if (isNaN(t.getTime())) return false;
  return t.getTime() <= agora.getTime();
}
