// COMPATIBILIDADE DE FORMATO na saida de webhook (card 86ak85apk).
//
// O PROBLEMA, medido: as acoes "chamar sistema externo" (`CRM` / `POST PARA URL`)
// da conta medida apontam pra **72 URLs distintas**, quase todas em servicos de
// automacao de terceiro (`hook.us1.make.com`, `hook.integromat.com`, n8n
// proprio). Esses cenarios continuam vivos depois da migracao — mas quem passa a
// chama-los e o Expert Chat, e **se o nosso corpo for diferente do da ferramenta
// antiga, os 72 param de funcionar em silencio**: o Make responde 200 pra
// qualquer corpo e simplesmente nao acha os campos que o cenario le.
//
// ————————————————————————————————————————————————————————————————————————
// O QUE NAO EXISTE, E POR QUE ISTO NAO E UM "MODO CHATGURU"
//
// Varredura de 31/08/2026 (33 backups exportados da ferramenta antiga): **o corpo que a ferramenta
// antiga POSTA nao esta registrado em lugar nenhum.** O que existe no backup e o
// formulario de CONFIGURACAO da acao — os 7 campos `crm.name`, `crm.url`,
// `crm.campanha_id`, `crm.campanha_nome`, `crm.origem`, `crm.token_publico`,
// `crm.token_privado` — que sao ENTRADA pro servidor deles, nao o formato de
// saida. Nenhuma requisicao de saida foi capturada (e nao poderia: e
// servidor-a-servidor, invisivel pro navegador que gerou o backup) e nao existe
// blueprint de cenario do Make em disco. `docs/mapa/06-conversor.md` recomenda
// "enviar um corpo no mesmo formato do deles" e **nunca diz qual e**.
//
// Entao a escolha honesta e esta: **nao existe modo "chatguru" aqui.** Um modo
// com esse nome seria um chute com carimbo de compatibilidade — e chute que nao
// casa falha do jeito pior possivel (HTTP 200, cenario silencioso, ninguem sabe
// por quanto tempo). O que existe e um **mapa de campos DECLARADO** por quem faz
// a virada: ele abre UM dos cenarios, ve quais chaves aquele cenario le, e
// declara. Uma vez por formato, nao uma vez por cenario.
//
// COMO DESCOBRIR O FORMATO DE VERDADE (as duas unicas rotas, nesta ordem):
//  1. abrir um dos cenarios no Make e ler a "data structure" do webhook, ou o
//     bundle de entrada de uma execucao passada — o Make guarda o corpo recebido;
//  2. apontar UM `crm.url` pra um receptor temporario e disparar o dialogo 1x.
// Nada em disco responde isso. Esta pendencia esta declarada em
// `docs/webhooks-saida.md` e no relatorio de conversao (que lista as URLs).
//
// ————————————————————————————————————————————————————————————————————————
// A VARREDURA FOI ESTENDIDA AOS BACKUPS DE CLIENTE (31/08/2026, 6.527 arquivos de
// dialogo em 29 contas). Ela NAO achou o corpo — mas achou tres fatos que mudam o
// tamanho do problema, e ficam registrados aqui porque a fase 2 depende deles:
//
//  1. **A exposicao e 7x maior que os "72" acima**: 504 `crm.url` configuradas,
//     em 24 das 29 contas (2 a 91 por cliente). Hosts: Make/Integromat (239), sistemas
//     proprios dos clientes (160), uChat (18), n8n proprio. Uma delas tem um placeholder
//     literal no lugar do dominio — configuracao quebrada JA na origem.
//  2. **`crm.name` nao e sempre `POST PARA URL`**: 529 sao, mas existem 4
//     `RD_STATION` e 2 `ZAPIER`. Sao vendors com corpo PROPRIO (o formulario da
//     origem ate mostra a URL de fabrica de cada um), entao "o formato deles" nao
//     e um formato, sao tres. O modo `mapa` cobre os tres sem precisar chutar
//     nenhum — e a razao a mais pra nao existir um modo "chatguru" unico.
//  3. **Parte do dado dos clientes viaja na QUERY STRING, nao no corpo**: chaves
//     `service` 29, `status` 29, `agent_id` 18, `endpoint` 18, `token` 16,
//     `queue` 14, `type` 9, `message` 2. Duas URLs carregam texto com
//     `{PRIMEIRO_NOME_LEAD}` dentro do proprio query — o integrador acreditava que
//     a origem interpola variavel na URL. NAO esta provado que ela interpola (e
//     configuracao de cliente, nao requisicao capturada), mas a consequencia pro
//     painel e concreta: ao apontar um destino desses, a URL inteira tem que ser
//     preservada como esta, com query e tudo — e se houver `{VAR}` la dentro, ela
//     NAO sera substituida por este painel, e isso precisa ser dito a quem migra.
//     (Hoje `lib/webhooks-saida.ts` manda a URL literal, que e o comportamento
//     certo; o que falta e o AVISO, e ele esta em `docs/webhooks-saida.md`.)
//
// ————————————————————————————————————————————————————————————————————————
// ZERO IMPORT, igual `lib/permissoes.ts` e `lib/fluxo/schema.ts`: roda no Next e
// em node solto (`node scripts/prova-webhook-compat.ts`). O HMAC continua sendo
// calculado sobre o CORPO CRU que sai daqui — quem assina e
// `lib/webhooks-saida.ts`, e ele assina exatamente o que vai na rede.
//
// A INVARIANTE DE PRIVACIDADE ATRAVESSA TODOS OS FORMATOS, E ELA TEM UM PORTAO
// SO: `montarPayload` (lib/webhooks-saida.ts) e o unico lugar que decide se o
// texto da mensagem entra no payload, e ele so entra em `dados.conteudo` quando o
// destino tem `incluir_conteudo`. **Este arquivo NAO recebe o texto por fora** —
// `$conteudo` e apelido de `$dados.conteudo`, ou seja le do payload JA filtrado.
// Foi decisao, nao economia: um segundo parametro com o texto cru daria a cada
// formato a chance de esquecer a flag, e regra que cada formato reimplementa e
// regra que um dos formatos esquece (a mesma licao que tirou a guarda de status
// dos chamadores e a pos dentro de `avisarStatus`).

export const MODOS_FORMATO = ["expert", "plano", "mapa"] as const;
export type ModoFormato = (typeof MODOS_FORMATO)[number];

export const TIPOS_CONTEUDO = ["json", "form"] as const;
export type TipoConteudo = (typeof TIPOS_CONTEUDO)[number];

export type FormatoSaida = {
  modo: ModoFormato;
  /**
   * `form` = `application/x-www-form-urlencoded`. Existe porque cenario antigo de
   * Make/Integromat era comumente montado sobre form post, e um webhook que
   * espera form ignora JSON sem reclamar.
   */
  tipo_conteudo: TipoConteudo;
  /**
   * So no modo `mapa`: **campo do destino -> de onde vem o valor**.
   *
   * Valor comecando com `$` e CAMINHO no payload; qualquer outra coisa e
   * LITERAL. O literal nao e enfeite: nos 273 usos medidos da acao antiga, tres
   * dos campos que os cenarios recebem (`campanha_id`, `campanha_nome`,
   * `origem`) sao CONSTANTES configuradas por acao — literal e o que reproduz
   * isso sem inventar formato.
   */
  mapa: Record<string, string>;
};

export const FORMATO_PADRAO: FormatoSaida = { modo: "expert", tipo_conteudo: "json", mapa: {} };

/** Caminhos que o mapa aceita. Lista FECHADA de proposito — ver `resolverCaminho`. */
export const CAMINHOS = [
  "$evento",
  "$canal",
  "$chat_id",
  "$em",
  "$id",
  "$versao",
  "$conteudo",
  // atalhos dos `dados` mais usados; o caminho generico `$dados.<chave>` tambem vale
  "$dados",
] as const;

export const MAX_CAMPOS_MAPA = 40;
const MAX_VALOR = 1000;
const CHAVE_OK = /^[A-Za-z0-9_.\-]{1,64}$/;

/**
 * Normaliza o formato vindo da config. PURA e TOLERANTE: config torta cai no
 * formato de sempre (`expert`/json) em vez de derrubar a entrega — o destino
 * continua recebendo o que sempre recebeu, que e o desfecho menos surpreendente.
 *
 * O que ela NAO tolera: modo `mapa` com mapa vazio. Isso viraria corpo `{}`
 * entregue como se fosse compatibilidade — o cenario do cliente receberia nada e
 * responderia 200. Nesse caso volta pro `expert`, com o modo declarado no
 * retorno pra quem grava poder avisar.
 */
export function validarFormato(bruto: unknown): FormatoSaida {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return { ...FORMATO_PADRAO };
  const o = bruto as Record<string, unknown>;

  const modo = (MODOS_FORMATO as readonly string[]).includes(String(o.modo))
    ? (o.modo as ModoFormato)
    : "expert";
  const tipo_conteudo = (TIPOS_CONTEUDO as readonly string[]).includes(String(o.tipo_conteudo))
    ? (o.tipo_conteudo as TipoConteudo)
    : "json";

  const mapa: Record<string, string> = {};
  if (o.mapa && typeof o.mapa === "object" && !Array.isArray(o.mapa)) {
    for (const [k, v] of Object.entries(o.mapa as Record<string, unknown>)) {
      if (Object.keys(mapa).length >= MAX_CAMPOS_MAPA) break;
      if (!CHAVE_OK.test(k)) continue;
      // `__proto__` e afins: a chave existe no jsonb e nao pode virar poluicao de
      // prototipo no objeto de saida (o mapa nasce sem prototipo mais abaixo)
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
      mapa[k] = String(v).slice(0, MAX_VALOR);
    }
  }

  if (modo === "mapa" && !Object.keys(mapa).length) {
    return { modo: "expert", tipo_conteudo, mapa: {} };
  }
  return { modo, tipo_conteudo, mapa };
}

/** O formato pedido e o que de fato sera usado? (a rota de admin avisa quando nao) */
export function formatoFoiRebaixado(bruto: unknown): boolean {
  const o = (bruto && typeof bruto === "object" ? bruto : {}) as Record<string, unknown>;
  return o.modo === "mapa" && validarFormato(bruto).modo !== "mapa";
}

// ————————————————————————————————————————————————————————————— resolucao

type PayloadLido = {
  versao?: unknown;
  evento?: unknown;
  id?: unknown;
  em?: unknown;
  canal?: unknown;
  chat_id?: unknown;
  dados?: unknown;
};

/**
 * Resolve UM caminho do mapa contra o payload. PURA.
 *
 * A lista de caminhos e FECHADA (`$evento`, `$canal`, ..., `$dados.<chave>`) em
 * vez de "qualquer propriedade do objeto": caminho aberto viraria porta pra
 * qualquer campo interno que um dia entre no payload sair pra fora sem ninguem
 * decidir. Caminho desconhecido resolve VAZIO, nunca o literal do caminho — mandar
 * a string "$telefone" pro CRM do cliente seria pior que mandar vazio.
 */
export function resolverCaminho(caminho: string, payload: PayloadLido): unknown {
  switch (caminho) {
    case "$versao":
      return payload.versao;
    case "$evento":
      return payload.evento;
    case "$id":
      return payload.id;
    case "$em":
      return payload.em;
    case "$canal":
      return payload.canal;
    case "$chat_id":
      return payload.chat_id;
    case "$conteudo":
      // APELIDO de `$dados.conteudo`, de proposito: o texto so esta no payload
      // quando `montarPayload` o deixou entrar (flag `incluir_conteudo`). Sem a
      // flag, a chave nao existe e isto devolve "" — nao ha caminho pelo qual o
      // texto da mensagem escape do portao.
      return resolverCaminho("$dados.conteudo", payload);
    case "$dados":
      return payload.dados ?? {};
    default: {
      if (!caminho.startsWith("$dados.")) return "";
      const chave = caminho.slice("$dados.".length);
      if (!chave) return "";
      const d = payload.dados;
      if (!d || typeof d !== "object" || Array.isArray(d)) return "";
      // `conteudo` dentro de dados segue a mesma flag: montarPayload so o poe la
      // quando o destino pediu, entao ler daqui e coerente
      return (d as Record<string, unknown>)[chave] ?? "";
    }
  }
}

/**
 * O objeto que vai virar corpo. PURA — devolve objeto, nao string, pra o
 * chamador escolher JSON ou form sem duplicar a regra.
 */
export function corpoObjeto(formato: FormatoSaida, payload: PayloadLido): Record<string, unknown> {
  if (formato.modo === "expert") {
    // o envelope de sempre, intacto: destino que ja integrou nao pode mudar de
    // corpo porque a feature nova nasceu
    return { ...(payload as Record<string, unknown>) };
  }

  if (formato.modo === "plano") {
    // achatado em UM nivel: `dados` sobe pra raiz. Cenario de Make montado sobre
    // corpo raso nao alcanca `dados.tipo`, e "sem nesting" e o pedido mais comum
    // de compatibilidade — sem inventar NOME de campo nenhum (as chaves sao as
    // nossas, so a profundidade muda).
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      if (k === "dados") continue;
      out[k] = v;
    }
    const d = payload.dados;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
        // colisao: a chave do envelope VENCE. Um `dados.evento` sobrescrevendo o
        // evento faria o destino rotear a coisa errada.
        if (k in out) continue;
        out[k] = v;
      }
    }
    return { ...out };
  }

  // modo mapa
  const out: Record<string, unknown> = Object.create(null);
  for (const [destino, origem] of Object.entries(formato.mapa)) {
    out[destino] = origem.startsWith("$") ? resolverCaminho(origem, payload) : origem;
  }
  return { ...out };
}

/** `application/x-www-form-urlencoded`. Objeto/lista viram JSON no valor. PURA. */
export function corpoForm(obj: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) {
      p.append(k, "");
      continue;
    }
    if (typeof v === "object") {
      p.append(k, JSON.stringify(v));
      continue;
    }
    p.append(k, String(v));
  }
  return p.toString();
}

export type CorpoDeSaida = { corpo: string; contentType: string };

/**
 * O corpo final e o content-type. PURA — e o unico lugar que decide os dois, pra
 * o cabecalho nunca discordar do corpo (destino que recebe `application/json`
 * com corpo de form e o mesmo silencio de antes, do outro lado).
 */
export function corpoDeSaida(formato: FormatoSaida, payload: PayloadLido): CorpoDeSaida {
  const obj = corpoObjeto(formato, payload);
  if (formato.tipo_conteudo === "form") {
    return { corpo: corpoForm(obj), contentType: "application/x-www-form-urlencoded;charset=UTF-8" };
  }
  return { corpo: JSON.stringify(obj), contentType: "application/json" };
}

/**
 * Texto pra tela do admin explicando o que o destino vai receber. PURA.
 * Existe porque formato e a coisa mais facil de configurar errado aqui, e o erro
 * so aparece do outro lado, dias depois, como cenario que parou de rodar.
 */
export function descreverFormato(f: FormatoSaida): string {
  const ct = f.tipo_conteudo === "form" ? "formulario (urlencoded)" : "JSON";
  if (f.modo === "expert") return `envelope padrao do Expert Chat, em ${ct}`;
  if (f.modo === "plano") return `campos achatados na raiz (sem "dados"), em ${ct}`;
  const n = Object.keys(f.mapa).length;
  return `mapa declarado com ${n} campo(s) (${Object.keys(f.mapa).slice(0, 6).join(", ")}${
    n > 6 ? ", ..." : ""
  }), em ${ct}`;
}
