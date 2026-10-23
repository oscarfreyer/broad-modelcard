// Fixes of the frontend review before release (2026-10-20): reads that are
// aborted are never cached as answers. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { singlesQuery } from '../frontend/src/api/queryKeys.js';
import { LOCAL_RESULT_NOTE, buildConceptCardFile, cardFileStem } from '../frontend/src/features/details/conceptCardExport.js';
import { withCompareDefaults } from '../frontend/src/app/profileDefaults.js';
import { parseCompareState } from '../frontend/src/features/compare/compareState.js';
import { parseCatalogueState } from '../frontend/src/features/catalogue/catalogueState.js';
import { siteNavItems } from '../frontend/src/design/siteNav.js';
import { lookupBody, readPanelInputs } from '../frontend/src/embed/panelInputs.js';
import { errorKind } from '../frontend/src/embed/panelController.js';
import { populationLine } from '../frontend/src/embed/panelView.js';
import { PRESETS, caseFromPreset, embedSnippet, panelAttributes } from '../frontend/src/features/plugin/pluginCase.js';

const FILTERS = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };
const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

test('the single rows of a combination: a failed read is a missing row, an aborted read aborts the set', async () => {
  assert.equal(singlesQuery(FILTERS, ['5A11']), null, 'one condition has no combination');
  const query = singlesQuery(FILTERS, ['5A11', 'BA00']);
  const failing = {
    getConceptMetrics: async ({ conceptId }) => {
      if (conceptId === 'BA00') throw Object.assign(new Error('Unknown concept'), { code: 'unknown_concept' });
      return { metrics: { concept_id: conceptId } };
    }
  };
  assert.deepEqual(await query.fetch(failing, {}), { '5A11': { concept_id: '5A11' }, BA00: null });

  const controller = new AbortController();
  const aborting = {
    getConceptMetrics: async ({ conceptId }) => {
      if (conceptId === 'BA00') {
        controller.abort();
        throw abortError();
      }
      return { metrics: { concept_id: conceptId } };
    }
  };
  await assert.rejects(query.fetch(aborting, { signal: controller.signal }), { name: 'AbortError' });
});

test('useClientQuery caches an answer only when its read was not aborted', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../frontend/src/api/useClientQuery.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!controller\.signal\.aborted\) \{\s*cache\.set\(key, data\);/);
});

// ------------------------------------------------------------------ state across pages

test('a comparison link that names only the cards takes the reader\'s defaults; one naming its context opens that', () => {
  const cards = 'SynGPT-2.0|Clinician Facing CDSS,ICU_GPT-1.0|CDSS';
  const defaults = { lens: { age: 'Age 65+' }, population: 'northbridge-region', ontology: 'mondo', depth: 'expert' };
  const entry = `?cards=${cards}`;
  const filled = withCompareDefaults(parseCompareState(entry), entry, defaults);
  assert.deepEqual([filled.lens.age, filled.lens.sex, filled.population, filled.ontology], ['Age 65+', 'All sexes', 'northbridge-region', 'mondo']);
  const shared = `?cards=${cards}&sex=Sex+Female`;
  const exact = withCompareDefaults(parseCompareState(shared), shared, defaults);
  assert.deepEqual([exact.lens.age, exact.lens.sex, exact.population, exact.ontology], ['All ages', 'Sex Female', null, null]);
});

test('the comparison\'s way back to the catalogue keeps its cards chosen', () => {
  const items = siteNavItems('compare', { isStatic: false, hrefs: { catalogue: './?compare=a|b,c|d' } });
  assert.equal(items.find((page) => page.id === 'catalogue').href, './?compare=a|b,c|d');
  assert.equal(items.find((page) => page.id === 'admin').href, './admin.html');
  assert.deepEqual(parseCatalogueState('?compare=a|b,c|d').compare, ['a|b', 'c|d']);
});

test('the live panel looks a case up at a local prevalence the host names, as the atlas does', () => {
  const attributes = { model: 'ICU_GPT-1.0', 'use-case': 'CDSS', codes: '1C45', population: 'northbridge-region' };
  const inputs = readPanelInputs((name) => attributes[name] ?? null);
  assert.equal(inputs.population, 'northbridge-region');
  assert.equal(lookupBody(inputs).context.population_id, 'northbridge-region');
  assert.equal(populationLine(inputs), 'All patients, local prevalence');
  const none = readPanelInputs((name) => ({ ...attributes, population: 'Not An Id!' })[name] ?? null);
  assert.equal(none.population, null, 'a malformed id is left out');
  assert.equal('population_id' in lookupBody(none).context, false, 'the default prevalence sends no id');
  assert.equal(errorKind({ code: 'unknown_population', status: 404 }), 'unknown_population');
  const current = { ...caseFromPreset(PRESETS[0], 'plain', 'northbridge-region') };
  assert.equal(panelAttributes(current).population, 'northbridge-region');
  assert.match(embedSnippet(current), /population="northbridge-region"/);
  assert.equal(panelAttributes(caseFromPreset(PRESETS[0])).population, undefined);
});

// ------------------------------------------------------------------ condition card exports

const ALL = { context: 'Clinical', age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };
const exportOf = (row, extra = {}) => ({
  exported_at: '2026-10-20T00:00:00Z',
  audience_view: 'patient',
  concept: { code: '5A11', block: 'BLK', name: 'Type 2 diabetes mellitus', hierarchy: [] },
  context: { model: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS', population: ALL },
  model_card: row,
  warnings: [],
  safeguards: [],
  synthetic_data_notice: 'Synthetic.',
  ...extra
});

test('an export of a card without an intended-use statement says what the card says', () => {
  const row = { perf: 0.6, overall: { tier: 'out_of_scope' }, status: { overall: 'out_of_scope', performance: 'weak', evidence: 'weak' }, intended_use_level: 'out_of_scope', provenance: { source: 'condition' } };
  const stated = buildConceptCardFile(exportOf(row));
  assert.equal(stated.model_card.statuses.overall, 'Out of scope');
  const none = buildConceptCardFile(exportOf(row), { hasIntendedUse: false });
  assert.equal(none.model_card.statuses.overall, 'No data', 'nothing is out of scope without a statement');
  assert.equal(none.model_card.intended_use, 'No statement');
  assert.equal(none.context.use_case, 'Clinician-Facing CDSS', 'the function in UI words');
  assert.equal(cardFileStem(none), '5a11-condition-card', "a condition card, never the AI system's model card");
});

test('an export without a row is a file of No data, not an error', () => {
  const card = buildConceptCardFile(exportOf(null));
  assert.deepEqual(Object.values(card.model_card.statuses), ['No data', 'No data', 'No data']);
  assert.equal(card.model_card.details.performance_value, null);
});

test('an export of a local result carries the public result it replaces; a public one carries none', () => {
  const local = { perf: 0.63, overall: { tier: 'graded', score: 0.63, grade: 'D' }, status: { overall: 'weak', performance: 'weak', evidence: 'strong' }, provenance: { source: 'condition', layer: 'local' } };
  const publicRow = { perf: 0.83, overall: { tier: 'graded', score: 0.83, grade: 'B' }, status: { overall: 'strong', performance: 'strong', evidence: 'strong' }, provenance: { source: 'condition', data_source: { source: 'Seed' } } };
  const card = buildConceptCardFile(exportOf(local), { publicMetrics: publicRow });
  assert.equal(card.local_result.note, LOCAL_RESULT_NOTE);
  assert.equal(card.local_result.public_result.statuses.overall, 'Strong');
  assert.equal(card.local_result.public_result.details.performance_value, 0.83);
  assert.equal(buildConceptCardFile(exportOf(publicRow)).local_result, undefined);
});

test('an export in another classification credits it and the WHO mapping tables', () => {
  const entry = {
    id: 'mondo',
    name: 'MONDO',
    attribution: 'Mondo Disease Ontology, Monarch Initiative',
    licence: 'CC BY 4.0',
    sources: [{ id: 'who-mapping', attribution: 'WHO ICD-10 to ICD-11 mapping tables', licence: 'CC BY-ND 3.0 IGO (used unmodified at import)' }]
  };
  const row = { perf: 0.8, status: {}, overall: {}, provenance: { source: 'condition' } };
  const card = buildConceptCardFile(exportOf(row, { ontology: { id: 'mondo', name: 'MONDO' } }), { ontologyEntry: entry });
  assert.match(card.concept.classification.attribution, /Mondo Disease Ontology, Monarch Initiative, CC BY 4\.0\. Mappings: WHO .*CC BY-ND 3\.0 IGO, used unmodified\./);
});
