import { Hono } from 'hono';
import { HttpError, auditar } from '../lib/http.js';
import { exigir } from '../lib/auth.js';
import { alertar } from '../lib/alertas.js';
import { assinaturaValida, buscarPagamento, criarPreferencia, mpAtivo } from '../lib/mp.js';
import { buscarPedido, confirmarPedido, estornarPago, liberarExpirados } from '../lib/pedidos.js';

const r = new Hono();
const reais = (n) => (n / 100).toFixed(2).replace('.', ',');

// O comprador pede o link de pagamento (Pix ou cartão) do próprio pedido.
r.post('/pedidos/:codigo/pagar-mp', exigir(), async (c) => {
  if (!mpAtivo(c.env)) throw new HttpError(503, 'Pagamento automático indisponível. Use o Pix com a chave.');
  const u = c.get('usuario');
  const db = c.env.DB;
  const b = await c.req.json().catch(() => ({}));
  const metodo = ['cartao', 'pix'].includes(b?.metodo) ? b.metodo : null;
  await liberarExpirados(db);
  const pedido = await buscarPedido(db, { codigo: c.req.param('codigo').toUpperCase() });
  if (!pedido || pedido.comprador_id !== u.id) throw new HttpError(404, 'Pedido não encontrado.');
  if (pedido.status !== 'aguardando_pagamento') throw new HttpError(409, 'Este pedido não está aguardando pagamento.');
  let pref;
  try {
    pref = await criarPreferencia(c.env, { origem: new URL(c.req.url).origin, pedido, metodo });
  } catch (e) {
    if (e.mpDetalhe) await alertar(c, 'mp_erro', `Falha ao criar link do Mercado Pago (pedido ${pedido.codigo}, ${metodo || 'todos'}): ${e.mpDetalhe}`).catch(() => {});
    throw e;
  }
  return c.json({ url: pref.url });
});

// Aviso do Mercado Pago. Nunca confiamos no corpo: sempre re-consultamos o pagamento na API.
r.post('/mp/webhook', async (c) => {
  if (!mpAtivo(c.env)) return c.json({ ok: true });
  const q = c.req.query();
  let corpo = {};
  try { corpo = await c.req.json(); } catch {}
  const tipo = q.type || q.topic || corpo.type || corpo.topic;
  const dataId = q['data.id'] || q.id || corpo?.data?.id;
  if (!(await assinaturaValida(c.env, { assinatura: c.req.header('x-signature'), requestId: c.req.header('x-request-id'), dataId }))) {
    throw new HttpError(401, 'Assinatura inválida.');
  }
  if (tipo !== 'payment' || !dataId || !/^\d{1,20}$/.test(String(dataId))) return c.json({ ok: true });

  const db = c.env.DB;
  const pg = await buscarPagamento(c.env, dataId); // erro => 5xx => o MP tenta de novo
  const codigo = String(pg.external_reference || '').toUpperCase();
  const pedido = codigo ? await buscarPedido(db, { codigo }) : null;
  if (!pedido) return c.json({ ok: true });

  if (['refunded', 'charged_back'].includes(pg.status)) {
    if (String(pedido.mp_payment_id) !== String(pg.id)) return c.json({ ok: true });
    if (pg.status === 'refunded') {
      // Reembolso total feito no Mercado Pago: cancela o pedido e invalida os ingressos (a menos que algum já tenha entrado).
      if (pedido.status === 'pago') {
        await estornarPago(db, pedido.id);
        const depois = await buscarPedido(db, { id: pedido.id });
        if (depois.status === 'cancelado') {
          await auditar(db, null, 'pedido_estornado_mp', codigo);
          await alertar(c, 'mp_estorno', `Pedido ${codigo} reembolsado no Mercado Pago: pedido cancelado e ingressos invalidados automaticamente.`);
        } else {
          await alertar(c, 'mp_estorno', `ATENÇÃO: pedido ${codigo} foi reembolsado no Mercado Pago, mas algum ingresso já foi usado na portaria, então NÃO foi cancelado. Veja o pedido.`);
        }
      }
    } else {
      await alertar(c, 'mp_estorno', `ATENÇÃO: pedido ${codigo} teve chargeback (contestação) no Mercado Pago. Decida se cancela o pedido em Admin → Pedidos.`);
    }
    return c.json({ ok: true });
  }
  if (pg.status !== 'approved') return c.json({ ok: true });

  if (pg.currency_id !== 'BRL' || Math.round(Number(pg.transaction_amount) * 100) !== pedido.total_centavos) {
    await alertar(c, 'mp_valor_diferente', `Pedido ${codigo}: pagamento ${pg.id} aprovado com valor diferente (R$ ${pg.transaction_amount}, esperado R$ ${reais(pedido.total_centavos)}). Não foi confirmado.`);
    return c.json({ ok: true });
  }
  if (pedido.status === 'pago') return c.json({ ok: true });

  // Registra o id do pagamento (índice único: o mesmo pagamento não confirma dois pedidos).
  try {
    await db.prepare('UPDATE pedidos SET mp_payment_id = ?2 WHERE id = ?1 AND mp_payment_id IS NULL').bind(pedido.id, String(pg.id)).run();
  } catch {
    return c.json({ ok: true });
  }
  await confirmarPedido(db, pedido.id, null, 'mercadopago');
  const depois = await buscarPedido(db, { id: pedido.id });
  if (depois.status === 'pago') {
    await auditar(db, null, 'pedido_confirmado_mp', `${codigo} pagamento ${pg.id}`);
    await alertar(c, 'pedido_pago_mp', `Pedido ${codigo} pago e confirmado automaticamente (Mercado Pago, R$ ${reais(pedido.total_centavos)}).`);
  } else {
    await alertar(c, 'mp_sem_estoque', `ATENÇÃO: pedido ${codigo} foi pago no Mercado Pago (R$ ${reais(pedido.total_centavos)}) mas a reserva venceu e não há mais ingressos. Devolva o valor no painel do Mercado Pago.`);
  }
  return c.json({ ok: true });
});

export default r;
