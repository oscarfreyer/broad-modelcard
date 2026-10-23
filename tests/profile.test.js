// The per-browser profile: tracking survives a
// reload, the list exports and imports as a validated JSON file, unknown
// cards are kept but flagged, and refused storage never breaks the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TRACKED,
  PROFILE_KEY,
  cardId,
  createProfileStore,
  importMessage,
  isCardId,
  mergeImported,
  parseProfileFile,
  profileFile,
  unknownTracked
} from '../frontend/src/features/profile/profile.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    data
  };
}

const refusing = {
  getItem() {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem() {
    throw new DOMException('full', 'QuotaExceededError');
  }
};

test('card ids are <model_version>|<use_case>', () => {
  assert.equal(cardId('SynGPT-2.0', 'Discharge letter generation'), 'SynGPT-2.0|Discharge letter generation');
  assert.equal(cardId('', 'X'), null);
  assert.ok(isCardId('A|B'));
  for (const bad of ['A', 'A|B|C', '|B', 'A|', 'A\n|B', 42, null]) {
    assert.ok(!isCardId(bad), String(bad));
  }
});

test('a new browser gets a random profile id; tracking survives a reload', () => {
  const storage = memoryStorage();
  const first = createProfileStore({ storage, target: null });
  const id = first.get().profile_id;
  assert.match(id, /^p_[A-Za-z0-9]{8,}$/);
  assert.notEqual(createProfileStore({ storage: memoryStorage(), target: null }).get().profile_id, id);
  first.setTracked('SynGPT-2.0|CDSS', true);
  first.setTracked('MediCore-2.5|Discharge letter generation', true);
  first.setTracked('SynGPT-2.0|CDSS', false);
  first.setTracked('not a card id', true);
  assert.equal(first.isPersistent(), true);
  const stored = JSON.parse(storage.data.get(PROFILE_KEY));
  assert.deepEqual(stored, { version: 1, profile_id: id, tracked: ['MediCore-2.5|Discharge letter generation'], defaults: {} });

  // "Reload": a new store over the same storage.
  const reloaded = createProfileStore({ storage, target: null });
  assert.equal(reloaded.get().profile_id, id);
  assert.deepEqual(reloaded.get().tracked, ['MediCore-2.5|Discharge letter generation']);
  assert.ok(reloaded.isTracked('MediCore-2.5|Discharge letter generation'));
});

test('subscribers hear every change, and a change in another tab arrives through the storage event', () => {
  const storage = memoryStorage();
  const target = new EventTarget();
  const store = createProfileStore({ storage, target });
  let calls = 0;
  const unsubscribe = store.subscribe(() => {
    calls += 1;
  });
  store.setTracked('A|B', true);
  assert.equal(calls, 1);
  // Another tab writes the same key.
  const other = { ...store.get(), tracked: ['C|D'] };
  storage.setItem(PROFILE_KEY, JSON.stringify(other));
  const event = new Event('storage');
  event.key = PROFILE_KEY;
  target.dispatchEvent(event);
  assert.equal(calls, 2);
  assert.deepEqual(store.get().tracked, ['C|D']);
  unsubscribe();
  store.setTracked('E|F', true);
  assert.equal(calls, 2);
});

test('storage that is missing, refused, or corrupt never breaks the page', () => {
  for (const storage of [null, refusing, memoryStorage({ [PROFILE_KEY]: '{not json' }), memoryStorage({ [PROFILE_KEY]: '{"tracked":"A|B"}' })]) {
    const store = createProfileStore({ storage, target: null });
    assert.deepEqual(store.get().tracked, []);
    store.setTracked('A|B', true);
    assert.ok(store.isTracked('A|B'), 'tracking still works for the page lifetime');
  }
  assert.equal(createProfileStore({ storage: refusing, target: null }).isPersistent(), false);
});

test('the export file round-trips through import', () => {
  const storage = memoryStorage();
  const store = createProfileStore({ storage, target: null });
  store.setTracked('A|One', true);
  store.setTracked('B|Two', true);
  const file = store.exportFile(new Date('2026-10-12T10:00:00Z'));
  assert.equal(file.format, 'broad-modelcard-profile');
  assert.equal(file.format_version, 1);
  assert.equal(file.exported_at, '2026-10-12T10:00:00.000Z');
  assert.deepEqual(file.tracked, ['B|Two', 'A|One']);
  assert.match(file.note, /no patient data/i);

  // A fresh browser imports it and takes over the profile id.
  const fresh = createProfileStore({ storage: memoryStorage(), target: null });
  const result = fresh.importText(JSON.stringify(file));
  assert.equal(result.ok, true);
  assert.equal(result.unreadable, 0);
  assert.equal(result.added, 2);
  assert.equal(importMessage(result), 'Added 2 cards to your list.');
  assert.deepEqual(fresh.get().tracked, ['B|Two', 'A|One']);
  assert.equal(fresh.get().profile_id, store.get().profile_id);
});

test('import merges into a list that already has cards and keeps its id', () => {
  const profile = { version: 1, profile_id: 'p_localprofile1', tracked: ['A|One'], defaults: { lens: { age: 'Age 65+' } } };
  const merged = mergeImported(profile, {
    profileId: 'p_otherprofile1',
    tracked: ['B|Two', 'A|One'],
    defaults: { lens: { sex: 'Sex Female' }, depth: 'plain' }
  });
  assert.deepEqual(merged.tracked, ['A|One', 'B|Two']);
  assert.equal(merged.profile_id, 'p_localprofile1');
  assert.deepEqual(merged.defaults, { lens: { age: 'Age 65+' }, depth: 'plain' }, 'local defaults win');
});

test('import validation explains what is wrong and drops unreadable entries', () => {
  assert.match(parseProfileFile('not json').error, /not valid JSON/);
  assert.match(parseProfileFile('[1,2]').error, /not a Broad Modelcard list/);
  assert.match(parseProfileFile('{"format":"something-else","tracked":[]}').error, /not a Broad Modelcard list/);
  assert.match(parseProfileFile('{"format":"broad-modelcard-profile","format_version":2,"tracked":[]}').error, /newer version/);
  assert.match(parseProfileFile('{"format":"broad-modelcard-profile"}').error, /no list of tracked cards/);

  const parsed = parseProfileFile(JSON.stringify({ format: 'broad-modelcard-profile', format_version: 1, profile_id: 'bad id!', tracked: ['A|B', 'A|B', 7, 'no-pipe', 'C|D'] }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.tracked, ['A|B', 'C|D']);
  assert.equal(parsed.unreadable, 2, 'only entries that are not card ids are unreadable');
  assert.equal(parsed.duplicates, 1);
  assert.equal(parsed.overLimit, 0);
  assert.equal(parsed.profileId, null, 'a malformed id is not adopted');

  const many = parseProfileFile(JSON.stringify({ tracked: Array.from({ length: MAX_TRACKED + 20 }, (_, i) => `M${i}|F`) }));
  assert.equal(many.tracked.length, MAX_TRACKED);
  assert.equal(many.unreadable, 0, 'cards past the cap are not unreadable');
  assert.equal(many.overLimit, 20);

  // The store leaves the profile unchanged on a rejected file.
  const store = createProfileStore({ storage: memoryStorage(), target: null });
  store.setTracked('A|B', true);
  const before = store.get();
  assert.equal(store.importText('{').ok, false);
  assert.equal(store.get(), before);
});

test('the import message counts the cards the merge actually added', () => {
  const store = createProfileStore({ storage: memoryStorage(), target: null });
  const file = (tracked) => JSON.stringify({ format: 'broad-modelcard-profile', format_version: 1, tracked });

  // Duplicates are silent; only non-card entries are unreadable.
  const first = store.importText(file(['A|One', 'A|One', 'B|Two', 7, 'no-pipe']));
  assert.equal(first.added, 2);
  assert.equal(importMessage(first), 'Added 2 cards to your list; 2 unreadable entries were left out.');

  // Cards already in the list are not counted as added.
  const again = store.importText(file(['B|Two', 'C|Three']));
  assert.deepEqual([again.added, again.alreadyHad, again.notAdded], [1, 1, 0]);
  assert.equal(importMessage(again), 'Added 1 card to your list; 1 was already in it.');
  assert.equal(importMessage(store.importText(file(['A|One', 'C|Three']))), 'Every card in this file is already in your list.');
  assert.equal(importMessage(store.importText(file(['A|One']))), 'The card in this file is already in your list.');
  assert.equal(importMessage(store.importText(file([]))), 'No cards were added.');

  // A nearly full list takes what fits; the rest is reported, not called unreadable.
  const full = createProfileStore({ storage: memoryStorage(), target: null });
  full.importText(file(Array.from({ length: MAX_TRACKED - 2 }, (_, i) => `Old${i}|F`)));
  const capped = full.importText(file(['Old0|F', 'N1|F', 'N2|F', 'N3|F', 'N4|F']));
  assert.equal(full.get().tracked.length, MAX_TRACKED);
  assert.deepEqual([capped.added, capped.alreadyHad, capped.notAdded, capped.unreadable], [2, 1, 2, 0]);
  assert.equal(
    importMessage(capped),
    `Added 2 cards to your list; 1 was already in it; 2 cards were left out because the list holds at most ${MAX_TRACKED} cards.`
  );

  // A file over the cap on its own reports the cut cards too.
  const fresh = createProfileStore({ storage: memoryStorage(), target: null });
  const big = fresh.importText(file(Array.from({ length: MAX_TRACKED + 3 }, (_, i) => `M${i}|F`)));
  assert.deepEqual([big.added, big.notAdded, big.unreadable], [MAX_TRACKED, 3, 0]);

  assert.equal(importMessage(store.importText('{')), 'This file is not a Broad Modelcard list: it is not valid JSON.');
});

test('tracked cards the catalogue does not hold are kept but flagged, and can be removed', () => {
  const store = createProfileStore({ storage: memoryStorage(), target: null });
  store.importText(JSON.stringify({ tracked: ['Known|F', 'Gone|F', 'Renamed|G'] }));
  const missing = unknownTracked(store.get(), ['Known|F', 'Other|F']);
  assert.deepEqual(missing, ['Gone|F', 'Renamed|G']);
  assert.deepEqual(store.get().tracked, ['Known|F', 'Gone|F', 'Renamed|G'], 'kept until the user removes them');
  store.untrack(missing);
  assert.deepEqual(store.get().tracked, ['Known|F']);
  assert.deepEqual(profileFile(store.get()).tracked, ['Known|F']);
});
