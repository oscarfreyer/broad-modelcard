// Small LRU cache of resolved data-client responses, shared by every query
// hook of one client. Lets revisited views (a chapter, a lens, the atlas)
// render from memory without waiting for the adapter.

export function createQueryCache(limit = 64) {
  const entries = new Map();
  return {
    has(key) {
      return entries.has(key);
    },
    get(key) {
      if (!entries.has(key)) {
        return undefined;
      }
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) {
        entries.delete(entries.keys().next().value);
      }
      return value;
    }
  };
}
