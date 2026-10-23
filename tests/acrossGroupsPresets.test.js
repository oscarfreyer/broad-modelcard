// release 0.4, phase R3 (E3, E4, E5): the population
// named beside every result, "Across groups" (getConceptSubgroups, contract
// v1.13 §24), the Overview explainer and sheet, and the audience presets with
// their precedence and profile compatibility. All data is synthetic.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { conceptSubgroupsQuery } from '../frontend/src/api/queryKeys.js';
import { STATIC_REASONS, createStaticAdapter } from '../frontend/src/api/staticAdapter.js';
import { withProfileDefaults } from '../frontend/src/app/profileDefaults.js';
import { parseStartupParams } from '../frontend/src/app/startupParams.js';
import { mapRowStatus, overviewDecision, overviewStatus } from '../frontend/src/design/status.js';
import { AcrossGroups } from '../frontend/src/features/details/AcrossGroups.js';
import { OverviewExplainer } from '../frontend/src/features/details/OverviewExplainer.js';
import { buildConceptCardFile, cardFileStem } from '../frontend/src/features/details/conceptCardExport.js';
import { OVERVIEW_RULE, explainOverview } from '../frontend/src/features/details/copy/overviewRule.js';
import { acrossGroupsModel, ruleSentence } from '../frontend/src/features/details/copy/subgroupCopy.js';
import { labelText } from '../frontend/src/features/label/labelModel.js';
import { AUDIENCES, cardLayout, plainSummary } from '../frontend/src/features/profile/audience.js';
import { defaultsPhrases, depthChoice, depthToStore } from '../frontend/src/features/profile/defaultsModel.js';
import {
  PROFILE_KEY,
  createProfileStore,
  mergeImported,
  normalizeProfile,
  parseProfileFile,
  profileFile
} from '../frontend/src/features/profile/profile.js';
import { resultPopulationLabel, resultPopulationParts, resultPopulationSlug } from '../frontend/src/shared/resultPopulation.js';
import { schemaErrors } from './support/openapiSchema.js';
import { apiClient, copyStore, startTestBackend } from './support/backend.js';

const ALL = { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };
const NORTHBRIDGE = { id: 'northbridge-region', name: 'Northbridge region (fictional)' };
const RULE = { min_delta: 0.05, requires_ci_separation: true, note: 'Prototype heuristic. Not a grade; it changes no status.' };

// ------------------------------------------------- population beside results

test('one formatter names the lens and the prevalence', () => {
  assert.equal(resultPopulationLabel(ALL), 'All patients, default prevalence');
  assert.equal(resultPopulationLabel(null), 'All patients, default prevalence');
  assert.equal(resultPopulationLabel({ ...ALL, age: 'Age 65+', sex: 'Sex Female' }, NORTHBRIDGE), 'Age 65+, Female, Northbridge region (fictional)');
  assert.equal(resultPopulationLabel({ ...ALL, ethnicity: 'Ethnicity Asian' }), 'Asian, default prevalence');
  assert.equal(resultPopulationLabel({ ...ALL, age: 'Age 0-17' }), 'Age 0–17, default prevalence');
  assert.equal(resultPopulationLabel(ALL, null, { separator: ', ' }), 'All patients, default prevalence');
  assert.deepEqual(resultPopulationParts(ALL, NORTHBRIDGE), { group: 'All patients', prevalence: NORTHBRIDGE.name, isLocal: true, isAllPatients: true });
  assert.equal(resultPopulationSlug(ALL), '');
  assert.equal(resultPopulationSlug({ ...ALL, age: 'Age 65+', sex: 'Sex Female' }, NORTHBRIDGE), 'age-65-female-northbridge-region');
});

test('every surface that shows a result uses the formatter', () => {
  const read = (path) => readFileSync(new URL(`../frontend/src/${path}`, import.meta.url), 'utf8');
  for (const path of [
    'features/details/DetailCard.jsx', // condition card header
    'app/AtlasApp.jsx', // hover card and Summary (resultFor), dataset export file name
    'features/details/conceptCardExport.js', // JSON and PDF
    'features/label/DeveloperLabel.js', // model card
    'features/label/labelModel.js', // model card text layer
    'embed/panelView.js' // live panel header
  ]) {
    assert.match(read(path), /resultPopulation(Label|Slug)/, path);
  }
  assert.match(read('features/atlas/HoverCard.jsx'), /resultFor/);
  assert.match(read('features/summary/SummaryPanel.jsx'), /resultFor/);
});

test('the condition card export names who it is for, in the file and its name', () => {
  const conceptExport = {
    exported_at: '2026-10-20T00:00:00Z',
    audience_view: 'patient',
    concept: { code: '5A11', block: 'BLK', name: 'Type 2 diabetes mellitus', hierarchy: [] },
    context: { model: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS', population: { ...ALL, age: 'Age 65+' } },
    model_card: { perf: 0.8, ci_low: 0.75, ci_high: 0.85, overall: { tier: 'graded', score: 0.8, grade: 'B' }, status: { overall: 'strong', performance: 'strong', evidence: 'strong' }, provenance: { source: 'condition' } },
    warnings: [],
    safeguards: [],
    synthetic_data_notice: 'Synthetic.',
    population: NORTHBRIDGE
  };
  const card = buildConceptCardFile(conceptExport);
  assert.equal(card.context.shown_for, 'Age 65+, Northbridge region (fictional)');
  assert.equal(cardFileStem(card, conceptExport, NORTHBRIDGE), '5a11-condition-card-age-65-northbridge-region');
  assert.equal(cardFileStem(card), '5a11-condition-card');
});

test('the model card says "All patients, default prevalence"', () => {
  const lines = labelText({
    systemName: 'SynGPT-2.0', functionName: 'CDSS', facts: [], builtOn: [], total: 1, rows: [], noStatement: null, incidents: null,
    lens: ALL, population: null, prevalence: null, isPreview: false, datasetVersion: '7', lastChanged: null, cardUrl: 'http://127.0.0.1/atlas.html',
    cardUrlIsLocal: true, declarations: [], notice: 'Synthetic.'
  });
  assert.ok(lines.includes('Population: All patients, default prevalence.'), lines.join('\n'));
});

// ------------------------------------------------------------ Overview rule

const STATUSES = ['strong', 'moderate', 'weak', 'out_of_scope', 'no_data', 'not_validated', null];
const SAFETY = [null, 'caution', 'serious'];

test('the explainer decides exactly what the ring draws, for every combination', () => {
  let cases = 0;
  for (const overall of STATUSES) {
    for (const safety of SAFETY) {
      for (const hasIntendedUse of [true, false]) {
        for (const isEmptyRollup of [false, true]) {
          const mapRow = { concept_id: 'X', overall_status: overall, safety, child_count: isEmptyRollup ? 0 : null };
          const metricRow = {
            concept_id: 'X',
            perf: overall === 'no_data' ? null : 0.8,
            status: { overall, performance: 'moderate', evidence: 'strong' },
            overall: { tier: overall === 'out_of_scope' ? 'out_of_scope' : 'graded', score: 0.8, grade: 'B' },
            intended_use_level: overall === 'out_of_scope' ? 'out_of_scope' : 'in_scope',
            provenance: { source: isEmptyRollup ? 'rollup' : 'condition', rollup: isEmptyRollup ? { child_count: 0 } : null }
          };
          const incidents = safety ? [{ incident_id: 'I', severity: safety, status: 'open' }] : [];
          const ring = mapRowStatus(isEmptyRollup ? { ...mapRow, safety: null } : mapRow, 'overall', { hasIntendedUse });
          const explained = explainOverview({ row: metricRow, incidents, hasIntendedUse });
          assert.equal(explained.status, overviewStatus(metricRow, safety ?? 'no_incidents', { hasIntendedUse }));
          if (!isEmptyRollup && overall !== null) {
            assert.equal(explained.status, mapRowStatus(mapRow, 'overall', { hasIntendedUse }), JSON.stringify({ overall, safety, hasIntendedUse }));
          }
          // The deciding step is the one the shared rule names, and the only one marked "decided".
          const decision = overviewDecision({ safety, overallStatus: isEmptyRollup ? null : overall, hasIntendedUse });
          assert.equal(explained.decidingStep, decision.step);
          assert.deepEqual(explained.steps.filter((step) => step.state === 'decided').map((step) => step.id), [decision.step]);
          assert.ok(ring);
          cases += 1;
        }
      }
    }
  }
  assert.equal(cases, STATUSES.length * SAFETY.length * 4);
});

test('the explainer words each step and the sheet shares its source', () => {
  const row = {
    perf: 0.79,
    status: { overall: 'strong', performance: 'moderate', evidence: 'strong' },
    overall: { tier: 'graded', score: 0.828, grade: 'B' },
    intended_use_level: 'in_scope',
    provenance: { source: 'condition' }
  };
  const weights = { performance_grade: 0.35, perf: 0.2, evidence_grade: 0.3, intended_use: 0.15 };
  const plain = explainOverview({ row, depth: 'plain' });
  assert.equal(plain.decidingStep, 'grade');
  assert.match(plain.steps[2].result, /Performance Moderate and evidence Strong: Strong/);
  const expert = explainOverview({ row, depth: 'expert', weights });
  assert.match(expert.steps[2].result, /Score 0\.828, grade B\. Weights: performance grade 35%/);
  const withIncident = explainOverview({ row, incidents: [{ severity: 'serious', status: 'open' }] });
  assert.equal(withIncident.status, 'serious');
  assert.match(withIncident.steps[2].result, /^Underneath the incident/);
  assert.equal(withIncident.steps[3].state, 'not_reached');
  const noStatement = explainOverview({ row: { ...row, status: { ...row.status, overall: 'out_of_scope' } }, hasIntendedUse: false });
  assert.equal(noStatement.status, 'no_data');
  assert.match(noStatement.steps[1].result, /No intended-use statement/);

  assert.deepEqual(OVERVIEW_RULE.map((step) => step.id), ['incident', 'scope', 'grade', 'no_data']);
  const html = renderToStaticMarkup(h(OverviewExplainer, { row, depth: 'plain', defaultOpen: true, onOpenRule: () => {} }));
  assert.match(html, /What is behind this mark\?/);
  assert.match(html, /Decides the mark/);
  assert.match(html, /How the Overview works/);
  const sheet = readFileSync(new URL('../frontend/src/features/details/OverviewSheet.jsx', import.meta.url), 'utf8');
  assert.match(sheet, /OVERVIEW_RULE/, 'the sheet reads the same content source');
  for (const path of ['features/atlas/RingLegend.jsx', 'features/catalogue/CatalogueApp.jsx']) {
    assert.match(readFileSync(new URL(`../frontend/src/${path}`, import.meta.url), 'utf8'), /How the Overview works/, path);
  }
});

// ------------------------------------------------------------- Across groups

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
    entry('age', 'Age 65+', 0.861, 0.032, { difference: { delta: 0.071, direction: 'higher', flagged: true, reason: 'separated' } }),
    entry('sex', 'Sex Female', 0.75, 0.08, { difference: { delta: -0.04, direction: 'lower', flagged: false, reason: 'below_delta' }, provenance: { source: 'condition', lens_fallback: true } }),
    entry('ethnicity', 'Ethnicity Other', undefined, null, { difference: { delta: null, direction: null, flagged: false, reason: 'no_result' } })
  ]
};

test('the subgroup model words flags, fallback, missing results, and the group on screen', () => {
  const model = acrossGroupsModel(ANSWER, { depth: 'plain', currentLens: { ...ALL, age: 'Age 65+' } });
  assert.equal(model.reference.label, 'All patients');
  assert.deepEqual(model.groups.map((group) => group.label), ['Age', 'Sex', 'Ethnicity']);
  const [young, old] = model.groups[0].rows;
  assert.equal(young.label, '0–17');
  assert.deepEqual(young.flag, { direction: 'lower', word: 'Lower', text: 'Lower than all patients' });
  assert.equal(old.flag.word, 'Higher');
  assert.equal(old.isCurrent, true);
  assert.ok(old.referencePct > 0 && old.referencePct < 100, 'the all-patients line sits on the track');
  const female = model.groups[1].rows[0];
  assert.equal(female.flag, null);
  assert.equal(female.isFallback, true);
  const other = model.groups[2].rows[0];
  assert.equal(other.value, null);
  assert.equal(other.status, 'no_data');
  assert.equal(model.flaggedCount, 2);
  assert.equal(model.summary, '2 of 4 groups differ from all patients.');
  const expert = acrossGroupsModel(ANSWER, { depth: 'expert' });
  assert.match(expert.groups[0].rows[0].details.join(' '), /CI 0\.599–0\.733 Δ −0\.124/);
  assert.match(ruleSentence(RULE), /0\.05 or more and their ranges do not overlap\. A prototype check, not a grade\./);
  assert.match(ruleSentence(RULE, 'expert'), /not a grade; it changes no status/);
});

test('a product with results for all patients only says so and flags nothing', () => {
  const answer = {
    ...ANSWER,
    groups: ANSWER.groups.map((group) => ({ ...group, has_result: true, perf: null, ci_low: null, ci_high: null, provenance: { source: 'rollup', rollup: { child_count: 0 }, lens_fallback: false }, difference: { delta: null, direction: null, flagged: false, reason: 'no_result' } }))
  };
  const model = acrossGroupsModel(answer);
  assert.equal(model.hasAnyGroupResult, false);
  assert.equal(model.flaggedCount, 0);
  assert.match(model.summary, /all patients only/);
});

test('the section renders apart from Study quality, loads on demand, and lets a group be chosen', () => {
  const closed = renderToStaticMarkup(h(AcrossGroups, { isOpen: false, onToggle: () => {}, query: null, depth: 'plain' }));
  assert.match(closed, /<h3[^>]*>Across groups<\/h3>/);
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /group-row/);
  const open = renderToStaticMarkup(
    h(AcrossGroups, { isOpen: true, onToggle: () => {}, query: { data: ANSWER }, depth: 'plain', rule: RULE, currentLens: ALL, onChooseGroup: () => {} })
  );
  assert.match(open, /Lower/);
  assert.match(open, /aria-label="0–17, performance 0\.66, Lower than all patients"/);
  assert.match(open, /Worked out from related groups/);
  assert.match(open, /group-range-reference/);
  assert.match(open, /Choose a group to show it on the atlas\./);
  // About population groups, never about study quality.
  assert.doesNotMatch(open, /bias|Study quality|risk/i);
  const failed = renderToStaticMarkup(h(AcrossGroups, { isOpen: true, onToggle: () => {}, query: { data: null, error: new Error('x') }, depth: 'plain' }));
  assert.match(failed, /could not be loaded/);
});

test('the read is keyed without a lens, and the static demo says what it did not record (R7)', async () => {
  const filters = { model: 'M', useCase: 'U', age: 'Age 65+', sex: 'All sexes', ethnicity: 'All ethnicities' };
  const query = conceptSubgroupsQuery(filters, '5A11');
  assert.equal(query.key, conceptSubgroupsQuery({ ...filters, age: 'All ages' }, '5A11').key, 'a lens switch reuses the answer');
  assert.notEqual(query.key, conceptSubgroupsQuery({ ...filters, population: 'northbridge-region' }, '5A11').key);
  assert.equal(conceptSubgroupsQuery(filters, null), null);
  const calls = [];
  await query.fetch({ getConceptSubgroups: (params) => calls.push(params) }, {});
  assert.deepEqual(calls, [{ model: 'M', useCase: 'U', conceptId: '5A11' }]);
  // R7 records Across groups for the ICD-11 conditions; another classification says so in words.
  const adapter = createStaticAdapter({ fetch: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(
    adapter.getConceptSubgroups({ model: 'M', useCase: 'U', conceptId: 'MONDO:0005015', ontology: 'mondo' }),
    (error) => error.code === 'static_unavailable'
  );
  const app = readFileSync(new URL('../frontend/src/app/AtlasApp.jsx', import.meta.url), 'utf8');
  // The subgroup read is not switched off in the static build (other reads, e.g. R5's narrow card, may be).
  const subgroupLine = app.split('\n').find((line) => line.includes('const subgroupsQuery ='));
  assert.ok(subgroupLine, 'AtlasApp builds the subgroup query');
  assert.doesNotMatch(subgroupLine, /IS_STATIC_BUILD/, 'the static build offers Across groups too');
  const words = renderToStaticMarkup(
    h(AcrossGroups, { isOpen: true, onToggle: () => {}, query: { data: null, error: { code: 'static_unavailable', detail: STATIC_REASONS.subgroups } }, depth: 'plain' })
  );
  assert.match(words, /available for ICD-11 conditions only/);
});

test('the contract adds the read and the rule additively (v1.13, §24)', () => {
  const spec = JSON.parse(readFileSync(new URL('../backend/openapi.json', import.meta.url), 'utf8'));
  const contract = readFileSync(new URL('../backend/CONTRACT.md', import.meta.url), 'utf8');
  const operation = spec.paths['/metrics/concepts/{concept_id}/subgroups'].get;
  assert.equal(operation.operationId, 'getConceptSubgroups');
  const names = operation.parameters.map((param) => (param.$ref ? param.$ref.split('/').pop() : param.name));
  // The care setting (v1.14, §29): groups are compared within a setting.
  assert.deepEqual(names, ['ConceptIdPath', 'Model', 'UseCase', 'Context', 'Version', 'Population', 'Ontology']);
  assert.ok(!spec.components.schemas.Meta.required.includes('subgroup_difference'));
  assert.deepEqual(spec.components.schemas.SubgroupDifference.properties.reason.enum, ['separated', 'below_delta', 'ci_overlap', 'missing_ci', 'no_result', 'layer_differs']);
  // §24 Layers: additive, optional fields for cards with local results.
  assert.ok(!spec.components.schemas.SubgroupDifference.required.includes('compared_with'));
  assert.ok(!spec.components.schemas.SubgroupResult.required.includes('layer'));
  assert.ok(!spec.components.schemas.ConceptSubgroups.required.includes('public_all_patients'));
  assert.match(contract, /\*\*Layers\*\*/);
  assert.match(contract, /## 24\. Subgroups \(v1\.13\)/);
  assert.match(contract, /- \*\*v1\.13 \(R3\):\*\*/);
});

// --------------------------------------------------------- audience presets

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)), data };
}

test('presets set the starting depth and view on entry links; explicit choices win', () => {
  const entry = parseStartupParams('?model=SynGPT-2.0&use_case=CDSS');
  const procurement = withProfileDefaults(entry, { audience: 'procurement' });
  assert.equal(procurement.depth, 'expert');
  assert.equal(procurement.view, 'overall');
  assert.equal(procurement.audience, 'procurement');
  assert.ok(procurement.appliedDefaults.includes('audience'));
  assert.equal(withProfileDefaults(entry, { audience: 'patient' }).depth, 'plain');
  assert.equal(withProfileDefaults(entry, { audience: 'clinician' }).depth, 'plain');
  // An explicit depth default of this browser wins over the preset.
  assert.equal(withProfileDefaults(entry, { audience: 'procurement', depth: 'plain' }).depth, 'plain');
  // A link that carries atlas state opens exactly what it names: no preset depth, but the layout still follows.
  const state = withProfileDefaults(parseStartupParams('?model=SynGPT-2.0&use_case=CDSS&view=performance'), { audience: 'procurement' });
  assert.equal(state.depth, null);
  assert.equal(state.view, 'performance');
  assert.equal(state.audience, 'procurement');
  assert.deepEqual(state.appliedDefaults, []);
  const explicitDepth = withProfileDefaults(parseStartupParams('?depth=expert'), { audience: 'patient' });
  assert.equal(explicitDepth.depth, 'expert');
  // No audience: exactly as before.
  const none = withProfileDefaults(entry, {});
  assert.equal(none.depth, null);
  assert.equal(none.audience, null);
});

test('each preset lays the condition card out in its own order', () => {
  assert.deepEqual(cardLayout(null), { lead: [], openAssessment: false, plainSummary: false, hideExpertFacts: false });
  // Values first for every role; Across groups opens with a click.
  assert.deepEqual(cardLayout('clinician'), cardLayout(null));
  for (const audience of [null, 'clinician', 'patient', 'procurement', 'regulator', 'payer']) {
    assert.ok(!cardLayout(audience).lead.includes('acrossGroups'), audience);
    assert.ok(!('openAcrossGroups' in cardLayout(audience)), audience);
  }
  const atlas = readFileSync(new URL('../frontend/src/app/AtlasApp.jsx', import.meta.url), 'utf8');
  assert.match(atlas, /const \[acrossConceptId, setAcrossConceptId\] = useState\(null\);/);
  assert.match(atlas, /const isAcrossOpen = acrossConceptId !== null && acrossConceptId === nav\.selectedConceptId;/);
  assert.equal(cardLayout('patient').plainSummary, true);
  assert.equal(cardLayout('patient').hideExpertFacts, true);
  assert.equal(cardLayout('patient', 'expert').hideExpertFacts, false, 'a reader who switches to Expert sees every table');
  assert.deepEqual(cardLayout('procurement').lead, ['assessment', 'studyQuality']);
  assert.equal(cardLayout('procurement').openAssessment, true);
  assert.deepEqual(AUDIENCES.map((audience) => audience.label), ['Clinician', 'Patient', 'Procurement and governance', 'Regulator', 'Payer']);
  assert.match(plainSummary('strong', { performance: 'moderate', evidence: 'no_data' }), /^In short: strong overall\. How well it works is moderate; the proof behind it is missing\.$/);
  assert.match(plainSummary('serious', {}), /safety problem/);
  assert.match(plainSummary('no_data', {}), /no graded result/);
});

test('the role is chosen in Settings only: no first-visit prompt', () => {
  const audience = readFileSync(new URL('../frontend/src/features/profile/audience.js', import.meta.url), 'utf8');
  assert.doesNotMatch(audience, /shouldOfferAudience|Who is reading/);
  for (const file of ['app/AtlasApp.jsx', 'features/catalogue/CatalogueApp.jsx']) {
    assert.doesNotMatch(readFileSync(new URL(`../frontend/src/${file}`, import.meta.url), 'utf8'), /AudienceChoice/, file);
  }
  const storage = memoryStorage();
  const store = createProfileStore({ storage, target: null });
  assert.equal(typeof store.answerAudience, 'undefined');
  store.setDefaults({ audience: 'clinician' });
  // Survives a reload.
  assert.equal(createProfileStore({ storage, target: null }).get().defaults.audience, 'clinician');
});

test('the profile stays backward compatible and exports the audience', () => {
  const old = { version: 1, profile_id: 'p_abcdefgh1234', tracked: ['A|B'], defaults: { depth: 'expert' } };
  assert.deepEqual(normalizeProfile(old), old, 'a profile from before R3 reads exactly as before');
  const stored = createProfileStore({ storage: memoryStorage({ [PROFILE_KEY]: JSON.stringify(old) }), target: null });
  assert.deepEqual(stored.get(), old);
  assert.deepEqual(normalizeProfile({ ...old, defaults: { audience: 'nurse' }, audience_asked: 'yes' }).defaults, {}, 'unknown values are dropped');
  const withAudience = normalizeProfile({ ...old, defaults: { audience: 'procurement' }, audience_asked: true });
  assert.ok(!('audience_asked' in withAudience), 'the retired first-visit flag is dropped');
  const file = profileFile(withAudience, new Date('2026-10-20T00:00:00Z'));
  assert.equal(file.defaults.audience, 'procurement');
  const parsed = parseProfileFile(JSON.stringify(file));
  assert.equal(parsed.defaults.audience, 'procurement');
  const merged = mergeImported({ version: 1, profile_id: 'p_zzzzzzzz9999', tracked: [], defaults: {} }, parsed);
  assert.equal(merged.defaults.audience, 'procurement');
  const kept = mergeImported({ version: 1, profile_id: 'p_zzzzzzzz9999', tracked: [], defaults: { audience: 'patient' } }, parsed);
  assert.equal(kept.defaults.audience, 'patient', 'a default set here is kept');
});

test('"Your defaults" shows the preset depth and stores only an override', () => {
  assert.equal(depthChoice(undefined, 'procurement'), 'expert');
  assert.equal(depthChoice('plain', 'procurement'), '');
  assert.equal(depthChoice(undefined, null), '');
  assert.equal(depthToStore('', 'procurement'), 'plain', 'Plain over a procurement preset is an explicit choice');
  assert.equal(depthToStore('expert', 'procurement'), null, 'equal to the preset: the preset keeps deciding');
  assert.equal(depthToStore('expert', null), 'expert');
  assert.equal(depthToStore('', null), null);
  assert.deepEqual(defaultsPhrases({ audience: 'patient', depth: 'expert' }), ['Reading as Patient', 'Expert depth']);
});

// --------------------------------------------------------------- real backend

let store;
let backend;
let client;

before(async () => {
  store = copyStore();
  backend = await startTestBackend({ db: store.path });
  client = apiClient(backend.origin);
});
after(async () => {
  await backend?.stop();
  store?.dispose();
});

test('getConceptSubgroups answers in one request, as the contract says', async () => {
  const meta = await client.getMeta();
  assert.equal(meta.subgroup_difference.min_delta, 0.05);
  assert.equal(meta.subgroup_difference.requires_ci_separation, true);
  const answer = await client.getConceptSubgroups({ model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', conceptId: '5A11' });
  assert.deepEqual(schemaErrors('getConceptSubgroups', answer), []);
  assert.equal(answer.groups.length, 11);
  const concept = await client.getConceptMetrics({ model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', conceptId: '5A11', age: 'Age 65+' });
  const older = answer.groups.find((group) => group.group === 'Age 65+');
  assert.equal(older.perf, concept.metrics.perf);
  assert.deepEqual(older.status, concept.metrics.status);
  const model = acrossGroupsModel(answer, { depth: 'expert', currentLens: older.lens });
  assert.equal(model.groups.flatMap((group) => group.rows).filter((row) => row.flag).length, answer.groups.filter((group) => group.difference.flagged).length);
  await assert.rejects(client.getConceptSubgroups({ model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', conceptId: 'NOPE' }), (error) => error.code === 'unknown_concept');
});

test('another classification is named last and keys the subgroup read (contract v1.13, §23)', async () => {
  const MONDO = { id: 'mondo', name: 'MONDO' };
  assert.equal(resultPopulationLabel(ALL, null, { ontology: MONDO }), 'All patients, default prevalence, MONDO');
  assert.equal(resultPopulationLabel(ALL, null, { ontology: { id: 'icd11', name: 'ICD-11' } }), 'All patients, default prevalence');
  const filters = { model: 'M', useCase: 'U', age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities', ontology: 'mondo' };
  const query = conceptSubgroupsQuery(filters, 'MONDO:0005015');
  assert.notEqual(query.key, conceptSubgroupsQuery({ ...filters, ontology: null }, 'MONDO:0005015').key);
  assert.equal(conceptSubgroupsQuery({ ...filters, ontology: 'icd11' }, '5A11').key, conceptSubgroupsQuery({ ...filters, ontology: null }, '5A11').key);
  const calls = [];
  await query.fetch({ getConceptSubgroups: (params) => calls.push(params) }, {});
  assert.deepEqual(calls, [{ model: 'M', useCase: 'U', conceptId: 'MONDO:0005015', ontology: 'mondo' }]);
  const spec = JSON.parse(readFileSync(new URL('../backend/openapi.json', import.meta.url), 'utf8'));
  const operation = spec.paths['/metrics/concepts/{concept_id}/subgroups'].get;
  assert.ok(operation.parameters.some((param) => param.$ref === '#/components/parameters/Ontology'));
  assert.ok(operation.responses['200'].headers['X-Ontology']);
  assert.ok(spec.components.schemas.ConceptSubgroups.properties.mapping);
});
