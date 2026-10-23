// The shared version watch: /meta every 5
// minutes (well within the 15-minute target), at once on focus or when the
// tab becomes visible, one request when focus and visibilitychange fire
// together, nothing while hidden, and onChange only for a new version. Fake
// timers stand in for the clock; the app keeps its 5-minute interval.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVersionWatch, updatedText, VERSION_POLL_MS } from '../frontend/src/shared/versionWatch.js';

const SRC = new URL('../frontend/src/', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, SRC), 'utf8');

/** A window and document stand-in whose timers are node's mocked ones. */
function fakeEnv() {
  const target = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  return {
    env: {
      now: () => Date.now(),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id),
      addEventListener: (type, fn) => target.addEventListener(type, fn),
      removeEventListener: (type, fn) => target.removeEventListener(type, fn),
      document: doc
    },
    focus: () => target.dispatchEvent(new Event('focus')),
    show: () => {
      doc.visibilityState = 'visible';
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    hide: () => {
      doc.visibilityState = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
    }
  };
}

/** A /meta stand-in: counts reads, answers the current version. */
function fakeMeta(initial = '7') {
  const meta = { version: initial, reads: 0 };
  meta.read = async () => {
    meta.reads += 1;
    return meta.version;
  };
  return meta;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the app polls every 5 minutes, inside the 15-minute target', () => {
  assert.equal(VERSION_POLL_MS, 5 * 60 * 1000);
  assert.ok(VERSION_POLL_MS * 2 < 15 * 60 * 1000, 'even a missed tick stays within 15 minutes');
});

test('a periodic check picks up a publish within one interval; nothing runs while hidden', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { env, hide, show } = fakeEnv();
  const meta = fakeMeta('7');
  const changes = [];
  const watch = createVersionWatch({ readVersion: meta.read, onChange: (version, previous) => changes.push([previous, version]), env });
  watch.start();
  await settle();
  assert.equal(meta.reads, 1, 'the atlas learns the version on start');
  assert.equal(watch.knownVersion(), '7');

  meta.version = '8';
  t.mock.timers.tick(VERSION_POLL_MS - 1);
  await settle();
  assert.equal(meta.reads, 1, 'no check before the interval');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(meta.reads, 2);
  assert.deepEqual(changes, [['7', '8']], 'the new version arrives within 5 minutes');

  t.mock.timers.tick(VERSION_POLL_MS);
  await settle();
  assert.deepEqual(changes, [['7', '8']], 'an unchanged version calls nothing');

  hide();
  t.mock.timers.tick(VERSION_POLL_MS * 3);
  await settle();
  assert.equal(meta.reads, 3, 'a hidden tab is not polled');
  meta.version = '9';
  show();
  await settle();
  assert.equal(meta.reads, 4, 'becoming visible checks at once');
  assert.deepEqual(changes.at(-1), ['8', '9']);
  watch.stop();
  t.mock.timers.tick(VERSION_POLL_MS * 2);
  await settle();
  assert.equal(meta.reads, 4, 'a stopped watch is silent');
});

test('focus checks at once, and focus plus visibilitychange make one request', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { env, focus, show } = fakeEnv();
  const meta = fakeMeta('3');
  let triggers = 0;
  const changes = [];
  const watch = createVersionWatch({
    readVersion: meta.read,
    knownVersion: '3',
    onChange: (version) => changes.push(version),
    onTrigger: () => {
      triggers += 1;
    },
    env
  });
  watch.start();
  await settle();
  assert.equal(meta.reads, 0, 'a view that knows its version requests nothing on load');

  meta.version = '4';
  focus();
  show();
  await settle();
  assert.equal(meta.reads, 1, 'one request for both events');
  assert.equal(triggers, 2, 'each trigger still runs onTrigger (e.g. retry a failed read)');
  assert.deepEqual(changes, ['4']);

  // A while later, focus checks again at once, long before the next tick.
  t.mock.timers.tick(30 * 1000);
  meta.version = '5';
  focus();
  await settle();
  assert.equal(meta.reads, 2);
  assert.deepEqual(changes, ['4', '5']);
  watch.stop();
});

test('a check in flight is not doubled, and a failed read is tried again on the next trigger', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { env, focus } = fakeEnv();
  let release;
  let reads = 0;
  let fail = true;
  const watch = createVersionWatch({
    readVersion: () => {
      reads += 1;
      if (fail) return Promise.reject(new Error('backend down'));
      return new Promise((resolve) => {
        release = () => resolve('2');
      });
    },
    knownVersion: '1',
    env
  });
  watch.start();
  focus();
  await settle();
  assert.equal(reads, 1);
  fail = false;
  t.mock.timers.tick(5000);
  focus();
  t.mock.timers.tick(5000);
  focus();
  await settle();
  assert.equal(reads, 2, 'the second trigger waits for the check in flight');
  release();
  await settle();
  assert.equal(watch.knownVersion(), '2');
  watch.stop();
});

test('"Updated <time>" copy, never "live"; the views use the one shared watch', () => {
  assert.match(updatedText(new Date(Date.UTC(2026, 9, 12, 14, 5))), /^Updated \d{2}:\d{2}$/);
  assert.equal(updatedText(null), null);
  const atlas = read('app/AtlasApp.jsx');
  const catalogue = read('features/catalogue/CatalogueApp.jsx');
  for (const source of [atlas, catalogue]) {
    assert.match(source, /useVersionWatch\(/);
    assert.doesNotMatch(source, /useDataVersionWatch|useCatalogueFreshness/);
    assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /\blive monitoring\b/i);
  }
  // The catalogue requests nothing extra on load: it hands the watch its own version.
  assert.match(catalogue, /knownVersion: isPreview \? null : data\?\.dataset_version/);
  // A staged catalogue preview re-reads its upload and shows the ended band.
  assert.match(catalogue, /usePreview\(isPreview \?/);
  assert.match(catalogue, /<PreviewBanner preview=\{preview\} surface="catalogue" \/>/);
  assert.match(catalogue, /if \(isPreviewGone\)/);
  // The plugin panel uses the same watch, without React, and polls nothing of its own.
  const panel = read('embed/panelController.js');
  assert.match(panel, /import \{ VERSION_POLL_MS, createVersionWatch \} from '\.\.\/shared\/versionWatch\.js'/);
  assert.doesNotMatch(panel, /addEventListener\('focus'|visibilitychange'|from 'react'/);
});
