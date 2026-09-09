# Importar o historico do ChatGuru

Traz para a sua instalacao do Expert Chat o historico de conversas que ficou no
ChatGuru: mensagens, anotacoes internas, nome de quem atendeu, status da conversa
e etiquetas.

Voce roda isto **uma vez**, na sua maquina, apontando para a sua pasta de backup e
para o seu banco. Nada sai daqui para lugar nenhum: o script fala so com o banco
cujo endereco voce informar.

---

## Antes de comecar

Voce vai precisar de tres coisas:

1. **A pasta de backup do ChatGuru.** E a pasta exportada da sua conta antiga,
   com um arquivo `chats_index.json` na raiz e uma pasta `messages/` dentro.
2. **O endereco do seu projeto Supabase** (o mesmo que esta na variavel
   `MSG_SUPABASE_URL` da sua instalacao). Parece com `https://xxxx.supabase.co`.
3. **A chave `service_role` do seu projeto** (a mesma de `MSG_SUPABASE_SERVICE_KEY`).
   Ela esta em *Project Settings -> API* no painel do Supabase.

E preciso ter o **Node.js 18 ou mais novo** instalado (`node --version` responde).

> **A chave e a senha-mestra do seu banco.** Nao mande por WhatsApp, nao cole em
> chat, nao guarde em arquivo de texto. O jeito mais seguro e coloca-la numa
> variavel de ambiente (mostrado abaixo) em vez de digita-la na linha de comando —
> o que voce digita fica gravado no historico do terminal.

O que este importador **nao** faz: nao cria tabela nenhuma no seu banco, nao cria
conta de login para os atendentes antigos, e nao apaga nada.

---

## Passo 1 — simular (nao grava nada)

Sempre comece por aqui. O modo `--dry` **nao abre conexao com banco nenhum**: ele
so le o backup e escreve um relatorio dizendo exatamente o que entraria.

```bash
node scripts/importar/chatguru.mjs --pasta "/caminho/do/backup" --dry
```

No fim ele mostra o caminho de um relatorio em Markdown. Abra e confira:

- **as contagens batem** com o tamanho que voce esperava da sua operacao;
- **a data da mensagem mais recente** e proxima do dia em que o backup foi tirado
  (se estiver muito atras, o backup esta velho — reexporte antes de continuar);
- **a secao "O que NAO entrou"** nao tem nenhuma surpresa;
- **a secao "Pendencias"** — e ali que ficam as coisas que precisam da sua decisao.

## Passo 2 — importar de verdade

```bash
export MSG_SUPABASE_URL="https://xxxx.supabase.co"
export MSG_SUPABASE_SERVICE_KEY="a-sua-chave-service-role"

node scripts/importar/chatguru.mjs --pasta "/caminho/do/backup"
```

No Windows (PowerShell), troque as duas primeiras linhas por:

```powershell
$env:MSG_SUPABASE_URL     = "https://xxxx.supabase.co"
$env:MSG_SUPABASE_SERVICE_KEY = "a-sua-chave-service-role"
```

O relatorio gerado no fim agora traz tambem a **contagem real das tabelas antes e
depois** — e a prova de que o que saiu do backup chegou no banco.

### Deu erro no meio? Rode de novo

A importacao e **idempotente e retomavel**: as conversas ja concluidas ficam
anotadas num arquivo de checkpoint dentro da pasta de trabalho, e sao puladas na
proxima vez. Mensagem repetida e recusada pelo proprio banco. Ou seja: rodar duas
vezes nunca duplica nada, e nunca apaga o que ja entrou.

### Importar por cima de um painel que ja esta em uso

Pode. O importador nunca rebobina conversa viva:

- conversa que **ja existe** no painel mantem o status do atendimento, o arquivo
  e a data da ultima mensagem — o historico antigo entra por baixo, sem jogar a
  conversa de volta pro topo da lista nem reabrir atendimento encerrado;
- campo que o backup **nao tem** (nome, foto, responsavel, etiqueta) nao e
  enviado, entao nunca apaga o que o painel ja sabe.

Ainda assim, o normal e importar numa instalacao nova, antes de a equipe comecar
a atender.

Se quiser reprocessar tudo do zero (por exemplo, depois de reexportar a lista de
usuarios do sistema antigo para recuperar nomes de atendente), acrescente
`--recomecar`.

---

## Todas as opcoes

| Opcao | Para que serve |
| --- | --- |
| `--pasta <dir>` | Pasta do backup. **Obrigatoria.** |
| `--url <url>` | Endereco do seu projeto. Tambem lido de `MSG_SUPABASE_URL`. |
| `--key <chave>` | Chave `service_role`. Tambem lida de `MSG_SUPABASE_SERVICE_KEY`. |
| `--dry` | Simula. Nao abre conexao e nao grava nada. |
| `--so-config` | Importa so o catalogo de etiquetas e os nomes dos atendentes, sem mexer nas conversas. |
| `--canal <id>` | Para qual canal da sua instalacao o historico vai. Default: `central`. |
| `--schema <nome>` | Schema no banco. Default: `mensageria`. |
| `--lote <n>` | Quantas linhas por vez. Default: 500. Diminua se a rede for instavel. |
| `--limite <n>` | Processa so as N primeiras conversas — bom para um teste curto. |
| `--trabalho <dir>` | Onde ficam o checkpoint e os relatorios. Default: `<pasta do backup>/.importacao`. |
| `--recomecar` | Ignora o checkpoint e repassa tudo. |
| `--relatorio <arquivo>` | Caminho do relatorio em Markdown. |
| `--rotulo-canal <txt>` | Rotulo de origem gravado nas conversas novas. Default: `chatguru-<canal>`. |
| `--dump <arquivo>` | So com `--dry`: escreve num JSON as linhas exatas que seriam gravadas, pra voce conferir campo a campo. |

Para reimprimir o relatorio de uma execucao passada (o `.json` que fica ao lado do
`.md`):

```bash
node scripts/importar/relatorio.mjs --dados "/caminho/relatorio-....json"
```

---

## Segundo passo: funis, etapas e a etapa de cada conversa

O `chatguru.mjs` deixa os funis normalizados num arquivo
(`<pasta de trabalho>/funis-normalizados.json`) e guarda a etapa de cada conversa
dentro de `conversas.meta_chatguru.funil_etapas`. Quem carrega isso no painel e o
`funis.mjs` — rode-o **depois** das conversas e **depois** de aplicar a migration
`supabase/migrations/0009_funis.sql` na sua instalacao.

```bash
# ver o que aconteceria, sem abrir conexao
node scripts/importar/funis.mjs --pasta "/caminho/backup" --dry

# valendo
node scripts/importar/funis.mjs --pasta "/caminho/backup" \
  --url https://SEU-PROJETO.supabase.co --key SUA_CHAVE_SERVICE_ROLE
```

| Opcao | Para que serve |
| --- | --- |
| `--funis <arq>` | Outro caminho para o `funis-normalizados.json`. |
| `--conversas <arq>` | So em `--dry`: le a etapa das conversas de um arquivo em vez do banco. |
| `--canal <id>` | Canal das conversas. Default: `central`. |
| `--origem-sistema <s>` | Rotulo do sistema de origem gravado nas colunas `origem_*`. Default: `chatguru`. |
| `--origem-conta <id>` | Qual conta/aparelho da origem. Default: o campo `canal` do arquivo de funis. |
| `--limite <n>` | Processa so as N primeiras conversas. |
| `--dump <arq>` | So em `--dry`: escreve as linhas que seriam gravadas. |

Rodar de novo e seguro: funil e etapa **ja importados** sao reusados (se voce
renomeou no painel, o seu nome fica); funil e etapa com o **mesmo nome** criados a
mao sao adotados em vez de duplicar; o vinculo conversa -> etapa nunca entra duas
vezes. Valor de etapa que nao casar com nada aparece no relatorio como pendencia —
nada e adivinhado por semelhanca de nome.

---

## Terceiro passo: a midia (`midia.mjs`)

Os arquivos das mensagens (foto, audio, PDF, video) **nao ficam com voce**: eles
estao no armazenamento da ferramenta antiga, e esses enderecos deixam de
funcionar quando a conta for encerrada. Este passo baixa cada arquivo, sobe para
o armazenamento da **sua** instalacao e troca o endereco antigo pelo novo em cada
mensagem que ja foi importada.

```bash
# 1) so contar: quantos arquivos, de que tipos, quanto pesa. Nao baixa nada.
#    (este e o comportamento PADRAO — sem flag nenhuma ele so conta)
node scripts/importar/midia.mjs --pasta "/caminho/do/backup"

# 2) valendo (as mesmas variaveis do importador, mais o nome do bucket)
export MSG_STORAGE_BUCKET="midia-mensagens"
node scripts/importar/midia.mjs --pasta "/caminho/do/backup" --valendo
```

> **Baixar e subir de verdade exige `--valendo`.** Sem essa palavra o comando so
> conta. E de proposito: mover centenas de gigabytes e trocar o endereco das suas
> mensagens nao pode ser o que acontece quando alguem esquece uma opcao.

Rode **depois** de importar as conversas: o passo reescreve o endereco nas
mensagens que ja estao no banco.

- **Pode interromper.** O progresso fica em `rehospedagem-estado.json` na pasta de
  trabalho, e o endereco de cada arquivo no destino e calculado a partir do
  endereco antigo — entao rodar de novo continua de onde parou e **nunca sobe o
  mesmo arquivo duas vezes**.
- Se o arquivo ja estiver na pasta `media/` do backup, ele **nao e baixado de
  novo**. Com `--sem-rede` o passo usa exclusivamente o que ja esta em disco.
- Arquivo acima do teto (`--teto-mb`, 25 por padrao) e pulado e aparece no
  relatorio. Arquivo que falhar mantem o endereco antigo e entra na lista de
  falhas — rodar de novo tenta so esses.

| Opcao | Para que serve |
| --- | --- |
| *(sem opcao)* | **Padrao:** so inventaria. Nao baixa, nao sobe, nao grava. |
| `--valendo` | Faz o trabalho de verdade: baixa, sobe e troca os enderecos. |
| `--amostra <n>` | Processa so os N primeiros — bom para um teste curto. |
| `--teto-mb <n>` | Teto de tamanho por arquivo. Default: 25. |
| `--sem-rede` | Proibe download: usa so a copia local do backup. |
| `--bucket <nome>` | Bucket do armazenamento. Tambem lido de `MSG_STORAGE_BUCKET`. |
| `--sem-banco` | Sobe os arquivos e **nao** mexe no endereco das mensagens. |
| `--destino-local <dir>` | Grava numa pasta local em vez do armazenamento (para conferencia). Exige `--url-publica-base`. |
| `--recomecar` | Ignora o progresso e reprocessa tudo. |

## Quarto passo: respostas rapidas e anexos (`config-restante.mjs`)

```bash
node scripts/importar/config-restante.mjs --pasta "/caminho/do/backup" --dry
```

- **Respostas rapidas** (os textos do atalho "/") entram como respostas da
  **conta**, disponiveis para todo mundo. O atalho e ajustado para o formato que o
  painel aceita (minusculas, numeros, `-` e `_`); se dois atalhos diferentes
  virarem o mesmo, **o segundo nao entra** e aparece no relatorio para voce
  escolher o novo nome — nada e sobrescrito no chute.
- Resposta que usava **variavel** do sistema antigo (`{Nome}`, `{Empresa}`) entra
  com o texto como esta: o painel nao troca variavel em resposta rapida. O texto
  cai no campo de digitacao e o atendente ajusta antes de enviar.
- **Precisa da migracao `supabase/migrations/0020_respostas_rapidas_origem.sql`**
  aplicada. Sem ela o passo para antes de gravar, em vez de deixar duas copias de
  cada resposta.
- Atalho que **ja existe** na sua instalacao (criado na tela pela equipe) **nao e
  sobrescrito**: a resposta antiga fica de fora e aparece no relatorio, para voce
  renomear uma das duas e rodar de novo. Reimportar a mesma resposta, sim,
  atualiza — a chave de origem cuida disso.
- **Anexos da biblioteca** sao medidos e listados num arquivo
  (`anexos-biblioteca.json`). Este passo so **conta**; quem traz o acervo de
  verdade e o `anexos.mjs` (secao abaixo). Atencao ao numero: a tela de anexos do
  sistema antigo e **paginada** e o backup normalmente guardou so a primeira
  pagina. Quando isso acontece o relatorio diz **INVENTARIO PARCIAL** e mostra os
  dois numeros — o total que a origem declara (o que vale) e o que ha para listar
  aqui.

## A biblioteca de anexos (`anexos.mjs`)

A **biblioteca de anexos** e o material que a sua equipe reusa todo dia: tabela de
precos, catalogo, contrato, guia de implantacao. No sistema antigo ela e uma tela
propria, e os fluxos de automacao mandam esses arquivos pelo **id** que eles tem
lá. Este passo traz o acervo para a sua instalacao.

Como na midia das mensagens, **o arquivo nao fica com voce**: o endereco aponta
para o armazenamento da ferramenta antiga e para de funcionar quando a conta for
encerrada. Este passo baixa cada arquivo, sobe para o armazenamento da **sua**
instalacao e grava o endereco **novo**.

```bash
# 1) so contar: quantos anexos, que tipos, e qual apelido (chave) cada um teria.
#    (padrao — nao baixa, nao sobe, nao grava)
node scripts/importar/anexos.mjs --pasta "/caminho/do/backup"

# 2) valendo (exige a migration 0024_anexos_biblioteca.sql aplicada)
export MSG_SUPABASE_URL="https://xxxx.supabase.co"
export MSG_SUPABASE_SERVICE_KEY="a-sua-chave-service-role"
node scripts/importar/anexos.mjs --pasta "/caminho/do/backup" --valendo
```

> **Rode este passo ANTES de converter os fluxos.** Ele deixa no backup um mapa
> (`config/anexos-chaves.json`) ligando o id antigo de cada arquivo ao apelido
> novo. E esse mapa que faz o passo "enviar arquivo" dos seus fluxos ser convertido
> de verdade; sem ele, cada um desses passos sai como pendencia para voce resolver
> a mao.

- Cada arquivo ganha um **apelido** (a "chave") tirado do proprio nome: *Tabela de
  Precos 2026.xlsx* vira `tabela-de-precos-2026-xlsx`. E o apelido que os fluxos
  guardam, e ele **nao muda** quando voce sobe uma versao nova do arquivo.
- Dois arquivos com o mesmo nome? O segundo ganha um numero no fim. Nada e
  sobrescrito no chute.
- **Rodar de novo e seguro**: o mesmo arquivo escreve no mesmo lugar, entao a
  segunda rodada atualiza em vez de duplicar o acervo.
- Arquivo acima do teto (`--teto-mb`, 25 por padrao), arquivo sem endereco e
  arquivo de tipo recusado (`.svg`, `.html`) **ficam de fora e aparecem no
  relatorio com o motivo** — pagina web no armazenamento publico da sua instalacao
  seria um risco de seguranca, nao um anexo.
- Se a tela de anexos do sistema antigo tinha **mais paginas** do que o backup
  guardou, o relatorio diz isso na cara: os arquivos que faltam nao estao aqui para
  importar, e os fluxos que usam esses arquivos continuam saindo como pendencia.

| Opcao | Para que serve |
| --- | --- |
| *(sem opcao)* | **Padrao:** so inventaria. Nao baixa, nao sobe, nao grava. |
| `--valendo` | Faz o trabalho de verdade: baixa, sobe e grava o acervo. |
| `--amostra <n>` | Processa so os N primeiros — teste curto. |
| `--teto-mb <n>` | Teto de tamanho por arquivo. Default: 25. |
| `--pasta-arquivos <dir>` | Onde estao os arquivos ja baixados, se voce os tiver em disco. |
| `--sem-rede` | Proibe download: usa so o que ja esta em `--pasta-arquivos`. |
| `--sem-banco` | Sobe os arquivos e **nao** grava linha na biblioteca. |
| `--destino-local <dir>` | Grava numa pasta local em vez do armazenamento (para conferencia). Exige `--url-publica-base`. |
| `--bucket <nome>` | Bucket do armazenamento. Tambem lido de `MSG_STORAGE_BUCKET`. |

## Quinto passo: as intencoes (`intencoes.mjs`)

As **intencoes** sao o que faz o painel entender o que a pessoa quis dizer —
"quero atendente", "nao consegui participar", "quanto custa" — por palavra-chave e
frase de exemplo, em vez de dezenas de regras de texto escritas a mao. Este passo
traz o catalogo que a sua operacao levou anos calibrando.

```bash
# 1) simular (nao abre conexao, nao grava nada)
node scripts/importar/intencoes.mjs --pasta "/caminho/do/backup" --dry

# 2) valendo (exige a migration 0022_intencoes.sql aplicada)
node scripts/importar/intencoes.mjs --pasta "/caminho/do/backup" \
  --url https://SEU-PROJETO.supabase.co --key SUA_CHAVE_SERVICE_ROLE
```

> **Aponte `--pasta` para a pasta da SUA conta** — a que tem `automacao/` dentro.
> Se a pasta tiver telas de contas diferentes, o comando **para** e lista o que
> encontrou: juntar tudo criaria um catalogo com as palavras-chave de varias
> empresas, e o termo de uma passaria a valer na instalacao de outra.

**A pontuacao minima e o coracao disso, e ela vem da propria ferramenta antiga:**
palavra-chave encontrada vale **10**, frase de exemplo **igual** a mensagem vale
**100**, frase **parecida** vale **2**, e cada intencao tem o total minimo que ela
precisa somar (o padrao dela e **2**). O passo reproduz essa escala — sem isso uma
intencao configurada para exigir 100 (so a frase exata) passaria a disparar com
uma palavra solta.

O que voce precisa conferir no relatorio:

- **Mesmo nome em bots diferentes.** No sistema antigo a intencao pertencia a um
  chatbot; aqui o catalogo e da instalacao inteira (um nome, uma intencao). Onde o
  nome se repetia, as palavras-chave e as frases foram **unidas** (nenhum termo seu
  e jogado fora) e ficou a pontuacao minima **mais alta** — a que dispara
  **menos**. Isso e de proposito: deixar de disparar voce percebe na primeira
  conversa; passar a disparar onde antes nao disparava some no meio de mil
  atendimentos. Cada caso aparece no relatorio com os dois valores.
- **Palavra-chave de uma letra so.** Sao listadas para conferencia: algumas sao
  legitimas ("n" e como gente escreve "nao"), mas uma letra e encontrada em quase
  toda mensagem e vale 10 pontos.
- **Pontuacao ilegivel** na origem: entra com o padrao 2 e aparece na lista.

Coisas que este passo **nao** faz:

- **Nao liga intencao a fluxo.** Intencao sozinha nao dispara nada: ela passa a
  valer quando um fluxo tiver um passo de condicao com o campo **intencao**. Fazer
  essa ligacao continua sendo escolha sua, na tela de Fluxos.
- **Nao usa IA e nao tem custo por mensagem.** O reconhecimento acontece dentro da
  sua instalacao, por palavra-chave e frase; o texto das suas conversas nao sai
  para servico nenhum.
- Nao cria tabela e nao apaga nada.

| Opcao | Para que serve |
| --- | --- |
| `--pasta <dir>` | Pasta do backup da sua conta. **Obrigatoria.** |
| `--dry` | Simula. Nao abre conexao e nao grava nada. |
| `--juntar-contas` | Aceita telas de contas diferentes num catalogo unico. Leia o aviso acima antes. |
| `--detalhe` | Inclui nomes e termos no relatorio (e **dado seu**: o relatorio vira material sensivel). |
| `--limite <n>` | Processa so as N primeiras intencoes — teste curto. |
| `--dump <arq>` | So com `--dry`: grava as linhas exatas que entrariam, para conferir campo a campo. |
| `--origem-sistema <s>` | Rotulo do sistema de origem gravado em `origem_ferramenta`. Default: `chatguru`. |

Rodar de novo e seguro: a intencao e reconhecida pelo identificador que tinha na
origem, entao a segunda execucao **atualiza** em vez de duplicar. Nome que **ja
existe** no painel nao e sobrescrito — a intencao fica de fora e aparece no
relatorio para voce renomear uma das duas.

## Medir tudo de uma vez, sem gravar (`lote.mjs`)

```bash
node scripts/importar/lote.mjs --raiz "/pasta/com/varios/backups" --dry
```

Roda a simulacao em cada backup encontrado e junta tudo numa tabela por conta,
com os totais. Serve para dimensionar a migracao antes de comecar.

**Este comando nao grava, e nao aceita `--url` nem `--key`.** Cada backup e de
uma empresa diferente, com banco proprio: a carga de verdade e sempre uma conta
por vez, apontando para a instalacao daquele cliente.

## Conferir as referencias de um backup (`referencias.mjs`)

```bash
node scripts/importar/referencias.mjs --pasta "/caminho/do/backup"
```

Mostra, por tipo de referencia (etiqueta, usuario, departamento, etapa de funil,
dialogo), quantas apontam para algo que existe, quantas ficaram **ambiguas** e
quantas apontam para algo que **nao existe mais**. Ambigua e inexistente sempre
viram ressalva no relatorio: o importador nao escolhe no chute.

## Para onde vai cada coisa

| No ChatGuru | Na sua instalacao |
| --- | --- |
| Conversa | uma linha em `conversas` (ou `conversas_<canal>`), com nome, status, arquivada e etiquetas |
| Mensagem recebida | `mensagens`, direcao `in` |
| Mensagem enviada | `mensagens`, direcao `out`, com o **nome** de quem enviou |
| Anotacao interna | `mensagens`, direcao `interna` — aparece na conversa como anotacao, nao vai para o cliente |
| Etiquetas | catalogo em `etiquetas_catalogo` + a marcacao em cada conversa |
| Usuarios/atendentes | so o mapa de nomes, guardado em `config`. **Nao vira conta de login** |
| Funis e etapas | `funis` e `funil_etapas`, e a etapa de cada conversa em `conversa_funil` — importados no **segundo passo**, `funis.mjs` (secao abaixo) |
| Arquivos (foto, audio, PDF) | o endereco antigo entra junto com a mensagem; trocar pelo arquivo re-hospedado na sua instalacao e o **terceiro passo**, `midia.mjs` |
| Citacao ("respondendo a"), reacao, edicao, encaminhada | preservadas na mensagem |
| Mensagem apagada para todos | entra marcada, aparecendo como "Mensagem apagada" |
| Recibo de entrega (enviado / entregue / lido) | preservado como estava no sistema antigo |
| Respostas rapidas | `respostas_rapidas`, como respostas da conta — **quarto passo**, `config-restante.mjs` |
| Intencoes (palavra-chave, frase de exemplo, pontuacao minima) | `intencoes`, como catalogo da instalacao — **quinto passo**, `intencoes.mjs` |
| Biblioteca de anexos | `anexos`, com o arquivo re-hospedado na sua instalacao e o apelido que os fluxos usam — passo `anexos.mjs` |

---

## Limites conhecidos desta versao

- **Funis e etapas** entram num **segundo passo** (`funis.mjs`), depois que as
  conversas ja estiverem no banco e a migration `supabase/migrations/0009_funis.sql`
  tiver sido aplicada. Rodar a migration continua sendo gesto humano no SQL editor.
- **Mídia** entra num passo proprio (`midia.mjs`, secao abaixo), depois das
  conversas: e ele que baixa o arquivo, sobe pro armazenamento da sua instalacao e
  troca o endereco antigo pelo novo em cada mensagem.
- **Listas de transmissao nao entram.** No sistema antigo elas aparecem como se
  fossem conversa, mas o "telefone" delas nao e telefone (e um numero de controle
  interno). Importar criaria um contato falso, pra onde alguem poderia responder.
  O relatorio diz quantas eram e quantos itens tinham.
- **Biblioteca de anexos** entra num passo proprio (`anexos.mjs`), que precisa da
  migration `supabase/migrations/0024_anexos_biblioteca.sql` aplicada e deve rodar
  **antes** da conversao dos fluxos. O que o backup nao capturou (a tela de anexos
  e paginada) nao pode ser importado: aparece no relatorio com os dois numeros.
- **Atendentes antigos nao ganham login.** O nome deles aparece nas mensagens
  historicas; para o atendente voltar a trabalhar, crie a conta normalmente no
  painel.
- **Envio de robo/campanha** do sistema antigo entra sem autor — o painel mostra
  "atendimento (fora do painel)", que e o correto: nao foi ninguem do time.
- **Tipos de mensagem sem equivalente** (chamada perdida, mensagem apagada,
  mensagem cifrada) sao descartados de proposito e contados no relatorio.

---

## Trazer tambem as campanhas antigas

O historico de **campanhas** (os disparos que a empresa ja fez no sistema antigo)
vem por um comando separado:

```bash
node scripts/importar/campanhas.mjs --pasta "/caminho/do/backup" --dry
```

Depois de conferir o relatorio, rode sem o `--dry` (com as mesmas variaveis de
ambiente do importador de conversas).

**Campanha importada e so registro: ela nao dispara mensagem em nenhuma
circunstancia.** Isso nao depende de disciplina do programa — o proprio banco
recusa colocar uma campanha historica em funcionamento, e ela nem chega a ter
lista de destinatarios.

O que vem: nome, situacao, progresso, quantidade de destinatarios, o fluxo
associado e as datas. Rodar duas vezes nao duplica nada.

Se algumas campanhas aparecerem no relatorio como "sem id do fluxo": o nome do
fluxo delas foi preservado e continua legivel; o que falta e o link que leva ate
ele, porque o sistema antigo so publica esse link em parte das linhas.

## Se der problema

| O que aparece | O que fazer |
| --- | --- |
| `pasta nao encontrada` | Confira o caminho. Com espacos no nome, use aspas. |
| `nao consegui ler chats_index.json` | A pasta apontada nao e a raiz do backup — procure a pasta que tem o `chats_index.json`. |
| `HTTP 401` ou `HTTP 403` | A chave esta errada, incompleta ou nao e a `service_role`. |
| `HTTP 404` na tabela | O banco ainda nao tem as tabelas do painel: rode as migracoes da instalacao antes. |
| `Ja existe uma importacao rodando` | Ha outra copia em andamento. Se tiver certeza de que morreu, apague o `rodando.lock` da pasta de trabalho. |

---

# Importar pesquisas de satisfacao (NPS) — `nps.mjs`

Script separado, para trazer as respostas de NPS que voce ja coletou na
ferramenta antiga. Elas entram como **dado historico**: ficam consultaveis no
painel (`/api/relatorios/nps`), ligadas a conversa de origem quando der, mas o
painel **nao passa a enviar pesquisa de NPS** — isso e outra coisa, e nao entra
nesta versao.

Nao confunda com a **pesquisa de satisfacao do proprio painel** (nota de 1 a 5,
enviada ao concluir o atendimento). Sao duas escalas diferentes e o relatorio
mostra as duas separadas, nunca somadas.

```bash
# 1) confira antes de gravar (nao abre conexao nenhuma)
node scripts/importar/nps.mjs --arquivo respostas.csv --pesquisa "NPS" --dry

# 2) grave
node scripts/importar/nps.mjs --arquivo respostas.csv --pesquisa "NPS" \
  --url https://<projeto>.supabase.co --key <service_role>
```

- Aceita **`.csv`**, **`.json`** e **`.html`** (a primeira tabela da pagina, para
  quando a unica copia que sobrou foi a tela salva).
- Adivinha as colunas pelo nome (nota, comentario, data, telefone); se errar,
  aponte na mao com `--col-nota`, `--col-data` etc. — `--help` lista todas.
- Rodar de novo **nunca duplica**: o banco deduplica a resposta.
- Precisa da migracao `0013_relatorios.sql` aplicada (e ela que cria as tabelas).
- O relatorio na tela sai **so com contagem** — resposta de pesquisa e dado de
  cliente e nao vira texto no terminal.

**Antes de exportar, prefira o CSV nativo da ferramenta antiga.** A tela salva
costuma vir com filtro de periodo embutido (90 dias, por exemplo), e ai o
arquivo tem menos respostas do que a sua conta realmente coletou.
