import { HttpError, agora } from './http.js';
import { eventoAberto } from './evento.js';

export const ROTULO_CATEGORIA = { dj: 'DJ', aniversariante: 'Aniversariante', convidado: 'Amigo/parceiro' };

// O convite vale para a conta cujo telefone confere, ou cujo e-mail confere (se o admin informou e-mail).
export const confere = (convite, usuario) =>
  convite.telefone === usuario.telefone ||
  (!!convite.email && String(usuario.email ?? '').toLowerCase() === convite.email);

// Transforma o convite em ingressos na conta do usuário. Atômico no convite (só um resgate vence).
export async function resgatar(db, convite, usuario) {
  const t = agora();
  const res = await db
    .prepare(
      `UPDATE convites SET status = 'resgatado', usuario_id = ?2, resgatado_em = ?3
        WHERE id = ?1 AND status = 'pendente'`,
    )
    .bind(convite.id, usuario.id, t)
    .run();
  if (res.meta.changes !== 1) return false;
  // Parte da cortesia pode ter entrado direto pela portaria (sem conta): só nascem os ingressos que faltam.
  const ja = (await db.prepare(`SELECT COUNT(*) AS n FROM ingressos WHERE convite_id = ?1 AND status != 'cancelado'`).bind(convite.id).first())?.n ?? 0;
  try {
    await db.batch(
      Array.from({ length: Math.max(0, convite.quantidade - ja) }, () =>
        db
          .prepare(
            `INSERT INTO ingressos (pedido_id, evento_id, lote_id, dono_id, tipo, status, criado_em, motivo, categoria, convite_id)
             VALUES (NULL, ?1, NULL, ?2, 'cortesia', 'valido', ?3, ?4, ?5, ?6)`,
          )
          .bind(convite.evento_id, usuario.id, t, ROTULO_CATEGORIA[convite.categoria], convite.categoria, convite.id),
      ),
    );
  } catch (e) {
    await db.prepare(`UPDATE convites SET status = 'pendente', usuario_id = NULL, resgatado_em = NULL WHERE id = ?1`).bind(convite.id).run();
    throw e;
  }
  return true;
}

// Resgata sozinho todo convite pendente que combina com o cadastro. Devolve quantos convites foram resgatados.
export async function resgatarPendentes(db, usuario) {
  const { results } = await db
    .prepare(
      `SELECT * FROM convites
        WHERE status = 'pendente' AND evento_id IN (SELECT e.id FROM eventos e WHERE ${eventoAberto('e')})
          AND (telefone = ?1 OR (email IS NOT NULL AND email = lower(?2)))`,
    )
    .bind(usuario.telefone, usuario.email ?? '')
    .all();
  let n = 0;
  for (const cv of results) if (await resgatar(db, cv, usuario)) n++;
  return n;
}

// Telefone que a portaria confere: o do convite enquanto o ingresso está com quem resgatou;
// depois de transferido (ou se não veio de convite), o da conta do dono atual.
export async function telefoneTitular(db, ingressoId) {
  const r = await db
    .prepare(
      `SELECT i.dono_id, u.telefone AS tel_dono, c.telefone AS tel_convite, c.usuario_id AS convite_usuario
         FROM ingressos i JOIN usuarios u ON u.id = i.dono_id LEFT JOIN convites c ON c.id = i.convite_id
        WHERE i.id = ?1`,
    )
    .bind(ingressoId)
    .first();
  if (!r) throw new HttpError(404, 'Ingresso não encontrado.');
  return r.tel_convite && r.convite_usuario === r.dono_id ? r.tel_convite : r.tel_dono;
}
