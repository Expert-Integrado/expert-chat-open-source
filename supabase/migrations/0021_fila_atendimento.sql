-- 0021_fila_atendimento.sql
-- FILA DE ATENDIMENTO: entrar, sair e PULAR A VEZ (Frente S, card 86ak85nxx).
--
-- UMA LINHA POR PESSOA **QUE TEM ESTADO GRAVADO**. Quem nunca mexeu na fila nao
-- tem linha, e isso significa DENTRO (lib/fila-atendimento.ts, `estadoPadrao`):
-- ligar o modulo da CONTROLE, nao muda quem recebe. Se a ausencia de linha
-- valesse "fora", ligar o modulo pararia a distribuicao da instalacao inteira e
-- ninguem saberia por que as conversas pararam de cair.
--
-- POR QUE TABELA NOVA E NAO COLUNA EM `perfis`: o estado da fila e operacional e
-- volatil (muda varias vezes por turno, e o `pular_vez` expira em 12h), enquanto
-- `perfis` e cadastro. Mais concreto: `getPerfil` e lido no caminho quente de
-- TODA rota (polling de 3-6s por atendente) e serve de fonte pra autorizacao —
-- colocar um campo que muda a cada clique ali derrubaria o cache de perfil da
-- frota inteira a cada "pular a vez", e um select largo de perfis que falha
-- rebaixa super admin (gotcha da 0010, ver CLAUDE.md).
--
-- ATENCAO: este arquivo NAO e executado por codigo nenhum. Rodar a migration e
-- gesto humano no SQL Editor do Supabase da instalacao (mesma convencao das
-- 0008..0020). Idempotente: pode rodar de novo. Enquanto nao rodar, o painel
-- degrada — a rota responde `migration_pendente: true` com aviso, o controle da
-- fila aparece explicando que a fila nao esta instalada, e a distribuicao se
-- comporta como antes desta frente (ninguem tem estado, logo todos estao
-- dentro). Nunca 500.
--
-- Regra da casa (CLAUDE.md, licao da 0018): coluna nova entra SEMPRE tambem como
-- `add column if not exists`, e default que muda entra como
-- `alter column ... set default` — `create table if not exists` NAO altera
-- tabela que ja existe, e a instalacao que testou uma versao anterior desta
-- branch e justamente a que quebraria.

create table if not exists mensageria.atendente_fila (
  -- id do usuario no auth compartilhado (o mesmo `perfis.user_id`). Sem FK de
  -- proposito: `perfis` tambem nao tem FK pro auth, e uma FK aqui faria apagar
  -- usuario no auth quebrar a fila.
  user_id uuid primary key,
  -- na fila? Sair e gesto EXPLICITO, e e ele que cria a linha.
  dentro boolean not null default true,
  -- "pula a MINHA proxima vez". Consumido quando a vez da pessoa chega
  -- (lib/fila-atendimento.ts) e inerte depois de 12h (TTL declarado la).
  pular_vez boolean not null default false,
  -- quando o pulo foi marcado. E o que faz o TTL existir: sem carimbo, um pulo
  -- marcado numa quinta as 18h tiraria a pessoa da distribuicao na manha
  -- seguinte sem ela lembrar de ter marcado.
  pular_desde timestamptz,
  atualizado_em timestamptz not null default now(),
  -- autoria da ultima escrita, convencao da 0006: id+nome = pessoa;
  -- id NULL com nome preenchido = automacao (aqui: o consumo do pulo pelo
  -- proprio rodizio, que nao e clique de ninguem).
  atualizado_por_id uuid,
  atualizado_por_nome text
);

alter table mensageria.atendente_fila add column if not exists dentro boolean not null default true;
alter table mensageria.atendente_fila add column if not exists pular_vez boolean not null default false;
alter table mensageria.atendente_fila add column if not exists pular_desde timestamptz;
alter table mensageria.atendente_fila add column if not exists atualizado_em timestamptz not null default now();
alter table mensageria.atendente_fila add column if not exists atualizado_por_id uuid;
alter table mensageria.atendente_fila add column if not exists atualizado_por_nome text;
alter table mensageria.atendente_fila alter column dentro set default true;
alter table mensageria.atendente_fila alter column pular_vez set default false;

-- O rodizio le "quem esta fora ou pulou" a cada conversa nova sem responsavel.
-- Indice PARCIAL: numa operacao normal a grande maioria das linhas e
-- (dentro=true, pular_vez=false), que e o estado inerte — indexar isso seria
-- indexar a tabela inteira pra nada.
create index if not exists ix_atendente_fila_indisponivel
  on mensageria.atendente_fila (user_id)
  where dentro = false or pular_vez = true;

-- RLS ligada como em TODAS as irmas (funis, papeis, conversa_contexto...): quem
-- le e escreve aqui e o service_role da rota; o painel nunca fala com esta
-- tabela pelo anon key. Sem policy nenhuma, ligar RLS fecha a porta pro anon e
-- nao muda nada pro service_role (que a ignora por definicao).
alter table mensageria.atendente_fila enable row level security;

comment on table mensageria.atendente_fila is
  'Fila de atendimento humano: quem esta dentro, quem saiu e quem pediu pra pular a vez. SEM LINHA = DENTRO (ligar o modulo da controle, nao muda quem recebe). O modulo `fila_atendimento` (lib/modulos.ts) nasce DESLIGADO — desligado, o rodizio nem consulta esta tabela.';

comment on column mensageria.atendente_fila.pular_vez is
  'Pula a PROXIMA vez da pessoa. Consumido quando a vez dela chega (nao a cada distribuicao — senao "pular a vez" viraria "esperar dois segundos" numa operacao movimentada) e inerte depois de 12h.';

-- ------------------------------------------------------------------- grants
-- Gotcha do repo (CLAUDE.md): tabela nova no schema `mensageria` costuma nascer
-- SEM grant e a rota devolve 500 (permission denied do service_role). O
-- `alter default privileges` da 0001 cobre tabela futura, mas o grant explicito
-- cobre o caso de a migration rodar com outro dono.
grant select, insert, update, delete on mensageria.atendente_fila to service_role;

-- ------------------------------------------------- carona: mensagens_agendadas
-- FRENTE S, 3a revisao. NAO e da fila, e viaja aqui porque esta migration ainda
-- nao rodou em lugar nenhum (emendar e mais honesto que criar uma 0021b pra uma
-- coluna).
--
-- O cron passou a RESERVAR a agendada (`status = 'enviando'`) antes de enviar, e
-- a varredura de linha presa media a idade por `enviar_em`. Isso confunde duas
-- coisas diferentes: "vencida ha muito tempo" e "esta em envio ha muito tempo".
-- Depois de um backlog (cron parado, fila acumulada), uma linha com `enviar_em`
-- de horas atras entra em envio LEGITIMO e seria marcada como interrompida no
-- mesmo minuto — mandando o atendente conferir no WhatsApp uma mensagem que
-- estava saindo naquele instante, com risco de reenvio manual.
alter table mensageria.mensagens_agendadas
  add column if not exists reservada_em timestamptz;

comment on column mensageria.mensagens_agendadas.reservada_em is
  'Quando o cron RESERVOU esta linha pra enviar (status = enviando). E o relogio da varredura de linha presa — medir por enviar_em confundiria "vencida ha muito" com "em envio ha muito", e um backlog marcaria envio legitimo como interrompido.';

-- Sem isto o PostgREST responde PGRST205 ("could not find the table ... in the
-- schema cache") e o painel acusa "migration nao rodada" com a migration
-- rodada — diagnostico errado, e caro de perseguir.
notify pgrst, 'reload schema';
