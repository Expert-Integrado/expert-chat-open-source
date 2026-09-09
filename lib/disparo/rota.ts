// Portao das rotas de disparo — modulo + login + permissao, em UM lugar.
//
// FAIL-CLOSED: modulo `disparo` desligado = 403 em TUDO, antes de qualquer
// leitura. A instalacao nasce sem disparo (lib/modulos.ts), e uma instalacao
// que nunca ligou o modulo nao deve nem saber que existem campanhas.
//
// A ordem importa: modulo -> login -> permissao. Responder 401 antes de checar
// o modulo contaria que o modulo existe pra quem nem logou.

import { NextRequest, NextResponse } from "next/server";
import { getUser, type UsuarioLogado } from "@/lib/auth-server";
import { getPerfil, type Perfil } from "@/lib/perfil";
import { moduloAtivo } from "@/lib/modulos";
import { MOTIVO_SEM_PERMISSAO, podeDisparar } from "@/lib/disparo/permissao";

export type Autorizado = { user: UsuarioLogado; perfil: Perfil };

export const RESP_MODULO_OFF = () =>
  NextResponse.json({ error: "modulo de disparo desligado nesta instalacao" }, { status: 403 });

/**
 * Devolve o usuario autorizado OU a resposta de recusa (nunca os dois).
 * Uso: `const g = await portao(req); if (g instanceof NextResponse) return g;`
 */
export async function portao(req: NextRequest): Promise<Autorizado | NextResponse> {
  if (!(await moduloAtivo("disparo"))) return RESP_MODULO_OFF();
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  if (!podeDisparar(perfil)) return NextResponse.json({ error: MOTIVO_SEM_PERMISSAO }, { status: 403 });
  return { user, perfil };
}

/** Resposta padrao quando a migration 0012 ainda nao foi aplicada. */
export const RESP_SEM_TABELA = () =>
  NextResponse.json(
    { error: "as tabelas de disparo nao existem nesta instalacao (a migration 0012 ja foi aplicada?)" },
    { status: 503 }
  );
