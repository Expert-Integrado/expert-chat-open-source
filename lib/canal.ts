import type { NextRequest } from "next/server";
import { canalPorId } from "@/lib/canais";

// Canal agora e entidade de primeira classe — o registro vive em lib/canais.ts
// (tipo whatsapp/instagram, identidade, dono empresa/pessoal, fonte, tabelas).
// Estas funcoes seguem sendo a porta das rotas: resolvem o canal pedido e o
// par de tabelas dele. Canal desconhecido ou inativo cai no "central", como
// sempre caiu (fallback seguro — nunca 500 por canal invalido).
export type Canal = string;

function resolver(id: unknown): Canal {
  const c = typeof id === "string" ? canalPorId(id) : null;
  return c && c.ativo ? c.id : "central";
}

export function canalDe(req: NextRequest): Canal {
  return resolver(req.nextUrl.searchParams.get("canal"));
}

export function canalDeBody(body: any): Canal {
  return resolver(body?.canal);
}

// Cada canal tem o proprio par de tabelas (mesmas colunas; PK chat_id =
// telefone/perfil do CONTATO — juntar numa tabela so colidiria quem falou
// com mais de um canal).
export function tabelas(canal: Canal) {
  return (canalPorId(canal) ?? canalPorId("central"))!.tabelas;
}
