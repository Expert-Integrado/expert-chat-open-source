import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth-server";
import { getPerfil, permitido, podeVerConversa } from "@/lib/perfil";
import { restricaoEfetiva } from "@/lib/embed";
import { canalDeBody } from "@/lib/canal";
import { canalPorId, envioDisponivel, somenteLeitura } from "@/lib/canais";
import { chaveJaValida, legendaDeAnexo, motivoNaoAnexa, payloadDeEnvio } from "@/lib/anexos";
import { anexoPorChave, anexoPorId, registrarEventoAnexo, registrarUso } from "@/lib/anexos-db";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// ANEXAR UM ARQUIVO DA BIBLIOTECA A UMA CONVERSA (Frente W, card 86ak85bmw)
//
// ESTA ROTA NAO ENVIA — ELA DELEGA. O envio continua sendo `/api/send`, e a
// chamada sai daqui com a MESMA credencial de quem pediu (o padrao que
// `lib/mcp-tools.ts` ja usa pras 14 tools: proxia pra REST do proprio painel com
// a chave do usuario, zero logica de permissao duplicada).
//
// POR QUE ASSIM, e nao mandando o arquivo daqui: `/api/send` carrega travas que
// nenhuma outra porta tem e que nao podem existir em duas versoes — permissao
// `enviar`, destino valido, so conversa que JA EXISTE (barreira anti-disparo
// frio), janela de 24h do canal oficial, assinatura do atendente, zerar nao-lidas
// so pra identidade de SESSAO, trilha de autoria na mensagem e o eco do webhook
// deduplicando por `provider_msg_id`. Reescrever isso aqui seria uma segunda
// porta de envio com as travas da primeira pela metade — que e exatamente o que
// este repo recusou no editor de fluxos ("editor que executa vira segunda porta
// de envio sem as travas da primeira").
//
// O QUE ESTA ROTA FAZ, e que `/api/send` nao faria sozinho:
//   1. resolve o item da biblioteca (por `chave` PORTATIL ou por id) — e a URL
//      que vai pro provedor sai do acervo, nunca do corpo do pedido. Isto e
//      seguranca, nao conveniencia: aceitar `media` livre transformaria a rota
//      num encaminhador de URL arbitraria assinado pelo numero da empresa;
//   2. recusa ANTES do clique, com frase honesta, o que o canal nao faz (numero
//      somente leitura, envio nao cabeado, API Oficial que na v1 manda so texto);
//   3. carimba o uso e grava a trilha ("este material foi mandado").
//
// GATE DE CONVERSA: `podeVerConversa` + `restricaoEfetiva`, igual /api/macros e
// /api/send. Mandar arquivo numa conversa e agir nela; quem nao pode abrir a
// conversa nao anexa nada nela — e o `/api/send` recusaria de novo, o que faz
// deste gate a primeira das duas camadas, nunca a unica.

const semCache = { "Cache-Control": "no-store, max-age=0" } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  // getUser ANTES de ler o corpo, sempre: a porta da chave de API precisa CLONAR
  // o corpo pra saber de qual canal o pedido fala, e corpo de `Request` se le uma
  // vez. Handler que le primeiro deixa o escopo da chave INERTE — o GRAVE D1 da
  // Frente U, que passou por duas revisoes.
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const perfil = await getPerfil(user.id);
  const emb = await restricaoEfetiva(req, user, perfil);
  if (emb === "invalido") return NextResponse.json({ error: "contexto invalido" }, { status: 401 });

  const body = await req.json().catch(() => ({}) as any);
  const canal = canalDeBody(body);
  const chatId = typeof body?.chat_id === "string" ? body.chat_id.trim() : "";
  if (!chatId) return NextResponse.json({ error: "chat_id obrigatorio" }, { status: 400 });

  // PERMISSAO DE ENVIAR, nao permissao de biblioteca: anexar e MANDAR MENSAGEM
  // pro cliente. As quatro permissoes de biblioteca governam administrar o
  // acervo; quem atende usa o acervo com a permissao que ele ja tem.
  if (!permitido(perfil, "enviar")) {
    return NextResponse.json({ error: "sem permissao de enviar mensagem" }, { status: 403 });
  }
  if (!(await podeVerConversa(chatId, user, perfil, canal))) {
    return NextResponse.json({ error: "conversa fora do seu escopo" }, { status: 403 });
  }
  if (emb && !emb.permite(chatId)) {
    return NextResponse.json({ error: "fora do contexto" }, { status: 403 });
  }

  const def = canalPorId(canal);
  if (!def) return NextResponse.json({ error: "canal desconhecido" }, { status: 404 });
  // CAPACIDADE DA FONTE, nunca id de canal (licao da Frente S no clipe e no
  // microfone): com id escrito na regra, uma 2a instancia declarada em
  // CANAIS_EXTRA ficaria sem anexo suportando o envio.
  const motivo = motivoNaoAnexa({
    fonte: def.fonte,
    soLeitura: somenteLeitura(canal),
    envioCabeado: envioDisponivel(canal),
  });
  if (motivo) return NextResponse.json({ error: motivo }, { status: 403 });

  const legenda = legendaDeAnexo(body?.legenda);
  if (!legenda.ok) return NextResponse.json({ error: legenda.erro }, { status: 400 });

  // A URL SAI DO ACERVO. Por `chave` (a identidade portatil, a mesma que o fluxo
  // usa) ou por id; nunca por URL vinda do corpo.
  const porChave = typeof body?.chave === "string" ? body.chave.trim().toLowerCase() : "";
  const porId = typeof body?.id === "string" ? body.id : "";
  const leitura = porChave
    ? chaveJaValida(porChave)
      ? await anexoPorChave(porChave)
      : { ok: true as const, linha: null }
    : UUID_RE.test(porId)
      ? await anexoPorId(porId)
      : null;
  if (!leitura) return NextResponse.json({ error: "informe `chave` ou `id` do arquivo" }, { status: 400 });
  if (!leitura.ok) return NextResponse.json({ error: leitura.aviso }, { status: 503 });
  if (!leitura.linha) return NextResponse.json({ error: "arquivo nao encontrado na biblioteca" }, { status: 404 });
  const anexo = leitura.linha;

  const payload = payloadDeEnvio(
    {
      chave: anexo.chave,
      nome: anexo.nome,
      arquivo_nome: anexo.arquivo_nome,
      mime: anexo.mime,
      url: anexo.url,
    },
    legenda.valor
  );

  // PROXY pro /api/send com a credencial de quem pediu. Os dois cabecalhos sao
  // repassados quando existem (sessao e chave de API), e nenhum e inventado aqui:
  // se o pedido nao trouxe credencial, o /api/send responde 401 — o que e o
  // certo. Segredo nenhum desta instalacao entra nesta chamada.
  const autorizacao = req.headers.get("authorization");
  const chaveApi = req.headers.get("x-api-key");
  const cabecalhos: Record<string, string> = { "Content-Type": "application/json" };
  if (autorizacao) cabecalhos.authorization = autorizacao;
  if (chaveApi) cabecalhos["x-api-key"] = chaveApi;

  const alvo = new URL("/api/send", req.nextUrl.origin);
  const ctrl = new AbortController();
  const relogio = setTimeout(() => ctrl.abort(), 45_000);
  let resposta: { status: number; corpo: any };
  try {
    const r = await fetch(alvo, {
      method: "POST",
      headers: cabecalhos,
      body: JSON.stringify({ ...payload, canal, chat_id: chatId }),
      cache: "no-store",
      // 3xx nao leva credencial pra outro host: a mesma regra dos webhooks de
      // saida e da transcricao. Aqui o destino e o proprio painel, entao um
      // redirect e sinal de configuracao errada, nao de caminho novo.
      redirect: "manual",
      signal: ctrl.signal,
    });
    let corpo: any = {};
    try {
      corpo = await r.json();
    } catch {
      corpo = {};
    }
    resposta = { status: r.status, corpo };
  } catch (e: any) {
    const abortou = e?.name === "AbortError";
    return NextResponse.json(
      { error: abortou ? "o envio passou de 45s e foi abortado" : `falha falando com o envio: ${e?.message ?? e}` },
      { status: 502 }
    );
  } finally {
    clearTimeout(relogio);
  }

  if (resposta.status < 200 || resposta.status >= 300) {
    // O MOTIVO DE `/api/send` VIAJA INTEIRO. Trocar por uma frase generica faria
    // o atendente perder o unico diagnostico que existe ("janela de 24h fechada",
    // "inicie o contato pelo WhatsApp antes") — e ele nao tem como abrir o log.
    return NextResponse.json(
      {
        error: resposta.corpo?.error || "o envio recusou o anexo",
        etapa: "envio",
        anexo: { chave: anexo.chave, nome: anexo.nome },
      },
      { status: resposta.status }
    );
  }

  // Carimbo e trilha DEPOIS de a mensagem sair, e melhor-esforco: a mensagem ja
  // esta com o cliente, e transformar falha de carimbo em erro faria a tela
  // mostrar erro num envio que deu certo (e, num chamador com retentativa,
  // mandaria o arquivo duas vezes).
  await registrarUso(anexo.id);
  await registrarEventoAnexo({
    anexo_id: anexo.id,
    chave: anexo.chave,
    nome: anexo.nome,
    tipo: "usado",
    autor: { id: user.id, nome: user.nome },
    // canal + chat_id ficam na trilha porque "este material foi mandado pra quem"
    // e a pergunta que aparece depois; o telefone nao vai pra log nenhum aqui
    // alem desta linha, que e do proprio painel.
    detalhe: { canal, chat_id: chatId, tipo_envio: payload.tipo, com_legenda: !!payload.message },
  });

  return NextResponse.json(
    {
      ok: true,
      anexo: { id: anexo.id, chave: anexo.chave, nome: anexo.nome, tipo_envio: payload.tipo },
      envio: resposta.corpo,
    },
    { headers: semCache }
  );
}
