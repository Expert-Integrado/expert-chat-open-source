import type { MetadataRoute } from "next";

// Painel interno: fora de buscador.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
