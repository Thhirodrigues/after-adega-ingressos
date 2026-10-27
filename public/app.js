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
const ROTULO = { aguardando_pagamento: 'Aguardando pagamento', pago: 'Pago', expirado: 'Expirado', cancelado: 'Cancelado', valido: 'Válido', usado: 'Usado', pendente: 'Aguardando cadastro', resgatado: 'Resgatado' };
const tag = (s) => `<span class="tag ${esc(s)}">${esc(ROTULO[s] || s)}</span>`;

function centavos(txt) {
  const n = Number(String(txt).replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
const nomeForma = (f) => ({ dinheiro: 'Dinheiro', cartao: 'Cartão', mercadopago: 'Mercado Pago', cupom: 'Cupom' }[f] || 'Pix');
const reais = (c) => (c / 100).toFixed(2).replace('.', ',');
// Seletor de quantidade com botões − e +. O valor fica num <input type="hidden"> (mesmo
// nome/atributos de antes), então o resto do código lê .value e escuta "change".
const stepperHtml = (attrs, max, valor = 1) =>
  `<div class="qtd" data-max="${max}"><button type="button" class="qb" data-d="-1" aria-label="Diminuir quantidade">−</button><output aria-live="polite">${valor}</output><button type="button" class="qb" data-d="1" aria-label="Aumentar quantidade">+</button><input type="hidden" ${attrs} value="${valor}"></div>`;
function ligarSteppers(raiz) {
  raiz.querySelectorAll('.qtd').forEach((el) => {
    const inp = el.querySelector('input');
    const out = el.querySelector('output');
    const [menos, mais] = el.querySelectorAll('.qb');
    const max = () => Number(el.dataset.max) || 1;
    const pinta = () => { out.textContent = inp.value; menos.disabled = Number(inp.value) <= 1; mais.disabled = Number(inp.value) >= max(); };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('.qb');
      if (!b || b.disabled) return;
      inp.value = String(Math.min(max(), Math.max(1, Number(inp.value) + Number(b.dataset.d))));
      pinta();
      inp.dispatchEvent(new Event('change'));
    });
    el.setValor = (n) => { inp.value = String(Math.min(max(), Math.max(1, Number(n) || 1))); pinta(); };
    pinta();
  });
}

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
    if (estado.eu.convites_resgatados) {
      aviso(`Você recebeu ${estado.eu.convites_resgatados > 1 ? 'cortesias' : 'uma cortesia'}! Veja em “Meus ingressos”.`);
      estado.eu.convites_resgatados = 0;
    }
  } catch {
    estado.eu = null;
  }
  desenharNav();
  atualizarBadgeAvisos();
  verificarPush();
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
    h += '<a href="#/meus">Meus ingressos</a><a href="#/conta">Conta</a><span class="sair-sino"><button id="sair">Sair</button>' + (eu.papel === 'admin' ? htmlSino() : '') + '</span>';
  }
  nav.innerHTML = h;
  ligarSino();
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
          ${stepperHtml(`data-qtd="${l.id}"`, max)}</div>
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
    ${ev.descricao ? `<p class="mudo descricao">${esc(ev.descricao)}</p>` : ''}
    <h2>Ingressos</h2>${lotesHtml}
    <p class="peq">O comprador é responsável pelos ingressos do seu pedido.</p>
    <p class="peq"><a href="#/regras">Termos e regras</a> · <a href="#/privacidade">Privacidade</a></p>`;
  ligarSteppers(app);
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
      ${stepperHtml('name="quantidade"', max)}
      ${d.pagamento_automatico
        ? `<input type="hidden" name="nome_pagador" value="${esc(`${estado.eu.nome} ${estado.eu.sobrenome}`)}">`
        : `<label>Nome de quem vai fazer o Pix (para conferirmos o pagamento)</label>
      <input name="nome_pagador" required minlength="3" maxlength="80" value="${esc(`${estado.eu.nome} ${estado.eu.sobrenome}`)}">`}
      <div class="card" style="background:var(--campo);margin-top:1rem">
        <div class="linha"><span>Ingressos</span><b id="t_sub"></b></div>
        <div class="linha"><span>Taxa de serviço</span><b id="t_taxa"></b></div>
        <div class="linha"><span><b>Total</b></span><b class="preco" id="t_tot"></b></div>
      </div>
      <label class="check"><input type="checkbox" name="temcupom"> <span>Tenho um cupom</span></label>
      <div id="boxcupom" hidden><label>Cupom</label>
      <input name="cupom" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="30"></div>
      <label class="check"><input type="checkbox" name="aceito" required> <span>Li e aceito as <a href="#/regras" target="_blank" rel="noopener">regras de compra</a>. Sei que ingresso é pessoal e de uso único e que <b>qualquer envio de print ou foto do QR Code é de minha inteira responsabilidade</b>, podendo resultar em entrada negada.</span></label>
      <p class="peq">${d.pagamento_automatico ? 'Na próxima tela você escolhe cartão ou Pix.' : 'Ao gerar o Pix,'} Seguramos seus ingressos por ${d.reserva_minutos || 20} minutos para você pagar.</p>
      <button class="bt bloco" id="btpagar" disabled>${d.pagamento_automatico ? 'Ir para o pagamento' : 'Gerar Pix'}</button>
    </form>`;
  const f = document.getElementById('f');
  ligarSteppers(f);
  const btPagar = document.getElementById('btpagar');
  const travarPagar = () => (btPagar.disabled = !f.aceito.checked);
  f.aceito.addEventListener('change', travarPagar);
  travarPagar();
  f.temcupom.addEventListener('change', () => {
    document.getElementById('boxcupom').hidden = !f.temcupom.checked;
    if (f.temcupom.checked) f.cupom.focus();
    else f.cupom.value = '';
  });
  try {
    const g = JSON.parse(sessionStorage.getItem('qtd') || 'null');
    if (g && String(g.lote) === id && Number(g.q) >= 1 && Number(g.q) <= max) f.querySelector('.qtd').setValor(Number(g.q));
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
    comEspera(btPagar, async () => {
      try {
        const r = await api('POST', '/pedidos', { lote_id: l.id, quantidade: Number(f.quantidade.value), nome_pagador: f.nome_pagador.value, cupom: f.temcupom.checked ? f.cupom.value.trim() : '', aceito_termos: f.aceito.checked === true });
        location.hash = `#/pedido/${r.codigo}`;
      } catch (e) {
        if (e.status === 409 && e.dados?.pedido_aberto) {
          aviso('Você já tem um pedido aguardando pagamento. Pague ou cancele esse pedido antes de fazer outro.', 'erro');
          location.hash = `#/pedido/${e.dados.pedido_aberto}`;
          return;
        }
        throw e;
      }
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
      const manual = `
        <p class="peq">Reserva válida por <b${p.mp_disponivel ? '' : ' id="cont"'}>${Math.floor(falta / 60)} min</b>. Pague pelo app do seu banco usando "Pix copia e cola". A organização confere o recebimento e libera seus ingressos, o que pode levar alguns minutos.</p>
        <div class="pix" id="pixcode">${esc(p.pix.copia_e_cola)}</div>
        <button class="bt bloco" id="copiar">Copiar código Pix</button>
        <p class="peq" style="margin-top:.75rem">Favorecido: ${esc(p.pix.favorecido)}<br>Chave: ${esc(p.pix.chave)}<br>Referência: <b>${esc(p.codigo)}</b></p>`;
      corpo = p.mp_disponivel
        ? `<div class="card atual">
        <b>Como você quer pagar ${brl(p.total_centavos)}?</b>
        <p class="peq">Reserva válida por <b id="cont">${Math.floor(falta / 60)} min</b>. A confirmação é automática: assim que o pagamento for aprovado, seus ingressos aparecem aqui.</p>
        <button class="bt bloco" id="pagarcartao">Cartão de crédito (à vista)</button>
        <button class="bt sec bloco" id="pagarpix" style="margin-top:.6rem">Pix</button>
        <p class="peq" style="margin-top:.6rem">Pagamento seguro pelo Mercado Pago.</p>
      </div>
      <details class="card"><summary>Prefiro pagar direto na chave Pix (confirmação manual)</summary>${manual}</details>
      <div class="acoes"><button class="bt perigo peq" id="cancelar">Cancelar pedido</button></div>`
        : `<div class="card atual"><b>Pague ${brl(p.pix.valor_centavos)} via Pix</b>${manual}</div>
      <p class="peq">Esta tela atualiza sozinha depois que o pagamento for confirmado.</p>
      <div class="acoes"><button class="bt perigo peq" id="cancelar">Cancelar pedido</button></div>`;
    } else if (p.status === 'pago') {
      corpo = `<div class="card atual"><b>Pagamento confirmado!</b><p class="mudo">Seus ingressos estão em "Meus ingressos".</p><a class="bt" href="#/meus">Ver meus ingressos</a></div>
      <div class="card obrigado"><b>Ingresso garantido, te vejo dia 23 🫶🏼</b>
        <p class="mudo">Se quiser dar uma força, posta o flyer nos seus stories. Ajuda a festa a encher.</p>
        <img src="/api/flyer" alt="Flyer da festa">
        <div class="acoes2"><button class="bt bloco" id="stories">Postar nos stories</button>
        <a class="bt sec bloco" href="/api/flyer" download="flyer-festa.jpg" id="baixarflyer">Baixar imagem</a></div></div>`;
    } else if (p.status === 'expirado') {
      corpo = `<div class="card"><b>Reserva expirada.</b><p class="mudo">Se você já pagou, fale com a organização informando o código ${esc(p.codigo)}. Caso contrário, faça um novo pedido.</p><a class="bt sec" href="#/">Voltar</a></div>`;
    } else {
      corpo = `<div class="card"><b>Pedido cancelado.</b><p class="mudo">Se houve pagamento, a organização fará a devolução por Pix.</p><a class="bt sec" href="#/">Voltar</a></div>`;
    }
    app.innerHTML = `
      <h1>Pedido ${esc(p.codigo)}</h1> ${tag(p.status)}
      <div class="card">
        <div class="linha"><span>${p.quantidade}× ${esc(p.lote)}</span><b>${brl(p.subtotal_centavos)}</b></div>
        ${p.cupom ? `<div class="linha"><span>Cupom ${esc(p.cupom)}</span><b>${p.desconto_centavos ? `− ${brl(p.desconto_centavos)}` : 'sem taxa'}</b></div>` : ''}
        <div class="linha"><span>Taxa de serviço</span><b>${brl(p.taxa_centavos)}</b></div>
        <div class="linha"><span><b>Total</b></span><b>${brl(p.total_centavos)}</b></div>
        <div class="peq">${esc(p.evento)} · ${dataBR(p.data_evento)}</div>
      </div>${corpo}`;
    for (const [id, metodo] of [['pagarcartao', 'cartao'], ['pagarpix', 'pix']]) {
      document.getElementById(id)?.addEventListener('click', (e) =>
        comEspera(e.target, async () => {
          const r = await api('POST', `/pedidos/${p.codigo}/pagar-mp`, { metodo });
          location.href = r.url;
        }),
      );
    }
    // Copiar o código (botão ou seleção manual do texto) conta como escolher o Pix na chave.
    const avisarChave = () => api('POST', `/pedidos/${p.codigo}/escolheu-pagamento`, {}).catch(() => {});
    document.getElementById('pixcode')?.addEventListener('copy', avisarChave);
    document.getElementById('copiar')?.addEventListener('click', async () => {
      avisarChave();
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
    document.getElementById('stories')?.addEventListener('click', async (e) => {
      const bt = e.currentTarget;
      try {
        const blob = await (await fetch('/api/flyer')).blob();
        const arq = new File([blob], 'flyer-festa.jpg', { type: blob.type || 'image/jpeg' });
        if (navigator.canShare && navigator.canShare({ files: [arq] })) {
          await navigator.share({ files: [arq] });
          return;
        }
        aviso('Seu navegador não abre o compartilhamento direto. Baixe a imagem e poste nos stories.', 'erro');
        document.getElementById('baixarflyer')?.click();
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        aviso('Não deu pra abrir o compartilhamento. Use "Baixar imagem".', 'erro');
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
    }, p.mp_disponivel ? 5000 : 15000);
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
        alvo.innerHTML = `<div class="card" style="background:var(--campo)">
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
      <label class="check"><input type="checkbox" name="aceito" required> <span>Li e aceito os <a href="#/regras" target="_blank" rel="noopener">termos de uso e regras de compra</a> e a <a href="#/privacidade" target="_blank" rel="noopener">política de privacidade</a>.</span></label>
      <button class="bt bloco">Criar conta</button>
    </form>
    <p>Já tem conta? <a href="#/entrar">Entrar</a></p>`;
  const f = document.getElementById('f');
  mascaraCpf(f.cpf);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    comEspera(f.querySelector('button'), async () => {
      const d = await dadosCadastro(f);
      await api('POST', '/auth/cadastro', { ...d, aceito_termos: f.aceito.checked === true });
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
    <details class="item"><summary><b>Resposta secreta</b><span class="peq">${estado.eu.tem_resposta ? 'definida' : '<b style="color:var(--erro)">não definida</b>'}</span></summary>
    <form class="card" id="f">
      <p class="peq" style="margin-top:0">${estado.eu.tem_resposta ? 'Para trocar, digite a nova resposta e a senha atual.' : '<b>Você ainda não definiu uma resposta secreta</b> — sem ela, só a organização consegue refazer sua senha.'}</p>
      <label>Senha atual</label><input name="atual" type="password" required autocomplete="current-password">
      ${campoResposta(estado.eu.tem_resposta ? 'Resposta secreta (toque para trocar)' : 'Nova resposta secreta (1 palavra, 4 a 8 letras)')}
      <button class="bt peq" style="margin-top:.75rem">Salvar resposta</button>
    </form></details>
    <p><a href="#/trocar-senha">Trocar senha</a> · <a href="#/regras">Regras de compra</a></p>`;
  const f = document.getElementById('f');
  if (estado.eu.tem_resposta) {
    const r = f.resposta;
    r.type = 'password';
    r.value = r.defaultValue = '••••••••';
    r.dataset.mascara = '1';
    r.addEventListener('focus', () => { if (r.dataset.mascara) { r.value = ''; delete r.dataset.mascara; } });
    r.addEventListener('blur', () => { if (!r.value) { r.value = r.defaultValue; r.dataset.mascara = '1'; } });
  }
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    if (f.resposta.dataset.mascara) return aviso('Digite a nova resposta secreta para trocar.', 'erro');
    comEspera(f.querySelector('button'), async () => {
      const cpfUso = estado.eu.cpf;
      await api('POST', '/auth/resposta', { senha_atual: await derivar(cpfUso, f.atual.value), resposta: await derivarResposta(cpfUso, f.resposta.value) });
      await carregarEu();
      aviso('Resposta secreta salva.');
      location.hash = '#/';
    });
  });
});

// Termos de uso, regras de compra e privacidade (rascunho: vale revisão jurídica antes de divulgar em larga escala).
const TERMOS_VERSAO = '2026-10-v3';
const contatoHtml = (c) => {
  const [txt, zap] = Array.isArray(c) ? c : [c, ''];
  const partes = [];
  if (txt) partes.push(`<b>${esc(txt)}</b>`);
  if (zap) partes.push(`<a href="https://wa.me/${esc(zap)}" target="_blank" rel="noopener"><b>WhatsApp ${esc(zap.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3'))}</b></a>`);
  return partes.length ? partes.join(' · ') : 'o contato informado pela organização na página do evento';
};
const TEXTO_REGRAS = (contato) => `
  <h2>1. Sua conta</h2>
  <p>Informe dados verdadeiros no cadastro. A senha e a resposta secreta são pessoais: não as compartilhe. Tudo o que for feito com a sua conta é de sua responsabilidade.</p>
  <h2>2. Seu ingresso é pessoal e de uso único</h2>
  <p>Cada ingresso tem um QR Code exclusivo, válido para uma única entrada. Depois que ele é lido na portaria, não vale mais — mesmo que outra pessoa apresente a mesma imagem.</p>
  <h2>3. Você é responsável pelo seu ingresso</h2>
  <p>Quem compra é o responsável pelo ingresso e pelo QR Code. <b>Se você compartilhar, publicar ou enviar print, foto ou arquivo do QR Code e outra pessoa usá-lo antes de você, a entrada será negada, sem direito a reembolso.</b> Qualquer vazamento do QR Code é de inteira responsabilidade de quem comprou.</p>
  <h2>4. Presenteando ou passando o ingresso</h2>
  <p>Para dar o ingresso a outra pessoa, use o botão <b>Transferir</b> em “Meus ingressos”. Isso gera um novo QR para quem recebe e invalida o seu. A transferência encerra 48 horas antes da festa.</p>
  <h2>5. Pagamento</h2>
  <p>A compra pelo aplicativo é por Pix, com a taxa de serviço informada na compra. Também pode haver venda presencial (dinheiro ou Pix na porta), sem taxa de serviço, diretamente com a equipe da organização. Ao gerar o Pix, o seu pedido fica reservado por 20 minutos; passado esse prazo sem pagamento, a reserva é cancelada. O ingresso só é liberado depois que a organização confirmar o pagamento. Compras em dinheiro são confirmadas na hora, por quem recebeu. Se você pagar depois do prazo, fale com a organização: confirmamos o pedido se ainda houver ingresso; caso contrário, devolvemos o valor.</p>
  <h2>6. Desistência, cancelamento e reembolso</h2>
  <p>Você pode desistir em até 7 dias após a compra, desde que faltem mais de 48 horas para a festa. Se a festa for cancelada pela organização, o reembolso é integral, incluindo a taxa de serviço. Todo reembolso é feito por Pix, manualmente, para quem pagou, <b>em até 2 dias úteis após a data da festa</b>.</p>
  <h2>7. Entrada</h2>
  <p>Leve um documento com foto. A organização pode negar a entrada de quem descumprir as regras do local ou a lei.</p>
  <h2>8. Dúvidas</h2>
  <p>Fale com a organização: ${contatoHtml(contato)}.</p>
  <p class="peq">Termos de uso e regras de compra · versão ${TERMOS_VERSAO}.</p>`;
const TEXTO_PRIVACIDADE = (contato) => `
  <h2>Quem somos</h2>
  <p>O Fast Pass vende e controla os ingressos das festas organizadas pelo Os Brothers Adega (“organização”), que decide como os seus dados são usados (controladora, nos termos da Lei Geral de Proteção de Dados – LGPD).</p>
  <h2>Quais dados coletamos</h2>
  <p>Nome, sobrenome, CPF, e-mail e celular; os dados dos seus pedidos e ingressos (inclusive o nome de quem fez o Pix e a hora da entrada na festa); e registros técnicos de acesso e de ações no sistema, para segurança. Sua senha e sua resposta secreta nunca são guardadas como você digitou: são transformadas no seu aparelho e guardadas em forma irreversível. Não coletamos dados de cartão neste momento.</p>
  <h2>Para que usamos</h2>
  <p>Identificar o comprador, emitir o ingresso, conferir o pagamento, controlar a entrada na festa, prevenir fraude e uso indevido, atender você e cumprir obrigações legais. A base legal é a execução do contrato de compra do ingresso, o cumprimento de obrigações legais e o legítimo interesse na segurança do evento.</p>
  <h2>Com quem compartilhamos</h2>
  <p>Não vendemos nem cedemos seus dados para publicidade. Usamos uma empresa de infraestrutura em nuvem (Cloudflare) para hospedar o sistema, cujos servidores podem estar fora do Brasil. A equipe da porta vê apenas o nome e o ingresso, não o seu CPF nem o seu contato. Se houver ordem de autoridade competente, poderemos informar os dados exigidos.</p>
  <h2>Por quanto tempo guardamos</h2>
  <p>Pelo tempo necessário para realizar o evento, tratar reembolsos e reclamações e cumprir prazos legais. Depois disso, os dados são excluídos ou anonimizados.</p>
  <h2>Seus direitos</h2>
  <p>Você pode pedir confirmação do tratamento, acesso, correção, anonimização ou exclusão dos dados, portabilidade e informação sobre compartilhamento, e retirar o consentimento quando ele for a base do tratamento (art. 18 da LGPD). Para isso, fale com a organização: ${contatoHtml(contato)}.</p>
  <h2>Cookies</h2>
  <p>Usamos apenas um cookie essencial, que mantém você conectado. Não usamos cookies de publicidade nem de rastreamento.</p>
  <h2>Segurança</h2>
  <p>Adotamos medidas técnicas para proteger os dados, mas nenhum sistema é totalmente seguro. Se houver incidente que possa causar risco a você, avisaremos como a lei determina.</p>
  <p class="peq">Política de privacidade · versão ${TERMOS_VERSAO}.</p>`;
async function paginaLegal(titulo, texto) {
  let contato = ['', ''];
  try { const r = await api('GET', '/contato'); contato = [r.contato || '', r.contato_whatsapp || '']; } catch {}
  app.innerHTML = `<h1>${titulo}</h1><div class="card regras">${texto(contato)}</div><a class="bt sec" href="javascript:history.back()">Voltar</a>`;
}
rota('/regras', () => paginaLegal('Termos de uso e regras de compra', TEXTO_REGRAS));
rota('/privacidade', () => paginaLegal('Política de privacidade', TEXTO_PRIVACIDADE));


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

// Baixa um CSV do admin (precisa do cookie de sessão, por isso não é um link simples).
async function baixarCsv(caminho, nome) {
  const r = await fetch('/api' + caminho, { credentials: 'same-origin' });
  if (!r.ok) {
    let msg = `Erro ${r.status}`;
    try { msg = (await r.json()).erro || msg; } catch {}
    throw new Error(msg);
  }
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const botoesCsv = `<div class="acoes" style="margin:.5rem 0"><button class="bt sec peq" data-csv="convidados">Baixar lista de convidados (CSV)</button><button class="bt sec peq" data-csv="vendas">Baixar vendas (CSV)</button></div>`;
function ligarCsv() {
  app.querySelectorAll('[data-csv]').forEach((b) =>
    b.addEventListener('click', () => comEspera(b, () => baixarCsv(`/admin/export/${b.dataset.csv}.csv`, `${b.dataset.csv}.csv`))),
  );
}

// ---------- admin ----------
const ABAS = [
  ['financeiro', 'Financeiro'],
  ['pedidos', 'Pedidos'],
  ['eventos', 'Eventos'],
  ['lotes', 'Lotes e cupons'],
  ['cortesias', 'Cortesias'],
  ['usuarios', 'Usuários'],
  ['avisos', 'Avisos'],
  ['config', 'Configurações'],
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
    ${botoesCsv}
    <h2>Pagamentos</h2>
    <div class="kpis">
      ${kpi('Recebido (pedidos confirmados)', brl(r.total_recebido_centavos), 'dest')}
      ${kpi('Por Pix', brl(r.recebido_pix_centavos))}
      ${kpi('Por cartão', brl(r.recebido_cartao_centavos))}
      ${kpi('Em dinheiro', brl(r.recebido_dinheiro_centavos))}
    </div>
    <p class="peq linha-taxas"><span>Total sem taxas: <b>${brl(r.total_recebido_centavos - r.taxa_servico_centavos)}</b></span><span>Taxas recebidas: <b>${brl(r.taxa_servico_centavos)}</b></span></p>
    <h2>Ingressos</h2>
    <div class="kpis">
      ${kpi('Vendidos (pagos)', r.ingressos_vendidos)}
      ${kpi('Aguardando pagamento', r.ingressos_aguardando)}
      <details class="kpi kpi-det"><summary><span class="peq">Cortesias ▾</span><b>${r.cortesias}</b></summary>
        <table>${[['Amigo / parceiro', 'amigo_parceiro'], ['Aniversariante', 'aniversariante'], ['DJ', 'dj'], ['Acompanhante de DJ', 'acompanhante_dj'], ['Cupom VIP', 'cupom'], ['Outras', 'outras']]
          .filter(([, k]) => k !== 'outras' || r.cortesias_tipos[k])
          .map(([n, k]) => `<tr><td>${n}</td><td class="num"><b>${r.cortesias_tipos[k]}</b></td></tr>`).join('')}</table>
        ${r.cortesias_aguardando ? `<p class="peq mudo" style="margin:.5rem 0 0">Mais ${r.cortesias_aguardando} aguardando cadastro (ainda sem ingresso).</p>` : ''}</details>
      ${kpi('Já entraram', r.entraram)}
    </div>
    <h2>Por forma de pagamento</h2>
    <div class="rolar"><table><tr><th>Canal</th><th>Forma</th><th class="num">Pedidos</th><th class="num">Ingressos</th><th class="num">Total</th></tr>
    ${(f.por_forma || []).map((x) => `<tr><td>${x.canal === 'porta' ? 'Porta' : 'Online'}</td><td>${nomeForma(x.forma)}</td><td class="num">${x.pedidos}</td><td class="num">${x.ingressos}</td><td class="num">${brl(x.total_centavos)}</td></tr>`).join('') || '<tr><td colspan="5" class="mudo">Sem vendas ainda.</td></tr>'}</table></div>
    ${(f.por_vendedor || []).length ? `<h2>Vendas na porta por vendedor</h2><p class="peq">Dinheiro que cada pessoa deve prestar contas.</p>
    <div class="rolar"><table><tr><th>Vendedor</th><th>Forma</th><th class="num">Ingressos</th><th class="num">Total</th></tr>${f.por_vendedor.map((x) => `<tr><td>${esc(x.vendedor)}</td><td>${nomeForma(x.forma)}</td><td class="num">${x.ingressos}</td><td class="num">${brl(x.total_centavos)}</td></tr>`).join('')}</table></div>` : ''}
    <h2>Por lote</h2>
    <div class="rolar"><table><tr><th>Lote</th><th class="num">Preço</th><th class="num">Vendidos</th><th class="num">Reservados</th><th class="num">Restam</th><th class="num">Receita</th></tr>
    ${f.lotes
      .map(
        (l) => `<tr><td>${esc(l.nome)}${l.ativo ? '' : ' <span class="peq">(inativo)</span>'}</td><td class="num">${brl(l.valor_centavos)}</td><td class="num">${l.vendidos}</td><td class="num">${l.reservados}</td><td class="num"><b>${Math.max(0, l.quantidade - l.vendidos - l.reservados)}</b> <span class="peq">de ${l.quantidade}</span></td><td class="num">${brl(l.receita_ingressos_centavos + l.taxa_servico_centavos)}</td></tr>`,
      )
      .join('')}</table></div>`,
  );
  ligarCsv();
});

rota('/admin/pedidos', async () => {
  if (!exigirAdmin()) return;
  const filtro = sessionStorage.getItem('fped') || 'todos';
  const d = await api('GET', `/admin/pedidos${filtro === 'todos' ? '' : `?status=${filtro}`}`);
  const linhas = d.pedidos
    .map((p) => {
      const st = p.vencido ? 'expirado' : p.status;
      const confirmavel = p.status === 'aguardando_pagamento' || p.status === 'expirado';
      return `<tr>
        <td><b>${esc(p.codigo)}</b><br>${tag(st)}</td>
        <td>${esc(p.comprador)}<br><span class="peq">${esc(p.telefone)} · CPF ${esc(fmtCpf(p.cpf))}</span></td>
        <td>${p.quantidade}× ${esc(p.lote)}<br><span class="peq">${p.canal === 'porta' ? 'Venda na porta' : 'Pagador'}: ${esc(p.nome_pagador)}${p.status === 'pago' ? ` · ${nomeForma(p.forma_pagamento).toLowerCase()}` : ''}${p.cupom_codigo ? ` · cupom ${esc(p.cupom_codigo)}` : ''}</span></td>
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
    ${botoesCsv}
    <div class="rolar"><table><tr><th>Pedido</th><th>Comprador</th><th>Itens</th><th class="num">Total</th><th></th></tr>${linhas || '<tr><td colspan="5" class="mudo">Nenhum pedido.</td></tr>'}</table></div>`,
  );
  ligarCsv();
  document.getElementById('fil').addEventListener('change', (e) => {
    sessionStorage.setItem('fped', e.target.value);
    navegar();
  });
  document.getElementById('atualiza').addEventListener('click', navegar);
  app.querySelectorAll('[data-conf]').forEach((b) =>
    b.addEventListener('click', () => {
      const din = b.dataset.forma === 'dinheiro';
      if (!confirm(din ? 'Confirmar que você recebeu o valor deste pedido em dinheiro?' : 'Confirmar que o Pix deste pedido caiu na conta?')) return;
      comEspera(b, async () => {
        await api('POST', `/admin/pedidos/${b.dataset.conf}/confirmar`, din ? { forma: 'dinheiro' } : {});
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

// Padrão das telas de cadastro do admin: título com "+", o formulário abre ao tocar, e os itens ficam em lista (toque para editar).
function ligarMais() {
  app.querySelectorAll('[data-abre]').forEach((b) => b.addEventListener('click', () => {
    const f = document.getElementById(b.dataset.abre);
    f.hidden = !f.hidden;
    if (!f.hidden) { f.scrollIntoView({ block: 'center' }); f.querySelector('input,textarea')?.focus(); }
  }));
  app.querySelectorAll('[data-fecha]').forEach((b) => b.addEventListener('click', () => { document.getElementById(b.dataset.fecha).hidden = true; }));
}
async function irParaLista(seletor) {
  await navegar();
  document.querySelector(seletor)?.scrollIntoView({ block: 'start' });
}

rota('/admin/eventos', async () => {
  if (!exigirAdmin()) return;
  const ev = await api('GET', '/admin/eventos');
  const camposEvento = (e = {}) => `<label>Nome</label><input name="nome" value="${esc(e.nome || '')}" placeholder="Festa dos amigos" required>
      <div class="grade"><div><label>Data</label><input name="data_evento" type="date" value="${esc(e.data_evento || '')}" required></div>
      <div><label>Horário de início</label><input name="hora_inicio" type="time" value="${esc(e.hora_inicio || '22:00')}" required></div></div>
      <label>Local</label><input name="local" value="${esc(e.local || '')}">
      <label>Descrição (line-up, avisos…)</label><textarea name="descricao" rows="8">${esc(e.descricao || '')}</textarea>
      <p class="peq">A descrição aparece na página de venda exatamente como você digitar, com as mesmas quebras de linha.</p>`;
  const ordenados = [...ev.eventos].sort((x, y) => Number(y.ativo) - Number(x.ativo));
  const itens = ordenados
    .map(
      (e) => `<details class="item"><summary><b>${esc(e.nome)}</b><span class="peq">${e.ativo ? '<span class="tag valido">À venda</span> ' : ''}${dataBR(e.data_evento)} · ${esc(e.hora_inicio || '22:00')}${e.local ? ` · ${esc(e.local)}` : ''}</span></summary>
      <form class="card" data-evento="${e.id}">${camposEvento(e)}
      <div class="linha"><button class="bt peq">Salvar evento</button>${e.ativo ? '' : `<button type="button" class="bt sec peq" data-ativar="${e.id}">Tornar ativo</button>`}</div></form></details>`,
    )
    .join('');
  layoutAdmin(
    'eventos',
    `<p class="peq">Só <b>um evento fica ativo</b> por vez: é o que aparece para venda e o que a portaria usa. Troque o ativo só depois que a portaria da festa anterior encerrar. Os ingressos de festas anteriores continuam salvos.</p>
    <h2 id="lista-eventos" class="h-mais">Eventos <button type="button" class="mais" data-abre="fnovo" aria-label="Novo evento" title="Novo evento">+</button></h2>${itens || '<p class="mudo">Nenhum evento ainda.</p>'}
    <form class="card" id="fnovo" hidden><b>Novo evento</b>${camposEvento()}
      <label><input type="checkbox" name="ativo" style="width:auto"> Já deixar este evento ativo (à venda agora)</label>
      <p class="peq">Depois de criar, vá em <b>Lotes</b> para cadastrar valor e quantidade (com o evento ativo).</p>
      <div class="linha"><button class="bt peq">Criar evento</button><button type="button" class="bt sec peq" data-fecha="fnovo">Cancelar</button></div></form>`,
  );
  ligarMais();
  app.querySelectorAll('form[data-evento]').forEach((f) =>
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      comEspera(f.querySelector('button'), async () => {
        await api('PUT', `/admin/eventos/${f.dataset.evento}`, { nome: f.nome.value, data_evento: f.data_evento.value, hora_inicio: f.hora_inicio.value, local: f.local.value, descricao: f.descricao.value });
        estado.evento = null;
        aviso('Evento salvo.');
        await irParaLista('#lista-eventos');
      });
    }),
  );
  app.querySelectorAll('[data-ativar]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm('Tornar este o evento ativo? A venda e a portaria passam a usar ele.')) return;
      comEspera(b, async () => {
        await api('PUT', `/admin/eventos/${b.dataset.ativar}`, { ativo: true });
        estado.evento = null;
        aviso('Evento ativado.');
        await irParaLista('#lista-eventos');
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
      await irParaLista('#lista-eventos');
    });
  });
});

rota('/admin/lotes', async () => {
  if (!exigirAdmin()) return;
  const ev = await api('GET', '/admin/eventos');
  const evAtivo = ev.eventos.find((e) => e.ativo) || ev.eventos[0];
  const lo = await api('GET', `/admin/lotes${evAtivo ? `?evento_id=${evAtivo.id}` : ''}`);
  const cu = evAtivo ? await api('GET', `/admin/cupons?evento_id=${evAtivo.id}`) : { cupons: [] };
  const camposCupom = (c = {}) => `<div class="grade">
        <div><label>Palavra-chave</label><input name="codigo" value="${esc(c.codigo || '')}" maxlength="30" autocomplete="off" autocapitalize="characters" required></div>
        <div><label>Benefício</label><select name="tipo">
          <option value="sem_taxa" ${c.tipo === 'sem_taxa' ? 'selected' : ''}>Sem taxa de serviço</option>
          <option value="percentual" ${c.tipo === 'percentual' ? 'selected' : ''}>Desconto (%) no valor dos ingressos</option>
          <option value="vip" ${c.tipo === 'vip' ? 'selected' : ''}>VIP (não paga o ingresso)</option></select></div>
        <div class="pct"><label>Desconto (%)</label><input name="percentual" inputmode="numeric" value="${c.percentual || 10}"></div>
        <div><label>Limite de ingressos (vazio = sem limite)</label><input name="limite" inputmode="numeric" value="${c.limite ?? ''}"></div>
      </div>`;
  const cuponsCards = cu.cupons
    .map(
      (c) => `<details class="item"><summary><b>${esc(c.codigo)}</b><span class="peq">${({ sem_taxa: 'sem taxa', percentual: `${c.percentual}% off`, vip: 'VIP' })[c.tipo] || c.tipo} · usados ${c.usados}${c.limite != null ? ` de ${c.limite}` : ''} · ${c.ativo ? 'ativo' : 'inativo'}</span></summary>
      <form class="card" data-cupom="${c.id}">
      ${camposCupom(c)}
      <label><input type="checkbox" name="ativo" ${c.ativo ? 'checked' : ''} style="width:auto"> Cupom ativo</label>
      <button class="bt peq" style="margin-top:.75rem">Salvar cupom</button></form></details>`,
    )
    .join('');
  const cards = lo.lotes
    .map(
      (l) => `<details class="item"><summary><b>${esc(l.nome)}</b><span class="peq">${brl(l.valor_centavos)} · restam ${Math.max(0, l.quantidade - l.vendidos - l.reservados)} de ${l.quantidade} · ${l.ativo ? 'ativo' : 'inativo'}</span></summary>
      <form class="card" data-lote="${l.id}">
      <div class="grade">
        <div><label>Nome</label><input name="nome" value="${esc(l.nome)}" required></div>
        <div><label>Valor do ingresso (R$)</label><input name="valor" inputmode="decimal" value="${reais(l.valor_centavos)}" required></div>
        <div><label>Quantidade total</label><input name="quantidade" inputmode="numeric" value="${l.quantidade}" required></div>
        <div><label>Ordem de venda (1 = primeiro)</label><input name="ordem" inputmode="numeric" value="${l.ordem}"></div>
        <div><label>Quem pode comprar</label><select name="canal"><option value="todos" ${l.canal === 'todos' ? 'selected' : ''}>Online e na porta</option><option value="online" ${l.canal === 'online' ? 'selected' : ''}>Só online</option><option value="porta" ${l.canal === 'porta' ? 'selected' : ''}>Só na porta</option></select></div>
      </div>
      <label><input type="checkbox" name="ativo" ${l.ativo ? 'checked' : ''} style="width:auto"> Lote ativo (venda online; lote “Só na porta” aparece na portaria mesmo desmarcado)</label>
      <button class="bt peq" style="margin-top:.75rem">Salvar lote</button></form></details>`,
    )
    .join('');
  layoutAdmin(
    'lotes',
`${evAtivo ? `<p class="peq">Evento à venda: <b>${esc(evAtivo.nome)}</b> · ${dataBR(evAtivo.data_evento)}. Para editar nome, data, local ou descrição, use a aba <a href="#/admin/eventos">Eventos</a>.</p>` : ''}
    <h2 id="lista-lotes" class="h-mais">Lotes <button type="button" class="mais" data-abre="fnovo" aria-label="Novo lote" title="Novo lote">+</button></h2>${cards || '<p class="mudo">Nenhum lote ainda.</p>'}
    <form class="card" id="fnovo" hidden>
      <b>Novo lote</b>
      <div class="grade">
        <div><label>Nome</label><input name="nome" placeholder="1º lote" required></div>
        <div><label>Valor do ingresso (R$)</label><input name="valor" inputmode="decimal" placeholder="35,00" required></div>
        <div><label>Quantidade</label><input name="quantidade" inputmode="numeric" required></div>
        <div><label>Ordem de venda (1 = primeiro)</label><input name="ordem" inputmode="numeric" value="${lo.lotes.length + 1}"></div>
        <div><label>Quem pode comprar</label><select name="canal"><option value="todos">Online e na porta</option><option value="online">Só online</option><option value="porta">Só na porta</option></select></div>
      </div>
      <p class="peq">Ordem de venda: o lote de menor número é vendido primeiro; quando esgota, o site destaca o próximo automaticamente. A taxa de serviço (%) é aplicada por cima do valor e aparece para o comprador.</p>
      <div class="linha"><button class="bt peq">Criar lote</button><button type="button" class="bt sec peq" data-fecha="fnovo">Cancelar</button></div></form>
    <h2 id="lista-cupons" class="h-mais">Cupons <button type="button" class="mais" data-abre="fcupnovo" aria-label="Novo cupom" title="Novo cupom">+</button></h2>
    <p class="peq">O comprador digita a palavra-chave no campo "Cupom" antes de efetuar a compra. Alterações valem só para pedidos novos. VIP gera os ingressos na hora, como cortesia: use o limite para não liberar mais do que quer.</p>
    ${cuponsCards || '<p class="mudo">Nenhum cupom ainda.</p>'}
    <form class="card" id="fcupnovo" hidden><b>Novo cupom</b>${camposCupom()}<div class="linha"><button class="bt peq">Criar cupom</button><button type="button" class="bt sec peq" data-fecha="fcupnovo">Cancelar</button></div></form>`,
  );
  app.querySelectorAll('[data-abre]').forEach((b) => b.addEventListener('click', () => {
    const f = document.getElementById(b.dataset.abre);
    f.hidden = !f.hidden;
    if (!f.hidden) { f.scrollIntoView({ block: 'center' }); f.querySelector('input')?.focus(); }
  }));
  app.querySelectorAll('[data-fecha]').forEach((b) => b.addEventListener('click', () => { document.getElementById(b.dataset.fecha).hidden = true; }));
  // Depois de salvar, recarrega e leva a tela até a lista (não volta pro topo).
  const voltarPara = async (seletor) => {
    await navegar();
    const el = document.querySelector(seletor);
    if (el) el.scrollIntoView({ block: 'start' });
  };
  const lerCupom = (f) => ({
    codigo: f.codigo.value,
    tipo: f.tipo.value,
    percentual: f.tipo.value === 'percentual' ? Number(soDig(f.percentual.value)) : 0,
    limite: f.limite.value.trim() === '' ? null : Number(soDig(f.limite.value)),
  });
  app.querySelectorAll('form[data-cupom], #fcupnovo').forEach((f) => {
    const mostra = () => (f.querySelector('.pct').hidden = f.tipo.value !== 'percentual');
    f.tipo.addEventListener('change', mostra);
    mostra();
  });
  app.querySelectorAll('form[data-cupom]').forEach((f) =>
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      comEspera(f.querySelector('button'), async () => {
        await api('PUT', `/admin/cupons/${f.dataset.cupom}`, { ...lerCupom(f), ativo: f.ativo.checked });
        aviso('Cupom salvo.');
        await voltarPara('#lista-cupons');
      });
    }),
  );
  document.getElementById('fcupnovo').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    comEspera(f.querySelector('button'), async () => {
      await api('POST', '/admin/cupons', { ...lerCupom(f), evento_id: evAtivo.id, ativo: true });
      aviso('Cupom criado.');
      await voltarPara('#lista-cupons');
    });
  });
  const lerLote = (f) => {
    const valor = centavos(f.valor.value);
    const quantidade = Number(soDig(f.quantidade.value));
    if (!Number.isFinite(valor) || valor < 0) throw new Error('Valor inválido.');
    if (f.quantidade.value.trim() === '' || !Number.isInteger(quantidade)) throw new Error('Quantidade inválida.');
    return { nome: f.nome.value.trim(), valor_centavos: valor, quantidade, ordem: Number(soDig(f.ordem.value) || 0), canal: f.canal.value };
  };
  app.querySelectorAll('form[data-lote]').forEach((f) =>
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      comEspera(f.querySelector('button'), async () => {
        await api('PUT', `/admin/lotes/${f.dataset.lote}`, { ...lerLote(f), ativo: f.ativo.checked });
        aviso('Lote salvo.');
        await voltarPara('#lista-lotes');
      });
    }),
  );
  document.getElementById('fnovo').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    comEspera(f.querySelector('button'), async () => {
      await api('POST', '/admin/lotes', { ...lerLote(f), evento_id: evAtivo.id, ativo: true });
      aviso('Lote criado.');
      await voltarPara('#lista-lotes');
    });
  });
});

rota('/admin/config', async () => {
  if (!exigirAdmin()) return;
  const [c, sitPush] = await Promise.all([api('GET', '/admin/config'), verificarPush(true)]);
  const TXT_PUSH = { ok: 'ativadas neste aparelho', desativado: 'desativadas', bloqueado: 'bloqueadas pelo navegador', instalar: 'instale o app no iPhone', sem_suporte: 'sem suporte neste navegador' };
  const resumoPix = c.pix_chave ? `${esc(c.pix_nome || '')} · ${esc(c.pix_chave)}` : '<b style="color:var(--erro)">não configurada</b>';
  layoutAdmin(
    'config',
    `<h2 id="secoes-config">Configurações</h2>
    <details class="item" id="det-push"><summary><b>Notificações</b><span class="peq">${esc(TXT_PUSH[sitPush] || 'verificando…')}</span></summary>
      <div class="card"><p class="peq" style="margin-top:0">Avisos de compra, pedido em pagamento e erros de confirmação na portaria chegam como notificação neste aparelho. O sino no menu faz o mesmo.</p>
        <div class="acoes">
          <button type="button" class="bt peq" id="push-ativar">${sitPush === 'ok' ? 'Reativar neste aparelho' : 'Ativar notificações'}</button>
          <button type="button" class="bt sec peq" id="push-teste"${sitPush === 'ok' ? '' : ' disabled'}>Enviar teste</button>
          <button type="button" class="bt perigo peq" id="push-desligar"${sitPush === 'ok' ? '' : ' disabled'}>Desativar neste aparelho</button>
        </div></div></details>
    <details class="item"><summary><b>Flyer da tela de agradecimento</b><span class="peq">${c.flyer_personalizado ? 'enviado por você' : 'padrão'}</span></summary>
      <div class="card"><p class="peq" style="margin-top:0">Aparece depois do pagamento, com o botão de postar nos stories. Use imagem vertical (9:16 funciona melhor). A troca vale na hora.</p>
        <img id="flyer-prev" src="/api/flyer?v=${Date.now()}" alt="Flyer atual" style="width:100%;max-width:12rem;border-radius:10px;display:block;margin:.5rem 0">
        <input type="file" id="flyer-arq" accept="image/*" hidden>
        <div class="acoes">
          <button type="button" class="bt peq" id="flyer-trocar">Escolher nova imagem</button>
          ${c.flyer_personalizado ? '<button type="button" class="bt sec peq" id="flyer-padrao">Voltar ao padrão</button>' : ''}
        </div></div></details>
    <details class="item"><summary><b>Senha de desbloqueio da recepção</b><span class="peq">${c.pin_definido ? 'definida' : '<b style="color:var(--erro)">não definida</b>'}</span></summary>
      <form class="card" id="fpin">
        <p class="peq" style="margin-top:0">${c.pin_definido ? 'Já definida.' : '<b>Ainda não definida</b> — sem ela a recepcionista não consegue desfazer entradas.'} Ela precisa digitá-la para desfazer uma entrada; você recebe um aviso a cada uso.</p>
        <label>${c.pin_definido ? 'Senha (toque para trocar)' : 'Nova senha (4 a 12 caracteres)'}</label><input name="pin" type="password" required minlength="4" maxlength="12" autocomplete="new-password"${c.pin_definido ? ' value="••••••••" data-mascara="1"' : ''}>
        <button class="bt peq" style="margin-top:.75rem">Salvar senha</button></form></details>
    <details class="item"><summary><b>Recebimento por Pix</b><span class="peq">${resumoPix}</span></summary>
      <form class="card" data-sec="pix">
        <label>Tipo da chave Pix</label>
        <select name="pix_tipo">
          <option value="celular">Celular</option><option value="email">E-mail</option>
          <option value="cpf">CPF</option><option value="cnpj">CNPJ</option><option value="aleatoria">Chave aleatória</option>
        </select>
        <label>Chave Pix</label><input name="pix_chave" value="${esc(c.pix_chave)}" autocomplete="off" autocapitalize="off">
        <p class="peq" id="dica-pix"></p>
        <div class="grade"><div><label>Nome do favorecido (como no banco)</label><input name="pix_nome" value="${esc(c.pix_nome)}" maxlength="25"></div>
        <div><label>Cidade</label><input name="pix_cidade" value="${esc(c.pix_cidade)}" maxlength="15" placeholder="SAO PAULO"></div></div>
        <button class="bt peq" style="margin-top:.75rem">Salvar Pix</button></form></details>
    <details class="item"><summary><b>Regras de venda</b><span class="peq">taxa ${esc(c.taxa_percentual)}% · reserva ${esc(c.reserva_minutos)} min · máx. ${esc(c.max_ingressos_por_pedido)} por pedido</span></summary>
      <form class="card" data-sec="regras">
        <div class="grade"><div><label>Taxa de serviço (%)</label><input name="taxa_percentual" inputmode="numeric" value="${esc(c.taxa_percentual)}"></div>
        <div><label>Prazo da reserva (minutos)</label><input name="reserva_minutos" inputmode="numeric" value="${esc(c.reserva_minutos)}"></div>
        <div><label>Máximo de ingressos por pedido</label><input name="max_ingressos_por_pedido" inputmode="numeric" value="${esc(c.max_ingressos_por_pedido)}"></div>
        <div><label>Transferências encerram (horas antes da festa)</label><input name="transferencia_limite_horas" inputmode="numeric" value="${esc(c.transferencia_limite_horas ?? 48)}"></div></div>
        <p class="peq">Alterar a taxa vale só para pedidos novos; pedidos já feitos mantêm o valor combinado.</p>
        <button class="bt peq" style="margin-top:.5rem">Salvar regras</button></form></details>
    <details class="item"><summary><b>Contato da organização</b><span class="peq">${esc([c.contato, c.contato_whatsapp && '+' + c.contato_whatsapp].filter(Boolean).join(' · ') || 'não informado')}</span></summary>
      <form class="card" data-sec="contato">
        <label>Contato</label><input name="contato" value="${esc(c.contato || '')}" maxlength="200" placeholder="E-mail ou texto de contato">
        <label>Celular WhatsApp (opcional)</label><input name="contato_whatsapp" inputmode="tel" value="${esc((c.contato_whatsapp || '').replace(/^55/, ''))}" placeholder="11 99999-9999">
        <button class="bt peq" style="margin-top:.75rem">Salvar contato</button></form></details>`,
  );
  document.getElementById('push-ativar').addEventListener('click', (e) =>
    ativarPush(e.currentTarget).then(() => irParaLista('#secoes-config')).catch((er) => aviso(er.message, 'erro')));
  document.getElementById('push-teste').addEventListener('click', () => testarPush());
  document.getElementById('push-desligar').addEventListener('click', () => desativarPushManual().then(() => irParaLista('#secoes-config')));
  const campoPin = document.getElementById('fpin').pin;
  campoPin.addEventListener('focus', () => { if (campoPin.dataset.mascara) { campoPin.value = ''; delete campoPin.dataset.mascara; } });
  campoPin.addEventListener('blur', () => { if (!campoPin.value && campoPin.defaultValue) { campoPin.value = campoPin.defaultValue; campoPin.dataset.mascara = '1'; } });
  document.getElementById('fpin').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.pin.dataset.mascara) return aviso('Digite a nova senha para trocar.', 'erro');
    comEspera(f.querySelector('button'), async () => {
      await api('PUT', '/admin/pin', { pin: f.pin.value });
      aviso('Senha de desbloqueio salva.');
      await irParaLista('#secoes-config');
    });
  });
  const arq = document.getElementById('flyer-arq');
  document.getElementById('flyer-trocar').addEventListener('click', () => arq.click());
  arq.addEventListener('change', () =>
    comEspera(document.getElementById('flyer-trocar'), async () => {
      const f = arq.files[0];
      if (!f) return;
      const bmp = await createImageBitmap(f).catch(() => null);
      if (!bmp) throw new Error('Não consegui abrir essa imagem. Tente um JPG ou PNG.');
      const esc2 = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(bmp.width * esc2);
      cv.height = Math.round(bmp.height * esc2);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      let q = 0.9, url = cv.toDataURL('image/jpeg', q);
      while (url.length > 1_900_000 && q > 0.4) { q -= 0.1; url = cv.toDataURL('image/jpeg', q); }
      await api('PUT', '/admin/flyer', { imagem: url });
      aviso('Flyer atualizado.');
      await irParaLista('#secoes-config');
    }));
  document.getElementById('flyer-padrao')?.addEventListener('click', (e) =>
    comEspera(e.currentTarget, async () => {
      await api('DELETE', '/admin/flyer');
      aviso('Flyer padrão restaurado.');
      await irParaLista('#secoes-config');
    }));
  const fp = app.querySelector('form[data-sec=pix]');
  fp.pix_tipo.value = detectarTipoPix(fp.pix_chave.value);
  const dicaPix = () => (document.getElementById('dica-pix').textContent = DICAS_PIX[fp.pix_tipo.value]);
  fp.pix_tipo.addEventListener('change', dicaPix);
  dicaPix();
  app.querySelectorAll('form[data-sec]').forEach((f) =>
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      comEspera(f.querySelector('button'), async () => {
        const d = dadosForm(f);
        const corpo = {};
        for (const [k, v] of Object.entries(d)) {
          if (k === 'pix_tipo') continue;
          if (k === 'contato_whatsapp' || k === 'contato') corpo[k] = String(v).trim();
          else if (String(v).trim() !== '') corpo[k] = ['pix_chave', 'pix_nome', 'pix_cidade', 'contato'].includes(k) ? v.trim() : Number(v);
        }
        if (corpo.pix_chave !== undefined) corpo.pix_chave = normalizarChavePix(fp.pix_tipo.value, corpo.pix_chave);
        await api('PUT', '/admin/config', corpo);
        aviso('Configurações salvas.');
        await irParaLista('#secoes-config');
      });
    }),
  );
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
    <h2 id="lista-usuarios" class="h-mais">Usuários (<span id="cont-usuarios">${u.usuarios.length}</span>) <button type="button" class="mais" data-abre="f" aria-label="Novo usuário" title="Cadastrar hostess ou admin">+</button></h2>
    <input type="search" id="busca-usuarios" placeholder="Buscar por nome, e-mail, celular ou CPF" autocomplete="off" autocapitalize="off" spellcheck="false" style="margin-bottom:.6rem">
    <div id="lista-usuarios-itens">
    ${u.usuarios
      .map(
        (x) => `<details class="item" data-busca="${esc(semAcento(`${x.nome} ${x.sobrenome} ${x.email} ${x.telefone} ${soDig(x.telefone)} ${x.cpf} ${fmtCpf(x.cpf)} ${x.papel}`))}"><summary><b>${esc(x.nome)} ${esc(x.sobrenome)}</b><span class="peq">${esc(x.papel)}${x.ativo ? '' : ' · <span class="tag cancelado">inativo</span>'}</span></summary>
        <div class="card">
          <p class="peq" style="margin:0 0 .6rem">${esc(x.telefone)}<br>${esc(x.email)}</p>
          ${x.id === estado.eu.id ? '' : `<label>Perfil</label><select data-papel="${x.id}"><option value="comprador"${x.papel === 'comprador' ? ' selected' : ''}>comprador</option><option value="hostess"${x.papel === 'hostess' ? ' selected' : ''}>hostess</option><option value="admin"${x.papel === 'admin' ? ' selected' : ''}>admin</option></select>`}
          <div class="acoes" style="margin-top:.75rem"><button class="bt sec peq" data-senha="${x.id}" data-cpf="${esc(x.cpf)}">Nova senha</button>
          ${x.id !== estado.eu.id ? `<button class="bt sec peq" data-ativo="${x.id}" data-v="${x.ativo ? 0 : 1}">${x.ativo ? 'Desativar' : 'Reativar'}</button>` : ''}</div>
        </div></details>`,
      )
      .join('')}
    <p class="mudo" id="sem-usuarios" hidden>Nenhum usuário encontrado.</p>
    </div>
    <form class="card" id="f" hidden><b>Cadastrar recepcionista (hostess) ou admin</b>
      ${campoUsuario('<label>Perfil</label><select name="papel"><option value="hostess">Hostess (leitura de QR e lista)</option><option value="admin">Administrador</option></select>' + campoSenha('senha', 'Senha provisória (ela troca no 1º acesso)'))}
      <div class="linha"><button class="bt peq">Cadastrar</button><button type="button" class="bt sec peq" data-fecha="f">Cancelar</button></div></form>`,
  );
  ligarMais();
  // Busca: filtra a lista já carregada (sem acento e sem diferenciar maiúsculas); todas as palavras digitadas precisam aparecer.
  const buscaUsu = document.getElementById('busca-usuarios');
  const filtrarUsuarios = () => {
    const termos = semAcento(buscaUsu.value).split(/\s+/).filter(Boolean);
    let n = 0;
    app.querySelectorAll('#lista-usuarios-itens details.item').forEach((el) => {
      const ok = termos.every((t) => el.dataset.busca.includes(t));
      el.hidden = !ok;
      if (ok) n++;
    });
    document.getElementById('cont-usuarios').textContent = termos.length ? `${n} de ${u.usuarios.length}` : u.usuarios.length;
    document.getElementById('sem-usuarios').hidden = n > 0;
  };
  buscaUsu.addEventListener('input', filtrarUsuarios);
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
      await irParaLista('#lista-usuarios');
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
  P.pendentes = d.pendentes || [];
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

// Entrada pela lista: só com internet e com os 4 últimos números do celular do titular (o servidor confere).
async function entradaManual(it, ultimos4) {
  if (!navigator.onLine) throw new Error('Sem internet: a entrada pela lista precisa de conexão. Use o QR, que funciona offline.');
  const r = await apiTimeout('POST', '/portaria/entrada-manual', { ingresso_id: it.id, ultimos4 });
  if (r.resultado === 'ok' || r.resultado === 'usado') {
    it.status = 'usado';
    it.usado_em = r.usado_em;
    salvarP();
  }
  return r;
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
    <div class="abas"><a href="#" data-aba="ler" class="on">Ler QR</a><a href="#" data-aba="lista">Lista</a><a href="#" data-aba="venda">Venda</a></div>
    <div id="aba-ler">
      <div class="camera"><video id="video" playsinline muted></video><canvas id="cv" hidden></canvas></div>
      <div class="acoes" style="margin:.75rem 0"><button class="bt" id="btcam">Abrir câmera</button><button class="bt sec" id="btatualiza">Atualizar lista</button></div>
      <p class="peq" id="camerro"></p>
    </div>
    <div id="aba-lista" hidden>
      <input id="busca" placeholder="Buscar por nome…" autocomplete="off">
      <div id="itens"></div>
    </div>
    <div id="aba-venda" hidden></div>
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
    const pend = (P.pendentes || []).filter((x) => !q || semAcento(x.nome).includes(q)).slice(0, 50);
    if (pend.length) {
      $('itens').insertAdjacentHTML('beforeend', pend.map((x) => `<div class="card"><div class="linha"><div><b>${esc(x.nome)}</b><div class="peq">cortesia (${esc(CATEGORIAS_CONV[x.categoria] || '')})${x.restantes > 1 ? ` · ${x.restantes} ingressos` : ''} · sem cadastro no app</div></div><div class="acoes">${tag('pendente')}<button class="bt peq" data-pend="${x.id}">Dar entrada</button></div></div></div>`).join(''));
    }
    $('itens').querySelectorAll('[data-pend]').forEach((b) =>
      b.addEventListener('click', async () => {
        const x = (P.pendentes || []).find((y) => y.id === Number(b.dataset.pend));
        if (!x) return;
        if (!navigator.onLine) return aviso('Sem internet: a entrada de quem não tem cadastro precisa de conexão.', 'erro');
        const resp = await pedirDigitos(`Entrada de ${x.nome}`, x.restantes || 1);
        if (resp === null) return;
        try {
          const r = await apiTimeout('POST', '/portaria/entrada-convite', { convite_id: x.id, ultimos4: resp.d4, quantas: resp.quantas });
          mostrarResultado(r);
          try { await atualizarLista(); } catch {}
          desenharTopo();
          desenharLista();
        } catch (e) {
          aviso(e.message, 'erro');
        }
      }),
    );
    $('itens').querySelectorAll('[data-man]').forEach((b) =>
      b.addEventListener('click', async () => {
        const it = P.lista.find((x) => x.id === Number(b.dataset.man));
        if (!it) return;
        const resp = await pedirDigitos(`Entrada de ${it.nome}`);
        if (resp === null) return;
        try {
          mostrarResultado(await entradaManual(it, resp.d4));
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

  // Venda presencial (dinheiro ou Pix na porta). Exige internet: o estoque é decidido no servidor.
  const abrirVenda = async () => {
    const box = $('aba-venda');
    if (!navigator.onLine) {
      box.innerHTML = '<div class="card">A venda precisa de internet, para nunca vender o mesmo ingresso duas vezes. A leitura de QR continua funcionando sem internet.</div>';
      return;
    }
    let d;
    try { d = await api('GET', '/portaria/lotes-venda'); } catch (e) { box.innerHTML = `<div class="card">${esc(e.message)}</div>`; return; }
    const lotes = d.lotes.filter((l) => l.disponiveis > 0);
    if (!lotes.length) { box.innerHTML = '<div class="card">Nenhum lote liberado para venda presencial. O administrador define isso em Lotes (“Online e na porta” ou “Só na porta”).</div>'; return; }
    box.innerHTML = `<form class="card" id="fvenda">
      <label>Lote</label>
      <select name="lote">${lotes.map((l) => `<option value="${l.id}" data-v="${l.valor_centavos}" data-max="${Math.min(20, l.disponiveis)}">${esc(l.nome)} — ${brl(l.valor_centavos)}</option>`).join('')}</select>
      <label>Quantidade</label>
      ${stepperHtml('name="quantidade"', Math.min(20, lotes[0].disponiveis))}
      <div id="vnomes"></div>
      <label>Forma de pagamento</label>
      <div class="grade"><label class="check" style="margin:0"><input type="radio" name="forma" value="dinheiro" checked> <span>Dinheiro</span></label>
      <label class="check" style="margin:0"><input type="radio" name="forma" value="pix_chave"> <span>Pix</span></label>
      <label class="check" style="margin:0"><input type="radio" name="forma" value="cartao"> <span>Cartão (Maquininha)</span></label></div>
      <div class="card" id="vpix" hidden style="background:var(--campo);margin-top:.6rem">
        <div class="linha"><span class="peq">Chave Pix (CNPJ) · PagSeguro</span><button type="button" class="bt sec peq" id="vpixcopiar">Copiar</button></div>
        <b style="font-family:var(--mono);font-size:1.05rem;letter-spacing:.02em">37318148000189</b>
        <p class="peq" style="margin:.4rem 0 0">Favorecido: 37.318.148 THIAGO RODRIGUES CHAVES</p>
      </div>
      <p class="peq">A entrada de todos é marcada na hora, sem QR.</p>
      <div class="card" style="background:var(--campo);margin-top:1rem"><div class="linha"><span><b>Total a receber</b></span><b class="preco" id="vtotal"></b></div><p class="peq" style="margin:.4rem 0 0">Sem taxa de serviço na venda presencial.</p></div>
      <button class="bt bloco">Registrar venda</button></form>`;
    const f = $('fvenda');
    ligarSteppers(f);
    const calc = () => {
      const op = f.lote.selectedOptions[0];
      f.querySelector('.qtd').dataset.max = op.dataset.max;
      f.querySelector('.qtd').setValor(Number(f.quantidade.value));
      $('vtotal').textContent = brl(Number(op.dataset.v) * Number(f.quantidade.value));
      const q = Number(f.quantidade.value);
      const box2 = $('vnomes');
      const atuais = [...box2.querySelectorAll('input[name^="nome"]')].map((i) => i.value);
      const cels = [...box2.querySelectorAll('input[name^="cel"]')].map((i) => i.value);
      box2.innerHTML = Array.from({ length: q }, (_, i) => `<label>${q > 1 ? `Nome da pessoa ${i + 1}` : 'Nome do convidado'}</label><input name="nome${i}" required minlength="2" maxlength="80" autocomplete="off" placeholder="Nome e sobrenome" value="${esc(atuais[i] || '')}">
        <label>Celular${q > 1 ? ` da pessoa ${i + 1}` : ''} <span class="peq">(opcional)</span></label><input name="cel${i}" type="tel" inputmode="tel" maxlength="16" autocomplete="off" placeholder="11 99999-9999" value="${esc(cels[i] || '')}">`).join('');
    };
    const mostraPix = () => { $('vpix').hidden = f.forma.value !== 'pix_chave'; };
    f.querySelectorAll('input[name="forma"]').forEach((r) => r.addEventListener('change', mostraPix));
    mostraPix();
    $('vpixcopiar').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText('37318148000189'); aviso('Chave Pix copiada!'); } catch { aviso('Copie a chave exibida na tela.', 'erro'); }
    });
    f.lote.addEventListener('change', calc);
    f.quantidade.addEventListener('change', calc);
    calc();
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      comEspera(f.querySelector('button'), async () => {
        try {
          const r = await api('POST', '/portaria/venda', { lote_id: Number(f.lote.value), quantidade: Number(f.quantidade.value), nomes: [...$('vnomes').querySelectorAll('input[name^="nome"]')].map((i) => i.value), celulares: [...$('vnomes').querySelectorAll('input[name^="cel"]')].map((i) => i.value), forma: f.forma.value });
          aviso(`Venda registrada: ${r.quantidade} ingresso(s), ${brl(r.total_centavos)} em ${({ dinheiro: 'dinheiro', cartao: 'cartão' })[r.forma] || 'Pix'} · entrada marcada.`);
          try { await atualizarLista(); } catch {}
          desenharTopo();
          abrirVenda();
        } catch (err) {
          aviso(err.message, 'erro');
        }
      });
    });
  };

  app.querySelectorAll('[data-aba]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      aba = a.dataset.aba;
      app.querySelectorAll('[data-aba]').forEach((x) => x.classList.toggle('on', x === a));
      $('aba-ler').hidden = aba !== 'ler';
      $('aba-lista').hidden = aba !== 'lista';
      $('aba-venda').hidden = aba !== 'venda';
      if (aba === 'lista') desenharLista();
      if (aba === 'venda') abrirVenda();
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

function pedirDigitos(titulo, maxQtd = 1) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'overlay modal';
    ov.innerHTML = `<form class="card ov-corpo"><h2 style="margin-top:0">${esc(titulo)}</h2>
      <label>4 últimos números do celular do titular</label><input name="d4" required inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" placeholder="0000" style="font-size:1.6rem;letter-spacing:.4rem;text-align:center">
      ${maxQtd > 1 ? `<label>Quantas pessoas entram agora?</label><select name="quantas">${Array.from({ length: maxQtd }, (_, i) => maxQtd - i).map((n) => `<option>${n}</option>`).join('')}</select>` : ''}
      <p class="peq">Peça para a pessoa falar os números. Não mostre nem leia o telefone cadastrado.</p>
      <div class="acoes" style="margin-top:1rem"><button class="bt">Liberar entrada</button><button type="button" class="bt sec" id="cancela">Cancelar</button></div></form>`;
    document.body.appendChild(ov);
    const f = ov.querySelector('form');
    f.d4.focus();
    const fim = (v) => { ov.remove(); resolve(v); };
    f.addEventListener('submit', (e) => { e.preventDefault(); fim({ d4: f.d4.value.replace(/\D/g, ''), quantas: f.quantas ? Number(f.quantas.value) : 1 }); });
    ov.querySelector('#cancela').addEventListener('click', () => fim(null));
  });
}

// ---------- avisos (admin) ----------
const b64uParaBytes = (b) => {
  const t = (b + '='.repeat((4 - (b.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
};
// ---------- Notificações (push): estado verificado sempre, religa sozinho e avisa quando está desligado ----------
const estadoPush = { situacao: null, t: 0 };
const pushManual = () => { try { return localStorage.getItem('push_desligado_manual') === '1'; } catch { return false; } };
const pushManualSet = (v) => { try { v ? localStorage.setItem('push_desligado_manual', '1') : localStorage.removeItem('push_desligado_manual'); } catch {} };
const pushSuportado = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function assinarPush(reg) {
  const { publica } = await api('GET', '/admin/push/chave');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uParaBytes(publica) });
  await api('POST', '/admin/push/assinar', { endpoint: sub.endpoint });
  return sub;
}
async function verificarPush(forcar = false) {
  if (estado.eu?.papel !== 'admin') return null;
  if (!forcar && Date.now() - estadoPush.t < 30000) return estadoPush.situacao;
  estadoPush.t = Date.now();
  let sit;
  try {
    if (!pushSuportado()) sit = /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone ? 'instalar' : 'sem_suporte';
    else if (Notification.permission === 'denied') sit = 'bloqueado';
    else {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('sw')), 6000))]);
      let sub = await reg.pushManager.getSubscription();
      if (sub) {
        // o servidor é quem manda: se ele não conhece (ou apagou) esta assinatura, ela é refeita
        const { registrado } = await api('GET', `/admin/push/estado?endpoint=${encodeURIComponent(sub.endpoint)}`);
        if (!registrado) { await sub.unsubscribe().catch(() => {}); sub = null; }
      }
      if (!sub && Notification.permission === 'granted' && !pushManual()) sub = await assinarPush(reg).catch(() => null);
      sit = sub ? 'ok' : 'desativado';
    }
  } catch {
    sit = estadoPush.situacao; // sem internet / erro passageiro: mantém o último estado conhecido
  }
  estadoPush.situacao = sit;
  if (sit === 'ok') pushJaAtivoSet(true);
  pintarSino();
  return sit;
}
// ---------- Sino de notificações (menu, depois de "Sair") ----------
// verde = ativadas · vermelho com risco, piscando = desativadas · amarelo = estavam ativadas e o sistema desligou
const pushJaAtivo = () => { try { return localStorage.getItem('push_ja_ativo') === '1'; } catch { return false; } };
const pushJaAtivoSet = (v) => { try { v ? localStorage.setItem('push_ja_ativo', '1') : localStorage.removeItem('push_ja_ativo'); } catch {} };
function sinoClasse() {
  const s = estadoPush.situacao;
  if (s === 'ok') return 'verde';
  if (!s) return 'neutro';
  return pushJaAtivo() && !pushManual() ? 'amarelo' : 'vermelho';
}
const SINO_TITULO = {
  verde: 'Notificações ativadas. Toque duas vezes para enviar um teste; segure para desativar.',
  vermelho: 'Notificações desativadas. Toque para ativar.',
  amarelo: 'O sistema desativou as notificações. Toque para religar.',
  neutro: 'Verificando notificações…',
};
function htmlSino() {
  const c = sinoClasse();
  return `<button type="button" id="sino" class="sino ${c}" title="${SINO_TITULO[c]}" aria-label="${SINO_TITULO[c]}">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/><line class="risco" x1="3" y1="3" x2="21" y2="21"/></svg></button>`;
}
function pintarSino() {
  const b = document.getElementById('sino');
  if (!b) return;
  const c = sinoClasse();
  b.className = `sino ${c}`;
  b.title = SINO_TITULO[c];
  b.setAttribute('aria-label', SINO_TITULO[c]);
}
async function testarPush() {
  try {
    const r = await api('POST', '/admin/push/teste', {});
    aviso(r.enviados ? `Teste enviado (${r.enviados} aparelho${r.enviados === 1 ? '' : 's'}).` : 'Nenhum aparelho recebeu o teste. Toque no sino para religar.', r.enviados ? 'ok' : 'erro');
  } catch (e) { aviso(e.message, 'erro'); }
  await verificarPush(true);
}
async function desativarPushManual() {
  if (!confirm('Desativar as notificações neste aparelho?')) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('POST', '/admin/push/cancelar', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    pushManualSet(true);
    pushJaAtivoSet(false);
    await verificarPush(true);
    aviso('Notificações desativadas.');
  } catch (e) { aviso(e.message, 'erro'); }
}
function ligarSino() {
  const b = document.getElementById('sino');
  if (!b) return;
  let ultimo = 0, esperaMsg = null, segurou = false, seguraTimer = null;
  const solta = () => clearTimeout(seguraTimer);
  b.addEventListener('pointerdown', () => {
    segurou = false;
    if (estadoPush.situacao === 'ok') seguraTimer = setTimeout(() => { segurou = true; desativarPushManual(); }, 800);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, solta));
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  b.addEventListener('click', () => {
    if (segurou) { segurou = false; return; }
    const sit = estadoPush.situacao;
    if (sit === 'ok') {
      const t = Date.now();
      if (t - ultimo < 450) { ultimo = 0; clearTimeout(esperaMsg); testarPush(); return; }
      ultimo = t;
      esperaMsg = setTimeout(() => aviso('Notificações ativadas. Toque duas vezes para enviar um teste; segure para desativar.'), 450);
      return;
    }
    if (sit === 'bloqueado') return aviso('Notificações bloqueadas pelo navegador. Libere em Configurações do site → Notificações e abra o app de novo.', 'erro');
    if (sit === 'instalar') return aviso('No iPhone, instale o site na tela inicial para receber notificações.', 'erro');
    if (sit === 'sem_suporte') return aviso('Este navegador não recebe notificações. Use o Chrome (Android) ou instale o site na tela inicial.', 'erro');
    ativarPush(null).catch((e) => aviso(e.message, 'erro'));
  });
}
async function ativarPush(botao) {
  const fazer = async () => {
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('Permissão negada. Libere as notificações nas configurações do navegador.');
    pushManualSet(false);
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe().catch(() => {}); // recomeça limpo, evita assinatura velha
    await assinarPush(reg);
    await verificarPush(true);
    aviso('Notificações ativadas.');
  };
  if (botao) await comEspera(botao, fazer);
  else await fazer();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') verificarPush(); });
setInterval(() => verificarPush(true), 5 * 60 * 1000);

rota('/admin/avisos', async () => {
  if (!exigirAdmin()) return;
  const d = await api('GET', '/admin/alertas');
  verificarPush(true);
  layoutAdmin(
    'avisos',
    `<div class="card"><div class="linha"><h2 style="margin:0">Avisos</h2>${d.nao_lidos ? '<button class="bt sec peq" id="lidos">Marcar como lidos</button>' : ''}</div>
      ${d.alertas.length ? d.alertas.map((a) => `<div class="linha aviso-item" style="margin-top:.6rem"><div>${a.lido_em ? '' : '<span class="badge">novo</span> '}${esc(a.detalhe).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}<div class="peq">${hora(a.criado_em)}${a.pedido ? ` · pedido agora: ${tag(a.pedido.status)}` : ''}</div>
        ${a.tipo === 'novo_pedido' && a.pedido && ['aguardando_pagamento', 'expirado'].includes(a.pedido.status) ? `<div class="acoes" style="margin-top:.4rem"><button class="bt ok peq" data-confirmar-pedido="${a.pedido.id}">Confirmar Pix</button><a class="bt sec peq" href="#/admin/pedidos" data-ver-pedidos>Ver pedido</a></div>` : ''}</div></div>`).join('') : '<p class="mudo">Nenhum aviso ainda.</p>'}
    </div>`,
  );
  app.querySelectorAll('[data-confirmar-pedido]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm('Confirmar que o Pix deste pedido caiu na conta? Confira no extrato: valor exato, horário e nome do pagador.')) return;
      comEspera(b, async () => {
        await api('POST', `/admin/pedidos/${b.dataset.confirmarPedido}/confirmar`, {});
        aviso('Pedido confirmado. Ingressos liberados.');
        navegar();
      });
    }),
  );
  app.querySelectorAll('[data-ver-pedidos]').forEach((a) => a.addEventListener('click', () => { try { sessionStorage.setItem('fped', 'todos'); } catch {} }));
  document.getElementById('lidos')?.addEventListener('click', (e) =>
    comEspera(e.target, async () => {
      await api('POST', '/admin/alertas/lidos', {});
      await carregarEu();
      navegar();
    }),
  );
});

const CATEGORIAS_CONV = { dj: 'DJ', aniversariante: 'Aniversariante', convidado: 'Amigo / parceiro' };
const linkConvite = (token) => `${location.origin}/#/convite/${token}`;
function zapConvite(cv, evento) {
  const primeiro = cv.nome.split(' ')[0];
  const qtd = cv.quantidade > 1 ? `${cv.quantidade} ingressos` : 'seu ingresso';
  const msg = `Olá, ${primeiro}! Sua cortesia (${CATEGORIAS_CONV[cv.categoria]}) para ${evento?.nome || 'a festa'}${evento?.data_evento ? ` (${dataBR(evento.data_evento)})` : ''} está garantida 🎉\n\nAbra o link e crie sua conta com este mesmo celular (ou entre, se já tiver conta). ${qtd[0].toUpperCase() + qtd.slice(1)} aparece${cv.quantidade > 1 ? 'm' : ''} no app:\n${linkConvite(cv.token)}\n\nNa portaria, tenha o celular em mãos: vamos confirmar os 4 últimos números dele.`;
  return `https://wa.me/${cv.telefone}?text=${encodeURIComponent(msg)}`;
}

rota('/admin/cortesias', async () => {
  if (!exigirAdmin()) return;
  const lista = await api('GET', '/admin/convites');
  const evento = lista.evento;
  const camposConv = (x = {}) => `<label>Categoria</label>
      <select name="categoria">${Object.entries(CATEGORIAS_CONV).map(([k, n]) => `<option value="${k}"${x.categoria === k ? ' selected' : ''}>${n}</option>`).join('')}</select>
      <label>Nome completo</label><input name="nome" value="${esc(x.nome || '')}" maxlength="80" required>
      <label>Celular (com DDD) — a pessoa precisa usar este número no cadastro</label><input name="telefone" inputmode="tel" value="${esc(x.telefone ? x.telefone.replace(/^55/, '') : '')}" placeholder="11 99999-9999" required>
      <label>E-mail (opcional — também libera o convite se bater)</label><input name="email" type="email" value="${esc(x.email || '')}">
      <div data-nasc${x.categoria === 'aniversariante' ? '' : ' hidden'}><label>Data de nascimento</label><input name="nascimento" type="date" value="${esc(x.nascimento || '')}"></div>
      <label>Quantidade de ingressos</label>
      <select name="quantidade">${[1, 2, 3, 4].map((n) => `<option${Number(x.quantidade || 1) === n ? ' selected' : ''}>${n}</option>`).join('')}</select>
      <p class="peq">DJ: você decide se leva 1 ou 2 ingressos; os dois ficam na conta dele, e ele repassa o segundo pelo link em “Meus ingressos”.</p>`;
  const ligarCategoria = (f) => {
    const sync = () => { const box = f.querySelector('[data-nasc]'); box.hidden = f.categoria.value !== 'aniversariante'; };
    f.categoria.addEventListener('change', sync);
    sync();
  };
  const itens = lista.convites
    .map((x) => {
      const resumo = `${esc(CATEGORIAS_CONV[x.categoria])}${x.quantidade > 1 ? ` · ${x.quantidade} ingressos` : ''}`;
      const cab = `<summary><b>${esc(x.nome)}</b><span class="peq">${tag(x.status)} ${resumo}</span></summary>`;
      if (x.status === 'pendente') {
        return `<details class="item">${cab}<form class="card" data-convite="${x.id}">${camposConv(x)}
          <div class="acoes" style="margin-top:.75rem">
            <button class="bt peq">Salvar</button>
            <a class="bt sec peq" target="_blank" rel="noopener" href="${esc(zapConvite(x, evento))}">Enviar pelo WhatsApp</a>
            <button type="button" class="bt sec peq" data-copia="${esc(linkConvite(x.token))}">Copiar link</button>
            <button type="button" class="bt perigo peq" data-exclui="${x.id}" data-nome="${esc(x.nome)}">Excluir cortesia</button>
          </div><div class="erro-conv"></div></form></details>`;
      }
      if (x.status === 'resgatado') {
        return `<details class="item">${cab}<form class="card" data-convite="${x.id}">
          <p class="peq" style="margin-top:0">Conta: ${esc(x.conta || '—')} · resgatado em ${hora(x.resgatado_em)}<br>Ingressos: ${x.validos} válido(s) · ${x.entraram} usado(s)</p>
          ${camposConv(x)}
          <p class="peq">Mudar a quantidade ajusta os ingressos da conta (aumentar cria os novos na hora; reduzir cancela os não usados). Trocar o celular ou e-mail cancela os ingressos não usados e libera de novo para o novo contato.</p>
          <div class="acoes" style="margin-top:.75rem">
            <button class="bt peq">Salvar</button>
            <button type="button" class="bt sec peq" data-zap="${esc(zapConvite(x, evento))}">Enviar pelo WhatsApp</button>
            <button type="button" class="bt perigo peq" data-exclui="${x.id}" data-nome="${esc(x.nome)}">Excluir cortesia</button>
          </div><div class="erro-conv"></div></form></details>`;
      }
      return `<details class="item">${cab}<div class="card"><p class="peq" style="margin:0">Celular: ${esc(x.telefone)}${x.email ? `<br>E-mail: ${esc(x.email)}` : ''}${x.nascimento ? `<br>Nascimento: ${dataBR(x.nascimento)}` : ''}</p>
        <div class="acoes" style="margin-top:.75rem"><button type="button" class="bt perigo peq" data-exclui="${x.id}" data-nome="${esc(x.nome)}">Excluir da lista</button></div></div></details>`;
    })
    .join('');
  layoutAdmin(
    'cortesias',
    `<h2 id="lista-cortesias" class="h-mais">Cortesias (${lista.convites.length}) <button type="button" class="mais" data-abre="f" aria-label="Nova cortesia" title="Nova cortesia">+</button></h2>
    ${itens || '<p class="mudo">Nenhuma cortesia cadastrada.</p>'}
    <form class="card" id="f" hidden><b>Nova cortesia</b>${camposConv()}
      <div class="linha"><button class="bt peq">Cadastrar cortesia</button><button type="button" class="bt sec peq" data-fecha="f">Cancelar</button></div>
      <div id="erro-cort"></div></form>`,
  );
  ligarMais();
  const lerForm = (f) => ({
    categoria: f.categoria.value,
    nome: f.nome.value,
    telefone: f.telefone.value,
    email: f.email.value,
    nascimento: f.categoria.value === 'aniversariante' ? f.nascimento.value : '',
    quantidade: Number(f.quantidade.value),
  });
  const f = document.getElementById('f');
  ligarCategoria(f);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    comEspera(f.querySelector('button'), async () => {
      const dados = lerForm(f);
      const r = await api('POST', '/admin/convites', dados);
      const cv = { ...dados, telefone: r.telefone, token: r.token };
      const ov = document.createElement('div');
      ov.className = 'overlay modal';
      ov.innerHTML = `<div class="card ov-corpo"><h2 style="margin-top:0">Cortesia cadastrada</h2>
        <p><b>${esc(cv.nome)}</b> · ${esc(CATEGORIAS_CONV[cv.categoria])}${cv.quantidade > 1 ? ` · ${cv.quantidade} ingressos` : ''}</p>
        ${r.resgatado ? '<p class="peq">A pessoa já tinha conta: o ingresso já está liberado no app dela. Se quiser, avise pelo WhatsApp.</p>' : ''}
        <div style="margin-top:1rem">
          <button type="button" class="bt bloco" id="cort-zap">Enviar pelo WhatsApp</button>
          <button type="button" class="bt sec bloco" id="cort-copia" style="margin-top:.5rem">Copiar link</button>
          <button type="button" class="bt sec bloco" id="cort-fecha" style="margin-top:.5rem">Enviar depois</button></div></div>`;
      document.body.appendChild(ov);
      const fim = () => { ov.remove(); irParaLista('#lista-cortesias'); };
      ov.querySelector('#cort-zap').addEventListener('click', () => { window.open(zapConvite(cv, evento), '_blank', 'noopener'); setTimeout(fim, 400); });
      ov.querySelector('#cort-fecha').addEventListener('click', fim);
      ov.querySelector('#cort-copia').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(linkConvite(cv.token)); aviso('Link copiado.'); } catch { prompt('Copie o link:', linkConvite(cv.token)); }
      });
    });
  });
  app.querySelectorAll('form[data-convite]').forEach((fc) => {
    ligarCategoria(fc);
    fc.addEventListener('submit', (e) => {
      e.preventDefault();
      comEspera(fc.querySelector('button'), async () => {
        const r = await api('PUT', `/admin/convites/${fc.dataset.convite}`, lerForm(fc));
        aviso(r.ajustado ? 'Cortesia atualizada.' : r.resgatado ? 'Salvo. A pessoa já tinha conta, então o ingresso foi liberado.' : 'Convite atualizado.');
        await irParaLista('#lista-cortesias');
      });
    });
  });
  app.querySelectorAll('[data-zap]').forEach((b) => b.addEventListener('click', () => window.open(b.dataset.zap, '_blank', 'noopener')));
  app.querySelectorAll('[data-copia]').forEach((b) =>
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copia); aviso('Link copiado.'); } catch { prompt('Copie o link:', b.dataset.copia); }
    }),
  );
  app.querySelectorAll('[data-exclui]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm(`Excluir a cortesia de ${b.dataset.nome}?\n\nOs ingressos dela deixam de valer e de contar. Se a pessoa já entrou na festa, a entrada também deixa de contar.`)) return;
      comEspera(b, async () => {
        await api('DELETE', `/admin/convites/${b.dataset.exclui}`);
        aviso('Cortesia excluída.');
        await irParaLista('#lista-cortesias');
      });
    }),
  );
  app.querySelectorAll('[data-cancela]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm('Cancelar este convite? Ingressos ainda não usados também são cancelados.')) return;
      comEspera(b, async () => {
        await api('POST', `/admin/convites/${b.dataset.cancela}/cancelar`, {});
        await irParaLista('#lista-cortesias');
      });
    }),
  );
});

// ---------- link de cortesia ----------
rota('/convite/([0-9a-f]{32})', async (token) => {
  const info = await api('GET', `/convites/${token}`);
  const cab = `<h1>Sua cortesia</h1>`;
  if (info.estado === 'cancelado') {
    app.innerHTML = `${cab}<div class="card">Este convite foi cancelado. Fale com a organização.</div><a class="bt sec" href="#/">Início</a>`;
    return;
  }
  if (!estado.eu) {
    sessionStorage.setItem('voltar', `#/convite/${token}`);
    app.innerHTML = `${cab}<div class="card atual">Você tem uma cortesia (<b>${esc(info.categoria)}</b>) para <b>${esc(info.evento)}</b> (${dataBR(info.data_evento)}).
      <p class="peq">Crie sua conta (ou entre, se já tiver) usando o <b>mesmo celular</b> ou e-mail que você passou à organização. O ingresso aparece na sua conta logo em seguida.</p>
      <a class="bt bloco" href="#/cadastro">Criar conta</a><a class="bt sec bloco" href="#/entrar">Já tenho conta</a></div>`;
    return;
  }
  try {
    const r = await api('POST', `/convites/${token}/resgatar`, {});
    app.innerHTML = `${cab}<div class="card atual"><b>Cortesia liberada!</b> ${r.quantidade > 1 ? `${r.quantidade} ingressos estão` : 'Seu ingresso está'} na sua conta para <b>${esc(info.evento)}</b>.
      <p class="peq">Na portaria, mostre o QR e tenha o celular em mãos: a recepção confere os 4 últimos números dele.</p>
      <a class="bt bloco" href="#/meus">Ver meus ingressos</a></div>`;
  } catch (e) {
    app.innerHTML = `${cab}<div class="card" style="border-color:var(--erro)">${esc(e.message)}</div><a class="bt sec" href="#/meus">Meus ingressos</a>`;
  }
});

// ---------- início ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
window.addEventListener('hashchange', navegar);
(async () => {
  await carregarEu();
  navegar();
})();
