// The live panel's behaviour without the DOM: looks
// the case up when the inputs change, keeps one request in flight, and keeps
// the answer current through the shared version watch (shared/versionWatch.js,
// as the catalogue and the atlas): /meta every 5 minutes while visible and at
// once when the window regains focus or the tab becomes visible, one check at
// a time, and a fresh lookup when the dataset version changed, so a publish
// reaches an open panel within 15 minutes (D5, D6). A failed lookup is tried
// again on the next check. The element (BmcLivePanel.js) only renders states.
import { VERSION_POLL_MS, createVersionWatch } from '../shared/versionWatch.js';
import { inputsKey, lookupBody, missingInput } from './panelInputs.js';
import { panelViewModel } from './panelView.js';

/** The version check interval: the shared watch's, well inside the 15-minute freshness budget (D5). */
export const VERSION_CHECK_MS = VERSION_POLL_MS;

/** How long an answer for the previous case may stay on screen while the next loads. */
export const STALE_ANSWER_MS = 250;

/** The panel's error kind for a data client error (CONTRACT.md §3, §16, §19). */
export function errorKind(error) {
  if (!error) return 'failed';
  const code = error.code || '';
  if (code === 'backend_unavailable' || error.status === 0) return 'unavailable';
  if (code === 'local_only') return 'local_only';
  if (/^unknown_(?:model|use_case|configuration)$/.test(code)) return 'unknown_card';
  if (code === 'unknown_population') return 'unknown_population';
  // An older backend without POST /lookup (before contract v1.8).
  if (code === 'no_lookup' || (error.status === 404 && code === 'not_found') || error.status === 405) return 'no_lookup';
  if (error.status === 422 || error.status === 400) return 'invalid';
  return 'failed';
}

/**
 * The app's root URL for an API base: `/api/v1` → the page's origin, and
 * `https://host/app/api/v1` → `https://host/app/`. Card links (relative
 * `atlas.html?…`) resolve against it.
 */
export function appRootFor(apiBase, pageHref) {
  const absolute = new URL(`${apiBase.replace(/\/+$/, '')}/`, pageHref);
  absolute.pathname = absolute.pathname.replace(/api\/v1\/$/, '');
  absolute.search = '';
  absolute.hash = '';
  return absolute.href;
}

/** Resolves a relative card link against the app root; null for anything else than http(s). */
export function cardHref(url, appRoot) {
  if (!url) return null;
  try {
    const resolved = new URL(url, appRoot);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {(state: object) => void} options.onState called with every new state
 * @param {(apiBase: string) => { lookup?: Function, getMeta: Function }} options.createClient
 * @param {() => string} [options.pageHref] the host page's URL (for card links)
 * @param {() => Date} [options.now]
 * @param {{ setInterval: Function, clearInterval: Function }} [options.timers]
 * @param {EventTarget|null} [options.win] window (focus)
 * @param {Document|null} [options.doc] document (visibilitychange)
 * @param {number} [options.interval] version check interval in ms
 */
export function createPanelController({
  onState,
  createClient,
  pageHref = () => globalThis.location?.href ?? 'http://localhost/',
  now = () => new Date(),
  timers = globalThis,
  win = globalThis.window ?? null,
  doc = globalThis.document ?? null,
  interval = VERSION_CHECK_MS
}) {
  let inputs = null;
  let client = null;
  let clientBase = null;
  let injectedClient = null;
  let state = { phase: 'empty', inputs: null, view: null, missing: 'card', error: null, refreshing: false };
  let response = null;
  let shownKey = null;
  let shownVersion = null;
  let updatedAt = null;
  let controller = null;
  let pending = null;
  let staleTimer = null;
  let inflightKey = null;
  let connected = false;
  // Aborts the version check in flight when the panel leaves the page.
  let checks = null;
  // The live dataset version the last check saw (a staged panel compares with it).
  let lastLive = null;

  const emit = (next) => {
    state = { ...state, ...next };
    onState(state);
  };

  const clientFor = (apiBase) => {
    if (injectedClient) return injectedClient;
    if (!client || clientBase !== apiBase) {
      client = createClient(apiBase);
      clientBase = apiBase;
    }
    return client;
  };

  const viewFor = () =>
    response
      ? panelViewModel(response, { inputs, updatedAt, resolveHref: (url) => cardHref(url, appRootFor(inputs.apiBase, pageHref())) })
      : null;

  async function lookup({ force = false } = {}) {
    if (!inputs) return;
    const missing = missingInput(inputs);
    if (missing) {
      controller?.abort();
      response = null;
      shownKey = null;
      emit({ phase: 'empty', inputs, view: null, missing, error: null, refreshing: false });
      return;
    }
    const key = inputsKey(inputs);
    if (!force && key === shownKey && state.phase === 'ready') {
      // The case on screen; only the depth (or nothing) changed. A lookup for
      // another case still in flight is superseded by it: drop that one.
      if (controller && inflightKey !== key) {
        controller.abort();
        controller = null;
        inflightKey = null;
        timers.clearTimeout?.(staleTimer);
      }
      emit({ inputs, view: viewFor(), refreshing: Boolean(controller) });
      return;
    }
    if (!force && controller && key === inflightKey) {
      // This case is already being looked up; only the depth may differ.
      return;
    }
    controller?.abort();
    const request = new AbortController();
    controller = request;
    inflightKey = key;
    // The answer on screen stays while the next one loads (marked busy, with
    // "Updating"), so the panel does not flash; an answer for another case
    // gives way to the loading state if the lookup takes longer than a moment.
    timers.clearTimeout?.(staleTimer);
    if (response && state.phase === 'ready') {
      emit({ refreshing: true, inputs });
      if (key !== shownKey) {
        staleTimer = timers.setTimeout?.(() => {
          if (controller === request) {
            response = null;
            emit({ phase: 'loading', view: null, refreshing: false });
          }
        }, STALE_ANSWER_MS);
      }
    } else {
      response = null;
      emit({ phase: 'loading', inputs, view: null, error: null, refreshing: false });
    }
    const api = clientFor(inputs.apiBase);
    try {
      if (typeof api.lookup !== 'function') {
        throw Object.assign(new Error('The data client has no lookup operation.'), { code: 'no_lookup', status: 404 });
      }
      const answer = await api.lookup(lookupBody(inputs), { version: inputs.version, signal: request.signal });
      if (request.signal.aborted) return;
      timers.clearTimeout?.(staleTimer);
      response = answer;
      shownKey = key;
      shownVersion = answer?.dataset_version ?? null;
      // A live answer names the live version; a staged one ("staged:<id>")
      // does not, so the watch keeps the live version it read itself.
      if (shownVersion != null && isLive()) watch.setKnownVersion(shownVersion);
      updatedAt = now();
      emit({ phase: 'ready', view: viewFor(), error: null, refreshing: false, missing: null });
    } catch (error) {
      if (request.signal.aborted || error?.name === 'AbortError') return;
      timers.clearTimeout?.(staleTimer);
      response = null;
      shownKey = null;
      emit({ phase: 'error', view: null, error: { kind: errorKind(error), detail: error?.detail ?? null }, refreshing: false });
    } finally {
      if (controller === request) controller = null;
    }
  }

  /**
   * The watch's read: the live dataset version from /meta while an answer is
   * on screen (null otherwise: nothing to compare). A failed lookup is looked
   * up again instead, so coming back to the window retries it.
   */
  async function readVersion() {
    if (!connected || !inputs || missingInput(inputs)) return null;
    if (state.phase === 'error') {
      await lookup({ force: true });
      return null;
    }
    if (state.phase !== 'ready') return null;
    const meta = await clientFor(inputs.apiBase).getMeta({}, { version: 'live', signal: checks?.signal });
    return meta?.dataset_version ?? null;
  }

  /** The panel reads the live data (not a staged upload: `version="staged:<id>"`). */
  const isLive = () => (inputs?.version ?? 'live') === 'live';

  const watch = createVersionWatch({
    readVersion,
    // A new live version: the case is looked up again on it (a staged
    // preview follows live changes too, CONTRACT.md §2).
    onChange: () => {
      if (connected) lookup({ force: true });
    },
    // The same version: the answer on screen is confirmed ("Updated hh:mm").
    onChecked: (version) => {
      const same = isLive() ? version === String(shownVersion) : lastLive == null || version === lastLive;
      lastLive = version;
      if (connected && same && state.phase === 'ready') {
        updatedAt = now();
        emit({ view: viewFor() });
      }
    },
    // The first lookup names the version; no /meta read on connect.
    checkOnStart: false,
    intervalMs: interval,
    env: {
      now: () => now().getTime(),
      setInterval: (fn, ms) => timers.setInterval(fn, ms),
      clearInterval: (id) => timers.clearInterval(id),
      addEventListener: (type, fn) => win?.addEventListener?.(type, fn),
      removeEventListener: (type, fn) => win?.removeEventListener?.(type, fn),
      document: doc
    }
  });

  return {
    /** New inputs: looked up once per task, however many attributes changed. */
    setInputs(next) {
      inputs = next;
      if (pending) return;
      pending = Promise.resolve().then(() => {
        pending = null;
        if (connected) lookup();
      });
    },
    /** Use this client instead of one built from `api-base` (tests, the demo page). */
    setClient(next) {
      injectedClient = next ?? null;
      shownKey = null;
      if (connected && inputs) lookup({ force: true });
    },
    connect() {
      if (connected) return;
      connected = true;
      checks = new AbortController();
      watch.start();
      if (inputs && !pending) lookup({ force: true });
    },
    disconnect() {
      connected = false;
      controller?.abort();
      controller = null;
      inflightKey = null;
      checks?.abort();
      checks = null;
      watch.stop();
      timers.clearTimeout?.(staleTimer);
      // Nothing is in flight any more: an answer on screen is not "Updating".
      if (state.refreshing) emit({ refreshing: false });
    },
    /** One version check now (as on focus); resolves when it is done. */
    checkVersion: () => watch.check(),
    refresh: () => lookup({ force: true }),
    get state() {
      return state;
    }
  };
}
