// Across groups (contract v1.13, CONTRACT.md §24): the reason given when no
// group has a result, and with local results for the chosen population (§24
// Layers) each group read against the all-patients result of its own layer.
// All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { rangePosition } from '../frontend/src/design/rangeScale.js';
import { AcrossGroups } from '../frontend/src/features/details/AcrossGroups.js';
import { acrossGroupsModel } from '../frontend/src/features/details/copy/subgroupCopy.js';

const ALL = { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };
const RULE = { min_delta: 0.05, requires_ci_separation: true, note: 'Prototype heuristic. Not a grade; it changes no status.' };

function entry(axis, group, perf, ci, extra = {}) {
  const lens = axis === 'all' ? ALL : { ...ALL, [axis]: group };
  return {
    axis,
    group,
    lens,
    has_result: perf !== undefined,
    perf: perf ?? null,
    ci_low: ci ? perf - ci : null,
    ci_high: ci ? perf + ci : null,
    status: { overall: 'strong', performance: perf >= 0.8 ? 'strong' : 'moderate', evidence: 'strong' },
    provenance: perf === undefined ? null : { source: 'condition', lens_fallback: false, rollup: null },
    ...extra
  };
}

const ANSWER = {
  dataset_version: '7',
  concept: { concept_id: '5A11' },
  all_patients: entry('all', null, 0.79, 0.024),
  groups: [
    entry('age', 'Age 0-17', 0.666, 0.067, { difference: { delta: -0.124, direction: 'lower', flagged: true, reason: 'separated' } }),
    entry('sex', 'Sex Female', 0.75, 0.08, { difference: { delta: -0.04, direction: 'lower', flagged: false, reason: 'below_delta' } })
  ]
};

test('without any group result the reason follows the facts (no mapping, all patients only, no data)', () => {
  const empty = (extra = {}) => ({ ...entry('age', 'Age 65+', undefined, null), difference: { delta: null, direction: null, flagged: false, reason: 'no_result' }, ...extra });
  const groups = [empty(), { ...empty(), axis: 'sex', group: 'Sex Female', lens: { ...ALL, sex: 'Sex Female' } }];
  // A MONDO concept without an ICD-11 mapping on a card that stores every group.
  const unmapped = acrossGroupsModel({ ...ANSWER, all_patients: entry('all', null, undefined, null), groups, mapping: { kind: 'none', icd11: null } });
  assert.equal(unmapped.summary, 'No results by group: this condition has no ICD-11 mapping.');
  assert.doesNotMatch(unmapped.summary, /all patients only/);
  // All patients has a result and no group has a row: stored for all patients only.
  assert.equal(acrossGroupsModel({ ...ANSWER, groups }).summary, 'No results by group: results are stored for all patients only.');
  // Groups have rows but no values, or nothing has a result: no data, never "all patients only".
  const valueless = groups.map((group) => ({ ...group, has_result: true, provenance: { source: 'condition', lens_fallback: false, rollup: null } }));
  assert.equal(acrossGroupsModel({ ...ANSWER, groups: valueless }).summary, 'No results by group: no data for this condition.');
  assert.equal(acrossGroupsModel({ ...ANSWER, all_patients: entry('all', null, undefined, null), groups }).summary, 'No results by group: no data for this condition.');
});

test('with local results a group is read against the all-patients result of its own layer (§24 Layers)', () => {
  const layered = {
    ...ANSWER,
    all_patients: entry('all', null, 0.63, 0.045, { layer: 'local', provenance: { source: 'condition', lens_fallback: false, rollup: null, layer: 'local' } }),
    public_all_patients: entry('all', null, 0.88, 0.044, { layer: 'public' }),
    groups: [
      entry('age', 'Age 65+', 0.701, 0.045, { layer: 'local', difference: { delta: 0.071, direction: 'higher', flagged: false, reason: 'ci_overlap', compared_with: 'local' } }),
      entry('sex', 'Sex Female', 0.657, 0.056, { layer: 'public', difference: { delta: -0.223, direction: 'lower', flagged: true, reason: 'separated', compared_with: 'public' } })
    ]
  };
  const model = acrossGroupsModel(layered, { currentLens: ALL });
  assert.equal(model.isLayered, true);
  assert.deepEqual(model.references.map((row) => row.isCurrent), [true, false], 'only the served all-patients result is on the atlas');
  assert.deepEqual(model.references.map((row) => [row.label, row.value]), [['All patients, local result', '0.63'], ['All patients, public result', '0.88']]);
  const [older] = model.groups[0].rows;
  const [female] = model.groups[1].rows;
  assert.equal(older.details[0], 'Local result');
  assert.equal(female.details[0], 'Public result');
  assert.equal(female.flag.word, 'Lower');
  // Each line marks the all-patients result of the row's own layer.
  const atPct = (row, perf) => row.referencePct === rangePosition(perf, row.chart.domain).pct;
  assert.ok(atPct(older, 0.63), 'the local group reads against local all patients');
  assert.ok(atPct(female, 0.88), 'the public group reads against public all patients');
  const html = renderToStaticMarkup(h(AcrossGroups, { isOpen: true, onToggle: () => {}, query: { data: layered }, depth: 'plain', rule: RULE }));
  assert.match(html, /Local results are compared with the local result for all patients, public results with the public one\./);
  assert.match(html, /All patients, public result/);
  assert.match(html, /aria-label="Female, performance 0\.65, Lower than all patients, Public result"/);
  // A local group without a local all-patients result is not compared.
  const lone = acrossGroupsModel({
    ...layered,
    all_patients: entry('all', null, 0.88, 0.044, { layer: 'public' }),
    public_all_patients: undefined,
    groups: [entry('age', 'Age 65+', 0.701, 0.045, { layer: 'local', difference: { delta: null, direction: null, flagged: false, reason: 'layer_differs', compared_with: null } })]
  });
  assert.equal(lone.references.length, 1);
  assert.equal(lone.references[0].label, 'All patients');
  assert.equal(lone.groups[0].rows[0].referencePct, null);
  assert.ok(lone.groups[0].rows[0].details.includes('Not compared: no local result for all patients'));
  // Without local results nothing changes: one reference row, no layer words.
  const plain = acrossGroupsModel(ANSWER);
  assert.equal(plain.isLayered, false);
  assert.equal(plain.references.length, 1);
  assert.ok(plain.groups.flatMap((group) => group.rows).every((row) => !row.details.some((detail) => /result$/.test(detail))));
});

test('the contract adds the layer fields optionally (§24 Layers)', () => {
  const spec = JSON.parse(readFileSync(new URL('../backend/openapi.json', import.meta.url), 'utf8'));
  const contract = readFileSync(new URL('../backend/CONTRACT.md', import.meta.url), 'utf8');
  const schemas = spec.components.schemas;
  assert.ok(schemas.SubgroupDifference.properties.reason.enum.includes('layer_differs'));
  assert.deepEqual(schemas.SubgroupLayer.enum, ['local', 'includes_local', 'public']);
  assert.ok(!schemas.SubgroupDifference.required.includes('compared_with'));
  assert.ok(!schemas.SubgroupResult.required.includes('layer'));
  assert.ok(!schemas.ConceptSubgroups.required.includes('public_all_patients'));
  assert.match(contract, /\*\*Layers\*\*/);
});

