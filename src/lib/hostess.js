import { HttpError, auditar } from './http.js';
import { eventoAberto, eventoEncerrado } from './evento.js';

// Hostess é escalada para UM evento (usuarios.hostess_evento_id). Quando ele termina ou é excluído, ela volta a
// ser usuário comum (comprador), sem ninguém precisar lembrar de tirar o acesso. Roda sob demanda: a cada acesso
// de uma hostess e quando o admin abre a lista de usuários (não há tarefa agendada).
// Devolve os ids rebaixados.
export async function encerrarHostess(db) {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.nome, u.sobrenome,
              (SELECT e.id FROM eventos e WHERE e.id = u.hostess_evento_id AND e.excluido_em IS NULL) AS evento_id
         FROM usuarios u
        WHERE u.papel = 'hostess'
          AND NOT EXISTS (SELECT 1 FROM eventos e WHERE e.id = u.hostess_evento_id AND e.excluido_em IS NULL AND NOT ${eventoEncerrado('e')})`,
    )
    .all();
  const ids = [];
  for (const h of results) {
    const r = await db.prepare(`UPDATE usuarios SET papel = 'comprador', hostess_evento_id = NULL WHERE id = ?1 AND papel = 'hostess'`).bind(h.id).run();
    if (r.meta.changes === 1) {
      ids.push(h.id);
      // Fica na auditoria do evento que terminou (sistema, sem usuário).
      await auditar(db, null, 'hostess_encerrada', `${h.nome} ${h.sobrenome} (#${h.id}) voltou a ser usuário: evento terminou`, h.evento_id);
    }
  }
  return ids;
}

// Evento em que a hostess vai trabalhar: o informado (precisa existir e não ter terminado) ou, sem informar,
// o evento à venda agora; sem ele, o próximo que ainda não terminou.
export async function eventoParaHostess(db, bruto) {
  const id = Number.parseInt(bruto ?? '', 10);
  if (Number.isFinite(id) && id > 0) {
    const e = await db.prepare(`SELECT e.id, e.nome, ${eventoEncerrado('e')} AS enc FROM eventos e WHERE e.id = ?1 AND e.excluido_em IS NULL`).bind(id).first();
    if (!e) throw new HttpError(404, 'Evento não encontrado.');
    if (e.enc) throw new HttpError(409, 'Este evento já terminou: escolha um evento que ainda vai acontecer para escalar a hostess.');
    return e;
  }
  const e = await db
    .prepare(
      `SELECT e.id, e.nome FROM eventos e WHERE e.excluido_em IS NULL AND NOT ${eventoEncerrado('e')}
        ORDER BY ${eventoAberto('e')} DESC, e.data_evento LIMIT 1`,
    )
    .first();
  if (!e) throw new HttpError(409, 'Não há evento por acontecer. Crie ou reabra um evento antes de escalar a hostess.');
  return e;
}
