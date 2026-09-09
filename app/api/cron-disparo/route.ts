import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil } from "@/lib/perfil";
import { moduloAtivo } from "@/lib/modulos";
import { podeDisparar, MOTIVO_SEM_PERMISSAO } from "@/lib/disparo/permissao";
import { processarTick } from "@/lib/disparo/motor";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// TICK do disparo — processa um lote de destinos por chamada.
//
// AUTENTICACAO (mesmo padrao de /api/cron-agendadas e /api/vigia): bearer do
// cron OU super admin logado. As duas portas, e so essas.
//
// FAIL-CLOSED: modulo `disparo` desligado = 403 antes de olhar qualquer
// campanha. Instalacao que nao ligou o modulo tem esta rota morta.
//
// A rota NAO decide nada: quem decide quantos saem agora e `decidirEnvios`
// (lib/disparo/ritmo.ts), funcao pura provada em `scripts/prova-disparo.ts` sem
// tocar rede. Aqui e so autorizacao + orquestracao.
//
// Quando ligar de verdade: pg_cron no banco da instalacao chamando esta rota a
// cada minuto com o bearer, no mesmo modelo dos jobs 14/23/24/25 (CLAUDE.md).
// Ainda NAO existe job criado — criar cron e gesto humano, como a migration.

export async function POST(req: NextRequest) {
  if (!(await moduloAtivo("disparo"))) {
    return NextResponse.json({ error: "modulo de disparo desligado nesta instalacao" }, { status: 403 });
  }

  const auth = req.headers.get("authorization") || "";
  const segredo = process.env.CHATGURU_SYNC_SECRET;
  const peloCron = !!segredo && auth === `Bearer ${segredo}`;

  if (!peloCron) {
    const user = await getUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const perfil = await getPerfil(user.id);
    if (!podeDisparar(perfil)) return NextResponse.json({ error: MOTIVO_SEM_PERMISSAO }, { status: 403 });
  }

  const { processadas, erro } = await processarTick();
  if (erro) return NextResponse.json({ ok: false, erro }, { status: 503 });

  return NextResponse.json({
    ok: true,
    campanhas: processadas.length,
    enviados: processadas.reduce((a, p) => a + p.enviados, 0),
    falhas: processadas.reduce((a, p) => a + p.falhas, 0),
    detalhe: processadas,
  });
}
