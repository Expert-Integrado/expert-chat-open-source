-- Widget embutido: contextos de filtro e allowlist de telefones.
-- O token de contexto (assinado com EMBED_JWT_SECRET) so RESTRINGE a visao
-- de um usuario ja autenticado no painel — ver lib/embed.ts.

create table if not exists mensageria.embed_contextos (
  id text primary key,
  nome text not null,
  filtro jsonb not null default '{"tipo":"allowlist"}'::jsonb,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

create table if not exists mensageria.embed_allowlist (
  contexto_id text not null references mensageria.embed_contextos(id) on delete cascade,
  telefone_digits text not null,
  atualizado_em timestamptz not null default now(),
  primary key (contexto_id, telefone_digits)
);

alter table mensageria.embed_contextos enable row level security;
alter table mensageria.embed_allowlist enable row level security;

notify pgrst, 'reload schema';
