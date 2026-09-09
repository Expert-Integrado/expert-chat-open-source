-- 0011_perfil_preferencias.sql
-- Frente G (31/08/2026): tela "Meu perfil" — foto do atendente e preferencias de aviso.
--
-- Duas colunas em mensageria.perfis, nada de tabela nova:
--   foto_url     = URL PUBLICA da foto do atendente (bucket `fotos-perfil`, prefixo `usuarios/`)
--   preferencias = jsonb com as preferencias proprias do usuario (hoje: som e desktop)
--
-- ATENCAO: este arquivo NAO e executado por codigo nenhum. Rodar a migration e
-- gesto humano no SQL Editor do Supabase da instalacao (mesma convencao de 0007/0008).
-- Idempotente: pode rodar de novo sem estragar nada.
--
-- Enquanto NAO rodar, o painel continua de pe: /api/perfil devolve as preferencias
-- padrao com `perfil_conta_disponivel: false` (nunca 500) e a tela mostra o aviso
-- de que falta rodar a migration. Foto e preferencia respondem 503 com a mesma
-- mensagem em vez de fingir que salvaram.

alter table mensageria.perfis
  add column if not exists foto_url text;

alter table mensageria.perfis
  add column if not exists preferencias jsonb not null default '{}'::jsonb;

comment on column mensageria.perfis.foto_url is
  'Foto do atendente (URL publica do bucket fotos-perfil, prefixo usuarios/). NULL = mostra as iniciais.';
comment on column mensageria.perfis.preferencias is
  'Preferencias proprias do usuario (jsonb). Chaves de hoje: som (bip do sininho), desktop (aviso do navegador). Chave desconhecida e ignorada pelo codigo.';

-- Gotcha do repo (CLAUDE.md): coluna nova nao precisa de grant, mas o PostgREST
-- so enxerga o schema novo depois do reload.
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- BUCKET: a foto do atendente reusa o bucket PUBLICO `fotos-perfil`, o mesmo da
-- foto de contato do WhatsApp (lib/foto-store.ts, prefixo `central/`). Se a
-- instalacao ainda nao tem esse bucket, criar UMA vez — tambem gesto humano:
--
--   insert into storage.buckets (id, name, public)
--   values ('fotos-perfil', 'fotos-perfil', true)
--   on conflict (id) do nothing;
--
-- O upload sai do servidor com a service key (rota /api/perfil/foto), entao nao
-- e preciso policy de storage pra usuario anonimo — e nao se deve criar uma:
-- bucket publico com escrita aberta vira deposito de arquivo de terceiro.
