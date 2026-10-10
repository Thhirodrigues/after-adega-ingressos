-- Pagamento automático (Mercado Pago Checkout Pro).
ALTER TABLE pedidos ADD COLUMN mp_payment_id TEXT;
CREATE UNIQUE INDEX idx_pedidos_mp_payment ON pedidos (mp_payment_id) WHERE mp_payment_id IS NOT NULL;
