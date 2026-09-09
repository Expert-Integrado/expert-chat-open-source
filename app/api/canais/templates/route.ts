import { NextRequest, NextResponse } from "next/server";
import { canalPublico, type CanalDef } from "@/lib/canais";
import { portaDoCanal, portaDoCorpo, recusou } from "@/lib/canais-porta";
import { credsGupshup, faltaAppId, gsApagarTemplate, gsCriarTemplate, gsListarTemplates, gsSaldo } from "@/lib/gupshup";
import {
  ROTULO_STATUS,
  botoesValidos,
  lerSaldo,
  lerTemplateGupshup,
  sugerirExemplo,
  validarNovoTemplate,
  type TemplateCanal,
} from "@/lib/templates-oficial";
import { removerTemplate, registrarEvento, salvarTemplates, templatesDoCanal } from "@/lib/canais-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// TEMPLATES DE MENSAGEM POR NUMERO — API OFICIAL (card 86ak858pa)
//
//   GET    /api/canais/templates?canal=<id>          -> catalogo do canal (+ saldo)
//   POST   /api/canais/templates                     -> {canal, acao}
//          acao: "sincronizar"  busca o veredito da Meta no provedor
//          acao: "criar"        manda um template pra aprovacao
//   DELETE /api/canais/templates?canal=<id>&nome=... -> apaga no provedor E no espelho
//
// TRES DECISOES QUE MANDAM NESTE ARQUIVO:
//
// 1. O TEMPLATE PERTENCE AO CANAL, nao a conta. Na API Oficial a aprovacao e por
//    NUMERO REMETENTE: o mesmo nome pode estar aprovado num numero e recusado no
//    outro, e mandar o template do numero A pelo numero B e recusa garantida. Por
//    isso `canal` e obrigatorio aqui tambem — sem default, como em
//    /api/canais/conexao.
//
// 2. SINCRONIZAR E GESTO EXPLICITO. Nada de cron, nada de sync escondido no
//    polling da tela. Quem aprova esta do lado de fora (Meta) e buscar o veredito
//    custa chamada ao provedor: chamada que roda sozinha e a que aparece na fatura
//    sem ninguem ter pedido. O carimbo `sincronizado_em` fica visivel na tela,
//    porque catalogo velho sem aviso e o mesmo defeito do QR expirado sem aviso.
//
// 3. O ESPELHO EXISTE PRA BARRAR ANTES. `podeEnviarTemplate` (puro) recusa envio
//    com template em analise, recusado, pausado ou desconhecido ANTES da chamada
//    ao provedor — a recusa da Meta gastaria chamada e, em template
//    recusado/pausado, arranha a nota de qualidade do numero.
//
// PERMISSAO — DUAS, por nivel (revisao cega): LER o catalogo e sincronizar o
// espelho e `gerenciar_canais`; CRIAR e APAGAR template exige `conectar_numero`,
// porque escreve num sistema EXTERNO com a credencial da empresa e template
// reprovado derruba a nota de qualidade do WABA (que mexe no limite de disparo).
// O gate e no servidor; o botao sumir da tela e so aparencia.

/**
 * Template existe SO no numero de API Oficial (Meta) — a aprovacao e por
 * remetente. 409 e nao 403: nao e falta de permissao, e um numero que NAO TEM
 * template. Numero Z-API/Evolution manda texto livre a qualquer hora (nao ha
 * janela de 24h nem aprovacao da Meta), e dizer isso e melhor que devolver lista
 * vazia — lista vazia faria o usuario procurar um botao de sincronizar que nao
 * resolveria nada.
 */
function exigeApiOficial(canal: CanalDef): NextResponse | null {
  if (canal.fonte === "gupshup") return null;
  return NextResponse.json(
    {
      error:
        "template de mensagem existe so no numero de API Oficial (Meta). Neste numero a conversa e livre — nao precisa de template.",
      fonte: canal.fonte,
    },
    { status: 409 }
  );
}

export async function GET(req: NextRequest) {
  // GET e nivel "ler": ver o catalogo do numero nao mexe em nada.
  const p = await portaDoCanal(req, req.nextUrl.searchParams.get("canal"), "ler");
  if (recusou(p)) return p.erro;
  const { canal } = p;
  const oficial = exigeApiOficial(canal);
  if (oficial) return oficial;

  const [cat, creds] = await Promise.all([templatesDoCanal(canal.id), credsGupshup(canal.id)]);

  // SALDO e informacao de APOIO: sem credencial ou sem resposta legivel, a tela
  // diz "indisponivel" e segue funcionando (`lerSaldo` nunca estoura). Tela de
  // canal que fica vermelha por causa do saldo seria pior que tela sem saldo.
  const saldo = creds ? lerSaldo(await gsSaldo(creds)) : lerSaldo(null);

  return NextResponse.json(
    {
      canal: canalPublico(canal),
      // sem credencial nesta instalacao: a tela mostra o catalogo (espelho) e
      // desabilita sincronizar/criar/apagar, em vez de fingir que da
      cabeado: !!creds,
      app_configurado: creds ? !faltaAppId(creds) : false,
      templates: cat.lista.map((t) => ({ ...t, rotulo_status: ROTULO_STATUS[t.status] })),
      sincronizado_em: cat.sincronizado_em,
      saldo,
      disponivel: cat.disponivel,
      aviso: cat.aviso,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  // QUEM LE O CORPO E A PORTA (GRAVE D1): `req.json()` aqui deixava o escopo de
  // canal da chave de API inerte, porque `getUser` nao conseguia mais clonar.
  const p = await portaDoCorpo(req, (body) => {
    if (body?.acao !== "sincronizar" && body?.acao !== "criar") {
      return NextResponse.json({ error: 'acao invalida — use "sincronizar" ou "criar"' }, { status: 400 });
    }
    // DUAS PERMISSOES, pela consequencia da acao (revisao cega):
    //   SINCRONIZAR e leitura do provedor pro espelho local — nivel "ler".
    //   CRIAR escreve num sistema EXTERNO com a credencial da empresa, e template
    //   reprovado derruba a nota de qualidade do WABA (a nota mexe no limite de
    //   disparo) — nivel "operar".
    return body.acao === "criar" ? "operar" : "ler";
  });
  if (recusou(p)) return p.erro;
  const { canal, user, body } = p;
  const acao = body.acao as "sincronizar" | "criar";
  const oficial = exigeApiOficial(canal);
  if (oficial) return oficial;

  const creds = await credsGupshup(canal.id);
  if (!creds) {
    return NextResponse.json(
      {
        error:
          "este numero nao tem credencial de API Oficial configurada nesta instalacao " +
          "(GUPSHUP_<CANAL>_API_KEY / _SOURCE_NUMBER / _APP_ID)",
      },
      { status: 501 }
    );
  }
  if (faltaAppId(creds)) {
    // o envio de sessao funciona com source+api_key; o CATALOGO exige app_id. Sem
    // essa distincao o usuario veria 404 do provedor e nao saberia o que faltava.
    return NextResponse.json(
      { error: "para administrar templates este numero precisa do GUPSHUP_<CANAL>_APP_ID na instalacao" },
      { status: 501 }
    );
  }

  // ————————————————————————————————————————————— acao: sincronizar
  if (acao === "sincronizar") {
    const r = await gsListarTemplates(creds);
    if (!r.ok) return NextResponse.json({ error: r.motivo }, { status: 502 });

    const lista: TemplateCanal[] = r.lista.map(lerTemplateGupshup);
    const g = await salvarTemplates(canal.id, lista);
    if (!g.ok) {
      // AS DUAS FALHAS SAO DIFERENTES (achado de revisao), e o status tem que
      // separa-las:
      //
      //   `escrita` (migration ausente, banco fora, permissao) = 503. Devolver 200
      //   {ok:false} aqui fazia a tela mostrar aviso amarelo pra algo que e falha
      //   de infra — e quem chama por script/curl leria 200 e concluiria que
      //   sincronizou.
      //
      //   `decisao` (lista vazia, nomes fora do formato) = 200. Nao houve erro:
      //   houve um RESULTADO que nao serve pra sobrescrever o espelho, e o espelho
      //   ficou como estava de proposito.
      if (g.falha === "escrita") {
        return NextResponse.json({ error: g.aviso, disponivel: false }, { status: 503 });
      }
      return NextResponse.json({ ok: false, aviso: g.aviso, no_provedor: lista.length });
    }
    await registrarEvento(canal.id, {
      tipo: "templates_sincronizados",
      autor_id: user.id,
      autor_nome: user.nome,
      detalhe: { quantidade: g.gravados, removidos: g.removidos },
    });
    const cat = await templatesDoCanal(canal.id);
    return NextResponse.json({
      ok: true,
      gravados: g.gravados,
      removidos: g.removidos,
      templates: cat.lista.map((t) => ({ ...t, rotulo_status: ROTULO_STATUS[t.status] })),
      sincronizado_em: cat.sincronizado_em,
    });
  }

  // ——————————————————————————————————————————————————— acao: criar
  //
  // A validacao roda ANTES de qualquer chamada: cada linha de
  // `validarNovoTemplate` e uma reprovacao da Meta que ja aconteceu de verdade, e
  // template reprovado mexe na nota de qualidade do numero da empresa.
  const novo = {
    nome: String(body?.nome ?? "").trim().toLowerCase(),
    categoria: String(body?.categoria ?? "") as "UTILITY" | "MARKETING" | "AUTHENTICATION",
    assunto: String(body?.assunto ?? "").trim(),
    corpo: String(body?.corpo ?? "").trim(),
    // exemplo em branco com corpo COM variavel e o erro mais comum do formulario:
    // preencher com a sugestao seria decidir pelo usuario um texto que a Meta vai
    // LER — entao aqui so sugerimos de volta, e a validacao cobra.
    exemplo: String(body?.exemplo ?? "").trim(),
    idioma: String(body?.idioma ?? "pt_BR").trim() || "pt_BR",
    rodape: String(body?.rodape ?? "").trim(),
    botoes: botoesValidos(body?.botoes),
  };
  const erros = validarNovoTemplate(novo);
  if (erros.length) {
    return NextResponse.json(
      {
        error: erros[0],
        erros,
        ...(novo.corpo && !novo.exemplo ? { exemplo_sugerido: sugerirExemplo(novo.corpo) } : {}),
      },
      { status: 400 }
    );
  }

  const r = await gsCriarTemplate(creds, {
    nome: novo.nome,
    idioma: novo.idioma,
    categoria: novo.categoria,
    assunto: novo.assunto,
    corpo: novo.corpo,
    exemplo: novo.exemplo || novo.corpo,
    rodape: novo.rodape,
    botoes: novo.botoes,
    midiaId: String(body?.midia_id ?? "").trim(),
  });
  if (!r.ok) return NextResponse.json({ error: r.motivo }, { status: 400 });

  // NAO grava o template no espelho aqui, de proposito: ele nasce PENDING e o
  // espelho e o que autoriza envio. Gravar agora criaria uma linha que so a
  // sincronizacao seguinte confirma — e a fonte da verdade e o provedor. O que a
  // rota devolve e o passo seguinte, escrito.
  return NextResponse.json({
    ok: true,
    provider_id: r.providerId,
    status_provedor: r.status,
    proximo_passo:
      "o template foi enviado pra aprovacao da Meta (de minutos a 24h). Clique em Sincronizar " +
      "mais tarde pra ver o veredito — ate ser aprovado, ele nao pode ser usado.",
  });
}

export async function DELETE(req: NextRequest) {
  const nomeCru = req.nextUrl.searchParams.get("nome");
  // APAGAR sai da Meta e NAO VOLTA — nivel "operar".
  const p = await portaDoCanal(req, req.nextUrl.searchParams.get("canal"), "operar");
  if (recusou(p)) return p.erro;
  const { canal, user } = p;
  const oficial = exigeApiOficial(canal);
  if (oficial) return oficial;

  const nome = String(nomeCru ?? "").trim().toLowerCase();
  // o nome vai NA URL da API do provedor: formato livre aqui seria path traversal.
  // Mesmo formato que o CHECK da 0023 exige, e que `validarNovoTemplate` cobra.
  if (!nome || !/^[a-z0-9_]{1,512}$/.test(nome)) {
    return NextResponse.json({ error: "nome de template invalido" }, { status: 400 });
  }
  const idioma = String(req.nextUrl.searchParams.get("idioma") ?? "").trim();

  const creds = await credsGupshup(canal.id);
  if (!creds) {
    return NextResponse.json(
      { error: "este numero nao tem credencial de API Oficial configurada nesta instalacao" },
      { status: 501 }
    );
  }
  const r = await gsApagarTemplate(creds, nome);
  if (!r.ok) return NextResponse.json({ error: r.motivo }, { status: 502 });

  // some do espelho SO depois de sair do provedor. A ordem importa: apagar o
  // espelho primeiro e falhar no provedor deixaria um template vivo (e enviavel
  // por fora) que o painel jura que nao existe.
  await removerTemplate(canal.id, nome, idioma || undefined);
  await registrarEvento(canal.id, {
    tipo: "template_apagado",
    autor_id: user.id,
    autor_nome: user.nome,
    detalhe: { nome, idioma: idioma || null },
  });
  return NextResponse.json({ ok: true, apagado: nome });
}
