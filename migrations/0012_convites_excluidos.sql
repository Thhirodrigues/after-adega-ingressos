-- Convite "excluído" some da lista do admin, mas o registro fica (histórico). Os ingressos dele são cancelados.
ALTER TABLE convites ADD COLUMN excluido_em INTEGER;
