// Testes de ponta a ponta contra `wrangler dev --local` (porta 8787) com D1 local.
// Rode: npm test   (com o servidor local no ar e o banco recém-migrado)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8787';
const SETUP_KEY = 'setup-de-teste';

function cpfAleatorio() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (d.every((x) => x === d[0])) d[0] = (d[0] + 1) % 10;
  for (let n = 9; n <= 10; n++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[i] * (n + 1 - i);
    d.push(((s * 10) % 11) % 10);
  }
  return d.join('');
}
const derivada = (s) => createHash('sha256').update(s).digest('hex');

class Cliente {
  cookie = '';
  async req(metodo, caminho, corpo) {
    const r = await fetch(BASE + caminho, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, json };
  }
  get = (p) => this.req('GET', p);
  post = (p, b = {}) => this.req('POST', p, b);
  put = (p, b = {}) => this.req('PUT', p, b);
}

function dados(extra = {}) {
  const cpf = cpfAleatorio();
  return { cpf, nome: 'Fulano', sobrenome: 'Teste', email: `f${cpf}@x.com`, telefone: '11988887777', senha: derivada('s' + cpf), ...extra };
}
async function novoComprador() {
  const d = dados();
  const c = new Cliente();
  const r = await c.post('/api/auth/cadastro', d);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { c, d };
}
const sql = (q) => execSync(`npx wrangler d1 execute ingressos --local --command "${q}"`, { stdio: 'pipe' });

const admin = new Cliente();
const adminDados = dados();
let loteId, eventoId;

test('cpf inválido é recusado e dígitos repetidos também', async () => {
  const c = new Cliente();
  assert.equal((await c.post('/api/auth/cadastro', dados({ cpf: '12345678900' }))).status, 400);
  assert.equal((await c.post('/api/auth/cadastro', dados({ cpf: '11111111111' }))).status, 400);
});

test('setup do admin: chave errada 403, certa 201, segunda vez 409', async () => {
  const c = new Cliente();
  assert.equal((await c.post('/api/setup/admin', { ...adminDados, setup_key: 'errada' })).status, 403);
  const r = await c.post('/api/setup/admin', { ...adminDados, setup_key: SETUP_KEY });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal((await c.post('/api/setup/admin', { ...dados(), setup_key: SETUP_KEY })).status, 409);
  const l = await admin.post('/api/auth/login', { cpf: adminDados.cpf, senha: adminDados.senha });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  assert.equal((await admin.get('/api/me')).json.usuario?.papel ?? (await admin.get('/api/me')).json.papel, 'admin');
});

test('autorização: sem login 401, comprador em rota admin 403', async () => {
  assert.equal((await new Cliente().get('/api/admin/config')).status, 401);
  const { c } = await novoComprador();
  assert.equal((await c.get('/api/admin/config')).status, 403);
  assert.equal((await c.get('/api/admin/financeiro')).status, 403);
});

test('login: erro genérico e bloqueio após 5 falhas', async () => {
  const { d } = await novoComprador();
  const c = new Cliente();
  for (let i = 0; i < 5; i++) {
    assert.equal((await c.post('/api/auth/login', { cpf: d.cpf, senha: derivada('x' + i) })).status, 401);
  }
  assert.equal((await c.post('/api/auth/login', { cpf: d.cpf, senha: d.senha })).status, 429);
});

test('escrita sem JSON é recusada', async () => {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
});

test('admin configura Pix, evento e lote', async () => {
  let r = await admin.put('/api/admin/config', { pix_chave: '+5511999990000', pix_nome: 'Os Brothers', pix_cidade: 'SAO PAULO', reserva_minutos: 60 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  eventoId = (await admin.get('/api/admin/eventos')).json.eventos[0].id;
  r = await admin.post('/api/admin/lotes', { evento_id: eventoId, nome: 'Teste 5', valor_centavos: 3500, quantidade: 5, ativo: true });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  loteId = r.json.id;
  const ev = await new Cliente().get('/api/evento');
  const lote = ev.json.lotes.find((l) => l.id === loteId);
  assert.equal(lote.disponiveis, 5);
  assert.equal(lote.total_centavos ?? lote.total_por_ingresso_centavos, 3850);
});

test('pedido de 2 ingressos: valores e Pix', async () => {
  const { c } = await novoComprador();
  const r = await c.post('/api/pedidos', { lote_id: loteId, quantidade: 2, nome_pagador: 'Fulano de Tal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.subtotal_centavos, 7000);
  assert.equal(r.json.taxa_centavos, 700);
  assert.equal(r.json.total_centavos, 7700);
  assert.ok(r.json.pix?.copia_e_cola?.startsWith('000201'), JSON.stringify(r.json.pix));
  // cancelar libera a reserva
  const cc = await c.post(`/api/pedidos/${r.json.codigo}/cancelar`);
  assert.equal(cc.status, 200);
  const ev = await new Cliente().get('/api/evento');
  assert.equal(ev.json.lotes.find((l) => l.id === loteId).disponiveis, 5);
});

test('concorrência: 12 pedidos de 1 ingresso num lote de 5 → exatamente 5', async () => {
  const clientes = [];
  for (let i = 0; i < 12; i++) clientes.push((await novoComprador()).c);
  const rs = await Promise.all(
    clientes.map((c) => c.post('/api/pedidos', { lote_id: loteId, quantidade: 1, nome_pagador: 'Concorrente' })),
  );
  const ok = rs.filter((r) => r.status === 201).length;
  assert.equal(ok, 5, rs.map((r) => r.status).join(','));
  assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409), rs.map((r) => r.status).join(','));
  globalThis.__pedidosConc = rs.filter((r) => r.status === 201).map((r) => r.json);
});

test('confirmação: idempotente, gera QRs únicos, financeiro bate', async () => {
  const ped = globalThis.__pedidosConc;
  const lista = (await admin.get('/api/admin/pedidos')).json.pedidos;
  const alvo = lista.find((p) => p.codigo === ped[0].codigo);
  assert.ok(alvo, 'pedido na lista admin');
  for (let i = 0; i < 2; i++) {
    const r = await admin.post(`/api/admin/pedidos/${alvo.id}/confirmar`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const f = (await admin.get('/api/admin/financeiro')).json.resumo;
  assert.equal(f.pedidos_pagos, 1);
  assert.equal(f.ingressos_vendidos, 1);
  assert.equal(f.receita_ingressos_centavos, 3500);
  assert.equal(f.taxa_servico_centavos, 350);
  assert.equal(f.total_recebido_centavos, 3850);
  assert.equal(f.ingressos_aguardando, 4);
});

test('QR únicos entre ingressos de um pedido de vários', async () => {
  // libera lote: aumenta quantidade e compra 3
  await admin.put(`/api/admin/lotes/${loteId}`, { quantidade: 20 });
  const { c } = await novoComprador();
  const r = await c.post('/api/pedidos', { lote_id: loteId, quantidade: 3, nome_pagador: 'Trio Teste' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const id = (await admin.get('/api/admin/pedidos')).json.pedidos.find((p) => p.codigo === r.json.codigo).id;
  assert.equal((await admin.post(`/api/admin/pedidos/${id}/confirmar`)).status, 200);
  const ing = (await c.get('/api/meus-ingressos')).json.ingressos;
  assert.equal(ing.length, 3);
  assert.equal(new Set(ing.map((i) => i.qr)).size, 3);
  assert.ok(ing.every((i) => /^\d+\.[0-9a-f]{32}$/.test(i.qr)), JSON.stringify(ing));
  // estorno cancela ingressos
  assert.equal((await admin.post(`/api/admin/pedidos/${id}/cancelar`)).status, 200);
  const dep = (await c.get('/api/meus-ingressos')).json.ingressos;
  assert.ok(dep.every((i) => i.status === 'cancelado' && i.qr === null));
});

test('expiração: reserva vencida devolve estoque; confirmação tardia respeita estoque', async () => {
  const { c } = await novoComprador();
  const r = await c.post('/api/pedidos', { lote_id: loteId, quantidade: 1, nome_pagador: 'Atrasado' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  sql(`UPDATE pedidos SET expira_em = 1 WHERE codigo = '${r.json.codigo}'`);
  const ev = await new Cliente().get('/api/evento'); // dispara liberarExpirados
  assert.ok(ev.status === 200);
  const p = (await c.get(`/api/pedidos/${r.json.codigo}`)).json;
  assert.equal(p.status, 'expirado');
  const id = (await admin.get('/api/admin/pedidos')).json.pedidos.find((x) => x.codigo === r.json.codigo).id;
  const tarde = await admin.post(`/api/admin/pedidos/${id}/confirmar`);
  assert.equal(tarde.status, 200, JSON.stringify(tarde.json)); // há estoque
  assert.equal((await c.get(`/api/pedidos/${r.json.codigo}`)).json.status, 'pago');
});

test('esqueci a senha: admin define provisória e usuário precisa trocar', async () => {
  const { d } = await novoComprador();
  await new Cliente().post('/api/auth/esqueci', { cpf: d.cpf });
  const resets = (await admin.get('/api/admin/resets')).json;
  assert.ok(JSON.stringify(resets).includes(d.nome));
  const u = (await admin.get('/api/admin/usuarios')).json.usuarios.find((x) => x.cpf === d.cpf);
  const nova = derivada('nova' + d.cpf);
  assert.equal((await admin.post(`/api/admin/usuarios/${u.id}/definir-senha`, { senha: nova })).status, 200);
  const c = new Cliente();
  assert.equal((await c.post('/api/auth/login', { cpf: d.cpf, senha: nova })).status, 200);
  const me = (await c.get('/api/me')).json;
  assert.ok(JSON.stringify(me).includes('"deve_trocar_senha":true') || JSON.stringify(me).includes('"deve_trocar_senha":1'), JSON.stringify(me));
});
