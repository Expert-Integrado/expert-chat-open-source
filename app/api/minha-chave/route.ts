import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { usuarioPorSessao, derrubarCacheApiKeys } from "@/lib/auth-server";
import { canalPorId } from "@/lib/canais";
import {
  DESCRICAO_RECURSO,
  RECURSOS,
  TIPOS_CHAVE,
  chaveExpirada,
  escopoSemPrivilegio,
  resumoEscopo,
  rotuloValido,
  validarEscopoChave,
} from "@/lib/escopo-chave";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Autoatendimento da chave de API (MCP): cada usuario gera/revoga a PROPRIA
// chave na tela "Meu perfil". SO por sessao logada (usuarioPorSessao recusa
// x-api-key) — chave de API nao gera nem revoga outra chave.
//
// Frente Q (31/08/2026, card 86ak85899): a pessoa agora escolhe o ESCOPO da
// propria chave (somente leitura, recursos, canais) e um PRAZO. O teto e
// `escopoSemPrivilegio`: o autoatendimento so consegue APERTAR. A unica
// dimensao que afrouxaria — `ignorar_janela`, a chave trabalhando fora da
// janela de acesso do dono — e zerada aqui e vive so no caminho de super admin
// (/api/admin/api-keys). Sem esse corte, qualquer pessoa com janela furaria a
// propria janela gerando uma chave — escalada com um passo a mais, a mesma
// classe de furo que `bloqueiaDelegacao` fecha nas permissoes.

const AVISO_SEM_COLUNAS =
  "escopo de chave indisponivel nesta instalacao — pergunte ao administrador (migration 0019_seguranca_conta.sql)";

function semColuna(erro: any): boolean {
  return !!erro && ["42703", "42P01"].includes(String(erro.code));
}

function validarPrazo(bruto: unknown): { ok: true; valor: string | null } | { ok: false; erro: string } {
  if (bruto === undefined || bruto === null || bruto === "") return { ok: true, valor: null };
  if (typeof bruto !== "string") return { ok: false, erro: "expira_em precisa ser uma data ou null" };
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(bruto.trim()) ? `${bruto.trim()}T23:59:59` : bruto.trim();
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { ok: false, erro: "expira_em nao e uma data valida" };
  if (t <= Date.now()) return { ok: false, erro: "expira_em precisa ser no futuro" };
  return { ok: true, valor: new Date(t).toISOString() };
}

export async function GET(req: NextRequest) {
  const user = await usuarioPorSessao(req);
  if (!user) return NextResponse.json({ error: "somente pela tela do painel, logado" }, { status: 401 });
  const catalogo = {
    recursos: RECURSOS.map((r) => ({ id: r, descricao: DESCRICAO_RECURSO[r] })),
    tipos: TIPOS_CHAVE,
  };
  const largo = await msgDb()
    .from("api_keys")
    .select("id,nome,tipo,rotulo,escopo,expira_em,criado_em,ultimo_uso_em,ultimo_uso_ip,ultimo_uso_ua")
    .eq("user_id", user.id)
    .eq("ativo", true)
    .is("revogado_em", null)
    .order("criado_em", { ascending: false });
  if (largo.error) {
    if (!semColuna(largo.error)) return NextResponse.json({ error: largo.error.message }, { status: 500 });
    const antigo = await msgDb()
      .from("api_keys")
      .select("id,nome,criado_em,ultimo_uso_em")
      .eq("user_id", user.id)
      .eq("ativo", true)
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
    };
  });
  return NextResponse.json(
    { chaves, escopo_disponivel: true, ...catalogo },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  const user = await usuarioPorSessao(req);
  if (!user) return NextResponse.json({ error: "somente pela tela do painel, logado" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const nome = (typeof body?.nome === "string" ? body.nome.trim() : "").slice(0, 60) || "minha maquina";

  const { count } = await msgDb()
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("ativo", true);
  if ((count ?? 0) >= 10) {
    return NextResponse.json({ error: "limite de 10 chaves ativas — revogue uma antes de gerar outra" }, { status: 400 });
  }

  // TETO: o autoatendimento so aperta. `ignorar_janela` sai daqui sempre.
  const escopo = escopoSemPrivilegio(validarEscopoChave(body?.escopo));
  const canalRuim = escopo.canais.filter((c) => !canalPorId(c));
  if (canalRuim.length) {
    return NextResponse.json({ error: `canal inexistente: ${canalRuim.join(", ")}` }, { status: 400 });
  }
  const prazo = validarPrazo(body?.expira_em);
  if (!prazo.ok) return NextResponse.json({ error: prazo.erro }, { status: 400 });

  const chave = `eck_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(chave).digest("hex");
  const linha: Record<string, any> = { user_id: user.id, nome, key_hash: keyHash };
  let criada = await msgDb()
    .from("api_keys")
    .insert({
      ...linha,
      escopo,
      tipo: rotuloValido(body?.tipo, 40),
      rotulo: rotuloValido(body?.rotulo),
      expira_em: prazo.valor,
    })
    .select("id,nome,criado_em")
    .single();
  if (criada.error && semColuna(criada.error)) {
    // migration pendente: se a pessoa PEDIU escopo/prazo, recusar. Entregar uma
    // chave aberta pra quem pediu chave restrita e dar mais poder do que se
    // pediu — nunca degrada nessa direcao.
    if (body?.escopo !== undefined || body?.expira_em !== undefined) {
      return NextResponse.json({ error: AVISO_SEM_COLUNAS }, { status: 400 });
    }
    criada = await msgDb().from("api_keys").insert(linha).select("id,nome,criado_em").single();
  }
  if (criada.error) return NextResponse.json({ error: criada.error.message }, { status: 500 });
  // plaintext SO aqui, uma unica vez
  return NextResponse.json({ ok: true, chave, escopo_resumo: resumoEscopo(escopo), ...criada.data });
}

export async function DELETE(req: NextRequest) {
  const user = await usuarioPorSessao(req);
  if (!user) return NextResponse.json({ error: "somente pela tela do painel, logado" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id obrigatorio" }, { status: 400 });
  // so revoga chave PROPRIA — o filtro por user_id e a autorizacao
  const cheio = {
    ativo: false,
    revogado_em: new Date().toISOString(),
    revogado_por_id: user.id,
    revogado_por_nome: user.nome,
  };
  let r = await msgDb().from("api_keys").update(cheio).eq("id", id).eq("user_id", user.id).select("id");
  if (r.error && semColuna(r.error)) {
    r = await msgDb().from("api_keys").update({ ativo: false }).eq("id", id).eq("user_id", user.id).select("id");
  }
  if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
  if (!r.data?.length) return NextResponse.json({ error: "chave nao encontrada" }, { status: 404 });
  derrubarCacheApiKeys();
  return NextResponse.json({ ok: true, revogada: id });
}
