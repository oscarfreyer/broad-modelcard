// Developer submissions in plain words (contract v1.13, CONTRACT.md §26):
// what each part is, where its check stands, and the JSON example of a
// narrow model card. React-free, so the tests can read it.

export const PART_WORDS = Object.freeze({
  models: 'AI system entry',
  metrics: 'Performance metrics',
  studies: 'Studies',
  model_cards: 'Narrow model card',
  safety: 'Safety incidents',
  multimorbidity: 'Multimorbidity',
  prevalence: 'Prevalence',
  population: 'Local population',
  local_metrics: 'Local results',
  evaluation_results: 'Evaluation results'
});

/** The AI system of a submission by the name readers see: the live registry's display name, else the given name (a new AI system's staged entry), else its model version. */
export function systemName(modelVersion, models, fallback = null) {
  const entry = (models ?? []).find((model) => model.model_version === modelVersion);
  return entry?.display_name || fallback || modelVersion || '';
}

export const SUBMISSION_STATUS_WORDS = Object.freeze({
  submitted: 'Waiting for review',
  returned: 'Returned',
  accepted: 'Accepted'
});

/** "Checking" / "Needs a fix: 2 problems" / "Ready" / "Published" for one part. */
export function partState(upload) {
  if (!upload) return { word: '', tone: 'quiet' };
  if (upload.status === 'checking') return { word: 'Checking', tone: 'quiet' };
  if (upload.status === 'invalid') {
    const count = (upload.report?.errors ?? []).reduce((sum, group) => sum + (group.count ?? 0), 0);
    return { word: `Needs a fix${count ? `: ${count} ${count === 1 ? 'problem' : 'problems'}` : ''}`, tone: 'fix' };
  }
  if (upload.status === 'valid') {
    const notes = upload.report?.notes?.length ?? 0;
    return { word: notes ? `Ready, ${notes} ${notes === 1 ? 'note' : 'notes'}` : 'Ready', tone: 'ready' };
  }
  // Evaluation results (contract v1.14, §32.2) publish nothing themselves: their records were published.
  if (upload.status === 'published') return { word: upload.kind === 'evaluation_results' ? 'Records published' : 'Published', tone: 'done' };
  return { word: upload.status === 'discarded' ? 'Discarded' : 'Replaced', tone: 'quiet' };
}

/** Whether every staged part passed its check (a custodian can accept). */
export function submissionReady(submission) {
  const staged = (submission?.uploads ?? []).filter((upload) => ['checking', 'invalid', 'valid'].includes(upload.status));
  return staged.length > 0 && staged.every((upload) => upload.status === 'valid');
}

export function isChecking(submission) {
  return (submission?.uploads ?? []).some((upload) => upload.status === 'checking');
}

/** The first problem of a part, in its own words, or null. */
export function firstProblem(upload) {
  const group = upload?.report?.errors?.[0];
  if (!group) return null;
  const example = group.examples?.[0];
  return `${group.message}${example?.problem ? ` ${example.problem}` : ''} ${group.fix}`.trim();
}

/** The narrow model card JSON the Data Library offers as a starting point (synthetic, fictional). */
export function modelCardExample(modelVersion = 'Example-1.0') {
  return JSON.stringify(
    {
      model_version: modelVersion,
      name: 'Example model (fictional)',
      version: '1.0',
      license: 'Proprietary (fictional)',
      date: '2026-10-01',
      intended_use: 'What the AI system is for, and for whom.',
      limitations: 'Where it should not be used.',
      training_data: 'What it was trained on (synthetic in this demonstration).',
      'model-index': [
        {
          name: 'Example model 1.0',
          results: [
            {
              task: { type: 'classification', name: 'Triage' },
              dataset: { name: 'Example validation set (fictional)' },
              metrics: [{ type: 'auroc', name: 'AUROC', value: 0.84, icd11_codes: ['1G40'] }]
            }
          ]
        }
      ]
    },
    null,
    2
  );
}

/** At most 1 MB per narrow model card (createModelCardUpload, CONTRACT.md §26). */
export const MAX_CARD_BYTES = 1024 * 1024;

/**
 * A narrow model card file as the card form's value, or the reason it cannot
 * be: a file over 1 MB is refused whole (never cut short), and one that cannot
 * be read says so.
 *
 * @param {{ name: string, size: number, text: () => Promise<string> }} file
 * @returns {Promise<{ card: { format: 'json'|'markdown', content: string, filename: string } } | { problem: string }>}
 */
export async function readModelCardFile(file) {
  const name = file?.name ?? 'The file';
  if ((file?.size ?? 0) > MAX_CARD_BYTES) {
    return { problem: `“${name}” is larger than 1 MB, the most a narrow model card can hold. Shorten it, or link long sections instead.` };
  }
  let content;
  try {
    content = await file.text();
  } catch {
    return { problem: `“${name}” could not be read. Choose it again, or paste the card as text.` };
  }
  if (content.length > MAX_CARD_BYTES) {
    return { problem: `“${name}” is larger than 1 MB, the most a narrow model card can hold. Shorten it, or link long sections instead.` };
  }
  return { card: { format: /\.(md|markdown)$/i.test(name) ? 'markdown' : 'json', content, filename: name } };
}

/**
 * Stages a narrow model card's proposed performance metrics, one records
 * upload (a merge) per card (getModelCardProposals batches). Without
 * `replaceStaged`, a card whose metrics already have an update waiting is
 * not overwritten: it comes back in `conflicts`, for the page to ask about
 * and send again with `replaceStaged`. Any other failure stops and comes back
 * as `error`, with what was staged before it.
 *
 * @param {{ createRecordsUpload: Function }} client
 * @param {{ model_version: string, use_case: string, records: object[] }[]} batches
 * @param {{ replaceStaged?: boolean, submissionId?: string }} [options]
 * @returns {Promise<{ created: object[], conflicts: object[], error: Error|null }>}
 */
export async function stageProposalBatches(client, batches, { replaceStaged = false, submissionId } = {}) {
  const created = [];
  const conflicts = [];
  for (const batch of batches ?? []) {
    try {
      created.push(
        await client.createRecordsUpload({
          kind: 'metrics',
          modelVersion: batch.model_version,
          useCase: batch.use_case,
          records: batch.records,
          ...(submissionId ? { submissionId } : {}),
          ...(replaceStaged ? { replaceStaged: true } : {})
        })
      );
    } catch (error) {
      if (!replaceStaged && error?.code === 'staged_upload_exists') {
        conflicts.push(batch);
      } else {
        return { created, conflicts, error };
      }
    }
  }
  return { created, conflicts, error: null };
}
