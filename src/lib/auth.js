import { getCookie, setCookie } from 'hono/cookie';
import { HttpError, agora } from './http.js';
import { aleatorioHex, hmacHex, sha256Hex } from './crypto.js';

const SESSAO_SEGUNDOS = 30 * 24 * 3600;

// O navegador já estica a senha (PBKDF2, 600 mil iterações). Aqui o Worker só aplica
// um HMAC com o "pepper" (segredo que NÃO fica no banco): custo de CPU quase zero e,
// sem o pepper, um vazamento do banco não permite nem testar senhas.
export const guardarSenha = (env, cpf, derivada) => hmacHex(env.PEPPER, `v1|${cpf}|${derivada}`);

export async function criarSessao(c, usuarioId) {
  const token = aleatorioHex(32);
  const id = await sha256Hex(token);
  const t = agora();
  await c.env.DB.prepare(
    'INSERT INTO sessoes (id, usuario_id, criado_em, expira_em) VALUES (?1, ?2, ?3, ?4)',
  )
    .bind(id, usuarioId, t, t + SESSAO_SEGUNDOS)
    .run();
  setCookie(c, 'sid', token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSAO_SEGUNDOS,
  });
}

// Middleware: exige login e, opcionalmente, um dos papéis informados.
export function exigir(...papeis) {
  return async (c, next) => {
    const token = getCookie(c, 'sid');
    if (!token) throw new HttpError(401, 'Faça login para continuar.');
    const id = await sha256Hex(token);
    const u = await c.env.DB.prepare(
      `SELECT u.id, u.cpf, u.nome, u.sobrenome, u.email, u.telefone, u.papel, u.deve_trocar_senha,
              (u.resposta_hash IS NOT NULL) AS tem_resposta
         FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
        WHERE s.id = ?1 AND s.expira_em > ?2 AND u.ativo = 1`,
    )
      .bind(id, agora())
      .first();
    if (!u) throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
    if (papeis.length && !papeis.includes(u.papel)) {
      throw new HttpError(403, 'Você não tem permissão para isso.');
    }
    c.set('usuario', u);
    c.set('sessaoId', id);
    await next();
  };
}
