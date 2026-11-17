-- Hostess é escalada para um evento. Quando ele termina (ou é excluído), ela volta a ser usuário comum
-- automaticamente; para a próxima festa o admin escala de novo.
ALTER TABLE usuarios ADD COLUMN hostess_evento_id INTEGER REFERENCES eventos (id);

-- Hostess que já existiam ficam escaladas no evento ativo que ainda não terminou (se houver).
-- Sem evento assim, voltam a ser usuário no primeiro acesso.
UPDATE usuarios SET hostess_evento_id = (
  SELECT e.id FROM eventos e
   WHERE e.ativo = 1 AND e.excluido_em IS NULL
     AND datetime('now', '-3 hours') < COALESCE(e.data_fim, date(e.data_evento, '+1 day')) || ' ' || e.hora_fim || ':00'
   ORDER BY e.data_evento LIMIT 1)
WHERE papel = 'hostess';

-- Auditoria guarda o papel de quem agiu NAQUELE momento: a hostess que volta a ser usuário
-- continua aparecendo como "portaria" nas ações da festa em que trabalhou.
ALTER TABLE auditoria ADD COLUMN papel TEXT;
UPDATE auditoria SET papel = (SELECT u.papel FROM usuarios u WHERE u.id = auditoria.usuario_id) WHERE usuario_id IS NOT NULL;
