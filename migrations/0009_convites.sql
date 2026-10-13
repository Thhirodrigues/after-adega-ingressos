-- Convites de cortesia nominais (DJ, aniversariante, amigo/parceiro).
-- O admin cadastra a pessoa; o ingresso (com QR) só nasce quando ela se cadastra/entra no app
-- com o telefone (ou e-mail) informado. Convite pendente não vence.
CREATE TABLE convites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evento_id INTEGER NOT NULL REFERENCES eventos (id),
  categoria TEXT NOT NULL CHECK (categoria IN ('dj', 'aniversariante', 'convidado')),
  nome TEXT NOT NULL,
  telefone TEXT NOT NULL,                     -- só dígitos, com DDI 55
  email TEXT,                                 -- opcional, minúsculas
  nascimento TEXT,                            -- AAAA-MM-DD (só aniversariante)
  quantidade INTEGER NOT NULL DEFAULT 1 CHECK (quantidade BETWEEN 1 AND 4),
  token TEXT NOT NULL UNIQUE,                 -- vai no link enviado pelo WhatsApp
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'resgatado', 'cancelado')),
  usuario_id INTEGER REFERENCES usuarios (id),
  criado_por INTEGER NOT NULL REFERENCES usuarios (id),
  criado_em INTEGER NOT NULL,
  resgatado_em INTEGER
);
CREATE INDEX idx_convites_status_tel ON convites (status, telefone);
CREATE INDEX idx_convites_evento ON convites (evento_id, status);

ALTER TABLE ingressos ADD COLUMN convite_id INTEGER REFERENCES convites (id);
ALTER TABLE ingressos ADD COLUMN categoria TEXT;
