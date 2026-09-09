import { NextRequest, NextResponse } from "next/server";
import { msgDb } from "@/lib/mensageria";
import { getUser } from "@/lib/auth-server";
import { getPerfil, permitido, contaDoUsuario } from "@/lib/perfil";
import { canalDeBody, tabelas } from "@/lib/canal";
import { canalPorId, envioDisponivel, somenteLeitura } from "@/lib/canais";
import { contextoEmbed } from "@/lib/embed";
import { textoComAssinatura } from "@/lib/conversa-automatica";
import { normalizarTelefone } from "@/lib/disparo/telefone";
import { estaBloqueado } from "@/lib/disparo/bloqueio";
import {
  registrarEventoResponsavel,
  registrarEventoStatus,
  reservarInicio,
  encerrarReserva,
  desfazerReserva,
  optOutDisponivel,
} from "@/lib/tela-conversa-db";
import { validarInicioConversa, TETO_INICIOS_POR_HORA } from "@/lib/tela-conversa";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

// INICIAR CONVERSA NOVA (card 86ak85nyv).
//
//   POST /api/conversa/iniciar { canal, telefone, texto, confirmado: true }
//
// ------------------------------------------------------------------------
// POR QUE ESTA ROTA E DELICADA, e o que a segura
// ------------------------------------------------------------------------
// O painel tem uma TRAVA ANTI-DISPARO-FRIO explicita: /api/send recusa enviar
// pra conversa que ainda nao existe ("inicie o contato pelo WhatsApp antes").
// Abrir conversa nova E, por definicao, a excecao a essa trava. Excecao sem
// contorno e a trava revogada — e o numero da empresa banido por spam.
//
// Entao o contorno e explicito, em SEIS camadas, da mais estrutural pra menos:
//
//  1. UM DESTINO POR CHAMADA, nunca lista (regra pura em `validarInicioConversa`).
//     Rota que aceita array de destinos e rota de disparo, com qualquer teto.
//  2. `confirmado: true` OBRIGATORIO. E o consentimento de gente, dado na tela
//     naquele instante. Nenhum conteudo de conversa e nenhuma inferencia produz
//     esse `true` — quem chama pela chave de API tem que mandar, e mandar e
//     assumir.
//  3. TETO POR PESSOA POR HORA, contado DENTRO da instrucao que reserva a linha
//     (`mensageria.reservar_inicio`, 0017) — ver ORDEM abaixo.
//  4. OPT-OUT RESPEITADO. `estaBloqueado` e a MESMA lista do modulo de disparo
//     (lib/disparo/bloqueio.ts, leitura apenas). Quem pediu pra nao receber
//     mensagem nao pode ser alcancado por uma porta diferente da que ele fechou.
//  5. SO PESSOA, nunca grupo. Entrar em grupo pelo painel e outra coisa.
//  6. PERMISSAO NOMEADA `iniciar_conversa` — nao `enviar`. RESPONDER quem
//     procurou a empresa e ABORDAR quem nao procurou tem consequencias
//     diferentes; quem quiser que o time so responda cria papel com `enviar` e
//     sem esta (ver lib/permissoes.ts).
//
// ------------------------------------------------------------------------
// ORDEM DAS OPERACOES — RESERVA, envia, fecha o ciclo
// ------------------------------------------------------------------------
// A v1 fazia `contar teto -> enviar -> gravar`, e a revisao cega reprovou: entre
// a contagem em JavaScript e o envio nao havia nada, entao 300 chamadas
// paralelas liam a MESMA contagem e todas passavam. Teto que so vale quando
// ninguem esta com pressa nao e teto.
//
// Agora: `reservarInicio` (conta e insere na MESMA instrucao SQL) -> envia ->
// `encerrarReserva('enviado'|'falha_envio')`.
//
// O motivo da ordem antiga era nao deixar CONVERSA FANTASMA na caixa do time
// (linha na lista, com previa, sem nada ter chegado ao cliente) — e ele continua
// valendo. A resposta nao e gravar depois: e a coluna `inicio_estado`. Reserva
// que o provedor recusou fica visivel como `falha_envio`, dizendo que a mensagem
// nao saiu. Estado visivel nao e fantasma; o que era inaceitavel era o SILENCIO.
//
// FAIL-CLOSED: falha transiente na reserva (rede, permissao, banco fora) RECUSA
// com 503 sem enviar. So a ausencia da migration degrada, e ai a resposta diz
// `teto_ativo: false` — trava que nao vale tem que ser declarada, nao suposta.

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);

  // WIDGET EMBUTIDO NAO ABRE CONVERSA. O embed e UMA conversa dentro de outro
  // sistema, com o escopo travado naquele contexto; deixar ele abrir conversa
  // nova seria dar porta de saida pro fora do proprio contexto que o define.
  //
  // DETECTA PELO HEADER (`contextoEmbed`), NAO por `restricaoEfetiva` — achado
  // da revisao cega. `restricaoEfetiva` mistura DUAS coisas: o contexto do
  // widget (header) E o vinculo de BU do usuario. Barrar pelo resultado dela
  // recusava atendente com vinculo de BU sentado no painel normal, com um
  // diagnostico falso ("nao esta disponivel no widget embutido"). Aqui o header
  // e barrado explicitamente — a propriedade "o widget nao inicia conversa"
  // continua valendo, sem pegar quem nao e widget.
  const ctxEmbed = await contextoEmbed(req);
  if (ctxEmbed === "invalido") {
    return NextResponse.json({ error: "contexto invalido" }, { status: 401 });
  }
  if (ctxEmbed) {
    return NextResponse.json({ error: "iniciar conversa nao esta disponivel no widget embutido" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const canal = canalDeBody(body);
  const def = canalPorId(canal);
  if (!def) return NextResponse.json({ error: "canal desconhecido" }, { status: 400 });
  if (somenteLeitura(canal) || !envioDisponivel(canal)) {
    return NextResponse.json({ error: "este numero nao envia mensagem" }, { status: 403 });
  }
  if (!permitido(perfil, "iniciar_conversa")) {
    return NextResponse.json(
      { error: "sem permissao pra iniciar conversa com numero novo" },
      { status: 403 }
    );
  }

  // telefone: a normalizacao e a MESMA do modulo de disparo (aceita mascara,
  // recusa letra, recusa curto/longo). Duas validacoes de telefone no mesmo
  // repo divergem — esta importa a que ja existe em vez de reescrever.
  const tel = normalizarTelefone(body?.telefone ?? body?.chat_id);
  if (!tel.ok) return NextResponse.json({ error: `numero invalido: ${tel.motivo}` }, { status: 400 });

  const v = validarInicioConversa({
    chat_id: tel.chat_id,
    telefone: tel.telefone,
    grupo: tel.grupo,
    texto: body?.texto,
    confirmado: body?.confirmado,
  });
  if (!v.ok) return NextResponse.json({ error: v.erro }, { status: 400 });

  // API OFICIAL (Gupshup/Meta): fora da janela de 24h so template aprovado
  // passa, e template nao sai pelo painel. Recusa EXPLICITA em vez de um envio
  // que a Meta engole — e a janela de 24h de quem nunca falou com a empresa
  // esta, por definicao, FECHADA. Ou seja: iniciar conversa no canal oficial e
  // recusa por desenho da plataforma, nao limitacao nossa.
  if (def.fonte === "gupshup") {
    return NextResponse.json(
      {
        error:
          "o canal oficial (WhatsApp Business) nao permite iniciar conversa por mensagem livre — a Meta exige template aprovado fora da janela de 24h",
      },
      { status: 403 }
    );
  }

  const db = msgDb();
  const T = tabelas(canal);
  const nomeInformado = typeof body?.nome === "string" ? body.nome.trim().slice(0, 120) : "";

  // ------------------------------------------- 0) o texto final, ANTES da reserva
  // ORDEM IMPORTA (achado da re-revisao): `contaDoUsuario` vai ao banco e
  // `textoComAssinatura` monta a mensagem. Rodando isso DEPOIS da reserva, uma
  // excecao ali deixaria a linha presa em `reservado` pra sempre — nem
  // `encerrarReserva` nem `desfazerReserva` seriam alcancados, e a conversa
  // ficaria na caixa do time num estado que nenhuma tela sabe explicar. Tudo que
  // pode falhar sem consequencia externa roda antes de reservar.
  const conta = await contaDoUsuario(user.id);
  const textoEnviar = textoComAssinatura(v.texto, { ...conta, nome: user.nome });

  // ---------------------------------------------------- 1) RESERVA (atomica)
  const reserva = await reservarInicio({
    canal,
    chatId: v.chat_id,
    userId: user.id,
    userNome: user.nome,
    nome: nomeInformado || null,
    teto: TETO_INICIOS_POR_HORA,
  });

  if (reserva.estado === "ja_existe") {
    // conversa que ja existe nao e "iniciar": e abrir. Devolve o chat_id pra a
    // tela navegar, sem mandar mensagem nenhuma — mandar seria enviar um texto
    // que a pessoa escreveu pensando que era o primeiro contato.
    return NextResponse.json(
      { ok: false, ja_existe: true, chat_id: v.chat_id, aviso: "essa conversa ja existe — abra e responda por ela" },
      { status: 409 }
    );
  }
  if (reserva.estado === "teto") {
    return NextResponse.json(
      {
        error: `limite de ${TETO_INICIOS_POR_HORA} conversas novas por hora atingido — use o modulo de disparo pra falar com muita gente (ele tem descadastro e ritmo)`,
        na_ultima_hora: reserva.na_ultima_hora,
      },
      { status: 429 }
    );
  }
  // FAIL-CLOSED: falha transiente NAO vira permissao de envio.
  if (reserva.estado === "erro") {
    return NextResponse.json({ error: reserva.aviso }, { status: 503 });
  }

  // `sem_0017`: a migration nao rodou, a reserva nao existe e o teto nao pode
  // valer. Segue pelo caminho antigo (checa existencia, envia, grava sem as
  // colunas novas) e DECLARA as duas coisas na resposta.
  const semMigration = reserva.estado === "sem_0017";
  if (semMigration) {
    const { data: existente } = await db
      .from(T.conversas)
      .select("chat_id")
      .eq("chat_id", v.chat_id)
      .maybeSingle();
    if (existente) {
      return NextResponse.json(
        { ok: false, ja_existe: true, chat_id: v.chat_id, aviso: "essa conversa ja existe — abra e responda por ela" },
        { status: 409 }
      );
    }
  }

  // ------------------------------------------------------------ 2) OPT-OUT
  // Depois da reserva de propostio: a reserva e o gesto atomico e nao pode
  // esperar por uma segunda ida ao banco. Bloqueado = desfaz a reserva (nada foi
  // tentado, e uma conversa na caixa do time pra contato nunca contatado
  // poluiria a lista) e recusa.
  // `estaBloqueado` E CHAMADO SEMPRE, e essa ordem e a correcao de uma regressao
  // que a propria revisao anterior introduziu: a versao passada era
  // `if (optout && await estaBloqueado(...))`, ou seja, um probe FAIL-OPEN
  // (`optOutDisponivel` devolve false em qualquer falha) curto-circuitando uma
  // checagem FAIL-CLOSED. Timeout no probe = `optout` false = a checagem nem
  // rodava = mensagem indo pra quem pediu descadastro.
  //
  // `estaBloqueado` ja falha fechado por desenho (lib/disparo/bloqueio.ts: erro
  // de leitura ou excecao devolvem TRUE; so o 42P01 de "a lista nem existe"
  // devolve false — decisao daquele arquivo, que tem dono e e auditada la).
  //
  // E e justamente por falhar fechado que o probe roda ANTES: `true` significa
  // "pediu descadastro" OU "nao deu pra conferir", e as duas coisas tem que virar
  // o mesmo 403. Sem o probe, um blip de banco fazia o painel AFIRMAR pro
  // atendente que o numero pediu descadastro — fato falso, e ele iria procurar
  // um bloqueio que nao existe. O probe nao decide SE recusa (a recusa e a mesma
  // nos dois casos); decide so a FRASE, e alimenta o `optout_ativo` da resposta.
  const optout = await optOutDisponivel();
  if (await estaBloqueado(v.telefone || v.chat_id)) {
    if (!semMigration) await desfazerReserva(canal, v.chat_id);
    return NextResponse.json(
      {
        error: optout
          ? "esse numero pediu pra nao receber mensagens (descadastro) — remova o bloqueio antes, se for o caso"
          : "nao deu pra conferir a lista de descadastro; recusado por seguranca",
      },
      { status: 403 }
    );
  }

  // ------------------------------------------------------- 3) efeito externo
  let providerMsgId: string | null = null;
  try {
    if (def.fonte === "zapi") {
      const { credsZapi, zapiSendText } = await import("@/lib/zapi");
      const creds = credsZapi(canal);
      if (!creds) throw new Error("credenciais Z-API do canal nao configuradas");
      const sent = await zapiSendText(creds, v.chat_id, textoEnviar, null);
      providerMsgId = sent.messageId || null;
    } else if (def.fonte === "evolution") {
      const { credsEvolution, evoSendText } = await import("@/lib/evolution");
      const creds = credsEvolution(canal);
      if (!creds) throw new Error("credenciais Evolution do canal nao configuradas");
      const sent = await evoSendText(creds, v.chat_id, textoEnviar, null);
      providerMsgId = sent.messageId || null;
    } else {
      throw new Error("canal sem envio de texto");
    }
  } catch (e: any) {
    // o numero pode simplesmente nao ter WhatsApp — e o erro mais comum aqui, e
    // a mensagem do provedor e o unico lugar que sabe disso.
    console.error("iniciar conversa falhou", { usuario: user.email, erro: e?.message });
    // A reserva NAO e apagada: ela vira `falha_envio` e fica visivel. Apagar
    // silenciosamente devolveria "nao deu" e sumiria com o rastro de que alguem
    // tentou abordar este numero — que e informacao de operacao (e a tentativa
    // consumiu a cota da hora, de propostio: senao o teto seria burlavel
    // mandando pra numeros invalidos).
    // O motivo que vai pra PREVIA da conversa e TEXTO FIXO nosso, nunca a
    // mensagem do provedor: ela e conteudo de terceiro e a previa aparece na
    // lista pra todo o time. O texto do provedor fica no log acima e na resposta
    // desta chamada (que so quem clicou ve).
    if (!semMigration) {
      await encerrarReserva(canal, v.chat_id, "falha_envio", "o provedor recusou o envio");
    }
    return NextResponse.json(
      { error: `nao deu pra enviar: ${String(e?.message || e).slice(0, 200)}`, reserva_marcada: !semMigration },
      { status: 502 }
    );
  }

  // ------------------------- 3b) O FATO EXTERNO ACONTECEU: registra ISOLADO
  // A mensagem SAIU. Antes desta chamada, o unico lugar que gravava
  // `inicio_estado: 'enviado'` era o upsert do passo 4 — e se o passo 4 falhasse
  // com erro generico, a linha ficava 'reservado' e a faxina dos 10 minutos
  // depois a reetiquetava como "nao enviada: tempo esgotado", com selo vermelho,
  // AFIRMANDO que a mensagem nao saiu quando ela saiu. O atendente reenviava, e
  // o cliente recebia uma segunda abordagem fria.
  //
  // Entao o fato externo e gravado numa escrita PROPRIA, antes de qualquer coisa
  // falivel. Se ela mesma falhar, NAO derruba a rota (o envio ja aconteceu, e
  // recusar aqui seria mentir na direcao oposta): engole com log e segue — o pior
  // caso volta a ser exatamente o que era antes desta correcao.
  if (!semMigration) {
    try {
      await encerrarReserva(canal, v.chat_id, "enviado");
    } catch (e: any) {
      console.error("iniciar conversa: encerrar reserva como enviado falhou", {
        chat_id: v.chat_id,
        erro: e?.message,
      });
    }
  }

  // -------------------------------------------- 4) grava o que houve, CONFERINDO
  // NUNCA `ok: true` sem conferir o error de cada escrita (achado da revisao
  // cega): sem a 0017 o upsert com as colunas novas falha com 42703/PGRST204 e a
  // v1 respondia `ok: true` — mensagem no cliente, NADA no painel, e ninguem
  // sabendo. Cada falha aqui e classificada, e o que o cliente recebeu ja
  // recebeu: a resposta diz o que ficou de fora.
  const now = new Date().toISOString();
  const preview = `${user.nome}: ${v.texto}`.slice(0, 140);
  // `falhas` leva SO ROTULO FIXO ("conversa" | "mensagem" | "responsavel"): ela
  // vai pro corpo da resposta, e mensagem de erro do Postgres na tela e
  // invariante violada neste repo (auditoria 13/08/2026) — o texto do banco
  // carrega nome de coluna, de constraint e as vezes trecho do dado. O detalhe
  // tecnico vive no log do servidor, onde quem cuida da instalacao alcanca.
  const falhas: string[] = [];
  const logar = (onde: string, erro: any) =>
    console.error("iniciar conversa: escrita falhou", {
      usuario: user.email,
      onde,
      codigo: erro?.code,
      msg: erro?.message,
    });
  let registroParcial = semMigration;

  const linhaConversa: Record<string, any> = {
    chat_id: v.chat_id,
    // nome so quando quem abriu digitou um: mandar vazio criaria conversa "sem
    // nome" que o webhook depois sobrescreve com o pushname real de todo jeito
    ...(nomeInformado ? { nome: nomeInformado } : {}),
    is_group: false,
    canal,
    status: "atendimento",
    last_message_at: now,
    last_message_preview: preview,
    updated_at: now,
  };
  const colunas0017 = {
    // quem abriu a conversa pelo painel — distingue "o cliente procurou a
    // empresa" de "a empresa procurou o cliente" (colunas da 0017)
    iniciada_por_id: user.id,
    iniciada_por_nome: user.nome,
    iniciada_em: now,
    inicio_estado: "enviado",
  };

  {
    const { error } = await db
      .from(T.conversas)
      .upsert({ ...linhaConversa, ...(semMigration ? {} : colunas0017) }, { onConflict: "chat_id" });
    if (error) {
      if (SEM_COLUNA.includes(String(error.code ?? ""))) {
        // a 0017 nao existe (ou o PostgREST nao a conhece ainda): regrava SEM as
        // colunas novas, pra a conversa pelo menos aparecer na caixa do time
        const { error: e2 } = await db.from(T.conversas).upsert(linhaConversa, { onConflict: "chat_id" });
        registroParcial = true;
        if (e2) { falhas.push("conversa"); logar("conversa (2a tentativa)", e2); }
      } else {
        falhas.push("conversa"); logar("conversa", error);
      }
    }
  }

  {
    const { error } = await db.from(T.mensagens).insert({
      chat_id: v.chat_id,
      direcao: "out",
      tipo: "text",
      conteudo: textoEnviar,
      provider_msg_id: providerMsgId,
      status: "sent",
      criada_em: now,
      // autoria de PESSOA (convencao da 0006): abrir conversa e gesto humano, e a
      // bolha tem que dizer quem foi
      enviado_por_id: user.id,
      enviado_por_nome: user.nome,
    });
    if (error) { falhas.push("mensagem"); logar("mensagem", error); }
  }

  // quem abre e o responsavel. Sem isso a conversa nasce orfa na fila do time,
  // e quem a abriu nem a ve se estiver com visao restrita ao proprio escopo.
  {
    const { error } = await db.from("conversa_responsaveis").upsert(
      { canal, chat_id: v.chat_id, tipo: "usuario", ref_id: user.id, nome: user.nome },
      { onConflict: "canal,chat_id,tipo,ref_id" }
    );
    if (error) { falhas.push("responsavel"); logar("responsavel", error); }
  }
  {
    const { error } = await db
      .from(T.conversas)
      .update({ responsavel_id: user.id, responsavel_nome: user.nome, responsavel_tipo: "usuario" })
      .eq("chat_id", v.chat_id);
    if (error) { falhas.push("responsavel"); logar("responsavel (espelho)", error); }
  }

  // AWAIT nas trilhas: em serverless o processo congela na resposta, e promessa
  // solta some no meio da insercao. As duas engolem excecao por dentro, entao o
  // await nao pode derrubar a rota.
  await registrarEventoResponsavel({
    canal,
    chatId: v.chat_id,
    acao: "atribuido",
    tipo: "usuario",
    refId: user.id,
    refNome: user.nome,
    por: { id: user.id, nome: user.nome },
    origem: "inicio",
  });
  // o NASCIMENTO da conversa tambem e um evento de status: ela nasce em
  // "atendimento". Sem isto a trilha de uma conversa aberta pelo painel comeca
  // na SEGUNDA troca, e a primeira permanencia sai sem marco.
  await registrarEventoStatus({
    canal,
    chatId: v.chat_id,
    status: "atendimento",
    statusAnterior: null,
    marcoAnterior: null,
    por: { id: user.id, nome: user.nome },
    origem: "inicio",
  });

  // A MENSAGEM JA SAIU. Se o registro falhou, isso NAO e `ok: true` — e um 207
  // dizendo exatamente o que o painel nao guardou, pra a pessoa saber que
  // precisa procurar a conversa (ou chamar quem cuida da instalacao).
  if (falhas.length) {
    console.error("iniciar conversa: enviado mas nao registrado", { usuario: user.email, falhas });
    return NextResponse.json(
      {
        ok: false,
        enviado: true,
        registrado: false,
        chat_id: v.chat_id,
        canal,
        messageId: providerMsgId,
        error:
          "a mensagem FOI enviada, mas o painel nao conseguiu registrar a conversa — avise quem cuida da instalacao",
        detalhes: falhas,
      },
      { status: 207 }
    );
  }

  return NextResponse.json({
    ok: true,
    chat_id: v.chat_id,
    canal,
    messageId: providerMsgId,
    // o teto SO vale com a 0017 aplicada; sem ela, dizer nada seria deixar a
    // pessoa achar que existe uma trava que nao existe
    teto_ativo: !semMigration,
    // idem pro descadastro: `estaBloqueado` devolve false tanto pra "pode
    // receber" quanto pra "a tabela da 0012 nao existe"
    optout_ativo: optout,
    // a conversa entrou na caixa do time, mas sem a autoria de quem a abriu
    ...(registroParcial ? { registro_parcial: true } : {}),
  });
}

// PGRST204 = o PostgREST nao conhece a coluna que o upsert mandou (ele valida
// contra o cache de schema ANTES de falar com o Postgres); 42703 = o Postgres
// nao tem a coluna. Os dois querem dizer "a 0017 nao chegou aqui".
const SEM_COLUNA = ["42703", "PGRST204"];
