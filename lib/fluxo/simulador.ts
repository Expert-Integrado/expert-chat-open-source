// SIMULADOR DE FLUXO — "o que aconteceria com esta mensagem", sem enviar nada.
//
// Frente P, 31/08/2026. Card 86ak85a69.
//
// POR QUE ISTO EXISTE (docs/mapa/05, secao 9): a ferramenta de origem NAO tem modo
// de teste. Com 935 dialogos (a conta medida na origem) competindo pela mesma
// mensagem e condicao escrita em
// texto, depurar automacao la e adivinhacao. O simulador e a diferenca mais
// visivel que o nosso editor pode ter, e e barato: o motor JA sabe avaliar
// condicao (`avaliarCondicao`, da Frente L) — o simulador so roda essa avaliacao
// em seco e mostra o resultado.
//
// ================== A GARANTIA DESTE ARQUIVO: ZERO EFEITO ==================
// Ele importa SO `./schema.ts` — nao tem banco, nao tem provedor, nao tem `fetch`.
// Nao existe caminho daqui pra `enviarTexto` nem pra qualquer escrita. A prova
// (`scripts/prova-motor-fila.ts`) reprova se este arquivo passar a importar
// qualquer coisa fora do schema. E o que permite o simulador ser exposto numa
// rota de LEITURA (`GET /api/fluxos?simular=1`), sem gate de execucao.
//
// O que ele NAO decide: QUEM GANHA quando dois fluxos sao elegiveis pra mesma
// mensagem. Isso e pergunta aberta (docs/mapa/05, secao 10: "e comportamento de
// servidor deles; decisao nossa") e prioridade entre fluxos ainda nao existe no
// formato canonico. O simulador lista TODOS os elegiveis, na ordem que recebeu, e
// diz qual seria o primeiro — com o criterio escrito na cara. Inventar um
// vencedor aqui seria ensinar ao usuario uma regra que o motor nao tem.

import {
  alcancaCliente,
  avaliarCondicao,
  camposDaCondicao,
  noAtivo,
  ordemDeExecucao,
  passosQueRodam,
  type Acao,
  type CampoCondicao,
  type FatosConversa,
  type Fluxo,
  type No,
} from "./schema.ts";

/** Uma linha do fluxo simulado. */
export type PassoSimulado = {
  no_id: string;
  /** tipo da acao, ou "condicao" */
  acao: string;
  /** "rodaria" | "parou" | "pulado" | "desligado" */
  situacao: "rodaria" | "parou" | "pulado" | "desligado";
  /** o que ele faria, em portugues */
  detalhe: string;
  /** segundos de atraso acumulados ate este passo (0 = sai na hora) */
  atraso_segundos: number;
  /** este passo pararia esperando aprovacao humana */
  aprovacao: boolean;
};

export type FluxoSimulado = {
  slug: string;
  nome: string;
  tipo: string;
  ativo: boolean;
  /** o fluxo seria disparado por esta mensagem? */
  elegivel: boolean;
  /** por que sim ou por que nao — sempre preenchido */
  motivo: string;
  /** ele MANDARIA mensagem pro cliente? (o que a pergunta "qual responderia" quer saber) */
  responderia: boolean;
  /** os textos que sairiam, na ordem */
  textos: string[];
  passos: PassoSimulado[];
  /** avisos honestos sobre o que a simulacao NAO consegue prever */
  ressalvas: string[];
};

export type ResultadoSimulacao = {
  /** todos os fluxos avaliados, na ordem em que foram recebidos */
  fluxos: FluxoSimulado[];
  /** quantos seriam disparados por esta mensagem */
  elegiveis: number;
  /** o primeiro elegivel que responderia (ou null) */
  primeiro: string | null;
  /**
   * COMO o "primeiro" foi escolhido. Escrito por extenso de proposito: o usuario
   * precisa saber que isto NAO e prioridade configurada.
   */
  criterio_de_ordem: string;
  /** ressalvas que valem pra simulacao inteira */
  ressalvas: string[];
};

export const CRITERIO_DE_ORDEM =
  "ordem em que os fluxos foram lidos (nome). Prioridade entre fluxos elegiveis ainda NAO existe no formato canonico — quando existir, este campo muda.";

const RESSALVA_STATUS_AO_RESPONDER =
  "responder pode mover a conversa pra 'Em atendimento' dependendo da configuracao da instalacao; a simulacao NAO mexe no status aqui pra nao chutar a config.";

const norm = (s: unknown) => (typeof s === "string" ? s : "");

// ------------------------------------------------------------ efeito previsto

/**
 * Copia dos fatos com o efeito PREVISTO de uma acao aplicado.
 *
 * Isto e o que separa simulacao honesta de teatro: um fluxo que faz
 * `definir_contexto URA=MENU` e depois pergunta `contexto[URA] igual MENU` tem que
 * simular VERDADEIRO — e foi exatamente esse o defeito que a revisao cega pegou no
 * motor de verdade (a condicao decidia em dado velho). Aqui a mesma tabela de
 * "quem suja o que" e aplicada, mas em memoria.
 *
 * O que NAO e previsto, e esta declarado como ressalva em vez de chutado:
 *  - `enviar_texto` mexe em `status` na vida real (auto atendimento ao responder),
 *    mas isso depende da CONFIG da instalacao — a simulacao nao inventa;
 *  - `atribuir_responsavel` e `nota_interna` nao sao campo de condicao da v1.
 */
export function efeitoPrevisto(fatos: FatosConversa, acao: Acao): FatosConversa {
  const novo: FatosConversa = {
    ...fatos,
    etiquetas: [...(fatos.etiquetas ?? [])],
    etapas: [...(fatos.etapas ?? [])],
    contexto: { ...(fatos.contexto ?? {}) },
  };
  switch (acao.tipo) {
    case "mudar_status":
      novo.status = acao.status;
      return novo;
    case "etiquetar": {
      const atuais = novo.etiquetas ?? [];
      if (acao.modo === "substituir") novo.etiquetas = [...acao.etiquetas];
      else if (acao.modo === "remover") novo.etiquetas = atuais.filter((e) => !acao.etiquetas.includes(e));
      else novo.etiquetas = Array.from(new Set([...atuais, ...acao.etiquetas]));
      return novo;
    }
    case "mover_funil": {
      // mover DENTRO de um funil nunca mexe nos outros funis da conversa (regra
      // da Frente D); `etapa: null` tira a conversa daquele funil
      const fora = (novo.etapas ?? []).filter((e) => norm(e.funil) !== acao.funil);
      novo.etapas = acao.etapa === null ? fora : [...fora, { funil: acao.funil, etapa: acao.etapa }];
      return novo;
    }
    case "definir_contexto":
      novo.contexto = { ...(novo.contexto ?? {}), [acao.chave]: acao.valor };
      return novo;
    case "limpar_contexto": {
      const mapa = { ...(novo.contexto ?? {}) };
      // apagar a chave e DIFERENTE de gravar vazio: so apagando o `nao_existe`
      // volta a valer (regra da Frente L)
      delete mapa[acao.chave];
      novo.contexto = mapa;
      return novo;
    }
    default:
      return novo;
  }
}

function resumoDaAcao(acao: Acao): string {
  switch (acao.tipo) {
    case "enviar_texto":
      return `responderia: "${acao.texto.slice(0, 120)}${acao.texto.length > 120 ? "..." : ""}"`;
    case "nota_interna":
      return `gravaria uma nota interna (${acao.texto.length} chars)`;
    case "etiquetar":
      return `etiquetas (${acao.modo}): ${acao.etiquetas.join(", ")}`;
    case "mudar_status":
      return `status viraria "${acao.status}"`;
    case "atribuir_responsavel":
      return `responsaveis: ${acao.responsaveis.map((r) => `${r.tipo}:${r.nome}`).join(", ")}`;
    case "mover_funil":
      return acao.etapa === null
        ? `sairia do funil "${acao.funil}"`
        : `iria pra etapa "${acao.etapa}" do funil "${acao.funil}"`;
    case "espera":
      return `esperaria ${acao.segundos}s${acao.pular_fim_de_semana ? " (pulando o fim de semana)" : ""}`;
    case "definir_contexto":
      return `gravaria ${acao.chave} = "${acao.valor.slice(0, 60)}"`;
    case "limpar_contexto":
      return `apagaria a variavel ${acao.chave}`;
    // FRENTE W (card 86ak85bmw). O simulador NAO confere se a chave existe na
    // biblioteca de proposito: ele importa SO o schema (zero banco, zero
    // provedor, e a prova reprova se isso mudar), e conferir exigiria ler o
    // acervo. O resumo diz a chave na cara, que e o que permite a pessoa notar
    // que o fluxo aponta pra um item que ela nao reconhece.
    case "anexar_biblioteca":
      return acao.legenda
        ? `mandaria o arquivo "${acao.anexo}" da biblioteca com legenda: "${acao.legenda.slice(0, 80)}"`
        : `mandaria o arquivo "${acao.anexo}" da biblioteca`;
    // FRENTE Y — a pergunta com opcoes. O resumo NAO diz "botoes" nem "lista"
    // por conta propria: quem decide isso e `planoDeEnvio` (lib/interativas.ts),
    // que depende da FONTE do canal, e o simulador nao conhece canal — ele roda
    // sobre fatos, sem banco e sem env (a prova reprova se ele importar algo
    // alem do schema). Dizer "sairiam botoes" aqui seria prometer um desenho que
    // o canal pode nao entregar. O tipo PEDIDO sai como pedido, e o modo REAL
    // aparece na trilha depois do envio.
    case "perguntar_opcoes":
      return `perguntaria "${acao.params.texto.slice(0, 80)}" com ${acao.params.opcoes.length} opcoes (pedido: ${acao.params.tipo})`;
  }
}

// ------------------------------------------------------------ o percurso seco

/**
 * A CONDICAO DE ENTRADA de um fluxo de gatilho: o primeiro no de condicao da
 * corrente, quando ele vem ANTES de qualquer acao.
 *
 * Por que "antes de qualquer acao": o conversor do ChatGuru grava a condicao do
 * dialogo como PRIMEIRO no da corrente (e assim que a condicao de entrada de la
 * caber no formato daqui). Uma condicao que aparece no MEIO e outra coisa — e
 * decisao de continuar, nao de disparar — e tratar as duas igual faria o
 * simulador dizer "nao dispara" pra fluxo que dispara sim, so porque a checagem
 * dele fica no passo 3.
 */
export function condicaoDeEntrada(fluxo: Fluxo): No | null {
  // passo DESLIGADO nao conta pra decidir qual e a condicao de entrada: uma
  // condicao desligada nao filtra nada, e uma acao desligada antes dela nao
  // "consome" a entrada
  for (const no of passosQueRodam(fluxo)) {
    if (no.tipo === "condicao") return no.condicao ? no : null;
    if (no.acao) return null;
  }
  return null;
}

/** Campos de condicao que ESTE fluxo consulta — o que a tela precisa pedir. */
export function camposUsadosPeloFluxo(fluxo: Fluxo): CampoCondicao[] {
  const acc = new Set<CampoCondicao>();
  for (const no of fluxo.nos) {
    if (no.condicao) camposDaCondicao(no.condicao, acc);
    for (const r of no.ramos ?? []) if (r.condicao) camposDaCondicao(r.condicao, acc);
  }
  return [...acc];
}

export type EntradaSimulacao = {
  slug: string;
  nome: string;
  ativo: boolean;
  fluxo: Fluxo;
};

/**
 * Simula UM fluxo contra um conjunto de fatos.
 *
 * Fatos que a condicao pede e a tela nao informou: a condicao decide FAIL-CLOSED
 * (campo ausente derruba comparacao de valor), igual na vida real — e a ressalva
 * diz quais campos ficaram em branco, pra ninguem confundir "nao dispara" com
 * "voce nao me disse o status".
 */
export function simularFluxo(entrada: EntradaSimulacao, fatosIniciais: FatosConversa): FluxoSimulado {
  const { fluxo } = entrada;
  const base: FluxoSimulado = {
    slug: entrada.slug,
    nome: entrada.nome,
    tipo: fluxo.tipo,
    ativo: entrada.ativo,
    elegivel: false,
    motivo: "",
    responderia: false,
    textos: [],
    passos: [],
    ressalvas: [],
  };

  if (!entrada.ativo) {
    base.motivo = "o fluxo esta DESLIGADO nesta instalacao";
    return base;
  }
  if (fluxo.tipo === "macro") {
    // Macro nao concorre pela mensagem: ele existe pra um atendente clicar. Dizer
    // "nao dispara" sem essa palavra faria parecer defeito de condicao.
    base.motivo = "macro: roda quando um atendente dispara, nunca sozinho por mensagem recebida";
  }

  const corrente = ordemDeExecucao(fluxo);
  if (!corrente.length) {
    base.motivo = "fluxo sem nenhum passo na corrente";
    return base;
  }

  const entradaNo = condicaoDeEntrada(fluxo);
  let fatos = fatosIniciais;
  let atraso = 0;
  let parou = false;
  let parouEsperandoAval = false;
  let entradaBateu = true;

  for (const no of corrente) {
    // PASSO DESLIGADO: aparece na simulacao (senao a pessoa nao entende por que a
    // mensagem nao sai) e nao produz efeito nenhum — nem texto, nem atraso.
    if (!noAtivo(no)) {
      base.passos.push({
        no_id: no.id,
        acao: no.tipo === "condicao" ? "condicao" : (no.acao?.tipo ?? "?"),
        situacao: "desligado",
        detalhe: "passo DESLIGADO: nao roda, e o fluxo segue pro proximo",
        atraso_segundos: atraso,
        aprovacao: false,
      });
      continue;
    }
    if (parou || parouEsperandoAval) {
      base.passos.push({
        no_id: no.id,
        acao: no.tipo === "condicao" ? "condicao" : (no.acao?.tipo ?? "?"),
        situacao: "pulado",
        detalhe: parouEsperandoAval ? "depende da aprovacao do passo anterior" : "o fluxo parou antes deste passo",
        atraso_segundos: atraso,
        aprovacao: no.aprovacao === true,
      });
      continue;
    }

    if (no.tipo === "condicao") {
      if (!no.condicao) {
        base.passos.push({
          no_id: no.id,
          acao: "condicao",
          situacao: "parou",
          detalhe: "no de condicao sem condicao: na vida real este passo FALHA",
          atraso_segundos: atraso,
          aprovacao: false,
        });
        parou = true;
        continue;
      }
      const bateu = avaliarCondicao(no.condicao, fatos);
      base.passos.push({
        no_id: no.id,
        acao: "condicao",
        situacao: bateu ? "rodaria" : "parou",
        detalhe: bateu ? "condicao verdadeira: segue" : "condicao FALSA: o fluxo para aqui",
        atraso_segundos: atraso,
        aprovacao: false,
      });
      if (!bateu) {
        parou = true;
        if (entradaNo && no.id === entradaNo.id) entradaBateu = false;
      }
      continue;
    }

    // no de espera: nao e efeito, e RELOGIO. Ele empurra os passos seguintes.
    if (no.acao?.tipo === "espera") {
      atraso += no.acao.segundos;
      base.passos.push({
        no_id: no.id,
        acao: "espera",
        situacao: "rodaria",
        detalhe: resumoDaAcao(no.acao),
        atraso_segundos: atraso,
        aprovacao: false,
      });
      continue;
    }

    if (!no.acao) {
      base.passos.push({
        no_id: no.id,
        acao: no.tipo,
        situacao: "parou",
        detalhe: `no de tipo ${no.tipo} sem acao: na vida real este passo FALHA`,
        atraso_segundos: atraso,
        aprovacao: no.aprovacao === true,
      });
      parou = true;
      continue;
    }

    // MESMA REGRA DO MOTOR, e por isso ela nao e reimplementada aqui: aval so
    // vale onde a acao alcanca o cliente (`alcancaCliente`, schema.ts). Se o
    // simulador dissesse "PARARIA esperando aprovacao" num passo de nota interna,
    // ele mandaria a pessoa consertar um fluxo que roda direto — o defeito que a
    // primeira revisao pegou aqui em outro campo.
    const pedeAval = no.aprovacao === true && alcancaCliente(no);
    base.passos.push({
      no_id: no.id,
      acao: no.acao.tipo,
      situacao: pedeAval ? "parou" : "rodaria",
      detalhe: pedeAval ? `PARARIA esperando aprovacao humana antes de: ${resumoDaAcao(no.acao)}` : resumoDaAcao(no.acao),
      atraso_segundos: atraso,
      aprovacao: pedeAval,
    });
    if (pedeAval) {
      parouEsperandoAval = true;
      continue;
    }
    if (no.acao.tipo === "enviar_texto") {
      base.textos.push(no.acao.texto);
      base.ressalvas.push(RESSALVA_STATUS_AO_RESPONDER);
    }
    fatos = efeitoPrevisto(fatos, no.acao);
  }

  base.elegivel = fluxo.tipo === "gatilho" && entradaBateu;
  base.responderia = base.elegivel && base.textos.length > 0;
  if (!base.motivo) {
    base.motivo = entradaBateu
      ? entradaNo
        ? "a condicao de entrada bateu"
        : "sem condicao de entrada: dispara pra qualquer mensagem"
      : "a condicao de entrada nao bateu";
  }
  base.ressalvas = Array.from(new Set(base.ressalvas));
  return base;
}

/**
 * Simula uma mensagem contra N fluxos.
 *
 * `campos_em_branco` diz quais campos de condicao os fluxos consultam e a tela
 * NAO informou. Sem isso o resultado engana: um fluxo que pergunta pela etapa do
 * funil apareceria como "nao dispara" quando a verdade e "ninguem me disse em que
 * etapa a conversa esta".
 */
export function simularMensagem(
  entradas: EntradaSimulacao[],
  fatos: FatosConversa,
  informados: CampoCondicao[]
): ResultadoSimulacao {
  const fluxos = entradas.map((e) => simularFluxo(e, fatos));
  const informadosSet = new Set(informados);
  const emBranco = new Set<CampoCondicao>();
  for (const e of entradas) {
    for (const c of camposUsadosPeloFluxo(e.fluxo)) if (!informadosSet.has(c)) emBranco.add(c);
  }

  const ressalvas: string[] = [];
  if (emBranco.size) {
    ressalvas.push(
      `estes campos de condicao nao foram informados e por isso contam como AUSENTES (a condicao decide fail-closed): ${[...emBranco].join(", ")}`
    );
  }
  const respondem = fluxos.filter((f) => f.responderia);
  if (respondem.length > 1) {
    ressalvas.push(
      `${respondem.length} fluxos responderiam a esta mensagem. ${CRITERIO_DE_ORDEM}`
    );
  }

  return {
    fluxos,
    elegiveis: fluxos.filter((f) => f.elegivel).length,
    primeiro: respondem[0]?.slug ?? null,
    criterio_de_ordem: CRITERIO_DE_ORDEM,
    ressalvas,
  };
}
