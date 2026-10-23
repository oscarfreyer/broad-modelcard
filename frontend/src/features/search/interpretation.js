// Plain-language search (contract v1.14, CONTRACT.md §31): what the
// interpretation row shows and what Apply does with its chips. Framework-free,
// so the node tests can check it. The chips come from interpretQuery (or the
// helper); nothing is applied until the reader presses Apply.

import { atlasHref } from '../../app/startupParams.js';
import { specificSetting } from '../../shared/careSetting.js';
import { systemName } from '../../shared/aiSystem.js';
import { displayUseCase, lensValueWords } from '../../shared/format.js';

export const ALL_LENS = Object.freeze({ age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' });
const LENS_KINDS = ['age', 'sex', 'ethnicity'];
// Kinds other than conditions: a query with one of them is read as a whole, however short.
const NON_CONDITION_KINDS = new Set(['system', 'function', 'age', 'sex', 'ethnicity', 'setting']);

/** Words of a query, as the palette counts them. */
function wordCount(query) {
  return String(query ?? '').trim().split(/\s+/).filter(Boolean).length;
}

/** Whether a query is worth reading as a whole (three or more words; any query may still give chips). */
function asksForInterpretation(query) {
  return wordCount(query) >= 3;
}

/**
 * Whether the interpretation row shows: three or more words with any chip, or
 * any query with a recognized system, function, lens, or setting chip.
 */
export function showsInterpretation(query, chips) {
  if (!chips?.length) return false;
  return asksForInterpretation(query) || chips.some((chip) => NON_CONDITION_KINDS.has(chip.kind));
}

/** The chip's words in the UI's vocabulary ("AI system", "Function"; CONTRACT.md "Vocabulary"). */
export function chipLabel(chip, entries = []) {
  switch (chip.kind) {
    case 'system':
      return systemName(entries.find((entry) => entry.model_version === chip.value), chip.label || chip.value);
    case 'function':
      return displayUseCase(chip.value);
    case 'sex':
      return chip.value === 'Sex Female' ? 'Women' : chip.value === 'Sex Male' ? 'Men' : lensValueWords(chip.value);
    case 'age':
      return `Age ${lensValueWords(chip.value)}`;
    case 'ethnicity':
      return lensValueWords(chip.value);
    default:
      return chip.label || chip.value;
  }
}

/** The kind of a chip in words, for its accessible name ("Remove AI system SynGPT-2.0"). */
export const CHIP_KIND_WORDS = Object.freeze({
  system: 'AI system',
  function: 'Function',
  condition: 'Condition',
  age: 'Age group',
  sex: 'Sex',
  ethnicity: 'Ethnicity',
  setting: 'Care setting'
});

/**
 * The card a system and function chip name, given the registry (listModels
 * entries) and the card on screen: a system alone keeps the function on screen
 * when it has it, else its first; a function alone keeps the system on screen
 * when it has it, else the first system that does. Null when no chip names a card.
 */
export function cardOfChips(chips, entries = [], current = null) {
  const system = chips.find((chip) => chip.kind === 'system')?.value ?? null;
  const fn = chips.find((chip) => chip.kind === 'function')?.value ?? null;
  if (!system && !fn) return null;
  const has = (entry, useCase) => entry?.use_cases?.some((item) => item.use_case === useCase);
  if (system) {
    const entry = entries.find((item) => item.model_version === system);
    if (!entry) return null;
    const useCase = fn && has(entry, fn) ? fn : has(entry, current?.useCase) ? current.useCase : entry.use_cases?.[0]?.use_case ?? null;
    return useCase ? { model: system, useCase } : null;
  }
  const onScreen = entries.find((item) => item.model_version === current?.model);
  if (has(onScreen, fn)) return { model: onScreen.model_version, useCase: fn };
  const first = entries.find((entry) => has(entry, fn));
  return first ? { model: first.model_version, useCase: fn } : null;
}

/**
 * What Apply sets, from the chips alone: the card (or null to keep the one on
 * screen), the whole lens (an axis without a chip is "All …"), the setting
 * (null: Any setting), and the conditions in chip order.
 */
export function applyPlan(chips, entries = [], current = null) {
  const lens = { ...ALL_LENS };
  LENS_KINDS.forEach((kind) => {
    const chip = chips.find((item) => item.kind === kind);
    if (chip) lens[kind] = chip.value;
  });
  const settingChip = chips.find((chip) => chip.kind === 'setting');
  const card = cardOfChips(chips, entries, current);
  const conditions = chips.filter((chip) => chip.kind === 'condition' && chip.concept).map((chip) => chip.concept);
  return { card, lens, setting: settingChip ? specificSetting(settingChip.value) : null, conditions };
}

/** The distinct conditions a combination of the plan holds: subcategories join as their depth-1 condition. */
function combinationIds(plan) {
  return [...new Set(plan.conditions.map((concept) => concept.metric_anchor_id || concept.concept_id))];
}

/** Whether the card a plan opens stores combinations for two or three of its conditions (Multimorbidity mode). */
export function canCombine(plan, entries = [], current = null) {
  const target = plan.card ?? current;
  if (!target || combinationIds(plan).length < 2) return false;
  const entry = entries.find((item) => item.model_version === target.model);
  const useCase = entry?.use_cases?.find((item) => item.use_case === target.useCase);
  return Boolean(useCase?.has_multimorbidity) && plan.conditions.every((concept) => concept.level === 2);
}

/**
 * The atlas URL a plan opens from the catalogue (the atlas reads it at
 * start-up): the card, the lens, the setting by its code, and the first
 * condition, or the combination in Multimorbidity mode.
 */
export function atlasHrefOfPlan(plan, { combine = false } = {}) {
  const first = plan.conditions[0] ?? null;
  return atlasHref({
    model: plan.card?.model ?? null,
    useCase: plan.card?.useCase ?? null,
    lens: plan.lens,
    setting: plan.setting,
    ...(combine
      ? { mode: 'multimorbidity', selectedIds: combinationIds(plan) }
      : first
        ? // A condition opens in its chapter, as the palette opens it; the chapter
          // also lets the atlas find a subcategory, which the overview does not hold.
          { chapterId: first.level >= 2 ? first.chapter_id ?? null : null, conceptId: first.concept_id }
        : {})
  });
}

/** The interpretation's sentence for screen readers and the row's title: "Read as: …". */
export function interpretationSummary(chips, entries = []) {
  return chips.length ? `Read as: ${chips.map((chip) => chipLabel(chip, entries)).join(', ')}` : '';
}
