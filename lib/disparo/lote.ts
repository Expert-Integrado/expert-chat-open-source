// O LACO DE UM LOTE — reserva, interrupcao e retry, SEM rede.
//
// Este arquivo nao importa nada de proposito (mesma escolha de lib/fluxo/
// schema.ts): ele descreve o protocolo do tick contra uma PORTA injetada, e por
// isso a corrida entre dois ticks pode ser provada em memoria, sem banco e sem
// mandar mensagem nenhuma (`scripts/prova-disparo.ts`).
//
// O QUE ESTE PROTOCOLO RESOLVE (achados da revisao de 31/08/2026):
//
// 1. RESERVA ATOMICA (claim). A versao anterior lia N pendentes e enviava os N.
//    Dois ticks simultaneos liam a MESMA fila e mandavam a MESMA mensagem duas
//    vezes — e ainda decidiam lote/intervalo/teto sobre leitura velha. Agora
//    cada destino e reservado um a um (`pendente -> enviando`, condicional) e
//    **so e enviado o que a reserva devolveu**. Quem perdeu a corrida pula.
// 2. INTERRUPCAO. Pausar/cancelar nao parava o lote em curso: a campanha ia pra
//    `pausada` e o tick seguia mandando ate o fim do lote. Agora o estado da
//    campanha e RELIDO a cada volta, e o laco para no proximo destino.
// 3. RETRY. Falha de rede marcava o destino como `falhou` definitivo — um
//    timeout custava o destino pra sempre. Agora conta tentativa e devolve pra
//    fila ate o teto.
//
// O que este arquivo NAO faz: decidir QUANTOS enviar (isso e `decidirEnvios`,
// em ritmo.ts) e falar com provedor (isso e envio.ts).

export const LIMITE_RESERVA_MS = 5 * 60 * 1000;
export const LIMITE_LOCK_MS = 90 * 1000;
export const MAX_TENTATIVAS = 2;

export type DestinoLote = {
  id: string;
  chat_id: string;
  telefone?: string | null;
  nome?: string | null;
  variaveis?: Record<string, string> | null;
  tentativas?: number | null;
};

export type ResultadoEnvioLote =
  | { ok: true; provider_msg_id: string | null }
  | { ok: false; erro: string; configuracao?: boolean };

/**
 * A porta que o laco usa. A implementacao real fala com o banco e com o
 * provedor (lib/disparo/motor.ts); a da prova e um objeto em memoria.
 */
export type PortaLote = {
  /** Estado ATUAL da campanha, relido a cada volta (pausar/cancelar interrompe). */
  estadoDaCampanha(): Promise<string>;
  /** Proximos candidatos pendentes (pode devolver menos que o pedido). */
  candidatos(quantidade: number): Promise<DestinoLote[]>;
  /** Reserva atomica: devolve o destino se ESTE tick pegou, null se perdeu. */
  reservar(destino: DestinoLote): Promise<DestinoLote | null>;
  /** Lista de bloqueio (opt-out), consultada AGORA — nao na montagem do publico. */
  bloqueado(destino: DestinoLote): Promise<boolean>;
  /** Marca o destino como opt-out (nao conta como falha nem como envio). */
  marcarOptout(destino: DestinoLote): Promise<void>;
  enviar(destino: DestinoLote): Promise<ResultadoEnvioLote>;
  registrarEnvio(destino: DestinoLote, provider_msg_id: string | null): Promise<void>;
  /** Grava o desfecho de uma falha (ja decidido por `decidirFalha`). */
  registrarFalha(destino: DestinoLote, desfecho: DesfechoFalha): Promise<void>;
  /** Devolve a reserva pra fila sem contar tentativa (interrupcao). */
  devolverReserva(destino: DestinoLote): Promise<void>;
  agora(): number;
  esperar(ms: number): Promise<void>;
};

export type ResumoLote = {
  enviados: number;
  falhas: number;
  /** reservas perdidas pra outro tick */
  perdidos: number;
  /** bloqueados por opt-out */
  bloqueados: number;
  interrompido: boolean;
  motivo: string | null;
};

// ------------------------------------------------------------- puros

/** A reserva ficou orfa? (tick morreu no meio do lote) */
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

/** O lock do tick pode ser tomado por esta rodada? */
export function lockDisponivel(
  lockEm: string | number | Date | null | undefined,
  agora: number,
  limiteMs: number = LIMITE_LOCK_MS
): boolean {
  if (!lockEm) return true;
  const t = new Date(lockEm as any).getTime();
  if (isNaN(t)) return true;
  return agora - t > limiteMs;
}

export type DesfechoFalha = {
  estado: "pendente" | "falhou";
  tentativas: number;
  erro: string;
  definitivo: boolean;
};

/**
 * O que fazer com uma falha de envio.
 *
 * Falha de CONFIGURACAO (credencial ausente) e definitiva na hora: tentar de
 * novo nao muda nada, e so quem administra resolve. Falha transitoria (timeout,
 * 5xx do provedor) volta pra fila ate o teto de tentativas — antes, um timeout
 * custava o destino pra sempre.
 */
export function decidirFalha(
  tentativasAnteriores: number | null | undefined,
  erro: string,
  opcoes: { configuracao?: boolean; max?: number } = {}
): DesfechoFalha {
  const max = opcoes.max ?? MAX_TENTATIVAS;
  const tentativas = Math.max(0, Math.floor(Number(tentativasAnteriores) || 0)) + 1;
  if (opcoes.configuracao) {
    return { estado: "falhou", tentativas, erro, definitivo: true };
  }
  if (tentativas >= max) {
    return {
      estado: "falhou",
      tentativas,
      erro: `${erro} (desistiu apos ${tentativas} tentativa(s))`,
      definitivo: true,
    };
  }
  return { estado: "pendente", tentativas, erro, definitivo: false };
}

/** A campanha ainda autoriza continuar o lote? */
export function deveInterromper(estadoAtual: string): { parar: boolean; motivo: string | null } {
  if (estadoAtual === "rodando") return { parar: false, motivo: null };
  if (estadoAtual === "pausada") return { parar: true, motivo: "campanha pausada durante o lote" };
  if (estadoAtual === "cancelada") return { parar: true, motivo: "campanha cancelada durante o lote" };
  if (estadoAtual === "concluida") return { parar: true, motivo: "campanha ja concluida" };
  return { parar: true, motivo: `campanha saiu de rodando (estado "${estadoAtual}")` };
}

// -------------------------------------------------------- o laco em si

/**
 * Processa ate `quantidade` destinos, respeitando reserva, interrupcao,
 * bloqueio, intervalo e orcamento de tempo.
 *
 * Nunca lanca: falha de destino vira desfecho gravado, e o que sobrar continua
 * pendente pro proximo tick.
 */
export async function executarLote(
  porta: PortaLote,
  opcoes: { quantidade: number; intervaloS: number; orcamentoMs: number; maxTentativas?: number }
): Promise<ResumoLote> {
  const r: ResumoLote = {
    enviados: 0,
    falhas: 0,
    perdidos: 0,
    bloqueados: 0,
    interrompido: false,
    motivo: null,
  };
  const quantidade = Math.max(0, Math.floor(opcoes.quantidade) || 0);
  if (quantidade === 0) return r;

  // pede um pouco mais que o lote: parte dos candidatos pode ter sido reservada
  // por outro tick entre a leitura e a reserva
  const candidatos = await porta.candidatos(quantidade);
  const comeco = porta.agora();
  let enviadosNesteLote = 0;

  for (const candidato of candidatos) {
    if (r.enviados + r.falhas >= quantidade) break;

    // ORCAMENTO: o que sobrar continua pendente e sai no proximo tick
    if (porta.agora() - comeco > opcoes.orcamentoMs) {
      r.motivo = r.motivo ?? "orcamento da rodada esgotado: o resto sai no proximo tick";
      break;
    }

    // INTERRUPCAO: estado RELIDO a cada volta. Pausar/cancelar para aqui, no
    // proximo destino — nao no fim do lote.
    const estado = await porta.estadoDaCampanha();
    const parada = deveInterromper(estado);
    if (parada.parar) {
      r.interrompido = true;
      r.motivo = parada.motivo;
      break;
    }

    // RESERVA ATOMICA: so segue quem o update condicional devolveu
    const reservado = await porta.reservar(candidato);
    if (!reservado) {
      r.perdidos++;
      continue;
    }

    // OPT-OUT conferido AGORA (o publico pode ter sido montado dias antes)
    if (await porta.bloqueado(reservado)) {
      await porta.marcarOptout(reservado);
      r.bloqueados++;
      continue;
    }

    // INTERVALO entre dois envios DESTA campanha (o primeiro da rodada ja foi
    // liberado pela decisao pura, que olhou o ultimo envio gravado)
    if (enviadosNesteLote > 0 && opcoes.intervaloS > 0) {
      await porta.esperar(opcoes.intervaloS * 1000);
      // pausar durante a espera tambem interrompe: reler antes de mandar
      const depois = await porta.estadoDaCampanha();
      const p2 = deveInterromper(depois);
      if (p2.parar) {
        await porta.devolverReserva(reservado);
        r.interrompido = true;
        r.motivo = p2.motivo;
        break;
      }
    }

    const envio = await porta.enviar(reservado);
    enviadosNesteLote++;
    if (envio.ok) {
      await porta.registrarEnvio(reservado, envio.provider_msg_id);
      r.enviados++;
    } else {
      const desfecho = decidirFalha(reservado.tentativas, envio.erro, {
        configuracao: envio.configuracao,
        max: opcoes.maxTentativas,
      });
      await porta.registrarFalha(reservado, desfecho);
      if (desfecho.definitivo) r.falhas++;
      // falha nao-definitiva volta pra fila: nao conta como falha nem como envio
    }
  }

  return r;
}
