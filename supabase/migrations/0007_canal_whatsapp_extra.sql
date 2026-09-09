-- 0007_canal_whatsapp_extra.sql
-- Card 63m51nru8vcz (Central de Atendimento, subtarefa 5/8): 2a instancia Z-API.
--
-- Cada canal WhatsApp tem o PROPRIO par de tabelas (PK chat_id = telefone do
-- contato — juntar tudo numa tabela colidiria quem falou com mais de um numero).
-- Esta funcao cria o par de um canal NOVO clonando a estrutura ATUAL do central
-- (colunas, defaults, PK e indices — inclusive o trigram da busca), sem nenhum
-- nome de canal fixo aqui: quem decide o id e o CANAIS_EXTRA do painel
-- (lib/canais.ts assume conversas_<id>/mensagens_<id> por default).
--
-- Uso (SQL Editor do Supabase do painel, UMA vez por canal — gesto humano):
--   select mensageria.criar_canal_whatsapp('testador');
-- Idempotente: tabela que ja existe e preservada (if not exists).
--
-- Limites conhecidos (v1): inc_nao_lidas e merge_lid_chat continuam fixos nas
-- tabelas do central (o webhook trata canal extra por fora); relatorio_atendimento
-- so conhece central/apioficial.

create or replace function mensageria.criar_canal_whatsapp(p_id text)
returns text
language plpgsql
security definer
set search_path to 'mensageria', 'pg_temp'
as $$
declare
  t_conv text := 'conversas_' || p_id;
  t_msg  text := 'mensagens_' || p_id;
begin
  if p_id is null or p_id !~ '^[a-z][a-z0-9_]{1,30}$' then
    raise exception 'id de canal invalido: %', p_id;
  end if;
  if p_id in ('central', 'apioficial') then
    raise exception 'canal built-in ja tem tabelas: %', p_id;
  end if;

  execute format('create table if not exists mensageria.%I (like mensageria.conversas including all)', t_conv);
  execute format('create table if not exists mensageria.%I (like mensageria.mensagens including all)', t_msg);

  -- o schema ja tem default privileges pro service_role (0001); tabela criada
  -- dentro de funcao security definer segue o dono da funcao — garante explicito.
  execute format('grant all on mensageria.%I to service_role', t_conv);
  execute format('grant all on mensageria.%I to service_role', t_msg);

  return t_conv || ', ' || t_msg;
end;
$$;

grant execute on function mensageria.criar_canal_whatsapp(text) to service_role;
