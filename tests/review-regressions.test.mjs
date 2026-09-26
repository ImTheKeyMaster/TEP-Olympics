import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const worker = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

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
  assert.match(styles, /@media\(max-width:540px\).*\.leaderboard-actions\{[^}]*grid-template-columns:/);
  assert.match(app, /const APP_VERSION = '17'/);
  assert.match(worker, /const DEPLOYMENT_VERSION = '17'/);
  assert.match(html, /styles\.css\?v=17/);
  assert.match(html, /app\.js\?v=17/);
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
  assert.match(app, /type==='CACHE_PROGRESS'&&!failedUpdateVersions\.has\(version\)/);
  assert.match(app, /'applyUpdate'\)\.hidden=true/);
  assert.match(app, /worker\.state==='installed'.*showUpdate\(worker\)/);
  assert.match(html, /role="progressbar"/);
  assert.match(styles, /--update-progress/);
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
