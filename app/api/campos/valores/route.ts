import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, podeVerConversa } from "@/lib/perfil";
import { restricaoEfetiva } from "@/lib/embed";
import { canalDe, canalDeBody, tabelas } from "@/lib/canal";
import { somenteLeitura } from "@/lib/canais";
import {
  aplicarPatchDeValores,
  lerValor,
  pendenciasObrigatorias,
  valoresOrfaos,
  MAX_CAMPOS,
  MAX_CHAVES_PATCH,
} from "@/lib/campos";
import { gravarFichaDaConversa, lerCatalogo, lerFichaDaConversa } from "@/lib/campos-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// OS VALORES DA FICHA DE UMA CONVERSA, ja com o tipo aplicado (Frente X).
//
// POR QUE ESTA ROTA EXISTE AO LADO DE `/api/ficha`, e por que isso NAO e uma
// segunda porta de escrita: `/api/ficha` e a rota da tela de conversa (e da tool
// `atualizar_ficha` do MCP) e devolve a ficha JUNTO com nome, etiquetas e
// anotacoes — ela nao sabe de tipo, de obrigatorio nem de opcao. Esta rota
// responde a outra pergunta: "quais campos esta ficha tem, de que tipo, o que
// esta preenchido, o que falta e o que esta fora do formato".
//
// A ESCRITA DAS DUAS PASSA PELA MESMA DECISAO: `aplicarPatchDeValores`
// (lib/campos.ts). Duas rotas com regras proprias divergiriam na primeira
// mudanca — e a divergencia aqui seria "o painel aceita e o MCP recusa o mesmo
// valor". Duas rotas chamando a MESMA decisao, nao.
//
// GATE: e o da CONVERSA, nao uma permissao nomeada. Preencher a ficha e
// atendimento; ADMINISTRAR os campos e `gerenciar_campos` (rota `/api/campos`) —
// e essa e a separacao que o card pede. Sobre por que PREENCHER nao ganhou
// permissao propria, ver a secao desta frente no CLAUDE.md: exigi-la tiraria a
// ficha de todo atendente com papel NOMEADO no dia do deploy, e a separacao
// pedida ja existe do lado que importa (quem preenche nao administra).

/**
 * A identidade sai daqui de proposito (mesmo desenho de /api/conversa/contexto):
 * no PATCH o chat_id vem do CORPO, e o corpo so pode ser lido DEPOIS de
 * `getUser` — consumir o corpo antes deixa o escopo da chave de API inerte
 * (GRAVE D1 da Frente W; esta rota foi pega exatamente assim no merge da onda 5).
 */
async function portaDoUsuario(req: NextRequest, user: NonNullable<Awaited<ReturnType<typeof getUser>>>, chatId: string, canal: string) {
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return { erro: NextResponse.json({ error: "contexto invalido" }, { status: 401 }) };
  if (!chatId) return { erro: NextResponse.json({ error: "chat_id obrigatorio" }, { status: 400 }) };
  if (!(await podeVerConversa(chatId, user, perfil, canal))) {
    return { erro: NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 }) };
  }
  if (emb && !emb.permite(chatId)) {
    return { erro: NextResponse.json({ error: "fora do contexto" }, { status: 403 }) };
  }
  return { user, perfil };
}

/** O GET nao tem corpo: identidade e porta saem juntas. */
async function porta(req: NextRequest, chatId: string, canal: string) {
  const user = await getUser(req);
  if (!user) return { erro: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  return portaDoUsuario(req, user, chatId, canal);
}

export async function GET(req: NextRequest) {
  const chatId = req.nextUrl.searchParams.get("chat_id") || "";
  const canal = canalDe(req);
  const p = await porta(req, chatId, canal);
  if ("erro" in p) return p.erro;

  const cat = await lerCatalogo();
  const ativos = cat.campos.filter((c) => c.ativo);

  // CANAL DE FONTE EXTERNA nao tem tabela de conversa no painel: a ficha dele nao
  // existe. Responde o CATALOGO (a tela precisa saber que campos existem) com
  // valores vazios e `somente_leitura`, em vez de 500 na leitura de uma tabela
  // que nao ha — mesmo desenho que `/api/ficha` ja usa.
  if (somenteLeitura(canal)) {
    return NextResponse.json(
      {
        chat_id: chatId,
        canal,
        somente_leitura: true,
        campos: ativos.map((c) => ({ ...c, valor: null })),
        pendencias: [],
        orfaos: [],
        tipos_disponiveis: cat.tipos_disponiveis,
        aviso: cat.aviso,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }

  const T = tabelas(canal);
  const f = await lerFichaDaConversa(T.conversas, chatId);
  if (!f.ok) return NextResponse.json({ error: f.motivo }, { status: f.status });

  return NextResponse.json(
    {
      chat_id: chatId,
      canal,
      somente_leitura: false,
      campos: ativos.map((c) => ({ ...c, valor: lerValor(c, f.ficha[c.nome]) })),
      // PENDENCIA E INFORMACAO, NAO TRAVA: campo obrigatorio sem valor aparece
      // aqui pra tela destacar. Nao existe gate de "preencha antes de concluir" —
      // isso seria politica de produto que ninguem decidiu, e travaria a operacao
      // em milhares de conversas importadas sem valor.
      pendencias: pendenciasObrigatorias(cat.campos, f.ficha),
      // VALOR QUE NENHUM CAMPO ATIVO ALCANCA — e este e o defeito que a feature
      // fecha. A tela da conversa desenha a ficha iterando o catalogo ATIVO, entao
      // valor de campo arquivado (ou renomeado pela rota antiga, ou trazido pelo
      // sync sem cadastro) ficava no banco e desaparecia da tela. Ninguem apagou
      // nada, e ninguem conseguia mais ver.
      orfaos: valoresOrfaos(cat.campos, f.ficha),
      tipos_disponiveis: cat.tipos_disponiveis,
      aviso: cat.aviso,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function PATCH(req: NextRequest) {
  // IDENTIDADE ANTES DO CORPO (GRAVE D1 da Frente W): `getUser` precisa do
  // request inteiro — corpo consumido nao clona, e o escopo da chave de API
  // ficaria inerte. Pego pela prova de seguranca no merge da onda 5.
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const chatId = typeof body?.chat_id === "string" ? body.chat_id : "";
  const canal = canalDeBody(body);
  const p = await portaDoUsuario(req, user, chatId, canal);
  if ("erro" in p) return p.erro;

  if (somenteLeitura(canal)) {
    return NextResponse.json(
      { error: "canal somente leitura: a ficha deste canal vive na fonte de origem e o painel nao escreve nela" },
      { status: 403 }
    );
  }
  const valores = body?.valores;
  if (!valores || typeof valores !== "object" || Array.isArray(valores)) {
    return NextResponse.json({ error: "valores (objeto campo -> valor) obrigatorio" }, { status: 400 });
  }
  // TETO DE CHAVES ANTES DE ITERAR: campo fora do catalogo agora vira linha em
  // `recusados` (era descarte silencioso), entao um corpo com 10 mil chaves
  // viraria 10 mil recusas e uma resposta de megabytes.
  const nChaves = Object.keys(valores).length;
  if (nChaves > MAX_CHAVES_PATCH) {
    return NextResponse.json(
      { error: `${nChaves} campos num pedido so; o teto e ${MAX_CHAVES_PATCH} (a ficha inteira tem no maximo ${MAX_CAMPOS} campos ativos)` },
      { status: 413 }
    );
  }

  const T = tabelas(canal);
  const [cat, f] = await Promise.all([lerCatalogo(), lerFichaDaConversa(T.conversas, chatId)]);
  if (!f.ok) return NextResponse.json({ error: f.motivo }, { status: f.status });
  // CATALOGO ILEGIVEL = 503, nao 422 dizendo que os campos "nao existem". Com a
  // lista vazia por engano, `aplicarPatchDeValores` recusaria TUDO com o motivo
  // errado ("nao existe um campo ativo com esse nome"), e o atendente iria
  // procurar o campo que ele esta vendo na tela. Nada e gravado nos dois casos —
  // o que muda e a frase, e a frase e o que faz alguem agir certo.
  if (!cat.legivel) {
    return NextResponse.json(
      { error: cat.aviso || "nao deu pra ler o catalogo de campos agora", catalogo_ilegivel: true },
      { status: 503 }
    );
  }

  const r = aplicarPatchDeValores(cat.campos, f.ficha, valores as Record<string, unknown>);

  // TUDO OU NADA. Qualquer recusa e 422 e NADA e gravado — o padrao de
  // `validarFluxo`. Gravar a parte boa e responder 200 faria o atendente sair
  // achando que a ficha inteira entrou, e o campo recusado e justamente o que ele
  // precisa corrigir.
  if (r.recusados.length) {
    return NextResponse.json(
      { error: r.recusados.map((x) => `${x.campo}: ${x.motivo}`).join("; "), recusados: r.recusados },
      { status: 422 }
    );
  }
  if (!r.aplicados.length) {
    // "salvei" sem ter salvado e a mentira que faz o atendente ir embora achando
    // que trocou o dado (mesmo criterio do PATCH de /api/agendadas).
    return NextResponse.json({ error: "nada pra mudar" }, { status: 400 });
  }

  const g = await gravarFichaDaConversa(T.conversas, chatId, r.ficha);
  if (!g.ok) return NextResponse.json({ error: g.motivo }, { status: g.status });

  return NextResponse.json({
    ok: true,
    aplicados: r.aplicados,
    pendencias: pendenciasObrigatorias(cat.campos, r.ficha),
    orfaos: valoresOrfaos(cat.campos, r.ficha),
  });
}
