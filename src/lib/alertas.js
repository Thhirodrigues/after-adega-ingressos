import { agora } from './http.js';
import { enviarPush } from './push.js';

// Registra um aviso para o admin e tenta tocar o celular dele (push). Nunca derruba a operação.
export async function alertar(c, tipo, detalhe) {
  const db = c.env.DB;
  await db
    .prepare('INSERT INTO alertas (tipo, detalhe, criado_em) VALUES (?1, ?2, ?3)')
    .bind(tipo, String(detalhe).slice(0, 300), agora())
    .run();
  const origem = new URL(c.req.url).origin;
  const tarefa = enviarPush(db, origem).catch(() => {});
  try {
    c.executionCtx.waitUntil(tarefa);
  } catch {
    await tarefa;
  }
}
