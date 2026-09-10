// CONEXAO DO NUMERO e TROCA DE CHIP — REGRA PURA (cards 86ak858mx e 86ak858nx).
//
// Este arquivo NAO IMPORTA NADA de proposito, igual lib/escopo-chave.ts,
// lib/permissoes.ts e lib/fluxo/schema.ts: roda no Next e em node solto (a prova
// `node scripts/prova-canais-conexao.ts`). Tudo o que fala com provedor mora em
// lib/zapi.ts; tudo o que fala com banco mora em lib/canais-db.ts; a tela
// (app/admin-canais.tsx) so reflete o que sai daqui.
//
// POR QUE A REGRA SAI DA TELA — as duas partes que conseguem causar dano:
//
//  1. A IDADE DO QR. O card diz, com todas as letras, que o chamado "escanei e
//     nao funcionou" e quase sempre codigo expirado. Se a tela mostrasse um QR
//     velho sem dizer que ele venceu, o produto estaria mentindo pro cliente na
//     hora em que ele mais precisa de clareza.
//  2. A COMPARACAO DE NUMERO na conclusao da troca. Concluir a troca com o chip
//     ERRADO conectado grava numero errado no canal e manda a operacao atender
//     por um numero que ninguem quis — e o inverso (recusar uma troca legitima
//     porque o cliente digitou o numero sem o 9) e um lockout bobo. As duas
//     bordas moram em `mesmoNumero`, com teste.

// ————————————————————————————————————————————————————————— o QR e a idade
//
// O QR do WhatsApp gira sozinho a cada ~20s: o codigo que esta na tela hoje nao
// serve amanha, nem daqui a meio minuto. O painel entao NAO guarda QR — ele
// pede um novo ao provedor quando o que esta na tela vence, e carimba a hora em
// que pediu. Este numero e o teto de confianca desse carimbo.
export const SEGUNDOS_QR_VALIDO = 20;

/**
 * A CADENCIA, decidida e escrita (a revisao cobrou a decisao, com razao).
 *
 * O card pede "polling do QR a cada ~4 segundos". Tomado ao pe da letra isso e
 * ERRADO, e o motivo e mecanico: **pedir um QR novo INVALIDA o anterior** no
 * provedor. Um pedido a cada 4s com um QR que vale 20s significa que, das cinco
 * imagens que a pessoa ve por ciclo, quatro morrem antes de ela terminar de
 * apontar a camera — o cliente escaneia um codigo que acabou de ser invalidado
 * pelo nosso proprio polling, e o sintoma e exatamente o chamado que este card
 * existe pra matar ("escaneei e nao funcionou").
 *
 * Entao a cadencia e: **pedir QR novo SO quando o atual vence** (`deveRenovarQr`),
 * e o que roda a cada poucos segundos e o polling de ESTADO — que e barato, nao
 * mexe em nada no pareamento e e o que fecha o modal quando conecta. A tela conta
 * os segundos na frase com um relogio local; o carimbo continua sendo do servidor.
 *
 * `INTERVALO_ACAO.qr` abaixo e o piso de seguranca (duplo-clique, duas abas), nao
 * a cadencia: quem manda na cadencia e esta funcao.
 */
export function deveRenovarQr(geradoEm: unknown, agora: Date = new Date()): boolean {
  // sem QR na tela, pede (e o primeiro). Com QR vencido, pede outro.
  return qrExpirado(geradoEm, agora);
}

/**
 * O `value` que a Z-API devolveu e mesmo uma imagem base64, e nao outra coisa?
 *
 * Este valor vai DIRETO pro `src` de um `<img>`. Sem a conferencia, o dia em que o
 * provedor (ou um proxy no caminho) devolver texto no lugar da imagem, o painel
 * injeta no atributo o que vier — `data:text/html`, `javascript:` e afins. Nao e
 * paranoia com o fornecedor: e que `src` de imagem e superficie de injecao, e o
 * conteudo vem de fora. Fail-closed: o que nao casa nao vira imagem, e a tela diz
 * que nao conseguiu o codigo.
 */
const QR_DATA_URI = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/;

export function qrValido(v: unknown): boolean {
  return typeof v === "string" && v.length > 32 && v.length < 5_000_000 && QR_DATA_URI.test(v);
}

/** Segundos desde que o QR foi gerado. `null` = carimbo ilegivel ou ausente. */
export function idadeQr(geradoEm: unknown, agora: Date = new Date()): number | null {
  if (geradoEm == null || geradoEm === "") return null;
  const t = geradoEm instanceof Date ? geradoEm.getTime() : Date.parse(String(geradoEm));
  if (Number.isNaN(t)) return null;
  // carimbo no FUTURO (relogio do servidor a frente do da tela) vira 0, nunca
  // negativo: "gerado em -3s" nao quer dizer nada pra quem le.
  return Math.max(0, Math.floor((agora.getTime() - t) / 1000));
}

/**
 * O QR que esta na tela ja venceu?
 *
 * FAIL-CLOSED: carimbo ilegivel conta como EXPIRADO. Preferimos mandar o cliente
 * gerar outro codigo (custa um clique) a deixar ele escanear um codigo morto e
 * concluir que o produto esta quebrado.
 */
export function qrExpirado(geradoEm: unknown, agora: Date = new Date()): boolean {
  const s = idadeQr(geradoEm, agora);
  if (s === null) return true;
  return s > SEGUNDOS_QR_VALIDO;
}

/** A frase que fica embaixo do QR. E o antidoto do "escaneei e nao funcionou". */
export function rotuloIdadeQr(geradoEm: unknown, agora: Date = new Date()): string {
  const s = idadeQr(geradoEm, agora);
  if (s === null) return "gerando o codigo...";
  if (qrExpirado(geradoEm, agora)) return "este codigo expirou — buscando um novo";
  if (s <= 1) return "codigo gerado agora";
  return `codigo gerado ha ${s} segundos`;
}

// ——————————————————————————————— o `?canal=` obrigatorio, como FLUXO
//
// A guarda "esta rota nao assume um numero padrao" era provada por GREP DE FRASE
// (a prova procurava o texto no fonte) — e a revisao cega mostrou o obvio:
// mutacao que apaga a guarda e deixa o comentario passa batido. Frase nao e
// comportamento. Agora a decisao e uma FUNCAO, as tres rotas chamam ELA, e a
// prova exercita o fluxo.
//
// Por que 400 e nao 404 pra id malformado: id fora do formato e erro do PEDIDO
// (consertavel por quem chamou), enquanto "id valido que nao existe nesta
// instalacao" e 404 e sai da porta, depois do registro. A separacao tambem evita
// que a mensagem de 404 vire oraculo: texto arbitrario do pedinte nunca e ecoado
// de volta junto de "nao existe".
export type RecusaCanal = { ok: false; status: 400; erro: string };
export type VereditoCanalPedido = { ok: true; id: string } | RecusaCanal;

// mesmo formato de id que `lib/canais.ts` aceita no registro (ID_RE) — regua
// unica, senao existe id que o registro aceita e a rota recusa
const ID_CANAL = /^[a-z][a-z0-9_]{1,30}$/;

export function canalObrigatorio(pedido: unknown): VereditoCanalPedido {
  const id = typeof pedido === "string" ? pedido.trim() : "";
  if (!id) {
    return {
      ok: false,
      status: 400,
      erro: "informe o canal (numero) — esta rota nao assume um numero padrao",
    };
  }
  if (!ID_CANAL.test(id)) {
    return { ok: false, status: 400, erro: "identificador de canal invalido" };
  }
  return { ok: true, id };
}

// ————————————————— o CORPO tem que se DECLARAR JSON (415), e isso e seguranca
//
// Achado GRAVE da 3a revisao cega, e ele e o D1 de volta por outra porta. Havia
// DUAS leituras do MESMO corpo, e elas DISCORDAVAM:
//
//   canalDoPedido (a porta da CHAVE, lib/canais.ts) so olhava o corpo quando o
//   content-type se dizia JSON;
//   portaDoCorpo (lib/canais-porta.ts) parseava o corpo SEM conferir header nenhum.
//
// Entao um `curl -d` — que manda `application/x-www-form-urlencoded` por DEFAULT —
// com corpo JSON valido dava exatamente isto:
//
//   canalDoPedido -> nao le o corpo   -> canal do pedido = null
//   escopoPermite -> canal null       -> NAO COMPARA NADA
//   portaDoCorpo  -> parseia o MESMO corpo -> opera o canal que veio nele
//
// Ou seja: chave escopada a ["central"] desconectando o `apioficial` de novo — o
// dano inteiro do D1, agora por um HEADER em vez de por uma corrida de leitura.
//
// A raiz foi fechada nas DUAS pontas, porque uma ponta so e remendo: (1)
// `canalDoPedido` passou a ler o corpo de TODO metodo que muda estado (menos
// upload, que e multipart e bufferizar la custa memoria); (2) o corpo de rota de
// canal tem que se declarar JSON, e esta e a funcao que decide isso. As duas
// pontas passaram a ler A MESMA COISA.
//
// Nao ha cliente legitimo pra recusar: a tela manda `Content-Type:
// application/json` nos quatro POST que existem (e os DELETE nao tem corpo, entram
// por `portaDoCanal`). 415 e nao 400 porque e literalmente isso — "media type nao
// suportado".
//
// Funcao PURA de proposito, mesma razao de `canalObrigatorio`: guarda que vive
// dentro de arquivo que nenhuma prova carrega (especificador sem extensao + alias
// `@/`) e guarda que nenhuma prova alcanca,
// e a revisao ja mediu duas vezes o preco disso.
export type RecusaCorpo = { ok: false; status: 415; erro: string };
export type VereditoCorpoJson = { ok: true } | RecusaCorpo;

// `application/json` e os tipos com sufixo `+json` (application/vnd.x+json). O
// parametro (`; charset=utf-8`) e cortado antes de comparar.
const MEDIA_JSON = /^application\/(json|[a-z0-9.\-+]*\+json)$/;

export function corpoJsonObrigatorio(contentType: unknown): VereditoCorpoJson {
  const bruto = typeof contentType === "string" ? contentType : "";
  const media = bruto.split(";")[0].trim().toLowerCase();
  // FAIL-CLOSED: header ausente tambem e recusa. "Sem content-type" e o caso do
  // cliente que nao sabe o que esta mandando, e e justamente ali que o corpo
  // JSON entrava sem a porta da chave ter olhado pra ele.
  if (MEDIA_JSON.test(media)) return { ok: true };
  return {
    ok: false,
    status: 415,
    erro: "o corpo desta rota tem que ser JSON — mande content-type: application/json",
  };
}

// —————————————————————————————————————————————————————————————— o numero
//
// DDI+DDD+numero, so digitos. O teto de 15 e o do E.164; o piso de 10 e o que a
// rota de envio ja usa (`DESTINO_VALIDO` em /api/send) — mesma regua nas duas
// pontas, pra nao existir numero que o painel aceita conectar e recusa atender.
const SO_DIGITOS = /^\d{10,15}$/;

/** Digitos do numero, ou `null` quando nao da pra ler um numero dali. */
export function normalizarNumero(bruto: unknown): string | null {
  if (typeof bruto !== "string" && typeof bruto !== "number") return null;
  const d = String(bruto).replace(/\D+/g, "");
  return SO_DIGITOS.test(d) ? d : null;
}

/** Numero formatado pra LER na tela: +55 11 91234-5678. Nunca esconde digito. */
export function formatarNumero(bruto: unknown): string {
  const n = normalizarNumero(bruto);
  if (!n) return typeof bruto === "string" && bruto.trim() ? bruto.trim() : "—";
  if (n.startsWith("55") && (n.length === 12 || n.length === 13)) {
    const ddd = n.slice(2, 4);
    const resto = n.slice(4);
    const corte = resto.length - 4;
    return `+55 ${ddd} ${resto.slice(0, corte)}-${resto.slice(corte)}`;
  }
  return `+${n}`;
}

/**
 * "E o mesmo numero?" — com a tolerancia do NONO DIGITO brasileiro, e so dela.
 *
 * O caso real: o administrador digita `1191234-5678` de um jeito e o provedor
 * devolve de outro. No Brasil o celular ganhou um 9 na frente do numero local em
 * 2012, e conviver com as duas grafias e o normal: `5511912345678` (13 digitos) e
 * `551112345678` (12) sao o MESMO telefone quando o unico delta e esse 9.
 *
 * Por que a tolerancia e estreita de proposito: qualquer folga a mais aqui vira
 * "concluiu a troca com o chip errado". Entao a regra e exata em tudo — DDI, DDD,
 * quantidade de digitos — e cede SO nesse 9, SO em numero 55, SO na transicao
 * 12<->13 digitos. Fora disso, diferente e diferente.
 */
export function mesmoNumero(a: unknown, b: unknown): boolean {
  const x = normalizarNumero(a);
  const y = normalizarNumero(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const curto = x.length < y.length ? x : y;
  const longo = x.length < y.length ? y : x;
  if (curto.length !== 12 || longo.length !== 13) return false;
  if (!curto.startsWith("55") || !longo.startsWith("55")) return false;
  if (curto.slice(0, 4) !== longo.slice(0, 4)) return false; // DDI + DDD iguais
  // o longo e o curto com um 9 enfiado logo depois do DDD
  return longo.slice(4) === `9${curto.slice(4)}`;
}

// ————————————————————————————————————————————— o estado da conexao
//
// Cada provedor conta o estado do jeito dele. O painel fala UMA lingua, e e esta.
export type Situacao =
  | "conectado" // o chip esta na instancia e pronto pra atender
  | "sem_celular" // conectado na instancia, mas o aparelho esta fora do ar
  | "desconectado" // precisa ler o QR / digitar o codigo
  | "erro" // o provedor respondeu, e respondeu problema
  | "desconhecido"; // nao deu pra ler o estado (rede, formato novo)

export type EstadoConexao = {
  situacao: Situacao;
  conectado: boolean;
  /** numero que o provedor diz estar conectado (so digitos), quando ele diz */
  numero: string | null;
  /** frase curta pra tela — nunca texto cru de API na cara do usuario */
  detalhe: string;
};

const FRASE: Record<Situacao, string> = {
  conectado: "numero conectado e atendendo",
  sem_celular: "conectado, mas o celular esta fora do ar — abra o WhatsApp no aparelho",
  desconectado: "desconectado — leia o QR Code ou use o codigo de 8 digitos",
  erro: "o provedor recusou a consulta de estado",
  desconhecido: "nao consegui ler o estado deste numero agora",
};

/**
 * Le o `/status` da Z-API (`{connected, smartphoneConnected, error}`) e o
 * `/device` (`{phone}`) no vocabulario do painel.
 *
 * A ordem das perguntas importa: `error` vem ANTES de `connected`, porque a
 * Z-API manda os dois no mesmo corpo em instancia com problema — e ler
 * `connected:false` como "leia o QR" mandaria o cliente escanear um codigo que
 * nunca vai funcionar, em vez de mostrar o problema.
 */
export function estadoZapi(status: unknown, device?: unknown): EstadoConexao {
  const s = (status && typeof status === "object" ? status : {}) as Record<string, unknown>;
  const d = (device && typeof device === "object" ? device : {}) as Record<string, unknown>;
  const numero = normalizarNumero(d.phone ?? s.phone ?? null);

  const erro = typeof s.error === "string" ? s.error.trim() : "";
  if (erro) {
    return { situacao: "erro", conectado: false, numero, detalhe: traduzirErroZapi(erro) };
  }
  if (s.connected === true) {
    // `smartphoneConnected` AUSENTE nao e "celular fora do ar": instancia
    // conectada por versao antiga da API nao manda o campo. So `false` explicito
    // vira aviso — inventar aviso e ensinar o usuario a ignorar aviso.
    const sit: Situacao = s.smartphoneConnected === false ? "sem_celular" : "conectado";
    return { situacao: sit, conectado: true, numero, detalhe: FRASE[sit] };
  }
  if (s.connected === false) {
    return { situacao: "desconectado", conectado: false, numero, detalhe: FRASE.desconectado };
  }
  return { situacao: "desconhecido", conectado: false, numero, detalhe: FRASE.desconhecido };
}

/**
 * Erro cru da Z-API -> frase de gente. O que nao esta no mapa sai como
 * "o provedor recusou..." + o texto cru CURTO: esconder o texto inteiro atrapalha
 * o suporte, e jogar um JSON de 2KB na tela atrapalha o cliente.
 */
export function traduzirErroZapi(bruto: unknown): string {
  const t = String(bruto ?? "").trim();
  if (!t) return FRASE.erro;
  if (/you are already connected|already connected/i.test(t)) {
    return "este numero ja esta conectado — nao precisa ler o QR de novo";
  }
  if (/not found|instance.*not.*exist/i.test(t)) {
    return "a instancia deste numero nao existe mais no provedor — confira a configuracao da instalacao";
  }
  if (/token|unauthor|forbidden/i.test(t)) {
    return "o provedor recusou a credencial deste numero — confira a configuracao da instalacao";
  }
  if (/disconnected|not connected/i.test(t)) return FRASE.desconectado;
  return `${FRASE.erro}: ${t.slice(0, 120)}`;
}

/**
 * O provedor APLICOU a acao, ou so respondeu?
 *
 * Achado D7 da 2a revisao. A rota decidia isso por `!!r.corpo?.error` — ou seja,
 * confiava em um CAMPO do corpo pra saber se um POST HTTP funcionou. Um 502 de
 * proxy morto, um 504 de gateway ou um 429 do provedor NAO trazem esse campo, e a
 * trilha gravava "Ana desconectou o numero" com o numero seguindo conectado.
 * Trilha que registra a INTENCAO como se fosse o FATO e pior que trilha faltando:
 * ela mente com autoridade, e e ela que alguem vai ler pra entender o incidente.
 *
 * Agora sao DOIS sinais, e qualquer um dos dois condena: campo `error` no corpo OU
 * status fora da familia 2xx (`status: 0` = excecao de rede, tambem recusa).
 *
 * Funcao PURA de proposito: era guarda dentro do handler, invisivel pra prova, e a
 * revisao mostrou que "sem o rotulo `recusado`" passava a bateria verde.
 */
export function provedorRecusou(r: { status?: unknown; corpo?: any }): {
  recusado: boolean;
  motivo: string;
} {
  const erro = String(r?.corpo?.error ?? "").trim();
  const status = Number(r?.status);
  const httpOk = Number.isFinite(status) && status >= 200 && status < 300;
  const recusado = !!erro || !httpOk;
  if (!recusado) return { recusado: false, motivo: "" };
  return {
    recusado: true,
    motivo: erro
      ? traduzirErroZapi(erro)
      : `o provedor respondeu ${Number.isFinite(status) && status ? status : "nada"} e nao confirmou a acao`,
  };
}

/**
 * Este evento e TRANSICAO (fato novo) ou repeticao do que a trilha ja diz?
 *
 * Usada pelos eventos que o polling reavalia toda rodada (`troca_divergente`):
 * sem ela, a revisao mediu ~1.028 linhas/hora com UM chip errado plugado, e a
 * trilha — o lugar onde alguem procura "de qual numero pra qual" — afogava.
 *
 * A IDENTIDADE DO ESTADO E `tipo` + `de`, e o `de` nao e detalhe (achado D6): no
 * `troca_divergente` o `de` E o chip errado que apareceu. Comparando so o tipo,
 * dois aparelhos errados DIFERENTES na mesma troca geravam UMA linha — a trilha
 * dizia que o segundo nunca existiu, e "quantos numeros tentaram entrar aqui?" e
 * exatamente a pergunta da apuracao.
 *
 * `ultimo === null` = nao deu pra ler a trilha. Devolve false: na duvida, perder
 * uma linha e melhor que voltar a inundar.
 */
export function ehTransicao(
  ultimo: { tipo: string; de: string | null } | null,
  ev: { tipo: string; de?: string | null }
): boolean {
  if (ultimo === null) return false;
  const mesmoTipo = ultimo.tipo === String(ev.tipo);
  const mesmoDe = (ultimo.de ?? null) === (ev.de ?? null);
  return !(mesmoTipo && mesmoDe);
}

export function estadoDesconhecido(motivo?: string): EstadoConexao {
  return {
    situacao: "desconhecido",
    conectado: false,
    numero: null,
    detalhe: motivo?.trim() || FRASE.desconhecido,
  };
}

// ——————————————————————————————————————————————————————————— o segredo
/**
 * Identificador de instancia pra MOSTRAR na tela sem virar vazamento.
 *
 * A instancia nao e senha (o token e), mas ela identifica a conta do cliente no
 * provedor e nao tem por que aparecer inteira numa tela que alguem compartilha
 * em call de suporte. Mostrar as pontas basta pro que a tela precisa: dizer se a
 * instancia MUDOU depois de uma troca de chip.
 */
export function mascararInstancia(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "—";
  if (s.length <= 8) return `${s.slice(0, 2)}…`;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// ——————————————————————————————————————————————— troca de numero (chip)
//
// A ENTIDADE canal NAO MUDA. Isso e a feature inteira: as conversas e as
// mensagens moram em tabelas nomeadas pelo ID do canal (lib/canais.ts,
// `tabelas`), e o id nao entra na troca em nenhum momento. Trocar o chip mexe no
// NUMERO e na credencial da instalacao; o historico nem sabe que houve troca.
export type TrocaPendente = {
  /** numero que o administrador declarou que vai entrar (so digitos) */
  numero_novo: string;
  /** numero que estava no canal quando a troca comecou (pode ser "" na 1a vez) */
  numero_anterior: string;
  iniciada_em: string;
  iniciada_por: string;
  iniciada_por_nome: string;
};

export type ErroTroca = { campo: "numero_novo" | "consentimento"; texto: string };

/**
 * Pode ABRIR uma troca com estes dados?
 *
 * As duas guardas do card, e nenhuma a mais:
 *  - numero novo tem que ser numero;
 *  - o consentimento tem que estar marcado, EXPLICITO. Trocar chip nao e editar
 *    campo: o canal para de atender ate alguem ler um QR com o aparelho na mao.
 *
 * Numero novo IGUAL ao atual tambem e recusado — abrir troca pro mesmo numero
 * poe o canal em estado pendente sem nada pra ganhar, e o cliente ficaria
 * olhando um aviso de "troca em andamento" que nunca conclui.
 */
export function validarTroca(pedido: {
  numero_novo?: unknown;
  consentimento?: unknown;
  numero_atual?: unknown;
}): ErroTroca[] {
  const erros: ErroTroca[] = [];
  const novo = normalizarNumero(pedido.numero_novo);
  if (!novo) {
    erros.push({
      campo: "numero_novo",
      texto: "informe o numero novo com DDI e DDD, so digitos (ex.: 5511912345678)",
    });
  } else if (mesmoNumero(novo, pedido.numero_atual)) {
    erros.push({
      campo: "numero_novo",
      texto: "este ja e o numero do canal — nao ha o que trocar",
    });
  }
  if (pedido.consentimento !== true) {
    erros.push({
      campo: "consentimento",
      texto: "marque a confirmacao: o canal fica fora do ar ate o chip novo conectar",
    });
  }
  return erros;
}

export type VereditoTroca =
  | { acao: "nada"; aviso: null }
  | { acao: "aguardar"; aviso: string }
  | { acao: "divergente"; aviso: string }
  | { acao: "concluir"; aviso: null; numero: string };

/**
 * A troca pendente pode ser CONCLUIDA com o que esta conectado agora?
 *
 * Quem chama e o GET de estado (`/api/canais/conexao`), a cada rodada de
 * polling: e o unico lugar que sabe, ao mesmo tempo, o que o provedor diz e o
 * que o administrador declarou. Concluir e efeito de CONECTAR, nao de clicar em
 * botao — o card e explicito: "o usuario nao clica em confirmar".
 *
 * Os quatro caminhos, e por que cada um:
 *  - `nada`: nao ha troca pendente. Nada a fazer.
 *  - `aguardar`: ainda nao conectou (ou o provedor nao disse o numero). Nao
 *    concluir por falta de informacao e o unico jeito seguro: concluir no escuro
 *    gravaria como "numero novo" um numero que ninguem conferiu.
 *  - `divergente`: conectou um chip DIFERENTE do declarado. A troca NAO conclui
 *    e o usuario e avisado com os dois numeros na frase — foi criterio de aceite
 *    do card, e e o caso que mais acontece na pratica (o cliente pega o celular
 *    errado da mesa).
 *  - `concluir`: bate. Quem chama grava o numero, fecha a pendencia e carimba a
 *    trilha.
 */
export function vereditoDaTroca(
  pendente: TrocaPendente | null | undefined,
  estado: EstadoConexao
): VereditoTroca {
  if (!pendente || !normalizarNumero(pendente.numero_novo)) return { acao: "nada", aviso: null };
  if (!estado.conectado) {
    return {
      acao: "aguardar",
      aviso: `troca em andamento: leia o QR Code no aparelho do numero ${formatarNumero(pendente.numero_novo)}`,
    };
  }
  if (!estado.numero) {
    return {
      acao: "aguardar",
      aviso:
        "conectou, mas o provedor ainda nao informou qual numero — a troca so conclui quando der pra conferir",
    };
  }
  if (!mesmoNumero(estado.numero, pendente.numero_novo)) {
    return {
      acao: "divergente",
      aviso:
        `conectou o numero ${formatarNumero(estado.numero)}, e a troca foi aberta pro ` +
        `${formatarNumero(pendente.numero_novo)} — a troca NAO foi concluida. Desconecte e conecte o chip certo, ` +
        "ou cancele a troca e abra outra com o numero que voce quer de verdade.",
    };
  }
  return { acao: "concluir", aviso: null, numero: normalizarNumero(estado.numero)! };
}

// ————————————————————————————————————————————————————————— a trilha
export type TipoEvento =
  | "troca_iniciada"
  | "troca_concluida"
  | "troca_cancelada"
  | "troca_divergente"
  | "conectado"
  // chip DIFERENTE conectado sem ninguem ter aberto troca — ver `descreverEvento`
  | "numero_trocado_sem_troca"
  | "desconectado"
  | "reiniciado"
  | "codigo_pedido"
  | "templates_sincronizados"
  | "template_apagado";

export type EventoCanal = {
  tipo: TipoEvento | string;
  de?: string | null;
  para?: string | null;
  // convencao de autor da 0006/0019: id nulo com nome preenchido = automacao;
  // os dois nulos = o painel carimbou sozinho (a conclusao da troca, por
  // exemplo, acontece por CONECTAR e nao por clique de ninguem)
  autor_id?: string | null;
  autor_nome?: string | null;
  criada_em?: string | null;
  detalhe?: Record<string, unknown> | null;
};

/**
 * Uma linha do historico do canal, em portugues de gente.
 *
 * Isto e o "quem trocou, quando, de que numero pra qual" do card. Fica PURO
 * porque e a mesma frase na tela, no relato de erro da rota e em qualquer
 * export futuro — frase copiada diverge sozinha (licao que este repo ja pagou
 * com a assinatura de mensagem, `textoComAssinatura`).
 */
/** A acao foi RECUSADA pelo provedor? (carimbado pela rota em `detalhe`) */
function recusado(ev: EventoCanal): boolean {
  return (ev.detalhe as any)?.recusado === true;
}

/** O motivo da recusa, curto e entre parenteses — ou nada. */
function motivo(ev: EventoCanal): string {
  const m = String((ev.detalhe as any)?.motivo ?? "").trim();
  return m ? ` (${m.slice(0, 120)})` : "";
}

export function descreverEvento(ev: EventoCanal): string {
  const quem = (ev.autor_nome || "").trim() || "alguem";
  const de = ev.de ? formatarNumero(ev.de) : null;
  const para = ev.para ? formatarNumero(ev.para) : null;
  switch (ev.tipo) {
    case "troca_iniciada":
      return de
        ? `${quem} abriu a troca de ${de} para ${para}`
        : `${quem} abriu a conexao do numero ${para}`;
    case "troca_concluida":
      return de
        ? `troca concluida: o canal passou de ${de} para ${para}`
        : `numero ${para} conectado ao canal`;
    case "troca_cancelada":
      return `${quem} cancelou a troca para ${para}`;
    case "troca_divergente":
      return `conectou ${de}, mas a troca era pro ${para} — nao concluida`;
    case "conectado":
      return para ? `numero ${para} conectado` : "numero conectado";
    case "numero_trocado_sem_troca":
      // A LINHA MAIS IMPORTANTE DA TRILHA, e ela nasceu de um achado de revisao: o
      // painel reescrevia o numero do canal EM SILENCIO quando alguem lia o QR com
      // um chip diferente sem abrir troca. A operacao passa a atender por outro
      // numero e a unica pista era o campo mudando sozinho. Agora vira evento com
      // o DE e o PARA — e a tela mostra em destaque.
      return de
        ? `ATENCAO: o numero do canal passou de ${de} para ${para} FORA do fluxo de troca ` +
            "(alguem conectou outro chip direto, sem abrir troca)"
        : `numero ${para} conectado sem passar pelo fluxo de troca`;
    // TRILHA HONESTA: o provedor pode RECUSAR a acao. Antes, o evento entrava
    // igual e a trilha dizia "Ana desconectou o numero" com o numero seguindo
    // conectado — trilha que registra a intencao como se fosse o fato mente com
    // autoridade, e e pior que trilha faltando. `detalhe.recusado` muda a frase.
    case "desconectado":
      return recusado(ev)
        ? `${quem} TENTOU desconectar o numero${de ? ` ${de}` : ""}, e o provedor recusou${motivo(ev)}`
        : `${quem} desconectou o numero${de ? ` ${de}` : ""}`;
    case "reiniciado":
      return recusado(ev)
        ? `${quem} TENTOU reiniciar a conexao, e o provedor recusou${motivo(ev)}`
        : `${quem} reiniciou a conexao do numero`;
    case "codigo_pedido":
      return `${quem} pediu o codigo de 8 digitos para ${para}`;
    case "templates_sincronizados": {
      const n = Number((ev.detalhe as any)?.quantidade);
      return Number.isFinite(n)
        ? `${quem} sincronizou os templates (${n} no provedor)`
        : `${quem} sincronizou os templates`;
    }
    case "template_apagado": {
      const nome = String((ev.detalhe as any)?.nome ?? "").trim();
      return nome ? `${quem} apagou o template "${nome}"` : `${quem} apagou um template`;
    }
    default:
      // tipo que ESTA versao da tela nao conhece (a Frente que plugar Evolution
      // vai carimbar os seus). Sai legivel em vez de sumir: trilha que esconde
      // linha que nao entende e trilha que mente por omissao.
      return `${quem}: ${String(ev.tipo)}`;
  }
}

// ————————————————————————————————————————————————————————— as acoes
//
// Lista fechada, conferida na ROTA. Sem ela, `acao` vira string livre indo pra
// um switch — e o dia em que o switch ganha um default generoso, qualquer texto
// aciona qualquer coisa.
export const ACOES_CONEXAO = ["estado", "qr", "codigo", "desconectar", "reiniciar"] as const;
export type AcaoConexao = (typeof ACOES_CONEXAO)[number];

export function ehAcaoConexao(v: unknown): v is AcaoConexao {
  return typeof v === "string" && (ACOES_CONEXAO as readonly string[]).includes(v);
}

/**
 * Esta acao MEXE no provedor?
 *
 * `estado` nao mexe no provedor — mas mexe NO PAINEL (e a acao que carimba o
 * numero conectado e CONCLUI a troca pendente), e e por isso que ela e POST e nao
 * GET. Uma chave `somente_leitura` nao pode concluir troca de chip nem por
 * acidente, e o GET desta rota existe justamente pra observar sem aplicar nada.
 */
export function acaoMuda(a: AcaoConexao): boolean {
  return a !== "estado";
}

/**
 * Intervalo minimo entre duas chamadas da mesma acao, no mesmo canal (ms).
 *
 * PISO DE CHAMADAS AO PROVEDOR, nao cadencia de tela — quem manda na cadencia e a
 * tela (e, no caso do QR, `deveRenovarQr`). O piso existe pra duplo-clique, duas
 * abas abertas e o "conferir agora" clicado em sequencia nao virarem N sessoes de
 * pareamento nem N chamadas cobradas.
 *
 * O numero do `estado` tem uma restricao que os outros nao tem: ele e a acao que a
 * tela chama EM LOOP (~3,5s com o modal aberto), e passar do piso responde 429. Ou
 * seja, ele precisa ficar CONFORTAVELMENTE ABAIXO da cadencia da tela — se algum
 * dia esse loop acelerar, o piso tem que descer junto, senao a tela passa a
 * mostrar erro no caminho felz. Um segundo cabe: corta rajada de clique e de aba
 * duplicada, e nunca alcanca o loop de 3,5s de uma aba sozinha.
 *
 * (Duas abas no MESMO canal ainda podem, por azar de fase, cair dentro do mesmo
 * segundo. Por isso a tela IGNORA o 429 desta acao em vez de pintar erro vermelho:
 * ela mantem o ultimo estado conhecido e tenta de novo no proximo ciclo — ver o
 * polling de ESTADO em app/admin-canais.tsx.)
 */
export const INTERVALO_ACAO: Record<AcaoConexao, number> = {
  estado: 1_000,
  // o QR gira a cada ~20s. O piso e um respiro pra um duplo-clique ou duas abas
  // nao virarem duas sessoes de pareamento.
  qr: 2_500,
  // o codigo de 8 digitos ACENDE UMA NOTIFICACAO no celular do cliente. Pedir de
  // novo a cada segundo transforma o painel em maquina de incomodar quem esta com
  // o aparelho na mao — e cada pedido invalida o codigo anterior, ou seja,
  // repetir rapido garante que NENHUM codigo funcione.
  codigo: 25_000,
  desconectar: 5_000,
  reiniciar: 15_000,
};

// ——————————————————————————————————————————— o que cabe a cada fonte
//
// Conectar por QR e propriedade do provedor, nao do produto:
//  - `zapi`: a conexao E o QR/codigo desta tela (endpoints nativos).
//  - `gupshup`: numero da API Oficial e homologado junto da Meta, com processo
//    proprio — NAO existe QR. Dizer isso na tela e melhor que esconder o botao:
//    o cliente que veio do ChatGuru procura o QR aqui.
//  - `evolution`: tem conexao por QR na API dela, mas ESTA FRENTE nao cabeou (o
//    card e "Z-API nativo"). Fica declarado, nao inventado.
//  - fonte externa (`instagram-agent`): a conexao mora no outro sistema.
export type MotivoSemConexao = { pode: false; motivo: string };
export function conexaoDaFonte(fonte: unknown): { pode: true } | MotivoSemConexao {
  switch (fonte) {
    case "zapi":
      return { pode: true };
    case "gupshup":
      return {
        pode: false,
        motivo:
          "numero da API Oficial nao conecta por QR Code: a habilitacao e feita junto da Meta, pelo provedor. " +
          "Aqui voce administra os templates dele.",
      };
    case "evolution":
      return {
        pode: false,
        motivo:
          "conexao por QR em numero Evolution ainda nao esta ligada neste painel — conecte pelo painel da sua Evolution API.",
      };
    case "instagram-agent":
      return { pode: false, motivo: "este canal e somente leitura: a conexao dele mora no Instagram Agent." };
    case "whatsapp-agent":
      return { pode: false, motivo: "a conexao deste numero mora no WhatsApp Agent: o QR e lido pelo agente, nao por aqui." };
    default:
      return { pode: false, motivo: "este canal nao tem conexao administravel pelo painel." };
  }
}
