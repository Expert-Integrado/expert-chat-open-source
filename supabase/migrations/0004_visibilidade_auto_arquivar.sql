-- F9 (17/08/2026): visibilidade fixa por chat + auto-arquivar por chat.
-- DOCUMENTAL: aplicado em prod via Management API antes deste arquivo existir
-- (mesma convencao da 0003). Idempotente.

-- ACL fixa por conversa: quem PODE ver, independente de quem esta atendendo.
-- tipo 'usuario' -> ref_id = auth.users.id; 'departamento' -> departamentos.id;
-- 'contexto' -> embed_contextos.id (BU): casa com usuario VINCULADO aquela BU
-- (perfil_contextos) ou com usuario SEM vinculo nenhum (irrestrito).
-- Lista VAZIA = todos veem (comportamento historico do painel).
create table if not exists mensageria.conversa_visibilidade (
  canal text not null,
  chat_id text not null,
  tipo text not null check (tipo in ('usuario','departamento','contexto')),
  ref_id text not null,
  nome text,
  criado_em timestamptz not null default now(),
  primary key (canal, chat_id, tipo, ref_id)
);
alter table mensageria.conversa_visibilidade enable row level security;
create index if not exists idx_conv_visibilidade_chat on mensageria.conversa_visibilidade (canal, chat_id);
create index if not exists idx_conv_visibilidade_ctx on mensageria.conversa_visibilidade (tipo, ref_id);

-- Auto-arquivar POR CHAT: chat com o flag ligado NAO desarquiva/reabre nos
-- fluxos automaticos (msg recebida, enviada, encaminhada, troca de status) —
-- cada evento re-afirma arquivada=true. Toggle manual de arquivo segue valendo.
alter table mensageria.conversas add column if not exists auto_arquivar boolean not null default false;
alter table mensageria.conversas_apioficial add column if not exists auto_arquivar boolean not null default false;

-- BU Consultoria: allowlist manual (sem fonte automatica) — existe pros grupos
-- de cliente da consultoria AI taggeados via conversa_visibilidade.
insert into mensageria.embed_contextos (id, nome, filtro, ativo)
values ('consultoria', 'Consultoria', '{"tipo":"allowlist"}'::jsonb, true)
on conflict (id) do nothing;

-- merge_lid_chat tambem foi atualizada em prod (17/08) pra: carregar arquivada
-- e auto_arquivar no merge (antes RESETAVA o arquivo do chat destino, gap
-- pre-existente) e migrar conversa_responsaveis + conversa_visibilidade da
-- origem @lid pro destino por telefone (on conflict do nothing). Definicao
-- canonica: pg_get_functiondef em prod; aplicada via Management API.
