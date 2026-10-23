// "Across groups" in the Summary (contract v1.14, CONTRACT.md §24): which patient groups differ most often from all patients, and which have
// no data, from one getSubgroupSummary read. The flag is the backend's
// difference rule, a prototype heuristic and never a grade, so the words say
// "differs from all patients" and never more. About patient groups, never about
// study quality. React-free so the node tests can check every sentence.
import { lensValueWords } from '../../shared/format.js';

export const GROUP_SUMMARY_TITLE = 'Across groups';
const GROUP_SUMMARY_NOTE = 'A prototype check on synthetic data, not a grade.';
const GROUP_SUMMARY_ICD11_NOTE = 'Counted over ICD-11 conditions.';
export const GROUP_SUMMARY_UNAVAILABLE = 'Results by group could not be loaded.';
const SHOWN_GROUPS = 3;
const SHOWN_CONDITIONS_PLAIN = 3;

const count = (value, one, many = `${one}s`) => `${Number(value).toLocaleString('en-US')} ${value === 1 ? one : many}`;

/** "patients aged 65+", "female patients", "Asian patients", "patients of other ethnicity": a group inside a sentence. */
export function groupPhrase(axis, value) {
  const words = lensValueWords(value);
  if (axis === 'age') return `patients aged ${words}`;
  if (axis === 'ethnicity' && words === 'Other') return 'patients of other ethnicity';
  if (axis === 'sex') return `${words.toLowerCase()} patients`;
  return `${words} patients`;
}

const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function listWords(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function signedDelta(delta, depth) {
  const digits = depth === 'expert' ? 3 : 2;
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(digits)}`;
}

/** "22 higher, 684 lower", "12 higher", or "5 lower". */
function directionWords(group) {
  return [
    group.higher ? `${group.higher.toLocaleString('en-US')} higher` : null,
    group.lower ? `${group.lower.toLocaleString('en-US')} lower` : null
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Everything the block shows for one getSubgroupSummary answer.
 *
 * @param {object} answer contract SubgroupSummary
 * @param {{ depth?: 'plain'|'expert', classification?: string|null }} [options]
 *   classification: another classification than ICD-11 on screen (the counts stay ICD-11; no condition links)
 * @returns {{ lead: string, groups: object[], conditions: object[], conditionsTitle: string|null, noData: string[], note: string, canOpen: boolean }}
 */
export function groupSummaryModel(answer, { depth = 'plain', classification = null } = {}) {
  const groups = (answer?.groups ?? []).map((group, index) => ({
    key: `${group.axis}:${group.group}`,
    index,
    phrase: groupPhrase(group.axis, group.group),
    flagged: group.flagged_higher + group.flagged_lower,
    higher: group.flagged_higher,
    lower: group.flagged_lower,
    compared: group.compared,
    withResult: group.with_result,
    conditions: group.flagged ?? []
  }));
  const canOpen = !classification;
  const note = classification ? `${GROUP_SUMMARY_NOTE} ${GROUP_SUMMARY_ICD11_NOTE}` : GROUP_SUMMARY_NOTE;
  const empty = (lead) => ({ lead, groups: [], conditions: [], conditionsTitle: null, noData: [], note, canOpen });

  if (!answer?.all_patients_with_result) {
    return empty('No results by group: there are no results for all patients to compare with.');
  }
  const noData = groups.filter((group) => group.withResult === 0).map((group) => group.phrase);
  if (noData.length === groups.length) {
    return empty('No results by group: results are stored for all patients only.');
  }

  const differing = groups.filter((group) => group.flagged > 0).sort((a, b) => b.flagged - a.flagged || a.index - b.index);
  const top = differing[0] ?? null;
  const sentences = [];
  if (!top) {
    sentences.push('No group differs clearly from all patients in any condition.');
  } else if (depth === 'expert') {
    sentences.push(`Conditions whose result in a group differs from all patients, of ${count(answer.all_patients_with_result, 'condition')} with a result for all patients.`);
  } else {
    const others = differing.slice(1, SHOWN_GROUPS).map((group) => group.phrase);
    sentences.push(
      `Results for ${top.phrase} differ from all patients most often: ${count(top.flagged, 'condition')} (${directionWords(top)})${others.length ? `, then ${listWords(others)}` : ''}.`
    );
  }
  if (noData.length) {
    sentences.push(`No data for ${listWords(noData)}.`);
  }
  // Plain depth says it in the lead; expert depth lists every group that differs.
  const shownGroups = depth === 'expert' ? differing : [];
  const conditions = top
    ? top.conditions.slice(0, depth === 'expert' ? top.conditions.length : SHOWN_CONDITIONS_PLAIN).map((condition) => ({
        conceptId: condition.concept_id,
        chapterId: condition.chapter_id,
        label: condition.pt,
        code: condition.code,
        text: `${condition.direction === 'higher' ? 'Higher' : 'Lower'} for ${top.phrase} (${signedDelta(condition.delta, depth)})`
      }))
    : [];
  return {
    lead: sentences.join(' '),
    groups: shownGroups.map((group) => ({
      key: group.key,
      label: capitalized(group.phrase),
      text:
        depth === 'expert'
          ? `${count(group.flagged, 'condition')} ${group.flagged === 1 ? 'differs' : 'differ'} (${directionWords(group)}) of ${group.compared.toLocaleString('en-US')} compared`
          : `${count(group.flagged, 'condition')} (${directionWords(group)})`
    })),
    conditions,
    conditionsTitle: top ? `Largest differences for ${top.phrase}` : null,
    noData,
    note,
    canOpen
  };
}
