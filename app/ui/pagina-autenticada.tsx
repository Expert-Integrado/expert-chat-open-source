"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { authClient } from "@/lib/auth-client";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// BOOTSTRAP UNICO DE PAGINA PROPRIA (`/campos`, `/canais`, `/biblioteca`) — fusao declarada
// na Frente X ("bootstrap duplicado de pagina", CLAUDE.md) e feita na tranche 2 da revisao
// de interface (03/09/2026), com a onda fechada e os tres arquivos sem dono ativo.
//
// O que ele faz, e so isso: le a sessao do MESMO cliente de auth do painel (mesmo
// `storageKey`: quem esta logado no painel esta logado aqui), acompanha a renovacao do
// token (aba aberta por horas nao pode virar 401) e entrega um `authedFetch` que manda o
// Bearer. Sem sessao, manda a pessoa entrar pelo painel — nao tem tela de login propria
// de proposito: duas telas de login sao duas coisas pra divergir.
//
// SEGURANCA: nada aqui autoriza nada. Quem decide e a rota (403 por permissao nomeada);
// a pagina so monta o componente, e o componente reflete o que o servidor responder.
export default function PaginaAutenticada({
  children,
}: {
  /** recebe o `authedFetch` pronto e devolve a tela */
  children: (authedFetch: Fetch) => ReactNode;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [pronto, setPronto] = useState(false);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  useEffect(() => {
    let vivo = true;
    authClient.auth.getSession().then(({ data }) => {
      if (!vivo) return;
      setSession(data.session ?? null);
      setPronto(true);
    });
    const { data: sub } = authClient.auth.onAuthStateChange((_ev, s) => {
      if (vivo) setSession(s ?? null);
    });
    return () => {
      vivo = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const authedFetch = useCallback<Fetch>((url, init) => {
    const token = sessionRef.current?.access_token;
    // deslogado no meio de uma acao: nao bater na API so pra colecionar 401
    if (!token) return Promise.reject(new Error("sem sessao"));
    return fetch(url, {
      ...init,
      cache: "no-store",
      headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` },
    });
  }, []);

  if (!pronto) return null;

  if (!session) {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-6">
        <div className="max-w-sm space-y-2 text-center">
          <p className="text-sm font-semibold">Entre no painel primeiro</p>
          <p className="text-xs text-muted-foreground">
            Esta tela usa o mesmo login do painel de atendimento. Abra o painel, entre com a sua conta e volte pra ca.
          </p>
          <a href="/" className="inline-block rounded-lg border px-3 py-2 text-xs font-medium hover:bg-muted">
            ir pro painel
          </a>
        </div>
      </div>
    );
  }

  return <>{children(authedFetch)}</>;
}
