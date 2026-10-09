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
}

function desenharNav() {
  const eu = estado.eu;
  let h = '';
  if (!eu) h = '<a href="#/entrar">Entrar</a>';
  else {
    if (eu.papel === 'admin') h += '<a href="#/admin">Admin</a>';
    h += '<a href="#/meus">Meus ingressos</a><button id="sair">Sair</button>';
  }
  nav.innerHTML = h;
  document.getElementById('sair')?.addEventListener('click', async () => {
    try { await api('POST', '/auth/logout', {}); } catch {}
    estado.eu = null;
    desenharNav();
    location.hash = '#/';
  });
}

const rotas = [];
const rota = (padrao, fn) => rotas.push([new RegExp('^' + padrao + '$'), fn]);

async function navegar() {
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
        .map(
          (l) => `
    <div class="card ${l.atual ? 'atual' : ''}">
      <div class="linha">
        <div><b>${esc(l.nome)}</b> ${l.atual ? '<span class="tag valido">Disponível</span>' : ''}
          <div class="peq">${l.esgotado ? 'Esgotado' : `${l.disponiveis} restantes`}</div></div>
        <div style="text-align:right">
          <div class="preco">${brl(l.valor_centavos)}</div>
          <div class="peq">+ ${brl(l.taxa_centavos)} taxa de serviço (${d.taxa_percentual}%)<br><b>Total ${brl(l.total_centavos)}</b></div>
        </div>
      </div>
      ${l.esgotado ? '' : `<button class="bt bloco" data-lote="${l.id}">Comprar</button>`}
    </div>`,
        )
        .join('')
    : '<p class="mudo">Ingressos ainda não disponíveis.</p>';
  app.innerHTML = `
    <h1>${esc(ev.nome)}</h1>
    <p><b>${dataBR(ev.data_evento)}</b>${ev.local ? ` · ${esc(ev.local)}` : ''}</p>
    ${ev.descricao ? `<p class="mudo">${esc(ev.descricao)}</p>` : ''}
    <h2>Ingressos</h2>${lotesHtml}
    <p class="peq">Pagamento por Pix. O valor total já inclui a taxa de serviço, igual em qualquer forma de pagamento. O comprador é responsável pelos ingressos do seu pedido.</p>`;
  app.querySelectorAll('[data-lote]').forEach((b) =>
    b.addEventListener('click', () => {
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
        <div class="linha"><span>Taxa de serviço (${d.taxa_percentual}%)</span><b id="t_taxa"></b></div>
        <div class="linha"><span><b>Total</b></span><b class="preco" id="t_tot"></b></div>
      </div>
      <p class="peq">Ao continuar seguramos seus ingressos por um tempo limitado para você pagar via Pix.</p>
      <button class="bt bloco">Gerar Pix</button>
    </form>`;
  const f = document.getElementById('f');
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
      const r = await api('POST', '/pedidos', { lote_id: l.id, quantidade: Number(f.quantidade.value), nome_pagador: f.nome_pagador.value });
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

rota('/meus', async () => {
  if (!estado.eu) {
    location.hash = '#/entrar';
    return;
  }
  const [ped, ing] = await Promise.all([api('GET', '/meus-pedidos'), api('GET', '/meus-ingressos')]);
  const pedidos = ped.pedidos
    .map(
      (p) => `<a class="card" style="display:block;text-decoration:none;color:inherit" href="#/pedido/${esc(p.codigo)}">
      <div class="linha"><b>${esc(p.codigo)}</b> ${tag(p.status)}</div>
      <div class="peq">${p.quantidade}× ${esc(p.lote)} · ${brl(p.total_centavos)} · ${hora(p.criado_em)}</div></a>`,
    )
    .join('');
  app.innerHTML = `
    <h1>Meus ingressos</h1>
    <p class="mudo">${ing.ingressos.length ? `${ing.ingressos.length} ingresso(s) na sua conta.` : 'Você ainda não tem ingressos liberados.'}</p>
    <div id="lista-ing"></div>
    <h2>Meus pedidos</h2>${pedidos || '<p class="mudo">Nenhum pedido ainda.</p>'}`;
  document.getElementById('lista-ing').innerHTML = ing.ingressos
    .map((i) => `<div class="card"><div class="linha"><b>Ingresso #${i.id}</b> ${tag(i.status)}</div><div class="peq">${esc(i.evento)} · ${dataBR(i.data_evento)}${i.tipo === 'cortesia' ? ' · cortesia' : ''}</div><p class="peq">O QR Code para a entrada aparece aqui (disponível na próxima atualização, antes da festa).</p></div>`)
    .join('');
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
      location.hash = estado.eu?.deve_trocar_senha ? '#/trocar-senha' : volta || (estado.eu?.papel === 'admin' ? '#/admin' : '#/');
    });
  });
});

rota('/cadastro', async () => {
  app.innerHTML = `
    <h1>Criar conta</h1>
    <form class="card" id="f">
      ${campoUsuario(campoSenha() + campoSenha('senha2', 'Repita a senha'))}
      <p class="peq">Seus dados são usados apenas para identificar o comprador dos ingressos. Guarde sua senha: por enquanto a recuperação é feita pela organização.</p>
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
      <button class="bt bloco">Pedir nova senha</button>
    </form>
    <p class="peq">Sua solicitação chega à organização, que vai te passar uma senha provisória (por WhatsApp). No primeiro acesso você escolhe uma nova.</p>`;
  const f = document.getElementById('f');
  mascaraCpf(f.cpf);
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    comEspera(f.querySelector('button'), async () => {
      await api('POST', '/auth/esqueci', { cpf: soDig(f.cpf.value) });
      app.innerHTML = '<h1>Pedido enviado</h1><p class="mudo">Se o CPF estiver cadastrado, a organização recebeu seu pedido e entrará em contato pelo celular cadastrado.</p><a class="bt sec" href="#/entrar">Voltar</a>';
    });
  });
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
      location.hash = estado.eu?.papel === 'admin' ? '#/admin' : '#/';
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
      ${campoUsuario(campoSenha() + campoSenha('senha2', 'Repita a senha'))}
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

// ---------- admin ----------
const ABAS = [
  ['financeiro', 'Financeiro'],
  ['pedidos', 'Pedidos'],
  ['lotes', 'Lotes'],
  ['config', 'Pix e taxas'],
  ['usuarios', 'Usuários'],
];
function layoutAdmin(ativa, html) {
  app.innerHTML = `
    <h1>Administração</h1>
    <div class="abas">${ABAS.map(([k, n]) => `<a href="#/admin/${k}" class="${k === ativa ? 'on' : ''}">${n}</a>`).join('')}</div>
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

rota('/admin/lotes', async () => {
  if (!exigirAdmin()) return;
  const [ev, lo] = await Promise.all([api('GET', '/admin/eventos'), api('GET', '/admin/lotes')]);
  const evAtivo = ev.eventos.find((e) => e.ativo) || ev.eventos[0];
  const cards = lo.lotes
    .map(
      (l) => `<form class="card" data-lote="${l.id}">
      <div class="linha"><b>Lote #${l.id}</b><span class="peq">vendidos ${l.vendidos} · reservados ${l.reservados}</span></div>
      <div class="grade">
        <div><label>Nome</label><input name="nome" value="${esc(l.nome)}" required></div>
        <div><label>Valor do ingresso (R$)</label><input name="valor" inputmode="decimal" value="${reais(l.valor_centavos)}" required></div>
        <div><label>Quantidade total</label><input name="quantidade" inputmode="numeric" value="${l.quantidade}" required></div>
        <div><label>Ordem</label><input name="ordem" inputmode="numeric" value="${l.ordem}"></div>
      </div>
      <label><input type="checkbox" name="ativo" ${l.ativo ? 'checked' : ''} style="width:auto"> Lote ativo (visível para venda)</label>
      <button class="bt peq" style="margin-top:.75rem">Salvar lote</button></form>`,
    )
    .join('');
  layoutAdmin(
    'lotes',
    `<h2>Evento</h2>
    <form class="card" id="fev" data-id="${evAtivo?.id ?? ''}">
      <label>Nome</label><input name="nome" value="${esc(evAtivo?.nome)}" required>
      <div class="grade"><div><label>Data</label><input name="data_evento" type="date" value="${esc(evAtivo?.data_evento)}" required></div>
      <div><label>Local</label><input name="local" value="${esc(evAtivo?.local)}"></div></div>
      <label>Descrição</label><textarea name="descricao" rows="3">${esc(evAtivo?.descricao)}</textarea>
      <button class="bt peq" style="margin-top:.75rem">Salvar evento</button></form>
    <h2>Lotes</h2>${cards || '<p class="mudo">Nenhum lote ainda.</p>'}
    <h2>Novo lote</h2>
    <form class="card" id="fnovo">
      <div class="grade">
        <div><label>Nome</label><input name="nome" placeholder="1º lote" required></div>
        <div><label>Valor do ingresso (R$)</label><input name="valor" inputmode="decimal" placeholder="35,00" required></div>
        <div><label>Quantidade</label><input name="quantidade" inputmode="numeric" required></div>
        <div><label>Ordem</label><input name="ordem" inputmode="numeric" value="${lo.lotes.length + 1}"></div>
      </div>
      <p class="peq">A taxa de serviço (%) é aplicada por cima do valor e aparece para o comprador.</p>
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
      const corpo = { nome: f.nome.value, data_evento: f.data_evento.value, local: f.local.value, descricao: f.descricao.value, ativo: true };
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
      <label>Chave Pix (celular precisa começar com +55)</label><input name="pix_chave" value="${esc(c.pix_chave)}" placeholder="+5511999999999 ou e-mail/CPF/CNPJ/aleatória">
      <div class="grade"><div><label>Nome do favorecido (como no banco)</label><input name="pix_nome" value="${esc(c.pix_nome)}" maxlength="25"></div>
      <div><label>Cidade</label><input name="pix_cidade" value="${esc(c.pix_cidade)}" maxlength="15" placeholder="SAO PAULO"></div></div>
      <h2>Regras de venda</h2>
      <div class="grade"><div><label>Taxa de serviço (%)</label><input name="taxa_percentual" inputmode="numeric" value="${esc(c.taxa_percentual)}"></div>
      <div><label>Prazo da reserva (minutos)</label><input name="reserva_minutos" inputmode="numeric" value="${esc(c.reserva_minutos)}"></div>
      <div><label>Máximo de ingressos por pedido</label><input name="max_ingressos_por_pedido" inputmode="numeric" value="${esc(c.max_ingressos_por_pedido)}"></div></div>
      <p class="peq">Alterar a taxa vale só para pedidos novos; pedidos já feitos mantêm o valor combinado.</p>
      <button class="bt bloco">Salvar</button></form>`,
  );
  const f = document.getElementById('f');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    comEspera(f.querySelector('button'), async () => {
      const d = dadosForm(f);
      const corpo = {};
      for (const [k, v] of Object.entries(d)) if (String(v).trim() !== '') corpo[k] = ['pix_chave', 'pix_nome', 'pix_cidade'].includes(k) ? v.trim() : Number(v);
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
        (x) => `<tr><td>${esc(x.nome)} ${esc(x.sobrenome)}</td><td>${esc(x.papel)}${x.ativo ? '' : ' <span class="tag cancelado">inativo</span>'}</td>
        <td class="peq">${esc(x.telefone)}<br>${esc(x.email)}</td>
        <td><div class="acoes"><button class="bt sec peq" data-senha="${x.id}" data-cpf="${esc(x.cpf)}">Nova senha</button>
        ${x.id !== estado.eu.id ? `<button class="bt sec peq" data-ativo="${x.id}" data-v="${x.ativo ? 0 : 1}">${x.ativo ? 'Desativar' : 'Reativar'}</button>` : ''}</div></td></tr>`,
      )
      .join('')}</table></div>`,
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

// ---------- início ----------
window.addEventListener('hashchange', navegar);
(async () => {
  await carregarEu();
  navegar();
})();
