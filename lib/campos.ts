// CAMPOS PERSONALIZADOS DA FICHA — a regra PURA (Frente X, card 86ak85nxn).
//
// O que este arquivo decide, e o motivo de existir separado: cada instalacao
// monta a propria ficha do contato (quais campos existem, de que tipo, em que
// ordem), e as decisoes que mordem — o que e um valor valido, o que acontece
// quando alguem remove um campo, o que "obrigatorio" de fato impede — precisam
// ser provaveis sem banco, sem env e sem navegador. A fiacao (banco) vive em
// `lib/campos-db.ts`; as rotas em `app/api/campos/**`.
//
// IMPORTA UM ARQUIVO SO, e a escolha e deliberada: `./fluxo/variaveis.ts`, por
// causa de `chaveNormalizadaDeCampo`. Essa funcao E o dialeto de nome de campo
// deste painel (ela ja decide o que `!campo.nome_da_empresa` alcanca nas
// respostas rapidas). Reimplementar a normalizacao aqui faria o construtor
// aceitar dois campos que o `!campo.x` nao consegue distinguir — regra copiada
// diverge na primeira mudanca, e aqui a divergencia seria invisivel. Precedente
// da casa: `lib/janela-acesso.ts` importa so `./fuso.ts`;
// `lib/relatorios-tela.ts` importa so `./relatorios.ts`. Segue rodando em node
// solto (`node scripts/prova-campos.ts`), que e a prova.
import { chaveNormalizadaDeCampo } from "./fluxo/variaveis.ts";

// ───────────────────────────────────────────────────────────── o contrato
//
// ONDE O VALOR MORA — leia antes de propor tabela de valores:
// `conversas[_<canal>].ficha` (jsonb), chaveado pelo NOME do campo, valor em
// TEXTO. Nao e escolha estetica: quem ja grava ali e o sync do ChatGuru
// (`lib/chatguru-sync.ts`), que le os rotulos da tela de origem, cria no
// catalogo o campo que apareceu novo (`{nome, ativo, ordem}` e mais nada) e
// funde `{...atual, ...ficha}` na coluna. Mudar a casa do valor, ou exigir
// coluna que o sync nao preenche, quebraria um cron que roda 1x/min.
//
// CONSEQUENCIA QUE ATRAVESSA TUDO AQUI: o acervo de valores e ANTERIOR aos
// tipos. Valor que nao casa com o tipo do campo NAO e consertado nem descartado
// — e mostrado como esta e marcado `fora_do_formato`. Chute de formato estraga o
// dado que estava certo (a mesma regra que o importador aplica a encoding).

export const TIPOS_CAMPO = ["texto", "numero", "data", "lista", "sim_nao"] as const;
export type TipoCampo = (typeof TIPOS_CAMPO)[number];

/**
 * OS CINCO TIPOS, e por que sao exatamente cinco.
 *
 * O catalogo saiu do que a ficha de atendimento realmente carrega e do que a
 * CONDICAO de fluxo consegue avaliar hoje (`OPERADORES_CONDICAO` em
 * lib/fluxo/schema.ts: igual/diferente/contem/nao_contem/comeca_com/existe/
 * nao_existe — SEM operador de ordem, de proposito).
 *
 * O que ficou FORA, com o motivo, pra ninguem "completar a lista" depois:
 *  - **moeda / porcentagem**: sao `numero` com mascara de tela. Tipo proprio
 *    duplicaria a validacao pra mudar so o sufixo, e a comparacao seria a mesma.
 *  - **data e hora**: a condicao nao tem operador de ordem, entao um campo com
 *    hora so serviria pra igualdade exata — que ninguem usa com hora. E o painel
 *    ja tem fuso por INSTALACAO (lib/fuso.ts): guardar instante num campo de
 *    ficha criaria um segundo relogio pra divergir do primeiro.
 *  - **multipla escolha (lista com N valores)**: o valor da ficha e uma string
 *    unica; guardar lista dentro dela exigiria separador, e separador dentro de
 *    texto digitado por gente e ambiguidade garantida. Quem precisa de multiplo
 *    usa ETIQUETA, que ja e multivalor e ja e campo de condicao.
 *  - **arquivo / anexo**: nao ha onde guardar o arquivo por campo, e inventar
 *    isso e outra entrega (bucket, teto, expiracao).
 */
export const DESCRICAO_TIPO: Record<TipoCampo, string> = {
  texto: "Texto livre. E o tipo de TODO campo que ja existe hoje, e o default de campo criado pelo sync.",
  numero: "Numero. Aceita a virgula decimal do pt-BR na entrada e guarda a forma canonica com ponto.",
  data: "Data (sem hora). Aceita dd/mm/aaaa na entrada e guarda aaaa-mm-dd.",
  lista: "Uma opcao entre as que o administrador cadastrou. Guarda o TEXTO da opcao.",
  sim_nao: "Sim ou nao.",
};

/** Teto de campos ATIVOS na ficha. */
export const MAX_CAMPOS = 60;
/** Teto de opcoes de um campo de lista. */
export const MAX_OPCOES = 40;
export const LIMITE_NOME_CAMPO = 80;
export const LIMITE_OPCAO = 80;
export const LIMITE_DESCRICAO = 200;

/**
 * Teto do valor que o PAINEL grava. E o numero que ja valia em
 * `/api/ficha` (PATCH) — nao mexi nele.
 *
 * ELE NAO VALE PRA LEITURA, e isso e deliberado: o sync do ChatGuru grava ate
 * 5000 chars (`corta(val, 5000)`), entao um valor legitimo do acervo pode ser
 * maior que este teto. Reprovar na leitura marcaria como "fora do formato" um
 * valor que a operacao gravou por um caminho que sempre existiu.
 */
export const LIMITE_VALOR_CAMPO = 1000;

/**
 * Quantas chaves um PATCH de ficha pode trazer de uma vez.
 *
 * O teto existe porque a Frente X TROCOU o desfecho de campo fora do catalogo:
 * antes ele era descartado em silencio (e `/api/ficha` cortava a iteracao num
 * `slice(0, 60)`), agora ele entra em `recusados` e a resposta e 422 com a lista.
 * Sem teto, um corpo com 10 mil chaves vira 10 mil linhas de recusa e um erro de
 * megabytes — a rota fica cara de propria conta e a mensagem, ilegivel.
 *
 * 120 e folgado de proposito: o teto de campos ATIVOS e `MAX_CAMPOS` (60), e
 * ninguem escreve mais que isso de uma vez num uso legitimo. O dobro deixa espaco
 * pra quem manda campo arquivado junto e ainda assim recebe a recusa nominal.
 */
export const MAX_CHAVES_PATCH = 120;

export type VereditoDaPorta =
  | { ok: true }
  | { ok: false; status: 401; erro: "unauthorized" }
  | { ok: false; status: 403; erro: string };

/**
 * QUEM PODE ADMINISTRAR OS CAMPOS DA FICHA — decisao PURA.
 *
 * Ela decide o acesso a rota que APAGA CAMPO DA INSTALACAO INTEIRA, e vivia so
 * dentro do handler, cobrada por varredura de texto. Medido na revisao cega:
 * trocar a linha por `if (false && !permitido(...))` deixava as tres provas
 * VERDES — a guarda pegava a REMOCAO da linha, nunca o DESLIGAMENTO dela.
 *
 * Agora a decisao e uma funcao com desfecho observavel, e o handler so a executa.
 * Sem usuario e 401 (nao 403): 'nao sei quem e voce' e diferente de 'sei e voce
 * nao pode'.
 */
export function decidirPorta(user: unknown, temPermissao: boolean): VereditoDaPorta {
  if (!user) return { ok: false, status: 401, erro: "unauthorized" };
  if (!temPermissao) {
    return {
      ok: false,
      status: 403,
      erro: "sem permissao pra administrar os campos da ficha (gerenciar_campos)",
    };
  }
  return { ok: true };
}

/**
 * O NOME CABE NO CAMINHO DE JSONB DO PostgREST?
 *
 * O filtro por chave de jsonb monta o caminho na URL (`ficha->>Nome=not.is.null`),
 * e o nome do campo e TEXTO ESCOLHIDO POR GENTE — com ponto, virgula, parentese.
 * Nome que nao cabe vira `null` (= 'nao deu pra contar', que RECUSA a remocao)
 * ANTES da chamada, com o mesmo desfecho e sem gastar request.
 */
export function nomeCabeNoCaminhoJsonb(nome: unknown): boolean {
  return /^[A-Za-z0-9 _-]{1,80}$/.test(String(nome ?? ""));
}

/**
 * A CONTAGEM DE UMA RESPOSTA — a decisao que separa 'nenhum' de 'nao sei'.
 *
 * E a regra central da frente, e ela vivia so dentro do executor: uma mutacao que
 * trocava o `null` do erro por `0` sobrevivia a bateria inteira, e a partir dai o
 * painel ofereceria remover um campo dizendo que NENHUMA conversa usa — depois de
 * uma consulta que nem respondeu. Aqui a decisao e pura e provada por caso.
 *
 * `null` sai em tres situacoes, e as tres significam a mesma coisa: erro na
 * consulta, resposta ausente, e resposta que nao e numero.
 *
 * A COERCAO E POR TIPO, NUNCA `Number(qualquer coisa)` — medido na re-revisao
 * cega de 31/08/2026: `Number("")`, `Number([])` e `Number(false)` valem 0 e sao
 * FINITOS, entao passavam pelo `Number.isFinite` e viravam contagem ZERO. E zero
 * e exatamente o numero que destrava a remocao do campo ("nenhuma conversa usa
 * este campo"). Resposta vazia de PostgREST, `head:true` sem `count`, corpo
 * `[]` — todos caiam nisso. Agora so `number` finito e string NAO-VAZIA que
 * converte passam; o resto e NAO SEI.
 *
 * E ELA ERRA FECHADO quando a forma da resposta muda: se a RPC
 * `contar_valores_campo` virar `returns setof bigint`, `data` passa a ser `[7]` —
 * uma LISTA, que nao e `number` nem string. A coercao responde "nao sei", o
 * impacto fica `incompleto` e `vereditoDaRemocao` RECUSA. Ou seja: a mudanca de
 * forma bloqueia a remocao em vez de autoriza-la no escuro. E o lado certo pra
 * errar, e esta escrito pra ninguem "consertar" isso adicionando um
 * `Array.isArray` sem entender que o preco de acertar a forma nova e reabrir a
 * porta pro `[]` vazio virar zero.
 */
export function contagemDaResposta(valor: unknown, erro?: unknown): number | null {
  if (erro) return null;
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  if (typeof valor === "string" && valor.trim() !== "") {
    const n = Number(valor);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export type CampoFicha = {
  id: string;
  nome: string;
  tipo: TipoCampo;
  obrigatorio: boolean;
  opcoes: string[];
  descricao: string | null;
  ordem: number;
  ativo: boolean;
};

// ─────────────────────────────────── a FORMA do catalogo, decidida aqui

export type CatalogoCampos = {
  /**
   * A LEITURA DEU CERTO? `false` = `campos` esta vazio porque nao deu pra ler, e
   * NAO porque a instalacao nao tem campo.
   *
   * Existe como campo PROPRIO, e nao como "tem `aviso`", porque `aviso` tem dois
   * donos: a 0025 pendente (degradacao PREVISTA — os campos continuam
   * funcionando como texto livre) e a falha de leitura (nao da pra decidir nada).
   * Confundir os dois travaria o construtor em toda instalacao que ainda nao
   * rodou a migration, que e exatamente o contrario do desenho.
   *
   * Quem ESCREVE tem que conferir isto antes de usar `campos`: com lista vazia
   * por engano, o teto de MAX_CAMPOS nao se aplica, a colisao normalizada nao e
   * detectada e `ordem` nasce 1 colidindo — e ai sobra so a UNIQUE exata da 0001,
   * que deixa "CNPJ" conviver com um "cnpj" existente. A partir dai `acharCampo`
   * fica ambiguo e TODA escrita naquele campo e recusada, na conta inteira.
   */
  legivel: boolean;
  campos: CampoFicha[];
  /** as colunas de tipo/obrigatorio/opcoes existem nesta instalacao? */
  tipos_disponiveis: boolean;
  /** a funcao de renome com migracao de valor existe? */
  renome_disponivel: boolean;
  aviso?: string;
};

export const AVISO_0025 =
  "a migration 0025 nao rodou nesta instalacao: os campos funcionam como texto livre (tipo, obrigatorio e opcoes nao gravam)";

/**
 * LEITURA QUE FALHOU — a forma que diz "nao sei", e que so podia ser decidida
 * aqui.
 *
 * Ela vivia como objeto literal dentro de `lerCatalogo` (lib/campos-db.ts, que
 * fala com o banco e nao roda em node solto), e por isso a unica prova possivel
 * era varredura de texto. Medido na re-revisao cega de 31/08/2026: trocar
 * `legivel: false` por `true` naquele literal sobrevivia a bateria INTEIRA — e
 * com isso `ilegivel()` para de recusar, `criar()` volta a decidir teto/colisao/
 * ordem contra uma lista vazia, e o painel volta a dizer "esta instalacao nao tem
 * campo nenhum" depois de uma consulta que nem respondeu. E o defeito que a
 * frente inteira existe pra fechar.
 *
 * `tipos_disponiveis` e `renome_disponivel` saem `false` junto de proposito:
 * quem nao conseguiu ler o catalogo tambem nao pode PROMETER tipo nem renome.
 */
export function falhaDeLeitura(motivo: string): CatalogoCampos {
  return {
    campos: [],
    legivel: false,
    tipos_disponiveis: false,
    renome_disponivel: false,
    aviso: `falha ao ler o catalogo de campos: ${motivo}`,
  };
}

/**
 * LEITURA QUE DEU CERTO, com o que esta instalacao consegue oferecer.
 *
 * `renome_disponivel` e a conjuncao das DUAS medicoes (colunas da 0025 E a RPC
 * chamavel), e ela mora aqui pelo mesmo motivo: solta no literal da fiacao, a
 * mutacao `disponiveis && rpcOk() || true` sobrevivia (a guarda antiga era um
 * regex sobre o texto do arquivo). Com `|| true` a tela PROMETE o renome com
 * migracao e a rota devolve 502 com a mensagem crua do Postgres — e o admin so
 * descobre no meio do renome.
 */
export function catalogoLido(
  campos: CampoFicha[],
  colunasDisponiveis: boolean,
  rpcDisponivel: boolean
): CatalogoCampos {
  return {
    campos,
    legivel: true,
    tipos_disponiveis: colunasDisponiveis,
    renome_disponivel: colunasDisponiveis && rpcDisponivel,
    aviso: colunasDisponiveis ? undefined : AVISO_0025,
  };
}

// ──────────────────────── a rota ANTIGA de catalogo (/api/admin/ficha-config)

export type VereditoConfig = { ok: true } | { ok: false; status: number; erro: string };

/**
 * O QUE A ROTA ANTIGA NAO PODE MAIS FAZER — decisao PURA.
 *
 * `/api/admin/ficha-config` e a tela velha (aba "Ficha" das configuracoes). Ela
 * faz UPDATE direto em `campos_personalizados` e NAO varre canal nenhum, entao os
 * dois gestos abaixo eram perda silenciosa de dado do cliente:
 *
 *  - RENOMEAR: o valor continua gravado sob o nome ANTIGO em `conversas.ficha`, e
 *    a tela da conversa desenha a ficha iterando o CATALOGO. Depois do rename o
 *    valor de todo mundo fica no banco e INVISIVEL.
 *  - DESATIVAR: a ficha da conversa itera o catalogo ATIVO, entao o valor some da
 *    tela no instante do clique — sem aviso, sem numero, sem "valores sem campo".
 *
 * Os dois tem caminho novo que MEDE antes (`POST /api/campos`, acoes `editar` e
 * `arquivar`). REATIVAR (`ativo: true`) continua passando: ele nao esconde nada.
 *
 * A decisao esta aqui, e nao no handler, porque handler importa `next/server` e
 * so alcanca prova de VARREDURA — e varredura pega a remocao da linha, nunca o
 * desligamento dela (`if (false && ...)`). Medido na re-revisao cega.
 */
export function decidirPatchDeCatalogo(
  tipo: unknown,
  patch: { nome?: unknown; ativo?: unknown }
): VereditoConfig {
  if (tipo !== "campo") return { ok: true };
  if (patch.nome !== undefined) {
    return {
      ok: false,
      status: 409,
      erro:
        "renomear campo da ficha nao acontece por aqui: o valor gravado nas conversas continuaria no nome antigo e sumiria da tela. Use a tela de campos da ficha (POST /api/campos, acao editar), que move os valores antes de trocar o nome.",
    };
  }
  if (patch.ativo === false) {
    return {
      ok: false,
      status: 409,
      erro:
        'desativar campo da ficha nao acontece por aqui: o valor gravado nas conversas sumiria da tela sem ninguem ver quantas sao. Use a tela de campos da ficha (POST /api/campos, acao arquivar), que mede o impacto antes e mantem os valores visiveis como "valores sem campo".',
    };
  }
  return { ok: true };
}

/**
 * NOME DE CAMPO NOVO pela rota antiga — o mesmo saneamento da rota nova.
 *
 * O `trim().slice(0,80)` de antes aceitava "%", "---", "..." — nome que
 * NORMALIZA PRA VAZIO. Ele pareceria funcionar (a escrita casa por nome exato) e
 * falharia calado em tres lugares: `!campo.<chave>` das respostas rapidas nao
 * alcanca o campo, a condicao de `ficha` do fluxo tambem nao, e `colisoesDeNome`
 * nao enxerga dois deles no mesmo catalogo (`mesmoCampo` devolve false com chave
 * vazia, entao nem a colisao logo abaixo barraria).
 */
export function decidirNomeDeCampoNovo(
  bruto: unknown
): { ok: true; nome: string } | { ok: false; status: 422; erro: string } {
  const saneado = nomeDeCampo(bruto);
  if (!saneado) {
    return { ok: false, status: 422, erro: "nome de campo invalido (1 a 80 caracteres, sem quebra de linha)" };
  }
  if (!chaveDeCampo(saneado)) {
    return {
      ok: false,
      status: 422,
      erro:
        "nome precisa ter pelo menos uma letra ou numero (a ficha alcanca o campo por `!campo.<nome>`, e so pontuacao nao vira chave)",
    };
  }
  return { ok: true, nome: saneado };
}

/**
 * COLISAO DE NOME NA CRIACAO — e ela FALHA FECHADO.
 *
 * A versao anterior descartava o `error` do select: consulta que falhava virava
 * `[]` e NENHUMA colisao era detectada, justo quando o banco esta ruim. 503 (a
 * leitura pode voltar no proximo pedido), nunca "pode criar".
 *
 * Igualdade NORMALIZADA, nunca `ilike`: `_` e comum em nome de campo importado e
 * viraria coringa.
 *
 * FRONTEIRA DECLARADA (medida na re-revisao cega, 31/08/2026, e mantida de
 * proposito): resposta AUSENTE sem erro — `decidirColisaoNoCatalogo(undefined,
 * null, nome)` — devolve `ok: true`, ou seja, e lida como catalogo vazio. E o
 * mesmo comportamento de antes desta frente, e o PostgREST nao produz essa forma
 * (select sem erro devolve array — vazio no limite, nunca `undefined`). Quem
 * recusa aqui e o ERRO. REGISTRADO, NAO CORRIGIDO: separar `undefined` de `[]`
 * seria possivel, mas trocaria uma forma que o cliente nao emite por uma regra a
 * mais no caminho que decide se um campo pode nascer. Se algum dia outro cliente
 * (ou um mock) passar a devolver ausencia sem erro, e AQUI que se conserta.
 */
export function decidirColisaoNoCatalogo(
  existentes: unknown,
  erroDeLeitura: unknown,
  nome: string
): VereditoConfig {
  if (erroDeLeitura) {
    const msg =
      typeof erroDeLeitura === "object" && erroDeLeitura && "message" in (erroDeLeitura as any)
        ? String((erroDeLeitura as any).message)
        : String(erroDeLeitura);
    return {
      ok: false,
      status: 503,
      erro: `nao deu pra ler o catalogo de campos pra conferir colisao de nome: ${msg}`,
    };
  }
  const lista = Array.isArray(existentes) ? (existentes as { nome?: unknown; ativo?: unknown }[]) : [];
  const colide = lista.find((c) => mesmoCampo(c?.nome, nome));
  if (colide) {
    return {
      ok: false,
      status: 409,
      erro: `ja existe o campo "${String(colide.nome)}"${colide.ativo ? "" : " (arquivado)"} — nomes que diferem so por caixa ou acento disputariam o mesmo valor na ficha`,
    };
  }
  return { ok: true };
}

/**
 * ARQUIVAR E EM DOIS PASSOS, IGUAL AO REMOVER — decisao PURA.
 *
 * Arquivar tira o campo do formulario da CONTA INTEIRA. A versao anterior
 * APLICAVA e so depois contava quantas conversas tinham ficado com valor sem
 * campo: o numero chegava quando nao dava mais pra decidir com ele. Sem
 * `confirmar: true` a resposta e PREVIA e nao muda nada; com, aplica.
 *
 * REATIVAR nao tem previa de proposito: ele nao esconde nada de ninguem, so
 * devolve o campo ao formulario. Previa pra gesto sem consequencia vira ritual, e
 * ritual e a coisa que as pessoas aprendem a clicar sem ler.
 */
export function decidirArquivamento(arquivando: boolean, confirmar: unknown): "reativar" | "previa" | "arquivar" {
  if (!arquivando) return "reativar";
  return confirmar === true ? "arquivar" : "previa";
}

// ───────────────────────────────────────────────── nome e chave do campo

/**
 * Nome do campo saneado. `null` = nome invalido.
 *
 * Controle e quebra de linha ficam fora: o nome vai pro rotulo da ficha, pro
 * `title` do input e pro relatorio — e ele e tambem a CHAVE do jsonb, entao um
 * `\n` no meio produziria uma chave que ninguem consegue digitar de novo.
 */
export function nomeDeCampo(bruto: unknown): string | null {
  if (typeof bruto !== "string") return null;
  const nome = bruto.replace(/\s+/g, " ").trim();
  if (!nome || nome.length > LIMITE_NOME_CAMPO) return null;
  if (/[\u0000-\u001f]/.test(nome)) return null;
  return nome;
}

/**
 * A chave normalizada de um nome de campo — o MESMO dialeto de
 * `!campo.<chave>` das respostas rapidas.
 *
 * Reexportada daqui pra quem monta condicao e pra tela nao precisarem conhecer
 * `lib/fluxo/variaveis.ts`: o construtor e o dono do catalogo, entao e daqui que
 * sai a chave canonica.
 */
export function chaveDeCampo(nome: unknown): string {
  return chaveNormalizadaDeCampo(nome);
}

/**
 * Dois nomes de campo colidem?
 *
 * IGUALDADE NORMALIZADA, NUNCA `ilike` — armadilha conhecida deste repo: `%` e
 * `_` digitados por gente viram coringa e passam a casar campo que ninguem
 * pediu. E `_` e comum de verdade em nome de campo importado.
 */
export function mesmoCampo(a: unknown, b: unknown): boolean {
  const ca = chaveDeCampo(a);
  const cb = chaveDeCampo(b);
  return !!ca && ca === cb;
}

/**
 * Resolve o nome pedido contra o catalogo: EXATO primeiro, normalizado depois, e
 * so quando o normalizado e UNICO.
 *
 * A ordem e a mesma disciplina do `resolver.mjs` do importador (id -> nome
 * normalizado -> posicao, e "nada de parecido"): ambiguo NAO e chute. Aqui a
 * ambiguidade e real e medida no acervo — o sync cria o campo com o rotulo da
 * origem, e ao longo dos anos a mesma coisa aparece escrita de formas diferentes
 * ("CNPJ" e "cnpj" convivem). Se `cnpj` casasse com o primeiro que aparecesse, a
 * escrita cairia num campo e a leitura no outro.
 */
export function acharCampo(
  catalogo: readonly CampoFicha[],
  pedido: unknown
): { campo: CampoFicha } | { erro: "nao_existe" | "ambiguo" } {
  const nome = typeof pedido === "string" ? pedido.trim() : "";
  if (!nome) return { erro: "nao_existe" };
  const exato = catalogo.find((c) => c.nome === nome);
  if (exato) return { campo: exato };
  const chave = chaveDeCampo(nome);
  if (!chave) return { erro: "nao_existe" };
  const iguais = catalogo.filter((c) => chaveDeCampo(c.nome) === chave);
  if (iguais.length === 1) return { campo: iguais[0] };
  return { erro: iguais.length ? "ambiguo" : "nao_existe" };
}

// ────────────────────────────────────────────────── definicao do campo

export type DefinicaoBruta = {
  nome?: unknown;
  tipo?: unknown;
  obrigatorio?: unknown;
  opcoes?: unknown;
  descricao?: unknown;
};

export type CampoNovo = {
  nome: string;
  tipo: TipoCampo;
  obrigatorio: boolean;
  opcoes: string[];
  descricao: string | null;
};

/** Opcoes de lista saneadas. Duplicata (normalizada) e RECUSA, nao dedupe. */
export function validarOpcoes(bruto: unknown): { ok: true; opcoes: string[] } | { ok: false; erro: string } {
  if (bruto === undefined || bruto === null) return { ok: true, opcoes: [] };
  if (!Array.isArray(bruto)) return { ok: false, erro: "opcoes precisa ser uma lista" };
  if (bruto.length > MAX_OPCOES) return { ok: false, erro: `no maximo ${MAX_OPCOES} opcoes` };
  const opcoes: string[] = [];
  const vistas = new Set<string>();
  for (const b of bruto) {
    if (typeof b !== "string") return { ok: false, erro: "cada opcao precisa ser texto" };
    const o = b.replace(/\s+/g, " ").trim();
    if (!o) return { ok: false, erro: "opcao vazia" };
    if (o.length > LIMITE_OPCAO) return { ok: false, erro: `opcao acima de ${LIMITE_OPCAO} caracteres` };
    if (/[\u0000-\u001f]/.test(o)) return { ok: false, erro: "opcao com quebra de linha" };
    // DUPLICATA E RECUSA, NAO DEDUPE SILENCIOSO: duas opcoes que normalizam
    // igual ("A vista" e "A VISTA") sao indistinguiveis na comparacao de valor,
    // entao uma delas nunca seria escolhivel. Deduplicar calado deixaria a tela
    // mostrando 4 opcoes onde o admin cadastrou 5.
    const k = chaveDeCampo(o);
    if (vistas.has(k)) return { ok: false, erro: `opcao repetida: ${o}` };
    vistas.add(k);
    opcoes.push(o);
  }
  return { ok: true, opcoes };
}

/**
 * Valida a definicao de um campo (criar ou editar).
 *
 * `tipo = lista` SEM opcao e RECUSADO: um select vazio e um campo que ninguem
 * consegue preencher — o mesmo criterio que faz o painel recusar interruptor sem
 * efeito. E tipo diferente de `lista` COM opcoes tambem e recusado, em vez de
 * descartar as opcoes calado: descartar faria o admin trocar o tipo, salvar, e
 * perder a lista que ele tinha cadastrado.
 */
export function validarDefinicao(bruto: DefinicaoBruta): { ok: true; campo: CampoNovo } | { ok: false; erros: string[] } {
  const erros: string[] = [];
  const nome = nomeDeCampo(bruto.nome);
  if (!nome) erros.push(`nome invalido (1 a ${LIMITE_NOME_CAMPO} caracteres, sem quebra de linha)`);
  // NOME QUE NORMALIZA PRA VAZIO E RECUSADO — "%", "---", "...". Ele pareceria
  // funcionar (a escrita casa por nome EXATO) e falharia em tres lugares de uma
  // vez, todos silenciosos: a variavel `!campo.<chave>` das respostas rapidas nao
  // alcancaria o campo, a condicao de `ficha` do fluxo tambem nao, e a deteccao de
  // colisao nao veria dois deles no mesmo catalogo. Campo inalcancavel por metade
  // do painel e campo que ninguem consegue usar depois de cadastrar.
  if (nome && !chaveDeCampo(nome)) {
    erros.push("nome precisa ter pelo menos uma letra ou numero (a ficha alcanca o campo por `!campo.<nome>`, e so pontuacao nao vira chave)");
  }

  const tipoBruto = bruto.tipo === undefined ? "texto" : bruto.tipo;
  const tipo = (TIPOS_CAMPO as readonly unknown[]).includes(tipoBruto) ? (tipoBruto as TipoCampo) : null;
  if (!tipo) erros.push(`tipo desconhecido (use ${TIPOS_CAMPO.join(" | ")})`);

  // BOOLEANO DE VERDADE, como `aprovacao`/`pular_fim_de_semana` no schema de
  // fluxo: `"false"` e `0` nao podem virar `true` por `!!`, e `"true"` nao pode
  // ligar obrigatoriedade que ninguem marcou.
  let obrigatorio = false;
  if (bruto.obrigatorio !== undefined) {
    if (typeof bruto.obrigatorio !== "boolean") erros.push("obrigatorio precisa ser booleano de verdade (true|false)");
    else obrigatorio = bruto.obrigatorio;
  }

  const op = validarOpcoes(bruto.opcoes);
  if (!op.ok) erros.push(op.erro);

  let descricao: string | null = null;
  if (bruto.descricao !== undefined && bruto.descricao !== null) {
    if (typeof bruto.descricao !== "string") erros.push("descricao precisa ser texto");
    else {
      const d = bruto.descricao.replace(/\s+/g, " ").trim();
      if (d.length > LIMITE_DESCRICAO) erros.push(`descricao acima de ${LIMITE_DESCRICAO} caracteres`);
      else descricao = d || null;
    }
  }

  if (tipo && op.ok) {
    if (tipo === "lista" && !op.opcoes.length) {
      erros.push("campo de lista precisa de pelo menos uma opcao (select vazio e campo que ninguem consegue preencher)");
    }
    if (tipo !== "lista" && op.opcoes.length) {
      erros.push(`tipo ${tipo} nao usa opcoes — troque o tipo pra lista ou remova as opcoes (nao descarto calado)`);
    }
  }

  if (erros.length || !nome || !tipo || !op.ok) return { ok: false, erros: erros.length ? erros : ["definicao invalida"] };
  return { ok: true, campo: { nome, tipo, obrigatorio, opcoes: op.opcoes, descricao } };
}

// ───────────────────────────────────────────── valor: escrever e ler

export type ValorAceito = { ok: true; valor: string | null } | { ok: false; erro: string };

const RE_SO_DIGITOS = /^[0-9]+$/;

/**
 * NUMERO — e a decisao mais delicada daqui.
 *
 * Aceita o dialeto que a operacao digita de verdade: `1234`, `1234.56`,
 * `1234,56`, `1.234,56`, `-12`, com espacos em volta.
 *
 * E **RECUSA A AMBIGUIDADE**, em vez de escolher: `1.234` pode ser mil duzentos
 * e trinta e quatro (ponto de milhar, como a operacao escreve) OU um e duzentos
 * e trinta e quatro milesimos (ponto decimal, como a maquina escreve). Nao ha
 * como saber, e as duas leituras diferem por um fator de mil — num campo
 * "Valor da causa" isso e a diferenca entre R$ 1.234 e R$ 1,23. Chutar aqui
 * seria estragar o dado com cara de tela funcionando; a recusa vem com a frase
 * que diz as duas formas nao ambiguas.
 *
 * A canonica guarda PONTO decimal e nenhum separador de milhar: e a forma que
 * volta a ser lida igual em qualquer lugar, inclusive por quem exporta CSV.
 */
export function numeroCanonico(bruto: string): { ok: true; valor: string } | { ok: false; erro: string } {
  const s = bruto.replace(/\s/g, "");
  if (!s) return { ok: false, erro: "numero vazio" };
  const sinal = s.startsWith("-") ? "-" : "";
  const corpo = sinal ? s.slice(1) : s;
  if (!/^[0-9.,]+$/.test(corpo)) return { ok: false, erro: "numero com caractere que nao e digito, ponto ou virgula" };

  const pontos = (corpo.match(/\./g) || []).length;
  const virgulas = (corpo.match(/,/g) || []).length;

  let inteiro = "";
  let fracao = "";

  if (virgulas > 1) return { ok: false, erro: "numero com mais de uma virgula" };
  if (virgulas === 1) {
    // virgula presente = ela E o decimal (pt-BR). Ponto, se houver, e milhar.
    const [i, f] = corpo.split(",");
    inteiro = i.replace(/\./g, "");
    fracao = f;
    if (i.includes(".") && !grupoDeMilharOk(i)) return { ok: false, erro: "grupos de milhar irregulares" };
  } else if (pontos === 0) {
    inteiro = corpo;
  } else if (pontos === 1) {
    const [i, f] = corpo.split(".");
    // A AMBIGUIDADE: exatamente 3 digitos depois do ponto, com parte inteira de
    // 1 a 3 digitos, e a forma que serve as duas leituras ("1.234").
    if (f.length === 3 && i.length >= 1 && i.length <= 3 && RE_SO_DIGITOS.test(i) && RE_SO_DIGITOS.test(f)) {
      return {
        ok: false,
        erro: `"${bruto.trim()}" e ambiguo: o ponto pode ser milhar ou decimal. Escreva ${i}${f} se for milhar, ou ${i},${f} se for decimal`,
      };
    }
    inteiro = i;
    fracao = f;
  } else {
    // varios pontos = so pode ser milhar
    if (!grupoDeMilharOk(corpo)) return { ok: false, erro: "grupos de milhar irregulares" };
    inteiro = corpo.replace(/\./g, "");
  }

  if (!RE_SO_DIGITOS.test(inteiro)) return { ok: false, erro: "parte inteira invalida" };
  if (fracao && !RE_SO_DIGITOS.test(fracao)) return { ok: false, erro: "parte decimal invalida" };
  if (inteiro.length > 18 || fracao.length > 6) return { ok: false, erro: "numero fora do alcance suportado" };

  // zeros a esquerda saem (menos o unico), fracao a direita fica como veio: em
  // dinheiro, "10,50" e "10,5" sao a mesma quantia mas nao a mesma escrita, e
  // reescrever o que a pessoa digitou e mexer no dado dela.
  const iLimpo = inteiro.replace(/^0+(?=[0-9])/, "");
  const canon = fracao ? `${iLimpo}.${fracao}` : iLimpo;
  return { ok: true, valor: (sinal && Number(canon) !== 0 ? "-" : "") + canon };
}

function grupoDeMilharOk(s: string): boolean {
  const partes = s.split(".");
  if (partes.length < 2) return true;
  if (!RE_SO_DIGITOS.test(partes[0]) || partes[0].length < 1 || partes[0].length > 3) return false;
  return partes.slice(1).every((p) => p.length === 3 && RE_SO_DIGITOS.test(p));
}

/**
 * DATA — canonica `aaaa-mm-dd`. Aceita `dd/mm/aaaa` (o que a operacao digita) e
 * `aaaa-mm-dd`.
 *
 * ANO DE DOIS DIGITOS E RECUSADO. Ele existe no acervo (a nota de transcricao
 * importada traz "17/10/24"), e completar o seculo e chute: `24` e 2024 hoje e
 * 1924 num campo de data de nascimento. A recusa diz o que escrever.
 *
 * A validacao e de CALENDARIO, nao de forma: `31/02/2026` casa o regex e nao
 * existe. Sem essa conferencia, o valor entraria canonico e a tela mostraria uma
 * data que o resto do mundo nao reconhece.
 */
export function dataCanonica(bruto: string): { ok: true; valor: string } | { ok: false; erro: string } {
  const s = bruto.trim();
  if (!s) return { ok: false, erro: "data vazia" };
  let a = "";
  let m = "";
  let d = "";
  const iso = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(s);
  const br = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{2,4})$/.exec(s);
  if (iso) {
    [, a, m, d] = iso;
  } else if (br) {
    if (br[3].length !== 4) {
      return { ok: false, erro: `"${s}" tem ano de dois digitos e nao da pra saber o seculo — escreva o ano com 4 digitos` };
    }
    d = br[1].padStart(2, "0");
    m = br[2].padStart(2, "0");
    a = br[3];
  } else {
    return { ok: false, erro: `"${s}" nao e uma data — use dd/mm/aaaa ou aaaa-mm-dd` };
  }
  const ano = Number(a);
  const mes = Number(m);
  const dia = Number(d);
  if (ano < 1900 || ano > 2200) return { ok: false, erro: "ano fora do alcance (1900-2200)" };
  if (mes < 1 || mes > 12) return { ok: false, erro: "mes invalido" };
  if (dia < 1 || dia > diasNoMes(ano, mes)) return { ok: false, erro: `dia invalido para ${m}/${a}` };
  return { ok: true, valor: `${a}-${m}-${d}` };
}

function diasNoMes(ano: number, mes: number): number {
  const trinta = [4, 6, 9, 11];
  if (mes === 2) return (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0 ? 29 : 28;
  return trinta.includes(mes) ? 30 : 31;
}

const SIM = new Set(["sim", "s", "true", "1", "yes", "y", "verdadeiro"]);
const NAO = new Set(["nao", "n", "false", "0", "no", "falso"]);

/** SIM/NAO — canonico `sim` | `nao`. O dialeto aceito e largo na ENTRADA (o que
 * o acervo importado pode ter) e estreito na SAIDA (uma forma so, pra condicao
 * comparar). */
export function simNaoCanonico(bruto: string): { ok: true; valor: string } | { ok: false; erro: string } {
  const s = chaveDeCampo(bruto);
  if (SIM.has(s)) return { ok: true, valor: "sim" };
  if (NAO.has(s)) return { ok: true, valor: "nao" };
  return { ok: false, erro: `"${bruto.trim()}" nao e sim nem nao` };
}

/**
 * Valor pronto pra GRAVAR, ou a recusa com o motivo.
 *
 * `null` (ou texto vazio) significa LIMPAR o campo — quem decide se limpar e
 * permitido e `aplicarPatchDeValores`, que conhece `obrigatorio`.
 *
 * RECUSA EM VEZ DE CORTAR. O caminho antigo (`/api/ficha`) fazia
 * `String(v).slice(0, 1000)`: um endereco, um numero de processo ou um CNPJ
 * chegava truncado ao banco e ninguem era avisado. Mesma licao de
 * `validarInterativa` — cortar entrega ao cliente uma coisa que diz outra.
 */
export function valorParaGravar(campo: CampoFicha, bruto: unknown): ValorAceito {
  if (bruto === null || bruto === undefined) return { ok: true, valor: null };
  if (typeof bruto === "number" || typeof bruto === "boolean") bruto = String(bruto);
  if (typeof bruto !== "string") return { ok: false, erro: "valor precisa ser texto" };
  const cru = bruto.replace(/\r\n/g, "\n").trim();
  if (!cru) return { ok: true, valor: null };
  if (cru.length > LIMITE_VALOR_CAMPO) {
    return { ok: false, erro: `valor com ${cru.length} caracteres; o teto e ${LIMITE_VALOR_CAMPO} (recusado em vez de cortado)` };
  }
  switch (campo.tipo) {
    case "texto":
      return { ok: true, valor: cru };
    case "numero": {
      const r = numeroCanonico(cru);
      return r.ok ? { ok: true, valor: r.valor } : r;
    }
    case "data": {
      const r = dataCanonica(cru);
      return r.ok ? { ok: true, valor: r.valor } : r;
    }
    case "sim_nao": {
      const r = simNaoCanonico(cru);
      return r.ok ? { ok: true, valor: r.valor } : r;
    }
    case "lista": {
      // IGUALDADE NORMALIZADA CONTRA O CATALOGO, nunca `ilike` nem "parecido": o
      // valor gravado passa a ser o texto da opcao COMO O ADMIN CADASTROU, entao
      // "a vista" digitado por um atendente e "A Vista" digitado por outro viram
      // a mesma linha no relatorio.
      const alvo = chaveDeCampo(cru);
      const achou = campo.opcoes.find((o) => chaveDeCampo(o) === alvo);
      if (!achou) {
        return { ok: false, erro: `"${cru}" nao e uma das opcoes de "${campo.nome}" (${campo.opcoes.join(", ")})` };
      }
      return { ok: true, valor: achou };
    }
  }
}

export type LeituraValor = {
  /** o texto COMO ESTA GRAVADO — e o que a tela mostra */
  texto: string;
  /** a forma canonica, quando o valor gravado casa com o tipo */
  canonico: string | null;
  /** valor gravado que nao casa com o tipo do campo */
  fora_do_formato: boolean;
  motivo?: string;
};

/**
 * Leitura TOLERANTE de um valor gravado.
 *
 * A regra que manda: **nunca reescrever, nunca esconder.** O acervo de valores e
 * anterior aos tipos (o sync grava texto livre desde sempre), entao o campo que
 * alguem tipa como `numero` hoje pode ter "a combinar" gravado em mil conversas.
 * Devolver vazio esconderia o dado; corrigir inventaria um numero. A leitura
 * devolve o texto original, marca `fora_do_formato` e diz o motivo — quem ve isso
 * na tela conserta com contexto, que e a unica forma correta de consertar.
 *
 * E o TETO NAO REPROVA NA LEITURA: o sync grava ate 5000 chars, e chamar de
 * "fora do formato" um valor que a operacao gravou por um caminho legitimo seria
 * mentira sobre o dado dela.
 */
export function lerValor(campo: CampoFicha, gravado: unknown): LeituraValor | null {
  let texto: string;
  if (typeof gravado === "string") texto = gravado;
  else if (typeof gravado === "number" || typeof gravado === "boolean") texto = String(gravado);
  else return null; // objeto/lista/nulo no jsonb: nao ha valor legivel
  if (!texto.trim()) return null;
  if (campo.tipo === "texto") return { texto, canonico: texto.trim(), fora_do_formato: false };
  const r =
    campo.tipo === "numero"
      ? numeroCanonico(texto)
      : campo.tipo === "data"
        ? dataCanonica(texto)
        : campo.tipo === "sim_nao"
          ? simNaoCanonico(texto)
          : opcaoCanonica(campo, texto);
  if (r.ok) return { texto, canonico: r.valor, fora_do_formato: false };
  return { texto, canonico: null, fora_do_formato: true, motivo: r.erro };
}

function opcaoCanonica(campo: CampoFicha, texto: string): { ok: true; valor: string } | { ok: false; erro: string } {
  const alvo = chaveDeCampo(texto);
  const achou = campo.opcoes.find((o) => chaveDeCampo(o) === alvo);
  return achou
    ? { ok: true, valor: achou }
    : { ok: false, erro: `valor gravado nao esta mais entre as opcoes de "${campo.nome}"` };
}

// ──────────────────────────────────────────── o patch de valores da ficha

export type PatchValores = {
  /**
   * A ficha INTEIRA depois do patch, pronta pra gravar no jsonb.
   *
   * `unknown` no valor, e nao `string`, porque a chave que o patch NAO toca sai
   * daqui como entrou — inclusive objeto e lista (ver o laco de copia abaixo).
   * Tipar como `string` obrigava a descartar o que nao cabia, que era exatamente
   * o apagamento silencioso.
   */
  ficha: Record<string, unknown>;
  aplicados: { campo: string; valor: string | null }[];
  recusados: { campo: string; motivo: string }[];
};

/**
 * A DECISAO UNICA de escrita de valor da ficha — e a razao de ela morar aqui e
 * nao numa rota: existem DUAS portas (`/api/campos/valores`, a tipada, e
 * `/api/ficha` PATCH, a que a tela de conversa ja usa e que o MCP chama pela tool
 * `atualizar_ficha`). Duas portas com regras proprias divergiriam na primeira
 * mudanca; duas portas chamando a MESMA decisao nao.
 *
 * TUDO OU NADA. Qualquer recusa e 422 com a lista, e nada e gravado — o padrao de
 * `validarFluxo` ("Invalido = 422 com os erros e NADA gravado"). Gravar a parte
 * boa e responder 200 faria o atendente sair achando que a ficha inteira entrou.
 *
 * O QUE `obrigatorio` DE FATO IMPEDE: esvaziar um campo obrigatorio que JA tem
 * valor. Nao ha gate de "preencha antes de concluir" — isso seria politica de
 * produto que ninguem decidiu, e travaria a operacao em 12 mil conversas
 * importadas sem valor. O efeito e assimetrico de proposito, e e o unico que o
 * dado sustenta.
 */
export function aplicarPatchDeValores(
  catalogo: readonly CampoFicha[],
  fichaAtual: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>
): PatchValores {
  const ativos = catalogo.filter((c) => c.ativo);
  // COPIA QUE NAO PERDE NADA. A versao anterior reconstruia o objeto aceitando so
  // `string | number | boolean`, entao chave com OBJETO ou LISTA no jsonb
  // (gravada por fora, ou por uma versao futura do produto) sumia no primeiro
  // PATCH — sem entrar em `recusados`, sem ninguem ver, dentro da funcao que
  // existe justamente pra impedir apagamento silencioso.
  //
  // Numero e booleano seguem virando TEXTO, e isso e outra coisa: e a forma
  // canonica que a ficha usa em todo lugar (a condicao compara texto, e `1` e
  // `"1"` nunca casariam), e a conversao nao perde informacao. Objeto e lista nao
  // tem forma canonica de texto — entao ficam como estao.
  const ficha: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fichaAtual || {})) {
    if (typeof v === "number" || typeof v === "boolean") ficha[k] = String(v);
    else ficha[k] = v;
  }
  const aplicados: PatchValores["aplicados"] = [];
  const recusados: PatchValores["recusados"] = [];

  for (const [pedido, bruto] of Object.entries(patch)) {
    const achado = acharCampo(ativos, pedido);
    if ("erro" in achado) {
      recusados.push({
        campo: String(pedido).slice(0, LIMITE_NOME_CAMPO),
        motivo:
          achado.erro === "ambiguo"
            ? "ha mais de um campo com esse nome (diferindo so por caixa/acento) — use o nome exato"
            : "nao existe um campo ativo com esse nome na ficha desta instalacao",
      });
      continue;
    }
    const campo = achado.campo;
    const r = valorParaGravar(campo, bruto);
    if (!r.ok) {
      recusados.push({ campo: campo.nome, motivo: r.erro });
      continue;
    }
    if (r.valor === null) {
      const gravado = ficha[campo.nome];
      const tinha = typeof gravado === "string" && gravado.trim() !== "";
      if (campo.obrigatorio && tinha) {
        recusados.push({ campo: campo.nome, motivo: `"${campo.nome}" e obrigatorio e ja tem valor — nao da pra esvaziar` });
        continue;
      }
      delete ficha[campo.nome];
      aplicados.push({ campo: campo.nome, valor: null });
      continue;
    }
    ficha[campo.nome] = r.valor;
    aplicados.push({ campo: campo.nome, valor: r.valor });
  }

  return { ficha, aplicados, recusados };
}

/** Campos obrigatorios ATIVOS sem valor nesta conversa. */
export function pendenciasObrigatorias(
  catalogo: readonly CampoFicha[],
  ficha: Record<string, unknown> | null | undefined
): string[] {
  const f = ficha || {};
  return catalogo
    .filter((c) => c.ativo && c.obrigatorio)
    .filter((c) => !temValor(f[c.nome]))
    .map((c) => c.nome);
}

/**
 * "Tem valor?" num lugar so.
 *
 * `false` e `0` CONTAM COMO VALOR, e isso e o ponto: num campo `sim_nao` a
 * resposta "nao" e uma resposta, e num campo `numero` zero e um numero. Uma
 * conferencia por veracidade (`if (v)`) trataria as duas como "nao preenchido" e
 * a ficha ficaria cobrando pendencia de campo que a pessoa respondeu.
 */
function temValor(v: unknown): boolean {
  if (typeof v === "string") return v.trim() !== "";
  return typeof v === "number" || typeof v === "boolean";
}

/**
 * Valores gravados que NENHUM campo ativo alcanca.
 *
 * Esta funcao existe por causa de um defeito que ja estava em producao: a tela da
 * conversa desenha a ficha iterando o CATALOGO ativo, entao valor cuja chave saiu
 * do catalogo (campo arquivado, campo renomeado pela rota antiga, chave que o
 * sync trouxe e ninguem cadastrou) fica no banco e desaparece da tela. Ninguem
 * apagou nada — e ninguem consegue mais ver.
 *
 * O construtor mostra isso como "valores sem campo", com a chave e o conteudo.
 */
export function valoresOrfaos(
  catalogo: readonly CampoFicha[],
  ficha: Record<string, unknown> | null | undefined
): { chave: string; valor: string }[] {
  const ativos = catalogo.filter((c) => c.ativo);
  const saida: { chave: string; valor: string }[] = [];
  for (const [k, v] of Object.entries(ficha || {})) {
    const texto = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
    if (!texto.trim()) continue;
    if (ativos.some((c) => c.nome === k)) continue;
    saida.push({ chave: k, valor: texto });
  }
  return saida;
}

// ────────────────────────────────────────────── ordem, remocao, renome

/**
 * Reordenacao: a lista de nomes na ordem desejada vira `ordem` 1..N.
 *
 * EXIGE A LISTA COMPLETA dos campos ativos. Aceitar lista parcial faria os que
 * ficaram de fora manterem uma `ordem` antiga que colide com as novas — e ordem
 * empatada e ordem que o banco resolve como quiser, ou seja a ficha embaralha
 * sozinha entre dois carregamentos. Faltando ou sobrando nome, recusa dizendo
 * qual.
 */
export function planoDeOrdem(
  catalogo: readonly CampoFicha[],
  ordemPedida: unknown
): { ok: true; ordens: { id: string; ordem: number }[] } | { ok: false; erro: string } {
  if (!Array.isArray(ordemPedida)) return { ok: false, erro: "ordem precisa ser a lista de nomes dos campos" };
  const ativos = catalogo.filter((c) => c.ativo);
  const pedidos: CampoFicha[] = [];
  const vistos = new Set<string>();
  for (const p of ordemPedida) {
    const achado = acharCampo(ativos, p);
    if ("erro" in achado) return { ok: false, erro: `"${String(p).slice(0, 80)}" nao e um campo ativo desta ficha` };
    if (vistos.has(achado.campo.id)) return { ok: false, erro: `"${achado.campo.nome}" aparece duas vezes na ordem` };
    vistos.add(achado.campo.id);
    pedidos.push(achado.campo);
  }
  const faltando = ativos.filter((c) => !vistos.has(c.id)).map((c) => c.nome);
  if (faltando.length) {
    return { ok: false, erro: `a ordem precisa listar TODOS os campos ativos — faltou: ${faltando.join(", ")}` };
  }
  return { ok: true, ordens: pedidos.map((c, i) => ({ id: c.id, ordem: i + 1 })) };
}

export type ImpactoCampo = {
  /** contagem por canal; `null` = nao deu pra contar naquele canal */
  por_canal: { canal: string; conversas: number | null }[];
  /** soma das contagens que deram certo */
  conversas: number;
  /** algum canal nao respondeu a contagem */
  incompleto: boolean;
};

export type VereditoRemocao =
  | { acao: "remover"; motivo: string }
  | { acao: "arquivar"; motivo: string }
  | { acao: "recusar"; motivo: string };

/**
 * O veredito da REMOCAO, dado o impacto medido. Puro de proposito — a parte
 * perigosa desta feature e decidir o que fazer com o historico, e decisao que
 * mora dentro da funcao que fala com banco e decisao que nenhuma prova alcanca
 * (licao paga em `lib/exportacao.ts` no micro-check de 31/08).
 *
 * As tres saidas, e o que cada uma protege:
 *
 *  - **remover** so quando o impacto e ZERO E foi medido em TODOS os canais.
 *    Campo sem valor nenhum e cadastro errado, e apagar cadastro errado nao
 *    perde nada.
 *  - **arquivar** e o que o painel oferece quando ha valor: o campo sai do
 *    formulario e os valores FICAM — e, diferente de hoje, ficam VISIVEIS (o
 *    construtor e a ficha mostram "valores sem campo"). Hoje desativar um campo
 *    e exatamente a perda silenciosa que o card manda evitar: o valor continua no
 *    banco e a tela para de desenha-lo.
 *  - **recusar** quando a contagem nao fechou em algum canal. Contagem que falhou
 *    NAO e contagem zero — freio que falha aberto nao e freio, e o que se perde
 *    aqui e historico de cliente.
 */
export function vereditoDaRemocao(impacto: ImpactoCampo): VereditoRemocao {
  if (impacto.incompleto) {
    return {
      acao: "recusar",
      motivo:
        "nao deu pra contar quantas conversas tem valor neste campo em todos os canais — sem essa contagem, remover seria apagar historico no escuro",
    };
  }
  if (impacto.conversas > 0) {
    return {
      acao: "arquivar",
      motivo: `${impacto.conversas} conversa(s) tem valor gravado neste campo. Remover o campo do catalogo deixaria esses valores sem dono; arquivar tira o campo do formulario e mantem os valores visiveis na ficha como "valores sem campo".`,
    };
  }
  return { acao: "remover", motivo: "nenhuma conversa tem valor gravado neste campo" };
}

export type PlanoRenome =
  | { ok: true; migrar: boolean; motivo: string }
  | { ok: false; motivo: string };

/**
 * O plano do RENOME, e ele fecha um defeito que existia em producao.
 *
 * O DEFEITO (tempo passado, fechado NESTA frente): `/api/admin/ficha-config`
 * aceitava `{tipo:"campo", id, nome}` e fazia UPDATE em
 * `campos_personalizados.nome`. Os valores continuavam gravados sob o nome ANTIGO
 * em `conversas.ficha`, e a tela da conversa desenha a ficha iterando o CATALOGO:
 * depois do rename, o valor de todo mundo ficava no banco e INVISIVEL, e a rota
 * de escrita passava a ignorar aquela chave. Um botao de renomear escondendo dado
 * do cliente, sem uma linha de aviso. Hoje aquela rota RECUSA com 409 e aponta pra
 * ca (`decidirPatchDeCatalogo`).
 *
 * Aqui: renome COM valores exige a funcao `mensageria.renomear_campo_ficha`
 * (0025), que move a chave do jsonb em uma instrucao por canal. Sem a migration,
 * RECUSA — e a recusa e a resposta certa, porque a alternativa seria repetir
 * aquela perda silenciosa, agora pelo caminho novo. Sem valores, renome e so
 * trocar o rotulo.
 */
export function planoDeRenome(impacto: ImpactoCampo, renomeDisponivel: boolean): PlanoRenome {
  if (impacto.incompleto) {
    return {
      ok: false,
      motivo:
        "nao deu pra contar os valores gravados neste campo em todos os canais — renomear sem saber disso deixaria valor orfao sem ninguem ver",
    };
  }
  if (impacto.conversas === 0) return { ok: true, migrar: false, motivo: "campo sem valor gravado: renomear e so trocar o rotulo" };
  if (!renomeDisponivel) {
    return {
      ok: false,
      motivo: `${impacto.conversas} conversa(s) tem valor neste campo e a migration 0025 (que move o valor pro nome novo) nao rodou nesta instalacao. Renomear agora esconderia esses valores — rode a 0025 ou arquive o campo e crie outro`,
    };
  }
  return {
    ok: true,
    migrar: true,
    motivo: `${impacto.conversas} conversa(s) tem valor neste campo e ele sera movido pro nome novo`,
  };
}

// ──────────────────────────────── as duas travessias de canal, com EXECUTOR

/**
 * MEDIR o impacto de mexer num campo, canal por canal.
 *
 * O executor (`contar`) e injetado de proposito, e a razao e um preco que este
 * repo ja pagou: enquanto a decisao morava dentro da funcao que fala com o banco,
 * a unica prova possivel era varredura de texto — e varredura de texto protege a
 * CHAMADA, nao o CORPO. Um `?? 0` acrescentado no lugar do `null` desligaria o
 * freio inteiro da remocao com a bateria verde (micro-check de 31/08/2026 em
 * `lib/exportacao.ts`). Aqui a travessia roda de verdade na prova, com um fake no
 * lugar do banco, e o que se confere e o DESFECHO.
 *
 * AS TRES REGRAS QUE ELA GUARDA:
 *  1. canal que nao respondeu vira `null`, NUNCA zero — `incompleto` e o que faz
 *     `vereditoDaRemocao` recusar, e contagem que falhou nao e contagem zero;
 *  2. excecao do executor (rede caiu, cliente mal configurado) e "nao deu pra
 *     contar", nao 500 e nao zero;
 *  3. LISTA DE CANAL VAZIA e INCOMPLETA, nao "zero valor gravado". Zero canal
 *     significa que nada foi medido — e nada medido virando "pode remover" e o
 *     freio que falha aberto. (Acontece de verdade: `listarCanais()` devolve o que
 *     a configuracao tem, e a varredura ainda descarta as fontes externas.)
 */
export type ContagemDeCanal = (canal: string) => Promise<number | null>;

export async function medirImpacto(canais: readonly string[], contar: ContagemDeCanal): Promise<ImpactoCampo> {
  // ID REPETIDO CONTA UMA VEZ: canal duplicado na configuracao dobraria o numero
  // que a tela mostra antes de remover, e numero inflado tambem e numero errado.
  const lista = [...new Set(canais.filter((c) => typeof c === "string" && c.trim()))];
  if (!lista.length) {
    return {
      por_canal: [],
      conversas: 0,
      incompleto: true,
    };
  }
  const por_canal: ImpactoCampo["por_canal"] = [];
  await Promise.all(
    lista.map(async (canal) => {
      let bruto: number | null;
      try {
        bruto = await contar(canal);
      } catch {
        bruto = null;
      }
      const n = Number(bruto);
      por_canal.push({
        canal,
        conversas: bruto === null || bruto === undefined || !Number.isFinite(n) ? null : Math.max(0, Math.round(n)),
      });
    })
  );
  // ordem estavel: a tela lista canal por canal, e lista que troca de ordem entre
  // dois cliques parece dado mudando
  por_canal.sort((a, b) => a.canal.localeCompare(b.canal));
  return {
    por_canal,
    conversas: por_canal.reduce((s, p) => s + (p.conversas ?? 0), 0),
    incompleto: por_canal.some((p) => p.conversas === null),
  };
}

export type RespostaMigracao = {
  ok?: unknown;
  motivo?: unknown;
  renomeadas?: unknown;
  conflitos?: unknown;
} | null | undefined;

export type MigracaoDeCanal = (canal: string) => Promise<RespostaMigracao>;

export type ResultadoRenome = { ok: true; renomeadas: number; conflitos: number } | { ok: false; motivo: string };

/**
 * MIGRAR o valor de um campo renomeado, canal por canal — a travessia mais
 * perigosa desta frente, e por isso ela tambem roda na prova com executor
 * injetado.
 *
 * SEQUENCIAL, e para no PRIMEIRO canal que falhar. Em paralelo, uma falha no
 * canal B com o canal C ja migrado deixaria o acervo partido em dois nomes sem
 * ninguem saber quantos. Parar no primeiro limita o estrago ao que ja passou, e a
 * resposta diz QUAL canal falhou.
 *
 * FALHA E `ok:false` COM MOTIVO, e quem chama NAO troca o nome no catalogo. Sem
 * isso, o campo passaria a se chamar X enquanto metade dos valores continuaria em
 * Y — invisivel na tela, que desenha a ficha pelo catalogo. Nao existe caminho
 * "migrou parcial e renomeou": entre um acervo partido com o nome novo e um
 * acervo inteiro com o nome antigo, o segundo e o unico que alguem consegue
 * consertar depois.
 *
 * RESPOSTA TORTA DO BANCO (sem `ok`, nulo, numero em texto) e FALHA, nao sucesso
 * com zero: `renomeadas: 0` mentiria dizendo que nao havia nada pra mover.
 */
export async function migrarRenome(canais: readonly string[], mover: MigracaoDeCanal): Promise<ResultadoRenome> {
  const lista = [...new Set(canais.filter((c) => typeof c === "string" && c.trim()))];
  if (!lista.length) {
    return { ok: false, motivo: "nenhum canal pra migrar o valor do campo — o nome NAO foi trocado" };
  }
  let renomeadas = 0;
  let conflitos = 0;
  for (const canal of lista) {
    let r: RespostaMigracao;
    try {
      r = await mover(canal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, motivo: `o canal ${canal} nao migrou os valores (${msg}) — o nome do campo NAO foi trocado` };
    }
    if (!r || r.ok !== true) {
      const motivo = typeof r?.motivo === "string" && r.motivo.trim() ? r.motivo.trim() : "motivo nao informado";
      return { ok: false, motivo: `o canal ${canal} nao migrou os valores (${motivo}) — o nome do campo NAO foi trocado` };
    }
    renomeadas += inteiroNaoNegativo(r.renomeadas);
    conflitos += inteiroNaoNegativo(r.conflitos);
  }
  return { ok: true, renomeadas, conflitos };
}

/** Contagem devolvida pelo banco. Torta vira 0 no SOMATORIO (nunca NaN na tela). */
function inteiroNaoNegativo(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// ────────────────────────────────────────────────────── saneamento do banco

/**
 * Linha do banco -> `CampoFicha`. Coluna ausente (0025 pendente) cai no default
 * que reproduz o comportamento de hoje: `texto`, nao obrigatorio, sem opcoes.
 *
 * Chave desconhecida no jsonb de opcoes e ignorada em silencio de proposito
 * (mesmo espirito de `lib/modulos.ts`): instalacao antiga nao quebra quando o
 * formato crescer.
 */
export function campoDaLinha(linha: Record<string, unknown>): CampoFicha | null {
  const nome = nomeDeCampo(linha.nome);
  const id = typeof linha.id === "string" ? linha.id : "";
  if (!nome || !id) return null;
  const tipoBruto = linha.tipo;
  const declarado = (TIPOS_CAMPO as readonly unknown[]).includes(tipoBruto) ? (tipoBruto as TipoCampo) : "texto";
  const op = validarOpcoes(Array.isArray(linha.opcoes) ? linha.opcoes : []);
  const opcoes = op.ok ? op.opcoes : [];
  // TIPO DE LISTA SEM OPCAO LEGIVEL VOLTA A SER TEXTO na leitura, e isso e
  // fail-safe, nao conserto de dado: um select vazio nao aceita valor nenhum,
  // entao a ficha ficaria com um campo impossivel de preencher — e a linha do
  // banco continua dizendo `lista`, pra quem for consertar o cadastro achar. Como
  // texto, o campo segue servindo enquanto ninguem conserta. (Acontece de verdade:
  // o jsonb pode ter chegado com `{}` ou com opcao duplicada por um caminho de
  // fora da rota.)
  const tipo: TipoCampo = declarado === "lista" && !opcoes.length ? "texto" : declarado;
  return {
    id,
    nome,
    tipo,
    obrigatorio: linha.obrigatorio === true,
    opcoes: tipo === "lista" ? opcoes : [],
    descricao: typeof linha.descricao === "string" && linha.descricao.trim() ? linha.descricao.trim() : null,
    ordem: Number.isFinite(Number(linha.ordem)) ? Math.round(Number(linha.ordem)) : 999,
    ativo: linha.ativo !== false,
  };
}

/**
 * Colisoes de nome que JA existem no catalogo (diferindo so por caixa/acento).
 *
 * Nao viram unique no banco de proposito: `add constraint` valida as linhas
 * existentes, e o sync cria campo com o rotulo da tela de origem — a migration
 * abortaria na primeira instalacao que tem as duas variantes, e migration que
 * morre no meio deixa a instalacao pior do que estava (licao da 0019). Entao a
 * colisao antiga e PENDENCIA declarada na tela, e a colisao NOVA e recusada pela
 * rota.
 */
export function colisoesDeNome(catalogo: readonly CampoFicha[]): { chave: string; nomes: string[] }[] {
  const porChave = new Map<string, string[]>();
  for (const c of catalogo) {
    const k = chaveDeCampo(c.nome);
    if (!k) continue;
    porChave.set(k, [...(porChave.get(k) ?? []), c.nome]);
  }
  return [...porChave.entries()].filter(([, nomes]) => nomes.length > 1).map(([chave, nomes]) => ({ chave, nomes }));
}

// ───────────────────── os HANDLERS viram FUNCAO, com os EFEITOS injetados

/**
 * POR QUE ESTA SECAO EXISTE (3a rodada da re-revisao cega, 31/08/2026).
 *
 * As decisoes acima ja eram puras e provadas por desfecho — e a re-revisao
 * REPROVOU de novo, porque o pecado tinha migrado da DECISAO pra COSTURA: cinco
 * mutacoes no CORPO DOS HANDLERS reabriam defeito de producao com a bateria
 * inteira verde. A causa e sempre a mesma que ja custou duas rodadas aqui —
 * handler importa `next/server`, entao a unica prova possivel era varredura, e
 * **varredura pega a REMOCAO da linha, nunca o DESLIGAMENTO dela**:
 *
 *   - `if (passo === "previa" && false)` — arquiva sem previa, e o numero do
 *     impacto chega quando ja nao da pra decidir com ele. O literal `previa: true`
 *     continua no corpo (dentro do `if` morto), entao a guarda de ordem nao ve.
 *   - um `update({ativo:false})` inserido ANTES de `decidirPatchDeCatalogo` —
 *     a perda silenciosa que a frente existe pra fechar volta inteira, e a guarda
 *     de status nao morde porque o handler nao RECUSA: ele APLICA.
 *   - `if (!vcol.ok && false)` — colisao normalizada volta a ser criada, e a
 *     partir dai `acharCampo` fica ambiguo e toda escrita naquele campo e recusada
 *     na conta inteira.
 *   - `linha.nome = String(nome).trim()` DEPOIS de `linha.nome = vn.nome` — o
 *     nome saneado e sobrescrito pelo cru. A guarda exigia a linha certa, nao que
 *     ela fosse a ULTIMA.
 *
 * O conserto e o mesmo gesto que ja tinha precedente nesta rota (`decidirPorta`),
 * levado um passo adiante: **o corpo do handler vira uma funcao daqui que recebe
 * os EFEITOS (medir, gravar, ler, inserir) e devolve a RESPOSTA** — status e
 * corpo. A prova chama a funcao com fakes no lugar do banco e confere o DESFECHO:
 * o que foi gravado, com que patch, em que ordem, e — o que mais importa — **o que
 * NAO foi gravado**. O handler fica sendo tres linhas de adaptacao pro
 * `NextResponse`, e a assercao de texto sobre ele vira cinto redundante, nao o
 * unico portao.
 */
export type RespostaDeRota = { status: number; corpo: Record<string, unknown> };

export type GravacaoDeCampo = { ok: true } | { ok: false; motivo: string; status: number };

/**
 * OS EFEITOS DO ARQUIVAMENTO — e por que o efeito e a CONTAGEM DE UM CANAL, e nao
 * o impacto pronto.
 *
 * A versao anterior recebia `medirImpacto: (nome) => Promise<ImpactoCampo>`, ou
 * seja, o adaptador entregava o veredito numerico ja montado. Medido na 4a rodada
 * da re-revisao cega (01/09/2026): um adaptador "tolerante"
 * (`{...await impactoDoCampo(nome), conversas: 0, por_canal: []}`) fazia a previa
 * dizer "0 conversas afetadas" e o dono arquivar achando que nao perdia nada — com
 * a bateria inteira verde, porque adaptador mora em arquivo de rota e rota nenhuma
 * prova importa.
 *
 * Agora o efeito e o MENOR pedaco que precisa de banco (contar UM canal) e quem
 * monta `conversas`/`incompleto` e o `medirImpacto` PURO, que a prova executa. A
 * forma `{conversas: 0, por_canal: []}` deixou de ser representavel por um efeito:
 * `conversas` e a SOMA de `por_canal`, e canal que nao respondeu vira `incompleto`,
 * que RECUSA. Mentir agora exige mentir canal por canal — que e outra coisa, e esta
 * declarada na secao de modelo de ameaca do CLAUDE.md.
 */
export type EfeitosDeArquivamento = {
  /** os canais varridos (ids). Lista vazia = nada medido = fail-closed em `medirImpacto` */
  canais: readonly string[];
  /** conta, num canal so, quantas conversas tem valor gravado neste campo. `null` = nao sei */
  contar: (canal: string, nome: string) => Promise<number | null>;
  /** UPDATE por id em `campos_personalizados` */
  gravar: (id: string, patch: Record<string, unknown>) => Promise<GravacaoDeCampo>;
  /** o carimbo de `atualizado_em` (injetado pra prova nao depender do relogio) */
  agora: () => string;
};

/**
 * ARQUIVAR/REATIVAR CAMPO — o corpo do handler, com os efeitos injetados.
 *
 * Arquivar tira o campo do formulario da CONTA INTEIRA, entao ele e em DOIS
 * PASSOS igual ao remover: sem `confirmar: true` a resposta e PREVIA e **nao muda
 * nada**. REATIVAR nao tem previa (ele nao esconde nada de ninguem) e por isso
 * tambem nao gasta a medicao.
 *
 * A medicao acontece nos DOIS ramos que mexem em campo ativo: a previa existe pra
 * MOSTRAR o numero, e o arquivamento devolve o MESMO numero pra tela poder dizer
 * quantas conversas ficaram com "valores sem campo". O valor nunca e apagado — ele
 * continua na conversa e passa a aparecer como `valoresOrfaos`.
 */
export async function executarArquivamento(
  campo: { id: string; nome: string },
  arquivando: boolean,
  confirmar: unknown,
  ef: EfeitosDeArquivamento
): Promise<RespostaDeRota> {
  const passo = decidirArquivamento(arquivando, confirmar);
  if (passo === "reativar") {
    const r = await ef.gravar(campo.id, { ativo: true, atualizado_em: ef.agora() });
    if (!r.ok) return { status: r.status, corpo: { error: r.motivo } };
    return { status: 200, corpo: { ok: true, impacto: null } };
  }
  const impacto = await medirImpacto(ef.canais, (canal) => ef.contar(canal, campo.nome));
  if (passo === "previa") {
    return {
      status: 200,
      corpo: { previa: true, campo: campo.nome, impacto, veredito: vereditoDaRemocao(impacto) },
    };
  }
  const r = await ef.gravar(campo.id, { ativo: false, atualizado_em: ef.agora() });
  if (!r.ok) return { status: r.status, corpo: { error: r.motivo } };
  return { status: 200, corpo: { ok: true, impacto } };
}

export type EfeitosDeFichaConfig = {
  /** UPDATE por id na tabela do catalogo (`campos_personalizados` | `etiquetas_catalogo`) */
  atualizar: (
    tabela: string,
    id: string,
    patch: Record<string, unknown>
  ) => Promise<{ ok: true } | { ok: false; motivo: string }>;
  /** os nomes ja cadastrados em `campos_personalizados`, com o ERRO da leitura junto */
  lerNomes: () => Promise<{ data: unknown; erro: unknown }>;
  /** a `ordem` do proximo campo */
  proximaOrdem: () => Promise<number>;
  /** UPSERT da linha nova */
  inserir: (
    tabela: string,
    linha: Record<string, unknown>
  ) => Promise<{ ok: true; item: unknown } | { ok: false; motivo: string }>;
};

/**
 * A ROTA ANTIGA DE CATALOGO (`/api/admin/ficha-config`) — o corpo do handler,
 * com os efeitos injetados.
 *
 * Ela e a tela velha (aba "Ficha" das configuracoes): faz UPDATE direto e nao
 * varre canal nenhum. As quatro regras que ela guarda ja eram decisoes puras
 * (`decidirPatchDeCatalogo`, `decidirNomeDeCampoNovo`, `decidirColisaoNoCatalogo`);
 * o que faltava era provar que a rota **as OBEDECE** — que nada e escrito quando
 * elas recusam, e que o que e escrito e o SANEADO.
 *
 * A ORDEM importa e e observavel: nenhum efeito acontece antes do veredito, e o
 * nome que chega em `inserir` e o de `decidirNomeDeCampoNovo`, montado numa SO
 * expressao (nao ha `linha.nome` mutavel pra uma segunda atribuicao sequestrar).
 */
export async function executarFichaConfig(
  pedido: { tipo?: unknown; id?: unknown; nome?: unknown; ativo?: unknown },
  ef: EfeitosDeFichaConfig
): Promise<RespostaDeRota> {
  const { tipo, id, nome, ativo } = pedido;
  if (tipo !== "campo" && tipo !== "etiqueta") {
    return { status: 400, corpo: { error: "tipo invalido (campo|etiqueta)" } };
  }
  const tabela = tipo === "campo" ? "campos_personalizados" : "etiquetas_catalogo";

  if (id) {
    const patch: Record<string, unknown> = {};
    if (typeof nome === "string" && nome.trim()) patch.nome = nome.trim().slice(0, LIMITE_NOME_CAMPO);
    if (ativo !== undefined) patch.ativo = !!ativo;
    const vc = decidirPatchDeCatalogo(tipo, patch);
    if (!vc.ok) return { status: vc.status, corpo: { error: vc.erro } };
    if (!Object.keys(patch).length) return { status: 400, corpo: { error: "nada pra alterar" } };
    const r = await ef.atualizar(tabela, String(id), patch);
    if (!r.ok) return { status: 500, corpo: { error: r.motivo } };
    return { status: 200, corpo: { ok: true } };
  }

  if (typeof nome !== "string" || !nome.trim()) {
    return { status: 400, corpo: { error: "nome obrigatorio" } };
  }

  if (tipo === "campo") {
    const vn = decidirNomeDeCampoNovo(nome);
    if (!vn.ok) return { status: vn.status, corpo: { error: vn.erro } };
    const { data, erro } = await ef.lerNomes();
    const vcol = decidirColisaoNoCatalogo(data, erro, vn.nome);
    if (!vcol.ok) return { status: vcol.status, corpo: { error: vcol.erro } };
    const ordem = await ef.proximaOrdem();
    const novo = await ef.inserir(tabela, { nome: vn.nome, ativo: true, ordem });
    if (!novo.ok) return { status: 500, corpo: { error: novo.motivo } };
    return { status: 200, corpo: { ok: true, item: novo.item } };
  }

  const novo = await ef.inserir(tabela, { nome: nome.trim().slice(0, LIMITE_NOME_CAMPO), ativo: true });
  if (!novo.ok) return { status: 500, corpo: { error: novo.motivo } };
  return { status: 200, corpo: { ok: true, item: novo.item } };
}
