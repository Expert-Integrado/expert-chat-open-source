// FIO DE PENDENCIA — ESTA PROVA REPROVA DE PROPOSITO. NAO E BATERIA QUEBRADA.
//
//   node scripts/prova-pendencia-z-imagem.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// POR QUE ELA EXISTE
// ═══════════════════════════════════════════════════════════════════════════
//
// GRAVE 1 da 1a revisao cega da Frente Y: **template de IMAGEM sem arte**.
// Template com `cabecalho: "IMAGE"` e `midia_url` vazio no espelho do numero sai
// pro Gupshup SEM o `message` da imagem (`corpoEnvioTemplate` so o inclui quando
// ha link). O Gupshup responde 202 com `messageId`, `lerRespostaEnvio` conta como
// sucesso, `/api/send` devolve `{"ok":true}`, o painel escreve "enviado" — e a
// Meta dropa a entrega em silencio. Ninguem ve nada vermelho em lugar nenhum.
//
// O caso fecha NA RAIZ, dentro de `podeEnviarTemplate` (`lib/templates-oficial.ts`),
// que e a mesma funcao que a rota `/api/send` e o seletor da tela consultam — uma
// regra, um lugar. Esse fechamento e da **frente Z** (branch
// `frente-z-template-params`, commit `95315f1`) e **ainda nao esta mergeado nesta
// arvore**: aqui `podeEnviarTemplate` NAO tem a regra da imagem, entao o caso
// segue passando — o seletor oferece o template, a tela nao ve motivo pra barrar
// (`motivoDeNaoEnviar` devolve `null`, porque ela so TRADUZ a raiz) e o envio vai.
//
// A prova da tela (`scripts/prova-costuras-y.ts`, secao 7) cobra a DELEGACAO
// (a tela concorda com a raiz caso a caso), e isso e deliberado — fixar a frase
// da imagem la amarraria a tela a UMA versao da regra e quebraria no merge. Mas a
// delegacao, POR CONSTRUCAO, nunca detecta que a raiz esta sem a regra: as duas
// pontas concordam que da pra enviar, e a bateria fica verde com o GRAVE aberto.
// Foi exatamente o que a re-revisao cega mediu.
//
// ENTAO ESTE ARQUIVO E O FIO QUE ESTOURA ENQUANTO ISSO. Ele reprova, com exit 1,
// enquanto `podeEnviarTemplate` nao recusar o template de imagem sem arte. Ele
// fica VERDE sozinho no dia em que a frente Z entrar — sem editar uma linha daqui
// — e a partir dai vira a guarda permanente da regra.
//
// NAO AFROUXE E NAO REMOVA. Ela e o unico impedimento a este GRAVE ir pra
// producao por esquecimento no merge.
import assert from "node:assert/strict";
import {
  contarVariaveis,
  corpoEnvioTemplate,
  podeEnviarTemplate,
  type TemplateCanal,
} from "../lib/templates-oficial.ts";

function template(corpo: string, p: Partial<TemplateCanal> = {}): TemplateCanal {
  return {
    provider_id: "prov-1",
    nome: "aviso_consulta",
    idioma: "pt_BR",
    categoria: "UTILITY",
    status: "aprovado",
    corpo,
    exemplo: "",
    variaveis: contarVariaveis(corpo),
    rodape: "",
    cabecalho: "",
    midia_url: "",
    motivo: "",
    ...p,
  };
}

const semArte = template("Ola {{1}}", { nome: "promo_agosto", cabecalho: "IMAGE", midia_url: "" });
const comArte = template("Ola {{1}}", {
  nome: "promo_agosto_ok",
  cabecalho: "IMAGE",
  midia_url: "https://cdn.exemplo/promo.png",
});

// ─── 1) O DANO, medido aqui e agora (isto NAO depende da frente Z).
//
// O corpo que sai pro provedor com o template sem arte nao tem imagem nenhuma:
// e um template de IMAGEM viajando sem o `message`. E o mesmo corpo com arte tem.
// Se algum dia isto deixar de valer, a premissa inteira do fio mudou.
{
  const cfg = { source: "5511999999999", appName: "expert" };
  const enviado = corpoEnvioTemplate(cfg, "5511888888888", semArte, ["Eric"]);
  assert.equal(
    enviado.has("message"),
    false,
    "o corpo do template de imagem SEM arte sai sem imagem (o dano que a raiz tem que barrar)"
  );
  const enviadoOk = corpoEnvioTemplate(cfg, "5511888888888", comArte, ["Eric"]);
  assert.equal(enviadoOk.has("message"), true, "e com arte a imagem vai junto");
  console.log("ok  o dano esta medido: template de IMAGEM sem arte sai sem imagem");
}

// ─── 2) A REGRA LARGA DEMAIS TAMBEM E DEFEITO.
//
// Barrar TODO template de imagem mataria o caso de uso; esta asserção ja passa
// hoje e continua valendo depois do merge da Z.
assert.equal(
  podeEnviarTemplate(comArte).ok,
  true,
  "template de IMAGEM COM arte continua liberado (a regra nao pode ser larga demais)"
);
console.log("ok  template de imagem COM arte continua liberado");

// ─── 3) O FIO.
const veredito = podeEnviarTemplate(semArte);
if (veredito.ok) {
  console.error("");
  console.error("════════════════════════════════════════════════════════════════════");
  console.error("REPROVA DE PROPOSITO — ISTO NAO E BATERIA QUEBRADA.");
  console.error("════════════════════════════════════════════════════════════════════");
  console.error("");
  console.error("`podeEnviarTemplate` (lib/templates-oficial.ts) AINDA LIBERA o template");
  console.error('com cabecalho IMAGE e `midia_url` vazio ("promo_agosto"): ele entra no');
  console.error("seletor, a tela nao acha motivo pra barrar, /api/send responde ok:true,");
  console.error("o corpo sai SEM imagem e a Meta dropa a entrega em silencio.");
  console.error("");
  console.error("O fechamento e da FRENTE Z, na raiz — branch `frente-z-template-params`,");
  console.error("commit 95315f1 —, que NAO esta mergeada nesta arvore.");
  console.error("");
  console.error("COMO ISTO FICA VERDE: mergeando a frente Z. Nenhuma linha desta prova");
  console.error("precisa mudar. NAO afrouxe e NAO remova este arquivo pra fechar a");
  console.error("bateria: ele e o que impede o GRAVE de ir pra producao por esquecimento.");
  console.error("");
  process.exit(1);
}

assert.equal(veredito.ok, false, "a raiz recusa o template de imagem sem arte");
assert.equal(
  typeof veredito.motivo === "string" && veredito.motivo.trim().length > 10,
  true,
  "e recusa com motivo legivel (a frase e da frente Z; aqui so se cobra que exista)"
);
console.log("ok  a raiz recusa o template de IMAGEM sem arte — a frente Z entrou");
console.log("prova-pendencia-z-imagem: OK (5 checagens) — fio da frente Z FECHADO");
