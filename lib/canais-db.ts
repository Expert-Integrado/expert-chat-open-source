import { msgDb } from "@/lib/mensageria";
import { erroDeSchemaAusente } from "@/lib/acesso";
import {
  ehTransicao,
  mascararInstancia,
  normalizarNumero,
  type EventoCanal,
  type TrocaPendente,
} from "@/lib/canal-conexao";
import { decidirSincronizacao, statusDoBanco, type TemplateCanal } from "@/lib/templates-oficial";

// Camada de BANCO do estado do canal, da trilha e do catalogo de templates
// (Frente U, 31/08/2026 — cards 86ak858mx, 86ak858nx, 86ak858pa).
//
// A REGRA PURA mora em lib/canal-conexao.ts e lib/templates-oficial.ts. Aqui so
// tem leitura, gravacao e DEGRADACAO — e a degradacao e a parte que importa.
//
// AS TRES TABELAS SAO GESTO HUMANO (migration 0023, rodada no SQL Editor).
// Codigo nao cria tabela. Enquanto ela nao rodar, cada leitura devolve
// `disponivel:false` + `aviso` e cada gravacao devolve o mesmo aviso em vez de
// estourar — o padrao que a Frente Q deixou escrito em lib/acesso.ts, e que a
// tela ja sabe mostrar.
//
// A POLITICA DE FALHA, e por que ela e DIFERENTE por operacao:
//
//   TABELA AUSENTE (`erroDeSchemaAusente`, a mesma deteccao de duas camadas da
//   0019: codigo do PostgREST + a frase "schema cache") = a funcionalidade nao
//   existe nesta instalacao. Conectar por QR SEGUE FUNCIONANDO (fala com o
//   provedor, nao com o banco); troca de numero e catalogo de template ficam
//   desligados, com aviso.
//
//   ERRO DE LEITURA DE VERDADE (banco fora, permissao, timeout) na TROCA =
//   `disponivel:false` tambem, e a rota NAO conclui troca nenhuma. Concluir troca
//   sem conseguir ler a pendencia gravaria numero por adivinhacao — o oposto do
//   que a pendencia existe pra evitar.
//
//   ERRO NA TRILHA = melhor-esforco, SEMPRE. `registrarEvento` nunca estoura e
//   nunca derruba a operacao que acabou de dar certo: perder uma linha de
//   historico e ruim, deixar o canal em estado meio-trocado porque o insert da
//   trilha falhou e pior.

export type { EventoCanal, TrocaPendente };

const AVISO_SEM_TABELA =
  "a migration 0023 (conexao e templates de canal) ainda nao rodou nesta instalacao — " +
  "troca de numero e catalogo de templates ficam desligados ate rodar";

function semTabela(erro: any): boolean {
  return erroDeSchemaAusente(erro);
}

// ————————————————————————————————————————————— a pendencia de troca
/**
 * Le o jsonb da pendencia com desconfianca: OU tem tudo, OU nao tem pendencia.
 *
 * "Meia pendencia" e o estado que conclui troca no escuro — se `numero_novo` nao
 * for um numero de verdade, `vereditoDaTroca` nao teria contra o que comparar. Na
 * duvida, canal SEM troca em andamento (e o administrador abre outra, que custa
 * dois cliques).
 */
export function lerTrocaPendente(bruto: unknown): TrocaPendente | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const b = bruto as Record<string, unknown>;
  const novo = normalizarNumero(b.numero_novo);
  if (!novo) return null;
  return {
    numero_novo: novo,
    numero_anterior: normalizarNumero(b.numero_anterior) ?? "",
    iniciada_em: typeof b.iniciada_em === "string" ? b.iniciada_em : new Date().toISOString(),
    iniciada_por: typeof b.iniciada_por === "string" ? b.iniciada_por : "",
    iniciada_por_nome: typeof b.iniciada_por_nome === "string" ? b.iniciada_por_nome.slice(0, 120) : "",
  };
}

// —————————————————————————————————————————————————— estado do canal
export type EstadoCanalDb = {
  disponivel: boolean;
  aviso: string;
  numero: string | null;
  numero_em: string | null;
  instancia_marca: string | null;
  troca: TrocaPendente | null;
};

const VAZIO: EstadoCanalDb = {
  disponivel: true,
  aviso: "",
  numero: null,
  numero_em: null,
  instancia_marca: null,
  troca: null,
};

export async function estadoDoCanal(canal: string): Promise<EstadoCanalDb> {
  const { data, error } = await msgDb()
    .from("canal_estado")
    .select("numero,numero_em,instancia_marca,troca_pendente")
    .eq("canal", canal)
    .maybeSingle();
  if (error) {
    if (semTabela(error)) return { ...VAZIO, disponivel: false, aviso: AVISO_SEM_TABELA };
    console.error("canais-db/estado:", error.message);
    return {
      ...VAZIO,
      disponivel: false,
      aviso: "nao consegui ler o estado deste canal agora — tente de novo em 1 minuto",
    };
  }
  if (!data) return { ...VAZIO };
  return {
    disponivel: true,
    aviso: "",
    numero: normalizarNumero((data as any).numero),
    numero_em: (data as any).numero_em ?? null,
    instancia_marca: (data as any).instancia_marca ?? null,
    troca: lerTrocaPendente((data as any).troca_pendente),
  };
}

/**
 * Carimba o numero CONFERIDO no provedor (e a marca da instancia, quando dela).
 * `troca` explicito como `null` fecha a pendencia; omitir NAO mexe nela — a
 * mesma semantica de PATCH por dimensao que `mesclarEscopo` fixou na Frente Q.
 */
export async function gravarNumero(
  canal: string,
  numero: string | null,
  opts: { instancia?: string; fecharTroca?: boolean } = {}
): Promise<{ ok: boolean; aviso: string }> {
  const linha: Record<string, unknown> = {
    canal,
    numero: normalizarNumero(numero),
    numero_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  };
  if (opts.instancia !== undefined) linha.instancia_marca = mascararInstancia(opts.instancia);
  if (opts.fecharTroca) linha.troca_pendente = null;
  const { error } = await msgDb().from("canal_estado").upsert(linha, { onConflict: "canal" });
  if (error) {
    if (semTabela(error)) return { ok: false, aviso: AVISO_SEM_TABELA };
    console.error("canais-db/gravar-numero:", error.message);
    return { ok: false, aviso: "nao consegui gravar o numero deste canal agora" };
  }
  return { ok: true, aviso: "" };
}

/**
 * CONCLUI a troca: grava o numero e fecha a pendencia — mas SO se ela ainda
 * estiver aberta.
 *
 * A GUARDA DE CONCORRENCIA (achado de revisao): o polling de estado roda em cada
 * aba aberta, e duas abas veem o chip novo conectado no mesmo segundo. Com um
 * upsert cego, as duas concluiam: duas linhas `troca_concluida` na trilha, e a
 * segunda com `de` = o numero NOVO (porque a primeira ja tinha reescrito o
 * estado), o que faz a trilha contar uma troca que nunca houve — "passou de
 * 9888-7777 para 9888-7777". A guarda e `troca_pendente is not null` no proprio
 * UPDATE, e quem ganha e quem chegou primeiro; a outra recebe `concluiu: false` e
 * nao escreve trilha nenhuma.
 *
 * E um UPDATE, nao upsert, de proposito: se nao existe linha, nao existe troca
 * pendente, e nao ha o que concluir.
 */
export async function concluirTroca(
  canal: string,
  numero: string,
  instancia: string
): Promise<{ concluiu: boolean; aviso: string }> {
  const { data, error } = await msgDb()
    .from("canal_estado")
    .update({
      numero: normalizarNumero(numero),
      numero_em: new Date().toISOString(),
      instancia_marca: mascararInstancia(instancia),
      troca_pendente: null,
      atualizado_em: new Date().toISOString(),
    })
    .eq("canal", canal)
    .not("troca_pendente", "is", null)
    .select("canal");
  if (error) {
    if (semTabela(error)) return { concluiu: false, aviso: AVISO_SEM_TABELA };
    console.error("canais-db/concluir-troca:", error.message);
    return { concluiu: false, aviso: "nao consegui concluir a troca agora — ela segue pendente" };
  }
  // zero linhas = outra aba (ou outra instancia do servidor) concluiu primeiro
  return { concluiu: (data ?? []).length > 0, aviso: "" };
}

export async function gravarTroca(
  canal: string,
  troca: TrocaPendente | null
): Promise<{ ok: boolean; aviso: string }> {
  const { error } = await msgDb()
    .from("canal_estado")
    .upsert(
      { canal, troca_pendente: troca, atualizado_em: new Date().toISOString() },
      { onConflict: "canal" }
    );
  if (error) {
    if (semTabela(error)) return { ok: false, aviso: AVISO_SEM_TABELA };
    console.error("canais-db/gravar-troca:", error.message);
    return { ok: false, aviso: "nao consegui gravar a troca deste canal agora" };
  }
  return { ok: true, aviso: "" };
}

// ————————————————————————————————————————————————————————— a trilha
/** Melhor-esforco por contrato: NUNCA estoura, NUNCA derruba quem chamou. */
export async function registrarEvento(canal: string, ev: EventoCanal): Promise<void> {
  try {
    const { error } = await msgDb()
      .from("canal_eventos")
      .insert({
        canal,
        tipo: String(ev.tipo).slice(0, 40),
        de: normalizarNumero(ev.de) ?? null,
        para: normalizarNumero(ev.para) ?? null,
        autor_id: ev.autor_id || null,
        autor_nome: ev.autor_nome ? String(ev.autor_nome).slice(0, 120) : null,
        detalhe: ev.detalhe ?? {},
      });
    if (error && !semTabela(error)) console.error("canais-db/evento:", error.message);
  } catch (e: any) {
    console.error("canais-db/evento:", e?.message || e);
  }
}

/**
 * O tipo do ULTIMO evento do canal — pra gravar so na TRANSICAO.
 *
 * POR QUE ISSO EXISTE (achado de revisao cega, medido): `troca_divergente` era
 * gravado a cada rodada do polling de estado. Com o modal aberto (3,5s) isso da
 * ~1.028 linhas por hora de UM chip errado plugado — a trilha do canal, que e o
 * lugar onde alguem vai procurar "de qual numero pra qual", afoga em repeticao e
 * o historico util vira agulha em palheiro. Divergencia e ESTADO, nao evento; o
 * que interessa registrar e o momento em que ela comecou.
 *
 * `null` = nao deu pra ler (tabela ausente ou erro). Quem chama trata como "nao
 * sei", e NAO grava — na duvida, perder uma linha de trilha e melhor que voltar a
 * inundar.
 */
export type UltimoEvento = { tipo: string; de: string | null };

export async function ultimoEventoDoCanal(canal: string): Promise<UltimoEvento | null> {
  // O `de` VEM JUNTO, e nao e detalhe (achado da 2a revisao): no
  // `troca_divergente` o `de` E o chip errado que apareceu. Comparando so o tipo,
  // dois chips errados DIFERENTES na mesma troca geravam UMA linha — a trilha
  // dizia que o segundo aparelho nunca existiu, e e exatamente essa a pergunta que
  // alguem faz quando a troca da errado ("quantos numeros tentaram entrar aqui?").
  const { data, error } = await msgDb()
    .from("canal_eventos")
    .select("tipo,de")
    .eq("canal", canal)
    .order("criada_em", { ascending: false })
    .limit(1);
  if (error) {
    if (!semTabela(error)) console.error("canais-db/ultimo-evento:", error.message);
    return null;
  }
  const t = (data ?? [])[0] as any;
  // sem evento nenhum: tipo vazio (nao e "nao sei ler", e "nao tem")
  return { tipo: t?.tipo ? String(t.tipo) : "", de: t?.de ? String(t.de) : null };
}

/**
 * Registra o evento SO se ele nao for repeticao do ultimo — "transicao", nao "estado".
 *
 * Usado pelos eventos que o polling reavalia toda rodada (`troca_divergente`).
 * Evento de ACAO humana (troca_iniciada, desconectado, codigo_pedido) NAO passa
 * por aqui: dois cliques sao dois fatos, e engolir o segundo esconderia o que a
 * pessoa fez.
 */
export async function registrarTransicao(canal: string, ev: EventoCanal): Promise<boolean> {
  const ultimo = await ultimoEventoDoCanal(canal);
  // A DECISAO e PURA (`ehTransicao`, em lib/canal-conexao.ts) — comparacao de
  // `tipo` + `de`, e o "nao deu pra ler = nao grava". Ela saiu daqui porque, dentro
  // desta funcao (que fala com o banco), nenhuma prova a alcancava: a revisao
  // mediu que "gravar SEMPRE" passava a bateria verde.
  if (!ehTransicao(ultimo, ev)) return false;
  await registrarEvento(canal, ev);
  return true;
}

export async function historicoDoCanal(
  canal: string,
  limite = 30
): Promise<{ disponivel: boolean; lista: EventoCanal[] }> {
  const { data, error } = await msgDb()
    .from("canal_eventos")
    .select("tipo,de,para,autor_nome,criada_em,detalhe")
    .eq("canal", canal)
    .order("criada_em", { ascending: false })
    .limit(Math.min(Math.max(limite, 1), 200));
  if (error) {
    if (!semTabela(error)) console.error("canais-db/historico:", error.message);
    return { disponivel: false, lista: [] };
  }
  return { disponivel: true, lista: (data ?? []) as EventoCanal[] };
}

// ——————————————————————————————————————————— catalogo de templates
export type CatalogoTemplates = {
  disponivel: boolean;
  aviso: string;
  lista: TemplateCanal[];
  sincronizado_em: string | null;
};

function linhaParaTemplate(r: any): TemplateCanal {
  return {
    provider_id: String(r.provider_id ?? ""),
    nome: String(r.nome ?? ""),
    idioma: String(r.idioma ?? "pt_BR"),
    categoria: String(r.categoria ?? ""),
    // a linha do banco JA esta no vocabulario do painel; o saneador aqui e o de
    // saida (`statusDoBanco`), nao o de entrada (`statusCanonico`, que le o cru
    // da Meta). Linha gravada a mao com status fora da lista cai em
    // `desconhecido`, que nao envia.
    status: statusDoBanco(r.status),
    corpo: String(r.corpo ?? ""),
    exemplo: String(r.exemplo ?? ""),
    variaveis: Number(r.variaveis ?? 0) || 0,
    rodape: String(r.rodape ?? ""),
    cabecalho: String(r.cabecalho ?? ""),
    midia_url: String(r.midia_url ?? ""),
    motivo: String(r.motivo ?? ""),
  };
}

export async function templatesDoCanal(canal: string): Promise<CatalogoTemplates> {
  const { data, error } = await msgDb()
    .from("canal_templates")
    .select(
      "provider_id,nome,idioma,categoria,status,corpo,exemplo,rodape,cabecalho,midia_url,variaveis,motivo,sincronizado_em"
    )
    .eq("canal", canal)
    .order("nome", { ascending: true });
  if (error) {
    if (semTabela(error)) {
      return { disponivel: false, aviso: AVISO_SEM_TABELA, lista: [], sincronizado_em: null };
    }
    console.error("canais-db/templates:", error.message);
    return {
      disponivel: false,
      aviso: "nao consegui ler o catalogo de templates agora",
      lista: [],
      sincronizado_em: null,
    };
  }
  const linhas = data ?? [];
  // a idade do espelho e a do registro MAIS VELHO: se um template ficou pra tras
  // na ultima sincronizacao, o catalogo inteiro e velho, e dizer o contrario
  // seria o mesmo defeito do QR expirado sem aviso.
  let maisVelho: string | null = null;
  for (const r of linhas as any[]) {
    const s = r.sincronizado_em ? String(r.sincronizado_em) : null;
    if (!s) continue;
    if (!maisVelho || s < maisVelho) maisVelho = s;
  }
  return {
    disponivel: true,
    aviso: "",
    lista: (linhas as any[]).map(linhaParaTemplate),
    sincronizado_em: maisVelho,
  };
}

/** UM template do catalogo do canal. `null` = nao esta no espelho (nao envia). */
export async function templateDoCanal(
  canal: string,
  nome: string,
  idioma?: string
): Promise<{ disponivel: boolean; aviso: string; template: TemplateCanal | null }> {
  let q = msgDb()
    .from("canal_templates")
    .select(
      "provider_id,nome,idioma,categoria,status,corpo,exemplo,rodape,cabecalho,midia_url,variaveis,motivo"
    )
    .eq("canal", canal)
    .eq("nome", nome);
  if (idioma) q = q.eq("idioma", idioma);
  const { data, error } = await q.limit(1);
  if (error) {
    if (semTabela(error)) return { disponivel: false, aviso: AVISO_SEM_TABELA, template: null };
    console.error("canais-db/template:", error.message);
    return { disponivel: false, aviso: "nao consegui ler o catalogo de templates agora", template: null };
  }
  const r = (data ?? [])[0];
  return { disponivel: true, aviso: "", template: r ? linhaParaTemplate(r) : null };
}

/**
 * Substitui o espelho do canal pelo que o provedor acabou de devolver.
 *
 * DUAS decisoes, as duas medidas em cima do que o espelho existe pra fazer:
 *
 *   TEMPLATE QUE SUMIU DO PROVEDOR SAI DO ESPELHO. Se alguem apagou o template no
 *   console do Gupshup, manter a linha aqui e guardar uma autorizacao de envio que
 *   nao existe mais — e o envio falharia no provedor, depois de o painel dizer que
 *   podia. A limpeza e por NOME+IDIOMA dos que voltaram, dentro do canal.
 *
 *   LISTA VAZIA NAO APAGA NADA. Provedor que responde `[]` por soluco (conta nova
 *   ainda propagando, resposta em formato novo que o parser nao leu) esvaziaria o
 *   catalogo inteiro e derrubaria todo envio por template da instalacao. Nesse
 *   caso a sincronizacao devolve aviso e o espelho fica como estava — perder um
 *   template novo por uma rodada e barato; perder o catalogo nao e.
 */
export type ResultadoSync = {
  ok: boolean;
  aviso: string;
  gravados: number;
  removidos: number;
  /**
   * POR QUE A FALHA TEM TIPO (achado de revisao): as duas maneiras de esta funcao
   * nao gravar sao coisas diferentes pro chamador.
   *
   *   `decisao` — o provedor respondeu algo que nao serve pra sobrescrever o
   *   espelho (lista vazia, nomes fora do formato). Nao houve erro: houve um
   *   resultado. A rota responde 200 com aviso, e o espelho fica como estava.
   *
   *   `escrita` — nao deu pra gravar (migration ausente, banco fora, permissao).
   *   Isso e FALHA DE INFRA, e responder 200 {ok:false} faz a tela mostrar um
   *   aviso amarelo pra algo que merece 503: quem chamou por script ou curl leria
   *   200 e concluiria que sincronizou.
   */
  falha?: "decisao" | "escrita";
};

export async function salvarTemplates(canal: string, lista: TemplateCanal[]): Promise<ResultadoSync> {
  // A DECISAO e pura e provada (`decidirSincronizacao` em lib/templates-oficial.ts):
  // lista vazia nao apaga espelho, nome fora do formato e descartado sem derrubar
  // a rodada. Ela morava aqui dentro, fora do alcance de qualquer prova sem banco —
  // e e a decisao que define se um catalogo inteiro sobrevive a um soluco do
  // provedor.
  const decisao = decidirSincronizacao(lista);
  if (decisao.acao === "nada") {
    return { ok: false, aviso: decisao.aviso, gravados: 0, removidos: 0, falha: "decisao" };
  }
  const agora = new Date().toISOString();
  const linhas = decisao.lista
    .map((t) => ({
      canal,
      nome: t.nome,
      idioma: t.idioma || "pt_BR",
      provider_id: t.provider_id || null,
      categoria: t.categoria || null,
      status: t.status,
      corpo: t.corpo,
      exemplo: t.exemplo,
      rodape: t.rodape,
      cabecalho: t.cabecalho,
      midia_url: t.midia_url,
      variaveis: Math.min(Math.max(t.variaveis, 0), 50),
      motivo: t.motivo,
      sincronizado_em: agora,
    }));

  const db = msgDb();
  const { error } = await db.from("canal_templates").upsert(linhas, { onConflict: "canal,nome,idioma" });
  if (error) {
    if (semTabela(error)) {
      return { ok: false, aviso: AVISO_SEM_TABELA, gravados: 0, removidos: 0, falha: "escrita" };
    }
    console.error("canais-db/salvar-templates:", error.message);
    return {
      ok: false,
      aviso: "nao consegui gravar o catalogo de templates agora",
      gravados: 0,
      removidos: 0,
      falha: "escrita",
    };
  }

  // os que nao voltaram do provedor saem do espelho. `lt` no carimbo em vez de
  // `not in (nomes)`: a lista de nomes pode passar de mil numa conta grande, e
  // filtro gigante em querystring e o caminho pro 414 do PostgREST. Quem acabou
  // de ser gravado tem o carimbo DESTA rodada, entao "carimbo anterior" e
  // exatamente "nao veio agora".
  const { data: fora, error: erroFora } = await db
    .from("canal_templates")
    .delete()
    .eq("canal", canal)
    .lt("sincronizado_em", agora)
    .select("nome");
  if (erroFora && !semTabela(erroFora)) console.error("canais-db/limpar-templates:", erroFora.message);

  return {
    ok: true,
    // `descartados` sai no relato: template com nome estranho ser ignorado em
    // silencio faria alguem procurar pra sempre um template que o sync pulou
    aviso: decisao.descartados
      ? `${decisao.descartados} template(s) do provedor foram ignorados por ter nome fora do formato (minusculas, numeros e _)`
      : "",
    gravados: linhas.length,
    removidos: (fora ?? []).length,
  };
}

/** Tira UM template do espelho (depois de apagar no provedor). */
export async function removerTemplate(
  canal: string,
  nome: string,
  idioma?: string
): Promise<void> {
  try {
    let q = msgDb().from("canal_templates").delete().eq("canal", canal).eq("nome", nome);
    if (idioma) q = q.eq("idioma", idioma);
    const { error } = await q;
    if (error && !semTabela(error)) console.error("canais-db/remover-template:", error.message);
  } catch (e: any) {
    console.error("canais-db/remover-template:", e?.message || e);
  }
}

