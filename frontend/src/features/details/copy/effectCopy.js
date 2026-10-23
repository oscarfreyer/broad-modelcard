// "Effects on outcomes" on the condition card (contract v1.13, CONTRACT.md §27): the words and the plot geometry for each intervention
// effect. Effects are evidence of a different kind from predictive
// performance: what using the AI system changed for patients or care, against
// a comparator, from a trial or a prospective study. They are never graded,
// so nothing here uses a status word or a status colour.
import { CONDUCTOR_PHRASES, DESIGN_LABELS } from './studyCopy.js';

export const EFFECTS_TITLE = 'Effects on outcomes';
export const EFFECTS_NOT_GRADED = 'Not part of any grade. Grades on this card cover predictive performance only.';
export const EFFECTS_LEAD = 'What using the AI system changed for patients or care, compared with care without it.';

const RATIO_MEASURES = new Set(['risk_ratio', 'odds_ratio', 'hazard_ratio']);
const MEASURE_WORDS = {
  risk_ratio: 'Risk ratio',
  odds_ratio: 'Odds ratio',
  hazard_ratio: 'Hazard ratio',
  risk_difference: 'Risk difference',
  mean_difference: 'Mean difference',
  standardized_mean_difference: 'Standardized mean difference'
};
// What a ratio compares, for the plain sentence ("18% higher risk").
const RATIO_NOUNS = { risk_ratio: 'risk', odds_ratio: 'odds', hazard_ratio: 'rate' };
const OUTCOME_TYPE_WORDS = { benefit: 'Benefit', harm: 'Harm', process: 'Process' };
const TOOL_WORDS = { rob2: 'RoB 2', robins_i: 'ROBINS-I' };
const JUDGEMENT_WORDS = { low: 'low', some_concerns: 'some concerns', high: 'high', critical: 'critical', unclear: 'unclear' };

export const isRatio = (effect) => RATIO_MEASURES.has(effect.effect_measure);
/** The value of no effect: 1 for a ratio, 0 for a difference. */
export const nullValue = (effect) => (isRatio(effect) ? 1 : 0);

/** A number as the card writes it: a typographic minus, at most three significant decimals. */
export function figure(value) {
  if (!Number.isFinite(value)) return '–';
  const rounded = Math.round(value * 1000) / 1000;
  const text = Math.abs(rounded).toLocaleString('en-US', { maximumFractionDigits: 3 });
  return rounded < 0 ? `−${text}` : text;
}

/**
 * Where the confidence interval lies: `better` when all of it favours the AI
 * system, `worse` when all of it favours the comparator, `unclear` when it
 * includes no effect.
 */
export function effectVerdict(effect) {
  const zero = nullValue(effect);
  const lowerBetter = effect.direction === 'lower_is_better';
  if (effect.ci_high < zero) return lowerBetter ? 'better' : 'worse';
  if (effect.ci_low > zero) return lowerBetter ? 'worse' : 'better';
  return 'unclear';
}

const VERDICT_WORDS = {
  better: 'Better with the AI system',
  worse: 'Worse with the AI system',
  unclear: 'No clear difference'
};

/** "about 14 minutes less", "about 18% higher risk"; null when no plain amount fits (a standardized difference). */
export function effectSize(effect) {
  const estimate = effect.estimate;
  if (isRatio(effect)) {
    const percent = Math.round(Math.abs(estimate - 1) * 100);
    if (!percent) return null;
    return `about ${percent}% ${estimate < 1 ? 'lower' : 'higher'} ${RATIO_NOUNS[effect.effect_measure]}`;
  }
  if (effect.effect_measure === 'standardized_mean_difference' || !estimate) return null;
  const unit = effect.unit ? ` ${effect.unit}` : '';
  return `about ${figure(Math.abs(estimate))}${unit} ${estimate < 0 ? 'less' : 'more'}`;
}

/** Lower-case the first letter of a comparator for use inside a sentence ("Usual care" → "usual care"). */
function inSentence(text) {
  const value = String(text ?? '').trim();
  if (/^[A-Z][a-z]/.test(value)) return value[0].toLowerCase() + value.slice(1);
  return value;
}

/** The plain-depth sentence: the verdict against the comparator, and the amount. */
export function effectSentence(effect) {
  const verdict = effectVerdict(effect);
  const amount = effectSize(effect);
  const against = inSentence(effect.comparator);
  const head = verdict === 'unclear' ? `${VERDICT_WORDS.unclear} from ${against}` : `${VERDICT_WORDS[verdict]} than ${against}`;
  return amount && verdict !== 'unclear' ? `${head}: ${amount}.` : `${head}.`;
}

/** "Mean difference −14 minutes (95% CI −21 to −7)" */
export function effectNumbers(effect) {
  const unit = effect.unit ? ` ${effect.unit}` : '';
  return `${MEASURE_WORDS[effect.effect_measure] ?? effect.effect_measure} ${figure(effect.estimate)}${unit} (95% CI ${figure(effect.ci_low)} to ${figure(effect.ci_high)})`;
}

/** "Randomized trial, risk of bias low (RoB 2)"; the design comes from the study record. */
export function appraisalLine(effect) {
  const design = DESIGN_LABELS[effect.study?.design] ?? 'Study';
  return `${design}, risk of bias ${JUDGEMENT_WORDS[effect.judgement] ?? effect.judgement} (${TOOL_WORDS[effect.appraisal_tool] ?? effect.appraisal_tool})`;
}

/** The study in a line: its title, else its ID (and a note when the record is gone). */
export function studyLine(effect) {
  if (!effect.study) return `Study ${effect.study_id} (no longer in Studies)`;
  return effect.study.title;
}

/** Expert facts, in reading order. */
export function effectFacts(effect) {
  const facts = [
    { label: 'Estimate', value: effectNumbers(effect) },
    { label: 'Better when', value: effect.direction === 'lower_is_better' ? 'Lower' : 'Higher' },
    { label: 'Population', value: effect.population }
  ];
  if (effect.follow_up) facts.push({ label: 'Follow-up', value: effect.follow_up });
  facts.push({ label: 'Risk of bias', value: `${TOOL_WORDS[effect.appraisal_tool] ?? effect.appraisal_tool}: ${JUDGEMENT_WORDS[effect.judgement] ?? effect.judgement}` });
  if (effect.study) {
    const study = effect.study;
    facts.push({
      label: 'Study',
      value: `${study.study_id}, ${DESIGN_LABELS[study.design] ?? study.design} by ${CONDUCTOR_PHRASES[study.conducted_by] ?? study.conducted_by}, ${study.sites.toLocaleString('en-US')} ${study.sites === 1 ? 'site' : 'sites'}, ${study.patients.toLocaleString('en-US')} patients`
    });
  } else {
    facts.push({ label: 'Study', value: `${effect.study_id} (no longer in Studies)` });
  }
  if (effect.notes) facts.push({ label: 'Notes', value: effect.notes });
  return facts;
}

/**
 * The plot of one effect on its own scale, with no effect in the middle: a
 * log scale for ratios (so 0.5 and 2 sit equally far from 1), a linear one for
 * differences. Positions are percentages of the track; the better side is the
 * one the direction of benefit names.
 *
 * @returns {{ nullPct: number, estimatePct: number, ciStartPct: number, ciEndPct: number,
 *   betterSide: 'left'|'right', scale: 'log'|'linear', low: number, high: number }}
 */
export function effectPlot(effect) {
  const ratio = isRatio(effect);
  const toAxis = (value) => (ratio ? Math.log(Math.max(value, 1e-6)) : value);
  const zero = toAxis(nullValue(effect));
  const points = [effect.ci_low, effect.ci_high, effect.estimate].map(toAxis);
  const reach = Math.max(...points.map((point) => Math.abs(point - zero)));
  // Room around the interval, and a floor so a tiny effect does not fill the track.
  const half = Math.max(reach * 1.2, ratio ? Math.log(1.25) : Math.abs(effect.estimate) * 0.5 || 1);
  const pct = (value) => Math.min(100, Math.max(0, ((toAxis(value) - (zero - half)) / (2 * half)) * 100));
  const fromAxis = (value) => (ratio ? Math.exp(value) : value);
  return {
    nullPct: 50,
    estimatePct: pct(effect.estimate),
    ciStartPct: pct(effect.ci_low),
    ciEndPct: pct(effect.ci_high),
    betterSide: effect.direction === 'lower_is_better' ? 'left' : 'right',
    scale: ratio ? 'log' : 'linear',
    low: fromAxis(zero - half),
    high: fromAxis(zero + half)
  };
}

/** What the plot shows, for a screen reader. */
export function plotLabel(effect) {
  const plot = effectPlot(effect);
  const side = plot.betterSide === 'left' ? 'left' : 'right';
  return `${effectNumbers(effect)}. No effect is ${figure(nullValue(effect))}, in the middle; better with the AI system is to the ${side}. ${VERDICT_WORDS[effectVerdict(effect)]}.`;
}

/** The section's model: one entry per effect at the reader's depth. */
export function effectsModel(effects, depth) {
  return (effects ?? []).map((effect) => ({
    id: effect.effect_id,
    outcome: effect.outcome,
    outcomeType: OUTCOME_TYPE_WORDS[effect.outcome_type] ?? effect.outcome_type,
    comparator: effect.comparator,
    sentence: effectSentence(effect),
    verdict: effectVerdict(effect),
    plot: effectPlot(effect),
    plotLabel: plotLabel(effect),
    nullText: figure(nullValue(effect)),
    appraisal: appraisalLine(effect),
    study: studyLine(effect),
    facts: depth === 'expert' ? effectFacts(effect) : []
  }));
}
