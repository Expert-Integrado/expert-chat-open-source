import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { usuarioPorSessao } from "@/lib/auth-server";
import { contaDoUsuario } from "@/lib/perfil";
import { msgDb } from "@/lib/mensageria";
import {
  BUCKET_FOTOS,
  caminhoFotoUsuario,
  tipoImagem,
  urlPublicaFoto,
  validarFoto,
  corpoGrandeDemais,
  LIMITE_FOTO_BYTES,
  EXTENSOES_FOTO,
} from "@/lib/perfil-conta";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const FALTA_MIGRATION =
  "Foto de perfil indisponivel: falta rodar a migration 0011 nesta instalacao.";

// Foto do proprio atendente. Sobe pro bucket PUBLICO `fotos-perfil` (o mesmo da
// foto de contato do WhatsApp, prefixo `usuarios/`) e a URL fica em
// mensageria.perfis.foto_url.
//
// Identidade so por sessao de login (nunca x-api-key): chave de agente nao
// troca a cara de ninguem no painel.
export async function POST(req: NextRequest) {
  const user = await usuarioPorSessao(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const conta = await contaDoUsuario(user.id);
  if (!conta.disponivel) return NextResponse.json({ error: FALTA_MIGRATION }, { status: 503 });

  // Teto ANTES de tocar no corpo: req.formData() ja bufferiza o upload inteiro,
  // entao conferir o tamanho so depois dele nao protege de nada. A folga sobre
  // os 2 MB cobre o overhead do multipart (boundary + cabecalhos de campo);
  // o teto exato vale sobre os BYTES DA IMAGEM, mais abaixo.
  if (corpoGrandeDemais(req.headers.get("content-length"))) {
    return NextResponse.json({ error: "A imagem precisa ter no maximo 2 MB." }, { status: 413 });
  }

  let bytes: Uint8Array;
  try {
    const form = await req.formData();
    const arquivo = form.get("arquivo");
    if (!(arquivo instanceof Blob)) {
      return NextResponse.json({ error: "Envie o arquivo no campo 'arquivo'." }, { status: 400 });
    }
    if (arquivo.size > LIMITE_FOTO_BYTES) {
      return NextResponse.json({ error: "A imagem precisa ter no maximo 2 MB." }, { status: 400 });
    }
    bytes = new Uint8Array(await arquivo.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "Nao consegui ler o arquivo enviado." }, { status: 400 });
  }

  // content-type do cliente nao vale nada: o tipo sai dos magic bytes
  const problema = validarFoto(bytes);
  if (problema) return NextResponse.json({ error: problema }, { status: 400 });
  const tipo = tipoImagem(bytes)!;
  const path = caminhoFotoUsuario(user.id, tipo.ext);
  if (!path) return NextResponse.json({ error: "Identificador de usuario invalido." }, { status: 400 });

  const db = msgDb();
  const { error: erroUp } = await db.storage.from(BUCKET_FOTOS).upload(path, bytes, {
    contentType: tipo.mime,
    upsert: true,
  });
  if (erroUp) {
    return NextResponse.json(
      { error: `Nao consegui guardar a imagem. Confira se o bucket publico '${BUCKET_FOTOS}' existe nesta instalacao.` },
      { status: 500 }
    );
  }

  const versao = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const url = urlPublicaFoto(process.env.MSG_SUPABASE_URL, BUCKET_FOTOS, path, versao);
  if (!url) return NextResponse.json({ error: "Storage nao configurado nesta instalacao." }, { status: 500 });

  // trocou de formato? o arquivo antigo (outra extensao) vira lixo no bucket
  for (const ext of EXTENSOES_FOTO) {
    if (ext === tipo.ext) continue;
    const velho = caminhoFotoUsuario(user.id, ext);
    if (velho) await db.storage.from(BUCKET_FOTOS).remove([velho]).catch(() => {});
  }

  // upsert de FOTO mexe so na foto: mandar `nome` aqui sobrescreveria de brinde
  // o nome gravado em perfis (que o super admin pode ter ajustado)
  const { error } = await db
    .from("perfis")
    .upsert({ user_id: user.id, foto_url: url, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: "Nao consegui salvar a foto no seu perfil." }, { status: 500 });

  return NextResponse.json({ ok: true, foto_url: url });
}

// Remover a propria foto: some do bucket e a coluna volta a NULL (a UI cai nas
// iniciais, que e como o painel sempre mostrou quem nao tem foto).
export async function DELETE(req: NextRequest) {
  const user = await usuarioPorSessao(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const conta = await contaDoUsuario(user.id);
  if (!conta.disponivel) return NextResponse.json({ error: FALTA_MIGRATION }, { status: 503 });

  const db = msgDb();
  const alvos = EXTENSOES_FOTO.map((ext) => caminhoFotoUsuario(user.id, ext)).filter(
    (p): p is string => !!p
  );
  if (alvos.length) await db.storage.from(BUCKET_FOTOS).remove(alvos).catch(() => {});

  const { error } = await db
    .from("perfis")
    .upsert({ user_id: user.id, foto_url: null, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: "Nao consegui remover a foto." }, { status: 500 });
  return NextResponse.json({ ok: true, foto_url: null });
}
