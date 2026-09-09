import { createHash } from "node:crypto";
import { msgDb } from "@/lib/mensageria";
import { fusoDaConfig, derrubarCacheConfig, getConfig } from "@/lib/config";
import { resolverFuso } from "@/lib/fuso";
import {
  acessoPermitido,
  motivoForaDaJanela,
  validarJanela,
  type JanelaAcesso,
} from "@/lib/janela-acesso";
import { assinaturaDispositivo, ipDoCliente, lerUserAgent } from "@/lib/dispositivo-ua";
import {
  restricaoVazia,
  type RestricaoAplicada,
  type RestricaoUsuario,
} from "@/lib/visibilidade";

// Camada de BANCO da seguranca de conta (Frente Q, 31/08/2026): janela de
// acesso, restricao por funil/canal e registro de dispositivos. A REGRA PURA
// mora em lib/janela-acesso.ts, lib/visibilidade.ts e lib/dispositivo-ua.ts —
// aqui so tem leitura, cache e degradacao.
//
// AS TRES TABELAS SAO GESTO HUMANO (migration 0019_seguranca_conta.sql, rodada
// no SQL Editor). Codigo nao cria tabela — regra da casa. Enquanto ela nao
// rodar, o painel funciona EXATAMENTE como antes: ninguem tem janela, ninguem
// tem restricao, ninguem tem dispositivo revogado.
//
// A PRIMEIRA PORTEIRA E UM MARCADOR, NAO UM CODIGO DE ERRO (achado de revisao,
// 31/08/2026). `mensageria.config.politica_acesso_ativa` nasce false e vira true
// SO quando a primeira janela, restricao ou revogacao e gravada
// (`ligarPoliticaDeAcesso`, chamada pelas rotas de gravacao). Com ela false,
// NENHUMA das tres tabelas e consultada — e portanto nao existe caminho pra
// barrar ninguem.
//
// Por que isso e a peca central: sem o marcador, "a 0019 nao rodou" dependia de
// acertar o codigo de erro do PostgREST. Errar o codigo — e o PostgREST tem
// varios: 42P01 do Postgres, mas tambem PGRST205 pra tabela fora do schema
// cache, PGRST202/204 pra funcao/coluna — transformava fail-closed em APAGAO:
// 403 pra todo mundo, no painel inteiro, ate alguem rodar uma migration. Agora
// sao duas camadas independentes: o marcador evita o caminho, e a lista de
// codigos abaixo (mais a deteccao por "schema cache" na mensagem, como cinto
// extra) evita o apagao se o caminho for percorrido.
//
// POLITICA DE FALHA, e por que ela NAO e a mesma nas tres:
//
//  - TABELA AUSENTE (42P01/42703 do Postgres, PGRST205/202/204 do PostgREST, ou
//    qualquer mensagem falando de "schema cache") = a funcionalidade nao existe
//    nesta instalacao. Ninguem configurou nada, entao nada restringe. Isso e
//    retrocompatibilidade, nao fail-open: e o mesmo que a instalacao de hoje.
//
//  - ERRO DE LEITURA DE VERDADE (banco fora, permissao, timeout) com a tabela
//    JA existindo = serve o ULTIMO CACHE BOM, mesmo vencido (padrao de
//    `getPapeis` em lib/perfil.ts). Sem cache bom nenhum:
//      * JANELA -> NEGA pra quem nao e super admin. Fail-closed de verdade, e
//        seguro porque super admin NUNCA e barrado pela janela (abaixo) — ou
//        seja, existe sempre um caminho de volta pra dentro. Sem essa garantia,
//        fail-closed aqui seria brickar a instalacao num soluco de rede.
//      * RESTRICAO -> restringe a NADA (o usuario nao ve conversa nenhuma).
//        Vazar conversa de outro numero e pior que uma tela vazia com aviso.
//      * DISPOSITIVO -> NEGA. Sem saber quem foi revogado, nao ha como servir
//        alguem com seguranca.
//
// SUPER ADMIN nunca e barrado por janela nem por dispositivo revogado. Isto e
// escolha de desenho, escrita aqui pra ninguem "consertar" depois: (1) e a
// mesma camada 1 de `conversaVisivel` ("super admin ve tudo"); (2) e o que
// permite que TODA a politica de falha acima seja fail-closed sem risco de
// trancar a instalacao pra fora — o dono entra e desfaz. A rota de gravacao
// recusa configurar janela pra super admin, pra ninguem gravar regra inerte
// achando que ela vale.

// 42P01 tabela inexistente / 42703 coluna inexistente (Postgres);
// PGRST205 tabela fora do schema cache do PostgREST (o caso REAL de "migration
// nao rodou" numa instalacao Supabase, e o que a primeira versao desta frente
// nao pegava); PGRST202 funcao nao encontrada; PGRST204 coluna nao encontrada.
const TABELA_AUSENTE = new Set(["42P01", "42703", "PGRST205", "PGRST202", "PGRST204"]);
const TTL = 60_000;

/**
 * "Isto e schema que nao existe (ainda)?" — por CODIGO e por MENSAGEM.
 *
 * A mensagem entra como cinto extra porque a lista de codigos do PostgREST
 * cresce, e errar um deles aqui e exatamente o que transforma fail-closed em
 * apagao. Toda resposta de schema-cache do PostgREST diz "schema cache" no texto.
 */
export function erroDeSchemaAusente(erro: any): boolean {
  if (!erro) return false;
  if (TABELA_AUSENTE.has(String(erro.code))) return true;
  // "schema cache" e a frase que o PostgREST monta em INGLES no proprio corpo da
  // resposta, independente do locale do Postgres. `does not exist` estava aqui
  // tambem e SAIU: e mensagem do POSTGRES, que muda com `lc_messages` (em pt_BR
  // vira "nao existe" e o cinto nao serviria pra nada) e, pior, casaria com erro
  // REAL de outra natureza ("column x does not exist" de um select torto,
  // "role ... does not exist"), engolindo defeito como se fosse migration
  // pendente.
  const txt = `${erro.message ?? ""} ${erro.hint ?? ""}`.toLowerCase();
  return txt.includes("schema cache");
}

function ausente(erro: any): boolean {
  return erroDeSchemaAusente(erro);
}

// ——————————————————————————————————————————————— o marcador da politica
//
// Sem politica configurada, a porta nao consulta nada. Ver o cabecalho.
async function politicaLigada(): Promise<boolean> {
  const cfg = await getConfig().catch(() => null);
  return cfg?.politica_acesso_ativa === true;
}

/**
 * Liga o marcador. Chamada pelas rotas que gravam janela, restricao ou
 * revogacao — idempotente. Falhar aqui NAO derruba a gravacao que acabou de dar
 * certo, mas devolve a frase pra rota avisar: senao o admin grava a janela, ela
 * nao pega, e ninguem entende por que.
 */
export async function ligarPoliticaDeAcesso(): Promise<string | null> {
  if (await politicaLigada()) return null;
  const { error } = await msgDb()
    .from("config")
    .upsert(
      { chave: "politica_acesso_ativa", valor: true, updated_at: new Date().toISOString() },
      { onConflict: "chave" }
    );
  derrubarCacheConfig();
  if (error) {
    console.error("acesso/ligar-politica:", error.message);
    return "gravei a regra, mas nao consegui LIGAR a politica de acesso nesta instalacao — ela so passa a valer quando isso funcionar";
  }
  return null;
}

// ————————————————————————————————————————————————————— poda dos mapas
//
// Todo cache aqui e Map em memoria de instancia serverless. Chave por usuario e
// por dispositivo cresce com o time, e instancia que vive horas acumula entrada
// de quem nem esta mais logado. Teto simples com descarte do mais ANTIGO (o Map
// do JS preserva a ordem de insercao, entao a primeira chave e a mais velha).
// Nao e LRU e nao precisa ser: o custo de um miss aqui e uma consulta que o TTL
// ja pagaria de todo jeito.
export function podar<K, V>(mapa: Map<K, V>, teto: number) {
  if (mapa.size <= teto) return;
  const sobra = mapa.size - teto;
  let i = 0;
  for (const k of mapa.keys()) {
    mapa.delete(k);
    if (++i >= sobra) break;
  }
}

// ————————————————————————————————————————————————— janela de acesso
type CacheJanelas = { mapa: Map<string, JanelaAcesso>; ts: number };
let janelasCache: CacheJanelas | null = null;
let janelasSemTabela = 0;

export function derrubarCacheAcesso() {
  janelasCache = null;
  restricoesCache = null;
  revogadosCache = null;
  janelasSemTabela = 0;
  restricoesSemTabela = 0;
  dispositivosSemTabela = 0;
}

/**
 * Todas as janelas configuradas, por user_id. A tabela e pequena por natureza
 * (uma linha por pessoa COM janela, e o normal e quase ninguem ter), entao vale
 * mais um mapa em cache de 60s do que uma consulta por request.
 *
 * `null` = nao foi possivel ler E nao ha cache bom. Semanticamente diferente de
 * "mapa vazio" (que quer dizer "ninguem tem janela").
 */
async function janelas(): Promise<Map<string, JanelaAcesso> | null> {
  // sem politica configurada nesta instalacao: nem consulta (ver cabecalho)
  if (!(await politicaLigada())) return new Map();
  if (janelasCache && Date.now() - janelasCache.ts < TTL) return janelasCache.mapa;
  if (janelasSemTabela && Date.now() - janelasSemTabela < TTL) return new Map();
  const { data, error } = await msgDb().from("acesso_janelas").select("user_id,ativo,dias");
  if (error) {
    if (ausente(error)) {
      janelasSemTabela = Date.now();
      return new Map();
    }
    console.error("acesso/janelas:", error.message);
    return janelasCache?.mapa ?? null;
  }
  const mapa = new Map<string, JanelaAcesso>();
  for (const r of data ?? []) {
    const j = validarJanela({ ativo: (r as any).ativo, dias: (r as any).dias });
    if (j.ativo) mapa.set((r as any).user_id as string, j);
  }
  janelasCache = { mapa, ts: Date.now() };
  return mapa;
}

export type VereditoAcesso = { ok: true } | { ok: false; motivo: string };

/**
 * Este usuario pode entrar AGORA? Chamado na porta (lib/auth-server.ts), entao
 * vale pro login E pra sessao que ja estava aberta — o bloqueio e nas ROTAS,
 * nao na tela.
 */
export async function janelaDoUsuario(userId: string): Promise<JanelaAcesso | null> {
  const mapa = await janelas();
  if (!mapa) return null;
  return mapa.get(userId) ?? null;
}

/**
 * `souSuperAdmin` e uma FUNCAO, e nao um booleano, de proposito.
 *
 * A porta (`lib/auth-server.ts`) atravessa TODO request, e o polling do painel
 * bate a cada 3-6s. Descobrir se alguem e super admin custa uma leitura de
 * `perfis` (`getPerfil`) — e no caso normal, que e a instalacao onde NINGUEM tem
 * janela nem dispositivo revogado, essa leitura nao decide nada. Passando um
 * resolvedor preguicoso, o caso normal custa ZERO consulta a mais: os dois mapas
 * ja vem de cache de 30-60s pra instalacao inteira, e o `perfis` so e lido
 * quando existe de fato uma regra pra aplicar aquela pessoa.
 */
export type SouSuperAdmin = () => Promise<boolean> | boolean;

export async function acessoNaJanela(
  userId: string,
  souSuperAdmin: SouSuperAdmin,
  agora: Date = new Date()
): Promise<VereditoAcesso> {
  const mapa = await janelas();
  if (!mapa) {
    // sem cache bom e a tabela existe: fail-closed pra quem nao e super admin
    // (e o super admin e o caminho de volta pra dentro)
    if (await souSuperAdmin()) return { ok: true };
    return { ok: false, motivo: "nao consegui conferir sua janela de acesso agora — tente de novo em 1 minuto" };
  }
  const j = mapa.get(userId);
  if (!j) return { ok: true };
  if (await souSuperAdmin()) return { ok: true };
  // config ilegivel NAO vira "America/Sao_Paulo" chumbado: `resolverFuso`
  // percorre a mesma cadeia do painel inteiro (config > env > fabrica), entao a
  // instalacao em Lisboa nao passa a ser avaliada em horario de Brasilia so
  // porque a leitura da config falhou.
  const cfg = await getConfig().catch(() => null);
  const fuso = cfg ? fusoDaConfig(cfg) : resolverFuso(undefined);
  if (acessoPermitido(j, agora, fuso)) return { ok: true };
  return { ok: false, motivo: motivoForaDaJanela(j) };
}

// —————————————————————————————————————————— restricao por funil/canal
type CacheRestricoes = { mapa: Map<string, RestricaoUsuario>; ts: number };
let restricoesCache: CacheRestricoes | null = null;
let restricoesSemTabela = 0;

// A restricao que NEGA tudo — o fail-closed de quando nao da pra ler a tabela.
// O jeito de negar e uma lista de canais com UM id que nenhum canal tem: o
// predicado puro nao precisa de um terceiro estado ("negar tudo") so por causa
// deste caso, e o sentinela mantem a regra com duas dimensoes. `canalPorId`
// nunca resolve este nome (lib/canais.ts), entao nenhum canal real casa.
const CANAL_INEXISTENTE = "__sem_acesso__";
const RESTRICAO_FECHADA: RestricaoUsuario = { canais: [CANAL_INEXISTENTE], funis: [], sem_funil: false };

/**
 * Esta restricao e o estado FAIL-CLOSED (nao deu pra ler a tabela), e nao um
 * recorte que alguem configurou?
 *
 * Existe pra rota nao precisar conhecer o sentinela por dentro: `/api/funis` usa
 * isto pra devolver CATALOGO VAZIO junto das conversas vazias — nome de funil e
 * metadado da operacao, e quadro montado e vazio dava mais informacao do que
 * tela em branco com aviso.
 */
export function restricaoFailClosed(r: RestricaoUsuario | null | undefined): boolean {
  return !!r && r.canais.includes(CANAL_INEXISTENTE);
}

export function validarRestricao(bruto: any): RestricaoUsuario {
  const lista = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const x of v) {
      if (typeof x !== "string") continue;
      const s = x.trim().slice(0, 80);
      if (s && !out.includes(s)) out.push(s);
      if (out.length >= 200) break;
    }
    return out.sort();
  };
  return {
    canais: lista(bruto?.canais),
    funis: lista(bruto?.funis),
    sem_funil: bruto?.sem_funil === true,
  };
}

async function restricoes(): Promise<Map<string, RestricaoUsuario> | null> {
  if (!(await politicaLigada())) return new Map();
  if (restricoesCache && Date.now() - restricoesCache.ts < TTL) return restricoesCache.mapa;
  if (restricoesSemTabela && Date.now() - restricoesSemTabela < TTL) return new Map();
  const { data, error } = await msgDb()
    .from("usuario_restricoes")
    .select("user_id,canais,funis,sem_funil");
  if (error) {
    if (ausente(error)) {
      restricoesSemTabela = Date.now();
      return new Map();
    }
    console.error("acesso/restricoes:", error.message);
    return restricoesCache?.mapa ?? null;
  }
  const mapa = new Map<string, RestricaoUsuario>();
  const cru = new Map<string, RestricaoUsuario>();
  for (const r of data ?? []) {
    const v = validarRestricao(r);
    if (!restricaoVazia(v)) cru.set((r as any).user_id as string, v);
  }

  // FUNIL APAGADO NAO TRANCA NINGUEM (achado de revisao, 31/08/2026).
  //
  // Funil e entidade que o admin apaga. Um id orfao na lista faria a pessoa
  // ficar sem ver conversa NENHUMA daquele funil — e como ela nao ve o cadastro,
  // o sintoma chega como "o painel quebrou pra mim", nao como "a restricao esta
  // errada". Fail-closed silencioso e o pior tipo.
  //
  // Entao id que nao existe mais e IGNORADO na leitura, e o GET de admin
  // devolve o aviso (`funisOrfaos`) pra alguem consertar o cadastro.
  //
  // O ALCANCE, declarado: se TODOS os funis da lista morreram, a dimensao funil
  // fica vazia e sobra o recorte por CANAL. Se nem canal havia, a pessoa volta
  // ao modelo base (escopo de visao + ACL) — que e o comportamento anterior a
  // esta feature, nao "ve tudo": quem tem escopo `proprias` continua vendo so as
  // suas. Preferimos essa degradacao a trancar alguem por causa de cadastro
  // apagado.
  //
  // Falha ao LER o catalogo de funis nao poda nada (podar no escuro
  // AFROUXARIA a restricao): fica como esta gravado.
  orfaos = new Map<string, string[]>();
  const comFunis = [...cru.values()].some((v) => v.funis.length);
  let vivos: Set<string> | null = null;
  if (comFunis) {
    const cat = await msgDb().from("funis").select("id");
    if (cat.error) {
      if (!ausente(cat.error)) console.error("acesso/funis-catalogo:", cat.error.message);
      // sem catalogo (0009 nao rodou ou leitura falhou): nao poda
    } else {
      vivos = new Set((cat.data ?? []).map((f: any) => f.id as string));
    }
  }
  for (const [userId, v] of cru) {
    if (!vivos || !v.funis.length) {
      mapa.set(userId, v);
      continue;
    }
    const fora = v.funis.filter((f) => !vivos!.has(f));
    if (!fora.length) {
      mapa.set(userId, v);
      continue;
    }
    orfaos.set(userId, fora);
    const sobraram = v.funis.filter((f) => vivos!.has(f));
    if (!sobraram.length) {
      // TODOS os funis da lista morreram: a restricao fica COMO ESTA, negando.
      //
      // A versao anterior podava mesmo assim, e a segunda revisao mediu o
      // resultado: a dimensao funil virava vazia, e se nao houvesse recorte de
      // canal a pessoa recebia a CAIXA INTEIRA. Trocar "nao ve o funil apagado"
      // por "ve tudo" e o inverso do que a poda existe pra fazer — a poda serve
      // pra nao trancar quem ainda tem funil valido, nao pra abrir a conta de
      // quem nao tem nenhum. Aqui quem trabalha e o `aviso_orfaos` do GET de
      // admin: alguem conserta o cadastro.
      mapa.set(userId, v);
      continue;
    }
    const podado: RestricaoUsuario = { ...v, funis: sobraram };
    if (!restricaoVazia(podado)) mapa.set(userId, podado);
  }

  restricoesCache = { mapa, ts: Date.now() };
  return mapa;
}

// ids de funil gravados que nao existem mais, por usuario. Preenchido pela
// leitura acima; lido pelo GET de /api/admin/restricoes pra avisar em voz alta.
let orfaos = new Map<string, string[]>();

export async function funisOrfaos(): Promise<Map<string, string[]>> {
  await restricoes();
  return orfaos;
}

/**
 * Restricao EFETIVA do usuario: `null` = nao restringe nada (o caso normal).
 * Super admin nunca e restringido — `conversaVisivel` ja devolve true pra ele
 * na camada 1, mas devolver null aqui evita que a rota pague as consultas de
 * funil sem necessidade.
 */
export async function restricaoDeConversas(
  userId: string,
  ehSuperAdmin: boolean
): Promise<RestricaoUsuario | null> {
  if (ehSuperAdmin) return null;
  const mapa = await restricoes();
  if (!mapa) return RESTRICAO_FECHADA; // fail-closed: nao vê nada até a leitura voltar
  return mapa.get(userId) ?? null;
}

/**
 * Os funis de um lote de conversas — `${canal}|${chat_id}` -> ids de funil.
 * So e chamado quando existe restricao POR FUNIL: sem isso, o quadro e a lista
 * de conversas nao pagariam a consulta.
 *
 * Sem a migration 0009 (funis) a tabela nao existe: devolve `null`, e quem
 * chama trata como "nao deu pra avaliar" — que no predicado e NEGAR. Correto:
 * restricao por funil sem tabela de funil e configuracao impossivel de honrar.
 */
export async function funisDasConversas(
  pares: Array<{ canal: string; chatId: string }>
): Promise<Map<string, string[]> | null> {
  const mapa = new Map<string, string[]>();
  if (!pares.length) return mapa;
  const porCanal = new Map<string, string[]>();
  for (const p of pares) {
    const l = porCanal.get(p.canal) ?? [];
    if (!l.includes(p.chatId)) l.push(p.chatId);
    porCanal.set(p.canal, l);
  }
  for (const [canal, ids] of porCanal) {
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await msgDb()
        .from("conversa_funil")
        .select("chat_id,funil_id")
        .eq("canal", canal)
        .in("chat_id", ids.slice(i, i + 200));
      if (error) {
        console.error("acesso/funis-das-conversas:", error.message);
        return null;
      }
      for (const r of data ?? []) {
        const k = `${canal}|${(r as any).chat_id}`;
        const l = mapa.get(k) ?? [];
        if (!l.includes((r as any).funil_id)) l.push((r as any).funil_id);
        mapa.set(k, l);
      }
    }
  }
  return mapa;
}

/**
 * A restricao pronta pra um LOTE de conversas (listagem, busca, quadro).
 *
 * Devolve `null` quando nada restringe — e o caso normal, e o chamador entao
 * passa `undefined` ao predicado, que se comporta exatamente como antes desta
 * feature. Quando restringe, devolve um `para(canal, chatId)` que entrega o par
 * {restricao, alvo} do predicado.
 *
 * A consulta de funil so acontece quando a restricao TEM funis: no recorte
 * apenas por canal, nem se paga o lote. Falha de leitura dos funis vira
 * `alvo: null` pra todo mundo, e o predicado NEGA — a lista fica vazia com o
 * usuario avisado, nunca cheia com conversa de outro funil.
 */
export async function restricaoEmLote(
  userId: string,
  ehSuperAdmin: boolean,
  pares: Array<{ canal: string; chatId: string }>
): Promise<{ para(canal: string, chatId: string): RestricaoAplicada } | null> {
  const restricao = await restricaoDeConversas(userId, ehSuperAdmin);
  if (!restricao || restricaoVazia(restricao)) return null;
  let funis: Map<string, string[]> | null = new Map();
  if (restricao.funis.length) funis = await funisDasConversas(pares);
  return {
    para(canal: string, chatId: string): RestricaoAplicada {
      if (!funis) return { restricao, alvo: null };
      return { restricao, alvo: { canal, funilIds: funis.get(`${canal}|${chatId}`) ?? [] } };
    },
  };
}

/** Este usuario alcanca este CANAL? Usado pro seletor de numero da tela nao
 *  oferecer canal que a pessoa nao pode abrir. Sem restricao = alcanca todos. */
export function canalPermitido(restricao: RestricaoUsuario | null, canal: string): boolean {
  if (!restricao || !restricao.canais.length) return true;
  return restricao.canais.includes(canal);
}

// ————————————————————————————————————————————————————— dispositivos
type CacheRevogados = { set: Set<string>; ts: number };
let revogadosCache: CacheRevogados | null = null;
let dispositivosSemTabela = 0;
const gravouEm = new Map<string, number>();

/** `user_id|assinatura` -> hash estavel. O hash e o que a linha guarda. */
export function impressaoDispositivo(userId: string, ua: unknown): string {
  return createHash("sha256").update(`${userId}|${assinaturaDispositivo(ua)}`).digest("hex").slice(0, 32);
}

async function revogados(): Promise<Set<string> | null> {
  if (!(await politicaLigada())) return new Set();
  if (revogadosCache && Date.now() - revogadosCache.ts < 30_000) return revogadosCache.set;
  if (dispositivosSemTabela && Date.now() - dispositivosSemTabela < TTL) return new Set();
  const { data, error } = await msgDb()
    .from("usuario_dispositivos")
    .select("user_id,impressao")
    .not("revogado_em", "is", null);
  if (error) {
    if (ausente(error)) {
      dispositivosSemTabela = Date.now();
      return new Set();
    }
    console.error("acesso/dispositivos:", error.message);
    return revogadosCache?.set ?? null;
  }
  const set = new Set((data ?? []).map((r: any) => `${r.user_id}|${r.impressao}`));
  revogadosCache = { set, ts: Date.now() };
  return set;
}

export function derrubarCacheDispositivos() {
  revogadosCache = null;
}

/**
 * Confere a revogacao e ATUALIZA o registro (throttle de 2min por dispositivo,
 * como `marcarPresenca`). A conferencia NUNCA e throttled — senao a revogacao
 * levaria 2min pra pegar, e o throttle e so pra escrita.
 */
export async function conferirDispositivo(
  userId: string,
  souSuperAdmin: SouSuperAdmin,
  req: { headers: { get(n: string): string | null } }
): Promise<VereditoAcesso> {
  const ua = req.headers.get("user-agent");
  const impressao = impressaoDispositivo(userId, ua);
  const set = await revogados();
  if (!set) {
    if (await souSuperAdmin()) return { ok: true };
    return { ok: false, motivo: "nao consegui conferir seu dispositivo agora — tente de novo em 1 minuto" };
  }
  if (set.has(`${userId}|${impressao}`) && !(await souSuperAdmin())) {
    return { ok: false, motivo: "o acesso deste dispositivo foi revogado — fale com o administrador" };
  }
  if (dispositivosSemTabela && Date.now() - dispositivosSemTabela < TTL) return { ok: true };

  const chaveThrottle = `${userId}|${impressao}`;
  const ultimo = gravouEm.get(chaveThrottle) ?? 0;
  if (Date.now() - ultimo > 120_000) {
    gravouEm.set(chaveThrottle, Date.now());
    podar(gravouEm, 5_000);
    const d = lerUserAgent(ua);
    const ip = ipDoCliente({
      forwardedFor: req.headers.get("x-forwarded-for"),
      realIp: req.headers.get("x-real-ip"),
    });
    const agora = new Date().toISOString();
    // upsert por (user_id, impressao): `primeiro_acesso_em` tem default no banco
    // e NAO entra no patch de proposito — reenviar apagaria a data de estreia.
    await msgDb()
      .from("usuario_dispositivos")
      .upsert(
        {
          user_id: userId,
          impressao,
          navegador: d.navegador,
          sistema: d.sistema,
          rotulo: d.rotulo,
          robo: d.robo,
          user_agent: typeof ua === "string" ? ua.slice(0, 400) : null,
          ip_ultimo: ip,
          visto_em: agora,
        },
        { onConflict: "user_id,impressao" }
      )
      .then((r: any) => {
        if (r?.error && !ausente(r.error)) console.error("acesso/dispositivo-upsert:", r.error.message);
        if (r?.error && ausente(r.error)) dispositivosSemTabela = Date.now();
      });
  }
  return { ok: true };
}
