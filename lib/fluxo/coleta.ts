// A LINHA DE CONVERSA VIRANDO FATO — a coleta que a condicao de fluxo usa
// (Frente X, card 86ak85nxn), PURA e com o leitor injetado.
//
// POR QUE ESTE ARQUIVO EXISTE, e nao mora em `lib/fluxo/schema.ts`:
// `schema.ts` e o CONTRATO DE FORMATO do fluxo (nos, acoes, condicao) e e
// compartilhado com os conversores do ChatGuru. O formato da LINHA de
// `mensageria.conversas` — quais colunas se le, o que cada resposta do banco
// significa — nao e contrato de fluxo, e vizinhanca de banco. Na 3a rodada da
// re-revisao cega a decisao foi parar la por falta de casa; na 4a ela ganhou a
// propria, seguindo o precedente que a Frente Y abriu nesta mesma onda
// (`lib/fluxo/pergunta.ts`, em vez de alargar o contrato).
//
// O INVARIANTE QUE MANTEM ISTO PROVAVEL: ZERO import de valor. So `import type`
// (apagado pelo type-stripping do node), entao a prova importa este arquivo
// direto — sem alias `@/`, sem banco, sem env. `lib/fluxo/executar.ts` arrasta
// banco e provedor e NENHUMA prova consegue importa-lo: tudo que decide aqui e
// desfecho medido, tudo que ficasse la seria varredura de token.
//
// A DEPENDENCIA E DE MAO UNICA (`coleta.ts -> schema.ts`), e o tipo do resultado
// (`ResultadoColeta`) ficou LA: ele e o retorno de `DepsPercurso.coletar`, ou seja
// contrato de verdade. Re-exportar o tipo DE CA pra la exigiria um `import` em
// `schema.ts`, e a guarda de arquitetura da `prova-motor-fila` (bloco 10) le o
// FONTE, nao o runtime: `import type` conta como import ali, com razao — quem
// mantem o contrato publico nao quer descobrir uma dependencia nova lendo o
// type-stripping.
import type { CampoCondicao, FatosConversa, ResultadoColeta } from "./schema.ts";

export type { ResultadoColeta };

/**
 * OS CAMPOS QUE SAEM DA MESMA LINHA DE `conversas` — e a REGRA PRO MERGE.
 *
 * `status`, `etiqueta` e `ficha` saem de UMA leitura: dois SELECT na mesma linha
 * podem pegar estados diferentes se alguem gravar no meio, e ai duas condicoes da
 * MESMA arvore falariam de retratos distintos da conversa.
 *
 * **CAMPO NOVO QUE SAIR DESTA LINHA ENTRA AQUI E EM `coletaDaLinhaDeConversa` —
 * NUNCA na fiacao de `coletarFatos`.** O instinto (e a versao antiga do arquivo)
 * manda escrever o ramo novo dentro de `coletarFatos`, em `lib/fluxo/executar.ts`;
 * o git aceita calado e o ramo nasce fora do alcance de qualquer prova, que e
 * exatamente onde o fail-open da `ficha` morava. Esta constante e o freio: a prova
 * percorre ela e cobra que uma leitura que FALHOU marque CADA campo listado como
 * indisponivel. Campo adicionado aqui sem tratamento na decisao pura REPROVA a
 * bateria; campo tratado so na fiacao nunca aparece aqui e a condicao dele decide
 * contra dado inventado, sem erro em lugar nenhum.
 */
export const CAMPOS_DA_LINHA_DE_CONVERSA = ["status", "etiqueta", "ficha"] as const;

export type CampoDaLinhaDeConversa = (typeof CAMPOS_DA_LINHA_DE_CONVERSA)[number];

/** true quando a condicao pede ao menos um campo que sai desta linha */
export function pedeALinhaDeConversa(campos: ReadonlySet<CampoCondicao>): boolean {
  return CAMPOS_DA_LINHA_DE_CONVERSA.some((c) => campos.has(c));
}

/**
 * AS COLUNAS DO SELECT.
 *
 * `status` e `etiquetas` saem SEMPRE que a linha vem (a decisao preenche os dois
 * assim que ha linha), entao a unica coluna sob demanda e a cara: `ficha` (jsonb,
 * que pode ter dezenas de chaves por conversa). Trazer `ficha` num macro que so
 * olha status seria pagar o jsonb inteiro por nada.
 */
export function colunasDaLinhaDeConversa(campos: ReadonlySet<CampoCondicao>): string[] {
  const colunas = ["status", "etiquetas"];
  if (campos.has("ficha")) colunas.push("ficha");
  return colunas;
}

/**
 * OS FATOS QUE SAEM DA LINHA DE CONVERSA — decisao PURA, e ela FALHA FECHADO.
 *
 * Quem LE e `coletarFatos` (lib/fluxo/executar.ts, que fala com banco); quem
 * DECIDE o que a resposta do banco significa e esta funcao, que roda sem banco e
 * sem env.
 *
 * A REGRA: leitura que falhou NAO vira ficha vazia. Ficha vazia faria toda
 * comparacao de valor dar `false` (regra 1 do avaliador) e o macro pararia com
 * cara de "condicao avaliada" — decidindo contra uma ficha inventada, sem erro em
 * lugar nenhum. O desfecho certo e `indisponiveis.ficha`, que PARA a decisao.
 *
 * POR QUE ELA E PURA (3a rodada da re-revisao cega, 31/08/2026): enquanto morava
 * dentro de `coletarFatos`, a unica guarda possivel era varredura de token, e ela
 * errava nas DUAS direcoes. `indisponiveis["ficha"] =` (mesma semantica, outra
 * forma) REPROVAVA; `if (campos.has("ficha") && error)` (propriedade destruida,
 * forma preservada) PASSAVA — e com ele "conversa nao encontrada" deixava de
 * marcar indisponivel, `fatos.ficha` ficava `undefined`, e o macro decidia contra
 * uma ficha inventada. Aqui a prova executa a funcao com a resposta do banco que
 * ela quiser e confere o DESFECHO.
 *
 * "conversa nao encontrada" (sem `error` e sem linha) e o caso que mais importa:
 * `maybeSingle()` devolve exatamente isso quando o chat_id nao casa, e ele NAO
 * traz erro.
 */
export function coletaDaLinhaDeConversa(
  campos: ReadonlySet<CampoCondicao>,
  data: unknown,
  erro: unknown
): ResultadoColeta {
  const fatos: FatosConversa = {};
  const indisponiveis: Partial<Record<CampoCondicao, string>> = {};

  if (erro || !data) {
    const msg =
      erro && typeof erro === "object" && "message" in (erro as Record<string, unknown>)
        ? String((erro as Record<string, unknown>).message ?? "")
        : "";
    const motivo = msg || "conversa nao encontrada";
    if (campos.has("status")) indisponiveis.status = motivo;
    if (campos.has("etiqueta")) indisponiveis.etiqueta = motivo;
    if (campos.has("ficha")) indisponiveis.ficha = motivo;
    return { fatos, indisponiveis };
  }

  const linha = data as Record<string, unknown>;
  fatos.status = (linha.status as string | null) ?? null;
  fatos.etiquetas = Array.isArray(linha.etiquetas)
    ? (linha.etiquetas as unknown[]).filter((e): e is string => typeof e === "string")
    : [];

  if (campos.has("ficha")) {
    // A ficha e jsonb e aceita numero/booleano/objeto (gravado por fora, ou por
    // uma versao futura). Devolver cru faria a condicao comparar "1" com 1 e nunca
    // casar; objeto/lista nao viram texto e SOMEM da leitura, como em
    // `normalizarContexto`.
    const mapa: Record<string, string> = Object.create(null);
    const bruto = linha.ficha;
    if (bruto && typeof bruto === "object" && !Array.isArray(bruto)) {
      for (const [k, v] of Object.entries(bruto as Record<string, unknown>)) {
        if (typeof v === "string") mapa[k] = v;
        else if (typeof v === "number" || typeof v === "boolean") mapa[k] = String(v);
      }
    }
    fatos.ficha = mapa;
  }

  return { fatos, indisponiveis };
}

/**
 * O LEITOR da linha, injetado. Devolve a resposta CRUA do cliente do banco —
 * `data` e `erro` como vieram.
 *
 * Ele nao interpreta nada de proposito: adaptador que interpreta e adaptador que
 * pode MENTIR pra decisao. `{ data: data ?? [], erro: null }` — a forma "tolerante"
 * que um dev escreve sem perceber — apagaria o erro do banco, e a partir dai a
 * condicao decidiria contra uma conversa inventada. A prova exercita esta funcao
 * com um leitor que falha e cobra o `indisponiveis` no OUTRO lado.
 */
export type LeitorDaLinhaDeConversa = (colunas: string[]) => Promise<{ data: unknown; erro: unknown }>;

/**
 * LER A LINHA E DECIDIR, num gesto so.
 *
 * Existe pra que a escolha das colunas, a chamada do leitor e a leitura da
 * resposta fiquem AQUI, onde a prova roda de verdade com um leitor fake e confere
 * o desfecho — e nao no motor, que nenhuma prova consegue importar.
 *
 * Condicao que nao pede nenhum campo desta linha nao gasta consulta: o leitor
 * sequer e chamado.
 */
export async function fatosDaLinhaDeConversa(
  campos: ReadonlySet<CampoCondicao>,
  ler: LeitorDaLinhaDeConversa
): Promise<ResultadoColeta> {
  if (!pedeALinhaDeConversa(campos)) return { fatos: {}, indisponiveis: {} };
  const { data, erro } = await ler(colunasDaLinhaDeConversa(campos));
  return coletaDaLinhaDeConversa(campos, data, erro);
}

/**
 * O QUE `coletarFatos` CHAMA — e por que ela ESCREVE nos mapas do chamador em vez
 * de devolver o resultado.
 *
 * A versao anterior devolvia `ResultadoColeta` e o motor derramava com dois
 * `Object.assign`. Aquelas duas linhas moravam em `lib/fluxo/executar.ts`, que
 * arrasta banco e provedor: nenhuma prova as EXECUTA, entao a unica guarda
 * possivel era varredura de token — e ela cobrava a forma exata das tres linhas,
 * reprovando refatoracao inocua (medido na 4a rodada: `const colhido = ...` mais
 * dois `for…of` derramando nos mesmos mapas, mesma propriedade, REPROVAVA). Falso
 * positivo numa onda que vai fazer merge e pior que falso negativo: quebra por
 * motivo errado e alguem afrouxa a guarda.
 *
 * Escrevendo no destino, o derrame passou a ser CODIGO PROVADO (a prova chama esta
 * funcao com mapas de verdade e confere que os dois chegaram cheios) e o motor
 * ficou com UMA chamada — nao existe mais linha de derrame pra esquecer, e trocar
 * os dois mapas de lugar nao compila.
 *
 * `void` de proposito: quem chama empilha isto direto no `Promise.all` das outras
 * coletas, como os demais ramos de `coletarFatos`.
 */
export async function colherLinhaDeConversa(
  campos: ReadonlySet<CampoCondicao>,
  ler: LeitorDaLinhaDeConversa,
  fatos: FatosConversa,
  indisponiveis: Partial<Record<CampoCondicao, string>>
): Promise<void> {
  const r = await fatosDaLinhaDeConversa(campos, ler);
  Object.assign(fatos, r.fatos);
  Object.assign(indisponiveis, r.indisponiveis);
}
