# Expert Chat

Painel de atendimento de WhatsApp **multiatendente e open source**: a caixa de entrada
compartilhada da sua empresa, com permissões, departamentos, respostas rápidas, agendamento,
automação e relatórios — rodando no **seu** número, no **seu** banco e na **sua** conta de
hospedagem. Sem mensalidade de plataforma.

Criado por **Eric Luciano** na **Mentoria Automações Inteligentes** (Expert Integrado).

**Uma instalação por empresa.** Isto não é multi-tenant e não pretende ser: cada empresa tem
o seu banco, o seu deploy e as suas variáveis. Ninguém hospeda o seu atendimento além de você.

## Já tem o WhatsApp Agent?

O painel roda em cima dele, no mesmo Supabase, sem reinstalar nada: abra a pasta no Claude
Code e diga `/setup`, ou rode `node scripts/instalar/agente.mjs`. Detalhes em
`docs/canal-whatsapp-agent.md`.

## Como obter

```bash
git clone https://github.com/Expert-Integrado/expert-chat-open-source.git
cd expert-chat-open-source
npm install
```

## Avisos desta versão (1.1.0, publicada em 10/09/2026)

Esta é a **mesma versão que roda na Expert Integrado**, aberta às pressas para a sprint da
mentoria. Leia antes de instalar:

- **Módulo de automação (fluxos) e disparo em massa nascem desligados e a automação está em
  versão instável.** Não ligue o módulo de automação até sair uma versão marcada como estável.
- **Importador de outra ferramenta** (`scripts/importar/`) e **canal de Instagram**: existem no
  código, mas ficam fora do suporte desta versão. O código ainda cita a ferramenta antiga em
  nome de arquivo e de variável (ex.: `CHATGURU_SYNC_SECRET`, que é só o nome da senha das
  rotinas — você **não** precisa de conta em lugar nenhum para usá-la).
- **A documentação interna do time não veio** (histórico de decisões, planos de sprint,
  benchmarks). O que está em `docs/` é o que serve para instalar e operar.
- Encontrou algo que não devia estar aqui, ou que quebra na sua instalação? Abra uma issue.

## O que ele faz

- Conversas em tempo real: texto, áudio gravado no próprio painel, foto, vídeo, documento, figurinha
- Vários atendentes no mesmo número, com responsável por **pessoa e por departamento**
- **Distribuição automática** da conversa nova (rodízio entre quem está online, com teto opcional)
- **Permissões por escopo**: cada pessoa vê tudo, só o departamento dela, ou só o que é dela
- Etiquetas e **ficha do contato com campos personalizados**, com catálogos que o admin controla
- **Anotações internas** com @menção e notificação
- **Respostas rápidas** (digite `/` no campo de mensagem) e **agendamento de mensagem**
- **Horário de atendimento** com saudação e mensagem de ausência automáticas
- **Pesquisa de satisfação** ao concluir (nota 1 a 5, respondida no próprio WhatsApp)
- **Relatórios**: conversas por status, mensagens por dia e por atendente, tempo até a primeira
  resposta, média de satisfação
- **Busca pelo conteúdo** das mensagens
- **Automação de conversa** (fluxos com condições e intenções) e **disparo em massa** — módulos
  que nascem desligados, você liga se quiser
- Segurança: **2FA** (opcionalmente obrigatória para todos), desligamento por inatividade,
  revogação de dispositivo, janela de horário por pessoa, assinatura do atendente

---

## Antes de começar: o que isso vai custar

| O que | Precisa? | Dá pra começar de graça? | Quando começa a custar |
|---|---|---|---|
| **Supabase** (banco + login) | sim | **sim** | O projeto gratuito **hiberna depois de 7 dias sem uso** — e painel de atendimento hibernado é mensagem perdida. Para uso de verdade, o plano pago. |
| **Hospedagem** (Vercel ou VPS) | sim | **sim, pra testar** | O plano gratuito da Vercel **não permite uso comercial**. Atendendo cliente de verdade: plano pago, ou uma VPS sua (é um app Next, roda em qualquer lugar). |
| **Provedor de WhatsApp** | **sim, sem escapatória** | não existe grátis | É a única despesa inevitável. Três caminhos abaixo. |
| **Node.js 22.6 ou mais novo** | sim, na sua máquina | grátis | — |
| Domínio próprio | não | — | Dá pra usar o endereço que a hospedagem fornece |

### Os três caminhos de WhatsApp

Escolha um. O painel suporta os três, e a diferença é bolso contra esforço:

1. **Evolution API — o mais barato.** É software livre que **você mesmo hospeda**. Não tem
   fornecedor no meio: você paga só a VPS onde ele roda. É também o caminho mais didático, se
   você quiser entender a peça inteira.
2. **Z-API — o de menor esforço.** É o que o canal principal usa por padrão. Você conecta seu
   número lendo um QR code, como no WhatsApp Web. É serviço pago, e a conexão não é oficial da
   Meta (existe risco de bloqueio do número, como em qualquer solução por QR code).
3. **Gupshup — API Oficial (WABA).** A rota oficial da Meta, sem risco de bloqueio. Em troca:
   número dedicado, aprovação de template pra cada mensagem que você inicia, e custo por
   conversa (o da Meta mais o do parceiro).

> **Preço:** não colocamos valor aqui de propósito — preço de terceiro muda. Confira no site de
> cada um antes de decidir.

---

## Instalação, na ordem em que ela quebra se você pular

> Tem um **conferidor** no repo que lê a sua instalação e diz o que falta, sem mudar nada.
> Guarde este comando, você vai usar em quase todo passo:
>
> ```bash
> node scripts/instalar/index.mjs
> ```
>
> Ele **não** aplica nada por conta própria (a única exceção é criar variáveis na Vercel, e só
> se você pedir com `--valendo`). Modo conferência é o padrão.
>
> Se quiser o detalhe de cada decisão dele, `docs/instalacao.md` explica tudo.

### 1. Crie o projeto no Supabase

Em supabase.com, crie um projeto novo. Depois, em **Settings → API**, guarde duas coisas:

- a **URL** do projeto
- a chave **`service_role`**

**A `service_role` é a chave-mestra do seu banco.** Ela ignora todas as permissões. Guarde no
seu gerenciador de senhas e não deixe ela chegar ao navegador, a um print, a um repositório ou
a uma mensagem — nem pra você mesmo depois.

Ainda em **Settings → API**, no campo **Exposed schemas**, acrescente **`mensageria`** à lista
(sem tirar `public`). O painel inteiro fala com o banco por esse schema; sem isso ele sobe e
não lê nada. Isso não abre dado nenhum: em `mensageria` só a `service_role` tem permissão.

Depois, vá em **Database → Extensions** e habilite **`pg_cron`** e **`pg_net`**.
Sem elas as rotinas automáticas (agendamento, automação, alertas) não têm como rodar. As duas
existem no plano gratuito.

### 2. Crie as tabelas: as 25 migrations, em ordem

Abra o **SQL Editor** do Supabase e cole o conteúdo dos arquivos de `supabase/migrations/`,
**um por vez, na ordem numérica, sem pular nenhum**:

```
0001_schema_completo.sql          0014_relatorio_fuso.sql
0002_embed.sql                    0015_fluxo_pastas.sql
0003_perfil_contextos.sql         0016_conversa_contexto.sql
0004_visibilidade_auto_arquivar.sql   0017_tela_conversa.sql
0005_api_keys.sql                 0018_fluxo_fila.sql
0006_status_autor.sql             0019_seguranca_conta.sql
0007_canal_whatsapp_extra.sql     0020_respostas_rapidas_origem.sql
0008_fluxos.sql                   0021_fila_atendimento.sql
0009_funis.sql                    0022_intencoes.sql
0010_papeis.sql                   0023_canais_conexao_templates.sql
0011_perfil_preferencias.sql      0024_anexos_biblioteca.sql
0012_disparo.sql                  0025_campos_ficha.sql
0013_relatorios.sql
```

**Três coisas que valem saber antes de começar:**

- **Rodar a 0001 e parar não instala o painel.** Ela é 338 linhas de um total de 4.077. As
  outras 24 trazem chaves de API, papéis, automação, disparo, relatórios, segurança de conta,
  fila e campos de ficha. Migration que falta se manifesta como tela que não abre ou recurso
  que "não existe", nunca como um erro claro.
- **O código do painel nunca cria tabela.** É regra do projeto, não limitação: aplicar DDL é
  gesto humano, com alguém lendo a saída. É também por isso que o conferidor não roda as
  migrations por você — ele só te diz quais faltam.
- **Migration aplicada pela metade é o pior estado possível**, porque o painel degrada com
  aviso discreto e você acha que instalou. Cada arquivo tem uma explicação no topo dizendo o
  que muda e o que continua funcionando sem ele — vale ler.

Terminou? Rode o conferidor. Ele lê o banco e responde quais migrations estão aplicadas, quais
faltam, e quais estão **pela metade**:

```bash
node scripts/instalar/index.mjs
```

Algumas migrations que só criam função aparecem como *não verificável* — checar função exigiria
executá-la, e ninguém executa função de relatório no banco de outra pessoa por curiosidade.
Essas ficam pra conferência manual.

### 3. Configure as variáveis de ambiente

Local: um arquivo `.env.local` na raiz do repo (já está no `.gitignore`, não vai pro Git). Em
produção: no painel da sua hospedagem.

**Obrigatórias — sem elas o painel não sobe, não autentica ou não recebe mensagem:**

| Variável | O que é |
|---|---|
| `MSG_SUPABASE_URL` | URL do projeto Supabase que guarda as conversas |
| `MSG_SUPABASE_SERVICE_KEY` | a `service_role` do mesmo projeto. **Nunca vai pro navegador** |
| `NEXT_PUBLIC_AUTH_URL` | URL do Supabase que faz o login. Pode ser o mesmo projeto |
| `NEXT_PUBLIC_AUTH_ANON_KEY` | chave `anon` do projeto de login. Pública por natureza |
| `WEBHOOK_KEY` | chave longa e aleatória que protege o webhook de entrada. Sem ela o painel não recebe mensagem |
| `CHATGURU_SYNC_SECRET` | chave longa e aleatória que autentica **todas** as rotinas automáticas. Sem ela nenhuma roda |

> O nome `CHATGURU_SYNC_SECRET` é herança da ferramenta que este painel substituiu. Não tem
> relação com o ChatGuru: é só o nome da senha das rotinas internas. Gere um valor aleatório
> longo, como faria com qualquer senha.

**Do seu número de WhatsApp** — preencha o bloco do provedor que você escolheu:

| Provedor | Variáveis |
|---|---|
| Z-API | `CENTRAL_ZAPI_INSTANCE_ID`, `CENTRAL_ZAPI_TOKEN`, `CENTRAL_ZAPI_CLIENT_TOKEN` |
| Gupshup (API Oficial) | `GUPSHUP_APIOFICIAL_API_KEY`, `GUPSHUP_APIOFICIAL_SOURCE_NUMBER` |
| Evolution (auto-hospedado) | `EVOLUTION_<ID>_BASE_URL`, `EVOLUTION_<ID>_INSTANCE_ID`, `EVOLUTION_<ID>_API_KEY` |

**Opcionais — cada uma liga um recurso ou troca um padrão:**

| Variável | O que faz | Sem ela |
|---|---|---|
| `MODULOS` | liga automação, disparo e fila. JSON, ex. `{"automacao":true,"disparo":true}` | **tudo desligado** (ver "Ligando os módulos" abaixo) |
| `FUSO_INSTALACAO` | fuso dos relatórios e das janelas de horário, ex. `America/Sao_Paulo` | cai no padrão do código |
| `NEXT_PUBLIC_NOME_PAINEL` | o nome que aparece na tela e na aba do navegador | "Central de Atendimento" |
| `NEXT_PUBLIC_SUBTITULO` | a linha abaixo do nome | "WhatsApp da empresa" |
| `NEXT_PUBLIC_DICA_LOGIN` | a frase da tela de login | frase genérica |
| `NEXT_PUBLIC_ROTULO_CANAL` | nome curto do canal principal no seletor | "Principal" |
| `CANAL_CENTRAL_IDENTIDADE` | seu número, só pra exibição na tela | fica em branco |
| `MSG_STORAGE_BUCKET` | bucket do Supabase Storage onde a mídia é guardada | `midia-mensagens` |
| `CANAIS_EXTRA` | JSON com canais além do principal (segundo número etc.) | só o canal principal |
| `WA_MCP_URL`, `WA_MCP_KEY` | o painel como tela do seu **WhatsApp Agent**: lê o banco dele e envia pela `mcp-api` (ver `docs/canal-whatsapp-agent.md`) | canal do agent só leitura |
| `TELEGRAM_BOT_TOKEN` | manda os alertas de canal caído e de SLA pro seu Telegram | alerta desligado, com aviso na tela |
| `VIGIA_ALERTAS` | destino dos alertas, se você não configurar pela tela | usa o que está na tela |
| `PIPEDRIVE_API_TOKEN` | permite usar filtro do Pipedrive como público de disparo | a opção some da tela de disparo |
| `EMBED_JWT_SECRET`, `EMBED_MINT_SECRET`, `EMBED_FRAME_ANCESTORS` | só se você for embutir o painel dentro de outro sistema | o widget fica fechado |

Um detalhe que não dá erro legível quando acontece: **variável com espaço nas pontas falha na
autenticação e não avisa em lugar nenhum.** O conferidor trata isso como grave até em variável
opcional. Ele também nunca imprime valor de segredo — mostra só `(N caracteres, não exibido)`.

Rode o conferidor de novo: o passo das variáveis lista todas, com o que quebra sem cada uma.

### 4. Publique

```bash
npm install
npm run build     # confere que compila antes de subir
```

E publique na sua hospedagem. Na Vercel:

```bash
npx vercel deploy --prod
```

**Variável nova não alcança um deploy que já está no ar.** A Vercel injeta as variáveis no
momento do build — sempre que você criar ou mudar uma, faça um deploy novo. Isso responde a
maioria dos "configurei e não mudou nada".

**Na Vercel, desligue a proteção de acesso — senão nenhum atendente entra.** Projeto novo nasce
com **Deployment Protection** ligada, e ela exige conta na Vercel para abrir qualquer endereço
`*.vercel.app`. O painel sobe, responde normalmente para você, e todo mundo do time cai numa tela
de login da Vercel. O sintoma engana: parece problema de autenticação do painel, mas é um
redirect para `vercel.com/login` antes de a sua aplicação ser chamada.

Em **Settings → Deployment Protection**, desligue **Require Log In** (as opções do menu —
"Standard Protection" e "All Deployments" — não resolvem: a primeira só libera domínio
personalizado de produção, e instalação nova não tem nenhum).

A configuração melhor, se você já tem domínio: aponte um subdomínio seu para o projeto e
mantenha a proteção ligada. Aí os previews continuam fechados e só a produção fica aberta —
com o login do painel, que é quem deve barrar.

Para rodar na sua máquina antes de publicar: `npm run dev`, e abra http://localhost:3000.

### 5. A senha das rotinas, dentro do banco

As rotinas automáticas (alertas, disparo, agendadas, automação, SLA) rodam **de dentro do
Supabase** e chamam o seu painel pela rede. Elas precisam da mesma
`CHATGURU_SYNC_SECRET` — e leem esse valor **do próprio banco**, não do código.

No SQL Editor, uma vez:

```sql
insert into mensageria.config (chave, valor)
values ('tick_bearer', to_jsonb('COLE_AQUI_O_SEGREDO'::text))
on conflict (chave) do update set valor = excluded.valor, updated_at = now();
```

Por que assim, e não digitado direto no agendamento: o `cron.schedule` guarda o comando em
**texto** no catálogo do banco. Senha digitada ali fica gravada pra sempre. E senha errada num
agendamento dá erro 401 em silêncio — ninguém lê o retorno de uma rotina automática. Lendo do
banco, a rotina falha **antes** de chamar o painel, e o conferidor te mostra que o valor não
está lá.

### 6. Agende as rotinas

O conferidor imprime o SQL pronto de cada rotina que **a sua** instalação precisa — rotina de
módulo desligado não entra na lista, porque rodaria pra nada:

```bash
node scripts/instalar/index.mjs --base https://SEU-PAINEL
```

As rotinas são estas:

| Rotina | Frequência | Sem ela |
|---|---|---|
| `expert_chat_vigia` | a cada 10 min | ninguém é avisado quando um canal cai |
| `expert_chat_tick_agendadas` | a cada 1 min | mensagem agendada nunca é enviada |
| `expert_chat_tick_sla` | a cada 15 min | alerta de SLA nunca dispara |
| `expert_chat_tick_disparo` | a cada 1 min | campanha criada nunca sai da fila *(módulo disparo)* |
| `expert_chat_tick_fluxos` | a cada 1 min | fluxo enfileirado nunca executa *(módulo automação)* |

Cole no SQL Editor e confira em `cron.job_run_details` que a primeira execução voltou
`succeeded`.

### 7. Crie o primeiro administrador

Duas metades, e a primeira é no painel do Supabase porque criar usuário exige a Admin API do
Auth.

**a)** No Supabase, **Authentication → Users → Add user**: e-mail e senha. Copie o **UUID** que
aparece na lista.

**b)** No SQL Editor, promova esse usuário:

```sql
insert into mensageria.perfis (user_id, papel, escopo_visao)
values ('UUID_DO_USUARIO', 'super_admin', 'todas')
on conflict (user_id) do update set papel = 'super_admin', escopo_visao = 'todas';
```

Sem o passo (b) o login funciona e o painel abre vazio — o usuário existe, mas não tem perfil.

**Uma nota que importa se você usa outros sistemas no mesmo Supabase:** trocar a senha pelo
painel vale para **todos** os aplicativos que compartilham aquele projeto de autenticação. Numa
instalação nova, esse conjunto é só o seu — mas se você apontar `NEXT_PUBLIC_AUTH_URL` para um
Supabase que já atende outro sistema seu, saiba que a senha é a mesma nos dois.

### 8. Primeiro login e 2FA

Entre com o e-mail e a senha que você criou. Em **Configurações** você encontra, entre outras
coisas:

- **2FA**: cada pessoa cadastra o segundo fator no perfil dela. Ligando `exigir_2fa`, **ninguém
  entra sem segundo fator** — quem ainda não cadastrou cai na tela de cadastro em vez de ser
  barrado, então ligar isso não tranca você fora.
- **Desligamento por inatividade** (`auto_logout_minutos`, padrão desligado)
- **Horário de atendimento** com saudação e ausência (padrão: seg a sex, 09:00 às 18:00, com as
  mensagens em branco — em branco não envia nada)
- **Pesquisa de satisfação** (padrão desligada)
- **Distribuição automática** de conversa nova (padrão desligada)
- **Alertas** de canal caído e de SLA, com destino no Telegram

### 9. Conecte o seu número

Esta é a parte que nenhum instalador faz por você, e o motivo é que apontar o webhook do
número de uma empresa é gesto com consequência: errar entrega a mensagem no painel errado.

**a) Conecte a instância no provedor.** No painel da Z-API, do Gupshup ou no seu Evolution,
crie a instância e conecte o número. Na Z-API e no Evolution isso significa **ler um QR code**
com o celular, como no WhatsApp Web. Copie as credenciais para as variáveis do passo 3, e faça
um deploy novo.

**b) Aponte o webhook de entrada** do provedor para o seu painel:

```
https://SEU-PAINEL/api/webhook?key=SUA_WEBHOOK_KEY
```

Na Z-API, configure em "Ao receber" e também em "Status da mensagem" (é o que faz o visto de
entregue e lido aparecer).

Se você tiver mais de um canal, o endereço leva o **id** do canal:

```
https://SEU-PAINEL/api/webhook?key=SUA_WEBHOOK_KEY&canal=ID-DO-CANAL
```

O id tem que ser exato. Errar o id entrega a mensagem no canal errado, e o painel responderia
pelo número errado.

Testando na sua máquina? O provedor precisa alcançar você de fora: use um túnel (`ngrok`,
`cloudflared`) no lugar do domínio.

**c) Prove a ida e a volta com mensagem de verdade.** Mande uma mensagem de um celular e veja a
conversa aparecer no painel; responda pelo painel e veja chegar no celular.

Este passo não é formalidade. O teste automático do conferidor (passo 10) prova que as rotas
**recusam** quem chega sem credencial — ele não prova que o seu provedor está entregando
mensagem. Só a mensagem real prova isso.

### 10. Confira o resultado

```bash
node scripts/instalar/index.mjs --base https://SEU-PAINEL --log instalacao.md
```

O teste não comemora "respondeu 200": rota protegida respondendo 200 **sem login** é
vazamento, e o relatório manda parar a instalação. Ele confere que a raiz sobe e que conversas,
exportação, administração, rotinas e webhook **recusam** quem chega sem credencial.

O `--log` grava tudo num arquivo — guarde, é a foto de como a instalação estava no dia.

---

## Ligando os módulos

Três recursos grandes nascem **desligados**, de propósito: a instalação começa simples e você
liga o que for usar.

| Módulo | O que liga |
|---|---|
| `automacao` | fluxos de conversa automática, com condições e intenções — **em validação, não recomendado ligar ainda** |
| `disparo` | campanhas de mensagem em massa |
| `fila_atendimento` | entrar, sair e pular a vez numa fila de atendimento |

> **Aviso sobre `automacao` (09/09/2026):** este módulo ainda não foi validado em operação
> real e não é uma versão estável. A recomendação da Expert Integrado é **não ligar** em
> uma instalação nova até sair uma versão marcada como estável. Quem ligar mesmo assim deve
> usar só em teste, nunca no atendimento de verdade. O painel repete este aviso em
> Configurações > Regras automáticas e no topo da tela de Automação.

Por variável de ambiente (o padrão de quem instala):

```
MODULOS={"automacao":true,"disparo":true}
```

Ou pelo banco, que **vence** a variável — é a palavra final na instalação rodando:

```sql
insert into mensageria.config (chave, valor)
values ('modulos', '{"automacao":true,"disparo":true}'::jsonb)
on conflict (chave) do update set valor = excluded.valor, updated_at = now();
```

Se você ligou automação ou disparo, volte ao passo 6: cada um tem uma rotina própria, e sem ela
o fluxo nunca executa e a campanha nunca sai da fila.

## O catálogo de etiquetas nasce vazio

Instalação nova não tem etiqueta nenhuma cadastrada, e a rota só aceita etiqueta do catálogo —
então a primeira tentativa de etiquetar uma conversa responde **400 "etiqueta fora do catálogo"**
sem que nada esteja quebrado. O super admin cria as etiquetas em **Configurações → Etiquetas
(catálogo único)**, e a partir daí o atendente escolhe entre elas. Mesma ideia dos campos da
ficha: o catálogo é do admin, o valor é do atendente.

## Atualizar uma instalação que já existe

**Não sabe onde a pasta ficou?** Abra o Claude Code em qualquer lugar e peça: *"acha a pasta do
Expert Chat aqui no meu computador e atualiza ele pra última versão"*. Ele encontra, atualiza e
roda o conferidor. Você não precisa saber o caminho nem digitar comando nenhum.

Código novo não muda nada do que você já configurou: o `.env.local` é seu e fica fora do Git, e
migration aplicada não roda de novo. Na pasta do painel:

```bash
git pull
npm install                                   # só se o package.json mudou
node scripts/instalar/agente.mjs --valendo    # completa o que faltar; nada é sobrescrito
```

O conferidor é idempotente: ele aplica só a migration que falta, cria o que ainda não existe
(bucket, tabelas de um canal novo) e mantém toda chave que já está no `.env.local`. Rodar duas
vezes não faz mal. Sem o WhatsApp Agent, o equivalente é
`node scripts/instalar/index.mjs`, que **confere e diz** o que falta sem alterar nada.

Depois:

- **Local:** reinicie o `npm run dev`.
- **Vercel pelo CLI:** `vercel --prod` de novo. Envs novas vão com
  `node scripts/instalar/agente.mjs --valendo --vercel` antes do deploy — variável só entra em
  build novo.
- **Vercel ligada a um fork no GitHub:** `git push` para o seu fork e ela redeploya sozinha.

Se a atualização trouxer migration nova, o conferidor avisa antes de aplicar e confere no fim;
ele **para com erro** se sobrar alguma pela metade, em vez de dizer que terminou.

## Esqueci a senha

Dois caminhos, e o segundo existe porque o primeiro depende de e-mail:

1. **Link por e-mail.** Na tela de login, "Esqueci minha senha" manda um link pelo Supabase Auth.
   Precisa de **SMTP configurado** no projeto (Authentication → SMTP Settings); o remetente
   padrão do Supabase é só para teste e limita a poucos e-mails por hora. O caminho mais curto
   é o Resend: crie a API key lá, verifique o seu domínio, e no Supabase preencha host
   `smtp.resend.com`, porta `465`, usuário `resend`, senha = a API key, remetente um e-mail do
   domínio verificado. Em **Authentication → URL Configuration**, ponha a URL do painel em
   Site URL e em Redirect URLs, senão o link volta para o endereço errado.
2. **Senha temporária pelo super admin.** Em Configurações → Acesso → **Redefinir senha**, o
   administrador escolhe a pessoa e o painel gera uma senha temporária, mostrada uma vez. A
   pessoa entra com ela e troca em Meu perfil. Não depende de e-mail.

## Permissões que não se ganham sozinhas

Um papel que você criou **antes** de uma permissão nova existir não a recebe automaticamente —
marque na tela de papéis. Hoje isso vale para `relatorios_exportar`, `iniciar_conversa`,
`aprovar_automacao` e `editar_contexto`. Quem não tem papel nomeado já as tem pelo
comportamento padrão.

## Quando algo não funciona

Os modos de falha silenciosa que mais aparecem, e o que cada um significa:

| O sintoma | A causa quase sempre é |
|---|---|
| Tela que não abre, ou recurso que "não existe" | migration que falta. Rode o conferidor |
| Configurei a variável e nada mudou | deploy antigo. Variável só entra em build novo |
| Nenhuma rotina roda | `tick_bearer` não está no banco (passo 5), ou `pg_cron`/`pg_net` não habilitados |
| Canal aparece na tela, recebe mensagem e **não envia** | credencial do canal faltando. O conferidor aponta |
| Canal aparece e a lista fica **vazia** | a fonte dele não está conectada (é isso, não é erro) |
| Webhook responde 403 e não grava | canal sem `INSTANCE_ID` configurado. É proteção: ninguém enche de conversa um canal que não foi cabeado |
| Autenticação falha sem motivo aparente | espaço nas pontas do valor da variável |
| Login entra e o painel fica vazio | falta a linha em `mensageria.perfis` (passo 7b) |
| Fluxo não executa / campanha não sai | módulo desligado, ou a rotina dele não foi agendada |

## Rodando as provas

O projeto tem cerca de 30 provas que rodam em **Node puro, sem build e sem rede** — nenhuma
precisa da sua instalação de pé:

```bash
node scripts/prova-permissoes.ts
node scripts/prova-fluxo.ts
node scripts/prova-disparo.ts
node scripts/instalar/index.mjs --prova
```

Exigem Node 22.6 ou mais novo. Vale abrir uma: cada prova é a explicação executável de uma
decisão do produto, e é o melhor lugar pra entender uma parte do código antes de mexer nela.

## Documentação

| Arquivo | Sobre |
|---|---|
| `docs/instalacao.md` | a instalação em detalhe, com a justificativa de cada decisão |
| `docs/variaveis.md` | como escrever variável em resposta rápida e em mensagem de automação |
| `docs/permissoes.md` | papéis, escopos e quem vê o quê |
| `docs/disparo.md` | campanhas em massa |
| `docs/webhooks-saida.md` | como avisar outro sistema quando algo acontece aqui |
| `docs/exportacao.md` | tirar os dados de dentro |
| `docs/canal-whatsapp-agent.md` | usar o painel em cima do WhatsApp Agent que você já tem, sem reinstalar |
| `docs/api.md` | as rotas da API que um integrador ou agente usa, com os nomes certos dos parâmetros |

## Licença

MIT. Use, modifique e distribua. Veja `LICENSE`.
