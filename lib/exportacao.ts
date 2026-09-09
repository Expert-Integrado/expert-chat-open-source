// CONSULTAS EXPORTAVEIS — o miolo PURO (card 86ak85bne, delta declarado no
// comentario: "consultas exportaveis de mensagens/usuarios/anotacoes/acessos").
//
// Este arquivo NAO importa nada: roda no Next e em node solto, que e a prova
// (`node scripts/prova-exportacao.ts`). Banco, sessao e permissao ficam na rota.
//
// ————————————————————————————————————————————————————————————————————————
// POR QUE ISTO NAO ENTROU EM /api/relatorios
//
// O portao dos relatorios (lib/relatorios-acesso.ts) tem UM invariante escrito
// com todas as letras, depois de ter sido violado uma vez: "o que sai por este
// portao e NUMERO. Lista de conversa nao sai." Uma consulta de MENSAGENS e o
// oposto disso — ela existe pra tirar LINHA do sistema.
//
// Enfiar linha no portao dos relatorios teria dois efeitos ruins: quebraria o
// invariante que a proxima pessoa vai ler e confiar, e herdaria a ressalva de
// escopo que esta declarada la ("a agregacao e da operacao inteira; filtrar por
// escopo e trabalho no SQL, nao ajuste de rota") — numa exportacao de linha,
// ignorar escopo nao e ressalva, e vazamento.
//
// Entao a porta e outra, `/api/exportar`, com regra propria:
//
//   1. LINHA de conversa (mensagens, anotacoes) so sai pra quem ve a operacao
//      INTEIRA. Nao ha meio: um CSV nao sabe recortar por conversa, e filtrar
//      chat por chat na exportacao seria `podeVerConversa` vezes N mil (e, pior,
//      daria a impressao de recorte exato onde ele seria aproximado).
//      Quem tem visao com recorte recebe 403 com a razao, e a tela diz isso.
//   2. Dado de PESSOA DA EQUIPE (usuarios, acessos) exige `gerenciar_usuarios`:
//      e a mesma permissao que ja governa as telas de onde esse dado vem.
//   3. Sobre tudo isso, `relatorios_exportar` — tirar dado do sistema e
//      permissao propria, decisao da frente J.
//
// A resposta em JSON (sem `formato=csv`) devolve CONTAGEM e nomes de coluna,
// nunca linha. E de proposito: a tela precisa saber "cabe? quantas linhas?" sem
// que a previa se torne um segundo caminho de leitura, mais frouxo que o CSV.

export type IdConsulta = "mensagens" | "anotacoes" | "usuarios" | "acessos";

/** O que a consulta exige de quem chama, alem de `relatorios_exportar`. */
export type ExigenciaConsulta = "visao_sem_recorte" | "gerenciar_usuarios";

export type Consulta = {
  id: IdConsulta;
  titulo: string;
  /** uma frase, na tela, dizendo o que vai dentro do arquivo */
  oQueSai: string;
  exige: ExigenciaConsulta;
  /** a consulta e por canal (mensagens/anotacoes) ou global (usuarios/acessos)? */
  porCanal: boolean;
  /** o periodo (?dias=) recorta esta consulta? */
  porPeriodo: boolean;
  colunas: string[];
  /** migration que precisa ter rodado; null = tabela do 0001 */
  migration: string | null;
};

// Teto por arquivo. NAO e "o maximo que o banco aguenta": e o ponto em que um
// CSV deixa de ser exportacao e passa a ser copia do banco — e copia do banco
// se faz com dump, com decisao humana e destino combinado, nao por um botao numa
// tela de relatorio. Passar do teto NAO trunca calado: a rota avisa e a tela
// manda estreitar o periodo (ver `avisoDeTeto`).
export const TETO_LINHAS = 50_000;

export const DIAS_PADRAO = 30;
export const DIAS_MAX = 3650;

export const CONSULTAS: Consulta[] = [
  {
    id: "mensagens",
    titulo: "Mensagens",
    oQueSai:
      "uma linha por mensagem trocada com o cliente no periodo: data, canal, conversa, direcao, tipo, quem enviou e o texto.",
    exige: "visao_sem_recorte",
    porCanal: true,
    porPeriodo: true,
    colunas: [
      "criada_em",
      "canal",
      "chat_id",
      "direcao",
      "tipo",
      "remetente",
      "enviado_por",
      "status",
      "conteudo",
      "tem_midia",
    ],
    migration: null,
  },
  {
    id: "anotacoes",
    titulo: "Anotacoes internas",
    oQueSai:
      "uma linha por anotacao interna (o que a equipe escreveu na conversa e nunca foi pro cliente): data, conversa, autor e texto.",
    exige: "visao_sem_recorte",
    porCanal: true,
    porPeriodo: true,
    colunas: ["criada_em", "canal", "chat_id", "autor", "texto"],
    migration: null,
  },
  {
    id: "usuarios",
    titulo: "Usuarios do painel",
    oQueSai:
      "uma linha por pessoa com acesso ao painel: papel, escopo de visao, se esta ativa e quando entrou. Sem senha e sem token.",
    exige: "gerenciar_usuarios",
    porCanal: false,
    porPeriodo: false,
    colunas: ["user_id", "nome", "papel", "papel_nomeado", "escopo_visao", "ativo", "assinatura_ativa", "criado_em"],
    migration: null,
  },
  {
    id: "acessos",
    titulo: "Acessos por dispositivo",
    oQueSai:
      "uma linha por (pessoa, navegador, sistema): primeiro acesso, ultimo acesso, ultimo IP e se esta revogado. E o inventario do painel, nao as sessoes do login.",
    exige: "gerenciar_usuarios",
    porCanal: false,
    porPeriodo: true,
    colunas: [
      "user_id",
      "navegador",
      "sistema",
      "rotulo",
      "robo",
      "primeiro_acesso",
      "ultimo_acesso",
      "ultimo_ip",
      "revogado",
    ],
    migration: "0019_seguranca_conta.sql",
  },
];

export function consultaPorId(id: string): Consulta | null {
  return CONSULTAS.find((c) => c.id === id) ?? null;
}

// ————————————————————————————————————————————————————— os quatro recortes
//
// QUATRO coisas recortam o que uma pessoa ve de conversa neste painel, e qualquer
// uma delas invalida a exportacao de LINHA. A conta mora aqui, pura, porque a
// versao dela dentro da rota esqueceu o quarto — e a falta era um vazamento
// (revisao cega de 31/08/2026): a ACL por conversa
// (`mensageria.conversa_visibilidade`) e avaliada em `lib/visibilidade.ts` ANTES do
// atalho `escopo_visao === "todas"`, entao `podeVerConversa` escondia a conversa e a
// exportacao entregava conteudo + telefone.
//
// Regra unica em funcao pura = a prova consegue quebrar cada um dos quatro e ver a
// recusa acontecer. Era exatamente o que faltava.

export type FatosDeRecorte = {
  ehSuperAdmin: boolean;
  /** "todas" | "departamento" | "proprias" (o que estiver no perfil) */
  escopoVisao: string;
  /** contexto embutido do widget */
  contextoEmbutido: "nenhum" | "restrito" | "invalido";
  /** restricao por funil/canal (frente Q) */
  restricaoFunilCanal: "vazia" | "restrito";
  /**
   * ACL por conversa. `tabela_ausente` (migration 0004 nao rodada) e o unico valor
   * que LIBERA sem ACL existir: sem tabela nao ha recorte pra furar, e negar ali
   * travaria a exportacao numa instalacao onde o recorte nem existe.
   */
  aclDeConversa: "nenhuma" | "existe" | "ilegivel" | "tabela_ausente";
};

/**
 * A visao desta pessoa e SEM recorte? PURA. Devolve o motivo do recorte quando ha.
 *
 * Fail-closed nos tres "nao deu pra saber": contexto invalido, restricao ilegivel
 * (quem chama passa "restrito" quando o mapa nao carrega) e ACL ilegivel.
 */
export function recorteDaVisao(f: FatosDeRecorte): { semRecorte: boolean; motivo: string | null } {
  if (f.ehSuperAdmin) return { semRecorte: true, motivo: null };
  if (f.escopoVisao !== "todas") return { semRecorte: false, motivo: `escopo de visao "${f.escopoVisao}"` };
  if (f.contextoEmbutido !== "nenhum") return { semRecorte: false, motivo: "contexto embutido (widget)" };
  if (f.restricaoFunilCanal !== "vazia") return { semRecorte: false, motivo: "restricao por funil/canal" };
  if (f.aclDeConversa === "existe") return { semRecorte: false, motivo: "ACL por conversa nesta instalacao" };
  if (f.aclDeConversa === "ilegivel") return { semRecorte: false, motivo: "nao deu pra ler a ACL por conversa" };
  return { semRecorte: true, motivo: null };
}

/**
 * O erro da leitura da ACL virou qual FATO? PURA.
 *
 * Aqui `tabela_ausente` e o unico valor que LIBERA, entao o mapeamento e a superficie
 * mais perigosa do recorte — e a versao anterior era fail-OPEN (achado da re-revisao
 * cega de 31/08/2026): aceitava `PGRST205` e `PGRST204` como tabela ausente.
 *
 * `PGRST205` ("could not find the table in the schema cache") NAO e schema ausente: e
 * o estado TRANSITORIO do PostgREST logo depois de um DDL, enquanto o cache nao
 * recarregou. Nessa janela, instalacao COM ACL respondia `tabela_ausente` -> LIBERA, e
 * o vazamento do GRAVE reabria por alguns segundos, na hora exata em que alguem estava
 * mexendo no schema.
 *
 * `conversa_visibilidade` e da migration 0004 (antiga): se ela nao existe, o Postgres
 * diz `42P01` e ponto. Qualquer outro codigo aqui — cache, coluna que faltou (`42703`),
 * permissao, rede — e "NAO DEU PRA LER", que RECUSA. Fail-closed e o lado certo: o
 * custo de recusar uma exportacao e um "tente de novo".
 */
export function estadoDaAcl(
  error: { code?: string | null } | null | undefined,
  count: number | null | undefined
): FatosDeRecorte["aclDeConversa"] {
  if (error) return String(error.code ?? "") === "42P01" ? "tabela_ausente" : "ilegivel";
  if (count === null || count === undefined) return "ilegivel";
  return count === 0 ? "nenhuma" : "existe";
}

/** O que a leitura da tabela de ACL devolveu — so o que a DECISAO usa. */
export type LeituraDaAcl = { count?: number | null; error?: { code?: string | null } | null };

/**
 * Existe ACL por conversa nesta instalacao? O EXECUTOR entra por PARAMETRO.
 *
 * A injecao existe por um motivo especifico, e ele e sobre PROVA (achado do
 * micro-check de 31/08/2026): enquanto esta decisao morava dentro da rota, a unica
 * forma de prova era varredura de TEXTO — e varredura protege o call site, nao o
 * corpo. Um `if (count) return "nenhuma"` acrescentado DENTRO do helper da rota
 * liberava o GRAVE inteiro com a bateria verde, porque nenhuma assercao executava
 * a decisao. Com o executor injetado, a prova exercita os cinco desfechos com fake
 * (`scripts/prova-exportacao.ts`) e mutacao no corpo MORRE.
 *
 * O que sobra na rota e I/O de uma linha: `head: true` + `count: exact` nao traz
 * linha nenhuma, so o numero — instalacao sem ACL (o caso normal) paga uma consulta
 * de contagem e nao paga leitura de dado.
 *
 * A checagem e GROSSA de proposito: "existe QUALQUER ACL?" e nao "quais conversas
 * tem ACL". Um CSV nao sabe recortar; recusar por causa de uma ACL que talvez nao
 * pegasse esta pessoa e um falso negativo barato, e o falso positivo custa o
 * vazamento.
 *
 * Leitura que ESTOURA (rede, cliente mal configurado) e `ilegivel`, nao excecao
 * propagada: "nao deu pra ler" e RECUSA com razao na tela, e nao 500 sem explicacao.
 */
export async function aclDeConversa(
  ler: () => PromiseLike<LeituraDaAcl>
): Promise<FatosDeRecorte["aclDeConversa"]> {
  let r: LeituraDaAcl | null = null;
  try {
    r = await ler();
  } catch {
    return "ilegivel";
  }
  return estadoDaAcl(r?.error, r?.count);
}

/**
 * Quem chama pode rodar esta consulta? PURA — e o mesmo calculo na rota (que
 * decide o 403) e na tela (que decide o que mostrar), pra tela nunca oferecer
 * botao que o servidor recusa.
 *
 * `visaoSemRecorte` e uma decisao do chamador, nao um papel: e verdade quando a
 * pessoa ve a operacao inteira (super admin, ou escopo `todas` sem restricao de
 * funil/canal e sem contexto embutido).
 */
export function motivoParaNaoExportar(
  c: Consulta,
  quem: { podeExportar: boolean; visaoSemRecorte: boolean; gerenciaUsuarios: boolean }
): string | null {
  if (!quem.podeExportar) {
    return "sem a permissao de exportar (relatorios_exportar) — marcar na tela de papeis";
  }
  if (c.exige === "gerenciar_usuarios" && !quem.gerenciaUsuarios) {
    return `"${c.titulo}" e dado das pessoas da equipe: exige a permissao de gerenciar usuarios`;
  }
  if (c.exige === "visao_sem_recorte" && !quem.visaoSemRecorte) {
    return `"${c.titulo}" tira conversa de cliente do sistema, e seu acesso ve um RECORTE das conversas (escopo de visao, restricao por funil/canal ou contexto embutido). Um arquivo unico nao sabe respeitar esse recorte, entao a exportacao e recusada em vez de sair errada.`;
  }
  return null;
}

/** Consultas que este chamador consegue rodar, com o motivo de cada recusa. PURA. */
export function catalogoParaQuem(quem: {
  podeExportar: boolean;
  visaoSemRecorte: boolean;
  gerenciaUsuarios: boolean;
}): (Consulta & { disponivel: boolean; motivo: string | null })[] {
  return CONSULTAS.map((c) => {
    const motivo = motivoParaNaoExportar(c, quem);
    return { ...c, disponivel: !motivo, motivo };
  });
}

/** `?dias=` dentro dos limites. PURA. Valor torto cai no padrao, nunca em NaN. */
export function diasDoPedido(bruto: unknown): number {
  const n = Number(bruto);
  if (!Number.isFinite(n) || n <= 0) return DIAS_PADRAO;
  return Math.min(DIAS_MAX, Math.floor(n));
}

/** Corte ISO do periodo. PURA (recebe o agora, pra prova nao depender do relogio). */
export function desdeIso(dias: number, agora: Date): string {
  return new Date(agora.getTime() - dias * 86_400_000).toISOString();
}

/**
 * Aviso de teto. PURA.
 *
 * Fica ligado ao NUMERO REAL de linhas que o banco tem, nao ao tamanho da
 * pagina: a armadilha aqui e o arquivo sair com 50.000 linhas e parecer
 * completo. Quem le a planilha nao tem como saber que faltou o resto.
 */
export function avisoDeTeto(total: number, teto = TETO_LINHAS): string | null {
  if (total <= teto) return null;
  return `o periodo escolhido tem ${total.toLocaleString("pt-BR")} linha(s), acima do teto de ${teto.toLocaleString(
    "pt-BR"
  )} por arquivo. Estreite o periodo (ou o canal) e exporte em partes — o arquivo NAO sai cortado pela metade sem aviso.`;
}

// ——————————————————————————————————————————— quando o arquivo sai incompleto
//
// Duas marcas, e as duas existem porque **o cabecalho HTTP 200 ja foi** quando o
// problema aparece: nao existe como virar 500 no meio de um download. Entao o aviso
// entra NO ARQUIVO, como ultima linha.
//
// A segunda (`INCOMPLETA`) nasceu de um achado da revisao cega: nada conferia as
// linhas ESCRITAS contra a contagem. Um short-read — o `db-max-rows` do PostgREST
// abaixo do tamanho da pagina, ou um erro engolido — encerrava o laco mais cedo, e o
// CSV saia curto com HTTP 200 e **sem marca nenhuma**. Planilha que termina antes,
// sem dizer, e indistinguivel de planilha completa.
export const MARCA_INTERROMPIDA = "# EXPORTACAO INTERROMPIDA";
export const MARCA_INCOMPLETA = "# EXPORTACAO INCOMPLETA";

// ATENCAO ao mexer no TEXTO destas duas linhas: elas nao podem conter `"`, `,`, `;`
// nem quebra de linha. `csvCampo` (lib/relatorios.ts) aspa o campo quando ve qualquer
// um desses, e a linha aspada e indistinguivel de uma linha CONTINUADA de campo de
// texto — que e exatamente o que o cliente controla. Sem aspas, a marca do sistema
// tem uma forma que conteudo de cliente nao consegue imitar (ver `problemaNoCsv`).

/** A linha de rodape quando escreveu menos que o contado. PURA. `null` = fechou. */
export function linhaDeIncompleto(escritas: number, total: number): string | null {
  if (escritas >= total) return null;
  return `${MARCA_INCOMPLETA}: ${escritas} de ${total} linha(s) — o arquivo esta CURTO. Exporte de novo e se repetir estreite o periodo.`;
}

/**
 * A linha de rodape quando o stream morreu no meio. PURA.
 *
 * O texto do erro entra SANEADO: `"`/`,`/`;`/quebra de linha viram espaco. Sem isso um
 * erro do Postgres com virgula fazia `csvCampo` aspar a linha inteira, e linha aspada
 * e a forma que `problemaNoCsv` tem que recusar (ver ali).
 */
export function linhaDeInterrompido(erro: unknown, escritas: number, total: number): string {
  const limpo = String((erro as any)?.message || erro || "")
    .replace(/[",;\r\n\t]+/g, " ")
    .trim()
    .slice(0, 200)
    .trim();
  return `${MARCA_INTERROMPIDA}: ${limpo || "falha sem mensagem"} (${escritas} de ${total} linha(s) escritas)`;
}

/**
 * O CSV baixado carrega marca de problema? PURA — a tela usa isso pra avisar em vez
 * de entregar o arquivo calado (a marca esta na ULTIMA linha, nao no cabecalho HTTP).
 *
 * TRES exigencias, e as tres existem porque o CLIENTE escreve o conteudo das
 * mensagens (achado da re-revisao cega de 31/08/2026). Uma mensagem com
 * "\n# EXPORTACAO INCOMPLETA: ... ligue 0800" virava aviso do SISTEMA na tela do
 * gestor — e, pior, podia mascarar a marca de verdade:
 *
 *   1. so a ULTIMA linha conta. As duas marcas sao sempre o ultimo `push` do stream;
 *      linha continuada de campo de texto no meio do arquivo nao interessa.
 *   2. a linha nao pode ter `"`. Marca do sistema nunca e aspada (o texto delas nao
 *      tem `,` `;` nem `"`); campo de texto continuado sempre carrega a aspa que abre
 *      ou fecha o campo.
 *   3. a linha tem que ter a FORMA da marca (o contador no fim), nao so o prefixo.
 *
 * E uma QUARTA, que existe por causa de quem chama (micro-check de 31/08/2026): o
 * texto tem que ter pelo menos DUAS linhas. A tela le so a cauda do arquivo
 * (`blob.slice`, 4 KB) — e se a ultima linha do CSV for MAIOR que a janela, a cauda
 * comeca no MEIO do texto do cliente e vira um fragmento cujo "comeco de linha" foi
 * FABRICADO pelo corte. Sem esta exigencia, uma mensagem de 5 KB terminada na marca
 * forjada passava, e o banner mostrava ao gestor ate 4 KB de texto escolhido por
 * terceiro. Marca legitima tem menos de 300 bytes, entao a janela de 4 KB SEMPRE
 * contem a quebra de linha anterior a ela; e arquivo menor que a janela e lido
 * inteiro (com o cabecalho dentro). Duas linhas nunca faltam no caso honesto.
 */
const FORMA_DA_MARCA = [
  new RegExp(`^${MARCA_INCOMPLETA}: \\d+ de \\d+ linha\\(s\\) `),
  new RegExp(`^${MARCA_INTERROMPIDA}: .+ \\(\\d+ de \\d+ linha\\(s\\) escritas\\)$`),
];

export function problemaNoCsv(texto: string): string | null {
  const linhas = String(texto || "").replace(/\s+$/, "").split(/\r?\n/);
  if (linhas.length < 2) return null;
  const ultima = linhas[linhas.length - 1] ?? "";
  if (ultima.includes('"')) return null;
  return FORMA_DA_MARCA.some((re) => re.test(ultima)) ? ultima : null;
}

/** Nome do arquivo. PURA. Sanitizado porque canal vem de configuracao. */
export function nomeDoArquivo(id: IdConsulta, canal: string | null, dia: string): string {
  const partes = [id, canal || null, dia].filter(Boolean).join("-");
  const limpo = partes.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${limpo || "exportacao"}.csv`;
}

// ————————————————————————————————————————————————————————— linha -> colunas
//
// Cada mapeador recebe a linha CRUA do banco e devolve os valores na ordem das
// `colunas` da consulta. A ordem e a mesma lista: cabecalho e corpo nao podem
// sair de lugares diferentes (o jeito classico de um CSV trocar de coluna no
// meio da vida do produto).

export function linhaMensagem(r: Record<string, unknown>, canal: string): unknown[] {
  return [
    r.criada_em ?? "",
    canal,
    r.chat_id ?? "",
    r.direcao ?? "",
    r.tipo ?? "",
    r.sender_name ?? r.sender_phone ?? "",
    r.enviado_por_nome ?? "",
    r.status ?? "",
    // apagada no WhatsApp: o texto original nao vai pro arquivo. O painel ja
    // trata `is_deleted` como "esta mensagem foi apagada" na tela, e exportar o
    // conteudo de uma mensagem apagada seria desfazer isso num arquivo solto.
    r.is_deleted ? "(mensagem apagada)" : (r.conteudo ?? ""),
    r.media_url ? "sim" : "nao",
  ];
}

export function linhaAnotacao(r: Record<string, unknown>, canal: string): unknown[] {
  return [r.criada_em ?? "", canal, r.chat_id ?? "", r.enviado_por_nome ?? r.sender_name ?? "", r.conteudo ?? ""];
}

export function linhaUsuario(r: Record<string, unknown>): unknown[] {
  return [
    r.user_id ?? "",
    // NOME entra (existe em perfis desde a 0001) e E-MAIL nao: sem o nome a planilha
    // e uma lista de UUIDs, inutil pra decidir quem tira acesso de quem. O e-mail e
    // o LOGIN deste painel, e a lista completa de logins e material de phishing.
    r.nome ?? "",
    r.papel ?? "",
    r.papel_nome ?? "",
    r.escopo_visao ?? "",
    r.ativo === false ? "nao" : "sim",
    r.assinatura_ativa ? "sim" : "nao",
    r.criado_em ?? "",
  ];
}

/**
 * NOMES DE COLUNA DO BANCO x DO ARQUIVO: no banco e `primeiro_acesso_em`,
 * `visto_em` e `ip_ultimo` (migration 0019); no arquivo saem como
 * `primeiro_acesso`, `ultimo_acesso` e `ultimo_ip`, que e o que a tela de
 * dispositivos mostra pra quem le. O mapeamento vive AQUI e nao na rota, pra
 * cabecalho e corpo nunca saírem de fontes diferentes.
 *
 * `user_agent` e `impressao` NAO saem: sao a assinatura tecnica que a tela usa
 * pra casar dispositivo, nao informacao de gestao, e o user-agent cru e texto
 * escolhido pelo cliente.
 */
export function linhaAcesso(r: Record<string, unknown>): unknown[] {
  return [
    r.user_id ?? "",
    r.navegador ?? "",
    r.sistema ?? "",
    r.rotulo ?? "",
    r.robo ? "sim" : "nao",
    r.primeiro_acesso_em ?? "",
    r.visto_em ?? "",
    r.ip_ultimo ?? "",
    r.revogado_em ? "sim" : "nao",
  ];
}

/**
 * E-mail NAO sai na exportacao de usuarios, e isso e escolha. PURA — a funcao
 * existe pra prova poder travar a escolha, e pra quem mudar de ideia ter que
 * mudar aqui e ver o comentario.
 *
 * O arquivo identifica a pessoa pelo `user_id`, que e o que as outras tabelas
 * usam pra cruzar. E-mail e o login de verdade num painel que autentica por
 * e-mail; uma planilha com a lista completa de logins da empresa circulando por
 * anexo e material de phishing pronto, e nao e necessaria pra nenhuma das
 * perguntas que a consulta responde (quem tem acesso, com que papel, ativo ou
 * nao). Quem precisa do e-mail de UMA pessoa abre a tela de usuarios.
 */
export function campoNuncaExportado(coluna: string): boolean {
  return ["email", "e-mail", "senha", "password", "token", "api_key", "chave"].includes(coluna.toLowerCase());
}
