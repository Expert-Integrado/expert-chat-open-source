// Prova de lib/lista-conversas.ts (puro, node solto) + guardas de FONTE sobre a
// rota e a tela, pra busca/paginacao no acervo nao voltar a ser "600 e acabou".
//   node --experimental-strip-types scripts/prova-lista-conversas.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  adicionarExtras,
  criteriosDeBusca,
  cursorAntes,
  cursorMaisAntigo,
  digitosDe,
  manterExtras,
  normalizarLimite,
  padraoIlike,
  BUSCA_MAX,
  PAGINA_MAX,
  PAGINA_MIN,
  PAGINA_PADRAO,
} from "../lib/lista-conversas.ts";

let n = 0;
function t(nome: string, fn: () => void) {
  fn();
  n++;
}
const ler = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// ─── limites
t("limite: default 600, clamp 50..600, lixo vira default", () => {
  assert.equal(PAGINA_PADRAO, 600);
  assert.equal(normalizarLimite(undefined), 600);
  assert.equal(normalizarLimite("abc"), 600);
  assert.equal(normalizarLimite(10), PAGINA_MIN);
  assert.equal(normalizarLimite(5000), PAGINA_MAX);
  assert.equal(normalizarLimite("300"), 300);
  assert.equal(BUSCA_MAX <= PAGINA_MAX, true);
});

// ─── busca
t("digitos: mascara, espaco e +55 caem fora", () => {
  assert.equal(digitosDe("+55 (11) 9 0000-0000"), "5511900000000");
  assert.equal(digitosDe("Maria"), "");
});
t("padrao ilike escapa os coringas do proprio texto (input do usuario nao vira coringa)", () => {
  assert.equal(padraoIlike("maria"), "%maria%");
  assert.equal(padraoIlike("100%"), "%100\\%%");
  assert.equal(padraoIlike("a_b"), "%a\\_b%");
  assert.equal(padraoIlike("c\\d"), "%c\\\\d%");
});
t("criterios: texto curto nao vai ao acervo; nome sempre; digitos so com >= 3", () => {
  assert.equal(criteriosDeBusca(""), null);
  assert.equal(criteriosDeBusca(" a "), null);
  assert.deepEqual(criteriosDeBusca("Maria"), { nome: "%maria%", digitos: null });
  assert.deepEqual(criteriosDeBusca("11 9"), { nome: "%11 9%", digitos: "119" });
  assert.deepEqual(criteriosDeBusca("12"), { nome: "%12%", digitos: null }, "2 digitos = so nome (mesma regra da tela)");
});
t("criterios espelham conversaBateBusca da tela (nome contem OU >= 3 digitos contidos)", () => {
  const home = ler("app/home.tsx");
  assert.match(home, /digitos\.length >= 3 && c\.chat_id\.replace\(\/\\D\/g, ""\)\.includes\(digitos\)/);
});

// ─── cursor
t("cursor antes: ISO valido normalizado, lixo ignorado", () => {
  assert.equal(cursorAntes(null), null);
  assert.equal(cursorAntes("ontem"), null);
  assert.equal(cursorAntes("2026-06-29T13:09:00.000Z"), "2026-06-29T13:09:00.000Z");
  assert.equal(cursorAntes("2026-06-29T13:09:00+00:00"), "2026-06-29T13:09:00.000Z");
});
t("cursor mais antigo por canal ignora sem data e outros canais", () => {
  const lista = [
    { canal: "central", last_message_at: "2026-08-01T00:00:00.000Z" },
    { canal: "central", last_message_at: "2026-07-01T00:00:00.000Z" },
    { canal: "central", last_message_at: null },
    { canal: "apioficial", last_message_at: "2026-01-01T00:00:00.000Z" },
  ];
  assert.equal(cursorMaisAntigo(lista, "central"), "2026-07-01T00:00:00.000Z");
  assert.equal(cursorMaisAntigo(lista, "apioficial"), "2026-01-01T00:00:00.000Z");
  assert.equal(cursorMaisAntigo(lista, "ig"), null);
  assert.equal(cursorMaisAntigo([{ canal: "central", last_message_at: null }], "central"), null);
});

// ─── mescla poll x extras
const c = (uid: string, at: string | null, extra: Record<string, unknown> = {}) => ({ uid, last_message_at: at, ...extra });
t("manterExtras: a cabeca vence, extras fora da cabeca sobrevivem, nao-extras somem", () => {
  const cabeca = [c("central:1", "2026-09-01T00:00:00Z", { v: "novo" }), c("central:2", "2026-08-30T00:00:00Z")];
  const anterior = [
    c("central:1", "2026-08-31T00:00:00Z", { v: "velho" }), // na cabeca: a copia nova vence
    c("central:9", "2026-01-01T00:00:00Z"), // pagina antiga puxada: fica
    c("central:7", "2026-05-01T00:00:00Z"), // saiu da janela do poll e NAO e extra: some
  ];
  const r = manterExtras(cabeca, anterior, new Set(["central:9"]));
  assert.deepEqual(r.map((x) => x.uid), ["central:1", "central:2", "central:9"]);
  assert.equal((r[0] as any).v, "novo");
});
t("manterExtras: sem extras e igual a cabeca (comportamento antigo do poll)", () => {
  const cabeca = [c("a", "2"), c("b", "1")];
  assert.deepEqual(manterExtras(cabeca, [c("z", "9")], new Set()), cabeca);
});
t("adicionarExtras: junta sem duplicar (o que chegou vence) e ordena pela data", () => {
  const atual = [c("a", "2026-09-01T00:00:00Z"), c("b", "2026-08-01T00:00:00Z", { v: "velho" })];
  const novos = [c("b", "2026-08-01T00:00:00Z", { v: "novo" }), c("c", "2026-01-01T00:00:00Z")];
  const r = adicionarExtras(atual, novos);
  assert.deepEqual(r.map((x) => x.uid), ["a", "b", "c"]);
  assert.equal((r[1] as any).v, "novo");
});

// ─── guardas de FONTE: a rota e a tela USAM isto (helper sem consumidor e enfeite)
t("a rota /api/chats le q/antes/limite pelo modulo e devolve tem_mais", () => {
  const rota = ler("app/api/chats/route.ts");
  assert.match(rota, /criteriosDeBusca\(req\.nextUrl\.searchParams\.get\("q"\)\)/);
  assert.match(rota, /cursorAntes\(req\.nextUrl\.searchParams\.get\("antes"\)\)/);
  assert.match(rota, /normalizarLimite\(/);
  assert.match(rota, /tem_mais: temMais/);
  assert.doesNotMatch(rota, /\.limit\(600\)/, "o 600 fixo saiu: o limite vem do modulo");
  assert.match(rota, /\.ilike\("nome", busca\.nome!\)/, "busca por nome usa o padrao ESCAPADO");
  assert.match(rota, /\.like\("chat_id", `%\$\{busca\.digitos\}%`\)/, "busca por numero usa so os digitos");
  const trechoBusca = rota.slice(rota.indexOf("const consulta = "), rota.indexOf("const [convRes, msgRes]"));
  assert.equal(trechoBusca.length > 200, true, "achei o trecho da consulta de conversas");
  assert.doesNotMatch(trechoBusca, /\.or\(/, "sem .or() montado por string com texto do usuario na consulta de conversas");
  assert.match(rota, /q\.lt\("last_message_at", antes\)/, "a pagina antiga e 'mais antiga que o cursor'");
});
t("a tela preserva extras no poll, busca no acervo e oferece 'mais antigas'", () => {
  const home = ler("app/home.tsx");
  assert.match(home, /manterExtras\(\s*juntarChats\(/, "o poll passa por manterExtras");
  assert.match(home, /adicionarExtras\(/);
  assert.match(home, /cursorMaisAntigo\(/);
  assert.match(home, /criteriosDeBusca\(filter\)/, "a busca no acervo obedece ao MESMO criterio da rota");
  assert.match(home, /Carregar conversas mais antigas/);
  assert.match(home, /Nenhuma conversa com esse nome ou numero\./, "lista vazia por busca nao finge 'carregando'");
  assert.match(home, /encodeURIComponent\(filter\)/, "o texto vai codificado na URL");
});
t("o MCP manda a busca pro servidor (varre o acervo, nao so as 600)", () => {
  let mcp = "";
  try {
    mcp = readFileSync("../expert-chat-mcp/index.js", "utf8");
  } catch {
    return; // repo irmao ausente nesta maquina: nada a cobrar aqui
  }
  assert.match(mcp, /query: busca \? \{ canal, q: busca \} : \{ canal \}/);
});

console.log(`prova-lista-conversas: ${n} casos OK`);
