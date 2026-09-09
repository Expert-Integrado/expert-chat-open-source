-- 0016_conversa_contexto.sql
-- Contexto da conversa: a MEMORIA do robo (card 86ak859vt).
--
-- Pares chave/valor gravados NA CONVERSA. E o que faz o motor de automacao
-- deixar de ser reflexo (responde a mensagem, esquece tudo) e virar maquina de
-- estados (sabe em que ponto do menu o cliente esta, de que campanha ele veio,
-- que temporizador ja disparou).
--
-- Medido no acervo do ChatGuru (33 contas, 7.462 dialogos): 3.423 dialogos
-- exigem contexto de entrada e as condicoes citam 182 variaveis distintas. As
-- tres familias que aparecem sao maquina de estados do atendimento (URA,
-- AUTOATENDIMENTO, *_ETAPA), atribuicao de origem (campanha, UTM, fonte) e
-- controle de temporizador (timer, timer_menu, timer_opcao).
--
-- UMA LINHA POR CONVERSA, com os pares num jsonb — nao uma linha por par. O
-- acesso e sempre "me da o contexto desta conversa" (o avaliador de condicao
-- precisa do mapa inteiro pra decidir); com linha por par, toda avaliacao viraria
-- N leituras. O preco e que gravar um par exige escrita atomica no jsonb — por
-- isso as duas funcoes abaixo, e nao read-modify-write no cliente.
--
-- ATENCAO: este arquivo NAO e executado por codigo nenhum. Rodar a migration e
-- gesto humano no SQL Editor do Supabase da instalacao (mesma convencao das
-- 0008/0009). Idempotente: pode rodar de novo. Enquanto nao rodar, o painel
-- degrada — leitura devolve contexto vazio com aviso e as acoes de contexto
-- falham com o motivo escrito. Nunca 500.
--
-- Gotcha do repo (CLAUDE.md): tabela nova no schema `mensageria` costuma nascer
-- SEM grant e a rota devolve 500 (permission denied do service_role). Os grants
-- explicitos no fim cobrem o caso de a migration rodar com outro dono.

create table if not exists mensageria.conversa_contexto (
  -- chaveada por (canal, chat_id), igual conversa_responsaveis e conversa_funil:
  -- funciona em QUALQUER canal sem ALTER por tabela de canal — inclusive canal
  -- de fonte externa (somente leitura), porque a memoria mora no banco do
  -- PAINEL e nao escreve no sistema de origem.
  canal text not null,
  chat_id text not null,
  -- mapa chave -> valor. Valor e sempre TEXTO: contexto e rotulo de estado
  -- ("Vendas", "aguardando", "True"), nao tipo de dado. Guardar numero/booleano
  -- aqui criaria duas comparacoes diferentes pra mesma condicao.
  dados jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now(),
  -- autoria da ultima escrita (convencao da 0006): id+nome = pessoa;
  -- id NULL com nome preenchido = automacao
  atualizado_por_id uuid,
  atualizado_por_nome text,
  primary key (canal, chat_id)
);

-- RLS ligada como em TODAS as irmas (funis, papeis, conversa_funil...): quem le
-- e escreve aqui e o service_role da rota, e o painel nunca fala com esta tabela
-- pelo anon key. Sem policy nenhuma, ligar RLS fecha a porta pro anon e nao
-- muda nada pro service_role (que a ignora por definicao).
alter table mensageria.conversa_contexto enable row level security;

comment on table mensageria.conversa_contexto is
  'Memoria da conversa: pares chave/valor lidos pelas condicoes de fluxo. PENDENTE: nao existe tela nem rota pra atendente ver/editar (backend only nesta leva).';

-- ------------------------------------------------------------------ escrita
-- ESCRITA ATOMICA, no servidor. Sem isto, gravar um par seria ler o jsonb,
-- mexer em memoria e regravar — e duas mensagens chegando juntas na mesma
-- conversa (o caso NORMAL de menu de atendimento) fariam uma apagar a variavel
-- que a outra acabou de gravar, em silencio.
create or replace function mensageria.definir_contexto(
  p_canal text,
  p_chat_id text,
  p_chave text,
  p_valor text,
  p_por_id uuid default null,
  p_por_nome text default null
) returns jsonb
language sql
as $$
  insert into mensageria.conversa_contexto as c (canal, chat_id, dados, atualizado_em, atualizado_por_id, atualizado_por_nome)
  values (p_canal, p_chat_id, jsonb_build_object(p_chave, to_jsonb(p_valor)), now(), p_por_id, p_por_nome)
  on conflict (canal, chat_id) do update
    set dados = c.dados || jsonb_build_object(p_chave, to_jsonb(p_valor)),
        atualizado_em = now(),
        atualizado_por_id = p_por_id,
        atualizado_por_nome = p_por_nome
  returning c.dados;
$$;

-- Apagar a chave e DIFERENTE de gravar vazio: a condicao "existe" tem que
-- conseguir distinguir "nunca foi definida" de "definida como ''".
create or replace function mensageria.limpar_contexto(
  p_canal text,
  p_chat_id text,
  p_chave text,
  p_por_id uuid default null,
  p_por_nome text default null
) returns jsonb
language sql
as $$
  update mensageria.conversa_contexto as c
     set dados = c.dados - p_chave,
         atualizado_em = now(),
         atualizado_por_id = p_por_id,
         atualizado_por_nome = p_por_nome
   where c.canal = p_canal and c.chat_id = p_chat_id
  returning c.dados;
$$;

-- ------------------------------------------------------------------- grants
grant select, insert, update, delete on mensageria.conversa_contexto to service_role;
grant execute on function mensageria.definir_contexto(text, text, text, text, uuid, text) to service_role;
grant execute on function mensageria.limpar_contexto(text, text, text, uuid, text) to service_role;

-- O PostgREST so enxerga a tabela e as FUNCOES novas depois de recarregar o
-- schema. Sem isto, a RPC responde PGRST202 ("function not found") e o painel
-- acusa "migration nao rodada" mesmo com a migration rodada — diagnostico
-- errado, e caro de perseguir.
notify pgrst, 'reload schema';
