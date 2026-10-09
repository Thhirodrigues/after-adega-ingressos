import { HttpError } from './http.js';
import { cpfValido, soDigitos } from './cpf.js';

export function texto(v, campo, min, max) {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (s.length < min || s.length > max) {
    throw new HttpError(400, `${campo}: use entre ${min} e ${max} caracteres.`);
  }
  return s;
}

export function inteiro(v, campo, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${campo}: informe um número inteiro entre ${min} e ${max}.`);
  }
  return n;
}

export function email(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) {
    throw new HttpError(400, 'E-mail inválido.');
  }
  return s;
}

// Guarda só dígitos, com DDI 55: 5511999990000.
export function telefone(v) {
  let d = soDigitos(v);
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (!/^55\d{10,11}$/.test(d)) throw new HttpError(400, 'Telefone inválido. Use DDD + número.');
  return d;
}

export function cpf(v) {
  const d = soDigitos(v);
  if (!cpfValido(d)) throw new HttpError(400, 'CPF inválido.');
  return d;
}

// A senha chega já esticada pelo navegador (PBKDF2): 64 caracteres hexadecimais.
export function senhaDerivada(v) {
  const s = String(v ?? '');
  if (!/^[0-9a-f]{64}$/.test(s)) throw new HttpError(400, 'Senha em formato inválido.');
  return s;
}

export function dataISO(v, campo = 'Data') {
  const s = String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw new HttpError(400, `${campo}: use o formato AAAA-MM-DD.`);
  }
  return s;
}
