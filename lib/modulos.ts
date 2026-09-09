// MODULOS da instalacao (decisao de versao, Eric 30/08/2026 — opcao A).
//
// Base UNICA de codigo: cada modulo grande (automacao, e o que vier depois)
// fica atras de uma chave POR INSTALACAO — nunca por conta, nunca fork.
// A instalacao NASCE simples: default de TODOS os modulos = DESLIGADO. Quem
// quiser liga, e a partir dai o codigo do modulo passa a responder.
//
// Duas camadas, nesta ordem de precedencia:
//   1. env `MODULOS` — JSON, ex: MODULOS={"automacao":true}
//   2. `mensageria.config` chave `modulos` (valor jsonb), que VENCE a env — a
//      env e o default de quem instalou; a config e a palavra final na
//      instalacao rodando.
// ESTADO REAL HOJE (31/08/2026): a chave `modulos` NAO tem tela. A aba
// Automacao do admin so aceita as chaves de `CHAVES_CONFIG` (lib/config.ts), e
// `modulos` nao esta la de proposito — ligar modulo e gesto de quem instala,
// por env ou por SQL direto na linha de config. Tela do super admin e
// incremento futuro (precisa de validacao visual do Eric).
//
// Regra BASE do repo: nada de nenhuma empresa aqui — so nome de modulo.
// Chave desconhecida e IGNORADA: instalacao velha nao quebra quando um modulo
// novo entra na lista, e lixo no JSON nao vira flag ligada.

// FRENTE S (31/08/2026): `fila_atendimento` — entrar/sair/pular a vez na
// distribuicao de conversa nova. Nasce DESLIGADO como os irmaos, e com ele
// desligado `lib/rodizio.ts` nem consulta a tabela da fila: a distribuicao se
// comporta EXATAMENTE como antes da frente. Ligar o modulo da o CONTROLE (quem
// nunca mexeu na fila continua dentro dela), nao muda quem recebe.
export const MODULOS = ["automacao", "disparo", "fila_atendimento"] as const;
export type Modulo = (typeof MODULOS)[number];
export type MapaModulos = Record<Modulo, boolean>;

// Instalacao nasce SIMPLES: tudo desligado.
export const MODULOS_PADRAO: MapaModulos = MODULOS.reduce(
  (acc, m) => ({ ...acc, [m]: false }),
  {} as MapaModulos
);

export function moduloConhecido(nome: string): nome is Modulo {
  return (MODULOS as readonly string[]).includes(nome);
}

// Normaliza um objeto bruto (env ou banco) num mapa parcial de modulos.
// Puro — e o que a prova exercita. So aceita booleano de verdade: "true",
// 1 ou "sim" NAO ligam modulo (ligar por engano e pior que nao ligar).
export function validarMapaModulos(bruto: unknown): Partial<MapaModulos> {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return {};
  const out: Partial<MapaModulos> = {};
  for (const [k, v] of Object.entries(bruto as Record<string, unknown>)) {
    if (!moduloConhecido(k)) continue;
    if (typeof v !== "boolean") continue;
    out[k] = v;
  }
  return out;
}

export function modulosDoEnv(): Partial<MapaModulos> {
  const raw = process.env.MODULOS;
  if (!raw) return {};
  try {
    return validarMapaModulos(JSON.parse(raw));
  } catch {
    return {}; // JSON invalido na env nunca liga modulo nem derruba o painel
  }
}

// cache curto, mesmo padrao do getConfig (lib/config.ts): rota de polling nao
// pode pagar um SELECT por request, e 30s de atraso pra chave nova valer em
// toda instancia e aceitavel.
let cache: { mapa: MapaModulos; ts: number } | null = null;

// FRENTE S (31/08/2026) — LEITURA que falhou NAO e leitura que veio vazia.
//
// Achado da 1a revisao cega: o `supabase-js` NAO LANCA em erro de query, devolve
// `{ data: null, error }`. O `try/catch` so pegava excecao, entao um blip no
// banco caia no ramo silencioso, virava "mapa default" (= tudo DESLIGADO) e
// ficava 30s no cache. Pra quem LE a flag pra decidir um FREIO (`lib/rodizio.ts`
// e a fila de atendimento) isso e fail-OPEN: a fila nem seria consultada e a
// conversa cairia justamente em quem pediu pra sair dela.
//
// Quem le com SUCESSO nao muda em nada: mesmo mapa, mesmo cache de 30s.
export type LeituraModulos = {
  mapa: MapaModulos;
  /**
   * true = nao foi possivel SABER o estado das chaves.
   *
   * O `mapa` que vem junto NAO e default cego: e o ULTIMO valor lido com sucesso
   * (mesmo vencido) quando existe um. Quem decide freio combina os dois — "falhou
   * E o ultimo valor conhecido dizia LIGADO" e a unica combinacao que pede recusa
   * (ver o cabecalho da fila em lib/rodizio.ts).
   */
  falhou: boolean;
  /**
   * true = falhou E nao existe NENHUM valor conhecido pra cair (processo FRIO).
   *
   * `ultimoBom` e estado DE PROCESSO: numa instancia serverless que acabou de
   * subir ele e `null`, e ai o mapa que sai daqui e so a env + o default. Pra quem
   * decide freio isso NAO e a mesma coisa que "o ultimo valor bom dizia
   * desligado" — e "nao ha valor nenhum". Quem precisa da diferenca (lib/rodizio.ts)
   * usa este campo pra ir perguntar a QUEM SABE (a propria tabela da fila) em vez
   * de assumir desligado.
   */
  sem_valor_conhecido: boolean;
};

// ULTIMO VALOR BOM, sem prazo — o padrao da casa (`getConfig` em lib/config.ts,
// `getPapeis` em lib/perfil.ts, as janelas em lib/acesso.ts). Correcao da 2a
// revisao: servir o DEFAULT numa falha e o que transformava "nao sei" em
// "desligado", e num arquivo de flags "desligado" e uma afirmacao com
// consequencia. Valor velho e melhor que valor inventado.
let ultimoBom: MapaModulos | null = null;
// AMORTECEDOR de falha (curto). Sem ele, indisponibilidade real do banco fazia um
// SELECT + um console.error POR MENSAGEM RECEBIDA — o log viraria o segundo
// incidente. 5s e curto o suficiente pra flag nova valer quase na hora e longo o
// suficiente pra um pico de mensagens nao virar tempestade de query.
const TTL_FALHA_MS = 5_000;
let falhaAte = 0;

export async function getModulosDetalhado(): Promise<LeituraModulos> {
  if (cache && Date.now() - cache.ts < 30_000)
    return { mapa: cache.mapa, falhou: false, sem_valor_conhecido: false };
  const base: MapaModulos = { ...MODULOS_PADRAO, ...modulosDoEnv() };
  // ainda dentro da janela de falha: nao bate no banco e nao loga de novo
  if (Date.now() < falhaAte)
    return { mapa: ultimoBom ?? base, falhou: true, sem_valor_conhecido: !ultimoBom };
  try {
    // import preguicoso de proposito: assim o topo deste arquivo nao depende de
    // nada e as funcoes puras (validarMapaModulos/modulosDoEnv) rodam em node
    // solto — e o que a prova `scripts/prova-fluxo.ts` exercita.
    const { msgDb } = await import("@/lib/mensageria");
    const { data, error } = await msgDb().from("config").select("valor").eq("chave", "modulos").maybeSingle();
    // `maybeSingle` devolve `data: null, error: null` quando NAO HA LINHA — esse
    // e o caso normal de instalacao que nunca ligou modulo, e nao e falha.
    //
    // NAO EXISTE MAIS excecao de "schema ausente" aqui (correcao da 2a revisao).
    // Ela reabria o fail-open pela porta dos fundos: `erroDeSchemaAusente` casa
    // pela frase "schema cache" (PGRST205), que a propria 0021 documenta
    // acontecendo COM A TABELA PRESENTE — logo depois de deploy/migration,
    // enquanto o `notify pgrst` nao propagou. Nessa janela a leitura era dada por
    // boa, o mapa default (fila OFF) entrava no cache por 30s e o rodizio
    // distribuia pra quem tinha saido da fila. E a excecao nao protegia caso real
    // nenhum: `mensageria.config` nasce na 0001, entao se a fila foi ligada por
    // config a tabela existe; se foi por env, `modulosDoEnv()` ja entregou ON
    // antes de qualquer consulta.
    if (error) throw error;
    const mapa: MapaModulos = { ...base, ...validarMapaModulos(data?.valor) };
    cache = { mapa, ts: Date.now() };
    ultimoBom = mapa;
    falhaAte = 0;
    return { mapa, falhou: false, sem_valor_conhecido: false };
  } catch (e) {
    falhaAte = Date.now() + TTL_FALHA_MS;
    // logar e o ponto: leitura de flag que falha calada e indistinguivel de
    // instalacao que escolheu deixar tudo desligado. 1 log por janela de 5s.
    console.error("[modulos] leitura da chave `modulos` FALHOU:", e);
    // leitura que falhou NUNCA entra no cache de 30s. O que sai daqui e o ultimo
    // valor bom (se houver) — nao o default.
    return { mapa: ultimoBom ?? base, falhou: true, sem_valor_conhecido: !ultimoBom };
  }
}

export async function getModulos(): Promise<MapaModulos> {
  return (await getModulosDetalhado()).mapa;
}

export async function moduloAtivo(nome: Modulo): Promise<boolean> {
  return (await getModulos())[nome] === true;
}

/**
 * Invalida a FRESCURA (releia na proxima), NAO o fallback.
 *
 * `ultimoBom` fica de pe de proposito — mesma licao que `derrubarCacheConfig`
 * pagou em lib/config.ts: zerando os dois juntos, "acabei de gravar, releia"
 * seguido de um soluco de rede cairia no default, e o default aqui desliga
 * modulo. O ultimo valor bom nunca vence a leitura fresca; ele so existe pra
 * hora em que nao ha leitura nenhuma.
 */
export function derrubarCacheModulos() {
  cache = null;
  falhaAte = 0;
}
