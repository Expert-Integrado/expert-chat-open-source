-- 0009_funis.sql
-- Funil e etapas (epico 11, cards 86ak86k62 + 86ak86kac): a conversa anda por
-- etapas de um ou mais funis, sem sair do atendimento.
--
-- Tres tabelas:
--   mensageria.funis                 = o funil (nome, ordem, ativo)
--   mensageria.funil_etapas          = as etapas ordenadas de um funil (nome, ordem, cor)
--   mensageria.conversa_funil        = EM QUE ETAPA cada conversa esta (N:N)
--   mensageria.conversa_funil_eventos= trilha de entrada/saida com autor e data
--
-- ATENCAO: este arquivo NAO e executado por codigo nenhum. Rodar a migration e
-- gesto humano no SQL Editor do Supabase da instalacao (mesma convencao da 0007
-- e da 0008). Idempotente: pode rodar de novo sem estragar nada. Enquanto nao
-- rodar, as rotas de funil respondem lista vazia com aviso — nunca 500.
--
-- Gotcha do repo (CLAUDE.md): tabela nova no schema `mensageria` costuma nascer
-- SEM grant e a rota devolve 500 (permission denied do service_role). O
-- `alter default privileges` de 0001 cobre tabelas futuras; o grant explicito no
-- fim garante o caso de a migration rodar com outro dono.
--
-- Esta migration SUBSTITUI a proposta `scripts/importar/ddl-funis-proposto.sql`
-- (frente do importador): mesmos nomes de tabela e mesma PK de vinculo, com o
-- que faltava pro produto — ordem, cor, arquivamento, rastreabilidade completa e
-- trilha com autor.

-- ---------------------------------------------------------------- funis
create table if not exists mensageria.funis (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  -- arquivar em vez de apagar: ha conversas e fluxos apontando pra ca
  ativo boolean not null default true,
  ordem integer not null default 0,
  descricao text,
  -- RASTREABILIDADE DE ORIGEM (card 86ak858b8). As tres colunas juntas dizem
  -- "esta linha veio de tal registro, de tal conta, de tal sistema" — e sao o
  -- que torna a reimportacao idempotente sem duplicar nada.
  --   origem_sistema   = ferramenta de origem ("chatguru", ...)
  --   origem_conta_id  = qual conta/aparelho daquela ferramenta
  --   origem_id        = o id do funil LA
  origem_sistema text,
  origem_conta_id text,
  origem_id text,
  criado_por_id uuid,
  criado_por_nome text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

alter table mensageria.funis enable row level security;

-- nome unico: o motor de fluxo referencia funil POR NOME (fluxo importado nao
-- conhece o uuid desta instalacao), entao dois funis com o mesmo nome fariam a
-- acao de fluxo virar sorteio.
create unique index if not exists uq_funis_nome on mensageria.funis (nome);
-- Indice NAO-parcial e sem expressao DE PROPOSITO: o importador usa upsert do
-- PostgREST (`on_conflict=origem_sistema,origem_conta_id,origem_id`) e o
-- PostgREST recusa on_conflict em indice parcial com 42P10 (gotcha ja pago em
-- `uq_mensagens_provider`). Linha criada a mao no painel tem as tres colunas
-- NULL e nao colide com nada (NULL e distinto de NULL em indice unico).
create unique index if not exists uq_funis_origem
  on mensageria.funis (origem_sistema, origem_conta_id, origem_id);
create index if not exists ix_funis_ativo on mensageria.funis (ativo, ordem);

-- ---------------------------------------------------------- funil_etapas
create table if not exists mensageria.funil_etapas (
  id uuid primary key default gen_random_uuid(),
  funil_id uuid not null references mensageria.funis (id) on delete cascade,
  nome text not null,
  ordem integer not null default 0,
  -- cor da etapa no quadro; hex de 6 digitos ou nada (a tela escolhe o default)
  cor text,
  ativo boolean not null default true,
  origem_sistema text,
  origem_conta_id text,
  origem_id text,
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now(),
  constraint ck_funil_etapas_cor check (cor is null or cor ~ '^#[0-9A-Fa-f]{6}$')
);

alter table mensageria.funil_etapas enable row level security;

-- nome unico DENTRO do funil (entre funis pode repetir — e o normal: "Fechamento"
-- costuma existir em varios funis ao mesmo tempo). E exatamente por isso que
-- fluxo e importador resolvem etapa por FUNIL+NOME ou por id de origem, nunca
-- por nome solto.
create unique index if not exists uq_funil_etapas_nome on mensageria.funil_etapas (funil_id, nome);
create unique index if not exists uq_funil_etapas_origem
  on mensageria.funil_etapas (origem_sistema, origem_conta_id, origem_id);
create index if not exists ix_funil_etapas_funil on mensageria.funil_etapas (funil_id, ordem);

-- --------------------------------------------------------- conversa_funil
-- Em que etapa cada conversa esta. Chaveada por (canal, chat_id) como o resto do
-- painel (conversa_responsaveis, conversa_visibilidade, notificacoes): assim
-- funciona pra QUALQUER canal — inclusive canal de fonte externa, somente
-- leitura, que nao tem linha de conversa no banco do painel — e canal novo nao
-- exige ALTER nenhum.
--
-- N:N de verdade: a mesma conversa pode estar em varias etapas ao mesmo tempo,
-- inclusive de funis diferentes (acompanhar venda e implantacao em paralelo e o
-- caso comum). Duas etapas do MESMO funil o banco tambem aceita — a PK e por
-- etapa, e importacao de outra ferramenta traz esse caso; quem MOVE a conversa
-- por dentro de um funil sai das outras etapas daquele funil.
create table if not exists mensageria.conversa_funil (
  canal text not null,
  chat_id text not null,
  etapa_id uuid not null references mensageria.funil_etapas (id) on delete cascade,
  -- desnormalizado de proposito: "as etapas desta conversa NESTE funil" e a
  -- consulta mais quente (mover, ler, quadro) e sem esta coluna toda leitura
  -- vira join. Quem escreve mantem coerente com a etapa (API e importador).
  funil_id uuid not null references mensageria.funis (id) on delete cascade,
  -- quem colocou: pessoa (id+nome) ou automacao (id NULL + nome) — mesma
  -- convencao de autoria da migration 0006
  definido_por_id uuid,
  definido_por_nome text,
  -- quando veio de fluxo: qual
  fluxo_slug text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  primary key (canal, chat_id, etapa_id)
);

alter table mensageria.conversa_funil enable row level security;

create index if not exists ix_conversa_funil_etapa on mensageria.conversa_funil (etapa_id);
create index if not exists ix_conversa_funil_funil on mensageria.conversa_funil (funil_id, canal, chat_id);

-- ------------------------------------------------- conversa_funil_eventos
-- Trilha append-only: entrar, sair e mover gravam QUEM e QUANDO. Sem isto,
-- "por que essa conversa esta em Fechamento?" nao tem resposta — e a resposta e
-- justamente o que o gestor pede quando o quadro comeca a valer dinheiro.
create table if not exists mensageria.conversa_funil_eventos (
  id uuid primary key default gen_random_uuid(),
  canal text not null,
  chat_id text not null,
  -- referencia solta (sem FK): funil/etapa apagados nao apagam o historico
  funil_id uuid,
  funil_nome text,
  etapa_id uuid,
  etapa_nome text,
  etapa_anterior_id uuid,
  etapa_anterior_nome text,
  -- entrou | saiu | moveu
  acao text not null,
  -- pessoa (id+nome) | automacao (id NULL + nome) — convencao da 0006
  por_id uuid,
  por_nome text,
  -- preenchidos quando o movimento veio do motor de fluxo
  fluxo_slug text,
  fluxo_nome text,
  criada_em timestamptz not null default now()
);

alter table mensageria.conversa_funil_eventos enable row level security;

create index if not exists ix_cf_eventos_chat
  on mensageria.conversa_funil_eventos (canal, chat_id, criada_em desc);
create index if not exists ix_cf_eventos_etapa
  on mensageria.conversa_funil_eventos (etapa_id, criada_em desc);

-- ---------------------------------------------------------------- grants
-- RLS ligado com ZERO policy + grant so pro service_role = anon e usuario
-- logado levam 42501 no PostgREST direto (mesmo modelo das outras tabelas).
grant all on mensageria.funis to service_role;
grant all on mensageria.funil_etapas to service_role;
grant all on mensageria.conversa_funil to service_role;
grant all on mensageria.conversa_funil_eventos to service_role;

-- O PostgREST so enxerga a tabela nova depois de recarregar o schema:
notify pgrst, 'reload schema';
