// Prova da 4a origem de publico do disparo: FILTRO SALVO / ETAPA DO PIPEDRIVE.
// Roda em Node >= 22.6 sem build: `node scripts/prova-publico-pipedrive.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// REGRA DA CASA: **nenhuma rede tocada e nenhum banco tocado.** A ida ao CRM
// entra por porta injetada (`PortaPipedrive`), entao paginacao, teto, resposta
// hostil e formato torto sao medidos aqui em memoria. Se um dia esta prova
// precisar de rede pra passar, o desenho regrediu.
//
// O QUE ELA GUARDA DE VERDADE (o resto e detalhe):
//  1. resposta que nao e `success: true` NUNCA vira publico vazio — vira ERRO;
//  2. UM telefone por pessoa, e sempre o MESMO (remontar nao troca o destino);
//  3. paginacao que nao anda para, em vez de virar laco infinito com HTTP 200;
//  4. o token vem de env DA INSTALACAO e nada da Expert esta cravado no codigo;
//  5. nenhum verbo de escrita alcanca o CRM por estes arquivos.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BASE_PADRAO,
  ErroPipedrive,
  MAX_PAGINAS,
  STATUS_ETAPA_PADRAO,
  TIPOS_APROVEITAVEIS,
  avisosDaColeta,
  basePipedrive,
  coletar,
  contatoDaPessoa,
  credencialPipedrive,
  erroDaResposta,
  esperaDoLimite,
  etapasDaResposta,
  filtrosDaResposta,
  fontePipedriveDisponivel,
  paginaSeguinte,
  quantosNumeros,
  respostaOk,
  telefonesDaPessoa,
  type PortaPipedrive,
  type SelecaoPublico,
} from "../lib/disparo/pipedrive.ts";
import { chaveDedupe, normalizarTelefone, type DestinoValido } from "../lib/disparo/telefone.ts";

let checagens = 0;
const teste = (oque: string, fn: () => void | Promise<void>) => {
  const r = fn();
  if (r instanceof Promise) throw new Error("use `testeAsync` para caso assincrono");
  checagens++;
  console.log(`  ok  ${oque}`);
};
const testeAsync = async (oque: string, fn: () => Promise<void>) => {
  await fn();
  checagens++;
  console.log(`  ok  ${oque}`);
};

// ————————————————————————————————————————————————————————— fixtures SINTETICAS
//
// Nenhum dado de conta real entra aqui. A regra da casa e explicita: dado de
// conversa/CRM de cliente NUNCA vira fixture do repo. O FORMATO abaixo foi
// medido contra a API v1 em 31/08/2026 (chaves e tipos); os VALORES sao
// inventados de proposito.
const pessoa = (nome: string, tels: { value: string; label?: string; primary?: boolean }[]) => ({
  id: 1,
  name: nome,
  phone: tels.map((t) => ({ label: t.label ?? "", value: t.value, primary: t.primary === true })),
});

const respostaPagina = (itens: unknown[], proximo: number | null) => ({
  success: true,
  data: itens,
  additional_data: {
    pagination: {
      start: 0,
      limit: 500,
      more_items_in_collection: proximo !== null,
      ...(proximo !== null ? { next_start: proximo } : {}),
    },
  },
});

const SEL_PESSOAS: SelecaoPublico = { tipo: "filtro", filtro_id: 7, filtro_tipo: "people" };
const SEL_DEALS: SelecaoPublico = { tipo: "filtro", filtro_id: 2, filtro_tipo: "deals" };
const SEL_ETAPA: SelecaoPublico = { tipo: "etapa", etapa_id: 64 };

/** Porta de mentira: guarda os caminhos pedidos e devolve o roteiro. */
const portaFake = (roteiro: unknown[]) => {
  const pedidos: string[] = [];
  let i = 0;
  const porta: PortaPipedrive = async (caminho) => {
    pedidos.push(caminho);
    if (i >= roteiro.length) throw new Error(`porta chamada ${i + 1}x; o roteiro tem ${roteiro.length}`);
    return roteiro[i++];
  };
  return { porta, pedidos };
};

// ============================================ 1) CREDENCIAL DA INSTALACAO
console.log("\n1) CREDENCIAL — vem da instalacao, e sem ela a fonte NAO EXISTE");

teste("sem env nenhuma, nao ha credencial e a fonte fica invisivel", () => {
  assert.equal(credencialPipedrive({}), null);
  assert.equal(fontePipedriveDisponivel({}), false);
});

teste("env de qualquer um dos dois nomes serve (a instalacao nao configura o mesmo segredo 2x)", () => {
  assert.equal(credencialPipedrive({ PIPEDRIVE_API_TOKEN: "tok-a" }), "tok-a");
  assert.equal(credencialPipedrive({ PIPEDRIVE_API_KEY: "tok-b" }), "tok-b");
  // o nome novo vence quando os dois existem: e o que a instalacao nova configura
  assert.equal(credencialPipedrive({ PIPEDRIVE_API_TOKEN: "novo", PIPEDRIVE_API_KEY: "velho" }), "novo");
});

teste("env so com espaco NAO conta como configurada (senao a fonte aparece e todo pedido da 401)", () => {
  assert.equal(credencialPipedrive({ PIPEDRIVE_API_TOKEN: "   " }), null);
  assert.equal(fontePipedriveDisponivel({ PIPEDRIVE_API_TOKEN: "\t\n" }), false);
});

teste("base default e a API publica; base propria da empresa vale se for https limpo", () => {
  assert.equal(basePipedrive({}), BASE_PADRAO);
  assert.equal(basePipedrive({ PIPEDRIVE_API_BASE: "https://acme.pipedrive.com/api/v1/" }), "https://acme.pipedrive.com/api/v1");
});

teste("base http, com credencial embutida ou impossivel de ler cai no default (nunca sai do https)", () => {
  for (const v of ["http://acme.pipedrive.com/api/v1", "https://u:p@acme.pipedrive.com/v1", "nao-e-url", " "]) {
    assert.equal(basePipedrive({ PIPEDRIVE_API_BASE: v }), BASE_PADRAO, v);
  }
});

// ============================================ 2) CATALOGO DE FILTROS SALVOS
console.log("\n2) FILTROS SALVOS — o que entra, o que sai e o que e DECLARADO");

const CORPO_FILTROS = {
  success: true,
  data: [
    { id: 7, name: "Leads do mes", type: "people", active_flag: true, last_used_time: "2026-08-30 10:00:00" },
    { id: 2, name: "Negocios abertos", type: "deals", active_flag: true, last_used_time: "2026-08-31 09:00:00" },
    { id: 9, name: "Empresas SP", type: "org", active_flag: true },
    { id: 10, name: "Atividades atrasadas", type: "activity", active_flag: true },
    { id: 11, name: "Leads novos", type: "leads", active_flag: true },
    { id: 12, name: "Recorte de agora", type: "people", active_flag: true, temporary_flag: true },
    { id: 13, name: "Antigo", type: "people", active_flag: false },
    { id: 0, name: "id torto", type: "people", active_flag: true },
  ],
};

teste("so os tipos que rendem contato com telefone entram (people e deals)", () => {
  const c = filtrosDaResposta(CORPO_FILTROS);
  assert.deepEqual(
    c.filtros.map((f) => f.id).sort((a, b) => a - b),
    [2, 7]
  );
  assert.deepEqual([...TIPOS_APROVEITAVEIS].sort(), ["deals", "people"]);
});

teste("os tipos ignorados saem CONTADOS, nunca escondidos (senao o dono do CRM acha que o painel perdeu filtro)", () => {
  const c = filtrosDaResposta(CORPO_FILTROS);
  assert.deepEqual(c.ignorados_por_tipo, { org: 1, activity: 1, leads: 1 });
  assert.equal(c.temporarios, 1);
  assert.equal(c.inativos, 1);
});

teste("filtro TEMPORARIO fica fora: e recorte que a pessoa nao salvou, e muda sozinho", () => {
  const c = filtrosDaResposta({ success: true, data: [{ id: 5, name: "x", type: "people", temporary_flag: true }] });
  assert.equal(c.filtros.length, 0);
  assert.equal(c.temporarios, 1);
});

teste("item sem active_flag NAO desaparece por ausencia de dado (so `false` desliga)", () => {
  const c = filtrosDaResposta({ success: true, data: [{ id: 5, name: "x", type: "people" }] });
  assert.equal(c.filtros.length, 1);
  assert.equal(c.inativos, 0);
});

teste("ordem: ultimo uso primeiro; empate desempata por NOME, nunca pela ordem da API", () => {
  const c = filtrosDaResposta({
    success: true,
    data: [
      { id: 1, name: "Zebra", type: "people" },
      { id: 2, name: "Abacaxi", type: "people" },
      { id: 3, name: "Usado ontem", type: "people", last_used_time: "2026-08-30 10:00:00" },
    ],
  });
  assert.deepEqual(
    c.filtros.map((f) => f.nome),
    ["Usado ontem", "Abacaxi", "Zebra"]
  );
  // e a ordem e ESTAVEL: mesma entrada, mesma saida
  const c2 = filtrosDaResposta({
    success: true,
    data: [
      { id: 3, name: "Usado ontem", type: "people", last_used_time: "2026-08-30 10:00:00" },
      { id: 2, name: "Abacaxi", type: "people" },
      { id: 1, name: "Zebra", type: "people" },
    ],
  });
  assert.deepEqual(c.filtros.map((f) => f.nome), c2.filtros.map((f) => f.nome));
});

teste("nome vazio nao vira linha em branco na tela (cai no id)", () => {
  const c = filtrosDaResposta({ success: true, data: [{ id: 42, name: "   ", type: "people" }] });
  assert.equal(c.filtros[0].nome, "filtro 42");
});

teste("nome com quebra de linha e achatado (nome de filtro e escrito por gente do CRM)", () => {
  const c = filtrosDaResposta({ success: true, data: [{ id: 42, name: "linha1\nlinha2", type: "people" }] });
  assert.equal(c.filtros[0].nome, "linha1 linha2");
});

teste("corpo torto (nulo, sem data, data que nao e lista) devolve catalogo vazio sem lancar", () => {
  for (const c of [null, undefined, {}, { data: null }, { data: "x" }, { data: [null, 1, "a", []] }]) {
    const r = filtrosDaResposta(c);
    assert.equal(r.filtros.length, 0);
  }
});

// ============================================ 3) ETAPAS
console.log("\n3) ETAPAS — a etapa viaja SEMPRE com o funil (nome de etapa se repete)");

teste("etapa carrega funil, e a ordenacao e por funil e depois por ordem do funil", () => {
  const { etapas } = etapasDaResposta({
    success: true,
    data: [
      { id: 3, name: "Proposta", order_nr: 2, pipeline_id: 1, pipeline_name: "Comercial", active_flag: true },
      { id: 1, name: "Proposta", order_nr: 1, pipeline_id: 2, pipeline_name: "Aluno", active_flag: true },
      { id: 2, name: "Contato", order_nr: 1, pipeline_id: 1, pipeline_name: "Comercial", active_flag: true },
    ],
  });
  assert.deepEqual(
    etapas.map((e) => `${e.funil_nome}/${e.nome}`),
    ["Aluno/Proposta", "Comercial/Contato", "Comercial/Proposta"]
  );
  // o MESMO nome de etapa em dois funis: sao duas etapas, e o id e quem separa
  assert.equal(etapas.filter((e) => e.nome === "Proposta").length, 2);
  assert.notEqual(etapas[0].id, etapas[2].id);
});

teste("etapa desativada no CRM nao entra", () => {
  const { etapas } = etapasDaResposta({ success: true, data: [{ id: 1, name: "x", active_flag: false }] });
  assert.equal(etapas.length, 0);
});

// ============================================ 4) TELEFONE DA PESSOA
console.log("\n4) TELEFONE — UM por pessoa, e sempre o MESMO");

teste("o principal vence o rotulado WhatsApp, que vence a ordem de origem", () => {
  const p = pessoa("Ana", [
    { value: "5511900000001", label: "Comercial" },
    { value: "5511900000002", label: "WhatsApp" },
    { value: "5511900000003", label: "Celular", primary: true },
  ]);
  assert.deepEqual(
    telefonesDaPessoa(p).map((t) => t.valor),
    ["5511900000003", "5511900000002", "5511900000001"]
  );
  assert.equal(contatoDaPessoa(p)?.telefone, "5511900000003");
});

teste("sem principal, o rotulado WhatsApp vence (rotulo ignora caixa e acento)", () => {
  for (const label of ["WhatsApp", "whatsapp", "WHATS", "Whatsápp"]) {
    const p = pessoa("Ana", [{ value: "5511900000001", label: "Fixo" }, { value: "5511900000002", label }]);
    assert.equal(contatoDaPessoa(p)?.telefone, "5511900000002", label);
  }
});

teste("campo `phones` (v2) e lido igual a `phone` (v1) — ler o errado devolveria publico VAZIO calado", () => {
  const v2 = { id: 1, name: "Ana", phones: [{ value: "5511900000009", primary: true, label: "" }] };
  assert.equal(contatoDaPessoa(v2)?.telefone, "5511900000009");
});

teste("lista de telefones como strings soltas tambem e aceita", () => {
  assert.equal(contatoDaPessoa({ name: "Ana", phone: ["5511900000004"] })?.telefone, "5511900000004");
});

teste("pessoa sem telefone devolve null (nao vira item com telefone vazio)", () => {
  assert.equal(contatoDaPessoa(pessoa("Ana", [])), null);
  assert.equal(contatoDaPessoa({ name: "Ana", phone: [{ value: "   " }] }), null);
  assert.equal(contatoDaPessoa(null), null);
});

teste("A DECISAO: um so telefone por pessoa — dois numeros do mesmo contato virariam DUAS mensagens", () => {
  // a deduplicacao do publico e por ULTIMOS DIGITOS: numeros diferentes NAO se
  // juntam. Levar os dois faria a mesma pessoa receber a campanha 2x.
  const p = pessoa("Ana", [
    { value: "551190000001", label: "Celular", primary: true },
    { value: "551133330000", label: "Fixo" },
  ]);
  assert.equal(quantosNumeros(p), 2);
  const c = contatoDaPessoa(p);
  assert.ok(c);
  // a chave de deduplicacao do publico e por ULTIMOS DIGITOS: os dois numeros
  // desta pessoa dao chaves DIFERENTES, ou seja o `consolidar` de
  // lib/disparo/publico.ts nao os juntaria — seriam dois destinos.
  const chaves = new Set(
    p.phone.map((t) => normalizarTelefone(t.value)).filter((d) => d.ok).map((d) => chaveDedupe(d as DestinoValido))
  );
  assert.equal(chaves.size, 2, "os dois numeros passariam pela deduplicacao como destinos distintos");
});

teste("o mesmo numero repetido na pessoa conta como UM (mascara diferente nao e numero diferente)", () => {
  const p = pessoa("Ana", [{ value: "+55 (11) 90000-0001" }, { value: "5511900000001" }]);
  assert.equal(quantosNumeros(p), 1);
});

// ============================================ 5) PAGINACAO
console.log("\n5) PAGINACAO — o `next_start` da v1, e a trava contra pagina presa");

teste("more_items_in_collection false encerra, mesmo com next_start presente", () => {
  assert.equal(paginaSeguinte({ additional_data: { pagination: { more_items_in_collection: false, next_start: 500 } } }), null);
});

teste("sem o bloco de paginacao, encerra (nao assume que tem mais)", () => {
  assert.equal(paginaSeguinte({}), null);
  assert.equal(paginaSeguinte(null), null);
  assert.equal(paginaSeguinte({ additional_data: { pagination: { more_items_in_collection: true } } }), null);
});

teste("next_start valido e devolvido", () => {
  assert.equal(paginaSeguinte({ additional_data: { pagination: { more_items_in_collection: true, next_start: 500 } } }), 500);
});

// ============================================ 6) COLETA — pessoas
console.log("\n6) COLETA de filtro de PESSOAS");

await testeAsync("le as duas paginas e pede o caminho certo (persons, filter_id, start)", async () => {
  const { porta, pedidos } = portaFake([
    respostaPagina([pessoa("Ana", [{ value: "5511900000001", primary: true }])], 500),
    respostaPagina([pessoa("Bia", [{ value: "5511900000002", primary: true }])], null),
  ]);
  const c = await coletar(SEL_PESSOAS, porta, 5000);
  assert.equal(c.paginas, 2);
  assert.equal(c.lidos, 2);
  assert.deepEqual(c.brutos.map((b) => b.nome), ["Ana", "Bia"]);
  assert.match(pedidos[0], /^\/persons\?/);
  assert.match(pedidos[0], /filter_id=7/);
  assert.match(pedidos[0], /start=0/);
  assert.match(pedidos[1], /start=500/);
});

await testeAsync("contato sem telefone e CONTADO, nao silenciado", async () => {
  const { porta } = portaFake([
    respostaPagina([pessoa("Ana", []), pessoa("Bia", [{ value: "5511900000002" }])], null),
  ]);
  const c = await coletar(SEL_PESSOAS, porta, 5000);
  assert.equal(c.sem_telefone, 1);
  assert.equal(c.brutos.length, 1);
  assert.ok(avisosDaColeta(c).some((a) => a.includes("nao tem telefone")));
});

await testeAsync("pessoa com 2 numeros: entra 1 destino e o aviso DIZ isso", async () => {
  const { porta } = portaFake([
    respostaPagina([pessoa("Ana", [{ value: "5511900000001", primary: true }, { value: "5511333300001" }])], null),
  ]);
  const c = await coletar(SEL_PESSOAS, porta, 5000);
  assert.equal(c.brutos.length, 1);
  assert.equal(c.multiplos_numeros, 1);
  assert.ok(avisosDaColeta(c).some((a) => a.includes("mais de um numero")));
});

// ============================================ 7) COLETA — negocios e etapa
console.log("\n7) COLETA de NEGOCIOS (filtro e etapa)");

const deal = (titulo: string, person: unknown, nomePessoa = "") => ({
  id: 1,
  title: titulo,
  stage_id: 64,
  status: "open",
  person_name: nomePessoa,
  person_id: person,
});

await testeAsync("o telefone vem DENTRO de person_id (foi o achado que evitou 1 requisicao por deal)", async () => {
  const { porta, pedidos } = portaFake([
    respostaPagina([deal("Contrato", pessoa("Ana", [{ value: "5511900000001", primary: true }]))], null),
  ]);
  const c = await coletar(SEL_DEALS, porta, 5000);
  assert.deepEqual(c.brutos, [{ telefone: "5511900000001", nome: "Ana" }]);
  assert.match(pedidos[0], /^\/deals\?/);
  assert.equal(c.paginas, 1, "uma pagina, uma requisicao — nunca uma por deal");
});

await testeAsync("person_id como NUMERO (v2) nao e chutado: conta como contato nao resolvido", async () => {
  const { porta } = portaFake([respostaPagina([deal("Contrato", 4321, "Ana")], null)]);
  const c = await coletar(SEL_DEALS, porta, 5000);
  assert.equal(c.brutos.length, 0);
  assert.equal(c.contato_nao_resolvido, 1);
  assert.ok(avisosDaColeta(c).some((a) => a.includes("nao trouxe o contato")));
});

await testeAsync("deal sem pessoa (so empresa) tambem conta, e nao vira item vazio", async () => {
  const { porta } = portaFake([respostaPagina([deal("Contrato", null)], null)]);
  const c = await coletar(SEL_DEALS, porta, 5000);
  assert.equal(c.brutos.length, 0);
  assert.equal(c.contato_nao_resolvido, 1);
});

await testeAsync("person_name preenche o nome quando o objeto da pessoa nao traz `name`", async () => {
  const { porta } = portaFake([
    respostaPagina([deal("Contrato", { phone: [{ value: "5511900000001", primary: true }] }, "Ana do CRM")], null),
  ]);
  const c = await coletar(SEL_DEALS, porta, 5000);
  assert.equal(c.brutos[0].nome, "Ana do CRM");
});

await testeAsync("ETAPA: o status default e `open` — etapa guarda ganho e perdido, e mandar pra eles nao volta atras", async () => {
  const { porta, pedidos } = portaFake([respostaPagina([], null)]);
  await coletar(SEL_ETAPA, porta, 5000);
  assert.equal(STATUS_ETAPA_PADRAO, "open");
  assert.match(pedidos[0], /stage_id=64/);
  assert.match(pedidos[0], /status=open/);
});

await testeAsync("ETAPA com status `todos` NAO manda o parametro (e a unica forma de pedir a etapa inteira)", async () => {
  const { porta, pedidos } = portaFake([respostaPagina([], null)]);
  await coletar({ tipo: "etapa", etapa_id: 64, status: "todos" }, porta, 5000);
  assert.ok(!pedidos[0].includes("status="), pedidos[0]);
});

// ============================================ 8) FAIL-CLOSED
console.log("\n8) FAIL-CLOSED — o que NUNCA pode virar publico vazio calado");

teste("respostaOk exige success === true (nem 'true', nem 1, nem ausente)", () => {
  assert.equal(respostaOk({ success: true }), true);
  for (const c of [{ success: "true" }, { success: 1 }, { success: false }, {}, null, "ok", []]) {
    assert.equal(respostaOk(c), false, JSON.stringify(c));
  }
});

await testeAsync("GRAVE: token vencido (success false) LANCA — publico vazio silencioso faria a pessoa achar que o filtro do CRM esvaziou", async () => {
  const { porta } = portaFake([{ success: false, error: "unauthorized access", error_info: "veja a doc" }]);
  await assert.rejects(() => coletar(SEL_PESSOAS, porta, 5000), (e: unknown) => {
    assert.ok(e instanceof ErroPipedrive);
    assert.match((e as Error).message, /unauthorized access/);
    return true;
  });
});

await testeAsync("resposta que nao e JSON (null) tambem lanca, com frase legivel", async () => {
  const { porta } = portaFake([null]);
  await assert.rejects(() => coletar(SEL_PESSOAS, porta, 5000), /fora do formato esperado/);
});

await testeAsync("falha NO MEIO da paginacao lanca — nao devolve a metade lida como se fosse o publico", async () => {
  const { porta } = portaFake([
    respostaPagina([pessoa("Ana", [{ value: "5511900000001" }])], 500),
    { success: false, error: "rate limit" },
  ]);
  await assert.rejects(() => coletar(SEL_PESSOAS, porta, 5000), /rate limit/);
});

teste("erroDaResposta nunca devolve string vazia (erro sem motivo ainda tem que dizer algo)", () => {
  assert.ok(erroDaResposta({ success: false }).length > 10);
  assert.ok(erroDaResposta(null).length > 10);
});

// ============================================ 9) TETOS
console.log("\n9) TETOS — e o corte sempre DECLARADO");

await testeAsync("teto de destinos corta e diz que cortou", async () => {
  const muitos = Array.from({ length: 10 }, (_, i) => pessoa(`P${i}`, [{ value: `55119000000${i}0` }]));
  const { porta } = portaFake([respostaPagina(muitos, 500)]);
  const c = await coletar(SEL_PESSOAS, porta, 3);
  assert.equal(c.brutos.length, 3);
  assert.equal(c.truncado, true);
  assert.match(String(c.motivo_truncado), /teto de 3 destinos/);
  assert.ok(avisosDaColeta(c)[0].includes("cortado"));
});

await testeAsync("teto de paginas segura resposta que mente 'tem mais' pra sempre", async () => {
  let n = 0;
  const porta: PortaPipedrive = async () => {
    n++;
    return respostaPagina([], n * 500);
  };
  const c = await coletar(SEL_PESSOAS, porta, 5000);
  assert.equal(c.paginas, MAX_PAGINAS);
  assert.equal(c.truncado, true);
  assert.match(String(c.motivo_truncado), /paginas/);
});

await testeAsync("PAGINACAO QUE NAO ANDA para na hora (next_start <= start seria laco infinito com HTTP 200)", async () => {
  let n = 0;
  const porta: PortaPipedrive = async () => {
    n++;
    return respostaPagina([], 0); // sempre volta pro comeco
  };
  const c = await coletar(SEL_PESSOAS, porta, 5000);
  assert.equal(n, 1, "parou na primeira, nao foi ate o teto de paginas");
  assert.equal(c.truncado, true);
  assert.match(String(c.motivo_truncado), /nao avancou/);
});

await testeAsync("teto zerado nao consulta o CRM nem uma vez", async () => {
  const { porta, pedidos } = portaFake([]);
  const c = await coletar(SEL_PESSOAS, porta, 0);
  assert.equal(pedidos.length, 0);
  assert.equal(c.truncado, true);
});

// ============================================ 10) ESTABILIDADE DO DESTINO
console.log("\n10) REMONTAR O PUBLICO NAO TROCA QUEM RECEBE");

await testeAsync("a mesma resposta, em ordem diferente de telefones, escolhe o MESMO numero", async () => {
  const tels = [
    { value: "5511900000001", label: "Fixo" },
    { value: "5511900000002", label: "WhatsApp" },
    { value: "5511900000003", label: "Celular", primary: true },
  ];
  const a = await coletar(SEL_PESSOAS, portaFake([respostaPagina([pessoa("Ana", tels)], null)]).porta, 10);
  const b = await coletar(
    SEL_PESSOAS,
    portaFake([respostaPagina([pessoa("Ana", [...tels].reverse())], null)]).porta,
    10
  );
  assert.equal(a.brutos[0].telefone, b.brutos[0].telefone);
  assert.equal(a.brutos[0].telefone, "5511900000003");
});

// ============================================ 11) GUARDAS DE ARQUITETURA
console.log("\n11) GUARDAS — lidas do CODIGO, nao de lista escrita a mao");

const FONTE_PURA = readFileSync(new URL("../lib/disparo/pipedrive.ts", import.meta.url), "utf8");
const FONTE_PORTA = readFileSync(new URL("../lib/disparo/pipedrive-http.ts", import.meta.url), "utf8");
const semComentario = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

teste("lib/disparo/pipedrive.ts NAO importa nada (e o que faz esta prova rodar em node solto)", () => {
  const codigo = semComentario(FONTE_PURA);
  assert.equal(/^\s*import\s/m.test(codigo), false, "apareceu import na parte pura");
  assert.equal(/\brequire\s*\(/.test(codigo), false);
});

teste("NENHUM verbo de escrita alcanca o CRM por estes dois arquivos (montar publico e LEITURA)", () => {
  for (const [nome, fonte] of [["pipedrive.ts", FONTE_PURA], ["pipedrive-http.ts", FONTE_PORTA]] as const) {
    const codigo = semComentario(fonte);
    for (const verbo of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(
        new RegExp(`method\\s*:\\s*["'\`]${verbo}`, "i").test(codigo),
        false,
        `${nome} usa method ${verbo}`
      );
    }
  }
});

teste("NADA da Expert cravado: nem telefone, nem dominio, nem id de filtro/etapa/funil", () => {
  for (const [nome, fonte] of [["pipedrive.ts", FONTE_PURA], ["pipedrive-http.ts", FONTE_PORTA]] as const) {
    assert.equal(/55\d{10}/.test(fonte), false, `${nome} tem telefone cravado`);
    assert.equal(/expertintegrado/i.test(fonte), false, `${nome} cita a Expert`);
    assert.equal(/pipedrive\.com\/api\/v1['"]/.test(fonte) && /acme|expert/i.test(fonte), false);
  }
});

teste("o TOKEN nunca sai por retorno nem entra na mensagem de erro (URL com api_token= na tela e segredo vazado)", () => {
  const codigo = semComentario(FONTE_PORTA);
  // a URL montada nao pode aparecer dentro de nenhum `throw`/mensagem
  const trechosDeErro = codigo.match(/ErroPipedrive\([^)]*\)/g) ?? [];
  assert.ok(trechosDeErro.length >= 3, "a porta tem que distinguir credencial, limite e o resto");
  for (const t of trechosDeErro) {
    assert.equal(/\burl\b/.test(t), false, `mensagem de erro cita a url: ${t}`);
    assert.equal(/api_token/.test(t), false, `mensagem de erro cita o token: ${t}`);
  }
});

teste("a porta DRENA o corpo no caminho de erro (corpo nao lido segura socket no undici)", () => {
  assert.match(FONTE_PORTA, /body\?\.cancel\(\)/);
});

teste("a porta nao segue redirect (3xx nao leva a credencial pra outro host)", () => {
  assert.match(FONTE_PORTA, /redirect:\s*"manual"/);
});

const ROTA_PUBLICO = readFileSync(new URL("../app/api/disparo/publico/route.ts", import.meta.url), "utf8");
const ROTA_CAMPANHA = readFileSync(new URL("../app/api/disparo/route.ts", import.meta.url), "utf8");

const FONTE_PUBLICO = readFileSync(new URL("../lib/disparo/publico.ts", import.meta.url), "utf8");
const ROTA_LISTAS = readFileSync(new URL("../app/api/disparo/listas/route.ts", import.meta.url), "utf8");

teste("as rotas distinguem 400 (pedido torto), 501 (nao tem CRM aqui) e 502 (o CRM nao respondeu)", () => {
  // TRES desfechos, nao dois (achado da revisao cega): selecao invalida saia como
  // 502, mandando a pessoa conferir token e status do Pipedrive por causa de um
  // campo que faltou no PROPRIO pedido — diagnostico errado, e caro de perseguir.
  for (const [nome, fonte] of [
    ["publico", ROTA_PUBLICO],
    ["campanha", ROTA_CAMPANHA],
    ["listas", ROTA_LISTAS],
  ] as const) {
    assert.match(fonte, /pedidoInvalido[\s\S]{0,120}status:\s*400/, `${nome} sem o 400`);
    assert.match(fonte, /indisponivel[\s\S]{0,120}status:\s*501/, `${nome} sem o 501`);
    assert.match(fonte, /p\.erro[\s\S]{0,120}status:\s*502/, `${nome} sem o 502`);
    // ORDEM dentro do MESMO bloco de decisao: o 400 tem que ser avaliado antes do
    // ramo generico, senao o pedido torto volta a mentir que o CRM nao respondeu.
    // A comparacao e com o 502 QUE FICA DEPOIS do 400 (a rota do catalogo tem um
    // 502 proprio, mais acima, que nao tem nada a ver com este ramo).
    const i400 = fonte.indexOf("pedidoInvalido");
    const i502 = fonte.indexOf("status: 502", i400);
    assert.ok(i400 > 0, `${nome}: sem o ramo de pedido invalido`);
    assert.ok(i502 > i400, `${nome}: o 400 nao vem antes do 502 do mesmo bloco`);
    // e o 501 fica entre os dois
    const i501 = fonte.indexOf("status: 501", i400);
    assert.ok(i501 > i400 && i501 < i502, `${nome}: a ordem 400 -> 501 -> 502 nao esta de pe`);
  }
  // e o lado da lib: selecao invalida MARCA o pedido, em vez de sair como erro cru
  assert.match(
    FONTE_PUBLICO,
    /typeof selecao === "string"[\s\S]{0,600}pedidoInvalido: true/,
    "publicoDoPipedrive nao marca pedido invalido"
  );
});

teste("429: a espera vem do Retry-After do proprio CRM, e valor torto nao vira NaN", () => {
  assert.match(esperaDoLimite("30"), /pediu 30s/);
  assert.match(esperaDoLimite("30.4"), /pediu 31s/, "arredonda pra cima: pedir 30 e voltar aos 30,4 seria cedo");
  assert.match(esperaDoLimite(null), /alguns minutos/);
  assert.match(esperaDoLimite(""), /alguns minutos/);
  assert.match(esperaDoLimite("nao e numero"), /alguns minutos/);
  assert.equal(/NaN|Invalid/.test(esperaDoLimite("nao e numero")), false);
  assert.equal(/NaN/.test(esperaDoLimite("-5")), false);
  // forma de DATA HTTP tambem e valida na RFC 9110
  const futuro = new Date(Date.now() + 120_000).toUTCString();
  assert.match(esperaDoLimite(futuro), /pediu espera de \d+s/);
  // data no passado nao vira numero negativo
  assert.match(esperaDoLimite(new Date(Date.now() - 60_000).toUTCString()), /espera de 0s/);
});

teste("ESPERA_NAO_AUTOMATICA: a porta nao dorme e nao retenta, e isso esta escrito", () => {
  // se alguem enfiar backoff aqui, tem que ser decisao consciente — nao efeito
  // colateral. Dormir dentro do request que CRIA a campanha troca erro claro por
  // timeout de 300s.
  assert.match(FONTE_PORTA, /ESPERA_NAO_AUTOMATICA/, "a decisao nao esta registrada no arquivo");
  assert.equal(/setTimeout\([^)]*\d{4,}/.test(FONTE_PORTA.replace(/TIMEOUT_MS/g, "")), false, "nao ha sleep embutido");
  assert.equal(/for\s*\([^)]*tentativa|while\s*\(/.test(FONTE_PORTA), false, "nao ha laco de retentativa");
});

teste("a PORTA liga o cabecalho na mensagem, e le o cabecalho ANTES de drenar o corpo", () => {
  // provar so a funcao pura deixa passar o erro que importa: a porta nao chamar ela.
  assert.match(FONTE_PORTA, /esperaDoLimite\(retryApos\)/, "o 429 nao usa a espera vinda do CRM");
  const iLe = FONTE_PORTA.indexOf('r.headers.get("retry-after")');
  assert.notEqual(iLe, -1, "a porta nao le o Retry-After");
  const iDrena = FONTE_PORTA.indexOf("r.body?.cancel()");
  assert.notEqual(iDrena, -1, "a porta nao drena o corpo no caminho de erro");
  assert.ok(iLe < iDrena, "cabecalho lido DEPOIS de cancelar o corpo — em undici isso volta vazio");
  // e o 429 tem que ser um ramo proprio: cair no `respondeu ${status}` perde o tempo
  assert.match(FONTE_PORTA, /r\.status === 429/, "429 nao tem ramo proprio");
});

teste("a origem pipedrive passa pelo MESMO tirarBloqueados das outras tres (opt-out nao tem porta lateral)", () => {
  // a rota resolve o publico e SO DEPOIS chama tirarBloqueados — uma vez, pra
  // todas as origens. A guarda e por POSICAO: a chamada tem que vir depois do
  // ramo do pipedrive, senao a origem nova escaparia da lista de bloqueio.
  for (const [nome, fonte] of [["publico", ROTA_PUBLICO], ["campanha", ROTA_CAMPANHA]] as const) {
    const iPd = fonte.indexOf("publicoDoPipedrive(");
    const iBloq = fonte.lastIndexOf("tirarBloqueados(");
    assert.ok(iPd > 0, `${nome} nao usa a origem pipedrive`);
    assert.ok(iBloq > iPd, `${nome}: tirarBloqueados nao vem depois do ramo do pipedrive`);
  }
});

teste("o GET do catalogo responde 200 com disponivel:false quando falta credencial (a tela esconde, nao mostra botao que falha)", () => {
  const i = ROTA_PUBLICO.indexOf("disponivel: false");
  assert.ok(i > 0, "a rota nao declara a fonte indisponivel");
  // nao ha status de erro na mesma resposta
  const trecho = ROTA_PUBLICO.slice(i, i + 500);
  assert.equal(/status:\s*(4|5)\d\d/.test(trecho), false, "indisponibilidade nao e erro HTTP");
});

console.log(
  `\nTUDO OK — ${checagens} checagens. Nenhuma rede tocada, nenhum banco tocado, nenhum dado de conta real no repo.`
);
