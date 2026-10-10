-- Venda presencial (dinheiro / Pix na porta) e lotes por canal.
ALTER TABLE lotes ADD COLUMN canal TEXT NOT NULL DEFAULT 'todos' CHECK (canal IN ('todos', 'online', 'porta'));
ALTER TABLE pedidos ADD COLUMN canal TEXT NOT NULL DEFAULT 'online' CHECK (canal IN ('online', 'porta'));
ALTER TABLE pedidos ADD COLUMN vendedor_id INTEGER REFERENCES usuarios (id);
ALTER TABLE ingressos ADD COLUMN nome_avulso TEXT; -- nome do convidado em venda presencial (sem conta)
