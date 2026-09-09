import type { DestinoAlerta } from "@/lib/alertas";

// Alertas agendados de SLA — o miolo PURO (Frente J, 31/08/2026).
//
// Este arquivo nao importa nada em RUNTIME de proposito (o unico import e de
// tipo, apagado na execucao): roda no Next e em node solto, que e a prova
// (`node scripts/prova-relatorios.ts`).
//
// O que e um alerta: uma CONSULTA SALVA (o mesmo filtro da caixa de entrada)
// + horarios fixos + destino. Nao e relatorio que alguem abre — e o aviso que
// procura a pessoa. A consulta em si roda no banco (mensageria.sla_conversas);
// aqui vive a validacao da configuracao e a decisao de "esta na hora?".
//
// Onde mora: mensageria.config, chave `alertas_sla` (array). Formato:
//   [{
//     "nome": "Implementacao sem contato por 3 dias",
//     "filtro": { "status": ["aguardando"], "departamento": "<uuid>", "idade_min": 4320 },
//     "horarios": ["08:00", "14:00"],
//     "destino": { "tipo": "telegram", "chat_id": "..." },   // opcional
//     "canal": "central",                                     // opcional
//     "ativo": true
//   }]
// `idade_min` e em MINUTOS sem interacao (1 dia = 1440, 3 dias = 4320,
// 7 dias = 10080) — uma unidade so, sem "dias OU horas" pra interpretar.
// `departamento` aceita o id do departamento ou "__sem_dono__" (conversa sem
// nenhum responsavel, que e o caso que mais dói).

export type FiltroSla = {
  status: string[] | null;
  departamento: string | null;
  idade_min: number;
};

export type AlertaSla = {
  nome: string;
  filtro: FiltroSla;
  horarios: string[];
  // sem destino proprio, cai no destino padrao da instalacao
  destino: DestinoAlerta | null;
  // sem canal, o tick avalia o alerta em TODOS os canais ativos
  canal: string | null;
  limite: number;
  ativo: boolean;
};

const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUS_RE = /^[a-z_]{2,30}$/;
const CANAL_RE = /^[a-z][a-z0-9_]{1,30}$/;
export const SEM_DONO = "__sem_dono__";

export const MAX_ALERTAS = 50;

function destinoValido(d: unknown): DestinoAlerta | null {
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  if (o.tipo === "telegram" && typeof o.chat_id === "string" && /^-?\d{1,20}$/.test(o.chat_id.trim())) {
    return {
      tipo: "telegram",
      chat_id: o.chat_id.trim(),
      ...(typeof o.assinatura === "string" && o.assinatura ? { assinatura: o.assinatura.slice(0, 120) } : {}),
    };
  }
  if (o.tipo === "webhook" && typeof o.url === "string" && /^https:\/\/\S+$/.test(o.url)) {
    // so https: destino de alerta carrega dado de cliente
    return {
      tipo: "webhook",
      url: o.url,
      ...(o.headers && typeof o.headers === "object" ? { headers: o.headers as Record<string, string> } : {}),
      ...(o.body !== undefined ? { body: o.body } : {}),
    };
  }
  return null;
}

// Valida e normaliza o que veio da config. Entrada invalida NUNCA derruba o
// tick: alerta malformado e descartado (fail-closed — nao dispara sozinho).
export function normalizarAlertas(bruto: unknown): AlertaSla[] {
  if (!Array.isArray(bruto)) return [];
  const out: AlertaSla[] = [];
  const nomes = new Set<string>();
  for (const item of bruto) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, any>;
    const nome = typeof o.nome === "string" ? o.nome.trim().slice(0, 120) : "";
    if (!nome || nomes.has(nome)) continue; // nome e a chave do dedupe diario

    const horarios = Array.from(
      new Set((Array.isArray(o.horarios) ? o.horarios : []).filter((h: unknown) => typeof h === "string" && HORA_RE.test(h)))
    ).sort() as string[];
    if (!horarios.length) continue; // alerta sem horario nao e alerta

    const f = o.filtro && typeof o.filtro === "object" ? o.filtro : {};
    const status = Array.isArray(f.status)
      ? Array.from(new Set(f.status.filter((s: unknown) => typeof s === "string" && STATUS_RE.test(s)))) as string[]
      : null;
    const dep =
      typeof f.departamento === "string" && f.departamento.trim() ? f.departamento.trim().slice(0, 60) : null;
    const idade = Number(f.idade_min);

    nomes.add(nome);
    out.push({
      nome,
      filtro: {
        status: status && status.length ? status : null,
        departamento: dep,
        idade_min: Number.isFinite(idade) && idade > 0 ? Math.min(Math.round(idade), 525_600) : 0,
      },
      horarios,
      destino: destinoValido(o.destino),
      canal: typeof o.canal === "string" && CANAL_RE.test(o.canal) ? o.canal : null,
      limite: Number.isFinite(Number(o.limite)) ? Math.min(Math.max(Math.round(Number(o.limite)), 1), 200) : 50,
      // default DESLIGADO: alerta so dispara quando alguem liga de proposito
      ativo: o.ativo === true,
    });
    if (out.length >= MAX_ALERTAS) break;
  }
  return out;
}

// Estado de dedupe (mensageria.config, chave `alertas_sla_estado`):
// { "<nome>|<HH:MM>|<YYYY-MM-DD>": "<iso do envio>" }
export type EstadoAlertas = Record<string, string>;

export function chaveDisparo(nome: string, horario: string, dia: string): string {
  return `${nome}|${horario}|${dia}`;
}

function minutos(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

export type Devido = { alerta: AlertaSla; horario: string; chave: string };

// Quais alertas estao vencidos AGORA. `agora` e `dia` ja vem no fuso da
// instalacao (horaLocal/diaLocal em lib/relatorios.ts).
//
// Janela de tolerancia: o tick roda de N em N minutos e pode perder a batida
// exata (deploy, cron atrasado). Dentro da tolerancia o alerta ainda sai —
// atrasado e melhor que nunca; passou da janela, pula pro dia seguinte em vez
// de disparar as 23h um alerta das 08h.
export function alertasDevidos(
  alertas: AlertaSla[],
  agora: string,
  dia: string,
  estado: EstadoAlertas,
  toleranciaMin = 60
): Devido[] {
  const agoraMin = minutos(agora);
  const devidos: Devido[] = [];
  for (const a of alertas) {
    if (!a.ativo) continue;
    for (const h of a.horarios) {
      const atraso = agoraMin - minutos(h);
      if (atraso < 0 || atraso > toleranciaMin) continue;
      const chave = chaveDisparo(a.nome, h, dia);
      if (estado[chave]) continue; // ja saiu hoje neste horario
      devidos.push({ alerta: a, horario: h, chave });
    }
  }
  return devidos;
}

// Mantem so o estado dos ultimos dias (a config nao pode virar log infinito).
export function podarEstado(estado: EstadoAlertas, diasVivos: string[]): EstadoAlertas {
  const vivos = new Set(diasVivos);
  return Object.fromEntries(Object.entries(estado || {}).filter(([k]) => vivos.has(k.split("|")[2] ?? "")));
}

// Texto do aviso. Sem lista = nada a avisar; quem chama nao envia.
export function textoAlerta(
  alerta: AlertaSla,
  canal: string,
  total: number,
  conversas: { nome?: string | null; chat_id: string; status?: string | null; last_message_at?: string | null }[],
  agora: Date,
  fmtEspera: (desde: string | null | undefined, agora: Date) => string
): string {
  const linhas = conversas
    .slice(0, 15)
    .map((c) => `- ${c.nome || c.chat_id} (${c.status || "?"}, parada ha ${fmtEspera(c.last_message_at, agora)})`);
  const resto = total - Math.min(conversas.length, 15);
  return [
    `${alerta.nome} — ${total} conversa(s) [${canal}]`,
    ...linhas,
    resto > 0 ? `... e mais ${resto}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// "3d 4h" / "5h" / "40min" — espera legivel sem dependencia de data.
export function esperaLegivel(desde: string | null | undefined, agora: Date): string {
  if (!desde) return "sem registro";
  const ms = agora.getTime() - new Date(desde).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "sem registro";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
