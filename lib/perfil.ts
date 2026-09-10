import { msgDb } from "@/lib/mensageria";
import type { UsuarioLogado } from "@/lib/auth-server";
import {
  PREFERENCIAS_PADRAO,
  mesclarPreferencias,
  sanitizarPreferencias,
  type Preferencias,
} from "@/lib/perfil-conta";
import {
  escopoComTeto,
  permissoesEfetivas,
  pode,
  validarEscopo,
  validarPermissoes,
  type Permissao,
} from "@/lib/permissoes";

export type Perfil = {
  papel: "super_admin" | "normal";
  escopo_visao: "proprias" | "departamento" | "todas";
  tema: "claro" | "escuro";
  // Papel NOMEADO (mensageria.papeis). null = instalacao que nunca configurou
  // papel — segue no comportamento anterior, via fallback embutido.
  papel_id: string | null;
  papel_nome: string | null;
  // Permissoes JA calculadas (papel + excecoes individuais). Ler daqui, sempre
  // por `permitido()`; nunca refazer a conta na rota.
  permissoes: Set<Permissao>;
};

const PADRAO: Perfil = {
  papel: "normal",
  escopo_visao: "todas",
  tema: "claro",
  papel_id: null,
  papel_nome: null,
  permissoes: new Set(),
};
const PERMISSIVIDADE = { proprias: 0, departamento: 1, todas: 2 } as const;

// Usuarios desativados pelo super admin. Cache de 60s: o polling bate a cada
// 3-6s e a desativacao pode custar ate 1min pra derrubar quem ja esta logado
// (o ban no auth ja impede login novo na hora).
let inativosCache: { set: Set<string>; ts: number } | null = null;
export async function idsInativos(): Promise<Set<string>> {
  if (inativosCache && Date.now() - inativosCache.ts < 60_000) return inativosCache.set;
  const { data } = await msgDb().from("perfis").select("user_id").eq("ativo", false);
  const set = new Set((data ?? []).map((p) => p.user_id as string));
  inativosCache = { set, ts: Date.now() };
  return set;
}
export function derrubarCacheInativos() {
  inativosCache = null;
}

// Leitura da linha de perfis TOLERANTE a migration 0010 nao ter rodado ainda.
//
// Por que isso importa tanto: se o select inteiro falhar por causa de coluna
// inexistente, `data` vem null e o perfil cai no PADRAO — que e normal+todas.
// Isso rebaixaria super admin E promoveria quem tem escopo "proprias" a ver a
// conta inteira. Entao: tenta o select largo; se ele der erro, cai no select
// ANTIGO (identico ao de antes desta feature) e marca pra nao insistir a cada
// request. Reavalia a cada 60s, porque a migration pode rodar com o app no ar.
type LinhaPerfil = {
  papel?: unknown;
  escopo_visao?: unknown;
  tema?: unknown;
  papel_id?: unknown;
  permissoes_excecao?: unknown;
};
let colunasPapelOk = true;
let colunasPapelTs = 0;

async function lerLinhaPerfil(userId: string): Promise<LinhaPerfil | null> {
  const db = msgDb();
  if (!colunasPapelOk && Date.now() - colunasPapelTs > 60_000) colunasPapelOk = true;
  if (colunasPapelOk) {
    const r = await db
      .from("perfis")
      .select("papel,escopo_visao,tema,papel_id,permissoes_excecao")
      .eq("user_id", userId)
      .maybeSingle();
    if (!r.error) return r.data as LinhaPerfil | null;
    colunasPapelOk = false;
    colunasPapelTs = Date.now();
  }
  const r2 = await db.from("perfis").select("papel,escopo_visao,tema").eq("user_id", userId).maybeSingle();
  return r2.data as LinhaPerfil | null;
}

// Catalogo de papeis (tabela pequena) — cache de 60s, no mesmo ritmo dos outros
// caches do painel. `null` = NAO FOI POSSIVEL LER (migration pendente ou falha
// transitoria) e e semanticamente diferente de "papel nao encontrado": no
// primeiro caso o usuario volta pro fallback embutido (o comportamento de
// sempre); no segundo, fail-closed com zero permissao.
type PapelRow = { permissoes: Permissao[]; ativo: boolean; nome: string };
let papeisCache: { map: Map<string, PapelRow>; ts: number } | null = null;

async function getPapeis(): Promise<Map<string, PapelRow> | null> {
  if (papeisCache && Date.now() - papeisCache.ts < 60_000) return papeisCache.map;
  const { data, error } = await msgDb().from("papeis").select("id,nome,permissoes,ativo");
  // Falha de leitura NAO pode virar "sem papel nomeado" (isso era fail-OPEN:
  // devolvia a pessoa ao embutido `normal`, dando enviar/concluir/disparo a um
  // "Somente leitura"). Serve o ULTIMO cache bom, mesmo vencido; se nunca deu
  // certo, devolve null e quem tem papel_id cai em fail-closed no getPerfil.
  if (error) return papeisCache?.map ?? null;
  const map = new Map<string, PapelRow>();
  for (const p of data ?? []) {
    map.set(p.id as string, {
      nome: String(p.nome ?? ""),
      ativo: p.ativo !== false,
      permissoes: validarPermissoes(p.permissoes),
    });
  }
  papeisCache = { map, ts: Date.now() };
  return map;
}

export function derrubarCachePapeis() {
  papeisCache = null;
}

// Perfil EFETIVO de permissao: regra de DEPARTAMENTO (departamentos.escopo_visao)
// vale pra todos os membros e substitui a individual; com mais de um dep com
// regra, vence a mais permissiva. Sem regra de dep = escopo do proprio perfil.
// Sem linha em perfis = aberto (todas), igual o painel era antes.
//
// Desde 31/08 tambem resolve as PERMISSOES: papel nomeado (se houver) +
// excecoes individuais, e o teto de visibilidade que o papel impoe.
export async function getPerfil(userId: string): Promise<Perfil> {
  const db = msgDb();
  const [data, { data: vinculos }] = await Promise.all([
    lerLinhaPerfil(userId),
    db.from("departamento_membros").select("departamento_id").eq("user_id", userId),
  ]);
  const base: Perfil = !data
    ? { ...PADRAO, permissoes: new Set() }
    : {
        papel: data.papel === "super_admin" ? "super_admin" : "normal",
        escopo_visao: validarEscopo(data.escopo_visao),
        tema: data.tema === "escuro" ? "escuro" : "claro",
        papel_id: typeof data.papel_id === "string" ? data.papel_id : null,
        papel_nome: null,
        permissoes: new Set(),
      };

  // 1) escopo de visao — a regra de departamento, exatamente como antes
  let escopo = base.escopo_visao;
  if (base.papel !== "super_admin" && vinculos?.length) {
    const { data: deps } = await db
      .from("departamentos")
      .select("escopo_visao")
      .in("id", vinculos.map((v) => v.departamento_id))
      .not("escopo_visao", "is", null);
    const regras = (deps ?? [])
      .map((d) => d.escopo_visao as Perfil["escopo_visao"])
      .filter((e) => e in PERMISSIVIDADE);
    if (regras.length) escopo = regras.sort((a, b) => PERMISSIVIDADE[b] - PERMISSIVIDADE[a])[0];
  }

  // 2) permissoes — papel nomeado, se der pra ler o catalogo
  let papelPermissoes: Permissao[] | null = null;
  let papelNome: string | null = null;
  // catalogo ilegivel COM papel_id setado: nao da pra saber o que a pessoa
  // pode, e o papel existe justamente pra restringir — degrada pro minimo.
  let catalogoIndisponivel = false;
  if (base.papel !== "super_admin" && base.papel_id) {
    const papeis = await getPapeis();
    if (papeis) {
      const p = papeis.get(base.papel_id);
      // papel apagado ou desativado = fail-closed (zero permissao), NUNCA
      // silenciosamente de volta pro embutido: quem desativa um papel esta
      // tirando acesso de proposito.
      papelPermissoes = p && p.ativo ? p.permissoes : [];
      papelNome = p?.nome ?? null;
    } else {
      // FAIL-CLOSED (corrigido 31/08): antes isto caia no embutido `normal`, e
      // por ate 60s um "Somente leitura" ganhava enviar/concluir/disparo e um
      // "Atendente" com escopo_visao=todas antigo na coluna recuperava a visao
      // total. Falha de leitura nunca pode devolver privilegio.
      //
      // ALCANCE EXATO: zera as permissoes DO PAPEL. As excecoes individuais
      // (perfis.permissoes_excecao) continuam valendo — sao concessao explicita
      // do admin, gravada naquela pessoa, e nao dependem do catalogo pra serem
      // lidas. Quem concede excecao esta dizendo "esta pessoa pode isto,
      // independente do papel", e nao ha por que revogar isso numa falha de
      // leitura de outra tabela.
      papelPermissoes = [];
      catalogoIndisponivel = true;
    }
  }

  const permissoes = permissoesEfetivas({
    papel: base.papel,
    escopo_visao: escopo,
    papelPermissoes,
    excecoes: data?.permissoes_excecao,
  });

  return {
    ...base,
    escopo_visao: catalogoIndisponivel
      ? "proprias"
      : escopoComTeto(escopo, permissoes, papelPermissoes !== null),
    papel_nome: papelNome,
    permissoes,
  };
}

export function ehAdmin(perfil: Perfil) {
  return perfil.papel === "super_admin";
}

// Gate unico de permissao nomeada. Fail-closed: ausente = negado.
// Super admin passa em tudo (permissoesEfetivas ja devolve a lista inteira).
export function permitido(perfil: Perfil, permissao: Permissao): boolean {
  return pode(perfil.permissoes, permissao);
}

// ---------------------------------------------------------------- Meu perfil
// Foto do atendente e preferencias de aviso (migration 0011). As colunas podem
// AINDA nao existir na instalacao — rodar migration e gesto humano. Enquanto
// nao existem, o painel segue de pe com os defaults e `disponivel: false`
// (nunca 500), mesma convencao de /api/macros antes da 0008.
export type ContaPerfil = {
  foto_url: string | null;
  preferencias: Preferencias;
  assinatura_ativa: boolean;
  assinatura_nome: string;
  // false = colunas de 0011 ausentes: leitura devolve default e escrita e recusada
  disponivel: boolean;
  // true = a leitura FALHOU (banco fora, permissao, timeout). Os valores acima
  // sao default, NAO o que esta gravado — entao escrita que mescle sobre eles
  // (preferencia, assinatura) tem que ser RECUSADA: mesclar patch sobre default
  // religaria em silencio o que a pessoa tinha desligado.
  erroLeitura: boolean;
};

const CONTA_PADRAO: Omit<ContaPerfil, "disponivel" | "erroLeitura"> = {
  foto_url: null,
  preferencias: { ...PREFERENCIAS_PADRAO },
  assinatura_ativa: false,
  assinatura_nome: "",
};

// "coluna nao existe" no PostgREST. Re-testa a cada 60s: assim, no minuto
// seguinte a migration rodar, o painel passa a gravar sem redeploy.
const COL_INEXISTENTE = "42703";
let semColunas = 0;
function marcarSemColunas() {
  semColunas = Date.now();
}
export function colunasPerfil0011Ausentes(): boolean {
  return Date.now() - semColunas < 60_000;
}

export async function contaDoUsuario(userId: string): Promise<ContaPerfil> {
  if (colunasPerfil0011Ausentes()) {
    const { data, error } = await msgDb()
      .from("perfis")
      .select("assinatura_ativa,assinatura_nome")
      .eq("user_id", userId)
      .maybeSingle();
    return {
      ...CONTA_PADRAO,
      assinatura_ativa: data?.assinatura_ativa === true,
      assinatura_nome: data?.assinatura_nome || "",
      disponivel: false,
      erroLeitura: !!error,
    };
  }
  const { data, error } = await msgDb()
    .from("perfis")
    .select("foto_url,preferencias,assinatura_ativa,assinatura_nome")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    if ((error as any).code === COL_INEXISTENTE) {
      marcarSemColunas();
      return contaDoUsuario(userId);
    }
    // Erro de banco de verdade (nao e "coluna nao existe"): devolve o padrao
    // MARCADO como leitura falha. Quem escreve tem que recusar — o que esta
    // aqui nao e o que a pessoa gravou.
    return { ...CONTA_PADRAO, disponivel: true, erroLeitura: true };
  }
  return {
    foto_url: typeof data?.foto_url === "string" && data.foto_url ? data.foto_url : null,
    preferencias: sanitizarPreferencias(data?.preferencias),
    assinatura_ativa: data?.assinatura_ativa === true,
    assinatura_nome: data?.assinatura_nome || "",
    disponivel: true,
    erroLeitura: false,
  };
}

// Foto de VARIOS usuarios (mapa user_id -> url) pras telas que mostram atendente.
// Sem a coluna, devolve mapa vazio — a UI cai nas iniciais, como sempre foi.
export async function fotosDeUsuarios(ids?: string[]): Promise<Record<string, string>> {
  if (colunasPerfil0011Ausentes()) return {};
  let q = msgDb().from("perfis").select("user_id,foto_url").not("foto_url", "is", null);
  if (ids?.length) q = q.in("user_id", ids.slice(0, 500));
  const { data, error } = await q;
  if (error) {
    if ((error as any).code === COL_INEXISTENTE) marcarSemColunas();
    return {};
  }
  const mapa: Record<string, string> = {};
  for (const p of data ?? []) if (p.foto_url) mapa[p.user_id as string] = p.foto_url as string;
  return mapa;
}

// Preferencias de VARIOS usuarios (mapa user_id -> Preferencias) pra tela de
// admin mostrar/ligar o modo supervisor de cada pessoa. Consulta SEPARADA da de
// perfis de proposito, igual `fotosDeUsuarios`: sem a migration 0011 a coluna
// nao existe, e juntar no select principal derrubaria a tela inteira.
export async function preferenciasDeUsuarios(ids?: string[]): Promise<Record<string, Preferencias>> {
  if (colunasPerfil0011Ausentes()) return {};
  let q = msgDb().from("perfis").select("user_id,preferencias");
  if (ids?.length) q = q.in("user_id", ids.slice(0, 500));
  const { data, error } = await q;
  if (error) {
    if ((error as any).code === COL_INEXISTENTE) marcarSemColunas();
    return {};
  }
  const mapa: Record<string, Preferencias> = {};
  for (const p of data ?? []) mapa[p.user_id as string] = sanitizarPreferencias(p.preferencias);
  return mapa;
}

/**
 * Grava um PATCH nas preferencias de outra pessoa (tela de admin).
 *
 * Read-modify-write de proposito: `preferencias` e UM jsonb com varias chaves, e
 * gravar o objeto inteiro apagaria o que o dono da conta escolheu (som, aviso de
 * desktop). Mescla por `mesclarPreferencias`, que so aceita booleano de verdade.
 *
 * Devolve mensagem de erro legivel, ou null quando gravou.
 */
export async function salvarPreferenciasDeOutro(
  userId: string,
  patch: Partial<Preferencias>
): Promise<string | null> {
  const { data, error } = await msgDb()
    .from("perfis")
    .select("preferencias")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    if ((error as any).code === COL_INEXISTENTE) {
      marcarSemColunas();
      return "preferencias indisponiveis — rode a migration 0011_perfil_preferencias.sql";
    }
    // leitura falhou: NAO mesclar sobre default (religaria em silencio o que a
    // pessoa tinha desligado — mesma disciplina de /api/perfil)
    return "nao consegui ler as preferencias dessa pessoa agora, entao nao salvei nada";
  }
  const novo = mesclarPreferencias(data?.preferencias, patch);
  const up = await msgDb()
    .from("perfis")
    .upsert({ user_id: userId, preferencias: novo, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (up.error) {
    if ((up.error as any).code === COL_INEXISTENTE) {
      marcarSemColunas();
      return "preferencias indisponiveis — rode a migration 0011_perfil_preferencias.sql";
    }
    return up.error.message;
  }
  return null;
}

// O predicado de visibilidade e os tipos dele (inclusive Responsavel) moram
// em lib/visibilidade.ts
// (arquivo PURO, provavel em node solto). Re-exportados aqui porque as rotas
// importam tudo de "@/lib/perfil" — nada muda pra quem consome.
export {
  conversaVisivel,
  restricaoPermite,
  restricaoVazia,
  type Responsavel,
  type ContextoVisao,
  type VisibilidadeEntry,
  type PerfilVisao,
  type RestricaoUsuario,
  type AlvoConversa,
  type RestricaoAplicada,
} from "@/lib/visibilidade";
import type { ContextoVisao, RestricaoAplicada } from "@/lib/visibilidade";
import { conversaVisivel, restricaoVazia } from "@/lib/visibilidade";
import type { Responsavel, VisibilidadeEntry } from "@/lib/visibilidade";

export async function contextoVisao(user: UsuarioLogado, perfil: Perfil): Promise<ContextoVisao> {
  const vazio: ContextoVisao = { meusDeps: new Set(), colegas: new Set() };
  if (perfil.papel === "super_admin") return vazio;
  const db = msgDb();
  // meusDeps carrega pra TODO usuario normal (a ACL de visibilidade por chat
  // casa entradas tipo departamento mesmo com escopo proprias/todas)
  const { data: meus } = await db
    .from("departamento_membros")
    .select("departamento_id")
    .eq("user_id", user.id);
  const meusDeps = new Set((meus ?? []).map((m) => m.departamento_id));
  // colegas so importa pro escopo "departamento"
  if (perfil.escopo_visao !== "departamento" || !meusDeps.size) {
    return { meusDeps, colegas: new Set() };
  }
  const { data: todos } = await db
    .from("departamento_membros")
    .select("departamento_id,user_id")
    .in("departamento_id", Array.from(meusDeps));
  return { meusDeps, colegas: new Set((todos ?? []).map((m) => m.user_id)) };
}

// Gate pontual: este usuario pode ver/agir NESTA conversa (do canal informado)?
export async function podeVerConversa(
  chatId: string,
  user: UsuarioLogado,
  perfil: Perfil,
  canal: string = "central"
): Promise<boolean> {
  if (perfil.papel === "super_admin") return true;
  // tabela de conversas PELO registro de canais (lib/canais.ts); fonte externa nao
  // tem linha no painel — status vale "aberto", como /api/chats ja devolve
  const { tabelas } = await import("@/lib/canal");
  const { somenteLeitura, canalPorId, fonteExterna } = await import("@/lib/canais");
  const { vinculosBu } = await import("@/lib/embed");
  const [{ data }, { data: conv }, { data: vis }, vinculos, ctx, restr] = await Promise.all([
    msgDb().from("conversa_responsaveis").select("tipo,ref_id").eq("chat_id", chatId).eq("canal", canal),
    somenteLeitura(canal)
      ? Promise.resolve({ data: { status: "aberto" } as { status: string } | null })
      : msgDb().from(tabelas(canal).conversas).select("status").eq("chat_id", chatId).maybeSingle(),
    msgDb().from("conversa_visibilidade").select("tipo,ref_id").eq("chat_id", chatId).eq("canal", canal),
    vinculosBu(user.id, false),
    contextoVisao(user, perfil),
    // RESTRICAO por funil/canal (Frente Q). No caso normal (ninguem restrito)
    // isto sai do mapa em cache e nao custa consulta nenhuma.
    restricaoAplicadaNaConversa(user.id, canal, chatId),
  ]);
  return conversaVisivel(
    (data ?? []) as Responsavel[],
    user,
    perfil,
    ctx,
    // canal externo sem linha de estado ainda: e uma conversa ABERTA (a linha
    // nasce na primeira acao), nunca "inexistente"
    conv?.status ?? (canalPorId(canal) && fonteExterna(canalPorId(canal)!) ? "aberto" : null),
    (vis ?? []) as VisibilidadeEntry[],
    vinculos,
    restr
  );
}

/**
 * O par {restricao, alvo} de UMA conversa, pronto pro predicado.
 *
 * O funil da conversa so e consultado quando a pessoa esta restrita POR FUNIL —
 * sem isso, `alvo.funilIds` seria uma consulta paga em todo request pra nada.
 * Falha na leitura dos funis devolve `alvo: null`, que no predicado NEGA
 * (fail-closed: restricao por funil que nao da pra avaliar nao pode liberar).
 */
export async function restricaoAplicadaNaConversa(
  userId: string,
  canal: string,
  chatId: string
): Promise<RestricaoAplicada | null> {
  const { restricaoDeConversas, funisDasConversas } = await import("@/lib/acesso");
  // super admin ja passa na camada 1 do predicado; aqui basta nao restringir
  const restricao = await restricaoDeConversas(userId, false);
  if (!restricao || restricaoVazia(restricao)) return null;
  if (!restricao.funis.length) {
    return { restricao, alvo: { canal, funilIds: [] } };
  }
  const mapa = await funisDasConversas([{ canal, chatId }]);
  if (!mapa) return { restricao, alvo: null };
  return { restricao, alvo: { canal, funilIds: mapa.get(`${canal}|${chatId}`) ?? [] } };
}
