import { useEffect, useRef, useState } from 'react';
import { UI_MODES } from '../features/navigation/navigationReducer.js';
import { navigationParams, restoreFromUrl } from '../features/navigation/urlNavigation.js';
import { atlasSearch, parseStartupParams, readableSearch } from './startupParams.js';

/**
 * Keeps the atlas URL in step with what is on screen, so a
 * copied URL reopens the same view, and restores the view from the URL.
 *
 * - At load, the URL's chapter, concept, and disease set are applied once the
 *   overview has loaded (a subtype waits for its chapter); until then, and
 *   until the AI system and function are known, the URL is left as it came.
 * - Changes are written with `history.replaceState`, except opening, leaving,
 *   or switching a chapter: that is a step of its own (`pushState`), so the
 *   browser's Back returns from a chapter to the atlas. Back and Forward
 *   restore the whole state of their entry through `onApply` and the
 *   navigation reducer's `restore`.
 *
 * @param {object} options
 * @param {ReturnType<typeof parseStartupParams>} options.startup the URL at load
 * @param {object} options.nav navigation state (navigationReducer.js)
 * @param {(action: object) => void} options.dispatch navigation dispatch
 * @param {{ model: string, useCase: string, view: string, lens: object, depth: string|null }|null} options.shown
 *   the rest of the state on screen, or null while it is not settled
 * @param {Record<string, object>|null} options.conceptsById overview concepts, null until loaded
 * @param {Record<string, object>|null} options.chapterConceptsById the open chapter's concepts, once loaded
 * @param {boolean} options.chapterFailed the open chapter could not be loaded
 * @param {(concept: object|undefined) => string|null} options.canonicalId
 * @param {Record<string, object|null>} options.firstConditionByChapterId a chapter's first condition, focused when a URL names the chapter
 * @param {(params: ReturnType<typeof parseStartupParams>) => void} options.onApply
 *   applies AI system, function, view, lens, mode, and depth of a URL (Back/Forward)
 */
export default function useAtlasUrlState({ startup, nav, dispatch, shown, conceptsById, chapterConceptsById, chapterFailed, canonicalId, firstConditionByChapterId, onApply }) {
  // What still has to be restored from the URL: `stage` 'start' waits for the
  // overview, 'chapter' for the open chapter's own concepts.
  const [pending, setPending] = useState(() => ({ target: startup, stage: 'start', chapterId: null }));
  const isMultimorbidity = nav.uiMode === UI_MODES.multimorbidity;

  useEffect(() => {
    if (pending?.stage !== 'start' || !conceptsById) {
      return;
    }
    const { action, waitForChapter } = restoreFromUrl(pending.target, { conceptsById, isMultimorbidity, canonicalId, firstConditionByChapterId });
    dispatch(action);
    setPending(waitForChapter ? { ...pending, stage: 'chapter', chapterId: waitForChapter } : null);
  }, [canonicalId, conceptsById, dispatch, firstConditionByChapterId, isMultimorbidity, pending]);

  useEffect(() => {
    if (pending?.stage !== 'chapter') {
      return;
    }
    if (nav.chapterId !== pending.chapterId || chapterFailed) {
      setPending(null);
      return;
    }
    if (chapterConceptsById) {
      dispatch(restoreFromUrl(pending.target, { conceptsById, chapterConceptsById, isMultimorbidity, canonicalId, firstConditionByChapterId }).action);
      setPending(null);
    }
  }, [canonicalId, chapterConceptsById, chapterFailed, conceptsById, dispatch, firstConditionByChapterId, isMultimorbidity, nav.chapterId, pending]);

  // Back and Forward: the entry's URL becomes the state again.
  const applyRef = useRef(onApply);
  applyRef.current = onApply;
  const writtenChapter = useRef(undefined);
  useEffect(() => {
    const onPopState = () => {
      const params = parseStartupParams(window.location.search);
      writtenChapter.current = undefined;
      applyRef.current(params);
      setPending({ target: params, stage: 'start', chapterId: null });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navParams = navigationParams(nav);
  const search =
    shown && !pending
      ? readableSearch(atlasSearch({ version: startup.version, ...shown, ...navParams }))
      : null;
  useEffect(() => {
    if (search === null) {
      return;
    }
    const url = `${window.location.pathname}${search}${window.location.hash}`;
    const isNewPlace = writtenChapter.current !== undefined && writtenChapter.current !== navParams.chapterId;
    writtenChapter.current = navParams.chapterId;
    if (url === `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      return;
    }
    try {
      if (isNewPlace) {
        window.history.pushState(null, '', url);
      } else {
        window.history.replaceState(window.history.state, '', url);
      }
    } catch {
      // Some browsers throttle history updates; the next change writes the URL again.
    }
  }, [navParams.chapterId, search]);
}
