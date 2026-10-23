// The study helper of the Data Library (contract v1.9, CONTRACT.md §20): its words, the review state of a
// proposal, and the mapping from the records the maintainer keeps to the
// createRecordsUpload body (a merge, CONTRACT.md §11.4). The helper proposes,
// never publishes: nothing here stages or sends anything by itself.
//
// The API key never passes through this module's state: `configureRequest`
// takes it as an argument at the moment of saving and returns the request
// body, which the caller sends at once and drops.

import { displayUseCase, populationWords } from '../../shared/format.js';
import {
  ALL_LENS,
  EVIDENCE_GRADES,
  HARMS,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  INTENDED_USE_LEVELS,
  MAX_SUMMARY,
  METRIC_FIELDS,
  SOURCE_TYPES,
  VALIDATION_TYPES,
  evidenceProblems,
  parseMetricNumber
} from './records.js';

export const HELPER_NAME = 'Study helper';

export const PROVIDER_WORDS = Object.freeze({
  hosted: {
    title: 'A hosted model, with your own API key',
    help: 'The Anthropic Messages API. It reads PDFs, text, and tables. Your key stays in a file on this computer.',
    short: 'hosted model'
  },
  local: {
    title: 'A local model on this computer',
    help: 'Any OpenAI-compatible API, such as a local model server. It reads text and tables; paste the text of a PDF.',
    short: 'local model'
  }
});

export const DEFAULT_HOSTED_MODEL = 'claude-sonnet-5-5';
export const LOCAL_URL_EXAMPLE = 'http://127.0.0.1:11434/v1';
export const MAX_STUDY_CHARACTERS = 200000;
export const MAX_STUDY_BYTES = 10 * 1024 * 1024;

/** One line for the sidebar: "Off", or "On, hosted model, claude-sonnet-5-5". */
export function helperDetail(status) {
  if (!status) return 'Checking…';
  if (!status.enabled) return 'Off';
  return `On, ${PROVIDER_WORDS[status.provider]?.short ?? status.provider}, ${status.model}`;
}

/** Where a proposal sends the study, in one sentence. */
export function destinationSentence(status) {
  if (!status?.enabled) return '';
  if (status.provider === 'local') {
    return `Proposing sends this study to the local model ${status.model} at ${status.base_url}.`;
  }
  return `Proposing sends this study to the hosted model ${status.model}${status.base_url ? ` through ${status.base_url}` : ''}.`;
}

const ACCEPT_TYPES = {
  pdf: { attr: '.pdf,application/pdf', word: 'PDF' },
  text: { attr: '.txt,.md,text/plain,text/markdown', word: 'text' },
  csv: { attr: '.csv,.tsv,text/csv,text/tab-separated-values', word: 'CSV' },
  xlsx: { attr: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', word: 'Excel' }
};

/** The file input's accept attribute for the provider's inputs. */
export function acceptAttribute(accepts) {
  return (accepts ?? []).map((kind) => ACCEPT_TYPES[kind]?.attr).filter(Boolean).join(',');
}

/** "PDF, text, CSV, or Excel" */
export function acceptWords(accepts) {
  const words = (accepts ?? []).map((kind) => ACCEPT_TYPES[kind]?.word).filter(Boolean);
  if (words.length < 2) return words.join('');
  return `${words.slice(0, -1).join(', ')}, or ${words.at(-1)}`;
}

/** Whether a chosen file is one the configured provider reads (by extension). */
export function fileIsAccepted(file, accepts) {
  const name = String(file?.name ?? '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const kind = ext === 'pdf' ? 'pdf' : ext === 'txt' || ext === 'md' ? 'text' : ext === 'csv' || ext === 'tsv' ? 'csv' : ext === 'xlsx' ? 'xlsx' : null;
  return Boolean(kind && (accepts ?? []).includes(kind));
}

/** "12.4 KB" */
export function sizeWords(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const DROP_REASONS = Object.freeze({
  unknown_code: 'Code not in the atlas',
  not_a_condition: 'Not a top-level condition',
  unknown_card: 'Not a card in the catalogue',
  other_card: 'For another card',
  invalid_value: 'Value not allowed',
  duplicate: 'Repeated record'
});

const ORIGIN_WORDS = Object.freeze({
  study: 'From the study',
  search: 'Found by name in the atlas',
  store: 'Kept from the stored row',
  request: 'The card you chose',
  default: 'Default',
  generated: 'Made up by the helper'
});

// Fields the study speaks for; the others fold into one line per origin.
const SHOWN_ORIGINS = new Set(['study', 'search', 'generated']);

const SAFETY_LABELS = {
  incident_id: 'Incident ID',
  model_version: 'AI system',
  use_case: 'Function',
  codes: 'ICD-11 codes',
  incident_type: 'Incident type',
  harm: 'Harm',
  status: 'Status',
  source_type: 'Source type',
  source_reference: 'Source reference',
  study_id: 'Study ID',
  reported_date: 'Reported date',
  updated_date: 'Updated date',
  summary: 'Summary'
};

const COMMON_LABELS = {
  code: 'ICD-11 code',
  condition: 'Condition',
  conditions: 'Conditions',
  age: 'Age',
  sex: 'Sex',
  ethnicity: 'Ethnicity',
  source: 'Source',
  study: 'Study',
  source_date: 'Source date',
  ...Object.fromEntries(METRIC_FIELDS.map((field) => [field.key, field.label])),
  ...SAFETY_LABELS
};

/** The template's words for a record key. */
export function fieldLabel(key) {
  return COMMON_LABELS[key] ?? key;
}

/** Template order of a data set's record keys (as the API lists them). */
export const FIELD_ORDER = Object.freeze({
  metrics: ['code', 'age', 'sex', 'ethnicity', ...METRIC_FIELDS.map((field) => field.key), 'source', 'study', 'source_date'],
  safety: Object.keys(SAFETY_LABELS).slice(0, 4).concat(['age', 'sex', 'ethnicity'], Object.keys(SAFETY_LABELS).slice(4))
});

const LENS_KEYS = ['age', 'sex', 'ethnicity'];

/** A proposed value as the page shows it ("Empty" for nothing). */
export function displayValue(key, value) {
  if (value === null || value === undefined || value === '') {
    if (LENS_KEYS.includes(key)) return ALL_LENS[key];
    return 'Empty';
  }
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (key === 'use_case') return displayUseCase(value);
  return String(value);
}

/** A record's id in the review: batch and record index. */
const recordId = (batchIndex, recordIndex) => `${batchIndex}:${recordIndex}`;

/** Every proposed record with its id, in the order the API lists them. */
export function proposedRecords(proposals) {
  return (proposals?.batches ?? []).flatMap((batch, batchIndex) =>
    batch.records.map((entry, recordIndex) => ({ id: recordId(batchIndex, recordIndex), batch, batchIndex, entry }))
  );
}

/** Counts for the figure row: records, fields to check, items left out. */
export function proposalSummary(proposals) {
  const records = proposedRecords(proposals);
  const uncertainFields = records.reduce((sum, { entry }) => sum + Object.values(entry.fields ?? {}).filter((field) => field.uncertain).length, 0);
  return { records: records.length, uncertainFields, dropped: proposals?.dropped?.length ?? 0 };
}

/**
 * The title of one proposed record: for metrics the condition, its code, and
 * the group; for safety the incident type, its card, and its conditions.
 */
export function recordTitle(kind, record, conditions = []) {
  const names = new Map(conditions.map((entry) => [entry.code, entry.name]));
  const lens = populationWords({ age: record.age ?? ALL_LENS.age, sex: record.sex ?? ALL_LENS.sex, ethnicity: record.ethnicity ?? ALL_LENS.ethnicity });
  if (kind === 'safety') {
    const codes = String(record.codes ?? '')
      .split(';')
      .map((code) => code.trim())
      .filter(Boolean);
    const where = codes.map((code) => (names.get(code) ? `${names.get(code)} (${code})` : code)).join(', ');
    return {
      title: displayValue('incident_type', record.incident_type),
      detail: [`${record.model_version}, ${displayUseCase(record.use_case)}`, where, lens].filter(Boolean).join('; ')
    };
  }
  const name = names.get(record.code);
  return { title: name ? `${name} (${record.code})` : String(record.code ?? 'No condition'), detail: lens };
}

/**
 * A record's fields split for reading: `shown` are the values the study
 * speaks for (plus any uncertain field), each with its source; `folded`
 * groups the rest by origin ("Kept from the stored row: …").
 */
export function fieldsForReading(kind, entry) {
  const order = FIELD_ORDER[kind] ?? Object.keys(entry.record);
  const keys = [...order.filter((key) => key in entry.record), ...Object.keys(entry.record).filter((key) => !order.includes(key))];
  const shown = [];
  const folded = new Map();
  keys.forEach((key) => {
    const field = entry.fields?.[key] ?? { origin: 'study', source: null, confidence: null, uncertain: false, reason: null };
    if (SHOWN_ORIGINS.has(field.origin) || field.uncertain) {
      shown.push({ key, value: entry.record[key], field });
    } else {
      if (!folded.has(field.origin)) folded.set(field.origin, []);
      folded.get(field.origin).push({ key, value: entry.record[key] });
    }
  });
  return { shown, folded: [...folded.entries()].map(([origin, items]) => ({ origin, label: ORIGIN_WORDS[origin] ?? origin, items })) };
}

const ROW_SOURCE_KEYS = ['source', 'study', 'source_date'];

/**
 * Whether a metrics proposal keeps values from the stored row under this
 * study's Source, Study, or Source date. A merge row has one source, so
 * staging credits the whole row to this study (CONTRACT.md §20); the API flags
 * the Source field, and the review says so next to the kept values.
 */
export function creditsStoredValues(kind, entry) {
  if (kind !== 'metrics') return false;
  const fields = Object.values(entry?.fields ?? {});
  return fields.some((field) => field.origin === 'store') && ROW_SOURCE_KEYS.some((key) => entry.fields?.[key]?.origin === 'study');
}

/** "“the accuracy was 0.83”, Results, page 2" */
export function sourceWords(source) {
  if (!source) return null;
  const quote = source.quote ? `“${source.quote}”` : null;
  return [quote, source.location].filter(Boolean).join(', ') || null;
}

/** A fresh review: every record kept, nothing edited, nothing open for editing. */
export function initialReview(proposals) {
  return { kept: Object.fromEntries(proposedRecords(proposals).map(({ id }) => [id, true])), edits: {}, editing: {} };
}

// ---------------------------------------------------------------- editing

const FIELD_TYPES = Object.fromEntries(METRIC_FIELDS.map((field) => [field.key, field.type]));

/** The edit control of a record key: what kind of field the form shows. */
export function editKind(kind, key) {
  if (LENS_KEYS.includes(key)) return 'lens';
  if (kind === 'metrics') {
    if (key === 'code') return 'condition';
    if (key === 'source_date') return 'date';
    return FIELD_TYPES[key] ?? 'text';
  }
  if (key === 'codes') return 'conditions';
  if (key === 'incident_type' || key === 'harm' || key === 'status' || key === 'source_type') return key;
  if (key === 'reported_date' || key === 'updated_date') return 'date';
  if (key === 'summary') return 'summary';
  if (key === 'model_version' || key === 'use_case') return 'card';
  return 'text';
}

const LABELLED = {
  validation: VALIDATION_TYPES,
  level: INTENDED_USE_LEVELS,
  incident_type: INCIDENT_TYPES,
  harm: HARMS,
  status: INCIDENT_STATUSES,
  source_type: SOURCE_TYPES
};

/** Select options of a labelled field: the template's codes with their readable labels (the API accepts either). */
export function labelledOptions(type) {
  return (LABELLED[type] ?? []).map((option) => ({ value: option.value, label: option.label }));
}

/** A proposed value as the text an edit field starts with. */
export function editText(kind, key, value) {
  const type = editKind(kind, key);
  if (value === null || value === undefined) {
    return type === 'lens' ? ALL_LENS[key] : '';
  }
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  const options = LABELLED[type];
  if (options) {
    const match = options.find((option) => option.value === value || option.label.toLowerCase() === String(value).toLowerCase());
    return match ? match.value : String(value);
  }
  if (type === 'grade') return String(value).toUpperCase();
  return String(value);
}

export { EVIDENCE_GRADES };

/** What an edited record still needs, as { key: message }; only edited keys are checked. */
export function editProblems(kind, edits = {}) {
  const problems = {};
  Object.entries(edits).forEach(([key, raw]) => {
    if (key.startsWith('__')) return;
    const value = String(raw ?? '').trim();
    const type = editKind(kind, key);
    if ((type === 'share' || type === 'count') && value) {
      const parsed = parseMetricNumber(value, type);
      if (parsed.problem) problems[key] = parsed.problem;
    }
    if (kind === 'metrics' && (key === 'in_intended_use' || key === 'intended_use_level') && !value) problems[key] = 'Required.';
    if (kind === 'metrics' && key === 'code' && !value) problems[key] = 'Choose the condition.';
    if (kind === 'safety' && key === 'codes' && !value) problems[key] = 'Add at least one condition.';
    if (type === 'date' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) problems[key] = 'A date as YYYY-MM-DD.';
    if (type === 'summary' && value.length > MAX_SUMMARY) problems[key] = `At most ${MAX_SUMMARY} characters.`;
    if (kind === 'safety' && ['incident_id', 'source_reference', 'summary', 'reported_date'].includes(key) && !value) problems[key] = 'Required.';
  });
  return problems;
}

/** An edited text as the record value createRecordsUpload takes. */
function editedValue(kind, key, raw) {
  const value = String(raw ?? '').trim();
  const type = editKind(kind, key);
  if (type === 'lens') {
    // Safety rows leave "All …" groups empty, as the template does; metrics rows always name the group.
    return kind === 'safety' && value === ALL_LENS[key] ? null : value || ALL_LENS[key];
  }
  if (!value) return key === 'warnings' ? '' : null;
  if (type === 'share' || type === 'count') {
    // A value the page would reject is sent as typed, so the check names it too.
    return parseMetricNumber(value, type).number ?? value;
  }
  return value;
}

/** A proposed record with the maintainer's edits applied. */
export function editedRecord(kind, entry, edits = {}) {
  const record = { ...entry.record };
  Object.entries(edits ?? {}).forEach(([key, raw]) => {
    if (!key.startsWith('__') && (key in record || FIELD_ORDER[kind]?.includes(key))) {
      record[key] = editedValue(kind, key, raw);
    }
  });
  return record;
}

/**
 * What one proposed record still needs before it can be staged, as
 * { key: message }: the problems of its edits and, for metrics, Performance
 * without its evidence (contract v1.11), which the backend
 * would reject at check.
 */
export function proposalProblems(kind, entry, edits = {}) {
  const problems = editProblems(kind, edits ?? {});
  if (kind !== 'metrics') return problems;
  return { ...problems, ...evidenceProblems(editedRecord(kind, entry, edits), problems) };
}

/** Whether any kept record has a problem (staging waits for it). */
export function reviewProblems(proposals, review) {
  return proposedRecords(proposals)
    .filter(({ id }) => review.kept[id])
    .map(({ id, entry }) => ({ id, problems: proposalProblems(proposals.kind, entry, review.edits[id]) }))
    .filter(({ problems }) => Object.keys(problems).length);
}

/**
 * The createRecordsUpload request for the records the maintainer keeps: a
 * merge (the client always sends mode "merge"), only ticked records, with
 * their edits. Metrics stage the batch of the page's card; a batch for
 * another card is never staged here (the helper drops those already when a
 * card is chosen). Safety stages its one batch; every incident names its card.
 *
 * @returns {{ kind: string, modelVersion?: string, useCase?: string, records: object[], skipped: number }}
 */
export function stageRequest(proposals, review, { card = null } = {}) {
  const kind = proposals.kind;
  const records = [];
  let skipped = 0;
  proposedRecords(proposals).forEach(({ id, batch, entry }) => {
    if (!review.kept[id]) return;
    if (kind === 'metrics' && card && (batch.model_version !== card.model || batch.use_case !== card.useCase)) {
      skipped += 1;
      return;
    }
    records.push(editedRecord(kind, entry, review.edits[id]));
  });
  if (kind === 'metrics') {
    return { kind, modelVersion: card?.model, useCase: card?.useCase, records, skipped };
  }
  return { kind, records, skipped };
}

// ------------------------------------------------------------ settings

/**
 * The configureAssist request from the settings form and the key typed this
 * time (or '' to keep the stored key). The key is passed in, never held.
 */
export function configureRequest(form, apiKey = '') {
  const request = { provider: form.provider };
  const model = String(form.model ?? '').trim();
  const baseUrl = String(form.baseUrl ?? '').trim();
  if (model) request.model = model;
  if (baseUrl) request.baseUrl = baseUrl;
  if (apiKey) request.apiKey = apiKey;
  return request;
}

/** The settings form's starting values from the status (never a key). */
export function settingsForm(status) {
  if (status?.enabled) {
    return { provider: status.provider, model: status.model ?? '', baseUrl: status.base_url ?? '' };
  }
  return { provider: 'hosted', model: '', baseUrl: '' };
}

const HOSTED_ORIGIN = 'https://api.anthropic.com';
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };

/**
 * The origin (scheme, host, port) a provider's requests go to, as the backend
 * compares it (config.endpoint_origin); null for an address that is not a URL.
 */
export function endpointOrigin(provider, baseUrl) {
  const raw = String(baseUrl ?? '').trim() || (provider === 'hosted' ? HOSTED_ORIGIN : '');
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || DEFAULT_PORTS[url.protocol] || ''}`;
  } catch {
    return null;
  }
}

/**
 * Whether saving the form keeps the stored key: only for the same provider at
 * the same origin. The backend never sends a stored key to another address, so
 * a changed address needs the key typed again (a local model saves without one).
 */
export function keyStaysWith(status, form) {
  if (!status?.enabled || !status.key_set || status.provider !== form.provider) return false;
  const before = endpointOrigin(status.provider, status.base_url);
  return before !== null && before === endpointOrigin(form.provider, form.baseUrl);
}

/** Whether a stored key is left behind because the form names another address (same provider). */
export function keyLeftBehind(status, form) {
  return Boolean(status?.enabled && status.key_set && status.provider === form.provider && !keyStaysWith(status, form));
}

/** Whether an address names this computer (127.0.0.1 and the rest of 127/8, ::1, localhost), as the backend requires for a local model. */
export function isLoopbackUrl(value) {
  try {
    const host = new URL(String(value ?? '').trim()).hostname.toLowerCase();
    return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** What the settings form still needs before it can be saved, as { field: message }. */
export function settingsProblems(form, { keyTyped, keyKept, addressChanged = false }) {
  const problems = {};
  if (form.provider === 'local') {
    const baseUrl = String(form.baseUrl ?? '').trim();
    if (!baseUrl) problems.baseUrl = `The address of its OpenAI-compatible API, e.g. ${LOCAL_URL_EXAMPLE}.`;
    else if (!isLoopbackUrl(baseUrl)) problems.baseUrl = 'A local model runs on this computer: use 127.0.0.1, ::1, or localhost as the host.';
    if (!String(form.model ?? '').trim()) problems.model = 'The model name, e.g. llama3.1:8b.';
  } else if (!keyTyped && !keyKept) {
    problems.apiKey = addressChanged ? 'The address changed: enter the API key again.' : 'A hosted model needs your own API key.';
  }
  return problems;
}

// ------------------------------------------------------------ problems

const ASSIST_MESSAGES = {
  assist_not_configured: {
    title: 'The study helper is off',
    text: 'Set it up first: your own API key for a hosted model, or a local model. Uploads and the forms work without it.'
  },
  assist_provider_error: {
    title: 'The model could not be reached or gave no usable answer',
    text: 'Nothing was staged. Try again, or enter the update with the form or a file.'
  },
  assist_unsupported_input: {
    title: 'The helper cannot read this study',
    text: 'A local model reads text and tables only, and a table must be readable. Paste the text of the PDF, or the part with the results, instead.'
  },
  assist_busy: {
    title: 'The helper is still reading another study',
    text: 'It reads one study at a time. A study you cancelled keeps it busy until the model answers or 3 minutes pass. Try again in a moment.'
  },
  upload_too_large: {
    title: 'The study is too large',
    text: 'The helper reads files up to 10 MB or 200,000 characters of text. Hand it the part with the results.'
  },
  unsupported_file_type: {
    title: 'The helper cannot read this file type',
    text: 'Use a PDF (hosted model only), a text file (.txt, .md), a table (.csv, .tsv), or an Excel file (.xlsx).'
  },
  invalid_parameter: {
    title: 'The helper could not use this request',
    text: 'Check the fields and try again.'
  },
  backend_unavailable: {
    title: 'The backend is not running',
    text: 'The helper works through the Broad Modelcard backend on this computer. Start the app with npm run dev, then try again.'
  }
};

/**
 * A helper failure in plain words. The API's own detail is shown for a
 * provider error and for an invalid setting: the backend redacts the key and
 * never repeats the study or the value, so the detail is safe to show.
 */
export function describeAssistProblem(error) {
  const code = error?.code ?? 'unknown';
  const known = ASSIST_MESSAGES[code];
  if (!known) {
    return { title: 'Something went wrong', text: error?.message || 'The request failed.', detail: null, code };
  }
  const detail = code === 'assist_provider_error' || code === 'invalid_parameter' || code === 'assist_unsupported_input' ? error?.detail ?? null : null;
  return { ...known, detail, code };
}

// ------------------------------------------------------ staged entries

// Which staged records uploads came from the helper, per upload for this
// browser tab: only the upload id, never the study, the proposals, or a key.
const HELPER_ENTRY_KEY = 'bmc.admin.helperEntry.';

export function rememberHelperEntry(upload) {
  try {
    window.sessionStorage.setItem(HELPER_ENTRY_KEY + upload.upload_id, '1');
  } catch {
    // Without storage a helper entry reads like a form entry after a reload.
  }
}

/** Whether a staged records upload was staged from the helper's proposals in this tab. */
export function isHelperEntry(upload) {
  if (!upload || upload.origin !== 'records') return false;
  try {
    return window.sessionStorage.getItem(HELPER_ENTRY_KEY + upload.upload_id) === '1';
  } catch {
    return false;
  }
}

/** How a records upload was entered, in lower case: "entered with the form" or "proposed by the study helper". */
export function recordsEntryWords(upload) {
  return isHelperEntry(upload) ? 'proposed by the study helper' : 'entered with the form';
}
