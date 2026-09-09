# Instalar o Expert Chat numa conta nova

> Uma instalacao por cliente, na infra do proprio cliente. Nada aqui e multi-tenant:
> cada empresa tem o seu Supabase, o seu deploy e as suas envs.

O instalador assistido nao instala sozinho — ele **confere e diz o que falta**, na
ordem em que a instalacao quebra:

```bash
node scripts/instalar/index.mjs                            # confere tudo, nao muda nada
node scripts/instalar/index.mjs --base https://SEU-PAINEL   # inclui o smoke test
node scripts/instalar/index.mjs --log instalacao.md         # grava o relatorio
node scripts/instalar/index.mjs --envs-vercel                # diff das envs do projeto
node scripts/instalar/index.mjs --envs-vercel --valendo      # cria as envs que faltam
node scripts/instalar/index.mjs --prova                      # prova das decisoes dele
```

Modo conferencia e o **default**: `--dry` nao precisa ser digitado. O unico passo
com escrita e `--envs-vercel --valendo`.

## Por que ele nao roda as migrations

Porque **codigo nunca cria tabela nesta casa** — migration e gesto humano no SQL
Editor. Um CLI que executa DDL com a `service_role` faz `drop function` e
`alter column set default` no banco de producao de um cliente sem ninguem lendo a
saida, e transforma "rodei o instalador" em "alguem aplicou algo em algum momento".
Migration aplicada pela metade e o pior estado possivel: a rota degrada com aviso e
o dono acha que instalou.

O que ele faz e melhor pro que o processo precisa: **prova de estado**. Ele descobre
por leitura quais migrations estao aplicadas, quais faltam e quais estao **PELA
METADE**, e entrega a fila ordenada pra colar. Rodar de novo depois de colar e a
prova: antes e depois medidos.

## A ordem

### 1. Projeto Supabase
Crie o projeto. Guarde a URL e a `service_role` no gerenciador de senhas — a
`service_role` nunca vai pro navegador nem pro repo.

### 2. Migrations
No SQL Editor, cole os arquivos de `supabase/migrations/` em **ordem numerica**, um
por vez, sem pular buraco. Depois rode o instalador: o passo 3 tem que dizer
"todas as migrations aplicadas".

Migrations que so criam funcao aparecem como *nao verificavel* — checar funcao
exigiria executa-la, e executar funcao de relatorio num banco de producao e leitura
pesada por curiosidade. Essas ficam na lista pra conferencia manual.

### 3. Envs
Rode o instalador: o passo 1 lista todas, com o que quebra sem cada uma. Valor de
segredo nunca e exibido (sai como `(N caracteres, nao exibido)`).

Env **com espaco nas pontas** e tratada como grave mesmo quando opcional: ela falha
na hora de autenticar e o erro nao diz isso em lugar nenhum.

### 4. Deploy
Suba o projeto. Env nova **nao alcanca deploy que ja esta no ar** — a Vercel injeta
variavel no build; depois de criar env, faca deploy novo.

### 5. Bearer das rotinas
Todas as rotinas (vigia, disparo, agendadas, fluxos, SLA) autenticam pelo mesmo
bearer, `CHATGURU_SYNC_SECRET`. Os jobs do pg_cron leem esse valor **de dentro do
banco**, entao ele precisa estar la uma vez:

```sql
insert into mensageria.config (chave, valor) values ('tick_bearer', to_jsonb('COLE_AQUI_O_SEGREDO'::text))
  on conflict (chave) do update set valor = excluded.valor, updated_at = now();
```

O valor vai do gerenciador de senhas direto pro SQL Editor: nao passa pelo CLI, nao
entra em log e nao vira argumento de linha de comando (argumento fica no historico
do shell).

### 6. Jobs do pg_cron
O passo 4 do instalador imprime o SQL de cada job que **esta** instalacao precisa —
job de modulo desligado nao entra na lista, porque rodaria pra nada. Cole no SQL
Editor e confira em `cron.job_run_details` que a primeira execucao voltou
`succeeded`.

O comando le o bearer do banco em vez de carregar o valor porque `cron.schedule`
guarda o comando em **texto** no catalogo — bearer digitado ali fica gravado pra
sempre, e bearer errado num job da 401 em silencio (ninguem le o retorno de um cron).

### 6b. Numeros e canais (a outra metade da instalacao)

O instalador confere as credenciais de **todos** os canais desta instalacao, com o
prefixo de env derivado do id e da fonte (`ZAPI_<ID>_TOKEN`, `GUPSHUP_<ID>_API_KEY`,
`EVOLUTION_<ID>_*`; `central` e a excecao historica, `CENTRAL_ZAPI_*`):

- **canal de `CANAIS_EXTRA` com `ativo: true`** sem credencial e **grave**, porque o
  modo de falha e silencioso: ele aparece no painel, recebe mensagem e **nao envia**,
  sem erro na tela. Canal `ativo: false` nao e cobrado (alarme falso);
- **os dois canais BUILTIN — `central` (Z-API) e `apioficial` (Gupshup) — tambem sao
  conferidos**, e isso e novo: eles existem em toda instalacao, com `ativo: true`, mas
  as envs deles nao estao na lista fixa. Antes, `GUPSHUP_APIOFICIAL_API_KEY` e
  `_SOURCE_NUMBER` nao eram conferidas por ninguem, e o instalador dizia "nenhuma
  obrigatoria faltando" numa instalacao onde a API Oficial **aparece na tela de
  envio**.

Builtin sem credencial **nao barra a subida**, e nao e descuido: `central` sem
credencial de envio ainda RECEBE (instalacao que so le e valida), e `apioficial` tem
fallback historico no banco (`public.connectors`), entao a env faltando nao prova que o
envio esta quebrado. O que o relatorio faz e nao deixar passar calado — sai a linha
**"confira antes de prometer envio"** com o nome do canal e onde olhar. E
"credenciais conferidas" so aparece quando **todas** estao ok: dizer isso com um
builtin vazio na linha de baixo era a contradicao que fazia o instalador parecer
confiavel demais.

Uma env que aparece nos DOIS lugares (`CENTRAL_ZAPI_*` esta escrita a mao na lista fixa
e tambem e derivada do builtin `central`) e conferida UMA vez: o texto vem da lista
fixa, e a marca de canal/builtin vem da derivada. A fusao importa — quando o dedupe
descartava a derivada, `central` saia da cobertura de canal e o passo 1 chegava a
imprimir "Credenciais de 1 canal(is): conferidas." com o canal principal vazio.

> A lista dos builtin em `scripts/instalar/plano.mjs` (`CANAIS_BUILTIN`) e um
> **espelho** de `lib/canais.ts` — importar de la criaria ciclo, como o proprio
> `envioDisponivel` registra. Canal builtin novo entra nos dois lugares, e a prova do
> instalador LE `lib/canais.ts` pra comparar id/fonte/ativo: espelho fora de sincronia
> QUEBRA `--prova` em vez de sumir da conferencia em silencio.

O que segue **manual** (fase 2 — o instalador nao faz, e diz que nao faz):

1. **criar/conectar a instancia** no provedor (Z-API, Gupshup, Evolution) e ler o QR
   code, quando for o caso;
2. **apontar o webhook de entrada** do provedor para esta instalacao:
   `https://SEU-PAINEL/api/webhook?key=<WEBHOOK_KEY>&canal=<id-do-canal>`
   O `canal` tem que ser o **id** exato (`central`, ou o id que esta em
   `CANAIS_EXTRA`): errar o id entrega a mensagem no canal errado, e o painel
   responderia pelo numero errado;
3. **conferir a ida e a volta com mensagem real** — mandar de um celular e ver a
   conversa aparecer, depois responder pelo painel e ver chegar. O smoke test do
   passo 8 prova que a rota **recusa quem nao tem a chave**; ele nao prova que o
   provedor esta entregando.

Por que isso nao esta automatizado: cada provedor tem painel e fluxo proprios (um
deles exige leitura de QR code por uma pessoa), e apontar webhook de producao do
numero de um cliente e gesto com consequencia — mensagem entregue no lugar errado.

### 7. Primeiro super admin
Gesto humano no painel do Supabase (Authentication → Add user) e depois:

```sql
insert into mensageria.perfis (user_id, papel, escopo_visao)
values ('UUID_DO_USUARIO', 'super_admin', 'todas')
  on conflict (user_id) do update set papel = 'super_admin', escopo_visao = 'todas';
```

### 8. Smoke test
```bash
node scripts/instalar/index.mjs --base https://SEU-PAINEL
```

O passo 6 nao comemora HTTP 200: rota protegida respondendo **200 sem login** e
vazamento, e o relatorio manda parar a instalacao. Ele confere que a raiz sobe e
que conversas, exportacao, administracao, tick e webhook **recusam** quem chega sem
credencial.

## Permissoes que nao se ganham sozinhas

Papel **nomeado** criado antes de uma permissao nova nao a recebe automaticamente —
marcar na tela de papeis. Hoje isso vale para:

- `relatorios_exportar` — exportar dado do sistema;
- `iniciar_conversa` — abordar numero sem conversa;
- `aprovar_automacao` — liberar mensagem que um fluxo segurou;
- `editar_contexto` — editar a memoria da conversa.

Quem **nao** tem papel nomeado ja as tem pelo fallback embutido.

## O que continua fora deste instalador (fase 2)

- **modo pergunta-e-resposta que escreve o `.env.local`** a partir das respostas
  (hoje ele confere o ambiente, nao o cria);
- **criar o primeiro super admin** pelo CLI — exige a Admin API do Auth, e a
  service_role de outro projeto no ambiente de quem instala;
- **`--valendo` do pg_cron e das migrations** — so faz sentido no dia em que
  existir caminho de escrita auditado pro banco do cliente, com log de quem aplicou
  o que. Enquanto nao existir, o gesto humano E o controle;
- **plugar o numero** (instancia no provedor, QR code, webhook de entrada, ida e
  volta com mensagem real) — ver o passo 6b. O instalador **confere** as credenciais
  de todos os canais (builtin e declarados); conectar o numero segue manual.
