// Prova da BIBLIOTECA DE ANEXOS (Frente W, card 86ak85bmw) — SEM banco, SEM
// navegador, SEM rede. Roda em Node >= 22.6 sem build:
//
//   node --experimental-strip-types scripts/prova-anexos.ts
//
// O que esta prova trava, em cinco blocos:
//
//  A) AS REGRAS PURAS — chave, nome, descricao, etiquetas, busca sem acento,
//     paginacao e o tipo de envio. Entra aqui o portao do upload exercitado com
//     BYTES HOSTIS (svg com nome .pdf, html declarado text/plain, binario mudo):
//     o tipo sai dos bytes, e o bucket e publico.
//
//  B) O QUE DECIDE SEGURANCA, PROVADO POR COMPORTAMENTO — `varrerFluxosQueUsam`
//     com o LEITOR INJETADO nos quatro desfechos, `decidirPatch` na matriz das
//     quatro permissoes e `decidirExclusao` nos quatro caminhos. Prova de texto
//     nao alcanca o corpo da funcao: aqui o fake entra no lugar do banco.
//
//  C) QUEM USA ESTE ANEXO — leitura por FORMA (caminhar os nos e ler `acao.tipo`),
//     nunca por busca de frase no jsonb: mensagem que CITA a chave nao e passo que
//     USA a chave.
//
//  D) GUARDAS ESTRUTURAIS, por FORMA e sem comentario — a biblioteca nao e segunda
//     porta de envio, o upload nao entra por chave de API, o DELETE varre antes de
//     apagar, e as costuras (escopo de chave, permissoes, config) existem de fato.
//
//  E) AS DUAS COPIAS DELIBERADAS — a chave em `scripts/importar/anexos-catalogo.mjs`
//     e os limites em `lib/fluxo/schema.ts` tem que dar o MESMO resultado que
//     `lib/anexos.ts`. Copia sem prova e copia que diverge.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ACAO_ANEXO,
  LIMITE_BYTES,
  LIMITE_CHAVE,
  LIMITE_DESCRICAO,
  LIMITE_ETIQUETA,
  LIMITE_ETIQUETAS,
  LIMITE_LEGENDA,
  POR_PAGINA_MAX,
  POR_PAGINA_MIN,
  POR_PAGINA_PADRAO,
  assinaturaDeArquivo,
  casaBuscaAnexo,
  chaveDeAnexo,
  chaveJaValida,
  decidirExclusao,
  decidirPatch,
  descricaoDeAnexo,
  estadoDaLeituraDeFluxos,
  etiquetasDeAnexo,
  etiquetasEmUso,
  extensaoDe,
  filtrarAnexos,
  fluxosQueUsamAnexo,
  legendaDeAnexo,
  motivoNaoAnexa,
  nomeDeAnexo,
  nomeDeArquivo,
  payloadDeEnvio,
  porPaginaValido,
  referenciasDeAnexoNoFluxo,
  resumoDoImpacto,
  tipoDeEnvio,
  PREFIXO_ANEXOS,
  caminhoDeAnexoNaUrl,
  caminhoDoAnexo,
  urlDeAnexoValida,
  usoPorChave,
  validarArquivo,
  varrerFluxosQueUsam,
  type LinhaFluxo,
} from "../lib/anexos.ts";
// o modulo INTEIRO, pra cobrar o que ele NAO exporta (D.13b) — a trava com
// prefixo-argumento so fica inalcancavel enquanto ninguem a re-exportar.
import * as regrasDeAnexo from "../lib/anexos.ts";
import {
  DESCRICAO_PERMISSAO,
  PAPEIS_EMBUTIDOS,
  PAPEIS_SUGERIDOS,
  PERMISSOES,
  permissoesEfetivas,
  pode,
} from "../lib/permissoes.ts";
import { CANAL_PADRAO_EM, DESCRICAO_RECURSO, RECURSOS, assumeCanalPadrao, recursoDaRota } from "../lib/escopo-chave.ts";
import { ACOES_QUE_ALCANCAM_CLIENTE, ACOES_V1, validarFluxo } from "../lib/fluxo/schema.ts";
import {
  chaveDeAnexo as chaveDoImportador,
  etiquetasDoCatalogo as etiquetasDoImportador,
  inventarioDeAnexos,
  marcacaoNoInicio,
} from "../scripts/importar/anexos-catalogo.mjs";

let assercoes = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  assercoes++;
  assert.equal(a, b, msg);
};
const dep = (a: unknown, b: unknown, msg: string) => {
  assercoes++;
  assert.deepEqual(a, b, msg);
};
const certo = (cond: unknown, msg: string) => {
  assercoes++;
  assert.ok(cond, msg);
};

const bytesDe = (texto: string) => new Uint8Array(Buffer.from(texto, "binary"));
const comBytes = (...n: number[]) => new Uint8Array(n);

// ════════════════════════════════════════════════ A) AS REGRAS PURAS

// A.1 CHAVE — normaliza o que da pra consertar, recusa o que nao da.
{
  eq(chaveDeAnexo("Tabela de Preços 2026"), "tabela-de-precos-2026", "acento, espaco e caixa viram kebab");
  eq(chaveDeAnexo("  guia__interno  "), "guia__interno", "underscore e legitimo na chave");
  eq(chaveDeAnexo("--- catalogo ---"), "catalogo", "separador nas pontas cai");
  eq(chaveDeAnexo("a b   c"), "a-b-c", "espaco repetido nao gera separador repetido");
  eq(chaveDeAnexo("Contrato (v2).pdf"), "contrato-v2-pdf", "pontuacao vira separador");
  eq(chaveDeAnexo("###"), null, "nome so de simbolo NAO tem chave (nada de chave sorteada)");
  eq(chaveDeAnexo(""), null, "vazio nao tem chave");
  eq(chaveDeAnexo(null), null, "nao-texto nao tem chave");
  eq(chaveDeAnexo("2026"), "2026", "chave pode comecar com numero");
  eq(chaveDeAnexo("_interno"), "interno", "chave NAO comeca com separador (a forma do banco proibe)");
  const gigante = chaveDeAnexo("x".repeat(200));
  eq(gigante?.length, LIMITE_CHAVE, "chave gigante e cortada no limite");
  certo(chaveJaValida(gigante), "e o que sai do corte continua valido");
  // o corte nao pode deixar separador na ponta: `chave-` nao passa no check do banco
  const cortada = chaveDeAnexo(`${"a".repeat(LIMITE_CHAVE - 1)}-bbb`);
  certo(cortada && !cortada.endsWith("-"), `corte nao deixa separador na ponta: ${cortada}`);
  certo(chaveJaValida(cortada), "e o resultado do corte respeita a forma");
  eq(chaveJaValida("Maiuscula"), false, "chaveJaValida NAO normaliza (ela e o check, nao o conserto)");
  eq(chaveJaValida("-comeca-com-tracinho"), false, "forma do banco: nao comeca com separador");
}

// A.2 NOME, DESCRICAO, LEGENDA — vazio legitimo x texto que nao e texto.
{
  eq(nomeDeAnexo("  Guia\tde\nImplantacao  "), "Guia de Implantacao", "quebra de linha e tab viram espaco");
  eq(nomeDeAnexo("   "), null, "nome so de espaco nao e nome");
  eq(nomeDeAnexo(42), null, "nao-texto nao e nome");

  const limpa = descricaoDeAnexo("");
  eq(limpa.ok, true, "descricao VAZIA e legitima (limpar e um gesto)");
  eq(limpa.ok && limpa.valor, "", "e ela chega vazia mesmo");
  const naoTexto = descricaoDeAnexo(7);
  eq(naoTexto.ok, false, "numero NAO e descricao (e o resultado discriminado diz isso)");
  eq(descricaoDeAnexo("x".repeat(LIMITE_DESCRICAO + 1)).ok, false, "descricao acima do limite e recusada");
  eq(descricaoDeAnexo("x".repeat(LIMITE_DESCRICAO)).ok, true, "no limite, passa");

  eq(legendaDeAnexo(undefined).ok, true, "legenda ausente e legitima (o anexo vai sem texto)");
  eq(legendaDeAnexo("x".repeat(LIMITE_LEGENDA + 1)).ok, false, "legenda acima do limite e recusada");
  eq(legendaDeAnexo(42).ok, false, "legenda que nao e texto e recusada");
}

// A.3 ETIQUETAS — dedupe por FORMA normalizada, e o primeiro texto e o que fica.
{
  const e = etiquetasDeAnexo(["Comercial", "comercial", "COMERCIAL", "  precos  "]);
  certo(e.ok, "lista boa passa");
  dep(e.ok && e.etiquetas, ["Comercial", "precos"], "'Comercial' e 'comercial' sao a MESMA etiqueta pra quem filtra");
  dep(etiquetasDeAnexo([]).ok && etiquetasDeAnexo([]).etiquetas, [], "lista vazia e legitima (desetiquetar)");
  eq(etiquetasDeAnexo("comercial").ok, false, "etiqueta fora de lista e recusada");
  eq(etiquetasDeAnexo([["a"]]).ok, true, "item que nao e texto e IGNORADO, nao derruba o pedido");
  eq(etiquetasDeAnexo(["x".repeat(LIMITE_ETIQUETA + 1)]).ok, false, "etiqueta gigante e recusada com o nome dela");
  eq(
    etiquetasDeAnexo(Array.from({ length: LIMITE_ETIQUETAS + 1 }, (_, i) => `e${i}`)).ok,
    false,
    "acima do teto de etiquetas por arquivo, recusa"
  );
}

// A.4 BUSCA — sem acento, sem caixa, em qualquer campo (inclusive etiqueta).
{
  const acervo = [
    {
      chave: "tabela-precos",
      nome: "Tabela de Preços 2026",
      descricao: "manda depois da proposta",
      arquivo_nome: "tabela.xlsx",
      etiquetas: ["Comercial"],
    },
    { chave: "guia", nome: "Guia", descricao: "", arquivo_nome: "guia.pdf", etiquetas: ["Onboarding"] },
  ];
  certo(casaBuscaAnexo(acervo[0], "precos"), "busca sem acento acha nome com acento");
  certo(casaBuscaAnexo(acervo[0], "PREÇOS"), "e com acento e maiuscula tambem");
  certo(casaBuscaAnexo(acervo[0], "comercial"), "a etiqueta entra na busca");
  certo(casaBuscaAnexo(acervo[0], "xlsx"), "o nome do arquivo entra na busca");
  certo(casaBuscaAnexo(acervo[0], ""), "termo vazio nao filtra nada");
  eq(casaBuscaAnexo(acervo[1], "precos"), false, "quem nao casa, nao casa");

  dep(filtrarAnexos(acervo, { termo: "guia" }).map((a) => a.chave), ["guia"], "filtro por termo");
  dep(
    filtrarAnexos(acervo, { etiqueta: "comercial" }).map((a) => a.chave),
    ["tabela-precos"],
    "filtro por etiqueta e por FORMA (a caixa nao importa)"
  );
  dep(filtrarAnexos(acervo, { termo: "guia", etiqueta: "comercial" }).map((a) => a.chave), [], "os dois filtros somam");
  dep(
    etiquetasEmUso(acervo),
    [
      { etiqueta: "Comercial", itens: 1 },
      { etiqueta: "Onboarding", itens: 1 },
    ],
    "as etiquetas em uso saem com a contagem"
  );
}

// A.5 PAGINACAO CONFIGURAVEL — clampeia em vez de derrubar a listagem.
{
  eq(porPaginaValido(undefined), POR_PAGINA_PADRAO, "sem valor, o padrao (a conta de referencia pagina de 50)");
  eq(POR_PAGINA_PADRAO, 50, "e o padrao E 50, o numero medido na conta de referencia");
  eq(porPaginaValido("1"), POR_PAGINA_MIN, "abaixo do minimo, sobe pro minimo");
  eq(porPaginaValido("100000"), POR_PAGINA_MAX, "acima do maximo, desce pro maximo");
  eq(porPaginaValido("abc"), POR_PAGINA_PADRAO, "valor torto nao derruba: cai no padrao");
  eq(porPaginaValido("25"), 25, "valor bom passa");
  eq(porPaginaValido(undefined, 12), 12, "o padrao pode vir da config da instalacao");
  eq(POR_PAGINA_MIN, 4, "os limites sao os do card: minimo 4");
  eq(POR_PAGINA_MAX, 300, "e maximo 300");
}

// A.6 TIPO DE ENVIO — sai do mime, e webp de biblioteca e IMAGEM (nao figurinha).
{
  eq(tipoDeEnvio("image/png"), "image", "png e imagem");
  eq(tipoDeEnvio("image/webp"), "image", "webp de BIBLIOTECA e imagem: banner nao chega como figurinha");
  eq(tipoDeEnvio("video/mp4"), "video", "mp4 e video");
  eq(tipoDeEnvio("audio/ogg; codecs=opus"), "audio", "mime com parametro ainda e audio");
  eq(tipoDeEnvio("application/pdf"), "document", "pdf e documento");
  eq(tipoDeEnvio(null), "document", "sem mime, documento (o caminho que sempre funciona)");
  eq(extensaoDe("relatorio.PDF", "application/octet-stream"), "pdf", "a extensao do nome vence o mime");
  eq(extensaoDe("sem-extensao", "image/png"), "png", "sem extensao no nome, o mime decide");
  eq(extensaoDe("sem-extensao", "application/desconhecido"), "bin", "sem nenhum dos dois, `bin` — nunca chute");
}

// A.7 O PORTAO DO UPLOAD, COM BYTES HOSTIS.
//
// Este bloco e a razao de `assinaturaDeArquivo` existir: o content-type do cliente
// nao decide nada. O bucket e PUBLICO e a URL vai pro WhatsApp do cliente final —
// svg e html sao script hospedado no dominio da instalacao.
{
  const pdf = validarArquivo({ bytes: bytesDe("%PDF-1.7\n1 0 obj"), nome: "proposta.txt", mime: "text/plain" });
  certo(pdf.ok, "PDF de verdade passa...");
  eq(pdf.ok && pdf.mime, "application/pdf", "...com o mime dos BYTES, nao o declarado");
  eq(pdf.ok && pdf.arquivo_nome, "proposta.pdf", "...e o nome ganha a extensao do tipo REAL");

  const svgComNomeDePdf = validarArquivo({
    bytes: bytesDe('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    nome: "catalogo.pdf",
    mime: "application/pdf",
  });
  eq(svgComNomeDePdf.ok, false, "SVG com nome .pdf e mime .pdf e RECUSADO (o byte nao mente)");

  const htmlComoTexto = validarArquivo({
    bytes: bytesDe("  <html><body><script>fetch('//fora')</script>"),
    nome: "aviso.txt",
    mime: "text/plain",
  });
  eq(htmlComoTexto.ok, false, "HTML declarado text/plain e RECUSADO (comeca com `<`)");

  const htmlComBom = validarArquivo({
    bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...bytesDe("<script>x</script>")]),
    nome: "a.csv",
    mime: "text/csv",
  });
  eq(htmlComBom.ok, false, "BOM antes do `<` nao contorna a trava");

  const texto = validarArquivo({ bytes: bytesDe("nome;telefone\nJoao;1"), nome: "lista.csv", mime: "text/csv" });
  certo(texto.ok, "CSV de verdade passa (texto e a UNICA familia em que o declarado abre porta)");
  eq(texto.ok && texto.mime, "text/csv", "e com o mime declarado, que estava na lista");

  const textoSemDeclarar = validarArquivo({ bytes: bytesDe("linha solta"), nome: "x.txt", mime: "" });
  eq(textoSemDeclarar.ok, false, "texto SEM mime declarado nao passa: nao ha assinatura pra confirmar");

  const binarioMudo = validarArquivo({ bytes: comBytes(1, 2, 3, 4, 5, 6, 7, 8), nome: "x.bin", mime: "text/plain" });
  eq(binarioMudo.ok, false, "binario se passando por texto e recusado (byte de controle)");

  eq(validarArquivo({ bytes: new Uint8Array(), nome: "a.pdf" }).ok, false, "arquivo vazio e recusado");
  eq(
    validarArquivo({ bytes: new Uint8Array(LIMITE_BYTES + 1), nome: "a.pdf" }).ok,
    false,
    "acima do teto de bytes e recusado ANTES de olhar assinatura"
  );

  const png = assinaturaDeArquivo(comBytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0));
  eq(png?.mime, "image/png", "PNG pela assinatura");
  const docx = assinaturaDeArquivo(
    comBytes(0x50, 0x4b, 0x03, 0x04, 0, 0),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  eq(docx?.ext, "docx", "zip + mime declarado da familia = docx (nao ha como distinguir por bytes)");
  const zipCru = assinaturaDeArquivo(comBytes(0x50, 0x4b, 0x03, 0x04, 0, 0), "image/svg+xml");
  eq(zipCru?.mime, "application/zip", "declarado FORA da familia nao amplia nada: cai no generico");
  const m4a = assinaturaDeArquivo(bytesDe("....ftypM4A "));
  eq(m4a?.familia, "audio", "ftypM4A e audio");
  const mp4 = assinaturaDeArquivo(bytesDe("....ftypisom"));
  eq(mp4?.familia, "video", "o resto da familia ISO-BMFF e video");

  // nome de arquivo NUNCA carrega caminho nem controle
  eq(nomeDeArquivo("../../etc/passwd", "pdf"), ".. .. etc passwd.pdf", "separador de caminho sai do nome");
  eq(nomeDeArquivo("nome\u0000quebrado.pdf", "pdf"), "nome quebrado.pdf", "byte de controle sai do nome");
  eq(nomeDeArquivo("", "pdf"), "arquivo.pdf", "sem nome, um nome que existe");
  certo(nomeDeArquivo("x".repeat(300), "pdf").length <= 120, "nome gigante e cortado dentro do limite do banco");
}

// A.8 O CORPO DO ENVIO, MONTADO EM UM LUGAR SO.
{
  const anexo = {
    chave: "tabela",
    nome: "Tabela",
    arquivo_nome: "tabela.xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    url: "https://x.supabase.co/storage/v1/object/public/midia-mensagens/biblioteca/tabela.xlsx?v=abcd1234",
  };
  const p = payloadDeEnvio(anexo, "  segue a tabela  ");
  eq(p.tipo, "document", "o tipo sai do mime");
  eq(p.media, anexo.url, "o `media` e a URL PUBLICA: o provedor baixa dela (o painel nao re-sobe 25 MB)");
  eq(p.file_name, "tabela.xlsx", "o nome do arquivo viaja (e o que o cliente ve)");
  eq(p.message, "segue a tabela", "a legenda vai aparada");
  eq(payloadDeEnvio(anexo).message, undefined, "sem legenda, sem campo de texto");
  eq(payloadDeEnvio(anexo, "   ").message, undefined, "legenda so de espaco nao vira mensagem vazia");
  eq(payloadDeEnvio(anexo, "x".repeat(LIMITE_LEGENDA + 50)).message?.length, LIMITE_LEGENDA, "legenda longa e cortada");

  certo(urlDeAnexoValida(anexo.url), "https passa");
  eq(urlDeAnexoValida("http://x/y.pdf"), null, "http NAO passa");
  eq(urlDeAnexoValida("javascript:alert(1)"), null, "esquema esquisito nao passa");
  eq(urlDeAnexoValida("https://x/ y.pdf"), null, "espaco na URL nao passa");
}

// A.9 CANAL QUE NAO MANDA ARQUIVO — a recusa e por CAPACIDADE, nunca por id.
{
  eq(motivoNaoAnexa({ fonte: "zapi", envioCabeado: true }), null, "z-api cabeada manda arquivo");
  eq(motivoNaoAnexa({ fonte: "evolution", envioCabeado: true }), null, "evolution tambem");
  certo(
    /somente leitura/.test(String(motivoNaoAnexa({ fonte: "zapi", soLeitura: true }))),
    "numero somente leitura recusa, com a frase honesta"
  );
  certo(
    /nao esta configurado/.test(String(motivoNaoAnexa({ fonte: "zapi", envioCabeado: false }))),
    "envio nao cabeado recusa"
  );
  certo(
    /so texto/.test(String(motivoNaoAnexa({ fonte: "gupshup", envioCabeado: true }))),
    "API Oficial (v1 so texto) recusa ANTES do clique"
  );
  certo(
    /fonte nova/.test(String(motivoNaoAnexa({ fonte: "fonte nova", envioCabeado: true }))),
    "fonte desconhecida recusa nomeando a fonte (fail-closed)"
  );
}

// ══════════════════════════ B) COMPORTAMENTO (leitor injetado, fake no lugar do banco)

// B.1 A VARREDURA DE FLUXOS NOS QUATRO DESFECHOS.
{
  const fluxoComAnexo = {
    nos: [
      { id: "n1", acao: { tipo: "enviar_texto", texto: "segue" } },
      { id: "n2", acao: { tipo: ACAO_ANEXO, anexo: "tabela-precos" } },
    ],
  };
  const linhas: LinhaFluxo[] = [
    { slug: "boas-vindas", nome: "Boas-vindas", ativo: true, fluxo: fluxoComAnexo },
    { slug: "outro", nome: "Outro", ativo: false, fluxo: { nos: [{ id: "n1", acao: { tipo: "nota_interna" } }] } },
  ];

  const ok1 = await varrerFluxosQueUsam("tabela-precos", async () => ({ linhas }));
  certo(ok1.ok, "leitura boa: varredura ok");
  dep(ok1.ok && ok1.afetados.map((f) => f.slug), ["boas-vindas"], "e acha SO quem referencia a chave");
  eq(ok1.ok && ok1.sem_tabela_de_fluxos, false, "com tabela, o marcador e false");

  // 42P01 = a tabela de fluxos nao existe. E o UNICO codigo que LIBERA.
  const semTabela = await varrerFluxosQueUsam("tabela-precos", async () => ({ error: { code: "42P01" } }));
  certo(semTabela.ok, "sem tabela de fluxos, a lista de impacto e vazia DE VERDADE");
  eq(semTabela.ok && semTabela.sem_tabela_de_fluxos, true, "e o marcador diz por que");

  // PGRST205 e o estado TRANSITORIO do cache do PostgREST: aceitar isso como
  // "tabela ausente" faria o apagar ignorar os fluxos justo durante um DDL.
  const cache = await varrerFluxosQueUsam("tabela-precos", async () => ({ error: { code: "PGRST205" } }));
  eq(cache.ok, false, "PGRST205 (cache do PostgREST) RECUSA — nao e tabela ausente");
  const colunaAusente = await varrerFluxosQueUsam("x", async () => ({ error: { code: "42703" } }));
  eq(colunaAusente.ok, false, "coluna ausente RECUSA");
  const permissao = await varrerFluxosQueUsam("x", async () => ({ error: { code: "42501" } }));
  eq(permissao.ok, false, "erro de permissao RECUSA");

  // "nao vi" nao vira "nao usa" na porta de um gesto destrutivo
  const truncado = await varrerFluxosQueUsam("tabela-precos", async () => ({ linhas, truncado: true }));
  eq(truncado.ok, false, "leitura CORTADA pelo teto RECUSA");
  certo(!truncado.ok && /CORTADA/.test(truncado.aviso), "e o aviso diz que foi corte de teto");

  const explodiu = await varrerFluxosQueUsam("x", async () => {
    throw new Error("rede caiu");
  });
  eq(explodiu.ok, false, "leitor que ESTOURA nao vaza excecao pra rota: vira recusa");
  certo(!explodiu.ok && /rede caiu/.test(explodiu.aviso), "e o motivo real viaja");

  eq(estadoDaLeituraDeFluxos(null), "ok", "sem erro, ok");
  eq(estadoDaLeituraDeFluxos({ code: "42P01" }), "sem_tabela", "42P01 e o unico `sem_tabela`");
  eq(estadoDaLeituraDeFluxos({ code: null }), "ilegivel", "erro sem codigo e ilegivel (fail-closed)");
}

// B.2 AS QUATRO PERMISSOES SAO SEPARADAS — e o PATCH e onde isso vira mentira.
{
  const so = (descrever: boolean, etiquetar: boolean) => ({ descrever, etiquetar });

  const ambos = decidirPatch({ descricao: "nova", etiquetas: ["a"] }, so(true, true));
  certo(ambos.ok, "quem tem as duas permissoes muda as duas coisas");
  dep(ambos.ok && ambos.campos, { descricao: "nova", etiquetas: ["a"] }, "e os dois campos vao");

  // O DEFEITO QUE ESTA PROVA MATA: gravar a descricao de carona no pedido de quem
  // so pode etiquetar.
  const carona = decidirPatch({ descricao: "nova", etiquetas: ["a"] }, so(false, true));
  eq(carona.ok, false, "pedido com campo NAO autorizado e recusado INTEIRO");
  eq(!carona.ok && carona.status, 403, "com 403");
  certo(!carona.ok && /DESCREVER/.test(carona.erro), "e a frase diz QUAL permissao falta");
  const caronaInversa = decidirPatch({ descricao: "nova", etiquetas: ["a"] }, so(true, false));
  eq(caronaInversa.ok, false, "vale nos dois sentidos");
  certo(!caronaInversa.ok && /ETIQUETAR/.test(caronaInversa.erro), "nomeando a outra permissao");

  const soDescricao = decidirPatch({ descricao: "nova" }, so(true, false));
  certo(soDescricao.ok, "quem so descreve, descreve");
  eq(soDescricao.ok && soDescricao.campos.etiquetas, undefined, "e nao encosta em etiqueta");
  const soEtiqueta = decidirPatch({ etiquetas: ["a"] }, so(false, true));
  certo(soEtiqueta.ok, "quem so etiqueta, etiqueta");
  eq(soEtiqueta.ok && soEtiqueta.campos.descricao, undefined, "e nao encosta em descricao");

  const nada = decidirPatch({}, so(true, true));
  eq(nada.ok, false, "pedido sem campo nenhum e 400, nao um 'salvei' mentiroso");
  eq(!nada.ok && nada.status, 400, "com 400");

  // limpar a descricao E um gesto legitimo: string vazia passa
  const limpar = decidirPatch({ descricao: "" }, so(true, false));
  certo(limpar.ok, "limpar a descricao e um gesto legitimo");
  eq(limpar.ok && limpar.campos.descricao, "", "e chega vazia");
  // ...mas valor torto e 400, nao "ignora e diz que salvou"
  eq(decidirPatch({ descricao: 7 }, so(true, true)).ok, false, "descricao que nao e texto e 400");
  eq(decidirPatch({ etiquetas: "a,b" }, so(true, true)).ok, false, "etiquetas fora de lista e 400");
}

// B.3 APAGAR NUNCA E SILENCIOSO — os quatro caminhos de `decidirExclusao`.
{
  const afetados = [
    { slug: "boas-vindas", nome: "Boas-vindas", ativo: true, passos: [{ no_id: "n2", desligado: false }] },
    { slug: "regua", nome: "Regua de 7 dias", ativo: false, passos: [{ no_id: "n5", desligado: true }] },
  ];
  const vazia = { ok: true as const, afetados: [] };
  const cheia = { ok: true as const, afetados };
  const falhou = { ok: false as const, aviso: "nao deu pra ler os fluxos desta instalacao (42501)" };

  const semConfirmar = decidirExclusao({ confirmar: false, ciente_fluxos: true, varredura: vazia });
  eq(semConfirmar.ok, false, "sem confirmacao explicita, nao apaga");
  eq(!semConfirmar.ok && semConfirmar.status, 400, "e o status e 400");

  // FAIL-CLOSED NA IGNORANCIA: "nao sei se algum fluxo usa" nao vira "nenhum usa"
  const naoSei = decidirExclusao({ confirmar: true, ciente_fluxos: true, varredura: falhou });
  eq(naoSei.ok, false, "varredura que FALHOU recusa o apagar, mesmo com as duas confirmacoes");
  eq(!naoSei.ok && naoSei.status, 503, "com 503 (estado, nao culpa de quem clicou)");
  certo(!naoSei.ok && naoSei.detalhe === falhou.aviso, "e o motivo real chega na tela");

  const comFluxos = decidirExclusao({ confirmar: true, ciente_fluxos: false, varredura: cheia });
  eq(comFluxos.ok, false, "com fluxos afetados e sem ciente, 409");
  eq(!comFluxos.ok && comFluxos.status, 409, "409 = conflito, o modelo do DELETE de /api/fluxos");
  certo(!comFluxos.ok && /2 fluxo/.test(String(comFluxos.detalhe)), "e o detalhe CONTA quantos");
  certo(!comFluxos.ok && /1 deles estao LIGADOS/.test(String(comFluxos.detalhe)), "e quantos estao ligados");

  certo(decidirExclusao({ confirmar: true, ciente_fluxos: true, varredura: cheia }).ok, "ciente + confirmar: apaga");
  certo(decidirExclusao({ confirmar: true, ciente_fluxos: false, varredura: vazia }).ok, "sem fluxo afetado, o ciente nem e pedido");

  // a frase do impacto nao inventa numero
  eq(resumoDoImpacto([]), "nenhum fluxo de automacao referencia este arquivo", "sem afetados, a frase e essa");
  certo(/Boas-vindas/.test(resumoDoImpacto(afetados)), "com afetados, a frase NOMEIA os fluxos");
}

// ═══════════════════════════════ C) QUEM USA ESTE ANEXO — por FORMA, nunca por frase

// C.1 A leitura caminha os nos e le `acao.tipo`.
{
  const fluxo = {
    nos: [
      // mensagem que CITA a chave: nao e passo que USA a chave
      { id: "n1", acao: { tipo: "enviar_texto", texto: "veja a tabela-precos no site" } },
      { id: "n2", acao: { tipo: ACAO_ANEXO, anexo: "Tabela-Precos" } },
      { id: "n3", desligado: true, acao: { tipo: ACAO_ANEXO, anexo: "tabela-precos" } },
      { id: "n4", acao: { tipo: ACAO_ANEXO, anexo: "  " } },
      { acao: { tipo: ACAO_ANEXO, anexo: "outro" } },
      { id: "n6", acao: null },
      { id: "n7" },
    ],
  };
  const refs = referenciasDeAnexoNoFluxo(fluxo);
  dep(
    refs.map((r) => [r.no_id, r.chave, r.desligado]),
    [
      ["n2", "tabela-precos", false],
      ["n3", "tabela-precos", true],
      ["(sem id 5)", "outro", false],
    ],
    "le por forma: a chave normalizada, o passo desligado INCLUIDO, e no sem id identificado pela posicao"
  );
  eq(
    refs.some((r) => r.no_id === "n1"),
    false,
    "mensagem que cita a chave no TEXTO nao entra (importar nao e chamar)"
  );

  // jsonb torto nao pode derrubar a lista de impacto — ela e o que protege o apagar
  dep(referenciasDeAnexoNoFluxo(null), [], "fluxo nulo: lista vazia, sem estourar");
  dep(referenciasDeAnexoNoFluxo({ nos: "isto nao e lista" }), [], "nos torto: lista vazia, sem estourar");
  dep(referenciasDeAnexoNoFluxo({ nos: [null, 7, "x"] }), [], "nos com lixo: ignora item por item");

  const linhas: LinhaFluxo[] = [
    { slug: "a", nome: "A", ativo: true, fluxo },
    { slug: "b", nome: null, ativo: undefined, fluxo: { nos: [{ id: "x", acao: { tipo: ACAO_ANEXO, anexo: "outro" } }] } },
  ];
  const usam = fluxosQueUsamAnexo(linhas, "TABELA-PRECOS  ");
  dep(usam.map((f) => f.slug), ["a"], "a busca do impacto normaliza a chave pedida");
  eq(usam[0].passos.length, 2, "e conta os DOIS passos do mesmo fluxo");
  const semNome = fluxosQueUsamAnexo(linhas, "outro").map((f) => [f.slug, f.nome, f.ativo]);
  dep(
    semNome,
    [
      ["a", "A", true],
      ["b", "b", true],
    ],
    "fluxo sem nome usa o slug, e `ativo` ausente conta como LIGADO (fail-closed na frase do impacto)"
  );
  dep(fluxosQueUsamAnexo(linhas, ""), [], "chave vazia nao casa com tudo");

  const uso = usoPorChave(linhas);
  eq(uso["tabela-precos"], 1, "a contagem por chave conta FLUXOS, nao passos");
  eq(uso["outro"], 2, "e soma os fluxos distintos");
}

// ══════════════════════════════════════════ D) GUARDAS ESTRUTURAIS (por FORMA)

const semComentario = (fonte: string) =>
  fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const fonteDe = (caminho: string) => {
  try {
    return semComentario(readFileSync(caminho, "utf8"));
  } catch {
    return "";
  }
};

// D.1 lib/anexos.ts e PURA (zero import). E o que permite provar tudo acima sem
// banco — e o dia em que ela importar o banco, esta prova para de valer.
{
  const cru = readFileSync("lib/anexos.ts", "utf8");
  eq(/^\s*import\s/m.test(cru), false, "lib/anexos.ts nao tem import nenhum (lib pura)");
}

// D.2 A BIBLIOTECA NAO E SEGUNDA PORTA DE ENVIO.
{
  const acervo = fonteDe("app/api/anexos/route.ts");
  certo(acervo, "achei a rota do acervo");
  for (const proibido of ["zapiSend", "evoSend", "gupshupSend", "credsZapi", "credsEvolution"]) {
    eq(
      acervo.includes(proibido),
      false,
      `/api/anexos NAO fala com provedor (${proibido}): quem envia e /api/send, com as travas dele`
    );
  }
  const conversa = fonteDe("app/api/anexos/conversa/route.ts");
  certo(conversa, "achei a sub-rota de anexar na conversa");
  for (const proibido of ["zapiSend", "evoSend", "credsZapi", "credsEvolution"]) {
    eq(conversa.includes(proibido), false, `/api/anexos/conversa NAO fala com provedor (${proibido})`);
  }
  certo(/new URL\(\s*"\/api\/send"/.test(conversa), "ela DELEGA pro /api/send (a porta unica de envio)");
  certo(/redirect:\s*"manual"/.test(conversa), "e sem seguir redirect (credencial nao viaja pra outro host)");
  certo(/payloadDeEnvio\s*\(/.test(conversa), "o corpo do envio vem do montador unico (lib/anexos.ts)");
  // a URL sai do ACERVO, nunca do corpo do pedido: aceitar `media` livre faria a
  // rota encaminhar URL arbitraria assinada pelo numero da empresa
  eq(/body\?\.\s*media/.test(conversa), false, "a rota NAO aceita `media` do corpo");
  eq(/body\?\.\s*url/.test(conversa), false, "nem `url` do corpo");
  certo(/anexoPorChave|anexoPorId/.test(conversa), "o item vem do acervo, por chave ou id");
}

// D.3 A ORDEM DOS GATES na rota do acervo (gate antes do efeito; varre antes de apagar).
{
  const src = fonteDe("app/api/anexos/route.ts");
  // upload multipart e gesto de GENTE: `usuarioPorSessao` recusa x-api-key
  const post = src.slice(src.indexOf("export async function POST"), src.indexOf("export async function PATCH"));
  certo(/usuarioPorSessao\s*\(/.test(post), "o POST (upload) identifica por SESSAO");
  eq(/getUser\s*\(/.test(post), false, "e NAO por getUser: chave de API nao sobe multipart nesta rota");
  const iPermissao = post.indexOf('permitido(perfil, "anexos_enviar")');
  const iForm = post.indexOf("req.formData()");
  const iSubir = post.indexOf("subirAnexo");
  certo(iPermissao > -1 && iForm > -1 && iSubir > -1, "achei as tres marcas do POST");
  certo(iPermissao < iForm, "a permissao e conferida ANTES de bufferizar o corpo");
  certo(iPermissao < iSubir, "e muito antes de subir arquivo (gate depois do efeito e efeito parcial)");

  const del = src.slice(src.indexOf("export async function DELETE"));
  const iGate = del.indexOf('permitido(perfil, "anexos_apagar")');
  const iVarre = del.indexOf("varrerFluxos");
  const iDecide = del.indexOf("decidirExclusao");
  const iApaga = del.indexOf("apagarAnexo");
  certo(iGate > -1 && iVarre > -1 && iDecide > -1 && iApaga > -1, "achei as quatro marcas do DELETE");
  certo(iGate < iVarre, "a permissao de apagar vem primeiro");
  certo(iVarre < iDecide, "a varredura dos fluxos acontece ANTES da decisao");
  certo(iDecide < iApaga, "e a decisao vem ANTES de apagar (nunca em silencio)");
  certo(/usado_por/.test(del), "e a resposta do 409 carrega a LISTA dos fluxos (mostrar quais, nao quantos)");

  const patch = src.slice(src.indexOf("export async function PATCH"), src.indexOf("export async function DELETE"));
  certo(/decidirPatch\s*\(/.test(patch), "o PATCH decide pela funcao pura (as 4 permissoes separadas)");
  const iDecidirPatch = patch.indexOf("decidirPatch");
  const iGravar = patch.indexOf("atualizarAnexo");
  certo(iDecidirPatch > -1 && iGravar > -1 && iDecidirPatch < iGravar, "e decide ANTES de gravar");
}

// D.4 A COSTURA DO ESCOPO DE CHAVE (as varreduras de prova-seguranca-conta cobram
//     verbete; aqui a prova cobra o verbete CERTO).
{
  certo((RECURSOS as readonly string[]).includes("anexos"), "existe o recurso `anexos`");
  certo(DESCRICAO_RECURSO.anexos && DESCRICAO_RECURSO.anexos.length > 20, "com descricao de verdade");
  eq(recursoDaRota("/api/anexos"), "anexos", "o acervo vive no recurso proprio");
  // anexar na conversa e MANDAR MENSAGEM: chave de robo que dispara material nao
  // ganha o DELETE do acervo de brinde
  eq(recursoDaRota("/api/anexos/conversa"), "envio", "anexar numa conversa vive no recurso `envio`");
  // a biblioteca e da INSTALACAO, nao de um numero: assumir canal padrao aqui
  // criaria negacao falsa pra chave restrita a um canal
  eq(assumeCanalPadrao("/api/anexos", "GET"), false, "o acervo NAO assume canal padrao");
  eq(assumeCanalPadrao("/api/anexos", "DELETE"), false, "em nenhum metodo");
  eq(assumeCanalPadrao("/api/anexos/conversa", "POST"), true, "a sub-rota, que resolve canal do corpo, assume");
  const entradas = CANAL_PADRAO_EM.filter(([p]) => p.startsWith("/api/anexos")).map(([p, m]) => [p, [...m]]);
  dep(entradas, [["/api/anexos/conversa", ["POST"]]], "e existe UMA entrada na tabela, so pra sub-rota");
}

// D.5 AS QUATRO PERMISSOES, o verbete obrigatorio e os papeis.
{
  const quatro = ["anexos_enviar", "anexos_apagar", "anexos_descrever", "anexos_etiquetar"] as const;
  for (const p of quatro) {
    certo((PERMISSOES as readonly string[]).includes(p), `${p} esta em PERMISSOES`);
    const verbete = (DESCRICAO_PERMISSAO as Record<string, string>)[p] ?? "";
    certo(verbete.length > 30, `${p} tem verbete de verdade`);
    certo(
      verbete.toLowerCase().includes("papel nomeado criado antes desta permissao nao a ganha sozinho"),
      `o verbete de ${p} carrega a frase que evita o "ligou e nao funcionou"`
    );
  }
  // feature nova NAO tira botao de ninguem, e tambem nao se auto-concede
  for (const p of quatro) {
    eq(
      (PAPEIS_EMBUTIDOS.normal as readonly string[]).includes(p),
      false,
      `o papel embutido "normal" NAO ganha ${p} de graca`
    );
  }
  const sup = PAPEIS_SUGERIDOS.find((p) => p.nome === "Supervisor");
  certo(sup, "existe o papel sugerido Supervisor");
  for (const p of ["anexos_enviar", "anexos_descrever", "anexos_etiquetar"]) {
    certo((sup!.permissoes as readonly string[]).includes(p), `o Supervisor sugerido recebe ${p}`);
  }
  eq(
    (sup!.permissoes as readonly string[]).includes("anexos_apagar"),
    false,
    "e NAO recebe anexos_apagar (apagar acervo e a divisao de gerenciar_canais x conectar_numero)"
  );
  // e o portao continua fail-closed pra quem nao tem: instalacao SEM papel nomeado
  // (o estado de toda instalacao existente) nao ganha nenhuma das quatro
  const semPapel = permissoesEfetivas({ papel: "normal", escopo_visao: "todas" });
  for (const p of quatro) {
    eq(pode(semPapel, p), false, `usuario sem papel nomeado nao tem ${p} (feature nova nao se auto-concede)`);
  }
  eq(pode(semPapel, "enviar"), true, "e ele continua com o que sempre teve (nenhum botao desapareceu)");
  // papel nomeado que RECEBEU a permissao, tem
  const comPapel = permissoesEfetivas({
    papel: "normal",
    escopo_visao: "proprias",
    papelPermissoes: ["enviar", "anexos_enviar"],
  });
  eq(pode(comPapel, "anexos_enviar"), true, "papel nomeado com a permissao marcada, passa");
  eq(pode(comPapel, "anexos_apagar"), false, "e as outras tres seguem negadas (as quatro sao separadas)");
  const admin = permissoesEfetivas({ papel: "super_admin", escopo_visao: "todas" });
  for (const p of quatro) {
    eq(pode(admin, p), true, `super admin tem ${p}`);
  }
}

// D.6 A CONFIG DO TAMANHO DE PAGINA existe de verdade (lib/config.ts importa banco,
//     entao aqui a guarda e sobre a FORMA do arquivo, e a regra do clamp ja foi
//     provada em A.5 pela funcao que os dois lados usam).
{
  const cfg = fonteDe("lib/config.ts");
  certo(cfg, "achei lib/config.ts");
  certo(/anexos_por_pagina:\s*number;/.test(cfg), "`anexos_por_pagina` esta no tipo da config");
  certo(/anexos_por_pagina:\s*POR_PAGINA_PADRAO/.test(cfg), "e no CONFIG_PADRAO, com o padrao medido");
  certo(
    /chave === "anexos_por_pagina"/.test(cfg) && /POR_PAGINA_MIN/.test(cfg) && /POR_PAGINA_MAX/.test(cfg),
    "a validacao usa os MESMOS limites de lib/anexos.ts (nao um par de numeros solto)"
  );
  const rota = fonteDe("app/api/anexos/route.ts");
  certo(/porPaginaValido\([^)]*cfg\.anexos_por_pagina/.test(rota), "a rota usa a config como PADRAO da listagem");
}

// D.7 A MIGRATION E ARQUIVO, e o codigo nao roda DDL.
{
  const sql = readFileSync("supabase/migrations/0024_anexos_biblioteca.sql", "utf8");
  certo(/create table if not exists/i.test(sql), "a 0024 e idempotente (create table if not exists)");
  certo(/add column if not exists/i.test(sql), "inclusive nas colunas");
  certo(/enable row level security/i.test(sql), "RLS habilitada");
  certo((sql.match(/enable row level security/gi) ?? []).length >= 2, "nas DUAS tabelas novas");
  certo(/grant[\s\S]*service_role/i.test(sql), "grant explicito pro service_role");
  // O PAPEL IMPORTA: o codigo escreve como `service_role`, entao e DELE que a
  // revogacao tem que sair. A guarda antiga procurava so `revoke update, delete on
  // mensageria.anexo_eventos` e casava com a linha de `public, anon, authenticated`
  // — uma mutacao que apagava exatamente a linha do service_role passou VERDE
  // (medido). Comparacao com o espaco normalizado, pra formatacao do SQL nao virar
  // regra.
  const sqlEmUmaLinha = sql.toLowerCase().replace(/\s+/g, " ");
  for (const papel of ["service_role", "public, anon, authenticated"]) {
    certo(
      sqlEmUmaLinha.includes(`revoke update, delete on mensageria.anexo_eventos from ${papel}`),
      `a trilha e append-only no BANCO tambem pra ${papel}`
    );
  }
  const linhas = sql.trim().split(/\r?\n/);
  certo(/notify\s+pgrst\s*,\s*'reload schema'/i.test(linhas[linhas.length - 1]), "e o notify pgrst e a ULTIMA linha");
  // codigo NUNCA cria tabela: a busca e por DDL em .ts, nao por frase
  for (const arq of ["lib/anexos-db.ts", "app/api/anexos/route.ts", "app/api/anexos/conversa/route.ts"]) {
    const src = fonteDe(arq);
    eq(/create\s+table|alter\s+table|drop\s+table/i.test(src), false, `${arq} nao executa DDL`);
  }
  // e a degradacao sem a 0024 e explicita (aviso), nunca 500 nem 200 mentiroso
  const db = fonteDe("lib/anexos-db.ts");
  certo(/erroDeSchemaAusente/.test(db), "a deteccao de migration pendente reusa o helper da casa");
  certo(/disponivel/.test(fonteDe("app/api/anexos/route.ts")), "e a rota responde `disponivel:false` com aviso");
}

// ═════════════════════════════════ E) AS DUAS COPIAS DELIBERADAS

// E.1 A CHAVE do importador tem que ser a MESMA do painel.
{
  const hostis = [
    "Tabela de Preços 2026.xlsx",
    "guia de implantacao.PDF",
    "  espaço  duplo  ",
    "ÁÉÍÓÚ ç ñ",
    "emoji 🚀 no nome.pdf",
    "###",
    "",
    "_comeca_com_underscore",
    "-comeca-com-tracinho",
    "MAIUSCULA.PDF",
    "x".repeat(200),
    `${"a".repeat(LIMITE_CHAVE - 1)}-bbb`,
    "ponto.no.meio.txt",
    "barra/no/nome.pdf",
    "2026",
    "só-símbolos-!@#$%",
  ];
  for (const nome of hostis) {
    eq(
      chaveDoImportador(nome),
      chaveDeAnexo(nome),
      `a chave do importador bate com a do painel para ${JSON.stringify(nome.slice(0, 40))}`
    );
  }
  eq(chaveDoImportador(null), chaveDeAnexo(null), "e nao-texto tambem");

  // AS ETIQUETAS TAMBEM: o catalogo da origem traz "comercial" e "Comercial" no
  // MESMO item (medido no fixture, e foi assim que a divergencia apareceu), e pra
  // quem filtra elas sao a mesma. O importador tem que dedupar como o painel.
  const listas: unknown[][] = [
    ["comercial", "Comercial", "COMERCIAL"],
    ["Preços", "precos", "PREÇOS "],
    ["  a  ", "a", ""],
    ["unica"],
    [],
    ["texto", 7, null, ["nao e texto"]],
  ];
  for (const lista of listas) {
    const doPainel = etiquetasDeAnexo(lista);
    dep(
      etiquetasDoImportador(lista),
      doPainel.ok ? doPainel.etiquetas : [],
      `as etiquetas do importador batem com as do painel para ${JSON.stringify(lista)}`
    );
  }

  // e o inventario do catalogo devolve o que o passo precisa, sem tocar em disco
  const inv = inventarioDeAnexos({
    attachments: [
      {
        _id: { $oid: "aaaaaaaaaaaaaaaaaaaaaa01" },
        name: "guia_1.pdf",
        original_name: "Guia.pdf",
        mime: "application/pdf",
        path_relative: "https://armazem.invalido/x/attached",
        size: 10,
        tags: ["Comercial", "comercial"],
      },
      {
        _id: { $oid: "aaaaaaaaaaaaaaaaaaaaaa02" },
        name: "guia_2.PDF",
        original_name: "guia.PDF",
        mime: "application/pdf",
        path_relative: "https://armazem.invalido/x/attached",
        size: 11,
      },
      {
        _id: { $oid: "aaaaaaaaaaaaaaaaaaaaaa03" },
        name: "b.svg",
        original_name: "b.svg",
        mime: "application/octet-stream",
        path_relative: "https://armazem.invalido/x/attached",
        size: 12,
      },
    ],
    total_results: 9,
    total_pages: 3,
    current_page: 1,
  });
  eq(inv.capturados, 3, "conta o que o backup capturou");
  eq(inv.total_na_origem, 9, "e o que a origem declara");
  eq(inv.parcial, true, "declarando PARCIAL (id ausente != inexistente)");
  eq(inv.itens[0].chave, "guia-pdf", "a chave sai do nome");
  dep(inv.itens[0].etiquetas, ["Comercial"], "e a etiqueta repetida em outra caixa entra UMA vez");
  eq(inv.itens[1].chave, "guia-pdf-2", "colisao ganha sufixo deterministico");
  eq(inv.itens[2].chave, null, "svg nao ganha chave...");
  certo(/recusado/.test(String(inv.itens[2].motivo)), "...e o motivo fica dito");
  eq(inv.itens[0].url, "https://armazem.invalido/x/attached/guia_1.pdf", "a URL de origem e montada como na medicao");
}

// E.2 O ESPELHO DOS LIMITES no schema do fluxo (lib/fluxo/schema.ts e PURO de
//     proposito — ele nao pode importar lib/anexos.ts, entao a copia e provada).
{
  certo((ACOES_V1 as readonly string[]).includes(ACAO_ANEXO), "a acao existe no vocabulario da v1");
  const schema = fonteDe("lib/fluxo/schema.ts");
  const limite = schema.match(/LIMITE_CHAVE_ANEXO\s*=\s*(\d+)/);
  eq(Number(limite?.[1]), LIMITE_CHAVE, "o limite de chave no schema espelha lib/anexos.ts");
  const legenda = schema.match(/LIMITE_LEGENDA_ANEXO\s*=\s*(\d+)/);
  eq(Number(legenda?.[1]), LIMITE_LEGENDA, "o limite de legenda tambem");
  const re = schema.match(/RE_CHAVE_ANEXO\s*=\s*(\/[^\n]+?\/)/);
  certo(re, "o schema tem a forma da chave");
  // a MESMA forma: exercitada, nao comparada como texto
  const formaSchema = new RegExp(re![1].slice(1, -1));
  for (const [valor, esperado] of [
    ["tabela-de-precos", true],
    ["Tabela", false],
    ["-comeca", false],
    ["a".repeat(LIMITE_CHAVE), true],
    ["a".repeat(LIMITE_CHAVE + 1), false],
  ] as [string, boolean][]) {
    eq(formaSchema.test(valor), esperado, `a forma do schema aceita/recusa ${valor.slice(0, 20)} como o painel`);
    eq(chaveJaValida(valor), esperado, "e lib/anexos.ts concorda");
  }

  // O GATE DA APROVACAO HUMANA: sem esta linha, `aprovacao: true` num passo que
  // manda ARQUIVO pro cliente seria ignorado nos dois caminhos (fila e inline).
  certo(
    (ACOES_QUE_ALCANCAM_CLIENTE as readonly string[]).includes(ACAO_ANEXO),
    "anexar_biblioteca ALCANCA O CLIENTE (e por isso a aprovacao vale nela)"
  );

  // E A VALIDACAO DO FLUXO E EXIGENTE: chave torta nao entra. A porta e
  // `validarFluxo` (o `validarAcao` e interno de proposito — quem valida um passo
  // solto valida um fluxo que nao existe).
  const comAcao = (acao: unknown) =>
    validarFluxo({
      id: "biblioteca",
      nome: "Manda o material",
      tipo: "macro",
      versao: 1,
      nos: [{ id: "n1", tipo: "acao", acao }],
    });
  certo(comAcao({ tipo: ACAO_ANEXO, anexo: "tabela-de-precos" }).ok, "passo com chave valida passa");
  certo(comAcao({ tipo: ACAO_ANEXO, anexo: "tabela-de-precos", legenda: "segue" }).ok, "com legenda tambem");
  eq(comAcao({ tipo: ACAO_ANEXO, anexo: "Tabela De Precos" }).ok, false, "chave fora da forma e RECUSADA");
  eq(comAcao({ tipo: ACAO_ANEXO }).ok, false, "passo sem `anexo` e recusado");
  eq(comAcao({ tipo: ACAO_ANEXO, anexo: "" }).ok, false, "chave vazia e recusada");
  eq(comAcao({ tipo: ACAO_ANEXO, anexo: "x".repeat(LIMITE_CHAVE + 1) }).ok, false, "chave acima do limite e recusada");
  eq(
    comAcao({ tipo: ACAO_ANEXO, anexo: "ok-assim", legenda: "x".repeat(LIMITE_LEGENDA + 1) }).ok,
    false,
    "legenda acima do limite e recusada"
  );
  const recusa = comAcao({ tipo: ACAO_ANEXO, anexo: "Tabela De Precos" });
  certo(
    !recusa.ok && recusa.erros.some((e) => /n1/.test(e) && /chave do arquivo/i.test(e)),
    "e o erro NOMEIA o passo e o campo (quem edita o fluxo tem que saber onde arrumar)"
  );
}


// D.9 A CHAVE E CONFERIDA ANTES DE ENCOSTAR NO STORAGE.
//
// O caminho do objeto e DETERMINISTICO (biblioteca/<chave>.<ext>) e `subirAnexo`
// usa upsert. Sem esta ordem, subir com uma chave que ja existe reescrevia o
// arquivo VIVO que N passos de fluxo mandam pro cliente, e o 23505 do insert
// chegava tarde: a tela dizia "ja existe um arquivo com a chave..." enquanto o
// bucket publico ja servia o arquivo novo, sem uma linha na trilha. Trocar o
// material de N fluxos em silencio e a mesma familia do apagar em silencio.
{
  const rota = fonteDe("app/api/anexos/route.ts");
  const iConfere = rota.indexOf("await anexoPorChave(chave)");
  const iSobe = rota.indexOf("await subirAnexo(");
  certo(iConfere > 0, "a rota consulta anexoPorChave antes de subir");
  certo(iSobe > 0 && iConfere < iSobe, "e a consulta vem ANTES do upload (o upload e upsert)");
  certo(
    /if \(!jaExiste\.ok\)[^;]*status: 503/.test(rota),
    "leitura que FALHOU recusa (503) — nao consegui olhar nunca vira a chave esta livre"
  );
  certo(/if \(jaExiste\.linha\)[\s\S]{0,400}?status: 409/.test(rota), "chave ocupada devolve 409 sem tocar no Storage");

  // a razao da guarda tem que continuar verdadeira: se um dia o caminho deixar de
  // ser deterministico ou a subida deixar de ser upsert, esta prova cai junto e
  // obriga alguem a reconsiderar a ordem.
  const db = fonteDe("lib/anexos-db.ts");
  certo(/upsert: true/.test(db), "a subida continua sendo upsert (a razao desta guarda)");
  // deterministico, por COMPORTAMENTO: a mesma chave da o MESMO objeto — e e
  // exatamente por isso que o upsert morde o arquivo vivo.
  eq(
    caminhoDoAnexo("guia-de-implantacao", "pdf"),
    `${PREFIXO_ANEXOS}/guia-de-implantacao.pdf`,
    "e o caminho do objeto continua derivado da chave (deterministico)"
  );
  // RESIDUO DECLARADO (4a re-revisao), o MESMO do lado do apagar: esta e uma
  // cobranca de FORMA, e forma nao segura composicao. `caminhoDoAnexo(dados.chave,
  // dados.ext).replace("biblioteca/", "conversas/")` atravessa esta linha com a
  // bateria verde e `tsc` OK — a assercao ve a chamada, nao o valor que sai dela.
  // O fechamento de verdade e `lib/anexos-db.ts` entrar na bateria (hoje nao
  // entra: `@/` nao resolve em `node --experimental-strip-types`); enquanto nao
  // entrar, o que protege o PREFIXO e o modulo puro (`caminhoDoAnexo` sem
  // prefixo-argumento, provado por comportamento acima) mais esta forma.
  certo(/caminhoDoAnexo\(\s*dados\.chave/.test(db), "e a subida usa esse caminho (chave -> objeto), nao um id novo a cada vez");

  // NAO existe porta de TROCA de arquivo hoje: o PATCH so mexe em texto. Se um dia
  // existir, ela precisa da mesma varredura de fluxos afetados que o apagar faz —
  // e esta assercao cai, de proposito, pra obrigar a decisao.
  const trechoPatch = rota.slice(rota.indexOf("export async function PATCH"));
  eq(
    /subirAnexo\(/.test(trechoPatch),
    false,
    "o PATCH nao sobe arquivo (trocar o material de N fluxos exigiria rota propria com aviso de impacto)"
  );
}


// D.10 A FONTE DO CANAL E NOMEADA, NUNCA PRESUMIDA.
//
// `enviarAnexoDaBiblioteca` caia no Z-API por `else`: hoje isso e seguro porque
// `motivoNaoAnexa` ja barrou tudo que nao e zapi/evolution — mas essa seguranca
// mora em OUTRO arquivo. Um `else` cru manda uma fonte nova pro Z-API com
// credencial de outro canal. O irmao `enviarTexto`, ao lado, sempre fez `throw`.
{
  const exec = fonteDe("lib/fluxo/executar.ts");
  const i = exec.indexOf("async function enviarAnexoDaBiblioteca");
  certo(i > 0, "enviarAnexoDaBiblioteca existe");
  const corpo = exec.slice(i, i + 4000);
  certo(/if \(c\.fonte === "evolution"\)/.test(corpo), "o ramo evolution e nomeado");
  certo(/else if \(c\.fonte === "zapi"\)/.test(corpo), "o ramo zapi tambem e NOMEADO (nao e o else)");
  certo(
    /} else {[\s\S]{0,400}?throw new Error\([^)]*nao envia anexo/.test(corpo),
    "e fonte desconhecida levanta erro em vez de cair num provedor por acidente"
  );
  // e o MOTIVO de nao anexar e calculado e USADO aqui tambem: a mutacao que o
  // calculava e jogava fora sobrevivia a bateria inteira (medido na revisao cega),
  // e o passo passaria a tentar enviar por uma fonte que nao suporta anexo.
  certo(
    /const motivo = motivoNaoAnexa[\s\S]{0,400}?if \(motivo\) throw new Error\(motivo\);/.test(corpo),
    "o motivo de nao anexar PARA o passo (nao e calculado e jogado fora)"
  );
}


// D.11 AS DUAS PORTAS DO MESMO BUCKET DECIDEM IGUAL SOBRE MARCACAO.
//
// A tela recusa `<svg>`/`<html>` pelos BYTES; o importador triava so pelo tipo
// DECLARADO pela origem. Como as duas escrevem no MESMO bucket publico, bastava a
// origem declarar `text/plain` num arquivo que comeca com `<` pra ele morar numa
// URL do dominio da instalacao. Paridade provada por COMPORTAMENTO, com os mesmos
// bytes nas duas — nao por varredura de texto.
{
  const b = (txt: string) => new TextEncoder().encode(txt);
  const bom = (txt: string) => {
    const corpo = new TextEncoder().encode(txt);
    const saida = new Uint8Array(corpo.length + 3);
    saida.set([0xef, 0xbb, 0xbf], 0);
    saida.set(corpo, 3);
    return saida;
  };
  const casos: Array<[string, Uint8Array]> = [
    ["svg cru", b("<svg xmlns=\"http://www.w3.org/2000/svg\"><script/></svg>")],
    ["html cru", b("<!doctype html><script>alert(1)</script>")],
    ["marcacao depois de espaco e quebra de linha", b("   \n\t <svg/>")],
    ["marcacao depois do BOM", bom("<svg/>")],
  ];
  for (const [oque, bytes] of casos) {
    eq(marcacaoNoInicio(bytes), true, `o importador ve marcacao: ${oque}`);
    eq(
      assinaturaDeArquivo(bytes, "text/plain"),
      null,
      `e a tela recusa os MESMOS bytes declarados text/plain: ${oque}`
    );
  }
  // e o negativo: texto de verdade e PDF passam nos dois lados
  const texto = b("nome;telefone\nmaria;11999");
  eq(marcacaoNoInicio(texto), false, "csv de verdade nao e marcacao");
  certo(
    assinaturaDeArquivo(texto, "text/csv") !== null,
    "e a tela aceita o mesmo csv (a trava e a marcacao, nao o texto)"
  );
  const pdf = b("%PDF-1.7 conteudo");
  eq(marcacaoNoInicio(pdf), false, "pdf nao comeca com marcacao");
  eq(
    assinaturaDeArquivo(pdf, "application/pdf")?.familia,
    "pdf",
    "e a tela le pdf nos mesmos bytes"
  );
}


// D.12 O ELO ENTRE A DECISAO E O BANCO — a linha que ninguem olhava.
//
// `varrerFluxosQueUsam` e pura e esta provada acima com leitor de mentira, mas ela
// so vale se `varrerFluxos` ligar essa decisao ao banco DE VERDADE. Trocar o corpo
// por `{ ok: true, afetados: [] }` deixava a bateria inteira verde e o DELETE
// passava a apagar dizendo NENHUM FLUXO USA — o apagar silencioso que esta frente
// existe pra impedir, com todas as guardas de forma intactas.
//
// Por isso a cobranca e sobre o CORPO da funcao, nao sobre o arquivo: o arquivo
// continha as marcas certas mesmo com a composicao cortada.
{
  const db = fonteDe("lib/anexos-db.ts");
  certo(
    /export function varrerFluxos\([^)]*\)[^{]*{\s*return varrerFluxosQueUsam\(chave, lerFluxosDaInstalacao\(\)\);\s*}/.test(db),
    "varrerFluxos compoe a decisao pura com o leitor REAL do banco (nada entre os dois)"
  );
  certo(
    /const r = await lerFluxosDaInstalacao\(\)\(\);/.test(db),
    "e o uso por chave da listagem le pelo MESMO leitor (uma fonte, nao duas)"
  );
  // e o leitor real traz o CORPO do fluxo: sem `fluxo` no select, a varredura
  // devolveria zero afetado sem erro nenhum — mentira com cara de verdade.
  certo(
    /\.select\(\s*"[^"]*fluxo[^"]*"/.test(db),
    "o leitor real seleciona o corpo do fluxo (sem ele, ninguem usa nada)"
  );
}


// D.13 DE QUAL OBJETO A LINHA FALA — e a trava que impede o apagar da biblioteca
// alcancar midia de conversa.
//
// Esta decisao nao tinha cobertura nenhuma (medido na revisao cega). Uma linha da
// biblioteca com `url` editada no banco apontando pra outro lugar do MESMO bucket
// faria o DELETE remover o arquivo de uma CONVERSA. A trava e o prefixo, e o
// desfecho seguro e null: sem caminho, nada e apagado.
{
  const BK = "midia-mensagens";
  const c = (u: unknown) => caminhoDeAnexoNaUrl(u, BK);
  const base = "https://xyz.supabase.co/storage/v1/object/public/midia-mensagens/";
  eq(
    c(base + "biblioteca/tabela.pdf?v=abc123"),
    "biblioteca/tabela.pdf",
    "url da biblioteca vira o caminho, sem a versao do cache"
  );
  eq(
    c(base + "biblioteca/pasta/guia.pdf"),
    "biblioteca/pasta/guia.pdf",
    "subpasta dentro do prefixo continua valendo"
  );
  eq(
    c(base + "conversas/5511999999999/foto.jpg"),
    null,
    "midia de CONVERSA nunca vira alvo de remocao por uma linha da biblioteca"
  );
  eq(
    c(base + "bibliotecaria/x.pdf"),
    null,
    "prefixo PARECIDO nao passa (a comparacao e por biblioteca/, com a barra)"
  );
  eq(
    c("https://outro.host/storage/v1/object/public/outro-bucket/biblioteca/x.pdf"),
    null,
    "outro bucket nao e o nosso, mesmo com o prefixo certo"
  );
  eq(c("http://xyz.supabase.co/storage/v1/object/public/midia-mensagens/biblioteca/x.pdf"), null, "http nao passa (so https)");
  eq(c(""), null, "vazio nao vira caminho");
  eq(c(null), null, "null nao vira caminho");
  eq(c(42), null, "numero nao vira caminho");
  eq(c("biblioteca/x.pdf"), null, "caminho solto (sem url) nao passa");
}


// D.13b O PREFIXO NAO E MAIS ARGUMENTO DE NINGUEM — e o ida-e-volta subir/apagar.
//
// A 1a versao deste bloco cobrava a FORMA de `caminhoDaUrl` por regex no fonte, e
// a re-revisao cega mediu os dois furos disso:
//
//   * NAO guardava o dano que nomeia: `removerArquivoDoAnexo` deixando de chamar
//     `caminhoDaUrl` e chamando `caminhoDentroDoBucket(url, BUCKET_ANEXOS,
//     "conversas")` passava com a bateria inteira VERDE e `tsc` OK — o DELETE da
//     biblioteca voltando a alcancar midia de CONVERSA, que e exatamente o que a
//     trava existe pra impedir.
//   * REPROVAVA CODIGO CORRETO: a mesma composicao com os dois valores em consts
//     locais (semantica identica) caia no regex. Falso positivo em guarda de
//     seguranca e o comeco do afrouxamento — o proximo que tropecar nela afrouxa,
//     e ai ela nao guarda mais nada.
//
// A causa dos dois era a mesma: o bloco pregava a FORMA DE UMA FUNCAO no lugar do
// COMPORTAMENTO do caminho de exclusao. Agora o prefixo mora em `lib/anexos.ts`
// (constante do modulo) e a trava com prefixo-argumento NAO E EXPORTADA: a mutacao
// acima virou erro de `tsc`, e o que resta e cobrado por comportamento, com URL de
// verdade. `lib/anexos-db.ts` nao entra na bateria (`@/lib` nao resolve em
// `node --experimental-strip-types`) — por isso a decisao foi PRA CA, onde entra.
{
  // 1) A PORTA PUBLICA NAO TEM ONDE ERRAR O PREFIXO. Se alguem re-exportar a
  // versao com prefixo-argumento, a mutacao volta a ser escrivivel e compilavel.
  eq(
    "caminhoDentroDoBucket" in regrasDeAnexo,
    false,
    "a trava com prefixo-argumento NAO e exportada — nao ha assinatura onde passar 'conversas'"
  );
  eq(typeof regrasDeAnexo.caminhoDeAnexoNaUrl, "function", "a porta publica e caminhoDeAnexoNaUrl(url, bucket)");
  eq(caminhoDeAnexoNaUrl.length, 2, "e ela recebe DOIS argumentos (url e bucket), nunca um terceiro pro prefixo");

  // 2) IDA E VOLTA: quem SOBE e quem APAGA falam do mesmo lugar. Prefixo trocado
  // em qualquer uma das duas pontas quebra aqui — subir num prefixo e apagar
  // noutro deixa arquivo orfao no bucket publico.
  const BK = "midia-mensagens";
  const subida = caminhoDoAnexo("tabela-de-precos", "pdf");
  eq(subida, `${PREFIXO_ANEXOS}/tabela-de-precos.pdf`, "o caminho de subida usa o prefixo do modulo");
  eq(
    caminhoDeAnexoNaUrl(`https://xyz.supabase.co/storage/v1/object/public/${BK}/${subida}?v=abc123`, BK),
    subida,
    "e a URL publica desse mesmo objeto volta a virar EXATAMENTE o caminho que subiu"
  );

  // 3) O DANO NOMEADO, medido: midia de conversa no MESMO bucket nao vira alvo,
  // seja qual for o formato do caminho. Nao ha argumento que faca ela passar.
  for (const fora of [
    "conversas/5511999999999/foto.jpg",
    "conversas/biblioteca/foto.jpg",
    "usuarios/avatar.png",
    "bibliotecaria/x.pdf",
  ]) {
    eq(
      caminhoDeAnexoNaUrl(`https://xyz.supabase.co/storage/v1/object/public/${BK}/${fora}`, BK),
      null,
      `${fora}: fora do prefixo da biblioteca, o apagar nao tem alvo`
    );
  }

  // 4) O BUCKET CONTINUA ARGUMENTO — e errar ele e FAIL-SAFE, nao fail-open. E o
  // que autoriza `lib/anexos-db.ts` a passar o `BUCKET_ANEXOS` da instalacao (env)
  // sem trazer env pro arquivo puro: bucket trocado nao casa a marca da URL,
  // devolve null, e o desfecho e "nao apaguei", nunca "apaguei o de outro".
  eq(
    caminhoDeAnexoNaUrl(`https://xyz.supabase.co/storage/v1/object/public/${BK}/${subida}`, "outro-bucket"),
    null,
    "bucket errado nao apaga nada (fail-safe medido, nao prometido)"
  );

  // 5) E O CAMINHO DE EXCLUSAO PASSA POR AQUI. Isto e o unico pedaco que sobrou
  // por FORMA, porque `lib/anexos-db.ts` nao importa na bateria — e e forma sobre
  // o CORPO da funcao que apaga, nao sobre a assinatura de um intermediario:
  // `removerArquivoDoAnexo` tem que derivar o caminho de uma porta com o prefixo
  // cravado, e nao montar caminho na mao a partir da URL.
  const db = fonteDe("lib/anexos-db.ts");
  const i = db.indexOf("export async function removerArquivoDoAnexo");
  certo(i > 0, "lib/anexos-db.ts tem removerArquivoDoAnexo");
  const remover = db.slice(i, db.indexOf("\n}", i));
  // A cobranca e SEMANTICA, nao de forma: "chama uma porta com prefixo cravado" e
  // "nao monta caminho a mao". Trocar o nome da variavel, quebrar a linha ou usar a
  // porta do arquivo puro direto continuam passando — reprovar codigo correto e o
  // comeco do afrouxamento: o proximo que tropeca na guarda afrouxa a guarda.
  certo(
    /(?<![.\w$])(?:caminhoDaUrl|caminhoDeAnexoNaUrl)\s*\(/.test(remover),
    "removerArquivoDoAnexo deriva o caminho de uma porta com o prefixo cravado"
  );
  certo(
    !/storage\/v1\/object\/public/.test(remover),
    "e nao reimplementa a extracao da URL dentro dele (seria a trava do prefixo por fora)"
  );
}

// D.14 OS GATES PROPRIOS DA SUB-ROTA DE CONVERSA.
//
// Ela DELEGA o envio pro /api/send, que gateia de novo — e por isso as mutacoes
// que arrancavam estes ifs nao quebravam nada visivel: a segunda camada salvava.
// Guarda que so existe por acidente de outra camada nao e guarda. Cada `return`
// abaixo e cobrado com o codigo dele, pra a remocao aparecer aqui e nao em
// producao no dia em que o /api/send mudar.
{
  const rota = fonteDe("app/api/anexos/conversa/route.ts");
  const i = rota.indexOf("export async function POST");
  certo(i > 0, "a sub-rota tem POST");
  const post = rota.slice(i);
  certo(/if \(!permitido\(perfil, "enviar"\)\) \{[\s\S]{0,200}?status: 403/.test(post), "anexar exige permissao de ENVIAR (nao a de administrar acervo)");
  certo(/if \(!\(await podeVerConversa\([^)]*\)\)\) \{[\s\S]{0,200}?status: 403/.test(post), "e exige poder ver a conversa (403, primeira das duas camadas)");
  certo(/if \(emb && !emb\.permite\(chatId\)\) \{[\s\S]{0,200}?status: 403/.test(post), "e respeita a restricao de contexto embutida");
  certo(
    /const motivo = motivoNaoAnexa[\s\S]{0,400}?if \(motivo\) return[^;]{0,120}status: 403/.test(post),
    "o motivo de nao anexar e CALCULADO e usado (403), nunca calculado e ignorado"
  );
  // e a URL sai do ACERVO, nunca do corpo do pedido: e o que impede a sub-rota de
  // virar porta pra mandar qualquer link com a credencial de quem pediu.
  eq(
    /body\?\.(media|url|arquivo_url)/.test(post),
    false,
    "a sub-rota nao aceita endereco vindo do corpo"
  );
}

console.log(`prova-anexos: ${assercoes} assercoes OK`);
