import { NextRequest, NextResponse } from "next/server";
import { getUser, escopoDaChaveNoRequest } from "@/lib/auth-server";
import { canalNoEscopo } from "@/lib/escopo-chave";
import { getPerfil, ehAdmin, permitido, podeVerConversa } from "@/lib/perfil";
import { canalDeBody, canalDe, tabelas } from "@/lib/canal";
import { msgDb } from "@/lib/mensageria";
import { restricaoEfetiva } from "@/lib/embed";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Mensagens agendadas (enviar depois). O envio de fato acontece no
// /api/cron-agendadas (pg_cron 1x/min).
export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  const canal = canalDe(req);
  const chatId = req.nextUrl.searchParams.get("chat_id");
  if (!chatId) return NextResponse.json({ error: "chat_id obrigatorio" }, { status: 400 });
  if (emb && !emb.permite(chatId)) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }
  // VAZAMENTO CORRIGIDO 31/08/2026: este GET checava a restricao de BU mas NAO
  // o escopo de visao — o POST logo abaixo sempre checou. Resultado: quem tinha
  // escopo "proprias" e nenhuma restricao de BU conseguia ler, por chat_id na
  // URL, os agendamentos de conversa alheia (texto da mensagem e quem agendou).
  // O criterio de acesso e o mesmo do resto do painel: se nao ve a conversa,
  // nao ve o que esta agendado nela.
  if (!(await podeVerConversa(chatId, user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  const { data, error } = await msgDb()
    .from("mensagens_agendadas")
    .select("id,texto,enviar_em,status,criado_por_nome,criado_por_id")
    .eq("canal", canal)
    .eq("chat_id", chatId)
    // FRENTE S: `enviando` entra na lista junto com `pendente`. O cron passou a
    // RESERVAR a linha antes de enviar, e uma linha reservada some do filtro
    // `pendente` — sem isto ela desapareceria da tela no meio do envio, e uma
    // linha que ficou presa em `enviando` (funcao morta no meio) seria invisivel
    // pra sempre. A tela mostra "saindo agora" e nao oferece editar/cancelar.
    .in("status", ["pendente", "enviando"])
    .order("enviar_em");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ agendadas: data ?? [] }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

// FRENTE S (31/08/2026), card 86ak85nyj — as regras do agendamento num lugar so.
//
// Elas nasceram escritas a mao dentro do POST; com o PATCH (editar antes de
// sair) viraria a segunda copia, e regra copiada diverge na primeira mudanca —
// aqui isso significaria "o POST recusa data no passado e o PATCH aceita".
const LIMITE_TEXTO_AGENDADA = 4096;
/** margem minima: agendar pra "agora" perderia a corrida com o cron de 1/min */
const MARGEM_MINIMA_MS = 30_000;
const MAX_ADIANTE_MS = 90 * 24 * 3600 * 1000;

function textoDaAgendada(bruto: unknown): { ok: true; texto: string } | { ok: false; erro: string } {
  const t = String(bruto ?? "").trim();
  if (!t) return { ok: false, erro: "texto obrigatorio" };
  if (t.length > LIMITE_TEXTO_AGENDADA) return { ok: false, erro: "mensagem muito longa" };
  return { ok: true, texto: t };
}

function horaDaAgendada(bruto: unknown): { ok: true; iso: string } | { ok: false; erro: string } {
  const quando = new Date(String(bruto ?? ""));
  if (isNaN(quando.getTime()) || quando.getTime() < Date.now() + MARGEM_MINIMA_MS) {
    // criterio do card: "agendamento com data no passado e recusado com mensagem
    // clara". Uma data invalida NUNCA e silenciosamente trocada pela hora atual.
    return { ok: false, erro: "horario invalido — precisa ser no futuro" };
  }
  if (quando.getTime() > Date.now() + MAX_ADIANTE_MS) {
    return { ok: false, erro: "maximo 90 dias pra frente" };
  }
  return { ok: true, iso: quando.toISOString() };
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { chat_id, texto, enviar_em } = body;
  const canal = canalDeBody(body);
  // agendar pra canal sem envio cabeado criaria mensagem que o cron mandaria
  // pelo numero errado — recusa na entrada (lib/canais.ts)
  const { envioDisponivel } = await import("@/lib/canais");
  if (!envioDisponivel(canal)) {
    return NextResponse.json({ error: "envio nao configurado pra este canal" }, { status: 403 });
  }
  if (!permitido(perfil, "disparo")) {
    return NextResponse.json({ error: "sem permissao pra agendar mensagem" }, { status: 403 });
  }
  if (!chat_id) return NextResponse.json({ error: "chat_id e texto sao obrigatorios" }, { status: 400 });
  const vt = textoDaAgendada(texto);
  if (!vt.ok) return NextResponse.json({ error: vt.erro }, { status: 400 });
  const t = vt.texto;
  const vq = horaDaAgendada(enviar_em);
  if (!vq.ok) return NextResponse.json({ error: vq.erro }, { status: 400 });
  const quando = new Date(vq.iso);
  if (!(await podeVerConversa(String(chat_id), user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(String(chat_id))) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }
  const T = tabelas(canal);
  const { data: conversa } = await msgDb().from(T.conversas).select("chat_id").eq("chat_id", String(chat_id)).maybeSingle();
  if (!conversa) return NextResponse.json({ error: "conversa nao encontrada" }, { status: 404 });

  const { data, error } = await msgDb()
    .from("mensagens_agendadas")
    .insert({
      canal,
      chat_id: String(chat_id),
      texto: t,
      enviar_em: quando.toISOString(),
      criado_por_id: user.id,
      criado_por_nome: user.nome,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data.id });
}

// FRENTE S (31/08/2026), card 86ak85nyj — EDITAR a agendada antes de sair.
//
// Criterio do card: "a conversa lista as mensagens agendadas, e da pra EDITAR ou
// cancelar antes de sair". Cancelar ja existia (DELETE); editar nao.
//
// POR QUE PATCH E NAO "cancela e cria de novo": cancelar+criar troca o `id`, e
// com isso a agendada perde a autoria original e sobe pro fim da lista. Pior:
// entre o cancelar e o criar existe uma janela em que a mensagem NAO esta
// agendada — se o segundo pedido falhar (rede, 403, teto), o atendente fica
// achando que so mudou o horario e o cliente nunca recebe nada.
//
// O canal NAO e lido aqui de proposito (a linha e achada por `id` na tabela
// unica `mensagens_agendadas`): por isso este metodo fica FORA de
// `CANAL_PADRAO_EM` em lib/escopo-chave.ts — declarar metodo que nao resolve
// canal criaria negacao falsa pra chave restrita a um canal (defeito medido na
// revisao da Frente Q).
export async function PATCH(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({} as any));
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "id obrigatorio" }, { status: 400 });

  const perfil = await getPerfil(user.id);
  // MESMA permissao de CRIAR. Quem nao pode agendar nao pode reescrever o texto
  // que vai sair pro cliente daqui a duas horas — seria a mesma capacidade por
  // uma porta lateral.
  if (!permitido(perfil, "disparo")) {
    return NextResponse.json({ error: "sem permissao pra mexer em mensagem agendada" }, { status: 403 });
  }

  const db = msgDb();
  const { data: alvo } = await db
    .from("mensagens_agendadas")
    // canal e chat_id entram no select pra dar pra checar A CONVERSA (abaixo)
    .select("criado_por_id,status,canal,chat_id")
    .eq("id", id)
    .maybeSingle();
  if (!alvo) return NextResponse.json({ error: "nao encontrada" }, { status: 404 });
  // JA PROCESSADA nao se edita: o texto ja saiu (ou ja foi cancelado), e reescrever
  // o registro faria a conversa contar uma historia diferente do que o cliente leu.
  if (alvo.status !== "pendente") return NextResponse.json({ error: "essa ja foi processada" }, { status: 400 });
  if (alvo.criado_por_id !== user.id && !ehAdmin(perfil)) {
    return NextResponse.json({ error: "esse agendamento nao e seu" }, { status: 403 });
  }
  // OS MESMOS DOIS GATES DO POST (achado da revisao cega: faltavam aqui).
  //
  // "Ser dono ou admin" NAO substitui nenhum dos dois: escopo de visao e contexto
  // de embed mudam DEPOIS que a mensagem foi agendada. Um admin operando numa aba
  // de embed restrita a uma BU nao pode reescrever, por `id`, o texto que vai sair
  // numa conversa fora daquele contexto — e foi exatamente o vazamento que o GET
  // desta rota levou nesta frente (linha 25 acima).
  const canalAlvo = String(alvo.canal || "central");
  const chatAlvo = String(alvo.chat_id);
  // ESCOPO DE CANAL DA CHAVE, comparado AQUI (achado da 3a revisao).
  //
  // Este metodo nao recebe canal no pedido: acha a linha por `id` e le o canal
  // DELA. A porta central (`escopoPermite`) nao teve o que comparar, e por isso o
  // metodo fica fora de `CANAL_PADRAO_EM` — declarar canal padrao ali criaria
  // negacao falsa. Sem esta comparacao, uma chave restrita a um canal reescrevia
  // o texto de uma agendada de OUTRO canal (mesma classe do furo da Frente U).
  //
  // CUIDADO AO EDITAR ESTE COMENTARIO. A varredura B.10 de
  // `scripts/prova-seguranca-conta.ts` procura, DENTRO do handler, mencao literal
  // ao id do canal OFICIAL (e aos dois resolvedores de canal do `lib/canal.ts`)
  // pra achar quem resolve canal A MAO. Este metodo NAO resolve canal do pedido —
  // ele le o canal da LINHA — entao escrever aquele id, ainda que so em prosa,
  // faz a varredura cobrar uma entrada em `CANAL_PADRAO_EM` que criaria negacao
  // falsa. Ja derrubou a prova de seguranca uma vez, editando este comentario.
  //
  // E o `|| "central"` do `canalAlvo` acima e OUTRA coisa: e o default de fabrica
  // do canal, codigo de verdade, e nao esta no padrao da varredura. A frase que
  // ficava aqui — "o id do canal nao e citado nominalmente aqui" — era falsa por
  // nao fazer essa distincao: o que nao pode ser citado e o id que a varredura
  // PROCURA, nao qualquer id de canal.
  // A cobertura real desta comparacao esta na secao 7.9(h) da prova da fila.
  const escopoChave = escopoDaChaveNoRequest(req);
  if (escopoChave && !canalNoEscopo(escopoChave, canalAlvo)) {
    return NextResponse.json({ error: "esta chave nao alcanca o canal desta agendada" }, { status: 403 });
  }
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  if (emb && !emb.permite(chatAlvo)) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }
  if (!(await podeVerConversa(chatAlvo, user, perfil, canalAlvo))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }

  const patch: { texto?: string; enviar_em?: string } = {};
  if (body?.texto !== undefined) {
    const vt = textoDaAgendada(body.texto);
    if (!vt.ok) return NextResponse.json({ error: vt.erro }, { status: 400 });
    patch.texto = vt.texto;
  }
  if (body?.enviar_em !== undefined) {
    const vq = horaDaAgendada(body.enviar_em);
    if (!vq.ok) return NextResponse.json({ error: vq.erro }, { status: 400 });
    patch.enviar_em = vq.iso;
  }
  // PATCH POR CAMPO: campo ausente MANTEM o valor gravado, nunca apaga (mesma
  // semantica que a Frente Q fixou pro escopo de chave). Pedido que nao muda
  // nada e recusado em vez de responder 200 — "salvei" sem ter salvado nada e a
  // mentira que faz o atendente sair achando que trocou o horario.
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "nada pra mudar (mande texto e/ou enviar_em)" }, { status: 400 });
  }

  // O UPDATE leva `.eq("status","pendente")`: entre a leitura acima e esta escrita
  // cabe o cron de 1/min. Sem a guarda, editar uma agendada que ACABOU de sair
  // reescreveria a linha de uma mensagem que o cliente ja recebeu.
  const { data, error } = await db
    .from("mensagens_agendadas")
    .update(patch)
    .eq("id", id)
    .eq("status", "pendente")
    .select("id,texto,enviar_em,status,criado_por_nome,criado_por_id");
  if (error) {
    console.error("agendadas (patch):", error.code, error.message);
    return NextResponse.json({ error: "nao deu pra salvar a alteracao" }, { status: 500 });
  }
  if (!data?.length) {
    return NextResponse.json({ error: "essa acabou de ser enviada ou cancelada" }, { status: 409 });
  }
  return NextResponse.json({ ok: true, agendada: data[0] });
}

export async function DELETE(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id obrigatorio" }, { status: 400 });
  const db = msgDb();
  const { data: alvo } = await db
    .from("mensagens_agendadas")
    .select("criado_por_id,status,canal,chat_id")
    .eq("id", id)
    .maybeSingle();
  if (!alvo) return NextResponse.json({ error: "nao encontrada" }, { status: 404 });
  if (alvo.status !== "pendente") return NextResponse.json({ error: "essa ja foi processada" }, { status: 400 });
  const perfil = await getPerfil(user.id);
  if (alvo.criado_por_id !== user.id && !ehAdmin(perfil)) {
    return NextResponse.json({ error: "esse agendamento nao e seu" }, { status: 403 });
  }
  // MESMO escopo de canal do PATCH: cancelar a agendada de outro canal e efeito
  // naquele canal, e a chave restrita nao alcanca.
  const escopoChave = escopoDaChaveNoRequest(req);
  if (escopoChave && !canalNoEscopo(escopoChave, String(alvo.canal || "central"))) {
    return NextResponse.json({ error: "esta chave nao alcanca o canal desta agendada" }, { status: 403 });
  }
  // FRENTE S: os mesmos dois gates do PATCH. Este metodo e PRE-EXISTENTE e o furo
  // tambem era — mas e o furo IDENTICO ao do item 4 da revisao, no mesmo arquivo,
  // e cancelar a mensagem de uma conversa fora do escopo tambem e efeito naquela
  // conversa. Corrigido junto e DECLARADO no report (nao e mudanca silenciosa).
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  if (emb && !emb.permite(String(alvo.chat_id))) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }
  if (!(await podeVerConversa(String(alvo.chat_id), user, perfil, String(alvo.canal || "central")))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  // MESMA GUARDA DE CORRIDA DO PATCH (correcao da 2a revisao). O DELETE checava o
  // status na LEITURA e escrevia sem condicao — e os dois gates que este metodo
  // acabou de ganhar ALARGARAM a janela (dois awaits novos antes da escrita).
  // Sem o `.eq`, a sequencia cron-reserva -> cron-envia -> DELETE-grava-cancelada
  // terminava com o atendente recebendo `ok:true` de um cancelamento que nao
  // aconteceu: a mensagem ja estava no celular do cliente. Perdeu a corrida = 409.
  const { data: canceladas, error } = await db
    .from("mensagens_agendadas")
    .update({ status: "cancelada" })
    .eq("id", id)
    .eq("status", "pendente")
    .select("id");
  if (error) {
    console.error("agendadas (delete):", error.code, error.message);
    return NextResponse.json({ error: "nao deu pra cancelar" }, { status: 500 });
  }
  if (!canceladas?.length) {
    return NextResponse.json({ error: "essa acabou de sair — confira na conversa" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
