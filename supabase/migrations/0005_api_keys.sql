-- F11 (18/08/2026): chave de API por usuario, pro MCP/agentes operarem o
-- painel com a MESMA identidade e permissoes de um usuario (BU, visibilidade,
-- escopo, pool). DOCUMENTAL: aplicado em prod via Management API antes deste
-- arquivo existir (convencao das 0003/0004). Idempotente.
-- Plaintext da chave NUNCA e gravado — so o sha256 (key_hash). Gestao em
-- /api/admin/api-keys (super admin ou bearer do sync).
create table if not exists mensageria.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  nome text not null,
  key_hash text not null unique,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  ultimo_uso_em timestamptz
);
alter table mensageria.api_keys enable row level security;
create index if not exists idx_api_keys_user on mensageria.api_keys (user_id);
