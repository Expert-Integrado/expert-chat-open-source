// connect-src do CSP derivado das envs do proprio deploy (base open source:
// nada de host de Supabase hardcodado). Sem env no build, cai no wildcard.
const supabaseOrigins = [
  ...new Set(
    [process.env.MSG_SUPABASE_URL, process.env.NEXT_PUBLIC_AUTH_URL]
      .filter(Boolean)
      .map((u) => new URL(u).origin)
  ),
];
const connectSrc = ["'self'", ...(supabaseOrigins.length ? supabaseOrigins : ["https://*.supabase.co"])];

// Modo widget: SO a rota /widget pode ser emoldurada, e SO pelas origens
// listadas em EMBED_FRAME_ANCESTORS (separadas por espaco) MAIS a extensao
// oficial do Chrome (Chrome Web Store, id fixo em lib/extensao-oficial.json):
// e a mesma extensao pra qualquer instalacao, entao toda instalacao a aceita
// sem configurar nada (decisao do Eric, 02/09/2026). Fora disso, nenhum site
// emoldura o widget — abrir pra um hospedeiro e decisao explicita de deploy.
import { readFileSync } from "node:fs";
const extensaoOficial = JSON.parse(readFileSync(new URL("./lib/extensao-oficial.json", import.meta.url), "utf8"));
const frameAncestorsWidget = [
  ...new Set([
    ...(process.env.EMBED_FRAME_ANCESTORS || "").trim().split(/\s+/).filter(Boolean),
    extensaoOficial.origem,
  ]),
].join(" ");

function csp(frameAncestors) {
  return [
    "default-src 'self'",
    // Next injeta script inline de hidratacao
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    // midia e foto de perfil vem da Z-API/Backblaze/WhatsApp
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    `connect-src ${connectSrc.join(" ")}`,
    `frame-ancestors ${frameAncestors}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

const headersComuns = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // microphone=(self): o proprio painel grava audio (PTT); camera/geo seguem bloqueados
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // painel interno: nao indexar em buscador
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        // tudo MENOS /widget: moldura proibida (XFO DENY + frame-ancestors 'none')
        source: "/((?!widget).*)",
        headers: [
          ...headersComuns,
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: csp("'none'") },
        ],
      },
      {
        // /widget: sem X-Frame-Options (nao expressa allowlist); CSP manda
        source: "/widget/:path*",
        headers: [...headersComuns, { key: "Content-Security-Policy", value: csp(frameAncestorsWidget) }],
      },
    ];
  },
};

export default nextConfig;
