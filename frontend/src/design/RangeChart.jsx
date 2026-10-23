import StatusMark from './StatusMark.js';
import { rangeAbsence } from './rangeScale.js';
import { ABSENCE_MEANING, DISPLAY } from './status.js';

const ZONE_WORDS = { strong: 'Strong', moderate: 'Moderate', weak: 'Weak' };
const SCOPE_STEPS = ['out_of_scope', 'partially_in_scope', 'in_scope'];
const SCOPE_WORDS = { out_of_scope: 'Out of scope', partially_in_scope: 'Partly', in_scope: 'In scope' };

function describeRange(model, valueLabel) {
  const bands = model.zones
    .map((zone) => `${ZONE_WORDS[zone.status]} ${zone.from.toFixed(2)} to ${zone.to.toFixed(2)}`)
    .join(', ');
  const value = model.value ? `${valueLabel}. ` : 'No value. ';
  const ci = model.ci ? `Confidence interval ${model.ci.low.toFixed(2)} to ${model.ci.high.toFixed(2)}. ` : '';
  return `${value}${ci}Bands: ${bands}.`;
}

/**
 * A scope step's class: the fills in their zone tint; Out of scope neutral
 * until it is the level, then in its barred mark (the same band as the strip).
 */
function scopeZoneClass(step, isActive) {
  const { form, tone } = DISPLAY[step];
  if (form === 'fill') {
    return `tone-${tone}`;
  }
  if (form === 'half') {
    // Partly in scope: the scope tint, half filled when it is the level.
    return isActive ? `strip-${form}` : `tone-${tone}`;
  }
  return isActive ? `strip-${form}` : 'tone-absent';
}

/**
 * In place of a track: the absence state's mark and word (with its meaning
 * at regular size), so a missing value reads as the same state as on the
 * ring, never as an empty bar.
 */
function AbsenceRange({ status, size, label }) {
  const key = DISPLAY[status] ? status : 'no_data';
  const word = DISPLAY[key].label;
  const meaning = size === 'regular' ? ABSENCE_MEANING[key] : null;
  return (
    <div className={`range range-${size} range-absent`} role="img" aria-label={`${label ? `${label}: ` : ''}${word}, no value on the range`}>
      <span className="range-absent-row" data-status={key}>
        <StatusMark status={key} size={size === 'compact' ? 12 : 14} />
        <span className="range-absent-word">
          {word}
          {meaning ? <span className="range-absent-meaning">: {meaning}</span> : null}
        </span>
      </span>
    </div>
  );
}

/**
 * The Health-style range chart: tinted Strong / Moderate / Weak zones, the
 * value as a dot, the confidence interval as a whisker. With no value, the
 * zone of the row's status is highlighted instead; with no value and an
 * absence status (Out of scope, No data), the absence mark and
 * word take the track's place.
 *
 * @param {object} props
 * @param {ReturnType<import('./rangeScale.js').rangeModel>|{ kind: 'scope', level: string }} props.model
 * @param {'regular'|'compact'} [props.size]
 * @param {string} [props.valueLabel] spoken value, e.g. "Performance 0.84"
 * @param {'values'|'words'} [props.axis] threshold numbers (expert) or zone words (plain)
 */
export default function RangeChart({ model, size = 'regular', valueLabel = '', axis = 'values' }) {
  const absence = rangeAbsence(model);
  if (absence) {
    return <AbsenceRange status={absence} size={size} label={model.kind === 'scope' ? 'Intended use' : valueLabel} />;
  }
  if (model.kind === 'scope') {
    return (
      <div className={`range range-${size} range-scope`} role="img" aria-label={`Intended use: ${DISPLAY[model.level].label}`}>
        <div className="range-track">
          {SCOPE_STEPS.map((step) => (
            <span
              key={step}
              data-status={step}
              className={`range-zone ${scopeZoneClass(step, step === model.level)}${step === model.level ? ' is-active' : ''}`}
            />
          ))}
        </div>
        {size === 'regular' ? (
          <div className="range-zone-labels">
            {SCOPE_STEPS.map((step) => (
              <span key={step} className={step === model.level ? 'is-active' : ''}>
                {SCOPE_WORDS[step]}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const { zones, value, ci, ticks, domain } = model;
  return (
    <div className={`range range-${size}${value ? '' : ' has-no-value'}`} role="img" aria-label={describeRange(model, valueLabel)}>
      <div className="range-track">
        {zones.map((zone) => (
          <span
            key={zone.status}
            className={`range-zone tone-${zone.status}${zone.isActive ? ' is-active' : ''}`}
            style={{ left: `${zone.startPct}%`, width: `${zone.endPct - zone.startPct}%` }}
          />
        ))}
        {ci ? <span className="range-ci" style={{ left: `${ci.startPct}%`, width: `${Math.max(0, ci.endPct - ci.startPct)}%` }} /> : null}
        {value ? (
          <span className={`range-dot${value.clamped ? ` is-clamped-${value.clamped}` : ''}`} style={{ left: `${value.pct}%` }} />
        ) : null}
      </div>
      {size === 'regular' && axis === 'words' ? (
        <div className="range-axis" aria-hidden="true">
          {zones.map((zone) => (
            <span
              key={zone.status}
              className={`range-zone-word${zone.isActive ? ' is-active' : ''}`}
              style={{ left: `${(zone.startPct + zone.endPct) / 2}%` }}
            >
              {ZONE_WORDS[zone.status]}
            </span>
          ))}
        </div>
      ) : null}
      {size === 'regular' && axis === 'values' ? (
        <div className="range-axis" aria-hidden="true">
          <span className="range-tick" style={{ left: '0%' }}>{domain[0].toFixed(2)}</span>
          {ticks.map((tick) => (
            <span key={tick.value} className="range-tick" style={{ left: `${tick.pct}%` }}>
              {tick.label}
            </span>
          ))}
          <span className="range-tick" style={{ left: '100%' }}>{domain[1].toFixed(2)}</span>
        </div>
      ) : null}
    </div>
  );
}
