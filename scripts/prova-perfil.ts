// Prova das regras de "Meu perfil" (Frente G): preferencias de aviso, validacao
// da troca de senha e aceitacao da foto do atendente.
// Roda em Node >= 22.6 sem build: `node scripts/prova-perfil.ts`
// (type stripping nativo; `scripts/` esta fora do tsconfig por isso).
//
// Aqui so entra o que e PURO — o que o navegador nao precisa provar e o banco
// nao decide. O resto (upload de verdade, gravacao no perfil) e a revisao do
// codigo + o build, como combinado na frente.
import assert from "node:assert/strict";
import {
  CHAVES_PREFERENCIA, EXTENSOES_FOTO, LIMITE_FOTO_BYTES, LIMITE_MULTIPART_BYTES,
  PREFERENCIAS_PADRAO, SENHA_MINIMA,
  caminhoFotoUsuario, corpoGrandeDemais, mesclarPreferencias, motivoRecusaDeGravacao,
  sanitizarAssinaturaNome, sanitizarPreferencias, tipoImagem, urlPublicaFoto, validarFoto,
  validarTrocaDeSenha,
} from "../lib/perfil-conta.ts";

// ==================================================== 1) PREFERENCIAS DE AVISO

// 1.1 nada gravado = o painel se comporta como antes desta tela (bip ligado)
{
  assert.deepEqual(sanitizarPreferencias(undefined), PREFERENCIAS_PADRAO);
  assert.deepEqual(sanitizarPreferencias(null), PREFERENCIAS_PADRAO);
  assert.deepEqual(sanitizarPreferencias({}), PREFERENCIAS_PADRAO);
  assert.equal(PREFERENCIAS_PADRAO.som, true, "bip nasce ligado: era o comportamento anterior");
  assert.equal(PREFERENCIAS_PADRAO.desktop, false, "aviso do navegador nasce desligado (depende de permissao)");
}

// 1.2 so booleano de VERDADE conta; string "false"/"true" e numero nao ligam nada
{
  assert.equal(sanitizarPreferencias({ som: false }).som, false);
  assert.equal(sanitizarPreferencias({ som: "false" }).som, true, "string nao decide preferencia");
  assert.equal(sanitizarPreferencias({ desktop: 1 }).desktop, false, "numero nao liga o aviso");
  assert.equal(sanitizarPreferencias({ desktop: true }).desktop, true);
}

// 1.3 chave desconhecida e IGNORADA (instalacao velha nao quebra com chave nova)
{
  const p: any = sanitizarPreferencias({ som: false, email: true, papel: "super_admin" });
  assert.deepEqual(Object.keys(p).sort(), [...CHAVES_PREFERENCIA].sort());
  assert.equal(p.email, undefined, "chave que o painel nao emite nao entra no objeto");
  assert.equal(p.papel, undefined, "preferencia nunca vira porta de escalada de permissao");
}

// 1.4 patch parcial: o que nao veio MANTEM o valor atual
// (o `atual` sai do PADRAO de proposito: chave nova na lista — o modo supervisor
// da Frente N entrou aqui — nao pode quebrar a prova do MECANISMO de mesclagem)
{
  const atual = { ...PREFERENCIAS_PADRAO, som: false, desktop: true };
  assert.deepEqual(mesclarPreferencias(atual, { som: true }), { ...atual, som: true });
  assert.deepEqual(mesclarPreferencias(atual, {}), atual, "patch vazio nao reseta nada");
  assert.deepEqual(mesclarPreferencias(atual, null), atual);
  assert.deepEqual(mesclarPreferencias(atual, { som: "x" }), atual, "valor invalido nao muda o gravado");
  // jsonb corrompido no banco cai no padrao, nunca em undefined
  assert.deepEqual(mesclarPreferencias("lixo", { desktop: false }), { ...PREFERENCIAS_PADRAO, desktop: false });
}

// 1.5 assinatura: corta espaco e respeita o teto de 60
{
  assert.equal(sanitizarAssinaturaNome("  Ana  "), "Ana");
  assert.equal(sanitizarAssinaturaNome(null), "");
  assert.equal(sanitizarAssinaturaNome(123 as any), "");
  assert.equal(sanitizarAssinaturaNome("x".repeat(200)).length, 60);
}

// ========================================================= 2) TROCA DE SENHA

// 2.1 fail-closed: sem senha atual nao passa (o ponto da story)
{
  assert.equal(validarTrocaDeSenha("", "senha-nova-123"), "Informe a senha atual.");
  assert.equal(validarTrocaDeSenha(undefined, "senha-nova-123"), "Informe a senha atual.");
  assert.equal(validarTrocaDeSenha(null, "senha-nova-123"), "Informe a senha atual.");
  assert.equal(validarTrocaDeSenha(123 as any, "senha-nova-123"), "Informe a senha atual.");
}

// 2.2 nova senha: obrigatoria, com tamanho minimo e diferente da atual
{
  assert.equal(validarTrocaDeSenha("atual123", ""), "Informe a nova senha.");
  assert.ok(validarTrocaDeSenha("atual123", "1234567")!.includes(String(SENHA_MINIMA)));
  assert.equal(validarTrocaDeSenha("mesmasenha1", "mesmasenha1"), "A nova senha precisa ser diferente da atual.");
  assert.equal(validarTrocaDeSenha("atual12345", "novasenha123"), null, "caso feliz passa");
}

// 2.3 toda recusa vira frase LEGIVEL (a story pede mensagem clara, nao codigo)
{
  for (const caso of [["", "x"], ["a", ""], ["abc12345", "abc12345"], ["abc12345", "curta"]] as const) {
    const msg = validarTrocaDeSenha(caso[0], caso[1]);
    assert.ok(typeof msg === "string" && msg.length > 10 && msg.endsWith("."), "mensagem legivel: " + msg);
  }
}

// ============================================================= 3) FOTO

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const WEBP = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), 0, 0, 0, 0]);

// 3.1 o tipo sai dos MAGIC BYTES — content-type do cliente nao decide nada
{
  assert.deepEqual(tipoImagem(JPEG), { mime: "image/jpeg", ext: "jpg" });
  assert.deepEqual(tipoImagem(PNG), { mime: "image/png", ext: "png" });
  assert.deepEqual(tipoImagem(WEBP), { mime: "image/webp", ext: "webp" });
  assert.equal(EXTENSOES_FOTO.length, 3);
}

// 3.2 o que NAO e imagem e recusado — inclusive SVG (bucket publico + script dentro)
{
  const svg = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'));
  assert.equal(tipoImagem(svg), null, "SVG nao passa");
  assert.ok(validarFoto(svg)!.includes("JPG"));
  const html = new Uint8Array(Buffer.from("<!doctype html><script>alert(1)</script>"));
  assert.equal(tipoImagem(html), null);
  // arquivo com cara de imagem so no comeco do nome nao existe aqui: so bytes valem
  assert.equal(tipoImagem(new Uint8Array(Buffer.from("GIF89a............"))), null, "gif fica de fora da v1");
}

// 3.3 vazio, curto demais e grande demais
{
  assert.equal(validarFoto(new Uint8Array()), "Arquivo vazio.");
  assert.equal(validarFoto(null), "Arquivo vazio.");
  assert.equal(tipoImagem(new Uint8Array([0xff, 0xd8])), null, "cabecalho truncado nao passa");
  const gorda = new Uint8Array(LIMITE_FOTO_BYTES + 1);
  gorda.set(JPEG.slice(0, 4));
  assert.ok(validarFoto(gorda)!.includes("2 MB"));
  assert.equal(validarFoto(JPEG), null, "jpeg pequeno passa");
}

// 3.4 caminho no bucket: id de usuario nao conferido NUNCA vira path
{
  assert.equal(caminhoFotoUsuario("11111111-2222-3333-4444-555555555555", "jpg"),
    "usuarios/11111111-2222-3333-4444-555555555555.jpg");
  assert.equal(caminhoFotoUsuario("../../central/5511999999999", "jpg"), null, "traversal recusado");
  assert.equal(caminhoFotoUsuario("id com espaco", "png"), null);
  assert.equal(caminhoFotoUsuario("", "png"), null);
  assert.equal(caminhoFotoUsuario(null, "png"), null);
  assert.equal(caminhoFotoUsuario("11111111-2222-3333-4444-555555555555", "svg"), null, "extensao fora da lista");
  // prefixo proprio: foto de atendente nunca sobrescreve foto de contato
  assert.ok(caminhoFotoUsuario("abcdefgh", "webp")!.startsWith("usuarios/"));
}

// 3.5 URL publica: versao muda com a imagem; sem storage configurado devolve null
{
  const u = urlPublicaFoto("https://xyz.supabase.co/", "fotos-perfil", "usuarios/a.jpg", "deadbeef");
  assert.equal(u, "https://xyz.supabase.co/storage/v1/object/public/fotos-perfil/usuarios/a.jpg?v=deadbeef");
  assert.equal(urlPublicaFoto(undefined, "fotos-perfil", "usuarios/a.jpg", "x"), null);
}

// ============================ 4) ACHADOS DA REVISAO CEGA (31/08/2026)

// 4.1 (MEDIA-BAIXA) Teto conferido DEPOIS de req.formData() nao protege de nada:
// o corpo inteiro ja foi bufferizado. A recusa tem que sair do content-length.
{
  assert.ok(LIMITE_MULTIPART_BYTES > LIMITE_FOTO_BYTES, "o teto do corpo tem folga sobre o da imagem");
  assert.equal(corpoGrandeDemais(LIMITE_MULTIPART_BYTES + 1), true);
  assert.equal(corpoGrandeDemais(10 * 1024 * 1024), true, "upload de 10MB morre no cabecalho");
  assert.equal(corpoGrandeDemais(LIMITE_MULTIPART_BYTES), false, "no limite ainda passa");
  assert.equal(corpoGrandeDemais(String(LIMITE_MULTIPART_BYTES + 1)), true, "header chega como string");
  // sem content-length (ou ilegivel) NAO e motivo de recusa: quem decide e o
  // teto dos bytes, ja provado em 3.3 — aqui so cortamos quem se declara grande
  assert.equal(corpoGrandeDemais(null), false);
  assert.equal(corpoGrandeDemais(undefined), false);
  assert.equal(corpoGrandeDemais("abc"), false, "lixo no header nao vira recusa nem NaN");
  assert.equal(corpoGrandeDemais(-1), false);
}

// 4.2 (BAIXA-MEDIA) Leitura do perfil que FALHA nao pode virar gravacao: o objeto
// em maos e default, e mesclar patch sobre default religaria em silencio o que a
// pessoa desligou. Recusa com mensagem DIFERENTE da de migration pendente.
{
  const ok = motivoRecusaDeGravacao({ disponivel: true, erroLeitura: false });
  assert.equal(ok, null, "leitura boa grava");

  const falhou = motivoRecusaDeGravacao({ disponivel: true, erroLeitura: true });
  assert.ok(typeof falhou === "string" && falhou.includes("nao salvei nada"),
    "leitura falha recusa e diz que nada foi salvo: " + falhou);

  const semMigration = motivoRecusaDeGravacao({ disponivel: false, erroLeitura: false });
  assert.ok(typeof semMigration === "string" && semMigration.includes("0011"),
    "falta de migration aponta a migration: " + semMigration);

  assert.notEqual(falhou, semMigration, "problema do momento nao se confunde com problema de instalacao");
  // erro de leitura MANDA mesmo quando as colunas tambem faltam: a recusa mais
  // conservadora e a que vale
  assert.equal(motivoRecusaDeGravacao({ disponivel: false, erroLeitura: true }), falhou);
}

console.log("prova-perfil: OK");
