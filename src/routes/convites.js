import { Hono } from 'hono';
import { HttpError } from '../lib/http.js';
import { exigir } from '../lib/auth.js';
import { confere, resgatar, ROTULO_CATEGORIA } from '../lib/convites.js';

const r = new Hono();
const TOKEN = /^[0-9a-f]{32}$/;

async function achar(db, token) {
  if (!TOKEN.test(token)) throw new HttpError(404, 'Convite não encontrado.');
  const cv = await db
    .prepare(`SELECT c.*, e.nome AS evento_nome, e.data_evento FROM convites c JOIN eventos e ON e.id = c.evento_id WHERE c.token = ?1`)
    .bind(token)
    .first();
  if (!cv) throw new HttpError(404, 'Convite não encontrado.');
  return cv;
}

// Página do link: não revela nome nem contato, só o evento e a situação.
r.get('/convites/:token', async (c) => {
  const cv = await achar(c.env.DB, c.req.param('token'));
  return c.json({ estado: cv.status, evento: cv.evento_nome, data_evento: cv.data_evento, categoria: ROTULO_CATEGORIA[cv.categoria] });
});

// Quem abriu o link já logado confirma o resgate; os dados da conta precisam bater com os do convite.
r.post('/convites/:token/resgatar', exigir(), async (c) => {
  const u = c.get('usuario');
  const cv = await achar(c.env.DB, c.req.param('token'));
  if (cv.status === 'resgatado') {
    if (cv.usuario_id === u.id) return c.json({ ok: true, ja: true, quantidade: cv.quantidade });
    throw new HttpError(409, 'Este convite já foi resgatado.');
  }
  if (cv.status === 'cancelado') throw new HttpError(409, 'Este convite foi cancelado. Fale com a organização.');
  if (!confere(cv, u)) {
    throw new HttpError(403, 'Os dados do seu cadastro (telefone ou e-mail) não conferem com os informados à organização. Fale com a organização para corrigir.');
  }
  if (!(await resgatar(c.env.DB, cv, u))) throw new HttpError(409, 'Este convite já foi resgatado.');
  return c.json({ ok: true, quantidade: cv.quantidade });
});

export default r;
