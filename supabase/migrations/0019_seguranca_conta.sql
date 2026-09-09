-- 0019 — Seguranca e conta (Frente Q, 31/08/2026)
--   card 86ak858x0  janela de acesso por usuario
--   card 86ak85917  dispositivos e sessoes
--   card 86ak85zm4  visibilidade por funil e por numero
--   card 86ak85899  token de identidade com escopo
--
-- COMO RODAR: SQL Editor do Supabase, na mao. O codigo do painel NUNCA cria
-- tabela nem coluna — regra da casa. Enquanto esta migration nao rodar, o
-- painel se comporta EXATAMENTE como hoje: ninguem tem janela de acesso,
-- ninguem tem restricao de funil/canal, nenhum dispositivo esta revogado e
-- nenhuma chave de API tem escopo. A deteccao e por erro 42P01/42703 do
-- PostgREST, re-testada a cada 60s — no minuto seguinte a migration rodar, tudo
-- passa a valer sem redeploy (lib/acesso.ts).
--
-- COMPATIBILIDADE: nenhuma linha existente muda de sentido. As tres tabelas
-- nascem VAZIAS (ausencia de linha = sem restricao) e as colunas novas de
-- `api_keys` nascem nulas/`{}` (= o comportamento de hoje). Atribuir janela,
-- restricao ou escopo e sempre um gesto explicito do admin.

-- ─────────────────────────────────────────────────── janela de acesso (86ak858x0)
--
-- Uma linha por pessoa COM janela. SEM linha (ou `ativo=false`) = entra sempre.
--
-- `dias` guarda o mapa "0".."6" (0=domingo) -> lista de ATE DOIS periodos, cada
-- periodo como par ["HH:MM","HH:MM"] ou {"de":"HH:MM","ate":"HH:MM"}. Dois
-- periodos porque o segundo existe pro intervalo de almoco (a ferramenta que
-- este painel substitui tem exatamente isso: d{dia}_p1_from/to e p2_from/to).
-- A hora vale no FUSO DA INSTALACAO (lib/fuso.ts: config `fuso` > env > fabrica),
-- nunca no fuso do navegador do atendente. `ate` e EXCLUSIVO, e periodo que
-- vira a meia-noite (22:00 -> 06:00) e aceito: a madrugada pertence a escala do
-- dia anterior.
--
-- Exemplo (seg a sex, 08:00-12:00 e 13:00-18:00):
--   {"1":[["08:00","12:00"],["13:00","18:00"]], ... ,"5":[[...]]}
--
-- Validacao e semantica: lib/janela-acesso.ts (arquivo PURO, provado por
-- `node scripts/prova-seguranca-conta.ts`). O jsonb aqui e livre de proposito —
-- lixo gravado a mao e DESCARTADO na leitura, nao derruba o login de ninguem.
--
-- DOIS CUIDADOS DE LOCKOUT, no SCHEMA e nao so no codigo (achado de revisao):
--
--   `ativo` nasce FALSE. Um `insert into acesso_janelas (user_id) values (...)`
--   escrito a mao — o jeito mais natural de "criar a linha e depois configurar"
--   — nascia com ativo=true e dias vazio, o que barra a pessoa 24 horas por dia.
--   Ligar a janela passa a ser sempre um ato explicito.
--
--   O CHECK garante que janela LIGADA tem grade. A rota de gravacao ja recusa
--   esse estado com a frase certa, mas SQL rodado a mao nao passa pela rota, e
--   quem paga o preco e uma pessoa que nao consegue mais entrar no painel.
create table if not exists mensageria.acesso_janelas (
  user_id uuid primary key,
  ativo boolean not null default false,
  dias jsonb not null default '{}'::jsonb,
  -- quem configurou (trilha; a convencao de autor da 0006 vale: id nulo com
  -- nome preenchido = automacao, ambos nulos = linha anterior a esta migration)
  definido_por_id uuid,
  definido_por_nome text,
  criado_em timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_acesso_janelas_grade check (not ativo or dias <> '{}'::jsonb)
);
-- idempotencia: numa base que ja tenha a tabela da versao anterior, alinhar o
-- default e adicionar o CHECK (o `add constraint` nao tem `if not exists`)
alter table mensageria.acesso_janelas alter column ativo set default false;

-- SANEAR ANTES DE VALIDAR (3a revisao). `add constraint` nao e declaracao: ele
-- VALIDA as linhas que ja estao la. Numa base onde o build anterior criou a
-- linha a mao (`ativo=true, dias='{}'`, que era o default de entao), o
-- constraint levantava check_violation, o handler abaixo so tratava
-- duplicate_object, e o script MORRIA aqui — antes do seed e dos gatilhos do
-- marcador, reabrindo justamente o fail-open que esta migration fecha.
--
-- Desativar e a semantica certa, nao um atalho pra passar: grade vazia com
-- janela ligada e lockout 24 horas por dia. A pessoa volta a entrar, e quem
-- quiser janela de verdade configura a grade pela tela (a rota recusa gravar
-- este estado).
update mensageria.acesso_janelas set ativo = false where ativo and dias = '{}'::jsonb;

do $$
begin
  alter table mensageria.acesso_janelas
    add constraint ck_acesso_janelas_grade check (not ativo or dias <> '{}'::jsonb);
exception
  when duplicate_object then null;
  -- sobrou linha invalida que o UPDATE acima nao previu: AVISA e segue, porque
  -- parar aqui deixaria a base sem seed e sem gatilho (pior que ficar sem o
  -- CHECK — a rota de gravacao ja recusa janela ligada sem grade).
  when check_violation then
    raise notice 'ck_acesso_janelas_grade NAO foi criado: ha linha com janela ligada e grade vazia em mensageria.acesso_janelas. Rode: update mensageria.acesso_janelas set ativo = false where ativo and dias = ''{}''::jsonb; e depois recrie o constraint.';
end $$;
alter table mensageria.acesso_janelas enable row level security;
grant all on mensageria.acesso_janelas to service_role;

-- ────────────────────────────────────────────── dispositivos e sessoes (86ak85917)
--
-- POR QUE E REGISTRO NOSSO, e nao "as sessoes do Supabase Auth" (VERIFY feito
-- em 31/08 na superficie inteira de `GoTrueAdminApi` do @supabase/auth-js
-- 2.112.3 instalado neste repo): a admin API expoe signOut, inviteUserByEmail,
-- generateLink, createUser, listUsers, getUserById, updateUserById, deleteUser
-- e mfa.listFactors — e NENHUM listador de sessoes. `signOut` ainda exige o JWT
-- do proprio usuario (que o admin nao tem) e, no default, e GLOBAL: revoga
-- TODOS os refresh tokens da pessoa em TODOS os apps do pool de login (Meeting
-- Hub etc.). Esse e o gotcha que a Frente G pagou na troca de senha. Logo:
-- **este painel nao chama signOut de terceiro**, e "de onde cada pessoa acessa"
-- e alimentado a cada request autenticado.
--
-- `impressao` = sha256(user_id + navegador + sistema + robo?) truncado em 32.
-- NAO e o user-agent cru de proposito: versao de Chrome muda toda semana e cada
-- atualizacao criaria um "dispositivo novo", enchendo a tela de linha morta.
--
-- LIMITE HONESTO (a tela precisa dizer isso com estas palavras): user-agent e
-- texto que o CLIENTE escolhe. Revogar um dispositivo faz ESTE painel recusar
-- quem chega com aquela assinatura — tranca de porta, nao criptografia. A
-- revogacao DURA continua sendo desativar a pessoa (perfis.ativo=false), que
-- bane no GoTrue e vale pro pool inteiro.
--
-- `ip_ultimo` guarda o IP REAL do cliente (primeiro de x-forwarded-for), nao o
-- do proxy: na ferramenta antiga a coluna de IP dos 41 dispositivos nasceu
-- inutil porque registrava 10.244.x.x, o endereco interno deles
-- (docs/mapa/03-usuarios-permissoes.md, secao 5).
create table if not exists mensageria.usuario_dispositivos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  impressao text not null,
  navegador text,
  sistema text,
  rotulo text,
  robo boolean not null default false,
  user_agent text,
  ip_ultimo text,
  primeiro_acesso_em timestamptz not null default now(),
  visto_em timestamptz not null default now(),
  revogado_em timestamptz,
  revogado_por_id uuid,
  revogado_por_nome text,
  constraint uq_usuario_dispositivos unique (user_id, impressao)
);
alter table mensageria.usuario_dispositivos enable row level security;
create index if not exists ix_dispositivos_user on mensageria.usuario_dispositivos (user_id);
-- a leitura mais quente e "quem esta revogado" (cache de 30s na porta)
create index if not exists ix_dispositivos_revogados
  on mensageria.usuario_dispositivos (user_id, impressao)
  where revogado_em is not null;
grant all on mensageria.usuario_dispositivos to service_role;

-- ─────────────────────────────── visibilidade por funil e por numero (86ak85zm4)
--
-- O QUE JA EXISTIA (e por que nao bastava): a visibilidade tinha o ESCOPO de
-- visao (proprias/departamento/todas — fala de RESPONSAVEL) e a ACL por
-- conversa (`conversa_visibilidade` — trava dura, cadastrada uma conversa por
-- vez). As duas sao GLOBAIS quanto a funil e a numero: nao havia como dizer "o
-- comercial ve o funil de vendas e o numero da loja, e mais nada" sem
-- cadastrar a ACL de cada conversa, pra sempre.
--
-- Lista VAZIA = dimensao SEM restricao. SEM linha = comportamento de hoje.
-- `sem_funil` decide se, para quem esta restrito a funis, a conversa que nao
-- esta em NENHUM funil aparece. Default false = fail-closed, e a escolha e
-- explicita porque decide se a pessoa ve a maior parte da caixa (conversa nao
-- entra em funil sozinha).
--
-- FAIL-CLOSED tambem no que nao da pra avaliar: restricao presente e alvo
-- (canal/funil da conversa) que o chamador nao conseguiu trazer = NEGA.
-- Regra pura em lib/visibilidade.ts (`restricaoPermite`).
create table if not exists mensageria.usuario_restricoes (
  user_id uuid primary key,
  -- ids de canal (lib/canais.ts): 'central', 'apioficial', ...
  canais jsonb not null default '[]'::jsonb,
  -- ids de mensageria.funis
  funis jsonb not null default '[]'::jsonb,
  sem_funil boolean not null default false,
  definido_por_id uuid,
  definido_por_nome text,
  criado_em timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table mensageria.usuario_restricoes enable row level security;
grant all on mensageria.usuario_restricoes to service_role;

-- ─────────────────────────────── token de identidade com escopo (86ak85899)
--
-- O QUE JA EXISTIA (F11, 0005): `api_keys` com user_id, nome, key_hash sha256,
-- ativo e ultimo_uso_em. A chave vira a IDENTIDADE do dono e todas as
-- permissoes dele valem — o que e certo e nao muda.
--
-- O QUE FALTAVA: a chave nao conseguia valer MENOS que o dono. Sem escopo, sem
-- prazo, sem tipo, e a revogacao sem trilha de quem revogou. Chave vazada valia
-- tudo o que o dono vale, pra sempre.
--
-- `escopo` (jsonb) e saneado por lib/escopo-chave.ts:
--   { somente_leitura: bool, canais: [id], recursos: [nome], ignorar_janela: bool }
-- `{}` = chave sem escopo = comportamento de hoje (o estado de TODA chave que
-- ja existe em producao). Escopo so RESTRINGE, nunca concede.
-- `ignorar_janela` e a UNICA dimensao que afrouxa (a chave trabalha fora da
-- janela de acesso do dono) e por isso e privativa do super admin — o
-- autoatendimento de /api/minha-chave zera esse campo.
alter table mensageria.api_keys add column if not exists escopo jsonb not null default '{}'::jsonb;
-- tipo/rotulo sao ROTULO, nao autorizacao: servem pra tela agrupar ("mcp",
-- "integracao", "leitura", "automacao"), e texto livre e aceito.
alter table mensageria.api_keys add column if not exists tipo text;
alter table mensageria.api_keys add column if not exists rotulo text;
-- prazo. NULL = sem prazo (o estado de hoje). Data ilegivel e tratada como
-- VENCIDA na leitura — prazo que ninguem consegue ler nao vira chave eterna.
alter table mensageria.api_keys add column if not exists expira_em timestamptz;
-- trilha da revogacao. `ativo=false` continua sendo o que desliga a chave; estas
-- colunas dizem QUANDO e POR QUEM (mesma licao da 0006: quem mudou o estado).
alter table mensageria.api_keys add column if not exists revogado_em timestamptz;
alter table mensageria.api_keys add column if not exists revogado_por_id uuid;
alter table mensageria.api_keys add column if not exists revogado_por_nome text;
-- trilha do ultimo uso. `ultimo_uso_em` ja existia; sem o IP e o cliente nao da
-- pra responder "de onde essa chave esta sendo usada?", que e a pergunta que se
-- faz quando ha suspeita de vazamento.
alter table mensageria.api_keys add column if not exists ultimo_uso_ip text;
alter table mensageria.api_keys add column if not exists ultimo_uso_ua text;

create index if not exists ix_api_keys_expira on mensageria.api_keys (expira_em) where expira_em is not null;

-- ══════════════════════════════════════════════════════════════════════════
-- O MARCADOR `politica_acesso_ativa` — SEMEADURA E GATILHO
--
-- A porta (lib/auth-server.ts) so consulta as tres tabelas acima quando
-- `mensageria.config.politica_acesso_ativa` e `true`. Isso existe pra "migration
-- nao rodou" e "banco fora num cold start" nao virarem apagao do painel (403 pra
-- todo mundo) — ver lib/config.ts.
--
-- O BURACO QUE ISTO FECHA (medido na 2a revisao desta frente): o marcador era
-- ligado SO pelas rotas de gravacao. Regra criada por SQL nao passa por rota — e
-- neste momento do projeto ISSO E A REGRA, nao a excecao: as telas de admin
-- ainda nao existem, entao a primeira janela e a primeira restricao de qualquer
-- instalacao nascem no SQL Editor, na mao. Sem semeadura e sem gatilho, o admin
-- gravava a janela, ela nao pegava, e nada no sistema explicava por que.
--
-- Duas camadas, as duas necessarias:
--   (a) SEED, aqui: se JA existe regra gravada nesta base (inclusive de um build
--       anterior desta branch), o marcador nasce ligado.
--   (b) GATILHO: qualquer insert/update futuro liga o marcador, venha de rota,
--       do SQL Editor ou de script. Fecha o caminho SQL pra sempre.
--
-- Nenhuma das duas LIGA regra nenhuma: elas so contam a verdade sobre o que ja
-- esta gravado. Instalacao sem regra continua com o marcador `false`.

insert into mensageria.config (chave, valor)
select 'politica_acesso_ativa', 'true'::jsonb
where exists (select 1 from mensageria.acesso_janelas where ativo)
   or exists (select 1 from mensageria.usuario_restricoes)
   or exists (select 1 from mensageria.usuario_dispositivos where revogado_em is not null)
on conflict (chave) do update set valor = 'true'::jsonb;

-- SECURITY INVOKER (o default, explicito aqui) e nao DEFINER: o corpo e
-- constante — um upsert de UMA chave fixa em mensageria.config — e quem grava
-- nas 3 tabelas e o service_role, que ja escreve em config. DEFINER nao
-- compraria nada e deixaria uma funcao com privilegio de dono pendurada em
-- tabela que a aplicacao escreve. `search_path` fica fixo de todo jeito (boa
-- pratica de funcao em trigger, INVOKER inclusive).
create or replace function mensageria.ligar_politica_acesso()
returns trigger
language plpgsql
security invoker
set search_path = mensageria, public
as $$
begin
  insert into mensageria.config (chave, valor)
  values ('politica_acesso_ativa', 'true'::jsonb)
  on conflict (chave) do update set valor = 'true'::jsonb;
  return null; -- AFTER trigger: o valor de retorno e ignorado
end;
$$;

-- Os WHEN espelham as condicoes do SEED acima: linha de janela DESLIGADA e linha
-- de dispositivo NAO revogada sao inertes, e ligar o marcador por causa delas so
-- faria a porta consultar tabela sem necessidade.
drop trigger if exists tg_politica_janela on mensageria.acesso_janelas;
create trigger tg_politica_janela
  after insert or update on mensageria.acesso_janelas
  for each row when (new.ativo)
  execute function mensageria.ligar_politica_acesso();

drop trigger if exists tg_politica_restricao on mensageria.usuario_restricoes;
create trigger tg_politica_restricao
  after insert or update on mensageria.usuario_restricoes
  for each row
  execute function mensageria.ligar_politica_acesso();

-- DOIS gatilhos, um por evento, e nao um `after insert or update` com um WHEN
-- so (3a revisao). Motivo medido: `conferirDispositivo` faz upsert de trilha a
-- cada 2min por dispositivo, e num super admin (que a politica nunca barra) com
-- dispositivo revogado a linha segue com `revogado_em` preenchido — o WHEN
-- unico dava true a cada 2min e reescrevia config pra sempre. O que interessa e
-- a TRANSICAO pra revogado.
--
-- Por que separado: o WHEN de um gatilho que cobre INSERT nao pode referenciar
-- OLD (e `tg_op` nao existe em expressao SQL, so dentro do plpgsql). Com um
-- evento por gatilho, cada WHEN referencia o que existe naquele evento.
--
-- Janela e restricao seguem com gatilho unico de proposito: elas so sao escritas
-- por acao de admin, nao por trilha automatica.
drop trigger if exists tg_politica_dispositivo on mensageria.usuario_dispositivos;
create trigger tg_politica_dispositivo
  after insert on mensageria.usuario_dispositivos
  for each row when (new.revogado_em is not null)
  execute function mensageria.ligar_politica_acesso();

drop trigger if exists tg_politica_dispositivo_upd on mensageria.usuario_dispositivos;
create trigger tg_politica_dispositivo_upd
  after update on mensageria.usuario_dispositivos
  for each row when (new.revogado_em is not null and old.revogado_em is null)
  execute function mensageria.ligar_politica_acesso();

notify pgrst, 'reload schema';
