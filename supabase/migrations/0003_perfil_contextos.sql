-- Permissao por BU (16/08/2026): vinculo de usuario a um ou mais contextos do
-- widget embutido (mensageria.embed_contextos). Usuario vinculado so enxerga a
-- UNIAO das BUs vinculadas, imposto no SERVIDOR (lib/embed.ts, restricaoDoUsuario/
-- restricaoEfetiva) em toda rota — independe de header/token ou selecao de tela.
-- Super admin nunca e restringido, mesmo com linhas aqui.
-- NOTA: esta tabela ja existe em producao; migration criada so pra documentar
-- o schema no repo (create if not exists = no-op se ja aplicada).

create table if not exists mensageria.perfil_contextos (
  user_id uuid not null,
  contexto_id text not null references mensageria.embed_contextos(id) on delete cascade,
  criado_em timestamptz not null default now(),
  primary key (user_id, contexto_id)
);

alter table mensageria.perfil_contextos enable row level security;

notify pgrst, 'reload schema';
