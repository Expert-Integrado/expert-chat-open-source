// COSTURAS DA TELA DE CONVERSA — as REGRAS puras (Frente Y, 31/08/2026)
//
// Este arquivo existe por causa da regra da casa que ja custou revisao em cinco
// frentes: **a decisao nao mora no .tsx**. `app/home.tsx` passa de 7.400 linhas e
// nao roda em node solto; tudo o que decide alguma coisa nas tres costuras desta
// frente mora aqui e e provado por `node scripts/prova-costuras-y.ts`.
//
// AS TRES COSTURAS, e o que cada frente deixou escrito no CLAUDE.md:
//
//  1. VARIAVEL EM RESPOSTA RAPIDA (frente T, card 86ak86jw9). A rota
//     `/api/respostas-rapidas` ja devolve `texto_resolvido` quando recebe
//     `canal`+`chat_id`; faltava a caixa de digitacao USAR isso. O criterio do
//     card e "substituida ANTES de aparecer na caixa".
//  2. MEMORIA DA CONVERSA (frente V, card 86ak859vt). `/api/conversa/contexto`
//     devolve `contexto` + `pode_editar`; faltava a tela.
//  3. TEMPLATE NO COMPOSER (frente U, card 86ak858pa). `/api/send` responde 403
//     com `use_template: true` quando a janela de 24h fechou; faltava a tela
//     oferecer o template em vez de so travar o campo.
//
// Importa SO modulos PUROS, com o especificador de extensao que a frente H
// liberou no tsconfig (`allowImportingTsExtensions`) — a mesma convencao de
// `lib/janela-acesso.ts` e `lib/fluxo/fila-relogio.ts`. Roda no Next E em node
// solto, sem build.
import {
  podeEnviarTemplate,
  renderizarTemplate,
  validarParametros,
  variaveisDoCorpo,
  type TemplateCanal,
} from "./templates-oficial.ts";
import {
  LIMITE_CHAVE_CONTEXTO,
  LIMITE_VALOR_CONTEXTO,
  chaveDeContexto,
} from "./fluxo/schema.ts";

// ══════════════════════════════ 1) resposta rapida com variavel ══════════════

/** O que a rota `/api/respostas-rapidas` devolve, no recorte que a tela usa. */
export type RespostaRapida = {
  id: string;
  atalho: string;
  texto: string;
  global: boolean;
  /** so vem quando o GET foi feito COM `canal`+`chat_id` */
  texto_resolvido?: string;
  variaveis_vazias?: string[];
  variaveis_nao_resolvidas?: string[];
};

/**
 * O TEXTO QUE VAI PRA CAIXA DE DIGITACAO.
 *
 * `texto_resolvido` VENCE, e a ordem importa nos dois sentidos:
 *
 *  - usar `texto` quando o resolvido existe faz o atendente mandar `!nome` cru
 *    pro cliente (o defeito que o card manda fechar);
 *  - usar `texto_resolvido` quando ele NAO existe (a rota foi chamada sem
 *    conversa, ou o campo veio nulo) faria a caixa ficar VAZIA — pior que o
 *    template cru, porque o atendente perde a resposta rapida inteira.
 *
 * Por isso o fallback e explicito e o tipo do resolvido e checado: `null` no
 * jsonb, string vazia e numero nao viram texto de mensagem.
 */
export function textoParaCaixa(r: RespostaRapida): string {
  const resolvido = typeof r.texto_resolvido === "string" ? r.texto_resolvido : "";
  return resolvido.trim() ? resolvido : r.texto;
}

/**
 * A resposta rapida saiu com variavel EM BRANCO ou variavel que ninguem
 * reconheceu?
 *
 * O AVISO E OBRIGATORIO E E ISSO QUE FAZ A COSTURA HONESTA. A substituicao
 * troca variavel sem valor por VAZIO (regra da frente T: `!nome` num contato sem
 * nome nao pode virar a string "!nome" na cara do cliente). Sem aviso, o
 * atendente cola "Oi , tudo bem?" e nao ve o buraco — a frase fica quebrada e
 * nada na tela disse por que. Devolve `null` quando nao ha nada a dizer, pra a
 * tela nao desenhar faixa vazia.
 */
export function avisoDeVariaveis(r: RespostaRapida): string | null {
  const vazias = (r.variaveis_vazias ?? []).filter((v) => typeof v === "string" && v.trim());
  const cruas = (r.variaveis_nao_resolvidas ?? []).filter((v) => typeof v === "string" && v.trim());
  const partes: string[] = [];
  if (vazias.length) partes.push(`sem valor nesta conversa: ${vazias.join(", ")}`);
  // "nao resolvida" e diferente de "vazia": a primeira e uma variavel que este
  // painel NAO conhece (sobra de outra ferramenta) e ela fica NO TEXTO. Juntar
  // as duas faria o atendente procurar o valor de uma variavel que nao existe.
  if (cruas.length) partes.push(`nao existem neste painel e ficaram no texto: ${cruas.join(", ")}`);
  if (!partes.length) return null;
  return `Confira antes de enviar — ${partes.join("; ")}.`;
}

/** As respostas rapidas que casam com o que foi digitado depois da "/". */
export function respostasDoAtalho(
  lista: readonly RespostaRapida[],
  digitado: string,
  teto = 8
): RespostaRapida[] {
  // COMPARACAO CRUA, sem `ilike` e sem regex montada com o que a pessoa digitou:
  // o atalho e `^[a-z0-9_-]{1,30}$` na rota, entao `startsWith` em minusculas
  // basta. Regex a partir de texto de usuario e a armadilha que este repo ja
  // pagou (`%` e `_` virando coringa na busca).
  const q = digitado.replace(/^\//, "").toLowerCase();
  return lista.filter((r) => r.atalho.toLowerCase().startsWith(q)).slice(0, teto);
}

// ══════════════════════════════ 2) memoria da conversa ══════════════════════

export type ParContexto = { chave: string; valor: string };

/**
 * O mapa de contexto virando lista ORDENADA pra tela.
 *
 * Ordem alfabetica por chave, e nao a ordem do jsonb: a ordem das chaves de um
 * jsonb muda quando o Postgres reescreve a linha, e uma lista que se reordena
 * sozinha entre dois cliques faz o atendente perder a linha que estava lendo.
 *
 * Valor NAO-TEXTO vira texto aqui (o jsonb aceita numero e booleano, e o
 * `normalizarContexto` do schema tambem converte) — o que se recusa e objeto e
 * lista, que virariam "[object Object]" na tela.
 */
export function paresDeContexto(bruto: unknown): ParContexto[] {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return [];
  const pares: ParContexto[] = [];
  for (const [k, v] of Object.entries(bruto as Record<string, unknown>)) {
    if (typeof v === "string") pares.push({ chave: k, valor: v });
    else if (typeof v === "number" || typeof v === "boolean") pares.push({ chave: k, valor: String(v) });
  }
  return pares.sort((a, b) => a.chave.localeCompare(b.chave, "pt-BR"));
}

/**
 * O que impede gravar este par — a MESMA regra que a rota aplica, chamada antes
 * do clique.
 *
 * Nao e duplicacao: `chaveDeContexto` e a funcao do schema, a mesma que
 * `definir_contexto` usa, e os dois tetos sao as constantes dele. O ganho e o
 * erro aparecer no formulario em vez de voltar como 400 depois de o atendente
 * ter escrito tudo.
 *
 * `valor` VAZIO e legitimo de proposito (marcar a chave sem conteudo). Apagar e
 * gesto SEPARADO (`limpar: true`) porque so apagando a chave o `nao_existe` da
 * condicao volta a valer — regra do avaliador da frente L, e um botao "salvar
 * vazio" fazendo as duas coisas apagaria a diferenca.
 */
export function problemaDoPar(chave: string, valor: string): string | null {
  const c = chaveDeContexto(chave);
  if (!c) {
    return `nome da variavel invalido (ate ${LIMITE_CHAVE_CONTEXTO} caracteres, sem quebra de linha)`;
  }
  if (valor.length > LIMITE_VALOR_CONTEXTO) {
    return `o valor passa de ${LIMITE_VALOR_CONTEXTO} caracteres`;
  }
  return null;
}

/** A chave como ela vai ser GRAVADA (a tela mostra isso antes de salvar). */
export function chaveNormalizada(chave: string): string {
  return chaveDeContexto(chave) ?? "";
}

// ══════════════════════════════ 3) template no composer ═════════════════════

/**
 * A tela deve OFERECER o seletor de template?
 *
 * SO com o sinal do SERVIDOR (`use_template: true` no 403 de `/api/send`), nunca
 * por dedução da tela. Adivinhar por "canal e apioficial e a janela parece
 * fechada" abriria o seletor em caso que a rota aceitaria — e o contrario
 * (esconder quando ela recusou) e o comportamento que a frente U declarou como
 * costura pendente: o composer travado com banner e sem saida.
 */
export function pedeTemplate(resposta: unknown): boolean {
  return !!resposta && typeof resposta === "object" && (resposta as any).use_template === true;
}

/**
 * O que impede ENVIAR este template agora — `null` quando da pra enviar.
 *
 * Uma funcao so, e ela serve os DOIS lados da tela: quem entra no seletor e o
 * motivo que aparece na lista dos barrados. Duas regras separadas dariam a lista
 * de baixo dizendo "aprovado" pra um template que a de cima recusou.
 *
 * `podeEnviarTemplate` e a MESMA funcao que a rota chama antes do envio: recusa
 * `em_analise`, `recusado`, `pausado`, `desconhecido` e template sem
 * identificador no provedor. Oferecer um recusado/pausado nao e so botao inutil:
 * a tentativa ARRANHA a nota de qualidade do numero da empresa, que mexe no
 * limite de disparo.
 *
 * UMA REGRA SO, E ELA E DA RAIZ. Esta funcao NAO tem criterio proprio: ela
 * traduz `podeEnviarTemplate` em "null = pode / texto = por que nao". A 1a
 * revisao cega mandou acrescentar aqui a recusa do template com CABECALHO DE
 * IMAGEM sem `midia_url` (o caso em que o Gupshup devolve 202, `lerRespostaEnvio`
 * conta como sucesso e a Meta dropa a entrega em silencio) — e a decisao mudou
 * no meio: a frente Z fecha esse caso NA RAIZ, dentro de `podeEnviarTemplate`,
 * antes de qualquer chamada ao provedor.
 *
 * ATENCAO — no PRESENTE, nesta branch, isso ainda NAO vale: a regra da imagem
 * vive so em `frente-z-template-params` (`95315f1`) e nao foi mergeada. Ate la a
 * raiz LIBERA o template de imagem sem arte, esta funcao concorda com ela (que e
 * o comportamento certo de quem delega) e o caso segue passando. Quem guarda a
 * pendencia e `scripts/prova-pendencia-z-imagem.ts`, que reprova de proposito
 * ate o merge e fica verde sozinho depois — medido.
 *
 * A tela NAO replica. Duas regras pro mesmo fato divergem, e e a classe de
 * defeito que esta onda inteira vem pagando: bastaria a raiz mudar a frase, o
 * limite ou o criterio pra tela passar a barrar por um motivo e a rota por
 * outro. Por consumir a raiz, a tela aperta junto com ela sem uma linha de
 * alteracao — e a prova cobra exatamente essa DELEGACAO, nao a lista de casos.
 */
export function motivoDeNaoEnviar(t: TemplateCanal | null | undefined): string | null {
  const v = podeEnviarTemplate(t);
  return v.ok ? null : v.motivo;
}

/**
 * Os templates que dá pra ENVIAR agora — os que `motivoDeNaoEnviar` libera.
 */
export function templatesEnviaveis(lista: readonly TemplateCanal[] | null | undefined): TemplateCanal[] {
  return (lista ?? []).filter((t) => motivoDeNaoEnviar(t) === null);
}

/**
 * Quantos campos o formulario tem que pedir.
 *
 * `variaveis` do espelho e a contagem de variaveis DISTINTAS, e e ela que a rota
 * compara. `variaveisDoCorpo` da os NUMEROS usados, e a diferenca importa: um
 * corpo que usa `{{1}}` e `{{3}}` (sem `{{2}}`) tem 2 variaveis distintas, e um
 * formulario que desenhasse 3 campos mandaria 3 parametros — que a rota recusa.
 * Os rotulos saem dos numeros REAIS.
 */
export function camposDoTemplate(t: TemplateCanal): number[] {
  const numeros = variaveisDoCorpo(t.corpo);
  return numeros.length ? numeros : [];
}

/**
 * O que impede enviar com estes parametros.
 *
 * Duas camadas, e a PRIMEIRA e um achado desta frente, medido:
 *
 * 1. NUMERACAO COM BURACO. `validarParametros` cobra a quantidade de variaveis
 *    DISTINTAS, e o envio manda os valores por POSICAO (`params: [...]` no corpo
 *    do Gupshup, e `renderizarTemplate` trocando `{{n}}` por `params[n-1]`). Num
 *    corpo "Ola {{1}}, sua consulta e dia {{3}}" isso da 2 variaveis distintas,
 *    dois parametros, `validarParametros` OK — e o texto GRAVADO na conversa sai
 *    "Ola Eric, sua consulta e dia {{3}}." (medido, 31/08/2026), enquanto o
 *    provedor casa o 2o valor com um `{{2}}` que nao existe. Ou seja: o cliente
 *    recebe uma coisa e o historico registra outra — a classe de defeito que este
 *    repo persegue, e sem erro em lugar nenhum.
 *
 *    A Meta so aprova template numerado de 1 em diante, entao isso e catalogo
 *    ESTRAGADO (espelho velho, template criado por fora); mas "nao deveria
 *    existir" nunca foi motivo pra tela enviar errado. O envio para AQUI, com o
 *    motivo na tela — e nao no seletor: sumir com o template faria o atendente
 *    procurar o que ele sabe que existe. NAO e correcao da rota, que continua
 *    aceitando (fronteira da frente U; declarado no report).
 *
 * 2. A MESMA `validarParametros` DA ROTA: quantidade exata, nada vazio, nada com
 *    quebra de linha (a Meta recusa o envio inteiro por causa de um `\n` num
 *    parametro). Chamar aqui faz o erro aparecer no formulario; a rota recusa de
 *    todo jeito.
 */
export function problemaDosParametros(t: TemplateCanal, params: readonly string[]): string | null {
  const numeros = camposDoTemplate(t);
  const comBuraco = numeros.some((num, i) => num !== i + 1);
  if (comBuraco) {
    return (
      `o template "${t.nome}" numera as variaveis com buraco (${numeros.map((x) => `{{${x}}}`).join(" ")}) ` +
      "e o envio casa os valores por POSICAO — nao ha como saber qual valor vai em qual. " +
      "Quem cuida dos numeros precisa renumerar o template de 1 em diante na Meta."
    );
  }
  const v = validarParametros(t, [...params]);
  return v.ok ? null : v.motivo;
}

/**
 * A PREVIA do que o cliente vai ler.
 *
 * Ela existe porque template aprovado NAO SE EDITA: o atendente nao escreve a
 * mensagem, ele preenche buracos num texto que a Meta aprovou. Sem ver o
 * resultado, preencher `{{1}}` e `{{2}}` as cegas e como enviar de olhos
 * fechados — e depois de sair, nao ha como corrigir.
 *
 * `renderizarTemplate` e a mesma funcao que a rota usa pra GRAVAR o conteudo da
 * mensagem, entao a previa e literalmente o que vai ficar no historico.
 */
export function previaDoTemplate(t: TemplateCanal, params: readonly string[]): string {
  const corpo = renderizarTemplate(t.corpo, [...params]);
  return t.rodape ? `${corpo}\n\n${t.rodape}` : corpo;
}
