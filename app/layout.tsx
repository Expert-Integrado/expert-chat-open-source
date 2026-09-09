import type { Metadata } from "next";
import "./globals.css";

// TEMA ANTES DA 1a PINTURA — o painel (home.tsx) grava a preferencia em
// localStorage("tema"); este script aplica a classe .dark em TODAS as paginas
// (/fluxos, /disparo, /biblioteca, /campos, /canais) antes do React montar, sem
// flash claro->escuro. Auditoria de interface 02/09/2026: as paginas irmas
// abriam claras pra quem usa o painel escuro.
// E um <script> cru no inicio do <body>, NAO `next/script` com beforeInteractive:
// medido em producao (02/09), o inline beforeInteractive do App Router nao rodou
// (classe ausente com localStorage preenchido). Script cru executa em ordem de
// documento, antes de qualquer conteudo pintar.
const APLICAR_TEMA = "try{if(localStorage.getItem('tema')==='escuro')document.documentElement.classList.add('dark')}catch(e){}";

const NOME = process.env.NEXT_PUBLIC_NOME_PAINEL || "Central de Atendimento";

export const metadata: Metadata = {
  title: NOME,
  description: `${NOME} — central de mensagens`,
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body className="h-screen overflow-hidden antialiased">
        <script id="tema-inicial" dangerouslySetInnerHTML={{ __html: APLICAR_TEMA }} />
        {children}
      </body>
    </html>
  );
}
