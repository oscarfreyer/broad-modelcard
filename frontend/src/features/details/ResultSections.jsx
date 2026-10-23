import { useState } from 'react';
import { withHelp } from '../../design/HelpTip.js';
import Icon from '../../design/Icon.jsx';
import RangeChart from '../../design/RangeChart.jsx';
import StatusLabel from '../../design/StatusLabel.jsx';
import { SYNTHETIC_NOTE } from './copy/aboutResult.js';
import { describeSafeguards } from './copy/safeguardCopy.js';
import { rankWarnings, warningScope } from './copy/warningCopy.js';

/**
 * The function's requirement (clinician review), stated once under a card's
 * title rather than listed as a warning. `requirement` comes from
 * splitRequirement (copy/warningCopy.js).
 */
export function RequirementLine({ requirement, depth }) {
  if (!requirement) {
    return null;
  }
  return (
    <p className="detail-requirement">
      <Icon name="shield" size={16} />
      <span>
        <strong>{requirement.title}.</strong> {depth === 'expert' ? requirement.expertSummary : requirement.patientSummary}
      </span>
    </p>
  );
}

const RELEVANCE_TONE = { High: 'weak', Medium: 'moderate', Low: 'absent' };

/**
 * One metric: tinted label, status, the big figure, the range chart, its
 * meaning. A metric without a value and with an absence status (Not
 * validated, Out of scope, No data) names the state once, in its header,
 * and then says what it means.
 */
export function MetricSection({ section, isActiveView, depth = 'plain' }) {
  const { viewId, label, status, statusWord = null, grade, figure, chart, meaning, help = null, facts, isAbsent = false } = section;
  const spoken = figure.value ? `${label} ${figure.value}` : `${label} ${figure.word}`;
  return (
    <section className={`metric-section${isActiveView ? ' is-active-view' : ''}`} aria-label={label}>
      <header className="metric-section-head">
        {withHelp(
          <h3 className={`metric-section-label tint-${viewId}`}>
            <Icon name={viewId} size={18} />
            {label}
          </h3>,
          [help],
          `About ${label}`
        )}
        {status ? (
          <StatusLabel status={status} grade={grade} />
        ) : (
          <span className="status-label status-label-regular is-neutral">
            <span className="status-word">{statusWord}</span>
          </span>
        )}
      </header>
      {isAbsent ? null : (
        <>
          <p className="metric-figure">
            {figure.value ? (
              <>
                <span className="metric-figure-value">{figure.value}</span>
                <span className="metric-figure-unit">{figure.unit}</span>
              </>
            ) : (
              <span className="metric-figure-word">{figure.word}</span>
            )}
          </p>
          <RangeChart model={chart} valueLabel={spoken} axis={depth === 'expert' ? 'values' : 'words'} />
        </>
      )}
      {meaning ? <p className="metric-meaning">{meaning}</p> : null}
      {facts?.length ? (
        <dl className="fact-list">
          {facts.map((fact) => (
            <div key={fact.label} className="fact-row">
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/**
 * Warnings, ranked; each opens to its detail. On an aggregated row each
 * warning says how many of its conditions or population groups it applies to.
 *
 * @param {object} props
 * @param {string} [props.source] the row's `provenance.source`
 */
export function WarningList({ warnings, depth, source }) {
  const [openCodes, setOpenCodes] = useState({});
  const ranked = rankWarnings(warnings);
  if (!ranked.length) {
    return <p className="list-empty">No warnings for this result.</p>;
  }
  return (
    <ul className="inset-list">
      {ranked.map((warning) => {
        const isOpen = Boolean(openCodes[warning.code]);
        const scope = warningScope(warning, source);
        return (
          <li key={warning.code} className="inset-row">
            <button
              type="button"
              className="inset-row-button"
              aria-expanded={isOpen}
              onClick={() => setOpenCodes((current) => ({ ...current, [warning.code]: !current[warning.code] }))}
            >
              <span className="inset-row-main">
                <span className="inset-row-title">{warning.title}</span>
                {scope ? <span className="inset-row-scope">{scope}</span> : null}
                <span className="inset-row-text">{depth === 'expert' ? warning.expertSummary : warning.patientSummary}</span>
              </span>
              <span className={`priority-chip tone-${RELEVANCE_TONE[warning.relevance] ?? 'absent'}`}>{warning.relevance}</span>
              <Icon name="chevronDown" size={16} className={`disclosure${isOpen ? ' is-open' : ''}`} />
            </button>
            {isOpen ? <p className="inset-row-detail">{warning.detail}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Recommended safeguards in API order (most urgent first), with actions at
 * expert depth. No priority pill: the warnings above carry the one severity
 * scale on the card (audit A28).
 */
export function SafeguardList({ safeguards, depth }) {
  const described = describeSafeguards(safeguards);
  if (!described.length) {
    return <p className="list-empty">No safeguards listed.</p>;
  }
  return (
    <ul className="inset-list">
      {described.map((safeguard) => (
        <li key={safeguard.id} className="inset-row is-static">
          <div className="inset-row-button">
            <span className="inset-row-main">
              <span className="inset-row-title">{safeguard.title}</span>
              <span className="inset-row-text">{depth === 'expert' ? safeguard.expertSummary : safeguard.patientSummary}</span>
              {depth === 'expert' ? (
                <ul className="action-list">
                  {safeguard.actions.map((action) => (
                    <li key={action}>{action}</li>
                  ))}
                </ul>
              ) : null}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function AboutResult({ sentences }) {
  // The synthetic-data sentence is the heading's help; the header badge says it on every page.
  const shown = sentences.filter((sentence) => sentence !== SYNTHETIC_NOTE);
  return (
    <section className="about-block" aria-label="About this result">
      {withHelp(<h3 className="group-heading">About this result</h3>, [sentences.includes(SYNTHETIC_NOTE) ? SYNTHETIC_NOTE : null], 'About these data')}
      <div className="about-text">
        {shown.map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
      </div>
    </section>
  );
}
