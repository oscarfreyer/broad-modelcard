import { useCallback, useEffect, useMemo, useState } from 'react';
import { catalogueQuery } from '../../api/queryKeys.js';
import useClientQuery from '../../api/useClientQuery.js';
import AppHeader from '../../design/AppHeader.jsx';
import HelpTip from '../../design/HelpTip.js';
import Icon from '../../design/Icon.jsx';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import StaticDemoBand from '../../design/StaticDemoBand.jsx';
import { DEFAULT_STATUS_BANDS } from '../../design/rangeScale.js';
import { ALL_LENS } from '../../app/startupParams.js';
import { STATIC_OTHER_ONTOLOGY_LENS_NOTE, fitLens, staticLens } from '../../app/lensSelection.js';
import { IS_STATIC_BUILD } from '../../shared/staticBuild.js';
import { kindLabel } from '../../shared/aiSystem.js';
import { displayUseCase, lensOptions } from '../../shared/format.js';
import { conceptName } from '../../shared/conceptName.js';
import { DEFAULT_PREVALENCE, checkPopulation, populationFallbackText } from '../../shared/localPopulation.js';
import { ICD11, mappingSourceAttribution, ontologyAttribution, ontologyList, ontologyNotice, otherOntology } from '../../shared/ontology.js';
import { ANY_SETTING, ANY_SETTING_LABEL, NO_DATA_STORED, specificSetting } from '../../shared/careSetting.js';
import { DEPTH_OPTIONS } from '../../shared/depth.js';
import useSnapshotGeometry from '../label/useSnapshotGeometry.js';
import '../../styles/label.css';
import CardFacts from './CardFacts.jsx';
import CardPicker from './CardPicker.jsx';
import ComparisonTable from './ComparisonTable.jsx';
import { NOT_COMPARABLE, REASON_RULES, reasonText, resultContext } from './compareCopy.js';
import { cardNames, showCounts, showOptions, tableEntries } from './compareModel.js';
import { MAX_CARDS, MIN_CARDS, SHOW, SORTS, addCard, compareSearch, isComparable, removeCard, splitCardId, urlDepth } from './compareState.js';
import useVersionWatch from '../../app/useVersionWatch.js';
import { catalogueSearch } from '../catalogue/catalogueState.js';

/** The page's synthetic-data notice. */

const LENS_FIELDS = [
  { axis: 'age', label: 'Age' },
  { axis: 'sex', label: 'Sex' },
  { axis: 'ethnicity', label: 'Ethnicity' }
];

function comparisonQuery({ cards, chapterId, lens, setting, population, ontology }) {
  if (!isComparable(cards)) return { key: null, fetch: null };
  const scope = chapterId ? 'chapter' : 'atlas';
  // A specific care setting (v1.14) is part of the key only when chosen, so Any-setting keys are as before.
  const key = [
    'compare', cards.join(','), scope, chapterId ?? '', lens.age, lens.sex, lens.ethnicity, population ?? '', otherOntology(ontology) ?? '',
    ...(setting ? [`setting:${setting}`] : [])
  ].join('|');
  return {
    key,
    fetch: (client, options) =>
      client.getComparison(
        { cards, scope, chapterId, ...lens, setting: setting ?? undefined, population: population ?? undefined, ontology: ontology ?? undefined },
        options
      )
  };
}

function Select({ label, value, options, onChange, disabled = false }) {
  return (
    <label className="cmp-select">
      <span className="cmp-select-label">{label}</span>
      <span className="select-wrap">
        <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={16} className="select-chevron" />
      </span>
    </label>
  );
}

/** One chosen card: its name, function, and kind, with a way to take it out. */
function CardChip({ tile, cardId, onRemove }) {
  const { modelVersion, useCase } = splitCardId(cardId);
  const name = tile?.system?.display_name || modelVersion;
  return (
    <li className="cmp-chip">
      <span className="cmp-chip-text">
        <span className="cmp-chip-name">{name}</span>
        <span className="cmp-chip-function">
          {tile ? <span className="kind-tag">{kindLabel(tile.system)}</span> : null}
          {displayUseCase(useCase)}
        </span>
      </span>
      <button type="button" className="cmp-chip-remove" onClick={() => onRemove(cardId)} aria-label={`Remove ${name}, ${displayUseCase(useCase)}`}>
        <Icon name="close" size={14} />
      </button>
    </li>
  );
}

/** Answers that name a card the data does not hold: retrying cannot help, removing it can. */
const UNKNOWN_CARD_CODES = new Set(['unknown_model', 'unknown_use_case', 'invalid_cards']);

function UnknownCard({ unknownCards, names, onRemove }) {
  return (
    <div className="cat-state" role="alert">
      <Icon name="warning" size={28} className="cat-state-icon" />
      <h2 className="cat-state-title">This comparison names a card the data does not hold</h2>
      <p className="cat-state-text">The link may be older than the data. Remove the card to compare the others.</p>
      {unknownCards.map((cardId) => (
        <button key={cardId} type="button" className="button-tinted" onClick={() => onRemove(cardId)}>
          <Icon name="close" size={16} />
          Remove {names(cardId)}
        </button>
      ))}
    </div>
  );
}

function LoadFailure({ error, onRetry }) {
  const isDown = error?.code === 'backend_unavailable';
  // The static demo did not record this comparison (R7): it says so; retrying cannot help.
  const isStatic = error?.code === 'static_unavailable';
  if (isStatic) {
    return (
      <div className="cat-state" role="status">
        <Icon name="info" size={28} className="cat-state-icon" />
        <h2 className="cat-state-title">{error.title}</h2>
        <p className="cat-state-text">{error.detail}</p>
      </div>
    );
  }
  return (
    <div className="cat-state" role="alert">
      <Icon name="warning" size={28} className="cat-state-icon" />
      <h2 className="cat-state-title">{isDown ? 'The backend is not running' : 'The comparison could not be loaded'}</h2>
      <p className="cat-state-text">
        {isDown ? 'The comparison reads its cards from the Broad Modelcard backend on this computer, and it did not answer.' : error?.detail || error?.message}
      </p>
      {isDown ? <code className="ring-state-command">npm run dev</code> : null}
      <button type="button" className="button-tinted" onClick={onRetry}>
        <Icon name="retry" size={16} />
        Try again
      </button>
    </div>
  );
}

function SkeletonTable() {
  return (
    <div className="cmp-skeleton" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <span key={index} className="skeleton-line is-wide" />
      ))}
    </div>
  );
}

/**
 * The comparison page: 2 to 4 cards side by side, with the
 * facts that decide whether their results compare, then the results per
 * chapter or, in a chapter, per subchapter and condition. Every row the
 * backend flags says "Not directly comparable" and why (CONTRACT.md §25).
 * The state lives in the URL (compareState.js).
 *
 * @param {{ initialState: ReturnType<import('./compareState.js').parseCompareState> }} props
 */
export default function CompareApp({ initialState }) {
  const [cards, setCards] = useState(initialState.cards);
  const [chapterId, setChapterId] = useState(initialState.chapterId);
  const [lens, setLens] = useState(initialState.lens);
  // Contract v1.14 (§29): a specific care setting for every column, or null (Any setting); none in the static demo.
  const [setting, setSetting] = useState(IS_STATIC_BUILD ? null : specificSetting(initialState.setting));
  const [population, setPopulation] = useState(initialState.population);
  const [ontology, setOntology] = useState(initialState.ontology);
  const [show, setShow] = useState(initialState.show);
  const [sort, setSort] = useState(initialState.sort);
  const [depth, setDepth] = useState(initialState.depth);
  // Carried only: the atlas view the links back open (the table shows the Overview mark).
  const view = initialState.view ?? null;
  const readerDepth = initialState.readerDepth ?? null;
  const [refusal, setRefusal] = useState(null);

  const meta = useClientQuery('meta', (client, options) => client.getMeta({}, options));
  const catalogueRequest = catalogueQuery({});
  const catalogue = useClientQuery(catalogueRequest.key, catalogueRequest.fetch);
  const tiles = catalogue.data?.tiles ?? null;
  const tilesById = useMemo(() => new Map((tiles ?? []).map((tile) => [tile.card_id, tile])), [tiles]);
  // Each column's atlas in miniature, as on its catalogue tile.
  const geometry = useSnapshotGeometry();
  const snapshots = useMemo(() => ({ geometry, tilesById }), [geometry, tilesById]);

  // Values the data does not offer fall back to the defaults once /meta has loaded.
  const axes = meta.data?.axes ?? null;
  const populations = meta.data?.populations ?? [];
  // A local population /meta does not list is dropped, and the page says so, as the atlas does.
  const populationCheck = checkPopulation(population, meta.data ? populations : null);
  const activePopulation = populationCheck.entry;
  const readPopulation = meta.data ? activePopulation?.id ?? null : population;
  const ontologies = meta.data ? ontologyList(meta.data) : [];
  const activeOntology = ontology && meta.data ? ontologies.find((entry) => entry.id === ontology) ?? null : null;
  const readOntology = meta.data ? activeOntology?.id ?? null : ontology;
  // The static demo holds one group at a time, and other classifications for all patients only (R7).
  const isLensLocked = IS_STATIC_BUILD && Boolean(otherOntology(readOntology));
  const fittedLens = useMemo(() => {
    const fitted = fitLens(lens, axes);
    return IS_STATIC_BUILD ? staticLens(fitted, { isOtherOntology: isLensLocked }) : fitted;
  }, [lens, axes, isLensLocked]);

  // Settings /meta offers (none in the static demo or for older data); an unknown one reads as Any setting.
  const settingOptions = IS_STATIC_BUILD ? [] : (axes?.context ?? []).filter((value) => specificSetting(value));
  const readSetting = axes && !settingOptions.includes(setting) ? null : setting;
  const request = comparisonQuery({ cards, chapterId, lens: fittedLens, setting: readSetting, population: readPopulation, ontology: readOntology });
  const comparison = useClientQuery(meta.data ? request.key : null, request.fetch);
  const data = comparison.data;
  // useClientQuery reports an error only for the current request; an older answer may still be on screen.
  const isStale = Boolean(data && comparison.dataKey !== request.key && !comparison.error);

  // Publishes made elsewhere reach this page as on the atlas and the catalogue (shared version watch).
  useVersionWatch({
    knownVersion: data?.dataset_version ?? null,
    onTrigger: () => {
      if (comparison.error) comparison.retry();
    }
  });

  useEffect(() => {
    const search = compareSearch({
      cards,
      chapterId,
      lens: fittedLens,
      setting: readSetting,
      population: readPopulation,
      ontology: readOntology,
      show,
      sort,
      depth: urlDepth(depth, readerDepth),
      view
    });
    const next = `${window.location.pathname}${search}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(window.history.state, '', next);
    }
  }, [cards, chapterId, fittedLens, readSetting, readPopulation, readOntology, show, sort, depth, readerDepth, view]);

  const add = useCallback(
    (cardId) => {
      const result = addCard(cards, cardId);
      setCards(result.cards);
      setRefusal(result.refused === 'full' ? `Compare at most ${MAX_CARDS} cards. Remove one to add another.` : null);
    },
    [cards]
  );
  const remove = useCallback((cardId) => {
    setCards((current) => removeCard(current, cardId));
    setRefusal(null);
  }, []);
  const changeOntology = (value) => {
    setOntology(otherOntology(value));
    setChapterId(null); // chapters belong to their classification
  };

  // "AI systems" goes back to the catalogue with these cards chosen for Compare.
  const navLinks = useMemo(() => (cards.length ? { catalogue: `./${catalogueSearch({ compare: cards })}` } : null), [cards]);

  const statusBands = meta.data?.status_bands ?? DEFAULT_STATUS_BANDS;
  // While a new comparison loads, the previous one stays on screen, dimmed.
  const shown = data;
  const scope = shown?.filters?.scope ?? (chapterId ? 'chapter' : 'atlas');
  const names = useMemo(() => cardNames(shown?.cards ?? []), [shown]);
  const entries = useMemo(() => (shown ? tableEntries(shown.rows, { show, sort, scope, cardReasons: shown.card_reasons }) : []), [shown, show, sort, scope]);
  const counts = useMemo(() => (shown ? showCounts(shown.rows, shown.card_reasons) : null), [shown]);
  const contextChapterId = scope === 'chapter' ? shown?.filters?.chapter_id ?? chapterId : null;
  // One object per change, so the memoized table skips renders that change nothing in it.
  const context = useMemo(
    () => ({ lens: fittedLens, setting: readSetting, population: readPopulation, ontology: readOntology, chapterId: contextChapterId, depth, view }),
    [contextChapterId, depth, fittedLens, readOntology, readPopulation, readSetting, view]
  );
  const contextWords = resultContext({
    lens: shown?.filters?.lens ?? fittedLens,
    setting: shown ? shown.filters?.context ?? null : readSetting,
    population: shown?.population ?? activePopulation,
    ontology: shown?.ontology ?? activeOntology
  });
  const chapterTitle = scope === 'chapter' ? conceptName({ pt: shown?.filters?.chapter_pt ?? '', level: 0 }) : null;
  const caption = scope === 'chapter' ? 'Results by subchapter and condition' : 'Results by chapter';

  // Whether any compared card stores rows at a setting (the facts' `lenses.settings`, v1.14); unknown before the first answer.
  const storedByAny = (value) => !shown || shown.cards.some((card) => (card.lenses?.settings ?? [ANY_SETTING]).includes(value));

  const lensFields = LENS_FIELDS.map(({ axis, label }) => ({
    axis,
    label,
    options: lensOptions(axes?.[axis] ?? [ALL_LENS[axis]])
  }));

  let results;
  if (cards.length < MIN_CARDS) {
    results = (
      <div className="cat-state is-empty" role="status">
        <h2 className="cat-state-title">{cards.length ? 'Add one more card' : 'Choose two to four cards'}</h2>
        <p className="cat-state-text">
          Add cards with <strong>Add a card</strong>, or choose them in the catalogue with <strong>Compare</strong> on each tile.
        </p>
      </div>
    );
  } else if (comparison.error && UNKNOWN_CARD_CODES.has(comparison.error.code)) {
    const known = (cardId) => tilesById.has(cardId);
    const unknownCards = tiles ? cards.filter((cardId) => !known(cardId)) : [];
    const nameOf = (cardId) => {
      const { modelVersion, useCase } = splitCardId(cardId);
      return `${modelVersion}, ${displayUseCase(useCase)}`;
    };
    results = unknownCards.length ? (
      <UnknownCard unknownCards={unknownCards} names={nameOf} onRemove={remove} />
    ) : (
      <LoadFailure error={comparison.error} onRetry={comparison.retry} />
    );
  } else if (comparison.error) {
    results = <LoadFailure error={comparison.error} onRetry={comparison.retry} />;
  } else if (!shown) {
    results = <SkeletonTable />;
  } else {
    results = (
      <ComparisonTable
        comparison={shown}
        entries={entries}
        names={names}
        scope={scope}
        sortedByDifference={sort === SORTS.difference}
        context={context}
        statusBands={statusBands}
        isExpert={depth === 'expert'}
        onDrill={setChapterId}
        caption={caption}
        snapshots={snapshots}
      />
    );
  }

  const cardReasons = shown?.card_reasons ?? [];

  return (
    <div className={`compare-shell${IS_STATIC_BUILD ? ' is-static' : ''}`}>
      <a className="skip-link" href="#cmp-results">
        Skip to the results
      </a>
      {IS_STATIC_BUILD ? <StaticDemoBand /> : null}
      <AppHeader current="compare" hrefs={navLinks} />

      <main className="cmp-main">
        <div className="cat-intro">
          <div className="page-title-row">
            <h1 className="cat-title">Compare</h1>
            <HelpTip label="About the comparison">
              <p>Two to four cards side by side, chapter by chapter. Rows that cannot be read against each other at face value say why.</p>
            </HelpTip>
          </div>
        </div>

        <section className="cmp-setup" aria-label="What to compare">
          <ul className="cmp-chips" aria-label="Cards in the comparison">
            {cards.map((cardId) => (
              <CardChip key={cardId} cardId={cardId} tile={tilesById.get(cardId)} onRemove={remove} />
            ))}
          </ul>
          <CardPicker tiles={tiles} cards={cards} onAdd={add} startOpen={cards.length < MIN_CARDS} />
          {refusal ? (
            <p className="cmp-refusal" role="status">
              {refusal}
            </p>
          ) : null}
        </section>

        {/* The population and classification choices appear with a comparison, so the picker has the room before. */}
        {cards.length >= MIN_CARDS ? (
          <section className="cmp-choices" aria-label="Population and classification">
            {lensFields.map((field) => (
              <Select
                key={field.axis}
                label={field.label}
                value={fittedLens[field.axis]}
                options={field.options}
                disabled={isLensLocked}
                onChange={(value) =>
                  setLens((current) => (IS_STATIC_BUILD ? staticLens({ ...current, [field.axis]: value }, { axis: field.axis }) : { ...current, [field.axis]: value }))
                }
              />
            ))}
            {settingOptions.length ? (
              <Select
                label="Setting"
                value={readSetting ?? ANY_SETTING}
                options={[
                  { value: ANY_SETTING, label: ANY_SETTING_LABEL },
                  ...settingOptions.map((value) => ({ value, label: storedByAny(value) ? value : `${value} (${NO_DATA_STORED})` }))
                ]}
                onChange={(value) => setSetting(specificSetting(value))}
              />
            ) : null}
            {populations.length ? (
              <Select
                label="Prevalence"
                value={readPopulation ?? ''}
                options={[{ value: '', label: DEFAULT_PREVALENCE }, ...populations.map((entry) => ({ value: entry.id, label: entry.name }))]}
                onChange={(value) => setPopulation(value || null)}
              />
            ) : null}
            {ontologies.length > 1 ? (
              <Select
                label="Classification"
                value={readOntology ?? ICD11}
                options={ontologies.map((entry) => ({ value: entry.id, label: entry.name }))}
                onChange={changeOntology}
              />
            ) : null}
            {IS_STATIC_BUILD ? (
              <HelpTip label="About these choices in the demo" className="cmp-static-help">
                <p>{isLensLocked ? STATIC_OTHER_ONTOLOGY_LENS_NOTE : 'This static demo holds one population group at a time: choosing one resets the others to All.'}</p>
              </HelpTip>
            ) : null}
          </section>
        ) : null}

        {populationCheck.status === 'dropped' ? (
          <p className="cmp-refusal" role="status">
            {populationFallbackText(populationCheck.dropped)}
          </p>
        ) : null}

        {shown && cards.length >= MIN_CARDS && !comparison.error ? (
          <section className="cmp-panel" aria-labelledby="cmp-facts-title">
            <h2 id="cmp-facts-title" className="cmp-panel-title">
              About these cards
            </h2>
            <CardFacts cards={shown.cards} cardReasons={cardReasons} lens={shown.filters.lens} setting={specificSetting(shown.filters.context)} />
          </section>
        ) : null}

        <section className="cmp-panel" aria-labelledby="cmp-results-title" aria-busy={isStale} id="cmp-results" tabIndex={-1}>
          <div className="cmp-panel-head">
            <div className="cmp-panel-heading">
              {shown && scope === 'chapter' ? (
                <button type="button" className="button-back cmp-back" onClick={() => setChapterId(null)}>
                  <Icon name="chevronLeft" size={16} />
                  All chapters
                </button>
              ) : null}
              <h2 id="cmp-results-title" className="cmp-panel-title">
                {shown && scope === 'chapter' && chapterTitle ? chapterTitle : 'Results'}
              </h2>
              <p className="cmp-context-line">
                <Icon name="population" size={16} />
                <span>
                  <span className="visually-hidden">Results for </span>
                  {contextWords}
                </span>
              </p>
              {isStale ? (
                <p className="cmp-updating" role="status">
                  Updating…
                </p>
              ) : null}
            </div>
            {shown && cards.length >= MIN_CARDS ? (
              <div className="cmp-panel-tools">
                <SegmentedControl
                  label="Rows"
                  size="small"
                  value={show}
                  onChange={setShow}
                  options={showOptions(counts, cardReasons)}
                />
                <SegmentedControl label="Explanation depth" size="small" options={DEPTH_OPTIONS} value={depth} onChange={setDepth} />
                <Select
                  label="Order"
                  value={sort}
                  options={[
                    { value: SORTS.atlas, label: 'Atlas order' },
                    { value: SORTS.difference, label: 'Largest difference' }
                  ]}
                  onChange={setSort}
                />
              </div>
            ) : null}
          </div>
          {cardReasons.length && cards.length >= MIN_CARDS ? (
            <div className="cmp-card-reasons" role="note">
              <Icon name="info" size={18} />
              <p>
                <strong>{NOT_COMPARABLE} on every row:</strong>{' '}
                {cardReasons.map((reason) => reasonText(reason, names, shown.cards.length, { cards: shown.cards })).join('; ')}.
              </p>
            </div>
          ) : null}
          {shown && entries.length === 0 && cards.length >= MIN_CARDS && !comparison.error ? (
            <p className="cmp-empty">No row matches. {show === SHOW.comparable && cardReasons.length ? 'The reasons above hold on every row.' : 'Show all rows to see them.'}</p>
          ) : (
            results
          )}
        </section>

        {cards.length >= MIN_CARDS ? (
          <details className="cmp-rule">
            <summary>How comparability is judged</summary>
            <p>
              A row is directly comparable when every card has a result and none of these applies. The rule is a prototype heuristic, the same for
              every reader; it never changes a grade.
            </p>
            <ul>
              {Object.entries(REASON_RULES).map(([code, rule]) => (
                <li key={code}>{rule}</li>
              ))}
            </ul>
          </details>
        ) : null}

        {shown ? (
          <footer className="cat-foot">
            <span>Dataset version {shown.dataset_version}</span>
            <HelpTip label="About these figures">
              <p>
                Performance with its confidence interval{depth === 'expert' ? '; the letter is the evidence grade' : ''}. Status bands are prototype
                heuristics. Open a cell to see that card’s atlas at the condition.
              </p>
            </HelpTip>
            {/* Another classification names its source and the WHO mapping tables, as the Classification choice does. */}
            {activeOntology && activeOntology.id !== ICD11 ? (
              <span className="cat-foot-attribution">
                {`${ontologyNotice(activeOntology)} ${ontologyAttribution(activeOntology)} ${mappingSourceAttribution(activeOntology)}`.trim()}
              </span>
            ) : null}
          </footer>
        ) : null}
      </main>
    </div>
  );
}
