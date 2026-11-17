-- Avisos e auditoria por evento.
-- Cada aviso (alerta) passa a pertencer a um evento; NULL = aviso geral (conta, senha, pagamento do
-- Mercado Pago sem pedido correspondente). Na auditoria, NULL = ação geral (usuários, permissões,
-- configurações, evento excluído). Nada é apagado: evento novo só "começa vazio" porque a tela filtra.

ALTER TABLE alertas ADD COLUMN evento_id INTEGER;
CREATE INDEX idx_alertas_evento ON alertas (evento_id, id);

-- Avisos antigos que citam um pedido herdam o evento dele ("Pedido X", "Novo pedido X", "pedido X").
UPDATE alertas SET evento_id = (
  SELECT p.evento_id FROM pedidos p WHERE instr(alertas.detalhe, 'edido ' || p.codigo) > 0 LIMIT 1
);

-- Avisos antigos de lote citam o nome do evento ("... no evento à venda <nome>.").
UPDATE alertas SET evento_id = (
  SELECT e.id FROM eventos e WHERE instr(alertas.detalhe, 'no evento à venda ' || e.nome || '.') > 0 ORDER BY e.id DESC LIMIT 1
)
WHERE evento_id IS NULL AND tipo = 'lote_em_uso';

-- Avisos antigos de portaria/lote (sem pedido no texto): o primeiro evento que ainda não tinha
-- terminado na data do aviso (horário de São Paulo); se não houver, o mais recente.
UPDATE alertas SET evento_id = COALESCE(
  (SELECT e.id FROM eventos e
    WHERE e.excluido_em IS NULL AND COALESCE(e.data_fim, e.data_evento) >= date(alertas.criado_em, 'unixepoch', '-3 hours')
    ORDER BY e.data_evento LIMIT 1),
  (SELECT e.id FROM eventos e WHERE e.excluido_em IS NULL ORDER BY e.data_evento DESC LIMIT 1)
)
WHERE evento_id IS NULL AND tipo IN ('confirmacao_errada', 'entrada_desfeita', 'pin_errado', 'lote_em_uso', 'novo_pedido');

-- Auditoria: ações gerais saem do evento em que tinham sido gravadas (antes iam para o evento ativo).
UPDATE auditoria SET evento_id = NULL
 WHERE acao IN ('setup_admin', 'config_alterada', 'usuario_criado', 'usuario_papel', 'usuario_ativo',
                'senha_provisoria', 'pin_definido', 'flyer_trocado', 'flyer_padrao', 'evento_excluido',
                'resposta_definida', 'senha_recuperada_resposta');
