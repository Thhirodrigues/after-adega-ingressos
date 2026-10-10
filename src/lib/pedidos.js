import { HttpError, agora, configuracoes } from './http.js';
import { codigoCurto } from './crypto.js';
import { pixCopiaECola } from './pix.js';

// Todas as mudanças de estoque abaixo rodam em db.batch(): o D1 executa o lote em UMA
// transação, em sequência, e desfaz tudo se algo falhar. Cada UPDATE carrega a própria
// condição (ex.: "só se ainda há ingressos"), então duas compras simultâneas nunca
// vendem o mesmo ingresso duas vezes.

export function calcularValores(valorUnitCentavos, quantidade, taxaPercentual) {
  const subtotal = valorUnitCentavos * quantidade;
  const taxa = Math.floor((subtotal * taxaPercentual + 50) / 100);
  return { subtotal, taxa, total: subtotal + taxa };
}

// Devolve ao estoque as reservas vencidas (pedidos que ninguém pagou a tempo).
export async function liberarExpirados(db) {
  const t = agora();
  const vencido = await db
    .prepare(
      `SELECT 1 FROM pedidos WHERE status = 'aguardando_pagamento' AND expira_em < ?1 LIMIT 1`,
    )
    .bind(t)
    .first();
  if (!vencido) return;
  await db.batch([
    db
      .prepare(
        `UPDATE lotes SET reservados = reservados - COALESCE(
           (SELECT SUM(p.quantidade) FROM pedidos p
             WHERE p.lote_id = lotes.id AND p.status = 'aguardando_pagamento'
               AND p.reserva_ativa = 1 AND p.expira_em < ?1), 0)`,
      )
      .bind(t),
    db
      .prepare(
        `UPDATE pedidos SET status = 'expirado', reserva_ativa = 0
          WHERE status = 'aguardando_pagamento' AND expira_em < ?1`,
      )
      .bind(t),
  ]);
}

export async function criarPedido(env, usuario, { loteId, quantidade, nomePagador }) {
  const db = env.DB;
  const cfg = await configuracoes(db);
  if (!cfg.pix_chave) {
    throw new HttpError(503, 'O pagamento ainda não foi configurado. Fale com a organização.');
  }
  const pct = Number(cfg.taxa_percentual);
  const reservaMin = Number(cfg.reserva_minutos);
  const max = Number(cfg.max_ingressos_por_pedido);
  if (quantidade > max) {
    throw new HttpError(400, `Máximo de ${max} ingressos por pedido.`);
  }

  await liberarExpirados(db);

  const lote = await db
    .prepare(
      `SELECT l.id, l.ativo, l.canal, e.ativo AS evento_ativo
         FROM lotes l JOIN eventos e ON e.id = l.evento_id WHERE l.id = ?1`,
    )
    .bind(loteId)
    .first();
  if (!lote || !lote.ativo || !lote.evento_ativo || lote.canal === 'porta') throw new HttpError(404, 'Lote indisponível.');

  const t = agora();
  const expira = t + reservaMin * 60;

  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const codigo = codigoCurto();
    try {
      const [ins] = await db.batch([
        db
          .prepare(
            `INSERT INTO pedidos
               (codigo, comprador_id, evento_id, lote_id, quantidade, valor_unit_centavos,
                subtotal_centavos, taxa_centavos, total_centavos, nome_pagador, status,
                reserva_ativa, contabilizado, criado_em, expira_em)
             SELECT ?1, ?2, l.evento_id, l.id, ?3, l.valor_centavos,
                    CAST(?3 * l.valor_centavos AS INTEGER),
                    CAST((?3 * l.valor_centavos * ?4 + 50) / 100 AS INTEGER),
                    CAST(?3 * l.valor_centavos AS INTEGER)
                      + CAST((?3 * l.valor_centavos * ?4 + 50) / 100 AS INTEGER),
                    ?5, 'aguardando_pagamento', 1, 0, ?6, ?7
               FROM lotes l
              WHERE l.id = ?8 AND l.ativo = 1 AND l.canal <> 'porta'
                AND (l.quantidade - l.vendidos - l.reservados) >= ?3`,
          )
          .bind(codigo, usuario.id, quantidade, pct, nomePagador, t, expira, loteId),
        db
          .prepare(
            `UPDATE lotes SET reservados = reservados + ?1
              WHERE id = ?2 AND ativo = 1 AND (quantidade - vendidos - reservados) >= ?1`,
          )
          .bind(quantidade, loteId),
      ]);
      if (ins.meta.changes !== 1) {
        throw new HttpError(409, 'Não há ingressos suficientes neste lote.');
      }
      return codigo;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (/UNIQUE/i.test(String(e.message)) && /pedidos\.codigo/i.test(String(e.message))) continue;
      throw e;
    }
  }
  throw new HttpError(500, 'Não foi possível gerar o pedido. Tente novamente.');
}

// Admin confirma que o Pix caiu na conta. Idempotente: confirmar duas vezes não duplica nada.
// Se o pedido já tinha vencido (cliente pagou atrasado), só confirma se ainda houver estoque.
export async function confirmarPedido(db, pedidoId, adminId, forma = null) {
  const t = agora();
  await db.batch([
    db
      .prepare(
        `UPDATE pedidos SET status = 'pago', pago_em = ?2, confirmado_por = ?3, contabilizado = 0,
                forma_pagamento = COALESCE(?4, forma_pagamento)
          WHERE id = ?1 AND status IN ('aguardando_pagamento', 'expirado')
            AND (reserva_ativa = 1 OR
                 (SELECT l.quantidade - l.vendidos - l.reservados FROM lotes l
                   WHERE l.id = pedidos.lote_id) >= pedidos.quantidade)`,
      )
      .bind(pedidoId, t, adminId, forma),
    db
      .prepare(
        `UPDATE lotes
            SET reservados = reservados - (SELECT reserva_ativa * quantidade FROM pedidos WHERE id = ?1),
                vendidos = vendidos + (SELECT quantidade FROM pedidos WHERE id = ?1)
          WHERE id = (SELECT lote_id FROM pedidos WHERE id = ?1)
            AND EXISTS (SELECT 1 FROM pedidos WHERE id = ?1 AND status = 'pago' AND contabilizado = 0)`,
      )
      .bind(pedidoId),
    db
      .prepare(
        `UPDATE pedidos SET contabilizado = 1, reserva_ativa = 0
          WHERE id = ?1 AND status = 'pago' AND contabilizado = 0`,
      )
      .bind(pedidoId),
    db
      .prepare(
        `WITH RECURSIVE seq(i) AS (
           SELECT 1 UNION ALL SELECT i + 1 FROM seq
            WHERE i < (SELECT quantidade FROM pedidos WHERE id = ?1))
         INSERT INTO ingressos (pedido_id, evento_id, lote_id, dono_id, tipo, status, criado_em)
         SELECT p.id, p.evento_id, p.lote_id, p.comprador_id, 'pago', 'valido', ?2
           FROM seq JOIN pedidos p ON p.id = ?1
          WHERE p.status = 'pago' AND p.contabilizado = 1
            AND NOT EXISTS (SELECT 1 FROM ingressos WHERE pedido_id = ?1)`,
      )
      .bind(pedidoId, t),
  ]);
}

// Cancela pedido que ainda não foi pago (comprador desistiu ou admin recusou).
export async function cancelarNaoPago(db, pedidoId) {
  await db.batch([
    db
      .prepare(
        `UPDATE lotes SET reservados = reservados - (SELECT quantidade FROM pedidos WHERE id = ?1)
          WHERE id = (SELECT lote_id FROM pedidos WHERE id = ?1)
            AND EXISTS (SELECT 1 FROM pedidos
                         WHERE id = ?1 AND status = 'aguardando_pagamento' AND reserva_ativa = 1)`,
      )
      .bind(pedidoId),
    db
      .prepare(
        `UPDATE pedidos SET status = 'cancelado', reserva_ativa = 0
          WHERE id = ?1 AND status IN ('aguardando_pagamento', 'expirado')`,
      )
      .bind(pedidoId),
  ]);
}

// Estorno de pedido pago (a devolução do Pix é feita à mão pelo admin): invalida os
// ingressos e devolve a quantidade ao lote. Recusa se algum ingresso já foi usado.
export async function estornarPago(db, pedidoId) {
  await db.batch([
    db
      .prepare(
        `UPDATE pedidos SET status = 'cancelado'
          WHERE id = ?1 AND status = 'pago'
            AND NOT EXISTS (SELECT 1 FROM ingressos WHERE pedido_id = ?1 AND status = 'usado')`,
      )
      .bind(pedidoId),
    db
      .prepare(
        `UPDATE lotes SET vendidos = vendidos - (SELECT quantidade FROM pedidos WHERE id = ?1)
          WHERE id = (SELECT lote_id FROM pedidos WHERE id = ?1)
            AND EXISTS (SELECT 1 FROM pedidos WHERE id = ?1 AND status = 'cancelado' AND contabilizado = 1)`,
      )
      .bind(pedidoId),
    db
      .prepare(
        `UPDATE pedidos SET contabilizado = 0 WHERE id = ?1 AND status = 'cancelado' AND contabilizado = 1`,
      )
      .bind(pedidoId),
    db
      .prepare(
        `UPDATE ingressos SET status = 'cancelado'
          WHERE pedido_id = ?1 AND status = 'valido'
            AND EXISTS (SELECT 1 FROM pedidos WHERE id = ?1 AND status = 'cancelado')`,
      )
      .bind(pedidoId),
  ]);
}

export async function buscarPedido(db, { id, codigo }) {
  const sql = `SELECT p.*, e.nome AS evento_nome, e.data_evento, l.nome AS lote_nome
                 FROM pedidos p
                 JOIN eventos e ON e.id = p.evento_id
                 JOIN lotes l ON l.id = p.lote_id
                WHERE ${id != null ? 'p.id = ?1' : 'p.codigo = ?1'}`;
  return db.prepare(sql).bind(id != null ? id : codigo).first();
}

// O que o comprador vê. Se o pedido está aguardando e dentro do prazo, inclui o Pix.
export async function visaoPedido(db, p) {
  const t = agora();
  const vencido = p.status === 'aguardando_pagamento' && p.expira_em < t;
  const status = vencido ? 'expirado' : p.status;
  const visao = {
    codigo: p.codigo,
    status,
    evento: p.evento_nome,
    data_evento: p.data_evento,
    lote: p.lote_nome,
    quantidade: p.quantidade,
    valor_unit_centavos: p.valor_unit_centavos,
    subtotal_centavos: p.subtotal_centavos,
    taxa_centavos: p.taxa_centavos,
    total_centavos: p.total_centavos,
    nome_pagador: p.nome_pagador,
    criado_em: p.criado_em,
    expira_em: p.expira_em,
    pago_em: p.pago_em,
  };
  if (status === 'aguardando_pagamento') {
    const cfg = await configuracoes(db);
    visao.pix = {
      chave: cfg.pix_chave,
      favorecido: cfg.pix_nome,
      valor_centavos: p.total_centavos,
      referencia: p.codigo,
      copia_e_cola: pixCopiaECola({
        chave: cfg.pix_chave,
        nome: cfg.pix_nome,
        cidade: cfg.pix_cidade,
        valorCentavos: p.total_centavos,
        referencia: p.codigo,
      }),
    };
  }
  return visao;
}

// Venda presencial (porta ou dinheiro em mãos): sem taxa de serviço, já nasce paga.
// Reaproveita a reserva + confirmação atômicas; depois grava o nome do convidado.
// Cada ingresso recebe o nome de uma pessoa e a entrada é marcada na hora (sem QR).
export async function venderPresencial(db, vendedor, { loteId, quantidade, nomes, forma }) {
  await liberarExpirados(db);
  const lote = await db
    .prepare(
      `SELECT l.id, l.ativo, l.canal, e.ativo AS evento_ativo
         FROM lotes l JOIN eventos e ON e.id = l.evento_id WHERE l.id = ?1`,
    )
    .bind(loteId)
    .first();
  if (!lote || !lote.ativo || !lote.evento_ativo || lote.canal === 'online') {
    throw new HttpError(404, 'Lote indisponível para venda presencial.');
  }
  const t = agora();
  let codigo = null;
  for (let tentativa = 0; tentativa < 5 && !codigo; tentativa++) {
    const cod = codigoCurto();
    try {
      const [ins] = await db.batch([
        db
          .prepare(
            `INSERT INTO pedidos
               (codigo, comprador_id, evento_id, lote_id, quantidade, valor_unit_centavos,
                subtotal_centavos, taxa_centavos, total_centavos, nome_pagador, status,
                reserva_ativa, contabilizado, criado_em, expira_em, canal, vendedor_id, forma_pagamento)
             SELECT ?1, ?2, l.evento_id, l.id, ?3, l.valor_centavos,
                    CAST(?3 * l.valor_centavos AS INTEGER), 0, CAST(?3 * l.valor_centavos AS INTEGER),
                    ?4, 'aguardando_pagamento', 1, 0, ?5, ?6, 'porta', ?2, ?7
               FROM lotes l
              WHERE l.id = ?8 AND l.ativo = 1 AND l.canal <> 'online'
                AND (l.quantidade - l.vendidos - l.reservados) >= ?3`,
          )
          .bind(cod, vendedor.id, quantidade, nomes[0], t, t + 120, forma, loteId),
        db
          .prepare(
            `UPDATE lotes SET reservados = reservados + ?1
              WHERE id = ?2 AND ativo = 1 AND (quantidade - vendidos - reservados) >= ?1`,
          )
          .bind(quantidade, loteId),
      ]);
      if (ins.meta.changes !== 1) throw new HttpError(409, 'Não há ingressos suficientes neste lote.');
      codigo = cod;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (/UNIQUE/i.test(String(e.message)) && /pedidos\.codigo/i.test(String(e.message))) continue;
      throw e;
    }
  }
  if (!codigo) throw new HttpError(500, 'Não foi possível registrar a venda. Tente novamente.');
  const p = await db.prepare('SELECT id FROM pedidos WHERE codigo = ?1').bind(codigo).first();
  await confirmarPedido(db, p.id, vendedor.id);
  // Venda na porta: cada ingresso leva o nome de uma pessoa e já entra.
  const { results: ings } = await db.prepare('SELECT id FROM ingressos WHERE pedido_id = ?1 ORDER BY id').bind(p.id).all();
  await db.batch(
    ings.map((ing, i) =>
      db
        .prepare(`UPDATE ingressos SET nome_avulso = ?2, status = 'usado', usado_em = ?3, usado_por = ?4 WHERE id = ?1`)
        .bind(ing.id, nomes[i] ?? nomes[0], t, vendedor.id),
    ),
  );
  return { id: p.id, codigo };
}
