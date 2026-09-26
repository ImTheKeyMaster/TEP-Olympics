const DEPLOYMENT_VERSION = '14';
const CACHE_NAME = `tep-hunt-v${DEPLOYMENT_VERSION}`;
const SHELL = ['./', './index.html', `./styles.css?v=${DEPLOYMENT_VERSION}`, `./app.js?v=${DEPLOYMENT_VERSION}`, './manifest.webmanifest', './data/teams.json', './images/Objectives.png', './images/JR.jpg', './icons/app-icon.svg', './icons/Emeralds.png', './icons/lamp.png', './icons/open-book.png', './icons/pearls.png', './icons/scroll.png', './icons/star.png', './icons/sword.png', './icons/three-plumes.png', './icons/torch.png'];
const FIREBASE_MODULES = [
  'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js'
];

async function cacheModuleGraph(url, cache, visited = new Set()) {
  if (visited.has(url)) return;
  visited.add(url);
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Unable to cache module ${url}`);
  await cache.put(url, response.clone());
  const source = await response.text();
  const dependencies = new Set();
  const staticImport = /(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g;
  const dynamicImport = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const pattern of [staticImport, dynamicImport]) {
    let match;
    while ((match = pattern.exec(source))) dependencies.add(new URL(match[1], url).href);
  }
  await Promise.all([...dependencies]
    .filter(dependency => {
      const dependencyUrl = new URL(dependency);
      return dependencyUrl.hostname === 'www.gstatic.com'
        && dependencyUrl.pathname.startsWith('/firebasejs/11.10.0/')
        && dependencyUrl.pathname.endsWith('.js');
    })
    .map(dependency => cacheModuleGraph(dependency, cache, visited)));
}

self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(SHELL);
  const visited = new Set();
  for (const moduleUrl of FIREBASE_MODULES) await cacheModuleGraph(moduleUrl, cache, visited);
})()));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('message', event => { if (event.data === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) {
    event.respondWith(fetch(event.request).then(response => {
      const copy=response.clone(); caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy)); return response;
    }).catch(() => caches.match(event.request)));
    return;
  }
  event.respondWith(fetch(event.request).then(response => { const copy=response.clone(); caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy)); return response; }).catch(() => caches.match(event.request).then(hit => hit || (event.request.mode === 'navigate' ? caches.match('./index.html') : caches.match('./icons/lamp.png')))));
});
