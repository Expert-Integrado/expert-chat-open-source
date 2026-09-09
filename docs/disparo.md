# Modulo de disparo em massa

Doc vivo da Frente H (31/08/2026). Cobre os cards 86ak85jek (motor), 86ak85jdk
(publico), 86ak85jfd (acompanhamento) e 86ak85bez (campanhas historicas).

O modulo se chama `disparo` e **nasce DESLIGADO** em toda instalacao
(`lib/modulos.ts`, decisao A do Eric de 30/08). Instalacao que nunca ligou o
modulo tem todas as rotas de disparo respondendo 403.

---

## A regra de produto que manda em tudo

**Disparo em massa exige aprovacao humana explicita, campanha por campanha.**

Nao e configuracao, nao e um toggle que alguem liga uma vez e esquece: e o
comportamento do produto, e ele esta gravado em quatro lugares que se reforcam.

1. **Toda campanha nasce em `rascunho`.** O `POST /api/disparo` nao aceita criar
   campanha em outro estado — nao existe atalho.
2. **So uma pessoa tira do rascunho.** `podeTransicionar` (lib/disparo/estado.ts)
   marca a transicao `rascunho -> rodando|agendada` como `humano`, e recusa o
   autor `motor`. O tick, o cron e qualquer chamador automatico batem nessa
   recusa. Provado em `scripts/prova-disparo.ts`.
3. **A rota que aprova exige login e permissao** (`PATCH /api/disparo/<id>`), e
   carimba quem aprovou em `ativada_por_id/_nome/_em`. Depois do disparo, da pra
   responder "quem autorizou isso?" — que e a pergunta que aparece quando algo
   sai errado.
4. **Agendar nao burla nada.** `agendada_para` so vale DEPOIS da aprovacao: o
   relogio cumpre o que uma pessoa ja autorizou (`agendada -> rodando` e a unica
   transicao que o motor faz sozinho). Campanha agendada sem hora marcada nunca
   comeca.

### Quem pode disparar

`lib/disparo/permissao.ts`, funcao `podeDisparar`. Hoje: `super_admin` — a base
ainda nao tem `lib/permissoes.ts` com papel granular por acao. Quando a Frente E
entregar esse papel, **a troca e dentro dessa funcao** e nenhuma rota muda. A
regra nao esta replicada em lugar nenhum de proposito.

---

## Fail-closed: os quatro "nao" do modulo

| Situacao | Resposta |
| --- | --- |
| Modulo `disparo` desligado | 403 em **todas** as rotas, antes de qualquer leitura (`lib/disparo/rota.ts`) |
| Usuario sem permissao | 403 com motivo legivel |
| Canal sem credencial de envio cabeada | **recusa na hora de ativar** a campanha (409), nao no meio do envio |
| Migration 0012 nao aplicada | 503 dizendo exatamente isso, nunca 500 |

O terceiro merece nota: e a decisao 4 do card 86ak85jek ("distinguir sem
capacidade de sem credencial"). Canal sem credencial nao e espera — e
configuracao, e so quem administra resolve. Por isso a campanha e barrada na
ativacao, e nao descobre isso com a fila inteira falhando. Se um canal perder a
credencial com a campanha ja rodando, o tick **pausa** a campanha com o motivo,
em vez de queimar destinos em falhas identicas.

---

## Ritmo: os tres freios

Toda a decisao de "quem sai agora" mora em `decidirEnvios`
(`lib/disparo/ritmo.ts`), **funcao pura, sem rede e sem banco**. A rota de tick
nao decide nada: junta os numeros e obedece.

1. **Lote** — quantos destinos uma chamada do tick processa (padrao 40, teto 200).
2. **Intervalo** — espera minima entre dois envios da mesma campanha (padrao 5s).
3. **Teto diario por canal** — quantos envios o numero aguenta por dia (padrao
   300), **somando todas as campanhas que saem por aquele canal**. O teto e por
   canal e nao por campanha porque quem queima e o numero: duas campanhas de 200
   no mesmo chip somam 400 no mesmo dia, e o WhatsApp conta o numero.

A ordem importa. O teto e checado **antes** do intervalo porque as duas esperas
sao respostas diferentes: "espera 5 segundos" e "so continua amanha". Dizer a
primeira quando a verdade e a segunda faz o operador ficar apertando atualizar.

A janela do teto diario e o **dia da INSTALACAO**, nao UTC e nao um fuso cravado:
vem de `lib/disparo/fuso.ts` (env `FUSO_HORARIO`). Ver "Fuso da instalacao".

**Qual teto prevalece quando duas campanhas dividem o canal:** o teto e
configurado POR CAMPANHA, mas contado POR CANAL. Com duas campanhas no mesmo
numero e tetos diferentes, **prevalece o MAIOR** — a de teto 500 segue enviando
depois que a de teto 300 ja parou, porque cada uma compara a contagem do canal
com o proprio limite. E assim de proposito nesta v1 (mover o teto pra config do
canal e mudanca de modelagem, nao ajuste), e a tela diz isso em uma linha.

**Estimativa antes de aprovar**: `estimarDuracao` conta o intervalo E o teto
diario. Um publico de 5.000 com teto de 300/dia nao leva horas, leva mais de duas
semanas — e quem aprova ve isso na tela antes de autorizar.

---

---

## A corrida do tick: reserva, interrupcao e retry

Tudo isto e `lib/disparo/lote.ts` — **puro, com a porta injetada**, e por isso a
corrida e provada em memoria (`scripts/prova-disparo.ts`), sem rede e sem enviar
mensagem nenhuma.

### Reserva (claim)

O tick **nao** le N pendentes e envia os N. Ele reserva um a um, com um update
condicional de `pendente` para `enviando`, e **so envia o que o update
devolveu**. Dois ticks simultaneos disputam destino a destino e exatamente um
vence cada um; quem perde pula e contabiliza a perda.

Sem isso — e era o estado da entrega anterior — dois ticks liam a MESMA fila,
mandavam a MESMA mensagem duas vezes e ainda decidiam lote, intervalo e teto
sobre leitura velha.

Complementos:

- **reserva orfa volta pra fila** depois de 5 minutos (`LIMITE_RESERVA_MS`): um
  deploy no meio do lote nao pode prender destino em `enviando` pra sempre;
- **lock por campanha** (`campanhas.tick_lock_em`, expira em 90s): dois ticks nao
  disputam a mesma fila nem decidem ritmo sobre a mesma leitura.

### Interrupcao

Pausar ou cancelar **para o lote em curso**, e nao no fim dele: o estado da
campanha e RELIDO a cada volta do laco, e de novo depois da espera do intervalo.
O destino ja reservado volta pra fila.

Todo update de estado do motor carrega a guarda do estado esperado. Sem ela, uma
campanha CANCELADA no meio do lote voltava a `concluida` no update final — o
cancelamento sumia do registro.

### Retry

Falha de envio nao e mais definitiva na primeira: conta tentativa e volta pra
fila ate o teto (`MAX_TENTATIVAS`), quando vira `falhou` com o motivo e o numero
de tentativas. Antes, um timeout de rede custava o destino pra sempre.

Quando o motor desiste, o par manual e `PATCH /api/disparo/<id>` com
`{"acao":"reenfileirar_falhas"}`: devolve as falhas pra fila e zera a contagem de
tentativas — para quando a causa foi resolvida por fora (chip religado,
credencial arrumada) e nao faz sentido remontar a campanha inteira. Campanha
**concluida ou cancelada recusa** o re-enfileiramento: estado terminal e
terminal, e devolver destino pra uma fila que o tick nao olha prometeria um envio
que nunca aconteceria. Nesse caso, campanha nova.

A excecao e falha de **configuracao** (credencial ausente), definitiva na hora —
tentar de novo nao muda nada. E, antes do lote, o canal passa por
`motivoCanalNaoEnviaAsync`, que consulta o conector Gupshup de verdade: o canal
`apioficial` escapava do guarda sincrono (pelo fallback historico de
`envioDisponivel`) e queimava a fila inteira em N falhas identicas de credencial,
em vez de pausar UMA vez por impedimento.

### O teto falha FECHADO

A contagem do teto diario ignorava erro e devolvia zero — um erro de banco apagava
o freio do chip justamente quando ninguem estava olhando. Agora ela lanca e **o
tick nao envia nada naquela rodada**. Freio que falha aberto nao e freio.

---

## Lista de bloqueio (opt-out)

Quem pediu pra sair nao recebe, conferido em **dois pontos independentes, os dois
fail-closed**:

1. na **montagem do publico**, inclusive na previa — o numero que a pessoa aprova
   tem que ser o numero que vai receber;
2. de novo **no envio**, destino a destino, dentro do laco.

Os dois existem porque o publico pode ter sido montado dias antes do disparo: quem
pediu pra sair no meio nao pode receber so porque ja estava na lista.

**Fail-closed de verdade:** se a consulta a lista falhar, o destino conta como
BLOQUEADO. Erro de banco nao pode virar "manda pra todo mundo, inclusive pra quem
pediu pra sair" — o custo dos dois erros e completamente diferente.

A chave e a mesma dos ultimos digitos usada na deduplicacao: a pessoa aparece com
e sem DDI, com e sem o nono digito.

**A lista se alimenta sozinha:** quando o destino responde ao disparo com uma
palavra de descadastro, a deteccao de respostas bloqueia na hora e marca o destino
como `optout`. A lista basica (`lib/disparo/optout.ts`): PARE, PARAR, SAIR, STOP,
CANCELAR, CANCELA, DESCADASTRAR, DESCADASTRO, REMOVER, SEM INTERESSE, NAO QUERO
RECEBER, NAO ENVIE MAIS.

O reconhecimento e **conservador de proposito**: a mensagem tem que SER a palavra,
ou uma frase curta que comeca por ela. "Nao pare de me mandar novidades" NAO
descadastra, e "gostaria de cancelar a consulta de quinta" tambem nao —
descadastrar por engano e perder o contato pra sempre sem a pessoa ter pedido.

Gestao pela rota `/api/disparo/bloqueios` (GET/POST/DELETE, mesma permissao).

## Publico (card 86ak85jdk)

Quatro origens, todas em `lib/disparo/publico.ts`:

1. **CSV** — planilha anexada. Separador do Excel BR (`;`) detectado sozinho, BOM
   tratado, aspas com separador dentro, cabecalho em varios nomes e com acento.
   Telefone invalido **nao derruba o arquivo**: vira linha rejeitada com o numero
   da linha e o motivo, pra pessoa achar e corrigir. Colunas extras viram
   variaveis da mensagem.
2. **Filtro da caixa de entrada** — os mesmos filtros que a pessoa ja usa
   (status, arquivada, etiquetas, responsavel, periodo). **Respeita o escopo do
   usuario**: passa cada conversa pelo mesmo `conversaVisivel` das rotas de
   leitura, nao por uma copia da regra. Quem so ve as proprias conversas nao
   monta publico com as dos outros — e o relatorio diz quantas ficaram de fora.
3. **Lista salva** — `mensageria.campanha_listas`, itens em jsonb.
4. **Filtro do Pipedrive** — filtro salvo ou etapa de funil do CRM (Frente V,
   31/08/2026). Detalhe abaixo.

**Por que a lista guarda os itens e nao o filtro:** filtro salvo mudaria de
tamanho entre a aprovacao e o disparo. Quem aprovou 400 pessoas nao aprovou as
900 que o mesmo filtro devolve na semana seguinte. Lista e a fotografia do que a
pessoa viu quando salvou.

### Filtro do Pipedrive (a 4a origem)

A credencial vem **da instalacao** (`PIPEDRIVE_API_TOKEN` ou `PIPEDRIVE_API_KEY`),
nunca do repo. **Sem credencial a fonte fica invisivel** na tela — o catalogo
responde `disponivel: false` com 200, em vez de aparecer e falhar no clique.

Duas selecoes: `filtro_id` + `filtro_tipo` (filtro salvo de pessoas ou de negocios)
ou `etapa_id` + `status` (etapa de funil). Regra pura em `lib/disparo/pipedrive.ts`
(zero import, porta HTTP injetada); a porta real e `lib/disparo/pipedrive-http.ts`,
e **o token nunca entra em mensagem de erro nem em retorno**.

Decisoes que valem saber antes de usar:

- **Um telefone por pessoa** — primario, senao o rotulado como WhatsApp, senao o
  primeiro da lista. Dois numeros do mesmo contato virariam **duas mensagens**: o
  dedupe casa pelos ultimos digitos, e dois numeros diferentes dao chaves
  diferentes. O relatorio conta quantos contatos tinham mais de um numero.
- **Status default da busca por etapa e `open`** — a etapa guarda ganho e perdido
  junto, e campanha pra quem ja foi perdido nao volta atras.
- **Tipos aproveitaveis: pessoas e negocios.** Organizacao, atividade, produto,
  projeto e lead ficam fora (nao tem telefone de pessoa fisica pra abordar), e
  entram no relatorio como `ignorados_por_tipo` em vez de desaparecer.
- **`success !== true` LANCA.** Publico vazio silencioso faria a pessoa achar que o
  filtro do CRM esvaziou, quando foi a chamada que falhou.
- **501 e 502 sao respostas diferentes**: 501 = esta instalacao nao tem CRM
  configurado; 502 = o CRM nao respondeu. `total: 0` nos dois casos mentiria.
- **Fail-closed na criacao da campanha**: falha ao consultar o CRM **nao cria**
  campanha vazia.
- Tetos: 500 por pagina, 40 paginas, 20s por chamada. Paginacao que nao avanca
  (`next_start <= start`) para na hora — senao e laco infinito com HTTP 200.

Formatos MEDIDOS contra a API v1 em 31/08/2026, nao deduzidos da documentacao (que
mostra o exemplo colapsado e documenta a v2): telefone chega como `phone` na v1 e
`phones` na v2 (os dois sao aceitos), e no negocio o `person_id` vem como
**objeto** com nome e telefone dentro — o que evita uma requisicao por negocio.

### Deduplicacao

Chave = **os ultimos 8 digitos** do telefone. A mesma pessoa aparece na base ora
com DDI, ora sem, ora com o nono digito e ora sem; casar pelo numero inteiro
deixaria passar duplicata. Grupo usa o proprio id.

O indice unico `(campanha_id, chat_id)` fecha por baixo: o mesmo destino entra
uma vez so por campanha, mesmo se o publico for gravado duas vezes.

---

## Acompanhamento (card 86ak85jfd)

`GET /api/disparo/<id>` devolve, ao vivo: contagens por estado, percentual,
canal em uso, estimativa do que falta, lista paginada de destinos (com o motivo
de cada falha) e as **respostas recebidas com link pra conversa**.

O link e o ponto: num disparo comercial o que interessa nao e a taxa de entrega,
e quem respondeu — e cada resposta e uma conversa na caixa de entrada, a um
clique.

### Como "respondeu" e detectado — e por que assim

**Decisao: a deteccao acontece na LEITURA, nao por hook na ingestao.**

A entrada de mensagem tem hoje tres portas diferentes (webhook Z-API, sync do
canal oficial via Gupshup, Evolution). Um hook precisaria existir nas tres — a
regra ficaria em tres lugares e divergiria na primeira porta nova, que e
exatamente o defeito que este repo ja pagou em outras areas.

A pergunta "quem respondeu?" so tem consumidor quando alguem abre o relatorio.
Calcular na leitura (`marcarRespostas`, em `lib/disparo/motor.ts`, chamada pelo
GET do acompanhamento e pelo tick) nao perde nada e mantem **uma** implementacao.
O criterio: destino com estado `enviado` cuja conversa tem mensagem de entrada
com data **posterior** ao `enviado_em`.

---

## Campanhas historicas (card 86ak85bez)

`scripts/importar/campanhas.mjs`, no mesmo padrao da CLI de historico:
`--dry` nao abre conexao nenhuma, idempotente por `(origem_ferramenta, origem_id)`,
relatorio em Markdown no fim.

**Campanha importada e DADO, nunca funcionalidade.** O guardrail esta em tres
camadas:

- o importador grava `historico = true` e estado terminal;
- o CHECK `campanhas_historico_nunca_dispara` (migration 0012) **impede** que uma
  linha historica exista em estado vivo — nem UPDATE manual no SQL Editor
  consegue coloca-la pra rodar;
- ela nunca ganha linha em `campanha_destinos`, entao nao ha fila pro motor
  consumir.

`PAUSADA` na origem vira `concluida` aqui de proposito: neste painel `pausada` e
um estado **vivo**, que o tick retoma. Registro historico nao tem estado vivo.

### Onde ficam as campanhas no backup

`config-dados/campanhas.json` — a captura da tela `/campaigns`, no formato
`{ tabelas: [{ cabecalho, linhas: [{ celulas, links }] }] }`. O importador casa
as colunas **pelo cabecalho**, nunca por posicao: a tela da origem pode ganhar
coluna, e casar por indice transformaria "progresso" em "destinatarios" sem
ninguem notar. Os identificadores saem dos LINKS da linha
(`/campaigns/<id>/view` e `/dialog/<id>/edit`).

### Aferido contra o acervo real (31/08/2026, dry run)

| Medida | Valor |
| --- | --- |
| Campanhas | 134 |
| Destinatarios somados | 24.631 |
| Finalizadas / pausadas | 129 / 5 |

Reproduz exatamente o que o card mediu.

**GOTCHA medido, e que contradiz a leitura ingenua do card:** o card diz "nenhuma
sem fluxo associado", e esta certo — mas so pelo NOME. As 134 trazem o nome do
dialogo na coluna; **so 87 trazem o link com o id dele**. Ter nome de fluxo e ter
id de fluxo sao coisas diferentes, e conta-las juntas faz o relatorio declarar
"47 sem fluxo" para campanhas que tem fluxo sim — o que falta nelas e o
identificador que torna a ligacao **navegavel**. O relatorio separa as duas
medidas por isso.

A ligacao campanha -> fluxo e por `origem_fluxo_id`, que casa com
`fluxos.origem_id` (gravado pelo importador de fluxos da Frente C). Sem chave
estrangeira: importar fluxos antes ou depois tanto faz, a ligacao resolve na
leitura.

---

## Fuso da instalacao

Nada de fuso cravado: `lib/disparo/fuso.ts` resolve o fuso da instalacao pela env
`FUSO_HORARIO` (IANA), e vale tanto na janela do teto diario quanto no
agendamento. Texto de agendamento **sem** offset e lido no fuso da instalacao;
**com** offset e respeitado como veio; invalido vira **400 com mensagem**, nunca
uma data silenciosa ou 1970. Agendar sem hora tambem e recusado — sem hora
marcada a campanha nunca comecaria, e ninguem entenderia por que.

**COSTURA A LIGAR NO MERGE:** a Frente F entregou `lib/fuso.ts` na central, com
`isoDeLocal`. Este worktree foi cortado antes disso, entao `lib/disparo/fuso.ts`
existe com a **mesma assinatura e a mesma semantica** — no merge, trocar o corpo
por um re-export de `lib/fuso.ts` e nada mais muda.

## Tela

`app/disparo/page.tsx` — **pagina propria**. Nao toca `app/home.tsx`, que estava
com outra frente no mesmo dia (duas frentes num arquivo de 3.700 linhas e
conflito garantido).

**A entrada pela navegacao do painel ficou de FORA desta entrega**: quem usa
chega por `/disparo` direto. Ligar no menu e um incremento de uma linha em
`home.tsx`, pra fazer quando aquele arquivo tiver dono livre.

A tela e a **minima consistente** — mesma paleta e mesmos padroes visuais do
painel, sem invencao de layout. **Marcada para ajuste visual do Eric de dia.**

A pagina e estatica e publica, entao o conteudo so e renderizado **depois do
primeiro fetch autorizado**: sem sessao, sem permissao ou com o modulo desligado
aparece so o motivo — nenhuma casca contando que esta instalacao tem um modulo de
disparo em massa.

**Divida declarada, e ela e do painel inteiro:** o gate de pagina neste repo e so
no client — `app/page.tsx` e `app/widget/page.tsx` sao `"use client"` e nao existe
nenhum server component com checagem de sessao. A protecao real sao as rotas /api
respondendo 401/403. Consequencia: o chunk JS e publico, entao os TEXTOS da tela
revelam que o modulo existe nesta instalacao (dado nenhum vaza — so a
existencia). Fechar isso e mudanca de padrao do painel todo (server component +
redirect), nao da tela do disparo.

---

## Nenhum disparo real neste desenvolvimento

Regra da casa nesta frente, cumprida: **nao saiu uma mensagem sequer**.

- A decisao do motor e funcao pura e a prova (`node scripts/prova-disparo.ts`,
  42 checagens) exercita ritmo, teto, ciclo de vida, telefone e CSV **sem tocar
  rede**.
- O importador foi provado em `--dry` contra fixture sintetica
  (`node scripts/importar/prova-campanhas.mjs`) e depois em `--dry` contra o
  acervo real, que **nao abre conexao nenhuma**.
- Nenhuma fixture do repo contem dado de cliente.

---

## Como ligar numa instalacao

1. Rodar `supabase/migrations/0012_disparo.sql` no SQL Editor (gesto humano —
   codigo nao cria tabela).
2. Ligar o modulo: env `MODULOS={"disparo":true}` ou a chave `modulos` em
   `mensageria.config` (a config vence a env).
3. Garantir que o canal tem credencial de envio (`envioDisponivel`).
4. Agendar o tick: `POST /api/cron-disparo` com o bearer do cron, no mesmo modelo
   dos jobs 14/23/24/25. **O job de cron ainda NAO existe** — criar cron e gesto
   humano, como a migration.

---

## Pendencias declaradas

| O que | Por que ficou de fora |
| --- | --- |
| **Rodizio entre chips** | O card pede teto por chip **com rodizio automatico** entre numeros. Esta v1 tem o teto por canal e o motivo legivel quando ele estoura, mas a campanha sai por UM canal. O rodizio precisa de politica ("quais numeros podem substituir quais") que e decisao de produto, nao detalhe tecnico. |
| **Origem Pipedrive** | Depende da integracao com o CRM (outra historia). |
| **Entrada no menu do painel** | `app/home.tsx` estava com outra frente. |
| **Importar bloqueios historicos** | A lista de bloqueio existe e funciona (cadastro manual + descadastro automatico por resposta), mas quem ja pedira pra sair no sistema ANTIGO nao vem junto: o backup nao traz essa lista num formato identificado. Ate vir, a base comeca sem esses bloqueios — e o risco e concreto, e gente que ja pediu pra nao receber. |
| **Tela da lista de bloqueio** | A rota `/api/disparo/bloqueios` esta pronta; a tela de gestao nao entrou. |
| **Teto por canal (e nao por campanha)** | Hoje prevalece o MAIOR teto entre as campanhas do canal (secao Ritmo). Mover o teto pra config do canal e mudanca de modelagem. |
| **Exportar as falhas** | O relatorio traz falha com motivo na tela e na API; o botao de exportar nao entrou. |
| **Job de pg_cron** | Criar cron e gesto humano, como a migration. |
| **Midia na campanha** | v1 e so texto, como o resto do painel no canal oficial. |
