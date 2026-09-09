-- 0018_fluxo_fila.sql
-- P3 / Frente P (31/08/2026): EXECUCAO ADIADA do motor de automacao.
-- Cards 86ak859wr (fila, atraso, fim de semana, limites) e 86ak859xn (aprovacao
-- humana). O card 86ak85zn1 (trilha por mensagem) entra aqui como duas colunas
-- novas em `fluxo_execucoes`, no fim do arquivo.
--
-- ATENCAO: este arquivo NAO e executado por codigo nenhum. Rodar a migration e
-- gesto humano no SQL Editor do Supabase da instalacao (mesma convencao da 0008).
-- Idempotente: pode rodar de novo sem estragar nada.
--
-- Numero: a 0017 esta RESERVADA pra outra frente da mesma onda. Sem colisao.
--
-- O QUE ESTA TABELA E, EM UMA LINHA: uma linha = uma CADEIA em andamento, que
-- ANDA (o `no_id` avanca) em vez de virar N linhas.
--
-- Por que uma linha que anda, e nao uma linha por passo:
--   1. CANCELAR e um UPDATE so. Com N linhas, cancelar seria "apagar as futuras",
--      e futuro que ainda nao foi criado nao da pra apagar.
--   2. O CLAIM ATOMICO de uma linha unica ja serializa a cadeia: nao existe passo
--      2 disponivel enquanto o passo 1 nao terminou, porque e a MESMA linha.
--   3. Espera nao ocupa fila. O no de `espera` do fluxo canonico nunca e
--      EXECUTADO — ele e consumido no agendamento e vira `disponivel_em` no
--      futuro (ver lib/fluxo/fila.ts `proximoPasso`). Espera de 5 dias e uma
--      linha dormindo, nao um processo preso.
--
-- A TRILHA de quem rodou continua em `fluxo_execucoes` (0008), agrupada por
-- `execucao_id` — o mesmo `execucao_id` da linha da fila. Fila = o que VAI
-- acontecer; fluxo_execucoes = o que ACONTECEU. Nao juntar as duas: apagar a fila
-- depois de concluir nao pode apagar o historico do que saiu pro cliente.

-- ---------------------------------------------------------------- fluxo_fila
create table if not exists mensageria.fluxo_fila (
  id uuid primary key default gen_random_uuid(),

  -- agrupa a cadeia na trilha (fluxo_execucoes.execucao_id)
  execucao_id uuid not null,

  -- referencia SOLTA (sem FK), igual a trilha: fluxo apagado nao apaga a fila —
  -- o tick descobre a ausencia e encerra a cadeia com o motivo escrito, que e
  -- melhor que a linha sumir sem ninguem saber que a regua parou
  fluxo_id uuid,
  fluxo_slug text not null,

  -- a conversa, no par (canal, chat_id) — mesma chave de conversa_responsaveis e
  -- conversa_funil: funciona em QUALQUER canal sem ALTER por tabela de canal
  canal text not null,
  chat_id text not null,

  -- o PROXIMO no a executar (id dentro do jsonb do fluxo)
  no_id text not null,

  -- agendado | aguardando_aprovacao | executando | concluido | falhou |
  -- cancelado | recusado  (espelho de ESTADOS_FILA em lib/fluxo/fila.ts)
  estado text not null default 'agendado',

  -- quando este passo pode rodar. E o RELOGIO da fila: o atraso do fluxo e o
  -- "pular fim de semana" ja estao resolvidos aqui, no fuso da INSTALACAO.
  disponivel_em timestamptz not null default now(),

  -- quem mandou rodar: "manual" (atendente) conta como GENTE nas regras de
  -- status; "gatilho" (automacao) conta como ROBO e obedece auto_atendimento_bot.
  -- Vai direto pro `origem` do ContextoExecucao (lib/fluxo/executar.ts).
  --
  -- DEFAULT 'manual' pra CASAR com o codigo: `ContextoExecucao.origem` tem default
  -- "manual" e a rota de enfileirar sempre grava "manual" explicitamente. Um
  -- default 'gatilho' aqui divergiria do TypeScript e faria um INSERT feito por
  -- fora (SQL direto, script) nascer contando como ROBO — o lado que obedece
  -- `auto_atendimento_bot` e mexe em status sozinho. Default tem que ser o caso
  -- MENOS surpreendente, e quem escreve por fora e gente.
  origem text not null default 'manual',

  -- o usuario em nome de quem a cadeia age (JA autorizado por quem enfileirou).
  -- Pode ser null quando a origem e automacao pura (convencao da 0006:
  -- id NULL + nome preenchido = automacao).
  usuario_id uuid,
  usuario_nome text,

  -- tentativas do passo ATUAL (falha transitoria volta pra fila com recuo)
  tentativas integer not null default 0,

  -- carimbo do claim: `agendado -> executando`. Reserva orfa (tick que morreu no
  -- meio) volta pra fila depois de 5 min.
  reservado_em timestamptz,

  -- ultimo ERRO visto (pra tela dizer por que falhou). SO erro de verdade.
  erro text,

  -- AVISO OPERACIONAL: por que a cadeia esta parada SEM ter dado erro — hoje, o
  -- motivo da parada pra aprovacao ("passo exige aprovacao humana", "o passo foi
  -- editado depois da aprovacao").
  --
  -- Coluna PROPRIA porque escrever isso em `erro` fazia duas coisas erradas de uma
  -- vez: a tela pintava de VERMELHO uma espera normal do fluxo (parada esperando
  -- aval nao e defeito), e o texto SOBRESCREVIA a ultima falha real — apagando
  -- justamente a informacao que alguem procuraria pra entender o que aconteceu
  -- antes. Separados, a tela mostra os dois com o peso certo.
  aviso text,

  -- APROVACAO HUMANA. A decisao e POR PASSO, nunca pela cadeia: sem
  -- `aprovacao_no_id`, um "aprovar" no passo 2 liberaria em silencio o passo 5,
  -- que tambem pedia aval.
  aprovacao_no_id text,
  -- aprovado | recusado
  aprovacao_decisao text,
  -- IMPRESSAO DIGITAL DO CONTEUDO do no no momento da decisao
  -- (lib/fluxo/fila.ts, `assinaturaDoNo`). Sem ela a aprovacao carimbaria so o
  -- ENDERECO do passo: aprovo "mando o orcamento de R$ 5.000", edito o texto do
  -- passo, e o que sai pro cliente e outra coisa com aval de ninguem. Divergiu na
  -- hora de executar = volta pra aguardando_aprovacao, com o motivo na trilha.
  aprovacao_assinatura text,
  aprovado_por_id uuid,
  aprovado_por_nome text,
  aprovado_em timestamptz,
  -- POR ONDE a decisao entrou: "sessao" (pessoa logada no painel). Aprovacao NAO
  -- aceita chave de API (x-api-key) — o gate esta na rota — e a coluna existe pra
  -- a trilha de auditoria poder PROVAR isso depois, em vez de depender de a gente
  -- lembrar que a regra existia. Se um dia outra via for permitida, ela aparece
  -- aqui e as decisoes antigas continuam legiveis.
  aprovado_via text,

  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);

alter table mensageria.fluxo_fila enable row level security;

-- ------------------------------- COLUNAS QUE NASCERAM DEPOIS (idempotencia real)
--
-- `create table if not exists` NAO ALTERA tabela que ja existe: numa instalacao que
-- rodou a versao ANTERIOR deste arquivo, a tabela esta la e as colunas de baixo
-- simplesmente nao apareceriam — e o `add constraint fluxo_fila_via_valida` logo
-- abaixo abortaria a migration inteira com "column aprovado_via does not exist".
-- Pior: em runtime a fila PARARIA EM SILENCIO, porque o select da fiacao pede essas
-- colunas, leva PGRST204 e `candidatos` devolve lista vazia — fila sem nada pra
-- fazer e fila quebrada tem a mesma cara na tela.
--
-- Regra da casa, entao: coluna nova SEMPRE tambem como `add column if not exists`,
-- e `alter column ... set default` pra default que mudou. Rodar duas vezes nao
-- estraga nada, e a base nova e a base antiga terminam IGUAIS.
alter table mensageria.fluxo_fila
  add column if not exists aprovacao_assinatura text;

alter table mensageria.fluxo_fila
  add column if not exists aprovado_via text;

alter table mensageria.fluxo_fila
  add column if not exists aviso text;

-- o default de `origem` mudou de 'gatilho' pra 'manual' (ver o comentario da coluna):
-- em base que ja existia, so este ALTER faz a mudanca valer.
alter table mensageria.fluxo_fila
  alter column origem set default 'manual';

-- ------------------------------------------------------------- constraints
-- Estado e origem escritos NO BANCO, no mesmo espirito do CHECK
-- `campanhas_historico_nunca_dispara` da 0012: a regra que nao pode ser burlada
-- nem por UPDATE manual mora aqui, nao so no TypeScript.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'fluxo_fila_estado_valido'
  ) then
    alter table mensageria.fluxo_fila
      add constraint fluxo_fila_estado_valido check (
        estado in ('agendado','aguardando_aprovacao','executando','concluido','falhou','cancelado','recusado')
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'fluxo_fila_origem_valida'
  ) then
    alter table mensageria.fluxo_fila
      add constraint fluxo_fila_origem_valida check (origem in ('manual','gatilho'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'fluxo_fila_decisao_valida'
  ) then
    alter table mensageria.fluxo_fila
      add constraint fluxo_fila_decisao_valida check (
        aprovacao_decisao is null or aprovacao_decisao in ('aprovado','recusado')
      );
  end if;

  -- A VIA da aprovacao e fechada NO BANCO: hoje so 'sessao'. Se alguem afrouxar o
  -- gate da rota por engano (ou um script escrever direto), o INSERT quebra em vez
  -- de gravar em silencio uma aprovacao vinda de robo.
  if not exists (
    select 1 from pg_constraint where conname = 'fluxo_fila_via_valida'
  ) then
    alter table mensageria.fluxo_fila
      add constraint fluxo_fila_via_valida check (
        aprovado_via is null or aprovado_via in ('sessao')
      );
  end if;
end $$;

-- ----------------------------------------------------------------- indices
-- o tick: pega o que ja pode rodar, na ordem certa
create index if not exists idx_fluxo_fila_tick
  on mensageria.fluxo_fila (estado, disponivel_em)
  where estado = 'agendado';

-- a tela da conversa (card 86ak85zn1) e o "o que esta agendado pra este chat"
create index if not exists idx_fluxo_fila_conversa
  on mensageria.fluxo_fila (canal, chat_id, criada_em desc);

-- os LIMITES por conversa (maximo_por_conversa / intervalo_minimo_segundos)
create index if not exists idx_fluxo_fila_limites
  on mensageria.fluxo_fila (fluxo_slug, canal, chat_id, criada_em desc);

-- a fila de aprovacao (tela minima do card 86ak859xn)
create index if not exists idx_fluxo_fila_aprovacao
  on mensageria.fluxo_fila (disponivel_em)
  where estado = 'aguardando_aprovacao';

-- A REGRA "UMA CADEIA VIVA POR FLUXO POR CONVERSA", NO BANCO.
--
-- Sem ela, dois cliques (ou dois gatilhos no mesmo segundo) enfileiram a MESMA
-- regua duas vezes e o cliente recebe tudo em dobro. A checagem em codigo existe
-- e da a mensagem bonita, mas ela e read-then-write: entre a leitura e o insert
-- cabe outra requisicao. O indice unico parcial fecha a janela — a segunda
-- tentativa leva 23505 e o codigo traduz pra "ja esta em andamento".
create unique index if not exists uq_fluxo_fila_viva
  on mensageria.fluxo_fila (fluxo_slug, canal, chat_id)
  where estado in ('agendado','aguardando_aprovacao','executando');

-- ------------------------------------------------------- DIVIDA DECLARADA
-- `aguardando_aprovacao` NAO EXPIRA E NAO NOTIFICA NINGUEM.
--
-- Uma cadeia parada esperando aval fica parada indefinidamente, e ninguem e
-- avisado de que ela existe — quem descobre e quem abre a aba "Fila e aprovacoes".
-- Consequencia pratica: passo de aprovacao esquecido = mensagem que nunca sai, em
-- silencio. Nao foi resolvido aqui de proposito (prazo de expiracao e politica de
-- produto: expirar aprovando? recusando? avisando quem?), e notificacao tem canal
-- proprio no painel. Quando entrar, o lugar e este indice + uma rotina no BACKEND
-- do sistema, nunca uma sessao vigiando.
-- Enquanto isso, a tela conta em destaque quantas execucoes estao paradas.

-- ------------------------------------------- trilha: mensagem -> execucao
-- Card 86ak85zn1. `fluxo_execucoes` (0008) ja guardava QUAL passo rodou, mas nao
-- dava pra sair de uma MENSAGEM da conversa e chegar na execucao que a gerou:
-- faltava o id da mensagem. Duas colunas, as duas opcionais (instalacao que ja
-- tem trilha antiga segue valendo, com o campo vazio).
alter table mensageria.fluxo_execucoes
  add column if not exists mensagem_id uuid;

-- "manual" (atendente disparou) | "gatilho" (automacao). Sem isso a trilha nao
-- distingue o macro que uma pessoa clicou da regua que rodou sozinha — e essa e a
-- primeira pergunta de quem investiga "por que o cliente recebeu isso?".
alter table mensageria.fluxo_execucoes
  add column if not exists origem text;

create index if not exists idx_fluxo_exec_mensagem
  on mensageria.fluxo_execucoes (mensagem_id)
  where mensagem_id is not null;

-- ---------------------------------------------------------------- grants
-- RLS ligado com ZERO policy + grant so pro service_role = anon e usuario logado
-- levam 42501 no PostgREST direto (mesmo modelo das outras tabelas).
grant all on mensageria.fluxo_fila to service_role;

-- Sem isto a rota acusa "migration nao aplicada" mesmo depois de aplicada
-- (PGRST202/PGRST205 no cache de schema do PostgREST).
notify pgrst, 'reload schema';
