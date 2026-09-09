// Quem pode disparar — UM lugar so.
//
// Disparo em massa e a acao mais cara que este painel sabe fazer: erra e sai
// mensagem errada pra milhares de pessoas, pelo numero da empresa. Por isso a
// permissao mora aqui e nao espalhada por rota — e por isso o default e o mais
// fechado que existe no repo hoje.
//
// ESTADO (31/08/2026): a base ainda NAO tem `lib/permissoes.ts` (papel granular
// por acao). Enquanto nao tiver, disparar exige `super_admin`, o mesmo portao
// das rotas /api/admin/*. Quando a Frente E entregar o papel granular, a troca e
// AQUI DENTRO — trocar o corpo de `podeDisparar` por uma checagem de permissao
// `disparo` e nenhuma rota muda. Nao replicar esta regra em rota nenhuma.

import type { Perfil } from "@/lib/perfil";

export function podeDisparar(perfil: Perfil): boolean {
  return perfil.papel === "super_admin";
}

/** Motivo legivel do 403 — a tela mostra isso, entao nada de "forbidden". */
export const MOTIVO_SEM_PERMISSAO =
  "disparo em massa exige permissao de administrador nesta instalacao";
