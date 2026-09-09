// POLITICA DE PRIVACIDADE DA EXTENSAO DO CHROME (Chrome Web Store exige um endereco publico).
// Pagina estatica, sem login, sem dado do painel. A extensao (extensao-chrome/) e so uma
// moldura: o unico dado que ela guarda e o endereco do painel escolhido pela pessoa.
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Expert Chat — Política de privacidade da extensão",
  robots: { index: false, follow: false },
};

export default function PrivacidadeExtensao() {
  return (
    <main className="h-full overflow-y-auto bg-background text-foreground">
      <article className="mx-auto max-w-2xl px-6 py-12 text-sm leading-relaxed">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Expert Chat — extensão do Chrome</p>
        <h1 className="mt-2 text-2xl font-semibold">Política de privacidade</h1>
        <p className="mt-2 text-muted-foreground">Vigente a partir de 3 de setembro de 2026.</p>

        <h2 className="mt-8 text-base font-semibold">O que a extensão faz</h2>
        <p className="mt-2">
          A extensão Expert Chat abre, no painel lateral do navegador, o painel de atendimento
          que você indicar. Ela é apenas uma moldura: a tela, os dados e o login que aparecem
          dentro dela pertencem ao painel de atendimento da sua empresa, no endereço que você
          configurou.
        </p>

        <h2 className="mt-8 text-base font-semibold">O que a extensão guarda</h2>
        <p className="mt-2">
          Um único dado: o endereço do painel que você escolheu na tela de Opções. Ele fica no
          armazenamento sincronizado do seu navegador (chrome.storage.sync), para que a extensão
          saiba qual painel abrir. Nada mais é gravado pela extensão.
        </p>

        <h2 className="mt-8 text-base font-semibold">O que a extensão não faz</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Não coleta, não lê e não envia dados de navegação, histórico, abas ou sites visitados.</li>
          <li>Não coleta dados pessoais, dados de conversas, mensagens, contatos ou credenciais.</li>
          <li>Não usa ferramentas de análise, rastreamento ou publicidade.</li>
          <li>Não transmite nenhuma informação a servidores da Expert Integrado ou de terceiros.</li>
          <li>Não executa código remoto: todo o código da extensão está no pacote instalado.</li>
        </ul>

        <h2 className="mt-8 text-base font-semibold">Os dados do painel de atendimento</h2>
        <p className="mt-2">
          As conversas, contatos e demais informações exibidas dentro da moldura são tratadas
          pelo painel de atendimento da empresa que o instalou, no endereço configurado por você,
          e seguem a política de privacidade dessa empresa. A extensão não tem acesso a esses
          dados: eles trafegam diretamente entre o seu navegador e o painel.
        </p>

        <h2 className="mt-8 text-base font-semibold">Permissões pedidas ao navegador</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li><strong>sidePanel</strong>: exibir o painel de atendimento no painel lateral.</li>
          <li><strong>storage</strong>: lembrar o endereço do painel escolhido.</li>
        </ul>
        <p className="mt-2">A extensão não pede acesso a nenhum site.</p>

        <h2 className="mt-8 text-base font-semibold">Como apagar o que a extensão guarda</h2>
        <p className="mt-2">
          Remova a extensão do navegador: o endereço salvo é apagado junto. Você também pode
          trocar ou limpar o endereço a qualquer momento na tela de Opções.
        </p>

        <h2 className="mt-8 text-base font-semibold">Contato</h2>
        <p className="mt-2">
          Expert Integrado — <a className="text-primary underline" href="mailto:contato@expertintegrado.com.br">contato@expertintegrado.com.br</a>
          {" "}— <a className="text-primary underline" href="https://expertintegrado.com.br">expertintegrado.com.br</a>
        </p>
      </article>
    </main>
  );
}
