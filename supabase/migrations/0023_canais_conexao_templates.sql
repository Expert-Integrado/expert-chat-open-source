-- 0023 — Conexao do numero, troca de chip e templates da API Oficial
--        (Frente U, 31/08/2026)
--   card 86ak858mx  conectar numero por QR Code e por codigo de 8 digitos (Z-API)
--   card 86ak858nx  trocar o numero de um canal preservando o historico
--   card 86ak858pa  templates de mensagem por numero (API Oficial)
--
-- COMO RODAR: SQL Editor do Supabase, na mao. O codigo do painel NUNCA cria
-- tabela nem coluna — regra da casa. Enquanto esta migration nao rodar:
--   * a tela de canais funciona pra CONECTAR (QR, codigo, desconectar,
--     reiniciar): isso fala com o provedor, nao com o banco;
--   * a TROCA de numero e o CATALOGO de templates respondem
--     `disponivel:false` + `aviso` (nunca 500), e a escrita fica desabilitada na
--     tela — nunca finge que salvou;
--   * o envio por template no /api/send recusa com "sincronize os templates
--     deste numero" — fail-closed, porque sem catalogo nao ha como saber se o
--     template esta aprovado.
-- A deteccao e a mesma da 0019: erro de schema ausente do PostgREST
-- (`erroDeSchemaAusente` em lib/acesso.ts), re-testado a cada leitura. No minuto
-- seguinte a migration rodar, tudo passa a valer sem redeploy.
--
-- COMPATIBILIDADE: as tres tabelas nascem VAZIAS e nenhuma linha existente muda
-- de sentido. Canal sem linha em `canal_estado` = canal que nunca passou por
-- troca nem teve numero conferido; a identidade que a tela mostra continua sendo
-- a do registro de canais (env `CANAL_<ID>_IDENTIDADE` / `CANAIS_EXTRA`).
--
-- ───────────────────────────────────────────────────────────────────────
-- O QUE **NAO** ENTRA AQUI, e por que — leia antes de "melhorar" o schema:
--
--   CREDENCIAL DE PROVEDOR NAO MORA NO BANCO. Nem instancia, nem token, nem
--   apikey. A regra da casa e clara (segredo nunca vira literal) e o registro de
--   canais ja resolve isso por env, por canal: `ZAPI_<ID>_INSTANCE_ID/_TOKEN/
--   _CLIENT_TOKEN`, `GUPSHUP_<ID>_API_KEY/_APP_ID`, `EVOLUTION_<ID>_*`
--   (lib/canais.ts, lib/zapi.ts, lib/gupshup.ts, lib/evolution.ts).
--   A coluna `instancia_marca` abaixo guarda so as PONTAS do identificador da
--   instancia (`mascararInstancia`), com um proposito estreito: DETECTAR que a
--   instalacao apontou o canal pra outra instancia, e registrar isso na trilha.
--   Ela nao serve — e nao consegue — pra autenticar nada.
--
--   O ID DO CANAL NAO MUDA NUNCA. E a feature inteira do card 86ak858nx: as
--   conversas e as mensagens moram em tabelas nomeadas pelo id do canal
--   (`conversas_<id>` / `mensagens_<id>`, lib/canais.ts) e as tabelas compostas
--   (conversa_responsaveis, notificacoes, visibilidade, conversa_funil) sao
--   chaveadas por (canal, chat_id). Trocar o chip mexe no NUMERO; o historico nem
--   fica sabendo. Por isso `canal` aqui e TEXT sem FK: o registro de canais e o
--   env/config da instalacao, nao uma tabela.

-- ────────────────────────────── estado do canal (86ak858mx + 86ak858nx)
--
-- UMA linha por canal, criada na primeira vez que alguem conecta ou abre troca.
--
-- `numero` = o numero que o painel viu CONECTADO pela ultima vez (conferido no
-- provedor, nao digitado por ninguem). `troca_pendente` = a declaracao do
-- administrador, com consentimento, esperando o chip novo aparecer.
--
-- POR QUE `troca_pendente` E UM JSONB, E NAO COLUNAS: a pendencia e um objeto de
-- ciclo curto que ou existe inteiro ou nao existe (numero novo + quem abriu +
-- quando + de qual numero saiu). Em colunas soltas, "meia pendencia" e um estado
-- alcancavel — e meia pendencia e exatamente o bug que conclui troca no escuro.
-- O formato e validado na leitura (`lerTrocaPendente` em lib/canais-db.ts); jsonb
-- torto e DESCARTADO, e canal sem pendencia legivel simplesmente nao tem troca em
-- andamento.
create table if not exists mensageria.canal_estado (
  canal text primary key,
  -- so digitos (DDI+DDD+numero). NULL = o painel ainda nao conferiu o numero
  -- deste canal no provedor.
  numero text,
  numero_em timestamptz,
  -- pontas do identificador da instancia (NUNCA o token) — ver o aviso acima
  instancia_marca text,
  troca_pendente jsonb,
  atualizado_em timestamptz not null default now(),
  constraint ck_canal_estado_numero check (numero is null or numero ~ '^[0-9]{10,15}$')
);

comment on table mensageria.canal_estado is
  'Numero conectado e troca de chip pendente, por canal. Sem credencial: token e instancia vivem em env (lib/zapi.ts).';

-- ───────────────────────────────────── trilha do canal (86ak858nx)
--
-- "Quem trocou, quando, de que numero pra qual" — criterio de aceite do card.
--
-- A trilha e APPEND-ONLY por desenho: nada aqui e atualizado nem apagado pelo
-- painel. Ela e o unico lugar que sabe contar a historia do numero depois de a
-- troca terminar, e trilha que se edita nao e trilha.
--
-- `tipo` e TEXT com CHECK, e nao enum: tipo novo (a Frente que plugar Evolution
-- vai querer os seus) entra sem ALTER TYPE, e o CHECK segue barrando lixo. Quem
-- traduz cada tipo em frase e `descreverEvento` (lib/canal-conexao.ts) —
-- inclusive o `else` pro tipo que a versao da tela nao conhece ainda.
--
-- Convencao de AUTOR igual a da 0006 e da 0019: id nulo com nome preenchido =
-- automacao; os dois nulos = evento que o painel carimbou sozinho (ex.: a
-- conclusao da troca, que acontece por CONECTAR e nao por clique).
create table if not exists mensageria.canal_eventos (
  id bigserial primary key,
  canal text not null,
  tipo text not null,
  -- numero de origem e de destino do evento (so digitos), quando faz sentido
  de text,
  para text,
  autor_id uuid,
  autor_nome text,
  detalhe jsonb not null default '{}'::jsonb,
  criada_em timestamptz not null default now(),
  constraint ck_canal_eventos_tipo check (tipo ~ '^[a-z_]{3,40}$')
);

create index if not exists ix_canal_eventos_canal on mensageria.canal_eventos (canal, criada_em desc);

comment on table mensageria.canal_eventos is
  'Trilha append-only do canal: conexao, desconexao, troca de numero (de/para/quem/quando), sync de templates.';

-- ──────────────────────────────── catalogo de templates (86ak858pa)
--
-- ESPELHO LOCAL do que o provedor tem. Ele NAO e a fonte da verdade — quem
-- aprova e a Meta, do lado de fora — e existe por dois motivos concretos:
--
--   1. BARRAR ANTES. O criterio do card e "envio com template nao aprovado e
--      recusado com mensagem compreensivel". Sem espelho, a unica forma de
--      saber o status seria uma chamada ao provedor a cada envio; e a recusa
--      chegaria como codigo da Meta, gastando chamada e (em template
--      recusado/pausado) arranhando a nota de qualidade do numero.
--   2. SEM CUSTO POR DESCUIDO. A sincronizacao e SO por gesto explicito (botao
--      "Sincronizar"), decisao desta frente: nada de cron, nada de sync no
--      polling da tela. Chamada a provedor que roda sozinha e a coisa que
--      aparece na fatura sem ninguem ter pedido.
--
-- PK (canal, nome, idioma): a aprovacao e por NUMERO REMETENTE, entao o MESMO
-- nome de template pode existir aprovado num canal e recusado no outro — e
-- misturar os dois e mandar o template do numero A pelo numero B, que a Meta
-- recusa. O idioma entra na chave porque o WhatsApp trata `nome@pt_BR` e
-- `nome@en_US` como templates distintos.
--
-- `provider_id` e o que vai no ENVIO (o nome nao serve pra enviar; serve pra
-- apagar). `sincronizado_em` e a idade do espelho: a tela mostra isso, porque
-- catalogo velho sem aviso e o mesmo defeito do QR expirado sem aviso.
create table if not exists mensageria.canal_templates (
  canal text not null,
  nome text not null,
  idioma text not null default 'pt_BR',
  provider_id text,
  categoria text,
  -- vocabulario do painel, nao o cru da Meta: aprovado | em_analise | recusado |
  -- pausado | desconhecido (statusCanonico em lib/templates-oficial.ts).
  -- `desconhecido` NAO envia — status novo da Meta nao pode virar "aprovado" por
  -- descuido de mapeamento.
  status text not null default 'desconhecido',
  -- corpo LIMPO (sem rodape e sem a especificacao de botoes): vem de
  -- containerMeta.data, nunca do campo `data` do topo da resposta do Gupshup.
  corpo text not null default '',
  exemplo text not null default '',
  rodape text not null default '',
  -- "IMAGE" quando o template tem cabecalho de imagem; `midia_url` e a arte
  -- aprovada, OBRIGATORIA no envio (sem ela a Meta dropa a entrega em silencio).
  cabecalho text not null default '',
  midia_url text not null default '',
  variaveis integer not null default 0,
  motivo text not null default '',
  sincronizado_em timestamptz not null default now(),
  primary key (canal, nome, idioma),
  constraint ck_canal_templates_status
    check (status in ('aprovado', 'em_analise', 'recusado', 'pausado', 'desconhecido')),
  constraint ck_canal_templates_nome check (nome ~ '^[a-z0-9_]{1,512}$'),
  constraint ck_canal_templates_variaveis check (variaveis >= 0 and variaveis <= 50)
);

create index if not exists ix_canal_templates_canal on mensageria.canal_templates (canal, status);

comment on table mensageria.canal_templates is
  'Espelho local dos templates aprovados por canal (API Oficial). Fonte da verdade e o provedor; sincronizacao so por gesto explicito.';

-- ═════════════════════════════════════════════ 4. RLS, grants e reload
--
-- ESTA SECAO FALTAVA, e a falta era GRAVE em duas frentes (achado de revisao
-- cega, 31/08/2026). Ela e a convencao da casa (0013, 0017, 0019) e cada linha
-- abaixo conserta um jeito diferente da feature nascer quebrada:
--
--   SEM `notify pgrst` A FEATURE NASCE MORTA. O PostgREST cacheia o schema: a
--   tabela existe no Postgres e ele segue respondendo PGRST205 ("tabela fora do
--   schema cache") ate reiniciar ou receber o notify. E o pior: o painel LE esse
--   erro como "a migration nao rodou" (`erroDeSchemaAusente`), entao a troca de
--   numero e o catalogo de template ficariam desligados COM AVISO — o admin roda
--   a migration, ve "sucesso" no SQL Editor, e a tela continua dizendo que a
--   0023 nao rodou. Todas as migrations do repo terminam com esta linha; esta
--   era a UNICA sem ela.
--
--   SEM GRANT A ROTA DEVOLVE 500. Tabela nova no schema nasce sem grant e o
--   service_role bate em "permission denied" — gotcha ja escrito no cabecalho da
--   0017. A 0001 aplicou `alter default privileges ... grant all on tables to
--   service_role`, o que cobre tabela criada DEPOIS; o grant explicito aqui e
--   cinto, e e o que deixa o `revoke` seguinte ter algo pra revogar.
--
--   SEM RLS A ANON KEY LE A TABELA. As tres tabelas guardam numero de telefone
--   da empresa, quem trocou o chip e o corpo dos templates. RLS ligada com ZERO
--   policy + acesso so pelo service_role e a convencao da casa: o painel fala
--   com o banco pela service key no servidor, e nenhuma tela tem chave anon
--   apontada pro schema mensageria.
alter table mensageria.canal_estado    enable row level security;
alter table mensageria.canal_eventos   enable row level security;
alter table mensageria.canal_templates enable row level security;

grant select, insert, update, delete on mensageria.canal_estado    to service_role;
grant select, insert                 on mensageria.canal_eventos   to service_role;
grant select, insert, update, delete on mensageria.canal_templates to service_role;
grant usage, select on sequence mensageria.canal_eventos_id_seq to service_role;

-- ─────────────────────────────── a trilha e APPEND-ONLY *NO BANCO*
--
-- Ate a revisao, "append-only" era so uma frase de comentario — e o repo JA
-- PAGOU ESTE EXATO ACHADO na 0017 (`conversa_status_eventos`,
-- `conversa_responsavel_eventos`) e na 0016 (`conversa_funil_eventos`). Trilha
-- que o proprio codigo pode reescrever nao e trilha: um bug (ou um script de
-- "limpeza") apaga a linha que diz de qual numero pra qual o canal foi trocado,
-- e ninguem mais consegue reconstruir a historia do chip.
--
-- O `revoke` e o que transforma a promessa em garantia. Ele NAO tira nada que o
-- codigo use: `lib/canais-db.ts` so faz `insert` e `select` em canal_eventos.
-- Tentativa de update/delete passa a estourar no banco — que e o aviso que a
-- gente quer, e nao um apagamento silencioso.
--
-- Nota de mecanica (mesma da 0017): `grant select, insert` NAO revoga o resto,
-- porque a 0001 deu `all on tables` por default privilege. Por isso o revoke
-- explicito e obrigatorio, e vem DEPOIS do grant.
revoke update, delete on mensageria.canal_eventos from service_role;
revoke update, delete on mensageria.canal_eventos from public, anon, authenticated;

notify pgrst, 'reload schema';
