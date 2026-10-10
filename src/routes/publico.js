import { Hono } from 'hono';
import { agora, configuracoes } from '../lib/http.js';
import { calcularValores } from '../lib/pedidos.js';
import { TERMOS_VERSAO } from '../lib/termos.js';

const r = new Hono();

// Página do evento: dados da festa e lotes com o que ainda está disponível.
// Reservas vencidas já não contam (o cálculo ignora pedidos expirados sem precisar gravar).
r.get('/evento', async (c) => {
  const db = c.env.DB;
  const evento = await db
    .prepare(`SELECT id, nome, data_evento, local, descricao FROM eventos WHERE ativo = 1 ORDER BY data_evento LIMIT 1`)
    .first();
  if (!evento) return c.json({ evento: null, lotes: [] });

  const cfg = await configuracoes(db);
  const pct = Number(cfg.taxa_percentual);
  const { results } = await db
    .prepare(
      `SELECT l.id, l.nome, l.valor_centavos, l.ativo,
              (l.quantidade - l.vendidos - l.reservados
                + COALESCE((SELECT SUM(p.quantidade) FROM pedidos p
                             WHERE p.lote_id = l.id AND p.status = 'aguardando_pagamento'
                               AND p.reserva_ativa = 1 AND p.expira_em < ?2), 0)) AS disponiveis
         FROM lotes l WHERE l.evento_id = ?1 AND l.ativo = 1 AND l.canal <> 'porta' ORDER BY l.ordem, l.id`,
    )
    .bind(evento.id, agora())
    .all();

  let atualMarcado = false;
  const maxPedido = Number(cfg.max_ingressos_por_pedido);
  const lotes = results.map((l) => {
    const ehAtual = !atualMarcado && l.disponiveis > 0;
    if (ehAtual) atualMarcado = true;
    const { taxa, total } = calcularValores(l.valor_centavos, 1, pct);
    return {
      id: l.id,
      nome: l.nome,
      valor_centavos: l.valor_centavos,
      taxa_centavos: taxa,
      total_centavos: total,
      // Não revela o estoque real: limita ao máximo por pedido (só serve para o seletor de quantidade).
      disponiveis: Math.min(l.disponiveis, maxPedido),
      esgotado: l.disponiveis <= 0,
      atual: ehAtual,
    };
  });

  return c.json({
    evento,
    taxa_percentual: pct,
    max_ingressos_por_pedido: Number(cfg.max_ingressos_por_pedido),
    reserva_minutos: Number(cfg.reserva_minutos),
    pagamento_automatico: !!c.env.MP_ACCESS_TOKEN,
    lotes,
  });
});

// Contato da organização e versão dos termos (páginas legais). Público.
r.get('/contato', async (c) => {
  const cfg = await configuracoes(c.env.DB);
  return c.json({ contato: cfg.contato || '', termos_versao: TERMOS_VERSAO });
});

export default r;
