import { memo, useMemo } from 'react';
import Icon from '../../design/Icon.jsx';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import StatusLabel from '../../design/StatusLabel.jsx';
import StatusMark from '../../design/StatusMark.js';
import { formatScore } from '../../design/rangeScale.js';
import { DISPLAY, metricRowStatus, viewLabel } from '../../design/status.js';
import { aboutResult } from '../details/copy/aboutResult.js';
import { DEPTH_OPTIONS } from '../../shared/depth.js';
import { metricSections } from '../details/metricSections.js';
import { splitRequirement } from '../details/copy/warningCopy.js';
import { AboutResult, MetricSection, RequirementLine, SafeguardList, WarningList } from '../details/ResultSections.jsx';
import { conceptName } from '../../shared/conceptName.js';
import { displayUseCase } from '../../shared/format.js';

function guidance({ count, hasRow, isLoadingRow, candidateCount }) {
  if (count >= 2 && isLoadingRow) {
    return 'Loading the stored result for this combination…';
  }
  if (count === 0) {
    return 'Choose a coloured condition on the ring to start a combination. Only conditions with stored combination results are coloured.';
  }
  if (count === 1) {
    return candidateCount
      ? `Choose a second condition. ${candidateCount.toLocaleString('en-US')} ${candidateCount === 1 ? 'condition has' : 'conditions have'} a stored result paired with this one.`
      : 'No stored combination includes this condition. Remove it to start again.';
  }
  if (!hasRow) {
    return 'No result is stored for exactly this set of conditions. Remove one, or go back a step.';
  }
  return candidateCount
    ? `${candidateCount.toLocaleString('en-US')} ${candidateCount === 1 ? 'condition can' : 'conditions can'} extend this combination.`
    : 'No stored combination extends this set further.';
}

const CANDIDATE_LIST_LIMIT = 60;

/** The value a view compares, from a contract MetricRow (null when it has none). */
function viewValue(row, viewId) {
  if (!row) {
    return null;
  }
  const value = viewId === 'overall' ? row.overall?.score : viewId === 'performance' ? row.perf : viewId === 'evidence' ? row.evidence_signal : null;
  return Number.isFinite(value) ? value : null;
}

/**
 * The combination against each condition alone, on the active view (audit
 * A19): "Obesity: alone 0.80 Strong, together 0.71 Moderate". Uses each
 * condition's own stored row; Intended use has no value to compare.
 */
function AloneComparison({ selection, singleRowsById, combinationRow, viewId, hasIntendedUse }) {
  if (!singleRowsById || viewId === 'intended_use') {
    return null;
  }
  const together = viewValue(combinationRow, viewId);
  const togetherStatus = metricRowStatus(combinationRow, viewId, { hasIntendedUse });
  return (
    <section aria-label="Compared with each condition alone">
      <h3 className="group-heading">{viewLabel(viewId)}: each condition alone, then together</h3>
      <ul className="inset-list">
        {selection.map((concept) => {
          const row = singleRowsById[concept.concept_id] ?? null;
          const alone = viewValue(row, viewId);
          const aloneStatus = metricRowStatus(row, viewId, { hasIntendedUse });
          return (
            <li key={concept.concept_id} className="inset-row is-static">
              <div className="inset-row-button alone-row">
                <span className="inset-row-main">
                  <span className="inset-row-title">{conceptName(concept)}</span>
                  <span className="alone-values">
                    <span className="alone-value">
                      <StatusMark status={aloneStatus} size={12} />
                      Alone {alone != null ? formatScore(alone) : '–'} {DISPLAY[aloneStatus]?.label ?? ''}
                    </span>
                    <span className="alone-arrow" aria-hidden="true">→</span>
                    <span className="alone-value">
                      <StatusMark status={togetherStatus} size={12} />
                      Together {together != null ? formatScore(together) : '–'} {DISPLAY[togetherStatus]?.label ?? ''}
                    </span>
                  </span>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What a candidate's mark says: the combination's result with it, in words. */
function candidateWord(status) {
  const label = DISPLAY[status]?.label ?? DISPLAY.no_data.label;
  return DISPLAY[status]?.form === 'fill' ? `${label} with it` : label;
}

/** Conditions that can start or extend the combination, as a list to pick from. */
function CandidateList({ candidates, count, onAdd }) {
  if (!candidates.length) {
    return null;
  }
  const shown = candidates.slice(0, CANDIDATE_LIST_LIMIT);
  return (
    <section aria-label="Next conditions">
      <h3 className="group-heading">{count === 0 ? 'Conditions that can start a combination' : 'Conditions that can extend it'}</h3>
      <ul className="inset-list">
        {shown.map(({ concept, status }) => (
          <li key={concept.concept_id} className="inset-row">
            <button type="button" className="inset-row-button candidate-row" onClick={() => onAdd(concept)}>
              <StatusMark status={status} size={12} />
              <span className="inset-row-main">
                <span className="inset-row-title">{conceptName(concept)}</span>
                {/* The word as well as the colour (WCAG 1.4.1, audit A19). */}
                <span className="inset-row-text">
                  <span className="code">{concept.icd11_code || concept.concept_id}</span> {candidateWord(status)}
                </span>
              </span>
              <Icon name="plus" size={18} className="highlight-chevron" />
            </button>
          </li>
        ))}
      </ul>
      {candidates.length > shown.length ? (
        <p className="side-hint">{(candidates.length - shown.length).toLocaleString('en-US')} more are coloured on the ring.</p>
      ) : null}
    </section>
  );
}

/**
 * Multimorbidity: the selected conditions as removable tokens, with Back and
 * Reset, guidance for the next step, and the stored result for the set.
 *
 * @param {object} props
 * @param {object[]} props.selection selected conditions (contract Concepts) in selection order
 * @param {object|null} props.combinationRow contract MetricRow of the exact set
 * @param {{ model: string, useCase: string }[]} props.alternatives cards (AI system × function) that have combination data
 * @param {{ concept: object, status: string }[]} props.candidates conditions that can start or extend the set
 */
function CombinationPanel({
  selection,
  combinationRow,
  isLoadingRow,
  singleRowsById = null,
  candidateCount,
  candidates,
  onAdd,
  hasData,
  modelLabel,
  alternatives,
  onSwitch,
  onRemove,
  onBack,
  onReset,
  depth,
  onDepthChange,
  viewId,
  statusBands,
  overallScoreWeights,
  hasIntendedUse = true
}) {
  const sections = useMemo(
    () => (combinationRow ? metricSections(combinationRow, { depth, statusBands, overallScoreWeights, hasIntendedUse }) : []),
    [combinationRow, depth, hasIntendedUse, statusBands, overallScoreWeights]
  );
  const about = useMemo(() => aboutResult({ concept: null, row: combinationRow, depth }), [combinationRow, depth]);
  // The synthetic-data warning repeats what "About this result" and the
  // legend already say once, plainly (audit A19); the other warnings stay.
  const { requirement, findings } = useMemo(() => {
    const split = splitRequirement(combinationRow?.warnings);
    return { ...split, findings: split.findings.filter((warning) => warning.code !== 'multimorbidity_synthetic_demo') };
  }, [combinationRow]);

  if (!hasData) {
    return (
      <section className="side-card combination-panel" aria-labelledby="combination-title">
        <h2 id="combination-title" className="side-title">Combinations</h2>
        <p className="side-intro">{modelLabel} has no stored multimorbidity results, so the ring shows no combinations.</p>
        {alternatives.length ? (
          <>
            <h3 className="group-heading">AI systems with combination data</h3>
            <ul className="inset-list">
              {alternatives.map((alternative) => (
                <li key={`${alternative.model}|${alternative.useCase}`} className="inset-row">
                  <button type="button" className="inset-row-button" onClick={() => onSwitch(alternative)}>
                    <span className="inset-row-main">
                      <span className="inset-row-title">{alternative.model}</span>
                      <span className="inset-row-text">{displayUseCase(alternative.useCase)}</span>
                    </span>
                    <Icon name="chevronRight" size={18} className="highlight-chevron" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    );
  }

  const count = selection.length;
  return (
    <section className="side-card combination-panel" aria-labelledby="combination-title">
      <div className="detail-head-row">
        <h2 id="combination-title" className="side-title">Combination</h2>
        <div className="button-row">
          <button type="button" className="button-plain" onClick={onBack} disabled={!count}>
            <Icon name="chevronLeft" size={16} />
            Back
          </button>
          <button type="button" className="button-plain" onClick={onReset} disabled={!count}>
            Reset
          </button>
        </div>
      </div>

      {count ? (
        <ul className="token-list" aria-label="Selected conditions">
          {selection.map((concept, index) => (
            <li key={concept.concept_id} className="token">
              <span className="token-index" aria-hidden="true">{index + 1}</span>
              <span className="token-name">{conceptName(concept)}</span>
              <button type="button" className="token-remove" onClick={() => onRemove(concept.concept_id)} aria-label={`Remove ${conceptName(concept)}`}>
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="side-intro">{guidance({ count, hasRow: Boolean(combinationRow), isLoadingRow, candidateCount })}</p>

      {count < 2 ? <CandidateList candidates={candidates} count={count} onAdd={onAdd} /> : null}

      {count >= 2 && combinationRow ? (
        <>
          <div className="detail-head-row">
            <p className="detail-status">
              <StatusLabel status={metricRowStatus(combinationRow, viewId, { hasIntendedUse })} size="large" toned />
              <span className="detail-status-view">{viewLabel(viewId)}</span>
            </p>
            <SegmentedControl size="small" label="Explanation depth" options={DEPTH_OPTIONS} value={depth} onChange={onDepthChange} />
          </div>
          {/* The function's requirement once, as on a single condition's card, never as a warning. */}
          <RequirementLine requirement={requirement} depth={depth} />
          <div className={`metric-stack${isLoadingRow ? ' is-refreshing' : ''}`}>
            {sections.map((section) => (
              <MetricSection key={section.viewId} section={section} isActiveView={section.viewId === viewId} depth={depth} />
            ))}
          </div>
          <AloneComparison selection={selection} singleRowsById={singleRowsById} combinationRow={combinationRow} viewId={viewId} hasIntendedUse={hasIntendedUse} />
          <AboutResult sentences={about} />
          <section aria-label="Warnings">
            <h3 className="group-heading">Warnings</h3>
            <WarningList key={selection.map((concept) => concept.concept_id).join('+')} warnings={findings} depth={depth} source={combinationRow.provenance?.source} />
          </section>
          <section aria-label="Recommended safeguards">
            <h3 className="group-heading">Recommended safeguards</h3>
            <SafeguardList safeguards={combinationRow.safeguards} depth={depth} />
          </section>
        </>
      ) : null}

      {count >= 2 ? <CandidateList candidates={candidates} count={count} onAdd={onAdd} /> : null}
    </section>
  );
}

export default memo(CombinationPanel);
