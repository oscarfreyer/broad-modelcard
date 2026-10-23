// The shared version watch. Every open
// view (the catalogue, the atlas, and the live plugin panel) keeps in
// step with publishes and rollbacks made elsewhere by asking /meta for the
// live dataset version:
//
// - every 5 minutes while the page is visible, so a publish reaches an open
//   view well within the 15-minute target (D5);
// - at once when the window regains focus or the tab becomes visible again;
//   focus and visibilitychange usually fire together, so triggers within a
//   short gap of the last check are merged into one request;
// - never while a check is still running.
//
// The /meta read goes through the data client, so the browser revalidates it
// with its ETag and a 304 costs no body. When the version differs from the
// last one seen, `onChange` runs (views drop their cached responses and read
// again). No push channel: copy says "Updated <time>", never "live".
//
// Framework-free: the dependency-free plugin panel uses it directly
// (embed/panelController.js), the React views through app/useVersionWatch.js.

export const VERSION_POLL_MS = 5 * 60 * 1000;
/** Triggers closer than this to the last check start are merged into it. */
export const TRIGGER_GAP_MS = 2000;

/**
 * @param {object} options
 * @param {() => Promise<string>} options.readVersion resolves the live dataset version (e.g. getMeta's dataset_version)
 * @param {(version: string, previous: string) => void} [options.onChange] a different version than the last one seen
 * @param {(version: string, at: Date) => void} [options.onChecked] after every successful check
 * @param {() => void} [options.onTrigger] on every focus or visibility trigger (e.g. retry failed reads), before the check
 * @param {string|null} [options.knownVersion] the version on screen, if the view already knows it (no check on start then)
 * @param {boolean} [options.checkOnStart] check at once on start (default: when no version is known)
 * @param {number} [options.intervalMs]
 * @param {number} [options.gapMs]
 * @param {object} [options.env] window-like timers, events, and visibility (tests pass fakes)
 * @returns {{ start: () => void, stop: () => void, check: (reason?: string) => Promise<void>, setKnownVersion: (version: string|null) => void, knownVersion: () => string|null }}
 */
export function createVersionWatch({
  readVersion,
  onChange,
  onChecked,
  onTrigger,
  knownVersion = null,
  checkOnStart = knownVersion == null,
  intervalMs = VERSION_POLL_MS,
  gapMs = TRIGGER_GAP_MS,
  env = defaultEnv()
}) {
  let known = knownVersion;
  let inFlight = null;
  let lastStart = -Infinity;
  let timer = null;
  let running = false;

  const isVisible = () => !env.document || env.document.visibilityState !== 'hidden';

  async function check() {
    if (inFlight) {
      return inFlight;
    }
    lastStart = env.now();
    inFlight = (async () => {
      try {
        const version = await readVersion();
        if (!running || version == null) {
          return;
        }
        const previous = known;
        known = String(version);
        onChecked?.(known, new Date(env.now()));
        if (previous != null && previous !== known) {
          onChange?.(known, previous);
        }
      } catch {
        // A failed read shows on the page itself; the next trigger tries again.
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function trigger() {
    if (!running) return;
    onTrigger?.();
    if (inFlight || env.now() - lastStart < gapMs) {
      return;
    }
    check();
  }

  const onFocus = () => trigger();
  const onVisibility = () => {
    if (isVisible()) trigger();
  };
  const onTick = () => {
    // A hidden tab is checked when it becomes visible again, not in the background.
    if (running && isVisible()) check();
  };

  return {
    start() {
      if (running) return;
      running = true;
      env.addEventListener('focus', onFocus);
      env.document?.addEventListener('visibilitychange', onVisibility);
      timer = env.setInterval(onTick, intervalMs);
      if (checkOnStart) check();
    },
    stop() {
      running = false;
      env.removeEventListener('focus', onFocus);
      env.document?.removeEventListener('visibilitychange', onVisibility);
      if (timer != null) env.clearInterval(timer);
      timer = null;
    },
    check,
    setKnownVersion(version) {
      known = version == null ? null : String(version);
    },
    knownVersion: () => known
  };
}

function defaultEnv() {
  const win = typeof window === 'undefined' ? null : window;
  return {
    now: () => Date.now(),
    setInterval: (fn, ms) => win?.setInterval(fn, ms) ?? null,
    clearInterval: (id) => win?.clearInterval(id),
    addEventListener: (type, fn) => win?.addEventListener(type, fn),
    removeEventListener: (type, fn) => win?.removeEventListener(type, fn),
    document: typeof document === 'undefined' ? null : document
  };
}

const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** "Updated 14:05" for a check time; never "live". */
export function updatedText(at) {
  return at instanceof Date && !Number.isNaN(at.getTime()) ? `Updated ${TIME.format(at)}` : null;
}
