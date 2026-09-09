import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import { getPerfil, podeVerConversa } from "@/lib/perfil";
import { canalDe, canalDeBody, tabelas } from "@/lib/canal";
import { canalPorId, fonteExterna, somenteLeitura } from "@/lib/canais";
import { prepararEstadoExterno, tabelaAusente } from "@/lib/estado-externo";
import { fonteLigada } from "@/lib/fonte-externa";
import { restricaoEfetiva } from "@/lib/embed";
// FRENTE X (31/08/2026), toque 1 de 2 nesta rota — o catalogo TIPADO e a DECISAO
// de escrita passaram a vir de um lugar so. Ver `app/api/campos/valores/route.ts`:
// as duas rotas escrevem `conversas.ficha` e chamam a MESMA decisao, senao o
// painel aceitaria um valor que o MCP recusa (e vice-versa) na primeira mudanca.
import {
  aplicarPatchDeValores,
  pendenciasObrigatorias,
  valoresOrfaos,
  MAX_CAMPOS,
  MAX_CHAVES_PATCH,
} from "@/lib/campos";
import { lerCatalogo } from "@/lib/campos-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Ficha da conversa: campos personalizados, etiquetas e anotacoes internas
// (dados vindos do ChatGuru pela importacao do historico).
export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") {
    return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  }
  const chatId = req.nextUrl.searchParams.get("chat_id");
  if (!chatId) return NextResponse.json({ error: "chat_id obrigatorio" }, { status: 400 });
  const canal = canalDe(req);
  const T = tabelas(canal);
  if (!(await podeVerConversa(chatId, user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(chatId)) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }

  const db = msgDb();
  const def = canalPorId(canal)!;
  if (somenteLeitura(canal)) {
    // fonte externa SEM estado no painel (instagram-agent): ficha minima (nome,
    // status). O canal do agente segue pelo caminho normal: a linha dele mora no
    // painel (lib/estado-externo.ts) e so o nome pode vir do agente.
    const ext = await fonteLigada(def);
    const [c] = ext ? await ext.conversasPorIds([chatId]) : [];
    const catExt = await lerCatalogo();
    const ativosExt = catExt.campos.filter((x) => x.ativo);
    return NextResponse.json(
      {
        chat_id: chatId,
        nome: c?.nome ?? null,
        is_group: c?.is_group ?? false,
        status: "aberto",
        responsavel_nome: null,
        etiquetas: [],
        campos_padrao: ativosExt.map((x) => x.nome),
        // campos TIPADOS (Frente X). `campos_padrao` fica de pe pro consumidor
        // antigo (app/home.tsx e a tool do MCP leem so os nomes): adicionar campo
        // na resposta e aditivo, trocar seria quebrar a tela de outra frente.
        campos: ativosExt,
        arquivado: false,
        ficha: {},
        enriquecido_em: null,
        notas: [],
        somente_leitura: true,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }
  const [conv, notas, cat] = await Promise.all([
    db
      .from(T.conversas)
      .select("chat_id,nome,is_group,foto_url,foto_wa_url,status,responsavel_nome,ficha,meta_chatguru,etiquetas,created_at,enriquecido_em")
      .eq("chat_id", chatId)
      .maybeSingle(),
    db
      .from(T.mensagens)
      .select("id,conteudo,sender_name,criada_em")
      .eq("chat_id", chatId)
      .eq("direcao", "interna")
      .order("criada_em", { ascending: false })
      .limit(100),
    // campos PADRAO da ficha (catalogo do admin) — o atendente so preenche valor.
    // Desde a Frente X o catalogo vem TIPADO, por `lerCatalogo` (que degrada
    // sozinho quando a 0025 nao rodou: devolve tudo como texto).
    lerCatalogo(),
  ]);

  if (conv.error && !(fonteExterna(def) && tabelaAusente(conv.error))) {
    console.error("ficha:", conv.error.message);
    return NextResponse.json({ error: "falha ao carregar ficha" }, { status: 500 });
  }
  const c: any = conv.data;
  // canal do agente: a linha do painel nasce na primeira acao; ate la o nome
  // vem do banco do agente (e a ficha aparece vazia, nao "nao encontrada")
  const nomeExterno = fonteExterna(def) && !c?.nome ? ((await (await fonteLigada(def))?.conversasPorIds([chatId]))?.[0]?.nome ?? null) : null;
  const meta: any = c?.meta_chatguru || {};
  const ficha: Record<string, string> = {};
  for (const [k, v] of Object.entries((c?.ficha as Record<string, unknown>) || {})) {
    const texto = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
    if (texto.trim()) ficha[k] = texto;
  }

  return NextResponse.json(
    {
      chat_id: c?.chat_id ?? chatId,
      nome: c?.nome ?? nomeExterno,
      is_group: !!c?.is_group,
      status: c?.status ?? "aberto",
      responsavel_nome: c?.responsavel_nome ?? null,
      // etiquetas agora vivem na coluna propria (editaveis no painel); meta e so legado
      etiquetas: Array.isArray(c?.etiquetas) ? c.etiquetas : Array.isArray(meta.etiquetas) ? meta.etiquetas : [],
      campos_padrao: cat.campos.filter((x) => x.ativo).map((x) => x.nome),
      // Frente X, aditivo: o catalogo TIPADO, as pendencias de campo obrigatorio e
      // os valores que NENHUM campo ativo alcanca. Os orfaos sao o defeito que a
      // frente fecha: a tela desenha a ficha iterando `campos_padrao`, entao valor
      // de campo arquivado (ou renomeado pela rota antiga) ficava no banco e
      // desaparecia — ninguem apagou nada, e ninguem conseguia mais ver.
      campos: cat.campos.filter((x) => x.ativo),
      pendencias: pendenciasObrigatorias(cat.campos, ficha),
      orfaos: valoresOrfaos(cat.campos, ficha),
      tipos_disponiveis: cat.tipos_disponiveis,
      arquivado: !!meta.arquivado,
      ficha,
      enriquecido_em: c?.enriquecido_em ?? null,
      notas: (notas.data ?? []).map((n) => ({
        id: n.id,
        texto: n.conteudo,
        autor: n.sender_name,
        criada_em: n.criada_em,
      })),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

// Edicao dos campos personalizados: patch por chave (valor vazio remove a chave).
export async function PATCH(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  const bodyF = await req.json().catch(() => ({}));
  const { chat_id, ficha } = bodyF;
  const canal = canalDeBody(bodyF);
  const T = tabelas(canal);
  if (!chat_id || typeof ficha !== "object" || ficha === null || Array.isArray(ficha)) {
    return NextResponse.json({ error: "chat_id e ficha (objeto) sao obrigatorios" }, { status: 400 });
  }
  // TETO DE CHAVES ANTES DE ITERAR (Frente X). Esta rota tinha um
  // `Object.entries(ficha).slice(0, 60)` que sumiu junto com o laco antigo — e o
  // teto passou a fazer MAIS falta, nao menos: campo fora do catalogo agora vira
  // linha em `recusados` (era descarte silencioso), entao um corpo com 10 mil
  // chaves viraria 10 mil recusas e uma resposta de megabytes.
  const nChaves = Object.keys(ficha).length;
  if (nChaves > MAX_CHAVES_PATCH) {
    return NextResponse.json(
      { error: `${nChaves} campos num pedido so; o teto e ${MAX_CHAVES_PATCH} (a ficha inteira tem no maximo ${MAX_CAMPOS} campos ativos)` },
      { status: 413 }
    );
  }
  if (!(await podeVerConversa(String(chat_id), user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(String(chat_id))) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }
  const bloqueio = await prepararEstadoExterno(canal, String(chat_id), "a ficha");
  if (bloqueio) return bloqueio;
  const db = msgDb();
  const [{ data: atual }, cat] = await Promise.all([
    db.from(T.conversas).select("ficha").eq("chat_id", String(chat_id)).maybeSingle(),
    lerCatalogo(),
  ]);
  if (!atual) return NextResponse.json({ error: "conversa nao encontrada" }, { status: 404 });
  // CATALOGO ILEGIVEL = 503, nao 422 dizendo que os campos "nao existem": com a
  // lista vazia por engano, `aplicarPatchDeValores` recusaria TUDO com o motivo
  // errado e o atendente iria procurar o campo que ele esta vendo na tela.
  if (!cat.legivel) {
    return NextResponse.json(
      { error: cat.aviso || "nao deu pra ler o catalogo de campos agora", catalogo_ilegivel: true },
      { status: 503 }
    );
  }

  // FRENTE X (31/08/2026), toque 2 de 2 nesta rota — a DECISAO saiu daqui.
  //
  // Campos seguem PADRAO: criar/remover campo e acao de admin (`/api/campos`,
  // permissao `gerenciar_campos`); aqui so entra VALOR pra campo do catalogo
  // ativo. O que mudou e QUEM decide: `aplicarPatchDeValores` (lib/campos.ts), a
  // mesma funcao que `/api/campos/valores` chama. Duas portas escrevendo a mesma
  // coluna com regras proprias divergem na primeira mudanca — e a divergencia
  // aqui seria "o painel aceita e o MCP recusa o mesmo valor".
  //
  // TRES COMPORTAMENTOS MUDARAM, e os tres pra melhor (declarado no CLAUDE.md):
  //   1. o valor passa a ser VALIDADO pelo tipo do campo. Instalacao sem a 0025
  //      nao sente nada: todo campo e `texto`, que aceita o que aceitava;
  //   2. valor acima do teto e RECUSADO em vez de CORTADO em 1000 chars. O corte
  //      silencioso entregava ao banco um CNPJ/endereco pela metade sem avisar
  //      ninguem (mesma licao de `validarInterativa`: recusa, nao corta);
  //   3. recusa e 422 com a lista e NADA gravado (padrao `validarFluxo`). Antes o
  //      campo fora do catalogo era descartado em silencio e a resposta era 200 —
  //      quem chamou pela API achava que gravou.
  const r = aplicarPatchDeValores(cat.campos, atual.ficha as Record<string, unknown>, ficha as Record<string, unknown>);
  if (r.recusados.length) {
    return NextResponse.json(
      { error: r.recusados.map((x) => `${x.campo}: ${x.motivo}`).join("; "), recusados: r.recusados },
      { status: 422 }
    );
  }

  const { error } = await db
    .from(T.conversas)
    .update({ ficha: r.ficha, updated_at: new Date().toISOString() })
    .eq("chat_id", String(chat_id));
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    ok: true,
    ficha: r.ficha,
    aplicados: r.aplicados,
    pendencias: pendenciasObrigatorias(cat.campos, r.ficha),
    orfaos: valoresOrfaos(cat.campos, r.ficha),
  });
}
