// Prova das REACOES A MENSAGEM (03/09/2026) — pedido do Eric: "nao tem botao de
// reagir nas mensagens. Tem q ter. Igual no WhatsApp".
//
// Roda em Node >= 22.6 sem build: `node --experimental-strip-types scripts/prova-reacoes.ts`.
//
// O QUE COBRE: a regra pura de lib/reacoes.ts (o que e uma reacao valida, quais
// canais suportam, o corpo que vai pro provedor, a aplicacao otimista na lista e
// o portao `podeReagir`), a leitura PURA da reacao recebida pela API oficial
// (lib/gupshup-inbound.ts) e uma varredura LOAD-BEARING das superficies que
// consomem isso (rota, tela, clientes dos provedores e as duas portas de entrada
// da API oficial): a decisao mora na lib, mas se a rota deixar de chamar o
// portao de escopo ou a tela deixar de usar `podeReagir`, a bateria tem que cair.
//
// O QUE NAO COBRE (declarado): o React de app/home.tsx e a rota com Next/Postgres —
// isso e o H14 de scripts/homologacao/homologar.py, em producao.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REACOES_RAPIDAS,
  TETO_REACAO,
  aplicarReacao,
  contarGrafemas,
  corpoReacaoEvolution,
  corpoReacaoZapi,
  motivoSemReacao,
  podeReagir,
  reacaoGravada,
  suportaReacao,
  validarReacao,
} from "../lib/reacoes.ts";
import { parseEvento, reacoesDoEvento } from "../lib/gupshup-inbound.ts";

let blocos = 0;
function bloco(nome: string, fn: () => void) {
  try {
    fn();
    blocos++;
    console.log("ok -", nome);
  } catch (e) {
    console.error("FALHOU -", nome);
    throw e;
  }
}

// so as linhas que nao sao comentario: presenca em comentario nao conta
function linhasVivas(caminho: string): string {
  const src = readFileSync(new URL(`../${caminho}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

bloco("reacoes rapidas: 6 emojis distintos, todos validos", () => {
  assert.equal(REACOES_RAPIDAS.length, 6);
  assert.equal(new Set(REACOES_RAPIDAS).size, 6);
  for (const e of REACOES_RAPIDAS) {
    const v = validarReacao(e);
    assert.equal(v.ok, true, `rapida ${e} tem que ser valida`);
    if (v.ok) assert.equal(v.emoji, e);
  }
});

bloco("contarGrafemas: emoji composto e UM", () => {
  assert.equal(contarGrafemas("👍"), 1);
  assert.equal(contarGrafemas("👍🏽"), 1);
  assert.equal(contarGrafemas("❤️"), 1);
  assert.equal(contarGrafemas("👍👍"), 2);
  assert.equal(contarGrafemas("ab"), 2);
});

bloco("validarReacao aceita um emoji so (inclusive composto) e vazio remove", () => {
  for (const e of ["👍", "❤️", "👍🏽", "🙏", "😂"]) {
    assert.deepEqual(validarReacao(e), { ok: true, emoji: e });
  }
  assert.deepEqual(validarReacao(" 🙏 "), { ok: true, emoji: "🙏" });
  assert.deepEqual(validarReacao(""), { ok: true, emoji: "" });
  assert.deepEqual(validarReacao("   "), { ok: true, emoji: "" });
});

bloco("validarReacao recusa o que nao e UM emoji", () => {
  const ruins: unknown[] = ["👍👍", "a", "ok", "1", "<script>", "👍 legal", "x".repeat(50), null, undefined, 5, {}, []];
  for (const r of ruins) {
    const v = validarReacao(r);
    assert.equal(v.ok, false, `tinha que recusar ${JSON.stringify(r)}`);
    if (!v.ok) assert.ok(v.erro.length > 10);
  }
  // um grafema so, mas gigante (modificador repetido): o teto barra
  const gigante = "👍" + "\u{1F3FD}".repeat(8);
  assert.ok(gigante.length > TETO_REACAO);
  assert.equal(validarReacao(gigante).ok, false);
});

bloco("reacaoGravada: vazio vira null, emoji fica", () => {
  assert.equal(reacaoGravada(""), null);
  assert.equal(reacaoGravada("👍"), "👍");
});

bloco("suportaReacao: Z-API e Evolution sim; Gupshup e externa nao, com motivo", () => {
  assert.equal(suportaReacao("zapi"), true);
  assert.equal(suportaReacao("evolution"), true);
  assert.equal(suportaReacao("gupshup"), false);
  assert.equal(suportaReacao("instagram-agent"), false);
  assert.equal(suportaReacao("whatsapp-agent"), true, "reage pela tool react da mcp-api do agente");
  assert.equal(suportaReacao(""), false);
  assert.equal(suportaReacao(undefined), false);
  assert.match(motivoSemReacao("gupshup"), /API oficial/);
  assert.match(motivoSemReacao("instagram-agent"), /somente leitura/);
  assert.ok(motivoSemReacao("qualquer").length > 10);
  assert.notEqual(motivoSemReacao("gupshup"), motivoSemReacao("instagram-agent"));
});

bloco("corpo Z-API: {phone, messageId, reaction} — o contrato do whatsapp-agent em producao", () => {
  assert.deepEqual(corpoReacaoZapi("5511000000902", "3EB0X", "👍"), { phone: "5511000000902", messageId: "3EB0X", reaction: "👍" });
  // string vazia REMOVE: tem que viajar como "", nunca virar undefined/null
  assert.deepEqual(corpoReacaoZapi("5511000000902", "3EB0X", ""), { phone: "5511000000902", messageId: "3EB0X", reaction: "" });
});

bloco("corpo Evolution: key {remoteJid, fromMe, id} + reaction", () => {
  assert.deepEqual(corpoReacaoEvolution("5511000000902@s.whatsapp.net", "3EB0X", false, "❤️"), {
    key: { remoteJid: "5511000000902@s.whatsapp.net", fromMe: false, id: "3EB0X" },
    reaction: "❤️",
  });
  assert.deepEqual(corpoReacaoEvolution("5511000000902@s.whatsapp.net", "3EB0Y", true, ""), {
    key: { remoteJid: "5511000000902@s.whatsapp.net", fromMe: true, id: "3EB0Y" },
    reaction: "",
  });
});

bloco("aplicarReacao: troca so a mensagem alvo, nao muta a lista, vazio limpa", () => {
  const lista = [
    { id: "a", reacao: null as string | null, content: "x" },
    { id: "b", reacao: "👍" as string | null, content: "y" },
  ];
  const congelada = JSON.stringify(lista);
  const r1 = aplicarReacao(lista, "a", "❤️");
  assert.equal(r1[0].reacao, "❤️");
  assert.equal(r1[1].reacao, "👍");
  assert.equal(r1[0].content, "x");
  const r2 = aplicarReacao(lista, "b", "");
  assert.equal(r2[1].reacao, null);
  assert.equal(JSON.stringify(lista), congelada, "lista original nao pode mudar");
  assert.notEqual(r1, lista);
  assert.deepEqual(aplicarReacao(lista, "zzz", "👍"), lista);
});

bloco("podeReagir: portao fail-closed", () => {
  const ok = { provider_msg_id: "3EB0X", is_deleted: false, interna: false, direcao: "in" };
  assert.equal(podeReagir("zapi", ok), true);
  assert.equal(podeReagir("evolution", { ...ok, direcao: "out" }), true);
  assert.equal(podeReagir("gupshup", ok), false);
  assert.equal(podeReagir("instagram-agent", ok), false);
  assert.equal(podeReagir("zapi", { ...ok, provider_msg_id: null }), false);
  assert.equal(podeReagir("zapi", { ...ok, provider_msg_id: "" }), false);
  assert.equal(podeReagir("zapi", { ...ok, is_deleted: true }), false);
  assert.equal(podeReagir("zapi", { ...ok, interna: true }), false);
  assert.equal(podeReagir("zapi", { ...ok, direcao: "interna" }), false);
  assert.equal(podeReagir("zapi", {}), false);
});

bloco("API oficial: reacao recebida aplica no alvo e NAO vira mensagem", () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: "5511000000902", profile: { name: "Homolog" } }],
              messages: [
                { from: "5511000000902", id: "wamid.TXT", timestamp: "1756900000", type: "text", text: { body: "oi" } },
                { from: "5511000000902", id: "wamid.R1", timestamp: "1756900001", type: "reaction", reaction: { message_id: "wamid.ALVO", emoji: "❤️" } },
              ],
            },
          },
        ],
      },
    ],
  };
  const msgs = parseEvento(payload);
  assert.equal(msgs.length, 1, "a reacao nao pode virar linha de mensagem");
  assert.equal(msgs[0].wamid, "wamid.TXT");
  assert.deepEqual(reacoesDoEvento(payload), [{ alvo: "wamid.ALVO", emoji: "❤️" }]);
  // remocao: a Meta manda reaction SEM emoji
  const remocao = { entry: [{ changes: [{ value: { messages: [{ from: "5511000000902", id: "wamid.R2", type: "reaction", reaction: { message_id: "wamid.ALVO" } }] } }] }] };
  assert.deepEqual(reacoesDoEvento(remocao), [{ alvo: "wamid.ALVO", emoji: null }]);
  assert.equal(parseEvento(remocao).length, 0);
  // reacao sem alvo e lixo: ignorada, nao estoura
  const semAlvo = { entry: [{ changes: [{ value: { messages: [{ from: "5511000000902", id: "wamid.R3", type: "reaction", reaction: { emoji: "👍" } }] } }] }] };
  assert.deepEqual(reacoesDoEvento(semAlvo), []);
  assert.deepEqual(reacoesDoEvento(null), []);
  assert.deepEqual(reacoesDoEvento({ type: "message", payload: {} }), []);
});

bloco("varredura load-bearing: a rota passa pelos portoes", () => {
  const rota = linhasVivas("app/api/mensagem/reacao/route.ts");
  for (const trecho of [
    "getUser(req)",
    "restricaoEfetiva(",
    "validarReacao(",
    "podeVerConversa(",
    "emb.permite(",
    'permitido(perfil, "enviar")',
    "suportaReacao(",
    "podeReagir(",
    "reacaoGravada(",
    "msgDb()",
  ]) {
    assert.ok(rota.includes(trecho), `rota sem ${trecho}`);
  }
  assert.ok(!/select\s*\*/i.test(rota), "rota nao pode fazer select *");
  // a ordem importa: escopo ANTES de dizer se o canal suporta (nao vazar existencia)
  assert.ok(rota.indexOf("podeVerConversa(") < rota.indexOf("suportaReacao(def.fonte)"));
});

bloco("varredura load-bearing: a tela usa o portao e a barra", () => {
  const tela = linhasVivas("app/home.tsx");
  for (const trecho of [
    "podeReagir(",
    "REACOES_RAPIDAS.map(",
    '"/api/mensagem/reacao"',
    'title="Reagir"',
    'title="Remover reacao"',
    'aria-label="Reagir a esta mensagem"',
    "aplicarReacao(",
  ]) {
    assert.ok(tela.includes(trecho), `tela sem ${trecho}`);
  }
});

bloco("varredura: as duas portas da API oficial aplicam a reacao recebida", () => {
  assert.ok(linhasVivas("app/api/webhook/route.ts").includes("reacoesDoEvento("), "webhook sem reacoesDoEvento");
  assert.ok(linhasVivas("lib/sync-apioficial.ts").includes("reacoesDoEvento("), "sync apioficial sem reacoesDoEvento");
});

bloco("varredura: os clientes dos provedores montam o corpo pela lib", () => {
  const zapi = linhasVivas("lib/zapi.ts");
  assert.ok(zapi.includes("corpoReacaoZapi("));
  assert.ok(zapi.includes('"send-reaction"'));
  const evo = linhasVivas("lib/evolution.ts");
  assert.ok(evo.includes("corpoReacaoEvolution("));
  assert.ok(evo.includes('"message/sendReaction"'));
});

console.log(`prova-reacoes: ${blocos} blocos OK`);
