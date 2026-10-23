import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DATA_CLIENT_METHODS,
  DATA_CLIENT_OPERATIONS,
  DataClientError,
  createDataClient
} from '../frontend/src/api/dataClient.js';
import { decodeMetricMap } from '../frontend/src/features/atlas/decodeMetricMap.js';

const readJson = (relativePath) => JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));

const spec = readJson('../backend/openapi.json');
const contract = readFileSync(new URL('../backend/CONTRACT.md', import.meta.url), 'utf8');
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  HTTP_METHODS.filter((method) => item[method]).map((method) => ({ path, method, op: item[method] }))
);

function resolveRef(ref) {
  assert.ok(ref.startsWith('#/'), `only local refs are allowed: ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => (node == null ? undefined : node[key]), spec);
}

function collectRefs(node, refs = []) {
  if (Array.isArray(node)) node.forEach((item) => collectRefs(item, refs));
  else if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string') refs.push(node.$ref);
    Object.values(node).forEach((value) => collectRefs(value, refs));
  }
  return refs;
}

const paramNames = (op) => (op.parameters ?? []).map((p) => (p.$ref ? resolveRef(p.$ref) : p).name);

test('contract is OpenAPI 3.1 and every $ref resolves', () => {
  assert.equal(spec.openapi, '3.1.0');
  const unresolved = collectRefs(spec).filter((ref) => resolveRef(ref) === undefined);
  assert.deepEqual(unresolved, []);
});

test('operationIds are unique and map one-to-one onto data client methods', () => {
  const ids = operations.map(({ op }) => op.operationId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate operationId');
  assert.deepEqual([...ids].sort(), Object.values(DATA_CLIENT_OPERATIONS).sort());
  assert.equal(new Set(Object.values(DATA_CLIENT_OPERATIONS)).size, DATA_CLIENT_METHODS.length);
});

test('every data read accepts a dataset version and reports the version it used', () => {
  const reads = operations.filter(({ path, method }) => method === 'get' && !path.startsWith('/admin'));
  assert.ok(reads.length >= 10);
  for (const { path, op } of reads) {
    assert.ok(paramNames(op).includes('version'), `${path} lacks the version parameter`);
    if (!path.startsWith('/export')) {
      const ok = op.responses['200'].$ref ? resolveRef(op.responses['200'].$ref) : op.responses['200'];
      assert.ok(ok.headers?.['X-Dataset-Version'], `${path} lacks X-Dataset-Version`);
    }
  }
});

test('metric-scoped reads require model and use case', () => {
  const scoped = operations.filter(({ path }) => /^\/(metrics|multimorbidity|export)\//.test(path));
  assert.ok(scoped.length >= 6);
  for (const { path, op } of scoped) {
    const names = paramNames(op);
    assert.ok(names.includes('model') && names.includes('use_case'), `${path} must take model and use_case`);
  }
});

test('metric map columns align with the row tuple definition', () => {
  const map = spec.components.schemas.MetricMap;
  const columns = map.properties.columns.const;
  assert.equal(columns[0], 'concept_id');
  assert.equal(columns.length, map.properties.rows.items.prefixItems.length);
  assert.equal(map.properties.rows.items.minItems, columns.length);
});

test('status vocabulary matches CONTRACT.md §4.5 (not_validated merged into no_data in v1.11)', () => {
  assert.deepEqual(spec.components.schemas.Status.enum, ['strong', 'moderate', 'weak', 'out_of_scope', 'no_data']);
  assert.deepEqual(spec.components.schemas.StatusCounts.required, ['strong', 'moderate', 'weak', 'out_of_scope', 'no_data']);
  assert.ok(!JSON.stringify(spec.components.schemas).includes('"not_validated"'), 'no schema names not_validated');
});

test('lens enums and row format match the seed', () => {
  // The small multimorbidity payload carries the same axes as the full metrics tables.
  const payload = readJson('../backend/seed/models/syngpt-2.0.clinician-facing-cdss.multimorbidity.metrics.json');
  const { schemas } = spec.components;
  assert.deepEqual(schemas.AgeLens.enum, payload.metric_axes.age_lens);
  assert.deepEqual(schemas.SexLens.enum, payload.metric_axes.sex_lens);
  assert.deepEqual(schemas.EthnicityLens.enum, payload.metric_axes.ethnicity_lens);
  assert.deepEqual(payload.row_format, [
    'perf',
    'ci_low',
    'ci_high',
    'evidence_grade',
    'n_samples',
    'n_sites',
    'n_studies',
    'peer_reviewed_studies',
    'validation_type',
    'in_intended_use',
    'intended_use_coverage',
    'intended_use_level',
    'warnings'
  ]);
});

test('the contract is v1.14', () => {
  assert.equal(spec.info.version, '1.14.0');
});

test('study fields, group sizes, and the group summary are additive (v1.14, CONTRACT.md §22, §24)', () => {
  const { schemas } = spec.components;
  const study = schemas.Study;
  // Optional and never null: a study without them keeps the v1.13 shape.
  for (const field of ['applicability', 'applicability_notes', 'quality_tool', 'quality_score', 'setting_category', 'configuration_id']) {
    assert.ok(study.properties[field], field);
    assert.ok(!study.required.includes(field), `${field} is optional`);
    assert.ok(!JSON.stringify(study.properties[field]).includes('null'), `${field} is never null`);
  }
  assert.deepEqual(study.properties.applicability.enum, ['low', 'high', 'unclear']);
  assert.deepEqual(study.properties.quality_tool.enum, ['probast_ai', 'appraise_ai', 'quadas_ai', 'other']);
  assert.deepEqual([study.properties.quality_score.minimum, study.properties.quality_score.maximum], [0, 100]);
  assert.deepEqual(study.properties.setting_category.enum, [
    'emergency_department', 'intensive_care', 'inpatient_ward', 'outpatient_clinic', 'primary_care', 'mixed'
  ]);
  assert.equal(study.properties.configuration_id.pattern, '^[A-Za-z0-9._-]{1,64}$');
  for (const size of ['n_samples', 'n_sites']) {
    assert.ok(schemas.SubgroupResult.required.includes(size), size);
    assert.deepEqual(schemas.SubgroupResult.properties[size].type, ['integer', 'null']);
  }
  const summary = spec.paths['/metrics/subgroups/summary'].get;
  assert.equal(summary.operationId, 'getSubgroupSummary');
  assert.deepEqual(summary.tags, ['metrics']);
  // The care setting (v1.14, §29) joined the read in phase Q3.
  assert.deepEqual(paramNames(summary), ['model', 'use_case', 'context', 'version', 'population', 'ontology']);
  assert.equal(DATA_CLIENT_OPERATIONS.getSubgroupSummary, 'getSubgroupSummary');
  assert.equal(schemas.SubgroupSummary.properties.classification_basis.const, 'icd11');
  assert.deepEqual(schemas.SubgroupSummaryGroup.required, ['axis', 'group', 'lens', 'with_result', 'no_result', 'compared', 'flagged_higher', 'flagged_lower', 'flagged']);
  assert.equal(schemas.SubgroupSummaryGroup.properties.flagged.maxItems, 5);
  assert.match(contract, /- \*\*v1\.14 \(Q2\)/);
  assert.match(contract, /getSubgroupSummary/);
});

test('studies and appraisal are additive (v1.13, CONTRACT.md §22)', () => {
  const { schemas } = spec.components;
  assert.ok(schemas.DatasetKind.enum.includes('studies'));
  assert.equal(spec.paths['/studies'].get.operationId, 'listStudies');
  assert.equal(spec.paths['/studies/{study_id}'].get.operationId, 'getStudy');
  assert.deepEqual(schemas.Study.properties.design.enum, [
    'vignette', 'simulation', 'benchmark', 'retrospective', 'prospective', 'real_world_deployment', 'randomized_trial'
  ]);
  assert.deepEqual(schemas.Study.properties.conducted_by.enum, ['developer', 'independent', 'hospital']);
  assert.deepEqual(schemas.Study.properties.risk_of_bias.enum, ['low', 'some_concerns', 'high', 'unclear']);
  // The appraisal is optional on MetricRow: a row without a linked study keeps its earlier shape.
  assert.ok(schemas.MetricRow.properties.appraisal && !schemas.MetricRow.required.includes('appraisal'));
  assert.deepEqual(schemas.Appraisal.required, ['study', 'study_adjustment', 'applied', 'terms']);
  for (const term of ['type', 'studies', 'sites', 'peer', 'size', 'base_signal', 'penalties', 'guideline_adjustment', 'risk_of_bias_adjustment', 'signal', 'grade']) {
    assert.ok(schemas.EvidenceSignalTerms.required.includes(term), term);
  }
  // The frontend explains the signal with the weights and adjustments /meta publishes.
  const meta = schemas.Meta.properties;
  assert.deepEqual(meta.evidence_signal_weights.required, ['type', 'studies', 'sites', 'peer', 'size']);
  assert.deepEqual(meta.evidence_study_adjustments.properties.risk_of_bias.required, ['low', 'some_concerns', 'high', 'unclear']);
  assert.ok(!schemas.Meta.required.includes('evidence_signal_weights'));
  assert.match(contract, /## 22\. Studies and appraisal \(v1\.13\)/);
  assert.match(contract, /\*\*\+0\.05\*\* when the reporting guideline was followed/);
  assert.match(contract, /- \*\*v1\.13 \(R1\):\*\*/);
});

test('search ranks its matches best first (v1.12, CONTRACT.md §9)', () => {
  const ok = spec.paths['/search'].get.responses['200'].description;
  assert.match(ok, /ranked best first/);
  assert.match(contract, /Since v1\.12 the matches are ranked best first/);
  assert.match(contract, /\*\*v1\.12 \(2026-10-14\)\.\*\* Search order/);
});

test('intended use is optional, with its own score weights (v1.11, CONTRACT.md §4.1, §4.4, §11.1)', () => {
  const { schemas } = spec.components;
  const useCase = schemas.ModelRegistry.properties.models.items.properties.use_cases.items;
  assert.equal(useCase.properties.intended_use_defined.type, 'boolean');
  assert.ok(!useCase.required.includes('intended_use_defined'), 'absent means true');
  const row = schemas.MetricRow.properties;
  assert.deepEqual(row.in_intended_use.type, ['boolean', 'null']);
  assert.deepEqual(row.intended_use_coverage.type, ['number', 'null']);
  assert.ok(row.intended_use_level.oneOf.some((option) => option.type === 'null'));
  const weights = schemas.Meta.properties.overall_score_weights_without_intended_use;
  assert.deepEqual(weights.required, ['performance_grade', 'perf', 'evidence_grade']);
  assert.ok(!schemas.Meta.required.includes('overall_score_weights_without_intended_use'));
  assert.deepEqual(schemas.MetricSummary.properties.intended_use_counts.type, ['object', 'null']);
});

test('the catalogue snapshot, the incident list, and the no-change rollback (v1.11, CONTRACT.md §11, §17, §18)', () => {
  const { schemas } = spec.components;
  const tile = schemas.CatalogueTile.properties;
  assert.equal(tile.intended_use_defined.type, 'boolean');
  assert.deepEqual(tile.distribution.properties.intended_use.type, ['object', 'null']);
  assert.deepEqual(tile.snapshot.required, ['overview', 'safety']);
  assert.equal(tile.snapshot.properties.overview.items.$ref, '#/components/schemas/Status');
  assert.deepEqual(schemas.Catalogue.properties.snapshot_blocks.items.required, ['id', 'chapter']);

  const list = spec.paths['/admin/safety/incidents'].get;
  assert.equal(list.operationId, 'listIncidents');
  assert.deepEqual(paramNames(list), ['model', 'use_case', 'version']);
  assert.equal(DATA_CLIENT_OPERATIONS.listIncidents, 'listIncidents');
  const stored = schemas.StoredIncident;
  for (const field of [...schemas.SafetyIncident.required, 'code_names', 'chapter_no']) {
    assert.ok(stored.required.includes(field), `StoredIncident.${field}`);
  }
  assert.match(spec.paths['/admin/versions/{version_id}/rollback'].post.description, /rollback_no_change/);
});

test('ontologies are an optional read parameter over the ICD-11 contract (v1.13, CONTRACT.md §23)', () => {
  const { schemas, parameters, headers } = spec.components;
  assert.equal(spec.info.version, '1.14.0');
  assert.equal(parameters.Ontology.name, 'ontology');
  assert.equal(parameters.Ontology.required, false, 'optional: without it every read is ICD-11 and unchanged');
  assert.equal(schemas.OntologyId.pattern, '^[a-z0-9][a-z0-9-]{0,31}$');
  assert.ok(headers.Ontology);
  // getComparison (R4, §25) reads the atlas rows of the chosen ontology too.
  // getSubgroupSummary (v1.14, §24) validates it but always counts ICD-11 conditions, so its answer names no ontology.
  const withOntology = ['getAtlasOverview', 'getChapter', 'getMetricMap', 'getMetricSummary', 'getConceptMetrics', 'getConceptSubgroups', 'getSubgroupSummary', 'getComparison', 'searchConcepts', 'exportConcept'];
  const namesNoOntology = ['getSubgroupSummary'];
  for (const { op } of operations) {
    const takes = paramNames(op).includes('ontology');
    assert.equal(takes, withOntology.includes(op.operationId), `${op.operationId} ${takes ? 'takes' : 'lacks'} ontology`);
    if (takes) {
      assert.ok(op.responses['404'], `${op.operationId} declares 404 (unknown_ontology)`);
      assert.equal(Boolean(op.responses['200'].headers['X-Ontology']), !namesNoOntology.includes(op.operationId), `${op.operationId} X-Ontology`);
    }
  }
  for (const name of ['AtlasOverview', 'ChapterDetail', 'MetricMap', 'MetricSummary', 'ConceptMetrics', 'SearchResults', 'ConceptExport']) {
    assert.equal(schemas[name].properties.ontology.$ref, '#/components/schemas/OntologyRef', name);
    assert.ok(!schemas[name].required.includes('ontology'), `${name}.ontology is optional (absent on ICD-11 reads)`);
  }
  assert.deepEqual(schemas.MappingKind.enum, ['exact', 'stem', 'block', 'parent', 'none']);
  // The map's columns are unchanged; the kinds come as an aligned array.
  assert.ok(!schemas.MetricMap.properties.columns.const.includes('mapping'));
  assert.equal(schemas.MetricMap.properties.mapping.type, 'array');
  assert.deepEqual(schemas.OntologyInfo.required, ['id', 'name', 'release', 'licence', 'attribution', 'is_default', 'counts', 'mapping_counts', 'sources']);
  assert.equal(schemas.Meta.properties.ontologies.items.$ref, '#/components/schemas/OntologyInfo');
  assert.ok(schemas.Concept.properties.code && !schemas.Concept.required.includes('code'));
  assert.ok(schemas.ConceptMetrics.properties.mapping && schemas.ConceptMetrics.properties.other_parents);
  assert.match(contract, /## 23\. Ontologies \(v1\.13\)/);
  assert.match(contract, /v1\.13 \(R2\):/);
  // decodeMetricMap carries the mapping kind onto each row.
  const rows = decodeMetricMap({ columns: ['concept_id', 'overall_status'], rows: [['E12', 'no_data'], ['CM-CH-04', 'strong']], mapping: ['none', null] });
  assert.equal(rows.get('E12').mapping, 'none');
  assert.equal(rows.get('CM-CH-04').mapping, null);
  assert.equal(decodeMetricMap({ columns: ['concept_id'], rows: [['5A11']] }).get('5A11').mapping, undefined);
});

test('the comparison is one additive read with its rule in /meta (v1.13 R4, CONTRACT.md §25)', () => {
  const { schemas } = spec.components;
  const operation = spec.paths['/compare'].get;
  assert.equal(operation.operationId, 'getComparison');
  assert.equal(DATA_CLIENT_OPERATIONS.getComparison, 'getComparison');
  assert.deepEqual(paramNames(operation), ['cards', 'scope', 'chapter_id', 'age', 'sex', 'ethnicity', 'context', 'version', 'population', 'ontology']);
  assert.equal(operation.parameters[0].required, true);
  for (const status of ['404', '422']) assert.ok(operation.responses[status], status);
  for (const header of ['X-Dataset-Version', 'X-Population', 'X-Ontology']) assert.ok(operation.responses['200'].headers[header], header);
  // v1.14 (Q4) adds measure_differs and measure_unknown (card level) and setting_differs (row level, last).
  const reasons = [
    'function_category_differs', 'function_category_unknown', 'population_differs', 'measure_differs', 'measure_unknown',
    'no_mapping', 'mapped_broader', 'no_result', 'out_of_scope', 'lens_fallback', 'design_differs', 'setting_differs'
  ];
  assert.deepEqual(schemas.ComparisonReasonCode.enum, reasons);
  assert.deepEqual(schemas.DesignGroup.enum, ['clinical_study', 'test_cases', 'internal_test']);
  assert.deepEqual(schemas.ComparisonRow.required, ['concept_id', 'code', 'pt', 'level', 'parent_id', 'chapter_no', 'mapping', 'cells', 'comparable', 'reasons', 'perf_spread']);
  assert.ok(schemas.ComparisonCell.required.includes('status') && schemas.ComparisonCell.required.includes('design_group'));
  assert.equal(schemas.Meta.properties.comparison.$ref, '#/components/schemas/ComparisonMeta');
  assert.ok(!schemas.Meta.required.includes('comparison'));
  assert.equal(schemas.ComparisonMeta.properties.heuristic.const, true, 'published as a prototype heuristic');
  assert.match(contract, /## 25\. Comparison \(v1\.13\)/);
  assert.match(contract, /- \*\*v1\.13 \(R4\): comparison/);
  for (const code of reasons) assert.ok(contract.includes(`\`${code}\``), `CONTRACT.md documents ${code}`);
});

test('local populations are additive and never change default reads (v1.10, CONTRACT.md §21)', () => {
  const { schemas, parameters, headers } = spec.components;
  assert.ok(schemas.DatasetKind.enum.includes('population'));
  assert.equal(parameters.Population.name, 'population');
  assert.equal(parameters.Population.required, false, 'optional: without it every read is unchanged');
  assert.equal(schemas.PopulationId.pattern, '^[a-z0-9][a-z0-9-]{0,39}$');
  assert.ok(headers.Population);

  // Every read that depends on prevalence takes the optional population; /meta and /models do not.
  const withPopulation = [
    'getCatalogue', 'getAtlasOverview', 'getChapter', 'getMetricMap', 'getMetricSummary', 'getConceptMetrics', 'getConceptSubgroups',
    'getMultimorbidityCandidates', 'getMultimorbidityCombination', 'searchConcepts', 'exportConcept', 'exportDataset'
  ];
  for (const { op } of operations.filter(({ op }) => withPopulation.includes(op.operationId))) {
    assert.ok(paramNames(op).includes('population'), `${op.operationId} takes population`);
    assert.ok(op.responses['404'], `${op.operationId} declares 404 (unknown_population)`);
    assert.ok(op.responses['200'].headers['X-Population'], `${op.operationId} declares X-Population`);
  }
  assert.equal(operations.filter(({ op }) => withPopulation.includes(op.operationId)).length, withPopulation.length);
  for (const id of ['getMeta', 'listModels', 'lookup']) {
    const { op } = operations.find(({ op }) => op.operationId === id);
    assert.ok(!paramNames(op).includes('population'), `${id} takes no population query`);
  }

  // Responses name the population in an optional field; /meta lists them.
  for (const name of ['AtlasOverview', 'ChapterDetail', 'MetricMap', 'MetricSummary', 'ConceptMetrics', 'MultimorbidityCandidates', 'MultimorbidityCombination', 'SearchResults', 'ConceptExport', 'Catalogue', 'Lookup']) {
    assert.equal(schemas[name].properties.population.$ref, '#/components/schemas/PopulationRef', name);
    assert.ok(!schemas[name].required.includes('population'), `${name}.population is optional (absent on default reads)`);
  }
  assert.deepEqual(schemas.PopulationRef.required, ['id', 'name']);
  assert.deepEqual(schemas.PopulationInfo.required, ['id', 'name', 'codes', 'updated_version']);
  assert.equal(schemas.Meta.properties.populations.items.$ref, '#/components/schemas/PopulationInfo');
  assert.ok(!schemas.LookupContext.required.includes('population_id'));

  // The data set: upload target, filled template, removal.
  const form = spec.paths['/admin/uploads'].post.requestBody.content['multipart/form-data'].schema;
  assert.ok(form.properties.population_id && form.properties.population_name && !form.required.includes('population_id'));
  assert.ok(schemas.Upload.properties.target.properties.population_id);
  const template = spec.paths['/admin/templates/{kind}.{format}'].get;
  assert.ok(paramNames(template).includes('population_id'));
  const remove = spec.paths['/admin/populations/{population_id}/remove'].post;
  assert.equal(remove.operationId, 'removePopulation');
  assert.ok(remove.tags.includes('admin') && remove.responses['404'] && remove.responses['409']);
  assert.equal(remove.requestBody.required, false);
});

test('the map tells a rollup without children by its trailing child_count column (v1.10, CONTRACT.md §6, §13)', () => {
  const map = spec.components.schemas.MetricMap.properties;
  const columns = map.columns.const;
  assert.equal(columns.at(-1), 'child_count', 'appended: earlier positions are unchanged');
  assert.equal(columns.indexOf('safety'), 12);
  const cell = map.rows.items.prefixItems.at(-1);
  assert.deepEqual(cell.type, ['integer', 'null'], 'null for condition rows');
  assert.equal(cell.minimum, 0);
  // Clients read map columns by name, so the new column needs no decoder change.
  const [row] = decodeMetricMap({ columns, rows: [columns.map((column) => (column === 'child_count' ? 0 : null))] }).values();
  assert.equal(row.child_count, 0);
});

test('assisted data entry proposes and never returns the key (v1.9, CONTRACT.md §20)', () => {
  const { schemas } = spec.components;
  const status = spec.paths['/admin/assist'];
  assert.deepEqual(
    [status.get.operationId, status.put.operationId, status.delete.operationId],
    ['getAssistStatus', 'configureAssist', 'clearAssist']
  );
  for (const op of [status.get, status.put, status.delete, spec.paths['/admin/assist/proposals'].post]) {
    assert.ok(op.tags.includes('admin'), `${op.operationId} is an admin operation`);
  }
  // The key is write-only: requests may carry it, no response schema has it.
  assert.ok(schemas.AssistConfigRequest.properties.api_key && !schemas.AssistConfigRequest.required.includes('api_key'));
  assert.ok(!('api_key' in schemas.AssistStatus.properties) && schemas.AssistStatus.required.includes('key_set'));
  const responseSchemas = JSON.stringify(Object.fromEntries(Object.entries(schemas).filter(([name]) => name !== 'AssistConfigRequest')));
  assert.ok(!responseSchemas.includes('"api_key"'), 'no response schema names api_key');
  assert.deepEqual(status.delete.responses['204'], { description: 'The helper is off.' });

  const propose = spec.paths['/admin/assist/proposals'].post;
  assert.equal(propose.operationId, 'proposeRecords');
  const form = propose.requestBody.content['multipart/form-data'].schema;
  assert.deepEqual(form.required, ['kind']);
  assert.deepEqual(form.properties.kind.enum, ['metrics', 'safety']);
  for (const status of ['409', '413', '415', '422', '502']) assert.ok(propose.responses[status], status);
  // Proposals carry per-field sources and flags; the input is identified by its hash only.
  const proposals = schemas.AssistProposals;
  assert.deepEqual(proposals.required.slice().sort(), ['batches', 'dataset_version', 'dropped', 'input', 'kind', 'model', 'notes', 'provider', 'requests', 'synthetic_data_notice']);
  assert.deepEqual(schemas.AssistInput.required.slice().sort(), ['bytes', 'filename', 'media', 'sha256']);
  assert.deepEqual(schemas.AssistField.required.slice().sort(), ['confidence', 'origin', 'reason', 'source', 'uncertain']);
  assert.ok(schemas.AssistDropped.properties.reason.enum.includes('unknown_code'));
  assert.ok(schemas.AssistDropped.properties.reason.enum.includes('unknown_card'));
});

test('the lookup is a POST read with a closed CDS Hooks–shaped body (v1.8, CONTRACT.md §19)', () => {
  const { schemas } = spec.components;
  const operation = spec.paths['/lookup'].post;
  assert.equal(operation.operationId, 'lookup');
  assert.equal(DATA_CLIENT_OPERATIONS.lookup, 'lookup');
  assert.equal(spec.paths['/lookup'].get, undefined, 'case inputs never go into a URL');
  assert.deepEqual(paramNames(operation), ['version'], 'only the dataset version is a query parameter');
  assert.ok(operation.responses['200'].headers['X-Dataset-Version']);
  assert.ok(operation.requestBody.required);
  assert.equal(operation.requestBody.content['application/json'].schema.$ref, '#/components/schemas/LookupRequest');

  // Closed at every level: no additionalProperties anywhere (the drift test treats such objects as closed).
  const request = schemas.LookupRequest;
  assert.deepEqual(request.required, ['context']);
  const context = schemas.LookupContext;
  assert.deepEqual(context.required, ['card', 'conditions']);
  assert.equal(context.properties.conditions.minItems, 1);
  assert.equal(context.properties.conditions.maxItems, 12);
  assert.deepEqual(context.properties.card.required, ['model_version', 'use_case']);
  const coding = schemas.LookupCoding;
  assert.deepEqual(coding.required, ['code']);
  assert.equal(coding.properties.system.anyOf[0].const, 'http://id.who.int/icd/release/11/mms');
  assert.equal(coding.properties.code.pattern, '^[A-Za-z0-9.]{1,16}$', 'codes only, no free text');
  const population = schemas.LookupPopulation.properties;
  assert.deepEqual(population.age_group.anyOf[0].enum, ['0-17', '18-39', '40-64', '65+']);
  assert.deepEqual(population.sex.anyOf[0].enum, ['female', 'male']);
  assert.deepEqual(population.ethnicity.anyOf[0].enum, ['white', 'black', 'hispanic', 'asian', 'other']);
  for (const schema of [request, context, context.properties.card, coding, schemas.LookupPopulation]) {
    assert.equal(schema.additionalProperties, undefined);
  }

  const lookup = schemas.Lookup;
  assert.deepEqual(lookup.required, ['dataset_version', 'synthetic_data_notice', 'disclaimer', 'card', 'lens', 'conditions', 'combination']);
  assert.deepEqual(lookup.properties.card.required, ['model_version', 'use_case', 'display_name', 'kind', 'card_url']);
  assert.deepEqual(
    lookup.properties.conditions.items.oneOf.map(({ $ref }) => $ref),
    ['#/components/schemas/LookupCondition', '#/components/schemas/LookupUnmatchedCondition']
  );
  assert.deepEqual(schemas.LookupCondition.required, [
    'code', 'matched', 'concept_id', 'pt', 'icd11_code', 'anchor_id', 'statuses', 'safety', 'warnings', 'safeguards', 'incidents', 'provenance', 'card_url'
  ]);
  assert.deepEqual(schemas.LookupUnmatchedCondition.required, ['code', 'matched']);
  assert.deepEqual(schemas.LookupStatuses.required, ['overall', 'performance', 'evidence', 'intended_use']);
  assert.equal(schemas.LookupCondition.properties.incidents.items.$ref, '#/components/schemas/SafetyIncident');
  assert.deepEqual(schemas.LookupCombination.required, [
    'combination_key', 'label', 'concept_ids', 'statuses', 'safety', 'warnings', 'safeguards', 'provenance', 'card_url'
  ]);
});

test('safety incidents, merge uploads, provenance, and change notes are additive (v1.7, CONTRACT.md §11, §18)', () => {
  const { schemas } = spec.components;
  assert.ok(schemas.DatasetKind.enum.includes('safety'));
  assert.deepEqual(schemas.UploadMode.enum, ['replace', 'merge']);
  assert.deepEqual(schemas.SafetyMark.enum, ['serious', 'caution'], 'never "safe" or green');

  // The map's trailing safety column; clients read columns by name.
  const map = schemas.MetricMap.properties;
  assert.equal(map.columns.const.indexOf('safety'), 12);
  assert.equal(map.columns.const.indexOf('ci_high'), 11, 'earlier positions are unchanged');

  // Concept metrics list the incidents; rows carry their data source.
  assert.ok(schemas.ConceptMetrics.required.includes('incidents'));
  const incident = schemas.SafetyIncident;
  for (const field of ['incident_id', 'codes', 'condition_ids', 'chapter_id', 'lens', 'incident_type', 'harm', 'status', 'severity', 'source_type', 'source_reference', 'reported_date', 'summary']) {
    assert.ok(incident.required.includes(field), `SafetyIncident.${field}`);
  }
  assert.deepEqual(incident.properties.status.enum, ['open', 'mitigated', 'closed']);
  assert.ok(!schemas.Provenance.required.includes('data_source'), 'data_source is optional on MetricRow');
  assert.deepEqual(schemas.DataSource.required, ['source', 'study', 'date']);

  // Summary view=safety, catalogue counts.
  assert.ok(schemas.SummaryView.enum.includes('safety'));
  assert.deepEqual(schemas.SafetyCounts.required, ['serious', 'caution', 'none']);
  const tile = schemas.CatalogueTile;
  assert.ok(tile.required.includes('safety'));
  assert.deepEqual(tile.properties.safety.required, ['serious', 'caution', 'open', 'mitigated', 'closed']);

  // Uploads: mode on createUpload, the records upload, notes on publish, rollback, and history.
  const createUpload = spec.paths['/admin/uploads'].post.requestBody.content['multipart/form-data'].schema;
  assert.ok(createUpload.properties.mode && !createUpload.required.includes('mode'));
  const records = spec.paths['/admin/uploads/records'].post;
  assert.equal(records.operationId, 'createRecordsUpload');
  // studies and effects since v1.13; local_metrics and (in a developer submission) models since v1.13 §26.
  assert.deepEqual(schemas.RecordsUploadRequest.properties.kind.enum, ['metrics', 'prevalence', 'safety', 'studies', 'effects', 'local_metrics', 'models']);
  assert.ok(schemas.Upload.required.includes('mode') && schemas.Upload.required.includes('origin'));
  assert.ok(!schemas.PublishRequest.required.includes('note'));
  assert.equal(schemas.ChangeNote.maxLength, 500);
  assert.equal(spec.paths['/admin/versions/{version_id}/rollback'].post.requestBody.required, false);
  assert.ok(schemas.VersionEntry.required.includes('note'));
});

test('registry entries carry the optional v1.5 fields (CONTRACT.md §11)', () => {
  const entry = spec.components.schemas.ModelRegistry.properties.models.items;
  const optional = ['kind', 'ai_type', 'developer', 'release_date', 'description', 'built_on'];
  assert.deepEqual(optional.filter((name) => !entry.properties[name]), []);
  assert.deepEqual(optional.filter((name) => entry.required.includes(name)), [], 'v1.5 fields stay optional');
  assert.deepEqual(entry.properties.kind.enum, ['model', 'product']);
  assert.deepEqual(entry.properties.ai_type.anyOf[0].enum, ['llm', 'imaging', 'tabular_risk', 'rule_based', 'hybrid']);
  assert.equal(entry.properties.description.maxLength, 280);

  const useCase = entry.properties.use_cases.items;
  assert.deepEqual(useCase.required, ['use_case', 'has_multimorbidity']);
  assert.deepEqual(useCase.properties.function_category.anyOf[0].enum, [
    'decision_support',
    'documentation',
    'image_analysis',
    'triage',
    'patient_communication',
    'administrative'
  ]);
  const declarations = resolveRef(useCase.properties.declarations.anyOf[0].$ref);
  assert.deepEqual(declarations.required, [
    'declared_intended_purpose',
    'declared_regulatory_status',
    'declared_contact',
    'declared_documentation_url'
  ]);
});

test('the catalogue serves one tile per configuration with all four view distributions (CONTRACT.md §17)', () => {
  const { schemas } = spec.components;
  const operation = spec.paths['/catalogue'].get;
  assert.equal(operation.operationId, 'getCatalogue');
  assert.deepEqual(paramNames(operation), ['version', 'population']);
  assert.ok(operation.responses['200'].headers['X-Dataset-Version']);

  const catalogue = schemas.Catalogue;
  assert.deepEqual(catalogue.required, ['dataset_version', 'synthetic_data_notice', 'lens', 'condition_count', 'tiles']);
  const tile = resolveRef(catalogue.properties.tiles.items.$ref);
  for (const field of ['card_id', 'model_version', 'use_case', 'system', 'function_category', 'declarations', 'has_multimorbidity', 'is_default_use_case', 'distribution', 'chapters', 'last_updated']) {
    assert.ok(tile.required.includes(field), `tile.${field} is required`);
  }
  const system = tile.properties.system;
  assert.deepEqual(system.properties.status.enum, ['ACTIVE', 'EXPERIMENTAL'], 'the status filter uses the registry status');
  assert.deepEqual(system.properties.kind.enum, ['model', 'product']);

  const { overall, performance, evidence, intended_use: intendedUse } = tile.properties.distribution.properties;
  assert.equal(overall.$ref, '#/components/schemas/StatusCounts');
  assert.deepEqual(performance.required, ['strong', 'moderate', 'weak', 'no_data']);
  assert.deepEqual(evidence.required, ['strong', 'moderate', 'weak', 'no_data']);
  assert.deepEqual(intendedUse.required, ['in_scope', 'partially_in_scope', 'out_of_scope', 'no_data']);
  assert.deepEqual(tile.properties.chapters.items.required, ['chapter_id', 'chapter_no', 'condition_count', 'overall']);
  assert.deepEqual(tile.properties.last_updated.required, ['version', 'at']);
});

test('createDataClient rejects incomplete adapters and binds complete ones', () => {
  assert.throws(() => createDataClient({ getMeta() {} }), /missing contract methods: listModels/);

  const adapter = Object.fromEntries(
    DATA_CLIENT_METHODS.map((method) => [
      method,
      function call() {
        return this === adapter ? method : 'unbound';
      }
    ])
  );
  const client = createDataClient(adapter);
  assert.ok(Object.isFrozen(client));
  const { getMeta } = client;
  assert.equal(getMeta(), 'getMeta');
});

test('DataClientError carries problem details', () => {
  const error = new DataClientError({ status: 404, code: 'unknown_model', title: 'Unknown model', detail: 'X-1.0' });
  assert.equal(error.status, 404);
  assert.equal(error.code, 'unknown_model');
  assert.equal(error.message, 'Unknown model: X-1.0');
});

test('local results, instance, roles, submissions, model cards, and releases are additive (v1.13 R5, CONTRACT.md §26)', () => {
  const schemas = spec.components.schemas;
  assert.ok(contract.includes('## 26. Local results, instance, roles, and nested model cards (v1.13)'));
  assert.ok(schemas.DatasetKind.enum.includes('local_metrics') && schemas.DatasetKind.enum.includes('model_cards'));
  // Optional additions: a public row keeps its exact shape.
  assert.ok(schemas.Provenance.properties.layer && !schemas.Provenance.required.includes('layer'));
  assert.ok(schemas.MetricMap.properties.layer && !schemas.MetricMap.required.includes('layer'));
  assert.ok(schemas.ConceptMetrics.properties.public_metrics && !(schemas.ConceptMetrics.required ?? []).includes('public_metrics'));
  assert.ok(schemas.Meta.properties.instance);
  assert.deepEqual(schemas.InstanceProfile.properties.kind.enum, ['public', 'hospital']);
  assert.ok(schemas.VersionEntry.properties.publisher_role && schemas.VersionEntry.properties.publisher_name);
  assert.ok(schemas.PublishRequest.properties.role && !schemas.PublishRequest.required.includes('role'));
  // The public version feed is a read; the admin History keeps its own operation id.
  const ids = operations.map(({ op }) => op.operationId);
  for (const id of ['listDatasetVersions', 'getNarrowModelCard', 'updateInstance', 'createSubmission', 'listSubmissions', 'getSubmission',
    'acceptSubmission', 'returnSubmission', 'createModelCardUpload', 'getModelCardProposals', 'exportPublicRelease', 'importPublicRelease',
    'getReleaseImport', 'publishReleaseImport', 'discardReleaseImport']) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(spec.paths['/versions'].get && spec.paths['/admin/versions'].get);
  assert.equal(DATA_CLIENT_OPERATIONS.getReleaseExportUrl, 'exportPublicRelease');
});

test('the study appraisal of map rows and summary counts is additive (CONTRACT.md §22)', () => {
  const schemas = spec.components.schemas;
  // Present only when a row is linked, so stores and cards without linked studies keep their exact bytes.
  const appraisal = schemas.MetricMap.properties.appraisal;
  assert.ok(appraisal && !schemas.MetricMap.required.includes('appraisal'));
  assert.equal(appraisal.type, 'array');
  assert.deepEqual(appraisal.items.oneOf[0].enum, ['linked', 'includes_linked']);
  assert.ok(schemas.MetricSummary.properties.appraisal_counts && !schemas.MetricSummary.required.includes('appraisal_counts'));
  assert.deepEqual(schemas.AppraisalCounts.required, ['graded', 'linked']);
  assert.ok(contract.includes('separator_in_name') && contract.includes('decisions of 2026-10-21'));
  const rows = decodeMetricMap({ columns: ['concept_id'], rows: [['2C30'], ['BLK'], ['2C31']], appraisal: ['linked', 'includes_linked', null] });
  assert.deepEqual([...rows.values()].map((row) => row.appraisal), ['linked', 'includes_linked', null]);
  assert.equal(decodeMetricMap({ columns: ['concept_id'], rows: [['5A11']] }).get('5A11').appraisal, undefined);
});

test('comparison depth and evidence age are additive (v1.14 Q4, CONTRACT.md §25, §28.5)', () => {
  const { schemas } = spec.components;
  // New cell and card fields are optional: comparisons without them keep their v1.13 keys.
  for (const name of ['layer', 'setting_category']) {
    assert.ok(schemas.ComparisonCell.properties[name] && !schemas.ComparisonCell.required.includes(name), name);
    assert.ok(!JSON.stringify(schemas.ComparisonCell.properties[name]).includes('null'), `${name} is never null`);
  }
  assert.equal(schemas.ComparisonCell.properties.layer.$ref, '#/components/schemas/SubgroupLayer');
  for (const name of ['performance_measure', 'reference_standard', 'configuration', 'narrow_model_card', 'conductors']) {
    assert.ok(schemas.ComparisonCard.properties[name] && !schemas.ComparisonCard.required.includes(name), name);
  }
  assert.deepEqual(schemas.ComparisonConfiguration.required, ['configuration_id', 'configuration_date']);
  assert.deepEqual(schemas.ComparisonNarrowModelCard.required, ['present', 'submitted_at']);
  assert.deepEqual(schemas.ComparisonConductors.required, ['developer', 'independent', 'hospital']);
  assert.ok(schemas.MetricSummary.properties.configuration_counts && !schemas.MetricSummary.required.includes('configuration_counts'));
  assert.deepEqual(schemas.ConfigurationCounts.required, ['current', 'earlier', 'not_stated']);
  assert.match(contract, /- \*\*v1\.14 \(Q4\)/);
  assert.match(contract, /### 28\.5 Evidence age/);
  for (const code of ['measure_differs', 'measure_unknown', 'setting_differs', 'configuration_not_in_registry', 'configuration_counts']) {
    assert.ok(contract.includes(`\`${code}\``), `CONTRACT.md documents ${code}`);
  }
});

test('configurations, lineage, and data-protection fields are additive (v1.14 Q1, CONTRACT.md §28)', () => {
  const schemas = spec.components.schemas;
  assert.ok(contract.includes('## 28. Configurations and lineage (v1.14)'));
  // Every new field is optional, so a store without them reads byte for byte as under v1.13.
  const entry = schemas.ModelRegistry.properties.models.items;
  const useCase = entry.properties.use_cases.items;
  for (const name of ['configuration', 'performance_measure', 'reference_standard']) {
    assert.ok(useCase.properties[name] && !useCase.required.includes(name), name);
  }
  for (const name of ['replaces', 'replaced_by']) {
    assert.ok(entry.properties[name] && !entry.required.includes(name), name);
  }
  const record = schemas.ConfigurationRecord;
  assert.equal(useCase.properties.configuration.$ref, '#/components/schemas/ConfigurationRecord');
  assert.deepEqual(record.required, [
    'configuration_id', 'configuration_date', 'prompt_summary', 'prompt_sha256', 'retrieval', 'tools',
    'sampling_temperature', 'sampling_top_p', 'sampling_max_output_tokens', 'fine_tuning'
  ]);
  assert.equal(record.properties.configuration_id.pattern, '^[A-Za-z0-9._-]{1,64}$');
  assert.equal(record.properties.prompt_sha256.pattern, '^[0-9a-f]{64}$');
  assert.equal(record.properties.prompt_summary.maxLength, 500);
  assert.equal(record.properties.tools.maxItems, 10);
  assert.deepEqual([record.properties.sampling_temperature.minimum, record.properties.sampling_temperature.maximum], [0, 2]);
  assert.deepEqual([record.properties.sampling_top_p.minimum, record.properties.sampling_top_p.maximum], [0, 1]);
  assert.equal(record.properties.sampling_max_output_tokens.minimum, 1);
  const declarations = schemas.Declarations;
  for (const name of ['declared_data_use', 'declared_data_location', 'declared_retention', 'declared_privacy_contact']) {
    assert.ok(declarations.properties[name] && !declarations.required.includes(name), name);
  }
  const tile = schemas.CatalogueTile;
  assert.ok(tile.properties.configuration && !tile.required.includes('configuration'));
  assert.ok(tile.properties.system.properties.replaced_by && !tile.properties.system.required.includes('replaced_by'));
  assert.deepEqual(tile.properties.function_category.anyOf[0].enum.slice(-2), ['patient_communication', 'administrative']);
  assert.ok(schemas.InstanceProfile.properties.data_protection_note && !schemas.InstanceProfile.required.includes('data_protection_note'));
  assert.equal(schemas.InstanceProfile.properties.data_protection_note.maxLength, 500);
});

test('contract v1.14 (Q6): synonym matches in search, the interpreter, and the helper rewrite (§31)', () => {
  const schemas = spec.components.schemas;
  assert.equal(schemas.SearchResults.properties.results.items.$ref, '#/components/schemas/SearchResult');
  const result = schemas.SearchResult;
  assert.deepEqual(result.required, schemas.Concept.required);
  for (const name of Object.keys(schemas.Concept.properties)) assert.ok(result.properties[name], name);
  assert.equal(result.properties.match.const, 'synonym');
  assert.ok(result.properties.matched_term && !result.required.includes('match') && !result.required.includes('matched_term'));

  const interpret = spec.paths['/search/interpret'].get;
  assert.equal(interpret.operationId, 'interpretQuery');
  assert.deepEqual(paramNames(interpret), ['q', 'version']);
  assert.ok(interpret.responses['200'].headers['X-Dataset-Version'] && interpret.responses['422']);
  assert.deepEqual(schemas.Interpretation.required, ['query', 'chips', 'unrecognized']);
  assert.deepEqual(schemas.InterpretationChip.properties.kind.enum, ['system', 'function', 'condition', 'age', 'sex', 'ethnicity', 'setting']);
  assert.deepEqual(schemas.InterpretationChip.properties.match.enum, ['term', 'synonym', 'code']);

  const helper = spec.paths['/assist/interpret'].post;
  assert.equal(helper.operationId, 'interpretQueryWithHelper');
  assert.ok(helper.tags.includes('search') && !helper.tags.includes('admin'));
  assert.equal(helper.requestBody.content['application/json'].schema.$ref, '#/components/schemas/InterpretRequest');
  for (const status of ['409', '422', '502']) assert.ok(helper.responses[status], status);
  assert.deepEqual(schemas.HelperInterpretation.required, ['query', 'chips', 'unrecognized', 'provider', 'model', 'dropped']);
  assert.deepEqual(schemas.DroppedChip.properties.reason.enum, ['unknown_kind', 'unknown_value', 'not_found', 'conflict', 'limit']);
  assert.match(contract, /## 31\. Plain-language search and synonyms/);
});

test('contract v1.14 (Q7): card record, JSON-LD, evaluation results, and the CDS Hooks service (§32, §33)', () => {
  const schemas = spec.components.schemas;
  const record = spec.paths['/cards/record'].get;
  assert.equal(record.operationId, 'getCardRecord');
  assert.deepEqual(paramNames(record), ['model', 'use_case', 'version', 'format']);
  assert.ok(record.responses['200'].headers['X-Dataset-Version']);
  assert.deepEqual(Object.keys(record.responses['200'].content).sort(), ['application/json', 'application/ld+json']);
  assert.equal(schemas.CardRecord.properties.format.const, 'bmc-card-record/1');
  for (const name of ['system', 'card', 'summary', 'chapters', 'studies', 'effects', 'incidents', 'links', 'generated']) {
    assert.ok(schemas.CardRecord.required.includes(name), name);
  }
  assert.ok(schemas.CardRecordLd.required.includes('@context'));
  assert.equal(schemas.CardRecordLd.properties['@type'].const, 'obo:MCRO_0000001');

  const upload = spec.paths['/admin/uploads/evaluation-results'].post;
  assert.equal(upload.operationId, 'createEvaluationUpload');
  assert.ok(upload.responses['202'] && upload.responses['413']);
  assert.equal(schemas.Upload.properties.kind.$ref, '#/components/schemas/UploadKind');
  assert.deepEqual(schemas.UploadKind.enum, [...schemas.DatasetKind.enum, 'evaluation_results']);
  const proposals = spec.paths['/admin/uploads/{upload_id}/evaluation-proposals'].get;
  assert.equal(proposals.operationId, 'getEvaluationProposals');
  assert.deepEqual(schemas.EvaluationProposals.required, ['upload_id', 'model_version', 'use_case', 'study', 'metrics', 'results', 'notes']);

  const discovery = spec.paths['/cds-services'].get;
  const service = spec.paths['/cds-services/bmc-condition-status'].post;
  assert.ok(discovery.tags.includes('cds-hooks') && service.tags.includes('cds-hooks'));
  assert.equal(service.operationId, 'callCdsService');
  assert.ok(service.responses['400'] && service.responses['413']);
  assert.equal(schemas.CdsHooksRequest.properties.hook.const, 'patient-view');
  assert.deepEqual(schemas.CdsCard.properties.indicator.enum, ['info', 'warning', 'critical']);
  assert.equal(schemas.CdsCard.properties.summary.maxLength, 140);
  assert.match(contract, /## 32\. Card record and evaluation import/);
  assert.match(contract, /## 33\. CDS Hooks service/);
});
