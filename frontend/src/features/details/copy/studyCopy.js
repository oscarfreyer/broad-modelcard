// "How was this assessed?" and "Study quality" on the condition card (contract v1.13, CONTRACT.md §22): the study behind a result and the terms
// of its evidence signal, in words. The API serves the terms (`appraisal`);
// their weights and the study adjustments come from /meta, never from here.
// Study quality is about how the underlying study was run, never about how
// patient groups differ. Every study is synthetic and fictional.
import { isRollupWithoutChildren } from '../../../design/status.js';
import { evidenceAgeFacts } from './evidenceAgeCopy.js';

const DESIGN_NOUNS = Object.freeze({
  vignette: 'vignette study',
  simulation: 'simulation study',
  benchmark: 'benchmark study',
  retrospective: 'retrospective study',
  prospective: 'prospective study',
  real_world_deployment: 'real-world deployment review',
  randomized_trial: 'randomized trial'
});

/** A study's design as a name, the same on the condition card, the comparison, effects, and exports. */
export const DESIGN_LABELS = Object.freeze({
  vignette: 'Vignette study',
  simulation: 'Simulation study',
  benchmark: 'Benchmark',
  retrospective: 'Retrospective study',
  prospective: 'Prospective study',
  real_world_deployment: 'Real-world deployment',
  randomized_trial: 'Randomized trial'
});

const CONDUCTED = Object.freeze({ developer: 'by the developer', independent: 'independently', hospital: 'by a hospital' });

export const CONDUCTOR_LABELS = Object.freeze({ developer: 'The developer', independent: 'An independent group', hospital: 'A hospital' });

/** Who conducted a study, inside a sentence ("by an independent group"). */
export const CONDUCTOR_PHRASES = Object.freeze({ developer: 'the developer', independent: 'an independent group', hospital: 'a hospital' });

export const GUIDELINE_LABELS = Object.freeze({
  none: 'None',
  tripod_ai: 'TRIPOD+AI',
  stard_ai: 'STARD-AI',
  consort_ai: 'CONSORT-AI',
  decide_ai: 'DECIDE-AI',
  other: 'Another guideline'
});

export const FOLLOWED_LABELS = Object.freeze({ yes: 'followed', partly: 'partly followed', no: 'not followed' });

export const RISK_OF_BIAS_LABELS = Object.freeze({ low: 'Low', some_concerns: 'Some concerns', high: 'High', unclear: 'Unclear' });

const RISK_PHRASES = Object.freeze({
  low: 'risk of bias low',
  some_concerns: 'some concerns about bias',
  high: 'risk of bias high',
  unclear: 'risk of bias unclear'
});

// The evidence signal's terms in CONTRACT.md §4.2 order; weights from /meta.
const TERM_LABELS = [
  ['type', 'Validation type'],
  ['studies', 'Studies'],
  ['sites', 'Sites'],
  ['peer', 'Peer review'],
  ['size', 'Sample size']
];

const MINUS = '−';

/** "+0.05", "−0.10", "0.00": a change to the evidence signal. */
export function signed(value, digits = 2) {
  if (!Number.isFinite(value)) return '';
  const text = Math.abs(value).toFixed(digits);
  if (Number(text) === 0) return (0).toFixed(digits);
  return `${value > 0 ? '+' : MINUS}${text}`;
}

const count = (value, noun) => `${Number(value).toLocaleString('en-US')} ${noun}${value === 1 ? '' : 's'}`;

/** "followed TRIPOD+AI", "partly followed STARD-AI", "no reporting guideline". */
export function guidelinePhrase(study) {
  if (!study || study.reporting_guideline === 'none') return 'no reporting guideline';
  const name = study.reporting_guideline === 'other' ? 'another reporting guideline' : GUIDELINE_LABELS[study.reporting_guideline] ?? study.reporting_guideline;
  if (study.guideline_followed === 'partly') return `partly followed ${name}`;
  if (study.guideline_followed === 'no') return `did not follow ${name}`;
  return `followed ${name}`;
}

/** "TRIPOD+AI, followed", or "None". */
export function guidelineValue(study) {
  if (!study || study.reporting_guideline === 'none') return GUIDELINE_LABELS.none;
  const followed = FOLLOWED_LABELS[study.guideline_followed];
  return `${GUIDELINE_LABELS[study.reporting_guideline] ?? study.reporting_guideline}${followed ? `, ${followed}` : ''}`;
}

/**
 * The plain sentence for a study: "One prospective study at 4 sites,
 * conducted independently, followed TRIPOD+AI; risk of bias low."
 */
export function studySentence(study) {
  const design = DESIGN_NOUNS[study.design] ?? 'study';
  const conducted = CONDUCTED[study.conducted_by] ?? '';
  const risk = RISK_PHRASES[study.risk_of_bias] ?? 'risk of bias not stated';
  return `One ${design} at ${count(study.sites, 'site')}${conducted ? `, conducted ${conducted}` : ''}, ${guidelinePhrase(study)}; ${risk}.`;
}

// Contract v1.14 (CONTRACT.md §22): optional study fields, shown as stated and never graded.
export const APPLICABILITY_LABELS = Object.freeze({ low: 'Low', high: 'High', unclear: 'Unclear' });
export const QUALITY_TOOL_LABELS = Object.freeze({ probast_ai: 'PROBAST+AI', appraise_ai: 'APPRAISE-AI', quadas_ai: 'QUADAS-AI', other: 'Another tool' });
export const SETTING_CATEGORY_LABELS = Object.freeze({
  emergency_department: 'Emergency department',
  intensive_care: 'Intensive care',
  inpatient_ward: 'Inpatient ward',
  outpatient_clinic: 'Outpatient clinic',
  primary_care: 'Primary care',
  mixed: 'Mixed settings'
});

/** "APPRAISE-AI score 72 of 100", "PROBAST+AI", or null when no tool is stated. */
export function appraisalToolValue(study) {
  if (!study?.quality_tool) return null;
  const tool = QUALITY_TOOL_LABELS[study.quality_tool] ?? study.quality_tool;
  if (!Number.isFinite(study.quality_score)) return tool;
  const score = Number.isInteger(study.quality_score) ? String(study.quality_score) : study.quality_score.toFixed(1);
  return `${tool} score ${score} of 100`;
}

/**
 * Study quality: risk of bias, applicability concerns, guideline, appraisal tool, who ran it,
 * and the setting and configuration it evaluated (the same at both depths; notes at expert depth).
 * Fields a study does not state are left out. With the card's `ageContext` (contract v1.14,
 * §28.5; evidenceAgeContext) the configuration reads against the card's current one
 * ("Evaluated configuration") and another version evaluated is named ("Measured on").
 */
export function studyQualityFacts(study, depth = 'plain', ageContext = null) {
  const tool = appraisalToolValue(study);
  const facts = [
    { label: 'Risk of bias', value: RISK_OF_BIAS_LABELS[study.risk_of_bias] ?? study.risk_of_bias },
    ...(study.applicability ? [{ label: 'Applicability concerns', value: APPLICABILITY_LABELS[study.applicability] ?? study.applicability }] : []),
    { label: 'Reporting guideline', value: guidelineValue(study) },
    ...(tool ? [{ label: 'Appraisal tool', value: tool }] : []),
    { label: 'Conducted by', value: CONDUCTOR_LABELS[study.conducted_by] ?? study.conducted_by },
    ...(study.setting_category ? [{ label: 'Setting', value: SETTING_CATEGORY_LABELS[study.setting_category] ?? study.setting_category }] : []),
    ...(ageContext ? evidenceAgeFacts(study, ageContext) : study.configuration_id ? [{ label: 'Configuration evaluated', value: study.configuration_id }] : [])
  ];
  if (depth === 'expert' && study.risk_of_bias_notes) {
    facts.push({ label: 'Risk-of-bias notes', value: study.risk_of_bias_notes });
  }
  if (depth === 'expert' && study.applicability_notes) {
    facts.push({ label: 'Applicability notes', value: study.applicability_notes });
  }
  return facts;
}

/** The study record at expert depth. */
export function studyRecordFacts(study) {
  return [
    { label: 'Study', value: `${study.title} (${study.study_id})` },
    { label: 'Design', value: DESIGN_LABELS[study.design] ?? study.design },
    { label: 'Setting', value: study.setting },
    { label: 'Sites', value: Number(study.sites).toLocaleString('en-US') },
    { label: 'Patients', value: Number(study.patients).toLocaleString('en-US') },
    { label: 'Peer reviewed', value: study.peer_reviewed ? 'Yes' : 'No' },
    { label: 'Population', value: study.population },
    { label: 'Evaluation', value: study.evaluation_conditions },
    ...(study.model_version ? [{ label: 'Model version', value: study.model_version }] : []),
    { label: 'Published', value: study.publication_date }
  ];
}

/**
 * The signal's terms with their weights (expert depth): each term's score
 * times its weight, the sum before penalties, the penalties, the study's two
 * adjustments, and the signal with its grade.
 *
 * @param {object} terms contract EvidenceSignalTerms
 * @param {object|null} weights /meta evidence_signal_weights
 */
export function signalTermFacts(terms, weights) {
  const weighted = TERM_LABELS.map(([key, label]) => ({
    label,
    value: Number.isFinite(weights?.[key]) ? `${terms[key].toFixed(2)} × ${Math.round(weights[key] * 100)}%` : terms[key].toFixed(2)
  }));
  return [
    ...weighted,
    { label: 'Before penalties', value: terms.base_signal.toFixed(3) },
    { label: 'Penalties', value: signed(terms.penalties) },
    { label: 'Reporting guideline', value: signed(terms.guideline_adjustment) },
    { label: 'Risk of bias', value: signed(terms.risk_of_bias_adjustment) },
    { label: 'Evidence signal', value: `${terms.signal.toFixed(3)}, grade ${terms.grade}` }
  ];
}

const isAggregated = (row) => row?.provenance?.source === 'rollup' || Boolean(row?.provenance?.lens_fallback);

/**
 * What "How was this assessed?" says about a row.
 *
 * @param {{ row: object|null, depth: 'plain'|'expert', weights?: object|null, adjustments?: object|null }} input
 *   row: contract MetricRow; weights: /meta evidence_signal_weights;
 *   adjustments: /meta evidence_study_adjustments
 * @returns {{ lines: string[], facts: {label: string, value: string}[], record: {label: string, value: string}[] }}
 */
export function assessment({ row, depth, weights = null, adjustments = null }) {
  const expert = depth === 'expert';
  const appraisal = row?.appraisal ?? null;
  if (!row || isRollupWithoutChildren(row)) {
    return { lines: ['There is no result to assess.'], facts: [], record: [] };
  }
  if (!row.evidence_grade) {
    return { lines: ['No validation evidence, so there is nothing to assess.'], facts: [], record: [] };
  }
  if (isAggregated(row)) {
    const noun = row.provenance?.source === 'rollup' ? 'conditions' : 'population groups';
    if (!appraisal) {
      return {
        lines: [`Combines several ${noun}; none links a study record.`],
        facts: expert ? weightFacts(weights) : [],
        record: []
      };
    }
    const mean = signed(appraisal.study_adjustment, expert ? 3 : 2);
    return {
      lines: [
        expert
          ? `Combines several ${noun}. The mean study adjustment of its rows (${mean}${row.provenance?.source === 'rollup' ? ', weighted by prevalence' : ''}) is added to the evidence signal.`
          : `Combines several ${noun}. Their linked studies move the evidence score by ${mean} on average.`
      ],
      facts: [],
      record: []
    };
  }
  if (!appraisal?.study) {
    return {
      lines: [
        expert
          ? 'No study record is linked. The evidence signal comes from this row’s own counts.'
          : 'No study record is linked. The grade comes from the counts on this result (synthetic).'
      ],
      facts: expert ? weightFacts(weights) : [],
      record: []
    };
  }
  const { study } = appraisal;
  const lines = [studySentence(study)];
  if (!appraisal.applied) {
    lines.push('The grade is the stored one, so the study does not change it.');
  } else if (!expert) {
    lines.push(adjustmentSentence(appraisal.study_adjustment, adjustments));
  }
  return {
    lines,
    facts: expert && appraisal.terms ? signalTermFacts(appraisal.terms, weights) : [],
    record: expert ? studyRecordFacts(study) : []
  };
}

function adjustmentSentence(value, adjustments) {
  const bonus = Number.isFinite(adjustments?.guideline_followed) ? ` (a followed guideline adds ${signed(adjustments.guideline_followed)})` : '';
  if (!value) return `The study leaves the evidence score as it is${bonus}.`;
  return `The study moves the evidence score by ${signed(value)}${value > 0 ? '' : bonus}.`;
}

function weightFacts(weights) {
  if (!weights) return [];
  return TERM_LABELS.filter(([key]) => Number.isFinite(weights[key])).map(([key, label]) => ({
    label,
    value: `weight ${Math.round(weights[key] * 100)}%`
  }));
}

/**
 * The Study quality section: the linked study's risk of bias, guideline, and
 * who ran it, or a plain line when no study record is linked.
 *
 * @returns {{ lead: string|null, help?: string, facts: {label: string, value: string}[] }}
 */
export function studyQuality(row, depth = 'plain', ageContext = null) {
  const study = row?.appraisal?.study ?? null;
  if (study) {
    // What the section is about is its help; the facts are the content.
    return { lead: null, help: 'How the study behind this result was run, not how patient groups differ.', facts: studyQualityFacts(study, depth, ageContext) };
  }
  if (isAggregated(row)) {
    return { lead: 'Combines several rows; open a condition to see its study.', facts: [] };
  }
  // Not appraised is named here in words (§22).
  return { lead: row?.evidence_grade ? 'Not appraised: no study record is linked to this result.' : 'No study record is linked to this result.', facts: [] };
}
