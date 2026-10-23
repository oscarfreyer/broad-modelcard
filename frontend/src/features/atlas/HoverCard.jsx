import RangeChart from '../../design/RangeChart.jsx';
import { formatScore, mapRangeValues, rangeModel } from '../../design/rangeScale.js';
import StatusLabel from '../../design/StatusLabel.jsx';
import StatusMark from '../../design/StatusMark.js';
import { displayFor, isRollupWithoutChildren, isSafetyView, mapRowStatus, presentedRow, ringStatus } from '../../design/status.js';
import { emptyRollupSentence } from '../details/copy/aboutResult.js';
import { prevalenceTierLabel } from '../../shared/prevalenceTiers.js';
import { conceptCode, conceptName } from '../../shared/conceptName.js';
import { incidentHint, tallyText } from './safetyTally.js';
import { localLayerOf } from './localLayer.js';
import { coreNoDataText, coreText } from './coreText.js';

const LEVEL_WORDS = { 0: 'Chapter', 1: 'Subchapter', 2: 'Condition' };

/**
 * One-line result for a hovered or focused bubble: name, code, status, and
 * for scored views the value on a compact range bar, with the confidence
 * interval as a whisker on the Performance view (map columns ci_low, ci_high).
 *
 * @param {object} props
 * On the Safety view it shows the incident mark and, for a subchapter, how
 * many of its conditions are marked (`tally`); a marked condition points to
 * its card, where the incidents are listed. On the other views a reported
 * incident adds one line with its Safety mark (`incidentHint`).
 *
 * @param {{ x: number, y: number, placeAbove: boolean, placeLeft: boolean }} props.position stage coordinates
 * @param {{ serious: number, caution: number, total: number }|null} [props.tally] Safety view, subchapters
 * @param {string|null} [props.resultFor] who the result is for (resultPopulation.js)
 */
export default function HoverCard({ concept, row, tile, viewId, statusBands, position, isCombinationMode, isExpert, hasIntendedUse = true, isLoading = false, core = null, tally = null, resultFor = null }) {
  // While the results load (a chapter opening, a view or card switch) the
  // card says Loading, never No data (audit A4).
  const status = ringStatus(row, viewId, { isCombinationMode, hasIntendedUse, isLoading });
  // The range bar shows the result; on Overview an incident's mark sits over it.
  const resultStatus = isCombinationMode ? status : mapRowStatus(row, viewId, { hasIntendedUse, withSafety: false });
  const range = isLoading ? { value: null } : mapRangeValues(presentedRow(row), viewId);
  const { value } = range;
  const code = conceptCode(concept, { isExpert });
  const grade = isExpert ? presentedRow(row)?.[`${viewId}_grade`] ?? null : null;
  // A rollup without children reads No data and says why (CONTRACT.md §6, V1).
  const isEmptyRollup = !isLoading && !isCombinationMode && !isSafetyView(viewId) && isRollupWithoutChildren(row);
  const incident = isLoading ? null : incidentHint(row, concept, viewId, { isCombinationMode, hasIntendedUse });
  const local = isLoading ? null : localLayerOf(row, viewId, { isCombinationMode });
  let detail = LEVEL_WORDS[concept.level] ?? 'Concept';
  if (Number.isFinite(tile?.disease_count) && concept.level < 2) {
    detail = `${detail}, ${tile.disease_count} ${tile.disease_count === 1 ? 'condition' : 'conditions'}`;
  } else if (concept.level === 2 && prevalenceTierLabel(concept)) {
    detail = `${detail}, ${prevalenceTierLabel(concept)}`;
  }
  const style = {
    left: `${position.x}px`,
    top: `${position.y}px`,
    transform: `translate(${position.placeLeft ? 'calc(-100% - 14px)' : '14px'}, ${position.placeAbove ? 'calc(-100% - 6px)' : '6px'})`
  };

  return (
    <div className="hover-card" style={style} role="tooltip">
      <p className="hover-card-name">{conceptName(concept)}</p>
      <p className="hover-card-meta">
        {code ? (
          <>
            <span className="code">{code}</span>{' '}
          </>
        ) : null}
        {detail}
      </p>
      <div className="hover-card-result">
        <StatusLabel status={status} grade={grade} />
        {value != null ? <span className="hover-card-value">{formatScore(value)}</span> : null}
      </div>
      {isEmptyRollup ? <p className="hover-card-meta">{emptyRollupSentence(concept)}</p> : null}
      {isSafetyView(viewId) && tally ? <p className="hover-card-meta">{tallyText(tally)}</p> : null}
      {isSafetyView(viewId) && !tally && concept.level === 2 && displayFor(status).form === 'alert' ? (
        <p className="hover-card-meta">Select it to read its incidents.</p>
      ) : null}
      {incident ? (
        <p className="hover-card-meta hover-card-incident">
          <StatusMark status={incident.status} size={12} /> {incident.text}
        </p>
      ) : null}
      {core && displayFor(status).form === 'fill' ? (
        <p className="hover-card-meta">
          <StatusMark status={core.status} size={12} /> {coreText(core)}
          {coreNoDataText(core) ? <>; {coreNoDataText(core)}</> : null}
        </p>
      ) : null}
      {value != null ? (
        <RangeChart size="compact" model={rangeModel({ view: viewId, ...range, statusBands, status: resultStatus })} valueLabel={formatScore(value)} />
      ) : null}
      {local ? (
        <p className="hover-card-meta hover-card-local">
          <span className={`local-dot${local === 'includes_local' ? ' is-within' : ''}`} aria-hidden="true" />
          {local === 'local' ? 'Local result: the hospital’s own evaluation.' : 'Holds local results.'}
        </p>
      ) : null}
      {resultFor ? <p className="hover-card-for">For {resultFor}</p> : null}
    </div>
  );
}
