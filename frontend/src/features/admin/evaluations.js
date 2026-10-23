// Evaluation results imports (contract v1.14, CONTRACT.md §32.2): the file,
// its proposed records, and staging what the reviewer ticks. React-free, so
// the tests can drive it with a stub client. Nothing here publishes: the
// staged study and metrics merge go through the usual check, review, and
// publish steps.

/** At most 1 MB, like a narrow model card (createEvaluationUpload). */
export const MAX_EVALUATION_BYTES = 1024 * 1024;
export const EVALUATION_FORMAT = 'bmc-evaluation-results/1';

/** A starting point in the format (synthetic, fictional), for the card chosen. */
export function evaluationExample({ modelVersion = 'Example-1.0', useCase = 'Example function', configurationId = 'cfg-example-1' } = {}) {
  return JSON.stringify(
    {
      format: EVALUATION_FORMAT,
      model_version: modelVersion,
      use_case: useCase,
      configuration_id: configurationId,
      benchmark: { name: 'Example vignette benchmark (fictional)', version: '1.0', description: 'Synthetic case vignettes (fictional).', url: 'https://benchmark.example/' },
      run_date: '2026-10-01',
      conducted_by: 'independent',
      setting: 'mixed',
      results: [
        { icd11_code: '5A11', measure: 'Top-3 diagnostic accuracy', value: 0.81, ci_low: 0.75, ci_high: 0.87, cases: 160, sites: 3 },
        { icd11_code: 'BA41', measure: 'Top-3 diagnostic accuracy', value: 0.7, cases: 48, age: 'Age 65+' }
      ]
    },
    null,
    2
  );
}

/**
 * An evaluation results file as text, or the reason it cannot be: a file over
 * 1 MB is refused whole (never cut short).
 *
 * @param {{ name: string, size: number, text: () => Promise<string> }} file
 * @returns {Promise<{ content: string, filename: string } | { problem: string }>}
 */
export async function readEvaluationFile(file) {
  const name = file?.name ?? 'The file';
  const tooLarge = `“${name}” is larger than 1 MB, the most an evaluation results file can hold. Split the run into several files.`;
  if ((file?.size ?? 0) > MAX_EVALUATION_BYTES) return { problem: tooLarge };
  let content;
  try {
    content = await file.text();
  } catch {
    return { problem: `“${name}” could not be read. Choose it again, or paste the JSON.` };
  }
  return content.length > MAX_EVALUATION_BYTES ? { problem: tooLarge } : { content, filename: name };
}

/** The proposed metrics rows in plain words, one per result, in file order. */
export function proposalRows(proposals) {
  const records = proposals?.metrics?.records ?? [];
  return records.map((record, index) => {
    const result = proposals.results?.[index] ?? {};
    const groups = [record.age, record.sex, record.ethnicity].filter((value) => value && !String(value).startsWith('All '));
    return {
      index,
      code: result.code ?? record.code,
      conceptId: record.code,
      measure: result.measure ?? '',
      value: record.perf,
      interval: record.ci_low != null && record.ci_high != null ? `${record.ci_low}–${record.ci_high}` : null,
      cases: record.n_samples,
      group: groups.length ? groups.join(', ') : 'All patients'
    };
  });
}

/** The proposed study in one line: its id, design, who ran it, and its size. */
export function studyLine(study) {
  if (!study) return '';
  const who = { developer: 'the developer', independent: 'an independent group', hospital: 'a hospital' }[study.conducted_by] ?? study.conducted_by;
  return `${study.study_id}: benchmark run by ${who}, ${study.patients} cases at ${study.sites} ${study.sites === 1 ? 'site' : 'sites'}, ${study.publication_date}. Risk of bias Unclear until a reviewer judges it.`;
}

/**
 * Stages what the reviewer ticked (createRecordsUpload): the study first, as a
 * studies merge, then the ticked metrics records as one merge for the card.
 * Without `replaceStaged`, a data set that already has an update waiting is
 * not overwritten: it comes back in `conflicts` ('study' or 'metrics') for the
 * page to ask about. Any other failure stops and comes back as `error`.
 *
 * @param {{ createRecordsUpload: Function }} client
 * @param {object} proposals getEvaluationProposals
 * @param {{ includeStudy?: boolean, recordIndexes?: number[], submissionId?: string, replaceStaged?: string[] }} options
 *   `replaceStaged` names the parts to send with replaceStaged
 * @returns {Promise<{ created: Array<{ part: string, upload: object }>, conflicts: string[], error: Error|null }>}
 */
export async function stageEvaluation(client, proposals, { includeStudy = true, recordIndexes = null, submissionId, replaceStaged = [] } = {}) {
  const created = [];
  const conflicts = [];
  const records = (proposals?.metrics?.records ?? []).filter((_, index) => !recordIndexes || recordIndexes.includes(index));
  const parts = [];
  if (includeStudy && proposals?.study) parts.push(['study', { kind: 'studies', records: [proposals.study] }]);
  if (records.length) {
    parts.push(['metrics', { kind: 'metrics', modelVersion: proposals.metrics.model_version, useCase: proposals.metrics.use_case, records }]);
  }
  for (const [part, request] of parts) {
    try {
      const upload = await client.createRecordsUpload({
        ...request,
        ...(submissionId ? { submissionId } : {}),
        ...(replaceStaged.includes(part) ? { replaceStaged: true } : {})
      });
      created.push({ part, upload });
    } catch (error) {
      if (error?.code === 'staged_upload_exists' && !replaceStaged.includes(part)) {
        conflicts.push(part);
      } else {
        return { created, conflicts, error };
      }
    }
  }
  return { created, conflicts, error: null };
}

/** "Ready, 2 notes" style words for the check of an evaluation results upload. */
export function evaluationState(upload) {
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
  if (upload.status === 'published') return { word: 'Records published', tone: 'done' };
  return { word: upload.status === 'discarded' ? 'Discarded' : 'Replaced', tone: 'quiet' };
}
