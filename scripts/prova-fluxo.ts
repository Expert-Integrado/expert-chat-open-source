// Prova do schema canonico de fluxo, do conversor ChatGuru e das flags de modulo.
// Roda em Node >= 22.6 sem build: `node scripts/prova-fluxo.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// FIXTURES SAO SINTETICAS. Nenhum dialogo real de cliente entra no repo — o
// exercicio contra o acervo de verdade e o DRY RUN do conversor, que le os
// backups fora do repo e sai em relatorio de contagem.
import assert from "node:assert/strict";
import {
  ACOES_QUE_ALCANCAM_CLIENTE,
  ACOES_V1, acoesDoFluxo, esperaTotalSegundos, fluxoLinear, LIMITE_ESPERA_SEG, ordemDeExecucao,
  problemaDeEspera, refFormatoOk, validarFluxo, VERSAO_SCHEMA,
  type Fluxo,
} from "../lib/fluxo/schema.ts";
import { modulosDoEnv, MODULOS_PADRAO, validarMapaModulos } from "../lib/modulos.ts";
import {
  acoesDoDialogo, ALCANCAM_CLIENTE, cabecalhoDoDialogo, consolidar, converterDialogo,
  limitesDoCabecalho, montarFluxo, nomeArquivoSeguro,
} from "./fluxo/converter-chatguru.mjs";

const ok = (r: ReturnType<typeof validarFluxo>) => {
  assert.equal(r.ok, true, "esperava fluxo valido, veio: " + (r.ok ? "" : r.erros.join(" | ")));
  return (r as { ok: true; fluxo: Fluxo }).fluxo;
};
const falha = (bruto: unknown, trecho: string) => {
  const r = validarFluxo(bruto);
  assert.equal(r.ok, false, `esperava recusa por "${trecho}"`);
  const erros = (r as { ok: false; erros: string[] }).erros.join(" | ");
  assert.ok(erros.includes(trecho), `erro deveria citar "${trecho}", veio: ${erros}`);
};

const macroBase = (nos: any[]) => ({ id: "m1", nome: "Macro", tipo: "macro", versao: 1, nos });

// ============================================================ 1) SCHEMA
// 1.1 macro linear valido, com normalizacao
{
  const f = ok(
    validarFluxo(
      macroBase([
        { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "Oi" }, proximo: "n2" },
        { id: "n2", tipo: "acao", acao: { tipo: "etiquetar", etiquetas: ["  a ", "a", "b"] }, proximo: "n3" },
        { id: "n3", tipo: "espera", acao: { tipo: "espera", segundos: 5.4 } },
      ])
    )
  );
  assert.deepEqual((f.nos[1].acao as any).etiquetas, ["a", "b"], "etiqueta trima e deduplica");
  assert.equal((f.nos[1].acao as any).modo, "adicionar", "modo default e adicionar");
  assert.equal((f.nos[2].acao as any).segundos, 5, "segundos arredonda");
}

// 1.2 recusas — cada uma e um jeito de o fluxo estar errado
falha("nao sou objeto", "fluxo precisa ser um objeto");
falha(null, "fluxo precisa ser um objeto");
falha({}, "nome obrigatorio"); // objeto vazio: reclama campo a campo
falha(macroBase([]), "nos precisa ser lista nao vazia");
falha({ ...macroBase([{ id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "x" } }]), tipo: "outro" }, "tipo precisa ser macro ou gatilho");
falha({ ...macroBase([{ id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "x" } }]), id: "id invalido!" }, "id invalido");
falha(macroBase([{ id: "n1", tipo: "acao", acao: { tipo: "danca", texto: "x" } }]), "acao de tipo desconhecido");
falha(macroBase([{ id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "   " } }]), "enviar_texto sem texto");
falha(macroBase([{ id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "x".repeat(4097) } }]), "acima de 4096");
falha(macroBase([{ id: "n1", tipo: "acao", acao: { tipo: "mudar_status", status: "resolvido" } }]), "status invalido");
falha(macroBase([{ id: "n1", tipo: "acao", acao: { tipo: "atribuir_responsavel", responsaveis: [{ tipo: "robo", id: "x" }] } }]), "nenhum responsavel valido");
falha(macroBase([{ id: "n1", tipo: "acao", acao: { tipo: "espera", segundos: LIMITE_ESPERA_SEG + 1 } }]), "espera fora do intervalo");
falha(
  macroBase([
    { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "a" } },
    { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "b" } },
  ]),
  "id repetido"
);
falha(macroBase([{ id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "a" }, proximo: "n9" }]), "proximo aponta pra no inexistente");
// no de tipo espera tem que carregar acao de espera (senao viram 2 jeitos de dizer a mesma coisa)
falha(macroBase([{ id: "n1", tipo: "espera", acao: { tipo: "enviar_texto", texto: "a" } }]), "precisa carregar acao espera");
// MACRO nao aceita ramificacao nem gatilho — isso e fluxo de tipo "gatilho"
falha(
  macroBase([
    { id: "n1", tipo: "condicao", ramos: [{ quando: "x", proximo: "n2" }] },
    { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "a" } },
  ]),
  "macro nao aceita no de tipo condicao"
);

// 1.3 o MESMO desenho com tipo "gatilho" e valido (condicao existe no formato,
// so nao roda na v1) — e o que garante que o conversor nao perde a estrutura
ok(
  validarFluxo({
    id: "g1", nome: "Com condicao", tipo: "gatilho", versao: 1,
    nos: [
      { id: "n1", tipo: "condicao", ramos: [{ quando: "contexto.x == 1", proximo: "n2" }] },
      { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "a" } },
    ],
  })
);

// 1.4 ordem de execucao: segue a corrente, ignora no solto, nao entra em laco
{
  const f = ok(
    validarFluxo(
      macroBase([
        { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "1" }, proximo: "n3" },
        { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "solto" } },
        { id: "n3", tipo: "acao", acao: { tipo: "enviar_texto", texto: "3" } },
      ])
    )
  );
  assert.deepEqual(ordemDeExecucao(f).map((n) => n.id), ["n1", "n3"], "no fora da corrente nao roda");
}
{
  const ciclo = ok(
    validarFluxo(
      macroBase([
        { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "1" }, proximo: "n2" },
        { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "2" }, proximo: "n1" },
      ])
    )
  );
  assert.deepEqual(ordemDeExecucao(ciclo).map((n) => n.id), ["n1", "n2"], "ciclo e cortado, nunca vira laco");
}

// 1.5 fluxoLinear: o atalho que todo conversor usa
{
  const f = fluxoLinear({ id: "x", nome: "X" }, [
    { tipo: "enviar_texto", texto: "a" },
    { tipo: "espera", segundos: 3 },
    { tipo: "nota_interna", texto: "b" },
  ]);
  assert.equal(f.versao, VERSAO_SCHEMA);
  assert.deepEqual(f.nos.map((n) => n.tipo), ["acao", "espera", "acao"]);
  assert.equal(f.nos[2].proximo, undefined, "ultimo no fecha a corrente");
  ok(validarFluxo(f));
}

// 1.6 origem: e o que separa "importei" de "sei o que ficou faltando"
{
  const f = ok(
    validarFluxo({
      ...macroBase([{ id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "a" } }]),
      origem: { ferramenta: "chatguru", id_original: "abc", ressalvas: ["perdeu X", 42] },
    })
  );
  assert.deepEqual(f.origem!.ressalvas, ["perdeu X"], "ressalva nao-texto e descartada");
}

// 7 desde 31/08/2026: `mover_funil` entrou com o epico de funis (a prova dela
// mora em scripts/prova-funis.ts). 9 desde 31/08/2026 (mesmo dia, frente L):
// `definir_contexto`/`limpar_contexto` entraram com o contexto da conversa (a
// prova delas mora em scripts/prova-condicao.ts). 11 desde 31/08/2026 (frentes W e Y):
// `anexar_biblioteca` entrou com a biblioteca de anexos (a prova dela mora em
// scripts/prova-anexos.ts, e o gate de aprovacao dela em scripts/prova-motor-fila.ts)
// e `perguntar_opcoes` com o passo interativo (prova em scripts/prova-costuras-y.ts).
// Mexeu aqui, mexe no doc e no motor.
assert.equal(ACOES_V1.length, 11, "a v1 tem 11 acoes (anexar_biblioteca da W + perguntar_opcoes da Y no merge da onda 5); mexeu aqui, mexe no doc e no motor");

// =========================================================== 2) MODULOS
// Instalacao NASCE simples: nada ligado sem alguem ligar.
// A afirmacao e "NADA nasce ligado", nao "existe exatamente 1 modulo": a lista
// cresce (lib/modulos.ts diz que modulo novo nao pode quebrar instalacao velha),
// e fixar o mapa inteiro fazia esta prova falhar so por existir um modulo a mais
// — foi o que aconteceu quando `disparo` entrou, em 31/08/2026.
assert.ok(Object.keys(MODULOS_PADRAO).includes("automacao"), "automacao esta no registro");
assert.deepEqual(
  Object.entries(MODULOS_PADRAO).filter(([, ligado]) => ligado !== false),
  [],
  "default = tudo desligado, qualquer que seja o tamanho da lista"
);
assert.deepEqual(validarMapaModulos({ automacao: true }), { automacao: true });
assert.deepEqual(validarMapaModulos({ automacao: "true" }), {}, "string nao liga modulo");
assert.deepEqual(validarMapaModulos({ automacao: 1 }), {}, "numero nao liga modulo");
assert.deepEqual(validarMapaModulos({ inventado: true }), {}, "modulo desconhecido e ignorado");
assert.deepEqual(validarMapaModulos(null), {});
assert.deepEqual(validarMapaModulos([{ automacao: true }]), {}, "lista nao e mapa de modulos");
assert.deepEqual(validarMapaModulos({ automacao: false }), { automacao: false }, "desligar explicito vale");
{
  const antes = process.env.MODULOS;
  process.env.MODULOS = '{"automacao":true}';
  assert.deepEqual(modulosDoEnv(), { automacao: true });
  process.env.MODULOS = "{isso nao e json";
  assert.deepEqual(modulosDoEnv(), {}, "JSON quebrado nunca liga modulo");
  if (antes === undefined) delete process.env.MODULOS;
  else process.env.MODULOS = antes;
}

// ========================================================== 3) CONVERSOR
// Fixture no formato do formulario do ChatGuru: lista PLANA de campos.
const campo = (nome: string, valor: any) => ({ rotulo: nome, nome, tipo: "text", valor });
const atraso = (dias = 0, horas = 0, min = 0, seg = 0, delay = 0) => [
  campo("execute_date_days", String(dias)), campo("execute_date_hours", String(horas)),
  campo("execute_date_minutes", String(min)), campo("execute_date_seconds", String(seg)),
  campo("execution_delay", String(delay)),
];
const cabecalho = (over: Record<string, string> = {}) => [
  campo("title", over.title ?? "Macro de teste"),
  campo("node_type", over.node_type ?? "Manual (não será executado automaticamente pelo chatbot)"),
  campo("max_executions_per_chat", over.max_executions_per_chat ?? "9999"),
  campo("seconds_between_execution", over.seconds_between_execution ?? "0"),
  campo("context_variable_name", over.context_variable_name ?? ""),
  campo("context_variable_value", over.context_variable_value ?? ""),
  campo("conditions_advanced", over.conditions_advanced ?? ""),
];
const acao = (id: string, tipo: string, extras: any[] = [], atrasos = atraso()) => [
  campo("action_id", id), { rotulo: "action_type", nome: "action_type", tipo: "hidden", valor: tipo },
  ...extras, ...atrasos,
];
const dialogo = (campos: any[], id = "abc123") => ({ dialogo_id: id, campos });

// 3.1 A ARMADILHA: o formulario renderiza os 21 tipos mesmo sem uso. Acao real
// e so a que tem action_id preenchido — os action_type soltos depois sao ruido.
{
  const campos = [
    ...cabecalho(),
    ...acao("a1", "RESPONDER", [campo("reply.text", "Oi")]),
    // ruido do formulario: action_type sem action_id antes
    { rotulo: "action_type", nome: "action_type", tipo: "hidden", valor: "CRM" },
    campo("crm.name", "- Selecione -"),
    { rotulo: "action_type", nome: "action_type", tipo: "hidden", valor: "FUNIL" },
    { rotulo: "action_type", nome: "action_type", tipo: "hidden", valor: "TEMPLATE_LOCATION" },
  ];
  const acoes = acoesDoDialogo(campos);
  assert.equal(acoes.length, 1, "so a acao com action_id conta (os 21 tipos do form sao ruido)");
  assert.equal(acoes[0].tipo, "RESPONDER");
  assert.equal(cabecalhoDoDialogo(campos).title, "Macro de teste");
}

// 3.2 macro manual com RESPONDER + ANOTACAO = convertido SEM ressalva
{
  const r = converterDialogo(
    dialogo([
      ...cabecalho(),
      ...acao("a1", "RESPONDER", [campo("reply.text", "Bom dia!")]),
      ...acao("a2", "ANOTAÇÃO", [campo("note_text", "cliente avisado")]),
    ])
  );
  assert.equal(r.estado, "convertido", "macro simples converte sem perda: " + JSON.stringify(r.ressalvas));
  assert.equal(r.fluxo.tipo, "macro");
  assert.equal(r.fluxo.origem.ferramenta, "chatguru");
  assert.equal(r.fluxo.origem.id_original, "abc123");
  const f = ok(validarFluxo(r.fluxo)); // ROUND-TRIP: o conversor produz fluxo valido
  assert.deepEqual(ordemDeExecucao(f).map((n) => n.acao!.tipo), ["enviar_texto", "nota_interna"]);
}

// 3.3 atraso da acao vira no de espera ANTES dela (e assim a regua sobrevive)
{
  const r = converterDialogo(
    dialogo([...cabecalho(), ...acao("a1", "RESPONDER", [campo("reply.text", "oi")], atraso(1, 2, 3, 4, 0))])
  );
  const f = ok(validarFluxo(r.fluxo));
  const seq = ordemDeExecucao(f);
  assert.deepEqual(seq.map((n) => n.acao!.tipo), ["espera", "enviar_texto"]);
  assert.equal((seq[0].acao as any).segundos, 86400 + 7200 + 180 + 4, "dias+horas+min+seg somam");
}

// 3.4 STATUS: os 5 do ChatGuru viram os 4 do painel; FECHADO avisa
{
  const alvo = (v: string) => converterDialogo(dialogo([...cabecalho(), ...acao("a1", "STATUS", [campo("status.status", v)])]));
  assert.equal((alvo("RESOLVIDO").fluxo.nos[0].acao as any).status, "concluido");
  assert.equal((alvo("EM ATENDIMENTO").fluxo.nos[0].acao as any).status, "atendimento");
  const fechado = alvo("FECHADO");
  assert.equal((fechado.fluxo.nos[0].acao as any).status, "concluido");
  assert.equal(fechado.estado, "ressalva");
  assert.ok(fechado.ressalvas.some((r: string) => r.includes("FECHADO")), "FECHADO->concluido tem que ficar dito");
  // placeholder do formulario nao vira acao
  assert.equal(alvo("- Selecione -").estado, "nao");
}

// 3.5 TAG: id de etiqueta so vira nome com o catalogo do backup na mao
{
  const campos = [...cabecalho(), ...acao("a1", "TAG", [campo("tags", "id1")])];
  const comCat = converterDialogo(dialogo(campos), { etiquetas: new Map([["id1", "Lead quente"]]) });
  assert.equal(comCat.estado, "convertido");
  assert.deepEqual((comCat.fluxo.nos[0].acao as any).etiquetas, ["Lead quente"]);
  const semCat = converterDialogo(dialogo(campos), { etiquetas: new Map() });
  assert.equal(semCat.estado, "nao", "sem catalogo o id nao vira etiqueta inventada");
}

// 3.6 DELEGAR: o export so traz NOME — converte, mas nao pode ligar sem casar id
{
  const r = converterDialogo(
    dialogo([...cabecalho(), ...acao("a1", "DELEGAR", [campo("delegate.groups", "Vendas | Suporte")])])
  );
  assert.equal(r.estado, "ressalva");
  const resp = (r.fluxo.nos[0].acao as any).responsaveis;
  assert.deepEqual(resp.map((x: any) => x.nome), ["Vendas", "Suporte"], "pipe separa e prefixo de papel cai");
  assert.ok(resp.every((x: any) => x.tipo === "departamento"));
  assert.ok(r.ressalvas.some((x: string) => x.includes("casar com usuario/departamento")));
  ok(validarFluxo(r.fluxo));
}

// 3.7 dialogo so de encadeamento (DIALOGO) = NAO convertido, com motivo
{
  const r = converterDialogo(dialogo([...cabecalho(), ...acao("a1", "DIALOGO", [campo("dialog_id_to_execute", "outro")])]));
  assert.equal(r.estado, "nao");
  assert.ok(r.motivo.includes("DIALOGO"), "o motivo diz qual acao dominava: " + r.motivo);
  assert.equal(r.fluxo, undefined, "nao convertido nao produz fluxo");
}

// 3.8 dialogo AUTOMATICO vira tipo gatilho e avisa que nao dispara sozinho
{
  const r = converterDialogo(
    dialogo([
      ...cabecalho({ node_type: "Padrão (executa o diálogo e finaliza)", conditions_advanced: "!precos", context_variable_name: "etapa" }),
      ...acao("a1", "RESPONDER", [campo("reply.text", "oi")]),
    ])
  );
  assert.equal(r.estado, "ressalva");
  assert.equal(r.fluxo.tipo, "gatilho");
  assert.ok(r.ressalvas.some((x: string) => x.includes("nao dispara sozinho")));
  // desde 31/08/2026 (frente L) a condicao E convertida — quando da. Aqui
  // `!precos` nao existe no vocabulario medido, entao a condicao INTEIRA cai
  // (tudo ou nada) e a ressalva diz que o fluxo veio sem condicao nenhuma.
  assert.ok(r.ressalvas.some((x: string) => x.includes("condicao avancada NAO convertida")));
  assert.ok(r.ressalvas.some((x: string) => x.includes("nem a de variavel de contexto")));
  ok(validarFluxo(r.fluxo));
}

// 3.9 arquivo vazio / sem acao nao explode
assert.equal(converterDialogo({ dialogo_id: "x", campos: [] }).estado, "nao");
assert.equal(converterDialogo(null as any).estado, "nao");
assert.equal(converterDialogo(dialogo([...cabecalho()])).estado, "nao");

// 3.10 consolidado conta as acoes dos NAO convertidos tambem (senao o total do
// relatorio fica menor que o export, e a conta com a origem nao fecha)
{
  const resultados = [
    converterDialogo(dialogo([...cabecalho(), ...acao("a1", "RESPONDER", [campo("reply.text", "oi")])], "d1")),
    converterDialogo(dialogo([...cabecalho(), ...acao("a1", "DIALOGO", [campo("dialog_id_to_execute", "z")])], "d2")),
  ];
  const c = consolidar([{ conta: "teste", resultados }]);
  assert.equal(c.total.convertido, 1);
  assert.equal(c.total.nao, 1);
  assert.equal(c.porTipoConvertido.RESPONDER, 1);
  assert.equal(c.porTipoRessalvado.DIALOGO, 1, "acao do dialogo NAO convertido tem que aparecer");
  assert.equal(c.macro.convertido + c.macro.nao, 2, "os dois sao macro (node_type Manual)");
}

// 3.11 montarFluxo do conversor (JS) produz o mesmo desenho do fluxoLinear (TS)
{
  const acoes = [{ tipo: "enviar_texto", texto: "a" }, { tipo: "espera", segundos: 2 }];
  assert.deepEqual(
    montarFluxo({ id: "z", nome: "Z", tipo: "macro" }, acoes).nos,
    fluxoLinear({ id: "z", nome: "Z" }, acoes as any).nos,
    "as duas montagens tem que desenhar a mesma corrente"
  );
}

// ================================================ 4) ACHADOS DA REVISAO CEGA
// Cada bloco aqui reproduz um defeito REAL apontado na revisao de 31/08/2026.

// 4.1 (ALTA) O 500 do GET /api/macros. Fluxo de tipo "gatilho" com no de
// condicao passa no validarFluxo e o PRIMEIRO no nao tem acao. A listagem
// mapeava n.acao!.tipo direto e estourava TypeError — uma linha ruim no banco
// derrubava a rota inteira, pra todo mundo, com 500.
{
  const gatilho = ok(
    validarFluxo({
      id: "g-quebra", nome: "Gatilho", tipo: "gatilho", versao: 1,
      nos: [
        { id: "n1", tipo: "condicao", ramos: [{ quando: "x", proximo: "n2" }], proximo: "n2" },
        { id: "n2", tipo: "acao", acao: { tipo: "enviar_texto", texto: "oi" } },
      ],
    })
  );
  assert.equal(gatilho.nos[0].acao, undefined, "no de condicao nao carrega acao (e legitimo)");
  // o jeito ANTIGO explodia; o jeito novo devolve so as acoes de verdade
  assert.throws(() => ordemDeExecucao(gatilho).map((n) => (n.acao as any).tipo), TypeError, "o mapa ingenuo ainda estoura — por isso existe acoesDoFluxo");
  assert.deepEqual(acoesDoFluxo(gatilho), ["enviar_texto"], "acoesDoFluxo ignora no sem acao em vez de estourar");
  // macro normal segue listando tudo, na ordem da corrente
  const macro = ok(
    validarFluxo(
      macroBase([
        { id: "n1", tipo: "acao", acao: { tipo: "enviar_texto", texto: "a" }, proximo: "n2" },
        { id: "n2", tipo: "espera", acao: { tipo: "espera", segundos: 2 } },
      ])
    )
  );
  assert.deepEqual(acoesDoFluxo(macro), ["enviar_texto", "espera"]);
}

// 4.2 (MEDIA-ALTA) A SOMA das esperas. Cada espera dentro do limite individual,
// o total estourando o tempo da requisicao: a funcao morria no meio, com
// mensagem ja enviada pro cliente e sem trilha (que so grava no fim).
{
  const comEsperas = (qtd: number, seg: number) =>
    ok(validarFluxo(fluxoLinear({ id: "e", nome: "E" }, Array.from({ length: qtd }, () => ({ tipo: "espera", segundos: seg }) as any))));
  const limites = { maxInline: 15, maxTotal: 40 };
  assert.equal(esperaTotalSegundos(comEsperas(5, 15)), 75, "a soma e o que conta");
  assert.equal(problemaDeEspera(comEsperas(2, 15), limites), null, "30s cabe");
  const estouro = problemaDeEspera(comEsperas(5, 15), limites);
  assert.ok(estouro?.includes("somam mais de 40s"), "5 esperas de 15s (cada uma no limite) TEM que ser recusado: " + estouro);
  // o limite individual continua valendo sozinho
  assert.ok(problemaDeEspera(comEsperas(1, 3600), limites)?.includes("espera inline"), "espera unica gigante segue recusada");
  // e uma espera longa importada continua CABENDO no formato (so nao roda na v1)
  ok(validarFluxo(fluxoLinear({ id: "r", nome: "Regua" }, [{ tipo: "espera", segundos: 86400 } as any])));
}

// 4.3 (MEDIA) Responsavel FANTASMA: id que nao existe no painel faz a conversa
// sumir do escopo de todo mundo menos super admin. O guarda do motor comeca
// pelo formato — e e exatamente onde o id sintetico do conversor cai.
{
  assert.equal(refFormatoOk("3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607"), true);
  assert.equal(refFormatoOk("chatguru:usuario:Barbara"), false, "id sintetico do import NAO passa");
  assert.equal(refFormatoOk(""), false);
  assert.equal(refFormatoOk("nao-uuid"), false);
  assert.equal(refFormatoOk(undefined as any), false);
  // e o conversor de fato produz ids que o guarda barra (o elo entre os dois)
  const r = converterDialogo(
    dialogo([...cabecalho(), ...acao("a1", "DELEGAR", [campo("delegate.groups", "Vendas")])])
  );
  const ids = (r.fluxo.nos[0].acao as any).responsaveis.map((x: any) => x.id);
  assert.ok(ids.every((id: string) => !refFormatoOk(id)), "fluxo importado nunca entra com responsavel valido de brinde");
}

// 4.4 (BAIXA-MEDIA) Path traversal na saida --json: o id do fluxo deriva do
// dialogo_id de um JSON de TERCEIRO e ia direto pro path.join.
{
  assert.equal(nomeArquivoSeguro("conta", "cg-abc123"), "conta__cg-abc123.json");
  const mau = nomeArquivoSeguro("conta", "../../../etc/passwd");
  assert.ok(!mau.includes("/") && !mau.includes("\\") && !mau.includes(".."), "traversal neutralizado: " + mau);
  assert.ok(!nomeArquivoSeguro("../conta", "x").includes(".."), "a conta tambem e saneada");
  // ":" e valido no id canonico mas nao em nome de arquivo no Windows
  assert.ok(!nomeArquivoSeguro("c", "cg:a:b").includes(":"));
  assert.ok(nomeArquivoSeguro("", "").endsWith(".json"), "nome vazio nao vira arquivo sem nome");
}

// 4.5 A ressalva do DIALOGO separa "nunca teve alvo" de "tem alvo e ainda nao
// converte". Sem isso, quem monta o mapa da rede de fluxos conta 1.205 acoes
// que NUNCA tiveram destino como chamada perdida — 1/3 de perda inventada.
{
  const comAlvo = (v: string) =>
    converterDialogo(dialogo([...cabecalho(), ...acao("a1", "DIALOGO", [campo("dialog_id_to_execute", v)])]));

  const semAlvo = comAlvo("-- SELECIONE O DIÁLOGO --");
  assert.ok(
    semAlvo.ressalvas.some((r: string) => r.includes("sem alvo configurado")),
    "placeholder tem que dizer que nao havia chamada: " + JSON.stringify(semAlvo.ressalvas)
  );
  assert.ok(comAlvo("").ressalvas.some((r: string) => r.includes("sem alvo configurado")), "vazio conta como sem alvo");

  const nomeado = comAlvo("Menu Inicial");
  assert.ok(nomeado.ressalvas.some((r: string) => r.includes("chamar outro fluxo e v2")), "alvo real mantem a ressalva de encadeamento");

  // As duas NAO podem se confundir. Quem le a ressalva pra montar o mapa da
  // rede de fluxos reconhece o caso "sem alvo" por SUBSTRING; se a ressalva de
  // alvo REAL passar a casar com um desses marcadores, o sentido do numero na
  // tela dele inverte EM SILENCIO (aresta real vira "nunca teve destino").
  // Marcadores vigentes do leitor (frente do editor, 31/08/2026):
  const MARCADORES_SEM_ALVO = /sem alvo|nenhum dialogo selecionado|nao configurad|sem destino/i;
  assert.ok(
    nomeado.ressalvas.every((r: string) => !MARCADORES_SEM_ALVO.test(r)),
    "ressalva de alvo REAL nao pode casar com marcador de sem-alvo: " + JSON.stringify(nomeado.ressalvas)
  );
  assert.ok(
    semAlvo.ressalvas.some((r: string) => MARCADORES_SEM_ALVO.test(r)),
    "ressalva de SEM alvo tem que casar com o marcador do leitor"
  );
  // os dois casos continuam sendo NAO convertido (a acao segue sem equivalente)
  assert.equal(semAlvo.estado, "nao");
  assert.equal(nomeado.estado, "nao");
}

// ============ 4) OS CAMPOS DA FILA NO CONVERSOR (Frente P, fase 3)
//
// O conversor emite `limites`, `espera.pular_fim_de_semana` e `no.aprovacao`. Cada
// caso abaixo e um defeito que a re-revisao pegou, nao um estilo preferido.

// 4.1 A LISTA DUPLICADA NAO PODE DIVERGIR.
// O conversor precisa rodar mesmo onde o Node nao le TypeScript, entao ele carrega
// o schema so dinamicamente e mantem uma copia da lista de acoes que falam com o
// cliente. Copia sem prova e copia que diverge — esta assertion e a prova.
{
  assert.deepEqual(
    [...ALCANCAM_CLIENTE],
    [...ACOES_QUE_ALCANCAM_CLIENTE],
    "a lista do conversor tem que ser IGUAL a do schema (lib/fluxo/schema.ts e a fonte)"
  );
}

// 4.2 APROVACAO SO ONDE A ACAO FALA COM O CLIENTE.
// Medido: 796 dos 837 nos com `need_approval` eram NOTA INTERNA, e marcar todos
// matava 631 macros que rodam num clique. O que nao e aplicado sai como ressalva.
{
  const comAval = (tipo: string, extras: any[]) =>
    converterDialogo(
      dialogo([...cabecalho(), ...acao("a1", tipo, [...extras, campo("need_approval", "True")])])
    );

  const mensagem = comAval("RESPONDER", [campo("reply.text", "segue a proposta")]);
  assert.equal(mensagem.fluxo.nos[0].aprovacao, true, "aval em mensagem pro cliente e APLICADO");
  assert.ok(
    mensagem.ressalvas.some((r: string) => r.includes("roda mais como macro instantaneo")),
    "e quem importa precisa saber que o macro passou a rodar pela fila"
  );

  const nota = comAval("ANOTAÇÃO", [campo("note_text", "conferir")]);
  assert.equal(nota.fluxo.nos[0].aprovacao, undefined, "aval em nota interna NAO e aplicado");
  assert.ok(
    nota.ressalvas.some((r: string) => r.includes("nao fala com o cliente")),
    "o que nao foi aplicado tem que ficar DITO: " + JSON.stringify(nota.ressalvas)
  );
  assert.equal(
    nota.ressalvas.some((r: string) => r.includes("roda mais como macro instantaneo")),
    false,
    "sem aval que bloqueia, o macro continua sendo macro"
  );
  ok(validarFluxo(nota.fluxo));
}

// 4.3 FLAG PRESENTE E ILEGIVEL = LIGADA + RESSALVA (freio falha FECHADO).
// `limpo()` devolve "" pra tudo que nao e string: boolean/number viravam `false` em
// silencio e a exigencia de aval SUMIA. Nos 33 backups medidos o valor e sempre a
// string "True" — esta prova existe pro dia em que o export mudar.
{
  const porValor = (v: any) =>
    converterDialogo(
      dialogo([...cabecalho(), ...acao("a1", "RESPONDER", [campo("reply.text", "oi"), campo("need_approval", v)])])
    );

  assert.equal(porValor(true).fluxo.nos[0].aprovacao, true, "boolean true do JSON conta");
  assert.equal(porValor(1).fluxo.nos[0].aprovacao, true, "number 1 conta");
  assert.equal(porValor("false").fluxo.nos[0].aprovacao, undefined, "'false' e false de verdade");
  assert.equal(porValor(0).fluxo.nos[0].aprovacao, undefined, "0 e false de verdade");
  assert.equal(porValor("").fluxo.nos[0].aprovacao, undefined, "vazio nao e marca");

  const estranho = porValor("Sim, sempre");
  assert.equal(estranho.fluxo.nos[0].aprovacao, true, "valor irreconhecivel conta como LIGADO");
  assert.ok(
    estranho.ressalvas.some((r: string) => r.includes("irreconhecivel")),
    "e sai com ressalva pra alguem conferir: " + JSON.stringify(estranho.ressalvas)
  );
}

// 4.4 PULAR FIM DE SEMANA vai na ESPERA; sem atraso a adiar, vira ressalva.
{
  const comAtraso = converterDialogo(
    dialogo([
      ...cabecalho(),
      ...acao("a1", "RESPONDER", [campo("reply.text", "oi"), campo("jump_weekend", "True")], atraso(2)),
    ])
  );
  const seq = ordemDeExecucao(ok(validarFluxo(comAtraso.fluxo)));
  assert.equal((seq[0].acao as any).tipo, "espera");
  assert.equal((seq[0].acao as any).pular_fim_de_semana, true, "a marca mora NA espera");
  assert.equal(seq[1].aprovacao, undefined);

  const semAtraso = converterDialogo(
    dialogo([...cabecalho(), ...acao("a1", "RESPONDER", [campo("reply.text", "oi"), campo("jump_weekend", "True")])])
  );
  assert.ok(
    semAtraso.ressalvas.some((r: string) => r.includes("sem atraso a adiar")),
    "sem espera nao ha o que adiar, e isso e diferente de 'nao existe na v1'"
  );
}

// 4.5 SENTINELA POR IGUALDADE. 999 e 9999 sao os valores de fabrica da tela; a
// faixa 1000..9998 e limite DIGITADO (37 ocorrencias medidas) e era descartada em
// silencio pelo teste por faixa.
{
  const lim = (max: string, entre = "0") => {
    const r: string[] = [];
    const l = limitesDoCabecalho(
      { max_executions_per_chat: max, seconds_between_execution: entre },
      r
    );
    return { l, ressalvas: r };
  };

  assert.equal(lim("9999").l, null, "9999 e 'sem limite' de fabrica");
  assert.equal(lim("999").l, null, "999 tambem");
  assert.equal(lim("1").l.maximo_por_conversa, 1, "1 e o limite que importa (roda uma vez)");
  assert.equal(lim("99").l.maximo_por_conversa, 99);

  const mil = lim("1000");
  assert.equal(mil.l.maximo_por_conversa, 1000, "1000 e limite digitado, nao sentinela");
  assert.ok(
    mil.ressalvas.some((r) => r.includes("honrado como limite REAL")),
    "numero alto sai com ressalva pra quem importou conferir"
  );

  const enorme = lim("99999");
  assert.equal(enorme.l, null, "acima do teto do schema o limite NAO e aplicado");
  assert.ok(enorme.ressalvas.some((r) => r.includes("acima do teto")), "e a razao fica escrita");

  assert.equal(lim("9999", "300").l.intervalo_minimo_segundos, 300, "o anti-repique entra sozinho");
  const meses = lim("9999", String(180 * 24 * 3600));
  assert.equal(meses.l, null, "intervalo de 180 dias passa do teto: nao aplicado");
  assert.ok(meses.ressalvas.some((r) => r.includes("acima do teto")));
}

// 4.6 CAMPO NUMERICO COMO NUMBER NAO PODE SUMIR (irmao do 4.3).
// `limpo()` devolve "" pra tudo que nao e string e `Number("")` e 0: atraso e limite
// vindos como number viravam ZERO em silencio — a regua de 2 dias mandava tudo na
// hora, e `max_executions: 5` virava "sem limite", o oposto do configurado.
{
  // atraso: number cru nos campos de data
  const comNumber = converterDialogo(
    dialogo([
      ...cabecalho(),
      ...acao("a1", "RESPONDER", [campo("reply.text", "oi")], [
        campo("execute_date_days", 2 as any),
        campo("execute_date_hours", 0 as any),
        campo("execute_date_minutes", 0 as any),
        campo("execute_date_seconds", 0 as any),
        campo("execution_delay", 0 as any),
      ]),
    ])
  );
  const seq = ordemDeExecucao(ok(validarFluxo(comNumber.fluxo)));
  assert.deepEqual(seq.map((n) => n.acao!.tipo), ["espera", "enviar_texto"], "atraso como NUMBER nao pode sumir");
  assert.equal((seq[0].acao as any).segundos, 2 * 86400);

  // atraso ilegivel: vira 0 E sai com ressalva (nao chuta em silencio)
  const ilegivel = converterDialogo(
    dialogo([
      ...cabecalho(),
      ...acao("a1", "RESPONDER", [campo("reply.text", "oi")], [
        campo("execute_date_days", "dois"),
        campo("execute_date_hours", "0"),
        campo("execute_date_minutes", "0"),
        campo("execute_date_seconds", "0"),
        campo("execution_delay", "0"),
      ]),
    ])
  );
  assert.deepEqual(ordemDeExecucao(ok(validarFluxo(ilegivel.fluxo))).map((n) => n.acao!.tipo), ["enviar_texto"]);
  assert.ok(
    ilegivel.ressalvas.some((r: string) => r.includes("irreconhecivel no atraso")),
    "atraso ilegivel tem que ficar dito: " + JSON.stringify(ilegivel.ressalvas)
  );

  // limites: number cru no cabecalho
  const r1: string[] = [];
  const lim = limitesDoCabecalho({ max_executions_per_chat: 5, seconds_between_execution: 300 }, r1);
  assert.equal(lim.maximo_por_conversa, 5, "limite como NUMBER nao pode virar null");
  assert.equal(lim.intervalo_minimo_segundos, 300, "intervalo como NUMBER tambem vale");
  assert.deepEqual(r1, [], "number valido nao gera ressalva");

  // limite ilegivel: nao aplica E avisa
  const r2: string[] = [];
  assert.equal(limitesDoCabecalho({ max_executions_per_chat: "cinco", seconds_between_execution: "" }, r2), null);
  assert.ok(r2.some((r) => r.includes("irreconhecivel no limite")), "limite ilegivel tem que ficar dito: " + JSON.stringify(r2));

  // e a sentinela continua valendo com number (9999 cru = sem limite)
  assert.equal(limitesDoCabecalho({ max_executions_per_chat: 9999, seconds_between_execution: 0 }, []), null);
}

// ================================ 5) ACAO ANEXAR -> anexar_biblioteca (Frente W)
//
// A acao que decide se 76 ocorrencias medidas nos dialogos convertem ou saem como
// ressalva. O campo `attach.files` guarda ID (medido: 61 valores, 100% ObjectId),
// e o painel referencia o item pela CHAVE — entao a conversao depende do mapa que
// o passo de importacao dos anexos emite. As provas abaixo cobram as duas metades:
// converte quando o mapa alcanca, e NAO CHUTA quando nao alcanca.
{
  const anexar = (valores: any, ctx: any = {}) =>
    converterDialogo(
      dialogo([...cabecalho(), ...acao("a1", "ANEXAR", [campo("attach.files", valores)])]),
      ctx
    );
  const mapa = new Map<string, { chave: string; nome: string }>([
    ["642735c7929b0a3a4d36cb3c", { chave: "tabela-de-precos-2026", nome: "Tabela de Precos 2026.pdf" }],
    ["642735c7929b0a3a4d36cb3d", { chave: "catalogo", nome: "catalogo.pdf" }],
    ["642735c7929b0a3a4d36cb3e", { chave: "catalogo-2", nome: "catalogo.pdf" }],
  ]);

  // 5.1 COM O MAPA, converte — e a referencia vai pela CHAVE, nunca pelo id
  const bom = anexar(["642735c7929b0a3a4d36cb3c"], { anexos: mapa });
  assert.equal(bom.estado, "convertido", "ANEXAR com o mapa CONVERTE: " + JSON.stringify(bom.ressalvas));
  const passo = ok(validarFluxo(bom.fluxo)).nos[0].acao as any;
  assert.equal(passo.tipo, "anexar_biblioteca");
  assert.equal(passo.anexo, "tabela-de-precos-2026", "o passo guarda a CHAVE portatil");
  assert.equal(passo.legenda, undefined, "sem legenda: a origem nao tem campo medido pra isso");

  // 5.2 SEM MAPA NENHUM: ressalva que diz O QUE FAZER (o comando, com nome)
  const semMapa = anexar(["642735c7929b0a3a4d36cb3c"]);
  assert.equal(semMapa.estado, "nao", "sem mapa a acao nao converte");
  assert.ok(
    semMapa.ressalvas.some((r: string) => r.includes("importar/anexos.mjs")),
    "a ressalva tem que nomear o passo que resolve: " + JSON.stringify(semMapa.ressalvas)
  );

  // 5.3 ID FORA DO MAPA: a frase MUDA conforme o catalogo e parcial ou completo —
  // "nao capturado" e "nao existe" pedem acoes diferentes de quem migra.
  const forapParcial = anexar(["ffffffffffffffffffffffff"], { anexos: mapa, anexosParcial: true });
  assert.ok(
    forapParcial.ressalvas.some((r: string) => /PARCIAL/.test(r)),
    "com catalogo parcial, a ressalva diz que o item pode existir e nao ter sido capturado"
  );
  const foraCompleto = anexar(["ffffffffffffffffffffffff"], { anexos: mapa, anexosParcial: false });
  assert.ok(
    foraCompleto.ressalvas.some((r: string) => /tela da biblioteca/.test(r)) &&
      !foraCompleto.ressalvas.some((r: string) => /PARCIAL/.test(r)),
    "com catalogo completo, a ressalva manda subir o material: " + JSON.stringify(foraCompleto.ressalvas)
  );

  // 5.4 O VALOR PODE SER NOME (medido: o campo aceita as duas formas). Nome UNICO
  // resolve; nome REPETIDO vira ressalva — chutar mandaria o material errado.
  const porNome = anexar(["Tabela de Precos 2026.pdf"], { anexos: mapa });
  assert.equal(porNome.estado, "convertido", "nome unico resolve: " + JSON.stringify(porNome.ressalvas));
  assert.equal((ok(validarFluxo(porNome.fluxo)).nos[0].acao as any).anexo, "tabela-de-precos-2026");
  const ambiguo = anexar(["catalogo.pdf"], { anexos: mapa });
  assert.equal(ambiguo.estado, "nao", "nome repetido NAO converte");
  assert.ok(
    ambiguo.ressalvas.some((r: string) => /mais de um item/.test(r)),
    "e a ressalva diz que o nome e ambiguo: " + JSON.stringify(ambiguo.ressalvas)
  );

  // 5.4b A GUARDA "so quando parece nome de arquivo" TEM QUE GUARDAR.
  //
  // O ponto do regex era metacaractere (`.` sem barra), entao QUALQUER texto com
  // 2-5 alfanumericos no fim passava por ela. Pra a mutacao ser visivel, o mapa
  // aqui tem um item cujo NOME nao tem extensao: com o ponto escapado a acao NAO
  // resolve (o valor nao parece arquivo, e vira ressalva); sem a barra, ela
  // resolveria pelo nome e o fluxo importado mandaria material que ninguem
  // configurou.
  {
    const mapaSemExtensao = new Map<string, { chave: string; nome: string }>([
      ["642735c7929b0a3a4d36cb40", { chave: "guia-do-aluno", nome: "Guia do Aluno" }],
    ]);
    const semExtensao = anexar(["Guia do Aluno"], { anexos: mapaSemExtensao });
    assert.equal(
      semExtensao.estado,
      "nao",
      "texto sem extensao NAO e tratado como nome de arquivo: " + JSON.stringify(semExtensao.ressalvas)
    );
    // o irmao positivo continua valendo: COM extensao, resolve pelo nome
    const comExtensao = anexar(["Tabela de Precos 2026.pdf"], { anexos: mapa });
    assert.equal(comExtensao.estado, "convertido", "e nome COM extensao segue resolvendo");
  }
  // 5.5 VARIOS ARQUIVOS numa acao: cada um vira UM passo, e o que nao resolve sai
  // como ressalva SEM derrubar os que resolvem (mesma regra do case FUNIL).
  const misto = anexar(["642735c7929b0a3a4d36cb3c", "ffffffffffffffffffffffff", "642735c7929b0a3a4d36cb3d"], {
    anexos: mapa,
  });
  const passos = ordemDeExecucao(ok(validarFluxo(misto.fluxo))).map((n) => (n.acao as any).anexo);
  assert.deepEqual(passos, ["tabela-de-precos-2026", "catalogo"], "os que resolvem viram passo, na ordem");
  assert.equal(misto.ressalvas.length >= 1, true, "e o que nao resolveu ficou DITO");

  // 5.6 SEM ARQUIVO ESCOLHIDO: o formulario do ChatGuru renderiza a acao mesmo sem
  // uso — isso nao e perda de importacao, e a frase nao pode culpar o mapa.
  const vazio = anexar([], { anexos: mapa });
  assert.ok(
    vazio.ressalvas.some((r: string) => r.includes("sem arquivo escolhido")),
    "acao sem arquivo diz exatamente isso: " + JSON.stringify(vazio.ressalvas)
  );
}
console.log("prova-fluxo: OK");
