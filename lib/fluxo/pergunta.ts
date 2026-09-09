// A DECISAO da pergunta com opcoes, separada do ENVIO (Frente Y, 31/08/2026).
//
// POR QUE ESTE ARQUIVO EXISTE — a revisao cega mediu o preco de nao ter:
// `perguntarOpcoes` e `enviarTexto` vivem em `lib/fluxo/executar.ts`, que importa
// banco, provedor e config. Nenhuma prova consegue carregar aquele arquivo, entao
// tudo o que decidia ali estava provado por GREP DE FORMA ("delega pro
// enviarTexto") e nunca por DESFECHO — e oito mutacoes que mudam o que o CLIENTE
// recebe passavam com a bateria verde:
//
//   * tirar `modo === "nativo"` do ramo Z-API => botao sai NATIVO num numero em
//     que a propria doc da Z-API declara que botao vem falhando;
//   * `grupo: false` => lista sai NATIVA em GRUPO, que a Z-API declara que nao
//     funciona;
//   * a pergunta voltar a ser ASSINADA => `*Nome:*` na frente do corpo estoura o
//     teto da Meta e ela recusa a mensagem INTEIRA;
//   * a previa/o tipo/o conteudo gravados fixos em "nativo" => a barra lateral
//     diz `[botoes]` numa mensagem que saiu como texto numerado, e o relatorio
//     afirma um recurso que nao houve.
//
// Nenhuma dessas quebra build, tipo ou teste. Aqui elas sao funcao PURA, com
// desfecho medido em `scripts/prova-costuras-y.ts`.
//
// A REGRA DE PROVEDOR NAO MORA AQUI: quem decide nativo x texto numerado e
// `planoDeEnvio` (lib/interativas.ts, da Frente S). Este arquivo so a CONSULTA e
// traduz a resposta em "qual porta chamar e o que fica gravado".
import {
  planoDeEnvio,
  previaDoEnviado,
  resumoDoEnviado,
  textoNumerado,
  tipoDeMensagem,
  type Interativa,
} from "../interativas.ts";

/**
 * A porta do provedor que a pergunta vai usar.
 *
 * E um valor, nao um `if` espalhado: com quatro `if` dentro da funcao de envio,
 * trocar `modo === "nativo"` por `true` num deles era invisivel pra bateria.
 */
export type RotaDaPergunta = "gupshup_nativo" | "zapi_nativo" | "gupshup_texto" | "zapi_texto";

export type PlanoDaPergunta = {
  modo: "nativo" | "texto_numerado";
  /** por que caiu no fallback (null quando foi nativo) — vem de `planoDeEnvio` */
  motivo: string | null;
  rota: RotaDaPergunta | null;
  /** o corpo do FALLBACK, calculado UMA vez (sai pelo provedor e fica gravado) */
  numerado: string;
  previa: string;
  conteudo: string;
  tipo: string;
  detalhe: string;
};

/**
 * Conversa de GRUPO? O sufixo `-group` no chat_id e a marca do provedor.
 *
 * Isto era um regex solto dentro de `perguntarOpcoes`. Vira funcao porque e ele
 * que decide se a lista sai nativa ou numerada num numero Z-API — e um `false`
 * digitado no lugar dele nao muda nada que a bateria enxergasse.
 */
export function ehGrupo(chatId: unknown): boolean {
  return /-group$/.test(String(chatId ?? ""));
}

/**
 * O plano completo da pergunta: qual porta chamar, e o que fica gravado.
 *
 * `fonte` e `chatId` entram crus (nao `ContextoExecucao`) exatamente pra esta
 * funcao rodar em node solto, sem banco e sem canal registrado.
 */
export function planoDaPergunta(fonte: string, chatId: string, msg: Interativa): PlanoDaPergunta {
  const plano = planoDeEnvio(fonte, msg.tipo, { grupo: ehGrupo(chatId) });
  const nativo = plano.modo === "nativo";
  // A ROTA SO E NATIVA NAS DUAS FONTES QUE TEM ENVIO INTERATIVO CABEADO. Fonte
  // que nao seja `gupshup` nem `zapi` (evolution, e o que vier depois) vira
  // `null`, e quem envia RECUSA em vez de improvisar uma porta.
  //
  // Isto e defesa em profundidade, nao o unico portao — e vale dizer com
  // precisao, porque prosa exagerada em comentario e o que faz a proxima frente
  // achar que ja esta protegida. HOJE o braco `null` e INALCANCAVEL: quem envia
  // e `enviarTexto` (lib/fluxo/executar.ts), que faz `if gupshup / else if zapi
  // / else throw` ANTES de chamar `especial.enviar` — com fonte desconhecida ele
  // ja estoura, e o `switch` desta rota nem roda. O valor do `null` e o dia em
  // que alguem cabear uma fonte nova naquele if-else: sem ele, a pergunta com
  // opcoes passaria a sair como TEXTO por uma porta que nunca soube de
  // interativa, calada. Com ele, o passo falha com motivo.
  const rota: RotaDaPergunta | null =
    fonte === "gupshup" ? (nativo ? "gupshup_nativo" : "gupshup_texto")
    : fonte === "zapi" ? (nativo ? "zapi_nativo" : "zapi_texto")
    : null;
  return {
    modo: plano.modo,
    motivo: plano.motivo,
    rota,
    numerado: textoNumerado(msg),
    previa: previaDoEnviado(msg, plano.modo),
    conteudo: resumoDoEnviado(msg, plano.modo),
    tipo: tipoDeMensagem(msg, plano.modo),
    // A TRILHA DIZ O MODO REAL. "pergunta enviada" para uma que saiu como texto
    // numerado esconde justamente o que o atendente precisa saber quando o
    // cliente responde "2" em vez de apertar o botao.
    detalhe:
      plano.modo === "texto_numerado"
        ? `pergunta enviada como TEXTO NUMERADO (${msg.opcoes.length} opcoes) — ${plano.motivo ?? "fallback"}`
        : `pergunta enviada (${msg.tipo}, ${msg.opcoes.length} opcoes)`,
  };
}

/** Os rotulos que a saida especial troca em `enviarTexto`. */
export type CamposEspeciais = { previa: string; conteudo: string; tipo: string; detalhe: string };

export type SaidaDaMensagem = {
  /** false na saida especial — ver o comentario abaixo, e nao e detalhe */
  assinar: boolean;
  previa: string;
  tipo: string;
  /** null = grava o texto que saiu pela porta (o assinado) */
  conteudo: string | null;
  detalhe: string;
};

/**
 * O CONTRATO INTEIRO de "saida especial x texto normal" dentro de `enviarTexto`,
 * numa funcao so.
 *
 * Eram CINCO ternarios `especial ? ... : ...` espalhados por 120 linhas daquela
 * funcao, cada um numa mutacao propria e nenhum alcancavel por prova. Juntos aqui
 * eles viram desfecho medido — e, de quebra, some a chance de alguem corrigir
 * quatro e esquecer o quinto.
 *
 * `assinar: false` NA SAIDA ESPECIAL NAO E ESTILO. A assinatura poe `*Nome:*` na
 * frente do corpo; num interativo o corpo tem teto de plataforma (1024 na Meta) e
 * o texto ja passou por `validarInterativa` COM o tamanho final. Assinar depois
 * estoura o teto e a Meta recusa a mensagem inteira — o cliente nao recebe nada e
 * o painel diz "enviado".
 */
export function saidaDaMensagem(texto: string, especial?: CamposEspeciais | null): SaidaDaMensagem {
  if (!especial) {
    return {
      assinar: true,
      previa: texto,
      tipo: "text",
      conteudo: null,
      detalhe: `mensagem enviada (${texto.length} chars)`,
    };
  }
  return {
    assinar: false,
    previa: especial.previa,
    tipo: especial.tipo,
    conteudo: especial.conteudo,
    detalhe: especial.detalhe,
  };
}
