import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, permitido, restricaoVazia } from "@/lib/perfil";
import { restricaoDeConversas } from "@/lib/acesso";
import { restricaoEfetiva } from "@/lib/embed";
import { canalDe, tabelas } from "@/lib/canal";
import { canaisAtivos } from "@/lib/canais";
import { msgDb } from "@/lib/mensageria";
import { csvLinha, erroSeguro } from "@/lib/relatorios";
import {
  CONSULTAS,
  TETO_LINHAS,
  aclDeConversa,
  avisoDeTeto,
  linhaDeIncompleto,
  linhaDeInterrompido,
  catalogoParaQuem,
  consultaPorId,
  desdeIso,
  diasDoPedido,
  linhaAcesso,
  linhaAnotacao,
  linhaMensagem,
  linhaUsuario,
  motivoParaNaoExportar,
  nomeDoArquivo,
  recorteDaVisao,
} from "@/lib/exportacao";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
// exportacao de 50 mil linhas em paginas de 1.000 leva mais que o default de 15s
export const maxDuration = 300;

// CONSULTAS EXPORTAVEIS (card 86ak85bne) — a UNICA porta por onde LINHA sai.
//
//   GET /api/exportar                                  -> catalogo (o que posso rodar)
//   GET /api/exportar?consulta=mensagens&dias=30        -> contagem + colunas (nunca linha)
//   GET /api/exportar?consulta=mensagens&formato=csv    -> o arquivo
//
// A regra de QUEM pode o que, e por que esta rota nao mora em /api/relatorios,
// esta em lib/exportacao.ts (arquivo puro, provado por
// `node scripts/prova-exportacao.ts`). Resumo do que importa aqui:
//
//  - linha de conversa (mensagens, anotacoes) so sai pra quem ve a operacao
//    INTEIRA. Visao com recorte -> 403 com a razao, nunca arquivo parcial que
//    parece completo;
//  - dado de pessoa da equipe (usuarios, acessos) exige `gerenciar_usuarios`;
//  - sobre os dois, `relatorios_exportar`.
//
// SEM TRUNCAMENTO CALADO: acima do teto a rota RECUSA e diz o tamanho real
// (`avisoDeTeto`). Arquivo cortado na linha 50.000 e o pior desfecho possivel —
// ninguem que abre a planilha descobre que faltou.
//
// SEM 500 QUANDO FALTA MIGRATION: a consulta de acessos depende da 0019; sem ela
// a resposta e 503 com a frase, no padrao do resto do painel.

const PAGINA = 1_000;

type Quem = { podeExportar: boolean; visaoSemRecorte: boolean; gerenciaUsuarios: boolean };

/**
 * VISAO SEM RECORTE — o calculo que decide se linha de conversa pode sair.
 *
 * QUATRO recortes existem no painel e QUALQUER um deles ja invalida a exportacao:
 * escopo de visao (proprias/departamento), restricao por funil/canal (frente Q),
 * contexto embutido (frente do widget) e a **ACL por conversa**
 * (`mensageria.conversa_visibilidade`). Super admin passa por definicao — ele passa
 * na camada 1 de `conversaVisivel` tambem, e e a mesma decisao de produto.
 *
 * O QUARTO ENTROU DEPOIS, e a falta dele era um vazamento (achado da revisao cega
 * de 31/08/2026). Em `lib/visibilidade.ts` o bloco `visibilidade?.length` roda
 * ANTES do atalho `escopo_visao === "todas"`: uma conversa com ACL fica INVISIVEL
 * pra quem tem escopo "todas" (que e o default de fabrica) e nao esta na lista nem
 * e responsavel. Ou seja, `podeVerConversa` escondia e a exportacao entregava — com
 * conteudo e `chat_id` (o telefone) dentro. Cenario concreto: conversas do juridico
 * travadas pra dois diretores, e um Supervisor com `relatorios_exportar` baixando
 * tudo em CSV.
 *
 * A checagem e GROSSA de proposito: existe QUALQUER linha de ACL na instalacao?
 * Entao esta exportacao nao sai. Nao e "quais conversas tem ACL" — um CSV nao sabe
 * recortar, e recusar por causa de uma ACL que talvez nao pegasse esta pessoa e um
 * falso negativo barato; o falso positivo custa o vazamento.
 *
 * Fail-closed em TRES pontos, de proposito: contexto invalido, leitura de restricao
 * que nao voltou (`restricaoDeConversas` devolve a restricao FECHADA quando o mapa
 * nao carrega) e erro ao ler a ACL contam como RECORTE, nao como liberado.
 */
async function visaoSemRecorte(req: NextRequest, user: Awaited<ReturnType<typeof getUser>>, perfil: any) {
  if (!user) return false;
  // a DECISAO e pura (lib/exportacao.ts); aqui so se colhem os quatro fatos
  if (perfil.papel === "super_admin") return recorteDaVisao(FATOS_SUPER).semRecorte;
  const emb = await restricaoEfetiva(req, user, perfil);
  const restricao = await restricaoDeConversas(user.id, false);
  return recorteDaVisao({
    ehSuperAdmin: false,
    escopoVisao: String(perfil.escopo_visao ?? ""),
    contextoEmbutido: emb === "invalido" ? "invalido" : emb ? "restrito" : "nenhum",
    restricaoFunilCanal: restricaoVazia(restricao) ? "vazia" : "restrito",
    aclDeConversa: await aclDeConversa(lerAclDeConversa),
  }).semRecorte;
}

const FATOS_SUPER = {
  ehSuperAdmin: true,
  escopoVisao: "todas",
  contextoEmbutido: "nenhum",
  restricaoFunilCanal: "vazia",
  aclDeConversa: "nenhuma",
} as const;

/**
 * A LEITURA da tabela de ACL. So I/O — uma expressao, nenhuma decisao.
 *
 * A DECISAO toda (o que cada erro significa, o que libera e o que recusa) mora em
 * `aclDeConversa` + `estadoDaAcl`, em lib/exportacao.ts, com este executor injetado.
 * A divisoria e o que torna a decisao provavel por COMPORTAMENTO: enquanto ela morava
 * aqui, a unica prova possivel era varredura de texto, e varredura protege a chamada,
 * nao o corpo — um `if (count) return "nenhuma"` no meio deste helper liberava o
 * GRAVE inteiro com a bateria verde (micro-check de 31/08/2026).
 *
 * Tabela ausente (0004 nao rodada) vira `tabela_ausente`, que LIBERA: sem tabela nao
 * ha recorte pra furar. E o mapeamento NAO usa o `semTabela` desta rota de proposito:
 * aquele e generoso (aceita cache do PostgREST) porque serve pra decidir 503 em
 * tabela opcional; aqui, generosidade LIBERA exportacao.
 */
function lerAclDeConversa() {
  return msgDb()
    .from("conversa_visibilidade")
    .select("chat_id", { count: "exact", head: true })
    .limit(1);
}

function semTabela(error: { code?: string | null } | null | undefined): boolean {
  const c = String(error?.code ?? "");
  return c === "42P01" || c === "42703" || c === "PGRST205" || c === "PGRST204";
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  // `relatorios` continua sendo o portao da VISAO; exportar e a permissao de cima
  if (!permitido(perfil, "relatorios")) {
    return NextResponse.json({ error: "sem permissao de relatorios" }, { status: 403 });
  }

  const quem: Quem = {
    podeExportar: permitido(perfil, "relatorios_exportar"),
    visaoSemRecorte: await visaoSemRecorte(req, user, perfil),
    gerenciaUsuarios: permitido(perfil, "gerenciar_usuarios"),
  };

  const q = req.nextUrl.searchParams;
  const semCache = { headers: { "Cache-Control": "no-store, max-age=0" } };
  const idConsulta = q.get("consulta");

  // ---- catalogo -----------------------------------------------------------
  if (!idConsulta) {
    return NextResponse.json(
      {
        consultas: catalogoParaQuem(quem).map((c) => ({
          id: c.id,
          titulo: c.titulo,
          o_que_sai: c.oQueSai,
          por_canal: c.porCanal,
          por_periodo: c.porPeriodo,
          colunas: c.colunas,
          disponivel: c.disponivel,
          motivo: c.motivo,
          migration: c.migration,
        })),
        canais: canaisAtivos().map((c) => ({ id: c.id, rotulo: c.rotulo })),
        teto_linhas: TETO_LINHAS,
        pode_exportar: quem.podeExportar,
        visao_sem_recorte: quem.visaoSemRecorte,
      },
      semCache
    );
  }

  const c = consultaPorId(idConsulta);
  if (!c) {
    return NextResponse.json(
      { error: `consulta desconhecida (as que existem: ${CONSULTAS.map((x) => x.id).join(", ")})` },
      { status: 400 }
    );
  }
  const motivo = motivoParaNaoExportar(c, quem);
  if (motivo) return NextResponse.json({ error: motivo }, { status: 403 });

  const dias = diasDoPedido(q.get("dias"));
  const desde = desdeIso(dias, new Date());
  const canal = c.porCanal ? canalDe(req) : null;
  const csv = (q.get("formato") || "").toLowerCase() === "csv";

  // ---- contagem (vale pros dois caminhos: e o freio do teto) --------------
  const cont = await contar(c.id, canal, c.porPeriodo ? desde : null);
  if (cont.erro) {
    return NextResponse.json(
      { error: cont.erro, disponivel: false, migration: c.migration },
      { status: cont.semTabela ? 503 : 500, ...semCache }
    );
  }
  const aviso = avisoDeTeto(cont.total);

  if (!csv) {
    // PREVIA = numero e cabecalho. Linha nenhuma sai por aqui, nem "as 10
    // primeiras": seria um segundo caminho de leitura mais frouxo que o CSV.
    return NextResponse.json(
      {
        consulta: c.id,
        titulo: c.titulo,
        o_que_sai: c.oQueSai,
        canal: canal ?? "todos",
        dias: c.porPeriodo ? dias : null,
        total: cont.total,
        colunas: c.colunas,
        teto_linhas: TETO_LINHAS,
        acima_do_teto: !!aviso,
        aviso,
      },
      semCache
    );
  }

  if (aviso) {
    // 413: o pedido e legitimo, o recorte e que nao cabe
    return NextResponse.json({ error: aviso, total: cont.total, teto_linhas: TETO_LINHAS }, { status: 413, ...semCache });
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (s: string) => controller.enqueue(enc.encode(s));
      let escritas = 0;
      try {
        push(csvLinha(c.colunas));
        let de = 0;
        for (;;) {
          const lote = await pagina(c.id, canal, c.porPeriodo ? desde : null, de, PAGINA);
          if (lote.erro) throw new Error(lote.erro);
          for (const l of lote.linhas) {
            push(csvLinha(l));
            escritas++;
          }
          if (lote.linhas.length < PAGINA) break;
          de += PAGINA;
          if (de >= TETO_LINHAS) break;
        }
        // CONFERENCIA DE FECHAMENTO: escreveu tudo o que a contagem prometeu? Um
        // short-read (db-max-rows menor que a pagina, erro engolido) encerrava o
        // laco mais cedo e o arquivo saia curto com HTTP 200 e sem marca nenhuma.
        // O total pode ter crescido entre a contagem e a leitura — e por isso a
        // marca so sai quando escreveu MENOS, nunca quando escreveu mais.
        const curto = linhaDeIncompleto(escritas, cont.total);
        if (curto) push(csvLinha([curto]));
      } catch (e: any) {
        // O cabecalho HTTP 200 ja foi. Nao existe como virar 500 no meio de um
        // download, entao a falha entra NO ARQUIVO, na ultima linha: melhor uma
        // planilha que diz "faltou o resto" do que uma que so termina antes.
        push(csvLinha([linhaDeInterrompido(e, escritas, cont.total)]));
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nomeDoArquivo(c.id, canal, new Date().toISOString().slice(0, 10))}"`,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

// ————————————————————————————————————————————————————————————————— consultas
//
// Anotacao interna e `mensagens` com `direcao='interna'` (mesmo formato das notas
// importadas — ver app/api/nota/route.ts). Por isso as duas consultas leem a
// mesma tabela com filtros opostos, e nenhuma das duas pode esquecer o filtro:
// sem ele, "Mensagens" entregaria nota interna ao cliente do arquivo e
// "Anotacoes" entregaria a conversa inteira.

async function contar(
  id: string,
  canal: string | null,
  desde: string | null
): Promise<{ total: number; erro?: string; semTabela?: boolean }> {
  const db = msgDb();
  try {
    if (id === "mensagens" || id === "anotacoes") {
      const T = tabelas(canal || "central");
      let s = db.from(T.mensagens).select("id", { count: "exact", head: true });
      s = id === "anotacoes" ? s.eq("direcao", "interna") : s.neq("direcao", "interna");
      if (desde) s = s.gte("criada_em", desde);
      const { count, error } = await s;
      if (error) return { total: 0, erro: erroSeguro(error), semTabela: semTabela(error) };
      return { total: count ?? 0 };
    }
    if (id === "usuarios") {
      const { count, error } = await db.from("perfis").select("user_id", { count: "exact", head: true });
      if (error) return { total: 0, erro: erroSeguro(error), semTabela: semTabela(error) };
      return { total: count ?? 0 };
    }
    let s = db.from("usuario_dispositivos").select("id", { count: "exact", head: true });
    if (desde) s = s.gte("visto_em", desde);
    const { count, error } = await s;
    if (error) {
      return {
        total: 0,
        erro: semTabela(error)
          ? "inventario de dispositivos indisponivel nesta instalacao — rode a migration 0019_seguranca_conta.sql"
          : erroSeguro(error),
        semTabela: semTabela(error),
      };
    }
    return { total: count ?? 0 };
  } catch (e: any) {
    return { total: 0, erro: "falha ao consultar" };
  }
}

async function pagina(
  id: string,
  canal: string | null,
  desde: string | null,
  de: number,
  tamanho: number
): Promise<{ linhas: unknown[][]; erro?: string }> {
  const db = msgDb();
  const ate = de + tamanho - 1;
  if (id === "mensagens" || id === "anotacoes") {
    const T = tabelas(canal || "central");
    let s = db
      .from(T.mensagens)
      .select(
        "id,criada_em,chat_id,direcao,tipo,conteudo,sender_name,sender_phone,enviado_por_nome,status,media_url,is_deleted"
      )
      // ORDEM DETERMINISTICA: `criada_em` NAO e unico (o importador grava o
      // timestamp da origem, e rajada empata no mesmo instante). Paginacao por
      // OFFSET sobre ordem ambigua duplica ou PERDE linha na borda da pagina — e
      // linha perdida num CSV nao deixa rastro. `id` e o desempate.
      .order("criada_em", { ascending: true })
      .order("id", { ascending: true })
      .range(de, ate);
    s = id === "anotacoes" ? s.eq("direcao", "interna") : s.neq("direcao", "interna");
    if (desde) s = s.gte("criada_em", desde);
    const { data, error } = await s;
    if (error) return { linhas: [], erro: erroSeguro(error) };
    const f = id === "anotacoes" ? linhaAnotacao : linhaMensagem;
    return { linhas: (data ?? []).map((r) => f(r as Record<string, unknown>, canal || "central")) };
  }
  if (id === "usuarios") {
    // e-mail NAO entra (ver `campoNuncaExportado` em lib/exportacao.ts)
    const COLS = "user_id,nome,papel,escopo_visao,ativo,assinatura_ativa,criado_em";
    let { data, error } = await db
      .from("perfis")
      .select(`${COLS},papel_id`)
      .order("criado_em", { ascending: true })
      // desempate: dois perfis criados no mesmo instante (semente/importacao) empatam
      .order("user_id", { ascending: true })
      .range(de, ate);
    if (error && String((error as any).code) === "42703") {
      // `papel_id` nasce na 0010. Instalacao que nao rodou a 0010 nao perde a
      // exportacao inteira por causa de UMA coluna: sai sem o papel nomeado, com
      // o papel BASE (que e o que decide permissao de fabrica) no lugar.
      const alt = await db.from("perfis").select(COLS).order("criado_em", { ascending: true }).order("user_id", { ascending: true }).range(de, ate);
      data = alt.data as any;
      error = alt.error;
    }
    if (error) return { linhas: [], erro: erroSeguro(error) };
    // nome do papel nomeado, quando a 0010 rodou. Falha aqui NAO derruba a
    // exportacao: a coluna sai vazia (o papel BASE, que e o que decide a
    // permissao de fabrica, ja esta na linha).
    const ids = [...new Set((data ?? []).map((r: any) => r.papel_id).filter(Boolean))];
    const nomes = new Map<string, string>();
    if (ids.length) {
      const { data: ps } = await db.from("papeis").select("id,nome").in("id", ids);
      for (const p of ps ?? []) nomes.set(String((p as any).id), String((p as any).nome));
    }
    return {
      linhas: (data ?? []).map((r: any) =>
        linhaUsuario({ ...r, papel_nome: r.papel_id ? nomes.get(String(r.papel_id)) : "" })
      ),
    };
  }
  let s = db
    .from("usuario_dispositivos")
    .select("user_id,navegador,sistema,rotulo,robo,primeiro_acesso_em,visto_em,ip_ultimo,revogado_em")
    .order("visto_em", { ascending: false })
    // desempate: varios dispositivos vistos no mesmo minuto empatam
    .order("id", { ascending: true })
    .range(de, ate);
  if (desde) s = s.gte("visto_em", desde);
  const { data, error } = await s;
  if (error) return { linhas: [], erro: erroSeguro(error) };
  return { linhas: (data ?? []).map((r) => linhaAcesso(r as Record<string, unknown>)) };
}
