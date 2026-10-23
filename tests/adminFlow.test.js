// The maintainer's update flow through the app's data client against the real
// backend, on a private copy of the store: template → invalid upload →
// annotated file → fixed upload → change summary → staged read (preview) →
// publish → live data changed → roll back → live data restored.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { DataClientError } from '../frontend/src/api/dataClient.js';
import { schemaErrors } from './support/openapiSchema.js';
import { apiClient, copyStore, startTestBackend } from './support/backend.js';

const SCENARIO = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' };
const CONDITION = '5A11';

let store;
let backend;
let client;

before(async () => {
  store = copyStore();
  backend = await startTestBackend({ db: store.path });
  client = apiClient(backend.origin);
  // The copy starts from the developer's store, which may hold staged updates.
  for (const entry of await client.listDatasets()) {
    for (const uploadId of entry.staged_upload_ids ?? []) {
      await client.discardUpload({ uploadId });
    }
  }
});
after(async () => {
  await backend?.stop();
  store?.dispose();
});

const absolute = (url) => `${backend.origin}${url.replace(/^.*?(\/api\/v1)/, '$1')}`;

async function downloadText(url) {
  const response = await fetch(absolute(url));
  assert.equal(response.status, 200, url);
  return response.text();
}

/** Polls getUpload until the check has finished (the UI does the same). */
async function checked(upload) {
  let current = upload;
  const progress = [];
  while (current.status === 'checking') {
    progress.push(current.progress);
    await new Promise((resolve) => setTimeout(resolve, 50));
    current = await client.getUpload({ uploadId: upload.upload_id });
  }
  assert.ok(progress.every((value, index) => value >= 0 && value <= 1 && (index === 0 || value >= progress[index - 1])), 'progress only grows');
  return current;
}

const csvFile = (text, name = 'prevalence.csv') => new File([text], name, { type: 'text/csv' });
// A prevalence template line with its Commonness (the third column) replaced; the
// optional Action and source columns (contract v1.7) follow it.
const withTier = (line, tier) => line.replace(/^([^,]*,(?:"(?:[^"]|"")*"|[^,]*),)[^,]*/, `$1${tier}`);
const evidenceOf = async (options) =>
  (await client.getConceptMetrics({ ...SCENARIO, conceptId: CONDITION }, options)).metrics.evidence_grade;

test('the full update flow publishes and rolls back without touching history', async () => {
  const datasets = await client.listDatasets();
  assert.deepEqual(datasets.map((entry) => entry.kind).sort(), ['effects', 'local_metrics', 'metrics', 'model_cards', 'models', 'multimorbidity', 'population', 'prevalence', 'safety', 'studies']); // population: v1.10, studies, effects, local_metrics, and model_cards: v1.13
  for (const entry of datasets) {
    assert.deepEqual(schemaErrors('listDatasets', [entry]), []);
  }
  const startVersion = Math.max(...datasets.map((entry) => entry.version));
  const liveEvidence = await evidenceOf();

  // Template: the live prevalence data in template form.
  const filled = await downloadText(client.getTemplateUrl({ kind: 'prevalence', format: 'csv', filled: true }));
  const lines = filled.split(/\r?\n/);
  const target = lines.findIndex((line) => line.startsWith(`${CONDITION},`));
  assert.ok(target > 0);
  const empty = await downloadText(client.getTemplateUrl({ kind: 'prevalence', format: 'csv' }));
  assert.match(empty, /Never upload patient-level or real patient data/);

  // Invalid upload: an unknown commonness tier on the 5A11 row.
  const invalidLines = [...lines];
  invalidLines[target] = withTier(invalidLines[target], 'Sometimes');
  const invalid = await checked(await client.createUpload({ kind: 'prevalence', file: csvFile(invalidLines.join('\n')) }));
  assert.equal(invalid.status, 'invalid');
  const tierError = invalid.report.errors.find((group) => group.code === 'unknown_tier');
  assert.ok(tierError, 'the unknown tier is reported');
  assert.equal(tierError.count, 1);
  assert.equal(tierError.examples[0].row, target + 1, 'spreadsheet row number (first line is 1)');
  assert.ok(tierError.fix.length > 10, 'with a plain-language fix');
  await assert.rejects(client.getUploadChanges({ uploadId: invalid.upload_id }), { status: 409, code: 'upload_not_valid' });
  await assert.rejects(client.getMeta({}, { version: `staged:${invalid.upload_id}` }), { status: 409, code: 'upload_not_valid' });

  // The annotated file marks the problem in a Problems column.
  const annotated = await downloadText(client.getAnnotatedUploadUrl({ uploadId: invalid.upload_id, format: 'csv' }));
  assert.match(annotated, /Problems/);
  assert.match(annotated, /Sometimes/);

  // One staged upload per data set: a second upload must replace it.
  const fixedLines = [...lines];
  fixedLines[target] = withTier(fixedLines[target], 'Very rare');
  await assert.rejects(
    client.createUpload({ kind: 'prevalence', file: csvFile(fixedLines.join('\n')) }),
    (error) => error instanceof DataClientError && error.status === 409 && error.code === 'staged_upload_exists'
  );
  const valid = await checked(
    await client.createUpload({ kind: 'prevalence', file: csvFile(fixedLines.join('\n'), 'prevalence-fixed.csv'), replaceStaged: true })
  );
  assert.equal(valid.status, 'valid', JSON.stringify(valid.report?.errors));
  assert.equal((await client.getUpload({ uploadId: invalid.upload_id })).status, 'superseded');
  assert.equal(valid.previewed, false);

  // Change summary in the atlas's status words.
  const changes = await client.getUploadChanges({ uploadId: valid.upload_id });
  assert.deepEqual(schemaErrors('getUploadChanges', changes), []);
  assert.equal(changes.rows.changed, 1);
  assert.equal(changes.rows.removed, 0);
  assert.equal(changes.base_version, startVersion);
  assert.ok(changes.status_shifts.some((shift) => shift.view === 'evidence' && shift.sample_concept_ids.includes(CONDITION)));

  // Preview: a staged read changes nothing live and marks the upload previewed.
  const stagedEvidence = await evidenceOf({ version: `staged:${valid.upload_id}` });
  assert.notEqual(stagedEvidence, liveEvidence);
  assert.equal(await evidenceOf(), liveEvidence, 'live data is unchanged');
  assert.equal((await client.getUpload({ uploadId: valid.upload_id })).previewed, true);

  // Publish → new version; the live atlas now shows the new data.
  const published = await client.publishUpload({ uploadId: valid.upload_id, previewed: true });
  assert.deepEqual(schemaErrors('publishUpload', published), []);
  assert.equal(published.version_id, startVersion + 1);
  assert.equal(published.kind, 'prevalence');
  assert.equal(published.previewed, true);
  assert.equal(await evidenceOf(), stagedEvidence);
  assert.equal((await client.getMeta()).dataset_version, String(published.version_id));
  await assert.rejects(client.publishUpload({ uploadId: valid.upload_id }), { status: 409, code: 'upload_not_valid' });
  await assert.rejects(client.getMeta({}, { version: `staged:${valid.upload_id}` }), { status: 409, code: 'upload_not_valid' });

  // Roll back: restore the prevalence data of the version before the publish.
  const rolledBack = await client.rollbackVersion({ versionId: startVersion, kind: 'prevalence' });
  assert.equal(rolledBack.version_id, startVersion + 2);
  assert.equal(rolledBack.rollback_of, startVersion);
  assert.equal(await evidenceOf(), liveEvidence, 'the atlas shows the previous data again');

  const history = await client.listVersions({ kind: 'prevalence' });
  assert.deepEqual(schemaErrors('listVersions', history), []);
  assert.deepEqual(history.slice(0, 2).map((entry) => entry.version_id), [startVersion + 2, startVersion + 1], 'history is kept, newest first');
});

test('discarding a staged upload leaves live data alone', async () => {
  const filled = await downloadText(client.getTemplateUrl({ kind: 'prevalence', format: 'csv', filled: true }));
  const upload = await checked(await client.createUpload({ kind: 'prevalence', file: csvFile(filled) }));
  assert.equal(upload.status, 'valid');
  const changes = await client.getUploadChanges({ uploadId: upload.upload_id });
  assert.deepEqual([changes.rows.added, changes.rows.changed, changes.rows.removed], [0, 0, 0], 'an unchanged filled template has no changes');
  assert.equal(await client.discardUpload({ uploadId: upload.upload_id }), null);
  assert.equal((await client.getUpload({ uploadId: upload.upload_id })).status, 'discarded');
  await assert.rejects(client.discardUpload({ uploadId: upload.upload_id }), { status: 409, code: 'upload_not_staged' });
});

test('empty and wrong-type files are rejected plainly', async () => {
  await assert.rejects(
    client.createUpload({ kind: 'prevalence', file: new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }) }),
    { status: 415, code: 'unsupported_file_type' }
  );
  const empty = await checked(await client.createUpload({ kind: 'prevalence', file: csvFile(''), replaceStaged: true }));
  assert.equal(empty.status, 'invalid');
  assert.ok(empty.report.errors.some((group) => group.code === 'empty_file'));
  const wrong = await checked(
    await client.createUpload({ kind: 'prevalence', file: csvFile('Model version,Display name\nX,Y\n', 'models.csv'), replaceStaged: true })
  );
  assert.ok(wrong.report.errors.some((group) => group.code === 'wrong_template' || group.code === 'missing_column'));
  await client.discardUpload({ uploadId: wrong.upload_id });
});

test('metrics uploads need a model and use case', async () => {
  await assert.rejects(
    client.createUpload({ kind: 'metrics', file: csvFile('x\n', 'metrics.csv') }),
    { status: 422, code: 'invalid_parameter' }
  );
});

test('a publish while another publish runs is refused with 409 publish_in_progress', async () => {
  // A prevalence publish computes its change summary (every model and use
  // case) inside the publish lock, so publishes sent at the same time meet it.
  const filled = await downloadText(client.getTemplateUrl({ kind: 'prevalence', format: 'csv', filled: true }));
  const lines = filled.split(/\r?\n/);
  const target = lines.findIndex((line) => line.startsWith(`${CONDITION},`));
  lines[target] = withTier(lines[target], 'Rare');
  const upload = await checked(await client.createUpload({ kind: 'prevalence', file: csvFile(lines.join('\n')), replaceStaged: true }));
  assert.equal(upload.status, 'valid');
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => client.publishUpload({ uploadId: upload.upload_id })));
  const codes = results.map((result) => (result.status === 'fulfilled' ? 'published' : result.reason.code));
  assert.equal(codes.filter((code) => code === 'published').length, 1, codes.join(', '));
  assert.ok(codes.every((code) => ['published', 'publish_in_progress', 'upload_not_valid'].includes(code)), codes.join(', '));
  assert.ok(codes.includes('publish_in_progress'), codes.join(', '));
});

// The one-record form's path (CONTRACT.md §11.4, §11.5, §18):
// the form state → records (frontend/src/features/admin/records.js) →
// createRecordsUpload → check → change summary of the touched incident only →
// publish with a change note → History. Then a Remove row deletes it, and an
// update without the marker leaves every other incident alone.
test('one incident entered with the form is checked, published with a note, and removed only with the marker', async () => {
  const { emptyIncident, incidentRecord } = await import('../frontend/src/features/admin/records.js');
  const registry = await client.listModels({}, { version: 'live' });
  const entry = registry.models[0];
  const card = { model: entry.model_version, useCase: entry.default_use_case ?? entry.use_cases[0].use_case };
  const before = (await client.listDatasets()).find((item) => item.kind === 'safety');
  const form = {
    ...emptyIncident({ card }),
    codes: [{ code: CONDITION, name: 'Type 2 diabetes mellitus' }],
    incidentType: 'subgroup_bias',
    harm: 'none',
    sourceReference: 'Incident report IR-TEST-1 (fictional)',
    summary: 'Synthetic example: test incident from the form.'
  };

  const staged = await checked(await client.createRecordsUpload({ kind: 'safety', records: [incidentRecord(form)], replaceStaged: true }));
  assert.equal(staged.status, 'valid', JSON.stringify(staged.report?.errors));
  assert.equal(staged.origin, 'records');
  assert.equal(staged.mode, 'merge');
  const changes = await client.getUploadChanges({ uploadId: staged.upload_id });
  assert.deepEqual([changes.rows.added, changes.rows.changed, changes.rows.removed], [1, 0, 0], 'only the entered incident is touched');
  assert.equal(changes.rows.samples.added[0].key, form.incidentId);
  assert.deepEqual(changes.status_shifts, [], 'safety never changes a status');

  const note = 'Adds the open subgroup incident from IR-TEST-1.';
  const published = await client.publishUpload({ uploadId: staged.upload_id, previewed: false, note });
  assert.equal(published.note, note);
  assert.equal((await client.listVersions({ kind: 'safety' }))[0].note, note);
  const metrics = await client.getConceptMetrics({ ...card, conceptId: CONDITION });
  const incident = metrics.incidents.find((item) => item.incident_id === form.incidentId);
  assert.equal(incident.severity, 'caution', 'open without harm');
  const afterAdd = (await client.listDatasets()).find((item) => item.kind === 'safety');
  assert.equal(afterAdd.counts.incidents, (before?.counts?.incidents ?? 0) + 1, 'every other incident stays');

  // Changing the incident (Mitigated) touches it alone; removing it needs Action = Remove.
  const mitigated = await checked(
    await client.createRecordsUpload({ kind: 'safety', records: [incidentRecord({ ...form, status: 'mitigated' })] })
  );
  const mitigatedChanges = await client.getUploadChanges({ uploadId: mitigated.upload_id });
  assert.deepEqual([mitigatedChanges.rows.added, mitigatedChanges.rows.changed, mitigatedChanges.rows.removed], [0, 1, 0]);
  await client.discardUpload({ uploadId: mitigated.upload_id });
  const removal = await checked(
    await client.createRecordsUpload({ kind: 'safety', records: [{ ...incidentRecord(form), action: 'Remove' }] })
  );
  const removalChanges = await client.getUploadChanges({ uploadId: removal.upload_id });
  assert.deepEqual([removalChanges.rows.added, removalChanges.rows.changed, removalChanges.rows.removed], [0, 0, 1]);
  await client.discardUpload({ uploadId: removal.upload_id });

  // A form entry with a problem names the field, for the form to show.
  const invalid = await checked(
    await client.createRecordsUpload({ kind: 'safety', records: [incidentRecord({ ...form, incidentId: 'SI-TEST-2', model: 'No-Such-System' })] })
  );
  assert.equal(invalid.status, 'invalid');
  const problem = invalid.report.errors.find((group) => group.code === 'unknown_configuration');
  assert.ok(problem, JSON.stringify(invalid.report.errors));
  assert.equal(problem.examples[0].record, 0);
  await client.discardUpload({ uploadId: invalid.upload_id });
});

test('one metrics row entered with the form changes only that row', async () => {
  const { emptyMetricRow, metricRecord } = await import('../frontend/src/features/admin/records.js');
  const form = {
    ...emptyMetricRow(),
    condition: { code: CONDITION, name: 'Type 2 diabetes mellitus' },
    source: 'Form test study (fictional)',
    study: 'FTS-2026-01'
  };
  form.values = { ...form.values, perf: '0.83', ci_low: '0.80', ci_high: '0.86', n_samples: '900', n_studies: '2', validation_type: 'benchmark' };
  const staged = await checked(
    await client.createRecordsUpload({ kind: 'metrics', modelVersion: SCENARIO.model, useCase: SCENARIO.useCase, records: [metricRecord(form)], replaceStaged: true })
  );
  assert.equal(staged.status, 'valid', JSON.stringify(staged.report?.errors));
  const changes = await client.getUploadChanges({ uploadId: staged.upload_id });
  assert.equal(changes.rows.added + changes.rows.changed, 1, 'one row, the one entered');
  assert.equal(changes.rows.removed, 0, 'a merge removes nothing without the marker');
  assert.equal((await client.getConceptMetrics({ ...SCENARIO, conceptId: CONDITION }, { version: `staged:${staged.upload_id}` })).metrics.perf, 0.83);
  await client.discardUpload({ uploadId: staged.upload_id });
});
