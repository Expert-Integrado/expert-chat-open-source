"use client";

import BibliotecaAnexos from "../biblioteca-anexos";
import PaginaAutenticada from "../ui/pagina-autenticada";

// PAGINA PROPRIA DA BIBLIOTECA DE ANEXOS — `/biblioteca` (Frente W, 31/08/2026).
//
// Entrada pelo mapa de Configuracoes (Atendimento > Biblioteca de anexos); esta URL
// continua valendo como link direto. Bootstrap de sessao = `<PaginaAutenticada>`
// compartilhado (tranche 2 da revisao de interface, 03/09/2026).
//
// SEGURANCA: nada aqui autoriza nada. Quem decide sao as rotas (`anexos_enviar`,
// `anexos_apagar`, `anexos_descrever`, `anexos_etiquetar`).
export default function BibliotecaPage() {
  return (
    <PaginaAutenticada>
      {(authedFetch) => (
        <BibliotecaAnexos
          authedFetch={authedFetch}
          aoSair={() => {
            window.location.href = "/";
          }}
        />
      )}
    </PaginaAutenticada>
  );
}
