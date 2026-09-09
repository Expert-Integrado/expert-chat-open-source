// Fuso da INSTALACAO — costura temporaria da Frente H.
//
// COSTURA A LIGAR NO MERGE: a Frente F entregou `lib/fuso.ts` na central, com
// `isoDeLocal`. Este worktree foi cortado antes disso, entao as funcoes abaixo
// existem aqui para a Frente H nao cravar fuso nenhum no codigo. **No merge,
// trocar o corpo destas funcoes por um re-export de `lib/fuso.ts`** — a
// assinatura foi escolhida pra isso (mesmo nome `isoDeLocal`, mesma semantica:
// texto sem offset e interpretado no fuso da instalacao).
//
// Nada de "BRT" hardcoded: o fuso vem da env `FUSO_HORARIO` (IANA, ex.
// "America/Sao_Paulo"), com um default que a instalacao pode trocar sem tocar
// codigo. O painel e um produto instalado por cada cliente — cravar o fuso de
// uma empresa aqui e exatamente o tipo de coisa que a REGRA Nº1 do repo proibe.

export const FUSO_PADRAO = "America/Sao_Paulo";

export function fusoDaInstalacao(): string {
  const v = process.env.FUSO_HORARIO;
  return typeof v === "string" && v.trim() ? v.trim() : FUSO_PADRAO;
}

/**
 * Offset do fuso (em minutos) NAQUELE instante — resolve horario de verao
 * sozinho, o que um offset fixo nao faz.
 */
export function offsetMinutos(instante: Date, fuso: string = fusoDaInstalacao()): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: fuso,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p: Record<string, string> = {};
    for (const parte of fmt.formatToParts(instante)) {
      if (parte.type !== "literal") p[parte.type] = parte.value;
    }
    const comoUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour === "24" ? "0" : p.hour),
      Number(p.minute),
      Number(p.second)
    );
    return Math.round((comoUtc - instante.getTime()) / 60000);
  } catch {
    // fuso invalido na env nao pode derrubar o painel nem inventar horario:
    // cai em UTC, que e o unico default honesto
    return 0;
  }
}

/**
 * Converte um texto de data/hora LOCAL (sem offset) no ISO absoluto,
 * interpretando no fuso da instalacao.
 *
 * Texto que JA traz offset ("...Z", "...-03:00") e respeitado como veio — quem
 * mandou offset sabe o que quis dizer.
 *
 * Devolve null quando o texto nao e uma data valida (o chamador vira 400).
 */
export function isoDeLocal(texto: unknown, fuso: string = fusoDaInstalacao()): string | null {
  if (typeof texto !== "string" || !texto.trim()) return null;
  const t = texto.trim();

  // ja tem fuso declarado: confia no que veio
  if (/(z|[+-]\d{2}:?\d{2})$/i.test(t)) {
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  const m = t.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!m) return null;
  const [, a, mes, dia, h = "00", min = "00", s = "00"] = m;
  const ano = Number(a);
  const nMes = Number(mes);
  const nDia = Number(dia);
  const nH = Number(h);
  const nMin = Number(min);
  if (nMes < 1 || nMes > 12 || nDia < 1 || nDia > 31 || nH > 23 || nMin > 59) return null;

  // interpreta como se fosse UTC e desconta o offset daquele instante no fuso
  const comoUtc = Date.UTC(ano, nMes - 1, nDia, nH, nMin, Number(s));
  const off = offsetMinutos(new Date(comoUtc), fuso);
  const real = new Date(comoUtc - off * 60000);
  if (isNaN(real.getTime())) return null;
  // data impossivel ("2026-02-31") vira outro dia: recusar em vez de deslizar
  const conferir = new Date(comoUtc);
  if (conferir.getUTCDate() !== nDia || conferir.getUTCMonth() !== nMes - 1) return null;
  return real.toISOString();
}

/** Comeco do dia corrente no fuso da instalacao, em ISO — janela do teto diario. */
export function inicioDoDia(agora: Date = new Date(), fuso: string = fusoDaInstalacao()): string {
  const off = offsetMinutos(agora, fuso);
  const local = new Date(agora.getTime() + off * 60000);
  const meiaNoiteLocal = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    0,
    0,
    0
  );
  return new Date(meiaNoiteLocal - off * 60000).toISOString();
}

/** Segundos ate a virada do dia no fuso da instalacao. */
export function segundosAteVirarODia(agora: Date = new Date(), fuso: string = fusoDaInstalacao()): number {
  const off = offsetMinutos(agora, fuso);
  const local = new Date(agora.getTime() + off * 60000);
  const proximaMeiaNoite = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + 1,
    0,
    0,
    0
  );
  return Math.max(1, Math.ceil((proximaMeiaNoite - local.getTime()) / 1000));
}
