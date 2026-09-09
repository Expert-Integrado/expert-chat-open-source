import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import {
  getPerfil, contextoVisao, conversaVisivel,
  type Responsavel, type VisibilidadeEntry,
} from "@/lib/perfil";
import { canaisAtivos, canalPorId, fonteExterna, somenteLeitura } from "@/lib/canais";
import { tabelas } from "@/lib/canal";
import { fotoPublica } from "@/lib/foto";
import { conversasIgPorIds, igDisponivel, resolverContaIg } from "@/lib/instagram-agent";
import { restricaoEfetiva, vinculosBu } from "@/lib/embed";
import {
  canalPermitido,
  restricaoDeConversas,
  restricaoEmLote,
  restricaoFailClosed,
} from "@/lib/acesso";
import { carregarCatalogo, vinculosPorCanais } from "@/lib/funis-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
// com_conversas varre os vinculos de todos os canais + responsaveis/visibilidade
export const maxDuration = 60;

// LEITURA de funis pra QUALQUER usuario logado — e o que o quadro (kanban) e a
// ficha da conversa consomem. A ESTRUTURA (criar/arquivar) e outra rota,
// `/api/admin/funis`, so pra super admin.
//
//   GET /api/funis                      -> funis + etapas ativos
//   GET /api/funis?com_conversas=1      -> + os vinculos que ESTE usuario pode ver
//                                          + `cards`: nome, foto, previa, etiquetas e
//                                            responsaveis pra desenhar o cartao
//                                          + `fora_do_quadro`: conversas presas em
//                                            etapa/funil arquivado (o quadro TEM que
//                                            mostrar isso, senao elas somem caladas)
//   GET /api/funis?canal=<id>           -> restringe os vinculos a um canal
//
// VISIBILIDADE: `chat_id` e telefone. Devolver os vinculos crus vazaria numero
// de conversa que o usuario nao pode abrir — entao o filtro e o MESMO predicado
// da listagem de conversas (`conversaVisivel` + contexto de embed), aplicado em
// lote. Fail-closed: conversa que nao da pra avaliar nao entra.
//
// Sem a migration 0009: lista vazia com aviso, nunca 500.

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });

  // carrega TUDO (inclusive arquivado) e filtra aqui: e o que permite dizer
  // quantas conversas ficaram apontando pra funil/etapa que saiu do quadro.
  // Arquivar nao apaga vinculo de proposito — apagar seria perder trabalho em
  // silencio —, entao alguem precisa contar essas conversas em voz alta.
  const cat = await carregarCatalogo({ incluirArquivados: true });
  if (!cat.ok) {
    return NextResponse.json(
      { funis: [], aviso: cat.aviso },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }
  // RESTRICAO por funil/canal (Frente Q, card 86ak85zm4): o quadro respeita o
  // recorte da pessoa, em DUAS frentes.
  //
  // (1) O CATALOGO. Achado de revisao: filtrar so as conversas deixava o funil
  //     proibido aparecer na tela como quadro VAZIO — a pessoa via o nome do
  //     funil que nao pode ver, e ainda parecia que a operacao daquele funil
  //     tinha parado. Funil fora do recorte simplesmente nao existe pra ela.
  // (2) As CONVERSAS, pelo mesmo predicado da listagem, mais abaixo.
  //
  // O canal tambem e cortado ANTES de varrer os vinculos: nao ha por que ler o
  // quadro de um numero que a pessoa nao alcanca.
  const restricao = await restricaoDeConversas(user.id, perfil.papel === "super_admin");
  const restricaoCanais = restricao;
  // FAIL-CLOSED tambem no CATALOGO (correcao da 2a revisao): quando a leitura da
  // tabela de restricoes falha, `restricaoDeConversas` devolve o sentinela que
  // nega toda conversa — mas o catalogo de funis seguia inteiro, e a tela ficava
  // com o quadro montado e vazio. NOME DE FUNIL E METADADO da operacao ("Cobranca
  // judicial", "Churn"): no fail-closed nao sai nada.
  const fechado = restricaoFailClosed(restricao);
  const funilNoRecorte = (id: string) =>
    !fechado && (!restricao?.funis.length || restricao.funis.includes(id));

  const ativos = cat.catalogo
    .filter((f) => f.ativo && funilNoRecorte(f.id))
    .map((f) => ({ ...f, etapas: f.etapas.filter((e) => e.ativo) }));
  const etapaAtiva = new Set(ativos.flatMap((f) => f.etapas.map((e) => e.id)));
  // o catalogo COMPLETO (usado nas respostas de borda abaixo e pelo agregado de
  // "fora do quadro") tambem sai recortado — senao vaza nome de funil pela porta
  // dos fundos
  const catalogoVisivel = cat.catalogo.filter((f) => funilNoRecorte(f.id));

  const comConversas = req.nextUrl.searchParams.get("com_conversas") === "1";
  if (!comConversas) {
    return NextResponse.json({ funis: ativos }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  }

  const pedido = req.nextUrl.searchParams.get("canal");
  const canais = canaisAtivos()
    .map((c) => c.id)
    .filter((id) => !pedido || id === pedido)
    .filter((id) => canalPermitido(restricaoCanais, id));
  if (!canais.length) {
    return NextResponse.json({ funis: catalogoVisivel, conversas: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  // DIVIDA DECLARADA — paginacao e POR QUADRO, nao por etapa. `vinculosPorCanais`
  // corta num teto GLOBAL (5.000, mais recentes primeiro) e `truncado` avisa o
  // quadro inteiro; a rolagem infinita da coluna e do CLIENTE, sobre o que ja
  // veio. Num funil com milhares de conversas numa unica etapa, o corte cai
  // desigual entre as colunas. O caminho pra fechar: paginar por etapa no
  // servidor (`etapa_id` + range) usando `contarNaEtapa` (lib/funis-db.ts) pro
  // contador do cabecalho, que hoje sai da contagem em memoria. Enquanto nao
  // fecha, o banner de `truncado` e o que impede o quadro cortado de parecer
  // completo. Detalhe no CLAUDE.md, secao "Quadro (kanban) de funil".
  const res = await vinculosPorCanais(canais);
  if (!res.ok) {
    return NextResponse.json({ funis: catalogoVisivel, conversas: [], aviso: res.aviso }, { headers: { "Cache-Control": "no-store" } });
  }

  const db = msgDb();
  const ctx = await contextoVisao(user, perfil);
  const vinculosBuIds = await vinculosBu(user.id, perfil.papel === "super_admin");

  // por canal: responsaveis, ACL por chat e status — em lotes de 200 ids, o
  // mesmo tamanho de lote da listagem de conversas (o `in` do PostgREST estoura
  // a URL com lista grande)
  const porCanal = new Map<string, string[]>();
  for (const v of res.vinculos) {
    const l = porCanal.get(v.canal) ?? [];
    if (!l.includes(v.chat_id)) l.push(v.chat_id);
    porCanal.set(v.canal, l);
  }

  const resp = new Map<string, Responsavel[]>();
  // mesma leitura, guardada com o NOME: a visibilidade so precisa de tipo+ref_id,
  // o cartao do quadro precisa de quem e a pessoa. Ler duas vezes seria pagar o
  // lote de novo pra ter a mesma linha.
  const respCard = new Map<string, { tipo: string; id: string; nome: string }[]>();
  const vis = new Map<string, VisibilidadeEntry[]>();
  const status = new Map<string, string | null>();
  const chave = (canal: string, chatId: string) => `${canal}|${chatId}`;

  for (const [canal, ids] of porCanal) {
    for (let i = 0; i < ids.length; i += 200) {
      const fatia = ids.slice(i, i + 200);
      const [r, v, s] = await Promise.all([
        db.from("conversa_responsaveis").select("chat_id,tipo,ref_id,nome").eq("canal", canal).in("chat_id", fatia),
        db.from("conversa_visibilidade").select("chat_id,tipo,ref_id").eq("canal", canal).in("chat_id", fatia),
        // canal de fonte externa nao tem linha de conversa no banco do painel —
        // status vale "aberto", igual /api/chats ja devolve
        somenteLeitura(canal)
          ? Promise.resolve({ data: fatia.map((chat_id) => ({ chat_id, status: "aberto" })) })
          : db.from(tabelas(canal).conversas).select("chat_id,status").in("chat_id", fatia),
      ]);
      for (const x of r.data ?? []) {
        const k = chave(canal, (x as any).chat_id);
        resp.set(k, [...(resp.get(k) ?? []), { tipo: (x as any).tipo, ref_id: (x as any).ref_id }]);
        respCard.set(k, [
          ...(respCard.get(k) ?? []),
          { tipo: (x as any).tipo, id: (x as any).ref_id, nome: (x as any).nome ?? "" },
        ]);
      }
      for (const x of v.data ?? []) {
        const k = chave(canal, (x as any).chat_id);
        vis.set(k, [...(vis.get(k) ?? []), { tipo: (x as any).tipo, ref_id: (x as any).ref_id }]);
      }
      for (const x of (s as any).data ?? []) status.set(chave(canal, (x as any).chat_id), (x as any).status ?? null);
    }
  }

  // o alvo do recorte por funil ja esta na mao: `res.vinculos` E a tabela
  // conversa_funil. Passar os pares aqui reaproveita a leitura em vez de pagar
  // outro lote (o `restricaoEmLote` so consulta funil quando precisa).
  const restr = await restricaoEmLote(
    user.id,
    perfil.papel === "super_admin",
    res.vinculos.map((v) => ({ canal: v.canal, chatId: v.chat_id }))
  );

  const visiveis = res.vinculos.filter((v) => {
    const k = chave(v.canal, v.chat_id);
    const podeVer = conversaVisivel(
      resp.get(k) ?? [],
      user,
      perfil,
      ctx,
      status.get(k) ?? null,
      vis.get(k) ?? [],
      vinculosBuIds,
      restr?.para(v.canal, v.chat_id)
    );
    return podeVer && (!emb || emb.permite(v.chat_id));
  });

  // ------------------------------------------------------------------ cards
  // Dado de EXIBICAO do cartao (nome, foto, previa, etiquetas, responsaveis).
  // Vem depois do filtro de escopo DE PROPOSITO: a lista de entrada e
  // `visiveis`, nunca `res.vinculos`. Montar sobre o cru devolveria nome e
  // telefone de conversa que o usuario nao pode abrir — o vazamento que o
  // predicado desta rota existe pra impedir.
  //
  // A previa e a COLUNA gravada (`last_message_preview`), nao a derivada da
  // ultima mensagem que /api/chats calcula: derivar exigiria varrer a tabela de
  // mensagens de milhares de conversas a cada abertura do quadro. Custo do
  // atalho, declarado: previa de mensagem apagada pode envelhecer no cartao —
  // abrir a conversa mostra o certo.
  const idsVisiveis = new Map<string, string[]>();
  for (const v of visiveis) {
    if (!etapaAtiva.has(v.etapa_id)) continue; // fora do quadro vai agregado, sem chat_id
    const l = idsVisiveis.get(v.canal) ?? [];
    if (!l.includes(v.chat_id)) l.push(v.chat_id);
    idsVisiveis.set(v.canal, l);
  }

  const cards: any[] = [];
  for (const [canal, ids] of idsVisiveis) {
    const def = canalPorId(canal);
    if (def && fonteExterna(def)) {
      // canal de fonte externa nao tem linha de conversa no banco do painel: o
      // nome vem da fonte, em lote de 200 (mesmo teto do helper). Sem env ou
      // conta desconectada, o cartao cai no chat_id — nunca 500.
      const conta = igDisponivel() ? await resolverContaIg(def) : null;
      if (!conta) continue;
      for (let i = 0; i < ids.length; i += 200) {
        const linhas = await conversasIgPorIds(conta, ids.slice(i, i + 200));
        for (const c of linhas) {
          const k = chave(canal, c.chat_id);
          cards.push({
            canal,
            chat_id: c.chat_id,
            nome: c.nome,
            foto: null,
            preview: c.last_message_preview,
            last_message_at: c.last_message_at,
            status: status.get(k) ?? "aberto",
            etiquetas: [],
            responsaveis: respCard.get(k) ?? [],
          });
        }
      }
      continue;
    }
    const T = tabelas(canal);
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db
        .from(T.conversas)
        .select("chat_id,nome,foto_url,foto_wa_url,last_message_at,last_message_preview,status,etiquetas")
        .in("chat_id", ids.slice(i, i + 200));
      // sem isto o lote falho sumia calado e os cartoes daquele canal caiam no
      // fallback do chat_id como se a conversa nao tivesse nome — canal novo
      // com tabela fora do formato ficaria degradado sem deixar rastro. O
      // quadro segue montando (o cartao aparece com o identificador), mas o
      // motivo fica no log, que e onde alguem procura.
      if (error) console.error(`funis/cards ${canal}:`, error.message);
      for (const c of (data ?? []) as any[]) {
        const k = chave(canal, c.chat_id);
        cards.push({
          canal,
          chat_id: c.chat_id,
          nome: c.nome,
          // mesma regra da lista: foto do WhatsApp primeiro; a do ChatGuru so
          // se for publica (a privada expira e vira cadeado na tela)
          foto: fotoPublica(c.foto_wa_url) || fotoPublica(c.foto_url),
          preview: c.last_message_preview,
          last_message_at: c.last_message_at,
          status: c.status || "aberto",
          etiquetas: Array.isArray(c.etiquetas) ? c.etiquetas : [],
          responsaveis: respCard.get(k) ?? [],
        });
      }
    }
  }

  const conversas = visiveis
    .filter((v) => etapaAtiva.has(v.etapa_id))
    .map((v) => ({
      canal: v.canal,
      chat_id: v.chat_id,
      funil_id: v.funil_id,
      etapa_id: v.etapa_id,
      atualizado_em: v.atualizado_em,
      definido_por_nome: v.definido_por_nome,
    }));

  // Conversas presas em etapa/funil que o quadro nao desenha mais (etapa
  // arquivada, funil arquivado, ou estrutura apagada). Sem esta lista elas
  // sumiriam da tela sem ninguem perceber — que e exatamente como trabalho se
  // perde. Vai agregado, sem chat_id: o numero e o que dispara a acao.
  const fora = new Map<string, { funil: string | null; etapa: string | null; motivo: string; conversas: number }>();
  for (const v of visiveis) {
    if (etapaAtiva.has(v.etapa_id)) continue;
    // O AGREGADO TAMBEM RESPEITA O RECORTE (correcao da 2a revisao, medida na
    // base real: 1.110 de 4.826 conversas estao em duas etapas ao mesmo tempo,
    // entao a conversa passa pelo predicado por causa do funil PERMITIDO e
    // aparecia aqui trazendo o NOME do funil proibido). Resolver o nome em
    // `catalogoVisivel`, nunca em `cat.catalogo`, e a segunda metade do conserto:
    // sem ela o nome vazaria por este caminho mesmo com o `continue` acima.
    if (!funilNoRecorte(v.funil_id)) continue;
    const funil = catalogoVisivel.find((f) => f.id === v.funil_id) ?? null;
    const etapa = funil?.etapas.find((e) => e.id === v.etapa_id) ?? null;
    const motivo = !funil || !etapa ? "estrutura apagada" : !funil.ativo ? "funil arquivado" : "etapa arquivada";
    const k = `${v.funil_id}|${v.etapa_id}`;
    const atual = fora.get(k) ?? { funil: funil?.nome ?? null, etapa: etapa?.nome ?? null, motivo, conversas: 0 };
    atual.conversas++;
    fora.set(k, atual);
  }

  return NextResponse.json(
    {
      funis: ativos,
      conversas,
      cards,
      fora_do_quadro: [...fora.values()].sort((a, b) => b.conversas - a.conversas),
      // honestidade sobre o teto: o quadro precisa saber que a lista foi cortada
      truncado: res.truncado,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
