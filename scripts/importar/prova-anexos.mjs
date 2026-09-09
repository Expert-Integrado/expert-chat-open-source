// Prova do passo de importacao da biblioteca de anexos (scripts/importar/anexos.mjs).
//
//   node scripts/importar/prova-anexos.mjs
//
// Roda a CLI DE VERDADE contra o backup SINTETICO de scripts/importar/fixture-anexos
// e contra um armazenamento LOCAL DE MENTIRA (pasta temporaria + prefixo publico
// declarado na linha de comando). Nao toca em bucket, nao toca em banco, nao usa
// rede: `--sem-rede` proibe download, e as URLs do fixture apontam pra um dominio
// inexistente de proposito.
//
// O fixture tem um caso de cada situacao que importa:
//   1  nome com acento e bytes na mao ............ sobe, chave sem acento
//   2  nome que COLIDE com o primeiro ............ sobe com sufixo deterministico
//   3  .svg (mime mentindo octet-stream) ......... RECUSADO (bucket publico)
//   4  item sem id na origem ..................... recusado (sem identidade)
//   5  sem bytes locais + --sem-rede ............. pulado e declarado
//   6  acima do teto ............................. pulado e declarado
//   7  nome com espaco e maiuscula ............... sobe, chave em kebab
//   8  DIZ ser pdf, bytes sao <svg> ............. RECUSADO pelos BYTES: a tela ja
//                                                 decidia assim e as duas portas
//                                                 escrevem no MESMO bucket publico
//
// E prova as tres coisas que fazem este passo servir a uma migracao de verdade:
//   (a) o catalogo e PARCIAL e isso viaja no mapa (`parcial: true`), porque id que
//       nao esta na pagina capturada NAO significa "nao existe";
//   (b) rodar de novo escreve NO MESMO objeto (o caminho e `biblioteca/<chave>.<ext>`,
//       o mesmo que o painel usa) — nao duplica o acervo;
//   (c) o endereco que vai pro mapa e o do DESTINO; a URL do fornecedor nao
//       aparece em lugar nenhum do que foi gravado.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { donoDaChave } from "./anexos-catalogo.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(AQUI, "fixture-anexos");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "prova-anexos-"));
// O FIXTURE E COPIADO: a CLI grava o mapa em `<pasta>/config/anexos-chaves.json`
// (e ali que o conversor procura), e um passo de prova NAO pode escrever dentro do
// repo — arvore suja no fim da rodada e um defeito por si so.
const BACKUP = path.join(TMP, "backup");
const MOCK = path.join(TMP, "armazenamento-de-mentira");
const TRABALHO = path.join(TMP, "trabalho");
const BASE_PUBLICA = "http://localhost/mock";

fs.cpSync(FIXTURE, BACKUP, { recursive: true });

let falhas = 0;
const ok = (cond, oque, detalhe = "") => {
  console.log(`${cond ? "  ok  " : "FALHA "} ${oque}${detalhe && !cond ? ` — ${detalhe}` : ""}`);
  if (!cond) falhas++;
};
const igual = (obtido, esperado, oque) =>
  ok(
    JSON.stringify(obtido) === JSON.stringify(esperado),
    oque,
    `esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`
  );

// `env` existe pro bloco 8b: e o unico que roda contra um destino de MENTIRA na
// rede (o resto usa armazenamento local, que nao tem painel do outro lado).
const rodar = (extra, env) => {
  let status = 0;
  let saida = "";
  try {
    saida = execFileSync(
      process.execPath,
      [path.join(AQUI, "anexos.mjs"), "--pasta", BACKUP, "--trabalho", TRABALHO, ...extra],
      { stdio: "pipe", encoding: "utf8", env: { ...process.env, ...(env || {}) } }
    );
  } catch (e) {
    status = e.status ?? -1;
    saida = String(e.stdout || "") + String(e.stderr || "");
  }
  const arqs = fs
    .readdirSync(TRABALHO)
    .filter((f) => f.startsWith("anexos-") && f.endsWith(".json") && f !== "anexos-chaves.json")
    .sort();
  const rel = arqs.length ? JSON.parse(fs.readFileSync(path.join(TRABALHO, arqs[arqs.length - 1]), "utf8")) : null;
  const mapa = fs.existsSync(path.join(TRABALHO, "anexos-chaves.json"))
    ? JSON.parse(fs.readFileSync(path.join(TRABALHO, "anexos-chaves.json"), "utf8"))
    : null;
  return { status, saida, rel, mapa };
};

const arquivosNoMock = () => {
  const achados = [];
  const andar = (dir, prefixo) => {
    if (!fs.existsSync(dir)) return;
    for (const n of fs.readdirSync(dir)) {
      const cheio = path.join(dir, n);
      if (fs.statSync(cheio).isDirectory()) andar(cheio, `${prefixo}${n}/`);
      else achados.push(`${prefixo}${n}`);
    }
  };
  andar(MOCK, "");
  return achados.sort();
};

console.log("\n-- 1) DEFAULT E INVENTARIO: nao baixa, nao sobe, nao grava");
{
  const { status, rel, mapa } = rodar([]);
  ok(status === 0, "o inventario sai com 0");
  ok(rel?.modo?.startsWith("inventario"), "o relatorio se declara inventario", rel?.modo);
  ok(rel?.grava_banco === false, "e diz que NAO grava banco");
  igual(arquivosNoMock(), [], "nada foi escrito no armazenamento");
  ok(rel?.catalogo?.capturados === 8, "leu os 8 itens capturados", String(rel?.catalogo?.capturados));
  ok(rel?.catalogo?.total_na_origem === 12, "e guardou os 12 que a origem declara");
  ok(rel?.catalogo?.parcial === true, "declara o catalogo como PARCIAL");
  ok(
    (rel?.pendencias || []).some((p) => /parcial/i.test(p.tema)),
    "pendencia de catalogo parcial esta no relatorio"
  );
  // o inventario JA monta as chaves (e o que a pessoa confere antes de valer)
  ok(mapa?.anexos && Object.keys(mapa.anexos).length === 6, "o mapa do inventario tem os 6 itens com chave", String(Object.keys(mapa?.anexos || {}).length));
  ok(mapa?.parcial === true, "o mapa carrega o aviso de parcial (id ausente != inexistente)");
}

console.log("\n-- 2) A CHAVE: sem acento, kebab, e colisao desempatada");
{
  const { mapa } = rodar([]);
  const chaves = Object.fromEntries(Object.entries(mapa.anexos).map(([id, v]) => [id, v.chave]));
  ok(chaves["aaaaaaaaaaaaaaaaaaaaaa01"] === "guia-de-implantacao-pdf", "acento e ponto viram kebab", chaves["aaaaaaaaaaaaaaaaaaaaaa01"]);
  ok(
    chaves["aaaaaaaaaaaaaaaaaaaaaa02"] === "guia-de-implantacao-pdf-2",
    "o segundo nome que gera a MESMA chave ganha sufixo deterministico",
    chaves["aaaaaaaaaaaaaaaaaaaaaa02"]
  );
  ok(chaves["aaaaaaaaaaaaaaaaaaaaaa07"] === "tabela-de-precos-2026-xlsx", "espaco e maiuscula viram kebab", chaves["aaaaaaaaaaaaaaaaaaaaaa07"]);
  ok(!("aaaaaaaaaaaaaaaaaaaaaa03" in chaves), "o .svg NAO entra no mapa (recusado)");
  ok(Object.values(chaves).every((c) => /^[a-z0-9][a-z0-9_-]{0,59}$/.test(c)), "toda chave respeita a forma do painel");
}

console.log("\n-- 3) VALENDO contra armazenamento local: sobe, e o que nao pode subir e DECLARADO");
{
  const { status, rel, mapa } = rodar([
    "--valendo",
    "--sem-banco",
    "--sem-rede",
    "--destino-local",
    MOCK,
    "--url-publica-base",
    BASE_PUBLICA,
    "--pasta-arquivos",
    path.join(BACKUP, "anexos"),
  ]);
  ok(status === 0, "saiu com 0 (nenhuma FALHA de verdade — o que sobrou foi pulado com motivo)", String(status));
  ok(rel?.resultado?.subidos === 3, "3 arquivos subiram", String(rel?.resultado?.subidos));
  ok(rel?.resultado?.gravados === 0, "--sem-banco: nenhuma linha gravada");
  ok(rel?.resultado?.pulados === 5, "5 pulados (svg, sem id, sem bytes, acima do teto, bytes de marcacao)", String(rel?.resultado?.pulados));
  ok(rel?.resultado?.falharam === 0, "nenhuma falha de rede/upload");
  const motivos = Object.keys(rel?.motivos || {}).join(" | ");
  ok(/tipo recusado/i.test(motivos), "o motivo do svg esta nomeado no relatorio", motivos);
  ok(/sem id/i.test(motivos), "o motivo do item sem id esta nomeado", motivos);
  ok(/sem_copia_local_e_sem_rede/.test(motivos), "o motivo de 'sem bytes e sem rede' esta nomeado", motivos);
  ok(/acima_do_teto/.test(motivos), "o motivo do teto esta nomeado", motivos);
  // OS BYTES DESMENTEM O TIPO DECLARADO. O catalogo diz application/pdf; o arquivo
  // e <svg>. A tela ja recusava isso pelos bytes; o importador triava so pelo tipo
  // declarado, e as duas portas escrevem no MESMO bucket publico.
  ok(/bytes_de_marcacao/.test(motivos), "arquivo que DIZ ser pdf mas comeca com marcacao e recusado", motivos);
  ok(
    !arquivosNoMock().some((f) => /disfarcado|politica-de-privacidade/i.test(f)),
    "e ele NAO foi escrito no armazenamento",
    arquivosNoMock().join(" | ")
  );

  igual(
    arquivosNoMock(),
    ["biblioteca/guia-de-implantacao-pdf-2.pdf", "biblioteca/guia-de-implantacao-pdf.pdf", "biblioteca/tabela-de-precos-2026-xlsx.xlsx"],
    "o caminho no destino e `biblioteca/<chave>.<ext>` — o MESMO que o painel usa"
  );

  // (c) o endereco gravado e o do DESTINO, e o do fornecedor nao sobra em lugar nenhum
  const urls = Object.values(mapa.anexos).map((v) => v.url).filter(Boolean);
  ok(urls.length === 3, "o mapa tem o endereco novo dos 3 subidos", String(urls.length));
  ok(urls.every((u) => u.startsWith(BASE_PUBLICA)), "todo endereco aponta pro destino declarado");
  const bruto = JSON.stringify(mapa);
  ok(!/armazem\.invalido/.test(bruto), "a URL do fornecedor NAO aparece no mapa (ela morre com a conta)");
}

console.log("\n-- 4) IDEMPOTENCIA: rodar de novo escreve no MESMO objeto");
{
  const antes = arquivosNoMock();
  const conteudoAntes = antes.map((f) => fs.readFileSync(path.join(MOCK, f), "utf8"));
  const { status, rel } = rodar([
    "--valendo",
    "--sem-banco",
    "--sem-rede",
    "--destino-local",
    MOCK,
    "--url-publica-base",
    BASE_PUBLICA,
    "--pasta-arquivos",
    path.join(BACKUP, "anexos"),
  ]);
  ok(status === 0, "a segunda rodada tambem sai com 0");
  ok(rel?.resultado?.subidos === 3, "subiu os mesmos 3");
  igual(arquivosNoMock(), antes, "o acervo NAO duplicou (mesmos caminhos)");
  igual(
    arquivosNoMock().map((f) => fs.readFileSync(path.join(MOCK, f), "utf8")),
    conteudoAntes,
    "o conteudo e o mesmo (sobrescreveu, nao acumulou)"
  );
}

console.log("\n-- 4b) A LINHA QUE IRIA PRO BANCO leva o endereco NOVO");
{
  // ESTE BLOCO EXISTE POR UMA MUTACAO QUE PASSOU VERDE: trocar `url: urlNova` por
  // `url: it.url` (o endereco do FORNECEDOR, que morre com a conta) nao quebrava
  // prova nenhuma, porque com `--sem-banco` a linha nem era montada. Agora ela e
  // sempre montada e o `--dump` a escreve — e a prova le o campo.
  const dump = path.join(TMP, "linhas.json");
  rodar([
    "--valendo",
    "--sem-banco",
    "--sem-rede",
    "--destino-local",
    MOCK,
    "--url-publica-base",
    BASE_PUBLICA,
    "--pasta-arquivos",
    path.join(BACKUP, "anexos"),
    "--dump",
    dump,
  ]);
  ok(fs.existsSync(dump), "o --dump escreveu as linhas que entrariam");
  const linhas = JSON.parse(fs.readFileSync(dump, "utf8")).anexos;
  ok(linhas.length === 3, "uma linha por arquivo que subiu", String(linhas.length));
  ok(
    linhas.every((l) => String(l.url).startsWith(BASE_PUBLICA)),
    "TODA linha aponta pro destino da instalacao",
    JSON.stringify(linhas.map((l) => l.url))
  );
  ok(
    !linhas.some((l) => String(l.url).includes("armazem.invalido")),
    "e NENHUMA carrega o endereco do fornecedor (ele morre com a conta)"
  );
  const guia = linhas.find((l) => l.chave === "guia-de-implantacao-pdf");
  ok(guia, "achei a linha do guia");
  ok(guia.origem_ferramenta === "chatguru", "a linha carrega a ferramenta de origem (idempotencia)");
  ok(guia.origem_id === "aaaaaaaaaaaaaaaaaaaaaa01", "e o id na origem");
  ok(guia.descricao === "manda junto com a proposta", "a descricao do catalogo VEM JUNTO (e conteudo)");
  ok(JSON.stringify(guia.etiquetas) === JSON.stringify(["comercial"]), "e as etiquetas, sem repetir a mesma forma", JSON.stringify(guia.etiquetas));
  ok(guia.bytes === fs.statSync(path.join(BACKUP, "anexos", "guia_123.pdf")).size, "o tamanho e o do arquivo REAL, nao o declarado no catalogo");
  ok(guia.arquivo_nome === "guia_123.pdf", "o nome do arquivo na origem viaja", guia.arquivo_nome);
}

console.log("\n-- 5) O MAPA CHEGA ONDE O CONVERSOR PROCURA");
{
  const noBackup = path.join(BACKUP, "config", "anexos-chaves.json");
  ok(fs.existsSync(noBackup), "o mapa foi copiado pra <backup>/config/anexos-chaves.json");
  const m = JSON.parse(fs.readFileSync(noBackup, "utf8"));
  ok(m.origem === "chatguru", "o mapa diz de qual ferramenta veio", m.origem);
  ok(Object.keys(m.anexos).length === 3, "e tem so os itens que existem de verdade no destino", String(Object.keys(m.anexos).length));
}

console.log("\n-- 6) SEM CATALOGO NAO INVENTA BIBLIOTECA");
{
  const vazio = path.join(TMP, "backup-vazio");
  fs.mkdirSync(vazio, { recursive: true });
  let status = 0;
  try {
    execFileSync(process.execPath, [path.join(AQUI, "anexos.mjs"), "--pasta", vazio], { stdio: "pipe" });
  } catch (e) {
    status = e.status ?? -1;
  }
  ok(status === 2, "sem attachments_search.json a CLI recusa (exit 2), em vez de importar acervo vazio", String(status));
}

console.log("\n-- 7) O DESTINO NUNCA E EMBUTIDO NO CODIGO");
{
  let status = 0;
  let err = "";
  try {
    execFileSync(process.execPath, [path.join(AQUI, "anexos.mjs"), "--pasta", BACKUP, "--valendo", "--trabalho", TRABALHO], {
      stdio: "pipe",
      env: { ...process.env, MSG_SUPABASE_URL: "", MSG_SUPABASE_SERVICE_KEY: "" },
    });
  } catch (e) {
    status = e.status ?? -1;
    err = String(e.stderr || "");
  }
  ok(status === 2, "--valendo sem --url/--key (e sem destino local) recusa", String(status));
  ok(/vem do ambiente de quem roda/i.test(err), "e diz por que", err.slice(0, 120));
  igual(arquivosNoMock().length, 3, "e nada foi escrito nessa tentativa");
}

console.log("\n-- 8) A CHAVE E CONFERIDA ANTES DE SUBIR (o arquivo vivo nao e reescrito em silencio)");
{
  // A DECISAO, por comportamento. O caminho no bucket e deterministico e a subida
  // e upsert: sem esta conta, reimportar numa instalacao onde alguem ja subiu
  // aquela chave PELA TELA reescrevia o arquivo que os fluxos mandam pro cliente,
  // e so o insert reclamava depois — a linha nao era sobrescrita, o arquivo era.
  const meu = { origem_ferramenta: "chatguru", origem_id: "abc123" };
  igual(donoDaChave(undefined, { origem: "chatguru", origem_id: "abc123" }), "livre", "chave que ninguem ocupa esta livre");
  igual(donoDaChave(null, { origem: "chatguru", origem_id: "abc123" }), "livre", "dono nulo tambem e livre");
  igual(
    donoDaChave(meu, { origem: "chatguru", origem_id: "abc123" }),
    "meu",
    "reimportar o MESMO item reescreve o mesmo objeto (idempotencia do passo)"
  );
  igual(
    donoDaChave(meu, { origem: "chatguru", origem_id: "OUTRO" }),
    "de_outro",
    "mesma origem, item diferente: NAO sobrescreve"
  );
  igual(
    donoDaChave(meu, { origem: "outra-ferramenta", origem_id: "abc123" }),
    "de_outro",
    "mesmo id, origem diferente: NAO sobrescreve"
  );
  igual(
    donoDaChave({ origem_ferramenta: null, origem_id: null }, { origem: "chatguru", origem_id: "abc123" }),
    "de_outro",
    "linha criada PELA TELA (sem origem) nunca e minha"
  );
  igual(
    donoDaChave({ origem_ferramenta: "chatguru", origem_id: null }, { origem: "chatguru", origem_id: null }),
    "de_outro",
    "nulo dos dois lados NAO e igualdade — nulo nao identifica item"
  );
  igual(
    donoDaChave({ origem_ferramenta: "chatguru", origem_id: 123 }, { origem: "chatguru", origem_id: "123" }),
    "meu",
    "id numero e id texto sao o mesmo item"
  );
}

console.log("\n-- 8b) E A FIACAO, CONTRA UM DESTINO DE MENTIRA (nao por varredura de texto)");
{
  // POR QUE ESTE BLOCO MUDOU DE NATUREZA: a versao anterior conferia a fiacao por
  // VARREDURA DE TEXTO no fonte (`indexOf`/regex), e a re-revisao cega mediu que
  // isso nao guardava nada — TRES mutacoes reabriam a GRAVE com a bateria toda
  // verde e efeito real no destino:
  //
  //   (a) `if (de === "de_outro")` -> `"de_outro_nunca"`: a decisao era calculada
  //       e jogada fora, e o cenario voltava a escrever por cima do arquivo VIVO;
  //   (b) `donosDasChaves` devolvendo `new Map()` em vez de `null` no erro: o
  //       passo que devia abortar subia 3 arquivos no escuro, com exit 0;
  //   (c) `CONFERE_CHAVES = false`: a leitura simplesmente nunca acontecia.
  //
  // As tres passavam porque o texto continuava escrito no arquivo. Agora o cenario
  // e o do DANO — a chave do guia ja pertence a OUTRO item no painel de destino —
  // e a cobranca e sobre o que SAI pra rede: nenhum POST de Storage naquela chave.
  //
  // O destino de mentira e um PROCESSO separado (`prova-mock-destino.mjs`) pelo
  // motivo explicado la: `execFileSync` congela o event loop de quem chama, entao
  // um servidor no mesmo processo aceitaria a conexao e nunca responderia.
  const ARQ_PORTA = path.join(TMP, "mock-porta.txt");
  const ARQ_REQS = path.join(TMP, "mock-requisicoes.ndjson");
  const ARQ_ROTEIRO = path.join(TMP, "mock-roteiro.json");
  fs.writeFileSync(ARQ_REQS, "");
  fs.writeFileSync(ARQ_ROTEIRO, "{}");
  const servidor = spawn(process.execPath, [path.join(AQUI, "prova-mock-destino.mjs"), ARQ_PORTA, ARQ_REQS, ARQ_ROTEIRO], {
    stdio: "ignore",
  });
  // nao deixar node orfao segurando porta se uma assercao adiante lancar
  process.on("exit", () => {
    try {
      servidor.kill();
    } catch {
      // ja morreu
    }
  });
  let espera = 0;
  while (!fs.existsSync(ARQ_PORTA) && espera < 100) {
    await new Promise((r) => setTimeout(r, 50));
    espera++;
  }
  ok(fs.existsSync(ARQ_PORTA), "o destino de mentira subiu");
  const BASE = `http://127.0.0.1:${fs.readFileSync(ARQ_PORTA, "utf8").trim()}`;

  // VALENDO contra o destino de mentira: sem `--sem-banco` e sem `--destino-local`,
  // que e a UNICA combinacao em que a conferencia de chaves faz sentido (e a que a
  // mutacao (c) desligava).
  const contraODestino = (cenario) => {
    fs.writeFileSync(ARQ_ROTEIRO, JSON.stringify(cenario));
    fs.writeFileSync(ARQ_REQS, "");
    const r = rodar(
      ["--valendo", "--sem-rede", "--pasta-arquivos", path.join(BACKUP, "anexos")],
      { MSG_SUPABASE_URL: BASE, MSG_SUPABASE_SERVICE_KEY: "chave-de-mentira" }
    );
    const reqs = fs
      .readFileSync(ARQ_REQS, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return {
      ...r,
      reqs,
      // o que EFETIVAMENTE encostou no armazenamento
      storage: reqs.filter((q) => q.metodo === "POST" && q.caminho.startsWith("/storage/v1/object/")).map((q) => q.caminho),
      linhas: reqs.filter((q) => q.metodo === "POST" && q.caminho.startsWith("/rest/")),
    };
  };
  const chaveDeOutro = { chave: "guia-de-implantacao-pdf", origem_ferramenta: "chatguru", origem_id: "OUTRO-ITEM" };
  const nomeDoObjeto = (p) => p.split("/").pop();

  // (i) LINHA DE BASE: painel vazio. Os 3 sobem, e a leitura vem ANTES de tudo.
  //     Sem esta metade, uma guarda que recusa SEMPRE passaria nas outras duas.
  {
    const c = contraODestino({ chaves: [] });
    const iLeitura = c.reqs.findIndex((q) => q.metodo === "GET" && q.consulta.includes("select=chave,origem_ferramenta,origem_id"));
    const iUpload = c.reqs.findIndex((q) => q.metodo === "POST" && q.caminho.startsWith("/storage/v1/object/"));
    ok(iLeitura === 0, "a PRIMEIRA coisa que o passo faz no destino e ler quem ja e dono das chaves", JSON.stringify(c.reqs[0] || null));
    ok(iUpload > iLeitura, "e nenhum upload sai antes dessa leitura", `leitura ${iLeitura} < upload ${iUpload}`);
    ok(c.rel?.resultado?.subidos === 3, "com o painel vazio os 3 sobem (o cenario nao e vacuo)", String(c.rel?.resultado?.subidos));
    ok(c.status === 0, "e o passo sai com 0", String(c.status));
  }

  // (ii) A GRAVE: a chave do guia ja pertence a OUTRO item no painel.
  {
    const c = contraODestino({ chaves: [chaveDeOutro] });
    ok(
      !c.storage.some((p) => nomeDoObjeto(p) === "guia-de-implantacao-pdf.pdf"),
      "NENHUM upload sai pra chave que ja e de outro item — o arquivo vivo nao e reescrito",
      c.storage.join(" | ")
    );
    igual(
      c.storage.map(nomeDoObjeto).sort(),
      ["guia-de-implantacao-pdf-2.pdf", "tabela-de-precos-2026-xlsx.xlsx"],
      "e os outros dois sobem normalmente (a guarda pula O ITEM, nao a rodada)"
    );
    ok(c.rel?.resultado?.subidos === 2, "o relatorio conta 2 subidos", String(c.rel?.resultado?.subidos));
    ok(
      /chave_ja_existe_no_painel/.test(Object.keys(c.rel?.motivos || {}).join(" | ")),
      "e nomeia o motivo do que ficou de fora",
      Object.keys(c.rel?.motivos || {}).join(" | ")
    );
    ok(
      !c.linhas.some((q) => q.corpo.includes('"chave":"guia-de-implantacao-pdf"')),
      "e a LINHA daquele item tambem nao e gravada (nada foi subido nem gravado)"
    );
  }

  // (iii) LEITURA QUE FALHOU NAO LIBERA: "nao consegui olhar" nunca e "esta livre".
  {
    const c = contraODestino({ ler_chaves: false });
    igual(c.storage, [], "GET das chaves com erro: NENHUM arquivo encosta no armazenamento");
    igual(c.linhas.length, 0, "e nenhuma linha e tentada no banco");
    ok(c.status === 1, "o passo sai com 1 (falha declarada), nunca 0 no escuro", String(c.status));
    ok(
      /chaves_do_painel_ilegiveis/.test(Object.keys(c.rel?.motivos || {}).join(" | ")),
      "o motivo esta nomeado no relatorio",
      Object.keys(c.rel?.motivos || {}).join(" | ")
    );
    ok(
      (c.rel?.pendencias || []).some((p) => /chaves_nao_conferidas/.test(p.tema)),
      "e a pendencia diz o que fazer"
    );
  }

  // (iv) LEITURA CORTADA E LEITURA ILEGIVEL. O fail-closed acima falhava ABERTO
  //      com resposta truncada: `&limit=100000` numa requisicao so, e o PostgREST
  //      honra o `db-max-rows` DO SERVIDOR — a resposta vem cortada com 200, sem
  //      erro nenhum. As chaves que sobraram liam como "livre". Medido antes do
  //      conserto, com este mesmo cenario: `subidos: 3` e o arquivo VIVO reescrito,
  //      tendo como unico sinal o 23505 tardio do insert.
  {
    const c = contraODestino({ chaves: [chaveDeOutro], chaves_total: 500 });
    igual(c.storage, [], "resposta CORTADA (o destino declara 500 chaves e mandou 1): NADA sobe");
    igual(c.linhas.length, 0, "e nenhuma linha e tentada no banco");
    ok(c.status === 1, "o passo sai com 1", String(c.status));
    ok(
      /chaves_do_painel_truncadas/.test(Object.keys(c.rel?.motivos || {}).join(" | ")),
      "e o motivo separa CORTADA de ilegivel (a causa e outra: teto de linhas do servidor)",
      Object.keys(c.rel?.motivos || {}).join(" | ")
    );
    ok(
      (c.rel?.falhas || []).some((f) => /500 chave/.test(String(f.motivo)) && /trouxe 1/.test(String(f.motivo))),
      "e o relatorio diz os DOIS numeros (o que o destino declara e o que chegou)",
      JSON.stringify(c.rel?.falhas || [])
    );
  }

  // (v) DESTINO QUE NAO DECLARA O TOTAL nao prova leitura inteira. Sem o
  //     `Content-Range` nao da pra saber se veio tudo — e "achei que veio" e o
  //     mesmo erro de (iv) com outra roupa.
  {
    const c = contraODestino({ chaves: [], chaves_sem_faixa: true });
    igual(c.storage, [], "sem Content-Range: NADA sobe (nao da pra provar que a leitura veio inteira)");
    ok(c.status === 1, "o passo sai com 1", String(c.status));
    // e a RECUSA E DELIBERADA, nao um tropeco: sem esta linha, tirar a checagem
    // do cabecalho ainda passava — o codigo estourava no `declarado[1]` nulo e
    // caia no catch, abortando pelo motivo errado e com frase de erro de rede.
    ok(
      /chaves_do_painel_truncadas/.test(Object.keys(c.rel?.motivos || {}).join(" | ")),
      "e o motivo e o de leitura nao provada, nao um erro de conexao disfarcado",
      Object.keys(c.rel?.motivos || {}).join(" | ")
    );
    ok(
      (c.rel?.falhas || []).some((f) => /Content-Range/.test(String(f.motivo))),
      "e o relatorio diz o que faltou",
      JSON.stringify(c.rel?.falhas || [])
    );
  }

  servidor.kill();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(falhas ? `\n${falhas} FALHA(S)` : "\nTUDO OK");
process.exit(falhas ? 1 : 0);
