// The comparison page's words. The backend decides which
// reasons apply (CONTRACT.md §25); the frontend owns how they read.
// Framework-free, so the node tests can check every reason has its words.
import { functionCategoryLabel } from '../../shared/aiSystem.js';
import { populationWords } from '../../shared/format.js';
import { resultPopulationLabel } from '../../shared/resultPopulation.js';
import { ANY_SETTING, settingLabel, specificSetting } from '../../shared/careSetting.js';
import { validationTypeLabel } from '../../shared/metricLabels.js';
import { CONDUCTOR_PHRASES, DESIGN_LABELS, SETTING_CATEGORY_LABELS } from '../details/copy/studyCopy.js';

export const NOT_COMPARABLE = 'Not directly comparable';

/**
 * Short words for each reason, in the order /meta.comparison.reasons lists
 * them. `who` is the cards the reason concerns, already named ("Vantrel
 * Triage" or "2 cards"); `all` is true when it concerns every card.
 * `measures` and `settings` (contract v1.14) name what differs, when the
 * caller passes the card facts and the row (`reasonText`'s `detail`).
 */
export const REASON_WORDS = Object.freeze({
  function_category_differs: ({ who, one }) => `different task: ${who} ${one ? 'has' : 'have'} another function category`,
  function_category_unknown: ({ who, one }) => `task unknown: ${who} ${one ? 'states' : 'state'} no function category`,
  population_differs: ({ who, one }) => `different population: ${who} ${one ? 'has' : 'have'} no data for this group or setting`,
  measure_differs: ({ who, one, measures }) =>
    measures?.length > 1 ? `measures differ: ${measures.join(' vs ')}` : `different measure: ${who} ${one ? 'measures' : 'measure'} something else`,
  measure_unknown: ({ who, one }) => `measure unknown: ${who} ${one ? 'states' : 'state'} no performance measure`,
  no_mapping: () => 'no ICD-11 mapping, so no card has a result',
  mapped_broader: () => 'mapped through a broader ICD-11 concept',
  no_result: ({ who, all }) => (all ? 'no card has a result' : `no result from ${who}`),
  out_of_scope: ({ who }) => `outside the intended use of ${who}`,
  lens_fallback: ({ who, one }) => `${who} ${one ? 'combines' : 'combine'} narrower groups`,
  design_differs: ({ who }) => `different study design: ${who}`,
  setting_differs: ({ who, settings }) => (settings?.length > 1 ? `settings differ: ${settings.join(' vs ')}` : `different care setting: ${who}`)
});

/** Plain explanations of each reason, for the "How comparability is judged" list. */
export const REASON_RULES = Object.freeze({
  function_category_differs: 'The functions are in different categories (for example triage and decision support), so the figures measure different tasks.',
  function_category_unknown: 'A card states no function category, so whether the tasks match is unknown.',
  population_differs: 'A card stores no data for the chosen group or care setting (a product often stores all patients only, and few cards store a specific setting).',
  no_mapping: 'In another classification, the condition has no ICD-11 counterpart.',
  mapped_broader: 'In another classification, the condition takes the result of an ICD-11 subchapter or a broader parent.',
  no_result: 'A card shows No data for the row.',
  out_of_scope: 'The row is outside a card’s intended use.',
  lens_fallback: 'One card’s result was combined from narrower groups, another’s was stored for the group.',
  design_differs: 'The results rest on different kinds of evidence: clinical studies, test cases (benchmark, vignette, simulation), or internal tests.',
  measure_differs: 'The cards state different performance measures (for example top-3 accuracy and sensitivity), so the figures measure different things.',
  measure_unknown: 'A card states no performance measure while another does, so whether the figures measure the same thing is unknown.',
  setting_differs: 'The studies behind the results were done in different care settings (for example an emergency department and a ward). Mixed settings do not count.'
});

export const DESIGN_GROUP_WORDS = Object.freeze({
  clinical_study: 'Clinical study',
  test_cases: 'Test cases',
  internal_test: 'Internal test'
});

export function designLabel(design) {
  return DESIGN_LABELS[design] ?? design ?? '';
}

/** A study's setting category as a name ("Emergency department"). */
export function settingCategoryLabel(category) {
  return SETTING_CATEGORY_LABELS[category] ?? category ?? '';
}

export function conductorLabel(conductor) {
  return CONDUCTOR_PHRASES[conductor] ?? conductor ?? '';
}

/** The kind of evidence a cell rests on, in words: its linked study's design, else its validation type. */
export function evidenceWords(cell) {
  if (cell?.study_design) return designLabel(cell.study_design);
  return cell?.validation_type ? validationTypeLabel(cell.validation_type, '') : '';
}

/**
 * The reason's words for a row. `names` maps card id → short card name.
 * `detail` (optional) lets the words name what differs: `cards` (the card
 * facts, for the measures) and `row` (its cells, for the settings).
 *
 * @param {{ code: string, cards: string[] }} reason
 * @param {Map<string, string>} names
 * @param {number} cardCount
 * @param {{ cards?: object[], row?: object }} [detail]
 */
export function reasonText(reason, names, cardCount, detail = {}) {
  const words = REASON_WORDS[reason.code];
  if (!words) return reason.code.replace(/_/g, ' ');
  return words({ ...whoWords(reason.cards, names, cardCount), measures: statedMeasures(detail.cards), settings: rowSettings(detail.row) });
}

/** A label inside a sentence: "Top-3 diagnostic accuracy" → "top-3 diagnostic accuracy"; "AUROC" stays. */
export function inSentence(label) {
  if (!label) return '';
  return /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label;
}

/** The different performance measures the cards state, in card order (case and spacing do not count, as in the rule). */
export function statedMeasures(cards) {
  const seen = new Map();
  for (const card of cards ?? []) {
    const measure = card?.performance_measure;
    if (!measure) continue;
    const key = measure.split(/\s+/).filter(Boolean).join(' ').toLowerCase();
    if (!seen.has(key)) seen.set(key, inSentence(measure.trim()));
  }
  return [...seen.values()];
}

/** The different specific care settings of a row's results, in card order ("emergency department", …). */
export function rowSettings(row) {
  if (!row?.cells) return [];
  const settings = [];
  row.cells.forEach((cell) => {
    const setting = cell?.setting_category;
    if (setting && setting !== 'mixed' && ['strong', 'moderate', 'weak'].includes(cell.status) && !settings.includes(setting)) {
      settings.push(setting);
    }
  });
  return settings.map((setting) => inSentence(SETTING_CATEGORY_LABELS[setting] ?? setting));
}

/** The words of who conducted a card's linked studies: "1 independent, 2 by the developer", or null without any. */
export function conductorWords(conductors) {
  if (!conductors) return null;
  const parts = [
    [conductors.independent, 'independent'],
    [conductors.hospital, conductors.hospital === 1 ? 'by a hospital' : 'by hospitals'],
    [conductors.developer, 'by the developer']
  ].filter(([count]) => count > 0);
  return parts.length ? parts.map(([count, words]) => `${count} ${words}`).join(', ') : null;
}

/** "Provided, 2026-10-20" or "None": the AI system's narrow model card (§26.4), never verified. */
export function narrowCardWords(narrow) {
  if (!narrow?.present) return 'None';
  return narrow.submitted_at ? `Provided, ${String(narrow.submitted_at).slice(0, 10)}` : 'Provided';
}

/** A cell's local marker (§26.1): "Local" for a local result, "Includes local" for a rollup over one; else null. */
export function localWords(cell) {
  if (cell?.layer === 'local') return 'Local';
  if (cell?.layer === 'includes_local') return 'Includes local';
  return null;
}

/**
 * The cards a reason concerns, in words: one or two by name ("Vantrel Triage
 * 2.1 and radAIology-1"), every card, or a count.
 */
export function whoWords(cards, names, cardCount) {
  const name = (id) => names.get(id) ?? id;
  const all = cards.length === cardCount && cardCount > 1;
  let who;
  if (all) who = 'every card';
  else if (cards.length === 1) who = name(cards[0]);
  else if (cards.length === 2) who = `${name(cards[0])} and ${name(cards[1])}`;
  else who = `${cards.length} cards`;
  return { who, all, one: cards.length === 1 || all };
}

/**
 * The row's reasons without the card-level ones, which the page states once
 * above the table (they hold on every row).
 */
export function rowOnlyReasons(row, cardReasons) {
  const shared = new Set((cardReasons ?? []).map((reason) => reason.code));
  // A card without data for the group (population_differs) has no result on any row: said once above the table.
  const lacking = new Set((cardReasons ?? []).filter((reason) => reason.code === 'population_differs').flatMap((reason) => reason.cards));
  return row.reasons.filter(
    (reason) => !shared.has(reason.code) && !(reason.code === 'no_result' && reason.cards.every((card) => lacking.has(card)))
  );
}

export function functionCategoryWords(code) {
  return code ? functionCategoryLabel(code) : 'Not stated';
}

/**
 * The lens, population, and classification named next to the results
 *: the shared formatter of every result surface
 * (shared/resultPopulation.js), e.g. "All patients, default prevalence", or
 * "Age 65+, Female, Northbridge region (fictional), MONDO" in another
 * classification (ICD-11, the default, is not named).
 *
 * @param {{ lens: object, setting?: string|null, population?: { name: string }|null, ontology?: { id: string, name: string }|null }} context
 *   `setting` a specific care setting (contract v1.14), named after the group
 */
export function resultContext({ lens, setting = null, population = null, ontology = null }) {
  return resultPopulationLabel(lens, population, { ontology, setting });
}

/** "Any setting" or "Any setting, Emergency department": the care settings a card stores rows for (v1.14). */
export function settingsWords(lenses) {
  return (lenses?.settings ?? [ANY_SETTING]).map(settingLabel).join(', ');
}

/** "Age 65+", "All patients only", or "90 of 90 groups": what a card stores. */
export function lensesWords(lenses) {
  if (!lenses) return '';
  if (lenses.all_patients_only) return 'All patients only';
  return lenses.stored === lenses.total ? `Every group (${lenses.total})` : `${lenses.stored} of ${lenses.total} groups`;
}

/** How a card holds the chosen group, at the chosen care setting (v1.14). */
export function requestedLensWords(lenses, lens, setting = null) {
  if (!lenses) return '';
  if (specificSetting(setting) && !(lenses.settings ?? [ANY_SETTING]).includes(setting)) return 'No data for this setting';
  if (populationWords(lens) === 'All patients') return specificSetting(setting) && lenses.requested === 'none' ? 'No data for this setting' : '';
  if (lenses.requested === 'stored') return 'Stored for this group';
  if (lenses.requested === 'fallback') return 'Combined from narrower groups';
  return 'No data for this group';
}
