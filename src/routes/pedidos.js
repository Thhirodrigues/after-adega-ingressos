import { Hono } from 'hono';
import { HttpError, agora, auditar, configuracoes, corpo } from '../lib/http.js';
import { limiteTransferencia } from '../lib/prazo.js';
import { exigir } from '../lib/auth.js';
import { qrDoIngresso } from '../lib/crypto.js';
import * as v from '../lib/validar.js';
import { buscarPedido, cancelarNaoPago, concluirPedidoGratis, criarPedido, liberarExpirados, visaoPedido } from '../lib/pedidos.js';
import { alertar, avisarPedidoEmPagamento } from '../lib/alertas.js';
import { TERMOS_VERSAO } from '../lib/termos.js';

const r = new Hono();

// Cria o pedido: segura os ingressos (reserva) e devolve o Pix para pagar.
r.post('/pedidos', exigir(), async (c) => {
  const b = await corpo(c);
  if (b.aceito_termos !== true) throw new HttpError(400, 'Para comprar, leia e aceite as regras do ingresso.');
  const loteId = v.inteiro(b.lote_id, 'Lote', 1, 1_000_000_000);
  const quantidade = v.inteiro(b.quantidade, 'Quantidade', 1, 100);
  const nomePagador = v.texto(b.nome_pagador, 'Nome do pagador', 3, 80);
  const usuario = c.get('usuario');
  // Um pedido em aberto por pessoa: evita segurar estoque sem pagar. Pagar ou cancelar libera.
  await liberarExpirados(c.env.DB);
  const aberto = await c.env.DB.prepare(
    `SELECT codigo FROM pedidos WHERE comprador_id = ?1 AND status = 'aguardando_pagamento' AND expira_em >= ?2 ORDER BY id DESC LIMIT 1`,
  )
    .bind(usuario.id, agora())
    .first();
  if (aberto) {
    throw new HttpError(409, 'Você já tem um pedido aguardando pagamento. Pague ou cancele esse pedido para fazer outro.', { pedido_aberto: aberto.codigo });
  }
  const cupomDigitado = typeof b.cupom === 'string' ? b.cupom.slice(0, 60) : '';
  const codigo = await criarPedido(c.env, usuario, { loteId, quantidade, nomePagador, cupomDigitado });
  await c.env.DB.prepare('UPDATE pedidos SET aceite_termos_em = ?2, termos_versao = ?3 WHERE codigo = ?1').bind(codigo, agora(), TERMOS_VERSAO).run();
  let pedido = await buscarPedido(c.env.DB, { codigo });
  await auditar(c.env.DB, usuario.id, 'pedido_criado', pedido.cupom_codigo ? `${codigo} cupom ${pedido.cupom_codigo}` : codigo);
  const cents = (n) => (n / 100).toFixed(2).replace('.', ',');
  if (pedido.total_centavos === 0 && pedido.cupom_id) {
    await concluirPedidoGratis(c.env.DB, pedido.id, pedido.cupom_codigo);
    pedido = await buscarPedido(c.env.DB, { codigo });
    await alertar(c, 'novo_pedido', `Pedido ${codigo} com cupom ${pedido.cupom_codigo}: ${usuario.nome} ${usuario.sobrenome} — ${quantidade} ingresso(s) sem custo, já confirmado.`);
  }
  // Pedido pago normal: o admin só é avisado quando a pessoa escolhe a forma de pagamento.
  return c.json({ ...(await visaoPedido(c.env.DB, pedido)), mp_disponivel: !!c.env.MP_ACCESS_TOKEN }, 201);
});

// A pessoa escolheu pagar direto na chave Pix (copiou o código). Dispara o aviso ao admin, uma vez por pedido.
r.post('/pedidos/:codigo/escolheu-pagamento', exigir(), async (c) => {
  const usuario = c.get('usuario');
  const pedido = await buscarPedido(c.env.DB, { codigo: c.req.param('codigo').toUpperCase() });
  if (!pedido || pedido.comprador_id !== usuario.id) throw new HttpError(404, 'Pedido não encontrado.');
  if (pedido.status === 'aguardando_pagamento') await avisarPedidoEmPagamento(c, pedido, usuario, 'Pix na chave');
  return c.json({ ok: true });
});

r.get('/pedidos/:codigo', exigir(), async (c) => {
  const usuario = c.get('usuario');
  const pedido = await buscarPedido(c.env.DB, { codigo: c.req.param('codigo').toUpperCase() });
  if (!pedido || (pedido.comprador_id !== usuario.id && usuario.papel !== 'admin')) {
    throw new HttpError(404, 'Pedido não encontrado.');
  }
  return c.json({ ...(await visaoPedido(c.env.DB, pedido)), mp_disponivel: !!c.env.MP_ACCESS_TOKEN });
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
    .prepare(`SELECT id FROM pedidos WHERE comprador_id = ?1 AND canal = 'online' ORDER BY id DESC LIMIT 50`)
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
      WHERE i.dono_id = ?1 AND i.nome_avulso IS NULL ORDER BY i.id`,
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
