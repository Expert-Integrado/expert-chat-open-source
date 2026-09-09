import type { ConfigAutomacao } from "@/lib/config";

// Envio de ALERTA da instalacao (Telegram ou webhook) — extraido de
// /api/vigia em 31/08/2026, quando os alertas de SLA passaram a precisar do
// mesmo caminho. Regra que vale pros dois: NADA de destino da empresa no
// codigo (o repo e produto BASE) — tudo por config da tela ou env.
//
// No body do webhook, toda string "{{texto}}" vira a mensagem do alerta —
// cobre Zoom Incoming Webhook, Resend (email), Slack etc. sem codigo novo.
export type DestinoAlerta =
  | { tipo: "telegram"; chat_id: string; assinatura?: string }
  | { tipo: "webhook"; url: string; headers?: Record<string, string>; body?: unknown };

// Destino PADRAO da instalacao: o configurado na tela (Configuracoes -> Vigia)
// manda; o env VIGIA_ALERTAS e a reserva. Lista vazia = instalacao sem canal de
// alerta configurado — quem chama trata como "desligado com aviso", nunca
// inventa destino.
export function destinosDaInstalacao(
  cfg: Pick<ConfigAutomacao, "vigia_tg_chat_id" | "vigia_assinatura">
): DestinoAlerta[] {
  if (cfg.vigia_tg_chat_id) {
    return [{ tipo: "telegram", chat_id: cfg.vigia_tg_chat_id, assinatura: cfg.vigia_assinatura || undefined }];
  }
  try {
    const lista = JSON.parse(process.env.VIGIA_ALERTAS || "[]");
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

// substitui "{{texto}}" recursivamente em qualquer string do body
export function preencher(v: unknown, texto: string): unknown {
  if (typeof v === "string") return v.replaceAll("{{texto}}", texto);
  if (Array.isArray(v)) return v.map((x) => preencher(x, texto));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, preencher(x, texto)]));
  }
  return v;
}

// Dispara todos os destinos; devolve quantos aceitaram (melhor-esforco: um
// destino fora do ar nao impede os outros). Sem TELEGRAM_BOT_TOKEN o destino
// telegram simplesmente nao envia — nunca cai em outro canal.
export async function enviarAlerta(texto: string, destinos: DestinoAlerta[]): Promise<number> {
  const resultados = await Promise.all(
    (destinos || []).map(async (d): Promise<boolean> => {
      try {
        if (d.tipo === "telegram") {
          const token = process.env.TELEGRAM_BOT_TOKEN;
          if (!token || !d.chat_id) return false;
          // assinatura em negrito no rodape (convencao dos avisos automaticos
          // da instalacao); HTML so na assinatura — o alerta vai escapado
          const escapado = texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const corpo = d.assinatura ? `${escapado}\n\n<b>${d.assinatura}</b>` : escapado;
          const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: d.chat_id, text: corpo, parse_mode: "HTML" }),
            cache: "no-store",
          });
          return (await r.json().catch(() => ({})))?.ok === true;
        }
        if (d.tipo === "webhook" && d.url) {
          const r = await fetch(d.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(d.headers || {}) },
            body: JSON.stringify(preencher(d.body ?? { text: "{{texto}}" }, texto)),
            cache: "no-store",
          });
          return r.ok;
        }
        return false;
      } catch {
        return false;
      }
    })
  );
  return resultados.filter(Boolean).length;
}
