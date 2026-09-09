import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { portao, RESP_SEM_TABELA } from "@/lib/disparo/rota";
import { canalPorId } from "@/lib/canais";
import { podeTransicionar, type EstadoCampanha } from "@/lib/disparo/estado";
import { motivoCanalNaoEnvia } from "@/lib/disparo/envio";
import { enviadosHojeNoCanal, marcarRespostas } from "@/lib/disparo/motor";
import { estimarDuracao, normalizarRitmo } from "@/lib/disparo/ritmo";
import { isoDeLocal } from "@/lib/disparo/fuso";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// ACOMPANHAMENTO e CONTROLE de UMA campanha (card 86ak85jfd).
//
// GET   = contagens ao vivo + lista paginada de destinos + respostas com link
//         pra conversa
// PATCH = muda o ESTADO (aprovar, pausar, retomar, cancelar). E aqui que mora a
//         aprovacao humana: a campanha so sai de rascunho por esta chamada,
//         feita por uma pessoa com permissao de disparo.

const CAMPOS =
  "id,nome,canal,mensagem,estado,agendada_para,lote,intervalo_s,teto_por_numero_dia,historico,destinatarios_total,progresso_origem,origem_ferramenta,origem_id,origem_fluxo_id,origem_fluxo_nome,criado_por_nome,ativada_por_nome,ativada_em,criada_em,iniciada_em,concluida_em,erro";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const g = await portao(req);
  if (g instanceof NextResponse) return g;

  const db = msgDb();
  const { data: c, error } = await db.from("campanhas").select(CAMPOS).eq("id", params.id).maybeSingle();
  if (error) return RESP_SEM_TABELA();
  if (!c) return NextResponse.json({ error: "campanha nao encontrada" }, { status: 404 });
  const campanha = c as any;

  // atualiza quem respondeu antes de contar (a deteccao acontece na LEITURA —
  // decisao registrada em docs/disparo.md e no comentario de motor.ts)
  if (!campanha.historico) await marcarRespostas(campanha.id, campanha.canal).catch(() => 0);

  const pagina = Math.max(1, Number(req.nextUrl.searchParams.get("pagina") || 1));
  const porPagina = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get("por_pagina") || 50)));
  const filtroEstado = req.nextUrl.searchParams.get("estado");

  const [contagemRes, destinosRes, respostasRes] = await Promise.all([
    db.from("campanha_destinos").select("estado").eq("campanha_id", campanha.id).limit(100000),
    (() => {
      let q = db
        .from("campanha_destinos")
        .select("id,chat_id,telefone,nome,estado,enviado_em,respondeu_em,provider_msg_id,erro", { count: "exact" })
        .eq("campanha_id", campanha.id)
        .order("enviado_em", { ascending: false, nullsFirst: false })
        .range((pagina - 1) * porPagina, pagina * porPagina - 1);
      if (filtroEstado) q = q.eq("estado", filtroEstado);
      return q;
    })(),
    db
      .from("campanha_destinos")
      .select("chat_id,nome,telefone,respondeu_em")
      .eq("campanha_id", campanha.id)
      .eq("estado", "respondeu")
      .order("respondeu_em", { ascending: false })
      .limit(200),
  ]);

  const contagens: Record<string, number> = {};
  for (const d of (contagemRes.data ?? []) as any[]) contagens[d.estado] = (contagens[d.estado] || 0) + 1;
  const total = Object.values(contagens).reduce((a, b) => a + b, 0);
  const concluidos = (contagens.enviado || 0) + (contagens.respondeu || 0) + (contagens.falhou || 0) + (contagens.optout || 0);
  // `enviando` e a RESERVA em curso (lib/disparo/lote.ts). Ele existe de verdade
  // durante um lote, e nao aparecia em coluna nenhuma: o total nao fechava
  // (soma das colunas < total) e o percentual andava PRA TRAS quando a reserva
  // era feita. Entra em "faltam" — do ponto de vista de quem olha, destino
  // reservado ainda nao saiu — e tambem separado, pra tela poder mostrar
  // "3 saindo agora".
  const reservados = contagens.enviando || 0;
  const pendentes = (contagens.pendente || 0) + reservados;

  const def = canalPorId(campanha.canal);
  // estimativa do que FALTA (nao do total): e o que a tela mostra enquanto roda
  const folga = campanha.historico
    ? 0
    : Math.max(0, campanha.teto_por_numero_dia - (await enviadosHojeNoCanal(campanha.canal).catch(() => 0)));

  return NextResponse.json(
    {
      campanha: {
        ...campanha,
        canal_rotulo: def?.rotulo ?? campanha.canal,
        pode_disparar: !campanha.historico,
      },
      progresso: {
        total: campanha.historico ? campanha.destinatarios_total ?? 0 : total,
        enviados: contagens.enviado || 0,
        respondidos: contagens.respondeu || 0,
        falhas: contagens.falhou || 0,
        optout: contagens.optout || 0,
        pendentes,
        // destinos reservados por um tick em curso (subconjunto de `pendentes`)
        saindo_agora: reservados,
        // percentual: campanha historica usa o progresso da origem
        percentual: campanha.historico
          ? campanha.progresso_origem ?? null
          : total
            ? `${Math.round((concluidos / total) * 100)}%`
            : "0%",
        canal_em_uso: def?.rotulo ?? campanha.canal,
        estimativa_restante: campanha.historico
          ? null
          : estimarDuracao(pendentes, normalizarRitmo(campanha), folga).texto,
        impedimento: campanha.historico ? null : motivoCanalNaoEnvia(campanha.canal),
      },
      destinos: {
        itens: destinosRes.data ?? [],
        pagina,
        por_pagina: porPagina,
        total: destinosRes.count ?? 0,
      },
      // cada resposta e uma conversa na caixa de entrada: o link e o que faz a
      // pessoa chegar nela em um clique (o que o card chama de mais importante
      // que a taxa de entrega)
      respostas: ((respostasRes.data ?? []) as any[]).map((r) => ({
        ...r,
        link: `/?chat=${encodeURIComponent(r.chat_id)}&canal=${encodeURIComponent(campanha.canal)}`,
      })),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

// Agendar exige hora marcada: horaDeComecar (lib/disparo/estado.ts) recusa
// agendada_para nulo de proposito, entao agendar sem hora criaria uma campanha
// que o tick nunca comeca — e ninguem entenderia por que.
function temHoraMarcada(body: any, campanha: any): boolean {
  const informada = body?.agendada_para;
  if (informada !== undefined && informada !== null && informada !== "") return true;
  return !!campanha.agendada_para;
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const g = await portao(req);
  if (g instanceof NextResponse) return g;
  const { user } = g;

  const body = await req.json().catch(() => ({}));
  const alvo = body?.estado as EstadoCampanha;

  const db = msgDb();
  const { data: c, error } = await db
    .from("campanhas")
    .select("id,nome,canal,estado,historico,agendada_para")
    .eq("id", params.id)
    .maybeSingle();
  if (error) return RESP_SEM_TABELA();
  if (!c) return NextResponse.json({ error: "campanha nao encontrada" }, { status: 404 });
  const campanha = c as any;

  // RE-ENFILEIRAR as falhas (par do retry automatico do motor): o motor desiste
  // depois de MAX_TENTATIVAS, e o que sobra e uma lista de falhas com motivo.
  // Quando a causa foi resolvida por fora (chip religado, credencial arrumada),
  // quem opera precisa poder devolver esses destinos pra fila sem remontar a
  // campanha inteira. Zera a contagem de tentativas: e uma nova chance de fato.
  if (body?.acao === "reenfileirar_falhas") {
    if (campanha.historico) {
      return NextResponse.json({ error: "campanha historica nao dispara" }, { status: 400 });
    }
    // Estado terminal e terminal — e disso que todo o guardrail depende. Devolver
    // destino pra fila de uma campanha concluida/cancelada criaria fila que nunca
    // anda (o tick so olha rodando/agendada) e a tela prometeria um envio que
    // nunca aconteceria. Dizer isso e melhor que abrir excecao no modelo.
    if (["concluida", "cancelada"].includes(campanha.estado)) {
      return NextResponse.json(
        {
          error: `campanha ${campanha.estado} nao volta a enviar — para reaproveitar estes destinos, crie uma campanha nova`,
        },
        { status: 409 }
      );
    }
    const { data: devolvidos, error: eRef } = await db
      .from("campanha_destinos")
      .update({ estado: "pendente", tentativas: 0, erro: null, reservado_em: null })
      .eq("campanha_id", campanha.id)
      .eq("estado", "falhou")
      .select("id");
    if (eRef) return NextResponse.json({ error: "falha ao re-enfileirar" }, { status: 500 });
    return NextResponse.json({
      ok: true,
      reenfileirados: (devolvidos ?? []).length,
      // re-enfileirar devolve destino; nao reativa disparo sozinho
      aviso:
        campanha.estado === "pausada"
          ? "os destinos voltaram pra fila; retome a campanha para que eles saiam"
          : null,
    });
  }

  // A transicao e pedida por uma PESSOA (esta rota exige login + permissao):
  // por isso autor "humano". O tick nunca passa por aqui.
  const t = podeTransicionar(campanha.estado, alvo, { autor: "humano", historico: campanha.historico });
  if (!t.ok) return NextResponse.json({ error: t.motivo }, { status: 400 });

  // FAIL-CLOSED: nao deixa ativar campanha em canal que nao envia. Recusar agora
  // e melhor que descobrir com a fila inteira falhando (decisao 4 do card).
  if (alvo === "agendada" && !temHoraMarcada(body, campanha)) {
    return NextResponse.json(
      { error: "para agendar, informe a data e a hora — sem hora marcada a campanha nunca comeca sozinha" },
      { status: 400 }
    );
  }
  if (alvo === "rodando" || alvo === "agendada") {
    const impedimento = motivoCanalNaoEnvia(campanha.canal);
    if (impedimento) return NextResponse.json({ error: impedimento }, { status: 409 });
    const { count } = await db
      .from("campanha_destinos")
      .select("id", { count: "exact", head: true })
      .eq("campanha_id", campanha.id)
      .eq("estado", "pendente");
    if (!count) return NextResponse.json({ error: "a campanha nao tem nenhum destino pendente" }, { status: 409 });
  }

  const agora = new Date().toISOString();
  const patch: Record<string, any> = { estado: alvo, atualizada_em: agora, erro: null };
  // carimba QUEM aprovou o disparo — a campanha nasce rascunho e so uma pessoa
  // tira dali; sem esse registro nao da pra saber quem autorizou
  if (campanha.estado === "rascunho" && (alvo === "rodando" || alvo === "agendada")) {
    patch.ativada_por_id = user.id;
    patch.ativada_por_nome = user.nome;
    patch.ativada_em = agora;
  }
  if (alvo === "rodando" && !campanha.iniciada_em) patch.iniciada_em = agora;
  if (alvo === "cancelada" || alvo === "concluida") patch.concluida_em = agora;
  if (body?.agendada_para !== undefined && body?.agendada_para !== null && body?.agendada_para !== "") {
    const quando = isoDeLocal(body.agendada_para);
    if (!quando) {
      return NextResponse.json(
        { error: "data de agendamento invalida — use 2026-09-01T14:30 (hora local da sua operacao)" },
        { status: 400 }
      );
    }
    patch.agendada_para = quando;
  }

  const { data: nova, error: e2 } = await db
    .from("campanhas")
    .update(patch)
    .eq("id", campanha.id)
    // trava de concorrencia: se outra aba mudou o estado no meio, esta chamada
    // nao aplica em cima de um estado que ja nao existe mais
    .eq("estado", campanha.estado)
    .select("id,nome,estado,ativada_por_nome,ativada_em")
    .maybeSingle();
  if (e2) return NextResponse.json({ error: "falha ao mudar o estado da campanha" }, { status: 500 });
  if (!nova) {
    return NextResponse.json({ error: "a campanha mudou de estado em outra aba — recarregue" }, { status: 409 });
  }

  return NextResponse.json({ campanha: nova });
}
