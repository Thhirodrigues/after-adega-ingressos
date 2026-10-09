// TESTE TÉCNICO (spike) — after-adega-ingressos
// Objetivo: descobrir, antes de construir o app, se o plano grátis do Cloudflare
// Workers (10 ms de CPU por requisição) aguenta o hash de senha do login e a
// criação de um Pix no Mercado Pago. Este arquivo NÃO é o app final.

const enc = new TextEncoder();

const toHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
}

function homePage() {
  const links = [10000, 50000, 100000, 210000, 600000]
    .map((n) => `<li><a href="/spike/hash?iter=${n}">hash com ${n.toLocaleString('pt-BR')} iterações</a></li>`)
    .join('');
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Teste técnico</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.6}
a{display:inline-block;padding:.35rem 0}</style></head>
<body><h1>Teste técnico</h1>
<p>Toque em cada link, um por vez. Depois veja o <b>CPU time</b> no painel do Cloudflare (Workers &rarr; seu worker &rarr; Metrics).</p>
<ul>${links}</ul>
<p>Pix de teste (exige os segredos configurados): <code>/spike/pix?key=SUA_CHAVE&amp;valor=1</code></p>
</body></html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function spikeHash(url) {
  const iter = Number(url.searchParams.get('iter') || 100000);
  if (!Number.isInteger(iter) || iter < 1000 || iter > 2000000) {
    return json({ ok: false, erro: 'iter deve ser um inteiro entre 1000 e 2000000' }, 400);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  try {
    const bits = await derive('senha-de-teste-123', salt, iter);
    return json({
      ok: true,
      iter,
      hashInicio: toHex(bits).slice(0, 8),
      proximoPasso: 'Veja o CPU time desta requisição no painel do Cloudflare.',
    });
  } catch (e) {
    // Se existir um teto de iterações no Workers, ele aparece aqui.
    return json({ ok: false, iter, erro: String((e && e.message) || e) }, 500);
  }
}

async function spikePix(url, env) {
  if (!env.SPIKE_KEY || !env.MP_ACCESS_TOKEN) {
    return json(
      { ok: false, erro: 'Configure os segredos SPIKE_KEY e MP_ACCESS_TOKEN para testar o Pix.' },
      501,
    );
  }
  if (url.searchParams.get('key') !== env.SPIKE_KEY) {
    return json({ ok: false, erro: 'chave inválida' }, 403);
  }
  const valor = Number(url.searchParams.get('valor') || 1);
  if (!(valor >= 0.01 && valor <= 5)) {
    return json({ ok: false, erro: 'valor deve ficar entre 0,01 e 5,00' }, 400);
  }

  const resp = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      transaction_amount: valor,
      description: 'Teste técnico (spike) - não pagar',
      payment_method_id: 'pix',
      payer: { email: 'teste@example.com' },
    }),
  });
  const body = await resp.json().catch(() => ({}));
  const qr = body?.point_of_interaction?.transaction_data?.qr_code;
  return json(
    {
      ok: resp.ok,
      httpStatus: resp.status,
      paymentId: body.id ?? null,
      status: body.status ?? null,
      qrGerado: Boolean(qr),
      erro: resp.ok ? undefined : body.message ?? 'falha ao criar o pagamento',
    },
    resp.ok ? 200 : 502,
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') return homePage();
    if (url.pathname === '/spike/hash') return spikeHash(url);
    if (url.pathname === '/spike/pix') return spikePix(url, env);
    return json({ ok: false, erro: 'não encontrado' }, 404);
  },
};
