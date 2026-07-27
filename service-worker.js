const CACHE_NAME = 'tep-hunt-v5';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './data/teams.json', './icons/app-icon.svg', './icons/lamp.png', './icons/open-book.png', './icons/scroll.png', './icons/star.png', './icons/sword.png', './icons/three-plumes.png', './icons/torch.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('message', event => { if (event.data === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) { event.respondWith(fetch(event.request).catch(() => caches.match('./icons/lamp.png'))); return; }
  event.respondWith(fetch(event.request).then(response => { const copy=response.clone(); caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy)); return response; }).catch(() => caches.match(event.request).then(hit => hit || (event.request.mode === 'navigate' ? caches.match('./index.html') : caches.match('./icons/lamp.png')))));
});
