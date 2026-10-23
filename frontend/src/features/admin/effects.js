// The one-effect form of the Data Library (contract v1.13, CONTRACT.md §27):
// its choices, checks, and the mapping from form state to the JSON record that
// createRecordsUpload stages as a merge upload, keyed by the effects template's
// column keys so the backend checks it like a spreadsheet row. Effects are
// never graded. Every effect is synthetic and fictional.

import { optionLabel } from './options.js';

// Allowed values in the template's words (backend/README.md "Effects on outcomes").
export const OUTCOME_TYPES = Object.freeze([
  { value: 'benefit', label: 'Benefit' },
  { value: 'harm', label: 'Harm' },
  { value: 'process', label: 'Process' }
]);
export const EFFECT_MEASURES = Object.freeze([
  { value: 'risk_ratio', label: 'Risk ratio' },
  { value: 'odds_ratio', label: 'Odds ratio' },
  { value: 'hazard_ratio', label: 'Hazard ratio' },
  { value: 'risk_difference', label: 'Risk difference' },
  { value: 'mean_difference', label: 'Mean difference' },
  { value: 'standardized_mean_difference', label: 'Standardized mean difference' }
]);
export const RATIO_MEASURES = Object.freeze(['risk_ratio', 'odds_ratio', 'hazard_ratio']);
export const EFFECT_DIRECTIONS = Object.freeze([
  { value: 'higher_is_better', label: 'Higher is better' },
  { value: 'lower_is_better', label: 'Lower is better' }
]);
export const APPRAISAL_TOOLS = Object.freeze([
  { value: 'rob2', label: 'RoB 2' },
  { value: 'robins_i', label: 'ROBINS-I' }
]);
export const EFFECT_JUDGEMENTS = Object.freeze([
  { value: 'low', label: 'Low' },
  { value: 'some_concerns', label: 'Some concerns' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
  { value: 'unclear', label: 'Unclear' }
]);
/** The study designs that can carry an effect, and the appraisal tool each needs (CONTRACT.md §27). */
const EFFECT_STUDY_TOOLS = Object.freeze({ randomized_trial: 'rob2', prospective: 'robins_i', real_world_deployment: 'robins_i' });

export const MAX_OUTCOME = 200;
export const MAX_EFFECT_TEXT = 280;
export const MAX_EFFECT_UNIT = 40;
export const MAX_FOLLOW_UP = 120;
export const MAX_EFFECT_NOTES = 500;
const EFFECT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const NUMBER = /^-?(\d+(\.\d*)?|\.\d+)$/;

const text = (value) => String(value ?? '').trim();
// "1,200" or "12,000": a thousands separator, never a decimal comma ("0,85", "12,5" are).
const THOUSANDS = /^-?[1-9]\d{0,2}(,\d{3})+$/;

/**
 * A number the maintainer typed, with a decimal comma or a typographic minus
 * accepted; null when it is not one. A thousands separator is refused rather
 * than read as a decimal comma ("1,200" is not 1.2).
 */
export function parsedNumber(value) {
  const signed = text(value).replace(/^[−–]/, '-');
  if (THOUSANDS.test(signed)) return null;
  const cleaned = signed.replace(',', '.');
  return NUMBER.test(cleaned) ? Number(cleaned) : null;
}

/** The studies an effect can name: designs that compared care with and without the AI system. */
export function effectStudies(studies) {
  return (studies ?? []).filter((study) => EFFECT_STUDY_TOOLS[study.design]);
}

/** An empty effect form; `card` starts it on the page's card. */
export function emptyEffect({ card = null } = {}) {
  return {
    effectId: '',
    editing: null, // { id } while the form edits a stored effect
    studyId: '',
    model: card?.model ?? '',
    useCase: card?.useCase ?? '',
    scope: 'codes', // 'codes' | 'chapter'
    codes: [], // [{ code, name }]
    chapterNo: '',
    outcome: '',
    outcomeType: '',
    population: '',
    comparator: '',
    measure: '',
    estimate: '',
    ciLow: '',
    ciHigh: '',
    unit: '',
    direction: '',
    followUp: '',
    tool: '',
    judgement: '',
    notes: ''
  };
}

/**
 * What the effect form still needs, as { field: message }. The backend checks
 * everything again (the study, its design, the card); this saves a round trip
 * for empty or malformed fields and for the rules the form can see.
 *
 * @param {object} form
 * @param {object[]|null} [studies] stored studies (listStudies), to match the tool to the design
 */
export function effectProblems(form, studies = null) {
  const problems = {};
  if (!EFFECT_ID.test(text(form.effectId))) problems.effectId = 'Use letters, digits, ".", "_", or "-" (at most 64).';
  const study = (studies ?? []).find((entry) => entry.study_id === form.studyId) ?? null;
  if (!form.studyId) problems.studyId = 'Choose the study that measured the effect.';
  if (!form.model || !form.useCase) problems.card = 'Choose the AI system and its function.';
  if (form.scope === 'chapter' ? !form.chapterNo : !form.codes.length) {
    problems.where = form.scope === 'chapter' ? 'Choose the chapter.' : 'Add at least one condition.';
  }
  if (!text(form.outcome)) problems.outcome = 'Say what was measured.';
  else if (text(form.outcome).length > MAX_OUTCOME) problems.outcome = `At most ${MAX_OUTCOME} characters.`;
  if (!form.outcomeType) problems.outcomeType = 'Choose Benefit, Harm, or Process.';
  if (!text(form.population)) problems.population = 'Say who was studied.';
  else if (text(form.population).length > MAX_EFFECT_TEXT) problems.population = `At most ${MAX_EFFECT_TEXT} characters.`;
  if (!text(form.comparator)) problems.comparator = 'Say what care with the AI system was compared with.';
  else if (text(form.comparator).length > MAX_EFFECT_TEXT) problems.comparator = `At most ${MAX_EFFECT_TEXT} characters.`;
  if (!form.measure) problems.measure = 'Choose the effect measure.';
  const numbers = { estimate: parsedNumber(form.estimate), ciLow: parsedNumber(form.ciLow), ciHigh: parsedNumber(form.ciHigh) };
  for (const [key, value] of Object.entries(numbers)) {
    if (value === null) problems[key] = THOUSANDS.test(text(form[key]).replace(/^[−–]/, '-')) ? 'Without a thousands separator, e.g. 1200.' : 'A number, e.g. -12 or 0.85.';
  }
  const isRatio = RATIO_MEASURES.includes(form.measure);
  if (isRatio) {
    for (const [key, value] of Object.entries(numbers)) {
      if (value !== null && value <= 0) problems[key] = 'A ratio is above 0; 1 means no effect.';
    }
  }
  if (!problems.estimate && !problems.ciLow && !problems.ciHigh && !(numbers.ciLow <= numbers.estimate && numbers.estimate <= numbers.ciHigh)) {
    problems.ciLow = 'CI low must not be above the estimate, and CI high not below it.';
  }
  if (text(form.unit).length > MAX_EFFECT_UNIT) problems.unit = `At most ${MAX_EFFECT_UNIT} characters.`;
  if (!form.direction) problems.direction = 'Choose which direction favours the AI system.';
  if (text(form.followUp).length > MAX_FOLLOW_UP) problems.followUp = `At most ${MAX_FOLLOW_UP} characters.`;
  if (!form.tool) problems.tool = 'Choose RoB 2 or ROBINS-I.';
  else if (study && EFFECT_STUDY_TOOLS[study.design] && EFFECT_STUDY_TOOLS[study.design] !== form.tool) {
    problems.tool = study.design === 'randomized_trial' ? 'The study is a randomized trial: use RoB 2.' : 'The study is not randomized: use ROBINS-I.';
  }
  if (!form.judgement) problems.judgement = 'Choose the overall judgement.';
  else if (form.judgement === 'critical' && form.tool === 'rob2') problems.judgement = 'Critical is a ROBINS-I judgement; RoB 2 ends at High.';
  if (text(form.notes).length > MAX_EFFECT_NOTES) problems.notes = `At most ${MAX_EFFECT_NOTES} characters.`;
  return problems;
}

/** The effect form as one effects record (template column keys). */
export function effectRecord(form) {
  const number = (value) => parsedNumber(value) ?? text(value);
  return {
    effect_id: text(form.effectId),
    study_id: form.studyId,
    model_version: form.model,
    use_case: form.useCase,
    codes: form.scope === 'chapter' ? `chapter ${form.chapterNo}` : form.codes.map((entry) => entry.code).join('; '),
    outcome: text(form.outcome),
    outcome_type: form.outcomeType,
    population: text(form.population),
    comparator: text(form.comparator),
    effect_measure: form.measure,
    estimate: number(form.estimate),
    ci_low: number(form.ciLow),
    ci_high: number(form.ciHigh),
    unit: text(form.unit) || null,
    direction: form.direction,
    follow_up: text(form.followUp) || null,
    appraisal_tool: form.tool,
    judgement: form.judgement,
    notes: text(form.notes) || null
  };
}

/**
 * A stored effect (listEffects) as the effect form, every field as stored and
 * the ID kept, so publishing the form replaces that effect. `chapters` (from
 * /meta) give a chapter effect its number. `editing` is never sent.
 *
 * @param {object} stored contract Effect
 * @param {{ concept_id: string, chapter_no: string }[]} [chapters]
 */
export function storedEffectForm(stored, chapters = []) {
  const chapterNo = stored.chapter_id ? chapters.find((chapter) => chapter.concept_id === stored.chapter_id)?.chapter_no ?? '' : '';
  return {
    effectId: stored.effect_id,
    editing: { id: stored.effect_id },
    studyId: stored.study_id ?? '',
    model: stored.model_version ?? '',
    useCase: stored.use_case ?? '',
    scope: stored.chapter_id ? 'chapter' : 'codes',
    codes: (stored.codes ?? []).map((code) => ({ code, name: code })),
    chapterNo,
    outcome: stored.outcome ?? '',
    outcomeType: stored.outcome_type ?? '',
    population: stored.population ?? '',
    comparator: stored.comparator ?? '',
    measure: stored.effect_measure ?? '',
    estimate: String(stored.estimate ?? ''),
    ciLow: String(stored.ci_low ?? ''),
    ciHigh: String(stored.ci_high ?? ''),
    unit: stored.unit ?? '',
    direction: stored.direction ?? '',
    followUp: stored.follow_up ?? '',
    tool: stored.appraisal_tool ?? '',
    judgement: stored.judgement ?? '',
    notes: stored.notes ?? ''
  };
}

/** The tool a study's design needs ('' when the study is unknown or cannot carry an effect). */
export function toolForStudy(studies, studyId) {
  const study = (studies ?? []).find((entry) => entry.study_id === studyId);
  return study ? EFFECT_STUDY_TOOLS[study.design] ?? '' : '';
}

/** One stored effect in the list's words. */
export function effectRowWords(effect) {
  const unit = effect.unit ? ` ${effect.unit}` : '';
  return {
    title: effect.outcome,
    text: `${optionLabel(OUTCOME_TYPES, effect.outcome_type)}, ${optionLabel(EFFECT_MEASURES, effect.effect_measure)} ${effect.estimate}${unit} (${effect.ci_low} to ${effect.ci_high})`,
    appraisal: `${optionLabel(APPRAISAL_TOOLS, effect.appraisal_tool)} ${optionLabel(EFFECT_JUDGEMENTS, effect.judgement).toLowerCase()}`,
    meta: [effect.model_version, effect.study_id].filter(Boolean).join(', ')
  };
}
