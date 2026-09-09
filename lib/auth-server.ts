import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { idsInativos } from "@/lib/perfil";
import { getConfig } from "@/lib/config";
import { msgDb } from "@/lib/mensageria";
import { acessoNaJanela, conferirDispositivo, podar } from "@/lib/acesso";
import { canalDoPedido, canalPorId, type CanalDoPedido } from "@/lib/canais";
import { escopoPermite, recursoDaRota, validarEscopoChave, type EscopoChave } from "@/lib/escopo-chave";
import { RECUSA_CHAVE, chaveServe, motivoLimpo, respostaDaRecusa } from "@/lib/recusa";
import { ipDoCliente } from "@/lib/dispositivo-ua";

// presenca: marca "visto por ultimo" no perfil (base do rodizio de distribuicao
// automatica). Throttle em memoria: no maximo 1 escrita por usuario a cada 2min.
const vistoEm = new Map<string, number>();
async function marcarPresenca(userId: string) {
  const ultimo = vistoEm.get(userId) || 0;
  if (Date.now() - ultimo < 120_000) return;
  vistoEm.set(userId, Date.now());
  podar(vistoEm, 5_000);
  await msgDb()
    .from("perfis")
    .upsert({ user_id: userId, visto_em: new Date().toISOString() }, { onConflict: "user_id" })
    .then(() => {});
}

// Valida o access token (auth compartilhado do projeto de login) no server.
// cache:no-store no fetch — sem isso o Data Cache do Next pode congelar a validacao.
const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

export type UsuarioLogado = { id: string; email: string | null; nome: string };

// ————————————————————————————————————————————————————————————————
// MOTIVO DA RECUSA (Frente Q, 31/08/2026)
//
// A porta (`getUser`) devolve `null` quando recusa, e toda rota transforma isso
// em 401 "unauthorized". Isso e correto e fail-closed, mas indistinguivel:
// "seu horario de acesso terminou", "este dispositivo foi revogado", "esta
// chave e somente de leitura" e "token invalido" chegavam todos como o mesmo
// 401 seco — e quem esta do outro lado (atendente ou agente com chave) nao tem
// como saber o que fazer.
//
// O motivo fica num WeakMap chaveado pelo PROPRIO objeto de request: e escopo
// de request de verdade (nada de estado global que vaze entre chamadas
// concorrentes na mesma instancia) e some com o GC sozinho.
//
// A rota que quiser explicar troca `401 unauthorized` por `respostaSemAcesso`.
// Esquecer de trocar NAO abre buraco: a porta ja recusou; perde-se so a frase.
const motivos = new WeakMap<object, string>();

// ESCOPO DA CHAVE deste request (FRENTE S, 3a revisao).
//
// Mesmo padrao do WeakMap de motivos acima: escopo de request de verdade, sem
// estado global que vaze entre chamadas concorrentes, e some com o GC. Existe pro
// caso do metodo que NAO recebe canal no pedido e descobre o canal depois, lendo
// a linha por `id` — a porta central nao teve o que comparar, e a rota compara na
// hora com `canalNoEscopo`. Ausente = identidade de SESSAO (gente logada), que
// nao tem recorte de chave.
const escopos = new WeakMap<object, EscopoChave>();

/**
 * O escopo da chave de API que autenticou este request, ou `null` quando a
 * identidade veio de sessao de login.
 *
 * `null` NAO significa "pode tudo": significa "nao ha recorte de CHAVE" — as
 * permissoes da pessoa (lib/perfil.ts) e o escopo de visao seguem valendo e sao
 * checados do jeito de sempre.
 */
export function escopoDaChaveNoRequest(req: object): EscopoChave | null {
  return escopos.get(req) ?? null;
}

function recusar(req: object, motivo: string): null {
  motivos.set(req, motivo);
  return null;
}

// "Nao ha identidade aqui" (401) x "a politica te barrou" (403): a distincao
// importa (2a revisao) porque 403 numa credencial que nao resolve confundia
// cliente HTTP e, no caso da chave, dava um pingo de oraculo — sugeria "existe,
// mas nao pode". A frase e unica nos dois; so o status muda.
//
// A DECISAO (marcador, frase unica, status) mora em `lib/recusa.ts`, que e PURO
// — 3a revisao, item 7: a prova nao consegue importar ESTE arquivo (cliente do
// Supabase e aliases `@/`; `next/server` em si carrega em node — o que barra e a
// forma do especificador sem extensao), entao o invariante do oraculo era afirmado
// olhando a propria constante, ou seja, tautologia. Com a decisao la, a prova
// exercita o caminho de verdade e trava `{status, error}`.

/** O motivo da ultima recusa desta requisicao, se houver. */
export function motivoDaRecusa(req: NextRequest): string | null {
  return motivoLimpo(motivos.get(req) ?? null);
}

/**
 * A resposta de "nao autorizado" COM o motivo, quando houver.
 * 403 quando a credencial e valida e a POLITICA barrou (janela, dispositivo,
 * escopo da chave) — o cliente nao deve tentar de novo com outra senha; 401
 * quando nao ha identidade nenhuma.
 */
export function respostaSemAcesso(req: NextRequest) {
  const { status, ...corpo } = respostaDaRecusa(motivos.get(req) ?? null);
  return NextResponse.json(corpo, { status });
}

// F11 (18/08/2026): CHAVE DE API POR USUARIO (header x-api-key) — identidade
// alternativa pro MCP/agentes, que nao fazem o ciclo TOTP. A chave e gerada
// por super admin (/api/admin/api-keys) ou pelo proprio usuario
// (/api/minha-chave), guardada so como hash sha256 e resolve pro user_id do
// dono — TODAS as permissoes existentes (BU, visibilidade, escopo, pool) valem
// automaticamente porque as rotas so enxergam o UsuarioLogado. 2FA nao se
// aplica aqui: a chave E a credencial forte (revogavel; plaintext aparece 1
// unica vez na criacao).
// Cache 60s por hash; revogacao/desativacao pega em ate 1min.
//
// Frente Q (31/08/2026): a chave agora pode valer MENOS que o dono — escopo por
// chave, prazo e revogacao com trilha (lib/escopo-chave.ts). O cache guarda a
// LINHA; o escopo e avaliado a cada request, porque depende do metodo, do
// caminho e do canal.
type LinhaChave = {
  id: string;
  user: UsuarioLogado;
  escopo: EscopoChave;
  expiraEm: string | null;
  revogada: boolean;
};
const cacheApiKey = new Map<string, { linha: LinhaChave | null; ts: number }>();
const usoEm = new Map<string, number>();

// A leitura larga (colunas da 0019) e TOLERANTE a migration nao ter rodado:
// se ela falhar, cai no select antigo e a chave segue valendo como hoje (sem
// escopo, sem prazo). Reavalia a cada 60s, entao a migration pega sem redeploy.
let colunasEscopoOk = true;
let colunasEscopoTs = 0;

async function lerLinhaChave(hash: string): Promise<any | null | "erro"> {
  const db = msgDb();
  if (!colunasEscopoOk && Date.now() - colunasEscopoTs > 60_000) colunasEscopoOk = true;
  if (colunasEscopoOk) {
    const r = await db
      .from("api_keys")
      .select("id,user_id,escopo,expira_em,revogado_em")
      .eq("key_hash", hash)
      .eq("ativo", true)
      .maybeSingle();
    if (!r.error) return r.data;
    colunasEscopoOk = false;
    colunasEscopoTs = Date.now();
  }
  const r2 = await db
    .from("api_keys")
    .select("id,user_id")
    .eq("key_hash", hash)
    .eq("ativo", true)
    .maybeSingle();
  if (r2.error) return "erro";
  return r2.data;
}

async function linhaPorApiKey(chave: string): Promise<LinhaChave | null> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(chave).digest("hex");
  const cached = cacheApiKey.get(hash);
  if (cached && Date.now() - cached.ts < 60_000) return cached.linha;

  const row = await lerLinhaChave(hash);
  // falha de leitura NAO e cacheada como "chave invalida": um soluco de rede
  // faria a chave morrer por 60s. Recusa este request e tenta de novo no proximo.
  if (row === "erro") return null;

  let linha: LinhaChave | null = null;
  if (row && !(await idsInativos()).has(row.user_id)) {
    const { data: perfil } = await msgDb()
      .from("perfis")
      .select("nome")
      .eq("user_id", row.user_id)
      .maybeSingle();
    linha = {
      id: row.id,
      user: { id: row.user_id, email: null, nome: perfil?.nome || "agente" },
      escopo: validarEscopoChave(row.escopo),
      expiraEm: (row.expira_em as string | null) ?? null,
      // `revogado_em` preenchido derruba a chave mesmo se `ativo` ficou true por
      // gravacao pela metade: as duas colunas tem que concordar, e a mais
      // restritiva ganha.
      revogada: !!row.revogado_em,
    };
  }
  cacheApiKey.set(hash, { linha, ts: Date.now() });
  podar(cacheApiKey, 2_000);
  return linha;
}

export function derrubarCacheApiKeys() {
  cacheApiKey.clear();
}

/**
 * "Esta pessoa e super admin?" — resolvido PREGUICOSAMENTE e so quando a
 * politica de acesso tem algo a decidir (ver `SouSuperAdmin` em lib/acesso.ts).
 *
 * Le so a coluna `papel`, com cache de 60s: no ritmo do polling do painel
 * (3-6s), consultar `getPerfil` inteiro aqui dobraria a leitura de perfis de
 * TODA rota — e este gate nao precisa de escopo nem de permissao, so do enum.
 * O cache tem o mesmo TTL dos outros do painel (papeis, inativos, config).
 */
const papelCache = new Map<string, { eh: boolean; ts: number }>();
export function derrubarCachePapelBase(userId?: string) {
  if (userId) papelCache.delete(userId);
  else papelCache.clear();
}

async function souSuperAdmin(userId: string): Promise<boolean> {
  const c = papelCache.get(userId);
  if (c && Date.now() - c.ts < 60_000) return c.eh;
  const { data, error } = await msgDb()
    .from("perfis")
    .select("papel")
    .eq("user_id", userId)
    .maybeSingle();
  // erro de leitura NAO e cacheado como "nao e admin": seria transformar um
  // soluco de rede em rebaixamento por 60s, e e justamente o super admin que
  // precisa entrar pra consertar a politica. Serve o ultimo valor bom.
  if (error) return c?.eh ?? false;
  const eh = data?.papel === "super_admin";
  papelCache.set(userId, { eh, ts: Date.now() });
  podar(papelCache, 5_000);
  return eh;
}

/**
 * O canal deste request, resolvido DO MESMO JEITO que a rota vai resolver.
 *
 * A primeira versao disto lia so a query string e, quando nao achava, devolvia
 * null "pro gate de conversa decidir". Era FURO, e a revisao pegou: a rota
 * resolve canal ausente como `central` (lib/canal.ts, `resolver`), entao uma
 * chave restrita ao `apioficial` lia o `central` inteiro simplesmente OMITINDO
 * `?canal=`. E o comentario que dizia "quem barra e podeVerConversa" era falso:
 * podeVerConversa confere a VISIBILIDADE do usuario dono, nao o escopo da chave.
 *
 * Agora:
 *  - resolve com `canalPorId` + regra do canal inativo, igual `resolver()`;
 *  - o CORPO tem precedencia sobre a query, porque a rota que decide pelo corpo
 *    (`canalDeBody`: /api/send, /api/nota, /api/conversa...) ignora a query;
 *  - query e corpo com canais DIFERENTES = `divergente`, e o escopo NEGA. Nao
 *    da pra saber qual a rota usa, e adivinhar a favor do pedinte e contrabando.
 *
 * O clone do corpo acontece SO quando ha restricao de canal, o metodo muda
 * estado e o content-type se diz JSON — upload de foto e multipart, e ler o
 * corpo ali quebraria a rota.
 */
// A REGRA MORA EM `lib/canais.ts` (`canalDoPedido`), e nao mais aqui, por um
// motivo so: pra ser PROVAVEL sem rede. Enquanto ela era uma funcao privada desta
// porta, o furo do canal INATIVO (que afrouxava e apertava ao mesmo tempo) nao
// tinha como ser exercitado por prova nenhuma — e passou por duas revisoes. O
// porque de cada ramo esta documentado lá, junto do registro de canais.
async function canalDoRequest(req: NextRequest, precisa: boolean): Promise<CanalDoPedido> {
  if (!precisa) return { canal: null, divergente: false };
  // decidido pelo RECURSO da rota, nao por lista de caminhos: rota de canal nova
  // (`/api/canais/...`) herda a regra sem ninguem lembrar de cadastra-la
  const rotaDeCanal = recursoDaRota(req.nextUrl.pathname) === "canais";
  // A RESOLUCAO INTEIRA mora em lib/canais.ts (`canalDoPedido`) — query, corpo,
  // precedencia e divergencia. Mudou de casa na 2a revisao: enquanto ela era
  // privada daqui, a prova so conseguia exercitar o TRADUTOR (`canalParaEscopo`)
  // com o id escolhido a mao, e o furo GRAVE D1 (corpo consumido antes da porta ->
  // escopo de canal INERTE) atravessou. Lá ela e exercitada com Request de
  // verdade, inclusive o caso do corpo ja lido.
  return canalDoPedido(req, rotaDeCanal);
}

async function usuarioPorApiKey(chave: string, req: NextRequest): Promise<UsuarioLogado | null> {
  const linha = await linhaPorApiKey(chave);
  // ORACULO FECHADO (achado de revisao): chave INEXISTENTE, chave revogada e
  // chave expirada respondem a MESMA coisa, com o mesmo status. Diferenciar
  // deixava quem tem uma chave vazada descobrir, pela frase, que a chave existia
  // e foi revogada — ou seja, confirmava que o palpite estava certo. Os motivos
  // ESPECIFICOS ficam so pra chave VALIDA barrada por escopo, onde nao ha o que
  // confirmar (o portador ja provou ter a chave).
  // Um so predicado pros tres casos, no arquivo puro (`lib/recusa.ts`): e o que
  // faz a frase unica ser ESTRUTURAL, e nao promessa de comentario. Guard porque
  // daqui pra baixo o TypeScript precisa saber que a linha existe.
  if (!chaveServe(linha)) return recusar(req, RECUSA_CHAVE);

  const pedidoCanal = await canalDoRequest(req, linha.escopo.canais.length > 0);
  const veredito = escopoPermite(linha.escopo, {
    metodo: req.method,
    pathname: req.nextUrl.pathname,
    canal: pedidoCanal.canal,
    divergente: pedidoCanal.divergente,
  });
  if (!veredito.ok) return recusar(req, veredito.motivo);
  // guardado SO depois do veredito: escopo de chave recusada nao vira contexto
  escopos.set(req, linha.escopo);

  // JANELA DE ACESSO do DONO vale pra chave tambem: a chave e a pessoa agindo, e
  // uma chave vazada usada de madrugada e exatamente o que a janela existe pra
  // barrar. O escape e explicito e privativo do super admin
  // (`escopo.ignorar_janela`) — robo noturno se declara como tal.
  if (!linha.escopo.ignorar_janela) {
    const j = await acessoNaJanela(linha.user.id, () => souSuperAdmin(linha.user.id));
    if (!j.ok) return recusar(req, j.motivo);
  }

  // trilha de uso, no maximo 1 escrita a cada 2min por chave
  const ultimo = usoEm.get(linha.id) || 0;
  if (Date.now() - ultimo > 120_000) {
    usoEm.set(linha.id, Date.now());
    podar(usoEm, 2_000);
    const patch: Record<string, any> = { ultimo_uso_em: new Date().toISOString() };
    if (colunasEscopoOk) {
      patch.ultimo_uso_ip = ipDoCliente({
        forwardedFor: req.headers.get("x-forwarded-for"),
        realIp: req.headers.get("x-real-ip"),
      });
      patch.ultimo_uso_ua = (req.headers.get("user-agent") || "").slice(0, 400) || null;
    }
    await msgDb()
      .from("api_keys")
      .update(patch)
      .eq("id", linha.id)
      .then((r: any) => {
        // coluna ausente = migration 0019 pendente: grava so o que existia antes
        if (r?.error && String(r.error.code) === "42703") {
          colunasEscopoOk = false;
          colunasEscopoTs = Date.now();
          return msgDb()
            .from("api_keys")
            .update({ ultimo_uso_em: patch.ultimo_uso_em })
            .eq("id", linha.id)
            .then(() => {});
        }
      });
  }
  return linha.user;
}

// Devolve o usuario autenticado ou null. Quem envia mensagem fica registrado
// na trilha de auditoria (mensagens.enviado_por_*).
export async function getUser(req: NextRequest): Promise<UsuarioLogado | null> {
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) return usuarioPorApiKey(apiKey, req);
  return usuarioPorSessao(req);
}

/**
 * A identidade deste request veio de CHAVE DE API (MCP/agente), nao de sessao de
 * login? Mesma regra de roteamento do `getUser` acima, num lugar so — a rota que
 * precisa distinguir "gente no painel" de "robo com chave" pergunta aqui em vez
 * de reimplementar o teste do header.
 *
 * Existe porque efeito colateral de LEITURA HUMANA nao pode sair de chamada de
 * robo: `/api/send` zera o contador de nao lidas quando um atendente responde
 * (ele leu a conversa), e o agente respondendo pela chave nao leu nada.
 */
export function identidadePorApiKey(req: NextRequest): boolean {
  return !!req.headers.get("x-api-key");
}

// Identidade SO por sessao de login (Bearer), NUNCA por x-api-key. Usar nas
// rotas que gerenciam chaves de API (admin/api-keys, minha-chave): uma chave
// vazada NAO pode gerar/revogar outra chave — a gestao exige o login humano.
//
// `opts.ignorarPolitica` sai da regra de proposito e tem UM uso legitimo: a
// rota que EXPLICA por que a pessoa foi barrada (`/api/acesso`) precisa saber
// quem ela e. Nunca usar em rota que le ou escreve dado de conversa.
export async function usuarioPorSessao(
  req: NextRequest,
  opts: { ignorarPolitica?: boolean } = {}
): Promise<UsuarioLogado | null> {
  if (req.headers.get("x-api-key")) return null;
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const supa = createClient(
    process.env.NEXT_PUBLIC_AUTH_URL!,
    process.env.NEXT_PUBLIC_AUTH_ANON_KEY!,
    { auth: { persistSession: false }, global: { fetch: noStoreFetch } }
  );
  const { data, error } = await supa.auth.getUser(token);
  const u = data?.user;
  if (error || !u) return null;
  // conta desativada pelo super admin = tratada como deslogada em TODA rota
  if ((await idsInativos()).has(u.id)) return null;
  // 2FA: quem tem fator TOTP verificado so entra com sessao aal2 — e com
  // exigir_2fa ligado NINGUEM entra sem aal2 (quem nao cadastrou cai na tela
  // de cadastro forcado, que fala direto com o auth). Token de senha pura
  // (aal1) e recusado AQUI, entao a exigencia vale so neste painel
  // (o auth e compartilhado; os outros apps seguem aceitando aal1).
  const temFator = ((u as any).factors ?? []).some((f: any) => f.status === "verified");
  if (temFator || (await getConfig()).exigir_2fa) {
    let aal: string | null = null;
    try {
      aal = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString()).aal ?? null;
    } catch {}
    if (aal !== "aal2") return null;
  }

  // JANELA DE ACESSO e DISPOSITIVO REVOGADO (Frente Q, 31/08/2026).
  //
  // Mora AQUI, na porta, e nao no front, porque o login deste painel acontece
  // direto no auth compartilhado (o navegador chama signInWithPassword) — nao
  // existe handler nosso pra "recusar o login". O que existe e este gate, que
  // toda rota atravessa: fora da janela, a sessao ja aberta para de funcionar no
  // MESMO minuto, e a sessao nova nao consegue carregar nada. Barrar no front
  // seria decoracao.
  //
  // Super admin nunca e barrado (ver lib/acesso.ts) — e o que garante caminho de
  // volta quando a configuracao esta errada ou a leitura falhou.
  if (!opts.ignorarPolitica) {
    const eh = () => souSuperAdmin(u.id);
    const janela = await acessoNaJanela(u.id, eh);
    if (!janela.ok) return recusar(req, janela.motivo);
    const disp = await conferirDispositivo(u.id, eh, req);
    if (!disp.ok) return recusar(req, disp.motivo);
  }

  await marcarPresenca(u.id).catch(() => {});
  return {
    id: u.id,
    email: u.email ?? null,
    nome:
      (u.user_metadata?.nome as string) ||
          (u.user_metadata?.name as string) ||
      (u.user_metadata?.full_name as string) ||
      (u.email ? u.email.split("@")[0] : "usuario"),
  };
}

export async function requireUser(req: NextRequest): Promise<boolean> {
  return (await getUser(req)) !== null;
}
