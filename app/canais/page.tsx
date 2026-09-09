"use client";

import AdminCanais from "../admin-canais";
import PaginaAutenticada from "../ui/pagina-autenticada";

// PAGINA PROPRIA DA TELA DE NUMEROS — `/canais` (Frente U, 31/08/2026).
//
// A entrada natural e a visao "Numeros" do painel (trilho esquerdo e mapa de
// Configuracoes); esta URL continua valendo como link direto. O bootstrap de sessao
// que nasceu aqui e foi copiado por `/campos` e `/biblioteca` virou o
// `<PaginaAutenticada>` compartilhado (tranche 2 da revisao de interface, 03/09/2026).
//
// SEGURANCA: nada aqui autoriza nada. Quem decide e a rota (`gerenciar_canais` ou
// super admin); a pagina so carrega o componente, que reflete o que o servidor
// responder — inclusive o 403.
export default function CanaisPage() {
  return (
    <PaginaAutenticada>
      {(authedFetch) => (
        <AdminCanais
          authedFetch={authedFetch}
          aoSair={() => {
            window.location.href = "/";
          }}
        />
      )}
    </PaginaAutenticada>
  );
}
