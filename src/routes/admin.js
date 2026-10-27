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
import { alertar } from '../lib/alertas.js';
import { chavesVapid, enviarPush } from '../lib/push.js';
import { aleatorioHex, hmacHex } from '../lib/crypto.js';
import { ROTULO_CATEGORIA, resgatarPendentes } from '../lib/convites.js';
import { SQL_USADOS, TIPOS_CUPOM, normalizarCupom } from '../lib/cupons.js';

const r = new Hono();
r.use('/admin/*', exigir('admin'));

const bool = (x) => (x ? 1 : 0);
const CATEGORIAS_CONVITE = ['dj', 'aniversariante', 'convidado'];


// ---------- Configuração (chave Pix, taxa, prazo da reserva) ----------

const SEGREDOS_CONFIG = ['vapid_privada', 'pin_hash'];
const publicas = (cfg) => {
  const o = { ...cfg, pin_definido: !!cfg.pin_hash };
  for (const k of SEGREDOS_CONFIG) delete o[k];
  return o;
};
r.get('/admin/config', async (c) => {
  const fl = await c.env.DB.prepare(`SELECT 1 AS x FROM arquivos WHERE nome = 'flyer'`).first();
  return c.json({ ...publicas(await configuracoes(c.env.DB)), flyer_personalizado: !!fl });
});

r.put('/admin/config', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const novos = {};
  if ('pix_chave' in b) novos.pix_chave = v.texto(b.pix_chave, 'Chave Pix', 1, 77);
  if ('pix_nome' in b) novos.pix_nome = v.texto(b.pix_nome, 'Nome do favorecido', 1, 60);
  if ('pix_cidade' in b) novos.pix_cidade = v.texto(b.pix_cidade, 'Cidade', 1, 40);
  if ('taxa_percentual' in b) novos.taxa_percentual = String(v.inteiro(b.taxa_percentual, 'Taxa (%)', 0, 30));
  if ('reserva_minutos' in b) novos.reserva_minutos = String(v.inteiro(b.reserva_minutos, 'Prazo da reserva (min)', 5, 1440));
  if ('transferencia_limite_horas' in b) {
    novos.transferencia_limite_horas = String(v.inteiro(b.transferencia_limite_horas, 'Prazo de transferência (horas antes)', 0, 720));
  }
  if ('max_ingressos_por_pedido' in b) {
    novos.max_ingressos_por_pedido = String(v.inteiro(b.max_ingressos_por_pedido, 'Máximo por pedido', 1, 50));
  }
  if ('contato' in b) novos.contato = String(b.contato ?? '').trim().slice(0, 200);
  if ('contato_whatsapp' in b) {
    let d = String(b.contato_whatsapp ?? '').replace(/\D/g, '');
    if (d && !d.startsWith('55')) d = '55' + d;
    if (d && (d.length < 12 || d.length > 13)) throw new HttpError(400, 'Celular inválido. Use DDD + número.');
    novos.contato_whatsapp = d;
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
  return c.json(publicas(await configuracoes(db)));
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
        'INSERT INTO eventos (nome, data_evento, local, descricao, ativo, criado_em, hora_inicio) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      )
      .bind(
        v.texto(b.nome, 'Nome', 2, 80),
        v.dataISO(b.data_evento),
        String(b.local ?? '').trim().slice(0, 120),
        String(b.descricao ?? '').trim().slice(0, 1000),
        ativo,
        agora(),
        'hora_inicio' in b ? v.horaHM(b.hora_inicio, 'Horário de início') : '22:00',
      ),
  );
  const res = await db.batch(stmts);
  await auditar(db, c.get('usuario').id, 'evento_criado', `${v.texto(b.nome, 'Nome', 2, 80)} ${b.data_evento}${ativo ? ' (ativo)' : ''}`);
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
  const hora = 'hora_inicio' in b ? v.horaHM(b.hora_inicio, 'Horário de início') : atual.hora_inicio;
  const stmts = [];
  if (ativo) stmts.push(db.prepare('UPDATE eventos SET ativo = 0 WHERE id <> ?1').bind(id));
  stmts.push(
    db
      .prepare('UPDATE eventos SET nome=?2, data_evento=?3, local=?4, descricao=?5, ativo=?6, hora_inicio=?7 WHERE id=?1')
      .bind(id, nome, data, local, descricao, ativo, hora),
  );
  await db.batch(stmts);
  await auditar(db, c.get('usuario').id, 'evento_alterado', `${nome} ${data}${ativo ? ' (ativo)' : ' (inativo)'}`);
  return c.json({ ok: true });
});

const canalLote = (x) => (['todos', 'online', 'porta'].includes(x) ? x : 'todos');

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
      `INSERT INTO lotes (evento_id, nome, valor_centavos, quantidade, ativo, ordem, criado_em, canal)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      eventoId,
      v.texto(b.nome, 'Nome do lote', 1, 60),
      v.inteiro(b.valor_centavos, 'Valor (centavos)', 0, 10_000_000),
      v.inteiro(b.quantidade, 'Quantidade', 0, 100_000),
      bool(b.ativo),
      'ordem' in b ? v.inteiro(b.ordem, 'Ordem', 0, 1000) : 0,
      agora(),
      canalLote(b.canal),
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
  const canal = 'canal' in b ? canalLote(b.canal) : atual.canal;
  if (quantidade < atual.vendidos + atual.reservados) {
    throw new HttpError(
      409,
      `A quantidade não pode ficar abaixo de ${atual.vendidos + atual.reservados} (vendidos + reservados).`,
    );
  }
  try {
    await db
      .prepare('UPDATE lotes SET nome=?2, valor_centavos=?3, quantidade=?4, ativo=?5, ordem=?6, canal=?7 WHERE id=?1')
      .bind(id, nome, valor, quantidade, ativo, ordem, canal)
      .run();
  } catch (e) {
    if (/CHECK/i.test(String(e.message))) throw new HttpError(409, 'Quantidade menor que os ingressos já vendidos ou reservados.');
    throw e;
  }
  await auditar(db, c.get('usuario').id, 'lote_alterado', `${id}: ${Object.keys(b).join(',')}`);
  return c.json({ ok: true });
});

// ---------- Pedidos: conferência manual do Pix ----------

// ---------- Exportações (CSV para Excel: separador ";" e BOM) ----------
function csv(linhas) {
  const cel = (x) => {
    let t = String(x ?? '');
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // evita fórmula em planilha
    return `"${t.replace(/"/g, '""')}"`;
  };
  return '\uFEFF' + linhas.map((l) => l.map(cel).join(';')).join('\r\n') + '\r\n';
}
const fmtData = (t) => (t ? new Date(t * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');
const resp = (c, nome, texto) =>
  new Response(texto, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nome}"`, 'Cache-Control': 'no-store' },
  });

// Lista para a porta: sem CPF nem telefone.
r.get('/admin/export/convidados.csv', async (c) => {
  const ev = await c.env.DB.prepare('SELECT id, nome, data_evento FROM eventos WHERE ativo = 1 LIMIT 1').first();
  if (!ev) throw new HttpError(404, 'Nenhum evento ativo.');
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, COALESCE(i.nome_avulso, u.nome || ' ' || u.sobrenome) AS nome, i.tipo, i.motivo, i.status, i.usado_em
       FROM ingressos i JOIN usuarios u ON u.id = i.dono_id
      WHERE i.evento_id = ?1 AND i.status <> 'cancelado' ORDER BY 2, i.id`,
  )
    .bind(ev.id)
    .all();
  await auditar(c.env.DB, c.get('usuario').id, 'export_convidados', String(results.length));
  const linhas = [['Ingresso', 'Nome', 'Tipo', 'Motivo (cortesia)', 'Situação', 'Entrou às', 'Presente']];
  for (const i of results) linhas.push([`#${i.id}`, i.nome, i.tipo, i.motivo, i.status, fmtData(i.usado_em), '']);
  return resp(c, `convidados-${ev.data_evento}.csv`, csv(linhas));
});

// Vendas do evento ativo (conferência do Pix e fechamento).
r.get('/admin/export/vendas.csv', async (c) => {
  const ev = await c.env.DB.prepare('SELECT id, data_evento FROM eventos WHERE ativo = 1 LIMIT 1').first();
  if (!ev) throw new HttpError(404, 'Nenhum evento ativo.');
  const { results } = await c.env.DB.prepare(
    `SELECT p.codigo, p.status, p.quantidade, p.subtotal_centavos, p.taxa_centavos, p.total_centavos, p.nome_pagador, p.canal, p.forma_pagamento, p.cupom_codigo, p.desconto_centavos,
            p.criado_em, p.pago_em, u.nome || ' ' || u.sobrenome AS comprador, u.email, u.telefone, l.nome AS lote,
            (SELECT group_concat(i.celular_avulso, ' / ') FROM ingressos i WHERE i.pedido_id = p.id AND i.celular_avulso IS NOT NULL) AS celulares_porta
       FROM pedidos p JOIN usuarios u ON u.id = p.comprador_id JOIN lotes l ON l.id = p.lote_id
      WHERE p.evento_id = ?1 ORDER BY p.id`,
  )
    .bind(ev.id)
    .all();
  await auditar(c.env.DB, c.get('usuario').id, 'export_vendas', String(results.length));
  const reais = (n) => (n / 100).toFixed(2).replace('.', ',');
  const linhas = [['Pedido', 'Situação', 'Lote', 'Qtd', 'Ingressos (R$)', 'Desconto (R$)', 'Cupom', 'Taxa (R$)', 'Total (R$)', 'Comprador', 'Pagador (Pix)', 'Canal', 'Forma', 'E-mail', 'Celular', 'Criado em', 'Pago em', 'Celular do convidado (porta)']];
  for (const p of results) linhas.push([p.codigo, p.status, p.lote, p.quantidade, reais(p.subtotal_centavos), reais(p.desconto_centavos || 0), p.cupom_codigo || '', reais(p.taxa_centavos), reais(p.total_centavos), p.comprador, p.nome_pagador, p.canal === 'porta' ? 'porta' : 'online', ({ dinheiro: 'dinheiro', cartao: 'cartão (maquininha)', cupom: 'cupom', mercadopago: 'mercado pago' })[p.forma_pagamento] || 'pix', p.email, p.telefone, fmtData(p.criado_em), fmtData(p.pago_em), p.celulares_porta || '']);
  return resp(c, `vendas-${ev.data_evento}.csv`, csv(linhas));
});

r.get('/admin/pedidos', async (c) => {
  const status = c.req.query('status') || null;
  const eventoId = c.req.query('evento_id') ? Number(c.req.query('evento_id')) : null;
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.codigo, p.status, p.quantidade, p.subtotal_centavos, p.taxa_centavos,
            p.total_centavos, p.nome_pagador, p.criado_em, p.expira_em, p.pago_em, p.reserva_ativa, p.canal, p.forma_pagamento, p.cupom_codigo, p.desconto_centavos,
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
  const b = await corpo(c).catch(() => ({}));
  const forma = ['pix_chave', 'dinheiro'].includes(b.forma) ? b.forma : null;
  await confirmarPedido(db, id, admin.id, forma);
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
  if ('papel' in b) {
    const papel = String(b.papel ?? '');
    if (!['hostess', 'admin', 'comprador'].includes(papel)) throw new HttpError(400, 'Perfil inválido.');
    if (id === admin.id) throw new HttpError(409, 'Você não pode mudar o seu próprio perfil.');
    const res = await db.prepare('UPDATE usuarios SET papel = ?2 WHERE id = ?1').bind(id, papel).run();
    if (res.meta.changes !== 1) throw new HttpError(404, 'Usuário não encontrado.');
    await auditar(db, admin.id, 'usuario_papel', `${id}:${papel}`);
    if (!('ativo' in b)) return c.json({ ok: true });
  }
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

// ---------- Cupons ----------
// Palavra-chave que o comprador digita antes de efetuar a compra. O admin define o benefício:
// sem taxa de serviço, desconto em % no valor dos ingressos, ou VIP (entrada sem pagar).

const lerCupom = (b, atual = {}) => {
  const codigo = 'codigo' in b ? normalizarCupom(b.codigo) : atual.codigo;
  if (!/^[A-Z0-9_-]{3,30}$/.test(codigo || '')) {
    throw new HttpError(400, 'Palavra-chave: 3 a 30 letras ou números, sem espaço.');
  }
  const tipo = 'tipo' in b ? b.tipo : atual.tipo;
  if (!TIPOS_CUPOM.includes(tipo)) throw new HttpError(400, 'Tipo de cupom inválido.');
  const percentual = tipo === 'percentual' ? v.inteiro('percentual' in b ? b.percentual : atual.percentual, 'Desconto (%)', 1, 100) : 0;
  const lim = 'limite' in b ? b.limite : atual.limite;
  const limite = lim === null || lim === undefined || String(lim).trim() === '' ? null : v.inteiro(lim, 'Limite de ingressos', 0, 100_000);
  const ativo = 'ativo' in b ? bool(b.ativo) : (atual.ativo ?? 1);
  return { codigo, tipo, percentual, limite, ativo };
};

r.get('/admin/cupons', async (c) => {
  const eventoId = c.req.query('evento_id');
  const { results } = await c.env.DB.prepare(
    `SELECT cupons.*, ${SQL_USADOS} AS usados FROM cupons WHERE (?1 IS NULL OR evento_id = ?1) ORDER BY id`,
  )
    .bind(eventoId ? Number(eventoId) : null)
    .all();
  return c.json({ cupons: results });
});

r.post('/admin/cupons', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const eventoId = v.inteiro(b.evento_id, 'Evento', 1, 1_000_000_000);
  if (!(await db.prepare('SELECT 1 FROM eventos WHERE id = ?1').bind(eventoId).first())) {
    throw new HttpError(404, 'Evento não encontrado.');
  }
  const d = lerCupom(b);
  try {
    const res = await db
      .prepare('INSERT INTO cupons (evento_id, codigo, tipo, percentual, limite, ativo, criado_em) VALUES (?1,?2,?3,?4,?5,?6,?7)')
      .bind(eventoId, d.codigo, d.tipo, d.percentual, d.limite, d.ativo, agora())
      .run();
    await auditar(db, c.get('usuario').id, 'cupom_criado', `${d.codigo} ${d.tipo}`);
    return c.json({ ok: true, id: res.meta.last_row_id }, 201);
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'Já existe um cupom com essa palavra-chave neste evento.');
    throw e;
  }
});

// Mudar o cupom vale só para pedidos NOVOS (cada pedido guarda o desconto da hora da compra).
r.put('/admin/cupons/:id', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const id = v.inteiro(c.req.param('id'), 'Cupom', 1, 1_000_000_000);
  const atual = await db.prepare('SELECT * FROM cupons WHERE id = ?1').bind(id).first();
  if (!atual) throw new HttpError(404, 'Cupom não encontrado.');
  const d = lerCupom(b, atual);
  try {
    await db
      .prepare('UPDATE cupons SET codigo=?2, tipo=?3, percentual=?4, limite=?5, ativo=?6 WHERE id=?1')
      .bind(id, d.codigo, d.tipo, d.percentual, d.limite, d.ativo)
      .run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'Já existe um cupom com essa palavra-chave neste evento.');
    throw e;
  }
  await auditar(db, c.get('usuario').id, 'cupom_editado', `${d.codigo} ${d.tipo}`);
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
      `SELECT l.id, l.nome, l.valor_centavos, l.quantidade, l.vendidos, l.reservados, l.ativo, l.canal,
              (SELECT COUNT(*) FROM pedidos p WHERE p.lote_id = l.id AND p.status = 'pago') AS pedidos_pagos,
              COALESCE((SELECT SUM(p.subtotal_centavos - p.desconto_centavos) FROM pedidos p WHERE p.lote_id = l.id AND p.status = 'pago'), 0) AS receita_ingressos_centavos,
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

  // Cortesias por tipo (só ingressos não cancelados). DJ com 2 ingressos = 1 DJ + 1 acompanhante.
  const { results: gruposCort } = await db
    .prepare(
      `SELECT categoria, convite_id, motivo, COUNT(*) AS n FROM ingressos
        WHERE evento_id = ?1 AND tipo = 'cortesia' AND status <> 'cancelado' GROUP BY categoria, convite_id, motivo`,
    )
    .bind(eventoId)
    .all();
  const cortTipos = { amigo_parceiro: 0, aniversariante: 0, dj: 0, acompanhante_dj: 0, cupom: 0, outras: 0 };
  for (const g of gruposCort) {
    if (g.categoria === 'dj') {
      cortTipos.dj += Math.min(g.n, 1);
      cortTipos.acompanhante_dj += Math.max(0, g.n - 1);
    } else if (g.categoria === 'aniversariante') cortTipos.aniversariante += g.n;
    else if (g.categoria === 'convidado') cortTipos.amigo_parceiro += g.n;
    else if (String(g.motivo).startsWith('Cupom')) cortTipos.cupom += g.n;
    else cortTipos.outras += g.n;
  }
  const aguardando = await db
    .prepare(`SELECT COALESCE(SUM(quantidade), 0) AS n FROM convites WHERE evento_id = ?1 AND status = 'pendente'`)
    .bind(eventoId)
    .first();

  const formas = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN forma_pagamento = 'pix_chave' OR (forma_pagamento = 'mercadopago' AND mp_tipo = 'bank_transfer')
                           THEN total_centavos END), 0) AS pix,
         COALESCE(SUM(CASE WHEN forma_pagamento = 'cartao' OR (forma_pagamento = 'mercadopago' AND COALESCE(mp_tipo, '') <> 'bank_transfer')
                           THEN total_centavos END), 0) AS cartao,
         COALESCE(SUM(CASE WHEN forma_pagamento = 'dinheiro' THEN total_centavos END), 0) AS dinheiro,
         COALESCE(SUM(desconto_centavos), 0) AS descontos
         FROM pedidos WHERE evento_id = ?1 AND status = 'pago'`,
    )
    .bind(eventoId)
    .first();
  const { results: porForma } = await db
    .prepare(
      `SELECT canal, forma_pagamento AS forma, COUNT(*) AS pedidos, SUM(quantidade) AS ingressos,
              SUM(total_centavos) AS total_centavos
         FROM pedidos WHERE evento_id = ?1 AND status = 'pago' GROUP BY canal, forma_pagamento`,
    )
    .bind(eventoId)
    .all();
  const { results: porVendedor } = await db
    .prepare(
      `SELECT u.nome || ' ' || u.sobrenome AS vendedor, p.forma_pagamento AS forma, COUNT(*) AS pedidos,
              SUM(p.quantidade) AS ingressos, SUM(p.total_centavos) AS total_centavos
         FROM pedidos p JOIN usuarios u ON u.id = p.vendedor_id
        WHERE p.evento_id = ?1 AND p.status = 'pago' AND p.canal = 'porta'
        GROUP BY p.vendedor_id, p.forma_pagamento ORDER BY vendedor`,
    )
    .bind(eventoId)
    .all();

  const soma = (campo) => lotes.reduce((a, l) => a + l[campo], 0);
  const receitaIngressos = soma('receita_ingressos_centavos');
  const taxaServico = soma('taxa_servico_centavos');

  return c.json({
    evento,
    resumo: {
      pedidos_pagos: soma('pedidos_pagos'),
      ingressos_vendidos: ing.pagos ?? 0,
      cortesias: ing.cortesias ?? 0,
      cortesias_tipos: cortTipos,
      cortesias_aguardando: aguardando.n ?? 0,
      entraram: ing.entraram ?? 0,
      receita_ingressos_centavos: receitaIngressos,
      taxa_servico_centavos: taxaServico,
      total_recebido_centavos: receitaIngressos + taxaServico,
      recebido_pix_centavos: formas.pix,
      recebido_cartao_centavos: formas.cartao,
      recebido_dinheiro_centavos: formas.dinheiro,
      descontos_cupom_centavos: formas.descontos,
      a_receber_centavos: pend.total,
      pedidos_aguardando: pend.pedidos,
      ingressos_aguardando: pend.ingressos,
      pedidos_vencidos: venc.pedidos,
      valor_vencido_centavos: venc.total,
      pedidos_cancelados: canc.pedidos,
      observacao: 'Pix recebido na chave: sem taxa de gateway. Valores em centavos.',
    },
    lotes,
    por_forma: porForma,
    por_vendedor: porVendedor,
  });
});


// ---------- Senha de desbloqueio da portaria (PIN) ----------
r.put('/admin/pin', async (c) => {
  const b = await corpo(c);
  const pin = v.texto(b.pin, 'Senha de desbloqueio', 4, 12);
  await c.env.DB.prepare(
    `INSERT INTO config (chave, valor) VALUES ('pin_hash', ?1) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
  )
    .bind(await hmacHex(c.env.PEPPER, `pin|${pin}`))
    .run();
  await auditar(c.env.DB, c.get('usuario').id, 'pin_definido');
  return c.json({ ok: true });
});

// ---------- Flyer da tela de agradecimento ----------
const TIPOS_IMG = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
r.put('/admin/flyer', async (c) => {
  const b = await corpo(c);
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.imagem ?? ''));
  if (!m) throw new HttpError(400, 'Envie uma imagem JPG, PNG ou WebP.');
  let bin;
  try { bin = atob(m[2]); } catch { throw new HttpError(400, 'Imagem inválida.'); }
  if (bin.length > 1_500_000) throw new HttpError(413, 'Imagem grande demais (máx. 1,5 MB).');
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  if (!TIPOS_IMG[m[1]].every((x, i) => bytes[i] === x)) throw new HttpError(400, 'O arquivo não parece ser uma imagem válida.');
  await c.env.DB.prepare(
    `INSERT INTO arquivos (nome, tipo, dados, atualizado_em) VALUES ('flyer', ?1, ?2, ?3)
     ON CONFLICT(nome) DO UPDATE SET tipo = excluded.tipo, dados = excluded.dados, atualizado_em = excluded.atualizado_em`,
  )
    .bind(m[1], bytes, agora())
    .run();
  await auditar(c.env.DB, c.get('usuario').id, 'flyer_trocado');
  return c.json({ ok: true });
});
r.delete('/admin/flyer', async (c) => {
  await c.env.DB.prepare(`DELETE FROM arquivos WHERE nome = 'flyer'`).run();
  await auditar(c.env.DB, c.get('usuario').id, 'flyer_padrao');
  return c.json({ ok: true });
});

// ---------- Avisos (alertas) e push ----------
r.get('/admin/alertas', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, tipo, detalhe, criado_em, lido_em FROM alertas ORDER BY id DESC LIMIT 100').all();
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM alertas WHERE lido_em IS NULL').first();
  // Avisos de pedido trazem o pedido (situação de agora), para o admin confirmar o Pix direto do aviso.
  const codigoDe = (a) => (/^(?:Novo pedido|Pedido) ([A-Z0-9]{6})\b/.exec(a.detalhe) || [])[1];
  const codigos = [...new Set(results.map(codigoDe).filter(Boolean))];
  const pedidos = new Map();
  if (codigos.length) {
    const { results: ps } = await c.env.DB.prepare(
      `SELECT id, codigo, status, expira_em FROM pedidos WHERE codigo IN (${codigos.map((_, i) => `?${i + 1}`).join(',')})`,
    )
      .bind(...codigos)
      .all();
    const t = agora();
    for (const p of ps) pedidos.set(p.codigo, { id: p.id, codigo: p.codigo, status: p.status === 'aguardando_pagamento' && p.expira_em < t ? 'expirado' : p.status });
  }
  return c.json({ alertas: results.map((a) => ({ ...a, pedido: pedidos.get(codigoDe(a)) || null })), nao_lidos: n.n });
});

// Usado pelo service worker ao receber o "toque" do push: devolve o aviso mais recente não lido.
r.get('/admin/alertas/pendentes', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, tipo, detalhe, criado_em FROM alertas WHERE lido_em IS NULL ORDER BY id DESC LIMIT 5').all();
  return c.json({ alertas: results });
});

r.post('/admin/alertas/lidos', async (c) => {
  await c.env.DB.prepare('UPDATE alertas SET lido_em = ?1 WHERE lido_em IS NULL').bind(agora()).run();
  return c.json({ ok: true });
});

r.get('/admin/push/chave', async (c) => c.json({ publica: (await chavesVapid(c.env.DB)).publica }));

r.get('/admin/push/estado', async (c) => {
  const endpoint = String(c.req.query('endpoint') ?? '');
  const linha = await c.env.DB.prepare('SELECT 1 AS ok FROM push_assinaturas WHERE endpoint = ?1 AND usuario_id = ?2')
    .bind(endpoint, c.get('usuario').id)
    .first();
  return c.json({ registrado: !!linha });
});

r.post('/admin/push/assinar', async (c) => {
  const b = await corpo(c);
  const endpoint = String(b.endpoint ?? '');
  if (!/^https:\/\/[^\s]{10,1000}$/.test(endpoint)) throw new HttpError(400, 'Assinatura de notificação inválida.');
  await c.env.DB.prepare(
    `INSERT INTO push_assinaturas (usuario_id, endpoint, criado_em) VALUES (?1, ?2, ?3)
     ON CONFLICT(endpoint) DO UPDATE SET usuario_id = excluded.usuario_id`,
  )
    .bind(c.get('usuario').id, endpoint, agora())
    .run();
  return c.json({ ok: true });
});

r.post('/admin/push/cancelar', async (c) => {
  const b = await corpo(c);
  await c.env.DB.prepare('DELETE FROM push_assinaturas WHERE endpoint = ?1 AND usuario_id = ?2')
    .bind(String(b.endpoint ?? ''), c.get('usuario').id)
    .run();
  return c.json({ ok: true });
});

r.post('/admin/push/teste', async (c) => {
  await c.env.DB.prepare('INSERT INTO alertas (tipo, detalhe, criado_em) VALUES (?1, ?2, ?3)')
    .bind('teste', 'Aviso de teste: as notificações estão funcionando.', agora())
    .run();
  const envio = await enviarPush(c.env.DB, new URL(c.req.url).origin);
  return c.json(envio);
});

// ---------- Cortesias por convite nominal (DJ, aniversariante, amigo/parceiro) ----------
// O admin cadastra a pessoa. O ingresso só nasce quando ela entra no app com o telefone
// (ou e-mail) informado aqui. Convite pendente não vence.
function lerConvite(b, { parcial = false } = {}) {
  const d = {};
  if (!parcial || b.categoria !== undefined) {
    if (!CATEGORIAS_CONVITE.includes(b.categoria)) throw new HttpError(400, 'Escolha a categoria: DJ, aniversariante ou amigo/parceiro.');
    d.categoria = b.categoria;
  }
  if (!parcial || b.nome !== undefined) d.nome = v.texto(b.nome, 'Nome', 2, 80);
  if (!parcial || b.telefone !== undefined) d.telefone = v.telefone(b.telefone);
  if (!parcial || b.email !== undefined) d.email = String(b.email ?? '').trim() ? v.email(b.email) : null;
  if (!parcial || b.quantidade !== undefined) d.quantidade = v.inteiro(b.quantidade ?? 1, 'Quantidade de ingressos', 1, 4);
  if (!parcial || b.nascimento !== undefined) {
    const n = String(b.nascimento ?? '').trim();
    if (n) {
      const dt = new Date(`${n}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(n) || Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== n || n > new Date().toISOString().slice(0, 10) || n < '1900-01-01') {
        throw new HttpError(400, 'Data de nascimento inválida.');
      }
      d.nascimento = n;
    } else d.nascimento = null;
  }
  return d;
}

r.post('/admin/convites', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const d = lerConvite(b);
  if (d.categoria === 'aniversariante' && !d.nascimento) throw new HttpError(400, 'Informe a data de nascimento do aniversariante.');
  if (d.categoria !== 'aniversariante') d.nascimento = null;
  const ev = await db.prepare('SELECT id FROM eventos WHERE ativo = 1 ORDER BY data_evento LIMIT 1').first();
  if (!ev) throw new HttpError(409, 'Nenhum evento ativo.');
  const dup = await db
    .prepare(`SELECT nome FROM convites WHERE evento_id = ?1 AND telefone = ?2 AND categoria = ?3 AND status <> 'cancelado'`)
    .bind(ev.id, d.telefone, d.categoria)
    .first();
  if (dup) throw new HttpError(409, `Já existe um convite desta categoria para este telefone (${dup.nome}).`);
  const token = aleatorioHex(16);
  const res = await db
    .prepare(
      `INSERT INTO convites (evento_id, categoria, nome, telefone, email, nascimento, quantidade, token, criado_por, criado_em)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(ev.id, d.categoria, d.nome, d.telefone, d.email, d.nascimento, d.quantidade, token, c.get('usuario').id, agora())
    .run();
  await auditar(db, c.get('usuario').id, 'convite_criado', `${d.categoria} ${d.nome} x${d.quantidade}`);
  // Se a pessoa já tem conta com esse telefone/e-mail, o ingresso aparece na hora.
  const conta = await db
    .prepare(`SELECT id, telefone, email FROM usuarios WHERE ativo = 1 AND (telefone = ?1 OR (?2 IS NOT NULL AND lower(email) = ?2)) LIMIT 1`)
    .bind(d.telefone, d.email)
    .first();
  let resgatado = false;
  if (conta) resgatado = await resgatarPendentes(db, conta).then((n) => n > 0).catch(() => false);
  return c.json({ ok: true, id: res.meta.last_row_id, token, resgatado, telefone: d.telefone }, 201);
});

r.get('/admin/convites', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.categoria, c.nome, c.telefone, c.email, c.nascimento, c.quantidade, c.token, c.status, c.criado_em, c.resgatado_em,
            COALESCE(u.nome || ' ' || u.sobrenome, CASE WHEN c.status = 'resgatado' THEN 'baixa na portaria' END) AS conta,
            (SELECT COUNT(*) FROM ingressos i WHERE i.convite_id = c.id AND i.status = 'usado') AS entraram,
            (SELECT COUNT(*) FROM ingressos i WHERE i.convite_id = c.id AND i.status = 'valido') AS validos
       FROM convites c LEFT JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.evento_id = (SELECT id FROM eventos WHERE ativo = 1 ORDER BY data_evento LIMIT 1) AND c.excluido_em IS NULL
      ORDER BY c.id DESC LIMIT 300`,
  ).all();
  const evento = await c.env.DB.prepare('SELECT nome, data_evento FROM eventos WHERE ativo = 1 ORDER BY data_evento LIMIT 1').first();
  return c.json({ convites: results, evento });
});

// Edita um convite. Pendente: qualquer campo. Já resgatado: nome, categoria e quantidade ajustam os ingressos
// da própria conta; trocar celular/e-mail devolve o convite a "pendente" (ingressos não usados são cancelados)
// e ele é liberado de novo para a conta do novo contato, se já existir.
r.put('/admin/convites/:id', async (c) => {
  const id = v.inteiro(c.req.param('id'), 'Convite', 1, 1_000_000_000);
  const db = c.env.DB;
  const atual = await db.prepare('SELECT * FROM convites WHERE id = ?1').bind(id).first();
  if (!atual) throw new HttpError(404, 'Convite não encontrado.');
  if (atual.status === 'cancelado') throw new HttpError(409, 'Convite cancelado não pode ser editado. Cadastre outro.');
  const b = await corpo(c);
  const d = lerConvite(b, { parcial: true });
  const novo = { ...atual, ...d };
  if (novo.categoria === 'aniversariante' && !novo.nascimento) throw new HttpError(400, 'Informe a data de nascimento do aniversariante.');
  if (novo.categoria !== 'aniversariante') novo.nascimento = null;
  const campos = `categoria = ?2, nome = ?3, telefone = ?4, email = ?5, nascimento = ?6, quantidade = ?7`;
  const vals = [id, novo.categoria, novo.nome, novo.telefone, novo.email, novo.nascimento, novo.quantidade];

  if (atual.status === 'resgatado') {
    const mudouContato = novo.telefone !== atual.telefone || (novo.email || null) !== (atual.email || null);
    const cnt = await db
      .prepare(
        `SELECT SUM(status = 'usado') AS usados, SUM(status = 'valido') AS validos FROM ingressos WHERE convite_id = ?1`,
      )
      .bind(id)
      .first();
    const usados = cnt?.usados || 0;
    const validos = cnt?.validos || 0;
    if (mudouContato) {
      if (usados > 0) throw new HttpError(409, 'Já entrou gente com esta cortesia na portaria, então não dá para trocar o celular ou e-mail.');
      await db.batch([
        db.prepare(`UPDATE ingressos SET status = 'cancelado' WHERE convite_id = ?1 AND status = 'valido'`).bind(id),
        db.prepare(`UPDATE convites SET ${campos}, status = 'pendente', usuario_id = NULL, resgatado_em = NULL WHERE id = ?1 AND status = 'resgatado'`).bind(...vals),
      ]);
      await auditar(db, c.get('usuario').id, 'convite_contato_trocado', `${novo.nome} (#${id})`);
      // segue para a liberação automática abaixo
    } else {
      const diff = novo.quantidade - (usados + validos);
      if (diff > 0 && !atual.usuario_id) throw new HttpError(409, 'Esta cortesia foi baixada na portaria, sem conta. Para liberar mais ingressos, cadastre outra cortesia.');
      if (diff < 0 && validos < -diff) throw new HttpError(409, 'Só dá para reduzir ingressos que ainda não foram usados na portaria.');
      const ops = [db.prepare(`UPDATE convites SET ${campos} WHERE id = ?1 AND status = 'resgatado'`).bind(...vals)];
      if (diff < 0) {
        ops.push(
          db.prepare(`UPDATE ingressos SET status = 'cancelado' WHERE id IN (SELECT id FROM ingressos WHERE convite_id = ?1 AND status = 'valido' ORDER BY id DESC LIMIT ?2)`).bind(id, -diff),
        );
      }
      for (let n = 0; n < diff; n++) {
        ops.push(
          db
            .prepare(
              `INSERT INTO ingressos (pedido_id, evento_id, lote_id, dono_id, tipo, status, criado_em, motivo, categoria, convite_id)
               VALUES (NULL, ?1, NULL, ?2, 'cortesia', 'valido', ?3, ?4, ?5, ?6)`,
            )
            .bind(atual.evento_id, atual.usuario_id, agora(), ROTULO_CATEGORIA[novo.categoria], novo.categoria, id),
        );
      }
      if (novo.categoria !== atual.categoria) {
        ops.push(db.prepare(`UPDATE ingressos SET motivo = ?2, categoria = ?3 WHERE convite_id = ?1 AND status = 'valido'`).bind(id, ROTULO_CATEGORIA[novo.categoria], novo.categoria));
      }
      await db.batch(ops);
      await auditar(db, c.get('usuario').id, 'convite_editado', `${novo.nome} (#${id}, resgatado, ${diff >= 0 ? '+' : ''}${diff} ingresso(s))`);
      return c.json({ ok: true, resgatado: true, ajustado: true });
    }
  } else {
    await db.prepare(`UPDATE convites SET ${campos} WHERE id = ?1 AND status = 'pendente'`).bind(...vals).run();
    await auditar(db, c.get('usuario').id, 'convite_editado', `${novo.nome} (#${id})`);
  }
  const conta = await db
    .prepare(`SELECT id, telefone, email FROM usuarios WHERE ativo = 1 AND (telefone = ?1 OR (?2 IS NOT NULL AND lower(email) = ?2)) LIMIT 1`)
    .bind(novo.telefone, novo.email)
    .first();
  let resgatado = false;
  if (conta) resgatado = await resgatarPendentes(db, conta).then((n) => n > 0).catch(() => false);
  return c.json({ ok: true, resgatado });
});

// Cancela o convite; se já foi resgatado, cancela também os ingressos que ainda não foram usados.
r.post('/admin/convites/:id/cancelar', async (c) => {
  const id = v.inteiro(c.req.param('id'), 'Convite', 1, 1_000_000_000);
  const db = c.env.DB;
  const cv = await db.prepare('SELECT status, nome FROM convites WHERE id = ?1').bind(id).first();
  if (!cv) throw new HttpError(404, 'Convite não encontrado.');
  if (cv.status === 'cancelado') throw new HttpError(409, 'Este convite já está cancelado.');
  await db.batch([
    db.prepare(`UPDATE convites SET status = 'cancelado' WHERE id = ?1`).bind(id),
    db.prepare(`UPDATE ingressos SET status = 'cancelado' WHERE convite_id = ?1 AND status = 'valido'`).bind(id),
  ]);
  await auditar(db, c.get('usuario').id, 'convite_cancelado', `${cv.nome} (#${id})`);
  return c.json({ ok: true });
});

// Exclui a cortesia: some da lista e os ingressos ainda não usados deixam de valer. Quem já entrou na festa
// não pode ser apagado (é presença real): para isso, a portaria precisa desfazer a entrada antes.
// O registro fica no banco e a ação fica na auditoria.
r.delete('/admin/convites/:id', async (c) => {
  const id = v.inteiro(c.req.param('id'), 'Convite', 1, 1_000_000_000);
  const db = c.env.DB;
  const cv = await db.prepare('SELECT id, nome, status FROM convites WHERE id = ?1 AND excluido_em IS NULL').bind(id).first();
  if (!cv) throw new HttpError(404, 'Convite não encontrado.');
  const barrado = new HttpError(409, 'Esta cortesia já entrou na festa e não pode ser excluída.');
  const afetados = await db.prepare(`SELECT COUNT(*) AS n FROM ingressos WHERE convite_id = ?1 AND status = 'valido'`).bind(id).first();
  // A própria condição do UPDATE confere de novo (atômico): se alguém entrou agora há pouco, não exclui.
  const res = await db
    .prepare(
      `UPDATE convites SET status = 'cancelado', excluido_em = ?2
        WHERE id = ?1 AND excluido_em IS NULL AND NOT EXISTS (SELECT 1 FROM ingressos WHERE convite_id = ?1 AND status = 'usado')`,
    )
    .bind(id, agora())
    .run();
  if (res.meta.changes !== 1) throw barrado;
  await db.prepare(`UPDATE ingressos SET status = 'cancelado' WHERE convite_id = ?1 AND status = 'valido'`).bind(id).run();
  await auditar(db, c.get('usuario').id, 'convite_excluido', `${cv.nome} (${afetados?.n ?? 0} ingresso(s) cancelado(s))`);
  return c.json({ ok: true });
});

r.post('/admin/cortesias/:id/cancelar', async (c) => {
  const id = v.inteiro(c.req.param('id'), 'Ingresso', 1, 1_000_000_000);
  const res = await c.env.DB.prepare(
    `UPDATE ingressos SET status = 'cancelado' WHERE id = ?1 AND tipo = 'cortesia' AND status = 'valido'`,
  )
    .bind(id)
    .run();
  if (res.meta.changes !== 1) throw new HttpError(409, 'Só cortesias ainda válidas podem ser canceladas.');
  await auditar(c.env.DB, c.get('usuario').id, 'cortesia_cancelada', String(id));
  return c.json({ ok: true });
});

// Auditoria: o que cada administrador e cada pessoa da portaria fez, do mais recente para o mais antigo.
// Só leitura. Paginada: "antes" é o id do último item já carregado.
r.get('/admin/auditoria', async (c) => {
  const papel = ['admin', 'hostess'].includes(c.req.query('papel')) ? c.req.query('papel') : '';
  const antes = Math.max(0, Number.parseInt(c.req.query('antes') ?? '0', 10) || 0);
  const LIM = 100;
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.acao, a.detalhe, a.criado_em, u.nome, u.sobrenome, u.papel
       FROM auditoria a JOIN usuarios u ON u.id = a.usuario_id
      WHERE u.papel IN ('admin', 'hostess') AND (?1 = '' OR u.papel = ?1) AND (?2 = 0 OR a.id < ?2)
      ORDER BY a.id DESC LIMIT ?3`,
  )
    .bind(papel, antes, LIM + 1)
    .all();
  const mais = results.length > LIM;
  const itens = results.slice(0, LIM);
  return c.json({ itens, mais, proximo: mais ? itens[itens.length - 1].id : null });
});

export default r;
