// Prova da seguranca de conta (Frente Q) — SEM banco e SEM navegador.
// Roda em Node >= 22.6 sem build: `node scripts/prova-seguranca-conta.ts`
// (type stripping nativo; `import type` e apagado, e os modulos puros deste
// repo importam por caminho relativo COM extensao, que o node resolve).
//
// O que esta prova trava, por card:
//
//  A) 86ak858x0 JANELA DE ACESSO — dentro/fora com FUSO de verdade (nao aritmetica
//     de UTC-3), dois periodos por dia (o intervalo do almoco), VIRADA DE
//     MEIA-NOITE nos dois lados, horario de verao do hemisferio norte, e a
//     retrocompatibilidade que manda em tudo: sem janela = entra sempre.
//
//  B) 86ak85899 ESCOPO DE CHAVE — somente leitura, recurso, canal, prazo, o teto
//     do autoatendimento e o TUNEL do MCP (que nao pode ser gateado por metodo,
//     senao mata JSON-RPC). Inclui a varredura que cobra verbete de rota nova.
//
//  C) 86ak85zm4 VISIBILIDADE COM E SEM RESTRICAO — a matriz de nao-regressao (o
//     8o parametro ausente TEM que se comportar como antes) e o fail-closed:
//     alvo que nao da pra avaliar NEGA, conversa sem funil NEGA salvo permissao
//     explicita, e a restricao nao tem a valvula do "responsavel sempre ve".
//
//  D) 86ak85917 DISPOSITIVO — impressao ESTAVEL entre versoes de navegador (senao
//     a lista enche de linha morta), leitura de user-agent, robo x gente, e IP
//     real x IP de proxy (a coluna que nasceu inutil na ferramenta antiga).

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  acessoPermitido,
  dentroDaJanela,
  horaValida,
  janelaBloqueiaSempre,
  janelaVazia,
  resumoJanela,
  validarJanela,
  type JanelaAcesso,
} from "../lib/janela-acesso.ts";
import { partesNoFuso } from "../lib/fuso.ts";
// registro de canais: a varredura B.10 deriva dele o padrao de busca por id de
// canal usado como literal (toque da Frente U — ver a nota no proprio bloco)
import {
  CANAL_NAO_REGISTRADO,
  canaisBuiltin,
  canalDoPedido,
  canalParaEscopo,
  listarCanais,
} from "../lib/canais.ts";
// a guarda do 415 (`corpoJsonObrigatorio`) mora no arquivo PURO da regra de
// conexao — lib/canais-porta.ts nao carrega em node puro (o especificador
// `next/server` sem extensao e o alias `@/` pediriam hook de resolve; o modulo em
// si carrega, medido na 4a re-revisao)
import { corpoJsonObrigatorio } from "../lib/canal-conexao.ts";
import {
  CANAL_PADRAO,
  CANAL_PADRAO_EM,
  DESCRICAO_RECURSO,
  RECURSOS,
  TOCA_TODOS_OS_CANAIS,
  assumeCanalPadrao,
  exigeCanalExplicito,
  mesclarEscopo,
  chaveExpirada,
  escopoAberto,
  escopoPermite,
  escopoSemPrivilegio,
  recursoDaRota,
  resumoEscopo,
  rotuloValido,
  validarEscopoChave,
} from "../lib/escopo-chave.ts";
import {
  conversaVisivel,
  restricaoPermite,
  restricaoVazia,
  type AlvoConversa,
  type ContextoVisao,
  type PerfilVisao,
  type Responsavel,
  type RestricaoUsuario,
  type VisibilidadeEntry,
} from "../lib/visibilidade.ts";
import {
  assinaturaDispositivo,
  ipDoCliente,
  ipPrivado,
  lerUserAgent,
} from "../lib/dispositivo-ua.ts";
import {
  MOTIVO_CHAVE_SEM_ACESSO,
  RECUSA_CHAVE,
  SEM_IDENTIDADE,
  chaveServe,
  ehSemIdentidade,
  motivoLimpo,
  recusaDaChave,
  respostaDaRecusa,
  type LinhaDeChave,
} from "../lib/recusa.ts";

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
const LISBOA = "Europe/Lisbon";
const NY = "America/New_York";

// instante -> partes no fuso -> a decisao. E o caminho REAL do servidor
// (lib/acesso.ts faz exatamente isto), so sem o banco no meio.
const em = (j: JanelaAcesso, iso: string, fuso = SP) => acessoPermitido(j, new Date(iso), fuso);

// =========================================================== A) JANELA DE ACESSO

// A.1 retrocompatibilidade — a invariante que manda em tudo
{
  const seg_sex: JanelaAcesso = validarJanela({
    ativo: true,
    dias: { 1: [["08:00", "18:00"]], 2: [["08:00", "18:00"]] },
  });
  eq(dentroDaJanela(null, { diaSemana: 3, hora: 3, minuto: 0 }), true, "sem linha de janela = entra sempre");
  eq(
    dentroDaJanela(undefined, { diaSemana: 0, hora: 23, minuto: 59 }),
    true,
    "janela indefinida = entra sempre (instalacao que nunca configurou)"
  );
  const desligada = validarJanela({ ativo: false, dias: { 1: [["08:00", "09:00"]] } });
  eq(
    dentroDaJanela(desligada, { diaSemana: 3, hora: 3, minuto: 0 }),
    true,
    "janela DESLIGADA nao barra, mesmo com grade cadastrada"
  );
  eq(janelaVazia(desligada), true, "janela desligada nao restringe nada");
  eq(janelaVazia(seg_sex), false, "janela ligada com grade restringe");
  // e o contraste que prova que a retrocompatibilidade nao e acidental
  eq(dentroDaJanela(seg_sex, { diaSemana: 3, hora: 12, minuto: 0 }), false, "quarta nao esta na grade = barrado");
}

// A.2 grade vazia com a janela LIGADA = fail-closed, e a rota recusa esse estado
{
  const ligadaVazia = validarJanela({ ativo: true, dias: {} });
  eq(dentroDaJanela(ligadaVazia, { diaSemana: 1, hora: 10, minuto: 0 }), false, "ligada e vazia barra sempre");
  eq(janelaBloqueiaSempre(ligadaVazia), true, "a rota reconhece o estado de lockout e recusa gravar");
  // dia presente porem sem periodo VALIDO conta como vazio (senao um {"1":[]} do
  // front passaria pelo teste de lockout da rota e barraria a pessoa 24/7)
  const soLixo = validarJanela({ ativo: true, dias: { 1: [], 2: [["25:00", "26:00"]], 3: [["08:00", "08:00"]] } });
  dep(soLixo.dias, {}, "dia sem periodo valido nao entra na grade");
  eq(janelaBloqueiaSempre(soLixo), true, "grade que so tinha lixo e reconhecida como lockout");
}

// A.3 saneamento
{
  eq(horaValida("00:00"), true, "00:00 e hora valida");
  eq(horaValida("23:59"), true, "23:59 e hora valida");
  eq(horaValida("24:00"), false, "24:00 nao existe");
  eq(horaValida("7:00"), false, "hora sem zero a esquerda e recusada (a comparacao e por string)");
  eq(horaValida("08:60"), false, "minuto 60 nao existe");
  const j = validarJanela({
    ativo: true,
    dias: {
      1: [["13:00", "18:00"], ["08:00", "12:00"], ["19:00", "20:00"]],
      9: [["08:00", "09:00"]],
      x: [["08:00", "09:00"]],
    },
    lixo: true,
  });
  eq(j.dias[1].length, 2, "no maximo DOIS periodos por dia (o terceiro e descartado)");
  dep(
    j.dias[1].map((p) => p.de),
    ["08:00", "13:00"],
    "os dois PRIMEIROS periodos validos e que ficam (o 19:00 cai fora), ja ordenados por hora"
  );
  eq(j.dias[9 as any], undefined, "dia fora de 0..6 e ignorado");
  eq(validarJanela("nao e objeto").ativo, false, "entrada que nao e objeto vira janela vazia");
  eq(validarJanela(null).ativo, false, "null vira janela vazia");
  // formato {de,ate} tambem vale (e o que o front manda)
  const obj = validarJanela({ ativo: true, dias: { 5: [{ de: "09:00", ate: "17:00" }] } });
  dep(obj.dias[5], [{ de: "09:00", ate: "17:00" }], "periodo em {de,ate} e aceito igual ao par");
}

// A.4 dois periodos por dia — o intervalo do almoco, que e a razao do segundo
{
  const comercial = validarJanela({
    ativo: true,
    dias: {
      1: [["08:00", "12:00"], ["13:00", "18:00"]],
      2: [["08:00", "12:00"], ["13:00", "18:00"]],
      3: [["08:00", "12:00"], ["13:00", "18:00"]],
      4: [["08:00", "12:00"], ["13:00", "18:00"]],
      5: [["08:00", "12:00"], ["13:00", "18:00"]],
    },
  });
  const seg = (h: number, m = 0) => dentroDaJanela(comercial, { diaSemana: 1, hora: h, minuto: m });
  eq(seg(7, 59), false, "07:59 e antes do turno");
  eq(seg(8, 0), true, "08:00 abre (inicio INCLUSIVO)");
  eq(seg(11, 59), true, "11:59 ainda no turno da manha");
  eq(seg(12, 0), false, "12:00 fecha (fim EXCLUSIVO) — o almoco e buraco de verdade");
  eq(seg(12, 30), false, "12:30 esta no almoco");
  eq(seg(13, 0), true, "13:00 abre o turno da tarde");
  eq(seg(17, 59), true, "17:59 ainda no turno");
  eq(seg(18, 0), false, "18:00 fecha o dia");
  eq(dentroDaJanela(comercial, { diaSemana: 6, hora: 10, minuto: 0 }), false, "sabado nao esta na grade");
  eq(dentroDaJanela(comercial, { diaSemana: 0, hora: 10, minuto: 0 }), false, "domingo nao esta na grade");
  assert.match(resumoJanela(comercial), /segunda 08:00-12:00 e 13:00-18:00/);
  assercoes++;
}

// A.5 VIRADA DE MEIA-NOITE — o turno da noite pertence a escala do dia em que
// COMECOU. E o caso que quebra implementacao ingenua nos dois lados.
{
  // sexta 22:00 -> sabado 06:00, e so isso
  const noturno = validarJanela({ ativo: true, dias: { 5: [["22:00", "06:00"]] } });
  const q = (dia: number, hora: number, minuto = 0) => dentroDaJanela(noturno, { diaSemana: dia, hora, minuto });
  eq(q(5, 21, 59), false, "sexta 21:59 ainda nao abriu");
  eq(q(5, 22, 0), true, "sexta 22:00 abre");
  eq(q(5, 23, 59), true, "sexta 23:59 dentro");
  eq(q(6, 0, 0), true, "sabado 00:00 — a madrugada pertence a escala de SEXTA");
  eq(q(6, 5, 59), true, "sabado 05:59 dentro");
  eq(q(6, 6, 0), false, "sabado 06:00 fecha (fim exclusivo)");
  eq(q(6, 22, 0), false, "SABADO 22:00 nao abre: quem esta na grade e a sexta, nao o sabado");
  eq(q(5, 3, 0), false, "sexta 03:00 nao vale: a madrugada de sexta pertenceria a QUINTA");
  // e a prova de que a borda do domingo tambem fecha (o (dia+6)%7 do codigo)
  const domingoNoite = validarJanela({ ativo: true, dias: { 0: [["23:00", "02:00"]] } });
  eq(
    dentroDaJanela(domingoNoite, { diaSemana: 1, hora: 1, minuto: 30 }),
    true,
    "segunda 01:30 pertence a escala de DOMINGO (a volta do modulo funciona)"
  );
  eq(
    dentroDaJanela(domingoNoite, { diaSemana: 6, hora: 23, minuto: 30 }),
    false,
    "sabado 23:30 nao abre a janela do domingo"
  );
}

// A.6 FUSO DE VERDADE — a hora vale no fuso da INSTALACAO, nunca em UTC nem no
// fuso do navegador. Sem isto, um atendente em outro fuso e barrado na hora errada.
{
  const comercial = validarJanela({ ativo: true, dias: { 1: [["08:00", "18:00"]] } });
  // 2026-08-31 e uma SEGUNDA. 11:00Z = 08:00 em Sao Paulo (UTC-3, sem verao)
  eq(em(comercial, "2026-08-31T11:00:00Z"), true, "11:00Z = 08:00 em Sao Paulo: dentro");
  eq(em(comercial, "2026-08-31T10:59:00Z"), false, "10:59Z = 07:59 em Sao Paulo: fora");
  eq(em(comercial, "2026-08-31T21:00:00Z"), false, "21:00Z = 18:00 em Sao Paulo: fim exclusivo, fora");
  // MESMO instante, MESMA janela, fusos diferentes = respostas diferentes
  eq(em(comercial, "2026-08-31T07:30:00Z", LISBOA), true, "07:30Z = 08:30 em Lisboa (verao): dentro");
  eq(em(comercial, "2026-08-31T07:30:00Z", SP), false, "o MESMO instante em Sao Paulo e 04:30: fora");
  // virada de dia por causa do fuso: 2026-09-01T02:00Z e ainda SEGUNDA 23:00 em SP
  const soSegunda = validarJanela({ ativo: true, dias: { 1: [["22:00", "23:30"]] } });
  eq(
    em(soSegunda, "2026-09-01T02:00:00Z"),
    true,
    "02:00Z de terca ainda e segunda 23:00 em Sao Paulo — o dia da semana sai do FUSO"
  );
  eq(em(soSegunda, "2026-09-01T02:00:00Z", LISBOA), false, "em Lisboa o mesmo instante ja e terca 03:00");
  // conferencia direta: o dia da semana usado e o do fuso, nao o do UTC
  eq(partesNoFuso(new Date("2026-09-01T02:00:00Z"), SP).diaSemana, 1, "em SP o instante cai numa segunda");
  eq(partesNoFuso(new Date("2026-09-01T02:00:00Z"), LISBOA).diaSemana, 2, "em Lisboa o mesmo instante e terca");
}

// A.7 HORARIO DE VERAO entra sozinho (offset por instante, sem tabela)
{
  const janela = validarJanela({ ativo: true, dias: { 1: [["09:00", "10:00"]], 2: [["09:00", "10:00"]] } });
  // Nova York: 2026-01-05 (segunda) e EST (UTC-5); 2026-07-06 (segunda) e EDT (UTC-4)
  eq(em(janela, "2026-01-05T14:30:00Z", NY), true, "inverno em NY: 14:30Z = 09:30 EST, dentro");
  eq(em(janela, "2026-07-06T14:30:00Z", NY), false, "verao em NY: 14:30Z = 10:30 EDT, fora");
  eq(em(janela, "2026-07-06T13:30:00Z", NY), true, "verao em NY: 13:30Z = 09:30 EDT, dentro");
}

// ========================================================= B) ESCOPO DE CHAVE

// B.1 retrocompatibilidade: chave sem escopo = comportamento de hoje
{
  const aberto = validarEscopoChave({});
  eq(escopoAberto(aberto), true, "escopo {} nao restringe nada — o estado de TODA chave que ja existe");
  for (const [metodo, rota] of [
    ["GET", "/api/chats"],
    ["POST", "/api/send"],
    ["DELETE", "/api/conversa"],
    ["POST", "/api/admin/usuarios"],
  ] as const) {
    eq(escopoPermite(aberto, { metodo, pathname: rota }).ok, true, `escopo vazio libera ${metodo} ${rota}`);
  }
  eq(validarEscopoChave(null).somente_leitura, false, "null vira escopo aberto");
  eq(validarEscopoChave("lixo").canais.length, 0, "string vira escopo aberto");
}

// B.2 somente leitura
{
  const ro = validarEscopoChave({ somente_leitura: true });
  eq(escopoPermite(ro, { metodo: "GET", pathname: "/api/chats" }).ok, true, "somente leitura permite GET");
  eq(escopoPermite(ro, { metodo: "HEAD", pathname: "/api/chats" }).ok, true, "somente leitura permite HEAD");
  const r = escopoPermite(ro, { metodo: "POST", pathname: "/api/send" });
  eq(r.ok, false, "somente leitura barra POST");
  eq(r.ok === false && /somente de leitura/.test(r.motivo), true, "o motivo diz o que aconteceu");
  eq(escopoPermite(ro, { metodo: "patch", pathname: "/api/perfil" }).ok, false, "metodo minusculo tambem e barrado");
  eq(escopoPermite(ro, { metodo: "DELETE", pathname: "/api/minha-chave" }).ok, false, "DELETE barrado");
}

// B.3 recursos — e o fail-closed da rota que nao esta no mapa
{
  const soLeituraDeConversa = validarEscopoChave({ recursos: ["conversas", "mensagens"] });
  eq(escopoPermite(soLeituraDeConversa, { metodo: "GET", pathname: "/api/chats" }).ok, true, "recurso na lista passa");
  eq(
    escopoPermite(soLeituraDeConversa, { metodo: "GET", pathname: "/api/messages" }).ok,
    true,
    "segundo recurso da lista passa"
  );
  eq(
    escopoPermite(soLeituraDeConversa, { metodo: "POST", pathname: "/api/send" }).ok,
    false,
    "recurso fora da lista e barrado (envio)"
  );
  eq(
    escopoPermite(soLeituraDeConversa, { metodo: "GET", pathname: "/api/admin/usuarios" }).ok,
    false,
    "admin fora da lista e barrado"
  );
  eq(
    escopoPermite(soLeituraDeConversa, { metodo: "GET", pathname: "/api/rota-que-nao-existe" }).ok,
    false,
    "FAIL-CLOSED: caminho fora do mapa e negado quando ha lista de recursos"
  );
  // recurso inventado e descartado no saneamento (nao vira permissao nem erro)
  dep(
    validarEscopoChave({ recursos: ["conversas", "voar", 7] }).recursos,
    ["conversas"],
    "recurso inventado e ignorado"
  );
  // prefixo mais especifico ganha
  eq(recursoDaRota("/api/conversa/funil"), "funis", "/api/conversa/funil e FUNIL, nao conversa");
  eq(recursoDaRota("/api/conversa"), "conversas", "/api/conversa e conversa");
  eq(recursoDaRota("/api/relatorios/sla"), "relatorios", "sub-rota herda o recurso do prefixo");
  eq(recursoDaRota("/api/chats/"), "conversas", "barra no fim nao muda o recurso");
  eq(recursoDaRota(""), null, "caminho vazio nao resolve recurso");
  eq(recursoDaRota(undefined), null, "caminho ausente nao resolve recurso");
}

// B.4 o TUNEL do MCP — nao pode ser gateado por metodo nem por recurso
{
  const ro = validarEscopoChave({ somente_leitura: true, recursos: ["conversas"] });
  eq(
    escopoPermite(ro, { metodo: "POST", pathname: "/api/mcp/mcp" }).ok,
    true,
    "o tunel do MCP passa: JSON-RPC streamable e POST ate pra tool de LEITURA"
  );
  // ...e a conferencia real acontece na rota REST que o tunel chama a seguir
  eq(
    escopoPermite(ro, { metodo: "POST", pathname: "/api/send" }).ok,
    false,
    "a chamada que o tunel faz DEPOIS e que e barrada — a mesma chave, a rota real"
  );
  // canal continua valendo no tunel (o tunel nao muda de numero)
  const soCentral = validarEscopoChave({ canais: ["central"] });
  eq(
    escopoPermite(soCentral, { metodo: "POST", pathname: "/api/mcp/mcp", canal: "apioficial" }).ok,
    false,
    "canal proibido e barrado ate no tunel"
  );
}

// B.5 canais — e o FURO que a revisao pegou: canal AUSENTE no pedido nao pode
// virar "sem canal", porque a ROTA resolve ausente como `central` (lib/canal.ts).
// Sem isto, chave restrita ao apioficial lia o central inteiro so OMITINDO
// `?canal=`.
{
  const soCentral = validarEscopoChave({ canais: ["central"] });
  const soOficial = validarEscopoChave({ canais: ["apioficial"] });
  eq(escopoPermite(soCentral, { metodo: "GET", pathname: "/api/chats", canal: "central" }).ok, true, "canal na lista passa");
  eq(
    escopoPermite(soCentral, { metodo: "GET", pathname: "/api/chats", canal: "apioficial" }).ok,
    false,
    "canal fora da lista e barrado"
  );

  // O CASO DO FURO, agora fechado — o pedido que o revisor mandou provar:
  eq(
    escopoPermite(soOficial, { metodo: "GET", pathname: "/api/messages", canal: null }).ok,
    false,
    "chave restrita ao apioficial lendo /api/messages SEM canal = NEGA (a rota usaria central)"
  );
  eq(
    escopoPermite(soCentral, { metodo: "GET", pathname: "/api/messages", canal: null }).ok,
    true,
    "...e a chave restrita ao central passa, porque central E o default da rota"
  );
  eq(CANAL_PADRAO, "central", "o default assumido aqui e o MESMO de lib/canal.ts");

  // ...mas a suposicao e de ROTA + METODO, nao de recurso. A 2a revisao mediu os
  // dois erros do Set por recurso, e os dois estao travados aqui.
  //
  // (a) O FURO: rota que resolve canal cujo RECURSO ficava fora do Set. Medido:
  //     chave restrita ao apioficial escrevia etiqueta e movia conversa de etapa
  //     no canal proibido — alcancavel pelo MCP com `definir_etiquetas` sem canal.
  eq(
    escopoPermite(soOficial, { metodo: "POST", pathname: "/api/etiquetas", canal: null }).ok,
    false,
    "POST /api/etiquetas SEM canal = NEGA (a rota usaria central) — era o furo do recurso `etiquetas`"
  );
  eq(
    escopoPermite(soOficial, { metodo: "GET", pathname: "/api/conversa/funil", canal: null }).ok,
    false,
    "GET /api/conversa/funil SEM canal = NEGA — era o furo do recurso `funis`"
  );
  eq(
    escopoPermite(soOficial, { metodo: "POST", pathname: "/api/conversa/funil", canal: null }).ok,
    false,
    "POST /api/conversa/funil SEM canal = NEGA (mover etapa no canal proibido)"
  );
  //
  // (b) A NEGACAO FALSA: rota que NAO fala de canal e caia no default por causa
  //     do recurso do vizinho. Tres dos quatro casos que a revisao nomeou:
  for (const rota of ["/api/notificacoes", "/api/disparo/listas", "/api/disparo/bloqueios"]) {
    eq(
      escopoPermite(soOficial, { metodo: "GET", pathname: rota, canal: null }).ok,
      true,
      `GET ${rota} nao fala de canal: NAO pode ser negado por recorte de canal`
    );
  }
  // /api/fluxos SAIU da lista acima no merge com a Frente P (31/08/2026): o GET
  // ganhou o SIMULADOR, que le fatos de UMA conversa (canalDe via
  // fatosDaSimulacao) — o metodo passou a falar de canal e entrou na tabela.
  // Consequencia deliberada: chave com recorte de canal precisa mandar
  // `?canal=` explicito ate pra LISTAR fluxos (o default central seria negado).
  // E o preco de rota que mistura listagem e leitura de conversa no mesmo
  // metodo; a alternativa (deixar fora da tabela) reabria leitura de fatos de
  // conversa do canal proibido via simulador sem canal.
  eq(
    escopoPermite(soOficial, { metodo: "GET", pathname: "/api/fluxos", canal: null }).ok,
    false,
    "GET /api/fluxos sem canal: NEGADO pra chave com recorte (simulador le conversa)"
  );
  eq(
    escopoPermite(soOficial, { metodo: "GET", pathname: "/api/fluxos", canal: "apioficial" }).ok,
    true,
    "GET /api/fluxos com canal explicito do recorte: PERMITIDO"
  );
  // e o catalogo de etiquetas (GET) segue liberado — so o POST endereca conversa
  eq(
    escopoPermite(soOficial, { metodo: "GET", pathname: "/api/etiquetas", canal: null }).ok,
    true,
    "catalogo de etiquetas (GET) sem canal NAO e negado"
  );
  eq(
    escopoPermite(soOficial, { metodo: "GET", pathname: "/api/perfil", canal: null }).ok,
    true,
    "a propria conta nao e negada por restricao de canal"
  );
  // O GRAVE da 3a revisao, caso a caso: a rota resolvia canal A MAO e por isso
  // uma chave restrita ao apioficial gravava ACL dura (conversa_visibilidade,
  // lotes de 2000 conversas) no central.
  eq(
    escopoPermite(soOficial, { metodo: "POST", pathname: "/api/visibilidade", canal: null }).ok,
    false,
    "POST /api/visibilidade SEM canal: a chave que nao alcanca o central e BARRADA (o default da rota e central)"
  );
  eq(
    escopoPermite(soOficial, { metodo: "POST", pathname: "/api/visibilidade", canal: "apioficial" }).ok,
    true,
    "...e com o canal dela no corpo, passa"
  );
  eq(
    escopoPermite(soOficial, { metodo: "POST", pathname: "/api/webhook", canal: null }).ok,
    false,
    "POST /api/webhook sem canal tambem cai no central (`canalPorId(query.canal || \"central\")`)"
  );
  // ROTA GLOBAL (/api/midia): a DECISAO, nao so a frase. Ela mexe nos DOIS canais
  // no mesmo request, entao NENHUM recorte de canal alcanca — inclusive o recorte
  // que casa com o default da rota, que era exatamente o furo: `central` passava e
  // a rota processava o `apioficial` junto.
  const midia = escopoPermite(soOficial, { metodo: "POST", pathname: "/api/midia", canal: null });
  eq(midia.ok, false, "POST /api/midia: chave restrita ao apioficial nao alcanca");
  const midiaCentral = escopoPermite(validarEscopoChave({ canais: ["central"] }), {
    metodo: "POST",
    pathname: "/api/midia",
    canal: null,
  });
  eq(
    midiaCentral.ok,
    false,
    "POST /api/midia: chave restrita ao CENTRAL tambem NAO alcanca — era aqui que ela passava e mexia no apioficial"
  );
  // e mesmo dizendo o canal no pedido nao adianta: a rota nao le canal do pedido
  eq(
    escopoPermite(validarEscopoChave({ canais: ["central"] }), {
      metodo: "POST",
      pathname: "/api/midia",
      canal: "central",
    }).ok,
    false,
    "nem pedir explicitamente o canal que a chave alcanca libera a rota global"
  );
  // e o MOTIVO diz a verdade: "nao alcanca o canal central" mandaria o dono
  // procurar um ?canal= que esta rota nao tem
  eq(
    midia.ok === false && /TODOS os numeros/.test(midia.motivo),
    true,
    "o motivo do /api/midia nomeia a rota como GLOBAL, nao como um canal que faltou"
  );
  eq(
    midia.ok === false && /apioficial/.test(midia.motivo),
    true,
    "...e diz o que a chave alcanca, pra quem le saber o que fazer"
  );
  // marcador de TEXTO, nunca de permissao: quem esta la tem que continuar na
  // tabela de canal-padrao, senao a rota global viraria passe livre
  const declaradosCanal = new Set(CANAL_PADRAO_EM.map(([prefixo]) => prefixo));
  dep(
    TOCA_TODOS_OS_CANAIS.filter((r) => !declaradosCanal.has(r)),
    [],
    "toda rota de TOCA_TODOS_OS_CANAIS segue em CANAL_PADRAO_EM (o marcador troca a frase, nao a decisao)"
  );
  eq(
    escopoPermite(validarEscopoChave({}), { metodo: "POST", pathname: "/api/midia", canal: null }).ok,
    true,
    "chave sem recorte de canal passa no /api/midia (o marcador nao inventa restricao)"
  );
  eq(assumeCanalPadrao("/api/etiquetas", "POST"), true, "a tabela responde por rota+metodo");
  eq(assumeCanalPadrao("/api/etiquetas", "GET"), false, "...e o mesmo prefixo responde diferente por metodo");
  eq(assumeCanalPadrao("/api/conversa/funil", "GET"), true, "prefixo mais especifico ganha do generico");
  eq(
    assumeCanalPadrao("/api/relatorios/serie", "GET"),
    true,
    "/api/relatorios/serie casa a ENTRADA dele, nao o prefixo /api/relatorio"
  );
  eq(assumeCanalPadrao("/api/relatorios/sla", "GET"), false, "irmao que nao resolve canal nao herda o default");
  // e o recorte segue valendo quando a rota TRAZ canal de verdade
  eq(
    escopoPermite(soOficial, { metodo: "POST", pathname: "/api/etiquetas", canal: "central" }).ok,
    false,
    "etiquetar conversa do canal proibido e barrado"
  );

  // DIVERGENCIA entre endereco e corpo = NEGA. O segundo caso que o revisor
  // mandou provar: nao da pra saber qual a rota vai usar, e adivinhar a favor do
  // pedinte e o caminho de contrabando.
  const div = escopoPermite(soOficial, {
    metodo: "POST",
    pathname: "/api/send",
    canal: "central",
    divergente: true,
  });
  eq(div.ok, false, "POST /api/send?canal=apioficial com corpo central = NEGA (divergencia)");
  eq(div.ok === false && /dois canais diferentes/.test(div.motivo), true, "o motivo nomeia a divergencia");
  // divergencia sem restricao de canal na chave nao inventa problema
  eq(
    escopoPermite(validarEscopoChave({}), { metodo: "POST", pathname: "/api/send", canal: "central", divergente: true }).ok,
    true,
    "chave sem recorte de canal nao se importa com divergencia"
  );
  // no TUNEL nao se assume default (o corpo la e JSON-RPC, nao {canal})
  eq(
    escopoPermite(soOficial, { metodo: "POST", pathname: "/api/mcp/mcp", canal: null }).ok,
    true,
    "o tunel do MCP sem canal nao assume central — quem carrega o canal e a chamada REST seguinte"
  );
  eq(CANAL_PADRAO_EM.length > 0, true, "a tabela de rota+metodo com canal padrao existe");
}

// B.6 prazo
{
  const agora = new Date("2026-08-31T12:00:00Z");
  eq(chaveExpirada(null, agora), false, "chave sem prazo nunca vence");
  eq(chaveExpirada("", agora), false, "prazo vazio = sem prazo");
  eq(chaveExpirada("2026-09-30T00:00:00Z", agora), false, "prazo no futuro: vale");
  eq(chaveExpirada("2026-08-31T11:59:59Z", agora), true, "prazo passado: vencida");
  eq(chaveExpirada("2026-08-31T12:00:00Z", agora), true, "prazo exatamente agora: vencida (limite fechado)");
  eq(
    chaveExpirada("data-que-ninguem-le", agora),
    true,
    "FAIL-CLOSED: prazo ilegivel conta como VENCIDO, nunca como 'sem prazo'"
  );
  eq(chaveExpirada(new Date("2030-01-01"), agora), false, "aceita Date tambem");
}

// B.6b ORACULO FECHADO — frase E status, exercitando o caminho de verdade.
//
// A versao anterior era TAUTOLOGIA (achado da 3a revisao): afirmava que as tres
// recusas tem a mesma frase porque as tres usavam a mesma constante, e nao
// tocava em quem decide o status. Agora a prova chama o MESMO predicado que a
// porta chama (`recusaDaChave`) com os tres casos, e passa o resultado pelo
// MESMO montador de resposta (`respostaDaRecusa`) — os dois em `lib/recusa.ts`,
// que e puro justamente pra isso.
{
  const agora = new Date("2026-08-31T12:00:00Z");
  const casos: [string, LinhaDeChave][] = [
    ["inexistente", null],
    ["revogada", { revogada: true, expiraEm: null }],
    ["expirada", { revogada: false, expiraEm: "2026-08-30T00:00:00Z" }],
  ];
  const respostas = new Set<string>();
  for (const [nome, linha] of casos) {
    const marca = recusaDaChave(linha, agora);
    eq(typeof marca, "string", `chave ${nome}: recusada`);
    // o GUARD e o que a porta chama — os dois tem que concordar sempre, senao a
    // prova estaria testando um caminho que a producao nao usa
    eq(chaveServe(linha, agora), false, `chave ${nome}: o guard da porta tambem recusa`);
    eq(marca, RECUSA_CHAVE, `chave ${nome}: a MESMA constante de recusa`);
    eq(ehSemIdentidade(marca), true, `chave ${nome}: marcada como SEM identidade`);
    const r = respostaDaRecusa(marca);
    eq(r.status, 401, `chave ${nome}: responde 401 (nao ha identidade), nunca 403`);
    eq(r.error, MOTIVO_CHAVE_SEM_ACESSO, `chave ${nome}: a frase unica, sem detalhe`);
    eq(r.sem_acesso, true, `chave ${nome}: o corpo marca sem_acesso`);
    eq(r.error.includes(SEM_IDENTIDADE), false, `chave ${nome}: o marcador interno NAO vaza no corpo`);
    respostas.add(`${r.status}|${r.error}`);
  }
  eq(respostas.size, 1, "os TRES casos sao INDISTINGUIVEIS: mesmo status e mesma frase");

  // e a chave que serve nao e recusada por este caminho
  const viva = { revogada: false, expiraEm: "2026-09-30T00:00:00Z" };
  eq(recusaDaChave(viva, agora), null, "chave viva e no prazo passa pelo predicado de recusa");
  eq(chaveServe(viva, agora), true, "...e o guard da porta concorda");

  // sem motivo registrado: 401 seco, sem sem_acesso (a porta recusou e ninguem explicou)
  const seco = respostaDaRecusa(null);
  eq(seco.status, 401, "recusa sem motivo: 401");
  eq(seco.error, "unauthorized", "recusa sem motivo: frase seca");
  eq(seco.sem_acesso, undefined, "recusa sem motivo nao promete explicacao");

  // chave VALIDA barrada por ESCOPO: 403 e motivo especifico — o unico caso onde
  // detalhar nao entrega nada (o portador ja provou ter a chave)
  const ro = escopoPermite(validarEscopoChave({ somente_leitura: true }), {
    metodo: "POST",
    pathname: "/api/send",
  });
  eq(ro.ok, false, "chave somente-leitura e barrada num POST");
  if (ro.ok === false) {
    const r = respostaDaRecusa(ro.motivo);
    eq(r.status, 403, "escopo barrou credencial VALIDA: 403, nao 401");
    eq(r.error, ro.motivo, "o motivo de escopo chega inteiro ao cliente");
    eq(r.error === MOTIVO_CHAVE_SEM_ACESSO, false, "e nao se confunde com a frase unica da chave");
    eq(ehSemIdentidade(ro.motivo), false, "motivo de escopo nao e 'sem identidade'");
  }

  // o descascador do marcador (o que `motivoDaRecusa` devolve pras rotas)
  eq(motivoLimpo(recusaDaChave(null, agora)), MOTIVO_CHAVE_SEM_ACESSO, "motivoLimpo tira o marcador");
  eq(motivoLimpo("horario de acesso encerrado"), "horario de acesso encerrado", "frase sem marcador passa igual");
  eq(motivoLimpo(null), null, "sem motivo, nada a limpar");

  // chave aberta segue passando (nao-regressao)
  for (const caso of [
    { metodo: "GET", pathname: "/api/chats" },
    { metodo: "POST", pathname: "/api/send" },
  ]) {
    const v = escopoPermite(validarEscopoChave({}), caso);
    eq(v.ok, true, `chave valida e aberta passa em ${caso.metodo} ${caso.pathname}`);
  }
}

// B.7 teto do autoatendimento — a unica dimensao que afrouxa e cortada
{
  const pedido = validarEscopoChave({
    somente_leitura: true,
    recursos: ["conversas"],
    canais: ["central"],
    ignorar_janela: true,
  });
  eq(pedido.ignorar_janela, true, "o saneamento LE o campo (quem grava e o super admin)");
  const seguro = escopoSemPrivilegio(pedido);
  eq(seguro.ignorar_janela, false, "TETO: autoatendimento nunca fura a propria janela de acesso");
  eq(seguro.somente_leitura, true, "...e o que APERTA continua valendo");
  dep(seguro.recursos, ["conversas"], "...recursos preservados");
  dep(seguro.canais, ["central"], "...canais preservados");
}

// B.8 rotulo e resumo
{
  eq(rotuloValido("  mcp do notebook  "), "mcp do notebook", "rotulo e aparado");
  eq(rotuloValido(""), null, "rotulo vazio vira null");
  eq(rotuloValido(123), null, "rotulo que nao e texto vira null");
  eq(rotuloValido("a".repeat(200))!.length, 60, "rotulo e cortado no limite");
  assert.match(resumoEscopo(validarEscopoChave({})), /leitura e escrita/);
  assert.match(resumoEscopo(validarEscopoChave({ somente_leitura: true })), /somente leitura/);
  assercoes += 2;
}

// B.9 VARREDURA: toda rota de app/api tem verbete no mapa de recursos.
// Sem isto, rota nova nasce invisivel pro escopo — e o fail-closed viraria
// "chave restrita nao consegue usar a feature nova", que ninguem entende.
{
  const raiz = "app/api";
  const rotas: string[] = [];
  const varrer = (dir: string, prefixo: string) => {
    for (const nome of readdirSync(dir)) {
      const cheio = join(dir, nome);
      if (statSync(cheio).isDirectory()) varrer(cheio, `${prefixo}/${nome}`);
      // TODA route.ts precisa de verbete, sem excecao (endurecido apos revisao).
      //
      // A primeira versao so cobrava de quem chama `getUser`, porque so essas
      // sao alcancaveis por chave. Mas o filtro era fragil de um jeito ruim: uma
      // rota que autentique por `requireUser`, `usuarioPorSessao` ou por um
      // portao proprio saia da varredura CALADA, e a lista de nomes a procurar
      // ia crescer sem ninguem lembrar. Exigir verbete de todas custa uma linha
      // no mapa e nao tem como envelhecer.
      else if (nome === "route.ts") rotas.push(prefixo);
    }
  };
  try {
    varrer(raiz, "/api");
  } catch {
    // rodou de outro diretorio: a varredura e melhor-esforco, o resto da prova nao depende dela
  }
  const semVerbete = rotas.filter((r) => {
    // segmento dinamico ([transport]) nao muda o prefixo que o mapa casa
    const limpo = r.replace(/\/\[[^\]]+\]/g, "");
    return recursoDaRota(limpo) === null;
  });
  eq(rotas.length > 20, true, `a varredura achou as rotas (${rotas.length})`);
  dep(semVerbete, [], `toda rota tem recurso no mapa de lib/escopo-chave.ts — sem verbete: ${semVerbete.join(", ")}`);
}

// B.10 VARREDURA DERIVADA: quem resolve canal esta na tabela, com os METODOS certos?
//
// A asseracao sem a qual a proxima rota escapa igual. A regra e mecanica, e a 3a
// revisao a endureceu em dois eixos:
//
//   QUEM RESOLVE. Nao basta procurar `canalDe`/`canalDeBody`: `/api/visibilidade`
//   comparava `body.canal === "apioficial"` A MAO e por isso saiu do radar da
//   tabela E desta varredura (chave restrita ao apioficial gravava ACL no
//   central). Entao a busca inclui a mencao literal a um id de canal — rota que
//   compara canal na mao ou passa a usar `canalDe*`, ou se declara na tabela.
//
//   POR METODO, nao por arquivo. Conferir so o prefixo deixava passar metodo
//   novo em rota ja declarada. E a conferencia e por HANDLER, nao pelo arquivo
//   inteiro: `DELETE /api/agendadas` (cancela por id, tabela unica) e
//   `GET /api/etiquetas` (catalogo global) NAO tocam canal, e exigi-los na
//   tabela criaria NEGACAO FALSA pra chave de um canal so — defeito medido na
//   revisao anterior. A igualdade e nos dois sentidos: metodo faltando e furo,
//   metodo sobrando e verbete morto que finge cobertura.
{
  const raiz = "app/api";
  // TOQUE CIRURGICO DA FRENTE U (31/08/2026), a pedido da revisao cega — o padrao
  // passa a ser DERIVADO do registro de canais, e nao uma lista escrita a mao.
  //
  // O QUE ESTAVA FRAGIL: o literal `apioficial` era o unico id procurado. Uma
  // resolucao a mao comparando com o OUTRO builtin (`body.canal ?? "central"`)
  // ficava fora do radar — e nao era hipotese: `/api/disparo` POST fazia
  // exatamente isso, sem entrada em CANAL_PADRAO_EM, deixando uma chave escopada
  // ao apioficial criar disparo em massa saindo pelo central.
  //
  // Agora os ids vem dos canais BUILTIN, entao canal builtin novo entra no padrao
  // sozinho — mas canal EXTRA da instalacao NAO entra, e isso e deliberado (achado
  // D11): `listarCanais()` le `CANAIS_EXTRA` do ambiente onde a prova roda, e uma
  // instalacao com canal de id curto e comum (`api`, `teste`, `chat`) faria a
  // varredura casar qualquer `"api"` no meio de uma rota e REPROVAR por falso
  // positivo, num arquivo que ninguem tocou. Prova que depende do ambiente nao e
  // prova — e a pior versao disso e a que falha sem culpado. O id e
  // buscado ENTRE ASPAS de proposito: `central` aparece em prosa e em nome de
  // funcao (`credsCentral`) por todo lado, e casar texto solto encheria a
  // varredura de falso positivo — o que importa e o id usado como LITERAL.
  const padraoDeResolucao = () => {
    const ids = canaisBuiltin().map((c) => c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(String.raw`\bcanalDe\b|\bcanalDeBody\b|["'](?:` + ids.join("|") + `)["']`);
  };
  const RESOLVE = padraoDeResolucao();

  // ——— E O PADRAO NAO PODE DEPENDER DO AMBIENTE (achado D11), medido com um
  // CANAIS_EXTRA hostil: um id curto e comum declarado pela instalacao passaria a
  // casar qualquer `"api"` no meio de uma rota, e a varredura reprovaria um arquivo
  // que ninguem tocou. Prova que falha por causa da env do ambiente nao e prova —
  // e a pior versao disso e a que falha sem culpado.
  {
    const salvo = process.env.CANAIS_EXTRA;
    process.env.CANAIS_EXTRA = JSON.stringify([
      { id: "api", tipo: "whatsapp", dono: "empresa", rotulo: "Api", fonte: "zapi" },
    ]);
    try {
      eq(
        listarCanais().some((c) => c.id === "api"),
        true,
        "o canal extra hostil existe no registro desta instalacao ficticia..."
      );
      eq(
        padraoDeResolucao().test('const rota = "api";'),
        false,
        "...e MESMO ASSIM o padrao da varredura nao casa `\"api\"`: ele sai dos canais BUILTIN, nao do ambiente"
      );
      eq(
        padraoDeResolucao().test('const c = "central";'),
        true,
        "e o builtin de verdade segue casando (a correcao nao afrouxou a varredura)"
      );
    } finally {
      if (salvo === undefined) delete process.env.CANAIS_EXTRA;
      else process.env.CANAIS_EXTRA = salvo;
    }
  }
  const achados: { prefixo: string; metodos: string[] }[] = [];
  // MERGE DA ONDA 4 (31/08/2026) — a SEGUNDA forma legitima de escopar canal.
  //
  // A tabela `CANAL_PADRAO_EM` serve a quem resolve canal DO PEDIDO: ali o escopo
  // da chave precisa assumir o mesmo default que o handler. Mas `PATCH` e `DELETE`
  // de `/api/agendadas` (Frente S) fazem o contrario e mais forte: leem a LINHA,
  // pegam o canal DELA (`alvo.canal || "central"`) e comparam com o escopo da chave
  // por `canalNoEscopo(escopoDaChaveNoRequest(req), ...)`. Declarar esses metodos na
  // tabela seria PIOR que nao declarar: o escopo passaria a assumir `central` pra um
  // PATCH cuja linha e do `apioficial`, e a chave restrita ao apioficial levaria 403
  // ao editar a PROPRIA agendada — a NEGACAO FALSA que esta varredura existe pra
  // evitar.
  //
  // Entao o handler que carrega as DUAS pecas da comparacao explicita fica fora da
  // cobranca da tabela — e so ele. Segue fail-closed: quem resolve canal sem entrada
  // na tabela E sem a comparacao continua reprovando, e tirar a comparacao do PATCH
  // joga o metodo de volta na cobranca (mutacao verificada no merge).
  const COMPARA_ESCOPO = /canalNoEscopo\s*\(/;
  const LE_ESCOPO_DA_CHAVE = /escopoDaChaveNoRequest\s*\(/;
  const porComparacao: string[] = [];
  const varrer = (dir: string, prefixo: string) => {
    for (const nome of readdirSync(dir)) {
      const cheio = join(dir, nome);
      if (statSync(cheio).isDirectory()) varrer(cheio, `${prefixo}/${nome}`);
      else if (nome === "route.ts") {
        const src = readFileSync(cheio, "utf8");
        if (!RESOLVE.test(src)) continue;
        // corta o arquivo nos handlers exportados e pergunta de cada um
        const marcas: { metodo: string; i: number }[] = [];
        const re = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PATCH|PUT|DELETE)\b/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) marcas.push({ metodo: m[1], i: m.index });
        const fatia = (k: number) =>
          src.slice(marcas[k].i, k + 1 < marcas.length ? marcas[k + 1].i : src.length);
        const comparaNaMao = (k: number) => {
          const s = fatia(k);
          return COMPARA_ESCOPO.test(s) && LE_ESCOPO_DA_CHAVE.test(s);
        };
        marcas.forEach((mk, k) => {
          if (comparaNaMao(k)) porComparacao.push(`${prefixo} ${mk.metodo}`);
        });
        const resolvem = marcas
          .filter((mk, k) => RESOLVE.test(fatia(k)) && !comparaNaMao(k))
          .map((mk) => mk.metodo);
        // FAIL-CLOSED: o arquivo fala de canal mas nenhum handler mostra onde
        // (helper compartilhado, por exemplo) — cobra TODOS os metodos. Preferir
        // uma linha a mais na tabela a um metodo fora do radar. Os que escopam por
        // comparacao explicita saem da cobranca (ja estao protegidos por ela).
        const todosMenosComparados = marcas.filter((_, k) => !comparaNaMao(k)).map((mk) => mk.metodo);
        const metodos = resolvem.length ? resolvem : todosMenosComparados;
        if (metodos.length) achados.push({ prefixo, metodos });
      }
    }
  };
  try {
    varrer(raiz, "/api");
  } catch {
    // rodou de outro diretorio: o resto da prova nao depende desta varredura
  }
  const limpo = (p: string) => p.replace(/\/\[[^\]]+\]/g, "");
  const tabela = new Map(CANAL_PADRAO_EM.map(([prefixo, metodos]) => [prefixo, [...metodos].sort()]));
  eq(achados.length > 10, true, `a varredura achou quem resolve canal (${achados.length} rotas)`);

  const semEntrada = achados.map((a) => limpo(a.prefixo)).filter((p) => !tabela.has(p));
  dep(
    semEntrada,
    [],
    `rota que resolve canal precisa de entrada EXATA em CANAL_PADRAO_EM — sem entrada: ${semEntrada.join(", ")}`
  );

  const metodoErrado: string[] = [];
  for (const a of achados) {
    const declarados = tabela.get(limpo(a.prefixo));
    if (!declarados) continue; // ja contado em semEntrada
    const medidos = [...new Set(a.metodos)].sort();
    if (declarados.join(",") !== medidos.join(",")) {
      metodoErrado.push(`${limpo(a.prefixo)} (tabela: ${declarados.join("|")} / medido: ${medidos.join("|")})`);
    }
  }
  dep(
    metodoErrado,
    [],
    `os metodos da tabela tem que ser IGUAIS aos handlers que resolvem canal — divergencia: ${metodoErrado.join("; ")}`
  );

  // A ISENCAO NAO E DE GRACA: quem sai da cobranca da tabela tem que estar de fato
  // comparando o canal da LINHA com o escopo da chave. Sem estas duas asseracoes a
  // isencao viraria uma porta de saida — bastaria escrever `canalNoEscopo(` num
  // comentario pra um handler novo escapar do radar da tabela.
  //
  // A MUTACAO QUE ESTAS LINHAS MATAM: tirar a comparacao do PATCH de
  // `/api/agendadas`. Sem ela o metodo volta pra cobranca da tabela (que so declara
  // GET|POST, de proposito) e a asseracao acima reprova nomeando a rota.
  for (const alvo of ["/api/agendadas PATCH", "/api/agendadas DELETE"]) {
    eq(
      porComparacao.includes(alvo),
      true,
      `${alvo} escopa canal comparando a linha com o escopo da chave (canalNoEscopo + escopoDaChaveNoRequest); sem isso ele tem que voltar pra CANAL_PADRAO_EM`
    );
  }
  eq(
    porComparacao.length >= 2,
    true,
    `a varredura achou os handlers que escopam por comparacao explicita (${porComparacao.length})`
  );

  // e o contrario: entrada que aponta pra rota que nao resolve canal e verbete morto
  //
  // EXCECAO NOMEADA (Frente U): entrada com lista de metodos VAZIA e um ESCUDO, nao
  // verbete morto. A tabela casa por PREFIXO e para no primeiro que bate, entao
  // declarar `["/api/disparo", ["POST"]]` faria as sub-rotas `/api/disparo/listas`,
  // `/bloqueios` e `/publico` assumirem canal padrao tambem — e nenhuma das tres
  // fala de canal, o que criaria NEGACAO FALSA pra chave de um canal so (defeito ja
  // medido numa revisao anterior). O escudo diz, explicitamente, "esta rota NAO
  // assume canal padrao". Ele segue tendo que apontar pra uma rota que EXISTE: o
  // que a excecao dispensa e o casamento com RESOLVE, nunca a existencia.
  const vistos = new Set(achados.map((a) => limpo(a.prefixo)));
  const escudos = new Set(CANAL_PADRAO_EM.filter(([, m]) => m.length === 0).map(([p]) => p));
  const orfas = [...tabela.keys()].filter((d) => !vistos.has(d) && !escudos.has(d));
  dep(orfas, [], `entrada de CANAL_PADRAO_EM sem rota correspondente: ${orfas.join(", ")}`);

  // escudo que aponta pra rota inexistente E verbete morto — a excecao acima nao
  // pode virar porta pra entrada que envelheceu
  const escudoSemRota = [...escudos].filter((e) => {
    try {
      return !statSync(join("app", e.replace(/^\/api\//, "api/"), "route.ts")).isFile();
    } catch {
      return true;
    }
  });
  dep(escudoSemRota, [], `entrada-escudo de CANAL_PADRAO_EM sem rota no disco: ${escudoSemRota.join(", ")}`);

  // ————————————————————————————— O OUTRO SENTIDO: negacao falsa por PREFIXO
  //
  // A varredura acima cobra entrada de quem RESOLVE canal. Faltava o espelho: rota
  // que NAO resolve canal nao pode assumir canal padrao — e ela pode acabar
  // assumindo sem ninguem declarar nada, porque a tabela casa por PREFIXO. Foi
  // exatamente o que apareceu quando `/api/disparo` POST entrou na tabela (Frente
  // U): `POST /api/disparo/listas`, `/bloqueios` e `/publico` passaram a assumir
  // `central` de carona, e uma chave escopada a um canal so seria negada em tres
  // rotas que nem falam de canal. Isso e negacao falsa — o mesmo defeito que uma
  // revisao anterior mediu, e que a nota de `CANAL_PADRAO_EM` promete evitar.
  //
  // Sem esta asseracao, apagar um dos escudos passava batido (medido: passou). A
  // regra e mecanica: pra cada handler exportado de uma rota que nao casa com
  // RESOLVE, `assumeCanalPadrao` tem que ser false.
  {
    const naoResolvem: { prefixo: string; metodos: string[] }[] = [];
    const varrer2 = (dir: string, prefixo: string) => {
      for (const nome of readdirSync(dir)) {
        const cheio = join(dir, nome);
        if (statSync(cheio).isDirectory()) varrer2(cheio, `${prefixo}/${nome}`);
        else if (nome === "route.ts") {
          const src = readFileSync(cheio, "utf8");
          if (RESOLVE.test(src)) continue;
          const metodos = [
            ...src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PATCH|PUT|DELETE)\b/g),
          ].map((m) => m[1]);
          if (metodos.length) naoResolvem.push({ prefixo, metodos });
        }
      }
    };
    try {
      varrer2(raiz, "/api");
    } catch {
      // rodou de outro diretorio
    }
    eq(naoResolvem.length > 5, true, `a varredura achou rotas que NAO resolvem canal (${naoResolvem.length})`);
    const negacaoFalsa: string[] = [];
    for (const r of naoResolvem) {
      for (const m of r.metodos) {
        if (assumeCanalPadrao(limpo(r.prefixo), m)) negacaoFalsa.push(`${limpo(r.prefixo)} ${m}`);
      }
    }
    dep(
      negacaoFalsa,
      [],
      `rota que nao resolve canal nao pode assumir canal padrao (negacao falsa pra chave de um canal so): ${negacaoFalsa.join(", ")}`
    );
  }
  eq(
    [...escudos].every((e) => !assumeCanalPadrao(e, "POST") && !assumeCanalPadrao(e, "GET")),
    true,
    "entrada-escudo nao faz a rota assumir canal padrao em nenhum metodo"
  );
}

// B.11 VARREDURA: quem escreve na tabela de CONVERSAS do canal guarda `somenteLeitura`.
//
// A linha divisoria e a que lib/canais.ts escreve: visibilidade e responsavel
// moram em tabela do painel chaveada por (canal, chat_id) e valem pra qualquer
// canal; o que mora na tabela de conversas do canal (arquivar, auto_arquivar) nao
// existe em canal de fonte externa. /api/visibilidade fazia as duas coisas e
// guardava nenhuma — passava batido porque resolvia canal a mao entre dois ids
// fixos. Depois de passar a aceitar QUALQUER canal registrado, o ramo de
// `auto_arquivar` precisa do guard, senao o UPDATE bate em tabela inexistente e
// vira 500 no lugar de um 403 explicavel.
{
  let src = "";
  try {
    src = readFileSync("app/api/visibilidade/route.ts", "utf8");
  } catch {
    // rodou de outro diretorio: o resto da prova nao depende disto
  }
  if (src) {
    eq(
      /\bsomenteLeitura\b/.test(src),
      true,
      "/api/visibilidade importa e usa somenteLeitura (o ramo de auto_arquivar escreve na tabela do canal)"
    );
    eq(
      /if \(autoArquivar !== undefined\) \{[\s\S]{0,400}?prepararEstadoExterno\(canal/.test(src),
      true,
      "e o guard fica NO RAMO de auto_arquivar (403 sem estado, linha garantida no canal do agente) — visibilidade pura segue valendo pra canal de fonte externa"
    );
    eq(/\bcanalDeBody\b/.test(src), true, "e o canal continua saindo de canalDeBody, nao de comparacao a mao");
  }
}

// B.12 PATCH DE ESCOPO: dimensao omitida FICA COMO ESTA.
//
// `validarEscopoChave` trata campo ausente como o default dele — certo pra ler
// jsonb, errado pra PATCH. Sem mesclar, `{escopo:{canais:[...]}}` de curl/script/
// MCP reescrevia o escopo inteiro nos DOIS sentidos, e o sentido que AFROUXA e o
// caro: quem pediu "so mexe no canal" recebia escrita e alcance total de volta.
// A correcao anterior morava na TELA e nao alcancava nada disso.
{
  const robo = validarEscopoChave({ canais: ["apioficial"], ignorar_janela: true });
  const apertada = validarEscopoChave({ somente_leitura: true, recursos: ["conversas"], canais: ["central"] });

  // ——— o sentido que APERTA calado (o privilegio do robo noturno)
  eq(
    mesclarEscopo(robo, { canais: ["central"] }).ignorar_janela,
    true,
    "PATCH de canal NAO apaga ignorar_janela (o robo noturno segue trabalhando)"
  );
  dep(mesclarEscopo(robo, { canais: ["central"] }).canais, ["central"], "...e o canal pedido vale");

  // ——— o sentido que AFROUXA calado, que e pior
  eq(
    mesclarEscopo(apertada, { canais: ["apioficial"] }).somente_leitura,
    true,
    "PATCH de canal NAO devolve escrita a uma chave somente-leitura"
  );
  dep(
    mesclarEscopo(apertada, { canais: ["apioficial"] }).recursos,
    ["conversas"],
    "...e NAO devolve alcance total apagando a lista de recursos"
  );

  // ——— limpar e ORDEM EXPLICITA, nunca omissao
  dep(mesclarEscopo(apertada, { recursos: [] }).recursos, [], "mandar recursos:[] LIMPA a dimensao");
  eq(
    mesclarEscopo(apertada, { somente_leitura: false }).somente_leitura,
    false,
    "mandar somente_leitura:false devolve a escrita, porque foi PEDIDO"
  );
  eq(
    mesclarEscopo(robo, { ignorar_janela: false }).ignorar_janela,
    false,
    "e mandar ignorar_janela:false tira o privilegio, porque foi PEDIDO"
  );

  // ——— corpo vazio ou lixo nao muda nada
  dep(mesclarEscopo(apertada, {}), apertada, "escopo vazio no PATCH deixa tudo como esta");
  dep(mesclarEscopo(apertada, null), apertada, "escopo null nao apaga nada");
  dep(mesclarEscopo(apertada, "texto"), apertada, "escopo que nem e objeto nao apaga nada");
  dep(mesclarEscopo(apertada, []), apertada, "array no lugar do objeto nao apaga nada");
  // chave desconhecida segue ignorada (mesmo espirito de validarEscopoChave)
  dep(mesclarEscopo(apertada, { inventado: true }), apertada, "campo inventado no PATCH e ignorado");

  // ——— e a ROTA usa isso: a rota de edicao le o gravado antes de mesclar
  {
    let src = "";
    try {
      src = readFileSync("app/api/admin/api-keys/route.ts", "utf8");
    } catch {
      // rodou de outro diretorio
    }
    if (src) {
      // a MENCAO nao serve: `mesclarEscopo` continua na linha de import mesmo se a
      // chamada sumir — e foi exatamente assim que esta asseracao passou por uma
      // sabotagem no teste negativo. Cobrar a ATRIBUICAO amarra o comportamento.
      eq(
        /const escopo = mesclarEscopo\(/.test(src),
        true,
        "/api/admin/api-keys monta o escopo do PATCH com mesclarEscopo (as duas pontas)"
      );
      eq(
        /from\("api_keys"\)\s*\.select\("escopo"\)/.test(src),
        true,
        "...e le o escopo GRAVADO antes de mesclar (senao nao ha o que preservar)"
      );
    }
  }
}

// ============================================ C) VISIBILIDADE COM E SEM RESTRICAO
const EU = { id: "u-eu", email: "eu@x", nome: "Eu" };
const ctx = (meusDeps: string[] = [], colegas: string[] = []): ContextoVisao => ({
  meusDeps: new Set(meusDeps),
  colegas: new Set(colegas),
});
const perf = (
  escopo: PerfilVisao["escopo_visao"],
  papel: PerfilVisao["papel"] = "normal"
): PerfilVisao => ({ papel, escopo_visao: escopo });
const resp = (...rs: Array<[Responsavel["tipo"], string]>): Responsavel[] =>
  rs.map(([tipo, ref_id]) => ({ tipo, ref_id }));
const alvo = (canal: string, ...funilIds: string[]): AlvoConversa => ({ canal, funilIds });

// C.1 a regra pura, isolada
{
  const semNada: RestricaoUsuario = { canais: [], funis: [], sem_funil: false };
  eq(restricaoVazia(null), true, "sem linha = nao restringe");
  eq(restricaoVazia(semNada), true, "listas vazias = nao restringe (mesmo com sem_funil false)");
  eq(restricaoPermite(null, null), true, "sem restricao, alvo nem importa");
  eq(restricaoPermite(semNada, alvo("central")), true, "restricao vazia permite tudo");

  const soCentral: RestricaoUsuario = { canais: ["central"], funis: [], sem_funil: false };
  eq(restricaoVazia(soCentral), false, "restricao de canal restringe");
  eq(restricaoPermite(soCentral, alvo("central")), true, "canal permitido");
  eq(restricaoPermite(soCentral, alvo("apioficial")), false, "canal proibido");
  eq(
    restricaoPermite(soCentral, null),
    false,
    "FAIL-CLOSED: restricao presente e alvo que nao deu pra avaliar = NEGA"
  );

  const soVendas: RestricaoUsuario = { canais: [], funis: ["f-vendas"], sem_funil: false };
  eq(restricaoPermite(soVendas, alvo("central", "f-vendas")), true, "conversa no funil permitido");
  eq(restricaoPermite(soVendas, alvo("central", "f-suporte")), false, "conversa em outro funil");
  eq(
    restricaoPermite(soVendas, alvo("central", "f-suporte", "f-vendas")),
    true,
    "conversa em VARIOS funis: basta UM permitido"
  );
  eq(
    restricaoPermite(soVendas, alvo("central")),
    false,
    "conversa SEM funil e negada por padrao (fail-closed)"
  );
  const soVendasMaisSoltas: RestricaoUsuario = { canais: [], funis: ["f-vendas"], sem_funil: true };
  eq(
    restricaoPermite(soVendasMaisSoltas, alvo("central")),
    true,
    "...e liberada quando o admin marcou `sem_funil` de proposito"
  );
  eq(
    restricaoPermite(soVendasMaisSoltas, alvo("central", "f-suporte")),
    false,
    "...mas `sem_funil` nao libera conversa que ESTA em outro funil"
  );

  // as duas dimensoes sao E, nunca OU
  const ambas: RestricaoUsuario = { canais: ["central"], funis: ["f-vendas"], sem_funil: false };
  eq(restricaoPermite(ambas, alvo("central", "f-vendas")), true, "canal E funil certos");
  eq(restricaoPermite(ambas, alvo("apioficial", "f-vendas")), false, "funil certo, canal errado: nega");
  eq(restricaoPermite(ambas, alvo("central", "f-suporte")), false, "canal certo, funil errado: nega");
  // o sentinela de fail-closed que lib/acesso.ts usa quando nao da pra ler
  const fechada: RestricaoUsuario = { canais: ["__sem_acesso__"], funis: [], sem_funil: false };
  eq(restricaoPermite(fechada, alvo("central")), false, "o sentinela de leitura falha nega todo canal real");
  eq(restricaoPermite(fechada, alvo("apioficial")), false, "...em qualquer canal");
  // o mesmo sentinela e o que `/api/funis` testa pra devolver CATALOGO VAZIO no
  // fail-closed (2a revisao): nome de funil e metadado da operacao, e o quadro
  // montado e vazio dava mais informacao do que uma tela em branco com aviso.
  eq(
    fechada.canais.includes("__sem_acesso__"),
    true,
    "o estado fail-closed e reconhecivel pela rota (e o que corta o catalogo tambem)"
  );
}

// C.2 NAO-REGRESSAO: o 8o parametro ausente tem que se comportar EXATAMENTE
// como antes desta feature. Esta e a invariante que permitiu mexer no predicado
// mais critico do painel sem tocar em quem ainda nao passa por ele.
{
  const casos: Array<[string, boolean, () => boolean]> = [
    [
      "super admin ve tudo",
      true,
      () => conversaVisivel(resp(["usuario", "outro"]), EU, perf("proprias", "super_admin"), ctx()),
    ],
    ["conversa sem responsavel e de todo mundo", true, () => conversaVisivel([], EU, perf("proprias"), ctx())],
    [
      "escopo proprias nao ve conversa de outro",
      false,
      () => conversaVisivel(resp(["usuario", "outro"]), EU, perf("proprias"), ctx(), "aberto"),
    ],
    [
      "escopo proprias ve a propria",
      true,
      () => conversaVisivel(resp(["usuario", EU.id]), EU, perf("proprias"), ctx(), "aberto"),
    ],
    [
      "escopo departamento ve a do seu dep",
      true,
      () => conversaVisivel(resp(["departamento", "d1"]), EU, perf("departamento"), ctx(["d1"]), "aberto"),
    ],
    [
      "concluida e pool de todo mundo",
      true,
      () => conversaVisivel(resp(["usuario", "outro"]), EU, perf("proprias"), ctx(), "concluido"),
    ],
    [
      "ACL fixa restringe ate escopo todas",
      false,
      () =>
        conversaVisivel(
          [],
          EU,
          perf("todas"),
          ctx(),
          "aberto",
          [{ tipo: "usuario", ref_id: "terceiro" }] as VisibilidadeEntry[],
          []
        ),
    ],
  ];
  for (const [nome, esperado, f] of casos) {
    eq(f(), esperado, `nao-regressao (sem restricao): ${nome}`);
  }
  // e o mesmo caso com o parametro explicitamente vazio / nulo
  eq(
    conversaVisivel(resp(["usuario", EU.id]), EU, perf("proprias"), ctx(), "aberto", null, null, null),
    true,
    "8o parametro null = igual a ausente"
  );
  eq(
    conversaVisivel(
      resp(["usuario", EU.id]),
      EU,
      perf("proprias"),
      ctx(),
      "aberto",
      null,
      null,
      { restricao: null, alvo: null }
    ),
    true,
    "restricao null dentro do par = igual a ausente"
  );
}

// C.3 a restricao dentro do predicado, e a ORDEM das camadas
{
  const soCentral: RestricaoUsuario = { canais: ["central"], funis: [], sem_funil: false };
  const par = (canal: string, ...f: string[]) => ({ restricao: soCentral, alvo: alvo(canal, ...f) });

  // super admin passa ANTES da restricao — e a camada 1, e ela nao muda
  eq(
    conversaVisivel([], EU, perf("todas", "super_admin"), ctx(), "aberto", null, null, par("apioficial")),
    true,
    "super admin nao e restringido (camada 1 vem primeiro)"
  );
  // escopo `todas` NAO fura a restricao
  eq(
    conversaVisivel([], EU, perf("todas"), ctx(), "aberto", null, null, par("apioficial")),
    false,
    "escopo `todas` nao fura a restricao de canal"
  );
  eq(
    conversaVisivel([], EU, perf("todas"), ctx(), "aberto", null, null, par("central")),
    true,
    "...e o canal permitido segue visivel"
  );
  // conversa CONCLUIDA (pool de todo mundo) tambem nao fura
  eq(
    conversaVisivel([], EU, perf("proprias"), ctx(), "concluido", null, null, par("apioficial")),
    false,
    "conversa concluida nao fura a restricao (a regra do pool vem DEPOIS)"
  );
  // SER RESPONSAVEL nao fura: a restricao nao tem a valvula que a ACL tem.
  // Isso e deliberado — restringir alguem a um numero e dizer que ele nao le os
  // outros, inclusive um em que alguem o marcou por engano.
  eq(
    conversaVisivel(resp(["usuario", EU.id]), EU, perf("proprias"), ctx(), "aberto", null, null, par("apioficial")),
    false,
    "ser RESPONSAVEL nao fura a restricao de canal"
  );
  // ...e o contraste com a ACL, que TEM a valvula do dono (comportamento antigo,
  // que continua valendo)
  eq(
    conversaVisivel(
      resp(["usuario", EU.id]),
      EU,
      perf("proprias"),
      ctx(),
      "aberto",
      [{ tipo: "usuario", ref_id: "terceiro" }] as VisibilidadeEntry[],
      []
    ),
    true,
    "na ACL o responsavel SEGUE vendo — as duas travas sao diferentes de proposito"
  );
  // alvo indeterminado nega dentro do predicado tambem
  eq(
    conversaVisivel([], EU, perf("todas"), ctx(), "aberto", null, null, { restricao: soCentral, alvo: null }),
    false,
    "alvo indeterminado nega dentro do predicado"
  );
  // funil: o caminho completo
  const soVendas: RestricaoUsuario = { canais: [], funis: ["f-vendas"], sem_funil: false };
  eq(
    conversaVisivel([], EU, perf("todas"), ctx(), "aberto", null, null, {
      restricao: soVendas,
      alvo: alvo("central", "f-vendas"),
    }),
    true,
    "conversa no funil permitido aparece"
  );
  eq(
    conversaVisivel([], EU, perf("todas"), ctx(), "aberto", null, null, {
      restricao: soVendas,
      alvo: alvo("central"),
    }),
    false,
    "conversa sem funil nao aparece pra quem esta restrito por funil"
  );
}

// ============================================================ D) DISPOSITIVO

// D.1 impressao ESTAVEL entre versoes de navegador
{
  const chrome138 =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
  const chrome141 =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.55 Safari/537.36";
  eq(
    assinaturaDispositivo(chrome138),
    assinaturaDispositivo(chrome141),
    "atualizar o Chrome NAO cria dispositivo novo (senao a lista enche de linha morta)"
  );
  const firefox =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0";
  assert.notEqual(
    assinaturaDispositivo(chrome138),
    assinaturaDispositivo(firefox),
    "navegador diferente e dispositivo diferente"
  );
  assercoes++;
  const chromeMac =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  assert.notEqual(
    assinaturaDispositivo(chrome141),
    assinaturaDispositivo(chromeMac),
    "mesmo navegador em outro sistema e dispositivo diferente"
  );
  assercoes++;
}

// D.2 leitura do user-agent
{
  eq(lerUserAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36").rotulo, "Chrome no Windows", "Chrome/Windows");
  eq(
    lerUserAgent("Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/141 Safari/537 Edg/141.0").navegador,
    "Edge",
    "Edge nao e confundido com Chrome (a ordem do mapa importa)"
  );
  eq(
    lerUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Safari/604.1").rotulo,
    "Safari no iPhone",
    "iPhone antes de mac os x (o UA do iPhone diz os dois)"
  );
  eq(lerUserAgent("curl/8.4.0").robo, true, "curl e robo");
  eq(lerUserAgent("node-fetch/3.3.2").robo, true, "node-fetch e robo");
  eq(lerUserAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/141.0").robo, false, "navegador nao e robo");
  eq(lerUserAgent("").rotulo, "cliente sem identificacao", "sem user-agent nao quebra");
  eq(lerUserAgent(null).robo, false, "user-agent nulo nao quebra");
  eq(lerUserAgent(undefined).navegador, "desconhecido", "user-agent ausente nao quebra");
}

// D.3 IP real x IP de proxy — a coluna que nasceu inutil na ferramenta antiga
{
  eq(
    ipDoCliente({ forwardedFor: "203.0.113.7, 10.244.1.9, 172.16.0.1" }),
    "203.0.113.7",
    "o IP do CLIENTE e o PRIMEIRO de x-forwarded-for, nao o do proxy"
  );
  eq(ipDoCliente({ forwardedFor: "", realIp: "198.51.100.4" }), "198.51.100.4", "x-real-ip e a reserva");
  eq(ipDoCliente({}), null, "sem cabecalho nenhum, null");
  eq(ipDoCliente({ forwardedFor: "  203.0.113.7  " }), "203.0.113.7", "espaco em volta e aparado");
  eq(ipPrivado("10.244.1.9"), true, "10.x e rede interna (era o que a ferramenta antiga gravava)");
  eq(ipPrivado("172.16.5.4"), true, "172.16-31 e rede interna");
  eq(ipPrivado("172.32.5.4"), false, "172.32 NAO e rede interna (a borda da faixa)");
  eq(ipPrivado("192.168.0.1"), true, "192.168 e rede interna");
  eq(ipPrivado("203.0.113.7"), false, "IP publico nao e interno");
  eq(ipPrivado("::1"), true, "loopback IPv6 e interno");
  eq(ipPrivado(null), false, "null nao e interno (nem quebra)");
}

// ============================================================== fechamento
// RECURSOS e a documentacao do escopo: verbete sem descricao e recurso que
// ninguem sabe o que faz (mesma regra de DESCRICAO_PERMISSAO em lib/permissoes.ts)
{
  eq(RECURSOS.length > 5, true, "a lista de recursos existe");
  eq(new Set(RECURSOS).size, RECURSOS.length, "sem recurso duplicado na lista canonica");
  for (const r of RECURSOS) {
    eq(typeof DESCRICAO_RECURSO[r] === "string" && DESCRICAO_RECURSO[r].length > 10, true, `recurso ${r} tem descricao`);
  }

  // EXPORTAR LINHA NAO ENTRA NO VERBETE DE `relatorios` (achado da revisao cega,
  // 31/08/2026). Uma chave existente com {somente_leitura, recursos:["relatorios"]}
  // foi consentida pra ler NUMERO agregado. Se /api/exportar caisse naquele verbete,
  // a MESMA chave passaria a baixar 50 mil mensagens com conteudo e telefone por um
  // GET — permissao nova entrando de carona em consentimento antigo.
  eq(recursoDaRota("/api/exportar"), "exportacao", "a exportacao tem recurso proprio");
  eq(recursoDaRota("/api/relatorios/serie"), "relatorios", "e o relatorio agregado segue em `relatorios`");
  eq(RECURSOS.includes("exportacao" as any), true, "o verbete existe na lista canonica");
  // fail-closed pra chave antiga: quem tem `relatorios` NAO tem `exportacao`
  const soRelatorio = validarEscopoChave({ somente_leitura: true, recursos: ["relatorios"] });
  const soExportacao = validarEscopoChave({ somente_leitura: true, recursos: ["exportacao"] });
  eq(
    escopoPermite(soRelatorio, { metodo: "GET", pathname: "/api/exportar" }).ok,
    false,
    "chave de relatorio NAO exporta linha sem o dono marcar o recurso novo"
  );
  eq(
    escopoPermite(soExportacao, { metodo: "GET", pathname: "/api/exportar" }).ok,
    true,
    "com o recurso marcado, exporta"
  );
  eq(
    escopoPermite(soExportacao, { metodo: "GET", pathname: "/api/relatorios/serie" }).ok,
    false,
    "e o recurso novo nao vira passe pro resto dos relatorios"
  );
}

// ═══════ B.12 O CANAL INATIVO E O ESCOPO DA CHAVE (Frente U, achado de revisao)
//
// O furo tinha OS DOIS SENTIDOS ao mesmo tempo, e nenhuma prova o alcancava
// porque a regra era funcao PRIVADA de lib/auth-server.ts. Ela mudou de casa
// (`canalParaEscopo` em lib/canais.ts) exatamente pra caber aqui.
//
// Contexto: a porta de `/api/canais/*` aceita canal registrado e INATIVO de
// proposito — e justamente o numero que alguem acabou de declarar em CANAIS_EXTRA
// e vem conectar agora. Mas a porta da CHAVE reescrevia esse id como `central`
// (espelho de `resolver()`, que existe pra rota de conversa). Resultado:
//
//   AFROUXA: chave escopada a ["central"] operava o canal extra inativo.
//   APERTA:  chave escopada a ["testador"] nunca alcancava nada.
{
  const salvo = process.env.CANAIS_EXTRA;
  // canal registrado e DESLIGADO (`ativo` default false — o estado de todo canal
  // que acabou de ser declarado e ainda nao foi conectado)
  process.env.CANAIS_EXTRA = JSON.stringify([
    { id: "testador", tipo: "whatsapp", dono: "empresa", rotulo: "Testador", fonte: "zapi" },
  ]);
  try {
    const extra = listarCanais().find((c) => c.id === "testador");
    eq(!!extra, true, "o canal extra entrou no registro (pre-condicao da prova)");
    eq(extra!.ativo, false, "e ele nasce DESLIGADO, que e o caso que interessa");

    // ——— a resolucao, ramo por ramo
    eq(
      canalParaEscopo("testador", false),
      "central",
      "ROTA DE CONVERSA: canal inativo segue caindo no central (comportamento de sempre, preservado)"
    );
    eq(
      canalParaEscopo("testador", true),
      "testador",
      "ROTA DE CANAL: resolve o id REGISTRADO mesmo inativo, sem default"
    );
    eq(
      canalParaEscopo("nao_existe_nenhum", true),
      CANAL_NAO_REGISTRADO,
      "id que nao esta no registro vira sentinela (nega, em vez de atravessar e virar 404)"
    );
    eq(
      canalParaEscopo("nao_existe_nenhum", false),
      "central",
      "e na rota de conversa id desconhecido segue no central"
    );
    eq(canalParaEscopo("", true), null, "pedido SEM canal continua sendo 'sem canal'");
    eq(canalParaEscopo(undefined, true), null, "e valor ausente tambem");

    // ——— SENTIDO 1: AFROUXAVA. Chave do central operando o canal extra.
    const soCentral = validarEscopoChave({ canais: ["central"] });
    const antesAfrouxa = escopoPermite(soCentral, {
      metodo: "POST",
      pathname: "/api/canais/conexao",
      canal: canalParaEscopo("testador", true),
    });
    eq(
      antesAfrouxa.ok,
      false,
      "chave escopada ao central NAO opera o canal extra inativo (era o furo: desconectava numero que nao alcanca)"
    );
    assert.match(String((antesAfrouxa as any).motivo), /testador/);
    assercoes++;

    // e a prova do contrario, pra a correcao nao ter virado bloqueio geral:
    eq(
      escopoPermite(soCentral, {
        metodo: "POST",
        pathname: "/api/canais/conexao",
        canal: canalParaEscopo("central", true),
      }).ok,
      true,
      "e ela segue operando o canal DELA"
    );

    // ——— SENTIDO 2: APERTAVA. Chave do canal extra nunca alcancava nada.
    const soExtra = validarEscopoChave({ canais: ["testador"] });
    eq(
      escopoPermite(soExtra, {
        metodo: "POST",
        pathname: "/api/canais/conexao",
        canal: canalParaEscopo("testador", true),
      }).ok,
      true,
      "chave escopada ao canal extra ALCANCA o canal extra (antes o id era reescrito como central e ela nunca alcancava nada)"
    );
    eq(
      escopoPermite(soExtra, {
        metodo: "POST",
        pathname: "/api/canais/conexao",
        canal: canalParaEscopo("central", true),
      }).ok,
      false,
      "e nao alcanca o central"
    );

    // ——— a rota de canal NAO assume canal padrao: sem `?canal=`, nada e assumido
    eq(
      assumeCanalPadrao("/api/canais/conexao", "POST"),
      false,
      "rota de canal nao assume canal padrao (o `?canal=` e obrigatorio, e a rota responde 400 sem ele)"
    );
  } finally {
    if (salvo === undefined) delete process.env.CANAIS_EXTRA;
    else process.env.CANAIS_EXTRA = salvo;
  }
}

// ═════ B.13 A RESOLUCAO REAL DO CANAL DO PEDIDO (GRAVE D1 da 2a revisao)
//
// A B.12 provava o TRADUTOR (`canalParaEscopo`) com o id ja escolhido a mao. Isso
// deixou passar o furo que estava na RESOLUCAO — em como o canal do pedido e
// EXTRAIDO de um request HTTP de verdade. Agora a prova monta `Request` reais e
// chama `canalDoPedido`, que e o mesmo caminho que lib/auth-server.ts percorre.
//
// O FURO, e ele nao precisava de nenhuma camada faltando:
//
//   1. as tres rotas de `/api/canais/*` faziam `await req.json()` no topo do POST;
//   2. a porta chamava `getUser` DEPOIS, e `getUser` precisa CLONAR o corpo pra
//      descobrir de qual canal o pedido fala;
//   3. corpo de Request se le UMA VEZ: o clone lancava, o catch zerava, e o canal
//      do pedido virava `null`;
//   4. `null` NAO e negacao — em `escopoPermite`, canal null numa rota fora de
//      `CANAL_PADRAO_EM` simplesmente NAO COMPARA NADA.
//
// Ou seja: uma chave com `escopo.canais = ["central"]` DESCONECTAVA o `apioficial`.
// O escopo de canal ficava inerte, sem erro, sem log e sem teste vermelho.
//
// Contraste medido na epoca: `/api/disparo` chamava o portao ANTES de ler o corpo —
// e por isso LA o escopo funcionava. A diferenca era a ORDEM, e nada mais.
{
  const json = (corpo: unknown, url: string, metodo = "POST") =>
    new Request(url, {
      method: metodo,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
    });

  const CONEXAO = "https://painel.exemplo/api/canais/conexao";
  const CHATS = "https://painel.exemplo/api/chats";
  const SEND = "https://painel.exemplo/api/send";

  // ——— o caminho FELIZ: corpo intacto, canal sai do corpo
  {
    const r = await canalDoPedido(json({ canal: "apioficial", acao: "desconectar" }, CONEXAO), true);
    eq(r.canal, "apioficial", "corpo intacto: o canal do pedido sai do CORPO");
    eq(r.divergente, false, "e nao ha divergencia");
  }

  // ——— A ARMADILHA D1, medida: corpo JA LIDO antes da resolucao
  {
    const req = json({ canal: "apioficial", acao: "desconectar" }, CONEXAO);
    await req.json(); // <- exatamente o que as rotas faziam no topo do POST
    const r = await canalDoPedido(req, true);
    eq(
      r.canal,
      null,
      "corpo JA CONSUMIDO: a resolucao devolve null — e por isso quem le o corpo tem que ser a PORTA, nunca o handler"
    );
    // O QUE O `null` FAZIA — e o que ele faz AGORA. Ate a 3a revisao, canal null
    // numa rota fora de `CANAL_PADRAO_EM` simplesmente NAO COMPARAVA: a chave do
    // `central` passava num POST que mexe no `apioficial`. Era esse o dano, e ele
    // nao precisava de camada faltando. Agora `null` em metodo que muda estado,
    // numa rota que exige canal explicito, e NEGACAO (`CANAL_OBRIGATORIO_EM`) —
    // segunda linha de defesa pra quando a resolucao falhar por qualquer motivo.
    const soCentral = validarEscopoChave({ canais: ["central"] });
    eq(
      escopoPermite(soCentral, { metodo: "POST", pathname: "/api/canais/conexao", canal: null }).ok,
      false,
      "canal null num POST de rota de canal agora NEGA — resolucao que falhou nao pode virar passe livre"
    );
    // ... enquanto com a resolucao funcionando ela e barrada
    eq(
      escopoPermite(soCentral, {
        metodo: "POST",
        pathname: "/api/canais/conexao",
        canal: "apioficial",
      }).ok,
      false,
      "com o canal resolvido, a MESMA chave e barrada — a correcao e a ordem de leitura"
    );
  }

  // ——— query x corpo: precedencia e divergencia, com request de verdade
  {
    const r = await canalDoPedido(json({ canal: "apioficial" }, `${CONEXAO}?canal=apioficial`), true);
    eq(r.canal, "apioficial", "query e corpo concordando: resolve normal");
    eq(r.divergente, false, "sem divergencia");

    const d = await canalDoPedido(json({ canal: "apioficial" }, `${CONEXAO}?canal=central`), true);
    eq(d.divergente, true, "query e corpo com canais DIFERENTES = divergente (o escopo nega)");
    eq(d.canal, "apioficial", "e o canal reportado e o do CORPO, que e o que a rota le");
  }

  // ——— GET nao tem corpo: sai da query
  {
    const r = await canalDoPedido(
      new Request(`${CONEXAO}?canal=apioficial`, { method: "GET" }),
      true
    );
    eq(r.canal, "apioficial", "GET resolve pela query");
  }

  // ——— O HEADER HOSTIL (GRAVE da 3a revisao cega). Corpo JSON valido com
  // content-type de formulario — o DEFAULT do `curl -d`. Era o D1 de volta:
  //
  //   canalDoPedido nao lia o corpo (gate de content-type) -> canal null
  //   escopoPermite com canal null -> NAO COMPARAVA NADA
  //   portaDoCorpo parseava o MESMO corpo -> operava o canal que veio nele
  //
  // Duas leituras DISCORDANTES do mesmo corpo, e a diferenca era um header que
  // quem chama escolhe. Mede-se aqui os DOIS lados: a resolucao e o veredito.
  {
    const hostil = new Request(CONEXAO, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: JSON.stringify({ canal: "apioficial", acao: "desconectar" }),
    });
    const r = await canalDoPedido(hostil, true);
    eq(
      r.canal,
      "apioficial",
      "content-type de formulario com corpo JSON: a resolucao le o corpo IGUAL a rota (nenhum handler confere content-type)"
    );

    const soCentral = validarEscopoChave({ canais: ["central"] });
    const v = escopoPermite(soCentral, {
      metodo: "POST",
      pathname: "/api/canais/conexao",
      canal: r.canal,
    });
    eq(v.ok, false, "e a chave escopada ao `central` e NEGADA nesse POST do `apioficial`");
    assert.match(
      (v as { motivo: string }).motivo,
      /apioficial/,
      "com o motivo dizendo qual numero ela nao alcanca"
    );
    assercoes++;

    // e a chave do numero CERTO segue passando — o conserto nao inventou negacao
    const soOficial = validarEscopoChave({ canais: ["apioficial"] });
    eq(
      escopoPermite(soOficial, { metodo: "POST", pathname: "/api/canais/conexao", canal: r.canal }).ok,
      true,
      "a chave do canal certo passa: o fail-closed nao virou negacao falsa"
    );
  }

  // ——— A OUTRA METADE: a porta recusa 415 antes de ler o corpo. A guarda e pura
  // (lib/canal-conexao.ts) porque lib/canais-porta.ts nao carrega em node puro (o
  // especificador `next/server` sem extensao e o alias `@/`, nao o modulo em si) —
  // a divisao ler/operar ja tinha sido provada por grep
  // por esse motivo, e a mutacao passou verde. Aqui a decisao e exercitada.
  {
    eq(corpoJsonObrigatorio("application/json").ok, true, "415: JSON puro passa");
    eq(
      corpoJsonObrigatorio("application/json; charset=utf-8").ok,
      true,
      "415: o parametro do header nao atrapalha (a tela manda com charset)"
    );
    const recusa = corpoJsonObrigatorio("application/x-www-form-urlencoded");
    eq(recusa.ok, false, "415: content-type de formulario e RECUSADO antes de ler o corpo");
    eq((recusa as { status: number }).status, 415, "e o status e 415 (media type), nao 400");
    eq(corpoJsonObrigatorio("").ok, false, "415: header ausente tambem e recusa (fail-closed)");
    eq(corpoJsonObrigatorio(undefined).ok, false, "415: nem header nenhum passa");
  }

  // ——— O HEADER multipart NAO SALVA MAIS O ATAQUE (GRAVE da 4a revisao cega).
  //
  // A 1a correcao trocou o gate de content-type por uma isencao de `multipart/`, e
  // isso REABRIU o furo pelas rotas de CANAL_PADRAO_EM (/api/send, /api/disparo,
  // /api/visibilidade): o mesmo corpo JSON com `Content-Type: multipart/form-data`
  // fazia o resolvedor pular a leitura -> canal null -> `assumeCanalPadrao` -> a
  // chave do `central` PASSAVA, e a rota mandava pelo `apioficial` do corpo. So
  // /api/canais/* escapava (assumePadrao=false lá). A isencao nao se sustentava: a
  // unica rota multipart do repo (/api/perfil/foto) autentica por SESSAO e nunca
  // chega ao resolvedor. `req.clone().json()` le os BYTES JSON ignorando o header —
  // igual a rota faz — entao a resolucao devolve o canal de verdade.
  {
    const hostilMultipart = new Request(SEND, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=abc" },
      body: JSON.stringify({ canal: "apioficial", texto: "oi" }),
    });
    const r = await canalDoPedido(hostilMultipart, false);
    eq(
      r.canal,
      "apioficial",
      "header multipart com corpo JSON: a resolucao le os bytes IGUAL a rota (o header nao isenta a leitura)"
    );

    // e o veredito ponta a ponta em /api/send (rota de CANAL_PADRAO_EM): a chave do
    // `central` e NEGADA em vez de cair no default e passar
    const soCentral = validarEscopoChave({ canais: ["central"] });
    const v = escopoPermite(soCentral, { metodo: "POST", pathname: "/api/send", canal: r.canal });
    eq(v.ok, false, "chave do `central` NEGADA no POST /api/send com header multipart e corpo do `apioficial`");
    assert.match((v as { motivo: string }).motivo, /apioficial/, "com o motivo dizendo o numero fora do escopo");
    assercoes++;

    // a mesma classe em /api/visibilidade (ACL em lote) e /api/disparo (massa)
    for (const rota of ["/api/visibilidade", "/api/disparo"]) {
      eq(
        escopoPermite(soCentral, { metodo: "POST", pathname: rota, canal: r.canal }).ok,
        false,
        `${rota}: header multipart nao vaza a chave do central pro apioficial`
      );
    }

    // e a chave do numero CERTO segue passando
    const soOficial = validarEscopoChave({ canais: ["apioficial"] });
    eq(
      escopoPermite(soOficial, { metodo: "POST", pathname: "/api/send", canal: r.canal }).ok,
      true,
      "a chave do apioficial passa: o conserto nao inventou negacao"
    );
  }

  // ——— UPLOAD DE VERDADE (bytes que nao sao JSON) cai no catch e vira null —
  // upload legitimo nao chega aqui (a unica rota multipart autentica por sessao),
  // mas se um dia chegasse, o fail-closed de escopoPermite e a rede de baixo.
  {
    const r = await canalDoPedido(
      new Request(CONEXAO, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=abc" },
        body: "------abc\r\nContent-Disposition: form-data; name=\"arquivo\"\r\n\r\n\x89PNG...\r\n------abc--",
      }),
      true
    );
    eq(r.canal, null, "corpo multipart que NAO e JSON falha no parse e vira null (e o fail-closed cobre)");
  }

  // ——— O FAIL-CLOSED: `null` numa rota que EXIGE canal explicito e metodo que muda
  // estado = NEGA. Era aqui que o `null` passava batido, nas duas revisoes.
  {
    const soCentral = validarEscopoChave({ canais: ["central"] });
    eq(
      escopoPermite(soCentral, { metodo: "POST", pathname: "/api/canais/conexao", canal: null }).ok,
      false,
      "canal NAO RESOLVIDO em POST de rota de canal: NEGA (antes passava, e o escopo ficava inerte)"
    );
    eq(
      escopoPermite(soCentral, { metodo: "DELETE", pathname: "/api/canais/templates", canal: null }).ok,
      false,
      "vale pra DELETE tambem — apagar template na Meta e mudar estado"
    );
    // e as duas NEGACOES FALSAS que o fail-closed NAO pode criar:
    eq(
      escopoPermite(soCentral, { metodo: "GET", pathname: "/api/canais", canal: null }).ok,
      true,
      "GET do INDICE sem canal segue passando (ele LISTA numeros e filtra pelo recorte)"
    );
    eq(
      escopoPermite(soCentral, { metodo: "POST", pathname: "/api/admin/usuarios", canal: null }).ok,
      true,
      "e rota que nao fala de canal nenhum segue passando: o fail-closed e da lista curta, nao do recurso"
    );
    eq(
      exigeCanalExplicito("/api/fotos"),
      false,
      "`/api/fotos` e do recurso `canais` e NAO exige canal — por isso a lista e curta, e nao o recurso inteiro"
    );
  }

  // ——— e a lista curta e DERIVADA DO DISCO: todo handler que muda estado em
  // app/api/canais/** tem de ser coberto por `exigeCanalExplicito`. Rota de canal
  // nova entra sem ninguem lembrar de cadastrar.
  {
    const rotas: Array<{ url: string; src: string }> = [];
    const varrer = (d: string, url: string) => {
      for (const nome of readdirSync(d)) {
        const cheio = join(d, nome);
        if (statSync(cheio).isDirectory()) varrer(cheio, `${url}/${nome}`);
        else if (nome === "route.ts") rotas.push({ url, src: readFileSync(cheio, "utf8") });
      }
    };
    varrer(join("app", "api", "canais"), "/api/canais");
    eq(rotas.length >= 4, true, "achei as rotas de canal no disco");
    for (const { url, src } of rotas) {
      const muda = /export async function (POST|PUT|PATCH|DELETE)/.test(src);
      if (!muda) continue;
      eq(
        exigeCanalExplicito(url),
        true,
        `${url} muda estado e esta coberta por CANAL_OBRIGATORIO_EM (canal null ali NAO pode passar)`
      );
    }
  }

  // ——— corpo com JSON QUEBRADO nao derruba a resolucao
  {
    const r = await canalDoPedido(
      new Request(`${CONEXAO}?canal=central`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{isso nao e json",
      }),
      true
    );
    eq(r.canal, "central", "JSON quebrado no corpo: cai na query, sem estourar");
  }

  // ——— O DANO NA ROTA DE `CANAL_PADRAO_EM`, medido — e ele e PIOR que o de
  // `/api/canais/*`. `/api/conversa/contexto` foi uma das duas rotas que a Frente W
  // corrigiu, e ela e o D1 LITERAL: esta em `CANAL_PADRAO_EM` com `["GET","POST"]`
  // e decide o canal pelo CORPO (`canalDeBody`). Ali `null` nao NEGA — ele assume
  // o canal PADRAO. Ou seja: com o corpo consumido antes da identidade, a chave
  // escopada ao `central` PASSA num POST que a rota vai gravar no `apioficial`.
  // Nao ha erro, nao ha log, nao ha teste vermelho: o escopo so para de comparar.
  //
  // Isto NAO substitui a B.14 (que e quem cobra a ORDEM dentro do handler): aqui
  // se mede a CONSEQUENCIA da ordem errada, com `Request` de verdade, pra ela
  // deixar de ser afirmacao de prosa e virar numero.
  {
    const CONTEXTO = "https://painel.exemplo/api/conversa/contexto";
    const soCentral = validarEscopoChave({ canais: ["central"] });
    const corpo = { canal: "apioficial", chat_id: "5511999999999", chave: "ura", valor: "menu" };

    // ordem CERTA (identidade primeiro): o corpo chega intacto na resolucao
    const certa = await canalDoPedido(json(corpo, CONTEXTO), false);
    eq(certa.canal, "apioficial", "ordem certa: a resolucao ve o canal do CORPO em /api/conversa/contexto");
    eq(
      escopoPermite(soCentral, { metodo: "POST", pathname: "/api/conversa/contexto", canal: certa.canal }).ok,
      false,
      "e a chave do `central` e NEGADA — o escopo compara o canal que a rota vai gravar"
    );

    // ordem ERRADA (o handler leu o corpo antes): a resolucao devolve null...
    const consumido = json(corpo, CONTEXTO);
    await consumido.json();
    const errada = await canalDoPedido(consumido, false);
    eq(errada.canal, null, "ordem antiga: corpo consumido, o clone lanca e a resolucao devolve null");
    // ...e AQUI o null nao nega: `CANAL_PADRAO_EM` assume `central` e a chave passa
    eq(assumeCanalPadrao("/api/conversa/contexto", "POST"), true, "e esta rota assume canal padrao no POST");
    eq(
      escopoPermite(soCentral, { metodo: "POST", pathname: "/api/conversa/contexto", canal: errada.canal }).ok,
      true,
      "COM O CORPO CONSUMIDO a chave do `central` PASSA — o escopo comparou o canal ASSUMIDO enquanto a rota escreve no PEDIDO"
    );
  }

  // ——— e a diferenca ENTRE rota de canal e rota de conversa segue valendo aqui,
  //     na resolucao completa (na B.12 ela era medida no tradutor isolado)
  {
    const salvo = process.env.CANAIS_EXTRA;
    process.env.CANAIS_EXTRA = JSON.stringify([
      { id: "testador", tipo: "whatsapp", dono: "empresa", rotulo: "Testador", fonte: "zapi" },
    ]);
    try {
      const emCanal = await canalDoPedido(json({ canal: "testador" }, CONEXAO), true);
      eq(
        emCanal.canal,
        "testador",
        "ROTA DE CANAL: resolve o id registrado mesmo INATIVO (e o numero que vem ser conectado agora)"
      );
      const emConversa = await canalDoPedido(json({ canal: "testador" }, CHATS), false);
      eq(
        emConversa.canal,
        "central",
        "ROTA DE CONVERSA: o mesmo id inativo cai no default central, como a rota vai usar"
      );
      const fantasma = await canalDoPedido(json({ canal: "nao_existe_isso" }, CONEXAO), true);
      eq(
        fantasma.canal,
        CANAL_NAO_REGISTRADO,
        "id que nem existe vira a sentinela: chave com escopo declarado e NEGADA na porta, nao descobre pelo 404"
      );
    } finally {
      if (salvo === undefined) delete process.env.CANAIS_EXTRA;
      else process.env.CANAIS_EXTRA = salvo;
    }
  }

  // ——— O CURTO-CIRCUITO DO CLONE, declarado como VARREDURA.
  //
  // A 3a revisao apontou `canalDoRequest(req, precisa)` como parametro MORTO —
  // "clone+parse do corpo em TODO POST JSON com chave, mesmo sem recorte de canal".
  // Medido no fonte: o curto-circuito EXISTE e e a primeira linha da funcao. O
  // achado nao procede, mas a preocupacao sim, e ficou MAIS forte com a correcao
  // desta onda: agora que o header nao decide mais se o corpo e lido, quem nao tem
  // recorte de canal pagaria clone+parse em TODO metodo que muda estado.
  //
  // Isto e VARREDURA, e nao exercicio, por um motivo declarado: `canalDoRequest` e
  // privada de lib/auth-server.ts, e esse arquivo nao carrega em node puro: nao pelo
  // `next/server` (que carrega, medido), mas pela FORMA do especificador (sem
  // extensao, mais o alias `@/`) e pelo cliente do Supabase que `msgDb()` sobe. O que se
  // mede e a ORDEM no fonte: o `!precisa` tem que vir ANTES da chamada que clona.
  {
    const auth = readFileSync(join("lib", "auth-server.ts"), "utf8");
    const iFn = auth.indexOf("async function canalDoRequest(");
    eq(iFn > -1, true, "achei canalDoRequest no fonte da porta");
    const fn = auth.slice(iFn, auth.indexOf("\n}", iFn));
    assert.match(
      fn,
      /if \(!precisa\) return \{ canal: null, divergente: false \};/,
      "canalDoRequest curto-circuita quando a chave NAO declara canais (o parametro nao e morto)"
    );
    assercoes++;
    const iCurto = fn.indexOf("if (!precisa)");
    const iResolve = fn.indexOf("canalDoPedido(");
    eq(
      iResolve > -1 && iCurto < iResolve,
      true,
      "e o curto-circuito vem ANTES da resolucao que clona o corpo — depois nao economizaria nada"
    );
    // e quem alimenta o parametro e o ESCOPO da chave, nao um palpite da rota
    assert.match(
      auth,
      /canalDoRequest\(req, linha\.escopo\.canais\.length > 0\)/,
      "e o parametro vem do escopo da chave: so paga clone quem tem recorte de canal"
    );
    assercoes++;
  }

  // ——— A GUARDA ESTRUTURAL. O caso acima e mecanico e invisivel: o codigo errado
  // nao quebra, nao loga e nao falha teste — so PARA DE COMPARAR. Entao a unica
  // defesa durável e proibir a leitura do corpo nos handlers de canal.
  {
    const dir = join("app", "api", "canais");
    const rotas: string[] = [];
    const varrer = (d: string) => {
      for (const nome of readdirSync(d)) {
        const cheio = join(d, nome);
        if (statSync(cheio).isDirectory()) varrer(cheio);
        else if (nome === "route.ts") rotas.push(cheio);
      }
    };
    varrer(dir);
    eq(rotas.length >= 4, true, "achei as rotas de canal no disco");
    // A guarda e sobre CODIGO, nao sobre prosa: sem tirar comentario, a propria
    // explicacao do furo ("`req.json()` aqui era o GRAVE D1...") reprovava a rota
    // corrigida. Mesmo helper das provas de fluxo e de fila.
    const semComentario = (fonte: string) =>
      fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const arq of rotas) {
      const src = semComentario(readFileSync(arq, "utf8"));
      eq(
        /req\.json\s*\(/.test(src),
        false,
        `${arq}: handler de canal NAO le o corpo (quem le e portaDoCorpo — ler aqui deixa o escopo da chave inerte)`
      );
      // e todo handler que RECEBE corpo entra pela porta que o le
      if (/export async function (POST|PUT|PATCH)/.test(src)) {
        assert.match(src, /portaDoCorpo\s*\(/, `${arq}: POST de canal entra por portaDoCorpo`);
        assercoes++;
      }
    }
  }
}


// ═════ B.14 A IDENTIDADE VEM ANTES DO CORPO — EM CADA HANDLER, NAO NO ARQUIVO
//
// O GRAVE D1 foi exatamente isto: `await req.json()` no topo do handler e o
// `getUser` depois. `getUser` precisa CLONAR o pedido pra ler a chave de API e
// descobrir de que canal ele fala; corpo ja consumido nao clona — o clone lanca
// "Body is unusable", o catch de `lib/canais.ts` zera o canal do corpo e a
// comparacao do escopo PARA DE ACONTECER. Nao quebra, nao loga, nao falha teste.
//
// A 1a versao desta varredura comparava indices NO ARQUIVO (`src.indexOf("getUser(")`)
// e a re-revisao cega mediu o furo: aquele indice e o da PRIMEIRA ocorrencia do
// arquivo, entao um handler que le o corpo antes da PROPRIA identidade passava se
// qualquer irmao (ou um helper definido acima) ja tivesse citado `getUser`. Medido:
// enfiar `await req.json()` antes do `getUser` do POST de `/api/admin/departamentos`
// deixava a prova VERDE — e DUAS rotas violavam de verdade com a guarda aprovando
// (`/api/admin/restricoes` e `/api/conversa/contexto`; a segunda esta em
// CANAL_PADRAO_EM e decide o canal pelo CORPO, ou seja, o D1 literal em producao).
//
// Agora a comparacao acontece DENTRO da fatia de cada handler exportado, e a
// identidade conta mesmo quando vem por HELPER (`autorizado`, `portao`,
// `portaDoCorpo`, `acessoRelatorios`...). Sem contar helper, a varredura acusaria
// rota CORRETA — falso positivo que apaga o sinal e ensina a ignorar a prova.
//
// E a LEITURA DO CORPO conta pelo MESMO MECANISMO — nao "pelo mesmo criterio" de
// boca: a lista de consumidores de corpo cresce no MESMO laco, com as MESMAS 3
// voltas, e a leitura mediada e reconhecida em CADEIA. Foi assim que a 4a
// re-revisao fechou o furo que a 3a abriu pela metade: reconhecer helper de UM
// nivel (`corpoDoPedido(req)` chamando `req.json()`) deixava passar o mesmo D1
// escrito com DOIS (`corpoDoPedido -> lerCru -> req.json()`) — medido, rota NOVA
// violando o GRAVE D1 com a bateria verde em 464 assercoes. Extrair o parse pra
// helper (e depois extrair de novo) e o reflexo que este repo pratica
// (`autorizado`, `portaDoUsuario`, `barraAutoEdicao`): o que importa e o corpo ter
// sido CONSUMIDO, nao quem o consumiu nem por quantas maos passou.
//
// Helper que resolve identidade e SO ENTAO le o corpo (`portaDoCorpo`) NAO e
// consumidor perigoso: ali a ordem certa acontece dentro dele. Ele entra na
// TERCEIRA lista (`portaDeCorpo`), que existe pro CANARIO: handler que migra pro
// desenho da casa continua contado como "corpo consumido". Sem essa lista,
// adotar `portaDoCorpo` numa rota CORRETA derrubava o piso (medido: 44 contra 45)
// — falso positivo em guarda de seguranca, que e o comeco do afrouxamento.
//
// E a maquina tem PROVA POSITIVA: as ISCAS no fim do bloco sao fonte sintetica
// (dado de teste, nunca codigo do app) analisada pela MESMA funcao que varre
// `app/api`. Desligar o laco mediado, ou tirar o fecho transitivo, deixa este
// bloco VERMELHO. Antes delas a peca nao tinha nenhuma assercao que a
// discriminasse: desligar a deteccao mediada por inteiro mantinha 464 verdes.
{
  // Comentario nao e codigo — e a remocao inclui o de FIM DE LINHA. Sem isso, um
  // `// ... getUser(` na cauda de uma linha antes da leitura dava identidade de
  // graca ao handler (0 casos na arvore hoje; a guarda existe pra continuar 0).
  // O corte e conservador de proposito — so quando o `//` vem depois de espaco,
  // `;`, `)` ou `}` —, entao `https://` dentro de string (que vem depois de `:`)
  // fica intacto. E se algum dia ele comer codigo de verdade, os pisos-canario la
  // embaixo caem junto: eles estao pregados nos numeros MEDIDOS, entao leitura de
  // corpo que sumir da varredura derruba a prova em vez de virar verde silencioso.
  const semComentario = (fonte: string) =>
    fonte
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/([\s;)}])\/\/[^\n]*/g, "$1");
  const arquivos = (dir: string, quero: (nome: string) => boolean) => {
    const achados: string[] = [];
    const varrer = (d: string) => {
      for (const nome of readdirSync(d)) {
        const cheio = join(d, nome);
        if (statSync(cheio).isDirectory()) varrer(cheio);
        else if (quero(nome)) achados.push(cheio);
      }
    };
    varrer(dir);
    return achados;
  };

  // TOPO = declaracao no nivel do arquivo (coluna 0). Ela e o FIM da fatia do que
  // veio antes — e e assim que um helper definido ENTRE dois handlers deixa de ser
  // atribuido ao handler de cima (o falso positivo que a revisao previu).
  const TOPO = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\b/gm;
  const fatia = (src: string, inicio: number) => {
    let fim = src.length;
    for (const m of src.matchAll(TOPO)) {
      if (m.index > inicio) {
        fim = m.index;
        break;
      }
    }
    return src.slice(inicio, fim);
  };
  // chamada DIRETA (`nome(`), nunca membro: `supa.auth.getUser(` NAO e a identidade
  // desta casa (`/api/politica` usa exatamente isso pra validar um token solto).
  const chamada = (corpo: string, nome: string) => new RegExp(`(?<![.\\w$])${nome}\\s*\\(`).exec(corpo);
  const menorIndice = (corpo: string, nomes: Iterable<string>) => {
    let i = -1;
    for (const n of nomes) {
      const m = chamada(corpo, n);
      if (m && (i < 0 || m.index < i)) i = m.index;
    }
    return i;
  };

  // HANDLER cobre as DUAS formas de exportar. Hoje as 127 sao `export async
  // function`, mas `export const POST = async (req) => {}` e Next valido: com o
  // regex antigo a rota inteira ficava FORA da varredura, sem uma linha de aviso.
  const HANDLER =
    /^export\s+(?:(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)|const\s+(GET|POST|PUT|PATCH|DELETE)\s*(?::[^=\n]*)?=)/gm;
  // DECLARACAO idem, e aqui doi mais: a lista de identidade CRESCE varrendo `lib/`,
  // e resolvedor escrito como arrow const fazia o arquivo inteiro que so o usa ser
  // pulado como "webhook" — a rota saia da regra em silencio. (Medido hoje: `lib/`
  // tem 5 arrow consts exportados contra 726 `function`, nenhum de identidade.)
  const DECLARACAO =
    /^(?:export\s+)?(?:(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*(?::[^=\n]*)?=\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>))/gm;
  const nomeDe = (m: RegExpMatchArray) => m[1] ?? m[2] ?? "";
  const VERBO = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;

  // O PARAMETRO NAO SE CHAMA `req` POR LEI. Hoje os 127 handlers usam `req`, mas
  // `request`/`pedido` sao igualmente validos e sairiam da varredura calados: a
  // leitura de corpo e cobrada no NOME DO PARAMETRO daquele handler, lido da
  // assinatura. (E ler o corpo de um CLONE nao consome nada, entao `r.json()`
  // depois de `const r = req.clone()` continua — corretamente — fora da conta.)
  const parametrosDe = (src: string, inicio: number): string => {
    const cab = src.slice(inicio, inicio + 400);
    const par = /^[^(){}]*\(([^)]*)\)/.exec(cab);
    if (par) return par[1];
    const nu = /=\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(cab);
    return nu ? nu[1] : "";
  };
  const nomesDosParametros = (params: string) =>
    params
      .split(",")
      .map((p) => /^\s*([A-Za-z_$][\w$]*)/.exec(p)?.[1])
      .filter((n): n is string => !!n);
  const LEITURA = /(json|formData|text|arrayBuffer)/;
  const leituraDireta = (corpo: string, params: string[]) => {
    let achado: RegExpExecArray | null = null;
    for (const p of params) {
      const m = new RegExp(`(?<![.\\w$])${p}\\.${LEITURA.source}\\s*\\(`).exec(corpo);
      if (m && (!achado || m.index < achado.index)) achado = m;
    }
    return achado;
  };

  // O CONSUMO DO CORPO, direto OU mediado, numa peca so — e a peca que da ao
  // corpo o mesmo fecho transitivo da identidade. `mediadores` sao os nomes ja
  // sabidos consumidores; passar um parametro proprio pra um deles consome o corpo
  // do mesmo jeito que `param.json()`, e por quantas camadas passar. Devolve o
  // MENOR indice (quem consumiu primeiro) e COMO consumiu, pra mensagem de erro
  // nomear o caminho em vez de dizer "algo leu o corpo".
  const consumo = (corpo: string, params: string[], mediadores: Iterable<string>, eu = "") => {
    const direta = leituraDireta(corpo, params);
    let i = direta ? direta.index : -1;
    let como = direta ? direta[0] : "";
    for (const nome of mediadores) {
      if (nome === eu) continue; // funcao recursiva nao se consome a si mesma
      for (const p of params) {
        const m = new RegExp(`(?<![.\\w$])${nome}\\s*\\([^)]*\\b${p}\\b`).exec(corpo);
        if (m && (i < 0 || m.index < i)) {
          i = m.index;
          como = `${nome}(${p})`;
        }
      }
    }
    return { i, como };
  };

  // OS RESOLVEDORES DE IDENTIDADE DESTE REPO, nomeados a mao de proposito:
  //   getUser          — sessao OU chave de API (e o que CLONA o corpo)
  //   usuarioPorSessao — so sessao, recusa `x-api-key` (o corpo dela cita
  //                      `supa.auth.getUser`, que e MEMBRO e nao casa sozinho)
  //   requireUser      — `getUser` puro
  const identidade = new Set(["getUser", "usuarioPorSessao", "requireUser"]);

  // A SEMENTE TEM QUE ESTAR COMPLETA — senao um 4o resolvedor em `lib/auth-server`
  // sai da regra em silencio, levando junto TODA rota que so use ele (elas viram
  // "webhook: fora da regra"). Resolver identidade e I/O (sessao, banco, cache),
  // entao os resolvedores sao exatamente os `export async function` daquele
  // arquivo; os `export function` de la sao helpers sincronos sobre o request
  // (`motivoDaRecusa`, `respostaSemAcesso`, `identidadePorApiKey`...). Resolvedor
  // novo reprova aqui ate ser semeado — que e o ponto.
  //
  // FRONTEIRA DECLARADA (a revisao mediu e anotou): a derivacao e por PROXY
  // ("assincrono => resolvedor") e cobre UM arquivo. Resolvedor novo em outro
  // `lib/*.ts` que valide sessao chamando `supa.auth.getUser` (membro, excluido de
  // proposito) fica fora da semente e fora do crescimento. E heuristica, nao
  // teorema.
  {
    const auth = semComentario(readFileSync(join("lib", "auth-server.ts"), "utf8"));
    const assincronos = [...auth.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]).sort();
    const exportadas = new Set([...auth.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]));
    dep(
      assincronos,
      [...identidade].sort(),
      "a semente de identidade e EXATAMENTE os resolvedores exportados de lib/auth-server.ts (resolvedor novo reprova ate ser semeado aqui)"
    );
    for (const n of identidade) {
      eq(exportadas.has(n), true, `${n} ainda existe em lib/auth-server.ts (semente nao pode apontar pra nome morto)`);
    }
  }

  // AS TRES LISTAS CRESCEM JUNTAS, no mesmo laco e com o mesmo numero de voltas —
  // e por isso a simetria e verdadeira e nao retorica:
  //   nomes          — funcao que chama um resolvedor tambem resolve identidade
  //                    (`portaDoCorpo`, `portaDoCanal`, `acessoRelatorios`...)
  //   consumidores   — funcao que consome o corpo de um parametro ANTES de
  //                    resolver identidade (direto ou por outro consumidor)
  //   portas         — funcao que resolve identidade e SO ENTAO le o corpo (o
  //                    desenho de `portaDoCorpo`): nao e perigosa, mas o corpo
  //                    FOI consumido, e o canario precisa saber
  // Tres voltas cobrem cadeia de 3o grau nas TRES listas — inclusive quando os
  // helpers estao declarados na ordem inversa (uma isca prega exatamente isso).
  // Cadeia de 4o grau esta fora: fronteira declarada, igual a da identidade.
  // Tambem fora (4a revisao cega mediu): request EMBRULHADO em objeto —
  // `kCorpo({ req })` — passa invisivel, porque o rastreio segue o NOME do
  // parametro, nao o valor dentro de literais. E forma evasiva, nao reflexo da
  // casa: 0 ocorrencias dessa forma em app/api+lib contra ~200 de `helper(req)`.
  const crescer = (fontes: string[], nomes: Set<string>, consumidores: Set<string>, portas: Set<string>) => {
    for (let volta = 0; volta < 3; volta++) {
      for (const src of fontes) {
        for (const m of src.matchAll(DECLARACAO)) {
          const nome = nomeDe(m);
          if (!nome || VERBO.test(nome)) continue;
          const corpo = fatia(src, m.index + m[0].length);
          const params = nomesDosParametros(parametrosDe(src, m.index));
          const iId = menorIndice(corpo, nomes);
          const { i: iCorpo } = consumo(corpo, params, [...consumidores, ...portas], nome);
          if (iId > -1) nomes.add(nome);
          // consumo via PORTA nunca cai no ramo perigoso por construcao: a porta e
          // ela mesma um nome de identidade, entao `iId <= iCorpo` sempre.
          if (iCorpo > -1 && (iId < 0 || iCorpo < iId)) consumidores.add(nome);
          else if (iCorpo > -1 && iId > -1) portas.add(nome);
        }
      }
    }
  };

  // DECLARADO, porque a 3a re-revisao mediu e tem razao: a lista de consumidores
  // vinda de `lib/` e hoje `{textoDoCorpo}`, e essa funcao le o corpo de uma
  // RESPOSTA de upstream, nao do request — ou seja, pro D1 ela e semanticamente
  // vazia HOJE. O valor dela e o dia em que um consumidor de request nascer em
  // `lib/`. Quem morde agora e o crescimento POR ARQUIVO DE ROTA (a mesma
  // `crescer`, com o mesmo fecho) e as iscas do fim do bloco, que sao a prova
  // positiva de que a peca esta ligada. A terceira lista tem pino nomeado logo
  // abaixo (`portaDeCorpo.has("portaDoCorpo")`), entao ela nao pode esvaziar calada.
  const consomeCorpo = new Set<string>();
  const portaDeCorpo = new Set<string>();
  const libs = arquivos("lib", (n) => n.endsWith(".ts"));
  crescer(
    libs.map((a) => semComentario(readFileSync(a, "utf8"))),
    identidade,
    consomeCorpo,
    portaDeCorpo
  );
  eq(identidade.has("portaDoCorpo"), true, "a porta das rotas de canal conta como identidade (ela chama getUser antes de ler o corpo)");
  eq(identidade.has("acessoRelatorios"), true, "e a porta dos relatorios tambem — helper nao pode virar falso positivo");
  eq(
    consomeCorpo.has("portaDoCorpo"),
    false,
    "e ela NAO conta como consumidora de corpo: resolve a identidade antes de ler, que e justamente o desenho certo"
  );
  eq(
    portaDeCorpo.has("portaDoCorpo"),
    true,
    "ela e a PORTA do corpo (le depois da identidade) — e por isso o handler que entra por ela continua contado no canario, em vez de derrubar o piso"
  );

  // A ANALISE DE UM ARQUIVO DE ROTA, isolada de proposito: a MESMA funcao roda
  // sobre `app/api` de verdade e sobre as iscas sinteticas do fim do bloco. E o
  // que da prova POSITIVA a esta maquina — sem isso, desligar o laco mediado
  // ficava verde.
  // `cobrado` = a varredura viu o corpo ser consumido por caminho PERIGOSO (direto
  // ou mediado por consumidor). Handler que entra por PORTA aparece na lista com
  // `cobrado: false` — ele conta pro canario e nao e cobrado por ordem, porque a
  // ordem certa acontece dentro da porta. `viola` e o veredito: consumo cobrado
  // sem identidade, ou antes dela.
  type Achado = {
    verbo: string;
    comoLeu: string;
    cobrado: boolean;
    resolveIdentidade: boolean;
    identidadePrimeiro: boolean;
    viola: boolean;
  };
  const analisar = (fonteCrua: string, extras: string[] = []) => {
    const src = semComentario(fonteCrua);
    // helpers do PROPRIO arquivo entram nas tres listas (`autorizado`, `portao` de
    // um lado; um `corpoDoPedido(req)` extraido do outro). O handler nunca entra:
    // `POST(` casaria com a propria assinatura e daria identidade na posicao 0 pra
    // todo mundo — aprovacao universal (e o `VERBO.test` de `crescer` e o que
    // impede).
    const nomes = new Set(identidade);
    const consumidores = new Set(consomeCorpo);
    const portas = new Set(portaDeCorpo);
    crescer([...extras.map(semComentario), src], nomes, consumidores, portas);
    const naRegra = [...identidade].some((n) => chamada(src, n));
    const achados: Achado[] = [];
    for (const h of src.matchAll(HANDLER)) {
      const verbo = h[1] ?? h[2];
      const corpo = fatia(src, h.index);
      const params = nomesDosParametros(parametrosDe(src, h.index));
      if (!params.length) continue; // handler sem objeto de pedido nao tem corpo a consumir
      const perigo = consumo(corpo, params, consumidores);
      const visto = perigo.i > -1 ? perigo : consumo(corpo, params, [...consumidores, ...portas]);
      if (visto.i < 0) continue; // a varredura nao ve corpo consumido aqui
      const iId = menorIndice(corpo, nomes);
      const identidadePrimeiro = perigo.i < 0 || (iId > -1 && perigo.i > iId);
      achados.push({
        verbo,
        comoLeu: visto.como,
        cobrado: perigo.i > -1,
        resolveIdentidade: iId > -1,
        identidadePrimeiro,
        viola: perigo.i > -1 && (iId < 0 || !identidadePrimeiro),
      });
    }
    return { naRegra, achados };
  };

  const rotas = arquivos(join("app", "api"), (n) => n === "route.ts");
  let comIdentidade = 0;
  let handlersComCorpo = 0;
  for (const arq of rotas) {
    const r = analisar(readFileSync(arq, "utf8"));
    if (!r.naRegra) continue; // webhook: fora da regra
    comIdentidade++;
    handlersComCorpo += r.achados.length;
    for (const a of r.achados) {
      if (!a.cobrado) continue; // entrou por porta que resolve identidade primeiro
      eq(
        a.resolveIdentidade,
        true,
        `${arq} ${a.verbo}: le o corpo (${a.comoLeu}) e NAO resolve identidade nenhuma — webhook nao pode morar no mesmo arquivo de uma rota autenticada`
      );
      eq(
        a.identidadePrimeiro,
        true,
        `${arq} ${a.verbo}: le o corpo (${a.comoLeu}) ANTES da propria identidade — corpo consumido nao clona, e o escopo da chave fica inerte`
      );
    }
  }

  // ISCAS — PROVA POSITIVA DA DETECCAO. Fonte sintetica montada linha por linha
  // (as declaracoes tem que nascer na coluna 0, que e onde os regexes de topo
  // casam). Isto e DADO de teste; nao entra no build, nao vira rota, e a analise
  // que roda sobre elas e a mesma que roda sobre `app/api`.
  //
  // Cada isca existe pra que uma peca da maquina MORDA: apague o laco mediado de
  // `consumo`, ou o fecho transitivo de `crescer`, e as linhas abaixo ficam
  // vermelhas. Sem elas, a peca era cerimonia — medido pela 3a re-revisao:
  // desligar a leitura mediada por inteiro mantinha a bateria com 464 verdes.
  const linhas = (...l: string[]) => l.join("\n");
  const ISCAS: {
    nome: string;
    fonte: string;
    libs?: string[];
    acusa: boolean;
    comoLeu?: string;
    semIdentidade?: boolean;
    contaNoCanario?: boolean;
  }[] = [
    {
      nome: "leitura DIRETA antes da identidade",
      fonte: linhas(
        "export async function POST(req) {",
        "  const b = await req.json();",
        "  const u = await getUser(req);",
        "  return Response.json({ b, u });",
        "}"
      ),
      acusa: true,
      comoLeu: "req.json(",
      contaNoCanario: true,
    },
    {
      nome: "helper de UM nivel antes da identidade (o furo que a 3a re-revisao mediu)",
      fonte: linhas(
        "async function corpoDoPedido(p) { return p.json(); }",
        "export async function POST(req) {",
        "  const b = await corpoDoPedido(req);",
        "  const u = await getUser(req);",
        "  return Response.json({ b, u });",
        "}"
      ),
      acusa: true,
      comoLeu: "corpoDoPedido(req)",
      contaNoCanario: true,
    },
    {
      nome: "cadeia de DOIS helpers no mesmo arquivo antes da identidade",
      fonte: linhas(
        "async function lerCru(p) { return p.json(); }",
        "async function corpoDoPedido(p) { return lerCru(p); }",
        "export async function POST(req) {",
        "  const b = await corpoDoPedido(req);",
        "  const u = await getUser(req);",
        "  return Response.json({ b, u });",
        "}"
      ),
      acusa: true,
      comoLeu: "corpoDoPedido(req)",
      contaNoCanario: true,
    },
    {
      // Prega a semantica de INDICE MINIMO de `consumo` (4a revisao cega, ressalva
      // 3): um early-return na leitura direta ("if (direta) return ...", cara de
      // micro-otimizacao) faria o analisador ver SO o `req.json()` de DEPOIS da
      // identidade e deixar passar a violacao mediada de ANTES. Esta isca fica
      // vermelha com essa edicao.
      nome: "mediado ANTES da identidade + direto DEPOIS (o minimo dos dois e que manda)",
      fonte: linhas(
        "async function corpoDoPedido(p) { return p.json(); }",
        "export async function POST(req) {",
        "  const b = await corpoDoPedido(req);",
        "  const u = await getUser(req);",
        "  const extra = await req.json();",
        "  return Response.json({ b, u, extra });",
        "}"
      ),
      acusa: true,
      comoLeu: "corpoDoPedido(req)",
      contaNoCanario: true,
    },
    {
      nome: "cadeia de DOIS helpers vinda de lib/, parametro com outro nome, em rota NOVA",
      fonte: linhas(
        "export async function PUT(pedido) {",
        "  const b = await corpoDoPedido(pedido);",
        "  const u = await getUser(pedido);",
        "  return Response.json({ b, u });",
        "}"
      ),
      libs: [
        linhas(
          "export async function lerCru(p) { return p.json(); }",
          "export async function corpoDoPedido(p) { return lerCru(p); }"
        ),
      ],
      acusa: true,
      comoLeu: "corpoDoPedido(pedido)",
      contaNoCanario: true,
    },
    {
      nome: "cadeia de TRES helpers declarados na ordem INVERSA (prega as 3 voltas)",
      fonte: linhas(
        "async function corpoDoPedido(p) { return meio(p); }",
        "async function meio(p) { return lerCru(p); }",
        "async function lerCru(p) { return p.formData(); }",
        "export async function PATCH(req) {",
        "  const b = await corpoDoPedido(req);",
        "  const u = await getUser(req);",
        "  return Response.json({ b, u });",
        "}"
      ),
      acusa: true,
      comoLeu: "corpoDoPedido(req)",
      contaNoCanario: true,
    },
    {
      nome: "handler que le o corpo e nao resolve identidade nenhuma, com irmao autenticado no arquivo",
      fonte: linhas(
        "export async function GET(req) {",
        "  const u = await getUser(req);",
        "  return Response.json({ u });",
        "}",
        "export async function POST(req) {",
        "  const b = await req.json();",
        "  return Response.json({ b });",
        "}"
      ),
      acusa: true,
      comoLeu: "req.json(",
      semIdentidade: true,
      contaNoCanario: true,
    },
    {
      nome: "ordem CERTA, leitura direta depois da identidade",
      fonte: linhas(
        "export async function POST(req) {",
        "  const u = await getUser(req);",
        "  const b = await req.json();",
        "  return Response.json({ b, u });",
        "}"
      ),
      acusa: false,
      contaNoCanario: true,
    },
    {
      nome: "cadeia de DOIS helpers de IDENTIDADE (ordem certa) segue verde",
      fonte: linhas(
        "async function quemE(p) { return getUser(p); }",
        "async function portao(p) { return quemE(p); }",
        "export async function POST(req) {",
        "  const u = await portao(req);",
        "  const b = await req.json();",
        "  return Response.json({ b, u });",
        "}"
      ),
      acusa: false,
      contaNoCanario: true,
    },
    {
      nome: "rota correta adotando o desenho da casa: porta resolve identidade e SO ENTAO le o corpo",
      fonte: linhas(
        "async function minhaPorta(p) {",
        "  const u = await getUser(p);",
        "  const b = await p.json();",
        "  return { u, b };",
        "}",
        "export async function POST(req) {",
        "  const { u, b } = await minhaPorta(req);",
        "  return Response.json({ u, b });",
        "}"
      ),
      acusa: false,
      contaNoCanario: true,
    },
  ];
  for (const isca of ISCAS) {
    const r = analisar(isca.fonte, isca.libs ?? []);
    eq(r.naRegra, true, `isca "${isca.nome}": o arquivo entra na regra (cita um resolvedor de identidade)`);
    const violam = r.achados.filter((a) => a.viola);
    eq(
      violam.length > 0,
      isca.acusa,
      `isca "${isca.nome}": a varredura ${isca.acusa ? "ACUSA" : "NAO acusa"} consumo de corpo antes da identidade`
    );
    if (isca.acusa) {
      const a = violam[0];
      eq(a.comoLeu, isca.comoLeu, `isca "${isca.nome}": e nomeia COMO o corpo foi consumido (a mensagem tem que apontar o caminho)`);
      if (isca.semIdentidade) {
        eq(a.resolveIdentidade, false, `isca "${isca.nome}": reprova pela assercao de "nenhuma identidade"`);
      } else {
        eq(a.resolveIdentidade, true, `isca "${isca.nome}": a identidade existe no handler`);
        eq(a.identidadePrimeiro, false, `isca "${isca.nome}": reprova pela assercao de ORDEM (corpo antes da identidade)`);
      }
    }
    if (isca.contaNoCanario) {
      eq(
        r.achados.length > 0,
        true,
        `isca "${isca.nome}": o canario CONTA este handler — adotar a porta da casa numa rota correta nao pode derrubar o piso`
      );
    }
  }

  // PISOS-CANARIO PREGADOS NO MEDIDO. Fatia vazia por mudanca de formatacao (ou um
  // regex que parou de casar) nao pode virar aprovacao silenciosa: e o mesmo tipo
  // de "verde por nada" que esta secao existe pra impedir.
  //
  // Eles estavam em `> 30` contra 74/69/45, e isso NAO pregava a cobertura:
  // medido, estreitar o regex de handler pra `(GET|POST)` deixava a guarda VERDE
  // com 7 handlers no escuro. Um terco da cobertura sumia calado, que e o
  // contrario do que este bloco promete. Agora sao os numeros MEDIDOS com folga
  // pequena e DECLARADA: `>=`, nada de margem.
  //
  // O QUE ELES SAO: canario de ENCOLHIMENTO da varredura. Nao sao portao de
  // violacao — quem reprova violacao sao as duas assercoes por handler la em cima,
  // e as iscas provam que elas mordem. Por isso o terceiro conta handler cujo
  // corpo a varredura VE consumido por QUALQUER caminho (direto, mediado por
  // consumidor, ou por porta que resolve identidade primeiro): rota CORRETA que
  // migra pro desenho da casa continua contada, em vez de derrubar o piso.
  //
  // Como reagir quando um deles cair: nao afrouxe o numero pra a bateria voltar ao
  // verde. Rota virou webhook de verdade, ou handler deixou de ler corpo? Confira
  // e RE-MEDIA, escrevendo o numero novo aqui. Se ninguem mexeu nas rotas, o que
  // quebrou foi a varredura — e ai o canario fez o trabalho dele.
  eq(rotas.length >= 74, true, `achei as rotas de api no disco (${rotas.length}, medido 74) — canario de encolhimento, nao portao`);
  eq(comIdentidade >= 69, true, `a varredura olhou as rotas com identidade (${comIdentidade}, medido 69) — canario de encolhimento, nao portao`);
  eq(
    handlersComCorpo >= 48,
    true,
    `e ve o corpo ser consumido nos handlers (${handlersComCorpo}, medido 48 = 45 por caminho cobrado + 3 por porta) — canario de ENCOLHIMENTO da varredura, nao portao de violacao: caiu? re-medir, nunca afrouxar`
  );
}

console.log(`prova-seguranca-conta: 4 cards, ${assercoes} assercoes OK`);
