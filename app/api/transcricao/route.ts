import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, podeVerConversa } from "@/lib/perfil";
import { canalDeBody, tabelas } from "@/lib/canal";
import { somenteLeitura } from "@/lib/canais";
import { msgDb } from "@/lib/mensageria";
import { restricaoEfetiva } from "@/lib/embed";
import { getConfig, fusoDaConfig } from "@/lib/config";
import {
  corpoDaChamada, disponivel, linhaDaNota, motivoParaNaoTranscrever, prefixoDaNota, resolverConfig,
  textoDoCorpo, LIMITE_TEXTO_TRANSCRICAO, TIMEOUT_MS, TIPOS_DE_AUDIO,
} from "@/lib/transcricao";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// TRANSCRICAO DE AUDIO — card 86ak85ny7. So o GANCHO.
//
//   GET   diz se o recurso esta disponivel nesta instalacao (e a tela se esconde
//         quando nao esta). NUNCA devolve url nem chave.
//   POST  transcreve UM audio e grava a anotacao interna.
//
// NADA AQUI CHAMA UM SERVICO QUE O DONO NAO CONFIGUROU. Sem `TRANSCRICAO_URL` e
// `TRANSCRICAO_CHAVE` na instalacao, o GET responde `disponivel: false` e o POST
// responde 503 com o motivo — o painel nunca faz uma chamada paga por conta
// propria. O porque de cada camada esta em lib/transcricao.ts.
//
// COSTURA DECLARADA — O QUE ESTE CARD **NAO** ENTREGA:
// a transcricao aqui e SOB PEDIDO (um POST por audio). O modo da origem era
// AUTOMATICO: todo audio que chegava entrava numa fila (`transcribed`: `new` ->
// `done`/`error`, medido 1.542 na fila e 997 com erro no acervo) e a anotacao
// aparecia sozinha. Fazer isso aqui exige duas coisas que NAO estao neste card e
// que seriam decisao de outra pessoa:
//   1. uma COLUNA DE ESTADO na mensagem (`new|done|error`), porque sem estado nao
//      ha fila, nao ha retentativa e nao ha como mostrar "falhou" na tela — e
//      coluna nova e DDL, que aqui sai como arquivo e e gesto humano;
//   2. um GATILHO no ponto de INGESTAO (o webhook que grava a mensagem recebida),
//      que e territorio de quem cuida dos canais.
// Foi escolhido assim de proposito, em vez de inventar meia-fila: fila sem estado
// e o tipo de coisa que parece funcionar e perde audio em silencio.
//
// O QUE A IDEMPOTENCIA COBRE, com precisao (nao arredondar isto pra cima):
//   - NOTA DUPLICADA: coberta pelo BANCO. A nota aponta pro audio em
//     `quoted_msg_id` e a 0022 poe um indice unico parcial ali — duas chamadas
//     simultaneas nunca deixam duas notas; a que perde recebe a nota da que
//     ganhou (23505 tratado adiante).
//   - COBRANCA DUPLICADA: **NAO coberta**, e a janela e real: duas chamadas que
//     entram antes de qualquer uma terminar chamam o servico duas vezes (a
//     segunda so descobre a colisao ao gravar). Fechar isso exige RESERVAR antes
//     de chamar — ou seja, a coluna de estado do item 1. Enquanto ela nao existe,
//     o custo do clique-duplo-simultaneo e uma transcricao a mais, uma vez.
//     Declarado em vez de silenciado: o proximo a mexer aqui precisa saber.
//
// PERMISSAO: quem PODE VER A CONVERSA pode transcrever. Nao ha permissao nova, e
// a razao esta declarada: transcrever e ler o que o cliente falou — e trabalho de
// atendente, nao configuracao de automacao. O controle de CUSTO nao e permissao,
// e a configuracao: a instalacao liga o servico sabendo o que paga, e desliga
// pela config sem deploy.

const semCache = { "Cache-Control": "no-store, max-age=0" } as const;

/** Nota de transcricao que JA existia: devolve o texto sem o cabecalho. */
function respostaDeNotaExistente(linha: { id: string; conteudo?: string | null }, prefixo: string) {
  const conteudo = String(linha.conteudo || "");
  // corta o cabecalho SO se ele estiver ali: nota antiga (importada, ou gravada
  // com outro fuso) tem prefixo diferente, e cortar N caracteres no escuro
  // comeria as primeiras palavras da transcricao
  const texto = conteudo.startsWith(prefixo) ? conteudo.slice(prefixo.length).trim() : conteudo.trim();
  return NextResponse.json({ ok: true, id: linha.id, ja_existia: true, texto }, { headers: semCache });
}

async function configDaInstalacao() {
  let doBanco: unknown = null;
  try {
    const { data } = await msgDb().from("config").select("valor").eq("chave", "transcricao").maybeSingle();
    doBanco = data?.valor ?? null;
  } catch {
    // linha de config ilegivel (banco fora, tabela sem a linha) NAO pode LIGAR
    // nada: segue o que a env disse, que e o unico lugar de onde a chave vem
  }
  return resolverConfig(process.env, doBanco);
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cfg = await configDaInstalacao();
  // SO o booleano e a lista de tipos. Devolver a url (ou pior, o tamanho da
  // chave) daria a qualquer atendente logado um pedaco da configuracao de
  // infraestrutura da instalacao.
  return NextResponse.json(
    { disponivel: disponivel(cfg), tipos: TIPOS_DE_AUDIO, teto_caracteres: LIMITE_TEXTO_TRANSCRICAO },
    { headers: semCache }
  );
}

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const canal = canalDeBody(body);
  const T = tabelas(canal);
  const chat_id = typeof body?.chat_id === "string" ? body.chat_id.trim() : "";
  const mensagem_id = typeof body?.mensagem_id === "string" ? body.mensagem_id.trim() : "";
  if (!chat_id || !mensagem_id) {
    return NextResponse.json({ error: "chat_id e mensagem_id sao obrigatorios" }, { status: 400 });
  }

  // GATE DE CONVERSA antes de qualquer coisa: sem isto, um atendente com recorte
  // de visibilidade poderia transcrever (e ler) audio de conversa que ele nao
  // pode abrir — e a nota ficaria gravada na conversa alheia.
  if (!(await podeVerConversa(chat_id, user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(chat_id)) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }

  // FONTE EXTERNA (instagram-agent): a nota mora na tabela de mensagens do
  // painel, que este canal nao tem. Mesmo gate de `/api/nota` — mesmo recurso,
  // mesma tabela. Sem ele o insert morria em 42P01 e a rota devolvia 500 com a
  // mensagem crua do Postgres (nome de tabela e schema pra quem pediu), em vez de
  // um 403 que explica.
  if (somenteLeitura(canal)) {
    return NextResponse.json(
      { error: "canal somente leitura: transcricao ainda nao disponivel pra este canal" },
      { status: 403 }
    );
  }

  const cfg = await configDaInstalacao();
  if (!disponivel(cfg)) {
    return NextResponse.json(
      {
        error:
          "transcricao nao configurada nesta instalacao — quem instala aponta o servico em TRANSCRICAO_URL e TRANSCRICAO_CHAVE",
        disponivel: false,
      },
      { status: 503, headers: semCache }
    );
  }

  const db = msgDb();
  const { data: msg, error: erroMsg } = await db
    .from(T.mensagens)
    .select("id,chat_id,direcao,tipo,media_url,media_mime,is_deleted,criada_em")
    .eq("id", mensagem_id)
    .maybeSingle();
  if (erroMsg) return NextResponse.json({ error: erroMsg.message }, { status: 500 });
  // conferir o chat_id da LINHA, e nao confiar no que o pedido disse: sem isto o
  // gate acima seria contornavel mandando um chat_id que a pessoa alcanca com o
  // id de uma mensagem de outra conversa
  if (!msg || String(msg.chat_id) !== chat_id) {
    return NextResponse.json({ error: "mensagem nao encontrada nesta conversa" }, { status: 404 });
  }
  const impedimento = motivoParaNaoTranscrever(msg);
  if (impedimento) return NextResponse.json({ error: impedimento }, { status: 422 });

  const cfgPainel = await getConfig();
  const fuso = fusoDaConfig(cfgPainel);
  const prefixo = prefixoDaNota(msg.criada_em || Date.now(), fuso);

  // JA TRANSCRITO? A pergunta e feita pela MENSAGEM, e isso e correcao de um
  // defeito real (revisao cega de 31/08/2026): a primeira versao procurava pelo
  // PREFIXO da nota, que tem resolucao de MINUTO — dois `ptt` seguidos no mesmo
  // minuto (caso comum, e ha par identico no acervo importado: "14/01/25 as
  // 20:29") produzem prefixo IGUAL, e o segundo audio recebia de volta a
  // transcricao do PRIMEIRO sem nunca ser transcrito. Errado em silencio, que e o
  // pior tipo: o atendente le um texto que nao e daquele audio.
  //
  // A nota aponta pra mensagem por `quoted_msg_id` (coluna que ja existe — zero
  // DDL), e a 0022 poe um indice UNICO parcial nela pra nota de transcricao:
  // assim a unicidade e do BANCO, nao da checagem, e duas chamadas simultaneas
  // nunca deixam duas notas.
  const { data: jaTem } = await db
    .from(T.mensagens)
    .select("id,conteudo")
    .eq("chat_id", chat_id)
    .eq("direcao", "interna")
    .eq("tipo", "nota")
    .eq("quoted_msg_id", mensagem_id)
    .limit(1);
  if (jaTem?.length) return respostaDeNotaExistente(jaTem[0], prefixo);

  // A CHAMADA AO SERVICO DA INSTALACAO.
  //
  // Timeout obrigatorio: sem ele um servico que pendura deixa o handler preso e
  // come o pool de conexoes do painel.
  //
  // `redirect: "manual"` e A CHAVE EM UM CABECALHO SO — as duas coisas consertam
  // um vazamento MEDIDO em 31/08/2026 (dois servidores locais, um respondendo
  // 302 pro outro): num redirect cross-origin o undici REMOVE `Authorization` e
  // **NAO remove `x-api-key`** — o segundo host recebeu a chave em texto claro. O
  // proprio servico de terceiro (ou quem sequestrasse a resposta) colhia a chave
  // paga da instalacao respondendo um 302. Mandar a chave em dois cabecalhos
  // "pra dar certo com qualquer fornecedor" era comodidade paga com a chave.
  // Mesma regra de `lib/webhooks-saida.ts`, que ja disparava com redirect manual.
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TIMEOUT_MS);
  let resposta: Response;
  try {
    resposta = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.chave}` },
      body: JSON.stringify(corpoDaChamada(msg, { idioma: typeof body?.idioma === "string" ? body.idioma : undefined })),
      signal: controle.signal,
      redirect: "manual",
      cache: "no-store",
    });
  } catch (e: any) {
    const abortou = e?.name === "AbortError";
    return NextResponse.json(
      { error: abortou ? "o servico de transcricao nao respondeu no tempo limite" : "nao consegui falar com o servico de transcricao" },
      { status: 504 }
    );
  } finally {
    clearTimeout(relogio);
  }

  // Com `redirect: "manual"` um 3xx chega aqui como resposta normal (nao seguida),
  // e `resposta.ok` e falso — entao o aviso e explicito em vez de virar "respondeu
  // 302", que manda a pessoa procurar defeito no lugar errado.
  if (resposta.status >= 300 && resposta.status < 400) {
    return NextResponse.json(
      {
        error:
          "o servico de transcricao respondeu com redirecionamento, e o painel nao segue redirect (seguir levaria a chave pra outro host) — aponte TRANSCRICAO_URL pro endereco final",
      },
      { status: 502 }
    );
  }
  if (!resposta.ok) {
    // O corpo do erro do servico NAO e repassado: ele e de terceiro e pode
    // conter chave, url interna ou o proprio audio. Vai o status, que e o que a
    // pessoa precisa pra reclamar com o fornecedor dela.
    return NextResponse.json(
      { error: `o servico de transcricao respondeu ${resposta.status}` },
      { status: 502 }
    );
  }

  // O corpo e lido UMA VEZ (ver `textoDoCorpo`: a versao anterior fazia `.json()`
  // e depois `.text()`, que sempre lancava "Body is unusable" e derrubava todo
  // servico que responde texto puro).
  const texto = await textoDoCorpo(resposta);
  if (!texto) {
    // Resposta sem texto NAO vira nota vazia: uma nota em branco diria ao
    // atendente que o audio nao tinha nada dentro, o que e diferente de
    // "o servico nao devolveu transcricao".
    return NextResponse.json(
      { error: "o servico respondeu sem transcricao — o audio pode estar inaudivel ou o formato nao ser aceito" },
      { status: 422 }
    );
  }

  const { data: nota, error } = await db
    .from(T.mensagens)
    .insert({
      ...linhaDaNota(chat_id, msg.criada_em || Date.now(), texto, fuso, mensagem_id),
      criada_em: new Date().toISOString(),
      // TRILHA DE QUEM GASTOU. A AUTORIA da nota e da automacao (id NULL + nome,
      // convencao 0006) e isso esta certo: nenhum atendente escreveu aquele
      // texto. Mas transcrever CUSTA DINHEIRO da instalacao, e acao paga sem
      // rastro de quem pediu nao da pra auditar nem pra conversar com a equipe
      // quando a fatura sobe. Os dois registros nao competem: um diz quem
      // ESCREVEU, o outro quem MANDOU transcrever.
      raw: { transcricao_por: user.id, transcricao_de_mensagem: mensagem_id },
    })
    .select("id,conteudo")
    .single();
  if (error) {
    // 23505 = o indice unico parcial da 0022 pegou uma segunda chamada
    // simultanea. Nao e erro pra quem pediu: a nota que interessa existe.
    if (/23505|duplicate key/i.test(`${error.code || ""} ${error.message || ""}`)) {
      const { data: dela } = await db
        .from(T.mensagens)
        .select("id,conteudo")
        .eq("chat_id", chat_id)
        .eq("direcao", "interna")
        .eq("tipo", "nota")
        .eq("quoted_msg_id", mensagem_id)
        .limit(1);
      if (dela?.length) return respostaDeNotaExistente(dela[0], prefixo);
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: nota.id, texto, nota: nota.conteudo }, { headers: semCache });
}
