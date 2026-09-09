import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUser } from "@/lib/auth-server";
import {
  getPerfil,
  permitido,
  ehAdmin,
  derrubarCacheInativos,
  fotosDeUsuarios,
  preferenciasDeUsuarios,
  salvarPreferenciasDeOutro,
} from "@/lib/perfil";
import { msgDb } from "@/lib/mensageria";
import { derrubarCacheRestricao } from "@/lib/embed";
import {
  PERMISSOES,
  DESCRICAO_PERMISSAO,
  bloqueiaDelegacao,
  bloqueiaTrocaDePapelBase,
  editaPropriaAutorizacao,
  validarExcecoes,
  validarPermissoes,
  type Permissao,
} from "@/lib/permissoes";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Administracao de usuarios (papel, escopo de visao, departamento) — SO super admin.
export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!permitido(await getPerfil(user.id), "gerenciar_usuarios")) {
    return NextResponse.json({ error: "sem permissao pra gerenciar usuarios" }, { status: 403 });
  }

  const admin = createClient(process.env.MSG_SUPABASE_URL!, process.env.MSG_SUPABASE_SERVICE_KEY!, {
    auth: { persistSession: false },
    global: { fetch: (u: any, i: any) => fetch(u, { ...i, cache: "no-store" }) },
  });
  // As leituras de papeis/extras sao TOLERANTES a migration 0010 nao ter rodado
  // (papeis_disponiveis: false diz isso ao front), e a de fotos tolera a 0011.
  const [lista, perfis, deps, membros, vinculosBu, papeis, extras, fotos, prefs] = await Promise.all([
    admin.auth.admin.listUsers({ page: 1, perPage: 200 }),
    msgDb().from("perfis").select("user_id,papel,escopo_visao,ativo,assinatura_ativa,assinatura_nome"),
    msgDb().from("departamentos").select("id,nome,ativo").order("nome"),
    msgDb().from("departamento_membros").select("departamento_id,user_id"),
    msgDb().from("perfil_contextos").select("user_id,contexto_id"),
    msgDb().from("papeis").select("id,nome,descricao,permissoes,ativo").order("nome"),
    msgDb().from("perfis").select("user_id,papel_id,permissoes_excecao"),
    // foto do atendente em consulta SEPARADA de proposito: sem a migration 0011
    // a coluna nao existe, e juntar no select acima derrubaria a tela inteira
    fotosDeUsuarios(),
    // modo supervisor por pessoa (Frente N) — vive em `perfis.preferencias`,
    // mesma coluna da 0011, entao mesma tolerancia: sem migration vem vazio e a
    // tela mostra a chave desligada.
    preferenciasDeUsuarios(),
  ]);
  if (lista.error) return NextResponse.json({ error: lista.error.message }, { status: 500 });

  const papeisDisponiveis = !papeis.error && !extras.error;
  const extraPorId = new Map((extras.data ?? []).map((p: any) => [p.user_id, p]));

  const nomeDep = new Map((deps.data ?? []).map((d) => [d.id, d.nome]));
  const depsDoUsuario = new Map<string, string[]>();
  for (const m of membros.data ?? []) {
    const l = depsDoUsuario.get(m.user_id) || [];
    const nome = nomeDep.get(m.departamento_id);
    if (nome) l.push(nome);
    depsDoUsuario.set(m.user_id, l);
  }
  // permissao por BU: contextos vinculados (ids) por usuario
  const contextosDoUsuario = new Map<string, string[]>();
  for (const v of vinculosBu.data ?? []) {
    const l = contextosDoUsuario.get(v.user_id) || [];
    l.push(v.contexto_id);
    contextosDoUsuario.set(v.user_id, l);
  }
  const porId = new Map((perfis.data ?? []).map((p) => [p.user_id, p]));
  const usuarios = (lista.data?.users || [])
    .filter((u) => u.email && !u.email.startsWith("teste-painel-"))
    .map((u) => {
      const p: any = porId.get(u.id) || {};
      const ex: any = extraPorId.get(u.id) || {};
      return {
        id: u.id,
        papel_id: typeof ex.papel_id === "string" ? ex.papel_id : null,
        // excecoes ja saneadas: a tela destaca "ajuste individual" a partir daqui
        permissoes_excecao: validarExcecoes(ex.permissoes_excecao),
        nome:
          (u.user_metadata?.nome as string) ||
          (u.user_metadata?.name as string) ||
          (u.user_metadata?.full_name as string) ||
          u.email!.split("@")[0],
        email: u.email,
        papel: p.papel || "normal",
        escopo_visao: p.escopo_visao || "todas",
        ativo: p.ativo !== false,
        assinatura_ativa: p.assinatura_ativa === true,
        assinatura_nome: p.assinatura_nome || "",
        supervisor: prefs[u.id]?.supervisor === true,
        supervisor_responder_zera: prefs[u.id]?.supervisor_responder_zera !== false,
        departamentos: (depsDoUsuario.get(u.id) || []).sort(),
        contextos: contextosDoUsuario.get(u.id) || [],
        foto_url: fotos[u.id] || null,
      };
    })
    .sort((a, b) => a.nome.localeCompare(b.nome));

  return NextResponse.json(
    {
      usuarios,
      departamentos: deps.data ?? [],
      papeis_disponiveis: papeisDisponiveis,
      papeis: (papeis.data ?? []).map((p: any) => ({
        id: p.id,
        nome: p.nome,
        descricao: p.descricao || "",
        ativo: p.ativo !== false,
        permissoes: validarPermissoes(p.permissoes),
      })),
      // catalogo pra tela montar os rotulos sem duplicar texto no front
      permissoes: PERMISSOES.map((p) => ({ id: p, descricao: DESCRICAO_PERMISSAO[p] })),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfilAtor = await getPerfil(user.id);
  if (!permitido(perfilAtor, "gerenciar_usuarios")) {
    return NextResponse.json({ error: "sem permissao pra gerenciar usuarios" }, { status: 403 });
  }
  const atorEhAdmin = ehAdmin(perfilAtor);
  // vinculo com departamento agora e N:N e vive em /api/admin/departamentos
  const {
    user_id,
    nome,
    papel,
    escopo_visao,
    ativo,
    assinatura_ativa,
    assinatura_nome,
    supervisor,
    supervisor_responder_zera,
    contextos,
    papel_id,
    permissoes_excecao,
  } = await req.json().catch(() => ({}));
  if (!user_id) return NextResponse.json({ error: "user_id obrigatorio" }, { status: 400 });
  if (papel && !["super_admin", "normal"].includes(papel)) {
    return NextResponse.json({ error: "papel invalido" }, { status: 400 });
  }
  // ESCALADA FECHADA (31/08): o papel BASE so muda por quem ja e super admin.
  // Sem isto, quem tem `gerenciar_usuarios` cunhava super admin — inclusive
  // pra si mesmo — porque a unica trava existente pegava o auto-REBAIXAMENTO.
  // O conjunto de quem cria super admin tem que continuar sendo {super admin}.
  if (papel !== undefined && !atorEhAdmin) {
    // Reenviar o MESMO valor nao e troca. O formulario do painel salva o
    // registro inteiro, entao tratar reenvio como troca faria TODO save de
    // nao-admin virar 403 no dia em que a tela abrir pra eles — trava vira
    // paralisia. Comparamos com o que esta gravado antes de barrar.
    const { data: alvoPapel } = await msgDb()
      .from("perfis")
      .select("papel")
      .eq("user_id", user_id)
      .maybeSingle();
    const papelAtual = alvoPapel?.papel ?? "normal";
    if (bloqueiaTrocaDePapelBase(atorEhAdmin, papel, papelAtual)) {
      return NextResponse.json(
        { error: "somente super admin muda o papel base de um usuario" },
        { status: 403 }
      );
    }
  }
  // ESCALADA FECHADA (31/08): ninguem edita a PROPRIA autorizacao. Sem isto,
  // quem administra usuarios se auto-concedia qualquer permissao por excecao
  // ou se auto-atribuia um papel Administrador.
  if (
    editaPropriaAutorizacao({
      atorEhAdmin,
      atorId: user.id,
      alvoId: String(user_id),
      mexeEmAutorizacao: papel_id !== undefined || permissoes_excecao !== undefined,
    })
  ) {
    return NextResponse.json(
      { error: "voce nao pode editar o proprio perfil de permissoes — peca a um super admin" },
      { status: 403 }
    );
  }
  if (escopo_visao && !["proprias", "departamento", "todas"].includes(escopo_visao)) {
    return NextResponse.json({ error: "escopo invalido" }, { status: 400 });
  }
  // permissao por BU: lista de ids de embed_contextos (vazia = remove vinculo,
  // sem restricao). Cada id precisa existir de verdade (nao aceita lixo do front).
  let contextosValidados: string[] | undefined;
  if (contextos !== undefined) {
    if (!Array.isArray(contextos) || contextos.some((c) => typeof c !== "string")) {
      return NextResponse.json({ error: "contextos precisa ser uma lista de ids" }, { status: 400 });
    }
    contextosValidados = Array.from(new Set(contextos as string[]));
    if (contextosValidados.length) {
      const { data: existentes } = await msgDb()
        .from("embed_contextos")
        .select("id")
        .in("id", contextosValidados);
      const validos = new Set((existentes ?? []).map((c) => c.id));
      const invalidos = contextosValidados.filter((id) => !validos.has(id));
      if (invalidos.length) {
        return NextResponse.json({ error: `contexto inexistente: ${invalidos.join(", ")}` }, { status: 400 });
      }
    }
  }
  // papel NOMEADO: null desatribui (volta pro comportamento embutido do enum).
  // Id inexistente e recusado — papel que nao existe deixaria a pessoa em
  // fail-closed sem ninguem entender por que.
  if (papel_id !== undefined && papel_id !== null) {
    if (typeof papel_id !== "string") {
      return NextResponse.json({ error: "papel_id precisa ser um id ou null" }, { status: 400 });
    }
    const { data: existe, error: erroPapel } = await msgDb()
      .from("papeis")
      .select("id,nome,permissoes")
      .eq("id", papel_id)
      .maybeSingle();
    if (erroPapel) {
      return NextResponse.json(
        { error: "papeis nomeados indisponiveis — rode a migration 0010_papeis.sql" },
        { status: 400 }
      );
    }
    if (!existe) return NextResponse.json({ error: "papel inexistente" }, { status: 400 });
    // TETO: atribuir um papel e CONCEDER as permissoes dele. Quem nao tem a
    // permissao nao pode entrega-la a ninguem — nem a si (ja barrado acima),
    // nem a um terceiro, que seria fabricar um administrador por procuracao.
    {
      const fora = bloqueiaDelegacao(
        atorEhAdmin,
        perfilAtor.permissoes,
        validarPermissoes((existe as any).permissoes)
      );
      if (fora.length) {
        return NextResponse.json(
          { error: `voce nao tem essas permissoes pra conceder: ${fora.join(", ")}` },
          { status: 403 }
        );
      }
    }
  }
  // excecao individual: mapa permissao -> boolean. Saneado contra a lista
  // canonica, entao o front nao consegue gravar permissao inventada.
  let excecoesValidadas: Record<string, boolean> | undefined;
  if (permissoes_excecao !== undefined) {
    if (permissoes_excecao === null) excecoesValidadas = {};
    else if (typeof permissoes_excecao !== "object" || Array.isArray(permissoes_excecao)) {
      return NextResponse.json({ error: "permissoes_excecao precisa ser um mapa" }, { status: 400 });
    } else excecoesValidadas = validarExcecoes(permissoes_excecao) as Record<string, boolean>;
    // TETO: so as CONCEDIDAS (true) precisam caber no conjunto do ator —
    // revogar e restricao, nunca escalada, entao segue livre.
    if (excecoesValidadas) {
      const concedidas = Object.entries(excecoesValidadas)
        .filter(([, v]) => v === true)
        .map(([k]) => k as Permissao);
      const fora = bloqueiaDelegacao(atorEhAdmin, perfilAtor.permissoes, concedidas);
      if (fora.length) {
        return NextResponse.json(
          { error: `voce nao tem essas permissoes pra conceder: ${fora.join(", ")}` },
          { status: 403 }
        );
      }
    }
  }

  // trava anti-tiro-no-pe: o super admin nao consegue rebaixar a si mesmo
  if (user_id === user.id && papel === "normal") {
    return NextResponse.json({ error: "nao da pra remover seu proprio papel de super admin" }, { status: 400 });
  }
  if (ativo === false) {
    if (user_id === user.id) {
      return NextResponse.json({ error: "nao da pra desativar a si mesmo" }, { status: 400 });
    }
    // outro super admin nao cai por 1 clique: rebaixa o papel antes
    const alvo = await msgDb().from("perfis").select("papel").eq("user_id", user_id).maybeSingle();
    if (alvo.data?.papel === "super_admin") {
      return NextResponse.json({ error: "mude o papel pra Usuario antes de desativar um super admin" }, { status: 400 });
    }
  }

  const patch: Record<string, any> = { user_id, updated_at: new Date().toISOString() };
  if (nome) patch.nome = nome;
  if (papel) patch.papel = papel;
  if (escopo_visao) patch.escopo_visao = escopo_visao;
  if (typeof ativo === "boolean") patch.ativo = ativo;
  if (typeof assinatura_ativa === "boolean") patch.assinatura_ativa = assinatura_ativa;
  if (typeof assinatura_nome === "string") patch.assinatura_nome = assinatura_nome.trim().slice(0, 60) || null;
  if (papel_id !== undefined) patch.papel_id = papel_id === null ? null : String(papel_id);
  if (excecoesValidadas !== undefined) patch.permissoes_excecao = excecoesValidadas;

  const { error } = await msgDb().from("perfis").upsert(patch, { onConflict: "user_id" });
  if (error) {
    // coluna ausente = migration 0010 pendente; mensagem util em vez de 500 cru
    if (papel_id !== undefined || excecoesValidadas !== undefined) {
      return NextResponse.json(
        { error: "papeis nomeados indisponiveis — rode a migration 0010_papeis.sql" },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (typeof ativo === "boolean") {
    // corta tambem na origem: banido nao loga de novo; reativar solta o ban
    const admin = createClient(process.env.MSG_SUPABASE_URL!, process.env.MSG_SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false },
      global: { fetch: (u: any, i: any) => fetch(u, { ...i, cache: "no-store" }) },
    });
    const ban = await admin.auth.admin.updateUserById(user_id, { ban_duration: ativo ? "none" : "87600h" } as any);
    if (ban.error) return NextResponse.json({ error: `perfil salvo, mas o bloqueio de login falhou: ${ban.error.message}` }, { status: 500 });
    derrubarCacheInativos();
  }

  // permissao por BU: substitui os vinculos (delete + insert, lista vazia so
  // limpa). Super admin PODE ter vinculo gravado aqui, mas ele nunca tem
  // efeito — restricaoDoUsuario devolve null pra super admin sempre, entao o
  // vinculo fica so registrado (pra reaparecer se um dia o papel mudar pra
  // normal), nunca restringe quem e super admin.
  if (contextosValidados !== undefined) {
    const del = await msgDb().from("perfil_contextos").delete().eq("user_id", user_id);
    if (del.error) return NextResponse.json({ error: del.error.message }, { status: 500 });
    if (contextosValidados.length) {
      const ins = await msgDb()
        .from("perfil_contextos")
        .insert(contextosValidados.map((contexto_id) => ({ user_id, contexto_id })));
      if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });
    }
    derrubarCacheRestricao(user_id);
  }

  // MODO SUPERVISOR por pessoa (Frente N): mora em `perfis.preferencias`, junto
  // das preferencias que o dono da conta escolhe — por isso e PATCH mesclado, em
  // escrita separada do upsert acima. Gravar o jsonb inteiro aqui apagaria o som
  // do sininho e o aviso de desktop que a pessoa configurou.
  const patchPrefs: Record<string, boolean> = {};
  if (typeof supervisor === "boolean") patchPrefs.supervisor = supervisor;
  if (typeof supervisor_responder_zera === "boolean") {
    patchPrefs.supervisor_responder_zera = supervisor_responder_zera;
  }
  if (Object.keys(patchPrefs).length) {
    const erro = await salvarPreferenciasDeOutro(user_id, patchPrefs);
    // o resto do save JA gravou: erro aqui e parcial, e a mensagem diz isso em
    // vez de fingir sucesso ou de sugerir que nada foi salvo.
    if (erro) return NextResponse.json({ error: `perfil salvo, mas o modo supervisor nao: ${erro}` }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
