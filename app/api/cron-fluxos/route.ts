import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, permitido } from "@/lib/perfil";
import { moduloAtivo } from "@/lib/modulos";
import { processarTickFluxos } from "@/lib/fluxo/fila-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// TICK DA FILA DE AUTOMACAO — Frente P, 31/08/2026 (card 86ak859wr).
//
// Processa os passos de fluxo cuja hora chegou: espera vencida, aprovacao ja
// dada, retentativa de passo que falhou. Um passo por cadeia, uma cadeia por
// conversa (a fila e POR CONVERSA), com claim atomico entre ticks.
//
// AUTENTICACAO (mesmo padrao de /api/cron-disparo, /api/cron-agendadas e
// /api/vigia): bearer do cron OU usuario logado com a permissao nomeada
// `automacao`. As duas portas, e so essas.
//
// FAIL-CLOSED: modulo `automacao` desligado = 403 antes de olhar a fila.
// Instalacao que nao ligou o modulo tem esta rota morta.
//
// A ROTA NAO DECIDE NADA: quem decide o que roda agora, em que ordem e com que
// hora e `lib/fluxo/fila.ts` (puro, provado em `node scripts/prova-motor-fila.ts`
// sem tocar rede nem banco). Aqui e autorizacao + orquestracao.
//
// QUANDO LIGAR DE VERDADE (pendencia declarada, pro coordenador): pg_cron no
// banco da instalacao chamando esta rota a cada minuto com o bearer, no mesmo
// modelo dos jobs 14/23/24/25 do CLAUDE.md. **Ainda NAO existe job criado** —
// criar cron e gesto humano, como a migration. O comando esta no CLAUDE.md,
// secao da Frente P.
//
// Sem o cron, a fila NAO anda sozinha. Isso e proposital enquanto ninguem criou o
// job: melhor uma fila parada e visivel na tela do que meia fila andando por
// chamada de tela. A rota tambem aceita chamada manual do admin — e o que permite
// testar a regua inteira sem esperar o relogio.

export async function POST(req: NextRequest) {
  if (!(await moduloAtivo("automacao"))) {
    return NextResponse.json({ error: "modulo de automacao desligado nesta instalacao" }, { status: 403 });
  }

  const auth = req.headers.get("authorization") || "";
  const segredo = process.env.CHATGURU_SYNC_SECRET;
  const peloCron = !!segredo && auth === `Bearer ${segredo}`;

  if (!peloCron) {
    const user = await getUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const perfil = await getPerfil(user.id);
    if (!permitido(perfil, "automacao")) {
      return NextResponse.json({ error: "sem permissao de automacao" }, { status: 403 });
    }
  }

  const r = await processarTickFluxos();
  if (!r.ok) return NextResponse.json({ ok: false, erro: r.erro }, { status: 503 });

  return NextResponse.json(r, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
