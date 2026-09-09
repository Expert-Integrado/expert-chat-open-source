-- 0008_fluxos.sql
-- P3 (Frente C, 31/08/2026): motor de automacao em FLOW — fundacao.
--
-- Duas tabelas, o minimo que o motor precisa:
--   mensageria.fluxos           = o fluxo canonico inteiro em jsonb + metadados
--   mensageria.fluxo_execucoes  = trilha de cada disparo (quem, onde, qual passo)
--
-- O FORMATO do jsonb esta em docs/fluxo-canonico.md e e validado em codigo por
-- lib/fluxo/schema.ts (validarFluxo). De proposito o banco NAO replica a regra:
-- schema de fluxo muda mais rapido que DDL, e ter a regra em dois lugares faz os
-- dois divergirem. O banco guarda e indexa; quem valida e o schema TS.
--
-- ATENCAO: este arquivo NAO e executado por codigo nenhum. Rodar a migration e
-- gesto humano no SQL Editor do Supabase da instalacao (mesma convencao da 0007).
-- Idempotente: pode rodar de novo sem estragar nada.
--
-- Gotcha do repo (CLAUDE.md): tabela nova no schema `mensageria` costuma nascer
-- SEM grant e a rota devolve 500 (permission denied do service_role). O
-- `alter default privileges` de 0001 cobre tabelas futuras, mas o grant explicito
-- abaixo garante o caso de a migration rodar com outro dono.

-- ---------------------------------------------------------------- fluxos
create table if not exists mensageria.fluxos (
  id uuid primary key default gen_random_uuid(),
  -- slug estavel usado nas rotas e dentro do proprio jsonb (fluxo->>'id')
  slug text not null unique,
  nome text not null,
  -- "macro" (lista de acoes disparada a mao) ou "gatilho" (motor completo, v2)
  tipo text not null default 'macro',
  ativo boolean not null default true,
  -- o fluxo canonico inteiro (docs/fluxo-canonico.md)
  fluxo jsonb not null,
  -- rastreabilidade de importacao (espelho de fluxo->'origem', pra filtrar sem
  -- abrir o jsonb): de qual ferramenta veio e com quantas ressalvas
  origem_ferramenta text,
  origem_id text,
  criado_por_id uuid,
  criado_por_nome text,
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);

alter table mensageria.fluxos enable row level security;

create index if not exists idx_fluxos_tipo_ativo on mensageria.fluxos (tipo, ativo);
create index if not exists idx_fluxos_origem on mensageria.fluxos (origem_ferramenta, origem_id);

-- ------------------------------------------------------- fluxo_execucoes
-- Trilha: 1 linha por PASSO executado. Granularidade de passo (e nao de fluxo)
-- porque a pergunta real depois de um macro dar errado e "parou em qual acao?".
create table if not exists mensageria.fluxo_execucoes (
  id uuid primary key default gen_random_uuid(),
  -- referencia solta (sem FK): fluxo apagado nao apaga a trilha do que ja rodou
  fluxo_id uuid,
  fluxo_slug text not null,
  -- agrupa os passos de UM disparo
  execucao_id uuid not null,
  canal text not null,
  chat_id text not null,
  -- id do no dentro do fluxo + tipo da acao (redundante de proposito: o fluxo
  -- pode ser editado depois, e a trilha tem que continuar legivel)
  no_id text,
  acao text,
  -- ok | falhou | pulado
  status text not null,
  detalhe text,
  executado_por_id uuid,
  executado_por_nome text,
  criada_em timestamptz not null default now()
);

alter table mensageria.fluxo_execucoes enable row level security;

create index if not exists idx_fluxo_exec_execucao on mensageria.fluxo_execucoes (execucao_id);
create index if not exists idx_fluxo_exec_chat on mensageria.fluxo_execucoes (canal, chat_id, criada_em desc);
create index if not exists idx_fluxo_exec_fluxo on mensageria.fluxo_execucoes (fluxo_slug, criada_em desc);

-- ---------------------------------------------------------------- grants
-- RLS ligado com ZERO policy + grant so pro service_role = anon e usuario
-- logado levam 42501 no PostgREST direto (mesmo modelo das outras tabelas).
grant all on mensageria.fluxos to service_role;
grant all on mensageria.fluxo_execucoes to service_role;

-- Depois de rodar, se a rota reclamar de tabela desconhecida:
--   notify pgrst, 'reload schema';
