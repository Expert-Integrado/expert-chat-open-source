-- Relatorio de atendimento agrupado no FUSO DA INSTALACAO.
--
-- Problema: `relatorio_atendimento(p_canal, p_dias)` agrupa o "por dia" com
-- `at time zone 'America/Sao_Paulo'` cravado no corpo da funcao. Numa instalacao
-- de outro fuso, a mensagem das 23h aparece no dia seguinte (ou no anterior) e
-- ninguem entende por que o grafico nao bate com a conversa.
--
-- Solucao: uma SOBRECARGA de 3 argumentos que recebe o fuso. A versao de 2
-- argumentos continua existindo e intacta — instalacao que ainda nao rodou esta
-- migration segue funcionando, e a rota /api/relatorio tenta a de 3 e cai na de
-- 2 automaticamente (o codigo nao cria nem exige DDL; rodar isto e gesto humano
-- no SQL Editor, como todo DDL deste repo).
--
-- Fuso invalido cai em UTC em vez de estourar: relatorio nao pode dar 500 por
-- causa de um campo de configuracao.
--
-- OBS deliberada: o CORTE do periodo (`now() - make_interval(days => p_dias)`)
-- segue sendo uma janela deslizante em UTC, nao "os ultimos N dias civis". Isso
-- ja era assim e nao muda aqui — o que esta migration conserta e o AGRUPAMENTO,
-- que e o que o usuario le como "dia".

create or replace function mensageria.relatorio_atendimento(p_canal text, p_dias integer, p_tz text)
 returns jsonb
 language sql
 stable
as $function$
with tz as (
  -- fuso desconhecido nao pode derrubar o relatorio inteiro
  select coalesce((select p_tz where exists (select 1 from pg_timezone_names where name = p_tz)), 'UTC') as nome
), msgs as (
  -- so as colunas usadas: as duas tabelas nao tem o MESMO conjunto de colunas,
  -- e `select *` num UNION quebra (42601) — pego rodando contra o banco real
  select m.chat_id, m.direcao, m.criada_em, m.enviado_por_nome
    from (select chat_id, direcao, criada_em, enviado_por_nome
            from mensageria.mensagens where p_canal = 'central'
          union all
          select chat_id, direcao, criada_em, enviado_por_nome
            from mensageria.mensagens_apioficial where p_canal = 'apioficial') m
   where m.criada_em >= now() - make_interval(days => p_dias)
     and m.direcao in ('in','out')
), convs as (
  select
    case when p_canal='central' then (select count(*) from mensageria.conversas where status='aberto')
         else (select count(*) from mensageria.conversas_apioficial where status='aberto') end as aberto,
    case when p_canal='central' then (select count(*) from mensageria.conversas where status='atendimento')
         else (select count(*) from mensageria.conversas_apioficial where status='atendimento') end as atendimento,
    case when p_canal='central' then (select count(*) from mensageria.conversas where status='aguardando')
         else (select count(*) from mensageria.conversas_apioficial where status='aguardando') end as aguardando,
    case when p_canal='central' then (select count(*) from mensageria.conversas where status='concluido')
         else (select count(*) from mensageria.conversas_apioficial where status='concluido') end as concluido
), por_dia as (
  select to_char(criada_em at time zone (select nome from tz),'YYYY-MM-DD') as dia,
         count(*) filter (where direcao='in') as recebidas,
         count(*) filter (where direcao='out') as enviadas
    from msgs group by 1 order by 1
), por_atendente as (
  select coalesce(enviado_por_nome,'(sem registro)') as nome, count(*) as enviadas
    from msgs where direcao='out' group by 1 order by 2 desc limit 20
), primeira as (
  select avg(extract(epoch from (o.primeira_out - i.primeira_in))) as media_s
    from (select chat_id, min(criada_em) as primeira_in from msgs where direcao='in' group by chat_id) i
    join lateral (select min(criada_em) as primeira_out from msgs o
                   where o.chat_id=i.chat_id and o.direcao='out' and o.criada_em > i.primeira_in) o on true
   where o.primeira_out is not null
), csat as (
  select round(avg(nota)::numeric,2) as media, count(*) as total
    from mensageria.avaliacoes
   where canal=p_canal and criada_em >= now() - make_interval(days => p_dias)
)
select jsonb_build_object(
  'por_status', (select jsonb_build_object('aberto',aberto,'atendimento',atendimento,'aguardando',aguardando,'concluido',concluido) from convs),
  'por_dia', coalesce((select jsonb_agg(jsonb_build_object('dia',dia,'recebidas',recebidas,'enviadas',enviadas)) from por_dia),'[]'::jsonb),
  'por_atendente', coalesce((select jsonb_agg(jsonb_build_object('nome',nome,'enviadas',enviadas)) from por_atendente),'[]'::jsonb),
  'primeira_resposta_media_s', (select round(media_s::numeric,0) from primeira),
  'csat_media', (select media from csat),
  'csat_total', (select total from csat),
  'fuso', (select nome from tz)
)
$function$;

grant execute on function mensageria.relatorio_atendimento(text, integer, text) to service_role;
notify pgrst, 'reload schema';
