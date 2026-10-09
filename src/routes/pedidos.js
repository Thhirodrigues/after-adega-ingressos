import { Hono } from 'hono';
import { HttpError, agora, auditar, configuracoes, corpo } from '../lib/http.js';
import { limiteTransferencia } from '../lib/prazo.js';
import { exigir } from '../lib/auth.js';
import { qrDoIngresso } from '../lib/crypto.js';
import * as v from '../lib/validar.js';
import { buscarPedido, cancelarNaoPago, criarPedido, visaoPedido } from '../lib/pedidos.js';

const r = new Hono();

// Cria o pedido: segura os ingressos (reserva) e devolve o Pix para pagar.
r.post('/pedidos', exigir(), async (c) => {
  const b = await corpo(c);
  const loteId = v.inteiro(b.lote_id, 'Lote', 1, 1_000_000_000);
  const quantidade = v.inteiro(b.quantidade, 'Quantidade', 1, 100);
  const nomePagador = v.texto(b.nome_pagador, 'Nome do pagador', 3, 80);
  const usuario = c.get('usuario');
  const codigo = await criarPedido(c.env, usuario, { loteId, quantidade, nomePagador });
  const pedido = await buscarPedido(c.env.DB, { codigo });
  await auditar(c.env.DB, usuario.id, 'pedido_criado', codigo);
  return c.json(await visaoPedido(c.env.DB, pedido), 201);
});

r.get('/pedidos/:codigo', exigir(), async (c) => {
  const usuario = c.get('usuario');
  const pedido = await buscarPedido(c.env.DB, { codigo: c.req.param('codigo').toUpperCase() });
  if (!pedido || (pedido.comprador_id !== usuario.id && usuario.papel !== 'admin')) {
    throw new HttpError(404, 'Pedido não encontrado.');
  }
  return c.json(await visaoPedido(c.env.DB, pedido));
});

r.post('/pedidos/:codigo/cancelar', exigir(), async (c) => {
  const usuario = c.get('usuario');
  const db = c.env.DB;
  const pedido = await buscarPedido(db, { codigo: c.req.param('codigo').toUpperCase() });
  if (!pedido || pedido.comprador_id !== usuario.id) throw new HttpError(404, 'Pedido não encontrado.');
  if (pedido.status === 'pago') {
    throw new HttpError(409, 'Pedido já pago. Para cancelar, fale com a organização.');
  }
  await cancelarNaoPago(db, pedido.id);
  await auditar(db, usuario.id, 'pedido_cancelado_comprador', pedido.codigo);
  return c.json(await visaoPedido(db, await buscarPedido(db, { id: pedido.id })));
});

r.get('/meus-pedidos', exigir(), async (c) => {
  const db = c.env.DB;
  const { results } = await db
    .prepare(`SELECT id FROM pedidos WHERE comprador_id = ?1 ORDER BY id DESC LIMIT 50`)
    .bind(c.get('usuario').id)
    .all();
  const pedidos = [];
  for (const { id } of results) pedidos.push(await visaoPedido(db, await buscarPedido(db, { id })));
  return c.json({ pedidos });
});

// Ingressos do usuário, com o QR (só para os ainda válidos).
r.get('/meus-ingressos', exigir(), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.tipo, i.status, i.qr_versao, i.motivo, e.nome AS evento, e.data_evento, e.hora_inicio, l.nome AS lote,
            EXISTS (SELECT 1 FROM transferencias t WHERE t.ingresso_id = i.id AND t.status = 'pendente' AND t.expira_em > ?2) AS transferencia_pendente
       FROM ingressos i
       JOIN eventos e ON e.id = i.evento_id
       LEFT JOIN lotes l ON l.id = i.lote_id
      WHERE i.dono_id = ?1 ORDER BY i.id`,
  )
    .bind(c.get('usuario').id, agora())
    .all();
  const cfg = await configuracoes(c.env.DB);
  const ingressos = [];
  for (const { qr_versao, hora_inicio, ...i } of results) {
    ingressos.push({
      ...i,
      transferivel_ate: limiteTransferencia(i.data_evento, hora_inicio, cfg.transferencia_limite_horas),
      transferencia_pendente: !!i.transferencia_pendente,
      qr: i.status === 'valido' ? await qrDoIngresso(c.env, i.id, qr_versao) : null,
    });
  }
  return c.json({ ingressos });
});

export default r;
