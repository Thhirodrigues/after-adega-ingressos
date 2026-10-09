import { Hono } from 'hono';
import { HttpError } from './lib/http.js';
import auth from './routes/auth.js';
import publico from './routes/publico.js';
import pedidos from './routes/pedidos.js';
import admin from './routes/admin.js';

const app = new Hono();

// Diagnóstico: mostra só se cada segredo existe (nunca os valores).
app.get('/api/saude', async (c) => {
  let db = false;
  try { db = !!(await c.env.DB.prepare('SELECT 1 AS ok').first()); } catch {}
  return c.json({
    db,
    segredos: { PEPPER: !!c.env.PEPPER, QR_SECRET: !!c.env.QR_SECRET, SETUP_KEY: !!c.env.SETUP_KEY },
  });
});

app.use('/api/*', async (c, next) => {
  if (!c.env.PEPPER || !c.env.QR_SECRET) {
    throw new HttpError(500, 'Servidor sem os segredos configurados (PEPPER, QR_SECRET).');
  }
  // Defesa extra contra CSRF: escritas só com JSON (o cookie já é SameSite=Lax).
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    if (!(c.req.header('content-type') || '').includes('application/json')) {
      throw new HttpError(415, 'Envie o corpo em JSON.');
    }
  }
  c.header('Cache-Control', 'no-store');
  await next();
});

app.route('/api', auth);
app.route('/api', publico);
app.route('/api', pedidos);
app.route('/api', admin);

app.notFound((c) => c.json({ erro: 'Não encontrado.' }, 404));
app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ erro: err.message }, err.status);
  console.error(err);
  return c.json({ erro: 'Erro interno.' }, 500);
});

export default app;
