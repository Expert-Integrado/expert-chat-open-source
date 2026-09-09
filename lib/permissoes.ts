// Permissoes nomeadas — o nucleo da autorizacao por PAPEL (F-E, 31/08/2026).
//
// Este arquivo e PURO de proposito: nao importa NADA (nem tipo). Isso deixa a
// regra rodar no Next e em node solto (`node scripts/prova-permissoes.ts`),
// mesma escolha do lib/fluxo/schema.ts. Quem toca aqui, mantem assim.
//
// PROBLEMA QUE ISTO RESOLVE: a ferramenta que este painel substitui configura
// permissao caixa a caixa POR PESSOA — dezenas de caixas, por usuario. Numa
// operacao com trinta atendentes isso degenera rapido: contas reais acabam com
// usuario do tipo "comum" tendo MAIS caixas marcadas que o proprio
// administrador, e ninguem mais consegue dizer o que um "comum" pode fazer.
// Aqui a unidade de configuracao e o PAPEL NOMEADO; o ajuste por pessoa existe,
// mas como EXCECAO declarada e visivel.
//
// COMPATIBILIDADE TOTAL e requisito, nao gentileza: instalacao que ja roda nao
// tem papel nomeado nenhum, e precisa se comportar EXATAMENTE como antes. Por
// isso existe o fallback embutido (PAPEIS_EMBUTIDOS) que reproduz, permissao a
// permissao, o que o painel ja fazia com o enum super_admin|normal.

export const PERMISSOES = [
  // — visibilidade —
  "ver_todas_conversas",
  // — atendimento do dia a dia —
  "enviar",
  "iniciar_conversa",
  "concluir",
  "disparo",
  "editar_contexto",
  // — administracao —
  "relatorios",
  "relatorios_exportar",
  "gerenciar_etiquetas",
  "gerenciar_campos",
  "gerenciar_usuarios",
  "gerenciar_visibilidade",
  "gerenciar_canais",
  "conectar_numero",
  "automacao",
  "aprovar_automacao",
  // — biblioteca de anexos (Frente W, card 86ak85bmw) —
  // QUATRO permissoes, e a separacao nao e gosto: a ferramenta de origem tem
  // quatro caixas dedicadas pra este acervo, o que e ela dizendo que a biblioteca
  // e gerida por MAIS DE UMA PESSOA. Quem sobe material nao e quem apaga, e quem
  // escreve a descricao comercial nao e quem organiza as etiquetas.
  "anexos_enviar",
  "anexos_apagar",
  "anexos_descrever",
  "anexos_etiquetar",
] as const;

export type Permissao = (typeof PERMISSOES)[number];
export type PapelBase = "super_admin" | "normal";
export type EscopoVisao = "proprias" | "departamento" | "todas";

// O que cada permissao governa, em uma linha. Esta tabela E a documentacao:
// permissao sem verbete aqui nao existe, e verbete sem rota que o consuma e
// permissao morta (nao criar).
export const DESCRICAO_PERMISSAO: Record<Permissao, string> = {
  ver_todas_conversas:
    "Enxergar a conta inteira. Sem ela, o escopo de visao cai pro departamento (ou so as proprias).",
  enviar: "Enviar e encaminhar mensagem nas conversas que ja enxerga.",
  iniciar_conversa:
    "ABORDAR numero que ainda nao tem conversa (o painel recusa isso em /api/send de proposito, contra disparo frio). Separada de `enviar` porque RESPONDER quem procurou a empresa e ABORDAR quem nao procurou tem consequencias diferentes: a segunda usa o numero da empresa pra iniciar contato, e e ela que pode fazer o numero ser banido por spam. Quem quiser que o time so responda cria papel com `enviar` e SEM esta. Como `relatorios_exportar`: papel NOMEADO criado antes desta permissao (inclusive os semeados pela 0010) nao a ganha sozinho — marcar na tela de papeis. Quem NAO tem papel nomeado ja a tem, pelo fallback embutido.",
  concluir: "Concluir, reabrir e arquivar conversa.",
  disparo: "Agendar mensagem pra enviar depois.",
  relatorios: "Abrir o relatorio de atendimento.",
  relatorios_exportar:
    "Baixar relatorio em CSV. Separada de `relatorios` de proposito: exportar tira dado de cliente do sistema. Papel nomeado criado ANTES desta permissao nao a ganha sozinho — marcar na tela de papeis.",
  gerenciar_etiquetas:
    "Administrar o catalogo de etiquetas. Ate 31/08/2026 esta caixa tambem cobria os campos da ficha; o CONSTRUTOR da ficha saiu pra `gerenciar_campos` (ver o verbete dela). Do lado da ficha sobrou aqui o que a rota antiga `/api/admin/ficha-config` ainda pode fazer sem esconder dado de ninguem: CRIAR campo de texto e REATIVAR campo arquivado. DESATIVAR e RENOMEAR sairam (a rota recusa com 409): os dois alcancam o valor ja gravado em todas as conversas, e aquela rota nao varre canal — entao ela nao tem como medir o impacto antes. Os dois acontecem em `/campos`, sob `gerenciar_campos`.",
  gerenciar_campos:
    "MONTAR a ficha do contato desta instalacao: criar, editar, tipar (texto/numero/data/lista/sim-nao), marcar obrigatorio, reordenar, arquivar e remover campo. Separada de `gerenciar_etiquetas` de proposito, e a divisao e a mesma de `relatorios` x `relatorios_exportar`: etiqueta e um rotulo que se poe e se tira sem consequencia, enquanto MEXER NO CAMPO alcanca o valor gravado em TODAS as conversas — arquivar tira o campo do formulario da conta inteira, renomear move o valor de milhares de fichas, remover apaga o cadastro. Separada tambem de PREENCHER: quem preenche a ficha passa pelo gate da CONVERSA (`/api/campos/valores` e `/api/ficha`) e nao precisa de permissao nomeada nenhuma — atendente preenche, administrador constroi. Papel nomeado criado ANTES desta permissao (inclusive os semeados pela 0010) nao a ganha sozinho — marcar na tela de papeis. Quem NAO tem papel nomeado segue pelo fallback embutido (super_admin tem, normal nao).",
  gerenciar_usuarios: "Administrar usuarios, departamentos e papeis.",
  gerenciar_visibilidade: "Definir quem enxerga cada conversa (a trava dura por conversa).",
  gerenciar_canais:
    "VER os numeros da instalacao e puxar dado de integracao: listar canal, sincronizar o historico do ChatGuru, sincronizar o catalogo de templates da API Oficial e acompanhar o estado da conexao. E a metade de LEITURA da administracao de canal — ela nao conecta, nao desconecta e nao troca chip (isso e `conectar_numero`).",
  conectar_numero:
    "MEXER no numero em si: conectar por QR Code, pedir o codigo de 8 digitos, desconectar, reiniciar a conexao, abrir/cancelar a troca de chip e APAGAR template no provedor (o apagar sai da Meta e nao volta). Separada de `gerenciar_canais` de proposito, e a divisao e a mesma de `relatorios` x `relatorios_exportar`: LER o estado do numero e diagnostico, e todo supervisor precisa; DESCONECTAR o numero da empresa derruba o atendimento inteiro na hora, e trocar o chip para a operacao ate alguem aparecer com um aparelho na mao. Papel nomeado criado ANTES desta permissao (inclusive os semeados pela 0010) NAO a ganha sozinho — marcar na tela de papeis. Quem NAO tem papel nomeado segue pelo fallback embutido (super_admin tem, normal nao).",
  automacao: "Configurar as automacoes do painel (nao e o mesmo que EXECUTAR um macro).",
  editar_contexto:
    "Editar a memoria da conversa (os pares chave/valor que as automacoes leem). SEPARADA de `automacao` de proposito: quem CONFIGURA fluxo nao e quem destrava um menu preso numa conversa, e o atendente que destrava nao precisa poder editar fluxo nenhum. LER o contexto NAO exige esta permissao — quem pode abrir a conversa le a memoria dela, como le a ficha; ESCREVER exige, porque muda o que o robo vai fazer ali. Papel nomeado criado ANTES desta permissao nao a ganha sozinho — marcar na tela de papeis (mesma regra de `relatorios_exportar`).",
  aprovar_automacao:
    "Liberar mensagem que um passo de fluxo segurou pra aval humano (aprovar ou recusar). Separada de `automacao` de proposito: quem CONFIGURA a automacao nao e necessariamente quem responde pelo que sai pro cliente, e quem aprova nao precisa poder editar fluxo. Papel nomeado criado ANTES desta permissao nao a ganha sozinho — marcar na tela de papeis (mesma regra de `relatorios_exportar`).",
  anexos_enviar:
    "SUBIR arquivo novo pra biblioteca de anexos da instalacao. LER a biblioteca e ANEXAR um arquivo dela numa conversa NAO exigem esta permissao — quem atende usa o acervo com a permissao `enviar` que ele ja tem, como usa o catalogo de etiquetas e as respostas rapidas; o que estas quatro permissoes governam e ADMINISTRAR o acervo. Papel nomeado criado ANTES desta permissao nao a ganha sozinho — marcar na tela de papeis (mesma regra de `relatorios_exportar`).",
  anexos_apagar:
    "APAGAR arquivo da biblioteca (a linha sai e o arquivo sai do armazenamento). E a mais perigosa das quatro e a razao de elas serem separadas: 56 arquivos da conta medida sao referenciados por fluxos de automacao, entao apagar um deles pode deixar 76 passos mandando mensagem SEM o material, em silencio. Por isso a rota mostra a lista de fluxos afetados e exige confirmacao ciente antes de apagar. Ela tambem libera VER A TRILHA da biblioteca (quem subiu, descreveu, etiquetou e apagou), que e a leitura que nomeia pessoas. Papel nomeado criado ANTES desta permissao nao a ganha sozinho — marcar na tela de papeis.",
  anexos_descrever:
    "Editar a DESCRICAO de um arquivo da biblioteca (pra que serve, quando mandar). Separada de `anexos_etiquetar` porque descricao e texto que vai pro atendente decidir o que enviar, e etiqueta e organizacao do acervo — na origem sao duas caixas diferentes, e um pedido que mexe nos dois campos exige as DUAS permissoes (ou e recusado inteiro, nunca gravado pela metade). Papel nomeado criado ANTES desta permissao nao a ganha sozinho — marcar na tela de papeis.",
  anexos_etiquetar:
    "Editar as ETIQUETAS de um arquivo da biblioteca (a organizacao do acervo, que e o que faz achar o arquivo certo em 153 itens). Nao sao as etiquetas de conversa: catalogo e tabela diferentes, e ter as duas na mesma permissao faria organizar a biblioteca mexer no filtro da caixa de entrada. Papel nomeado criado ANTES desta permissao nao a ganha sozinho — marcar na tela de papeis.",
};

export const ORDEM_ESCOPO: Record<EscopoVisao, number> = {
  proprias: 0,
  departamento: 1,
  todas: 2,
};

// ————————————————————————————————————————————————————————————————
// Fallback embutido — o retrato EXATO do painel antes desta feature.
//
// super_admin: podia tudo (ehAdmin liberava toda rota /api/admin/*).
// normal: atendia (enviava, concluia, agendava) e nada de administracao.
//
// `ver_todas_conversas` NAO entra aqui pro normal de proposito: pra quem nao
// tem papel nomeado, quem manda na visibilidade continua sendo a coluna
// escopo_visao, e a permissao e DERIVADA dela (ver permissoesEfetivas). O
// contrario — deixar a permissao mandar no escopo de quem nunca a configurou —
// tiraria acesso de todo mundo no dia do deploy.
export const PAPEIS_EMBUTIDOS: Record<PapelBase, readonly Permissao[]> = {
  super_admin: PERMISSOES,
  // `iniciar_conversa` ENTRA aqui, em paridade com `enviar`: instalacao sem
  // papel nomeado nao pode perder um botao no dia do deploy. Quem quiser
  // restringir abordagem de numero frio cria papel nomeado SEM ela — e ai a
  // restricao e uma escolha da instalacao, nao um efeito colateral nosso.
  // `editar_contexto` ENTRA aqui, e a decisao merece o registro porque ela e uma
  // MUDANCA DE COMPORTAMENTO NO DEPLOY: `papel_id` NULL e o estado de toda
  // instalacao existente, entao sem esta linha o recurso nasceria visivel so pro
  // super admin em todas elas — e a memoria da conversa e justamente o que o
  // ATENDENTE precisa destravar quando um cliente fica preso no meio de um menu.
  // O que pesou a favor: o efeito e limitado a UMA conversa que a pessoa ja pode
  // abrir (o gate de conversa vem antes), nada sai pro cliente por causa dessa
  // escrita, e o modulo de automacao nasce DESLIGADO — numa instalacao que nunca
  // ligou automacao, escrever contexto nao muda nada. Quem quiser restringir cria
  // papel nomeado SEM ela, e ai a restricao e escolha da instalacao.
  // AS QUATRO PERMISSOES DE BIBLIOTECA (Frente W) NAO ENTRAM AQUI, e a decisao
  // merece registro porque ela e o CONTRARIO da do `editar_contexto` logo acima —
  // e o motivo e a data de nascimento da feature. `editar_contexto` entrou porque
  // deixa-la fora MUDARIA o comportamento de instalacao existente (o atendente
  // perderia acesso a uma conversa que ele ja destravava). A biblioteca de anexos
  // NAO EXISTIA antes desta frente: nenhuma instalacao tem material la, ninguem
  // perde botao, e nada deixa de funcionar no dia do deploy. Entao ela nasce
  // FECHADA (so super admin administra o acervo) e a instalacao abre pra quem
  // quiser, marcando na tela de papeis — que e a direcao certa pra um acervo
  // compartilhado com gesto destrutivo dentro.
  //
  // ATENCAO: nascer fechada NAO tranca o atendimento. USAR a biblioteca (listar,
  // buscar e anexar numa conversa) nao passa por nenhuma das quatro: passa por
  // `enviar`, que o papel embutido `normal` tem desde sempre.
  normal: ["enviar", "iniciar_conversa", "concluir", "disparo", "editar_contexto"],
};

// Papeis sugeridos pro cliente comecar (o card cita estes quatro). Sao SEMENTE,
// nao lei: a instalacao edita e cria os seus. A migration 0010 insere estes
// mesmos conjuntos — mudou aqui, mudar la.
//
// DIVERGENCIA DELIBERADA com a 0010, e vale entender antes de "consertar":
// permissao criada DEPOIS que a 0010 rodou nao e retro-adicionada no arquivo da
// migration. Duas razoes: (1) a 0010 usa `on conflict do nothing`, entao reescrever
// as sementes nao mexeria em nenhuma instalacao que ja rodou — daria a ILUSAO de
// ter migrado o papel; (2) editar o texto de uma migration ja aplicada faz o
// arquivo deixar de descrever o que existe no banco. Por isso `relatorios_exportar`
// (Frente J), `aprovar_automacao` (Frente P) e `conectar_numero` (Frente U)
// aparecem AQUI e nao la, e cada uma carrega no verbete a frase "papel nomeado
// criado ANTES desta permissao nao a ganha sozinho — marcar na tela de papeis".
// Instalacao NOVA nasce sem elas nos papeis semeados; quem quiser, marca na tela
// (que le PERMISSOES, nao a 0010).
export const PAPEIS_SUGERIDOS: ReadonlyArray<{
  nome: string;
  descricao: string;
  permissoes: readonly Permissao[];
}> = [
  {
    nome: "Administrador",
    descricao: "Governa a instalacao inteira.",
    permissoes: PERMISSOES,
  },
  {
    nome: "Supervisor",
    descricao: "Enxerga a conta inteira, atende e le relatorio, sem mexer no cadastro.",
    // `aprovar_automacao` entra no Supervisor e NAO no Atendente (decisao do
    // coordenador, 31/08/2026): aprovar e responder pelo que sai pro cliente, e
    // isso e papel de quem supervisiona. Note que ela NAO vem com `automacao` —
    // supervisor aprova sem poder editar fluxo, que e exatamente a divisao.
    // `iniciar_conversa` (Frente O) tambem entra: supervisor aborda a frio.
    // `editar_contexto` (Frente V) entra no Supervisor E no Atendente: destravar
    // uma conversa presa no meio de um menu e gesto de ATENDIMENTO, nao de
    // administracao — deixa-la so pra quem tem `automacao` faria o atendente
    // abrir ticket pro admin pra consertar uma conversa que ele tem na tela.
    //
    // `conectar_numero` (Frente U) NAO entra, e a decisao e explicita pra ninguem
    // "completar a lista" depois: dos papeis semeados, SO o Administrador mexe no
    // numero. Desconectar derruba o atendimento inteiro na hora e trocar o chip
    // para a operacao — nao e acao de quem esta supervisionando a fila, e a
    // instalacao que quiser delegar isso marca a caixa na tela de papeis.
    // `gerenciar_canais` (a metade de LEITURA) tambem segue fora daqui, como
    // sempre esteve.
    //
    // BIBLIOTECA (Frente W): o Supervisor SOBE, DESCREVE e ETIQUETA material —
    // curar o acervo comercial e trabalho de quem supervisiona a operacao. Ele
    // NAO recebe `anexos_apagar`, e a divisao e a mesma de `gerenciar_canais` x
    // `conectar_numero`: apagar um arquivo pode deixar passos de fluxo mandando
    // mensagem sem o material, e isso e decisao de quem responde pela instalacao.
    // `gerenciar_campos` (Frente X) NAO entra, mesmo motivo do `conectar_numero`:
    // arquivar um campo tira ele do formulario da CONTA INTEIRA e renomear move o
    // valor de milhares de fichas — nao e gesto de quem supervisiona a fila. E o
    // supervisor nao perde nada com isso: PREENCHER a ficha nao exige permissao
    // nomeada (o gate e a conversa). A instalacao que quiser delegar marca a caixa
    // na tela de papeis.
    permissoes: [
      "ver_todas_conversas", "enviar", "iniciar_conversa", "concluir", "disparo", "editar_contexto",
      "relatorios", "aprovar_automacao", "anexos_enviar", "anexos_descrever", "anexos_etiquetar",
    ],
  },
  {
    nome: "Atendente",
    descricao: "Atende o que cai pra ele ou pro departamento dele.",
    // NENHUMA das quatro de biblioteca (Frente W), e isso NAO tira dele a
    // biblioteca: com `enviar` ele lista, busca e ANEXA arquivo na conversa. O que
    // ele nao faz e administrar o acervo — subir material novo, reescrever a
    // descricao comercial ou apagar. A instalacao que quiser um atendente
    // curador marca `anexos_enviar` na tela de papeis.
    permissoes: ["enviar", "iniciar_conversa", "concluir", "disparo", "editar_contexto"],
  },
  {
    nome: "Somente leitura",
    descricao: "Le conversa e nao age em nada.",
    permissoes: [],
  },
];

// ————————————————————————————————————————————————————————————————
// Saneamento do que vem do banco (jsonb livre) e do que vem da rota.

export function ehPermissao(v: unknown): v is Permissao {
  return typeof v === "string" && (PERMISSOES as readonly string[]).includes(v);
}

/**
 * VER o numero x MEXER no numero — a politica das rotas `/api/canais/*`.
 *
 * Mora AQUI, junto do catalogo, e nao dentro de lib/canais-porta.ts, por um motivo
 * medido: enquanto era constante privada da porta (que nenhuma prova consegue
 * carregar — especificador `next/server` sem extensao e alias `@/`), a divisao
 * estava provada so por grep de
 * frase — e a mutacao que apontava `operar` de volta pra `gerenciar_canais`, ou
 * seja, que DESFAZ a correcao inteira em producao, passava a bateria verde.
 *
 * A desigualdade entre os dois niveis e o invariante: `gerenciar_canais` VE o
 * estado do numero e sincroniza catalogo (diagnostico, todo supervisor precisa);
 * `conectar_numero` conecta, desconecta, reinicia, troca o chip e apaga template na
 * Meta. Desconectar derruba o atendimento inteiro na hora — nao pode vir de brinde
 * com a caixa de "ver".
 */
export const PERM_POR_NIVEL_CANAL = {
  ler: "gerenciar_canais",
  operar: "conectar_numero",
} as const;

export type NivelCanal = keyof typeof PERM_POR_NIVEL_CANAL;

export function permissaoDoNivel(nivel: NivelCanal): Permissao {
  return PERM_POR_NIVEL_CANAL[nivel];
}

// Aceita lista (["enviar"]) ou mapa ({enviar:true, x:false}). Chave desconhecida
// e IGNORADA — mesmo espirito do lib/modulos.ts: instalacao velha nao quebra
// quando permissao nova entra na lista, e permissao que saiu nao vira erro.
export function validarPermissoes(bruto: unknown): Permissao[] {
  const achadas = new Set<Permissao>();
  if (Array.isArray(bruto)) {
    for (const v of bruto) if (ehPermissao(v)) achadas.add(v);
  } else if (bruto && typeof bruto === "object") {
    for (const [k, v] of Object.entries(bruto as Record<string, unknown>)) {
      if (v === true && ehPermissao(k)) achadas.add(k);
    }
  }
  // devolve na ordem canonica, pra gravacao e telas nao dependerem de ordem de digitacao
  return PERMISSOES.filter((p) => achadas.has(p));
}

// Excecao por pessoa: mapa permissao -> true (concede) | false (revoga).
// So booleano de verdade conta; qualquer outro valor e descartado.
export function validarExcecoes(bruto: unknown): Partial<Record<Permissao, boolean>> {
  const out: Partial<Record<Permissao, boolean>> = {};
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return out;
  for (const [k, v] of Object.entries(bruto as Record<string, unknown>)) {
    if (typeof v === "boolean" && ehPermissao(k)) out[k] = v;
  }
  return out;
}

export function validarEscopo(v: unknown): EscopoVisao {
  return v === "proprias" || v === "departamento" || v === "todas" ? v : "todas";
}

// ————————————————————————————————————————————————————————————————
// O calculo.

export type EntradaPermissoes = {
  papel: PapelBase;
  escopo_visao: EscopoVisao;
  // permissoes do papel NOMEADO (mensageria.papeis.permissoes). null/undefined =
  // usuario sem papel nomeado -> cai no fallback embutido.
  papelPermissoes?: unknown;
  // excecoes individuais (perfis.permissoes_excecao)
  excecoes?: unknown;
};

// Permissoes efetivas, em camadas:
//   1. base = papel nomeado, se houver; senao o embutido do enum.
//   2. ver_todas_conversas derivada do escopo, SO no caminho embutido (compat).
//   3. excecoes individuais por cima (conceder ou revogar).
//   4. super_admin sempre tem tudo — excecao nao rebaixa super admin (senao da
//      pra se trancar pra fora, e ehAdmin/anti-escalada ja dependem do enum).
export function permissoesEfetivas(e: EntradaPermissoes): Set<Permissao> {
  if (e.papel === "super_admin") return new Set(PERMISSOES);

  const temPapelNomeado = e.papelPermissoes != null;
  const base = temPapelNomeado
    ? validarPermissoes(e.papelPermissoes)
    : [...PAPEIS_EMBUTIDOS.normal];

  const set = new Set<Permissao>(base);
  if (!temPapelNomeado && e.escopo_visao === "todas") set.add("ver_todas_conversas");

  for (const [k, v] of Object.entries(validarExcecoes(e.excecoes))) {
    if (v) set.add(k as Permissao);
    else set.delete(k as Permissao);
  }
  return set;
}

// Teto de visibilidade imposto pelo papel.
//
// REGRA CRITICA (nao afrouxar): quem NAO tem papel nomeado sai daqui com o
// escopo intacto — e o que garante que a instalacao existente nao muda de
// comportamento. Quem TEM papel nomeado e nao recebeu ver_todas_conversas nao
// pode ficar com escopo "todas": o papel e a fonte, e a permissao ausente nega.
export function escopoComTeto(
  escopo: EscopoVisao,
  permissoes: Set<Permissao>,
  temPapelNomeado: boolean
): EscopoVisao {
  if (!temPapelNomeado) return escopo;
  if (permissoes.has("ver_todas_conversas")) return escopo;
  return escopo === "todas" ? "departamento" : escopo;
}

// Fail-closed: permissao ausente = negado. Ponto unico de leitura.
export function pode(permissoes: Set<Permissao>, permissao: Permissao): boolean {
  return permissoes.has(permissao);
}

// TETO DE DELEGACAO — a trava contra escalada de privilegio.
//
// Quem administra usuarios NAO pode conceder permissao que ele proprio nao tem.
// Sem isto, `gerenciar_usuarios` vira admin total por tres portas: editar um
// papel poderoso, gravar excecao individual em si mesmo, ou se auto-atribuir um
// papel Administrador. Devolve as permissoes que EXCEDEM o conjunto do ator
// (vazio = pode delegar). Super admin nao passa por aqui.
export function excedem(pedidas: Iterable<Permissao>, doAtor: Set<Permissao>): Permissao[] {
  const fora: Permissao[] = [];
  for (const p of pedidas) if (!doAtor.has(p)) fora.push(p);
  return fora;
}

// A decisao que as rotas de admin CHAMAM (nao uma copia da regra: e a regra).
// Devolve as permissoes que o ator nao pode entregar — vazio = liberado.
// Super admin e isento: ele ja tem todas, entao o teto nunca o alcanca.
export function bloqueiaDelegacao(
  atorEhAdmin: boolean,
  atorPermissoes: Set<Permissao>,
  concedidas: Iterable<Permissao>
): Permissao[] {
  if (atorEhAdmin) return [];
  return excedem(concedidas, atorPermissoes);
}

// Ninguem edita a PROPRIA autorizacao (papel nomeado ou excecao individual):
// seria auto-promocao com um passo a mais. Super admin isento — ele ja pode
// tudo, e travar isso o impediria de consertar a propria conta.
export function editaPropriaAutorizacao(opts: {
  atorEhAdmin: boolean;
  atorId: string;
  alvoId: string;
  mexeEmAutorizacao: boolean;
}): boolean {
  if (opts.atorEhAdmin || !opts.mexeEmAutorizacao) return false;
  return opts.atorId === opts.alvoId;
}

// O papel BASE (super_admin | normal) so muda por quem ja e super admin.
// `gerenciar_usuarios` NAO cunha super admin: o conjunto de quem cria super
// admin tem que continuar sendo exatamente {super_admin}.
//
// `papelAtual` evita paralisia: front que reenvia o valor que ja esta gravado
// nao e troca, e nao pode virar 403 em todo save. Sem esse argumento, qualquer
// papel informado conta como troca (o caso conservador).
export function bloqueiaTrocaDePapelBase(
  atorEhAdmin: boolean,
  papelPedido: unknown,
  papelAtual?: unknown
): boolean {
  if (papelPedido === undefined) return false;
  if (atorEhAdmin) return false;
  return papelPedido !== papelAtual;
}

// APAGAR papel e privativo do super admin — e a unica operacao de papel que
// AFROUXA autorizacao, entao teto nenhum a torna segura.
//
// Por que: `ON DELETE SET NULL` devolve os membros ao fallback embutido
// `normal` (enviar/concluir/disparo) E levanta o teto de escopo, fazendo um
// `escopo_visao=todas` legado na coluna voltar a valer. Dois ataques que o teto
// por permissoes do papel NAO pegava: apagar o papel "Somente leitura" (lista
// vazia, cabe em qualquer teto) promove todo mundo que estava nele; e apagar o
// PROPRIO papel devolve ao ator o embutido mais a visao total.
// Quem nao e super admin tira acesso com `ativo:false`, que e fail-closed.
export function bloqueiaApagarPapel(atorEhAdmin: boolean): boolean {
  return !atorEhAdmin;
}
