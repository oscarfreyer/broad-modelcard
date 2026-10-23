// "How to read a card" (release 0.5; CONTRACT.md §30.3): the
// guide's four steps, and the phrases the audience summaries share with it
// (features/summary/audienceModel.js), so the same thing is explained in
// the same words wherever it appears. The marks' meanings come from the
// legend's own words (design/status.js), the one source for those.
// React-free for the tests.
import { ABSENCE_MEANING, DISPLAY, SAFETY_MEANING } from '../../design/status.js';

export const GUIDE_TITLE = 'How to read a card';
export const GUIDE_INTRO = 'A card is one AI system with one function. Four things to know.';
export const GUIDE_OPEN_LEGEND = 'How to read this';
export const GUIDE_OPEN_CATALOGUE = 'How to read a card';

// Shared phrases (one source of truth for the guide and the audience summaries).
export const NO_DATA_MEANING = ABSENCE_MEANING.no_data;
export const OUT_OF_SCOPE_MEANING = ABSENCE_MEANING.out_of_scope;
export const NOT_SAFE_MEANING = SAFETY_MEANING.no_incidents;
export const SYNTHETIC_NOT_CLINICAL = 'Demonstration on synthetic data, not for clinical use.';
export const SAME_FIGURES = 'Every reader sees the same figures.';
export const DECLARED = 'Declared by the developer, not checked.';

/**
 * The four steps. `marks` lists the marks step 2 shows with their words (the
 * results first, then the absences and the safety marks).
 */
export const GUIDE_STEPS = Object.freeze([
  {
    id: 'ring',
    title: 'The ring and its chapters',
    text:
      'The ring is the disease space of the classification on screen (ICD-11 unless you choose another). Each sector is a chapter, and each bubble a subchapter; bigger bubbles hold more common conditions. Click a bubble to open its chapter.',
    marks: []
  },
  {
    id: 'marks',
    title: 'The marks and their words',
    text: 'Each mark says, in one word, how the AI system does for those conditions: Strong, Moderate, or Weak, from best to worst. Absence is information too.',
    marks: ['strong', 'moderate', 'weak', 'no_data', 'out_of_scope', 'serious', 'caution', 'no_incidents']
  },
  {
    id: 'condition',
    title: 'The condition card',
    text:
      'Select a condition to read its card: the result, how it was assessed, the study behind it, safety incidents, warnings, and safeguards. Plain or Expert changes how much it explains, never the figures.',
    marks: []
  },
  {
    id: 'population',
    title: 'Population, setting, and lens',
    text:
      'Every result is for the group named beside it: all patients or one age group, sex, or ethnicity; any care setting or one; the default prevalence or a local population. Change them under Population. Another group can read differently.',
    marks: []
  }
]);

/** The words for one mark in step 2: its label and, for an absence or safety mark, the legend's own meaning. */
export function guideMark(key) {
  return { key, label: DISPLAY[key].label, meaning: ABSENCE_MEANING[key] ?? SAFETY_MEANING[key] ?? null };
}

/**
 * Whether the guide opens by itself: once per browser, on the first atlas
 * visit (not in a staged preview); closing it is remembered (`guide_seen`).
 *
 * @param {{ guide_seen?: boolean }} profile
 * @param {{ isPreview?: boolean }} [context]
 */
export function shouldShowGuide(profile, { isPreview = false } = {}) {
  return !profile?.guide_seen && !isPreview;
}
