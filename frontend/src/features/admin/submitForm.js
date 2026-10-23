// The developer's submission form (Developer submission; contract v1.13,
// CONTRACT.md §26): its checks, its parts, and sending them. React-free, so
// the tests can drive it with a stub client.
//
// A submission is opened once and its parts join it one by one. Should a part
// fail to send, the submission stays open with the parts sent so far; the next
// Submit sends only what is missing or changed into the same submission
// (a changed part replaces its earlier one there), instead of opening another.

import { AI_TYPE_LABELS, FUNCTION_CATEGORY_LABELS, KIND_LABELS } from '../../shared/aiSystem.js';
import { emptyEntryFields, entryFieldProblems, entryRecordCells } from './registryEntryFields.js';

const MODEL_VERSION = /^[A-Za-z0-9._ -]{1,64}$/;
const CARD_NAME_RESERVED = /[|,]/;

/** The parts in the order they are sent: the AI system entry first, so the others are checked against it. */
// Evaluation results (contract v1.14, §32.2) come last: they name the card the entry adds.
export const SUBMISSION_PARTS = Object.freeze(['models', 'model_cards', 'studies', 'metrics', 'evaluation_results']);

export function emptySubmitForm(name = '') {
  return {
    developerName: name ?? '',
    system: 'new',
    existing: '',
    existingFunction: '',
    modelVersion: '',
    displayName: '',
    useCase: '',
    kind: 'model',
    aiType: '',
    organisation: '',
    description: '',
    category: '',
    purpose: '',
    // Contract v1.14 registry fields of a new AI system (§28): Replaces, configuration, measure, data protection.
    entry: emptyEntryFields(),
    card: { format: 'json', content: '', filename: null },
    studiesFile: null,
    resultsFile: null,
    evaluation: { content: '', filename: null },
    note: ''
  };
}

/** The AI system and function the submission is about. */
export function submissionTarget(form, systems = []) {
  if (form.system === 'new') {
    return { modelVersion: form.modelVersion.trim(), useCase: form.useCase.trim() };
  }
  const chosen = (systems ?? []).find((entry) => entry.model_version === form.existing) ?? null;
  return {
    modelVersion: form.existing,
    useCase: form.existingFunction || chosen?.default_use_case || chosen?.use_cases?.[0]?.use_case || ''
  };
}

/** The parts this form would send, in sending order. */
export function submissionParts(form) {
  return SUBMISSION_PARTS.filter((part) => {
    if (part === 'models') return form.system === 'new';
    if (part === 'model_cards') return Boolean(form.card.content.trim());
    if (part === 'studies') return Boolean(form.studiesFile);
    if (part === 'evaluation_results') return Boolean(form.evaluation?.content.trim());
    return Boolean(form.resultsFile);
  });
}

/**
 * What the form still needs, as { field: message }, every one at once; `parts`
 * says that nothing would be sent.
 */
export function submitProblems(form) {
  const problems = {};
  if (!form.developerName.trim()) problems.developerName = 'Give your name or your organisation’s.';
  if (form.system === 'new') {
    if (!MODEL_VERSION.test(form.modelVersion.trim())) problems.modelVersion = 'Letters, digits, ".", "_", "-", at most 64.';
    if (!form.displayName.trim()) problems.displayName = 'Give the name readers see.';
    if (!form.useCase.trim()) problems.useCase = 'Name the function, e.g. Sepsis early warning.';
    // Card ids join the AI system and the function with "|", and comparisons list cards with "," (contract §11.1).
    else if (CARD_NAME_RESERVED.test(form.useCase)) problems.useCase = 'Use a name without | or ,.';
    Object.assign(problems, entryFieldProblems(form.entry, { modelVersion: form.modelVersion }));
  } else if (!form.existing) {
    problems.existing = 'Choose the AI system.';
  }
  if (!submissionParts(form).length) problems.parts = 'Add at least one part: a narrow model card, studies, performance metrics, or evaluation results.';
  return problems;
}

/** The line under Submit when something is missing: how many fields, whether a part is missing, and that nothing was sent. */
export function problemSummary(problems) {
  const fields = Object.keys(problems).filter((key) => key !== 'parts').length;
  return [
    fields ? (fields === 1 ? 'One field still needs an answer.' : `${fields} fields still need an answer.`) : null,
    problems.parts ?? null,
    'Nothing was sent.'
  ]
    .filter(Boolean)
    .join(' ');
}

const fileIdentity =(file) => (file ? `${file.name}|${file.size}|${file.lastModified ?? ''}` : '');

/** What a part holds, so a retry can tell a part already sent from one changed since. */
export function partIdentity(form, part, systems = []) {
  const { modelVersion, useCase } = submissionTarget(form, systems);
  if (part === 'models') {
    return JSON.stringify([modelVersion, useCase, form.displayName.trim(), form.kind, form.aiType, form.organisation.trim(), form.description.trim(), form.category, form.purpose.trim(), entryRecordCells(form.entry)]);
  }
  if (part === 'model_cards') return JSON.stringify([modelVersion, form.card.format, form.card.content]);
  if (part === 'studies') return fileIdentity(form.studiesFile);
  if (part === 'evaluation_results') return JSON.stringify([form.evaluation.filename, form.evaluation.content]);
  return JSON.stringify([modelVersion, useCase, form.system, fileIdentity(form.resultsFile)]);
}

/** The AI system entry of a new AI system, as one registry record (template column keys). */
export function registryRecord(form) {
  const { modelVersion, useCase } = submissionTarget(form);
  return {
    model_version: modelVersion,
    display_name: form.displayName.trim(),
    status: 'EXPERIMENTAL',
    use_case: useCase,
    default_use_case: true,
    kind: KIND_LABELS[form.kind],
    ai_type: form.aiType ? AI_TYPE_LABELS[form.aiType] : null,
    developer: form.organisation.trim() || null,
    description: form.description.trim() || null,
    function_category: form.category ? FUNCTION_CATEGORY_LABELS[form.category] : null,
    declared_intended_purpose: form.purpose.trim() || null,
    ...entryRecordCells(form.entry)
  };
}

function sendPart(client, form, part, { submissionId, systems, replaceStaged }) {
  const { modelVersion, useCase } = submissionTarget(form, systems);
  const replace = replaceStaged ? { replaceStaged: true } : {};
  if (part === 'models') {
    return client.createRecordsUpload({ kind: 'models', submissionId, records: [registryRecord(form)], ...replace });
  }
  if (part === 'model_cards') {
    return client.createModelCardUpload({ modelVersion, format: form.card.format, content: form.card.content, filename: form.card.filename ?? undefined, submissionId, ...replace });
  }
  if (part === 'studies') {
    return client.createUpload({ kind: 'studies', file: form.studiesFile, mode: 'merge', submissionId, ...replace });
  }
  if (part === 'evaluation_results') {
    return client.createEvaluationUpload({ content: form.evaluation.content, filename: form.evaluation.filename ?? undefined, submissionId, ...replace });
  }
  return client.createUpload({ kind: 'metrics', file: form.resultsFile, modelVersion, useCase, mode: form.system === 'new' ? 'replace' : 'merge', submissionId, ...replace });
}

/**
 * Sends the form's parts. `opened` is the submission a failed attempt left
 * open ({ submissionId, modelVersion, sent: { part: identity } }); it is
 * reused when it is about the same AI system, and only parts missing from it,
 * or changed since they were sent, are sent again.
 *
 * @returns {Promise<{ opened: object|null, error: Error|null, failedPart: string|null }>}
 *   `opened` is the submission as it now stands (null when it could not be opened).
 */
export async function runSubmission(client, form, { opened = null, systems = [] } = {}) {
  const { modelVersion } = submissionTarget(form, systems);
  let state = opened && opened.modelVersion === modelVersion ? { ...opened, sent: { ...opened.sent } } : null;
  if (!state) {
    try {
      const created = await client.createSubmission({ developerName: form.developerName.trim(), modelVersion, note: form.note.trim() || undefined });
      state = { submissionId: created.submission_id, modelVersion, sent: {} };
    } catch (error) {
      return { opened: null, error, failedPart: null };
    }
  }
  for (const part of submissionParts(form)) {
    const identity = partIdentity(form, part, systems);
    if (state.sent[part] === identity) continue;
    try {
      // A part sent before with other content is replaced within the submission.
      await sendPart(client, form, part, { submissionId: state.submissionId, systems, replaceStaged: part in state.sent });
      state.sent[part] = identity;
    } catch (error) {
      return { opened: state, error, failedPart: part };
    }
  }
  return { opened: state, error: null, failedPart: null };
}
