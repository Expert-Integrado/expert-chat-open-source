// A foto so pode ir pro <img> se o navegador conseguir busca-la SEM credencial.
// O bucket S3 do ChatGuru (importacao do historico) responde 403 pra requisicao
// anonima — serve-lo vira circulo quebrado na tela, pior que as iniciais.
const HOSTS_PRIVADOS = ["zapguruusers.s3."];

export function fotoPublica(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    if (HOSTS_PRIVADOS.some((h) => u.host.includes(h))) return null;
    return url;
  } catch {
    return null;
  }
}
