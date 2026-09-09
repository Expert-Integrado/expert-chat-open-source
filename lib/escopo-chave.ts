// Escopo POR CHAVE de API — REGRA PURA (card 86ak85899).
//
// O QUE JA EXISTIA (F11, 18/08/2026): a chave `eck_` resolve pro user_id do
// dono e TODAS as permissoes dele valem automaticamente (BU, visibilidade,
// escopo de visao, papel). Isso e bom e nao muda: chave nao inventa permissao.
//
// O QUE FALTAVA, e e este arquivo: a chave nao conseguia valer MENOS que o
// dono. Nao havia como dizer "esta chave e so pra ler", "esta chave so mexe no
// canal X", "esta chave vale ate sexta". Uma chave vazada valia tudo o que o
// dono vale, pra sempre.
//
// INVARIANTE QUE MANDA EM TUDO: escopo so RESTRINGE. Nunca concede. O calculo
// de permissao continua sendo o do dono (lib/permissoes.ts); o escopo entra
// DEPOIS, como porta que fecha. Chave sem escopo = `{}` = comportamento
// identico ao de hoje (retrocompatibilidade: e o estado de toda chave que ja
// existe em producao).
//
// Zero import de proposito, igual lib/permissoes.ts e lib/funis.ts: roda no
// Next e em node solto (`node scripts/prova-seguranca-conta.ts`).

// ————————————————————————————————————————————————————————————— recursos
//
// A unidade de restricao e o RECURSO, nao a rota: rota e detalhe de
// implementacao e muda; recurso e o que o dono da instalacao entende ("esta
// chave le conversas e nada mais"). O mapa rota->recurso vive AQUI, num lugar
// so, e a porta (lib/auth-server.ts) apenas consulta.
export const RECURSOS = [
  "conversas",
  "mensagens",
  "envio",
  "ficha",
  "etiquetas",
  "notas",
  // BIBLIOTECA DE ANEXOS (Frente W, 31/08/2026): o ACERVO da instalacao —
  // listar, subir, descrever, etiquetar e apagar arquivo reutilizavel. Verbete
  // PROPRIO, e nao `envio`, pelo mesmo motivo que `exportacao` saiu de
  // `relatorios`: uma chave que recebeu "envio" foi consentida pra mandar
  // mensagem, nao pra APAGAR material que os fluxos de automacao referenciam.
  // A consequencia deliberada: chave criada ANTES desta linha nao alcanca a
  // biblioteca (fail-closed) — o dono opta explicitamente.
  //
  // Anexar arquivo A UMA CONVERSA nao esta aqui: aquilo e mandar mensagem, e o
  // verbete de `/api/anexos/conversa` no MAPA e `envio`, de proposito.
  "anexos",
  "funis",
  "macros",
  "disparo",
  "relatorios",
  // EXPORTACAO e recurso PROPRIO, separado de relatorios (Frente V, 31/08/2026,
  // achado da revisao cega). Motivo: chave existente com {somente_leitura,
  // recursos:["relatorios"]} foi consentida pra ler NUMERO agregado; se a
  // exportacao entrasse naquele verbete, a MESMA chave passaria a baixar 50 mil
  // mensagens com conteudo e telefone por um GET, sem ninguem ter decidido isso.
  // Verbete novo = chave antiga fica fail-closed, e o dono opta explicitamente.
  "exportacao",
  "canais",
  "admin",
  "conta",
] as const;

export type Recurso = (typeof RECURSOS)[number];

export const DESCRICAO_RECURSO: Record<Recurso, string> = {
  conversas: "Listar e buscar conversas, mudar status e responsavel.",
  mensagens: "Ler o historico de mensagens de uma conversa.",
  envio: "Enviar e encaminhar mensagem.",
  ficha: "Ler e escrever a ficha do contato.",
  etiquetas: "Ler o catalogo e etiquetar conversa.",
  notas: "Anotacao interna e o sininho de notificacao.",
  anexos: "Biblioteca de arquivos reutilizaveis: listar, subir, descrever, etiquetar e apagar.",
  funis: "Funil, etapas e a etapa da conversa.",
  macros: "Executar macro e fluxo de automacao.",
  disparo: "Agendamento e disparo em lote.",
  relatorios: "Relatorios de atendimento (numeros agregados).",
  exportacao: "Baixar em CSV as linhas de mensagens, anotacoes, usuarios e acessos.",
  canais: "Sincronizacao e manutencao de canais, midia e fotos.",
  admin: "Administracao da instalacao (usuarios, papeis, configuracao).",
  conta: "Dados da propria conta e das pessoas do time.",
};

/** Rota que e TRANSPORTE, nao recurso — ver `escopoPermite`. */
export const TRANSPORTE = "transporte";

/**
 * O canal que a rota assume quando o pedido nao diz qual (`canalDe`/`canalDeBody`
 * em lib/canal.ts caem aqui). O escopo TEM que assumir o mesmo, senao a chave
 * restrita a um numero le o outro so por OMITIR o parametro — foi o furo que a
 * revisao pegou.
 */
export const CANAL_PADRAO = "central";

/**
 * ONDE "sem canal no pedido" SIGNIFICA `CANAL_PADRAO`.
 *
 * Isto era um Set de RECURSOS e estava errado nos dois sentidos — a segunda
 * revisao mediu os dois:
 *
 *  - FURO: `POST /api/etiquetas` e `GET/POST /api/conversa/funil` resolvem canal
 *    pelo corpo/query com default `central`, mas os recursos deles (`etiquetas`,
 *    `funis`) estavam fora do Set. Uma chave restrita ao `apioficial` escrevia
 *    etiqueta e movia conversa de etapa no canal proibido — alcancavel pelo MCP
 *    com `definir_etiquetas` sem canal.
 *  - NEGACAO FALSA: `GET /api/notificacoes` (recurso `notas`), `GET /api/fluxos`
 *    (`macros`), `GET /api/disparo/listas` e `/api/disparo/bloqueios` (`disparo`)
 *    NAO falam de canal, e caiam no default por causa do recurso do vizinho.
 *
 * A licao: **assumir canal-padrao e propriedade de ROTA + METODO**, nao de
 * recurso. Recurso agrupa por assunto; quem resolve canal e o handler. Entao a
 * tabela abaixo e (prefixo, metodos), e ela e DERIVADA de fato: a prova
 * `scripts/prova-seguranca-conta.ts` varre `app/api` procurando quem importa
 * `canalDe`/`canalDeBody` e exige entrada EXATA aqui pra cada um. Sem essa
 * asseracao tirada do proprio codigo, a proxima rota escapa igual.
 *
 * Metodo que a rota nao tem (ou que nao resolve canal) pode ficar na lista: e
 * inerte e protege a rota do dia em que o metodo nascer.
 */
// A lista e MEDIDA, nao redigida: `scripts/prova-seguranca-conta.ts` varre
// `app/api` e cobra que o conjunto de metodos aqui seja IGUAL ao conjunto de
// handlers que resolvem canal — sem faltante e sem sobra (ver B.10).
//
// 3a revisao, dois consertos que sairam dessa medicao:
//
//   RESOLUCAO A MAO tambem conta. `/api/visibilidade` comparava `body.canal ===
//   "apioficial"` na propria rota, sem importar `canalDe*` — ficou fora do radar
//   da tabela E da varredura, e uma chave restrita ao apioficial gravava ACL
//   dura (conversa_visibilidade, lotes de 2000) no central. A rota passou a usar
//   `canalDeBody`; `/api/webhook` (que faz `canalPorId(query.canal || "central")`)
//   e `/api/midia` entraram na tabela. `/api/midia` nao le canal do pedido: ele
//   mexe nos DOIS canais sempre, e declarar `central` aqui e o que barra uma
//   chave que so alcanca o apioficial — que e o certo, porque ela mexeria no
//   central de qualquer jeito.
//
//   METODO A MAIS e tao ruim quanto metodo a menos. A lista tinha DELETE em
//   `/api/conversa/funil` e em `/api/etiquetas`, e nenhuma das duas exporta
//   DELETE — verbete morto que da a impressao de cobertura. Ja o inverso (metodo
//   que resolve canal e nao esta aqui) e o furo do item anterior. Por isso a
//   prova exige igualdade, nos dois sentidos.
//
// O que NAO entra: metodo que nao toca canal. `DELETE /api/agendadas` (cancela
// por id, tabela unica) e `GET /api/etiquetas` (catalogo global) ficam fora de
// proposito — declara-los criaria NEGACAO FALSA pra chave de um canal so, que
// foi um defeito medido na revisao anterior.
//
// 4a revisao (Frente U, 31/08/2026) — DUAS ENTRADAS NOVAS, e a primeira e um FURO
// que estava aberto em producao. Elas apareceram quando a varredura B.10 passou a
// derivar o padrao de busca dos IDS DO REGISTRO (`central` inclusive) em vez de
// procurar so o literal `apioficial`:
//
//   `/api/disparo` POST resolve canal A MAO — `body?.canal ?? "central"` — e nao
//   estava aqui. Uma chave escopada ao `apioficial` criava CAMPANHA DE DISPARO EM
//   MASSA saindo pelo `central`, so omitindo `canal` no corpo. E a mesma familia do
//   furo de `/api/visibilidade` (2a revisao), com consequencia maior: mensagem em
//   lote pelo numero errado. A rota e de outra frente; o conserto que cabe AQUI e
//   a entrada na tabela, que faz o escopo assumir o mesmo default que o handler.
//
//   `/api/cron-agendadas` POST resolve `m.canal || "central"` por linha da fila.
//   Ela autentica por bearer proprio (chave de API nunca chega la), entao o verbete
//   e inerte — existe pela mesma razao que o de `/api/cron-disparo` no mapa de
//   recursos: pra varredura nao precisar de lista de excecao, que e o que envelhece
//   calado. Ela tambem entra em `TOCA_TODOS_OS_CANAIS`: processa a fila de TODOS os
//   canais no mesmo request.
//
// AS TRES ENTRADAS-ESCUDO (`[]`) de `/api/disparo/*`: esta tabela casa por PREFIXO,
// entao `["/api/disparo", ["POST"]]` faria `POST /api/disparo/listas`,
// `/bloqueios` e `/publico` assumirem canal padrao tambem — e NENHUMA das tres
// fala de canal. Isso criaria NEGACAO FALSA pra chave de um canal so, que e um
// defeito ja medido numa revisao anterior. Lista de metodos VAZIA = "esta rota nao
// assume canal padrao", e como a tabela para no primeiro prefixo que casa, o
// escudo tem que vir ANTES do generico.
export const CANAL_PADRAO_EM: ReadonlyArray<[string, readonly string[]]> = [
  // mais especifico primeiro: /api/conversa/funil casaria com /api/conversa
  ["/api/conversa/busca", ["GET"]],
  // Frente V (31/08/2026): a memoria da conversa resolve canal no GET (canalDe) e
  // no POST (canalDeBody). Sem esta entrada EXATA, uma chave restrita ao
  // apioficial leria e ESCREVERIA contexto no central so por omitir `?canal=` —
  // e o `/api/conversa` de baixo nao cobre (ele lista so POST), que e literalmente
  // o bug que a 2a revisao mediu em `/api/conversa/funil`.
  ["/api/conversa/contexto", ["GET", "POST"]],
  ["/api/conversa/funil", ["GET", "POST"]],
  ["/api/conversa/historicos", ["GET"]],
  ["/api/conversa/iniciar", ["POST"]],
  // Acoes em massa (02/09/2026): a rota resolve canal UMA vez pelo body (canalDeBody,
  // default central) e aplica status/arquivo/responsavel em N conversas daquele canal.
  // Sem esta entrada EXATA, chave restrita ao apioficial arquivaria conversas do
  // central so por omitir `canal` no body — o `/api/conversa` de baixo nao cobre
  // (casa por prefixo, mas a prova cobra entrada exata por rota que resolve canal).
  ["/api/conversa/massa", ["POST"]],
  ["/api/conversa", ["POST"]],
  // Frente T (card 86ak86jw9): o GET resolve canal (canalDe) pra substituir
  // variavel de resposta rapida com os dados DAQUELA conversa. POST e DELETE
  // mexem no catalogo de respostas, que nao tem canal — e por isso a entrada
  // declara SO o GET (metodo sobrando na tabela e verbete morto que finge
  // cobertura, a prova cobra a igualdade nos dois sentidos).
  ["/api/respostas-rapidas", ["GET"]],
  ["/api/relatorios/serie", ["GET"]],
  ["/api/relatorio", ["GET"]],
  // Frente V (31/08/2026): as consultas de mensagem/anotacao sao POR CANAL e
  // resolvem por `canalDe` (default central). Sem esta entrada, chave restrita ao
  // apioficial baixaria o CSV das mensagens do central so por omitir `?canal=`.
  ["/api/exportar", ["GET"]],
  // Frente W (31/08/2026): SO a sub-rota /api/anexos/conversa resolve canal
  // (canalDeBody, default central) — e ela exporta so o POST. A rota generica
  // /api/anexos (acervo da instalacao, sem canal) NAO tem entrada aqui, nem
  // escudo: a tabela casa por prefixo pra FRENTE, e "/api/anexos" nao comeca
  // com "/api/anexos/conversa/", entao nada dela assume canal padrao. Entrada
  // sobrando ali seria negacao falsa pra chave restrita a um numero, que
  // perderia o acervo inteiro por causa de um canal que a rota nem le.
  ["/api/anexos/conversa", ["POST"]],
  ["/api/agendadas", ["GET", "POST"]],
  ["/api/busca", ["GET"]],
  ["/api/chats", ["GET"]],
  ["/api/cron-agendadas", ["POST"]],
  // escudos: sub-rota de disparo que NAO fala de canal (ver a nota acima)
  ["/api/disparo/bloqueios", []],
  ["/api/disparo/listas", []],
  ["/api/disparo/publico", []],
  ["/api/disparo", ["POST"]],
  // Frente X (31/08/2026): os VALORES da ficha sao por conversa e resolvem canal
  // (GET por `canalDe`, PATCH por `canalDeBody`). A entrada e EXATA e vem ANTES do
  // catalogo: `/api/campos` (o construtor) NAO resolve canal — o catalogo e da
  // instalacao — e declara-lo aqui criaria negacao falsa pra chave restrita a um
  // numero. Como a tabela casa por prefixo e nao existe entrada `/api/campos`,
  // `assumeCanalPadrao("/api/campos", ...)` e false, que e o certo.
  ["/api/campos/valores", ["GET", "PATCH"]],
  ["/api/etiquetas", ["POST"]],
  ["/api/ficha", ["GET", "PATCH"]],
  // Frente P (costura no merge): a fila resolve canal no GET (canalDe) e no
  // POST (canalDeBody). Em /api/fluxos quem resolve e o helper compartilhado
  // fatosDaSimulacao (simulador do GET) — a varredura da prova nao consegue
  // atribuir helper a um handler e cobra os TRES metodos (fail-closed). Chave
  // com recorte de canal manda `?canal=` explicito nas rotas de fluxo, ate pra
  // listar/editar; o default central seria negado.
  ["/api/fluxo-fila", ["GET", "POST"]],
  ["/api/fluxos", ["GET", "POST", "DELETE"]],
  ["/api/forward", ["POST"]],
  ["/api/macros", ["GET", "POST"]],
  // REACAO (03/09/2026): /api/mensagem/reacao resolve canal pelo body (canalDeBody,
  // default central) so no POST. Entrada EXATA, antes do /api/mensagem generico:
  // a prova cobra uma por rota que resolve canal, e sem ela uma chave restrita ao
  // apioficial reagiria em mensagem do central so por omitir `canal`.
  ["/api/mensagem/reacao", ["POST"]],
  ["/api/mensagem", ["PATCH", "DELETE"]],
  ["/api/messages", ["GET"]],
  ["/api/midia", ["POST"]],
  ["/api/nota", ["POST"]],
  // Frente T (card 86ak85ny7): SO o POST resolve canal (canalDeBody) — o GET
  // apenas diz se a transcricao esta configurada nesta instalacao, e essa
  // resposta nao tem canal. Metodo sobrando aqui seria verbete morto fingindo
  // cobertura, e a prova cobra a igualdade nos dois sentidos.
  ["/api/transcricao", ["POST"]],
  ["/api/send", ["POST"]],
  ["/api/visibilidade", ["POST"]],
  ["/api/webhook", ["POST"]],
];

/**
 * Rotas que mexem em TODOS os canais de uma vez, sem ler canal do pedido.
 *
 * Elas SEGUEM na tabela acima, e isso nao e contradicao: assumir `central` e
 * justamente o que barra uma chave de um canal so, e barrar e o certo — a rota
 * mexeria no central de qualquer jeito. O que o marcador conserta e a FRASE.
 * "esta chave nao alcanca o canal central" manda o dono procurar um parametro
 * `?canal=` que nao existe nessa rota; o motivo certo e dizer que a rota e
 * global. Marcador de TEXTO, entao — nunca de permissao.
 */
export const TOCA_TODOS_OS_CANAIS: readonly string[] = ["/api/midia", "/api/cron-agendadas"];

export function tocaTodosOsCanais(pathname: unknown): boolean {
  const p = typeof pathname === "string" ? pathname.split("?")[0].replace(/\/+$/, "") : "";
  return !!p && TOCA_TODOS_OS_CANAIS.some((r) => p === r || p.startsWith(`${r}/`));
}

/** Esta rota+metodo resolve canal com default `central`? */
export function assumeCanalPadrao(pathname: unknown, metodo: unknown): boolean {
  const p = typeof pathname === "string" ? pathname.split("?")[0].replace(/\/+$/, "") : "";
  const m = String(metodo || "GET").toUpperCase();
  if (!p) return false;
  for (const [prefixo, metodos] of CANAL_PADRAO_EM) {
    if (p === prefixo || p.startsWith(`${prefixo}/`)) return metodos.includes(m);
  }
  return false;
}

/**
 * O AVESSO de `CANAL_PADRAO_EM`: rotas que EXIGEM `canal` explicito e respondem
 * 400 sem ele (`canalObrigatorio`, na porta de lib/canais-porta.ts).
 *
 * Existe por causa do GRAVE da 3a revisao cega. Nessas rotas, canal `null` nao
 * significa "o pedido nao fala de canal" — significa que a resolucao NAO CONSEGUIU
 * ler de qual numero o pedido fala. E `null` sem tabela de default fazia
 * `escopoPermite` simplesmente NAO COMPARAR: o escopo de canal da chave ficava
 * inerte, e uma chave escopada a um numero operava o outro (era o D1; voltou
 * disfarcado de content-type mentido).
 *
 * O fail-closed vale SO pra metodo que muda estado. GET aqui e observacao (o
 * indice `/api/canais` lista numeros e filtra a lista pelo recorte do usuario), e
 * negar leitura sem canal criaria NEGACAO FALSA — defeito que este repo ja mediu.
 *
 * E ele e uma LISTA CURTA de proposito, em vez de "todo recurso `canais`": o
 * recurso `canais` tambem cobre `/api/fotos`, `/api/sync-chatguru`, `/api/vigia`,
 * `/api/embed/*` e `/api/midia` — rotas que NAO leem canal do pedido e que
 * passariam a ser negadas pra qualquer chave com recorte de numero. Negacao falsa
 * e o outro lado do mesmo erro, e a revisao cobrou os dois.
 *
 * A prova (`scripts/prova-seguranca-conta.ts`, B.13) DERIVA do disco: todo handler
 * que muda estado em `app/api/canais/**` tem de ser coberto por
 * `exigeCanalExplicito`. Rota de canal nova entra sem ninguem lembrar.
 */
export const CANAL_OBRIGATORIO_EM: readonly string[] = ["/api/canais"];

/** Esta rota exige `canal` explicito (400 sem ele)? */
export function exigeCanalExplicito(pathname: unknown): boolean {
  const p = typeof pathname === "string" ? pathname.split("?")[0].replace(/\/+$/, "") : "";
  return !!p && CANAL_OBRIGATORIO_EM.some((r) => p === r || p.startsWith(`${r}/`));
}

// Prefixos, do mais especifico pro mais generico. A ordem importa:
// "/api/conversa/funil" tem que casar antes de "/api/conversa".
const MAPA: ReadonlyArray<[string, Recurso | typeof TRANSPORTE]> = [
  // O MCP remoto e um TUNEL: ele reencaminha pras rotas REST deste mesmo painel
  // levando a MESMA chave, e e LA que metodo e recurso sao conferidos. Gatear a
  // porta do tunel por metodo mataria o MCP inteiro (JSON-RPC streamable e POST
  // por definicao, inclusive pra tool de leitura).
  ["/api/mcp", TRANSPORTE],
  ["/api/conversa/funil", "funis"],
  ["/api/relatorios", "relatorios"],
  ["/api/relatorio", "relatorios"],
  // A exportacao de LINHA tem recurso PROPRIO (`exportacao`), nao `relatorios`.
  // Rota fora de /api/relatorios e verbete fora de `relatorios` sao a mesma decisao
  // vista de dois angulos: aquele portao promete "so numero sai", e uma chave que
  // recebeu "relatorios" recebeu consentimento pra numero agregado — nao pra 50 mil
  // mensagens com conteudo e telefone. Ver o cabecalho de app/api/exportar/route.ts.
  ["/api/exportar", "exportacao"],
  ["/api/disparo", "disparo"],
  ["/api/agendadas", "disparo"],
  ["/api/cron-disparo", "disparo"],
  ["/api/cron-agendadas", "disparo"],
  ["/api/admin", "admin"],
  ["/api/chats", "conversas"],
  ["/api/busca", "conversas"],
  ["/api/conversa", "conversas"],
  ["/api/visibilidade", "conversas"],
  ["/api/messages", "mensagens"],
  // REACAO (03/09/2026): reagir SAI pelo numero da empresa e o cliente ve — e envio,
  // nao leitura de mensagem. Entrada exata ANTES do prefixo /api/mensagem: chave com
  // recurso `mensagens` (so ler) nao pode reagir; precisa de `envio`, como /api/send.
  ["/api/mensagem/reacao", "envio"],
  ["/api/mensagem", "mensagens"],
  ["/api/send", "envio"],
  ["/api/forward", "envio"],
  // BIBLIOTECA (Frente W): as DUAS rotas, e os verbetes sao DIFERENTES de
  // proposito. Anexar um item a uma conversa e MANDAR MENSAGEM pro cliente (a
  // rota so resolve o item e delega pro /api/send com a mesma credencial),
  // entao ela vive no recurso `envio`; administrar o acervo vive em `anexos`.
  // Chave de robo que so dispara material precisa de `envio` e nada mais —
  // dar-lhe `anexos` seria dar-lhe o DELETE do acervo de brinde.
  //
  // A ordem importa (o mapa para no primeiro prefixo que casa): a sub-rota vem
  // ANTES da generica, senao ela herdaria `anexos` e o recorte inverteria.
  ["/api/anexos/conversa", "envio"],
  ["/api/anexos", "anexos"],
  // FRENTE X (31/08/2026) — os DOIS lados do construtor de ficha, e a ordem
  // importa (o mapa casa por prefixo e para no primeiro que bate):
  //
  //  * `/api/campos/valores` = o valor de UM contato -> recurso `ficha`, o mesmo
  //    de `/api/ficha`. E literalmente a mesma coisa que aquela rota escreve, so
  //    com o tipo aplicado; verbete proprio faria uma chave consentida pra ficha
  //    ser negada na porta tipada da MESMA ficha (negacao falsa).
  //  * `/api/campos` = o CATALOGO da instalacao -> recurso `admin`, NAO `ficha`.
  //    Uma chave com `recursos:["ficha"]` foi consentida pra ler e escrever a
  //    ficha de um contato; se o catalogo caisse naquele verbete, a MESMA chave
  //    passaria a poder REMOVER um campo da conta inteira. E exatamente a decisao
  //    que separou `exportacao` de `relatorios` (Frente V) — chave antiga fica
  //    fail-closed e o dono opta explicitamente.
  ["/api/campos/valores", "ficha"],
  ["/api/campos", "admin"],
  ["/api/ficha", "ficha"],
  ["/api/etiquetas", "etiquetas"],
  ["/api/respostas-rapidas", "etiquetas"],
  ["/api/nota", "notas"],
  ["/api/notificacoes", "notas"],
  // transcricao (Frente T, card 86ak85ny7): o que ela PRODUZ e uma anotacao
  // interna, entao quem alcanca notas pela chave alcanca isto. Recurso proprio
  // seria verbete a mais pra mesma escrita, e um recurso "transcricao" faria
  // parecer que existe permissao separada — nao existe: o portao e a conversa.
  ["/api/transcricao", "notas"],
  ["/api/funis", "funis"],
  ["/api/macros", "macros"],
  ["/api/fluxos", "macros"],
  // intencoes (Frente T, card 86ak85nzr): catalogo que a CONDICAO de fluxo
  // consulta — mesma familia do editor. Nao resolve canal (o catalogo e da
  // instalacao, nao de um numero), entao NAO entra em CANAL_PADRAO_EM.
  ["/api/intencoes", "macros"],
  // fila do motor de fluxos (Frente P): mesma familia dos macros — quem pode
  // operar automacao pela chave opera a fila; aprovar continua barrado por
  // identidadePorApiKey na propria rota, verbete nenhum muda isso.
  ["/api/fluxo-fila", "macros"],
  // paridade com /api/cron-disparo: o tick autentica por bearer proprio, o
  // verbete existe pra varredura nao precisar de lista de excecao.
  ["/api/cron-fluxos", "macros"],
  // o webhook de entrada NAO e alcancavel por chave (autentica por `?key=`), e a
  // verbete existe pra varredura da prova poder exigir verbete de TODA rota sem
  // lista de excecao — lista de excecao e o que envelhece calada.
  ["/api/webhook", "canais"],
  // administracao do NUMERO em si (Frente U): conectar por QR/codigo, trocar o
  // chip e o catalogo de templates da API Oficial. Recurso `canais` porque e
  // exatamente o que a descricao dele diz — "manutencao de canais".
  //
  // NOTA de leitura, pra ninguem procurar estas rotas em `CANAL_PADRAO_EM`: elas
  // NAO assumem canal padrao. `?canal=` e OBRIGATORIO nas tres (400 sem ele), e
  // isso e escolha de seguranca, nao esquecimento — default aqui seria
  // desconectar, trocar ou apagar template do NUMERO ERRADO, e tambem daria a
  // uma chave restrita a um numero o alcance do outro por OMISSAO do parametro.
  ["/api/canais", "canais"],
  ["/api/sync-chatguru", "canais"],
  ["/api/midia", "canais"],
  ["/api/fotos", "canais"],
  ["/api/vigia", "canais"],
  ["/api/embed", "canais"],
  ["/api/perfil", "conta"],
  // FRENTE S (31/08/2026): a fila de atendimento e disponibilidade DA PESSOA
  // (entrar/sair/pular a vez) — autoatendimento, como tema e foto em /api/perfil.
  // Recurso `conta` e nao `conversas`: a rota nao le nem escreve conversa nenhuma
  // e nao fala de canal. Ela NAO entra em CANAL_PADRAO_EM (nao resolve canal).
  ["/api/fila-atendimento", "conta"],
  ["/api/minha-chave", "conta"],
  ["/api/users", "conta"],
  ["/api/acesso", "conta"],
  ["/api/politica", "conta"],
];

/**
 * Recurso de um caminho, ou `null` quando o caminho nao esta no mapa.
 * `null` e DENY quando a chave declara `recursos` (fail-closed): rota nova sem
 * verbete nao pode virar buraco. Quem cria rota nova adiciona a linha aqui — e
 * a prova `scripts/prova-seguranca-conta.ts` varre `app/api` cobrando isso.
 */
export function recursoDaRota(pathname: unknown): Recurso | typeof TRANSPORTE | null {
  const p = typeof pathname === "string" ? pathname.split("?")[0].replace(/\/+$/, "") : "";
  if (!p) return null;
  for (const [prefixo, recurso] of MAPA) {
    if (p === prefixo || p.startsWith(`${prefixo}/`)) return recurso;
  }
  return null;
}

// —————————————————————————————————————————————————————————————— escopo
export type EscopoChave = {
  /** So GET/HEAD. Tudo que muda estado e recusado. */
  somente_leitura: boolean;
  /** Canais (numeros) que a chave alcanca. Vazio = todos os do dono. */
  canais: string[];
  /** Recursos que a chave alcanca. Vazio = todos os do dono. */
  recursos: Recurso[];
  /**
   * Chave que trabalha FORA da janela de acesso do dono (robo noturno).
   * Default false = a chave respeita a janela do dono, como uma sessao.
   * SO super admin marca isto (`/api/admin/api-keys`); o autoatendimento
   * (`/api/minha-chave`) nao alcanca — marcar em si mesmo seria furar a
   * propria janela com um passo a mais.
   */
  ignorar_janela: boolean;
};

export const ESCOPO_ABERTO: EscopoChave = {
  somente_leitura: false,
  canais: [],
  recursos: [],
  ignorar_janela: false,
};

/**
 * O canal cabe no escopo desta chave? PURO — e o que a prova exercita.
 *
 * FRENTE S (31/08/2026, 3a revisao). `escopoPermite` decide com o canal do
 * PEDIDO (URL ou corpo). Existem metodos que nao recebem canal nenhum e
 * descobrem o canal DEPOIS, lendo a linha do banco por `id` — o PATCH e o DELETE
 * de `/api/agendadas` sao os dois casos hoje. Pra eles a porta central nao tem o
 * que comparar, e por isso eles ficam FORA de `CANAL_PADRAO_EM` (declarar canal
 * padrao ali criaria negacao falsa). A comparacao entao acontece na rota, com
 * esta funcao, no instante em que o canal fica conhecido.
 *
 * Sem isso, uma chave restrita a um canal editava e cancelava agendamento de
 * OUTRO canal — mesma classe de furo que reprovou a Frente U.
 *
 * `canais` vazio = a chave alcanca todos os canais do dono (o default).
 */
export function canalNoEscopo(e: EscopoChave, canal: unknown): boolean {
  if (!e.canais.length) return true;
  const c = typeof canal === "string" ? canal.trim() : "";
  if (!c) return false; // canal desconhecido com escopo restrito NAO passa
  return e.canais.includes(c);
}

export function ehRecurso(v: unknown): v is Recurso {
  return typeof v === "string" && (RECURSOS as readonly string[]).includes(v);
}

function listaDeTexto(bruto: unknown, limite = 40): string[] {
  if (!Array.isArray(bruto)) return [];
  const out: string[] = [];
  for (const v of bruto) {
    if (typeof v !== "string") continue;
    const s = v.trim().slice(0, 60);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= limite) break;
  }
  return out.sort();
}

/**
 * Sanea o jsonb do banco / o corpo da rota. Chave desconhecida e IGNORADA
 * (mesmo espirito de lib/permissoes.ts): escopo velho nao quebra quando a lista
 * cresce, e o front nao consegue gravar recurso inventado.
 */
export function validarEscopoChave(bruto: unknown): EscopoChave {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return { ...ESCOPO_ABERTO };
  const b = bruto as Record<string, unknown>;
  const recursosCrus = listaDeTexto(b.recursos);
  return {
    somente_leitura: b.somente_leitura === true,
    canais: listaDeTexto(b.canais),
    // devolve na ordem canonica de RECURSOS, nao na ordem de digitacao
    recursos: RECURSOS.filter((r) => recursosCrus.includes(r)),
    ignorar_janela: b.ignorar_janela === true,
  };
}

/**
 * MESCLA o escopo pedido sobre o escopo GRAVADO — dimensao ausente FICA COMO ESTA.
 *
 * POR QUE ISTO EXISTE (achado de revisao, e a correcao e na ROTA, nao na tela):
 * `validarEscopoChave` trata campo ausente como o default dele, o que e certo pra
 * ler jsonb do banco e ERRADO pra PATCH. Sem mesclar, um
 * `{escopo: {canais: ["central"]}}` vindo de curl, script ou MCP reescrevia o
 * escopo INTEIRO — e nos DOIS sentidos:
 *
 *   APERTA em silencio: `ignorar_janela` volta a false e a chave de robo noturno
 *   para de trabalhar de madrugada, sem nada dizer por que.
 *
 *   AFROUXA em silencio, que e pior: `somente_leitura` volta a false e `recursos`
 *   volta a vazio (= todos). Quem mandou "so mexe nos canais" acabava de dar
 *   escrita e alcance total pra chave. Esta e a metade que a correcao anterior
 *   (feita so na tela) nao cobria de jeito nenhum.
 *
 * Semantica: PATCH por dimensao. Pra LIMPAR uma dimensao, mande ela explicita
 * (`recursos: []`, `somente_leitura: false`) — omitir nunca e ordem de apagar.
 */
export function mesclarEscopo(atual: EscopoChave, pedido: unknown): EscopoChave {
  const p = pedido && typeof pedido === "object" && !Array.isArray(pedido) ? (pedido as Record<string, unknown>) : {};
  const tem = (chave: string) => Object.prototype.hasOwnProperty.call(p, chave);
  return validarEscopoChave({
    somente_leitura: tem("somente_leitura") ? p.somente_leitura : atual.somente_leitura,
    canais: tem("canais") ? p.canais : atual.canais,
    recursos: tem("recursos") ? p.recursos : atual.recursos,
    ignorar_janela: tem("ignorar_janela") ? p.ignorar_janela : atual.ignorar_janela,
  });
}

/** Nao restringe nada — o estado de toda chave que ja existe. */
export function escopoAberto(e: EscopoChave): boolean {
  return !e.somente_leitura && !e.canais.length && !e.recursos.length;
}

/**
 * TETO DO AUTOATENDIMENTO: quem gera a PROPRIA chave so consegue APERTAR.
 * `ignorar_janela` e a unica dimensao que AFROUXA (fura a janela do dono),
 * entao ela e zerada aqui. Espelha `bloqueiaDelegacao` de lib/permissoes.ts:
 * ninguem entrega a si mesmo o que nao tem.
 */
export function escopoSemPrivilegio(e: EscopoChave): EscopoChave {
  return { ...e, ignorar_janela: false };
}

// —————————————————————————————————————————————————————————— expiracao
/** Chave com prazo vencido. Sem prazo (`null`) nunca vence. */
export function chaveExpirada(expiraEm: unknown, agora: Date = new Date()): boolean {
  if (expiraEm == null || expiraEm === "") return false;
  const t = expiraEm instanceof Date ? expiraEm.getTime() : Date.parse(String(expiraEm));
  // data ilegivel = FAIL-CLOSED. Prazo que ninguem consegue ler nao pode virar
  // "sem prazo": seria transformar erro de gravacao em chave eterna.
  if (Number.isNaN(t)) return true;
  return t <= agora.getTime();
}

// ——————————————————————————————————————————————————————————— a decisao
export type Pedido = {
  metodo: string;
  pathname: string;
  /**
   * Canal JA RESOLVIDO do request (id canonico, como `canalDe` resolveria).
   * `null` = o pedido nao trouxe canal nenhum — e ai vale `CANAL_PADRAO` nos
   * recursos de `RECURSOS_SEMPRE_COM_CANAL`.
   */
  canal?: string | null;
  /**
   * O pedido trouxe DOIS canais diferentes (um na query, outro no corpo).
   * Com escopo de canal, isso e NEGADO: nao da pra saber qual a rota vai usar, e
   * adivinhar a favor do pedinte e o caminho de contrabando.
   */
  divergente?: boolean;
};

export type Veredito = { ok: true } | { ok: false; motivo: string };

const LEITURA = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * O escopo permite ESTE request? Fail-closed em toda duvida.
 *
 * Ordem, e por que:
 *  1. `transporte` (/api/mcp) passa por metodo e recurso — a conferencia real
 *     acontece na rota REST que o tunel chama a seguir, com a mesma chave. O
 *     canal SEGUE valendo aqui, porque o tunel nao muda de numero.
 *  2. somente_leitura barra qualquer metodo que nao seja leitura.
 *  3. recursos: caminho fora do mapa e NEGADO quando ha lista (rota nova nao
 *     vira brecha).
 *  4. canais: o canal do pedido tem que estar na lista — e "sem canal no
 *     pedido" vale `CANAL_PADRAO` nas rotas+metodos de `CANAL_PADRAO_EM`, porque
 *     e o que a rota vai fazer. Query e corpo divergentes = NEGA. E canal que NAO
 *     RESOLVEU (`null`) num metodo que muda estado, numa rota de
 *     `CANAL_OBRIGATORIO_EM`, tambem NEGA — `null` ali nao e "pedido sem canal",
 *     e resolucao que falhou, e deixa-lo passar foi o GRAVE das duas ultimas
 *     revisoes (escopo de canal inerte).
 */
export function escopoPermite(e: EscopoChave, p: Pedido): Veredito {
  const metodo = String(p.metodo || "GET").toUpperCase();
  const recurso = recursoDaRota(p.pathname);
  const ehTunel = recurso === TRANSPORTE;

  if (!ehTunel) {
    if (e.somente_leitura && !LEITURA.has(metodo)) {
      return { ok: false, motivo: "esta chave e somente de leitura" };
    }
    if (e.recursos.length) {
      if (recurso === null) {
        return { ok: false, motivo: "esta chave nao alcanca este recurso" };
      }
      if (!e.recursos.includes(recurso)) {
        return { ok: false, motivo: `esta chave nao alcanca o recurso "${recurso}"` };
      }
    }
  }

  if (e.canais.length) {
    if (p.divergente) {
      return {
        ok: false,
        motivo: "o pedido traz dois canais diferentes (endereco e corpo) — recusado por seguranca",
      };
    }
    // ROTA GLOBAL: nenhum recorte de canal alcanca, e a decisao vem ANTES da
    // comparacao (correcao de revisao). A versao anterior so trocava a FRASE e
    // deixava o furo de pe: `/api/midia` cai no default `central`, entao uma chave
    // restrita a `central` PASSAVA — e a rota processa o `apioficial` no mesmo
    // request, ou seja, a chave mexia no canal que ela nao alcanca. Comparar o
    // canal de uma rota que nao le canal do pedido e a pergunta errada.
    if (!ehTunel && tocaTodosOsCanais(p.pathname)) {
      return {
        ok: false,
        motivo: `esta rota mexe em TODOS os numeros de uma vez, e esta chave alcanca so ${e.canais.join(", ")}`,
      };
    }
    // o mesmo default que a ROTA aplicaria — decidido por rota+metodo, nao por
    // recurso (ver `CANAL_PADRAO_EM`). No tunel do MCP nao se assume nada: o
    // corpo la e JSON-RPC, nao {canal}, e a chamada REST que vem a seguir e que
    // carrega o canal de verdade.
    const canal = p.canal ?? (!ehTunel && assumeCanalPadrao(p.pathname, metodo) ? CANAL_PADRAO : null);
    // FAIL-CLOSED (3a revisao cega): canal NAO RESOLVIDO num pedido que MUDA ESTADO,
    // numa rota que EXIGE canal explicito, e NEGADO. Antes caia no `if` de baixo e
    // passava — `null` nao comparava nada, e o escopo de canal ficava INERTE
    // justamente nas rotas que desconectam, trocam chip e apagam template.
    //
    // Nao cria negacao falsa: a rota ja responde 400 sem `canal` (a porta e a mesma
    // pra todo mundo). O que muda e QUEM responde — e a chave que nao alcanca aquele
    // numero para na porta, em vez de descobrir pelo comportamento da rota.
    if (canal === null && !LEITURA.has(metodo) && exigeCanalExplicito(p.pathname)) {
      return {
        ok: false,
        motivo: `este pedido nao diz de qual numero fala, e esta chave alcanca so ${e.canais.join(", ")}`,
      };
    }
    if (canal && !e.canais.includes(canal)) {
      return { ok: false, motivo: `esta chave nao alcanca o canal "${canal}"` };
    }
  }

  return { ok: true };
}

// ————————————————————————————————————————————————————————————— rotulo
/** Tipos sugeridos, so pra tela agrupar. Texto livre e aceito: e RoTULO, nao
 *  autorizacao — quem autoriza e `escopo`. */
export const TIPOS_CHAVE = ["mcp", "integracao", "leitura", "automacao"] as const;

export function rotuloValido(v: unknown, limite = 60): string | null {
  if (typeof v !== "string") return null;
  // caractere de controle fora (byte nulo faz o PostgREST recusar a coluna text)
  const s = v.replace(new RegExp("[\\u0000-\\u001f\\u007f]", "g"), "").trim().slice(0, limite);
  return s || null;
}

/** Uma linha legivel do que a chave alcanca — pra tela e pro relato de recusa. */
export function resumoEscopo(e: EscopoChave): string {
  const partes: string[] = [];
  partes.push(e.somente_leitura ? "somente leitura" : "leitura e escrita");
  partes.push(e.recursos.length ? `recursos: ${e.recursos.join(", ")}` : "todos os recursos");
  if (e.canais.length) partes.push(`canais: ${e.canais.join(", ")}`);
  if (e.ignorar_janela) partes.push("fora da janela de acesso");
  return partes.join(" · ");
}
