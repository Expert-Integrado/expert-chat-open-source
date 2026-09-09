import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, permitido } from "@/lib/perfil";
import { msgDb } from "@/lib/mensageria";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Departamentos COM membros (pessoa pode estar em varios — N:N).
export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!permitido(await getPerfil(user.id), "gerenciar_usuarios")) {
    return NextResponse.json({ error: "sem permissao pra gerenciar usuarios" }, { status: 403 });
  }
  const db = msgDb();
  const [deps, membros, perfis] = await Promise.all([
    db.from("departamentos").select("id,nome,ativo,escopo_visao").order("nome"),
    db.from("departamento_membros").select("departamento_id,user_id"),
    db.from("perfis").select("user_id,nome"),
  ]);
  if (deps.error) return NextResponse.json({ error: deps.error.message }, { status: 500 });
  const nomes = new Map((perfis.data ?? []).map((p) => [p.user_id, p.nome || "?"]));
  const porDep = new Map<string, { id: string; nome: string }[]>();
  for (const m of membros.data ?? []) {
    const lista = porDep.get(m.departamento_id) || [];
    lista.push({ id: m.user_id, nome: nomes.get(m.user_id) || "?" });
    porDep.set(m.departamento_id, lista);
  }
  const departamentos = (deps.data ?? []).map((d) => ({
    ...d,
    membros: (porDep.get(d.id) || []).sort((a, b) => a.nome.localeCompare(b.nome)),
  }));
  return NextResponse.json({ departamentos }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

// Criar/renomear/ativar departamento e ADICIONAR/REMOVER membros — SO super admin.
export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!permitido(await getPerfil(user.id), "gerenciar_usuarios")) {
    return NextResponse.json({ error: "sem permissao pra gerenciar usuarios" }, { status: 403 });
  }
  const { id, nome, ativo, escopo_visao, add_user_id, add_user_nome, remove_user_id } =
    await req.json().catch(() => ({}));
  const db = msgDb();

  if (id && add_user_id) {
    // garante a linha em perfis (nome legivel na listagem) e vincula
    await db.from("perfis").upsert(
      { user_id: add_user_id, ...(add_user_nome ? { nome: add_user_nome } : {}) },
      { onConflict: "user_id", ignoreDuplicates: !add_user_nome }
    );
    const { error } = await db
      .from("departamento_membros")
      .upsert({ departamento_id: id, user_id: add_user_id }, { onConflict: "departamento_id,user_id" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (id && remove_user_id) {
    const { error } = await db
      .from("departamento_membros")
      .delete()
      .eq("departamento_id", id)
      .eq("user_id", remove_user_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (id) {
    // renomear / ativar / desativar / regra de visao — nunca deletar: ha conversas apontando
    const patch: Record<string, any> = {};
    if (typeof nome === "string" && nome.trim()) patch.nome = nome.trim();
    if (ativo !== undefined) patch.ativo = !!ativo;
    if (escopo_visao !== undefined) {
      if (escopo_visao !== null && !["proprias", "departamento", "todas"].includes(escopo_visao)) {
        return NextResponse.json({ error: "escopo invalido" }, { status: 400 });
      }
      // regra do departamento vale pra TODOS os membros (substitui a individual)
      patch.escopo_visao = escopo_visao;
    }
    if (!Object.keys(patch).length) return NextResponse.json({ error: "nada pra alterar" }, { status: 400 });
    const { error } = await db.from("departamentos").update(patch).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (typeof nome !== "string" || !nome.trim()) {
    return NextResponse.json({ error: "nome obrigatorio" }, { status: 400 });
  }
  const { data, error } = await db
    .from("departamentos")
    .upsert({ nome: nome.trim(), ativo: true }, { onConflict: "nome" })
    .select("id,nome,ativo")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, departamento: data });
}
