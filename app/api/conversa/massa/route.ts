import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import { getPerfil, podeVerConversa } from "@/lib/perfil";
import { getConfig } from "@/lib/config";
import { canalDeBody, tabelas } from "@/lib/canal";
import { somenteLeitura } from "@/lib/canais";
import { avisarStatus } from "@/lib/webhooks-saida";
import { registrarEventoStatus, registrarEventoResponsavel } from "@/lib/tela-conversa-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// ACOES EM MASSA (pedido do Eric, 17/08/2026; Brain u3fywq0dftur sub 9): atribuir responsavel,
// mudar status e arquivar/desarquivar VARIAS conversas de uma vez — so super admin.
//
// Por que uma rota propria e nao N chamadas a POST /api/conversa pela tela: N requisicoes
// em paralelo estouram o limite do navegador e deixam N trilhas soltas sem um "feito"
// consolidado; aqui o servidor aplica UMA conversa por vez, grava a MESMA trilha da rota
// unitaria (status com autoria e evento; responsavel com evento de transferencia) e devolve
// quantas aplicou e quais falharam. As regras de negocio da rota unitaria valem iguais:
// concluir arquiva se `auto_arquivar_concluida`; sair de concluido desarquiva (salvo chat com
// auto_arquivar); responsavel em massa nao passa pelo rodizio.
//
// O que fica de FORA de proposito: pesquisa de satisfacao (CSAT) ao concluir em massa —
// disparar N pesquisas por um clique de limpeza de fila e comportamento que ninguem pediu.

const STATUS_VALIDOS = ["aberto", "atendimento", "concluido", "aguardando"];
const TETO_CHATS = 200;

type Resp = { tipo: "usuario" | "departamento"; id: string; nome?: string };

async function espelharLegado(db: any, chatId: string, canal: string, tabConversas: string) {
  const { data } = await db
    .from("conversa_responsaveis")
    .select("tipo,ref_id,nome")
    .eq("chat_id", chatId)
    .eq("canal", canal)
    .order("criado_em", { ascending: true })
    .limit(1);
  const primeiro = data?.[0];
  await db
    .from(tabConversas)
    .update({
      responsavel_id: primeiro?.ref_id ?? null,
      responsavel_nome: primeiro?.nome ?? null,
      responsavel_tipo: primeiro ? primeiro.tipo : null,
    })
    .eq("chat_id", chatId);
}

function respValida(r: unknown): r is Resp {
  const x = r as Resp | undefined;
  return !!x && typeof x.id === "string" && !!x.id && (x.tipo === "usuario" || x.tipo === "departamento");
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  if (perfil.papel !== "super_admin") {
    return NextResponse.json({ error: "acao em massa e so pra super admin" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const canal = canalDeBody(body);
  const T = tabelas(canal);
  const chatIds: string[] = Array.isArray(body?.chat_ids)
    ? Array.from(new Set(body.chat_ids.map((c: unknown) => String(c)).filter(Boolean)))
    : [];
  if (!chatIds.length) return NextResponse.json({ error: "chat_ids obrigatorio" }, { status: 400 });
  if (chatIds.length > TETO_CHATS) {
    return NextResponse.json({ error: `maximo de ${TETO_CHATS} conversas por vez` }, { status: 400 });
  }
  const { status, arquivada, add_responsavel, remove_responsavel, limpar_responsaveis } = body;
  if (status !== undefined && !STATUS_VALIDOS.includes(status)) {
    return NextResponse.json({ error: "status invalido" }, { status: 400 });
  }
  if (add_responsavel !== undefined && !respValida(add_responsavel)) {
    return NextResponse.json({ error: "add_responsavel invalido" }, { status: 400 });
  }
  if (remove_responsavel !== undefined && !respValida(remove_responsavel)) {
    return NextResponse.json({ error: "remove_responsavel invalido" }, { status: 400 });
  }
  const temAcao =
    status !== undefined || arquivada !== undefined || add_responsavel || remove_responsavel || limpar_responsaveis === true;
  if (!temAcao) return NextResponse.json({ error: "nenhuma acao informada" }, { status: 400 });
  if (somenteLeitura(canal) && (status !== undefined || arquivada !== undefined)) {
    return NextResponse.json({ error: "canal somente leitura: status e arquivo nao disponiveis" }, { status: 403 });
  }

  const db = msgDb();
  const cfg = status !== undefined ? await getConfig() : null;
  const por = { id: user.id, nome: user.nome };
  const aplicadas: string[] = [];
  const falhas: { chat_id: string; erro: string }[] = [];

  for (const chatId of chatIds) {
    try {
      // mesmo gate de escopo da rota unitaria — super admin ve tudo, mas a checagem fica
      // pra a regra nao depender do papel do dia
      if (!(await podeVerConversa(chatId, user, perfil, canal))) {
        falhas.push({ chat_id: chatId, erro: "fora do escopo" });
        continue;
      }

      if (limpar_responsaveis === true) {
        const { data: atuais } = await db
          .from("conversa_responsaveis")
          .select("tipo,ref_id,nome")
          .eq("canal", canal)
          .eq("chat_id", chatId);
        if (atuais?.length) {
          const { error } = await db.from("conversa_responsaveis").delete().eq("canal", canal).eq("chat_id", chatId);
          if (error) throw new Error(error.message);
          for (const a of atuais) {
            await registrarEventoResponsavel({
              canal,
              chatId,
              acao: "removido",
              tipo: a.tipo,
              refId: String(a.ref_id),
              refNome: a.nome ?? null,
              por,
              origem: "painel",
            });
          }
        }
      }
      if (remove_responsavel) {
        const { data: antes } = await db
          .from("conversa_responsaveis")
          .select("nome")
          .eq("canal", canal)
          .eq("chat_id", chatId)
          .eq("tipo", remove_responsavel.tipo)
          .eq("ref_id", remove_responsavel.id)
          .maybeSingle();
        if (antes) {
          const { error } = await db
            .from("conversa_responsaveis")
            .delete()
            .eq("canal", canal)
            .eq("chat_id", chatId)
            .eq("tipo", remove_responsavel.tipo)
            .eq("ref_id", remove_responsavel.id);
          if (error) throw new Error(error.message);
          await registrarEventoResponsavel({
            canal,
            chatId,
            acao: "removido",
            tipo: remove_responsavel.tipo,
            refId: String(remove_responsavel.id),
            refNome: antes.nome ?? null,
            por,
            origem: "painel",
          });
        }
      }
      if (add_responsavel) {
        const { error } = await db.from("conversa_responsaveis").upsert(
          {
            canal,
            chat_id: chatId,
            tipo: add_responsavel.tipo,
            ref_id: add_responsavel.id,
            nome: String(add_responsavel.nome || "?").slice(0, 120),
          },
          { onConflict: "canal,chat_id,tipo,ref_id" }
        );
        if (error) throw new Error(error.message);
        await registrarEventoResponsavel({
          canal,
          chatId,
          acao: "atribuido",
          tipo: add_responsavel.tipo,
          refId: String(add_responsavel.id),
          refNome: String(add_responsavel.nome || "").slice(0, 120) || null,
          por,
          origem: "painel",
        });
      }
      if ((limpar_responsaveis === true || remove_responsavel || add_responsavel) && !somenteLeitura(canal)) {
        await espelharLegado(db, chatId, canal, T.conversas);
      }

      if (status !== undefined || arquivada !== undefined) {
        const patch: Record<string, any> = { updated_at: new Date().toISOString() };
        let statusAntes: string | null = null;
        let marcoStatus: string | null = null;
        if (status !== undefined) {
          const { data: conv } = await db
            .from(T.conversas)
            .select("status,auto_arquivar,status_alterado_em,created_at")
            .eq("chat_id", chatId)
            .maybeSingle();
          statusAntes = conv?.status ?? null;
          marcoStatus = conv?.status_alterado_em ?? conv?.created_at ?? null;
          patch.status = status;
          patch.status_alterado_por_id = user.id;
          patch.status_alterado_por_nome = user.nome;
          patch.status_alterado_em = patch.updated_at;
          if (status === "concluido") {
            if (cfg?.auto_arquivar_concluida) patch.arquivada = true;
          } else if (arquivada === undefined) {
            if (!conv?.auto_arquivar) patch.arquivada = false;
            patch.aguardando_avaliacao = false;
          }
        }
        if (arquivada !== undefined) patch.arquivada = !!arquivada;
        const { error } = await db.from(T.conversas).update(patch).eq("chat_id", chatId);
        if (error) throw new Error(error.message);
        if (status !== undefined) {
          avisarStatus({ canal, chatId, de: statusAntes, para: status, porId: user.id, porNome: user.nome, origem: "painel" });
          await registrarEventoStatus({
            canal,
            chatId,
            status,
            statusAnterior: statusAntes,
            marcoAnterior: marcoStatus,
            por,
            origem: "painel",
          });
        }
      }
      aplicadas.push(chatId);
    } catch (e: any) {
      falhas.push({ chat_id: chatId, erro: String(e?.message || e) });
    }
  }

  return NextResponse.json({ ok: falhas.length === 0, aplicadas: aplicadas.length, falhas });
}
