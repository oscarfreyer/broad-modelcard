// Audience presets: who is reading, chosen once per browser
// ("Your defaults", or the small first-visit choice) and kept in the profile
// as `defaults.audience`. A preset changes where a card starts, never what it
// says: every reader sees the same figures (principle 3).
//
// What each preset does:
// - clinician: plain depth, Overview; a condition card opens with its status
//   and "Across groups" (open, right under the header).
// - patient: plain depth, Overview; a condition card leads with a one-line
//   plain summary and hides the expert fact tables (evidence facts, study
//   record facts) while the depth is plain.
// - procurement (Procurement and governance): expert depth, Overview; the
//   Summary comes first on the atlas (no card opens by itself), and a
//   condition card opens "How was this assessed?" and shows it and "Study
//   quality" right under the header.
// - regulator (release 0.5): expert depth, Overview; a condition
//   card shows "Safety incidents" and "Study quality" right under the header.
// - payer (release 0.5): expert depth, Overview; a condition card
//   shows "Effects on outcomes" right under the header.
// Each preset also heads the atlas Summary with its own short summary
// (features/summary/audienceModel.js), built from the same figures.
//
// Precedence, highest first: an explicit URL parameter (a link that carries
// atlas state opens exactly what it names, with no default at all,
// profileDefaults.js), an explicit default in this browser ("Your defaults"
// depth), the audience preset, the app's own default. The card layout (which
// sections open first) follows the preset on every link: it changes no figure.
import { DISPLAY } from '../../design/status.js';

export const AUDIENCE_IDS = Object.freeze(['clinician', 'patient', 'procurement', 'regulator', 'payer']);

export const AUDIENCES = Object.freeze([
  { id: 'clinician', label: 'Clinician', help: 'Plain words. A condition card opens with its results.' },
  { id: 'patient', label: 'Patient', help: 'The plainest words. A condition card starts with a one-line summary.' },
  {
    id: 'procurement',
    label: 'Procurement and governance',
    help: 'Expert depth. A condition card opens how it was assessed and the study quality first.'
  },
  { id: 'regulator', label: 'Regulator', help: 'Expert depth. A condition card shows safety incidents and study quality first.' },
  { id: 'payer', label: 'Payer', help: 'Expert depth. A condition card shows effects on patient outcomes first.' }
]);

export function isAudience(value) {
  return AUDIENCE_IDS.includes(value);
}

export function audienceLabel(id) {
  return AUDIENCES.find((entry) => entry.id === id)?.label ?? null;
}

/** The starting depth and view of a preset; null for none. */
export const AUDIENCE_PRESETS = Object.freeze({
  clinician: Object.freeze({ depth: 'plain', view: 'overall' }),
  patient: Object.freeze({ depth: 'plain', view: 'overall' }),
  procurement: Object.freeze({ depth: 'expert', view: 'overall' }),
  regulator: Object.freeze({ depth: 'expert', view: 'overall' }),
  payer: Object.freeze({ depth: 'expert', view: 'overall' })
});

export function audiencePreset(audience) {
  return AUDIENCE_PRESETS[audience] ?? null;
}

const DEFAULT_LAYOUT = Object.freeze({
  // Sections right under the header, in order (else in their usual place).
  lead: Object.freeze([]),
  openAssessment: false,
  plainSummary: false,
  hideExpertFacts: false
});

const LAYOUTS = Object.freeze({
  // Values first for everyone; Across groups opens with a click.
  clinician: DEFAULT_LAYOUT,
  patient: Object.freeze({ ...DEFAULT_LAYOUT, plainSummary: true, hideExpertFacts: true }),
  procurement: Object.freeze({ ...DEFAULT_LAYOUT, lead: Object.freeze(['assessment', 'studyQuality']), openAssessment: true }),
  regulator: Object.freeze({ ...DEFAULT_LAYOUT, lead: Object.freeze(['incidents', 'studyQuality']) }),
  payer: Object.freeze({ ...DEFAULT_LAYOUT, lead: Object.freeze(['effects']) })
});

/**
 * How a condition card is laid out for an audience. `hideExpertFacts` only
 * holds at plain depth: a reader who switches to Expert sees every table.
 *
 * @param {string|null|undefined} audience
 * @param {'plain'|'expert'} [depth]
 */
export function cardLayout(audience, depth = 'plain') {
  const layout = LAYOUTS[audience] ?? DEFAULT_LAYOUT;
  return depth === 'expert' && layout.hideExpertFacts ? { ...layout, hideExpertFacts: false } : layout;
}

const word = (status) => (DISPLAY[status]?.label ?? DISPLAY.no_data.label).toLowerCase();

/**
 * The patient preset's one-line lead: the card's Overview mark in the plainest
 * words, from the mark the header shows (never a new judgement).
 *
 * @param {string} overview the Overview display key of the card (`overviewStatus`)
 * @param {{ performance: string, evidence: string }} parts the performance and evidence display keys
 */
export function plainSummary(overview, { performance, evidence } = {}) {
  if (overview === 'serious' || overview === 'caution') {
    return 'In short: a safety problem has been reported here. Read it below before relying on this AI system.';
  }
  if (overview === 'out_of_scope') {
    return 'In short: this AI system is not meant for this condition or these patients.';
  }
  if (['strong', 'moderate', 'weak'].includes(overview)) {
    const works = performance === 'no_data' ? 'not measured' : word(performance);
    const proof = evidence === 'no_data' ? 'missing' : word(evidence);
    return `In short: ${word(overview)} overall. How well it works is ${works}; the proof behind it is ${proof}.`;
  }
  return 'In short: there is no graded result here, so this card cannot say how well the AI system works for it.';
}
