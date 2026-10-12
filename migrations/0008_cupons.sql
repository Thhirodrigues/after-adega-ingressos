-- Cupons de desconto (palavra-chave cadastrada pelo admin) e método de pagamento do Mercado Pago.
-- tipo: 'sem_taxa' (zera a taxa de serviço), 'percentual' (desconto % no valor dos ingressos)
--       e 'vip' (100% de desconto: pedido já nasce pago e os ingressos saem como cortesia).
CREATE TABLE cupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evento_id INTEGER NOT NULL REFERENCES eventos (id),
  codigo TEXT NOT NULL,                       -- normalizado: MAIÚSCULAS, sem acento nem espaço
  tipo TEXT NOT NULL CHECK (tipo IN ('sem_taxa', 'percentual', 'vip')),
  percentual INTEGER NOT NULL DEFAULT 0 CHECK (percentual BETWEEN 0 AND 100),
  limite INTEGER CHECK (limite IS NULL OR limite >= 0),  -- máx. de ingressos com este cupom; NULL = sem limite
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_cupons_codigo ON cupons (evento_id, codigo);

ALTER TABLE pedidos ADD COLUMN cupom_id INTEGER REFERENCES cupons (id);
ALTER TABLE pedidos ADD COLUMN cupom_codigo TEXT;
ALTER TABLE pedidos ADD COLUMN desconto_centavos INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_pedidos_cupom ON pedidos (cupom_id);

-- payment_type_id do Mercado Pago ('credit_card', 'debit_card', 'bank_transfer' = Pix, ...).
ALTER TABLE pedidos ADD COLUMN mp_tipo TEXT;
