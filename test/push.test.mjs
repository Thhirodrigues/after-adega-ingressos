// Confere que o JWT do VAPID é válido (ES256) sem depender de nenhum serviço de push.
import test from 'node:test';
import assert from 'node:assert/strict';
import { b64u, jwtVapid } from '../src/lib/push.js';

const deb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

test('JWT VAPID assina com ES256 e a chave pública valida', async () => {
  const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privada = JSON.stringify(await crypto.subtle.exportKey('jwk', par.privateKey));
  const jwt = await jwtVapid(privada, 'https://fcm.googleapis.com', 'https://exemplo.dev');
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(deb64u(h))), { typ: 'JWT', alg: 'ES256' });
  const corpo = JSON.parse(new TextDecoder().decode(deb64u(c)));
  assert.equal(corpo.aud, 'https://fcm.googleapis.com');
  assert.equal(corpo.sub, 'https://exemplo.dev');
  assert.ok(corpo.exp > Date.now() / 1000 && corpo.exp <= Date.now() / 1000 + 13 * 3600);
  assert.equal(deb64u(sig).length, 64); // r||s, formato do JWS
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, par.publicKey, deb64u(sig), new TextEncoder().encode(`${h}.${c}`));
  assert.equal(ok, true);
  const pub = b64u(await crypto.subtle.exportKey('raw', par.publicKey));
  assert.equal(deb64u(pub).length, 65);
});
