import { createHash } from "node:crypto";

// Foto de perfil PERMANENTE (decisao Eric 25/08/2026): a URL que o WhatsApp
// da expira em dias — em vez de renovar link pra sempre, baixamos a imagem
// UMA vez e guardamos no Storage do proprio Supabase (bucket publico
// fotos-perfil). A URL gravada em conversas.foto_wa_url passa a ser NOSSA e
// nunca morre; a renovacao periodica vira so "capturar foto TROCADA".
// O ?v=<hash da imagem> so muda quando a foto muda — cache do browser continua
// valendo entre renovacoes identicas.
const BUCKET = "fotos-perfil";

// A Z-API responde contato sem foto com a STRING "null" (nao null) — que e
// truthy e ja poluiu foto_wa_url com "null" literal. So URL http(s) presta.
export function linkCdnValido(link: unknown): string | null {
  return typeof link === "string" && /^https?:\/\//.test(link) ? link : null;
}

export async function guardarFotoPermanente(
  db: any,
  chatId: string,
  linkCdn: string
): Promise<string | null> {
  try {
    const r = await fetch(linkCdn, { cache: "no-store" });
    if (!r.ok) return null;
    const bytes = Buffer.from(await r.arrayBuffer());
    if (!bytes.length) return null;
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
    // chat_id e telefone ou id de grupo (...-group) — sanitizar por garantia
    const safe = chatId.replace(/[^A-Za-z0-9._-]/g, "_");
    const path = `central/${safe}.jpg`;
    const { error } = await db.storage.from(BUCKET).upload(path, bytes, {
      contentType: r.headers.get("content-type") || "image/jpeg",
      upsert: true,
    });
    if (error) return null;
    return `${process.env.MSG_SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}?v=${hash}`;
  } catch {
    return null;
  }
}
