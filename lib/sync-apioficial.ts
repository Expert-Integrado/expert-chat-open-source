import { msgDb, pubDb } from "@/lib/mensageria";
import { getConfig } from "@/lib/config";
import { parseEvento, reacoesDoEvento, type MsgNova } from "@/lib/gupshup-inbound";
import { credsGupshup, gsSendText } from "@/lib/gupshup";
import { ehNotaCsat, notaDaMensagem, registrarAvaliacao } from "@/lib/csat";
import { avisarAvaliacao, avisarMensagemRecebida, avisarStatus } from "@/lib/webhooks-saida";
import { aplicarReinicio } from "@/lib/conversa-reinicio";
import type { RegrasConversa } from "@/lib/conversa-automatica";

// Ingestao do canal API oficial: a Gupshup entrega no fluxo de entrada externo,
// que grava o payload cru em public.webhook_events (source=gupshup_inbound).
// Este sync materializa os eventos novos nas tabelas do painel
// (mensagens_apioficial/conversas_apioficial), com cursor em mensageria.config.
// Dedupe por wamid (indice unico) — convive com o importador do ChatGuru.

// O parse dos formatos (Meta cloud e Gupshup v1) vive em lib/gupshup-inbound.ts
// — puro, sem banco/env, provado por scripts/prova-webhook-formatos.ts. Segue
// reexportado daqui porque e por aqui que as rotas historicas o importam.
export { parseEvento } from "@/lib/gupshup-inbound";
export type { MsgNova } from "@/lib/gupshup-inbound";

// Roda no maximo 1x a cada 5s por instancia (as rotas chamam a cada GET).
let ultimaRodada = 0;

export async function sincronizarApioficial(): Promise<void> {
  if (Date.now() - ultimaRodada < 5000) return;
  ultimaRodada = Date.now();
  const db = msgDb();

  try {
    const { data: cfgRow } = await db.from("config").select("valor").eq("chave", "apioficial_evt_cursor").maybeSingle();
    const cursor = Number(cfgRow?.valor ?? 0);

    const { data: eventos } = await pubDb()
      .from("webhook_events")
      .select("id,payload,received_at")
      .eq("source", "gupshup_inbound")
      .gt("id", cursor)
      .order("id", { ascending: true })
      .limit(200);
    if (!eventos?.length) return;

    const cfg = await getConfig();
    const T = { conversas: "conversas_apioficial", mensagens: "mensagens_apioficial" };
    for (const ev of eventos) {
      // reacao recebida (03/09/2026): aplica no alvo, nao vira mensagem
      for (const r of reacoesDoEvento(ev.payload)) {
        await db.from(T.mensagens).update({ reacao: r.emoji }).eq("provider_msg_id", r.alvo);
      }
      for (const m of parseEvento(ev.payload)) {
        await gravarMsgGupshup(db, cfg, T, m, {
          canal: "apioficial",
          responder: (texto) => responderApioficial(m.chat_id, texto),
        });
      }
    }

    const maiorId = eventos[eventos.length - 1].id;
    await db
      .from("config")
      .upsert({ chave: "apioficial_evt_cursor", valor: maiorId, updated_at: new Date().toISOString() }, { onConflict: "chave" });
  } catch (e: any) {
    console.error("sync apioficial:", e?.message);
  }
}

// Resposta automatica do builtin apioficial (hoje so o agradecimento da
// pesquisa). A janela de 24h esta aberta por definicao: isto so roda logo depois
// de uma mensagem que o cliente acabou de mandar.
async function responderApioficial(chatId: string, texto: string): Promise<void> {
  const creds = await credsGupshup("apioficial");
  if (!creds) return;
  await gsSendText(creds, chatId, texto);
}

// Grava UMA mensagem recebida de fonte Gupshup no par de tabelas do canal —
// mecanica unica usada pelo sync (webhook_events, builtin apioficial) e pelo
// webhook direto (/api/webhook?canal=<id> de fonte gupshup, P1 30/08/2026).
// Dedupe por provider_msg_id (23505 = ja veio pelo importador/sync).
//
// `ctx.canal` e o id do canal (vai na linha de `avaliacoes`); `ctx.responder`
// manda o agradecimento da pesquisa de satisfacao — opcional, porque nem todo
// chamador tem credencial de saida na mao.
export async function gravarMsgGupshup(
  db: any,
  cfg: { auto_desarquivar_recebida: boolean; auto_arquivar_concluida: boolean; teto_por_atendente: number } &
    RegrasConversa,
  T: { conversas: string; mensagens: string },
  m: MsgNova,
  ctx: { canal: string; responder?: (texto: string) => Promise<unknown> }
): Promise<void> {
  // estado ANTES do insert: e ele que diz se a conversa estava esperando a nota
  // da pesquisa (depois do upsert essa informacao continua la, mas ler antes
  // deixa a regra explicita e evita depender da ordem das escritas)
  // `status` entra na leitura que ja acontecia: e o "de" do webhook de saida, e
  // sem ele a conclusao pos-pesquisa avisaria uma transicao que nao houve (a
  // conversa ja estava concluida quando a pergunta saiu).
  const { data: convAntes } = await db
    .from(T.conversas)
    // `last_message_at`: carimbo de que a conversa REINICIOU (Frente N). Depois
    // do upsert desta mensagem ele ja e "agora" — le-se aqui ou nunca.
    .select("status,auto_arquivar,aguardando_avaliacao,responsavel_id,responsavel_nome,mensagens_nao_lidas,last_message_at")
    .eq("chat_id", m.chat_id)
    .maybeSingle();

  const { error } = await db.from(T.mensagens).insert({
    chat_id: m.chat_id,
    direcao: "in",
    tipo: m.tipo,
    conteudo: m.texto || `[${m.tipo}]`,
    sender_name: m.nome,
    sender_phone: m.chat_id,
    provider_msg_id: m.wamid,
    status: "received",
    criada_em: m.ts,
  });
  if (error) return; // 23505 (dedupe) ou falha pontual: nao mexe na conversa

  await db.from(T.conversas).upsert(
    {
      chat_id: m.chat_id,
      ...(m.nome ? { nome: m.nome } : {}),
      is_group: false,
      canal: "gupshup",
      last_message_at: m.ts,
      last_message_preview: (m.texto || `[${m.tipo}]`).slice(0, 140),
      updated_at: m.ts,
    },
    { onConflict: "chat_id" }
  );
  // NOTA da pesquisa de satisfacao ("5" numa conversa que esta aguardando):
  // grava a avaliacao e encerra a espera. NAO reabre o atendimento nem conta
  // como nao lida — quem respondeu a pesquisa nao esta pedindo ajuda. Sem isto,
  // aguardando_avaliacao ficava true pra sempre e a conversa nunca mais recebia
  // pesquisa (a metade que envia vive em /api/conversa).
  // webhook de saida: a mensagem ja esta gravada. Melhor-esforco e sem await —
  // destino do cliente fora do ar nao pode atrasar nem travar a ingestao.
  avisarMensagemRecebida({
    canal: ctx.canal,
    chatId: m.chat_id,
    tipo: m.tipo,
    deGrupo: false,
    temMidia: false, // a Gupshup nao entrega o arquivo no webhook (vem depois, pelo sync)
    providerMsgId: m.wamid,
    conteudo: m.texto,
  });

  if (
    ehNotaCsat({
      fromMe: false, // este caminho so materializa mensagem RECEBIDA
      isGroup: false, // a API oficial nao entrega grupo
      tipo: m.tipo,
      conteudo: m.texto,
      conversa: convAntes,
    })
  ) {
    const nota = notaDaMensagem(m.texto)!;
    const gravou = await registrarAvaliacao(db, cfg, T, {
      canal: ctx.canal,
      chatId: m.chat_id,
      nota,
      conversa: convAntes,
      agradecer: ctx.responder,
    });
    // so anuncia o que existe no banco: insert recusado nao vira avaliacao
    // registrada no CRM do cliente
    if (gravou) {
      avisarAvaliacao({
        canal: ctx.canal,
        chatId: m.chat_id,
        nota,
        atendenteId: convAntes?.responsavel_id,
        atendenteNome: convAntes?.responsavel_nome,
      });
    }
    // registrarAvaliacao tambem CONCLUI a conversa. Normalmente ela JA estava
    // concluida (a pergunta so sai ao concluir), e ai `avisarStatus` engole
    // sozinho — o aviso so sai no caso real de transicao.
    avisarStatus({
      canal: ctx.canal,
      chatId: m.chat_id,
      de: convAntes?.status ?? null,
      para: "concluido",
      porNome: "automacao: pesquisa de satisfacao",
      origem: "automacao",
    });
    return;
  }

  // F9: chat com auto_arquivar ligado nunca reabre sozinho
  if (convAntes?.auto_arquivar) {
    await db.from(T.conversas).update({ arquivada: true }).eq("chat_id", m.chat_id);
  } else if (cfg.auto_desarquivar_recebida) {
    await db
      .from(T.conversas)
      .update({ status: "aberto", arquivada: false })
      .eq("chat_id", m.chat_id)
      .or("status.eq.concluido,arquivada.eq.true");
  }
  // contador de nao lidas (sem RPC propria: le e escreve — ingestao e single-writer)
  await db
    .from(T.conversas)
    .update({ mensagens_nao_lidas: (convAntes?.mensagens_nao_lidas || 0) + 1 })
    .eq("chat_id", m.chat_id);
  // conversa REINICIADA (Frente N): mesma decisao das outras portas de ingestao,
  // pelo mesmo helper. Melhor-esforco — status torto nao desfaz a mensagem, mas
  // LOGA: regra silenciosamente morta em producao e pior que erro na tela.
  //
  // O RELOGIO e o carimbo DA MENSAGEM (`m.ts`), nunca `Date.now()`: este caminho
  // e um SYNC com cursor, e materializar sabado na segunda mediria 48h de janela
  // que nunca existiram pro cliente.
  //
  // DIFERENCA DECLARADA deste canal: a fonte Gupshup nao tem rodizio (ele so
  // roda no webhook Z-API), entao aqui o reinicio ajusta o STATUS e NAO solta
  // responsavel nenhum — `canalTemRodizio` recusa a redistribuicao. Soltar sem
  // ter pra quem redelegar seria orfanar a conversa e chamar isso de rodizio.
  await aplicarReinicio(
    db,
    T,
    cfg,
    { canal: ctx.canal, chatId: m.chat_id, antes: convAntes, deGrupo: false },
    Date.parse(m.ts) || Date.now()
  ).catch((e: any) => console.error("reinicio falhou", { canal: ctx.canal, chat: m.chat_id, erro: e?.message }));
}
