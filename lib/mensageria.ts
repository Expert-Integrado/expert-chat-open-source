import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Schema mensageria no Supabase do painel (conversas do numero conectado).
// fetch com cache:no-store — o Data Cache do Next congela GETs ao PostgREST
// (leitura ficava presa na primeira resposta, sobrevivendo a redeploys).
const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

let client: SupabaseClient<any, any, any> | null = null;
let clientPub: SupabaseClient<any, any, any> | null = null;

export function msgDb(): SupabaseClient<any, any, any> {
  if (!client) {
    client = createClient(
      process.env.MSG_SUPABASE_URL!,
      process.env.MSG_SUPABASE_SERVICE_KEY!,
      {
        db: { schema: "mensageria" },
        auth: { persistSession: false },
        global: { fetch: noStoreFetch },
      }
    );
  }
  return client;
}

// Schema public do MESMO banco (connectors e webhook_events da Gupshup).
export function pubDb(): SupabaseClient<any, any, any> {
  if (!clientPub) {
    clientPub = createClient(
      process.env.MSG_SUPABASE_URL!,
      process.env.MSG_SUPABASE_SERVICE_KEY!,
      {
        db: { schema: "public" },
        auth: { persistSession: false },
        global: { fetch: noStoreFetch },
      }
    );
  }
  return clientPub;
}
