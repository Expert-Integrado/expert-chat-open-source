import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { credsCentral } from "@/lib/zapi";
import { fusoDaConfig, getConfig, type ConfigAutomacao } from "@/lib/config";
import { horaNoFuso } from "@/lib/fuso";
import { getUser } from "@/lib/auth-server";
import { getPerfil, ehAdmin } from "@/lib/perfil";
import { destinosDaInstalacao, enviarAlerta } from "@/lib/alertas";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// Vigia do canal (F10, 17/08/2026): o time vai depender do painel no lugar do
// ChatGuru — se o numero desconectar ou o webhook morrer, NINGUEM percebe e
// cliente fica sem resposta em silencio. Chamado pelo pg_cron a cada 10min
// (Bearer CHATGURU_SYNC_SECRET). Sinais:
// 1. Conexao da instancia Z-API central (status connected+smartphoneConnected)
//    — sinal FORTE, zero falso positivo; e o modo de falha dominante.
// 2. Silencio de entrada: > 4h sem mensagem recebida DENTRO de 09-19h no FUSO
//    DA INSTALACAO (lib/fuso.ts; era America/Sao_Paulo cravado) —
//    sinal fraco (medido 30 dias: acontece ~5x/mes naturalmente), por isso
//    entra como aviso, com dedupe.
// Anti-spam: alerta so em MUDANCA de estado ou re-alerta apos 60min do
// anterior; recuperacao avisa 1x. Estado em mensageria.vigia_estado (1 linha).
// Alerta via Telegram (fora da banda do WhatsApp de proposito: se a instancia
// caiu, avisar por ela nao daria).

const SILENCIO_LIMITE_MS = 4 * 3600_000;
const REALERTA_MS = 60 * 60_000;

// Destinos e envio moram em lib/alertas.ts desde 31/08/2026 (os alertas de SLA
// usam o MESMO caminho — regra de destino em dois lugares e regra que diverge).
// Continua valendo: NADA de destino da instancia no codigo (produto BASE); o
// destino sai da tela (Configuracoes -> Vigia) ou do env VIGIA_ALERTAS.
const destinos = destinosDaInstalacao;

async function statusZapi(): Promise<{ conectado: boolean; detalhe: string }> {
  const creds = credsCentral();
  if (!creds) return { conectado: false, detalhe: "credenciais Z-API ausentes" };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  try {
    const r = await fetch(
      `https://api.z-api.io/instances/${creds.instance}/token/${creds.token}/status`,
      { headers: { "Client-Token": creds.clientToken }, signal: controller.signal, cache: "no-store" }
    );
    const d = await r.json().catch(() => ({}));
    const conectado = d?.connected === true && d?.smartphoneConnected !== false;
    return { conectado, detalhe: conectado ? "ok" : `connected=${d?.connected} smartphone=${d?.smartphoneConnected}` };
  } catch {
    return { conectado: false, detalhe: "API da Z-API nao respondeu" };
  } finally {
    clearTimeout(t);
  }
}

async function alertar(texto: string, cfg: ConfigAutomacao): Promise<number> {
  return enviarAlerta(texto, destinos(cfg));
}

function bearerOk(req: NextRequest): boolean {
  const segredo = process.env.CHATGURU_SYNC_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (!segredo || !auth.startsWith("Bearer ")) return false;
  const recebido = Buffer.from(auth.slice(7));
  const esperado = Buffer.from(segredo);
  return recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
}

export async function POST(req: NextRequest) {
  // pg_cron entra pelo bearer; o botao "enviar teste" da tela entra como super admin
  if (!bearerOk(req)) {
    const user = await getUser(req);
    if (!user || !ehAdmin(await getPerfil(user.id))) {
      return NextResponse.json({ error: "bearer invalido" }, { status: 401 });
    }
  }
  const cfg = await getConfig();

  // modo teste: exercita o caminho real do alerta sem depender de falha real
  // (funciona mesmo com o vigia desligado — valida o canal antes de ligar)
  if (req.nextUrl.searchParams.get("teste") === "1") {
    const enviados = await alertar(
      "[teste] Vigia do painel de chat ativo. Alertas reais virao neste formato quando o numero desconectar ou a entrada silenciar.",
      cfg
    );
    return NextResponse.json({ ok: true, teste: true, destinos_ok: enviados, destinos_total: destinos(cfg).length });
  }

  // chave da tela (Configuracoes -> Vigia): desligado = nao checa nem alerta
  if (!cfg.vigia_ativo) {
    return NextResponse.json({ ok: true, desativado: true });
  }

  const db = msgDb();
  const [zapi, { data: ult }, { data: estadoRow }] = await Promise.all([
    statusZapi(),
    db.from("mensagens").select("criada_em").eq("direcao", "in").order("criada_em", { ascending: false }).limit(1),
    db.from("vigia_estado").select("problemas,alertado_em").eq("id", 1).maybeSingle(),
  ]);

  const problemas: string[] = [];
  if (!zapi.conectado) {
    problemas.push(`Numero central DESCONECTADO do WhatsApp (${zapi.detalhe})`);
  }
  const ultima = ult?.[0]?.criada_em ? new Date(ult[0].criada_em) : null;
  // "silencio suspeito" so vale no horario em que ha gente pra receber mensagem,
  // e esse horario e o da INSTALACAO — antes era America/Sao_Paulo cravado, o que
  // faria o vigia calar de dia e alertar de madrugada em instalacao de outro fuso.
  const horaLocal = horaNoFuso(new Date(), fusoDaConfig(cfg));
  if (ultima && horaLocal >= 9 && horaLocal < 19 && Date.now() - ultima.getTime() > SILENCIO_LIMITE_MS) {
    const horas = Math.round((Date.now() - ultima.getTime()) / 3600_000);
    problemas.push(`Nenhuma mensagem recebida ha ${horas}h (pode ser normal, mas confere o webhook)`);
  }

  const antes: string[] = Array.isArray(estadoRow?.problemas) ? estadoRow.problemas : [];
  const alertadoEm = estadoRow?.alertado_em ? new Date(estadoRow.alertado_em).getTime() : 0;
  const mudou = JSON.stringify(problemas) !== JSON.stringify(antes);
  let alertaEnviado = false;

  if (problemas.length && (mudou || Date.now() - alertadoEm > REALERTA_MS)) {
    alertaEnviado = (await alertar(
      `Vigia do painel de chat (Expert Chat):\n- ${problemas.join("\n- ")}`,
      cfg
    )) > 0;
    await db
      .from("vigia_estado")
      .update({ problemas, alertado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() })
      .eq("id", 1);
  } else if (!problemas.length && antes.length) {
    alertaEnviado = (await alertar("Vigia do painel de chat: normalizado, numero conectado e entrada fluindo.", cfg)) > 0;
    await db
      .from("vigia_estado")
      .update({ problemas: [], alertado_em: null, atualizado_em: new Date().toISOString() })
      .eq("id", 1);
  }

  return NextResponse.json({
    ok: true,
    conectado: zapi.conectado,
    ultima_recebida: ultima?.toISOString() ?? null,
    problemas,
    alerta_enviado: alertaEnviado,
  });
}
