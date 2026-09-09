import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { msgDb } from "@/lib/mensageria";
import type { UsuarioLogado } from "@/lib/auth-server";
import type { Perfil } from "@/lib/perfil";

// Widget embutido (F1): o hospedeiro (portal do aluno, app de eventos, admin
// do Super SDR...) cunha um token de vida curta que so RESTRINGE a visao de
// um usuario ja autenticado no painel (2FA mantido) — vazou token = ve MENOS,
// nunca mais. JWT HS256 manual (sem dependencia nova): header.payload.assinatura
// em base64url, {ctx, exp, jti} no payload.

type FiltroEmbed = { tipo?: string; valor?: unknown };

export type ContextoEmbed = {
  id: string;
  // chatId de grupo (contem "-group") nunca passa; resto compara digits
  // aceitando variante BR com/sem o nono digito.
  permite(chatId: string): boolean;
};

function base64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

// Assina o token de contexto. exp em segundos de vida (default 8h — turno).
export function assinarTokenContexto(contextoId: string, expSegundos = 8 * 3600): string {
  const secret = process.env.EMBED_JWT_SECRET;
  if (!secret) throw new Error("EMBED_JWT_SECRET nao configurado");
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    ctx: contextoId,
    exp: Math.floor(Date.now() / 1000) + expSegundos,
    jti: randomUUID(),
  };
  const dados = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const assinatura = createHmac("sha256", secret).update(dados).digest("base64url");
  return `${dados}.${assinatura}`;
}

// Confere assinatura (tempo constante) e validade; devolve o contexto_id ou null.
export function validarTokenContexto(token: string): string | null {
  const secret = process.env.EMBED_JWT_SECRET;
  if (!secret || !token) return null;
  const partes = token.split(".");
  if (partes.length !== 3) return null;
  const [h, p, s] = partes;
  try {
    const esperado = createHmac("sha256", secret).update(`${h}.${p}`).digest();
    const recebido = Buffer.from(s, "base64url");
    if (esperado.length !== recebido.length) return null;
    if (!timingSafeEqual(esperado, recebido)) return null;
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    if (typeof payload?.ctx !== "string" || !payload.ctx) return null;
    if (typeof payload?.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.ctx;
  } catch {
    return null;
  }
}

// Variantes BR do numero (digits-only): 55 + DDD(2) + 8 ou 9 digitos. Devolve
// as DUAS formas (com e sem o nono digito) quando o formato bate; senao devolve
// so o proprio valor (numero fora do padrao BR, ex: instancia internacional).
function variantesBr(digitsRaw: string): string[] {
  const digits = String(digitsRaw || "").replace(/\D/g, "");
  const m = /^55(\d{2})(\d{8,9})$/.exec(digits);
  if (!m) return digits ? [digits] : [];
  const [, ddd, resto] = m;
  if (resto.length === 9) return [digits, `55${ddd}${resto.slice(1)}`];
  return [digits, `55${ddd}9${resto}`];
}

// Cache em memoria de 60s POR CONTEXTO (mesmo padrao do cache de lib/config.ts).
const cacheContextos = new Map<string, { ctx: ContextoEmbed; ts: number }>();

export function derrubarCacheEmbed(contextoId?: string) {
  if (contextoId) cacheContextos.delete(contextoId);
  else cacheContextos.clear();
}

// Carrega o contexto SO por id (sem token/assinatura) — usado tanto pelo
// widget (apos validar o JWT) quanto pela restricao de BU por vinculo direto.
// Mesmo cache de 60s por contexto_id; so=ativo, senao null (contexto apagado/
// desligado nunca fica "aberto" por engano).
async function carregarContextoPorId(contextoId: string): Promise<ContextoEmbed | null> {
  const cached = cacheContextos.get(contextoId);
  if (cached && Date.now() - cached.ts < 60_000) return cached.ctx;

  const db = msgDb();
  const { data: contexto } = await db
    .from("embed_contextos")
    .select("id,filtro")
    .eq("id", contextoId)
    .eq("ativo", true)
    .maybeSingle();
  if (!contexto) return null;

  const filtro = (contexto.filtro || {}) as FiltroEmbed;
  const telefones = new Set<string>();
  if (filtro.tipo === "allowlist") {
    // paginado: o PostgREST trunca CALADO em 1000 linhas — allowlist de alunos passa disso
    for (let de = 0; ; de += 1000) {
      const { data: allow } = await db
        .from("embed_allowlist")
        .select("telefone_digits")
        .eq("contexto_id", contextoId)
        .range(de, de + 999);
      for (const row of allow ?? []) {
        for (const v of variantesBr(String(row.telefone_digits || ""))) telefones.add(v);
      }
      if (!allow || allow.length < 1000) break;
    }
  }

  // Grupos do contexto (F9): grupo nao tem telefone — entra na BU quando foi
  // taggeado em conversa_visibilidade com uma entrada tipo 'contexto' desta BU
  // (qualquer canal; chat_id e unico o bastante). Teto largo por seguranca.
  const grupos = new Set<string>();
  const { data: gruposTag } = await db
    .from("conversa_visibilidade")
    .select("chat_id")
    .eq("tipo", "contexto")
    .eq("ref_id", contextoId)
    .range(0, 4999);
  for (const g of gruposTag ?? []) grupos.add(String(g.chat_id));

  const ctx: ContextoEmbed = {
    id: contextoId,
    permite(chatId: string) {
      if (!chatId) return false;
      if (grupos.has(chatId)) return true;
      if (chatId.includes("-group")) return false;
      // v1 so implementa filtro tipo 'allowlist'; outro tipo = nada liberado
      if (filtro.tipo !== "allowlist") return false;
      return variantesBr(chatId).some((v) => telefones.has(v));
    },
  };
  cacheContextos.set(contextoId, { ctx, ts: Date.now() });
  return ctx;
}

// Le o header x-embed-token (nunca query param). Ausente = request normal do
// painel (null); presente e invalido/expirado = "invalido"; valido = contexto
// carregado (so ativo=true) com a allowlist pronta pra permite().
export async function contextoEmbed(req: NextRequest): Promise<ContextoEmbed | null | "invalido"> {
  const token = req.headers.get("x-embed-token");
  if (!token) return null;
  const contextoId = validarTokenContexto(token);
  if (!contextoId) return "invalido";
  const ctx = await carregarContextoPorId(contextoId);
  return ctx ?? "invalido";
}

// Permissao por BU (16/08/2026): vinculo do admin em mensageria.perfil_contextos
// (user_id + contexto_id). Super admin ou usuario SEM vinculo = null (sem
// restricao, comportamento de sempre). Com vinculo, permite() e a UNIAO das
// allowlists dos contextos ATIVOS vinculados. Vinculado mas com TODOS os
// contextos inativos/apagados = fail-closed (permite() sempre false, nunca
// abre por omissao). Cache em memoria de 60s POR userId.
const cacheRestricaoUsuario = new Map<string, { val: ContextoEmbed | null; ts: number }>();
const cacheVinculosIds = new Map<string, { ids: string[] | null; ts: number }>();

export function derrubarCacheRestricao(userId?: string) {
  if (userId) {
    cacheRestricaoUsuario.delete(userId);
    cacheVinculosIds.delete(userId);
  } else {
    cacheRestricaoUsuario.clear();
    cacheVinculosIds.clear();
  }
}

// Ids das BUs vinculadas ao usuario (perfil_contextos), cru — usado pela ACL
// de visibilidade por chat (lib/perfil.ts) pra casar entradas tipo 'contexto'.
// null = SEM vinculo (irrestrito) ou super admin. Cache 60s por userId.
export async function vinculosBu(userId: string, ehSuperAdmin: boolean): Promise<string[] | null> {
  if (ehSuperAdmin) return null;
  const cached = cacheVinculosIds.get(userId);
  if (cached && Date.now() - cached.ts < 60_000) return cached.ids;
  const { data } = await msgDb().from("perfil_contextos").select("contexto_id").eq("user_id", userId);
  const ids = data?.length ? Array.from(new Set(data.map((v) => String(v.contexto_id)))) : null;
  cacheVinculosIds.set(userId, { ids, ts: Date.now() });
  return ids;
}

export async function restricaoDoUsuario(
  userId: string,
  ehSuperAdmin: boolean
): Promise<ContextoEmbed | null> {
  if (ehSuperAdmin) return null;
  const cached = cacheRestricaoUsuario.get(userId);
  if (cached && Date.now() - cached.ts < 60_000) return cached.val;

  const db = msgDb();
  const { data: vinculos } = await db
    .from("perfil_contextos")
    .select("contexto_id")
    .eq("user_id", userId);
  if (!vinculos?.length) {
    cacheRestricaoUsuario.set(userId, { val: null, ts: Date.now() });
    return null;
  }

  const ids = Array.from(new Set(vinculos.map((v) => String(v.contexto_id))));
  const carregados = await Promise.all(ids.map((id) => carregarContextoPorId(id)));
  const ativos = carregados.filter((c): c is ContextoEmbed => c !== null);

  const val: ContextoEmbed = {
    id: `uniao:${userId}`,
    permite(chatId: string) {
      // vinculado mas nenhum contexto ativo restou: fail-closed, nunca libera
      if (!ativos.length) return false;
      return ativos.some((c) => c.permite(chatId));
    },
  };
  cacheRestricaoUsuario.set(userId, { val, ts: Date.now() });
  return val;
}

// Combina o contexto do HEADER (widget/visao escolhida na tela) com o VINCULO
// de BU do usuario (imposto pelo admin) — INTERSECAO: cada um so restringe,
// nunca amplia. Ambos ausentes = null (sem restricao nenhuma, igual antes desta
// feature). Header invalido/expirado propaga "invalido" (mesmo gate de sempre).
export async function restricaoEfetiva(
  req: NextRequest,
  user: UsuarioLogado,
  perfil: Perfil
): Promise<{ permite(chatId: string): boolean } | null | "invalido"> {
  const header = await contextoEmbed(req);
  if (header === "invalido") return "invalido";
  const vinculo = await restricaoDoUsuario(user.id, perfil.papel === "super_admin");
  if (!header && !vinculo) return null;
  return {
    permite(chatId: string) {
      if (header && !header.permite(chatId)) return false;
      if (vinculo && !vinculo.permite(chatId)) return false;
      return true;
    },
  };
}
