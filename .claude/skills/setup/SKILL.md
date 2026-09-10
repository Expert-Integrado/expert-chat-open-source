---
name: setup
description: Instala o Expert Chat em cima do WhatsApp Agent que a pessoa já tem, em conversa, com um comando. Use quando o usuário abrir esta pasta e disser "setup", "instala o painel", "roda o setup", "quero o Expert Chat no meu agent", ou "continua o setup". Não use para instalação em cliente sem o agent (README, passo a passo).
---

# /setup — o painel em cima do seu WhatsApp Agent

Você conduz a instalação. Quem faz o trabalho é `scripts/instalar/agente.mjs`: ele lê o
`.env` que o setup do agent deixou (projeto, PAT, service_role), pega a chave anon pela
Management API, aplica as migrations do painel no MESMO projeto Supabase (schema `mensageria`,
separado do `public` do agent), escreve o `.env.local` e cria o primeiro administrador.
Nenhum segredo passa pelo chat: o script não imprime valor nenhum, e senha e chave são
digitadas no terminal do usuário, ocultas.

## Regras

1. **Nunca peça, cole ou ecoe segredo no chat.** O script acha o que precisa; o que ele não
   acha (a `MCP_API_KEY`, às vezes) o usuário digita no terminal dele, com o prefixo `!`.
2. **Conferência antes de aplicar.** Rode sem `--valendo` primeiro e leia o plano com o usuário.
3. **Nada de migration à mão.** Se o script reclamar de algo no banco, mostre o erro e pare;
   não vá ao SQL Editor por conta própria.
4. Fale curto, em português, um passo por vez.

## Passos

### 0. Pré-requisitos (30 segundos)

```bash
node --version      # precisa ser 22.6 ou mais novo
npm install
```

Node velho: mande instalar pelo site do Node ou `nvm install 22`, e volte.

### 1. Achar o agent e conferir o plano

```bash
node scripts/instalar/agente.mjs
```

O script procura a pasta do agent ao lado desta (`../whatsapp-agent`) e na home. Se não
achar, pergunte ao usuário onde está e rode com `--agente <caminho>`.

Leia a saída para ele em uma frase por linha: projeto encontrado, quantas migrations vão
rodar, quais chaves vão pro `.env.local`. Se a linha 3 disser que não achou a `MCP_API_KEY`,
avise que o passo 2 vai pedir.

### 2. Aplicar (o usuário roda, para a senha não passar por você)

Peça ao usuário para digitar no prompt, com o prefixo `!`, trocando o e-mail:

```
! node scripts/instalar/agente.mjs --valendo --admin-email voce@empresa.com
```

O terminal vai pedir a senha do admin (e a `MCP_API_KEY`, se não foi achada), sem mostrar
na tela. Quando terminar, a saída volta para a conversa. Se falhou em uma migration, mostre
a mensagem do Postgres e pare.

### 3. Subir e provar

```bash
npm run dev
```

Peça para abrir http://localhost:3000, entrar com o e-mail e a senha, e escolher
**Meu WhatsApp** no seletor de canal. A lista tem que mostrar as conversas do agent.
Depois: responder uma conversa pelo painel e conferir no celular que a mensagem saiu com
`*Nome:*` na frente.

Se a lista vier vazia: `node scripts/instalar/agente.mjs` de novo e olhe a linha 3 (chave) e
a linha 5 (`CANAIS_EXTRA`). Dois números no agent? `--conta <alias>` escolhe qual.

### 4. Publicar (opcional, mas é o que deixa o painel no ar)

1. `vercel` na pasta: faz login (no navegador do usuário) e o primeiro deploy, e linka a pasta.
2. Envs do `.env.local` no projeto: `node scripts/instalar/agente.mjs --valendo --vercel`
   (usa o login da CLI; não pede token). Depois `vercel --prod` para o build pegar as envs.
3. **Desligue a proteção de acesso da Vercel** (Settings → Deployment Protection → desligar
   "Require Log In"), senão só quem tem conta no time abre o painel e o time inteiro cai na tela
   de login da Vercel. Avise o usuário: é um passo no navegador, ninguém faz por ele.
4. Rotinas do painel (agendadas, SLA, alertas), apontando para a URL publicada:
   `node scripts/instalar/agente.mjs --valendo --base https://SEU-PAINEL.vercel.app`
   Ele desagenda e agenda cada job no pg_cron; o bearer é lido de dentro do banco.

Confira no fim: `node scripts/instalar/index.mjs --base https://SEU-PAINEL` faz o smoke test.
Para testar local, nada disso é necessário.

## Já instalado, quer só atualizar

Se a pasta já tem `.env.local` e o painel já rodou, o pedido é atualização, não instalação:
`git pull`, depois `node scripts/instalar/agente.mjs --valendo` (idempotente: completa o que
falta, não sobrescreve chave nenhuma), e reiniciar o `npm run dev`. Na Vercel, `--valendo
--vercel` e `vercel --prod`. O README tem a seção "Atualizar uma instalação que já existe".

## O que ainda não faz (diga, se perguntarem)

Pergunta com opções e template (não existem no agent). O relatório de SLA por conversa só
enxerga conversas que já têm linha de estado no painel (as que alguém atendeu, etiquetou ou
concluiu). Mídia, reação, etiqueta, ficha, nota interna, transcrição, concluir, iniciar
conversa, pesquisa de satisfação e relatórios já funcionam. A tabela completa está em
`docs/canal-whatsapp-agent.md`.
