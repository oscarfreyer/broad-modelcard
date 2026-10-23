import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { catalogueQuery } from '../../api/queryKeys.js';
import useClientQuery from '../../api/useClientQuery.js';
import AppHeader from '../../design/AppHeader.jsx';
import HelpTip from '../../design/HelpTip.js';
import Icon from '../../design/Icon.jsx';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import StaticDemoBand from '../../design/StaticDemoBand.jsx';
import { downloadJson } from '../../shared/download.js';
import { IS_STATIC_BUILD } from '../../shared/staticBuild.js';
import LabelDialog from '../label/LabelDialog.jsx';
import useSnapshotGeometry from '../label/useSnapshotGeometry.js';
import DefaultsSheet from '../profile/DefaultsSheet.jsx';
import OverviewSheet from '../details/OverviewSheet.jsx';
import GuideSheet from '../guide/GuideSheet.jsx';
import { GUIDE_OPEN_CATALOGUE } from '../guide/guideCopy.js';
import { hasDefaults, importMessage, unknownTracked } from '../profile/profile.js';
import { findPopulation } from '../../shared/localPopulation.js';
import useProfile from '../profile/useProfile.js';
import CatalogueTile from './CatalogueTile.jsx';
import FilterBar from './FilterBar.jsx';
import {
  TAB_LABELS,
  availableSorts,
  availableTabs,
  filterOptions,
  formatUpdated,
  functionsPerSystem,
  hasLineage,
  relativeUpdated,
  replacesName,
  sameUpdateDay,
  systemNames,
  tabTiles,
  visibleTiles
} from './catalogueModel.js';
import useVersionWatch from '../../app/useVersionWatch.js';
import { defaultDepth } from '../../app/profileDefaults.js';
import { DEFAULT_DEPTH } from '../../shared/depth.js';
import PreviewBanner from '../preview/PreviewBanner.jsx';
import usePreview from '../preview/usePreview.js';
import { DEFAULT_TAB, EMPTY_FILTERS, TABS, catalogueSearch, defaultSortFor } from './catalogueState.js';
import CompareBar from '../compare/CompareBar.jsx';
import CatalogueAsk from '../search/CatalogueAsk.jsx';
import { MAX_CARDS, addCard, removeCard } from '../compare/compareState.js';
import { scrollBehavior } from '../../shared/motion.js';

const ADMIN_PAGE = './admin.html';
const PLUGIN_PAGE = './plugin.html';

/** The page's one synthetic-data notice (the header badge says it in two words). */

function SkeletonTiles() {
  return (
    <div className="cat-grid" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="cat-tile is-skeleton">
          <div className="cat-tile-id">
            <span className="skeleton-line is-wide" />
            <span className="skeleton-line" />
          </div>
          <div className="cat-tile-snapshot">
            <span className="cat-skeleton-ring" />
          </div>
          <span className="skeleton-line is-wide" />
        </div>
      ))}
    </div>
  );
}

function LoadFailure({ error, onRetry }) {
  const isDown = error?.code === 'backend_unavailable';
  return (
    <div className="cat-state" role="alert">
      <Icon name="warning" size={28} className="cat-state-icon" />
      <h2 className="cat-state-title">{isDown ? 'The backend is not running' : 'The catalogue could not be loaded'}</h2>
      <p className="cat-state-text">
        {isDown
          ? 'The catalogue reads its cards from the Broad Modelcard backend on this computer, and it did not answer.'
          : error?.message || 'Something went wrong while reading the cards.'}
      </p>
      {isDown ? (
        <>
          <p className="cat-state-hint">Start the app from the project folder with this command; it starts the backend too.</p>
          <code className="ring-state-command">npm run dev</code>
        </>
      ) : null}
      <button type="button" className="button-tinted" onClick={onRetry}>
        <Icon name="retry" size={16} />
        Try again
      </button>
    </div>
  );
}

function EmptyState({ title, text, children }) {
  return (
    <div className="cat-state is-empty" role="status">
      <h2 className="cat-state-title">{title}</h2>
      <p className="cat-state-text">{text}</p>
      {children ? <div className="cat-state-actions">{children}</div> : null}
    </div>
  );
}

/**
 * The catalogue reads every card with the default prevalence. When "Your
 * defaults" name a local population, the cards open with it: say so, so the
 * tile figures are not mistaken for the local ones.
 */
function DefaultPopulationNote({ populationId, onOpenDefaults }) {
  const meta = useClientQuery(populationId ? 'meta' : null, (client, options) => client.getMeta({}, options));
  if (!populationId || !meta.data) {
    return null;
  }
  const population = findPopulation(meta.data.populations, populationId);
  return (
    <p className="cat-population-note" role="note">
      <Icon name="prevalence" size={18} />
      <span>
        {population ? (
          <>
            Tiles: <strong>default prevalence</strong>. Cards open with <strong>{population.name}</strong> (synthetic).
          </>
        ) : (
          <>
            Your local prevalence ({populationId}) is no longer in the data. Cards open with the default.
          </>
        )}{' '}
        <button type="button" className="button-link" onClick={onOpenDefaults}>
          Settings
        </button>
      </span>
    </p>
  );
}

/** Export and import of the tracked list (My systems), with the result as a quiet note. */
function ProfileTools({ store, trackedCount, onImported }) {
  const inputRef = useRef(null);
  const exportList = () => downloadJson('broad-modelcard-my-systems.json', store.exportFile());
  const canExport = trackedCount > 0 || hasDefaults(store.get().defaults);
  const importList = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch {
      onImported({ ok: false, error: 'The file could not be read.' });
      return;
    }
    onImported(store.importText(text));
  };
  return (
    <div className="cat-profile-tools">
      <div className="cat-profile-actions">
        <HelpTip label="Where your list is kept">
          <p>
            {store.isPersistent()
              ? 'Your tracked cards and settings are kept in this browser only. Export the list to move them to another browser.'
              : 'This browser does not allow saving, so your tracked cards and settings last until you close the page. Export the list to keep them.'}
          </p>
        </HelpTip>
        <button type="button" className="button-plain" onClick={exportList} disabled={!canExport}>
          <Icon name="download" size={16} />
          Export list
        </button>
        <button type="button" className="button-plain" onClick={() => inputRef.current?.click()}>
          <Icon name="upload" size={16} />
          Import list
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          tabIndex={-1}
          aria-label="Choose a My systems list to import"
          onChange={importList}
        />
      </div>
    </div>
  );
}

/**
 * The catalogue landing page: every card as a
 * tile, from one catalogue request; tabs, filters, sort, and tracking work on
 * the loaded tiles. The view state lives in the URL (catalogueState.js).
 *
 * @param {{ initialState: ReturnType<import('./catalogueState.js').parseCatalogueState> }} props
 */
export default function CatalogueApp({ initialState }) {
  const [tab, setTab] = useState(initialState.tab);
  // Null until the reader picks a sort: each tab then opens with its own default.
  const [sort, setSort] = useState(initialState.sort);
  const [query, setQuery] = useState(initialState.query ?? '');
  const [filters, setFilters] = useState(initialState.filters);
  const [newestOnly, setNewestOnly] = useState(Boolean(initialState.newest));
  const [compareCards, setCompareCards] = useState(initialState.compare ?? []);
  const [labelCardId, setLabelCardId] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [isDefaultsOpen, setIsDefaultsOpen] = useState(false);
  const [isOverviewRuleOpen, setIsOverviewRuleOpen] = useState(false);
  // "How to read a card": reopened here; it opens by itself on the first atlas visit only.
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  // A card just taken off My systems, with Undo (the tile leaves the tab at once).
  const [removed, setRemoved] = useState(null);
  const undoRef = useRef(null);
  const version = initialState.version;
  const isPreview = version !== 'live';
  // A staged preview (`?preview=staged:<id>`) re-reads its upload, so the page
  // notices when it was published, replaced, or discarded elsewhere.
  const preview = usePreview(isPreview ? version.slice('staged:'.length) : null);
  const isPreviewGone = Boolean(preview && ['ended', 'missing'].includes(preview.phase));

  const catalogueRequest = catalogueQuery({ version });
  const catalogue = useClientQuery(catalogueRequest.key, catalogueRequest.fetch);
  const data = catalogue.data;
  const tiles = data?.tiles;
  // The snapshots' geometry: the atlas structure, read alongside the
  // catalogue and laid out once for every tile (the catalogue stays on the
  // default prevalence, so the snapshot places bubbles as the default atlas).
  const geometry = useSnapshotGeometry({ enabled: !isPreviewGone });
  // The shared version watch: /meta every 5 minutes and on
  // focus; a new live version drops the cache, so the one catalogue request
  // runs again. Nothing extra is requested on load: the catalogue names its
  // version. A preview follows live changes too (CONTRACT.md §2).
  const retryRef = useRef(null);
  retryRef.current = catalogue.error ? catalogue.retry : null;
  useVersionWatch({
    knownVersion: isPreview ? null : data?.dataset_version ?? null,
    onTrigger: () => retryRef.current?.()
  });

  const { profile, store } = useProfile();
  const tracked = useMemo(() => new Set(profile.tracked), [profile.tracked]);

  const tabs = useMemo(() => availableTabs(tiles ?? []), [tiles]);
  const sorts = useMemo(() => availableSorts(tiles ?? []), [tiles]);
  // A tab or sort from a shared URL that this catalogue cannot show yet (Safety before S3) falls back.
  const activeTab = tiles && !tabs.includes(tab) ? DEFAULT_TAB : tab;
  // The reader's own sort is kept across tabs; without one, the tab's default shows in the sort menu.
  const chosenSort = sort && (!tiles || sorts.includes(sort)) ? sort : null;
  const activeSort = chosenSort ?? defaultSortFor(activeTab, sorts);

  useEffect(() => {
    const search = catalogueSearch({ tab: activeTab, sort: chosenSort, query, filters, newest: newestOnly, version, compare: compareCards });
    const next = `${window.location.pathname}${search}${window.location.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, '', next);
    }
  }, [activeTab, chosenSort, query, filters, newestOnly, version, compareCards]);

  // Faceted counts: each choice counts the cards it would show in this tab with the other filters.
  const options = useMemo(
    () => filterOptions(tiles ? tabTiles(tiles, { tab: activeTab, tracked, newest: newestOnly }) : [], filters),
    [tiles, activeTab, tracked, filters, newestOnly]
  );
  const siblings = useMemo(() => functionsPerSystem(tiles ?? []), [tiles]);
  const shown = useMemo(
    () => (tiles ? visibleTiles(tiles, { tab: activeTab, filters, query, sort: activeSort, tracked, newest: newestOnly }) : []),
    [tiles, activeTab, filters, query, activeSort, tracked, newestOnly]
  );
  // Version lineage (contract v1.14, §28.2): "Replaces X" on a tile, and the "Newest versions only" choice.
  const names = useMemo(() => systemNames(tiles ?? []), [tiles]);
  const offersNewest = useMemo(() => hasLineage(tiles ?? []), [tiles]);
  const missing = useMemo(
    () => (tiles ? unknownTracked(profile, tiles.map((tile) => tile.card_id)) : []),
    [tiles, profile]
  );
  const trackedCount = tiles ? profile.tracked.length - missing.length : profile.tracked.length;

  const setFilter = useCallback((key, value) => setFilters((current) => ({ ...current, [key]: value })), []);
  const filtersRef = useRef(null);
  // The Clear filters button goes away when pressed: the focus moves to the search instead of the page.
  const clearFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    setQuery('');
    setNewestOnly(false);
    requestAnimationFrame(() => filtersRef.current?.querySelector('input, select')?.focus());
  }, []);
  const showSiblings = useCallback((modelVersion) => {
    setFilters({ ...EMPTY_FILTERS, system: modelVersion });
    setQuery('');
    // My systems may not track the other functions: show them among all cards.
    setTab((current) => (current === TABS.mine ? TABS.performance : current));
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  }, []);
  const openLabel = useCallback((id) => setLabelCardId(id), []);
  // A tab never changes the reader's sort; without one, the sort menu shows the tab's default.
  const changeTab = useCallback((next) => {
    setTab(next);
    setRemoved(null);
  }, []);
  const trackChanged = useCallback(
    (id, name, isTracked) => setRemoved(activeTab === TABS.mine && !isTracked ? { id, name } : null),
    [activeTab]
  );
  const undoRemove = () => {
    if (removed) store.setTracked(removed.id, true);
    setRemoved(null);
  };
  // The removed tile took the focus with it: it moves to Undo, which says what happened.
  useEffect(() => {
    if (removed) undoRef.current?.focus();
  }, [removed]);
  // The cards chosen for a comparison, kept in the URL. The
  // comparison reads the live data, so a staged preview does not offer it; the
  // static demo records it (R7).
  const canCompare = !isPreview;
  const toggleCompare = useCallback(
    (id) => setCompareCards((current) => (current.includes(id) ? removeCard(current, id) : addCard(current, id).cards)),
    []
  );
  const labelTile = labelCardId ? tiles?.find((tile) => tile.card_id === labelCardId) ?? null : null;

  const tabOptions = tabs.map((value) => ({
    value,
    label: value === TABS.mine ? `${TAB_LABELS[value]} (${trackedCount})` : TAB_LABELS[value]
  }));
  const newest = tiles?.reduce((latest, tile) => (!latest || (tile.last_updated?.at ?? '') > latest ? tile.last_updated?.at : latest), null);
  // One update day for every card: the tiles leave the date out and the footer says it.
  const oneUpdateDay = useMemo(() => sameUpdateDay(tiles ?? []), [tiles]);

  let body;
  if (isPreviewGone) {
    body = (
      <EmptyState
        title="No staged cards to show"
        text="The preview has ended, so this page no longer shows staged data. The live catalogue, linked above, has every published card."
      />
    );
  } else if (catalogue.error && !data) {
    body = <LoadFailure error={catalogue.error} onRetry={catalogue.retry} />;
  } else if (!data) {
    body = <SkeletonTiles />;
  } else if (activeTab === TABS.mine && trackedCount === 0) {
    body = (
      <EmptyState
        title="No tracked cards yet"
        text="Press Track on a card, here or on its atlas, to keep it in My systems: for example the AI systems your hospital deploys. The list stays in this browser; import a list saved elsewhere."
      >
        <button type="button" className="button-tinted" onClick={() => changeTab(TABS.performance)}>
          Show all cards
        </button>
      </EmptyState>
    );
  } else if (!shown.length) {
    body = (
      <EmptyState
        title={query.trim() ? `No card matches “${query.trim()}”` : 'No card matches these filters'}
        text="Try another word, remove a filter, or clear them all to see every card in this tab."
      >
        <button type="button" className="button-tinted" onClick={clearFilters}>
          Clear filters
        </button>
      </EmptyState>
    );
  } else {
    body = (
      <ul className="cat-grid" aria-label="Cards" id="cat-cards" tabIndex={-1}>
        {shown.map((tile) => (
          <li key={tile.card_id} className="cat-grid-item">
            <CatalogueTile
              tile={tile}
              total={data.condition_count}
              tab={activeTab}
              version={version}
              geometry={geometry}
              siblingCount={siblings.get(tile.model_version) ?? 1}
              replaces={replacesName(tile, names)}
              onShowSiblings={showSiblings}
              onOpenLabel={isPreview ? null : openLabel}
              onTrackChange={trackChanged}
              showUpdated={!oneUpdateDay}
              isCompared={compareCards.includes(tile.card_id)}
              isCompareFull={compareCards.length >= MAX_CARDS}
              onToggleCompare={canCompare ? toggleCompare : null}
            />
          </li>
        ))}
      </ul>
    );
  }

  const inTabCount = tiles ? tabTiles(tiles, { tab: activeTab, tracked }).length : 0;
  const isNarrowed = Boolean(data) && !isPreviewGone && shown.length > 0 && shown.length !== inTabCount;

  return (
    <div className={`catalogue-shell${isPreview ? ' is-preview' : ''}${isPreviewGone ? ' is-preview-ended' : ''}${canCompare && compareCards.length ? ' has-compare-bar' : ''}`}>
      <a className="skip-link" href="#cat-cards">
        Skip to the cards
      </a>
      {IS_STATIC_BUILD ? <StaticDemoBand /> : null}
      {preview ? <PreviewBanner preview={preview} surface="catalogue" /> : null}
      <AppHeader current="catalogue" onOpenSettings={() => setIsDefaultsOpen(true)} />

      <main className="cat-main">
        <div className="cat-intro">
          {/* The title and its help on one line; the help explains the page. */}
          <div className="page-title-row">
            <h1 className="cat-title">
              AI systems
              {tiles ? (
                <span className="cat-title-count">
                  <span className="visually-hidden">, </span>
                  {tiles.length.toLocaleString('en-US')} {tiles.length === 1 ? 'card' : 'cards'}
                </span>
              ) : null}
            </h1>
            <HelpTip label="About the catalogue" className="cat-title-help">
              <p>
                {activeTab === TABS.safety
                  ? 'One bubble per ICD-11 subchapter, marked where a safety incident applies.'
                  : 'One card per AI system and function. Each ring is its atlas in miniature: one bubble per ICD-11 subchapter, in its Overview mark.'}
              </p>
              <p className="help-tip-links">
                {activeTab === TABS.safety ? null : (
                  <button type="button" className="button-link" onClick={() => setIsOverviewRuleOpen(true)} aria-haspopup="dialog">
                    How the Overview works
                  </button>
                )}
                <button type="button" className="button-link" onClick={() => setIsGuideOpen(true)} aria-haspopup="dialog">
                  {GUIDE_OPEN_CATALOGUE}
                </button>
              </p>
            </HelpTip>
          </div>
          {!isPreview ? <DefaultPopulationNote populationId={profile.defaults?.population ?? null} onOpenDefaults={() => setIsDefaultsOpen(true)} /> : null}
          {/* Plain-language search (contract v1.14, §31): read as chips, opened in the atlas. */}
          {!isPreview ? <CatalogueAsk /> : null}
        </div>

        <div className="cat-controls">
          <SegmentedControl label="What the cards show" options={tabOptions} value={activeTab} onChange={changeTab} className="cat-tabs" />
          {/* An empty My systems has nothing to filter. */}
          {data && !isPreviewGone && !(activeTab === TABS.mine && inTabCount === 0) ? (
            <FilterBar
              ref={filtersRef}
              options={options}
              filters={filters}
              query={query}
              sort={activeSort}
              sorts={sorts}
              onFilter={setFilter}
              onQuery={setQuery}
              onSort={setSort}
              onClear={clearFilters}
              newest={newestOnly}
              onNewest={offersNewest || newestOnly ? setNewestOnly : null}
            />
          ) : null}
          <p className="cat-result-count" role="status">
            {isNarrowed ? `Showing ${shown.length} of ${inTabCount} ${inTabCount === 1 ? 'card' : 'cards'}` : ''}
          </p>
        </div>

        {activeTab === TABS.mine ? (
          <ProfileTools store={store} trackedCount={profile.tracked.length} onImported={setImportResult} />
        ) : null}
        {activeTab === TABS.mine && removed ? (
          <p className="cat-removed" role="status">
            <span>
              Removed <strong>{removed.name}</strong> from My systems.
            </span>
            <button ref={undoRef} type="button" className="button-plain" onClick={undoRemove}>
              <Icon name="undo" size={16} />
              Undo
            </button>
          </p>
        ) : null}
        {activeTab === TABS.mine && importResult ? (
          <p className={`cat-profile-result${importResult.ok ? '' : ' is-error'}`} role="status">
            {importMessage(importResult)}
          </p>
        ) : null}
        {activeTab === TABS.mine && missing.length ? (
          <div className="cat-missing" role="status">
            <p>
              {missing.length === 1 ? 'One tracked card is' : `${missing.length} tracked cards are`} not in the catalogue (removed or renamed):{' '}
              {missing.map((id) => id.replace('|', ' (').concat(')')).join(', ')}.
            </p>
            <button type="button" className="button-plain" onClick={() => store.untrack(missing)}>
              Remove from my list
            </button>
          </div>
        ) : null}

        {body}

        {data && !isPreviewGone ? (
          <footer className="cat-foot">
            <span>Dataset version {isPreview ? 'staged (preview)' : data.dataset_version}</span>
            {newest ? (
              <time dateTime={newest} title={formatUpdated(newest, { long: true }) ?? undefined}>
                {oneUpdateDay ? `Every card ${relativeUpdated(newest).replace(/^Updated/, 'updated')}` : `Last ${relativeUpdated(newest).replace(/^Updated/, 'update')}`}
              </time>
            ) : null}
            <HelpTip label="About these figures">
              <p>
                Counts for all patients over {data.condition_count.toLocaleString('en-US')} conditions. Status bands are prototype heuristics.
              </p>
              <p>
                {IS_STATIC_BUILD ? (
                  'This static demo is a frozen snapshot; the local app adds the Data Library and the live interaction panel.'
                ) : (
                  <>
                    Maintainers update the data in the <a href={ADMIN_PAGE}>Data Library</a>. <a href={PLUGIN_PAGE}>Live interaction</a> shows how
                    a host system looks a case up on a card.
                  </>
                )}
              </p>
            </HelpTip>
          </footer>
        ) : null}
      </main>

      {canCompare && compareCards.length ? <CompareBar cards={compareCards} tiles={tiles} onClear={() => setCompareCards([])} /> : null}
      {labelTile ? <LabelDialog tile={labelTile} catalogue={data} geometry={geometry} onClose={() => setLabelCardId(null)} /> : null}
      {isDefaultsOpen ? <DefaultsSheet onClose={() => setIsDefaultsOpen(false)} onOpenGuide={() => setIsGuideOpen(true)} /> : null}
      {isOverviewRuleOpen ? (
        <OverviewSheet depth={defaultDepth(profile.defaults) ?? DEFAULT_DEPTH} onClose={() => setIsOverviewRuleOpen(false)} />
      ) : null}
      {isGuideOpen ? (
        <GuideSheet
          onClose={() => {
            setIsGuideOpen(false);
            store.markGuideSeen();
          }}
        />
      ) : null}
    </div>
  );
}
