// The one-study form of the Data Library (contract v1.13, CONTRACT.md §22):
// its choices, checks, and the mapping from form state to the JSON record that
// createRecordsUpload stages as a merge upload, keyed by the studies
// template's column keys so the backend checks it like a spreadsheet row.
// Every study is synthetic and fictional.
import { optionLabel } from './options.js';
import { todayIso } from './records.js';

// Allowed values in the template's words (backend/README.md "Studies").
export const STUDY_DESIGNS = Object.freeze([
  { value: 'vignette', label: 'Vignette' },
  { value: 'simulation', label: 'Simulation' },
  { value: 'benchmark', label: 'Benchmark' },
  { value: 'retrospective', label: 'Retrospective' },
  { value: 'prospective', label: 'Prospective' },
  { value: 'real_world_deployment', label: 'Real-world deployment' },
  { value: 'randomized_trial', label: 'Randomized trial' }
]);
export const STUDY_CONDUCTORS = Object.freeze([
  { value: 'developer', label: 'Developer' },
  { value: 'independent', label: 'Independent' },
  { value: 'hospital', label: 'Hospital' }
]);
export const REPORTING_GUIDELINES = Object.freeze([
  { value: 'none', label: 'None' },
  { value: 'tripod_ai', label: 'TRIPOD+AI' },
  { value: 'stard_ai', label: 'STARD-AI' },
  { value: 'consort_ai', label: 'CONSORT-AI' },
  { value: 'decide_ai', label: 'DECIDE-AI' },
  { value: 'other', label: 'Other' }
]);
export const GUIDELINE_FOLLOWED = Object.freeze([
  { value: 'yes', label: 'Yes' },
  { value: 'partly', label: 'Partly' },
  { value: 'no', label: 'No' }
]);
export const RISKS_OF_BIAS = Object.freeze([
  { value: 'low', label: 'Low' },
  { value: 'some_concerns', label: 'Some concerns' },
  { value: 'high', label: 'High' },
  { value: 'unclear', label: 'Unclear' }
]);

// Contract v1.14 (CONTRACT.md §22): optional, shown with the study, never graded.
export const APPLICABILITY = Object.freeze([
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
  { value: 'unclear', label: 'Unclear' }
]);
export const QUALITY_TOOLS = Object.freeze([
  { value: 'probast_ai', label: 'PROBAST+AI' },
  { value: 'appraise_ai', label: 'APPRAISE-AI' },
  { value: 'quadas_ai', label: 'QUADAS-AI' },
  { value: 'other', label: 'Other' }
]);
export const SETTING_CATEGORIES = Object.freeze([
  { value: 'emergency_department', label: 'Emergency department' },
  { value: 'intensive_care', label: 'Intensive care' },
  { value: 'inpatient_ward', label: 'Inpatient ward' },
  { value: 'outpatient_clinic', label: 'Outpatient clinic' },
  { value: 'primary_care', label: 'Primary care' },
  { value: 'mixed', label: 'Mixed' }
]);

export const MAX_STUDY_TITLE = 200;
export const MAX_STUDY_TEXT = 280;
export const MAX_STUDY_NOTES = 500;
const STUDY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const CONFIGURATION_ID = STUDY_ID;
const SCORE = /^\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COUNT = /^\d+$/;
const URL_START = /^https?:\/\/\S+$/i;

const text = (value) => String(value ?? '').trim();

/** An empty study form. */
export function emptyStudy({ now = new Date() } = {}) {
  return {
    studyId: '',
    editing: null, // { id } while the form edits a stored study
    title: '',
    design: '',
    setting: '',
    sites: '',
    patients: '',
    peerReviewed: '',
    conductedBy: '',
    guideline: '',
    followed: '',
    risk: '',
    riskNotes: '',
    population: '',
    conditions: '',
    model: '',
    publicationDate: todayIso(now),
    sourceUrl: '',
    // Contract v1.13 (§26): a public study, or this hospital's evaluation of a local population.
    scope: 'public',
    localPopulation: '',
    // Contract v1.14 (§22): optional.
    applicability: '',
    applicabilityNotes: '',
    qualityTool: '',
    qualityScore: '',
    settingCategory: '',
    configurationId: ''
  };
}

export const STUDY_SCOPES = Object.freeze([
  { value: 'public', label: 'Public', hint: 'a published or developer study' },
  { value: 'hospital', label: 'Hospital', hint: 'this hospital’s own evaluation of a local population' }
]);

/**
 * What the study form still needs, as { field: message }. The backend checks
 * everything again; this saves a round trip for empty or malformed fields.
 */
export function studyProblems(form) {
  const problems = {};
  if (!STUDY_ID.test(text(form.studyId))) problems.studyId = 'Use letters, digits, ".", "_", or "-" (at most 64).';
  if (!text(form.title)) problems.title = 'Give the study’s title.';
  else if (text(form.title).length > MAX_STUDY_TITLE) problems.title = `At most ${MAX_STUDY_TITLE} characters.`;
  if (!form.design) problems.design = 'Choose the design.';
  if (!text(form.setting)) problems.setting = 'Say where the study took place.';
  else if (text(form.setting).length > MAX_STUDY_TEXT) problems.setting = `At most ${MAX_STUDY_TEXT} characters.`;
  if (!COUNT.test(text(form.sites)) || Number(form.sites) < 1) problems.sites = 'A whole number, at least 1.';
  if (!COUNT.test(text(form.patients))) problems.patients = 'A whole number in digits only, e.g. 1200.';
  if (!form.peerReviewed) problems.peerReviewed = 'Choose Yes or No.';
  if (!form.conductedBy) problems.conductedBy = 'Choose who ran the study.';
  if (!form.guideline) problems.guideline = 'Choose the reporting guideline, or None.';
  else if (form.guideline !== 'none' && !form.followed) problems.followed = 'Say whether the guideline was followed.';
  if (!form.risk) problems.risk = 'Choose the overall risk of bias.';
  if (text(form.riskNotes).length > MAX_STUDY_NOTES) problems.riskNotes = `At most ${MAX_STUDY_NOTES} characters.`;
  if (!text(form.population)) problems.population = 'Say who was studied.';
  else if (text(form.population).length > MAX_STUDY_TEXT) problems.population = `At most ${MAX_STUDY_TEXT} characters.`;
  if (!text(form.conditions)) problems.conditions = 'Say how the AI system was evaluated.';
  else if (text(form.conditions).length > MAX_STUDY_NOTES) problems.conditions = `At most ${MAX_STUDY_NOTES} characters.`;
  if (!ISO_DATE.test(form.publicationDate ?? '')) problems.publicationDate = 'Give the publication date.';
  if (text(form.sourceUrl) && !URL_START.test(text(form.sourceUrl))) problems.sourceUrl = 'Start with https:// or http://, or leave it empty.';
  if (form.scope === 'hospital' && !form.localPopulation) problems.localPopulation = 'Choose the local population this evaluation studied.';
  if (text(form.applicabilityNotes).length > MAX_STUDY_NOTES) problems.applicabilityNotes = `At most ${MAX_STUDY_NOTES} characters.`;
  const score = text(form.qualityScore);
  if (score && (!SCORE.test(score) || Number(score) > 100)) problems.qualityScore = 'A number from 0 to 100, e.g. 72.';
  else if (score && !form.qualityTool) problems.qualityScore = 'Choose the appraisal tool that gave the score, or leave the score empty.';
  if (text(form.configurationId) && !CONFIGURATION_ID.test(text(form.configurationId))) {
    problems.configurationId = 'Use letters, digits, ".", "_", or "-" (at most 64), e.g. cfg-2026-03.';
  }
  return problems;
}

/** The study form as one studies record (template column keys). */
export function studyRecord(form) {
  const hasGuideline = form.guideline && form.guideline !== 'none';
  return {
    study_id: text(form.studyId),
    title: text(form.title),
    design: form.design,
    setting: text(form.setting),
    sites: COUNT.test(text(form.sites)) ? Number(form.sites) : text(form.sites),
    patients: COUNT.test(text(form.patients)) ? Number(form.patients) : text(form.patients),
    peer_reviewed: form.peerReviewed === 'yes' ? true : form.peerReviewed === 'no' ? false : null,
    conducted_by: form.conductedBy,
    reporting_guideline: form.guideline,
    guideline_followed: hasGuideline ? form.followed || null : null,
    risk_of_bias: form.risk,
    risk_of_bias_notes: text(form.riskNotes) || null,
    population: text(form.population),
    evaluation_conditions: text(form.conditions),
    model_version: form.model || null,
    publication_date: form.publicationDate,
    source_url: text(form.sourceUrl) || null,
    scope: form.scope === 'hospital' ? 'Hospital' : 'Public',
    population_id: form.scope === 'hospital' ? form.localPopulation || null : null,
    ...optionalStudyFields(form)
  };
}

/** The optional v1.14 fields (§22) the form states; an empty one is left out, which the check reads as empty. */
function optionalStudyFields(form) {
  const score = text(form.qualityScore);
  const fields = {
    applicability: form.applicability || null,
    applicability_notes: text(form.applicabilityNotes) || null,
    quality_tool: form.qualityTool || null,
    quality_score: SCORE.test(score) ? Number(score) : score || null,
    setting_category: form.settingCategory || null,
    configuration_id: text(form.configurationId) || null
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
}

/**
 * A stored study (listStudies) as the study form, every field as stored and
 * the ID kept, so publishing the form replaces that study. `editing` is never sent.
 *
 * @param {object} stored contract Study
 */
export function storedStudyForm(stored) {
  return {
    studyId: stored.study_id,
    editing: { id: stored.study_id },
    title: stored.title ?? '',
    design: stored.design ?? '',
    setting: stored.setting ?? '',
    sites: String(stored.sites ?? ''),
    patients: String(stored.patients ?? ''),
    peerReviewed: stored.peer_reviewed ? 'yes' : 'no',
    conductedBy: stored.conducted_by ?? '',
    guideline: stored.reporting_guideline ?? '',
    followed: stored.guideline_followed ?? '',
    risk: stored.risk_of_bias ?? '',
    riskNotes: stored.risk_of_bias_notes ?? '',
    population: stored.population ?? '',
    conditions: stored.evaluation_conditions ?? '',
    model: stored.model_version ?? '',
    publicationDate: stored.publication_date ?? '',
    sourceUrl: stored.source_url ?? '',
    scope: stored.scope === 'hospital' ? 'hospital' : 'public',
    localPopulation: stored.population_id ?? '',
    applicability: stored.applicability ?? '',
    applicabilityNotes: stored.applicability_notes ?? '',
    qualityTool: stored.quality_tool ?? '',
    qualityScore: stored.quality_score == null ? '' : String(stored.quality_score),
    settingCategory: stored.setting_category ?? '',
    configurationId: stored.configuration_id ?? ''
  };
}

/** How a linked row's evidence grade will move with this study (CONTRACT.md §22; numbers from /meta). */
export function adjustmentWords(form, adjustments) {
  if (!form.risk || !form.guideline || (form.guideline !== 'none' && !form.followed)) return null;
  const bonus = form.guideline !== 'none' && form.followed === 'yes' ? adjustments?.guideline_followed ?? 0.05 : 0;
  const penalty = adjustments?.risk_of_bias?.[form.risk] ?? { low: 0, some_concerns: -0.04, high: -0.1, unclear: -0.04 }[form.risk] ?? 0;
  const total = Math.round((bonus + penalty) * 100) / 100;
  if (!total) return 'Rows linked to this study keep their evidence score.';
  const value = `${total > 0 ? '+' : '−'}${Math.abs(total).toFixed(2)}`;
  return `Rows linked to this study get ${value} on their evidence score.`;
}

/** One stored study in the list's words: title, design, and its quality in a line. */
export function studyRowWords(study) {
  const guideline =
    study.reporting_guideline === 'none'
      ? 'no guideline'
      : `${optionLabel(REPORTING_GUIDELINES, study.reporting_guideline)} ${study.guideline_followed === 'yes' ? 'followed' : study.guideline_followed === 'partly' ? 'partly followed' : 'not followed'}`;
  return {
    title: study.title,
    text: `${optionLabel(STUDY_DESIGNS, study.design)}, ${optionLabel(STUDY_CONDUCTORS, study.conducted_by).toLowerCase()}, ${guideline}`,
    risk: [
      `Risk of bias ${optionLabel(RISKS_OF_BIAS, study.risk_of_bias).toLowerCase()}`,
      study.applicability ? `applicability concerns ${optionLabel(APPLICABILITY, study.applicability).toLowerCase()}` : null
    ]
      .filter(Boolean)
      .join(', '),
    meta: [study.model_version, study.publication_date].filter(Boolean).join(', ')
  };
}
