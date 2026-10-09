const enc = new TextEncoder();

export const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hmacHex(segredo, mensagem) {
  const chave = await crypto.subtle.importKey(
    'raw',
    enc.encode(segredo),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', chave, enc.encode(mensagem)));
}

export async function sha256Hex(mensagem) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(mensagem)));
}

export const aleatorioHex = (bytes = 32) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

// Comparação em tempo constante para strings do mesmo tamanho (hex).
export function igual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Código curto do pedido (sem caracteres ambíguos como 0/O e 1/I).
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function codigoCurto(tamanho = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(tamanho));
  return [...bytes].map((b) => ALFABETO[b % ALFABETO.length]).join('');
}

// QR do ingresso: "<id>.<versao>.<token>". O token é derivado (HMAC) e nunca guardado
// no banco, então um vazamento do banco não revela QR codes válidos. A versão muda a
// cada transferência, invalidando o QR anterior.
export async function qrDoIngresso(env, ingressoId, versao = 0) {
  const token = (await hmacHex(env.QR_SECRET, `ing|${ingressoId}|${versao}`)).slice(0, 32);
  return `${ingressoId}.${versao}.${token}`;
}
