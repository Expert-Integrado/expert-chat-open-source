"use client";

import { useEffect, useState } from "react";
import Home from "../home";

// widget embutido: le o token de contexto (?ctx=) so no client (mesmo padrao
// do deep link ?chat= do Home) e so renderiza o painel depois de ler a URL,
// pra nao piscar sem o contexto aplicado.
export default function WidgetPage() {
  const [ctxToken, setCtxToken] = useState<string | null>(null);

  useEffect(() => {
    setCtxToken(new URLSearchParams(window.location.search).get("ctx") || "");
  }, []);

  if (ctxToken === null) return null;

  return <Home embed ctxToken={ctxToken} />;
}
