// The change summary of a staged upload (getUploadChanges) in the atlas's
// status words: counts, removals that need calling out, and status shifts
// grouped by metric view, each as "Moderate → Strong".
import { DISPLAY, VIEWS } from '../../design/status.js';
import { displayTerm } from '../../shared/conceptName.js';
import { displayUseCase, populationWords } from '../../shared/format.js';

const VIEW_ORDER = VIEWS.map((view) => view.id);

export function statusWord(key) {
  return DISPLAY[key]?.label ?? 'No data';
}

/** True when the upload leaves the live data exactly as it is. */
export function hasNoChanges(changes) {
  const rows = changes?.rows ?? {};
  const listed = ['added', 'changed', 'removed'].some((key) => (changes?.models?.[key]?.length ?? 0) > 0) ||
    ['added', 'removed'].some((key) => (changes?.use_cases?.[key]?.length ?? 0) > 0);
  return !rows.added && !rows.changed && !rows.removed && !listed && !(changes?.status_shifts?.length > 0);
}

/**
 * One named row of `rows.samples` (contract v1.4): "Cholera, 1A00, Age 65+, Female", and since
 * v1.14 (§29) the care setting of a row stored for one: "Cholera, 1A00, All patients, Emergency department".
 */
export function sampleText(sample, lensCount = 1) {
  const parts = [displayTerm(sample.name)];
  if (sample.code && sample.code !== sample.name) parts.push(sample.code);
  if (lensCount > 1) parts.push(`${lensCount.toLocaleString('en-US')} population groups`);
  else if (sample.lens) parts.push(populationWords(sample.lens));
  if (sample.setting) parts.push(sample.setting);
  return parts.join(', ');
}

/**
 * The rows an upload adds, changes, or removes per specific care setting (contract v1.14, §29,
 * `rows.settings`): "Emergency department: 600 added", in axis order; empty when it touches Any
 * setting only.
 */
export function settingChanges(changes) {
  return (changes?.rows?.settings ?? []).map((entry) => {
    const parts = ['added', 'changed', 'removed']
      .filter((key) => entry[key] > 0)
      .map((key) => `${entry[key].toLocaleString('en-US')} ${key}`);
    return `${entry.setting}: ${parts.join(', ') || 'no change'}`;
  });
}

/** The one specific setting an upload touches, when it touches no Any-setting row (its preview opens there). */
export function onlySetting(changes) {
  const settings = changes?.rows?.settings ?? [];
  if (settings.length !== 1) return null;
  const [entry] = settings;
  const inSetting = entry.added + entry.changed + entry.removed;
  const total = (changes.rows.added ?? 0) + (changes.rows.changed ?? 0) + (changes.rows.removed ?? 0);
  return inSetting === total ? entry.setting : null;
}

/**
 * The rows of one kind (added, changed, removed) by name: samples of the
 * same condition or combination are folded into one line ("Cholera, 1A00,
 * 50 population groups"), at most `limit` lines, and `more` counts the
 * remaining rows exactly. Null when the API sent no samples (before v1.4) or
 * the kind is empty.
 *
 * @returns {{ names: string[], more: number } | null}
 */
export function namedRows(changes, kind, limit = 5) {
  const samples = changes?.rows?.samples?.[kind];
  const total = changes?.rows?.[kind] ?? 0;
  if (!samples?.length || !total) {
    return null;
  }
  const groups = new Map();
  samples.forEach((sample) => {
    const key = `${sample.name}\u0000${sample.code ?? ''}\u0000${sample.setting ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  });
  const shown = [...groups.values()].slice(0, limit);
  const names = shown.map((group) => sampleText(group[0], group.length));
  const shownRows = shown.reduce((sum, group) => sum + group.length, 0);
  return { names, more: Math.max(0, total - shownRows) };
}

const RECORD_NOUNS = Object.freeze({ safety: ['incident', 'incidents'], studies: ['study', 'studies'], effects: ['effect', 'effects'] });

/** What one record of the change summary is called: an incident for safety (v1.7), a study (v1.13), else a row. */
export function rowNoun(changes) {
  return RECORD_NOUNS[changes?.kind] ?? ['row', 'rows'];
}

/** "and 3 more rows" ("3 more incidents" for safety) */
export function moreRows(more, kind = null) {
  const [one, many] = rowNoun({ kind });
  return `${more.toLocaleString('en-US')} more ${more === 1 ? one : many}`;
}

/** "A, B, and 3 more rows" */
export function nameSentence({ names, more }, kind = null) {
  const items = more ? [...names, moreRows(more, kind)] : names;
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')}${items.length > 2 ? ',' : ''} and ${items[items.length - 1]}`;
}

/**
 * What the upload deletes from the live data, as plain sentences (empty when
 * nothing). A replace upload removes what its file leaves out; a merge upload
 * (contract v1.7) removes only the rows its Action column marks Remove.
 *
 * @param {object} changes getUploadChanges
 * @param {{ mode?: 'replace'|'merge' }} [options] the upload's mode
 */
export function removals(changes, { mode = 'replace' } = {}) {
  const lines = [];
  const removedRows = changes?.rows?.removed ?? 0;
  if (removedRows > 0) {
    const [one, many] = rowNoun(changes);
    const noun = removedRows === 1 ? one : many;
    const count = removedRows.toLocaleString('en-US');
    lines.push(
      mode === 'merge'
        ? `${count} ${noun} marked Remove in your file will leave the live data.`
        : `${count} ${noun} in the live data ${removedRows === 1 ? 'is' : 'are'} missing from your file and will be removed from the live data.`
    );
    const named = changes?.kind === 'models' ? null : namedRows(changes, 'removed');
    if (named) {
      lines.push(`Removed: ${nameSentence(named, changes?.kind)}.`);
    }
  }
  (changes?.models?.removed ?? []).forEach((model) => lines.push(`The AI system ${model} will be removed from the atlas.`));
  (changes?.use_cases?.removed ?? []).forEach((useCase) => lines.push(`The card ${useCase} will be removed from the atlas.`));
  return lines;
}

/**
 * Status shifts grouped by metric view in display order, biggest first.
 *
 * @returns {{ viewId: string, label: string, total: number, shifts: { from: string, to: string, count: number, sampleIds: string[] }[] }[]}
 */
export function shiftsByView(changes) {
  const groups = new Map();
  (changes?.status_shifts ?? []).forEach((shift) => {
    if (!groups.has(shift.view)) {
      groups.set(shift.view, []);
    }
    groups.get(shift.view).push({ from: shift.from, to: shift.to, count: shift.count, sampleIds: shift.sample_concept_ids ?? [] });
  });
  return [...groups.entries()]
    .sort(([a], [b]) => VIEW_ORDER.indexOf(a) - VIEW_ORDER.indexOf(b))
    .map(([viewId, shifts]) => ({
      viewId,
      label: VIEWS.find((view) => view.id === viewId)?.label ?? viewId,
      total: shifts.reduce((sum, shift) => sum + shift.count, 0),
      shifts: [...shifts].sort((a, b) => b.count - a.count)
    }));
}

/**
 * Status shifts split by card, AI system × function (contract v1.4 `targets`),
 * most changes first. Each entry looks like a change summary of its own, so the
 * view grouping and the preview links work per card. Empty when the API sent
 * no targets (before v1.4).
 *
 * @returns {{ target: { model: string, useCase: string }, label: string, total: number, changes: { status_shifts: object[] } }[]}
 */
export function shiftsByTarget(changes) {
  const shifts = changes?.status_shifts ?? [];
  if (!shifts.length || !shifts.every((shift) => Array.isArray(shift.targets))) {
    return [];
  }
  const byTarget = new Map();
  shifts.forEach((shift) => {
    shift.targets.forEach((entry) => {
      const key = `${entry.model_version}\u0000${entry.use_case}`;
      if (!byTarget.has(key)) {
        byTarget.set(key, {
          target: { model: entry.model_version, useCase: entry.use_case },
          label: `${entry.model_version}, ${displayUseCase(entry.use_case)}`,
          total: 0,
          changes: { status_shifts: [] }
        });
      }
      const group = byTarget.get(key);
      group.total += entry.count;
      group.changes.status_shifts.push({ view: shift.view, from: shift.from, to: shift.to, count: entry.count, sample_concept_ids: entry.sample_concept_ids });
    });
  });
  return [...byTarget.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

/**
 * Every condition status change of the summary, over all views: one per
 * condition, view, and model when the API splits shifts by model.
 */
export function shiftTotal(changes) {
  const targets = shiftsByTarget(changes);
  if (targets.length) {
    return targets.reduce((sum, group) => sum + group.total, 0);
  }
  return (changes?.status_shifts ?? []).reduce((sum, shift) => sum + shift.count, 0);
}

/**
 * One headline sentence in the page's two units: spreadsheet rows, and
 * condition status changes (one per condition, view, and model), e.g.
 * "2 rows changed; 3 condition status changes."
 */
export function headline(changes) {
  if (hasNoChanges(changes)) {
    return Object.hasOwn(RECORD_NOUNS, changes?.kind ?? '')
      ? `No changes: the ${rowNoun(changes)[1]} match the live data.`
      : 'No changes: the file matches the live data.';
  }
  const rows = changes.rows;
  const [one, many] = rowNoun(changes);
  const touched = (rows.changed ?? 0) + (rows.added ?? 0) + (rows.removed ?? 0);
  const parts = [];
  if (rows.changed) parts.push(`${rows.changed.toLocaleString('en-US')} changed`);
  if (rows.added) parts.push(`${rows.added.toLocaleString('en-US')} added`);
  if (rows.removed) parts.push(`${rows.removed.toLocaleString('en-US')} removed`);
  const capital = (word) => word[0].toUpperCase() + word.slice(1);
  const rowText = parts.length ? `${capital(touched === 1 ? one : many)}: ${parts.join(', ')}` : `No ${many} change`;
  if (changes.kind === 'safety') {
    // Safety incidents never change a status (CONTRACT.md §18).
    return `${rowText}.`;
  }
  const total = shiftTotal(changes);
  return total ? `${rowText}; ${total.toLocaleString('en-US')} condition status ${total === 1 ? 'change' : 'changes'}.` : `${rowText}; no condition changes status.`;
}
