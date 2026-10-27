-- Término do evento (data e horário). O evento só deixa de aparecer para quem não é admin depois dele.
ALTER TABLE eventos ADD COLUMN data_fim TEXT;
ALTER TABLE eventos ADD COLUMN hora_fim TEXT NOT NULL DEFAULT '06:00';
-- Eventos que já existiam mantêm a regra antiga: encerram às 12h do dia seguinte.
UPDATE eventos SET data_fim = date(data_evento, '+1 day'), hora_fim = '12:00';
