# Expert Chat como tela do WhatsApp Agent

> Você já tem o [WhatsApp Agent](https://github.com/Expert-Integrado/whatsapp-agent) instalado
> e quer o painel de atendimento em cima **do mesmo número**, sem reinstalar nada e sem trocar o
> webhook. É isso que a fonte `whatsapp-agent` faz.

## O que acontece por baixo

- O painel **lê** as conversas e mensagens direto do banco do agent (`chats`, `messages`,
  `message_media`, `wa_instance`). Nenhuma tabela nova, nenhuma migration no agent.
- O painel **envia** pela `mcp-api` do agent, a mesma porta que o Claude usa. Isso significa que
  as travas do agent valem também para o atendente: voice guide em modo bloqueio recusa o texto,
  trava de instância impede mandar pelo número errado, e tudo fica no log do agent.
- O agent continua sendo o **único** que recebe o webhook do provedor. Zero conflito.
- O atendente que respondeu vai na assinatura `*Nome:*` da mensagem, e o painel lê isso de
  volta para mostrar quem atendeu.

## Instalação automática (recomendada)

Abra a pasta do repo no Claude Code e diga **`/setup`**. A skill conduz tudo: acha o `.env` do
seu agent, aplica as migrations do painel no mesmo projeto Supabase, escreve o `.env.local`
com o canal já declarado e cria o primeiro administrador. Sem Claude Code, o mesmo script
direto:

```bash
npm install
node scripts/instalar/agente.mjs                                             # confere, não muda nada
node scripts/instalar/agente.mjs --valendo --admin-email voce@empresa.com    # aplica; pede a senha no terminal
npm run dev
```

Se o script não achar a pasta do agent, `--agente <caminho>`. Se não achar a `MCP_API_KEY`,
ele pergunta no terminal (ou `--mcp-key <valor>`). Dois números no agent: `--conta <alias>`.

## Instalação manual (se preferir ver cada passo)

### 1. Um Supabase só (recomendado)

Instale o painel **no mesmo projeto Supabase do agent**. O painel vive no schema `mensageria`, o
agent em `public`; eles não se tocam. Rode as migrations do painel normalmente (README, passo 2).

Com um projeto só, `WA_SUPABASE_URL` e `WA_SUPABASE_SERVICE_KEY` **não precisam ser preenchidas**:
o painel usa as mesmas `MSG_SUPABASE_*`. Se o agent estiver em outro projeto, preencha as duas com
a URL e a `service_role` dele.

### 2. Variáveis

| Variável | O que é | Obrigatória? |
|---|---|---|
| `WA_MCP_URL` | `https://<ref>.supabase.co/functions/v1/mcp-api` do agent | para enviar. Sem ela o canal é só leitura |
| `WA_MCP_KEY` | a `MCP_API_KEY` do agent (ou a `MCP_API_KEY_LOCKED`, se quiser o painel preso a um número) | para enviar |
| `WA_SUPABASE_URL` | URL do projeto do agent | só se for outro projeto |
| `WA_SUPABASE_SERVICE_KEY` | `service_role` do projeto do agent. **Nunca vai pro navegador** | só se for outro projeto |

### 3. Declare o canal

Em `CANAIS_EXTRA` (JSON), um canal por número do agent:

```json
[{"id":"agente","tipo":"whatsapp","dono":"pessoal","rotulo":"Meu WhatsApp","fonte":"whatsapp-agent","conta":"profissional","ativo":true}]
```

- `conta` é o **alias** ou o `instance_id` da instância no agent (a mesma palavra que você usa
  no parâmetro `instance` das tools). Sem `conta`, vale a instância **default** do agent.
- `id` é o nome interno do canal no painel (letras minúsculas, sem espaço). Responsáveis,
  visibilidade e departamentos ficam guardados por esse `id`.
- Tem dois números no agent? Dois canais, um `conta` cada.

Faça um build novo (variável só entra em build novo) e o canal aparece no seletor.

## O que funciona e o que ainda não

| Funciona | Ainda não (v1) |
|---|---|
| Lista de conversas, grupos inclusive, com foto e "não lida"; o chat `@lid` e o do telefone da mesma pessoa aparecem como uma conversa só | Etiqueta, ficha editável, nota interna, concluir conversa: 403 "somente leitura", porque a linha da conversa não existe no banco do painel |
| Mensagens com texto, mídia (URL assinada de 1h do Storage do agent), áudio já transcrito pelo agent, reações | Pesquisa de satisfação, SLA e relatório de atendimento ficam parciais (o agent não gera esses eventos) |
| Enviar **texto e mídia** (foto, vídeo, áudio, documento), com resposta citada; a mídia fica guardada no bucket `midia-mensagens` do painel e vai como URL | Iniciar conversa com número novo pelo painel |
| Reagir a mensagem (tool `react` da mcp-api; a reação aparece no próximo carregamento, vinda do banco do agent) | Pergunta com opções e template (não existem no agent) |
| Busca por conteúdo (índice do agent); responsável por pessoa e departamento, visibilidade, escopo por papel, funis | |

Cada item da direita entra depois sem mexer no que já está: etiqueta/nota/status pedem uma
tabela de estado no painel chaveada por canal e `chat_id` (migration aditiva).

## Por que assim

Decisões de 09/09/2026 (Eric, Asafe, Victor), registradas para quem revisar:

- **Adaptador, não repasse de webhook nem substituição do agent.** Repasse no mesmo número
  vira ponto único de falha; trocar o agent pelo painel perde grupos, voice guide, transcrição
  e as tools do MCP. O adaptador lê o banco do agent e deixa o agent como único receptor.
- **Envio pela mcp-api, não pela Z-API direto.** A mcp-api aplica voice gate, trava de
  instância e log. Z-API direto seria mais simples e furaria as três.
- **Um Supabase só.** O painel vive no schema `mensageria`, o agent em `public`. Sem colisão,
  e o aluno não cria projeto novo.
- **Fonte externa = sem linha de conversa no painel.** Por isso etiqueta, nota, status e ficha
  ficam 403 nesta versão: precisam de uma tabela de estado chaveada por canal e `chat_id`
  (migration aditiva), que entra na v2.
- **@lid.** O agent guarda parte do tráfego de um contato num chat `@lid` e parte no chat do
  telefone (`lid_mapping` casa os dois). O painel funde os dois numa conversa só, com o
  telefone como id (é para ele que o envio vai; a mcp-api resolve o `@lid` sozinha), e as
  mensagens dos dois chats saem juntas em ordem de tempo.

## Quando algo não aparece

- **Canal não está no seletor**: falta `WA_SUPABASE_*` (ou `MSG_SUPABASE_*`) ou `ativo` não é
  `true` em `CANAIS_EXTRA`.
- **Canal aparece, lista vazia**: `conta` não casa com nenhuma instância ativa do agent. Confira
  o alias em `wa_instance` (`select instance_id, alias, is_default, is_active from wa_instance`).
- **"envio nao configurado pra este canal"**: falta `WA_MCP_URL` ou `WA_MCP_KEY`.
- **403 "texto recusado pelo voice guide"**: é o agent barrando, de propósito. A resposta traz as
  violações. Ajuste o texto ou o voice guide da instância.
- **502 "a mcp-api do agente recusou a credencial"**: `WA_MCP_KEY` diferente da `MCP_API_KEY`
  configurada nos secrets da edge function do agent.
- **Instalador diz que achou o agent mas não tem `.env`**: o agent roda na VPS ou é um clone novo.
  Crie o `.env` na pasta dele com `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN` e a chave do
  banco (`SUPABASE_SECRET_KEY`, ou a legada `SUPABASE_SERVICE_ROLE_KEY`).
- **Projeto migrado para as chaves novas (`sb_secret_`)**: o banco e o Storage funcionam com ela;
  só o passo de criar o primeiro admin exige JWT. O instalador avisa e o gesto vira criar o
  usuário no dashboard (Authentication → Users) e rodar o comando de novo, que promove por SQL.
- **Não monte o `.env` a partir de `/v1/projects/{ref}/secrets` da Management API**: ela devolve os
  valores **hasheados**, não as chaves. O arquivo fica com cara certa e falha com 401 depois.
  Chave de API real só em `api-keys?reveal=true` ou no dashboard; secret de edge function é
  só-escrita.
