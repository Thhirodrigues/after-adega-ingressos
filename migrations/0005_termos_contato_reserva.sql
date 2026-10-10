-- Aceite dos termos no cadastro, contato da organização e reserva de 20 minutos.
ALTER TABLE usuarios ADD COLUMN aceite_termos_em INTEGER;
ALTER TABLE usuarios ADD COLUMN termos_versao TEXT;
INSERT OR IGNORE INTO config (chave, valor) VALUES ('contato', '');
INSERT INTO config (chave, valor) VALUES ('reserva_minutos', '20')
  ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor;
