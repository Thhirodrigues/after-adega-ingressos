import { Hono } from 'hono';
import { HttpError, agora, auditar, corpo } from '../lib/http.js';
import { exigir } from '../lib/auth.js';
import { qrDoIngresso, sha256Hex } from '../lib/crypto.js';
import * as v from '../lib/validar.js';
import { lerQr, registrarEntrada } from '../lib/portaria.js';

const r = new Hono();
r.use('/portaria/*', exigir('hostess', 'admin'));

async function eventoAtivo(db) {
  const ev = await db
    .prepare(`SELECT id, nome, data_evento FROM eventos WHERE ativo = 1 ORDER BY data_evento LIMIT 1`)
    .first();
  if (!ev) throw new HttpError(409, 'Nenhum evento ativo.');
  return ev;
}

async function contagem(db, eventoId) {
  const c = await db
    .prepare(
      `SELECT SUM(CASE WHEN status IN ('valido','usado') THEN 1 ELSE 0 END) AS total,
              SUM(CASE WHEN status = 'usado' THEN 1 ELSE 0 END) AS entraram
         FROM ingressos WHERE evento_id = ?1`,
    )
    .bind(eventoId)
    .first();
  return { total: c.total ?? 0, entraram: c.entraram ?? 0 };
}

// Lista para conferência offline: guarda só o hash do QR (não o QR em si).
r.get('/portaria/lista', async (c) => {
  const db = c.env.DB;
  const ev = await eventoAtivo(db);
  const { results } = await db
    .prepare(
      `SELECT i.id, i.status, i.tipo, i.motivo, i.qr_versao, i.usado_em, u.nome || ' ' || u.sobrenome AS nome
         FROM ingressos i JOIN usuarios u ON u.id = i.dono_id
        WHERE i.evento_id = ?1 ORDER BY u.nome, u.sobrenome, i.id`,
    )
    .bind(ev.id)
    .all();
  const ingressos = [];
  for (const i of results) {
    ingressos.push({
      id: i.id,
      h: await sha256Hex(await qrDoIngresso(c.env, i.id, i.qr_versao)),
      nome: i.nome,
      tipo: i.tipo,
      motivo: i.motivo,
      status: i.status,
      usado_em: i.usado_em,
    });
  }
  return c.json({ evento: ev, gerado_em: agora(), ...(await contagem(db, ev.id)), ingressos });
});

r.get('/portaria/resumo', async (c) => {
  const ev = await eventoAtivo(c.env.DB);
  return c.json({ evento: ev, ...(await contagem(c.env.DB, ev.id)) });
});

r.post('/portaria/validar', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const ev = await eventoAtivo(db);
  const lido = await lerQr(c.env, b.qr);
  if (!lido) return c.json({ resultado: 'invalido' });
  const res = await registrarEntrada(db, { ...lido, eventoId: ev.id, quando: agora(), porId: c.get('usuario').id });
  return c.json({ ...res, ...(await contagem(db, ev.id)) });
});

// Entrada manual (QR ilegível): a hostess localiza o nome na lista e confirma.
r.post('/portaria/entrada-manual', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const ev = await eventoAtivo(db);
  const id = v.inteiro(b.ingresso_id, 'Ingresso', 1, 1_000_000_000);
  const res = await registrarEntrada(db, { id, eventoId: ev.id, quando: agora(), porId: c.get('usuario').id });
  if (res.resultado === 'ok') await auditar(db, c.get('usuario').id, 'entrada_manual', String(id));
  return c.json({ ...res, ...(await contagem(db, ev.id)) });
});

// Envia as entradas registradas sem internet. Cada item: { qr } ou { ingresso_id }, e "em" (epoch s).
r.post('/portaria/sincronizar', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const ev = await eventoAtivo(db);
  const usos = Array.isArray(b.usos) ? b.usos.slice(0, 500) : [];
  const resultados = [];
  for (const u of usos) {
    const quando = Number.isFinite(Number(u.em)) ? Number(u.em) : agora();
    let res;
    if (u.qr) {
      const lido = await lerQr(c.env, u.qr);
      res = lido
        ? await registrarEntrada(db, { ...lido, eventoId: ev.id, quando, porId: c.get('usuario').id })
        : { resultado: 'invalido' };
    } else {
      const id = Number(u.ingresso_id);
      res = Number.isInteger(id) && id > 0
        ? await registrarEntrada(db, { id, eventoId: ev.id, quando, porId: c.get('usuario').id })
        : { resultado: 'invalido' };
    }
    resultados.push({ chave: u.qr ?? `m${u.ingresso_id}`, ...res });
  }
  const conflitos = resultados.filter((x) => x.resultado !== 'ok').length;
  if (usos.length) await auditar(db, c.get('usuario').id, 'portaria_sincronizou', `${usos.length} itens, ${conflitos} conflitos`);
  return c.json({ resultados, ...(await contagem(db, ev.id)) });
});

export default r;
