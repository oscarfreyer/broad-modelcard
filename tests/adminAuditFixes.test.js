// Data Library fixes from the 2026-10-14 audit (batch 1): the one-row
// metrics form (A14), incident IDs (A15), and lens option words (A33).
// Components render through Vite's SSR loader, as in adminRecords.test.js.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import {
  INTENDED_USE_KEYS,
  METRIC_WARNING_CODES,
  emptyIncident,
  emptyMetricRow,
  metricRecord,
  metricRowProblems,
  nextIncidentId,
  stagedIncidentIds,
  toggleWarning,
  validStagedUploadIds,
  warningList,
  withNextIncidentId
} from '../frontend/src/features/admin/records.js';
import { lensOptions, lensValueWords } from '../frontend/src/shared/format.js';

const NOW = new Date(2026, 9, 14, 9, 30);
const TARGET = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' };
const AXES = {
  age: ['All ages', 'Age 0-17', 'Age 65+'],
  sex: ['All sexes', 'Sex Female', 'Sex Male'],
  ethnicity: ['All ethnicities', 'Ethnicity Asian']
};

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
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] }
  });
});
after(async () => {
  await vite?.close();
});

async function render(element) {
  const { DataClientProvider } = await load('/src/api/DataClientProvider.jsx');
  return renderToStaticMarkup(h(DataClientProvider, { client: {} }, element));
}

function filledRow(patch = {}) {
  const form = emptyMetricRow({ now: NOW });
  return {
    ...form,
    condition: { code: '5A11', name: 'Type 2 diabetes mellitus' },
    values: { ...form.values, perf: '0.8', validation_type: 'external', warnings: 'clinician_review_required' },
    source: 'Northbridge validation (fictional)',
    study: 'NBR-1',
    ...patch
  };
}

test('lens options under a labelled control drop the dimension (A33)', () => {
  assert.equal(lensValueWords('Sex Female'), 'Female');
  assert.equal(lensValueWords('Age 0-17'), '0–17');
  assert.equal(lensValueWords('Age 65+'), '65+');
  assert.equal(lensValueWords('Ethnicity Asian'), 'Asian');
  assert.equal(lensValueWords('All ages'), 'All ages');
  assert.deepEqual(lensOptions(AXES.sex), [
    { value: 'All sexes', label: 'All sexes' },
    { value: 'Sex Female', label: 'Female' },
    { value: 'Sex Male', label: 'Male' }
  ]);
});

test('warnings are ticked from the known codes and kept as the template cell (A14)', () => {
  assert.ok(METRIC_WARNING_CODES.includes('clinician_review_required'));
  assert.ok(!METRIC_WARNING_CODES.some((code) => code.startsWith('multimorbidity')), 'metrics rows, not combinations');
  assert.deepEqual(warningList(' a ; b;;c '), ['a', 'b', 'c']);
  assert.equal(toggleWarning('a; b', 'c', true), 'a; b; c');
  assert.equal(toggleWarning('a; b; c', 'b', false), 'a; c');
  assert.equal(toggleWarning('a', 'a', true), 'a', 'never twice');
});

test('a card without an intended-use statement is not asked for intended use (A14)', async () => {
  const form = filledRow({ values: { ...filledRow().values, in_intended_use: 'Yes', intended_use_level: '', intended_use_coverage: '0.5' } });
  // With a statement, a half-filled pair is a problem; without one it is not asked.
  assert.ok(metricRowProblems(form).intended_use_level);
  assert.deepEqual(Object.keys(metricRowProblems(form, { hasIntendedUse: false })), []);
  const record = metricRecord(form, { hasIntendedUse: false });
  for (const key of INTENDED_USE_KEYS) assert.equal(record[key], null, key);
  assert.equal(metricRecord(form).in_intended_use, 'Yes');

  const { default: MetricRowForm } = await load('/src/features/admin/MetricRowForm.jsx');
  const props = { form, onChange() {}, target: TARGET, meta: { axes: AXES }, onSubmit() {}, isBusy: false, onReset() {} };
  const withStatement = text(await render(h(MetricRowForm, props)));
  const without = await render(h(MetricRowForm, { ...props, hasIntendedUse: false }));
  assert.match(withStatement, /In intended use/);
  assert.match(withStatement, /Give In intended use and Intended-use level together/);
  assert.doesNotMatch(text(without), /In intended use|Intended-use level|Intended-use coverage/);
  assert.match(text(without), /This card has no intended-use statement, so the intended-use fields are not asked/);
  // The garbled sentence is gone.
  assert.doesNotMatch(withStatement, /does not report it; In intended use/);
  // Warnings are checkboxes with the condition card's words; the chosen code is ticked.
  assert.match(without, /<input type="checkbox" checked=""\/><span>Clinician review required<span class="warning-code">clinician_review_required<\/span>/);
  assert.equal((without.match(/type="checkbox"/g) || []).length, METRIC_WARNING_CODES.length);
  // Required fields are marked, to see and to hear.
  assert.equal((without.match(/class="field-required"> \(required\)/g) || []).length, 4, 'code, source, study, source date');
  assert.equal((without.match(/aria-required="true"/g) || []).length, 3, 'source, study, source date (the code picker has a value)');
  // Lens options without the dimension.
  assert.match(without, /<option value="Sex Female">Female<\/option>/);
  assert.match(without, /<option value="Age 0-17">0–17<\/option>/);
});

test('an incident staged but not yet published reserves its ID (audit batch 3)', () => {
  const stored = ['SI-2026-016', 'SI-2026-001'];
  // The change summary of a staged safety upload names its incidents by ID.
  const changes = {
    kind: 'safety',
    rows: { added: 1, changed: 1, removed: 0, unchanged: 14, samples: { added: [{ key: 'SI-2026-017' }], changed: [{ key: 'SI-2026-001' }], removed: [] } }
  };
  const staged = stagedIncidentIds(changes);
  assert.deepEqual(staged, ['SI-2026-017', 'SI-2026-001']);
  assert.deepEqual(stagedIncidentIds({ ...changes, kind: 'metrics' }), [], 'only a safety summary names incidents');
  assert.deepEqual(stagedIncidentIds(null), []);

  // A second new incident before the publish gets the next free ID.
  const second = withNextIncidentId(emptyIncident({ card: TARGET, now: NOW, random: () => 0 }), [...stored, ...staged], NOW);
  assert.equal(second.incidentId, 'SI-2026-018');
  // The form that staged SI-2026-017, still on screen, keeps its ID.
  const first = { ...emptyIncident({ card: TARGET, now: NOW }), incidentId: 'SI-2026-017', freshId: 'SI-2026-017', staged: true };
  assert.equal(withNextIncidentId(first, [...stored, ...staged], NOW), first);
  // A fresh form that got SI-2026-017 before the staged upload was known moves on.
  assert.equal(withNextIncidentId({ ...first, staged: false }, [...stored, ...staged], NOW).incidentId, 'SI-2026-018');

  // Only valid uploads can be read; the page's own (polled) upload wins over the restored list.
  assert.deepEqual(
    validStagedUploadIds({ upload_id: 'u2', status: 'valid' }, [{ upload_id: 'u2', status: 'checking' }, { upload_id: 'u1', status: 'valid' }, { upload_id: 'u3', status: 'invalid' }]),
    ['u1', 'u2']
  );
  assert.deepEqual(validStagedUploadIds(null, []), []);

  // The page reads the change summary (useIncidentIds), not a staged read, which would mark the upload previewed.
  const ids = readFileSync(new URL('../frontend/src/features/admin/useIncidentIds.js', import.meta.url), 'utf8');
  assert.match(ids, /client\.getUploadChanges\(\{ uploadId \}, options\)/);
  assert.doesNotMatch(ids, /listIncidents\(\{[^}]*version/);
  const page = readFileSync(new URL('../frontend/src/features/admin/DatasetPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /useIncidentIds\(\{/);
  assert.match(page, /\{ \.\.\.form, staged: true \}/);
});

test('a new incident gets the next free ID in the stored pattern, read-only (A15)', async () => {
  const stored = ['SI-2026-016', 'SI-2026-001', 'SI-2026-009'];
  assert.equal(nextIncidentId(stored, NOW), 'SI-2026-017');
  assert.equal(nextIncidentId([], NOW), 'SI-2026-001');
  assert.equal(nextIncidentId(['IR-7', 'IR-12', 'odd'], NOW), 'IR-13', 'the pattern most stored IDs share');
  assert.equal(nextIncidentId(['SI-2025-040', 'SI-2026-002'], NOW), 'SI-2026-003', 'this year first');
  assert.ok(!stored.includes(nextIncidentId(stored, NOW)));

  const fresh = emptyIncident({ card: TARGET, now: NOW, random: () => 0 });
  const next = withNextIncidentId(fresh, stored, NOW);
  assert.equal(next.incidentId, 'SI-2026-017');
  assert.equal(next.freshId, 'SI-2026-017', 'the form keeps it as its own: no collision note');
  assert.equal(withNextIncidentId(next, stored, NOW), next, 'stable');
  const editing = { ...next, incidentId: 'SI-2026-009', editing: { id: 'SI-2026-009', lastDate: '2026-10-01' } };
  assert.equal(withNextIncidentId(editing, stored, NOW), editing, 'an edited incident keeps its ID');

  const { default: IncidentForm } = await load('/src/features/admin/IncidentForm.jsx');
  const models = [{ model_version: TARGET.model, display_name: TARGET.model, default_use_case: TARGET.useCase, use_cases: [{ use_case: TARGET.useCase }] }];
  const props = { form: next, onChange() {}, models, meta: { axes: AXES, chapters: [] }, onSubmit() {}, isBusy: false, onReset() {}, storedIds: stored };
  const html = await render(h(IncidentForm, props));
  assert.match(html, /<input[^>]*readonly=""[^>]*value="SI-2026-017"/);
  assert.match(text(html), /The next free ID, given by the Data Library/);
  // An ID from an older form state that is stored: the note says so plainly.
  const collision = text(await render(h(IncidentForm, { ...props, form: { ...next, incidentId: 'SI-2026-009' } })));
  assert.match(collision, /SI-2026-009 is a stored incident: publishing replaces it/);
});

test('the sidebar never clips, the page is wider, and phone targets are 44px (B2, A32, B11)', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../frontend/src/styles/admin.css', import.meta.url), 'utf8');
  assert.match(css, /\.admin-sidebar > \* \{\s*flex-shrink: 0;/);
  assert.match(css, /\.admin-page \{[^}]*max-width: 960px;/);
  assert.doesNotMatch(css, /max-width: 58ch/);
  const phone = css.slice(css.lastIndexOf('@media (max-width: 767px)'));
  for (const selector of ['.admin-shell .segment', '.admin-shell select', '.admin-shell .text-input', '.admin-shell .button-plain', '.admin-shell .warning-option']) {
    assert.ok(phone.includes(selector), selector);
  }
  assert.match(phone, /min-height: 44px;/);
});
