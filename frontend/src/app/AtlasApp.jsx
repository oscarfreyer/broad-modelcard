import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useDataClient } from '../api/DataClientProvider.jsx';
import { conceptMetricsQuery, conceptSubgroupsQuery, subgroupSummaryQuery } from '../api/queryKeys.js';
import useClientQuery from '../api/useClientQuery.js';
import Icon from '../design/Icon.jsx';
import StaticDemoBand from '../design/StaticDemoBand.jsx';
import { DEFAULT_STATUS_BANDS } from '../design/rangeScale.js';
import { subchapterCore, hasIntendedUseStatement, isSafetyView, ringStatus, viewLabel } from '../design/status.js';
import { buildAtlasStructure, canonicalConditionId, conceptPathLabel } from '../features/atlas/atlasStructure.js';
import { ATLAS_LAYOUT_MODES, buildLevelOneModel } from '../features/atlas/layout/atlasLayout.js';
import RingPane from '../features/atlas/RingPane.jsx';
import useChapterLayout from '../features/atlas/useChapterLayout.js';
import { safetyTallies } from '../features/atlas/safetyTally.js';
import useMetricMap from '../features/atlas/useMetricMap.js';
import { downloadConceptCardJson, downloadConceptCardPdf } from '../features/details/conceptCardExport.js';
import DetailCard from '../features/details/DetailCard.jsx';
import useBuiltOn from '../features/details/useBuiltOn.js';
import { evidenceAgeContext } from '../features/details/copy/evidenceAgeCopy.js';
import CombinationPanel from '../features/multimorbidity/CombinationPanel.jsx';
import useMultimorbidity from '../features/multimorbidity/useMultimorbidity.js';
import {
  UI_MODES,
  escapeAction,
  initialNavigationState,
  navigationReducer,
  selectedTileIds
} from '../features/navigation/navigationReducer.js';
import { uiModeFromParam } from '../features/navigation/urlNavigation.js';
import SearchPalette from '../features/search/SearchPalette.jsx';
import { searchResultStatus } from '../features/search/searchMarks.js';
import useConceptSearch from '../features/search/useConceptSearch.js';
import InterpretationRow from '../features/search/InterpretationRow.jsx';
import usePlainSearch from '../features/search/usePlainSearch.js';
import SummaryPanel from '../features/summary/SummaryPanel.jsx';
import { systemDetails } from '../features/summary/systemDetails.js';
import useRingSummary, { chapterName } from '../features/summary/useRingSummary.js';
import useAudienceSummary from '../features/summary/useAudienceSummary.js';
import GuideSheet from '../features/guide/GuideSheet.jsx';
import { shouldShowGuide } from '../features/guide/guideCopy.js';
import PreviewBanner from '../features/preview/PreviewBanner.jsx';
import { adminHref, changedConceptIds, liveComparisonFilters, previewEndedReason, previewedPopulationId } from '../features/preview/previewModel.js';
import usePreview from '../features/preview/usePreview.js';
import Toolbar from '../features/toolbar/Toolbar.jsx';
import AppHeader from '../design/AppHeader.jsx';
import DefaultsSheet from '../features/profile/DefaultsSheet.jsx';
import { audiencePreset } from '../features/profile/audience.js';
import useProfile from '../features/profile/useProfile.js';
import OverviewSheet from '../features/details/OverviewSheet.jsx';
import { defaultDepth } from './profileDefaults.js';
import { lensOfFilters, resultPopulationLabel, resultPopulationSlug } from '../shared/resultPopulation.js';
import { downloadBlob, downloadJson } from '../shared/download.js';
import { cardRecordFilename } from '../features/summary/cardRecord.js';
import { IS_STATIC_BUILD } from '../shared/staticBuild.js';
import { staticSettingNotice, storesSetting } from '../shared/careSetting.js';
import { cardIdOf, compareHref, urlDepth } from '../features/compare/compareState.js';
import { systemName } from '../shared/aiSystem.js';
import { displayUseCase } from '../shared/format.js';
import { atlasTitle } from './atlasTitle.js';
import { parseStartupParams } from './startupParams.js';
import useAtlasUrlState from './useAtlasUrlState.js';
import { updatedText } from '../shared/versionWatch.js';
import { populationFallbackText } from '../shared/localPopulation.js';
import { ICD11 } from '../shared/ontology.js';
// Every mode opens in plain words; Expert is one switch away on the card.
import { DEFAULT_DEPTH } from '../shared/depth.js';
import useModelSelection from './useModelSelection.js';
import useVersionWatch from './useVersionWatch.js';

const CHAPTER_LAYOUT_MODE = 'Modelcard';
const EMPTY_STRUCTURE = buildAtlasStructure(null);
const NO_CONCEPTS = Object.freeze({});
const NO_ROWS = new Map();
const LOAD_HINT = 'Check that the backend is running (npm run dev starts it), then try again.';
const NO_STARTUP = Object.freeze(parseStartupParams(''));
const PREVIEW_GONE = new Set(['upload_not_valid', 'unknown_upload']);

/** This page without the preview: the live atlas on the same AI system and view. */
function liveAtlasHref() {
  const params = new URLSearchParams(window.location.search);
  params.delete('version');
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ''}`;
}

/** What the ring pane says instead of the ring when it cannot show data. */
function paneErrorFor({ loadFailure, preview, retryAll }) {
  if (preview && (preview.phase === 'ended' || preview.phase === 'missing')) {
    return {
      title: 'This preview has ended',
      message: preview.phase === 'missing' ? previewEndedReason(null) : previewEndedReason(preview.upload),
      links: [
        { href: liveAtlasHref(), label: 'Open the live atlas' },
        { href: adminHref(preview.upload), label: 'Back to the update' }
      ]
    };
  }
  if (preview?.phase === 'checking') {
    return { title: 'This update is still being checked', message: previewEndedReason(preview.upload), onRetry: preview.refresh };
  }
  if (!loadFailure) {
    return null;
  }
  if (loadFailure.code === 'static_unavailable') {
    // The static demo for GitHub Pages did not record this read; retrying cannot help.
    return { title: loadFailure.title, message: loadFailure.detail };
  }
  if (loadFailure.code === 'backend_unavailable') {
    return {
      title: 'The backend is not running',
      message: 'The atlas reads its data from the Broad Modelcard backend on this computer, and it did not answer.',
      hint: 'Start the app from the project folder with this command; it starts the backend too. The page tries again when you come back to it.',
      command: 'npm run dev',
      onRetry: retryAll
    };
  }
  if (preview && PREVIEW_GONE.has(loadFailure.code)) {
    return { title: 'Checking the preview', message: 'The staged update could not be read. Checking whether it still exists.', onRetry: retryAll };
  }
  return { title: 'The atlas data could not be loaded', message: loadFailure.message, hint: LOAD_HINT, onRetry: retryAll };
}

/** The notice for a failed export; the static demo has no exports and says so plainly. */
function exportFailure(what, error) {
  if (error?.code === 'static_unavailable') {
    return { tone: 'info', text: error.detail };
  }
  return { tone: 'error', text: `The ${what} export failed: ${error.message}` };
}

/** Where a chapter circle grows from: its sector's middle, in % of the ring. */
function entranceFor(chapterId, regions) {
  const region = regions.find((entry) => entry.concept_id === chapterId);
  if (!region) {
    return { chapterId, x: 50, y: 50 };
  }
  const angle = (region.startAngle + region.endAngle) / 2;
  return { chapterId, x: 50 + Math.sin(angle) * 28, y: 50 - Math.cos(angle) * 28 };
}

/**
 * The atlas workspace: one toolbar, the ring on the left, and the Summary,
 * result card, condition list, or combination on the right. Reads data only
 * through the data client.
 */
export default function AtlasApp({ startup = NO_STARTUP }) {
  const client = useDataClient();
  const preview = usePreview(startup.previewUploadId);
  const isPreview = Boolean(preview);
  // An ended preview (published, replaced, discarded) shows no staged data at all.
  const isPreviewGone = Boolean(preview && ['ended', 'missing', 'checking'].includes(preview.phase));
  const selection = useModelSelection({
    model: startup.model,
    useCase: startup.useCase,
    lens: startup.lens,
    setting: startup.setting,
    population: startup.population,
    ontology: startup.ontology
  });
  const { filters } = selection;
  // The local population every read names (contract v1.10): set once /meta
  // lists it; null for the default prevalence. While a chosen one is not yet
  // confirmed, the prevalence-dependent reads wait instead of loading the
  // default first.
  const readPopulation = selection.activePopulation?.id ?? null;
  const isPopulationReady = !selection.population || Boolean(selection.activePopulation);
  // The local population of the filters on screen, named by every view that uses it.
  const shownPopulation = filters?.population ? selection.activePopulation : null;
  const populationKey = readPopulation ? `|population:${readPopulation}` : '';
  // The classification (contract v1.13, CONTRACT.md §23): ICD-11, or another
  // ontology the data holds, whose conditions show the ICD-11 result they map
  // to. Its reads wait until /meta lists it; null reads ICD-11.
  const readOntology = selection.readOntology;
  const isOtherOntology = selection.ontology !== ICD11;
  const isAtlasReady = isPopulationReady && selection.isOntologyReady;
  const ontologyKey = readOntology ? `|ontology:${readOntology}` : '';
  // The AI system and function on screen, in the UI's words (CONTRACT.md "Vocabulary").
  const shownEntry = filters ? selection.entries.find((entry) => entry.model_version === filters.model) ?? null : null;
  const shownFunction = shownEntry?.use_cases.find((entry) => entry.use_case === filters.useCase) ?? null;
  const systemLabel = filters ? systemName(shownEntry, filters.model) : null;
  const system = useMemo(() => systemDetails(shownEntry, shownFunction, selection.entries), [selection.entries, shownEntry, shownFunction]);
  // The developer's narrow model card (contract v1.13, §26): not in the static demo.
  const narrowCardModel = IS_STATIC_BUILD ? null : shownEntry?.model_version ?? null;
  const narrowCard = useClientQuery(narrowCardModel ? `narrow-card|${narrowCardModel}` : null, (dataClient, options) =>
    dataClient.getNarrowModelCard({ modelVersion: narrowCardModel }, options)
  ).data?.narrow_model_card ?? null;
  const statusBands = selection.statusBands ?? DEFAULT_STATUS_BANDS;
  // A card without an intended-use statement (contract v1.11) has no Intended
  // use view and never reads Out of scope.
  const hasIntendedUse = hasIntendedUseStatement(shownFunction);
  const scoreWeights = hasIntendedUse ? selection.overallScoreWeights : selection.overallScoreWeightsWithoutIntendedUse;
  const [nav, dispatch] = useReducer(navigationReducer, startup.mode, (mode) =>
    uiModeFromParam(mode) ? { ...initialNavigationState, uiMode: uiModeFromParam(mode) } : initialNavigationState
  );
  const [requestedViewId, setViewId] = useState(startup.view ?? 'overall');
  // A link to the Intended use view of a card without a statement opens Overview.
  const viewId = requestedViewId === 'intended_use' && shownFunction && !hasIntendedUse ? 'overall' : requestedViewId;
  useEffect(() => {
    if (viewId !== requestedViewId) {
      setViewId(viewId);
    }
  }, [requestedViewId, viewId]);
  const [depth, setDepth] = useState(() => startup.depth ?? DEFAULT_DEPTH);
  const [notice, setNotice] = useState(null);
  // Below 1100px the results column is a bottom sheet; its grabber expands it.
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [isExportingDataset, setIsExportingDataset] = useState(false);
  const [isExportingCardRecord, setIsExportingCardRecord] = useState(false);
  const [isDefaultsOpen, setIsDefaultsOpen] = useState(false);
  const [isOverviewRuleOpen, setIsOverviewRuleOpen] = useState(false);
  // The reader's audience preset (audience.js), read live from the
  // profile: it decides which sections a condition card shows first.
  const { profile, store: profileStore } = useProfile();
  const audience = profile.defaults?.audience ?? null;
  // "Across groups" starts closed on every condition card and loads only once
  // opened: it is open for the condition it was opened on.
  const [acrossConceptId, setAcrossConceptId] = useState(null);
  const isAcrossOpen = acrossConceptId !== null && acrossConceptId === nav.selectedConceptId;
  // "How to read a card": once per browser on the first atlas visit, then from the legend.
  const [isGuideOpen, setIsGuideOpen] = useState(() => shouldShowGuide(profile, { isPreview: startup.version !== 'live' }));
  // A role chosen in Settings takes effect at once: its
  // preset depth, unless this browser keeps a depth default of its own.
  const shownAudience = useRef(audience);
  const ownDepth = profile.defaults?.depth ?? null;
  useEffect(() => {
    if (shownAudience.current === audience) return;
    shownAudience.current = audience;
    const preset = audiencePreset(audience);
    if (preset && !ownDepth) setDepth(preset.depth);
  }, [audience, ownDepth]);
  // A Summary card that names a subchapter, while it is hovered or focused (audit A20).
  const [hintGroupId, setHintGroupId] = useState(null);
  const isMultimorbidityMode = nav.uiMode === UI_MODES.multimorbidity;

  // Atlas structure and layouts (deterministic from concepts and prevalence).
  // The layout follows the population: its tiers size the bubbles (CONTRACT.md §13, §21).
  const overview = useClientQuery(isAtlasReady ? `overview${populationKey}${ontologyKey}` : null, (dataClient, options) =>
    dataClient.getAtlasOverview({ ...(readPopulation ? { population: readPopulation } : {}), ...(readOntology ? { ontology: readOntology } : {}) }, options)
  );
  // The classification of the structure on screen (while another loads, the last one stays).
  const structureOntology = overview.data ? overview.data.ontology?.id ?? null : null;
  const isStructureCurrent = Boolean(overview.data) && structureOntology === readOntology;
  const shownOntology = structureOntology ? selection.ontologies?.find((entry) => entry.id === structureOntology) ?? null : null;
  const structureCache = useRef(new WeakMap());
  const structure = useMemo(() => {
    if (!overview.data) {
      return EMPTY_STRUCTURE;
    }
    if (!structureCache.current.has(overview.data)) {
      structureCache.current.set(overview.data, buildAtlasStructure(overview.data));
    }
    return structureCache.current.get(overview.data);
  }, [overview.data]);
  // Subchapter bubbles; Multimorbidity picks conditions, so it draws one bubble per condition.
  const effectiveLayoutMode = isMultimorbidityMode ? ATLAS_LAYOUT_MODES[1] : ATLAS_LAYOUT_MODES[0];
  // Layouts per structure (one per prevalence: default or a local population)
  // and mode, so switching back to a prevalence seen before is immediate.
  const layoutCache = useRef(new WeakMap());
  const level1Model = useMemo(() => {
    if (!layoutCache.current.has(structure)) {
      layoutCache.current.set(structure, new Map());
    }
    const models = layoutCache.current.get(structure);
    const cached = models.get(effectiveLayoutMode);
    if (cached) {
      return cached;
    }
    const model = buildLevelOneModel({
      chapterConcepts: structure.chapterConcepts,
      blocksByChapterId: structure.blocksByChapterId,
      conditionsByBlockId: structure.topLevelConditionsByBlockId,
      conceptPrevalenceById: structure.conceptPrevalenceById,
      layoutMode: effectiveLayoutMode
    });
    models.set(effectiveLayoutMode, model);
    return model;
  }, [effectiveLayoutMode, structure]);
  const openChapterId = nav.level === 1 ? nav.chapterId : null;
  const chapter = useChapterLayout(isAtlasReady ? openChapterId : null, CHAPTER_LAYOUT_MODE, readPopulation, readOntology);
  const isChapterReady = Boolean(openChapterId && chapter.model && chapter.conceptsById);

  // Metrics for the ring: single-condition map, or multimorbidity display rows.
  const metricMap = useMetricMap(filters, openChapterId, !isMultimorbidityMode);
  const multimorbidity = useMultimorbidity(filters, nav.multimorbidityIds, openChapterId, isMultimorbidityMode);
  const rowsById = isMultimorbidityMode ? multimorbidity.displayRowsById : metricMap.rowsById;
  // A map is drawn only over the structure of its own classification (a switch loads both).
  const isMapReady = isMultimorbidityMode ? multimorbidity.isReady : metricMap.isReady && metricMap.ontology === structureOntology;

  // Preview: the same map from the live data, to ring every bubble that differs.
  // The previewed local population is compared with the default prevalence
  // (previewModel.js); another population on screen is read live as it is.
  const previewedPopulation = previewedPopulationId(preview?.upload);
  const liveFilters = useMemo(() => liveComparisonFilters(filters, previewedPopulation), [filters, previewedPopulation]);
  const liveMap = useMetricMap(liveFilters, openChapterId, isPreview && !isMultimorbidityMode, 'live');
  const liveCandidates = useMultimorbidity(liveFilters, nav.multimorbidityIds, openChapterId, isPreview && isMultimorbidityMode, 'live');
  const changedIds = useMemo(() => {
    if (!isPreview) {
      return null;
    }
    let changed = null;
    if (isMultimorbidityMode) {
      changed = multimorbidity.isCurrent && liveCandidates.isCurrent
        ? changedConceptIds(multimorbidity.displayRowsById, liveCandidates.displayRowsById)
        : null;
    } else {
      changed = metricMap.isCurrent && liveMap.isCurrent ? changedConceptIds(metricMap.rowsById, liveMap.rowsById) : null;
    }
    // A subchapter is ringed when it holds a changed condition, even if its rolled-up row did not change.
    if (changed) {
      Object.entries(structure.topLevelConditionsByBlockId).forEach(([blockId, conditions]) => {
        if (conditions.some((condition) => changed.has(condition.concept_id))) {
          changed.add(blockId);
        }
      });
    }
    return changed;
  }, [structure, isMultimorbidityMode, isPreview, liveCandidates.displayRowsById, liveCandidates.isCurrent, liveMap.isCurrent, liveMap.rowsById, metricMap.isCurrent, metricMap.rowsById, multimorbidity.displayRowsById, multimorbidity.isCurrent]);

  // A metrics or multimorbidity preview opens on its AI system and function.
  const previewTarget = preview?.upload?.target ?? null;
  const appliedPreviewTarget = useRef(false);
  // A local population preview opens with its population (the Data Library's link names it too).
  useEffect(() => {
    if (!previewTarget || appliedPreviewTarget.current) {
      return;
    }
    appliedPreviewTarget.current = true;
    if (previewTarget.population_id) {
      if (!startup.population) {
        selection.setPopulation(previewTarget.population_id);
      }
      return;
    }
    if (!startup.model && previewTarget.model_version) {
      selection.selectVariant({ model: previewTarget.model_version, useCase: previewTarget.use_case });
    }
  }, [previewTarget, selection, startup.model, startup.population]);

  // Subchapter bubbles carry a centre: the share of their weak conditions (Intended use: without a scope fit).
  const coresById = useMemo(() => {
    if (isMultimorbidityMode || nav.level !== 0 || effectiveLayoutMode !== ATLAS_LAYOUT_MODES[0] || !metricMap.isReady) {
      return null;
    }
    const cores = new Map();
    Object.entries(structure.topLevelConditionsByBlockId).forEach(([blockId, conditions]) => {
      const core = subchapterCore(conditions.map((condition) => metricMap.rowsById.get(condition.concept_id) ?? null), viewId, { hasIntendedUse });
      if (core) {
        cores.set(blockId, core);
      }
    });
    return cores;
  }, [effectiveLayoutMode, hasIntendedUse, isMultimorbidityMode, metricMap.isReady, metricMap.rowsById, nav.level, structure, viewId]);

  const chapterInfo = useMemo(() => {
    if (!isChapterReady) {
      return null;
    }
    const concepts = Object.values(chapter.conceptsById).filter((concept) => concept.level === 2);
    const blocksById = Object.fromEntries(
      Object.values(chapter.conceptsById).filter((concept) => concept.level === 1).map((block) => [block.concept_id, block])
    );
    return { id: openChapterId, concepts, blocksById };
  }, [chapter.conceptsById, isChapterReady, openChapterId]);

  // Safety view: how many of each subchapter's conditions are marked (hover card).
  const talliesById = useMemo(() => {
    if (!isSafetyView(viewId) || isMultimorbidityMode || !metricMap.isReady) {
      return null;
    }
    if (nav.level === 0) {
      return safetyTallies(structure.topLevelConditionsByBlockId, metricMap.rowsById);
    }
    if (!chapterInfo) {
      return null;
    }
    const byBlock = {};
    chapterInfo.concepts
      .filter((concept) => concept.depth_in_kind === 1 || concept.depth_in_kind == null)
      .forEach((concept) => {
        if (concept.parent_id) {
          (byBlock[concept.parent_id] ??= []).push(concept);
        }
      });
    return safetyTallies(byBlock, metricMap.rowsById);
  }, [chapterInfo, isMultimorbidityMode, metricMap.isReady, metricMap.rowsById, nav.level, structure, viewId]);
  // The summary follows the filters of the map on screen: the ring recolours
  // first, the summary's work never delays it, and the legend counts always
  // describe the colours shown.
  const shownFiltersRef = useRef(null);
  if (metricMap.isCurrent) {
    shownFiltersRef.current = filters;
  }
  const ringSummary = useRingSummary({
    filters: isMultimorbidityMode ? null : shownFiltersRef.current,
    viewId,
    structure,
    chapter: chapterInfo,
    chapterRows: metricMap.rowsById,
    chapterRowsReady: metricMap.isReady && metricMap.ontology === structureOntology,
    hasIntendedUse,
    withMapping: Boolean(structureOntology)
  });

  // The selected concept's card. While a new concept loads, the previous card
  // stays only if it is for the same concept (e.g. after a lens change).
  const detailsQuery = conceptMetricsQuery(isMultimorbidityMode ? null : filters, nav.selectedConceptId);
  const details = useClientQuery(detailsQuery?.key ?? null, (dataClient, options) => detailsQuery.fetch(dataClient, options));
  const currentDetails = detailsQuery && details.dataKey === detailsQuery.key ? details.data : null;
  const shownDetails =
    currentDetails ?? (nav.selectedConceptId && details.data?.concept?.concept_id === nav.selectedConceptId ? details.data : null);
  // A specific setting without a result for the condition (contract v1.14, §29): the card offers the
  // Any-setting result, read on demand through the data client and labelled; never substituted.
  const anySettingQuery = useMemo(
    () => (filters?.setting && nav.selectedConceptId && !isMultimorbidityMode ? conceptMetricsQuery({ ...filters, setting: null }, nav.selectedConceptId) : null),
    [filters, isMultimorbidityMode, nav.selectedConceptId]
  );
  // Across groups (contract v1.13, §24): one read per card and concept, with
  // no lens in its key, so switching to a group reuses it. The static demo
  // records it for the ICD-11 conditions and says so for other concepts (R7).
  const subgroupsQuery = isAcrossOpen && !isMultimorbidityMode ? conceptSubgroupsQuery(filters, nav.selectedConceptId) : null;
  const subgroups = useClientQuery(subgroupsQuery?.key ?? null, (dataClient, options) => subgroupsQuery.fetch(dataClient, options));
  const subgroupsState = useMemo(
    () => ({
      data: subgroupsQuery && subgroups.dataKey === subgroupsQuery.key ? subgroups.data : null,
      isLoading: Boolean(subgroupsQuery) && subgroups.dataKey !== subgroupsQuery.key && !subgroups.error,
      error: subgroups.error ?? null
    }),
    [subgroups.data, subgroups.dataKey, subgroups.error, subgroupsQuery?.key]
  );
  // The Summary's Across groups (contract v1.14, §24): one read per card and population while the
  // Summary is on screen; no lens or classification in its key, so neither switch reads it again.
  const isSummaryShown = !isMultimorbidityMode && !(nav.selectedConceptId && shownDetails) && !isPreviewGone;
  const groupSummaryQuery = isSummaryShown ? subgroupSummaryQuery(shownFiltersRef.current) : null;
  const groupSummaryRead = useClientQuery(groupSummaryQuery?.key ?? null, (dataClient, options) => groupSummaryQuery.fetch(dataClient, options));
  const shownLens = useMemo(() => lensOfFilters(filters), [filters]);
  // Who every result on screen is for: the lens, the prevalence, and another classification (§23).
  // Contract v1.14 (§29): a specific care setting is named after the group; Any setting is not.
  const shownSetting = filters?.setting ?? null;
  const resultFor = filters ? resultPopulationLabel(shownLens, shownPopulation, { ontology: shownOntology, setting: shownSetting }) : null;
  const chooseGroup = useCallback((lens) => selection.setLens(lens), [selection]);

  const toggleCondition = useCallback(
    (concept, shouldFocus = false) =>
      dispatch({ type: 'toggleMultimorbidity', canonicalId: canonicalConditionId(concept, structure), shouldFocus }),
    [structure]
  );
  const pathLabelFor = useCallback((concept) => conceptPathLabel(concept, structure), [structure]);
  const navigateToConcept = useCallback((concept) => {
    dispatch({
      type: 'navigateToConcept',
      concept,
      firstConditionId: structure.firstConditionByChapterId[concept.concept_id]?.concept_id ?? null,
      shouldFocus: true
    });
  }, [structure]);
  const toggleFoundCondition = useCallback((concept) => toggleCondition(concept, true), [toggleCondition]);
  const search = useConceptSearch({
    isMultimorbidityMode,
    population: readPopulation,
    ontology: readOntology,
    pathLabelFor,
    onNavigate: navigateToConcept,
    onToggleCondition: toggleFoundCondition
  });
  // Plain-language search (contract v1.14, §31): the palette reads its words as chips the
  // reader can remove and apply (ICD-11 only; Multimorbidity mode keeps its own search).
  const applyInterpretation = useCallback(
    (plan, { combine }) => {
      if (plan.card) selection.selectVariant(plan.card);
      selection.setLens(plan.lens);
      selection.setSetting(plan.setting);
      // The static demo holds a setting only for the cards that store it (release 0.5, Q9): it says so.
      if (IS_STATIC_BUILD && plan.setting) {
        const card = plan.card ?? (filters ? { model: filters.model, useCase: filters.useCase } : null);
        const entry = selection.entries.find((model) => model.model_version === card?.model)?.use_cases.find((useCase) => useCase.use_case === card?.useCase);
        if (!storesSetting(entry, plan.setting)) setNotice({ tone: 'info', text: staticSettingNotice(plan.setting) });
      }
      if (combine) {
        dispatch({ type: 'setUiMode', uiMode: UI_MODES.multimorbidity });
        dispatch({ type: 'restore', multimorbidityIds: [...new Set(plan.conditions.map((concept) => canonicalConditionId(concept, structure)).filter(Boolean))] });
      } else if (plan.conditions.length) {
        navigateToConcept(plan.conditions[0]);
      }
    },
    [filters, navigateToConcept, selection, structure]
  );
  const plainSearch = usePlainSearch({
    search,
    enabled: !isOtherOntology && !isMultimorbidityMode,
    entries: selection.entries,
    current: filters ? { model: filters.model, useCase: filters.useCase } : null,
    apply: applyInterpretation
  });
  // Each search result shows its mark as the ring would draw it (audit batch 3):
  // the atlas map holds every subchapter and top-level condition, and a subtype
  // shares its condition's result. In a chapter the atlas map is read once while
  // the palette is open (usually from the cache); never a request per result.
  // Multimorbidity mode shows no marks: what a condition adds depends on the
  // combination, which its candidate list and the ring already show.
  const atlasMapForSearch = useMetricMap(filters, null, search.isOpen && !isMultimorbidityMode && nav.level === 1);
  const searchAtlasRows = nav.level === 0 ? (metricMap.isCurrent ? metricMap.rowsById : null) : atlasMapForSearch.isCurrent ? atlasMapForSearch.rowsById : null;
  const searchChapterRows = nav.level === 1 && metricMap.isCurrent ? metricMap.rowsById : null;
  const searchStatusFor = useCallback(
    (concept) =>
      isMultimorbidityMode
        ? null
        : searchResultStatus(concept, { atlasRows: searchAtlasRows, chapterRows: searchChapterRows, chapterId: openChapterId }, viewId, {
            hasIntendedUse,
            ownRows: Boolean(readOntology)
          }),
    [hasIntendedUse, isMultimorbidityMode, openChapterId, readOntology, searchAtlasRows, searchChapterRows, viewId]
  );

  const handleUiModeChange = useCallback((uiMode) => {
    dispatch({ type: 'setUiMode', uiMode });
  }, []);

  const conceptsInView = nav.level === 1 ? (isChapterReady ? chapter.conceptsById : NO_CONCEPTS) : structure.conceptsById;
  const handleSelectTile = useCallback((tile) => {
    const concept = conceptsInView[tile?.concept_id];
    if (!concept) {
      return;
    }
    dispatch({ type: 'selectTile', tile, concept, canonicalId: canonicalConditionId(concept, structure) });
  }, [conceptsInView, structure]);
  const clearSelection = useCallback(() => dispatch({ type: 'clearSelection' }), []);
  const openChapter = useCallback((chapterId) => {
    dispatch({ type: 'openChapter', chapterId });
  }, []);
  const goBack = useCallback(() => {
    dispatch({ type: 'back' });
  }, []);
  const openHighlight = useCallback((targetId) => {
    if (nav.level === 0) {
      openChapter(targetId);
    } else {
      dispatch({ type: 'selectConcept', conceptId: targetId });
    }
  }, [nav.level, openChapter]);

  // Keyboard: ⌘K / Ctrl K opens search; Esc closes the card, then steps back.
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        search.open();
        return;
      }
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      const action = escapeAction(nav);
      if (action) {
        dispatch(action);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nav, search]);

  const handleExportDataset = useCallback(async () => {
    if (!filters) {
      return;
    }
    setIsExportingDataset(true);
    try {
      const blob = await client.exportDataset({ model: filters.model, useCase: filters.useCase, population: filters.population });
      const slug = resultPopulationSlug(null, shownPopulation);  // the dataset export holds every setting
      downloadBlob(`broad-modelcard-dataset${slug ? `-${slug}` : ''}.json`, blob);
    } catch (error) {
      setNotice(exportFailure('dataset', error));
    } finally {
      setIsExportingDataset(false);
    }
  }, [client, filters, shownPopulation]);

  // The card record (contract v1.14, CONTRACT.md §32.1): a small JSON of the card for operational systems.
  const handleExportCardRecord = useCallback(async () => {
    if (!filters) {
      return;
    }
    setIsExportingCardRecord(true);
    try {
      const record = await client.getCardRecord({ model: filters.model, useCase: filters.useCase });
      downloadJson(cardRecordFilename(filters.model, filters.useCase), record);
    } catch (error) {
      setNotice(exportFailure('card record', error));
    } finally {
      setIsExportingCardRecord(false);
    }
  }, [client, filters]);

  const handleExportConcept = useCallback(async (format) => {
    // Only the details read for the current filters: while a lens or card
    // switch refreshes the card, the previous read's incidents belong to the
    // previous filters, so the export waits (the buttons are disabled then).
    const conceptId = currentDetails?.concept?.concept_id;
    if (!filters || !conceptId) {
      return;
    }
    try {
      const conceptExport = await client.exportConcept({ ...filters, conceptId, audience: depth === 'expert' ? 'expert' : 'patient' });
      // The export operation carries no incidents or effects; the card's own read does (same filters).
      // Both name the local population they were read for (contract v1.10).
      // So do the public result beside a local one, and whether the card states an intended use; the
      // classification's entry gives its attribution.
      const extra = {
        incidents: currentDetails.incidents ?? [],
        effects: currentDetails.effects ?? [],
        population: conceptExport.population ?? currentDetails.population ?? null,
        hasIntendedUse,
        publicMetrics: currentDetails.public_metrics ?? null,
        ontologyEntry: shownOntology
      };
      if (format === 'pdf') {
        await downloadConceptCardPdf(conceptExport, extra);
      } else {
        downloadConceptCardJson(conceptExport, extra);
      }
    } catch (error) {
      setNotice(exportFailure(format.toUpperCase(), error));
    }
  }, [client, currentDetails, depth, filters, hasIntendedUse, shownOntology]);

  // Load failures; one retry re-runs every failed read.
  const loadFailure = selection.error || overview.error || metricMap.error || multimorbidity.error || ringSummary.error;
  const retryAll = () => {
    selection.retry();
    overview.retry();
    metricMap.retry();
    multimorbidity.retry();
    ringSummary.retry();
    preview?.refresh();
  };
  let paneError = paneErrorFor({ loadFailure, preview, retryAll });
  if (!paneError && openChapterId && chapter.error) {
    paneError = { title: 'This chapter could not be opened', message: chapter.error, hint: LOAD_HINT, onRetry: chapter.retry };
  }

  // The reader's audience summary (contract v1.14, §30.2): at atlas level, for the map on screen.
  const chapterLabels = useMemo(
    () => Object.fromEntries(structure.chapterConcepts.map((entry) => [entry.concept_id, chapterName(entry)])),
    [structure]
  );
  const audienceBlock = useAudienceSummary({
    audience,
    enabled: isSummaryShown && nav.level === 0 && !paneError,
    filters: shownFiltersRef.current,
    entry: shownEntry,
    functionEntry: shownFunction,
    system,
    resultFor,
    hasIntendedUse,
    chapterLabels
  });

  // A staged read that fails because the upload changed state: re-read the upload.
  const previewRefresh = preview?.refresh;
  const failedCode = loadFailure?.code ?? (details.error?.code === 'unknown_population' ? 'unknown_population' : null);
  useEffect(() => {
    if (previewRefresh && PREVIEW_GONE.has(failedCode)) {
      previewRefresh();
    }
  }, [failedCode, previewRefresh]);

  // A read named a local population the data no longer holds (removed
  // elsewhere): back to the default prevalence, with a notice. The selection
  // does the same when /meta stops listing it.
  const dropPopulation = selection.dropPopulation;
  useEffect(() => {
    if (failedCode === 'unknown_population') {
      dropPopulation();
    }
  }, [dropPopulation, failedCode]);
  // A shared link named a card the data does not hold: say what it asked for
  // and what is shown instead, as for an unknown population (audit B5).
  const substitution = selection.substitution;
  const clearSubstitution = selection.clearSubstitution;
  useEffect(() => {
    if (!substitution || !filters) {
      return;
    }
    const asked = [substitution.model, substitution.useCase ? displayUseCase(substitution.useCase) : null].filter(Boolean).join(', ');
    setNotice({
      tone: 'info',
      text: `This link asked for ${asked}, which this dataset does not hold. Showing ${systemLabel}, ${displayUseCase(filters.useCase)}, instead.`
    });
    clearSubstitution();
  }, [clearSubstitution, filters, substitution, systemLabel]);
  // The static demo records condition details for all patients only: say so where the card would open.
  const detailsGap = details.error?.code === 'static_unavailable' ? details.error.detail : null;
  useEffect(() => {
    if (detailsGap) {
      setNotice({ tone: 'info', text: detailsGap });
    }
  }, [detailsGap]);
  const dropped = selection.droppedPopulation;
  useEffect(() => {
    if (dropped) {
      setNotice({ tone: 'info', text: populationFallbackText(dropped) });
    }
  }, [dropped]);
  // A link or a default named a classification this data does not hold (contract v1.13).
  const droppedOntology = selection.droppedOntology;
  const clearDroppedOntology = selection.clearDroppedOntology;
  useEffect(() => {
    if (droppedOntology) {
      setNotice({ tone: 'info', text: `This data holds no classification "${droppedOntology}", so the atlas shows ICD-11.` });
      clearDroppedOntology();
    }
  }, [clearDroppedOntology, droppedOntology]);
  // Another classification has its own concept ids: a switch returns to its
  // atlas with nothing selected. Declared before the URL state, so a Back or
  // Forward across a switch resets first and then restores the entry.
  const lastOntology = useRef(selection.ontology);
  useEffect(() => {
    if (lastOntology.current !== selection.ontology) {
      lastOntology.current = selection.ontology;
      dispatch({ type: 'switchClassification' });
    }
  }, [selection.ontology]);
  // Combinations are stored in ICD-11 codes: Multimorbidity is ICD-11 only.
  useEffect(() => {
    if (isOtherOntology && nav.uiMode === UI_MODES.multimorbidity) {
      dispatch({ type: 'setUiMode', uiMode: UI_MODES.focused });
    }
  }, [isOtherOntology, nav.uiMode]);

  // Publishes and rollbacks made elsewhere reach this page within 5 minutes,
  // and at once when it regains focus (shared version watch); a
  // backend that was down is tried again then too.
  const retryRef = useRef(null);
  retryRef.current = loadFailure ? retryAll : null;
  useVersionWatch({
    onChange: (version) => {
      const updated = updatedText(new Date());
      setNotice({
        tone: 'info',
        text: isPreview
          ? `${updated}: the live data changed meanwhile; the preview now shows the update over it.`
          : `${updated}: the data is now dataset version ${version}, and the atlas shows it.`
      });
    },
    onTrigger: () => retryRef.current?.()
  });

  // "Compare with…": this card on the comparison page, with
  // the lens, setting, population, classification, depth, and open chapter on
  // screen. The comparison reads the live data, so a preview does not offer it;
  // the static demo records it (R7). Every compare link takes the same state.
  const compareStateHref = useCallback(
    (otherCards = []) =>
      filters && !isPreview
        ? compareHref({
            cards: [cardIdOf(filters.model, filters.useCase), ...otherCards],
            chapterId: openChapterId,
            lens: { age: filters.age, sex: filters.sex, ethnicity: filters.ethnicity },
            setting: filters.setting ?? null,
            population: filters.population ?? null,
            ontology: filters.ontology ?? null,
            depth: urlDepth(depth, defaultDepth(profile.defaults)),
            view: viewId
          })
        : null,
    [depth, filters, isPreview, openChapterId, profile.defaults, viewId]
  );
  const compareLink = compareStateHref();

  // "Compare with previous version" (contract v1.14, §28.2): this card beside
  // the matching card of the AI system it replaces, in the same state.
  const previousCard = system?.lineage?.previous ?? null;
  const previousCompareHref = previousCard ? compareStateHref([cardIdOf(previousCard.modelVersion, previousCard.useCase)]) : null;
  // Built on (contract v1.14): the base models' results at the condition on screen,
  // each with a link that puts this card beside the base card in the comparison.
  const builtOnCompareHref = useCallback((base) => compareStateHref([cardIdOf(base.version, base.choice.useCase)]), [compareStateHref]);
  const builtOn = useBuiltOn({
    entry: shownEntry,
    functionEntry: shownFunction,
    registry: selection.entries,
    filters: isMultimorbidityMode ? null : filters,
    conceptId: nav.selectedConceptId,
    compareHrefFor: builtOnCompareHref
  });
  // Evidence age (contract v1.14, §28.5): the card's configuration and earlier versions, for Study quality.
  const ageContext = useMemo(() => evidenceAgeContext(shownEntry, shownFunction, selection.entries), [selection.entries, shownEntry, shownFunction]);
  const { selectVariant } = selection;
  const openCard = useCallback((model, useCase) => selectVariant({ model, useCase }), [selectVariant]);

  // The URL holds the state on screen and restores it (shared links, Back and Forward).
  const canonicalId = useCallback((concept) => canonicalConditionId(concept, structure), [structure]);
  useAtlasUrlState({
    startup,
    nav,
    dispatch,
    shown: filters
      ? {
          model: filters.model,
          useCase: filters.useCase,
          view: viewId,
          lens: { age: filters.age, sex: filters.sex, ethnicity: filters.ethnicity },
          setting: filters.setting ?? null,
          population: filters.population ?? null,
          ontology: filters.ontology ?? null,
          depth: depth === DEFAULT_DEPTH ? null : depth
        }
      : null,
    conceptsById: isStructureCurrent ? structure.conceptsById : null,
    chapterConceptsById: openChapterId ? chapter.conceptsById : null,
    chapterFailed: Boolean(openChapterId && chapter.error),
    canonicalId,
    firstConditionByChapterId: structure.firstConditionByChapterId,
    onApply: (params) => {
      const uiMode = uiModeFromParam(params.mode) ?? UI_MODES.focused;
      if (params.model) {
        selection.selectVariant({ model: params.model, useCase: params.useCase ?? '' });
      }
      selection.setLens(params.lens);
      selection.setSetting(params.setting);
      selection.setPopulation(params.population);
      selection.setOntology(params.ontology);
      setViewId(params.view ?? 'overall');
      dispatch({ type: 'setUiMode', uiMode });
      setDepth(params.depth ?? DEFAULT_DEPTH);
    }
  });

  const tabTitle = atlasTitle({
    system: systemLabel,
    fn: filters ? displayUseCase(filters.useCase) : null,
    isPreview
  });
  useEffect(() => {
    document.title = tabTitle;
  }, [tabTitle]);

  // The ring.
  const openChapterConcept = openChapterId ? structure.conceptsById[openChapterId] : null;
  const showChapter = nav.level === 1 && isChapterReady;
  const ringModel = showChapter ? chapter.model : level1Model;
  const ringConcepts = showChapter ? chapter.conceptsById : structure.conceptsById;
  const ringScopeReady = (showChapter || nav.level === 0) && isMapReady;
  const selectedConcept = nav.selectedConceptId ? ringConcepts[nav.selectedConceptId] : null;
  const hasStructure = Boolean(overview.data);

  const legendCounts = ringScopeReady && !isMultimorbidityMode ? ringSummary.centre?.counts ?? null : null;
  const combination = isMultimorbidityMode
    ? { selectedCount: nav.multimorbidityIds.length, candidateCount: multimorbidity.candidateIds.length, hasData: selection.hasMultimorbidityData }
    : null;

  // The selection changes only with navigation; a stable list keeps the bubble layer memoized.
  const ringSelectedIds = useMemo(() => selectedTileIds(nav), [nav]);
  useEffect(() => {
    setHintGroupId(null);
  }, [openChapterId, nav.selectedConceptId]);

  const ring = hasStructure
    ? {
        viewModel: ringModel,
        conceptsById: ringConcepts,
        rowsById: ringScopeReady ? rowsById : NO_ROWS,
        coresById: ringScopeReady ? coresById : null,
        talliesById: ringScopeReady ? talliesById : null,
        changedIds: ringScopeReady ? changedIds : null,
        viewId,
        statusBands,
        isLoading: !ringScopeReady,
        isCombinationMode: isMultimorbidityMode,
        hasIntendedUse,
        resultFor: isMultimorbidityMode ? null : resultFor,
        isExpert: depth === 'expert',
        selectedTileIds: ringSelectedIds,
        selectedChapterId: nav.level === 1 && !showChapter ? openChapterId : null,
        selectedGroupId: showChapter && selectedConcept?.level === 1 ? selectedConcept.concept_id : null,
        highlightGroupId: showChapter ? hintGroupId : null,
        focusRequest: nav.focus,
        rim: showChapter ? { regions: level1Model.regions || [], currentChapterId: openChapterId, onOpenChapter: openChapter } : null,
        onSelectTile: handleSelectTile,
        onBackground: clearSelection,
        onOpenChapter: isMultimorbidityMode ? null : openChapter,
        label: showChapter
          ? `${chapterName(openChapterConcept)}: ${viewLabel(viewId)} by condition. Arrow keys move between bubbles, Enter selects.`
          : `${shownOntology?.name ?? 'ICD-11'} ring: ${viewLabel(viewId)} by ${effectiveLayoutMode === ATLAS_LAYOUT_MODES[0] ? 'subchapter' : 'condition'}. Arrow keys move between bubbles, Enter opens.`
      }
    : null;

  // The band counts changed top-level conditions in view (the unit of the admin's change summary).
  const changedCount = changedIds && ringScopeReady ? [...changedIds].filter((id) => structure.topLevelConditionIds.has(id)).length : null;

  const header = {
    title: nav.level === 1 ? chapterName(openChapterConcept) : 'All chapters',
    backLabel: 'All chapters',
    onBack: nav.level === 1 ? goBack : null,
    // The mode changes what the ring draws, so it sits on the ring tile (audit A10).
    mode: { value: nav.uiMode, onChange: handleUiModeChange },
    // The ring's centre holds nothing (the counts are in the legend tile): a
    // short state shows in the ring tile's header instead.
    status: paneError
      ? null
      : !hasStructure
        ? 'Loading'
        : nav.level === 1 && !showChapter && !isMultimorbidityMode
          ? 'Opening'
          : (isMultimorbidityMode ? !multimorbidity.isReady : metricMap.isLoading)
            ? 'Updating'
            : null
  };

  // Stable props for the memoized side column (the condition card, the Summary).
  const openDefaults = useCallback(() => setIsDefaultsOpen(true), []);
  const openOverviewRule = useCallback(() => setIsOverviewRuleOpen(true), []);
  const openGuide = useCallback(() => setIsGuideOpen(true), []);
  // Closing the guide at any step, or finishing it, is remembered: it does not open by itself again.
  const closeGuide = useCallback(() => {
    setIsGuideOpen(false);
    profileStore.markGuideSeen();
  }, [profileStore]);
  const toggleAcross = useCallback(() => setAcrossConceptId((open) => (open === nav.selectedConceptId ? null : nav.selectedConceptId)), [nav.selectedConceptId]);
  // A condition listed under the Summary's Across groups opens with its own Across groups section open.
  const openGroupCondition = useCallback(({ conceptId, chapterId }) => {
    const concept = structure.conceptsById[conceptId] ?? { concept_id: conceptId, chapter_id: chapterId, level: 2 };
    setAcrossConceptId(conceptId);
    dispatch({ type: 'navigateToConcept', concept, shouldFocus: true });
  }, [structure]);
  const groupSummary = useMemo(
    () => ({
      query: {
        data: groupSummaryQuery && groupSummaryRead.dataKey === groupSummaryQuery.key ? groupSummaryRead.data : null,
        error: groupSummaryRead.error ?? null
      },
      depth,
      classification: shownOntology ? shownOntology.name ?? shownOntology.id ?? 'other' : null,
      onOpenCondition: shownOntology ? null : openGroupCondition
    }),
    [depth, groupSummaryQuery?.key, groupSummaryRead.data, groupSummaryRead.dataKey, groupSummaryRead.error, openGroupCondition, shownOntology]
  );
  const subgroupRule = selection.subgroupDifference;
  const acrossGroups = useMemo(
    () => ({ isOpen: isAcrossOpen, onToggle: toggleAcross, query: subgroupsState, rule: subgroupRule, onChooseGroup: chooseGroup }),
    [chooseGroup, isAcrossOpen, subgroupRule, subgroupsState, toggleAcross]
  );
  // The static demo has no dataset export; it offers the recorded card record (release 0.5, Q9).
  const datasetExport = useMemo(
    () => ({
      onClick: IS_STATIC_BUILD ? null : handleExportDataset,
      isBusy: !IS_STATIC_BUILD && isExportingDataset,
      onCardRecord: handleExportCardRecord,
      isCardRecordBusy: isExportingCardRecord
    }),
    [handleExportCardRecord, handleExportDataset, isExportingCardRecord, isExportingDataset]
  );

  // The right column.
  let side;
  if (isPreviewGone) {
    side = null;
  } else if (isMultimorbidityMode) {
    side = (
      <CombinationPanel
        selection={nav.multimorbidityIds.map((id) => structure.conceptsById[id]).filter(Boolean)}
        combinationRow={multimorbidity.combinationRow}
        isLoadingRow={multimorbidity.isLoadingRow}
        singleRowsById={multimorbidity.singleRowsById}
        candidateCount={multimorbidity.candidateIds.length}
        candidates={multimorbidity.candidateIds
          .map((id) => structure.conceptsById[id])
          .filter(Boolean)
          .map((concept) => ({ concept, status: ringStatus(multimorbidity.displayRowsById.get(concept.concept_id) ?? null, viewId, { isCombinationMode: true, hasIntendedUse }) }))}
        onAdd={(concept) => toggleCondition(concept, true)}
        hasData={selection.hasMultimorbidityData}
        modelLabel={filters ? `${systemLabel} (${displayUseCase(filters.useCase)})` : 'This AI system'}
        alternatives={selection.multimorbidityVariants}
        onSwitch={selection.selectVariant}
        onRemove={(conceptId) => toggleCondition(structure.conceptsById[conceptId])}
        onBack={() => dispatch({ type: 'back' })}
        onReset={() => dispatch({ type: 'resetMultimorbidity' })}
        depth={depth}
        onDepthChange={setDepth}
        viewId={isSafetyView(viewId) ? 'overall' : viewId}
        statusBands={statusBands}
        overallScoreWeights={scoreWeights}
        hasIntendedUse={hasIntendedUse}
      />
    );
  } else if (nav.selectedConceptId && shownDetails) {
    side = (
      <DetailCard
        details={shownDetails}
        depth={depth}
        onDepthChange={setDepth}
        viewId={viewId}
        statusBands={statusBands}
        overallScoreWeights={scoreWeights}
        evidenceSignalWeights={selection.evidenceSignalWeights}
        studyAdjustments={selection.studyAdjustments}
        hasIntendedUse={hasIntendedUse}
        lens={shownLens}
        setting={shownSetting}
        anySettingQuery={anySettingQuery}
        audience={audience}
        acrossGroups={acrossGroups}
        onOpenOverviewRule={openOverviewRule}
        ageContext={ageContext}
        builtOn={builtOn}
        functionEntry={shownFunction}
        onClose={clearSelection}
        onExport={handleExportConcept}
        isRefreshing={!currentDetails}
      />
    );
  } else {
    side = (
      <SummaryPanel
        title={nav.level === 1 ? chapterName(openChapterConcept) : 'Summary'}
        highlights={(nav.level === 1 && !chapterInfo) || paneError ? null : ringSummary.highlights}
        isUnavailable={Boolean(paneError)}
        onOpen={openHighlight}
        onPreview={nav.level === 1 ? setHintGroupId : null}
        datasetExport={datasetExport}
        system={paneError ? null : system}
        onOpenSystem={selection.setModelVersion}
        onOpenCard={openCard}
        previousCompareHref={previousCompareHref}
        isExpert={depth === 'expert'}
        narrowCard={paneError ? null : narrowCard}
        population={shownPopulation}
        onOpenDefaults={openDefaults}
        resultFor={resultFor}
        groupSummary={paneError ? null : groupSummary}
        audienceSummary={nav.level === 0 ? audienceBlock : null}
        onOpenGuide={openGuide}
      />
    );
  }

  return (
    <div
      className={`app-shell${IS_STATIC_BUILD ? ' is-static' : ''}${isPreview ? ' is-preview' : ''}${isPreviewGone ? ' is-preview-ended' : ''}`}
      data-mode={nav.uiMode}
    >
      {IS_STATIC_BUILD ? <StaticDemoBand /> : null}
      {isPreview ? <PreviewBanner preview={preview} changedCount={changedCount} /> : null}
      {/* The page frame every page shares, then the card's own controls. */}
      <div className="atlas-top">
        <AppHeader current="atlas" onOpenSettings={openDefaults} />
        <Toolbar
          selection={selection}
          viewId={viewId}
          onViewChange={setViewId}
          onOpenSearch={search.open}
          hasIntendedUse={hasIntendedUse}
          compareHref={compareLink}
        />
      </div>
      <div className="workspace">
        <RingPane
          header={header}
          error={paneError}
          ring={ring}
          entrance={showChapter ? entranceFor(openChapterId, level1Model.regions || []) : null}
          viewId={viewId}
          isCombinationMode={isMultimorbidityMode}
          isPreview={isPreview && !isPreviewGone}
          population={shownPopulation}
          ontology={shownOntology}
          setting={isMultimorbidityMode ? null : shownSetting}
          counts={legendCounts}
          hasIntendedUse={hasIntendedUse}
          combination={combination}
          onOpenOverviewRule={openOverviewRule}
          onOpenGuide={openGuide}
        />
        <aside className={`side-column${sheetExpanded ? ' is-expanded' : ''}`} aria-label="Results">
          {/* Below 960px the results are a sheet: a plain button with its words
              expands or shrinks it; nothing suggests dragging (audit B12). */}
          <button
            type="button"
            className="sheet-grabber"
            aria-expanded={sheetExpanded}
            onClick={() => setSheetExpanded((expanded) => !expanded)}
          >
            <span className="sheet-grabber-label">
              <Icon name={sheetExpanded ? 'chevronDown' : 'chevronUp'} size={16} />
              {sheetExpanded ? 'Show less' : 'Show more'}
              <span className="visually-hidden"> of the results</span>
            </span>
          </button>
          {notice ? (
            <div className={`notice${notice.tone === 'info' ? ' is-info' : ''}`} role="status">
              <p>{notice.text}</p>
              <button type="button" className="button-plain" onClick={() => setNotice(null)}>Dismiss</button>
            </div>
          ) : null}
          {side}
        </aside>
      </div>
      <SearchPalette
        search={search}
        isMultimorbidityMode={isMultimorbidityMode}
        statusFor={searchStatusFor}
        viewId={viewId}
        classification={shownOntology?.name ?? 'ICD-11'}
        interpretation={
          plainSearch.isShown ? (
            <InterpretationRow
              interpretation={plainSearch.interpretation}
              entries={selection.entries}
              onApply={plainSearch.onApply}
              canCombine={plainSearch.canCombine}
              isApplied={plainSearch.isApplied}
              offerHelper={!IS_STATIC_BUILD}
            />
          ) : null
        }
      />
      {isDefaultsOpen ? (
        <DefaultsSheet onClose={() => setIsDefaultsOpen(false)} view={isPreview ? null : { filters, depth }} onOpenGuide={isPreviewGone ? null : openGuide} />
      ) : null}
      {isOverviewRuleOpen ? <OverviewSheet depth={depth} onClose={() => setIsOverviewRuleOpen(false)} /> : null}
      {isGuideOpen && !isPreviewGone ? <GuideSheet onClose={closeGuide} /> : null}
    </div>
  );
}
