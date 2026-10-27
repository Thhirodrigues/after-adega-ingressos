-- Cada registro de auditoria pertence a um evento (o da ação, ou o ativo na hora, nas ações gerais).
ALTER TABLE auditoria ADD COLUMN evento_id INTEGER;
-- Registros antigos: ficam com o evento ativo (ou o mais recente, se não houver ativo).
UPDATE auditoria SET evento_id = COALESCE(
  (SELECT id FROM eventos WHERE ativo = 1 ORDER BY data_evento LIMIT 1),
  (SELECT id FROM eventos ORDER BY data_evento DESC LIMIT 1));
CREATE INDEX idx_auditoria_evento ON auditoria (evento_id, id);
