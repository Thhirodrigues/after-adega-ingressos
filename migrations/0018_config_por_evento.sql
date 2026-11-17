-- Configurações do evento (Pix, taxa, reserva, máximo por pedido, prazo de transferência, contato e flyer)
-- passam a ser de cada evento. Ficam no app (tabela config): senha de desbloqueio da recepção e chaves do push.
-- Evento novo copia as configurações do evento mais recente (o admin só ajusta o que mudou).
CREATE TABLE config_evento (
  evento_id INTEGER NOT NULL REFERENCES eventos (id),
  chave TEXT NOT NULL,
  valor TEXT NOT NULL,
  PRIMARY KEY (evento_id, chave)
);

-- Eventos que já existem herdam os valores atuais.
INSERT INTO config_evento (evento_id, chave, valor)
SELECT e.id, c.chave, c.valor FROM eventos e CROSS JOIN config c
 WHERE c.chave IN ('pix_chave', 'pix_nome', 'pix_cidade', 'taxa_percentual', 'reserva_minutos', 'max_ingressos_por_pedido',
                   'transferencia_limite_horas', 'contato', 'contato_whatsapp');

-- Flyer: cada evento passa a ter o seu ('flyer:<id>'); os existentes recebem o flyer atual.
INSERT INTO arquivos (nome, tipo, dados, atualizado_em)
SELECT 'flyer:' || e.id, a.tipo, a.dados, a.atualizado_em FROM eventos e CROSS JOIN arquivos a WHERE a.nome = 'flyer';

-- Auditoria: alteração de configuração agora pertence ao evento; as antigas ficam na geral.
