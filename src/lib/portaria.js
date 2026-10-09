import { agora } from './http.js';
import { igual, qrDoIngresso } from './crypto.js';

// Lê "<id>.<versao>.<token>" e confere o token. Devolve { id, versao } ou null.
export async function lerQr(env, qr) {
  const m = /^(\d{1,10})\.(\d{1,6})\.([0-9a-f]{32})$/.exec(String(qr ?? '').trim());
  if (!m) return null;
  const id = Number(m[1]);
  const versao = Number(m[2]);
  const esperado = await qrDoIngresso(env, id, versao);
  return igual(esperado, `${id}.${versao}.${m[3]}`) ? { id, versao } : null;
}

async function dadosIngresso(db, id) {
  return db
    .prepare(
      `SELECT i.id, i.status, i.tipo, i.motivo, i.evento_id, i.qr_versao, i.usado_em,
              u.nome || ' ' || u.sobrenome AS nome, p.nome || ' ' || p.sobrenome AS usado_por_nome
         FROM ingressos i
         JOIN usuarios u ON u.id = i.dono_id
         LEFT JOIN usuarios p ON p.id = i.usado_por
        WHERE i.id = ?1`,
    )
    .bind(id)
    .first();
}

// Marca o ingresso como usado de forma atômica (duas leituras simultâneas: só uma entra).
// resultado: ok | usado | cancelado | invalido | outro_evento
export async function registrarEntrada(db, { id, versao = null, eventoId, quando, porId }) {
  const t = Math.min(quando ?? agora(), agora());
  const res = await db
    .prepare(
      `UPDATE ingressos SET status = 'usado', usado_em = ?2, usado_por = ?3
        WHERE id = ?1 AND status = 'valido' AND evento_id = ?4
          AND (?5 IS NULL OR qr_versao = ?5)`,
    )
    .bind(id, t, porId, eventoId, versao)
    .run();
  const ing = await dadosIngresso(db, id);
  if (!ing) return { resultado: 'invalido' };
  const base = { nome: ing.nome, tipo: ing.tipo, motivo: ing.motivo, ingresso_id: ing.id };
  if (res.meta.changes === 1) return { resultado: 'ok', ...base, usado_em: t };
  if (ing.evento_id !== eventoId) return { resultado: 'outro_evento', ...base };
  if (versao !== null && ing.qr_versao !== versao) return { resultado: 'invalido', ...base };
  if (ing.status === 'usado') return { resultado: 'usado', ...base, usado_em: ing.usado_em, usado_por: ing.usado_por_nome };
  return { resultado: ing.status === 'cancelado' ? 'cancelado' : 'invalido', ...base };
}
