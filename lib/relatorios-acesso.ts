import type { NextRequest } from "next/server";
import { getUser, type UsuarioLogado } from "@/lib/auth-server";
import { getPerfil, permitido } from "@/lib/perfil";

// PORTAO UNICO dos relatorios (Frente J, 31/08/2026; costurado no merge com a
// Frente E em 31/08/2026).
//
// O card separa duas permissoes: VER relatorio e EXPORTAR. Exportar tira dado
// de cliente do sistema, e nem todo mundo que consulta deve poder fazer isso —
// por isso `relatorios_exportar` e permissao propria (lib/permissoes.ts), que
// so o super_admin tem de fabrica.
//
// ESCOPO DE VISAO — pendencia declarada, nao esquecida: a agregacao do banco
// e da OPERACAO INTEIRA (contagens e medias). Um usuario normal com a permissao
// `relatorios` (ex.: papel Supervisor) ve esses numeros agregados sem filtro de
// conversaVisivel. Filtrar por escopo e trabalho no SQL da 0013 (as funcoes
// teriam que receber usuario/deps), nao um ajuste de rota — nao fazer de raspao.
//
// "NUNCA CONTEUDO DE CONVERSA" E INVARIANTE DESTE PORTAO, e ja foi violado uma
// vez (achado da revisao cega da frente M, 31/08/2026): o GET de
// /api/relatorios/sla devolvia `conversas` — chat_id, que E o telefone do
// cliente, e nome de ate 200 conversas por alerta e por canal, vindas do
// `sla_conversas` SEM filtro de conversaVisivel. A frase acima descrevia o
// contrario do codigo.
// REGRA PRA QUEM ADICIONAR ROTA NOVA AQUI: o que sai por este portao e NUMERO.
// Lista de conversa (mesmo "so os 15 primeiros", mesmo "a tela nao usa") nao
// sai — quem quer conversa usa /api/chats, que passa por conversaVisivel. Se a
// rota tambem tem caminho de ENVIO pra destino configurado por admin (o tick do
// SLA), a lista vive SO nesse caminho: contrato diferente, decisao humana
// diferente.

// 401 (nao esta logado) e 403 (esta logado e nao pode) sao respostas
// diferentes de proposito: a UI trata login expirado de um jeito e falta de
// permissao de outro.
export type Acesso =
  | { ok: true; user: UsuarioLogado; podeExportar: boolean }
  | { ok: false; status: 401 | 403; erro: string };

export async function acessoRelatorios(req: NextRequest): Promise<Acesso> {
  const user = await getUser(req);
  if (!user) return { ok: false, status: 401, erro: "unauthorized" };
  const perfil = await getPerfil(user.id);
  if (!permitido(perfil, "relatorios")) {
    return { ok: false, status: 403, erro: "sem permissao de relatorios" };
  }
  return { ok: true, user, podeExportar: permitido(perfil, "relatorios_exportar") };
}
