-- 0006_status_autor.sql
-- Card i47kayweds89. Fecha no painel a MESMA classe de buraco de auditoria
-- achada no whatsapp-agent: mutacao de estado de conversa sem autor.
--
-- O defeito, lido no codigo em 19/08/2026: POST /api/conversa ja resolve o
-- usuario logado na primeira linha do handler (getUser(req)) — o autor esta na
-- mao — e o patch de status grava status/updated_at/arquivada e DESCARTA quem
-- fez. O repo ja mantem trilha de autor no ENVIO (mensagens.enviado_por_id/
-- _nome, 0001); faltava no ENCERRAMENTO.
--
-- Por que aqui doi mais que no WhatsApp: la quem conclui e o dono; aqui quem
-- conclui e o TIME. Sem estas colunas nao ha como saber qual atendente encerrou
-- a conversa de um cliente — nem pra cobrar, nem pra defender o atendente.
--
-- Guarda a autoria de QUALQUER troca de status (concluir e reabrir), nao so do
-- 'concluido': reabrir sem rastro tem o mesmo problema, e uma coluna
-- 'concluida_por' pediria uma segunda no dia em que alguem perguntasse quem
-- reabriu.

alter table mensageria.conversas
  add column if not exists status_alterado_por_id   uuid,
  add column if not exists status_alterado_por_nome text,
  add column if not exists status_alterado_em       timestamp with time zone;

alter table mensageria.conversas_apioficial
  add column if not exists status_alterado_por_id   uuid,
  add column if not exists status_alterado_por_nome text,
  add column if not exists status_alterado_em       timestamp with time zone;

comment on column mensageria.conversas.status_alterado_por_id is
  'Usuario que fez a ultima troca de status (concluir/reabrir). NULL com _nome preenchido = automacao; ambos NULL = linha anterior a 0006.';
comment on column mensageria.conversas.status_alterado_por_nome is
  'Nome do autor no momento da troca — congelado, nao segue rename de usuario.';
comment on column mensageria.conversas.status_alterado_em is
  'Quando a ultima troca de status aconteceu (distinto de updated_at, que qualquer patch mexe).';

-- A pergunta de auditoria e "o que foi concluido nesta janela, e por quem".
create index if not exists idx_conversas_status_alterado
  on mensageria.conversas (status_alterado_em desc, status_alterado_por_id)
  where status_alterado_em is not null;

create index if not exists idx_conversas_apioficial_status_alterado
  on mensageria.conversas_apioficial (status_alterado_em desc, status_alterado_por_id)
  where status_alterado_em is not null;
