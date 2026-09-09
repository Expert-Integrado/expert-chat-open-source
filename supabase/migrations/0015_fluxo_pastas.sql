-- 0015_fluxo_pastas.sql
-- P5 (Frente K, 31/08/2026): organizacao e autoria do editor de fluxos.
--
-- Acrescenta a `mensageria.fluxos` (criada na 0008) o minimo que a gestao de
-- fluxos precisa e que NAO cabe dentro do jsonb canonico:
--   pasta               = caminho da pasta ("CRM / Educacional")
--   atualizado_por_id   = quem gravou por ultimo (a 0008 so tem quem CRIOU)
--   atualizado_por_nome
--
-- ATENCAO: este arquivo NAO e executado por codigo nenhum. Rodar a migration e
-- gesto humano no SQL Editor do Supabase da instalacao (mesma convencao da
-- 0007/0008/0009). Idempotente: pode rodar de novo sem estragar nada.
--
-- Ate rodar, `/api/fluxos` continua respondendo — a rota detecta a coluna
-- ausente (PostgREST 42703), refaz a leitura sem ela e devolve
-- `pastas_disponiveis: false`. Pasta some da tela; fluxo nenhum some.

-- ------------------------------------------------------------------ pasta
-- POR QUE COLUNA, e nao um campo dentro do jsonb `fluxo`:
-- `validarFluxo` (lib/fluxo/schema.ts) normaliza o fluxo campo a campo e
-- devolve um objeto so com o que o formato canonico conhece. Pasta gravada
-- dentro do jsonb seria descartada em SILENCIO no primeiro save — o fluxo
-- voltaria pra raiz sozinho e ninguem entenderia por que.
--
-- POR QUE CAMINHO EM TEXTO, e nao tabela de pastas com id:
--   1. medido no card 86ak85a5e: a hierarquia ja existe DENTRO do nome do grupo
--      de origem ("CRM | Educacional", "Campanhas | Disparo simples") porque a
--      ferramenta anterior so tem um nivel. Caminho em texto absorve isso na
--      importacao sem tabela nova;
--   2. criterio de aceite: mover fluxo entre pastas nao pode mudar
--      comportamento nem quebrar quem chama o fluxo. Sem id de pasta e com o
--      caminho fora do jsonb, mover e trocar uma string de metadado.
-- Renomear/mover pasta = reescrever o prefixo de segmentos das filhas
-- (lib/fluxo/editor.ts: moverPasta), sempre por SEGMENTO — nunca por prefixo
-- de texto, senao "Vendas" arrastaria "Vendas B2B" junto.
--
-- NULL e "" significam a mesma coisa (raiz). A rota normaliza pra "" antes de
-- gravar; o default abaixo cobre quem inserir por SQL direto.
alter table mensageria.fluxos add column if not exists pasta text not null default '';

-- Listagem e navegacao filtram por pasta e ordenam por nome.
create index if not exists idx_fluxos_pasta on mensageria.fluxos (pasta, nome);

-- Busca por PREFIXO de caminho (abrir uma pasta = trazer a subarvore inteira).
-- `text_pattern_ops` e o que faz o `like 'CRM / %'` usar indice numa instalacao
-- com collation nao-C.
create index if not exists idx_fluxos_pasta_prefixo on mensageria.fluxos (pasta text_pattern_ops);

-- --------------------------------------------------------------- autoria
-- A 0008 guarda so quem CRIOU. Criterio de aceite da edicao rapida (86ak85nzy):
-- "toda edicao rapida respeita a permissao do usuario e grava quem alterou".
-- Sem estas duas colunas, renomear um fluxo na listagem nao deixa rastro.
alter table mensageria.fluxos add column if not exists atualizado_por_id uuid;
alter table mensageria.fluxos add column if not exists atualizado_por_nome text;

-- Grant explicito pelo mesmo motivo da 0008 (coluna nova nao muda grant, mas
-- manter a linha torna a migration segura de rodar em instalacao com outro dono).
grant all on mensageria.fluxos to service_role;

-- Depois de rodar, se a rota continuar dizendo que a pasta nao existe:
--   notify pgrst, 'reload schema';
