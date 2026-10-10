import { Hono } from 'hono';
import { HttpError, agora, auditar, configuracoes, corpo } from '../lib/http.js';
import { exigir } from '../lib/auth.js';
import { hmacHex, igual, qrDoIngresso, sha256Hex } from '../lib/crypto.js';
import { alertar } from '../lib/alertas.js';
import * as v from '../lib/validar.js';
import { lerQr, registrarEntrada } from '../lib/portaria.js';
import { venderPresencial } from '../lib/pedidos.js';

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
      `SELECT i.id, i.status, i.tipo, i.motivo, i.qr_versao, i.usado_em, i.desfeitos, COALESCE(i.nome_avulso, u.nome || ' ' || u.sobrenome) AS nome
         FROM ingressos i JOIN usuarios u ON u.id = i.dono_id
        WHERE i.evento_id = ?1 ORDER BY 8, i.id`,
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
      desfeitos: i.desfeitos,
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

// Desfaz uma entrada marcada por engano. A recepcionista precisa da senha de desbloqueio
// (definida pelo admin); cada uso gera um aviso para o admin. O admin também digita a senha.
r.post('/portaria/desfazer', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const u = c.get('usuario');
  const ev = await eventoAtivo(db);
  const id = v.inteiro(b.ingresso_id, 'Ingresso', 1, 1_000_000_000);
  const chaveTent = `pin:${u.id}`;
  {
    const cfg = await configuracoes(db);
    if (!cfg.pin_hash) throw new HttpError(409, 'A senha de desbloqueio ainda não foi definida pelo administrador.');
    const t = agora();
    const tent = await db.prepare('SELECT bloqueado_ate FROM tentativas_login WHERE cpf = ?1').bind(chaveTent).first();
    if (tent && tent.bloqueado_ate > t) throw new HttpError(429, 'Muitas tentativas erradas. Aguarde alguns minutos ou chame o administrador.');
    const informado = await hmacHex(c.env.PEPPER, `pin|${String(b.pin ?? '')}`);
    if (!igual(informado, cfg.pin_hash)) {
      await db
        .prepare(
          `INSERT INTO tentativas_login (cpf, falhas, bloqueado_ate, atualizado_em) VALUES (?1, 1, 0, ?2)
           ON CONFLICT(cpf) DO UPDATE SET
             falhas = CASE WHEN falhas + 1 >= 3 THEN 0 ELSE falhas + 1 END,
             bloqueado_ate = CASE WHEN falhas + 1 >= 3 THEN ?3 ELSE bloqueado_ate END,
             atualizado_em = ?2`,
        )
        .bind(chaveTent, t, t + 900)
        .run();
      if (u.papel !== 'admin') await alertar(c, 'pin_errado', `${u.nome} ${u.sobrenome} errou a senha de desbloqueio ao tentar desfazer uma entrada.`);
      throw new HttpError(401, 'Senha de desbloqueio incorreta.');
    }
    await db.prepare('DELETE FROM tentativas_login WHERE cpf = ?1').bind(chaveTent).run();
  }
  const res = await db
    .prepare(
      `UPDATE ingressos SET status = 'valido', usado_em = NULL, usado_por = NULL, desfeitos = desfeitos + 1
        WHERE id = ?1 AND status = 'usado' AND evento_id = ?2`,
    )
    .bind(id, ev.id)
    .run();
  if (res.meta.changes !== 1) throw new HttpError(409, 'Este ingresso não está marcado como usado.');
  const ing = await db
    .prepare(`SELECT i.desfeitos, COALESCE(i.nome_avulso, u.nome || ' ' || u.sobrenome) AS nome FROM ingressos i JOIN usuarios u ON u.id = i.dono_id WHERE i.id = ?1`)
    .bind(id)
    .first();
  await auditar(db, u.id, 'entrada_desfeita', String(id));
  if (u.papel !== 'admin') {
    await alertar(c, 'entrada_desfeita', `${u.nome} ${u.sobrenome} desfez a entrada de ${ing.nome} (ingresso #${id}). Total de desfeitos neste ingresso: ${ing.desfeitos}.`);
  }
  return c.json({ ok: true, nome: ing.nome, desfeitos: ing.desfeitos, ...(await contagem(db, ev.id)) });
});

// Lotes que podem ser vendidos presencialmente (porta ou dinheiro), do evento ativo.
r.get('/portaria/lotes-venda', async (c) => {
  const db = c.env.DB;
  const ev = await eventoAtivo(db);
  const { results } = await db
    .prepare(
      `SELECT id, nome, valor_centavos, canal, (quantidade - vendidos - reservados) AS disponiveis
         FROM lotes WHERE evento_id = ?1 AND ativo = 1 AND canal <> 'online' ORDER BY ordem, id`,
    )
    .bind(ev.id)
    .all();
  return c.json({ evento: ev, lotes: results });
});

// Venda presencial: dinheiro ou Pix na hora. Sem taxa de serviço. Precisa de internet
// (o estoque é decidido no servidor, para nunca vender o mesmo ingresso duas vezes).
r.post('/portaria/venda', async (c) => {
  const b = await corpo(c);
  const db = c.env.DB;
  const u = c.get('usuario');
  const ev = await eventoAtivo(db);
  const loteId = v.inteiro(b.lote_id, 'Lote', 1, 1_000_000_000);
  const quantidade = v.inteiro(b.quantidade, 'Quantidade', 1, 20);
  const brutos = Array.isArray(b.nomes) ? b.nomes : [b.nome];
  if (brutos.length !== quantidade) throw new HttpError(400, `Informe o nome de cada uma das ${quantidade} pessoas.`);
  const nomes = brutos.map((n, i) => v.texto(n, `Nome da pessoa ${i + 1}`, 2, 80));
  const forma = ['dinheiro', 'pix_chave'].includes(b.forma) ? b.forma : null;
  if (!forma) throw new HttpError(400, 'Escolha a forma de pagamento: dinheiro ou Pix.');
  const lote = await db.prepare('SELECT evento_id FROM lotes WHERE id = ?1').bind(loteId).first();
  if (!lote || lote.evento_id !== ev.id) throw new HttpError(404, 'Lote indisponível para venda presencial.');
  const { codigo, id } = await venderPresencial(db, u, { loteId, quantidade, nomes, forma });
  const p = await db.prepare('SELECT total_centavos FROM pedidos WHERE id = ?1').bind(id).first();
  await auditar(db, u.id, 'venda_presencial', `${codigo} ${quantidade}x ${forma} ${p.total_centavos}`);
  return c.json({ ok: true, codigo, quantidade, total_centavos: p.total_centavos, forma, entrou: true, ...(await contagem(db, ev.id)) }, 201);
});

export default r;
