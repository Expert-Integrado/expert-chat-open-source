// Prova das TELAS de acesso e seguranca (Frente Q) — SEM banco e SEM navegador.
// `node scripts/prova-tela-acesso.ts`
//
// O que esta prova trava:
//
//  A) A GRADE da janela, nos dois sentidos. O round-trip (rota -> grade -> rota)
//     tem que preservar a janela inteira, inclusive o periodo que VIRA A
//     MEIA-NOITE — se a tela achatar isso, o turno da noite vira lockout.
//  B) O que a tela recusa salvar: dia marcado sem horario, horario pela metade e
//     o LOCKOUT (janela ligada sem nenhum dia), que a rota responde com 400.
//  C) Dispositivo: rotulo estavel e tempo relativo com as bordas certas —
//     inclusive data ilegivel e relogio adiantado, que era de onde saia
//     "ha 56 anos" na ferramenta antiga.
//  D) Restricao: o texto que a tela mostra ANTES de salvar espelha
//     `restricaoPermite`, e a caixa "sem funil" avisa quando esta inerte.
//  E) Escopo de chave: o corpo que a tela manda nunca carrega `ignorar_janela`
//     (a unica dimensao que afrouxa, privativa do super admin).

import assert from "node:assert/strict";

import {
  DIAS_UTEIS,
  alternar,
  avisoEscopoAberto,
  avisoSemFunilInerte,
  copiarLinha,
  corpoDoEscopo,
  corpoDoEscopoAdmin,
  errosDaGrade,
  gradeParaJanela,
  gradeVazia,
  janelaParaGrade,
  nomeDoDia,
  resumoDaGrade,
  rotuloDispositivo,
  rotuloEscopo,
  tempoRelativo,
  explicarRestricao,
} from "../lib/tela-acesso.ts";
import { acessoPermitido, resumoJanela, validarJanela } from "../lib/janela-acesso.ts";
import { restricaoPermite, type RestricaoUsuario } from "../lib/visibilidade.ts";
import { validarEscopoChave } from "../lib/escopo-chave.ts";

let assercoes = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  assercoes++;
  assert.equal(a, b, msg);
};
const dep = (a: unknown, b: unknown, msg: string) => {
  assercoes++;
  assert.deepEqual(a, b, msg);
};

const SP = "America/Sao_Paulo";

// ============================================================ A) A GRADE
{
  eq(gradeVazia().length, 7, "a grade tem 7 dias, sempre");
  eq(gradeVazia()[0].periodos.length, 2, "e sempre 2 campos de periodo por dia (nao aparecem/desaparecem)");
  eq(nomeDoDia(1), "Segunda", "o dia sai capitalizado pra tela");
  eq(nomeDoDia(0), "Domingo", "domingo e o indice 0 (dia da semana do JS)");

  // ROUND-TRIP: comercial de segunda a sexta com intervalo de almoco
  const comercial = {
    ativo: true,
    dias: {
      1: [["08:00", "12:00"], ["13:00", "18:00"]],
      2: [["08:00", "12:00"], ["13:00", "18:00"]],
      3: [["08:00", "12:00"], ["13:00", "18:00"]],
      4: [["08:00", "12:00"], ["13:00", "18:00"]],
      5: [["08:00", "12:00"], ["13:00", "18:00"]],
    },
  };
  const grade = janelaParaGrade(comercial);
  eq(grade[1].marcado, true, "dia com periodo vem marcado");
  eq(grade[0].marcado, false, "domingo sem periodo vem desmarcado");
  eq(grade[1].periodos[0].de, "08:00", "o primeiro periodo carrega no primeiro campo");
  eq(grade[1].periodos[1].ate, "18:00", "o segundo periodo carrega no segundo campo");
  dep(
    gradeParaJanela(grade, true),
    validarJanela(comercial),
    "ROUND-TRIP: rota -> grade -> rota devolve a MESMA janela canonica"
  );

  // VIRADA DA MEIA-NOITE preservada (turno da noite)
  const noturno = { ativo: true, dias: { 5: [["22:00", "02:00"]] } };
  const gNoturno = janelaParaGrade(noturno);
  eq(gNoturno[5].periodos[0].de, "22:00", "o turno da noite carrega");
  eq(gNoturno[5].periodos[0].ate, "02:00", "...com o fim na madrugada seguinte");
  dep(gradeParaJanela(gNoturno, true), validarJanela(noturno), "a virada da meia-noite sobrevive ao round-trip");
  // e continua valendo como REGRA depois de passar pela tela
  const jNoturno = gradeParaJanela(gNoturno, true);
  eq(acessoPermitido(jNoturno, new Date("2026-09-04T23:30:00-03:00"), SP), true, "sexta 23:30 entra (o turno comecou)");
  eq(
    acessoPermitido(jNoturno, new Date("2026-09-05T01:30:00-03:00"), SP),
    true,
    "SABADO 01:30 entra: a madrugada pertence a escala da SEXTA, que e o dia em que o turno comecou"
  );
  eq(
    acessoPermitido(jNoturno, new Date("2026-09-05T02:30:00-03:00"), SP),
    false,
    "sabado 02:30 NAO entra: o fim do periodo e exclusivo (02:00 ja fechou)"
  );
  eq(acessoPermitido(jNoturno, new Date("2026-09-05T04:00:00-03:00"), SP), false, "sabado 04:00 nao entra");

  // periodo PELA METADE e descartado no corpo (mas cobrado no salvar — bloco B)
  const meio = gradeVazia();
  meio[3].marcado = true;
  meio[3].periodos[0] = { de: "09:00", ate: "" };
  dep(gradeParaJanela(meio, true).dias, {}, "periodo sem o fim NAO vai pro corpo do POST");

  // linha desmarcada nao vai, mesmo com horario digitado (o admin desmarcou)
  const desmarcado = gradeVazia();
  desmarcado[2].periodos[0] = { de: "08:00", ate: "12:00" };
  dep(gradeParaJanela(desmarcado, true).dias, {}, "dia desmarcado nao vai pro corpo, mesmo com horario preenchido");

  // COPIAR pros dias uteis — o atalho da tela
  const uma = gradeVazia();
  uma[1].marcado = true;
  uma[1].periodos[0] = { de: "08:00", ate: "17:00" };
  const espalhada = copiarLinha(uma, 1, DIAS_UTEIS);
  eq(espalhada[5].marcado, true, "copiar pros dias uteis alcanca a sexta");
  eq(espalhada[5].periodos[0].ate, "17:00", "...com o mesmo horario");
  eq(espalhada[0].marcado, false, "e NAO alcanca o domingo");
  eq(espalhada[6].marcado, false, "nem o sabado");
  // copia e por VALOR: editar o destino nao mexe na origem
  espalhada[5].periodos[0].de = "10:00";
  eq(espalhada[1].periodos[0].de, "08:00", "a copia e por valor (editar sexta nao mexe na segunda)");

  // o resumo da tela e LITERALMENTE o da regra — nao uma segunda redacao que
  // pode divergir da frase que a rota devolve e que o usuario barrado le
  eq(
    resumoDaGrade(uma, true),
    resumoJanela(validarJanela({ ativo: true, dias: { 1: [["08:00", "17:00"]] } })),
    "o resumo da tela e o MESMO texto que resumoJanela produz"
  );
  eq(resumoDaGrade(uma, true), "segunda 08:00-17:00", "e ele nomeia o dia e o horario");
  eq(
    resumoDaGrade(gradeVazia(), false),
    "sem janela de acesso (entra sempre)",
    "grade vazia com janela desligada: a frase de 'entra sempre'"
  );
}

// ============================================================ B) O QUE NAO SALVA
{
  dep(errosDaGrade(gradeVazia(), false), [], "grade vazia com janela DESLIGADA pode salvar (e o estado 'entra sempre')");

  const semHora = gradeVazia();
  semHora[2].marcado = true;
  const e1 = errosDaGrade(semHora, true);
  eq(e1.length, 1, "dia marcado sem horario: 1 erro");
  assert.match(e1[0], /Terca/, "o erro NOMEIA o dia (senao o admin nao sabe onde olhar)");

  const metade = gradeVazia();
  metade[4].marcado = true;
  metade[4].periodos[0] = { de: "08:00", ate: "" };
  const e2 = errosDaGrade(metade, true);
  eq(e2.length, 1, "horario pela metade: 1 erro");
  assert.match(e2[0], /incompleto|invalido/, "o erro diz que o horario esta incompleto");

  const invalido = gradeVazia();
  invalido[1].marcado = true;
  invalido[1].periodos[0] = { de: "8h", ate: "18:00" };
  assert.match(errosDaGrade(invalido, true)[0] || "", /HH:MM/, "hora fora do formato: o erro ensina o formato");
  assercoes++;

  // LOCKOUT: ligada e sem nenhum dia — exatamente o 400 da rota
  const lockout = errosDaGrade(gradeVazia(), true);
  eq(lockout.length, 1, "janela LIGADA sem nenhum dia: a tela nao deixa salvar");
  assert.match(lockout[0], /24 horas/, "e a frase explica o efeito (barra 24 horas por dia)");
  assercoes++;

  const boa = gradeVazia();
  boa[1].marcado = true;
  boa[1].periodos[0] = { de: "08:00", ate: "18:00" };
  dep(errosDaGrade(boa, true), [], "grade valida: nenhum erro");
  // a virada da meia-noite NAO e erro (de > ate e legitimo)
  const vira = gradeVazia();
  vira[5].marcado = true;
  vira[5].periodos[0] = { de: "22:00", ate: "02:00" };
  dep(errosDaGrade(vira, true), [], "periodo que vira a meia-noite NAO e reprovado pela tela");
}

// ============================================================ C) DISPOSITIVO
{
  eq(rotuloDispositivo({ navegador: "Chrome", sistema: "Windows" }), "Chrome / Windows", "navegador e sistema, juntos");
  eq(rotuloDispositivo({ navegador: "Chrome", sistema: "Windows", robo: true }), "Chrome / Windows (robo)", "robo e marcado");
  eq(rotuloDispositivo({ rotulo: "Claude (MCP)", navegador: "Chrome" }), "Claude (MCP)", "rotulo pronto do servidor ganha");
  eq(rotuloDispositivo({ navegador: null, sistema: null }), "Desconhecido", "sem nada reconhecido: 'Desconhecido', nunca vazio");
  eq(rotuloDispositivo(null), "Desconhecido", "linha sem dado nao quebra a lista");
  eq(rotuloDispositivo({ navegador: "Safari", sistema: null }), "Safari", "so o navegador tambem serve");

  const agora = new Date("2026-08-31T12:00:00Z");
  eq(tempoRelativo(null, agora), null, "sem data: null (a tela escreve 'nunca')");
  eq(tempoRelativo("", agora), null, "data vazia: null");
  eq(tempoRelativo("nao-e-data", agora), null, "data ILEGIVEL: null, nunca 'Invalid Date'");
  eq(tempoRelativo("2026-08-31T11:59:30Z", agora), "agora mesmo", "30s: agora mesmo");
  eq(tempoRelativo("2026-08-31T11:45:00Z", agora), "ha 15 min", "15min");
  eq(tempoRelativo("2026-08-31T11:00:00Z", agora), "ha 1 hora", "1 hora no singular");
  eq(tempoRelativo("2026-08-31T09:00:00Z", agora), "ha 3 horas", "3 horas no plural");
  eq(tempoRelativo("2026-08-30T12:00:00Z", agora), "ha 1 dia", "1 dia no singular");
  eq(tempoRelativo("2026-08-25T12:00:00Z", agora), "ha 6 dias", "6 dias no plural");
  eq(tempoRelativo("2026-09-01T12:00:00Z", agora), "agora mesmo", "data no FUTURO (relogio adiantado) nao inventa 'em 1 dia'");
  eq(tempoRelativo("1970-01-01T00:00:00Z", agora), `ha ${Math.floor((agora.getTime() - 0) / 86_400_000)} dias`, "epoch 0 vira dias, nao 'ha 56 anos' escondido");
}

// ============================================================ D) RESTRICAO
{
  const vazia: RestricaoUsuario = { canais: [], funis: [], sem_funil: false };
  assert.match(explicarRestricao(vazia), /Sem recorte/, "restricao vazia: a tela diz que nao ha recorte");
  assercoes++;

  const soCanal: RestricaoUsuario = { canais: ["apioficial"], funis: [], sem_funil: false };
  const txtCanal = explicarRestricao(soCanal, { canais: { apioficial: "WhatsApp Oficial" } });
  assert.match(txtCanal, /WhatsApp Oficial/, "o texto usa o NOME do canal, nao o id");
  assercoes++;
  // e o texto tem que casar com o predicado de verdade
  eq(restricaoPermite(soCanal, { canal: "apioficial", funilIds: [] }), true, "predicado: canal permitido passa");
  eq(restricaoPermite(soCanal, { canal: "central", funilIds: [] }), false, "predicado: canal de fora e negado");

  const comFunil: RestricaoUsuario = { canais: [], funis: ["f1"], sem_funil: false };
  const txtFunil = explicarRestricao(comFunil, { funis: { f1: "Vendas" } });
  assert.match(txtFunil, /Vendas/, "o texto nomeia o funil");
  assert.match(txtFunil, /NAO ve conversa fora desses funis/, "e AVISA da pegadinha: conversa sem funil fica escondida");
  assercoes += 2;
  eq(restricaoPermite(comFunil, { canal: "central", funilIds: [] }), false, "predicado confirma: sem funil = negado quando sem_funil e false");

  const comSemFunil: RestricaoUsuario = { canais: [], funis: ["f1"], sem_funil: true };
  assert.match(explicarRestricao(comSemFunil, { funis: { f1: "Vendas" } }), /nao estao em funil nenhum/, "com sem_funil, o texto muda");
  assercoes++;
  eq(restricaoPermite(comSemFunil, { canal: "central", funilIds: [] }), true, "predicado confirma: sem_funil libera a conversa sem funil");

  // a caixa inerte
  eq(avisoSemFunilInerte({ canais: [], funis: [], sem_funil: true }) !== null, true, "sem_funil marcado SEM funil: a tela avisa que a caixa nao faz nada");
  eq(avisoSemFunilInerte(comSemFunil), null, "com funil escolhido, sem aviso");
  eq(avisoSemFunilInerte(vazia), null, "restricao vazia, sem aviso");

  // alternar mantem ordenado (igual a rota grava)
  dep(alternar(["b"], "a"), ["a", "b"], "alternar liga e mantem ordenado");
  dep(alternar(["a", "b"], "a"), ["b"], "alternar desliga");
  dep(alternar([], "x"), ["x"], "alternar na lista vazia");
}

// ============================================================ E) ESCOPO DE CHAVE
{
  const aberto = validarEscopoChave({});
  eq(avisoEscopoAberto(aberto) !== null, true, "escopo aberto: a tela avisa que a chave vale tudo o que o dono vale");
  eq(avisoEscopoAberto(validarEscopoChave({ somente_leitura: true })), null, "escopo apertado: sem aviso");
  assert.match(rotuloEscopo(validarEscopoChave({ somente_leitura: true })), /somente leitura/, "o rotulo e o MESMO da rota");
  assercoes++;

  const corpo = corpoDoEscopo({ somente_leitura: true, recursos: ["mensagens", "conversas"], canais: ["central"] });
  dep(corpo.recursos, ["conversas", "mensagens"], "o corpo sai ordenado");
  eq("ignorar_janela" in corpo, false, "o corpo do AUTOATENDIMENTO nunca carrega ignorar_janela (a unica dimensao que afrouxa)");

  // E o caminho de SUPER ADMIN manda o campo EXPLICITO, sempre. A rota sanea com
  // validarEscopoChave, que trata ausente como false: sem isto, mexer no canal de
  // uma chave de robo noturno apagaria o privilegio em silencio.
  const admin = corpoDoEscopoAdmin({ somente_leitura: false, recursos: [], canais: ["central"], ignorar_janela: true });
  eq(admin.ignorar_janela, true, "o corpo de admin PRESERVA ignorar_janela quando a chave tem");
  eq(
    validarEscopoChave(admin).ignorar_janela,
    true,
    "e sobrevive ao saneamento da rota (era aqui que o privilegio se perdia calado)"
  );
  eq(
    validarEscopoChave(corpoDoEscopo({ somente_leitura: false, recursos: [], canais: ["central"] })).ignorar_janela,
    false,
    "prova do contrario: corpo SEM o campo faz a rota gravar false"
  );
  eq(
    corpoDoEscopoAdmin({ somente_leitura: false, recursos: [], canais: [], ignorar_janela: false }).ignorar_janela,
    false,
    "chave normal segue com o privilegio desligado"
  );
  eq(corpo.somente_leitura, true, "somente_leitura vai como booleano");
  dep(corpoDoEscopo({ somente_leitura: false, recursos: [], canais: [] }).canais, [], "selecao vazia = dimensao livre");
}

console.log(`prova-tela-acesso: 5 blocos, ${assercoes} assercoes OK`);
