-- 0012_disparo.sql
-- Frente H (31/08/2026): modulo `disparo` — disparo em massa por campanha.
--
-- Tres tabelas:
--   mensageria.campanhas         = a campanha (mensagem, canal, estado, ritmo)
--   mensageria.campanha_destinos = 1 linha por destinatario, com o desfecho dele
--   mensageria.campanha_listas   = publico salvo e reutilizavel (jsonb)
--
-- ATENCAO: este arquivo NAO e executado por codigo nenhum. Rodar a migration e
-- gesto humano no SQL Editor do Supabase da instalacao (mesma convencao da 0007
-- e da 0008). Idempotente: pode rodar de novo sem estragar nada.
--
-- Gotcha do repo (CLAUDE.md): tabela nova no schema `mensageria` costuma nascer
-- SEM grant e a rota devolve 500 (permission denied do service_role). O
-- `alter default privileges` de 0001 cobre tabelas futuras, mas o grant
-- explicito abaixo garante o caso de a migration rodar com outro dono.
--
-- REGRA DE PRODUTO GRAVADA NO BANCO: campanha importada (`historico = true`)
-- NUNCA dispara. Nao e so disciplina de codigo — o CHECK abaixo impede que uma
-- campanha historica saia de 'concluida'/'cancelada', entao nem um UPDATE
-- manual no SQL Editor consegue coloca-la em 'rodando'.

-- ------------------------------------------------------------- campanhas
create table if not exists mensageria.campanhas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  -- canal do registro (lib/canais.ts) por onde a campanha sai. A mensagem sai
  -- pelo NUMERO DESSE canal — nunca cai no central por fallback (P1, 30/08).
  canal text not null default 'central',
  -- corpo da mensagem; aceita variaveis {{nome}} e as colunas extras do CSV
  mensagem text not null default '',
  -- rascunho | agendada | rodando | pausada | concluida | cancelada
  estado text not null default 'rascunho',
  agendada_para timestamptz,

  -- ---- ritmo (config POR CAMPANHA: cada publico pede um ritmo diferente)
  -- quantos destinos o tick processa por chamada
  lote int not null default 40,
  -- espera minima entre dois envios da MESMA campanha
  intervalo_s int not null default 5,
  -- teto diario de envios pelo canal (o "chip"), somando TODAS as campanhas
  teto_por_numero_dia int not null default 300,

  -- ---- registro historico (importado de outra ferramenta)
  -- true = a campanha existe so como DADO. Nao dispara em nenhuma condicao.
  historico boolean not null default false,
  -- campanha historica nao tem linha em campanha_destinos (o backup traz o
  -- numero somado, nao a lista): este campo guarda o total declarado na origem
  destinatarios_total int,
  -- progresso como veio da origem ("100%"), so pra campanha historica
  progresso_origem text,

  -- ---- rastreabilidade de importacao (espelho do padrao de mensageria.fluxos)
  origem_ferramenta text,
  origem_id text,
  -- id do fluxo/dialogo na ferramenta de origem: casa com fluxos.origem_id e e
  -- o que torna a ligacao campanha -> fluxo navegavel sem FK entre importacoes
  origem_fluxo_id text,
  origem_fluxo_nome text,

  -- ---- autoria
  criado_por_id uuid,
  criado_por_nome text,
  -- QUEM tirou a campanha do rascunho. Disparo em massa exige aprovacao humana
  -- explicita por campanha (regra de produto, docs/disparo.md).
  ativada_por_id uuid,
  ativada_por_nome text,
  ativada_em timestamptz,

  erro text,
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now(),
  iniciada_em timestamptz,
  concluida_em timestamptz,

  -- LOCK do tick por campanha: dois ticks simultaneos nao processam a MESMA
  -- campanha. O claim por destino ja impede envio duplicado; este lock impede o
  -- desperdicio de dois ticks disputando a mesma fila e, principalmente, que os
  -- dois decidam ritmo sobre a mesma leitura. Reserva expira sozinha
  -- (LIMITE_LOCK_MS) pra tick morto nao travar a campanha pra sempre.
  tick_lock_em timestamptz,

  constraint campanhas_estado_valido check (
    estado in ('rascunho','agendada','rodando','pausada','concluida','cancelada')
  ),
  -- trava dura: registro historico so pode existir em estado terminal
  constraint campanhas_historico_nunca_dispara check (
    historico = false or estado in ('concluida','cancelada')
  ),
  constraint campanhas_lote_sano check (lote between 1 and 200),
  constraint campanhas_intervalo_sano check (intervalo_s between 0 and 3600),
  constraint campanhas_teto_sano check (teto_por_numero_dia between 1 and 100000)
);

alter table mensageria.campanhas enable row level security;

create index if not exists idx_campanhas_estado on mensageria.campanhas (estado, agendada_para);
create index if not exists idx_campanhas_canal on mensageria.campanhas (canal, criada_em desc);
create index if not exists idx_campanhas_origem on mensageria.campanhas (origem_ferramenta, origem_id);
-- Idempotencia da importacao: a mesma campanha da mesma ferramenta entra 1x so.
--
-- INDICE TOTAL, SEM `where` — de proposito, e isto ja custou incidente neste
-- repo (CLAUDE.md, secao do importador): **o PostgREST recusa `on_conflict` em
-- indice PARCIAL com erro 42P10**. A primeira versao desta migration tinha
-- `where origem_ferramenta is not null and origem_id is not null`, o que faria o
-- upsert do importador (`on_conflict=origem_ferramenta,origem_id`) estourar
-- 42P10 no primeiro lote REAL — e passar batido no --dry, que nao toca banco.
--
-- Sem o `where` nao se perde nada: no Postgres NULL nao colide com NULL em
-- indice unico (NULLS DISTINCT e o default), entao campanha criada na tela — que
-- tem os dois campos NULL — continua entrando quantas vezes for.
-- O `drop` antes do `create` NAO e zelo: `create index if not exists` casa por
-- NOME, entao numa instalacao que ja rodou a versao antiga desta migration o
-- indice PARCIAL continuaria de pe e o create passaria em silencio — o 42P10
-- voltaria exatamente onde a correcao devia ter chegado. Recriar e barato
-- (indice de idempotencia de importacao, nao indice de leitura quente).
drop index if exists mensageria.uq_campanhas_origem;
create unique index if not exists uq_campanhas_origem
  on mensageria.campanhas (origem_ferramenta, origem_id);

-- ----------------------------------------------------- campanha_destinos
create table if not exists mensageria.campanha_destinos (
  id uuid primary key default gen_random_uuid(),
  campanha_id uuid not null references mensageria.campanhas (id) on delete cascade,
  -- chave de roteamento no painel (telefone so-digitos ou "<id>-group"), igual
  -- ao chat_id das tabelas de conversa
  chat_id text not null,
  -- telefone como veio da origem (util pro relatorio de falha ficar legivel)
  telefone text,
  nome text,
  -- colunas extras do CSV viram variaveis da mensagem
  variaveis jsonb,
  -- pendente | enviando | enviado | falhou | respondeu | optout
  --
  -- `enviando` e a RESERVA (claim): o tick move pendente -> enviando com um
  -- UPDATE condicional e so envia o que o update devolveu. Sem esse estado
  -- intermediario, dois ticks simultaneos leem a mesma fila e mandam a mesma
  -- mensagem duas vezes — e ainda decidem lote/intervalo/teto sobre leitura
  -- velha. Ver lib/disparo/lote.ts.
  estado text not null default 'pendente',
  -- quando a reserva foi feita; reserva parada volta pra fila (LIMITE_RESERVA_MS)
  reservado_em timestamptz,
  -- quantas vezes ja foi tentado. Falha transitoria volta pra fila ate o teto;
  -- depois vira `falhou` definitivo com motivo.
  tentativas int not null default 0,
  enviado_em timestamptz,
  respondeu_em timestamptz,
  provider_msg_id text,
  erro text,
  criada_em timestamptz not null default now(),

  constraint destinos_estado_valido check (
    estado in ('pendente','enviando','enviado','falhou','respondeu','optout')
  )
);

-- instalacao que ja rodou a 0012 antiga: acrescenta as colunas e afrouxa o CHECK
alter table mensageria.campanha_destinos add column if not exists reservado_em timestamptz;
alter table mensageria.campanha_destinos add column if not exists tentativas int not null default 0;
do $$
begin
  alter table mensageria.campanha_destinos drop constraint if exists destinos_estado_valido;
  alter table mensageria.campanha_destinos add constraint destinos_estado_valido check (
    estado in ('pendente','enviando','enviado','falhou','respondeu','optout')
  );
end $$;

alter table mensageria.campanha_destinos enable row level security;

-- nao repetir: o mesmo destino entra UMA vez por campanha (criterio 6 do card
-- 86ak85jek). E tambem o que faz o upsert do publico ser idempotente.
create unique index if not exists uq_campanha_destino
  on mensageria.campanha_destinos (campanha_id, chat_id);
-- fila do tick: proximos pendentes desta campanha
create index if not exists idx_destinos_fila
  on mensageria.campanha_destinos (campanha_id, estado, criada_em);
-- varredura de reserva orfa (tick que morreu no meio do lote)
create index if not exists idx_destinos_reserva
  on mensageria.campanha_destinos (estado, reservado_em)
  where estado = 'enviando';
-- teto diario por canal e deteccao de resposta varrem por janela de tempo
create index if not exists idx_destinos_enviado_em
  on mensageria.campanha_destinos (enviado_em desc)
  where enviado_em is not null;

-- ------------------------------------------------------- campanha_listas
-- Publico salvo: qualquer selecao pode virar lista nomeada e reutilizavel.
-- Os itens ficam em jsonb ([{chat_id, telefone, nome, variaveis}]) de proposito:
-- lista salva e uma FOTOGRAFIA do publico, nao uma tabela viva de contatos.
create table if not exists mensageria.campanha_listas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  descricao text,
  itens jsonb not null default '[]'::jsonb,
  total int not null default 0,
  criado_por_id uuid,
  criado_por_nome text,
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);

alter table mensageria.campanha_listas enable row level security;

create unique index if not exists uq_campanha_listas_nome on mensageria.campanha_listas (lower(nome));
create index if not exists idx_campanha_listas_data on mensageria.campanha_listas (criada_em desc);

-- instalacao que ja rodou a 0012 antiga
alter table mensageria.campanhas add column if not exists tick_lock_em timestamptz;

-- ---------------------------------------------------- campanha_bloqueios
-- LISTA DE BLOQUEIO (opt-out). Quem pediu pra sair NAO recebe disparo, e isso
-- vale em DOIS pontos independentes (fail-closed): na montagem do publico e
-- de novo no envio, imediatamente antes de mandar. Dois pontos porque o publico
-- pode ter sido montado dias antes do disparo — alguem que pediu pra sair no
-- meio nao pode receber so porque ja estava na lista.
--
-- A CHAVE e `chave` (ultimos digitos do telefone, mesma `chaveDedupe` do
-- publico): a mesma pessoa aparece com e sem DDI, com e sem o nono digito.
-- Bloquear pelo numero inteiro deixaria a pessoa voltar a receber pela variante.
create table if not exists mensageria.campanha_bloqueios (
  chave text primary key,
  -- o telefone como veio, so pra tela mostrar algo legivel
  telefone text,
  -- 'manual' (alguem cadastrou) | 'resposta' (o proprio destino pediu pra sair)
  origem text not null default 'manual',
  -- quando origem='resposta', a palavra que disparou o descadastro
  motivo text,
  criado_por_id uuid,
  criado_por_nome text,
  criado_em timestamptz not null default now()
);

alter table mensageria.campanha_bloqueios enable row level security;

create index if not exists idx_bloqueios_data on mensageria.campanha_bloqueios (criado_em desc);

-- ---------------------------------------------------------------- grants
-- RLS ligado com ZERO policy + grant so pro service_role = anon e usuario
-- logado levam 42501 no PostgREST direto (mesmo modelo das outras tabelas).
grant all on mensageria.campanhas to service_role;
grant all on mensageria.campanha_destinos to service_role;
grant all on mensageria.campanha_listas to service_role;
grant all on mensageria.campanha_bloqueios to service_role;

-- Depois de rodar, se a rota reclamar de tabela desconhecida:
--   notify pgrst, 'reload schema';
