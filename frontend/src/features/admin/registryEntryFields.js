// The contract v1.14 registry fields of a new AI system in the developer's
// submission form (CONTRACT.md §11.1, §28): Replaces, the configuration
// record, what the figures measure, and the four data-protection
// declarations. Every field is optional. The checks and their fixes are the
// registry upload's (backend app/validation, issues.py), so the form names a
// problem before anything is sent; the backend checks the record again.
// React-free, so the tests can drive it.

/** Limits of contract v1.14 (backend app/schema/contract.py). */
export const ENTRY_LIMITS = Object.freeze({
  promptSummary: 500,
  retrieval: 280,
  fineTuning: 280,
  measure: 200,
  referenceStandard: 200,
  dataUse: 500,
  dataLocation: 200,
  retention: 200,
  privacyContact: 200,
  tools: 10,
  toolName: 60
});

const CONFIGURATION_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// A number as typed: digits with one decimal point or comma ("0.2", "0,2").
const DECIMAL = /^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/;
const WHOLE = /^\d+$/;
export const TOOL_SEPARATOR = ';';

/** The plain fixes, in the words of the registry upload's issues (§28.1, §28.2). */
export const ENTRY_FIXES = Object.freeze({
  configurationId: 'Use at most 64 letters, digits, ".", "_", or "-", e.g. cfg-2026-09, or leave it empty.',
  configurationDate: 'A calendar date, YYYY-MM-DD, or leave it empty.',
  promptSha256: 'Paste the 64-character SHA-256 checksum of the full prompt (0-9 and a-f), or leave it empty. Never paste the prompt itself.',
  tooMany: `List at most ${ENTRY_LIMITS.tools} tool names, separated by "${TOOL_SEPARATOR}".`,
  toolName: `Each tool name at most ${ENTRY_LIMITS.toolName} characters.`,
  temperature: 'A number between 0 and 2, e.g. 0.2, or leave it empty.',
  topP: 'A number between 0 and 1, e.g. 0.9, or leave it empty.',
  maxTokens: 'A whole number of at least 1, e.g. 1200, or leave it empty.',
  replacesSelf: 'Name the earlier version this AI system replaces, not this one.'
});

/** The fields of an empty form (all optional). */
export function emptyEntryFields() {
  return {
    replaces: '',
    configurationId: '',
    configurationDate: '',
    promptSummary: '',
    promptSha256: '',
    retrieval: '',
    tools: '',
    temperature: '',
    topP: '',
    maxTokens: '',
    fineTuning: '',
    measure: '',
    referenceStandard: '',
    dataUse: '',
    dataLocation: '',
    retention: '',
    privacyContact: ''
  };
}

const clean = (value) => String(value ?? '').trim();
// A line break in a cell is refused by the registry check; in a text area it reads as a space.
const oneLine = (value) => clean(value).replace(/\s+/g, ' ');

/** The tool names as the registry stores them: split on ";", trimmed, empties and repeats dropped. */
export function toolNames(value) {
  const seen = new Set();
  return String(value ?? '')
    .split(TOOL_SEPARATOR)
    .map((name) => name.trim())
    .filter((name) => name && !seen.has(name.toLowerCase()) && seen.add(name.toLowerCase()));
}

function number(value, { min, max, whole = false }) {
  const typed = clean(value);
  if (!(whole ? WHOLE : DECIMAL).test(typed)) return null;
  const parsed = Number(typed.replace(',', '.'));
  return parsed >= min && parsed <= max ? parsed : null;
}

function isCalendarDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const TEXT_FIELDS = Object.freeze([
  'promptSummary',
  'retrieval',
  'fineTuning',
  'measure',
  'referenceStandard',
  'dataUse',
  'dataLocation',
  'retention',
  'privacyContact'
]);

/**
 * What the v1.14 fields still need, as { field: message }; empty fields are
 * fine. `modelVersion` is the new AI system's own version (Replaces must not
 * name it).
 *
 * @param {ReturnType<typeof emptyEntryFields>} entry
 * @param {{ modelVersion?: string }} [options]
 */
export function entryFieldProblems(entry, { modelVersion = '' } = {}) {
  const problems = {};
  const fields = { ...emptyEntryFields(), ...entry };
  if (clean(fields.replaces) && clean(fields.replaces) === clean(modelVersion)) problems.replaces = ENTRY_FIXES.replacesSelf;
  if (clean(fields.configurationId) && !CONFIGURATION_ID.test(clean(fields.configurationId))) problems.configurationId = ENTRY_FIXES.configurationId;
  if (clean(fields.configurationDate) && !isCalendarDate(clean(fields.configurationDate))) problems.configurationDate = ENTRY_FIXES.configurationDate;
  if (clean(fields.promptSha256) && !SHA256.test(clean(fields.promptSha256))) problems.promptSha256 = ENTRY_FIXES.promptSha256;
  const tools = toolNames(fields.tools);
  if (tools.length > ENTRY_LIMITS.tools) problems.tools = ENTRY_FIXES.tooMany;
  else if (tools.some((name) => name.length > ENTRY_LIMITS.toolName)) problems.tools = ENTRY_FIXES.toolName;
  if (clean(fields.temperature) && number(fields.temperature, { min: 0, max: 2 }) === null) problems.temperature = ENTRY_FIXES.temperature;
  if (clean(fields.topP) && number(fields.topP, { min: 0, max: 1 }) === null) problems.topP = ENTRY_FIXES.topP;
  if (clean(fields.maxTokens) && number(fields.maxTokens, { min: 1, max: Number.MAX_SAFE_INTEGER, whole: true }) === null) problems.maxTokens = ENTRY_FIXES.maxTokens;
  for (const key of TEXT_FIELDS) {
    if (oneLine(fields[key]).length > ENTRY_LIMITS[key]) problems[key] = `At most ${ENTRY_LIMITS[key]} characters.`;
  }
  return problems;
}

/**
 * The v1.14 cells of the registry record (template column keys); only the
 * filled ones, so a form that leaves them empty sends what it sent before.
 *
 * @param {ReturnType<typeof emptyEntryFields>} entry
 */
export function entryRecordCells(entry) {
  const fields = { ...emptyEntryFields(), ...entry };
  const cells = {
    replaces: clean(fields.replaces),
    configuration_id: clean(fields.configurationId),
    configuration_date: clean(fields.configurationDate),
    prompt_summary: oneLine(fields.promptSummary),
    prompt_sha256: clean(fields.promptSha256).toLowerCase(),
    retrieval: oneLine(fields.retrieval),
    tools: toolNames(fields.tools).join(`${TOOL_SEPARATOR} `),
    sampling_temperature: number(fields.temperature, { min: 0, max: 2 }) ?? clean(fields.temperature),
    sampling_top_p: number(fields.topP, { min: 0, max: 1 }) ?? clean(fields.topP),
    sampling_max_output_tokens: number(fields.maxTokens, { min: 1, max: Number.MAX_SAFE_INTEGER, whole: true }) ?? clean(fields.maxTokens),
    fine_tuning: oneLine(fields.fineTuning),
    performance_measure: oneLine(fields.measure),
    reference_standard: oneLine(fields.referenceStandard),
    declared_data_use: oneLine(fields.dataUse),
    declared_data_location: oneLine(fields.dataLocation),
    declared_retention: oneLine(fields.retention),
    declared_privacy_contact: oneLine(fields.privacyContact)
  };
  return Object.fromEntries(Object.entries(cells).filter(([, value]) => value !== ''));
}
