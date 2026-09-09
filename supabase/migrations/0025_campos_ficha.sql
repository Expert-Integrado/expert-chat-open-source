-- 0025 — Campos personalizados: construtor de ficha por conta
--        (Frente X, 31/08/2026 — card 86ak85nxn)
--
-- COMO RODAR: SQL Editor do Supabase, na mao. O codigo do painel NUNCA cria
-- tabela nem coluna — regra da casa. Enquanto esta migration nao rodar:
--   * a ficha continua funcionando EXATAMENTE como hoje (campo de texto livre,
--     catalogo por nome) — `lib/campos-db.ts` detecta 42703/PGRST204 na leitura
--     das colunas novas, refaz o select sem elas e devolve
--     `tipos_disponiveis: false`;
--   * a tela do construtor abre, mostra os campos e AVISA que tipo, obrigatorio
--     e opcoes nao gravam nesta instalacao (nunca finge que salvou);
--   * renomear campo COM valores gravados e RECUSADO (a funcao de renome nao
--     existe, e renomear sem migrar os valores os deixaria orfaos em silencio);
--   * remover campo pede a contagem de impacto, que cai no caminho de leitura
--     por PostgREST — mais lento e igualmente correto.
-- A deteccao e re-testada a cada 60s: no minuto seguinte a migration rodar,
-- tudo passa a valer sem redeploy.
--
-- ───────────────────────────────────────────────────────────────────────
-- O QUE **NAO** MUDA AQUI, e e o coracao da compatibilidade:
--
--   O VALOR CONTINUA MORANDO EM `conversas[_<canal>].ficha` (jsonb), CHAVEADO
--   PELO NOME DO CAMPO. Nao ha tabela de valores, e isso e decisao, nao
--   preguica: quem ja grava ali e o sync do ChatGuru
--   (`lib/chatguru-sync.ts` -> `buscarFicha` le os rotulos da tela de origem e
--   faz `patch.ficha = {...atual, ...ficha}`, ATE 5000 chars por valor) e ele
--   tambem INSERE no catalogo o campo que apareceu novo, com
--   `{nome, ativo, ordem}` e mais nada. Se o valor mudasse de casa, ou se `tipo`
--   nascesse NOT NULL sem default, o sync passaria a falhar — e ele roda 1x/min
--   pelo pg_cron (jobid 14). Por isso TODA coluna nova aqui tem DEFAULT, e o
--   default de `tipo` e `'texto'`, que e exatamente o comportamento de hoje.
--
--   E POR ISSO NAO HA UNIQUE NORMALIZADO EM `nome`. A UNIQUE por texto exato ja
--   existe desde a 0001. Um unique sobre a forma normalizada ("Cliente" x
--   "cliente") seria bonito e ABORTARIA a migration em qualquer instalacao onde
--   o sync ja criou as duas variantes — o acervo medido tem exatamente esse
--   padrao em etiqueta (catalogo de 35 nomes, 76 textos distintos usados). A
--   licao e a da 0019: `add constraint` VALIDA as linhas existentes, e migration
--   que aborta no meio deixa a instalacao pior do que estava. Quem recusa
--   colisao nova e a ROTA (`/api/campos`, por igualdade NORMALIZADA — nunca
--   `ilike`); colisao que JA existe entra como pendencia na tela.

-- ─────────────────────────── as colunas do construtor
--
-- `tipo` governa VALIDACAO e RENDERIZACAO, nunca reescrita: valor gravado que
-- nao casa com o tipo (importado, ou digitado antes de alguem tipar o campo) e
-- MOSTRADO como esta e marcado "fora do formato" — chute de formato estraga o
-- dado que estava certo (mesma regra do encoding no importador).
alter table mensageria.campos_personalizados
  add column if not exists tipo text not null default 'texto';

-- `obrigatorio` NAO bloqueia enviar mensagem nem concluir conversa: isso seria
-- politica de produto que ninguem decidiu, e travaria 12 mil conversas
-- importadas sem valor. O efeito REAL, e o unico, e assimetrico: campo
-- obrigatorio que JA tem valor nao pode ser ESVAZIADO pelo painel (e
-- literalmente o que "obrigatorio" proibe), e a ficha reporta as pendencias pra
-- tela mostrar. Interruptor que nao faz nada e mentira na tela.
alter table mensageria.campos_personalizados
  add column if not exists obrigatorio boolean not null default false;

-- `opcoes` so tem sentido em `tipo = 'lista'`. Guardado como array de TEXTO (a
-- opcao que o cliente ve), nunca como par id/rotulo: o valor gravado na ficha e
-- o texto da opcao, entao um id aqui criaria uma segunda linguagem que o
-- importador e o `!campo.x` das respostas rapidas nao falam.
alter table mensageria.campos_personalizados
  add column if not exists opcoes jsonb not null default '[]'::jsonb;

alter table mensageria.campos_personalizados
  add column if not exists descricao text;

alter table mensageria.campos_personalizados
  add column if not exists atualizado_em timestamp with time zone not null default now();

-- DEFAULT QUE MUDA ENTRA COMO `alter column ... set default` — regra da casa que
-- saiu da 0018: `create table if not exists` nao altera tabela que ja existe, e a
-- instalacao que rodou a versao anterior e justamente a que quebra.
alter table mensageria.campos_personalizados alter column tipo        set default 'texto';
alter table mensageria.campos_personalizados alter column obrigatorio set default false;
alter table mensageria.campos_personalizados alter column opcoes      set default '[]'::jsonb;

-- ─────────────────────────── os CHECKs, e o saneamento ANTES deles
--
-- `add constraint` valida as linhas existentes (licao paga na 0019: o CHECK
-- levantou check_violation e matou o script ANTES do seed). Aqui as colunas
-- acabaram de nascer com default valido, entao nao ha linha invalida possivel —
-- mas o saneamento vai escrito de todo jeito, porque numa instalacao que testou
-- uma versao anterior desta branch a coluna pode existir com lixo.
update mensageria.campos_personalizados
   set tipo = 'texto'
 where tipo is null or tipo not in ('texto', 'numero', 'data', 'lista', 'sim_nao');

update mensageria.campos_personalizados
   set opcoes = '[]'::jsonb
 where opcoes is null or jsonb_typeof(opcoes) <> 'array';

do $$
begin
  alter table mensageria.campos_personalizados
    add constraint campos_personalizados_tipo_check
    check (tipo in ('texto', 'numero', 'data', 'lista', 'sim_nao'));
exception
  when duplicate_object then null;
  -- CHECK que nao pega e menos grave que migration que morre antes do resto:
  -- avisa e segue (mesmo handler da 0019).
  when check_violation then raise notice 'campos_personalizados: ha linha com tipo fora da lista; CHECK de tipo NAO foi criado';
end $$;

do $$
begin
  alter table mensageria.campos_personalizados
    add constraint campos_personalizados_opcoes_array_check
    check (jsonb_typeof(opcoes) = 'array');
exception
  when duplicate_object then null;
  when check_violation then raise notice 'campos_personalizados: ha linha com opcoes que nao e array; CHECK de opcoes NAO foi criado';
end $$;

comment on column mensageria.campos_personalizados.tipo is
  'texto | numero | data | lista | sim_nao. Governa validacao e renderizacao. NAO reescreve valor gravado: valor que nao casa com o tipo e mostrado como esta e marcado "fora do formato".';
comment on column mensageria.campos_personalizados.obrigatorio is
  'Campo que a ficha considera necessario. NAO bloqueia envio nem conclusao (politica de produto nao decidida); o efeito real e impedir ESVAZIAR um campo que ja tem valor, e reportar pendencia na tela.';
comment on column mensageria.campos_personalizados.opcoes is
  'Array de TEXTO das opcoes de tipo=lista. O valor gravado na ficha e o texto da opcao (nunca um id) — e a mesma linguagem que o importador e o !campo.x das respostas rapidas falam.';

-- ─────────────────────────── contagem de impacto (remover / arquivar)
--
-- POR QUE FUNCAO, E NAO FILTRO NO POSTGREST: a pergunta e "quantas conversas
-- deste canal tem valor neste campo", e o nome do campo e TEXTO ESCOLHIDO POR
-- GENTE — com ponto, com aspas, com acento (o sync cria o campo com o rotulo da
-- tela de origem). Montar `ficha->>Nome` como caminho de filtro do PostgREST
-- exige escapar esse nome em outro dialeto; aqui o nome viaja como PARAMETRO e
-- nunca e concatenado.
--
-- `p_tabela` dinamico pelo mesmo motivo da 0017: cada canal tem o proprio par de
-- tabelas (`lib/canais.ts`), e canal declarado por `CANAIS_EXTRA` tem nome
-- proprio. O nome e validado contra o mesmo formato de id que o registro aceita
-- e resolvido por `to_regclass` antes de entrar no `format(%I)` — nunca
-- concatenado cru. Tabela invalida devolve NULL (nao 0): "nao consegui contar" e
-- diferente de "nao ha nenhuma", e quem decide a remocao e fail-closed.
create or replace function mensageria.contar_valores_campo(
  p_tabela text,
  p_nome   text
) returns bigint
language plpgsql
stable
as $$
declare
  v_total bigint;
begin
  if p_tabela is null or p_tabela !~ '^[a-z][a-z0-9_]{1,60}$' then
    return null;
  end if;
  if to_regclass('mensageria.' || quote_ident(p_tabela)) is null then
    return null;
  end if;
  if p_nome is null or p_nome = '' then
    return null;
  end if;

  -- valor VAZIO nao conta como valor: a ficha guarda string, e `""` e o que
  -- sobra de uma limpeza antiga. Contar isso inflaria o impacto e faria a tela
  -- avisar sobre historico que nao existe.
  execute format($q$
    select count(*) from mensageria.%I
     where ficha ? %L
       and btrim(coalesce(ficha->>%L, '')) <> ''
  $q$, p_tabela, p_nome, p_nome)
  into v_total;

  return v_total;
end $$;

-- ─────────────────────────── renomear campo SEM perder valor
--
-- O DEFEITO QUE ISTO FECHA JA EXISTIA EM PRODUCAO. `/api/admin/ficha-config`
-- aceita `{tipo:"campo", id, nome}` e faz UPDATE em `campos_personalizados.nome`
-- — e os valores continuam gravados sob o nome ANTIGO em `conversas.ficha`. A
-- tela da conversa itera `campos_padrao` (o catalogo) pra desenhar a ficha, ou
-- seja: depois de um rename, o valor de todo mundo fica no banco e INVISIVEL, e
-- a rota de escrita passa a ignorar aquela chave (ela nao esta mais no
-- catalogo). Perda silenciosa de dado do cliente, por um botao de renomear.
--
-- Aqui o rename e uma instrucao unica por canal, e ela devolve os DOIS numeros
-- que a tela precisa: quantas linhas foram renomeadas e quantas tinham JA um
-- valor no nome NOVO. Linha em conflito NAO e tocada — sobrescrever o valor de
-- destino seria trocar uma perda silenciosa por outra. O relatorio manda; a
-- decisao de o que fazer com o conflito e humana.
create or replace function mensageria.renomear_campo_ficha(
  p_tabela text,
  p_de     text,
  p_para   text
) returns jsonb
language plpgsql
as $$
declare
  v_renomeadas bigint := 0;
  v_conflitos  bigint := 0;
begin
  if p_tabela is null or p_tabela !~ '^[a-z][a-z0-9_]{1,60}$' then
    return jsonb_build_object('ok', false, 'motivo', 'tabela invalida');
  end if;
  if to_regclass('mensageria.' || quote_ident(p_tabela)) is null then
    return jsonb_build_object('ok', false, 'motivo', 'canal sem tabela no banco');
  end if;
  if p_de is null or p_de = '' or p_para is null or p_para = '' then
    return jsonb_build_object('ok', false, 'motivo', 'nome vazio');
  end if;
  if p_de = p_para then
    return jsonb_build_object('ok', true, 'renomeadas', 0, 'conflitos', 0);
  end if;

  -- LOCK PELO CAMPO, nao pela tabela: dois administradores renomeando campos
  -- DIFERENTES no mesmo minuto nao tem por que se esperar; dois renomeando o
  -- MESMO campo (ou um renomeando enquanto o outro remove) precisam serializar,
  -- senao o segundo le o catalogo antigo e escreve por cima.
  perform pg_advisory_xact_lock(hashtext('mensageria.renomear_campo_ficha:' || p_de));

  execute format($q$
    select count(*) from mensageria.%I
     where ficha ? %L and ficha ? %L
  $q$, p_tabela, p_de, p_para)
  into v_conflitos;

  -- UMA instrucao: tira a chave antiga e poe a nova com o MESMO valor, na mesma
  -- linha. `not (ficha ? novo)` deixa o conflito de fora (contado acima) — a
  -- alternativa seria sobrescrever o valor de destino, o que troca uma perda
  -- silenciosa por outra.
  execute format($q$
    update mensageria.%I
       set ficha = (ficha - %L) || jsonb_build_object(%L, ficha -> %L),
           updated_at = now()
     where ficha ? %L and not (ficha ? %L)
  $q$, p_tabela, p_de, p_para, p_de, p_de, p_para);

  -- ROW_COUNT depois de EXECUTE vem por GET DIAGNOSTICS (o `FOUND` do plpgsql
  -- NAO e atualizado por EXECUTE — usar `if found` aqui seria bug silencioso).
  get diagnostics v_renomeadas = row_count;

  return jsonb_build_object('ok', true, 'renomeadas', v_renomeadas, 'conflitos', v_conflitos);
end $$;

-- ─────────────────────────── grants, RLS e o notify
--
-- RLS: O QUE ESTA LINHA E DEPENDE DE ONDE SE MEDE — e as duas versoes anteriores
-- deste cabecalho erraram por confundir isso (re-revisao cega, 31/08/2026).
--
-- NA INSTANCIA DE PRODUCAO MEDIDA: `pg_class.relrowsecurity = true` pra esta
-- tabela e pra todas as do schema `mensageria`, todas com ZERO policies — o padrao
-- da casa descrito no CLAUDE.md (o `service_role` passa por cima da RLS, e mais
-- ninguem entra; a anon key nao tem grant e leva 42501). Ali esta linha e no-op.
--
-- NA ARVORE DESTE REPO: a `0001_schema_completo.sql` cria 17 tabelas e NAO liga RLS
-- em nenhuma, e `campos_personalizados` nao recebe `enable row level security` em
-- migration nenhuma antes desta. Ou seja: numa instalacao NOVA feita pelas
-- migrations, ESTA LINHA E A UNICA QUE LIGA RLS NESTA TABELA. Ela nao e cinto pra
-- instalacao divergente — no caminho do repo, ela e o unico caminho.
--
-- (DIVIDA DECLARADA, fora do escopo desta migration: 16 das 17 tabelas da 0001 —
-- `conversas`, `conversas_apioficial`, `mensagens`, `mensagens_apioficial` e
-- `perfis` entre elas — nao recebem RLS em migration nenhuma. Consertar isso mexe
-- no schema inteiro e nao e assunto do construtor de ficha; a linha esta no
-- CLAUDE.md pro proximo dono do assunto.)
--
-- O que protege a tabela e o par RLS-ligada-sem-policy + grant so pra service_role,
-- e o grant abaixo e que era mesmo obrigatorio, porque a `alter default privileges`
-- da 0001 nao alcanca tabela criada depois.
alter table mensageria.campos_personalizados enable row level security;

grant select, insert, update, delete on mensageria.campos_personalizados to service_role;

-- Funcao nova nasce executavel por `public`, e `anon`/`authenticated` herdam —
-- item de checklist desde a 0017. `renomear_campo_ficha` ESCREVE em toda linha de
-- conversa de um canal: chamavel pela anon key (que vai no bundle do navegador),
-- ela reescreveria a ficha da conta inteira sem passar por rota nenhuma.
revoke execute on function mensageria.contar_valores_campo(text, text) from public, anon, authenticated;
revoke execute on function mensageria.renomear_campo_ficha(text, text, text) from public, anon, authenticated;

-- E O GRANT, EM PAR COM O REVOKE — a metade que faltava e que faz as duas RPCs
-- NASCEREM MORTAS se ficar de fora. `revoke ... from public` tira de TODO MUNDO
-- (o `service_role` nao tem grant proprio: ele herdava de `public`), e a
-- `alter default privileges` da 0001 e `on tables`, nao alcanca funcao. Sem estas
-- duas linhas o admin roda a migration, ve "sucesso" no SQL Editor, e o painel
-- passa a levar `42501 permission denied for function` — que NAO e "a 0025 nao
-- rodou", entao a degradacao nem seria acionada. Par revoke+grant e o padrao da
-- casa desde a 0013/0017.
grant execute on function mensageria.contar_valores_campo(text, text) to service_role;
grant execute on function mensageria.renomear_campo_ficha(text, text, text) to service_role;

-- SEM `notify pgrst` A FEATURE NASCE MORTA: o PostgREST cacheia o schema e segue
-- respondendo PGRST205/PGRST204 pras colunas e pras RPCs novas ate receber o
-- notify — e o painel LE esse erro como "a migration nao rodou"
-- (`erroDeSchemaAusente` em lib/acesso.ts). O admin roda o SQL, ve "sucesso" no
-- editor, e a tela continua dizendo que a 0025 esta pendente.
notify pgrst, 'reload schema';
