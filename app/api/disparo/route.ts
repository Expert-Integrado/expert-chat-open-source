import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { portao, RESP_SEM_TABELA } from "@/lib/disparo/rota";
import { canalPorId } from "@/lib/canais";
import { motivoCanalNaoEnvia } from "@/lib/disparo/envio";
import { normalizarRitmo, estimarDuracao } from "@/lib/disparo/ritmo";
import {
  publicoDaLista,
  publicoDoCsv,
  publicoDoFiltro,
  publicoDoPipedrive,
  tirarBloqueados,
  type PublicoResolvido,
} from "@/lib/disparo/publico";
import { isoDeLocal } from "@/lib/disparo/fuso";
import { variaveisSemValor } from "@/lib/disparo/csv";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
// 300 desde a origem pipedrive (31/08/2026): a varredura do CRM pagina 500 por
// vez e pode ir a 40 paginas — o mesmo teto que /api/embed/sync usa. As outras
// tres origens nao chegam perto disso.
export const maxDuration = 300;

// CAMPANHAS — modulo `disparo` (desligado por default na instalacao).
//
// GET  = lista as campanhas com as contagens por estado
// POST = cria a campanha JA COM o publico resolvido, sempre em RASCUNHO
//
// Nenhuma campanha nasce disparando. O POST cria rascunho e ponto: quem tira do
// rascunho e o PATCH de /api/disparo/<id>, com acao explicita de uma pessoa
// (docs/disparo.md). Isso e comportamento de produto, nao detalhe de rota.

export async function GET(req: NextRequest) {
  const g = await portao(req);
  if (g instanceof NextResponse) return g;

  const db = msgDb();
  const { data, error } = await db
    .from("campanhas")
    .select(
      "id,nome,canal,estado,agendada_para,historico,destinatarios_total,progresso_origem,origem_ferramenta,origem_fluxo_nome,criado_por_nome,ativada_por_nome,criada_em,iniciada_em,concluida_em,erro"
    )
    .order("criada_em", { ascending: false })
    .limit(200);
  if (error) return RESP_SEM_TABELA();

  const ids = (data ?? []).map((c: any) => c.id);
  // contagem por estado das campanhas listadas (uma consulta, agrupada no node:
  // o PostgREST nao faz group by e N consultas seria N+1)
  const porCampanha = new Map<string, Record<string, number>>();
  if (ids.length) {
    const { data: destinos } = await db
      .from("campanha_destinos")
      .select("campanha_id,estado")
      .in("campanha_id", ids)
      .limit(100000);
    for (const d of (destinos ?? []) as any[]) {
      const m = porCampanha.get(d.campanha_id) || {};
      m[d.estado] = (m[d.estado] || 0) + 1;
      porCampanha.set(d.campanha_id, m);
    }
  }

  const campanhas = (data ?? []).map((c: any) => {
    const cont = porCampanha.get(c.id) || {};
    const total = Object.values(cont).reduce((a: number, b: number) => a + b, 0);
    return {
      ...c,
      canal_rotulo: canalPorId(c.canal)?.rotulo ?? c.canal,
      contagens: cont,
      // campanha historica nao tem linha de destino: o total vem da origem
      total: c.historico ? c.destinatarios_total ?? 0 : total,
      // a tela usa isso pra esconder qualquer botao de disparo
      pode_disparar: !c.historico,
    };
  });

  return NextResponse.json({ campanhas }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function POST(req: NextRequest) {
  const g = await portao(req);
  if (g instanceof NextResponse) return g;
  const { user, perfil } = g;

  const body = await req.json().catch(() => ({}));
  const nome = typeof body?.nome === "string" ? body.nome.trim() : "";
  const mensagem = typeof body?.mensagem === "string" ? body.mensagem : "";
  const canal = typeof body?.canal === "string" ? body.canal : "central";

  if (!nome) return NextResponse.json({ error: "de um nome pra campanha" }, { status: 400 });
  if (!mensagem.trim()) return NextResponse.json({ error: "a mensagem nao pode ficar vazia" }, { status: 400 });
  if (mensagem.length > 4096) return NextResponse.json({ error: "mensagem muito longa (teto de 4096)" }, { status: 400 });

  const def = canalPorId(canal);
  if (!def || !def.ativo) return NextResponse.json({ error: "canal desconhecido ou inativo" }, { status: 400 });

  // resolve o publico ANTES de gravar: campanha sem publico nao serve pra nada,
  // e o erro tem que aparecer no formulario, nao depois
  let publico: PublicoResolvido;
  const origem = body?.publico?.origem;
  if (origem === "csv") {
    const texto = typeof body.publico.csv === "string" ? body.publico.csv : "";
    if (!texto.trim()) return NextResponse.json({ error: "a planilha veio vazia" }, { status: 400 });
    if (texto.length > 5_000_000) return NextResponse.json({ error: "planilha grande demais" }, { status: 413 });
    publico = publicoDoCsv(texto);
  } else if (origem === "filtro") {
    publico = await publicoDoFiltro(body.publico.filtro || {}, user, perfil, req);
  } else if (origem === "lista") {
    publico = await publicoDaLista(String(body.publico.lista_id || ""));
  } else if (origem === "pipedrive") {
    const p = await publicoDoPipedrive(body.publico.pipedrive || {});
    // 400 = o PEDIDO esta torto; 501 = nao ha CRM aqui; 502 = o CRM nao respondeu
    if (p.pedidoInvalido) return NextResponse.json({ error: p.erro }, { status: 400 });
    if (p.indisponivel) return NextResponse.json({ error: p.erro }, { status: 501 });
    // FAIL-CLOSED na criacao: falha ao consultar o CRM NAO cria campanha com o
    // publico que deu pra ler. Publico pela metade gravado como definitivo
    // dispararia pra uma fatia e o resto sumiria sem ninguem notar.
    if (p.erro) return NextResponse.json({ error: p.erro }, { status: 502 });
    publico = p;
  } else {
    return NextResponse.json(
      { error: "origem do publico invalida (csv, filtro, lista ou pipedrive)" },
      { status: 400 }
    );
  }

  // lista de bloqueio: 1o dos dois pontos (o 2o e no envio, destino a destino)
  publico = await tirarBloqueados(publico);

  if (!publico.itens.length) {
    return NextResponse.json(
      { error: "o publico ficou vazio", detalhe: publico.aviso ?? null, invalidos: publico.invalidos.slice(0, 20) },
      { status: 400 }
    );
  }

  // agendamento: recusa data invalida com mensagem, em vez de gravar null
  // silenciosamente (ou 1970). Texto SEM offset e lido no fuso da INSTALACAO.
  let agendadaPara: string | null = null;
  if (body?.agendada_para !== undefined && body?.agendada_para !== null && body?.agendada_para !== "") {
    agendadaPara = isoDeLocal(body.agendada_para);
    if (!agendadaPara) {
      return NextResponse.json(
        { error: "data de agendamento invalida — use 2026-09-01T14:30 (hora local da sua operacao)" },
        { status: 400 }
      );
    }
  }

  const ritmo = normalizarRitmo({
    lote: body?.lote,
    intervalo_s: body?.intervalo_s,
    teto_por_numero_dia: body?.teto_por_numero_dia,
  });

  const db = msgDb();
  const { data: campanha, error } = await db
    .from("campanhas")
    .insert({
      nome,
      canal,
      mensagem,
      estado: "rascunho", // SEMPRE. Nao existe atalho pra criar ja rodando.
      agendada_para: agendadaPara,
      ...ritmo,
      criado_por_id: user.id,
      criado_por_nome: user.nome,
    })
    .select("id,nome,canal,estado,mensagem")
    .single();
  if (error || !campanha) return RESP_SEM_TABELA();

  // grava o publico em lotes; o indice unico (campanha_id, chat_id) garante que
  // rodar duas vezes nao duplica destino
  const linhas = publico.itens.map((i) => ({
    campanha_id: (campanha as any).id,
    chat_id: i.chat_id,
    telefone: i.telefone,
    nome: i.nome || null,
    variaveis: i.variaveis ?? null,
    estado: "pendente",
  }));
  for (let i = 0; i < linhas.length; i += 500) {
    const { error: e2 } = await db
      .from("campanha_destinos")
      .upsert(linhas.slice(i, i + 500), { onConflict: "campanha_id,chat_id", ignoreDuplicates: true });
    if (e2) {
      console.error("disparo: falha ao gravar publico", { campanha: (campanha as any).id, erro: e2.message });
      // NAO deixa campanha orfa: sem publico ela nao serve pra nada e ainda
      // apareceria na lista como rascunho fantasma. Apaga o que acabou de criar.
      await db.from("campanhas").delete().eq("id", (campanha as any).id).eq("estado", "rascunho");
      return NextResponse.json({ error: "falha ao gravar o publico da campanha" }, { status: 500 });
    }
  }

  return NextResponse.json({
    campanha,
    publico: {
      total: publico.itens.length,
      invalidos: publico.invalidos.length,
      duplicados: publico.duplicados.length,
      origem: publico.origem,
      bloqueados: publico.bloqueados ?? 0,
      aviso: publico.aviso ?? null,
    },
    // avisos que a tela mostra ANTES de alguem aprovar o disparo
    alertas: [
      ...(motivoCanalNaoEnvia(canal) ? [motivoCanalNaoEnvia(canal)!] : []),
      ...variaveisSemValor(mensagem, publico.itens).map(
        (v) => `a mensagem usa {{${v}}} e nenhum destino tem esse dado — vai sair vazio`
      ),
    ],
    estimativa: estimarDuracao(publico.itens.length, ritmo).texto,
  });
}
