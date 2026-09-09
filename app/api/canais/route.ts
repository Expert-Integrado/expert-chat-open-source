import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, permitido } from "@/lib/perfil";
import { canalPermitido, restricaoDeConversas } from "@/lib/acesso";
import { canaisAtivos, canalPublico, envioDisponivel, listarCanais, somenteLeitura } from "@/lib/canais";
import { conexaoDaFonte } from "@/lib/canal-conexao";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// OS NUMEROS DA INSTALACAO, pra tela de administracao de canais (Frente U).
//
//   GET /api/canais           -> canais ATIVOS que este usuario alcanca
//   GET /api/canais?todos=1   -> inclui os registrados e desligados (super admin)
//
// POR QUE ELA EXISTE, em vez de a tela reusar `/api/chats`: aquela rota carrega a
// LISTA DE CONVERSAS de um canal (o polling da sidebar) e devolve os canais como
// efeito colateral. A tela de canais precisa dos canais e de mais nada — pedir
// conversa pra descobrir numero e caro e sem sentido, e amarraria a visao de
// administracao ao formato da caixa de entrada.
//
// RESTRICAO DE CANAL VALE AQUI TAMBEM. Quem tem `gerenciar_canais` mas esta
// recortado a um numero (`usuario_restricoes`, Frente Q) NAO administra o numero
// que nem consegue ver: seria administrar no escuro um numero cujas conversas
// estao fora do alcance dele. Super admin nunca e restringido — a mesma camada 1
// de `conversaVisivel`.

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const ehSuper = perfil.papel === "super_admin";
  if (!permitido(perfil, "gerenciar_canais") && !ehSuper) {
    return NextResponse.json({ error: "sem permissao pra administrar canais" }, { status: 403 });
  }

  // `todos=1` mostra tambem canal registrado e DESLIGADO (`ativo:false`): e
  // exatamente o canal que alguem acabou de declarar em CANAIS_EXTRA e vai
  // conectar agora. Sem isso, a tela nao alcancaria o numero novo — que e o caso
  // de uso numero 1 desta tela.
  const querTodos = req.nextUrl.searchParams.get("todos") === "1" && ehSuper;
  const lista = querTodos ? listarCanais() : canaisAtivos();

  const restricao = await restricaoDeConversas(user.id, ehSuper);
  const visiveis = lista.filter((c) => canalPermitido(restricao, c.id));

  return NextResponse.json(
    {
      canais: visiveis.map((c) => {
        const conexao = conexaoDaFonte(c.fonte);
        return {
          ...canalPublico(c),
          // o que a tela precisa saber ANTES de oferecer botao: numero sem
          // credencial nao envia, e numero cuja conexao nao mora aqui nao tem QR.
          // Botao que aparece e nao funciona ensina o usuario a desconfiar da tela.
          envio_cabeado: envioDisponivel(c.id),
          somente_leitura: somenteLeitura(c.id),
          conexao_aqui: conexao.pode,
          conexao_motivo: conexao.pode ? "" : conexao.motivo,
          // template existe SO no numero de API Oficial (aprovacao por remetente)
          tem_templates: c.fonte === "gupshup",
        };
      }),
      // a tela precisa saber se esta vendo tudo, pra nao oferecer "conectar numero
      // novo" a quem nem consegue listar o numero novo
      pode_ver_desligados: ehSuper,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
