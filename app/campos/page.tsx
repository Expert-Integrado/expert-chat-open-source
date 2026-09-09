"use client";

import AdminCampos from "../admin-campos";
import PaginaAutenticada from "../ui/pagina-autenticada";

// PAGINA PROPRIA DO CONSTRUTOR DE FICHA — `/campos` (Frente X, 31/08/2026).
//
// Desde a tranche 2 da revisao de interface (03/09/2026) o construtor tambem e a aba
// "Campos da ficha" do mapa de Configuracoes (`<AdminCampos embutido />` em home.tsx).
// Esta URL continua valendo como link direto — e o bootstrap de sessao, antes copiado
// de `/canais`, virou o `<PaginaAutenticada>` compartilhado (fusao declarada na Frente X).
//
// SEGURANCA: nada aqui autoriza nada. Quem decide e a rota
// (`permitido(perfil, "gerenciar_campos")` em `app/api/campos/route.ts`).
export default function CamposPage() {
  return (
    <PaginaAutenticada>
      {(authedFetch) => (
        <AdminCampos
          authedFetch={authedFetch}
          aoSair={() => {
            window.location.href = "/";
          }}
        />
      )}
    </PaginaAutenticada>
  );
}
