import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import { getPerfil, ehAdmin } from "@/lib/perfil";
import { carregarCatalogo, contagemPorEtapa, AVISO_SEM_TABELA } from "@/lib/funis-db";
import { corValida, nomeValido, ordemValida, proximaOrdem } from "@/lib/funis";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// ESTRUTURA do funil (criar, renomear, reordenar, arquivar) — SO super admin.
//
// Permissoes separadas de proposito (criterio do card 86ak86k62): GERENCIAR o
// funil e cadastro; MOVER a conversa de etapa e uso do dia a dia e mora em
// `/api/conversa/funil`, com a permissao da CONVERSA. Atendente move card sem
// poder inventar coluna.
//
// Nada e DELETADO: funil e etapa se ARQUIVAM (`ativo=false`). Ha conversas e
// fluxos apontando pra ca — apagar transformaria historico em buraco.
//
// Enquanto a migration 0009 nao rodar (gesto humano no SQL Editor), o GET
// responde lista vazia com aviso e o POST responde 503 com o mesmo aviso; nunca
// 500 (mesmo padrao da rota de macros).

type Porta = { erro?: NextResponse; user?: { id: string; nome: string } };

async function admin(req: NextRequest): Promise<Porta> {
  const user = await getUser(req);
  if (!user) return { erro: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const perfil = await getPerfil(user.id);
  if (!ehAdmin(perfil)) return { erro: NextResponse.json({ error: "somente super admin" }, { status: 403 }) };
  return { user: { id: user.id, nome: user.nome } };
}

export async function GET(req: NextRequest) {
  const a = await admin(req);
  if (a.erro) return a.erro;

  // admin ve ARQUIVADOS tambem (e o unico lugar de onde da pra reativar)
  const cat = await carregarCatalogo({ incluirArquivados: true });
  if (!cat.ok) {
    return NextResponse.json(
      { funis: [], aviso: cat.aviso },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }
  const cont = await contagemPorEtapa();
  const funis = cat.catalogo.map((f) => ({
    ...f,
    etapas: f.etapas.map((e) => ({ ...e, conversas: cont.porEtapa[e.id] ?? 0 })),
  }));
  return NextResponse.json(
    { funis, contagem_truncada: cont.truncado },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  const a = await admin(req);
  if (a.erro) return a.erro;
  const user = a.user!;
  const db = msgDb();
  const body = await req.json().catch(() => ({}));
  const {
    funil_id,
    etapa_id,
    nome,
    descricao,
    ativo,
    ordem,
    cor,
    // reordenacao em lote
    ordem_funis,
    ordem_etapas,
    // arquivamento de etapa com conversas dentro
    destino_etapa_id,
    soltar,
  } = body || {};

  const agora = new Date().toISOString();
  const cat = await carregarCatalogo({ incluirArquivados: true });
  if (!cat.ok) return NextResponse.json({ error: cat.aviso }, { status: 503 });

  // ---------------------------------------------------- reordenar em lote
  if (Array.isArray(ordem_funis)) {
    for (const [i, id] of ordem_funis.entries()) {
      if (typeof id !== "string") continue;
      const { error } = await db.from("funis").update({ ordem: i, atualizado_em: agora }).eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }
  if (Array.isArray(ordem_etapas)) {
    for (const [i, id] of ordem_etapas.entries()) {
      if (typeof id !== "string") continue;
      const { error } = await db.from("funil_etapas").update({ ordem: i, atualizada_em: agora }).eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  // ------------------------------------------------------- editar ETAPA
  if (etapa_id) {
    const funil = cat.catalogo.find((f) => f.etapas.some((e) => e.id === etapa_id));
    const etapa = funil?.etapas.find((e) => e.id === etapa_id);
    if (!etapa || !funil) return NextResponse.json({ error: "etapa nao encontrada" }, { status: 404 });

    // ARQUIVAR etapa com conversas dentro exige DESTINO (criterio do card):
    // some do quadro sem dizer pra onde foi a fila e como perder trabalho.
    if (ativo === false) {
      const cont = await contagemPorEtapa();
      const quantas = cont.porEtapa[etapa_id] ?? 0;
      if (quantas > 0 && !destino_etapa_id && soltar !== true) {
        return NextResponse.json(
          {
            error: "etapa com conversas: informe destino_etapa_id (mover) ou soltar:true (tirar do funil)",
            conversas: quantas,
            etapa: etapa.nome,
          },
          { status: 409 }
        );
      }
      if (quantas > 0 && destino_etapa_id) {
        const destino = funil.etapas.find((e) => e.id === destino_etapa_id);
        if (!destino) {
          return NextResponse.json({ error: "destino precisa ser uma etapa do MESMO funil" }, { status: 400 });
        }
        if (!destino.ativo) return NextResponse.json({ error: "destino esta arquivado" }, { status: 400 });
        // as conversas que JA estao no destino nao podem duplicar a PK: apaga o
        // vinculo velho delas antes de mover o resto
        const { data: jaNoDestino } = await db
          .from("conversa_funil")
          .select("canal,chat_id")
          .eq("etapa_id", destino_etapa_id);
        const chaves = new Set((jaNoDestino ?? []).map((v: any) => `${v.canal}|${v.chat_id}`));
        const { data: naEtapa } = await db
          .from("conversa_funil")
          .select("canal,chat_id")
          .eq("etapa_id", etapa_id);
        const naEtapaTodas = naEtapa ?? [];
        // quem JA estava no destino nao "move": o vinculo velho e apagado e a
        // conversa continua onde estava. Essas nao entram na trilha — evento de
        // movimento que nao houve e ruido que faz o historico mentir.
        const jaEstavam = naEtapaTodas.filter((x: any) => chaves.has(`${x.canal}|${x.chat_id}`));
        const mexidas = naEtapaTodas.filter((x: any) => !chaves.has(`${x.canal}|${x.chat_id}`));
        for (const v of jaEstavam) {
          await db
            .from("conversa_funil")
            .delete()
            .eq("etapa_id", etapa_id)
            .eq("canal", v.canal)
            .eq("chat_id", v.chat_id);
        }
        const { error: errMover } = await db
          .from("conversa_funil")
          .update({ etapa_id: destino_etapa_id, atualizado_em: agora })
          .eq("etapa_id", etapa_id);
        if (errMover) return NextResponse.json({ error: errMover.message }, { status: 500 });
        // trilha CONVERSA A CONVERSA (nao um evento-resumo), e SO das que
        // realmente mudaram de etapa: quem abrir a ficha de UMA conversa daqui
        // a um mes precisa ver que ela mudou e por que. Teto de 2000 pra um
        // arquivamento gigante nao virar insert infinito — acima disso o log
        // diz quantas ficaram sem evento.
        const eventos = mexidas.slice(0, 2000).map((v: any) => ({
          canal: v.canal,
          chat_id: v.chat_id,
          funil_id: funil.id,
          funil_nome: funil.nome,
          etapa_id: destino.id,
          etapa_nome: destino.nome,
          etapa_anterior_id: etapa.id,
          etapa_anterior_nome: etapa.nome,
          acao: "moveu",
          por_id: user.id,
          por_nome: `${user.nome} (arquivou a etapa ${etapa.nome})`,
          criada_em: agora,
        }));
        if (eventos.length) await db.from("conversa_funil_eventos").insert(eventos);
        if (mexidas.length > eventos.length) {
          console.error(`funis: ${mexidas.length - eventos.length} movimentos sem evento (teto de trilha)`);
        }
      } else if (quantas > 0 && soltar === true) {
        const { data: naEtapa } = await db
          .from("conversa_funil")
          .select("canal,chat_id")
          .eq("etapa_id", etapa_id);
        const { error: errSoltar } = await db.from("conversa_funil").delete().eq("etapa_id", etapa_id);
        if (errSoltar) return NextResponse.json({ error: errSoltar.message }, { status: 500 });
        const eventos = (naEtapa ?? []).slice(0, 2000).map((v: any) => ({
          canal: v.canal,
          chat_id: v.chat_id,
          funil_id: funil.id,
          funil_nome: funil.nome,
          etapa_id: null,
          etapa_nome: null,
          etapa_anterior_id: etapa.id,
          etapa_anterior_nome: etapa.nome,
          acao: "saiu",
          por_id: user.id,
          por_nome: `${user.nome} (arquivou a etapa ${etapa.nome})`,
          criada_em: agora,
        }));
        if (eventos.length) await db.from("conversa_funil_eventos").insert(eventos);
      }
    }

    const patch: Record<string, any> = { atualizada_em: agora };
    if (nome !== undefined) {
      const n = nomeValido(nome);
      if (!n) return NextResponse.json({ error: "nome invalido" }, { status: 400 });
      patch.nome = n;
    }
    if (cor !== undefined) {
      if (cor !== null && cor !== "" && !corValida(cor)) {
        return NextResponse.json({ error: "cor precisa ser hex #RRGGBB" }, { status: 400 });
      }
      patch.cor = corValida(cor);
    }
    if (ordem !== undefined) patch.ordem = ordemValida(ordem);
    if (ativo !== undefined) patch.ativo = !!ativo;
    const { error } = await db.from("funil_etapas").update(patch).eq("id", etapa_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  // ------------------------------------------------- criar/editar FUNIL
  if (funil_id) {
    const funil = cat.catalogo.find((f) => f.id === funil_id);
    if (!funil) return NextResponse.json({ error: "funil nao encontrado" }, { status: 404 });

    // criar ETAPA dentro do funil: {funil_id, nome} quando o funil ja existe e
    // o corpo traz `etapa: true`
    if (body?.etapa === true) {
      const n = nomeValido(nome);
      if (!n) return NextResponse.json({ error: "nome da etapa obrigatorio" }, { status: 400 });
      if (cor !== undefined && cor !== null && cor !== "" && !corValida(cor)) {
        return NextResponse.json({ error: "cor precisa ser hex #RRGGBB" }, { status: 400 });
      }
      const { data, error } = await db
        .from("funil_etapas")
        .insert({
          funil_id,
          nome: n,
          cor: corValida(cor),
          ordem: ordem !== undefined ? ordemValida(ordem) : proximaOrdem(funil.etapas),
          ativo: true,
        })
        .select("id,funil_id,nome,ordem,cor,ativo")
        .single();
      if (error) {
        // nome repetido no MESMO funil bate no indice unico — erro legivel
        const dup = /duplicate key|uq_funil_etapas_nome/i.test(error.message);
        return NextResponse.json(
          { error: dup ? "ja existe uma etapa com esse nome neste funil" : error.message },
          { status: dup ? 409 : 500 }
        );
      }
      return NextResponse.json({ ok: true, etapa: data });
    }

    // ARQUIVAR O FUNIL INTEIRO tem a mesma trava de arquivar UMA etapa: se ha
    // conversas nele, some do quadro uma fila inteira de uma vez. Nao ha
    // "destino" natural (o funil todo esta saindo), entao a saida e explicita:
    //   soltar: true    -> tira as conversas do funil (vinculos apagados, com trilha)
    //   confirmar: true -> arquiva mantendo os vinculos (voltam se reativar)
    if (ativo === false) {
      const cont = await contagemPorEtapa();
      const porEtapa = funil.etapas.map((e) => ({ etapa: e, quantas: cont.porEtapa[e.id] ?? 0 }));
      const quantas = porEtapa.reduce((s, x) => s + x.quantas, 0);
      if (quantas > 0 && soltar !== true && body?.confirmar !== true) {
        return NextResponse.json(
          {
            error:
              "funil com conversas: informe soltar:true (tirar as conversas do funil) ou confirmar:true (arquivar mantendo os vinculos)",
            conversas: quantas,
            funil: funil.nome,
            etapas: porEtapa.filter((x) => x.quantas > 0).map((x) => ({ etapa: x.etapa.nome, conversas: x.quantas })),
          },
          { status: 409 }
        );
      }
      if (quantas > 0 && soltar === true) {
        const ids = funil.etapas.map((e) => e.id);
        const { data: vinc } = await db.from("conversa_funil").select("canal,chat_id,etapa_id").in("etapa_id", ids);
        const { error: errSoltar } = await db.from("conversa_funil").delete().in("etapa_id", ids);
        if (errSoltar) return NextResponse.json({ error: errSoltar.message }, { status: 500 });
        const nomeEtapa = new Map(funil.etapas.map((e) => [e.id, e.nome]));
        const eventos = (vinc ?? []).slice(0, 2000).map((v: any) => ({
          canal: v.canal,
          chat_id: v.chat_id,
          funil_id: funil.id,
          funil_nome: funil.nome,
          etapa_id: null,
          etapa_nome: null,
          etapa_anterior_id: v.etapa_id,
          etapa_anterior_nome: nomeEtapa.get(v.etapa_id) ?? null,
          acao: "saiu",
          por_id: user.id,
          por_nome: `${user.nome} (arquivou o funil ${funil.nome})`,
          criada_em: agora,
        }));
        if (eventos.length) await db.from("conversa_funil_eventos").insert(eventos);
      }
    }

    const patch: Record<string, any> = { atualizado_em: agora };
    if (nome !== undefined) {
      const n = nomeValido(nome);
      if (!n) return NextResponse.json({ error: "nome invalido" }, { status: 400 });
      patch.nome = n;
    }
    if (descricao !== undefined) patch.descricao = descricao ? String(descricao).slice(0, 500) : null;
    if (ordem !== undefined) patch.ordem = ordemValida(ordem);
    if (ativo !== undefined) patch.ativo = !!ativo;
    const { error } = await db.from("funis").update(patch).eq("id", funil_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  // ------------------------------------------------------- criar FUNIL
  const n = nomeValido(nome);
  if (!n) return NextResponse.json({ error: "nome obrigatorio" }, { status: 400 });
  const { data, error } = await db
    .from("funis")
    .insert({
      nome: n,
      descricao: descricao ? String(descricao).slice(0, 500) : null,
      ordem: ordem !== undefined ? ordemValida(ordem) : proximaOrdem(cat.catalogo),
      ativo: true,
      criado_por_id: user.id,
      criado_por_nome: user.nome,
    })
    .select("id,nome,ordem,ativo")
    .single();
  if (error) {
    const dup = /duplicate key|uq_funis_nome/i.test(error.message);
    return NextResponse.json(
      { error: dup ? "ja existe um funil com esse nome" : error.message || AVISO_SEM_TABELA },
      { status: dup ? 409 : 500 }
    );
  }
  return NextResponse.json({ ok: true, funil: { ...data, etapas: [] } });
}
