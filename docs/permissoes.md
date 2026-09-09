# Permissoes: papel nomeado e escopo de visao

Doc vivo. Cards de origem: **86ak858uu** (perfis de permissao: papel nomeado) e
**86ak858v3** (escopo de visao: conta inteira ou departamento).

## O problema que isto resolve

A ferramenta antiga tinha **90 permissoes em 17 grupos, marcadas caixa a caixa, por
pessoa**. A prova de que o desenho nao escala esta numa conta real que migramos:
os tipos oferecidos sao "Administrador (todas)" e "Normal (personalizadas)", mas
a usuaria do tipo NORMAL tem **85 caixas marcadas — mais que o ADMIN, com 80**, e
um superconjunto estrito das dele. Ninguem consegue mais dizer o que um "normal"
pode fazer naquela conta.

Aqui a unidade de configuracao e o **papel nomeado**: um conjunto de permissoes
com nome ("Supervisor comercial"), atribuido a pessoa. O ajuste individual
existe, mas como **excecao declarada e visivel** — a tela destaca em amarelo —,
nunca como o jeito normal de configurar.

## As quatro camadas (ortogonais, e nesta ordem)

| Camada | Onde mora | Governa |
|---|---|---|
| 1. Papel base | `perfis.papel` (`super_admin` \| `normal`) | quem e dono da instalacao |
| 2. Papel nomeado | `papeis` + `perfis.papel_id` (nullable) | o que a pessoa PODE FAZER |
| 3. Escopo de visao | `perfis.escopo_visao` + `departamentos.escopo_visao` | QUANTAS conversas ela ve |
| 4. Recorte por conversa | `conversa_visibilidade` (ACL dura, F9) e `perfil_contextos` (BU) | quais conversas, uma a uma |

Camadas 3 e 4 ja existiam desde 14-17/08/2026 e **nao foram reconstruidas**. A
Frente E acrescentou a camada 2 e ligou as duas primeiras nas rotas.

## A lista canonica de permissoes

Dez, pequenas e documentadas. Fonte unica: `lib/permissoes.ts` (`PERMISSOES` +
`DESCRICAO_PERMISSAO`). **Permissao sem verbete nao existe, e verbete sem rota
que o consuma e permissao morta** — a prova falha nos dois casos.

| Permissao | Rotas que a exigem |
|---|---|
| `ver_todas_conversas` | teto do escopo de visao (nao e uma rota) |
| `enviar` | `/api/send`, `/api/forward` |
| `concluir` | `/api/conversa` (status, arquivada) |
| `disparo` | `/api/agendadas` (POST) |
| `relatorios` | `/api/relatorio` |
| `gerenciar_etiquetas` | `/api/admin/ficha-config` |
| `gerenciar_usuarios` | `/api/admin/usuarios`, `/api/admin/departamentos`, `/api/admin/papeis` |
| `gerenciar_visibilidade` | `/api/visibilidade`, `/api/conversa` (ACL e auto-arquivar) |
| `gerenciar_canais` | `/api/sync-chatguru` |
| `automacao` | `/api/admin/config` |

`automacao` e **configurar** automacao, nao **executar** macro: executar segue
gateado so por `podeVerConversa`, como sempre foi.

## Compatibilidade — a invariante que manda em tudo

**`perfis.papel_id` nasce NULL, e NULL significa "se comporta exatamente como
antes".** Instalacao que ja roda nao muda de comportamento no dia do deploy;
atribuir papel e um gesto explicito do admin, uma pessoa por vez.

O mecanismo e `PAPEIS_EMBUTIDOS` em `lib/permissoes.ts`, que reproduz permissao
a permissao o painel anterior:

- `super_admin` -> tudo (era o que `ehAdmin` liberava);
- `normal` -> `enviar`, `concluir`, `disparo` (era o que um atendente fazia).

`ver_todas_conversas` no caminho legado e **derivada** do `escopo_visao`, nunca o
contrario. Deixar a permissao mandar no escopo de quem nunca a configurou
tiraria acesso de todo mundo de uma vez.

### Teto de escopo (so pra quem tem papel nomeado)

Quem TEM papel nomeado e nao recebeu `ver_todas_conversas` **nao pode** ficar com
escopo `todas`: cai pra `departamento`. O papel e a fonte, e permissao ausente
nega. Quem nao tem papel nomeado sai com o escopo intacto (`escopoComTeto`).

### Degradacao segura

- **Migration 0010 ainda nao rodou**: `getPerfil` tenta o select largo e, se ele
  falhar, cai no select ANTIGO. Isso importa muito — se o select inteiro
  falhasse, o perfil viraria o PADRAO (`normal` + `todas`), o que **rebaixaria
  super admin e promoveria quem tem escopo `proprias` a ver a conta inteira**. A
  tela de usuarios recebe `papeis_disponiveis:false` e esconde a secao.
- **Catalogo de papeis ilegivel** (falha transitoria): serve o **ultimo cache
  bom**, mesmo vencido. Se nunca deu certo e a pessoa TEM `papel_id`, e
  **fail-closed**: zero permissao **do papel** e escopo rebaixado pra `proprias`.
  As **excecoes individuais explicitas continuam valendo** — sao concessao que o
  admin gravou naquela pessoa, nao dependem do catalogo pra serem lidas, e nao ha
  por que revoga-las por causa de falha de leitura de outra tabela. Isto foi um
  fail-OPEN corrigido em 31/08 — a versao anterior caia no embutido `normal`, e
  por ate 60s um "Somente leitura" ganhava enviar/concluir/disparo e um
  "Atendente" com `escopo_visao=todas` na coluna recuperava a visao total. Quem
  NAO tem `papel_id` segue no embutido, como sempre.
- **Papel apagado ou desativado**: fail-closed, zero permissao. Desativar um
  papel e tirar acesso de proposito, entao nao pode virar "de volta ao padrao"
  silenciosamente. Apagar, ao contrario, devolve as pessoas ao padrao
  (`ON DELETE SET NULL`) e a rota exige `confirmar=1` quando ha gente no papel.
- **Excecao nao rebaixa super admin** — senao da pra se trancar pra fora.
- **Permissao desconhecida gravada no banco e ignorada** na leitura (instalacao
  velha nao quebra quando a lista cresce), mas **recusada** na escrita pela rota
  de cadastro (engolir um nome errado calado deixaria o admin achando que
  configurou).

## Travas contra escalada de privilegio

Uma revisao cega em 31/08 **reprovou** a primeira versao desta feature: ao trocar
`ehAdmin` por `gerenciar_usuarios`, essa permissao virava **administrador total**,
porque quem administra usuarios podia se auto-promover. Tres travas fecham isso, e
as tres sao funcoes puras em `lib/permissoes.ts` que **as rotas chamam** (nao ha
copia da regra em lugar nenhum):

| Trava | Funcao | Regra |
|---|---|---|
| Papel base e privativo | `bloqueiaTrocaDePapelBase` | so quem JA e super admin muda `perfis.papel`. O conjunto de quem cunha super admin continua sendo `{super_admin}` |
| Nao se edita a si mesmo | `editaPropriaAutorizacao` | ninguem grava o proprio `papel_id` nem a propria excecao (super admin isento, pra poder consertar a propria conta) |
| Teto de delegacao | `bloqueiaDelegacao` | ninguem concede permissao que nao possui — vale pra atribuir papel, editar papel e gravar excecao |
| Apagar papel e do super admin | `bloqueiaApagarPapel` | **apagar nao e revogar**: `ON DELETE SET NULL` joga os membros no embutido `normal` e ainda levanta o teto de escopo. Teto de permissoes nao cobre isso — apagar o papel "Somente leitura" (lista vazia, cabe em qualquer teto) promoveria todo mundo que estava nele, e apagar o proprio papel devolveria ao ator o embutido mais a visao total. Nao-admin tira acesso com `ativo:false`, que e fail-closed |

O teto olha o que e **concedido**; revogar segue livre, porque restringir nunca e
escalada. E a trava do papel base bloqueia a mudanca inteira (promover *e*
rebaixar), nao so a promocao — antes existia so a trava de auto-REBAIXAMENTO, que
era exatamente o buraco. Reenviar o papel **igual ao que ja esta gravado** nao
conta como troca: o formulario salva o registro inteiro, e tratar reenvio como
troca faria trava virar paralisia (o front tambem so manda `papel` quando mudou).

**`/api/admin/papeis` exige sessao (`usuarioPorSessao`), nunca `x-api-key`** —
mesma razao da gestao de chaves: quem redefine o que um papel pode redefine a
autorizacao da instalacao inteira, e chave vazada nao faz isso.
`/api/admin/usuarios` **segue aceitando chave de proposito** (o runbook de frota
atribui papel por script), mas as tres travas valem la para qualquer identidade.

## Onde o enforcement mora

Um lugar so: **`lib/perfil.ts`**.

- `getPerfil(userId)` resolve papel, excecoes, escopo e o teto — e devolve as
  permissoes **ja calculadas**. Rota nao refaz a conta.
- `permitido(perfil, permissao)` e o gate. Fail-closed: ausente = negado.
- `conversaVisivel` (o predicado de visibilidade) foi **extraido** pra
  `lib/visibilidade.ts` em 31/08 **sem alterar uma linha da logica**, so pra
  virar arquivo puro e finalmente ficar provavel em node solto. `lib/perfil.ts`
  re-exporta; nenhuma rota mudou.

## Prova

```bash
node scripts/prova-permissoes.ts    # 13 blocos, 162 assercoes, sem banco nem navegador
```

Cobre a matriz **papel x escopo x visibilidade**: super admin ve tudo; escopo
`proprias` so ve as suas; escopo `departamento` ve as do departamento (e as de
colega que divide departamento); ACL fixa F9 restringe **ate quem tem escopo
`todas`** e o responsavel atual sempre ve; canal em fonte externa (que chega como
status `aberto`) segue a regra normal. Mais o modelo novo: compatibilidade,
teto, excecao, fail-closed.

**Quem mexer em `conversaVisivel` atualiza a matriz junto.**

## Correcao de seguranca que veio junto

`GET /api/agendadas` checava a restricao de BU mas **nao o escopo de visao**,
enquanto o POST logo abaixo sempre checou. Quem tinha escopo `proprias` e nenhuma
restricao de BU conseguia ler, passando `chat_id` na URL, os agendamentos de
conversa alheia — texto da mensagem e quem agendou. Corrigido em 31/08: passa
pelo mesmo `podeVerConversa` do resto do painel.

## Como operar

Papel nasce pela API (a tela so ATRIBUI):

```bash
# criar / editar
curl -X POST "$PAINEL/api/admin/papeis" -H "x-api-key: eck_..." \
  -H "Content-Type: application/json" \
  -d '{"nome":"Supervisor comercial","permissoes":["ver_todas_conversas","enviar","concluir","relatorios"]}'

# listar (traz quantas pessoas usam cada papel)
curl "$PAINEL/api/admin/papeis" -H "x-api-key: eck_..."
```

Atribuir: **Configuracoes -> Usuarios -> clicar na pessoa -> "Perfil de
permissoes"**. "Padrao do sistema" = sem papel nomeado.

Excecao individual (o ajuste caixa-a-caixa, que a tela destaca mas nao edita):

```bash
curl -X POST "$PAINEL/api/admin/usuarios" -H "x-api-key: eck_..." \
  -H "Content-Type: application/json" \
  -d '{"user_id":"<uuid>","permissoes_excecao":{"relatorios":true}}'
```

## Pendencias

- **Construtor visual de papel** (criar/editar o conjunto de permissoes pela
  tela) e **editor de excecao individual**: sao tela nova, nao foram feitos —
  **validar com o Eric de dia** antes de desenhar.
- **Filtros da caixa de entrada liberados/bloqueados por perfil** (criterio do
  card 86ak858v3): nao implementado. O card observa que "deixar filtrar por
  usuario ja revela quem atende quem". Exige decisao de produto sobre quais dos
  dez filtros viram permissao — nao inventar sozinho.
- **Restricao de funil a departamentos/usuarios** (criterio do 86ak858v3): o
  analogo no painel e a BU (`perfil_contextos` + `conversa_visibilidade` tipo
  `contexto`), que ja funciona. Se "funil" virar entidade propria no motor de
  automacao (Frente C), a restricao dele reusa esta camada.
- **Migration 0010 ainda nao rodou em producao** — e gesto humano no SQL Editor.
  Ate rodar, tudo se comporta como antes, por desenho.
- `/api/fotos`, `/api/midia` e `/api/vigia` seguem com `ehAdmin` como fallback do
  bearer de cron (respondem 401, nao 403). Sao rotas de maquina; mapear pra
  `gerenciar_canais` e trivial, mas mexe no caminho do pg_cron — deixado de fora
  de proposito.

---

## Atualizacao — Frente Q (31/08/2026): o que mudou nesta spec

A camada de autorizacao ganhou tres travas novas, todas **por cima** do modelo
descrito acima (papel nomeado + escopo de visao + ACL por conversa), nenhuma
substituindo nada. Detalhe completo no `CLAUDE.md`, secao "Seguranca e conta
(Frente Q)". O que interessa a esta spec:

- **A linha "Restricao de funil a departamentos/usuarios" acima esta RESOLVIDA de
  outra forma.** A previsao era reusar a BU; o que entrou e uma restricao **por
  pessoa** em `mensageria.usuario_restricoes` (`canais` + `funis`), aplicada como
  camada 2b de `conversaVisivel` — depois do super admin, antes de tudo o mais, e
  **sem** a valvula do "responsavel sempre ve" que a ACL tem. A BU segue existindo
  e as duas se somam (intersecao, nunca substituicao). Card `86ak85zm4`.
- **Janela de acesso por usuario** (`mensageria.acesso_janelas`, card `86ak858x0`)
  nao e permissao: e QUANDO a pessoa pode usar o painel. Conferida na porta
  (`lib/auth-server.ts`), entao vale pra sessao ja aberta, nao so pro login.
- **Escopo por chave de API** (card `86ak85899`): a chave agora pode valer MENOS
  que o dono (somente leitura, recursos, canais, prazo). Nao entra na lista de
  `PERMISSOES` de proposito — e decidido na PORTA, por metodo/caminho/canal
  (`lib/escopo-chave.ts`), e so RESTRINGE.
- **Super admin nao e alcancado por nenhuma das tres** — e o que permite que a
  politica de falha de todas elas seja fail-closed sem risco de trancar a
  instalacao pra fora.
- **Nada disso vale antes de rodar `0019_seguranca_conta.sql`** (gesto humano no
  SQL Editor), pelo mesmo desenho da 0010.

### Correcao pos-revisao (31/08/2026)

A revisao cega da Frente Q reprovou a primeira versao e mudou duas coisas que
esta spec precisa registrar:

- **A politica de acesso tem uma porteira antes das tabelas**:
  `mensageria.config.politica_acesso_ativa`. Enquanto ela e `false` (o estado de
  toda instalacao que nunca configurou janela, restricao ou revogacao), a porta
  nao consulta nada — nao existe caminho pra barrar ninguem. Isso substitui a
  deteccao por codigo de erro como primeira linha de defesa: errar o codigo
  (faltava `PGRST205`, o de "tabela fora do schema cache" do Supabase)
  transformava fail-closed em apagao do painel inteiro.
- **Escopo de chave e canal**: o canal do pedido e resolvido como a ROTA resolve
  (ausente = `central`), o corpo tem precedencia sobre a query, e query x corpo
  divergentes = negado. Sem isso, uma chave restrita a um numero lia o outro so
  omitindo `?canal=`.
- **Rota que resolve canal A MAO tambem entra no recorte** (3a revisao): `POST
  /api/visibilidade` comparava `body.canal === "apioficial"` na propria rota, sem
  passar por `canalDe*`, e por isso uma chave restrita a um numero gravava ACL
  dura no outro. Hoje a rota usa `canalDeBody` + `tabelas()`, e a prova varre
  `app/api` cobrando, **por handler e por metodo**, que quem resolve canal esteja
  declarado em `CANAL_PADRAO_EM` — com igualdade nos dois sentidos (metodo
  faltando e furo; metodo sobrando e verbete morto que finge cobertura).
- **Chave que nao resolve responde 401 com frase unica; chave VALIDA barrada por
  politica responde 403.** A decisao mora em `lib/recusa.ts` (arquivo puro), pra a
  prova poder exercitar `{status, error}` de verdade em vez de afirmar o
  invariante olhando a propria constante.
