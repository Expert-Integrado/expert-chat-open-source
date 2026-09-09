-- 0010 — Papeis nomeados (perfis de permissao) — card 86ak858uu
--
-- POR QUE: ate aqui a autorizacao do painel era um enum de dois valores
-- (super_admin | normal) mais o escopo de visao. Nao existia jeito de dizer
-- "Supervisor comercial ve tudo e le relatorio, mas nao mexe em cadastro" sem
-- inventar caixa por pessoa — o desenho de permissao-por-caixa que nao escala
-- (dezenas de permissoes x N pessoas, e ninguem mais sabe o que cada tipo faz).
--
-- COMO RODAR: SQL Editor do Supabase, na mao. O codigo do painel NUNCA cria
-- tabela — regra da casa. Enquanto esta migration nao rodar, o painel continua
-- funcionando com o enum de hoje (as rotas caem no fallback embutido de
-- lib/permissoes.ts e as leituras de `papeis` degradam pra "sem papel nomeado").
--
-- COMPATIBILIDADE: nenhuma linha existente muda. `perfis.papel_id` nasce NULL
-- pra todo mundo = todo usuario segue no comportamento anterior, permissao por
-- permissao. Atribuir um papel e um gesto explicito do admin, um usuario por vez.

create table if not exists mensageria.papeis (
  id uuid not null default gen_random_uuid(),
  nome text not null,
  descricao text,
  -- lista de permissoes NOMEADAS. A lista canonica vive em lib/permissoes.ts
  -- (PERMISSOES); chave desconhecida aqui e ignorada na leitura de proposito,
  -- pra instalacao velha nao quebrar quando a lista crescer.
  permissoes jsonb not null default '[]'::jsonb,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id)
);

create unique index if not exists uq_papeis_nome on mensageria.papeis (lower(nome));

alter table mensageria.papeis enable row level security;

-- Papel do usuario. NULL = sem papel nomeado = fallback embutido (o de hoje).
-- on delete set null: apagar um papel devolve as pessoas ao comportamento
-- anterior, nunca as deixa sem autorizacao definida.
alter table mensageria.perfis
  add column if not exists papel_id uuid references mensageria.papeis(id) on delete set null;

-- Excecao individual, o "ajuste fino" que o card pede que seja VISIVEL:
-- mapa permissao -> true (concede) | false (revoga), aplicado por cima do papel.
-- Vazio = pessoa segue o papel puro, que e o caso normal e o que a tela mostra.
alter table mensageria.perfis
  add column if not exists permissoes_excecao jsonb not null default '{}'::jsonb;

create index if not exists ix_perfis_papel_id on mensageria.perfis (papel_id);

-- Grant explicito: tabela nova no schema mensageria ja herda o default privilege
-- aplicado em 13/08, mas o sintoma de quando falta e um 500 "permission denied"
-- dificil de ler — melhor ser redundante aqui do que caçar isso em producao.
grant all on mensageria.papeis to service_role;

-- Sementes sugeridas pelo card. Espelham PAPEIS_SUGERIDOS em lib/permissoes.ts
-- (mudou la, mudar aqui). Sao ponto de partida editavel, nao lei: nenhuma
-- pessoa e atribuida a elas por esta migration.
insert into mensageria.papeis (nome, descricao, permissoes)
values
  ('Administrador', 'Governa a instalacao inteira.',
   '["ver_todas_conversas","enviar","concluir","disparo","relatorios","gerenciar_etiquetas","gerenciar_usuarios","gerenciar_visibilidade","gerenciar_canais","automacao"]'::jsonb),
  ('Supervisor', 'Enxerga a conta inteira, atende e le relatorio, sem mexer no cadastro.',
   '["ver_todas_conversas","enviar","concluir","disparo","relatorios"]'::jsonb),
  ('Atendente', 'Atende o que cai pra ele ou pro departamento dele.',
   '["enviar","concluir","disparo"]'::jsonb),
  ('Somente leitura', 'Le conversa e nao age em nada.',
   '[]'::jsonb)
on conflict do nothing;

notify pgrst, 'reload schema';
