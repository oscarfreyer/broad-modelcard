// Editing stored incidents
// from a list, restoring every later change by default with the no-change
// refusal said before anything is sent, and Performance that needs its
// evidence in the one-record forms. Components render through Vite's SSR
// loader, as in adminRecords.test.js.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { describeProblem } from '../frontend/src/features/admin/problems.js';
import {
  EVIDENCE_NEEDED,
  changedIncidentId,
  emptyMetricRow,
  evidenceProblems,
  incidentProblems,
  incidentRecord,
  metricRecord,
  metricRowProblems,
  storedIncidentForm
} from '../frontend/src/features/admin/records.js';
import { EVERYTHING, kindSource, restorePlan, runRestore } from '../frontend/src/features/admin/restore.js';

let vite;
const load = (path) => vite.ssrLoadModule(path);
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

before(async () => {
  vite = await createServer({
    configFile: false,
    root: new URL('../frontend/', import.meta.url).pathname,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    oxc: { jsx: { runtime: 'automatic' } },
    optimizeDeps: { noDiscovery: true, include: [] }
  });
});
after(async () => {
  await vite?.close();
});

/** Renders inside a DataClientProvider (the code picker reads the client). */
async function renderWithClient(element) {
  const { DataClientProvider } = await load('/src/api/DataClientProvider.jsx');
  return renderToStaticMarkup(h(DataClientProvider, { client: {} }, element));
}

// ------------------------------------------------------------ L4 incidents

const CLOSED = Object.freeze({
  incident_id: 'SI-20260804-7KQ2',
  model_version: 'SkinAI-1.0',
  use_case: 'Lesion Triage',
  codes: ['2C30', 'EK90.0'],
  condition_ids: ['c1', 'c2'],
  chapter_id: null,
  lens: { age: 'Age 65+', sex: 'All sexes', ethnicity: 'All ethnicities' },
  incident_type: 'subgroup_bias',
  harm: 'possible',
  status: 'closed',
  severity: null,
  source_type: 'study',
  source_reference: 'Northbridge audit (fictional)',
  study_id: 'NBR-2026-04',
  reported_date: '2026-08-04',
  updated_date: '2026-09-01',
  summary: 'Synthetic example: lower sensitivity on darker skin in a reviewed sample.',
  code_names: ['Melanoma of skin', null],
  chapter_no: null
});

const CHAPTER = Object.freeze({
  ...CLOSED,
  incident_id: 'SI-CH-1',
  codes: [],
  condition_ids: [],
  chapter_id: 'chapter-02',
  chapter_no: '02',
  code_names: [],
  lens: { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' },
  status: 'open',
  severity: 'serious',
  source_type: 'incident_report',
  study_id: null,
  updated_date: null
});

test('Edit fills the incident form with every stored value and keeps the ID', () => {
  const form = storedIncidentForm(CLOSED);
  assert.equal(form.incidentId, 'SI-20260804-7KQ2');
  assert.deepEqual(form.editing, { id: 'SI-20260804-7KQ2', lastDate: '2026-09-01' });
  assert.deepEqual(form.codes, [
    { code: '2C30', name: 'Melanoma of skin' },
    { code: 'EK90.0', name: 'EK90.0' }
  ]);
  assert.equal(form.scope, 'codes');
  assert.deepEqual(form.lens, CLOSED.lens);
  assert.deepEqual(
    [form.model, form.useCase, form.incidentType, form.harm, form.status, form.sourceType, form.sourceReference, form.studyId, form.reportedDate, form.updatedDate, form.summary],
    ['SkinAI-1.0', 'Lesion Triage', 'subgroup_bias', 'possible', 'closed', 'study', 'Northbridge audit (fictional)', 'NBR-2026-04', '2026-08-04', '2026-09-01', CLOSED.summary]
  );
  assert.deepEqual(incidentProblems(form), {}, 'a stored incident is a complete form');
  assert.equal(changedIncidentId(form), null, 'editing is not the typed-ID case');

  // Reopening a closed incident and sending it gives the stored record with the new status: publishing replaces it.
  const record = incidentRecord({ ...form, status: 'open', updatedDate: '2026-10-13' });
  assert.deepEqual(record, {
    incident_id: 'SI-20260804-7KQ2',
    model_version: 'SkinAI-1.0',
    use_case: 'Lesion Triage',
    codes: '2C30; EK90.0',
    age: 'Age 65+',
    sex: null,
    ethnicity: null,
    incident_type: 'subgroup_bias',
    harm: 'possible',
    status: 'open',
    source_type: 'study',
    source_reference: 'Northbridge audit (fictional)',
    study_id: 'NBR-2026-04',
    reported_date: '2026-08-04',
    updated_date: '2026-10-13',
    summary: CLOSED.summary,
    scope: 'Public'
  });
  assert.equal('editing' in record, false, 'what the form edits is never sent');

  // A whole-chapter incident comes back as a chapter.
  const chapter = storedIncidentForm(CHAPTER);
  assert.deepEqual([chapter.scope, chapter.chapterNo, chapter.codes.length, chapter.updatedDate, chapter.studyId], ['chapter', '02', 0, '', '']);
  assert.equal(incidentRecord(chapter).codes, 'chapter 02');
});

test('an edit dated before the stored incident is named before anything is sent', () => {
  const form = storedIncidentForm(CLOSED);
  assert.match(incidentProblems({ ...form, updatedDate: '2026-08-20' }).updatedDate, /on or after 2026-09-01/);
  assert.equal(incidentProblems({ ...form, updatedDate: '2026-09-01' }).updatedDate, undefined, 'the same date replaces');
  assert.match(incidentProblems({ ...form, updatedDate: '' }).updatedDate, /on or after 2026-09-01/, 'without an updated date the reported date counts');
  assert.equal(incidentProblems({ ...storedIncidentForm(CHAPTER), updatedDate: '' }).updatedDate, undefined, 'a stored incident without an updated date');
});

test('the incident list shows each stored incident with its mark, and Edit', async () => {
  const { IncidentListView, incidentRowWords, dayWords } = await load('/src/features/admin/IncidentList.jsx');
  assert.equal(dayWords('2026-08-04'), '4 Aug 2026');
  const closed = incidentRowWords(CLOSED);
  assert.equal(closed.mark, 'Closed');
  assert.equal(closed.title, 'Subgroup bias, harm possible');
  assert.equal(closed.where, 'Melanoma of skin, EK90.0, Age 65+');
  assert.equal(closed.dates, 'Reported 4 Aug 2026, updated 1 Sept 2026');
  const chapter = incidentRowWords(CHAPTER, [{ chapter_no: '02', pt: '02 Neoplasms', level: 0 }]);
  assert.equal(chapter.mark, 'Serious, open');
  assert.equal(chapter.where, 'Chapter 02, Neoplasms');
  assert.equal(incidentRowWords({ ...CLOSED, summary: 'x'.repeat(300) }).snippet.length, 140);

  const render = (props) => renderToStaticMarkup(h(IncidentListView, { cardName: 'SkinAI-1.0, Lesion Triage', onEdit() {}, ...props }));
  const html = render({ incidents: [CHAPTER, CLOSED] });
  assert.match(html, /Stored incidents for SkinAI-1\.0, Lesion Triage/);
  assert.match(html, /aria-label="Edit incident SI-20260804-7KQ2"/);
  assert.match(html, /aria-label="Edit incident SI-CH-1"/);
  assert.match(text(html), /Closed .*Subgroup bias, harm possible/);
  assert.match(html, /data-status="serious"/, 'an open serious incident carries the Serious mark');
  assert.match(html, /data-status="no_incidents"/, 'a closed incident the quiet mark');
  assert.ok(html.indexOf('SI-CH-1') < html.indexOf('SI-20260804-7KQ2'), 'in the order served (newest first)');

  const editing = render({ incidents: [CHAPTER, CLOSED], editingId: 'SI-20260804-7KQ2', hasWaitingUpdate: true });
  assert.match(editing, /incident-row is-editing/);
  assert.doesNotMatch(editing, /aria-label="Edit incident SI-20260804-7KQ2"/, 'the edited row says Editing instead');
  assert.match(editing, /An update is waiting for this data set: the list shows the live incidents/);

  assert.match(render({ incidents: [] }), /No incidents stored for this card\./);
  assert.match(render({ incidents: null }), /aria-busy="true"/);
  assert.match(render({ cardName: null, incidents: null }), /Choose the AI system and function/);
  const many = Array.from({ length: 9 }, (_, index) => ({ ...CLOSED, incident_id: `SI-${index}` }));
  const long = render({ incidents: many, editingId: 'SI-8' });
  assert.match(long, /Show all 9 incidents/);
  assert.match(long, /SI-8/, 'the edited incident stays in view beyond the first rows');
  assert.doesNotMatch(long, /SI-7/);
});

test('the incident form says which stored incident it edits and keeps its ID', async () => {
  const { default: IncidentForm } = await load('/src/features/admin/IncidentForm.jsx');
  const models = [{ model_version: 'SkinAI-1.0', display_name: 'SkinAI-1.0', default_use_case: 'Lesion Triage', use_cases: [{ use_case: 'Lesion Triage' }] }];
  const html = await renderWithClient(h(IncidentForm, { form: storedIncidentForm(CLOSED), onChange() {}, models, meta: null, onSubmit() {}, isBusy: false, onReset() {} }));
  assert.match(html, /Editing incident SI-20260804-7KQ2/);
  assert.match(html, /Publishing replaces the stored incident/);
  assert.match(html, /Report a new incident instead/);
  assert.match(html, /<input[^>]*readonly=""[^>]*value="SI-20260804-7KQ2"/, 'the ID stays the stored one');
  assert.match(html, /Check this change/);
  assert.match(html, /not before 2026-09-01/);
  assert.match(html, /aria-label="Closed" checked=""/, 'the stored status is chosen');
  assert.doesNotMatch(html, /is stored, publishing replaces it/);
});

// ------------------------------------------------------------ L3 restore

// A demo store: version 8 changed the registry, 9 added an
// incident, then 10 and 11 restored the registry to version 8.
const HISTORY = [
  { version_id: 11, kind: 'models', rollback_of: 8, summary: 'Rolled back AI systems & functions to version 8.', note: 'wrong incidence' },
  { version_id: 10, kind: 'models', rollback_of: 8, summary: 'Rolled back AI systems & functions to version 8.', note: 'Wrong naming' },
  { version_id: 9, kind: 'safety', rollback_of: null, summary: 'Safety incidents: 1 incident added.', note: null },
  { version_id: 8, kind: 'models', rollback_of: null, summary: 'AI systems & functions: 1 function added.', note: null },
  { version_id: 7, kind: 'safety', rollback_of: null, summary: 'Safety incidents: 3 incidents added.', note: null },
  { version_id: 6, kind: 'metrics', rollback_of: null, summary: 'Performance metrics: 12 rows changed.', note: null },
  { version_id: 1, kind: null, rollback_of: null, summary: 'Initial import.', note: null }
];
const ids = (list) => list.map((version) => version.version_id);

test('a data set restored to version n holds the data of version n again', () => {
  assert.equal(kindSource(HISTORY, 11, 'models'), 8, 'versions 10 and 11 brought version 8 back');
  assert.equal(kindSource(HISTORY, 8, 'models'), 8);
  assert.equal(kindSource(HISTORY, 11, 'safety'), 9);
  assert.equal(kindSource(HISTORY, 8, 'safety'), 7);
  assert.equal(kindSource(HISTORY, 11, 'prevalence'), 1, 'never changed after the initial import');
  // A restore of every data set (kind null) brings each back.
  const all = [{ version_id: 12, kind: null, rollback_of: 6 }, ...HISTORY];
  assert.equal(kindSource(all, 12, 'safety'), kindSource(all, 6, 'safety'));
});

test('restoring version 8 undoes the incident by default; the registry alone would change nothing', () => {
  const everything = restorePlan(HISTORY, 8, EVERYTHING);
  assert.deepEqual(everything.kinds, ['safety']);
  assert.deepEqual(everything.same, ['models']);
  assert.deepEqual(ids(everything.undone), [9]);

  const models = restorePlan(HISTORY, 8, 'models');
  assert.deepEqual(models.kinds, [], 'a maintainer’s click: nothing would change');
  assert.deepEqual(models.same, ['models']);
  assert.deepEqual(models.undone, []);

  assert.deepEqual(restorePlan(HISTORY, 8, 'prevalence'), { kinds: [], same: [], undone: [] });
  const six = restorePlan(HISTORY, 6, EVERYTHING);
  assert.deepEqual(six.kinds, ['models', 'safety'], 'AI systems & functions first');
  assert.deepEqual(ids(six.undone), [11, 10, 9, 8, 7]);
});

test('the restore sheet defaults to Everything and blocks a restore that would change nothing', async () => {
  const { HistoryRestoreSheet, nothingToRestore } = await load('/src/features/admin/HistoryPage.jsx');
  const { DataClientProvider } = await load('/src/api/DataClientProvider.jsx');
  const render = (entry, versions) =>
    renderToStaticMarkup(h(DataClientProvider, { client: {} }, h(HistoryRestoreSheet, { entry, nextVersion: 12, versions, onClose() {}, onRestored() {} })));

  const eight = render(HISTORY[3], HISTORY);
  assert.match(eight, /checked="" value="all"/);
  assert.match(text(eight), /This takes back one later version of Safety incidents: Version 9/);
  assert.match(text(eight), /AI systems &amp; functions already holds the data of version 8 again and stays as it is/);
  assert.match(eight, /value="models"\/><span>AI systems &amp; functions<span class="radio-row-detail">, nothing to restore/);
  assert.match(eight, /Restore as version 12</);

  // Version 10 restored the registry to 8, like 11 after it: restoring 10 changes nothing at all.
  const ten = render(HISTORY[1], HISTORY);
  assert.match(ten, /Every data set already holds the data of version 10, so restoring it would change nothing\./);
  assert.match(ten, /<button type="button" class="button-filled" disabled="">Nothing to restore<\/button>/);

  assert.match(nothingToRestore(restorePlan(HISTORY, 8, 'models'), 'models', 8), /already holds the data of version 8 again/);
  assert.match(nothingToRestore(restorePlan(HISTORY, 8, 'prevalence'), 'prevalence', 8), /No version after 8 changed Prevalence/);

  // Two data sets that change go back together, as one version (every_kind, v1.11).
  const six = render(HISTORY[5], HISTORY);
  assert.match(six, /Restore as version 12</);
  assert.doesNotMatch(text(six), /its own version/);
});

function fakeClient(answers) {
  const calls = [];
  return {
    calls,
    async rollbackVersion(request) {
      calls.push(request);
      const answer = answers[request.kind ?? 'all'];
      const result = typeof answer === 'function' ? answer(calls) : answer;
      if (result instanceof Error) throw result;
      return { version_id: 100 + calls.length, kind: request.kind ?? null, summary: `Rolled back ${request.kind}.` };
    }
  };
}
const problem = (code) => Object.assign(new Error(code), { code });

test('restoring everything sends one restore per data set that changes, in order', async () => {
  const client = fakeClient({});
  const outcome = await runRestore(client, { versionId: 6, kinds: ['models', 'safety'], note: 'Back to 6.' });
  assert.deepEqual(client.calls, [
    { versionId: 6, kind: 'models', note: 'Back to 6.' },
    { versionId: 6, kind: 'safety', note: 'Back to 6.' }
  ]);
  assert.deepEqual(ids(outcome.restored), [101, 102]);
  assert.equal(outcome.failed, null);

  // A version that covers every data set restores all at once (one version).
  const once = fakeClient({});
  await runRestore(once, { versionId: 1, kinds: ['models', 'safety'], note: 'n', allAtOnce: true });
  assert.deepEqual(once.calls, [{ versionId: 1, everyKind: true, note: 'n' }]);

  // A data set that already matches is skipped; a conflict is tried again after the others.
  let firstMetrics = true;
  const retry = fakeClient({
    models: problem('rollback_no_change'),
    metrics: () => {
      if (firstMetrics) {
        firstMetrics = false;
        return problem('rollback_conflict');
      }
      return null;
    }
  });
  const mixed = await runRestore(retry, { versionId: 6, kinds: ['models', 'metrics', 'safety'], note: 'n' });
  assert.deepEqual(retry.calls.map((call) => call.kind), ['models', 'metrics', 'safety', 'metrics']);
  assert.deepEqual(mixed.unchanged, ['models']);
  assert.deepEqual(mixed.restored.map((entry) => entry.kind), ['safety', 'metrics']);
  assert.equal(mixed.failed, null);

  // Any other failure stops at once and keeps what was restored before it.
  const stop = fakeClient({ safety: problem('publish_in_progress') });
  const stopped = await runRestore(stop, { versionId: 6, kinds: ['models', 'safety', 'population'], note: 'n' });
  assert.deepEqual(stopped.restored.map((entry) => entry.kind), ['models']);
  assert.equal(stopped.failed.kind, 'safety');
  assert.equal(stopped.failed.error.code, 'publish_in_progress');
  assert.equal(stop.calls.length, 2);
});

test('a refused no-change restore reads in plain words', () => {
  const words = describeProblem(problem('rollback_no_change'));
  assert.equal(words.title, 'Nothing to restore');
  assert.match(words.text, /already matches this version.*no version was added/);
});

// ------------------------------------------------------------ D12 evidence

test('a Performance value without its Validation type is named in the row form before it is sent', async () => {
  const filled = (values) => {
    const form = { ...emptyMetricRow(), condition: { code: '5A11', name: 'Type 2 diabetes mellitus' }, source: 'S', study: 'T' };
    form.values = { ...form.values, ...values };
    return form;
  };
  assert.equal(metricRowProblems(filled({ perf: '0.81' })).validation_type, EVIDENCE_NEEDED);
  assert.deepEqual(metricRowProblems(filled({ perf: '0.81', validation_type: 'benchmark' })), {});
  assert.deepEqual(metricRowProblems(filled({ validation_type: '' })), {}, 'no Performance, no evidence needed');
  assert.match(metricRowProblems(filled({ perf: '0.81', validation_type: 'benchmark', warnings: 'clinician_review_required; no_validation_data' })).warnings, /Remove no_validation_data/);
  assert.equal(metricRowProblems(filled({ perf: '84' })).validation_type, undefined, 'a malformed Performance is named first');
  assert.deepEqual(evidenceProblems(metricRecord(filled({ perf: '0.81', validation_type: 'internal_test' }))), {});
  assert.ok(evidenceProblems({ perf: 0.81, validation_type: null }).validation_type, 'record values too');

  const { default: MetricRowForm } = await load('/src/features/admin/MetricRowForm.jsx');
  const render = (form) =>
    renderWithClient(h(MetricRowForm, { form, onChange() {}, target: { model: 'M', useCase: 'U' }, meta: null, onSubmit() {}, isBusy: false, onReset() {} }));
  assert.match(await render(filled({ perf: '0.81' })), /Needed: Performance has a value\./);
  assert.doesNotMatch(await render(filled({ perf: '0.81', validation_type: 'benchmark' })), /Needed: Performance has a value/);
  assert.doesNotMatch(await render(filled({})), /Not validated/, 'one missing state');
});

test('the study helper will not stage Performance without its Validation type', async () => {
  const { proposalProblems, reviewProblems } = await load('/src/features/admin/assist.js');
  const entry = { record: { code: '5A11', age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities', perf: 0.81, validation_type: null, warnings: '' }, fields: {} };
  assert.equal(proposalProblems('metrics', entry, undefined).validation_type, EVIDENCE_NEEDED);
  assert.deepEqual(proposalProblems('metrics', entry, { validation_type: 'benchmark' }), {});
  assert.deepEqual(proposalProblems('metrics', { ...entry, record: { ...entry.record, perf: null } }, undefined), {});
  assert.deepEqual(proposalProblems('safety', { record: { summary: 'x' } }, undefined), {});
  // A proposal without the field gets it from an edit.
  const bare = { record: { code: '5A11', perf: 0.81 }, fields: {} };
  assert.deepEqual(proposalProblems('metrics', bare, { validation_type: 'benchmark' }), {});

  const proposals = { kind: 'metrics', batches: [{ model_version: 'M', use_case: 'U', records: [entry] }], dropped: [] };
  assert.equal(reviewProblems(proposals, { kept: { '0:0': true }, edits: {} }).length, 1);
  assert.equal(reviewProblems(proposals, { kept: { '0:0': true }, edits: { '0:0': { validation_type: 'benchmark' } } }).length, 0);
  assert.equal(reviewProblems(proposals, { kept: {}, edits: {} }).length, 0, 'an unticked record is not staged');
});
