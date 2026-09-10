import { NextResponse } from "next/server";
import { msgDb } from "./mensageria";
import { tabelas } from "./canal";
import { canalPorId, fonteExterna, somenteLeitura } from "./canais";

// ESTADO DE ATENDIMENTO DO CANAL DE FONTE EXTERNA (09/09/2026).
//
// O canal `whatsapp-agent` LE conversas e mensagens do banco do agente, mas
// status, etiqueta, ficha, arquivo e anotacao interna sao do PAINEL — e moram no
// mesmo par de tabelas que qualquer canal extra tem (`conversas_<id>` /
// `mensagens_<id>`, criado por `mensageria.criar_canal_whatsapp(id)` da 0007; o
// /setup chama pra cada canal declarado). Nenhuma tabela nova: e a linha de
// conversa de sempre, so que quem a cria e o painel na primeira acao, nao o
// webhook (o agente nao manda webhook pro painel).
//
// As rotas de escrita chamam `prepararEstadoExterno` no lugar do antigo 403
// "somente leitura": canal SEM estado no painel (instagram-agent) continua 403;
// canal do agente ganha a linha e segue pelo caminho normal da rota. Par de
// tabelas ausente = 503 com o SQL, nunca 500 cru.

const TABELA_AUSENTE = ["42P01", "PGRST205", "PGRST204"];
export function tabelaAusente(erro: { code?: string | null } | null | undefined): boolean {
  return !!erro && TABELA_AUSENTE.includes(String(erro.code ?? ""));
}

export type Garantia = { ok: true } | { ok: false; status: number; aviso: string };

/** A linha de conversa do canal externo existe? Cria "aberta" se nao. Idempotente. */
export async function garantirLinha(canal: string, chatId: string, nome?: string | null): Promise<Garantia> {
  const T = tabelas(canal);
  const { error } = await msgDb()
    .from(T.conversas)
    .upsert({ chat_id: chatId, nome: nome || chatId, status: "aberto" }, { onConflict: "chat_id", ignoreDuplicates: true });
  if (!error) return { ok: true };
  if (tabelaAusente(error)) {
    return {
      ok: false,
      status: 503,
      aviso: `o canal "${canal}" ainda nao tem as tabelas de estado no painel — rode no SQL Editor: select mensageria.criar_canal_whatsapp('${canal}'); (o /setup faz isso sozinho)`,
    };
  }
  return { ok: false, status: 500, aviso: error.message };
}

/**
 * O gate das rotas de ESCRITA de estado. null = pode seguir pelo caminho normal.
 * `oQue` completa a frase do 403 do canal somente leitura ("etiquetas", "a nota"...).
 */
export async function prepararEstadoExterno(canal: string, chatId: string, oQue: string): Promise<NextResponse | null> {
  const def = canalPorId(canal);
  if (!def || !fonteExterna(def)) return null;
  if (somenteLeitura(canal)) {
    return NextResponse.json({ error: `canal somente leitura: ${oQue} ainda nao disponivel pra este canal` }, { status: 403 });
  }
  const g = await garantirLinha(canal, chatId);
  if (!g.ok) return NextResponse.json({ error: g.aviso }, { status: g.status });
  return null;
}

/** Varias linhas de uma vez (rotas em massa): um upsert por lote de 200. */
export async function garantirLinhas(canal: string, chatIds: string[]): Promise<Garantia> {
  const T = tabelas(canal);
  for (let i = 0; i < chatIds.length; i += 200) {
    const { error } = await msgDb()
      .from(T.conversas)
      .upsert(chatIds.slice(i, i + 200).map((chat_id) => ({ chat_id, nome: chat_id, status: "aberto" })), { onConflict: "chat_id", ignoreDuplicates: true });
    if (error) return tabelaAusente(error) ? await garantirLinha(canal, chatIds[0]) : { ok: false, status: 500, aviso: error.message };
  }
  return { ok: true };
}

export type EstadoLinha = {
  chat_id: string;
  status: string;
  arquivada: boolean;
  auto_arquivar: boolean;
  responsavel_id: string | null;
  responsavel_nome: string | null;
  responsavel_tipo: string | null;
  etiquetas: string[];
  aguardando_avaliacao: boolean;
};

/** O estado que o painel guarda das conversas listadas (lotes de 200). Tabela ausente = mapa vazio. */
export async function estadosDe(canal: string, ids: string[]): Promise<Map<string, EstadoLinha>> {
  const out = new Map<string, EstadoLinha>();
  if (!ids.length) return out;
  const T = tabelas(canal);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await msgDb()
      .from(T.conversas)
      .select("chat_id,status,arquivada,auto_arquivar,responsavel_id,responsavel_nome,responsavel_tipo,etiquetas,aguardando_avaliacao")
      .in("chat_id", ids.slice(i, i + 200));
    if (error) {
      if (!tabelaAusente(error)) console.error("estado externo:", error.message);
      return out;
    }
    for (const r of (data ?? []) as any[]) {
      out.set(r.chat_id, {
        chat_id: r.chat_id,
        status: r.status || "aberto",
        arquivada: !!r.arquivada,
        auto_arquivar: !!r.auto_arquivar,
        responsavel_id: r.responsavel_id ?? null,
        responsavel_nome: r.responsavel_nome ?? null,
        responsavel_tipo: r.responsavel_tipo ?? null,
        etiquetas: Array.isArray(r.etiquetas) ? r.etiquetas : [],
        aguardando_avaliacao: !!r.aguardando_avaliacao,
      });
    }
  }
  return out;
}

/** Anotacoes internas (e notas de transcricao) do painel numa conversa externa. Tabela ausente = []. */
export async function notasDe(canal: string, chatId: string, limite = 100): Promise<any[]> {
  const T = tabelas(canal);
  const { data, error } = await msgDb()
    .from(T.mensagens)
    .select(
      "id,direcao,tipo,conteudo,sender_name,sender_phone,status,criada_em,media_url,media_mime,enviado_por_id,enviado_por_nome,provider_msg_id,quoted_msg_id,is_deleted,editada_em,reacao,encaminhada"
    )
    .eq("chat_id", chatId)
    .eq("direcao", "interna")
    .order("criada_em", { ascending: false })
    .limit(limite);
  if (error) {
    if (!tabelaAusente(error)) console.error("notas externas:", error.message);
    return [];
  }
  return data ?? [];
}
