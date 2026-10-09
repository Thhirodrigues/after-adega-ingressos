-- Portaria (leitura de QR), transferência de ingressos e cortesias.
-- qr_versao muda a cada transferência: o QR antigo deixa de valer.
ALTER TABLE ingressos ADD COLUMN qr_versao INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingressos ADD COLUMN motivo TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_ingressos_evento_status ON ingressos (evento_id, status);

CREATE TABLE transferencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  ingresso_id INTEGER NOT NULL REFERENCES ingressos (id),
  de_usuario_id INTEGER NOT NULL REFERENCES usuarios (id),
  para_usuario_id INTEGER REFERENCES usuarios (id),
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aceita', 'cancelada')),
  criado_em INTEGER NOT NULL,
  expira_em INTEGER NOT NULL,
  aceita_em INTEGER
);
CREATE INDEX idx_transferencias_ingresso ON transferencias (ingresso_id, status);
