# Exportar dados e ler satisfação (CSAT / NPS)

Duas abas na visão de relatórios: **Exportar dados** e **Satisfação**.

## A porta de exportação: `/api/exportar`

### Por que não fica em `/api/relatorios`

O portão dos relatórios (`lib/relatorios-acesso.ts`) promete uma coisa, com todas as
letras, depois de já ter sido violado uma vez: **o que sai por ali é número; lista de
conversa não sai**. Uma consulta de mensagens é o oposto — ela existe pra tirar
**linha** do sistema. Enfiar linha naquele portão quebraria o invariante que a
próxima pessoa vai ler e confiar, e herdaria a ressalva de escopo declarada lá
("filtrar por escopo é trabalho no SQL, não ajuste de rota"), que numa exportação de
linha não é ressalva: é vazamento.

### As quatro consultas

| consulta | o que sai | quem pode |
|---|---|---|
| **Mensagens** | uma linha por mensagem trocada com o cliente | visão sem recorte |
| **Anotações internas** | o que a equipe escreveu na conversa (nunca foi pro cliente) | visão sem recorte |
| **Usuários do painel** | papel, escopo, ativo, entrada — sem senha e **sem e-mail** | `gerenciar_usuarios` |
| **Acessos por dispositivo** | pessoa × navegador × sistema, com primeiro/último acesso e IP | `gerenciar_usuarios` |

Sobre todas elas, `relatorios_exportar`. Papel **nomeado** criado antes dessa
permissão não a ganha sozinho — marcar na tela de papéis.

### "Visão sem recorte", e por que a recusa é melhor que o arquivo

**Quatro** recortes existem no painel, e **qualquer um deles** recusa a exportação de
conversa, com a razão na tela:

1. **escopo de visão** (próprias / departamento);
2. **restrição por funil ou canal**;
3. **contexto embutido** (widget);
4. **ACL por conversa** (`mensageria.conversa_visibilidade`) — conversa travada para
   pessoas específicas. Este é o que estava faltando, e a falta era um vazamento: a
   ACL é avaliada **antes** do atalho "escopo todas", então a conversa fica invisível
   na tela para quem tem o escopo padrão de fábrica, e o CSV a entregava com conteúdo
   e telefone dentro.

A checagem da ACL é grossa de propósito: **existe alguma ACL nesta instalação?** Se
existe, a exportação de conversa não sai. Não é "quais conversas têm ACL" — um CSV não
sabe recortar, e recusar por causa de uma ACL que talvez não pegasse esta pessoa é um
falso negativo barato; o falso positivo custa o vazamento.

Um CSV não sabe respeitar recorte por conversa. As alternativas seriam filtrar
conversa por conversa (`podeVerConversa` × N mil, e mesmo assim aproximado) ou
exportar tudo — e "exportar tudo pra quem vê uma parte" é a definição do problema.
Recusar com a frase certa é a única opção que não mente.

Três pontos falham **fechado** de propósito: contexto embutido inválido, leitura de
restrição que não voltou e falha ao ler a ACL contam como recorte, não como liberado.
A única exceção é a **tabela de ACL ausente** (migration 0004 não aplicada), que
libera — sem tabela não existe recorte para furar.

E é justamente por ser a única exceção que **o mapeamento do erro é a superfície mais
perigosa daqui**: `tabela_ausente` é o único valor que libera. Quem decide isso é uma
função pura, `estadoDaAcl` (`lib/exportacao.ts`), e ela aceita **um** código:

| o que o banco respondeu | vira | efeito |
|---|---|---|
| `42P01` (relation does not exist) | `tabela_ausente` | libera |
| `PGRST205` / `PGRST204` (cache do PostgREST) | `ilegivel` | **recusa** |
| `42703`, permissão, rede, erro sem código | `ilegivel` | **recusa** |
| a leitura **estourou** (exceção) | `ilegivel` | **recusa** |
| sem erro, contagem 0 | `nenhuma` | libera |
| sem erro, contagem nula | `ilegivel` | **recusa** |

`PGRST205` ("could not find the table in the schema cache") **não** é schema ausente:
é o estado transitório do PostgREST logo depois de um DDL, enquanto o cache não
recarregou. Aceitá-lo como tabela ausente reabria o vazamento numa instalação que
**tem** ACL, por alguns segundos, na hora exata em que alguém estava mexendo no
schema. `conversa_visibilidade` é da migration 0004: se ela não existe, o Postgres diz
`42P01` e ponto. O custo de recusar é um "tente de novo".

Por isso a rota **não** usa o `semTabela` dela para esta decisão, apesar de existir ali
do lado: aquele é generoso de propósito (serve para decidir 503 em tabela opcional), e
generosidade aqui libera exportação.

**A leitura entra por parâmetro, e isso é sobre prova.** `aclDeConversa(ler)` recebe o
executor; na rota sobra `lerAclDeConversa()`, uma expressão que devolve a consulta.
Enquanto a decisão morava dentro da rota, a única prova possível era varredura de
texto — e varredura protege a chamada, não o corpo: um `if (count) return "nenhuma"`
acrescentado no meio do helper liberava tudo com a bateria verde. Com o executor
injetado, a prova roda os cinco desfechos com um fake no lugar do banco e confere o
resultado (403 ou prossegue). Quem for mexer aqui: a decisão vive em
`lib/exportacao.ts` e é provada por comportamento; a rota só faz I/O.

### Super admin passa por cima dos quatro

E isso é decisão, não esquecimento: `conversaVisivel` também libera o super admin na
primeira camada, então a exportação apenas repete a regra do painel. Na prática:
**quem é super admin exporta a operação inteira, inclusive conversas com ACL**. Quem
não quer isso não dá super admin — dá um papel nomeado com `relatorios_exportar`, que
passa pelos quatro recortes normalmente.

### Contagem antes do arquivo

Sem `formato=csv`, a rota devolve **contagem e nomes de coluna** — linha nenhuma,
nem "as 10 primeiras" (seria um segundo caminho de leitura, mais frouxo que o CSV).
A tela mostra o número antes de oferecer o download.

**Acima de 50.000 linhas a exportação é recusada** (HTTP 413) com o número real, e a
mensagem manda estreitar o período. Arquivo cortado na linha 50.000 é o pior
desfecho possível: ninguém que abre a planilha descobre que faltou o resto.

### Detalhes que valem saber

- **Anotação é mensagem com `direcao='interna'`** (mesmo formato das notas
  importadas). As duas consultas leem a mesma tabela com filtros opostos.
- **Mensagem apagada não devolve o texto original** — sai como
  `(mensagem apagada)`. O painel já trata assim na tela; exportar o conteúdo
  desfaria isso num arquivo solto.
- **Fórmula neutralizada**: valor de terceiro começando com `=`, `+`, `-` ou `@`
  ganha apóstrofo. `=cmd|...` numa célula do Excel é execução de comando.
- **E-mail não sai** na consulta de usuários. O arquivo identifica pelo `user_id`,
  que é o que cruza com as outras tabelas. Uma planilha com a lista completa de
  logins da empresa é material de phishing pronto, e não responde nenhuma das
  perguntas da consulta (quem tem acesso, com que papel, ativo ou não).
- **`user_agent` e a impressão do dispositivo não saem**: são assinatura técnica, e
  o user-agent é texto escolhido pelo cliente.
- **Falha no meio do download entra no arquivo**, como última linha
  (`# EXPORTACAO INTERROMPIDA: ...`). O HTTP 200 já foi; melhor uma planilha que
  avisa do que uma que simplesmente termina antes.
- **Arquivo curto também é denunciado**: no fim do streaming a rota compara as linhas
  escritas com a contagem e, se escreveu menos, fecha com
  `# EXPORTACAO INCOMPLETA: N de M`. Isso pega o short-read silencioso (um
  `db-max-rows` menor que a página, um erro engolido) que antes encerrava o arquivo
  mais cedo com HTTP 200 e sem marca nenhuma. A tela fareja essa última linha e avisa
  — o arquivo é salvo de todo jeito, porque ele é a evidência.
- **A marca é do sistema, e o cliente não consegue imitá-la.** O conteúdo das
  mensagens exportadas é escrito por terceiro, e o CSV de mensagem tem campo de texto
  com quebra de linha dentro: uma mensagem com
  `"\n# EXPORTACAO INCOMPLETA: ... ligue 0800"` chegava a virar aviso do **sistema** na
  tela do gestor, e podia mascarar a marca de verdade. Três coisas fecham isso, e vale
  saber ao mexer no texto das marcas:
  1. **só a última linha conta** — as duas marcas são sempre o último `push` do stream;
  2. **linha com `"` é recusada** — o texto das marcas não tem `,`, `;` nem `"`, então
     `csvCampo` nunca as aspa; campo de texto continuado sempre carrega a aspa que
     abre ou fecha o campo. Por isso o texto do erro do banco entra **saneado** (vírgula
     do Postgres aspava a linha inteira) e **mexer no texto das marcas exige manter
     essa regra** — há prova cravando isso;
  3. **a forma inteira, não o prefixo** — a marca tem o contador (`N de M linha(s)`), e
     acertar a forma sem aspa nenhuma não está no alcance de quem só escreve texto;
  4. **pelo menos duas linhas** — ver o item seguinte, é o que fecha a brecha que a
     leitura por cauda abriu.
- **A tela lê só a cauda do arquivo** (`blob.slice`, 4 KB): a marca tem menos de 300
  bytes e é sempre a última linha, e `blob.text()` num arquivo de 50 mil linhas
  materializava dezenas de MB de string na aba de quem baixou. **Mas a fatia pode cair
  no meio do texto do cliente**: se a última linha do CSV for maior que a janela, a
  cauda vira um fragmento único cujo "começo de linha" foi *fabricado pelo corte* — e
  aí a regra da aspa não pega, porque uma mensagem sem vírgula, sem ponto-e-vírgula,
  sem aspa e sem quebra de linha não é aspada. O alinhamento fica todo na mão de quem
  escreve a mensagem (o que vem depois da marca é texto dele, e o corte é sempre a
  4096 bytes do fim; a ordenação `id ASC` põe a mensagem mais nova na última linha).
  Fecha com a exigência de **duas linhas**: marca legítima tem menos de 300 bytes,
  então a janela sempre contém a quebra de linha anterior a ela, e arquivo menor que a
  janela é lido inteiro, com o cabeçalho dentro. Quem mexer na janela: ela não pode
  encolher para perto do tamanho da marca — janela apertada não libera nada, mas volta
  a **esconder a marca real** (o arquivo curto sendo salvo calado), e há prova exigindo
  pelo menos 1 KB.
- **Ordem de paginação é determinística**: `criada_em` não é única (o importador grava
  o timestamp da origem, e rajada empata), então a ordenação leva `id` como
  desempate. Paginação por OFFSET sobre ordem ambígua duplica ou **perde** linha na
  borda da página — e linha perdida num CSV não deixa rastro.
- **Escopo de chave de API**: `/api/exportar` tem recurso **próprio**, `exportacao`,
  e está em `CANAL_PADRAO_EM`. O recurso é separado de `relatorios` de propósito: uma
  chave que recebeu `relatorios` foi consentida para ler **número agregado**, não para
  baixar 50 mil mensagens com conteúdo e telefone por um GET. Chave existente fica
  fail-closed até o dono marcar `exportacao`. Chave restrita a um canal precisa mandar
  `?canal=` explícito — sem isso o default (central) seria negado.

## Satisfação: CSAT e NPS não se somam

- **CSAT** é a pesquisa que **este** painel envia ao concluir atendimento. Escala
  1–5, média simples.
- **NPS** é histórico **importado** de outra ferramenta. Escala 0–10, cálculo por
  promotor/neutro/detrator.

São perguntas diferentes, escalas diferentes e origens diferentes. Um "índice de
satisfação" juntando as duas seria um número que não existe em lugar nenhum — a tela
mostra os dois blocos separados e diz de onde cada um vem.

**O painel não envia NPS.** A decisão está registrada no card: NPS entra como
**dado**, não como funcionalidade (o uso medido na ferramenta de origem foi 1,45% de
taxa de resposta). Número novo só aparece com importação nova.

O que a tela avisa, porque cada frase corresponde a um jeito de ler errado:

- resposta importada **sem data** fica fora de qualquer período — e some de todos os
  números da tela se ninguém disser;
- NPS **sem telefone** não dá pra abrir a conversa de quem respondeu;
- pesquisa com **0 resposta no período aparece na lista** mesmo assim: ela existe na
  instalação, e esconder faria parecer que não foi importada;
- **nota zerada é barra vazia, não nota ausente** — "ninguém deu 0" é informação;
- **score 0 e "sem resposta" são coisas diferentes**: metade promotor e metade
  detrator dá 0 de verdade.

### Pendência humana

A **rodada real do importador de NPS** (`scripts/importar/nps.mjs` sem `--dry`)
segue pendente por decisão do Eric. Enquanto não rodar, a tela mostra o CSAT e diz
que o histórico não foi importado — em vez de mostrar zero.
