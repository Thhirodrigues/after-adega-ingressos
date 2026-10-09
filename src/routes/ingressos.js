import { Hono } from 'hono';
import { HttpError, agora, auditar } from '../lib/http.js';
import { exigir } from '../lib/auth.js';
import { aleatorioHex, sha256Hex } from '../lib/crypto.js';
import * as v from '../lib/validar.js';

const r = new Hono();
const SETE_DIAS = 7 * 24 * 3600;

// Gera (ou renova) o link de transferência de um ingresso válido que é seu.
r.post('/ingressos/:id/transferir', exigir(), async (c) => {
  const db = c.env.DB;
  const u = c.get('usuario');
  const id = v.inteiro(c.req.param('id'), 'Ingresso', 1, 1_000_000_000);
  const ing = await db.prepare('SELECT id, status, dono_id FROM ingressos WHERE id = ?1').bind(id).first();
  if (!ing || ing.dono_id !== u.id) throw new HttpError(404, 'Ingresso não encontrado.');
  if (ing.status !== 'valido') throw new HttpError(409, 'Só ingressos válidos podem ser transferidos.');
  const token = aleatorioHex(16);
  const t = agora();
  await db.batch([
    db.prepare(`UPDATE transferencias SET status = 'cancelada' WHERE ingresso_id = ?1 AND status = 'pendente'`).bind(id),
    db
      .prepare(
        `INSERT INTO transferencias (token_hash, ingresso_id, de_usuario_id, criado_em, expira_em)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(await sha256Hex(token), id, u.id, t, t + SETE_DIAS),
  ]);
  await auditar(db, u.id, 'transferencia_criada', String(id));
  return c.json({ token, expira_em: t + SETE_DIAS }, 201);
});

r.post('/ingressos/:id/cancelar-transferencia', exigir(), async (c) => {
  const db = c.env.DB;
  const u = c.get('usuario');
  const id = v.inteiro(c.req.param('id'), 'Ingresso', 1, 1_000_000_000);
  await db
    .prepare(`UPDATE transferencias SET status = 'cancelada' WHERE ingresso_id = ?1 AND de_usuario_id = ?2 AND status = 'pendente'`)
    .bind(id, u.id)
    .run();
  return c.json({ ok: true });
});

async function buscarTransferencia(db, token) {
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  return db
    .prepare(
      `SELECT t.id, t.ingresso_id, t.de_usuario_id, t.status, t.expira_em,
              u.nome AS de_nome, e.nome AS evento, e.data_evento, i.status AS ingresso_status, i.dono_id
         FROM transferencias t
         JOIN ingressos i ON i.id = t.ingresso_id
         JOIN usuarios u ON u.id = t.de_usuario_id
         JOIN eventos e ON e.id = i.evento_id
        WHERE t.token_hash = ?1`,
    )
    .bind(await sha256Hex(token))
    .first();
}

// Prévia pública do link: só mostra primeiro nome de quem enviou e o evento.
r.get('/transferencias/:token', async (c) => {
  const t = await buscarTransferencia(c.env.DB, c.req.param('token'));
  if (!t) throw new HttpError(404, 'Link de transferência inválido.');
  const valida = t.status === 'pendente' && t.expira_em > agora() && t.ingresso_status === 'valido' && t.dono_id === t.de_usuario_id;
  return c.json({ valida, de: t.de_nome, evento: t.evento, data_evento: t.data_evento });
});

r.post('/transferencias/:token/aceitar', exigir(), async (c) => {
  const db = c.env.DB;
  const u = c.get('usuario');
  const t = await buscarTransferencia(db, c.req.param('token'));
  if (!t) throw new HttpError(404, 'Link de transferência inválido.');
  if (t.de_usuario_id === u.id) throw new HttpError(400, 'Este ingresso já é seu.');
  if (t.status !== 'pendente' || t.expira_em <= agora() || t.ingresso_status !== 'valido' || t.dono_id !== t.de_usuario_id) {
    throw new HttpError(409, 'Este link não vale mais (já usado, cancelado ou vencido).');
  }
  // Troca de dono + novo QR, de uma vez só. A condição repete as checagens.
  await db.batch([
    db
      .prepare(
        `UPDATE ingressos SET dono_id = ?2, qr_versao = qr_versao + 1
          WHERE id = ?1 AND dono_id = ?3 AND status = 'valido'
            AND EXISTS (SELECT 1 FROM transferencias WHERE id = ?4 AND status = 'pendente')`,
      )
      .bind(t.ingresso_id, u.id, t.de_usuario_id, t.id),
    db
      .prepare(
        `UPDATE transferencias SET status = 'aceita', para_usuario_id = ?2, aceita_em = ?3
          WHERE id = ?1 AND status = 'pendente'
            AND (SELECT dono_id FROM ingressos WHERE id = ?4) = ?2`,
      )
      .bind(t.id, u.id, agora(), t.ingresso_id),
  ]);
  const depois = await db.prepare('SELECT dono_id FROM ingressos WHERE id = ?1').bind(t.ingresso_id).first();
  if (depois.dono_id !== u.id) throw new HttpError(409, 'Não foi possível concluir: o ingresso mudou. Peça um novo link.');
  await auditar(db, u.id, 'transferencia_aceita', `${t.ingresso_id} de ${t.de_usuario_id}`);
  return c.json({ ok: true });
});

export default r;
