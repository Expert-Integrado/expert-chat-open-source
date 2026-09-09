// Prova da TELA DE CONVERSA — cards 86ak85nyv (kit de acoes), 86ak85nx0
// (historicos de status/NPS/midia) e 86ak85nwu (historico de transferencia).
//
// Roda em Node >= 22.6 sem build: `node scripts/prova-tela-conversa.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// FIXTURES SAO SINTETICAS. Nenhuma mensagem, telefone ou nome de cliente entra
// no repo — mesma regra do resto das provas deste projeto. Conteudo de conversa
// e dado NAO-CONFIAVEL: aqui ele aparece como texto hostil de propostio (coringa
// de LIKE, acento, texto gigante), nunca como instrucao.
//
// O QUE ESTA PROVA COBRE: a regra pura de lib/tela-conversa.ts — busca dentro da
// conversa (normalizacao, escape de coringa, recorte com acento), abas de midia,
// permanencia por status, trilha de transferencia, as travas de iniciar conversa
// e o portao do robo por conversa.
//
// O QUE ELA **NAO** COBRE (declarado, nao esquecido): o React de app/home.tsx
// (precisa de navegador) e lib/tela-conversa-db.ts + as rotas (precisam do
// Postgres da instalacao e do alias `@/` do Next). O que dava pra separar de
// tela e de banco foi separado de propostio e ESTA provado aqui.
import assert from "node:assert/strict";
import {
  ABAS_MIDIA,
  LIMITE_TEXTO_INICIO,
  MAX_DESTINOS_FORWARD,
  MAX_RESULTADOS_BUSCA,
  MIN_TERMO_BUSCA,
  ROTULO_ABA_MIDIA,
  STATUS_CONVERSA_TELA,
  TETO_INICIOS_POR_HORA,
  abaDaMidia,
  agruparMidia,
  botLigado,
  casaTermo,
  duracaoSeg,
  escaparIlike,
  formatarDuracao,
  linhaDoTempoStatus,
  linhaDoTempoTransferencia,
  motivoBotDesligado,
  normalizarBusca,
  rotuloAutor,
  trechoDoTermo,
  validarInicioConversa,
  padraoParaIlike,
  seloDeFluxo,
  booleanoEstrito,
  ehEventoRobo,
  ORIGEM_ROBO,
  STATUS_ROBO_LIGADO,
  STATUS_ROBO_DESLIGADO,
  type EventoResponsavel,
  type EventoStatus,
  type ItemMidia,
} from "../lib/tela-conversa.ts";

let casos = 0;
const ok = (cond: unknown, oque: string) => {
  casos++;
  assert.ok(cond, oque);
};
const igual = (a: unknown, b: unknown, oque: string) => {
  casos++;
  assert.deepEqual(a, b, oque);
};

// ===========================================================================
// 1. Encaminhar — o teto e UM numero, em UM lugar
// ===========================================================================
igual(MAX_DESTINOS_FORWARD, 5, "teto de encaminhamento e o do WhatsApp");
ok(Number.isInteger(MAX_DESTINOS_FORWARD) && MAX_DESTINOS_FORWARD > 0, "teto e inteiro positivo");
// A prova nao pode ler a rota nem a tela (uma importa banco, a outra e React),
// entao o que ela trava e a INTENCAO: se alguem transformar o teto em algo
// destravavel por config, este assert cai e a decisao volta pra mesa.
ok(typeof MAX_DESTINOS_FORWARD === "number", "teto e constante, nao funcao de config");

// ===========================================================================
// 2. Busca dentro da conversa
// ===========================================================================

// --- escape de coringa: o gotcha que faz a busca "parecer quebrada"
igual(escaparIlike("10%"), "10\\%", "porcentagem escapa (senao 10% casa qualquer coisa com 10)");
igual(escaparIlike("a_b"), "a\\_b", "sublinhado escapa (senao a_b casa aXb)");
igual(escaparIlike("c:\\temp"), "c:\\\\temp", "barra invertida escapa antes de virar escape");
igual(escaparIlike("%%__"), "\\%\\%\\_\\_", "termo feito so de coringa sai todo escapado");
igual(escaparIlike("nota fiscal"), "nota fiscal", "termo normal passa intacto");

// --- normalizacao: acento, caixa e espaco duplo
igual(normalizarBusca("Orçamento"), "orcamento", "acento sai na normalizacao");
igual(normalizarBusca("  NÃO   quero  "), "nao quero", "caixa, espaco duplo e acento juntos");
igual(normalizarBusca(null), "", "nulo normaliza pra vazio, nao explode");
igual(normalizarBusca(12345), "12345", "numero normaliza como texto");

ok(casaTermo("Segue o orçamento em anexo", "ORCAMENTO"), "sem acento acha com acento");
ok(casaTermo("Segue o orcamento", "orçamento"), "com acento acha sem acento");
ok(!casaTermo("segue o orcamento", "proposta"), "termo ausente nao casa");
ok(!casaTermo("qualquer coisa", ""), "termo vazio nunca casa (senao tudo casa)");
ok(!casaTermo(null, "a"), "texto nulo nao casa");

// --- recorte: o indice tem que voltar pro texto ORIGINAL
{
  const texto = "Bom dia! Segue o orçamento revisado conforme conversamos ontem.";
  const r = trechoDoTermo(texto, "orcamento", 5);
  ok(r.trecho.includes("orçamento"), "recorte devolve o texto ORIGINAL, com acento");
  ok(r.cortou_inicio, "houve corte antes");
  ok(r.cortou_fim, "houve corte depois");
}
{
  // O CASO-MAE do mapa de indices: acento ANTES da ocorrencia. Em NFD, cada "ç"
  // e cada "ã" ocupa 2 code points — usar o indice do normalizado direto no
  // original recortaria N caracteres adiante, e o erro so aparece em portugues.
  const texto = "ação ação ação ALVO";
  const r = trechoDoTermo(texto, "alvo", 4);
  ok(r.trecho.includes("ALVO"), "com 3 acentos antes, o recorte ainda pega o alvo");
}
{
  const r = trechoDoTermo("texto curto", "nao existe aqui", 10);
  igual(r.cortou_inicio, false, "termo ausente devolve o comeco do texto, sem corte a esquerda");
}
{
  const r = trechoDoTermo("", "a", 10);
  igual(r.trecho, "", "texto vazio devolve vazio");
}
{
  // texto gigante: conteudo de terceiro pode vir com tamanho hostil
  const gigante = "x".repeat(50_000) + "ACHOU" + "y".repeat(50_000);
  const r = trechoDoTermo(gigante, "achou", 20);
  ok(r.trecho.includes("ACHOU"), "acha em texto de 100 mil caracteres");
  ok(r.trecho.length < 100, "e devolve so o recorte, nao o texto inteiro");
}
igual(MIN_TERMO_BUSCA, 2, "busca escopada aceita 2 letras (a global exige 3, e por outro motivo)");
ok(MAX_RESULTADOS_BUSCA >= 50, "teto de resultados nao e minusculo");

// ===========================================================================
// 3. Mídia — três abas, e por que o tipo manda no mime
// ===========================================================================
igual([...ABAS_MIDIA], ["media", "document", "sticker"], "as tres abas do mapa, nao uma por tipo");
for (const aba of ABAS_MIDIA) ok(ROTULO_ABA_MIDIA[aba], `aba ${aba} tem rotulo pra tela`);

igual(abaDaMidia("image"), "media", "imagem vai pra media");
igual(abaDaMidia("audio"), "media", "audio vai pra media");
igual(abaDaMidia("ptt"), "media", "ptt (audio gravado na hora) e a MESMA aba de audio");
igual(abaDaMidia("video"), "media", "video vai pra media");
igual(abaDaMidia("document"), "document", "documento tem aba propria");
// O caso que decide a regra: sticker chega com mime de IMAGEM. Decidir por mime
// jogaria toda figurinha na aba de fotos.
igual(abaDaMidia("sticker", "image/webp"), "sticker", "sticker com mime de imagem NAO vira foto");
igual(abaDaMidia("text"), null, "mensagem de texto nao e midia");
igual(abaDaMidia("text", ""), null, "texto sem mime segue fora das abas");
// tipo desconhecido (canal/provedor novo): cai pro mime, e no limite pro balde
igual(abaDaMidia("coisa-nova", "image/png"), "media", "tipo desconhecido com mime de imagem vai pra media");
igual(abaDaMidia("coisa-nova", "application/pdf"), "document", "tipo desconhecido cai no balde de documento");
igual(abaDaMidia("IMAGE", null), "media", "tipo em maiuscula tambem casa");

{
  const itens: ItemMidia[] = [
    { id: "1", provider_msg_id: "p1", tipo: "image", mime: "image/jpeg", url: "u1", legenda: null, criada_em: "2026-08-30T10:00:00Z", direcao: "in" },
    { id: "2", provider_msg_id: "p2", tipo: "document", mime: "application/pdf", url: "u2", legenda: "contrato", criada_em: "2026-08-29T10:00:00Z", direcao: "out" },
    { id: "3", provider_msg_id: "p3", tipo: "sticker", mime: "image/webp", url: "u3", legenda: null, criada_em: "2026-08-28T10:00:00Z", direcao: "in" },
    { id: "4", provider_msg_id: "p4", tipo: "ptt", mime: "audio/ogg", url: "u4", legenda: null, criada_em: "2026-08-27T10:00:00Z", direcao: "in" },
    { id: "5", provider_msg_id: null, tipo: "text", mime: null, url: null, legenda: null, criada_em: "2026-08-26T10:00:00Z", direcao: "in" },
  ];
  const g = agruparMidia(itens);
  igual(g.media.map((m) => m.id), ["1", "4"], "foto e audio na mesma aba, ordem preservada");
  igual(g.document.map((m) => m.id), ["2"], "documento sozinho");
  igual(g.sticker.map((m) => m.id), ["3"], "figurinha sozinha");
  igual(agruparMidia([]).media.length, 0, "lista vazia devolve as tres abas vazias, nunca undefined");
}

// ===========================================================================
// 4. Histórico de status e permanência
// ===========================================================================
igual([...STATUS_CONVERSA_TELA], ["aberto", "atendimento", "aguardando", "concluido"], "os quatro status da rota");

igual(duracaoSeg("2026-08-31T10:00:00Z", "2026-08-31T10:01:30Z"), 90, "90 segundos entre os dois instantes");
igual(duracaoSeg("nao e data", "2026-08-31T10:00:00Z"), null, "data ilegivel devolve null, nao NaN");
igual(duracaoSeg(null, null), null, "duas nulas devolvem null");
// clamp em zero: `criada_em` sai do relogio do BANCO e `agora` do processo do
// Next. Alguns milissegundos de diferenca produziriam permanencia NEGATIVA.
igual(duracaoSeg("2026-08-31T10:00:05Z", "2026-08-31T10:00:00Z"), 0, "relogio invertido nunca produz duracao negativa");

// A DURACAO GRAVADA NAO E MAIS PROVADA AQUI, e isso e proposital.
// Havia tres assercoes sobre `duracaoDoMarco`, um helper que a camada de banco
// deixou de usar quando o calculo foi pra dentro de
// `mensageria.registrar_status_evento` (0017) pra tirar a corrida do duplo
// clique. Helper morto com assercao verde e prova que nao prova nada — ele foi
// REMOVIDO do lib e as assercoes saíram com ele.
//
// DIVIDA DECLARADA, no padrao de scripts/prova-relatorios.ts (que declara o
// mesmo pra `mensageria.segundos_uteis`): a duracao GRAVADA e SQL e so se prova
// contra o Postgres da instalacao. O que segue provado aqui e a LEITURA —
// `duracaoSeg` (permanencia em curso, derivada) e a soma do resumo.

igual(formatarDuracao(45), "45s", "menos de um minuto sai em segundos");
igual(formatarDuracao(90), "1min", "90s sai como 1min");
igual(formatarDuracao(3600), "1h", "hora redonda nao mostra '0min'");
igual(formatarDuracao(3720), "1h 2min", "hora e minuto");
igual(formatarDuracao(90000), "1d 1h", "mais de um dia");
igual(formatarDuracao(172800), "2d", "dia redondo nao mostra '0h'");
igual(formatarDuracao(-5), "—", "duracao negativa vira travessao, nunca numero");
igual(formatarDuracao(null), "—", "duracao ausente vira travessao");

// --- rotuloAutor: a convencao da 0006, e o terceiro caso que importa acertar
igual(rotuloAutor("uuid-1", "Ana"), "Ana", "pessoa: id + nome");
igual(rotuloAutor(null, "campanha: setembro"), "campanha: setembro", "automacao: id NULL + nome");
ok(
  rotuloAutor(null, null, "painel").includes("sem autor"),
  "os dois NULL NAO viram 'Sistema' — isso afirmaria que a automacao fez"
);
ok(rotuloAutor(null, null, "painel").includes("painel"), "sem autor, a origem ainda aparece pra ajudar o diagnostico");
igual(rotuloAutor(null, "   "), "sem autor registrado", "nome so com espaco conta como ausente");

{
  // linha do tempo: eventos do MAIS NOVO pro mais velho (ordem da rota)
  const agora = "2026-08-31T12:00:00Z";
  const eventos: EventoStatus[] = [
    { id: "e3", status: "concluido", status_anterior: "atendimento", duracao_seg: 1800, por_id: "u1", por_nome: "Ana", origem: "painel", criada_em: "2026-08-31T11:00:00Z" },
    { id: "e2", status: "atendimento", status_anterior: "aberto", duracao_seg: 600, por_id: "u2", por_nome: "Bruno", origem: "painel", criada_em: "2026-08-31T10:30:00Z" },
    { id: "e1", status: "aberto", status_anterior: null, duracao_seg: null, por_id: null, por_nome: null, origem: "importacao", criada_em: "2026-08-31T10:20:00Z" },
  ];
  const { linhas, resumo } = linhaDoTempoStatus(eventos, { agora });
  igual(linhas.length, 3, "as tres linhas");
  ok(linhas[0].atual, "o mais recente e o atual");
  ok(!linhas[1].atual, "os outros nao");
  igual(linhas[0].em_curso_seg, 3600, "o atual tem permanencia EM CURSO (1h desde as 11h)");
  igual(linhas[1].em_curso_seg, null, "evento passado nao tem permanencia em curso");
  igual(linhas[0].autor, "Ana", "autor pronto pra tela");
  ok(linhas[2].autor.includes("sem autor"), "evento sem autor diz que nao sabe");

  const porStatus = new Map(resumo.map((r) => [r.status, r]));
  // a permanencia medida pertence ao status de ONDE saiu
  igual(porStatus.get("atendimento")!.total_seg, 1800, "meia hora em atendimento (medida no evento que saiu dele)");
  igual(porStatus.get("aberto")!.total_seg, 600, "10 minutos em aberto");
  // e o status atual acumula a permanencia EM CURSO
  igual(porStatus.get("concluido")!.total_seg, 3600, "1h em concluido, derivada do agora");
  igual(porStatus.get("atendimento")!.entradas, 1, "uma entrada em atendimento");
  ok(resumo[0].total_seg >= resumo[resumo.length - 1].total_seg, "resumo sai ordenado do maior tempo pro menor");
}
{
  igual(linhaDoTempoStatus([]).linhas.length, 0, "trilha vazia nao explode");
  igual(linhaDoTempoStatus([]).resumo.length, 0, "e nao inventa resumo");
  igual(linhaDoTempoStatus(null as any).linhas.length, 0, "entrada nao-lista degrada pra vazio");
}
{
  // duracao NULL nao pode virar zero somado: "sem medicao" e diferente de "0s"
  const eventos: EventoStatus[] = [
    { id: "a", status: "aberto", status_anterior: "concluido", duracao_seg: null, por_id: "u", por_nome: "Ana", origem: "painel", criada_em: "2026-08-31T10:00:00Z" },
  ];
  const { resumo } = linhaDoTempoStatus(eventos, { agora: "2026-08-31T10:00:00Z" });
  const concluido = resumo.find((r) => r.status === "concluido");
  igual(concluido?.total_seg ?? 0, 0, "duracao ausente nao inventa tempo no status anterior");
}

// ===========================================================================
// 5. Histórico de transferência
// ===========================================================================
{
  const eventos: EventoResponsavel[] = [
    { id: "t2", acao: "removido", tipo: "usuario", ref_id: "u1", ref_nome: "Ana", por_id: "u2", por_nome: "Bruno", origem: "painel", criada_em: "2026-08-31T11:00:00Z" },
    { id: "t1", acao: "atribuido", tipo: "departamento", ref_id: "d1", ref_nome: "Suporte", por_id: null, por_nome: "rodizio", origem: "rodizio", criada_em: "2026-08-31T10:00:00Z" },
    { id: "t0", acao: "atribuido", tipo: "usuario", ref_id: "u9", ref_nome: null, por_id: "u2", por_nome: "Bruno", origem: "painel", criada_em: "2026-08-31T09:00:00Z" },
  ];
  const linhas = linhaDoTempoTransferencia(eventos);
  igual(linhas.length, 3, "as tres transferencias");
  ok(linhas[0].descricao.includes("tirou"), "remocao usa o verbo de remocao, nao 'passou para'");
  ok(linhas[1].descricao.includes("passou a conversa"), "atribuicao usa o verbo de passagem");
  ok(linhas[1].destino.includes("departamento"), "departamento aparece como departamento");
  ok(linhas[0].destino.includes("pessoa"), "usuario aparece como pessoa");
  // a automacao delega, e o log registra isso com o mesmo peso (formato do mapa)
  igual(linhas[1].autor, "rodizio", "automacao aparece nomeada, nao como 'sistema'");
  // nome ausente cai no ref_id: uuid cru na tela e feio, mas mentir e pior
  ok(linhas[2].destino.includes("u9"), "sem nome congelado, o id aparece em vez de 'desconhecido'");
  igual(linhaDoTempoTransferencia([]).length, 0, "trilha vazia nao explode");
  igual(linhaDoTempoTransferencia(null as any).length, 0, "entrada nao-lista degrada pra vazio");
}

// ===========================================================================
// 6. Iniciar conversa — as travas
// ===========================================================================
const BOM = { chat_id: "5511999999999", telefone: "5511999999999", grupo: false, texto: "Bom dia, tudo bem?" };

{
  const r = validarInicioConversa({ ...BOM, confirmado: true });
  ok(r.ok, "pedido completo e confirmado passa");
  if (r.ok) igual(r.chat_id, "5511999999999", "chat_id preservado");
}
// TRAVA 1 — consentimento explicito. Sem isto, qualquer chamador (agente, MCP,
// script) abre conversa com quem nao procurou a empresa.
for (const c of [undefined, false, null, "true", 1, {}]) {
  const r = validarInicioConversa({ ...BOM, confirmado: c as any });
  ok(!r.ok, `confirmado=${JSON.stringify(c)} e recusado (so o booleano true vale)`);
}
ok(
  (validarInicioConversa({ ...BOM, confirmado: undefined }) as any).erro.includes("confirmacao"),
  "a recusa diz qual e o problema"
);
// TRAVA 2 — grupo nao. Entrar em grupo pelo painel e outra coisa.
ok(!validarInicioConversa({ ...BOM, grupo: true, confirmado: true }).ok, "grupo recusado pelo flag");
ok(
  !validarInicioConversa({ ...BOM, chat_id: "123456789012345678-group", confirmado: true }).ok,
  "grupo recusado tambem pelo sufixo do chat_id (o flag pode nao vir)"
);
// TRAVA 3 — primeira mensagem obrigatoria. Abrir conversa vazia nao avisa ninguem.
ok(!validarInicioConversa({ ...BOM, texto: "", confirmado: true }).ok, "texto vazio recusado");
ok(!validarInicioConversa({ ...BOM, texto: "   ", confirmado: true }).ok, "texto so com espaco recusado");
ok(!validarInicioConversa({ ...BOM, texto: undefined, confirmado: true }).ok, "texto ausente recusado");
ok(
  !validarInicioConversa({ ...BOM, texto: "x".repeat(LIMITE_TEXTO_INICIO + 1), confirmado: true }).ok,
  "texto acima do limite recusado"
);
ok(
  validarInicioConversa({ ...BOM, texto: "x".repeat(LIMITE_TEXTO_INICIO), confirmado: true }).ok,
  "texto exatamente no limite passa (o corte e no limite+1)"
);
ok(!validarInicioConversa({ ...BOM, chat_id: "", confirmado: true }).ok, "destino vazio recusado");
{
  // o texto sai TRIMADO, mas o conteudo interno nao e tocado: mensagem e
  // conteudo do usuario, nao dado a normalizar
  const r = validarInicioConversa({ ...BOM, texto: "  linha 1\n\n  linha 2  ", confirmado: true });
  ok(r.ok && r.texto === "linha 1\n\n  linha 2", "trim nas pontas, miolo intacto");
}
// TRAVA 4 — teto por hora. A DECISAO NAO MORA MAIS EM JAVASCRIPT.
igual(TETO_INICIOS_POR_HORA, 20, "teto de conversas novas por pessoa por hora");
// O helper vazado (`estourouTetoInicios`) foi REMOVIDO do lib, nao apenas
// deixado de usar: enquanto existisse, o caminho "contar em JS e depois enviar"
// continuaria a um import de distancia. A guarda estrutural da secao 8 reprova
// se ele voltar.

// ---------------------------------------------------------------------------
// 6b. A CORRIDA DO TETO — o achado grave da revisao cega
// ---------------------------------------------------------------------------
// O QUE ESTA PROVA E, E O QUE ELA NAO E. A atomicidade real mora em
// `mensageria.reservar_inicio` (0017), que conta e insere na MESMA instrucao SQL,
// e ela SO se prova contra o Postgres da instalacao — nao existe em node solto.
// O que esta secao prova e a SEMANTICA que a funcao implementa, com um modelo
// executavel das duas formas: a que vazava e a que nao vaza. Ou seja: trava o
// raciocinio, e a secao 8 trava (por leitura dos arquivos) que a rota usa a
// forma certa.
{
  const TETO = TETO_INICIOS_POR_HORA;
  const PARALELAS = 300;

  // FORMA ANTIGA — ler, decidir, escrever. Cada chamada le a contagem, cede o
  // controle (o `await` do envio ao provedor) e so depois grava.
  {
    let gravadas = 0;
    const passaram: number[] = [];
    await Promise.all(
      Array.from({ length: PARALELAS }, async (_, i) => {
        const contagem = gravadas; // <-- leitura
        if (contagem >= TETO) return; // <-- decisao
        await Promise.resolve(); // <-- o envio ao provedor (cede o controle)
        gravadas += 1; // <-- escrita
        passaram.push(i);
      })
    );
    ok(
      passaram.length > TETO,
      `a forma antiga VAZA: ${passaram.length} de ${PARALELAS} passaram com teto ${TETO}`
    );
  }

  // FORMA NOVA — contar e gravar sem ceder o controle no meio. E o que a
  // instrucao SQL unica garante: as duas transacoes serializam e a segunda ve a
  // primeira.
  {
    let gravadas = 0;
    const reservar = (): boolean => {
      // sem `await` aqui dentro: contagem e insercao no MESMO passo indivisivel
      if (gravadas >= TETO) return false;
      gravadas += 1;
      return true;
    };
    const passaram: number[] = [];
    await Promise.all(
      Array.from({ length: PARALELAS }, async (_, i) => {
        const reservou = reservar(); // <-- gesto atomico
        await Promise.resolve(); // <-- o envio vem DEPOIS da reserva
        if (reservou) passaram.push(i);
      })
    );
    igual(
      passaram.length,
      TETO,
      `a forma nova NAO vaza: exatamente ${TETO} de ${PARALELAS} passaram`
    );
    igual(gravadas, TETO, "e o contador para no teto");
  }

  // A ordem tambem importa: na forma nova o envio acontece DEPOIS da reserva,
  // entao uma chamada barrada nunca chega a tocar o provedor.
  {
    let gravadas = 0;
    let enviosTentados = 0;
    const reservar = () => (gravadas >= TETO ? false : (gravadas += 1, true));
    await Promise.all(
      Array.from({ length: PARALELAS }, async () => {
        if (!reservar()) return;
        await Promise.resolve();
        enviosTentados += 1;
      })
    );
    igual(enviosTentados, TETO, "chamada barrada pelo teto nunca chega a tentar o envio");
  }
}

// ===========================================================================
// 7. Robô por conversa — o portão que o motor vai consumir
// ===========================================================================
// DEFAULT LIGADO: o campo pode faltar porque a 0017 nao rodou, porque a leitura
// falhou ou porque o canal e de fonte externa. Nos tres, `false` desligaria a
// automacao da instalacao inteira em silencio.
ok(botLigado(undefined), "campo ausente = robo LIGADO");
ok(botLigado(null), "campo nulo = robo LIGADO");
ok(botLigado(true), "true = ligado");
ok(!botLigado(false), "so o false explicito desliga");
ok(botLigado(0), "zero nao desliga (nao e o false que alguem gravou)");
ok(botLigado("false"), "a STRING 'false' nao desliga — desligar exige o booleano");

// A regra em duas metades: gatilho respeita, manual ignora.
igual(motivoBotDesligado(false, "manual"), null, "macro disparado A MAO roda mesmo com o robo desligado");
igual(motivoBotDesligado(true, "manual"), null, "manual com robo ligado roda");
igual(motivoBotDesligado(true, "gatilho"), null, "gatilho com robo ligado roda");
ok(motivoBotDesligado(false, "gatilho"), "gatilho com robo DESLIGADO e recusado");
ok(
  motivoBotDesligado(false, "gatilho")!.includes("desligado"),
  "a recusa explica o motivo (vai pro passo da trilha, alguem vai ler)"
);
igual(motivoBotDesligado(undefined, "gatilho"), null, "sem a 0017 o gatilho segue rodando (default ligado)");

// ===========================================================================
// 8. Guardas ESTRUTURAIS sobre os arquivos da frente
// ===========================================================================
// Isto nao testa comportamento: trava PROPRIEDADE do codigo, que e o que volta a
// se perder num refactor apressado. Ler o arquivo e o unico jeito de provar isso
// sem banco e sem navegador (as rotas importam `@/lib/*`, que so o Next resolve).
{
  const { readFileSync } = await import("node:fs");
  const ler = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  const ROTAS = [
    "app/api/conversa/busca/route.ts",
    "app/api/conversa/historicos/route.ts",
    "app/api/conversa/iniciar/route.ts",
  ];
  for (const r of ROTAS) {
    const src = ler(r);
    // toda rota nova resolve o usuario e recusa sem sessao. Rota que esquece
    // isto vira porta aberta pro banco de conversas de um cliente.
    ok(src.includes("getUser(req)"), `${r} resolve o usuario`);
    ok(src.includes('{ status: 401 }'), `${r} recusa sem sessao`);
    // e a autorizacao POR CONVERSA e checada (nao so "esta logado"): as de
    // leitura por `podeVerConversa`; a de iniciar por permissao nomeada, porque
    // ali a conversa ainda NAO existe pra ter escopo.
    ok(
      src.includes("podeVerConversa") || src.includes('permitido(perfil, "iniciar_conversa")'),
      `${r} checa a autorizacao por conversa`
    );
    // o widget embutido nunca ganha alcance maior do que o contexto dele —
    // leitura pela intersecao (`restricaoEfetiva`), iniciar pelo header
    // (`contextoEmbed`), que e barrado explicitamente
    ok(
      src.includes("restricaoEfetiva") || src.includes("contextoEmbed"),
      `${r} respeita o contexto do widget embutido`
    );
  }

  // A rota de iniciar e a unica com efeito externo NOVO: as travas dela ficam
  // travadas aqui pra ninguem "simplificar" o consentimento depois.
  const iniciar = ler("app/api/conversa/iniciar/route.ts");
  ok(iniciar.includes("estaBloqueado"), "iniciar conversa consulta o opt-out do disparo");
  ok(iniciar.includes("optOutDisponivel"), "e sabe distinguir 'pode receber' de 'a lista nao existe'");
  ok(iniciar.includes("validarInicioConversa"), "iniciar conversa passa pela regra pura");
  ok(!/destinos\s*[:=]/.test(iniciar), "iniciar conversa NAO tem campo de multiplos destinos");
  ok(iniciar.includes("normalizarTelefone"), "iniciar conversa reusa a validacao de telefone do disparo");
  ok(
    iniciar.includes('permitido(perfil, "iniciar_conversa")'),
    "iniciar conversa exige a permissao NOMEADA (nao so `enviar`)"
  );

  // O TETO: a reserva atomica tem que vir ANTES do envio, e a contagem em
  // JavaScript nao pode voltar. As duas coisas sao verificadas por POSICAO no
  // arquivo — a ordem e a propriedade, nao a presenca.
  ok(iniciar.includes("reservarInicio"), "iniciar conversa reserva a linha (gesto atomico)");
  ok(
    !iniciar.includes("estourouTetoInicios") && !iniciar.includes("iniciosNaUltimaHora"),
    "o caminho vazado (contar em JS e depois enviar) NAO voltou"
  );
  {
    const posReserva = iniciar.indexOf("await reservarInicio(");
    const posEnvio = Math.min(
      ...["zapiSendText(", "evoSendText("].map((t) => {
        const i = iniciar.indexOf(t);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      })
    );
    ok(posReserva > 0, "a reserva e chamada com await");
    ok(posEnvio < Number.MAX_SAFE_INTEGER, "o envio ao provedor esta no arquivo");
    ok(posReserva < posEnvio, "a RESERVA vem antes do ENVIO (ordem invertida = teto vazado)");
  }
  // O FATO EXTERNO E GRAVADO ISOLADO, entre o envio e as escritas do passo 4.
  // Enquanto `inicio_estado: 'enviado'` so existia dentro do upsert do passo 4,
  // uma falha generica ali deixava a linha 'reservado' — e a faxina dos 10
  // minutos depois a marcava "nao enviada: tempo esgotado" com selo vermelho,
  // afirmando que a mensagem nao saiu quando ela saiu (atendente reenvia = 2a
  // abordagem fria no cliente). A guarda e de POSICAO porque e a posicao que
  // resolve: a mesma chamada depois do upsert nao protegeria de nada.
  {
    const posEnvio = Math.min(
      ...["zapiSendText(", "evoSendText("].map((t) => {
        const i = iniciar.indexOf(t);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      })
    );
    const posEnviado = iniciar.indexOf('encerrarReserva(canal, v.chat_id, "enviado")');
    // ancora no upsert DO PASSO 4 (o `from(T.conversas)` mais cedo do arquivo e a
    // leitura do caminho 'ja_existe', que roda muito antes do envio)
    const posUpsert = iniciar.indexOf("{ ...linhaConversa, ...(semMigration");
    ok(posEnviado > 0, "o sucesso do envio e gravado por chamada PROPRIA (nao so dentro do upsert)");
    ok(posUpsert > 0, "o upsert do passo 4 existe no arquivo");
    ok(
      posEnvio < posEnviado && posEnviado < posUpsert,
      "e ela roda ENTRE o envio e a primeira escrita falivel do passo 4"
    );
  }

  // FAIL-CLOSED: falha transiente na reserva recusa; so a ausencia da migration
  // degrada. `503` e o codigo dessa recusa — se ele sair do arquivo, o teto
  // voltou a ser fail-open.
  ok(iniciar.includes("{ status: 503 }"), "falha transiente na reserva recusa com 503, sem enviar");
  ok(iniciar.includes("sem_0017"), "e a ausencia da migration e tratada separado da falha");
  // 207: enviou e nao registrou. Nunca `ok: true` sem conferir as escritas.
  ok(iniciar.includes("{ status: 207 }"), "envio sem registro responde 207, nunca ok:true");
  ok(iniciar.includes("registro_parcial"), "registro incompleto e declarado na resposta");

  // A trilha nao pode ficar em promessa solta: serverless congela na resposta.
  const conversaRoute = ler("app/api/conversa/route.ts");
  for (const fn of ["registrarEventoResponsavel", "registrarEventoStatus", "registrarEventoRobo"]) {
    const soltas = conversaRoute.split(new RegExp(`(?<!await )\\b${fn}\\(\\{`)).length - 1;
    ok(soltas === 0, `/api/conversa da await em ${fn} (promessa solta morre no congelamento do serverless)`);
  }
  // e o gate de permissao do robo roda ANTES de qualquer escrita
  {
    const posGate = conversaRoute.indexOf("bot_ativo !== undefined) &&");
    const posEscrita = conversaRoute.indexOf('from("conversa_responsaveis").upsert');
    ok(posGate > 0 && posEscrita > 0, "gate e primeira escrita existem no arquivo");
    ok(posGate < posEscrita, "o gate que cobre bot_ativo roda ANTES da primeira escrita");
  }

  // Nenhum parametro de conteudo de terceiro vira HTML na tela nova, e nenhum
  // arquivo desta frente executa DDL em runtime (a 0017 e gesto humano).
  const ARQUIVOS = [
    "lib/tela-conversa.ts",
    "lib/tela-conversa-db.ts",
    "app/conversa-historicos.tsx",
    ...ROTAS,
  ];
  for (const a of ARQUIVOS) {
    const src = ler(a);
    // o proprio comentario cita o nome da API; o que nao pode e a CHAMADA
    ok(!/dangerouslySetInnerHTML\s*=/.test(src), `${a} nao injeta HTML`);
    ok(!/\b(create table|alter table|drop table)\b/i.test(src), `${a} nao executa DDL em runtime`);
  }

  // lib/tela-conversa.ts e PURO: se ganhar um import, para de rodar em node
  // solto e esta prova inteira morre junto.
  const puro = ler("lib/tela-conversa.ts");
  ok(!/^\s*import\s/m.test(puro), "lib/tela-conversa.ts continua SEM nenhum import");

  // lib/fluxo/executar.ts NAO e desta frente. A prova trava isso porque o campo
  // do robo TENTA puxar a costura pra dentro dele.
  const executar = ler("lib/fluxo/executar.ts");
  ok(!executar.includes("tela-conversa"), "lib/fluxo/executar.ts nao foi costurado por esta frente");

  // ------------------------------------------------------------- a migration
  // A 0017 nao roda em prova (codigo nao cria tabela — e gesto humano), mas o
  // TEXTO dela e verificavel. Estes asserts existem porque cada um deles ja
  // falhou uma vez: os revokes eram so um comentario, e o indice nao existia.
  const ddl = ler("supabase/migrations/0017_tela_conversa.sql");
  for (const t of ["conversa_status_eventos", "conversa_responsavel_eventos"]) {
    ok(
      new RegExp(`grant select, insert on mensageria\\.${t}`).test(ddl),
      `0017 concede select+insert em ${t}`
    );
    // `grant select, insert` NAO TIRA NADA: a 0001 aplicou `alter default
    // privileges ... grant all`, entao toda tabela nova nasce com update/delete.
    // Sem o revoke explicito, "trilha imutavel" era so um comentario.
    ok(
      new RegExp(`revoke update, delete on mensageria\\.${t}`).test(ddl),
      `0017 REVOGA update+delete em ${t} (o grant sozinho nao tira o default privilege)`
    );
  }
  ok(
    ddl.includes("revoke update, delete on mensageria.conversa_funil_eventos"),
    "0017 revoga tambem na irma mais velha conversa_funil_eventos (0009, mesma armadilha)"
  );
  ok(
    /create index if not exists ix_avaliacoes_conversa/.test(ddl),
    "0017 cria o indice que a leitura de avaliacao por conversa usa (a 0001 nao criou nenhum)"
  );
  // as duas funcoes que tiram as corridas de JavaScript
  ok(ddl.includes("function mensageria.reservar_inicio"), "0017 tem a reserva atomica do teto");
  ok(
    ddl.includes("function mensageria.registrar_status_evento"),
    "0017 tem o registro de evento que calcula a duracao na mesma instrucao"
  );
  ok(ddl.includes("notify pgrst"), "0017 recarrega o schema (senao a RPC responde PGRST202)");
  // Migration e GESTO HUMANO: nenhum arquivo de codigo pode LER nem aplicar o
  // .sql. Citar o nome do arquivo num aviso ("a migration 0017 ja foi
  // aplicada?") e o comportamento certo e nao conta — o que nao pode e o codigo
  // abrir ou executar o arquivo.
  ok(
    !ARQUIVOS.some((a) => /(readFile|require|import)[^\n]*migrations/.test(ler(a))),
    "nenhum arquivo de codigo LE a pasta de migrations"
  );
  ok(
    !ARQUIVOS.some((a) => /\.rpc\(\s*["'](exec|exec_sql|query)["']/.test(ler(a))),
    "nenhum arquivo desta frente executa SQL arbitrario por RPC"
  );

  // ------------------------------------- as guardas que a RE-REVISAO exigiu
  // (a) `estaBloqueado` E CHAMADO SEMPRE. A regressao que a re-revisao pegou
  // punha a checagem FAIL-CLOSED atras de um probe FAIL-OPEN
  // (`optOutDisponivel`, que devolve false em QUALQUER falha): timeout no probe
  // pulava o opt-out e a mensagem saia pra quem pediu pra nao receber. Trava
  // por POSICAO — a checagem vem ANTES do probe — e por FORMA: o probe nunca
  // pode reaparecer como condicao dela.
  {
    ok(iniciar.includes("await estaBloqueado("), "a checagem de opt-out e chamada com await");
    ok(
      iniciar.includes("await optOutDisponivel("),
      "o probe da lista de opt-out existe (e o tri-estado da resposta)"
    );
    // A guarda e de FORMA, nao de posicao — e isso mudou de proposito. Enquanto a
    // checagem vinha antes do probe, "posicao" servia de prova; agora o probe roda
    // ANTES pra poder ESCOLHER A FRASE do 403 (`estaBloqueado` devolve true tanto
    // pra "pediu descadastro" quanto pra "nao deu pra conferir", e afirmar o
    // primeiro num blip de banco e afirmar fato falso). O que precisa continuar
    // travado nao e a ordem: e a checagem ser a CONDICAO INTEIRA do if, sem o
    // probe dentro dela.
    ok(
      /if \(await estaBloqueado\([^)]*\)\) \{/.test(iniciar),
      "`estaBloqueado` e a condicao INTEIRA do if (nada porteia a checagem fail-closed)"
    );
    ok(
      /error:\s*optout\s*\n?\s*\?/.test(iniciar) || /optout\s*\?\s*["'`]/.test(iniciar),
      "e o probe escolhe a FRASE do 403, nunca se a recusa acontece"
    );
    // a busca roda no CODIGO, sem os comentarios: o comentario ao lado da
    // checagem CITA a forma proibida (`if (optout && await estaBloqueado(...)`)
    // pra explicar a regressao, e casar com a citacao faria a prova reprovar o
    // codigo certo — e a "correcao" seria apagar a explicacao.
    const codigo = iniciar.replace(/^[ \t]*\/\/.*$/gm, "");
    ok(
      !/optout\s*&&\s*await\s+estaBloqueado/.test(codigo) &&
        !/optOutDisponivel[^;]{0,200}&&[^;]{0,200}estaBloqueado/.test(codigo),
      "a checagem NAO esta condicionada ao probe (`optout && await estaBloqueado(...)` = a regressao de volta)"
    );
  }

  // (b) A POSICAO DO LOCK dentro de `reservar_inicio`. `insert ... select ...
  // where (select count(*) ...) < teto` NAO e atomico sob READ COMMITTED: N
  // chamadas com numeros DIFERENTES leem count=0 cada uma no proprio snapshot e
  // todas passam. So o advisory lock por PESSOA serializa. Presenca nao basta:
  // lock DEPOIS do insert nao protege nada — e o comentario ao lado continuaria
  // afirmando que protege, que e como esta corrida sobreviveu duas revisoes.
  {
    const inicioFn = ddl.indexOf("function mensageria.reservar_inicio");
    const corpo = ddl.slice(inicioFn);
    const fim = corpo.indexOf("$$;");
    const fn = fim > 0 ? corpo.slice(0, fim) : corpo;
    const posLock = fn.indexOf("pg_advisory_xact_lock");
    const posInsert = fn.indexOf("insert into mensageria.%I");
    ok(inicioFn > 0, "reservar_inicio existe na 0017");
    ok(posLock > 0, "reservar_inicio pega o advisory lock");
    ok(posInsert > 0, "reservar_inicio tem o insert da reserva");
    ok(posLock < posInsert, "o LOCK vem ANTES do insert (lock depois nao serializa nada)");
    ok(
      /hashtext\(\s*'mensageria\.reservar_inicio:'\s*\|\|\s*p_user_id::text\s*\)/.test(fn),
      "a chave do lock e a PESSOA (a granularidade do teto), nao a tabela nem a conversa"
    );
    // e a frase que a 1a revisao deixou passar nao volta: dizer "nao ha janela"
    // sobre um insert nao-atomico desliga a revisao seguinte.
    ok(!/Nao ha janela/i.test(ddl), "a 0017 nao afirma atomicidade que nao tem");
  }

  // (d) A RESERVA ORFA (re-revisao, MEDIA N2). Se o processo morre entre reservar
  // e encerrar — lambda congelada, deploy no meio, timeout sem catch — a linha
  // fica 'reservado' pra sempre, com previa dizendo que ha envio em curso. Tres
  // coisas travadas aqui, porque cada uma sozinha ainda deixa o estado invisivel:
  // a previa no proprio INSERT (sem ela a linha nem entra na lista, que ordena
  // por `last_message_at`), a faxina dos 10 minutos, e a POSICAO dela — depois do
  // lock (varrer linha de outra pessoa seria mexer fora do que o lock protege) e
  // antes do insert.
  {
    const fnRes = (() => {
      const i = ddl.indexOf("function mensageria.reservar_inicio");
      const c = ddl.slice(i);
      const f = c.indexOf("$$;");
      return f > 0 ? c.slice(0, f) : c;
    })();
    ok(/last_message_preview\b/.test(fnRes), "o INSERT da reserva grava previa (senao a linha nao aparece na lista)");
    ok(fnRes.includes("'enviando...'"), "e a previa da reserva diz que o envio esta em curso");
    const posLock2 = fnRes.indexOf("pg_advisory_xact_lock");
    const posFaxina = fnRes.indexOf("interval '10 minutes'");
    const posInsert2 = fnRes.indexOf("insert into mensageria.%I");
    ok(posFaxina > 0, "reservar_inicio varre a reserva orfa (10 minutos)");
    ok(
      posLock2 < posFaxina && posFaxina < posInsert2,
      "a faxina roda DEPOIS do lock e ANTES do insert (fora do lock ela mexeria em linha de outra pessoa)"
    );
    ok(
      /iniciada_por_id = %L::uuid/.test(fnRes.slice(posFaxina - 400, posFaxina)),
      "e varre so as reservas DA PESSOA que o lock protege"
    );
    ok(
      /'nao enviada: tempo esgotado'/.test(fnRes),
      "a orfa vira 'nao enviada: tempo esgotado' — motivo FIXO, nunca texto de terceiro"
    );
  }

  // (e) O DROP DA SOBRECARGA (re-revisao, BAIXA N3). `p_motivo` entrou depois, e
  // em Postgres a assinatura faz parte da identidade: `create or replace` com 4
  // argumentos NAO substitui a versao de 3 — ela sobrevive como sobrecarga
  // executavel por `public`, fora do alcance do revoke (que nomeia os 4 tipos).
  // Sem o drop, a idempotencia que este arquivo anuncia seria falsa em toda
  // instalacao que rodou a versao anterior.
  {
    const posDrop = ddl.indexOf("drop function if exists mensageria.encerrar_reserva_inicio(text, text, text)");
    const posCreate = ddl.indexOf("create or replace function mensageria.encerrar_reserva_inicio");
    ok(posDrop > 0, "0017 dropa a sobrecarga de 3 argumentos de encerrar_reserva_inicio");
    ok(posDrop < posCreate, "e dropa ANTES de criar a versao de 4 (depois derrubaria a nova)");
  }

  // (f) O SELO DO ESTADO INTERMEDIARIO na lista de conversas. `falha_envio` ja
  // tinha selo; `reservado` nao tinha, e e o estado em que a conversa fica
  // enquanto o envio corre — ou pra sempre, quando a reserva orfana.
  {
    const home = ler("app/home.tsx");
    ok(home.includes('c.inicio_estado === "falha_envio"'), "a lista marca a conversa cujo envio falhou");
    ok(home.includes('c.inicio_estado === "reservado"'), "e marca tambem a que esta enviando (reserva em curso)");
  }

  // (g) O SELO DO FLUXO na bolha (costura com a Frente P). Duas propriedades: a
  // decisao vem da regra pura (a tela nao reimplementa "quando tem selo"), e a
  // trilha NAO entra no poll de 3s do `loadMsgs` — o vinculo mensagem->fluxo nao
  // muda pra mensagem que ja existe, e um poll aqui custaria uma consulta de
  // trilha a cada 3s por atendente com a tela aberta.
  {
    const home = ler("app/home.tsx");
    ok(home.includes("seloDeFluxo(vincFluxo, m)"), "a bolha decide o selo pela regra pura, nao no JSX");
    ok(home.includes("fluxo-fila?trilha=1"), "e consome a trilha que a Frente P entregou");
    const corpoLoadMsgs = (() => {
      const i = home.indexOf("const loadMsgs = useCallback");
      const j = home.indexOf("}, [authedFetch]);", i);
      return i > 0 && j > i ? home.slice(i, j) : "";
    })();
    ok(corpoLoadMsgs.length > 0, "loadMsgs foi localizado no arquivo");
    ok(!corpoLoadMsgs.includes("fluxo-fila"), "a trilha NAO entra no poll de 3s das mensagens");
    ok(
      !/setInterval\([^)]*carregarVinculoFluxo/.test(home),
      "e nao ganhou timer proprio (carrega uma vez por conversa aberta)"
    );
    // GATE ANTES DA CHAMADA: o modulo de automacao nasce desligado e a rota exige
    // `automacao` ou `aprovar_automacao` — sem o gate era um 403 por clique em
    // conversa pra todo atendente da instalacao tipica.
    // Tranche 2 da revisao de interface (03/09/2026): o gate ganhou a 2a metade — o
    // MODULO desligado na instalacao (perfil.modulos.automacao === false) tambem nao
    // busca, senao era 403 por clique mesmo pra quem tem a permissao. O comentario
    // que explica o gate fica entre a condicao e a chamada, por isso a janela e larga.
    const gateTrilha =
      /perfil\?\.modulos\?\.automacao !== false &&\s*\(temPermissao\("automacao"\) \|\| temPermissao\("aprovar_automacao"\)\)\s*\) \{[\s\S]{0,1500}?carregarVinculoFluxo/.exec(home);
    ok(!!gateTrilha, "a trilha so e buscada por quem a rota deixa ler E com o modulo ligado (sem 403 por clique)");
    ok(
      !!gateTrilha && !/\n\s*\}\s*\n/.test(gateTrilha[0].replace(/\/\/[^\n]*/g, "")),
      "a chamada da trilha esta DENTRO do bloco do gate (nao depois dele)"
    );
  }

  // (c) A PERMISSAO NOVA APARECE NA TELA DE PAPEIS. Permissao que existe no
  // codigo e nao aparece no catalogo do admin e permissao que ninguem consegue
  // conceder: o botao fica escondido pra sempre e a feature nasce morta. A tela
  // DERIVA a lista de `PERMISSOES`, entao a nova entra desmarcada sozinha — o
  // que precisa ficar travado e essa derivacao (um catalogo escrito a mao no
  // arquivo da tela seria o jeito conhecido de esquecer a proxima).
  {
    const papeis = ler("app/api/admin/papeis/route.ts");
    ok(
      /permissoes:\s*PERMISSOES\.map/.test(papeis),
      "o catalogo da tela de papeis e DERIVADO de PERMISSOES (permissao nova aparece sozinha)"
    );
    const perm = ler("lib/permissoes.ts");
    ok(/"iniciar_conversa"/.test(perm), "`iniciar_conversa` esta na lista PERMISSOES");
    ok(
      /iniciar_conversa:\s*\n?\s*["'`]/.test(perm),
      "e tem verbete em DESCRICAO_PERMISSAO (sem isso a linha aparece sem rotulo no admin)"
    );
  }
}

// ===========================================================================
// 9. O que a revisão cega reprovou (31/08/2026) — casos que travam a correção
// ===========================================================================

// --- item 12, e a CORRECAO DA CORRECAO (re-revisao, 31/08/2026)
// A revisao anterior mandou escapar `*` no ilike. Foi pior: `*` e coringa do
// POSTGREST, que troca por `%` antes do banco — e troca cegamente, inclusive
// depois da barra. `\*` viajava como `\%` = PERCENT LITERAL, e buscar `*urgente*`
// ou a assinatura `*Nome:*` passou a devolver ZERO (antes devolvia superset).
igual(escaparIlike("a*b"), "a*b", "escaparIlike NAO toca no asterisco (escapa-lo mata o resultado)");
igual(escaparIlike("a_b%c"), "a\\_b\\%c", "e continua escapando os coringas que sao DO POSTGRES");
{
  // o `*` e tratado por `padraoParaIlike`: manda pedacos livres de `*` pro banco
  // (superset) e marca que o resultado precisa de filtro literal em JS
  const p = padraoParaIlike("*Nome:*");
  ok(p.ok, "assinatura *Nome:* e buscavel");
  if (p.ok) {
    igual(p.patterns.join("|"), "Nome:", "o banco recebe o pedaco LIVRE de asterisco");
    igual(p.filtrar, true, "e o resultado tem que ser filtrado em JS");
  }
}
{
  const p = padraoParaIlike("*urgente*");
  ok(p.ok && p.patterns.join("|") === "urgente" && p.filtrar, "*urgente* -> pattern 'urgente' + filtro");
}
{
  // o MAIOR pedaco PRIMEIRO (e o mais seletivo), mas TODOS os pedacos vao: cada
  // `.ilike()` extra ANDa no PostgREST e aperta o superset. So o maior faria o
  // banco devolver tudo que tem "conteudo grande" e o JavaScript pagar a conta.
  const p = padraoParaIlike("ab*conteudo grande*cd");
  ok(p.ok, "termo com tres pedacos e buscavel");
  if (p.ok) {
    igual(p.patterns[0], "conteudo grande", "o MAIOR pedaco vem primeiro");
    igual(p.patterns.length, 3, "e TODOS os pedacos viram filtro (AND no PostgREST)");
    igual(p.patterns.slice(1).sort().join("|"), "ab|cd", "inclusive os curtos das pontas");
  }
}
{
  // termo sem `*`: um pattern so, igual ao termo, e nenhum filtro em JS
  const p = padraoParaIlike("nota fiscal");
  ok(p.ok, "termo sem asterisco e buscavel");
  if (p.ok) {
    igual(p.patterns.join("|"), "nota fiscal", "o pattern e o proprio termo");
    igual(p.filtrar, false, "termo sem asterisco nao filtra em JS");
  }
}
{
  // `*` sozinho seria pattern `%%` = varredura da tabela inteira pra filtrar
  // quase tudo fora. Recusa explicita e melhor que busca que trava o banco.
  const p = padraoParaIlike("***");
  ok(!p.ok, "termo feito SO de asterisco e recusado com motivo");
  const vazio = padraoParaIlike("");
  ok(!vazio.ok, "termo vazio idem");
}
{
  // E O PEDACO TEM MINIMO (re-revisao, BAIXA N4). `*a*` tem pedaco livre de `*`,
  // logo passava — mas `%a%` casa quase toda mensagem do banco: superset enorme,
  // filtro em JS jogando tudo fora, Postgres pagando. O minimo e o MESMO da busca
  // sem `*`, senao o asterisco viraria a porta de fuga do limite.
  const curto = padraoParaIlike("*a*");
  ok(!curto.ok, "pedaco de 1 caractere e recusado (superset da tabela inteira)");
  if (!curto.ok) ok(/refine/i.test(curto.erro), "e a recusa pede refino, em vez de so dizer 'invalido'");
  const noLimite = padraoParaIlike("*ab*");
  ok(noLimite.ok, `pedaco de ${MIN_TERMO_BUSCA} caracteres passa (o minimo e o mesmo da busca sem asterisco)`);
  // e o minimo olha o MAIOR pedaco, nao a soma: `a*b` tem 2 caracteres somados e
  // nenhum pedaco util — o banco receberia `%a%` AND `%b%`, superset gigante
  ok(!padraoParaIlike("a*b").ok, "dois pedacos de 1 caractere tambem sao recusados");
}
{
  // O CONTRATO QUE O FILTRO EM JS TEM QUE HONRAR: o superset entra, e so o que
  // contem o termo INTEIRO (com os asteriscos) sai. Zero falso positivo.
  const superset = [
    "*Nome:* bom dia",       // tem o termo inteiro
    "Nome: bom dia",         // tem o pedaco, NAO tem os asteriscos
    "meu *Nome:* aqui",      // tem o termo no meio
    "outro assunto",         // nem o pedaco
  ];
  const filtrado = superset.filter((t) => casaTermo(t, "*Nome:*"));
  igual(filtrado.length, 2, "o filtro literal descarta quem tem so o pedaco, sem os asteriscos");
  ok(!filtrado.includes("Nome: bom dia"), "e o falso positivo do superset nao passa");
}

// --- item 17: booleano ESTRITO no pedido do robo
igual(booleanoEstrito(true), true, "true passa");
igual(booleanoEstrito(false), false, "false passa");
for (const v of ["false", "true", 0, 1, "", null, undefined, {}, []]) {
  igual(booleanoEstrito(v as any), null, `${JSON.stringify(v) ?? "undefined"} NAO e booleano: devolve null`);
}
// o caso que motivou a trava: `!!"false"` e TRUE, e ligaria o robo pra quem
// pediu pra desligar
ok(!!"false" === true, "prova do perigo: !!'false' e true em JavaScript");
igual(booleanoEstrito("false"), null, "e por isso a string 'false' e recusada com 400 em vez de virar true");

// --- item 10: evento de robo vive na trilha de status, mas NAO e troca de status
igual(ORIGEM_ROBO, "robo", "a origem que marca o evento do robo");
ok(ehEventoRobo({ origem: ORIGEM_ROBO }), "evento com origem robo e do robo");
ok(!ehEventoRobo({ origem: "painel" }), "evento do painel nao e do robo");
ok(!ehEventoRobo({}), "evento sem origem nao e do robo (fail-open pra trilha antiga)");
{
  // A MEDICAO NAO PODE SER POLUIDA. Uma conversa que ficou 2h em atendimento e
  // teve o robo desligado no meio precisa continuar mostrando 2h — se o evento
  // do robo entrasse na linha do tempo, ele viraria um "status" a mais e ainda
  // reiniciaria a contagem de permanencia.
  const eventos: EventoStatus[] = [
    { id: "r1", status: STATUS_ROBO_DESLIGADO, status_anterior: STATUS_ROBO_LIGADO, duracao_seg: 999999, por_id: "u1", por_nome: "Ana", origem: ORIGEM_ROBO, criada_em: "2026-08-31T11:30:00Z" },
    { id: "e2", status: "concluido", status_anterior: "atendimento", duracao_seg: 7200, por_id: "u1", por_nome: "Ana", origem: "painel", criada_em: "2026-08-31T11:00:00Z" },
    { id: "e1", status: "atendimento", status_anterior: "aberto", duracao_seg: 60, por_id: "u1", por_nome: "Ana", origem: "painel", criada_em: "2026-08-31T09:00:00Z" },
  ];
  const { linhas, resumo } = linhaDoTempoStatus(eventos, { agora: "2026-08-31T12:00:00Z" });
  igual(linhas.length, 2, "o evento do robo NAO entra na linha do tempo de status");
  ok(!linhas.some((l) => l.origem === ORIGEM_ROBO), "e nenhuma linha tem origem robo");
  igual(linhas[0].status, "concluido", "o ATUAL segue sendo a ultima troca de status real, nao o clique no robo");
  const atendimento = resumo.find((r) => r.status === "atendimento");
  igual(atendimento?.total_seg, 7200, "2h em atendimento — a duracao gigante do evento de robo nao entrou na soma");
  // e o "em curso" do atual mede desde a troca REAL, nao desde o clique no robo
  igual(linhas[0].em_curso_seg, 3600, "permanencia em curso conta desde as 11h (a troca), nao desde as 11h30 (o robo)");
}
{
  // trilha SO com evento de robo: a tela nao pode dizer "essa conversa esta em
  // robo_desligado ha 3 dias"
  const so: EventoStatus[] = [
    { id: "r", status: STATUS_ROBO_LIGADO, status_anterior: STATUS_ROBO_DESLIGADO, duracao_seg: 10, por_id: "u", por_nome: "Ana", origem: ORIGEM_ROBO, criada_em: "2026-08-31T10:00:00Z" },
  ];
  const r = linhaDoTempoStatus(so, { agora: "2026-08-31T12:00:00Z" });
  igual(r.linhas.length, 0, "trilha so de robo aparece VAZIA no painel de status");
  igual(r.resumo.length, 0, "e nao produz resumo nenhum");
}

// --- item 7: resumo cortado nao pode se passar por total
{
  const eventos: EventoStatus[] = [
    { id: "b", status: "concluido", status_anterior: "atendimento", duracao_seg: 600, por_id: "u", por_nome: "Ana", origem: "painel", criada_em: "2026-08-31T11:00:00Z" },
    { id: "a", status: "atendimento", status_anterior: "aberto", duracao_seg: 300, por_id: "u", por_nome: "Ana", origem: "painel", criada_em: "2026-08-31T10:00:00Z" },
  ];
  igual(
    linhaDoTempoStatus(eventos, { agora: "2026-08-31T12:00:00Z" }).resumo_parcial,
    false,
    "leitura completa: o resumo E o total"
  );
  igual(
    linhaDoTempoStatus(eventos, { agora: "2026-08-31T12:00:00Z", truncado: true }).resumo_parcial,
    true,
    "leitura CORTADA: o resumo e parcial, e a tela tem que rotular"
  );
  // e o resumo continua vindo (nao somem com ele: a fatia recente ainda serve)
  ok(
    linhaDoTempoStatus(eventos, { agora: "2026-08-31T12:00:00Z", truncado: true }).resumo.length > 0,
    "parcial nao significa vazio — o numero continua util, so nao e total"
  );
}

// ===========================================================================
// 10. Selo "isto saiu do fluxo X" na bolha (costura com a Frente P, 31/08/2026)
// ===========================================================================
// A trilha vem de `GET /api/fluxo-fila?trilha=1` (`por_mensagem`). A regra de
// QUANDO existe selo e QUAL rotulo aparece e pura, e mora aqui — a bolha so
// desenha o que esta funcao decide.
{
  // A CHAVE DO MAPA e o `id` da linha em `mensagens` (uuid), NAO o
  // `provider_msg_id`: quem grava e lib/fluxo/executar.ts, que guarda o id
  // devolvido pelo insert, e a coluna da 0018 e `mensagem_id uuid`. Este caso
  // existe porque indexar pelo id do provedor devolveria selo NENHUM em silencio
  // — e "sem selo" e indistinguivel de "nao saiu de fluxo".
  const mapa = {
    "11111111-1111-1111-1111-111111111111": {
      execucao_id: "e1",
      fluxo_slug: "boas-vindas",
      fluxo_nome: "Boas-vindas",
      no_id: "n1",
    },
    "22222222-2222-2222-2222-222222222222": {
      execucao_id: "e2",
      fluxo_slug: "cobranca-d3",
      fluxo_nome: null,
      no_id: null,
    },
  };

  const s1 = seloDeFluxo(mapa, { id: "11111111-1111-1111-1111-111111111111", from_me: true });
  ok(!!s1, "mensagem enviada cujo id esta na trilha leva selo");
  if (s1) {
    igual(s1.rotulo, "Boas-vindas", "o rotulo e o NOME do fluxo quando ele existe");
    igual(s1.fluxo_slug, "boas-vindas", "e o slug viaja pro title (e por onde se desliga o fluxo)");
  }

  // fluxo sem nome (deletado, ou nome nulo na tabela): cai no slug. Slug tecnico e
  // feio, mas "saiu de um fluxo" sem dizer QUAL e pior — o atendente precisa saber
  // onde mexer pra parar aquilo.
  const s2 = seloDeFluxo(mapa, { id: "22222222-2222-2222-2222-222222222222", from_me: true });
  ok(!!s2 && s2.rotulo === "cobranca-d3", "sem nome, o rotulo cai no slug (nunca fica sem identificacao)");

  // SO MENSAGEM ENVIADA. A trilha registra o que a automacao FEZ, e o que ela faz
  // e mandar; "o cliente escreveu isso pelo fluxo" nao significa nada pra quem le.
  ok(
    !seloDeFluxo(mapa, { id: "11111111-1111-1111-1111-111111111111", from_me: false }),
    "mensagem RECEBIDA nao leva selo, mesmo com o id no mapa"
  );
  ok(
    !seloDeFluxo(mapa, { id: "11111111-1111-1111-1111-111111111111" }),
    "e `from_me` ausente tambem nao (o selo exige a afirmacao, nao a falta dela)"
  );

  // mensagem digitada por gente na mesma conversa: sem selo, e sem barulho
  ok(!seloDeFluxo(mapa, { id: "33333333-3333-3333-3333-333333333333", from_me: true }), "id fora do mapa = sem selo");

  // TODO CAMINHO RUIM E SILENCIOSO, porque isto e METADADO: 403 por falta de
  // `automacao`, modulo desligado, instalacao sem a 0018 (`vinculo_disponivel:
  // false`), rede caindo — tudo chega aqui como mapa nulo/vazio, e a resposta e
  // `null`, nunca um aviso na tela.
  ok(!seloDeFluxo(null, { id: "11111111-1111-1111-1111-111111111111", from_me: true }), "mapa nulo (403/rede) = sem selo");
  ok(!seloDeFluxo({}, { id: "11111111-1111-1111-1111-111111111111", from_me: true }), "mapa vazio (sem 0018) = sem selo");
  ok(!seloDeFluxo(mapa, null), "sem mensagem = sem selo (nunca estoura)");

  // vinculo que chegou sem identificacao nenhuma nao vira selo vazio na tela
  ok(
    !seloDeFluxo({ x: { execucao_id: "e3", fluxo_slug: "", fluxo_nome: null } }, { id: "x", from_me: true }),
    "vinculo sem slug e sem nome nao desenha selo em branco"
  );
  // id que nao e string (resposta estranha da rota) nao vai indexar objeto
  ok(!seloDeFluxo(mapa, { id: 11111111, from_me: true } as any), "id nao-string nao busca no mapa");

  // TETO NO ROTULO: nome de fluxo e conteudo de TERCEIRO (fluxo importado, nome
  // digitado por quem configurou) e vai inteiro pro `title` da bolha. Sem teto,
  // um nome de 4 mil caracteres virava tooltip cobrindo a conversa.
  {
    const gigante = "N".repeat(500);
    const s3 = seloDeFluxo({ z: { fluxo_slug: "s", fluxo_nome: gigante } }, { id: "z", from_me: true });
    ok(!!s3 && s3.rotulo.length === 120, "nome gigante e cortado em 120 chars");
    const slugGigante = seloDeFluxo({ z: { fluxo_slug: gigante, fluxo_nome: null } }, { id: "z", from_me: true });
    ok(
      !!slugGigante && slugGigante.rotulo.length === 120 && slugGigante.fluxo_slug.length === 120,
      "e o slug tambem — ele vai pro title quando nao ha nome"
    );
  }
}

// ===========================================================================
console.log(`prova-tela-conversa: ${casos} casos OK`);
