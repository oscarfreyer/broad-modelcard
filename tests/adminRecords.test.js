// The Data Library's S3 additions:
// the one-record forms and their records, merge-or-replace copy, change
// notes on publish and restore, notes in History, the Safety incidents data
// set, and the preview links. Components are rendered through Vite's SSR
// loader (Vite is already the build tool), so JSX runs without a browser.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { adminRouteSearch, parseAdminRoute } from '../frontend/src/features/admin/adminRoute.js';
import { liveAtlasHref, previewHref, safetyPreviewHref } from '../frontend/src/features/admin/atlasLinks.js';
import { headline, removals } from '../frontend/src/features/admin/changeSummary.js';
import { DATASETS, DATASET_ORDER, recordCount, versionSummary } from '../frontend/src/features/admin/datasets.js';
import {
  HARMS,
  INCIDENT_STATUSES,
  changedIncidentId,
  emptyIncident,
  emptyMetricRow,
  incidentProblems,
  incidentRecord,
  incidentSeverity,
  metricRecord,
  metricRowProblems,
  newIncidentId,
  noteIsReady,
  parseMetricNumber,
  todayIso
} from '../frontend/src/features/admin/records.js';

const NOW = new Date(2026, 9, 12, 9, 30);
const CARD = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' };

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

function filledIncident(patch = {}) {
  return {
    ...emptyIncident({ card: CARD, now: NOW, random: () => 0 }),
    codes: [
      { code: '5A11', name: 'Type 2 diabetes mellitus' },
      { code: 'CA40.0', name: 'Bacterial pneumonia' }
    ],
    lens: { age: 'Age 65+', sex: 'All sexes', ethnicity: 'All ethnicities' },
    incidentType: 'harmful_recommendation',
    harm: 'possible',
    sourceReference: '  Incident report IR-2026-031 (fictional) ',
    summary: ' Synthetic example: dosing advice ignored reduced kidney function. ',
    ...patch
  };
}

test('the incident form maps to one safety record in template column keys', () => {
  const form = filledIncident();
  assert.equal(form.incidentId, 'SI-20261012-AAAA');
  assert.equal(form.reportedDate, '2026-10-12');
  assert.equal(form.updatedDate, '', 'only the reported date defaults to today');
  assert.deepEqual(incidentRecord(form), {
    incident_id: 'SI-20261012-AAAA',
    model_version: 'SynGPT-2.0',
    use_case: 'Clinician Facing CDSS',
    codes: '5A11; CA40.0',
    age: 'Age 65+',
    sex: null,
    ethnicity: null,
    incident_type: 'harmful_recommendation',
    harm: 'possible',
    status: 'open',
    source_type: 'incident_report',
    source_reference: 'Incident report IR-2026-031 (fictional)',
    study_id: null,
    reported_date: '2026-10-12',
    updated_date: null,
    summary: 'Synthetic example: dosing advice ignored reduced kidney function.',
    scope: 'Public'
  });
  // A whole chapter replaces the codes; a study carries its Study ID.
  const chapter = incidentRecord(filledIncident({ scope: 'chapter', chapterNo: '06', sourceType: 'study', studyId: ' NBR-2026-01 ' }));
  assert.equal(chapter.codes, 'chapter 06');
  assert.equal(chapter.study_id, 'NBR-2026-01');
  // A Study ID typed before switching away from Study is not sent.
  assert.equal(incidentRecord(filledIncident({ studyId: 'X-1' })).study_id, null);
  assert.equal(incidentRecord(filledIncident({ updatedDate: '2026-10-13' })).updated_date, '2026-10-13');
});

test('the incident form names what it still needs before anything is sent', () => {
  const empty = { ...emptyIncident({ now: NOW }), status: '' };
  assert.deepEqual(Object.keys(incidentProblems(empty)).sort(), ['card', 'harm', 'incidentType', 'sourceReference', 'status', 'summary', 'where']);
  assert.deepEqual(incidentProblems(filledIncident()), {});
  assert.ok(incidentProblems(filledIncident({ sourceType: 'study' })).studyId, 'a study needs its Study ID');
  assert.ok(incidentProblems(filledIncident({ scope: 'chapter' })).where, 'a chapter must be chosen');
  assert.ok(incidentProblems(filledIncident({ updatedDate: '2026-10-01' })).updatedDate, 'updated before reported');
  assert.ok(incidentProblems(filledIncident({ summary: 'x'.repeat(281) })).summary);
  assert.ok(incidentProblems(filledIncident({ incidentId: 'SI 1' })).incidentId);
  assert.match(newIncidentId(NOW, () => 0.999), /^SI-20261012-[A-Z2-9]{4}$/);
  assert.equal(todayIso(NOW), '2026-10-12');
});

test('the severity line follows CONTRACT.md §18', () => {
  const cases = [
    [{ status: 'open', harm: 'occurred', incidentType: 'other' }, 'serious'],
    [{ status: 'open', harm: 'possible', incidentType: 'other' }, 'serious'],
    [{ status: 'open', harm: 'none', incidentType: 'developer_notice_or_recall' }, 'serious'],
    [{ status: 'open', harm: 'none', incidentType: 'subgroup_bias' }, 'caution'],
    [{ status: 'mitigated', harm: 'occurred', incidentType: 'other' }, 'caution'],
    [{ status: 'closed', harm: 'occurred', incidentType: 'developer_notice_or_recall' }, null]
  ];
  for (const [input, expected] of cases) {
    assert.equal(incidentSeverity(input), expected, JSON.stringify(input));
  }
});

test('the metrics row form maps to one metrics record with its source', () => {
  const form = {
    ...emptyMetricRow({ now: NOW }),
    condition: { code: '5A11', name: 'Type 2 diabetes mellitus' },
    lens: { age: 'Age 65+', sex: 'All sexes', ethnicity: 'All ethnicities' },
    source: 'Northbridge multisite validation (fictional)',
    study: 'NBR-2026-01'
  };
  form.values = { ...form.values, perf: '0,81', ci_low: '0.77', ci_high: '0.85', n_samples: '1200', validation_type: 'clinical_study_multisite' };
  assert.deepEqual(metricRowProblems(form), {});
  const record = metricRecord(form);
  assert.deepEqual(
    [record.code, record.age, record.sex, record.perf, record.ci_low, record.n_samples, record.n_sites, record.evidence_grade],
    ['5A11', 'Age 65+', 'All sexes', 0.81, 0.77, 1200, null, null]
  );
  assert.equal(record.in_intended_use, 'Yes');
  assert.equal(record.intended_use_level, 'in_scope');
  assert.equal(record.warnings, '');
  assert.deepEqual([record.source, record.study, record.source_date], ['Northbridge multisite validation (fictional)', 'NBR-2026-01', '2026-10-12']);
  assert.equal(Object.keys(record).length, 4 + 13 + 3, 'key, lens, the 13 fields, and the source');
  const bad = { ...form, source: '', values: { ...form.values, perf: '84', n_sites: '2.5' } };
  assert.deepEqual(Object.keys(metricRowProblems(bad)).sort(), ['n_sites', 'perf', 'source']);
});

test('metric numbers: a decimal comma only in 0–1 fields, plain digits for counts', () => {
  assert.deepEqual(parseMetricNumber('0,84', 'share'), { number: 0.84 });
  assert.deepEqual(parseMetricNumber('.5', 'share'), { number: 0.5 });
  assert.deepEqual(parseMetricNumber('1', 'share'), { number: 1 });
  assert.deepEqual(parseMetricNumber('1200', 'count'), { number: 1200 });
  assert.deepEqual(parseMetricNumber('0', 'count'), { number: 0 });
  for (const value of ['1,000', '1.000', '1e3', '0x10', '-1', '2.5', '1 000', '+3']) {
    assert.ok(parseMetricNumber(value, 'count').problem, `count ${value}`);
  }
  for (const value of ['0x1', '1e-1', '-0.2', '0,8,4', '1.2', '0.5.', 'Infinity']) {
    assert.ok(parseMetricNumber(value, 'share').problem, `share ${value}`);
  }
  const form = { ...emptyMetricRow({ now: NOW }), condition: { code: '5A11', name: 'X' }, source: 'S', study: 'T' };
  form.values = { ...form.values, n_samples: '1,000', perf: '0x10' };
  const problems = metricRowProblems(form);
  assert.match(problems.n_samples, /digits only/);
  assert.match(problems.perf, /between 0 and 1/);
  // "1,000" is never read as 1.
  assert.notEqual(metricRecord(form).n_samples, 1);
});

test('change notes are required, at most 500 characters', () => {
  assert.equal(noteIsReady(''), false);
  assert.equal(noteIsReady('   '), false);
  assert.equal(noteIsReady('Adds incident SI-1.'), true);
  assert.equal(noteIsReady('x'.repeat(500)), true);
  assert.equal(noteIsReady('x'.repeat(501)), false);
});

test('Safety incidents is the fifth data set, with routes, counts, and merge by default', () => {
  assert.deepEqual(DATASET_ORDER.slice(0, 5), ['models', 'metrics', 'multimorbidity', 'prevalence', 'safety']);
  const safety = DATASETS.safety;
  assert.equal(safety.title, 'Safety incidents');
  assert.deepEqual(safety.counts.map((entry) => entry.key), ['incidents', 'open']);
  assert.equal(safety.defaultMode, 'merge');
  assert.equal(safety.recordForm, 'incident');
  assert.match(safety.about, /No reported incidents does not mean safe/);
  assert.equal(parseAdminRoute('?set=safety&model=M&use_case=U').page, 'safety');
  assert.equal(adminRouteSearch({ page: 'safety', model: 'M', useCase: 'U' }), '?set=safety&model=M&use_case=U');
  // Merge is offered where the backend allows it (metrics, prevalence, safety, studies), never for the others.
  assert.deepEqual(DATASET_ORDER.filter((kind) => DATASETS[kind].modes.includes('merge')), ['metrics', 'prevalence', 'safety', 'studies', 'effects', 'local_metrics']);
  // A new file adds or changes rows unless the maintainer chooses Replace (A13).
  for (const kind of DATASET_ORDER) {
    assert.equal(DATASETS[kind].defaultMode, DATASETS[kind].modes.includes('merge') ? 'merge' : 'replace', kind);
  }
  assert.equal(recordCount('safety', 1), '1 incident');
  assert.equal(recordCount('metrics', 2), '2 rows');
});

test('merge copy: only the named rows change, and removal needs the Remove marker', () => {
  for (const kind of ['metrics', 'prevalence', 'safety']) {
    assert.match(DATASETS[kind].mergeHelp, /only new or changed [a-z]+; others stay/, kind);
    assert.match(DATASETS[kind].mergeHelp, /Action “Remove” (deletes|clears)/, kind);
  }
  assert.match(DATASETS.metrics.mergeHelp, /Source, Study, and Source date/);
  const changes = { kind: 'safety', rows: { added: 1, changed: 0, removed: 2, unchanged: 0 }, models: {}, use_cases: {}, status_shifts: [] };
  assert.deepEqual(removals(changes, { mode: 'merge' }), ['2 incidents marked Remove in your file will leave the live data.']);
  assert.match(removals({ ...changes, kind: 'metrics' })[0], /2 rows in the live data are missing from your file/);
  assert.equal(headline(changes), 'Incidents: 1 added, 2 removed.');
});

test('preview links open the Safety view on the card and the first incident', () => {
  const upload = { upload_id: 'up-1', kind: 'safety', origin: 'records' };
  const changes = {
    rows: {
      samples: {
        added: [{ key: 'SI-1', name: 'SI-1: Synthetic example', concept_id: '5A11', code: '5A11', lens: { age: 'Age 65+', sex: 'All sexes', ethnicity: 'All ethnicities' } }],
        changed: [],
        removed: []
      }
    }
  };
  const params = new URLSearchParams(safetyPreviewHref(upload, { target: CARD, changes }).split('?')[1]);
  assert.equal(params.get('version'), 'staged:up-1');
  assert.equal(params.get('view'), 'safety');
  assert.equal(params.get('model'), 'SynGPT-2.0');
  assert.equal(params.get('use_case'), 'Clinician Facing CDSS');
  assert.equal(params.get('concept'), '5A11');
  assert.equal(params.get('age'), 'Age 65+');
  assert.equal(params.get('sex'), null, '"All …" stays out of the URL');
  assert.equal(liveAtlasHref('safety', CARD), './atlas.html?model=SynGPT-2.0&use_case=Clinician+Facing+CDSS&view=safety');
  // A file may name incidents of other cards: its preview opens the picked card without a condition or population.
  const file = new URLSearchParams(safetyPreviewHref({ upload_id: 'up-2', kind: 'safety', origin: 'file' }, { target: CARD, changes }).split('?')[1]);
  assert.deepEqual([file.get('version'), file.get('view'), file.get('model'), file.get('use_case')], ['staged:up-2', 'safety', 'SynGPT-2.0', 'Clinician Facing CDSS']);
  assert.equal(file.get('concept'), null);
  assert.equal(file.get('age'), null);
  // Other data sets keep their links.
  assert.doesNotMatch(previewHref({ upload_id: 'u2' }, { kind: 'metrics', target: CARD }), /view=/);
});

test('backend summaries read in the page words: Restore is the only verb', () => {
  assert.equal(versionSummary('Rolled back safety incidents to version 5.'), 'Restored safety incidents to the data of version 5.');
  assert.equal(versionSummary('Rolled back models & use cases to version 1.'), 'Restored AI systems & functions to the data of version 1.');
  assert.equal(versionSummary('Safety incidents: 1 incident added.'), 'Safety incidents: 1 incident added.');
});

const VERSIONS = [
  { version_id: 9, kind: 'safety', published_at: '2026-10-12T10:00:00Z', summary: 'Safety incidents: 1 incident added.', upload_id: 'u9', rollback_of: null, previewed: true, note: 'Adds the open incident from report IR-2026-031.' },
  { version_id: 8, kind: 'metrics', published_at: '2026-10-12T09:00:00Z', summary: 'Performance metrics for X / Y: 2 rows changed.', upload_id: 'u8', rollback_of: null, previewed: false, note: null },
  { version_id: 1, kind: null, published_at: '2026-10-08T09:00:00Z', summary: 'Initial import.', upload_id: null, rollback_of: null, previewed: false, note: null }
];

async function renderWithClient(element) {
  const { DataClientProvider } = await load('/src/api/DataClientProvider.jsx');
  return renderToStaticMarkup(h(DataClientProvider, { client: {} }, element));
}

test('History shows each version’s change note', async () => {
  const { default: HistoryPage } = await load('/src/features/admin/HistoryPage.jsx');
  const html = await renderWithClient(h(HistoryPage, { versions: VERSIONS, onLibraryChange() {} }));
  assert.match(html, /Note:<\/span> Adds the open incident from report IR-2026-031\./);
  assert.equal((html.match(/version-note-label/g) ?? []).length, 1, 'versions without a note show none');
  // The filter is one select of every versioned kind, in the data sets' own titles (it no longer fits a segmented row).
  assert.match(html, /<select[^>]*>/);
  for (const word of ['All data sets', 'AI systems &amp; functions', 'Performance metrics', 'Safety incidents', 'Local populations', 'Narrow model cards']) {
    assert.match(html, new RegExp(`<option value="[a-z_]+"[^>]*>${word}</option>`), word);
  }
});

test('publish and restore stay disabled until a change note is written', async () => {
  const { PublishSheet, RestoreSheet } = await load('/src/features/admin/PublishSteps.jsx');
  const { HistoryRestoreSheet } = await load('/src/features/admin/HistoryPage.jsx');
  const session = { busy: null, problem: null, publish: async () => null, rollback: async () => null };
  const upload = { upload_id: 'u1', kind: 'safety', filename: 'safety-records.csv', origin: 'records', mode: 'merge', previewed: true };
  const changes = { kind: 'safety', rows: { added: 1, changed: 0, removed: 0, unchanged: 0 }, models: {}, use_cases: {}, status_shifts: [] };
  const confirm = (html, label) => {
    const button = html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];
    assert.ok(button, label);
    return button;
  };

  const publish = await renderWithClient(
    h(PublishSheet, { dataset: DATASETS.safety, target: CARD, upload, changes, nextVersion: 10, session, onClose() {}, onPublished() {} })
  );
  assert.match(confirm(publish, 'Publish as version 10'), /disabled/);
  assert.match(publish, /Change note/);
  assert.match(publish, /Required: say why/);
  assert.match(publish, /entered with the form; adds or changes incidents/);

  const restore = await renderWithClient(h(RestoreSheet, { published: VERSIONS[0], previousVersion: 8, dataset: DATASETS.safety, session, onClose() {} }));
  assert.match(confirm(restore, 'Restore as version 10'), /disabled/);
  assert.match(restore, /Why restore\?/);
  assert.match(restore, /This takes back version 9:/);

  const history = await renderWithClient(h(HistoryRestoreSheet, { entry: VERSIONS[1], nextVersion: 10, versions: VERSIONS, onClose() {}, onRestored() {} }));
  assert.match(confirm(history, 'Restore as version 10'), /disabled/);
  // Everything by default: restoring version 8 takes back the later safety change.
  assert.match(history, /<input type="radio" name="restore-kind" checked="" value="all"\/>/);
  assert.match(history, /This takes back one later version of Safety incidents/);
});

test('a restore names the later versions it takes back (S8 critique)', async () => {
  const { restoreUndoes } = await load('/src/features/admin/HistoryPage.jsx');
  const versions = [
    { version_id: 6, kind: 'safety' },
    { version_id: 5, kind: 'metrics' },
    { version_id: 4, kind: 'safety' },
    { version_id: 3, kind: null },
    { version_id: 2, kind: 'models' },
    { version_id: 1, kind: null }
  ];
  const ids = (list) => list.map((version) => version.version_id);
  assert.deepEqual(ids(restoreUndoes(versions, 2, 'safety')), [6, 4, 3]);
  assert.deepEqual(ids(restoreUndoes(versions, 1, 'all')), [6, 5, 4, 3, 2]);
  assert.deepEqual(ids(restoreUndoes(versions, 5, 'models')), []);
  assert.deepEqual(restoreUndoes(versions, 1, null), [], 'nothing until a data set is chosen');
});

test('the Safety page offers the incident form and, for files, the merge choice', async () => {
  const { default: UploadStep } = await load('/src/features/admin/UploadStep.jsx');
  const session = { upload: null, pendingReplace: null, busy: null, send() {} };
  const props = { dataset: DATASETS.safety, session, disabledReason: null, mode: 'merge', onModeChange() {}, onEntryChange() {} };
  const form = h('form', { 'aria-label': 'Report one safety incident' });
  const withForm = renderToStaticMarkup(h(UploadStep, { ...props, entry: 'record', recordForm: form }));
  assert.match(withForm, /Report one incident/);
  assert.match(withForm, /Upload a file/);
  assert.match(withForm, /aria-label="Report one safety incident"/);
  assert.doesNotMatch(withForm, /How should this file change the data/);

  const withFile = renderToStaticMarkup(h(UploadStep, { ...props, entry: 'file', recordForm: form }));
  assert.match(withFile, /How should this file change the data\?/);
  assert.match(withFile, /Add or change rows/);
  assert.match(withFile, /Replace the whole data set/);
  assert.match(withFile, /checked="" value="merge"/);

  // The registry has no merge mode, so no choice is offered.
  const registry = renderToStaticMarkup(h(UploadStep, { ...props, dataset: DATASETS.models, entry: 'file' }));
  assert.doesNotMatch(registry, /How should this file change the data/);
});

test('the incident form renders every field the template has, with the patient-data rule', async () => {
  const { default: IncidentForm } = await load('/src/features/admin/IncidentForm.jsx');
  const models = [{ model_version: 'SynGPT-2.0', display_name: 'SynGPT-2.0', default_use_case: 'Clinician Facing CDSS', use_cases: [{ use_case: 'Clinician Facing CDSS' }] }];
  const meta = { axes: { age: ['All ages', 'Age 65+'], sex: ['All sexes'], ethnicity: ['All ethnicities'] }, chapters: [] };
  const html = await renderWithClient(
    h(IncidentForm, { form: filledIncident(), onChange() {}, models, meta, onSubmit() {}, isBusy: false, onReset() {} })
  );
  for (const label of ['AI system', 'Function', 'ICD-11 codes', 'Age', 'Sex', 'Ethnicity', 'Incident type', 'Harm', 'Status', 'Source type', 'Source reference', 'Reported date', 'Updated date', 'Incident ID']) {
    assert.match(html, new RegExp(`>${label}(<|\\s)`), label);
  }
  assert.match(html, /Never patient details or real patient data/);
  assert.match(html, /5A11/);
  assert.match(html, /Serious/, 'the severity line shows how the atlas marks it');
  assert.match(html, /Check this incident/);
  assert.doesNotMatch(html, />Study ID</, 'Study ID only for a study');
});

test('the sidebar lists Safety incidents with its version and waiting count', async () => {
  const { Sidebar } = await load('/src/features/admin/AdminApp.jsx');
  const datasets = [
    { kind: 'safety', version: 8, updated_at: '2026-10-12T10:00:00Z', counts: { incidents: 17, open: 12 }, staged_upload_id: 'u1', staged_upload_ids: ['u1'] }
  ];
  const html = renderToStaticMarkup(h(Sidebar, { page: 'safety', datasets, onNavigate() {} }));
  assert.match(html, /href="\?set=safety"/);
  assert.match(html, /Safety incidents/);
  // Short to see ("v8, 12 Oct"), whole in words for screen readers (A32).
  assert.match(html, /<span aria-hidden="true">v8, 12 Oct<\/span><span class="visually-hidden">Changed in version 8, 12 October 2026<\/span>/);
  assert.match(html, /1 waiting/);
  assert.match(html, /aria-current="page"[^>]*>|class="sidebar-row is-current"/);
});

test('the code picker keyboard stays on the drawn options, and Enter never submits the form', async () => {
  const { SHOWN_MATCHES, activeIndex, comboboxKey, shownMatches } = await import('../frontend/src/features/admin/codePickerKeys.js');
  const forty = Array.from({ length: 40 }, (_, index) => ({ code: `C${index}` }));
  assert.equal(shownMatches(forty).length, SHOWN_MATCHES);
  const state = { shownCount: SHOWN_MATCHES, isListShown: true };
  // Arrow keys cycle the 12 drawn options, never an unseen 13th.
  assert.equal(comboboxKey('ArrowDown', { ...state, active: SHOWN_MATCHES - 1 }).active, 0);
  assert.equal(comboboxKey('ArrowUp', { ...state, active: 0 }).active, SHOWN_MATCHES - 1);
  assert.equal(comboboxKey('ArrowDown', { ...state, active: 30 }).active, 0, 'an index past the drawn list is clamped first');
  assert.deepEqual(comboboxKey('Enter', { ...state, active: 30 }), { preventDefault: true, pick: SHOWN_MATCHES - 1 });
  assert.equal(activeIndex(5, 0), null);
  // Enter with nothing highlighted (search pending, no match, list closed) is swallowed.
  assert.deepEqual(comboboxKey('Enter', { active: 0, shownCount: 0, isListShown: true }), { preventDefault: true });
  assert.deepEqual(comboboxKey('Enter', { active: 0, shownCount: 3, isListShown: false }), { preventDefault: true });
  assert.deepEqual(comboboxKey('ArrowDown', { active: 0, shownCount: 0, isListShown: false }), { preventDefault: true, open: true });
  assert.equal(comboboxKey('Tab', { ...state, active: 0 }).preventDefault, false);
});

test('a removed code token returns focus to the search field', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../frontend/src/features/admin/CodePicker.jsx', import.meta.url), 'utf8');
  const remove = source.slice(source.indexOf('className="code-token-remove"'), source.indexOf('</button>', source.indexOf('className="code-token-remove"')));
  assert.match(remove, /inputRef\.current\?\.focus\(\)/);
  assert.doesNotMatch(source, /matches\.slice\(0, 12\)/, 'the drawn options come from shownMatches');
});

test('the harm choices explain themselves in their help, which the group also reads out', async () => {
  const { ChoiceField } = await load('/src/features/admin/FormFields.jsx');
  const html = renderToStaticMarkup(h(ChoiceField, { label: 'Harm', value: 'none', options: HARMS, onChange() {} }));
  // A question mark that opens on hover, focus, or tap (HelpTip.js), never a title attribute.
  const hint = html.match(/<span id="([^"]+)" class="help-tip-bubble"[^>]*><p>([^<]+)<\/p><\/span>/);
  assert.ok(hint, 'the help holds the hint');
  assert.equal(hint[2], 'Occurred: a patient was harmed. Possible: harm could have occurred. None: no harm was possible.');
  assert.match(html, new RegExp(`<fieldset[^>]*aria-describedby="${hint[1]}"`));
  assert.match(html, /aria-label="About Harm"/);
  assert.doesNotMatch(html, /title=/, 'no hover-only hints');
  const status = renderToStaticMarkup(h(ChoiceField, { label: 'Status', value: 'open', options: INCIDENT_STATUSES, onChange() {} }));
  assert.doesNotMatch(status, /help-tip/);
});

test('the Harm and Status radios and the sidebar links carry readable accessible names', async () => {
  const { ChoiceField } = await load('/src/features/admin/FormFields.jsx');
  for (const [label, options, value] of [['Harm', HARMS, 'possible'], ['Status', INCIDENT_STATUSES, 'open']]) {
    const html = renderToStaticMarkup(h(ChoiceField, { label, value, options, onChange() {} }));
    for (const option of options) {
      assert.match(html, new RegExp(`<input type="radio"[^>]*aria-label="${option.label}"[^>]*value="${option.value}"`), `${label}: ${option.value}`);
    }
  }
  const { Sidebar } = await load('/src/features/admin/AdminApp.jsx');
  const datasets = [{ kind: 'safety', version: 8, updated_at: '2026-10-12T10:00:00Z', staged_upload_ids: ['u1'] }];
  const html = renderToStaticMarkup(h(Sidebar, { page: 'safety', datasets, onNavigate() {} }));
  const links = [...html.matchAll(/<a class="sidebar-row[^"]*"[^>]*>/g)].map((match) => match[0]);
  assert.ok(links.length >= 7);
  for (const link of links) {
    assert.match(link, /aria-label="[A-Z][^"]+"/, link);
  }
  assert.match(html, /aria-label="Safety incidents, 1 waiting" aria-describedby="sidebar-detail-safety"/);
  assert.match(html, /<span class="sidebar-detail" id="sidebar-detail-safety"><span aria-hidden="true">v8, /);
  assert.match(html, /<span class="visually-hidden">Changed in version 8, /);
});

test('typing a stored incident ID warns that every field replaces the stored incident', async () => {
  const fresh = filledIncident();
  assert.equal(changedIncidentId(fresh), null, 'the form’s own ID adds an incident');
  assert.equal(changedIncidentId({ ...fresh, incidentId: ' SI-20260804-7KQ2 ' }), 'SI-20260804-7KQ2');
  assert.equal(changedIncidentId({ ...fresh, incidentId: 'SI 1' }), null, 'an invalid ID is named by its own problem');
  assert.equal(incidentRecord(fresh).freshId, undefined, 'the fresh ID is never sent');

  const { default: IncidentForm } = await load('/src/features/admin/IncidentForm.jsx');
  const models = [{ model_version: 'SynGPT-2.0', display_name: 'SynGPT-2.0', default_use_case: 'Clinician Facing CDSS', use_cases: [{ use_case: 'Clinician Facing CDSS' }] }];
  const render = (form) => renderWithClient(h(IncidentForm, { form, onChange() {}, models, meta: null, onSubmit() {}, isBusy: false, onReset() {} }));
  assert.doesNotMatch(await render(fresh), /is stored, publishing replaces it/);
  // A short note now: Edit in the list fills in the stored values; no spreadsheet to copy from.
  const html = text(await render({ ...fresh, incidentId: 'SI-20260804-7KQ2' }));
  assert.match(html, /If SI-20260804-7KQ2 is stored, publishing replaces it/);
  assert.match(html, /choose Edit in the list above/);
  assert.doesNotMatch(html, /as Excel/);
});

test('a form entry with problems says when a reload emptied the form, and offers to start it again', async () => {
  const { default: CheckStep } = await load('/src/features/admin/CheckStep.jsx');
  const upload = {
    upload_id: 'u-form',
    kind: 'safety',
    filename: 'safety-records.csv',
    origin: 'records',
    mode: 'merge',
    status: 'invalid',
    report: { row_count: 1, errors: [{ code: 'unknown_code', count: 1, message: 'A code is not in the atlas.', fix: 'Choose a listed code.', examples: [] }], notes: [] }
  };
  const render = (formEntry) => renderWithClient(h(CheckStep, { session: { upload, busy: null }, formEntry }));
  const kept = text(await render({ state: 'kept', onRestart() {} }));
  assert.match(kept, /in the form above \(it keeps what you entered\)/);
  assert.doesNotMatch(kept, /Start the form again/);

  const lost = text(await render({ state: 'lost', onRestart() {} }));
  assert.match(lost, /The page was reloaded since, so the form no longer holds it/);
  assert.doesNotMatch(lost, /it keeps what you entered/);
  assert.match(lost, /Start the form again/);
  assert.match(text(await render({ state: 'lostSaved', onRestart() {} })), /Start the form again with what you entered/);
  const empty = text(await render({ state: 'empty', onRestart() {} }));
  assert.match(empty, /Enter the record again in the form above/);
  assert.doesNotMatch(empty, /keeps what you entered|Start the form again/);

  // The page knows which form entries it holds: those it sent or refilled.
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../frontend/src/features/admin/DatasetPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /\[created\.upload_id\]: 'kept'/);
  assert.match(page, /setEntry\('record'\)/, 'starting again opens the form, also on the metrics page');
  assert.match(page, /<CheckStep session=\{session\} formEntry=\{formEntry\} \/>/);
});


test('a patient-level upload offers no marked copy: its file was deleted after the check (CONTRACT.md §21)', async () => {
  const { default: CheckStep } = await load('/src/features/admin/CheckStep.jsx');
  const invalid = (errors) => ({
    upload_id: 'u-pop',
    kind: 'population',
    filename: 'region.csv',
    origin: 'file',
    mode: 'replace',
    status: 'invalid',
    report: { row_count: 2, errors, notes: [] }
  });
  const patientLevel = { code: 'patient_level_data', count: 1, message: 'The file looks like it holds patient-level data.', fix: 'Delete the column.', examples: [] };
  const other = { code: 'extra_column', count: 1, message: 'The template has no column.', fix: 'Delete it.', examples: [] };
  const { DataClientProvider } = await load('/src/api/DataClientProvider.jsx');
  const client = { getAnnotatedUploadUrl: ({ uploadId, format }) => `/api/v1/admin/uploads/${uploadId}/annotated.${format}` };
  const render = async (upload) => renderToStaticMarkup(h(DataClientProvider, { client }, h(CheckStep, { session: { upload, busy: null } })));
  const deleted = await render(invalid([patientLevel, other]));
  assert.doesNotMatch(deleted, /annotated\.(csv|xlsx)/, 'no marked copy link');
  assert.match(text(deleted), /deleted right after the check because it looked like patient-level data/);
  const kept = await render(invalid([other]));
  assert.match(kept, /annotated\.csv/, 'any other invalid file keeps its marked copy');
});

test('the change note announces its count only near and over the limit (S8)', async () => {
  const { countAnnouncement } = await load('/src/features/admin/FormFields.jsx');
  assert.equal(countAnnouncement(12, 500), '');
  assert.equal(countAnnouncement(460, 500), '40 characters left.');
  assert.equal(countAnnouncement(503, 500), '3 characters over the limit of 500.');
  const { ChangeNoteField } = await load('/src/features/admin/PublishSteps.jsx');
  const html = renderToStaticMarkup(h(ChangeNoteField, { value: '', onChange() {} }));
  assert.match(html, /aria-required="true"/);
  assert.doesNotMatch(html, /aria-live="polite"/, 'the visible count is not live');
});

test('sheets open on their title and never leave the focus on the page (S8)', async () => {
  const { readFileSync } = await import('node:fs');
  const source = (name) => readFileSync(new URL(`../frontend/src/features/admin/${name}`, import.meta.url), 'utf8');
  const { default: Sheet } = await load('/src/features/admin/Sheet.jsx');
  const html = renderToStaticMarkup(h(Sheet, { title: 'Publish as version 9?', onClose() {}, actions: null }));
  assert.match(html, /<h2[^>]*class="sheet-title"[^>]*tabindex="-1"/);
  assert.match(source('Sheet.jsx'), /querySelector\('\.sheet-title'\)\?\.focus\(\)/);
  // The helper's sheet falls back to its sidebar row and closes once it is off.
  assert.match(source('HelperSettingsSheet.jsx'), /fallbackFocus="\.sidebar-button"/);
  assert.match(source('HelperSettingsSheet.jsx'), /assist\.close\(\);\n    }\n  };/);
  // Staging a form entry or the helper's proposals moves the focus to the check.
  assert.equal((source('DatasetPage.jsx').match(/focusStep\(2\)/g) ?? []).length, 2);
});


test('History and the sheets speak the page words: the seed import and incidents (S8)', async () => {
  const { modeShort } = await load('/src/features/admin/records.js');
  assert.equal(modeShort('merge', 'safety'), 'adds or changes incidents');
  assert.equal(modeShort('merge', 'metrics'), 'adds or changes rows');
  assert.equal(modeShort(undefined, 'prevalence'), 'replaces the whole data set');
  assert.equal(
    versionSummary('Initial import of the legacy JSON tables (synthetic demonstration data).'),
    'The first version: the synthetic seed data the app starts with.'
  );
});
