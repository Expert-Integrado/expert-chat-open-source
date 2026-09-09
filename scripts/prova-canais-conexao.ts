// Prova da CONEXAO DO NUMERO, da TROCA DE CHIP e dos TEMPLATES da API Oficial
// (Frente U — cards 86ak858mx, 86ak858nx, 86ak858pa).
// `node scripts/prova-canais-conexao.ts`   (Node >= 22.6, como as outras provas)
//
// SEM BANCO, SEM NAVEGADOR E — a parte que mais importa — SEM NUMERO REAL.
// Nada aqui fala com a Z-API nem com o Gupshup. A ordem do card e explicita:
// "NUNCA teste contra numero real"; a prova ponta a ponta com um chip de verdade
// e gesto humano, em card separado. O que esta prova trava sao as REGRAS, e cada
// bloco existe por um dano concreto:
//
//  A) IDADE DO QR. O chamado "escaneei e nao funcionou" e quase sempre codigo
//     expirado. Carimbo ilegivel conta como expirado (fail-closed) e relogio
//     adiantado nao vira idade negativa.
//  B) NUMERO. `mesmoNumero` cede SO no nono digito brasileiro, e em mais nada —
//     folga aqui vira "concluiu a troca com o chip errado"; rigidez demais vira
//     "recusa a troca legitima porque digitaram sem o 9".
//  C) ESTADO DO PROVEDOR. `error` vence `connected`, e rede caida e
//     `desconhecido`, nunca `desconectado` (senao a tela manda o cliente ler um
//     QR por causa de um soluco nosso).
//  D) TROCA. As duas guardas (numero valido + consentimento explicito) e os
//     QUATRO caminhos do veredito — em especial o `divergente`, que e criterio de
//     aceite: conectar chip diferente do declarado NAO conclui e AVISA.
//  E) TEMPLATE — status. `desconhecido` NAO envia; e os dois saneadores (entrada
//     do cru da Meta, saida do banco) nao podem ser trocados um pelo outro.
//  F) TEMPLATE — validacao de criacao, portada do Meeting Hub: cada linha e uma
//     reprovacao da Meta que ja aconteceu de verdade.
//  G) TEMPLATE — envio: parametros exatos, corpo do POST com o gotcha da imagem
//     (202 silencioso), e o 202 sem messageId contado como FALHA.
//  H) LEITURA DO CRU do Gupshup: o corpo limpo vem de `containerMeta.data`,
//     nunca do campo `data` do topo (25 de 104 templates divergiam em producao).
//  I) VARREDURA: as rotas novas tem verbete de recurso e NAO estao na tabela de
//     canal-padrao — as duas coisas medidas no proprio codigo, nao redigidas.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  ACOES_CONEXAO,
  INTERVALO_ACAO,
  acaoMuda,
  conexaoDaFonte,
  descreverEvento,
  ehAcaoConexao,
  estadoDesconhecido,
  estadoZapi,
  formatarNumero,
  idadeQr,
  mascararInstancia,
  mesmoNumero,
  normalizarNumero,
  qrExpirado,
  rotuloIdadeQr,
  traduzirErroZapi,
  validarTroca,
  vereditoDaTroca,
  SEGUNDOS_QR_VALIDO,
  canalObrigatorio,
  deveRenovarQr,
  ehTransicao,
  provedorRecusou,
  qrValido,
  type TrocaPendente,
} from "../lib/canal-conexao.ts";
import {
  MAX_VARIAVEIS_TEMPLATE,
  ROTULO_STATUS,
  STATUS_TEMPLATE,
  botoesValidos,
  conflitoComTemplate,
  contarVariaveis,
  decidirEnvioTemplate,
  decidirSincronizacao,
  corpoEnvioTemplate,
  enviarTemplateProvado,
  exemploBate,
  linhasDoCatalogo,
  lerPedidoTemplate,
  lerRespostaEnvio,
  lerSaldo,
  lerTemplateGupshup,
  motivoParaNaoEnviarTemplate,
  numeracaoDoCorpo,
  podeEnviarTemplate,
  renderizarTemplate,
  statusCanonico,
  statusDoBanco,
  sugerirExemplo,
  validarNovoTemplate,
  validarParametros,
  variaveisDoCorpo,
  type TemplateCanal,
} from "../lib/templates-oficial.ts";
import { CANAL_PADRAO_EM, recursoDaRota } from "../lib/escopo-chave.ts";

let assercoes = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  assercoes++;
  assert.equal(a, b, msg);
};
const dep = (a: unknown, b: unknown, msg: string) => {
  assercoes++;
  assert.deepEqual(a, b, msg);
};
const tem = (texto: unknown, re: RegExp, msg: string) => {
  assercoes++;
  assert.match(String(texto), re, msg);
};
/** A chamada TINHA que estourar, e com esta frase. */
const estoura = async (fn: () => Promise<unknown>, re: RegExp, msg: string) => {
  assercoes++;
  let erro: unknown = null;
  try {
    await fn();
  } catch (e) {
    erro = e;
  }
  assert.match(String((erro as any)?.message ?? erro ?? "(nao estourou)"), re, msg);
};

const T0 = new Date("2026-08-31T12:00:00.000Z");
const emSegundos = (s: number) => new Date(T0.getTime() + s * 1000);

// Fonte SEM COMENTARIO, pra varredura de codigo. Licao paga varias vezes neste
// repo: a prosa ao lado da guarda contem o vocabulario que a guarda procura, e ai
// a mutacao passa verde por casar com a PROPRIA EXPLICACAO. Estava declarado duas
// vezes no arquivo (blocos N e J); virou um so, no topo, porque copia diverge.
const semComentario = (fonte: string) =>
  fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// A TELA como TEXTO. Componente React nao roda aqui (sem DOM, sem banco), mas duas
// correcoes da revisao cega vivem SO nela — a cadencia do QR e o destaque do chip
// trocado fora do fluxo. Medir no arquivo e pouco, e e mais do que redigir no
// CLAUDE.md: se alguem "simplificar" o polling de volta pro intervalo fixo, morde.
const TELA = readFileSync("app/admin-canais.tsx", "utf8");

// ================================================== A) A IDADE DO QR
{
  const gerado = T0.toISOString();
  eq(idadeQr(gerado, T0), 0, "QR recem gerado tem idade zero");
  eq(idadeQr(gerado, emSegundos(7)), 7, "a idade e em segundos inteiros");
  eq(qrExpirado(gerado, emSegundos(5)), false, "QR de 5s ainda vale");
  eq(qrExpirado(gerado, emSegundos(SEGUNDOS_QR_VALIDO)), false, "no limite exato ainda vale");
  eq(qrExpirado(gerado, emSegundos(SEGUNDOS_QR_VALIDO + 1)), true, "um segundo depois do limite, expirou");

  // FAIL-CLOSED: sem carimbo legivel, tratamos como expirado. Deixar o cliente
  // escanear codigo morto e o defeito que este card existe pra matar.
  eq(idadeQr(null, T0), null, "carimbo ausente nao tem idade");
  eq(qrExpirado(null, T0), true, "carimbo ausente conta como EXPIRADO");
  eq(qrExpirado("nao e data", T0), true, "carimbo ilegivel conta como EXPIRADO");

  // relogio do servidor a frente do da tela: idade 0, nunca negativa
  eq(idadeQr(emSegundos(30).toISOString(), T0), 0, "carimbo no futuro vira idade zero, nao negativa");
  eq(qrExpirado(emSegundos(30).toISOString(), T0), false, "e carimbo no futuro nao aparece como expirado");

  tem(rotuloIdadeQr(gerado, T0), /gerado agora/, "a frase de QR novo diz 'agora'");
  tem(rotuloIdadeQr(gerado, emSegundos(9)), /ha 9 segundos/, "a frase conta os segundos");
  tem(rotuloIdadeQr(gerado, emSegundos(60)), /expirou/, "a frase de QR velho diz EXPIROU — o antidoto do chamado");
  tem(rotuloIdadeQr(undefined, T0), /gerando/, "sem carimbo, a tela diz que esta gerando");

  // ——— A CADENCIA (decisao escrita, a pedido da revisao).
  //
  // Pedir QR novo INVALIDA o anterior no provedor. O card fala em "polling a cada
  // ~4s"; ao pe da letra isso mataria 4 de cada 5 codigos que a pessoa ve, e o
  // sintoma seria exatamente o chamado que este card existe pra resolver. Entao
  // quem manda na cadencia e `deveRenovarQr`: pede outro SO quando o atual vence.
  eq(deveRenovarQr(null, T0), true, "sem QR na tela, pede (e o primeiro)");
  eq(deveRenovarQr(gerado, emSegundos(4)), false, "QR de 4s NAO e renovado — pedir outro invalidaria este");
  eq(deveRenovarQr(gerado, emSegundos(SEGUNDOS_QR_VALIDO)), false, "no limite exato, ainda nao");
  eq(deveRenovarQr(gerado, emSegundos(SEGUNDOS_QR_VALIDO + 1)), true, "vencido, pede outro");
  eq(
    deveRenovarQr(gerado, emSegundos(4)) === qrExpirado(gerado, emSegundos(4)),
    true,
    "renovar e expirar sao a MESMA pergunta — duas respostas divergiriam sozinhas"
  );

  // ——— O `data:` DO QR vai direto pro src de um <img>: conferir e obrigatorio.
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH" + "AAAAAAA==";
  eq(qrValido(`data:image/png;base64,${base64}`), true, "PNG base64 e QR valido");
  eq(qrValido(`data:image/jpeg;base64,${base64}`), true, "JPEG tambem");
  eq(qrValido(`data:image/svg+xml;base64,${base64}`), false, "SVG NAO — svg carrega script");
  eq(qrValido(`data:text/html;base64,${base64}`), false, "text/html NAO");
  eq(qrValido("javascript:alert(1)"), false, "esquema javascript: NAO");
  eq(qrValido(`data:image/png;base64,<script>alert(1)</script>`), false, "conteudo fora do alfabeto base64 NAO");
  eq(qrValido(""), false, "vazio nao e QR");
  eq(qrValido(null), false, "nulo nao e QR");
  eq(qrValido("data:image/png;base64,QQ=="), false, "curto demais pra ser imagem (fail-closed)");
}

// ============ A2) O `?canal=` OBRIGATORIO, COMO FLUXO (nao como frase)
//
// Isto era provado por GREP DE FRASE — a prova procurava o texto "nao assume um
// numero padrao" no fonte da rota. A revisao cega mostrou o obvio: mutacao que
// arranca a guarda e deixa o comentario passa batido. Frase nao e comportamento.
// Agora a decisao e uma FUNCAO, as tres rotas chamam ELA (pela porta comum), e o
// que a prova exercita e o veredito.
{
  const ok = canalObrigatorio("central");
  eq(ok.ok, true, "canal informado passa");
  eq((ok as any).id, "central", "e volta o id limpo");
  eq((canalObrigatorio("  testador  ") as any).id, "testador", "espaco em volta e aparado");

  for (const vazio of ["", "   ", null, undefined, 123, {}, []]) {
    const r = canalObrigatorio(vazio as unknown);
    eq(r.ok, false, `pedido sem canal (${JSON.stringify(vazio)}) e RECUSADO`);
    eq((r as any).status, 400, "com status 400 — erro do pedido, consertavel por quem chamou");
  }
  tem(
    (canalObrigatorio("") as any).erro,
    /nao assume um numero padrao/,
    "e a frase diz por que: default aqui seria mexer no numero errado"
  );

  // id malformado e 400, nao 404: 404 sai da porta, DEPOIS do registro. A
  // separacao tambem evita ecoar texto arbitrario do pedinte junto de "nao existe".
  for (const torto of ["Central", "com espaco", "../etc", "a", "x".repeat(40), "1abc", "com-hifen"]) {
    const r = canalObrigatorio(torto);
    eq(r.ok, false, `id fora do formato do registro e recusado: ${torto}`);
    eq((r as any).status, 400, "e tambem com 400");
  }
}

// ===================================================== B) O NUMERO
{
  eq(normalizarNumero("+55 (11) 91234-5678"), "5511912345678", "mascara de digitacao e limpa");
  eq(normalizarNumero(5511912345678), "5511912345678", "numero como number tambem vale");
  eq(normalizarNumero("119123"), null, "curto demais nao e numero");
  eq(normalizarNumero("5".repeat(16)), null, "longo demais (fora do E.164) nao e numero");
  eq(normalizarNumero(""), null, "vazio nao e numero");
  eq(normalizarNumero(null), null, "nulo nao e numero");

  eq(mesmoNumero("5511912345678", "5511912345678"), true, "igual e igual");
  // a UNICA folga: o nono digito brasileiro
  eq(mesmoNumero("5511912345678", "551112345678"), true, "com e sem o nono digito e o MESMO telefone (55)");
  eq(mesmoNumero("551112345678", "5511912345678"), true, "e a comparacao nao depende da ordem dos argumentos");
  // e as bordas onde ela NAO vale
  eq(mesmoNumero("5511912345678", "5511912345679"), false, "um digito diferente no fim = outro telefone");
  eq(mesmoNumero("5511912345678", "5521912345678"), false, "DDD diferente = outro telefone");
  eq(mesmoNumero("5511912345678", "1911912345678"), false, "DDI diferente = outro telefone");
  eq(
    mesmoNumero("5511812345678", "551112345678"),
    false,
    "a folga e SO pro digito 9 — um 8 enfiado no lugar nao casa"
  );
  eq(mesmoNumero("351912345678", "35112345678"), false, "a folga vale so pro Brasil (DDI 55)");
  eq(mesmoNumero(null, "5511912345678"), false, "numero ausente nunca 'e o mesmo' (fail-closed)");
  eq(mesmoNumero("", ""), false, "dois vazios tambem nao sao o mesmo numero");

  eq(formatarNumero("5511912345678"), "+55 11 91234-5678", "celular brasileiro sai legivel");
  eq(formatarNumero("551133334444"), "+55 11 3333-4444", "fixo de 12 digitos tambem");
  eq(formatarNumero("447911123456"), "+447911123456", "numero de fora sai com o DDI, sem inventar formato");
  eq(formatarNumero(null), "—", "sem numero, um travessao — nunca 'undefined' na tela");

  eq(mascararInstancia("AAAA1111BBBB2222CCCC3333"), "AAAA…3333", "instancia sai MASCARADA pra tela");
  eq(mascararInstancia(""), "—", "sem instancia, travessao");
  eq(mascararInstancia("abc"), "ab…", "instancia curta nao vira mascara que revela tudo");
}

// ========================================= C) O ESTADO DO PROVEDOR
{
  const ok = estadoZapi({ connected: true, smartphoneConnected: true }, { phone: "5511912345678" });
  eq(ok.situacao, "conectado", "connected+smartphone = conectado");
  eq(ok.conectado, true, "e conta como conectado");
  eq(ok.numero, "5511912345678", "o numero vem do /device");

  const semCel = estadoZapi({ connected: true, smartphoneConnected: false }, null);
  eq(semCel.situacao, "sem_celular", "celular fora do ar tem situacao propria");
  eq(semCel.conectado, true, "e ainda conta como conectado (a instancia esta com o chip)");
  tem(semCel.detalhe, /celular/, "e a frase diz pra abrir o WhatsApp no aparelho");

  const semCampo = estadoZapi({ connected: true }, { phone: "5511912345678" });
  eq(
    semCampo.situacao,
    "conectado",
    "smartphoneConnected AUSENTE nao inventa aviso (so `false` explicito vira aviso)"
  );

  eq(estadoZapi({ connected: false }, null).situacao, "desconectado", "connected:false = leia o QR");

  // `error` vence `connected`: instancia com problema manda os dois no mesmo
  // corpo, e ler so o `connected` mandaria o cliente escanear um codigo inutil
  const comErro = estadoZapi({ connected: false, error: "You are already connected" }, null);
  eq(comErro.situacao, "erro", "erro do provedor tem prioridade sobre connected");
  tem(comErro.detalhe, /ja esta conectado/, "e o erro sai traduzido, nao cru");

  eq(estadoZapi(null, null).situacao, "desconhecido", "corpo ilegivel = desconhecido, nao desconectado");
  eq(estadoZapi({}, {}).situacao, "desconhecido", "corpo sem `connected` tambem e desconhecido");
  eq(estadoDesconhecido("rede caiu").conectado, false, "desconhecido nunca conta como conectado");
  tem(estadoDesconhecido("rede caiu").detalhe, /rede caiu/, "o motivo de quem chamou aparece na frase");

  tem(traduzirErroZapi("Instance not found"), /nao existe mais/, "instancia inexistente sai explicada");
  tem(traduzirErroZapi("invalid token"), /credencial/, "token invalido aponta pra configuracao da instalacao");
  tem(traduzirErroZapi("Boom 500 xyz"), /Boom 500 xyz/, "erro desconhecido leva o texto CURTO pro suporte");
  eq(traduzirErroZapi("").length > 0, true, "erro vazio ainda produz frase (nunca string vazia na tela)");
}

// ======================================================= D) A TROCA
{
  // as duas guardas do card
  dep(validarTroca({ numero_novo: "5511912345678", consentimento: true }), [], "numero valido + consentimento = ok");
  eq(
    validarTroca({ numero_novo: "5511912345678", consentimento: false }).some((e) => e.campo === "consentimento"),
    true,
    "sem consentimento marcado, a troca NAO abre"
  );
  eq(
    validarTroca({ numero_novo: "5511912345678" }).some((e) => e.campo === "consentimento"),
    true,
    "consentimento ausente conta como nao marcado (fail-closed)"
  );
  eq(
    validarTroca({ numero_novo: "119", consentimento: true }).some((e) => e.campo === "numero_novo"),
    true,
    "numero invalido nao abre troca"
  );
  eq(
    validarTroca({ numero_novo: "5511912345678", consentimento: true, numero_atual: "551112345678" }).length,
    1,
    "trocar pro MESMO numero (com/sem o 9) e recusado — pendencia que nunca conclui"
  );

  const pend: TrocaPendente = {
    numero_novo: "5511988887777",
    numero_anterior: "5511912345678",
    iniciada_em: T0.toISOString(),
    iniciada_por: "u1",
    iniciada_por_nome: "Ana",
  };

  dep(
    vereditoDaTroca(null, estadoZapi({ connected: true }, { phone: "5511988887777" })),
    { acao: "nada", aviso: null },
    "sem pendencia, nada a fazer"
  );

  const aguardando = vereditoDaTroca(pend, estadoZapi({ connected: false }, null));
  eq(aguardando.acao, "aguardar", "chip novo ainda nao conectou: aguardar");
  tem(aguardando.aviso, /91?[0-9]/, "e o aviso mostra o numero que a pessoa tem que conectar");

  const semNumero = vereditoDaTroca(pend, estadoZapi({ connected: true }, {}));
  eq(
    semNumero.acao,
    "aguardar",
    "conectou mas o provedor nao disse o numero: NAO conclui (concluir no escuro gravaria palpite)"
  );

  const divergente = vereditoDaTroca(pend, estadoZapi({ connected: true }, { phone: "5511777776666" }));
  eq(divergente.acao, "divergente", "chip DIFERENTE do declarado nao conclui — criterio de aceite do card");
  tem(divergente.aviso, /NAO foi concluida/, "e o usuario e avisado, com as palavras claras");
  tem(divergente.aviso, /77777-6666/, "o aviso mostra o numero que conectou");
  tem(divergente.aviso, /98888-7777/, "e o numero que era esperado — os DOIS, pra a pessoa entender o erro");

  const concluir = vereditoDaTroca(pend, estadoZapi({ connected: true }, { phone: "5511988887777" }));
  eq(concluir.acao, "concluir", "chip certo conectado: conclui sozinho (o usuario nao clica em confirmar)");
  eq((concluir as any).numero, "5511988887777", "e devolve o numero normalizado pra gravar");

  // e a tolerancia do nono digito TAMBEM vale na conclusao: o cliente declarou
  // com o 9, o provedor devolveu sem (ou o contrario) — e o mesmo chip
  const comNove = vereditoDaTroca(
    { ...pend, numero_novo: "5511988887777" },
    estadoZapi({ connected: true }, { phone: "551188887777" })
  );
  eq(comNove.acao, "concluir", "declarado com 9 e conectado sem 9 = mesmo chip, conclui");

  const trocaTorta = vereditoDaTroca({ ...pend, numero_novo: "abc" } as any, estadoZapi({ connected: true }, {}));
  eq(trocaTorta.acao, "nada", "pendencia com numero ilegivel nao e pendencia (nada pra comparar)");
}

// ======================================== D2) A TRILHA DO CANAL
{
  tem(
    descreverEvento({ tipo: "troca_iniciada", de: "5511912345678", para: "5511988887777", autor_nome: "Ana" }),
    /Ana abriu a troca de .* para /,
    "a linha da trilha diz QUEM, DE onde e PARA onde — o criterio do card"
  );
  tem(
    descreverEvento({ tipo: "troca_concluida", de: "5511912345678", para: "5511988887777" }),
    /troca concluida/,
    "a conclusao aparece na trilha mesmo sem autor (foi o painel que carimbou)"
  );
  tem(
    descreverEvento({ tipo: "troca_iniciada", para: "5511988887777", autor_nome: "Ana" }),
    /abriu a conexao/,
    "primeira conexao (sem numero anterior) nao e descrita como 'troca de nada'"
  );
  tem(descreverEvento({ tipo: "desconectado", autor_nome: "" }), /alguem desconectou/, "sem autor, 'alguem'");
  tem(
    descreverEvento({ tipo: "templates_sincronizados", autor_nome: "Ana", detalhe: { quantidade: 12 } }),
    /12 no provedor/,
    "o sync de template conta quantos vieram"
  );
  tem(
    descreverEvento({ tipo: "tipo_que_nao_existe_ainda", autor_nome: "Ana" }),
    /Ana: tipo_que_nao_existe_ainda/,
    "tipo desconhecido sai LEGIVEL — trilha que esconde linha que nao entende mente por omissao"
  );
}

// =============================== D3) O QUE CABE A CADA FONTE
{
  eq(conexaoDaFonte("zapi").pode, true, "numero Z-API conecta por QR aqui");
  eq(conexaoDaFonte("gupshup").pode, false, "numero de API Oficial NAO tem QR");
  tem((conexaoDaFonte("gupshup") as any).motivo, /Meta/, "e a frase explica por que (homologacao junto da Meta)");
  eq(conexaoDaFonte("evolution").pode, false, "Evolution nao esta cabeado nesta frente");
  tem((conexaoDaFonte("evolution") as any).motivo, /ainda nao/, "e isso e DECLARADO, nao escondido");
  eq(conexaoDaFonte("instagram-agent").pode, false, "canal de fonte externa e somente leitura");
  eq(conexaoDaFonte("fonte_que_nao_existe").pode, false, "fonte desconhecida: fail-closed");

  dep(
    [...ACOES_CONEXAO],
    ["estado", "qr", "codigo", "desconectar", "reiniciar"],
    "a lista de acoes e FECHADA (sem ela, `acao` seria string livre num switch)"
  );
  eq(ehAcaoConexao("qr"), true, "acao conhecida passa");
  eq(ehAcaoConexao("apagar_tudo"), false, "acao inventada nao passa");
  eq(acaoMuda("estado"), false, "`estado` nao mexe no provedor...");
  eq(acaoMuda("desconectar"), true, "...mas desconectar mexe");
  eq(
    INTERVALO_ACAO.codigo > INTERVALO_ACAO.qr,
    true,
    "o codigo de 8 digitos tem respiro MAIOR que o QR: cada pedido acende notificacao no celular do cliente e invalida o codigo anterior"
  );
  // ——— o piso do `estado`: > 0 (a revisao cega mediu 1.028 chamadas/h) e, ao mesmo
  // tempo, abaixo da cadencia da tela — passar do piso responde 429, e um 429 no
  // caminho felz pintaria erro vermelho num numero que esta perfeito.
  eq(INTERVALO_ACAO.estado > 0, true, "o polling de estado TEM piso: sem ele, uma aba aberta e 1.000+ chamadas/h ao provedor");
  const cadenciaEstado = Number(
    /timer = setTimeout\(rodar, modoRef\.current \? (\d+)/.exec(TELA)?.[1] ?? 0
  );
  eq(cadenciaEstado > 0, true, "a cadencia do polling de ESTADO foi encontrada na tela");
  eq(
    INTERVALO_ACAO.estado < cadenciaEstado,
    true,
    `o piso (${INTERVALO_ACAO.estado}ms) fica ABAIXO da cadencia da tela (${cadenciaEstado}ms) — se o loop acelerar, o piso desce junto`
  );
  eq(
    INTERVALO_ACAO.estado < INTERVALO_ACAO.qr,
    true,
    "e abaixo do piso do QR: observar e barato, pedir pareamento nao"
  );
  // e a tela ENGOLE o 429 desta acao em vez de pintar vermelho (duas abas no mesmo
  // canal podem, por azar de fase, cair dentro do mesmo segundo)
  // a tela NAO pinta vermelho no 429 do piso — ela conta (D5) e segue com o ultimo
  // estado conhecido. O `else setErro` prova que so o 429 escapa do vermelho.
  tem(
    TELA,
    /if \(e\?\.status === 429\) setSemAtualizar\(\(n\) => n \+ 1\);\s*\n\s*else setErro\(/,
    "no polling de estado, 429 vira contador e QUALQUER outro erro vira vermelho"
  );
}

// ================================== D2) A TELA: cadencia do QR e o chip trocado
//
// Duas coisas que a revisao cega apontou e que SO existem na tela — e que, se
// alguem "simplificar" o componente, voltam a ser o bug de origem.
{
  // ——— item 13: o QR NAO pode ser pedido em intervalo fixo. Pedir invalida o
  // anterior, entao polling cego a 4s mata 4 de cada 5 codigos que a pessoa ve.
  tem(TELA, /deveRenovarQr\(/, "a tela decide renovar o QR pela funcao pura, nao por intervalo fixo");
  eq(
    /setTimeout\(rodar, 4000\)/.test(TELA),
    false,
    "e nao sobrou o polling cego de 4s (era ele que invalidava o QR debaixo da camera do cliente)"
  );
  // a MESMA funcao pura que escreve a frase de idade decide o pedido — duas
  // respostas pra "este QR ainda vale?" divergiriam sozinhas
  tem(TELA, /qrExpirado\(/, "e a frase de idade continua saindo da mesma familia de funcoes puras");

  // ——— item 8: chip trocado FORA do fluxo de troca aparece em DESTAQUE.
  // Antes disso o numero do canal era reescrito em silencio: a unica pista era o
  // campo mudando sozinho no rodape.
  tem(TELA, /numero_trocado_sem_troca/, "a tela recebe o aviso de chip trocado fora do fluxo");
  tem(TELA, /FORA do fluxo de troca/, "e diz isso com essas palavras, em destaque proprio");
  tem(
    TELA,
    /trocaSelvagem\.de \?/,
    "o aviso usa o numero ANTIGO (`de`) — 'mudou' sem dizer de onde nao ajuda quem opera"
  );
}

// ================================== E) STATUS DO TEMPLATE
{
  eq(statusCanonico("APPROVED"), "aprovado", "APPROVED = aprovado");
  eq(statusCanonico("PENDING"), "em_analise", "PENDING = em analise");
  eq(statusCanonico("IN_APPEAL"), "em_analise", "recurso tambem e analise");
  eq(statusCanonico("REJECTED"), "recusado", "REJECTED = recusado");
  eq(statusCanonico("PAUSED"), "pausado", "PAUSED = pausado");
  eq(statusCanonico("ALGO_NOVO_DA_META"), "desconhecido", "status novo cai em desconhecido (fail-closed)");
  eq(statusCanonico(null), "desconhecido", "status ausente = desconhecido");

  // OS DOIS SANEADORES NAO SAO INTERCAMBIAVEIS. Trocar um pelo outro apagaria a
  // aprovacao de TODO template do catalogo, e todo envio por template da
  // instalacao passaria a ser recusado.
  eq(statusCanonico("aprovado"), "desconhecido", "o saneador de ENTRADA nao entende o vocabulario do banco...");
  eq(statusDoBanco("aprovado"), "aprovado", "...e o de SAIDA entende");
  eq(statusDoBanco("APROVADO"), "aprovado", "o de saida tolera caixa alta");
  eq(statusDoBanco("qualquer_coisa"), "desconhecido", "valor gravado a mao fora da lista = desconhecido");
  eq(STATUS_TEMPLATE.every((s) => !!ROTULO_STATUS[s]), true, "todo status tem rotulo de tela (nenhum sai cru)");
}

// ============================= E2) QUEM PODE ENVIAR
{
  const base: TemplateCanal = {
    provider_id: "tpl-1",
    nome: "aviso_agenda",
    idioma: "pt_BR",
    categoria: "UTILITY",
    status: "aprovado",
    corpo: "Ola {{1}}, sua consulta e dia {{2}}. Ate logo!",
    exemplo: "Ola Maria, sua consulta e dia 10/08. Ate logo!",
    variaveis: 2,
    rodape: "",
    cabecalho: "TEXT",
    midia_url: "",
    motivo: "",
  };

  eq(podeEnviarTemplate(base).ok, true, "template aprovado envia");
  eq(podeEnviarTemplate(null).ok, false, "template fora do catalogo do canal NAO envia");
  tem((podeEnviarTemplate(null) as any).motivo, /sincronize/, "e a frase diz o que fazer");
  eq(podeEnviarTemplate({ ...base, status: "em_analise" }).ok, false, "em analise NAO envia");
  tem(
    (podeEnviarTemplate({ ...base, status: "em_analise" }) as any).motivo,
    /aprovacao/,
    "e a frase e compreensivel (criterio do card)"
  );
  eq(podeEnviarTemplate({ ...base, status: "recusado" }).ok, false, "recusado NAO envia");
  tem(
    (podeEnviarTemplate({ ...base, status: "recusado", motivo: "texto promocional" }) as any).motivo,
    /texto promocional/,
    "e o motivo da Meta aparece, pra dar o que consertar"
  );
  eq(podeEnviarTemplate({ ...base, status: "pausado" }).ok, false, "pausado NAO envia");
  eq(
    podeEnviarTemplate({ ...base, status: "desconhecido" }).ok,
    false,
    "DESCONHECIDO nao envia — status novo da Meta nunca vira permissao por descuido"
  );
  eq(
    podeEnviarTemplate({ ...base, provider_id: "" }).ok,
    false,
    "template sem id no provedor nao envia (o nome nao serve pra enviar)"
  );

  // parametros
  dep(validarParametros(base, ["Maria", "10/08"]), { ok: true, params: ["Maria", "10/08"] }, "2 variaveis, 2 valores");
  eq(validarParametros(base, ["Maria"]).ok, false, "parametro a MENOS: a Meta recusaria");
  eq(
    validarParametros(base, ["Maria", "10/08", "sobra"]).ok,
    false,
    "parametro a MAIS: a Meta ignora em silencio e a mensagem sai errada — barrar aqui"
  );
  eq(validarParametros(base, ["Maria", "  "]).ok, false, "valor em branco nao passa");
  eq(validarParametros(base, ["Maria", "10/08\nnova linha"]).ok, false, "quebra de linha em parametro a Meta recusa");
  // "TEMPLATE SEM VARIAVEL" AGORA E UM TEMPLATE SEM VARIAVEL — a intencao das duas
  // asseracoes nao mudou (nenhuma variavel: lista vazia passa, parametro sobrando
  // nao), mudou a FIXTURE. Antes elas zeravam a coluna `variaveis` e deixavam o
  // `corpo` com {{1}} e {{2}} dentro, ou seja: a propria prova montava o estado
  // impossivel que a Frente Z veio fechar (a coluna dizendo uma coisa e o texto
  // que vai ser renderizado dizendo outra). Com a contagem saindo do corpo, esse
  // fixture pediria 2 parametros — e teria virado argumento pra afrouxar a guarda
  // nova, que e exatamente o que nao se faz.
  const semVar: TemplateCanal = { ...base, nome: "recibo_pronto", corpo: "Seu recibo esta pronto.", variaveis: 0 };
  eq(validarParametros(semVar, []).ok, true, "template sem variavel aceita lista vazia");
  eq(validarParametros(semVar, ["x"]).ok, false, "e recusa parametro que nao existe no template");

  eq(
    renderizarTemplate(base.corpo, ["Maria", "10/08"]),
    "Ola Maria, sua consulta e dia 10/08. Ate logo!",
    "o texto gravado na conversa e o que o cliente LE"
  );
  eq(
    renderizarTemplate(base.corpo, ["Maria"]),
    "Ola Maria, sua consulta e dia {{2}}. Ate logo!",
    "faltando valor, a variavel fica visivel (nunca some silenciosamente)"
  );
}

// ================== F) VALIDACAO DE CRIACAO (portada do Meeting Hub)
{
  const bom = {
    nome: "aviso_agenda",
    categoria: "UTILITY" as const,
    assunto: "agenda",
    corpo: "Ola {{1}}, sua consulta e dia {{2}}. Ate logo!",
    exemplo: "Ola Maria, sua consulta e dia 10/08. Ate logo!",
    idioma: "pt_BR",
    botoes: [],
  };
  dep(validarNovoTemplate(bom), [], "template bem formado passa");

  tem(validarNovoTemplate({ ...bom, nome: "Aviso Agenda" })[0], /minusculas/, "nome com espaco/maiuscula e recusado");
  tem(validarNovoTemplate({ ...bom, nome: "" })[0], /De um nome/, "sem nome, recusa");
  tem(validarNovoTemplate({ ...bom, categoria: "OUTRA" as any })[0], /categoria/, "categoria fora da lista e recusada");
  tem(validarNovoTemplate({ ...bom, assunto: "" })[0], /assunto/, "sem assunto interno, o Gupshup recusa");
  tem(validarNovoTemplate({ ...bom, corpo: "" })[0], /corpo/, "sem corpo, recusa");
  tem(validarNovoTemplate({ ...bom, corpo: "a".repeat(1100) })[0], /1024/, "corpo acima do teto da Meta");

  // as duas regras que a Meta reprova e que o usuario violava sem perceber
  eq(
    validarNovoTemplate({ ...bom, corpo: "{{1}} tudo bem?", exemplo: "Maria tudo bem?" }).some((e) => /COMECAR/.test(e)),
    true,
    "mensagem nao pode COMECAR com variavel"
  );
  eq(
    validarNovoTemplate({ ...bom, corpo: "Ola, {{1}}", exemplo: "Ola, Maria" }).some((e) => /TERMINAR/.test(e)),
    true,
    "nem TERMINAR com variavel"
  );
  eq(
    validarNovoTemplate({ ...bom, corpo: "Ola {{1}} e {{3}}, ate logo", exemplo: "Ola A e B, ate logo" }).some((e) =>
      /sequencia/.test(e)
    ),
    true,
    "numeracao com buraco ({{1}} e {{3}}) nao casa os parametros no envio"
  );
  eq(
    validarNovoTemplate({ ...bom, exemplo: "" }).some((e) => /exemplo/.test(e)),
    true,
    "corpo com variavel exige exemplo (e o que a Meta LE pra entender o template)"
  );
  eq(
    validarNovoTemplate({ ...bom, exemplo: "Ola {{1}}, sua consulta e dia {{2}}." }).some((e) => /\{\{1\}\}/.test(e)),
    true,
    "exemplo com variavel crua e recusado"
  );
  eq(
    validarNovoTemplate({ ...bom, exemplo: "Texto que nao tem nada a ver" }).some((e) => /nao bate/.test(e)),
    true,
    "exemplo incompativel com o corpo era a unica regra que passava sem aviso"
  );

  tem(
    validarNovoTemplate({ ...bom, rodape: "a".repeat(70) })[0],
    /rodape/,
    "rodape acima de 60 caracteres a Meta recusa"
  );
  eq(
    validarNovoTemplate({ ...bom, rodape: "responda {{1}}" }).some((e) => /rodape/.test(e)),
    true,
    "variavel no rodape e recusada no envio"
  );
  eq(
    validarNovoTemplate({
      ...bom,
      botoes: [
        { type: "URL", text: "Ir", url: "nao-e-url" },
      ],
    }).some((e) => /URL/.test(e)),
    true,
    "botao de URL sem http e recusado"
  );
  eq(
    validarNovoTemplate({
      ...bom,
      botoes: [
        { type: "QUICK_REPLY", text: "a" },
        { type: "QUICK_REPLY", text: "b" },
        { type: "QUICK_REPLY", text: "c" },
        { type: "QUICK_REPLY", text: "d" },
      ],
    }).some((e) => /3 botoes/.test(e)),
    true,
    "no maximo 3 botoes"
  );

  dep(
    botoesValidos([{ type: "URL", text: "Ir", url: "https://x" }, { type: "ESTRANHO", text: "?" }, { text: "" }]),
    [{ type: "URL", text: "Ir", url: "https://x" }],
    "botao em formato desconhecido e DESCARTADO, nao derruba o cadastro"
  );
  eq(botoesValidos("nao e lista").length, 0, "botoes que nao sao lista viram lista vazia");

  eq(contarVariaveis("Ola {{1}}, dia {{2}} e de novo {{1}}"), 2, "conta variaveis DISTINTAS");
  dep(variaveisDoCorpo("{{2}} e {{1}}"), [1, 2], "e devolve os numeros ordenados");
  eq(exemploBate("Ola {{1}}, tudo bem?", "Ola Maria, tudo bem?"), true, "os trechos fixos aparecem no exemplo");
  eq(exemploBate("Ola {{1}}, tudo bem?", "Oi Maria, beleza?"), false, "exemplo com outro texto nao bate");
  tem(sugerirExemplo("Ola {{1}}"), /Ola Maria/, "a sugestao de exemplo troca a variavel por um valor real");
}

// ================================ G) O CORPO E A RESPOSTA DO ENVIO
{
  const cfg = { source: "5511955554444", appName: "MeuApp" };
  const texto: TemplateCanal = {
    provider_id: "tpl-1",
    nome: "t",
    idioma: "pt_BR",
    categoria: "UTILITY",
    status: "aprovado",
    corpo: "Ola {{1}}",
    exemplo: "",
    variaveis: 1,
    rodape: "",
    cabecalho: "TEXT",
    midia_url: "",
    motivo: "",
  };
  const f = corpoEnvioTemplate(cfg, "5511999998888", texto, ["Maria"]);
  eq(f.get("channel"), "whatsapp", "canal fixo");
  eq(f.get("source"), cfg.source, "o remetente e o numero DO CANAL");
  eq(f.get("destination"), "5511999998888", "o destino vai como digitos");
  eq(f.get("src.name"), "MeuApp", "src.name vai quando a conta tem app name");
  dep(JSON.parse(f.get("template")!), { id: "tpl-1", params: ["Maria"] }, "o template vai por ID, com os params");
  eq(
    f.get("message"),
    null,
    "template de TEXTO vai SEM `message` — mandar message de imagem aqui faz a Meta recusar o envio inteiro"
  );

  // o gotcha que custou horas: template de IMAGEM sem o link volta 202 e a Meta
  // DROPA a entrega em silencio
  const imagem = { ...texto, cabecalho: "IMAGE", midia_url: "https://exemplo/arte.png" };
  const fi = corpoEnvioTemplate(cfg, "5511999998888", imagem, ["Maria"]);
  dep(
    JSON.parse(fi.get("message")!),
    { type: "image", image: { link: "https://exemplo/arte.png" } },
    "template de IMAGEM leva o link da arte — sem ele o 202 e mentira"
  );
  eq(
    corpoEnvioTemplate(cfg, "5511999998888", { ...imagem, midia_url: "" }, ["Maria"]).get("message"),
    null,
    "cabecalho de imagem SEM arte nao inventa message (a validacao e do cadastro, nao do envio)"
  );
  eq(
    corpoEnvioTemplate({ source: "1", appName: "" }, "5511999998888", texto, ["x"]).get("src.name"),
    null,
    "conta sem app name nao manda src.name vazio"
  );

  dep(lerRespostaEnvio(202, { messageId: "abc" }), { ok: true, messageId: "abc" }, "202 COM messageId = enviado");
  eq(
    lerRespostaEnvio(202, {}).ok,
    false,
    "202 SEM messageId e FALHA — contar como sucesso ja fez relatorio de campanha mentir"
  );
  tem((lerRespostaEnvio(202, {}) as any).motivo, /fila/, "e a frase explica que ficou na fila, sem virar mensagem");
  eq(lerRespostaEnvio(400, { message: "template not found" }).ok, false, "4xx e falha");
  tem((lerRespostaEnvio(400, { message: "template not found" }) as any).motivo, /template not found/, "com o motivo");
}

// ============================== H) LEITURA DO TEMPLATE CRU
{
  // O GOTCHA: `data` do TOPO nao e o corpo — e uma serializacao do template
  // inteiro, com rodape e botoes colados. O corpo LIMPO mora em containerMeta.
  const cru = {
    id: "tpl-9",
    elementName: "aula_convite",
    status: "APPROVED",
    category: "MARKETING",
    languageCode: "pt_BR",
    templateType: "TEXT",
    data: "Oi {{1}}, garanta sua vaga.\nPra sair, responda SAIR | [Garantir minha vaga,https://exemplo/x]",
    containerMeta: JSON.stringify({
      data: "Oi {{1}}, garanta sua vaga.",
      footer: "Pra sair, responda SAIR",
      sampleText: "Oi Maria, garanta sua vaga.",
      buttons: [{ type: "URL", text: "Garantir minha vaga", url: "https://exemplo/x" }],
    }),
  };
  const t = lerTemplateGupshup(cru);
  eq(t.corpo, "Oi {{1}}, garanta sua vaga.", "o corpo vem de containerMeta.data, LIMPO");
  eq(t.corpo.includes("|"), false, "e sem o markup cru dos botoes — 14 de 104 templates exibiam isso em producao");
  eq(t.rodape, "Pra sair, responda SAIR", "o rodape vem do campo proprio");
  eq(t.exemplo, "Oi Maria, garanta sua vaga.", "o exemplo tambem");
  eq(t.status, "aprovado", "o status vem traduzido");
  eq(t.variaveis, 1, "e as variaveis sao contadas do corpo LIMPO");
  eq(t.provider_id, "tpl-9", "o id do provedor e o que vai no envio");
  eq(t.nome, "aula_convite", "o nome e o elementName");

  // formato antigo, sem containerMeta: o `data` do topo entra como ultimo recurso
  const antigo = lerTemplateGupshup({ id: "x", elementName: "velho", status: "PENDING", data: "Texto simples" });
  eq(antigo.corpo, "Texto simples", "sem containerMeta, o data do topo e o ultimo recurso");
  eq(antigo.status, "em_analise", "e o status segue traduzido");

  // containerMeta corrompido nao derruba a listagem
  const torto = lerTemplateGupshup({ id: "y", elementName: "torto", status: "APPROVED", containerMeta: "{nao e json" });
  eq(torto.corpo, "", "containerMeta ilegivel sai com corpo vazio, sem estourar");
  eq(torto.nome, "torto", "e o resto do template continua legivel");

  const img = lerTemplateGupshup({
    id: "z",
    elementName: "arte",
    status: "APPROVED",
    templateType: "IMAGE",
    containerMeta: JSON.stringify({ data: "Olha isso {{1}}!", mediaUrl: "https://exemplo/a.png", mediaId: "h1" }),
  });
  eq(img.cabecalho, "IMAGE", "cabecalho de imagem e reconhecido");
  eq(img.midia_url, "https://exemplo/a.png", "e a arte aprovada vem junto (obrigatoria no envio)");
  eq(lerTemplateGupshup(null).nome, "", "template nulo nao estoura");

  // saldo: melhor-esforco, fracasso MUDO
  eq(lerSaldo({ walletResponse: { currentBalance: 12.5, currency: "usd" } }).valor, 12.5, "le o saldo da carteira");
  eq(lerSaldo({ walletResponse: { currentBalance: 12.5, currency: "usd" } }).moeda, "USD", "moeda em caixa alta");
  eq(lerSaldo({ currentBalance: "9" }).valor, 9, "aceita o corpo sem o envelope");
  eq(lerSaldo(null).disponivel, false, "sem resposta, saldo indisponivel");
  tem(lerSaldo(null).aviso, /indisponivel/, "e a tela diz isso em vez de mostrar erro");
  eq(lerSaldo({ walletResponse: {} }).disponivel, false, "corpo sem numero legivel tambem e indisponivel");
}

// ========================= I) VARREDURA: as rotas novas no mapa de escopo
//
// Medida no proprio codigo, nao redigida: e o mesmo espirito das varreduras B.9 e
// B.10 de `prova-seguranca-conta.ts`. Aqui o alvo e estreito — as rotas desta
// frente — porque a varredura geral do repo ja roda naquela prova, e o que esta
// frente precisa travar e a DECISAO dela: `/api/canais/*` tem verbete de recurso
// (senao chave com `recursos` declarados nao alcancaria a feature nova) e NAO
// assume canal padrao (senao uma chave restrita a um numero alcancaria o outro
// por OMISSAO do parametro).
{
  const raiz = "app/api/canais";
  const rotas: string[] = [];
  const varrer = (dir: string, prefixo: string) => {
    for (const nome of readdirSync(dir)) {
      const cheio = join(dir, nome);
      if (statSync(cheio).isDirectory()) varrer(cheio, `${prefixo}/${nome}`);
      else if (nome === "route.ts") rotas.push(prefixo);
    }
  };
  let varreu = true;
  try {
    varrer(raiz, "/api/canais");
  } catch {
    varreu = false; // rodou de outro diretorio
  }

  if (varreu) {
    eq(rotas.length >= 3, true, `a varredura achou as rotas de canal (${rotas.length})`);

    const semVerbete = rotas.filter((r) => recursoDaRota(r) === null);
    dep(semVerbete, [], `toda rota de canal tem recurso no mapa — sem verbete: ${semVerbete.join(", ")}`);
    for (const r of rotas) {
      eq(recursoDaRota(r), "canais", `${r} responde pelo recurso 'canais'`);
    }

    // e NENHUMA delas assume canal padrao
    const declaradas = new Set(CANAL_PADRAO_EM.map(([p]) => p));
    const indevidas = rotas.filter((r) => declaradas.has(r) || declaradas.has("/api/canais"));
    dep(
      indevidas,
      [],
      "rota de canal NAO pode assumir canal padrao (o `?canal=` e obrigatorio; default seria mexer no numero errado)"
    );

    // e nenhuma delas resolve canal pelo helper de default, que e o que a
    // varredura B.10 da outra prova cobraria na tabela
    for (const r of rotas) {
      const src = readFileSync(join("app", r.replace(/^\/api\//, "api/"), "route.ts"), "utf8");
      eq(
        /\bcanalDeBody\b|\bcanalDe\b\s*\(/.test(src),
        false,
        `${r} nao usa o resolvedor com default 'central' — canal explicito, sempre`
      );
    }

    // ——— A PORTA E UMA SO, E TODAS PASSAM POR ELA.
    //
    // Isto e o item que a revisao cega classificou como GRAVE: as tres rotas
    // nasceram com a porta COPIADA e as tres esqueceram a MESMA coisa — a
    // restricao de canal do usuario (`usuario_restricoes`). Quem tinha a permissao
    // mas estava recortado a um numero DESCONECTAVA o outro; e o indice ja
    // filtrava por `canalPermitido`, entao o numero nem aparecia na tela — o
    // recorte parecia valer e nao valia. Fail-closed na listagem virando fail-open
    // na operacao e o pior arranjo possivel.
    //
    // A varredura cobra a porta COMPARTILHADA em vez de procurar `canalPermitido`
    // em cada arquivo: se cada rota fizesse a sua checagem, a proxima rota de canal
    // herdaria o esquecimento de novo. Um lugar so, e a prova aponta pra ele.
    for (const r of rotas) {
      const src = readFileSync(join("app", r.replace(/^\/api\//, "api/"), "route.ts"), "utf8");
      if (r === "/api/canais") {
        // o INDICE nao opera um numero: ele LISTA, e filtra a lista pelo recorte.
        // Excecao NOMEADA, pra ninguem acrescentar a segunda calada.
        eq(/\bcanalPermitido\b/.test(src), true, "o indice filtra a lista por canalPermitido");
        continue;
      }
      eq(
        /\bportaDoCanal\s*\(/.test(src),
        true,
        `${r} passa pela porta COMPARTILHADA (lib/canais-porta.ts) — porta copiada e porta que divergiu`
      );
      eq(
        /\bgetUser\s*\(/.test(src),
        false,
        `${r} nao autentica por conta propria (quem faz isso e a porta, com o recorte de canal)`
      );
      // e o nivel e declarado explicitamente em cada handler
      tem(src, /"(ler|operar)"/, `${r} declara o nivel de permissao de cada handler`);
    }

    // A porta em si: as cinco camadas na ordem, e a de restricao presente.
    const porta = readFileSync(join("lib", "canais-porta.ts"), "utf8");
    eq(/\bcanalPermitido\s*\(/.test(porta), true, "a porta consulta canalPermitido (o furo GRAVE)");
    eq(/\brestricaoDeConversas\s*\(/.test(porta), true, "e le a restricao do usuario pra isso");
    eq(/\bcanalObrigatorio\s*\(/.test(porta), true, "e a guarda do `?canal=` e a funcao pura, nao um comentario");
    const iPerm = porta.indexOf("canalPermitido(");
    const iCanal = porta.indexOf("canalObrigatorio(");
    eq(iCanal > -1 && iPerm > iCanal, true, "o recorte e conferido DEPOIS de resolver qual canal e (ordem das camadas)");
    // as duas permissoes, e nao uma
    tem(porta, /gerenciar_canais/, "nivel `ler` usa gerenciar_canais");
    tem(porta, /conectar_numero/, "nivel `operar` usa conectar_numero");

    // ——— O 415 VEM ANTES DA LEITURA DO CORPO (GRAVE da 3a revisao cega).
    //
    // A porta parseava o corpo sem conferir content-type, enquanto `canalDoPedido`
    // (a porta da CHAVE) so olhava o corpo quando o header dizia JSON. Duas leituras
    // DISCORDANTES do mesmo corpo: `curl -d` com JSON valido e content-type de
    // formulario dava canal `null` no escopo — que nao comparava nada — e canal REAL
    // na rota. Chave escopada a um numero operando o outro, so por um header.
    //
    // A DECISAO e pura (`corpoJsonObrigatorio`) e e exercitada onde a historia
    // inteira mora — bloco B.13 de `prova-seguranca-conta.ts`, junto do header
    // hostil e do escopo da chave. O que se mede AQUI e a COSTURA e a ORDEM: se a
    // chamada cair pra depois do `req.json()`, o corpo ja foi lido e a guarda nao
    // guarda nada.
    // a medicao e DENTRO de portaDoCorpo: `portaDoCanal` tambem chama `getUser`, e
    // medir no arquivo inteiro passaria verde com a guarda no lugar errado
    const iFn = porta.indexOf("export async function portaDoCorpo");
    eq(iFn > -1, true, "achei portaDoCorpo no fonte da porta");
    const comCorpo = porta.slice(iFn);
    eq(
      /\bcorpoJsonObrigatorio\s*\(/.test(comCorpo),
      true,
      "portaDoCorpo exige que o corpo se declare JSON (415), pela funcao pura"
    );
    const i415 = comCorpo.indexOf("corpoJsonObrigatorio(");
    const iLer = comCorpo.indexOf("req.json(");
    eq(
      i415 > -1 && iLer > i415,
      true,
      "e o 415 e decidido ANTES de ler o corpo — depois seria guarda de enfeite"
    );
    // e DEPOIS da identidade, pra a porta da chave (que clona o corpo) rodar antes:
    // as duas guardas ficam vivas, em vez de o conserto depender de UMA
    const iUser = comCorpo.indexOf("await getUser(");
    eq(
      iUser > -1 && i415 > iUser,
      true,
      "e DEPOIS de getUser: o escopo da chave ja comparou o canal do corpo (as duas guardas vivas)"
    );
  }
}

// ============ J) VARREDURA: o gate do envio por template em /api/send
//
// A regra pura ja esta provada acima; o que este bloco trava e a COSTURA — que a
// rota de envio realmente passe por ela. Medido no fonte, porque o defeito aqui
// nao apareceria em nenhum teste de unidade: bastaria alguem chamar
// `gsEnviarTemplate` direto e o painel mandaria template nao aprovado pela Meta,
// arranhando a nota de qualidade do numero da empresa.
{
  let src = "";
  try {
    src = readFileSync("app/api/send/route.ts", "utf8");
  } catch {
    // rodou de outro diretorio: o resto da prova nao depende deste bloco
  }
  if (src) {
    // CHAMADA, nao mencao: a primeira versao deste bloco procurava o NOME e
    // passava com o gate arrancado, porque o nome sobrevive na linha do `import`.
    // Aparecer na lista de import nao e prova de nada.
    //
    // FRENTE Z — O GATE VIROU UM SO, e por que isso e mais forte e nao menos: os
    // quatro passos sairam dos `if`s da rota pra `decidirEnvioTemplate` (pura), e
    // esta varredura deixou de conferir que a rota MENCIONA duas funcoes pra
    // conferir que ela chama a decisao INTEIRA — cujos quatro passos sao
    // exercitados por COMPORTAMENTO no bloco P, com fixture, em node solto. O que
    // se perdeu foi um grep; o que se ganhou foi o caminho medido (e mais: o tipo
    // do parametro de `enviarTemplateProvado`, que faz o `tsc` recusar o envio nao
    // provado ATE onde ele vai — a tabela medida esta em lib/templates-oficial.ts).
    eq(
      /\bdecidirEnvioTemplate\s*\(/.test(src),
      true,
      "/api/send CHAMA `decidirEnvioTemplate` (mencao no import nao conta)"
    );
    eq(
      /\btemplateDoCanal\s*\(/.test(src),
      true,
      "e busca o template no catalogo DO CANAL (aprovacao e por numero)"
    );
    eq(
      /\bconflitoComTemplate\s*\(/.test(src),
      true,
      "e CHAMA `conflitoComTemplate` (template + texto livre / + pergunta com opcoes = 400)"
    );
    // O TIPO E METADE DA COSTURA: `enviarTemplateProvado` (lib) so aceita
    // `EnvioTemplateProvado` — classe com campo `#privado`, instanciada so por
    // `decidirEnvioTemplate`.
    //
    // ATE ONDE ISSO VAI, medido na 3a revisao cega e re-conferido na 4a
    // (`tsc --strict`, um arquivo por caso, fora do repo): vale pro LITERAL e pro
    // SPREAD, e NAO vale pra `as`, pra uma variavel `any` no meio, pro
    // `Object.assign` sobre o PROTOTIPO nem pro `JSON.parse(JSON.stringify(...))`
    // — todos COMPILAM, os dois ultimos sem escrever `as` em lugar nenhum. **O tipo
    // e sinalizacao, nao fechadura.**
    //
    // O QUE FECHA MUDOU NA 4a REVISAO: o POST do template SAIU desta rota pra
    // `enviarTemplateProvado`, e o que chega ao provedor virou COMPORTAMENTO (bloco
    // P.7, com um `postar` falso). Aqui sobrou a COSTURA — a rota entrega o envio
    // provado e o postador de verdade, e nao monta corpo nenhum.
    //
    // DECLARADO: a asseracao abaixo e VARREDURA DE FONTE e e LOAD-BEARING pra esta
    // costura (uma rota que voltasse a montar o POST na mao sairia do alcance da
    // prova sem ela reclamar). Ela NAO sustenta a regra — a regra e comportamento
    // no bloco P.7. A 4a revisao cega mediu que o pino
    // `enviarTemplateProvado(...tplEnvio, gsEnviarTemplate)` reprovava refatoracao
    // correta (`const postador = gsEnviarTemplate`) e que, sem ele, a mutacao
    // "rota volta a montar o POST na mao" continua morrendo AQUI — entao o pino
    // saiu e esta linha e a costura inteira.
    eq(
      /\bcorpoEnvioTemplate\s*\(/.test(semComentario(src)),
      false,
      "e a rota NAO monta o corpo do POST — ele nasce so na lib, onde a prova alcanca"
    );
    // e `tplEnvio` nao pode nascer de outro lugar: a UNICA atribuicao vem do
    // veredito. Varredura por FORMA (sem comentario), porque a prosa acima cita a
    // forma errada pra explicar a mutacao.
    dep(
      [...semComentario(src).matchAll(/\btplEnvio\s*=\s*([^;]+);/g)].map((m) => m[1].trim()),
      ["decisao.envio"],
      "a unica atribuicao de `tplEnvio` e o veredito da decisao"
    );

    // ——— O DESTINO de `tplEnvio.texto` (MEDIA 3 da 2a revisao cega)
    //
    // O NASCIMENTO de `tplEnvio` ja estava travado pela asseracao acima, e o bloco
    // P prova que `renderizarTemplate` le o corpo igual ao provedor. Faltava o
    // DESTINO — e e ali que o sintoma original volta pela outra ponta. Duas
    // mutacoes independentes passavam com `tsc` e bateria VERDES:
    //
    //   textoEnviar = tplEnvio.alvo.corpo   -> a conversa grava "Ola {{1}}, dia
    //                                          {{2}}." e o cliente le o renderizado
    //   conteudo    = text || tplEnvio.texto -> o preview da lista mostra outra coisa
    //
    // Entao a asseracao e sobre a FORMA do ramo: no caminho do template, os dois
    // so podem vir de `tplEnvio.texto`. Varredura sem comentario, como sempre —
    // esta prosa cita as duas mutacoes, e a prosa nao pode virar a prova.
    const ramoDoTemplate = (nome: string) => {
      const m = semComentario(src).match(
        new RegExp(`\\b(?:const|let)\\s+${nome}\\s*=\\s*tplEnvio\\s*\\?([^:]+):`)
      );
      return m ? m[1].trim() : `(nao existe \`${nome} = tplEnvio ? ...\` na rota)`;
    };
    eq(
      ramoDoTemplate("textoEnviar"),
      "tplEnvio.texto",
      "o texto ENVIADO no ramo do template e `tplEnvio.texto` — nunca o corpo cru do alvo"
    );
    eq(
      ramoDoTemplate("conteudo"),
      "tplEnvio.texto",
      "e o preview gravado na conversa tambem (painel e cliente leem a MESMA coisa)"
    );
    // e o corpo da bolha cai no `textoEnviar` ja provado acima (ultimo ramo do
    // ternario), nao numa terceira leitura do template.
    const gravado = semComentario(src).match(/\bconst\s+conteudoEnviado\s*=([^;]+);/);
    tem(
      (gravado?.[1] ?? "").split(":").pop() ?? "",
      /^\s*textoEnviar\b/,
      "e `conteudoEnviado` cai em `textoEnviar` (uma leitura so, ja provada)"
    );

    // ——— A FIACAO DO PEDIDO E DO CATALOGO (BAIXA 2 da 2a revisao cega)
    //
    // Duas mutacoes passavam verdes nesta varredura, as duas mentindo pro operador:
    //
    //  (a) catalogo FIXO no argumento (`{ disponivel: true, ... }`): mata o 503 e
    //      faz o diagnostico mentir — a tela manda "sincronize os templates" quando
    //      o que faltou foi a 0023 rodar. Por isso o argumento tem que ser a
    //      VARIAVEL lida do banco, e ela tem que vir de `templateDoCanal`.
    //  (b) rota parar de chamar `lerPedidoTemplate`: o nome vai cru pra consulta, e
    //      "Aviso_Agenda " nao acha o `aviso_agenda` do catalogo — 409 falso num
    //      template que existe e esta aprovado.
    const chamada = semComentario(src).match(
      /\bdecidirEnvioTemplate\(\s*([A-Za-z_$][\w$.]*)\s*,\s*([A-Za-z_$][\w$.]*)\s*\)/
    );
    eq(
      !!chamada,
      true,
      "`decidirEnvioTemplate` recebe DUAS variaveis (catalogo fixo escrito no argumento nao passa)"
    );
    const catVar = chamada?.[2] ?? "";
    tem(
      semComentario(src),
      new RegExp(`\\b(?:const|let)\\s+${catVar || "(?!)"}\\s*=\\s*await\\s+templateDoCanal\\(`),
      `e o catalogo (\`${catVar}\`) e o que a rota LEU do banco por \`templateDoCanal\``
    );
    const pedido = semComentario(src).match(/\b(?:const|let)\s+(\w+)\s*=\s*lerPedidoTemplate\(/);
    eq(!!pedido, true, "a rota CHAMA `lerPedidoTemplate` (o nome cru nem pode virar consulta)");
    tem(
      semComentario(src).match(/\btemplateDoCanal\(([^)]*)\)/)?.[1] ?? "",
      new RegExp(`\\b${pedido?.[1] || "(?!)"}\\.nome\\b`),
      "e consulta o catalogo pelo nome SANEADO, nunca pelo que veio no pedido"
    );

    // A ORDEM importa: o gate vem ANTES do envio.
    //
    // A comparacao e contra `await enviarTemplateProvado(` — o disparo DENTRO do
    // handler. Ate a 3a revisao havia um helper `enviarTemplate` declarado no TOPO
    // deste arquivo, e comparar contra `gsEnviarTemplate(` dava falso negativo
    // (posicao de DECLARACAO, nao de execucao). O helper saiu pra lib na 4a; a
    // licao fica: medir a ordem de EXECUCAO, nao a de escrita.
    const iGate = src.indexOf("decidirEnvioTemplate(");
    const iEnvio = src.indexOf("await enviarTemplateProvado(");
    eq(iGate > -1, true, "o gate esta no handler");
    eq(iEnvio > iGate, true, "e o envio do template acontece DEPOIS do gate, nunca antes");

    // e o template NAO pode passar pela assinatura do atendente (a Meta recusa
    // template alterado, e o painel gravaria texto diferente do que o cliente leu).
    // A asseracao e sobre o ARGUMENTO: `textoComAssinatura` so pode receber o
    // `text` do composer. Procurar `tplEnvio` perto da chamada nao servia — um
    // `textoComAssinatura(tplEnvio ? tplEnvio.texto : text)` passava batido.
    const assina = [...src.matchAll(/textoComAssinatura\(([^,]*),/g)].map((m) => m[1].trim());
    dep(
      assina.filter((arg) => arg !== "text"),
      [],
      `textoComAssinatura so recebe o texto do composer — nunca o do template (recebeu: ${assina.join(" | ")})`
    );
    tem(src, /tplEnvio\s*\?\s*\n?\s*tplEnvio\.texto/, "e o texto do template vai INTEIRO, sem passar pela assinatura");
    tem(src, /use_template/, "o 403 de janela fechada devolve o gancho pra tela oferecer template");
  }
}

// ============ K) A DECISAO DA SINCRONIZACAO (pura, extraida do banco)
//
// Ela era um `if` no meio de `salvarTemplates` (lib/canais-db.ts) — ou seja, a
// decisao mais consequente do sync estava fora do alcance de qualquer prova sem
// banco. Extraida, ela e provada aqui, e as duas regras abaixo decidem se um
// catalogo inteiro sobrevive a um soluco do provedor.
{
  const t = (nome: string): TemplateCanal => ({
    provider_id: `id_${nome}`,
    nome,
    idioma: "pt_BR",
    categoria: "UTILITY",
    status: "aprovado",
    corpo: "Ola {{1}}, tudo bem?",
    exemplo: "Ola Maria, tudo bem?",
    variaveis: 1,
    rodape: "",
    cabecalho: "TEXT",
    midia_url: "",
    motivo: "",
  });

  // LISTA VAZIA NAO APAGA NADA. O espelho e o que AUTORIZA envio por template:
  // esvazia-lo por um `[]` de soluco derrubaria todo o envio por template da
  // instalacao. Perder um template novo por uma rodada e barato; isso nao e.
  const vazia = decidirSincronizacao([]);
  eq(vazia.acao, "nada", "lista vazia NAO grava (e portanto nao apaga o espelho)");
  tem((vazia as any).aviso, /nao foi mexido/, "e o aviso diz que o catalogo local ficou como estava");
  tem((vazia as any).aviso, /app_id/, "e aponta a causa provavel pra quem for investigar");
  eq(decidirSincronizacao(null).acao, "nada", "null tambem nao grava");
  eq(decidirSincronizacao(undefined).acao, "nada", "undefined tambem");
  eq(decidirSincronizacao("nao e lista" as unknown as TemplateCanal[]).acao, "nada", "e o que nem e lista tambem");

  // TEMPLATE QUE SUMIU DO PROVEDOR SAI DO ESPELHO — e quem faz isso e a gravacao
  // por carimbo (lib/canais-db.ts). O que se prova aqui e a metade pura: a lista
  // que volta e a que MANDA no espelho, sem herdar o que nao veio.
  const duas = decidirSincronizacao([t("aviso_agenda"), t("convite_aula")]);
  eq(duas.acao, "gravar", "lista com conteudo grava");
  dep(
    (duas as any).lista.map((x: TemplateCanal) => x.nome),
    ["aviso_agenda", "convite_aula"],
    "e o espelho passa a ser exatamente o que o provedor devolveu (o que sumiu de la sai daqui)"
  );
  eq((duas as any).descartados, 0, "nada descartado quando todos os nomes servem");

  // NOME FORA DO FORMATO E DESCARTADO, sem derrubar a rodada: o nome e chave, vira
  // URL no DELETE do provedor e tem CHECK no banco — uma linha recusada pelo
  // Postgres abortaria o upsert INTEIRO.
  const comLixo = decidirSincronizacao([t("aviso_agenda"), t("Nome Com Espaco"), t("ACENTUADO"), t("ok_2")]);
  eq(comLixo.acao, "gravar", "template estranho NAO derruba a sincronizacao dos outros");
  dep(
    (comLixo as any).lista.map((x: TemplateCanal) => x.nome),
    ["aviso_agenda", "ok_2"],
    "so os nomes em formato valido entram"
  );
  eq((comLixo as any).descartados, 2, "e o descarte e CONTADO (ignorar em silencio faria alguem procurar pra sempre)");

  // e o caso em que TODOS sao invalidos: nao grava, e diz por que — em vez de
  // gravar zero linhas e apagar o espelho por tabela vazia
  const tudoLixo = decidirSincronizacao([t("Nome Ruim"), t("Outro Ruim")]);
  eq(tudoLixo.acao, "nada", "se NENHUM nome serve, nao grava (senao o espelho seria apagado)");
  tem((tudoLixo as any).aviso, /formato valido/, "e o aviso explica o formato");
}

// ============ L) O PROVEDOR APLICOU, OU SO RESPONDEU? (achado D7 da 2a revisao)
//
// A rota decidia isso por `!!r.corpo?.error` — confiava num CAMPO do corpo pra
// saber se um POST HTTP funcionou. A trilha entao gravava "Ana desconectou o
// numero" com o numero seguindo conectado, e essa e a linha que alguem vai ler pra
// entender o incidente. Trilha que registra INTENCAO como FATO mente com
// autoridade.
{
  eq(provedorRecusou({ status: 200, corpo: { value: true } }).recusado, false, "200 limpo: aplicou");
  eq(provedorRecusou({ status: 204 }).recusado, false, "204 sem corpo tambem aplicou");

  // ——— o caso que passava: erro HTTP SEM o campo `error` no corpo
  eq(provedorRecusou({ status: 502, corpo: {} }).recusado, true, "502 de proxy morto NAO e sucesso");
  eq(provedorRecusou({ status: 504 }).recusado, true, "504 de gateway mudo NAO e sucesso");
  eq(provedorRecusou({ status: 429, corpo: {} }).recusado, true, "429 do provedor NAO e sucesso");
  eq(provedorRecusou({ status: 500, corpo: { mensagem: "oops" } }).recusado, true, "500 com outro campo tambem recusa");
  tem(
    provedorRecusou({ status: 502, corpo: {} }).motivo,
    /502/,
    "e o motivo DIZ o status, pra a trilha nao ficar com 'erro desconhecido'"
  );

  // ——— excecao de rede: a rota carimba status 0
  eq(provedorRecusou({ status: 0, corpo: { error: "fetch failed" } }).recusado, true, "excecao de rede recusa");
  tem(
    provedorRecusou({ status: 0, corpo: {} }).motivo,
    /nada/,
    "sem status nenhum, a frase nao inventa um numero"
  );

  // ——— o campo `error` continua condenando mesmo com status bonito (a Z-API
  //     responde 200 com {error} — foi o caso que fez a guarda nascer)
  eq(
    provedorRecusou({ status: 200, corpo: { error: "You are already connected" } }).recusado,
    true,
    "200 COM campo error recusa (a Z-API responde assim)"
  );
  tem(
    provedorRecusou({ status: 200, corpo: { error: "You are already connected" } }).motivo,
    /ja esta conectado/,
    "e o motivo passa pelo tradutor de frase do provedor"
  );

  // ——— fail-closed: resposta que nao da pra entender NAO conta como sucesso
  eq(provedorRecusou({}).recusado, true, "resposta sem status conta como recusa");
  eq(provedorRecusou({ status: "200" as any }).recusado, false, "status numerico em string ainda e 200");
  eq(provedorRecusou({ status: NaN }).recusado, true, "status ilegivel recusa");
}

// ============ M) TRANSICAO x REPETICAO na trilha (item 6 + achado D6)
//
// Sem esta regra, `troca_divergente` era gravado A CADA POLLING: a revisao mediu
// ~1.028 linhas/hora com UM chip errado plugado, e a trilha — o lugar onde alguem
// procura "de qual numero pra qual" — virava palheiro.
//
// A decisao saiu de dentro de `registrarTransicao` (que fala com o banco, e por
// isso nenhuma prova a alcancava) pra funcao pura. A revisao mediu o preco: "gravar
// SEMPRE" passava a bateria inteira verde.
{
  const div = (de: string | null) => ({ tipo: "troca_divergente", de });

  eq(ehTransicao({ tipo: "", de: null }, div("551133334444")), true, "trilha vazia: o 1o divergente E transicao");
  eq(
    ehTransicao({ tipo: "troca_divergente", de: "551133334444" }, div("551133334444")),
    false,
    "MESMO tipo e MESMO chip errado: repeticao, nao grava (era isso que inundava)"
  );

  // ——— o achado D6: dois chips errados DIFERENTES na mesma troca
  eq(
    ehTransicao({ tipo: "troca_divergente", de: "551133334444" }, div("5511955554444")),
    true,
    "chip errado DIFERENTE e fato novo: comparar so o tipo dizia que o 2o aparelho nunca existiu"
  );

  // ——— e a divergencia que volta depois de outro evento tambem e transicao
  eq(
    ehTransicao({ tipo: "conectado", de: null }, div("551133334444")),
    true,
    "depois de outro evento, a divergencia volta a ser transicao"
  );

  // ——— `de` ausente x `de` null sao a MESMA coisa (senao a trilha duplicaria por
  //     causa de um campo omitido)
  eq(
    ehTransicao({ tipo: "reiniciado", de: null }, { tipo: "reiniciado" }),
    false,
    "`de` omitido e `de` null nao sao estados diferentes"
  );

  // ——— FAIL-CLOSED: nao deu pra ler a trilha = nao grava
  eq(
    ehTransicao(null, div("551133334444")),
    false,
    "trilha ilegivel: NAO grava (na duvida, perder uma linha e melhor que voltar a inundar)"
  );
}

// ============ N) AS GUARDAS QUE VIVEM NO CODIGO DE BANCO (varredura declarada)
//
// Estas tres nao dao pra exercitar sem Postgres: sao clausulas de query. A
// varredura e o que sobra — e ela e honesta sobre o que mede: a PRESENCA da
// clausula, no codigo, sem comentario. A revisao mediu que, sem isso, arrancar a
// guarda passava verde.
{
  // `semComentario` mora no topo do arquivo (era declarado aqui dentro).
  const db = semComentario(readFileSync(join("lib", "canais-db.ts"), "utf8"));

  // ——— item 15: a conclusao da troca e um UPDATE CONDICIONAL. Sem a condicao,
  // duas abas concluem a mesma troca e a segunda grava `de` = o numero NOVO, ou
  // seja, a trilha conta uma troca que nunca houve ("passou de X para X").
  const corpoConcluir = db.slice(db.indexOf("export async function concluirTroca"));
  const ateOProximoExport = corpoConcluir.slice(0, corpoConcluir.indexOf("\nexport ", 10));
  assert.match(
    ateOProximoExport,
    /\.not\(\s*["']troca_pendente["']\s*,\s*["']is["']\s*,\s*null\s*\)/,
    "concluirTroca carrega a guarda de concorrencia no proprio UPDATE (`troca_pendente is not null`)"
  );
  assercoes++;
  assert.match(
    ateOProximoExport,
    /\.select\(/,
    "...e pede as linhas afetadas de volta — sem isso nao ha como saber se concluiu"
  );
  assercoes++;
  eq(
    /\.upsert\(/.test(ateOProximoExport),
    false,
    "e NAO e upsert: sem linha nao existe troca pendente, e nao ha o que concluir"
  );

  // ——— item 6: quem grava a divergencia passa pela decisao pura
  const corpoTransicao = db.slice(db.indexOf("export async function registrarTransicao"));
  assert.match(
    corpoTransicao.slice(0, 600),
    /ehTransicao\s*\(/,
    "registrarTransicao DELEGA a decisao pura (nao reimplementa a comparacao)"
  );
  assercoes++;

  // ——— e o `de` vem do banco junto do tipo (achado D6): sem ele a comparacao nao
  // tem como distinguir dois chips errados diferentes
  const corpoUltimo = db.slice(db.indexOf("export async function ultimoEventoDoCanal"));
  assert.match(
    corpoUltimo.slice(0, 500),
    /\.select\(\s*["']tipo,de["']\s*\)/,
    "ultimoEventoDoCanal le `tipo` E `de` (so o tipo engolia o 2o chip errado)"
  );
  assercoes++;

  // ——— item 7 / D7: a trilha do desconectar carrega o rotulo da recusa
  const rota = semComentario(readFileSync(join("app", "api", "canais", "conexao", "route.ts"), "utf8"));
  assert.match(
    rota,
    /provedorRecusou\s*\(/,
    "a rota decide a recusa pela funcao pura (e nao por `!!corpo.error`, que era o D7)"
  );
  assercoes++;
  assert.match(
    rota,
    /detalhe:\s*\{\s*recusado:\s*true/,
    "e o evento gravado carrega `recusado: true` — sem esse rotulo a trilha mente"
  );
  assercoes++;
  assert.match(rota, /aplicado:\s*!recusadoPeloProvedor/, "e a resposta diz se a acao foi APLICADA");
  assercoes++;
}

// ============ O) A TELA: a corrida do "gerar um codigo novo" (achado D3)
//
// O clique zerava o QR local (certo: o proprio pedido invalida o codigo que esta na
// tela) e so DEPOIS esperava a resposta. Nesse meio, `qrRef` estava null, o poller
// acordava, `deveRenovarQr(undefined)` dava true e disparava um SEGUNDO pedido com o
// primeiro em voo — 429 vermelho logo apos o clique, ou, em outra aba, o QR
// invalidado debaixo da camera do cliente. O clique de "quero outro codigo"
// recriava exatamente o bug que a cadencia veio matar.
{
  tem(TELA, /const pedindoQr = useRef\(false\)/, "existe uma trava SINCRONA do pedido de QR");
  tem(
    TELA,
    /if \(pedindoQr\.current\) \{[\s\S]{0,900}?\breturn;/,
    "e ela desiste do pedido novo enquanto um esta em voo (ref, nao estado: tem que valer no MESMO tick)"
  );
  // ——— e o clique descartado FALA. Botao que nao responde parece botao quebrado:
  // o early-return e certo, mas engolir o CLIQUE em silencio faz a pessoa clicar de
  // novo. So no manual — no pedido automatico nao ha ninguem esperando resposta.
  tem(
    TELA,
    /if \(pedindoQr\.current\) \{[\s\S]{0,900}?if \(manual\) setAvisoLeve\(/,
    "o clique descartado pela trava responde com aviso leve, em vez de sumir calado"
  );
  // os DOIS caminhos passam pela mesma funcao travada, cada um com o seu `manual`:
  // a trava nao serve se um dos dois a contornar
  tem(TELA, /deveRenovarQr\(qrRef\.current\?\.em\)\) await pedirQr\(false\)/, "o POLLER pede por `pedirQr(false)`");
  tem(TELA, /void pedirQr\(true\)/, "e o BOTAO manual pede por `pedirQr(true)` — mesma trava");
  eq(
    (TELA.match(/pedirQr\(/g) ?? []).length,
    2,
    "e nao existe um terceiro caminho de pedido de QR por fora da trava"
  );
  eq(
    /await agir\("qr"\)/.test(TELA),
    false,
    "o botao manual nao chama mais `agir` direto — era por fora da trava"
  );

  // ——— D4: o botao "conferir agora" e a MESMA acao `estado` do poller, e pegava o
  // mesmo 429 do piso: clicar duas vezes pintava vermelho.
  tem(
    TELA,
    /acao === "estado" && e\?\.status === 429/,
    "o clique de conferir tolera o 429 do piso (nao e erro: e rajada nossa)"
  );
  tem(TELA, /setAvisoLeve\(/, "...e responde com aviso neutro, porque a pessoa CLICOU e merece resposta");

  // ——— O 429 DO PISO DO QR, o lado que a revisao anterior deixou de fora. O
  // raciocinio do D4 foi aplicado so a acao `estado`, e `INTERVALO_ACAO.qr` (2,5s) e
  // ALCANCAVEL sem ninguem errar nada: duas abas do mesmo canal com o modal aberto
  // caem dentro do piso por azar de fase. Pintar vermelho ali inventa problema num
  // numero que esta perfeito.
  {
    const iPedir = TELA.indexOf("const pedirQr = useCallback(");
    eq(iPedir > -1, true, "achei o pedirQr na tela");
    const fn = TELA.slice(iPedir, TELA.indexOf("useEffect(", iPedir));
    // medido DENTRO do catch: o `setAvisoLeve` do early-return (a baixa do clique
    // descartado) faria uma assertion frouxa passar verde com o 429 em vermelho
    const catchQr = fn.slice(fn.indexOf("} catch (e: any) {"));
    eq(catchQr.length > 0, true, "achei o catch do pedido de QR");
    tem(
      catchQr,
      /if \(e\?\.status === 429\) \{[\s\S]{0,600}?setAvisoLeve\(/,
      "o 429 do piso do QR responde em ambar (aviso leve), nao em vermelho"
    );
    // o vermelho continua existindo pro que NAO e piso: engolir tudo esconderia
    // credencial invalida, canal sem creds (501) e provedor fora do ar
    tem(catchQr, /else setErro\(/, "e o resto do erro segue em vermelho — engolir tudo esconderia falha real");
    // DECLARACAO PROVADA (nit): o 429 do piso do QR NAO conta em `semAtualizar`.
    // Aquele contador e do polling de ESTADO e a frase dele e "o que esta na tela
    // pode estar velho" — somar o piso do QR ali mentiria sobre o estado do numero,
    // que segue sendo lido no ciclo de 3,5s. `pedirQr` inteira nunca toca o contador.
    eq(
      /setSemAtualizar/.test(fn),
      false,
      "pedirQr NAO mexe em semAtualizar — o 429 do piso do QR nao vira aviso de estado velho"
    );
    eq(
      /INTERVALO_ACAO\.qr/.test(readFileSync("lib/canal-conexao.ts", "utf8")),
      true,
      "o piso do QR existe no regramento puro (e o numero que a tela tolera)"
    );
  }

  // ——— D5: engolir 429 pra sempre congelaria a tela num 429 de proxy/WAF
  tem(TELA, /semAtualizar >= 3/, "3 recusas seguidas viram aviso na tela");
  tem(TELA, /setSemAtualizar\(0\)/, "e o contador zera quando volta a atualizar");
  tem(
    TELA,
    /pode estar velho/,
    "o aviso diz a verdade util: o que esta na tela pode estar velho"
  );
}

// ============ P) A NUMERACAO DAS VARIAVEIS, E A FAMILIA CONCORDANDO (Frente Z)
//
// O DEFEITO QUE ESTE BLOCO FECHA, medido em node solto ANTES do conserto:
//
//   corpo    "Ola {{1}}, sua consulta e dia {{3}}."   (aprovado na Meta, com buraco)
//   params   ["Eric", "10/09"]
//   validarParametros -> ok:true            (contava variaveis DISTINTAS: 2 == 2)
//   painel grava      "Ola Eric, sua consulta e dia {{3}}."
//   provedor recebe   params:["Eric","10/09"] e casa por POSICAO
//
// Ou seja: a conversa guardava um texto DIFERENTE do que o cliente recebeu, e nao
// havia erro em lugar nenhum — nem 4xx, nem log, nem teste vermelho. A tela ja
// tinha sido corrigida por outra frente; a ROTA continuava aceitando, e a rota e
// o caminho da chave de API, do fluxo e de qualquer integracao.
//
// Tres coisas sao provadas aqui, nesta ordem: a regra (numeracao), a EQUIVALENCIA
// da familia (quem grava e quem envia leem o mesmo corpo do mesmo jeito) e o
// CAMINHO do pedido (`decidirEnvioTemplate`, os quatro passos por comportamento).
{
  // A fixture de template do bloco. Fica no TOPO porque a regra pura (1 e 1b) ja
  // precisa dela pra exercitar `validarParametros`.
  const tpl = (nome: string, corpo: string, extra: Partial<TemplateCanal> = {}): TemplateCanal => ({
    provider_id: `id_${nome}`,
    nome,
    idioma: "pt_BR",
    categoria: "UTILITY",
    status: "aprovado",
    corpo,
    exemplo: "",
    variaveis: contarVariaveis(corpo),
    rodape: "",
    cabecalho: "TEXT",
    midia_url: "",
    motivo: "",
    ...extra,
  });

  // ——— 1. a regra pura
  dep(numeracaoDoCorpo("Ola {{1}}, dia {{2}}."), { ok: true, variaveis: 2 }, "{{1}}..{{2}} contiguo passa");
  dep(numeracaoDoCorpo("sem variavel nenhuma"), { ok: true, variaveis: 0 }, "corpo sem variavel: zero, e passa");
  dep(numeracaoDoCorpo("{{2}} antes de {{1}}"), { ok: true, variaveis: 2 }, "fora de ordem NAO e furo — o conjunto e o que importa");
  dep(numeracaoDoCorpo("Oi {{1}}, {{1}} de novo, e {{2}}"), { ok: true, variaveis: 2 }, "variavel repetida conta uma vez");
  dep(numeracaoDoCorpo("Oi {{ 1 }} e {{ 2 }}"), { ok: true, variaveis: 2 }, "espaco dentro das chaves nao muda nada");
  eq(numeracaoDoCorpo("Ola {{1}}, dia {{3}}.").ok, false, "BURACO no meio ({{1}} e {{3}}) NAO passa");
  eq(numeracaoDoCorpo("Ola {{2}}, tudo bem?").ok, false, "comecar em {{2}} NAO passa");
  eq(numeracaoDoCorpo("Ola {{0}} e {{1}}").ok, false, "{{0}} nao existe pra Meta — a contagem comeca em 1");
  eq(numeracaoDoCorpo("{{1}} {{2}} {{4}} {{5}}").ok, false, "buraco no fim da faixa tambem e buraco");
  // a frase tem que servir pra alguem CONSERTAR: diz o que usa, o que falta e o que fazer
  const motFuro = (numeracaoDoCorpo("Ola {{1}}, dia {{3}}.") as any).motivo as string;
  tem(motFuro, /\{\{1\}\}, \{\{3\}\}/, "o motivo cita as variaveis que o texto usa");
  tem(motFuro, /nao usa \{\{2\}\}/, "e cita a que falta (e o conserto)");
  tem(motFuro, /Meta/, "e diz ONDE consertar: o texto do template esta na Meta");
  tem(motFuro, /sincronize/, "e o que fazer depois de consertar");

  // ——— 1b. O TETO (GRAVE da 2a revisao cega) — o numero dentro de `{{...}}` NAO
  // pode virar o limite de um laco.
  //
  // O QUE FOI MEDIDO no estado reprovado: `fim` saía do texto livre do espelho e
  // limitava o `for` e o array `faltando`. `{{20000000}}` montava 20 milhoes de
  // itens e uma string `motivo` de 256 MB (event loop travado); `{{40000000}}`
  // estourava `RangeError: Invalid string length` NAO TRATADO, e com heap folgado
  // o processo Node do painel MORRIA — a chamada mora fora do `try` da rota, entao
  // isso nao virava recusa, virava 500 ou a instalacao caindo.
  //
  // O caso `{{60}}` e o que MORDE se o teto sumir: sem ele o veredito continua
  // `false` (2..59 sao buracos), mas a frase passa a listar 58 variaveis — as
  // duas asseracoes abaixo (a citacao do limite e o TAMANHO da frase) reprovam
  // na hora, antes de a prova chegar no caso pesado.
  const capado = numeracaoDoCorpo("Ola {{1}}, dia {{60}}.");
  eq(capado.ok, false, "TETO — {{60}} nao passa: a Meta nao aprova template com mais de 50 variaveis");
  tem((capado as any).motivo, /limite de 50/, "e a recusa diz QUAL e o limite (nao um buraco generico)");
  eq(
    (capado as any).motivo.length < 360,
    true,
    `a frase da recusa e curta (${(capado as any).motivo.length} chars) — ela nao cresce com o corpo`
  );
  // O TETO NAO E UM `50` DIGITADO AQUI (BAIXA 2 da 3a revisao cega). A asseracao
  // antiga era `eq(MAX_VARIAVEIS_TEMPLATE, 50, ...)`: se a 0023 mudasse pra 100 e a
  // constante ficasse em 50 — ou o contrario — nada avisava, e o "mesmo 50 dos tres
  // lugares" viraria prosa. Agora os dois outros lados sao LIDOS: o CHECK da
  // migration e o clamp de `salvarTemplates`.
  const ddl = readFileSync(join("supabase", "migrations", "0023_canais_conexao_templates.sql"), "utf8");
  const tetoDaDdl = ddl.match(/ck_canal_templates_variaveis[\s\S]{0,160}?variaveis\s*<=\s*(\d+)/);
  eq(!!tetoDaDdl, true, "o CHECK `ck_canal_templates_variaveis` da 0023 declara um teto legivel");
  eq(
    MAX_VARIAVEIS_TEMPLATE,
    Number(tetoDaDdl?.[1] ?? -1),
    `e o teto do codigo e o LIDO do CHECK da 0023 (${tetoDaDdl?.[1]}), nao um literal digitado na prova`
  );
  // e o clamp do sync (que grava a coluna) usa o MESMO numero. Ele importa mais que
  // o CHECK: como o clamp vem ANTES, o CHECK nunca dispara pra valor alto.
  tem(
    semComentario(readFileSync(join("lib", "canais-db.ts"), "utf8")),
    new RegExp(`Math\\.min\\(Math\\.max\\(t\\.variaveis, 0\\), ${MAX_VARIAVEIS_TEMPLATE}\\)`),
    "e `salvarTemplates` capa a coluna `variaveis` no MESMO teto"
  );

  // A FRONTEIRA, nos dois lados: 50 variaveis contiguas e cadastro legitimo e passa;
  // 51 nao existe na Meta e e recusado. Sem isso, "teto" poderia ser um numero
  // qualquer que quebra template bom (falso negativo — a classe de erro que este
  // repo ja pagou duas vezes).
  const corpoN = (n: number) => Array.from({ length: n }, (_, i) => `{{${i + 1}}}`).join(" ");
  dep(numeracaoDoCorpo(corpoN(50)), { ok: true, variaveis: 50 }, "50 variaveis contiguas PASSAM (o teto nao inventa recusa)");
  eq(numeracaoDoCorpo(corpoN(51)).ok, false, "e 51 nao passa — a fronteira e exatamente o teto do banco");

  // A frase tambem nao cresce com a lista de FALTANDO: {{1}} e {{50}} tem 48
  // buracos, e so os primeiros entram na frase (o resto vira contagem).
  const muitosBuracos = (numeracaoDoCorpo("{{1}} {{50}}") as any).motivo as string;
  eq(muitosBuracos.length < 500, true, `48 buracos cabem numa frase curta (${muitosBuracos.length} chars)`);
  tem(muitosBuracos, /\(48 no total\)/, "e a frase diz quantos sao, em vez de listar todos");

  // E O CASO-MAE DO GRAVE, agora barato. ATENCAO a quem mexer: sem o teto, esta
  // linha nao "falha" — ela TRAVA o processo (20 milhoes de iteracoes e 256 MB de
  // string). Ela fica por ultimo de proposito; as de cima ja teriam reprovado.
  const t0 = Date.now();
  const gigante = numeracaoDoCorpo("Ola {{1}}, dia {{20000000}}.");
  eq(gigante.ok, false, "TETO — {{20000000}} e recusado (era o corpo que derrubava o painel)");
  eq((gigante as any).motivo.length < 360, true, "com frase curta: `motivo` nao cresce com o numero da variavel");
  eq(
    Math.abs((gigante as any).motivo.length - (capado as any).motivo.length) <= 20,
    true,
    "e ela tem o MESMO tamanho da recusa do {{60}} (so mudam os digitos do numero) — nao ha lista proporcional"
  );
  eq(Date.now() - t0 < 1000, true, "e a recusa sai na hora — sem laco proporcional ao numero escrito no corpo");
  eq(
    validarParametros(tpl("gigante", "Ola {{1}}, dia {{20000000}}."), ["Eric"]).ok,
    false,
    "e o envio para no mesmo lugar (validarParametros recusa antes de qualquer chamada)"
  );

  // ——— 2. o envio: recusa o furado ANTES de qualquer chamada, e passa o contiguo
  const furado = tpl("consulta_furada", "Ola {{1}}, sua consulta e dia {{3}}.");
  const contiguo = tpl("consulta_ok", "Ola {{1}}, sua consulta e dia {{2}}.");
  eq(validarParametros(furado, ["Eric", "10/09"]).ok, false, "o CASO-MAE: 2 params num corpo {{1}}+{{3}} nao passa mais");
  dep(
    validarParametros(contiguo, ["Eric", "10/09"]),
    { ok: true, params: ["Eric", "10/09"] },
    "e o template contiguo segue passando (a guarda nova nao fecha o caminho legitimo)"
  );

  // A CONTAGEM SAI DO CORPO, NAO DA COLUNA. Espelho com a coluna divergindo do
  // texto (o sync limita `variaveis` em 50, e linha escrita a mao nao passa pelo
  // sync) autorizava N parametros e renderizava outro texto — a mesma classe do
  // GRAVE da 3a revisao da Frente U: quem autoriza tem que ler o MESMO que executa.
  const espelhoMentiroso = tpl("tres_vars", "A {{1}} B {{2}} C {{3}}.", { variaveis: 2 });
  eq(
    validarParametros(espelhoMentiroso, ["a", "b"]).ok,
    false,
    "coluna diz 2 e o corpo usa 3: dois parametros NAO passam (a coluna nao manda)"
  );
  dep(
    validarParametros(espelhoMentiroso, ["a", "b", "c"]),
    { ok: true, params: ["a", "b", "c"] },
    "e tres passam — a contagem que vale e a do texto que vai ser renderizado"
  );

  // ——— 3. A FAMILIA CONCORDA? (`renderizarTemplate` x `corpoEnvioTemplate`)
  //
  // As duas leem o MESMO corpo de jeitos diferentes: uma por NUMERO da variavel
  // ({{2}} -> params[1]) e a outra por POSICAO no array (`params: [a, b]` no POST).
  // Com numeracao contigua isso e a mesma coisa; com buraco, nao — e a divergencia
  // e invisivel porque ninguem falha.
  //
  // DECLARADO: `renderComoProvedor` e um MODELO do provedor (a Meta preenche as
  // variaveis do corpo aprovado com o array `params`, na ordem). Nao e medicao
  // contra o Gupshup — prova com numero real e gesto humano, card separado. O que
  // este bloco mede e a CONSISTENCIA das duas leituras nossas.
  const renderComoProvedor = (corpo: string, paramsDoForm: readonly string[]) => {
    const porNumero = new Map<number, string>();
    variaveisDoCorpo(corpo).forEach((n, i) => porNumero.set(n, paramsDoForm[i]));
    return corpo.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => porNumero.get(Number(n)) ?? m);
  };
  const paramsDoPost = (t: TemplateCanal, params: string[]) =>
    JSON.parse(corpoEnvioTemplate({ source: "5500000000000" }, "5511000000000", t, params).get("template")!).params as string[];

  // a divergencia MEDIDA no caso-mae — e por isso que ele e recusado
  const pFuro = ["Eric", "10/09"];
  eq(
    renderizarTemplate(furado.corpo, pFuro),
    "Ola Eric, sua consulta e dia {{3}}.",
    "o painel gravaria a variavel CRUA no lugar do valor"
  );
  eq(
    renderComoProvedor(furado.corpo, paramsDoPost(furado, pFuro)),
    "Ola Eric, sua consulta e dia 10/09.",
    "e o cliente leria o valor — os dois textos DIVERGEM (o defeito, em numeros)"
  );

  // e a equivalencia, como REGRA: numeracao aceita <=> as duas leituras batem.
  // Se a guarda voltar a contar variaveis distintas, algum corpo aceito aqui
  // divergira e esta asseracao morde.
  const corpos = [
    "sem nada",
    "Ola {{1}}!",
    "Ola {{1}}, dia {{2}}.",
    "{{2}} antes de {{1}}",
    "Oi {{1}}, {{1}} de novo, e {{2}}",
    "Oi {{ 1 }} e {{ 2 }}",
    "A {{1}} B {{2}} C {{3}}.",
    "Ola {{1}}, dia {{3}}.",
    "Ola {{2}}, tudo bem?",
    "{{1}} {{2}} {{4}}",
    "Ola {{0}} e {{1}}",
  ];
  const valores = ["Eric", "10/09", "19:30", "quarta", "{{2}}"];
  for (const corpo of corpos) {
    const t = tpl("equiv", corpo);
    const n = numeracaoDoCorpo(corpo);
    const params = valores.slice(0, n.ok ? n.variaveis : variaveisDoCorpo(corpo).length);
    const batem = renderizarTemplate(corpo, params) === renderComoProvedor(corpo, paramsDoPost(t, params));
    eq(
      n.ok ? batem : true,
      true,
      `numeracao aceita => painel e provedor leem igual: ${JSON.stringify(corpo)}`
    );
    // e o inverso: corpo que a guarda recusa e corpo que NAO pode chegar ao envio
    eq(
      n.ok || !validarParametros(t, params).ok,
      true,
      `numeracao recusada => o envio para antes: ${JSON.stringify(corpo)}`
    );
  }
  // o valor que contem "{{2}}" nao e re-substituido em nenhum dos dois lados
  eq(
    renderizarTemplate("Ola {{1}}, dia {{2}}.", ["{{2}}", "10/09"]),
    "Ola {{2}}, dia 10/09.",
    "parametro que PARECE variavel entra como texto, sem segunda passada"
  );

  // ——— 4. O CAMINHO DO PEDIDO: `decidirEnvioTemplate`, por comportamento
  //
  // Isto era um bloco de `if`s dentro de /api/send, e a unica prova possivel era
  // varredura de fonte ("a rota menciona X", "o indexOf de X vem antes do de Y").
  // Agora os quatro passos rodam aqui, com fixture, e cada recusa carrega o codigo
  // HTTP que a rota devolve — o que a varredura do bloco J nao alcancava.
  const catalogo = (t: TemplateCanal | null) => ({ disponivel: true, aviso: "", template: t });
  const semCatalogo = { disponivel: false, aviso: "rode a migration 0023 pra sincronizar", template: null };

  dep(lerPedidoTemplate({ nome: " Aviso_Agenda " }), { ok: true, nome: "aviso_agenda", idioma: "" }, "nome vem saneado (trim + minusculas)");
  eq(lerPedidoTemplate({ nome: "aviso agenda" }).ok, false, "nome com espaco e recusado (ele viaja na URL do DELETE)");
  eq(lerPedidoTemplate({}).ok, false, "pedido sem nome e recusado");

  const dFuro = decidirEnvioTemplate({ nome: "consulta_furada", params: ["Eric", "10/09"] }, catalogo(furado));
  eq(dFuro.ok, false, "PASSO 4 — template com numeracao furada NAO chega ao provedor");
  eq((dFuro as any).status, 400, "e a recusa e 400 (pedido que nao da pra atender)");
  tem((dFuro as any).motivo, /\{\{2\}\}/, "com o motivo que aponta o conserto");

  const dOk = decidirEnvioTemplate({ nome: "consulta_ok", params: ["Eric", "10/09"] }, catalogo(contiguo));
  eq(dOk.ok, true, "o caminho legitimo passa");
  eq(
    (dOk as any).envio.texto,
    "Ola Eric, sua consulta e dia 10/09.",
    "e o texto provado e o RENDERIZADO — o que o painel grava e o que o cliente le"
  );
  eq(
    (dOk as any).envio.texto,
    renderComoProvedor(contiguo.corpo, paramsDoPost(contiguo, (dOk as any).envio.params)),
    "e ele bate com o que o provedor montaria com os MESMOS parametros"
  );
  dep((dOk as any).envio.params, ["Eric", "10/09"], "os parametros saem saneados (string, na ordem)");

  eq((decidirEnvioTemplate({ nome: "x y" }, catalogo(contiguo)) as any).status, 400, "PASSO 1 — nome fora do formato: 400");
  eq((decidirEnvioTemplate({ nome: "consulta_ok" }, semCatalogo) as any).status, 503, "PASSO 2 — sem catalogo: 503, nunca envio no escuro");
  tem((decidirEnvioTemplate({ nome: "consulta_ok" }, semCatalogo) as any).motivo, /0023/, "e o aviso do catalogo chega inteiro a quem chamou");
  tem(
    (decidirEnvioTemplate({ nome: "consulta_ok" }, { disponivel: false, aviso: "", template: null }) as any).motivo,
    /sincronize/,
    "catalogo indisponivel SEM aviso ainda diz o que fazer (nunca 503 mudo)"
  );
  // o `em_analise` vem ANTES do `catalogo(null)` de proposito: arrancar o passo 3
  // faz o template nulo estourar la dentro, e um TypeError nao diz a alguem que
  // acabou de quebrar a guarda O QUE ele quebrou. Esta asseracao diz.
  eq(
    (decidirEnvioTemplate({ nome: "consulta_ok", params: ["a", "b"] }, catalogo({ ...contiguo, status: "em_analise" })) as any).status,
    409,
    "PASSO 3 — em analise na Meta: 409 (status novo nunca vira permissao)"
  );
  eq((decidirEnvioTemplate({ nome: "consulta_ok" }, catalogo(null)) as any).status, 409, "PASSO 3 — fora do catalogo deste numero: 409");
  eq(
    (decidirEnvioTemplate({ nome: "consulta_ok", params: ["a", "b"] }, catalogo({ ...contiguo, provider_id: "" })) as any).status,
    409,
    "PASSO 3 — sem id no provedor: 409 (o nome nao serve pra enviar)"
  );
  eq((decidirEnvioTemplate({ nome: "consulta_ok", params: ["so-um"] }, catalogo(contiguo)) as any).status, 400, "PASSO 4 — parametro a menos: 400");
  eq((decidirEnvioTemplate({ nome: "consulta_ok", params: ["a", "b", "c"] }, catalogo(contiguo)) as any).status, 400, "PASSO 4 — parametro a mais: 400");
  eq((decidirEnvioTemplate({ nome: "consulta_ok" }, catalogo(contiguo)) as any).status, 400, "PASSO 4 — sem params num template com variaveis: 400");
  eq((decidirEnvioTemplate({ nome: "consulta_ok", params: ["a", " "] }, catalogo(contiguo)) as any).status, 400, "PASSO 4 — valor em branco: 400");

  // A ORDEM DOS PASSOS, por COMPORTAMENTO (nao por indexOf): quem quebra dois
  // passos ao mesmo tempo recebe o codigo do passo que vem ANTES. Isso importa
  // porque o passo 3 e o que protege a nota de qualidade do numero: ele nao pode
  // ficar atras de uma conferencia de parametro.
  eq(
    (decidirEnvioTemplate({ nome: "NOME INVALIDO" }, semCatalogo) as any).status,
    400,
    "nome torto + catalogo fora = 400: o nome e conferido antes da consulta"
  );
  eq(
    (decidirEnvioTemplate({ nome: "consulta_furada", params: [] }, catalogo({ ...furado, status: "recusado" })) as any).status,
    409,
    "status recusado + params errados = 409: o status vem antes dos parametros"
  );

  // ——— 5. AS OUTRAS DUAS DIVERGENCIAS DA MESMA FAMILIA (achadas nesta frente)
  //
  // (a) CABECALHO DE IMAGEM SEM O LINK DA ARTE. `corpoEnvioTemplate` so poe o
  // `message` com o link quando ele existe — e o gotcha portado do Meeting Hub diz
  // que SEM o `message` a Meta aceita (202, com messageId) e DESCARTA a entrega em
  // silencio. Resultado: o painel gravava a mensagem na conversa e o cliente nao
  // recebia nada. As duas asseracoes abaixo andam juntas de proposito: a condicao
  // que faz o corpo do POST sair sem `message` e EXATAMENTE a que recusa o envio.
  const imgSemLink = tpl("promo_arte", "Ola {{1}}, chegou a novidade.", { cabecalho: "IMAGE", midia_url: "" });
  const imgComLink = tpl("promo_arte", "Ola {{1}}, chegou a novidade.", {
    cabecalho: "IMAGE",
    midia_url: "https://exemplo.invalid/arte.jpg",
  });
  eq(
    corpoEnvioTemplate({ source: "5500000000000" }, "5511000000000", imgSemLink, ["Eric"]).get("message"),
    null,
    "sem o link, o POST sai SEM `message` — e e assim que a Meta dropa em silencio"
  );
  eq(podeEnviarTemplate(imgSemLink).ok, false, "entao template de imagem sem link NAO envia (a entrega seria descartada)");
  tem((podeEnviarTemplate(imgSemLink) as any).motivo, /descarta a entrega/, "e a frase diz o que aconteceria");
  tem((podeEnviarTemplate(imgSemLink) as any).motivo, /[Ss]incronize/, "e o que fazer");
  eq(podeEnviarTemplate(imgComLink).ok, true, "com o link, envia normalmente (a guarda nao fecha o caminho legitimo)");
  eq(podeEnviarTemplate({ ...imgSemLink, cabecalho: "TEXT" }).ok, true, "e template de TEXTO nao precisa de link nenhum");
  eq(
    (podeEnviarTemplate({ ...imgSemLink, status: "recusado" }) as any).motivo.includes("recusado pela Meta"),
    true,
    "template recusado E sem link responde pelo STATUS: pra ele, a frase util e a da Meta"
  );
  eq(
    (decidirEnvioTemplate({ nome: "promo_arte", params: ["Eric"] }, catalogo(imgSemLink)) as any).status,
    409,
    "e o caminho do pedido devolve 409 antes de qualquer chamada ao provedor"
  );

  // (b) TEMPLATE + PERGUNTA COM OPCOES no mesmo pedido. O ramo do template vem
  // primeiro, entao saía o template — mas a linha gravada saía MISTURADA (`tipo`
  // interativo e corpo com o resumo da pergunta que nunca foi enviada). Mesmo
  // precedente do 400 de `message` diferente de `interativa.texto`.
  eq(conflitoComTemplate({}), null, "so template: sem conflito");
  eq(conflitoComTemplate({ texto: "", pergunta: false }), null, "texto vazio nao e conflito");
  tem(conflitoComTemplate({ texto: "oi, tudo bem?" }), /texto livre OU template/, "texto livre + template = recusa (ja existia)");
  tem(conflitoComTemplate({ pergunta: true }), /pergunta com opcoes OU template/, "pergunta com opcoes + template = recusa (novo)");
  tem(
    conflitoComTemplate({ texto: "oi", pergunta: true }),
    /pergunta com opcoes/,
    "com os dois, a frase e a da pergunta — e a que explica o historico misturado"
  );

  // ——— 6. A TELA AVISA ANTES DO ENVIO (MEDIA 4 da 2a revisao / GRAVE 1 da 3a)
  //
  // A recusa nasceu so no envio: o template com numeracao furada continuava no
  // catalogo pintado de `aprovado`, verdinho, e o operador descobria quando a
  // mensagem falhasse. Este painel ja condena esse padrao com todas as letras pro
  // `sincronizado_em` ("catalogo velho sem aviso e o mesmo defeito do QR expirado
  // sem aviso") — a recusa nova nao podia nascer sem inventario na tela.
  //
  // POR QUE ESTE SUB-BLOCO FOI REFEITO. Na 1a versao a expressao do selo morava no
  // JSX e as tres asseracoes eram varredura de fonte — selo morto, portanto. A 3a
  // revisao mediu, com a bateria inteira VERDE em cada caso:
  //
  //   `{false && bloqueio && (`     o selo nunca renderiza
  //   `const bloqueio = "";`        o selo nunca tem conteudo
  //   `num` antes de `envio`        passa, e o motivo passa a DIVERGIR da rota no
  //                                 template com dois defeitos
  //
  // A expressao virou `motivoParaNaoEnviarTemplate` (lib/templates-oficial.ts), e a
  // prova agora EXERCITA a funcao contra fixtures, comparando a frase com a que a
  // ROTA (`decidirEnvioTemplate`) devolveria pro MESMO template. O gate do status
  // deixou de ser um `if` da tela: ele mora em `podeEnviarTemplate`, o passo 3 da
  // rota, entao numeracao furada em template `em_analise` responde pelo STATUS nos
  // dois lugares — que e o que o comentario da tela sempre afirmou e o codigo antigo
  // nao fazia (o `numeracaoDoCorpo` rodava fora do gate).
  {
    const selo = (t: TemplateCanal) => motivoParaNaoEnviarTemplate(t);
    const naRota = (t: TemplateCanal, params: string[]) =>
      decidirEnvioTemplate({ nome: t.nome, params }, catalogo(t));

    const furadoEmAnalise = tpl("consulta_furada", "Ola {{1}}, sua consulta e dia {{3}}.", { status: "em_analise" });
    const furadoRecusado = tpl("consulta_furada", "Ola {{1}}, sua consulta e dia {{3}}.", { status: "recusado" });
    const doisDefeitos = tpl("promo_furada", "Ola {{1}}, chegou o dia {{3}}.", {
      cabecalho: "IMAGE",
      midia_url: "",
    });

    // (a) APROVADO E USAVEL: a tela nao inventa selo, e a rota deixa passar.
    eq(selo(contiguo), null, "template aprovado e usavel NAO ganha selo (a tela nao e mais rigorosa que o envio)");

    // (b) APROVADO COM NUMERACAO FURADA: o caso-mae, agora visivel no catalogo.
    tem(selo(furado), /numeracao das variaveis esta furada/, "aprovado com numeracao furada ganha o selo, no catalogo");
    tem(selo(furado), /nao usa \{\{2\}\}/, "e o selo carrega o conserto (a variavel que falta)");

    // (c) APROVADO COM IMAGEM SEM O LINK DA ARTE.
    tem(selo(imgSemLink), /descarta a entrega/, "imagem no cabecalho sem o link da arte tambem ganha selo");

    // (d) OS DOIS DEFEITOS JUNTOS — e aqui a ORDEM e a asseracao. A rota responde
    // pela imagem (passo 3, 409) antes da numeracao (passo 4, 400); inverter os dois
    // passos na funcao pura faz a tela dizer "numeracao" onde a recusa diria
    // "imagem", e o operador conserta a coisa errada.
    tem(selo(doisDefeitos), /descarta a entrega/, "com os DOIS defeitos, o selo e o da imagem — a mesma ordem da rota");
    eq(
      /numeracao das variaveis/.test(selo(doisDefeitos) ?? ""),
      false,
      "e NAO e o da numeracao (inverter os dois passos morde aqui)"
    );

    // (e) NAO-APROVADO COM NUMERACAO FURADA — o defeito que a 3a revisao achou. Com
    // `numeracaoDoCorpo` fora do gate, a tela dizia "a numeracao esta furada" e a
    // rota diria "ainda esta em analise na Meta".
    tem(selo(furadoEmAnalise), /em analise na Meta/, "em analise + numeracao furada: quem fala e o STATUS");
    eq(
      /numeracao das variaveis/.test(selo(furadoEmAnalise) ?? ""),
      false,
      "e a numeracao NAO aparece — ela e criterio de template aprovado, como o comentario da tela promete"
    );
    tem(selo(furadoRecusado), /recusado pela Meta/, "recusado + numeracao furada: idem, a frase util e a da Meta");

    // A EQUIVALENCIA COMO REGRA, sobre os seis casos: o selo existe se e somente se a
    // rota recusa, e quando existe a rota repete a MESMA frase. Isto e o que fecha a
    // promessa da frente — "a tela nao tem regra propria" — sem depender de prosa.
    const casos: { t: TemplateCanal; params: string[]; rotulo: string }[] = [
      { t: contiguo, params: ["Eric", "10/09"], rotulo: "aprovado usavel" },
      { t: furado, params: ["Eric", "10/09"], rotulo: "aprovado, numeracao furada" },
      { t: imgSemLink, params: ["Eric"], rotulo: "aprovado, imagem sem link" },
      { t: imgComLink, params: ["Eric"], rotulo: "aprovado, imagem com link" },
      { t: doisDefeitos, params: ["Eric", "10/09"], rotulo: "aprovado, os dois defeitos" },
      { t: furadoEmAnalise, params: ["Eric", "10/09"], rotulo: "em analise, numeracao furada" },
      { t: furadoRecusado, params: ["Eric", "10/09"], rotulo: "recusado, numeracao furada" },
      // A MUDANCA VISUAL NOMEADA (BAIXA 5 da 4a revisao cega), por COMPORTAMENTO:
      // template SEM defeito nenhum no corpo, so esperando/barrado pela Meta, TAMBEM
      // ganha a caixa vermelha. A invariante e essa — *caixa existe se e so se a rota
      // recusaria* —, e e ela que faz a AUSENCIA da caixa significar "da pra enviar".
      // Os quatro status nao-aprovados entram aqui de proposito: se algum dia alguem
      // suprimir a caixa "porque o rotulo do status ja diz", esta linha reprova e a
      // decisao volta pra mesa em vez de virar mudanca silenciosa.
      { t: tpl("limpo_analise", "Ola {{1}}.", { status: "em_analise" }), params: ["Eric"], rotulo: "em analise, corpo limpo" },
      { t: tpl("limpo_recusado", "Ola {{1}}.", { status: "recusado" }), params: ["Eric"], rotulo: "recusado, corpo limpo" },
      { t: tpl("limpo_pausado", "Ola {{1}}.", { status: "pausado" }), params: ["Eric"], rotulo: "pausado, corpo limpo" },
      { t: tpl("limpo_zumbi", "Ola {{1}}.", { status: "desconhecido" }), params: ["Eric"], rotulo: "estado desconhecido, corpo limpo" },
      // e o sem-provider_id, que e 409 desde antes desta frente (e o que o inventario
      // do CLAUDE.md agora exclui da contagem de `aprovados`, porque inflava PRA MAIS)
      { t: tpl("sem_id", "Ola {{1}}.", { provider_id: "" }), params: ["Eric"], rotulo: "aprovado sem id no provedor" },
    ];
    // A LINHA INTEIRA DO CATALOGO, POR COMPORTAMENTO (4a revisao cega).
    //
    // O selo ja era funcao pura, mas quem decidia o que DESENHAR com ela era o `map`
    // do componente — e regra dentro de JSX so tem prova por varredura de fonte, que
    // e o que esta onda inteira pagou. `linhasDoCatalogo` devolve a linha PRONTA
    // (nome, detalhe, rotulo, selo e os paragrafos) e a tela virou desenhista. Daqui
    // pra baixo tudo e comportamento: sumir com o selo, trocar a frase, inverter os
    // dois passos ou perder o motivo da Meta muda o que esta funcao devolve.
    for (const { t, params, rotulo } of casos) {
      const s = selo(t);
      const d = naRota(t, params);
      const [linha] = linhasDoCatalogo([t]);
      eq(s === null, d.ok, `tela e rota concordam em ENVIA / NAO ENVIA: ${rotulo}`);
      eq(
        s === null || String((d as any).motivo).includes(s),
        true,
        `e a recusa da rota repete a MESMA frase do selo: ${rotulo}`
      );
      eq(linha.selo, s, `a LINHA do catalogo carrega o mesmo selo da funcao pura: ${rotulo}`);
      const recusa = linha.blocos.filter((b) => b.tom === "recusa");
      eq(recusa.length, s === null ? 0 : 1, `o paragrafo de recusa existe se e so se existe selo: ${rotulo}`);
      eq(recusa[0]?.texto ?? null, s, `e ele carrega o MOTIVO inteiro — selo sem motivo nao ensina nada: ${rotulo}`);
      eq(
        recusa[0]?.rotulo ?? "",
        s === null ? "" : "Nao pode ser enviado:",
        `com o rotulo que o operador le na tela: ${rotulo}`
      );
    }

    // A ORDEM E A COMPOSICAO dos paragrafos, que e o que a tela desenha de cima pra
    // baixo: corpo, motivo da Meta, recusa.
    const [lFurado] = linhasDoCatalogo([furado]);
    dep(
      lFurado.blocos.map((b) => b.tom),
      ["corpo", "recusa"],
      "template aprovado com numeracao furada: corpo e depois a recusa"
    );
    eq(lFurado.blocos[0].texto, furado.corpo, "e o corpo desenhado e o corpo do template");
    eq(lFurado.chave, "consulta_furada@pt_BR", "a chave da linha e nome@idioma (a mesma de antes)");
    eq(lFurado.detalhe, "pt_BR · UTILITY · 2 variavel(is)", "o detalhe da linha vem montado, sem `if` no JSX");
    eq(
      linhasDoCatalogo([imgComLink])[0].detalhe,
      "pt_BR · UTILITY · 1 variavel(is) · com imagem",
      "e cabecalho de imagem aparece no detalhe"
    );

    // O `motivo:` DA META NAO APARECE DUAS VEZES. Em `recusado` a frase do selo ja
    // termina com `(motivo)`; um paragrafo `motivo:` separado seria a mesma frase de
    // novo, na mesma linha, logo acima do selo.
    const recusadoComMotivo = tpl("promo_meta", "Ola {{1}}.", { status: "recusado", motivo: "texto promocional" });
    const l2 = linhasDoCatalogo([recusadoComMotivo])[0];
    dep(l2.blocos.map((b) => b.tom), ["corpo", "recusa"], "recusado: o `motivo:` some, porque o selo ja o carrega");
    tem(l2.selo, /texto promocional/, "e o motivo da Meta continua visivel — dentro do selo");
    // e quando o selo NAO carrega o motivo (motivo longo, truncado em 120 chars na
    // frase do status), os dois aparecem: mostrar demais, nunca esconder.
    const motivoLongo = "x".repeat(200);
    const l3 = linhasDoCatalogo([tpl("promo_longa", "Ola {{1}}.", { status: "recusado", motivo: motivoLongo })])[0];
    dep(l3.blocos.map((b) => b.tom), ["corpo", "motivo", "recusa"], "motivo longo: o paragrafo separado volta (nada e escondido)");
    eq(l3.blocos[1].texto, motivoLongo, "e ele traz o motivo INTEIRO, sem o corte de 120 da frase do status");

    // aprovado e usavel: nem recusa, nem motivo — so o corpo
    dep(linhasDoCatalogo([contiguo])[0].blocos.map((b) => b.tom), ["corpo"], "aprovado usavel: so o corpo, sem caixa vermelha");
    eq(linhasDoCatalogo([tpl("sem_corpo", "")])[0].blocos.length, 0, "template sem corpo nao desenha paragrafo vazio");
    dep(linhasDoCatalogo<TemplateCanal>([]), [], "catalogo vazio: nenhuma linha");
    dep(linhasDoCatalogo<TemplateCanal>(null), [], "catalogo ausente nao estoura a tela");

    // o rotulo do status vem da rota quando ela manda, e do mapa quando nao manda
    eq(linhasDoCatalogo([{ ...contiguo, rotulo_status: "aprovado pela Meta" }])[0].rotulo, "aprovado pela Meta", "o rotulo da rota vence");
    eq(linhasDoCatalogo([{ ...contiguo, status: "em_analise" as const }])[0].rotulo, ROTULO_STATUS.em_analise, "sem rotulo da rota, o do mapa");

    // VARREDURA DE FONTE, e ela e o PORTAO de UMA coisa so: o RESIDUO do JSX.
    //
    // Classificacao honesta (criterio da 4a revisao cega — apagar a asseracao e ver
    // se a propriedade continua provada):
    //
    //   - pra a REGRA (que selo existe se e so se a rota recusa, com a mesma frase)
    //     estas linhas sao CINTO: apagar todas nao tira prova nenhuma, porque a
    //     regra e comportamento em `linhasDoCatalogo`, acima.
    //   - pro RESIDUO (alguem escrever uma decisao NOVA dentro do JSX, ou peneirar
    //     os `blocos` na hora de desenhar) elas sao o PORTAO — nao existe segunda
    //     cobertura, porque nenhuma prova deste repo renderiza React: o harness
    //     roda `node --experimental-strip-types`, que nem parseia JSX.
    //
    // O portao fecha a FORMA, nao a classe (fechar a classe exige renderizar
    // React, outra entrega) — e a FORMA aqui e escrita pra NAO pinar identificador:
    // a 4a revisao cega mediu que pinos como `linhasDoCatalogo(lista).map(` e
    // `linha.blocos.map(` reprovavam refatoracao CORRETA (renomear o callback,
    // extrair `const linhas = ...`, `?? []`, copia `[...blocos]`) — e guarda que
    // acusa refatoracao correta ensina o proximo dev a afrouxa-la. Regra: guarda
    // de forma que reprovar renome/extracao se conserta na FORMA DA GUARDA, nunca
    // afrouxando a propriedade. Ver "Modelo de ameaca" no CLAUDE.md.
    const tela = semComentario(TELA);
    // a funcao pura e chamada na tela (sobrevive a renome do callback, const
    // intermediaria, useMemo e `?? []`)...
    tem(tela, /\blinhasDoCatalogo\s*\(/, "a tela desenha as linhas que a funcao pura devolveu");
    // ...e a tela NAO le os campos crus que ela substituiu — linha montada na mao
    // precisa deles pra desenhar detalhe e rotulo, entao some daqui se voltar.
    // (`.corpo` fica FORA do padrao de proposito: o formulario de criacao usa
    // `f.corpo` legitimamente — e linha montada na mao continua presa pelo rotulo,
    // que so existe em ROTULO_STATUS/.rotulo_status, e pelo detalhe, em
    // .variaveis/.cabecalho.)
    eq(
      /\bROTULO_STATUS\b|\.rotulo_status\b|\.variaveis\b|\.cabecalho\b/.test(tela),
      false,
      "e nao le os campos crus que a funcao pura substituiu — linha montada na mao reprova"
    );
    eq(
      /\.blocos\s*(?:\)|\])?\s*\.\s*(filter|slice|reverse|sort)\s*\(/.test(tela),
      false,
      "sem peneirar nem reordenar os `blocos` no JSX (quem decide o que aparece e a funcao pura)"
    );
    eq(
      /\bnumeracaoDoCorpo\s*\(|\bpodeEnviarTemplate\s*\(|\bmotivoParaNaoEnviarTemplate\s*\(/.test(tela),
      false,
      "e nao chama guarda nenhuma na mao — a ordem dos passos nao volta a viver no JSX"
    );
  }

  // ——— 7. O QUE CHEGA AO PROVEDOR (GRAVE da 4a revisao cega), por COMPORTAMENTO
  //
  // O texto GRAVADO e o texto ENVIADO ja estavam travados; o que sai pra Meta no
  // template, porem, nao e o `texto` — e o `params` do JSON do POST
  // (`corpoEnvioTemplate` casa por POSICAO). Ate a 3a revisao os `params` estavam
  // fechados so no NASCIMENTO (`tplEnvio` so nasce do veredito) e na FORMA da
  // chamada, e isso deixava passar o gesto mais plausivel do mundo naquele ponto do
  // codigo: mexer no `form` antes do POST. MEDIDO — colar
  // `form.set("template", JSON.stringify({ id: tpl.alvo.provider_id, params: [] }))`
  // imediatamente antes do envio deixava a bateria INTEIRA verde.
  //
  // As quatro linhas viraram `enviarTemplateProvado`, que recebe QUEM posta por
  // parametro. Aqui um postador falso guarda o `URLSearchParams` que saiu, e a
  // prova le o JSON de dentro dele: nada disto e varredura de fonte.
  {
    const cfg = { source: "5500000000000", appName: "app_expert" };
    const enviados: URLSearchParams[] = [];
    const postar = async (_creds: typeof cfg, form: URLSearchParams) => {
      enviados.push(form);
      return { status: 200, corpo: { messageId: "gs_mid_1" } };
    };

    const dec = decidirEnvioTemplate({ nome: "consulta_ok", params: ["Eric", "10/09"] }, catalogo(contiguo));
    eq(dec.ok, true, "o envio provado nasce da decisao (fixture do caminho legitimo)");
    const provado = (dec as any).envio;

    const r = await enviarTemplateProvado(cfg, "5511000000000", provado, postar);
    eq(enviados.length, 1, "uma chamada ao provedor por envio — nem zero, nem duas");
    const formEnviado = enviados[0];
    const enviado = JSON.parse(String(formEnviado.get("template")));
    dep(enviado.params, ["Eric", "10/09"], "os `params` que CHEGAM ao provedor sao os do envio PROVADO");
    eq(enviado.id, contiguo.provider_id, "e o id e o do alvo provado, nunca o nome");
    eq(formEnviado.get("destination"), "5511000000000", "o destino e o que a rota passou");
    eq(formEnviado.get("source"), cfg.source, "e a origem e o numero do canal");
    eq(formEnviado.get("src.name"), cfg.appName, "com o app do provedor junto");
    eq(r.messageId, "gs_mid_1", "e o messageId volta da resposta do provedor");
    // o que o cliente LE, montado com o que saiu de verdade no POST
    eq(
      renderComoProvedor(contiguo.corpo, enviado.params),
      provado.texto,
      "e o texto que o provedor montaria com esses params e o MESMO que o painel grava"
    );

    // template de IMAGEM: o link da arte viaja no `message`, senao a Meta dropa em
    // silencio. A guarda ja recusa imagem sem link; aqui o caminho COM link e medido.
    const decImg = decidirEnvioTemplate({ nome: "promo_arte", params: ["Eric"] }, catalogo(imgComLink));
    eq(decImg.ok, true, "template de imagem COM link passa pela decisao");
    await enviarTemplateProvado(cfg, "5511000000000", (decImg as any).envio, postar);
    eq(
      JSON.parse(String(enviados[1].get("message"))).image.link,
      imgComLink.midia_url,
      "e o POST leva o link da arte aprovada (sem ele a Meta aceita e descarta)"
    );

    // 202 SEM messageId E FALHA: "aceito na fila" nao e "virou mensagem".
    await estoura(
      () => enviarTemplateProvado(cfg, "5511000000000", provado, async () => ({ status: 202, corpo: {} })),
      /sem messageId/,
      "202 sem messageId estoura — nunca vira linha 'sent' na conversa"
    );
    await estoura(
      () => enviarTemplateProvado(cfg, "5511000000000", provado, async () => ({ status: 400, corpo: { message: "bad template" } })),
      /Gupshup 400/,
      "e o erro do provedor sobe com o codigo e a frase dele"
    );
  }
}

// PISO DA CONTAGEM (BAIXA 6 da 4a revisao cega).
//
// Ate aqui `assercoes` era so IMPRESSO: apagar metade da bateria nao reprovava
// nada, e o unico lugar onde o numero vivia era a prosa do CLAUDE.md — que nao
// executa. O piso e pregado no MEDIDO desta entrega. Ele NAO sobe sozinho (somar
// prova e livre e nao mexe aqui); o que ele barra e a bateria ENCOLHER — apagar
// bloco, comentar laco, um `return` cedo. Quem tirar prova de proposito atualiza
// esta linha, e ai a mudanca aparece no diff em vez de sumir na contagem.
const PISO_ASSERCOES = 552;
assert.ok(
  assercoes >= PISO_ASSERCOES,
  `a bateria ENCOLHEU: ${assercoes} assercoes, piso ${PISO_ASSERCOES} — apagar prova tem que reprovar`
);

console.log(`prova-canais-conexao: 18 blocos, ${assercoes} assercoes OK (piso ${PISO_ASSERCOES})`);
