// The care setting on the condition card (contract v1.14, CONTRACT.md §29). A specific setting reads only the results measured there; when
// it has none for the condition, the card says "No data for this setting" and
// offers the Any-setting result on request, labelled as such and never put in
// the setting's place. React-free.
import { displayFor, metricRowStatus } from '../../../design/status.js';
import { formatScore } from '../../../design/rangeScale.js';
import { NO_DATA_FOR_SETTING, anySettingResultLabel, specificSetting } from '../../../shared/careSetting.js';

const VIEWS = [
  ['overall', 'Overview'],
  ['performance', 'Performance'],
  ['evidence', 'Evidence']
];

function figure(value, grade, depth) {
  if (value == null) return null;
  const shown = formatScore(value);
  return depth === 'expert' && grade ? `${shown} (${grade})` : shown;
}

function cell(row, view, depth, hasIntendedUse) {
  const status = metricRowStatus(row, view, { hasIntendedUse });
  const word = displayFor(status).label;
  if (view === 'overall') return { status, word, figure: figure(row.overall?.score, row.overall?.grade, depth) };
  if (view === 'performance') return { status, word, figure: figure(row.perf, row.performance_grade, depth) };
  return { status, word, figure: depth === 'expert' && row.evidence_grade ? row.evidence_grade : null };
}

/**
 * The empty card at a specific setting: its title and sentence, or null outside a specific setting.
 *
 * @param {string|null} setting the setting's axis value
 * @param {string} noun "condition", "subchapter", "chapter"
 */
export function noSettingResult(setting, noun) {
  const value = specificSetting(setting);
  if (!value) return null;
  return {
    title: NO_DATA_FOR_SETTING,
    text: `No result for this ${noun} was measured in ${value} for the current AI system, function, and population.`
  };
}

/**
 * The Any-setting result shown on request: its label, one line per view, and whether it exists.
 *
 * @param {object|null} row the Any-setting MetricRow (null: none there either)
 * @param {string} setting the specific setting on screen
 * @param {'plain'|'expert'} depth
 * @param {{ hasIntendedUse?: boolean }} [options]
 */
export function anySettingResult(row, setting, depth = 'plain', { hasIntendedUse = true } = {}) {
  const label = anySettingResultLabel(setting);
  if (!row || row.provenance?.rollup?.child_count === 0) {
    return { label, rows: [], text: 'No result in any setting either.' };
  }
  return {
    label,
    rows: VIEWS.map(([view, title]) => ({ view, title, ...cell(row, view, depth, hasIntendedUse) })),
    text: `Measured across care settings, not in ${specificSetting(setting)} alone; shown for reference only.`
  };
}
