// Schema CANONICO do fluxo de automacao (modulo `automacao`).
//
// Este formato e PUBLICO e e o contrato entre tres coisas:
//   (a) o motor que executa (lib/fluxo/executar.ts),
//   (b) o que fica gravado em mensageria.fluxos (jsonb),
//   (c) os CONVERSORES de outras ferramentas — o do ChatGuru e o primeiro de N
//       (scripts/fluxo/converter-chatguru.mjs).
// Documentacao pra humano: docs/fluxo-canonico.md.
//
// Regra deste arquivo: ZERO import. Ele e importado tanto pelo Next (com alias
// @/) quanto por script solto rodando em Node puro (`node scripts/prova-fluxo.ts`,
// type stripping nativo) — qualquer dependencia quebraria o segundo caso.
// Validacao e funcao PURA, sem lib de schema: o repo nao ganha dependencia nova
// por causa disto.

export const VERSAO_SCHEMA = 1;

export type TipoFluxo = "macro" | "gatilho";
export type TipoNo = "acao" | "condicao" | "espera" | "gatilho";

/**
 * COMO o fluxo esta sendo executado, e e uma diferenca de CAPACIDADE, nao de
 * gosto (Frente P, 31/08/2026):
 *
 *  - `inline` = dentro da requisicao (`/api/macros`). Sabe fazer espera curta com
 *    `setTimeout` e NAO sabe parar pra esperar um humano — a funcao morre no fim
 *    da requisicao.
 *  - `fila`   = passo agendado em `mensageria.fluxo_fila`, retomado por um tick.
 *    Sabe esperar 5 dias, pular fim de semana e parar esperando aprovacao.
 *
 * O preflight (`motivoParaRecusarPuro`) recusa coisas diferentes em cada modo, e
 * e por isso que o modo entra na DECISAO e nao so na fiacao.
 */
export type ModoExecucao = "inline" | "fila";

// Acoes da v1. Sao exatamente as mecanicas que o painel ja sabe fazer numa
// conversa; nada aqui inventa capacidade nova.
export const ACOES_V1 = [
  "enviar_texto",
  "etiquetar",
  "mudar_status",
  "atribuir_responsavel",
  "nota_interna",
  "mover_funil",
  "espera",
  // memoria da conversa (par chave/valor) — o que faz o motor deixar de ser
  // reflexo e virar maquina de estados
  "definir_contexto",
  "limpar_contexto",
  // FRENTE W (31/08/2026, card 86ak85bmw): manda um arquivo da BIBLIOTECA da
  // instalacao. Ela entra na v1 porque o dado exige: 56 anexos da conta medida
  // sao referenciados DIRETAMENTE por dialogos (76 ocorrencias nas acoes), e sem
  // esta acao aqueles fluxos importam com a acao faltando — a mensagem sai e o
  // material nao. O alvo vai por CHAVE (slug), nunca por uuid, pelo mesmo motivo
  // de `mover_funil` ir por nome: o formato e portatil entre instalacoes.
  "anexar_biblioteca",
  // FRENTE Y (31/08/2026) — pergunta com OPCOES (botoes ou lista). Fecha o
  // criterio do card 86ak86jvw ("existe um tipo de passo que envia botoes/lista")
  // pelo CONTRATO que a Frente S escreveu no CLAUDE.md.
  "perguntar_opcoes",
] as const;
export type TipoAcao = (typeof ACOES_V1)[number];

// Status de conversa do painel (espelho de STATUS_VALIDOS em app/api/conversa).
export const STATUS_CONVERSA = ["aberto", "atendimento", "concluido", "aguardando"] as const;
export type StatusConversa = (typeof STATUS_CONVERSA)[number];

export const MODOS_ETIQUETA = ["adicionar", "remover", "substituir"] as const;
export type ModoEtiqueta = (typeof MODOS_ETIQUETA)[number];

export const TIPOS_RESPONSAVEL = ["usuario", "departamento"] as const;
export type TipoResponsavel = (typeof TIPOS_RESPONSAVEL)[number];

// Limites — espelham os das rotas equivalentes, pra um fluxo valido nunca
// gerar uma chamada que a rota recusaria.
export const LIMITE_TEXTO = 4096; // /api/send
export const LIMITE_NOTA = 4000; // /api/nota
export const LIMITE_ETIQUETAS = 30; // /api/etiquetas
export const LIMITE_NOS = 200;
// espera: o SCHEMA aceita ate 30 dias porque regua importada de outra
// ferramenta tem atraso de dias e precisa caber no formato sem perda. Quem
// limita a execucao e o MOTOR (v1 so faz espera curta inline) — ver executar.ts.
export const LIMITE_ESPERA_SEG = 30 * 24 * 3600;
// espelho de LIMITE_NOME em lib/funis.ts (este arquivo nao importa nada de
// proposito; mudou la, muda aqui)
export const LIMITE_NOME_FUNIL = 120;

// contexto da conversa (memoria do robo)
export const LIMITE_CHAVE_CONTEXTO = 120;
export const LIMITE_VALOR_CONTEXTO = 1000;
// LIMITES POR CONVERSA (Frente P, 31/08/2026) — os dois campos medidos no
// ChatGuru (`max_executions_per_chat`, `seconds_between_executions`) viram dois
// campos honestos. 999/9999 de la ("sem limite escrito a mao") o importador
// traduz pra `null`; aqui `null`/ausente E "sem limite".
export const LIMITE_MAXIMO_POR_CONVERSA = 9998;
// 30 dias, o mesmo teto da espera: a cauda medida vai a 432.000s (5 dias)
export const LIMITE_INTERVALO_MINIMO_SEG = 30 * 24 * 3600;
/**
 * Teto da SOMA das esperas de uma corrente que roda pela FILA.
 *
 * O limite POR espera e 30 dias (`LIMITE_ESPERA_SEG`), mas nada impedia uma
 * corrente de somar meses: 20 esperas de 30 dias sao 20 meses de cadeia viva —
 * uma linha ocupando a trava de "uma cadeia viva por fluxo por conversa" por um
 * ano e meio, e uma mensagem chegando pro cliente muito depois de qualquer
 * contexto existir. 90 dias e um numero ESCOLHIDO (o acervo medido nao tem regua
 * maior que 5 dias, entao ele nao corta caso real) e a recusa acontece ao
 * ENFILEIRAR, com o total escrito na mensagem.
 */
export const LIMITE_ESPERA_TOTAL_FILA_SEG = 90 * 24 * 3600;
// arvore de condicao: teto de profundidade e de termos. Condicao vinda de
// importacao e conteudo de TERCEIRO — sem teto, uma arvore fundo demais estoura
// a pilha no servidor (o avaliador e recursivo).
export const LIMITE_PROFUNDIDADE_CONDICAO = 12;
export const LIMITE_TERMOS_CONDICAO = 200;
export const LIMITE_VALOR_CONDICAO = 1000;
// FRENTE W (card 86ak85bmw) — anexo da biblioteca. Estes tres sao ESPELHO de
// lib/anexos.ts (`LIMITE_CHAVE`, o formato da chave e `LIMITE_LEGENDA`), que e o
// dono da regra: este arquivo nao importa nada de proposito, entao "mudou la,
// muda aqui". A prova da frente compara os dois lados e reprova se divergirem —
// espelho sem guarda de deriva e espelho que envelhece calado.
export const LIMITE_CHAVE_ANEXO = 60;
export const LIMITE_LEGENDA_ANEXO = 1024;
const RE_CHAVE_ANEXO = /^[a-z0-9][a-z0-9_-]{0,59}$/;

// ————————————————————————— FRENTE Y: pergunta com opcoes (`perguntar_opcoes`)
//
// TETOS DE SANIDADE DO FORMATO — NAO sao os do WhatsApp. Os tetos de PLATAFORMA
// (3 botoes, 10 itens de lista, titulo de opcao 20/24, corpo 1024) moram em
// `lib/interativas.ts`, que este arquivo NAO importa de proposito: schema.ts e o
// contrato publico do formato e tem ZERO import (guarda em
// `scripts/prova-motor-fila.ts`). Aqui se protege o jsonb de payload absurdo;
// quem recusa por teto de plataforma e o PREFLIGHT (`motivoParaRecusar` em
// lib/fluxo/executar.ts, que importa a lib e chama `validarInterativa` — a MESMA
// funcao da rota `/api/send` e do composer).
//
// A DIVISAO E A MESMA QUE `mover_funil` JA USA: aqui vale o FORMATO, e a
// checagem que depende de conhecer o mundo (existencia da etapa lá; tetos da
// plataforma aqui) mora em quem conhece esse mundo.
//
// DIRECAO OBRIGATORIA: estes tetos sao SEMPRE >= os de `lib/interativas.ts`, pra
// o formato nunca recusar o que a plataforma aceita — o inverso e que e certo.
// `scripts/prova-costuras-y.ts` le os dois modulos e reprova se a direcao virar.
export const MIN_OPCOES_PERGUNTA = 2;
export const LIMITE_OPCOES_PERGUNTA = 20;
/** teto unico dos ROTULOS curtos da pergunta (titulo, rodape, botao, opcao) */
export const LIMITE_ROTULO_PERGUNTA = 200;

/** espelho de TIPOS_INTERATIVA em lib/interativas.ts (a prova compara os dois) */
export const TIPOS_PERGUNTA = ["botoes", "lista"] as const;
export type TipoPergunta = (typeof TIPOS_PERGUNTA)[number];
export type OpcaoPergunta = { titulo: string; descricao?: string };
/**
 * O payload da acao, no formato EXATO do contrato da Frente S (CLAUDE.md, secao
 * "CONTRATO do passo interativo de fluxo") — reproduzido ao pe da letra pra a
 * costura ser mecanica: `{ tipo, texto, titulo?, rodape?, botao_lista?, opcoes }`.
 */
export type PerguntaOpcoes = {
  tipo: TipoPergunta;
  /** o corpo da pergunta */
  texto: string;
  titulo?: string;
  rodape?: string;
  /** rotulo do botao que ABRE a lista (a lista nao aparece sozinha) */
  botao_lista?: string;
  opcoes: OpcaoPergunta[];
};

export type Acao =
  | { tipo: "enviar_texto"; texto: string }
  | { tipo: "etiquetar"; etiquetas: string[]; modo: ModoEtiqueta }
  | { tipo: "mudar_status"; status: StatusConversa }
  | { tipo: "atribuir_responsavel"; responsaveis: { tipo: TipoResponsavel; id: string; nome: string }[] }
  | { tipo: "nota_interna"; texto: string }
  // Funil e etapa vao por NOME, nao por id: o fluxo canonico e PORTATIL entre
  // instalacoes e nao pode carregar o uuid de uma delas. `etapa: null` = tira a
  // conversa daquele funil. Quem resolve nome->id e lib/funis.ts, sempre DENTRO
  // do funil informado (nome de etapa se repete entre funis).
  | { tipo: "mover_funil"; funil: string; etapa: string | null }
  // A espera e o RELOGIO do fluxo, e por isso a opcao de pular fim de semana
  // mora AQUI e nao no no de acao: quem tem hora marcada e ela. Vem do
  // `jump_weekend` do ChatGuru (26 acoes medidas) — "seguimento agendado pra 48h
  // depois numa sexta nao pode cair no domingo". O fuso e o da INSTALACAO
  // (lib/fuso.ts); quem aplica e a fila (lib/fluxo/fila.ts).
  | { tipo: "espera"; segundos: number; pular_fim_de_semana?: boolean }
  // Contexto da conversa: par chave/valor gravado NA CONVERSA (tabela do
  // painel, chaveada por canal+chat_id). E a memoria que a condicao le.
  | { tipo: "definir_contexto"; chave: string; valor: string }
  | { tipo: "limpar_contexto"; chave: string }
  // FRENTE W: `anexo` e a CHAVE do item na biblioteca da instalacao (slug), e
  // `legenda` e o texto que vai junto do arquivo. A validacao do formato da chave
  // e o teto da legenda vivem em lib/anexos.ts (que tambem nao importa nada);
  // aqui ficam so os limites de forma, pra este arquivo seguir sem dependencia.
  | { tipo: "anexar_biblioteca"; anexo: string; legenda?: string }
  // FRENTE Y — PERGUNTA COM OPCOES. O payload vive em `params` (e nao espalhado
  // no no) porque o contrato da Frente S o nomeia assim E porque `tipo` ja e o
  // nome do campo que diz qual e a ACAO: aninhar e o que deixa `params.tipo`
  // ("botoes"|"lista") conviver com `acao.tipo` sem apelido inventado.
  | { tipo: "perguntar_opcoes"; params: PerguntaOpcoes };

// ---------------------------------------------------------------- condicao
// CONDICAO E ESTRUTURA, NUNCA TEXTO. A ferramenta de origem (ChatGuru) guarda a
// condicao como mini-linguagem em texto, validada so no servidor dela; aqui ela
// e uma ARVORE de comparacoes, montavel clicando em blocos e provavel sem banco.
// Quem traduz o texto de la pra ca e o ANALISADOR do conversor
// (scripts/fluxo/parser-condicao-chatguru.mjs) — que nunca chuta em silencio.

// Campos que a v1 sabe consultar numa conversa. Cada um vira um "fato" coletado
// pelo motor (ver FatosConversa). O que nao esta aqui NAO vira condicao: vira
// ressalva na importacao, com o motivo escrito.
// `intencao` (Frente T, card 86ak85nzr) e MULTIVALOR: a mesma mensagem pode
// reconhecer mais de uma intencao, e a comparacao segue a regra 3 do avaliador
// (existencia no positivo, ausencia no negativo) — igual etiqueta.
// `ficha` (Frente X, card 86ak85nxn) e o CAMPO PERSONALIZADO do contato — a
// ficha que cada instalacao monta (lib/campos.ts, `mensageria.campos_personalizados`).
// Igual `contexto`, ele exige `chave`: qual campo da ficha. Diferente de
// `contexto`, a chave casa por forma NORMALIZADA (ver `chaveDeFicha` abaixo).
export const CAMPOS_CONDICAO = ["texto", "status", "etiqueta", "contexto", "etapa", "intencao", "ficha"] as const;
export type CampoCondicao = (typeof CAMPOS_CONDICAO)[number];

// Operadores da v1. NAO existe operador de ORDEM (<, >) de proposito: no acervo
// medido (33 contas, 3.305 expressoes) ordem so aparece com hora/data
// (`!current_time`, `!current_date`), que nao e campo da v1 — inventar `menor`
// sem ter o campo seria peca morta.
export const OPERADORES_CONDICAO = [
  "igual",
  "diferente",
  "contem",
  "nao_contem",
  "comeca_com",
  "existe",
  "nao_existe",
] as const;
export type OperadorCondicao = (typeof OPERADORES_CONDICAO)[number];

// operadores que NAO levam valor (falam sobre presenca, nao sobre conteudo)
export const OPERADORES_SEM_VALOR: readonly OperadorCondicao[] = ["existe", "nao_existe"];

export type Comparacao = {
  tipo: "comparacao";
  campo: CampoCondicao;
  operador: OperadorCondicao;
  /** ausente exatamente nos operadores de presenca */
  valor?: string;
  /** obrigatorio em campo "contexto" (variavel da conversa) e "ficha" (campo personalizado) */
  chave?: string;
  /** obrigatorio em campo "etapa": nome do funil (etapa NUNCA e nome solto) */
  funil?: string;
};

export type Condicao =
  | Comparacao
  | { tipo: "e"; condicoes: Condicao[] }
  | { tipo: "ou"; condicoes: Condicao[] }
  | { tipo: "nao"; condicao: Condicao };

export type No = {
  id: string;
  tipo: TipoNo;
  // presente em no de tipo "acao" e "espera"
  acao?: Acao;
  // proximo no na sequencia; ausente = fim do ramo
  proximo?: string;
  // ramificacao (tipo "condicao") — v2: um no que escolhe ENTRE caminhos. O
  // formato guarda pro conversor nao perder a estrutura e pro editor visual.
  // Macro nao aceita (ver validarFluxo).
  ramos?: { quando: string; condicao?: Condicao; proximo: string }[];
  // condicao ESTRUTURADA de um no `tipo: "condicao"`. Num MACRO ela decide
  // seguir (verdadeira -> vai pro `proximo`) ou PARAR (falsa -> o macro termina
  // ali, sem erro). Ramificacao de verdade e v2.
  condicao?: Condicao;
  // rotulo livre pra tela (nunca usado pra decidir nada)
  rotulo?: string;
  // APROVACAO HUMANA (Frente P, 31/08/2026 — `need_approval`, 52 acoes medidas):
  // o passo NAO executa direto; a execucao para na fila esperando alguem aprovar.
  // So `true` liga (qualquer outro valor e ignorado na validacao: aprovacao que
  // nasce ligada por lixo no jsonb travaria fluxo que hoje roda; aprovacao que
  // nasce DESligada por lixo mandaria mensagem sensivel sem aval — por isso o
  // valor tem que ser booleano de verdade ou o fluxo e RECUSADO).
  aprovacao?: boolean;
  /**
   * PASSO DESLIGADO (Frente T, card 86ak85nzy — edicao rapida POR ACAO).
   *
   * O passo continua NO LUGAR (posicao, encadeamento e conteudo intactos) e nao
   * executa. E a diferenca entre isso e tirar o no da corrente: tirar da corrente
   * perde a posicao e, na volta, exige reencadear tudo a mao — e o uso real e
   * "desliga esse aviso por uma semana", nao "apaga esse passo".
   *
   * So `true` liga o desligamento, e valor torto RECUSA o fluxo (mesma regra de
   * `aprovacao`): um "false" em texto desligaria um passo que hoje roda, e um 0
   * ligaria de volta um passo que alguem desligou de proposito — os dois em
   * silencio, e nos dois casos o efeito e visivel pro cliente.
   */
  desligado?: boolean;
};

// ------------------------------------------------------------- limites
// Limites POR CONVERSA do fluxo inteiro (nao do passo). Medidos no ChatGuru
// (docs/mapa/04, secao 2): `max_executions_per_chat` e
// `seconds_between_executions`. Quem aplica e a FILA, no momento de enfileirar
// (lib/fluxo/fila.ts `motivoParaNaoEnfileirar`) — o macro disparado a mao por um
// atendente NAO passa por eles de proposito: pessoa clicando e decisao humana, e
// anti-repique existe pra conter robo.
export type LimitesFluxo = {
  /** quantas vezes este fluxo pode rodar na MESMA conversa; null = sem limite */
  maximo_por_conversa: number | null;
  /** anti-repique: segundos que precisam passar entre duas execucoes na mesma conversa */
  intervalo_minimo_segundos: number;
};

export const LIMITES_PADRAO: LimitesFluxo = {
  maximo_por_conversa: null,
  intervalo_minimo_segundos: 0,
};

// Rastreabilidade de importacao: de onde este fluxo veio e o que se perdeu no
// caminho. `ressalvas` e o que o conversor NAO conseguiu representar — e a
// diferenca entre "importei" e "importei e sei o que ficou faltando".
export type Origem = {
  ferramenta: string;
  id_original: string;
  ressalvas: string[];
};

export type Fluxo = {
  id: string;
  nome: string;
  tipo: TipoFluxo;
  versao: number;
  nos: No[];
  origem?: Origem;
  descricao?: string;
  /** limites POR CONVERSA; ausente = sem limite nenhum */
  limites?: LimitesFluxo;
};

export type ResultadoValidacao =
  | { ok: true; fluxo: Fluxo }
  | { ok: false; erros: string[] };

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function ehTexto(v: unknown): v is string {
  return typeof v === "string";
}

function validarAcao(bruto: any, onde: string, erros: string[]): Acao | null {
  if (!bruto || typeof bruto !== "object") {
    erros.push(`${onde}: acao ausente`);
    return null;
  }
  const tipo = bruto.tipo;
  if (!(ACOES_V1 as readonly string[]).includes(tipo)) {
    erros.push(`${onde}: acao de tipo desconhecido (${String(tipo)})`);
    return null;
  }
  switch (tipo as TipoAcao) {
    case "enviar_texto": {
      const texto = ehTexto(bruto.texto) ? bruto.texto : "";
      if (!texto.trim()) {
        erros.push(`${onde}: enviar_texto sem texto`);
        return null;
      }
      if (texto.length > LIMITE_TEXTO) {
        erros.push(`${onde}: texto acima de ${LIMITE_TEXTO} caracteres`);
        return null;
      }
      return { tipo: "enviar_texto", texto };
    }
    case "nota_interna": {
      const texto = ehTexto(bruto.texto) ? bruto.texto : "";
      if (!texto.trim()) {
        erros.push(`${onde}: nota_interna sem texto`);
        return null;
      }
      if (texto.length > LIMITE_NOTA) {
        erros.push(`${onde}: nota acima de ${LIMITE_NOTA} caracteres`);
        return null;
      }
      return { tipo: "nota_interna", texto };
    }
    case "etiquetar": {
      if (!Array.isArray(bruto.etiquetas)) {
        erros.push(`${onde}: etiquetar sem lista de etiquetas`);
        return null;
      }
      const etiquetas = Array.from(
        new Set(bruto.etiquetas.filter(ehTexto).map((e: string) => e.trim()).filter(Boolean))
      ) as string[];
      if (!etiquetas.length) {
        erros.push(`${onde}: etiquetar com lista vazia`);
        return null;
      }
      if (etiquetas.length > LIMITE_ETIQUETAS) {
        erros.push(`${onde}: mais de ${LIMITE_ETIQUETAS} etiquetas`);
        return null;
      }
      const modo = (MODOS_ETIQUETA as readonly string[]).includes(bruto.modo) ? bruto.modo : "adicionar";
      return { tipo: "etiquetar", etiquetas, modo };
    }
    case "mudar_status": {
      if (!(STATUS_CONVERSA as readonly string[]).includes(bruto.status)) {
        erros.push(`${onde}: status invalido (${String(bruto.status)})`);
        return null;
      }
      return { tipo: "mudar_status", status: bruto.status };
    }
    case "atribuir_responsavel": {
      if (!Array.isArray(bruto.responsaveis) || !bruto.responsaveis.length) {
        erros.push(`${onde}: atribuir_responsavel sem responsaveis`);
        return null;
      }
      const responsaveis: { tipo: TipoResponsavel; id: string; nome: string }[] = [];
      for (const r of bruto.responsaveis) {
        if (!r || typeof r !== "object") continue;
        if (!(TIPOS_RESPONSAVEL as readonly string[]).includes(r.tipo)) continue;
        if (!ehTexto(r.id) || !r.id.trim()) continue;
        responsaveis.push({
          tipo: r.tipo,
          id: r.id.trim(),
          nome: (ehTexto(r.nome) ? r.nome.trim() : "").slice(0, 120) || r.id.trim(),
        });
      }
      if (!responsaveis.length) {
        erros.push(`${onde}: nenhum responsavel valido (tipo usuario|departamento + id)`);
        return null;
      }
      return { tipo: "atribuir_responsavel", responsaveis };
    }
    case "mover_funil": {
      const funil = ehTexto(bruto.funil) ? bruto.funil.trim() : "";
      if (!funil) {
        erros.push(`${onde}: mover_funil sem nome de funil`);
        return null;
      }
      if (funil.length > LIMITE_NOME_FUNIL) {
        erros.push(`${onde}: nome de funil acima de ${LIMITE_NOME_FUNIL} caracteres`);
        return null;
      }
      // `etapa` ausente NAO vira "sair do funil" por acidente: sair e explicito
      // (etapa: null). Ausente e erro — o silencio aqui apagaria a etapa da
      // conversa achando que estava so movendo.
      if (bruto.etapa === undefined) {
        erros.push(`${onde}: mover_funil precisa de etapa (nome) ou etapa: null pra SAIR do funil`);
        return null;
      }
      if (bruto.etapa === null) return { tipo: "mover_funil", funil, etapa: null };
      const etapa = ehTexto(bruto.etapa) ? bruto.etapa.trim() : "";
      if (!etapa) {
        erros.push(`${onde}: mover_funil com etapa vazia (use etapa: null pra sair do funil)`);
        return null;
      }
      if (etapa.length > LIMITE_NOME_FUNIL) {
        erros.push(`${onde}: nome de etapa acima de ${LIMITE_NOME_FUNIL} caracteres`);
        return null;
      }
      return { tipo: "mover_funil", funil, etapa };
    }
    case "espera": {
      const seg = Number(bruto.segundos);
      if (!Number.isFinite(seg) || seg < 0 || seg > LIMITE_ESPERA_SEG) {
        erros.push(`${onde}: espera fora do intervalo 0..${LIMITE_ESPERA_SEG}s`);
        return null;
      }
      // `pular_fim_de_semana` exige booleano de verdade quando presente: um
      // "true" em texto ligaria a regra e um 0 a desligaria, os dois em
      // silencio — e o efeito e a mensagem cair (ou nao) no sabado do cliente.
      if (bruto.pular_fim_de_semana !== undefined && typeof bruto.pular_fim_de_semana !== "boolean") {
        erros.push(`${onde}: pular_fim_de_semana precisa ser true ou false`);
        return null;
      }
      const espera: Extract<Acao, { tipo: "espera" }> = { tipo: "espera", segundos: Math.round(seg) };
      if (bruto.pular_fim_de_semana === true) espera.pular_fim_de_semana = true;
      return espera;
    }
    case "definir_contexto": {
      const chave = chaveDeContexto(bruto.chave);
      if (!chave) {
        erros.push(`${onde}: definir_contexto sem chave valida (ate ${LIMITE_CHAVE_CONTEXTO} chars, sem quebra de linha)`);
        return null;
      }
      // valor VAZIO e legitimo (marcar a chave sem conteudo); o que nao pode e
      // nao ser texto — numero/objeto viraria "[object Object]" na conversa
      if (bruto.valor !== undefined && !ehTexto(bruto.valor)) {
        erros.push(`${onde}: definir_contexto com valor que nao e texto`);
        return null;
      }
      const valor = ehTexto(bruto.valor) ? bruto.valor : "";
      if (valor.length > LIMITE_VALOR_CONTEXTO) {
        erros.push(`${onde}: valor de contexto acima de ${LIMITE_VALOR_CONTEXTO} caracteres`);
        return null;
      }
      return { tipo: "definir_contexto", chave, valor };
    }
    case "limpar_contexto": {
      const chave = chaveDeContexto(bruto.chave);
      if (!chave) {
        erros.push(`${onde}: limpar_contexto sem chave valida`);
        return null;
      }
      return { tipo: "limpar_contexto", chave };
    }
    // FRENTE W (card 86ak85bmw): anexo da biblioteca.
    case "anexar_biblioteca": {
      // A chave e validada por FORMA aqui (o mesmo formato de lib/anexos.ts, que
      // e o dono da regra) e a EXISTENCIA do item so se confere no banco, na hora
      // de executar. Validar existencia no schema seria impossivel — o formato
      // canonico e portatil entre instalacoes, e um fluxo exportado nao carrega o
      // acervo com ele.
      const anexo = ehTexto(bruto.anexo) ? bruto.anexo.trim().toLowerCase() : "";
      if (!RE_CHAVE_ANEXO.test(anexo)) {
        erros.push(
          `${onde}: anexar_biblioteca precisa da chave do arquivo (letras minusculas, numeros, - e _, ate ${LIMITE_CHAVE_ANEXO})`
        );
        return null;
      }
      // legenda AUSENTE e legitima (manda o arquivo sem texto). O que nao pode e
      // vir com tipo errado: um objeto viraria "[object Object]" na conversa.
      if (bruto.legenda !== undefined && !ehTexto(bruto.legenda)) {
        erros.push(`${onde}: legenda do anexo precisa ser texto`);
        return null;
      }
      const legenda = ehTexto(bruto.legenda) ? bruto.legenda : "";
      if (legenda.length > LIMITE_LEGENDA_ANEXO) {
        erros.push(`${onde}: legenda do anexo acima de ${LIMITE_LEGENDA_ANEXO} caracteres`);
        return null;
      }
      const acao: Extract<Acao, { tipo: "anexar_biblioteca" }> = { tipo: "anexar_biblioteca", anexo };
      if (legenda.trim()) acao.legenda = legenda;
      return acao;
    }
    // ————————————————————————————————————————————————————————— FRENTE Y
    case "perguntar_opcoes": {
      const p = bruto.params;
      if (!p || typeof p !== "object" || Array.isArray(p)) {
        erros.push(`${onde}: perguntar_opcoes sem params (a pergunta e as opcoes)`);
        return null;
      }
      if (!(TIPOS_PERGUNTA as readonly string[]).includes(p.tipo)) {
        erros.push(`${onde}: perguntar_opcoes com tipo invalido (use ${TIPOS_PERGUNTA.join(" ou ")})`);
        return null;
      }
      const corpo = ehTexto(p.texto) ? p.texto.trim() : "";
      if (!corpo) {
        erros.push(`${onde}: perguntar_opcoes sem a pergunta (params.texto)`);
        return null;
      }
      if (corpo.length > LIMITE_TEXTO) {
        erros.push(`${onde}: a pergunta passa de ${LIMITE_TEXTO} caracteres`);
        return null;
      }
      const rotulo = (v: unknown) => (ehTexto(v) ? v.trim() : "");
      const titulo = rotulo(p.titulo);
      const rodape = rotulo(p.rodape);
      const botao = rotulo(p.botao_lista);
      for (const [nome, valor] of [
        ["titulo", titulo],
        ["rodape", rodape],
        ["botao_lista", botao],
      ] as const) {
        if (valor.length > LIMITE_ROTULO_PERGUNTA) {
          erros.push(`${onde}: ${nome} da pergunta passa de ${LIMITE_ROTULO_PERGUNTA} caracteres`);
          return null;
        }
      }
      if (!Array.isArray(p.opcoes)) {
        erros.push(`${onde}: perguntar_opcoes sem lista de opcoes`);
        return null;
      }
      const opcoes: OpcaoPergunta[] = [];
      for (const o of p.opcoes) {
        // opcao como string nua e aceita (o formulario e o conversor produzem as
        // duas formas); linha em branco e AUSENCIA, nao erro — igual `etiquetar`
        const t = ehTexto(o) ? o.trim() : rotulo((o as any)?.titulo);
        if (!t) continue;
        if (t.length > LIMITE_ROTULO_PERGUNTA) {
          erros.push(`${onde}: o titulo de uma opcao passa de ${LIMITE_ROTULO_PERGUNTA} caracteres`);
          return null;
        }
        const d = rotulo((o as any)?.descricao);
        if (d.length > LIMITE_ROTULO_PERGUNTA) {
          erros.push(`${onde}: a descricao da opcao "${t}" passa de ${LIMITE_ROTULO_PERGUNTA} caracteres`);
          return null;
        }
        opcoes.push(d ? { titulo: t, descricao: d } : { titulo: t });
      }
      if (opcoes.length < MIN_OPCOES_PERGUNTA) {
        erros.push(`${onde}: uma pergunta com opcoes precisa de pelo menos ${MIN_OPCOES_PERGUNTA}`);
        return null;
      }
      if (opcoes.length > LIMITE_OPCOES_PERGUNTA) {
        erros.push(`${onde}: mais de ${LIMITE_OPCOES_PERGUNTA} opcoes na pergunta`);
        return null;
      }
      return {
        tipo: "perguntar_opcoes",
        params: {
          tipo: p.tipo,
          texto: corpo,
          ...(titulo ? { titulo } : {}),
          ...(rodape ? { rodape } : {}),
          ...(botao ? { botao_lista: botao } : {}),
          opcoes,
        },
      };
    }
  }
}

// Chave de contexto NORMALIZADA. A mesma funcao vale pra acao e pra condicao —
// senao o fluxo grava "URA " e a condicao procura "URA" e nunca casa (bug que
// o usuario final NAO tem como enxergar).
export function chaveDeContexto(bruto: unknown): string | null {
  if (!ehTexto(bruto)) return null;
  const chave = bruto.trim();
  if (!chave || chave.length > LIMITE_CHAVE_CONTEXTO) return null;
  // quebra de linha e caractere de controle fora: chave e identificador, nao texto
  if (/[\u0000-\u001f]/.test(chave)) return null;
  return chave;
}

// Contexto vindo do banco (jsonb) NORMALIZADO pra Record<string,string>.
// Valor de contexto e sempre TEXTO: o jsonb aceita numero/booleano/objeto (dado
// gravado por fora, ou por uma versao futura), e devolver isso cru faria a
// condicao comparar "1" com 1 e nunca casar. Chave invalida e valor que nao vira
// texto SOMEM da leitura — nao existe contexto pela metade.
export function normalizarContexto(bruto: unknown): Record<string, string> {
  // Object.create(null) e proposital: o mapa vem de jsonb, e jsonb aceita a
  // chave "__proto__". Num objeto literal, gravar essa chave nao cria
  // propriedade — a variavel sumiria em silencio, e uma condicao sobre ela
  // decidiria por falso pra sempre. Sem prototipo, ela e chave como outra
  // qualquer.
  const saida: Record<string, string> = Object.create(null);
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return saida;
  for (const [k, v] of Object.entries(bruto as Record<string, unknown>)) {
    const chave = chaveDeContexto(k);
    if (!chave) continue;
    if (typeof v === "string") saida[chave] = v;
    else if (typeof v === "number" || typeof v === "boolean") saida[chave] = String(v);
  }
  return saida;
}

/**
 * CHAVE DE CAMPO DA FICHA, normalizada — ESPELHO de
 * `chaveNormalizadaDeCampo` (lib/fluxo/variaveis.ts). MUDOU LA, MUDA AQUI.
 *
 * POR QUE UM ESPELHO, E NAO UM IMPORT: este arquivo tem ZERO import de proposito
 * (e a garantia esta travada em `scripts/prova-motor-fila.ts`, que compara a
 * lista de imports com `[]`) — ele e o contrato publico do formato e roda em node
 * solto. Importar `./variaveis.ts` quebraria essa guarda.
 * `scripts/prova-campos.ts` prende as DUAS implementacoes: alimenta as duas com o
 * mesmo corpus de nomes hostis e reprova se divergirem em UM caso. Espelho com
 * guarda de igualdade e o padrao da casa (`segundosUteis` em TS x
 * `mensageria.segundos_uteis` em SQL; `CANAIS_BUILTIN` em
 * scripts/instalar/plano.mjs x lib/canais.ts).
 *
 * POR QUE NORMALIZADA, quando a chave de `contexto` casa por igualdade EXATA: sao
 * dois armazens diferentes com numeros de leitores diferentes. `contexto` e
 * escrito e lido so pela automacao (`mensageria.conversa_contexto`), e a
 * igualdade exata mantem a resposta rapida e a condicao concordando. A FICHA tem
 * DOIS leitores que ja existem — a condicao (aqui) e a variavel
 * `!campo.<chave>` das respostas rapidas, que SEMPRE normalizou, porque token de
 * variavel nao carrega espaco nem acento. Dois leitores do MESMO armazem que
 * discordam sobre qual chave e qual e o defeito: `!campo.cnpj` acharia o valor e
 * a condicao sobre "CNPJ" nao. Entao a ficha normaliza nos dois lados.
 */
export function chaveDeFicha(bruto: unknown): string {
  return String(bruto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Comparacao de texto do painel: sem caixa, sem acento, sem espaco sobrando.
// Escolha DECLARADA: quem monta condicao clicando em blocos nao tem como saber
// que "Aluno" e "aluno" sao coisas diferentes. Vale pra TODOS os campos.
export function normalizarValorCondicao(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// --------------------------------------------------- validacao de condicao
function validarCondicaoInterna(
  bruto: any,
  onde: string,
  erros: string[],
  // profundidade vai por VALOR (cada ramo tem a sua) e o contador de termos vai
  // por REFERENCIA (e um total do ARVORE inteira). Isto ja foi bug: passar um
  // objeto novo em cada recursao fazia LIMITE_TERMOS_CONDICAO virar codigo morto
  // — uma arvore com 500 comparacoes passava batido.
  profundidade: number,
  contador: { termos: number }
): Condicao | null {
  if (profundidade > LIMITE_PROFUNDIDADE_CONDICAO) {
    erros.push(`${onde}: condicao com mais de ${LIMITE_PROFUNDIDADE_CONDICAO} niveis de aninhamento`);
    return null;
  }
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) {
    erros.push(`${onde}: condicao precisa ser um objeto`);
    return null;
  }
  const tipo = bruto.tipo;

  if (tipo === "e" || tipo === "ou") {
    if (!Array.isArray(bruto.condicoes) || !bruto.condicoes.length) {
      erros.push(`${onde}: condicao "${tipo}" sem lista de condicoes`);
      return null;
    }
    const filhas: Condicao[] = [];
    for (const [i, f] of bruto.condicoes.entries()) {
      const c = validarCondicaoInterna(f, `${onde}.${tipo}[${i}]`, erros, profundidade + 1, contador);
      if (!c) return null;
      filhas.push(c);
    }
    return { tipo, condicoes: filhas };
  }

  if (tipo === "nao") {
    const c = validarCondicaoInterna(bruto.condicao, `${onde}.nao`, erros, profundidade + 1, contador);
    if (!c) return null;
    return { tipo: "nao", condicao: c };
  }

  if (tipo !== "comparacao") {
    erros.push(`${onde}: tipo de condicao desconhecido (${String(tipo)}) — use e|ou|nao|comparacao`);
    return null;
  }

  contador.termos++;
  if (contador.termos > LIMITE_TERMOS_CONDICAO) {
    erros.push(`${onde}: condicao com mais de ${LIMITE_TERMOS_CONDICAO} comparacoes`);
    return null;
  }

  if (!(CAMPOS_CONDICAO as readonly string[]).includes(bruto.campo)) {
    erros.push(`${onde}: campo de condicao desconhecido (${String(bruto.campo)})`);
    return null;
  }
  if (!(OPERADORES_CONDICAO as readonly string[]).includes(bruto.operador)) {
    erros.push(`${onde}: operador de condicao desconhecido (${String(bruto.operador)})`);
    return null;
  }
  const campo = bruto.campo as CampoCondicao;
  const operador = bruto.operador as OperadorCondicao;
  const semValor = OPERADORES_SEM_VALOR.includes(operador);

  const cmp: Comparacao = { tipo: "comparacao", campo, operador };

  if (campo === "contexto") {
    const chave = chaveDeContexto(bruto.chave);
    if (!chave) {
      erros.push(`${onde}: condicao de contexto precisa de chave (a variavel da conversa)`);
      return null;
    }
    cmp.chave = chave;
  } else if (campo === "ficha") {
    // A chave e o NOME do campo personalizado, como o construtor de ficha o
    // gravou. Guardada como veio (o editor a escolhe de um select, entao ela e o
    // nome do catalogo); o CASAMENTO e por forma normalizada — ver `chaveDeFicha`.
    const chave = chaveDeContexto(bruto.chave);
    if (!chave || !chaveDeFicha(chave)) {
      erros.push(`${onde}: condicao de ficha precisa de chave (qual campo personalizado do contato)`);
      return null;
    }
    cmp.chave = chave;
  } else if (bruto.chave !== undefined) {
    erros.push(`${onde}: so condicao de contexto e de ficha usam chave`);
    return null;
  }

  if (campo === "etapa") {
    // etapa e SEMPRE resolvida dentro de um funil (nome de etapa se repete
    // entre funis — 11 dos 70 na conta medida). Nome solto seria chute.
    const funil = ehTexto(bruto.funil) ? bruto.funil.trim() : "";
    if (!funil) {
      erros.push(`${onde}: condicao de etapa precisa do nome do FUNIL (nome de etapa se repete entre funis)`);
      return null;
    }
    if (funil.length > LIMITE_NOME_FUNIL) {
      erros.push(`${onde}: nome de funil acima de ${LIMITE_NOME_FUNIL} caracteres`);
      return null;
    }
    cmp.funil = funil;
  } else if (bruto.funil !== undefined) {
    erros.push(`${onde}: so condicao de etapa usa funil`);
    return null;
  }

  if (semValor) {
    if (bruto.valor !== undefined) {
      erros.push(`${onde}: operador ${operador} nao leva valor`);
      return null;
    }
    return cmp;
  }
  if (!ehTexto(bruto.valor)) {
    erros.push(`${onde}: operador ${operador} precisa de valor (texto)`);
    return null;
  }
  if (bruto.valor.length > LIMITE_VALOR_CONDICAO) {
    erros.push(`${onde}: valor de condicao acima de ${LIMITE_VALOR_CONDICAO} caracteres`);
    return null;
  }
  // valor VAZIO nao e comparacao, e pergunta de presenca: manda usar existe/
  // nao_existe em vez de casar com "" por acidente.
  // A checagem e feita no valor JA NORMALIZADO porque a normalizacao tira acento
  // (NFD + corte das marcas combinantes): um valor feito SO de marcas
  // combinantes passa no `.trim()` e vira "" na comparacao — e `contem ""` casa
  // com QUALQUER texto, ou seja, a condicao viraria sempre-verdadeira.
  if (!bruto.valor.trim() || !normalizarValorCondicao(bruto.valor)) {
    erros.push(`${onde}: valor vazio — use o operador existe/nao_existe pra perguntar por presenca`);
    return null;
  }
  cmp.valor = bruto.valor;
  return cmp;
}

// Valida e normaliza uma condicao solta (a mesma porta do validarFluxo, exposta
// pra quem monta condicao fora de um fluxo — conversor, rota, editor).
export function validarCondicao(
  bruto: unknown
): { ok: true; condicao: Condicao } | { ok: false; erros: string[] } {
  const erros: string[] = [];
  const c = validarCondicaoInterna(bruto, "condicao", erros, 1, { termos: 0 });
  if (!c || erros.length) return { ok: false, erros: erros.length ? erros : ["condicao invalida"] };
  return { ok: true, condicao: c };
}

// --------------------------------------------------- avaliacao de condicao
// Os fatos da conversa que a condicao consulta. Coletar isto e trabalho do
// motor (tem banco); DECIDIR e trabalho desta funcao, que e pura e por isso
// provavel sem banco, sem env e sem rede.
export type FatosConversa = {
  /** texto da ultima mensagem RECEBIDA na conversa */
  texto?: string | null;
  /** status da conversa (aberto|atendimento|concluido|aguardando) */
  status?: string | null;
  /** etiquetas da conversa */
  etiquetas?: string[];
  /** contexto da conversa: pares chave/valor */
  contexto?: Record<string, string>;
  /**
   * CAMPOS PERSONALIZADOS DA FICHA do contato (Frente X), com a chave COMO ESTA
   * GRAVADA — quem normaliza e `valoresDoCampo`, num lugar so.
   *
   * Mapa AUSENTE (undefined) != mapa VAZIO: ausente e "ninguem foi buscar" (ou a
   * leitura falhou, e ai o motor poe o motivo em `indisponiveis`), vazio e "a
   * conversa nao tem valor nenhum na ficha". A diferenca importa porque o
   * avaliador e fail-closed e "nao tentei" nao pode virar "nao bateu" sem alguem
   * ver — a mesma regra que `intencoes` carrega.
   */
  ficha?: Record<string, string>;
  /** etapas de funil em que a conversa esta (N:N — pode estar em varias) */
  etapas?: { funil: string; etapa: string }[];
  /**
   * NOMES das intencoes reconhecidas na ultima mensagem RECEBIDA.
   *
   * Quem reconhece e `lib/fluxo/intencoes.ts` (local, deterministico, sem API
   * paga); aqui chega o resultado. Lista vazia = nenhuma intencao bateu, e o
   * campo AUSENTE (undefined) = ninguem tentou reconhecer — a diferenca importa
   * porque o avaliador e fail-closed e "nao tentei" nao pode virar "nao bateu"
   * sem alguem ver. Quem coleta e o motor, que trata a indisponibilidade.
   */
  intencoes?: string[];
};

// Valores do fato para UM campo. Lista vazia = campo AUSENTE.
function valoresDoCampo(cmp: Comparacao, fatos: FatosConversa): string[] {
  switch (cmp.campo) {
    case "texto":
      return ehTexto(fatos.texto) && fatos.texto.trim() ? [fatos.texto] : [];
    case "status":
      return ehTexto(fatos.status) && fatos.status.trim() ? [fatos.status] : [];
    case "etiqueta":
      return (fatos.etiquetas ?? []).filter((e) => ehTexto(e) && e.trim());
    case "contexto": {
      // CHAVE casa por igualdade EXATA (caixa e acento contam) — o VALOR e que
      // normaliza. Chave e identificador vindo da automacao; valor e conteudo
      // digitado por gente. Ver docs/fluxo-canonico.md.
      // `hasOwn` protege o caso do mapa que chegou como objeto literal (fixture,
      // jsonb parseado por fora): sem ele, uma condicao sobre a chave
      // "constructor" leria a funcao herdada do prototipo em vez de "ausente".
      const mapa = fatos.contexto;
      if (!mapa || !Object.prototype.hasOwnProperty.call(mapa, cmp.chave!)) return [];
      const v = mapa[cmp.chave!];
      return ehTexto(v) && v.trim() ? [v] : [];
    }
    case "ficha": {
      // CHAVE POR FORMA NORMALIZADA (ver `chaveDeFicha`): a ficha tem dois
      // leitores — esta condicao e o `!campo.<chave>` das respostas rapidas — e
      // dois leitores do mesmo armazem que discordam sobre a chave e o defeito.
      // O VALOR normaliza na comparacao, como em todo campo.
      const mapa = fatos.ficha;
      if (!mapa) return [];
      const alvo = chaveDeFicha(cmp.chave ?? "");
      if (!alvo) return [];
      // AMBIGUIDADE NAO CASA: se duas chaves gravadas normalizam pro mesmo alvo
      // ("CNPJ" e "cnpj", que o sync do ChatGuru consegue criar), escolher uma
      // seria decidir a condicao por ordem de iteracao do jsonb. Aqui as duas
      // entram na lista e a comparacao segue a regra 3 (existencia no positivo,
      // ausencia no negativo) — que e o comportamento honesto: "algum campo com
      // esse nome vale X".
      const valores: string[] = [];
      for (const [k, v] of Object.entries(mapa)) {
        if (chaveDeFicha(k) !== alvo) continue;
        if (ehTexto(v) && v.trim()) valores.push(v);
      }
      return valores;
    }
    case "intencao":
      return (fatos.intencoes ?? []).filter((i) => ehTexto(i) && i.trim());
    case "etapa": {
      const alvoFunil = normalizarValorCondicao(cmp.funil ?? "");
      return (fatos.etapas ?? [])
        .filter((e) => e && normalizarValorCondicao(String(e.funil ?? "")) === alvoFunil)
        .map((e) => String(e.etapa ?? ""))
        .filter((e) => e.trim());
    }
  }
}

// AVALIADOR PURO. Regras que valem a pena ler antes de mexer:
//
// 1. FAIL-CLOSED: campo AUSENTE faz qualquer comparacao de VALOR dar `false` —
//    inclusive `diferente` e `nao_contem`. Comparar exige ter o que comparar.
// 2. Por isso `diferente` NAO e a mesma coisa que `nao(igual)` quando o campo
//    esta ausente: `diferente` da false (nao ha valor), `nao(igual)` da true
//    (a igualdade nao vale). Os dois existem de proposito, e e assim que a
//    importacao consegue ser fiel: no ChatGuru `not $x=='y'` (o caso comum,
//    409 expressoes) e negacao do RESULTADO, e vira `nao(igual)`; `$x!='y'`
//    (15 expressoes) vira `diferente`.
// 3. Campo com VARIOS valores (etiqueta, etapa) casa por EXISTENCIA no positivo
//    (alguma etiqueta igual a X) e por AUSENCIA no negativo (nenhuma etiqueta
//    igual a X) — que e como pessoa le "a conversa nao esta etiquetada como X".
// 4. Comparacao ignora caixa, acento e espaco duplicado (normalizarValorCondicao).
export function avaliarCondicao(condicao: Condicao, fatos: FatosConversa): boolean {
  switch (condicao.tipo) {
    case "e":
      return condicao.condicoes.every((c) => avaliarCondicao(c, fatos));
    case "ou":
      return condicao.condicoes.some((c) => avaliarCondicao(c, fatos));
    case "nao":
      return !avaliarCondicao(condicao.condicao, fatos);
    case "comparacao": {
      const valores = valoresDoCampo(condicao, fatos);
      const presente = valores.length > 0;
      if (condicao.operador === "existe") return presente;
      if (condicao.operador === "nao_existe") return !presente;
      if (!presente) return false; // fail-closed
      const alvo = normalizarValorCondicao(condicao.valor ?? "");
      const achou = valores.some((v) => {
        const atual = normalizarValorCondicao(v);
        switch (condicao.operador) {
          case "igual":
          case "diferente":
            return atual === alvo;
          case "contem":
          case "nao_contem":
            return atual.includes(alvo);
          case "comeca_com":
            return atual.startsWith(alvo);
          default:
            return false;
        }
      });
      return condicao.operador === "diferente" || condicao.operador === "nao_contem" ? !achou : achou;
    }
  }
}

// Valida e NORMALIZA um fluxo bruto (do banco, de um conversor, de um POST).
// Nunca lanca: devolve ok:false com a lista de erros legivel.
export function validarFluxo(bruto: unknown): ResultadoValidacao {
  const erros: string[] = [];
  const b = bruto as any;
  if (!b || typeof b !== "object" || Array.isArray(b)) {
    return { ok: false, erros: ["fluxo precisa ser um objeto"] };
  }
  if (!ehTexto(b.id) || !ID_RE.test(b.id)) erros.push("id invalido (1-64 chars [A-Za-z0-9_.:-])");
  const nome = ehTexto(b.nome) ? b.nome.trim() : "";
  if (!nome) erros.push("nome obrigatorio");
  if (b.tipo !== "macro" && b.tipo !== "gatilho") erros.push("tipo precisa ser macro ou gatilho");
  const versao = Number.isFinite(Number(b.versao)) ? Math.round(Number(b.versao)) : NaN;
  if (!Number.isFinite(versao) || versao < 1) erros.push("versao precisa ser inteiro >= 1");
  if (!Array.isArray(b.nos) || !b.nos.length) erros.push("nos precisa ser lista nao vazia");
  if (Array.isArray(b.nos) && b.nos.length > LIMITE_NOS) erros.push(`mais de ${LIMITE_NOS} nos`);

  const nos: No[] = [];
  const ids = new Set<string>();
  for (const [i, bn] of (Array.isArray(b.nos) ? b.nos : []).entries()) {
    const onde = `no[${i}]`;
    if (!bn || typeof bn !== "object") {
      erros.push(`${onde}: precisa ser objeto`);
      continue;
    }
    if (!ehTexto(bn.id) || !ID_RE.test(bn.id)) {
      erros.push(`${onde}: id invalido`);
      continue;
    }
    if (ids.has(bn.id)) {
      erros.push(`${onde}: id repetido (${bn.id})`);
      continue;
    }
    ids.add(bn.id);
    const tipo: TipoNo = bn.tipo;
    if (!["acao", "condicao", "espera", "gatilho"].includes(tipo)) {
      erros.push(`${onde}: tipo de no invalido (${String(bn.tipo)})`);
      continue;
    }
    const no: No = { id: bn.id, tipo };
    if (ehTexto(bn.rotulo) && bn.rotulo.trim()) no.rotulo = bn.rotulo.trim().slice(0, 200);

    // APROVACAO: booleano de verdade ou RECUSA. Normalizar "truthy" aqui seria o
    // pior dos dois mundos — um valor torto poderia ligar aprovacao num fluxo que
    // roda hoje (travando a operacao) OU desliga-la num passo que pede aval
    // (mandando a mensagem sensivel sem ninguem ver). Nao ha default seguro pra
    // adivinhar, entao o fluxo nao grava.
    if (bn.aprovacao !== undefined) {
      if (typeof bn.aprovacao !== "boolean") {
        erros.push(`${onde}(${bn.id}): aprovacao precisa ser true ou false`);
        continue;
      }
      if (bn.aprovacao) no.aprovacao = true;
    }

    // DESLIGADO: mesma disciplina da aprovacao — booleano de verdade ou recusa.
    if (bn.desligado !== undefined) {
      if (typeof bn.desligado !== "boolean") {
        erros.push(`${onde}(${bn.id}): desligado precisa ser true ou false`);
        continue;
      }
      if (bn.desligado) no.desligado = true;
    }

    if (tipo === "acao" || tipo === "espera") {
      const acao = validarAcao(bn.acao, `${onde}(${bn.id})`, erros);
      if (!acao) continue;
      // "espera" e um no de leitura mais facil pro editor visual; e obrigado a
      // carregar a acao de espera, senao vira dois jeitos de dizer a mesma coisa
      if (tipo === "espera" && acao.tipo !== "espera") {
        erros.push(`${onde}(${bn.id}): no de tipo espera precisa carregar acao espera`);
        continue;
      }
      no.acao = acao;
    } else if (tipo === "condicao") {
      // Duas formas convivem: a ESTRUTURADA (`condicao`), que a v1 avalia, e a
      // ramificacao por `ramos`, que so o motor de gatilho (v2) executa.
      const temCondicao = bn.condicao !== undefined;
      const temRamos = bn.ramos !== undefined;
      if (!temCondicao && !temRamos) {
        erros.push(`${onde}(${bn.id}): no de condicao sem condicao nem ramos`);
        continue;
      }
      if (temCondicao) {
        const v = validarCondicao(bn.condicao);
        if (!v.ok) {
          for (const e of v.erros) erros.push(`${onde}(${bn.id}): ${e}`);
          continue;
        }
        no.condicao = v.condicao;
      }
      if (temRamos) {
        if (!Array.isArray(bn.ramos) || !bn.ramos.length) {
          erros.push(`${onde}(${bn.id}): ramos precisa ser lista nao vazia`);
          continue;
        }
        const ramos: { quando: string; condicao?: Condicao; proximo: string }[] = [];
        let ramoInvalido = false;
        for (const [j, r] of bn.ramos.entries()) {
          if (!r || typeof r !== "object") continue;
          if (!ehTexto(r.quando) || !ehTexto(r.proximo)) continue;
          const ramo: { quando: string; condicao?: Condicao; proximo: string } = {
            quando: r.quando,
            proximo: r.proximo,
          };
          if (r.condicao !== undefined) {
            const v = validarCondicao(r.condicao);
            if (!v.ok) {
              for (const e of v.erros) erros.push(`${onde}(${bn.id}).ramo[${j}]: ${e}`);
              ramoInvalido = true;
              continue;
            }
            ramo.condicao = v.condicao;
          }
          ramos.push(ramo);
        }
        if (ramoInvalido) continue;
        if (!ramos.length) {
          erros.push(`${onde}(${bn.id}): nenhum ramo valido ({quando, proximo})`);
          continue;
        }
        no.ramos = ramos;
      }
    }

    if (bn.proximo !== undefined) {
      if (!ehTexto(bn.proximo) || !ID_RE.test(bn.proximo)) {
        erros.push(`${onde}(${bn.id}): proximo invalido`);
        continue;
      }
      no.proximo = bn.proximo;
    }
    nos.push(no);
  }

  // referencias: proximo/ramos tem que apontar pra no que existe
  for (const n of nos) {
    if (n.proximo && !ids.has(n.proximo)) erros.push(`no(${n.id}): proximo aponta pra no inexistente (${n.proximo})`);
    for (const r of n.ramos ?? []) {
      if (!ids.has(r.proximo)) erros.push(`no(${n.id}): ramo aponta pra no inexistente (${r.proximo})`);
    }
  }

  // MACRO e uma lista ordenada disparada a mao: sem gatilho e sem RAMIFICACAO.
  // Desde a v1 de condicao ele aceita no de condicao ESTRUTURADA — que nao
  // ramifica: verdadeira segue pro `proximo`, falsa PARA o macro ali. Quem
  // escolhe entre caminhos (ramos) e fluxo de tipo "gatilho", motor v2.
  if (b.tipo === "macro") {
    for (const n of nos) {
      if (n.tipo === "gatilho") {
        erros.push(`no(${n.id}): macro nao aceita no de tipo ${n.tipo}`);
        continue;
      }
      if (n.tipo !== "condicao") continue;
      if (n.ramos) {
        erros.push(
          `no(${n.id}): macro nao aceita no de tipo condicao com ramificacao (ramos) — no macro a condicao so decide seguir ou parar`
        );
      }
      if (!n.condicao) {
        erros.push(`no(${n.id}): no de condicao de macro precisa da condicao estruturada`);
      }
    }
  }

  // LIMITES por conversa (Frente P). Ausente = sem limite; presente e torto =
  // ERRO, nunca "sem limite" em silencio — limite que desaparece calado e o
  // mesmo defeito do freio que falha aberto (licao do disparo).
  let limites: LimitesFluxo | undefined;
  if (b.limites !== undefined) {
    const l = b.limites;
    if (!l || typeof l !== "object" || Array.isArray(l)) {
      erros.push("limites precisa ser um objeto {maximo_por_conversa, intervalo_minimo_segundos}");
    } else {
      const parcial: LimitesFluxo = { ...LIMITES_PADRAO };
      if (l.maximo_por_conversa !== undefined && l.maximo_por_conversa !== null) {
        const n = Number(l.maximo_por_conversa);
        if (!Number.isInteger(n) || n < 1 || n > LIMITE_MAXIMO_POR_CONVERSA) {
          erros.push(
            `limites.maximo_por_conversa precisa ser inteiro de 1 a ${LIMITE_MAXIMO_POR_CONVERSA} (ou null pra sem limite)`
          );
        } else {
          parcial.maximo_por_conversa = n;
        }
      }
      if (l.intervalo_minimo_segundos !== undefined) {
        const n = Number(l.intervalo_minimo_segundos);
        if (!Number.isFinite(n) || n < 0 || n > LIMITE_INTERVALO_MINIMO_SEG) {
          erros.push(`limites.intervalo_minimo_segundos fora do intervalo 0..${LIMITE_INTERVALO_MINIMO_SEG}`);
        } else {
          parcial.intervalo_minimo_segundos = Math.round(n);
        }
      }
      limites = parcial;
    }
  }

  let origem: Origem | undefined;
  if (b.origem !== undefined) {
    const o = b.origem;
    if (!o || typeof o !== "object" || !ehTexto(o.ferramenta) || !ehTexto(o.id_original)) {
      erros.push("origem precisa ter ferramenta e id_original (texto)");
    } else {
      origem = {
        ferramenta: o.ferramenta.trim().slice(0, 60),
        id_original: o.id_original.trim().slice(0, 120),
        ressalvas: Array.isArray(o.ressalvas) ? o.ressalvas.filter(ehTexto).map((r: string) => r.slice(0, 300)) : [],
      };
    }
  }

  if (erros.length) return { ok: false, erros };
  const fluxo: Fluxo = { id: b.id, nome, tipo: b.tipo, versao, nos };
  if (limites) fluxo.limites = limites;
  if (origem) fluxo.origem = origem;
  if (ehTexto(b.descricao) && b.descricao.trim()) fluxo.descricao = b.descricao.trim().slice(0, 1000);
  return { ok: true, fluxo };
}

// Ordem de execucao de um MACRO: caminha do primeiro no seguindo `proximo`.
// `proximo` ausente termina o macro — no solto depois disso NAO roda (o que
// e proposital: quem edita fluxo tem que ver a corrente inteira).
// Ciclo e detectado e cortado, nunca vira laco infinito no servidor.
export function ordemDeExecucao(fluxo: Fluxo): No[] {
  const porId = new Map(fluxo.nos.map((n) => [n.id, n]));
  const ordem: No[] = [];
  const vistos = new Set<string>();
  let atual: No | undefined = fluxo.nos[0];
  while (atual && !vistos.has(atual.id)) {
    vistos.add(atual.id);
    ordem.push(atual);
    atual = atual.proximo ? porId.get(atual.proximo) : undefined;
  }
  return ordem;
}

/**
 * Este passo esta LIGADO?
 *
 * Existe como funcao (e nao como `!no.desligado` espalhado) porque a pergunta e
 * feita em cinco lugares — percurso inline, fila, preflight, contagem de espera e
 * simulador — e regra em cinco lugares e regra que diverge.
 */
export function noAtivo(no: No): boolean {
  return no.desligado !== true;
}

/**
 * Os passos que REALMENTE rodam: a corrente, sem os desligados.
 *
 * `ordemDeExecucao` continua devolvendo a corrente INTEIRA de proposito — e dela
 * que a tela e o editor precisam (passo desligado tem que aparecer, senao ninguem
 * consegue religa-lo).
 */
export function passosQueRodam(fluxo: Fluxo): No[] {
  return ordemDeExecucao(fluxo).filter(noAtivo);
}

// Tipos das acoes na ordem da corrente. IGNORA no sem acao (condicao/gatilho
// existem no formato e nao carregam acao) — quem lista fluxo pra tela nao pode
// explodir por causa de um no legitimo que nao e acao.
export function acoesDoFluxo(fluxo: Fluxo): TipoAcao[] {
  // SEM os passos desligados: esta lista e "o que este macro vai fazer" (a tela
  // mostra antes de disparar, /api/macros). Incluir passo desligado prometeria
  // ao atendente uma mensagem que nao vai sair.
  return passosQueRodam(fluxo)
    .filter((n) => !!n.acao)
    .map((n) => n.acao!.tipo);
}

// Quais CAMPOS uma condicao consulta. E o que permite o motor buscar no banco
// so o fato que a condicao usa, em vez de montar a conversa inteira pra
// responder "a etiqueta X esta aqui?".
export function camposDaCondicao(c: Condicao, acc = new Set<CampoCondicao>()): Set<CampoCondicao> {
  if (c.tipo === "e" || c.tipo === "ou") c.condicoes.forEach((f) => camposDaCondicao(f, acc));
  else if (c.tipo === "nao") camposDaCondicao(c.condicao, acc);
  else acc.add(c.campo);
  return acc;
}

// Todas as chaves de contexto que o fluxo TOCA — as que ele grava/limpa e as
// que ele consulta em condicao. E o que a tela precisa pra mostrar "este fluxo
// usa as variaveis X, Y" sem o usuario abrir no a no. Percorre o fluxo inteiro
// (nao so a corrente): no fora da corrente ainda esta escrito no fluxo.
export function chavesDeContextoDoFluxo(fluxo: Fluxo): { grava: string[]; le: string[] } {
  const grava = new Set<string>();
  const le = new Set<string>();
  const visitar = (c: Condicao) => {
    if (c.tipo === "e" || c.tipo === "ou") c.condicoes.forEach(visitar);
    else if (c.tipo === "nao") visitar(c.condicao);
    else if (c.campo === "contexto" && c.chave) le.add(c.chave);
  };
  for (const n of fluxo.nos) {
    if (n.acao?.tipo === "definir_contexto" || n.acao?.tipo === "limpar_contexto") grava.add(n.acao.chave);
    if (n.condicao) visitar(n.condicao);
    for (const r of n.ramos ?? []) if (r.condicao) visitar(r.condicao);
  }
  return { grava: [...grava].sort(), le: [...le].sort() };
}

/** Os limites POR CONVERSA deste fluxo, ja com o default de "sem limite". */
export function limitesDoFluxo(fluxo: Fluxo): LimitesFluxo {
  return { ...LIMITES_PADRAO, ...(fluxo.limites ?? {}) };
}

/**
 * Acoes que ALCANCAM O CLIENTE — as que saem do painel e chegam na conversa.
 *
 * Sao tres (`enviar_texto`, `anexar_biblioteca` desde a FRENTE W e
 * `perguntar_opcoes` desde a FRENTE Y), e a lista existe pra crescer com o
 * formato (template WABA entra aqui quando entrar no schema). Tudo o mais da v1 e INTERNO e
 * reversivel: nota interna, etiqueta, status, funil, responsavel, contexto — o
 * cliente nao ve nada disso.
 *
 * FRENTE W (card 86ak85bmw): `anexar_biblioteca` ENTRA, e esta e a linha mais
 * importante daquela frente neste arquivo. Sem ela, a marca de aprovacao humana
 * (`no.aprovacao`) num passo que MANDA UM ARQUIVO pro cliente nao bloquearia
 * nada, e o preflight inline aceitaria rodar esse passo dentro da requisicao —
 * ou seja: o material sairia pro cliente sem o aval que o campo existe pra
 * exigir, exatamente o contorno que a Frente P fechou pro texto.
 */
/*
 * FRENTE Y: `perguntar_opcoes` entra aqui porque a pergunta CHEGA no celular do
 * cliente. Consequencias que vem de graca por estar nesta lista, e sao as
 * certas: ela exige envio cabeado no preflight, o aval humano vale nela, e o
 * modo `inline` recusa fluxo que pede aprovacao num passo desses.
 */
export const ACOES_QUE_ALCANCAM_CLIENTE: readonly Acao["tipo"][] = ["enviar_texto", "anexar_biblioteca", "perguntar_opcoes"];

/**
 * Este no manda algo pro CLIENTE?
 *
 * A pergunta decide onde a aprovacao humana tem sentido. Aprovar existe pra uma
 * PESSOA conferir antes de algo IRREVERSIVEL sair pra fora — e nota interna,
 * etiqueta e mudanca de status nao saem pra fora nem sao irreversiveis.
 */
export function alcancaCliente(no: No): boolean {
  const t = no.acao?.tipo;
  return !!t && ACOES_QUE_ALCANCAM_CLIENTE.includes(t);
}

/**
 * Nos da CORRENTE que exigem aprovacao humana.
 *
 * Percorre a corrente (nao o fluxo inteiro): no fora da corrente nao roda, e
 * dizer que o fluxo "pede aprovacao" por causa de um no solto faria a tela pedir
 * aval de um passo que nunca vai executar.
 *
 * Traz o campo COMO ESTA GRAVADO. Quem quer saber quais avais realmente valem usa
 * `nosComAvalQueImporta`.
 */
export function nosComAprovacao(fluxo: Fluxo): string[] {
  return passosQueRodam(fluxo)
    .filter((n) => n.aprovacao === true)
    .map((n) => n.id);
}

/**
 * Nos que exigem aprovacao E cuja acao alcanca o cliente — os avais que VALEM.
 *
 * APROVACAO SO E HONRADA ONDE ELA PROTEGE ALGUEM, e isso vale nos DOIS caminhos
 * (inline e fila) de proposito: regra honrada num caminho e ignorada no outro seria
 * pior que qualquer das duas escolhas.
 *
 * Por que nao honrar em toda acao: medido nos 33 backups da importacao, 796 dos 837
 * nos com `need_approval` eram NOTA INTERNA. Honrar todos travava 631 macros que
 * hoje rodam num clique — a fila de aprovacao nasceria dominada por anotacao
 * interna, e o supervisor aprovaria em massa sem ler, que e o fim de qualquer
 * portao de aprovacao. Os 52 avais que protegem mensagem pro cliente continuam
 * valendo integralmente.
 *
 * O campo NAO e apagado do fluxo: fica gravado, a tela explica que ali ele nao
 * bloqueia, e no dia em que o formato tiver mais acao que fala com o cliente ele
 * passa a valer sozinho.
 */
export function nosComAvalQueImporta(fluxo: Fluxo): string[] {
  return passosQueRodam(fluxo)
    .filter((n) => n.aprovacao === true && alcancaCliente(n))
    .map((n) => n.id);
}

export function esperaTotalSegundos(fluxo: Fluxo): number {
  // passo desligado nao espera: contar a espera de um no que nao roda faria a
  // fila recusar uma regua por causa de um atraso que ninguem vai cumprir
  return passosQueRodam(fluxo).reduce(
    (soma, n) => soma + (n.acao?.tipo === "espera" ? n.acao.segundos : 0),
    0
  );
}

// Motor que executa espera INLINE (dentro da requisicao) tem dois limites, e o
// segundo e o que costuma ser esquecido: nao adianta so limitar cada espera, o
// que estoura o tempo da requisicao e a SOMA. Puro de proposito, pra ser
// exercitado sem banco. Devolve o motivo da recusa, ou null.
export function problemaDeEspera(
  fluxo: Fluxo,
  limites: { maxInline: number; maxTotal: number }
): string | null {
  let total = 0;
  for (const n of passosQueRodam(fluxo)) {
    if (n.acao?.tipo !== "espera") continue;
    if (n.acao.segundos > limites.maxInline) {
      // ATENCAO: o trecho "espera inline" e travado pela prova da frente-c
      // (scripts/prova-fluxo.ts). Reescrever a frase sem ele reprova a bateria —
      // e e proposital: e por essa palavra que se distingue "nao cabe na
      // requisicao" de "nao da pra fazer".
      return `o fluxo tem espera de ${n.acao.segundos}s e a v1 so faz espera inline de ate ${limites.maxInline}s — este fluxo roda pela FILA (/api/fluxo-fila)`;
    }
    total += n.acao.segundos;
    if (total > limites.maxTotal) {
      return `as esperas do fluxo somam mais de ${limites.maxTotal}s e nao cabem no tempo da requisicao — este fluxo roda pela FILA (/api/fluxo-fila)`;
    }
  }
  return null;
}

// -------------------------------------------------------------- percurso
// O PERCURSO de um macro (qual passo roda, com que fato a condicao decide, onde
// para) mora AQUI, e nao no motor, por um motivo pratico: `lib/fluxo/executar.ts`
// importa banco, env e provedor, entao nada dele da pra exercitar em node solto.
// Este arquivo nao importa nada — logo o percurso pode ser provado com deps de
// mentira (`scripts/prova-condicao.ts`). O motor virou a fiacao: ele resolve as
// deps de verdade e chama `percorrerMacro`.
//
// Quais campos de fato cada acao SUJA. Sem esta tabela, `definir_contexto`
// seguido de condicao sobre a MESMA chave decidiria em dado velho — o macro
// pararia sozinho, com ok:true, e ninguem saberia por que (defeito real,
// pego na revisao cega de 31/08/2026).
export const CAMPOS_SUJOS_POR_ACAO: Partial<Record<TipoAcao, readonly CampoCondicao[]>> = {
  // responder move a conversa pra "em atendimento" e desarquiva (config da
  // instalacao) — entao mexe em status mesmo sem ser a acao de status
  enviar_texto: ["status"],
  // FRENTE Y: a pergunta com opcoes sai pela MESMA porta de envio do texto
  // (`enviarTexto` em executar.ts), entao ela move a conversa pra "em
  // atendimento" e desarquiva do mesmo jeito. Fora desta tabela, uma condicao
  // sobre `status` logo depois da pergunta decidiria em dado velho — o defeito
  // que a revisao cega da frente L pegou.
  perguntar_opcoes: ["status"],
  mudar_status: ["status"],
  etiquetar: ["etiqueta"],
  mover_funil: ["etapa"],
  // definir_contexto/limpar_contexto NAO entram: elas devolvem o mapa novo do
  // contexto e o percurso usa o valor devolvido, sem reler o banco.
  //
  // `ficha` (Frente X) NAO TEM LINHA AQUI, e isso e medido, nao esquecimento:
  // NENHUMA acao da `ACOES_V1` escreve campo personalizado. O dia em que entrar
  // uma acao `definir_campo` (contrato declarado na secao da Frente X no
  // CLAUDE.md), ela entra AQUI sujando `ficha` — senao uma condicao logo depois
  // dela decidiria em dado velho, que e exatamente o GRAVE que a revisao cega
  // pegou com `definir_contexto` em 31/08/2026.
};

// `texto` nunca fica sujo de proposito: e o texto da ultima mensagem RECEBIDA, e
// macro nao recebe mensagem — o que ele manda nao muda esse fato.

export type StatusPassoPercurso = "ok" | "falhou" | "pulado";
export type PassoPercurso = {
  no_id: string;
  acao: string;
  status: StatusPassoPercurso;
  detalhe?: string;
  /** mensagem criada pelo passo — vai pra trilha e liga mensagem -> execucao */
  mensagem_id?: string | null;
};

/**
 * O QUE UMA COLETA DE FATOS DEVOLVE — e ele fica AQUI porque e CONTRATO: e o
 * retorno de `DepsPercurso.coletar`, e `lib/fluxo/fila.ts` fala dele.
 *
 * A DECISAO que monta isto MUDOU DE CASA na 4a rodada da re-revisao cega
 * (01/09/2026): `coletaDaLinhaDeConversa`, a lista dos campos que saem daquela
 * linha e o leitor injetado moram em `lib/fluxo/coleta.ts`. Motivo: este arquivo
 * e o CONTRATO DE FORMATO do fluxo (nos, acoes, condicao), compartilhado com os
 * conversores do ChatGuru — o formato da LINHA de `mensageria.conversas` (quais
 * colunas se le, o que cada resposta do banco significa) e vizinhanca de banco,
 * nao contrato de fluxo. Mesmo gesto de `lib/fluxo/pergunta.ts` (Frente Y).
 *
 * O TIPO NAO VIAJA COM A DECISAO de proposito: importar `./coleta.ts` daqui —
 * mesmo com `import type`, que o type-stripping apaga — quebraria a guarda de
 * arquitetura "schema.ts continua com ZERO import" (prova-motor-fila, bloco 10),
 * que le o FONTE e nao o runtime. A dependencia anda no sentido unico
 * `coleta.ts -> schema.ts`, e e `coleta.ts` que importa o tipo daqui.
 */
export type ResultadoColeta = {
  fatos: FatosConversa;
  indisponiveis: Partial<Record<CampoCondicao, string>>;
};

export type DepsPercurso = {
  /** le os fatos SO dos campos pedidos; diz tambem o que nao deu pra ler */
  coletar: (campos: CampoCondicao[]) => Promise<ResultadoColeta>;
  /**
   * executa a acao do no. Lanca com mensagem legivel quando falha. Quando a
   * acao mexe no contexto, devolve `contexto` com o mapa NOVO — e o percurso
   * passa a decidir por ele, sem reler.
   */
  executar: (no: No) => Promise<EfeitoDoNo>;
};

/**
 * O efeito de executar UM no. `contexto` = mapa novo da memoria da conversa (a
 * acao devolve, o percurso passa a decidir por ele sem reler). `mensagem_id` = a
 * linha de mensagem que a acao criou — e o que liga MENSAGEM -> EXECUCAO na
 * trilha (card 86ak85zn1); ausente em acao que nao gera mensagem.
 */
export type EfeitoDoNo = {
  detalhe: string;
  contexto?: Record<string, string>;
  mensagem_id?: string | null;
};

// Percorre a corrente do macro. Coleta fato SOB DEMANDA (a condicao pede o que
// precisa, no momento em que precisa) e RECOLETA o campo que uma acao anterior
// sujou. Macro sem condicao nunca consulta nada.
export async function percorrerMacro(
  fluxo: Fluxo,
  deps: DepsPercurso
): Promise<{ ok: boolean; passos: PassoPercurso[] }> {
  const nos = ordemDeExecucao(fluxo);
  const passos: PassoPercurso[] = [];
  // `parou` sinaliza ERRO; `parouPorCondicao` sinaliza DECISAO (o fluxo fez
  // exatamente o que mandaram) — sao coisas diferentes no resultado.
  let parou = false;
  let parouPorCondicao = false;

  const fatos: FatosConversa = {};
  const indisponiveis: Partial<Record<CampoCondicao, string>> = {};
  const coletados = new Set<CampoCondicao>();
  const sujos = new Set<CampoCondicao>();

  for (const no of nos) {
    const rotulo = no.tipo === "condicao" ? "condicao" : (no.acao?.tipo ?? "?");
    if (parou || parouPorCondicao) {
      passos.push({
        no_id: no.id,
        acao: rotulo,
        status: "pulado",
        detalhe: parou ? "passo anterior falhou" : "condicao anterior nao bateu",
      });
      continue;
    }

    // PASSO DESLIGADO: pula e SEGUE. Nao e falha (ninguem errou) e nao e parada
    // (a decisao foi sobre este passo, nao sobre o macro) — desligar um aviso do
    // meio de uma sequencia quer dizer "faca o resto". Vai pra trilha como
    // `pulado` com o motivo: skip invisivel deixaria o atendente procurando por
    // que a mensagem nao saiu.
    if (!noAtivo(no)) {
      passos.push({ no_id: no.id, acao: rotulo, status: "pulado", detalhe: "passo desligado" });
      continue;
    }

    if (no.tipo === "condicao") {
      if (!no.condicao) {
        passos.push({ no_id: no.id, acao: rotulo, status: "falhou", detalhe: "no de condicao sem condicao" });
        parou = true;
        continue;
      }
      const campos = [...camposDaCondicao(no.condicao)];
      const pedir = campos.filter((c) => !coletados.has(c) || sujos.has(c));
      if (pedir.length) {
        const r = await deps.coletar(pedir);
        Object.assign(fatos, r.fatos);
        for (const c of pedir) {
          coletados.add(c);
          sujos.delete(c);
          // `!== undefined` e proposital: motivo VAZIO tambem e indisponibilidade,
          // e um `||` deixaria passar string vazia como "estava tudo bem"
          if (r.indisponiveis[c] !== undefined) indisponiveis[c] = r.indisponiveis[c];
          else delete indisponiveis[c];
        }
      }
      // Fato que nao deu pra LER nao vira "condicao falsa": o passo falha
      // dizendo o que faltou. Silenciar aqui faria o macro parar com cara de
      // "a condicao nao bateu" quando ninguem conseguiu olhar.
      const faltando = campos.map((c) => indisponiveis[c]).filter((m) => m !== undefined);
      if (faltando.length) {
        passos.push({ no_id: no.id, acao: rotulo, status: "falhou", detalhe: faltando[0] });
        parou = true;
        continue;
      }
      const bateu = avaliarCondicao(no.condicao, fatos);
      passos.push({
        no_id: no.id,
        acao: rotulo,
        status: "ok",
        detalhe: bateu ? "condicao verdadeira: segue" : "condicao falsa: o macro para aqui",
      });
      if (!bateu) parouPorCondicao = true;
      continue;
    }

    try {
      const efeito = await deps.executar(no);
      if (efeito.contexto) {
        fatos.contexto = efeito.contexto;
        coletados.add("contexto");
        sujos.delete("contexto");
        delete indisponiveis.contexto;
      }
      for (const c of CAMPOS_SUJOS_POR_ACAO[no.acao!.tipo] ?? []) sujos.add(c);
      passos.push({
        no_id: no.id,
        acao: rotulo,
        status: "ok",
        detalhe: efeito.detalhe,
        mensagem_id: efeito.mensagem_id ?? null,
      });
    } catch (e: any) {
      // Para na primeira falha: seguir enviando depois de um erro deixa a
      // conversa num estado que ninguem consegue reconstruir.
      passos.push({ no_id: no.id, acao: rotulo, status: "falhou", detalhe: e?.message || "falha" });
      parou = true;
    }
  }

  return { ok: !parou, passos };
}

// ------------------------------------------------------------- preflight
// Acoes que escrevem SO em tabela do painel, chaveada por (canal, chat_id) —
// funcionam ate em canal de fonte externa (somente leitura), porque nao tocam
// nem na linha da conversa nem no sistema de origem. As demais mexem na
// conversa/mensagem do canal e nao teriam onde gravar numa fonte externa.
// Campos de condicao que o painel sabe responder MESMO em canal de fonte
// externa: os dois moram em tabela do painel chaveada por (canal, chat_id). Os
// outros (texto, status, etiqueta) vem da conversa/mensagem do canal, que numa
// fonte externa o painel nao tem.
// `intencao` NAO entra: ela e reconhecida a partir do TEXTO da ultima mensagem
// recebida, e texto de conversa de fonte externa o painel nao tem. Deixar ela
// aqui faria o macro passar no preflight e morrer no meio, na coleta.
// `ficha` (Frente X) TAMBEM NAO ENTRA, e a fronteira e a que lib/canais.ts
// escreve: contexto e etapa moram em tabela do painel chaveada por
// (canal, chat_id) e valem em qualquer canal; a ficha mora na COLUNA `ficha` da
// tabela de CONVERSAS do canal, que canal de fonte externa nao tem. Numa fonte
// externa a coleta nao acharia onde ler e o macro morreria no meio — o preflight
// recusa antes de comecar, que e a razao de ele existir.
export const CAMPOS_CONDICAO_SO_DO_PAINEL: readonly CampoCondicao[] = ["contexto", "etapa"];

export const ACOES_SO_DO_PAINEL: readonly TipoAcao[] = [
  "atribuir_responsavel",
  "mover_funil",
  "espera",
  // contexto vive em mensageria.conversa_contexto, chaveada por (canal, chat_id):
  // memoria do PAINEL sobre a conversa, nunca escrita no sistema de origem
  "definir_contexto",
  "limpar_contexto",
];

// O que o motor precisa saber do canal pra decidir. Sao os DOIS predicados de
// lib/canais.ts (somenteLeitura / envioDisponivel) transformados em dado — e o
// que permite a decisao inteira ser pura e provada sem banco e sem env.
export type CapacidadesCanal = {
  /** canal de fonte externa: o painel so LE as conversas dessa fonte */
  soLeitura: boolean;
  /** o canal tem credencial de SAIDA configurada */
  envioCabeado: boolean;
};

// DECISAO DE PREFLIGHT, pura. Recusa ANTES de rodar qualquer acao: macro pela
// metade e pior que macro recusado (o atendente nao consegue saber o que ja saiu
// pro cliente). Quem tem banco e env e `motivoParaRecusar` em executar.ts, que
// so resolve as capacidades do canal e delega pra ca.
export function motivoParaRecusarPuro(
  fluxo: Fluxo,
  cap: CapacidadesCanal,
  limites: { maxInline: number; maxTotal: number },
  opcoes: { modo?: ModoExecucao } = {}
): string | null {
  const modo = opcoes.modo ?? "inline";
  if (fluxo.tipo !== "macro") {
    return "v1 executa so fluxo de tipo macro (gatilho e condicao ficam pra v2)";
  }
  const nos = ordemDeExecucao(fluxo);
  if (!nos.length) return "fluxo sem nenhum no na corrente";
  // Corrente inteira desligada = nada a fazer, e isso e RECUSA e nao sucesso
  // vazio: um macro que "rodou" sem executar nada faria o atendente achar que a
  // mensagem saiu.
  if (!nos.some(noAtivo)) return "todos os passos deste fluxo estao desligados";

  // APROVACAO NAO PODE SER CONTORNADA PELO CAMINHO INLINE. Este e o ponto mais
  // sensivel dos campos novos: o motor inline nao tem onde PARAR pra esperar um
  // humano (ele roda dentro da requisicao), entao rodar inline um fluxo com passo
  // de aprovacao mandaria a mensagem sensivel sem ninguem ter aprovado — que e
  // exactamente o que o campo existe pra impedir. Recusa ANTES de comecar, com o
  // caminho certo escrito.
  //
  // A recusa olha SO os avais que valem (`alcancaCliente`): aprovacao marcada num
  // passo interno — nota interna, etiqueta, status — nao bloqueia o inline, porque
  // ali nao ha nada saindo pro cliente pra alguem conferir. Isso devolveu 631
  // macros da importacao que estavam mortos por causa de um checkbox em nota
  // interna, sem afrouxar UM dos avais que protegem mensagem.
  if (modo === "inline") {
    const pedem = nos.filter((n) => noAtivo(n) && n.aprovacao === true && alcancaCliente(n)).map((n) => n.id);
    if (pedem.length) {
      return `o passo ${pedem[0]} exige aprovacao humana e isso nao roda dentro da requisicao — este fluxo precisa ir pra fila (/api/fluxo-fila)`;
    }
  }

  for (const no of nos) {
    // PASSO DESLIGADO nao executa, entao nao pode ser motivo de recusa: um
    // `enviar_texto` desligado num canal somente leitura recusava o macro inteiro
    // por uma acao que nao ia acontecer.
    if (!noAtivo(no)) continue;
    // no de CONDICAO nao executa acao nenhuma: ele so decide se o macro segue.
    // Nao le nem escreve fora do painel, entao passa ate em canal so-leitura.
    if (no.tipo === "condicao") {
      if (!no.condicao) return `no ${no.id} e de condicao mas nao tem condicao`;
      // Canal de fonte externa: o painel NAO tem a conversa nem as mensagens
      // dessa fonte, entao `texto`, `status` e `etiqueta` nao existem pra ler —
      // a coleta falharia e o macro morreria NO MEIO. Recusa antes de comecar,
      // que e a razao de existir o preflight. `contexto` e `etapa` moram em
      // tabela do painel por (canal, chat_id) e continuam valendo.
      if (cap.soLeitura) {
        const fora = [...camposDaCondicao(no.condicao)].filter((c) => !CAMPOS_CONDICAO_SO_DO_PAINEL.includes(c));
        if (fora.length) {
          return `canal somente leitura: o painel nao tem ${fora.join("/")} das conversas desta fonte pra avaliar a condicao do no ${no.id}`;
        }
      }
      continue;
    }
    if (!no.acao) return `no ${no.id} sem acao`;
    // recusa por ACAO, nao pelo macro inteiro: num canal somente leitura,
    // mover de etapa e atribuir responsavel continuam valendo
    if (cap.soLeitura && !ACOES_SO_DO_PAINEL.includes(no.acao.tipo)) {
      return `canal somente leitura: o painel nao escreve nas conversas desta fonte (acao ${no.acao.tipo})`;
    }
    // FRENTE Y: a checagem passou a olhar `ACOES_QUE_ALCANCAM_CLIENTE` em vez do
    // literal `enviar_texto`. `perguntar_opcoes` tambem SAI pro cliente pela
    // porta de envio do canal — com o literal, um macro com pergunta num canal
    // sem credencial passava o preflight e morria NO MEIO (o que o preflight
    // existe pra impedir). A frase e a mesma de antes de proposito: ela e citada
    // por prova de outra frente (prova-funis, prova-motor-fila).
    if (ACOES_QUE_ALCANCAM_CLIENTE.includes(no.acao.tipo) && !cap.envioCabeado) {
      return "envio nao configurado pra este canal";
    }
  }
  // espera: limite POR acao e limite da SOMA — SO no caminho inline. Na fila a
  // espera e o proposito da coisa (a regua importada tem atraso de dias), e o
  // relogio e o banco, nao o `setTimeout` da requisicao. Mas a fila TAMBEM tem
  // teto: sem ele, uma corrente somando meses fica viva ocupando a trava de "uma
  // cadeia por fluxo por conversa" e entrega mensagem fora de qualquer contexto.
  if (modo === "fila") {
    const total = esperaTotalSegundos(fluxo);
    if (total > LIMITE_ESPERA_TOTAL_FILA_SEG) {
      const dias = Math.round(total / 86400);
      const teto = Math.round(LIMITE_ESPERA_TOTAL_FILA_SEG / 86400);
      return `as esperas do fluxo somam ${dias} dias e o teto da fila e ${teto} — quebre a regua em fluxos menores`;
    }
    return null;
  }
  return problemaDeEspera(fluxo, limites);
}

// Responsavel do painel e sempre uma entidade REAL (usuario do auth ou
// departamento), e as duas tem id uuid. Fluxo importado costuma trazer id
// sintetico derivado de NOME — que precisa ser casado com o painel antes de
// rodar, senao a conversa ganha responsavel fantasma e some do escopo de todo
// mundo. Checagem de FORMATO (a de existencia mora no motor, que tem banco).
export const REF_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function refFormatoOk(id: string): boolean {
  return typeof id === "string" && REF_ID_UUID_RE.test(id);
}

// Encadeia uma lista de acoes numa corrente linear de nos — e o que todo
// conversor de macro precisa fazer no fim.
export function fluxoLinear(
  base: {
    id: string;
    nome: string;
    tipo?: TipoFluxo;
    versao?: number;
    origem?: Origem;
    descricao?: string;
    limites?: LimitesFluxo;
  },
  acoes: Acao[]
): Fluxo {
  const nos: No[] = acoes.map((acao, i) => ({
    id: `n${i + 1}`,
    tipo: acao.tipo === "espera" ? ("espera" as const) : ("acao" as const),
    acao,
    ...(i < acoes.length - 1 ? { proximo: `n${i + 2}` } : {}),
  }));
  return {
    id: base.id,
    nome: base.nome,
    tipo: base.tipo ?? "macro",
    versao: base.versao ?? VERSAO_SCHEMA,
    nos,
    ...(base.limites ? { limites: base.limites } : {}),
    ...(base.origem ? { origem: base.origem } : {}),
    ...(base.descricao ? { descricao: base.descricao } : {}),
  };
}
