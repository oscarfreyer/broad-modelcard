// The per-browser profile: a random profile id,
// the tracked cards ("My systems"), and defaults ("Your defaults": a card, a
// demographic lens, the explanation depth, and from S6 a local population;
// normalizeDefaults lists them). It lives in localStorage
// under one key and can be exported to and imported from a JSON file, so a
// list moves between browsers. The id is random so it can become an account
// id later. Storage may be missing or refuse access (private windows, blocked
// site data): every access is wrapped, and the profile then lives in memory
// for the page's lifetime.
import { isOntologyId, otherOntology } from '../../shared/ontology.js';

export const PROFILE_KEY = 'bmc.profile.v1';
export const PROFILE_FILE_FORMAT = 'broad-modelcard-profile';
export const PROFILE_FILE_VERSION = 1;
export const MAX_TRACKED = 500;

const CARD_ID = /^[^|\u0000-\u001f]{1,200}\|[^|\u0000-\u001f]{1,200}$/;
const PROFILE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const POPULATION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TEXT = /^[^\u0000-\u001f]{1,200}$/;
const DEPTHS = new Set(['plain', 'expert']);
// Audience presets (audience.js). Kept here as plain ids so the
// profile module stays free of the presets' copy.
const AUDIENCES = new Set(['clinician', 'patient', 'procurement', 'regulator', 'payer']);
const LENS_AXES = ['age', 'sex', 'ethnicity'];

/** `<model_version>|<use_case>`, the id a tile and the atlas share (CONTRACT.md §17). */
export function cardId(modelVersion, useCase) {
  return modelVersion && useCase ? `${modelVersion}|${useCase}` : null;
}

export function isCardId(value) {
  return typeof value === 'string' && CARD_ID.test(value);
}

export function newProfileId(random = globalThis.crypto) {
  if (random?.randomUUID) {
    return `p_${random.randomUUID().replace(/-/g, '')}`;
  }
  return `p_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function emptyProfile(profileId = newProfileId()) {
  return { version: 1, profile_id: profileId, tracked: [], defaults: {} };
}

function uniqueCardIds(values) {
  return [...new Set(values.filter(isCardId))].slice(0, MAX_TRACKED);
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && TEXT.test(value);

/**
 * The defaults a profile may hold, each optional:
 * - `card`: `{ model, useCase }`, the card the atlas opens when its URL names none;
 * - `lens`: `{ age, sex, ethnicity }`, only the axes that are not "All …";
 * - `depth`: 'plain' or 'expert';
 * - `population`: a local population id (contract v1.10);
 * - `ontology`: the classification, another ontology than ICD-11 (contract v1.13);
 * - `audience`: 'clinician', 'patient', 'procurement', 'regulator', or 'payer' (audience.js).
 * Anything else, and any malformed value, is dropped, so an old or edited
 * profile never breaks the page. Values the data no longer offers are
 * checked where they are used (the atlas falls back to its own defaults).
 *
 * @returns {{ card?: { model: string, useCase: string }, lens?: Record<string, string>, depth?: 'plain'|'expert', population?: string, ontology?: string, audience?: 'clinician'|'patient'|'procurement'|'regulator'|'payer' }}
 */
export function normalizeDefaults(raw) {
  if (!isObject(raw)) {
    return {};
  }
  const defaults = {};
  if (isObject(raw.card) && isText(raw.card.model) && isText(raw.card.useCase) && isCardId(cardId(raw.card.model, raw.card.useCase))) {
    defaults.card = { model: raw.card.model, useCase: raw.card.useCase };
  }
  if (isObject(raw.lens)) {
    const lens = Object.fromEntries(LENS_AXES.filter((axis) => isText(raw.lens[axis]) && !/^All /.test(raw.lens[axis])).map((axis) => [axis, raw.lens[axis]]));
    if (Object.keys(lens).length) {
      defaults.lens = lens;
    }
  }
  if (DEPTHS.has(raw.depth)) {
    defaults.depth = raw.depth;
  }
  if (typeof raw.population === 'string' && POPULATION_ID.test(raw.population)) {
    defaults.population = raw.population;
  }
  if (AUDIENCES.has(raw.audience)) {
    defaults.audience = raw.audience;
  }
  if (isOntologyId(raw.ontology) && otherOntology(raw.ontology)) {
    defaults.ontology = raw.ontology;
  }
  return defaults;
}

/** True when the profile holds at least one default. */
export function hasDefaults(defaults) {
  return Object.keys(normalizeDefaults(defaults)).length > 0;
}

/**
 * The defaults with a change applied: a key set to null (or to a value that
 * is not valid) is cleared, any other key replaces its value.
 *
 * @param {object} defaults
 * @param {{ card?: object|null, lens?: object|null, depth?: string|null, population?: string|null, ontology?: string|null, audience?: string|null }} patch
 */
export function withDefaultsPatch(defaults, patch) {
  const next = { ...normalizeDefaults(defaults) };
  Object.entries(patch ?? {}).forEach(([key, value]) => {
    if (value == null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  });
  return normalizeDefaults(next);
}

/**
 * A stored profile in its current shape, or null when it is not one. Since
 * release 0.5 phase Q5 it may carry `guide_seen: true` (the guide "How to read a card" was shown and closed in this browser). A profile without it reads exactly
 * as before, and the key is never exported. The retired `audience_asked`
 * (the first-visit role prompt) is dropped.
 */
export function normalizeProfile(raw) {
  if (!isObject(raw)) {
    return null;
  }
  if (!PROFILE_ID.test(raw.profile_id ?? '') || !Array.isArray(raw.tracked)) {
    return null;
  }
  const profile = { version: 1, profile_id: raw.profile_id, tracked: uniqueCardIds(raw.tracked), defaults: normalizeDefaults(raw.defaults) };
  if (raw.guide_seen === true) {
    profile.guide_seen = true;
  }
  return profile;
}

export function readProfile(storage) {
  try {
    const text = storage?.getItem(PROFILE_KEY);
    return text ? normalizeProfile(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

/** Saves the profile; false when storage refused it. */
export function writeProfile(storage, profile) {
  try {
    if (!storage) return false;
    storage.setItem(PROFILE_KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

/** The profile with one card tracked or not. Newly tracked cards come first. */
export function withTracked(profile, id, on) {
  if (!isCardId(id)) {
    return profile;
  }
  const rest = profile.tracked.filter((entry) => entry !== id);
  const tracked = on ? [id, ...rest].slice(0, MAX_TRACKED) : rest;
  return { ...profile, tracked };
}

/** The export file for a profile (what "Export list" saves). */
export function profileFile(profile, now = new Date()) {
  return {
    format: PROFILE_FILE_FORMAT,
    format_version: PROFILE_FILE_VERSION,
    exported_at: now.toISOString(),
    note: 'Cards tracked in Broad Modelcard ("My systems") and your defaults, saved from one browser. Contains no patient data.',
    profile_id: profile.profile_id,
    tracked: profile.tracked,
    defaults: normalizeDefaults(profile.defaults)
  };
}

/**
 * Reads an export file. Accepts the file `profileFile` writes (and, for
 * robustness, a bare stored profile). Unknown fields are ignored. Entries
 * that are not card ids are dropped and counted as `unreadable`; repeated
 * cards count as `duplicates`, and cards past MAX_TRACKED as `overLimit`.
 *
 * @param {string} text file content
 * @returns {{ ok: true, profileId: string|null, tracked: string[], defaults: object, unreadable: number, duplicates: number, overLimit: number } | { ok: false, error: string }}
 */
export function parseProfileFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not a Broad Modelcard list: it is not valid JSON.' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'This file is not a Broad Modelcard list.' };
  }
  if (data.format !== undefined && data.format !== PROFILE_FILE_FORMAT) {
    return { ok: false, error: 'This file is not a Broad Modelcard list.' };
  }
  if (data.format_version !== undefined && data.format_version > PROFILE_FILE_VERSION) {
    return { ok: false, error: 'This list was saved by a newer version of Broad Modelcard.' };
  }
  if (!Array.isArray(data.tracked)) {
    return { ok: false, error: 'This file has no list of tracked cards.' };
  }
  const readable = data.tracked.filter(isCardId);
  const unique = [...new Set(readable)];
  const tracked = unique.slice(0, MAX_TRACKED);
  const defaults = normalizeDefaults(data.defaults);
  return {
    ok: true,
    profileId: PROFILE_ID.test(data.profile_id ?? '') ? data.profile_id : null,
    tracked,
    defaults,
    unreadable: data.tracked.length - readable.length,
    duplicates: readable.length - unique.length,
    overLimit: unique.length - tracked.length
  };
}

/**
 * Merges an imported list into the profile: the imported cards join the
 * tracked ones (nothing is removed). A browser that tracks nothing yet takes
 * over the file's profile id, so one person keeps one id across browsers.
 * The file's defaults fill the defaults this browser does not have yet; a
 * default set here is kept.
 */
export function mergeImported(profile, imported) {
  const adoptId = profile.tracked.length === 0 && imported.profileId;
  return {
    ...profile,
    profile_id: adoptId ? imported.profileId : profile.profile_id,
    tracked: uniqueCardIds([...profile.tracked, ...imported.tracked]),
    defaults: normalizeDefaults({ ...normalizeDefaults(imported.defaults), ...normalizeDefaults(profile.defaults) })
  };
}

/**
 * What an import did to the list: cards `added`, cards the list `alreadyHad`,
 * and new cards `notAdded` because the list would pass MAX_TRACKED.
 *
 * @param {{ tracked: string[] }} before the profile before the import
 * @param {{ tracked: string[] }} after the profile after `mergeImported`
 * @param {{ tracked: string[], overLimit: number }} imported a parsed file
 */
export function importOutcome(before, after, imported) {
  const had = new Set(before.tracked);
  const kept = new Set(after.tracked);
  const fresh = imported.tracked.filter((id) => !had.has(id));
  const added = fresh.filter((id) => kept.has(id)).length;
  const beforeDefaults = normalizeDefaults(before.defaults);
  const afterDefaults = normalizeDefaults(after.defaults);
  return {
    added,
    alreadyHad: imported.tracked.length - fresh.length,
    notAdded: fresh.length - added + imported.overLimit,
    defaultsAdded: Object.keys(afterDefaults).filter((key) => !(key in beforeDefaults)).length
  };
}

const count = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * The line shown after an import. Duplicates within the file are not
 * mentioned: they change nothing.
 *
 * @param {ReturnType<ReturnType<typeof createProfileStore>['importText']>} result
 */
export function importMessage(result) {
  if (!result.ok) {
    return result.error;
  }
  const { added, alreadyHad, notAdded, unreadable, defaultsAdded = 0 } = result;
  let lead;
  if (added > 0) {
    lead = `Added ${count(added, 'card', 'cards')} to your list`;
  } else if (defaultsAdded > 0 && alreadyHad === 0 && notAdded === 0) {
    lead = 'No cards were in this file';
  } else if (alreadyHad > 0 && notAdded === 0) {
    lead = alreadyHad === 1 ? 'The card in this file is already in your list' : 'Every card in this file is already in your list';
  } else {
    lead = 'No cards were added';
  }
  const notes = [];
  if (added > 0 && alreadyHad > 0) {
    notes.push(`${count(alreadyHad, 'was', 'were')} already in it`);
  }
  if (notAdded > 0) {
    notes.push(`${count(notAdded, 'card was', 'cards were')} left out because the list holds at most ${MAX_TRACKED} cards`);
  }
  if (unreadable > 0) {
    notes.push(`${count(unreadable, 'unreadable entry was', 'unreadable entries were')} left out`);
  }
  if (defaultsAdded > 0) {
    notes.push(`${count(defaultsAdded, 'default was', 'defaults were')} taken over from the file`);
  }
  return `${lead}${notes.length ? `; ${notes.join('; ')}` : ''}.`;
}

/** Tracked cards the catalogue does not hold (removed or renamed); kept, but flagged. */
export function unknownTracked(profile, knownCardIds) {
  const known = knownCardIds instanceof Set ? knownCardIds : new Set(knownCardIds);
  return profile.tracked.filter((id) => !known.has(id));
}

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * A profile store over one storage: read once, saved on every change, and
 * shared by every component through subscribe (useProfile.js). Changes made
 * in another tab arrive through the `storage` event.
 *
 * @param {{ storage?: Storage|null, target?: EventTarget|null }} [options]
 */
export function createProfileStore({ storage = browserStorage(), target = globalThis.window ?? null } = {}) {
  let profile = readProfile(storage);
  let persisted = Boolean(profile);
  if (!profile) {
    profile = emptyProfile();
    persisted = writeProfile(storage, profile);
  }
  const listeners = new Set();
  const emit = () => listeners.forEach((listener) => listener());
  const set = (next) => {
    if (next === profile) return;
    profile = next;
    persisted = writeProfile(storage, profile);
    emit();
  };

  target?.addEventListener?.('storage', (event) => {
    if (event.key !== PROFILE_KEY) return;
    const next = readProfile(storage);
    if (next) {
      profile = next;
      emit();
    }
  });

  return {
    get: () => profile,
    /** False when the browser refused storage: tracking lasts until the page closes. */
    isPersistent: () => persisted,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isTracked: (id) => profile.tracked.includes(id),
    setTracked: (id, on) => set(withTracked(profile, id, on)),
    untrack: (ids) => set({ ...profile, tracked: profile.tracked.filter((id) => !ids.includes(id)) }),
    /** Changes "Your defaults": a key set to null is cleared (withDefaultsPatch). */
    setDefaults: (patch) => set({ ...profile, defaults: withDefaultsPatch(profile.defaults, patch) }),
    clearDefaults: () => set({ ...profile, defaults: {} }),
    /** The guide "How to read a card" was shown and closed: it does not open by itself again. */
    markGuideSeen: () => {
      if (!profile.guide_seen) {
        set({ ...profile, guide_seen: true });
      }
    },
    /**
     * Merges a file into the list. The result says what the file held and
     * what the merge did with it (importOutcome); importMessage words it.
     *
     * @returns {(ReturnType<typeof parseProfileFile> & ReturnType<typeof importOutcome>) | { ok: false, error: string }}
     */
    importText(text) {
      const parsed = parseProfileFile(text);
      if (!parsed.ok) {
        return parsed;
      }
      const before = profile;
      const after = mergeImported(profile, parsed);
      set(after);
      return { ...parsed, ...importOutcome(before, after, parsed) };
    },
    exportFile: (now) => profileFile(profile, now)
  };
}

let sharedStore = null;

/** The page's one profile store. */
export function profileStore() {
  sharedStore ??= createProfileStore();
  return sharedStore;
}
