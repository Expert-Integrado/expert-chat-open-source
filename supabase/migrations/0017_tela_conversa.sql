-- 0017_tela_conversa.sql
-- A TELA DE CONVERSA: kit de acoes (86ak85nyv), historicos (86ak85nx0) e
-- historico de transferencia (86ak85nwu).
--
-- ATENCAO: este arquivo NAO e executado por codigo nenhum. Rodar a migration e
-- gesto humano no SQL Editor do Supabase da instalacao (mesma convencao das
-- 0008/0009/0015/0016). Idempotente: pode rodar de novo. Enquanto nao rodar, o
-- painel degrada com aviso — historico responde lista vazia, o robo continua
-- ligado (default seguro) e iniciar conversa segue funcionando sem a trilha.
-- Nunca 500.
--
-- Gotcha do repo (CLAUDE.md): tabela nova no schema `mensageria` costuma nascer
-- SEM grant e a rota devolve 500 (permission denied do service_role). Os grants
-- explicitos no fim cobrem o caso de a migration rodar com outro dono.
--
-- ------------------------------------------------------------------------
-- O QUE O VERIFY ACHOU, e por que cada peca daqui existe (31/08/2026)
-- ------------------------------------------------------------------------
--   * "a 0006 ja grava eventos status_alterado" — NAO grava. A 0006 poe TRES
--     COLUNAS na conversa (status_alterado_por_id/_nome/_em) que guardam so a
--     ULTIMA troca. `status_alterado` e nome de EVENTO DE WEBHOOK (0017 nao
--     mexe nisso, ver lib/webhooks-saida.ts) — evento que sai pela rede e
--     morre, nao linha de historico. Logo, historico de status nasce aqui.
--   * A atribuicao de responsavel grava em `conversa_responsaveis`, que e
--     ESTADO ATUAL (PK canal+chat_id+tipo+ref_id) e nao guarda nem QUEM
--     atribuiu nem QUANDO saiu. `notificacoes` (0001) tem titulo/texto pra
--     pessoa e e apagavel — nao serve de trilha. Logo, trilha de transferencia
--     nasce aqui.
--   * Ligar/desligar o robo POR CONVERSA nao existe em lugar nenhum do repo
--     (zero ocorrencia de bot_ativo/toggle_bot). Nasce aqui, como coluna.

-- ---------------------------------------------------------------------------
-- 1. Robo por conversa + autoria de quem abriu a conversa pelo painel
-- ---------------------------------------------------------------------------
-- POR QUE COLUNA NA CONVERSA, e nao tabela associativa: a pergunta e sempre
-- "esta conversa aceita automacao?", feita UMA vez por mensagem recebida, no
-- caminho mais quente do painel. Tabela a parte custaria um SELECT extra por
-- mensagem pra guardar um booleano.
--
-- DEFAULT TRUE de proposito: o robo LIGADO e o comportamento que a instalacao
-- ja tem hoje. Nascer `false` desligaria a automacao de toda conversa antiga na
-- hora em que a migration rodasse — mudanca de comportamento escondida dentro
-- de um ALTER TABLE.
--
-- `bot_ativo` vale SO pro caminho de GATILHO (automacao decidindo sozinha).
-- Macro disparado a mao por atendente NUNCA e barrado por ele: desligar o robo
-- e dizer "para de agir sozinho aqui", nao "me tira a ferramenta da mao".
alter table mensageria.conversas
  add column if not exists bot_ativo             boolean not null default true,
  add column if not exists bot_alterado_por_id   uuid,
  add column if not exists bot_alterado_por_nome text,
  add column if not exists bot_alterado_em       timestamp with time zone,
  -- quem abriu a conversa PELO PAINEL (gesto explicito de gente). Conversa que
  -- nasceu de mensagem do cliente fica com os tres NULL, e isso e informacao:
  -- distingue "o cliente procurou a empresa" de "a empresa procurou o cliente".
  add column if not exists iniciada_por_id       uuid,
  add column if not exists iniciada_por_nome     text,
  add column if not exists iniciada_em           timestamp with time zone;

alter table mensageria.conversas_apioficial
  add column if not exists bot_ativo             boolean not null default true,
  add column if not exists bot_alterado_por_id   uuid,
  add column if not exists bot_alterado_por_nome text,
  add column if not exists bot_alterado_em       timestamp with time zone,
  add column if not exists iniciada_por_id       uuid,
  add column if not exists iniciada_por_nome     text,
  add column if not exists iniciada_em           timestamp with time zone;

comment on column mensageria.conversas.bot_ativo is
  'Automacao pode agir SOZINHA nesta conversa (caminho de gatilho). Macro manual de atendente ignora esta chave de proposito. Default true = comportamento historico do painel.';
comment on column mensageria.conversas.iniciada_por_id is
  'Usuario que abriu a conversa pelo painel (POST /api/conversa/iniciar). NULL = a conversa nasceu de mensagem recebida ou de campanha.';

-- O teto de "conversas novas por hora por usuario" e contado por aqui: e o que
-- impede o botao de conversa nova de virar ferramenta de disparo frio.
create index if not exists idx_conversas_iniciada_por
  on mensageria.conversas (iniciada_por_id, iniciada_em desc)
  where iniciada_em is not null;
create index if not exists idx_conversas_apioficial_iniciada_por
  on mensageria.conversas_apioficial (iniciada_por_id, iniciada_em desc)
  where iniciada_em is not null;

-- ---------------------------------------------------------------------------
-- 2. Historico de STATUS da conversa
-- ---------------------------------------------------------------------------
-- Modelada em cima de `mensageria.conversa_funil_eventos` (0009), que ja e a
-- forma da casa pra trilha por conversa: chave (canal, chat_id), referencia
-- solta sem FK, autoria pela convencao da 0006, e as colunas de fluxo pra
-- trilha de OUTRAS tabelas reconhecerem movimento vindo do motor.
--
-- O modulo 10 do mapa mediu no ChatGuru que o historico de status deles calcula
-- PERMANENCIA por status, e que e dali que sai tempo de atendimento. Por isso a
-- coluna `duracao_seg`: quanto tempo a conversa passou NO STATUS ANTERIOR.
--
-- POR QUE A DURACAO E GRAVADA, e nao so derivada na leitura: derivar exige ter
-- TODOS os eventos da conversa em maos (o primeiro evento nao tem antecessor no
-- historico — o "de" dele vem de `conversas.created_at`). Uma leitura paginada,
-- ou um historico que comeca depois da migration, calcularia duracao errada e
-- com cara de certa. Gravado no momento da troca, o numero nao depende de quem
-- le. A leitura ainda calcula a permanencia do status ATUAL (que ainda nao
-- terminou), e essa sim e derivada de propostio: ela muda a cada segundo.
create table if not exists mensageria.conversa_status_eventos (
  id uuid primary key default gen_random_uuid(),
  canal text not null,
  chat_id text not null,
  -- 'aberto' | 'atendimento' | 'aguardando' | 'concluido' (STATUS_VALIDOS da rota)
  status text not null,
  -- status de onde saiu. NULL = primeiro evento registrado desta conversa
  -- (inclusive o caso "a migration rodou hoje, a conversa e de 2024").
  status_anterior text,
  -- quanto tempo ficou no `status_anterior`, em segundos. NULL quando nao havia
  -- de onde medir (primeiro evento sem marco anterior confiavel).
  duracao_seg integer,
  -- pessoa (id+nome) | automacao (id NULL + nome) — convencao da 0006
  por_id uuid,
  por_nome text,
  -- 'painel' | 'gatilho' | 'csat' | 'importacao' | ... (texto livre de
  -- proposito: caminho novo de troca de status entra sem ALTER)
  origem text,
  -- preenchidos quando a troca veio do motor de fluxo
  fluxo_slug text,
  fluxo_nome text,
  criada_em timestamptz not null default now()
);

-- A pergunta da tela e "o historico DESTA conversa, do mais novo pro mais
-- velho". A do relatorio e "o que mudou nesta janela".
create index if not exists ix_status_eventos_conversa
  on mensageria.conversa_status_eventos (canal, chat_id, criada_em desc);
create index if not exists ix_status_eventos_periodo
  on mensageria.conversa_status_eventos (criada_em desc);

comment on table mensageria.conversa_status_eventos is
  'Trilha de troca de status por conversa, com permanencia no status anterior. Guarda TAMBEM o liga/desliga do robo da conversa (origem = robo, status robo_ligado/robo_desligado) — mesma classe de defeito (mudanca de estado sem autor) e mesma trilha; a linha do tempo de status e o tempo-por-status EXCLUEM esses eventos. COBERTURA v1: so POST /api/conversa e /api/conversa/iniciar emitem. Trocas de raspao (auto atendimento ao responder, auto desarquivar na ingestao, motor de fluxo) ainda NAO emitem — declarado, nao e bug escondido.';

-- ---------------------------------------------------------------------------
-- 3. Historico de TRANSFERENCIA (responsavel)
-- ---------------------------------------------------------------------------
-- O mapa (modulo 10, secao 7.2) capturou o formato real do ChatGuru: tres
-- colunas — delegado (usuario OU departamento), delegado por (inclui
-- `ChatBot`), data e hora. A automacao delega, e o log registra isso com o
-- mesmo peso de uma acao humana. E exatamente a convencao da 0006, entao a
-- coluna de autoria e a mesma: id+nome = pessoa, id NULL + nome = automacao.
--
-- POR QUE `conversa_responsaveis` NAO SERVE: a PK e (canal, chat_id, tipo,
-- ref_id). Ela responde "quem e o dono AGORA". Remover um responsavel APAGA a
-- linha — e com ela a unica prova de que aquela pessoa foi responsavel um dia.
-- Como o modulo 1 do mapa registra que a mensagem enviada nao guarda autor na
-- origem, esta trilha e o que sobra de rastreabilidade de responsabilidade.
create table if not exists mensageria.conversa_responsavel_eventos (
  id uuid primary key default gen_random_uuid(),
  canal text not null,
  chat_id text not null,
  -- 'atribuido' | 'removido'
  acao text not null,
  -- 'usuario' | 'departamento' (mesmo dominio de conversa_responsaveis.tipo)
  tipo text not null,
  -- referencia solta (sem FK): usuario ou departamento apagado nao apaga a trilha
  ref_id text not null,
  -- nome CONGELADO no momento do evento (nao segue rename), igual a 0006
  ref_nome text,
  -- pessoa (id+nome) | automacao (id NULL + nome) — convencao da 0006
  por_id uuid,
  por_nome text,
  -- 'painel' | 'rodizio' | 'gatilho' | 'reinicio' | 'importacao' | ...
  origem text,
  fluxo_slug text,
  fluxo_nome text,
  criada_em timestamptz not null default now()
);

create index if not exists ix_resp_eventos_conversa
  on mensageria.conversa_responsavel_eventos (canal, chat_id, criada_em desc);
-- "o que passou pela mao desta pessoa" — a pergunta de gestao
create index if not exists ix_resp_eventos_ref
  on mensageria.conversa_responsavel_eventos (tipo, ref_id, criada_em desc);

comment on table mensageria.conversa_responsavel_eventos is
  'Trilha de transferencia da conversa: quem passou pra quem, quando e por que caminho. COBERTURA v1: so POST /api/conversa emite. lib/rodizio.ts, lib/fluxo/executar.ts e lib/conversa-reinicio.ts tambem escrevem em conversa_responsaveis e ainda NAO emitem — costura declarada no CLAUDE.md.';

-- ---------------------------------------------------------------------------
-- 4. Indice pra busca DENTRO da conversa, e o que a leitura de avaliacao usa
-- ---------------------------------------------------------------------------
-- A busca da tela filtra por (chat_id) e ordena por criada_em desc, e o filtro
-- de conteudo e `ilike '%termo%'`. Os indices de (chat_id, criada_em desc) ja
-- existem desde a 0001, e sao eles que fazem a busca escopada ser barata: ela
-- varre as mensagens de UMA conversa, nao a tabela inteira. Nada a criar aqui —
-- registrado pra ninguem "otimizar" com um trigram por conversa que nao paga.
--
-- O que SIM falta e o indice de conteudo pra busca GLOBAL (/api/busca), que
-- hoje faz ilike sem indice trigram apesar do comentario da rota dizer o
-- contrario. NAO entra nesta migration: e outra tela e outro dono.

-- `mensageria.avaliacoes` (0001) nasceu SEM indice nenhum: a leitura de
-- avaliacao por conversa (painel novo) filtra por (canal, chat_id) e ordena por
-- criada_em, e sem isto e varredura completa da tabela a cada abertura de aba.
-- A irma `nps_respostas` ja tem o equivalente desde a 0013
-- (`ix_nps_respostas_conversa`).
create index if not exists ix_avaliacoes_conversa
  on mensageria.avaliacoes (canal, chat_id, criada_em desc);

-- ---------------------------------------------------------------------------
-- 5. RESERVA ATOMICA de conversa nova — o teto que nao vaza em corrida
-- ---------------------------------------------------------------------------
-- ACHADO DA REVISAO CEGA (31/08/2026). A primeira versao do teto lia a contagem
-- em JavaScript e so depois enviava:
--
--     const total = await contar();      <-- 300 chamadas leem "0" aqui
--     if (total >= 20) return 429;
--     await enviarPeloProvedor();        <-- e as 300 passam
--
-- Entre a leitura e a escrita nao havia nada, entao N chamadas paralelas liam a
-- MESMA contagem e todas passavam. Um teto que so vale quando ninguem esta com
-- pressa nao e teto — e justamente sob pressa (script, agente, aba duplicada)
-- que ele precisava valer.
--
-- O CONSERTO, EM DUAS PECAS — e a primeira sozinha NAO BASTA (achado da
-- re-revisao, 31/08/2026):
--
--   (a) a contagem e a insercao viram UMA instrucao (`insert ... select ...
--       where (select count(*) ...) < p_teto`);
--   (b) um `pg_advisory_xact_lock` POR PESSOA, tomado antes dela.
--
-- POR QUE (a) SOZINHA NAO SERIA ATOMICA — e o texto anterior afirmava que era,
-- o que e pior que o bug: sob READ COMMITTED (default do Postgres), cada
-- instrucao toma o SEU snapshot e NAO ve inserts ainda nao commitados de outros
-- backends. Com 300 numeros DIFERENTES em paralelo, as 300 instrucoes leem
-- count=0 e as 300 passam. O indice unico de `chat_id` so serializa quando o
-- numero e o MESMO — e o teto nao e sobre um numero, e sobre a PESSOA.
--
-- O lock advisorio de TRANSACAO fecha exatamente essa janela, e a chave dele e
-- `p_user_id` porque essa e a granularidade do teto: duas pessoas abrindo
-- conversa ao mesmo tempo nao se esperam; a mesma pessoa em 300 chamadas
-- paralelas serializa. `_xact_` (e nao `pg_advisory_lock`) porque o lock cai
-- sozinho no fim da transacao — lock de sessao vazaria no pool de conexoes do
-- PostgREST e travaria a pessoa pra sempre.
--
-- ISSO INVERTE A ORDEM "envia primeiro, grava depois" que a v1 declarava. O
-- motivo da ordem antiga era nao deixar CONVERSA FANTASMA na caixa do time
-- (linha na lista, com previa, sem nada ter chegado ao cliente) — e ele continua
-- valendo. So que a resposta certa pra isso nao e gravar depois: e a coluna
-- `inicio_estado` abaixo. A reserva nasce 'reservado', vira 'enviado' quando o
-- provedor confirma e vira 'falha_envio' quando ele recusa. Estado VISIVEL nao e
-- fantasma: quem olha a conversa ve que a mensagem nao saiu, e por que.
alter table mensageria.conversas
  add column if not exists inicio_estado text;
alter table mensageria.conversas_apioficial
  add column if not exists inicio_estado text;

comment on column mensageria.conversas.inicio_estado is
  'Ciclo da conversa aberta PELO PAINEL: reservado (linha criada, envio em curso) | enviado (provedor confirmou) | falha_envio (provedor recusou; a conversa fica visivel dizendo que nao saiu). NULL = conversa que nao nasceu do botao de iniciar.';

-- POR QUE `p_tabela` DINAMICO: cada canal tem o proprio par de tabelas
-- (`lib/canais.ts`), e canal declarado por env (`CANAIS_EXTRA`) pode ter nome
-- proprio. Sem isso a funcao serviria so ao canal `central`. O nome e validado
-- contra o mesmo formato de id que `lib/canais.ts` aceita, e resolvido por
-- `to_regclass` antes de entrar no `format(%I)` — nunca concatenado cru.
--
-- POR QUE O TETO CONTA SO NA TABELA DO CANAL, e nao na soma de todas: a
-- alternativa exigiria varrer N tabelas dentro da mesma instrucao atomica, e o
-- unico canal com tabela separada nos built-ins e o OFICIAL, que recusa iniciar
-- conversa por desenho da Meta. Numa instalacao com varios canais Z-API/Evolution
-- por `CANAIS_EXTRA`, o teto passa a ser por canal — declarado no CLAUDE.md, nao
-- escondido.
create or replace function mensageria.reservar_inicio(
  p_tabela  text,
  p_canal   text,
  p_chat_id text,
  p_user_id uuid,
  p_user_nome text,
  p_nome    text,
  p_teto    int
) returns jsonb
language plpgsql
as $$
declare
  v_criadas int;
  v_existe  boolean;
begin
  if p_tabela is null or p_tabela !~ '^[a-z][a-z0-9_]{1,60}$' then
    return jsonb_build_object('estado', 'erro', 'motivo', 'tabela invalida');
  end if;
  if to_regclass('mensageria.' || quote_ident(p_tabela)) is null then
    return jsonb_build_object('estado', 'erro', 'motivo', 'canal sem tabela no banco');
  end if;
  if p_chat_id is null or p_chat_id = '' then
    return jsonb_build_object('estado', 'erro', 'motivo', 'chat_id vazio');
  end if;

  -- O LOCK, ANTES DE TUDO. Sem ele a instrucao abaixo NAO e atomica sob READ
  -- COMMITTED: 300 chamadas com numeros diferentes leem count=0 cada uma no seu
  -- snapshot e todas passam. Chave = a PESSOA, que e a granularidade do teto.
  perform pg_advisory_xact_lock(hashtext('mensageria.reservar_inicio:' || p_user_id::text));

  -- FAXINA DA RESERVA ORFA, e ela mora aqui porque aqui ja se tem o lock DA
  -- PESSOA — varrer linha de outra pessoa seria mexer fora do que este lock
  -- protege. Reserva orfa acontece quando o processo morre entre reservar e
  -- encerrar (lambda congelada, deploy no meio, timeout do provedor sem catch):
  -- a linha fica 'reservado' pra sempre, com a previa "enviando..." mentindo que
  -- ha um envio em curso. 10 minutos e folgado pra qualquer envio real.
  -- Nao devolve vaga do teto de proposito: a tentativa aconteceu.
  execute format($q$
    update mensageria.%I
       set inicio_estado = 'falha_envio',
           status = 'aberto',
           last_message_at = now(),
           last_message_preview = 'nao enviada: tempo esgotado',
           updated_at = now()
     where inicio_estado = 'reservado'
       and iniciada_por_id = %L::uuid
       and iniciada_em < now() - interval '10 minutes'
  $q$, p_tabela, p_user_id);

  -- A INSTRUCAO UNICA: conta e insere junto. `on conflict do nothing` cobre a
  -- corrida de duas pessoas abrindo o MESMO numero — a segunda nao grava, e o
  -- teste de existencia abaixo devolve 'ja_existe' pra ela.
  -- A previa "enviando..." entra JA NO INSERT: sem ela a conversa reservada nao
  -- aparece na lista (a ordenacao e por `last_message_at`) e o atendente nao ve
  -- nem o que esta em curso nem o que ficou orfao.
  execute format($q$
    with reserva as (
      insert into mensageria.%I
        (chat_id, nome, is_group, canal, status, created_at, updated_at,
         last_message_at, last_message_preview,
         iniciada_por_id, iniciada_por_nome, iniciada_em, inicio_estado)
      select %L, nullif(%L, ''), false, %L, 'atendimento', now(), now(),
             now(), 'enviando...',
             %L::uuid, %L, now(), 'reservado'
      where (
        select count(*) from mensageria.%I c
         where c.iniciada_por_id = %L::uuid
           and c.iniciada_em > now() - interval '1 hour'
      ) < %s
      on conflict (chat_id) do nothing
      returning 1
    )
    select count(*) from reserva
  $q$, p_tabela, p_chat_id, coalesce(p_nome, ''), p_canal, p_user_id, p_user_nome,
       p_tabela, p_user_id, greatest(coalesce(p_teto, 1), 1))
  into v_criadas;

  if v_criadas > 0 then
    return jsonb_build_object('estado', 'reservado');
  end if;

  -- nao gravou: ou a conversa ja existia, ou o teto barrou. Sao respostas
  -- MUITO diferentes pra quem esta na tela (409 "abra a conversa" x 429 "espere
  -- uma hora"), entao a funcao distingue em vez de devolver um "nao deu".
  execute format('select exists (select 1 from mensageria.%I where chat_id = %L)', p_tabela, p_chat_id)
    into v_existe;
  if v_existe then
    return jsonb_build_object('estado', 'ja_existe');
  end if;

  execute format($q$
    select count(*) from mensageria.%I c
     where c.iniciada_por_id = %L::uuid
       and c.iniciada_em > now() - interval '1 hour'
  $q$, p_tabela, p_user_id) into v_criadas;
  return jsonb_build_object('estado', 'teto', 'na_ultima_hora', v_criadas);
end;
$$;

-- Fecha o ciclo da reserva. Vale so pra linha que ESTA 'reservado': sem esse
-- filtro, uma chamada atrasada marcaria 'falha_envio' numa conversa que ja
-- estava viva havia semanas.
--
-- A FALHA TEM QUE SER VISIVEL DE VERDADE (achado da re-revisao): a v1 so gravava
-- a coluna, e a conversa aparecia na lista com previa VAZIA e status
-- "atendimento" — indistinguivel de conversa nova sem mensagem. Duas correcoes
-- que moram aqui, no banco, porque quem grava e quem sabe:
--
--   * `last_message_at` + `last_message_preview` recebem valor: e a previa que a
--     lista de conversas desenha, e "nao enviada: <motivo>" e o unico jeito de
--     quem olha a caixa entender o que aconteceu sem abrir a conversa. O motivo e
--     TEXTO FIXO CURTO passado pela rota — nunca a mensagem do provedor, que e
--     conteudo de terceiro e ja vazou pra tela em outro incidente deste repo.
--   * `status` vai pra 'aberto' na falha. A reserva nasce 'atendimento' (e o
--     estado certo pra conversa que a pessoa acabou de abrir), mas conversa
--     onde NADA saiu nao esta em atendimento. E ha um motivo mais duro: se o
--     cliente escrever meses depois, o webhook faz upsert numa conversa que
--     estaria em "atendimento" sem ninguem atendendo — contra o invariante do
--     banco e direto pra fila errada do time.
--
-- APAGAR A LINHA seria a alternativa "limpa", e foi RECUSADA: falha que
-- desaparece nao conta na cota da hora, e o teto viraria burlavel mandando pra
-- numeros invalidos de proposito.

-- O DROP e o preco de ter mudado a assinatura (`p_motivo` entrou depois). Em
-- Postgres a assinatura FAZ PARTE da identidade: `create or replace` com 4
-- argumentos nao substitui a versao de 3, ela SOBREVIVE como sobrecarga — e como
-- funcao nasce executavel por `public`, o revoke logo abaixo (que nomeia os 4
-- tipos) nao a alcanca. Sobraria uma versao antiga, chamavel por qualquer um,
-- num arquivo que se anuncia idempotente. Ou seja: sem este drop, a idempotencia
-- anunciada aqui mentiria em toda instalacao que rodou a versao anterior.
drop function if exists mensageria.encerrar_reserva_inicio(text, text, text);

create or replace function mensageria.encerrar_reserva_inicio(
  p_tabela  text,
  p_chat_id text,
  p_estado  text,
  p_motivo  text default null
) returns boolean
language plpgsql
as $$
declare
  v_n int;
  v_previa text;
begin
  if p_tabela is null or p_tabela !~ '^[a-z][a-z0-9_]{1,60}$' then return false; end if;
  if to_regclass('mensageria.' || quote_ident(p_tabela)) is null then return false; end if;
  if p_estado not in ('enviado', 'falha_envio') then return false; end if;

  if p_estado = 'falha_envio' then
    -- motivo LIMITADO no tamanho e sem quebra de linha: vai pra uma coluna de
    -- previa que a lista renderiza numa linha so
    v_previa := 'nao enviada: ' || left(regexp_replace(coalesce(nullif(btrim(p_motivo), ''), 'o provedor recusou'), '\s+', ' ', 'g'), 100);
    execute format(
      'update mensageria.%I
          set inicio_estado = %L,
              status = ''aberto'',
              last_message_at = now(),
              last_message_preview = %L,
              updated_at = now()
        where chat_id = %L and inicio_estado = ''reservado''',
      p_tabela, p_estado, v_previa, p_chat_id
    );
  else
    execute format(
      'update mensageria.%I set inicio_estado = %L, updated_at = now()
        where chat_id = %L and inicio_estado = ''reservado''',
      p_tabela, p_estado, p_chat_id
    );
  end if;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Evento de status GRAVADO NO BANCO — a duracao sem corrida
-- ---------------------------------------------------------------------------
-- SEGUNDO ACHADO DA REVISAO. A v1 lia o ultimo evento em JavaScript, calculava
-- `duracao_seg` e depois inseria. Duplo clique em "concluir" (ou dois
-- atendentes ao mesmo tempo) fazia as duas chamadas lerem o MESMO ultimo evento
-- e gravarem a MESMA duracao — a permanencia no status aparecia DOBRADA no
-- resumo, e o numero ia pra relatorio de tempo de atendimento com cara de real.
--
-- Aqui o `max(criada_em)` e lido DENTRO da instrucao que insere, entao o segundo
-- insert ja ve o primeiro e mede a partir dele (tipicamente 0s, que e a verdade:
-- foi um duplo clique).
--
-- O fallback `p_marco` e usado SO quando a conversa nao tem evento anterior
-- nenhum — ali o marco vem de `conversas.status_alterado_em` (coluna da 0006) ou
-- do `created_at`, e quem sabe disso e a rota. Sem nenhum dos dois, `duracao_seg`
-- fica NULL e a tela mostra "sem medicao" em vez de um numero inventado.
--
-- `p_origem` = 'robo' e usado pelo toggle de robo por conversa: a trilha e a
-- MESMA tabela (o defeito de "mudanca de estado sem autor" e identico), mas a
-- LINHA DO TEMPO de status e o "tempo em cada status" EXCLUEM esses eventos —
-- senao ligar/desligar o robo poluiria a medicao de permanencia. O filtro mora
-- em `lib/tela-conversa.ts` (`linhaDoTempoStatus`) e na leitura `tipo=robo`.
create or replace function mensageria.registrar_status_evento(
  p_canal    text,
  p_chat_id  text,
  p_status   text,
  p_anterior text,
  p_marco    timestamptz,
  p_por_id   uuid,
  p_por_nome text,
  p_origem   text,
  p_fluxo_slug text default null,
  p_fluxo_nome text default null
) returns uuid
language sql
as $$
  insert into mensageria.conversa_status_eventos
    (canal, chat_id, status, status_anterior, duracao_seg,
     por_id, por_nome, origem, fluxo_slug, fluxo_nome, criada_em)
  select
    p_canal, p_chat_id, p_status, p_anterior,
    -- o marco: ultimo evento DA TRILHA (lido aqui dentro, na mesma instrucao),
    -- senao o que a rota trouxe. `greatest(...,0)` porque `now()` do banco e o
    -- `p_marco` que veio da aplicacao podem divergir por milissegundos, e
    -- permanencia negativa na tela vira numero absurdo.
    case
      when coalesce(u.ultimo, p_marco) is null then null
      else greatest(0, floor(extract(epoch from (now() - coalesce(u.ultimo, p_marco))))::int)
    end,
    p_por_id, p_por_nome, p_origem, p_fluxo_slug, p_fluxo_nome, now()
  from (
    select max(e.criada_em) as ultimo
      from mensageria.conversa_status_eventos e
     where e.canal = p_canal
       and e.chat_id = p_chat_id
       -- eventos de robo nao sao marco de permanencia de STATUS: usar o ultimo
       -- clique no robo como marco mediria "tempo desde que mexeram no robo"
       and coalesce(e.origem, '') <> 'robo'
  ) u
  returning id;
$$;

-- ------------------------------------------------------------------- 7. RLS
-- RLS ligada como em TODAS as irmas (funis, papeis, conversa_contexto...): quem
-- le e escreve aqui e o service_role da rota, e o painel nunca fala com estas
-- tabelas pelo anon key. Sem policy nenhuma, ligar RLS fecha a porta pro anon e
-- nao muda nada pro service_role (que a ignora por definicao). Sao trilhas de
-- atendimento de cliente — nao podem sair pela anon key do bundle.
alter table mensageria.conversa_status_eventos      enable row level security;
alter table mensageria.conversa_responsavel_eventos enable row level security;

-- ---------------------------------------------------------------- 8. grants
grant select, insert on mensageria.conversa_status_eventos      to service_role;
grant select, insert on mensageria.conversa_responsavel_eventos to service_role;

-- REVOKE EXPLICITO — TERCEIRO ACHADO DA REVISAO, e o mais silencioso.
-- `grant select, insert` NAO tira nada: a 0001 aplicou
-- `alter default privileges in schema mensageria grant all on tables to
-- service_role`, entao TODA tabela nova nasce com update e delete. O comentario
-- "sem update/delete de proposito" era, ate aqui, so um comentario — a trilha
-- era editavel e apagavel pela mesma chave que a rota usa.
revoke update, delete on mensageria.conversa_status_eventos      from service_role;
revoke update, delete on mensageria.conversa_responsavel_eventos from service_role;

-- E A IRMA MAIS VELHA TEM O MESMO BURACO. `mensageria.conversa_funil_eventos`
-- (0009) foi criada com a mesma intencao de trilha e caiu na mesma armadilha do
-- default privilege. O revoke dela mora AQUI, e nao numa 0018, porque a
-- armadilha foi diagnosticada aqui e migration ja rodada nao se edita — deixar
-- pra depois seria deixar aberto. Se a 0009 nao rodou nesta instalacao, o
-- `if exists` evita derrubar a migration inteira por causa de uma tabela ausente.
do $$
begin
  if to_regclass('mensageria.conversa_funil_eventos') is not null then
    revoke update, delete on mensageria.conversa_funil_eventos from service_role;
  end if;
end;
$$;

grant execute on function mensageria.reservar_inicio(text, text, text, uuid, text, text, int) to service_role;
grant execute on function mensageria.encerrar_reserva_inicio(text, text, text, text) to service_role;
grant execute on function mensageria.registrar_status_evento(text, text, text, text, timestamptz, uuid, text, text, text, text) to service_role;

-- REVOKE EXECUTE DE `public` — padrao da 0013 (pos-pentest 13/08/2026), e o
-- motivo e que `grant execute ... to service_role` NAO tira nada: no Postgres
-- toda funcao nova nasce com EXECUTE pra `public`, e `anon`/`authenticated`
-- herdam de public. Sem estas linhas, `reservar_inicio` seria chamavel pela
-- ANON KEY que vai no bundle do navegador — ou seja, qualquer pessoa criaria
-- linha em `mensageria.conversas` sem passar por rota nenhuma.
revoke execute on function mensageria.reservar_inicio(text, text, text, uuid, text, text, int) from public, anon, authenticated;
revoke execute on function mensageria.encerrar_reserva_inicio(text, text, text, text) from public, anon, authenticated;
revoke execute on function mensageria.registrar_status_evento(text, text, text, text, timestamptz, uuid, text, text, text, text) from public, anon, authenticated;

-- E AS DUAS DA 0016 TEM O MESMO ESQUECIMENTO (segundo caso do mesmo padrao,
-- achado na re-revisao). `definir_contexto`/`limpar_contexto` ganharam grant pro
-- service_role e nunca o revoke — entao a anon key escreve na memoria da
-- conversa, que e o que as condicoes de fluxo leem pra decidir automacao. O
-- revoke mora AQUI porque a 0017 ainda NAO rodou em nenhuma instalacao e a 0016
-- pode ter rodado: migration ja aplicada nao se edita, e esperar uma 0018 seria
-- deixar aberto. `if exists` pra nao derrubar a migration onde a 0016 nao rodou.
do $$
begin
  if to_regprocedure('mensageria.definir_contexto(text, text, text, text, uuid, text)') is not null then
    revoke execute on function mensageria.definir_contexto(text, text, text, text, uuid, text) from public, anon, authenticated;
  end if;
  if to_regprocedure('mensageria.limpar_contexto(text, text, text, uuid, text)') is not null then
    revoke execute on function mensageria.limpar_contexto(text, text, text, uuid, text) from public, anon, authenticated;
  end if;
end;
$$;

-- O PostgREST so enxerga tabela, coluna e FUNCAO novas depois de recarregar o
-- schema. Sem isto a RPC responde PGRST202 ("function not found") e o painel
-- acusa "migration nao rodada" COM a migration rodada — diagnostico errado, e
-- caro de perseguir.
notify pgrst, 'reload schema';
