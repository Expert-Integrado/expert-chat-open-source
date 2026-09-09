import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { usuarioPorSessao, derrubarCacheApiKeys } from "@/lib/auth-server";
import { getPerfil } from "@/lib/perfil";
import { canalPorId } from "@/lib/canais";
import {
  DESCRICAO_RECURSO,
  RECURSOS,
  TIPOS_CHAVE,
  chaveExpirada,
  mesclarEscopo,
  resumoEscopo,
  rotuloValido,
  validarEscopoChave,
} from "@/lib/escopo-chave";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Chaves de API por usuario (F11): gestao SO por super admin logado ou pelo
// Bearer do sync (server-a-server, pra frota provisionar chave por script).
// A chave plaintext (prefixo eck_) aparece UMA unica vez, na resposta do POST
// — no banco vive apenas o sha256.
//
// Frente Q (31/08/2026, card 86ak85899) — o que entrou aqui:
//   escopo por chave (somente leitura / recursos / canais), tipo e rotulo,
//   expiracao, revogacao com trilha de quem revogou e leitura do ultimo uso
//   (quando, de qual IP, com qual cliente). REGRA-MAE: escopo so RESTRINGE —
//   a chave nunca vale mais que o dono. `escopo` vazio = comportamento de hoje.
//   `ignorar_janela` (a chave trabalha fora da janela de acesso do dono) e a
//   UNICA dimensao que afrouxa e por isso vive so aqui, no caminho de super
//   admin; o autoatendimento de /api/minha-chave zera esse campo.
//
// Sem a migration 0019 as colunas novas nao existem: a leitura cai no select
// antigo com `escopo_disponivel:false` e a escrita de escopo devolve 400 com a
// frase certa, em vez de fingir que salvou.

const AVISO_SEM_COLUNAS =
  "escopo de chave indisponivel nesta instalacao — rode a migration 0019_seguranca_conta.sql";

function semColuna(erro: any): boolean {
  return !!erro && ["42703", "42P01"].includes(String(erro.code));
}

async function autorizado(req: NextRequest): Promise<boolean> {
  const segredo = process.env.CHATGURU_SYNC_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (segredo && auth.startsWith("Bearer ")) {
    const recebido = Buffer.from(auth.slice(7));
    const esperado = Buffer.from(segredo);
    if (recebido.length === esperado.length && timingSafeEqual(recebido, esperado)) return true;
  }
  // gestao de chaves NUNCA por x-api-key: chave nao cunha nem revoga chave
  const user = await usuarioPorSessao(req);
  if (!user) return false;
  return (await getPerfil(user.id)).papel === "super_admin";
}

/** Quem esta operando, quando for gente logada (o bearer do sync nao tem nome). */
async function ator(req: NextRequest) {
  return usuarioPorSessao(req);
}

/**
 * Prazo: aceita ISO ou "YYYY-MM-DD". `null` remove o prazo.
 * Data no passado e recusada — gravar chave nascida vencida e sempre erro de
 * digitacao, e o sintoma (chave que nunca funciona) e caro de diagnosticar.
 */
function validarPrazo(bruto: unknown): { ok: true; valor: string | null } | { ok: false; erro: string } {
  if (bruto === undefined) return { ok: true, valor: undefined as any };
  if (bruto === null || bruto === "") return { ok: true, valor: null };
  if (typeof bruto !== "string") return { ok: false, erro: "expira_em precisa ser uma data ou null" };
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(bruto.trim()) ? `${bruto.trim()}T23:59:59` : bruto.trim();
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { ok: false, erro: "expira_em nao e uma data valida" };
  if (t <= Date.now()) return { ok: false, erro: "expira_em precisa ser no futuro" };
  return { ok: true, valor: new Date(t).toISOString() };
}

export async function GET(req: NextRequest) {
  if (!(await autorizado(req))) return NextResponse.json({ error: "somente super admin" }, { status: 403 });
  const largo = await msgDb()
    .from("api_keys")
    .select(
      "id,user_id,nome,tipo,rotulo,escopo,expira_em,ativo,revogado_em,revogado_por_nome,criado_em,ultimo_uso_em,ultimo_uso_ip,ultimo_uso_ua"
    )
    .order("criado_em", { ascending: false });
  const catalogo = {
    recursos: RECURSOS.map((r) => ({ id: r, descricao: DESCRICAO_RECURSO[r] })),
    tipos: TIPOS_CHAVE,
  };
  if (largo.error) {
    if (!semColuna(largo.error)) {
      return NextResponse.json({ error: largo.error.message }, { status: 500 });
    }
    const antigo = await msgDb()
      .from("api_keys")
      .select("id,user_id,nome,ativo,criado_em,ultimo_uso_em")
      .order("criado_em", { ascending: false });
    if (antigo.error) return NextResponse.json({ error: antigo.error.message }, { status: 500 });
    return NextResponse.json(
      { chaves: antigo.data ?? [], escopo_disponivel: false, aviso: AVISO_SEM_COLUNAS, ...catalogo },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }
  const chaves = (largo.data ?? []).map((k: any) => {
    const escopo = validarEscopoChave(k.escopo);
    return {
      ...k,
      escopo,
      escopo_resumo: resumoEscopo(escopo),
      expirada: chaveExpirada(k.expira_em),
      revogada: !!k.revogado_em,
      // vale de verdade? A tela nao deve mostrar "ativa" pra chave vencida.
      valendo: k.ativo !== false && !k.revogado_em && !chaveExpirada(k.expira_em),
    };
  });
  return NextResponse.json(
    { chaves, escopo_disponivel: true, ...catalogo },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  if (!(await autorizado(req))) return NextResponse.json({ error: "somente super admin" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const id = typeof body?.id === "string" ? body.id.trim() : "";

  // ————— EDICAO de chave existente: escopo, tipo/rotulo e prazo.
  // O SEGREDO nunca muda (nao ha como: o painel guarda so o hash) — trocar de
  // escopo nao exige gerar chave nova, que e o que faria o consumidor quebrar.
  if (id) return editar(req, id, body);

  const userId = typeof body?.user_id === "string" ? body.user_id.trim() : "";
  const nome = typeof body?.nome === "string" ? body.nome.trim().slice(0, 120) : "";
  if (!userId || !nome) {
    return NextResponse.json({ error: "user_id e nome obrigatorios" }, { status: 400 });
  }
  // dono precisa existir e estar ativo no painel
  const { data: perfil } = await msgDb().from("perfis").select("user_id,ativo").eq("user_id", userId).maybeSingle();
  if (!perfil || perfil.ativo === false) {
    return NextResponse.json({ error: "usuario inexistente ou desativado" }, { status: 400 });
  }

  const escopo = validarEscopoChave(body?.escopo);
  const canalRuim = escopo.canais.filter((c) => !canalPorId(c));
  if (canalRuim.length) {
    return NextResponse.json({ error: `canal inexistente: ${canalRuim.join(", ")}` }, { status: 400 });
  }
  const prazo = validarPrazo(body?.expira_em);
  if (!prazo.ok) return NextResponse.json({ error: prazo.erro }, { status: 400 });

  const chave = `eck_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(chave).digest("hex");
  const linha: Record<string, any> = { user_id: userId, nome, key_hash: keyHash };
  const linhaLarga = {
    ...linha,
    escopo,
    tipo: rotuloValido(body?.tipo, 40),
    rotulo: rotuloValido(body?.rotulo),
    expira_em: prazo.valor ?? null,
  };
  let criada = await msgDb()
    .from("api_keys")
    .insert(linhaLarga)
    .select("id,user_id,nome,criado_em")
    .single();
  if (criada.error && semColuna(criada.error)) {
    // migration pendente: se o pedido TRAZIA escopo/prazo, recusar em vez de
    // criar uma chave aberta que o pedinte pensa estar restrita — chave mais
    // poderosa do que se pediu e falha de seguranca, nao degradacao suave.
    const pediuEscopo = body?.escopo !== undefined || body?.expira_em !== undefined;
    if (pediuEscopo) return NextResponse.json({ error: AVISO_SEM_COLUNAS }, { status: 400 });
    criada = await msgDb().from("api_keys").insert(linha).select("id,user_id,nome,criado_em").single();
  }
  if (criada.error) return NextResponse.json({ error: criada.error.message }, { status: 500 });
  // plaintext SO aqui, uma unica vez
  return NextResponse.json({ ok: true, chave, escopo_resumo: resumoEscopo(escopo), ...criada.data });
}

async function editar(req: NextRequest, id: string, body: any) {
  const patch: Record<string, any> = {};
  if (body?.escopo !== undefined) {
    // PATCH POR DIMENSAO, nao reescrita (achado de revisao). Reescrever apagava
    // toda dimensao omitida: `ignorar_janela` voltava a false (a chave de robo
    // noturno parava calada) e — pior — `somente_leitura`/`recursos` voltavam ao
    // default ABERTO, dando escrita e alcance total a quem so pediu pra mexer no
    // canal. A correcao anterior era na TELA e nao alcancava curl, script nem MCP;
    // esta e nas DUAS pontas. Pra limpar uma dimensao, mande ela explicita.
    const gravado = await msgDb().from("api_keys").select("escopo").eq("id", id).maybeSingle();
    if (gravado.error) {
      if (semColuna(gravado.error)) return NextResponse.json({ error: AVISO_SEM_COLUNAS }, { status: 400 });
      return NextResponse.json({ error: gravado.error.message }, { status: 500 });
    }
    if (!gravado.data) return NextResponse.json({ error: "chave nao encontrada" }, { status: 404 });
    const escopo = mesclarEscopo(validarEscopoChave(gravado.data.escopo), body.escopo);
    const canalRuim = escopo.canais.filter((c) => !canalPorId(c));
    if (canalRuim.length) {
      return NextResponse.json({ error: `canal inexistente: ${canalRuim.join(", ")}` }, { status: 400 });
    }
    patch.escopo = escopo;
  }
  if (body?.tipo !== undefined) patch.tipo = rotuloValido(body.tipo, 40);
  if (body?.rotulo !== undefined) patch.rotulo = rotuloValido(body.rotulo);
  if (body?.expira_em !== undefined) {
    const prazo = validarPrazo(body.expira_em);
    if (!prazo.ok) return NextResponse.json({ error: prazo.erro }, { status: 400 });
    patch.expira_em = prazo.valor;
  }
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "nada pra mudar (escopo, tipo, rotulo ou expira_em)" }, { status: 400 });
  }
  const { data, error } = await msgDb().from("api_keys").update(patch).eq("id", id).select("id,nome,escopo");
  if (error) {
    if (semColuna(error)) return NextResponse.json({ error: AVISO_SEM_COLUNAS }, { status: 400 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data?.length) return NextResponse.json({ error: "chave nao encontrada" }, { status: 404 });
  // o cache da porta guarda a LINHA por 60s: sem derrubar, o escopo novo (mais
  // restritivo) levaria 1min pra valer. Aperto de seguranca pega na hora.
  derrubarCacheApiKeys();
  return NextResponse.json({
    ok: true,
    id,
    escopo_resumo: resumoEscopo(validarEscopoChave((data[0] as any).escopo)),
  });
}

export async function DELETE(req: NextRequest) {
  if (!(await autorizado(req))) return NextResponse.json({ error: "somente super admin" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id obrigatorio" }, { status: 400 });
  const quem = await ator(req);
  const cheio = {
    ativo: false,
    revogado_em: new Date().toISOString(),
    revogado_por_id: quem?.id ?? null,
    // bearer do sync nao tem pessoa: a convencao de autor da 0006 vale —
    // id NULL com nome preenchido = automacao
    revogado_por_nome: quem?.nome ?? "automacao: bearer do sync",
  };
  let r = await msgDb().from("api_keys").update(cheio).eq("id", id);
  if (r.error && semColuna(r.error)) {
    r = await msgDb().from("api_keys").update({ ativo: false }).eq("id", id);
  }
  if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
  derrubarCacheApiKeys();
  return NextResponse.json({ ok: true, revogada: id });
}
