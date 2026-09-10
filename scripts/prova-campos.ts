// Prova do CONSTRUTOR DE FICHA — campos personalizados por instalacao
// (Frente X, card 86ak85nxn). SEM banco e SEM navegador.
//
// Roda em Node >= 22.6 sem build: `node scripts/prova-campos.ts`
// (type stripping nativo; os `import type` sao apagados, nao precisa do alias @/).
// NAO usar tsx.
//
// O que ela cobre, em tres camadas:
//
//  A) A REGRA PURA de `lib/campos.ts`: tipo, opcao, nome, valor pra gravar, valor
//     pra ler, patch da ficha, ordem, veredito de remocao, plano de renome.
//  B) AS DUAS TRAVESSIAS DE CANAL, executando de verdade com EXECUTOR INJETADO
//     (fake no lugar do banco): `medirImpacto` e `migrarRenome`. E aqui que moram
//     as decisoes que perdem historico de cliente se estiverem erradas, e prova de
//     TEXTO nao alcanca corpo de funcao — licao paga em lib/exportacao.ts no
//     micro-check de 31/08/2026.
//  C) GUARDAS ESTRUTURAIS por FORMA (nunca grep de frase de comentario): o gate de
//     cada rota, a ORDEM do renome, o 422 antes da gravacao, os verbetes de
//     `lib/escopo-chave.ts`, a forma da migration 0025 e o espelho
//     `chaveDeFicha` (schema.ts) x `chaveNormalizadaDeCampo` (variaveis.ts).

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  DESCRICAO_TIPO,
  LIMITE_DESCRICAO,
  LIMITE_NOME_CAMPO,
  LIMITE_OPCAO,
  LIMITE_VALOR_CAMPO,
  MAX_CAMPOS,
  MAX_OPCOES,
  TIPOS_CAMPO,
  acharCampo,
  aplicarPatchDeValores,
  campoDaLinha,
  chaveDeCampo,
  colisoesDeNome,
  dataCanonica,
  lerValor,
  medirImpacto,
  mesmoCampo,
  migrarRenome,
  nomeDeCampo,
  numeroCanonico,
  pendenciasObrigatorias,
  planoDeOrdem,
  planoDeRenome,
  simNaoCanonico,
  validarDefinicao,
  validarOpcoes,
  valorParaGravar,
  valoresOrfaos,
  vereditoDaRemocao,
  type CampoFicha,
  type ImpactoCampo,
  type TipoCampo,
  contagemDaResposta,
  nomeCabeNoCaminhoJsonb,
  decidirPorta,
  catalogoLido,
  falhaDeLeitura,
  decidirPatchDeCatalogo,
  decidirNomeDeCampoNovo,
  decidirColisaoNoCatalogo,
  decidirArquivamento,
  executarArquivamento,
  executarFichaConfig,
} from "../lib/campos.ts";
import { DESCRICAO_PERMISSAO } from "../lib/permissoes.ts";
import { chaveNormalizadaDeCampo } from "../lib/fluxo/variaveis.ts";
import { escopoPermite, recursoDaRota } from "../lib/escopo-chave.ts";
import {
  ACOES_V1,
  CAMPOS_CONDICAO,
  CAMPOS_CONDICAO_SO_DO_PAINEL,
  CAMPOS_SUJOS_POR_ACAO,
  avaliarCondicao,
  chaveDeFicha,
  motivoParaRecusarPuro,
  validarCondicao,
  validarFluxo,
  type CampoCondicao,
} from "../lib/fluxo/schema.ts";
import {
  CAMPOS_DA_LINHA_DE_CONVERSA,
  coletaDaLinhaDeConversa,
  colherLinhaDeConversa,
  colunasDaLinhaDeConversa,
  fatosDaLinhaDeConversa,
  pedeALinhaDeConversa,
} from "../lib/fluxo/coleta.ts";
import { efeitosDeArquivamento, efeitosDeFichaConfig, type PortaDoBanco } from "../lib/campos-efeitos.ts";

let feitos = 0;
let assercoes = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  assercoes++;
  assert.equal(a, b, msg);
};
const t = (nome: string, fn: () => void) => {
  fn();
  feitos++;
  console.log(`  ok  ${nome}`);
};
/** Igual ao `t`, pra bloco que precisa de `await` (travessia com executor). */
const ta = async (nome: string, fn: () => Promise<void>) => {
  await fn();
  feitos++;
  console.log(`  ok  ${nome}`);
};

const campo = (p: Partial<CampoFicha> & { nome: string }): CampoFicha => ({
  id: p.id ?? `id-${p.nome}`,
  nome: p.nome,
  tipo: p.tipo ?? "texto",
  obrigatorio: p.obrigatorio ?? false,
  opcoes: p.opcoes ?? [],
  descricao: p.descricao ?? null,
  ordem: p.ordem ?? 1,
  ativo: p.ativo ?? true,
});

const LIB = readFileSync(new URL("../lib/campos.ts", import.meta.url), "utf8");
const LIB_DB = readFileSync(new URL("../lib/campos-db.ts", import.meta.url), "utf8");
const ROTA_CAT = readFileSync(new URL("../app/api/campos/route.ts", import.meta.url), "utf8");
const ROTA_VAL = readFileSync(new URL("../app/api/campos/valores/route.ts", import.meta.url), "utf8");
const ROTA_FICHA = readFileSync(new URL("../app/api/ficha/route.ts", import.meta.url), "utf8");
const ROTA_CFG = readFileSync(new URL("../app/api/admin/ficha-config/route.ts", import.meta.url), "utf8");
const ESCOPO = readFileSync(new URL("../lib/escopo-chave.ts", import.meta.url), "utf8");
const EXECUTAR_FLUXO = readFileSync(new URL("../lib/fluxo/executar.ts", import.meta.url), "utf8");
const COLETA = readFileSync(new URL("../lib/fluxo/coleta.ts", import.meta.url), "utf8");
const EFEITOS = readFileSync(new URL("../lib/campos-efeitos.ts", import.meta.url), "utf8");
const MIGRACAO = readFileSync(new URL("../supabase/migrations/0025_campos_ficha.sql", import.meta.url), "utf8");
/**
 * FONTE SEM OS COMENTARIOS — e isso e requisito das guardas NEGATIVAS ("esta
 * palavra NAO pode aparecer aqui"): estes arquivos EXPLICAM em comentario a
 * decisao que a guarda mede, e varredura ingenua leria a explicacao como se fosse
 * a coisa. ("preencher a ficha nao exige `gerenciar_campos`" contem
 * `gerenciar_campos`.)
 *
 * Corta linha de comentario inteira (`//`, `*`, `/*`), nao trecho no fim de linha
 * de codigo: comentario de fim de linha e raro nestes arquivos e cortar por `//`
 * solto estragaria qualquer string com URL.
 *
 * E CORTA TAMBEM O COMENTARIO JSX — o bloco entre chaves do TSX —, que nao cabe no filtro por
 * linha: so a PRIMEIRA linha dele comeca com `{`, e as de dentro comecam com
 * palavra. Medido na 3a rodada da re-revisao cega: o bloco 45 lia `app/home.tsx`
 * CRU, e o comentario que explica a saida do botao contem `ativo:false` — ele so
 * escapava da assercao `/ativo: false/` por nao ter espaco depois dos dois-pontos.
 * Reescrever o comentario deixaria a bateria VERMELHA sem mudar comportamento
 * nenhum, que e o mesmo teatro que a guarda existe pra evitar.
 *
 * A ORDEM importa: o filtro por linha roda ANTES, senao um `/*` que aparece dentro
 * de comentario `//` (`app/campos/**`, `/api/admin/*`) abriria um bloco falso e a
 * varredura engoliria codigo de verdade ate o proximo fechamento de bloco.
 */
const semComentario = (fonte: string) =>
  fonte
    .split("\n")
    .filter((l) => {
      const s = l.trim();
      return !(s.startsWith("//") || s.startsWith("*") || s.startsWith("/*"));
    })
    .join("\n")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

// SQL SEM OS COMENTARIOS: guarda de FORMA nao pode casar com o texto do
// comentario — o cabecalho da 0025 EXPLICA por que nao se usa `ilike`, e uma
// varredura ingenua leria a explicacao como se fosse a coisa.
const SQL_SEM_COMENTARIO = MIGRACAO.split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const TELA = readFileSync(new URL("../app/admin-campos.tsx", import.meta.url), "utf8");
const HOME = readFileSync(new URL("../app/home.tsx", import.meta.url), "utf8");

/**
 * O CORPO DE UMA FUNCAO, e nao "os proximos N caracteres do arquivo".
 *
 * Guarda que mede corpo por `slice(i, i + 3000)` mede tambem o que veio DEPOIS da
 * funcao — e passa a quebrar (ou a passar por engano) quando alguem so mexe na
 * funcao vizinha. Aqui o recorte vai da assinatura ate a proxima declaracao de
 * topo, entao a assercao fala da funcao, nao da forma do arquivo.
 */
const corpoDaFuncao = (fonte: string, assinatura: string): string => {
  const i = fonte.indexOf(assinatura);
  if (i < 0) return "";
  const resto = fonte.slice(i + assinatura.length);
  const fim = resto.search(/\n(export |async function |function |const |type )/);
  return assinatura + (fim < 0 ? resto : resto.slice(0, fim));
};
const PAGINA = readFileSync(new URL("../app/campos/page.tsx", import.meta.url), "utf8");
const FICHA_UI = readFileSync(new URL("../app/ficha-campos.tsx", import.meta.url), "utf8");

console.log("\n— A) a regra pura");

// ═══════════════════════════════════════════════════════ 1) tipos
t("os cinco tipos, cada um com verbete (tipo sem verbete nao existe)", () => {
  assert.deepEqual([...TIPOS_CAMPO], ["texto", "numero", "data", "lista", "sim_nao"]);
  assert.deepEqual(Object.keys(DESCRICAO_TIPO).sort(), [...TIPOS_CAMPO].sort());
  for (const tipo of TIPOS_CAMPO) {
    eq(!!DESCRICAO_TIPO[tipo]?.trim(), true, `tipo ${tipo} sem verbete`);
  }
  // O QUE FICOU FORA e DECLARADO no fonte com o motivo — decisao registrada nao e
  // decisao esquecida. Guarda por FORMA: a lista de fora tem que citar as quatro.
  for (const fora of ["moeda", "data e hora", "multipla escolha", "arquivo"]) {
    eq(LIB.toLowerCase().includes(fora), true, `o tipo descartado "${fora}" nao esta declarado no fonte`);
  }
});

// ═══════════════════════════════════════════════ 2) nome, chave, e o ILIKE
t("nome saneado: espaco colapsa, controle e tamanho recusam", () => {
  eq(nomeDeCampo("  Nome   da    empresa "), "Nome da empresa", "espaco colapsa");
  eq(nomeDeCampo(""), null, "vazio nao e nome");
  eq(nomeDeCampo("   "), null, "so espaco nao e nome");
  eq(nomeDeCampo(42), null, "numero nao e nome");
  eq(nomeDeCampo(null), null, "nulo nao e nome");
  eq(nomeDeCampo("a".repeat(LIMITE_NOME_CAMPO)), "a".repeat(LIMITE_NOME_CAMPO), "no teto passa");
  eq(nomeDeCampo("a".repeat(LIMITE_NOME_CAMPO + 1)), null, "um acima do teto recusa");
  // quebra de linha viraria uma CHAVE de jsonb que ninguem consegue digitar de novo
  eq(nomeDeCampo("CNPJ\nda empresa"), "CNPJ da empresa", "quebra de linha e espaco, nao controle no meio");
  eq(nomeDeCampo(`CNPJ${String.fromCharCode(0)}`), null, "NUL no nome recusa");
});

t("A ARMADILHA DO ILIKE: `%` e `_` do usuario NUNCA viram coringa", () => {
  // Armadilha conhecida deste repo: campo de texto vindo de gente usado em busca
  // `ilike` transforma `%` em "qualquer coisa" e `_` em "um caractere qualquer".
  // Aqui a identidade e SEMPRE igualdade normalizada.
  eq(mesmoCampo("CNPJ", "cnpj"), true, "caixa nao separa");
  eq(mesmoCampo("Endereco", "Endereço"), true, "acento nao separa");
  eq(mesmoCampo("Nome da empresa", "nome_da_empresa"), true, "espaco e underline sao o mesmo separador");
  // o coringa NAO casa com nada alem do que ele literalmente e
  eq(mesmoCampo("%", "CNPJ"), false, "`%` nao casa com qualquer campo");
  eq(mesmoCampo("%", "%"), false, "nome que normaliza pra vazio nao casa nem com ele mesmo (fail-closed)");
  eq(mesmoCampo("CNP_", "CNPJ"), false, "`_` nao casa com um caractere qualquer");
  eq(mesmoCampo("CN%J", "CNPJ"), false, "`%` no meio nao vira coringa");
  eq(mesmoCampo("cnpj%", "cnpj da empresa"), false, "`%` no fim nao vira prefixo");
  // e nao ha `ilike` nem `like` em nenhuma das duas camadas desta frente
  eq(/\.i?like\(/.test(semComentario(LIB + LIB_DB + ROTA_CAT + ROTA_VAL)), false, "apareceu um like/ilike nesta frente");
  eq(/\bilike\b/i.test(SQL_SEM_COMENTARIO), false, "apareceu ilike na migration");
});

t("nome que normaliza pra vazio e RECUSADO no cadastro", () => {
  // "%" pareceria funcionar (a escrita casa por nome EXATO) e falharia calado em
  // tres lugares: `!campo.<chave>`, condicao de ficha e deteccao de colisao.
  for (const ruim of ["%", "---", "...", "!!!", "  &  "]) {
    const v = validarDefinicao({ nome: ruim });
    eq(v.ok, false, `"${ruim}" nao pode ser nome de campo`);
    if (!v.ok) assert.match(v.erros.join("; "), /letra ou numero/i);
    assercoes++;
  }
  eq(validarDefinicao({ nome: "Sala 3" }).ok, true, "nome com numero passa");
  eq(validarDefinicao({ nome: "CNPJ" }).ok, true, "nome com letra passa");
});

t("acharCampo: EXATO, depois normalizado UNICO; ambiguo nao e chute", () => {
  const cat = [campo({ nome: "CNPJ" }), campo({ nome: "cnpj" }), campo({ nome: "Cidade" })];
  // exato ganha mesmo havendo colisao normalizada
  eq((acharCampo(cat, "CNPJ") as any).campo.nome, "CNPJ", "exato vence");
  eq((acharCampo(cat, "cnpj") as any).campo.nome, "cnpj", "o outro exato tambem");
  // sem exato, a colisao e AMBIGUA: escolher um seria decidir por ordem de linha
  eq((acharCampo(cat, "CnPj") as any).erro, "ambiguo", "colisao normalizada nao escolhe sozinha");
  eq((acharCampo(cat, "cidade") as any).campo.nome, "Cidade", "normalizado unico resolve");
  eq((acharCampo(cat, "nada") as any).erro, "nao_existe");
  eq((acharCampo(cat, "") as any).erro, "nao_existe");
  eq((acharCampo(cat, "%") as any).erro, "nao_existe", "coringa nao acha campo");
  eq((acharCampo([], "CNPJ") as any).erro, "nao_existe");
});

// ═══════════════════════════════════════════════════════ 3) opcoes
t("opcoes: duplicata normalizada e RECUSA, nunca dedupe silencioso", () => {
  const ok = validarOpcoes(["A vista", "Parcelado"]);
  eq(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.opcoes, ["A vista", "Parcelado"]);
  assercoes++;
  const dup = validarOpcoes(["A vista", "A VISTA"]);
  eq(dup.ok, false, "duas opcoes indistinguiveis: uma delas nunca seria escolhivel");
  if (!dup.ok) assert.match(dup.erro, /repetida/i);
  assercoes++;
  eq(validarOpcoes(["A vista", "À Vista"]).ok, false, "acento tambem colide");
  eq(validarOpcoes([]).ok, true, "lista vazia e valida aqui (quem exige opcao e o tipo lista)");
  eq(validarOpcoes(undefined).ok, true);
  eq(validarOpcoes("A,B").ok, false, "texto nao e lista de opcoes");
  eq(validarOpcoes([1, 2]).ok, false, "opcao precisa ser texto");
  eq(validarOpcoes(["  "]).ok, false, "opcao vazia recusa");
  eq(validarOpcoes(["a".repeat(LIMITE_OPCAO + 1)]).ok, false, "opcao acima do teto recusa");
  eq(validarOpcoes(new Array(MAX_OPCOES).fill(0).map((_, i) => `op${i}`)).ok, true, "no teto passa");
  eq(validarOpcoes(new Array(MAX_OPCOES + 1).fill(0).map((_, i) => `op${i}`)).ok, false, "um acima recusa");
});

// ═══════════════════════════════════════════════════ 4) definicao
t("definicao: lista sem opcao recusa, e tipo != lista COM opcoes tambem", () => {
  eq(validarDefinicao({ nome: "Plano", tipo: "lista" }).ok, false, "select vazio e campo impossivel de preencher");
  eq(validarDefinicao({ nome: "Plano", tipo: "lista", opcoes: ["Mensal"] }).ok, true);
  // descartar as opcoes calado faria o admin trocar o tipo, salvar e perder a lista
  const v = validarDefinicao({ nome: "Idade", tipo: "numero", opcoes: ["1", "2"] });
  eq(v.ok, false, "tipo que nao usa opcoes com opcoes preenchidas: recusa, nao descarte");
  if (!v.ok) assert.match(v.erros.join("; "), /nao descarto calado/i);
  assercoes++;
});

t("definicao: `obrigatorio` e booleano DE VERDADE", () => {
  for (const ruim of ["true", "false", 1, 0, "sim", null]) {
    eq(validarDefinicao({ nome: "X", obrigatorio: ruim }).ok, false, `obrigatorio: ${JSON.stringify(ruim)} recusa`);
  }
  eq(validarDefinicao({ nome: "X", obrigatorio: true }).ok, true);
  const v = validarDefinicao({ nome: "X", obrigatorio: false });
  eq(v.ok, true);
  if (v.ok) eq(v.campo.obrigatorio, false, "false explicito nao vira true por `!!`");
  eq(validarDefinicao({ nome: "X" }).ok, true, "ausente = nao obrigatorio");
});

t("definicao: tipo desconhecido recusa; ausente cai em texto; descricao tem teto", () => {
  eq(validarDefinicao({ nome: "X", tipo: "cpf" }).ok, false, "tipo inventado recusa");
  eq(validarDefinicao({ nome: "X", tipo: "TEXTO" }).ok, false, "tipo e literal, nao case-insensitive");
  const v = validarDefinicao({ nome: "X" });
  if (v.ok) eq(v.campo.tipo, "texto", "sem tipo = texto (o comportamento de hoje)");
  eq(validarDefinicao({ nome: "X", descricao: "a".repeat(LIMITE_DESCRICAO + 1) }).ok, false);
  const d = validarDefinicao({ nome: "X", descricao: "   " });
  eq(d.ok, true);
  if (d.ok) eq(d.campo.descricao, null, "descricao so de espaco vira nula");
  eq(validarDefinicao({ nome: "X", descricao: 9 }).ok, false, "descricao precisa ser texto");
});

// ═══════════════════════════════════════════════ 5) numero (o mais delicado)
t("numero: aceita os dialetos e RECUSA a ambiguidade de `1.234`", () => {
  const n = (s: string) => numeroCanonico(s);
  eq((n("1234") as any).valor, "1234");
  eq((n("1234.56") as any).valor, "1234.56", "ponto decimal (dialeto de sistema)");
  eq((n("1234,56") as any).valor, "1234.56", "virgula decimal (dialeto de gente)");
  eq((n("1.234,56") as any).valor, "1234.56", "milhar com ponto + decimal com virgula");
  eq((n("1.234.567,89") as any).valor, "1234567.89");
  eq((n("-12") as any).valor, "-12");
  eq((n("  42  ") as any).valor, "42");
  eq((n("0") as any).valor, "0", "zero e um numero");
  // A AMBIGUIDADE REAL: `1.234` e mil duzentos e trinta e quatro (pt-BR) ou 1,234
  // (en-US)? Chutar erra por fator 1000 em campo de dinheiro e de quantidade.
  const amb = n("1.234");
  eq(amb.ok, false, "`1.234` nao pode ser adivinhado");
  if (!amb.ok) {
    assert.match(amb.erro, /1234/, "a recusa tem que MOSTRAR a leitura como milhar");
    assert.match(amb.erro, /1,234|1\.234/, "...e a leitura como decimal");
    assercoes += 2;
  }
  // a AMBIGUIDADE E ESTREITA de proposito: ela existe SO na forma que serve as
  // duas leituras (1 a 3 digitos, ponto, exatamente 3 digitos). Fora dela, o ponto
  // e decimal e nao ha o que adivinhar — recusar tudo com ponto faria a tela
  // rejeitar `12.34`, que veio de um sistema e nao tem duplo sentido nenhum.
  eq((n("1.2345") as any).valor, "1.2345", "4 casas depois do ponto nao e grupo de milhar: e decimal");
  eq((n("12.34") as any).valor, "12.34", "duas casas depois do ponto: decimal, sem ambiguidade de milhar");
  eq((n("1234.567") as any).valor, "1234.567", "parte inteira de 4 digitos ja nao serve de milhar");
  eq(n("1.23.4").ok, false, "grupos de milhar irregulares recusam");
  eq(n("abc").ok, false);
  eq(n("").ok, false);
  eq(n("1,2,3").ok, false, "duas virgulas nao formam numero");
  eq(n("R$ 10").ok, false, "moeda nao e numero (o tipo moeda ficou declarado de fora)");
  eq(n("1e3").ok, false, "notacao cientifica nao entra por acidente");
});

// ═══════════════════════════════════════════════════════ 6) data
t("data: dd/mm/aaaa e aaaa-mm-dd, calendario de verdade, ano de 2 digitos RECUSA", () => {
  const d = (s: string) => dataCanonica(s);
  eq((d("17/10/2026") as any).valor, "2026-10-17");
  eq((d("2026-10-17") as any).valor, "2026-10-17");
  eq((d("05/1/2026") as any).valor, "2026-01-05", "dia/mes sem zero a esquerda passa");
  eq((d("29/02/2024") as any).valor, "2024-02-29", "ano bissexto existe");
  eq(d("29/02/2026").ok, false, "2026 nao e bissexto");
  eq(d("31/02/2026").ok, false, "fevereiro nao tem 31");
  eq(d("31/04/2026").ok, false, "abril nao tem 31");
  eq(d("00/10/2026").ok, false);
  eq(d("17/13/2026").ok, false);
  // ANO DE 2 DIGITOS: "17/10/24" e 2024, 1924 ou 2124? Data errada em campo de
  // vencimento e cobranca errada.
  eq(d("17/10/24").ok, false, "ano de 2 digitos nao pode ser adivinhado");
  eq(d("10-17-2026").ok, false, "mm-dd-aaaa nao entra");
  eq(d("2026/10/17").ok, false, "aaaa/mm/dd nao entra (uma forma por dialeto)");
  eq(d("hoje").ok, false);
  eq(d("").ok, false);
});

// ═══════════════════════════════════════════════════════ 7) sim/nao
t("sim_nao: dialeto largo na entrada, dois valores na saida", () => {
  for (const s of ["sim", "SIM", "Sim", " s ", "true", "1", "yes", "y", "verdadeiro"]) {
    const r = simNaoCanonico(s);
    eq(r.ok && r.valor === "sim", true, `"${s}" e sim`);
  }
  for (const s of ["nao", "NAO", "não", "n", "false", "0", "no", "falso"]) {
    const r = simNaoCanonico(s);
    eq(r.ok && r.valor === "nao", true, `"${s}" e nao`);
  }
  // O DIALETO E LARGO, NAO INFINITO: o que nao esta no conjunto e RECUSADO com o
  // texto de volta, em vez de virar "nao" por descarte. "ok" parece sim e "talvez"
  // nao e resposta binaria — as duas viram valor errado se alguem chutar.
  for (const s of ["talvez", "ok", "claro", "-", "2", ""]) {
    eq(simNaoCanonico(s).ok, false, `"${s}" nao pode ser adivinhado como sim/nao`);
  }
});

// ═══════════════════════════════════════════════ 8) valor pra gravar
t("valor: RECUSA em vez de CORTAR acima do teto", () => {
  const c = campo({ nome: "Endereco" });
  const grande = "a".repeat(LIMITE_VALOR_CAMPO + 1);
  const r = valorParaGravar(c, grande);
  eq(r.ok, false, "o caminho antigo fazia slice(0,1000) e ninguem era avisado");
  if (!r.ok) {
    assert.match(r.erro, new RegExp(String(LIMITE_VALOR_CAMPO)), "a recusa diz o teto");
    assert.match(r.erro, new RegExp(String(LIMITE_VALOR_CAMPO + 1)), "...e o tamanho que veio");
    assercoes += 2;
  }
  eq((valorParaGravar(c, "a".repeat(LIMITE_VALOR_CAMPO)) as any).valor?.length, LIMITE_VALOR_CAMPO, "no teto passa");
});

t("valor: vazio limpa, tipo aplica, lista casa por igualdade normalizada", () => {
  const texto = campo({ nome: "Obs" });
  eq((valorParaGravar(texto, null) as any).valor, null, "nulo = limpar");
  eq((valorParaGravar(texto, "   ") as any).valor, null, "so espaco = limpar");
  eq((valorParaGravar(texto, "  oi  ") as any).valor, "oi", "texto e trimado");
  eq((valorParaGravar(texto, 42) as any).valor, "42", "numero vira texto");
  eq((valorParaGravar(texto, false) as any).valor, "false", "booleano vira texto");
  eq(valorParaGravar(texto, { a: 1 }).ok, false, "objeto nao e valor de campo");
  eq(valorParaGravar(texto, ["a"]).ok, false, "lista nao e valor de campo");

  const num = campo({ nome: "Valor", tipo: "numero" });
  eq((valorParaGravar(num, "1.234,56") as any).valor, "1234.56", "grava canonico, nao o que foi digitado");
  eq(valorParaGravar(num, "mais ou menos").ok, false);

  const lista = campo({ nome: "Plano", tipo: "lista", opcoes: ["A vista", "Parcelado"] });
  eq((valorParaGravar(lista, "a vista") as any).valor, "A vista", "grava o texto COMO O ADMIN CADASTROU");
  eq((valorParaGravar(lista, "  À VISTA ") as any).valor, "A vista", "acento e caixa nao criam linha nova no relatorio");
  const fora = valorParaGravar(lista, "Boleto");
  eq(fora.ok, false, "valor fora do catalogo recusa");
  if (!fora.ok) assert.match(fora.erro, /A vista, Parcelado/, "a recusa LISTA as opcoes validas");
  assercoes++;
  eq(valorParaGravar(lista, "%").ok, false, "coringa nao seleciona opcao");

  const sn = campo({ nome: "Aceitou", tipo: "sim_nao" });
  eq((valorParaGravar(sn, "S") as any).valor, "sim");
  const data = campo({ nome: "Vence", tipo: "data" });
  eq((valorParaGravar(data, "17/10/2026") as any).valor, "2026-10-17");
});

// ═══════════════════════════════════════════════ 9) valor pra ler
t("leitura TOLERANTE: nunca reescreve, nunca esconde, e o teto NAO reprova", () => {
  const num = campo({ nome: "Valor", tipo: "numero" });
  // o acervo e ANTERIOR aos tipos: o sync grava texto livre desde sempre
  const r = lerValor(num, "a combinar");
  eq(r?.texto, "a combinar", "mostra o que esta gravado");
  eq(r?.canonico, null, "nao inventa numero");
  eq(r?.fora_do_formato, true, "marca, em vez de esconder");
  eq(!!r?.motivo, true, "e diz o motivo, pra alguem consertar com contexto");
  const ok = lerValor(num, "1234,5");
  eq(ok?.fora_do_formato, false);
  eq(ok?.canonico, "1234.5");
  eq(ok?.texto, "1234,5", "o texto original sobrevive ao lado do canonico");

  // O SYNC GRAVA ATE 5000 CHARS: chamar isso de "fora do formato" seria mentir
  // sobre o dado da operacao. O teto vale na ESCRITA, nao na leitura.
  const texto = campo({ nome: "Obs" });
  const enorme = "x".repeat(5000);
  eq(lerValor(texto, enorme)?.fora_do_formato, false, "valor legado grande nao e 'fora do formato'");
  eq(lerValor(texto, enorme)?.texto.length, 5000, "e ele nao e cortado na leitura");

  // opcao que saiu do catalogo continua VISIVEL
  const lista = campo({ nome: "Plano", tipo: "lista", opcoes: ["Mensal"] });
  const antiga = lerValor(lista, "Trimestral");
  eq(antiga?.texto, "Trimestral", "opcao removida do catalogo nao apaga o valor gravado");
  eq(antiga?.fora_do_formato, true);

  eq(lerValor(texto, null), null, "sem valor = null (nao string vazia)");
  eq(lerValor(texto, "   "), null);
  eq(lerValor(texto, { a: 1 }), null, "objeto no jsonb nao tem valor legivel");
  eq(lerValor(texto, []), null);
  // false e 0 SAO valores
  eq(lerValor(texto, 0)?.texto, "0", "zero e um valor");
  eq(lerValor(texto, false)?.texto, "false", "false e um valor");
  eq(lerValor(campo({ nome: "A", tipo: "sim_nao" }), "nao")?.fora_do_formato, false, "'nao' e resposta valida");
});

// ═══════════════════════════════════════════════ 10) o patch da ficha
t("patch: TUDO OU NADA, e o recusado nao entra em `aplicados`", () => {
  const cat = [
    campo({ nome: "CNPJ" }),
    campo({ nome: "Valor", tipo: "numero" }),
    campo({ nome: "Antigo", ativo: false }),
  ];
  const r = aplicarPatchDeValores(cat, { CNPJ: "111" }, { CNPJ: "222", Valor: "nao sei" });
  eq(r.recusados.length, 1, "um campo recusado");
  eq(r.recusados[0].campo, "Valor");
  eq(r.aplicados.length, 1, "o outro foi calculado...");
  // ...e quem grava e a ROTA, que devolve 422 e NAO grava nada quando ha recusa.
  // A guarda dessa ordem esta no bloco C (forma da rota).
  eq(r.ficha.CNPJ, "222");

  // campo que nao existe: RECUSA, nunca descarte calado com 200
  const fantasma = aplicarPatchDeValores(cat, {}, { Fantasma: "x" });
  eq(fantasma.recusados.length, 1);
  assert.match(fantasma.recusados[0].motivo, /nao existe/i);
  assercoes++;
  // campo ARQUIVADO nao e escrevivel (ele saiu do formulario)
  const arq = aplicarPatchDeValores(cat, {}, { Antigo: "x" });
  eq(arq.recusados.length, 1, "arquivado nao aceita escrita nova");
  // ambiguidade recusa em vez de escolher
  const amb = aplicarPatchDeValores([campo({ nome: "CNPJ" }), campo({ nome: "cnpj" })], {}, { CnPj: "1" });
  eq(amb.recusados.length, 1);
  assert.match(amb.recusados[0].motivo, /mais de um campo/i);
  assercoes++;
});

t("patch: `obrigatorio` impede ESVAZIAR o que ja tem valor (e so isso)", () => {
  const cat = [campo({ nome: "CNPJ", obrigatorio: true })];
  // esvaziar campo obrigatorio COM valor: recusa
  const r1 = aplicarPatchDeValores(cat, { CNPJ: "111" }, { CNPJ: "" });
  eq(r1.recusados.length, 1, "apagar dado obrigatorio existente recusa");
  // esvaziar campo obrigatorio VAZIO: nao ha o que perder
  const r2 = aplicarPatchDeValores(cat, {}, { CNPJ: "" });
  eq(r2.recusados.length, 0, "campo vazio continua vazio, sem drama");
  // trocar o valor: sempre pode
  const r3 = aplicarPatchDeValores(cat, { CNPJ: "111" }, { CNPJ: "222" });
  eq(r3.ficha.CNPJ, "222");
  eq(r3.recusados.length, 0);
  // NAO EXISTE gate de "preencha antes de concluir": nenhum caminho aqui exige
  // pendencia zerada pra aceitar patch de OUTRO campo
  const cat2 = [campo({ nome: "CNPJ", obrigatorio: true }), campo({ nome: "Cidade" })];
  const r4 = aplicarPatchDeValores(cat2, {}, { Cidade: "Cotia" });
  eq(r4.recusados.length, 0, "campo obrigatorio vazio nao trava a ficha inteira");
  eq(r4.ficha.Cidade, "Cotia");
});

t("patch: valor legado NAO listado no pedido sobrevive (patch, nao PUT)", () => {
  const cat = [campo({ nome: "CNPJ" })];
  const r = aplicarPatchDeValores(cat, { CNPJ: "1", "Chave orfa": "guardado" }, { CNPJ: "2" });
  eq(r.ficha["Chave orfa"], "guardado", "chave que ninguem mencionou nao pode ser apagada pelo patch");
  eq(r.ficha.CNPJ, "2");
  // jsonb com numero/booleano gravado por fora vira texto, nao desaparece
  const r2 = aplicarPatchDeValores(cat, { Legado: 7, Flag: true } as any, { CNPJ: "1" });
  eq(r2.ficha.Legado, "7");
  eq(r2.ficha.Flag, "true");
});

// ═══════════════════════════════════════ 11) pendencia e valor orfao
t("pendencia: `false` e `0` CONTAM como valor preenchido", () => {
  const cat = [
    campo({ nome: "Aceitou", tipo: "sim_nao", obrigatorio: true }),
    campo({ nome: "Desconto", tipo: "numero", obrigatorio: true }),
    campo({ nome: "CNPJ", obrigatorio: true }),
    campo({ nome: "Opcional" }),
    campo({ nome: "Arquivado", obrigatorio: true, ativo: false }),
  ];
  assert.deepEqual(pendenciasObrigatorias(cat, { Aceitou: false, Desconto: 0 }), ["CNPJ"]);
  assercoes++;
  assert.deepEqual(pendenciasObrigatorias(cat, {}), ["Aceitou", "Desconto", "CNPJ"]);
  assercoes++;
  assert.deepEqual(pendenciasObrigatorias(cat, { CNPJ: "   " }), ["Aceitou", "Desconto", "CNPJ"], "espaco nao e valor");
  assercoes++;
  assert.deepEqual(pendenciasObrigatorias([], {}), [], "sem campo, sem pendencia");
  assercoes++;
});

t("valor orfao: o defeito que ESTAVA em producao fica visivel", () => {
  const cat = [campo({ nome: "CNPJ" }), campo({ nome: "Antigo", ativo: false })];
  const ficha = { CNPJ: "1", Antigo: "valor de 2024", "Veio do sync": "x", Vazio: "  " };
  const orfaos = valoresOrfaos(cat, ficha);
  assert.deepEqual(
    orfaos.map((o) => o.chave).sort(),
    ["Antigo", "Veio do sync"],
    "valor de campo arquivado e chave sem cadastro aparecem; campo ativo e valor vazio nao"
  );
  assercoes++;
  eq(orfaos.find((o) => o.chave === "Antigo")?.valor, "valor de 2024", "com o conteudo, nao so a chave");
  eq(valoresOrfaos(cat, null).length, 0);
  eq(valoresOrfaos([], { A: "1" }).length, 1, "catalogo vazio: TODO valor e orfao");
});

// ═══════════════════════════════════════════════════════ 12) ordem
t("ordem: exige a lista COMPLETA dos ativos (parcial embaralha a ficha)", () => {
  const cat = [
    campo({ nome: "A", ordem: 1 }),
    campo({ nome: "B", ordem: 2 }),
    campo({ nome: "C", ordem: 3 }),
    campo({ nome: "Z", ordem: 9, ativo: false }),
  ];
  const ok = planoDeOrdem(cat, ["C", "A", "B"]);
  eq(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.ordens, [{ id: "id-C", ordem: 1 }, { id: "id-A", ordem: 2 }, { id: "id-B", ordem: 3 }]);
  assercoes++;
  const parcial = planoDeOrdem(cat, ["C", "A"]);
  eq(parcial.ok, false, "lista parcial deixaria ordem empatada, e empate o banco resolve como quiser");
  if (!parcial.ok) assert.match(parcial.erro, /faltou: B/);
  assercoes++;
  eq(planoDeOrdem(cat, ["A", "A", "B", "C"]).ok, false, "nome repetido recusa");
  eq(planoDeOrdem(cat, ["A", "B", "C", "Z"]).ok, false, "arquivado nao entra na ordem da ficha");
  eq(planoDeOrdem(cat, ["A", "B", "C", "Fantasma"]).ok, false);
  eq(planoDeOrdem(cat, "A,B,C").ok, false, "ordem precisa ser lista");
  eq(planoDeOrdem(cat, null).ok, false);
  // normalizado tambem resolve (a tela manda o nome do catalogo, o MCP pode mandar caixa diferente)
  eq(planoDeOrdem(cat, ["c", "a", "b"]).ok, true);
});

// ═══════════════════════════════════════ 13) veredito e plano de renome
const imp = (por_canal: { canal: string; conversas: number | null }[]): ImpactoCampo => ({
  por_canal,
  conversas: por_canal.reduce((s, p) => s + (p.conversas ?? 0), 0),
  incompleto: por_canal.some((p) => p.conversas === null),
});

t("remover: zero medido remove; com valor manda ARQUIVAR; contagem falha RECUSA", () => {
  eq(vereditoDaRemocao(imp([{ canal: "central", conversas: 0 }])).acao, "remover", "cadastro errado sem valor: apaga");
  eq(vereditoDaRemocao(imp([{ canal: "central", conversas: 1 }])).acao, "arquivar", "1 valor ja e historico de cliente");
  eq(vereditoDaRemocao(imp([{ canal: "central", conversas: 0 }, { canal: "api", conversas: 3 }])).acao, "arquivar");
  // CONTAGEM QUE FALHOU NAO E CONTAGEM ZERO — freio que falha aberto nao e freio
  eq(vereditoDaRemocao(imp([{ canal: "central", conversas: 0 }, { canal: "api", conversas: null }])).acao, "recusar");
  const v = vereditoDaRemocao(imp([{ canal: "central", conversas: 12 }]));
  assert.match(v.motivo, /12/, "o motivo carrega o NUMERO (e ele que aparece na tela)");
  assert.match(v.motivo, /valores sem campo/i, "e aponta pra onde os valores continuam visiveis");
  assercoes += 2;
});

t("renome: sem valor troca o rotulo; com valor exige a 0025; contagem falha RECUSA", () => {
  const semValor = imp([{ canal: "central", conversas: 0 }]);
  const comValor = imp([{ canal: "central", conversas: 40 }]);
  const cego = imp([{ canal: "central", conversas: null }]);

  const a = planoDeRenome(semValor, false);
  eq(a.ok, true, "campo sem valor: renomear e so trocar o rotulo, ate sem a migration");
  if (a.ok) eq(a.migrar, false, "e nao ha nada pra migrar");

  const b = planoDeRenome(comValor, true);
  eq(b.ok, true);
  if (b.ok) eq(b.migrar, true, "com a 0025, migra");
  if (b.ok) assert.match(b.motivo, /40/, "o motivo diz quantos valores serao movidos");
  assercoes++;

  // SEM A 0025, RENOMEAR COM VALOR E A PERDA SILENCIOSA QUE EXISTIA EM PRODUCAO
  const c = planoDeRenome(comValor, false);
  eq(c.ok, false, "recusa e a resposta certa: a alternativa e esconder o valor de 40 conversas");
  if (!c.ok) assert.match(c.motivo, /0025/, "e ela diz o que falta");
  assercoes++;

  eq(planoDeRenome(cego, true).ok, false, "contagem incompleta recusa mesmo com a migration");
});

// ═══════════════════════════════════════ 14) linha do banco -> campo
t("campoDaLinha: sem a 0025 o campo vira TEXTO livre, e nao desaparece", () => {
  const base = campoDaLinha({ id: "1", nome: "CNPJ", ordem: 2, ativo: true });
  eq(base?.tipo, "texto", "coluna ausente cai no comportamento de hoje");
  eq(base?.obrigatorio, false);
  assert.deepEqual(base?.opcoes, []);
  assercoes++;
  eq(base?.descricao, null);

  const cheio = campoDaLinha({
    id: "2", nome: "Plano", ordem: 1, ativo: true,
    tipo: "lista", obrigatorio: true, opcoes: ["Mensal", "Anual"], descricao: " escolha ",
  });
  eq(cheio?.tipo, "lista");
  eq(cheio?.obrigatorio, true);
  eq(cheio?.descricao, "escolha");
  assert.deepEqual(cheio?.opcoes, ["Mensal", "Anual"]);
  assercoes++;

  // FAIL-SAFE: lista sem opcao legivel volta a ser TEXTO (select vazio nao aceita
  // valor nenhum, e a ficha ficaria com um campo impossivel de preencher)
  eq(campoDaLinha({ id: "3", nome: "X", tipo: "lista", opcoes: "nao e lista" })?.tipo, "texto");
  eq(campoDaLinha({ id: "4", nome: "X", tipo: "cpf" })?.tipo, "texto", "tipo desconhecido nao quebra a leitura");
  eq(campoDaLinha({ id: "5", nome: "X", obrigatorio: "true" })?.obrigatorio, false, "obrigatorio so por booleano");
  eq(campoDaLinha({ id: "6", nome: "X", ordem: "abc" })?.ordem, 999, "ordem torta vai pro fim, nao vira NaN");
  eq(campoDaLinha({ id: "7", nome: "X" })?.ativo, true, "ativo ausente = ativo (default do banco)");
  eq(campoDaLinha({ id: "8", nome: "X", ativo: false })?.ativo, false);
  eq(campoDaLinha({ nome: "X" }), null, "linha sem id nao vira campo");
  eq(campoDaLinha({ id: "9", nome: "  " }), null, "linha sem nome nao vira campo");
});

t("colisao de nome que JA existe aparece como pendencia", () => {
  const c = colisoesDeNome([campo({ nome: "CNPJ" }), campo({ nome: "cnpj" }), campo({ nome: "Cidade" })]);
  eq(c.length, 1);
  assert.deepEqual(c[0].nomes.sort(), ["CNPJ", "cnpj"]);
  assercoes++;
  eq(colisoesDeNome([campo({ nome: "A" }), campo({ nome: "B" })]).length, 0);
  // arquivado TAMBEM colide: ele disputa a mesma chave do jsonb
  eq(colisoesDeNome([campo({ nome: "CNPJ" }), campo({ nome: "cnpj", ativo: false })]).length, 1);
  eq(MAX_CAMPOS > 0 && MAX_OPCOES > 0, true, "os tetos existem e sao positivos");
});

console.log("\n— B) as travessias de canal, com EXECUTOR INJETADO");

// ═══════════════════════════════════════════════════════ 15) medirImpacto
await ta("medirImpacto RODA DE VERDADE: canal que nao respondeu vira null, nunca zero", async () => {
  // Enquanto esta decisao morava dentro da funcao que fala com o banco, a unica
  // prova possivel era varredura de texto — e um `?? 0` no lugar do `null`
  // desligava o freio da remocao com a bateria verde (micro-check de 31/08/2026 em
  // lib/exportacao.ts). Aqui ela executa, com fake no lugar do banco, e o que se
  // confere e o DESFECHO: o veredito.
  const fake = (mapa: Record<string, number | null>) => async (canal: string) => mapa[canal] ?? null;

  const tudoZero = await medirImpacto(["central", "apioficial"], fake({ central: 0, apioficial: 0 }));
  eq(tudoZero.incompleto, false);
  eq(tudoZero.conversas, 0);
  eq(vereditoDaRemocao(tudoZero).acao, "remover", "medido zero em todos: remove");

  const soma = await medirImpacto(["central", "apioficial"], fake({ central: 4, apioficial: 7 }));
  eq(soma.conversas, 11, "soma os canais (o catalogo e da instalacao, o valor e por canal)");
  eq(vereditoDaRemocao(soma).acao, "arquivar");

  // UM canal cego = impacto INCOMPLETO = remocao RECUSADA
  const cego = await medirImpacto(["central", "apioficial"], async (c) => (c === "central" ? 0 : null));
  eq(cego.incompleto, true, "null de UM canal contamina o veredito inteiro, e tem que contaminar");
  eq(vereditoDaRemocao(cego).acao, "recusar");
  eq(planoDeRenome(cego, true).ok, false, "e tambem barra o renome");
  assert.deepEqual(cego.por_canal.find((p) => p.canal === "apioficial"), { canal: "apioficial", conversas: null });
  assercoes++;

  // EXCECAO do executor (rede caiu, cliente mal configurado) e "nao deu pra contar"
  const estourou = await medirImpacto(["central"], async () => {
    throw new Error("rede caiu");
  });
  eq(estourou.incompleto, true, "excecao nao pode virar zero");
  eq(vereditoDaRemocao(estourou).acao, "recusar");

  // resposta TORTA do banco
  const torta = await medirImpacto(["a", "b", "c"], async (c) =>
    (c === "a" ? (undefined as any) : c === "b" ? (NaN as any) : ("12" as any))
  );
  eq(torta.por_canal.find((p) => p.canal === "a")?.conversas, null, "undefined nao e zero");
  eq(torta.por_canal.find((p) => p.canal === "b")?.conversas, null, "NaN nao e zero");
  eq(torta.por_canal.find((p) => p.canal === "c")?.conversas, 12, "numero em texto conta");
  eq(torta.incompleto, true);

  // LISTA DE CANAL VAZIA E INCOMPLETA: nada medido nao pode virar "pode remover"
  const vazio = await medirImpacto([], async () => 0);
  eq(vazio.incompleto, true, "zero canal = nada medido = fail-closed");
  eq(vereditoDaRemocao(vazio).acao, "recusar");
  eq((await medirImpacto(["", "   "], async () => 0)).incompleto, true, "id vazio nao conta como canal");

  // canal duplicado na configuracao conta UMA vez (numero inflado tambem e errado)
  let chamadas = 0;
  const dup = await medirImpacto(["central", "central"], async () => {
    chamadas++;
    return 5;
  });
  eq(chamadas, 1, "canal repetido nao e consultado duas vezes");
  eq(dup.conversas, 5, "nem contado duas vezes");

  // ordem estavel (lista que troca de ordem entre dois cliques parece dado mudando)
  const ordem = await medirImpacto(["zap", "apioficial", "central"], async () => 1);
  assert.deepEqual(ordem.por_canal.map((p) => p.canal), ["apioficial", "central", "zap"]);
  assercoes++;
});

// ═══════════════════════════════════════════════════════ 16) migrarRenome
await ta("migrarRenome RODA DE VERDADE: para no 1o canal que falhar, e NAO renomeia", async () => {
  const tudoOk = await migrarRenome(["central", "apioficial"], async () => ({ ok: true, renomeadas: 3, conflitos: 1 }));
  eq(tudoOk.ok, true);
  if (tudoOk.ok) {
    eq(tudoOk.renomeadas, 6, "soma os canais");
    eq(tudoOk.conflitos, 2, "e soma os conflitos (linha que ja tinha valor no nome novo)");
  }

  // FALHA NO MEIO: para ali, diz QUAL canal, e o 3o canal NAO e tocado
  const vistos: string[] = [];
  const parcial = await migrarRenome(["a", "b", "c"], async (canal) => {
    vistos.push(canal);
    return canal === "b" ? { ok: false, motivo: "tabela travada" } : { ok: true, renomeadas: 1, conflitos: 0 };
  });
  eq(parcial.ok, false, "falha parcial e falha: quem chama NAO troca o nome no catalogo");
  if (!parcial.ok) {
    assert.match(parcial.motivo, /canal b/, "o motivo nomeia o canal que falhou");
    assert.match(parcial.motivo, /tabela travada/, "e carrega o motivo do banco");
    assert.match(parcial.motivo, /NAO foi trocado/, "e diz o que NAO aconteceu");
    assercoes += 3;
  }
  assert.deepEqual(vistos, ["a", "b"], "sequencial: o canal `c` nem foi consultado (limita o estrago)");
  assercoes++;

  // resposta TORTA do banco e FALHA, nao sucesso com zero
  for (const torta of [null, undefined, {}, { ok: "true" }, { ok: 1 }, { renomeadas: 5 }]) {
    const r = await migrarRenome(["a"], async () => torta as any);
    eq(r.ok, false, `resposta ${JSON.stringify(torta)} nao pode passar por sucesso`);
  }
  const semMotivo = await migrarRenome(["a"], async () => ({ ok: false }));
  if (!semMotivo.ok) assert.match(semMotivo.motivo, /motivo nao informado/);
  assercoes++;

  // EXCECAO tambem e falha com razao
  const estourou = await migrarRenome(["a"], async () => {
    throw new Error("timeout");
  });
  eq(estourou.ok, false);
  if (!estourou.ok) assert.match(estourou.motivo, /timeout/);
  assercoes++;

  // contagem torta soma como 0, nunca NaN na tela
  const tortoNumero = await migrarRenome(["a"], async () => ({ ok: true, renomeadas: "x", conflitos: -3 }));
  eq(tortoNumero.ok, true);
  if (tortoNumero.ok) {
    eq(tortoNumero.renomeadas, 0, "'x' nao vira NaN");
    eq(tortoNumero.conflitos, 0, "negativo nao vira negativo na tela");
  }

  // lista vazia: nao existe "migrei tudo" sem canal nenhum
  const vazio = await migrarRenome([], async () => ({ ok: true }));
  eq(vazio.ok, false, "zero canal nao e migracao bem-sucedida");
});

console.log("\n— C) as guardas estruturais (forma, nunca frase)");

// ═══════════════════════════════════ 17) o espelho da chave normalizada
t("ESPELHO: chaveDeFicha (schema.ts) == chaveNormalizadaDeCampo (variaveis.ts)", () => {
  // POR QUE EXISTE UMA COPIA: `lib/fluxo/schema.ts` tem ZERO import de proposito,
  // e a garantia esta travada em scripts/prova-motor-fila.ts (importsDe == []).
  // Espelho com guarda de igualdade e o padrao da casa (`segundosUteis` em TS x
  // `mensageria.segundos_uteis` em SQL). Esta guarda E a duplicacao ficar honesta:
  // se uma das duas mudar, a bateria cai aqui.
  const CORPUS = [
    "CNPJ", "cnpj", "Nome da empresa", "nome_da_empresa", "NOME  DA   EMPRESA",
    "Endereço", "Endereco", "endereço  ", "Não sei", "Ação", "coração",
    "e-mail", "E_Mail", "e mail", "  espacos  ",
    "%", "%%", "_", "__", "100%", "50% de desconto", "a%b", "a_b", "a-b", "a.b",
    "R$ 1.234,56", "17/10/2026", "campo (2)", "campo [x]", "campo #1",
    "ja tem_underline", "MiXeD CaSe", "1234", "0", "-", "",
    "  ", "ç", "ñ", "ü", "Ã", "ÁÉÍÓÚ", "aeiou",
    // decomposto (NFD) vs composto (NFC): a MESMA palavra escrita de dois jeitos
    "Endereço", "Endereço",
    "campo\tcom\ttab", "campo\ncom\nlinha",
    "emoji 🙂 no nome", "🙂", "misto ç% _ 9",
    "a".repeat(120),
  ];
  for (const s of CORPUS) {
    eq(
      chaveDeFicha(s),
      chaveNormalizadaDeCampo(s),
      `o espelho divergiu em ${JSON.stringify(s)} — mudou uma das duas normalizacoes`
    );
  }
  // e nos valores que nao sao texto
  for (const v of [null, undefined, 0, 42, true, false]) {
    eq(chaveDeFicha(v), chaveNormalizadaDeCampo(v), `o espelho divergiu em ${String(v)}`);
  }
  // a chave do construtor tambem e a MESMA (ela reexporta a de variaveis.ts)
  for (const s of CORPUS) {
    eq(chaveDeCampo(s), chaveNormalizadaDeCampo(s), `chaveDeCampo divergiu em ${JSON.stringify(s)}`);
  }
  // e o espelho continua sendo espelho: schema.ts NAO pode ter ganhado um import
  const SCHEMA = readFileSync(new URL("../lib/fluxo/schema.ts", import.meta.url), "utf8");
  eq(/^import /m.test(SCHEMA), false, "schema.ts ganhou um import: a guarda do motor-fila vai cair");
  eq(SCHEMA.includes("function chaveDeFicha"), true, "chaveDeFicha saiu de schema.ts");
});

// ═══════════════════════════════ 18) a condicao de ficha no motor
t("condicao de `ficha`: campo valido, exige chave, casa por forma NORMALIZADA", () => {
  eq((CAMPOS_CONDICAO as readonly string[]).includes("ficha"), true, "`ficha` e campo de condicao");
  // sem chave nao existe condicao de ficha (qual campo?)
  const semChave = validarCondicao({ tipo: "comparacao", campo: "ficha", operador: "igual", valor: "x" });
  eq(semChave.ok, false, "condicao de ficha sem chave recusa");
  if (!semChave.ok) assert.match(semChave.erros.join("; "), /chave/i);
  assercoes++;
  eq(validarCondicao({ tipo: "comparacao", campo: "ficha", operador: "igual", valor: "x", chave: "%" }).ok, false,
    "chave que normaliza pra vazio nao alcanca campo nenhum");
  eq(validarCondicao({ tipo: "comparacao", campo: "status", operador: "igual", valor: "aberto", chave: "x" }).ok, false,
    "so contexto e ficha usam chave");

  const v = validarCondicao({ tipo: "comparacao", campo: "ficha", operador: "igual", valor: "Ativo", chave: "Situacao" });
  eq(v.ok, true);
  const c = (v as any).condicao;
  eq(avaliarCondicao(c, { ficha: { Situacao: "Ativo" } }), true, "casa pelo nome como gravado");
  eq(avaliarCondicao(c, { ficha: { situacao: "ativo" } }), true, "caixa nao separa (chave E valor)");
  eq(avaliarCondicao(c, { ficha: { "situação": "Ativo" } }), true, "acento na chave nao separa");
  eq(avaliarCondicao(c, { ficha: { Situacao: "Inativo" } }), false);
  eq(avaliarCondicao(c, { ficha: {} }), false, "ficha vazia nao casa valor");
  eq(avaliarCondicao(c, {}), false, "ficha AUSENTE nao casa valor (quem avisa que nao leu e `indisponiveis`)");

  // AMBIGUIDADE ENTRA COMO MULTIVALOR (regra 3): "algum campo com esse nome vale X"
  eq(avaliarCondicao(c, { ficha: { CNPJ: "x", Situacao: "Inativo", situacao: "Ativo" } }), true,
    "duas chaves colidindo: existencia no positivo");
  const neg = (validarCondicao({ tipo: "comparacao", campo: "ficha", operador: "diferente", valor: "Ativo", chave: "Situacao" }) as any).condicao;
  eq(avaliarCondicao(neg, { ficha: { Situacao: "Inativo", situacao: "Ativo" } }), false,
    "...e ausencia no negativo: com uma das duas valendo 'Ativo', `diferente` e falso");

  const existe = (validarCondicao({ tipo: "comparacao", campo: "ficha", operador: "existe", chave: "CNPJ" }) as any).condicao;
  eq(avaliarCondicao(existe, { ficha: { CNPJ: "1" } }), true);
  eq(avaliarCondicao(existe, { ficha: { CNPJ: "   " } }), false, "espaco nao e valor preenchido");
  eq(avaliarCondicao(existe, {}), false, "ficha ausente: nao existe");
});

t("`ficha` NAO vale em canal de fonte externa — e o preflight RECUSA antes", () => {
  // A ficha mora na COLUNA `ficha` da tabela de CONVERSAS do canal, que canal de
  // fonte externa nao tem. Sem esta recusa, a coleta falharia e o macro morreria
  // NO MEIO — o atendente nao consegue saber o que ja saiu pro cliente.
  eq((CAMPOS_CONDICAO_SO_DO_PAINEL as readonly string[]).includes("ficha"), false,
    "`ficha` nao e campo do painel: ela e da tabela do canal");
  const fluxo = {
    id: "m", nome: "macro", tipo: "macro" as const, versao: 1,
    nos: [
      { id: "n1", tipo: "condicao" as const, condicao: { tipo: "comparacao" as const, campo: "ficha" as const, operador: "existe" as const, chave: "CNPJ" }, proximo: "n2" },
      { id: "n2", tipo: "acao" as const, acao: { tipo: "nota_interna" as const, texto: "ok" } },
    ],
  };
  const ok = validarFluxo(fluxo);
  eq(ok.ok, true, "o fluxo em si e valido");
  const limites = { maxInline: 60, maxTotal: 86400 };
  const recusa = motivoParaRecusarPuro((ok as any).fluxo, { soLeitura: true, envioCabeado: true }, limites);
  eq(typeof recusa, "string", "canal somente leitura: o preflight recusa o macro");
  if (typeof recusa === "string") assert.match(recusa, /ficha/, "e diz qual campo ele nao consegue avaliar");
  assercoes++;
  eq(motivoParaRecusarPuro((ok as any).fluxo, { soLeitura: false, envioCabeado: true }, limites), null,
    "no canal do painel, o mesmo macro passa");
});

t("nenhuma acao da v1 escreve ficha — e o dia que uma escrever, esta prova cai", () => {
  // `CAMPOS_SUJOS_POR_ACAO` nao tem linha pra `ficha` porque NENHUMA acao mexe
  // nela hoje. A guarda e por FORMA, e ela e o contrato pra Frentes futuras: uma
  // acao chamada `definir_campo` (ou qualquer coisa com "campo"/"ficha" no nome)
  // TEM que declarar que suja `ficha`, senao uma condicao logo depois dela
  // decidiria em dado velho — o GRAVE que a revisao cega pegou com
  // `definir_contexto` em 31/08/2026.
  const sujam = new Set<string>();
  for (const [acao, campos] of Object.entries(CAMPOS_SUJOS_POR_ACAO)) {
    if ((campos as readonly string[]).includes("ficha")) sujam.add(acao);
  }
  for (const acao of ACOES_V1) {
    if (!/campo|ficha/i.test(acao)) continue;
    eq(sujam.has(acao), true,
      `a acao "${acao}" parece escrever campo de ficha e NAO declara \`ficha\` em CAMPOS_SUJOS_POR_ACAO`);
  }
  // e hoje, de fato, nenhuma acao suja ficha (se alguma passar a sujar, o autor
  // dela ajusta esta linha CIENTE do que esta fazendo)
  eq(sujam.size, 0, "alguma acao passou a sujar `ficha`: confira o passo e atualize esta guarda");
});

// ═══════════════════════════════════════ 19) o gate das duas rotas
t("O GATE: /api/campos exige `gerenciar_campos`; /api/campos/valores exige a CONVERSA", () => {
  // Esta e a metade da separacao "administrar x preencher" que a prova de
  // permissoes nao alcanca (as rotas importam next/server). Guarda por FORMA.
  // A DECISAO, POR DESFECHO. Antes esta guarda era so varredura de texto, e
  // trocar a linha do handler por `if (false && !permitido(...))` deixava as tres
  // provas VERDES (medido na revisao cega): texto pega a REMOCAO, nunca o
  // DESLIGAMENTO. E a rota apaga campo da instalacao inteira.
  eq(JSON.stringify(decidirPorta(null, false)), JSON.stringify({ ok: false, status: 401, erro: "unauthorized" }), "sem usuario e 401, nao 403");
  eq(JSON.stringify(decidirPorta(null, true)), JSON.stringify({ ok: false, status: 401, erro: "unauthorized" }), "sem usuario e 401 mesmo com permissao");
  {
    const v = decidirPorta({ id: "u1" }, false);
    eq(v.ok, false, "usuario sem gerenciar_campos NAO entra");
    eq(v.ok === false && v.status, 403, "e o status e 403 (sei quem e voce, e voce nao pode)");
    eq(v.ok === false && /gerenciar_campos/.test(v.erro), true, "e a mensagem NOMEIA a permissao que falta");
  }
  eq(JSON.stringify(decidirPorta({ id: "u1" }, true)), JSON.stringify({ ok: true }), "com usuario e permissao, entra");
  // e o handler EXECUTA essa decisao (nao reimplementa a regra do lado dele)
  // O ARGUMENTO tambem e cobrado, e nao so a chamada: sem isto, trocar o segundo
  // parametro por `true || (...)` desligava o gate com a decisao pura intacta e as
  // provas verdes. E a mesma classe de mutacao que a varredura antiga nao pegava.
  eq(
    /decidirPorta\(user, !!perfil && permitido\(perfil, "gerenciar_campos"\)\)/.test(ROTA_CAT),
    true,
    "a porta executa decidirPorta COM a permissao real (nao com um literal)"
  );

  // R21 — A COLISAO NORMALIZADA NO CALL SITE. `mesmoCampo` esta provada acima, mas
  // a guarda so cobrava a presenca dela no ARQUIVO: arrancar a checagem de dentro
  // de `criar()` passava verde, e a partir dai 'CNPJ' nascia ao lado de um 'cnpj'
  // existente — e `acharCampo` ficava ambiguo pra sempre naquela conta.
  {
    const corpoCriar = ROTA_CAT.split("async function criar(")[1]?.split("\nasync function")[0] ?? "";
    eq(corpoCriar.length > 0, true, "achei o corpo de criar()");
    eq(
      /const colide = cat\.campos\.find\(\(c\) => mesmoCampo\(c\.nome, v\.campo\.nome\)\)/.test(corpoCriar),
      true,
      "criar() confere colisao NORMALIZADA contra o catalogo inteiro (nao so a UNIQUE exata da 0001)"
    );
    eq(
      /if \(colide\)[\s\S]{0,300}?status: 409/.test(corpoCriar),
      true,
      "e recusa com 409 (o campo NAO e criado)"
    );
    eq(
      /const ruim = ilegivel\(cat\)[\s\S]{0,80}?if \(ruim\) return ruim;/.test(corpoCriar),
      true,
      "e catalogo ilegivel para criar() ANTES de qualquer conferencia (nao vira ficha vazia)"
    );
  }

  // R19 — `renome_disponivel` esta provado POR DESFECHO no bloco 43 (a decisao
  // saiu do literal da fiacao e virou `catalogoLido`). A varredura que morava aqui
  // sobrevivia a `disponiveis && rpcOk() || true`, medido na re-revisao cega.

  // R17 — A CONDICAO DE FLUXO NAO PODE LER FICHA COM FAIL-OPEN.
  //
  // A PROPRIEDADE esta provada por DESFECHO no bloco 48: `coletaDaLinhaDeConversa`,
  // `fatosDaLinhaDeConversa` e `colherLinhaDeConversa` (lib/fluxo/coleta.ts) rodam
  // de verdade, com leitor fake e com os mapas de destino de verdade. Apagar as
  // assercoes daqui NAO deixa a regra sem prova.
  //
  // O QUE SO A VARREDURA ALCANCA — e por isso continua aqui: que o motor CHAME a
  // coleta. `lib/fluxo/executar.ts` importa banco e provedor e usa alias `@/`:
  // nenhuma prova consegue importa-lo, entao "a chamada existe" nao tem como ser
  // desfecho. Este e o unico PORTAO de texto que sobrou nesta frente.
  //
  // E ELA E TOLERANTE DE PROPOSITO (o defeito da 3a rodada foi o oposto): as
  // Frentes W e Y mexem neste arquivo, e a rodada anterior cobrava TRES LINHAS
  // EXATAS — `const colhido = coletaDaLinhaDeConversa(campos, data, error)` mais
  // dois `for…of` derramando nos mesmos mapas (mesma propriedade, outra forma)
  // REPROVAVA. Falso positivo em onda de merge e pior que falso negativo: quebra
  // por motivo errado, e quem esta fazendo merge afrouxa a guarda. Agora o que se
  // cobra e que a coleta pura seja CHAMADA — por qualquer uma das portas dela — e,
  // quando a forma escolhida DEVOLVE o resultado, que os dois mapas recebam.
  {
    const corpo = semComentario(corpoDaFuncao(EXECUTAR_FLUXO, "export async function coletarFatos"));
    eq(corpo.length > 0, true, "achei coletarFatos");
    // as portas de lib/fluxo/coleta.ts, da mais alta pra mais baixa
    const PORTAS = ["colherLinhaDeConversa", "fatosDaLinhaDeConversa", "coletaDaLinhaDeConversa"];
    const usadas = PORTAS.filter((p) => new RegExp(`\\b${p}\\s*\\(`).test(corpo));
    eq(usadas.length > 0, true,
      "coletarFatos parou de chamar a coleta pura de lib/fluxo/coleta.ts: a decisao sobre a linha de conversa voltou pra dentro do motor, onde nenhuma prova alcanca");
    // Quem chama `colherLinhaDeConversa` passa os mapas de destino e nao tem
    // derrame pra esquecer (trocar os dois de lugar nao compila). Quem chama uma
    // das portas que DEVOLVEM o resultado precisa derrama-lo nos DOIS mapas —
    // qualquer forma serve, o que se exige e que os dois lados apareçam.
    if (!usadas.includes("colherLinhaDeConversa")) {
      eq(/\.fatos\b/.test(corpo), true,
        "o que a coleta apurou como FATO nao chega no resultado de coletarFatos");
      eq(/\.indisponiveis\b/.test(corpo), true,
        "o que a coleta marcou como INDISPONIVEL nao chega no resultado: leitura que falhou volta a passar por fato");
    }
    // CINTO REDUNDANTE: a decisao sobre a ficha nao pode ser REESCRITA aqui. O
    // portao e o bloco 48 (a decisao pura tem desfecho medido); isto so pega o
    // gesto de reimplementar a regra dentro do motor, que e a forma como o
    // fail-open nasceu.
    eq(/indisponiveis\.ficha\s*=|indisponiveis\["ficha"\]\s*=|fatos\.ficha\s*=|fatos\["ficha"\]\s*=/.test(corpo), false,
      "a decisao sobre a ficha voltou pra dentro de coletarFatos, onde nenhuma prova alcanca");
  }
  eq(/permitido\(perfil,\s*"gerenciar_campos"\)/.test(ROTA_CAT), true, "e a permissao consultada continua sendo a nomeada");
  // TODO handler exportado passa pela porta — handler que esquece a porta e rota aberta
  for (const m of ["GET", "POST", "DELETE"]) {
    const corpo = ROTA_CAT.split(`export async function ${m}(`)[1] ?? "";
    eq(corpo.slice(0, 200).includes("await porta(req)"), true, `${m} do catalogo nao passa pela porta`);
    eq(corpo.slice(0, 260).includes(`if ("erro" in p) return p.erro`), true, `${m} nao devolve o erro da porta`);
  }
  eq((ROTA_CAT.match(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g) || []).length, 3,
    "handler novo no catalogo sem passar pela porta: confira");

  // A ROTA DE VALORES NAO PODE EXIGIR A PERMISSAO: preencher a ficha e
  // atendimento. Exigi-la tiraria a ficha de todo atendente com papel NOMEADO no
  // dia do deploy.
  eq(semComentario(ROTA_VAL).includes("gerenciar_campos"), false, "preencher valor passou a exigir permissao de administrador");
  eq(ROTA_VAL.includes("await podeVerConversa("), true, "o gate da conversa saiu da rota de valores");
  eq(ROTA_VAL.includes("restricaoEfetiva("), true, "a restricao de contexto embutido saiu da rota de valores");
  // GET nao tem corpo: identidade e porta saem juntas. PATCH tem corpo: a
  // identidade vem ANTES do req.json() (GRAVE D1 da Frente W — corpo consumido
  // nao clona e o escopo da chave fica inerte; pego no merge da onda 5) e a
  // porta recebe o usuario ja resolvido.
  {
    const corpoGet = ROTA_VAL.split("export async function GET(")[1] ?? "";
    eq(/await porta\(req, chatId, canal\)/.test(corpoGet.slice(0, 400)), true, "GET de valores nao passa pela porta");
    const corpoPatch = ROTA_VAL.split("export async function PATCH(")[1] ?? "";
    const iUser = corpoPatch.indexOf("await getUser(req)");
    const iCorpo = corpoPatch.indexOf("req.json()");
    eq(iUser > -1 && iCorpo > -1 && iUser < iCorpo, true,
      "PATCH de valores resolve a identidade ANTES de consumir o corpo (GRAVE D1)");
    eq(/await portaDoUsuario\(req, user, chatId, canal\)/.test(corpoPatch.slice(0, 700)), true,
      "PATCH de valores nao passa pela porta");
  }
  eq((ROTA_VAL.match(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g) || []).length, 2);
});

t("A ORDEM DO RENOME: mede -> decide -> MIGRA -> so depois troca o nome", () => {
  const corpo = ROTA_CAT.split("async function editar(")[1] ?? "";
  const iImpacto = corpo.indexOf("await impactoDoCampo(");
  const iPlano = corpo.indexOf("planoDeRenome(");
  const iMigra = corpo.indexOf("await renomearValores(");
  const iGrava = corpo.indexOf("await gravarCampo(");
  eq(iImpacto > 0 && iPlano > iImpacto, true, "o plano tem que vir DEPOIS da medicao");
  eq(iMigra > iPlano, true, "a migracao tem que vir DEPOIS do plano");
  eq(iGrava > iMigra, true, "o nome novo entra no catalogo DEPOIS de migrar os valores em todos os canais");
  // falha na migracao NAO pode seguir pra gravacao
  eq(/if \(!mig\.ok\) return NextResponse\.json\(/.test(corpo), true, "falha de migracao nao interrompe o renome");
  // e o plano recusado tambem para (409, nao 200 calado)
  eq(/if \(!plano\.ok\)[\s\S]{0,120}status: 409/.test(corpo), true, "plano recusado nao devolve 409");
  // colisao NOVA e recusada por igualdade normalizada, nunca por like
  eq(/mesmoCampo\(c\.nome, v\.campo\.nome\)/.test(corpo), true, "a checagem de colisao do renome saiu");
});

t("REMOVER e em dois passos, e o 1o nao muda nada", () => {
  const corpo = ROTA_CAT.split("export async function DELETE(")[1] ?? "";
  const iPrevia = corpo.indexOf("previa: true");
  const iApaga = corpo.indexOf("await apagarCampo(");
  eq(iPrevia > 0, true, "sumiu a previa: a tela passaria a remover sem mostrar o impacto");
  eq(iApaga > iPrevia, true, "a remocao tem que vir depois da previa");
  eq(/confirmar"\) === "1"/.test(corpo), true, "a confirmacao explicita saiu do DELETE");
  // SO remove quando o veredito diz remover — e o veredito vem da MEDICAO
  eq(/veredito\.acao !== "remover"/.test(corpo), true, "o DELETE parou de consultar o veredito");
  eq(/const impacto = await impactoDoCampo\(atual\.nome\)/.test(corpo), true, "o impacto nao vem mais medido");
  eq(/veredito\.acao === "recusar" \? 503 : 409/.test(corpo), true,
    "contagem incompleta tem que dar 503 (transiente), nao 409 (conflito de dado)");
  // e a DECISAO nao voltou pra rota (decisao na rota so tem prova de texto)
  eq(/function vereditoDaRemocao/.test(semComentario(ROTA_CAT)), false, "o veredito voltou a morar na rota");
  eq(/function planoDeRenome/.test(semComentario(ROTA_CAT)), false, "o plano de renome voltou a morar na rota");
  // e a TRAVESSIA nao pode voltar pra fiacao: `incompleto` e a palavra que decide
  // se a remocao acontece, e ela so pode ser calculada em lib/campos.ts (onde a
  // prova a executa com fake). Recalculada dentro da funcao que fala com o banco,
  // ela volta a ser inalcancavel por prova.
  eq(/incompleto/.test(semComentario(LIB_DB)), false, "a decisao de `incompleto` voltou pra fiacao");
  eq(/incompleto/.test(semComentario(ROTA_CAT)), false, "a decisao de `incompleto` foi pra rota");
});

t("as DUAS portas de escrita chamam a MESMA decisao, e o 422 vem ANTES da gravacao", () => {
  for (const [nome, rota, gravar] of [
    ["/api/campos/valores", ROTA_VAL, "await gravarFichaDaConversa("],
    ["/api/ficha", ROTA_FICHA, "update("],
  ] as const) {
    eq(rota.includes("aplicarPatchDeValores("), true, `${nome} nao usa a decisao compartilhada`);
    const i422 = rota.indexOf("status: 422");
    const iRec = rota.indexOf("recusados.length");
    const iGrava = rota.indexOf(gravar, iRec > 0 ? iRec : 0);
    eq(iRec > 0, true, `${nome} nao confere as recusas`);
    eq(i422 > 0 && i422 > iRec, true, `${nome} nao devolve 422 na recusa`);
    eq(iGrava > i422, true, `${nome} pode gravar ANTES de conferir as recusas (tudo-ou-nada furado)`);
  }
  // e a regra NAO pode ter voltado pra dentro das rotas
  eq(/slice\(0,\s*1000\)/.test(semComentario(ROTA_FICHA)), false, "voltou o corte silencioso de 1000 chars em /api/ficha");
  eq(/LIMITE_VALOR_CAMPO/.test(semComentario(ROTA_VAL) + semComentario(ROTA_FICHA)), false, "o teto voltou a ser decidido na rota");
});

t("a rota antiga de ficha-config: o UPDATE de nome nao voltou, e nada escreve antes da decisao", () => {
  // AS RECUSAS estao no bloco 44 (decisao pura) e o USO delas no bloco 47 (o corpo
  // do handler, por desfecho). O que sobra aqui e a propriedade que so o ARQUIVO
  // mostra: esta rota nao pode voltar a escrever `nome` em `campos_personalizados`
  // por caminho nenhum — foi esse UPDATE que escondia o valor de todas as
  // conversas sob o nome antigo.
  eq(/update\(\{\s*nome/.test(semComentario(ROTA_CFG)), false, "voltou o UPDATE de nome sem migrar valor");
  // CINTO REDUNDANTE (o portao e o bloco 47): o handler e ADAPTADOR, entao toda
  // escrita tem que estar DEPOIS da chamada do executor — e ali ela so acontece se
  // o executor pedir. Escrita antes = a rota voltou a decidir sozinha.
  const corpo = semComentario(ROTA_CFG).split("export async function POST(")[1] ?? "";
  const iExec = corpo.indexOf("await executarFichaConfig(");
  eq(iExec > 0, true, "a rota antiga parou de executar `executarFichaConfig`");
  for (const escrita of [".update(", ".upsert(", ".insert(", ".delete("]) {
    const i = corpo.indexOf(escrita);
    eq(i < 0 || i > iExec, true, `a rota antiga escreve (${escrita}) ANTES de passar pela decisao`);
  }
  eq(/\{ tipo, id, nome, ativo \}/.test(corpo), true, "o executor deixou de receber o pedido real (tipo, id, nome, ativo)");
  // E OS EFEITOS SAO OS PROVADOS (bloco 49): montar o objeto de efeitos aqui, na
  // mao, e o que devolvia o adaptador pra zona sem prova — foi assim que
  // `lerNomes` com `erro: null` sobrevivia a bateria inteira.
  eq(/efeitosDeFichaConfig\(/.test(corpo), true,
    "a rota antiga voltou a montar os efeitos na mao, fora do alcance da prova");
  eq(/erro:\s*null|data\s*\?\?\s*\[\]/.test(corpo), false,
    "apareceu resposta de banco normalizada na rota: com o erro engolido, `decidirColisaoNoCatalogo` le 'catalogo vazio' e o 503 fail-closed morre");
  eq(/NextResponse\.json\(r\.corpo, \{ status: r\.status \}\)/.test(corpo), true,
    "a rota antiga parou de devolver a resposta que o executor decidiu");
  // e nenhuma das recusas pode ter sido reimplementada dentro do handler
  eq(/status: 409|status: 422|status: 503/.test(semComentario(ROTA_CFG)), false,
    "a rota antiga voltou a montar recusa por conta propria (decisao na rota so tem prova de texto)");
});

// ═══════════════════════════════════ 20) escopo de chave de API
t("escopo-chave: /api/campos/valores ANTES de /api/campos, e canal padrao so na de valores", () => {
  // O MAPA casa por PREFIXO e vale o PRIMEIRO que bate: se `/api/campos` viesse
  // antes, a rota de valores herdaria o recurso `admin` e uma chave consentida pra
  // `ficha` perderia a ficha (negacao falsa) — ou pior, uma chave `admin` ganharia
  // a ficha de contato sem ninguem pedir.
  //
  // MEDIDO POR EXECUCAO, e nao por posicao no arquivo — a versao anterior desta
  // guarda comparava `indexOf` das duas strings e PASSOU na mutacao que inverte o
  // MAPA (a rota de valores tambem aparece em CANAL_PADRAO_EM, ANTES do MAPA, e o
  // indexOf achava essa outra ocorrencia). Aqui quem responde e a funcao que a
  // porta usa de verdade.
  eq(recursoDaRota("/api/campos/valores"), "ficha", "a rota de valores tem que resolver pro recurso `ficha`");
  eq(recursoDaRota("/api/campos"), "admin", "o catalogo tem que resolver pro recurso `admin`");
  eq(recursoDaRota("/api/campos/valores?chat_id=1&canal=central"), "ficha", "query nao muda o recurso");

  // e o EFEITO na chave de API, que e o que importa: consentimento pra ler a ficha
  // de UM contato nao pode virar poder de REMOVER campo da instalacao inteira.
  const chave = (recursos: string[]) => ({
    somente_leitura: false, canais: [], recursos: recursos as any, ignorar_janela: false,
  });
  eq(escopoPermite(chave(["ficha"]), { metodo: "PATCH", pathname: "/api/campos/valores", canal: "central" }).ok, true,
    "chave de `ficha` precisa alcancar o valor da ficha");
  eq(escopoPermite(chave(["ficha"]), { metodo: "DELETE", pathname: "/api/campos" }).ok, false,
    "chave de `ficha` NAO pode remover campo da instalacao");
  eq(escopoPermite(chave(["admin"]), { metodo: "DELETE", pathname: "/api/campos" }).ok, true,
    "chave de `admin` administra o catalogo");
  eq(escopoPermite(chave(["admin"]), { metodo: "PATCH", pathname: "/api/campos/valores", canal: "central" }).ok, false,
    "chave de `admin` nao ganha a ficha de contato de brinde");

  // CANAL_PADRAO_EM: a rota de VALORES resolve canal (canalDe/canalDeBody) e
  // precisa do verbete com os metodos EXATOS. A do CATALOGO nao fala de canal, e
  // declarar canal padrao pra ela criaria negacao falsa pra chave restrita a um
  // numero (defeito ja medido duas vezes neste repo).
  const canalPadrao = ESCOPO.split("CANAL_PADRAO_EM")[1]?.split("CANAL_OBRIGATORIO_EM")[0] ?? "";
  eq(/\["\/api\/campos\/valores",\s*\["GET",\s*"PATCH"\]\]/.test(canalPadrao), true,
    "entrada de /api/campos/valores em CANAL_PADRAO_EM com os metodos exatos");
  eq(/\["\/api\/campos",\s*\[/.test(canalPadrao), false, "o catalogo NAO pode declarar canal padrao");
  // e a rota do catalogo de fato nao le canal nenhum
  eq(/canalDe\(|canalDeBody\(/.test(semComentario(ROTA_CAT)), false, "o catalogo passou a resolver canal: precisa de verbete");
  eq(/"central"|"apioficial"/.test(semComentario(ROTA_CAT)), false, "id de canal como literal na rota do catalogo");
  // a de valores resolve os dois lados (GET pela query, PATCH pelo corpo)
  eq(/const canal = canalDe\(req\)/.test(ROTA_VAL), true, "GET de valores nao resolve canal pela query");
  eq(/const canal = canalDeBody\(body\)/.test(ROTA_VAL), true, "PATCH de valores nao resolve canal pelo corpo");
});

// ═══════════════════════════════════════════════ 21) a migration 0025
t("0025: idempotente, RLS, grant explicito, e `notify pgrst` na ULTIMA linha", () => {
  // COMENTARIO FORA: o cabecalho da 0025 explica cada uma destas regras, e
  // varredura que le o comentario prova que o comentario existe, nao a regra.
  const sql = SQL_SEM_COMENTARIO.trim();
  // Sem o notify, o PostgREST nao recarrega o schema e a feature NASCE MORTA
  const linhas = sql.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("--"));
  eq(linhas[linhas.length - 1], "notify pgrst, 'reload schema';", "o notify tem que ser a ULTIMA instrucao");
  eq((sql.match(/notify pgrst/g) || []).length, 1, "um notify so");

  // idempotencia: nada de `add column` sem `if not exists`
  const addColumns = sql.match(/add column[^;]*/g) || [];
  eq(addColumns.length > 0, true, "a migration nao adiciona coluna nenhuma?");
  for (const a of addColumns) {
    eq(/add column if not exists/.test(a), true, `add column sem if not exists: ${a.slice(0, 60)}`);
  }
  // `create table if not exists` NAO altera tabela existente: por isso os defaults
  // sao reafirmados com `alter column ... set default` (regra da 0018)
  for (const col of ["tipo", "obrigatorio", "opcoes"]) {
    eq(new RegExp(`alter column ${col}\\s+set default`).test(sql), true, `default de \`${col}\` nao reafirmado`);
  }
  // REVOKE E GRANT ANDAM EM PAR — e a guarda antiga so cobrava metade. A revisao
  // cega mediu o preco: `revoke execute ... from public` tira de TODO MUNDO
  // (`service_role` nao tem grant proprio, ele herdava de `public`), e a
  // `alter default privileges` da 0001 e `on tables`, nao alcanca funcao. Com a
  // metade sozinha, a migration roda com "sucesso" no SQL Editor e as duas RPCs
  // NASCEM MORTAS: a chamada volta `42501 permission denied for function`.
  for (const f of ["contar_valores_campo", "renomear_campo_ficha"]) {
    eq(new RegExp(`create or replace function mensageria\\.${f}`).test(sql), true, `${f} nao e create or replace`);
    eq(new RegExp(`revoke execute on function mensageria\\.${f}[^;]*from public, anon, authenticated`).test(sql), true,
      `${f} sem revoke pra public/anon/authenticated`);
    eq(new RegExp(`grant execute on function mensageria\\.${f}[^;]*to service_role`).test(sql), true,
      `${f} tem revoke e NAO tem grant pro service_role — a RPC nasce morta (42501)`);
    // e a ORDEM importa: `grant` ANTES do `revoke` seria desfeito pelo revoke
    const iRevoke = sql.indexOf(`revoke execute on function mensageria.${f}`);
    const iGrant = sql.indexOf(`grant execute on function mensageria.${f}`);
    eq(iGrant > iRevoke, true, `o grant de ${f} vem antes do revoke — o revoke desfaz`);
  }
  // e o 42501 tem que ser tratado como INDISPONIBILIDADE na fiacao: sem isso, um
  // `revoke` manual (ou instalacao com a 0025 sem o par) deixa `renome_disponivel`
  // dizendo `true`, a tela prometendo renome e a rota devolvendo 502 com a
  // mensagem crua do Postgres
  eq(/RPC_AUSENTE = \[[^\]]*"42501"/.test(LIB_DB), true,
    "42501 (permission denied for function) nao entra na degradacao de RPC");
  // constraint em tabela COM linhas: `add constraint` VALIDA as existentes, e
  // migration que aborta no meio deixa a instalacao pior (licao da 0019)
  eq(/exception[\s\S]*duplicate_object/.test(sql), true, "add constraint sem tratar duplicate_object");
  eq(/check_violation/.test(sql), true, "add constraint sem tratar check_violation (linha antiga aborta a migration)");
  eq(/update mensageria\.campos_personalizados/.test(sql), true, "saneamento antes do check nao esta na migration");

  // RLS: a tabela nasceu na 0001 SEM row level security (achado desta frente)
  eq(/alter table mensageria\.campos_personalizados enable row level security/.test(sql), true, "sem enable RLS");
  eq(/grant select, insert, update, delete on mensageria\.campos_personalizados to service_role/.test(sql), true,
    "sem grant explicito pra service_role (com RLS ligado e sem grant, a feature para)");

  // e ela e SO DDL: nenhuma destruicao de dado
  eq(/drop table|truncate|delete from/i.test(sql), false, "a migration apaga dado");
  eq(/security definer/i.test(sql), false, "funcao security definer sem necessidade (a chamada e por service_role)");

  // 2a BARREIRA no nome de tabela (as duas funcoes montam SQL dinamico)
  for (const f of ["contar_valores_campo", "renomear_campo_ficha"]) {
    const corpo = sql.split(`function mensageria.${f}`)[1]?.split("$$;")[0] ?? "";
    eq(/p_tabela !~/.test(corpo), true, `${f} sem a checagem de forma do nome da tabela`);
    eq(/to_regclass/.test(corpo), true, `${f} sem to_regclass (nome que passa na forma mas nao existe)`);
    eq(/%I/.test(corpo), true, `${f} sem %I no format (identificador tem que ir quotado)`);
  }
  // e a de renome serializa por CAMPO (dois administradores renomeando ao mesmo tempo)
  eq(/pg_advisory_xact_lock/.test(sql), true, "renome sem advisory lock");
  // FOUND nao e atualizado por EXECUTE: quem conta e GET DIAGNOSTICS
  eq(/get diagnostics/i.test(sql), true, "a contagem do renome nao vem de GET DIAGNOSTICS");

  // NUMERACAO UNICA: 0024 e da Frente W (outra branch desta onda). Duas migrations
  // com o mesmo numero e a instalacao rodando uma e achando que rodou a outra.
  const arquivos = readdirSync(new URL("../supabase/migrations/", import.meta.url));
  eq(arquivos.filter((f) => f.startsWith("0025")).length, 1, "mais de um arquivo 0025");
  eq(arquivos.filter((f) => f.startsWith("0025_campos_ficha")).length, 1, "a 0025 desta frente sumiu");
});

// ═══════════════════════════════════════════════ 22) as telas
t("a tela nao decide: ela chama a rota e mostra o que o servidor responder", () => {
  // A REGRA NAO PODE MORAR NA TELA (tela nao tem prova sem navegador): o que ela
  // faz e desenhar. As decisoes chegam pelo GET.
  eq(/authedFetch\("\/api\/campos"/.test(TELA), true, "a tela nao carrega o catalogo da rota");
  eq(/impacto=/.test(TELA), true, "a tela nao pede o impacto antes de remover");
  eq(/confirmar=1/.test(TELA), true, "a tela nao confirma a remocao explicitamente");
  // a tela nao pode reimplementar veredito/tipo/normalizacao
  eq(/function vereditoDaRemocao|function chaveDeFicha|normalize\("NFD"\)/.test(semComentario(TELA)), false,
    "a tela reimplementou regra que mora em lib/campos.ts");
  eq(/from "@\/lib\/campos"/.test(TELA), true, "a tela nao importa os tipos canonicos");
  // ela AVISA quando a 0025 nao rodou, em vez de fingir que salvou tipo
  eq(/0025/.test(TELA), true, "a tela nao avisa que a migration nao rodou");
  eq(/tipos_disponiveis|tiposDisponiveis/.test(TELA), true, "a tela nao le tipos_disponiveis");
  // e diz o que `obrigatorio` DE FATO faz (interruptor cujo efeito ninguem sabe e
  // a mesma mentira de interruptor sem efeito)
  eq(/nao bloqueia enviar nem concluir/.test(TELA), true, "a tela promete demais no `obrigatorio`");

  // a pagina propria monta a tela (o componente nao fica orfao esperando costura)
  eq(/import AdminCampos from "\.\.\/admin-campos"/.test(PAGINA), true, "a pagina /campos nao monta o construtor");
  eq(/<AdminCampos/.test(PAGINA), true);
  // tranche 2 da revisao de interface (03/09/2026): o bootstrap de sessao + fetch assinado
  // saiu das paginas irmas e mora UMA vez em app/ui/pagina-autenticada.tsx — a pagina
  // monta <PaginaAutenticada> e recebe `authedFetch` pronto. A prova segue cobrando o
  // bootstrap, so que no lugar onde ele vive agora.
  const PAGINA_AUTENTICADA = readFileSync(new URL("../app/ui/pagina-autenticada.tsx", import.meta.url), "utf8");
  eq(/<PaginaAutenticada/.test(PAGINA), true, "a pagina /campos nao monta a moldura autenticada");
  eq(/authClient\.auth\.getSession\(\)/.test(PAGINA_AUTENTICADA), true, "a moldura nao faz o bootstrap de sessao");
  eq(/Authorization: `Bearer \$\{token\}`/.test(PAGINA_AUTENTICADA), true, "a moldura nao assina o fetch");
  eq(/authClient\.auth\.getSession\(\)/.test(PAGINA), false, "a pagina /campos duplica o bootstrap que a moldura ja faz");

  // o componente REUSAVEL da ficha (o criterio "editavel na conversa" sem tocar home.tsx)
  eq(/\/api\/campos\/valores/.test(FICHA_UI), true, "o componente de ficha nao consome a rota de valores");
  eq(/method: "PATCH"/.test(FICHA_UI), true, "o componente de ficha nao escreve");
  eq(/orfaos/.test(FICHA_UI), true, "o componente de ficha nao mostra os valores sem campo");
  eq(/fora do formato/.test(FICHA_UI), true, "o componente de ficha esconde valor fora do formato");
});

// ═══════════════════════════════════════════════ 23) a fiacao (degradacao)
t("degradacao em DUAS camadas: coluna ausente e RPC ausente, com reteste", () => {
  // Padrao da 0015: a migration e gesto HUMANO, entao o codigo tem que funcionar
  // antes dela — some o TIPO, nao o campo.
  eq(/42703/.test(LIB_DB) && /PGRST204/.test(LIB_DB), true, "sem deteccao de coluna ausente");
  eq(/PGRST202/.test(LIB_DB) && /42883/.test(LIB_DB), true, "sem deteccao de RPC ausente");
  eq(/JANELA_RETESTE_MS/.test(LIB_DB), true, "sem reteste: a feature so voltaria com redeploy");
  // a FORMA do catalogo (`legivel`, `tipos_disponiveis`, `renome_disponivel`) saiu
  // daqui e virou decisao pura — provada por DESFECHO no bloco 43, com o call site
  // desta funcao cobrado la tambem.
  // as duas travessias saem da regra pura, com executor
  eq(/return medirImpacto\(/.test(LIB_DB), true, "impactoDoCampo nao delega a travessia");
  eq(/return migrarRenome\(/.test(LIB_DB), true, "renomearValores nao delega a travessia");
  // CANAL DE FONTE EXTERNA FORA DA VARREDURA (senao o impacto sai incompleto pra
  // sempre e trava toda remocao de campo da instalacao).
  //
  // A versao anterior desta guarda CONTAVA as ocorrencias do filtro no arquivo e
  // exigia DUAS, porque ele era copiado em `impactoDoCampo` e em `renomearValores`
  // — cobrando so a presenca, tirar o filtro de UMA delas passava verde (medido na
  // revisao cega). Na 4a rodada o filtro virou ORIGEM UNICA (`canaisComFicha`), de
  // onde saem as duas travessias e o efeito da rota de arquivamento. A aritmetica
  // que MORREU e a de presenca multipla (exigir N copias do filtro — quebrava a
  // cada uso novo do denominador, falso positivo); a assercao abaixo e outra
  // coisa: guarda de UNICIDADE (exatamente 1 origem do literal), que e o proprio
  // invariante. E ela e RIGIDA ao nome `canaisComFicha` (4a revisao cega mediu:
  // renomear o helper reprova aqui) — renomeou? ajuste a guarda no mesmo commit.
  eq(
    (LIB_DB.match(/!semEstadoNoPainel\(c\)/g) || []).length,
    1,
    "o filtro de fonte externa deixou de ter origem unica: copia dele em outro lugar volta a poder ser removida de UM dos usos sem ninguem ver"
  );
  eq((LIB_DB.match(/canaisDaFicha\(\)/g) || []).length >= 2, true,
    "as duas travessias deixaram de sair do MESMO denominador (`canaisDaFicha`)");
  eq(/function canaisComFicha\(\)[\s\S]{0,200}?!semEstadoNoPainel\(c\)/.test(LIB_DB), true,
    "o filtro de fonte externa nao esta mais dentro de `canaisComFicha` (renomeou o helper? ajuste a guarda junto; tirou o filtro dele? isso e o defeito)");
  // a contagem de reserva nao monta caminho de jsonb com nome torto
  eq(
    /nomeCabeNoCaminhoJsonb\(nome\)/.test(LIB_DB),
    true,
    "a reserva confere a forma do nome pela funcao provada (bloco 41), nao por regex solto aqui"
  );
  // e a regra pura NAO importa banco (ela roda em node solto, e esta prova e a prova)
  const imports = (LIB.match(/^import .*$/gm) || []).join("\n");
  eq(/supabase|mensageria|next\//.test(imports), false, "lib/campos.ts ganhou import de infra");
  eq(imports.includes("./fluxo/variaveis.ts"), true, "lib/campos.ts nao reusa a normalizacao canonica");
  eq((LIB.match(/^import /gm) || []).length, 1, "lib/campos.ts passou a importar mais de um arquivo");
});

// ══════ 41) 'NAO SEI' NUNCA VIRA 'NENHUM' — a decisao saiu do executor
//
// A regra central da frente vivia dentro de `contarNoCanal`/`contarPorLeitura`, e
// so tinha guarda de TEXTO: trocar o `null` do erro por `0` sobrevivia a bateria
// inteira (medido na revisao cega). A partir dai o painel ofereceria remover um
// campo dizendo que NENHUMA conversa usa — depois de uma consulta que nem
// respondeu. Agora a decisao e pura, e cada caso e cobrado.
t("contagem: erro, ausencia e VAZIO sao NAO SEI — nunca zero", () => {
  eq(contagemDaResposta(0), 0, "zero de verdade continua sendo zero");
  eq(contagemDaResposta(37), 37, "numero passa");
  eq(contagemDaResposta("12"), 12, "numero em texto (o que o PostgREST as vezes devolve) conta");
  eq(contagemDaResposta(null), null, "resposta nula e NAO SEI");
  eq(contagemDaResposta(undefined), null, "resposta ausente e NAO SEI");
  eq(contagemDaResposta("nao e numero"), null, "resposta que nao e numero e NAO SEI");
  eq(contagemDaResposta(7, { code: "42501" }), null, "com erro, ate um numero na mao vira NAO SEI");
  eq(contagemDaResposta(0, { message: "timeout" }), null, "e zero COM erro tambem e NAO SEI (o caso perigoso)");

  // O ZERO FALSO DA COERCAO — medido na re-revisao cega de 31/08/2026, e e o pior
  // desfecho possivel desta frente. `Number("")`, `Number([])` e `Number(false)`
  // valem 0 e sao FINITOS: passavam pelo `Number.isFinite` e viravam contagem
  // ZERO. Zero e exatamente o numero que destrava a remocao do campo ("nenhuma
  // conversa usa este campo"), entao resposta vazia do PostgREST virava
  // autorizacao pra apagar. Agora a coercao e POR TIPO.
  eq(contagemDaResposta(""), null, "string vazia e NAO SEI (Number('') === 0, e finito)");
  eq(contagemDaResposta([]), null, "lista vazia e NAO SEI (Number([]) === 0, e finito)");
  eq(contagemDaResposta(false), null, "booleano e NAO SEI (Number(false) === 0, e finito)");
  eq(contagemDaResposta("  "), null, "so espaco e NAO SEI (Number('  ') === 0, e finito)");
  eq(contagemDaResposta(true), null, "e `true` tambem nao e contagem 1");
  eq(contagemDaResposta({}), null, "objeto nao e contagem");
  eq(contagemDaResposta([7]), null, "lista de um numero nao e contagem (Number([7]) === 7 e mentira de coercao)");
  eq(contagemDaResposta(NaN), null, "NaN nao e contagem");
  eq(contagemDaResposta(Infinity), null, "infinito nao e contagem");
  eq(contagemDaResposta(-3), -3, "numero negativo passa (nao e trabalho desta funcao julgar o sinal)");

  // e o nome que nao cabe no caminho de jsonb sai como NAO SEI antes da consulta
  eq(nomeCabeNoCaminhoJsonb("Cliente"), true, "nome simples cabe");
  eq(nomeCabeNoCaminhoJsonb("Numero do processo"), true, "com espaco cabe");
  eq(nomeCabeNoCaminhoJsonb("cnpj_2-b"), true, "com _ e - cabe");
  eq(nomeCabeNoCaminhoJsonb("Endereco (casa)"), false, "parentese nao cabe — vira NAO SEI, nunca contagem errada");
  eq(
    nomeCabeNoCaminhoJsonb("Endereço"),
    false,
    "acento nao cabe: e exatamente o nome que o sync do ChatGuru cria, e por isso o grant da 0025 importa tanto"
  );
  eq(nomeCabeNoCaminhoJsonb(""), false, "vazio nao cabe");
  eq(nomeCabeNoCaminhoJsonb("x".repeat(81)), false, "acima de 80 nao cabe");
});

// ══════ 42) OS DOIS EXECUTORES DA CONTAGEM — a funcao pura tem que estar COSTURADA
//
// `contagemDaResposta` esta provada caso a caso no bloco 41, mas prova de funcao
// pura nao alcanca quem a chama: medido na re-revisao cega, `contarNoCanal` e
// `contarPorLeitura` podiam devolver `0` no erro com a bateria inteira verde (duas
// mutacoes independentes, as duas sobreviviam). Aqui a guarda e do CORPO dos dois:
// todo `return` deles sai da decisao provada, do outro executor, ou e `null`.
t("os dois executores devolvem SO o que contagemDaResposta decidiu — falha e null, nunca 0", () => {
  for (const fn of ["contarNoCanal", "contarPorLeitura"]) {
    const corpo = semComentario(corpoDaFuncao(LIB_DB, `async function ${fn}(`));
    eq(corpo.length > 0, true, `achei ${fn}`);
    const retornos = (corpo.match(/return [^;]+;/g) || []).map((r) => r.slice(7, -1).trim());
    eq(retornos.length >= 2, true, `${fn} ficou sem retorno pra conferir`);
    for (const r of retornos) {
      eq(
        /^null$/.test(r) || /^contagemDaResposta\(.*\)$/.test(r) || /^contarPorLeitura\(.*\)$/.test(r),
        true,
        `${fn} devolve \`${r}\` — a contagem so pode sair de contagemDaResposta (ou ser null): qualquer outra coisa pode virar 0 e AUTORIZAR a remocao`
      );
    }
    eq(/\?\?\s*0|\|\|\s*0|:\s*0\b/.test(corpo), false, `${fn} tem um default 0 — "nao sei" viraria "nenhum"`);
    eq(/contagemDaResposta\(/.test(corpo), true, `${fn} parou de usar a decisao provada`);
  }
  // e o caminho da RPC so cai na reserva, nunca em zero
  const rpc = semComentario(corpoDaFuncao(LIB_DB, "async function contarNoCanal("));
  eq((rpc.match(/return contarPorLeitura\(/g) || []).length, 2,
    "a reserva tem que atender os DOIS jeitos de a RPC nao servir (indisponivel e erro)");
});

// ══════ 43) A FORMA DO CATALOGO — `legivel` e `renome_disponivel` por desfecho
//
// Os dois eram literais dentro de `lerCatalogo` (lib/campos-db.ts, que fala com o
// banco e nao roda em node solto), entao a unica prova possivel era varredura. Na
// re-revisao cega as duas mutacoes sobreviveram: `legivel: false` -> `true` (o
// painel volta a tratar leitura falhada como "zero registros", que e o defeito que
// a frente inteira existe pra fechar) e `disponiveis && rpcOk() || true` (a tela
// promete um renome que a rota devolve como 502).
t("catalogo: leitura que falhou e ILEGIVEL, e o renome exige as DUAS medicoes", () => {
  const f = falhaDeLeitura("timeout na leitura");
  eq(f.legivel, false, "leitura que falhou tem que sair ILEGIVEL — senao a tela afirma que a instalacao nao tem campo");
  eq(f.campos.length, 0, "e sem campo nenhum (a lista vazia so vale com o `legivel: false` do lado)");
  eq(f.tipos_disponiveis, false, "quem nao leu o catalogo nao pode prometer tipo");
  eq(f.renome_disponivel, false, "quem nao leu o catalogo nao pode prometer renome");
  eq(/timeout na leitura/.test(String(f.aviso)), true, "o aviso tem que dizer O QUE falhou");

  const ok = catalogoLido([campo({ nome: "CNPJ" })], true, true);
  eq(ok.legivel, true, "leitura que deu certo e legivel");
  eq(ok.campos.length, 1, "e devolve os campos lidos");
  eq(ok.renome_disponivel, true, "com colunas e RPC, o renome esta disponivel");
  eq(ok.aviso, undefined, "com tudo no lugar, nada de aviso");
  eq(catalogoLido([], true, false).renome_disponivel, false, "RPC fora = SEM renome (a tela nao pode prometer)");
  eq(catalogoLido([], false, true).renome_disponivel, false, "colunas fora = SEM renome");
  eq(catalogoLido([], false, false).renome_disponivel, false, "nada no lugar = SEM renome");
  eq(catalogoLido([], false, true).tipos_disponiveis, false, "sem as colunas da 0025 nao ha tipo");
  eq(catalogoLido([], false, true).legivel, true, "MAS a 0025 pendente nao torna o catalogo ilegivel (degradacao PREVISTA)");
  eq(/0025/.test(String(catalogoLido([], false, true).aviso)), true, "e o aviso nomeia a migration que falta");

  // e a fiacao EXECUTA as duas — sem literal proprio, que e o que a mutacao usava
  const corpo = semComentario(corpoDaFuncao(LIB_DB, "export async function lerCatalogo("));
  eq(corpo.length > 0, true, "achei lerCatalogo");
  eq(/return falhaDeLeitura\(error\.message\);/.test(corpo), true, "lerCatalogo nao delega a forma da FALHA");
  eq(/return catalogoLido\(campos, colunasOk\(\), rpcOk\(\)\);/.test(corpo), true,
    "lerCatalogo nao entrega o catalogo pela decisao, COM as duas medicoes reais");
  eq(/legivel:/.test(corpo), false, "voltou a montar `legivel` na mao dentro da fiacao");
  eq(/renome_disponivel:/.test(corpo), false, "voltou a montar `renome_disponivel` na mao dentro da fiacao");
});

// ══════ 44) OS QUATRO FECHAMENTOS DA ROTA ANTIGA — por DESFECHO, nao por varredura
//
// `/api/admin/ficha-config` e a tela velha: ela faz UPDATE direto e nao varre
// canal nenhum. As quatro regras abaixo eram linhas soltas do handler, cobradas
// por texto — e as quatro mutacoes passaram verdes na re-revisao cega. Agora cada
// uma e funcao pura de lib/campos.ts, e a prova CHAMA a decisao.
t("ficha-config: desativar, renomear, nome vazio e colisao — os quatro por desfecho", () => {
  // 1) DESATIVAR campo: a ficha da conversa itera o catalogo ATIVO, entao o valor
  //    some da tela no instante do clique — sem aviso e sem numero.
  const d = decidirPatchDeCatalogo("campo", { ativo: false });
  eq(d.ok, false, "desativar campo pela rota antiga voltou a passar (o valor some da tela sem ninguem ver quantas sao)");
  eq(d.ok === false && d.status, 409, "e a recusa e 409");
  eq(d.ok === false && /arquivar/.test(d.erro), true, "e a mensagem aponta a acao `arquivar`, que mede antes");
  eq(decidirPatchDeCatalogo("campo", { ativo: true }).ok, true, "REATIVAR tem que continuar passando: ele nao esconde nada");
  eq(decidirPatchDeCatalogo("campo", {}).ok, true, "patch sem nome e sem ativo nao e negocio desta regra");

  // 2) RENOMEAR: o valor fica gravado sob o nome ANTIGO e a ficha desenha pelo catalogo.
  const r = decidirPatchDeCatalogo("campo", { nome: "CNPJ da empresa" });
  eq(r.ok, false, "renomear campo pela rota antiga voltou a passar (perda silenciosa)");
  eq(r.ok === false && r.status, 409, "e a recusa e 409");
  eq(r.ok === false && /editar/.test(r.erro), true, "e a mensagem aponta a acao `editar`, que MIGRA os valores antes");
  eq(decidirPatchDeCatalogo("campo", { nome: "x", ativo: false }).ok, false, "os dois juntos tambem recusam");

  // ETIQUETA nao entra nesta regra: ela nao guarda valor por conversa na ficha.
  eq(decidirPatchDeCatalogo("etiqueta", { ativo: false }).ok, true, "desativar ETIQUETA continua sendo gesto legitimo aqui");
  eq(decidirPatchDeCatalogo("etiqueta", { nome: "Urgente" }).ok, true, "renomear ETIQUETA continua sendo gesto legitimo aqui");

  // 3) NOME que normaliza pra vazio: `%`, `---`, `...` passavam pelo trim/slice.
  const vazio = decidirNomeDeCampoNovo("---");
  eq(vazio.ok, false, "nome que normaliza pra vazio voltou a ser aceito");
  eq(vazio.ok === false && vazio.status, 422, "e a recusa e 422");
  eq(vazio.ok === false && /letra ou numero/.test(vazio.erro), true, "e a mensagem diz o que falta");
  eq(decidirNomeDeCampoNovo("%").ok, false, "`%` sozinho nao vira chave");
  eq(decidirNomeDeCampoNovo("   ").ok, false, "so espaco nao e nome");
  eq(decidirNomeDeCampoNovo("").ok, false, "vazio nao e nome");
  eq(decidirNomeDeCampoNovo(123).ok, false, "numero nao e nome");
  eq(decidirNomeDeCampoNovo("x".repeat(81)).ok, false, "acima de 80 nao e nome");
  eq(decidirNomeDeCampoNovo("a\u0007b").ok, false, "caractere de controle viraria chave que ninguem digita de novo");
  const bom = decidirNomeDeCampoNovo("  Numero   do  processo  ");
  eq(bom.ok, true, "nome legitimo passa");
  eq(bom.ok === true && bom.nome, "Numero do processo", "e sai SANEADO (espaco colapsado), nao cru");

  // 4) COLISAO: e ela falha FECHADO — consulta que falhou nao pode virar "pode criar".
  const e = decidirColisaoNoCatalogo(null, { message: "timeout" }, "CNPJ");
  eq(e.ok, false, "catalogo ilegivel voltou a deixar criar (a colisao nao seria detectada justo com o banco ruim)");
  eq(e.ok === false && e.status, 503, "e o status e 503 (transiente: a leitura pode voltar no proximo pedido), nunca 500");
  eq(e.ok === false && /timeout/.test(e.erro), true, "e a mensagem carrega o motivo do banco");
  const c = decidirColisaoNoCatalogo([{ nome: "cnpj", ativo: true }], null, "CNPJ");
  eq(c.ok, false, "colisao NORMALIZADA (CNPJ x cnpj) tem que recusar: as duas disputam a mesma chave do jsonb");
  eq(c.ok === false && c.status, 409, "e a recusa e 409");
  const arq = decidirColisaoNoCatalogo([{ nome: "cnpj", ativo: false }], null, "CNPJ");
  eq(arq.ok, false, "colide tambem com campo ARQUIVADO (ele ainda guarda valor)");
  eq(arq.ok === false && /arquivado/.test(arq.erro), true, "e a mensagem diz que o existente esta arquivado");
  eq(decidirColisaoNoCatalogo([{ nome: "Telefone", ativo: true }], null, "CNPJ").ok, true, "nome diferente passa");
  eq(decidirColisaoNoCatalogo([], null, "CNPJ").ok, true, "catalogo vazio passa");
  eq(decidirColisaoNoCatalogo(undefined, null, "CNPJ").ok, true, "resposta ausente SEM erro passa (o erro e quem recusa)");
  // A ARMADILHA DO ILIKE nao volta por esta porta: `%` e `_` digitados nao viram coringa
  eq(decidirColisaoNoCatalogo([{ nome: "cnpj_2", ativo: true }], null, "cnpj%").ok, true,
    "`cnpj%` nao pode casar com `cnpj_2` — sob ilike casaria e o campo seria recusado sem motivo");

  // 5) ARQUIVAR E EM DOIS PASSOS — o gesto que tira o campo do formulario da CONTA
  //    INTEIRA merece o mesmo tratamento do DELETE: ver o impacto ANTES.
  eq(decidirArquivamento(true, undefined), "previa", "arquivar sem confirmar tem que ser PREVIA (e previa nao muda nada)");
  eq(decidirArquivamento(true, false), "previa", "confirmar: false e previa");
  eq(decidirArquivamento(true, "1"), "previa", "so o booleano `true` confirma — string verdadeira nao arquiva a conta inteira");
  eq(decidirArquivamento(true, 1), "previa", "nem numero verdadeiro");
  eq(decidirArquivamento(true, true), "arquivar", "com confirmacao explicita, aplica");
  eq(decidirArquivamento(false, undefined), "reativar", "REATIVAR nao tem previa: ele nao esconde nada de ninguem");
  eq(decidirArquivamento(false, true), "reativar", "e reativar nao vira arquivamento por causa do confirmar");

  // O USO das quatro decisoes NAO se prova aqui: ele e o corpo dos handlers, e
  // corpo de handler so alcanca varredura. Os blocos 46 e 47 executam esse corpo
  // (`executarArquivamento` e `executarFichaConfig`, efeitos injetados) e conferem
  // o DESFECHO — inclusive o que NAO foi gravado.
});

// ══════ 45) A TELA VELHA NAO PODE OFERECER O QUE A ROTA RECUSA
//
// O 409 novo do bloco 44 deixou o botao "Remover" da aba Ficha (app/home.tsx)
// PERMANENTEMENTE quebrado: ele mandava `{tipo:"campo", id, ativo:false}` e a rota
// passou a recusar sempre. Controle clicavel que nao pode funcionar em
// circunstancia nenhuma e estado impossivel — o padrao que este repo condena, e
// que so se explica clicando.
t("a aba Ficha nao tem mais o `Remover` impossivel, e aponta pra tela que mede antes", () => {
  // SEM COMENTARIO, como os outros blocos: o comentario JSX que explica a saida do
  // botao contem `ativo:false`, e ele so escapava de `/ativo: false/` por nao ter
  // espaco depois dos dois-pontos. Reescrever o comentario deixaria a bateria
  // vermelha sem mudar comportamento nenhum.
  const HOME_LIMPO = semComentario(HOME);
  eq(/ativo/.test(semComentario("{/* ativo: false */}")), false, "semComentario deixou de cortar comentario JSX");
  // TRANCHE 2 da revisao de interface (03/09/2026): a metade "Campos da ficha" da aba
  // velha SAIU de home.tsx — a aba `fichacfg` ficou so com etiquetas e o construtor
  // inteiro (AdminCampos, o que mede o impacto antes de arquivar) virou a aba `campos`,
  // embutido. Entao o que se cobra agora e: (1) a aba de etiquetas nao voltou a
  // oferecer NENHUM gesto sobre campo (nem o `Remover` impossivel, nem a lista velha);
  // (2) o toggle de ETIQUETA continua la; (3) a aba `campos` monta o construtor.
  const abaEtiquetas = HOME_LIMPO.split('abaConfig === "fichacfg"')[1]?.split('abaConfig === "campos"')[0] ?? "";
  eq(abaEtiquetas.length > 0, true, "achei a aba Etiquetas (fichacfg) antes da aba Campos");
  eq(/Campos da ficha \(padrao/.test(abaEtiquetas), false, "a lista velha de campos voltou pra aba de etiquetas");
  eq(/tipo: "campo"/.test(abaEtiquetas), false,
    "a aba de etiquetas voltou a mexer em CAMPO — no campo ATIVO isso manda `false`, que a rota recusa com 409 SEMPRE");
  eq(/ativo: false/.test(abaEtiquetas), false, "a aba velha voltou a tentar desativar campo por ali");
  eq(/tipo: "etiqueta", id: c\.id, ativo: !c\.ativo/.test(abaEtiquetas), true,
    "o toggle da ETIQUETA foi removido junto — ele continua funcionando e nao deve mudar");
  const abaCampos = HOME_LIMPO.split('abaConfig === "campos"')[1]?.slice(0, 400) ?? "";
  eq(/temPermissao\("gerenciar_campos"\)/.test(abaCampos), true, "a aba Campos nao cobra a permissao que a rota do catalogo cobra");
  eq(/<AdminCampos authedFetch=\{authedFetch\} embutido \/>/.test(abaCampos), true,
    "a aba Campos nao monta o construtor (o unico lugar que arquiva com o impacto medido)");

  // e o verbete da permissao para de documentar o que a rota nao faz mais
  const verbete = DESCRICAO_PERMISSAO.gerenciar_etiquetas;
  eq(/ativar\/desativar/.test(verbete), false, "o verbete ainda promete `ativar/desativar` campo pela rota antiga");
  eq(/REATIVAR/.test(verbete), true, "o verbete nao diz o que de fato sobrou (criar texto e reativar)");
  eq(/409/.test(verbete), true, "o verbete nao diz que desativar e renomear agora sao RECUSADOS ali");
});


// ══════ 46) ARQUIVAR CAMPO — o CORPO do handler, por DESFECHO
//
// A guarda antiga era a ordem dos literais `previa: true` / `ativo: false` dentro
// de `arquivar()`. Medido na 3a rodada da re-revisao cega (31/08/2026):
// `if (passo === "previa" && false)` passava VERDE — o literal continua no corpo,
// dentro do `if` morto, e o campo sai do formulario da CONTA INTEIRA sem ninguem
// ver o numero. Agora o corpo e `executarArquivamento` (efeitos injetados) e o que
// se confere e o que foi, e principalmente o que NAO foi, gravado.
await ta("arquivar: sem confirmar NADA e gravado, e o numero e medido antes de aplicar", async () => {
  const CAMPO = { id: "c1", nome: "CNPJ" };
  // O EFEITO E A CONTAGEM DE UM CANAL (4a rodada), e nao o impacto pronto: quem
  // soma e quem decide `incompleto` e o `medirImpacto` PURO, que roda de verdade
  // aqui. A forma antiga (`medirImpacto` injetado) deixava o adaptador entregar o
  // veredito numerico montado — e `{conversas: 0, por_canal: []}` fazia a previa
  // dizer "nada se perde", com a bateria inteira verde (M10b).
  const CONTAGEM: Record<string, number> = { central: 5, apioficial: 2 };
  const fakes = (falhaAoGravar = false) => {
    const trilha: string[] = [];
    const gravados: { id: string; patch: Record<string, unknown> }[] = [];
    return {
      trilha,
      gravados,
      ef: {
        canais: Object.keys(CONTAGEM),
        contar: async (canal: string, nome: string) => {
          if (!trilha.includes(`medir:${nome}`)) trilha.push(`medir:${nome}`);
          return CONTAGEM[canal] ?? null;
        },
        gravar: async (id: string, patch: Record<string, unknown>) => {
          trilha.push(`gravar:${String(patch.ativo)}`);
          gravados.push({ id, patch });
          return falhaAoGravar
            ? ({ ok: false, motivo: "coluna atualizado_em nao existe", status: 400 } as const)
            : ({ ok: true } as const);
        },
        agora: () => "2026-08-31T12:00:00.000Z",
      },
    };
  };

  // 1) ARQUIVAR SEM CONFIRMAR = PREVIA, e previa nao muda NADA
  for (const confirmar of [undefined, false, "1", 1, "true", null]) {
    const f = fakes();
    const r = await executarArquivamento(CAMPO, true, confirmar, f.ef);
    eq(r.status, 200, "a previa nao e erro");
    eq(r.corpo.previa, true, `arquivar com confirmar=${JSON.stringify(confirmar)} deixou de devolver a previa`);
    eq(
      f.gravados.length,
      0,
      `ARQUIVOU SEM PREVIA (confirmar=${JSON.stringify(confirmar)}): o campo saiu do formulario da conta inteira e o numero do impacto chegou quando ja nao dava pra decidir com ele`
    );
    eq(r.corpo.ok, undefined, "a previa nao pode se anunciar como feito");
  }
  {
    const f = fakes();
    const r = await executarArquivamento(CAMPO, true, undefined, f.ef);
    eq((r.corpo.impacto as ImpactoCampo).conversas, 7, "a previa nao carrega o numero medido");
    eq((r.corpo.veredito as { acao: string }).acao, "arquivar", "a previa nao carrega o veredito");
    eq(r.corpo.campo, "CNPJ", "a previa nao diz de que campo esta falando");
    eq(f.trilha.join("|"), "medir:CNPJ", "a previa gastou mais que a medicao");
  }

  // 2) COM `confirmar: true` aplica — e MEDE ANTES (o numero volta pra tela dizer
  //    quantas conversas ficaram com "valores sem campo")
  {
    const f = fakes();
    const r = await executarArquivamento(CAMPO, true, true, f.ef);
    eq(r.status, 200);
    eq(r.corpo.ok, true, "com confirmacao explicita o arquivamento tem que acontecer");
    eq(f.gravados.length, 1, "confirmou e nao gravou");
    eq(f.gravados[0].id, "c1", "gravou em outro campo");
    eq(f.gravados[0].patch.ativo, false, "o patch do arquivamento nao desativa o campo");
    eq(typeof f.gravados[0].patch.atualizado_em, "string", "o arquivamento nao carimba `atualizado_em`");
    eq(f.trilha.join("|"), "medir:CNPJ|gravar:false", "a medicao tem que vir ANTES da gravacao");
    eq((r.corpo.impacto as ImpactoCampo).conversas, 7, "a resposta do arquivamento perdeu o numero");
  }

  // 3) REATIVAR nao tem previa E NAO MEDE: ele nao esconde nada de ninguem
  for (const confirmar of [undefined, true, false]) {
    const f = fakes();
    const r = await executarArquivamento(CAMPO, false, confirmar, f.ef);
    eq(r.status, 200);
    eq(r.corpo.ok, true, "reativar deixou de funcionar");
    eq(r.corpo.previa, undefined, "reativar ganhou previa: ritual pra gesto sem consequencia");
    eq(f.gravados.length, 1, "reativar nao gravou");
    eq(f.gravados[0].patch.ativo, true, "reativar gravou coisa diferente de `ativo: true`");
    eq(f.trilha.join("|"), "gravar:true", "reativar gastou uma medicao que ninguem le");
    eq(r.corpo.impacto, null, "reativar tem que dizer explicitamente que nao mediu impacto");
  }

  // 4) GRAVACAO QUE FALHOU nao vira 200 calado — o status do banco sobe
  {
    const f = fakes(true);
    const r = await executarArquivamento(CAMPO, true, true, f.ef);
    eq(r.status, 400, "falha de gravacao virou sucesso");
    eq(r.corpo.ok, undefined, "falha de gravacao respondeu `ok`");
    eq(String(r.corpo.error).includes("atualizado_em"), true, "a falha perdeu o motivo do banco");
  }

  // O QUE SO A VARREDURA ALCANCA (a rota importa `next/server`): que o handler
  // EXECUTE este corpo com os argumentos REAIS. Trocar `arquivando` por `true`
  // faria "reativar" arquivar, e nenhuma prova ve isso por desfecho — este e
  // portao herdado da 3a rodada, e ele e TOLERANTE a espaco e a hoisting
  // (`const confirmar = body?.confirmar` continua passando), mas RIGIDO aos
  // NOMES `atual`/`arquivando`/`confirmar` (4a revisao cega mediu: renomear o
  // local `atual` reprova aqui). Renomeou de proposito? Ajuste esta guarda no
  // MESMO commit — nunca a afrouxe pra regex que aceita qualquer argumento.
  const corpo = semComentario(corpoDaFuncao(ROTA_CAT, "async function arquivar("));
  const chamada = corpo.slice(Math.max(0, corpo.indexOf("executarArquivamento(")));
  eq(/^executarArquivamento\(\s*atual\s*,\s*arquivando\s*,\s*[^,]*confirmar/.test(chamada), true,
    "a chamada canonica `executarArquivamento(atual, arquivando, ...confirmar)` sumiu da rota — mudou os nomes? ajuste a guarda junto; tirou um argumento real? isso e o defeito");
  // CINTO REDUNDANTE (o portao sao as assercoes de desfecho acima): a rota nao
  // reimplementa a decisao do arquivamento.
  eq(/previa: true|ativo: false|decidirArquivamento\(/.test(corpo), false,
    "a rota voltou a decidir o arquivamento por conta propria");
  // e o EFEITO e montado pelo adaptador provado (bloco 51), com o executor real
  // por dentro — aqui e onde caberia o `?? 0` que apaga o `incompleto`. Tolerante
  // de proposito: `contar: (c, n) => contarCampoNoCanal(c, n)` tambem passa.
  eq(/efeitosDeArquivamento\(/.test(corpo), true,
    "a rota voltou a montar o efeito do arquivamento na mao, fora do alcance da prova");
  eq(/contar:[\s\S]{0,80}?contarCampoNoCanal/.test(corpo), true, "o efeito de contagem deixou de ser o executor real");
  eq(/\?\?\s*0|conversas:|por_canal:/.test(corpo), false,
    "apareceu contagem normalizada na rota: `?? 0` (ou um impacto montado a mao) apaga o `incompleto` e destrava o arquivamento no escuro");
});

// ══════ 47) A ROTA ANTIGA DE CATALOGO — o CORPO do handler, por DESFECHO
//
// Tres das cinco mutacoes que passaram verdes na 3a rodada moravam aqui: um
// `update({ativo:false})` inserido ANTES da decisao (a perda silenciosa que a
// frente existe pra fechar, de volta inteira), um `if (!vcol.ok && false)` (colisao
// normalizada volta a nascer) e uma reatribuicao do nome DEPOIS do saneamento
// (`"---"` volta a ser gravavel). As tres sobreviviam porque a guarda cobrava a
// presenca das linhas, e nenhuma delas foi REMOVIDA — foram DESLIGADAS.
await ta("ficha-config: a rota OBEDECE as quatro decisoes — quando elas recusam, NADA e escrito", async () => {
  const fakes = (catalogo: unknown = [], erroCat: unknown = null, falha = false) => {
    const atualizados: { tabela: string; id: string; patch: Record<string, unknown> }[] = [];
    const inseridos: { tabela: string; linha: Record<string, unknown> }[] = [];
    return {
      atualizados,
      inseridos,
      ef: {
        atualizar: async (tabela: string, id: string, patch: Record<string, unknown>) => {
          atualizados.push({ tabela, id, patch });
          return falha ? ({ ok: false, motivo: "timeout no update" } as const) : ({ ok: true } as const);
        },
        lerNomes: async () => ({ data: catalogo, erro: erroCat }),
        proximaOrdem: async () => 4,
        inserir: async (tabela: string, linha: Record<string, unknown>) => {
          inseridos.push({ tabela, linha });
          return falha
            ? ({ ok: false, motivo: "timeout no insert" } as const)
            : ({ ok: true, item: { id: "novo", ...linha } } as const);
        },
      },
    };
  };

  // 1) DESATIVAR CAMPO: 409 e ZERO escrita. Esta e a mutacao que reabria a perda
  //    silenciosa — o handler aplicava e retornava ANTES da decisao ser consultada.
  {
    const f = fakes();
    const r = await executarFichaConfig({ tipo: "campo", id: "c1", ativo: false }, f.ef);
    eq(r.status, 409, "desativar campo pela rota antiga deixou de ser recusado");
    eq(f.atualizados.length, 0,
      "A ROTA ANTIGA VOLTOU A DESATIVAR CAMPO: o valor gravado nas conversas some da tela sem ninguem ver quantas sao");
    eq(String(r.corpo.error).includes("arquivar"), true, "a recusa nao aponta o caminho que mede antes");
  }

  // 2) RENOMEAR CAMPO: 409 e ZERO escrita
  {
    const f = fakes();
    const r = await executarFichaConfig({ tipo: "campo", id: "c1", nome: "CNPJ novo" }, f.ef);
    eq(r.status, 409, "renomear campo pela rota antiga deixou de ser recusado");
    eq(f.atualizados.length, 0, "A ROTA ANTIGA VOLTOU A RENOMEAR CAMPO: o valor fica no banco sob o nome antigo, invisivel");
    eq(String(r.corpo.error).includes("editar"), true, "a recusa nao aponta a acao que MIGRA os valores");
  }
  {
    const f = fakes();
    const r = await executarFichaConfig({ tipo: "campo", id: "c1", nome: "X", ativo: false }, f.ef);
    eq(r.status, 409, "os dois gestos juntos tambem recusam");
    eq(f.atualizados.length, 0, "os dois juntos escreveram");
  }

  // 3) REATIVAR CAMPO continua passando, e ESCREVE de verdade (tirar o gesto
  //    legitimo junto seria o erro oposto)
  {
    const f = fakes();
    const r = await executarFichaConfig({ tipo: "campo", id: "c1", ativo: true }, f.ef);
    eq(r.status, 200, "reativar campo pela rota antiga parou de funcionar");
    eq(f.atualizados.length, 1, "reativar nao escreveu");
    eq(f.atualizados[0].tabela, "campos_personalizados", "reativar escreveu na tabela errada");
    eq(f.atualizados[0].id, "c1");
    assert.deepEqual(f.atualizados[0].patch, { ativo: true });
    assercoes++;
  }

  // 4) ETIQUETA nao entra nesta regra (ela nao guarda valor por conversa)
  {
    const f = fakes();
    eq((await executarFichaConfig({ tipo: "etiqueta", id: "e1", ativo: false }, f.ef)).status, 200,
      "desativar ETIQUETA parou de funcionar");
    eq((await executarFichaConfig({ tipo: "etiqueta", id: "e1", nome: "Urgente" }, f.ef)).status, 200,
      "renomear ETIQUETA parou de funcionar");
    eq(f.atualizados.length, 2, "as duas escritas de etiqueta nao aconteceram");
    eq(f.atualizados[0].tabela, "etiquetas_catalogo", "etiqueta escreveu na tabela de campos");
    assert.deepEqual(f.atualizados[1].patch, { nome: "Urgente" });
    assercoes++;
  }

  // 5) PATCH VAZIO nao vira UPDATE sem colunas
  {
    const f = fakes();
    const r = await executarFichaConfig({ tipo: "campo", id: "c1" }, f.ef);
    eq(r.status, 400, "patch sem nada deixou de recusar");
    eq(f.atualizados.length, 0, "patch vazio virou UPDATE");
  }

  // 6) CRIAR: nome que normaliza pra vazio e 422, e NADA e inserido. (Era a
  //    mutacao do nome cru sobrescrevendo o saneado.)
  for (const ruim of ["---", "%", "...", "   "]) {
    const f = fakes();
    const r = await executarFichaConfig({ tipo: "campo", nome: ruim }, f.ef);
    eq(r.status === 422 || r.status === 400, true, `o nome ${JSON.stringify(ruim)} voltou a ser aceito`);
    eq(f.inseridos.length, 0,
      `campo com nome ${JSON.stringify(ruim)} foi GRAVADO: ele nao vira chave, entao \`!campo.<nome>\` e a condicao de ficha nunca o alcancam`);
  }

  // 7) CRIAR: o que chega no banco e o nome SANEADO, nunca o cru
  {
    const f = fakes();
    const r = await executarFichaConfig({ tipo: "campo", nome: "  Numero   do  processo  " }, f.ef);
    eq(r.status, 200, "nome legitimo deixou de ser aceito");
    eq(f.inseridos.length, 1, "o campo legitimo nao foi criado");
    eq(f.inseridos[0].linha.nome, "Numero do processo",
      "O NOME CRU SOBRESCREVEU O SANEADO: espaco duplo (e tudo que `nomeDeCampo` corrige) volta a entrar na chave do jsonb");
    eq(f.inseridos[0].linha.ativo, true, "campo novo nasce inativo");
    eq(f.inseridos[0].linha.ordem, 4, "campo novo nasce sem a ordem do fim da fila");
    eq(f.inseridos[0].tabela, "campos_personalizados");
  }

  // 8) CRIAR: colisao NORMALIZADA recusa com 409 e NAO insere. (Era o
  //    `if (!vcol.ok && false)`: com dois nomes disputando a mesma chave do jsonb,
  //    `acharCampo` fica ambiguo e TODA escrita naquele campo passa a ser recusada
  //    na conta inteira.)
  {
    const f = fakes([{ nome: "cnpj", ativo: true }]);
    const r = await executarFichaConfig({ tipo: "campo", nome: "CNPJ" }, f.ef);
    eq(r.status, 409, "colisao normalizada voltou a ser aceita");
    eq(f.inseridos.length, 0, "A COLISAO FOI CRIADA: 'CNPJ' e 'cnpj' disputam a mesma chave e travam a escrita da conta inteira");
  }
  {
    const f = fakes([{ nome: "cnpj", ativo: false }]);
    const r = await executarFichaConfig({ tipo: "campo", nome: "CNPJ" }, f.ef);
    eq(r.status, 409, "campo ARQUIVADO parou de colidir (ele ainda guarda valor)");
    eq(f.inseridos.length, 0, "colidiu com arquivado e inseriu mesmo assim");
  }

  // 9) CRIAR com o catalogo ILEGIVEL falha FECHADO: 503 e nada inserido
  {
    const f = fakes(null, { message: "timeout" });
    const r = await executarFichaConfig({ tipo: "campo", nome: "CNPJ" }, f.ef);
    eq(r.status, 503, "leitura do catalogo que falhou voltou a deixar criar");
    eq(f.inseridos.length, 0, "criou campo sem conseguir conferir colisao — justo com o banco ruim");
    eq(String(r.corpo.error).includes("timeout"), true, "a recusa perdeu o motivo do banco");
  }

  // 10) ETIQUETA nova nao passa pelo saneamento de CAMPO (ela nao vira chave de
  //     jsonb) — comportamento anterior, preservado de proposito
  {
    const f = fakes();
    const r = await executarFichaConfig({ tipo: "etiqueta", nome: "  Urgente  " }, f.ef);
    eq(r.status, 200);
    assert.deepEqual(f.inseridos[0], { tabela: "etiquetas_catalogo", linha: { nome: "Urgente", ativo: true } });
    assercoes++;
    eq(f.inseridos[0].linha.ordem, undefined, "etiqueta ganhou `ordem`, que a tabela dela nao tem");
  }

  // 11) as bordas do pedido
  {
    const f = fakes();
    eq((await executarFichaConfig({ tipo: "outro", nome: "X" }, f.ef)).status, 400, "tipo invalido deixou de recusar");
    eq((await executarFichaConfig({ nome: "X" }, f.ef)).status, 400, "tipo ausente deixou de recusar");
    eq((await executarFichaConfig({ tipo: "campo" }, f.ef)).status, 400, "criar sem nome deixou de recusar");
    eq((await executarFichaConfig({ tipo: "campo", nome: 7 }, f.ef)).status, 400, "nome que nao e texto deixou de recusar");
    eq(f.atualizados.length + f.inseridos.length, 0, "pedido invalido escreveu no banco");
  }

  // 12) FALHA DO BANCO nao vira 200 calado
  {
    const f = fakes([], null, true);
    eq((await executarFichaConfig({ tipo: "campo", id: "c1", ativo: true }, f.ef)).status, 500, "update que falhou virou sucesso");
    eq((await executarFichaConfig({ tipo: "campo", nome: "Cidade" }, f.ef)).status, 500, "insert que falhou virou sucesso");
  }
});


// ══════ 48) A FICHA QUE O FLUXO LE — fail-closed provado por DESFECHO
//
// A guarda antiga era `/indisponiveis\.ficha\s*=/` no corpo de `coletarFatos`, e
// ela errava nas DUAS direcoes (medido na 3a rodada da re-revisao cega):
//   * `indisponiveis["ficha"] = motivo` — mesma semantica, outra forma — REPROVAVA
//     (refatoracao inocua das Frentes W/Y quebraria a bateria no merge);
//   * `if (campos.has("ficha") && error)` — propriedade destruida, forma
//     preservada — PASSAVA. Fail-open real: "conversa nao encontrada" (que vem SEM
//     `error`) deixava de marcar `indisponiveis.ficha`, `fatos.ficha` ficava
//     `undefined`, e o macro decidia contra uma ficha inventada sem erro nenhum.
// Agora a decisao e `coletaDaLinhaDeConversa` (pura, em lib/fluxo/schema.ts) e o
// que se cobra e a PROPRIEDADE, com a resposta do banco na mao.
t("coletarFatos: leitura ruim marca INDISPONIVEL e a ficha nunca e inventada vazia", () => {
  const TUDO = new Set<CampoCondicao>(["status", "etiqueta", "ficha"]);

  // 1) ERRO DO BANCO: os tres campos pedidos ficam indisponiveis, com o motivo
  {
    const r = coletaDaLinhaDeConversa(TUDO, null, { message: "timeout na leitura" });
    eq(r.indisponiveis.ficha, "timeout na leitura", "erro na leitura deixou de marcar a ficha como indisponivel");
    eq(r.indisponiveis.status, "timeout na leitura");
    eq(r.indisponiveis.etiqueta, "timeout na leitura");
    eq("ficha" in r.fatos, false, "A FICHA FOI INVENTADA depois de uma leitura que falhou");
  }

  // 2) CONVERSA NAO ENCONTRADA — o caso que a guarda de token deixava passar:
  //    `maybeSingle()` devolve linha ausente SEM erro.
  {
    const r = coletaDaLinhaDeConversa(TUDO, null, null);
    eq(r.indisponiveis.ficha, "conversa nao encontrada",
      "linha ausente SEM erro deixou de marcar a ficha: fail-open real, o macro decide contra ficha inventada");
    eq(r.indisponiveis.status, "conversa nao encontrada");
    eq("ficha" in r.fatos, false, "a ficha foi inventada com a conversa nao encontrada");
    eq("status" in r.fatos, false, "o status foi inventado com a conversa nao encontrada");
  }
  // erro sem `message` legivel tambem tem motivo
  eq(coletaDaLinhaDeConversa(TUDO, null, "caiu").indisponiveis.ficha, "conversa nao encontrada",
    "erro sem `message` perdeu o motivo (e ficaria sem marcar)");
  eq(coletaDaLinhaDeConversa(TUDO, { ficha: { A: "1" } }, { message: "" }).indisponiveis.ficha, "conversa nao encontrada",
    "erro com `message` vazio deixou de recusar a linha");

  // 3) SO QUEM PEDIU e marcado (condicao que nao le ficha nao trava por ela)
  {
    const r = coletaDaLinhaDeConversa(new Set<CampoCondicao>(["status"]), null, null);
    eq(r.indisponiveis.status, "conversa nao encontrada");
    eq(r.indisponiveis.ficha, undefined, "marcou `ficha` indisponivel pra quem nao pediu ficha");
    eq(r.indisponiveis.etiqueta, undefined, "marcou `etiqueta` indisponivel pra quem nao pediu etiqueta");
  }

  // 4) LEITURA BOA: a ficha vira mapa de texto, e nada fica indisponivel
  {
    const r = coletaDaLinhaDeConversa(TUDO, {
      status: "atendimento",
      etiquetas: ["vip", 3, null, "novo"],
      ficha: { CNPJ: "123", Idade: 40, Ativo: true, Objeto: { a: 1 }, Lista: [1], Nulo: null },
    }, null);
    assert.deepEqual(r.indisponiveis, {});
    assercoes++;
    eq(r.fatos.status, "atendimento");
    assert.deepEqual(r.fatos.etiquetas, ["vip", "novo"]);
    assercoes++;
    eq(r.fatos.ficha?.CNPJ, "123");
    eq(r.fatos.ficha?.Idade, "40", "numero na ficha tem que virar texto, senao a condicao compara 1 com \"1\" e nunca casa");
    eq(r.fatos.ficha?.Ativo, "true");
    eq(r.fatos.ficha?.Objeto, undefined, "objeto no jsonb nao vira texto: some da leitura");
    eq(r.fatos.ficha?.Lista, undefined, "lista no jsonb nao vira texto: some da leitura");
    eq(r.fatos.ficha?.Nulo, undefined, "null no jsonb nao e valor preenchido");
  }

  // 5) LINHA SEM COLUNA `ficha` (a conversa nunca teve ficha) e ficha VAZIA
  //    DE VERDADE — e isso e diferente de "nao deu pra ler"
  {
    const r = coletaDaLinhaDeConversa(TUDO, { status: null, etiquetas: null }, null);
    assert.deepEqual(r.indisponiveis, {});
    assercoes++;
    assert.deepEqual({ ...r.fatos.ficha }, {});
    assercoes++;
    eq("ficha" in r.fatos, true, "conversa sem ficha e mapa VAZIO, nao mapa ausente: aqui a leitura deu certo");
    eq(r.fatos.status, null, "status nulo e um fato, nao uma indisponibilidade");
    assert.deepEqual(r.fatos.etiquetas, []);
    assercoes++;
  }
  // ficha que veio como lista/texto no jsonb tambem e mapa vazio (leitura OK)
  for (const bruto of [[1, 2], "texto", 7, true, null]) {
    const r = coletaDaLinhaDeConversa(TUDO, { ficha: bruto }, null);
    assert.deepEqual({ ...r.fatos.ficha }, {});
    assercoes++;
    eq(r.indisponiveis.ficha, undefined, `ficha ${JSON.stringify(bruto)} no jsonb virou indisponibilidade`);
  }

  // 6) E O DESFECHO NO AVALIADOR — por que a diferenca importa. Com a ficha
  //    INVENTADA vazia, a condicao responde com confianca (e erra); sem ela, o
  //    campo fica ausente e quem avisa e `indisponiveis`, que PARA o macro.
  const cond = (validarCondicao({ tipo: "comparacao", campo: "ficha", operador: "existe", chave: "CNPJ" }) as any).condicao;
  eq(avaliarCondicao(cond, { ficha: {} }), false, "ficha inventada vazia responde 'nao existe' — a resposta errada com cara de certa");
  const ruim = coletaDaLinhaDeConversa(TUDO, null, { message: "timeout" });
  eq(avaliarCondicao(cond, ruim.fatos), false, "e o valor bruto e o mesmo: por isso quem separa os dois casos e `indisponiveis`");
  eq(ruim.indisponiveis.ficha !== undefined, true, "...e ele TEM que estar preenchido, senao o macro segue com cara de decidido");
});

// ══════ 49) A COLETA COMPLETA DA LINHA — leitor injetado, e os DOIS mapas
//
// O bloco 48 prova a DECISAO (o que a resposta do banco significa). Aqui esta o
// resto do que saiu do motor na 4a rodada: a escolha das colunas, a CHAMADA do
// leitor e o enchimento dos dois mapas do chamador. Era a "fiacao" que so
// alcancava varredura de token — e a varredura cobrava tres linhas EXATAS,
// reprovando refatoracao inocua (o pior defeito possivel numa onda de merge).
await ta("a coleta da linha: escolhe coluna, chama o leitor e enche os DOIS mapas do chamador", async () => {
  const SO_STATUS = new Set<CampoCondicao>(["status"]);
  const COM_FICHA = new Set<CampoCondicao>(["status", "ficha"]);

  // 1) AS COLUNAS: `ficha` e jsonb (dezenas de chaves por conversa) e so vem
  //    quando alguem pede. `status`/`etiquetas` vem sempre que a linha vem.
  assert.deepEqual(colunasDaLinhaDeConversa(SO_STATUS), ["status", "etiquetas"]);
  assercoes++;
  assert.deepEqual(colunasDaLinhaDeConversa(COM_FICHA), ["status", "etiquetas", "ficha"]);
  assercoes++;
  eq(colunasDaLinhaDeConversa(new Set<CampoCondicao>(["etiqueta"])).includes("ficha"), false,
    "condicao que nao pede ficha passou a pagar o jsonb inteiro em toda leitura");

  // 2) CONDICAO QUE NAO PEDE ESTA LINHA NAO GASTA CONSULTA
  eq(pedeALinhaDeConversa(new Set<CampoCondicao>(["texto", "contexto"])), false,
    "campo que nao sai desta linha passou a disparar a leitura dela");
  {
    let chamadas = 0;
    const r = await fatosDaLinhaDeConversa(new Set<CampoCondicao>(["texto"]), async () => {
      chamadas++;
      return { data: null, erro: null };
    });
    eq(chamadas, 0, "macro que nao olha esta linha foi ao banco de todo jeito");
    assert.deepEqual(r, { fatos: {}, indisponiveis: {} });
    assercoes++;
  }

  // 3) O LEITOR RECEBE as colunas escolhidas (nao uma lista fixa)
  {
    let vistas: string[] = [];
    await fatosDaLinhaDeConversa(COM_FICHA, async (colunas) => {
      vistas = colunas;
      return { data: { status: "aberto", etiquetas: [], ficha: {} }, erro: null };
    });
    assert.deepEqual(vistas, ["status", "etiquetas", "ficha"]);
    assercoes++;
  }

  // 4) LEITOR QUE FALHA: o erro CHEGA na decisao e vira INDISPONIVEL. Esta e a
  //    propriedade que morre quando um adaptador "normaliza" a resposta
  //    (`{ data: data ?? [], erro: null }`): a condicao passaria a decidir contra
  //    uma conversa inventada, sem erro em lugar nenhum.
  {
    const r = await fatosDaLinhaDeConversa(COM_FICHA, async () => ({ data: null, erro: { message: "timeout" } }));
    eq(r.indisponiveis.ficha, "timeout", "o erro do leitor deixou de chegar na decisao");
    eq(r.indisponiveis.status, "timeout");
    eq("ficha" in r.fatos, false, "a ficha foi inventada depois de um leitor que falhou");
  }
  {
    // e o leitor que EXPLODE nao vira ficha vazia: a excecao sobe pro `Promise.all`
    // de `coletarFatos`, que e onde o passo falha dizendo o motivo
    let subiu = false;
    await fatosDaLinhaDeConversa(COM_FICHA, async () => {
      throw new Error("conexao caiu");
    }).catch(() => {
      subiu = true;
    });
    eq(subiu, true, "leitor que explode passou a virar coleta vazia (fail-open silencioso)");
  }

  // 5) `colherLinhaDeConversa` ENCHE OS MAPAS DO CHAMADOR — o derrame que saiu do
  //    motor. Era ele que estava provado por duas linhas de texto.
  {
    const fatos: any = {};
    const indisponiveis: any = {};
    await colherLinhaDeConversa(
      COM_FICHA,
      async () => ({ data: { status: "atendimento", etiquetas: ["vip"], ficha: { CNPJ: "1" } }, erro: null }),
      fatos,
      indisponiveis
    );
    eq(fatos.status, "atendimento", "o FATO nao chegou no mapa do chamador");
    eq(fatos.ficha?.CNPJ, "1", "a ficha nao chegou no mapa do chamador");
    assert.deepEqual(indisponiveis, {});
    assercoes++;
  }
  {
    const fatos: any = {};
    const indisponiveis: any = {};
    await colherLinhaDeConversa(COM_FICHA, async () => ({ data: null, erro: null }), fatos, indisponiveis);
    eq(indisponiveis.ficha, "conversa nao encontrada",
      "o INDISPONIVEL nao chegou no mapa do chamador: leitura que falhou volta a passar por fato e o macro decide contra ficha inventada");
    eq(indisponiveis.status, "conversa nao encontrada");
    assert.deepEqual(fatos, {});
    assercoes++;
  }
  {
    // e ela ACRESCENTA, nao substitui: os outros ramos de `coletarFatos` escrevem
    // nos mesmos dois mapas em paralelo
    const fatos: any = { texto: "oi" };
    const indisponiveis: any = { contexto: "nao deu" };
    await colherLinhaDeConversa(SO_STATUS, async () => ({ data: { status: "aberto", etiquetas: [] }, erro: null }), fatos, indisponiveis);
    eq(fatos.texto, "oi", "a coleta da linha apagou o fato que outro ramo ja tinha colhido");
    eq(indisponiveis.contexto, "nao deu", "a coleta da linha apagou a indisponibilidade de outro ramo");
    eq(fatos.status, "aberto");
  }
  {
    // condicao que nao pede esta linha nao mexe em mapa nenhum
    const fatos: any = {};
    const indisponiveis: any = {};
    await colherLinhaDeConversa(new Set<CampoCondicao>(["texto"]), async () => ({ data: null, erro: { message: "x" } }), fatos, indisponiveis);
    assert.deepEqual([fatos, indisponiveis], [{}, {}]);
    assercoes++;
  }

  // 6) A REGRA PRO MERGE, COM GUARDA — e nao so escrita no comentario.
  //
  //    `CAMPOS_DA_LINHA_DE_CONVERSA` e a lista dos campos que saem desta leitura.
  //    Campo novo que sair dela entra NA LISTA e em `coletaDaLinhaDeConversa`
  //    (puros, e a prova executa) — nunca na fiacao de `coletarFatos`. Se alguem
  //    acrescentar o campo aqui sem tratar na decisao, o laco abaixo REPROVA; se
  //    tratar so na fiacao, a condicao dele decidiria contra dado inventado sem
  //    erro em lugar nenhum, e o cinto do bloco 19 (R17) e quem morde.
  eq(CAMPOS_DA_LINHA_DE_CONVERSA.length > 0, true, "a lista dos campos desta linha ficou vazia");
  for (const c of CAMPOS_DA_LINHA_DE_CONVERSA) {
    eq((CAMPOS_CONDICAO as readonly string[]).includes(c), true, `"${c}" nao e campo de condicao: a lista desta linha ficou dessincronizada do schema`);
    const pedido = new Set<CampoCondicao>([c]);
    eq(pedeALinhaDeConversa(pedido), true, `"${c}" esta na lista da linha e NAO dispara a leitura dela`);
    const r = coletaDaLinhaDeConversa(pedido, null, { message: "caiu" });
    eq(r.indisponiveis[c], "caiu",
      `CAMPO NOVO SEM FAIL-CLOSED: "${c}" sai desta linha e nao e marcado indisponivel quando a leitura falha — a condicao dele decidiria contra dado inventado`);
    eq(Object.keys(r.fatos).length, 0, `"${c}": leitura que falhou virou fato`);
  }
  // e a fiacao no motor NAO pode tratar nenhum deles: quem decide campo desta
  // linha e a decisao pura (cinto redundante, o portao e o laco acima)
  {
    const corpo = semComentario(corpoDaFuncao(EXECUTAR_FLUXO, "export async function coletarFatos"));
    for (const c of CAMPOS_DA_LINHA_DE_CONVERSA) {
      eq(new RegExp(`campos\\.has\\("${c}"\\)`).test(corpo), false,
        `"${c}" voltou a ser tratado dentro de coletarFatos: e a regiao onde o fail-open morava, e nenhuma prova a importa`);
    }
  }

  // 7) A CASA da decisao: `lib/fluxo/coleta.ts` nao pode ganhar import de VALOR —
  //    e o que permite esta prova importa-lo sem banco, sem env e sem alias `@/`.
  //    (`lib/fluxo/schema.ts` continua com ZERO import de qualquer tipo; quem cobra
  //    isso e prova-motor-fila, bloco 10.)
  eq(/^\s*import\s+(?!type)/m.test(semComentario(COLETA)), false,
    "lib/fluxo/coleta.ts ganhou import de valor: o invariante e ZERO import de valor (mesmo um hoje carregavel abre a porta pros que nao sao, e a decisao volta pra zona sem guarda)");
  eq(/from\s+"@\//.test(semComentario(COLETA)), false, "lib/fluxo/coleta.ts passou a usar alias `@/` (que node solto nao resolve)");
});

// ══════ 50) OS EFEITOS DA ROTA ANTIGA DE CATALOGO — o adaptador, por DESFECHO
//
// AQUI MORAVA A M9. `lerNomes: async () => ({ data: data ?? [], erro: null })` — a
// forma "tolerante" que um dev escreve sem perceber — passava com a bateria INTEIRA
// verde, porque o adaptador morava no arquivo de rota e rota nenhuma prova importa.
// Efeito medido: com o SELECT do catalogo falhando, `decidirColisaoNoCatalogo` le
// "catalogo vazio", o campo nasce SEM conferencia de colisao, `acharCampo` fica
// ambiguo e TODA escrita naquele campo passa a ser recusada na conta inteira.
//
// Agora o adaptador esta em `lib/campos-efeitos.ts` (zero import de valor) e a
// prova o EXECUTA com um cliente de banco fake, rodando a rota inteira de mentira.
await ta("ficha-config: o ADAPTADOR nao mente pra decisao — erro do banco chega, e o 503 acontece", async () => {
  /**
   * O cliente do banco de mentira, com o encadeamento do supabase-js. Cada
   * construtor de consulta e awaitable (`then`), como o de verdade.
   */
  const bancoFake = (opts: {
    catalogo?: unknown;
    erroLeitura?: unknown;
    ordemMax?: unknown;
    erroEscrita?: unknown;
  } = {}) => {
    const trilha: string[] = [];
    const escritas: { tabela: string; op: string; dados: unknown; conflito?: string; id?: unknown }[] = [];
    const responder = (est: any) => {
      trilha.push(`${est.op}:${est.tabela}${est.cols ? `:${est.cols}` : ""}`);
      if (est.op === "select") {
        if (est.cols === "nome,ativo") return { data: opts.catalogo ?? null, error: opts.erroLeitura ?? null };
        if (est.cols === "ordem") return { data: opts.ordemMax ?? null, error: null };
        return { data: null, error: null };
      }
      escritas.push({ tabela: est.tabela, op: est.op, dados: est.dados, conflito: est.conflito, id: est.eq?.[1] });
      if (opts.erroEscrita) return { data: null, error: opts.erroEscrita };
      return { data: { id: "novo", ...(est.dados as Record<string, unknown>) }, error: null };
    };
    const from = (tabela: string) => {
      const est: any = { tabela, op: "select", cols: "" };
      const api: any = {
        select: (cols?: string) => {
          if (est.op === "select") est.cols = cols ?? "";
          return api;
        },
        order: () => api,
        limit: (n: number) => {
          est.limite = n;
          return api;
        },
        eq: (campo: string, valor: unknown) => {
          est.eq = [campo, valor];
          return api;
        },
        single: () => api,
        update: (patch: unknown) => {
          est.op = "update";
          est.dados = patch;
          return api;
        },
        upsert: (linha: unknown, o?: { onConflict?: string }) => {
          est.op = "upsert";
          est.dados = linha;
          est.conflito = o?.onConflict;
          return api;
        },
        then: (ok: (v: unknown) => unknown, ruim?: (e: unknown) => unknown) =>
          Promise.resolve(responder(est)).then(ok, ruim),
      };
      return api;
    };
    return { db: { from } as PortaDoBanco, trilha, escritas };
  };

  // 1) O ERRO DO SELECT CHEGA NA DECISAO — o adaptador nao pode devolver
  //    `erro: null`. Aqui morre a M9, por desfecho: 503 e ZERO escrita.
  {
    const b = bancoFake({ erroLeitura: { message: "timeout no catalogo" } });
    const ef = efeitosDeFichaConfig(b.db);
    const cru = await ef.lerNomes();
    eq(cru.erro !== null && cru.erro !== undefined, true,
      "O ADAPTADOR ENGOLIU O ERRO DO SELECT: `decidirColisaoNoCatalogo` passa a ler 'catalogo vazio' e o campo nasce sem conferencia de colisao");
    const r = await executarFichaConfig({ tipo: "campo", nome: "CNPJ" }, ef);
    eq(r.status, 503, "catalogo ilegivel deixou de falhar FECHADO: o 503 virou criacao no escuro");
    eq(b.escritas.length, 0,
      "CAMPO CRIADO SEM CONFERIR COLISAO: 'CNPJ' nasce ao lado de um 'cnpj' que ninguem conseguiu ler, `acharCampo` fica ambiguo e toda escrita naquele campo e recusada na conta inteira");
    eq(String(r.corpo.error).includes("timeout no catalogo"), true, "a recusa perdeu o motivo do banco");
  }
  // 1b) e `data` tambem chega CRU: lista vazia de verdade e diferente de nao-lido
  {
    const b = bancoFake({ catalogo: [{ nome: "cnpj", ativo: true }] });
    const ef = efeitosDeFichaConfig(b.db);
    const r = await executarFichaConfig({ tipo: "campo", nome: "CNPJ" }, ef);
    eq(r.status, 409, "o catalogo lido deixou de chegar na decisao: a colisao normalizada voltou a ser aceita");
    eq(b.escritas.length, 0, "a colisao foi criada mesmo com o catalogo legivel");
  }

  // 2) O CAMINHO BOM, ponta a ponta: le a ordem, insere o nome SANEADO na tabela
  //    certa, com o `onConflict` que a rota sempre usou.
  {
    const b = bancoFake({ catalogo: [], ordemMax: [{ ordem: 9 }] });
    const r = await executarFichaConfig({ tipo: "campo", nome: "  Numero   do  processo  " }, efeitosDeFichaConfig(b.db));
    eq(r.status, 200, "campo legitimo deixou de ser criado");
    eq(b.escritas.length, 1, "o campo legitimo nao foi escrito");
    eq(b.escritas[0].tabela, "campos_personalizados");
    eq(b.escritas[0].op, "upsert", "o insert do campo deixou de ser upsert (a rota sempre usou upsert por nome)");
    eq(b.escritas[0].conflito, "nome", "o upsert perdeu o `onConflict: nome` — pedido repetido passaria a estourar 23505 pro admin");
    assert.deepEqual(b.escritas[0].dados, { nome: "Numero do processo", ativo: true, ordem: 10 });
    assercoes++;
    eq((r.corpo.item as { id: string }).id, "novo", "a resposta perdeu a linha que o banco devolveu");
  }
  // 2b) sem nenhuma linha, a proxima ordem e 1 (e nao NaN)
  {
    const b = bancoFake({ catalogo: [] });
    eq(await efeitosDeFichaConfig(b.db).proximaOrdem(), 1, "catalogo vazio deixou de comecar a ordem em 1");
  }

  // 3) A ESCRITA QUE FALHOU nao vira 200 calado, e o motivo do banco sobe
  {
    const b = bancoFake({ catalogo: [], erroEscrita: { message: "coluna ordem nao existe" } });
    const r = await executarFichaConfig({ tipo: "campo", nome: "Cidade" }, efeitosDeFichaConfig(b.db));
    eq(r.status, 500, "insert que falhou virou sucesso");
    eq(String(r.corpo.error).includes("coluna ordem nao existe"), true, "a falha do insert perdeu o motivo do banco");
  }
  {
    const b = bancoFake({ erroEscrita: { message: "timeout no update" } });
    const r = await executarFichaConfig({ tipo: "campo", id: "c1", ativo: true }, efeitosDeFichaConfig(b.db));
    eq(r.status, 500, "update que falhou virou sucesso");
    eq(String(r.corpo.error).includes("timeout no update"), true, "a falha do update perdeu o motivo do banco");
  }

  // 4) REATIVAR escreve o patch certo, no id certo, na tabela certa
  {
    const b = bancoFake();
    const r = await executarFichaConfig({ tipo: "campo", id: "c1", ativo: true }, efeitosDeFichaConfig(b.db));
    eq(r.status, 200, "reativar pela rota antiga parou de funcionar");
    eq(b.escritas.length, 1, "reativar nao escreveu");
    eq(b.escritas[0].op, "update");
    eq(b.escritas[0].id, "c1", "o UPDATE do adaptador perdeu o filtro por id: ele passaria a valer pra tabela inteira");
    assert.deepEqual(b.escritas[0].dados, { ativo: true });
    assercoes++;
  }

  // 5) DESATIVAR e RENOMEAR campo continuam recusados — com o adaptador real, o
  //    banco fake nao recebe UMA consulta
  for (const pedido of [{ tipo: "campo", id: "c1", ativo: false }, { tipo: "campo", id: "c1", nome: "CNPJ novo" }]) {
    const b = bancoFake();
    const r = await executarFichaConfig(pedido, efeitosDeFichaConfig(b.db));
    eq(r.status, 409, `${JSON.stringify(pedido)} deixou de ser recusado`);
    eq(b.trilha.length, 0, `${JSON.stringify(pedido)} FOI AO BANCO antes da recusa: a perda silenciosa de volta`);
  }

  // 6) ETIQUETA vai pra tabela dela, sem `ordem` (a tabela nao tem a coluna)
  {
    const b = bancoFake();
    const r = await executarFichaConfig({ tipo: "etiqueta", nome: "  Urgente  " }, efeitosDeFichaConfig(b.db));
    eq(r.status, 200);
    assert.deepEqual(b.escritas[0].dados, { nome: "Urgente", ativo: true });
    assercoes++;
    eq(b.escritas[0].tabela, "etiquetas_catalogo", "etiqueta nova foi pra tabela de campos");
  }
});

// ══════ 51) OS EFEITOS DO ARQUIVAMENTO — o adaptador, por DESFECHO
//
// AQUI MORAVA A M10b. A forma antiga do efeito era `medirImpacto: (nome) =>
// Promise<ImpactoCampo>`: o adaptador entregava o veredito numerico pronto, e
// `{...await impactoDoCampo(nome), conversas: 0, por_canal: []}` fazia a previa
// dizer "0 conversas afetadas" — o dono arquiva achando que nao perde nada.
// Aquela FORMA deixou de existir (o efeito e a contagem de UM canal, e quem soma e
// puro), e o que sobrou de mutavel — a travessia do `null` — esta provado aqui.
await ta("arquivamento: contagem que NAO houve chega `null` na decisao, e `tiposDisponiveis` chega no UPDATE", async () => {
  const CAMPO = { id: "c1", nome: "CNPJ" };
  const monta = (opts: {
    canais?: readonly string[];
    contar: (canal: string, nome: string) => Promise<number | null>;
    tiposDisponiveis?: boolean;
    agora?: () => string;
  }) => {
    const gravacoes: { id: string; patch: Record<string, unknown>; comColunasNovas: boolean }[] = [];
    const pedidos: string[] = [];
    const ef = efeitosDeArquivamento({
      canais: opts.canais ?? ["central", "apioficial"],
      contar: async (canal, nome) => {
        pedidos.push(`${canal}:${nome}`);
        return opts.contar(canal, nome);
      },
      gravarCampo: async (id, patch, comColunasNovas) => {
        gravacoes.push({ id, patch, comColunasNovas });
        return { ok: true as const };
      },
      tiposDisponiveis: opts.tiposDisponiveis ?? true,
      agora: opts.agora,
    });
    return { ef, gravacoes, pedidos };
  };

  // 1) CANAL QUE NAO RESPONDEU contamina o impacto inteiro e o veredito RECUSA.
  //    Um `?? 0` no efeito (a mutacao plausivel) mataria isto: a previa diria
  //    "nenhuma conversa usa" depois de uma contagem que nem respondeu.
  {
    const m = monta({ contar: async (canal) => (canal === "central" ? 3 : null) });
    const r = await executarArquivamento(CAMPO, true, undefined, m.ef);
    const imp = r.corpo.impacto as ImpactoCampo;
    eq(imp.incompleto, true,
      "CONTAGEM QUE FALHOU VIROU ZERO: a previa passa a dizer 'nada se perde' e o dono arquiva no escuro");
    eq((r.corpo.veredito as { acao: string }).acao, "recusar", "impacto incompleto deixou de recusar");
    eq(m.gravacoes.length, 0, "a previa gravou");
    assert.deepEqual(m.pedidos.sort(), ["apioficial:CNPJ", "central:CNPJ"]);
    assercoes++;
  }

  // 2) A CONTAGEM REAL soma canal por canal, e o veredito vira "arquivar"
  {
    const m = monta({ contar: async (canal) => (canal === "central" ? 4 : 3) });
    const r = await executarArquivamento(CAMPO, true, undefined, m.ef);
    const imp = r.corpo.impacto as ImpactoCampo;
    eq(imp.conversas, 7, "a soma canal por canal deixou de chegar na previa");
    eq(imp.incompleto, false);
    eq((r.corpo.veredito as { acao: string }).acao, "arquivar");
    eq(imp.por_canal.length, 2, "a previa perdeu a quebra por canal (o denominador escrito)");
  }

  // 3) LISTA DE CANAL VAZIA e "nada medido", nunca "zero valor gravado"
  {
    const m = monta({ canais: [], contar: async () => 0 });
    const r = await executarArquivamento(CAMPO, true, undefined, m.ef);
    eq((r.corpo.impacto as ImpactoCampo).incompleto, true,
      "zero canal virou 'pode remover': o freio que falha aberto nao e freio");
    eq((r.corpo.veredito as { acao: string }).acao, "recusar");
  }

  // 4) `tiposDisponiveis` CHEGA no executor da gravacao. Com a 0025 pendente,
  //    gravar `atualizado_em` derruba o arquivamento com erro de coluna
  //    inexistente — e o campo fica no formulario sem ninguem entender por que.
  for (const disponiveis of [true, false]) {
    const m = monta({ contar: async () => 0, tiposDisponiveis: disponiveis });
    const r = await executarArquivamento(CAMPO, true, true, m.ef);
    eq(r.status, 200);
    eq(m.gravacoes.length, 1, "o arquivamento confirmado nao gravou");
    eq(m.gravacoes[0].comColunasNovas, disponiveis,
      `\`tiposDisponiveis: ${disponiveis}\` nao chegou no executor da gravacao: com a 0025 pendente o UPDATE cai por coluna inexistente`);
    eq(m.gravacoes[0].patch.ativo, false, "o patch do arquivamento deixou de desativar o campo");
  }

  // 5) O CARIMBO: default e ISO real, e o injetado e respeitado (pra prova nao
  //    depender do relogio)
  {
    const m = monta({ contar: async () => 0, agora: () => "2026-09-01T10:00:00.000Z" });
    const r = await executarArquivamento(CAMPO, false, undefined, m.ef);
    eq(r.status, 200);
    eq(m.gravacoes[0].patch.atualizado_em, "2026-09-01T10:00:00.000Z", "o carimbo injetado deixou de ser usado");
    eq(m.pedidos.length, 0, "reativar gastou uma medicao que ninguem le");
  }
  {
    const m = monta({ contar: async () => 0 });
    await executarArquivamento(CAMPO, false, undefined, m.ef);
    const carimbo = String(m.gravacoes[0].patch.atualizado_em);
    eq(Number.isFinite(Date.parse(carimbo)), true, "o carimbo default deixou de ser uma data legivel");
    eq(carimbo, new Date(carimbo).toISOString(), "o carimbo default deixou de ser ISO (o banco recusa outro formato)");
  }

  // 6) O ADAPTADOR NAO PODE NORMALIZAR A CONTAGEM — o portao sao os itens 1 e 3
  //    (com `?? 0` na travessia do `contar`, o item 1 fica VERMELHO por desfecho);
  //    isto e cinto, e recortado na FUNCAO, nao no arquivo: `proximaOrdem` tem um
  //    `?? 0` legitimo (ordem inicial 1), e cobrar o arquivo inteiro seria falso
  //    positivo garantido.
  eq(/\?\?\s*0/.test(semComentario(corpoDaFuncao(EFEITOS, "export function efeitosDeArquivamento("))), false,
    "apareceu `?? 0` no efeito do arquivamento: contagem que nao houve passa a valer zero e o arquivamento decide no escuro");
  eq(/^\s*import\s+(?!type)/m.test(semComentario(EFEITOS)), false,
    "lib/campos-efeitos.ts ganhou import de valor: o invariante e ZERO import de valor (mesmo um hoje carregavel abre a porta pros que nao sao, e o adaptador volta pra zona sem guarda)");
  eq(/from\s+"@\/|next\/server/.test(semComentario(EFEITOS)), false,
    "lib/campos-efeitos.ts passou a usar alias `@/` ou `next/server` (que node solto nao resolve)");
});

console.log(`\nprova-campos: ${feitos} blocos, ${assercoes} assercoes OK`);
