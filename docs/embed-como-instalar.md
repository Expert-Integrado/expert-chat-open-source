# Embutir o painel em outro sistema

> Este documento tem **dois leitores**:
>
> - **O dev que vai embutir** o painel num sistema já existente (portal, ERP, admin de
>   produto, CRM próprio). Interessa a ele a seção 3 (as três formas de exibição) e a 6
>   (checklist).
> - **O dono da instalação do painel**, que precisa liberar a moldura no deploy do
>   próprio painel. Interessa a ele a seção 2 — e sem essa liberação **nada** do resto
>   funciona: o iframe aparece em branco.
>
> Implementação de referência: o Portal do Aluno da Expert Integrado (arquivos citados na
> seção 3).

---

## 0. O caminho rápido: tela **Instalar widget** (02/09/2026)

Tudo que este guia explica está pronto, clicável, em **Configurações → Instalar widget**
(só super admin). A tela faz quatro coisas:

1. **Onde vai ficar** — escolhe a forma (módulo em tela cheia, balão flutuante, painel
   lateral) e gera o HTML/JS completo da seção 3, já com a URL desta instalação. Na forma de
   tela cheia há também a versão React (JSX).
2. **O que a pessoa vê** — escolhe o contexto (ou "sem recorte") e cunha um **token de
   longa duração** (1 a 90 dias) pela sessão do admin: `POST /api/embed/instalacao`. É a saída
   para hospedeiro sem backend, favorito, link fixo e extensão do Chrome. O mint
   servidor-a-servidor da seção 4 continua sendo o caminho para hospedeiro com backend, e a
   tela mostra o `curl` dele quando `EMBED_MINT_SECRET` existe.
3. **Libere o site hospedeiro** — cole a URL do hospedeiro e a tela diz se a origem já está
   em `EMBED_FRAME_ANCESTORS` (lista lida do servidor por `GET /api/embed/instalacao`) ou se
   falta acrescentar e publicar de novo; imprime o `curl` de conferência.
4. **Cole no seu sistema** — botão de copiar o código e, separado, só o endereço do widget.

Contrato da rota (super admin): `GET` devolve `painel_url`, `origens_liberadas[]`,
`mint_configurado`, `jwt_configurado`, `teto_dias` e `contextos[]` (ativos, independente do
toggle `seletor_visao`); `POST {contexto, dias}` devolve `{token, expira_em, dias}`. Nenhum
segredo sai do servidor — só booleanos dizendo se existem.

---

## 1. O que é

O painel **inteiro** roda dentro de um `<iframe>` apontado para:

```
https://<sua-instalacao>/widget
```

Não existe SDK, não existe pacote npm, não existe bundle para copiar. O hospedeiro só
coloca um iframe na tela e decide o tamanho dele.

**Login e 2FA acontecem DENTRO do iframe.** O atendente vê a tela de login do próprio
painel na primeira vez, digita email/senha e o código do 2FA ali dentro. Consequências
que valem repetir:

- **Nenhuma credencial passa pelo sistema hospedeiro.** O host não autentica ninguém,
  não repassa token de sessão, não guarda senha. Ele não tem como ler a sessão do painel
  (origem diferente, storage diferente).
- A sessão vive no `localStorage` da origem do painel (chave `expert-chat-auth`,
  `lib/auth-client.ts`) e as chamadas da API vão com `Authorization: Bearer <token>`.
  **Não há cookie de sessão** — detalhe que importa na seção 5.
- Quem controla quem entra continua sendo o painel: usuário, papel, permissões,
  visibilidade por conversa e vínculo de BU (`mensageria.perfil_contextos`). Embutir não
  amplia o que ninguém vê.

### O que o modo embed muda na tela

A rota `/widget` renderiza o mesmo componente da tela cheia (`app/home.tsx`) com a prop
`embed`. Ela **esconde** o que não faz sentido dentro do sistema de outra pessoa:

- sino de notificações e o menu de perfil no rodapé;
- filtro de canal e seletor de visão (BU) — dentro do widget o recorte é fixo;
- Configurações, administração de acesso, canais, relatórios e visão em quadro;
- seleção em massa de conversas (visibilidade / auto-arquivar / status / responsável /
  arquivar).

E **mostra** uma única ponte de saída: o link "Abrir o painel completo em outra aba" no
rodapé da lista (02/09/2026) — quem precisar de configuração, quadro ou relatório não fica
trancado na moldura.

E **desliga o auto-logout por inatividade**: quem governa a sessão passa a ser o
hospedeiro (`app/home.tsx`, efeito com `if (!session || embed) return`).

### Modo estreito (02/09/2026)

Abaixo de **768px de largura** (breakpoint `md` do Tailwind, sem override no
`tailwind.config.ts`) a lista de conversas e a conversa viram **pilha**:

- a lista ocupa a largura toda;
- abrir uma conversa esconde a lista e mostra a conversa inteira, com um botão de
  **voltar** (seta) no cabeçalho;
- a ficha do contato deixa de ser terceira coluna e abre como **painel sobreposto** de
  tela cheia.

De 768px para cima nada muda em relação à tela cheia (lista de 340px + conversa + ficha).

**É esse modo que faz o balão de ~400px e o painel lateral de ~460px serem usáveis.**
Antes dele a lista comia 340px fixos e sobravam ~80px para a conversa (commit
`c3d943f`).

### Deep link

`/widget?chat=<chat_id>&canal=<canal>` abre a conversa direto — útil para um botão "abrir
o atendimento deste contato" numa tela do hospedeiro. Combina com o token de contexto:
`/widget?ctx=<token>&chat=<chat_id>&canal=<canal>`.

---

## 2. Pré-requisito do lado do painel (dono da instalação)

Por padrão o painel **proíbe** ser emoldurado: `next.config.mjs` manda
`X-Frame-Options: DENY` + `frame-ancestors 'none'` em tudo. A rota `/widget` é a única
exceção — e mesmo ela só abre para as origens que você listar.

### A variável

| Variável | Obrigatória? | Para quê |
| --- | --- | --- |
| `EMBED_FRAME_ANCESTORS` | **Sim, para embutir** | Origens do hospedeiro autorizadas a emoldurar `/widget`, **separadas por espaço**. Sem ela: `frame-ancestors 'none'` (iframe em branco). |
| `EMBED_JWT_SECRET` | Só com recorte por contexto | Assina/valida o token de contexto (`?ctx=`). Sem ela, cunhar token estoura. |
| `EMBED_MINT_SECRET` | Só com recorte por contexto | Autoriza a cunhagem servidor-a-servidor em `POST /api/embed/token`. |
| `CHATGURU_SYNC_SECRET` | Só com allowlist automática | Bearer de `POST /api/embed/sync` (popula a allowlist do contexto). |

Exemplo com duas origens:

```
EMBED_FRAME_ANCESTORS=https://portal.suaempresa.com.br https://admin.suaempresa.com.br
```

Regras que já custaram tempo:

- O valor entra **literalmente** no header, na diretiva `frame-ancestors`. Use **origem**
  (esquema + host + porta quando não for a padrão), **sem caminho** e **sem barra final**:
  `https://portal.suaempresa.com.br`, nunca `https://portal.suaempresa.com.br/admin`.
- Origem é o que aparece na barra de endereços do **hospedeiro**, não do painel.
- Ambiente de desenvolvimento é outra origem: para testar o embed rodando o host em
  local, acrescente `http://localhost:5173` (ou a porta que for) à lista.
- Só `/widget` é emoldurável. Apontar o iframe para a raiz (`/`) **não funciona nunca** —
  ali continua valendo `X-Frame-Options: DENY`.

### Depois de mudar a env: **redeploy**

O header é montado no `next.config.mjs`, que é avaliado **no build**. Salvar a variável
no painel da Vercel (ou no `.env`) não muda nada até um deploy novo. Não existe "reiniciar
e pegar".

### Como conferir com curl

```bash
curl -sS -D - -o /dev/null https://<sua-instalacao>/widget | grep -i content-security-policy
```

> No Git Bash do Windows, HTTPS costuma exigir `--ssl-no-revoke` (falha schannel exit 35).

Você deve ver a diretiva com a sua origem:

```
content-security-policy: default-src 'self'; ...; frame-ancestors https://portal.suaempresa.com.br; ...
```

Diagnóstico rápido pelo que aparece:

| O que o header mostra | Significa |
| --- | --- |
| `frame-ancestors 'none'` | Env ausente **ou** deploy antigo. O iframe fica branco. |
| `frame-ancestors https://outra-coisa` | Origem errada na lista (típico: com caminho, com barra final, ou host de dev). |
| A sua origem, e ainda assim branco | Confira o console do navegador do **hospedeiro**: se disser `Refused to frame ... frame-ancestors`, é origem; se não disser nada, é altura/tamanho do iframe (seção 3). |

Contraste que vale rodar junto (prova de que o resto segue fechado):

```bash
curl -sS -D - -o /dev/null https://<sua-instalacao>/ | grep -iE "x-frame-options|frame-ancestors"
# esperado: x-frame-options: DENY  +  frame-ancestors 'none'
```

---

## 3. As três formas de exibição

### Regra de ouro: nunca desmonte o iframe

O login com 2FA vive **dentro** do iframe. Remover o `<iframe>` do DOM (ou trocar o `src`)
recarrega o app do painel e **pede login de novo**. Ao fechar, esconder:

- `display:none` (atributo `hidden`, classe `hidden`), ou
- `transform: translateX(100%)` para o painel lateral.

Isso vale também para componentes de UI que desmontam o conteúdo ao fechar — no React, um
`Sheet`/`Dialog` do shadcn desmonta os filhos; por isso o portal **não** usou o `Sheet` no
painel lateral.

Atributos do iframe, iguais nas três formas:

```html
allow="clipboard-write"   <!-- copiar do painel -->
title="Atendimento"       <!-- rótulo acessível -->
<!-- sem sandbox: o painel precisa do storage próprio pra sessão e 2FA -->
```

- **Sem `sandbox`.** `sandbox` sem `allow-same-origin` bloqueia o storage da origem do
  painel e a sessão nunca persiste.
- Quer **gravar áudio** (PTT) de dentro do embed? Aí precisa delegar o microfone:
  `allow="clipboard-write; microphone"`. O painel já libera do lado dele
  (`Permissions-Policy: microphone=(self)`), mas a delegação do hospedeiro é obrigatória.
  A referência do portal **não** delegou (só `clipboard-write`).
- **Altura é responsabilidade do hospedeiro.** O painel usa `h-screen`, e dentro de um
  iframe `100vh` = a altura do iframe. Iframe sem altura definida = nada aparece. Não
  existe auto-resize por `postMessage`.

### 3.1 Balão flutuante (~400px)

Botão redondo fixo no canto; clicado, abre um painel ancorado. Cai no modo estreito.

```html
<div id="ec-balao" style="position:fixed;right:24px;bottom:24px;z-index:9999;
     display:flex;flex-direction:column;align-items:flex-end;gap:12px">

  <!-- o iframe nasce UMA vez; fechar só esconde esta caixa -->
  <div id="ec-painel" hidden
       style="width:min(400px,calc(100vw - 48px));height:min(620px,calc(100vh - 160px));
              overflow:hidden;border-radius:16px;border:1px solid #e5e7eb;background:#fff;
              box-shadow:0 20px 50px rgba(0,0,0,.25)">
    <iframe src="https://SUA-INSTALACAO/widget"
            title="Atendimento" allow="clipboard-write"
            style="width:100%;height:100%;border:0"></iframe>
  </div>

  <button id="ec-botao" type="button" aria-expanded="false"
          style="width:56px;height:56px;border-radius:9999px;border:0;cursor:pointer">
    Chat
  </button>
</div>

<script>
  var painel = document.getElementById('ec-painel');
  var botao = document.getElementById('ec-botao');
  botao.addEventListener('click', function () {
    painel.hidden = !painel.hidden; // esconde; NUNCA remove o iframe
    botao.setAttribute('aria-expanded', String(!painel.hidden));
  });
</script>
```

### 3.2 Módulo em tela cheia

O iframe ocupa a largura da rota e a altura da viewport **menos o que estiver acima dele**
(header do sistema, banner, breadcrumb). Meça em vez de chumbar: banners aparecem e
desaparecem.

```html
<div id="ec-modulo" style="overflow:hidden;border:1px solid #e5e7eb;border-radius:12px">
  <iframe src="https://SUA-INSTALACAO/widget"
          title="Atendimento" allow="clipboard-write"
          style="width:100%;height:100%;border:0"></iframe>
</div>

<script>
  var caixa = document.getElementById('ec-modulo');
  var MARGEM = 24;   // respiro embaixo, pra página não ganhar barra de rolagem
  var MINIMA = 420;  // piso de usabilidade
  function medir() {
    var topo = caixa.getBoundingClientRect().top;
    caixa.style.height = Math.max(MINIMA, window.innerHeight - topo - MARGEM) + 'px';
  }
  medir();
  window.addEventListener('resize', medir);
</script>
```

Nesta forma o painel normalmente passa de 768px e roda no layout de três colunas.

### 3.3 Painel lateral (~460px)

Aba discreta na borda; clicada, desliza um drawer. Fechar é `translateX(100%)` — o iframe
continua montado. Cai no modo estreito.

```html
<div id="ec-overlay" hidden
     style="position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.4)"></div>

<aside id="ec-drawer" aria-label="Painel de atendimento"
       style="position:fixed;top:0;bottom:0;right:0;z-index:9999;width:min(460px,90vw);
              background:#fff;border-left:1px solid #e5e7eb;
              transform:translateX(100%);pointer-events:none;
              transition:transform .3s ease-in-out">
  <iframe src="https://SUA-INSTALACAO/widget"
          title="Atendimento" allow="clipboard-write"
          style="width:100%;height:100%;border:0"></iframe>
</aside>

<button id="ec-aba" type="button" aria-expanded="false"
        style="position:fixed;top:50%;right:0;z-index:10000;transform:translateY(-50%)">
  Atendimento
</button>

<script>
  var drawer = document.getElementById('ec-drawer');
  var overlay = document.getElementById('ec-overlay');
  var aba = document.getElementById('ec-aba');
  var LARGURA = 'min(460px,90vw)';
  var aberto = false;

  function alternar(v) {
    aberto = v;
    drawer.style.transform = aberto ? 'translateX(0)' : 'translateX(100%)';
    drawer.style.pointerEvents = aberto ? 'auto' : 'none';
    overlay.hidden = !aberto;
    aba.style.right = aberto ? LARGURA : '0';   // a aba acompanha a borda do drawer
    aba.setAttribute('aria-expanded', String(aberto));
  }

  aba.addEventListener('click', function () { alternar(!aberto); });
  overlay.addEventListener('click', function () { alternar(false); });
</script>
```

### O padrão React do portal (referência)

Branch `feature/widget-atendimento` do Portal do Aluno (React + Vite + shadcn):

| Arquivo | O que carrega |
| --- | --- |
| `src/config/atendimento.ts` | URL do widget (`VITE_EXPERT_CHAT_WIDGET_URL` com padrão de produção) e a preferência de forma em `localStorage`. |
| `src/components/admin/atendimento/ChatEmbedFrame.tsx` | O iframe, um só: `allow="clipboard-write"`, **sem** `sandbox`, `onLoad` para tirar o "carregando". |
| `.../AtendimentoBalao.tsx` | Balão: `h-[min(620px,calc(100vh-10rem))] w-[min(400px,calc(100vw-3rem))]`, fecha com a classe `hidden`. |
| `.../AtendimentoTelaCheia.tsx` | Altura medida por `getBoundingClientRect().top` + listener de `resize`. |
| `.../AtendimentoPainelLateral.tsx` | Drawer por `translate-x-full` — **não** usa o `Sheet` do shadcn de propósito (o Sheet desmonta o conteúdo). |
| `src/pages/admin/Atendimento.tsx` | Página de validação com as três formas: um `Set` de "visitados" monta cada forma na primeira seleção e **mantém montada**, para alternar não custar login novo. |

Dois detalhes daquela página que valem virar hábito:

1. A rota fica atrás do gate de staff do hospedeiro (no portal, `ProtectedRoute` com
   `allowedRoles=['super_admin','admin']`). O painel é ferramenta **interna** — aluno,
   cliente ou usuário final nunca deve ver a aba.
2. A tela diz, em letra pequena, qual URL está no iframe e qual origem precisa estar no
   `EMBED_FRAME_ANCESTORS`. Isso transforma "está branco" em diagnóstico de 5 segundos.

---

## 4. Recorte de escopo por contexto (opcional)

Sem `?ctx=`, o widget mostra tudo o que aquele usuário já veria na tela cheia (com o
vínculo de BU dele valendo, se houver). A referência do portal hoje é assim: URL limpa,
sem token — o recorte que vale é o vínculo de BU do usuário no painel.

Quando o hospedeiro quer **estreitar** a visão (ex.: "aqui dentro só as conversas dos
alunos ativos"), existe o token de contexto. O que segue é **o que o código faz hoje**.

### O mecanismo

1. **O contexto é cadastrado no banco do painel**: `mensageria.embed_contextos`
   (`id` slug, `nome`, `filtro` jsonb, `ativo`) e a lista de telefones em
   `mensageria.embed_allowlist` (`contexto_id`, `telefone_digits`).
2. **O backend do hospedeiro cunha o token** — servidor-a-servidor, nunca no navegador:

   ```bash
   curl -sS -X POST https://<sua-instalacao>/api/embed/token \
     -H "Authorization: Bearer $EMBED_MINT_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"contexto":"portal-alunos"}'
   # -> {"token":"...","expira_em":"..."}
   ```

   Body: `contexto` (obrigatório, precisa existir e estar `ativo=true`) e `dias`
   (opcional, teto **90**). Sem `dias`, a validade é **8h**. Contexto inexistente ou
   inativo = 404; Bearer errado = 401 (comparação em tempo constante).

   **Alternativa sem backend (02/09/2026):** o super admin cunha o token na tela Instalar
   widget (`POST /api/embed/instalacao`, autenticado pela sessão dele, 1 a 90 dias) e cola
   o link pronto. Mesma assinatura, mesma validação, mesma propriedade de só restringir.
3. **O hospedeiro passa o token na URL do iframe**: `/widget?ctx=<token>`. O
   `app/widget/page.tsx` lê `?ctx=` só no cliente e o `app/home.tsx` manda esse valor no
   header **`x-embed-token`** em toda chamada de API.
4. **O servidor do painel aplica o recorte em toda rota de conversa**
   (`restricaoEfetiva`, `lib/embed.ts`): valida a assinatura HS256 (`EMBED_JWT_SECRET`) e
   a expiração, carrega o contexto **ativo** e resolve `permite(chatId)`. O resultado é a
   **interseção** com o vínculo de BU do usuário: cada camada só **restringe**, nunca
   amplia. Token adulterado, expirado ou de contexto desligado = `"invalido"` e as rotas
   respondem 401.

Por isso o token é seguro na URL: ele **não autentica** — quem entra continua entrando
com login + 2FA. Vazou token, o portador vê **menos**, nunca mais. Foi essa propriedade
que dispensou refresh curto no desenho (F1).

### O que o filtro cobre hoje

- **Só `filtro.tipo === "allowlist"`** está implementado. Qualquer outro tipo libera
  **nada** (fail-closed) — os tipos `etiqueta` e `canal` aparecem no jsonb do desenho mas
  não têm ramo de código.
- Comparação por dígitos, com as **duas variantes BR** (com e sem o nono dígito).
- **Grupo** (`chat_id` com `-group`) não entra por telefone. Entra quando foi taggeado em
  `mensageria.conversa_visibilidade` com uma entrada `tipo='contexto'` apontando para
  aquele contexto.
- Cache em memória de **60s por contexto** — mudança na allowlist pode demorar até um
  minuto para valer em toda a frota de lambdas.

### Populando a allowlist

`POST /api/embed/sync` (Bearer `CHATGURU_SYNC_SECRET`, body `{contexto}`) busca a fonte
declarada em `filtro.fonte` e substitui a allowlist. Fontes implementadas:

| `fonte.tipo` | O que faz |
| --- | --- |
| `http` (padrão) | Chama um endpoint seu com header `x-cs-secret` (valor vem de `fonte.secret_env`) e espera uma lista de telefones. |
| `conexa` | Consulta a API do Conexa direto (clientes `isActive` de `fonte.company_id`). |
| `pipedrive` | `fonte.regra`: `comercial` (deal aberto + atividade pendente dos `atividades_user_ids`) ou `financeiro` (deal ganho ou aberto em etapa de Formalização). |

Detalhes que evitam susto: `fonte.fontes[]` faz **união** de várias fontes (erro em
qualquer uma aborta o sync inteiro); `fonte.extras` é uma lista estática que sempre entra
na união; a escrita é **mark-and-sweep** (upsert refresca o timestamp, delete varre o que
ficou velho); e **fonte que devolve lista vazia não mexe na allowlist** — proteção contra
apagão acidental. Na instalação da Expert isso roda por `pg_cron` a cada 30min.

### Seletor de visão (só na tela cheia)

Na tela cheia existe um seletor que deixa o próprio usuário se auto-restringir a um
contexto (`POST /api/embed/token-proprio`, sem mint secret — token que só restringe),
governado pelo toggle `seletor_visao` em `mensageria.config`. **Dentro do widget esse
seletor não aparece**: ali o recorte é o da URL.

### Marcado como PLANO (não existe hoje)

- **Renovação automática do `?ctx=`.** O token da URL **não** é recunhado pelo widget — a
  re-cunhagem silenciosa em 401 existe só no caminho do seletor de visão (o código checa
  explicitamente `!ctxToken`). Expirou dentro de uma aba de plantão, as chamadas passam a
  dar 401 e o hospedeiro precisa recarregar o iframe com token novo. Mitigação de hoje:
  cunhar com `dias` maior (teto 90).
- **Filtros `etiqueta` e `canal`**: no desenho, sem código.
- **API de postMessage** entre host e widget (auto-resize, "abre a conversa do contato X",
  notificar contador de não lidas): não existe. O que há é a URL (`?chat=`, `?canal=`,
  `?ctx=`).

---

## 5. Extensão do Chrome — feita, provada e na loja

**[ESTADO em 03/09/2026]** A extensão existe (`extensao-chrome/`, Side Panel MV3, só a moldura do
`/widget`), foi **provada em produção** (o widget
carrega dentro da origem `chrome-extension://`, login com 2FA acontece dentro do painel lateral,
recarregar não pede login de novo) e foi **enviada à Chrome Web Store** como item não listado,
pela Expert Integrado. **ID oficial: `fnidebgjjamnnppdlcckodkiehlhagkp`**
(`lib/extensao-oficial.json`); link de instalação, válido após a aprovação:
<https://chromewebstore.google.com/detail/fnidebgjjamnnppdlcckodkiehlhagkp>.

**Para quem instala o painel (aluno/cliente): nada a configurar.** A origem da extensão oficial
entra por padrão na CSP do `/widget` (`next.config.mjs`) e aparece na tela Configurações →
Instalar widget, passo 3. Cada pessoa instala a extensão pelo link, cola o endereço do painel
da própria empresa nas Opções e entra com o próprio usuário. Detalhes e ficha da loja:
`extensao-chrome/README.md` e `extensao-chrome/LOJA.md`.

O texto abaixo é a análise de viabilidade feita ANTES de construir (02/09/2026), mantida como
registro do raciocínio — o "teste que decide" do veredito rodou e PASSOU:

Uma extensão MV3 com **Side Panel** (`side_panel.default_path` apontando para uma página
da extensão que só contém o iframe de `https://<sua-instalacao>/widget`) é **viável no
desenho**: mesmo banco, mesmo painel, mesma origem do widget — e o modo estreito da seção
1 cobre bem a largura típica do side panel (~320-500px). Exige liberar a origem
`chrome-extension://<id>` no `EMBED_FRAME_ANCESTORS` (com redeploy), e o `<id>` só é
estável se a extensão for publicada ou tiver a `key` fixada no manifesto — id de pasta
descompactada muda de máquina para máquina.

**O ponto de atenção real é storage de terceiro, não cookie.** Verificado no código: a
sessão do painel **não usa cookie** — é o cliente Supabase com
`storageKey: "expert-chat-auth"` (`lib/auth-client.ts`), ou seja `localStorage` da origem
do painel, e as rotas autenticam por `Authorization: Bearer` (`lib/auth-server.ts`). Isso
**ajuda**: a viabilidade não depende de cookie de terceiro, que é o que a maioria dos
navegadores está fechando. Mas continua depender de o iframe conseguir **ler e escrever
`localStorage` em contexto de terceiro**: com o particionamento de storage do Chrome, o
login vale por partição (loga uma vez dentro da extensão e persiste ali); já com
"bloquear cookies de terceiros" ligado, o acesso a site data em iframe cross-site é
negado e o painel não consegue guardar a sessão — vira login em loop.

**Veredito:** promissor, e o teste que decide é pequeno — extensão descompactada com a
página do side panel, id no `EMBED_FRAME_ANCESTORS`, logar, fechar o side panel, reabrir e
ver se pediu login (repetir com "bloquear cookies de terceiros" ligado). Enquanto esse
teste não rodar, tratar como hipótese, não como caminho pronto.

---

## 6. Checklist de validação

Depois de embutir, teste **nesta ordem** — cada item pressupõe o anterior:

- [ ] **O iframe carrega.** Aparece a tela de login do painel (não um retângulo branco).
      Branco = console do hospedeiro; `Refused to frame ... frame-ancestors` é seção 2.
- [ ] **O login com 2FA funciona dentro do iframe.** Email, senha e código do 2FA; a lista
      de conversas aparece.
- [ ] **Alternar / fechar / abrir não pede login de novo.** Feche e reabra o balão (ou o
      drawer) algumas vezes, troque de forma de exibição, navegue para outra rota do
      hospedeiro e volte. Pediu login = algum caminho está **desmontando** o iframe (ou
      trocando o `src`). Ver a regra de ouro na seção 3.
- [ ] **Modo estreito ativo abaixo de 768px.** Com o iframe em ~400-460px: a lista de
      conversas ocupa a largura toda, sem coluna de conversa esmagada ao lado.
- [ ] **A conversa abre com botão de voltar.** Clique numa conversa: ela ocupa o iframe
      inteiro e o cabeçalho tem a seta de voltar para a lista. Abra a ficha do contato
      (clique no nome): ela vem como painel sobreposto, com X para fechar.
- [ ] **Acima de 768px o layout de três colunas volta.** Estique o módulo em tela cheia:
      lista + conversa + ficha lado a lado.
- [ ] **O gate de acesso do hospedeiro segura.** Entre com uma conta que **não** é staff:
      a aba/rota do atendimento não deve nem aparecer.
- [ ] **Se usou `?ctx=`:** a lista mostra só as conversas do recorte, e um token
      adulterado (troque um caractere) derruba as chamadas em 401 em vez de mostrar tudo.
- [ ] **O resto do painel segue fechado.** `curl` na raiz da instalação ainda devolve
      `X-Frame-Options: DENY` e `frame-ancestors 'none'` (contraste da seção 2).
