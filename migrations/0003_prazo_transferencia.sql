-- Horário de início da festa e prazo final para transferir ingressos (horas antes do início).
ALTER TABLE eventos ADD COLUMN hora_inicio TEXT NOT NULL DEFAULT '22:00';
INSERT OR IGNORE INTO config (chave, valor) VALUES ('transferencia_limite_horas', '48');
