"use client";

import { Download } from "lucide-react";

// Botao Exportar CSV — card 86ak85bne.
//
// Arquivo PROPRIO (nao dentro de relatorios-painel.tsx) pra nao fechar ciclo de
// import: o painel importa as abas, e as abas importariam o painel de volta. O
// ciclo funcionaria por hoisting de `function`, mas ciclo entre componentes React
// e o tipo de coisa que quebra na primeira refatoracao, com "Element type is
// invalid" e nenhuma pista.
//
// SEM PERMISSAO O BOTAO NAO EXISTE — nao fica cinza. A rota
// (`?formato=csv` + `relatorios_exportar`) nega com 403 de todo jeito; botao
// desabilitado convida a clicar e nao explica nada. Uma linha dizendo QUAL
// permissao falta e mais honesta que um controle morto.
export function BotaoCsv({
  onClick,
  semExportar,
  rotulo = "Exportar CSV",
}: {
  onClick: () => void;
  /** `null` = pode exportar; texto = o motivo, que vai pra tela no lugar do botao */
  semExportar: string | null;
  rotulo?: string;
}) {
  if (semExportar) return <span className="text-[11px] text-muted-foreground">{semExportar}</span>;
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted"
    >
      <Download className="h-3.5 w-3.5" />
      {rotulo}
    </button>
  );
}
