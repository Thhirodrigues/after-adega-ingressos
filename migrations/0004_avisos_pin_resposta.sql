-- Avisos ao admin, desfazer entrada, resposta secreta e aceite das regras.
ALTER TABLE ingressos ADD COLUMN desfeitos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN resposta_hash TEXT;
ALTER TABLE pedidos ADD COLUMN aceite_termos_em INTEGER;
ALTER TABLE pedidos ADD COLUMN termos_versao TEXT;

CREATE TABLE alertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  detalhe TEXT NOT NULL DEFAULT '',
  criado_em INTEGER NOT NULL,
  lido_em INTEGER
);
CREATE INDEX idx_alertas_lido ON alertas (lido_em, id);

CREATE TABLE push_assinaturas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios (id),
  endpoint TEXT NOT NULL UNIQUE,
  criado_em INTEGER NOT NULL
);
