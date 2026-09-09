import { NextRequest, NextResponse } from "next/server";
import { zapiSendText, zapiSendMedia, zapiSendOptionList, credsZapi } from "@/lib/zapi";
import { credsEvolution, evoSendText, evoSendMedia } from "@/lib/evolution";
// FRENTE S (31/08/2026), card 86ak86jvw — mensagem interativa (botoes e lista).
// A decisao (formato, tetos do WhatsApp, plano por provedor, fallback de texto
// numerado) mora em lib/interativas.ts, que nao importa nada e roda em node
// solto. Aqui e so a porta: gate, plano, envio, registro.
import {
  envelopeGupshup,
  envelopeZapiLista,
  planoDeEnvio,
  previaDoEnviado,
  resumoDoEnviado,
  textoNumerado,
  tipoDeMensagem,
  validarInterativa,
} from "@/lib/interativas";
import { msgDb } from "@/lib/mensageria";
import { getUser, identidadePorApiKey } from "@/lib/auth-server";
import { getPerfil, podeVerConversa, permitido, contaDoUsuario } from "@/lib/perfil";
import { responderZeraNaoLidas, textoComAssinatura } from "@/lib/conversa-automatica";
import { canalDeBody, tabelas } from "@/lib/canal";
import { fonteLigada } from "@/lib/fonte-externa";
import { estadosDe, garantirLinha } from "@/lib/estado-externo";
import { DESTINO_WA_AGENT } from "@/lib/whatsapp-agent-formato";
import { credsGupshup, gsEnviarTemplate, gsSendText, gsSendInterativo, janela24h } from "@/lib/gupshup";
import { restricaoEfetiva } from "@/lib/embed";
import { efeitosDeResposta } from "@/lib/fluxo/executar";
import {
  conflitoComTemplate,
  decidirEnvioTemplate,
  enviarTemplateProvado,
  lerPedidoTemplate,
  type EnvioTemplateProvado,
} from "@/lib/templates-oficial";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60; // upload de midia pode passar do default

// Destino valido: telefone com DDI (10-15 digitos) ou id de grupo do WhatsApp.
const DESTINO_VALIDO = /^(\d{10,15}|\d{15,25}-group)$/;
const TIPOS_MIDIA = ["image", "audio", "ptt", "video", "document"] as const;
type TipoMidia = (typeof TIPOS_MIDIA)[number];

const PREVIEW_TIPO: Record<string, string> = {
  image: "[foto]",
  audio: "[audio]",
  ptt: "[audio]",
  video: "[video]",
  document: "[documento]",
};

// O ENVIO DO TEMPLATE NAO MORA MAIS AQUI (4a revisao cega). As quatro linhas que
// montavam o POST, chamavam o Gupshup e liam a resposta viraram
// `enviarTemplateProvado` (lib/templates-oficial.ts), que recebe QUEM posta por
// parametro — aqui a gente passa `gsEnviarTemplate` e mais nada.
//
// POR QUE: enquanto elas viviam nesta rota, nenhuma prova sem Next as alcancava, e
// o que sobrava era varredura de fonte. O buraco medido: os `params` estavam
// travados so no NASCIMENTO de `tplEnvio` e na FORMA da chamada, entao uma linha
// `form.set("template", ...)` colada antes do POST deixava a bateria INTEIRA verde
// e o template saía sem parametro nenhum. Agora o que chega ao provedor e
// exercitado por COMPORTAMENTO (bloco P.7 da prova, com um `postar` falso).
//
// O TIPO DO 3o PARAMETRO E SINALIZACAO FORTE, NAO FECHADURA: `EnvioTemplateProvado`
// e classe com campo `#privado`, instanciada so por `decidirEnvioTemplate`, e ate
// onde o `tsc` vai (com os codigos de erro por FORMA da tentativa) esta medido na
// tabela de `lib/templates-oficial.ts` — copia unica, de proposito.

// Envia pelo numero central (Z-API) e grava a saida no schema mensageria
// com QUEM enviou (trilha de auditoria); o eco do webhook deduplica por provider_msg_id.
// Aceita texto, midia (data URI base64) e resposta a uma mensagem (quoted).
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
  const { chat_id, message, tipo, media, file_name, quoted_msg_id, interativa, template } = body || {};
  const canal = canalDeBody(body);
  const T = tabelas(canal);

  // canal registrado (lib/canais.ts) mas sem envio cabeado NAO pode cair no
  // caminho do central — sairia mensagem pelo numero errado
  const { envioDisponivel, canalPorId, fonteExterna } = await import("@/lib/canais");
  if (!envioDisponivel(canal)) {
    return NextResponse.json({ error: "envio nao configurado pra este canal" }, { status: 403 });
  }
  // P1 (30/08/2026): o envio sai pelo NUMERO DO CANAL da conversa — a fonte do
  // canal decide o provedor (Z-API, Gupshup, Evolution ou a mcp-api do
  // WhatsApp Agent), nunca um numero fixo.
  const def = canalPorId(canal)!;
  const fonte = def.fonte;
  // FONTE EXTERNA QUE ENVIA (whatsapp-agent): a conversa nao tem linha no painel
  // e a mensagem sai pela mcp-api do agente (lib/whatsapp-agent.ts). O adaptador
  // resolvido aqui e o que decide o formato de destino e o ramo la embaixo.
  const ext = fonteExterna(def) ? await fonteLigada(def) : null;
  if (fonteExterna(def) && !ext?.enviar) {
    return NextResponse.json({ error: "fonte externa do canal nao esta ligada nesta instalacao" }, { status: 501 });
  }

  // o agente conhece grupo `@g.us` e `@lid`, que o painel nao guarda; cada
  // caminho valida o dialeto que o provedor dele aceita
  if (!chat_id || !(ext ? DESTINO_WA_AGENT : DESTINO_VALIDO).test(String(chat_id))) {
    return NextResponse.json({ error: "destino invalido" }, { status: 400 });
  }
  const ehMidia = TIPOS_MIDIA.includes(tipo as TipoMidia);
  // FRENTE S: pergunta com opcoes. VALIDADA NA ENTRADA (regra da casa pra jsonb),
  // antes de qualquer consulta: pedido torto nao chega a tocar o banco, e o erro
  // volta com a lista de problemas em vez de um "400 invalido" sem diagnostico.
  const ehInterativa = tipo === "interativo";
  const vInter = ehInterativa ? validarInterativa(interativa) : null;
  if (vInter && !vInter.ok) {
    return NextResponse.json({ error: "pergunta com opcoes invalida", erros: vInter.erros }, { status: 400 });
  }
  const text = typeof message === "string" ? message.trim() : "";
  // ENVIO POR TEMPLATE (Frente U, card 86ak858pa) — so no numero de API Oficial.
  // E o UNICO caminho de mensagem fora da janela de 24h, e o texto vem do
  // template aprovado, nao do composer: por isso `message` pode vir vazio.
  const pedeTemplate = fonte === "gupshup" && !!template && typeof template === "object";
  if (!ehMidia && !ehInterativa && !text && !pedeTemplate) {
    return NextResponse.json({ error: "mensagem vazia" }, { status: 400 });
  }
  // DUAS PERGUNTAS DIFERENTES NO MESMO PEDIDO = 400 (achado da revisao cega).
  //
  // Na interativa o corpo que sai e `interativa.texto`; um `message` diferente
  // era DESCARTADO em silencio. Quem chama (fluxo, integracao, script) mandaria a
  // pergunta em `message`, receberia 200 e o cliente leria outra coisa — bug que
  // so aparece do lado do cliente. `message` IGUAL ao texto e aceito: e o que um
  // cliente que preenche os dois campos por conveniencia manda.
  if (ehInterativa && vInter?.ok && text && text !== vInter.msg.texto) {
    return NextResponse.json(
      { error: "`message` diferente de `interativa.texto` — mande a pergunta em um lugar so" },
      { status: 400 }
    );
  }
  if (ehMidia && typeof media !== "string") {
    return NextResponse.json({ error: "midia ausente" }, { status: 400 });
  }
  if (text.length > 4096) {
    return NextResponse.json({ error: "mensagem muito longa" }, { status: 400 });
  }
  // ~15MB em base64 (limite do WhatsApp fica bem abaixo disso)
  if (ehMidia && media.length > 20_000_000) {
    return NextResponse.json({ error: "arquivo muito grande" }, { status: 413 });
  }
  // canal de fonte Gupshup (API oficial Meta): v1 e SO texto, e SO com a
  // janela de 24h aberta
  if (fonte === "gupshup" && ehMidia) {
    return NextResponse.json({ error: "no numero da API oficial da pra mandar so TEXTO por enquanto" }, { status: 400 });
  }
  // Interativa e template nao existem no agente. 400 declarado, nunca silencio.
  // (Midia vai: o adaptador sobe o arquivo pro bucket do painel e manda a URL.)
  if (ext && (ehInterativa || template)) {
    return NextResponse.json(
      { error: "pelo WhatsApp Agent nao ha pergunta com opcoes nem template — texto e midia, sim" },
      { status: 400 }
    );
  }

  const creds = fonte === "zapi" ? credsZapi(canal) : null;
  const credsGs = fonte === "gupshup" ? await credsGupshup(canal) : null;
  const credsEvo = fonte === "evolution" ? credsEvolution(canal) : null;
  if (fonte === "zapi" && !creds) {
    return NextResponse.json({ error: "credenciais Z-API do canal nao configuradas" }, { status: 501 });
  }
  if (fonte === "gupshup" && !credsGs) {
    return NextResponse.json({ error: "credenciais Gupshup do canal nao configuradas" }, { status: 501 });
  }
  if (fonte === "evolution" && !credsEvo) {
    return NextResponse.json({ error: "credenciais Evolution do canal nao configuradas" }, { status: 501 });
  }

  // PERMISSAO ANTES DE EXISTENCIA (fail-closed): os tres gates nao dependem da
  // conversa, e a fonte externa nao tem linha pra consultar — entao eles vem
  // primeiro pros dois caminhos. Quem nao tem a permissao de enviar nao escreve
  // em conversa nenhuma; quem nao ve a conversa tambem nao escreve nela.
  if (!permitido(perfil, "enviar")) {
    return NextResponse.json({ error: "sem permissao pra enviar mensagem" }, { status: 403 });
  }
  if (!(await podeVerConversa(String(chat_id), user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(String(chat_id))) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }

  // ————————————————————————— ENVIO PELA MCP-API DO WHATSAPP AGENT
  //
  // Nada e gravado no painel: a edge send-message do agente grava no banco DELE
  // (com a existencia da conversa, o voice gate e a trava de instancia
  // conferidos la), e o proximo polling de /api/messages ja mostra a bolha.
  // A assinatura "*Nome:*" e o unico rastro de quem atendeu — o adaptador le
  // ela de volta (lib/whatsapp-agent-formato.ts, nomeDaAssinatura).
  if (ext?.enviar) {
    const contaExt = await contaDoUsuario(user.id);
    const r = await ext.enviar(String(chat_id), {
      // na midia a assinatura vai na legenda, como no canal principal
      texto: textoComAssinatura(text, { ...contaExt, nome: user.nome }),
      quoted: quoted_msg_id ? String(quoted_msg_id) : null,
      ...(ehMidia
        ? { midia: { tipo: tipo as TipoMidia, dataUri: media as string, fileName: typeof file_name === "string" ? file_name : null } }
        : {}),
    });
    if (!r.ok) {
      return NextResponse.json({ error: r.error, ...(r.detalhe ? { detalhe: r.detalhe } : {}) }, { status: r.status });
    }
    // RESPONDI NESTA CONVERSA vale aqui tambem: status por `statusAoResponder`,
    // posse de quem responde, auto-arquivar — na linha de estado do painel
    // (nasce agora se nao existia). Melhor-esforco: sem tabelas, a mensagem ja saiu.
    try {
      const g = await garantirLinha(canal, String(chat_id));
      if (g.ok) {
        const est = (await estadosDe(canal, [String(chat_id)])).get(String(chat_id));
        if (est) {
          await efeitosDeResposta(
            { canal, chat_id: String(chat_id), usuario: { id: user.id, nome: user.nome }, origem: "manual", trilha: false },
            { status: est.status, auto_arquivar: est.auto_arquivar },
            `${user.nome}: ${text || PREVIEW_TIPO[tipo as string] || "[midia]"}`
          );
        }
      }
    } catch (e: any) {
      console.error("efeitos de resposta no canal externo:", e?.message);
    }
    return NextResponse.json({ ok: true, messageId: r.messageId });
  }

  const db = msgDb();

  // so envia pra conversa que ja existe (evita usar o numero da empresa pra disparo frio).
  // `status` e `auto_arquivar` vem junto porque decidem os efeitos de responder
  // (efeitosDeResposta) — ler ANTES de mexer, como o motor faz.
  const { data: conversa } = await db
    .from(T.conversas)
    .select("chat_id,status,auto_arquivar")
    .eq("chat_id", String(chat_id))
    .maybeSingle();
  if (!conversa) {
    return NextResponse.json(
      { error: "conversa nao encontrada — inicie o contato pelo WhatsApp antes" },
      { status: 404 }
    );
  }

  // ————————————————————————— API oficial: janela de 24h e TEMPLATE
  //
  // A regra da Meta: fora da janela de 24h nao passa mensagem livre, so template
  // APROVADO. Ate 31/08/2026 este painel so sabia recusar ("...enviado fora do
  // painel") — o template era fluxo do Meeting Hub. A Frente U fechou essa metade:
  // o catalogo de template por numero agora mora aqui (`/api/canais/templates`) e
  // este e o caminho de envio.
  //
  // A ORDEM DAS GUARDAS e o que importa, e ela e fail-closed em cada passo:
  //   1. template so existe em canal de API Oficial;
  //   2. o template tem que estar NO CATALOGO deste canal (aprovacao e por NUMERO
  //      remetente — o template do numero A nao vale no numero B);
  //   3. o status tem que ser `aprovado` (`podeEnviarTemplate` recusa em analise,
  //      recusado, pausado e desconhecido) — barrado ANTES da chamada ao provedor,
  //      porque a recusa da Meta gasta chamada e arranha a nota do numero;
  //   4. a NUMERACAO das variaveis tem que ser {{1}}..{{N}} sem pular, e a
  //      quantidade de parametros tem que bater EXATAMENTE (parametro a menos a
  //      Meta recusa; a mais ela ignora em silencio, e ai a mensagem sai com o
  //      texto errado sem erro em lugar nenhum).
  //
  // OS QUATRO PASSOS MORAM EM `decidirEnvioTemplate` (lib/templates-oficial.ts),
  // puro e provado em node solto — nao em `if`s aqui. Motivo, e ele foi medido:
  // enquanto a decisao vivia nesta rota, a unica prova possivel era varredura de
  // fonte, e foi assim que o passo 4 ficou seis dias contando variaveis DISTINTAS
  // (template "Ola {{1}} ... dia {{3}}." passava com 2 parametros; o painel
  // gravava "dia {{3}}" na conversa e o provedor casava por posicao — tela mentindo
  // sem erro em lugar nenhum).
  let tplEnvio: EnvioTemplateProvado | null = null;
  if (fonte === "gupshup") {
    if (pedeTemplate) {
      // TEMPLATE + OUTRA COISA no mesmo pedido = 400, nao "o template vence".
      // Texto livre ja era barrado; a PERGUNTA COM OPCOES nao era, e ela deixava a
      // linha gravada misturada (tipo `interactive_*` e corpo com o resumo da
      // pergunta, pra uma mensagem que saiu como template). A decisao e pura
      // (`conflitoComTemplate`) pra poder ser exercitada — ver bloco P da prova.
      const conflito = conflitoComTemplate({ texto: text, pergunta: ehInterativa });
      if (conflito) return NextResponse.json({ error: conflito }, { status: 400 });
      // o nome vem antes da consulta porque e ele que VAI na consulta — e nome
      // fora do formato nao pode nem virar query (ele viaja na URL do DELETE do
      // provedor). Mesma funcao pura que a decisao usa: nao ha copia de regex.
      const ped = lerPedidoTemplate(template);
      if (!ped.ok) return NextResponse.json({ error: ped.motivo }, { status: 400 });
      const { templateDoCanal } = await import("@/lib/canais-db");
      const cat = await templateDoCanal(canal, ped.nome, ped.idioma || undefined);
      const decisao = decidirEnvioTemplate(template, cat);
      if (!decisao.ok) {
        return NextResponse.json({ error: decisao.motivo }, { status: decisao.status });
      }
      tplEnvio = decisao.envio;
    } else {
      const j = await janela24h(String(chat_id), T.mensagens);
      if (!j.aberta) {
        return NextResponse.json(
          {
            error:
              "janela de 24h FECHADA — o cliente precisa mandar mensagem primeiro. " +
              "Fora dela, so template aprovado: escolha um template deste numero.",
            // a tela usa isto pra oferecer o seletor de template em vez de so
            // travar o composer com um banner sem saida
            use_template: true,
          },
          { status: 403 }
        );
      }
    }
  } else if (template) {
    // 400 explicito em vez de ignorar: pedido que carrega template pra numero
    // Z-API/Evolution esta com a intencao errada, e ignorar em silencio mandaria
    // a mensagem por outro caminho sem ninguem perceber.
    return NextResponse.json(
      { error: "template existe so no numero de API Oficial — neste numero a conversa e livre" },
      { status: 400 }
    );
  }

  // a mensagem respondida tem que ser da MESMA conversa (a API oficial nao tem
  // reply/quote no envio de sessao; Z-API e Evolution tem)
  let quoted: string | null = null;
  if (quoted_msg_id && (fonte === "zapi" || fonte === "evolution")) {
    const { data: alvo } = await db
      .from(T.mensagens)
      .select("provider_msg_id")
      .eq("chat_id", String(chat_id))
      .eq("provider_msg_id", String(quoted_msg_id))
      .maybeSingle();
    quoted = alvo?.provider_msg_id ?? null;
  }

  // Assinatura por usuario (como no ChatGuru): "*Nome:*" em negrito na frente do
  // texto/legenda. Nome de exibicao do perfil; sem nome definido, o da conta.
  // O FORMATO mora em lib/conversa-automatica.ts (`textoComAssinatura`) — havia
  // tres copias da mesma linha no repo, e formato copiado diverge sozinho.
  //
  // Esta e a porta de envio de TEXTO PROPRIO do painel. Quem NAO assina, e por
  // que: disparo em massa (lib/disparo) sai como automacao, e ENCAMINHAR
  // (/api/forward) leva conteudo de OUTRA pessoa — assinar o texto alheio com o
  // nome de quem encaminhou faria a mensagem parecer escrita por ele.
  //
  // FRENTE S — a PERGUNTA COM OPCOES nao e assinada, e por um motivo concreto:
  // no envelope interativo o corpo e um campo com teto proprio da plataforma
  // (1024 no `body` da lista, 20 no `header`), e prefixar "*Nome:*" pode
  // estourar esse teto e fazer a Meta recusar a mensagem INTEIRA — a assinatura
  // derrubaria o envio em vez de aparecer. Precedente da casa: encaminhar e
  // disparo em massa tambem nao assinam.
  //
  // A mesma leitura resolve as preferencias do remetente (modo supervisor).
  const conta = await contaDoUsuario(user.id);
  // TEMPLATE NAO E ASSINADO. Template aprovado nao se altera — mexer no texto e
  // exatamente o que a Meta recusa, e o que o painel grava tem que ser o que
  // chegou no cliente. Mesma logica que ja tira a assinatura de /api/forward
  // (conteudo de outra pessoa) e do disparo em massa (sai como automacao).
  const textoEnviar = tplEnvio
    ? tplEnvio.texto
    : textoComAssinatura(text, { ...conta, nome: user.nome });
  const porSessao = !identidadePorApiKey(req);

  // FRENTE S — PLANO da interativa. Calculado ANTES do envio porque ele decide
  // por qual porta a mensagem sai, e a resposta devolve o plano pra tela poder
  // dizer o que aconteceu ("foi como texto numerado porque ...").
  const grupo = /-group$/.test(String(chat_id));
  const plano = vInter?.ok ? planoDeEnvio(fonte, vInter.msg.tipo, { grupo }) : null;

  try {
    let sent: { messageId?: string | null };
    if (tplEnvio) {
      // ENVIO POR TEMPLATE (Frente U) — precede todo o resto: e o unico caminho
      // fora da janela de 24h e nunca se combina com interativa/midia.
      sent = await enviarTemplateProvado(credsGs!, String(chat_id), tplEnvio, gsEnviarTemplate);
    } else if (vInter?.ok && plano) {
      const msgI = vInter.msg;
      if (plano.modo === "nativo" && fonte === "gupshup") {
        sent = await gsSendInterativo(credsGs!, String(chat_id), envelopeGupshup(msgI));
      } else if (plano.modo === "nativo" && fonte === "zapi") {
        sent = await zapiSendOptionList(creds!, String(chat_id), envelopeZapiLista(msgI));
      } else {
        // FALLBACK: a MESMA pergunta como texto numerado (criterio do card). Sai
        // pela porta de texto normal do canal — nao ha caminho paralelo de
        // envio, entao o que vale pro texto (janela de 24h, quote, trilha) vale
        // aqui sem uma linha nova.
        const corpo = textoNumerado(msgI);
        sent =
          fonte === "gupshup"
            ? await gsSendText(credsGs!, String(chat_id), corpo)
            : fonte === "evolution"
            ? await evoSendText(credsEvo!, String(chat_id), corpo, quoted)
            : await zapiSendText(creds!, String(chat_id), corpo, quoted);
      }
    } else {
      sent =
        fonte === "gupshup"
          ? await gsSendText(credsGs!, String(chat_id), textoEnviar)
          : fonte === "evolution"
          ? ehMidia
            ? await evoSendMedia(credsEvo!, tipo as TipoMidia, String(chat_id), media, {
                caption: textoEnviar,
                fileName: typeof file_name === "string" ? file_name : undefined,
                quoted,
              })
            : await evoSendText(credsEvo!, String(chat_id), textoEnviar, quoted)
          : ehMidia
          ? await zapiSendMedia(creds!, tipo as TipoMidia, String(chat_id), media, {
              caption: textoEnviar,
              fileName: typeof file_name === "string" ? file_name : undefined,
              quoted,
            })
          : await zapiSendText(creds!, String(chat_id), textoEnviar, quoted);
    }

    // preview da lista fica SEM a assinatura (ja mostra "Nome: ..." por fora).
    // No template (Frente U), o preview e o texto RENDERIZADO — o que o cliente
    // esta lendo; "{{1}}" na lista de conversas seria tela mentindo.
    const conteudo = tplEnvio
      ? tplEnvio.texto
      : vInter?.ok && plano
      ? previaDoEnviado(vInter.msg, plano.modo)
      : text || PREVIEW_TIPO[tipo as string] || "[midia]";
    // O QUE FICA GRAVADO na bolha. Na interativa vao a pergunta E as opcoes,
    // mesmo no modo nativo: a bolha do painel nao desenha botao, e sem as opcoes
    // o atendente leria a resposta do cliente sem saber o que foi oferecido.
    // Template e midia caem no default: `textoEnviar` ja e o texto renderizado.
    const conteudoEnviado =
      vInter?.ok && plano
        ? resumoDoEnviado(vInter.msg, plano.modo)
        : textoEnviar || PREVIEW_TIPO[tipo as string] || "[midia]";
    // `text` no fallback (foi literalmente um texto que saiu) e
    // `interactive_quick_reply`/`interactive_list` no nativo — o MESMO
    // vocabulario que o importador ja reconhece no acervo. Template sai como "text".
    const tipoLinha = vInter?.ok && plano ? tipoDeMensagem(vInter.msg, plano.modo) : ehMidia ? (tipo as string) : "text";

    // EFEITOS DE "RESPONDI NESTA CONVERSA" — carimbo de ultima mensagem + previa, status
    // por `statusAoResponder` (gente, origem "manual"), auto-arquivar (F9: chat com
    // auto_arquivar nunca reabre sozinho) e posse (sem responsavel, quem responde assume;
    // conversa ENCERRADA e do pool e passa a ser de quem retomou — Eric, 16/08) — moram
    // em `efeitosDeResposta` (lib/fluxo/executar.ts), o MESMO dono que o motor de fluxo
    // e a acao de anexar usam. Ate 03/09/2026 esta rota carregava uma COPIA dessas ~60
    // linhas (divida declarada na Fundacao do motor): regra copiada em dois lugares
    // diverge na primeira mudanca. `trilha: false` porque isto nao e execucao de fluxo.
    const now = await efeitosDeResposta(
      {
        canal,
        chat_id: String(chat_id),
        usuario: { id: user.id, nome: user.nome },
        origem: "manual",
        trilha: false,
      },
      { status: conversa.status, auto_arquivar: conversa.auto_arquivar },
      `${user.nome}: ${conteudo}`
    );

    // O que e SO desta porta: responder zera o contador de nao lidas. Pra quem NAO e
    // supervisor isso e redundante (abrir a conversa ja zerou) e inofensivo; pra quem
    // esta em MODO SUPERVISOR e a unica porta que zera — e ela e opcional
    // (`supervisor_responder_zera`, nasce ligada). SO com identidade de SESSAO: zerar
    // "nao lida" e efeito de LEITURA HUMANA. Envio pela chave de API (MCP/agente) nao le
    // a conversa — ele apagaria da fila do time uma mensagem que nenhuma pessoa viu.
    if (porSessao && responderZeraNaoLidas(conta.preferencias)) {
      await db.from(T.conversas).update({ mensagens_nao_lidas: 0 }).eq("chat_id", String(chat_id));
    }

    await db.from(T.mensagens).insert({
      chat_id: String(chat_id),
      direcao: "out",
      tipo: tipoLinha,
      conteudo: conteudoEnviado,
      // midia enviada: o eco do webhook traz a URL publica e preenche media_url
      provider_msg_id: sent.messageId || null,
      quoted_msg_id: quoted,
      status: "sent",
      criada_em: now,
      enviado_por_id: user.id,
      enviado_por_nome: user.nome,
    });
    return NextResponse.json({
      ok: true,
      messageId: sent.messageId || null,
      // FRENTE S: o plano viaja de volta. Sem isso, a tela nao teria como dizer
      // que a pergunta saiu como texto numerado — e "enviei botoes" para um
      // cliente que recebeu texto e a mentira que este campo existe pra impedir.
      ...(plano ? { modo: plano.modo, motivo_modo: plano.motivo } : {}),
    });
  } catch (e: any) {
    console.error("send falhou", { usuario: user.email, chat: chat_id, tipo, erro: e?.message });
    return NextResponse.json({ error: "falha ao enviar pelo WhatsApp" }, { status: 502 });
  }
}
