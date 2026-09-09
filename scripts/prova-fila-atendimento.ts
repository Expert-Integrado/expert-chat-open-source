// Prova da FILA DE ATENDIMENTO (Frente S, card 86ak85nxx): entrar, sair, pular
// a vez, e quem do ranking recebe a conversa.
// Roda em Node >= 22.6 sem build: `node scripts/prova-fila-atendimento.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// Aqui entra so o que e PURO — a DECISAO. O efeito no banco
// (lib/fila-atendimento-db.ts, lib/rodizio.ts) e coberto pelas guardas
// ESTRUTURAIS da secao 7, que leem os arquivos e travam as propriedades que uma
// mutacao no SQL quebraria sem a bateria acusar (licao da fase 3 da Frente P: a
// fiacao nao estava presa por nada e 4 mutacoes passavam com a prova verde).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACOES_FILA,
  TTL_PULO_MS,
  aplicarAcao,
  contarFila,
  ehAcaoFila,
  escolherNaFila,
  estadoPadrao,
  frasePropria,
  motivoAcaoInerte,
  normalizarEstado,
  painelDaFila,
  puloVigente,
  situacao,
  type EstadoFila,
} from "../lib/fila-atendimento.ts";
import { ESCOPO_ABERTO, canalNoEscopo } from "../lib/escopo-chave.ts";
import {
  MODULOS,
  MODULOS_PADRAO,
  derrubarCacheModulos,
  getModulosDetalhado,
  validarMapaModulos,
} from "../lib/modulos.ts";

let n = 0;
function ok(cond: unknown, msg: string) {
  assert.equal(!!cond, true, msg);
  n += 1;
}
function eq(a: unknown, b: unknown, msg: string) {
  assert.deepEqual(a, b, msg);
  n += 1;
}

const AGORA = Date.parse("2026-08-31T15:00:00.000Z");
const iso = (msAtras: number) => new Date(AGORA - msAtras).toISOString();

const mapa = (...es: EstadoFila[]) => new Map(es.map((e) => [e.user_id, e]));
const dentro = (id: string): EstadoFila => ({ user_id: id, dentro: true, pular_vez: false, pular_desde: null });
const fora = (id: string): EstadoFila => ({ user_id: id, dentro: false, pular_vez: false, pular_desde: null });
const pulou = (id: string, msAtras = 0): EstadoFila => ({
  user_id: id,
  dentro: true,
  pular_vez: true,
  pular_desde: iso(msAtras),
});

// ============================================ 1) O DEFAULT: SEM LINHA = DENTRO

// 1.1 quem nunca mexeu na fila esta DENTRO dela. Esta e A propriedade que faz
//     "ligar o modulo da controle, nao muda quem recebe" ser verdade.
{
  eq(estadoPadrao("u1"), { user_id: "u1", dentro: true, pular_vez: false, pular_desde: null }, "sem linha = dentro");
  eq(situacao(estadoPadrao("u1"), AGORA), "dentro", "e a situacao do default e dentro");
}

// 1.2 com a tabela VAZIA e o modulo ligado, a escolha e a mesma do rodizio puro
{
  const r = escolherNaFila(["a", "b", "c"], new Map(), AGORA, { ativo: true });
  eq(r.escolhido, "a", "tabela vazia: vence o primeiro do ranking, como antes da frente");
  eq(r.pulos_consumidos, [], "e nada e consumido");
  eq(r.via_fila, true, "mas a fila DECIDIU (o modulo esta ligado)");
}

// 1.3 MODULO DESLIGADO nao le estado nenhum: mesmo quem esta "fora" recebe.
//     E o contrato de retrocompatibilidade — se esta prova cair, alguem fez a
//     fila valer numa instalacao que nao a ligou.
{
  const r = escolherNaFila(["a", "b"], mapa(fora("a"), pulou("b")), AGORA, { ativo: false });
  eq(r.escolhido, "a", "modulo desligado: o primeiro do ranking vence mesmo marcado como fora");
  eq(r.pulos_consumidos, [], "e nenhum pulo e gasto");
  eq(r.via_fila, false, "via_fila=false diz que a fila nao decidiu nada");
}

// 1.4 `fila_atendimento` existe na lista de modulos e nasce DESLIGADO
{
  ok((MODULOS as readonly string[]).includes("fila_atendimento"), "o modulo esta declarado");
  eq(MODULOS_PADRAO.fila_atendimento, false, "e nasce DESLIGADO (instalacao nasce simples)");
  eq(validarMapaModulos({ fila_atendimento: "true" }), {}, "string 'true' NAO liga modulo");
  eq(validarMapaModulos({ fila_atendimento: true }), { fila_atendimento: true }, "so booleano de verdade liga");
}

// =================================================== 2) SANEAMENTO DA LINHA

// 2.1 `dentro` so sai de true com um FALSE booleano. A string "false" e truthy
//     em JavaScript, e este repo ja pagou esse bug em `bot_ativo` (CLAUDE.md).
{
  eq(normalizarEstado({ user_id: "u", dentro: "false" })!.dentro, true, "string 'false' NAO tira ninguem da fila");
  eq(normalizarEstado({ user_id: "u", dentro: 0 })!.dentro, true, "0 tambem nao");
  eq(normalizarEstado({ user_id: "u", dentro: false })!.dentro, false, "false booleano tira");
  eq(normalizarEstado({ user_id: "u" })!.dentro, true, "campo ausente = dentro");
}

// 2.2 `pular_vez` no sentido oposto: so `true` liga o pulo
{
  eq(normalizarEstado({ user_id: "u", pular_vez: "true" })!.pular_vez, false, "string nao liga pulo");
  eq(normalizarEstado({ user_id: "u", pular_vez: 1 })!.pular_vez, false, "numero nao liga pulo");
  eq(normalizarEstado({ user_id: "u", pular_vez: true })!.pular_vez, true, "true liga");
}

// 2.3 linha sem identidade nao vira estado (nao daria pra saber de quem e)
{
  eq(normalizarEstado(null), null, "null nao vira estado");
  eq(normalizarEstado({}), null, "objeto sem user_id nao vira estado");
  eq(normalizarEstado([]), null, "array nao vira estado");
  eq(normalizarEstado({ dentro: false }, "u9")!.user_id, "u9", "user_id pode vir por fora (o select filtrou por ele)");
}

// ============================================== 3) O PULO: VIGENCIA E TTL

// 3.1 pulo recem-marcado vale
{
  ok(puloVigente(pulou("a", 0), AGORA), "marcado agora vale");
  ok(puloVigente(pulou("a", TTL_PULO_MS - 1000), AGORA), "1s antes do TTL ainda vale");
}

// 3.2 pulo VELHO e inerte — e a situacao volta a "dentro" JUNTO com o efeito.
//     Estado que a tela mostra tem que ser o estado que vale: mostrar "pulou"
//     depois de o pulo ter deixado de valer e a mentira classica de interruptor.
{
  ok(!puloVigente(pulou("a", TTL_PULO_MS + 1000), AGORA), "depois do TTL nao vale");
  eq(situacao(pulou("a", TTL_PULO_MS + 1000), AGORA), "dentro", "e a tela volta a dizer dentro");
  const r = escolherNaFila(["a"], mapa(pulou("a", TTL_PULO_MS + 1000)), AGORA, { ativo: true });
  eq(r.escolhido, "a", "pulo vencido nao segura conversa");
  eq(r.pulos_consumidos, [], "e nem conta como pulo gasto");
}

// 3.3 pulo SEM carimbo (ou com carimbo ilegivel) VALE. A pessoa disse "passa a
//     minha vez": ignorar isso por causa de um timestamp mandaria conversa pra
//     quem avisou que nao podia atender.
{
  ok(puloVigente({ user_id: "a", dentro: true, pular_vez: true, pular_desde: null }, AGORA), "sem carimbo vale");
  ok(puloVigente({ user_id: "a", dentro: true, pular_vez: true, pular_desde: "ontem" }, AGORA), "carimbo ilegivel vale");
}

// 3.4 quem esta FORA nunca aparece como "pulou" (fora ganha, e e mais forte)
{
  eq(situacao({ user_id: "a", dentro: false, pular_vez: true, pular_desde: iso(0) }, AGORA), "fora",
    "fora vence pulou");
}

// =============================================== 4) OS GESTOS (transicoes)

// 4.1 entrar / sair
{
  eq(aplicarAcao(fora("a"), "entrar", iso(0)).dentro, true, "entrar coloca dentro");
  eq(aplicarAcao(dentro("a"), "sair", iso(0)).dentro, false, "sair tira");
}

// 4.2 SAIR LIMPA O PULO. Sem isso, quem saiu e voltou entraria na fila ja
//     pulando a primeira vez sem ter pedido.
{
  const s = aplicarAcao(pulou("a"), "sair", iso(0));
  eq(s.pular_vez, false, "sair apaga o pulo");
  eq(s.pular_desde, null, "e o carimbo dele");
  const volta = aplicarAcao(s, "entrar", iso(0));
  eq(situacao(volta, AGORA), "dentro", "voltar pra fila entra limpo");
}

// 4.3 PULAR exige estar DENTRO (o card: "sem sair da fila"). Marcar pulo em quem
//     esta fora gravaria estado que nao significa nada.
{
  eq(aplicarAcao(fora("a"), "pular", iso(0)).pular_vez, false, "quem esta fora nao pula");
  eq(aplicarAcao(dentro("a"), "pular", iso(0)).pular_vez, true, "quem esta dentro pula");
  eq(aplicarAcao(dentro("a"), "pular", iso(0)).pular_desde, iso(0), "e o carimbo e gravado");
}

// 4.4 "voltar" desfaz o pulo sem sair da fila
{
  const v = aplicarAcao(pulou("a"), "voltar", iso(0));
  eq(situacao(v, AGORA), "dentro", "voltar cancela o pulo");
  eq(v.dentro, true, "e mantem na fila");
}

// 4.5 gesto que nao muda nada DIZ por que (botao que aceita clique e nao faz
//     nada e pior que botao ausente)
{
  ok(motivoAcaoInerte(dentro("a"), "entrar", AGORA), "entrar estando dentro e inerte");
  ok(motivoAcaoInerte(fora("a"), "sair", AGORA), "sair estando fora e inerte");
  ok(motivoAcaoInerte(fora("a"), "pular", AGORA), "pular estando fora e inerte");
  ok(motivoAcaoInerte(pulou("a"), "pular", AGORA), "pular duas vezes e inerte");
  ok(motivoAcaoInerte(dentro("a"), "voltar", AGORA), "voltar sem pulo e inerte");
  eq(motivoAcaoInerte(dentro("a"), "pular", AGORA), null, "pular estando dentro NAO e inerte");
  eq(motivoAcaoInerte(dentro("a"), "sair", AGORA), null, "sair estando dentro NAO e inerte");
  // pulo VENCIDO deixa "pular" valer de novo — senao a pessoa ficaria sem poder
  // pular pra sempre por causa de uma marca que nao vale mais
  eq(motivoAcaoInerte(pulou("a", TTL_PULO_MS + 1), "pular", AGORA), null, "com o pulo vencido, pular vale de novo");
}

// 4.6 a lista de acoes e fechada
{
  eq([...ACOES_FILA], ["entrar", "sair", "pular", "voltar"], "as quatro acoes");
  for (const v of ["ENTRAR", "remover", "", null, 1, {}]) {
    eq(ehAcaoFila(v), false, `acao invalida recusada: ${String(v)}`);
  }
  for (const a of ACOES_FILA) eq(ehAcaoFila(a), true, `acao valida aceita: ${a}`);
}

// ======================================= 5) A ESCOLHA E O CONSUMO DO PULO

// 5.1 "o proximo da fila" = o primeiro do RANKING que esta disponivel.
//     A fila FILTRA; ela nao reordena.
{
  const r = escolherNaFila(["a", "b", "c"], mapa(fora("a")), AGORA, { ativo: true });
  eq(r.escolhido, "b", "quem esta fora e pulado na ordem, sem reordenar o resto");
  eq(r.fora, ["a"], "e fica registrado quem estava fora");
  eq(r.pulos_consumidos, [], "estar fora NAO gasta pulo (nao havia pulo)");
}

// 5.2 O CORACAO DO CARD: o pulo e consumido quando A VEZ CHEGA, e so quem foi
//     percorrido ANTES do escolhido paga.
//
//     Ranking a,b,c com `b` pulando: quem recebe e `c`? NAO — `a` esta na frente
//     e disponivel, entao a vez de `b` nem chegou e o pulo dele CONTINUA.
{
  const r = escolherNaFila(["a", "b", "c"], mapa(pulou("b")), AGORA, { ativo: true });
  eq(r.escolhido, "a", "o primeiro disponivel recebe");
  eq(r.pulos_consumidos, [], "a vez de b nao chegou: o pulo dele fica de pe");
}

// 5.3 ... e quando a vez CHEGA, o pulo e gasto e o proximo recebe
{
  const r = escolherNaFila(["b", "c"], mapa(pulou("b")), AGORA, { ativo: true });
  eq(r.escolhido, "c", "b passou a vez, c recebe");
  eq(r.pulos_consumidos, ["b"], "e o pulo de b foi GASTO — a proxima e dele");
}

// 5.4 MUTACAO QUE A PROVA TEM QUE PEGAR: consumir o pulo de TODO MUNDO a cada
//     rodada. Se `pulos_consumidos` de 5.2 virasse ["b"], numa operacao
//     movimentada o pulo de quem esta no fim do ranking queimaria em segundos
//     sem a vez dele ter chegado — "pular a vez" viraria "esperar 2 segundos".
{
  const r1 = escolherNaFila(["a", "b"], mapa(pulou("b")), AGORA, { ativo: true });
  eq(r1.pulos_consumidos.includes("b"), false, "pulo de quem nao teve a vez NAO e consumido");
  // e a rodada seguinte, com `a` fora, entrega pra `b`? nao: b pulou, e AGORA
  // a vez dele chegou — ele passa e o pulo e gasto
  const r2 = escolherNaFila(["a", "b"], mapa(fora("a"), pulou("b")), AGORA, { ativo: true });
  eq(r2.escolhido, null, "sobrou so quem pulou: ninguem recebe");
  eq(r2.motivo, "todos_pularam", "e o motivo e nomeado");
  eq(r2.pulos_consumidos, ["b"], "o pulo foi gasto: a proxima conversa e dele");
}

// 5.5 CRITERIO DO CARD: fila vazia NAO perde a conversa. A funcao devolve
//     escolhido=null com motivo — quem trata isso e o rodizio, deixando a
//     conversa SEM RESPONSAVEL (visivel pra instalacao inteira,
//     lib/visibilidade.ts) em vez de forcar um destinatario.
{
  const r = escolherNaFila(["a", "b"], mapa(fora("a"), fora("b")), AGORA, { ativo: true });
  eq(r.escolhido, null, "todos fora: ninguem recebe");
  eq(r.motivo, "fila_vazia", "motivo proprio");
  eq(r.fora, ["a", "b"], "e os dois ficam no log");
  eq(r.pulos_consumidos, [], "sem pulo pra gastar");
}

// 5.6 ranking vazio (ninguem online / todos no teto) tem motivo PROPRIO —
//     "a fila esta vazia" e "ninguem estava online" sao diagnosticos diferentes
{
  eq(escolherNaFila([], new Map(), AGORA, { ativo: true }).motivo, "sem_candidato", "ranking vazio");
  eq(escolherNaFila([], new Map(), AGORA, { ativo: false }).motivo, "sem_candidato", "idem com modulo desligado");
}

// 5.7 mistura: alguns fora, um pulando, um disponivel no fim
{
  const r = escolherNaFila(["a", "b", "c", "d"], mapa(fora("a"), pulou("b"), fora("c")), AGORA, { ativo: true });
  eq(r.escolhido, "d", "o unico disponivel recebe");
  eq(r.pulos_consumidos, ["b"], "b teve a vez e passou");
  eq(r.fora, ["a", "c"], "os dois de fora ficam no log e nao gastam nada");
}

// 5.8 DETERMINISMO: a mesma entrada devolve sempre a mesma saida (o desempate do
//     rodizio depende disso pra duas passadas em corrida escolherem a MESMA
//     pessoa e colidirem no onConflict, que e idempotente)
{
  const entrada = () => escolherNaFila(["a", "b", "c"], mapa(pulou("a")), AGORA, { ativo: true });
  eq(entrada(), entrada(), "funcao pura: mesma entrada, mesma saida");
}

// ========================================== 6) O PAINEL DO GESTOR

// 6.1 lista PESSOAS, nao linhas da tabela: quem nunca mexeu aparece como dentro
{
  const linhas = painelDaFila(
    [
      { user_id: "a", nome: "Ana", online: true },
      { user_id: "b", nome: "Bruno" },
    ],
    new Map(),
    AGORA
  );
  eq(linhas.length, 2, "as duas pessoas aparecem");
  eq(linhas.every((l) => l.situacao === "dentro"), true, "e as duas como dentro");
  eq(linhas.find((l) => l.user_id === "a")!.online, true, "online vem de quem chamou");
  eq(linhas.find((l) => l.user_id === "b")!.online, false, "sem visto_em = offline, nunca undefined");
}

// 6.2 ORDEM: quem NAO vai receber vem primeiro (pulou, fora, dentro), nome como
//     desempate. Quem abre esse painel quer ver primeiro o que esta bloqueando.
{
  const linhas = painelDaFila(
    [
      { user_id: "a", nome: "Ana" },
      { user_id: "b", nome: "Bruno" },
      { user_id: "c", nome: "Carla" },
      { user_id: "d", nome: "Davi" },
    ],
    mapa(fora("b"), pulou("c")),
    AGORA
  );
  eq(linhas.map((l) => l.user_id), ["c", "b", "a", "d"], "pulou, fora, e os de dentro por nome");
  eq(linhas[0].pulou_desde, iso(0), "quem pulou traz desde quando");
  eq(linhas[1].pulou_desde, null, "quem nao pulou nao traz carimbo de pulo");
}

// 6.3 nome vazio nao vira linha anonima
{
  const linhas = painelDaFila([{ user_id: "x", nome: "" }], new Map(), AGORA);
  eq(linhas[0].nome, "Atendente", "nome vazio cai no rotulo generico");
}

// 6.4 contagem por situacao
{
  const linhas = painelDaFila(
    [
      { user_id: "a", nome: "A" },
      { user_id: "b", nome: "B" },
      { user_id: "c", nome: "C" },
    ],
    mapa(fora("b"), pulou("c")),
    AGORA
  );
  eq(contarFila(linhas), { dentro: 1, fora: 1, pulou: 1 }, "conta as tres situacoes");
  eq(contarFila([]), { dentro: 0, fora: 0, pulou: 0 }, "lista vazia conta zero em tudo, nunca undefined");
}

// 6.5 a frase que a pessoa le e UMA, pras duas telas (dela e a do gestor)
{
  for (const s of ["dentro", "fora", "pulou"] as const) {
    ok(frasePropria(s).length > 10, `a frase de "${s}" existe e diz algo`);
  }
  ok(/FORA/.test(frasePropria("fora")), "a de fora avisa que nao vai receber");
  ok(/PULADA/.test(frasePropria("pulou")), "a de pulou avisa que a proxima vez sera pulada");
}

// ================================== 7) GUARDAS ESTRUTURAIS (a fiacao)
//
// A prova pura nao alcanca SQL nem rota. Estas guardas leem os arquivos e travam
// propriedades que uma mutacao quebraria com a bateria verde — o defeito que a
// fase 3 da Frente P mediu (fake da porta fazendo o certo, consulta de verdade
// fazendo outra coisa).

const ler = (p: string) => readFileSync(p, "utf8");

// 7.1 o consumo do pulo e CONDICIONADO a `pular_vez` ainda estar ligado. Sem essa
//     guarda, um consumo atrasado apagaria um pulo NOVO que a pessoa marcou no
//     meio: ela clicaria "pular a vez" e receberia conversa mesmo assim.
{
  const src = ler("lib/fila-atendimento-db.ts");
  const consumir = src.slice(src.indexOf("export async function consumirPulos"));
  ok(/\.eq\("pular_vez",\s*true\)/.test(consumir), "consumirPulos leva .eq(pular_vez,true)");
  ok(/pular_vez:\s*false/.test(consumir), "e desliga o pulo");
  ok(/pular_desde:\s*null/.test(consumir), "limpando o carimbo junto");
}

// 7.2 erro de leitura DE VERDADE nao distribui; migration pendente distribui.
//     Os dois ramos tem que existir, e separados — tratar os dois igual foi o
//     defeito "teto fail-open" que a Frente O pagou.
{
  const src = ler("lib/rodizio.ts");
  // o bloco comeca na LEITURA DA FLAG (`const flag = ...`), nao no `filaLigada`:
  // a checagem de falha-na-flag e a primeira coisa do trecho e ficaria de fora.
  const bloco = src.slice(src.indexOf("const flag = await"), src.indexOf("const escolhido = aptos.find"));
  ok(/migration_pendente/.test(bloco), "o rodizio distingue migration pendente de erro real");
  ok(/return \{ motivo: "fila_indisponivel" \}/.test(bloco), "erro real de leitura NAO distribui");
  // a flag e lida pelo DESFECHO (getModulosDetalhado), nao por `moduloAtivo`:
  // um booleano sozinho nao distingue "desligado" de "nao deu pra ler", e essa
  // diferenca e o freio (ver 7.9-f).
  ok(/flag\.mapa\.fila_atendimento === true/.test(bloco), "e o modulo e consultado antes de tudo");
  ok(/getModulosDetalhado\(\)/.test(bloco), "pela leitura que informa se FALHOU");
  // O MODULO DESLIGADO NAO LE A TABELA — com a flag lida COM SUCESSO.
  //
  // A promessa foi REFINADA na 3a revisao, nao afrouxada: existe UM caminho que
  // consulta a tabela sem saber se o modulo esta ligado — o PROCESSO FRIO, gated
  // por `flag.falhou && flag.sem_valor_conhecido`. Leitura bem-sucedida nunca
  // entra ali, entao "modulo desligado + flag legivel" continua nao tocando a
  // tabela. O que a guarda cobra e exatamente isso.
  const iFrio = bloco.indexOf("if (flag.falhou && flag.sem_valor_conhecido)");
  ok(iFrio > 0, "o caminho de processo FRIO existe e e explicito");
  ok(!/lerFilaDe/.test(bloco.slice(0, iFrio)),
    "nenhuma leitura da tabela antes de decidir o caminho");
  // duas leituras, cada uma no seu caminho — uma 3a solta seria consulta sem gate
  eq((bloco.match(/lerFilaDe\(/g) || []).length, 2,
    "existem exatamente DUAS leituras da tabela (caminho frio e modulo ligado)");
  const iLigado = bloco.indexOf("if (filaLigada && !jaLeu)");
  ok(iLigado > iFrio, "e a do modulo ligado vem depois da do processo frio");
}

// 7.3 o consumo do pulo e ESPERADO (`await`). Promessa solta morre com o
//     congelamento do serverless na resposta, e o pulo valeria pra sempre — a
//     pessoa nunca mais receberia conversa.
{
  const src = ler("lib/rodizio.ts");
  ok(/await consumirPulos\(/.test(src), "consumirPulos e chamado com await");
  ok(!/[^t] consumirPulos\(/.test(src.replace(/await consumirPulos\(/g, "await consumirPulos(")),
    "e nao existe chamada sem await");
}

// 7.4 os pulos sao consumidos MESMO quando ninguem foi escolhido: a vez daquelas
//     pessoas chegou e passou. Se o consumo ficasse depois do `if (!r.escolhido)`,
//     um "todos pularam" deixaria os pulos de pe e a fila travaria pra sempre.
{
  const src = ler("lib/rodizio.ts");
  const iConsumo = src.indexOf("await consumirPulos(");
  const iSaida = src.indexOf("if (!r.escolhido)");
  ok(iConsumo > 0 && iSaida > 0, "os dois pontos existem");
  ok(iConsumo < iSaida, "o consumo vem ANTES do retorno de 'ninguem recebeu'");
}

// 7.5 a TRILHA de transferencia e gravada, e o nome do removido e lido ANTES do
//     delete (depois a linha nao existe e a trilha ficaria com um uuid cru).
{
  const src = ler("lib/rodizio.ts");
  const atribuir = src.slice(src.indexOf("export async function atribuir"));
  ok(/registrarEventoResponsavel/.test(atribuir), "atribuir grava a trilha (divida da Frente O fechada)");
  ok(/acao: "atribuido"/.test(atribuir), "com o evento de atribuicao");
  ok(/acao: "removido"/.test(atribuir), "e o de remocao");
  const iLeitura = atribuir.indexOf('.select("tipo,ref_id,nome")');
  const iDelete = atribuir.indexOf(".delete()");
  ok(iLeitura > 0 && iDelete > 0 && iLeitura < iDelete, "o nome de quem sai e lido ANTES do delete");
  ok(/await registrarEventoResponsavel\(/.test(atribuir), "as chamadas sao esperadas (serverless congela na resposta)");
  // a origem distingue FILA de rodizio: o card cobra a trilha DA FILA, e um
  // evento que diz so "rodizio" nao responde "por que essa pessoa e nao aquela"
  ok(/"fila"/.test(atribuir) && /"rodizio"/.test(atribuir) && /"reinicio"/.test(atribuir),
    "as tres origens possiveis estao no codigo");
  // autoria da automacao segue a convencao da 0006: id NULL + nome preenchido
  ok(/id: null as string \| null/.test(atribuir), "a automacao assina com id NULL (convencao da 0006)");
}

// 7.6 a rota NAO deixa ninguem mexer no estado de outra pessoa
{
  const src = ler("app/api/fila-atendimento/route.ts");
  ok(/body\?\.user_id !== undefined/.test(src), "user_id no corpo e recusado explicitamente");
  ok(/status: 403/.test(src), "com 403, nao em silencio");
  // e a rota nao resolve canal: por isso ela nao precisa (nem pode) estar em
  // CANAL_PADRAO_EM. Mencao literal a id de canal tambem entra na varredura da
  // prova de seguranca, entao ela nao pode aparecer aqui nem em comentario.
  ok(!/\bcanalDe\b|\bcanalDeBody\b/.test(src), "a rota nao resolve canal");
}

// 7.7 a migration 0021 segue as regras da casa
{
  const sql = ler("supabase/migrations/0021_fila_atendimento.sql");
  ok(/create table if not exists mensageria\.atendente_fila/.test(sql), "cria a tabela idempotente");
  // licao da 0018: `create table if not exists` NAO altera tabela que ja existe,
  // e a instalacao que testou a versao anterior e justamente a que quebra
  ok(/add column if not exists dentro/.test(sql), "coluna nova tambem entra como add column if not exists");
  ok(/alter column dentro set default true/.test(sql), "e default que muda entra como alter column set default");
  ok(/enable row level security/.test(sql), "RLS ligada como nas irmas");
  ok(/grant select, insert, update, delete on mensageria\.atendente_fila to service_role/.test(sql),
    "grant explicito (tabela nova no schema mensageria nasce sem grant)");
  ok(/notify pgrst, 'reload schema'/.test(sql), "e o reload do schema cache do PostgREST");
  ok(/default true/.test(sql), "o default da coluna `dentro` e true: sem linha = dentro");
}

// 7.8 A TELA so desenha o controle com o modulo LIGADO, e nao entra no poll.
{
  const src = ler("app/home.tsx");
  ok(/fila\?\.modulo_ativo && fila\.eu &&/.test(src), "o controle da fila so aparece com o modulo ligado");
  // a situacao na fila muda quando a PESSOA clica; consultar a cada 6s por
  // atendente pagaria um SELECT eterno pra pintar algo que quase nunca muda
  // (mesmo criterio que manteve a trilha de fluxo fora do poll, Frente O)
  const iPoll = src.indexOf("setInterval(loadChats, 6000)");
  const iCarga = src.indexOf("carregarFila();");
  ok(iPoll > 0 && iCarga > 0 && iCarga < iPoll, "carregarFila roda na abertura, ANTES do setInterval");
  // o corpo do loadChats acaba no closer do PROPRIO useCallback (`}, [` na
  // coluna 2), nao no proximo `function` do arquivo — fatiar ate `abrirConversa`
  // engoliria o efeito de abertura e a declaracao de carregarFila, e a checagem
  // reprovaria sempre por motivo errado
  const iLoad = src.indexOf("const loadChats = useCallback(");
  const iFimLoad = src.indexOf("\n  }, [", iLoad);
  ok(iLoad > 0 && iFimLoad > iLoad, "o corpo do loadChats foi localizado");
  const dentroDoLoadChats = src.slice(iLoad, iFimLoad);
  ok(!/carregarFila/.test(dentroDoLoadChats), "e a fila NAO e consultada dentro do poll de conversas");
  // gesto inerte tem que aparecer na tela: clique que "funciona" e nao muda nada
  // e pior que botao ausente
  // NAO basta a palavra aparecer no arquivo: o que importa e o motivo chegar ao
  // ATENDENTE. A 1a versao desta linha era `/nada_mudou/.test(src)` e passou por
  // uma mutacao que trocava o setAviso por comentario — o token continuava la.
  ok(/if \(j\.nada_mudou\) setAviso\(j\.nada_mudou\)/.test(src),
    "a tela AVISA o motivo de um gesto que nao mudou nada");
}

// ———————————————————————————————————————————————————————————————————————————
// 7.9 GUARDAS DE SEGURANCA E DE FREIO das rotas novas.
//
// Nasceram da revisao cega: TRES mutacoes de seguranca passaram com a bateria
// verde, porque a prova exercitava a DECISAO pura e nada prendia os GATES das
// rotas. Gate que nenhuma prova cobra e gate que a proxima refatoracao remove
// sem ninguem perceber.
{
  const fila = ler("app/api/fila-atendimento/route.ts");

  // (a) VER O TIME exige permissao nomeada. Sem isto, qualquer atendente lista a
  // situacao de todo mundo — "quem esta fora da fila" e informacao de gestao.
  ok(/permitido\(perfil, "gerenciar_usuarios"\)/.test(fila),
    "o painel do time exige a permissao gerenciar_usuarios");
  ok(/ehAdmin\(perfil\)/.test(fila), "super admin tambem alcanca o painel");

  // (b) NINGUEM MEXE NO ESTADO DE OUTRO — nem super admin. "Estou disponivel" e
  // afirmacao sobre uma PESSOA, e um gestor marcando outro como disponivel
  // colocaria conversa na mao de quem nao esta la.
  const post = fila.slice(fila.indexOf("export async function POST"));
  ok(/user_id/.test(post), "o POST olha se veio user_id no corpo");
  ok(/status: 403/.test(post), "e recusa com 403 explicito");
  // a recusa NAO pode ter escape por admin: se `ehAdmin` aparecer no ramo do
  // user_id alheio, alguem abriu a porta que esta rota fecha de proposito
  const iUid = post.indexOf("user_id");
  const ramoUserId = post.slice(iUid, iUid + 700);
  ok(!/ehAdmin|gerenciar_usuarios/.test(ramoUserId),
    "e a recusa do user_id alheio NAO tem excecao pra admin");

  // (c) modulo desligado responde 200, nunca 403 (a tela precisa saber que o
  // recurso existe e esta desligado; 403 faria a tela mentir "voce nao pode")
  ok(/modulo_ativo: false/.test(fila), "modulo desligado responde modulo_ativo:false");
  const antesDoPainel = fila.slice(0, fila.indexOf("pode_ver_time"));
  ok(!/status: 403/.test(antesDoPainel), "e o caminho do modulo desligado nao devolve 403");
}

{
  // (d) O PATCH da agendada: MESMA permissao de criar + a guarda da corrida.
  const ag = ler("app/api/agendadas/route.ts");
  const patch = ag.slice(ag.indexOf("export async function PATCH"), ag.indexOf("export async function DELETE"));
  ok(/permitido\(perfil, "disparo"\)/.test(patch),
    "o PATCH exige a MESMA permissao de criar (disparo)");
  ok(/\.eq\("status", "pendente"\)/.test(patch),
    "o UPDATE do PATCH e condicionado a linha ainda estar pendente");
  ok(/status: 409/.test(patch), "e perder a corrida responde 409, nao 200");
  // os dois gates de CONVERSA (achado da revisao: faltavam os dois aqui)
  ok(/podeVerConversa\(/.test(patch), "o PATCH checa podeVerConversa");
  ok(/restricaoEfetiva\(/.test(patch), "e checa a restricao de contexto (embed)");
  // erro do Postgres NAO vaza pro cliente
  ok(/console\.error\("agendadas \(patch\)/.test(patch), "erro real do banco vai pro log");
  ok(!/error: error\.message/.test(patch), "e a mensagem do Postgres nunca vai no corpo da resposta");
  // o DELETE ganhou os mesmos dois gates (furo identico, no mesmo arquivo)
  const del = ag.slice(ag.indexOf("export async function DELETE"));
  ok(/podeVerConversa\(/.test(del) && /restricaoEfetiva\(/.test(del),
    "o DELETE tambem checa conversa e contexto");
  // ...e a MESMA guarda de corrida do PATCH (achado da 2a revisao: o DELETE
  // escrevia `cancelada` sem condicao, e os dois gates novos ALARGARAM a janela.
  // A sequencia cron-reserva -> cron-envia -> DELETE terminava com `ok:true` de um
  // cancelamento que nao houve: a mensagem estava no celular do cliente).
  ok(/\.eq\("status", "pendente"\)/.test(del), "e o cancelamento so vale se a linha estava pendente");
  ok(/status: 409/.test(del), "perder a corrida no cancelamento responde 409");
  ok(!/error: error\.message/.test(del), "e o DELETE tambem nao vaza a mensagem do Postgres");

  // A LINHA RESERVADA: a rota devolve, e A TELA TRATA.
  //
  // Achado da 2a revisao: a rota e o CLAUDE.md afirmavam "a tela mostra 'saindo
  // agora' e nao oferece editar/cancelar" — e a tela nem carregava o `status`.
  // A linha reservada aparecia como agendamento futuro, com dois botoes que so
  // podiam voltar 400. As checagens abaixo cobram FORMA E FLUXO, nao a frase:
  // o campo chegando ao estado, e os dois botoes condicionados a ele.
  ok(/\.in\("status", \["pendente", "enviando"\]\)/.test(ag),
    "o GET lista tambem a agendada reservada (status enviando)");
  // POR HANDLER: o PATCH tem um select com os mesmos campos, e cobrar no arquivo
  // inteiro deixa passar o GET perdendo o `status` (mutacao mostrou).
  const get = ag.slice(ag.indexOf("export async function GET"), ag.indexOf("const LIMITE_TEXTO_AGENDADA"));
  ok(/\.select\("id,texto,enviar_em,status/.test(get), "e o select DO GET devolve o status");
  {
    const home = ler("app/home.tsx");
    // 1. o campo entra no ESTADO (sem isso, todo o resto e decoracao)
    const estado = home.slice(home.indexOf("const [agendadas, setAgendadas]"), home.indexOf("const [agendarAberto"));
    ok(/status\?: string/.test(estado), "o estado das agendadas carrega o status");
    // 2. a faixa DISTINGUE os dois casos, e o caso reservado nao mostra hora
    //    futura (dizer "agendada pra <hora que passou>" faz achar que da tempo)
    const faixa = home.slice(home.indexOf("{agendadas.length > 0 && ("), home.indexOf("{agendadaEdit?.id === a.id && ("));
    ok(/a\.status === "enviando" \?/.test(faixa), "a faixa distingue a linha que esta saindo");
    const ramoSaindo = faixa.slice(faixa.indexOf('a.status === "enviando" ?'), faixa.indexOf(") : ("));
    ok(!/dataHoraCompleta/.test(ramoSaindo), "e o ramo 'saindo agora' NAO mostra hora futura");
    // 3. os botoes ficam ATRAS da condicao — o teste que importa: nenhum dos dois
    //    pode ser alcancavel numa linha reservada
    ok(/\{a\.status !== "enviando" && \(<>/.test(faixa),
      "Editar e Cancelar so existem enquanto a linha esta pendente");
    const iGate = faixa.indexOf('{a.status !== "enviando" && (<>');
    ok(iGate > 0 && faixa.indexOf("cancelarAgendada(a.id)") > iGate,
      "e o Cancelar esta DENTRO desse gate");
    ok(iGate > 0 && faixa.indexOf('"Fechar" : "Editar"') > iGate, "e o Editar tambem");
    // 4. e o formulario de edicao nao abre pra linha reservada
    ok(/\{a\.status !== "enviando" && agendadaEdit\?\.id === a\.id && \(/.test(home),
      "o formulario de edicao nao abre numa linha que esta saindo");
  }

  // SAIDA pra linha presa em `enviando` (achado da 2a revisao: com PATCH e DELETE
  // recusando nao-pendente e maxDuration matando o laco sem catch, a linha ficava
  // orfa pra sempre). A varredura NUNCA reenvia — move pra `erro` com instrucao.
  {
    const cron = ler("app/api/cron-agendadas/route.ts");
    const varre = cron.slice(0, cron.indexOf("const { data: fila }"));
    ok(/\.eq\("status", "enviando"\)/.test(varre), "o cron varre linha presa em enviando");
    ok(/status: "erro"/.test(varre), "e move pra erro");
    ok(/LIMITE_PRESA_MS/.test(varre) && /\.lt\("enviar_em"/.test(varre),
      "so as velhas (limite de tempo), nunca um envio em curso");
    ok(/confira na conversa/.test(varre), "com frase que diz ao atendente o que fazer");
    // a varredura nao pode virar reenvio: nada de voltar pra `pendente`
    ok(!/status: "pendente"/.test(varre), "e NUNCA devolve a linha pra pendente (reenviaria)");
  }
}

{
  // (e) O CRON RESERVA A LINHA ANTES DE ENVIAR.
  //
  // Sem a reserva, o `.eq("status","pendente")` do PATCH nao protege nada (a
  // linha fica "pendente" durante o envio inteiro) e o tick seguinte reenvia a
  // mesma mensagem pro cliente.
  const cron = ler("app/api/cron-agendadas/route.ts");
  const iReserva = cron.indexOf('.update({ status: "enviando" })');
  ok(iReserva > 0, "o cron marca a linha como enviando");
  ok(/\.update\(\{ status: "enviando" \}\)[\s\S]{0,300}?\.eq\("status", "pendente"\)/.test(cron),
    "e a reserva so vale se a linha ainda estava pendente");
  ok(/if \(!reservada\?\.length\) \{ disputadas\+\+; continue; \}/.test(cron),
    "quem nao reservou NAO envia");
  // a reserva vem ANTES de qualquer envio
  for (const envio of ["gsSendText(", "zapiSendText(", "evoSendText("]) {
    ok(cron.indexOf(envio) > iReserva, `a reserva acontece antes de ${envio.slice(0, -1)}`);
  }
  // e o texto que sai e o da linha RESERVADA (uma edicao que entrou no meio ja
  // esta gravada la; usar o do select do topo mandaria o texto velho)
  // sem os comentarios: comentar a linha (`// m = reservada[0];`) e exatamente a
  // regressao que esta guarda tem que pegar, e ela casaria com o proprio comentario
  const cronCodigo = cron.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  ok(/^\s*m = reservada\[0\];\s*$/m.test(cronCodigo),
    "o texto enviado e o da linha reservada, nao o do select do topo");
}

{
  // (f) A FLAG do modulo — as DUAS metades do freio.
  //
  // 1a revisao: o supabase-js nao lanca em erro de query (devolve `{data,error}`),
  // e destruir o `error` fazia um blip virar mapa default (tudo DESLIGADO) por 30s
  // de cache — o freio da fila sumia justo na hora ruim.
  // 2a revisao: a correcao virou o defeito OPOSTO. Recusar so por `flag.falhou`,
  // antes de olhar se o modulo esta ligado, parava a distribuicao de TODA
  // instalacao — inclusive as que nunca ligaram a fila (100% delas hoje).
  const mod = ler("lib/modulos.ts");
  ok(/const \{ data, error \} = await msgDb\(\)/.test(mod), "getModulos LE o campo error");
  ok(/if \(error\) throw error;/.test(mod), "e erro de leitura SOBE");
  // a excecao de schema ausente SAIU: `erroDeSchemaAusente` casa pela frase
  // "schema cache" (PGRST205), que acontece COM a tabela presente logo depois de
  // deploy/migration — era fail-open pela porta dos fundos.
  const modCodigo = mod.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  ok(!/erroDeSchemaAusente/.test(modCodigo),
    "e NAO existe excecao de schema ausente na leitura da flag");
  // ULTIMO VALOR BOM (padrao da casa): falha serve o ultimo mapa lido, nao default
  ok(/let ultimoBom: MapaModulos \| null = null;/.test(mod), "guarda o ultimo valor bom");
  ok(/return \{ mapa: ultimoBom \?\? base, falhou: true, sem_valor_conhecido: !ultimoBom \};/.test(modCodigo),
    "e numa falha serve o ultimo valor bom, nunca o default cego");
  ok(/ultimoBom = mapa;/.test(modCodigo), "que e gravado a cada leitura boa");
  // leitura que falhou NUNCA entra no cache de 30s (o cache so e escrito no
  // caminho de sucesso, antes do return)
  // o `} catch` procurado e o do getModulosDetalhado, NAO o do modulosDoEnv (que
  // vem antes no arquivo): ancorar no throw e obrigatorio, senao a fatia sai
  // vazia e a checagem reprova por motivo errado.
  const iThrow = modCodigo.indexOf("if (error) throw error;");
  const iCatch = modCodigo.indexOf("} catch", iThrow);
  ok(iThrow > 0 && iCatch > iThrow, "os dois caminhos da leitura foram localizados");
  const sucesso = modCodigo.slice(iThrow, iCatch);
  ok(/cache = \{ mapa, ts: Date\.now\(\) \}/.test(sucesso), "o cache e escrito no caminho de SUCESSO");
  const falha = modCodigo.slice(iCatch);
  ok(!/cache = \{/.test(falha), "e nunca no caminho de falha");
  // a checagem do `ultimoBom ?? base` la de cima nao serve pra este ramo: existem
  // DOIS returns nesse formato (o do amortecedor e o do catch), e um teste global
  // fica verde com o do catch estragado — foi o que uma mutacao mostrou.
  ok(/return \{ mapa: ultimoBom \?\? base, falhou: true, sem_valor_conhecido: !ultimoBom \};/.test(falha),
    "e o ramo de ERRO serve o ultimo valor bom, nao o default");
  // amortecedor: indisponibilidade real nao vira 1 SELECT + 1 log por mensagem
  ok(/Date\.now\(\) < falhaAte/.test(modCodigo), "falha recente nao repete o SELECT");
  ok(/derrubarCacheModulos[\s\S]{0,200}falhaAte = 0/.test(modCodigo),
    "e 'releia agora' limpa a janela de falha");
  // o fallback NAO e derrubado junto com a frescura (licao do getConfig)
  const derruba = modCodigo.slice(modCodigo.indexOf("export function derrubarCacheModulos"));
  ok(!/ultimoBom = null/.test(derruba), "derrubarCacheModulos NAO apaga o ultimo valor bom");

  const rod = ler("lib/rodizio.ts");
  ok(/if \(flag\.falhou && filaLigada\) return \{ motivo: "fila_indisponivel" \};/.test(rod),
    "o rodizio recusa por falha na flag SO com o modulo ligado");
  // ancora na ATRIBUICAO, nao no `const`: virou `let` quando o caminho de
  // processo frio passou a poder ligar a fila depois de sondar a tabela
  const iLigada = rod.indexOf("filaLigada = flag.mapa.fila_atendimento === true;");
  const iRecusa = rod.indexOf("if (flag.falhou && filaLigada)");
  ok(iLigada > 0 && iRecusa > iLigada, "e decide se esta ligado ANTES de recusar");
  const iLerFila = rod.indexOf("lerFilaDe(");
  ok(iRecusa > 0 && iLerFila > iRecusa, "e recusa antes de tentar distribuir");

  // a faixa da tela le o campo PROPRIO do freio, nao o `aviso` compartilhado
  // (falha ao listar o TIME nao e distribuicao parada — era alarme falso)
  const home = ler("app/home.tsx");
  ok(/fila\?\.modulo_ativo && fila\.fila_indisponivel/.test(home),
    "a tela avisa que a fila caiu pelo campo proprio do freio");
  const rota = ler("app/api/fila-atendimento/route.ts");
  // migration pendente segue EXCLUIDA (nao freia nada), mas a falha na FLAG com o
  // modulo ligado passou a entrar — sao as duas causas de recusa do rodizio, e a
  // cobranca completa dessa igualdade esta em 7.9(h).
  ok(/!meu\.ok && !meu\.migration_pendente/.test(rota),
    "que a rota calcula com a leitura da fila, excluindo migration pendente");
  // e reconfere sozinha: falha no meio do turno tem que pintar
  ok(/setInterval\(carregarFila, 60_000\)/.test(home), "a fila e reconferida a cada 60s");
}

{
  // (g) COMPORTAMENTO da flag, nao so forma: a falha e exercitada de verdade.
  //
  // Rodando em node solto o `await import("@/lib/mensageria")` nao resolve, entao
  // getModulosDetalhado cai NO CAMINHO DE FALHA — que e exatamente o que interessa
  // provar. A tabela-verdade abaixo e a que separa o defeito da 1a correcao (parar
  // todo mundo) do comportamento certo (parar so quem ligou a fila).
  const envAntes = process.env.MODULOS;
  // o console.error da falha e ESPERADO aqui: capturado em vez de sujar a saida
  // da prova, e contado — o amortecedor promete 1 log por janela, nao 1 por
  // chamada, e promessa sem checagem e comentario.
  const errosLogados: unknown[] = [];
  const errAntes = console.error;
  console.error = (...args: unknown[]) => { errosLogados.push(args[0]); };
  try {
    // sem env: falha de leitura entrega mapa DESLIGADO -> quem nao usa a fila
    // segue distribuindo (equivalencia byte a byte com o mundo pre-frente)
    delete process.env.MODULOS;
    derrubarCacheModulos();
    const semEnv = await getModulosDetalhado();
    eq(semEnv.falhou, true, "leitura impossivel e reportada como falha");
    eq(semEnv.mapa.fila_atendimento, false, "e sem env o mapa diz DESLIGADO");
    ok(!(semEnv.falhou && semEnv.mapa.fila_atendimento === true),
      "logo o rodizio NAO recusa: instalacao que nao usa a fila nao para");

    // com a fila ligada por env: a MESMA falha agora pede recusa
    process.env.MODULOS = JSON.stringify({ fila_atendimento: true });
    derrubarCacheModulos();
    const comEnv = await getModulosDetalhado();
    eq(comEnv.falhou, true, "a falha continua sendo falha");
    eq(comEnv.mapa.fila_atendimento, true, "mas o valor conhecido diz LIGADO");
    ok(comEnv.falhou && comEnv.mapa.fila_atendimento === true,
      "e ai sim o rodizio recusa — o freio existe pra este caso");

    // AMORTECEDOR: a 3a chamada, SEM derrubar o cache, nao loga de novo e nao
    // tenta o SELECT — numa indisponibilidade real isso era 1 log por mensagem
    // recebida, e o log virava o segundo incidente.
    const logsAntes = errosLogados.length;
    const repetida = await getModulosDetalhado();
    eq(repetida.falhou, true, "a falha se mantem dentro da janela");
    eq(repetida.mapa.fila_atendimento, true, "servindo o mesmo valor conhecido");
    eq(errosLogados.length, logsAntes, "e SEM logar de novo (1 log por janela)");
  } finally {
    console.error = errAntes;
    if (envAntes === undefined) delete process.env.MODULOS;
    else process.env.MODULOS = envAntes;
    derrubarCacheModulos();
  }
}

{
  // (h) OS 4 ACHADOS RESIDUAIS da 3a revisao.
  const rod = ler("lib/rodizio.ts");

  // 1. PROCESSO FRIO: `ultimoBom` e estado de processo. Instancia serverless nova
  //    + blip de banco = nao ha valor conhecido NENHUM, e assumir "desligado"
  //    distribuia pra quem saiu da fila numa instalacao que ligou por config.
  ok(/sem_valor_conhecido/.test(ler("lib/modulos.ts")),
    "a leitura da flag distingue 'ultimo valor dizia OFF' de 'nao ha valor'");
  ok(/if \(flag\.falhou && flag\.sem_valor_conhecido\)/.test(rod),
    "e o rodizio trata processo FRIO como caso proprio");
  const sonda = rod.slice(rod.indexOf("if (flag.falhou && flag.sem_valor_conhecido)"), rod.indexOf("if (filaLigada && !jaLeu)"));
  ok(/lerFilaDe\(/.test(sonda), "no processo frio ele PERGUNTA a tabela em vez de assumir");
  ok(/if \(!sonda\.migration_pendente\) return \{ motivo: "fila_indisponivel" \};/.test(sonda),
    "tabela ausente distribui; erro real de leitura recusa");
  ok(/situacao\(e, agora\) !== "dentro"/.test(sonda), "e olha se ALGUEM esta fora/pulando");
  ok(/if \(alguemFora\) return \{ motivo: "fila_indisponivel" \};/.test(sonda),
    "alguem marcado fora = fila em uso de verdade = recusa");
  // ninguem fora tem que DISTRIBUIR — e sem reler a tabela
  ok(/jaLeu = true;/.test(sonda), "ninguem fora: segue com os estados ja lidos (nao le duas vezes)");
  ok(/if \(filaLigada && !jaLeu\) \{/.test(rod), "e o bloco normal respeita essa marca");

  // 2. O SINAL da tela cobre as DUAS causas de recusa. Calculando so a leitura da
  //    tabela, uma falha SO na flag invertia o sinal: o rodizio recusava e a tela
  //    dizia "voce esta na fila e pode receber conversa nova".
  const rota = ler("app/api/fila-atendimento/route.ts");
  ok(/const filaIndisponivel = \(!meu\.ok && !meu\.migration_pendente\) \|\| \(flag\.falhou && ativo\);/.test(rota),
    "a rota calcula o freio pelas duas causas (tabela E flag)");
  ok(/const flag = await getModulosDetalhado\(\);/.test(rota), "lendo a flag em detalhe, nao o booleano");
  // as duas pontas usam a MESMA regra: o que o rodizio recusa, a tela pinta
  ok(/flag\.falhou && filaLigada/.test(rod) && /flag\.falhou && ativo/.test(rota),
    "e a condicao da tela e a mesma do rodizio");

  // 3. ESCOPO DE CANAL DA CHAVE nos metodos que descobrem o canal DEPOIS.
  //    `escopoPermite` decide com o canal do PEDIDO; PATCH/DELETE de agendadas
  //    acham a linha por `id` e leem o canal dela, entao a porta central nao teve
  //    o que comparar — chave restrita a um canal mexia em agendada de outro.
  const ag = ler("app/api/agendadas/route.ts");
  for (const [metodo, ini, fim] of [
    ["PATCH", "export async function PATCH", "export async function DELETE"],
    ["DELETE", "export async function DELETE", ""],
  ] as [string, string, string][]) {
    const bloco = fim ? ag.slice(ag.indexOf(ini), ag.indexOf(fim)) : ag.slice(ag.indexOf(ini));
    ok(/escopoDaChaveNoRequest\(req\)/.test(bloco), `${metodo}: le o escopo da chave do request`);
    ok(/canalNoEscopo\(escopoChave, /.test(bloco), `${metodo}: compara o canal DA LINHA com o escopo`);
    ok(/status: 403/.test(bloco), `${metodo}: recusa com 403`);
    // a comparacao vem DEPOIS de ler a linha (antes, nao ha canal) e ANTES da escrita
    const iAlvo = bloco.indexOf("const { data: alvo }");
    const iEscopo = bloco.indexOf("canalNoEscopo(");
    const iEscrita = bloco.indexOf(".update(");
    ok(iAlvo >= 0 && iEscopo > iAlvo, `${metodo}: compara depois de saber o canal`);
    ok(iEscrita > iEscopo, `${metodo}: e antes de escrever`);
  }
  // O ESCOPO CHEGA A ROTA: sem esta linha na porta, `escopoDaChaveNoRequest`
  // devolve null pra todo mundo e as duas comparacoes acima ficam inertes —
  // guarda que nao cobre a fiacao cobre teatro (mutacao mostrou).
  const auth = ler("lib/auth-server.ts");
  ok(/escopos\.set\(req, linha\.escopo\);/.test(auth), "a porta guarda o escopo da chave no request");
  const iVeredito = auth.indexOf("if (!veredito.ok) return recusar(req, veredito.motivo);");
  const iSet = auth.indexOf("escopos.set(req, linha.escopo);");
  ok(iVeredito > 0 && iSet > iVeredito, "e SO depois do veredito (chave recusada nao vira contexto)");
  ok(/export function escopoDaChaveNoRequest/.test(auth), "e a rota tem como perguntar");

  // COMPORTAMENTO de canalNoEscopo (nao so a chamada): a funcao e pura, entao a
  // regra e provada de verdade aqui.
  ok(canalNoEscopo({ ...ESCOPO_ABERTO }, "central"), "escopo aberto alcanca qualquer canal");
  ok(canalNoEscopo({ ...ESCOPO_ABERTO, canais: ["central"] }, "central"), "canal declarado passa");
  ok(!canalNoEscopo({ ...ESCOPO_ABERTO, canais: ["central"] }, "outro"), "canal de fora NAO passa");
  ok(canalNoEscopo({ ...ESCOPO_ABERTO, canais: ["central"] }, " central "), "espaco em volta nao muda o veredito");
  // canal DESCONHECIDO com escopo restrito e recusa, nao liberacao: linha sem
  // canal legivel nao pode virar passe livre
  ok(!canalNoEscopo({ ...ESCOPO_ABERTO, canais: ["central"] }, ""), "canal vazio com escopo restrito e recusado");
  ok(!canalNoEscopo({ ...ESCOPO_ABERTO, canais: ["central"] }, null), "canal ausente tambem");
  ok(canalNoEscopo({ ...ESCOPO_ABERTO, canais: [] }, null), "mas com escopo aberto nao ha o que recusar");

  // e o metodo continua FORA da CANAL_PADRAO_EM (declarar canal padrao pra metodo
  // que nao le canal do pedido cria negacao falsa — disciplina da Frente Q)
  const esc = ler("lib/escopo-chave.ts");
  const mapa = esc.slice(esc.indexOf("export const CANAL_PADRAO_EM"), esc.indexOf("export const TOCA_TODOS_OS_CANAIS"));
  ok(!/agendadas[\s\S]{0,80}PATCH/.test(mapa), "o PATCH de agendadas nao entrou na CANAL_PADRAO_EM");
  // ...e pra ele CONSEGUIR ficar fora, o handler nao pode CITAR o id de canal que
  // a varredura B.10 procura — nem em prosa. Este metodo nao resolve canal do
  // pedido (le o canal da LINHA), entao a mencao faria a B.10 cobrar PATCH na
  // tabela e criar negacao falsa pra chave restrita a um canal. A B.10 ja derruba
  // a bateria nesse caso, mas com uma mensagem sobre "metodos divergentes", que
  // nao aponta o comentario: esta guarda existe pra falha DIZER a causa. Aconteceu
  // de verdade ao reescrever o comentario do PATCH nesta frente.
  const agend = ler("app/api/agendadas/route.ts");
  const iPatchAg = agend.indexOf("export async function PATCH");
  const iDeleteAg = agend.indexOf("export async function DELETE");
  const handlerPatch = agend.slice(iPatchAg, iDeleteAg);
  ok(iPatchAg > 0 && iDeleteAg > iPatchAg, "os dois handlers de agendadas foram achados");
  ok(!/\bcanalDe\b|\bcanalDeBody\b|apioficial/.test(handlerPatch),
    "o handler do PATCH nao cita (nem em comentario) o que a varredura B.10 procura");

  // 4. A varredura de linha presa mede pela RESERVA, nao pelo vencimento.
  const cron = ler("app/api/cron-agendadas/route.ts");
  // SEM OS COMENTARIOS, por licao paga tres vezes nesta frente: a prosa ao lado
  // da guarda costuma conter o proprio token que ela procura, e ai a mutacao
  // passa verde porque casou com o comentario (foi assim com o `m = reservada[0];`
  // da secao (e) acima). Aqui o risco e concreto: os comentarios deste trecho
  // falam de `reservada_em IS NULL`, de `NULL < corte` e do `enviar_em` —
  // exatamente o vocabulario das guardas abaixo.
  const cronSemProsa = cron.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  const varre = cronSemProsa.slice(0, cronSemProsa.indexOf("const { data: fila }"));
  ok(/\.lt\(coluna, corte\)/.test(varre) && /varrer\("reservada_em", false\)/.test(varre),
    "a varredura mede a idade por reservada_em");
  ok(/colunaReservadaOk = false/.test(varre), "e degrada pro relogio antigo se a 0021 nao rodou");
  // A COORTE `reservada_em IS NULL` tem varredura PROPRIA (achado da 4a revisao):
  // `NULL < corte` e UNKNOWN em SQL, nao true, entao a linha com a coluna
  // existente e valor NULL nao casava no `.lt` e nao era pega por ramo nenhum —
  // ficava `enviando` pra sempre, invisivel, com PATCH e DELETE recusando.
  ok(/\.is\("reservada_em", null\)\.lt\("enviar_em", corte\)/.test(varre),
    "a coorte reservada_em NULL tem varredura propria, pelo relogio possivel");
  ok(/varrer\("reservada_em", true\)/.test(varre), "e ela e chamada de fato");
  // as tres passadas SOMAM: contar so uma esconderia metade do conserto
  eq((varre.match(/liberadas \+= /g) || []).length, 3,
    "as tres passadas (reserva, legado, coluna ausente) somam em liberadas");
  // O LATCH REARMA. Era de mao unica: codigo que subiu ANTES da 0021 desligava
  // `colunaReservadaOk` no 1o 42703 e nada religava — depois da migration as
  // reservas seguiam gravando NULL pra sempre, alimentando a coorte invisivel.
  const iErro = varre.indexOf('String(r.error.code) === "42703"');
  // busca DEPOIS do 42703: a declaracao do latch no topo do modulo tambem e
  // `colunaReservadaOk = true` e casaria primeiro, deixando a guarda verde com o
  // rearme ausente (a mesma armadilha de ocorrencia irma que ja apareceu 3x aqui)
  const iRearma = varre.indexOf("colunaReservadaOk = true;", iErro);
  ok(iErro > 0 && iRearma > iErro,
    "o latch da coluna REARMA no ramo SEM erro (a varredura sonda a coluna a cada tick)");
  // e o rearme mora DENTRO do `if (!r.error)`: erro que nao e 42703 (rede, pool,
  // timeout) nao diz nada sobre a coluna existir, e rearmar em cima de um blip
  // faria a reserva voltar a tentar a coluna ausente item por item. Sem esta
  // guarda, tirar o `if` mantinha as outras verdes.
  const iSemErro = varre.indexOf("if (!r.error) {", iErro);
  ok(iSemErro > iErro && iRearma > iSemErro,
    "e o rearme (com a 2a passada) fica dentro do ramo sem erro, nao em qualquer nao-42703");
  ok(varre.indexOf('varrer("reservada_em", true)') > iSemErro,
    "a 2a passada tambem, pra nao gastar consulta que se sabe que vai falhar");
  ok(/patch\.reservada_em = new Date\(\)\.toISOString\(\)/.test(cron), "a reserva grava reservada_em");
  // a coluna ausente NAO pode quebrar a reserva (quebraria o agendamento de quem
  // ainda nao migrou) — tem que existir o retry sem a coluna
  const reserva = cron.slice(cron.indexOf("let reservada: any[] | null = null;"), cron.indexOf("const def = canalPorId"));
  ok(/42703/.test(reserva), "coluna ausente na reserva e tratada");
  ok(/\.update\(\{ status: "enviando" \}\)/.test(reserva), "com uma segunda tentativa SEM a coluna");
  // e a migration traz a coluna
  const sql = ler("supabase/migrations/0021_fila_atendimento.sql");
  ok(/add column if not exists reservada_em timestamptz/.test(sql), "a 0021 cria a coluna");
}

console.log(`prova-fila-atendimento: OK (${n} checagens)`);
