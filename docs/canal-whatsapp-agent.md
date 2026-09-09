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

Para publicar: `vercel` na pasta (login e primeiro deploy), depois
`node scripts/instalar/agente.mjs --valendo --vercel` sobe as envs e
`--valendo --base https://SEU-PAINEL` agenda as rotinas do pg_cron. Nenhum token é digitado.

## Instalação manual (se preferir ver cada passo)

### 1. Um Supabase só (recomendado)

Instale o painel **no mesmo projeto Supabase do agent**. O painel vive no schema `mensageria`, o
agent em `public`; eles não se tocam. Rode as migrations do painel normalmente (README, passo 2).

Com um projeto só, `WA_SUPABASE_URL` e `WA_SUPABASE_SERVICE_KEY` **não precisam ser preenchidas**:
o painel usa as mesmas `MSG_SUPABASE_*`. Se o agent estiver em outro projeto, preencha as duas com
a URL e a `service_role` dele.

Ainda em **Settings → API**, acrescente `mensageria` em **Exposed schemas** (o `/setup` faz isso
sozinho; na instalação manual é gesto seu). Sem isso o painel sobe e não lê nada.

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
| Lista de conversas, grupos inclusive, com foto e "não lida"; o chat `@lid` e o do telefone da mesma pessoa aparecem como uma conversa só | SLA por conversa (`/api/relatorios/sla`) só enxerga conversas que já têm linha de estado no painel (as que alguém atendeu, etiquetou ou concluiu) |
| Relatórios: mensagens por dia e por atendente, tempo até a primeira resposta e novos atendimentos são lidos do banco do agent e somados no painel (até 20 mil mensagens por período; acima disso vem marcado `parcial`); status e satisfação vêm das linhas do painel | |
| Mensagens com texto, mídia (URL assinada de 1h do Storage do agent), áudio já transcrito pelo agent, reações, anotações internas | Pergunta com opções e template (não existem no agent) |
| Enviar **texto e mídia** (foto, vídeo, áudio, documento), com resposta citada; a mídia fica guardada no bucket `midia-mensagens` do painel e vai como URL. Responder assume a conversa e muda o status, como no canal principal | |
| Reagir a mensagem (tool `react` da mcp-api; a reação aparece no próximo carregamento, vinda do banco do agent) | |
| **Estado de atendimento**: status (aberto, atendimento, concluído, aguardando), etiquetas, ficha com campos, nota interna, transcrição, arquivar, auto-arquivar. Mora na linha do painel, criada na primeira ação (`select mensageria.criar_canal_whatsapp('agente')`, que o `/setup` roda) | |
| Pesquisa de satisfação ao concluir: a pergunta sai pela mcp-api e a nota é reconhecida quando a conversa é lida no painel | |
| Iniciar conversa com número novo pelo painel (a mcp-api cria o chat no agent) | |
| Busca por conteúdo (índice do agent); responsável por pessoa e departamento, visibilidade, escopo por papel, funis | |

Os números de mensagem dos relatórios são somados em TypeScript a partir do banco do agent
(`lib/relatorios-agente.ts`), em vez de espelhar mensagens (duas fontes de verdade) ou reescrever
as funções SQL sobre o schema do agent. Se um número passar de 20 mil mensagens no período, o
relatório vem com `parcial: true` e o próximo passo é somar no banco.

## Por que assim

Decisões de 09/09/2026 (Eric, Asafe, Victor), registradas para quem revisar:

- **Adaptador, não repasse de webhook nem substituição do agent.** Repasse no mesmo número
  vira ponto único de falha; trocar o agent pelo painel perde grupos, voice guide, transcrição
  e as tools do MCP. O adaptador lê o banco do agent e deixa o agent como único receptor.
- **Envio pela mcp-api, não pela Z-API direto.** A mcp-api aplica voice gate, trava de
  instância e log. Z-API direto seria mais simples e furaria as três.
- **Um Supabase só.** O painel vive no schema `mensageria`, o agent em `public`. Sem colisão,
  e o aluno não cria projeto novo.
- **Estado no par de tabelas do canal, sem migration nova.** O canal do agent ganha
  `conversas_agente`/`mensagens_agente` como qualquer canal extra (função da 0007). A linha nasce
  na primeira ação do atendente, porque o agent não manda webhook para o painel. O Instagram
  segue somente leitura (`semEstadoNoPainel`).
- **@lid.** O agent guarda parte do tráfego de um contato num chat `@lid` e parte no chat do
  telefone (`lid_mapping` casa os dois). O painel funde os dois numa conversa só, com o
  telefone como id (é para ele que o envio vai; a mcp-api resolve o `@lid` sozinha), e as
  mensagens dos dois chats saem juntas em ordem de tempo.

## Atualizar

```bash
git pull
node scripts/instalar/agente.mjs --valendo
```

Idempotente: aplica só a migration que falta, cria o par de tabelas de canal novo, garante os
buckets e não sobrescreve nenhuma chave do `.env.local`. Reinicie o `npm run dev`; na Vercel,
`--valendo --vercel` sobe as envs e `vercel --prod` publica.

Depois de uma atualização que traga recurso novo no canal do agent (etiqueta, ficha, nota,
concluir), a primeira ação do atendente cria a linha de estado daquela conversa. Se a ação
responder **503 pedindo `criar_canal_whatsapp`**, é porque o passo das tabelas do canal não
rodou: repita o comando acima.

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
- **O time cai numa tela de login da Vercel, não do painel**: é a Deployment Protection, ligada
  por padrão em projeto novo. Settings → Deployment Protection → desligar "Require Log In".
- **400 "etiqueta fora do catálogo" na primeira etiquetagem**: não é do canal do agent. O
  catálogo de etiquetas nasce vazio; o super admin cria as etiquetas em Configurações →
  Etiquetas (catálogo único) antes de alguém etiquetar.
- **Instalador diz que achou o agent mas não tem `.env`**: o agent roda na VPS ou é um clone novo.
  Crie o `.env` na pasta dele com só duas linhas, `SUPABASE_PROJECT_REF` e `SUPABASE_ACCESS_TOKEN`
  (o PAT, em Account → Access Tokens). A chave do banco o instalador pega do próprio projeto.
- **Projeto migrado para as chaves novas (`sb_secret_`)**: funciona, inclusive para criar o
  primeiro admin (medido). Se a credencial for recusada pelo Auth (uma `service_role` legada
  desabilitada, por exemplo), o instalador avisa e o gesto vira criar o usuário no dashboard
  (Authentication → Users) e rodar o comando de novo, que promove por SQL.
- **Não monte o `.env` a partir de `/v1/projects/{ref}/secrets` da Management API**: ela devolve os
  valores **hasheados**, não as chaves. O arquivo fica com cara certa e falha com 401 depois.
  Chave de API real só em `api-keys?reveal=true` ou no dashboard; secret de edge function é
  só-escrita.
