// Prova das CONSULTAS EXPORTAVEIS (card 86ak85bne) — `node scripts/prova-exportacao.ts`.
//
// lib/exportacao.ts nao importa nada, entao roda em node solto. O que esta prova
// existe pra travar nao e "a funcao devolve o que eu escrevi": sao as decisoes que
// um refactor futuro desfaria sem perceber —
//
//   1. exportacao de conversa RECUSADA pra quem ve recorte (nunca arquivo parcial);
//   2. acima do teto RECUSA, nunca corta calado;
//   3. cabecalho e corpo do CSV saem da MESMA lista de colunas;
//   4. e-mail, senha e token nunca entram em coluna nenhuma;
//   5. mensagem apagada nao devolve o texto original;
//   6. valor que comeca com `=` nao vira formula na planilha.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONSULTAS,
  DIAS_PADRAO,
  DIAS_MAX,
  TETO_LINHAS,
  avisoDeTeto,
  campoNuncaExportado,
  catalogoParaQuem,
  consultaPorId,
  desdeIso,
  diasDoPedido,
  linhaAcesso,
  linhaAnotacao,
  linhaMensagem,
  linhaUsuario,
  MARCA_INCOMPLETA,
  MARCA_INTERROMPIDA,
  linhaDeIncompleto,
  linhaDeInterrompido,
  aclDeConversa,
  estadoDaAcl,
  type LeituraDaAcl,
  motivoParaNaoExportar,
  nomeDoArquivo,
  problemaNoCsv,
  recorteDaVisao,
  type FatosDeRecorte,
  type Consulta,
} from "../lib/exportacao.ts";
import { csvCampo, csvLinha } from "../lib/relatorios.ts";

let ok = 0;
const t = (oque: string, fn: () => void) => {
  const r = fn() as unknown;
  // bloco async passado pro `t` sincrono seria uma prova que NAO MORDE: a promessa
  // rejeitada some (o `ok` ja foi impresso) e a assercao vira decoracao. Usa `ta`.
  if (r && typeof (r as PromiseLike<void>).then === "function") {
    throw new Error(`bloco async no t() sincrono: "${oque}" — use \`await ta(...)\``);
  }
  ok++;
  console.log(`  ok  ${oque}`);
};

/** Igual ao `t`, pra bloco que precisa de `await` (decisao com executor injetado). */
const ta = async (oque: string, fn: () => Promise<void>) => {
  await fn();
  ok++;
  console.log(`  ok  ${oque}`);
};

const SUPER = { podeExportar: true, visaoSemRecorte: true, gerenciaUsuarios: true };
const c = (id: string): Consulta => {
  const x = consultaPorId(id);
  assert.ok(x, `consulta ${id} nao existe`);
  return x!;
};

console.log("\nprova das consultas exportaveis (lib pura, sem banco)");

// ————————————————————————————————————————————————————————— catalogo
t("as 4 consultas do card existem, e nenhuma a mais entrou sem decisao", () => {
  assert.deepEqual(
    CONSULTAS.map((x) => x.id),
    ["mensagens", "anotacoes", "usuarios", "acessos"]
  );
});

t("toda consulta declara o que sai, a exigencia, as colunas e a migration", () => {
  for (const x of CONSULTAS) {
    assert.ok(x.titulo.length > 2, x.id);
    assert.ok(x.oQueSai.length > 30, `${x.id}: frase curta demais pra tela`);
    assert.ok(["visao_sem_recorte", "gerenciar_usuarios"].includes(x.exige), x.id);
    assert.ok(x.colunas.length >= 4, x.id);
    assert.equal(new Set(x.colunas).size, x.colunas.length, `${x.id}: coluna repetida`);
    assert.ok(x.migration === null || /^\d{4}_.*\.sql$/.test(x.migration), x.id);
  }
});

// ———————————————————————————————————————————— o portao (a decisao central)
t("SEM relatorios_exportar nada sai, nem o que nao e conversa", () => {
  for (const x of CONSULTAS) {
    const m = motivoParaNaoExportar(x, { podeExportar: false, visaoSemRecorte: true, gerenciaUsuarios: true });
    assert.match(String(m), /relatorios_exportar/, x.id);
  }
});

t("A DECISAO: visao com RECORTE nao exporta conversa — recusa, nunca arquivo parcial", () => {
  const quem = { podeExportar: true, visaoSemRecorte: false, gerenciaUsuarios: true };
  for (const id of ["mensagens", "anotacoes"]) {
    const m = motivoParaNaoExportar(c(id), quem);
    assert.ok(m, `${id} deveria ser recusada`);
    assert.match(String(m), /RECORTE/);
    // a frase tem que dizer POR QUE, senao a pessoa abre ticket achando que e bug
    assert.match(String(m), /nao sabe respeitar esse recorte|recusada em vez de sair errada/);
  }
  // e as de equipe seguem liberadas pra ela (recorte de conversa nao as afeta)
  assert.equal(motivoParaNaoExportar(c("usuarios"), quem), null);
  assert.equal(motivoParaNaoExportar(c("acessos"), quem), null);
});

t("dado de PESSOA DA EQUIPE exige gerenciar_usuarios, mesmo com visao total", () => {
  const quem = { podeExportar: true, visaoSemRecorte: true, gerenciaUsuarios: false };
  assert.match(String(motivoParaNaoExportar(c("usuarios"), quem)), /gerenciar usuarios/);
  assert.match(String(motivoParaNaoExportar(c("acessos"), quem)), /gerenciar usuarios/);
  // e quem so atende (sem gerenciar) continua podendo exportar conversa
  assert.equal(motivoParaNaoExportar(c("mensagens"), quem), null);
});

t("super admin com tudo ligado roda as 4", () => {
  for (const x of CONSULTAS) assert.equal(motivoParaNaoExportar(x, SUPER), null, x.id);
});

t("o catalogo diz DISPONIVEL e o MOTIVO por consulta (a tela reflete, nao adivinha)", () => {
  const cat = catalogoParaQuem({ podeExportar: true, visaoSemRecorte: false, gerenciaUsuarios: false });
  const porId = new Map(cat.map((x) => [x.id, x]));
  assert.equal(porId.get("mensagens")!.disponivel, false);
  assert.ok(porId.get("mensagens")!.motivo);
  assert.equal(porId.get("usuarios")!.disponivel, false);
  assert.equal(cat.length, CONSULTAS.length);
  // catalogo de quem pode tudo nao carrega motivo nenhum
  for (const x of catalogoParaQuem(SUPER)) {
    assert.equal(x.disponivel, true, x.id);
    assert.equal(x.motivo, null, x.id);
  }
});

// ——————————————————————————————— os quatro recortes (o GRAVE da revisao cega)
const SEM_RECORTE: FatosDeRecorte = {
  ehSuperAdmin: false,
  escopoVisao: "todas",
  contextoEmbutido: "nenhum",
  restricaoFunilCanal: "vazia",
  aclDeConversa: "nenhuma",
};

t("visao limpa passa; e cada um dos QUATRO recortes, sozinho, ja recusa", () => {
  assert.equal(recorteDaVisao(SEM_RECORTE).semRecorte, true);
  const recortes: [Partial<FatosDeRecorte>, RegExp][] = [
    [{ escopoVisao: "proprias" }, /escopo de visao/],
    [{ escopoVisao: "departamento" }, /escopo de visao/],
    [{ contextoEmbutido: "restrito" }, /contexto embutido/],
    [{ restricaoFunilCanal: "restrito" }, /funil\/canal/],
    // O QUARTO, que faltava: ACL por conversa. `podeVerConversa` avalia a ACL ANTES
    // do atalho `escopo_visao === "todas"`, entao a conversa travada pra dois
    // diretores fica invisivel na tela e SAIA no CSV, com conteudo e telefone.
    [{ aclDeConversa: "existe" }, /ACL por conversa/],
  ];
  for (const [dif, esperado] of recortes) {
    const r = recorteDaVisao({ ...SEM_RECORTE, ...dif });
    assert.equal(r.semRecorte, false, JSON.stringify(dif));
    assert.match(String(r.motivo), esperado);
  }
});

t("os tres 'nao deu pra saber' contam como RECORTE (fail-closed), nao como liberado", () => {
  assert.equal(recorteDaVisao({ ...SEM_RECORTE, contextoEmbutido: "invalido" }).semRecorte, false);
  assert.equal(recorteDaVisao({ ...SEM_RECORTE, aclDeConversa: "ilegivel" }).semRecorte, false);
  assert.match(String(recorteDaVisao({ ...SEM_RECORTE, aclDeConversa: "ilegivel" }).motivo), /nao deu pra ler/);
  // e o escopo VAZIO (perfil sem coluna, leitura torta) tambem nega
  assert.equal(recorteDaVisao({ ...SEM_RECORTE, escopoVisao: "" }).semRecorte, false);
});

t("tabela de ACL AUSENTE libera (sem tabela nao existe recorte pra furar)", () => {
  assert.equal(recorteDaVisao({ ...SEM_RECORTE, aclDeConversa: "tabela_ausente" }).semRecorte, true);
});

t("super admin passa por cima dos quatro — e a mesma decisao de conversaVisivel", () => {
  const tudoRecortado: FatosDeRecorte = {
    ehSuperAdmin: true,
    escopoVisao: "proprias",
    contextoEmbutido: "invalido",
    restricaoFunilCanal: "restrito",
    aclDeConversa: "existe",
  };
  assert.equal(recorteDaVisao(tudoRecortado).semRecorte, true);
  assert.equal(recorteDaVisao(tudoRecortado).motivo, null);
});

// ——————————————————————————— arquivo curto NUNCA sai calado (medias 3 e 11)
t("escreveu MENOS que o contado = linha de INCOMPLETA com os dois numeros", () => {
  assert.equal(linhaDeIncompleto(500, 500), null, "fechou: nenhuma marca");
  assert.equal(linhaDeIncompleto(501, 500), null, "cresceu entre a contagem e a leitura: nao e falha");
  const l = String(linhaDeIncompleto(400, 500));
  assert.match(l, /INCOMPLETA/);
  assert.ok(l.includes("400") && l.includes("500"), "os dois numeros aparecem");
  assert.equal(linhaDeIncompleto(0, 0), null, "consulta vazia nao vira incompleta");
  assert.match(String(linhaDeIncompleto(0, 10)), /INCOMPLETA/);
});

t("a tela fareja a marca na ULTIMA linha (o HTTP foi 200; a verdade esta no arquivo)", () => {
  const cabecalho = csvLinha(["a", "b"]);
  assert.equal(problemaNoCsv(cabecalho + csvLinha(["1", "2"])), null, "arquivo bom nao acusa nada");
  const curto = cabecalho + csvLinha([String(linhaDeIncompleto(1, 9))]);
  assert.match(String(problemaNoCsv(curto)), /INCOMPLETA/);
  const morto = cabecalho + csvLinha([linhaDeInterrompido(new Error("falha ao consultar"), 3, 9)]);
  assert.match(String(problemaNoCsv(morto)), /INTERROMPIDA/);
  assert.equal(problemaNoCsv(""), null);
  assert.equal(problemaNoCsv("linha solta sem marca"), null);
  // marca no MEIO de um texto de mensagem nao conta: so o comeco da linha
  assert.equal(problemaNoCsv(cabecalho + csvLinha(["oi", `falei ${MARCA_INCOMPLETA} na conversa`])), null);
});

t("AS DUAS MARCAS NUNCA SAEM ASPADAS — e por isso a aspa denuncia falsificacao", () => {
  // o texto das marcas nao pode ter `,` `;` `"` nem quebra de linha: `csvCampo` aspa o
  // campo quando ve qualquer um deles, e linha aspada e a forma que o CLIENTE controla
  for (const linha of [String(linhaDeIncompleto(1, 9)), linhaDeInterrompido(new Error("x"), 1, 9)]) {
    assert.equal(/[",;\r\n]/.test(linha), false, `marca com caractere que faz aspar: ${linha}`);
    assert.equal(csvLinha([linha]).includes('"'), false, `csvCampo aspou a marca: ${linha}`);
  }
  // e o texto do ERRO, que vem do banco, entra saneado (virgula do Postgres aspava tudo)
  const comVirgula = linhaDeInterrompido(new Error('falha, com "aspas"; e ponto-e-virgula\nem duas linhas'), 2, 8);
  assert.equal(/[",;\r\n]/.test(comVirgula), false, comVirgula);
  assert.match(String(problemaNoCsv(csvLinha(["a"]) + csvLinha([comVirgula]))), /INTERROMPIDA/);
  // erro sem mensagem nenhuma nao gera marca torta (a FORMA tem que continuar valida)
  assert.match(String(problemaNoCsv(csvLinha(["a"]) + csvLinha([linhaDeInterrompido(null, 0, 5)]))), /INTERROMPIDA/);
});

t("CLIENTE NAO FORJA O AVISO: texto de mensagem com a marca dentro nao vira aviso do sistema", () => {
  // BAIXA 17 da re-revisao cega. O conteudo da mensagem e escrito por terceiro. Uma
  // mensagem com "\n# EXPORTACAO INCOMPLETA: ... ligue 0800" virava aviso do SISTEMA na
  // tela do gestor — e podia MASCARAR a marca real (phishing dentro da planilha).
  const golpe = `oi tudo bem\n${MARCA_INCOMPLETA}: 1 de 9 linha(s) — ligue 0800-123 para recuperar o arquivo`;
  const arquivo = csvLinha(["chat_id", "conteudo"]) + csvLinha(["5511", golpe]);
  // a linha forjada e a ULTIMA do arquivo e comeca exatamente com a marca...
  const ultima = arquivo.trimEnd().split(/\r?\n/).pop() as string;
  assert.ok(ultima.startsWith(MARCA_INCOMPLETA), "o cenario do golpe nao foi montado");
  // ...mas carrega a aspa que FECHA o campo de texto, e por isso e recusada
  assert.equal(problemaNoCsv(arquivo), null, "o cliente forjou o aviso do sistema");

  // e forjar SEM aspa exige acertar a FORMA da marca (o contador), nao so o prefixo
  assert.equal(problemaNoCsv(`a,b\r\n${MARCA_INCOMPLETA}: ligue 0800-123`), null, "prefixo sem contador passou");
  assert.equal(problemaNoCsv(`a,b\r\n${MARCA_INTERROMPIDA}: ligue 0800-123`), null, "prefixo sem contador passou");

  // e a marca REAL, que o sistema emite, continua sendo pega
  assert.match(String(problemaNoCsv(`a,b\r\n${String(linhaDeIncompleto(1, 9))}`)), /INCOMPLETA/);
});

t("A CAUDA NAO FABRICA COMECO DE LINHA: fragmento de 1 linha nunca vira aviso", () => {
  // micro-check de 31/08/2026. A tela le so os ultimos 4 KB (`blob.slice`), e se a
  // ULTIMA linha do CSV for maior que a janela, o corte cai no MEIO do texto do
  // cliente: o "comeco de linha" que `FORMA_DA_MARCA` exige passa a ser fabricado
  // pela fatia, e a mensagem de terceiro forjava o banner com ate 4 KB de texto dele.
  // A paginacao e `id ASC`, entao a mensagem mais NOVA e a ultima linha do arquivo.
  const JANELA = 4096;
  const cauda = (texto: string) => texto.slice(Math.max(0, texto.length - JANELA));

  // O GOLPE, alinhado: o corte cai a 4096 bytes do FIM, e o que vem depois da marca
  // forjada e texto do proprio golpista (+ o CRLF do fim da linha) — ou seja, o
  // alinhamento esta 100% na mao dele. Nada de virgula, ponto-e-virgula, aspa nem
  // quebra de linha na mensagem: assim `csvCampo` nao aspa o campo e a regra da aspa
  // (que pega a forja simples) nao tem onde pegar.
  const alvo = `${MARCA_INCOMPLETA}: 1 de 9 linha(s) ligue 0800-123 e informe seu CPF `;
  const forjada = alvo + "x".repeat(JANELA - 2 /* CRLF */ - alvo.length);
  const mensagem = "a".repeat(JANELA) + forjada;
  const arquivo = csvLinha(["chat_id", "conteudo"]) + csvLinha(["5511", mensagem]);
  const fatia = cauda(arquivo);
  // o cenario TEM que estar montado, senao a prova nao prova nada:
  assert.equal(fatia.includes('"'), false, "o campo saiu aspado: este nao e o golpe da cauda");
  assert.equal(/[\r\n]/.test(fatia.trimEnd()), false, "a fatia tem quebra de linha: o golpe nao foi montado");
  assert.ok(fatia.startsWith(MARCA_INCOMPLETA), "o corte nao caiu no comeco da marca forjada");
  assert.equal(problemaNoCsv(fatia), null, "a cauda fabricou o comeco da linha e o aviso foi forjado");

  // e o caso HONESTO continua detectado, inclusive quando a linha anterior e gigante:
  // a marca tem menos de 300 bytes, entao a janela sempre pega a quebra antes dela
  const real = String(linhaDeIncompleto(7, 9));
  assert.ok(real.length < 300, "a marca cresceu: a janela de 4 KB pode nao pegar a quebra anterior");
  const arquivoReal = csvLinha(["chat_id", "conteudo"]) + csvLinha(["5511", "b".repeat(JANELA * 2)]) + csvLinha([real]);
  assert.match(String(problemaNoCsv(cauda(arquivoReal))), /INCOMPLETA/, "a tela deixou de farejar a marca real");
  // arquivo menor que a janela e lido INTEIRO (com o cabecalho): duas linhas sempre
  const pequeno = csvLinha(["a", "b"]) + csvLinha([real]);
  assert.ok(pequeno.length < JANELA);
  assert.match(String(problemaNoCsv(cauda(pequeno))), /INCOMPLETA/);
});

// ————————————————————————————————— o mapeamento de erro da ACL (fail-CLOSED)
t("so 42P01 e tabela ausente: cache do PostgREST NAO libera a exportacao", () => {
  // MEDIA 14 da re-revisao cega. `tabela_ausente` e o UNICO valor que libera, e a versao
  // anterior aceitava PGRST205/PGRST204 — que e o estado TRANSITORIO do PostgREST logo
  // depois de um DDL. Nessa janela, instalacao COM ACL virava "sem tabela" e o vazamento
  // do GRAVE reabria por alguns segundos.
  assert.equal(estadoDaAcl({ code: "42P01" }, null), "tabela_ausente", "0004 nao rodada: libera");
  for (const code of ["PGRST205", "PGRST204", "42703", "42501", "", null, undefined]) {
    assert.equal(estadoDaAcl({ code }, null), "ilegivel", `codigo ${String(code)} nao pode liberar`);
  }
  // e o mapeamento tem que casar com quem RECUSA (senao o fail-closed nao acontece)
  assert.equal(recorteDaVisao({ ...SEM_RECORTE, aclDeConversa: estadoDaAcl({ code: "PGRST205" }, null) }).semRecorte, false);
  assert.equal(recorteDaVisao({ ...SEM_RECORTE, aclDeConversa: estadoDaAcl({ code: "42P01" }, null) }).semRecorte, true);
  // sem erro: o numero decide, e contagem AUSENTE tambem e "nao deu pra ler"
  assert.equal(estadoDaAcl(null, 0), "nenhuma");
  assert.equal(estadoDaAcl(null, 1), "existe");
  assert.equal(estadoDaAcl(null, 900), "existe");
  assert.equal(estadoDaAcl(null, null), "ilegivel", "count nulo sem erro nao pode virar 'nenhuma'");
  assert.equal(estadoDaAcl(undefined, undefined), "ilegivel");
});

await ta("A DECISAO DA ACL RODA DE VERDADE: executor injetado, fake no lugar do banco", async () => {
  // micro-check de 31/08/2026: a varredura de texto protegia o CALL SITE, e por isso
  // um `if (count) return "nenhuma"` acrescentado DENTRO do helper da rota liberava o
  // GRAVE inteiro com a bateria verde. Nada EXECUTAVA a decisao. Aqui ela executa —
  // com o executor injetado, e conferindo o DESFECHO (403 ou prossegue), nao a string.
  const fake = (r: LeituraDaAcl) => () => Promise.resolve(r);
  const desfecho = async (r: LeituraDaAcl) => {
    const acl = await aclDeConversa(fake(r));
    return { acl, prossegue: recorteDaVisao({ ...SEM_RECORTE, aclDeConversa: acl }).semRecorte };
  };

  // instalacao COM ACL: existe recorte que o CSV nao sabe respeitar -> 403
  assert.deepEqual(await desfecho({ count: 3, error: null }), { acl: "existe", prossegue: false });
  assert.deepEqual(await desfecho({ count: 1, error: null }), { acl: "existe", prossegue: false });
  // cache do PostgREST logo depois de um DDL: NAO DEU PRA LER -> 403 (fail-closed)
  assert.deepEqual(await desfecho({ count: null, error: { code: "PGRST205" } }), {
    acl: "ilegivel",
    prossegue: false,
  });
  // zero linha na tabela: nao ha recorte -> prossegue
  assert.deepEqual(await desfecho({ count: 0, error: null }), { acl: "nenhuma", prossegue: true });
  // 0004 nao rodada: sem tabela nao ha recorte pra furar -> prossegue
  assert.deepEqual(await desfecho({ count: null, error: { code: "42P01" } }), {
    acl: "tabela_ausente",
    prossegue: true,
  });
  // leitura que ESTOURA (rede, cliente mal configurado) e recusa com razao, nao 500
  assert.equal(await aclDeConversa(() => Promise.reject(new Error("rede caiu"))), "ilegivel");
  assert.equal(
    recorteDaVisao({ ...SEM_RECORTE, aclDeConversa: await aclDeConversa(() => Promise.reject(new Error("x"))) })
      .semRecorte,
    false
  );
  // resposta TORTA do cliente (nem count nem error) tambem e ilegivel, nao "nenhuma"
  assert.equal(await aclDeConversa(fake({} as LeituraDaAcl)), "ilegivel");
  assert.equal(await aclDeConversa(fake(null as unknown as LeituraDaAcl)), "ilegivel");
});

// ————————————————————————————————————————————————————————— periodo e teto
t("dias: valor torto cai no padrao, nunca em NaN, e o maximo e respeitado", () => {
  assert.equal(diasDoPedido(null), DIAS_PADRAO);
  assert.equal(diasDoPedido("abc"), DIAS_PADRAO);
  assert.equal(diasDoPedido(""), DIAS_PADRAO);
  assert.equal(diasDoPedido(0), DIAS_PADRAO);
  assert.equal(diasDoPedido(-5), DIAS_PADRAO);
  assert.equal(diasDoPedido(7), 7);
  assert.equal(diasDoPedido("7.9"), 7);
  assert.equal(diasDoPedido(99_999), DIAS_MAX);
  assert.ok(Number.isFinite(diasDoPedido(Infinity)));
});

t("desdeIso volta exatamente N dias do agora informado", () => {
  const agora = new Date("2026-08-31T12:00:00.000Z");
  assert.equal(desdeIso(1, agora), "2026-08-30T12:00:00.000Z");
  assert.equal(desdeIso(30, agora), "2026-08-01T12:00:00.000Z");
});

t("A OUTRA DECISAO: acima do teto AVISA com o numero real — nunca corta calado", () => {
  assert.equal(avisoDeTeto(0), null);
  assert.equal(avisoDeTeto(TETO_LINHAS), null, "no limite exato ainda cabe");
  const a = avisoDeTeto(TETO_LINHAS + 1);
  assert.ok(a);
  assert.match(String(a), /acima do teto/);
  // o numero REAL tem que estar na frase: sem ele a pessoa nao sabe quanto estreitar
  assert.ok(String(avisoDeTeto(123_456)).includes("123.456"));
  assert.match(String(a), /NAO sai cortado/);
});

// ———————————————————————————————————————————————————————— nome do arquivo
t("nome do arquivo carrega consulta, canal e dia, e sanitiza o canal (vem de config)", () => {
  assert.equal(nomeDoArquivo("mensagens", "central", "2026-08-31"), "mensagens-central-2026-08-31.csv");
  assert.equal(nomeDoArquivo("usuarios", null, "2026-08-31"), "usuarios-2026-08-31.csv");
  const sujo = nomeDoArquivo("mensagens", 'a/b\\c"d e', "2026-08-31");
  assert.equal(/[/\\"' ]/.test(sujo), false, `nome com caractere de path: ${sujo}`);
  assert.match(sujo, /\.csv$/);
});

// ——————————————————————————————————————————————————————— colunas x linhas
t("CABECALHO E CORPO SAEM DA MESMA LISTA: cada mapeador devolve o numero de colunas declarado", () => {
  assert.equal(linhaMensagem({}, "central").length, c("mensagens").colunas.length);
  assert.equal(linhaAnotacao({}, "central").length, c("anotacoes").colunas.length);
  assert.equal(linhaUsuario({}).length, c("usuarios").colunas.length);
  assert.equal(linhaAcesso({}).length, c("acessos").colunas.length);
});

t("linha vazia nao produz undefined/null no arquivo (planilha com 'undefined' e lixo)", () => {
  for (const l of [linhaMensagem({}, "central"), linhaAnotacao({}, "central"), linhaUsuario({}), linhaAcesso({})]) {
    for (const v of l) {
      assert.notEqual(v, undefined);
      assert.notEqual(v, null);
    }
    const linha = csvLinha(l);
    assert.equal(linha.includes("undefined"), false);
    assert.equal(linha.includes("null"), false);
  }
});

t("mensagem: canal vem de fora (a tabela nao guarda) e o campo de midia sai como sim/nao", () => {
  const l = linhaMensagem({ chat_id: "5511900000001", conteudo: "oi", media_url: "https://x/y.jpg" }, "apioficial");
  assert.equal(l[1], "apioficial");
  assert.equal(l[2], "5511900000001");
  assert.equal(l[9], "sim");
  assert.equal(linhaMensagem({}, "central")[9], "nao");
});

t("MENSAGEM APAGADA nao devolve o texto original no arquivo", () => {
  const l = linhaMensagem({ conteudo: "texto que o cliente apagou", is_deleted: true }, "central");
  assert.equal(l[8], "(mensagem apagada)");
  assert.equal(csvLinha(l).includes("apagou"), false);
});

t("remetente cai no telefone quando nao tem nome (coluna vazia esconderia quem falou)", () => {
  assert.equal(linhaMensagem({ sender_phone: "5511999" }, "central")[5], "5511999");
  assert.equal(linhaMensagem({ sender_name: "Joao", sender_phone: "5511999" }, "central")[5], "Joao");
});

t("usuario: NOME entra (planilha de UUID e inutil), e-mail nao, e nada vira 'undefined'", () => {
  const col = c("usuarios").colunas;
  const i = (nome: string) => {
    const k = col.indexOf(nome);
    assert.notEqual(k, -1, `coluna ${nome} nao existe`);
    return k;
  };
  const l = linhaUsuario({
    user_id: "u1",
    nome: "Ana Souza",
    papel: "normal",
    ativo: false,
    assinatura_ativa: true,
    email: "ana@empresa.com",
  });
  assert.equal(l[i("user_id")], "u1");
  // O ACHADO DA REVISAO: sem o nome, a planilha de "quem tem acesso" e uma lista de
  // UUIDs — ninguem decide quem tirar do painel olhando isso.
  assert.equal(l[i("nome")], "Ana Souza");
  assert.equal(l[i("papel")], "normal");
  assert.equal(l[i("papel_nomeado")], "", "papel nomeado ausente sai vazio, nao 'undefined'");
  assert.equal(l[i("ativo")], "nao");
  assert.equal(l[i("assinatura_ativa")], "sim");
  // e o E-MAIL continua fora, mesmo vindo na linha do banco
  assert.equal(csvLinha(l).includes("ana@empresa.com"), false, "e-mail nao pode entrar no arquivo");
  assert.equal(col.includes("email"), false);
  // ausencia de `ativo` conta como ativo (o default da coluna no banco e true)
  assert.equal(linhaUsuario({})[i("ativo")], "sim");
  assert.equal(linhaUsuario({})[i("nome")], "");
});

t("acesso: os nomes do BANCO (0019) chegam nas colunas do ARQUIVO", () => {
  const l = linhaAcesso({
    user_id: "u1",
    navegador: "Chrome",
    sistema: "Windows",
    rotulo: "notebook",
    robo: true,
    primeiro_acesso_em: "2026-01-01T00:00:00Z",
    visto_em: "2026-08-31T00:00:00Z",
    ip_ultimo: "1.2.3.4",
    revogado_em: "2026-08-30T00:00:00Z",
  });
  assert.deepEqual(l, [
    "u1",
    "Chrome",
    "Windows",
    "notebook",
    "sim",
    "2026-01-01T00:00:00Z",
    "2026-08-31T00:00:00Z",
    "1.2.3.4",
    "sim",
  ]);
  assert.equal(linhaAcesso({})[8], "nao", "sem revogado_em = ativo");
});

t("a assinatura tecnica do dispositivo (user_agent, impressao) NAO entra no arquivo", () => {
  const l = linhaAcesso({ user_agent: "Mozilla/5.0 (coisa toda)", impressao: "abc123", navegador: "Chrome" });
  assert.equal(csvLinha(l).includes("Mozilla"), false);
  assert.equal(csvLinha(l).includes("abc123"), false);
});

// ————————————————————————————————————————————————————————————— privacidade
t("E-MAIL, senha e token sao campos que nunca saem — e nenhuma coluna declarada e um deles", () => {
  assert.equal(campoNuncaExportado("email"), true);
  assert.equal(campoNuncaExportado("E-Mail"), true);
  assert.equal(campoNuncaExportado("senha"), true);
  assert.equal(campoNuncaExportado("api_key"), true);
  assert.equal(campoNuncaExportado("chat_id"), false);
  for (const x of CONSULTAS) {
    for (const col of x.colunas) {
      assert.equal(campoNuncaExportado(col), false, `${x.id}.${col} e campo proibido`);
    }
  }
});

t("nenhuma consulta declara coluna com cara de credencial (varredura por nome)", () => {
  for (const x of CONSULTAS) {
    for (const col of x.colunas) {
      assert.equal(/token|secret|senha|password|bearer|api[_-]?key/i.test(col), false, `${x.id}.${col}`);
    }
  }
});

// ————————————————————————————————————————————————————————————————— CSV
t("FORMULA NEUTRALIZADA: texto de cliente comecando com = nao executa na planilha", () => {
  // o conteudo vem do cliente; `=cmd|...` no Excel e execucao de comando
  const l = linhaMensagem({ conteudo: '=cmd|" /c calc"!A1' }, "central");
  const linha = csvLinha(l);
  assert.ok(linha.includes("'=cmd"), `nao neutralizou: ${linha}`);
  for (const p of ["=", "+", "-", "@"]) assert.equal(csvCampo(`${p}x`).startsWith("'"), true, p);
});

t("quebra de linha e ponto e virgula no texto nao rompem a linha do CSV", () => {
  const linha = csvLinha(linhaMensagem({ conteudo: 'oi\nde novo; "citado"' }, "central"));
  // uma linha logica = um \r\n no fim, e o resto entre aspas
  assert.equal(linha.endsWith("\r\n"), true);
  assert.equal(linha.slice(0, -2).split("\r\n").length, 1);
  assert.ok(linha.includes('"oi\nde novo; ""citado"""'));
});

t("o cabecalho do arquivo e exatamente as colunas declaradas, na ordem", () => {
  for (const x of CONSULTAS) {
    assert.equal(csvLinha(x.colunas), x.colunas.join(",") + "\r\n", x.id);
  }
});

// ————————————————————————————————————————— a rota, lida como TEXTO
//
// Estes dois nao dao pra provar em memoria (moram na rota, que importa Supabase),
// mas dao pra provar no CODIGO — e sao exatamente os dois que um refactor apaga
// sem que nenhum teste de unidade reclame.

const ROTA = readFileSync(new URL("../app/api/exportar/route.ts", import.meta.url), "utf8");

t("paginacao por OFFSET: toda consulta paginada tem DESEMPATE (senao pula/repete linha)", () => {
  // `.range(de, ate)` sem uma segunda `.order` = ordem instavel entre paginas:
  // duas linhas com o mesmo `criada_em` trocam de lugar e uma delas desaparece.
  const pedacos = ROTA.split(".range(de, ate)");
  assert.ok(pedacos.length - 1 >= 3, `esperava 3+ consultas paginadas, achei ${pedacos.length - 1}`);
  for (let i = 0; i < pedacos.length - 1; i++) {
    // olha so o trecho desta consulta (do ultimo `.from(` ate o `.range`)
    const corte = pedacos[i].lastIndexOf(".from(");
    assert.notEqual(corte, -1, `consulta ${i}: nao achei o .from()`);
    const consulta = pedacos[i].slice(corte);
    const orders = consulta.match(/\.order\(/g) || [];
    assert.ok(orders.length >= 2, `consulta ${i} pagina sem desempate (${orders.length} .order): ${consulta.slice(0, 120)}`);
    // o desempate tem que ser por coluna UNICA — `id`/`user_id`, nunca outra data
    const ultima = consulta.slice(consulta.lastIndexOf(".order("));
    assert.ok(
      /\.order\("(id|user_id|chat_id)"/.test(ultima),
      `consulta ${i}: o ultimo .order nao e coluna unica: ${ultima.slice(0, 80)}`
    );
  }
});

t("a rota CONTA as linhas escritas e emite a marca de incompleto (nao confia no total)", () => {
  assert.ok(ROTA.includes("escritas++"), "ninguem conta linha escrita");
  assert.ok(ROTA.includes("linhaDeIncompleto(escritas, cont.total)"), "escritas vs total nao e comparado");
  // CALCULAR nao e EMITIR (MEDIA 15 da re-revisao cega): apagar o `push` mantendo o
  // `const curto = ...` deixava a bateria verde e o arquivo curto voltava a sair calado
  assert.ok(/if \(curto\) push\(/.test(ROTA), "a marca e calculada e nao e escrita no arquivo");
  // a rota usa a funcao (nao um literal solto): mudar a marca em lib/exportacao.ts
  // tem que mudar as duas pontas de uma vez, senao a tela deixa de farejar
  assert.ok(ROTA.includes("linhaDeInterrompido(e, escritas, cont.total)"), "stream que morre no meio nao marca o arquivo");
  assert.ok(MARCA_INTERROMPIDA.length > 0);
});

t("a rota decide o recorte pela funcao PURA e COLHE os quatro fatos de verdade", () => {
  assert.ok(ROTA.includes("recorteDaVisao("), "a rota nao chama recorteDaVisao");
  // a versao anterior tinha a regra inline e esqueceu o 4o recorte
  assert.equal(/if\s*\(\s*[a-zA-Z.]*aclDeConversa\s*===/.test(ROTA), false, "regra de ACL duplicada na rota");
  // MEDIA 13 da re-revisao cega: exigir so a CHAMADA da funcao pura deixava o 4o
  // recorte desligavel numa linha — trocar o await por `aclDeConversa: "nenhuma"`
  // devolvia o GRAVE inteiro com a bateria verde. O FATO tem que vir da consulta.
  assert.ok(
    /aclDeConversa:\s*await aclDeConversa\(lerAclDeConversa\)/.test(ROTA),
    "o fato da ACL nao vem da consulta"
  );
  // e a DECISAO nao pode voltar a morar aqui (micro-check de 31/08): decisao na rota
  // so tem prova de TEXTO, e texto protege a chamada, nao o corpo. O que fica na rota
  // e o EXECUTOR: uma expressao, devolvendo a consulta — sem `if`, sem literal.
  assert.equal(/function aclDeConversa/.test(ROTA), false, "a decisao da ACL voltou pra rota");
  assert.equal(ROTA.includes("estadoDaAcl("), false, "o mapeamento da ACL voltou pra rota");
  assert.ok(
    /function lerAclDeConversa\(\) \{\s*return msgDb\(\)\s*\.from\("conversa_visibilidade"\)/.test(ROTA),
    "o executor da ACL nao e mais uma leitura direta da tabela"
  );
  // e o mapeamento generoso desta rota (que decide 503 de tabela opcional) nao pode
  // ser o que decide a ACL: ele aceita PGRST205, que aqui LIBERARIA a exportacao
  assert.equal(/semTabela\(error\) \? "tabela_ausente"/.test(ROTA), false, "ACL voltou ao semTabela generoso");
  // os outros tres fatos tambem vem colhidos, nao fixados
  assert.ok(/escopoVisao: String\(perfil\.escopo_visao/.test(ROTA), "escopo fixado no lugar de lido");
  assert.ok(/restricaoFunilCanal: restricaoVazia\(restricao\)/.test(ROTA), "restricao fixada no lugar de lida");
  assert.ok(/contextoEmbutido: emb ===/.test(ROTA), "contexto embutido fixado no lugar de lido");
});

const TELA = readFileSync(new URL("../app/relatorios-painel.tsx", import.meta.url), "utf8");

t("a TELA fareja a marca e avisa, e salva o arquivo de todo jeito (ele e a evidencia)", () => {
  assert.ok(TELA.includes("problemaNoCsv("), "a tela nao fareja o arquivo baixado");
  const i = TELA.indexOf("problemaNoCsv(");
  const j = TELA.indexOf("createObjectURL");
  assert.ok(i !== -1 && j !== -1 && i < j, "a farejada tem que vir antes do download, senao o blob ja foi consumido");
  assert.ok(/setErroCsv\(`O arquivo \$\{nome\} foi salvo, MAS esta incompleto/.test(TELA), "arquivo incompleto baixa calado");
  // o aviso tem que estar PENDURADO no que a farejada devolveu — `if (false)` aqui
  // deixa a mensagem no arquivo e o usuario sem aviso nenhum
  assert.ok(TELA.includes("if (problema) setErroCsv("), "o aviso nao depende do problema farejado");
  // SO A CAUDA: `blob.text()` no arquivo inteiro materializa dezenas de MB na aba
  // (exportacao vai a 50 mil linhas) so pra ler a ultima linha
  assert.equal(TELA.includes("problemaNoCsv(await blob.text())"), false, "a tela le o CSV inteiro na memoria");
  const janela = TELA.match(/blob\.slice\(Math\.max\(0, blob\.size - (\d+)\)\)\.text\(\)/);
  assert.ok(janela, "a tela nao le so a cauda");
  // a janela precisa ser MUITO maior que a marca: `problemaNoCsv` exige duas linhas, e
  // e a quebra anterior a marca que tem que caber junto com ela. Janela apertada nao
  // vira furo (nada e liberado), vira FALSO NEGATIVO: o arquivo curto volta a ser
  // salvo calado. 1 KB e folga de 3x sobre o pior texto de marca.
  assert.ok(Number(janela![1]) >= 1024, `janela da cauda apertada (${janela![1]} bytes)`);
  assert.ok(String(linhaDeIncompleto(1, 999999)).length < 1024);
});

console.log(`\nTUDO OK — ${ok} blocos, nenhuma consulta de banco.`);
