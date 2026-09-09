import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import { getPerfil, podeVerConversa } from "@/lib/perfil";
import { canalDe, canalDeBody, tabelas } from "@/lib/canal";
import { canalPorId, somenteLeitura } from "@/lib/canais";
import { restricaoEfetiva } from "@/lib/embed";
import { carregarCatalogo, historicoDaConversa, moverConversa, vinculosDaConversa } from "@/lib/funis-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// ETAPA DE UMA CONVERSA — uso do dia a dia (mover card no quadro, ver em que
// etapa a conversa esta). Permissao e a da CONVERSA (podeVerConversa +
// restricao de BU), NAO a de admin: quem atende move; so super admin cria e
// arquiva etapa (`/api/admin/funis`).
//
//   GET  /api/conversa/funil?chat_id=&canal=   -> etapas atuais + historico
//   POST /api/conversa/funil {chat_id, canal, funil_id, etapa_id|null}
//        etapa_id null = TIRA a conversa daquele funil.
//
// CANAL SOMENTE LEITURA TAMBEM TEM ETAPA: a associativa `conversa_funil` e do
// PAINEL (chaveada por canal+chat_id, como `conversa_responsaveis`), nao da
// fonte — organizar uma conversa de Instagram no quadro nao escreve nada no
// sistema de origem. Por isso aqui NAO ha o 403 de somente-leitura que status e
// etiqueta tem.
//
// Sem a migration 0009: GET responde vazio com aviso e POST responde 503 com o
// mesmo aviso — nunca 500.

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });

  const chatId = req.nextUrl.searchParams.get("chat_id");
  if (!chatId) return NextResponse.json({ error: "chat_id obrigatorio" }, { status: 400 });
  const canal = canalDe(req);

  if (!(await podeVerConversa(chatId, user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(chatId)) return NextResponse.json({ error: "fora do contexto" }, { status: 403 });

  const [cat, vinc] = await Promise.all([
    carregarCatalogo({ incluirArquivados: true }),
    vinculosDaConversa(canal, chatId),
  ]);
  if (!cat.ok || !vinc.ok) {
    const aviso = cat.ok ? (vinc as any).aviso : cat.aviso;
    return NextResponse.json({ etapas: [], historico: [], aviso }, { headers: { "Cache-Control": "no-store" } });
  }

  const etapas = vinc.vinculos
    .map((v) => {
      const funil = cat.catalogo.find((f) => f.id === v.funil_id);
      const etapa = funil?.etapas.find((e) => e.id === v.etapa_id);
      // vinculo apontando pra estrutura que sumiu nao pode derrubar a ficha:
      // aparece marcado, e quem ler sabe que ha lixo a limpar
      return {
        funil_id: v.funil_id,
        funil_nome: funil?.nome ?? null,
        etapa_id: v.etapa_id,
        etapa_nome: etapa?.nome ?? null,
        cor: etapa?.cor ?? null,
        arquivada: etapa ? !etapa.ativo : null,
        atualizado_em: v.atualizado_em,
        definido_por_nome: v.definido_por_nome,
        orfao: !funil || !etapa,
      };
    })
    .sort((a, b) => (a.funil_nome ?? "").localeCompare(b.funil_nome ?? ""));

  const historico = await historicoDaConversa(canal, chatId, 30);
  return NextResponse.json({ etapas, historico }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { chat_id, funil_id, etapa_id } = body || {};
  // canal invalido NAO pode cair no central em silencio: marcaria a etapa na
  // conversa homonima do numero principal (o mesmo telefone existe em mais de
  // um canal). Mesma trava explicita da rota de macros.
  if (body?.canal !== undefined) {
    const c = canalPorId(body.canal);
    if (!c || !c.ativo) return NextResponse.json({ error: "canal desconhecido ou inativo" }, { status: 400 });
  }
  const canal = canalDeBody(body);

  if (!chat_id || typeof chat_id !== "string") {
    return NextResponse.json({ error: "chat_id obrigatorio" }, { status: 400 });
  }
  if (!funil_id || typeof funil_id !== "string") {
    return NextResponse.json({ error: "funil_id obrigatorio" }, { status: 400 });
  }
  if (etapa_id !== null && typeof etapa_id !== "string") {
    return NextResponse.json({ error: "etapa_id precisa ser id ou null (null = sair do funil)" }, { status: 400 });
  }

  if (!(await podeVerConversa(chat_id, user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(chat_id)) return NextResponse.json({ error: "fora do contexto" }, { status: 403 });

  // A conversa tem que EXISTIR. Sem isto, um chat_id qualquer (inclusive de
  // quem nunca falou com a empresa) viraria card no quadro — o mesmo tipo de
  // trava que o /api/send tem pra nao deixar o numero da empresa virar
  // ferramenta de disparo frio. `conversa_funil` nao tem FK pra conversas de
  // proposito (a chave e canal+chat_id, pra valer em qualquer canal), entao a
  // checagem e aqui. Canal de fonte externa nao tem linha de conversa no banco
  // do painel — la a conferencia nao se aplica.
  if (!somenteLeitura(canal)) {
    const { data: existe } = await msgDb()
      .from(tabelas(canal).conversas)
      .select("chat_id")
      .eq("chat_id", chat_id)
      .maybeSingle();
    if (!existe) return NextResponse.json({ error: "conversa nao encontrada neste canal" }, { status: 404 });
  }

  const r = await moverConversa({
    canal,
    chatId: chat_id,
    funilId: funil_id,
    etapaId: etapa_id ?? null,
    // autoria de PESSOA (id + nome). Automacao entra por outro caminho (motor
    // de fluxo) e assina o fluxo — convencao de autoria da migration 0006.
    por: { id: user.id, nome: user.nome },
  });
  if (!r.ok) {
    const semTabela = /migration 0009/.test(r.erro);
    return NextResponse.json({ error: r.erro }, { status: semTabela ? 503 : 400 });
  }
  return NextResponse.json({ ok: true, acao: r.acao, detalhe: r.detalhe, etapas: r.vinculos });
}
