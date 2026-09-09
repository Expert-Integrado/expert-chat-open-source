// Publico da campanha — de onde sai a lista de quem vai receber.
//
// QUATRO origens (card 86ak85jdk):
//   1. csv       — planilha anexada (telefone + nome, colunas extras viram variaveis)
//   2. filtro    — a caixa de entrada, com os mesmos filtros que a pessoa ja usa
//   3. lista     — lista salva (mensageria.campanha_listas), reutilizavel
//   4. pipedrive — filtro salvo OU etapa do CRM (lib/disparo/pipedrive.ts)
//
// A 4a entrou em 31/08/2026 e ela cumpriu a promessa que a v1 deixou escrita
// aqui: "quando a integracao existir, ela entra como uma quarta origem neste
// mesmo lugar, sem mexer no resto". Foi o que aconteceu — as tres primeiras nao
// mudaram uma linha, e a nova cai no MESMO `consolidar` e no MESMO
// `tirarBloqueados`. Origem que ganha caminho proprio de validacao e a origem
// que um dia dispara pra numero invalido ou pra quem pediu descadastro.
//
// A credencial do CRM vem de env DA INSTALACAO (1 instalacao por cliente): sem
// env, a fonte fica invisivel. Ver o cabecalho de `lib/disparo/pipedrive.ts`.
//
// ESCOPO: o filtro da caixa de entrada respeita a visao do usuario. Quem so ve
// as proprias conversas nao monta publico com as dos outros — o predicado e o
// MESMO `conversaVisivel` das rotas de leitura, nao uma copia.

import { msgDb } from "@/lib/mensageria";
import { canalPorId } from "@/lib/canais";
import {
  contextoVisao,
  conversaVisivel,
  type Perfil,
  type Responsavel,
  type VisibilidadeEntry,
} from "@/lib/perfil";
import { vinculosBu, restricaoEfetiva } from "@/lib/embed";
import { restricaoEmLote } from "@/lib/acesso";
import type { UsuarioLogado } from "@/lib/auth-server";
import { chaveDedupe, normalizarTelefone, type DestinoValido } from "@/lib/disparo/telefone";
import { lerPublicoCsv, type ItemPublico, type LinhaRejeitada } from "@/lib/disparo/csv";

export type FiltroCaixa = {
  canal?: string;
  /** aberto | atendimento | aguardando | concluido */
  status?: string;
  arquivada?: boolean;
  /** conversa precisa ter TODAS estas etiquetas */
  etiquetas?: string[];
  /** id de usuario responsavel */
  responsavel_id?: string;
  /** conversa sem nenhum responsavel */
  sem_responsavel?: boolean;
  /** ultima mensagem a partir de / ate (ISO) */
  desde?: string;
  ate?: string;
  /** teto de conversas varridas (protege a rota) */
  limite?: number;
};

export type PublicoResolvido = {
  itens: ItemPublico[];
  invalidos: LinhaRejeitada[];
  duplicados: LinhaRejeitada[];
  /** de onde veio */
  origem: "csv" | "filtro" | "lista" | "pipedrive";
  /** o que a origem devolveu antes de validar/deduplicar */
  bruto: number;
  /** removidos por estarem na lista de bloqueio (opt-out) */
  bloqueados?: number;
  aviso?: string;
};

/**
 * Tira do publico quem esta na lista de bloqueio.
 *
 * Este e o PRIMEIRO dos dois pontos de checagem — o segundo e no envio, destino
 * a destino (lib/disparo/lote.ts). Os dois existem porque o publico pode ser
 * montado dias antes do disparo: quem pediu pra sair no meio nao pode receber so
 * porque ja estava na lista quando ela foi montada.
 */
export async function tirarBloqueados(p: PublicoResolvido): Promise<PublicoResolvido> {
  if (!p.itens.length) return p;
  const { bloqueadosEntre } = await import("@/lib/disparo/bloqueio");
  const { chaveDedupe, normalizarTelefone } = await import("@/lib/disparo/telefone");
  const bloqueadas = await bloqueadosEntre(p.itens.map((i) => i.chat_id));
  if (!bloqueadas.size) return p;

  const mantidos: ItemPublico[] = [];
  let removidos = 0;
  for (const i of p.itens) {
    const d = normalizarTelefone(i.chat_id);
    const chave = d.ok ? chaveDedupe(d as DestinoValido) : null;
    if (chave && bloqueadas.has(chave)) {
      removidos++;
      continue;
    }
    mantidos.push(i);
  }
  return {
    ...p,
    itens: mantidos,
    bloqueados: removidos,
    aviso: removidos
      ? `${removidos} contato(s) fora do publico por estarem na lista de bloqueio${p.aviso ? ` · ${p.aviso}` : ""}`
      : p.aviso,
  };
}

const TETO_PUBLICO = 5000;

/** Deduplica e valida uma lista crua de itens (usada por filtro e lista salva). */
export function consolidar(
  brutos: { telefone: unknown; nome?: string | null; variaveis?: Record<string, string> }[],
  origem: PublicoResolvido["origem"]
): PublicoResolvido {
  const itens: ItemPublico[] = [];
  const invalidos: LinhaRejeitada[] = [];
  const duplicados: LinhaRejeitada[] = [];
  const vistos = new Set<string>();

  brutos.forEach((b, i) => {
    const valor = String(b.telefone ?? "");
    const d = normalizarTelefone(b.telefone);
    if (!d.ok) {
      invalidos.push({ linha: i + 1, valor, motivo: d.motivo });
      return;
    }
    const chave = chaveDedupe(d as DestinoValido);
    if (vistos.has(chave)) {
      duplicados.push({ linha: i + 1, valor, motivo: "repetido no publico" });
      return;
    }
    vistos.add(chave);
    itens.push({
      chat_id: d.chat_id,
      telefone: d.telefone,
      nome: (b.nome || "").trim(),
      ...(b.variaveis && Object.keys(b.variaveis).length ? { variaveis: b.variaveis } : {}),
    });
  });

  return { itens, invalidos, duplicados, origem, bruto: brutos.length };
}

/** Origem 1: planilha CSV. */
export function publicoDoCsv(texto: string): PublicoResolvido {
  const p = lerPublicoCsv(texto);
  return {
    itens: p.itens.slice(0, TETO_PUBLICO),
    invalidos: p.invalidos,
    duplicados: p.duplicados,
    origem: "csv",
    bruto: p.total_linhas,
    ...(p.itens.length > TETO_PUBLICO
      ? { aviso: `a planilha tem ${p.itens.length} destinos validos; a v1 leva os primeiros ${TETO_PUBLICO}` }
      : {}),
  };
}

/**
 * Origem 2: filtro da caixa de entrada — RESPEITANDO o escopo do usuario.
 *
 * Le a tabela de conversas do canal, aplica os filtros no servidor (a listagem
 * do painel filtra no cliente sobre as 600 mais recentes; aqui nao daria: o
 * publico de uma campanha e justamente o que esta FORA dessa janela) e passa
 * cada conversa pelo mesmo `conversaVisivel` das rotas de leitura.
 */
export async function publicoDoFiltro(
  filtro: FiltroCaixa,
  user: UsuarioLogado,
  perfil: Perfil,
  req?: Request
): Promise<PublicoResolvido> {
  const canalId = filtro.canal || "central";
  const def = canalPorId(canalId);
  if (!def || !def.ativo) {
    return { itens: [], invalidos: [], duplicados: [], origem: "filtro", bruto: 0, aviso: "canal desconhecido ou inativo" };
  }
  if (def.tipo !== "whatsapp") {
    return {
      itens: [],
      invalidos: [],
      duplicados: [],
      origem: "filtro",
      bruto: 0,
      aviso: "disparo em massa e de WhatsApp: canal de outro tipo nao monta publico",
    };
  }

  const db = msgDb();
  const limite = Math.min(TETO_PUBLICO, Math.max(1, filtro.limite || TETO_PUBLICO));

  let q = db
    .from(def.tabelas.conversas)
    .select("chat_id,nome,is_group,status,arquivada,etiquetas,last_message_at")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(limite);

  if (filtro.status) q = q.eq("status", filtro.status);
  if (filtro.arquivada !== undefined) q = q.eq("arquivada", filtro.arquivada);
  if (filtro.desde) q = q.gte("last_message_at", filtro.desde);
  if (filtro.ate) q = q.lte("last_message_at", filtro.ate);
  if (filtro.etiquetas?.length) q = q.contains("etiquetas", filtro.etiquetas);

  const { data: conversas, error } = await q;
  if (error) {
    return { itens: [], invalidos: [], duplicados: [], origem: "filtro", bruto: 0, aviso: "falha ao ler as conversas" };
  }

  const ids = (conversas ?? []).map((c: any) => c.chat_id);
  if (!ids.length) return { itens: [], invalidos: [], duplicados: [], origem: "filtro", bruto: 0 };

  // responsaveis e ACL em lotes de 200 (mesmo padrao de /api/chats: o `in`
  // grande estoura a URL do PostgREST e o limit global truncava CALADO)
  const lotesResp = [];
  const lotesVis = [];
  for (let i = 0; i < ids.length; i += 200) {
    const fatia = ids.slice(i, i + 200);
    lotesResp.push(
      db.from("conversa_responsaveis").select("chat_id,tipo,ref_id").eq("canal", canalId).in("chat_id", fatia)
    );
    lotesVis.push(
      db.from("conversa_visibilidade").select("chat_id,tipo,ref_id").eq("canal", canalId).in("chat_id", fatia)
    );
  }
  const [respLotes, visLotes, vinculos, ctx, emb, restr] = await Promise.all([
    Promise.all(lotesResp),
    Promise.all(lotesVis),
    vinculosBu(user.id, perfil.papel === "super_admin"),
    contextoVisao(user, perfil),
    req ? restricaoEfetiva(req as any, user, perfil) : Promise.resolve(null),
    // RESTRICAO por funil/canal (Frente Q, card 86ak85zm4). Esta linha fecha a
    // divida que a frente Q declarou: sem ela, montar publico de campanha era a
    // porta que ignorava o recorte — e disparo em massa e o pior lugar pra isso,
    // porque a conversa fora do recorte nao seria apenas LIDA, seria escrita.
    // `null` = ninguem restringe, e o predicado age como antes.
    restricaoEmLote(
      user.id,
      perfil.papel === "super_admin",
      ids.map((chatId: string) => ({ canal: canalId, chatId }))
    ),
  ]);

  const respPorChat = new Map<string, Responsavel[]>();
  for (const r of respLotes.flatMap((x) => x.data ?? []) as any[]) {
    const l = respPorChat.get(r.chat_id) || [];
    l.push({ tipo: r.tipo, ref_id: r.ref_id });
    respPorChat.set(r.chat_id, l);
  }
  const visPorChat = new Map<string, VisibilidadeEntry[]>();
  for (const v of visLotes.flatMap((x) => x.data ?? []) as any[]) {
    const l = visPorChat.get(v.chat_id) || [];
    l.push({ tipo: v.tipo, ref_id: v.ref_id });
    visPorChat.set(v.chat_id, l);
  }

  const brutos: { telefone: unknown; nome?: string | null }[] = [];
  let foraDoEscopo = 0;
  for (const c of conversas as any[]) {
    const responsaveis = respPorChat.get(c.chat_id) || [];

    // filtros que dependem de responsavel (nao dava pra fazer no SELECT: N:N)
    if (filtro.sem_responsavel && responsaveis.length) continue;
    if (filtro.responsavel_id && !responsaveis.some((r) => r.tipo === "usuario" && r.ref_id === filtro.responsavel_id)) {
      continue;
    }

    // ESCOPO: o mesmo predicado das rotas de leitura, nao uma copia
    const visivel = conversaVisivel(
      responsaveis,
      user,
      perfil,
      ctx,
      c.status,
      visPorChat.get(c.chat_id) || [],
      vinculos,
      restr?.para(canalId, c.chat_id)
    );
    if (!visivel || (emb && emb !== "invalido" && !emb.permite(c.chat_id))) {
      foraDoEscopo++;
      continue;
    }
    brutos.push({ telefone: c.chat_id, nome: c.nome });
  }

  const r = consolidar(brutos, "filtro");
  r.bruto = (conversas ?? []).length;
  if (foraDoEscopo) {
    r.aviso = `${foraDoEscopo} conversa(s) do filtro ficaram de fora porque estao fora da sua visao`;
  }
  return r;
}

/**
 * Origem 4: filtro salvo ou etapa do Pipedrive.
 *
 * Import PREGUICOSO (mesmo padrao de `tirarBloqueados` e de `lib/modulos.ts`):
 * instalacao sem CRM nunca carrega o modulo, e o caminho quente das outras tres
 * origens nao paga nada por esta existir.
 *
 * DUAS RECUSAS DIFERENTES, de proposito:
 *  - **sem credencial** = a fonte NAO EXISTE nesta instalacao (`indisponivel`).
 *    Quem chama devolve 501 e a tela nem oferece o botao. Nao e erro do usuario.
 *  - **falha ao consultar** = a fonte existe e nao respondeu (`erro`). Aqui NAO
 *    se devolve publico vazio: publico vazio silencioso e o pior desfecho
 *    possivel — a pessoa remonta, ve zero e conclui que o filtro do CRM
 *    esvaziou, quando o que houve foi um token vencido.
 */
export async function publicoDoPipedrive(sel: unknown): Promise<
  PublicoResolvido & { indisponivel?: true; pedidoInvalido?: true; erro?: string }
> {
  const pd = await import("@/lib/disparo/pipedrive");
  const { portaPipedrive } = await import("@/lib/disparo/pipedrive-http");

  const selecao = pd_selecao(pd, sel);
  if (typeof selecao === "string") {
    // PEDIDO INVALIDO != CRM MUDO (achado da revisao cega): selecao torta e erro de
    // quem chamou, e sair como 502 ("o CRM nao respondeu") manda a pessoa conferir
    // token e status do Pipedrive por causa de um campo que faltou no proprio pedido.
    return { itens: [], invalidos: [], duplicados: [], origem: "pipedrive", bruto: 0, erro: selecao, pedidoInvalido: true };
  }

  const porta = portaPipedrive();
  if (!porta) {
    return {
      itens: [],
      invalidos: [],
      duplicados: [],
      origem: "pipedrive",
      bruto: 0,
      indisponivel: true,
      erro: "esta instalacao nao tem o Pipedrive configurado (env PIPEDRIVE_API_TOKEN)",
    };
  }

  let coleta;
  try {
    coleta = await pd.coletar(selecao, porta, TETO_PUBLICO);
  } catch (e) {
    return {
      itens: [],
      invalidos: [],
      duplicados: [],
      origem: "pipedrive",
      bruto: 0,
      erro: (e as Error)?.message || "falha ao consultar o Pipedrive",
    };
  }

  const r = consolidar(coleta.brutos, "pipedrive");
  r.bruto = coleta.lidos;
  const avisos = pd.avisosDaColeta(coleta);
  if (avisos.length) r.aviso = avisos.join(" · ");
  return r;
}

/**
 * Le a selecao vinda do corpo da rota. Conteudo de request, entao nada de
 * `Number(x)` solto: id nao-inteiro viraria `NaN` na query e o CRM devolveria
 * outra coisa (ou a conta inteira). Devolve a string do erro quando recusa.
 */
function pd_selecao(
  pd: typeof import("@/lib/disparo/pipedrive"),
  sel: unknown
): import("@/lib/disparo/pipedrive").SelecaoPublico | string {
  const o = (sel && typeof sel === "object" ? sel : {}) as Record<string, unknown>;
  const inteiro = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
    if (typeof v === "string" && /^\d{1,12}$/.test(v.trim())) {
      const n = Number(v.trim());
      return n > 0 ? n : null;
    }
    return null;
  };

  if (o.etapa_id !== undefined) {
    const id = inteiro(o.etapa_id);
    if (id === null) return "etapa_id invalido";
    const st = o.status;
    const status =
      st === "open" || st === "won" || st === "lost" || st === "todos" ? st : pd.STATUS_ETAPA_PADRAO;
    return { tipo: "etapa", etapa_id: id, status };
  }

  const id = inteiro(o.filtro_id);
  if (id === null) return "informe filtro_id (filtro salvo) ou etapa_id";
  const tipo = o.filtro_tipo;
  if (tipo !== "people" && tipo !== "deals") {
    // o TIPO decide qual endpoint responde (persons x deals) e nao da pra
    // adivinhar: chutar "people" num filtro de negocios devolveria a lista
    // errada com HTTP 200
    return "filtro_tipo obrigatorio (people ou deals) — a tela manda o tipo junto do id";
  }
  return { tipo: "filtro", filtro_id: id, filtro_tipo: tipo };
}

/** Origem 3: lista salva. */
export async function publicoDaLista(listaId: string): Promise<PublicoResolvido> {
  const { data, error } = await msgDb()
    .from("campanha_listas")
    .select("id,nome,itens")
    .eq("id", listaId)
    .maybeSingle();
  if (error || !data) {
    return { itens: [], invalidos: [], duplicados: [], origem: "lista", bruto: 0, aviso: "lista nao encontrada" };
  }
  const itens = Array.isArray((data as any).itens) ? (data as any).itens : [];
  return consolidar(
    itens.map((i: any) => ({ telefone: i.chat_id || i.telefone, nome: i.nome, variaveis: i.variaveis })),
    "lista"
  );
}
