-- Evento excluído: some de todas as telas, mas o registro (e pedidos/ingressos) continua no banco.
ALTER TABLE eventos ADD COLUMN excluido_em INTEGER;
