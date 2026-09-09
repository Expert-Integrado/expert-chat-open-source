import { msgDb } from "./mensageria";
import { tabelas } from "./canal";
import type { CanalDef } from "./canais";
import { instanciaDoAgente } from "./fonte-externa";
import { enviadoPorNome } from "./whatsapp-agent-formato";
import { agregarMensagens, contarPorDia, type MensagemAgenteResumo } from "./relatorios-agente-formato";
import { createClient } from "@supabase/supabase-js";

// Os numeros de MENSAGENS dos relatorios, lidos do banco do agente e SOBREPOSTOS
// ao que a funcao SQL devolveu (status, CSAT e SLA continuam vindo das tabelas
// do painel, onde o estado do canal do agente mora). Ver relatorios-agente-formato.ts.
//
// ponytail: le ate TETO mensagens no periodo (paginado). Numero com mais que isso
// num mes recebe o relatorio marcado `parcial: true` — subir o teto ou somar no
// banco e o proximo passo quando alguem medir que acontece.
const TETO = 20_000;
const PAGINA = 1000;

function db() {
  const url = process.env.WA_SUPABASE_URL || process.env.MSG_SUPABASE_URL!;
  const key = process.env.WA_SUPABASE_SERVICE_KEY || process.env.MSG_SUPABASE_SERVICE_KEY!;
  return createClient(url, key, { db: { schema: "public" }, auth: { persistSession: false } });
}

async function mensagensNoPeriodo(instanceId: string, desde: string, ate: string): Promise<{ rows: MensagemAgenteResumo[]; parcial: boolean }> {
  const rows: MensagemAgenteResumo[] = [];
  for (let de = 0; de < TETO; de += PAGINA) {
    const { data, error } = await db()
      .from("messages")
      .select("chat_id,from_me,message_ts,sent_by_agent_name,content")
      .eq("instance_id", instanceId)
      .eq("is_deleted", false)
      .gte("message_ts", desde)
      .lt("message_ts", ate)
      .order("message_ts", { ascending: true })
      .range(de, de + PAGINA - 1);
    if (error) {
      console.error("relatorio agente:", error.message);
      break;
    }
    rows.push(...((data ?? []) as MensagemAgenteResumo[]));
    if (!data || data.length < PAGINA) return { rows, parcial: false };
  }
  return { rows, parcial: true };
}

const instanciaDo = instanciaDoAgente;

/** /api/relatorio (relatorio_atendimento): por_dia, por_atendente, primeira resposta e por_status. */
export async function sobreporAtendimento(canal: CanalDef, base: any, dias: number, fuso: string): Promise<any> {
  const inst = await instanciaDo(canal);
  if (!inst) return base;
  const ate = new Date();
  const desde = new Date(ate.getTime() - dias * 86_400_000);
  const { rows, parcial } = await mensagensNoPeriodo(inst.instance_id, desde.toISOString(), ate.toISOString());
  const agg = agregarMensagens(rows, fuso, enviadoPorNome);
  // por_status vem das linhas de estado do painel (a funcao SQL so conhece central/apioficial)
  const porStatus: Record<string, number> = { aberto: 0, atendimento: 0, aguardando: 0, concluido: 0 };
  const { data } = await msgDb().from(tabelas(canal.id).conversas).select("status").limit(10_000);
  for (const r of (data ?? []) as { status: string }[]) if (r.status in porStatus) porStatus[r.status]++;
  const { data: csat } = await msgDb().from("avaliacoes").select("nota").eq("canal", canal.id).gte("criada_em", desde.toISOString());
  const notas = ((csat ?? []) as { nota: number }[]).map((x) => x.nota);
  return {
    ...(base ?? {}),
    por_status: porStatus,
    por_dia: agg.por_dia.map(({ dia, recebidas, enviadas }) => ({ dia, recebidas, enviadas })),
    por_atendente: agg.por_atendente.slice(0, 20),
    primeira_resposta_media_s: agg.primeira_resposta_media_s,
    csat_media: notas.length ? Math.round((notas.reduce((a, b) => a + b, 0) / notas.length) * 100) / 100 : null,
    csat_total: notas.length,
    fuso,
    fonte: "whatsapp-agent",
    ...(parcial ? { parcial: true } : {}),
  };
}

/** /api/relatorios/serie: mensagens, por_usuario, novos_atendimentos e novos_chats por dia. */
export async function sobreporSerie(canal: CanalDef, base: any, desde: string, ate: string, fuso: string): Promise<any> {
  const inst = await instanciaDo(canal);
  if (!inst) return base;
  const [{ rows, parcial }, chats] = await Promise.all([
    mensagensNoPeriodo(inst.instance_id, desde, ate),
    db().from("chats").select("created_at").eq("instance_id", inst.instance_id).gte("created_at", desde).lt("created_at", ate).limit(10_000),
  ]);
  const agg = agregarMensagens(rows, fuso, enviadoPorNome);
  return {
    ...(base ?? {}),
    mensagens: agg.por_dia,
    por_usuario: agg.por_atendente,
    novos_atendimentos: agg.novos_atendimentos,
    novos_chats: contarPorDia(((chats.data ?? []) as { created_at: string }[]).map((c) => c.created_at), fuso),
    fonte: "whatsapp-agent",
    ...(parcial ? { parcial: true } : {}),
  };
}
