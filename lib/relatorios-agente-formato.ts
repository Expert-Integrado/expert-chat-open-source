// Agregacao PURA das mensagens do WhatsApp Agent nos numeros que os relatorios
// do painel mostram (mesmas chaves de `relatorio_atendimento` e
// `relatorio_serie`, migrations 0013/0014). Sem banco: provado em node solto.
//
// POR QUE EM TYPESCRIPT, e nao SQL: as funcoes de relatorio leem
// `mensageria.mensagens_<id>`, que no canal do agente so tem anotacoes. As
// mensagens de verdade estao em `public.messages` do agente — outro projeto, ou
// o mesmo projeto em outro schema. Reescrever as funcoes pra lerem de la
// amarraria o SQL do painel ao schema do agente; espelhar as mensagens criaria
// duas fontes de verdade. Ler e somar aqui e o menor caminho que respeita a
// decisao "o agente e o dono das mensagens".
// (sem import de outro modulo: `nomeDe` e injetado — a prova roda em node solto,
// que exige extensao no import, e o build do Next nao aceita `.ts` no caminho)

export type MensagemAgenteResumo = {
  chat_id: string;
  from_me: boolean;
  message_ts: string;
  sent_by_agent_name?: string | null;
  content?: string | null;
};

export type PontoDia = { dia: string; dow: number; recebidas: number; enviadas: number };
export type PontoN = { dia: string; dow: number; n: number };

// 'YYYY-MM-DD' e dia da semana (0=domingo) no fuso da instalacao — o mesmo
// `at time zone` das funcoes SQL. Fuso invalido cai em UTC, como la.
export function diaNoFuso(iso: string, fuso: string): { dia: string; dow: number } {
  const d = new Date(iso);
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  } catch {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  }
  const partes = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(partes.weekday));
  return { dia: `${partes.year}-${partes.month}-${partes.day}`, dow: dow < 0 ? 0 : dow };
}

export type NomeDe = (m: { from_me: boolean; sent_by_agent_name?: string | null; content?: string | null }) => string | null;

export function agregarMensagens(rows: MensagemAgenteResumo[], fuso: string, nomeDe: NomeDe) {
  const porDia = new Map<string, PontoDia>();
  const porNome = new Map<string, number>();
  const primeiraIn = new Map<string, string>();
  const primeiraOutDepois = new Map<string, string>();
  const ordenadas = [...rows].sort((a, b) => a.message_ts.localeCompare(b.message_ts));
  for (const m of ordenadas) {
    const { dia, dow } = diaNoFuso(m.message_ts, fuso);
    const p = porDia.get(dia) ?? { dia, dow, recebidas: 0, enviadas: 0 };
    if (m.from_me) {
      p.enviadas++;
      const nome = nomeDe({ from_me: true, sent_by_agent_name: m.sent_by_agent_name, content: m.content }) || "(sem registro)";
      porNome.set(nome, (porNome.get(nome) ?? 0) + 1);
      if (primeiraIn.has(m.chat_id) && !primeiraOutDepois.has(m.chat_id) && m.message_ts > primeiraIn.get(m.chat_id)!) {
        primeiraOutDepois.set(m.chat_id, m.message_ts);
      }
    } else {
      p.recebidas++;
      if (!primeiraIn.has(m.chat_id)) primeiraIn.set(m.chat_id, m.message_ts);
    }
    porDia.set(dia, p);
  }
  // tempo ate a primeira resposta: media, em segundos, dos chats que TIVERAM resposta
  const esperas = [...primeiraOutDepois].map(([chat, out]) => (Date.parse(out) - Date.parse(primeiraIn.get(chat)!)) / 1000);
  const media = esperas.length ? Math.round(esperas.reduce((a, b) => a + b, 0) / esperas.length) : null;
  const novosAtendimentos = new Map<string, PontoN>();
  for (const out of primeiraOutDepois.values()) {
    const { dia, dow } = diaNoFuso(out, fuso);
    const p = novosAtendimentos.get(dia) ?? { dia, dow, n: 0 };
    p.n++;
    novosAtendimentos.set(dia, p);
  }
  return {
    por_dia: [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia)),
    por_atendente: [...porNome].map(([nome, enviadas]) => ({ nome, enviadas })).sort((a, b) => b.enviadas - a.enviadas).slice(0, 50),
    primeira_resposta_media_s: media,
    novos_atendimentos: [...novosAtendimentos.values()].sort((a, b) => a.dia.localeCompare(b.dia)),
  };
}

export function contarPorDia(isos: string[], fuso: string): PontoN[] {
  const m = new Map<string, PontoN>();
  for (const iso of isos) {
    if (!iso) continue;
    const { dia, dow } = diaNoFuso(iso, fuso);
    const p = m.get(dia) ?? { dia, dow, n: 0 };
    p.n++;
    m.set(dia, p);
  }
  return [...m.values()].sort((a, b) => a.dia.localeCompare(b.dia));
}
