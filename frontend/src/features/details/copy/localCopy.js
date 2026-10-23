// Local and public results on the condition card (contract v1.13, CONTRACT.md §26). With a local population chosen, a hospital's own
// evaluation replaces the public result of the same condition and lens; the
// card shows both side by side, with where each comes from. React-free.
import { displayFor, metricRowStatus } from '../../../design/status.js';
import { formatScore } from '../../../design/rangeScale.js';
import { DESIGN_LABELS } from './studyCopy.js';

/** Whether the card's result is a local one. */
export const isLocalRow = (row) => row?.provenance?.layer === 'local';

function score(value, grade, depth) {
  if (value == null) return null;
  const figure = formatScore(value);
  return depth === 'expert' && grade ? `${figure} (${grade})` : figure;
}

function cell(row, view, depth, hasIntendedUse) {
  if (!row) return { word: displayFor('no_data').label, figure: null, status: 'no_data' };
  const status = metricRowStatus(row, view, { hasIntendedUse });
  const word = displayFor(status).label;
  if (view === 'overall') return { word, figure: score(row.overall?.score, row.overall?.grade, depth), status };
  if (view === 'performance') return { word, figure: score(row.perf, row.performance_grade, depth), status };
  return { word, figure: depth === 'expert' && row.evidence_grade ? row.evidence_grade : null, status };
}

const VIEWS = [
  ['overall', 'Overview'],
  ['performance', 'Performance'],
  ['evidence', 'Evidence']
];

/** Where a row comes from: its study's title, else its data source, else nothing. */
function sourceOf(row) {
  const study = row?.appraisal?.study;
  if (study) return study.title;
  return row?.provenance?.data_source?.source ?? null;
}

function studyFacts(row) {
  const study = row?.appraisal?.study;
  const facts = [];
  if (study) {
    facts.push({ label: 'Study', value: `${study.title} (${DESIGN_LABELS[study.design] ?? study.design})` });
    facts.push({ label: 'Patients', value: `${Number(study.patients).toLocaleString('en-US')} at ${study.sites} ${study.sites === 1 ? 'site' : 'sites'}` });
    facts.push({ label: 'Population', value: study.population });
    facts.push({ label: 'Evaluation', value: study.evaluation_conditions });
    facts.push({ label: 'Model version', value: study.model_version ?? row.model_version });
  } else {
    const source = sourceOf(row);
    if (source) facts.push({ label: 'Source', value: source });
    if (row?.n_samples != null) facts.push({ label: 'Patients', value: Number(row.n_samples).toLocaleString('en-US') });
    if (row?.model_version) facts.push({ label: 'Model version', value: row.model_version });
  }
  return facts;
}

/**
 * The comparison: one row per view (Overview, Performance, Evidence) with the
 * local and public word and figure, then the facts of each source.
 *
 * @param {{ metrics: object|null, public_metrics?: object|null, population?: { name: string }|null }} details contract ConceptMetrics
 * @param {'plain'|'expert'} depth
 * @param {{ hasIntendedUse?: boolean }} [options]
 * @returns {null|{ lead: string, rows: object[], local: object[], public: object[], publicMissing: boolean }}
 */
export function localComparison(details, depth = 'plain', { hasIntendedUse = true } = {}) {
  const local = details?.metrics;
  if (!isLocalRow(local)) return null;
  const publicRow = details.public_metrics ?? null;
  const where = details.population?.name ? ` for ${details.population.name}` : '';
  return {
    lead: publicRow
      ? `The result above is the hospital’s own evaluation${where}. It replaces the public result here; both are synthetic.`
      : `The result above is the hospital’s own evaluation${where}. No public result exists for it.`,
    rows: VIEWS.map(([view, label]) => ({ view, label, local: cell(local, view, depth, hasIntendedUse), public: cell(publicRow, view, depth, hasIntendedUse) })),
    local: studyFacts(local),
    public: publicRow ? studyFacts(publicRow) : [],
    publicMissing: !publicRow
  };
}
