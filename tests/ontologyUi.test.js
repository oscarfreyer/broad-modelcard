// The classification the atlas is drawn in (contract v1.13, CONTRACT.md §23): the `ontology` read parameter through the data client and
// its query keys, the URL and profile state, the No mapping mark, the legend,
// Summary, search marks, and condition card copy, the Classification choice
// in the toolbar, and a real backend on a private store with the backend's
// fixture ontologies (made-up stand-ins for ICD-10-CM and MONDO).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { createDataClient } from '../frontend/src/api/dataClient.js';
import { chapterQueryKey, conceptMetricsQuery, filtersKey, metricParams } from '../frontend/src/api/queryKeys.js';
import { withProfileDefaults } from '../frontend/src/app/profileDefaults.js';
import { parseStartupParams } from '../frontend/src/app/startupParams.js';
import StatusMark, { markShapes } from '../frontend/src/design/StatusMark.js';
import { ABSENCE_MEANING, ABSENCE_ORDER, DISPLAY, keysForView, mapRowStatus, ringKeyEntries, ringStatus } from '../frontend/src/design/status.js';
import { legendKeys, legendMeaning } from '../frontend/src/features/atlas/legendEntries.js';
import { chapterIconKey, chapterNumberLabel, chapterShortLabel } from '../frontend/src/features/atlas/layout/chapterLabels.js';
import { ONTOLOGY_CHAPTER_ICONS } from '../frontend/src/features/atlas/layout/ontologyChapters.js';
import { CHAPTER_ICONS } from '../frontend/src/design/chapterIcons.js';
import { aboutResult } from '../frontend/src/features/details/copy/aboutResult.js';
import { buildConceptCardFile } from '../frontend/src/features/details/conceptCardExport.js';
import { defaultsFromView, defaultsPhrases } from '../frontend/src/features/profile/defaultsModel.js';
import { normalizeDefaults } from '../frontend/src/features/profile/profile.js';
import { searchResultStatus } from '../frontend/src/features/search/searchMarks.js';
import { deriveHighlights, groupStatusCounts } from '../frontend/src/features/summary/summaryHighlights.js';
import { conceptCode } from '../frontend/src/shared/conceptName.js';
import {
  ICD11,
  mappedShare,
  mappingDetail,
  mappingSentence,
  ontologyAttribution,
  ontologyDescription,
  ontologyList,
  ontologyNotice
} from '../frontend/src/shared/ontology.js';
import { pythonPath } from '../scripts/backendServer.mjs';
import { schemaErrors } from './support/openapiSchema.js';
import { apiClient, copyStore, startTestBackend } from './support/backend.js';

const SRC = fileURLToPath(new URL('../frontend/src/', import.meta.url));
const read = (relative) => readFileSync(path.join(SRC, relative), 'utf8');
const FILTERS = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };

const MONDO = {
  id: 'mondo',
  name: 'MONDO',
  release: 'v2026-10-06',
  licence: 'CC BY 4.0',
  attribution: 'Mondo Disease Ontology, Monarch Initiative',
  is_default: false,
  counts: { chapters: 27, blocks: 285, conditions: 3039, concepts: 22970 },
  mapping_counts: { exact: 407, stem: 5, block: 20, parent: 1311, none: 1296 },
  sources: [{ id: 'who-mapping', release: '2026-01', licence: 'CC BY-ND 3.0 IGO', attribution: 'ICD-10 to ICD-11 mapping tables, World Health Organization' }]
};

// ----------------------------------------------------------- data client

const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function mockClient() {
  const requests = [];
  const fetchMock = async (input, init = {}) => {
    const url = new URL(input, 'http://localhost');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), init });
    return json({});
  };
  return { client: createDataClient(createApiAdapter({ fetch: fetchMock })), last: () => requests.at(-1) };
}

const READS = {
  getAtlasOverview: (client, ontology) => client.getAtlasOverview({ ontology }),
  getChapter: (client, ontology) => client.getChapter({ chapterId: 'MONDO:0005066', ontology }),
  getMetricMap: (client, ontology) => client.getMetricMap({ ...FILTERS, scope: 'atlas', ontology }),
  getMetricSummary: (client, ontology) => client.getMetricSummary({ ...FILTERS, view: 'evidence', ontology }),
  getConceptMetrics: (client, ontology) => client.getConceptMetrics({ ...FILTERS, conceptId: 'MONDO:0005015', ontology }),
  searchConcepts: (client, ontology) => client.searchConcepts({ q: 'diabetes', ontology }),
  exportConcept: (client, ontology) => client.exportConcept({ ...FILTERS, conceptId: 'E11', ontology })
};

test('the atlas reads send ontology only for another classification than ICD-11', async () => {
  const { client, last } = mockClient();
  for (const [operationId, readOp] of Object.entries(READS)) {
    for (const none of [undefined, null, ICD11]) {
      await readOp(client, none);
      assert.equal('ontology' in last().query, false, `${operationId}: ICD-11 sends nothing (${none})`);
    }
    await readOp(client, 'mondo');
    assert.equal(last().query.ontology, 'mondo', operationId);
  }
  await client.getChapter({ chapterId: 'MONDO:0005066', ontology: 'mondo' });
  assert.equal(last().path, '/api/v1/atlas/chapters/MONDO%3A0005066');
});

test('query keys carry the classification only when it is not ICD-11', () => {
  assert.equal(filtersKey(FILTERS), 'SynGPT-2.0|Clinician Facing CDSS|All ages|All sexes|All ethnicities');
  assert.equal(filtersKey({ ...FILTERS, ontology: ICD11 }), filtersKey(FILTERS));
  assert.equal(filtersKey({ ...FILTERS, population: 'p', ontology: 'mondo' }), `${filtersKey(FILTERS)}|population:p|ontology:mondo`);
  assert.deepEqual(Object.keys(metricParams({ ...FILTERS, ontology: ICD11 })), ['model', 'useCase', 'age', 'sex', 'ethnicity']);
  assert.equal(metricParams({ ...FILTERS, ontology: 'icd10cm' }).ontology, 'icd10cm');
  assert.equal(chapterQueryKey('CH-05'), 'chapter|CH-05');
  assert.equal(chapterQueryKey('CM-CH-04', null, 'icd10cm'), 'chapter|CM-CH-04|ontology:icd10cm');
  assert.notEqual(conceptMetricsQuery(FILTERS, 'E11').key, conceptMetricsQuery({ ...FILTERS, ontology: 'icd10cm' }, 'E11').key);
});

// ------------------------------------------------------------ URL, profile

test('a link and the profile choose the classification; a shared link opens exactly what it names', () => {
  const opened = withProfileDefaults(parseStartupParams('?model=SynGPT-2.0'), { ontology: 'mondo', depth: 'expert' });
  assert.equal(opened.ontology, 'mondo');
  assert.ok(opened.appliedDefaults.includes('ontology'));
  const shared = withProfileDefaults(parseStartupParams('?model=SynGPT-2.0&view=overall'), { ontology: 'mondo' });
  assert.equal(shared.ontology, null, 'a state URL names no classification, so it opens ICD-11 for every reader');
  assert.deepEqual(normalizeDefaults({ ontology: 'mondo' }), { ontology: 'mondo' });
  assert.deepEqual(normalizeDefaults({ ontology: ICD11 }), {}, 'ICD-11 is the default, never stored');
  assert.deepEqual(normalizeDefaults({ ontology: '../x' }), {});
  assert.equal(defaultsFromView({ ...FILTERS, ontology: 'icd10cm' }, null).ontology, 'icd10cm');
  assert.deepEqual(defaultsPhrases({ ontology: 'mondo' }, { ontologies: [MONDO] }), ['Classification: MONDO']);
});

// ---------------------------------------------------------- No mapping mark

test('No mapping is its own absence mark in the grey family, on every view', () => {
  assert.deepEqual(DISPLAY.no_mapping, { label: 'No mapping', form: 'slashed', tone: 'absent' });
  assert.ok(ABSENCE_ORDER.includes('no_mapping'));
  assert.ok(ABSENCE_MEANING.no_mapping.length <= 34, 'the legend line fits at 16rem');
  const forms = new Set(Object.entries(DISPLAY).filter(([key]) => key !== 'no_mapping').map(([, display]) => display.form));
  assert.ok(!forms.has('slashed'), 'no other state shares its shape');
  const shapes = markShapes('no_mapping', { cx: 6, cy: 6, r: 5 });
  assert.equal(shapes[0].props.className, 'mark mark-slashed tone-absent');
  assert.match(shapes[1].props.transform, /^rotate\(-45 6 6\)$/, 'a diagonal, never the horizontal bar of Out of scope');
  assert.match(renderToStaticMarkup(createElement(StatusMark, { status: 'no_mapping' })), /mark-slashed[\s\S]*mark-glyph-slash/);
  const marks = readFileSync(new URL('../frontend/src/styles/marks.css', import.meta.url), 'utf8');
  assert.match(marks, /\.mark-slashed \{[^}]*fill: var\(--mark-outline-fill\)/);
  assert.match(marks, /\.strip-slashed \{/);

  const unmapped = { concept_id: 'E12', mapping: 'none', overall_status: 'no_data', performance_status: 'no_data', evidence_status: 'no_data', safety: null };
  for (const view of ['overall', 'performance', 'evidence', 'intended_use', 'safety']) {
    assert.equal(mapRowStatus(unmapped, view), 'no_mapping', view);
  }
  assert.equal(ringStatus(unmapped, 'overall', { isLoading: true }), 'loading');
  assert.equal(mapRowStatus({ ...unmapped, mapping: 'exact' }, 'overall'), 'no_data', 'a mapped condition without a row is No data');
  assert.equal(mapRowStatus({ ...unmapped, mapping: undefined }, 'overall'), 'no_data', 'ICD-11 rows carry no mapping');
  const key = ringKeyEntries({ tiles: [{ concept_id: 'E12' }], rowsById: new Map([['E12', unmapped]]), viewId: 'overall' });
  assert.deepEqual(key.absences, ['no_mapping']);
});

test('the legend lists No mapping in another classification, last, with its meaning', () => {
  assert.deepEqual(keysForView('performance', { withMapping: true }), ['strong', 'moderate', 'weak', 'no_data', 'no_mapping']);
  assert.deepEqual(legendKeys({ viewId: 'overall', withMapping: true }), ['serious', 'caution', 'strong', 'moderate', 'weak', 'out_of_scope', 'no_data', 'no_mapping']);
  assert.deepEqual(legendKeys({ viewId: 'safety', withMapping: true }), ['serious', 'caution', 'no_incidents', 'no_mapping']);
  assert.deepEqual(legendKeys({ viewId: 'performance' }), ['strong', 'moderate', 'weak', 'no_data'], 'ICD-11 is unchanged');
  assert.equal(legendMeaning('no_mapping'), 'no ICD-11 match, so no result');
  const legend = read('features/atlas/RingLegend.jsx');
  assert.match(legend, /withMapping: Boolean\(ontology\)/);
  assert.match(legend, /ontologyNotice\(ontology\)/, 'the classification is named next to the synthetic-data notice');
});

test('Summary counts No mapping apart from No data and says where it concentrates', () => {
  const mapped = (id) => [id, { concept_id: id, mapping: 'exact', overall_status: 'strong', performance_status: 'strong', evidence_status: 'strong' }];
  const unmapped = (id) => [id, { concept_id: id, mapping: 'none', overall_status: 'no_data', performance_status: 'no_data', evidence_status: 'no_data' }];
  const conditions = ['A', 'B', 'C', 'D', 'E'].map((id, index) => ({ concept_id: id, chapter_id: index < 3 ? 'C1' : 'C2' }));
  const rows = new Map([mapped('A'), unmapped('B'), unmapped('C'), mapped('D'), mapped('E')]);
  const groups = groupStatusCounts(conditions, rows, 'performance', (concept) => concept.chapter_id, { C1: 'One', C2: 'Two' });
  const counts = groups.reduce((sum, group) => {
    Object.entries(group.counts).forEach(([key, value]) => {
      sum[key] = (sum[key] ?? 0) + value;
    });
    return sum;
  }, {});
  assert.deepEqual(counts, { strong: 3, no_mapping: 2 });
  const highlights = deriveHighlights({ viewId: 'performance', total: 5, counts, groups, withMapping: true });
  const card = highlights.find((item) => item.tone === 'no_mapping');
  assert.match(card.title, /^No mapping for 2 conditions$/);
  assert.equal(card.text, 'All in One.');
  // When most conditions have no mapping, the lead says so.
  const lead = deriveHighlights({ viewId: 'performance', total: 5, counts: { strong: 1, no_mapping: 4 }, groups, withMapping: true })[0];
  assert.match(lead.title, /^No mapping for 80% of conditions$/);
  assert.ok(highlights[0].strip.keys.includes('no_mapping'), 'the strip shows it');
  const ringSummary = read('features/summary/useRingSummary.js');
  assert.match(ringSummary, /const fromMap = isOverview \|\| withMapping;/, 'every view counts the map rows in another classification');
});

// ------------------------------------------------------------ chapters

test('other classifications take their icons from a hand-written table and labels from their titles', () => {
  for (const [chapterId, icon] of Object.entries(ONTOLOGY_CHAPTER_ICONS)) {
    assert.ok(CHAPTER_ICONS[icon], `${chapterId} → ${icon} is a vendored icon`);
  }
  // Every chapter the importer can make has an icon: ICD-10-CM's disease chapters and the MONDO chapter table.
  const mondo = readFileSync(new URL('../backend/app/ontologies/mondo.py', import.meta.url), 'utf8');
  const table = mondo.slice(mondo.indexOf('CHAPTERS: tuple[str, ...] = ('), mondo.indexOf('MAX_DEPTH'));
  const mondoChapters = [...table.matchAll(/"(MONDO:\d+)",/g)].map((match) => match[1]);
  assert.equal(mondoChapters.length, 27);
  const cmChapters = [...Array(17).keys()].map((index) => `CM-CH-${String(index + 1).padStart(2, '0')}`).concat('CM-CH-19');
  assert.deepEqual(Object.keys(ONTOLOGY_CHAPTER_ICONS).sort(), [...cmChapters, ...mondoChapters].sort());
  assert.equal(chapterIconKey({ concept_id: 'CM-CH-04', chapter_no: '04' }), '05', 'ICD-10-CM chapter 4 is endocrine, ICD-11 chapter 05');
  assert.equal(chapterIconKey({ concept_id: 'CH-04', chapter_no: '04' }), '04');
  assert.equal(chapterIconKey({ chapter_no: '04' }), '04', 'a chapter without an id counts as ICD-11');
  assert.equal(chapterShortLabel({ concept_id: 'CM-CH-04', chapter_no: '04', pt: 'Endocrine, nutritional and metabolic diseases' }), 'Endocrine Nutritional');
  assert.equal(chapterShortLabel({ concept_id: 'MONDO:0045024', chapter_no: '01', pt: 'Cancer or benign tumor' }), 'Cancer Benign');
  assert.equal(chapterShortLabel({ concept_id: 'CH-02', chapter_no: '02', pt: '02 Neoplasms' }), 'Neoplasms', 'authored ICD-11 names stay');
  assert.equal(chapterNumberLabel({ concept_id: 'CM-CH-04', chapter_no: '04' }), 'Chapter 4');
  assert.equal(chapterNumberLabel({ concept_id: 'MONDO:0045024', chapter_no: '01' }), null, 'MONDO has no chapter numbers');
  assert.equal(conceptCode({ concept_id: 'MONDO:0045024', level: 0, chapter_no: '01' }, { isExpert: true }), null);
  assert.equal(conceptCode({ concept_id: 'E11.9', icd11_code: null, code: 'E11.9', level: 2 }), 'E11.9');
});

// -------------------------------------------------- search, card, export

test('search marks in another classification never borrow a subtype’s condition row', () => {
  const atlasRows = new Map([['E11', { concept_id: 'E11', overall_status: 'strong' }]]);
  const subtype = { concept_id: 'E11.9', level: 2, depth_in_kind: 2, metric_anchor_id: 'E11', chapter_id: 'CM-CH-04' };
  assert.equal(searchResultStatus(subtype, { atlasRows }, 'overall'), 'strong', 'ICD-11: a subtype shares its condition');
  assert.equal(searchResultStatus(subtype, { atlasRows }, 'overall', { ownRows: true }), null, 'no mark rather than a wrong one');
  const chapterRows = new Map([['E11.9', { concept_id: 'E11.9', mapping: 'none' }]]);
  assert.equal(searchResultStatus(subtype, { atlasRows, chapterRows, chapterId: 'CM-CH-04' }, 'overall', { ownRows: true }), 'no_mapping');
});

test('the condition card names the mapping in one line; No mapping says why there is no result', () => {
  const exact = { kind: 'exact', icd11: { concept_id: '5A11', code: '5A11', pt: 'Type 2 diabetes mellitus', level: 2 }, via: null, steps: null, source: 'who-icd10-icd11', source_code: 'E11', icd11_code: '5A11' };
  assert.equal(mappingSentence(exact, 'ICD-10-CM'), 'Mapped from ICD-11 5A11 Type 2 diabetes mellitus.');
  const parent = { ...exact, kind: 'parent', via: { concept_id: 'MONDO:1', pt: 'Diabetes mellitus' }, steps: 2, source: 'mondo-icd11-foundation', source_code: '123' };
  assert.equal(mappingSentence(parent, 'MONDO'), 'Through MONDO parent Diabetes mellitus: mapped from ICD-11 5A11 Type 2 diabetes mellitus.');
  const block = { ...exact, kind: 'block', icd11: { concept_id: 'BLK-05-BlockL1-5A0', code: null, pt: 'Endocrine diseases', level: 1 }, icd11_code: '5A0Q' };
  assert.equal(mappingSentence(block, 'ICD-10-CM'), 'Mapped from the ICD-11 subchapter Endocrine diseases.');
  const none = { kind: 'none', icd11: null, via: null, steps: null, source: null, source_code: null, icd11_code: null };
  assert.equal(mappingSentence(none, 'MONDO'), 'No ICD-11 mapping, so no result is shown.');
  assert.equal(mappingSentence(null, 'MONDO'), null);
  assert.match(mappingDetail(parent), /MONDO cross-reference to the ICD-11 Foundation \(123 → 5A11\); inherited 2 steps up/);
  assert.match(mappingDetail(block), /matched in the atlas by the subchapter of its code/);

  const concept = { concept_id: 'MONDO:9', pt: 'Rare thing', level: 2 };
  const plain = aboutResult({ concept, row: null, depth: 'plain', ontology: MONDO, mapping: none });
  assert.match(plain[0], /no counterpart in ICD-11/);
  const row = { provenance: { source: 'condition', lens_fallback: false } };
  assert.match(aboutResult({ concept, row, depth: 'plain', ontology: MONDO, mapping: exact })[0], /Shows the result of the ICD-11 condition it maps to/);
  assert.match(aboutResult({ concept, row, depth: 'expert', ontology: MONDO, mapping: parent }).join(' '), /Mapped result[\s\S]*Stored condition-level row/);

  const card = read('features/details/DetailCard.jsx');
  assert.match(card, /headerStatus = 'no_mapping'/);
  assert.match(card, /mappingSentence\(mapping, ontology\.name\)/);
  assert.match(card, /depth === 'expert' && otherParents\.length/, 'other parents at expert depth');
});

test('exports name the classification and the mapping', () => {
  const conceptExport = {
    exported_at: '2026-10-20T00:00:00.000Z',
    audience_view: 'expert',
    dataset_version: '1',
    synthetic_data_notice: 'Synthetic.',
    concept: { code: 'E11', block: 'E08-E13', name: 'Type 2 diabetes mellitus', hierarchy: ['Endocrine', 'Diabetes mellitus', 'Type 2 diabetes mellitus'], mapping: { kind: 'exact', icd11: { concept_id: '5A11', code: '5A11', pt: 'Type 2 diabetes mellitus', level: 2 } } },
    context: { model: 'M', use_case: 'U', population: { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' } },
    model_card: { perf: 0.8, provenance: { source: 'condition' }, status: {}, overall: {} },
    warnings: [],
    safeguards: [],
    ontology: { id: 'icd10cm', name: 'ICD-10-CM' }
  };
  const file = buildConceptCardFile(conceptExport);
  assert.equal(file.concept.classification.name, 'ICD-10-CM');
  assert.equal(file.concept.classification.mapping, 'Mapped from ICD-11 5A11 Type 2 diabetes mellitus.');
  assert.match(file.concept.classification.note, /results are mapped from ICD-11/);
  assert.equal(buildConceptCardFile({ ...conceptExport, ontology: undefined }).concept.classification, undefined, 'ICD-11 exports are unchanged');
});

// ------------------------------------------------------ the toolbar choice

test('the Classification choice: shown only when the data holds more than ICD-11, credits every source', () => {
  const toolbar = read('features/toolbar/Toolbar.jsx');
  assert.match(toolbar, /\(selection\.ontologies\?\.length \?\? 0\) > 1 \? \(\s*<ClassificationPopover/);
  const popover = read('features/toolbar/ClassificationPopover.jsx');
  assert.match(popover, /aria-label=\{`Classification: \$\{active\.name\}`\}/);
  assert.match(popover, /ontologyAttribution\(entry\)/);
  assert.match(popover, /store\.setDefaults\(\{ ontology: isOther \? active\.id : null \}\)/, 'the choice can become the default');
  assert.deepEqual(ontologyList({}), ontologyList({ ontologies: [] }));
  assert.equal(ontologyList({}).length, 1, 'older data: ICD-11 alone, so the choice stays hidden');
  assert.equal(mappedShare(MONDO), 57);
  assert.match(ontologyDescription(MONDO), /^3,039 conditions; 57% show an ICD-11 result, some through a parent\. The others read No mapping\.$/);
  assert.match(ontologyDescription({ id: ICD11, counts: { conditions: 2400 } }), /^The standard: every result is stored in ICD-11\. 2,400 conditions\.$/);
  assert.equal(ontologyAttribution(MONDO), 'Mondo Disease Ontology, Monarch Initiative, CC BY 4.0.');
  assert.equal(ontologyAttribution({ ...MONDO, licence: 'Public domain (US CDC, NCHS)' }), 'Mondo Disease Ontology, Monarch Initiative, Public domain.');
  assert.equal(ontologyNotice(MONDO), 'Shown in MONDO; results are mapped from ICD-11.');
  assert.equal(ontologyNotice({ id: ICD11 }), '');
  // Multimorbidity is ICD-11 only; the ring pane says why.
  assert.match(read('features/atlas/RingPane.jsx'), /disabled: true, reason: NO_COMBINATIONS_TEXT/);
  assert.match(read('app/AtlasApp.jsx'), /dispatch\(\{ type: 'switchClassification' \}\)/);
  // A link's classification reaches the selection (the URL and the profile default open it).
  assert.match(read('app/AtlasApp.jsx'), /useModelSelection\(\{[^}]*ontology: startup\.ontology/);
});

// --------------------------------------------------------- real backend

let store;
let backend;
let client;
let fixtureRoot;

before(async () => {
  store = copyStore();
  fixtureRoot = mkdtempSync(path.join(tmpdir(), 'bmc-ontology-sources-'));
  const backendDir = fileURLToPath(new URL('../backend/', import.meta.url));
  const code = [
    'import sys',
    `sys.path[:0] = [${JSON.stringify(backendDir)}, ${JSON.stringify(path.join(backendDir, 'tests'))}]`,
    'from pathlib import Path',
    'from ontology_fixtures import import_fixture_ontologies',
    'import_fixture_ontologies(Path(sys.argv[1]), Path(sys.argv[2]))'
  ].join('\n');
  const result = spawnSync(pythonPath(), ['-I', '-c', code, store.path, fixtureRoot], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  backend = await startTestBackend({ db: store.path });
  client = apiClient(backend.origin);
});
after(async () => {
  await backend?.stop();
  store?.dispose();
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

test('every classification reads through the client in the contract shape (real backend, fixture ontologies)', async () => {
  const meta = await client.getMeta();
  assert.deepEqual(meta.ontologies.map((entry) => entry.id), ['icd11', 'icd10cm', 'mondo']);
  for (const ontology of ['icd10cm', 'mondo']) {
    const overview = await client.getAtlasOverview({ ontology });
    assert.deepEqual(schemaErrors('getAtlasOverview', overview), []);
    assert.equal(overview.ontology.id, ontology);
    const chapterId = overview.chapters[0].concept_id;
    assert.deepEqual(schemaErrors('getChapter', await client.getChapter({ chapterId, ontology })), []);
    const map = await client.getMetricMap({ ...FILTERS, scope: 'atlas', ontology });
    assert.deepEqual(schemaErrors('getMetricMap', map), []);
    assert.equal(map.mapping.length, map.rows.length);
    const summary = await client.getMetricSummary({ ...FILTERS, view: 'overall', ontology });
    assert.deepEqual(schemaErrors('getMetricSummary', summary), []);
    assert.ok(summary.mapping_counts.none > 0);
    const found = await client.searchConcepts({ q: 'diabetes', ontology });
    assert.deepEqual(schemaErrors('searchConcepts', found), []);
    const concept = await client.getConceptMetrics({ ...FILTERS, conceptId: found.results.at(-1).concept_id, ontology });
    assert.deepEqual(schemaErrors('getConceptMetrics', concept), []);
  }
  const unmapped = await client.getConceptMetrics({ ...FILTERS, conceptId: 'E12', ontology: 'icd10cm' });
  assert.equal(unmapped.metrics, null);
  assert.equal(unmapped.mapping.kind, 'none');
  await assert.rejects(client.getAtlasOverview({ ontology: 'snomed' }), { status: 404, code: 'unknown_ontology' });
  // ICD-11 reads name no classification.
  const icd11 = await client.getAtlasOverview({});
  assert.equal('ontology' in icd11, false);
});
