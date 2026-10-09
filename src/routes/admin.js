import { Hono } from 'hono';
import { HttpError, agora, auditar, configuracoes, corpo } from '../lib/http.js';
import { exigir, guardarSenha } from '../lib/auth.js';
import * as v from '../lib/validar.js';
import {
  buscarPedido,
  cancelarNaoPago,
  confirmarPedido,
  estornarPago,
} from '../lib/pedidos.js';
import { inserirUsuario, lerDadosUsuario } from './auth.js';

const r = new Hono();
r.use('/admin/*', exigir('admin'));

const bool = (x) => (x ? 1 : 0);

// ---------- Configuração (chave Pix, taxa, prazo da reserva) ----------

r.get('/admin/config', async (c) => c.json(await configuracoes(c.env.DB)));

r.put('/admin/config', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const novos = {};
  if ('pix_chave' in b) novos.pix_chave = v.texto(b.pix_chave, 'Chave Pix', 1, 77);
  if ('pix_nome' in b) novos.pix_nome = v.texto(b.pix_nome, 'Nome do favorecido', 1, 60);
  if ('pix_cidade' in b) novos.pix_cidade = v.texto(b.pix_cidade, 'Cidade', 1, 40);
  if ('taxa_percentual' in b) novos.taxa_percentual = String(v.inteiro(b.taxa_percentual, 'Taxa (%)', 0, 30));
  if ('reserva_minutos' in b) novos.reserva_minutos = String(v.inteiro(b.reserva_minutos, 'Prazo da reserva (min)', 5, 1440));
  if ('max_ingressos_por_pedido' in b) {
    novos.max_ingressos_por_pedido = String(v.inteiro(b.max_ingressos_por_pedido, 'Máximo por pedido', 1, 50));
  }
  const chaves = Object.keys(novos);
  if (!chaves.length) throw new HttpError(400, 'Nada para atualizar.');
  await db.batch(
    chaves.map((k) =>
      db
        .prepare(
          'INSERT INTO config (chave, valor) VALUES (?1, ?2) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
        )
        .bind(k, novos[k]),
    ),
  );
  await auditar(db, c.get('usuario').id, 'config_alterada', chaves.join(','));
  return c.json(await configuracoes(db));
});

// ---------- Eventos e lotes ----------

r.get('/admin/eventos', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM eventos ORDER BY data_evento DESC').all();
  return c.json({ eventos: results });
});

r.post('/admin/eventos', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const ativo = bool(b.ativo);
  const stmts = [];
  if (ativo) stmts.push(db.prepare('UPDATE eventos SET ativo = 0'));
  stmts.push(
    db
      .prepare(
        'INSERT INTO eventos (nome, data_evento, local, descricao, ativo, criado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      )
      .bind(
        v.texto(b.nome, 'Nome', 2, 80),
        v.dataISO(b.data_evento),
        String(b.local ?? '').trim().slice(0, 120),
        String(b.descricao ?? '').trim().slice(0, 1000),
        ativo,
        agora(),
      ),
  );
  const res = await db.batch(stmts);
  return c.json({ ok: true, id: res[res.length - 1].meta.last_row_id }, 201);
});

r.put('/admin/eventos/:id', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const id = v.inteiro(c.req.param('id'), 'Evento', 1, 1_000_000_000);
  const atual = await db.prepare('SELECT * FROM eventos WHERE id = ?1').bind(id).first();
  if (!atual) throw new HttpError(404, 'Evento não encontrado.');
  const nome = 'nome' in b ? v.texto(b.nome, 'Nome', 2, 80) : atual.nome;
  const data = 'data_evento' in b ? v.dataISO(b.data_evento) : atual.data_evento;
  const local = 'local' in b ? String(b.local ?? '').trim().slice(0, 120) : atual.local;
  const descricao = 'descricao' in b ? String(b.descricao ?? '').trim().slice(0, 1000) : atual.descricao;
  const ativo = 'ativo' in b ? bool(b.ativo) : atual.ativo;
  const stmts = [];
  if (ativo) stmts.push(db.prepare('UPDATE eventos SET ativo = 0 WHERE id <> ?1').bind(id));
  stmts.push(
    db
      .prepare('UPDATE eventos SET nome=?2, data_evento=?3, local=?4, descricao=?5, ativo=?6 WHERE id=?1')
      .bind(id, nome, data, local, descricao, ativo),
  );
  await db.batch(stmts);
  return c.json({ ok: true });
});

r.get('/admin/lotes', async (c) => {
  const eventoId = c.req.query('evento_id');
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM lotes WHERE (?1 IS NULL OR evento_id = ?1) ORDER BY evento_id, ordem, id`,
  )
    .bind(eventoId ? Number(eventoId) : null)
    .all();
  return c.json({ lotes: results });
});

r.post('/admin/lotes', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const eventoId = v.inteiro(b.evento_id, 'Evento', 1, 1_000_000_000);
  if (!(await db.prepare('SELECT 1 FROM eventos WHERE id = ?1').bind(eventoId).first())) {
    throw new HttpError(404, 'Evento não encontrado.');
  }
  const res = await db
    .prepare(
      `INSERT INTO lotes (evento_id, nome, valor_centavos, quantidade, ativo, ordem, criado_em)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      eventoId,
      v.texto(b.nome, 'Nome do lote', 1, 60),
      v.inteiro(b.valor_centavos, 'Valor (centavos)', 0, 10_000_000),
      v.inteiro(b.quantidade, 'Quantidade', 0, 100_000),
      bool(b.ativo),
      'ordem' in b ? v.inteiro(b.ordem, 'Ordem', 0, 1000) : 0,
      agora(),
    )
    .run();
  await auditar(db, c.get('usuario').id, 'lote_criado', String(res.meta.last_row_id));
  return c.json({ ok: true, id: res.meta.last_row_id }, 201);
});

// Mudar o valor afeta só pedidos NOVOS (cada pedido guarda o valor da hora da compra).
r.put('/admin/lotes/:id', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const id = v.inteiro(c.req.param('id'), 'Lote', 1, 1_000_000_000);
  const atual = await db.prepare('SELECT * FROM lotes WHERE id = ?1').bind(id).first();
  if (!atual) throw new HttpError(404, 'Lote não encontrado.');
  const nome = 'nome' in b ? v.texto(b.nome, 'Nome do lote', 1, 60) : atual.nome;
  const valor = 'valor_centavos' in b ? v.inteiro(b.valor_centavos, 'Valor (centavos)', 0, 10_000_000) : atual.valor_centavos;
  const quantidade = 'quantidade' in b ? v.inteiro(b.quantidade, 'Quantidade', 0, 100_000) : atual.quantidade;
  const ativo = 'ativo' in b ? bool(b.ativo) : atual.ativo;
  const ordem = 'ordem' in b ? v.inteiro(b.ordem, 'Ordem', 0, 1000) : atual.ordem;
  if (quantidade < atual.vendidos + atual.reservados) {
    throw new HttpError(
      409,
      `A quantidade não pode ficar abaixo de ${atual.vendidos + atual.reservados} (vendidos + reservados).`,
    );
  }
  try {
    await db
      .prepare('UPDATE lotes SET nome=?2, valor_centavos=?3, quantidade=?4, ativo=?5, ordem=?6 WHERE id=?1')
      .bind(id, nome, valor, quantidade, ativo, ordem)
      .run();
  } catch (e) {
    if (/CHECK/i.test(String(e.message))) throw new HttpError(409, 'Quantidade menor que os ingressos já vendidos ou reservados.');
    throw e;
  }
  await auditar(db, c.get('usuario').id, 'lote_alterado', `${id}: ${Object.keys(b).join(',')}`);
  return c.json({ ok: true });
});

// ---------- Pedidos: conferência manual do Pix ----------

r.get('/admin/pedidos', async (c) => {
  const status = c.req.query('status') || null;
  const eventoId = c.req.query('evento_id') ? Number(c.req.query('evento_id')) : null;
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.codigo, p.status, p.quantidade, p.subtotal_centavos, p.taxa_centavos,
            p.total_centavos, p.nome_pagador, p.criado_em, p.expira_em, p.pago_em, p.reserva_ativa,
            u.nome || ' ' || u.sobrenome AS comprador, u.telefone, u.cpf, l.nome AS lote
       FROM pedidos p
       JOIN usuarios u ON u.id = p.comprador_id
       JOIN lotes l ON l.id = p.lote_id
      WHERE (?1 IS NULL OR p.status = ?1) AND (?2 IS NULL OR p.evento_id = ?2)
      ORDER BY p.id DESC LIMIT 300`,
  )
    .bind(status, eventoId)
    .all();
  const t = agora();
  return c.json({
    pedidos: results.map((p) => ({
      ...p,
      vencido: p.status === 'aguardando_pagamento' && p.expira_em < t,
    })),
  });
});

r.post('/admin/pedidos/:id/confirmar', async (c) => {
  const db = c.env.DB;
  const admin = c.get('usuario');
  const id = v.inteiro(c.req.param('id'), 'Pedido', 1, 1_000_000_000);
  const antes = await buscarPedido(db, { id });
  if (!antes) throw new HttpError(404, 'Pedido não encontrado.');
  if (antes.status === 'cancelado') throw new HttpError(409, 'Este pedido foi cancelado.');
  await confirmarPedido(db, id, admin.id);
  const depois = await buscarPedido(db, { id });
  if (depois.status !== 'pago') {
    throw new HttpError(
      409,
      'O prazo da reserva venceu e o lote não tem mais ingressos. Devolva o Pix ao comprador.',
    );
  }
  if (antes.status !== 'pago') await auditar(db, admin.id, 'pedido_confirmado', depois.codigo);
  return c.json({ ok: true, status: depois.status });
});

// Recusa/cancela. Pedido ainda não pago: libera a reserva. Pedido pago: estorno
// (a devolução do Pix é feita por você, fora do sistema).
r.post('/admin/pedidos/:id/cancelar', async (c) => {
  const db = c.env.DB;
  const admin = c.get('usuario');
  const id = v.inteiro(c.req.param('id'), 'Pedido', 1, 1_000_000_000);
  const pedido = await buscarPedido(db, { id });
  if (!pedido) throw new HttpError(404, 'Pedido não encontrado.');
  if (pedido.status === 'cancelado') return c.json({ ok: true, status: 'cancelado' });
  if (pedido.status === 'pago') {
    await estornarPago(db, id);
    const depois = await buscarPedido(db, { id });
    if (depois.status !== 'cancelado') {
      throw new HttpError(409, 'Não dá para estornar: algum ingresso deste pedido já foi usado na portaria.');
    }
    await auditar(db, admin.id, 'pedido_estornado', pedido.codigo);
    return c.json({ ok: true, status: 'cancelado', lembrete: 'Devolva o Pix ao comprador manualmente.' });
  }
  await cancelarNaoPago(db, id);
  await auditar(db, admin.id, 'pedido_cancelado_admin', pedido.codigo);
  return c.json({ ok: true, status: 'cancelado' });
});

// ---------- Usuários (hostess, admins) e "esqueci minha senha" ----------

r.get('/admin/usuarios', async (c) => {
  const papel = c.req.query('papel') || null;
  const { results } = await c.env.DB.prepare(
    `SELECT id, cpf, nome, sobrenome, email, telefone, papel, ativo, deve_trocar_senha, criado_em
       FROM usuarios WHERE (?1 IS NULL OR papel = ?1) ORDER BY id DESC LIMIT 500`,
  )
    .bind(papel)
    .all();
  return c.json({ usuarios: results });
});

// Cria hostess/admin com senha provisória (o navegador do admin já envia a senha esticada).
r.post('/admin/usuarios', async (c) => {
  const b = await corpo(c);
  const papel = String(b.papel ?? '');
  if (!['hostess', 'admin', 'comprador'].includes(papel)) throw new HttpError(400, 'Papel inválido.');
  const dados = lerDadosUsuario(b);
  const id = await inserirUsuario(c, dados, papel, true);
  await auditar(c.env.DB, c.get('usuario').id, 'usuario_criado', `${id}:${papel}`);
  return c.json({ ok: true, id }, 201);
});

r.put('/admin/usuarios/:id', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const admin = c.get('usuario');
  const id = v.inteiro(c.req.param('id'), 'Usuário', 1, 1_000_000_000);
  if (!('ativo' in b)) throw new HttpError(400, 'Nada para atualizar.');
  if (id === admin.id && !b.ativo) throw new HttpError(409, 'Você não pode desativar a si mesmo.');
  await db.batch([
    db.prepare('UPDATE usuarios SET ativo = ?2 WHERE id = ?1').bind(id, bool(b.ativo)),
    db.prepare('DELETE FROM sessoes WHERE usuario_id = ?1 AND ?2 = 0').bind(id, bool(b.ativo)),
  ]);
  await auditar(db, admin.id, 'usuario_ativo', `${id}:${bool(b.ativo)}`);
  return c.json({ ok: true });
});

r.get('/admin/resets', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.usuario_id, r.criado_em, u.nome || ' ' || u.sobrenome AS nome, u.telefone, u.cpf
       FROM pedidos_reset r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.status = 'aberto' ORDER BY r.id`,
  ).all();
  return c.json({ resets: results });
});

// Define senha provisória (o usuário será obrigado a trocar no próximo login).
r.post('/admin/usuarios/:id/definir-senha', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const admin = c.get('usuario');
  const id = v.inteiro(c.req.param('id'), 'Usuário', 1, 1_000_000_000);
  const senha = v.senhaDerivada(b.senha);
  const u = await db.prepare('SELECT cpf FROM usuarios WHERE id = ?1').bind(id).first();
  if (!u) throw new HttpError(404, 'Usuário não encontrado.');
  await db.batch([
    db
      .prepare('UPDATE usuarios SET senha_hash = ?2, deve_trocar_senha = 1 WHERE id = ?1')
      .bind(id, await guardarSenha(c.env, u.cpf, senha)),
    db.prepare('DELETE FROM sessoes WHERE usuario_id = ?1').bind(id),
    db
      .prepare(
        `UPDATE pedidos_reset SET status = 'atendido', atendido_em = ?2, atendido_por = ?3
          WHERE usuario_id = ?1 AND status = 'aberto'`,
      )
      .bind(id, agora(), admin.id),
  ]);
  await auditar(db, admin.id, 'senha_provisoria', String(id));
  return c.json({ ok: true });
});

// ---------- Financeiro ----------

r.get('/admin/financeiro', async (c) => {
  const db = c.env.DB;
  const t = agora();
  const eventoId = c.req.query('evento_id')
    ? Number(c.req.query('evento_id'))
    : (await db.prepare('SELECT id FROM eventos WHERE ativo = 1 ORDER BY data_evento LIMIT 1').first())?.id;
  if (!eventoId) return c.json({ evento: null });
  const evento = await db.prepare('SELECT id, nome, data_evento FROM eventos WHERE id = ?1').bind(eventoId).first();
  if (!evento) throw new HttpError(404, 'Evento não encontrado.');

  const { results: lotes } = await db
    .prepare(
      `SELECT l.id, l.nome, l.valor_centavos, l.quantidade, l.vendidos, l.reservados, l.ativo,
              (SELECT COUNT(*) FROM pedidos p WHERE p.lote_id = l.id AND p.status = 'pago') AS pedidos_pagos,
              COALESCE((SELECT SUM(p.subtotal_centavos) FROM pedidos p WHERE p.lote_id = l.id AND p.status = 'pago'), 0) AS receita_ingressos_centavos,
              COALESCE((SELECT SUM(p.taxa_centavos) FROM pedidos p WHERE p.lote_id = l.id AND p.status = 'pago'), 0) AS taxa_servico_centavos
         FROM lotes l WHERE l.evento_id = ?1 ORDER BY l.ordem, l.id`,
    )
    .bind(eventoId)
    .all();

  const pend = await db
    .prepare(
      `SELECT COUNT(*) AS pedidos, COALESCE(SUM(total_centavos), 0) AS total, COALESCE(SUM(quantidade), 0) AS ingressos
         FROM pedidos WHERE evento_id = ?1 AND status = 'aguardando_pagamento' AND expira_em >= ?2`,
    )
    .bind(eventoId, t)
    .first();
  const venc = await db
    .prepare(
      `SELECT COUNT(*) AS pedidos, COALESCE(SUM(total_centavos), 0) AS total
         FROM pedidos WHERE evento_id = ?1
          AND ((status = 'aguardando_pagamento' AND expira_em < ?2) OR status = 'expirado')`,
    )
    .bind(eventoId, t)
    .first();
  const canc = await db
    .prepare(`SELECT COUNT(*) AS pedidos FROM pedidos WHERE evento_id = ?1 AND status = 'cancelado'`)
    .bind(eventoId)
    .first();
  const ing = await db
    .prepare(
      `SELECT SUM(CASE WHEN tipo = 'pago' AND status <> 'cancelado' THEN 1 ELSE 0 END) AS pagos,
              SUM(CASE WHEN tipo = 'cortesia' AND status <> 'cancelado' THEN 1 ELSE 0 END) AS cortesias,
              SUM(CASE WHEN status = 'usado' THEN 1 ELSE 0 END) AS entraram
         FROM ingressos WHERE evento_id = ?1`,
    )
    .bind(eventoId)
    .first();

  const soma = (campo) => lotes.reduce((a, l) => a + l[campo], 0);
  const receitaIngressos = soma('receita_ingressos_centavos');
  const taxaServico = soma('taxa_servico_centavos');

  return c.json({
    evento,
    resumo: {
      pedidos_pagos: soma('pedidos_pagos'),
      ingressos_vendidos: ing.pagos ?? 0,
      cortesias: ing.cortesias ?? 0,
      entraram: ing.entraram ?? 0,
      receita_ingressos_centavos: receitaIngressos,
      taxa_servico_centavos: taxaServico,
      total_recebido_centavos: receitaIngressos + taxaServico,
      a_receber_centavos: pend.total,
      pedidos_aguardando: pend.pedidos,
      ingressos_aguardando: pend.ingressos,
      pedidos_vencidos: venc.pedidos,
      valor_vencido_centavos: venc.total,
      pedidos_cancelados: canc.pedidos,
      observacao: 'Pix recebido na chave: sem taxa de gateway. Valores em centavos.',
    },
    lotes,
  });
});

export default r;
