import { useSyncExternalStore } from 'react';
import { profileStore } from './profile.js';

/**
 * The per-browser profile and its store; re-renders on every change, in
 * this tab or another.
 *
 * @returns {{ profile: ReturnType<ReturnType<typeof profileStore>['get']>, store: ReturnType<typeof profileStore> }}
 */
export default function useProfile() {
  const store = profileStore();
  const profile = useSyncExternalStore(store.subscribe, store.get, store.get);
  return { profile, store };
}
