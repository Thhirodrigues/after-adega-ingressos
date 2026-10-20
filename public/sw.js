// Deixa o site abrir sem internet (ingressos e portaria). Rede primeiro; se falhar, usa o salvo.
const VERSAO = 'fastpass-v56';
const BASE = ['/', '/index.html', '/style.css', '/app.js', '/vendor/qrcode.js', '/vendor/jsQR.js', '/manifest.webmanifest', '/icon-192.png', '/badge-96.png', '/logo-marca.png', '/splash.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(BASE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname.endsWith('.mp4')) return; // vídeos da splash: o navegador cuida (evita problema com Range no cache)
  e.respondWith(
    (async () => {
      const cache = await caches.open(VERSAO);
      try {
        const rede = await Promise.race([
          fetch(req),
          new Promise((_, rej) => setTimeout(() => rej(new Error('lento')), 5000)),
        ]);
        if (rede.ok) cache.put(req, rede.clone());
        return rede;
      } catch {
        const salvo = (await cache.match(req)) || (req.mode === 'navigate' ? await cache.match('/index.html') : null);
        return salvo || Response.error();
      }
    })(),
  );
});

// Notificações (push sem conteúdo): ao receber o "toque", busca os avisos pendentes.
self.addEventListener('push', (e) => {
  e.waitUntil(
    (async () => {
      let titulo = 'Fast Pass';
      let corpo = 'Você tem um novo aviso.';
      try {
        const r = await fetch('/api/admin/alertas/pendentes', { credentials: 'include' });
        if (r.ok) {
          const j = await r.json();
          if (j.alertas?.length) {
            corpo = j.alertas[0].detalhe;
            if (j.alertas.length > 1) corpo += ` (+${j.alertas.length - 1})`;
          }
        }
      } catch {}
      const abas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      abas.forEach((a) => a.postMessage({ tipo: 'push' }));
      await self.registration.showNotification(titulo, { body: corpo, icon: '/icon-192.png', badge: '/badge-96.png', tag: 'aviso-admin', renotify: true });
    })(),
  );
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const abas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const a of abas) {
        if ('focus' in a) {
          await a.focus();
          if ('navigate' in a) await a.navigate('/#/admin/avisos');
          return;
        }
      }
      await self.clients.openWindow('/#/admin/avisos');
    })(),
  );
});

// O navegador às vezes troca/expira a assinatura sozinho: renova e avisa o servidor, sem precisar abrir o app.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(
    (async () => {
      try {
        const k = await (await fetch('/api/admin/push/chave', { credentials: 'include' })).json();
        const t = (k.publica + '='.repeat((4 - (k.publica.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
        const chave = Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
        const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chave });
        await fetch('/api/admin/push/assinar', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
      } catch {}
    })(),
  );
});
