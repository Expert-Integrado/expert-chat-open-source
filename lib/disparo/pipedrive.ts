// PUBLICO DO DISPARO A PARTIR DO PIPEDRIVE — a 4a origem (card 86ak85jdk).
//
// O card chama esta de "a mais valiosa e a menos obvia", e o motivo e de
// produto, nao tecnico: o publico e montado na ferramenta que quem vende ja
// domina (um filtro que ele mesmo salvou no CRM), e o painel so CONSOME. Ninguem
// reaprende a filtrar em duas telas diferentes.
//
// A INSTALACAO E 1-POR-CLIENTE (decisao-mae do CLAUDE.md): a credencial vem de
// env DA INSTALACAO, exatamente como os outros conectores do repo
// (`CENTRAL_ZAPI_*`, `GUPSHUP_*`, `IG_SUPABASE_*`, `CONEXA_*`). **Nada da Expert
// aqui** — nem token, nem id de filtro, nem id de etapa, nem nome de pipeline.
// Sem env configurada a fonte fica INVISIVEL (`fontePipedriveDisponivel()`
// false) em vez de aparecer como botao que da erro.
//
// ZERO IMPORT de proposito (mesma convencao de lib/disparo/telefone.ts,
// lib/permissoes.ts e lib/fluxo/schema.ts): a DECISAO e pura e roda em node
// solto — e o que `node scripts/prova-publico-pipedrive.ts` exercita, sem rede.
// A ida a rede entra por PORTA INJETADA (`PortaPipedrive`), entao a prova mede
// paginacao, teto, formato torto e resposta hostil sem chamar a API de ninguem.
//
// LEITURA, NUNCA ESCRITA. Montar publico e consulta: nenhuma funcao daqui faz
// POST/PUT/DELETE no CRM, e a prova reprova se um verbo de escrita aparecer.
// Quem manda mensagem e o motor do disparo, DEPOIS da aprovacao humana por
// campanha (lib/disparo/estado.ts) — esta origem nao burla esse portao.
//
// ————————————————————————————————————————————————————————————————————————
// O FORMATO ABAIXO FOI MEDIDO contra a API v1 em 31/08/2026, nao deduzido da
// documentacao (a pagina publica de Deals/Persons mostra o exemplo de resposta
// COLAPSADO, e o que ela documenta em detalhe e a v2, que tem outro nome de
// campo). O que a medicao devolveu:
//
//   GET /v1/filters
//     -> { success, data: [{ id, name, filter_code, is_editable, active_flag,
//          type, temporary_flag, user_id, add_time, update_time, visible_to,
//          last_used_time, custom_view_id }] }
//        tipos observados: deals, people, org, leads, projects, activity, products
//
//   GET /v1/persons?filter_id=<n>&start=<n>&limit=<n>
//     -> { success, data: [{ id, name, phone: [{label, value, primary}], ... }],
//          additional_data: { pagination: { start, limit,
//                             more_items_in_collection, next_start } } }
//
//   GET /v1/deals?filter_id=<n>&start=&limit=      (idem com stage_id=&status=)
//     -> { success, data: [{ id, title, stage_id, status, person_name,
//          person_id: { name, phone: [{label, value, primary}], ... } | null,
//          org_id: {...} | null, ... }], additional_data: { pagination: {...} } }
//
// O ACHADO QUE DECIDIU O DESENHO: o deal ja TRAZ o telefone do contato dentro de
// `person_id` (objeto, nao numero). Sem isso, publico por etapa custaria uma
// requisicao POR DEAL (`GET /persons/<id>`) — 3 mil deals viram 3 mil chamadas,
// que nao cabem no tempo de uma rota. Ainda assim o codigo aceita `person_id`
// vindo como NUMERO: nesse caso o contato NAO e resolvido e vira ressalva
// contada, nunca chute (a v2 devolve `person_id` numerico, e um dia a conta pode
// migrar).
//
// UNIDADE DE FUSO/PAGINACAO: `start`/`next_start` (v1), nao cursor. A v2 usa
// cursor; se a conta migrar, `paginaSeguinte` e o unico ponto a mexer.

// ————————————————————————————————————————————————————————————— credencial

/**
 * Token da instalacao. `PIPEDRIVE_API_TOKEN` e o nome novo (fala do produto);
 * `PIPEDRIVE_API_KEY` e o que a instalacao da Expert ja usa em
 * `/api/embed/sync` — aceitar os dois evita pedir DUAS envs pro mesmo segredo
 * na mesma instalacao. Nenhum valor default: sem env, sem fonte.
 */
export function credencialPipedrive(env?: Record<string, string | undefined>): string | null {
  const e = env ?? (typeof process !== "undefined" ? process.env : {});
  const t = (e.PIPEDRIVE_API_TOKEN || e.PIPEDRIVE_API_KEY || "").trim();
  return t ? t : null;
}

/** A fonte aparece na tela? Sem credencial ela nao aparece — nao aparece cinza. */
export function fontePipedriveDisponivel(env?: Record<string, string | undefined>): boolean {
  return credencialPipedrive(env) !== null;
}

/**
 * Base da API. Env `PIPEDRIVE_API_BASE` existe pra instalacao em dominio proprio
 * de empresa (`https://<empresa>.pipedrive.com/api/v1`) e pra prova. So https,
 * e valor torto cai no default em vez de derrubar a rota.
 */
export const BASE_PADRAO = "https://api.pipedrive.com/v1";

export function basePipedrive(env?: Record<string, string | undefined>): string {
  const e = env ?? (typeof process !== "undefined" ? process.env : {});
  const bruto = (e.PIPEDRIVE_API_BASE || "").trim();
  if (!bruto) return BASE_PADRAO;
  try {
    const u = new URL(bruto);
    if (u.protocol !== "https:") return BASE_PADRAO;
    if (u.username || u.password) return BASE_PADRAO;
    return bruto.replace(/\/+$/, "");
  } catch {
    return BASE_PADRAO;
  }
}

// ————————————————————————————————————————————————————————————————— tetos

/** Teto da API v1 por pagina. Pedir mais e ignorado do outro lado. */
export const LOTE = 500;
/** Trava contra paginacao presa (a resposta mentindo `more_items_in_collection`). */
export const MAX_PAGINAS = 40;
export const TIMEOUT_MS = 20_000;

/**
 * Mensagem do 429 com o tempo que o proprio Pipedrive pediu. PURA.
 *
 * O cabecalho vem em SEGUNDOS ou como data HTTP (as duas formas sao validas na
 * RFC 9110). Ausente ou ilegivel cai na frase generica, em vez de virar
 * "tente em NaN segundos".
 */
export function esperaDoLimite(retryApos: string | null): string {
  const base = "o Pipedrive limitou as consultas";
  const bruto = (retryApos || "").trim();
  if (!bruto) return `${base} (tente de novo em alguns minutos)`;
  const seg = Number(bruto);
  if (Number.isFinite(seg) && seg > 0) return `${base}: ele pediu ${Math.ceil(seg)}s de espera`;
  const quando = Date.parse(bruto);
  if (Number.isFinite(quando)) {
    const faltam = Math.max(0, Math.ceil((quando - Date.now()) / 1000));
    return `${base}: ele pediu espera de ${faltam}s`;
  }
  return `${base} (tente de novo em alguns minutos)`;
}

// ———————————————————————————————————————————————————————————————— filtros

/**
 * Tipos de filtro que rendem CONTATO COM TELEFONE, e so eles.
 *
 * `org` (a organizacao tem telefone da empresa, nao da pessoa), `activity`,
 * `products` e `projects` nao viram publico de WhatsApp. `leads` fica de FORA
 * declarado: `GET /v1/leads` nao aceita `filter_id` e o contato do lead e outro
 * objeto — entra quando alguem precisar, nao por simetria.
 *
 * O que NAO se faz aqui: esconder os outros em silencio. A resposta da rota
 * devolve a contagem por tipo ignorado, senao o dono do CRM procura na tela um
 * filtro que ele sabe que existe e conclui que o painel perdeu dado.
 */
export const TIPOS_APROVEITAVEIS = ["people", "deals"] as const;
export type TipoFiltro = (typeof TIPOS_APROVEITAVEIS)[number];

export type FiltroSalvo = {
  id: number;
  nome: string;
  tipo: TipoFiltro;
  /** ISO do ultimo uso no CRM, quando a API informa — ordena a lista pela tela */
  ultimo_uso: string | null;
};

export type CatalogoFiltros = {
  filtros: FiltroSalvo[];
  /** quantos filtros de cada tipo NAO aproveitavel existem (transparencia) */
  ignorados_por_tipo: Record<string, number>;
  /** filtros temporarios (recorte que a pessoa nao salvou) descartados */
  temporarios: number;
  /** filtros desativados no CRM descartados */
  inativos: number;
  truncado: boolean;
};

/** Teto de filtros devolvidos pra tela (a conta medida tinha 163). */
export const MAX_FILTROS = 300;

function ehTipoAproveitavel(v: unknown): v is TipoFiltro {
  return typeof v === "string" && (TIPOS_APROVEITAVEIS as readonly string[]).includes(v);
}

function textoLimpo(v: unknown, teto: number): string {
  return typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").trim().slice(0, teto) : "";
}

function inteiroPositivo(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string" && /^\d{1,12}$/.test(v.trim())) {
    const n = Number(v.trim());
    return n > 0 ? n : null;
  }
  return null;
}

/**
 * Normaliza a lista de `GET /filters`. PURA.
 *
 * `active_flag !== false` liga (a conta medida tinha 100% `true`; item sem o
 * campo nao pode desaparecer por ausencia de dado). `temporary_flag === true`
 * desliga — filtro temporario e o recorte que alguem montou na tela e nao
 * salvou; oferecer ele como publico salvo seria oferecer algo que muda sozinho.
 */
export function filtrosDaResposta(corpo: unknown): CatalogoFiltros {
  const ignorados: Record<string, number> = {};
  const filtros: FiltroSalvo[] = [];
  let temporarios = 0;
  let inativos = 0;

  const dados = (corpo as { data?: unknown } | null)?.data;
  const lista = Array.isArray(dados) ? dados : [];
  for (const item of lista) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const id = inteiroPositivo(o.id);
    if (id === null) continue;
    if (o.temporary_flag === true) {
      temporarios++;
      continue;
    }
    if (o.active_flag === false) {
      inativos++;
      continue;
    }
    if (!ehTipoAproveitavel(o.type)) {
      const t = typeof o.type === "string" && o.type ? o.type : "(sem tipo)";
      ignorados[t] = (ignorados[t] || 0) + 1;
      continue;
    }
    const nome = textoLimpo(o.name, 120);
    filtros.push({
      id,
      // nome de filtro e conteudo escrito por gente do CRM: vazio nao pode virar
      // linha em branco na tela
      nome: nome || `filtro ${id}`,
      tipo: o.type,
      ultimo_uso: typeof o.last_used_time === "string" && o.last_used_time ? o.last_used_time : null,
    });
  }

  // mais recentemente usado primeiro: e o filtro que a pessoa tem na cabeca.
  // Empate (e quem nunca foi usado) desempata por NOME, nunca pela ordem que a
  // API devolveu — lista que muda de ordem sozinha faz a pessoa clicar errado.
  filtros.sort((a, b) => {
    const ua = a.ultimo_uso || "";
    const ub = b.ultimo_uso || "";
    if (ua !== ub) return ua > ub ? -1 : 1;
    return a.nome.localeCompare(b.nome, "pt-BR");
  });

  return {
    filtros: filtros.slice(0, MAX_FILTROS),
    ignorados_por_tipo: ignorados,
    temporarios,
    inativos,
    truncado: filtros.length > MAX_FILTROS,
  };
}

// ————————————————————————————————————————————————————————————————— etapas

export type EtapaCrm = {
  id: number;
  nome: string;
  funil_id: number | null;
  funil_nome: string;
  ordem: number;
};

export const MAX_ETAPAS = 300;

/**
 * Normaliza `GET /stages`. PURA.
 *
 * O NOME DA ETAPA SE REPETE ENTRE FUNIS (a mesma licao de `lib/funis.ts` deste
 * repo, e a conta medida tinha 55 etapas). Por isso a etapa aqui viaja SEMPRE
 * com o funil ao lado, e o que identifica e o `id` — nunca o nome solto.
 */
export function etapasDaResposta(corpo: unknown): { etapas: EtapaCrm[]; truncado: boolean } {
  const dados = (corpo as { data?: unknown } | null)?.data;
  const lista = Array.isArray(dados) ? dados : [];
  const etapas: EtapaCrm[] = [];
  for (const item of lista) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const id = inteiroPositivo(o.id);
    if (id === null) continue;
    if (o.active_flag === false) continue;
    const nome = textoLimpo(o.name, 120);
    etapas.push({
      id,
      nome: nome || `etapa ${id}`,
      funil_id: inteiroPositivo(o.pipeline_id),
      funil_nome: textoLimpo(o.pipeline_name, 120),
      ordem: inteiroPositivo(o.order_nr) ?? 0,
    });
  }
  etapas.sort((a, b) => {
    const fa = a.funil_nome || String(a.funil_id ?? "");
    const fb = b.funil_nome || String(b.funil_id ?? "");
    if (fa !== fb) return fa.localeCompare(fb, "pt-BR");
    if (a.ordem !== b.ordem) return a.ordem - b.ordem;
    return a.nome.localeCompare(b.nome, "pt-BR");
  });
  return { etapas: etapas.slice(0, MAX_ETAPAS), truncado: etapas.length > MAX_ETAPAS };
}

// ———————————————————————————————————————————————————————— telefone e pessoa

export type TelefoneDaPessoa = { valor: string; label: string; primario: boolean };

/**
 * Todos os telefones de um objeto de pessoa, em ORDEM DE PREFERENCIA. PURA.
 *
 * A v1 chama o campo de `phone`, a v2 de `phones` — aceita os dois, porque a
 * conta pode migrar e ler o campo errado devolveria publico VAZIO em silencio,
 * que e indistinguivel de "o filtro nao tem ninguem".
 *
 * Ordem: primario primeiro; depois o rotulado WhatsApp (rotulo escrito por gente
 * do CRM, entao a comparacao ignora caixa e acento); depois a ordem de origem.
 * Estavel de proposito — mesma pessoa tem que dar sempre o mesmo destino, senao
 * remontar o publico troca o numero de quem recebe.
 */
export function telefonesDaPessoa(pessoa: unknown): TelefoneDaPessoa[] {
  if (!pessoa || typeof pessoa !== "object") return [];
  const o = pessoa as Record<string, unknown>;
  const cru = Array.isArray(o.phone) ? o.phone : Array.isArray(o.phones) ? o.phones : [];
  const out: TelefoneDaPessoa[] = [];
  cru.forEach((item) => {
    // a origem as vezes guarda a lista como strings soltas
    if (typeof item === "string" || typeof item === "number") {
      const v = String(item).trim();
      if (v) out.push({ valor: v, label: "", primario: false });
      return;
    }
    if (!item || typeof item !== "object") return;
    const p = item as Record<string, unknown>;
    const v = typeof p.value === "string" || typeof p.value === "number" ? String(p.value).trim() : "";
    if (!v) return;
    out.push({
      valor: v,
      label: textoLimpo(p.label, 40),
      primario: p.primary === true,
    });
  });

  const peso = (t: TelefoneDaPessoa, i: number) => {
    if (t.primario) return -2_000_000 + i;
    const l = t.label
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    if (l.includes("whats")) return -1_000_000 + i;
    return i;
  };
  return out
    .map((t, i) => ({ t, k: peso(t, i) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.t);
}

export type ContatoBruto = { telefone: string; nome: string };

export type ColetaPipedrive = {
  brutos: ContatoBruto[];
  /** itens lidos da API antes de virar contato */
  lidos: number;
  /** paginas percorridas */
  paginas: number;
  /** registros sem NENHUM telefone (nao e erro: contato de e-mail existe) */
  sem_telefone: number;
  /** pessoas com mais de um numero — so o preferido entra (ver abaixo) */
  multiplos_numeros: number;
  /**
   * deals cujo contato veio como ID NUMERICO (v2) ou nulo (deal so de empresa):
   * o telefone nao esta na resposta e NAO se chuta. Contado e declarado.
   */
  contato_nao_resolvido: number;
  /** a coleta parou no teto (de destinos ou de paginas) */
  truncado: boolean;
  motivo_truncado?: string;
};

const VAZIO: ColetaPipedrive = {
  brutos: [],
  lidos: 0,
  paginas: 0,
  sem_telefone: 0,
  multiplos_numeros: 0,
  contato_nao_resolvido: 0,
  truncado: false,
};

/**
 * UM TELEFONE POR PESSOA, e isto e decisao — nao economia.
 *
 * A conta medida guarda "Celular" e "WhatsApp" na mesma pessoa, quase sempre com
 * numeros DIFERENTES (um com o 9, outro sem; fixo e celular). A deduplicacao do
 * publico (`chaveDedupe`, por ultimos digitos) nao junta numeros diferentes:
 * levar os dois faria a MESMA pessoa receber a campanha DUAS vezes, em dois
 * numeros, o que e exatamente a reclamacao que derruba a reputacao do chip.
 * Entao entra o preferido (`telefonesDaPessoa`), e quantas pessoas tinham mais de
 * um sai como numero na tela — quem quiser o outro numero exporta do CRM e usa a
 * origem CSV, que e explicita.
 */
export function contatoDaPessoa(pessoa: unknown, nomeAlternativo?: string): ContatoBruto | null {
  const tels = telefonesDaPessoa(pessoa);
  if (!tels.length) return null;
  const o = (pessoa && typeof pessoa === "object" ? pessoa : {}) as Record<string, unknown>;
  const nome = textoLimpo(o.name, 120) || textoLimpo(nomeAlternativo, 120);
  return { telefone: tels[0].valor, nome };
}

/** Quantos telefones distintos aquela pessoa tem (pra contar `multiplos_numeros`). */
export function quantosNumeros(pessoa: unknown): number {
  const vistos = new Set<string>();
  for (const t of telefonesDaPessoa(pessoa)) {
    const d = t.valor.replace(/\D/g, "");
    if (d) vistos.add(d);
  }
  return vistos.size;
}

/** `additional_data.pagination.next_start`, ou null quando acabou. PURA. */
export function paginaSeguinte(corpo: unknown): number | null {
  const pag = (corpo as { additional_data?: { pagination?: unknown } } | null)?.additional_data?.pagination;
  if (!pag || typeof pag !== "object") return null;
  const p = pag as Record<string, unknown>;
  if (p.more_items_in_collection !== true) return null;
  const prox = p.next_start;
  if (typeof prox === "number" && Number.isInteger(prox) && prox >= 0) return prox;
  return null;
}

/**
 * A resposta e uma resposta de sucesso da API? PURA.
 *
 * FAIL-CLOSED: `success` que nao e `true` (token invalido, 401 com corpo JSON,
 * pagina de erro) NAO pode virar "o filtro nao tem ninguem". Publico vazio
 * silencioso e o pior desfecho possivel aqui: a pessoa remonta o publico, ve
 * zero e conclui que o filtro do CRM esvaziou.
 */
export function respostaOk(corpo: unknown): boolean {
  return !!corpo && typeof corpo === "object" && (corpo as Record<string, unknown>).success === true;
}

export function erroDaResposta(corpo: unknown): string {
  const o = (corpo && typeof corpo === "object" ? corpo : {}) as Record<string, unknown>;
  const e = typeof o.error === "string" ? o.error : "";
  const info = typeof o.error_info === "string" ? o.error_info : "";
  const txt = [e, info].filter(Boolean).join(" — ");
  return textoLimpo(txt, 200) || "o Pipedrive respondeu fora do formato esperado";
}

// ———————————————————————————————————————————————————————————————— a porta

/**
 * A ida a rede, INJETADA. Recebe caminho relativo ja com query (sem token) e
 * devolve o corpo JSON. Quem implementa poe o token, o timeout e o tratamento de
 * status; quem decide (este arquivo) nunca ve credencial.
 *
 * Erro de rede/status LANCA — a coleta nao engole: publico incompleto entregue
 * como completo faria a campanha sair pra metade da lista sem ninguem saber.
 */
export type PortaPipedrive = (caminho: string) => Promise<unknown>;

export class ErroPipedrive extends Error {}

// —————————————————————————————————————————————————————————— coleta paginada

export type SelecaoPublico =
  | { tipo: "filtro"; filtro_id: number; filtro_tipo: TipoFiltro }
  | { tipo: "etapa"; etapa_id: number; status?: "open" | "won" | "lost" | "todos" };

/**
 * Status default da busca por ETAPA: **`open`**.
 *
 * Etapa de funil guarda historico — deal ganho e deal perdido continuam
 * carimbados com a etapa em que pararam. Mandar campanha pra base inteira de uma
 * etapa alcancaria quem ja comprou e quem ja disse nao, e isso e um estrago que
 * nao volta atras. Quem quiser os outros pede explicitamente.
 */
export const STATUS_ETAPA_PADRAO = "open";

function caminhoDaPagina(sel: SelecaoPublico, start: number): string {
  const q = [`start=${start}`, `limit=${LOTE}`];
  if (sel.tipo === "filtro") {
    q.push(`filter_id=${sel.filtro_id}`);
    return `${sel.filtro_tipo === "people" ? "/persons" : "/deals"}?${q.join("&")}`;
  }
  q.push(`stage_id=${sel.etapa_id}`);
  const st = sel.status || STATUS_ETAPA_PADRAO;
  if (st !== "todos") q.push(`status=${st}`);
  return `/deals?${q.join("&")}`;
}

/**
 * Le a selecao inteira, paginando, e devolve os contatos CRUS (sem validar
 * telefone e sem deduplicar — isso e do `consolidar` de lib/disparo/publico.ts,
 * que e o mesmo caminho das outras tres origens; regra de validacao em dois
 * lugares diverge).
 */
export async function coletar(
  sel: SelecaoPublico,
  porta: PortaPipedrive,
  teto: number
): Promise<ColetaPipedrive> {
  const r: ColetaPipedrive = { ...VAZIO, brutos: [] };
  if (teto <= 0) return { ...r, truncado: true, motivo_truncado: "teto de destinos zerado" };

  let start = 0;
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const corpo = await porta(caminhoDaPagina(sel, start));
    if (!respostaOk(corpo)) throw new ErroPipedrive(erroDaResposta(corpo));
    r.paginas++;

    const dados = (corpo as { data?: unknown }).data;
    const lista = Array.isArray(dados) ? dados : [];
    for (const item of lista) {
      r.lidos++;
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;

      let pessoa: unknown;
      let nomeAlt = "";
      if (sel.tipo === "filtro" && sel.filtro_tipo === "people") {
        pessoa = item;
      } else {
        const d = item as Record<string, unknown>;
        nomeAlt = textoLimpo(d.person_name, 120);
        const p = d.person_id;
        if (p && typeof p === "object" && !Array.isArray(p)) {
          pessoa = p;
        } else {
          // ID numerico (v2) ou deal sem contato (so empresa): a resposta nao
          // tem telefone e nao existe palpite aceitavel
          r.contato_nao_resolvido++;
          continue;
        }
      }

      const n = quantosNumeros(pessoa);
      if (n > 1) r.multiplos_numeros++;
      const c = contatoDaPessoa(pessoa, nomeAlt);
      if (!c) {
        r.sem_telefone++;
        continue;
      }
      r.brutos.push(c);
      if (r.brutos.length >= teto) {
        return { ...r, truncado: true, motivo_truncado: `teto de ${teto} destinos por publico` };
      }
    }

    const prox = paginaSeguinte(corpo);
    if (prox === null) return r;
    // paginacao que nao ANDA e paginacao presa: repetir a mesma pagina faria
    // laco infinito com resposta 200 (o cenario que o MAX_PAGINAS mal segura)
    if (prox <= start) {
      return { ...r, truncado: true, motivo_truncado: "a paginacao do CRM nao avancou" };
    }
    start = prox;
  }
  return { ...r, truncado: true, motivo_truncado: `teto de ${MAX_PAGINAS} paginas por consulta` };
}

/** Avisos legiveis da coleta, na ordem em que importam. PURA. */
export function avisosDaColeta(c: ColetaPipedrive): string[] {
  const av: string[] = [];
  if (c.truncado && c.motivo_truncado) {
    av.push(`o publico foi cortado: ${c.motivo_truncado}`);
  }
  if (c.contato_nao_resolvido) {
    av.push(
      `${c.contato_nao_resolvido} registro(s) do CRM ficaram de fora porque a resposta nao trouxe o contato (negocio sem pessoa, ou pessoa devolvida so como id)`
    );
  }
  if (c.sem_telefone) {
    av.push(`${c.sem_telefone} contato(s) do CRM nao tem telefone cadastrado`);
  }
  if (c.multiplos_numeros) {
    av.push(
      `${c.multiplos_numeros} contato(s) tem mais de um numero; entrou um por pessoa (o principal, senao o marcado como WhatsApp)`
    );
  }
  return av;
}
