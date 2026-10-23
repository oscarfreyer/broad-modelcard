import { useCallback, useEffect, useMemo, useRef } from 'react';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import { UI_MODES } from '../navigation/navigationReducer.js';
import Icon from '../../design/Icon.jsx';
import { ringKeyEntries } from '../../design/status.js';
import { localPrevalenceNotice } from '../../shared/localPopulation.js';
import { settingNotice } from '../../shared/careSetting.js';
import { NO_COMBINATIONS_TEXT } from '../../shared/ontology.js';
import { MODELCARD_INNER_RADIUS } from './layout/atlasGeometry.js';
import RingLegend from './RingLegend.jsx';
import RingView from './RingView.jsx';
import { drawnBubbles } from './ringUnits.js';
import { hasLocalLayer } from './localLayer.js';

const PLACEHOLDER_MODEL = Object.freeze({
  kind: 'radial-atlas',
  width: 1000,
  height: 1000,
  tiles: [],
  regions: Array.from({ length: 21 }, (_, index) => ({
    id: `PLACEHOLDER-${index}`,
    concept_id: `PLACEHOLDER-${index}`,
    startAngle: (index * Math.PI * 2) / 21,
    endAngle: ((index + 1) * Math.PI * 2) / 21,
    innerRadius: MODELCARD_INNER_RADIUS,
    outerRadius: 390
  }))
});

function ErrorState({ error }) {
  return (
    <div className="ring-state" role="alert">
      <Icon name="warning" size={28} className="ring-state-icon" />
      <h2 className="ring-state-title">{error.title}</h2>
      <p className="ring-state-text">{error.message}</p>
      {error.hint ? <p className="ring-state-hint">{error.hint}</p> : null}
      {error.command ? <code className="ring-state-command">{error.command}</code> : null}
      <div className="ring-state-actions">
        {error.links?.map((link) => (
          <a key={link.href} className="button-tinted" href={link.href}>
            {link.label}
          </a>
        ))}
        {error.onRetry ? (
          <button type="button" className="button-filled" onClick={error.onRetry}>
            <Icon name="retry" size={18} />
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}


/** Conditions or Multimorbidity: what the ring draws and picks (audit A10: on the ring's tile, not the toolbar). */
export const MODE_OPTIONS = Object.freeze([
  { value: UI_MODES.focused, label: 'Conditions', title: 'One condition at a time: the ring and its result card' },
  { value: UI_MODES.multimorbidity, label: 'Multimorbidity', title: 'Build combinations of conditions' }
]);
/**
 * The left column: the ring tile (where you are, the ring) and the legend
 * tile, its sibling, placed by one rule (ring.css, responsive.css): beside
 * the ring from 768px, under it on a phone, the same in the atlas, every
 * chapter, and both modes. The ring's centre holds nothing; a short state
 * (Loading, Opening, Updating) shows in the ring tile's header.
 *
 * @param {object} props
 * @param {{ title: string, onBack: (() => void)|null, backLabel: string, status: 'Loading'|'Opening'|'Updating'|null }} props.header
 * @param {{ title: string, message: string, hint?: string, command?: string, links?: { href: string, label: string }[], onRetry?: () => void }|null} props.error
 * @param {object|null} props.ring RingView props, or null while the atlas structure loads
 * @param {{ chapterId: string, x: number, y: number }|null} props.entrance where a chapter circle grows from
 * @param {{ id: string, name: string }|null} [props.population] the local population every read on screen uses (null: default prevalence)
 * @param {object|null} [props.ontology] another classification on screen (contract v1.13: its `/meta.ontologies` entry), else null
 * @param {string|null} [props.setting] a specific care setting every read on screen uses (contract v1.14), else null (Any setting)
 * @param {Record<string, number>|null} [props.counts] conditions in view by mark (null while loading)
 * @param {{ selectedCount: number, candidateCount: number, hasData: boolean }|null} [props.combination] multimorbidity mode facts
 * @param {(() => void)|null} [props.onOpenGuide] opens "How to read a card" from the legend
 */
export default function RingPane({
  header,
  error,
  ring,
  entrance,
  viewId,
  isCombinationMode,
  isPreview = false,
  population = null,
  ontology = null,
  setting = null,
  counts = null,
  hasIntendedUse = true,
  combination = null,
  onOpenOverviewRule = null,
  onOpenGuide = null
}) {
  // Combinations are ICD-11 only (contract v1.13): in another classification the mode stays visible, off, and says why.
  const modeOptions = useMemo(
    () => (ontology ? MODE_OPTIONS.map((option) => (option.value === UI_MODES.multimorbidity ? { ...option, disabled: true, reason: NO_COMBINATIONS_TEXT } : option)) : MODE_OPTIONS),
    [ontology]
  );
  // While a switch reloads the ring, the legend keeps its last entries so the
  // ring's footprint does not jump; Loading is explained on the first load.
  const lastKey = useRef(null);
  const keyEntries = useMemo(() => {
    if (error) {
      return { absences: [], safety: [], hasCores: false, hasLocal: false };
    }
    if (!ring || ring.isLoading) {
      return lastKey.current ?? { absences: ['loading'], safety: [], hasCores: false, hasLocal: false };
    }
    return {
      ...ringKeyEntries({
        tiles: ring.viewModel.tiles,
        rowsById: ring.rowsById,
        viewId: ring.viewId,
        isCombinationMode: ring.isCombinationMode,
        hasIntendedUse: ring.hasIntendedUse,
        coresById: ring.coresById
      }),
      // Local results (§26): the legend explains the dot only where one is drawn.
      hasLocal: hasLocalLayer(ring.viewModel.tiles, ring.rowsById, ring.viewId, { isCombinationMode: ring.isCombinationMode })
    };
  }, [error, ring?.viewModel, ring?.rowsById, ring?.viewId, ring?.isCombinationMode, ring?.hasIntendedUse, ring?.isLoading, ring?.coresById]);
  if (!error && ring && !ring.isLoading) {
    lastKey.current = keyEntries;
  }
  const { absences, safety, hasCores, hasLocal } = keyEntries;
  const showSubtypes = Boolean(ring && !error && ring.viewModel.kind === 'circle-chapter' && drawnBubbles(ring.viewModel.tiles, ring.conceptsById).subtypes);
  // The atlas draws subchapters (Multimorbidity draws one bubble per condition there).
  const showSubchapters = Boolean(ring && !error && !isCombinationMode && ring.viewModel.kind === 'radial-atlas');

  // A chapter opened from the keyboard takes the focus to its ring (the
  // chapter's first bubble), so the keyboard does not fall back to the page.
  // The request names its chapter and lasts until the next ring arrives: an
  // open by mouse, search, or link, or a return to the atlas, drops it.
  const focusChapter = useRef(null);
  const onOpenChapter = ring?.onOpenChapter ?? null;
  const openChapterFromRing = useCallback(
    (chapterId, how) => {
      focusChapter.current = how === 'keyboard' ? chapterId : null;
      onOpenChapter?.(chapterId, how);
    },
    [onOpenChapter]
  );
  // The chapter switch around a chapter circle opens chapters the same way:
  // from the keyboard, the new chapter's ring takes the focus.
  const rimOpen = ring?.rim?.onOpenChapter ?? null;
  const rimOpenChapter = useCallback(
    (chapterId, how) => {
      focusChapter.current = how === 'keyboard' ? chapterId : null;
      rimOpen?.(chapterId, how);
    },
    [rimOpen]
  );
  const hostRef = useRef(null);
  const ringKind = ring?.viewModel.kind ?? null;
  const ringChapterId = ringKind === 'circle-chapter' ? entrance?.chapterId ?? null : null;
  useEffect(() => {
    const requested = focusChapter.current;
    if (!requested || !ringKind) {
      return;
    }
    if (ringChapterId === requested) {
      hostRef.current?.querySelector('[data-tile-id][tabindex="0"]')?.focus({ preventScroll: true });
      focusChapter.current = null;
    } else if (ringChapterId) {
      // Another chapter arrived first (a search or a link): the request is stale.
      focusChapter.current = null;
    }
  }, [ringKind, ringChapterId]);
  // Back on the atlas (the header's back button, Esc): no pending focus survives.
  const isAtlasLevel = !header.onBack;
  useEffect(() => {
    if (isAtlasLevel) {
      focusChapter.current = null;
    }
  }, [isAtlasLevel]);

  return (
    <div className="ring-column">
      <main className="ring-pane" aria-busy={Boolean(header.status)}>
      <div className="ring-pane-layout">
        <div className="ring-pane-header">
          {/* One row from 1280px; below, the chips take a line of their own
              under the way back and the title, at every level (responsive.css). */}
          <div className="ring-pane-path">
            <span className="ring-pane-heading">
              {header.onBack ? (
                <button type="button" className="button-back" onClick={header.onBack}>
                  <Icon name="chevronLeft" size={18} />
                  {header.backLabel}
                </button>
              ) : null}
              <h2 className="ring-pane-title">{header.title}</h2>
            </span>
            {isPreview || population || setting ? (
              <span className="ring-pane-chips">
                {isPreview ? <span className="preview-chip">Preview, not live</span> : null}
                {setting ? (
                  <span className="population-chip setting-chip" title={settingNotice(setting)}>
                    <Icon name="setting" size={14} />
                    <span className="population-chip-text">{setting}</span>
                  </span>
                ) : null}
                {population ? (
                  <span className="population-chip" title={localPrevalenceNotice(population)}>
                    <Icon name="prevalence" size={14} />
                    <span className="population-chip-text">Local prevalence: {population.name}</span>
                  </span>
                ) : null}
              </span>
            ) : null}
            {header.status ? (
              <span className="ring-updating" role="status">
                <span className="ring-updating-dot" aria-hidden="true" />
                {header.status}
              </span>
            ) : null}
          </div>
          {header.mode ? (
            <SegmentedControl size="small" label="Mode" options={modeOptions} value={header.mode.value} onChange={header.mode.onChange} className="ring-mode" />
          ) : null}
        </div>

        {error ? (
          <ErrorState error={error} />
        ) : ring ? (
          <div
            key={ring.viewModel.kind === 'circle-chapter' ? `chapter-${entrance?.chapterId}` : 'atlas'}
            ref={hostRef}
            className={`ring-host${ring.viewModel.kind === 'circle-chapter' && entrance ? ' is-entering' : ''}`}
            style={entrance ? { '--enter-x': `${entrance.x}%`, '--enter-y': `${entrance.y}%` } : undefined}
          >
            <RingView
              {...ring}
              onOpenChapter={onOpenChapter ? openChapterFromRing : null}
              rim={ring.rim ? { ...ring.rim, onOpenChapter: rimOpenChapter } : null}
            />
          </div>
        ) : (
          <div className="ring-host">
            <RingView
              viewModel={PLACEHOLDER_MODEL}
              conceptsById={{}}
              rowsById={new Map()}
              viewId={viewId}
              isLoading
              showLabels={false}
              onSelectTile={() => {}}
              label="Atlas ring, loading"
            />
          </div>
        )}

      </div>
      </main>
      <RingLegend
        counts={error ? null : counts}
        viewId={viewId}
        hasIntendedUse={hasIntendedUse}
        absences={absences}
        safety={safety}
        combination={isCombinationMode ? combination : null}
        showCores={hasCores}
        showSubchapters={showSubchapters}
        showSubtypes={showSubtypes}
        isPreview={isPreview}
        hasLocal={hasLocal}
        population={population}
        onOpenOverviewRule={onOpenOverviewRule}
        onOpenGuide={onOpenGuide}
        ontology={ontology}
        setting={setting}
      />
    </div>
  );
}
