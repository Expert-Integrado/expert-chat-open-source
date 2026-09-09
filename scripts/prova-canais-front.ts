// Prova das funcoes puras da lista unica multi-canal (lib/canais-front.ts).
// Roda em Node >= 22.6 sem build: `node scripts/prova-canais-front.ts`
// (type stripping nativo; o `import type` da lib e apagado, nao precisa do alias @/).
import assert from "node:assert/strict";
import {
  acharChat, agruparPorCanal, canaisParaCarregar, chaveChat, filtrarPorCanal,
  gruposDoSeletor, juntarChats, rotuloDoCanal,
} from "../lib/canais-front.ts";

type C = { chat_id: string; last_message_at: string | null; nome: string };
const canais = [
  { id: "central", rotulo: "Principal", dono: "empresa" as const },
  { id: "apioficial", rotulo: "API Oficial", dono: "empresa" as const },
  { id: "testador", rotulo: "Testador", dono: "empresa" as const },
  { id: "ig_pessoal", rotulo: "@perfil", dono: "pessoal" as const },
];

// 1) chave composta
assert.equal(chaveChat("central", "5511999"), "central:5511999");

// 2) quais canais buscar
assert.deepEqual(canaisParaCarregar([], false), ["central"], "antes da 1a resposta so o central");
assert.deepEqual(canaisParaCarregar(canais, false), ["central", "apioficial", "testador", "ig_pessoal"]);
assert.deepEqual(canaisParaCarregar(canais, true), ["central"], "embed fica so no central");

// 3) juntar: mesmo telefone em 2 canais NAO colide; ordem por ultima mensagem entre canais
const central: C[] = [
  { chat_id: "5511999", last_message_at: "2026-08-28T10:00:00Z", nome: "Ana (central)" },
  { chat_id: "5511111", last_message_at: null, nome: "Sem data" },
];
const oficial: C[] = [
  { chat_id: "5511999", last_message_at: "2026-08-28T12:00:00Z", nome: "Ana (oficial)" },
  { chat_id: "5511222", last_message_at: "2026-08-28T11:00:00Z", nome: "Bia" },
];
const juntos = juntarChats([{ canal: "central", chats: central }, { canal: "apioficial", chats: oficial }]);
assert.equal(juntos.length, 4);
assert.deepEqual(juntos.map((c) => c.uid), [
  "apioficial:5511999", "apioficial:5511222", "central:5511999", "central:5511111",
], "ordem: mais recente primeiro, sem data por ultimo");
assert.equal(new Set(juntos.map((c) => c.uid)).size, 4, "uids unicos mesmo com chat_id repetido");
assert.equal(juntos.filter((c) => c.chat_id === "5511999").length, 2, "os 2 registros da Ana sobrevivem");
assert.equal(juntos[0].canal, "apioficial");
assert.equal(juntos[0].nome, "Ana (oficial)", "campos originais preservados");

// 4) filtro por canal ("" = todos)
assert.equal(filtrarPorCanal(juntos, "").length, 4);
assert.deepEqual(filtrarPorCanal(juntos, "central").map((c) => c.uid), ["central:5511999", "central:5511111"]);
assert.equal(filtrarPorCanal(juntos, "inexistente").length, 0);

// 5) acao em massa agrupa por canal e ignora uid que sumiu da lista
const grupos = agruparPorCanal(juntos, ["central:5511999", "apioficial:5511999", "apioficial:5511222", "central:fantasma"]);
assert.deepEqual(
  grupos.sort((a, b) => a.canal.localeCompare(b.canal)),
  [
    { canal: "apioficial", chat_ids: ["5511999", "5511222"] },
    { canal: "central", chat_ids: ["5511999"] },
  ]
);
assert.deepEqual(agruparPorCanal(juntos, []), []);

// 6) rotulo
assert.equal(rotuloDoCanal(canais, "apioficial"), "API Oficial");
assert.equal(rotuloDoCanal(canais, "desconhecido"), "desconhecido", "sem registro cai no id");

// 7) seletor agrupado por dono
const g = gruposDoSeletor(canais);
assert.deepEqual(g.empresa.map((c) => c.id), ["central", "apioficial", "testador"]);
assert.deepEqual(g.pessoal.map((c) => c.id), ["ig_pessoal"]);

// 8) achar pela identidade composta / preferencia
assert.equal(acharChat(juntos, "5511999", "central")?.nome, "Ana (central)");
assert.equal(acharChat(juntos, "5511999", "apioficial")?.nome, "Ana (oficial)");
assert.equal(acharChat(juntos, "5511999", null, "central")?.nome, "Ana (central)", "sem canal: prefere o preferido");
assert.equal(acharChat(juntos, "5511999", null, "testador")?.nome, "Ana (oficial)", "preferido sem match: 1a da lista");
assert.equal(acharChat(juntos, "5511999")?.nome, "Ana (oficial)", "sem canal nem preferido: 1a da lista");
assert.equal(acharChat(juntos, "5511222", "central"), undefined, "canal errado nao acha");
assert.equal(acharChat(juntos, "nada"), undefined);

console.log("prova-canais-front: 8 blocos, todas as assercoes OK");
