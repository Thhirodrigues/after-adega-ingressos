// Web Push SEM conteúdo (só "acorda" o navegador). O aviso em si é buscado pelo
// service worker no servidor, então não precisamos criptografar payload.
const enc = new TextEncoder();

export const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

// Chaves VAPID: geradas na primeira vez e guardadas no banco (a pública vai ao navegador).
export async function chavesVapid(db) {
  const ler = async () => {
    const { results } = await db.prepare(`SELECT chave, valor FROM config WHERE chave IN ('vapid_publica', 'vapid_privada')`).all();
    return Object.fromEntries(results.map((r) => [r.chave, r.valor]));
  };
  let k = await ler();
  if (!k.vapid_publica || !k.vapid_privada) {
    const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publica = b64u(await crypto.subtle.exportKey('raw', par.publicKey));
    const privada = JSON.stringify(await crypto.subtle.exportKey('jwk', par.privateKey));
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO config (chave, valor) VALUES ('vapid_publica', ?1)`).bind(publica),
      db.prepare(`INSERT OR IGNORE INTO config (chave, valor) VALUES ('vapid_privada', ?1)`).bind(privada),
    ]);
    k = await ler(); // se duas requisições geraram ao mesmo tempo, vale a primeira gravada
  }
  return { publica: k.vapid_publica, privada: k.vapid_privada };
}

export async function jwtVapid(privadaJwt, audiencia, assunto) {
  const parte = (o) => b64u(enc.encode(JSON.stringify(o)));
  const corpo = `${parte({ typ: 'JWT', alg: 'ES256' })}.${parte({ aud: audiencia, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: assunto })}`;
  const chave = await crypto.subtle.importKey('jwk', JSON.parse(privadaJwt), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const assinatura = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, chave, enc.encode(corpo)); // já vem em r||s (64 bytes)
  return `${corpo}.${b64u(assinatura)}`;
}

// Envia o "toque" a todos os aparelhos de admin cadastrados. Remove os que não existem mais.
export async function enviarPush(db, origem) {
  const { publica, privada } = await chavesVapid(db);
  const { results } = await db
    .prepare(`SELECT s.id, s.endpoint FROM push_assinaturas s JOIN usuarios u ON u.id = s.usuario_id WHERE u.papel = 'admin' AND u.ativo = 1`)
    .all();
  let enviados = 0;
  let falhas = 0;
  for (const s of results) {
    try {
      const jwt = await jwtVapid(privada, new URL(s.endpoint).origin, origem);
      const r = await fetch(s.endpoint, {
        method: 'POST',
        headers: { Authorization: `vapid t=${jwt}, k=${publica}`, TTL: '3600', Urgency: 'high', 'Content-Length': '0' },
      });
      if (r.status === 404 || r.status === 410) {
        await db.prepare('DELETE FROM push_assinaturas WHERE id = ?1').bind(s.id).run();
        falhas++;
      } else if (r.ok) enviados++;
      else falhas++;
    } catch {
      falhas++;
    }
  }
  return { enviados, falhas };
}
