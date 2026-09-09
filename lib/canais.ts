// Canal como ENTIDADE de primeira classe (Central de Atendimento).
//
// Ate 28/08/2026 "canal" era um literal solto ("central" | "apioficial")
// resolvido em lib/canal.ts. Este registro descreve cada canal com o que a
// operacao precisa saber dele: tipo (whatsapp/instagram), identidade (numero
// ou @perfil), dono (empresa/pessoal), fonte de dados e o par de tabelas.
//
// Regra BASE do repo: NENHUM dado da empresa hardcodado aqui. Metadados dos
// canais built-in vem de env (mesmos nomes que a UI ja usa); canais ADICIONAIS
// entram pela env CANAIS_EXTRA (JSON) — ver normalizarExtra abaixo.

export type TipoCanal = "whatsapp" | "instagram";
// dono = de quem e o canal: da EMPRESA ou PESSOAL (do titular da conta).
export type DonoCanal = "empresa" | "pessoal";
// fonte = de onde entram/saem as mensagens do canal.
// evolution = Evolution API (self-hosted, Baileys) — cada instalacao roda o
// proprio servidor; base_url, instancia e apikey vem por env do canal.
export type FonteCanal = "zapi" | "gupshup" | "evolution" | "instagram-agent";

export type CanalDef = {
  // slug estavel: e o valor de ?canal= nas rotas e da coluna `canal` nas
  // tabelas compostas (conversa_responsaveis, notificacoes, visibilidade)
  id: string;
  tipo: TipoCanal;
  dono: DonoCanal;
  rotulo: string; // nome curto no seletor da sidebar
  subtitulo: string; // linha sob o titulo do painel
  // numero de telefone (whatsapp) ou @perfil (instagram); "" = nao informado
  identidade: string;
  fonte: FonteCanal;
  // fonte externa (instagram-agent): QUAL conta do agente este canal mostra —
  // alias operacional ou @perfil da ig_account. Sem `conta`, vale a identidade.
  conta?: string;
  // cada canal tem o proprio par de tabelas (PK chat_id = telefone/perfil do
  // CONTATO — juntar tudo numa tabela colidiria quem falou com 2 canais)
  tabelas: { conversas: string; mensagens: string };
  // false = registrado mas fora do seletor (fonte ainda nao plugada)
  ativo: boolean;
};

// Recorte publico (vai pro front via /api/chats) — sem nome de tabela.
export type CanalPublico = Omit<CanalDef, "tabelas">;

const CANAIS_BUILTIN: CanalDef[] = [
  {
    id: "central",
    tipo: "whatsapp",
    dono: "empresa",
    rotulo: process.env.NEXT_PUBLIC_ROTULO_CANAL || "Principal",
    subtitulo: process.env.NEXT_PUBLIC_SUBTITULO || "WhatsApp da empresa",
    identidade: process.env.CANAL_CENTRAL_IDENTIDADE || "",
    fonte: "zapi",
    tabelas: { conversas: "conversas", mensagens: "mensagens" },
    ativo: true,
  },
  {
    id: "apioficial",
    tipo: "whatsapp",
    dono: "empresa",
    rotulo: process.env.NEXT_PUBLIC_ROTULO_CANAL_OFICIAL || "API Oficial",
    subtitulo: process.env.NEXT_PUBLIC_SUBTITULO_OFICIAL || "WhatsApp API Oficial",
    identidade: process.env.CANAL_APIOFICIAL_IDENTIDADE || "",
    fonte: "gupshup",
    tabelas: { conversas: "conversas_apioficial", mensagens: "mensagens_apioficial" },
    ativo: true,
  },
];

const TIPOS: TipoCanal[] = ["whatsapp", "instagram"];
const DONOS: DonoCanal[] = ["empresa", "pessoal"];
const FONTES: FonteCanal[] = ["zapi", "gupshup", "evolution", "instagram-agent"];
const ID_RE = /^[a-z][a-z0-9_]{1,30}$/;

// CANAIS_EXTRA = JSON de canais adicionais, ex:
//   [{"id":"testador","tipo":"whatsapp","dono":"empresa","rotulo":"Testador",
//     "identidade":"5511...","fonte":"zapi"}]
// Canal Instagram (fonte instagram-agent, le direto do banco do agente — ver
// lib/instagram-agent.ts e as envs IG_SUPABASE_URL/IG_SUPABASE_SERVICE_KEY):
//   {"id":"ig_pessoal","tipo":"instagram","dono":"pessoal","rotulo":"@meuperfil",
//    "identidade":"@meuperfil","fonte":"instagram-agent","conta":"meuperfil","ativo":true}
// Campos opcionais: subtitulo, conta, tabelas (default conversas_<id>/mensagens_<id>),
// ativo (default false — canal declarado so entra no seletor quando a fonte
// dele estiver plugada e alguem ligar explicitamente).
function normalizarExtra(bruto: any): CanalDef | null {
  if (!bruto || typeof bruto !== "object") return null;
  const id = typeof bruto.id === "string" ? bruto.id.trim() : "";
  if (!ID_RE.test(id)) return null;
  if (!TIPOS.includes(bruto.tipo)) return null;
  if (!FONTES.includes(bruto.fonte)) return null;
  const dono: DonoCanal = DONOS.includes(bruto.dono) ? bruto.dono : "empresa";
  const t = bruto.tabelas;
  return {
    id,
    tipo: bruto.tipo,
    dono,
    rotulo: (typeof bruto.rotulo === "string" && bruto.rotulo.trim()) || id,
    subtitulo: typeof bruto.subtitulo === "string" ? bruto.subtitulo : "",
    identidade: typeof bruto.identidade === "string" ? bruto.identidade : "",
    fonte: bruto.fonte,
    ...(typeof bruto.conta === "string" && bruto.conta.trim() ? { conta: bruto.conta.trim() } : {}),
    tabelas: {
      conversas: (t && typeof t.conversas === "string" && t.conversas) || `conversas_${id}`,
      mensagens: (t && typeof t.mensagens === "string" && t.mensagens) || `mensagens_${id}`,
    },
    ativo: bruto.ativo === true,
  };
}

function canaisExtra(): CanalDef[] {
  const raw = process.env.CANAIS_EXTRA;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map(normalizarExtra)
      .filter((c): c is CanalDef => !!c)
      // built-in vence colisao de id (extra nao redefine central/apioficial)
      .filter((c) => !CANAIS_BUILTIN.some((b) => b.id === c.id));
  } catch {
    return []; // JSON invalido nao pode derrubar o painel
  }
}

/**
 * SO os canais que vem no CODIGO (sem `CANAIS_EXTRA` da instalacao).
 *
 * Existe pra varredura de codigo (`scripts/prova-seguranca-conta.ts`, bloco B.10),
 * que deriva daqui o padrao de "id de canal usado como literal". Usar
 * `listarCanais()` la era fragil de um jeito especifico (achado D11): uma
 * instalacao que declarasse um canal com id curto e comum — `api`, `teste`, `chat`
 * — passaria a casar QUALQUER `"api"` no meio de uma rota e reprovaria a prova por
 * FALSO POSITIVO, num arquivo que ninguem tocou. Builtin e codigo, e codigo e o que
 * a varredura de codigo deve olhar; canal novo builtin continua entrando sozinho.
 */
export function canaisBuiltin(): CanalDef[] {
  return [...CANAIS_BUILTIN];
}

export function listarCanais(): CanalDef[] {
  return [...CANAIS_BUILTIN, ...canaisExtra()];
}

export function canaisAtivos(): CanalDef[] {
  return listarCanais().filter((c) => c.ativo);
}

export function canalPorId(id: string | null | undefined): CanalDef | null {
  if (!id) return null;
  return listarCanais().find((c) => c.id === id) ?? null;
}

export function canalPublico(c: CanalDef): CanalPublico {
  const { tabelas: _tabelas, ...pub } = c;
  return pub;
}

// ————————————————— o canal do pedido, do ponto de vista do ESCOPO da chave
//
// Sentinela pra "id que veio no pedido e NAO existe no registro", nas rotas de
// canal. Nome que `canalPorId` nunca resolve (mesmo espirito do
// `CANAL_INEXISTENTE` de lib/acesso.ts): com escopo de canal declarado ele nunca
// casa, e o pedido e NEGADO na porta — em vez de a chave atravessar e descobrir
// pelo 404 da rota que aquele canal nao existe.
export const CANAL_NAO_REGISTRADO = "__nao_registrado__";

/**
 * Como a PORTA (lib/auth-server.ts) resolve o canal do pedido pro escopo da chave.
 *
 * Mora AQUI, e nao dentro da porta, por um motivo so: pra ser PROVAVEL sem rede
 * (`scripts/prova-seguranca-conta.ts`). Enquanto a regra era uma funcao privada da
 * porta, o furo abaixo nao tinha como ser exercitado por prova nenhuma — e ele
 * passou por duas revisoes.
 *
 * `rotaDeCanal=false` (o caso de sempre — rota de conversa): espelha `resolver()`
 * de lib/canal.ts. Id desconhecido OU INATIVO cai no `central`, porque e isso que
 * a rota vai usar; cair no central e o comportamento certo lá (canal invalido nao
 * pode dar 500 na caixa de entrada).
 *
 * `rotaDeCanal=true` (`/api/canais/*`): resolve o id REGISTRADO **mesmo inativo**,
 * e sem default. O furo que isso fecha tinha OS DOIS SENTIDOS:
 *
 *   AFROUXA — canal registrado e inativo caia no `central`. Uma chave escopada a
 *   ["central"] passava pela porta e a ROTA operava o canal EXTRA inativo (a porta
 *   de `/api/canais/*` aceita canal inativo de proposito: e justamente o numero
 *   que alguem acabou de declarar e vem conectar). A chave desconectava um numero
 *   que ela nao alcanca.
 *
 *   APERTA — uma chave escopada ao canal extra (["testador"]) nunca alcancava
 *   nada, porque o id dela era reescrito como `central` antes da comparacao.
 */
export function canalParaEscopo(id: unknown, rotaDeCanal: boolean): string | null {
  if (typeof id !== "string" || !id) return null;
  const c = canalPorId(id);
  if (c && c.ativo) return c.id;
  if (rotaDeCanal) return c ? c.id : CANAL_NAO_REGISTRADO;
  return "central";
}

/**
 * QUAL canal este pedido HTTP esta falando — a resolucao COMPLETA (query + corpo),
 * que e o que a porta da CHAVE DE API compara contra `escopo.canais`.
 *
 * Mora aqui, e nao mais dentro de lib/auth-server.ts, pelo mesmo motivo de
 * `canalParaEscopo`: pra ser EXERCITAVEL por prova. A prova anterior chamava
 * `canalParaEscopo` na mao, com o id ja escolhido — ou seja, provava o TRADUTOR e
 * nao a RESOLUCAO. E foi na resolucao que morava o furo GRAVE D1 (leia abaixo).
 *
 * A assinatura pede o MINIMO de um Request (metodo, url, headers, clone) pra que a
 * prova possa passar um `new Request(...)` de verdade, com corpo de verdade, e
 * medir o comportamento real — inclusive o do corpo JA CONSUMIDO.
 *
 * ————————————————————————————————————————————— A ARMADILHA (GRAVE D1, 31/08/2026)
 *
 * O corpo de um Request se le UMA VEZ. Esta funcao le o corpo por `clone()`, e
 * clonar SO funciona enquanto o corpo original esta intacto. Se a rota fizer
 * `await req.json()` ANTES da porta, o clone lanca ("Body is unusable"), o catch
 * zera `doCorpo`, e o canal do pedido volta `null`.
 *
 * `null` NAO e negacao: em `escopoPermite`, canal null com rota fora de
 * `CANAL_PADRAO_EM` simplesmente NAO COMPARA nada. Ou seja: uma chave escopada a
 * ["central"] passava e DESCONECTAVA o `apioficial`, porque o escopo de canal
 * ficava INERTE. Nao era falta de camada — a camada existia e recebia `null`.
 *
 * Por isso quem le o corpo das rotas de canal e a PORTA (`portaDoCorpo` em
 * lib/canais-porta.ts), nunca o handler, e a prova varre `app/api/canais/*`
 * PROIBINDO `req.json(`. Guarda estrutural, porque a ordem correta e invisivel: o
 * codigo errado nao quebra, nao loga e nao falha teste — so para de comparar.
 */
export type PedidoHttp = {
  method: string;
  url: string;
  headers: { get(nome: string): string | null };
  clone(): { json(): Promise<any> };
};

export type CanalDoPedido = { canal: string | null; divergente: boolean };

export async function canalDoPedido(req: PedidoHttp, rotaDeCanal: boolean): Promise<CanalDoPedido> {
  const daUrl = canalParaEscopo(new URL(req.url).searchParams.get("canal"), rotaDeCanal);
  let doCorpo: string | null = null;
  const metodo = req.method.toUpperCase();
  // ——————— O HEADER NAO DECIDE SE O CORPO E LIDO, E O METODO TAMBEM NAO SALVA VIA
  //          content-type (3a revisao cega, e o remendo dela na 4a)
  //
  // Era assim: le o corpo SO quando o content-type se diz `application/json`. Isso
  // parecia prudente e era um FURO, porque NENHUM handler deste repo confere
  // content-type: `req.json()` (undici) le os BYTES do corpo e faz JSON.parse,
  // IGNORANDO o header; `canalDeBody` resolve o canal do objeto parseado. Ou seja,
  // a porta e a rota liam COISAS DIFERENTES do mesmo pedido, e a diferenca era so um
  // header que o cliente escolhe:
  //
  //   POST /api/canais/conexao, corpo {"canal":"apioficial","acao":"desconectar"},
  //   Content-Type: application/x-www-form-urlencoded (o DEFAULT do `curl -d`)
  //     -> aqui: corpo nao lido -> canal do pedido = null
  //     -> escopoPermite: canal null fora de CANAL_PADRAO_EM -> NAO COMPARA NADA
  //     -> a rota: parseia o corpo e opera o `apioficial`
  //
  // Chave escopada a ["central"] desconectando o `apioficial` — o dano inteiro do
  // GRAVE D1, por um header em vez de por uma corrida de leitura. E nao ficava so
  // nas rotas de canal: em `/api/send`, `/api/disparo` e `/api/visibilidade` o
  // mesmo truque fazia o escopo assumir o default `central` (via
  // `assumeCanalPadrao`) enquanto a rota mandava pelo canal do corpo.
  //
  // A 1a correcao trocou o gate de content-type por uma isencao de `multipart/`,
  // e ISSO REABRIU O FURO pelas rotas de CANAL_PADRAO_EM: bastava mandar o mesmo
  // corpo JSON com `Content-Type: multipart/form-data`. A isencao nao se sustentava:
  // a UNICA rota multipart do repo (`/api/perfil/foto`) autentica por SESSAO
  // (`usuarioPorSessao`, que devolve null pra `x-api-key`), entao ela NUNCA chega a
  // esta funcao — o resolvedor so roda no caminho `usuarioPorApiKey`. Nenhum upload
  // legitimo passa por aqui.
  //
  // Agora: metodo que muda estado tem o corpo lido, SEM excecao de header. Pro
  // ataque (header multipart, corpo JSON), `req.clone().json()` le os bytes JSON
  // e resolve `apioficial` IGUAL a rota faz — as duas pontas leem A MESMA COISA, e
  // o escopo compara e NEGA. Isto fecha /api/send, /api/disparo e /api/visibilidade
  // sem tocar em rota de outra frente: quem decide e o resolvedor. Upload de verdade
  // (bytes que nao sao JSON) so cairia aqui por uma rota multipart alcancavel por
  // chave de API — nao existe; se um dia existir, `.json()` falha no catch e o
  // fail-closed de `escopoPermite` (canal null + metodo que muda estado + rota de
  // CANAL_OBRIGATORIO_EM) e a rede de baixo.
  //
  // Custo: so paga quem tem recorte de canal na chave. `canalDoRequest` em
  // lib/auth-server.ts nem chama esta funcao quando `escopo.canais` esta vazio.
  if (metodo !== "GET" && metodo !== "HEAD" && metodo !== "OPTIONS") {
    try {
      const body = await req.clone().json();
      doCorpo = canalParaEscopo(body?.canal, rotaDeCanal);
    } catch {
      doCorpo = null;
    }
  }
  // query e corpo com canais DIFERENTES = divergente, e o escopo NEGA: nao da pra
  // saber qual dos dois a rota usa, e adivinhar a favor do pedinte e contrabando
  if (daUrl && doCorpo && daUrl !== doCorpo) return { canal: doCorpo, divergente: true };
  // corpo primeiro: e o que a rota de escrita le
  return { canal: doCorpo ?? daUrl, divergente: false };
}

// Envio CABEADO = o canal tem credencial de SAIDA configurada (P1 30/08/2026).
// Fail-closed: canal sem credencial nunca cai no caminho de outro numero —
// mandaria mensagem pelo NUMERO ERRADO. A convencao de envs e espelho de
// lib/zapi.ts (credsZapi), lib/gupshup.ts (credsGupshup) e lib/evolution.ts
// (credsEvolution) — mudou la, muda aqui
// (importar direto criaria ciclo: zapi/gupshup ja importam este arquivo).
export function envioDisponivel(canal: string): boolean {
  const c = canalPorId(canal);
  if (!c || !c.ativo) return false;
  if (c.fonte === "zapi") {
    const p = c.id === "central" ? "CENTRAL_ZAPI_" : `ZAPI_${c.id.toUpperCase()}_`;
    return !!(process.env[p + "INSTANCE_ID"] && process.env[p + "TOKEN"]);
  }
  if (c.fonte === "gupshup") {
    const p = `GUPSHUP_${c.id.toUpperCase()}_`;
    if (process.env[p + "API_KEY"] && process.env[p + "SOURCE_NUMBER"]) return true;
    // builtin apioficial tem fallback historico no banco (public.connectors);
    // a checagem async fica no proprio envio — aqui nao bloqueia.
    return c.id === "apioficial";
  }
  if (c.fonte === "evolution") {
    const p = `EVOLUTION_${c.id.toUpperCase()}_`;
    return !!(
      process.env[p + "BASE_URL"] &&
      process.env[p + "INSTANCE_ID"] &&
      process.env[p + "API_KEY"]
    );
  }
  return false; // fonte externa (instagram-agent) e somente leitura
}

// Fonte EXTERNA = o painel so LE (as tabelas moram no banco de outro sistema).
// Estado de atendimento que vive na linha da conversa (status, arquivo,
// etiqueta, ficha, nota interna) ainda nao tem onde morar pra esses canais —
// exigiria tabela nova no banco do painel (DDL). Ate la, as rotas de escrita
// respondem 403 "somente leitura" em vez de estourar 500 em tabela inexistente.
// Responsaveis e visibilidade NAO entram aqui: vivem em tabelas do painel
// chaveadas por (canal, chat_id) e funcionam pra qualquer canal.
export function fonteExterna(canal: CanalDef): boolean {
  return canal.fonte === "instagram-agent";
}
export function somenteLeitura(canal: string): boolean {
  const c = canalPorId(canal);
  return !!c && fonteExterna(c);
}
