import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { getUser, type UsuarioLogado } from "@/lib/auth-server";
import { getPerfil, permitido } from "@/lib/perfil";
import { moduloAtivo } from "@/lib/modulos";
import { canalDe } from "@/lib/canal";
import { podeVerConversa } from "@/lib/perfil";
import { restricaoEfetiva } from "@/lib/embed";
import {
  validarFluxo, acoesDoFluxo, fluxoLinear, nosComAprovacao, nosComAvalQueImporta,
  type CampoCondicao, type FatosConversa, type Fluxo,
} from "@/lib/fluxo/schema";
import { simularMensagem, type EntradaSimulacao } from "@/lib/fluxo/simulador";
import {
  aplicarPatchNoFluxo, aplicarPatchNoPasso, casaBusca, classificarChamadas, escaparLike, montarGrafo, moverPasta,
  nomeDeCopia, normalizarPasta, passosDoFluxo, pastaContem, slugLivre, slugValido,
} from "@/lib/fluxo/editor";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// FLUXOS — gestao e edicao (modulo `automacao`, desligado por default).
//
//   GET    lista / detalhe (?slug=) / mapa da rede (?grafo=1)
//   POST   criar | salvar (editor) | rapida (edicao na listagem) |
//          passo (edicao rapida POR ACAO) | duplicar |
//          mover_pasta (renomear/mover pasta inteira)
//   DELETE apaga UM fluxo, so com confirmacao explicita
//
// TRES coisas que esta rota nunca faz, e o porque:
//   1. NAO EXECUTA fluxo. Disparar continua sendo `/api/macros`, que tem o
//      preflight, a trilha e o gate de conversa. Editor que executa vira uma
//      segunda porta de envio pro cliente final, sem as travas da primeira.
//   2. NAO CRIA TABELA. A 0015 e gesto humano no SQL Editor; sem ela a rota
//      degrada (ver `semColunasNovas`), nunca 500.
//   3. NAO GRAVA FLUXO INVALIDO. `validarFluxo` e o portao unico — editor,
//      edicao rapida e duplicacao passam todos por ele.
//
// AUTORIZACAO: modulo `automacao` ligado + permissao nomeada `automacao`
// (lib/permissoes.ts: "Configurar as automacoes do painel — nao e o mesmo que
// EXECUTAR um macro"). Quem executa macro nao ganha o editor de brinde.

// UM teto so, de proposito. Havia dois (500 na listagem, 2.000 na varredura) e
// isso produzia tres defeitos que a revisao pegou:
//   - a conta medida tem 935 dialogos na origem, entao a listagem escondia ~400
//     deles (o numero e do ChatGuru, nao de linhas em `mensageria.fluxos`);
//   - a busca roda em memoria (acento-insensivel, ver casaBusca), entao buscar
//     fora dos primeiros 500 respondia "Nenhum fluxo por aqui" — busca que MENTE
//     e pior que busca lenta;
//   - "chamado por N" saia de um grafo de 500 linhas enquanto `?grafo=1` usava
//     2.000: o MESMO fluxo mostrava numeros diferentes em duas telas.
// Um teto unico resolve os tres. Acima dele, `truncado` vai pra tela como aviso.
const LIMITE_VARREDURA = 2000;

// colunas da 0015. Se a migration nao rodou, o PostgREST devolve 42703 e a
// leitura e refeita sem elas — a tela perde pasta e autoria, nao perde fluxo.
const COLS_BASE = "slug,nome,tipo,ativo,fluxo,origem_ferramenta,origem_id,criada_em,atualizada_em";
const COLS_0015 = `${COLS_BASE},pasta,atualizado_por_nome`;
const COL_INEXISTENTE = "42703";

// Re-testa a cada 60s: no minuto seguinte a migration rodar, a pasta volta a
// funcionar sem redeploy (mesmo padrao de colunasPerfil0011Ausentes).
let marcaSemColunas = 0;
function semColunasNovas(): boolean {
  return Date.now() - marcaSemColunas < 60_000;
}

type Linha = {
  slug: string;
  nome: string;
  tipo: string;
  ativo: boolean;
  fluxo: unknown;
  pasta?: string;
  origem_ferramenta?: string | null;
  origem_id?: string | null;
  criada_em?: string;
  atualizada_em?: string;
  atualizado_por_nome?: string | null;
};

type Leitura =
  | { ok: true; linhas: Linha[]; pastas: boolean; truncado: boolean }
  | { ok: false; aviso: string };

// Le a tabela tolerando as duas ausencias possiveis: a tabela inteira (0008 nao
// rodou) e as colunas novas (0015 nao rodou).
async function lerFluxos(opts: { limite: number; pasta?: string }): Promise<Leitura> {
  const monta = (cols: string) => {
    let q = msgDb().from("fluxos").select(cols).order("nome").limit(opts.limite + 1);
    // Filtro de pasta por PREFIXO no banco e so um redutor de payload: e um
    // SUPERSET do que vale ("Vendas%" traz "Vendas B2B" junto), e quem decide
    // de verdade e `pastaContem`, que compara segmento. Superset no banco +
    // exato na memoria = barato e correto.
    // escaparLike e obrigatorio: `%` e `_` sao CORINGA no like, e caminho de
    // pasta e texto que o usuario digitou.
    if (opts.pasta && cols.includes("pasta")) q = q.like("pasta", `${escaparLike(opts.pasta)}%`);
    return q;
  };

  let usouPasta = !semColunasNovas();
  let { data, error } = await monta(usouPasta ? COLS_0015 : COLS_BASE);

  if (error && (error as any).code === COL_INEXISTENTE && usouPasta) {
    marcaSemColunas = Date.now();
    usouPasta = false;
    ({ data, error } = await monta(COLS_BASE));
  }
  if (error) {
    // tabela ausente, sem grant, banco fora: lista vazia com aviso, NUNCA 500
    // (mesma promessa de /api/macros)
    return {
      ok: false,
      aviso:
        "nenhum fluxo disponivel (as migrations 0008 e 0015 ja foram aplicadas nesta instalacao?)",
    };
  }
  const linhas = (data ?? []) as unknown as Linha[];
  return {
    ok: true,
    linhas: linhas.slice(0, opts.limite),
    pastas: usouPasta,
    truncado: linhas.length > opts.limite,
  };
}

async function porteiro(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return { erro: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!(await moduloAtivo("automacao"))) {
    return { erro: NextResponse.json({ error: "modulo de automacao desligado nesta instalacao" }, { status: 403 }) };
  }
  const perfil = await getPerfil(user.id);
  // fail-closed: quem nao tem a permissao nomeada nao ve nem edita automacao
  if (!permitido(perfil, "automacao")) {
    return { erro: NextResponse.json({ error: "sem permissao de automacao" }, { status: 403 }) };
  }
  return { user, perfil };
}

const semCache = { "Cache-Control": "no-store, max-age=0" } as const;

// Resumo de UMA linha pra tela. Cada linha e ISOLADA: jsonb ruim vira item
// marcado `invalido`, nunca excecao — a listagem que quebra por causa de um
// fluxo torto e exatamente a que impede de consertar aquele fluxo.
function resumoLinha(row: Linha) {
  const base = {
    slug: row.slug,
    nome: row.nome,
    tipo: row.tipo,
    ativo: row.ativo !== false,
    pasta: normalizarPasta(row.pasta),
    origem: row.origem_ferramenta
      ? { ferramenta: row.origem_ferramenta, id_original: row.origem_id ?? null }
      : null,
    atualizada_em: row.atualizada_em ?? null,
    atualizado_por: row.atualizado_por_nome ?? null,
    // PRESENCA, nao contagem, e "nao trazida", nao "perdida". Dois motivos
    // medidos: (a) 1.205 das 3.607 chamadas do acervo nunca tiveram destino
    // configurado, entao chamar tudo de perda acusa buraco inexistente; (b) o
    // conversor deduplica a ressalva por fluxo, entao "quantas" nao existe no
    // dado — um fluxo com 15 chamadas chegaria aqui como "1".
    chamadas: classificarChamadas(row.fluxo),
  };
  try {
    const v = validarFluxo(row.fluxo);
    if (!v.ok) {
      return { ...base, invalido: true, erros: v.erros.slice(0, 5), passos: passosDoFluxo(row.fluxo).length, acoes: [] };
    }
    // coluna e jsonb divergentes: a linha esta inconsistente e a tela precisa
    // saber (o mesmo cuidado de /api/macros)
    if (v.fluxo.tipo !== row.tipo) {
      return {
        ...base,
        invalido: true,
        erros: [`coluna tipo='${row.tipo}' mas o fluxo gravado e do tipo '${v.fluxo.tipo}'`],
        passos: v.fluxo.nos.length,
        acoes: [],
      };
    }
    return {
      ...base,
      invalido: false,
      erros: [],
      descricao: v.fluxo.descricao ?? null,
      passos: v.fluxo.nos.length,
      acoes: acoesDoFluxo(v.fluxo),
      // Frente P: os passos da corrente que param esperando aval humano, e os
      // limites por conversa. Vao pra tela porque sao a diferenca entre "este
      // fluxo roda ao clicar" e "este fluxo entra numa fila e espera alguem" —
      // e quem edita precisa ver isso sem abrir no a no.
      aprovacao_nos: nosComAprovacao(v.fluxo),
      // OS DOIS NUMEROS, e eles nao sao o mesmo: `aprovacao_nos` e o CAMPO como
      // esta gravado (inclui passo interno, onde a marca nao bloqueia nada) e
      // `aval_que_bloqueia` e o que realmente para a cadeia e tira o fluxo do
      // caminho inline (so passo cuja acao alcanca o cliente). Publicar so o
      // primeiro fazia a tela dizer "este fluxo pede aprovacao" pra fluxo que roda
      // num clique — foi o caso de 631 dos 828 fluxos da importacao.
      aval_que_bloqueia: nosComAvalQueImporta(v.fluxo),
      limites: v.fluxo.limites ?? null,
    };
  } catch (e: any) {
    console.error("fluxo ilegivel na listagem", { slug: row?.slug, erro: e?.message });
    return { ...base, invalido: true, erros: ["fluxo ilegivel"], passos: 0, acoes: [] };
  }
}

// -------------------------------------------------------------- simulador
const LIMITE_TEXTO_SIMULADO = 4096;

/**
 * Monta os FATOS da simulacao. Duas fontes, e a ordem importa:
 *
 *  1. `chat_id` (opcional) carrega os fatos REAIS daquela conversa — status,
 *     etiquetas, contexto e etapa de funil. E o que faz o simulador responder
 *     "e nesta conversa aqui, o que aconteceria?".
 *  2. Os parametros da query VENCEM o que veio da conversa: e assim que se testa
 *     "e se o cliente escrevesse X?" ou "e se o status fosse concluido?".
 *
 * Campo que NINGUEM informou fica AUSENTE, e ausente derruba comparacao de valor
 * (fail-closed, regra da Frente L). Por isso a resposta devolve `informados`: sem
 * essa lista, "nao dispara" e indistinguivel de "voce nao me disse o status".
 */
async function fatosDaSimulacao(
  req: NextRequest,
  url: URL,
  user: UsuarioLogado,
  perfil: any
): Promise<
  | { ok: true; fatos: FatosConversa; informados: CampoCondicao[]; canal: string; chat_id: string | null }
  | { ok: false; resposta: NextResponse }
> {
  const fatos: FatosConversa = {};
  const informados = new Set<CampoCondicao>();
  const canal = canalDe(req);
  const chatId = url.searchParams.get("chat_id");

  if (chatId) {
    // GATE DE CONVERSA: os fatos de uma conversa sao dado dela. Ter a permissao
    // `automacao` nao da direito de ler o contexto e as etiquetas de conversa fora
    // do escopo de quem pediu.
    if (!(await podeVerConversa(chatId, user, perfil, canal))) {
      return { ok: false, resposta: NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 }) };
    }
    const emb = await restricaoEfetiva(req, user, perfil);
    if (emb === "invalido") {
      return { ok: false, resposta: NextResponse.json({ error: "contexto invalido" }, { status: 401 }) };
    }
    if (emb && !emb.permite(chatId)) {
      return { ok: false, resposta: NextResponse.json({ error: "fora do contexto" }, { status: 403 }) };
    }
    // import preguicoso: `coletarFatos` arrasta o motor (banco, provedor) e essa
    // rota tem outros caminhos que nao precisam dele
    const { coletarFatos } = await import("@/lib/fluxo/executar");
    const coleta = await coletarFatos(
      { canal, chat_id: chatId, usuario: { id: user.id, nome: user.nome }, trilha: false },
      new Set<CampoCondicao>(["texto", "status", "etiqueta", "contexto", "etapa", "intencao"])
    );
    Object.assign(fatos, coleta.fatos);
    for (const c of ["texto", "status", "etiqueta", "contexto", "etapa", "intencao"] as CampoCondicao[]) {
      // campo que a conversa nao soube responder NAO entra em `informados`: ele
      // segue ausente, e o aviso da simulacao vai dizer isso
      if (coleta.indisponiveis[c] === undefined) informados.add(c);
    }
  }

  const texto = url.searchParams.get("texto");
  if (texto !== null) {
    fatos.texto = texto.slice(0, LIMITE_TEXTO_SIMULADO);
    informados.add("texto");
    // O TEXTO INFORMADO TAMBEM RECONHECE INTENCAO, e isso e o que faz a simulacao
    // ser honesta: na vida real a intencao sai do texto da mensagem, entao simular
    // "e se ele escrevesse X?" sem reconhecer a intencao de X mandaria a pessoa
    // consertar um fluxo que dispara sim. Reconhecimento LOCAL (zero rede, zero
    // API paga) — quem le o catalogo e a camada de banco das intencoes.
    // Intencao informada direto na query (abaixo) VENCE isto: e assim que se testa
    // uma intencao sem escrever a frase.
    const { intencoesDoTexto } = await import("@/lib/fluxo/intencoes-db");
    const r = await intencoesDoTexto(fatos.texto);
    if (r.ok) {
      fatos.intencoes = r.nomes;
      informados.add("intencao");
    }
    // catalogo indisponivel (0022 nao aplicada): NAO entra em `informados`, entao a
    // ressalva da simulacao diz que o campo ficou em branco em vez de fingir que
    // nenhuma intencao bateu
  }
  const intencoes = url.searchParams.get("intencoes");
  if (intencoes !== null) {
    fatos.intencoes = intencoes.split(",").map((i) => i.trim()).filter(Boolean).slice(0, 30);
    informados.add("intencao");
  }
  const status = url.searchParams.get("status");
  if (status !== null) {
    fatos.status = status;
    informados.add("status");
  }
  const etiquetas = url.searchParams.get("etiquetas");
  if (etiquetas !== null) {
    fatos.etiquetas = etiquetas.split(",").map((e) => e.trim()).filter(Boolean).slice(0, 30);
    informados.add("etiqueta");
  }
  const contexto = url.searchParams.get("contexto");
  if (contexto !== null) {
    // contexto vem como JSON de pares; lixo NAO vira contexto vazio em silencio
    try {
      const bruto = JSON.parse(contexto);
      const { normalizarContexto } = await import("@/lib/fluxo/schema");
      fatos.contexto = normalizarContexto(bruto);
      informados.add("contexto");
    } catch {
      return {
        ok: false,
        resposta: NextResponse.json({ error: "contexto precisa ser um JSON de pares chave/valor" }, { status: 400 }),
      };
    }
  }
  const funil = url.searchParams.get("funil");
  const etapa = url.searchParams.get("etapa");
  if (funil !== null) {
    if (!etapa) {
      return {
        ok: false,
        resposta: NextResponse.json(
          { error: "pra simular etapa informe funil E etapa (nome de etapa se repete entre funis)" },
          { status: 400 }
        ),
      };
    }
    fatos.etapas = [{ funil, etapa }];
    informados.add("etapa");
  }

  return { ok: true, fatos, informados: [...informados], canal, chat_id: chatId };
}

async function simular(
  req: NextRequest,
  url: URL,
  linhas: Linha[],
  user: UsuarioLogado,
  perfil: any,
  truncado: boolean
): Promise<NextResponse> {
  const f = await fatosDaSimulacao(req, url, user, perfil);
  if (!f.ok) return f.resposta;

  // Fluxo com jsonb torto NAO derruba a simulacao inteira: ele sai numa lista
  // propria. Mesma promessa da listagem — a tela que quebra por causa de um fluxo
  // ruim e exatamente a que impede de consertar aquele fluxo.
  const entradas: EntradaSimulacao[] = [];
  const invalidos: { slug: string; nome: string; erros: string[] }[] = [];
  for (const row of linhas) {
    try {
      const v = validarFluxo(row.fluxo);
      if (!v.ok) {
        invalidos.push({ slug: row.slug, nome: row.nome, erros: v.erros.slice(0, 3) });
        continue;
      }
      entradas.push({ slug: row.slug, nome: row.nome, ativo: row.ativo !== false, fluxo: v.fluxo });
    } catch {
      invalidos.push({ slug: row?.slug ?? "?", nome: row?.nome ?? "?", erros: ["fluxo ilegivel"] });
    }
  }

  const r = simularMensagem(entradas, f.fatos, f.informados);
  const ressalvas = [...r.ressalvas];
  if (truncado) {
    // SIMULACAO PARCIAL NUNCA PARECE COMPLETA: sem este aviso, "nenhum fluxo
    // responderia" seria lido como resposta definitiva quando na verdade a
    // varredura nao alcancou a conta inteira.
    ressalvas.push(
      "esta instalacao tem mais fluxos do que a varredura le de uma vez: a simulacao cobriu so os primeiros lidos"
    );
  }
  if (invalidos.length) {
    ressalvas.push(
      `${invalidos.length} fluxo(s) estao fora do formato canonico e NAO foram simulados (eles aparecem em "invalidos")`
    );
  }

  return NextResponse.json(
    {
      simulacao: {
        ...r,
        ressalvas,
        // o que foi simulado, de volta pra tela — pra ninguem ficar em duvida
        // sobre qual mensagem gerou aquele resultado
        entrada: {
          texto: f.fatos.texto ?? null,
          status: f.fatos.status ?? null,
          etiquetas: f.fatos.etiquetas ?? [],
          contexto: f.fatos.contexto ?? {},
          etapas: f.fatos.etapas ?? [],
          informados: f.informados,
          canal: f.canal,
          chat_id: f.chat_id,
        },
      },
      invalidos,
      total_simulados: entradas.length,
      truncado,
    },
    { headers: semCache }
  );
}

// ------------------------------------------------------------------- GET
export async function GET(req: NextRequest) {
  const p = await porteiro(req);
  if ("erro" in p) return p.erro;

  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  const grafo = url.searchParams.get("grafo") === "1";
  const q = url.searchParams.get("q") ?? "";
  const escopo = url.searchParams.get("escopo") === "conteudo" ? "conteudo" : "nome";
  const pasta = normalizarPasta(url.searchParams.get("pasta"));
  const incluirInativos = url.searchParams.get("inativos") !== "0";

  // id/slug validado ANTES de virar filtro de banco
  if (slug !== null && !slugValido(slug)) {
    return NextResponse.json({ error: "slug invalido" }, { status: 400 });
  }

  // SEMPRE a conta inteira (ate o teto). "Quem chama este fluxo" so esta certo
  // se todos os fluxos foram lidos, e a busca em memoria (acento-insensivel) so
  // e honesta se todos passaram por ela.
  //
  // A pasta selecionada e ESCOPO da busca, e alcanca a subarvore toda — pasta
  // FECHADA na tela nao esconde resultado, porque quem decide e `pastaContem`
  // (por segmento), nao o estado de abertura da arvore.
  // SIMULAR IGNORA A PASTA de proposito: numa mensagem de verdade, TODOS os fluxos
  // da instalacao competem — a pasta e arrumacao de quem edita, nao escopo de
  // execucao. Simular dentro de uma pasta responderia "nenhum fluxo dispararia"
  // enquanto outro, de outra pasta, dispararia sim. Simulacao que MENTE e pior que
  // simulacao lenta.
  const simulando = url.searchParams.get("simular") === "1";
  const leitura = await lerFluxos({
    limite: LIMITE_VARREDURA,
    pasta: !grafo && !slug && !simulando && pasta ? pasta : undefined,
  });
  if (!leitura.ok) {
    return NextResponse.json(
      { fluxos: [], pastas_disponiveis: false, aviso: leitura.aviso },
      { headers: semCache }
    );
  }

  // ------------------------------------------------------------ SIMULADOR
  // Card 86ak85a69. Responde "o que aconteceria com esta mensagem" SEM ENVIAR
  // NADA. Fica no GET (rota de LEITURA) de proposito: a avaliacao e pura
  // (lib/fluxo/simulador.ts nao importa banco nem provedor, e nao ha caminho dali
  // pra `enviarTexto`), entao expor isso num GET nao cria segunda porta de envio —
  // o mesmo cuidado que faz esta rota nunca executar fluxo.
  if (simulando) {
    return await simular(req, url, leitura.linhas, p.user, p.perfil, leitura.truncado);
  }

  const g = montarGrafo(
    leitura.linhas.map((r) => ({
      slug: r.slug,
      nome: r.nome,
      pasta: normalizarPasta(r.pasta),
      ativo: r.ativo !== false,
      fluxo: r.fluxo,
    }))
  );
  const porSlug = new Map(g.nos.map((n) => [n.slug, n]));

  if (grafo) {
    return NextResponse.json(
      {
        // so metadado e arestas: o jsonb inteiro nao vai pro mapa
        nos: g.nos,
        raizes: g.raizes,
        arestas: g.arestas,
        fluxos_com_alvo_nao_trazido: g.fluxos_com_alvo_nao_trazido,
        fluxos_sem_alvo: g.fluxos_sem_alvo,
        pastas_disponiveis: leitura.pastas,
        truncado: leitura.truncado,
      },
      { headers: semCache }
    );
  }

  if (slug) {
    const row = leitura.linhas.find((r) => r.slug === slug);
    if (!row) return NextResponse.json({ error: "fluxo nao encontrado" }, { status: 404 });
    const no = porSlug.get(slug);
    return NextResponse.json(
      {
        ...resumoLinha(row),
        // o jsonb como esta gravado: o editor precisa do fluxo inteiro
        fluxo: row.fluxo,
        passos_detalhe: passosDoFluxo(row.fluxo),
        chama: no?.chama ?? [],
        chamado_por: no?.chamado_por ?? [],
        alvos_ausentes: no?.alvos_ausentes ?? [],
        pastas_disponiveis: leitura.pastas,
      },
      { headers: semCache }
    );
  }

  const fluxos = leitura.linhas
    .filter((r) => (incluirInativos ? true : r.ativo !== false))
    .filter((r) => (pasta ? pastaContem(pasta, normalizarPasta(r.pasta)) : true))
    .filter((r) => casaBusca({ nome: r.nome, pasta: r.pasta, fluxo: r.fluxo }, q, escopo))
    .map((r) => {
      const no = porSlug.get(r.slug);
      return {
        ...resumoLinha(r),
        chama: no?.chama.length ?? 0,
        chamado_por: no?.chamado_por.length ?? 0,
      };
    });

  return NextResponse.json(
    {
      fluxos,
      total: leitura.linhas.length,
      pastas: [...new Set(leitura.linhas.map((r) => normalizarPasta(r.pasta)).filter(Boolean))],
      pastas_disponiveis: leitura.pastas,
      truncado: leitura.truncado,
    },
    { headers: semCache }
  );
}

// ------------------------------------------------------------------ POST
export async function POST(req: NextRequest) {
  const p = await porteiro(req);
  if ("erro" in p) return p.erro;
  const { user } = p;

  const body = await req.json().catch(() => ({} as any));
  const acao = typeof body?.acao === "string" ? body.acao : "";

  const carimbo = () => ({
    atualizada_em: new Date().toISOString(),
    // quem alterou por ultimo — criterio de aceite da edicao rapida
    atualizado_por_id: user.id,
    atualizado_por_nome: user.nome,
  });

  // Grava tolerando a 0015 ausente: sem as colunas novas, grava o resto (o
  // fluxo NAO pode deixar de ser salvo porque falta a coluna de organizacao).
  //
  // `esperado` = valor de `atualizada_em` que o cliente leu. Com ele o UPDATE
  // vira condicional e `linhas: 0` significa "outro alguem gravou no meio" — o
  // `select()` e o que faz o supabase-js devolver as linhas afetadas (sem ele
  // nao ha como distinguir "gravou" de "nao casou a condicao").
  async function gravar(
    slug: string,
    campos: Record<string, unknown>,
    criar = false,
    esperado: string | null = null
  ): Promise<{ linhas: number; error: unknown }> {
    const tentar = async (c: Record<string, unknown>) => {
      if (criar) return await msgDb().from("fluxos").insert({ slug, ...c }).select("slug");
      let q = msgDb().from("fluxos").update(c).eq("slug", slug);
      if (esperado) q = q.eq("atualizada_em", esperado);
      return await q.select("slug");
    };

    let r = await tentar(semColunasNovas() ? semNovas(campos) : campos);
    if (r.error && (r.error as any).code === COL_INEXISTENTE) {
      marcaSemColunas = Date.now();
      r = await tentar(semNovas(campos));
    }
    return { linhas: r.data?.length ?? 0, error: r.error };
  }
  function semNovas(campos: Record<string, unknown>) {
    const { pasta, atualizado_por_id, atualizado_por_nome, ...resto } = campos as any;
    return resto;
  }

  // ---------------------------------------------------------- mover pasta
  // Renomear/mover uma pasta inteira: reescreve o caminho de cada fluxo da
  // subarvore. Nao toca no jsonb de ninguem — por isso nao muda comportamento
  // nem quebra quem chama (criterio de aceite do card 86ak85a5e).
  if (acao === "mover_pasta") {
    const de = normalizarPasta(body?.de);
    const para = normalizarPasta(body?.para);
    if (!de) return NextResponse.json({ error: "pasta de origem obrigatoria" }, { status: 400 });
    if (de === para) return NextResponse.json({ movidos: 0, aviso: "origem e destino iguais" });
    if (pastaContem(de, para) && para) {
      return NextResponse.json(
        { error: "nao da pra mover uma pasta pra dentro dela mesma" },
        { status: 400 }
      );
    }
    const leitura = await lerFluxos({ limite: LIMITE_VARREDURA });
    if (!leitura.ok) return NextResponse.json({ error: leitura.aviso }, { status: 503 });
    if (!leitura.pastas) {
      return NextResponse.json(
        { error: "organizacao em pastas indisponivel (migration 0015 nao aplicada)" },
        { status: 503 }
      );
    }
    const alvos = leitura.linhas.filter((r) => pastaContem(de, normalizarPasta(r.pasta)));
    let movidos = 0;
    for (const r of alvos) {
      const nova = moverPasta(normalizarPasta(r.pasta), de, para);
      if (nova === normalizarPasta(r.pasta)) continue;
      const { error } = await gravar(r.slug, { pasta: nova, ...carimbo() });
      if (!error) movidos++;
    }
    return NextResponse.json({ movidos, de, para });
  }

  // ------------------------------------------------------------- duplicar
  if (acao === "duplicar") {
    const origem = body?.slug;
    if (!slugValido(origem)) return NextResponse.json({ error: "slug invalido" }, { status: 400 });
    const leitura = await lerFluxos({ limite: LIMITE_VARREDURA });
    if (!leitura.ok) return NextResponse.json({ error: leitura.aviso }, { status: 503 });
    const row = leitura.linhas.find((r) => r.slug === origem);
    if (!row) return NextResponse.json({ error: "fluxo nao encontrado" }, { status: 404 });

    // TITULO PREFIXADO, e o nome fica LIVRE entre os que ja existem (criterio de
    // aceite do card 86ak86jw9). Antes era `${nome} (copia)`, o que dava duas
    // linhas com o MESMO texto ao duplicar duas vezes — e numa lista de centenas
    // de fluxos, duas linhas iguais e o mesmo que nenhuma pista.
    const nome =
      typeof body?.nome === "string" && body.nome.trim()
        ? body.nome.trim()
        : nomeDeCopia(row.nome, leitura.linhas.map((r) => r.nome));
    const novoSlug = slugLivre(nome, leitura.linhas.map((r) => r.slug));
    // o id DENTRO do jsonb acompanha o slug: os dois sao a identidade do fluxo
    // e ficariam divergentes na copia (e o `origem` do original NAO e herdado —
    // a copia nao veio de importacao nenhuma, e dizer que veio seria mentira
    // na rastreabilidade).
    const bruto = aplicarPatchNoFluxo(row.fluxo, { nome });
    delete bruto.origem;
    bruto.id = novoSlug;
    const v = validarFluxo(bruto);
    if (!v.ok) {
      return NextResponse.json(
        { error: "o fluxo de origem esta fora do formato canonico e nao pode ser duplicado", erros: v.erros.slice(0, 5) },
        { status: 422 }
      );
    }
    const { error } = await gravar(
      novoSlug,
      {
        nome: v.fluxo.nome,
        tipo: v.fluxo.tipo,
        // COPIA NASCE DESLIGADA de proposito: duplicar pra experimentar e o uso
        // normal, e uma copia ativa passa a existir na operacao sem ninguem ter
        // decidido isso. Ligar e um clique.
        ativo: false,
        fluxo: v.fluxo,
        pasta: normalizarPasta(body?.pasta ?? row.pasta),
        criado_por_id: user.id,
        criado_por_nome: user.nome,
        ...carimbo(),
      },
      true
    );
    if (error) return NextResponse.json({ error: "nao foi possivel duplicar" }, { status: 503 });
    return NextResponse.json({ slug: novoSlug, nome: v.fluxo.nome, ativo: false }, { status: 201 });
  }

  // ------------------------------------------------ edicao rapida POR ACAO
  //
  // Card 86ak85nzy: ligar/desligar UMA acao, mudar o atraso e o tempo de espera,
  // marcar "exige aprovacao" — tudo sem abrir o editor. A regra e PURA
  // (`aplicarPatchNoPasso`) e o resultado passa pelo MESMO `validarFluxo` do save
  // do editor: nao existe caminho que grave fluxo invalido.
  if (acao === "passo") {
    const slug = body?.slug;
    if (!slugValido(slug)) return NextResponse.json({ error: "slug invalido" }, { status: 400 });
    const esperado = typeof body?.atualizada_em === "string" ? body.atualizada_em : null;
    if (!esperado) {
      return NextResponse.json(
        { error: "atualizada_em obrigatorio (mande o valor que voce leu, pra detectar edicao concorrente)" },
        { status: 400 }
      );
    }
    const leitura = await lerFluxos({ limite: LIMITE_VARREDURA });
    if (!leitura.ok) return NextResponse.json({ error: leitura.aviso }, { status: 503 });
    const row = leitura.linhas.find((r) => r.slug === slug);
    if (!row) return NextResponse.json({ error: "fluxo nao encontrado" }, { status: 404 });

    const p = aplicarPatchNoPasso(row.fluxo, body?.no_id, {
      desligado: body?.desligado,
      aprovacao: body?.aprovacao,
      espera_segundos: body?.espera_segundos,
      atraso_segundos: body?.atraso_segundos,
    });
    if (!p.ok) return NextResponse.json({ error: p.erro }, { status: 400 });

    // o id do jsonb segue o slug, igual na edicao rapida do fluxo: jsonb com id
    // divergente do slug nao pode ser perpetuado por uma edicao de passo
    const v = validarFluxo({ ...p.fluxo, id: slug });
    if (!v.ok) return NextResponse.json({ error: "fluxo invalido", erros: v.erros }, { status: 422 });

    // o carimbo e capturado pra VOLTAR pra tela: o painel de passos faz varias
    // edicoes seguidas (desliga um, atrasa outro) e sem o `atualizada_em` novo a
    // segunda edicao levaria 409 por causa da primeira — a guarda de edicao
    // concorrente viraria estorvo em vez de protecao.
    const marca = carimbo();
    const { linhas: afetadas, error } = await gravar(
      slug,
      { nome: v.fluxo.nome, tipo: v.fluxo.tipo, fluxo: v.fluxo, ...marca },
      false,
      esperado
    );
    if (error) return NextResponse.json({ error: "nao foi possivel gravar" }, { status: 503 });
    if (afetadas === 0) {
      return NextResponse.json(
        {
          error: "alguem salvou antes de voce",
          detalhe: "Este fluxo foi alterado depois que voce abriu. Recarregue pra ver o que mudou antes de gravar de novo.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json({
      ok: true,
      slug,
      no_id: body?.no_id,
      mudou: p.mudou,
      passos_detalhe: passosDoFluxo(v.fluxo),
      // os DOIS numeros de aval, como no resto da rota: o campo gravado e o que
      // de fato para a cadeia (desligar o passo tira o aval de circulacao)
      aprovacao_nos: nosComAprovacao(v.fluxo),
      aval_que_bloqueia: nosComAvalQueImporta(v.fluxo),
      atualizada_em: marca.atualizada_em,
    });
  }

  // ---------------------------------------------------------------- criar
  if (acao === "criar") {
    const nome = typeof body?.nome === "string" ? body.nome.trim() : "";
    if (!nome) return NextResponse.json({ error: "nome obrigatorio" }, { status: 400 });
    const tipo = body?.tipo === "gatilho" ? "gatilho" : "macro";

    const leitura = await lerFluxos({ limite: LIMITE_VARREDURA });
    if (!leitura.ok) return NextResponse.json({ error: leitura.aviso }, { status: 503 });
    const novoSlug = slugLivre(nome, leitura.linhas.map((r) => r.slug));

    // O CASO MAJORITARIO medido no card: 127 dos 935 dialogos de origem sao um
    // unico passo
    // de resposta. Por isso `criar` aceita o texto da primeira mensagem e ja
    // devolve o fluxo pronto — sem passar pelo editor.
    const texto = typeof body?.texto === "string" ? body.texto.trim() : "";
    const bruto = body?.fluxo
      ? { ...(body.fluxo as any), id: novoSlug, nome, tipo }
      : texto
        ? fluxoLinear({ id: novoSlug, nome, tipo }, [{ tipo: "enviar_texto", texto }])
        : null;
    if (!bruto) {
      return NextResponse.json(
        { error: "informe o texto da primeira mensagem (ou um fluxo completo)" },
        { status: 400 }
      );
    }
    const v = validarFluxo(bruto);
    if (!v.ok) return NextResponse.json({ error: "fluxo invalido", erros: v.erros }, { status: 422 });

    const { error } = await gravar(
      novoSlug,
      {
        nome: v.fluxo.nome,
        tipo: v.fluxo.tipo,
        ativo: body?.ativo === true,
        fluxo: v.fluxo,
        pasta: normalizarPasta(body?.pasta),
        criado_por_id: user.id,
        criado_por_nome: user.nome,
        ...carimbo(),
      },
      true
    );
    if (error) return NextResponse.json({ error: "nao foi possivel criar o fluxo" }, { status: 503 });
    return NextResponse.json({ slug: novoSlug, nome: v.fluxo.nome }, { status: 201 });
  }

  // ------------------------------------------- salvar (editor) / rapida
  if (acao === "salvar" || acao === "rapida") {
    const slug = body?.slug;
    if (!slugValido(slug)) return NextResponse.json({ error: "slug invalido" }, { status: 400 });

    const leitura = await lerFluxos({ limite: LIMITE_VARREDURA });
    if (!leitura.ok) return NextResponse.json({ error: leitura.aviso }, { status: 503 });
    const row = leitura.linhas.find((r) => r.slug === slug);
    if (!row) return NextResponse.json({ error: "fluxo nao encontrado" }, { status: 404 });

    // EDICAO CONCORRENTE — o cliente manda de volta o `atualizada_em` que ele
    // leu, e a gravacao so acontece se a linha ainda estiver nesse estado.
    // Obrigatorio de proposito: opcional, um cliente que esquecesse de mandar
    // perderia a protecao em silencio, que e justamente o defeito a corrigir.
    const esperado = typeof body?.atualizada_em === "string" ? body.atualizada_em : null;
    if (!esperado) {
      return NextResponse.json(
        { error: "atualizada_em obrigatorio (mande o valor que voce leu, pra detectar edicao concorrente)" },
        { status: 400 }
      );
    }

    // SO COLUNA: ligar/desligar e mudar de pasta NAO tocam no jsonb, e por isso
    // nao passam por validarFluxo. Revalidar aqui tinha um efeito perverso: o
    // fluxo INVALIDO — exatamente o que mais precisa ser desligado — respondia
    // 422 e nao podia ser desligado pela tela. De quebra, reescrever
    // `campos.fluxo` num liga/desliga normalizava o jsonb sem ninguem pedir.
    const mexeNoJsonb = body?.nome !== undefined || body?.descricao !== undefined;
    const soColuna = acao === "rapida" && !mexeNoJsonb;

    const campos: Record<string, unknown> = { ...carimbo() };
    let nomeFinal = row.nome;

    if (soColuna) {
      if (body?.ativo === undefined && body?.pasta === undefined) {
        return NextResponse.json({ error: "nada pra editar" }, { status: 400 });
      }
    } else {
      const bruto =
        acao === "salvar"
          ? { ...(body?.fluxo as any), id: slug }
          : // a rapida tambem forca o id: se o jsonb tiver id divergente do
            // slug, editar pela listagem perpetuaria a divergencia
            { ...aplicarPatchNoFluxo(row.fluxo, { nome: body?.nome, descricao: body?.descricao }), id: slug };

      const v = validarFluxo(bruto);
      if (!v.ok) {
        // FLUXO INVALIDO NAO GRAVA — e a tela mostra os erros (nunca um "salvo"
        // que na verdade nao salvou)
        return NextResponse.json({ error: "fluxo invalido", erros: v.erros }, { status: 422 });
      }
      campos.nome = v.fluxo.nome;
      campos.tipo = v.fluxo.tipo;
      campos.fluxo = v.fluxo;
      nomeFinal = v.fluxo.nome;
    }

    if (body?.ativo !== undefined) campos.ativo = body.ativo === true;
    if (body?.pasta !== undefined) campos.pasta = normalizarPasta(body.pasta);

    const { linhas: afetadas, error } = await gravar(slug, campos, false, esperado);
    if (error) return NextResponse.json({ error: "nao foi possivel gravar" }, { status: 503 });
    if (afetadas === 0) {
      return NextResponse.json(
        {
          error: "alguem salvou antes de voce",
          detalhe: "Este fluxo foi alterado depois que voce abriu. Recarregue pra ver o que mudou antes de gravar de novo.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ slug, nome: nomeFinal, ok: true });
  }

  return NextResponse.json({ error: "acao desconhecida" }, { status: 400 });
}

// ---------------------------------------------------------------- DELETE
export async function DELETE(req: NextRequest) {
  const p = await porteiro(req);
  if ("erro" in p) return p.erro;

  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  if (!slugValido(slug)) return NextResponse.json({ error: "slug invalido" }, { status: 400 });
  if (url.searchParams.get("confirmar") !== "1") {
    return NextResponse.json({ error: "apagar exige confirmacao explicita" }, { status: 400 });
  }

  const leitura = await lerFluxos({ limite: LIMITE_VARREDURA });
  if (!leitura.ok) return NextResponse.json({ error: leitura.aviso }, { status: 503 });
  const row = leitura.linhas.find((r) => r.slug === slug);
  if (!row) return NextResponse.json({ error: "fluxo nao encontrado" }, { status: 404 });

  // FLUXO IMPORTADO NUNCA SOME SEM AVISO: ele veio de outra ferramenta e
  // reimportar custa caro (ou nao da mais, se a origem foi desligada).
  if (row.origem_ferramenta && url.searchParams.get("ciente_importado") !== "1") {
    return NextResponse.json(
      {
        error: "fluxo importado",
        detalhe: `Este fluxo veio de ${row.origem_ferramenta} e apagar nao desfaz. Confirme que esta ciente.`,
        origem: { ferramenta: row.origem_ferramenta, id_original: row.origem_id ?? null },
      },
      { status: 409 }
    );
  }

  // QUEM CHAMA ESTE FLUXO tem que aparecer ANTES do apagar: sem isso, apagar o
  // fluxo "Manter status resolvido" quebra em silencio os 69 lugares que o
  // chamam (medicao do card 86ak85a40).
  const g = montarGrafo(
    leitura.linhas.map((r) => ({
      slug: r.slug,
      nome: r.nome,
      pasta: normalizarPasta(r.pasta),
      ativo: r.ativo !== false,
      fluxo: r.fluxo,
    }))
  );
  const no = g.nos.find((n) => n.slug === slug);
  if (no?.chamado_por.length && url.searchParams.get("ciente_chamadas") !== "1") {
    return NextResponse.json(
      {
        error: "fluxo chamado por outros",
        detalhe: `${no.chamado_por.length} fluxo(s) chamam este. Apagar deixa essas chamadas sem destino.`,
        chamado_por: no.chamado_por.slice(0, 50),
      },
      { status: 409 }
    );
  }

  const { error } = await msgDb().from("fluxos").delete().eq("slug", slug);
  if (error) return NextResponse.json({ error: "nao foi possivel apagar" }, { status: 503 });
  // a trilha de execucao (fluxo_execucoes) NAO e apagada de proposito: ela e
  // referencia solta e guarda o que ja rodou pra cliente de verdade
  return NextResponse.json({ ok: true, slug });
}
