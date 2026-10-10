'use strict';
// App de ingressos — SPA simples (hash router), sem dependências.

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const estado = { eu: null, evento: null };

// ---------- utilidades ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const hora = (t) => (t ? new Date(t * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');
const soDig = (s) => String(s || '').replace(/\D/g, '');
const ROTULO = { aguardando_pagamento: 'Aguardando Pix', pago: 'Pago', expirado: 'Expirado', cancelado: 'Cancelado', valido: 'Válido', usado: 'Usado' };
const tag = (s) => `<span class="tag ${esc(s)}">${esc(ROTULO[s] || s)}</span>`;

function centavos(txt) {
  const n = Number(String(txt).replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
const reais = (c) => (c / 100).toFixed(2).replace('.', ',');

let avisoTimer;
function aviso(msg, tipo = 'ok') {
  const el = document.getElementById('aviso');
  el.textContent = msg;
  el.className = `aviso ${tipo}`;
  el.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => (el.hidden = true), tipo === 'erro' ? 6000 : 3000);
}

async function api(metodo, caminho, corpo) {
  let r;
  try {
    r = await fetch('/api' + caminho, {
      method: metodo,
      headers: { 'content-type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
  } catch {
    throw new Error('Sem conexão. Verifique a internet e tente de novo.');
  }
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) {
    const e = new Error(j?.erro || `Erro ${r.status}`);
    e.status = r.status;
    e.dados = j;
    throw e;
  }
  return j;
}

// Senha: o navegador estica (PBKDF2 600k) e só a versão derivada vai ao servidor.
async function derivar(cpf, senha) {
  const enc = new TextEncoder();
  const chave = await crypto.subtle.importKey('raw', enc.encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: enc.encode(`after-adega|v1|${soDig(cpf)}`) },
    chave,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cpfValido(c) {
  const s = soDig(c);
  if (s.length !== 11 || /^(\d)\1{10}$/.test(s)) return false;
  for (const n of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(s[i]) * (n + 1 - i);
    if (((soma * 10) % 11) % 10 !== Number(s[n])) return false;
  }
  return true;
}
const fmtCpf = (c) => soDig(c).replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');

function mascaraCpf(input) {
  input.addEventListener('input', () => {
    const d = soDig(input.value).slice(0, 11);
    input.value = d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2');
  });
}

async function comEspera(botao, fn) {
  const txt = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Aguarde…';
  try {
    await fn();
  } catch (e) {
    aviso(e.message, 'erro');
  } finally {
    botao.disabled = false;
    botao.textContent = txt;
  }
}

// Resposta secreta: 1 palavra, 4 a 8 letras. Normaliza (sem acento, minúscula) e estica como a senha.
function normalizarResposta(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}
async function derivarResposta(cpf, resposta) {
  const n = normalizarResposta(resposta);
  if (n.length < 4 || n.length > 8) throw new Error('A resposta secreta precisa ter de 4 a 8 letras (uma palavra só).');
  const enc = new TextEncoder();
  const chave = await crypto.subtle.importKey('raw', enc.encode(n), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: enc.encode(`after-adega|resp|v1|${soDig(cpf)}`) },
    chave,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const campoResposta = (rot = 'Resposta secreta (1 palavra, 4 a 8 letras)') =>
  `<label>${rot}</label><input name="resposta" required minlength="4" maxlength="12" autocomplete="off" autocapitalize="off" spellcheck="false">
   <p class="peq">Serve para você mesmo(a) refazer a senha se esquecer. Escolha algo que só você saiba — evite nome de pet, mãe ou time. Sem acento, só letras.</p>`;

function dadosForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// ---------- sessão / navegação ----------
async function carregarEu() {
  try {
    estado.eu = await api('GET', '/me');
  } catch {
    estado.eu = null;
  }
  desenharNav();
  atualizarBadgeAvisos();
}

// Mantém a bolinha vermelha de avisos não lidos (aba Avisos) sempre em dia.
function atualizarBadgeAvisos() {
  const n = estado.eu?.papel === 'admin' ? estado.eu.nao_lidos || 0 : 0;
  document.querySelectorAll('[data-badge-avisos]').forEach((el) => {
    el.textContent = n || '';
    el.hidden = !n;
  });
}
setInterval(() => {
  if (estado.eu?.papel === 'admin' && document.visibilityState === 'visible') carregarEu();
}, 20000);
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.tipo === 'push' && estado.eu?.papel === 'admin') carregarEu(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && estado.eu?.papel === 'admin') carregarEu();
});

function desenharNav() {
  const eu = estado.eu;
  let h = '';
  if (!eu) h = '<a href="#/entrar">Entrar</a>';
  else {
    if (eu.papel === 'admin') h += `<a href="#/admin">Admin${eu.nao_lidos ? ` <span class="badge">${eu.nao_lidos}</span>` : ''}</a>`;
    if (eu.papel === 'admin' || eu.papel === 'hostess') h += '<a href="#/portaria">Portaria</a>';
    h += '<a href="#/meus">Meus ingressos</a><a href="#/conta">Conta</a><button id="sair">Sair</button>';
  }
  nav.innerHTML = h;
  document.getElementById('sair')?.addEventListener('click', async () => {
    try { await api('POST', '/auth/logout', {}); } catch {}
    estado.eu = null;
    desenharNav();
    location.hash = '#/';
  });
}

const limpezas = [];
const rotas = [];
const rota = (padrao, fn) => rotas.push([new RegExp('^' + padrao + '$'), fn]);

async function navegar() {
  while (limpezas.length) { try { limpezas.pop()(); } catch {} }
  const hash = location.hash.replace(/^#/, '') || '/';
  if (estado.eu?.deve_trocar_senha && hash !== '/trocar-senha') {
    location.hash = '#/trocar-senha';
    return;
  }
  for (const [re, fn] of rotas) {
    const m = hash.match(re);
    if (m) {
      try {
        await fn(...m.slice(1));
      } catch (e) {
        if (e.status === 401) {
          estado.eu = null;
          desenharNav();
          location.hash = '#/entrar';
          return;
        }
        app.innerHTML = `<div class="card"><b>Algo deu errado.</b><p class="mudo">${esc(e.message)}</p><a class="bt sec" href="#/">Voltar ao início</a></div>`;
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  app.innerHTML = '<p class="mudo">Página não encontrada. <a href="#/">Início</a></p>';
}

// ---------- páginas públicas ----------
rota('/', async () => {
  const d = await api('GET', '/evento');
  estado.evento = d;
  if (!d.evento) {
    app.innerHTML = '<h1>Em breve</h1><p class="mudo">Nenhuma festa com vendas abertas no momento.</p>';
    return;
  }
  const ev = d.evento;
  const lotesHtml = d.lotes.length
    ? d.lotes
        .map((l) => {
          const max = Math.max(1, Math.min(d.max_ingressos_por_pedido, l.disponiveis));
          return `
    <div class="card ${l.atual ? 'atual' : ''}" data-card="${l.id}">
      <div class="linha">
        <div><b>${esc(l.nome)}</b>
          <div class="peq" style="margin-top:.2rem">${l.esgotado ? 'Esgotado' : l.atual ? '<span class="tag valido">Disponível</span>' : ''}</div></div>
        <div style="text-align:right">
          <div class="preco">${brl(l.valor_centavos)}</div>
          <div class="peq">cada ingresso</div>
        </div>
      </div>
      ${
        l.esgotado
          ? ''
          : `<div class="linha" style="margin-top:.75rem">
        <div><label style="margin:0 0 .2rem">Quantidade</label>
          <select data-qtd="${l.id}" style="width:auto;min-width:5rem">${Array.from({ length: max }, (_, k) => `<option value="${k + 1}">${k + 1}</option>`).join('')}</select></div>
        <div style="text-align:right"><div class="peq" data-taxa="${l.id}"></div><div><b data-total="${l.id}"></b></div></div>
      </div>
      <button class="bt bloco" data-lote="${l.id}">Comprar</button>`
      }
    </div>`;
        })
        .join('')
    : '<p class="mudo">Ingressos ainda não disponíveis.</p>';
  app.innerHTML = `
    <h1>${esc(ev.nome)}</h1>
    <p><b>${dataBR(ev.data_evento)}</b>${ev.local ? ` · ${esc(ev.local)}` : ''}</p>
    ${ev.descricao ? `<p class="mudo">${esc(ev.descricao)}</p>` : ''}
    <h2>Ingressos</h2>${lotesHtml}
    <p class="peq">O comprador é responsável pelos ingressos do seu pedido.</p>`;
  const calcLote = (l, q) => {
    const sub = l.valor_centavos * q;
    const taxa = Math.floor((sub * d.taxa_percentual + 50) / 100);
    return { sub, taxa, total: sub + taxa };
  };
  d.lotes.forEach((l) => {
    const sel = app.querySelector(`[data-qtd="${l.id}"]`);
    if (!sel) return;
    const atualiza = () => {
      const c = calcLote(l, Number(sel.value));
      app.querySelector(`[data-taxa="${l.id}"]`).textContent = `+ ${brl(c.taxa)} taxa de serviço`;
      app.querySelector(`[data-total="${l.id}"]`).textContent = `Total ${brl(c.total)}`;
    };
    sel.addEventListener('change', atualiza);
    atualiza();
  });
  app.querySelectorAll('[data-lote]').forEach((b) =>
    b.addEventListener('click', () => {
      const q = app.querySelector(`[data-qtd="${b.dataset.lote}"]`)?.value || '1';
      try { sessionStorage.setItem('qtd', JSON.stringify({ lote: b.dataset.lote, q })); } catch {}
      if (!estado.eu) {
        sessionStorage.setItem('voltar', `#/comprar/${b.dataset.lote}`);
        location.hash = '#/entrar';
      } else location.hash = `#/comprar/${b.dataset.lote}`;
    }),
  );
});

rota('/comprar/(\\d+)', async (id) => {
  if (!estado.eu) {
    sessionStorage.setItem('voltar', `#/comprar/${id}`);
    location.hash = '#/entrar';
    return;
  }
  const d = estado.evento?.lotes ? estado.evento : await api('GET', '/evento');
  estado.evento = d;
  const l = d.lotes.find((x) => String(x.id) === id);
  if (!l || l.esgotado) {
    app.innerHTML = '<div class="card">Este lote não está mais disponível. <a href="#/">Voltar</a></div>';
    return;
  }
  const max = Math.min(d.max_ingressos_por_pedido, l.disponiveis);
  app.innerHTML = `
    <h1>${esc(l.nome)}</h1>
    <p class="mudo">${esc(d.evento.nome)} · ${dataBR(d.evento.data_evento)}</p>
    <form class="card" id="f">
      <label>Quantidade de ingressos</label>
      <select name="quantidade">${Array.from({ length: max }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select>
      <label>Nome de quem vai fazer o Pix (para conferirmos o pagamento)</label>
      <input name="nome_pagador" required minlength="3" maxlength="80" value="${esc(`${estado.eu.nome} ${estado.eu.sobrenome}`)}">
      <div class="card" style="background:#0f0f16;margin-top:1rem">
        <div class="linha"><span>Ingressos</span><b id="t_sub"></b></div>
        <div class="linha"><span>Taxa de serviço</span><b id="t_taxa"></b></div>
        <div class="linha"><span><b>Total</b></span><b class="preco" id="t_tot"></b></div>
      </div>
      <label class="check"><input type="checkbox" name="aceito" required> <span>Li e aceito as <a href="#/regras" target="_blank" rel="noopener">regras de compra</a>. Sei que ingresso é pessoal e de uso único e que <b>qualquer envio de print ou foto do QR Code é de minha inteira responsabilidade</b>, podendo resultar em entrada negada.</span></label>
      <p class="peq">Ao continuar seguramos seus ingressos por um tempo limitado para você pagar via Pix.</p>
      <button class="bt bloco">Gerar Pix</button>
    </form>`;
  const f = document.getElementById('f');
  try {
    const g = JSON.parse(sessionStorage.getItem('qtd') || 'null');
    if (g && String(g.lote) === id && [...f.quantidade.options].some((o) => o.value === String(g.q))) f.quantidade.value = String(g.q);
  } catch {}
  const calc = () => {
    const q = Number(f.quantidade.value);
    const sub = l.valor_centavos * q;
    const taxa = Math.floor((sub * d.taxa_percentual + 50) / 100);
    document.getElementById('t_sub').textContent = brl(sub);
    document.getElementById('t_taxa').textContent = brl(taxa);
    document.getElementById('t_tot').textContent = brl(sub + taxa);
  };
  f.quantidade.addEventListener('change', calc);
  calc();
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    comEspera(f.querySelector('button'), async () => {
      const r = await api('POST', '/pedidos', { lote_id: l.id, quantidade: Number(f.quantidade.value), nome_pagador: f.nome_pagador.value, aceito_termos: f.aceito.checked === true });
      location.hash = `#/pedido/${r.codigo}`;
    });
  });
});

let pollTimer;
rota('/pedido/([A-Za-z0-9]+)', async (codigo) => {
  clearInterval(pollTimer);
  const desenhar = (p) => {
    let corpo = '';
    if (p.status === 'aguardando_pagamento') {
      const falta = Math.max(0, p.expira_em - Math.floor(Date.now() / 1000));
      corpo = `
      <div class="card atual">
        <b>Pague ${brl(p.pix.valor_centavos)} via Pix</b>
        <p class="peq">Reserva válida por <b id="cont">${Math.floor(falta / 60)} min</b>. Pague pelo app do seu banco usando "Pix copia e cola".</p>
        <div class="pix" id="pixcode">${esc(p.pix.copia_e_cola)}</div>
        <button class="bt bloco" id="copiar">Copiar código Pix</button>
        <p class="peq" style="margin-top:.75rem">Favorecido: ${esc(p.pix.favorecido)}<br>Chave: ${esc(p.pix.chave)}<br>Referência: <b>${esc(p.codigo)}</b></p>
      </div>
      <p class="peq">Depois de pagar, a organização confere o recebimento e libera seus ingressos aqui. Pode levar alguns minutos. Esta tela atualiza sozinha.</p>
      <div class="acoes">
        <button class="bt perigo peq" id="cancelar">Cancelar pedido</button>
      </div>`;
    } else if (p.status === 'pago') {
      corpo = `<div class="card atual"><b>Pagamento confirmado!</b><p class="mudo">Seus ingressos estão em "Meus ingressos".</p><a class="bt" href="#/meus">Ver meus ingressos</a></div>`;
    } else if (p.status === 'expirado') {
      corpo = `<div class="card"><b>Reserva expirada.</b><p class="mudo">Se você já pagou, fale com a organização informando o código ${esc(p.codigo)}. Caso contrário, faça um novo pedido.</p><a class="bt sec" href="#/">Voltar</a></div>`;
    } else {
      corpo = `<div class="card"><b>Pedido cancelado.</b><p class="mudo">Se houve pagamento, a organização fará a devolução por Pix.</p><a class="bt sec" href="#/">Voltar</a></div>`;
    }
    app.innerHTML = `
      <h1>Pedido ${esc(p.codigo)}</h1> ${tag(p.status)}
      <div class="card">
        <div class="linha"><span>${p.quantidade}× ${esc(p.lote)}</span><b>${brl(p.subtotal_centavos)}</b></div>
        <div class="linha"><span>Taxa de serviço</span><b>${brl(p.taxa_centavos)}</b></div>
        <div class="linha"><span><b>Total</b></span><b>${brl(p.total_centavos)}</b></div>
        <div class="peq">${esc(p.evento)} · ${dataBR(p.data_evento)}</div>
      </div>${corpo}`;
    document.getElementById('copiar')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(p.pix.copia_e_cola);
        aviso('Código Pix copiado!');
      } catch {
        const r = document.createRange();
        r.selectNodeContents(document.getElementById('pixcode'));
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        aviso('Selecione e copie o código acima.', 'erro');
      }
    });
    document.getElementById('cancelar')?.addEventListener('click', async () => {
      if (!confirm('Cancelar este pedido?')) return;
      try {
        desenhar(await api('POST', `/pedidos/${p.codigo}/cancelar`, {}));
      } catch (e) {
        aviso(e.message, 'erro');
      }
    });
  };
  let p = await api('GET', `/pedidos/${codigo.toUpperCase()}`);
  desenhar(p);
  if (p.status === 'aguardando_pagamento') {
    pollTimer = setInterval(async () => {
      if (!location.hash.startsWith('#/pedido/')) return clearInterval(pollTimer);
      try {
        const n = await api('GET', `/pedidos/${codigo.toUpperCase()}`);
        if (n.status !== p.status) {
          p = n;
          desenhar(n);
          if (n.status !== 'aguardando_pagamento') clearInterval(pollTimer);
        }
      } catch {}
    }, 15000);
  }
});

// ---------- meus ingressos (QR) e transferência ----------
function qrSvg(texto) {
  const q = qrcode(0, 'M');
  q.addData(texto);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}
const lerCache = (k) => {
  try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
};
const gravarCache = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
};

rota('/meus', async () => {
  if (!estado.eu) {
    location.hash = '#/entrar';
    return;
  }
  let ing;
  let offline = false;
  let ped = { pedidos: [] };
  try {
    [ped, ing] = await Promise.all([api('GET', '/meus-pedidos'), api('GET', '/meus-ingressos')]);
    gravarCache('ing_cache', { eu: estado.eu.id, em: Date.now(), ingressos: ing.ingressos });
  } catch (e) {
    if (e.status) throw e;
    const c = lerCache('ing_cache');
    if (!c || c.eu !== estado.eu.id) throw e;
    ing = { ingressos: c.ingressos };
    offline = true;
  }
  const pedidos = ped.pedidos
    .map(
      (p) => `<a class="card" style="display:block;text-decoration:none;color:inherit" href="#/pedido/${esc(p.codigo)}">
      <div class="linha"><b>${esc(p.codigo)}</b> ${tag(p.status)}</div>
      <div class="peq">${p.quantidade}× ${esc(p.lote)} · ${brl(p.total_centavos)} · ${hora(p.criado_em)}</div></a>`,
    )
    .join('');
  const cards = ing.ingressos
    .map((i) => {
      const nome = esc(`${estado.eu.nome} ${estado.eu.sobrenome}`);
      let corpo = '';
      if (i.status === 'valido' && i.qr) {
        corpo = `<div class="qrbox">${qrSvg(i.qr)}</div>
          <p class="peq" style="text-align:center">Aumente o brilho da tela e mostre este QR na entrada.${i.transferivel_ate > Date.now() / 1000 ? ` Transferência liberada até ${hora(i.transferivel_ate)}.` : ''}</p>
          ${offline ? '' : Date.now() / 1000 >= i.transferivel_ate ? '<p class="peq" style="text-align:center">Transferências encerradas.</p>' : `<div class="acoes" style="justify-content:center">
            <button class="bt sec peq" data-transf="${i.id}">Transferir para um amigo</button>
            ${i.transferencia_pendente ? `<button class="bt perigo peq" data-cancela="${i.id}">Cancelar transferência pendente</button>` : ''}</div>`}
          <div id="tr-${i.id}"></div>`;
      } else if (i.status === 'usado') {
        corpo = '<div class="usado-msg">Este ingresso já foi usado na entrada.</div>';
      } else {
        corpo = '<div class="usado-msg">Ingresso cancelado.</div>';
      }
      return `<div class="card ${i.status === 'valido' ? 'atual' : ''}">
        <div class="linha"><b>Ingresso #${i.id}</b> ${tag(i.status)}</div>
        <div class="peq">${esc(i.evento)} · ${dataBR(i.data_evento)}${i.tipo === 'cortesia' ? ` · cortesia${i.motivo ? ` (${esc(i.motivo)})` : ''}` : ''}</div>
        <div class="peq">Titular: ${nome}</div>${corpo}</div>`;
    })
    .join('');
  app.innerHTML = `
    <h1>Meus ingressos</h1>
    ${offline ? '<div class="card" style="border-color:var(--cor2)">Sem conexão: mostrando os ingressos salvos neste aparelho. Eles continuam valendo na entrada.</div>' : ''}
    <p class="mudo">${ing.ingressos.length ? 'Cada ingresso vale uma única entrada. Para um amigo entrar, transfira o ingresso pelo link: o QR muda para ele.' : 'Você ainda não tem ingressos liberados.'}</p>
    ${cards}
    <h2>Meus pedidos</h2>${offline ? '<p class="mudo">Indisponível sem conexão.</p>' : pedidos || '<p class="mudo">Nenhum pedido ainda.</p>'}`;

  app.querySelectorAll('[data-transf]').forEach((b) =>
    b.addEventListener('click', () =>
      comEspera(b, async () => {
        const r = await api('POST', `/ingressos/${b.dataset.transf}/transferir`, {});
        const link = `${location.origin}/#/aceitar/${r.token}`;
        const texto = `Seu ingresso para a After Os Brothers está aqui. Abra o link, entre (ou crie sua conta) e aceite: ${link}`;
        const alvo = document.getElementById(`tr-${b.dataset.transf}`);
        alvo.innerHTML = `<div class="card" style="background:#0f0f16">
          <b>Link de transferência (vale 7 dias, uso único)</b>
          <div class="pix">${esc(link)}</div>
          <div class="acoes">
            <a class="bt peq" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(texto)}">Enviar por WhatsApp</a>
            <button class="bt sec peq" id="cp-${b.dataset.transf}">Copiar link</button>
          </div>
          <p class="peq">Seu QR continua valendo até seu amigo aceitar. Depois que ele aceitar, este QR deixa de funcionar.</p></div>`;
        document.getElementById(`cp-${b.dataset.transf}`).addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(link); aviso('Link copiado!'); } catch { aviso('Copie o link manualmente.', 'erro'); }
        });
      }),
    ),
  );
  app.querySelectorAll('[data-cancela]').forEach((b) =>
    b.addEventListener('click', () =>
      comEspera(b, async () => {
        await api('POST', `/ingressos/${b.dataset.cancela}/cancelar-transferencia`, {});
        aviso('Transferência cancelada.');
        navegar();
      }),
    ),
  );
});

rota('/aceitar/([0-9a-f]{32})', async (token) => {
  const info = await api('GET', `/transferencias/${token}`);
  if (!info.valida) {
    app.innerHTML = '<h1>Link indisponível</h1><div class="card">Este link já foi usado, cancelado ou venceu. Peça um novo a quem enviou.</div><a class="bt sec" href="#/">Início</a>';
    return;
  }
  if (!estado.eu) {
    sessionStorage.setItem('voltar', `#/aceitar/${token}`);
    app.innerHTML = `<h1>Você recebeu um ingresso</h1>
      <div class="card atual"><b>${esc(info.de)}</b> quer te passar um ingresso para <b>${esc(info.evento)}</b> (${dataBR(info.data_evento)}).
      <p class="peq">Para receber, entre na sua conta ou crie uma (leva 1 minuto).</p>
      <a class="bt bloco" href="#/entrar">Entrar</a><a class="bt sec bloco" href="#/cadastro">Criar conta</a></div>`;
    return;
  }
  app.innerHTML = `<h1>Você recebeu um ingresso</h1>
    <div class="card atual"><b>${esc(info.de)}</b> quer te passar um ingresso para <b>${esc(info.evento)}</b> (${dataBR(info.data_evento)}).
    <p class="peq">Ao aceitar, o ingresso fica na sua conta, com um QR novo só seu.</p>
    <button class="bt bloco" id="aceitar">Aceitar ingresso</button></div>`;
  document.getElementById('aceitar').addEventListener('click', (e) =>
    comEspera(e.target, async () => {
      await api('POST', `/transferencias/${token}/aceitar`, {});
      aviso('Ingresso recebido!');
      location.hash = '#/meus';
    }),
  );
});

// ---------- login / cadastro ----------
function campoUsuario(extra = '') {
  return `
    <div class="grade"><div><label>Nome</label><input name="nome" required minlength="2" maxlength="40" autocomplete="given-name"></div>
    <div><label>Sobrenome</label><input name="sobrenome" required minlength="2" maxlength="60" autocomplete="family-name"></div></div>
    <label>CPF</label><input name="cpf" inputmode="numeric" required autocomplete="off" placeholder="000.000.000-00">
    <label>E-mail</label><input name="email" type="email" required autocomplete="email">
    <label>Celular (com DDD)</label><input name="telefone" inputmode="tel" required autocomplete="tel" placeholder="11 99999-9999">
    ${extra}`;
}
const campoSenha = (nome = 'senha', rot = 'Senha (mínimo 8 caracteres)') =>
  `<label>${rot}</label><input name="${nome}" type="password" minlength="8" required autocomplete="new-password">`;

async function dadosCadastro(f) {
  const d = dadosForm(f);
  if (!cpfValido(d.cpf)) throw new Error('CPF inválido. Confira os números.');
  if (soDig(d.telefone).length < 10) throw new Error('Informe o celular com DDD.');
  if (d.senha.length < 8) throw new Error('A senha precisa ter no mínimo 8 caracteres.');
  if (d.senha2 !== undefined && d.senha !== d.senha2) throw new Error('As senhas não conferem.');
  return {
    cpf: soDig(d.cpf),
    nome: d.nome.trim(),
    sobrenome: d.sobrenome.trim(),
    email: d.email.trim(),
    telefone: d.telefone,
    senha: await derivar(d.cpf, d.senha),
    resposta: d.resposta === undefined ? undefined : await derivarResposta(d.cpf, d.resposta),
    setup_key: d.setup_key,
  };
}

rota('/entrar', async () => {
  app.innerHTML = `
    <h1>Entrar</h1>
    <form class="card" id="f">
      <label>CPF</label><input name="cpf" inputmode="numeric" required autocomplete="username" placeholder="000.000.000-00">
      <label>Senha</label><input name="senha" type="password" required autocomplete="current-password">
      <button class="bt bloco">Entrar</button>
    </form>
    <p><a href="#/cadastro">Criar conta</a> · <a href="#/esqueci">Esqueci minha senha</a></p>`;
  const f = document.getElementById('f');
  mascaraCpf(f.cpf);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    comEspera(f.querySelector('button'), async () => {
      if (!cpfValido(f.cpf.value)) throw new Error('CPF inválido.');
      await api('POST', '/auth/login', { cpf: soDig(f.cpf.value), senha: await derivar(f.cpf.value, f.senha.value) });
      await carregarEu();
      const volta = sessionStorage.getItem('voltar');
      sessionStorage.removeItem('voltar');
      location.hash = estado.eu?.deve_trocar_senha ? '#/trocar-senha' : volta || (estado.eu?.papel === 'admin' ? '#/admin' : estado.eu?.papel === 'hostess' ? '#/portaria' : '#/');
    });
  });
});

rota('/cadastro', async () => {
  app.innerHTML = `
    <h1>Criar conta</h1>
    <form class="card" id="f">
      ${campoUsuario(campoSenha() + campoSenha('senha2', 'Repita a senha') + campoResposta())}
      <p class="peq">Seus dados são usados apenas para identificar o comprador dos ingressos.</p>
      <button class="bt bloco">Criar conta</button>
    </form>
    <p>Já tem conta? <a href="#/entrar">Entrar</a></p>`;
  const f = document.getElementById('f');
  mascaraCpf(f.cpf);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    comEspera(f.querySelector('button'), async () => {
      const d = await dadosCadastro(f);
      await api('POST', '/auth/cadastro', d);
      await carregarEu();
      const volta = sessionStorage.getItem('voltar');
      sessionStorage.removeItem('voltar');
      location.hash = volta || '#/';
    });
  });
});

rota('/esqueci', async () => {
  app.innerHTML = `
    <h1>Esqueci a senha</h1>
    <form class="card" id="f">
      <label>CPF cadastrado</label><input name="cpf" inputmode="numeric" required>
      <label>Resposta secreta</label><input name="resposta" required maxlength="12" autocomplete="off" autocapitalize="off" spellcheck="false">
      ${campoSenha('nova', 'Nova senha (mínimo 8 caracteres)')}
      ${campoSenha('nova2', 'Repita a nova senha')}
      <button class="bt bloco">Redefinir senha</button>
    </form>
    <p class="peq">Após 5 tentativas erradas a recuperação fica bloqueada por 1 hora e a organização é avisada.</p>
    <p class="peq">Não lembra a resposta (ou sua conta é antiga e não tem uma)? <a href="#" id="pedir">Peça ajuda à organização</a>: ela te passa uma senha provisória pelo WhatsApp.</p>`;
  const f = document.getElementById('f');
  mascaraCpf(f.cpf);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    comEspera(f.querySelector('button'), async () => {
      if (!cpfValido(f.cpf.value)) throw new Error('CPF inválido.');
      if (f.nova.value.length < 8) throw new Error('A nova senha precisa ter no mínimo 8 caracteres.');
      if (f.nova.value !== f.nova2.value) throw new Error('As senhas novas não conferem.');
      await api('POST', '/auth/recuperar', {
        cpf: soDig(f.cpf.value),
        resposta: await derivarResposta(f.cpf.value, f.resposta.value),
        senha_nova: await derivar(f.cpf.value, f.nova.value),
      });
      aviso('Senha redefinida! Entre com a nova senha.');
      location.hash = '#/entrar';
    });
  });
  document.getElementById('pedir').addEventListener('click', (e) => {
    e.preventDefault();
    comEspera(e.target, async () => {
      if (!cpfValido(f.cpf.value)) throw new Error('Preencha o CPF acima primeiro.');
      await api('POST', '/auth/esqueci', { cpf: soDig(f.cpf.value) });
      app.innerHTML = '<h1>Pedido enviado</h1><p class="mudo">Se o CPF estiver cadastrado, a organização recebeu seu pedido e entrará em contato pelo celular cadastrado.</p><a class="bt sec" href="#/entrar">Voltar</a>';
    });
  });
});

// Minha conta: trocar senha e definir/trocar a resposta secreta.
rota('/conta', async () => {
  if (!estado.eu) {
    location.hash = '#/entrar';
    return;
  }
  app.innerHTML = `
    <h1>Minha conta</h1>
    <p class="mudo">${esc(estado.eu.nome)} ${esc(estado.eu.sobrenome)}</p>
    <form class="card" id="f">
      <h2 style="margin-top:0">Resposta secreta</h2>
      <p class="peq">${estado.eu.tem_resposta ? 'Você já tem uma resposta secreta. Preencha abaixo para trocar.' : '<b>Você ainda não definiu uma resposta secreta</b> — sem ela, só a organização consegue refazer sua senha.'}</p>
      <label>Senha atual</label><input name="atual" type="password" required autocomplete="current-password">
      ${campoResposta('Nova resposta secreta (1 palavra, 4 a 8 letras)')}
      <button class="bt bloco">Salvar resposta</button>
    </form>
    <p><a href="#/trocar-senha">Trocar senha</a> · <a href="#/regras">Regras de compra</a></p>`;
  const f = document.getElementById('f');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    comEspera(f.querySelector('button'), async () => {
      const cpfUso = estado.eu.cpf;
      await api('POST', '/auth/resposta', { senha_atual: await derivar(cpfUso, f.atual.value), resposta: await derivarResposta(cpfUso, f.resposta.value) });
      await carregarEu();
      aviso('Resposta secreta salva.');
      location.hash = '#/';
    });
  });
});

// Regras de compra (rascunho — pedir revisão jurídica antes de divulgar em larga escala).
const TERMOS_VERSAO = '2026-10-v1';
const TEXTO_REGRAS = `
  <h2>1. Seu ingresso é pessoal e de uso único</h2>
  <p>Cada ingresso tem um QR Code exclusivo, válido para uma única entrada. Depois que ele é lido na portaria, não vale mais — mesmo que outra pessoa apresente a mesma imagem.</p>
  <h2>2. Você é responsável pelo seu ingresso</h2>
  <p>Quem compra é o responsável pelo ingresso e pelo QR Code. <b>Se você compartilhar, publicar ou enviar print, foto ou arquivo do QR Code e outra pessoa usá-lo antes de você, a entrada será negada, sem direito a reembolso.</b> Qualquer vazamento do QR Code é de inteira responsabilidade de quem comprou.</p>
  <h2>3. Presenteando ou passando o ingresso</h2>
  <p>Para dar o ingresso a outra pessoa, use o botão <b>Transferir</b> em “Meus ingressos”. Isso gera um novo QR para quem recebe e invalida o seu. A transferência encerra 48 horas antes da festa.</p>
  <h2>4. Pagamento</h2>
  <p>O pagamento é por Pix, com a taxa de serviço informada na compra. O ingresso só é liberado depois que a organização confirmar o Pix. Pedidos não pagos dentro do prazo são cancelados.</p>
  <h2>5. Desistência e cancelamento</h2>
  <p>Você pode desistir em até 7 dias após a compra, desde que faltem mais de 48 horas para a festa; o reembolso é feito por Pix. Se a festa for cancelada pela organização, o reembolso é integral, incluindo a taxa de serviço.</p>
  <h2>6. Entrada</h2>
  <p>Leve um documento com foto. A organização pode negar a entrada de quem descumprir as regras do local ou a lei.</p>
  <p class="peq">Versão ${TERMOS_VERSAO}.</p>`;
rota('/regras', async () => {
  app.innerHTML = `<h1>Regras de compra</h1><div class="card regras">${TEXTO_REGRAS}</div><a class="bt sec" href="javascript:history.back()">Voltar</a>`;
});

rota('/trocar-senha', async () => {
  if (!estado.eu) {
    location.hash = '#/entrar';
    return;
  }
  const forcado = estado.eu.deve_trocar_senha;
  app.innerHTML = `
    <h1>Trocar senha</h1>
    ${forcado ? '<p class="mudo">Você entrou com uma senha provisória. Escolha uma nova para continuar.</p>' : ''}
    <form class="card" id="f">
      <label>Senha atual</label><input name="atual" type="password" required autocomplete="current-password">
      ${campoSenha('nova', 'Nova senha (mínimo 8 caracteres)')}
      ${campoSenha('nova2', 'Repita a nova senha')}
      <button class="bt bloco">Salvar nova senha</button>
    </form>`;
  const f = document.getElementById('f');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    comEspera(f.querySelector('button'), async () => {
      if (f.nova.value.length < 8) throw new Error('A nova senha precisa ter no mínimo 8 caracteres.');
      if (f.nova.value !== f.nova2.value) throw new Error('As senhas novas não conferem.');
      const cpfUso = estado.eu.cpf;
      await api('POST', '/auth/trocar-senha', {
        senha_atual: await derivar(cpfUso, f.atual.value),
        senha_nova: await derivar(cpfUso, f.nova.value),
      });
      await carregarEu();
      aviso('Senha alterada!');
      location.hash = estado.eu?.papel === 'admin' ? '#/admin' : estado.eu?.papel === 'hostess' ? '#/portaria' : '#/';
    });
  });
});

// Configuração inicial: cria o PRIMEIRO administrador (exige a SETUP_KEY).
rota('/setup', async () => {
  app.innerHTML = `
    <h1>Configuração inicial</h1>
    <p class="mudo">Cria o primeiro administrador. Só funciona uma vez e exige a chave de configuração (SETUP_KEY) cadastrada no Cloudflare.</p>
    <form class="card" id="f">
      <label>Chave de configuração (SETUP_KEY)</label><input name="setup_key" type="password" required autocomplete="off">
      ${campoUsuario(campoSenha() + campoSenha('senha2', 'Repita a senha') + campoResposta())}
      <button class="bt bloco">Criar administrador</button>
    </form>`;
  const f = document.getElementById('f');
  mascaraCpf(f.cpf);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    comEspera(f.querySelector('button'), async () => {
      const d = await dadosCadastro(f);
      await api('POST', '/setup/admin', d);
      await api('POST', '/auth/login', { cpf: d.cpf, senha: d.senha });
      await carregarEu();
      aviso('Administrador criado!');
      location.hash = '#/admin/config';
    });
  });
});


// ---------- chave Pix ----------
const DICAS_PIX = {
  celular: 'Digite com DDD, ex.: 11 99999-9999. O sistema grava no formato +5511999999999.',
  email: 'O e-mail cadastrado como chave Pix no seu banco.',
  cpf: 'Só os 11 números do CPF cadastrado como chave.',
  cnpj: 'Só os 14 números do CNPJ cadastrado como chave.',
  aleatoria: 'Código aleatório gerado pelo banco (formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function detectarTipoPix(v) {
  const t = String(v || '').trim();
  if (t.includes('@')) return 'email';
  if (UUID_RE.test(t)) return 'aleatoria';
  if (t.startsWith('+')) return 'celular';
  const d = soDig(t);
  if (d.length === 14) return 'cnpj';
  if (d.length === 11) return cpfValido(d) ? 'cpf' : 'celular';
  return 'celular';
}
function normalizarChavePix(tipo, bruto) {
  const t = String(bruto).trim();
  const d = soDig(t);
  if (tipo === 'celular') {
    const num = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d;
    if (num.length < 10 || num.length > 11) throw new Error('Celular inválido: informe DDD + número.');
    return `+55${num}`;
  }
  if (tipo === 'cpf') {
    if (!cpfValido(d)) throw new Error('CPF da chave inválido.');
    return d;
  }
  if (tipo === 'cnpj') {
    if (d.length !== 14) throw new Error('CNPJ da chave precisa ter 14 números.');
    return d;
  }
  if (tipo === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) throw new Error('E-mail da chave inválido.');
    return t.toLowerCase();
  }
  if (!UUID_RE.test(t)) throw new Error('Chave aleatória inválida. Copie exatamente do app do banco.');
  return t.toLowerCase();
}

// ---------- admin ----------
const ABAS = [
  ['financeiro', 'Financeiro'],
  ['pedidos', 'Pedidos'],
  ['eventos', 'Eventos'],
  ['lotes', 'Lotes'],
  ['config', 'Pix e taxas'],
  ['cortesias', 'Cortesias'],
  ['usuarios', 'Usuários'],
  ['avisos', 'Avisos'],
];
function layoutAdmin(ativa, html) {
  app.innerHTML = `
    <h1>Administração</h1>
    <div class="abas">${ABAS.map(([k, n]) => `<a href="#/admin/${k}" class="${k === ativa ? 'on' : ''}">${n}${k === 'avisos' ? `<span class="badge" data-badge-avisos${estado.eu?.nao_lidos ? '' : ' hidden'}>${estado.eu?.nao_lidos || ''}</span>` : ''}</a>`).join('')}</div>
    ${html}`;
}
function exigirAdmin() {
  if (!estado.eu) {
    location.hash = '#/entrar';
    return false;
  }
  if (estado.eu.papel !== 'admin') {
    app.innerHTML = '<p class="mudo">Acesso restrito à administração.</p>';
    return false;
  }
  return true;
}
rota('/admin', async () => {
  if (exigirAdmin()) location.hash = '#/admin/financeiro';
});

rota('/admin/financeiro', async () => {
  if (!exigirAdmin()) return;
  const f = await api('GET', '/admin/financeiro');
  if (!f.evento) return layoutAdmin('financeiro', '<p class="mudo">Nenhum evento ativo.</p>');
  const r = f.resumo;
  const kpi = (t, v, extra = '') => `<div class="kpi ${extra}"><span class="peq">${t}</span><b>${v}</b></div>`;
  layoutAdmin(
    'financeiro',
    `<p class="mudo">${esc(f.evento.nome)} · ${dataBR(f.evento.data_evento)}</p>
    <h2>Dinheiro</h2>
    <div class="kpis">
      ${kpi('Recebido (pedidos confirmados)', brl(r.total_recebido_centavos), 'dest')}
      ${kpi('Em ingressos', brl(r.receita_ingressos_centavos))}
      ${kpi('Em taxa de serviço', brl(r.taxa_servico_centavos))}
      ${kpi('A receber (Pix aguardando)', brl(r.a_receber_centavos))}
    </div>
    <p class="peq">Pix direto na chave: sem taxa de gateway. Pedidos pagos: ${r.pedidos_pagos}. Vencidos sem pagamento: ${r.pedidos_vencidos} (${brl(r.valor_vencido_centavos)}). Cancelados: ${r.pedidos_cancelados}.</p>
    <h2>Ingressos</h2>
    <div class="kpis">
      ${kpi('Vendidos (pagos)', r.ingressos_vendidos)}
      ${kpi('Aguardando pagamento', r.ingressos_aguardando)}
      ${kpi('Cortesias', r.cortesias)}
      ${kpi('Já entraram', r.entraram)}
    </div>
    <h2>Por lote</h2>
    <div class="rolar"><table><tr><th>Lote</th><th class="num">Preço</th><th class="num">Vendidos</th><th class="num">Reservados</th><th class="num">Qtd.</th><th class="num">Receita</th></tr>
    ${f.lotes
      .map(
        (l) => `<tr><td>${esc(l.nome)}${l.ativo ? '' : ' <span class="peq">(inativo)</span>'}</td><td class="num">${brl(l.valor_centavos)}</td><td class="num">${l.vendidos}</td><td class="num">${l.reservados}</td><td class="num">${l.quantidade}</td><td class="num">${brl(l.receita_ingressos_centavos + l.taxa_servico_centavos)}</td></tr>`,
      )
      .join('')}</table></div>`,
  );
});

rota('/admin/pedidos', async () => {
  if (!exigirAdmin()) return;
  const filtro = sessionStorage.getItem('fped') || 'aguardando_pagamento';
  const d = await api('GET', `/admin/pedidos${filtro === 'todos' ? '' : `?status=${filtro}`}`);
  const linhas = d.pedidos
    .map((p) => {
      const st = p.vencido ? 'expirado' : p.status;
      const confirmavel = p.status === 'aguardando_pagamento' || p.status === 'expirado';
      return `<tr>
        <td><b>${esc(p.codigo)}</b><br>${tag(st)}</td>
        <td>${esc(p.comprador)}<br><span class="peq">${esc(p.telefone)} · CPF ${esc(fmtCpf(p.cpf))}</span></td>
        <td>${p.quantidade}× ${esc(p.lote)}<br><span class="peq">Pagador: ${esc(p.nome_pagador)}</span></td>
        <td class="num"><b>${brl(p.total_centavos)}</b><br><span class="peq">${hora(p.criado_em)}</span></td>
        <td><div class="acoes">
          ${confirmavel ? `<button class="bt ok peq" data-conf="${p.id}">Confirmar Pix</button>` : ''}
          ${p.status !== 'cancelado' ? `<button class="bt perigo peq" data-canc="${p.id}" data-pago="${p.status === 'pago' ? 1 : 0}">${p.status === 'pago' ? 'Estornar' : 'Cancelar'}</button>` : ''}
        </div></td></tr>`;
    })
    .join('');
  layoutAdmin(
    'pedidos',
    `<div class="linha"><select id="fil" style="max-width:15rem">
      ${[['aguardando_pagamento', 'Aguardando pagamento'], ['pago', 'Pagos'], ['expirado', 'Expirados'], ['cancelado', 'Cancelados'], ['todos', 'Todos']]
        .map(([v, n]) => `<option value="${v}" ${v === filtro ? 'selected' : ''}>${n}</option>`)
        .join('')}</select>
      <button class="bt sec peq" id="atualiza">Atualizar</button></div>
    <p class="peq">Confira no extrato do banco: valor exato, horário e nome do pagador. Só então toque em "Confirmar Pix".</p>
    <div class="rolar"><table><tr><th>Pedido</th><th>Comprador</th><th>Itens</th><th class="num">Total</th><th></th></tr>${linhas || '<tr><td colspan="5" class="mudo">Nenhum pedido.</td></tr>'}</table></div>`,
  );
  document.getElementById('fil').addEventListener('change', (e) => {
    sessionStorage.setItem('fped', e.target.value);
    navegar();
  });
  document.getElementById('atualiza').addEventListener('click', navegar);
  app.querySelectorAll('[data-conf]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm('Confirmar que o Pix deste pedido caiu na conta?')) return;
      comEspera(b, async () => {
        await api('POST', `/admin/pedidos/${b.dataset.conf}/confirmar`, {});
        aviso('Pedido confirmado. Ingressos liberados.');
        navegar();
      });
    }),
  );
  app.querySelectorAll('[data-canc]').forEach((b) =>
    b.addEventListener('click', () => {
      const pago = b.dataset.pago === '1';
      if (!confirm(pago ? 'Estornar: os ingressos serão cancelados e você deverá devolver o Pix manualmente. Continuar?' : 'Cancelar este pedido e liberar a reserva?')) return;
      comEspera(b, async () => {
        await api('POST', `/admin/pedidos/${b.dataset.canc}/cancelar`, {});
        aviso(pago ? 'Estornado. Lembre de devolver o Pix.' : 'Pedido cancelado.');
        navegar();
      });
    }),
  );
});

rota('/admin/eventos', async () => {
  if (!exigirAdmin()) return;
  const ev = await api('GET', '/admin/eventos');
  const lista = ev.eventos
    .map(
      (e) => `<div class="card"><div class="linha"><div><b>${esc(e.nome)}</b><div class="peq">${dataBR(e.data_evento)} · ${esc(e.hora_inicio || '22:00')}${e.local ? ` · ${esc(e.local)}` : ''}</div></div>
      <div class="acoes">${e.ativo ? '<span class="tag valido">À venda</span>' : `<button class="bt peq" data-ativar="${e.id}">Tornar ativo</button>`}</div></div></div>`,
    )
    .join('');
  layoutAdmin(
    'eventos',
    `<p class="peq">Só <b>um evento fica ativo</b> por vez: é o que aparece para venda e o que a portaria usa. Troque o ativo só depois que a portaria da festa anterior encerrar. Os ingressos de festas anteriores continuam salvos.</p>
    ${lista || '<p class="mudo">Nenhum evento ainda.</p>'}
    <h2>Novo evento</h2>
    <form class="card" id="fnovo">
      <label>Nome</label><input name="nome" placeholder="Festa dos amigos" required>
      <div class="grade"><div><label>Data</label><input name="data_evento" type="date" required></div>
      <div><label>Horário de início</label><input name="hora_inicio" type="time" value="22:00" required></div></div>
      <label>Local</label><input name="local">
      <label>Descrição</label><textarea name="descricao" rows="3"></textarea>
      <label><input type="checkbox" name="ativo" style="width:auto"> Já deixar este evento ativo (à venda agora)</label>
      <p class="peq">Depois de criar, vá em <b>Lotes</b> para cadastrar valor e quantidade (com o evento ativo).</p>
      <button class="bt bloco">Criar evento</button></form>`,
  );
  app.querySelectorAll('[data-ativar]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm('Tornar este o evento ativo? A venda e a portaria passam a usar ele.')) return;
      comEspera(b, async () => {
        await api('PUT', `/admin/eventos/${b.dataset.ativar}`, { ativo: true });
        estado.evento = null;
        aviso('Evento ativado.');
        navegar();
      });
    }),
  );
  document.getElementById('fnovo').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    comEspera(f.querySelector('button'), async () => {
      await api('POST', '/admin/eventos', { nome: f.nome.value, data_evento: f.data_evento.value, hora_inicio: f.hora_inicio.value, local: f.local.value, descricao: f.descricao.value, ativo: f.ativo.checked });
      estado.evento = null;
      aviso('Evento criado.');
      navegar();
    });
  });
});

rota('/admin/lotes', async () => {
  if (!exigirAdmin()) return;
  const ev = await api('GET', '/admin/eventos');
  const evAtivo = ev.eventos.find((e) => e.ativo) || ev.eventos[0];
  const lo = await api('GET', `/admin/lotes${evAtivo ? `?evento_id=${evAtivo.id}` : ''}`);
  const cards = lo.lotes
    .map(
      (l) => `<form class="card" data-lote="${l.id}">
      <div class="linha"><b>Lote #${l.id}</b><span class="peq">vendidos ${l.vendidos} · reservados ${l.reservados}</span></div>
      <div class="grade">
        <div><label>Nome</label><input name="nome" value="${esc(l.nome)}" required></div>
        <div><label>Valor do ingresso (R$)</label><input name="valor" inputmode="decimal" value="${reais(l.valor_centavos)}" required></div>
        <div><label>Quantidade total</label><input name="quantidade" inputmode="numeric" value="${l.quantidade}" required></div>
        <div><label>Ordem de venda (1 = primeiro)</label><input name="ordem" inputmode="numeric" value="${l.ordem}"></div>
      </div>
      <label><input type="checkbox" name="ativo" ${l.ativo ? 'checked' : ''} style="width:auto"> Lote ativo (visível para venda)</label>
      <button class="bt peq" style="margin-top:.75rem">Salvar lote</button></form>`,
    )
    .join('');
  layoutAdmin(
    'lotes',
    `<h2>Evento ativo</h2>
    <p class="peq">Para criar outra festa ou trocar o evento à venda, use a aba <a href="#/admin/eventos">Eventos</a>.</p>
    <form class="card" id="fev" data-id="${evAtivo?.id ?? ''}">
      <label>Nome</label><input name="nome" value="${esc(evAtivo?.nome)}" required>
      <div class="grade"><div><label>Data</label><input name="data_evento" type="date" value="${esc(evAtivo?.data_evento)}" required></div>
      <div><label>Local</label><input name="local" value="${esc(evAtivo?.local)}"></div></div>
      <label>Horário de início</label><input name="hora_inicio" type="time" value="${esc(evAtivo?.hora_inicio || '22:00')}" required>
      <label>Descrição</label><textarea name="descricao" rows="3">${esc(evAtivo?.descricao)}</textarea>
      <button class="bt peq" style="margin-top:.75rem">Salvar evento</button></form>
    <h2>Lotes</h2>${cards || '<p class="mudo">Nenhum lote ainda.</p>'}
    <h2>Novo lote</h2>
    <form class="card" id="fnovo">
      <div class="grade">
        <div><label>Nome</label><input name="nome" placeholder="1º lote" required></div>
        <div><label>Valor do ingresso (R$)</label><input name="valor" inputmode="decimal" placeholder="35,00" required></div>
        <div><label>Quantidade</label><input name="quantidade" inputmode="numeric" required></div>
        <div><label>Ordem de venda (1 = primeiro)</label><input name="ordem" inputmode="numeric" value="${lo.lotes.length + 1}"></div>
      </div>
      <p class="peq">Ordem de venda: o lote de menor número é vendido primeiro; quando esgota, o site destaca o próximo automaticamente. A taxa de serviço (%) é aplicada por cima do valor e aparece para o comprador.</p>
      <button class="bt peq">Criar lote</button></form>`,
  );
  const lerLote = (f) => {
    const valor = centavos(f.valor.value);
    const quantidade = Number(soDig(f.quantidade.value));
    if (!Number.isFinite(valor) || valor < 0) throw new Error('Valor inválido.');
    if (f.quantidade.value.trim() === '' || !Number.isInteger(quantidade)) throw new Error('Quantidade inválida.');
    return { nome: f.nome.value.trim(), valor_centavos: valor, quantidade, ordem: Number(soDig(f.ordem.value) || 0) };
  };
  document.getElementById('fev').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    comEspera(f.querySelector('button'), async () => {
      const corpo = { nome: f.nome.value, data_evento: f.data_evento.value, local: f.local.value, descricao: f.descricao.value, hora_inicio: f.hora_inicio.value, ativo: true };
      if (f.dataset.id) await api('PUT', `/admin/eventos/${f.dataset.id}`, corpo);
      else await api('POST', '/admin/eventos', corpo);
      aviso('Evento salvo.');
      navegar();
    });
  });
  app.querySelectorAll('form[data-lote]').forEach((f) =>
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      comEspera(f.querySelector('button'), async () => {
        await api('PUT', `/admin/lotes/${f.dataset.lote}`, { ...lerLote(f), ativo: f.ativo.checked });
        aviso('Lote salvo.');
        navegar();
      });
    }),
  );
  document.getElementById('fnovo').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    comEspera(f.querySelector('button'), async () => {
      await api('POST', '/admin/lotes', { ...lerLote(f), evento_id: evAtivo.id, ativo: true });
      aviso('Lote criado.');
      navegar();
    });
  });
});

rota('/admin/config', async () => {
  if (!exigirAdmin()) return;
  const c = await api('GET', '/admin/config');
  layoutAdmin(
    'config',
    `<form class="card" id="f">
      <h2 style="margin-top:0">Recebimento por Pix (chave)</h2>
      <label>Tipo da chave Pix</label>
      <select name="pix_tipo">
        <option value="celular">Celular</option><option value="email">E-mail</option>
        <option value="cpf">CPF</option><option value="cnpj">CNPJ</option><option value="aleatoria">Chave aleatória</option>
      </select>
      <label>Chave Pix</label><input name="pix_chave" value="${esc(c.pix_chave)}" autocomplete="off" autocapitalize="off">
      <p class="peq" id="dica-pix"></p>
      <div class="grade"><div><label>Nome do favorecido (como no banco)</label><input name="pix_nome" value="${esc(c.pix_nome)}" maxlength="25"></div>
      <div><label>Cidade</label><input name="pix_cidade" value="${esc(c.pix_cidade)}" maxlength="15" placeholder="SAO PAULO"></div></div>
      <h2>Regras de venda</h2>
      <div class="grade"><div><label>Taxa de serviço (%)</label><input name="taxa_percentual" inputmode="numeric" value="${esc(c.taxa_percentual)}"></div>
      <div><label>Prazo da reserva (minutos)</label><input name="reserva_minutos" inputmode="numeric" value="${esc(c.reserva_minutos)}"></div>
      <div><label>Máximo de ingressos por pedido</label><input name="max_ingressos_por_pedido" inputmode="numeric" value="${esc(c.max_ingressos_por_pedido)}"></div>
      <div><label>Transferências encerram (horas antes da festa)</label><input name="transferencia_limite_horas" inputmode="numeric" value="${esc(c.transferencia_limite_horas ?? 48)}"></div></div>
      <p class="peq">Alterar a taxa vale só para pedidos novos; pedidos já feitos mantêm o valor combinado.</p>
      <button class="bt bloco">Salvar</button></form>`,
  );
  const f = document.getElementById('f');
  f.pix_tipo.value = detectarTipoPix(f.pix_chave.value);
  const dicaPix = () => (document.getElementById('dica-pix').textContent = DICAS_PIX[f.pix_tipo.value]);
  f.pix_tipo.addEventListener('change', dicaPix);
  dicaPix();
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    comEspera(f.querySelector('button'), async () => {
      const d = dadosForm(f);
      const corpo = {};
      for (const [k, v] of Object.entries(d)) {
        if (k === 'pix_tipo') continue;
        if (String(v).trim() !== '') corpo[k] = ['pix_chave', 'pix_nome', 'pix_cidade'].includes(k) ? v.trim() : Number(v);
      }
      if (corpo.pix_chave !== undefined) corpo.pix_chave = normalizarChavePix(f.pix_tipo.value, corpo.pix_chave);
      await api('PUT', '/admin/config', corpo);
      aviso('Configurações salvas.');
    });
  });
});

rota('/admin/usuarios', async () => {
  if (!exigirAdmin()) return;
  const [u, rs] = await Promise.all([api('GET', '/admin/usuarios'), api('GET', '/admin/resets')]);
  const resets = rs.resets.length
    ? `<h2>Pedidos de nova senha</h2>${rs.resets
        .map(
          (r) => `<div class="card atual"><div class="linha"><div><b>${esc(r.nome)}</b><br><span class="peq">${esc(r.telefone)} · ${hora(r.criado_em)}</span></div>
          <button class="bt peq" data-senha="${r.usuario_id}" data-cpf="${esc(r.cpf)}">Definir senha provisória</button></div></div>`,
        )
        .join('')}`
    : '';
  layoutAdmin(
    'usuarios',
    `${resets}
    <h2>Cadastrar recepcionista (hostess) ou admin</h2>
    <form class="card" id="f">
      ${campoUsuario('<label>Perfil</label><select name="papel"><option value="hostess">Hostess (leitura de QR e lista)</option><option value="admin">Administrador</option></select>' + campoSenha('senha', 'Senha provisória (ela troca no 1º acesso)'))}
      <button class="bt bloco">Cadastrar</button></form>
    <h2>Usuários (${u.usuarios.length})</h2>
    <div class="rolar"><table><tr><th>Nome</th><th>Perfil</th><th>Contato</th><th></th></tr>
    ${u.usuarios
      .map(
        (x) => `<tr><td>${esc(x.nome)} ${esc(x.sobrenome)}</td><td>${x.id === estado.eu.id ? esc(x.papel) : `<select data-papel="${x.id}" style="width:auto;padding:.3rem .5rem"><option value="comprador"${x.papel === 'comprador' ? ' selected' : ''}>comprador</option><option value="hostess"${x.papel === 'hostess' ? ' selected' : ''}>hostess</option><option value="admin"${x.papel === 'admin' ? ' selected' : ''}>admin</option></select>`}${x.ativo ? '' : ' <span class="tag cancelado">inativo</span>'}</td>
        <td class="peq">${esc(x.telefone)}<br>${esc(x.email)}</td>
        <td><div class="acoes"><button class="bt sec peq" data-senha="${x.id}" data-cpf="${esc(x.cpf)}">Nova senha</button>
        ${x.id !== estado.eu.id ? `<button class="bt sec peq" data-ativo="${x.id}" data-v="${x.ativo ? 0 : 1}">${x.ativo ? 'Desativar' : 'Reativar'}</button>` : ''}</div></td></tr>`,
      )
      .join('')}</table></div>`,
  );
  app.querySelectorAll('select[data-papel]').forEach((sel) =>
    sel.addEventListener('change', async () => {
      if (!confirm(`Mudar o perfil desta pessoa para "${sel.value}"?`)) return navegar();
      try {
        await api('PUT', `/admin/usuarios/${sel.dataset.papel}`, { papel: sel.value });
        aviso('Perfil atualizado.');
      } catch (e) {
        aviso(e.message, 'erro');
      }
      navegar();
    }),
  );
  const f = document.getElementById('f');
  mascaraCpf(f.cpf);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    comEspera(f.querySelector('button'), async () => {
      const d = await dadosCadastro(f);
      await api('POST', '/admin/usuarios', { ...d, papel: f.papel.value });
      aviso('Usuário cadastrado.');
      navegar();
    });
  });
  app.querySelectorAll('[data-senha]').forEach((b) =>
    b.addEventListener('click', () => {
      const nova = prompt('Digite a senha provisória (mínimo 8 caracteres). Passe para a pessoa por WhatsApp:');
      if (!nova) return;
      if (nova.length < 8) return aviso('Mínimo de 8 caracteres.', 'erro');
      comEspera(b, async () => {
        await api('POST', `/admin/usuarios/${b.dataset.senha}/definir-senha`, { senha: await derivar(b.dataset.cpf, nova) });
        aviso('Senha provisória definida.');
        navegar();
      });
    }),
  );
  app.querySelectorAll('[data-ativo]').forEach((b) =>
    b.addEventListener('click', () =>
      comEspera(b, async () => {
        await api('PUT', `/admin/usuarios/${b.dataset.ativo}`, { ativo: b.dataset.v === '1' });
        navegar();
      }),
    ),
  );
});

// ---------- portaria (hostess/admin): leitura de QR com modo offline ----------
const sha256Txt = async (t) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const horaCurta = (t) => (t ? new Date(t * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');

const PORT_KEY = 'portaria_v1';
const P = Object.assign({ lista: [], gerado_em: 0, fila: [], conflitos: [], evento: null }, lerCache(PORT_KEY) || {});
const salvarP = () => gravarCache(PORT_KEY, P);

async function apiTimeout(metodo, caminho, corpo, ms = 4000) {
  return Promise.race([
    api(metodo, caminho, corpo),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Sem conexão (tempo esgotado).')), ms)),
  ]);
}
const contagemLocal = () => ({
  total: P.lista.filter((i) => i.status !== 'cancelado').length,
  entraram: P.lista.filter((i) => i.status === 'usado').length,
});

async function atualizarLista() {
  const d = await api('GET', '/portaria/lista');
  const pend = new Set(P.fila.map((f) => f.h).filter(Boolean));
  const pendIds = new Set(P.fila.map((f) => f.ingresso_id).filter(Boolean));
  P.lista = d.ingressos.map((i) => (i.status === 'valido' && (pend.has(i.h) || pendIds.has(i.id)) ? { ...i, status: 'usado', usado_em: i.usado_em || Math.floor(Date.now() / 1000) } : i));
  P.gerado_em = d.gerado_em;
  P.evento = d.evento;
  salvarP();
}

async function sincronizarFila() {
  if (!P.fila.length) return 0;
  const lote = P.fila.slice(0, 200);
  const r = await api('POST', '/portaria/sincronizar', { usos: lote.map(({ qr, ingresso_id, em }) => (qr ? { qr, em } : { ingresso_id, em })) });
  const falhas = r.resultados.filter((x) => x.resultado !== 'ok');
  P.fila = P.fila.slice(lote.length);
  if (falhas.length) P.conflitos.push(...falhas.map((x) => ({ nome: x.nome || '—', resultado: x.resultado, usado_em: x.usado_em, quando: Date.now() })));
  salvarP();
  return lote.length;
}

async function validarQr(qr) {
  try {
    const r = await apiTimeout('POST', '/portaria/validar', { qr });
    const it = P.lista.find((i) => i.id === r.ingresso_id);
    if (it && (r.resultado === 'ok' || r.resultado === 'usado')) {
      it.status = 'usado';
      it.usado_em = r.usado_em;
      salvarP();
    }
    return r;
  } catch (e) {
    if (e.status) throw e; // 401/403/409: o servidor respondeu
  }
  // Sem internet: confere na lista salva no aparelho.
  const h = await sha256Txt(qr);
  const it = P.lista.find((i) => i.h === h);
  const base = { offline: true };
  if (!it) return { resultado: 'invalido', ...base };
  const info = { nome: it.nome, tipo: it.tipo, motivo: it.motivo, ingresso_id: it.id };
  if (it.status === 'cancelado') return { resultado: 'cancelado', ...info, ...base };
  if (it.status === 'usado') return { resultado: 'usado', ...info, usado_em: it.usado_em, ...base };
  it.status = 'usado';
  it.usado_em = Math.floor(Date.now() / 1000);
  P.fila.push({ qr, h, em: it.usado_em });
  salvarP();
  return { resultado: 'ok', ...info, usado_em: it.usado_em, ...contagemLocal(), ...base };
}

async function entradaManual(it) {
  try {
    const r = await apiTimeout('POST', '/portaria/entrada-manual', { ingresso_id: it.id });
    if (r.resultado === 'ok' || r.resultado === 'usado') {
      it.status = 'usado';
      it.usado_em = r.usado_em;
      salvarP();
    }
    return r;
  } catch (e) {
    if (e.status) throw e;
  }
  if (it.status !== 'valido') return { resultado: it.status === 'usado' ? 'usado' : 'cancelado', nome: it.nome, usado_em: it.usado_em, offline: true };
  it.status = 'usado';
  it.usado_em = Math.floor(Date.now() / 1000);
  P.fila.push({ ingresso_id: it.id, em: it.usado_em });
  salvarP();
  return { resultado: 'ok', nome: it.nome, tipo: it.tipo, motivo: it.motivo, usado_em: it.usado_em, offline: true, ...contagemLocal() };
}

const TELAS = {
  ok: ['ok', 'ENTRADA LIBERADA'],
  usado: ['erro', 'INGRESSO JÁ USADO'],
  invalido: ['erro', 'QR INVÁLIDO'],
  cancelado: ['erro', 'INGRESSO CANCELADO'],
  outro_evento: ['aviso', 'INGRESSO DE OUTRO EVENTO'],
};

rota('/portaria', async () => {
  if (!estado.eu) {
    location.hash = '#/entrar';
    return;
  }
  if (!['hostess', 'admin'].includes(estado.eu.papel)) {
    app.innerHTML = '<p class="mudo">Acesso restrito à portaria.</p>';
    return;
  }
  let aba = 'ler';
  let stream = null;
  let travado = false;
  let ultimo = { qr: '', t: 0 };
  let rodando = true;
  let overlayTimer;

  app.innerHTML = `
    <div class="linha"><h1 style="margin:0">Portaria</h1><span id="conn" class="tag"></span></div>
    <p class="mudo" id="resumo"></p>
    <div id="conflitos"></div>
    <div class="abas"><a href="#" data-aba="ler" class="on">Ler QR</a><a href="#" data-aba="lista">Lista</a></div>
    <div id="aba-ler">
      <div class="camera"><video id="video" playsinline muted></video><canvas id="cv" hidden></canvas></div>
      <div class="acoes" style="margin:.75rem 0"><button class="bt" id="btcam">Abrir câmera</button><button class="bt sec" id="btatualiza">Atualizar lista</button></div>
      <p class="peq" id="camerro"></p>
    </div>
    <div id="aba-lista" hidden>
      <input id="busca" placeholder="Buscar por nome…" autocomplete="off">
      <div id="itens"></div>
    </div>
    <div id="overlay" class="overlay" hidden></div>`;
  const $ = (id) => document.getElementById(id);

  const desenharTopo = () => {
    const c = navigator.onLine ? null : null;
    const on = navigator.onLine;
    $('conn').textContent = on ? 'online' : 'SEM INTERNET';
    $('conn').className = `tag ${on ? 'valido' : 'aguardando_pagamento'}`;
    const n = contagemLocal();
    $('resumo').innerHTML = `${esc(P.evento?.nome || '')} · <b>${n.entraram}</b> entraram de <b>${n.total}</b> ingressos${P.fila.length ? ` · <span style="color:var(--cor2)">${P.fila.length} a sincronizar</span>` : ''}${P.gerado_em ? ` · lista de ${horaCurta(P.gerado_em)}` : ' · lista ainda não baixada'}`;
    $('conflitos').innerHTML = P.conflitos.length
      ? `<div class="card" style="border-color:var(--erro)"><b>${P.conflitos.length} conflito(s) ao sincronizar</b> (entradas feitas sem internet que o sistema já tinha como usadas/canceladas):<ul class="peq">${P.conflitos.map((x) => `<li>${esc(x.nome)}: ${esc(x.resultado)}</li>`).join('')}</ul><button class="bt sec peq" id="okconf">Entendi</button></div>`
      : '';
    $('okconf')?.addEventListener('click', () => { P.conflitos = []; salvarP(); desenharTopo(); });
  };

  const mostrarResultado = (r) => {
    const [cls, titulo] = TELAS[r.resultado] || TELAS.invalido;
    const ov = $('overlay');
    const linhas = [];
    if (r.nome) linhas.push(`<div class="nome">${esc(r.nome)}</div>`);
    if (r.tipo === 'cortesia') linhas.push(`<div>Cortesia${r.motivo ? ` · ${esc(r.motivo)}` : ''}</div>`);
    if (r.resultado === 'usado') linhas.push(`<div>Já entrou às ${horaCurta(r.usado_em)}</div>${r.usado_por ? `<div class="peq-ov">Portaria: ${esc(r.usado_por)}</div>` : ''}`);
    if (r.resultado === 'invalido') linhas.push('<div>Código não reconhecido. Peça para atualizar a tela do ingresso.</div>');
    if (r.offline) linhas.push('<div class="peq-ov">conferido sem internet</div>');
    ov.className = `overlay ${cls}`;
    ov.innerHTML = `<div class="ov-corpo"><div class="ov-titulo">${titulo}</div>${linhas.join('')}<button class="bt bloco" id="prox">${cls === 'ok' ? 'Próximo' : 'Entendi'}</button></div>`;
    ov.hidden = false;
    if (navigator.vibrate) navigator.vibrate(cls === 'ok' ? 80 : [200, 80, 200]);
    const fechar = () => { clearTimeout(overlayTimer); ov.hidden = true; travado = false; };
    $('prox').addEventListener('click', fechar);
    if (cls === 'ok') overlayTimer = setTimeout(fechar, 2500);
    desenharTopo();
  };

  const processar = async (qr) => {
    travado = true;
    try {
      const r = await validarQr(qr);
      mostrarResultado(r);
    } catch (e) {
      travado = false;
      aviso(e.status === 401 ? 'Sessão expirada. Entre novamente.' : e.message, 'erro');
    }
  };

  const loopCamera = () => {
    if (!rodando) return;
    const v = $('video');
    if (stream && !travado && v.readyState >= 2 && v.videoWidth) {
      const cv = $('cv');
      const esc_ = Math.min(1, 640 / v.videoWidth);
      cv.width = Math.round(v.videoWidth * esc_);
      cv.height = Math.round(v.videoHeight * esc_);
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, cv.width, cv.height);
      const img = ctx.getImageData(0, 0, cv.width, cv.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data && (code.data !== ultimo.qr || Date.now() - ultimo.t > 4000)) {
        ultimo = { qr: code.data, t: Date.now() };
        processar(code.data);
      }
    }
    setTimeout(() => requestAnimationFrame(loopCamera), 120);
  };

  const abrirCamera = async () => {
    $('camerro').textContent = '';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      const v = $('video');
      v.srcObject = stream;
      await v.play();
      $('btcam').textContent = 'Fechar câmera';
    } catch (e) {
      stream = null;
      $('camerro').textContent = 'Não consegui abrir a câmera. Permita o acesso à câmera no navegador (cadeado ao lado do endereço).';
    }
  };
  const fecharCamera = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    $('video').srcObject = null;
    $('btcam').textContent = 'Abrir câmera';
  };
  $('btcam').addEventListener('click', () => (stream ? fecharCamera() : abrirCamera()));
  $('btatualiza').addEventListener('click', (e) =>
    comEspera(e.target, async () => {
      await sincronizarFila();
      await atualizarLista();
      desenharTopo();
      desenharLista();
      aviso('Lista atualizada.');
    }),
  );

  const desenharLista = () => {
    const q = semAcento($('busca').value.trim());
    const itens = P.lista.filter((i) => !q || semAcento(i.nome).includes(q)).slice(0, 150);
    $('itens').innerHTML = itens.length
      ? itens
          .map(
            (i) => `<div class="card"><div class="linha"><div><b>${esc(i.nome)}</b><div class="peq">#${i.id}${i.tipo === 'cortesia' ? ` · cortesia${i.motivo ? ` (${esc(i.motivo)})` : ''}` : ''}${i.status === 'usado' ? ` · entrou ${horaCurta(i.usado_em)}` : ''}</div></div>
            <div class="acoes">${i.desfeitos ? `<span class="tag cancelado" title="Entrada desfeita">desfeito ${i.desfeitos}×</span>` : ''}${tag(i.status)}${i.status === 'valido' ? `<button class="bt peq" data-man="${i.id}">Dar entrada</button>` : ''}${i.status === 'usado' ? `<button class="bt sec peq" data-des="${i.id}">Desfazer</button>` : ''}</div></div></div>`,
          )
          .join('')
      : '<p class="mudo">Nenhum ingresso encontrado.</p>';
    $('itens').querySelectorAll('[data-man]').forEach((b) =>
      b.addEventListener('click', async () => {
        const it = P.lista.find((x) => x.id === Number(b.dataset.man));
        if (!it || !confirm(`Dar entrada manual para ${it.nome}? Use só se o QR não puder ser lido.`)) return;
        try {
          mostrarResultado(await entradaManual(it));
          desenharLista();
        } catch (e) {
          aviso(e.message, 'erro');
        }
      }),
    );
    $('itens').querySelectorAll('[data-des]').forEach((b) =>
      b.addEventListener('click', async () => {
        const it = P.lista.find((x) => x.id === Number(b.dataset.des));
        if (!it) return;
        if (!navigator.onLine) return aviso('Desfazer só funciona com internet.', 'erro');
        const pin = await pedirPin(`Desfazer a entrada de ${it.nome}`);
        if (pin === null) return;
        try {
          const r = await api('POST', '/portaria/desfazer', { ingresso_id: it.id, pin });
          it.status = 'valido';
          it.usado_em = null;
          it.desfeitos = r.desfeitos;
          salvarP();
          desenharLista();
          aviso('Entrada desfeita.');
        } catch (e) {
          aviso(e.message, 'erro');
        }
      }),
    );
  };
  $('busca').addEventListener('input', desenharLista);

  app.querySelectorAll('[data-aba]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      aba = a.dataset.aba;
      app.querySelectorAll('[data-aba]').forEach((x) => x.classList.toggle('on', x === a));
      $('aba-ler').hidden = aba !== 'ler';
      $('aba-lista').hidden = aba !== 'lista';
      if (aba === 'lista') desenharLista();
    }),
  );

  // Rotina de fundo: sincroniza entradas feitas offline e renova a lista.
  const rotina = async () => {
    if (!navigator.onLine || !rodando) return;
    try {
      await sincronizarFila();
      if (Date.now() / 1000 - P.gerado_em > 120) await atualizarLista();
    } catch {}
    if (rodando) {
      desenharTopo();
      if (aba === 'lista') desenharLista();
    }
  };
  const timer = setInterval(rotina, 15000);
  const aoVoltar = () => { desenharTopo(); rotina(); };
  window.addEventListener('online', aoVoltar);
  window.addEventListener('offline', desenharTopo);
  limpezas.push(() => {
    rodando = false;
    clearInterval(timer);
    clearTimeout(overlayTimer);
    window.removeEventListener('online', aoVoltar);
    window.removeEventListener('offline', desenharTopo);
    stream?.getTracks().forEach((t) => t.stop());
  });

  desenharTopo();
  loopCamera();
  if (navigator.onLine) {
    try {
      await sincronizarFila();
      await atualizarLista();
    } catch (e) {
      if (e.status) aviso(e.message, 'erro');
    }
    desenharTopo();
  } else if (!P.lista.length) {
    aviso('Sem internet e sem lista salva. Conecte-se ao menos uma vez antes da festa.', 'erro');
  }
});

// Caixa para digitar a senha de desbloqueio (não mostra o que é digitado). Devolve null se cancelar.
function pedirPin(titulo) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'overlay modal';
    ov.innerHTML = `<form class="card ov-corpo"><h2 style="margin-top:0">${esc(titulo)}</h2>
      <label>Senha de desbloqueio</label><input name="pin" type="password" required autocomplete="off" inputmode="text">
      <div class="acoes" style="margin-top:1rem"><button class="bt">Confirmar</button><button type="button" class="bt sec" id="cancela">Cancelar</button></div>
      <p class="peq">O administrador recebe um aviso sempre que uma entrada é desfeita.</p></form>`;
    document.body.appendChild(ov);
    const f = ov.querySelector('form');
    f.pin.focus();
    const fim = (v) => { ov.remove(); resolve(v); };
    f.addEventListener('submit', (e) => { e.preventDefault(); fim(f.pin.value); });
    ov.querySelector('#cancela').addEventListener('click', () => fim(null));
  });
}

// ---------- avisos (admin) ----------
const b64uParaBytes = (b) => {
  const t = (b + '='.repeat((4 - (b.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
};
async function pushAtivo() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(reg && (await reg.pushManager.getSubscription()));
  } catch { return false; }
}
rota('/admin/avisos', async () => {
  if (!exigirAdmin()) return;
  const [d, cfg] = await Promise.all([api('GET', '/admin/alertas'), api('GET', '/admin/config')]);
  const suporta = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const ativo = suporta && (await pushAtivo());
  layoutAdmin(
    'avisos',
    `<div class="card"><h2 style="margin-top:0">Notificações no celular</h2>
      ${suporta ? `<p class="peq">${ativo ? 'Ativadas neste aparelho.' : 'Desativadas neste aparelho.'} No iPhone só funciona com o site instalado na tela inicial.</p>
      <div class="acoes"><button class="bt" id="pushon">${ativo ? 'Reativar' : 'Ativar notificações'}</button>${ativo ? '<button class="bt sec" id="pushtest">Enviar teste</button><button class="bt sec" id="pushoff">Desativar</button>' : ''}</div>` : '<p class="peq">Este navegador não suporta notificações.</p>'}
    </div>
    <form class="card" id="fpin"><h2 style="margin-top:0">Senha de desbloqueio da recepção</h2>
      <p class="peq">${cfg.pin_definido ? 'Já definida.' : '<b>Ainda não definida</b> — sem ela a recepcionista não consegue desfazer entradas.'} Ela precisa digitá-la para desfazer uma entrada; você recebe um aviso a cada uso.</p>
      <label>Nova senha (4 a 12 caracteres)</label><input name="pin" required minlength="4" maxlength="12" autocomplete="off">
      <button class="bt bloco">Salvar senha</button></form>
    <div class="card"><div class="linha"><h2 style="margin:0">Avisos</h2>${d.nao_lidos ? '<button class="bt sec peq" id="lidos">Marcar como lidos</button>' : ''}</div>
      ${d.alertas.length ? d.alertas.map((a) => `<div class="linha" style="margin-top:.6rem"><div>${a.lido_em ? '' : '<span class="badge">novo</span> '}${esc(a.detalhe)}<div class="peq">${hora(a.criado_em)}</div></div></div>`).join('') : '<p class="mudo">Nenhum aviso ainda.</p>'}
    </div>`,
  );
  document.getElementById('lidos')?.addEventListener('click', (e) =>
    comEspera(e.target, async () => {
      await api('POST', '/admin/alertas/lidos', {});
      await carregarEu();
      navegar();
    }),
  );
  document.getElementById('fpin').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    comEspera(f.querySelector('button'), async () => {
      await api('PUT', '/admin/pin', { pin: f.pin.value });
      f.reset();
      aviso('Senha de desbloqueio salva.');
    });
  });
  document.getElementById('pushon')?.addEventListener('click', (e) =>
    comEspera(e.target, async () => {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Permissão negada. Libere as notificações nas configurações do navegador.');
      const reg = await navigator.serviceWorker.ready;
      const { publica } = await api('GET', '/admin/push/chave');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uParaBytes(publica) });
      await api('POST', '/admin/push/assinar', { endpoint: sub.endpoint });
      aviso('Notificações ativadas.');
      navegar();
    }),
  );
  document.getElementById('pushtest')?.addEventListener('click', (e) =>
    comEspera(e.target, async () => {
      const r = await api('POST', '/admin/push/teste', {});
      aviso(`Teste enviado (${r.enviados ?? 0} aparelho${r.enviados === 1 ? '' : 's'}).`);
    }),
  );
  document.getElementById('pushoff')?.addEventListener('click', (e) =>
    comEspera(e.target, async () => {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api('POST', '/admin/push/cancelar', { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      aviso('Notificações desativadas.');
      navegar();
    }),
  );
});

rota('/admin/cortesias', async () => {
  if (!exigirAdmin()) return;
  const lista = await api('GET', '/admin/cortesias');
  layoutAdmin(
    'cortesias',
    `<form class="card" id="f">
      <label>Motivo (aparece na portaria)</label><input name="motivo" value="DJ + acompanhante" maxlength="60">
      <label>E-mails (um por linha). Cada pessoa precisa ter conta no site com esse e-mail.</label>
      <textarea name="emails" rows="4" placeholder="dj@email.com&#10;acompanhante@email.com"></textarea>
      <label>Ingressos para cada e-mail</label><select name="qtd"><option>1</option><option>2</option><option>3</option><option>4</option></select>
      <p class="peq">DJ + acompanhante: coloque os dois e-mails com 1 ingresso cada, ou só o do DJ com 2 (ele repassa o segundo por link, na tela "Meus ingressos").</p>
      <button class="bt bloco">Emitir cortesias</button></form>
    <div id="erro-cort"></div>
    <h2>Emitidas (${lista.cortesias.length})</h2>
    ${lista.cortesias.length ? `<div class="rolar"><table><tr><th>Ingresso</th><th>Titular</th><th>Motivo</th><th></th></tr>${lista.cortesias
      .map((x) => `<tr><td>#${x.id}<br>${tag(x.status)}</td><td>${esc(x.dono)}<br><span class="peq">${esc(x.email)}</span></td><td>${esc(x.motivo)}</td><td>${x.status === 'valido' ? `<button class="bt perigo peq" data-canc="${x.id}">Cancelar</button>` : ''}</td></tr>`)
      .join('')}</table></div>` : '<p class="mudo">Nenhuma cortesia emitida.</p>'}`,
  );
  const f = document.getElementById('f');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    comEspera(f.querySelector('button'), async () => {
      const emails = f.emails.value.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
      if (!emails.length) throw new Error('Informe ao menos um e-mail.');
      document.getElementById('erro-cort').innerHTML = '';
      try {
        await api('POST', '/admin/cortesias', { motivo: f.motivo.value, itens: emails.map((email) => ({ email, quantidade: Number(f.qtd.value) })) });
      } catch (err) {
        const d = err.dados;
        if (d?.ausentes?.length || d?.ambiguos?.length) {
          document.getElementById('erro-cort').innerHTML = `<div class="card" style="border-color:var(--erro)"><b>Nada foi emitido.</b>${d.ausentes?.length ? `<p>Estes e-mails não têm conta: ${d.ausentes.map(esc).join(', ')}. Peça para criarem a conta no site e tente de novo.</p>` : ''}${d.ambiguos?.length ? `<p>E-mails repetidos em mais de uma conta: ${d.ambiguos.map(esc).join(', ')}.</p>` : ''}</div>`;
          return;
        }
        throw err;
      }
      aviso('Cortesias emitidas.');
      navegar();
    });
  });
  app.querySelectorAll('[data-canc]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm('Cancelar esta cortesia?')) return;
      comEspera(b, async () => {
        await api('POST', `/admin/cortesias/${b.dataset.canc}/cancelar`, {});
        navegar();
      });
    }),
  );
});

// ---------- início ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
window.addEventListener('hashchange', navegar);
(async () => {
  await carregarEu();
  navegar();
})();
