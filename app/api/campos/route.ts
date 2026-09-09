import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, permitido } from "@/lib/perfil";
import {
  colisoesDeNome,
  mesmoCampo,
  planoDeOrdem,
  planoDeRenome,
  validarDefinicao,
  vereditoDaRemocao,
  DESCRICAO_TIPO,
  MAX_CAMPOS,
  MAX_OPCOES,
  TIPOS_CAMPO,
  decidirPorta,
  executarArquivamento,
} from "@/lib/campos";
import { efeitosDeArquivamento } from "@/lib/campos-efeitos";
import {
  apagarCampo,
  canaisDaFicha,
  contarCampoNoCanal,
  gravarCampo,
  gravarOrdens,
  impactoDoCampo,
  lerCatalogo,
  renomearValores,
} from "@/lib/campos-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// CONSTRUTOR DA FICHA — o catalogo de campos personalizados desta instalacao
// (Frente X, card 86ak85nxn).
//
// ESTA ROTA NAO FALA DE CANAL, e isso e propriedade dela, nao esquecimento: o
// catalogo e da INSTALACAO (uma linha em `mensageria.campos_personalizados`, sem
// coluna de canal) e o VALOR mora na tabela de conversas de CADA canal. Logo:
//   * ela NAO entra em `CANAL_PADRAO_EM` (declarar canal padrao pra rota que nao
//     le canal do pedido cria NEGACAO FALSA pra chave restrita a um numero —
//     defeito ja medido duas vezes neste repo);
//   * nenhum id de canal aparece como literal aqui (a varredura B.10 da
//     `prova-seguranca-conta.ts` cobraria entrada na tabela, e ela estaria certa);
//   * o recorte por canal de uma chave de API nao alcanca este catalogo, do mesmo
//     jeito que nao alcanca `/api/admin/*`. O que barra chave e o verbete de
//     recurso (`admin`, em lib/escopo-chave.ts) mais a permissao.
//
// POR QUE O RECURSO E `admin`, E NAO `ficha`: uma chave com
// `recursos: ["ficha"]` foi consentida pra ler e escrever a ficha de UM contato.
// Se o catalogo caisse naquele verbete, a MESMA chave passaria a poder REMOVER um
// campo da instalacao inteira — mesma classe de decisao que separou `exportacao`
// de `relatorios`. Chave antiga fica fail-closed, e o dono opta explicitamente.
//
// A PERMISSAO E `gerenciar_campos`, separada de `gerenciar_etiquetas`: ver a
// justificativa no verbete dela em lib/permissoes.ts.

// a MENSAGEM e o STATUS saem de `decidirPorta` (lib/campos.ts, pura e provada por
// desfecho): aqui so viram resposta HTTP.

/**
 * CATALOGO ILEGIVEL = 503, e nao "a instalacao nao tem campo nenhum".
 *
 * `lerCatalogo` devolve lista VAZIA com aviso quando a leitura falha (nunca 500,
 * nunca lista vazia calada). Quem so LE pode seguir com a lista vazia + o aviso;
 * quem DECIDE em cima dela, nao: `criar` conferia teto, colisao e `ordem` contra
 * `cat.campos`, entao um blip no select fazia os tres sumirem de uma vez —
 * sobrava so a UNIQUE exata da 0001, e "CNPJ" nascia ao lado de um "cnpj"
 * existente. A partir dai `acharCampo` fica AMBIGUO e toda escrita naquele campo
 * e recusada na conta inteira.
 *
 * 503 (e nao 500): a leitura pode voltar no proximo pedido — e a mensagem diz o
 * que aconteceu, em vez de deixar a tela inventar que a ficha esta vazia.
 *
 * NAO confundir com a 0025 pendente: aquilo tem `aviso` TAMBEM, e ali o
 * construtor segue funcionando (texto livre). Por isso a conferencia e
 * `cat.legivel`, e nao `cat.aviso`.
 */
function ilegivel(cat: { legivel: boolean; aviso?: string }) {
  if (cat.legivel) return null;
  return NextResponse.json(
    { error: cat.aviso || "nao deu pra ler o catalogo de campos agora", catalogo_ilegivel: true },
    { status: 503 }
  );
}

async function porta(req: NextRequest) {
  const user = await getUser(req);
  const perfil = user ? await getPerfil(user.id) : null;
  const veredito = decidirPorta(user, !!perfil && permitido(perfil, "gerenciar_campos"));
  if (!veredito.ok) {
    return { erro: NextResponse.json({ error: veredito.erro }, { status: veredito.status }) };
  }
  return { user: user!, perfil };
}

export async function GET(req: NextRequest) {
  const p = await porta(req);
  if ("erro" in p) return p.erro;

  const cat = await lerCatalogo();

  // `?impacto=<nome>` responde "quantas conversas tem valor neste campo", por
  // canal. A tela chama isso ANTES de oferecer remover/renomear — o numero e o
  // que impede a remocao no escuro, e ele e caro (uma contagem por canal), entao
  // nao vem no GET do catalogo.
  const alvo = req.nextUrl.searchParams.get("impacto");
  let impacto: any = null;
  if (alvo) {
    const campo = cat.campos.find((c) => c.nome === alvo) ?? cat.campos.find((c) => mesmoCampo(c.nome, alvo));
    if (!campo) return NextResponse.json({ error: "campo nao encontrado no catalogo" }, { status: 404 });
    const medido = await impactoDoCampo(campo.nome);
    impacto = {
      campo: campo.nome,
      ...medido,
      veredito: vereditoDaRemocao(medido),
      renome: planoDeRenome(medido, cat.renome_disponivel),
    };
  }

  return NextResponse.json(
    {
      campos: cat.campos,
      tipos: TIPOS_CAMPO.map((t) => ({ tipo: t, descricao: DESCRICAO_TIPO[t] })),
      tipos_disponiveis: cat.tipos_disponiveis,
      renome_disponivel: cat.renome_disponivel,
      // COLISAO ANTIGA E PENDENCIA, NAO ERRO: o sync do ChatGuru cria campo com o
      // rotulo da tela de origem, e ao longo dos anos a mesma coisa aparece
      // escrita de formas diferentes. A rota recusa colisao NOVA; a que ja existe
      // aparece aqui pra alguem consertar com contexto (ver o cabecalho da 0025
      // sobre por que isto NAO e um unique no banco).
      colisoes: colisoesDeNome(cat.campos),
      max_campos: MAX_CAMPOS,
      max_opcoes: MAX_OPCOES,
      impacto,
      aviso: cat.aviso,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  const p = await porta(req);
  if ("erro" in p) return p.erro;
  const body = await req.json().catch(() => ({}));
  const acao = String(body?.acao ?? "");

  if (acao === "reordenar") return reordenar(body);
  if (acao === "criar") return criar(body);
  if (acao === "editar") return editar(body);
  if (acao === "arquivar" || acao === "reativar") return arquivar(body, acao === "arquivar");

  return NextResponse.json(
    { error: "acao invalida (criar | editar | reordenar | arquivar | reativar)" },
    { status: 400 }
  );
}

async function criar(body: any) {
  const cat = await lerCatalogo();
  const ruim = ilegivel(cat);
  if (ruim) return ruim;
  const v = validarDefinicao(body);
  if (!v.ok) return NextResponse.json({ error: v.erros.join("; "), erros: v.erros }, { status: 422 });

  const ativos = cat.campos.filter((c) => c.ativo);
  if (ativos.length >= MAX_CAMPOS) {
    return NextResponse.json(
      { error: `esta ficha ja tem ${ativos.length} campos ativos (teto ${MAX_CAMPOS}); arquive algum antes de criar outro` },
      { status: 409 }
    );
  }
  // COLISAO NOVA E RECUSADA POR IGUALDADE NORMALIZADA, nunca por `ilike`:
  // armadilha conhecida deste repo (`%` e `_` digitados viram coringa), e `_` e
  // comum de verdade em nome de campo importado. E a checagem vale contra o
  // catalogo INTEIRO, inclusive arquivado: criar "CNPJ" com um "cnpj" arquivado
  // guardando valor faria dois campos disputarem a mesma chave do jsonb.
  const colide = cat.campos.find((c) => mesmoCampo(c.nome, v.campo.nome));
  if (colide) {
    return NextResponse.json(
      {
        error: `ja existe o campo "${colide.nome}"${colide.ativo ? "" : " (arquivado)"} — nomes que diferem so por caixa ou acento disputariam o mesmo valor na ficha`,
      },
      { status: 409 }
    );
  }

  const ordem = (ativos.reduce((m, c) => Math.max(m, c.ordem), 0) || 0) + 1;
  const r = await gravarCampo(
    null,
    {
      nome: v.campo.nome,
      ativo: true,
      ordem,
      tipo: v.campo.tipo,
      obrigatorio: v.campo.obrigatorio,
      opcoes: v.campo.opcoes,
      descricao: v.campo.descricao,
      atualizado_em: new Date().toISOString(),
    },
    cat.tipos_disponiveis
  );
  if (!r.ok) return NextResponse.json({ error: r.motivo }, { status: r.status });
  return NextResponse.json({
    ok: true,
    id: r.id,
    // O QUE NAO ENTROU VAI NA RESPOSTA. Sem a 0025 o campo nasce como texto
    // livre, e dizer "salvei" sobre um tipo que nao foi gravado e a mentira que
    // faz o admin sair achando que a ficha esta tipada.
    tipos_disponiveis: cat.tipos_disponiveis,
    aviso: cat.tipos_disponiveis ? undefined : cat.aviso,
  });
}

async function editar(body: any) {
  const cat = await lerCatalogo();
  const ruim = ilegivel(cat);
  if (ruim) return ruim;
  const id = typeof body?.id === "string" ? body.id : "";
  const atual = cat.campos.find((c) => c.id === id);
  if (!atual) return NextResponse.json({ error: "campo nao encontrado" }, { status: 404 });

  // PATCH POR CAMPO: chave ausente MANTEM o valor gravado. Tratar ausente como
  // default apagaria a dimensao que o chamador nao mandou — o furo dos DOIS
  // sentidos que a Frente Q mediu no escopo de chave de API (aperta calado /
  // afrouxa calado). Pra limpar, manda explicito (`descricao: null`,
  // `opcoes: []`).
  const pedido = {
    nome: body?.nome === undefined ? atual.nome : body.nome,
    tipo: body?.tipo === undefined ? atual.tipo : body.tipo,
    obrigatorio: body?.obrigatorio === undefined ? atual.obrigatorio : body.obrigatorio,
    opcoes: body?.opcoes === undefined ? atual.opcoes : body.opcoes,
    descricao: body?.descricao === undefined ? atual.descricao : body.descricao,
  };
  const v = validarDefinicao(pedido);
  if (!v.ok) return NextResponse.json({ error: v.erros.join("; "), erros: v.erros }, { status: 422 });

  const trocouNome = v.campo.nome !== atual.nome;
  let renome: any = null;
  if (trocouNome) {
    const colide = cat.campos.find((c) => c.id !== atual.id && mesmoCampo(c.nome, v.campo.nome));
    if (colide) {
      return NextResponse.json(
        { error: `ja existe o campo "${colide.nome}" — nomes que diferem so por caixa ou acento disputariam o mesmo valor na ficha` },
        { status: 409 }
      );
    }
    // RENOMEAR SEM MIGRAR O VALOR E PERDA SILENCIOSA, e ela existia aqui antes
    // desta frente (`/api/admin/ficha-config` faz UPDATE no nome e ponto): a tela
    // da conversa desenha a ficha iterando o CATALOGO, entao o valor de todo mundo
    // fica no banco e invisivel. A ordem abaixo e o que fecha isso: mede o
    // impacto, decide, MIGRA os valores em todos os canais e SO DEPOIS troca o
    // nome no catalogo. Falha na migracao = nada e renomeado.
    const impacto = await impactoDoCampo(atual.nome);
    const plano = planoDeRenome(impacto, cat.renome_disponivel);
    if (!plano.ok) {
      return NextResponse.json({ error: plano.motivo, impacto }, { status: 409 });
    }
    if (plano.migrar) {
      const mig = await renomearValores(atual.nome, v.campo.nome);
      if (!mig.ok) return NextResponse.json({ error: mig.motivo, impacto }, { status: 502 });
      renome = { renomeadas: mig.renomeadas, conflitos: mig.conflitos };
    }
  }

  const r = await gravarCampo(
    atual.id,
    {
      nome: v.campo.nome,
      tipo: v.campo.tipo,
      obrigatorio: v.campo.obrigatorio,
      opcoes: v.campo.opcoes,
      descricao: v.campo.descricao,
      atualizado_em: new Date().toISOString(),
    },
    cat.tipos_disponiveis
  );
  if (!r.ok) return NextResponse.json({ error: r.motivo, renome }, { status: r.status });
  return NextResponse.json({
    ok: true,
    renome,
    tipos_disponiveis: cat.tipos_disponiveis,
    aviso: cat.tipos_disponiveis ? undefined : cat.aviso,
  });
}

async function arquivar(body: any, arquivando: boolean) {
  const cat = await lerCatalogo();
  const ruim = ilegivel(cat);
  if (ruim) return ruim;
  const id = typeof body?.id === "string" ? body.id : "";
  const atual = cat.campos.find((c) => c.id === id);
  if (!atual) return NextResponse.json({ error: "campo nao encontrado" }, { status: 404 });

  // ARQUIVAR E EM DOIS PASSOS, IGUAL AO REMOVER — e o CORPO DESTE HANDLER mora
  // em `executarArquivamento` (lib/campos.ts, efeitos injetados, provado por
  // desfecho), nao aqui. Enquanto a sequencia era linha solta do handler, a unica
  // prova possivel era varredura — e varredura pega a REMOCAO da linha, nunca o
  // DESLIGAMENTO: `if (passo === "previa" && false)` arquivava na hora, sem
  // previa, com a bateria inteira verde (medido na 3a rodada da re-revisao cega).
  // Arquivar tira o campo do formulario da CONTA INTEIRA. O porque de REATIVAR
  // nao ter previa esta no verbete de la.
  //
  // E OS EFEITOS TAMBEM SAIRAM DAQUI (4a rodada): `efeitosDeArquivamento` mora em
  // lib/campos-efeitos.ts, que a prova IMPORTA e executa com um banco fake. O que
  // ficou nesta linha e so a lista de dependencias, por referencia — sem lambda com
  // corpo, que e onde caberia um `?? 0` ou um impacto zerado.
  const r = await executarArquivamento(
    atual,
    arquivando,
    body?.confirmar,
    efeitosDeArquivamento({
      canais: canaisDaFicha(),
      contar: contarCampoNoCanal,
      gravarCampo,
      tiposDisponiveis: cat.tipos_disponiveis,
    })
  );
  return NextResponse.json(r.corpo, { status: r.status });
}

async function reordenar(body: any) {
  const cat = await lerCatalogo();
  const ruim = ilegivel(cat);
  if (ruim) return ruim;
  const plano = planoDeOrdem(cat.campos, body?.ordem);
  if (!plano.ok) return NextResponse.json({ error: plano.erro }, { status: 422 });
  const r = await gravarOrdens(plano.ordens);
  if (!r.ok) return NextResponse.json({ error: r.motivo }, { status: r.status });
  return NextResponse.json({ ok: true, ordens: plano.ordens });
}

/**
 * REMOVER campo. Dois passos, e o primeiro nao muda nada.
 *
 * Sem `confirmar=1` a rota devolve a PREVIA: o impacto medido por canal e o
 * veredito. Com `confirmar=1` ela aplica — e so aplica quando o veredito diz
 * `remover`, ou seja quando NENHUMA conversa tem valor gravado ali. Com valor,
 * responde 409 com o numero e aponta o caminho certo (arquivar). Contagem que
 * FALHOU tambem recusa: contagem que falhou nao e contagem zero, e o que se perde
 * aqui e historico de cliente.
 */
export async function DELETE(req: NextRequest) {
  const p = await porta(req);
  if ("erro" in p) return p.erro;
  const cat = await lerCatalogo();
  const ruim = ilegivel(cat);
  if (ruim) return ruim;
  const id = req.nextUrl.searchParams.get("id") || "";
  const atual = cat.campos.find((c) => c.id === id);
  if (!atual) return NextResponse.json({ error: "campo nao encontrado" }, { status: 404 });

  const impacto = await impactoDoCampo(atual.nome);
  const veredito = vereditoDaRemocao(impacto);
  const confirmado = req.nextUrl.searchParams.get("confirmar") === "1";

  if (!confirmado) {
    return NextResponse.json({ previa: true, campo: atual.nome, impacto, veredito });
  }
  if (veredito.acao !== "remover") {
    return NextResponse.json(
      { error: veredito.motivo, campo: atual.nome, impacto, veredito },
      { status: veredito.acao === "recusar" ? 503 : 409 }
    );
  }
  const r = await apagarCampo(atual.id);
  if (!r.ok) return NextResponse.json({ error: r.motivo }, { status: r.status });
  return NextResponse.json({ ok: true, campo: atual.nome, impacto });
}
