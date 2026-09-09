// Servidor MCP REMOTO do painel (streamable HTTP stateless — modelo Vercel, sem
// SSE/Redis). URL: /api/mcp/mcp. O usuario conecta o agente COLANDO a config
// (nada de instalar repo): a chave pessoal eck_ vai no header x-api-key e o
// servidor resolve a identidade (mesma chave do REST) — BU, visibilidade,
// escopo e pool valem automaticamente.
//   claude mcp add --transport http expert-chat https://SEU-PAINEL/api/mcp/mcp --header "x-api-key: eck_..."
import { createMcpHandler } from "mcp-handler";
import { getUser } from "@/lib/auth-server";
import { registerChatTools, MCP_INSTRUCTIONS } from "@/lib/mcp-tools";
import { fusoDaConfig, getConfig } from "@/lib/config";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
// enviar_mensagem/atribuir podem encadear webhook + banco; folga além do default.
export const maxDuration = 60;

async function guarded(req: NextRequest): Promise<Response> {
  const key = req.headers.get("x-api-key") || "";
  if (!key) {
    return new Response(JSON.stringify({ error: "faltou o header x-api-key com a sua chave eck_" }), {
      status: 401, headers: { "content-type": "application/json" },
    });
  }
  // fail-closed: valida a chave ANTES de montar o handler (401 limpo pra chave ruim)
  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: "chave invalida ou revogada" }), {
      status: 401, headers: { "content-type": "application/json" },
    });
  }
  const base = new URL(req.url).origin;
  // hora que o agente le sai no fuso da INSTALACAO (lib/fuso.ts), nao no do
  // servidor nem num fuso cravado no codigo
  const fuso = fusoDaConfig(await getConfig());
  const handler = createMcpHandler(
    (server) => registerChatTools(server, base, key, fuso),
    { serverInfo: { name: "expert-chat", version: "1.0.0" }, instructions: MCP_INSTRUCTIONS },
    { basePath: "/api/mcp", disableSse: true, maxDuration: 60 }
  );
  return handler(req);
}

export { guarded as GET, guarded as POST, guarded as DELETE };
