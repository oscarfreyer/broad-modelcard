// Pure logic of the data-update admin: URL routes, links to the atlas, the
// change summary in status words, data set copy, and plain-language problems.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { adminRouteSearch, parseAdminRoute } from '../frontend/src/features/admin/adminRoute.js';
import { previewHref, liveAtlasHref } from '../frontend/src/features/admin/atlasLinks.js';
import { hasNoChanges, headline, nameSentence, namedRows, removals, sampleText, shiftTotal, shiftsByTarget, shiftsByView, statusWord } from '../frontend/src/features/admin/changeSummary.js';
import { populationWords } from '../frontend/src/shared/format.js';
import { DATASETS, DATASET_ORDER, plural } from '../frontend/src/features/admin/datasets.js';
import { describeProblem } from '../frontend/src/features/admin/problems.js';
import { DataClientError } from '../frontend/src/api/dataClient.js';

const CHANGES = {
  upload_id: 'u1',
  kind: 'prevalence',
  base_version: 3,
  rows: { added: 0, changed: 17, removed: 2, unchanged: 13423 },
  models: {},
  use_cases: {},
  status_shifts: [
    { view: 'evidence', from: 'moderate', to: 'weak', count: 10, sample_concept_ids: ['5A11'] },
    { view: 'overall', from: 'strong', to: 'moderate', count: 1, sample_concept_ids: ['5A10'] },
    { view: 'overall', from: 'moderate', to: 'weak', count: 2, sample_concept_ids: [] },
    { view: 'intended_use', from: 'in_scope', to: 'out_of_scope', count: 4, sample_concept_ids: [] }
  ]
};

test('admin routes: data set, target, and history live in the URL', () => {
  assert.deepEqual(parseAdminRoute('?set=metrics&model=M&use_case=CDSS'), { page: 'metrics', explicit: true, model: 'M', useCase: 'CDSS', population: null, published: null });
  assert.equal(parseAdminRoute('?set=prevalence&published=4').published, 4);
  assert.equal(parseAdminRoute('?set=prevalence&published=-1').published, null);
  assert.equal(adminRouteSearch({ page: 'prevalence', published: 4 }), '?set=prevalence&published=4');
  assert.equal(parseAdminRoute('?view=history').page, 'history');
  // Without a page, the first data set of the sidebar (A13).
  assert.equal(parseAdminRoute('?set=nonsense').page, 'models');
  assert.equal(parseAdminRoute('').page, DATASET_ORDER[0]);
  assert.equal(adminRouteSearch({ page: 'prevalence', model: 'M' }), '?set=prevalence&model=M');
  assert.equal(adminRouteSearch({ page: 'history', model: 'M' }), '?view=history');
  const upload = { upload_id: 'u9', kind: 'multimorbidity' };
  assert.equal(
    previewHref(upload, { target: { model: 'M', useCase: 'U' }, view: 'evidence', conceptId: '5A11' }),
    './atlas.html?version=staged%3Au9&model=M&use_case=U&view=evidence&mode=multimorbidity&concept=5A11'
  );
  assert.equal(liveAtlasHref('prevalence', null), './atlas.html');
});

test('the change summary groups shifts by view in display order, biggest first', () => {
  const groups = shiftsByView(CHANGES);
  assert.deepEqual(groups.map((group) => group.viewId), ['overall', 'evidence', 'intended_use']);
  assert.deepEqual(groups[0].shifts.map((shift) => shift.count), [2, 1]);
  assert.equal(groups[0].total, 3);
  assert.equal(shiftTotal(CHANGES), 17);
  assert.equal(statusWord('not_validated'), 'No data'); // D5: a served not_validated reads No data
  assert.equal(statusWord('partially_in_scope'), 'Partly in scope');
  assert.equal(statusWord('nonsense'), 'No data');
  assert.equal(headline(CHANGES), 'Rows: 17 changed, 2 removed; 17 condition status changes.');
});

test('removals are called out; an unchanged file says so', () => {
  assert.deepEqual(removals(CHANGES), ['2 rows in the live data are missing from your file and will be removed from the live data.']);
  const registry = { ...CHANGES, rows: { added: 0, changed: 0, removed: 1, unchanged: 9 }, models: { removed: ['Old-1'] }, use_cases: { removed: ['Old-1 / CDSS'] } };
  assert.equal(removals(registry).length, 3);
  const same = { ...CHANGES, rows: { added: 0, changed: 0, removed: 0, unchanged: 13442 }, status_shifts: [] };
  assert.equal(hasNoChanges(same), true);
  assert.equal(hasNoChanges(CHANGES), false);
  assert.match(headline(same), /matches the live data/);
});

test('every data set has plain copy, and plurals read right', () => {
  assert.deepEqual(DATASET_ORDER, ['models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population', 'studies', 'effects', 'local_metrics']);
  for (const kind of DATASET_ORDER) {
    const dataset = DATASETS[kind];
    assert.ok(dataset.about.length > 40 && dataset.rows && dataset.counts.length, kind);
    assert.doesNotMatch(dataset.about, /json|schema|api|endpoint/i, `${kind} copy avoids developer jargon`);
  }
  assert.match(DATASETS.prevalence.shiftScope, /grouped by AI system and function/, 'prevalence explains why one code can change several statuses');
  assert.equal(DATASETS.models.shiftScope, null);
  assert.equal(DATASETS.metrics.needsTarget, true);
  assert.equal(DATASETS.prevalence.needsTarget, false);
  assert.equal(plural(1, 'row'), '1 row');
  assert.equal(plural(216000, 'row'), '216,000 rows');
});

test('admin failures are described in plain words with the next step', () => {
  const problem = (status, code, detail) => new DataClientError({ status, code, title: 'x', detail });
  assert.match(describeProblem(problem(409, 'publish_in_progress')).text, /Wait a few seconds/);
  assert.match(describeProblem(problem(415, 'unsupported_file_type')).title, /not a CSV or Excel/);
  assert.match(describeProblem(problem(0, 'backend_unavailable')).text, /npm run dev/);
  const conflict = describeProblem(problem(409, 'rollback_conflict', 'X / CDSS would have no metrics.'));
  assert.equal(conflict.detail, 'X / CDSS would have no metrics.');
  const unknown = describeProblem(new Error('boom'));
  assert.equal(unknown.title, 'Something went wrong');
  assert.equal(unknown.text, 'boom');
});

const ALL = { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };
const sample = (code, name, lens = null) => ({ key: lens ? `${code}|0` : code, name, concept_id: code, code, lens });

test('changed rows are named, five at most, with the rest counted (contract v1.4 samples)', () => {
  const changes = {
    kind: 'metrics',
    rows: {
      added: 0,
      changed: 7,
      removed: 2,
      unchanged: 0,
      samples: {
        added: [],
        changed: ['1A00', '1A01', '1A02', '1A03', '1A04', '1A05', '1A06'].map((code) => sample(code, `Condition ${code}`, ALL)),
        removed: [sample('1A07', 'Cholera', { age: 'Age 65+', sex: 'Sex Female', ethnicity: 'All ethnicities' })]
      }
    },
    models: {},
    use_cases: {},
    status_shifts: []
  };
  const changed = namedRows(changes, 'changed');
  assert.equal(changed.names.length, 5);
  assert.equal(changed.more, 2);
  assert.equal(changed.names[0], 'Condition 1A00, 1A00, All patients');
  assert.equal(namedRows(changes, 'added'), null);
  // The removal notice names what leaves the live data; the count stays authoritative.
  assert.deepEqual(removals(changes), [
    '2 rows in the live data are missing from your file and will be removed from the live data.',
    'Removed: Cholera, 1A07, Age 65+, Female and 1 more row.'
  ]);
  assert.equal(nameSentence({ names: ['A', 'B'], more: 3 }), 'A, B, and 3 more rows');
  // One condition removed in many population groups is one line, and the rest are counted in rows.
  const lenses = ['All ethnicities', 'Ethnicity White', 'Ethnicity Black'].map((ethnicity) => ({ ...ALL, ethnicity }));
  const folded = namedRows({ rows: { removed: 90, samples: { removed: lenses.map((lens) => sample('1A00', 'Cholera', lens)) } } }, 'removed');
  assert.deepEqual(folded, { names: ['Cholera, 1A00, 3 population groups'], more: 87 });
  assert.equal(sampleText(sample('5A11', 'Type 2 diabetes mellitus')), 'Type 2 diabetes mellitus, 5A11');
  assert.equal(sampleText(sample('2F20', '- Benign cutaneous melanocytic neoplasms')), 'Benign cutaneous melanocytic neoplasms, 2F20');
  assert.equal(namedRows({ rows: { changed: 3 } }, 'changed'), null, 'an older backend without samples shows counts only');
});

test('population words read like the toolbar', () => {
  assert.equal(populationWords(ALL), 'All patients');
  assert.equal(populationWords({ age: 'Age 0-17', sex: 'Sex Male', ethnicity: 'Ethnicity Asian' }), 'Age 0–17, Male, Asian');
});

test('prevalence shifts are grouped per model, and each "Show one" opens that model (contract v1.4 targets)', () => {
  const changes = {
    kind: 'prevalence',
    status_shifts: [
      {
        view: 'evidence', from: 'moderate', to: 'weak', count: 2, sample_concept_ids: ['5A11', '1A00'],
        targets: [
          { model_version: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS', count: 2, sample_concept_ids: ['5A11', '1A00'] },
          { model_version: 'MediCore-2.5', use_case: 'Discharge letter generation', count: 1, sample_concept_ids: ['1A00'] }
        ]
      },
      {
        view: 'overall', from: 'strong', to: 'moderate', count: 1, sample_concept_ids: ['1A00'],
        targets: [{ model_version: 'MediCore-2.5', use_case: 'Discharge letter generation', count: 1, sample_concept_ids: ['1A00'] }]
      }
    ]
  };
  const groups = shiftsByTarget(changes);
  assert.deepEqual(groups.map((group) => [group.label, group.total]), [
    ['MediCore-2.5, Discharge letter generation', 2],
    ['SynGPT-2.0, Clinician-Facing CDSS', 2]
  ]);
  assert.equal(shiftTotal(changes), 4, 'one change per condition, view, and model');
  const medicore = groups[0];
  assert.deepEqual(medicore.changes.status_shifts.map((shift) => [shift.view, shift.count, shift.sample_concept_ids[0]]), [
    ['evidence', 1, '1A00'],
    ['overall', 1, '1A00']
  ]);
  const href = previewHref({ upload_id: 'up-1' }, { kind: 'prevalence', target: medicore.target, view: 'evidence', conceptId: '1A00' });
  const params = new URLSearchParams(href.split('?')[1]);
  assert.equal(params.get('model'), 'MediCore-2.5');
  assert.equal(params.get('use_case'), 'Discharge letter generation');
  assert.equal(params.get('concept'), '1A00');
  assert.deepEqual(shiftsByTarget({ status_shifts: [{ view: 'overall', from: 'strong', to: 'weak', count: 1, sample_concept_ids: ['X'] }] }), []);
});

test('the Data Library uses one version vocabulary and one verb (Restore)', () => {
  const dir = new URL('../frontend/src/features/admin/', import.meta.url);
  const source = readdirSync(dir)
    .filter((name) => /\.(jsx?|js)$/.test(name))
    .map((name) => readFileSync(new URL(name, dir), 'utf8'))
    .join('\n')
    // Comments and identifiers may name the API operation; user-facing strings may not.
    .replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
  // Identifiers (rollbackVersion, rollback_conflict) never contain a space; user-facing words do.
  assert.doesNotMatch(source, /\b(roll|rolled|rolling) back\b/i);
  assert.match(source, /`Live version \$\{liveVersion\}, changed \$\{dateTime\(info\.updated_at\)\}`/);
  assert.match(source, /Publish as version/);
  assert.match(source, /`Restore version \$\{entry\.version_id\}\?`/);
  assert.match(source, /`Restore as \$\{versionsInWords\(nextVersion, versionCount\)\}`/);
  assert.doesNotMatch(source, /`Version \$\{info\.version\}/, 'no bare per-data-set "Version N"');
});
