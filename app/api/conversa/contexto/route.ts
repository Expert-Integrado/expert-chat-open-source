import { NextRequest, NextResponse } from "next/server";
import { getUser, type UsuarioLogado } from "@/lib/auth-server";
import { getPerfil, permitido, podeVerConversa } from "@/lib/perfil";
import { canalDe, canalDeBody } from "@/lib/canal";
import { restricaoEfetiva } from "@/lib/embed";
import { definirContexto, lerContexto, limparContexto } from "@/lib/fluxo/contexto-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// A MEMORIA DA CONVERSA, pela porta do ATENDENTE (card 86ak859vt).
//
//   GET   /api/conversa/contexto?chat_id=&canal=          -> le os pares
//   POST  /api/conversa/contexto  { chat_id, canal, chave, valor }   -> grava
//   POST  /api/conversa/contexto  { chat_id, canal, chave, limpar:true } -> apaga
//
// POR QUE ESTA ROTA EXISTE: o card pede "atendente humano ve e edita o contexto
// da conversa, com permissao para isso", e ate aqui as UNICAS portas eram as
// acoes de fluxo (`definir_contexto`/`limpar_contexto`) e o SQL Editor. Ou seja:
// uma conversa presa no meio de um menu (`URA` com o valor errado) so se
// destravava com alguem mexendo no banco. Medido no acervo: `URA` aparece 151
// vezes como variavel gravada por dialogo — e o estado que mais prende gente.
//
// LER x ESCREVER PEDEM COISAS DIFERENTES, e isso e decisao:
//  - LER exige so o gate da CONVERSA (`podeVerConversa` + `restricaoEfetiva`),
//    igual a ficha e as anotacoes: quem pode abrir a conversa ve a memoria dela;
//  - ESCREVER exige a permissao nomeada `editar_contexto`, porque muda o que a
//    automacao vai fazer ali. Ela e SEPARADA de `automacao` de proposito — quem
//    destrava um menu na conversa que tem na tela nao precisa poder editar fluxo
//    nenhum, e quem edita fluxo nao e necessariamente quem atende.
//
// CANAL SOMENTE LEITURA SEGUE VALENDO AQUI, ao contrario de status/etiqueta/nota
// (que respondem 403 em fonte externa). O motivo esta em `lib/canais.ts`: a
// memoria mora numa tabela do PAINEL chaveada por (canal, chat_id) e nao escreve
// nada na origem — mesma razao pela qual `definir_contexto` esta em
// `ACOES_SO_DO_PAINEL`. Recusar aqui tiraria a memoria justamente do canal onde
// ela e a unica coisa que o painel consegue guardar.
//
// SEM A MIGRATION 0016 nao ha 500: `lib/fluxo/contexto-db.ts` devolve
// `{ok:false, aviso}` com a CAUSA (tabela, funcao, coluna, grant ou rede) e a
// rota entrega isso como 503 com a frase. Vazio calado seria pior — "esta
// conversa nao tem memoria" e uma afirmacao que a rota nao pode fazer quando a
// verdade e "a tabela nao existe nesta instalacao".
//
// COSTURA DE UI DECLARADA, NAO FEITA: o painel da memoria na ficha da conversa
// mora em `app/home.tsx`, que tem outro dono nesta onda (Frente S). A rota e a
// consulta estao prontas e provadas; quem desenhar consome o `contexto` do GET e
// manda o POST. `pode_editar` ja vem na resposta justamente pra tela nao oferecer
// um campo que devolveria 403.

const MOTIVO_SEM_PERMISSAO =
  "sem a permissao de editar a memoria da conversa (editar_contexto) — marcar na tela de papeis";

/**
 * Autorizacao comum aos dois verbos, com a identidade JA RESOLVIDA.
 *
 * A identidade sai daqui de proposito: no POST o canal vem do CORPO, e o corpo so
 * pode ser lido DEPOIS de `getUser` (ver a nota no POST). Deixar o `getUser` aqui
 * dentro obrigava a rota a ler o corpo primeiro — que e exatamente o GRAVE D1.
 */
async function portaoDoUsuario(req: NextRequest, user: UsuarioLogado, chatId: string, canal: string) {
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") {
    return { erro: NextResponse.json({ error: "contexto invalido" }, { status: 401 }) };
  }
  if (!(await podeVerConversa(chatId, user, perfil, canal))) {
    return { erro: NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 }) };
  }
  if (emb && !emb.permite(chatId)) {
    return { erro: NextResponse.json({ error: "fora do contexto" }, { status: 403 }) };
  }
  return { user, perfil };
}

/** O GET nao tem corpo: identidade e porta saem juntas. */
async function portao(req: NextRequest, chatId: string, canal: string) {
  const user = await getUser(req);
  if (!user) return { erro: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  return portaoDoUsuario(req, user, chatId, canal);
}

export async function GET(req: NextRequest) {
  const chatId = req.nextUrl.searchParams.get("chat_id");
  if (!chatId) return NextResponse.json({ error: "chat_id obrigatorio" }, { status: 400 });
  const canal = canalDe(req);

  const g = await portao(req, chatId, canal);
  if ("erro" in g) return g.erro;

  const r = await lerContexto(canal, chatId);
  const semCache = { headers: { "Cache-Control": "no-store, max-age=0" } };
  if (!r.ok) {
    // 503 com a CAUSA, nunca `{}` com 200: contexto vazio e um fato sobre a
    // conversa, e a rota so pode afirmar isso quando conseguiu ler
    return NextResponse.json({ error: r.aviso, disponivel: false }, { status: 503, ...semCache });
  }
  return NextResponse.json(
    {
      canal,
      chat_id: chatId,
      contexto: r.dados,
      disponivel: true,
      // o servidor manda, a tela reflete (regra da casa): sem isso a tela
      // adivinharia pelo papel base e ofereceria um campo que devolve 403
      pode_editar: permitido(g.perfil, "editar_contexto"),
    },
    semCache
  );
}

export async function POST(req: NextRequest) {
  // A IDENTIDADE VEM ANTES DO CORPO — e aqui isto e o GRAVE D1 LITERAL, medido na
  // 2a re-revisao. Esta rota esta em `CANAL_PADRAO_EM` com ["GET","POST"] e decide
  // o canal pelo CORPO (`canalDeBody`). Lendo o corpo primeiro:
  //
  //   rota: await req.json()   -> corpo consumido
  //   getUser -> canalDoPedido -> req.clone() LANCA "Body is unusable"
  //                            -> catch (lib/canais.ts) -> canal do corpo = null
  //   escopoPermite: canal null + rota de CANAL_PADRAO_EM -> compara o canal
  //                  ASSUMIDO (central) enquanto a rota escreve no canal PEDIDO
  //
  // Ou seja: chave escopada ao `central` gravava e apagava a memoria de conversa
  // do `apioficial`. Nada quebrava — a comparacao so parava de acontecer.
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const chatId = typeof body?.chat_id === "string" ? body.chat_id : "";
  if (!chatId) return NextResponse.json({ error: "chat_id obrigatorio" }, { status: 400 });
  const canal = canalDeBody(body);

  const g = await portaoDoUsuario(req, user, chatId, canal);
  if ("erro" in g) return g.erro;

  // O GATE DE PERMISSAO VEM ANTES DE QUALQUER EFEITO (licao da revisao cega da
  // frente O: um pedido que aplicava o efeito e SO ENTAO levava 403 e a pior
  // combinacao possivel — efeito parcial com resposta de recusa).
  if (!permitido(g.perfil, "editar_contexto")) {
    return NextResponse.json({ error: MOTIVO_SEM_PERMISSAO }, { status: 403 });
  }

  const chave = typeof body?.chave === "string" ? body.chave : "";
  if (!chave.trim()) return NextResponse.json({ error: "chave obrigatoria" }, { status: 400 });

  // AUTORIA pela convencao da 0006: id + nome = pessoa. Aqui SEMPRE ha pessoa —
  // a automacao grava pelo motor, nao por esta rota.
  const por = { id: g.user.id, nome: g.user.nome };

  // `limpar` != gravar vazio, e a diferenca e semantica: so apagando a chave o
  // `nao_existe` da condicao volta a valer (regra do avaliador, frente L).
  // Por isso apagar e um campo EXPLICITO e nao `valor: ""`.
  if (body?.limpar === true) {
    const r = await limparContexto(canal, chatId, chave, por);
    if (!r.ok) return NextResponse.json({ error: r.aviso }, { status: 503 });
    return NextResponse.json({ ok: true, contexto: r.dados, acao: "limpar" });
  }

  if (typeof body?.valor !== "string") {
    return NextResponse.json(
      { error: "valor tem que ser texto (pra APAGAR a chave, mande limpar:true — gravar vazio nao e apagar)" },
      { status: 400 }
    );
  }

  const r = await definirContexto(canal, chatId, chave, body.valor, por);
  // 400 pra pedido invalido (chave torta, valor grande) e 503 pra indisponivel:
  // a frase de `contexto-db` distingue, e mandar tudo como 503 faria o atendente
  // procurar problema de migration num nome de variavel errado
  if (!r.ok) {
    const eIndisponivel = /indisponivel|permissao|nao deu pra falar/i.test(r.aviso);
    return NextResponse.json({ error: r.aviso }, { status: eIndisponivel ? 503 : 400 });
  }
  return NextResponse.json({ ok: true, contexto: r.dados, acao: "definir" });
}
