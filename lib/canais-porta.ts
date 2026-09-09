import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, permitido } from "@/lib/perfil";
import { permissaoDoNivel, type NivelCanal } from "@/lib/permissoes";
import { canalPermitido, restricaoDeConversas } from "@/lib/acesso";
import { canalPorId, type CanalDef } from "@/lib/canais";
import { canalObrigatorio, conexaoDaFonte, corpoJsonObrigatorio } from "@/lib/canal-conexao";
import type { UsuarioLogado } from "@/lib/auth-server";
import type { Perfil } from "@/lib/perfil";

// A PORTA UNICA das rotas de canal (`/api/canais/*`) — Frente U.
//
// POR QUE ELA EXISTE: as tres rotas nasceram com a porta COPIADA, e a revisao
// cega mediu o preco disso — as tres esqueceram a MESMA coisa (`usuario_restricoes`).
// Porta copiada e porta que divergiu: a proxima rota de canal herda o esquecimento.
// Agora ha um lugar so, e a prova varre `app/api/canais/*` cobrando que ela seja
// usada.
//
// AS CINCO CAMADAS, na ordem, e a ordem e deliberada:
//
//  1. IDENTIDADE (401). Sessao ou chave.
//  2. PERMISSAO (403), antes de qualquer coisa sobre o canal — nao contar a
//     existencia de canal pra quem nao pode administrar canal.
//  3. CANAL EXPLICITO (400) — `canalObrigatorio`, funcao PURA. Default aqui seria
//     desconectar/trocar/apagar template do NUMERO ERRADO, e daria a uma chave
//     restrita a um numero o alcance do outro por OMITIR o parametro.
//  4. CANAL REGISTRADO (404).
//  5. RESTRICAO DE CANAL DO USUARIO (403) — `usuario_restricoes` da Frente Q.
//     ERA O FURO: quem tem a permissao mas esta recortado a um numero
//     DESCONECTAVA o outro. Pior: o indice `/api/canais` ja filtrava por
//     `canalPermitido`, entao o numero nem aparecia na tela — o recorte parecia
//     valer e nao valia. Fail-closed na listagem virando fail-open na operacao e
//     o pior arranjo possivel: dava a impressao de estar protegido.
//
// SUPER ADMIN nunca e restringido (`restricaoDeConversas` devolve null pra ele) —
// mesma camada 1 de `conversaVisivel`.
//
// NIVEL: `ler` e `operar` sao DUAS permissoes diferentes (Frente U, a pedido da
// revisao). `gerenciar_canais` VE o numero e puxa integracao; `conectar_numero`
// MEXE nele (conectar, desconectar, reiniciar, pedir codigo, trocar chip, apagar
// template na Meta). A divisao e a de `relatorios` x `relatorios_exportar`: ler o
// estado e diagnostico e todo supervisor precisa; desconectar derruba o
// atendimento inteiro na hora.
// A POLITICA (qual permissao cada nivel exige) mora em lib/permissoes.ts, junto do
// catalogo, e nao aqui: nenhuma prova consegue carregar este arquivo (o
// especificador `next/server` sem extensao e o alias `@/`, nao o modulo em si) — e foi por isso que a divisao ficou provada so por grep de
// frase, com a mutacao que a desfaz passando verde. Lá ela e medida como
// comportamento (`permissaoDoNivel` + `permissoesEfetivas`).
export type { NivelCanal };

export type PortaOk = { user: UsuarioLogado; perfil: Perfil; canal: CanalDef };
export type PortaErro = { erro: NextResponse };
export type ResultadoPorta = PortaOk | PortaErro;

export function recusou(r: ResultadoPorta): r is PortaErro {
  return "erro" in r;
}

export async function portaDoCanal(
  req: NextRequest,
  canalPedido: unknown,
  nivel: NivelCanal
): Promise<ResultadoPorta> {
  // 1. identidade
  const user = await getUser(req);
  if (!user) return { erro: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  return camadas2a5(req, user, canalPedido, nivel);
}

/**
 * A porta das rotas de canal que decidem pelo CORPO (os POST) — e ela quem LE o
 * corpo. A rota recebe o corpo ja parseado e NUNCA chama `req.json()`.
 *
 * ISSO NAO E ARRUMACAO DE ESTILO, e o GRAVE D1 da 2a revisao cega. O corpo de um
 * Request se le uma vez. `getUser` precisa CLONAR o corpo pra descobrir de qual
 * canal o pedido fala e comparar com `escopo.canais` da chave de API. Quando a
 * rota lia primeiro:
 *
 *   rota: await req.json()            -> corpo consumido
 *   porta -> getUser -> canalDoPedido -> req.clone() LANCA ("Body is unusable")
 *                                     -> catch -> canal do pedido = null
 *   escopoPermite: canal null + rota fora de CANAL_PADRAO_EM -> NAO COMPARA NADA
 *
 * Resultado medido: chave com `escopo.canais = ["central"]` DESCONECTAVA o
 * `apioficial` por POST. A camada 5 desta porta nao cobre isso — ela e a restricao
 * do USUARIO (`usuario_restricoes`), nao o escopo da CHAVE.
 *
 * O sintoma e cruel: nada quebra. Sem erro, sem log, sem teste vermelho — a
 * comparacao simplesmente para de acontecer. Por isso a guarda e ESTRUTURAL: a
 * prova varre `app/api/canais/*` proibindo `req.json(`, e quem quiser um POST novo
 * de canal passa por aqui.
 *
 * O NIVEL vem por FUNCAO porque ele depende do corpo (`acao`), e o corpo so existe
 * depois da identidade. A funcao pode devolver uma NextResponse pra recusar a
 * propria acao (400 de `acao` invalida), que e o que as tres rotas faziam antes de
 * chamar a porta.
 *
 * ———————————————————————————— 3a REVISAO: o 415, e por que ele vem DEPOIS do 401
 *
 * A ordem de leitura estava certa e a de HEADER nao: `getUser` so olhava o corpo
 * quando o content-type se dizia JSON, e esta funcao parseava sem olhar nada. Corpo
 * JSON valido com `Content-Type: application/x-www-form-urlencoded` (o default do
 * `curl -d`) dava canal `null` na porta da chave — que nao compara nada — e canal
 * REAL aqui. O escopo de canal voltava a ser inerte, com o dano inteiro do D1.
 *
 * O 415 fica DEPOIS da identidade de proposito, e isso deixa as DUAS guardas vivas:
 * `getUser` ja resolveu o canal pelo corpo (a raiz, em `canalDoPedido`) e barrou a
 * chave que nao alcanca aquele numero; o 415 recusa o pedido que mentiu no header,
 * seja de quem for. Se o 415 viesse antes, a guarda da chave nunca rodaria nestas
 * rotas e a correcao dependeria de UM lugar so.
 */
export type CorpoPedido = Record<string, any>;
export type PortaComCorpo = PortaOk & { body: CorpoPedido };

export async function portaDoCorpo(
  req: NextRequest,
  nivelDaAcao: (body: CorpoPedido) => NivelCanal | NextResponse
): Promise<PortaComCorpo | PortaErro> {
  // 1. identidade PRIMEIRO — e aqui que o corpo e clonado pro escopo da chave.
  //    Ler o corpo antes desta linha e o furo D1.
  const user = await getUser(req);
  if (!user) return { erro: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };

  // 1b. O CORPO TEM QUE SE DECLARAR JSON — regra PURA, e ela roda ANTES da leitura.
  //     Ler um corpo que o header nao declarou como JSON e o que fazia esta porta
  //     discordar de `canalDoPedido` (ver o cabecalho desta funcao).
  const tipo = corpoJsonObrigatorio(req.headers.get("content-type"));
  if (!tipo.ok) {
    return { erro: NextResponse.json({ error: tipo.erro }, { status: tipo.status }) };
  }

  // agora sim: o clone ja aconteceu, o corpo original esta intacto
  const body: CorpoPedido = await req.json().catch(() => ({}));

  const nivel = nivelDaAcao(body);
  if (nivel instanceof NextResponse) return { erro: nivel };

  const r = await camadas2a5(req, user, body?.canal, nivel);
  if (recusou(r)) return r;
  return { ...r, body };
}

async function camadas2a5(
  req: NextRequest,
  user: UsuarioLogado,
  canalPedido: unknown,
  nivel: NivelCanal
): Promise<ResultadoPorta> {
  // 2. permissao (super admin passa sempre, como no resto do painel)
  const perfil = await getPerfil(user.id);
  const ehSuper = perfil.papel === "super_admin";
  const perm = permissaoDoNivel(nivel);
  if (!permitido(perfil, perm) && !ehSuper) {
    return {
      erro: NextResponse.json(
        {
          error:
            nivel === "operar"
              ? "sem permissao pra mexer no numero (conectar, desconectar ou trocar o chip)"
              : "sem permissao pra administrar canais",
          permissao: perm,
        },
        { status: 403 }
      ),
    };
  }

  // 3. canal explicito — regra PURA, provada sem rede
  const pedido = canalObrigatorio(canalPedido);
  if (!pedido.ok) {
    return { erro: NextResponse.json({ error: pedido.erro }, { status: pedido.status }) };
  }

  // 4. canal registrado nesta instalacao. Canal INATIVO passa de proposito: e
  //    exatamente o numero que alguem acabou de declarar em CANAIS_EXTRA e vem
  //    conectar agora — recusa-lo aqui tornaria impossivel plugar numero novo,
  //    que e o caso de uso numero 1 desta tela.
  const canal = canalPorId(pedido.id);
  if (!canal) {
    return { erro: NextResponse.json({ error: "canal nao registrado nesta instalacao" }, { status: 404 }) };
  }

  // 5. restricao de canal do usuario
  const restricao = await restricaoDeConversas(user.id, ehSuper);
  if (!canalPermitido(restricao, canal.id)) {
    return {
      erro: NextResponse.json(
        { error: "este numero esta fora do seu recorte de acesso" },
        { status: 403 }
      ),
    };
  }

  return { user, perfil, canal };
}

/**
 * A conexao deste canal mora NESTE painel?
 *
 * Fica aqui, e nao dentro de `portaDoCanal`, porque a resposta e 409 e nao 403 —
 * nao e falta de permissao, e um numero cuja conexao mora em outro lugar (a Meta,
 * pro canal de API Oficial; o painel da Evolution; o Instagram Agent). A frase
 * vem de `conexaoDaFonte`, por fonte, e diz ONDE ela mora — melhor que esconder o
 * botao, porque o cliente que veio do ChatGuru procura o QR aqui.
 */
export function exigeConexaoLocal(canal: CanalDef): NextResponse | null {
  const permite = conexaoDaFonte(canal.fonte);
  if (permite.pode) return null;
  return NextResponse.json({ error: permite.motivo, fonte: canal.fonte }, { status: 409 });
}
