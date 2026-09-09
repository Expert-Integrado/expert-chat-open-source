// Tela de conversa — as REGRAS PURAS do kit de acoes e dos historicos.
//
// Cards 86ak85nyv (kit de acoes), 86ak85nx0 (historicos de status/NPS/midia) e
// 86ak85nwu (historico de transferencia).
//
// PURO de proposito: este arquivo NAO IMPORTA NADA. Roda no Next e em node
// solto — e o que `scripts/prova-tela-conversa.ts` exercita, sem rede, sem banco
// e sem navegador. Mesma disciplina de lib/funis.ts, lib/kanban.ts e
// lib/fluxo/schema.ts: a decisao mora aqui, a fiacao mora na rota, o desenho
// mora em app/home.tsx.
//
// FRONTEIRA DE CONFIANCA: tudo que passa por aqui — texto de mensagem, nome de
// contato, nome de arquivo, termo de busca digitado — e CONTEUDO DE TERCEIRO.
// E dado a comparar e a recortar, nunca instrucao. Nenhuma funcao daqui produz
// HTML, monta URL de destino ou decide permissao.

// ===========================================================================
// 1. Encaminhar mensagem
// ===========================================================================

/**
 * Teto de destinos por encaminhamento. Mesmo numero do WhatsApp, e a razao e
 * essa: encaminhar e GESTO DE CONVERSA, nao ferramenta de disparo. Quem precisa
 * falar com 200 pessoas usa o modulo de disparo, que tem opt-out, ritmo e
 * trilha de campanha.
 *
 * POR QUE CONSTANTE E NAO CHAVE DE CONFIG (decisao, 31/08/2026): o card
 * perguntava se o teto devia sair da config. Nao. Config aqui viraria a porta
 * de fuga do modulo de disparo — bastaria subir o numero pra transformar o
 * botao de encaminhar em disparo sem opt-out. O que ERA problema de verdade e
 * que o 5 estava escrito em TRES lugares (a rota e duas vezes a tela), e isso
 * some com esta constante: fonte unica, os tres leem daqui.
 */
export const MAX_DESTINOS_FORWARD = 5;

// ===========================================================================
// 2. Busca DENTRO da conversa
// ===========================================================================

/**
 * Minimo de letras da busca dentro da conversa.
 *
 * DOIS, e nao os TRES de /api/busca. A diferenca nao e capricho: a busca global
 * varre a tabela de mensagens INTEIRA com ilike, e ali 2 letras devolveriam
 * meio banco. A busca escopada varre UMA conversa (o indice
 * (chat_id, criada_em) da 0001 faz o corte), entao procurar "ok", "nf" ou um
 * numero de dois digitos e barato e e exatamente o que a pessoa quer fazer.
 */
export const MIN_TERMO_BUSCA = 2;

/** Teto de resultados devolvidos por busca escopada. */
export const MAX_RESULTADOS_BUSCA = 200;

/**
 * Escapa os CORINGAS do ilike no termo digitado.
 *
 * GOTCHA QUE JA CUSTOU CARO (memoria da casa, e /api/busca ja fazia dois dos
 * tres): `%` e `_` sao coringas do LIKE. Sem escape, quem digita "10%" recebe
 * qualquer mensagem que tenha "10" seguido de qualquer coisa, e quem digita
 * "a_b" casa "aXb". O usuario nao sabe que digitou uma expressao — ele acha que
 * a busca esta quebrada. A barra invertida tambem escapa, senao o proprio
 * escape vira dado.
 *
 * O `*` NAO ENTRA AQUI, e isso e uma correcao de correcao (re-revisao,
 * 31/08/2026). Ele E um coringa, mas do POSTGREST, nao do Postgres: no filtro
 * `ilike` da API o PostgREST troca `*` por `%` ANTES de mandar pro banco, e
 * troca cegamente — inclusive depois de uma barra invertida. Escapar como `\*`
 * (a "correcao" anterior) viajava como `\%`, que em LIKE e PERCENT LITERAL:
 * buscar `*urgente*` ou a assinatura `*Nome:*` passou a devolver ZERO
 * resultados, quando antes devolvia um superset. Trocamos um resultado largo
 * por resultado nenhum — regressao pior que o defeito.
 *
 * O `*` e tratado em `padraoParaIlike`, que NAO tenta escapar: manda pro banco
 * um pedaco do termo livre de `*` (superset) e deixa o filtro literal pro
 * JavaScript.
 */
export function escaparIlike(termo: string): string {
  return String(termo).replace(/[\\%_]/g, "\\$&");
}

export type PadraoBusca =
  | {
      ok: true;
      /** o que vai no `.ilike()` do banco (ja escapado, SEM `*`) */
      /**
       * UM pattern por pedaco do termo livre de `*`, do maior pro menor. Quem
       * consulta encadeia um `.ilike()` por pattern: o PostgREST junta filtros
       * repetidos com AND, e cada pedaco extra APERTA o superset que volta do
       * banco (buscar `*Nome:*` exige "Nome:" e nada mais; `a*b*c` exige os tres).
       * Nunca vazio: `ok:true` garante pelo menos um.
       */
      patterns: string[];
      /**
       * true = os patterns sao mais LARGOS que o termo, e o resultado do banco
       * tem que passar por `casaTermo` no JavaScript antes de virar tela
       */
      filtrar: boolean;
    }
  | { ok: false; erro: string };

/**
 * Traduz o termo digitado no par (pattern do banco, precisa filtrar em JS?).
 *
 * O PROBLEMA: `*` e coringa do PostgREST e nao ha como escapa-lo no filtro
 * `ilike` — `\*` vira `\%` (percent literal) e mata o resultado. Mas `*` e
 * caractere COMUM no WhatsApp: e o marcador de negrito, e a assinatura do painel
 * sai como `*Nome:*`. Buscar por ele nao pode devolver zero.
 *
 * A SAIDA, em duas etapas: manda pro banco o MAIOR PEDACO do termo que nao tem
 * `*` (o banco devolve um superset garantido — toda mensagem que contem o termo
 * inteiro contem esse pedaco) e depois filtra o superset com `casaTermo`, que e
 * substring literal normalizada. Recall igual ao do banco, zero falso positivo.
 *
 * `*` SOZINHO NAO DA PRA BUSCAR: sem nenhum pedaco livre de `*`, o pattern seria
 * `%%` — varredura da tabela inteira pra depois filtrar quase tudo fora. Recusa
 * explicita com motivo legivel e melhor que uma busca que trava o banco.
 *
 * E O MAIOR PEDACO TEM MINIMO. `*a*` passaria pelo teste de "existe pedaco", mas
 * `%a%` casa quase toda mensagem do banco: o superset volta enorme, o filtro em
 * JS joga quase tudo fora e a conta e paga pelo Postgres. O minimo e o MESMO
 * `MIN_TERMO_BUSCA` que a busca sem `*` ja exige — quem digita `*a*` esta pedindo
 * a mesma coisa que quem digita `a`, e leva a mesma resposta.
 */
export function padraoParaIlike(termo: unknown): PadraoBusca {
  const t = String(termo ?? "");
  // pedacos livres de `*`, do maior pro menor: o primeiro e o mais seletivo, e a
  // ordem so ajuda quem le a query no log (o AND do PostgREST nao se importa)
  const pedacos = t
    .split("*")
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length);
  const maior = pedacos[0] || "";
  if (!maior) {
    return { ok: false, erro: "busca com asterisco precisa de pelo menos uma letra ou numero junto" };
  }
  if (maior.length < MIN_TERMO_BUSCA) {
    return {
      ok: false,
      erro: `refine a busca: e preciso um trecho de ${MIN_TERMO_BUSCA} caracteres ou mais sem asterisco`,
    };
  }
  return {
    ok: true,
    patterns: pedacos.map(escaparIlike),
    filtrar: pedacos.length > 1 || maior !== t,
  };
}

/**
 * Forma canonica pra COMPARAR e RECORTAR texto na tela: minusculas, sem acento,
 * sem espaco duplo.
 *
 * ATENCAO AO ESCOPO (corrigido na revisao cega, 31/08/2026): isto vale pro
 * RECORTE e pro REALCE que a tela desenha — NAO pra consulta. A busca no banco e
 * um `ilike` cru, e `ilike` **nao ignora acento** (sem `unaccent`/trigram, que
 * esta instalacao nao tem): quem digita "orcamento" NAO acha "orçamento" no
 * banco. Este arquivo nao pode prometer o que a consulta nao entrega — por isso
 * a rota devolve `realce: false` quando o banco casou e o normalizado nao, e
 * `casaTermo` e usada so pra decidir realce.
 *
 * Fechar de verdade a busca acento-insensivel exige `create extension unaccent`
 * + indice funcional, que e mudanca de infra da instalacao: declarado como
 * divida no CLAUDE.md, nao simulado aqui.
 */
export function normalizarBusca(texto: unknown): string {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** O termo aparece no texto? Comparacao normalizada (caixa, acento, espaco). */
export function casaTermo(texto: unknown, termo: unknown): boolean {
  const t = normalizarBusca(termo);
  if (!t) return false;
  return normalizarBusca(texto).includes(t);
}

export type Trecho = {
  /** o recorte em volta da primeira ocorrencia, no texto ORIGINAL */
  trecho: string;
  /** houve corte antes/depois (a tela desenha o "..." — a string nao o carrega) */
  cortou_inicio: boolean;
  cortou_fim: boolean;
};

/**
 * Recorta o pedaco do texto em volta da PRIMEIRA ocorrencia do termo.
 *
 * O recorte sai do texto ORIGINAL (com acento e caixa), mas a busca da posicao
 * roda no normalizado. Por isso o mapa de indices: `normalize("NFD")` MUDA O
 * COMPRIMENTO da string (um "ç" vira dois code points), entao usar o indice do
 * normalizado direto no original recorta no lugar errado — e o erro so aparece
 * em texto acentuado, que e a maioria em portugues. O mapa e construido
 * caractere a caractere justamente pra o indice voltar pro original.
 */
export function trechoDoTermo(texto: unknown, termo: unknown, raio = 60): Trecho {
  const original = String(texto ?? "");
  const t = normalizarBusca(termo);
  if (!t) return { trecho: original.slice(0, raio * 2), cortou_inicio: false, cortou_fim: original.length > raio * 2 };

  // normaliza caractere a caractere, guardando de qual indice do ORIGINAL cada
  // pedaco do normalizado veio
  let norm = "";
  const mapa: number[] = [];
  let espacoPendente = false;
  for (let i = 0; i < original.length; i++) {
    const pedaco = normalizarBusca(original[i]);
    if (!pedaco) {
      // caractere que virou vazio na normalizacao (espaco no fim, diacritico solto)
      if (/\s/.test(original[i])) espacoPendente = true;
      continue;
    }
    if (espacoPendente && norm) {
      norm += " ";
      mapa.push(i);
      espacoPendente = false;
    }
    for (const c of pedaco) {
      norm += c;
      mapa.push(i);
    }
  }

  const pos = norm.indexOf(t);
  if (pos < 0) {
    return { trecho: original.slice(0, raio * 2), cortou_inicio: false, cortou_fim: original.length > raio * 2 };
  }
  const inicioOrig = mapa[pos] ?? 0;
  const fimOrig = (mapa[Math.min(pos + t.length, mapa.length - 1)] ?? original.length - 1) + 1;
  const de = Math.max(0, inicioOrig - raio);
  const ate = Math.min(original.length, fimOrig + raio);
  return {
    trecho: original.slice(de, ate),
    cortou_inicio: de > 0,
    cortou_fim: ate < original.length,
  };
}

// ===========================================================================
// 3. Mídia da conversa
// ===========================================================================

/**
 * As TRES abas de midia.
 *
 * Nao e uma aba por tipo de arquivo — o mapa (modulo 10, secao 7.2) capturou o
 * formato real: `media` junta imagem, audio e video; `document` e `sticker` sao
 * separados. Copiado de proposito: sao as tres perguntas que a operacao faz
 * ("aquela foto", "aquele PDF", "aquela figurinha"), e separar audio de imagem
 * so multiplica cliques.
 */
export const ABAS_MIDIA = ["media", "document", "sticker"] as const;
export type AbaMidia = (typeof ABAS_MIDIA)[number];

export const ROTULO_ABA_MIDIA: Record<AbaMidia, string> = {
  media: "Fotos, audios e videos",
  document: "Documentos",
  sticker: "Figurinhas",
};

/**
 * Em qual aba entra um anexo. Devolve null pra mensagem que nao e midia.
 *
 * O TIPO manda, o MIME so desempata. Motivo medido no dicionario do mapa
 * (secao 7.4): `audio` e `ptt` sao tipos DIFERENTES no acervo (arquivo de audio
 * x audio gravado na hora, 36.330 juntos) e os dois sao a mesma coisa pra quem
 * procura. Ja `sticker` chega com mime de imagem (`image/webp`), entao decidir
 * por mime jogaria toda figurinha na aba de fotos.
 */
export function abaDaMidia(tipo: unknown, mime?: unknown): AbaMidia | null {
  const t = String(tipo ?? "").toLowerCase().trim();
  const m = String(mime ?? "").toLowerCase().trim();
  if (t === "sticker") return "sticker";
  if (t === "document") return "document";
  if (t === "image" || t === "audio" || t === "ptt" || t === "video") return "media";
  // tipo desconhecido (canal novo, provedor novo): cai pro mime, e so entao
  // pro balde de documento. Anexo que existe e nao aparece em aba nenhuma e
  // pior que anexo na aba errada.
  if (!m) return null;
  if (m.startsWith("image/")) return "media";
  if (m.startsWith("audio/")) return "media";
  if (m.startsWith("video/")) return "media";
  return "document";
}

export type ItemMidia = {
  id: string;
  provider_msg_id: string | null;
  tipo: string;
  mime: string | null;
  url: string | null;
  legenda: string | null;
  criada_em: string;
  direcao: string;
};

export type MidiaAgrupada = Record<AbaMidia, ItemMidia[]>;

/** Distribui os anexos nas tres abas, preservando a ordem recebida. */
export function agruparMidia(itens: ItemMidia[]): MidiaAgrupada {
  const saida: MidiaAgrupada = { media: [], document: [], sticker: [] };
  for (const it of itens ?? []) {
    const aba = abaDaMidia(it.tipo, it.mime);
    if (aba) saida[aba].push(it);
  }
  return saida;
}

// ===========================================================================
// 4. Histórico de status (com permanência)
// ===========================================================================

export const STATUS_CONVERSA_TELA = ["aberto", "atendimento", "aguardando", "concluido"] as const;
export type StatusTela = (typeof STATUS_CONVERSA_TELA)[number];

export type EventoStatus = {
  id: string;
  status: string;
  status_anterior: string | null;
  duracao_seg: number | null;
  por_id: string | null;
  por_nome: string | null;
  origem: string | null;
  fluxo_nome?: string | null;
  criada_em: string;
};

/**
 * Segundos entre dois instantes. Devolve null quando qualquer ponta nao e data
 * legivel, e nunca devolve negativo.
 *
 * O clamp em zero nao e paranoia: `criada_em` sai do `now()` do BANCO e o
 * `agora` da leitura sai do processo do Next. Relogios diferentes por alguns
 * milissegundos produzem "permanencia de -1s", que na tela vira numero absurdo.
 */
export function duracaoSeg(de: unknown, ate: unknown): number | null {
  const a = Date.parse(String(de ?? ""));
  const b = Date.parse(String(ate ?? ""));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}

// A DURACAO GRAVADA NAO E MAIS CALCULADA AQUI. Existia um `duracaoDoMarco` que
// a camada de banco usava antes de inserir o evento; ele foi REMOVIDO junto com
// a corrida que motivou a mudanca (duplo clique gravava permanencia dobrada,
// porque as duas chamadas liam o mesmo ultimo evento). O calculo mora agora
// DENTRO de `mensageria.registrar_status_evento` (0017), onde o `max(criada_em)`
// e lido na mesma instrucao que insere.
//
// DIVIDA DECLARADA, no padrao de `scripts/prova-relatorios.ts` (que declara o
// mesmo pra `mensageria.segundos_uteis`): a duracao GRAVADA passou a ser SQL e
// so se prova contra o Postgres da instalacao — nao ha como exercita-la em node
// solto. O que continua provado aqui e a leitura: `duracaoSeg` (a permanencia em
// curso, derivada) e a soma do resumo em `linhaDoTempoStatus`. Manter um helper
// morto so pra ter assercao verde seria prova que nao prova nada.

export type LinhaStatus = EventoStatus & {
  /** rotulo pronto de quem fez (pessoa, automacao ou sistema) */
  autor: string;
  /** true no evento mais recente: a permanencia dele ainda esta CORRENDO */
  atual: boolean;
  /** permanencia no status DESTE evento — derivada, e so existe no atual */
  em_curso_seg: number | null;
};

export type ResumoStatus = { status: string; total_seg: number; entradas: number };

/**
 * Monta a linha do tempo pra tela e o resumo de permanencia por status.
 *
 * Os eventos entram do MAIS NOVO pro mais velho (a ordem que a rota devolve, e
 * a que a tela desenha). O resumo soma `duracao_seg` por status ANTERIOR — e
 * ali que a permanencia foi medida — e acrescenta a permanencia em curso do
 * status atual, que e derivada de propostio: ela muda a cada segundo e nao pode
 * ficar congelada no banco.
 */
export function linhaDoTempoStatus(
  eventos: EventoStatus[],
  opcoes?: { agora?: unknown; truncado?: boolean }
): { linhas: LinhaStatus[]; resumo: ResumoStatus[]; resumo_parcial: boolean } {
  // EVENTO DE ROBO NAO E TROCA DE STATUS. O liga/desliga do robo por conversa
  // grava NESTA tabela (a mesma classe de defeito — mudanca de estado sem autor
  // — e a mesma trilha), mas com `origem: "robo"`. Deixa-lo entrar aqui poluiria
  // as duas coisas que este painel existe pra responder: a linha do tempo
  // mostraria "robo_desligado -> robo_ligado" entre "aberto" e "concluido", e o
  // "tempo em cada status" passaria a medir tempo desde o ultimo clique no robo.
  const lista = (Array.isArray(eventos) ? eventos : []).filter((e) => !ehEventoRobo(e));
  const agora = opcoes?.agora ?? new Date().toISOString();
  const linhas: LinhaStatus[] = lista.map((e, i) => ({
    ...e,
    autor: rotuloAutor(e.por_id, e.por_nome, e.origem),
    atual: i === 0,
    em_curso_seg: i === 0 ? duracaoSeg(e.criada_em, agora) : null,
  }));

  const por = new Map<string, ResumoStatus>();
  const soma = (status: string, seg: number, entrada: boolean) => {
    const linha = por.get(status) || { status, total_seg: 0, entradas: 0 };
    linha.total_seg += seg;
    if (entrada) linha.entradas += 1;
    por.set(status, linha);
  };
  for (const e of lista) {
    // o evento conta uma ENTRADA no status pra onde foi
    soma(e.status, 0, true);
    // e a permanencia medida pertence ao status de ONDE saiu
    if (e.status_anterior && typeof e.duracao_seg === "number" && e.duracao_seg > 0) {
      soma(e.status_anterior, e.duracao_seg, false);
    }
  }
  const atual = linhas[0];
  if (atual && atual.em_curso_seg) soma(atual.status, atual.em_curso_seg, false);

  return {
    linhas,
    resumo: Array.from(por.values()).sort((a, b) => b.total_seg - a.total_seg),
    // TRUNCADO CONTAMINA O RESUMO, e a tela tem que dizer isso (achado da
    // revisao cega). A leitura corta em N trocas mais recentes; o resumo soma o
    // que veio. Numa conversa com mais trocas que o teto, "Tempo em cada status:
    // atendimento 2h" e FALSO — o verdadeiro pode ser 40h. Nao somem com o
    // resumo (ele ainda e util pra ler a fatia recente) nem o apresente como
    // total: quem consome marca "parcial".
    resumo_parcial: opcoes?.truncado === true,
  };
}

/** Origem que marca o liga/desliga do robo dentro da trilha de status. */
export const ORIGEM_ROBO = "robo";
export const STATUS_ROBO_LIGADO = "robo_ligado";
export const STATUS_ROBO_DESLIGADO = "robo_desligado";

/**
 * O evento e do robo (e nao uma troca de status de atendimento)?
 *
 * Testa a ORIGEM, nao o status: `origem` e o campo que a funcao do banco grava e
 * que a leitura filtra, e um status novo de robo entraria sem ninguem lembrar de
 * atualizar uma lista de strings aqui.
 */
export function ehEventoRobo(evento: { origem?: unknown }): boolean {
  return String(evento?.origem ?? "") === ORIGEM_ROBO;
}

/**
 * Booleano ESTRITO vindo do corpo de um pedido.
 *
 * `!!valor` aceitaria a string `"false"` como `true` — e desligar o robo por
 * engano quando quem chama mandou `"false"` (o caso normal de formulario HTML e
 * de query string) e exatamente o tipo de falha que ninguem percebe. Devolve
 * `null` pra qualquer coisa que nao seja booleano de verdade, e quem chama
 * responde 400.
 */
export function booleanoEstrito(valor: unknown): boolean | null {
  return typeof valor === "boolean" ? valor : null;
}

/**
 * Como o autor de um evento aparece na tela.
 *
 * Convencao da 0006, e ela vale em TODA trilha do repo: id+nome = pessoa;
 * id NULL com nome preenchido = automacao (o nome diz qual); os dois NULL =
 * linha anterior a trilha, ou caminho que nao registrou. O terceiro caso e o
 * que mais importa acertar: escrever "Sistema" ali seria afirmar que a
 * automacao fez, quando a verdade e que ninguem sabe.
 */
export function rotuloAutor(porId: unknown, porNome: unknown, origem?: unknown): string {
  const nome = String(porNome ?? "").trim();
  if (porId && nome) return nome;
  if (porId) return "usuario do painel";
  if (nome) return nome;
  const o = String(origem ?? "").trim();
  return o ? `sem autor registrado (${o})` : "sem autor registrado";
}

/** "2h 14min" / "3d 5h" / "48s" — duracao curta pra caber em linha de trilha. */
export function formatarDuracao(segundos: unknown): string {
  // NULL/undefined tem que virar "—", NUNCA "0s": `Number(null)` e 0, e "0s" na
  // tela AFIRMA que a conversa passou zero segundo no status. "sem medicao" e
  // outra coisa — e o caso normal do primeiro evento de conversa importada, que
  // nao tem marco anterior de onde medir.
  if (segundos === null || segundos === undefined || segundos === "") return "—";
  const s = Number(segundos);
  if (!Number.isFinite(s) || s < 0) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const rmin = min % 60;
  if (h < 24) return rmin ? `${h}h ${rmin}min` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

// ===========================================================================
// 5. Histórico de transferência
// ===========================================================================

export type EventoResponsavel = {
  id: string;
  acao: string;
  tipo: string;
  ref_id: string;
  ref_nome: string | null;
  por_id: string | null;
  por_nome: string | null;
  origem: string | null;
  fluxo_nome?: string | null;
  criada_em: string;
};

export type LinhaTransferencia = EventoResponsavel & {
  /** quem passou (rotulo pronto) */
  autor: string;
  /** pra quem foi (nome + o que e) */
  destino: string;
  /** frase curta pronta pra linha da trilha */
  descricao: string;
};

/**
 * Monta a trilha de transferencia como a operacao le.
 *
 * O formato copia as tres colunas do ChatGuru capturadas no mapa (modulo 10,
 * secao 7.2): delegado (usuario OU departamento), delegado por (que pode ser a
 * automacao) e quando. A frase pronta sai daqui, e nao da tela, porque e regra:
 * "atribuido" e "removido" contam historias diferentes e a tela nao deve
 * escolher o verbo.
 */
export function linhaDoTempoTransferencia(eventos: EventoResponsavel[]): LinhaTransferencia[] {
  return (Array.isArray(eventos) ? eventos : []).map((e) => {
    const autor = rotuloAutor(e.por_id, e.por_nome, e.origem);
    const nome = String(e.ref_nome ?? "").trim() || e.ref_id;
    const oque = e.tipo === "departamento" ? "departamento" : "pessoa";
    const destino = `${nome} (${oque})`;
    const descricao =
      e.acao === "removido"
        ? `${autor} tirou ${destino} da conversa`
        : `${autor} passou a conversa para ${destino}`;
    return { ...e, autor, destino, descricao };
  });
}

// ===========================================================================
// 6. Iniciar conversa nova
// ===========================================================================

/**
 * Teto de conversas NOVAS por usuario por hora.
 *
 * ESTE NUMERO E A TRAVA, e vale explicar por que ele existe. A trava
 * anti-disparo-frio do painel mora em /api/send: "so envia pra conversa que ja
 * existe". Abrir conversa nova, por definicao, e a excecao a essa regra — e
 * excecao sem teto e a regra revogada. Com 20/hora, o atendente que precisa
 * chamar um cliente chama; quem tentar rodar uma lista de 500 numeros pelo
 * botao para na 21a e vai usar o modulo de disparo, que tem opt-out, ritmo e
 * trilha de campanha.
 *
 * O teto e por PESSOA (nao por instalacao) de proposito: teto global viraria um
 * atendente sozinho bloqueando o time inteiro.
 */
export const TETO_INICIOS_POR_HORA = 20;

/** Teto do texto da primeira mensagem (o mesmo espirito do composer). */
export const LIMITE_TEXTO_INICIO = 4096;

export type InicioValido = {
  ok: true;
  chat_id: string;
  telefone: string;
  texto: string;
};
export type InicioInvalido = { ok: false; erro: string };

/**
 * Valida o pedido de abrir conversa nova.
 *
 * TRES travas, e nenhuma delas e cosmetica:
 *
 *  1. UM destino por chamada, nunca lista. E a trava ESTRUTURAL: uma rota que
 *     aceita array de destinos e uma rota de disparo, por mais teto que tenha.
 *     Sem array, transformar isto em campanha exige N chamadas — que o teto por
 *     hora corta e a trilha registra uma por uma.
 *  2. `confirmado` explicito. O consentimento de "vou puxar assunto com quem
 *     nao me procurou" e um gesto de GENTE, dado na tela naquele instante.
 *     Nenhum conteudo de conversa, nenhuma inferencia e nenhuma chave de API
 *     produz esse `true` — quem chama pela API tem que mandar, e mandar e
 *     assumir.
 *  3. GRUPO nao. Abrir conversa e escrever pra uma PESSOA que nao procurou a
 *     empresa. Entrar num grupo pelo painel e outra coisa, com outras
 *     consequencias, e nao e este botao.
 *
 * A normalizacao do telefone NAO mora aqui: e `normalizarTelefone` de
 * lib/disparo/telefone.ts, que ja e pura, ja aceita mascara e ja e a regra
 * usada pelo disparo. Duas validacoes de telefone no mesmo repo divergem — a
 * rota passa o resultado dela pra ca.
 */
export function validarInicioConversa(entrada: {
  chat_id?: unknown;
  telefone?: unknown;
  grupo?: unknown;
  texto?: unknown;
  confirmado?: unknown;
}): InicioValido | InicioInvalido {
  if (entrada?.confirmado !== true) {
    return {
      ok: false,
      erro: "iniciar conversa exige confirmacao explicita de quem esta na tela (confirmado)",
    };
  }
  const chatId = String(entrada?.chat_id ?? "").trim();
  if (!chatId) return { ok: false, erro: "numero de destino obrigatorio" };
  if (entrada?.grupo === true || /-group$/.test(chatId)) {
    return { ok: false, erro: "iniciar conversa vale so pra pessoa, nao pra grupo" };
  }
  const texto = String(entrada?.texto ?? "").trim();
  if (!texto) {
    return { ok: false, erro: "a primeira mensagem e obrigatoria (abrir conversa vazia nao avisa ninguem)" };
  }
  if (texto.length > LIMITE_TEXTO_INICIO) {
    return { ok: false, erro: `a primeira mensagem passa de ${LIMITE_TEXTO_INICIO} caracteres` };
  }
  return { ok: true, chat_id: chatId, telefone: String(entrada?.telefone ?? chatId), texto };
}

// O TETO NAO E MAIS DECIDIDO EM JAVASCRIPT — e o achado grave da revisao cega
// (31/08/2026). Existia aqui um `estourouTetoInicios(contagem)` que a rota usava
// como `contar() -> if (estourou) 429 -> enviar()`: entre a contagem e o envio
// nao havia nada, entao N chamadas paralelas liam a MESMA contagem e TODAS
// passavam. A funcao foi REMOVIDA de propostio, e nao apenas deixada de usar:
// enquanto ela existisse, o caminho vazado continuaria a um import de distancia.
//
// A decisao mora agora em `mensageria.reservar_inicio` (0017), que conta e insere
// a linha na MESMA instrucao SQL — ver `reservarInicio` em lib/tela-conversa-db.ts.
// A prova modela essa semantica e trava, por leitura dos arquivos, que a rota nao
// voltou a contar antes de enviar.


// ===========================================================================
// 7. Robô ligado/desligado por conversa
// ===========================================================================

/**
 * A conversa aceita automacao?
 *
 * DEFAULT TRUE quando o campo nao veio, e isto e a decisao mais importante
 * deste arquivo. O campo pode faltar por tres motivos: a migration 0017 nao
 * rodou, a leitura falhou, ou o canal e de fonte externa e nao tem linha de
 * conversa no painel. Nos tres, `false` desligaria a automacao da instalacao
 * inteira em silencio — a falha de UMA leitura viraria "o robo parou de
 * funcionar e ninguem sabe por que". Ligado e o comportamento historico do
 * painel; o desligamento tem que ser um `false` que alguem gravou de propostio.
 */
export function botLigado(valor: unknown): boolean {
  return valor === false ? false : true;
}

export type OrigemExecucao = "manual" | "gatilho";

/**
 * O PORTAO que a automacao consulta. Devolve o motivo da recusa, ou null pra
 * seguir.
 *
 * A regra tem duas metades:
 *
 *   * origem "gatilho" (a automacao decidiu agir sozinha) RESPEITA a chave.
 *     Desligar o robo numa conversa e dizer "para de agir sozinho aqui" —
 *     tipicamente porque um humano assumiu o caso e nao quer o menu automatico
 *     atropelando.
 *   * origem "manual" (um atendente disparou um macro pela tela ou pela API)
 *     IGNORA a chave, de propostio. Desligar o robo nao pode tirar a ferramenta
 *     da mao de quem esta atendendo: quem clicou sabe o que esta fazendo, e a
 *     alternativa seria o atendente clicando num botao que nao faz nada sem
 *     entender por que.
 *
 * COSTURA PENDENTE (declarada no CLAUDE.md): hoje NENHUM caminho de gatilho
 * existe no repo — `/api/macros` e o unico chamador de `executarMacro` e passa
 * origem "manual". Este portao esta pronto e provado; quem escrever o gatilho
 * v2 (ou ligar `origem: "gatilho"` em `lib/fluxo/executar.ts`, que tem outro
 * dono) chama esta funcao com o `bot_ativo` lido por
 * `botAtivoDaConversa` (lib/tela-conversa-db.ts) ANTES de rodar.
 */
export function motivoBotDesligado(botAtivo: unknown, origem: OrigemExecucao): string | null {
  if (origem !== "gatilho") return null;
  if (botLigado(botAtivo)) return null;
  return "o robo esta desligado nesta conversa (um atendente assumiu o atendimento)";
}

// ---------------------------------------------------------------------------
// SELO "isto saiu do fluxo X" na bolha da mensagem (costura com a Frente P)
// ---------------------------------------------------------------------------

/**
 * O vinculo que `GET /api/fluxo-fila?trilha=1` devolve em `por_mensagem`.
 *
 * ATENCAO A CHAVE do mapa: e o `id` da linha em `mensagens` (uuid), NAO o
 * `provider_msg_id`. Quem grava e `lib/fluxo/executar.ts`, que insere a mensagem
 * e guarda o `id` devolvido pelo banco; a coluna da 0018 e `mensagem_id uuid`.
 * Indexar pelo id do provedor devolveria selo NENHUM, calado — e "sem selo" e
 * indistinguivel de "nao saiu de fluxo", entao o erro nao apareceria.
 */
export type VinculoFluxo = {
  execucao_id?: string | null;
  fluxo_slug?: string | null;
  fluxo_nome?: string | null;
  no_id?: string | null;
};

export type SeloFluxo = { fluxo_slug: string; rotulo: string };

/**
 * Decide o selo de UMA bolha. Devolve null quando nao ha selo pra mostrar — e
 * `null` e a resposta certa pra todos os caminhos ruins, porque este selo e
 * METADADO: mapa que nao carregou (rota 403 por falta de `automacao`, instalacao
 * sem a 0018, erro de rede) tem que sumir em silencio, nunca virar aviso na tela
 * nem afirmar que a mensagem foi humana.
 *
 * SO MENSAGEM ENVIADA leva selo: a trilha registra o que a automacao FEZ, e o que
 * ela faz e mandar. Mensagem recebida com id no mapa seria dado corrompido — e
 * mesmo assim o selo nao aparece, porque "o cliente escreveu isso pelo fluxo" nao
 * significa nada pra quem le a conversa.
 *
 * O ROTULO cai no slug quando o fluxo nao tem nome (fluxo deletado, ou nome nulo
 * na tabela): slug tecnico e feio, mas dizer "saiu de um fluxo" sem dizer qual e
 * pior — o atendente precisa saber ONDE mexer pra parar aquilo.
 */
export function seloDeFluxo(
  porMensagem: Record<string, VinculoFluxo> | null | undefined,
  mensagem: { id?: unknown; from_me?: unknown } | null | undefined
): SeloFluxo | null {
  if (!porMensagem || !mensagem) return null;
  if (mensagem.from_me !== true) return null;
  const id = typeof mensagem.id === "string" ? mensagem.id : "";
  if (!id) return null;
  const v = porMensagem[id];
  if (!v) return null;
  const slug = typeof v.fluxo_slug === "string" ? v.fluxo_slug.trim() : "";
  const nome = typeof v.fluxo_nome === "string" ? v.fluxo_nome.trim() : "";
  // TETO NO ROTULO: nome de fluxo e conteudo de terceiro (fluxo importado, nome
  // digitado por quem configurou) e ele vai pro `title` da bolha inteiro. 120
  // chars e a mesma disciplina das outras previas deste repo.
  const rotulo = (nome || slug).slice(0, 120);
  if (!rotulo) return null; // vinculo sem identificacao nenhuma nao vira selo
  return { fluxo_slug: slug.slice(0, 120), rotulo };
}
