-- Expert Chat — relatorios operacionais, series com pulo de fim de semana,
-- alertas de SLA e NPS historico (Frente J).
--
-- APLICAR NO SQL EDITOR DO SUPABASE DA SUA INSTALACAO. O codigo do painel NUNCA
-- cria tabela nem funcao: enquanto isto nao rodar, as rotas de relatorio
-- respondem com aviso (nunca 500) e o tick de SLA sai desligado.
--
-- Convencoes deste arquivo:
-- * As funcoes recebem o NOME DA TABELA do canal (p_tabela_*) em vez de derivar
--   pelo id: canal extra pode declarar tabelas proprias em CANAIS_EXTRA
--   (lib/canais.ts). O nome vem do registro do app; aqui ha 2a barreira
--   (regex + to_regclass) e quote_ident — nunca concatenacao crua.
-- * Agregacao mora no BANCO. O painel so pivota o resultado (lib/relatorios.ts).
--
-- ATENCAO NA APLICACAO — os 4 `create index` da secao 5b sao NAO-CONCORRENTES.
-- Eles tomam ACCESS EXCLUSIVE em mensagens/mensagens_apioficial/conversas* pelo
-- tempo do build: enquanto rodam, o webhook nao grava e o painel nao le aquela
-- tabela. Em instalacao pequena passa despercebido; com 100 mil+ mensagens sao
-- segundos a minutos de canal parado.
-- Nao da pra usar CONCURRENTLY aqui: ele NAO roda dentro de transacao, e o SQL
-- Editor do Supabase envolve o script inteiro em uma. Entao, em instalacao
-- grande, aplique este arquivo SEM a secao 5b e rode os 4 indices a parte, em
-- janela de baixo movimento — a mao, um por vez, com CONCURRENTLY se preferir.
-- O resto do arquivo (funcoes e tabelas novas) nao trava nada em uso.

-- ---------------------------------------------------------------------------
-- 1. segundos_uteis — duracao entre dois instantes IGNORANDO dias da semana
-- ---------------------------------------------------------------------------
-- p_pular = dias a descartar no fuso da instalacao (0=domingo .. 6=sabado).
-- Medir tempo de atendimento contando o fim de semana mente: conversa que chega
-- sexta 18h e e respondida segunda 9h vira "63h de espera" e nao foi.
--
-- ESPELHO de `segundosUteis()` em lib/relatorios.ts (mesma regra, mesmos casos
-- de borda) — a versao TS e a que o `node scripts/prova-relatorios.ts` prova.
-- MUDOU LA, MUDA AQUI.
create or replace function mensageria.segundos_uteis(
  p_ini timestamptz,
  p_fim timestamptz,
  p_fuso text,
  p_pular int[]
) returns numeric
language sql
stable
set search_path = pg_catalog, mensageria, pg_temp
as $$
  -- NULL dentro de p_pular envenena o `<> all`: `5 <> all (array[6,null])` e
  -- NULL, nao true, e a linha some do filtro — com um null no array TODOS os
  -- dias sumiriam e a funcao devolveria 0 caladinha. Guarda barata, mesmo o
  -- caso sendo hoje INALCANCAVEL pelos chamadores (diasIgnorados() monta o
  -- array com os literais SAB/DOM; ninguem injeta null).
  --
  -- POR QUE INLINE, e nao uma CTE: `<> all (...)` tem DUAS gramaticas no
  -- Postgres — forma-de-array e forma-de-subquery. Um `(select ... from lim)`
  -- nesta posicao cai na forma-de-subquery, que compararia int[] com integer,
  -- nao acha operador e derruba o CREATE FUNCTION logo na 1a aplicacao (o
  -- check_function_bodies default valida o corpo). Chamada de funcao e sempre
  -- forma-de-array, entao a expressao vai repetida nos dois pontos de
  -- proposito. NAO extrair pra CTE nem pra variavel de subquery.
  select case
    when p_ini is null or p_fim is null or p_fim <= p_ini then 0::numeric
    when coalesce(array_length(array_remove(coalesce(p_pular, '{}'::int[]), null), 1), 0) = 0
      then extract(epoch from (p_fim - p_ini))::numeric
    -- intervalo absurdo (dado sujo): nao varre 10 mil dias, devolve o cru
    when p_fim - p_ini > interval '400 days'
      then extract(epoch from (p_fim - p_ini))::numeric
    else coalesce((
      select sum(extract(epoch from (x.fim_d - x.ini_d)))::numeric
      from (
        select
          greatest(p_ini, (d::timestamp at time zone p_fuso)) as ini_d,
          least(p_fim, ((d::timestamp + interval '1 day') at time zone p_fuso)) as fim_d
        from generate_series(
          date_trunc('day', (p_ini at time zone p_fuso)),
          date_trunc('day', (p_fim at time zone p_fuso)),
          interval '1 day'
        ) d
        where extract(dow from d)::int <> all (array_remove(coalesce(p_pular, '{}'::int[]), null))
      ) x
      where x.fim_d > x.ini_d
    ), 0::numeric)
  end
$$;

-- ---------------------------------------------------------------------------
-- 2. relatorio_operacional — contagens CRUAS pro painel departamento x status
-- ---------------------------------------------------------------------------
-- Devolve group-by achatado; quem pivota na matriz e `montarMatriz()` em
-- lib/relatorios.ts (funcao PURA, provada sem banco). Aqui fica so o que o
-- banco faz melhor: contar sem trazer 12 mil linhas pro Node.
--
-- `sem_dono` = conversa sem NENHUMA linha em conversa_responsaveis. E a linha
-- mais importante da tela (trabalho que nao e responsabilidade de ninguem).
--
-- ARQUIVADA: esta funcao EXCLUI arquivada por default (p_incluir_arquivadas).
-- `relatorio_serie` NAO filtra arquivada nenhuma, e a diferenca e de proposito:
-- aqui a pergunta e "o que esta na minha fila AGORA" (arquivada saiu da fila),
-- la a pergunta e "o que aconteceu no periodo" (arquivar uma conversa hoje nao
-- pode apagar o atendimento que ela teve em junho). Igualar os dois estragaria
-- um dos lados — se um dia mudar, mude com esta nota na mao.
create or replace function mensageria.relatorio_operacional(
  p_canal text,
  p_tabela text,
  p_incluir_arquivadas boolean default false
) returns jsonb
language plpgsql
stable
set search_path = pg_catalog, mensageria, pg_temp
as $$
declare
  v_out jsonb;
begin
  if p_canal is null or p_canal !~ '^[a-z][a-z0-9_]{1,30}$' then
    return jsonb_build_object('erro', 'canal invalido');
  end if;
  if p_tabela is null or p_tabela !~ '^[a-z][a-z0-9_]{1,60}$' then
    return jsonb_build_object('erro', 'tabela invalida');
  end if;
  if to_regclass('mensageria.' || quote_ident(p_tabela)) is null then
    return jsonb_build_object('erro', 'canal sem tabela no banco', 'tabela', p_tabela);
  end if;

  execute format($q$
    with conv as (
      select c.chat_id, c.status
      from mensageria.%I c
      where (%L::boolean or c.arquivada = false)
    ),
    resp as (
      select r.chat_id, r.tipo, r.ref_id, r.nome
      from mensageria.conversa_responsaveis r
      where r.canal = %L
    ),
    linhas as (
      -- conversa com N responsaveis conta em CADA linha (igual a matriz da
      -- ferramenta de origem); por isso a soma das linhas > total do cabecalho
      -- INVARIANTE que faz o count(*) ser seguro aqui: conversa_responsaveis
      -- tem PK (canal, chat_id, tipo, ref_id) — nao existe linha repetida pro
      -- mesmo dono na mesma conversa. Se essa PK cair, isto vira dupla
      -- contagem e precisa virar count(distinct c.chat_id).
      select r.tipo, r.ref_id, max(r.nome) as nome, c.status, count(*)::int as n
      from conv c
      join resp r on r.chat_id = c.chat_id
      group by r.tipo, r.ref_id, c.status
    ),
    sem_dono as (
      select c.status, count(*)::int as n
      from conv c
      where not exists (select 1 from resp r where r.chat_id = c.chat_id)
      group by c.status
    ),
    totais as (
      select c.status, count(*)::int as n from conv c group by c.status
    )
    select jsonb_build_object(
      'linhas', coalesce((select jsonb_agg(jsonb_build_object(
          'tipo', tipo, 'ref_id', ref_id, 'nome', nome, 'status', status, 'n', n
        )) from linhas), '[]'::jsonb),
      'sem_dono', coalesce((select jsonb_agg(jsonb_build_object(
          'status', status, 'n', n)) from sem_dono), '[]'::jsonb),
      'totais', coalesce((select jsonb_agg(jsonb_build_object(
          'status', status, 'n', n)) from totais), '[]'::jsonb)
    )
  $q$, p_tabela, p_incluir_arquivadas, p_canal) into v_out;

  return v_out;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. relatorio_serie — os 6 graficos operacionais, agregados por DIA LOCAL
-- ---------------------------------------------------------------------------
-- p_pular so afeta o TEMPO DE ATENDIMENTO (horas de sabado/domingo saem da
-- conta, via mensageria.segundos_uteis). Os BALDES continuam voltando TODOS,
-- cada um com o seu `dow`; quem descarta os dias de fim de semana da EXIBICAO
-- e `filtrarDias()` no painel (pura, provada). Assim o dado cru volta inteiro e
-- a regra de exibicao vive num lugar so.
--
-- EFEITO COLATERAL ACEITO, e preciso saber dele: com p_pular preenchido, o
-- atendimento feito NO fim de semana vira tempo ZERO. Uma conversa que chegou
-- sabado 10h e foi respondida sabado 11h entra com 0s, nao com 1h — as horas do
-- dia ignorado nao existem pra conta. E o preco de nao contar as 63h da
-- conversa de sexta-pra-segunda, e e a escolha certa pra quem NAO atende no fim
-- de semana. Operacao que atende sabado nao deve marcar a caixinha.
--
-- APROXIMACAO DECLARADA (leia com atencao — o texto ja esteve errado aqui):
-- `primeira_in` e o primeiro recebimento DENTRO da janela pedida, nao o
-- primeiro da conversa. Conversa que comecou antes de p_desde ENTRA no
-- calculo assim mesmo — o que muda e que o tempo dela e medido a partir da
-- primeira mensagem dentro do periodo, nao do inicio real. E a mesma
-- aproximacao que `relatorio_atendimento` faz desde a 0001.
create or replace function mensageria.relatorio_serie(
  p_canal text,
  p_tabela_conversas text,
  p_tabela_mensagens text,
  p_desde timestamptz,
  p_ate timestamptz,
  p_fuso text default 'America/Sao_Paulo',
  p_pular int[] default null
) returns jsonb
language plpgsql
stable
set search_path = pg_catalog, mensageria, pg_temp
as $$
declare
  v_out jsonb;
begin
  if p_canal is null or p_canal !~ '^[a-z][a-z0-9_]{1,30}$' then
    return jsonb_build_object('erro', 'canal invalido');
  end if;
  if p_tabela_conversas is null or p_tabela_conversas !~ '^[a-z][a-z0-9_]{1,60}$'
     or p_tabela_mensagens is null or p_tabela_mensagens !~ '^[a-z][a-z0-9_]{1,60}$' then
    return jsonb_build_object('erro', 'tabela invalida');
  end if;
  if to_regclass('mensageria.' || quote_ident(p_tabela_conversas)) is null
     or to_regclass('mensageria.' || quote_ident(p_tabela_mensagens)) is null then
    return jsonb_build_object('erro', 'canal sem tabela no banco');
  end if;
  -- fuso invalido derrubaria a consulta inteira; cai no padrao com aviso
  begin
    perform now() at time zone p_fuso;
  exception when others then
    return jsonb_build_object('erro', 'fuso invalido', 'fuso', p_fuso);
  end;

  execute format($q$
    with janela as (
      select m.chat_id, m.direcao, m.criada_em, m.enviado_por_nome
      from mensageria.%I m
      where m.criada_em >= %L::timestamptz
        and m.criada_em <  %L::timestamptz
        and m.direcao in ('in', 'out')
    ),
    novos as (
      select to_char(c.created_at at time zone %L, 'YYYY-MM-DD') as dia,
             extract(dow from (c.created_at at time zone %L))::int as dow,
             count(*)::int as n
      from mensageria.%I c
      where c.created_at >= %L::timestamptz and c.created_at < %L::timestamptz
      group by 1, 2
    ),
    antes as (
      select count(*)::int as n from mensageria.%I c where c.created_at < %L::timestamptz
    ),
    msgs_dia as (
      select to_char(criada_em at time zone %L, 'YYYY-MM-DD') as dia,
             extract(dow from (criada_em at time zone %L))::int as dow,
             count(*) filter (where direcao = 'in')::int as recebidas,
             count(*) filter (where direcao = 'out')::int as enviadas
      from janela group by 1, 2
    ),
    por_usuario as (
      select coalesce(nullif(enviado_por_nome, ''), '(sem registro)') as nome,
             count(*)::int as enviadas
      from janela where direcao = 'out' group by 1 order by 2 desc limit 50
    ),
    primeiras_in as (
      select chat_id, min(criada_em) as primeira_in
      from janela where direcao = 'in' group by chat_id
    ),
    -- JOIN + GROUP BY, nao LATERAL. O lateral rodava uma varredura da CTE
    -- `janela` (materializada, sem indice) PRA CADA chat: com 100 mil mensagens
    -- e 5 mil chats sao 500 milhoes de comparacoes, e dias=365 e permitido —
    -- timeout garantido em instalacao grande. Assim o planejador faz UM hash
    -- join e agrega. Resultado identico: min() do primeiro `out` posterior ao
    -- primeiro `in`; chat sem `out` qualificado nao aparece (join interno), que
    -- e o mesmo que o antigo `where primeira_out is not null` fazia.
    pares as (
      select i.chat_id, i.primeira_in, min(o.criada_em) as primeira_out
      from primeiras_in i
      join janela o
        on o.chat_id = i.chat_id
       and o.direcao = 'out'
       and o.criada_em > i.primeira_in
      group by i.chat_id, i.primeira_in
    ),
    atendimentos as (
      select to_char(primeira_out at time zone %L, 'YYYY-MM-DD') as dia,
             extract(dow from (primeira_out at time zone %L))::int as dow,
             count(*)::int as n
      from pares group by 1, 2
    ),
    tempo as (
      select to_char(primeira_in at time zone %L, 'YYYY-MM-DD') as dia,
             extract(dow from (primeira_in at time zone %L))::int as dow,
             count(*)::int as n,
             round(avg(mensageria.segundos_uteis(primeira_in, primeira_out, %L, %L::int[])))::bigint as media_s,
             round(avg(extract(epoch from (primeira_out - primeira_in))))::bigint as media_bruta_s
      from pares group by 1, 2
    )
    select jsonb_build_object(
      'novos_chats', coalesce((select jsonb_agg(jsonb_build_object('dia',dia,'dow',dow,'n',n) order by dia) from novos), '[]'::jsonb),
      'acumulado_base', (select n from antes),
      'mensagens', coalesce((select jsonb_agg(jsonb_build_object('dia',dia,'dow',dow,'recebidas',recebidas,'enviadas',enviadas) order by dia) from msgs_dia), '[]'::jsonb),
      'por_usuario', coalesce((select jsonb_agg(jsonb_build_object('nome',nome,'enviadas',enviadas)) from por_usuario), '[]'::jsonb),
      'novos_atendimentos', coalesce((select jsonb_agg(jsonb_build_object('dia',dia,'dow',dow,'n',n) order by dia) from atendimentos), '[]'::jsonb),
      'tempo_atendimento', coalesce((select jsonb_agg(jsonb_build_object('dia',dia,'dow',dow,'n',n,'media_s',media_s,'media_bruta_s',media_bruta_s) order by dia) from tempo), '[]'::jsonb)
    )
  $q$,
    p_tabela_mensagens, p_desde, p_ate,
    p_fuso, p_fuso, p_tabela_conversas, p_desde, p_ate,
    p_tabela_conversas, p_desde,
    p_fuso, p_fuso,
    p_fuso, p_fuso,
    p_fuso, p_fuso, p_fuso, coalesce(p_pular, '{}'::int[])
  ) into v_out;

  return v_out;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. sla_conversas — a consulta salva dos alertas agendados
-- ---------------------------------------------------------------------------
-- p_idade_min = MINUTOS sem interacao (last_message_at). Cobre "8h",
-- "1 dia" (1440) e "7 dias" (10080) sem inventar unidade nova.
-- p_departamento: id do departamento (tipo='departamento'); a string
-- '__sem_dono__' filtra conversa sem NENHUM responsavel.
create or replace function mensageria.sla_conversas(
  p_canal text,
  p_tabela text,
  p_status text[] default null,
  p_departamento text default null,
  p_idade_min int default 0,
  p_limite int default 50
) returns jsonb
language plpgsql
stable
set search_path = pg_catalog, mensageria, pg_temp
as $$
declare
  v_out jsonb;
  v_corte timestamptz := now() - make_interval(mins => greatest(coalesce(p_idade_min, 0), 0));
  v_lim int := least(greatest(coalesce(p_limite, 50), 1), 500);
begin
  if p_canal is null or p_canal !~ '^[a-z][a-z0-9_]{1,30}$' then
    return jsonb_build_object('erro', 'canal invalido');
  end if;
  if p_tabela is null or p_tabela !~ '^[a-z][a-z0-9_]{1,60}$' then
    return jsonb_build_object('erro', 'tabela invalida');
  end if;
  if to_regclass('mensageria.' || quote_ident(p_tabela)) is null then
    return jsonb_build_object('erro', 'canal sem tabela no banco', 'tabela', p_tabela);
  end if;

  execute format($q$
    with resp as (
      select r.chat_id, r.tipo, r.ref_id, r.nome
      from mensageria.conversa_responsaveis r where r.canal = %L
    ),
    alvo as (
      select c.chat_id, c.nome, c.status, c.last_message_at
      from mensageria.%I c
      where c.arquivada = false
        and (%L::text[] is null or c.status = any (%L::text[]))
        and coalesce(c.last_message_at, c.created_at) <= %L::timestamptz
        and (
          %L::text is null
          or (%L::text = '__sem_dono__'
              and not exists (select 1 from resp r where r.chat_id = c.chat_id))
          or exists (select 1 from resp r
                     where r.chat_id = c.chat_id and r.tipo = 'departamento' and r.ref_id = %L::text)
        )
    )
    select jsonb_build_object(
      'total', (select count(*)::int from alvo),
      'conversas', coalesce((
        select jsonb_agg(x) from (
          select jsonb_build_object(
            'chat_id', a.chat_id,
            'nome', a.nome,
            'status', a.status,
            'last_message_at', a.last_message_at,
            'responsaveis', coalesce((
              select jsonb_agg(jsonb_build_object('tipo', r.tipo, 'nome', r.nome))
              from resp r where r.chat_id = a.chat_id), '[]'::jsonb)
          ) as x
          from alvo a
          order by coalesce(a.last_message_at, '-infinity'::timestamptz) asc
          limit %s
        ) y), '[]'::jsonb)
    )
  $q$,
    p_canal, p_tabela,
    p_status, p_status,
    v_corte,
    p_departamento, p_departamento, p_departamento,
    v_lim
  ) into v_out;

  return v_out;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. NPS historico — dado de CLIENTE que veio de outra ferramenta
-- ---------------------------------------------------------------------------
-- NPS como FUNCIONALIDADE (envio, regua, calculo ao vivo) NAO entra aqui: a
-- decisao registrada e guardar as respostas ja coletadas como dado historico.
-- O CSAT proprio do painel continua em mensageria.avaliacoes — sao coisas
-- diferentes e nao se misturam.
-- GOTCHA QUE JA CUSTOU CARO NESTE REPO (ver CLAUDE.md, dedupe de mensagem):
-- o PostgREST RECUSA `on_conflict` sobre indice unico PARCIAL com erro 42P10.
-- O `uq_mensagens_provider` parcial existe ate hoje e foi por isso que
-- precisaram criar o `uq_mensagens_provider_total` do lado. Aqui os indices de
-- dedupe nascem TOTAIS (sem `where`), e pra isso `origem_id` e NOT NULL: o
-- importador SEMPRE preenche (deriva um id estavel do conteudo quando a origem
-- nao tem id proprio). Indice parcial aqui daria 42P10 na 1a gravacao real.
create table if not exists mensageria.nps_pesquisas (
  id uuid primary key default gen_random_uuid(),
  -- de onde veio (ex: 'chatguru'); id da pesquisa na ferramenta de origem
  origem text not null,
  origem_id text not null,
  nome text not null,
  ativa boolean not null default false,
  importada_em timestamp with time zone not null default now(),
  meta jsonb
);
-- derruba a versao PARCIAL do rascunho desta migration, se alguem chegou a
-- rodar: `create index if not exists` de mesmo nome NAO corrigiria sozinho
drop index if exists mensageria.uq_nps_pesquisas_origem;
create unique index if not exists uq_nps_pesquisas_origem
  on mensageria.nps_pesquisas (origem, origem_id);

create table if not exists mensageria.nps_respostas (
  id uuid primary key default gen_random_uuid(),
  pesquisa_id uuid not null,
  -- ligacao com a conversa de origem quando existir (canal + chat_id do painel)
  canal text,
  chat_id text,
  nota integer,
  comentario text,
  respondida_em timestamp with time zone,
  origem text not null default 'chatguru',
  origem_id text not null,
  importada_em timestamp with time zone not null default now()
);
-- dedupe da importacao: rodar de novo nao duplica resposta
drop index if exists mensageria.uq_nps_respostas_origem;
create unique index if not exists uq_nps_respostas_origem
  on mensageria.nps_respostas (origem, origem_id);
create index if not exists ix_nps_respostas_pesquisa on mensageria.nps_respostas (pesquisa_id);
create index if not exists ix_nps_respostas_conversa on mensageria.nps_respostas (canal, chat_id);
-- a rota filtra o periodo por respondida_em
create index if not exists ix_nps_respostas_respondida on mensageria.nps_respostas (respondida_em);

-- RLS ligada com ZERO policy + grant so pro service_role (convencao da casa
-- desde a 0002): anon e usuario logado levam 42501 no PostgREST direto. Sao
-- respostas de pesquisa de cliente — nao podem sair pela anon key do bundle.
alter table mensageria.nps_pesquisas enable row level security;
alter table mensageria.nps_respostas enable row level security;

-- ---------------------------------------------------------------------------
-- 5b. Indices do que as funcoes deste arquivo FILTRAM
-- ---------------------------------------------------------------------------
-- Os indices que ja existiam sao `(chat_id, criada_em DESC)`: otimos pra abrir
-- UMA conversa, inuteis pra varrer um PERIODO inteiro (a coluna de data e a 2a
-- do indice). `relatorio_serie` filtra exatamente por periodo, com dias ate
-- 365 — sem estes indices e seq scan na tabela inteira toda vez.
create index if not exists ix_mensagens_criada_em
  on mensageria.mensagens (criada_em);
create index if not exists ix_mensagens_apioficial_criada_em
  on mensageria.mensagens_apioficial (criada_em);
create index if not exists ix_conversas_created_at
  on mensageria.conversas (created_at);
create index if not exists ix_conversas_apioficial_created_at
  on mensageria.conversas_apioficial (created_at);

-- ---------------------------------------------------------------------------
-- 6. Grants + reload (tabela nova no schema nasce sem grant — gotcha da casa)
-- ---------------------------------------------------------------------------
grant all on all tables in schema mensageria to service_role;
grant execute on all functions in schema mensageria to service_role;
-- as funcoes leem tabela de conversa/mensagem: ninguem alem do service_role
revoke execute on function mensageria.segundos_uteis(timestamptz, timestamptz, text, int[]) from public, anon, authenticated;
revoke execute on function mensageria.relatorio_operacional(text, text, boolean) from public, anon, authenticated;
revoke execute on function mensageria.relatorio_serie(text, text, text, timestamptz, timestamptz, text, int[]) from public, anon, authenticated;
revoke execute on function mensageria.sla_conversas(text, text, text[], text, int, int) from public, anon, authenticated;
notify pgrst, 'reload schema';
