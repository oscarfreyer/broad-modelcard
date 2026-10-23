import { useEffect, useRef, useState } from 'react';
import HelpTip from '../../design/HelpTip.js';
import StatusMark, { StatusMarkShape } from '../../design/StatusMark.js';
import { DISPLAY, keysForView } from '../../design/status.js';
import { localPrevalenceTitle } from '../../shared/localPopulation.js';
import { ontologyNotice } from '../../shared/ontology.js';
import { settingNotice } from '../../shared/careSetting.js';
import { ChangedGlyph } from '../preview/PreviewBanner.jsx';
import { legendKeys, legendMeaning } from './legendEntries.js';
import { GUIDE_OPEN_CATALOGUE } from '../guide/guideCopy.js';

const formatCount = (value) => Number(value || 0).toLocaleString('en-US');

/** A mark, its word, and its count; what it means is the row's tooltip and in the legend's help. */
function LegendRow({ status, label, count, meaning, mark }) {
  const isZero = count === 0;
  return (
    <li className={`legend-row${isZero ? ' is-zero' : ''}`} data-status={status} title={meaning ? `${label}: ${meaning}` : undefined}>
      <span className="legend-mark">{mark ?? <StatusMark status={status} size={12} />}</span>
      <span className="legend-label">{label}</span>
      {count === undefined ? null : <span className="legend-count">{count === null ? '–' : formatCount(count)}</span>}
    </li>
  );
}

/**
 * The atlas legend: its own tile, the ring tile's sibling, at one placement
 * in the atlas, every chapter, both modes, and every view (left of the ring from 768px, under it on a phone; ring.css, responsive.css).
 * Its width is fixed, so the ring's size never depends on what it lists.
 *
 * It shows marks, their words, and the conditions in view with each; a
 * glyph the ring draws besides the marks (changed from live, a local
 * result, a subchapter's centre) is a row too. What the marks mean, the
 * short notes, and the ways to the guides are behind the help button by the
 * title, so the tile reads at a glance.
 *
 * @param {object} props
 * @param {Record<string, number>|null} props.counts display key → conditions in view (null while loading)
 * @param {string} props.viewId
 * @param {boolean} props.hasIntendedUse
 * @param {string[]} props.absences absence states drawn on the ring now
 * @param {string[]} props.safety Safety marks drawn on the ring now
 * @param {{ selectedCount: number, candidateCount: number, hasData: boolean }|null} props.combination multimorbidity mode, else null
 * @param {object|null} [props.ontology] the `/meta.ontologies` entry of another classification on screen (contract v1.13), else null
 * @param {string|null} [props.setting] a specific care setting on screen (contract v1.14), else null
 * @param {boolean} [props.hasLocal] a local result is drawn (contract v1.13, §26)
 * @param {(() => void)|null} [props.onOpenGuide] opens "How to read a card"
 */
export default function RingLegend({
  counts,
  viewId,
  hasIntendedUse = true,
  absences = [],
  safety = [],
  combination = null,
  showCores = false,
  showSubchapters = false,
  showSubtypes = false,
  isPreview = false,
  hasLocal = false,
  population = null,
  onOpenOverviewRule = null,
  onOpenGuide = null,
  ontology = null,
  setting = null
}) {
  const isSafety = viewId === 'safety';
  const isIntendedUse = viewId === 'intended_use';
  // The body scrolls only in a very short window; then it takes a tab stop,
  // so the keyboard can scroll it too.
  const bodyRef = useRef(null);
  const [isScrollable, setIsScrollable] = useState(false);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const check = () => setIsScrollable(body.scrollHeight > body.clientHeight + 1);
    const observer = new ResizeObserver(check);
    observer.observe(body);
    [...body.children].forEach((child) => observer.observe(child));
    check();
    return () => observer.disconnect();
  }, []);

  // [key, label, meaning] of every mark listed, for the rows and the help.
  let entries;
  if (combination) {
    entries = [
      // The colours a candidate can wear, each named (audit A19); the help
      // says they are the combination's result with it.
      ...(isSafety
        ? [['no_incidents', 'A disc', 'can join, in its Safety mark']]
        : keysForView(viewId, { hasIntendedUse })
            .filter((key) => ['fill', 'half'].includes(DISPLAY[key].form))
            .map((key) => [key, DISPLAY[key].label, null])),
      ...safety.filter((key) => key !== 'no_incidents').map((key) => [key, DISPLAY[key].label, legendMeaning(key)]),
      ...['no_combination', ...absences.filter((key) => key !== 'no_combination' && key !== 'loading')].map((key) => [key, DISPLAY[key].label, legendMeaning(key)])
    ];
  } else {
    entries = legendKeys({ viewId, hasIntendedUse, absences, withMapping: Boolean(ontology) }).map((key) => [key, DISPLAY[key].label, legendMeaning(key)]);
  }
  const rows = entries.map(([key, label, meaning]) => (
    <LegendRow key={key} status={key} label={label} meaning={meaning} count={combination ? undefined : counts ? counts[key] ?? 0 : null} />
  ));

  // Glyphs the ring draws besides the marks.
  const glyphs = [];
  if (isPreview) {
    glyphs.push(<LegendRow key="changed" status="changed" label="Changed from live" mark={<ChangedGlyph />} meaning="a ring around a bubble whose result differs from the live data" />);
  }
  if (hasLocal) {
    glyphs.push(
      <LegendRow
        key="local"
        status="local"
        label="Local result"
        meaning={`a dot: a local result${population ? ` for ${population.name}` : ''}, in place of the public one; hollow: holds some`}
        mark={
          <span className="local-sample" aria-hidden="true">
            <span className="local-dot" />
            <span className="local-dot is-within" />
          </span>
        }
      />
    );
  }
  if (showSubchapters && showCores) {
    glyphs.push(
      <LegendRow
        key="core"
        status="core"
        label={isIntendedUse ? 'Centre: no scope fit' : 'Centre: weak share'}
        meaning={isIntendedUse ? 'the share of a subchapter with no scope fit' : 'the share of a subchapter that is weak'}
        mark={
          <span className="core-sample" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 16 16">
              <StatusMarkShape status={isIntendedUse ? 'in_scope' : 'moderate'} cx={8} cy={8} r={7} />
              <StatusMarkShape status={isIntendedUse ? 'out_of_scope' : 'weak'} cx={8} cy={8} r={3.8} className="bubble-core" />
            </svg>
          </span>
        }
      />
    );
  }

  // The legend's help: what each mark means, then the notes for what is on screen.
  const meanings = entries.filter(([, , meaning]) => meaning);
  const notes = [
    combination && !isSafety ? 'Colour: the combination’s result if added.' : null,
    safety.length && !combination ? (viewId === 'overall' ? 'Incidents show instead of the result.' : 'A subchapter shows its worst mark.') : null,
    !hasIntendedUse && !combination ? 'No intended-use statement, so nothing is out of scope.' : null,
    // In another classification (contract v1.13) a subtype has its own mapping, so its own result.
    showSubtypes ? (ontology ? 'Subtypes show the result of their own mapping.' : 'Subtypes share their condition’s result.') : null,
    showSubchapters ? 'Each bubble is a subchapter.' : null,
    population ? `${localPrevalenceTitle(population)}, also synthetic.` : null,
    ontology ? ontologyNotice(ontology) : null,
    setting ? settingNotice(setting) : null
  ].filter(Boolean);
  const help = (
    <HelpTip label="About the legend">
      {meanings.length ? (
        <ul className="legend-help-list">
          {meanings.map(([key, label, meaning]) => (
            <li key={key}>
              <strong>{label}</strong>: {meaning}
            </li>
          ))}
        </ul>
      ) : null}
      {notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
      {(viewId === 'overall' && !combination && onOpenOverviewRule) || onOpenGuide ? (
        <p className="help-tip-links">
          {viewId === 'overall' && !combination && onOpenOverviewRule ? (
            <button type="button" className="button-link" onClick={onOpenOverviewRule} aria-haspopup="dialog">
              How the Overview works
            </button>
          ) : null}
          {onOpenGuide ? (
            <button type="button" className="button-link" onClick={onOpenGuide} aria-haspopup="dialog">
              {GUIDE_OPEN_CATALOGUE}
            </button>
          ) : null}
        </p>
      ) : null}
    </HelpTip>
  );

  return (
    <section className="legend-tile" aria-labelledby="legend-title">
      <header className="legend-header">
        <div className="page-title-row">
          <h2 id="legend-title" className="legend-title">
            Legend
          </h2>
          {help}
        </div>
        <p className="legend-caption" role="status">
          {combination
            ? combination.hasData
              ? `${combination.selectedCount} selected, ${formatCount(combination.candidateCount)} ${combination.selectedCount ? 'can extend it' : 'can start one'}`
              : 'No combination data'
            : counts
              ? 'Conditions in view'
              : 'Loading the counts'}
        </p>
      </header>
      <div
        ref={bodyRef}
        className="legend-body"
        tabIndex={isScrollable ? 0 : undefined}
        role={isScrollable ? 'group' : undefined}
        aria-labelledby={isScrollable ? 'legend-title' : undefined}
      >
        <ul className="legend-list" aria-label={combination ? 'Marks in combination mode' : 'Conditions by mark'}>
          {rows}
        </ul>
        {glyphs.length ? (
          <ul className="legend-list is-secondary" aria-label="Other marks on the ring">
            {glyphs}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
