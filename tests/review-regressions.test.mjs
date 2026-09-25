import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const worker = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');

test('service worker precaches the complete Firebase module graph', () => {
  assert.match(worker, /const FIREBASE_MODULES = \[/);
  assert.match(worker, /async function cacheModuleGraph/);
  assert.match(worker, /staticImport/);
  assert.match(worker, /dynamicImport/);
  assert.match(worker, /pathname\.startsWith\('\/firebasejs\/11\.10\.0\/'\)/);
  assert.match(worker, /cacheModuleGraph\(dependency, cache, visited\)/);
  assert.match(worker, /for \(const moduleUrl of FIREBASE_MODULES\) await cacheModuleGraph/);
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
  assert.match(html, /href="images\/Objectives\.png"[^>]*target="_blank"/);
  assert.match(html, /alt="TEP Scavenger Hunt Objectives"/);
  assert.match(app, /'leaderboard','objectives','admin','about'/);
  assert.match(worker, /'\.\/images\/Objectives\.png'/);
});
