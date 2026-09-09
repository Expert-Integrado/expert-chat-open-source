# Extensao do Chrome — o painel de atendimento no painel lateral

> Pedido do Eric (02/09/2026): "um plugin do Chrome que abra exatamente o mesmo banco, a
> mesma coisa". E exatamente isso: a extensao e **so uma moldura** (Side Panel, Manifest V3)
> que carrega o `/widget` do painel. Zero codigo do painel aqui; zero dado da Expert aqui.
> Card `86akaap6t`. Viabilidade e limites: `docs/embed-como-instalar.md`, secao 5.

## O que tem na pasta

| Arquivo | Papel |
|---|---|
| `manifest.json` | MV3, `side_panel`, permissao `storage`, e a **chave publica fixa** (`key`) que trava o ID |
| `background.js` | clicar no icone abre o painel lateral; 1a instalacao sem endereco abre as Opcoes |
| `sidepanel.html` / `sidepanel.js` | o iframe do widget (`allow="clipboard-write; microphone"`, sem sandbox) e o aviso "falta o endereco" |
| `options.html` / `options.js` | onde a pessoa cola a URL do painel (guardada em `chrome.storage.sync`) e le a origem a liberar |

**ID fixo:** `ogopiikeijddpkmkeippljgcihapcnph`. Vem da `key` do manifesto, entao a pasta
descompactada carrega com o MESMO id em qualquer maquina — e o que permite liberar
`chrome-extension://ogopiikeijddpkmkeippljgcihapcnph` uma vez so no painel. A chave privada
correspondente nao foi guardada de proposito (so seria necessaria pra empacotar `.crx`);
publicar na Chrome Web Store gera OUTRO id, que teria que ser liberado tambem.

## Extensao oficial na Chrome Web Store (enviada em 03/09/2026 de madrugada; APROVADA e publicada no mesmo dia, a noite)

- **ID da loja: `fnidebgjjamnnppdlcckodkiehlhagkp`** (fixo; publisher Expert Integrado, conta
  da Expert Integrado, item nao listado). Link de instalacao (no ar desde 03/09/2026,
  medido por `scripts/extensao/status-loja.py`: pagina 200, CRX 200):
  <https://chromewebstore.google.com/detail/fnidebgjjamnnppdlcckodkiehlhagkp>. Instalar: "Usar no
  Chrome" -> clicar no icone -> na 1a vez colar o endereco do painel nas Opcoes -> logar.
- Fonte unica do id no codigo: `lib/extensao-oficial.json`. O `next.config.mjs` inclui essa
  origem na CSP do `/widget` por PADRAO e a rota `/api/embed/instalacao` a lista — toda
  instalacao do painel (aluno/cliente) aceita a extensao oficial sem configurar nada.
- O id de desenvolvimento (`ogopiikeijddpkmkeippljgcihapcnph`, pela `key` do manifesto) continua
  valendo so pra "Carregar sem compactacao"; quem instalar pela
  loja nao precisa dele.

## Publicar na Chrome Web Store (decisao do Eric, 02/09/2026: UMA extensao, nao listada)

`python scripts/extensao/empacotar.py` gera em uma pasta temporaria o zip SEM `key`
(a loja atribui o id), os icones (tambem gravados em `icones/` e no manifesto) e as imagens da
ficha (1280x800 e tile 440x280, so com a tela de login — nunca conversa). A politica de privacidade publica e
`/extensao/privacidade` no painel. Cada instalacao (aluno/cliente) usa a MESMA extensao e aponta
pro proprio painel nas Opcoes — ninguem publica nada por conta.

## Instalar (equipe interna, sem loja)

1. `chrome://extensions` → ligar **Modo do desenvolvedor** → **Carregar sem compactacao** →
   escolher esta pasta (`extensao-chrome/`). Confira que o ID mostrado e o de cima.
2. Na 1a vez abrem as **Opcoes**: cole o endereco do painel (`https://SEU-PAINEL` ja basta;
   a extensao completa com `/widget`). Aceita tambem um link com token de recorte
   (`/widget?ctx=...`) gerado em **Configuracoes → Instalar widget**.
3. Clique no icone da extensao: o painel lateral abre com a tela de login do painel (email,
   senha, 2FA — dentro da moldura, como em qualquer hospedeiro).

## Liberar no painel (quem administra a instalacao, 1 vez)

O `/widget` so aceita moldura das origens em `EMBED_FRAME_ANCESTORS`. Acrescente
`chrome-extension://ogopiikeijddpkmkeippljgcihapcnph` a lista (separado por espaco), publique
de novo (variavel de build) e confira na tela Instalar widget, passo 3.

Na instalacao da Expert (chat.expertintegrado.com.br) isso JA FOI FEITO em 02/09/2026: a origem
esta na CSP de producao (`curl -sI .../widget | grep frame-ancestors` mostra a origem).

## Provado em 02/09/2026 (Chromium do Playwright, `scripts/homologacao/homologar-extensao.py`)

- ID real da extensao carregada = `ogopiikeijddpkmkeippljgcihapcnph` (bate com o manifesto).
- Opcoes gravam o endereco; o painel lateral carrega o `/widget` dentro da origem
  `chrome-extension://` (CSP aceitou); login com e-mail, senha e 2FA acontece dentro da moldura.
- Recarregar o painel lateral NAO pede login de novo (a sessao vive no storage da particao).
- Falta so a instalacao fisica no Chrome de cada pessoa (3 passos acima).

## O que ja se sabe

- A sessao do painel vive em `localStorage` da origem do painel (nao e cookie): dentro da
  extensao ela persiste por particao — logou uma vez no painel lateral, fica logado ali.
- Com "Bloquear cookies de terceiros" ligado no Chrome, o iframe pode perder acesso ao storage
  e o login entrar em loop. Se acontecer: permitir cookies para o dominio do painel
  (`chrome://settings/cookies`, "Sites que sempre podem usar cookies").
- Largura tipica do painel lateral (320-500px) cai no **modo estreito** do widget (lista em
  pilha, conversa com botao de voltar).
- Prova automatizada: `scripts/homologacao/homologar-extensao.py` (carrega a pasta num Chromium
  do Playwright, abre `chrome-extension://<id>/sidepanel.html`, loga dentro do iframe e confere
  que recarregar nao pede login de novo).
