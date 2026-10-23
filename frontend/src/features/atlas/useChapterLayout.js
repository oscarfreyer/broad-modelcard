import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chapterQueryKey } from '../../api/queryKeys.js';
import useClientQuery from '../../api/useClientQuery.js';
import { buildChapterStructure } from './atlasStructure.js';
import { createLevel2LayoutClient } from './layout/level2LayoutClient.js';
import { createLevel2LayoutPayload, makeLevel2LayoutKey } from './layout/level2Layout.js';

const chapterPrefix = (chapterId) => chapterQueryKey(chapterId, null);
const layoutCacheKey = (chapterId, layoutMode, datasetVersion, population, ontology) =>
  `${makeLevel2LayoutKey(chapterId, layoutMode)}::${datasetVersion}${population ? `::${population}` : ''}${ontology ? `::${ontology}` : ''}`;

/**
 * The chapter drill-down: loads the chapter through the data client, then
 * computes its circle layout in a worker (the densest chapter packs in about
 * 30 ms). Layouts are cached per chapter, layout mode, and dataset version,
 * so revisits are immediate. A local population (contract v1.10) sizes the
 * circles by its own tiers, so it is part of both keys; while the chapter of
 * another population loads, the open chapter's last layout stays on screen.
 *
 * @param {string|null} chapterId the open chapter, or null at atlas level
 * @param {string} layoutMode
 * @param {string|null} [population] a local population id; null for the default prevalence
 * @param {string|null} [ontology] another classification than ICD-11 (contract v1.13); null for ICD-11
 */
export default function useChapterLayout(chapterId, layoutMode, population = null, ontology = null) {
  const chapterQuery = useClientQuery(
    chapterId ? chapterQueryKey(chapterId, population, ontology) : null,
    (dataClient, options) =>
      dataClient.getChapter({ chapterId, ...(population ? { population } : {}), ...(ontology ? { ontology } : {}) }, options)
  );
  const dataKey = chapterQuery.dataKey;
  const isSameChapter = Boolean(chapterId && dataKey && (dataKey === chapterPrefix(chapterId) || dataKey.startsWith(`${chapterPrefix(chapterId)}|`)));
  const chapter = isSameChapter ? chapterQuery.data : null;
  const chapterPopulation = chapter?.population?.id ?? null;
  const chapterOntology = chapter?.ontology?.id ?? null;
  const chapterStructure = useMemo(() => (chapter ? buildChapterStructure(chapter) : null), [chapter]);
  const layoutKey = chapter ? layoutCacheKey(chapterId, layoutMode, chapter.dataset_version, chapterPopulation, chapterOntology) : null;

  const layoutClientRef = useRef(null);
  const inFlightRef = useRef(new Set());
  const [models, setModels] = useState({});
  const [errors, setErrors] = useState({});

  useEffect(() => {
    layoutClientRef.current = createLevel2LayoutClient();
    return () => {
      layoutClientRef.current.terminate();
      layoutClientRef.current = null;
      inFlightRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!layoutKey || !chapterStructure || models[layoutKey] || errors[layoutKey] || inFlightRef.current.has(layoutKey)) {
      return;
    }
    inFlightRef.current.add(layoutKey);
    layoutClientRef.current
      .compute(createLevel2LayoutPayload(chapterStructure))
      .then(
        (model) => setModels((current) => ({ ...current, [layoutKey]: model })),
        (error) => setErrors((current) => ({ ...current, [layoutKey]: error?.message || 'Failed to prepare chapter view.' }))
      )
      .finally(() => inFlightRef.current.delete(layoutKey));
  }, [chapterStructure, errors, layoutKey, models]);

  const retry = useCallback(() => {
    if (chapterQuery.error) {
      chapterQuery.retry();
    }
    setErrors((current) => {
      const next = { ...current };
      delete next[layoutKey];
      return next;
    });
  }, [chapterQuery, layoutKey]);

  const model = layoutKey ? models[layoutKey] || null : null;
  const error = chapterQuery.error?.message || (layoutKey ? errors[layoutKey] : '') || '';
  return {
    model,
    conceptsById: chapterStructure?.conceptsById || null,
    isLoading: Boolean(chapterId) && !model && !error,
    error,
    retry
  };
}
