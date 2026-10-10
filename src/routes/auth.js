import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { HttpError, agora, auditar, corpo } from '../lib/http.js';
import { cpfValido, soDigitos } from '../lib/cpf.js';
import { igual, sha256Hex } from '../lib/crypto.js';
import { criarSessao, exigir, guardarSenha } from '../lib/auth.js';
import { alertar } from '../lib/alertas.js';
import { TERMOS_VERSAO } from '../lib/termos.js';
import { hmacHex } from '../lib/crypto.js';
import * as v from '../lib/validar.js';

const r = new Hono();

export const guardarResposta = (env, cpf, derivada) => hmacHex(env.PEPPER, `v1|resp|${cpf}|${derivada}`);

const MAX_FALHAS = 5;
const BLOQUEIO_SEGUNDOS = 15 * 60;
const MSG_LOGIN = 'CPF ou senha inválidos.';

async function checarBloqueio(db, cpf) {
  const t = await db
    .prepare('SELECT bloqueado_ate FROM tentativas_login WHERE cpf = ?1')
    .bind(cpf)
    .first();
  if (t && t.bloqueado_ate > agora()) {
    throw new HttpError(429, 'Muitas tentativas. Tente novamente em alguns minutos.');
  }
}

async function registrarFalha(db, cpf, bloqueioSeg = BLOQUEIO_SEGUNDOS) {
  const t = agora();
  await db
    .prepare(
      `INSERT INTO tentativas_login (cpf, falhas, bloqueado_ate, atualizado_em) VALUES (?1, 1, 0, ?2)
       ON CONFLICT(cpf) DO UPDATE SET
         falhas = CASE WHEN falhas + 1 >= ?3 THEN 0 ELSE falhas + 1 END,
         bloqueado_ate = CASE WHEN falhas + 1 >= ?3 THEN ?4 ELSE bloqueado_ate END,
         atualizado_em = ?2`,
    )
    .bind(cpf, t, MAX_FALHAS, t + bloqueioSeg)
    .run();
}

async function inserirUsuario(c, dados, papel, deveTrocarSenha) {
  const senhaHash = await guardarSenha(c.env, dados.cpf, dados.senha);
  const respostaHash = dados.resposta ? await guardarResposta(c.env, dados.cpf, dados.resposta) : null;
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO usuarios (cpf, nome, sobrenome, email, telefone, senha_hash, papel, deve_trocar_senha, criado_em, resposta_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(
        dados.cpf,
        dados.nome,
        dados.sobrenome,
        dados.email,
        dados.telefone,
        senhaHash,
        papel,
        deveTrocarSenha ? 1 : 0,
        agora(),
        respostaHash,
      )
      .run();
    return res.meta.last_row_id;
  } catch (e) {
    const m = String(e.message);
    if (/UNIQUE/i.test(m) && /cpf/i.test(m)) {
      throw new HttpError(409, 'Este CPF já tem cadastro. Use "Esqueci minha senha" se precisar.');
    }
    if (/UNIQUE/i.test(m) && /email/i.test(m)) {
      throw new HttpError(409, 'Este e-mail já está cadastrado.');
    }
    throw e;
  }
}

export function lerDadosUsuario(b, { exigirResposta = false } = {}) {
  const resposta = b.resposta === undefined || b.resposta === null || b.resposta === '' ? undefined : v.senhaDerivada(b.resposta);
  if (exigirResposta && !resposta) throw new HttpError(400, 'Informe a resposta secreta para recuperação da senha.');
  return {
    resposta,
    cpf: v.cpf(b.cpf),
    nome: v.texto(b.nome, 'Nome', 2, 40),
    sobrenome: v.texto(b.sobrenome, 'Sobrenome', 2, 60),
    email: v.email(b.email),
    telefone: v.telefone(b.telefone),
    senha: v.senhaDerivada(b.senha),
  };
}

export { inserirUsuario };

// Cria o PRIMEIRO admin (e só ele). Exige o segredo SETUP_KEY configurado no Worker.
r.post('/setup/admin', async (c) => {
  const b = await corpo(c);
  if (!c.env.SETUP_KEY) throw new HttpError(404, 'Não encontrado.');
  const enviada = await sha256Hex(String(b.setup_key ?? ''));
  if (!igual(enviada, await sha256Hex(c.env.SETUP_KEY))) {
    throw new HttpError(403, 'Chave de configuração inválida.');
  }
  const existe = await c.env.DB.prepare(`SELECT 1 FROM usuarios WHERE papel = 'admin' LIMIT 1`).first();
  if (existe) throw new HttpError(409, 'Já existe um administrador.');
  const dados = lerDadosUsuario(b, { exigirResposta: true });
  const id = await inserirUsuario(c, dados, 'admin', false);
  await auditar(c.env.DB, id, 'setup_admin');
  return c.json({ ok: true }, 201);
});

r.post('/auth/cadastro', async (c) => {
  const b = await corpo(c);
  if (b.aceito_termos !== true) throw new HttpError(400, 'Para criar a conta, leia e aceite os termos de uso e a política de privacidade.');
  const dados = lerDadosUsuario(b, { exigirResposta: true });
  const id = await inserirUsuario(c, dados, 'comprador', false);
  await c.env.DB.prepare('UPDATE usuarios SET aceite_termos_em = ?2, termos_versao = ?3 WHERE id = ?1').bind(id, agora(), TERMOS_VERSAO).run();
  await criarSessao(c, id);
  return c.json({ ok: true, papel: 'comprador' }, 201);
});

r.post('/auth/login', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const cpf = soDigitos(b.cpf);
  const derivada = String(b.senha ?? '');
  if (!cpfValido(cpf) || !/^[0-9a-f]{64}$/.test(derivada)) throw new HttpError(401, MSG_LOGIN);

  await checarBloqueio(db, cpf);
  const u = await db
    .prepare('SELECT id, senha_hash, ativo, deve_trocar_senha, papel FROM usuarios WHERE cpf = ?1')
    .bind(cpf)
    .first();
  const esperado = await guardarSenha(c.env, cpf, derivada);
  if (!u || !u.ativo || !igual(esperado, u.senha_hash)) {
    await registrarFalha(db, cpf);
    throw new HttpError(401, MSG_LOGIN);
  }
  await db.prepare('DELETE FROM tentativas_login WHERE cpf = ?1').bind(cpf).run();
  await criarSessao(c, u.id);
  return c.json({ ok: true, papel: u.papel, deve_trocar_senha: !!u.deve_trocar_senha });
});

r.post('/auth/logout', exigir(), async (c) => {
  await c.env.DB.prepare('DELETE FROM sessoes WHERE id = ?1').bind(c.get('sessaoId')).run();
  deleteCookie(c, 'sid', { path: '/' });
  return c.json({ ok: true });
});

r.get('/me', exigir(), async (c) => {
  const u = c.get('usuario');
  const nao_lidos = u.papel === 'admin' ? (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM alertas WHERE lido_em IS NULL').first()).n : 0;
  return c.json({
    nao_lidos,
    id: u.id,
    cpf: u.cpf,
    nome: u.nome,
    sobrenome: u.sobrenome,
    email: u.email,
    telefone: u.telefone,
    papel: u.papel,
    deve_trocar_senha: !!u.deve_trocar_senha,
    tem_resposta: !!u.tem_resposta,
  });
});

r.post('/auth/trocar-senha', exigir(), async (c) => {
  const b = await corpo(c);
  const u = c.get('usuario');
  const atual = v.senhaDerivada(b.senha_atual);
  const nova = v.senhaDerivada(b.senha_nova);
  const db = c.env.DB;
  const linha = await db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?1').bind(u.id).first();
  if (!igual(await guardarSenha(c.env, u.cpf, atual), linha.senha_hash)) {
    throw new HttpError(401, 'Senha atual incorreta.');
  }
  await db.batch([
    db
      .prepare('UPDATE usuarios SET senha_hash = ?1, deve_trocar_senha = 0 WHERE id = ?2')
      .bind(await guardarSenha(c.env, u.cpf, nova), u.id),
    db.prepare('DELETE FROM sessoes WHERE usuario_id = ?1 AND id <> ?2').bind(u.id, c.get('sessaoId')),
  ]);
  return c.json({ ok: true });
});

// "Esqueci minha senha": a resposta é sempre a mesma (não revela se o CPF existe).
// O admin vê o pedido, confere pelo WhatsApp e define uma senha provisória.
r.post('/auth/esqueci', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const cpf = soDigitos(b.cpf);
  if (cpfValido(cpf)) {
    const u = await db.prepare('SELECT id FROM usuarios WHERE cpf = ?1 AND ativo = 1').bind(cpf).first();
    if (u) {
      const aberto = await db
        .prepare(`SELECT 1 FROM pedidos_reset WHERE usuario_id = ?1 AND status = 'aberto'`)
        .bind(u.id)
        .first();
      if (!aberto) {
        await db
          .prepare('INSERT INTO pedidos_reset (usuario_id, criado_em) VALUES (?1, ?2)')
          .bind(u.id, agora())
          .run();
      }
    }
  }
  return c.json({
    ok: true,
    mensagem: 'Pedido registrado. A organização vai entrar em contato pelo WhatsApp cadastrado.',
  });
});

// Recuperação por resposta secreta (sem e-mail). Limite rígido: 5 erros = 1 hora bloqueado.
r.post('/auth/recuperar', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const cpf = soDigitos(b.cpf);
  const MSG = 'CPF ou resposta secreta não conferem.';
  if (!cpfValido(cpf) || !/^[0-9a-f]{64}$/.test(String(b.resposta ?? ''))) throw new HttpError(400, MSG);
  const nova = v.senhaDerivada(b.senha_nova);
  const chave = `rec:${cpf}`;
  await checarBloqueio(db, chave);
  const u = await db.prepare('SELECT id, nome, sobrenome, resposta_hash, ativo FROM usuarios WHERE cpf = ?1').bind(cpf).first();
  const esperado = await guardarResposta(c.env, cpf, b.resposta);
  if (!u || !u.ativo || !u.resposta_hash || !igual(esperado, u.resposta_hash)) {
    await registrarFalha(db, chave, 3600);
    throw new HttpError(401, MSG);
  }
  await db.batch([
    db.prepare('UPDATE usuarios SET senha_hash = ?2, deve_trocar_senha = 0 WHERE id = ?1').bind(u.id, await guardarSenha(c.env, cpf, nova)),
    db.prepare('DELETE FROM sessoes WHERE usuario_id = ?1').bind(u.id),
    db.prepare('DELETE FROM tentativas_login WHERE cpf IN (?1, ?2)').bind(chave, cpf),
  ]);
  await auditar(db, u.id, 'senha_recuperada_resposta');
  await alertar(c, 'senha_recuperada', `${u.nome} ${u.sobrenome} redefiniu a senha pela resposta secreta.`);
  return c.json({ ok: true });
});

// Define/troca a resposta secreta (precisa da senha atual).
r.post('/auth/resposta', exigir(), async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const u = c.get('usuario');
  const atual = v.senhaDerivada(b.senha_atual);
  const resposta = v.senhaDerivada(b.resposta);
  const linha = await db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?1').bind(u.id).first();
  if (!igual(await guardarSenha(c.env, u.cpf, atual), linha.senha_hash)) throw new HttpError(401, 'Senha atual incorreta.');
  await db.prepare('UPDATE usuarios SET resposta_hash = ?2 WHERE id = ?1').bind(u.id, await guardarResposta(c.env, u.cpf, resposta)).run();
  await auditar(db, u.id, 'resposta_definida');
  return c.json({ ok: true });
});

export default r;
