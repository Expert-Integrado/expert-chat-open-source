-- 0020 — origem das respostas rapidas (idempotencia da importacao)
--
-- Aplicar no SQL Editor do Supabase da INSTALACAO (gesto humano; nenhum script
-- deste repo roda DDL).
--
-- POR QUE: `mensageria.respostas_rapidas` nasceu na 0001 pensando so no cadastro
-- pela tela — id sorteado, sem nenhuma marca de onde a linha veio. A importacao
-- da conta antiga precisa da regra da casa, a mesma de fluxos, campanhas, funis e
-- NPS: chave unica por (ferramenta de origem, id na origem), pra que reimportar
-- ATUALIZE em vez de duplicar. Sem estas colunas, rodar o importador duas vezes
-- deixa a instalacao com duas copias de cada resposta rapida, e o atalho "/"
-- passa a oferecer texto repetido pro atendente.
--
-- Nao mexe em nada que a tela usa: as duas colunas sao nullable e resposta criada
-- na tela continua entrando com as duas em NULL.

alter table mensageria.respostas_rapidas add column if not exists origem_ferramenta text;
alter table mensageria.respostas_rapidas add column if not exists origem_id text;

-- INDICE TOTAL, SEM `where` — de proposito, e isto ja custou incidente neste
-- repo (CLAUDE.md, secao do importador): **o PostgREST recusa `on_conflict` em
-- indice PARCIAL com erro 42P10**, e o --dry nunca revela isso porque nao toca
-- banco. Sem o `where` nao se perde nada: no Postgres NULL nao colide com NULL
-- em indice unico (NULLS DISTINCT e o default), entao resposta cadastrada na
-- tela — com os dois campos NULL — continua entrando quantas vezes for.
--
-- O `drop` antes do `create` nao e zelo: `create index if not exists` casa por
-- NOME, entao numa instalacao que tivesse um indice homonimo PARCIAL o create
-- passaria em silencio e o 42P10 voltaria justamente onde a correcao devia estar.
drop index if exists mensageria.uq_respostas_rapidas_origem;
create unique index if not exists uq_respostas_rapidas_origem
  on mensageria.respostas_rapidas (origem_ferramenta, origem_id);

-- Consulta de apoio pra quem for revisar depois da importacao: quais respostas
-- vieram de fora e quais foram feitas na tela.
create index if not exists idx_respostas_rapidas_origem
  on mensageria.respostas_rapidas (origem_ferramenta);

-- Grants + reload: mesma convencao da 0013 e da 0016 deste repo, e as duas linhas
-- existem por motivo pago em incidente, nao por zelo.
--
-- O `grant` porque tabela/coluna nova no schema `mensageria` nasce sem permissao
-- pro `service_role` em instalacao que nao tenha o default privilege aplicado — e
-- a rota responde 500 "permission denied" numa tabela que acabou de ser criada
-- (gotcha registrado no CLAUDE.md). E idempotente e nao amplia nada: `service_role`
-- e a chave que o painel ja usa pra tudo.
--
-- O `notify` porque o PostgREST guarda o schema em CACHE: sem ele, o importador
-- roda logo depois da migration, pede `select=origem_ferramenta,origem_id`, leva
-- 400 e PARA dizendo "falta a migration 0020" — pra uma migration que acabou de
-- rodar. Exatamente o falso negativo que a 0016 pagou com PGRST202.
grant all on all tables in schema mensageria to service_role;

notify pgrst, 'reload schema';
