import { NextRequest, NextResponse } from "next/server";
import { portao } from "@/lib/disparo/rota";
import {
  publicoDaLista,
  publicoDoCsv,
  publicoDoFiltro,
  publicoDoPipedrive,
  tirarBloqueados,
  type PublicoResolvido,
} from "@/lib/disparo/publico";
import { estimarDuracao, normalizarRitmo } from "@/lib/disparo/ritmo";
import { variaveisSemValor } from "@/lib/disparo/csv";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
// a varredura do CRM pagina 500 por vez e pode ir a 40 paginas: o mesmo teto de
// tempo que /api/embed/sync usa pra varredura de Pipedrive
export const maxDuration = 300;

// —————————————————————————————————————————————————— catalogo das origens externas
//
// GET = "o que esta instalacao tem pra oferecer como publico do CRM": os filtros
// que alguem JA salvou no Pipedrive e as etapas dos funis dele. E o passo que
// falta pra pessoa ESCOLHER — sem ele a rota de previa exigiria que ela soubesse
// de cabeca o id numerico do filtro.
//
// LEITURA PURA, e nada e gravado. Sem credencial na instalacao a resposta diz
// `disponivel: false` com 200: a tela esconde a origem em vez de mostrar um botao
// que da erro. Falha ao CONSULTAR e outra coisa (502 com o motivo) — "nao tem
// CRM aqui" e "o CRM nao respondeu" nao podem chegar iguais na tela.

export async function GET(req: NextRequest) {
  const g = await portao(req);
  if (g instanceof NextResponse) return g;

  const sem = { "Cache-Control": "no-store, max-age=0" } as const;
  const pd = await import("@/lib/disparo/pipedrive");
  const { portaPipedrive } = await import("@/lib/disparo/pipedrive-http");

  const porta = portaPipedrive();
  if (!porta) {
    return NextResponse.json(
      {
        fonte: "pipedrive",
        disponivel: false,
        motivo:
          "esta instalacao nao tem o Pipedrive configurado — defina a env PIPEDRIVE_API_TOKEN pra usar filtros e etapas do CRM como publico",
      },
      { headers: sem }
    );
  }

  try {
    // as duas consultas sao independentes: pedir em paralelo poupa uma ida
    const [corpoFiltros, corpoEtapas] = await Promise.all([porta("/filters"), porta("/stages")]);
    if (!pd.respostaOk(corpoFiltros)) throw new pd.ErroPipedrive(pd.erroDaResposta(corpoFiltros));
    if (!pd.respostaOk(corpoEtapas)) throw new pd.ErroPipedrive(pd.erroDaResposta(corpoEtapas));

    const cat = pd.filtrosDaResposta(corpoFiltros);
    const et = pd.etapasDaResposta(corpoEtapas);
    return NextResponse.json(
      {
        fonte: "pipedrive",
        disponivel: true,
        filtros: cat.filtros,
        // transparencia: sem isto o dono do CRM procura na tela um filtro que ele
        // sabe que existe (de organizacao, de atividade) e conclui que o painel
        // perdeu dado
        filtros_ignorados_por_tipo: cat.ignorados_por_tipo,
        filtros_temporarios: cat.temporarios,
        filtros_inativos: cat.inativos,
        filtros_truncado: cat.truncado,
        etapas: et.etapas,
        etapas_truncado: et.truncado,
        status_etapa_padrao: pd.STATUS_ETAPA_PADRAO,
      },
      { headers: sem }
    );
  } catch (e) {
    return NextResponse.json(
      { fonte: "pipedrive", disponivel: true, error: (e as Error)?.message || "falha ao consultar o Pipedrive" },
      { status: 502, headers: sem }
    );
  }
}

// PREVIA do publico — valida ANTES de existir campanha (card 86ak85jdk).
//
// Nada e gravado aqui. E a tela perguntando "se eu usar este publico, o que
// acontece?": quantos entram, quantos telefones estao tortos e em que linha da
// planilha, quantos sao duplicata, e quanto tempo o disparo levaria.
//
// Por que previa separada da criacao: o card pede validacao ANTES de habilitar
// o envio. Descobrir que 300 dos 500 telefones estao invalidos depois de a
// campanha existir e tarde — a pessoa ja aprovou mentalmente o numero errado.

export async function POST(req: NextRequest) {
  const g = await portao(req);
  if (g instanceof NextResponse) return g;
  const { user, perfil } = g;

  const body = await req.json().catch(() => ({}));
  const origem = body?.origem;

  let publico: PublicoResolvido;
  if (origem === "csv") {
    const texto = typeof body?.csv === "string" ? body.csv : "";
    if (!texto.trim()) return NextResponse.json({ error: "a planilha veio vazia" }, { status: 400 });
    if (texto.length > 5_000_000) return NextResponse.json({ error: "planilha grande demais" }, { status: 413 });
    publico = publicoDoCsv(texto);
  } else if (origem === "filtro") {
    publico = await publicoDoFiltro(body?.filtro || {}, user, perfil, req);
  } else if (origem === "lista") {
    publico = await publicoDaLista(String(body?.lista_id || ""));
  } else if (origem === "pipedrive") {
    const p = await publicoDoPipedrive(body?.pipedrive || {});
    // 501 = a fonte nao existe nesta instalacao; 502 = ela existe e nao
    // respondeu. Devolver `total: 0` nos dois casos e o que faz alguem concluir
    // que o filtro do CRM esvaziou.
    // 400 = o PEDIDO esta torto; 501 = nao ha CRM aqui; 502 = o CRM nao respondeu
    if (p.pedidoInvalido) return NextResponse.json({ error: p.erro }, { status: 400 });
    if (p.indisponivel) return NextResponse.json({ error: p.erro }, { status: 501 });
    if (p.erro) return NextResponse.json({ error: p.erro }, { status: 502 });
    publico = p;
  } else {
    return NextResponse.json(
      { error: "origem do publico invalida (csv, filtro, lista ou pipedrive)" },
      { status: 400 }
    );
  }

  // quem esta na lista de bloqueio sai do publico JA na previa: o numero que a
  // pessoa aprova tem que ser o numero que vai receber
  publico = await tirarBloqueados(publico);

  const ritmo = normalizarRitmo({
    lote: body?.lote,
    intervalo_s: body?.intervalo_s,
    teto_por_numero_dia: body?.teto_por_numero_dia,
  });
  const mensagem = typeof body?.mensagem === "string" ? body.mensagem : "";

  return NextResponse.json(
    {
      origem: publico.origem,
      total: publico.itens.length,
      bruto: publico.bruto,
      // amostra pra tela conferir que as colunas foram lidas certo (nome no
      // lugar de nome, telefone no lugar de telefone)
      amostra: publico.itens.slice(0, 10),
      invalidos: publico.invalidos.slice(0, 50),
      invalidos_total: publico.invalidos.length,
      duplicados_total: publico.duplicados.length,
      bloqueados_total: publico.bloqueados ?? 0,
      aviso: publico.aviso ?? null,
      estimativa: estimarDuracao(publico.itens.length, ritmo).texto,
      alertas: mensagem
        ? variaveisSemValor(mensagem, publico.itens).map(
            (v) => `a mensagem usa {{${v}}} e nenhum destino tem esse dado — vai sair vazio`
          )
        : [],
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
