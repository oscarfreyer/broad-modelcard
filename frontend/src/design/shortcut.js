// Platform label for the search shortcut (⌘K on Apple platforms, Ctrl K elsewhere).
const IS_APPLE_PLATFORM =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const SEARCH_SHORTCUT = IS_APPLE_PLATFORM ? '⌘K' : 'Ctrl K';
export const SEARCH_SHORTCUT_ARIA = IS_APPLE_PLATFORM ? 'Meta+K' : 'Control+K';
