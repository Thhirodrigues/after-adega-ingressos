export class HttpError extends Error {
  constructor(status, mensagem, extra = null) {
    super(mensagem);
    this.status = status;
    this.extra = extra;
  }
}

// Epoch em segundos. (Em Workers o relógio só avança em operações de I/O; para
// expirar reservas em minutos isso é suficiente.)
export const agora = () => Math.floor(Date.now() / 1000);

export async function corpo(c) {
  try {
    const b = await c.req.json();
    if (b && typeof b === 'object' && !Array.isArray(b)) return b;
  } catch {
    // cai no erro abaixo
  }
  throw new HttpError(400, 'Corpo da requisição inválido (JSON esperado).');
}

export async function configuracoes(db) {
  const { results } = await db.prepare('SELECT chave, valor FROM config').all();
  return Object.fromEntries(results.map((r) => [r.chave, r.valor]));
}

// Cada registro pertence ao evento da ação (eventoId). Sem evento = ação geral (usuários, permissões,
// configurações, evento excluído), que aparece na Auditoria geral.
export async function auditar(db, usuarioId, acao, detalhe = '', eventoId = null) {
  await db
    // papel = o de quem agiu neste momento (a hostess continua "portaria" na festa em que trabalhou).
    .prepare(
      `INSERT INTO auditoria (usuario_id, acao, detalhe, criado_em, evento_id, papel)
       VALUES (?1, ?2, ?3, ?4, ?5, (SELECT papel FROM usuarios WHERE id = ?1))`,
    )
    .bind(usuarioId ?? null, acao, String(detalhe).slice(0, 500), agora(), eventoId)
    .run();
}
