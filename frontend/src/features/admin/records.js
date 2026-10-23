// The one-record forms of the Data Library:
// their choices, defaults, checks, and the mapping from form state to the
// JSON record that createRecordsUpload stages as a merge upload (contract
// v1.7, CONTRACT.md §11.4, §18). Records are keyed by the template's column
// keys, so the backend checks them exactly like a spreadsheet row.

import { specificSetting } from '../../shared/careSetting.js';

export const ALL_LENS = Object.freeze({ age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' });

// Allowed values in the template's words (backend/README.md "Templates").
export const INCIDENT_TYPES = Object.freeze([
  { value: 'harmful_recommendation', label: 'Harmful or incorrect recommendation' },
  { value: 'fabricated_content', label: 'Fabricated content' },
  { value: 'subgroup_bias', label: 'Subgroup bias' },
  { value: 'performance_drift', label: 'Performance drift' },
  { value: 'developer_notice_or_recall', label: 'Developer notice or recall' },
  { value: 'other', label: 'Other' }
]);
export const HARMS = Object.freeze([
  { value: 'occurred', label: 'Occurred', hint: 'a patient was harmed.' },
  { value: 'possible', label: 'Possible', hint: 'harm could have occurred.' },
  { value: 'none', label: 'None', hint: 'no harm was possible.' }
]);
export const INCIDENT_STATUSES = Object.freeze([
  { value: 'open', label: 'Open' },
  { value: 'mitigated', label: 'Mitigated' },
  { value: 'closed', label: 'Closed' }
]);
export const SOURCE_TYPES = Object.freeze([
  { value: 'incident_report', label: 'Incident report' },
  { value: 'study', label: 'Study' },
  { value: 'developer_notice', label: 'Developer notice' }
]);
export const EVIDENCE_GRADES = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F']);
export const VALIDATION_TYPES = Object.freeze([
  { value: 'clinical_study_multisite', label: 'Clinical study (multisite)' },
  { value: 'clinical_study_single_site', label: 'Clinical study (single site)' },
  { value: 'benchmark', label: 'Benchmark study' },
  { value: 'vignette_study', label: 'Vignette study' },
  { value: 'simulation_study', label: 'Simulation study' },
  { value: 'internal_test', label: 'Internal test' }
]);
export const INTENDED_USE_LEVELS = Object.freeze([
  { value: 'in_scope', label: 'In scope' },
  { value: 'partially_in_scope', label: 'Partially in scope' },
  { value: 'out_of_scope', label: 'Out of scope' }
]);

export const MAX_SUMMARY = 280;
export const MAX_NOTE = 500;
const INCIDENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today as YYYY-MM-DD in the maintainer's own time zone. */
export function todayIso(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A fresh incident id, e.g. "SI-20261012-K7Q3" (letters, digits, "-"; at most 64). */
export function newIncidentId(now = new Date(), random = Math.random) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const suffix = Array.from({ length: 4 }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
  return `SI-${todayIso(now).replace(/-/g, '')}-${suffix}`;
}

/**
 * The next free incident ID in the pattern the stored incidents follow
 * ("SI-2026-016" → "SI-2026-017"): the prefix of this year's IDs when there
 * are any, else the prefix most stored IDs share, the number one above the
 * highest with that prefix, padded as they are. Without a numbered stored ID
 * it starts the pattern at "SI-<year>-001". Never one of `storedIds`.
 *
 * @param {string[]} storedIds every stored incident's ID (all cards)
 * @param {Date} [now]
 */
export function nextIncidentId(storedIds = [], now = new Date()) {
  const ids = new Set(storedIds);
  const byPrefix = new Map();
  for (const id of ids) {
    const match = /^(.*?)(\d+)$/.exec(id);
    if (!match || !match[1]) continue;
    const entry = byPrefix.get(match[1]) ?? { count: 0, max: 0, width: 0 };
    entry.count += 1;
    entry.max = Math.max(entry.max, Number(match[2]));
    entry.width = Math.max(entry.width, match[2].length);
    byPrefix.set(match[1], entry);
  }
  const yearPrefix = `SI-${now.getFullYear()}-`;
  const prefix = byPrefix.has(yearPrefix)
    ? yearPrefix
    : [...byPrefix.entries()].sort((a, b) => b[1].count - a[1].count || b[1].max - a[1].max)[0]?.[0] ?? yearPrefix;
  const { max = 0, width = 3 } = byPrefix.get(prefix) ?? {};
  let number = max + 1;
  let id = `${prefix}${String(number).padStart(width, '0')}`;
  while (ids.has(id)) {
    number += 1;
    id = `${prefix}${String(number).padStart(width, '0')}`;
  }
  return id;
}

/**
 * A new incident form's ID once the taken IDs are known (the form keeps it as
 * its own). Taken are the stored incidents' IDs and those of incidents staged
 * but not yet published (audit batch 3), so a second new incident before a
 * publish gets the next free ID. A form that staged its entry (`staged`, set
 * when it is sent, and still on screen) keeps its ID.
 *
 * @param {object} form
 * @param {string[]} takenIds stored and staged incident IDs
 * @param {Date} [now]
 */
export function withNextIncidentId(form, takenIds, now = new Date()) {
  if (form.editing || form.staged || form.incidentId !== form.freshId) return form;
  const incidentId = nextIncidentId(takenIds, now);
  return incidentId === form.incidentId ? form : { ...form, incidentId, freshId: incidentId };
}

/**
 * The incident IDs a staged safety upload adds or changes, from its change
 * summary (getUploadChanges, CONTRACT.md §11: a safety row's key is its
 * incident ID). The summary names at most 50 per kind; a form adds one. A
 * staged read (`version=staged:…`) would list them all, but it marks the
 * upload previewed, which the Data Library must not do behind the
 * maintainer's back.
 *
 * @param {object|null} changes a ChangeSummary of kind `safety`
 * @returns {string[]}
 */
export function stagedIncidentIds(changes) {
  if (!changes || changes.kind !== 'safety') return [];
  const samples = changes.rows?.samples ?? {};
  return [...(samples.added ?? []), ...(samples.changed ?? [])].map((sample) => sample.key).filter(Boolean);
}

/**
 * The staged safety uploads whose incidents can be read: valid ones, once
 * each, the page's own upload (polled, so its status is current) first.
 *
 * @param {object|null} upload the page's staged upload
 * @param {object[]} stagedUploads every staged upload of the data set
 * @returns {string[]} upload ids
 */
export function validStagedUploadIds(upload, stagedUploads = []) {
  const byId = new Map();
  [upload, ...stagedUploads].forEach((entry) => {
    if (entry?.upload_id && !byId.has(entry.upload_id)) byId.set(entry.upload_id, entry);
  });
  return [...byId.values()].filter((entry) => entry.status === 'valid').map((entry) => entry.upload_id).sort();
}

/**
 * How the atlas will mark an incident (CONTRACT.md §18; derived, never stored):
 * serious = open and (harm occurred or possible, or a developer notice or
 * recall); caution = any other open incident, or a mitigated one; closed: none.
 *
 * @returns {'serious'|'caution'|null}
 */
export function incidentSeverity({ status, harm, incidentType }) {
  if (status === 'open') {
    return harm === 'occurred' || harm === 'possible' || incidentType === 'developer_notice_or_recall' ? 'serious' : 'caution';
  }
  return status === 'mitigated' ? 'caution' : null;
}

/**
 * An empty incident form for one card. Only the reported date starts as
 * today: the updated date stays empty until the maintainer gives one, because
 * the newest-first order and the newer-record merge rule read it.
 */
export function emptyIncident({ card = null, now = new Date(), random = Math.random } = {}) {
  const incidentId = newIncidentId(now, random);
  return {
    incidentId,
    // The ID the form made up; any other ID may name a stored incident (never sent).
    freshId: incidentId,
    model: card?.model ?? '',
    useCase: card?.useCase ?? '',
    scope: 'codes', // 'codes' | 'chapter'
    codes: [], // [{ code, name }]
    chapterNo: '',
    lens: { ...ALL_LENS },
    incidentType: '',
    harm: '',
    status: 'open',
    sourceType: 'incident_report',
    sourceReference: '',
    studyId: '',
    reportedDate: todayIso(now),
    updatedDate: '',
    summary: '',
    // Contract v1.13 (§26): a public incident, or one this hospital recorded (kept by a public release import).
    recordScope: 'public'
  };
}

const text = (value) => String(value ?? '').trim();

/**
 * What the incident form still needs before it can be checked, as
 * { field: message }. The backend checks everything again; this only saves
 * a round trip for empty required fields.
 */
export function incidentProblems(form) {
  const problems = {};
  if (!INCIDENT_ID.test(text(form.incidentId))) problems.incidentId = 'Use letters, digits, ".", "_", or "-" (at most 64).';
  if (!form.model || !form.useCase) problems.card = 'Choose the AI system and function.';
  if (form.scope === 'chapter' ? !form.chapterNo : !form.codes.length) {
    problems.where = form.scope === 'chapter' ? 'Choose the chapter.' : 'Add at least one condition.';
  }
  if (!form.incidentType) problems.incidentType = 'Choose what kind of incident it is.';
  if (!form.harm) problems.harm = 'Choose whether harm occurred.';
  if (!form.status) problems.status = 'Choose the status.';
  if (!form.sourceType) problems.sourceType = 'Choose the source type.';
  if (!text(form.sourceReference)) problems.sourceReference = 'Say where the incident is reported.';
  if (form.sourceType === 'study' && !text(form.studyId)) problems.studyId = 'An incident from a study needs its Study ID.';
  if (!ISO_DATE.test(form.reportedDate ?? '')) problems.reportedDate = 'Give the reported date.';
  if (form.updatedDate && ISO_DATE.test(form.updatedDate) && form.updatedDate < form.reportedDate) {
    problems.updatedDate = 'The updated date cannot be before the reported date.';
  }
  // An edit dated before the stored incident would be kept out by the merge (CONTRACT.md §11.2).
  const lastDate = ISO_DATE.test(form.updatedDate ?? '') ? form.updatedDate : form.reportedDate;
  if (!problems.updatedDate && form.editing?.lastDate && ISO_DATE.test(lastDate ?? '') && lastDate < form.editing.lastDate) {
    problems.updatedDate = `Give a date on or after ${form.editing.lastDate}, the stored incident’s date; an older edit is kept out.`;
  }
  if (!text(form.summary)) problems.summary = 'Describe the incident in a sentence.';
  else if (text(form.summary).length > MAX_SUMMARY) problems.summary = `At most ${MAX_SUMMARY} characters.`;
  return problems;
}

/**
 * The ID the maintainer typed in place of the form's own, which may name a
 * stored incident that the form would replace field by field; null while the
 * form keeps its fresh ID, edits a stored incident under its own ID, or the
 * ID is not valid yet.
 */
export function changedIncidentId(form) {
  const id = text(form.incidentId);
  return id && INCIDENT_ID.test(id) && id !== form.freshId && id !== form.editing?.id ? id : null;
}

/** The date the merge compares for an incident: updated, else reported (CONTRACT.md §11.2). */
const incidentLastDate = (incident) => incident.updated_date || incident.reported_date;

/**
 * A stored incident (listIncidents, contract v1.11) as the incident form,
 * every field as stored and the ID kept, so publishing the form replaces that
 * incident. `editing` remembers which incident the form edits
 * and its date, never sent.
 *
 * @param {object} stored a StoredIncident
 */
export function storedIncidentForm(stored) {
  const codes = (stored.codes ?? []).map((code, index) => ({ code, name: stored.code_names?.[index] ?? code }));
  const isChapter = Boolean(stored.chapter_no) && !codes.length;
  return {
    incidentId: stored.incident_id,
    freshId: null,
    editing: { id: stored.incident_id, lastDate: incidentLastDate(stored) },
    model: stored.model_version,
    useCase: stored.use_case,
    scope: isChapter ? 'chapter' : 'codes',
    codes,
    chapterNo: stored.chapter_no ?? '',
    lens: {
      age: stored.lens?.age || ALL_LENS.age,
      sex: stored.lens?.sex || ALL_LENS.sex,
      ethnicity: stored.lens?.ethnicity || ALL_LENS.ethnicity
    },
    incidentType: stored.incident_type ?? '',
    harm: stored.harm ?? '',
    status: stored.status ?? '',
    sourceType: stored.source_type ?? '',
    sourceReference: stored.source_reference ?? '',
    studyId: stored.study_id ?? '',
    reportedDate: stored.reported_date ?? '',
    updatedDate: stored.updated_date ?? '',
    summary: stored.summary ?? '',
    recordScope: stored.scope === 'hospital' ? 'hospital' : 'public'
  };
}

const lensCell = (value, all) => (value && value !== all ? value : null);

/**
 * The incident form as one safety record (template column keys). Codes are
 * joined with ";"; a chapter is written "chapter 06"; "All …" groups stay
 * empty, as in the template.
 */
export function incidentRecord(form) {
  return {
    incident_id: text(form.incidentId),
    model_version: form.model,
    use_case: form.useCase,
    codes: form.scope === 'chapter' ? `chapter ${form.chapterNo}` : form.codes.map((entry) => entry.code).join('; '),
    age: lensCell(form.lens?.age, ALL_LENS.age),
    sex: lensCell(form.lens?.sex, ALL_LENS.sex),
    ethnicity: lensCell(form.lens?.ethnicity, ALL_LENS.ethnicity),
    incident_type: form.incidentType,
    harm: form.harm,
    status: form.status,
    source_type: form.sourceType,
    source_reference: text(form.sourceReference),
    study_id: form.sourceType === 'study' ? text(form.studyId) || null : null,
    reported_date: form.reportedDate,
    updated_date: form.updatedDate || null,
    summary: text(form.summary),
    scope: form.recordScope === 'hospital' ? 'Hospital' : 'Public'
  };
}

// The 13 metric fields of a template row, in the template's order and words.
export const METRIC_FIELDS = Object.freeze([
  { key: 'perf', label: 'Performance', type: 'share', hint: '0 to 1, e.g. 0.84' },
  { key: 'ci_low', label: 'CI low', type: 'share', hint: '0 to 1' },
  { key: 'ci_high', label: 'CI high', type: 'share', hint: '0 to 1' },
  { key: 'evidence_grade', label: 'Evidence grade', type: 'grade' },
  { key: 'n_samples', label: 'Samples', type: 'count' },
  { key: 'n_sites', label: 'Sites', type: 'count' },
  { key: 'n_studies', label: 'Studies', type: 'count' },
  { key: 'peer_reviewed_studies', label: 'Peer-reviewed studies', type: 'count' },
  { key: 'validation_type', label: 'Validation type', type: 'validation' },
  { key: 'in_intended_use', label: 'In intended use', type: 'yes_no' },
  { key: 'intended_use_coverage', label: 'Intended-use coverage', type: 'share', hint: '0 to 1' },
  { key: 'intended_use_level', label: 'Intended-use level', type: 'level' },
  { key: 'warnings', label: 'Warnings', type: 'warnings', hint: 'Codes separated by ";"' }
]);

/** The three intended-use fields: hidden, and sent empty, on a card without an intended-use statement. */
export const INTENDED_USE_KEYS = Object.freeze(['in_intended_use', 'intended_use_coverage', 'intended_use_level']);

/**
 * The warning codes a stored metrics row carries (CONTRACT.md §4.6), offered
 * as checkboxes in the one-row form; their words come from the condition
 * card's warning copy. A code outside this list (from a file or the study
 * helper) stays as it is.
 */
export const METRIC_WARNING_CODES = Object.freeze([
  'clinician_review_required',
  'performance_below_target',
  'no_performance_data',
  'no_validation_data',
  'wide_confidence_interval',
  'limited_validation_depth',
  'rare_condition_low_support',
  'out_of_scope_group',
  'mental_disorders_high_variance'
]);

/** A Warnings cell as a list of codes ("a; b" → ['a', 'b']). */
export function warningList(value) {
  return String(value ?? '')
    .split(';')
    .map((code) => code.trim())
    .filter(Boolean);
}

/** The list with `code` switched on or off, as a Warnings cell, in the order given. */
export function toggleWarning(value, code, isOn) {
  const codes = warningList(value).filter((entry) => entry !== code);
  return (isOn ? [...codes, code] : codes).join('; ');
}

/** An empty metrics row form (the card comes from the page). */
export function emptyMetricRow({ now = new Date() } = {}) {
  return {
    condition: null, // { code, name }
    lens: { ...ALL_LENS },
    // The care setting (contract v1.14, §29): '' is Any setting, else a specific setting's axis value.
    setting: '',
    values: Object.fromEntries(METRIC_FIELDS.map((field) => [field.key, field.key === 'in_intended_use' ? 'Yes' : field.key === 'intended_use_level' ? 'in_scope' : ''])),
    source: '',
    study: '',
    sourceDate: todayIso(now)
  };
}

// A share (0–1) may use a decimal comma ("0,84"); a count is plain digits, so
// "1,000", "1.000", "1e3", and "0x10" are never read as some other number.
const SHARE = /^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/;
const COUNT = /^\d+$/;

/**
 * A share or count field as a number, or the problem to show under it.
 *
 * @param {string} value the trimmed field text (not empty)
 * @param {'share'|'count'} type
 * @returns {{ number: number }|{ problem: string }}
 */
export function parseMetricNumber(value, type) {
  if (type === 'count') {
    return COUNT.test(value) ? { number: Number(value) } : { problem: 'A whole number in digits only, e.g. 1200 (no separators).' };
  }
  if (!SHARE.test(value)) {
    return { problem: 'A number between 0 and 1, e.g. 0.84 or 0,84.' };
  }
  const number = Number(value.replace(',', '.'));
  return number <= 1 ? { number } : { problem: 'Between 0 and 1.' };
}

/** The message under Validation type when Performance has a value without it (contract v1.11). */
export const EVIDENCE_NEEDED = 'Choose the validation type: a Performance value needs its evidence. Or leave Performance, CI low, and CI high empty until it is known.';
const NO_VALIDATION_WARNING = 'Remove no_validation_data: this row gives Performance with its evidence.';

const warningCodes = (value) =>
  String(value ?? '')
    .split(';')
    .map((code) => code.trim())
    .filter(Boolean);

/**
 * Performance needs evidence (contract v1.11): a row with a
 * Performance value must name its Validation type and must not carry the
 * warning no_validation_data, or the backend rejects it at check
 * (`performance_without_evidence`). Works on form texts and on record values.
 *
 * @param {object} values the 13 metric fields (texts or record values)
 * @param {object} [known] problems already found, which take precedence
 * @returns {{ validation_type?: string, warnings?: string }}
 */
export function evidenceProblems(values, known = {}) {
  const problems = {};
  if (values?.perf === null || values?.perf === undefined || text(values.perf) === '' || known.perf) {
    return problems;
  }
  if (!text(values.validation_type) && !known.validation_type) problems.validation_type = EVIDENCE_NEEDED;
  if (warningCodes(values.warnings).includes('no_validation_data') && !known.warnings) problems.warnings = NO_VALIDATION_WARNING;
  return problems;
}

const INTENDED_USE_PAIR = 'Fill both In intended use and Intended-use level, or leave both empty when the row states no intended use.';
const COVERAGE_WITHOUT_SCOPE = 'Coverage needs In intended use and Intended-use level; fill them, or leave all three empty.';

/**
 * Intended use is optional per row (contract v1.11): In intended use and
 * Intended-use level are given together or not at all, and coverage only
 * with them. A card without an intended-use statement ignores all three.
 *
 * @param {object} values the 13 metric fields (form texts)
 * @param {object} [known] problems already found, which take precedence
 */
function intendedUseProblems(values, known = {}) {
  const problems = {};
  const inScope = text(values?.in_intended_use);
  const level = text(values?.intended_use_level);
  if (inScope && !level && !known.intended_use_level) problems.intended_use_level = INTENDED_USE_PAIR;
  if (level && !inScope && !known.in_intended_use) problems.in_intended_use = INTENDED_USE_PAIR;
  if (!inScope && !level && text(values?.intended_use_coverage) && !known.intended_use_coverage) problems.intended_use_coverage = COVERAGE_WITHOUT_SCOPE;
  return problems;
}

/**
 * What the metrics row form still needs, as { field: message }. On a card
 * without an intended-use statement the intended-use fields are not asked.
 *
 * @param {object} form
 * @param {{ hasIntendedUse?: boolean }} [options]
 */
export function metricRowProblems(form, { hasIntendedUse = true } = {}) {
  if (!hasIntendedUse) {
    form = { ...form, values: withoutIntendedUse(form.values) };
  }
  const problems = {};
  if (!form.condition) problems.condition = 'Choose the condition.';
  METRIC_FIELDS.forEach((field) => {
    const value = text(form.values[field.key]);
    if (field.required && !value) problems[field.key] = 'Required.';
    if (value && (field.type === 'share' || field.type === 'count')) {
      const parsed = parseMetricNumber(value, field.type);
      if (parsed.problem) problems[field.key] = parsed.problem;
    }
  });
  Object.assign(problems, evidenceProblems(form.values, problems));
  Object.assign(problems, intendedUseProblems(form.values, problems));
  if (!text(form.source)) problems.source = 'Name the source, e.g. the study title.';
  if (!text(form.study)) problems.study = 'Give the study identifier.';
  if (!ISO_DATE.test(form.sourceDate ?? '')) problems.sourceDate = 'Give the source date.';
  return problems;
}

function withoutIntendedUse(values) {
  return { ...values, ...Object.fromEntries(INTENDED_USE_KEYS.map((key) => [key, ''])) };
}

/**
 * The metrics row form as one metrics record. The lens is always written
 * (metrics rows need it); empty fields stay empty, as in the template. On a
 * card without an intended-use statement the intended-use fields go empty.
 *
 * @param {object} form
 * @param {{ hasIntendedUse?: boolean }} [options]
 */
export function metricRecord(form, { hasIntendedUse = true } = {}) {
  if (!hasIntendedUse) {
    form = { ...form, values: withoutIntendedUse(form.values) };
  }
  const record = {
    code: form.condition?.code ?? '',
    age: form.lens.age,
    sex: form.lens.sex,
    ethnicity: form.lens.ethnicity
  };
  // A specific care setting is sent as the record's Setting (§29); Any setting sends none, as before.
  const setting = specificSetting(form.setting);
  if (setting) record.setting = setting;
  METRIC_FIELDS.forEach((field) => {
    const value = text(form.values[field.key]);
    if (!value) {
      record[field.key] = field.key === 'warnings' ? '' : null;
    } else if (field.type === 'share' || field.type === 'count') {
      // The form checks first; a value it would reject is sent as typed, so the backend names it too.
      record[field.key] = parseMetricNumber(value, field.type).number ?? value;
    } else {
      record[field.key] = value;
    }
  });
  record.source = text(form.source);
  record.study = text(form.study);
  record.source_date = form.sourceDate;
  return record;
}

/** A change note the page can send: some text, at most 500 characters (contract v1.7). */
export function noteIsReady(note) {
  const trimmed = String(note ?? '').trim();
  return trimmed.length > 0 && trimmed.length <= MAX_NOTE;
}

/** The words the merge and replace choices use (CONTRACT.md §11.2). */
export const MODE_WORDS = Object.freeze({
  merge: { title: 'Add or change rows', short: 'adds or changes rows' },
  replace: { title: 'Replace the whole data set', short: 'replaces the whole data set' }
});

/** The mode in a sentence, in the data set's own noun ("adds or changes incidents" on Safety incidents). */
export function modeShort(mode, kind) {
  const words = MODE_WORDS[mode ?? 'replace'] ?? MODE_WORDS.replace;
  const noun = { safety: 'incidents', studies: 'studies', effects: 'effects' }[kind];
  return noun ? words.short.replace('rows', noun) : words.short;
}
