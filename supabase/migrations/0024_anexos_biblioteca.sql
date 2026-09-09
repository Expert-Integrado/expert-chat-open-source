-- 0024 — Biblioteca de anexos reutilizaveis (Frente W, 31/08/2026)
--        card 86ak85bmw
--
-- HISTORIA: o atendente manda um arquivo da biblioteca da empresa
-- (apresentacao, guia, tabela de preco) sem procurar no computador, e manda
-- sempre a versao certa. E, mais forte que isso: **56 anexos da conta medida sao
-- referenciados DIRETAMENTE por fluxos de automacao** (76 ocorrencias nas acoes)
-- — sem a biblioteca esses fluxos nao convertem na migracao, eles importam com a
-- acao pela metade.
--
-- COMO RODAR: SQL Editor do Supabase da instalacao, na mao. O codigo do painel
-- NUNCA cria tabela — regra da casa. Enquanto esta migration nao rodar:
--   * `GET /api/anexos` responde lista VAZIA com `aviso` (nunca 500), e a tela
--     mostra a faixa de "migration pendente" em vez de "a biblioteca esta vazia"
--     — as duas frases sao diferentes e so uma e verdade;
--   * subir, descrever, etiquetar e apagar respondem **503 com a frase certa**,
--     nunca 200: fingir que salvou um arquivo que nao entrou e pior que recusar;
--   * o passo de fluxo `anexar_biblioteca` FALHA no passo com o motivo legivel
--     ("a biblioteca nao esta disponivel nesta instalacao"), e o preflight do
--     macro recusa ANTES de comecar — macro pela metade e pior que recusado.
-- A deteccao e por erro de schema ausente do PostgREST (`erroDeSchemaAusente` em
-- lib/acesso.ts), re-testada a cada 60s: no minuto seguinte a migration rodar, a
-- biblioteca passa a valer sem redeploy.
--
-- COMPATIBILIDADE: as duas tabelas nascem VAZIAS, nenhuma linha existente muda
-- de sentido e nenhuma tela antiga passa a se comportar diferente. As quatro
-- permissoes novas (`anexos_enviar`, `anexos_apagar`, `anexos_descrever`,
-- `anexos_etiquetar`) NAO entram no papel embutido `normal` — biblioteca nasce
-- fechada, e quem tinha um botao continua com ele porque nao existia botao
-- nenhum aqui antes desta frente.
--
-- ───────────────────────────────────────────────────────────────────────
-- O QUE **NAO** ENTRA AQUI, e por que — leia antes de "melhorar" o schema:
--
--   O BYTE DO ARQUIVO NAO MORA NO BANCO. Ele vai pro Storage, no bucket PUBLICO
--   que a instalacao ja tem (`midia-mensagens`, prefixo `biblioteca/`), pela
--   mesma razao que a foto do atendente reusa o bucket `fotos-perfil` em vez de
--   pedir um bucket novo (Frente G): bucket novo e mais um gesto manual por
--   instalacao, e o gesto manual que ninguem faz e a feature que nasce quebrada.
--   A coluna `url` guarda o endereco publico JA na instalacao — nunca o endereco
--   do fornecedor antigo, que morre com a conta.
--
--   `tipo_envio` NAO E COLUNA. Ele e DERIVADO do mime (`tipoDeEnvio` em
--   lib/anexos.ts): imagem, video, audio ou documento. Coluna derivada e coluna
--   que envelhece — bastaria um UPDATE em `mime` sem o irmao pra a biblioteca
--   mandar um PDF como se fosse foto.
--
--   NAO HA `ativo`/soft delete. O criterio do card e APAGAR, e apagar de verdade;
--   o que protege o acervo nao e uma flag, e o portao de confirmacao com a LISTA
--   DE FLUXOS AFETADOS (409 em `DELETE /api/anexos` sem `ciente_fluxos=1`).
--   Linha "inativa" que os fluxos continuam referenciando seria o pior dos dois
--   mundos: o fluxo acha que tem anexo e o cliente nao recebe nada.

-- ───────────────────────────────────────────── 1. o acervo
--
-- UMA linha por arquivo da biblioteca DA INSTALACAO (nao por usuario, nao por
-- canal): a biblioteca e da empresa, e e isso que faz "manda sempre a versao
-- certa" ter sentido — se cada atendente tivesse a sua, seria pasta pessoal.
--
-- `chave` E A IDENTIDADE PORTATIL, e ela existe por causa do fluxo. O formato
-- canonico de fluxo (`lib/fluxo/schema.ts`) e PORTATIL entre instalacoes e nao
-- pode carregar o uuid de nenhuma — a acao `mover_funil` ja resolve isso indo
-- por NOME. Aqui a acao `anexar_biblioteca` vai por `chave` (slug), pelo mesmo
-- motivo: um fluxo exportado de uma instalacao e importado noutra continua
-- apontando pro item certo se a chave existir la. Por isso ela e UNIQUE e tem
-- formato apertado (`^[a-z0-9][a-z0-9_-]{0,59}$`) — a mesma familia do atalho de
-- resposta rapida, que ja e validado assim na rota.
create table if not exists mensageria.anexos (
  id uuid primary key default gen_random_uuid(),
  -- identidade portatil usada pelo fluxo (ver acima)
  chave text not null,
  -- titulo humano ("Tabela de precos 2026"), o que a pessoa procura na tela
  nome text not null,
  -- descricao: pra que serve / quando mandar. Permissao SEPARADA pra editar
  -- (`anexos_descrever`) — na ferramenta de origem tambem e uma caixa propria.
  descricao text,
  -- etiquetas da BIBLIOTECA (nao sao as etiquetas de conversa: catalogo, tabela
  -- e proposito diferentes). Permissao separada: `anexos_etiquetar`.
  etiquetas jsonb not null default '[]'::jsonb,
  -- nome do arquivo como ele CHEGA no cliente (o WhatsApp mostra isto)
  arquivo_nome text not null,
  mime text not null,
  bytes bigint,
  -- endereco PUBLICO na instalacao (Storage do proprio cliente). Nunca o do
  -- fornecedor antigo: aquele morre com a conta, e e por isso que a importacao
  -- re-hospeda antes de gravar (scripts/importar/anexos.mjs).
  url text not null,
  -- QUANDO o item foi usado pela ultima vez. Serve pra tela ordenar o que a
  -- operacao usa de verdade — "manda sempre a versao certa" precisa de sinal de
  -- qual e a versao viva.
  --
  -- CONTADOR DE USOS FICOU FORA, e a razao e mecanica: o PostgREST nao faz
  -- incremento atomico, entao `usos = usos + 1` viraria read-modify-write e dois
  -- envios simultaneos (o caso NORMAL numa operacao com varios atendentes)
  -- perderiam contagem em silencio. Numero que erra sozinho e pior que numero
  -- ausente. Data do ultimo uso e UMA escrita e nao tem corrida; quem quiser o
  -- numero conta a trilha (`anexo_eventos`, tipo `usado`) ou cria uma funcao no
  -- banco — declarado, nao esquecido.
  ultimo_uso_em timestamptz,
  criado_por_id uuid,
  criado_por_nome text,
  atualizado_por_id uuid,
  atualizado_por_nome text,
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now(),
  -- ORIGEM: a mesma convencao de fluxos, funis, campanhas, NPS e respostas
  -- rapidas (0020) — reimportar ATUALIZA em vez de duplicar.
  origem_ferramenta text,
  origem_id text,
  constraint ck_anexos_chave check (chave ~ '^[a-z0-9][a-z0-9_-]{0,59}$'),
  constraint ck_anexos_url_https check (url ~ '^https://'),
  constraint ck_anexos_etiquetas_lista check (jsonb_typeof(etiquetas) = 'array')
);

-- COLUNA NOVA ENTRA SEMPRE TAMBEM COMO `add column if not exists`: regra da casa
-- que saiu de um incidente (CLAUDE.md, FASE 3 do motor de fila) —
-- `create table if not exists` NAO altera tabela que ja existe, e a instalacao
-- que rodou uma versao anterior deste arquivo e justamente a que quebraria, em
-- runtime e em silencio (PGRST204 -> lista vazia; biblioteca vazia e biblioteca
-- quebrada tem a mesma cara).
alter table mensageria.anexos add column if not exists descricao text;
alter table mensageria.anexos add column if not exists etiquetas jsonb not null default '[]'::jsonb;
alter table mensageria.anexos add column if not exists bytes bigint;
alter table mensageria.anexos add column if not exists ultimo_uso_em timestamptz;
alter table mensageria.anexos add column if not exists criado_por_id uuid;
alter table mensageria.anexos add column if not exists criado_por_nome text;
alter table mensageria.anexos add column if not exists atualizado_por_id uuid;
alter table mensageria.anexos add column if not exists atualizado_por_nome text;
alter table mensageria.anexos add column if not exists origem_ferramenta text;
alter table mensageria.anexos add column if not exists origem_id text;

-- A chave e a identidade que o FLUXO carrega: unicidade e requisito, nao zelo.
-- Sem ela, duas linhas com a mesma chave fariam o passo de fluxo mandar um
-- arquivo ou outro dependendo da ordem que o banco devolveu.
create unique index if not exists uq_anexos_chave on mensageria.anexos (chave);

-- INDICE TOTAL, SEM `where` — o mesmo motivo da 0020, que este repo pagou com
-- 42P10: **o PostgREST recusa `on_conflict` em indice PARCIAL**, e o `--dry` do
-- importador nunca revela isso porque nao toca banco. Sem o `where` nao se perde
-- nada: NULL nao colide com NULL em indice unico (NULLS DISTINCT e o default),
-- entao anexo criado pela TELA — com os dois campos NULL — entra quantas vezes
-- for. E o `drop` antes do `create` nao e zelo: `create index if not exists` casa
-- por NOME, entao um homonimo PARCIAL passaria em silencio e o 42P10 voltaria
-- justo onde a correcao devia estar.
drop index if exists mensageria.uq_anexos_origem;
create unique index if not exists uq_anexos_origem on mensageria.anexos (origem_ferramenta, origem_id);

-- listagem padrao da tela (mais recentes primeiro) e o filtro por etiqueta
create index if not exists ix_anexos_criada_em on mensageria.anexos (criada_em desc);
create index if not exists ix_anexos_etiquetas on mensageria.anexos using gin (etiquetas);

comment on table mensageria.anexos is
  'Biblioteca de anexos da instalacao. O byte vive no Storage; `chave` e a identidade portatil que o fluxo canonico referencia.';

-- ───────────────────────────────────────────── 2. a trilha
--
-- POR QUE ELA EXISTE: o card manda separar QUATRO permissoes (subir, apagar,
-- descrever, etiquetar). Quatro permissoes e a origem dizendo, com todas as
-- letras, que este acervo e gerido por MAIS DE UMA PESSOA — nao e pasta pessoal.
-- Acervo compartilhado sem trilha produz a pergunta que ninguem responde: "quem
-- apagou a tabela de precos?". Aqui o apagar e destrutivo de verdade (o arquivo
-- sai do Storage), entao a linha da trilha e o unico registro que sobra.
--
-- APPEND-ONLY *NO BANCO*, nao em comentario (achado que este repo ja pagou tres
-- vezes: 0016, 0017 e 0023). O `revoke` la embaixo e o que transforma a promessa
-- em garantia: `lib/anexos-db.ts` so faz insert e select aqui.
--
-- Convencao de AUTOR igual a da 0006/0019/0023: id + nome = pessoa; id NULL com
-- nome preenchido = automacao; os dois NULL = o painel carimbou sozinho.
create table if not exists mensageria.anexo_eventos (
  id bigserial primary key,
  -- NAO e FK pra `anexos(id)` de proposito: o evento mais importante da tabela e
  -- justamente o `apagado`, e uma FK (mesmo com ON DELETE SET NULL) faria a
  -- trilha perder o vinculo exatamente no evento que ela existe pra guardar.
  anexo_id uuid,
  -- a chave viaja CONGELADA no evento: depois do apagar, ela e a unica coisa que
  -- liga a linha da trilha ao que os fluxos referenciavam.
  chave text,
  nome text,
  tipo text not null,
  autor_id uuid,
  autor_nome text,
  detalhe jsonb not null default '{}'::jsonb,
  criada_em timestamptz not null default now(),
  constraint ck_anexo_eventos_tipo check (tipo ~ '^[a-z_]{3,40}$')
);

create index if not exists ix_anexo_eventos_anexo on mensageria.anexo_eventos (anexo_id, criada_em desc);
create index if not exists ix_anexo_eventos_chave on mensageria.anexo_eventos (chave, criada_em desc);

comment on table mensageria.anexo_eventos is
  'Trilha append-only da biblioteca: subiu, descreveu, etiquetou, apagou (com a lista de fluxos afetados no detalhe).';

-- ═════════════════════════════════════════════ 3. RLS, grants e reload
--
-- Convencao da casa (0013, 0017, 0019, 0023), e cada linha conserta um jeito
-- diferente de a feature nascer quebrada:
--
--   SEM RLS A ANON KEY LE A TABELA. A biblioteca guarda o material comercial da
--   empresa e quem mexeu nele. RLS ligada com ZERO policy + acesso so pelo
--   service_role e o padrao do schema: o painel fala com o banco pela service
--   key, no servidor.
--
--   SEM GRANT A ROTA DEVOLVE 500 ("permission denied") em tabela que acabou de
--   ser criada. A 0001 aplicou o default privilege, e o grant explicito aqui e
--   cinto — e e o que da ao `revoke` seguinte algo pra revogar.
--
--   SEM `notify pgrst` A FEATURE NASCE MORTA: o PostgREST cacheia o schema e
--   segue respondendo PGRST205 com a tabela existindo; o painel LE isso como
--   "migration nao rodou" e a tela diz que a 0024 esta pendente logo depois de
--   alguem rodar a 0024. Esta linha e a ULTIMA do arquivo de proposito.
alter table mensageria.anexos        enable row level security;
alter table mensageria.anexo_eventos enable row level security;

grant select, insert, update, delete on mensageria.anexos        to service_role;
grant select, insert                 on mensageria.anexo_eventos to service_role;
grant usage, select on sequence mensageria.anexo_eventos_id_seq to service_role;

-- a trilha e APPEND-ONLY no banco (ver o bloco 2). O `grant select, insert` NAO
-- revoga o resto: a 0001 deu `all on tables` por default privilege, entao o
-- revoke explicito e obrigatorio e vem DEPOIS do grant.
revoke update, delete on mensageria.anexo_eventos from service_role;
revoke update, delete on mensageria.anexo_eventos from public, anon, authenticated;

notify pgrst, 'reload schema';
