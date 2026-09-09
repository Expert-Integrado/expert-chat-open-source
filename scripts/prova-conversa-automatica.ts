// Prova das regras de COMPORTAMENTO AUTOMATICO da conversa (Frente N):
// conversa reiniciada, status por evento (gente x robo), assinatura do atendente
// e modo supervisor.
// Roda em Node >= 22.6 sem build: `node scripts/prova-conversa-automatica.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// Aqui entra so o que e PURO — decisao. O efeito no banco (lib/conversa-reinicio.ts)
// e a revisao do codigo + o build, como nas outras frentes.
import assert from "node:assert/strict";
import {
  MINUTOS_REINICIO_MAX,
  MINUTOS_REINICIO_PADRAO,
  abrirMarcaLida,
  conversaReiniciada,
  decidirReinicio,
  minutosParada,
  montarAssinatura,
  nomeDeAssinatura,
  responderZeraNaoLidas,
  statusAoResponder,
  textoComAssinatura,
  type RegrasConversa,
} from "../lib/conversa-automatica.ts";
import { PREFERENCIAS_PADRAO, sanitizarPreferencias, mesclarPreferencias } from "../lib/perfil-conta.ts";

// defaults do card 86ak858zu, escritos aqui pra a prova falhar se alguem trocar
const CFG: RegrasConversa = {
  reinicio_minutos: MINUTOS_REINICIO_PADRAO,
  reinicio_marcar_aberto: true,
  reinicio_redelegar: false,
  reinicio_remover_delegados: false,
  auto_atendimento_ao_responder: true,
  auto_atendimento_bot: false,
};

const AGORA = Date.parse("2026-08-31T15:00:00.000Z");
const min = (m: number) => new Date(AGORA - m * 60000).toISOString();

// ======================================================= 1) TEMPO PARADO

// 1.1 a conta e simples e em minutos
{
  assert.equal(minutosParada(min(30), AGORA), 30);
  assert.equal(minutosParada(min(0.5), AGORA), 0.5);
  assert.equal(minutosParada(new Date(AGORA - 90 * 60000), AGORA), 90);
}

// 1.2 "nao da pra saber" NUNCA vira "faz muito tempo"
{
  for (const v of [null, undefined, "", "ontem", {}, 12345, NaN]) {
    assert.equal(minutosParada(v as unknown, AGORA), null, `carimbo ilegivel nao vira idade: ${String(v)}`);
  }
}

// 1.3 carimbo no FUTURO (relogio do provedor adiantado) conta como 0, nao negativo
{
  assert.equal(minutosParada(min(-10), AGORA), 0);
}

// ==================================================== 2) CONVERSA REINICIADA

// 2.1 a janela e um piso INCLUSIVO: 30 min parada com janela de 30 reinicia
{
  assert.equal(conversaReiniciada(min(29.9), 30, AGORA), false);
  assert.equal(conversaReiniciada(min(30), 30, AGORA), true);
  assert.equal(conversaReiniciada(min(600), 30, AGORA), true);
}

// 2.2 conversa NOVA (sem carimbo) nao e reinicio — e comeco (quem trata e a saudacao)
{
  assert.equal(conversaReiniciada(null, 30, AGORA), false);
  assert.equal(decidirReinicio(CFG, { statusAtual: null, ultimaAtividadeEm: null }, AGORA).reiniciada, false);
}

// 2.3 janela 0 (ou torta) DESLIGA a regra inteira
{
  for (const j of [0, -5, NaN, Infinity]) {
    assert.equal(conversaReiniciada(min(9999), j, AGORA), false, `janela ${j} desliga o reinicio`);
  }
  const tudoLigado = { ...CFG, reinicio_minutos: 0, reinicio_redelegar: true, reinicio_remover_delegados: true };
  const desligado = decidirReinicio(tudoLigado, { statusAtual: "atendimento", ultimaAtividadeEm: min(999) }, AGORA);
  assert.deepEqual(desligado, { reiniciada: false, status: null, redistribuir: false, removerDelegados: false },
    "janela 0 nao redistribui nem solta ninguem, mesmo com as duas chaves ligadas");
}

// 2.4 o default de fabrica e 30 min e cabe no teto da config
{
  assert.equal(MINUTOS_REINICIO_PADRAO, 30);
  assert.ok(MINUTOS_REINICIO_PADRAO <= MINUTOS_REINICIO_MAX);
}

// 2.5 quem reinicia e a conversa parada EM ATENDIMENTO / AGUARDANDO
{
  for (const st of ["atendimento", "aguardando"]) {
    const d = decidirReinicio(CFG, { statusAtual: st, ultimaAtividadeEm: min(45) }, AGORA);
    assert.equal(d.reiniciada, true);
    assert.equal(d.status, "aberto", `${st} parada volta pra aberto`);
  }
}

// 2.6 `concluido` NAO e tocado pelo reinicio: reabrir concluida e do
//     auto_desarquivar_recebida, que o admin pode ter desligado de proposito
{
  const d = decidirReinicio(CFG, { statusAtual: "concluido", ultimaAtividadeEm: min(500) }, AGORA);
  assert.equal(d.reiniciada, true, "a conversa reiniciou de fato");
  assert.equal(d.status, null, "mas o reinicio nao reabre conversa concluida");
}

// 2.7 `aberto` nao gera update: gravar o mesmo valor emitiria status_alterado
//     de uma transicao que nao houve (licao do webhook de saida da Frente F)
{
  const d = decidirReinicio(CFG, { statusAtual: "aberto", ultimaAtividadeEm: min(500) }, AGORA);
  assert.equal(d.status, null);
}

// 2.8 "marcar aberto" desligado = reinicio nao mexe em status nenhum
{
  const d = decidirReinicio({ ...CFG, reinicio_marcar_aberto: false }, { statusAtual: "atendimento", ultimaAtividadeEm: min(45) }, AGORA);
  assert.equal(d.reiniciada, true);
  assert.equal(d.status, null);
}

// 2.9 REDELEGAR e o gate REAL: ligado sozinho, o reinicio JA aciona o rodizio
//     (e nao depende de auto_distribuir — quem aplica nem consulta essa chave)
{
  const ctx = { statusAtual: "atendimento", ultimaAtividadeEm: min(45) };
  assert.equal(decidirReinicio(CFG, ctx, AGORA).redistribuir, false, "default do card: NAO");
  const so = decidirReinicio({ ...CFG, reinicio_redelegar: true }, ctx, AGORA);
  assert.equal(so.redistribuir, true, "redelegar ligado sozinho REDELEGA no reinicio");
  assert.equal(so.removerDelegados, false, "... mas sem tirar a conversa de quem esta atendendo");
}

// 2.10 TROCAR o responsavel exige as DUAS chaves: soltar sem redelegar deixaria a
//      conversa orfa por configuracao meio-preenchida
{
  const ctx = { statusAtual: "atendimento", ultimaAtividadeEm: min(45) };
  assert.equal(decidirReinicio(CFG, ctx, AGORA).removerDelegados, false, "default do card: NAO");
  const soRemover = decidirReinicio({ ...CFG, reinicio_remover_delegados: true }, ctx, AGORA);
  assert.equal(soRemover.removerDelegados, false, "remover sozinho nao solta ninguem");
  assert.equal(soRemover.redistribuir, false, "... e nem aciona o rodizio");
  const ambas = decidirReinicio(
    { ...CFG, reinicio_redelegar: true, reinicio_remover_delegados: true },
    ctx,
    AGORA
  );
  assert.equal(ambas.removerDelegados, true);
  assert.equal(ambas.redistribuir, true, "trocar responsavel implica redistribuir");
}

// 2.11 conversa que NAO reiniciou nunca produz efeito, mesmo com tudo ligado
{
  const tudoLigado = { ...CFG, reinicio_redelegar: true, reinicio_remover_delegados: true };
  const d = decidirReinicio(tudoLigado, { statusAtual: "atendimento", ultimaAtividadeEm: min(5) }, AGORA);
  assert.deepEqual(d, { reiniciada: false, status: null, redistribuir: false, removerDelegados: false });
}

// 2.12 RELOGIO DA MENSAGEM, nao do servidor (reprovacao da revisao cega): backlog
//      processado tarde nao pode reiniciar conversa que teve ida-e-volta rapida.
//      Cenario real: cliente escreve sabado 10h, atendente responde 10h02, cliente
//      responde 10h05 — e o sync so materializa isso na segunda 9h.
{
  const sabado10h = Date.parse("2026-08-29T13:00:00.000Z");
  const sabado10h02 = Date.parse("2026-08-29T13:02:00.000Z");
  const sabado10h05 = Date.parse("2026-08-29T13:05:00.000Z");
  const segunda9h = Date.parse("2026-08-31T12:00:00.000Z");

  // com o relogio CERTO (carimbo da mensagem): 3 minutos parada, nao reiniciou
  const certo = decidirReinicio(
    { ...CFG, reinicio_redelegar: true, reinicio_remover_delegados: true },
    { statusAtual: "atendimento", ultimaAtividadeEm: new Date(sabado10h02).toISOString() },
    sabado10h05
  );
  assert.equal(certo.reiniciada, false, "3 min de ida-e-volta nunca e conversa reiniciada");
  assert.equal(certo.removerDelegados, false, "e ninguem perde a conversa por atraso do sync");

  // com o relogio ERRADO (Date.now do processamento): 47h e a conversa "reinicia"
  const errado = decidirReinicio(
    CFG,
    { statusAtual: "atendimento", ultimaAtividadeEm: new Date(sabado10h02).toISOString() },
    segunda9h
  );
  assert.equal(errado.reiniciada, true, "prova que o relogio do servidor mediria uma janela que nunca existiu");
  assert.ok(minutosParada(new Date(sabado10h).toISOString(), sabado10h05)! < CFG.reinicio_minutos);
}

// ================================================= 3) STATUS AO RESPONDER

// 3.1 GENTE respondendo move pra atendimento (default do painel, ligado)
{
  for (const st of ["aberto", "aguardando", "concluido", null]) {
    assert.equal(
      statusAoResponder(CFG, { autor: "usuario", statusAtual: st }),
      "atendimento",
      `atendente responde conversa ${st} -> atendimento`
    );
  }
}

// 3.2 ROBO respondendo NAO move nada por default — o motor de fluxo nao
//     sequestra a fila humana (o card inteiro nasce dessa separacao)
{
  for (const st of ["aberto", "aguardando", "concluido", null]) {
    assert.equal(statusAoResponder(CFG, { autor: "bot", statusAtual: st }), null, `robo nao mexe em ${st}`);
  }
}

// 3.3 ... e move quando a instalacao LIGA a chave propria do robo
{
  const comBot = { ...CFG, auto_atendimento_bot: true };
  assert.equal(statusAoResponder(comBot, { autor: "bot", statusAtual: "aberto" }), "atendimento");
}

// 3.4 as duas chaves sao INDEPENDENTES: desligar a de gente nao liga a do robo
{
  const semGente = { ...CFG, auto_atendimento_ao_responder: false, auto_atendimento_bot: true };
  assert.equal(statusAoResponder(semGente, { autor: "usuario", statusAtual: "aberto" }), null);
  assert.equal(statusAoResponder(semGente, { autor: "bot", statusAtual: "aberto" }), "atendimento");
}

// 3.5 conversa JA em atendimento nao vira update (nem pra gente, nem pro robo)
{
  assert.equal(statusAoResponder(CFG, { autor: "usuario", statusAtual: "atendimento" }), null);
  assert.equal(
    statusAoResponder({ ...CFG, auto_atendimento_bot: true }, { autor: "bot", statusAtual: "atendimento" }),
    null
  );
}

// ====================================================== 4) ASSINATURA

// 4.1 formato UNICO: negrito do WhatsApp, dois pontos, quebra de linha
{
  assert.equal(montarAssinatura("bom dia", { assinatura_nome: "Ana" }), "*Ana:*\nbom dia");
}

// 4.2 sem nome de exibicao, cai no nome da conta
{
  assert.equal(montarAssinatura("oi", { assinatura_nome: "", nome: "Joao Silva" }), "*Joao Silva:*\noi");
  assert.equal(montarAssinatura("oi", { assinatura_nome: null, nome: "Joao" }), "*Joao:*\noi");
}

// 4.3 sem nome NENHUM, o texto sai CRU — assinar "undefined:" seria pior
{
  assert.equal(montarAssinatura("oi", {}), "oi");
  assert.equal(montarAssinatura("oi", { assinatura_nome: "   ", nome: "" }), "oi");
}

// 4.3b nome de exibicao SO-DE-ESPACOS nao faz a mensagem sair sem assinatura em
//      silencio: cai no proximo candidato (o nome da conta, e depois o fallback
//      do chamador — e o que devolve o "Atendimento:" historico das agendadas)
{
  assert.equal(montarAssinatura("oi", { assinatura_nome: "   ", nome: "Joao" }), "*Joao:*\noi");
  assert.equal(
    montarAssinatura("oi", { assinatura_nome: " ", nome: null, fallback: "Atendimento" }),
    "*Atendimento:*\noi"
  );
  assert.equal(
    textoComAssinatura("oi", { assinatura_ativa: true, assinatura_nome: "\t", nome: "", fallback: "Atendimento" }),
    "*Atendimento:*\noi"
  );
}

// 4.4 texto vazio (envio de midia sem legenda) nao ganha assinatura solta
{
  assert.equal(montarAssinatura("", { nome: "Ana" }), "");
  assert.equal(textoComAssinatura("", { assinatura_ativa: true, nome: "Ana" }), "");
}

// 4.5 nome comprido e cortado no mesmo teto do campo (60)
{
  const longo = "A".repeat(80);
  const saida = montarAssinatura("oi", { assinatura_nome: longo });
  assert.equal(saida, `*${"A".repeat(60)}:*\noi`);
}

// 4.6 a chave manda: assinatura desligada = texto intocado
{
  assert.equal(textoComAssinatura("oi", { assinatura_ativa: false, nome: "Ana" }), "oi");
  assert.equal(textoComAssinatura("oi", { nome: "Ana" }), "oi", "ausente = desligada (fail-closed)");
  assert.equal(textoComAssinatura("oi", { assinatura_ativa: true, nome: "Ana" }), "*Ana:*\noi");
}

// 4.7 so booleano de VERDADE liga a assinatura
{
  assert.equal(textoComAssinatura("oi", { assinatura_ativa: "true" as unknown as boolean, nome: "Ana" }), "oi");
  assert.equal(textoComAssinatura("oi", { assinatura_ativa: 1 as unknown as boolean, nome: "Ana" }), "oi");
}

// 4.8 NOME HOSTIL: o nome vem de campo digitado e o destino tem MARCACAO. Nada
//     que quebre o formato passa — nem quebra de linha (partia a linha da
//     assinatura e vazava o negrito pro corpo), nem os marcadores do WhatsApp
//     (`*` fechava o negrito no lugar errado e embaralhava a mensagem do cliente)
{
  assert.equal(montarAssinatura("bom dia", { assinatura_nome: "Ana\nSuporte" }), "*Ana Suporte:*\nbom dia");
  assert.equal(montarAssinatura("bom dia", { assinatura_nome: "Ana\r\nSuporte" }), "*Ana Suporte:*\nbom dia");
  assert.equal(montarAssinatura("bom dia", { assinatura_nome: "Ana\tB" }), "*Ana B:*\nbom dia");
  assert.equal(montarAssinatura("bom dia", { assinatura_nome: "*Ana*" }), "*Ana:*\nbom dia");
  assert.equal(montarAssinatura("bom dia", { assinatura_nome: "_A_n~a~" }), "*Ana:*\nbom dia");
  // nome que era SO marcacao nao vira assinatura vazia: cai no proximo candidato
  assert.equal(montarAssinatura("bom dia", { assinatura_nome: "***", nome: "Joao" }), "*Joao:*\nbom dia");
  // a saida NUNCA tem \n, \r, \t ou marcador dentro do rotulo
  const rotulo = montarAssinatura("x", { assinatura_nome: " *Ana*\n\tSilva~ " }).split(":*\n")[0];
  assert.equal(rotulo, "*Ana Silva");
  assert.equal(nomeDeAssinatura(null, undefined, "  "), "");
}

// 4.9 o corte de 60 vem DEPOIS da limpeza (cortar antes podia deixar so lixo
//     dentro do teto) e o resultado nunca termina em espaco solto
{
  const nome = "*".repeat(50) + "Ana " + "B".repeat(80);
  const saida = nomeDeAssinatura(nome);
  assert.equal(saida.length <= 60, true);
  assert.equal(saida.startsWith("Ana B"), true, "os asteriscos saem ANTES do corte");
  assert.equal(saida, saida.trim());
}

// ================================================== 5) MODO SUPERVISOR

// 5.1 sem preferencia gravada, o painel se comporta como sempre se comportou
{
  assert.equal(abrirMarcaLida(null), true);
  assert.equal(abrirMarcaLida(undefined), true);
  assert.equal(abrirMarcaLida({}), true);
  assert.equal(PREFERENCIAS_PADRAO.supervisor, false);
  assert.equal(abrirMarcaLida(PREFERENCIAS_PADRAO), true);
}

// 5.2 supervisor ligado: abrir NAO marca como lida
{
  assert.equal(abrirMarcaLida({ supervisor: true }), false);
}

// 5.3 so booleano de verdade liga o modo (string nao decide)
{
  assert.equal(abrirMarcaLida({ supervisor: "true" as unknown as boolean }), true);
  assert.equal(sanitizarPreferencias({ supervisor: "true" }).supervisor, false);
  assert.equal(sanitizarPreferencias({ supervisor: true }).supervisor, true);
}

// 5.4 responder zera o contador por default (quem respondeu leu) — inclusive
//     pra quem nao e supervisor, onde a pergunta e teorica
{
  assert.equal(responderZeraNaoLidas(null), true);
  assert.equal(responderZeraNaoLidas({}), true);
  assert.equal(responderZeraNaoLidas({ supervisor: false, supervisor_responder_zera: false }), true,
    "quem nao e supervisor zera de qualquer jeito: abrir a conversa ja zerava");
  assert.equal(responderZeraNaoLidas({ supervisor: true }), true);
  assert.equal(PREFERENCIAS_PADRAO.supervisor_responder_zera, true);
}

// 5.5 ... e so o supervisor consegue desligar isso
{
  assert.equal(responderZeraNaoLidas({ supervisor: true, supervisor_responder_zera: false }), false);
}

// 5.6 patch parcial nao apaga o resto das preferencias (som/desktop do dono)
{
  const atual = { som: false, desktop: true, supervisor: false, supervisor_responder_zera: true };
  const novo = mesclarPreferencias(atual, { supervisor: true });
  assert.deepEqual(novo, { som: false, desktop: true, supervisor: true, supervisor_responder_zera: true });
}

console.log("prova-conversa-automatica: OK");
