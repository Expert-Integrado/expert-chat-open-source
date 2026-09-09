# Variáveis de texto — a sintaxe única do painel

Este é **o lugar único** onde a sintaxe de variável está documentada (critério de aceite do
card `86ak86jw9`). Implementação: `lib/fluxo/variaveis.ts` (função pura, zero import).
Prova: `node scripts/prova-variaveis.ts`.

A ideia é o atendente aprender **uma vez**: a mesma escrita vale na resposta rápida e no
texto que o motor de automação manda.

## As duas formas

| Forma | O que é | Exemplo |
|---|---|---|
| `!propriedade` | Dado da conversa, do contato ou de quem está atendendo | `!primeiro_nome` |
| `$variavel` | Variável de **contexto** da conversa — a mesma memória que a condição de fluxo lê (`mensageria.conversa_contexto`) | `$URA` |

### Propriedades (`!`)

| Token | Valor |
|---|---|
| `!nome` | Nome do contato, como está na conversa |
| `!primeiro_nome` | Primeira palavra do nome |
| `!telefone` | Telefone (ou identificador) da conversa |
| `!atendente` | Nome de quem está usando a resposta agora |
| `!saudacao` | `Bom dia` / `Boa tarde` / `Boa noite`, pela hora **da instalação** (fuso de `lib/fuso.ts`) |
| `!campo.<chave>` | Qualquer campo personalizado da ficha |

**Campo personalizado usa a chave normalizada.** A ficha guarda o nome como a pessoa
escreveu ("Nome da empresa", "CNPJ"), e nome com espaço e acento não cabe num token. Então
"Nome da empresa" é alcançado por `!campo.nome_da_empresa` (minúsculas, sem acento, espaço
vira `_`). Sem isso, metade dos campos de uma conta real seria inalcançável.

### Contexto (`$`)

- `$URA` — chave sem espaço.
- `${Reserva confirmada}` — chave com espaço, hífen ou acento (o dialeto importado tem:
  `$Reserva confirmada`, `$QC-IM`).
- **A chave casa por igualdade EXATA**, caixa e acento contam. É a mesma regra da condição de
  fluxo (`docs/fluxo-canonico.md`): normalizar aqui e não lá faria a resposta rápida achar
  uma variável que a condição do fluxo não acha, com a mesma escrita.
- **Chave nua não começa com dígito.** `$50` é preço, não variável — o defeito foi pego pela
  própria prova, com a mensagem "o outro $50" saindo como "o outro ". Quem tiver mesmo uma
  chave que começa com número escreve `${50}`.

## As três regras que decidem o resultado

1. **Variável conhecida sem valor vira VAZIO, nunca o nome dela.** Receber `Oi !nome` é pior
   que receber `Oi`.
2. **Token fora do catálogo fica INTACTO.** `!` e `$` aparecem em texto normal ("Fechado!",
   "R$ 200", "50% off!"), e comer isso estragaria mensagem que estava certa. Não há escape a
   aprender: o catálogo é o que decide o que é variável.
3. **Uma varredura só, sem cascata.** O valor que entra no lugar de um token nunca volta a
   ser examinado. Isto fechou um furo real: nome de contato — que é conteúdo de **terceiro**,
   vindo do WhatsApp ou da ficha importada — podia conter `$URA` e trazer para o texto o
   valor de uma variável de contexto que ninguém pediu.

## Onde a substituição acontece hoje

| Lugar | Estado |
|---|---|
| **Resposta rápida** (`GET /api/respostas-rapidas?canal=&chat_id=`) | **Feito.** Cada resposta volta com `texto_resolvido`, mais `variaveis_preenchidas` / `variaveis_vazias`. Sem `chat_id`, a lista sai crua (a tela de cadastro tem que mostrar o template). |
| **Composer** (a caixa de texto do atendente) | **Costura declarada.** `app/home.tsx` tem outro dono nesta onda: a tela passa `canal`/`chat_id` no fetch que já faz e insere `texto_resolvido`. O texto entra no RASCUNHO — o atendente vê e edita antes de enviar (critério de aceite). |
| **Texto de ação de fluxo** (`enviar_texto`, `nota_interna`) | **NÃO substitui ainda,** e é fronteira declarada, não esquecimento: quem escreve a mensagem que sai sozinha é o motor, e ligar a substituição lá muda o comportamento de fluxo **já importado** (a base tem 4.543 referências `$contexto` vindas da migração). Entra junto com a ingestão de contexto, que é a pendência aberta do motor de automação. A lib já é a mesma — falta só o motor chamá-la. |
| **Disparo em massa** | Tem sintaxe PRÓPRIA e ANTERIOR (`{{chave}}`, `lib/disparo/*`). Não foi mexida aqui: unificar é mudança de comportamento em campanha gravada, e campanha em massa é o lugar errado pra descobrir isso. Pendência declarada. |

## O formato do sistema antigo (`{CHAVE}`)

A importação traz respostas rápidas escritas na sintaxe da ferramenta antiga. **Medido em 32
contas importadas (177 respostas):** `{PRIMEIRO_NOME_LEAD}` 42x, `{DAY_GREETING}` 12x,
`{TELEFONE_LEAD}` 3x, `{NOME_LEAD}` 1x — e mais `{Empresa}` 4x, `{Email}` 4x, `{CNPJ}` 2x, que **não são variáveis de sistema**: são campos da ficha.

Como fica:

- O formato antigo só é interpretado em resposta que **veio de importação**
  (`origem_ferramenta` preenchido, migration 0020). Texto escrito na tela do painel usa a
  sintaxe daqui — olhar `{...}` nele transformaria chave de JSON colada no texto em variável.
- As quatro variáveis de sistema medidas viram propriedade daqui (tabela `ALIAS_LEGADO`).
- O que não é variável de sistema é procurado como **campo da ficha**.
- **O que ninguém resolve fica LITERAL**, e vai em `variaveis_nao_resolvidas`. Assimetria
  proposital em relação à regra 1: `{...}` não é sintaxe daqui, e apagar calado o que sobrou
  da importação esconderia justamente o texto que alguém precisa consertar.
