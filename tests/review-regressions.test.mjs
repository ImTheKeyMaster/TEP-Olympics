import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const worker = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const pwaUpdate = await readFile(new URL('../pwa-update.js', import.meta.url), 'utf8');
const { registerPwaUpdate } = await import(`data:text/javascript;base64,${Buffer.from(pwaUpdate).toString('base64')}`);

class EventTargetMock {
  listeners = new Map();
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  dispatch(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
}

function updateHarness() {
  const elements = Object.fromEntries(['updateNotice', 'updateMessage', 'updateProgress', 'applyUpdate'].map(id => [id, {
    hidden: id !== 'updateMessage', disabled: false, textContent: '', attributes: new Map(),
    classList: { values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); } },
    style: { values: new Map(), setProperty(name, value) { this.values.set(name, value); } },
    setAttribute(name, value) { this.attributes.set(name, value); }, removeAttribute(name) { this.attributes.delete(name); },
    target: new EventTargetMock(), addEventListener(type, listener) { this.target.addEventListener(type, listener); },
    click() { this.target.dispatch('click'); }
  }]));
  const serviceWorkers = new EventTargetMock();
  serviceWorkers.controller = { state: 'activated' };
  const registration = new EventTargetMock();
  registration.update = async () => {};
  serviceWorkers.register = async () => registration;
  let reloads = 0;
  registerPwaUpdate({
    navigatorObject: { serviceWorker: serviceWorkers },
    locationObject: { protocol: 'https:', hostname: 'example.test' },
    documentObject: { getElementById: id => elements[id] },
    reloadPage: () => { reloads += 1; }
  });
  return { elements, serviceWorkers, registration, reloads: () => reloads };
}

test('service worker precaches the complete Firebase module graph', () => {
  assert.match(worker, /const FIREBASE_MODULES = \[/);
  assert.match(worker, /async function cacheModuleGraph/);
  assert.match(worker, /staticImport/);
  assert.match(worker, /dynamicImport/);
  assert.match(worker, /pathname\.startsWith\('\/firebasejs\/11\.10\.0\/'\)/);
  assert.match(worker, /cacheModuleGraph\(dependency, cache, scheduled, progress, true\)/);
  assert.match(worker, /FIREBASE_MODULES\.map\(moduleUrl => cacheModuleGraph/);
});

test('an empty cache is not authoritative before a server snapshot', () => {
  assert.match(app, /!hasServerBackedSnapshot/);
  assert.match(app, /teamSnapshot\?\.metadata\.fromCache/);
  assert.match(app, /!teamSnapshot\.size&&!settingsSnapshot\.exists\(\)/);
  assert.match(app, /showPublishedFallback\(\);return/);
  assert.match(app, /hasServerBackedSnapshot=true/);
});

test('realtime events defer Admin replacement while a team form is dirty', () => {
  assert.match(app, /adminHasUnsavedTeamEdits/);
  assert.match(app, /data-dirty="true"/);
  assert.match(app, /if\(!force&&adminHasUnsavedTeamEdits\(\)\)/);
  assert.match(app, /card\.addEventListener\('input'/);
  assert.match(app, /form\.dataset\.dirty='false';renderAdmin\(\)/);
  assert.match(app, /fingerprint===appliedDataFingerprint/);
});

test('navigation contains the application destinations in order', () => {
  assert.doesNotMatch(html, /refreshButton|↻ Refresh/);
  assert.doesNotMatch(app, /refreshButton/);
  assert.doesNotMatch(html, /installButton|Install App/);
  assert.deepEqual([...html.matchAll(/data-route="([^"]+)"/g)].map(match => match[1]), ['leaderboard', 'objectives', 'admin', 'about']);
  assert.match(app, /onSnapshot\(collection\(db,'teams'\)/);
  assert.match(app, /onSnapshot\(doc\(db,'settings','leaderboard'\)/);
});

test('completed migration controls and code are removed while fallback loading remains', () => {
  assert.doesNotMatch(html, /Initial data migration|Initialize from Published Data|initializeData/);
  assert.doesNotMatch(app, /initializePublishedData|initializeData|runTransaction/);
  assert.match(app, /fetch\('data\/teams\.json'/);
  assert.match(app, /showPublishedFallback/);
});

test('Objectives is a responsive routed view available offline', () => {
  assert.match(html, /id="objectivesScreen"/);
  assert.match(html, /class="objectives-button" href="#objectives">Objectives<\/a><button id="revealButton"/);
  assert.match(html, /class="objectives-close" href="#leaderboard" aria-label="Return to leaderboard">×<\/a>/);
  assert.match(html, /href="images\/Objectives\.png"[^>]*target="_blank"/);
  assert.match(html, /alt="TEP Scavenger Hunt Objectives"/);
  assert.match(app, /'leaderboard','objectives','admin','about'/);
  assert.match(worker, /'\.\/images\/Objectives\.png'/);
  assert.match(styles, /\.objectives-image\{[^}]*width:100%[^}]*max-width:1427px[^}]*height:auto[^}]*object-fit:contain/);
  assert.match(styles, /@media\(max-width:650px\).*\.objectives-hint\{display:block/);
  assert.match(styles, /\.objectives-button\{[^}]*min-height:48px/);
  assert.match(styles, /\.objectives-close\{[^}]*width:48px[^}]*height:48px/);
  assert.match(styles, /\.leaderboard-heading\{[^}]*flex-wrap:wrap/);
  assert.match(styles, /@media\(max-width:540px\).*\.leaderboard-actions\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media\(max-width:540px\).*\.leaderboard-actions #teamCount\{[^}]*grid-column:1\/-1/);
  assert.match(app, /const APP_VERSION = '18'/);
  assert.match(worker, /const DEPLOYMENT_VERSION = '18'/);
  assert.match(html, /styles\.css\?v=18/);
  assert.match(html, /app\.js\?v=18/);
});

test('update progress reports completed cache operations and gates reload', () => {
  assert.match(worker, /await cache\.put\(url, response\);\s*await progress\.complete\(\)/);
  assert.match(worker, /type: 'CACHE_PROGRESS'/);
  assert.match(worker, /percent: Math\.floor\(\(completed \/ total\) \* 100\)/);
  assert.match(worker, /Promise\.all\(SHELL\.map/);
  assert.match(worker, /newDependencies\.forEach\(dependency => scheduled\.add\(dependency\)\)/);
  assert.match(worker, /progress\?\.stop\(\);\s*await caches\.delete/);
  assert.match(worker, /await caches\.delete\(CACHE_NAME\)/);
  assert.match(worker, /type: 'CACHE_ERROR'/);
  assert.match(worker, /clients\.matchAll\(\{ type: 'window', includeUncontrolled: true \}\)/);
  assert.match(worker, /client\.postMessage\(\{ \.\.\.message, version: DEPLOYMENT_VERSION \}\)/);
  assert.match(worker, /event\.waitUntil\(self\.skipWaiting\(\)\)/);
  assert.match(worker, /if \(!isFirebaseModule\) return/);
  assert.match(worker, /do not hold the old worker alive by intercepting Firestore's/);
  assert.match(pwaUpdate, /payload\.type === 'CACHE_PROGRESS'/);
  assert.match(pwaUpdate, /waitingWorker\.postMessage\('SKIP_WAITING'\)/);
  assert.match(html, /role="progressbar"/);
  assert.match(styles, /--update-progress/);
});

test('installing-worker progress appears before ready, including completed and total work', async () => {
  const harness = updateHarness();
  await Promise.resolve();
  const installing = new EventTargetMock();
  installing.state = 'installing';
  harness.registration.installing = installing;
  harness.registration.dispatch('updatefound');
  assert.equal(harness.elements.updateMessage.textContent, 'Updating app… 0%');
  harness.serviceWorkers.dispatch('message', { source: installing, data: { type: 'CACHE_PROGRESS', version: '18', completed: 9, total: 20, percent: 45 } });
  assert.equal(harness.elements.updateMessage.textContent, 'Updating app… 45%');
  assert.equal(harness.elements.updateProgress.attributes.get('aria-valuetext'), '9 of 20 files cached');
  assert.equal(harness.elements.applyUpdate.hidden, true);
  installing.state = 'installed';
  installing.dispatch('statechange');
  assert.equal(harness.elements.updateMessage.textContent, 'A new app version is ready.');
  assert.equal(harness.elements.applyUpdate.hidden, false);
});

test('Reload gives immediate feedback, asks the waiting worker to activate, and reloads once', async () => {
  const harness = updateHarness();
  await Promise.resolve();
  const messages = [];
  harness.registration.waiting = { state: 'installed', postMessage: message => messages.push(message) };
  harness.elements.applyUpdate.click();
  assert.equal(harness.elements.updateMessage.textContent, 'Installing update…');
  assert.equal(harness.elements.applyUpdate.hidden, true);
  assert.equal(harness.elements.applyUpdate.disabled, true);
  assert.deepEqual(messages, ['SKIP_WAITING']);
  harness.serviceWorkers.dispatch('controllerchange');
  harness.serviceWorkers.dispatch('controllerchange');
  assert.equal(harness.reloads(), 1);
});

test('a failed install reports failure without activating or discarding the current controller', async () => {
  const harness = updateHarness();
  await Promise.resolve();
  const activeController = harness.serviceWorkers.controller;
  const installing = new EventTargetMock();
  harness.registration.installing = installing;
  harness.registration.dispatch('updatefound');
  harness.serviceWorkers.dispatch('message', { source: installing, data: { type: 'CACHE_ERROR', version: '18' } });
  assert.equal(harness.elements.updateMessage.textContent, 'Update failed. Using the current version.');
  assert.equal(harness.serviceWorkers.controller, activeController);
  assert.equal(harness.reloads(), 0);
});

test('About the Event presents J.R. responsively and offline', () => {
  assert.match(html, /id="aboutTitle">About the Event</);
  assert.match(html, /src="images\/JR\.jpg" alt="J\.R\. Benning, outgoing National Consul"/);
  assert.match(html, /Consider it his parting gift to the Fraternity\./);
  assert.match(worker, /'\.\/images\/JR\.jpg'/);
  assert.match(styles, /\.about\{display:grid;grid-template-columns:/);
  assert.match(styles, /\.about-portrait img\{[^}]*width:100%[^}]*height:auto[^}]*object-fit:contain/);
  assert.match(styles, /@media\(max-width:650px\).*\.about\{grid-template-columns:1fr/);
});
