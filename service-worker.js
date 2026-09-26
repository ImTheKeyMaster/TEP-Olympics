const DEPLOYMENT_VERSION = '15';
const CACHE_NAME = `tep-hunt-v${DEPLOYMENT_VERSION}`;
const SHELL = ['./', './index.html', `./styles.css?v=${DEPLOYMENT_VERSION}`, `./app.js?v=${DEPLOYMENT_VERSION}`, './manifest.webmanifest', './data/teams.json', './images/Objectives.png', './images/JR.jpg', './icons/app-icon.svg', './icons/Emeralds.png', './icons/lamp.png', './icons/open-book.png', './icons/pearls.png', './icons/scroll.png', './icons/star.png', './icons/sword.png', './icons/three-plumes.png', './icons/torch.png'];
const FIREBASE_MODULES = [
  'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js'
];

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage({ ...message, version: DEPLOYMENT_VERSION }));
}

function createProgress(total) {
  let completed = 0;
  return {
    addToTotal(count = 1) { total += count; },
    async complete() {
      completed += 1;
      await notifyClients({
        type: 'CACHE_PROGRESS',
        completed,
        total,
        percent: Math.floor((completed / total) * 100)
      });
    }
  };
}

async function cacheAsset(url, cache, progress) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Unable to cache asset ${url}`);
  await cache.put(url, response);
  await progress.complete();
}

async function cacheModuleGraph(url, cache, visited, progress, alreadyCounted = false) {
  if (visited.has(url)) return;
  visited.add(url);
  if (!alreadyCounted) progress.addToTotal();
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
  const moduleDependencies = [...dependencies]
    .filter(dependency => {
      const dependencyUrl = new URL(dependency);
      return dependencyUrl.hostname === 'www.gstatic.com'
        && dependencyUrl.pathname.startsWith('/firebasejs/11.10.0/')
        && dependencyUrl.pathname.endsWith('.js');
    });
  // Count newly discovered imports before reporting this module as complete so
  // a completed graph cannot be reported as 100% while dependencies remain.
  const newDependencies = moduleDependencies.filter(dependency => !visited.has(dependency));
  progress.addToTotal(newDependencies.length);
  await progress.complete();
  await Promise.all(newDependencies.map(dependency => cacheModuleGraph(dependency, cache, visited, progress, true)));
}

self.addEventListener('install', event => event.waitUntil((async () => {
  try {
    const cache = await caches.open(CACHE_NAME);
    const progress = createProgress(SHELL.length + FIREBASE_MODULES.length);
    await notifyClients({ type: 'CACHE_PROGRESS', completed: 0, total: SHELL.length + FIREBASE_MODULES.length, percent: 0 });
    await Promise.all(SHELL.map(asset => cacheAsset(asset, cache, progress)));
    const visited = new Set();
    await Promise.all(FIREBASE_MODULES.map(moduleUrl => cacheModuleGraph(moduleUrl, cache, visited, progress, true)));
  } catch (error) {
    await caches.delete(CACHE_NAME);
    await notifyClients({ type: 'CACHE_ERROR' });
    throw error;
  }
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
