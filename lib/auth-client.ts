"use client";

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Auth no projeto Supabase definido pelas envs (o pool de login pode ser
// compartilhado com outros apps). storageKey proprio pra nao conflitar com
// a sessao de outro app no mesmo navegador.
// Criado so no navegador — no prerender do build as envs nao existem.
let client: SupabaseClient | null = null;

function get(): SupabaseClient {
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_AUTH_URL!,
      process.env.NEXT_PUBLIC_AUTH_ANON_KEY!,
      { auth: { storageKey: "expert-chat-auth" } }
    );
  }
  return client;
}

export const authClient = {
  get auth() {
    return get().auth;
  },
};
