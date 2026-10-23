// Frontend presentation of contract values: map decoding, frontend-owned
// copy, atlas structure, and the condition card export.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeMetricMap } from '../frontend/src/features/atlas/decodeMetricMap.js';
import { buildAtlasStructure, canonicalConditionId, conceptPathLabel } from '../frontend/src/features/atlas/atlasStructure.js';
import { buildConceptCardFile } from '../frontend/src/features/details/conceptCardExport.js';
import { USE_CASE_REQUIREMENT, highWarningCount, rankWarnings, splitRequirement, warningScope } from '../frontend/src/features/details/copy/warningCopy.js';
import { describeSafeguards } from '../frontend/src/features/details/copy/safeguardCopy.js';
import { gradeLetter, summarizeMetricRow } from '../frontend/src/features/details/modelCardSummary.js';
import { apiClient, startTestBackend } from './support/backend.js';

let backend;
before(async () => {
  backend = await startTestBackend();
});
after(() => backend?.stop());

test('decodes columnar metric maps', () => {
  const rows = decodeMetricMap({ columns: ['concept_id', 'perf'], rows: [['A', 0.5], ['B', null]] });
  assert.deepEqual(rows.get('A'), { concept_id: 'A', perf: 0.5 });
  assert.equal(rows.get('B').perf, null);
});

test('warnings rank by relevance then title; unknown codes get fallback copy', () => {
  const ranked = rankWarnings([
    { code: 'conservative_rollup_p20', relevance: 'Low' },
    { code: 'wide_confidence_interval', relevance: 'Medium' },
    { code: 'custom_flag', relevance: 'Medium' },
    { code: 'no_validation_data', relevance: 'High' }
  ]);
  assert.deepEqual(ranked.map((warning) => warning.title), [
    'Validation evidence unavailable',
    'Custom Flag',
    'High uncertainty',
    'Conservative aggregate estimate'
  ]);
  assert.deepEqual(describeSafeguards([{ id: 'scope-stop', priority: 'Critical' }])[0].actions.length, 3);
});

test('export values use letters and "N" for missing grades, plus status words', () => {
  assert.equal(gradeLetter('b'), 'B');
  assert.equal(gradeLetter(null), 'N');
  const summary = summarizeMetricRow({
    overall: { tier: 'no_evidence_data', score: null, grade: null },
    status: { overall: 'not_validated', performance: 'strong', evidence: 'no_data' }, // a served not_validated reads No data (D5)
    performance_grade: 'B', perf: 0.82, ci_low: 0.8, ci_high: 0.84,
    evidence_grade: null, validation_type: null, intended_use_level: 'in_scope', intended_use_coverage: 1,
    n_studies: null, peer_reviewed_studies: null, n_samples: 900, n_sites: 3
  });
  assert.deepEqual([summary.overallGrade, summary.performanceGrade, summary.evidenceGrade, summary.intendedUse], ['N', 'B', 'N', 'In scope']);
  assert.deepEqual(summary.statuses, { overall: 'No data', performance: 'Strong', evidence: 'No data' });
  assert.equal(summary.validationType, 'Not available');
});

test('atlas structure resolves paths, first conditions, and multimorbidity anchors', async () => {
  const client = apiClient(backend.origin);
  const structure = buildAtlasStructure(await client.getAtlasOverview());
  assert.equal(structure.chapterConcepts.length, 21);
  assert.equal(structure.chapterConcepts[0].chapter_no, '01');
  const deep = (await client.getConceptMetrics({ model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', conceptId: '1A03.0' })).concept;
  assert.equal(canonicalConditionId(deep, structure), '1A03');
  assert.equal(canonicalConditionId(structure.conceptsById['CH-01'], structure), null);
  assert.match(conceptPathLabel(deep, structure), /^Certain infectious or parasitic diseases > .+ > Enteropathogenic Escherichia coli infection$/);
  assert.equal(structure.firstConditionByChapterId['CH-01'].parent_id, structure.blocksByChapterId['CH-01'][0].concept_id);
});

test('the condition card export keeps the pre-restructure format and adds statuses and the notice', async () => {
  const client = apiClient(backend.origin);
  const conceptExport = await client.exportConcept({ model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', conceptId: '5A11' });
  const card = buildConceptCardFile(conceptExport);
  assert.deepEqual(Object.keys(card), [
    'exported_at', 'audience_view', 'concept', 'context', 'model_card', 'warnings', 'safety_incidents', 'recommended_safeguards', 'synthetic_data_notice'
  ]);
  assert.match(card.synthetic_data_notice, /synthetic/i);
  assert.deepEqual(card.concept, {
    code: '5A11',
    block: 'BlockL1-5A0',
    name: 'Type 2 diabetes mellitus',
    hierarchy: card.concept.hierarchy
  });
  assert.equal(card.concept.hierarchy.length, 3);
  assert.equal(card.context.population, 'All ages | All sexes | All ethnicities');
  assert.deepEqual(Object.keys(card.model_card), ['overall', 'performance', 'evidence', 'intended_use', 'details', 'statuses']);
  assert.deepEqual(Object.keys(card.model_card.statuses), ['overall', 'performance', 'evidence']);
  assert.ok(card.recommended_safeguards.some((safeguard) => safeguard.title === 'Maintain clinician-in-the-loop governance'));
  assert.ok(card.warnings.every((warning) => warning.title && warning.summary && warning.technical_summary && warning.details));
});

test('warnings on aggregated rows say where they apply (contract v1.4 share)', () => {
  const share = (count, total) => ({ code: 'no_performance_data', relevance: 'High', share: { count, total } });
  assert.equal(warningScope(share(1, 2), 'rollup'), 'In 1 of 2 conditions');
  assert.equal(warningScope(share(6, 6), 'rollup'), 'In all 6 conditions');
  assert.equal(warningScope(share(2, 2), 'rollup'), 'In both conditions');
  assert.equal(warningScope(share(2, 6), 'condition'), 'In 2 of 6 population groups');
  assert.equal(warningScope(share(1, 1), 'rollup'), null); // one row: nothing to qualify
  assert.equal(warningScope({ code: 'no_performance_data', relevance: 'High' }, 'rollup'), null);
});

test('the high-priority count leaves out the use-case requirement', () => {
  const warnings = [
    { code: USE_CASE_REQUIREMENT, relevance: 'High' },
    { code: 'no_validation_data', relevance: 'High' },
    { code: 'no_performance_data', relevance: 'High' },
    { code: 'wide_confidence_interval', relevance: 'Medium' }
  ];
  assert.equal(highWarningCount(warnings), 2);
  assert.equal(highWarningCount([{ code: USE_CASE_REQUIREMENT, relevance: 'High' }]), 0);
  assert.equal(highWarningCount(undefined), 0);
});

test('"Clinician review required" is the requirement line on every card, combinations included, never a warning', () => {
  const { requirement, findings } = splitRequirement([
    { code: USE_CASE_REQUIREMENT, relevance: 'High' },
    { code: 'wide_confidence_interval', relevance: 'Medium' }
  ]);
  assert.equal(requirement.title, 'Clinician review required');
  assert.deepEqual(findings.map((warning) => warning.code), ['wide_confidence_interval']);
  assert.deepEqual(splitRequirement(undefined), { requirement: null, findings: [] });
  const source = (file) => readFileSync(new URL(`../frontend/src/features/${file}`, import.meta.url), 'utf8');
  for (const file of ['details/DetailCard.jsx', 'multimorbidity/CombinationPanel.jsx']) {
    const card = source(file);
    assert.match(card, /splitRequirement\(/, file);
    assert.match(card, /<RequirementLine requirement=\{requirement\} depth=\{depth\} \/>/, file);
    assert.match(card, /<WarningList .*warnings=\{findings\}/, file);
  }
});

test('every safeguard id in the contract has copy, so none is dropped silently', () => {
  const contract = JSON.parse(readFileSync(new URL('../backend/openapi.json', import.meta.url), 'utf8'));
  const ids = contract.components.schemas.Safeguard.properties.id.enum;
  assert.ok(ids.includes('evidence-missing') && ids.includes('overall-weak'));
  const described = describeSafeguards(ids.map((id) => ({ id, priority: 'Important' })));
  assert.deepEqual(described.map((safeguard) => safeguard.id), ids);
  assert.ok(described.every((safeguard) => safeguard.title && safeguard.patientSummary && safeguard.expertSummary && safeguard.actions.length));
});

test('the Sepsis subchapter card no longer reads "stable" and scopes its warnings (critique 2026-10-10)', async () => {
  const client = apiClient(backend.origin);
  const conceptExport = await client.exportConcept({ model: 'SynGPT-2.0', useCase: 'Discharge letter generation', conceptId: 'BLK-01-BlockL1-1G4' });
  const card = buildConceptCardFile(conceptExport);
  const titles = card.recommended_safeguards.map((safeguard) => safeguard.title);
  assert.deepEqual(titles, ['Validate before relying on it']);
  assert.ok(card.recommended_safeguards.every((safeguard) => !/stable/i.test(safeguard.summary)));
  const missing = card.warnings.find((warning) => warning.title === 'Performance data unavailable');
  assert.equal(missing.applies_to, 'In 1 of 2 conditions');
});
