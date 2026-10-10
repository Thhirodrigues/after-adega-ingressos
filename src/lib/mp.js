import { HttpError } from './http.js';
import { hmacHex, igual } from './crypto.js';

// Mercado Pago, Checkout Pro. O token (MP_ACCESS_TOKEN) fica só no servidor.
export const mpAtivo = (env) => !!env.MP_ACCESS_TOKEN;
const base = (env) => env.MP_API_BASE || 'https://api.mercadopago.com';

async function chamar(env, metodo, caminho, corpo, chaveIdem) {
  const r = await fetch(base(env) + caminho, {
    method: metodo,
    headers: {
      authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
      'content-type': 'application/json',
      ...(chaveIdem ? { 'x-idempotency-key': chaveIdem } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch {}
  if (!r.ok) {
    const detalhe = `HTTP ${r.status} ${JSON.stringify(json)?.slice(0, 220)}`;
    console.error('mercadopago', metodo, caminho, detalhe);
    const erro = new HttpError(502, 'Não foi possível falar com o Mercado Pago agora. Tente novamente ou pague pelo Pix com a chave.');
    erro.mpDetalhe = detalhe;
    throw erro;
  }
  return json;
}

// Cria o link de pagamento do pedido. Pix e cartão (à vista, sem parcelar); sem boleto.
// metodo: 'cartao' (só cartão de crédito), 'pix' (só Pix) ou nada (o comprador escolhe no Mercado Pago).
export async function criarPreferencia(env, { origem, pedido, metodo = null }) {
  const sem = ['ticket', 'atm'];
  if (metodo === 'cartao') sem.push('bank_transfer');
  if (metodo === 'pix') sem.push('credit_card', 'debit_card', 'prepaid_card');
  const exp = new Date(pedido.expira_em * 1000).toISOString();
  const corpo = {
    items: [{
      id: pedido.codigo,
      title: `${pedido.evento_nome} — ${pedido.quantidade}x ${pedido.lote_nome}`.slice(0, 120),
      quantity: 1,
      currency_id: 'BRL',
      unit_price: pedido.total_centavos / 100,
    }],
    external_reference: pedido.codigo,
    notification_url: `${origem}/api/mp/webhook`,
    back_urls: { success: `${origem}/#/pedido/${pedido.codigo}`, pending: `${origem}/#/pedido/${pedido.codigo}`, failure: `${origem}/#/pedido/${pedido.codigo}` },
    auto_return: 'approved',
    payment_methods: { excluded_payment_types: sem.map((id) => ({ id })), installments: 1 },
    expires: true,
    expiration_date_to: exp,
    statement_descriptor: 'FAST PASS',
  };
  const pref = await chamar(env, 'POST', '/checkout/preferences', corpo, `pref-${pedido.codigo}-${pedido.expira_em}-${metodo || 'todos'}`);
  return { id: pref.id, url: pref.init_point };
}

export const buscarPagamento = (env, id) => chamar(env, 'GET', `/v1/payments/${encodeURIComponent(id)}`);

// Confere x-signature: HMAC-SHA256 de "id:<data.id>;request-id:<x-request-id>;ts:<ts>;".
export async function assinaturaValida(env, { assinatura, requestId, dataId }) {
  if (!env.MP_WEBHOOK_SECRET) return true; // sem segredo configurado: a confirmação ainda re-consulta a API
  const partes = Object.fromEntries(String(assinatura || '').split(',').map((p) => p.trim().split('=')));
  if (!partes.ts || !partes.v1 || !dataId) return false;
  const manifesto = `id:${String(dataId).toLowerCase()};request-id:${requestId || ''};ts:${partes.ts};`;
  return igual(await hmacHex(env.MP_WEBHOOK_SECRET, manifesto), String(partes.v1));
}
