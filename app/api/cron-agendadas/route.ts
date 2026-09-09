import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { zapiSendText, credsZapi } from "@/lib/zapi";
import { credsGupshup, gsSendText, janela24h } from "@/lib/gupshup";
import { credsEvolution, evoSendText } from "@/lib/evolution";
import { canalPorId } from "@/lib/canais";
import { textoComAssinatura } from "@/lib/conversa-automatica";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// Coluna `reservada_em` (0021) presente? Cacheado por instancia, do jeito que a
// lib/auth-server.ts faz com as colunas da 0019: a primeira resposta 42703
// desliga a tentativa e o resto do processo nao paga por ela.
let colunaReservadaOk = true;

// Processa mensagens agendadas vencidas — chamado pelo pg_cron (1x/min) com o
// segredo do painel. Aplica a assinatura de quem agendou, respeita a janela de
// 24h nos canais Gupshup e grava a mensagem como enviada por essa pessoa.
// O envio sai pelo NUMERO DO CANAL da agendada (P1): canal desconhecido,
// inativo ou sem credencial = erro na fila — NUNCA cai no numero de outro canal.
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const segredo = process.env.CHATGURU_SYNC_SECRET;
  if (!segredo || auth !== `Bearer ${segredo}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = msgDb();

  // FRENTE S (correcao da 2a revisao) — SAIDA PRA LINHA PRESA EM `enviando`.
  //
  // A reserva resolveu a corrida, mas criou um estado sem porta de saida: com
  // `maxDuration = 60` a funcao pode ser MORTA no meio do laco, sem passar pelo
  // catch, e a linha fica `enviando` pra sempre — o PATCH e o DELETE recusam
  // qualquer coisa que nao seja `pendente`, entao nem a pessoa conseguia limpar.
  //
  // A varredura NUNCA REENVIA (isso poderia entregar a mensagem duas vezes ao
  // cliente): move pra `erro` com uma frase que diz o que fazer. 10 minutos e
  // folgado — o teto de execucao e 60s, entao nao existe envio legitimo em curso
  // com essa idade.
  // O RELOGIO E `reservada_em`, nao `enviar_em` (correcao da 3a revisao):
  // "vencida ha muito tempo" e "em envio ha muito tempo" sao coisas diferentes.
  // Depois de um backlog (cron parado, fila acumulada), uma linha com `enviar_em`
  // de horas atras entra em envio LEGITIMO e seria marcada como interrompida no
  // mesmo minuto — mandando o atendente conferir no WhatsApp uma mensagem que
  // estava saindo naquele instante, com risco de reenvio manual.
  const LIMITE_PRESA_MS = 10 * 60 * 1000;
  const corte = new Date(Date.now() - LIMITE_PRESA_MS).toISOString();
  const ERRO_PRESA =
    "envio interrompido no meio — confira na conversa do WhatsApp se a mensagem saiu antes de agendar de novo";
  // A coluna vem da 0021. Se ela nao rodou, a varredura NAO PODE simplesmente
  // falhar (deixaria a linha presa pra sempre, que e o defeito que ela conserta):
  // cai pro relogio antigo e segue. Mesmo padrao do `colunasEscopoOk` da
  // lib/auth-server.ts pra coluna de migration pendente.
  let liberadas = 0;
  let porReserva = true;
  {
    const varrer = (coluna: "reservada_em" | "enviar_em", nulos: boolean) => {
      let q = db
        .from("mensagens_agendadas")
        .update({ status: "erro", erro: ERRO_PRESA })
        .eq("status", "enviando");
      // A COORTE `reservada_em IS NULL` precisa de varredura PROPRIA (achado da
      // 4a revisao): em SQL, `NULL < corte` e UNKNOWN, nao true — entao a linha
      // com a coluna EXISTENTE e valor NULL nao casava no `.lt` e nao era pega
      // por ramo nenhum. Ficava `enviando` pra sempre, invisivel, com PATCH e
      // DELETE recusando. Pra essa coorte o relogio possivel e o `enviar_em`.
      if (nulos) q = q.is("reservada_em", null).lt("enviar_em", corte);
      else q = q.lt(coluna, corte);
      return q.select("id");
    };

    const r = await varrer("reservada_em", false);
    if (r.error && String(r.error.code) === "42703") {
      // coluna INEXISTENTE (0021 nao rodou): relogio antigo pra todo mundo
      porReserva = false;
      colunaReservadaOk = false;
      const r2 = await varrer("enviar_em", false);
      liberadas += r2.data?.length ?? 0;
    } else {
      liberadas += r.data?.length ?? 0;
      // SO com o UPDATE limpo. Erro que NAO e 42703 (rede, pool, timeout) nao diz
      // nada sobre a coluna existir: rearmar o latch ali seria decidir sobre o
      // schema em cima de um blip, e rodar a 2a passada seria uma consulta que ja
      // se sabe que vai falhar junto.
      if (!r.error) {
        // REARMA O LATCH (achado da 4a revisao): ele era so de mao unica. Se o
        // codigo subiu ANTES da 0021, o primeiro 42703 desligava
        // `colunaReservadaOk` e nada o religava — depois da migration as reservas
        // continuavam gravando NULL pra sempre, e a coorte NULL acima e justamente
        // a que ninguem varria. Esta varredura sonda a coluna a cada tick, entao e
        // o lugar natural de reconhecer que ela passou a existir.
        colunaReservadaOk = true;
        // e a coorte legada (reservada antes da migration, ou por uma instancia
        // que ainda estava com o latch baixo) sai nesta segunda passada
        const rNull = await varrer("reservada_em", true);
        liberadas += rNull.data?.length ?? 0;
      }
    }
  }

  const { data: fila } = await db
    .from("mensagens_agendadas")
    .select("id,canal,chat_id,texto,criado_por_id,criado_por_nome")
    .eq("status", "pendente")
    .lte("enviar_em", new Date().toISOString())
    .order("enviar_em")
    .limit(20);
  if (!fila?.length) return NextResponse.json({ ok: true, enviadas: 0, erros: 0, liberadas });

  let enviadas = 0, erros = 0, disputadas = 0;
  for (const item of fila) {
    let m: any = item;
    try {
      // FRENTE S (31/08/2026) — RESERVA A LINHA ANTES DE ENVIAR.
      //
      // Antes disto o laco era select -> envia -> update no fim, e o `status`
      // ficava "pendente" durante o envio INTEIRO. Duas consequencias, as duas
      // achadas na revisao cega:
      //   1. o tick N+1 (pg_cron roda 1x/min, e este laco pode passar de 1min)
      //      pegava a MESMA linha e mandava a mensagem DE NOVO pro cliente;
      //   2. o `.eq("status","pendente")` do PATCH /api/agendadas nao protegia
      //      nada: durante todo o envio ele respondia "atualizado" pra uma
      //      mensagem que o cliente JA TINHA RECEBIDO.
      // Trocar o status ANTES do envio, condicionado a ele ainda estar
      // "pendente", faz a disputa ser resolvida pelo banco: quem consegue o
      // UPDATE envia, quem nao consegue nao envia.
      // `reservada_em` = o relogio da varredura acima. A coluna e da 0021: se ela
      // nao rodou, a reserva NAO pode falhar por causa disso (quebraria o envio
      // agendado de toda instalacao que ainda nao migrou) — grava sem a coluna e
      // a varredura usa o relogio antigo.
      let reservada: any[] | null = null;
      {
        const patch: Record<string, unknown> = { status: "enviando" };
        if (colunaReservadaOk) patch.reservada_em = new Date().toISOString();
        const r = await db
          .from("mensagens_agendadas")
          .update(patch)
          .eq("id", item.id)
          .eq("status", "pendente")
          .select("id,canal,chat_id,texto,criado_por_id,criado_por_nome");
        if (r.error && String(r.error.code) === "42703") {
          colunaReservadaOk = false;
          const r2 = await db
            .from("mensagens_agendadas")
            .update({ status: "enviando" })
            .eq("id", item.id)
            .eq("status", "pendente")
            .select("id,canal,chat_id,texto,criado_por_id,criado_por_nome");
          if (r2.error) throw r2.error;
          reservada = (r2.data as any) ?? null;
        } else {
          if (r.error) throw r.error;
          reservada = (r.data as any) ?? null;
        }
      }
      // ninguem reservou = outro tick levou, ou a pessoa cancelou no intervalo.
      // Nao e erro: e a corrida sendo resolvida corretamente.
      if (!reservada?.length) { disputadas++; continue; }
      // e o texto que vale e o da LINHA RESERVADA, nao o do select do topo: uma
      // edicao (PATCH) que entrou no meio ja esta gravada aqui, e enviar o texto
      // velho seria mandar pro cliente exatamente o que a pessoa corrigiu.
      m = reservada[0];

      const def = canalPorId(m.canal || "central");
      if (!def || !def.ativo) throw new Error(`canal "${m.canal}" desconhecido ou inativo`);
      const T = def.tabelas;

      // Assinatura de quem agendou — MESMO formato do envio normal, pela mesma
      // funcao (lib/conversa-automatica.ts). Agendar e ato de GENTE: a mensagem
      // sai com o nome de quem escreveu, nao com rotulo de automacao.
      let textoEnviar = m.texto;
      if (m.criado_por_id) {
        const { data: ass } = await db
          .from("perfis")
          .select("assinatura_ativa,assinatura_nome")
          .eq("user_id", m.criado_por_id)
          .maybeSingle();
        textoEnviar = textoComAssinatura(m.texto, {
          assinatura_ativa: ass?.assinatura_ativa === true,
          assinatura_nome: ass?.assinatura_nome,
          nome: m.criado_por_nome,
          // fallback historico desta rota: agendada antiga pode ter ficado sem
          // nome de autor (e nome de exibicao so-de-espacos cai aqui tambem) —
          // assina generico em vez de sair crua e sem ninguem notar.
          fallback: "Atendimento",
        });
      }

      let providerId: string | null = null;
      if (def.fonte === "gupshup") {
        const j = await janela24h(m.chat_id, T.mensagens);
        if (!j.aberta) throw new Error("janela de 24h fechada na hora do envio");
        const credsGs = await credsGupshup(def.id);
        if (!credsGs) throw new Error("credenciais Gupshup do canal ausentes");
        providerId = (await gsSendText(credsGs, m.chat_id, textoEnviar)).messageId || null;
      } else if (def.fonte === "zapi") {
        const creds = credsZapi(def.id);
        if (!creds) throw new Error("credenciais Z-API do canal ausentes");
        providerId = (await zapiSendText(creds, m.chat_id, textoEnviar, null)).messageId || null;
      } else if (def.fonte === "evolution") {
        const creds = credsEvolution(def.id);
        if (!creds) throw new Error("credenciais Evolution do canal ausentes");
        providerId = (await evoSendText(creds, m.chat_id, textoEnviar, null)).messageId || null;
      } else {
        throw new Error("canal de fonte externa nao envia mensagem");
      }

      const now = new Date().toISOString();
      await db.from(T.mensagens).insert({
        chat_id: m.chat_id,
        direcao: "out",
        tipo: "text",
        conteudo: textoEnviar,
        provider_msg_id: providerId,
        status: "sent",
        criada_em: now,
        enviado_por_id: m.criado_por_id,
        enviado_por_nome: m.criado_por_nome,
      });
      await db
        .from(T.conversas)
        .update({
          last_message_at: now,
          last_message_preview: `${m.criado_por_nome || "Agendada"}: ${m.texto}`.slice(0, 140),
          updated_at: now,
        })
        .eq("chat_id", m.chat_id);
      await db.from("mensagens_agendadas").update({ status: "enviada", enviada_em: now }).eq("id", m.id);
      enviadas++;
    } catch (e: any) {
      // devolve a linha reservada pra "erro" (nunca pra "pendente": o envio pode
      // ter saido antes da falha, e reenviar por conta propria e pior que parar).
      await db
        .from("mensagens_agendadas")
        .update({ status: "erro", erro: String(e?.message || e).slice(0, 300) })
        .eq("id", item.id);
      erros++;
    }
  }
  // `disputadas` = linhas que outro tick (ou um cancelamento) levou antes desta
  // passada. Numero saudavel e 0; se subir, o laco esta passando de 1 minuto.
  return NextResponse.json({ ok: true, enviadas, erros, disputadas, liberadas, por_reserva: porReserva });
}
