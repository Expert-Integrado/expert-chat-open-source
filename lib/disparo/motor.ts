// Motor do disparo — o que UMA chamada do tick faz.
//
// A DIVISAO DE RESPONSABILIDADE, depois da revisao de 31/08/2026:
//   - QUANTOS saem agora .................. lib/disparo/ritmo.ts   (puro)
//   - COMO o lote corre (reserva, parada,
//     retry, opt-out) ..................... lib/disparo/lote.ts    (puro, porta injetada)
//   - COM QUEM falar (banco e provedor) ... este arquivo
//
// Este arquivo praticamente nao decide nada: ele monta a `PortaLote` que fala
// com o banco e com o provedor, e obedece. E o que permite provar a CORRIDA
// entre dois ticks em memoria, sem rede.
//
// AUTORIZACAO mora SO na rota: quem chama o tick — cron ou super admin — ja
// autorizou. Aqui nao ha checagem de usuario, e nao existe caminho automatico
// que tire campanha do rascunho (`podeTransicionar` recusa o autor "motor").

import { msgDb } from "@/lib/mensageria";
import { canalPorId } from "@/lib/canais";
import { decidirEnvios, inicioDoDia, normalizarRitmo } from "@/lib/disparo/ritmo";
import { aceitaTick, horaDeComecar, podeTransicionar, type EstadoCampanha } from "@/lib/disparo/estado";
import { aplicarVariaveis, type ItemPublico } from "@/lib/disparo/csv";
import { enviarDestino, gravarSaida, motivoCanalNaoEnviaAsync } from "@/lib/disparo/envio";
import { estaBloqueado } from "@/lib/disparo/bloqueio";
import {
  executarLote,
  lockDisponivel,
  LIMITE_LOCK_MS,
  LIMITE_RESERVA_MS,
  MAX_TENTATIVAS,
  type DestinoLote,
  type PortaLote,
} from "@/lib/disparo/lote";

export type Campanha = {
  id: string;
  nome: string;
  canal: string;
  mensagem: string;
  estado: EstadoCampanha;
  agendada_para: string | null;
  lote: number;
  intervalo_s: number;
  teto_por_numero_dia: number;
  historico: boolean;
  tick_lock_em?: string | null;
};

export type ResumoTick = {
  campanha_id: string;
  nome: string;
  enviados: number;
  falhas: number;
  restantes: number;
  estado: EstadoCampanha;
  motivo: string | null;
  causa: string;
};

// Orcamento de tempo da rodada (maxDuration da rota e 60s).
const ORCAMENTO_MS = 45_000;
const LOTES_DE = 200;

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Envios que ja sairam HOJE por este canal, somando TODAS as campanhas.
 *
 * FAIL-CLOSED (achado da revisao): antes esta funcao ignorava `error` e devolvia
 * `count ?? 0` — ou seja, um erro de banco virava "nada foi enviado hoje" e o
 * teto do chip sumia justamente no momento em que ninguem estava olhando. Um
 * freio que falha aberto nao e freio. Agora ela LANCA, e o chamador nao envia.
 */
export async function enviadosHojeNoCanal(canal: string): Promise<number> {
  const db = msgDb();
  const desde = inicioDoDia();

  // so campanhas VIVAS deste canal: as historicas (134 na base da Expert) nunca
  // enviaram nada por aqui e so engordavam o `in()`
  const { data: campanhas, error: e1 } = await db
    .from("campanhas")
    .select("id")
    .eq("canal", canal)
    .eq("historico", false);
  if (e1) throw new Error(`nao deu pra apurar o teto diario do canal: ${e1.message}`);

  const ids = (campanhas ?? []).map((c: any) => c.id);
  if (!ids.length) return 0;

  // fatiado: `in()` com centenas de ids estoura a URL do PostgREST (gotcha ja
  // pago neste repo, em /api/chats e no sync de allowlist)
  let total = 0;
  for (let i = 0; i < ids.length; i += LOTES_DE) {
    const { count, error } = await db
      .from("campanha_destinos")
      .select("id", { count: "exact", head: true })
      .in("campanha_id", ids.slice(i, i + LOTES_DE))
      .gte("enviado_em", desde)
      .in("estado", ["enviado", "respondeu"]);
    if (error) throw new Error(`nao deu pra apurar o teto diario do canal: ${error.message}`);
    total += count ?? 0;
  }
  return total;
}

/**
 * Devolve pra fila as reservas orfas (tick que morreu no meio do lote).
 * Sem isto, um deploy no meio de uma rodada deixaria os destinos reservados
 * presos em `enviando` pra sempre.
 */
export async function liberarReservasOrfas(campanhaId?: string): Promise<number> {
  const limite = new Date(Date.now() - LIMITE_RESERVA_MS).toISOString();
  let q = msgDb()
    .from("campanha_destinos")
    .update({ estado: "pendente", reservado_em: null })
    .eq("estado", "enviando")
    .lt("reservado_em", limite)
    .select("id");
  if (campanhaId) q = q.eq("campanha_id", campanhaId);
  const { data, error } = await q;
  if (error) return 0;
  return (data ?? []).length;
}

/**
 * Marca como `respondeu` quem mandou mensagem DEPOIS de receber o disparo — e
 * DESCADASTRA quem pediu pra sair.
 *
 * DECISAO (docs/disparo.md): a deteccao acontece na LEITURA e nao por hook na
 * ingestao, porque a entrada tem tres portas (webhook Z-API, sync do canal
 * oficial, Evolution) e a regra divergiria na primeira porta nova.
 */
export async function marcarRespostas(campanhaId: string, canal: string): Promise<number> {
  const def = canalPorId(canal);
  if (!def) return 0;
  const db = msgDb();
  const { data: enviados } = await db
    .from("campanha_destinos")
    .select("id,chat_id,telefone,enviado_em")
    .eq("campanha_id", campanhaId)
    .eq("estado", "enviado")
    .not("enviado_em", "is", null)
    .limit(1000);
  if (!enviados?.length) return 0;

  const maisAntigo = enviados.reduce(
    (min: string, d: any) => (d.enviado_em < min ? d.enviado_em : min),
    enviados[0].enviado_em as string
  );

  // fatiado pelo mesmo motivo do teto: `in()` com 1000 ids estoura a URL
  const entradas: any[] = [];
  const chats = enviados.map((d: any) => d.chat_id);
  for (let i = 0; i < chats.length; i += LOTES_DE) {
    const { data } = await db
      .from(def.tabelas.mensagens)
      .select("chat_id,conteudo,criada_em")
      .eq("direcao", "in")
      .gte("criada_em", maisAntigo)
      .in("chat_id", chats.slice(i, i + LOTES_DE))
      .limit(5000);
    if (data?.length) entradas.push(...data);
  }
  if (!entradas.length) return 0;

  // primeira entrada de cada chat depois do envio
  const primeira = new Map<string, { em: string; texto: string }>();
  for (const m of entradas) {
    const atual = primeira.get(m.chat_id);
    if (!atual || m.criada_em < atual.em) {
      primeira.set(m.chat_id, { em: m.criada_em, texto: m.conteudo ?? "" });
    }
  }

  const { pedidoDeDescadastro } = await import("@/lib/disparo/optout");
  const { bloquear } = await import("@/lib/disparo/bloqueio");

  let marcados = 0;
  for (const d of enviados as any[]) {
    const resp = primeira.get(d.chat_id);
    if (!resp || resp.em <= d.enviado_em) continue;

    // quem respondeu pedindo pra sair entra na lista de bloqueio NA HORA
    const palavra = pedidoDeDescadastro(resp.texto);
    if (palavra) {
      await bloquear({
        telefone: d.telefone || d.chat_id,
        origem: "resposta",
        motivo: palavra,
      }).catch(() => null);
    }

    await db
      .from("campanha_destinos")
      .update({
        estado: palavra ? "optout" : "respondeu",
        respondeu_em: resp.em,
      })
      .eq("id", d.id)
      .eq("estado", "enviado");
    marcados++;
  }
  return marcados;
}

/**
 * Tenta tomar o lock do tick pra esta campanha.
 * Devolve o CARIMBO gravado (pra soltar so o proprio lock depois) ou null.
 */
async function tomarLock(c: Campanha, agora: Date): Promise<string | null> {
  if (!lockDisponivel(c.tick_lock_em, agora.getTime(), LIMITE_LOCK_MS)) return null;
  const limite = new Date(agora.getTime() - LIMITE_LOCK_MS).toISOString();
  // condicional: so pega quem o UPDATE devolver. Dois ticks simultaneos —
  // exatamente um vence.
  const carimbo = agora.toISOString();
  const { data } = await msgDb()
    .from("campanhas")
    .update({ tick_lock_em: carimbo })
    .eq("id", c.id)
    .or(`tick_lock_em.is.null,tick_lock_em.lt.${limite}`)
    .select("id");
  return (data ?? []).length ? carimbo : null;
}

/**
 * Solta o lock — SO se ele ainda for o desta rodada.
 *
 * Sem a guarda, um tick que passou dos 90s do LIMITE_LOCK_MS derrubava o lock do
 * SUCESSOR ao terminar: o lock legitimo do tick novo era apagado por um tick
 * velho saindo, e a campanha voltava a aceitar dois ticks ao mesmo tempo — o
 * problema que o lock existe pra evitar.
 */
async function soltarLock(campanhaId: string, carimbo: string): Promise<void> {
  await msgDb()
    .from("campanhas")
    .update({ tick_lock_em: null })
    .eq("id", campanhaId)
    .eq("tick_lock_em", carimbo);
}

/**
 * Muda o estado da campanha com GUARDA do estado esperado.
 *
 * Achado da revisao: o update final gravava `concluida` sem `.eq("estado", ...)`,
 * entao uma campanha CANCELADA no meio do lote voltava a `concluida` — o
 * cancelamento sumia do registro. Todo update de estado passa por aqui.
 */
async function mudarEstado(
  campanhaId: string,
  de: EstadoCampanha,
  para: EstadoCampanha,
  extra: Record<string, any> = {}
): Promise<boolean> {
  const { data } = await msgDb()
    .from("campanhas")
    .update({ estado: para, atualizada_em: new Date().toISOString(), ...extra })
    .eq("id", campanhaId)
    .eq("estado", de)
    .select("id");
  return !!(data ?? []).length;
}

/** Processa UMA campanha nesta chamada. Nunca lanca. */
export async function processarCampanha(c: Campanha, agora = new Date()): Promise<ResumoTick> {
  const db = msgDb();
  const base = { campanha_id: c.id, nome: c.nome, enviados: 0, falhas: 0 };

  if (c.historico) {
    return { ...base, restantes: 0, estado: c.estado, motivo: "registro historico: nao dispara", causa: "historico" };
  }

  let estado = c.estado;

  // agendada cuja hora chegou vira rodando — o relogio so CUMPRE o que uma
  // pessoa ja aprovou
  if (estado === "agendada") {
    if (!horaDeComecar(c.agendada_para, agora)) {
      return { ...base, restantes: 0, estado, motivo: "aguardando a hora agendada", causa: "agendada" };
    }
    const t = podeTransicionar(estado, "rodando", { autor: "motor" });
    if (!t.ok) return { ...base, restantes: 0, estado, motivo: t.motivo, causa: "recusado" };
    const virou = await mudarEstado(c.id, "agendada", "rodando", { iniciada_em: agora.toISOString() });
    if (!virou) {
      // alguem pausou/cancelou entre a leitura e agora
      return { ...base, restantes: 0, estado, motivo: "a campanha mudou de estado durante o tick", causa: "corrida" };
    }
    estado = "rodando";
  }

  // LOCK por campanha: dois ticks nao disputam a mesma fila
  const carimboLock = await tomarLock({ ...c, estado }, agora);
  if (!carimboLock) {
    return { ...base, restantes: 0, estado, motivo: "outro tick ja esta processando esta campanha", causa: "lock" };
  }

  try {
    // reservas orfas de rodadas que morreram no meio voltam pra fila
    await liberarReservasOrfas(c.id);

    // canal sem envio cabeado: PAUSA com motivo de configuracao em vez de
    // queimar a fila em N falhas identicas. Guarda ASSINCRONO: o `apioficial`
    // escapava do sincrono pelo fallback historico do envioDisponivel.
    const impedimento = await motivoCanalNaoEnviaAsync(c.canal);
    if (impedimento) {
      await mudarEstado(c.id, estado, "pausada", { erro: impedimento });
      return { ...base, restantes: 0, estado: "pausada", motivo: impedimento, causa: "configuracao" };
    }
    const def = canalPorId(c.canal)!;

    const [contagemPendentes, ultimo] = await Promise.all([
      db
        .from("campanha_destinos")
        .select("id", { count: "exact", head: true })
        .eq("campanha_id", c.id)
        .eq("estado", "pendente"),
      db
        .from("campanha_destinos")
        .select("enviado_em")
        .eq("campanha_id", c.id)
        .not("enviado_em", "is", null)
        .order("enviado_em", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    // FAIL-CLOSED na CONTAGEM DA FILA (achado da revisao): um solucao de banco
    // devolvia count null -> 0, e 0 pendente fazia a campanha ser gravada como
    // `concluida` — estado TERMINAL e irreversivel — com destino ainda na fila.
    // Mesmo raciocinio do teto: se nao da pra contar, nao decide nada.
    if (contagemPendentes.error) {
      return {
        ...base,
        restantes: 0,
        estado,
        motivo: `nao deu pra contar a fila (${contagemPendentes.error.message}) — nao enviei e nao concluí nada nesta rodada`,
        causa: "fila_indisponivel",
      };
    }
    const pendentes = contagemPendentes.count ?? 0;

    // FAIL-CLOSED: erro na contagem do teto = nao envia nesta rodada
    let hoje: number;
    try {
      hoje = await enviadosHojeNoCanal(c.canal);
    } catch (e: any) {
      return {
        ...base,
        restantes: pendentes,
        estado,
        motivo: `${e?.message || e} — nao enviei nada nesta rodada (o freio do teto falha FECHADO)`,
        causa: "teto_indisponivel",
      };
    }

    const ritmo = normalizarRitmo(c);
    const decisao = decidirEnvios(
      ritmo,
      {
        pendentes,
        enviados_hoje_no_canal: hoje,
        ultimo_envio_em: (ultimo.data as any)?.enviado_em ?? null,
      },
      agora
    );

    if (decisao.encerrar) {
      // guarda de estado: campanha cancelada no meio NAO vira concluida
      if (podeTransicionar(estado, "concluida", { autor: "motor" }).ok) {
        const virou = await mudarEstado(c.id, estado, "concluida", { concluida_em: agora.toISOString() });
        if (virou) estado = "concluida";
      }
      await marcarRespostas(c.id, c.canal).catch(() => 0);
      return { ...base, restantes: 0, estado, motivo: null, causa: decisao.causa };
    }

    if (decisao.enviar <= 0) {
      return { ...base, restantes: pendentes, estado, motivo: decisao.motivo, causa: decisao.causa };
    }

    // ---------------- a porta do laco (lib/disparo/lote.ts) ----------------
    const porta: PortaLote = {
      async estadoDaCampanha() {
        const { data } = await db.from("campanhas").select("estado").eq("id", c.id).maybeSingle();
        return (data as any)?.estado ?? "cancelada"; // sumiu = para
      },
      async candidatos(quantidade) {
        // pede mais que o lote: parte pode ser reservada por outro tick
        const { data } = await db
          .from("campanha_destinos")
          .select("id,chat_id,telefone,nome,variaveis,tentativas")
          .eq("campanha_id", c.id)
          .eq("estado", "pendente")
          .order("criada_em")
          .limit(Math.min(200, quantidade * 2));
        return (data ?? []) as DestinoLote[];
      },
      async reservar(d) {
        // CLAIM ATOMICO: so envia o que este UPDATE devolver
        const { data } = await db
          .from("campanha_destinos")
          .update({ estado: "enviando", reservado_em: new Date().toISOString() })
          .eq("id", d.id)
          .eq("estado", "pendente")
          .select("id,chat_id,telefone,nome,variaveis,tentativas");
        const linha = (data ?? [])[0];
        return linha ? (linha as DestinoLote) : null;
      },
      async bloqueado(d) {
        return estaBloqueado(d.telefone || d.chat_id);
      },
      async marcarOptout(d) {
        await db
          .from("campanha_destinos")
          .update({ estado: "optout", erro: "na lista de bloqueio (pediu para nao receber)" })
          .eq("id", d.id)
          .eq("estado", "enviando");
      },
      async enviar(d) {
        const item: ItemPublico = {
          chat_id: d.chat_id,
          telefone: d.telefone || "",
          nome: d.nome || "",
          variaveis: (d.variaveis as any) || undefined,
        };
        const texto = aplicarVariaveis(c.mensagem, item);
        const r = await enviarDestino(c.canal, d.chat_id, texto);
        if (r.ok) {
          try {
            await gravarSaida({
              canal: def,
              chatId: d.chat_id,
              nome: d.nome,
              texto,
              providerMsgId: r.provider_msg_id,
              campanhaNome: c.nome,
            });
          } catch (e: any) {
            // a mensagem JA SAIU: falhar a gravacao nao pode virar reenvio
            console.error("disparo: saida gravada parcialmente", { campanha: c.id, erro: e?.message });
          }
          return { ok: true, provider_msg_id: r.provider_msg_id };
        }
        return { ok: false, erro: r.erro, configuracao: r.configuracao };
      },
      async registrarEnvio(d, provider_msg_id) {
        await db
          .from("campanha_destinos")
          .update({
            estado: "enviado",
            enviado_em: new Date().toISOString(),
            provider_msg_id,
            reservado_em: null,
            erro: null,
          })
          .eq("id", d.id)
          .eq("estado", "enviando");
      },
      async registrarFalha(d, desfecho) {
        await db
          .from("campanha_destinos")
          .update({
            estado: desfecho.estado,
            tentativas: desfecho.tentativas,
            erro: desfecho.erro.slice(0, 300),
            reservado_em: null,
          })
          .eq("id", d.id)
          .eq("estado", "enviando");
      },
      async devolverReserva(d) {
        await db
          .from("campanha_destinos")
          .update({ estado: "pendente", reservado_em: null })
          .eq("id", d.id)
          .eq("estado", "enviando");
      },
      agora: () => Date.now(),
      esperar: dormir,
    };

    const resultado = await executarLote(porta, {
      quantidade: decisao.enviar,
      intervaloS: ritmo.intervalo_s,
      orcamentoMs: ORCAMENTO_MS,
      maxTentativas: MAX_TENTATIVAS,
    });

    // estado REAL depois do lote (pode ter sido pausada/cancelada no meio)
    const { data: atual } = await db.from("campanhas").select("estado").eq("id", c.id).maybeSingle();
    estado = ((atual as any)?.estado ?? estado) as EstadoCampanha;

    const { count: restantes } = await db
      .from("campanha_destinos")
      .select("id", { count: "exact", head: true })
      .eq("campanha_id", c.id)
      .in("estado", ["pendente", "enviando"]);

    // conclui SO se ainda estiver rodando — guarda de estado
    if ((restantes ?? 0) === 0 && estado === "rodando") {
      const virou = await mudarEstado(c.id, "rodando", "concluida", { concluida_em: new Date().toISOString() });
      if (virou) estado = "concluida";
    }

    await marcarRespostas(c.id, c.canal).catch(() => 0);

    const motivo =
      resultado.motivo ??
      decisao.motivo ??
      (resultado.bloqueados ? `${resultado.bloqueados} destino(s) pulado(s) por estarem na lista de bloqueio` : null);

    return {
      campanha_id: c.id,
      nome: c.nome,
      enviados: resultado.enviados,
      falhas: resultado.falhas,
      restantes: restantes ?? 0,
      estado,
      motivo,
      causa: resultado.interrompido ? "interrompido" : decisao.causa,
    };
  } finally {
    await soltarLock(c.id, carimboLock).catch(() => null);
  }
}

/**
 * Uma rodada completa: pega as campanhas que aceitam tick e processa em ordem.
 * A primeira que tiver trabalho leva a rodada (o orcamento e da rodada).
 */
export async function processarTick(agora = new Date()): Promise<{ processadas: ResumoTick[]; erro?: string }> {
  const db = msgDb();
  const { data, error } = await db
    .from("campanhas")
    .select(
      "id,nome,canal,mensagem,estado,agendada_para,lote,intervalo_s,teto_por_numero_dia,historico,tick_lock_em"
    )
    .eq("historico", false)
    .in("estado", ["rodando", "agendada"])
    .order("atualizada_em", { ascending: true })
    .limit(10);

  if (error) {
    return { processadas: [], erro: "campanhas indisponiveis (a migration 0012 ja foi aplicada nesta instalacao?)" };
  }

  const fila = (data ?? []).filter((c: any) => aceitaTick(c.estado));
  if (!fila.length) return { processadas: [] };

  const processadas: ResumoTick[] = [];
  for (const c of fila as Campanha[]) {
    const r = await processarCampanha(c, agora);
    processadas.push(r);
    if (r.enviados > 0 || r.falhas > 0) break;
  }
  return { processadas };
}
