-- 0022 — INTENCOES (NLU local) do modulo de automacao. Card 86ak85nzr.
--
-- Aplicar no SQL Editor do Supabase da INSTALACAO (gesto humano; nenhum script
-- deste repo roda DDL). Ate rodar, /api/intencoes responde lista vazia com aviso
-- e a condicao de intencao nunca bate — nunca 500 (padrao de /api/macros).
--
-- O QUE E: uma intencao junta um conjunto de PALAVRAS-CHAVE e um conjunto de
-- FRASES DE EXEMPLO, mais a PONTUACAO MINIMA que a mensagem precisa somar pra ela
-- ser considerada reconhecida. O reconhecimento e LOCAL e deterministico
-- (lib/fluxo/intencoes.ts) — nao existe chamada a servico pago em lugar nenhum.
--
-- DIMENSIONAMENTO HONESTO (medido nos 33 backups, 31/08/2026): 52 intencoes, 249
-- palavras-chave e 431 frases em anos de uso, com pontuacao minima variando de 2
-- (o default, 23 casos) a 100. E paridade de MIGRACAO, nao recurso central: conta
-- sem nenhuma intencao tem que funcionar igual, e por isso nada aqui e obrigatorio.

create table if not exists mensageria.intencoes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  -- LISTAS EM text[], NAO tabela filha: o conjunto e pequeno (a maior intencao
  -- medida tem 10 palavras e 24 frases), sempre lido inteiro junto da intencao, e
  -- nunca consultado por termo isolado. Tabela filha custaria dois joins em toda
  -- leitura pra nao ganhar nada.
  palavras_chave text[] not null default '{}',
  frases text[] not null default '{}',
  -- 2 e o default da ferramenta de origem (o campo la tem placeholder "Padrao: 2")
  pontuacao_minima integer not null default 2,
  ativo boolean not null default true,
  -- rastreabilidade da importacao, na mesma convencao de fluxos, funis, campanhas,
  -- NPS e respostas rapidas: reimportar ATUALIZA em vez de duplicar
  origem_ferramenta text,
  origem_id text,
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now(),
  atualizado_por_id uuid,
  atualizado_por_nome text,
  constraint intencoes_pontuacao_minima_faixa check (pontuacao_minima between 1 and 1000)
);

-- Colunas tambem como `add column if not exists`, e o default tambem como
-- `alter column ... set default`: REGRA DA CASA paga em incidente (CLAUDE.md,
-- secao da 0018). `create table if not exists` NAO altera tabela que ja existe, e
-- a instalacao que testou uma versao anterior desta migration e justamente a que
-- quebraria — em runtime, com PGRST204 e a rota respondendo vazio como se nao
-- houvesse intencao nenhuma.
alter table mensageria.intencoes add column if not exists palavras_chave text[] not null default '{}';
alter table mensageria.intencoes add column if not exists frases text[] not null default '{}';
alter table mensageria.intencoes add column if not exists pontuacao_minima integer not null default 2;
alter table mensageria.intencoes add column if not exists ativo boolean not null default true;
alter table mensageria.intencoes add column if not exists origem_ferramenta text;
alter table mensageria.intencoes add column if not exists origem_id text;
alter table mensageria.intencoes add column if not exists criada_em timestamptz not null default now();
alter table mensageria.intencoes add column if not exists atualizada_em timestamptz not null default now();
alter table mensageria.intencoes add column if not exists atualizado_por_id uuid;
alter table mensageria.intencoes add column if not exists atualizado_por_nome text;
alter table mensageria.intencoes alter column pontuacao_minima set default 2;
alter table mensageria.intencoes alter column ativo set default true;

-- O CHECK TAMBEM PRECISA DO CAMINHO "TABELA JA EXISTE" — mesmo raciocinio das
-- colunas acima, e o furo foi apontado na revisao cega de 31/08/2026: o
-- `constraint ... check` do `create table` NAO e aplicado em instalacao que ja
-- criou a tabela numa versao anterior. Ela ficaria sem a faixa 1..1000, e o
-- unico portao da pontuacao seria o `validarIntencao` da aplicacao — quem
-- escrevesse por SQL (ou uma rota futura que esquecesse de validar) gravaria
-- pontuacao 0 e a intencao passaria a disparar em TODA mensagem.
-- `add constraint` nao tem `if not exists`, entao a checagem e no catalogo.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'intencoes_pontuacao_minima_faixa'
       and conrelid = 'mensageria.intencoes'::regclass
  ) then
    alter table mensageria.intencoes
      add constraint intencoes_pontuacao_minima_faixa check (pontuacao_minima between 1 and 1000);
  end if;
end $$;

-- NOME UNICO, comparado sem caixa. O nome e o que a condicao de fluxo guarda (o
-- fluxo canonico e portatil e nao carrega uuid de instalacao nenhuma), entao dois
-- nomes que so diferem na caixa fariam a condicao apontar pra duas intencoes
-- diferentes com o mesmo texto na tela.
create unique index if not exists uq_intencoes_nome on mensageria.intencoes (lower(nome));

-- INDICE TOTAL, SEM `where` — de proposito, e isto ja custou incidente neste repo
-- (CLAUDE.md, secao do importador): o PostgREST recusa `on_conflict` em indice
-- PARCIAL com erro 42P10, e o --dry do importador nunca revela isso porque nao
-- toca banco. Sem o `where` nao se perde nada: NULL nao colide com NULL em indice
-- unico (NULLS DISTINCT e o default), entao intencao criada na tela — com os dois
-- campos NULL — continua entrando quantas vezes for.
--
-- O `drop` antes do `create` nao e zelo: `create index if not exists` casa por
-- NOME, e numa instalacao com um homonimo PARCIAL o create passaria em silencio e
-- o 42P10 voltaria justamente onde a correcao devia estar.
drop index if exists mensageria.uq_intencoes_origem;
create unique index if not exists uq_intencoes_origem
  on mensageria.intencoes (origem_ferramenta, origem_id);

create index if not exists idx_intencoes_ativo on mensageria.intencoes (ativo);

alter table mensageria.intencoes enable row level security;

-- Grants + reload: mesma convencao da 0013, 0016 e 0020, e as duas linhas existem
-- por motivo pago em incidente, nao por zelo.
--
-- O `grant` porque tabela nova no schema `mensageria` nasce sem permissao pro
-- `service_role` em instalacao sem o default privilege aplicado — e a rota responde
-- 500 "permission denied" numa tabela que acabou de ser criada.
--
-- O `notify` porque o PostgREST guarda o schema em CACHE: sem ele, a primeira
-- leitura depois da migration leva 404/PGRST205 e a tela acusa "migration nao
-- aplicada" pra uma migration que acabou de rodar.
-- ---------------------------------------------------------------------------
-- TRANSCRICAO DE AUDIO (card 86ak85ny7): UMA nota por audio, garantido pelo BANCO.
--
-- A transcricao nao pediu tabela nem coluna nova — ela grava uma ANOTACAO INTERNA
-- na tabela de mensagens que ja existe, apontando pro audio em `quoted_msg_id`
-- (coluna da 0001, cujo sentido e exatamente "esta mensagem se refere aquela").
--
-- Este indice existe porque a checagem "ja transcrevi?" na aplicacao nao resolve
-- CORRIDA: duas chamadas simultaneas passam as duas pela leitura e gravam duas
-- notas iguais na conversa. Com o indice, a segunda leva 23505 e a rota devolve a
-- nota da primeira. Unicidade de dado e trabalho do banco.
--
-- PARCIAL de proposito, com as tres condicoes: so linha de ANOTACAO INTERNA com
-- `quoted_msg_id` preenchido. Sem o recorte, o indice proibiria duas mensagens
-- normais citando a mesma mensagem (responder duas vezes o mesmo audio no
-- WhatsApp e comum e legitimo) — e nenhuma nota antiga entra no indice, porque
-- `/api/nota` e a acao de fluxo nunca preenchem `quoted_msg_id`.
--
-- Nao ha `on_conflict` do PostgREST sobre este indice (a rota trata o 23505 na
-- mao), entao o `where` aqui nao cai na armadilha do 42P10 citada acima.
create unique index if not exists uq_mensagens_transcricao_por_audio
  on mensageria.mensagens (quoted_msg_id)
  where direcao = 'interna' and tipo = 'nota' and quoted_msg_id is not null;

create unique index if not exists uq_mensagens_apioficial_transcricao_por_audio
  on mensageria.mensagens_apioficial (quoted_msg_id)
  where direcao = 'interna' and tipo = 'nota' and quoted_msg_id is not null;

grant all on all tables in schema mensageria to service_role;

notify pgrst, 'reload schema';
