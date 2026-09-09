import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import { getPerfil, podeVerConversa, permitido } from "@/lib/perfil";
import { getConfig } from "@/lib/config";
import { canalDeBody, tabelas, Canal } from "@/lib/canal";
import { canalPorId, fonteExterna, somenteLeitura } from "@/lib/canais";
import { garantirLinha } from "@/lib/estado-externo";
import { fonteLigada } from "@/lib/fonte-externa";
import { restricaoEfetiva, derrubarCacheEmbed } from "@/lib/embed";
import { avisarStatus, getAssinantes } from "@/lib/webhooks-saida";
import {
  registrarEventoStatus,
  registrarEventoResponsavel,
  registrarEventoRobo,
  definirBotAtivo,
} from "@/lib/tela-conversa-db";
import { booleanoEstrito } from "@/lib/tela-conversa";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const STATUS_VALIDOS = ["aberto", "atendimento", "concluido", "aguardando"];

// Mantem as colunas legadas espelhando o PRIMEIRO responsavel (compat com
// consultas antigas e com o fallback de nome importado do ChatGuru).
async function espelharLegado(db: any, chatId: string, canal: Canal) {
  if (somenteLeitura(canal)) return; // fonte externa: nao ha linha de conversa no painel pra espelhar
  const T = tabelas(canal);
  const { data } = await db
    .from("conversa_responsaveis")
    .select("tipo,ref_id,nome")
    .eq("chat_id", chatId)
    .eq("canal", canal)
    .order("criado_em", { ascending: true })
    .limit(1);
  const primeiro = data?.[0];
  await db
    .from(T.conversas)
    .update({
      responsavel_id: primeiro?.ref_id ?? null,
      responsavel_nome: primeiro?.nome ?? null,
      responsavel_tipo: primeiro ? primeiro.tipo : null,
    })
    .eq("chat_id", chatId);
}

// Atualiza status/arquivo e gerencia os RESPONSAVEIS (N:N — varias pessoas e
// departamentos ao mesmo tempo) de uma conversa.
export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") {
    return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const {
    chat_id,
    status,
    marcar_lida,
    marcar_lida_por_abertura,
    arquivada,
    add_responsavel,
    remove_responsavel,
    auto_arquivar,
    add_visibilidade,
    remove_visibilidade,
    bot_ativo,
  } = body;
  const canal = canalDeBody(body);
  const T = tabelas(canal);
  if (!chat_id) {
    return NextResponse.json({ error: "chat_id obrigatorio" }, { status: 400 });
  }
  if (!(await podeVerConversa(String(chat_id), user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(String(chat_id))) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }
  const db = msgDb();
  // fonte externa (instagram-agent): status/arquivo/auto-arquivar moram na linha
  // da conversa, que nao existe no banco do painel — 403 explicito em vez de 500.
  // Responsaveis e visibilidade seguem funcionando (tabelas do painel por canal).
  const soLeitura = somenteLeitura(canal);
  // canal do agente: a linha de estado nasce na primeira acao (lib/estado-externo.ts)
  const defCanal = canalPorId(canal);
  if (defCanal && fonteExterna(defCanal) && !soLeitura) {
    const g = await garantirLinha(canal, String(chat_id));
    if (!g.ok) return NextResponse.json({ error: g.aviso }, { status: g.status });
  }
  // Concluir/reabrir/arquivar e acao de atendimento: pede "concluir".
  // Sem papel nomeado todo atendente tem, entao nada muda pra quem ja usa.
  //
  // `bot_ativo` ENTRA NESTA CONDICAO (achado da revisao cega): o gate dele
  // estava mais abaixo, DEPOIS de responsavel e visibilidade terem sido
  // gravados. Um pedido `{add_responsavel, bot_ativo}` de quem nao tem
  // `concluir` aplicava o responsavel e so ai levava 403 — efeito parcial com
  // resposta de recusa e a pior combinacao possivel. Todo gate de permissao
  // roda ANTES de qualquer escrita.
  if (
    (status !== undefined || arquivada !== undefined || bot_ativo !== undefined) &&
    !permitido(perfil, "concluir")
  ) {
    return NextResponse.json({ error: "sem permissao pra concluir, arquivar ou mexer no robo" }, { status: 403 });
  }
  // Booleano ESTRITO: `!!bot_ativo` aceitaria a string "false" como true e
  // LIGARIA o robo pra quem pediu pra desligar. Validado aqui, antes de escrever.
  const botBruto = bot_ativo === undefined ? undefined : booleanoEstrito(bot_ativo);
  if (botBruto === null) {
    return NextResponse.json({ error: "bot_ativo tem que ser true ou false (booleano)" }, { status: 400 });
  }
  // depois da guarda acima o tipo e boolean|undefined — o `null` de "veio, mas
  // nao era booleano" ja foi recusado com 400 e nao chega ao resto do handler
  const botPedido: boolean | undefined = botBruto;
  if (soLeitura && (status !== undefined || arquivada !== undefined || auto_arquivar !== undefined)) {
    return NextResponse.json(
      { error: "canal somente leitura: status e arquivo ainda nao disponiveis pra este canal" },
      { status: 403 }
    );
  }

  if (add_responsavel?.id && ["usuario", "departamento"].includes(add_responsavel.tipo)) {
    const { error } = await db.from("conversa_responsaveis").upsert(
      {
        canal,
        chat_id: String(chat_id),
        tipo: add_responsavel.tipo,
        ref_id: add_responsavel.id,
        nome: String(add_responsavel.nome || "?").slice(0, 120),
      },
      { onConflict: "canal,chat_id,tipo,ref_id" }
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await espelharLegado(db, String(chat_id), canal);
    // TRILHA DE TRANSFERENCIA (0017, card 86ak85nwu): `conversa_responsaveis` e
    // ESTADO ATUAL — remover apaga a linha, e com ela a unica prova de que
    // aquela pessoa foi responsavel um dia.
    //
    // COM `await`, e isto foi um achado da revisao: a funcao engole a propria
    // excecao (trilha indisponivel nao pode impedir uma atribuicao de
    // responsavel), mas em serverless o processo CONGELA na resposta — promessa
    // solta morre no meio da insercao. O melhor-esforco mora DENTRO da funcao;
    // aqui a espera e obrigatoria, senao a trilha grava "as vezes".
    await registrarEventoResponsavel({
      canal,
      chatId: String(chat_id),
      acao: "atribuido",
      tipo: add_responsavel.tipo,
      refId: String(add_responsavel.id),
      refNome: String(add_responsavel.nome || "").slice(0, 120) || null,
      por: { id: user.id, nome: user.nome },
      origem: "painel",
    });
  }

  if (remove_responsavel?.id && ["usuario", "departamento"].includes(remove_responsavel.tipo)) {
    // o NOME e lido ANTES do delete: depois dele a linha nao existe mais, e a
    // trilha ficaria com um uuid cru onde deveria estar "Fulano". O nome
    // congelado no evento e o que faz a trilha ser legivel anos depois, mesmo
    // com o usuario ja desligado da empresa.
    const { data: antes } = await db
      .from("conversa_responsaveis")
      .select("nome")
      .eq("canal", canal)
      .eq("chat_id", String(chat_id))
      .eq("tipo", remove_responsavel.tipo)
      .eq("ref_id", remove_responsavel.id)
      .maybeSingle();
    const { error } = await db
      .from("conversa_responsaveis")
      .delete()
      .eq("canal", canal)
      .eq("chat_id", String(chat_id))
      .eq("tipo", remove_responsavel.tipo)
      .eq("ref_id", remove_responsavel.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await espelharLegado(db, String(chat_id), canal);
    await registrarEventoResponsavel({
      canal,
      chatId: String(chat_id),
      acao: "removido",
      tipo: remove_responsavel.tipo,
      refId: String(remove_responsavel.id),
      refNome: antes?.nome ?? (typeof remove_responsavel.nome === "string" ? remove_responsavel.nome : null),
      por: { id: user.id, nome: user.nome },
      origem: "painel",
    });
  }

  // Visibilidade (ACL fixa, F9) e auto-arquivar: travas de cadastro — pedem a
  // permissao "gerenciar_visibilidade" (atendente nao abre/fecha acesso nem
  // silencia chat). Sem papel nomeado isso segue sendo so o super admin.
  if (add_visibilidade || remove_visibilidade || auto_arquivar !== undefined) {
    if (!permitido(perfil, "gerenciar_visibilidade")) {
      return NextResponse.json({ error: "sem permissao pra mudar visibilidade" }, { status: 403 });
    }
  }
  if (add_visibilidade?.id && ["usuario", "departamento", "contexto"].includes(add_visibilidade.tipo)) {
    const { error } = await db.from("conversa_visibilidade").upsert(
      {
        canal,
        chat_id: String(chat_id),
        tipo: add_visibilidade.tipo,
        ref_id: add_visibilidade.id,
        nome: String(add_visibilidade.nome || "?").slice(0, 120),
      },
      { onConflict: "canal,chat_id,tipo,ref_id" }
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (add_visibilidade.tipo === "contexto") derrubarCacheEmbed(String(add_visibilidade.id));
  }
  if (remove_visibilidade?.id && ["usuario", "departamento", "contexto"].includes(remove_visibilidade.tipo)) {
    const { error } = await db
      .from("conversa_visibilidade")
      .delete()
      .eq("canal", canal)
      .eq("chat_id", String(chat_id))
      .eq("tipo", remove_visibilidade.tipo)
      .eq("ref_id", remove_visibilidade.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (remove_visibilidade.tipo === "contexto") derrubarCacheEmbed(String(remove_visibilidade.id));
  }

  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  // DUAS portas diferentes de proposito (Frente N, modo supervisor):
  //
  //   marcar_lida             = "marque como lida" — INTENCAO EXPLICITA (botao,
  //                             tool do MCP). Sempre obedecida.
  //   marcar_lida_por_abertura= "eu abri a conversa" — efeito colateral de ler.
  //                             Quem esta em MODO SUPERVISOR nao consome o "nao
  //                             lida" do time so por espiar o atendimento.
  //
  // Sem essa separacao, ligar o modo supervisor transformaria a tool
  // `marcar_lida` do MCP num no-op silencioso — trava que mente e pior que
  // trava que nao existe.
  if (marcar_lida === true) patch.mensagens_nao_lidas = 0;
  else if (marcar_lida_por_abertura === true) {
    const { contaDoUsuario } = await import("@/lib/perfil");
    const { abrirMarcaLida } = await import("@/lib/conversa-automatica");
    // leitura FALHA cai no default (supervisor desligado) = comportamento
    // historico do painel; nunca "trava tudo por engano".
    const conta = await contaDoUsuario(user.id);
    if (abrirMarcaLida(conta.preferencias)) patch.mensagens_nao_lidas = 0;
  }
  // status ANTERIOR, lido antes do update: o webhook de saida promete "de/para",
  // e depois de escrever o "de" ja nao existe mais em lugar nenhum.
  let statusAntes: string | null = null;
  // de onde medir a permanencia no status anterior (trilha da 0017)
  let marcoStatus: string | null = null;
  if (status !== undefined) {
    if (!STATUS_VALIDOS.includes(status)) {
      return NextResponse.json({ error: "status invalido" }, { status: 400 });
    }
    patch.status = status;
    // Autoria da troca de status (0006): quem conclui aqui e o TIME, entao sem
    // isto nao ha como saber qual atendente encerrou a conversa de um cliente.
    // O usuario ja esta resolvido no topo do handler — era so nao descartar.
    patch.status_alterado_por_id = user.id;
    patch.status_alterado_por_nome = user.nome;
    patch.status_alterado_em = patch.updated_at;
    const cfg = await getConfig();

    // UMA leitura para os dois ramos abaixo E para o "de" do webhook. Cada ramo
    // ja fazia a sua; juntar as colunas nao custa nada e evita a terceira
    // consulta. Instalacao SEM destino de webhook cadastrado le exatamente o
    // que lia antes: quando nenhum ramo precisa da linha e ninguem esta
    // inscrito, nao ha consulta nenhuma. (getAssinantes tem cache de 30s, entao
    // o teste em si nao vira ida ao banco por request.)
    const querCsat = status === "concluido" && cfg.csat_ativo && !!cfg.csat_msg.trim();
    const querAutoArquivar = status !== "concluido" && arquivada === undefined;
    const temAssinante = (await getAssinantes()).some((a) => a.ativo && a.eventos.length > 0);
    let conv: {
      status?: string;
      is_group?: boolean;
      aguardando_avaliacao?: boolean;
      auto_arquivar?: boolean;
      status_alterado_em?: string | null;
      created_at?: string | null;
    } | null = null;
    // A LEITURA VIROU INCONDICIONAL quando o status muda (antes era so pra CSAT,
    // auto-arquivar ou webhook — `querCsat`/`querAutoArquivar`/`temAssinante`
    // seguem valendo pros ramos abaixo). Motivo: a trilha de status da 0017
    // precisa do "de" e do MARCO de onde medir a permanencia, e nenhum dos dois
    // existe depois do UPDATE. Custo: uma consulta por TROCA DE STATUS — que e
    // um clique de atendente, nao o polling da tela. As duas colunas novas no
    // select nao custam ida extra: e a mesma linha que os outros ramos ja liam.
    {
      const { data } = await db
        .from(T.conversas)
        .select("status,is_group,aguardando_avaliacao,auto_arquivar,status_alterado_em,created_at")
        .eq("chat_id", String(chat_id))
        .maybeSingle();
      conv = data;
      statusAntes = data?.status ?? null;
      // marco pra medir permanencia: a coluna da 0006 (ultima troca) quando
      // existe; senao o nascimento da conversa. `registrarEventoStatus` ainda
      // prefere o ultimo evento DA TRILHA quando ela ja tem historico.
      marcoStatus = data?.status_alterado_em ?? data?.created_at ?? null;
    }

    // concluir = arquivar automatico (configuravel); sair de concluido tira do arquivo
    if (status === "concluido") {
      if (cfg.auto_arquivar_concluida) patch.arquivada = true;
      // pesquisa de satisfacao: manda a pergunta e fica aguardando a nota (1-5).
      // Central sempre; no canal oficial so com a janela de 24h aberta.
      if (querCsat && conv && !conv.is_group && !conv.aguardando_avaliacao) {
        try {
          // P1: a pesquisa sai pelo NUMERO DO CANAL da conversa (fonte decide o provedor)
          const { canalPorId } = await import("@/lib/canais");
          const fonteCsat = canalPorId(canal)?.fonte;
          if (fonteCsat === "gupshup") {
            const { credsGupshup, gsSendText, janela24h } = await import("@/lib/gupshup");
            const j = await janela24h(String(chat_id), T.mensagens);
            const credsGs = j.aberta ? await credsGupshup(canal) : null;
            if (credsGs) {
              await gsSendText(credsGs, String(chat_id), cfg.csat_msg.trim());
              patch.aguardando_avaliacao = true;
            }
          } else if (fonteCsat === "zapi") {
            const { credsZapi, zapiSendText } = await import("@/lib/zapi");
            const creds = credsZapi(canal);
            if (creds) {
              await zapiSendText(creds, String(chat_id), cfg.csat_msg.trim(), null);
              patch.aguardando_avaliacao = true;
            }
          } else if (fonteCsat === "evolution") {
            const { credsEvolution, evoSendText } = await import("@/lib/evolution");
            const creds = credsEvolution(canal);
            if (creds) {
              await evoSendText(creds, String(chat_id), cfg.csat_msg.trim(), null);
              patch.aguardando_avaliacao = true;
            }
          } else if (fonteCsat === "whatsapp-agent" && defCanal) {
            // pela mcp-api do agente, como toda saida deste canal; a NOTA volta
            // pelo banco do agente e e lida em /api/messages (lib/csat-externo.ts)
            const ext = await fonteLigada(defCanal);
            if (ext?.enviar) {
              const r = await ext.enviar(String(chat_id), { texto: cfg.csat_msg.trim(), quoted: null });
              if (r.ok) patch.aguardando_avaliacao = true;
            }
          }
        } catch {
          // pesquisa e melhor-esforco: falha no envio nao impede concluir
        }
      }
    } else if (arquivada === undefined) {
      // F9: chat com auto_arquivar nao desarquiva de brinde na troca de status
      if (!conv?.auto_arquivar) patch.arquivada = false;
      patch.aguardando_avaliacao = false;
    }
  }
  if (arquivada !== undefined) patch.arquivada = !!arquivada;
  if (auto_arquivar !== undefined) {
    patch.auto_arquivar = !!auto_arquivar;
    // ligar a chave ja arquiva na hora (o estado alvo dela e "sempre arquivado")
    if (auto_arquivar && arquivada === undefined) patch.arquivada = true;
  }

  if (!soLeitura) {
    // (marcar_lida em fonte externa e no-op: o sinal de nao lida vem do banco do agente)
    const { error } = await db.from(T.conversas).update(patch).eq("chat_id", String(chat_id));
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // webhook de saida DEPOIS do efeito principal: a troca de status ja esta
    // gravada. Melhor-esforco, sem await — destino do cliente fora do ar nao
    // pode impedir o atendente de concluir uma conversa. Status reafirmado
    // (mesmo valor) e engolido dentro de `avisarStatus`.
    if (status !== undefined) {
      avisarStatus({
        canal,
        chatId: String(chat_id),
        de: statusAntes,
        para: status,
        porId: user.id,
        porNome: user.nome,
        origem: "painel",
      });
      // TRILHA DE STATUS (0017, card 86ak85nx0). Nao confundir com o webhook
      // acima: `status_alterado` sai pela rede e morre no destino do cliente;
      // isto e o historico que a tela de conversa desenha.
      //
      // DIFERENCA DELIBERADA DE COMPORTAMENTO: o webhook engole status
      // REAFIRMADO (mesmo valor) dentro de `avisarStatus`, porque o CRM do
      // cliente contaria o encerramento duas vezes. A trilha NAO engole: se
      // alguem re-concluiu a conversa, isso aconteceu, tem autor e hora, e
      // esconder o evento faria a permanencia no status ficar errada. Uma e
      // notificacao, a outra e livro-caixa.
      await registrarEventoStatus({
        canal,
        chatId: String(chat_id),
        status,
        statusAnterior: statusAntes,
        marcoAnterior: marcoStatus,
        por: { id: user.id, nome: user.nome },
        origem: "painel",
      });
    }
  }

  // ROBO POR CONVERSA (0017, card 86ak85nyv) — UPDATE SEPARADO de propostio.
  // Sem a migration a coluna nao existe e o PostgREST recusa o UPDATE INTEIRO
  // com 42703: se `bot_ativo` entrasse no patch de status/arquivo acima, uma
  // instalacao sem a 0017 perderia a capacidade de CONCLUIR conversa — a
  // feature nova quebrando a antiga. Aqui a falha fica contida num aviso.
  //
  // Permissao: a mesma de concluir/arquivar. Ligar e desligar automacao numa
  // conversa e decisao de atendimento (o atendente assumiu o caso e nao quer o
  // menu automatico atropelando), nao de cadastro.
  // (o gate de permissao e a validacao booleana rodam no topo do handler, antes
  // de qualquer escrita — ver comentario la)
  let avisoBot: string | null = null;
  if (botPedido !== undefined) {
    const r = await definirBotAtivo(canal, String(chat_id), botPedido, { id: user.id, nome: user.nome });
    if (!r.ok) avisoBot = r.aviso;
    else {
      // TRILHA DO ROBO — mesmo defeito que a 0006 fechou pro status: mudar
      // estado da conversa sem guardar quem mudou. Vai na MESMA tabela de
      // eventos, com `origem: "robo"`, e a linha do tempo de status filtra
      // esses eventos fora pra nao poluir a medicao de permanencia.
      await registrarEventoRobo({
        canal,
        chatId: String(chat_id),
        ativo: botPedido,
        por: { id: user.id, nome: user.nome },
      });
    }
  }

  const [{ data: resp }, { data: vis }] = await Promise.all([
    db
      .from("conversa_responsaveis")
      .select("tipo,ref_id,nome")
      .eq("chat_id", String(chat_id))
      .eq("canal", canal)
      .order("criado_em", { ascending: true }),
    db
      .from("conversa_visibilidade")
      .select("tipo,ref_id,nome")
      .eq("chat_id", String(chat_id))
      .eq("canal", canal)
      .order("criado_em", { ascending: true }),
  ]);
  return NextResponse.json({
    ok: true,
    responsaveis: (resp ?? []).map((r) => ({ tipo: r.tipo, id: r.ref_id, nome: r.nome })),
    visibilidade: (vis ?? []).map((v) => ({ tipo: v.tipo, id: v.ref_id, nome: v.nome })),
    // pedido de robo que nao pegou volta com o motivo: chave que a tela mostra
    // como aplicada sem ter sido gravada e a pior falha possivel aqui — a pessoa
    // acha que desligou a automacao e ela continua rodando.
    ...(avisoBot ? { aviso_bot: avisoBot } : {}),
  });
}
