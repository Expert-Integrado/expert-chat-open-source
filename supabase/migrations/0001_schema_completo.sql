-- Expert Chat — schema completo (mensageria).
-- Aplicar no SQL Editor do Supabase do SEU projeto (uma vez).

create extension if not exists pg_trgm;
create schema if not exists mensageria;
grant usage on schema mensageria to service_role;

create table if not exists mensageria.avaliacoes (
  id uuid not null default gen_random_uuid(),
  canal text not null default 'central'::text,
  chat_id text not null,
  nota integer not null,
  atendente_id text,
  atendente_nome text,
  criada_em timestamp with time zone not null default now()
);

create table if not exists mensageria.campos_personalizados (
  id uuid not null default gen_random_uuid(),
  nome text not null,
  ordem integer not null default 999,
  ativo boolean not null default true,
  criado_em timestamp with time zone not null default now()
);

create table if not exists mensageria.config (
  chave text not null,
  valor jsonb not null,
  updated_at timestamp with time zone not null default now()
);

create table if not exists mensageria.conversa_responsaveis (
  chat_id text not null,
  tipo text not null,
  ref_id text not null,
  nome text not null,
  criado_em timestamp with time zone not null default now(),
  canal text not null default 'central'::text
);

create table if not exists mensageria.conversas (
  chat_id text not null,
  nome text,
  is_group boolean not null default false,
  foto_url text,
  canal text not null default 'chatguru'::text,
  last_message_at timestamp with time zone,
  last_message_preview text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  status text not null default 'aberto'::text,
  responsavel_id text,
  responsavel_nome text,
  mensagens_nao_lidas integer not null default 0,
  foto_atualizada_em timestamp with time zone,
  meta_chatguru jsonb,
  ficha jsonb,
  enriquecido_em timestamp with time zone,
  arquivada boolean not null default false,
  foto_wa_url text,
  foto_wa_em timestamp with time zone,
  responsavel_tipo text,
  etiquetas jsonb not null default '[]'::jsonb,
  aguardando_avaliacao boolean not null default false,
  ultima_auto_msg_em timestamp with time zone
);

create table if not exists mensageria.conversas_apioficial (
  chat_id text not null,
  nome text,
  is_group boolean not null default false,
  foto_url text,
  canal text not null default 'chatguru'::text,
  last_message_at timestamp with time zone,
  last_message_preview text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  status text not null default 'aberto'::text,
  responsavel_id text,
  responsavel_nome text,
  mensagens_nao_lidas integer not null default 0,
  foto_atualizada_em timestamp with time zone,
  meta_chatguru jsonb,
  ficha jsonb,
  enriquecido_em timestamp with time zone,
  arquivada boolean not null default false,
  foto_wa_url text,
  foto_wa_em timestamp with time zone,
  responsavel_tipo text,
  etiquetas jsonb not null default '[]'::jsonb,
  chatguru_updated text,
  aguardando_avaliacao boolean not null default false,
  ultima_auto_msg_em timestamp with time zone
);

create table if not exists mensageria.departamento_membros (
  departamento_id uuid not null,
  user_id uuid not null,
  criado_em timestamp with time zone not null default now()
);

create table if not exists mensageria.departamentos (
  id uuid not null default gen_random_uuid(),
  nome text not null,
  ativo boolean not null default true,
  criado_em timestamp with time zone not null default now(),
  escopo_visao text
);

create table if not exists mensageria.etiquetas_catalogo (
  id uuid not null default gen_random_uuid(),
  nome text not null,
  ativo boolean not null default true,
  criado_em timestamp with time zone not null default now()
);

create table if not exists mensageria.lid_mapping (
  lid text not null,
  phone text not null,
  chat_name text,
  resolved_via text,
  resolved_at timestamp with time zone not null default now()
);

create table if not exists mensageria.mensagens (
  id uuid not null default gen_random_uuid(),
  chat_id text not null,
  direcao text not null,
  tipo text not null default 'text'::text,
  conteudo text,
  sender_name text,
  sender_phone text,
  provider_msg_id text,
  status text,
  criada_em timestamp with time zone not null default now(),
  raw jsonb,
  media_url text,
  media_mime text,
  enviado_por_id uuid,
  enviado_por_nome text,
  quoted_msg_id text,
  is_deleted boolean not null default false,
  editada_em timestamp with time zone,
  reacao text,
  encaminhada boolean not null default false
);

create table if not exists mensageria.mensagens_agendadas (
  id uuid not null default gen_random_uuid(),
  canal text not null default 'central'::text,
  chat_id text not null,
  texto text not null,
  enviar_em timestamp with time zone not null,
  criado_por_id text,
  criado_por_nome text,
  status text not null default 'pendente'::text,
  erro text,
  criada_em timestamp with time zone not null default now(),
  enviada_em timestamp with time zone
);

create table if not exists mensageria.mensagens_apioficial (
  id uuid not null default gen_random_uuid(),
  chat_id text not null,
  direcao text not null,
  tipo text not null default 'text'::text,
  conteudo text,
  sender_name text,
  sender_phone text,
  provider_msg_id text,
  status text,
  criada_em timestamp with time zone not null default now(),
  raw jsonb,
  media_url text,
  media_mime text,
  enviado_por_id uuid,
  enviado_por_nome text,
  quoted_msg_id text,
  is_deleted boolean not null default false,
  editada_em timestamp with time zone,
  reacao text,
  encaminhada boolean not null default false
);

create table if not exists mensageria.notificacoes (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  chat_id text,
  titulo text not null,
  texto text,
  autor_nome text,
  lida boolean not null default false,
  criada_em timestamp with time zone not null default now(),
  canal text not null default 'central'::text
);

create table if not exists mensageria.perfis (
  user_id uuid not null,
  nome text,
  papel text not null default 'normal'::text,
  escopo_visao text not null default 'todas'::text,
  departamento_id uuid,
  tema text not null default 'claro'::text,
  criado_em timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  ativo boolean not null default true,
  assinatura_ativa boolean not null default false,
  assinatura_nome text,
  visto_em timestamp with time zone
);

create table if not exists mensageria.respostas_rapidas (
  id uuid not null default gen_random_uuid(),
  atalho text not null,
  texto text not null,
  dono_id text,
  criado_em timestamp with time zone not null default now()
);

create table if not exists mensageria.webhook_raw (
  id bigint not null,
  payload jsonb not null,
  parse_ok boolean,
  erro text,
  recebido_em timestamp with time zone not null default now()
);

-- chaves primarias e unicas
alter table mensageria.avaliacoes add constraint avaliacoes_pkey PRIMARY KEY (id);
alter table mensageria.campos_personalizados add constraint campos_personalizados_nome_key UNIQUE (nome);
alter table mensageria.campos_personalizados add constraint campos_personalizados_pkey PRIMARY KEY (id);
alter table mensageria.config add constraint config_pkey PRIMARY KEY (chave);
alter table mensageria.conversa_responsaveis add constraint conversa_responsaveis_pkey PRIMARY KEY (canal, chat_id, tipo, ref_id);
alter table mensageria.conversas_apioficial add constraint conversas_apioficial_pkey PRIMARY KEY (chat_id);
alter table mensageria.conversas add constraint conversas_pkey PRIMARY KEY (chat_id);
alter table mensageria.departamento_membros add constraint departamento_membros_pkey PRIMARY KEY (departamento_id, user_id);
alter table mensageria.departamentos add constraint departamentos_nome_key UNIQUE (nome);
alter table mensageria.departamentos add constraint departamentos_pkey PRIMARY KEY (id);
alter table mensageria.etiquetas_catalogo add constraint etiquetas_catalogo_nome_key UNIQUE (nome);
alter table mensageria.etiquetas_catalogo add constraint etiquetas_catalogo_pkey PRIMARY KEY (id);
alter table mensageria.lid_mapping add constraint lid_mapping_pkey PRIMARY KEY (lid);
alter table mensageria.mensagens_agendadas add constraint mensagens_agendadas_pkey PRIMARY KEY (id);
alter table mensageria.mensagens_apioficial add constraint mensagens_apioficial_pkey PRIMARY KEY (id);
alter table mensageria.mensagens add constraint mensagens_pkey PRIMARY KEY (id);
alter table mensageria.notificacoes add constraint notificacoes_pkey PRIMARY KEY (id);
alter table mensageria.perfis add constraint perfis_pkey PRIMARY KEY (user_id);
alter table mensageria.respostas_rapidas add constraint respostas_rapidas_pkey PRIMARY KEY (id);
alter table mensageria.webhook_raw add constraint webhook_raw_pkey PRIMARY KEY (id);

-- indices
CREATE INDEX idx_mensagens_chat ON mensageria.mensagens USING btree (chat_id, criada_em DESC);
CREATE UNIQUE INDEX uq_mensagens_provider ON mensageria.mensagens USING btree (provider_msg_id) WHERE (provider_msg_id IS NOT NULL);
CREATE UNIQUE INDEX uq_mensagens_provider_total ON mensageria.mensagens USING btree (provider_msg_id);
CREATE INDEX ix_mensagens_conteudo_trgm ON mensageria.mensagens USING gin (conteudo gin_trgm_ops);
CREATE INDEX idx_conversas_ficha ON mensageria.conversas USING gin (ficha);
CREATE INDEX idx_conversas_arquivada ON mensageria.conversas USING btree (arquivada, last_message_at DESC);
CREATE INDEX notificacoes_user_idx ON mensageria.notificacoes USING btree (user_id, lida, criada_em DESC);
CREATE INDEX conv_resp_chat_idx ON mensageria.conversa_responsaveis USING btree (chat_id);
CREATE INDEX conv_resp_ref_idx ON mensageria.conversa_responsaveis USING btree (tipo, ref_id);
CREATE UNIQUE INDEX uq_msgs_apioficial_provider ON mensageria.mensagens_apioficial USING btree (provider_msg_id);
CREATE INDEX idx_msgs_apioficial_chat ON mensageria.mensagens_apioficial USING btree (chat_id, criada_em DESC);
CREATE UNIQUE INDEX uq_msg_apioficial_provider_total ON mensageria.mensagens_apioficial USING btree (provider_msg_id);
CREATE INDEX ix_mensagens_apioficial_conteudo_trgm ON mensageria.mensagens_apioficial USING gin (conteudo gin_trgm_ops);
CREATE INDEX ix_agendadas_pendentes ON mensageria.mensagens_agendadas USING btree (enviar_em) WHERE (status = 'pendente'::text);

-- functions
CREATE OR REPLACE FUNCTION mensageria.inc_nao_lidas(p_chat_id text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'mensageria', 'pg_temp'
AS $function$
  update mensageria.conversas set mensagens_nao_lidas = coalesce(mensagens_nao_lidas,0) + 1 where chat_id = p_chat_id;
$function$
;
CREATE OR REPLACE FUNCTION mensageria.merge_lid_chat(p_lid text, p_phone text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'mensageria', 'pg_temp'
AS $function$
declare
  movidas integer := 0;
  origem mensageria.conversas%rowtype;
begin
  select * into origem from mensageria.conversas where chat_id = p_lid;
  if not found then return 0; end if;

  -- garante o destino
  insert into mensageria.conversas (chat_id, nome, is_group, foto_url, canal, last_message_at, last_message_preview, status)
  values (p_phone, origem.nome, false, origem.foto_url, coalesce(origem.canal,'zapi-central'), origem.last_message_at, origem.last_message_preview, coalesce(origem.status,'aberto'))
  on conflict (chat_id) do update set
    nome = coalesce(mensageria.conversas.nome, excluded.nome),
    foto_url = coalesce(mensageria.conversas.foto_url, excluded.foto_url),
    last_message_at = greatest(coalesce(mensageria.conversas.last_message_at,'epoch'::timestamptz), coalesce(excluded.last_message_at,'epoch'::timestamptz));

  -- mensagens que ja existem no destino (mesmo provider_msg_id) sao descartadas
  delete from mensageria.mensagens m
   where m.chat_id = p_lid
     and m.provider_msg_id is not null
     and exists (select 1 from mensageria.mensagens d
                  where d.chat_id = p_phone and d.provider_msg_id = m.provider_msg_id);

  update mensageria.mensagens set chat_id = p_phone where chat_id = p_lid;
  get diagnostics movidas = row_count;

  -- soma nao lidas e mantem o preview mais recente
  update mensageria.conversas d set
    mensagens_nao_lidas = coalesce(d.mensagens_nao_lidas,0) + coalesce(origem.mensagens_nao_lidas,0),
    last_message_preview = case when coalesce(origem.last_message_at,'epoch'::timestamptz) > coalesce(d.last_message_at,'epoch'::timestamptz)
                                then origem.last_message_preview else d.last_message_preview end,
    responsavel_id = coalesce(d.responsavel_id, origem.responsavel_id),
    responsavel_nome = coalesce(d.responsavel_nome, origem.responsavel_nome),
    updated_at = now()
  where d.chat_id = p_phone;

  delete from mensageria.conversas where chat_id = p_lid;

  insert into mensageria.lid_mapping (lid, phone, chat_name, resolved_via)
  values (p_lid, p_phone, origem.nome, 'merge')
  on conflict (lid) do update set phone = excluded.phone, resolved_at = now();

  return movidas;
end;
$function$
;
CREATE OR REPLACE FUNCTION mensageria.relatorio_atendimento(p_canal text, p_dias integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$ with msgs as ( select m.chat_id, m.direcao, m.criada_em, m.enviado_por_nome from (select * from mensageria.mensagens where p_canal = 'central' union all select * from mensageria.mensagens_apioficial where p_canal = 'apioficial') m where m.criada_em >= now() - make_interval(days => p_dias) and m.direcao in ('in','out') ), convs as ( select case when p_canal='central' then (select count(*) from mensageria.conversas where status='aberto') else (select count(*) from mensageria.conversas_apioficial where status='aberto') end as aberto, case when p_canal='central' then (select count(*) from mensageria.conversas where status='atendimento') else (select count(*) from mensageria.conversas_apioficial where status='atendimento') end as atendimento, case when p_canal='central' then (select count(*) from mensageria.conversas where status='aguardando') else (select count(*) from mensageria.conversas_apioficial where status='aguardando') end as aguardando, case when p_canal='central' then (select count(*) from mensageria.conversas where status='concluido') else (select count(*) from mensageria.conversas_apioficial where status='concluido') end as concluido ), por_dia as ( select to_char(criada_em at time zone 'America/Sao_Paulo','YYYY-MM-DD') as dia, count(*) filter (where direcao='in') as recebidas, count(*) filter (where direcao='out') as enviadas from msgs group by 1 order by 1 ), por_atendente as ( select coalesce(enviado_por_nome,'(sem registro)') as nome, count(*) as enviadas from msgs where direcao='out' group by 1 order by 2 desc limit 20 ), primeira as ( select avg(extract(epoch from (o.primeira_out - i.primeira_in))) as media_s from ( select chat_id, min(criada_em) as primeira_in from msgs where direcao='in' group by chat_id ) i join lateral ( select min(criada_em) as primeira_out from msgs o where o.chat_id=i.chat_id and o.direcao='out' and o.criada_em > i.primeira_in ) o on true where o.primeira_out is not null ), csat as ( select round(avg(nota)::numeric,2) as media, count(*) as total from mensageria.avaliacoes where canal=p_canal and criada_em >= now() - make_interval(days => p_dias) ) select jsonb_build_object( 'por_status', (select jsonb_build_object('aberto',aberto,'atendimento',atendimento,'aguardando',aguardando,'concluido',concluido) from convs), 'por_dia', coalesce((select jsonb_agg(jsonb_build_object('dia',dia,'recebidas',recebidas,'enviadas',enviadas)) from por_dia),'[]'::jsonb), 'por_atendente', coalesce((select jsonb_agg(jsonb_build_object('nome',nome,'enviadas',enviadas)) from por_atendente),'[]'::jsonb), 'primeira_resposta_media_s', (select round(media_s::numeric,0) from primeira), 'csat_media', (select media from csat), 'csat_total', (select total from csat) ) $function$
;

-- permissoes pro backend (service_role) — inclui tabelas futuras
grant all on all tables in schema mensageria to service_role;
grant all on all sequences in schema mensageria to service_role;
grant execute on all functions in schema mensageria to service_role;
alter default privileges in schema mensageria grant all on tables to service_role;
notify pgrst, 'reload schema';