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
  return { cpf, nome: 'Fulano', sobrenome: 'Teste', email: `f${cpf}@x.com`, telefone: '11988887777', senha: derivada('s' + cpf), resposta: derivada('r' + cpf), ...extra };
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
  const r = await c.post('/api/pedidos', { aceito_termos: true, lote_id: loteId, quantidade: 2, nome_pagador: 'Fulano de Tal' });
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
    clientes.map((c) => c.post('/api/pedidos', { aceito_termos: true, lote_id: loteId, quantidade: 1, nome_pagador: 'Concorrente' })),
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
  const r = await c.post('/api/pedidos', { aceito_termos: true, lote_id: loteId, quantidade: 3, nome_pagador: 'Trio Teste' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const id = (await admin.get('/api/admin/pedidos')).json.pedidos.find((p) => p.codigo === r.json.codigo).id;
  assert.equal((await admin.post(`/api/admin/pedidos/${id}/confirmar`)).status, 200);
  const ing = (await c.get('/api/meus-ingressos')).json.ingressos;
  assert.equal(ing.length, 3);
  assert.equal(new Set(ing.map((i) => i.qr)).size, 3);
  assert.ok(ing.every((i) => /^\d+\.\d+\.[0-9a-f]{32}$/.test(i.qr)), JSON.stringify(ing));
  // estorno cancela ingressos
  assert.equal((await admin.post(`/api/admin/pedidos/${id}/cancelar`)).status, 200);
  const dep = (await c.get('/api/meus-ingressos')).json.ingressos;
  assert.ok(dep.every((i) => i.status === 'cancelado' && i.qr === null));
});

test('expiração: reserva vencida devolve estoque; confirmação tardia respeita estoque', async () => {
  const { c } = await novoComprador();
  const r = await c.post('/api/pedidos', { aceito_termos: true, lote_id: loteId, quantidade: 1, nome_pagador: 'Atrasado' });
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

// ---------- Fase 2: portaria, transferência e cortesias ----------
const sha = (t) => createHash('sha256').update(t).digest('hex');

async function comprarEConfirmar(qtd) {
  const { c, d } = await novoComprador();
  const r = await c.post('/api/pedidos', { aceito_termos: true, lote_id: loteId, quantidade: qtd, nome_pagador: 'Pagador Teste' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const id = (await admin.get('/api/admin/pedidos')).json.pedidos.find((p) => p.codigo === r.json.codigo).id;
  assert.equal((await admin.post(`/api/admin/pedidos/${id}/confirmar`)).status, 200);
  return { c, d, ingressos: (await c.get('/api/meus-ingressos')).json.ingressos };
}

let hostess;
test('admin cadastra hostess e ela entra', async () => {
  const d = dados();
  const r = await admin.post('/api/admin/usuarios', { ...d, papel: 'hostess' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  hostess = new Cliente();
  assert.equal((await hostess.post('/api/auth/login', { cpf: d.cpf, senha: d.senha })).status, 200);
  assert.equal((await hostess.get('/api/admin/config')).status, 403); // hostess não é admin
});

test('portaria: só hostess/admin; QR vale uma vez; adulterado é inválido', async () => {
  const { c, ingressos } = await comprarEConfirmar(2);
  assert.equal((await c.post('/api/portaria/validar', { qr: ingressos[0].qr })).status, 403);
  assert.equal((await new Cliente().post('/api/portaria/validar', { qr: ingressos[0].qr })).status, 401);

  const lista = (await hostess.get('/api/portaria/lista')).json;
  const item = lista.ingressos.find((i) => i.id === ingressos[0].id);
  assert.equal(item.h, sha(ingressos[0].qr)); // lista offline = hash do QR
  assert.ok(!JSON.stringify(lista).includes(ingressos[0].qr)); // QR em si nunca vai na lista

  const a = (await hostess.post('/api/portaria/validar', { qr: ingressos[0].qr })).json;
  assert.equal(a.resultado, 'ok');
  assert.ok(a.nome);
  const b = (await hostess.post('/api/portaria/validar', { qr: ingressos[0].qr })).json;
  assert.equal(b.resultado, 'usado');
  assert.ok(b.usado_em);
  const ruim = ingressos[1].qr.replace(/.$/, (x) => (x === '0' ? '1' : '0'));
  assert.equal((await hostess.post('/api/portaria/validar', { qr: ruim })).json.resultado, 'invalido');
  assert.equal((await hostess.post('/api/portaria/validar', { qr: 'lixo' })).json.resultado, 'invalido');

  // corrida: 6 leituras simultâneas do mesmo QR → exatamente uma entra
  const rs = await Promise.all(Array.from({ length: 6 }, () => hostess.post('/api/portaria/validar', { qr: ingressos[1].qr })));
  const oks = rs.filter((x) => x.json.resultado === 'ok').length;
  assert.equal(oks, 1, rs.map((x) => x.json.resultado).join(','));
});

test('portaria: sincronização offline e entrada manual', async () => {
  const { ingressos } = await comprarEConfirmar(3);
  const antes = Math.floor(Date.now() / 1000) - 600;
  const s = (await hostess.post('/api/portaria/sincronizar', {
    usos: [{ qr: ingressos[0].qr, em: antes }, { qr: ingressos[0].qr, em: antes + 5 }, { qr: 'x.y.z', em: antes }],
  })).json;
  assert.deepEqual(s.resultados.map((x) => x.resultado), ['ok', 'usado', 'invalido']);
  assert.equal(s.resultados[0].usado_em, antes); // guarda a hora real da entrada offline
  const m = (await hostess.post('/api/portaria/entrada-manual', { ingresso_id: ingressos[1].id })).json;
  assert.equal(m.resultado, 'ok');
  assert.equal((await hostess.post('/api/portaria/entrada-manual', { ingresso_id: ingressos[1].id })).json.resultado, 'usado');
});

test('ingresso cancelado não entra', async () => {
  const { c, ingressos } = await comprarEConfirmar(1);
  const id = (await admin.get('/api/admin/pedidos?status=pago')).json.pedidos[0].id; // pedido mais recente
  assert.equal((await admin.post(`/api/admin/pedidos/${id}/cancelar`)).status, 200);
  const r = (await hostess.post('/api/portaria/validar', { qr: ingressos[0].qr })).json;
  assert.equal(r.resultado, 'cancelado');
});

test('transferência: novo QR, antigo morre, link de uso único', async () => {
  const { c: dono, ingressos } = await comprarEConfirmar(1);
  const ing = ingressos[0];
  const t = await dono.post(`/api/ingressos/${ing.id}/transferir`);
  assert.equal(t.status, 201);
  assert.match(t.json.token, /^[0-9a-f]{32}$/);
  assert.equal((await new Cliente().get(`/api/transferencias/${t.json.token}`)).json.valida, true);
  assert.equal((await dono.post(`/api/transferencias/${t.json.token}/aceitar`)).status, 400); // não aceita o próprio
  assert.equal((await new Cliente().post(`/api/transferencias/${t.json.token}/aceitar`)).status, 401);

  const { c: amigo } = await novoComprador();
  assert.equal((await amigo.post(`/api/transferencias/${t.json.token}/aceitar`)).status, 200);
  const novo = (await amigo.get('/api/meus-ingressos')).json.ingressos.find((i) => i.id === ing.id);
  assert.ok(novo.qr && novo.qr !== ing.qr);
  assert.equal((await dono.get('/api/meus-ingressos')).json.ingressos.length, 0);
  assert.equal((await hostess.post('/api/portaria/validar', { qr: ing.qr })).json.resultado, 'invalido'); // QR antigo
  assert.equal((await new Cliente().get(`/api/transferencias/${t.json.token}`)).json.valida, false);
  const { c: outro } = await novoComprador();
  assert.equal((await outro.post(`/api/transferencias/${t.json.token}/aceitar`)).status, 409); // link já usado
  assert.equal((await amigo.post(`/api/ingressos/${ing.id}/transferir`)).status, 201); // novo dono pode repassar
  assert.equal((await hostess.post('/api/portaria/validar', { qr: novo.qr })).json.resultado, 'ok');
  assert.equal((await amigo.post(`/api/ingressos/${ing.id}/transferir`)).status, 409); // usado não transfere
});

test('cortesias: tudo ou nada, aparece para o dono e entra na portaria', async () => {
  const { c, d } = await novoComprador();
  const falha = await admin.post('/api/admin/cortesias', { motivo: 'DJ', itens: [{ email: d.email, quantidade: 2 }, { email: 'nao@existe.com' }] });
  assert.equal(falha.status, 409);
  assert.deepEqual(falha.json.ausentes, ['nao@existe.com']);
  assert.equal((await c.get('/api/meus-ingressos')).json.ingressos.length, 0); // nada emitido
  const ok = await admin.post('/api/admin/cortesias', { motivo: 'DJ + acompanhante', itens: [{ email: d.email, quantidade: 2 }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const ing = (await c.get('/api/meus-ingressos')).json.ingressos;
  assert.equal(ing.length, 2);
  assert.ok(ing.every((i) => i.tipo === 'cortesia' && i.motivo === 'DJ + acompanhante' && i.qr));
  assert.equal((await hostess.post('/api/portaria/validar', { qr: ing[0].qr })).json.resultado, 'ok');
  assert.equal((await admin.post(`/api/admin/cortesias/${ing[1].id}/cancelar`)).status, 200);
  assert.equal((await hostess.post('/api/portaria/validar', { qr: ing[1].qr })).json.resultado, 'cancelado');
  assert.equal((await c.post('/api/admin/cortesias', { itens: [] })).status, 403);
});

test('transferência: prazo de 48h antes da festa', async () => {
  const { c, ingressos } = await comprarEConfirmar(1);
  const ok = await c.post(`/api/ingressos/${ingressos[0].id}/transferir`);
  assert.equal(ok.status, 201);
  assert.ok(ingressos[0].transferivel_ate > Date.now() / 1000);
  const amanha = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const antigo = (await admin.get('/api/admin/eventos')).json.eventos.find((e) => e.id === eventoId).data_evento;
  assert.equal((await admin.put(`/api/admin/eventos/${eventoId}`, { data_evento: amanha })).status, 200);
  const bloq = await c.post(`/api/ingressos/${ingressos[0].id}/transferir`);
  assert.equal(bloq.status, 409);
  assert.match(bloq.json.erro, /encerradas/);
  // link já criado também deixa de valer (expirou no limite)
  assert.equal((await admin.put(`/api/admin/eventos/${eventoId}`, { data_evento: antigo, hora_inicio: '23:30' })).status, 200);
  assert.equal((await c.post(`/api/ingressos/${ingressos[0].id}/transferir`)).status, 201);
  assert.equal((await admin.put(`/api/admin/eventos/${eventoId}`, { hora_inicio: '25:99' })).status, 400);
});

// ---------- Fase 3: regras, resposta secreta, PIN, avisos ----------
test('compra exige aceite das regras', async () => {
  const { c } = await novoComprador();
  const r = await c.post('/api/pedidos', { lote_id: loteId, quantidade: 1, nome_pagador: 'Sem Aceite' });
  assert.equal(r.status, 400);
  assert.match(r.json.erro, /regras/);
});

test('cadastro exige resposta secreta; recuperar senha por ela', async () => {
  const d = dados();
  const { resposta, ...semResposta } = d;
  assert.equal((await new Cliente().post('/api/auth/cadastro', semResposta)).status, 400);
  const c = new Cliente();
  assert.equal((await c.post('/api/auth/cadastro', d)).status, 201);
  assert.equal((await c.get('/api/me')).json.tem_resposta, true);

  const novo = derivada('novissima' + d.cpf);
  const rec = new Cliente();
  assert.equal((await rec.post('/api/auth/recuperar', { cpf: d.cpf, resposta: derivada('errada'), senha_nova: novo })).status, 401);
  assert.equal((await rec.post('/api/auth/recuperar', { cpf: d.cpf, resposta: d.resposta, senha_nova: novo })).status, 200);
  assert.equal((await c.get('/api/me')).status, 401); // sessões antigas caem
  assert.equal((await new Cliente().post('/api/auth/login', { cpf: d.cpf, senha: d.senha })).status, 401); // senha antiga morreu
  assert.equal((await new Cliente().post('/api/auth/login', { cpf: d.cpf, senha: novo })).status, 200);
  // admin é avisado
  const av = (await admin.get('/api/admin/alertas')).json;
  assert.ok(av.alertas.some((a) => a.tipo === 'senha_recuperada' && a.detalhe.includes(d.nome)));
});

test('recuperação: 5 erros bloqueiam por 1h (mesmo com a resposta certa)', async () => {
  const { d } = await novoComprador();
  const c = new Cliente();
  for (let i = 0; i < 5; i++) {
    assert.equal((await c.post('/api/auth/recuperar', { cpf: d.cpf, resposta: derivada('x' + i), senha_nova: derivada('n') })).status, 401);
  }
  assert.equal((await c.post('/api/auth/recuperar', { cpf: d.cpf, resposta: d.resposta, senha_nova: derivada('n') })).status, 429);
  assert.equal((await c.post('/api/auth/recuperar', { cpf: cpfAleatorio(), resposta: derivada('z'), senha_nova: derivada('n') })).status, 401); // CPF inexistente: mesma resposta
});

test('definir resposta secreta depois (conta antiga): exige senha atual', async () => {
  const { c, d } = await novoComprador();
  assert.equal((await c.post('/api/auth/resposta', { senha_atual: derivada('errada'), resposta: derivada('nova') })).status, 401);
  assert.equal((await c.post('/api/auth/resposta', { senha_atual: d.senha, resposta: derivada('nova') })).status, 200);
  const r = await new Cliente().post('/api/auth/recuperar', { cpf: d.cpf, resposta: derivada('nova'), senha_nova: derivada('outra') });
  assert.equal(r.status, 200);
});

test('desfazer entrada: PIN, bloqueio, aviso ao admin e contador', async () => {
  const { ingressos } = await comprarEConfirmar(2);
  const id = ingressos[0].id;
  assert.equal((await hostess.post('/api/portaria/validar', { qr: ingressos[0].qr })).json.resultado, 'ok');
  // PIN ainda não definido
  assert.equal((await hostess.post('/api/portaria/desfazer', { ingresso_id: id, pin: '1234' })).status, 409);
  assert.equal((await hostess.put('/api/admin/pin', { pin: '1234' })).status, 403); // só admin define
  assert.equal((await admin.put('/api/admin/pin', { pin: '4821' })).status, 200);
  assert.equal((await admin.get('/api/admin/config')).json.pin_definido, true);
  assert.ok(!JSON.stringify((await admin.get('/api/admin/config')).json).includes('vapid_privada'));
  // errado
  assert.equal((await hostess.post('/api/portaria/desfazer', { ingresso_id: id, pin: '0000' })).status, 401);
  // certo
  const ok = await hostess.post('/api/portaria/desfazer', { ingresso_id: id, pin: '4821' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.desfeitos, 1);
  // o QR volta a valer e o contador aparece na lista
  assert.equal((await hostess.post('/api/portaria/validar', { qr: ingressos[0].qr })).json.resultado, 'ok');
  const lista = (await hostess.get('/api/portaria/lista')).json.ingressos.find((i) => i.id === id);
  assert.equal(lista.desfeitos, 1);
  // não desfaz o que não está usado
  assert.equal((await hostess.post('/api/portaria/desfazer', { ingresso_id: ingressos[1].id, pin: '4821' })).status, 409);
  // avisos
  const tipos = (await admin.get('/api/admin/alertas')).json.alertas.map((a) => a.tipo);
  assert.ok(tipos.includes('entrada_desfeita') && tipos.includes('pin_errado'));
  // 3 erros seguidos bloqueiam (tentativas zeradas após o acerto acima)
  for (let i = 0; i < 3; i++) await hostess.post('/api/portaria/desfazer', { ingresso_id: id, pin: 'zzzz' });
  assert.equal((await hostess.post('/api/portaria/desfazer', { ingresso_id: id, pin: '4821' })).status, 429);
  // admin também precisa da senha
  assert.equal((await admin.post('/api/portaria/desfazer', { ingresso_id: id })).status, 401);
  assert.equal((await admin.post('/api/portaria/desfazer', { ingresso_id: id, pin: '4821' })).status, 200);
});

test('avisos: marcar como lidos; push (chave, assinatura, teste)', async () => {
  const antes = (await admin.get('/api/me')).json.nao_lidos;
  assert.ok(antes > 0);
  const chave = (await admin.get('/api/admin/push/chave')).json.publica;
  assert.match(chave, /^[A-Za-z0-9_-]{86,90}$/); // ponto P-256 não comprimido (65 bytes) em base64url
  assert.equal((await admin.get('/api/admin/push/chave')).json.publica, chave); // estável
  assert.equal((await hostess.get('/api/admin/push/chave')).status, 403);
  assert.equal((await admin.post('/api/admin/push/assinar', { endpoint: 'http://inseguro' })).status, 400);
  assert.equal((await admin.post('/api/admin/push/assinar', { endpoint: 'https://push.invalido.example/abc123456789' })).status, 200);
  const t = await admin.post('/api/admin/push/teste');
  assert.equal(t.status, 200);
  assert.equal(t.json.enviados + t.json.falhas, 1); // tentou o aparelho cadastrado (que não existe)
  assert.equal((await admin.post('/api/admin/alertas/lidos')).status, 200);
  assert.equal((await admin.get('/api/me')).json.nao_lidos, 0);
});
