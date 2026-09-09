// Prova da TRANSCRICAO DE AUDIO (o gancho) — card 86ak85ny7.
// Roda em Node >= 22.6 sem build: `node scripts/prova-transcricao.ts`
//
// O que esta prova garante, em uma linha cada:
//   - sem servico configurado o recurso e INVISIVEL (e nada e chamado);
//   - a chave NUNCA vem do banco, so de env — a config sozinha nao consegue
//     fazer o painel comecar a chamar um servico pago;
//   - a config CONSEGUE desligar (kill switch sem deploy);
//   - a anotacao sai no formato EXATO da origem, com o fuso da instalacao;
//   - a nota e assinada como automacao (convencao 0006: id NULL + nome);
//   - a leitura da resposta e tolerante (o servico e o que o CLIENTE contratou);
//   - resposta sem texto NAO vira nota vazia;
//   - nenhuma linha do produto embute fornecedor, url default ou chave.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AUTOR_TRANSCRICAO, corpoDaChamada, dataDaNota, disponivel, linhaDaNota,
  motivoParaNaoTranscrever, normalizarHora24, prefixoDaNota, resolverConfig, textoDaNota, textoDaResposta,
  textoDoCorpo, TIPOS_DE_AUDIO, urlDeServicoValida, validarConfigDeBanco, LIMITE_TEXTO_TRANSCRICAO, TIMEOUT_MS,
} from "../lib/transcricao.ts";
import { urlAceita } from "../lib/webhooks-saida.ts";

let feitos = 0;
const t = (nome: string, fn: () => void) => {
  fn();
  feitos++;
  console.log(`  ok  ${nome}`);
};
/** o mesmo, para caso assincrono — com `await` no ponto de chamada, senao a
 *  assercao resolveria DEPOIS de a prova imprimir "ok" (verde mentiroso). */
const ta = async (nome: string, fn: () => Promise<void>) => {
  await fn();
  feitos++;
  console.log(`  ok  ${nome}`);
};

const ENV_OK = { TRANSCRICAO_URL: "https://transcricao.do-cliente.com/v1", TRANSCRICAO_CHAVE: "k-do-cliente" };
const SRC_LIB_TOPO = readFileSync(new URL("../lib/transcricao.ts", import.meta.url), "utf8");

// ======================================== 1) NADA CONFIGURADO = INVISIVEL
console.log("\n1) sem servico configurado, o recurso e invisivel");

t("instalacao sem env nenhuma: indisponivel (e nao ha default nosso)", () => {
  const cfg = resolverConfig({}, null);
  assert.equal(cfg.url, "");
  assert.equal(cfg.chave, "");
  assert.equal(disponivel(cfg), false, "e o GET responde disponivel:false, entao a tela nao mostra botao");
  assert.equal(disponivel({ url: "", chave: "", ligada: true }), false, "nem com `ligada:true`: sem url e chave nao ha o que chamar");
});

t("url SEM chave (e chave SEM url) continua indisponivel", () => {
  assert.equal(disponivel(resolverConfig({ TRANSCRICAO_URL: ENV_OK.TRANSCRICAO_URL }, null)), false);
  assert.equal(disponivel(resolverConfig({ TRANSCRICAO_CHAVE: "k" }, null)), false);
  assert.equal(disponivel(resolverConfig(ENV_OK, null)), true, "as duas juntas ligam");
});

t("url torta nao vira chamada pra lugar nenhum", () => {
  for (const ruim of [
    "", "   ", "nao-e-url", "ftp://x/y", "file:///c:/segredo.txt", "data:text/plain,oi",
    "javascript:alert(1)", "//sem-esquema.com", "https://com espaco.com",
    null, 42, {}, [], "https://" + "x".repeat(2100),
  ]) {
    assert.equal(urlDeServicoValida(ruim as any), false, `deveria recusar: ${String(ruim).slice(0, 40)}`);
  }
  assert.equal(urlDeServicoValida(ENV_OK.TRANSCRICAO_URL), true);
  assert.equal(resolverConfig({ ...ENV_OK, TRANSCRICAO_URL: "file:///etc/passwd" }, null).url, "", "url recusada nao entra");
});

t("SO https: a chave da instalacao vai no cabecalho desta chamada", () => {
  // `http://` levaria a chave paga em texto claro — colhivel por qualquer um no
  // caminho. Servico na rede da instalacao precisa de https (proxy/tunel), e a
  // consequencia esta declarada no comentario da funcao.
  assert.equal(urlDeServicoValida("http://transcricao.do-cliente.com/v1"), false);
  assert.equal(urlDeServicoValida("http://localhost:9000/transcrever"), false, "nem local: a chave viaja igual");
  assert.equal(urlDeServicoValida("http://127.0.0.1:9000/x"), false);
});

t("nada de SSRF: credencial na URL, IP interno e metadados de nuvem sao recusados", () => {
  // A URL pode vir de `mensageria.config` — ou seja, de quem tem SQL/tela. Sem
  // esta porta, o painel virava ferramenta de varredura da rede de quem o hospeda,
  // e mandava a chave junto.
  for (const ruim of [
    "https://usuario:senha@servico.com/v1", // credencial na URL vaza em log de proxy
    "https://169.254.169.254/latest/meta-data/", // metadados de nuvem
    "https://127.0.0.1/v1",
    "https://10.0.0.5/v1",
    "https://172.16.0.9/v1",
    "https://192.168.1.10/v1",
    "https://[::1]/v1", // IPv6 literal
    "https://[fd00::1]/v1",
    "https://localhost/v1", // sem ponto: nao e host publico
  ]) {
    assert.equal(urlDeServicoValida(ruim), false, `deveria recusar: ${ruim}`);
  }
});

t("a porta de URL e a MESMA dos webhooks de saida (um dialeto so no repo)", () => {
  // Validador proprio foi o defeito da 1a versao: o que endurece num nao endurece
  // no outro. A prova amarra as duas funcoes pra ninguem "melhorar" so um lado.
  for (const u of [
    "https://ok.exemplo.com/v1", "http://ok.exemplo.com/v1", "https://169.254.169.254/x",
    "https://a:b@ok.exemplo.com/x", "https://[::1]/x", "https://localhost/x", "nao-e-url", "",
  ]) {
    assert.equal(urlDeServicoValida(u), urlAceita(u), `divergiu de urlAceita em: ${u || "(vazio)"}`);
  }
});

// ============================== 2) A ASSIMETRIA ENV x BANCO (o que importa)
console.log("\n2) a chave so vem de env; o banco so consegue PARAR");

t("chave no BANCO e ignorada — a config sozinha nao liga servico pago", () => {
  const cfg = resolverConfig({}, { url: "https://servico-de-alguem.com", chave: "k-injetada", ligada: true });
  assert.equal(cfg.chave, "", "chave de linha de config NAO e aceita, em nenhuma hipotese");
  assert.equal(
    disponivel(cfg),
    false,
    "e por isso quem escreve na tabela config (SQL, tela de admin) nao consegue fazer o painel chamar servico pago"
  );
  assert.deepEqual(validarConfigDeBanco({ chave: "k" }), {}, "a chave nem aparece no que o banco pode dizer");
});

t("o banco CONSEGUE desligar (kill switch sem deploy)", () => {
  const ligado = resolverConfig(ENV_OK, null);
  assert.equal(disponivel(ligado), true);
  const desligado = resolverConfig(ENV_OK, { ligada: false });
  assert.equal(desligado.chave, ENV_OK.TRANSCRICAO_CHAVE, "a chave segue lida");
  assert.equal(disponivel(desligado), false, "mas o recurso para — e parar sem deploy e o objetivo");
});

t("o banco consegue trocar a URL (trocar de fornecedor sem deploy)", () => {
  const cfg = resolverConfig(ENV_OK, { url: "https://outro-fornecedor.com/api" });
  assert.equal(cfg.url, "https://outro-fornecedor.com/api");
  assert.equal(disponivel(cfg), true);
});

t("valor torto no banco nao liga NEM desliga por engano", () => {
  for (const torto of ["false", 0, "nao", null, "true", 1]) {
    const cfg = resolverConfig(ENV_OK, { ligada: torto as any });
    assert.equal(disponivel(cfg), true, `"${String(torto)}" nao e booleano: nao desliga`);
  }
  for (const lixo of [null, undefined, 42, "texto", [], [{ ligada: false }]]) {
    assert.deepEqual(validarConfigDeBanco(lixo), {}, "linha de config ilegivel nao muda nada");
  }
  assert.equal(disponivel(resolverConfig({}, { ligada: true })), false, "`ligada:true` sem env nao liga nada");
});

// ==================================== 3) O FORMATO DA ANOTACAO (paridade)
console.log("\n3) a anotacao no formato EXATO da origem");

t("o formato e byte a byte o do acervo real", () => {
  // Lido do backup em 31/08/2026 (chat 61e1e0cc..., nota 67115e43...):
  //   audio  ptt  timestamp 2024-10-17T18:58:07Z
  //   nota   "Conteúdo do áudio enviado em 17/10/24 às 15:58:\n\n É... CloudTarget"
  const DO_ACERVO = "Conteúdo do áudio enviado em 17/10/24 às 15:58:";
  assert.equal(prefixoDaNota("2024-10-17T18:58:07Z", "America/Sao_Paulo"), DO_ACERVO);
  assert.equal(
    textoDaNota("2024-10-17T18:58:07Z", "É... CloudTarget", "America/Sao_Paulo"),
    `${DO_ACERVO}\n\nÉ... CloudTarget`,
    "duas quebras de linha entre o cabecalho e o texto, como na origem"
  );
});

t("a hora e do FUSO da instalacao, nunca UTC", () => {
  // 18:58Z = 15:58 em Brasilia. Gravar em UTC faria a nota nova discordar de
  // 9.176 notas antigas em 3 horas, sem ninguem saber qual esta certa.
  assert.equal(dataDaNota("2024-10-17T18:58:07Z", "America/Sao_Paulo"), "17/10/24 às 15:58");
  assert.equal(dataDaNota("2024-10-17T18:58:07Z", "UTC"), "17/10/24 às 18:58");
  assert.equal(dataDaNota("2024-10-17T18:58:07Z", "Europe/Lisbon"), "17/10/24 às 19:58");
});

t("meia-noite e 00:00, nunca 24:00", () => {
  assert.equal(dataDaNota("2024-10-18T03:00:00Z", "America/Sao_Paulo"), "18/10/24 às 00:00");
  assert.equal(dataDaNota("2024-10-18T03:30:00Z", "America/Sao_Paulo"), "18/10/24 às 00:30");
  // O conserto de raiz e pedir o ciclo pelo nome: com `hour12:false` parte das
  // versoes de ICU devolve h24, em que meia-noite e "24" — e "24:00" e uma hora
  // que nao existe. Neste runtime o formatador ja devolve "00", entao o cinto
  // (`normalizarHora24`) e provado DIRETO: regra defensiva que a prova nao
  // alcanca e regra que apodrece sem aviso.
  // ANCORADO NA LINHA DE CODIGO (`^\s*`), nunca no arquivo inteiro: a primeira
  // versao deste guarda casava com o COMENTARIO que explica a escolha, e por isso
  // aceitava a troca de volta pra `hour12: false` sem reclamar — guarda de fonte
  // que casa com a propria documentacao nao guarda nada.
  assert.ok(/^\s*hourCycle: "h23",$/m.test(SRC_LIB_TOPO), "o ciclo e pedido pelo nome, nao por hour12:false");
  assert.equal(/^\s*hour12:/m.test(SRC_LIB_TOPO), false, "e `hour12` nao volta pela porta de tras");
  assert.ok(/^\s*const hora = normalizarHora24\(/m.test(SRC_LIB_TOPO), "e o cinto e realmente vestido");
  assert.equal(normalizarHora24("24"), "00");
  assert.equal(normalizarHora24("00"), "00");
  assert.equal(normalizarHora24("23"), "23");
  assert.equal(normalizarHora24(undefined), "", "hora ausente nao inventa 00");
});

t("virada de dia pelo fuso muda a DATA, nao so a hora", () => {
  // 01:30Z de 18/10 e ainda 22:30 do dia 17 em Brasilia
  assert.equal(dataDaNota("2024-10-18T01:30:00Z", "America/Sao_Paulo"), "17/10/24 às 22:30");
});

t("fuso desconhecido cai em UTC em vez de derrubar a nota", () => {
  // a nota vale mais com a hora em UTC do que uma excecao DEPOIS de o servico
  // do cliente ja ter sido pago pela transcricao
  assert.equal(dataDaNota("2024-10-17T18:58:07Z", "Nao/Existe"), "17/10/24 às 18:58");
});

t("data invalida nao inventa hora", () => {
  assert.equal(dataDaNota("nao e data"), "");
  assert.equal(prefixoDaNota("nao e data"), "Conteúdo do áudio:", "sem data, o cabecalho fica sem data");
});

t("o prefixo nao tem coringa de LIKE (a rota usa ele num like)", () => {
  // `%` ou `_` no prefixo viraria coringa e a busca de "ja transcrito" casaria
  // com nota de OUTRO audio — a mesma armadilha do `ilike` com texto de usuario
  for (const quando of ["2024-10-17T18:58:07Z", "2025-01-14T23:29:00Z", Date.now(), new Date()]) {
    const p = prefixoDaNota(quando, "America/Sao_Paulo");
    assert.equal(/[%_]/.test(p), false, `prefixo com coringa: ${p}`);
    assert.ok(p.endsWith(":"), "e termina em ':' — o texto vem depois");
  }
});

t("texto gigante e cortado sem estourar o teto da coluna de nota", () => {
  const nota = textoDaNota("2024-10-17T18:58:07Z", "a".repeat(99_999), "America/Sao_Paulo");
  assert.ok(nota.length <= LIMITE_TEXTO_TRANSCRICAO, `nota com ${nota.length} chars`);
  assert.ok(nota.startsWith("Conteúdo do áudio enviado em"), "e o cabecalho sobrevive ao corte (nunca o contrario)");
});

// =========================================== 4) A NOTA COMO AUTOMACAO
console.log("\n4) a nota e assinada como automacao (convencao 0006)");

t("enviado_por_id NULL + nome preenchido = automacao", () => {
  const l = linhaDaNota("5511999", "2024-10-17T18:58:07Z", "oi", "America/Sao_Paulo");
  assert.equal(l.enviado_por_id, null, "nenhum atendente escreveu isto: pendurar no id de quem clicou seria mentira");
  assert.equal(l.enviado_por_nome, AUTOR_TRANSCRICAO);
  assert.equal(l.sender_name, AUTOR_TRANSCRICAO);
  assert.equal(l.direcao, "interna", "anotacao interna: NAO vai pro cliente");
  assert.equal(l.tipo, "nota");
  assert.equal(l.chat_id, "5511999");
  assert.ok(l.conteudo.includes("oi"));
});

t("a nota APONTA PRA MENSAGEM (e nao pra hora dela)", () => {
  // Defeito real, achado na revisao cega: a ligacao era a data no texto, com
  // resolucao de MINUTO. Dois `ptt` no mesmo minuto (ha par identico no acervo
  // importado) ficavam indistinguiveis e o 2o audio recebia a transcricao do 1o.
  const a = linhaDaNota("5511999", "2024-10-17T18:58:07Z", "primeiro", "America/Sao_Paulo", "msg-a");
  const b = linhaDaNota("5511999", "2024-10-17T18:58:41Z", "segundo", "America/Sao_Paulo", "msg-b");
  assert.equal(a.quoted_msg_id, "msg-a");
  assert.equal(b.quoted_msg_id, "msg-b");
  assert.equal(
    a.conteudo,
    b.conteudo.replace("segundo", "primeiro"),
    "os dois audios do MESMO minuto tem cabecalho identico — e por isso o cabecalho nao pode ser a chave"
  );
  assert.notEqual(a.quoted_msg_id, b.quoted_msg_id, "mas a chave difere: e por mensagem");
  assert.equal(linhaDaNota("5511999", Date.now(), "x").quoted_msg_id, null, "sem mensagem, o campo fica NULL (fora do indice parcial)");
});

t("a nota nao carrega nada que o cliente veria", () => {
  const l = linhaDaNota("5511999", Date.now(), "texto") as Record<string, unknown>;
  assert.equal("provider_msg_id" in l, false, "nota interna nunca tem id de provedor (nao foi enviada a ninguem)");
  assert.equal("media_url" in l, false);
  assert.equal(l.status, "sent");
});

t("o autor e um nome que DESCREVE, e a consequencia esta declarada", () => {
  assert.equal(/chatbot/i.test(AUTOR_TRANSCRICAO), false, "nao existe chatbot nenhum assinando isto no painel");
  assert.ok(/transcri/i.test(AUTOR_TRANSCRICAO), "o nome diz o que fez");
  const src = readFileSync(new URL("../lib/transcricao.ts", import.meta.url), "utf8");
  assert.ok(
    /9\.176 anotacoes importadas seguem assinadas/.test(src),
    "e o arquivo declara que a trilha fica com DOIS nomes (historico nao se reescreve)"
  );
});

// =========================================== 5) O QUE PODE SER TRANSCRITO
console.log("\n5) o que pode (e o que nao pode) ser transcrito");

const AUDIO = {
  id: "m1", chat_id: "5511999", direcao: "in", tipo: "ptt",
  media_url: "https://arquivos.exemplo/audio.ogg", media_mime: "audio/ogg", is_deleted: false,
  criada_em: "2024-10-17T18:58:07Z",
};

t("audio recebido E audio enviado, os dois (paridade medida)", () => {
  assert.equal(motivoParaNaoTranscrever(AUDIO), null);
  assert.equal(motivoParaNaoTranscrever({ ...AUDIO, direcao: "out" }), null, "de 25 notas do acervo, 4 eram de audio ENVIADO");
  for (const tipo of TIPOS_DE_AUDIO) assert.equal(motivoParaNaoTranscrever({ ...AUDIO, tipo }), null, tipo);
  assert.ok(TIPOS_DE_AUDIO.includes("ptt"), "`ptt` (gravado na hora) sao 17.365 dos 36.330 audios: nao pode faltar");
});

t("o que nao e audio recusa COM MOTIVO, nunca em silencio", () => {
  for (const tipo of ["text", "image", "video", "document", "nota", ""]) {
    const m = motivoParaNaoTranscrever({ ...AUDIO, tipo });
    assert.ok(m && /nao e audio/.test(m), `tipo ${tipo}: ${m}`);
  }
  assert.match(String(motivoParaNaoTranscrever({ ...AUDIO, is_deleted: true })), /apagada/);
  assert.match(String(motivoParaNaoTranscrever(null)), /nao encontrada/);
  assert.match(String(motivoParaNaoTranscrever(undefined)), /nao encontrada/);
});

t("audio sem arquivo acessivel nao vai pro servico (nao paga por nada)", () => {
  for (const url of [null, "", "   ", "sem-esquema/audio.ogg", "file:///c:/audio.ogg", "data:audio/ogg;base64,AAA"]) {
    const m = motivoParaNaoTranscrever({ ...AUDIO, media_url: url as any });
    assert.ok(m && /arquivo de audio/.test(m), `url ${String(url)}: ${m}`);
  }
});

t("o corpo da chamada manda a URL, nao os bytes", () => {
  const c = corpoDaChamada(AUDIO);
  assert.equal(c.url, AUDIO.media_url, "o servico baixa o arquivo: o painel nao carrega midia na memoria do processo web");
  assert.equal(c.mime, "audio/ogg");
  assert.equal(c.idioma, "pt");
  assert.equal(corpoDaChamada(AUDIO, { idioma: "es" }).idioma, "es");
  assert.equal(corpoDaChamada({ ...AUDIO, media_mime: null }).mime, undefined, "mime ausente nao vai como string vazia");
  assert.equal(JSON.stringify(c).includes("chave"), false, "a chave vai no cabecalho, nunca no corpo");
});

// ================================= 6) A RESPOSTA DO SERVICO DO CLIENTE
console.log("\n6) ler a resposta do servico que o CLIENTE contratou");

t("aceita as formas comuns (e por isso o gancho e plugavel)", () => {
  assert.equal(textoDaResposta({ texto: "oi" }), "oi");
  assert.equal(textoDaResposta({ text: "oi" }), "oi");
  assert.equal(textoDaResposta({ transcription: "oi" }), "oi");
  assert.equal(textoDaResposta({ transcript: "oi" }), "oi");
  assert.equal(textoDaResposta({ transcricao: "oi" }), "oi");
  assert.equal(textoDaResposta("oi"), "oi", "servico que responde texto puro");
  assert.equal(textoDaResposta({ results: [{ text: "bom" }, { text: "dia" }] }), "bom dia");
  assert.equal(textoDaResposta({ segments: ["bom", "dia"] }), "bom dia");
  assert.equal(textoDaResposta({ data: { text: "aninhado" } }), "aninhado");
  assert.equal(textoDaResposta({ output: { texto: "aninhado" } }), "aninhado");
  assert.equal(textoDaResposta({ texto: "  espacos  " }), "espacos");
});

t("resposta SEM texto devolve vazio — e a rota nao grava nota", () => {
  // Nota em branco diria ao atendente que o audio nao tinha nada dentro, o que e
  // diferente de "o servico nao devolveu transcricao".
  for (const vazio of [null, undefined, {}, [], "", "   ", { texto: "" }, { texto: "   " }, { results: [] }, { erro: "falhou" }, 42]) {
    assert.equal(textoDaResposta(vazio as any), "", `deveria ser vazio: ${JSON.stringify(vazio)}`);
  }
});

t("campo que nao e texto nao vira texto", () => {
  assert.equal(textoDaResposta({ texto: 42 }), "");
  assert.equal(textoDaResposta({ texto: { a: 1 } }), "");
  assert.equal(textoDaResposta({ text: ["a"] }), "");
});

t("a ordem de preferencia e estavel", () => {
  assert.equal(textoDaResposta({ texto: "primeiro", text: "segundo" }), "primeiro", "servico que manda os dois nao vira loteria");
});

// A REGRESSAO que a revisao cega achou, provada com Response DE VERDADE (e por
// isso `textoDoCorpo` foi tirada da rota e trazida pra lib: dentro da rota, so
// guarda de fonte alcancava). A versao anterior fazia `.json()` e depois `.text()`
// — `.json()` consome o stream, o `.text()` seguinte lanca "Body is unusable", e
// TODO servico que responde texto puro levava 422 "sem transcricao".
console.log("\n6b) o corpo da resposta e lido UMA vez (a regressao do texto puro)");

const resp = (corpo: string, tipo = "application/json") =>
  new Response(corpo, { status: 200, headers: { "content-type": tipo } });

await ta("servico que responde TEXTO PURO funciona de verdade", async () => {
  assert.equal(await textoDoCorpo(resp("olha o que ele falou", "text/plain")), "olha o que ele falou");
});

await ta("servico que responde JSON tambem", async () => {
  assert.equal(await textoDoCorpo(resp('{"texto":"do json"}')), "do json");
  assert.equal(await textoDoCorpo(resp('{"results":[{"text":"bom"},{"text":"dia"}]}')), "bom dia");
});

await ta("corpo vazio, JSON quebrado e leitura que falha devolvem vazio (nunca nota vazia)", async () => {
  assert.equal(await textoDoCorpo(resp("", "text/plain")), "");
  assert.equal(await textoDoCorpo(resp("   ", "text/plain")), "");
  assert.equal(await textoDoCorpo(resp('{"texto":', "application/json")), '{"texto":', "JSON truncado cai pro texto");
  assert.equal(await textoDoCorpo({ text: async () => { throw new Error("Body is unusable"); } }), "");
});

await ta("o stream e consumido UMA vez so", async () => {
  // se `textoDoCorpo` lesse duas vezes, a 2a lancaria — a prova pega isso
  // contando as leituras de verdade
  let leituras = 0;
  const falso = { text: async () => { leituras++; return '{"texto":"ok"}'; } };
  assert.equal(await textoDoCorpo(falso), "ok");
  assert.equal(leituras, 1, "duas leituras significam 'Body is unusable' num Response real");
});

// ============================================ 7) GUARDAS DE ARQUITETURA
console.log("\n7) guardas: nenhum fornecedor, nenhuma chave, nenhum default");

const SRC_LIB = readFileSync(new URL("../lib/transcricao.ts", import.meta.url), "utf8");
const SRC_ROTA = readFileSync(new URL("../app/api/transcricao/route.ts", import.meta.url), "utf8");

/**
 * A fonte SEM COMENTARIO — e a ferramenta que faltava nas duas pontas.
 *
 * Guarda de PRESENCA casando com o comentario passa mesmo com o codigo trocado
 * (foi o defeito do `hourCycle`, achado por mutacao). Guarda de AUSENCIA falha
 * porque o comentario EXPLICA justamente o que nao se faz — foi o que aconteceu
 * com `x-api-key`: o comentario que documenta o vazamento fazia a guarda acusar a
 * propria documentacao. Nos dois casos a pergunta certa e sobre o CODIGO.
 */
const semComentario = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
const CODIGO_ROTA = semComentario(SRC_ROTA);
const CODIGO_LIB = semComentario(SRC_LIB);

t("a lib importa SO a porta de URL compartilhada (e segue rodando em node solto)", () => {
  const imports = SRC_LIB.match(/^\s*import\s.*$/gm) || [];
  assert.deepEqual(
    imports.map((l) => l.trim()),
    ['import { urlAceita } from "./webhooks-saida.ts";'],
    "um import so, e com extensao .ts (o padrao do repo pra lib que roda em node solto)"
  );
  // o fato de ESTA prova ter rodado ja e a evidencia: ela importa a lib em node
  // solto, sem build, sem env e sem banco — se o import trouxesse Supabase, nada
  // aqui carregaria
  assert.equal(/\bfetch\s*\(|process\.env|require\(/.test(CODIGO_LIB), false, "quem chama rede e quem tem rede: a rota");
});

t("nenhum fornecedor de IA embutido, em lugar nenhum", () => {
  for (const [nome, src] of [["lib", SRC_LIB], ["rota", SRC_ROTA]] as const) {
    assert.equal(
      /api\.openai|openai\.com|api\.anthropic|anthropic\.com|generativelanguage|deepgram|assemblyai|whisper\.api|elevenlabs/i.test(src),
      false,
      `${nome}: regra dura da casa — nenhuma linha do produto escolhe (nem consome) servico pago por conta propria`
    );
    assert.equal(/OPENAI_API_KEY|ANTHROPIC_API_KEY/.test(semComentario(src)), false, `${nome}: nem chave nossa`);
  }
});

t("nenhuma url nem chave default: sem configuracao nao ha para onde chamar", () => {
  for (const [nome, src] of [["lib", SRC_LIB], ["rota", SRC_ROTA]] as const) {
    const urls = src.match(/https?:\/\/[^\s"'`]+/g) || [];
    assert.deepEqual(urls, [], `${nome}: nenhuma url literal pode existir aqui — achei: ${urls.join(", ")}`);
  }
  // e nada com cara de chave embutida
  assert.equal(/chave\s*[:=]\s*["'][^"']{8,}/.test(SRC_LIB + SRC_ROTA), false, "nenhuma chave literal");
});

t("a rota tem o portao de conversa, e ANTES de chamar o servico", () => {
  assert.ok(/podeVerConversa/.test(SRC_ROTA), "gate de conversa obrigatorio");
  assert.ok(/restricaoEfetiva/.test(SRC_ROTA), "e a restricao de contexto embutido");
  const iGate = SRC_ROTA.indexOf("podeVerConversa(chat_id");
  const iFetch = SRC_ROTA.indexOf("await fetch(cfg.url");
  assert.ok(iGate > 0 && iFetch > iGate, "o gate vem ANTES da chamada paga (e antes de qualquer leitura de audio)");
  const iDisponivel = SRC_ROTA.indexOf("if (!disponivel(cfg))");
  assert.ok(iDisponivel > iGate && iDisponivel < iFetch, "e a checagem de disponibilidade fica entre os dois");
});

t("a rota confere o chat_id da LINHA, nao o do pedido", () => {
  assert.ok(
    /String\(msg\.chat_id\) !== chat_id/.test(SRC_ROTA),
    "sem isso o gate seria contornavel: chat_id que a pessoa alcanca + id de mensagem de outra conversa"
  );
});

t("a chamada ao servico tem timeout", () => {
  assert.ok(/AbortController/.test(SRC_ROTA), "servico que pendura prenderia o handler");
  // Guarda de FONTE, e a diferenca importa: `AbortController` + `TIMEOUT_MS`
  // presentes no arquivo nao provam que o relogio ABORTA. Exercitar isso de
  // verdade exigiria subir o handler do Next com auth e banco; aqui a guarda
  // cobra a ligacao exata, que e o que uma refatoracao distraida desfaz.
  assert.ok(
    /setTimeout\(\(\) => controle\.abort\(\), TIMEOUT_MS\)/.test(SRC_ROTA),
    "o relogio tem que chamar controle.abort() — timeout que nao aborta e decoracao"
  );
  assert.ok(/signal: controle\.signal/.test(SRC_ROTA), "e o fetch tem que receber o signal");
  assert.ok(TIMEOUT_MS > 0 && TIMEOUT_MS <= 300_000, `timeout fora de faixa razoavel: ${TIMEOUT_MS}`);
  assert.ok(/clearTimeout/.test(SRC_ROTA), "e o relogio e limpo (senao o processo segura o event loop)");
});

t("a rota nao devolve url, chave, nem o corpo de erro do terceiro", () => {
  const iGet = SRC_ROTA.indexOf("export async function GET");
  const iPost = SRC_ROTA.indexOf("export async function POST");
  const get = SRC_ROTA.slice(iGet, iPost);
  assert.equal(/cfg\.url|cfg\.chave/.test(semComentario(get)), false, "o GET devolve SO o booleano: url e infraestrutura da instalacao");
  assert.ok(/respondeu \$\{resposta\.status\}/.test(SRC_ROTA), "do erro do servico vai o STATUS...");
  assert.equal(
    /await resposta\.text\(\)[\s\S]{0,80}(error|message):/.test(SRC_ROTA),
    false,
    "...e nunca o corpo, que e de terceiro e pode trazer chave, url interna ou o proprio audio"
  );
});

t("a rota nao cria tabela e nao inventa DDL", () => {
  assert.equal(/create\s+table|alter\s+table|drop\s+/i.test(CODIGO_ROTA), false);
});

t("a costura que FALTA esta declarada no proprio arquivo", () => {
  // Um card que entrega o gancho e finge que entregou a fila e pior que um card
  // pequeno: quem le acha que audio novo transcreve sozinho, e nao transcreve.
  assert.ok(/COSTURA DECLARADA/.test(SRC_ROTA), "o cabecalho declara o que este card nao entrega");
  assert.ok(/ingestao|INGESTAO/i.test(SRC_ROTA), "e nomeia o ponto que falta (o gatilho na ingestao)");
  // e agora com PRECISAO, que e o que a revisao cobrou: nota duplicada esta
  // coberta pelo banco; cobranca duplicada NAO esta, e isso fica escrito
  assert.ok(/NOTA DUPLICADA: coberta pelo BANCO/.test(SRC_ROTA), "diz o que ESTA coberto");
  assert.ok(/COBRANCA DUPLICADA: \*\*NAO coberta\*\*/.test(SRC_ROTA), "e o que NAO esta — sem arredondar pra cima");
});

console.log("\n7b) a rota, depois da revisao cega");

t("a idempotencia pergunta pela MENSAGEM, nunca pelo texto da nota", () => {
  assert.ok(
    /\.eq\("quoted_msg_id", mensagem_id\)/.test(SRC_ROTA),
    "por mensagem: prefixo tem resolucao de minuto e confundiria dois audios seguidos"
  );
  assert.equal(
    /\.like\("conteudo"/.test(CODIGO_ROTA),
    false,
    "e a busca pelo prefixo saiu de vez (era ela que devolvia a transcricao do audio errado)"
  );
  assert.equal(
    (CODIGO_ROTA.match(/\.eq\("quoted_msg_id", mensagem_id\)/g) || []).length,
    2,
    "nos DOIS lugares: a checagem antes de pagar e a recuperacao depois do 23505"
  );
});

/**
 * O texto de uma chamada, do nome dela ate o parentese que FECHA (conta
 * aninhamento). Serve pra guarda de fonte de ARGUMENTO — fatiar por linha
 * quebraria no dia em que alguem reformatasse a chamada, e guarda que da falso
 * alarme e guarda que alguem apaga.
 */
function chamadaDe(src: string, nome: string): string {
  const i = src.indexOf(`${nome}(`);
  assert.ok(i >= 0, `nao achei a chamada de ${nome} no fonte`);
  let abertos = 0;
  for (let k = i + nome.length; k < src.length; k++) {
    if (src[k] === "(") abertos++;
    else if (src[k] === ")") {
      abertos--;
      if (abertos === 0) return src.slice(i, k + 1);
    }
  }
  assert.fail(`o parentese de ${nome}( nunca fecha`);
}

t("a ROTA passa o mensagem_id pra linhaDaNota (sem ele a idempotencia inteira evapora)", () => {
  // MUTACAO QUE PASSAVA VERDE ANTES DESTA GUARDA (re-revisao de 31/08/2026): tirar
  // o ultimo argumento da chamada. O estrago e silencioso nas TRES camadas de uma
  // vez, e nenhuma delas grita: a coluna `quoted_msg_id` grava NULL; a busca
  // `.eq("quoted_msg_id", mensagem_id)` nunca casa (entao "ja transcrevi?" responde
  // sempre NAO); e o indice unico da 0022 e PARCIAL em `quoted_msg_id is not null`,
  // ou seja nem o banco pega a duplicata. Resultado: cada clique transcreve de novo
  // e PAGA de novo, e a conversa junta notas repetidas. A prova de comportamento nao
  // alcanca isso (a rota importa o banco e usa alias `@/`, que o node
  // solto nao resolve; `next/server` em si nao e o obstaculo), entao a guarda e de FONTE —
  // lida SEM comentario, senao o comentario que explica o campo faria a guarda casar
  // consigo mesma (licao do `hourCycle`).
  const chamada = chamadaDe(CODIGO_ROTA, "linhaDaNota");
  assert.match(
    chamada,
    /,\s*mensagem_id\s*\)$/,
    `a nota tem que apontar pro audio que ela transcreve; achei: ${chamada}`
  );
  assert.ok(/^linhaDaNota\(\s*chat_id,/.test(chamada), `e o 1o argumento e a conversa; achei: ${chamada}`);
  // e o EFEITO do argumento que falta, medido na funcao pura (as duas pontas)
  assert.equal(linhaDaNota("c", 0, "x", "UTC").quoted_msg_id, null, "sem o id, a nota nao aponta pra nada");
  assert.equal(linhaDaNota("c", 0, "x", "UTC", "m1").quoted_msg_id, "m1", "com o id, aponta pro audio");
});

const DDL_0022 = readFileSync(new URL("../supabase/migrations/0022_intencoes.sql", import.meta.url), "utf8");

t("o indice unico da 0022 e quem garante UMA nota por audio", () => {
  const ddl = DDL_0022;
  assert.ok(/uq_mensagens_transcricao_por_audio/.test(ddl), "indice na tabela do canal central");
  assert.ok(/uq_mensagens_apioficial_transcricao_por_audio/.test(ddl), "e na do apioficial (as duas tem a coluna)");
  assert.ok(
    /where direcao = 'interna' and tipo = 'nota' and quoted_msg_id is not null/.test(ddl),
    "PARCIAL: sem o recorte, o indice proibiria duas mensagens normais citando o mesmo audio (uso legitimo)"
  );
  assert.ok(
    /if \s*\(\/23505\|duplicate key\/i\s*\.test/.test(CODIGO_ROTA),
    "e a rota TESTA o 23505 (nao basta o numero aparecer num comentario) pra devolver a nota que venceu"
  );
  assert.equal(
    (ddl.match(/where direcao = 'interna' and tipo = 'nota' and quoted_msg_id is not null/g) || []).length,
    2,
    "as DUAS tabelas com indice parcial — a 1a versao da guarda passava com uma delas sem o recorte"
  );
  assert.ok(/pg_constraint/.test(ddl), "e o CHECK da pontuacao tambem existe fora do ramo create table");
});

t("os DOIS indices da transcricao sao UNIQUE (a palavra e o que garante a unicidade)", () => {
  // MUTACAO QUE PASSAVA VERDE ANTES DESTA GUARDA (re-revisao de 31/08/2026): trocar
  // `create unique index` por `create index`. A guarda de cima confere NOME e o
  // `where` do indice parcial — e as duas coisas sobrevivem a mutacao inteiras.
  // Sem a palavra `unique` o indice vira so um atalho de busca: duas chamadas
  // simultaneas gravam DUAS notas, o 23505 nunca acontece, e o ramo que devolve "a
  // nota que venceu" na rota se torna codigo morto. E a honestidade do item 12 do
  // cabecalho da rota ("nota duplicada e coberta pelo BANCO") passa a ser falsa.
  //
  // O DDL e lido SEM COMENTARIO de proposito: o texto acima dos indices explica que
  // eles sao unicos, entao um `/unique/` no arquivo cru casaria com a EXPLICACAO
  // depois de o CODIGO ter perdido a palavra (a licao do `hourCycle`, secao final
  // do CLAUDE.md).
  const ddl = DDL_0022.replace(/^\s*--.*$/gm, "");
  const indices = [
    ...ddl.matchAll(/create\s+(unique\s+)?index\s+if\s+not\s+exists\s+(uq_[a-z_]*transcricao_por_audio)/gi),
  ];
  assert.equal(indices.length, 2, `esperava os 2 indices (central e apioficial), achei ${indices.length}`);
  for (const m of indices) {
    assert.ok(m[1], `${m[2]} NAO e unique: sem a palavra, o indice nao impede a segunda nota`);
  }
  // e o que sustenta o par: sem o `is not null` no `where`, toda nota antiga (que
  // tem quoted_msg_id NULL) entraria no indice e a segunda nota comum quebraria
  assert.equal(
    (ddl.match(/quoted_msg_id is not null/g) || []).length,
    2,
    "as duas com o recorte, e ele fora de comentario"
  );
});

t("a chave vai em UM cabecalho, e o redirect nao e seguido", () => {
  // MEDIDO em 31/08/2026 com dois servidores locais: em redirect cross-origin o
  // undici remove `Authorization` e NAO remove `x-api-key` — o segundo host
  // recebeu a chave em texto claro.
  assert.equal(/x-api-key/i.test(CODIGO_ROTA), false, "dois cabecalhos = a chave sobrevive ao 302");
  assert.ok(/x-api-key/i.test(SRC_ROTA), "e o comentario guarda o porque (o vazamento medido), pra ninguem reintroduzir");
  assert.ok(/redirect: "manual"/.test(CODIGO_ROTA), "e nem seguir o 302: a chave nao viaja pra outro host");
  assert.equal(/redirect: "follow"/.test(CODIGO_ROTA), false);
  const cabecalhos = SRC_ROTA.match(/headers: \{[^}]*\}/g) || [];
  const daChamada = cabecalhos.find((h) => h.includes("cfg.chave")) || "";
  assert.equal((daChamada.match(/cfg\.chave/g) || []).length, 1, "a chave aparece UMA vez nos cabecalhos da chamada");
  assert.ok(
    /resposta\.status >= 300 && resposta\.status < 400/.test(CODIGO_ROTA),
    "e o 3xx e DETECTADO (a mensagem sozinha nao detecta nada) pra virar aviso que diz o que fazer"
  );
  assert.ok(/respondeu com redirecionamento/.test(SRC_ROTA), "com o texto que orienta quem configurou");
});

t("o gate de canal somente-leitura existe (mesmo recurso, mesma tabela do /api/nota)", () => {
  assert.ok(/prepararEstadoExterno\(canal, chat_id/.test(SRC_ROTA), "sem ele o insert morria em 42P01 e a rota devolvia 500 cru (403 sem estado; linha garantida no canal do agente)");
  const iGate = SRC_ROTA.indexOf("prepararEstadoExterno(canal, chat_id");
  const iFetch = SRC_ROTA.indexOf("await fetch(cfg.url");
  assert.ok(iGate > 0 && iFetch > iGate, "e ANTES da chamada paga: nao paga por transcricao que nao tem onde ser gravada");
});

t("acao PAGA deixa trilha de quem pediu (sem mentir sobre autoria)", () => {
  assert.ok(
    /raw: \{ transcricao_por: user\.id/.test(SRC_ROTA),
    "quem MANDOU transcrever fica registrado — transcrever custa dinheiro da instalacao"
  );
  // e a autoria da NOTA segue sendo da automacao: os dois registros nao competem
  assert.equal(linhaDaNota("c", Date.now(), "x", undefined, "m").enviado_por_id, null);
});

console.log(`\nPROVA DA TRANSCRICAO OK — ${feitos} casos\n`);
