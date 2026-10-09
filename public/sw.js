// Deixa o site abrir sem internet (ingressos e portaria). Rede primeiro; se falhar, usa o salvo.
const VERSAO = 'after-v1';
const BASE = ['/', '/index.html', '/style.css', '/app.js', '/vendor/qrcode.js', '/vendor/jsQR.js', '/manifest.webmanifest', '/icon-192.png'];

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
