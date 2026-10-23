// Built on and evidence age on the condition card and in the Summary
// (contract v1.14, CONTRACT.md §28.5; release 0.5 phase Q4): the choice of the base model's card, the scope conflict in
// words, the Built on section, the evaluated configuration and version, and
// the Summary's configuration counts. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BuiltOn } from '../frontend/src/features/details/BuiltOnSection.js';
import { StudyQuality } from '../frontend/src/features/details/StudySections.js';
import {
  BUILT_ON_NOTE,
  SCOPE_CONFLICT_WORDS,
  baseCardChoice,
  builtOnBases,
  builtOnContent,
  scopeConflict
} from '../frontend/src/features/details/copy/builtOnCopy.js';
import {
  configurationHighlight,
  evaluatedConfiguration,
  evidenceAgeContext,
  measuredOn,
  replacesChain
} from '../frontend/src/features/details/copy/evidenceAgeCopy.js';
import { studyQuality } from '../frontend/src/features/details/copy/studyCopy.js';

// A small fictional registry in the shape of listModels (ModelEntry).
const SYN2 = {
  model_version: 'SynGPT-2.0',
  display_name: 'SynGPT-2.0',
  default_use_case: 'Discharge letter generation',
  replaces: 'SynGPT-1.0',
  use_cases: [
    { use_case: 'Clinician Facing CDSS', function_category: 'decision_support', intended_use_defined: false },
    { use_case: 'Discharge letter generation', function_category: 'documentation', intended_use_defined: false }
  ]
};
const SYN1 = { model_version: 'SynGPT-1.0', display_name: 'SynGPT-1.0', default_use_case: 'Clinician Facing CDSS', use_cases: [{ use_case: 'Clinician Facing CDSS', function_category: 'decision_support' }] };
const MEDICORE = {
  model_version: 'MediCore-2.5',
  display_name: 'MediCore 2.5',
  default_use_case: 'Discharge letter generation',
  use_cases: [
    { use_case: 'Discharge letter generation', function_category: 'documentation' },
    { use_case: 'Clinician Facing CDSS', function_category: 'decision_support' }
  ]
};
const V20 = { model_version: 'Vantrel-Triage-2.0', display_name: 'Vantrel Triage 2.0', built_on: ['SynGPT-1.0'], use_cases: [{ use_case: 'Emergency department triage', function_category: 'triage' }] };
const V21 = {
  model_version: 'Vantrel-Triage-2.1',
  display_name: 'Vantrel Triage 2.1',
  kind: 'product',
  built_on: ['SynGPT-2.0', 'Nowhere-1'],
  replaces: 'Vantrel-Triage-2.0',
  use_cases: [
    { use_case: 'Emergency department triage', function_category: 'triage', configuration: { configuration_id: 'cfg-vantrel-2026-05' } }
  ]
};
const QUILLARY = { model_version: 'Quillary-Scribe-1.0', display_name: 'Quillary Scribe 1.0', built_on: ['MediCore-2.5'], use_cases: [{ use_case: 'Discharge letter generation', function_category: 'documentation' }] };
const REGISTRY = [SYN1, SYN2, MEDICORE, V20, V21, QUILLARY];

const row = (fields = {}) => ({
  concept_id: 'BA41',
  perf: 0.81,
  ci_low: 0.76,
  ci_high: 0.86,
  performance_grade: 'B',
  evidence_grade: 'C',
  intended_use_level: 'in_scope',
  status: { overall: 'moderate', performance: 'strong', evidence: 'moderate', intended_use: 'in_scope' },
  provenance: { source: 'condition' },
  ...fields
});

// --------------------------------------------------------------- Built on

test('the base card: the same function category, else the default card, else the first', () => {
  assert.deepEqual(baseCardChoice(MEDICORE, 'documentation').useCase, 'Discharge letter generation');
  assert.equal(baseCardChoice(MEDICORE, 'documentation').reason, 'same_category');
  assert.equal(baseCardChoice(SYN2, 'decision_support').useCase, 'Clinician Facing CDSS');
  // A triage product on a model without a triage card: the model's default card, named as such.
  assert.deepEqual([baseCardChoice(SYN2, 'triage').useCase, baseCardChoice(SYN2, 'triage').reason], ['Discharge letter generation', 'default']);
  assert.deepEqual(
    [baseCardChoice({ ...SYN2, default_use_case: 'Gone' }, 'triage').useCase, baseCardChoice({ ...SYN2, default_use_case: 'Gone' }, 'triage').reason],
    ['Clinician Facing CDSS', 'first']
  );
  assert.equal(baseCardChoice({ ...SYN2, use_cases: [] }, 'triage'), null);
  const bases = builtOnBases(V21, V21.use_cases[0], REGISTRY);
  assert.deepEqual(bases.map((base) => [base.version, base.label, base.choice?.useCase ?? null]), [
    ['SynGPT-2.0', 'SynGPT-2.0', 'Discharge letter generation'],
    ['Nowhere-1', 'Nowhere-1', null]
  ]);
  assert.deepEqual(builtOnBases(MEDICORE, MEDICORE.use_cases[0], REGISTRY), [], 'a model without built_on has no section');
});

test('a scope conflict is named in words, never as a grade', () => {
  assert.equal(scopeConflict({ row: row(), baseRow: row(), baseHasIntendedUse: false }), 'not_stated');
  assert.equal(scopeConflict({ row: row({ intended_use_level: 'partially_in_scope' }), baseRow: row({ intended_use_level: 'out_of_scope' }) }), 'out_of_scope');
  assert.equal(scopeConflict({ row: row(), baseRow: row() }), null);
  assert.equal(scopeConflict({ row: row({ intended_use_level: 'out_of_scope' }), baseRow: row(), baseHasIntendedUse: false }), null, 'this card excludes it too');
  assert.equal(scopeConflict({ row: row(), hasIntendedUse: false, baseRow: row(), baseHasIntendedUse: false }), null, 'this card states no intended use');
  assert.equal(SCOPE_CONFLICT_WORDS.not_stated, 'The model it is built on is not stated for this use.');
  assert.equal(SCOPE_CONFLICT_WORDS.out_of_scope, 'The model it is built on marks this condition out of scope.');
});

test('the Built on content: the base card named, both results side by side, the conflict', () => {
  const [syn] = builtOnBases(V21, V21.use_cases[0], REGISTRY);
  const details = { metrics: row(), incidents: [] };
  const base = { metrics: row({ perf: 0.7, ci_low: 0.65, ci_high: 0.75, intended_use_level: null, status: { overall: 'weak', performance: 'moderate', evidence: 'weak' } }), incidents: [] };
  const content = builtOnContent({ base: syn, functionEntry: V21.use_cases[0], details, baseDetails: base, depth: 'plain' });
  assert.equal(content.lead, 'Built on SynGPT-2.0. It has no triage card, so this is its default card, Discharge letter generation, at this condition:');
  assert.deepEqual(content.rows.map((entry) => entry.label), ['Overview', 'Performance', 'Evidence', 'Intended use']);
  assert.deepEqual(content.rows[1].base, { status: 'moderate', word: 'Moderate', figure: '0.70 (0.65–0.75)' });
  assert.equal(content.rows[3].base.word, 'No statement', 'SynGPT-2.0 has no intended-use statement');
  assert.equal(content.conflict, SCOPE_CONFLICT_WORDS.not_stated);
  // Expert depth adds the grades; plain depth never shows a letter.
  const expert = builtOnContent({ base: syn, functionEntry: V21.use_cases[0], details, baseDetails: base, depth: 'expert' });
  assert.equal(expert.rows[2].own.figure, 'C');
  assert.equal(content.rows[2].own.figure, null);
  // A base without a card here, and a base still loading.
  const [, nowhere] = builtOnBases(V21, V21.use_cases[0], REGISTRY);
  assert.equal(builtOnContent({ base: nowhere, details }).lead, 'Built on Nowhere-1, which has no card here.');
  assert.equal(builtOnContent({ base: syn, functionEntry: V21.use_cases[0], details, baseDetails: null }).rows, null);
  const [medicore] = builtOnBases(QUILLARY, QUILLARY.use_cases[0], REGISTRY);
  assert.equal(
    builtOnContent({ base: medicore, functionEntry: QUILLARY.use_cases[0], details, baseDetails: base }).lead,
    'Built on MediCore 2.5. Its Discharge letter generation card, the same kind of function, at this condition:'
  );
});

test('the Built on section renders each base, the conflict, the comparison link, and the note', () => {
  const bases = builtOnBases(V21, V21.use_cases[0], REGISTRY);
  const details = { metrics: row(), incidents: [] };
  const html = renderToStaticMarkup(
    h(BuiltOn, {
      bases: [
        { base: bases[0], details: { metrics: row({ intended_use_level: 'out_of_scope' }), incidents: [] }, error: null, compareHref: './compare.html?cards=a' },
        { base: bases[1], details: null, error: null, compareHref: null }
      ],
      functionEntry: V21.use_cases[0],
      details,
      depth: 'plain'
    })
  );
  assert.match(html, /<h3 id="detail-built-on" class="group-heading">Built on<\/h3>/);
  assert.match(html, /<th scope="col">This card<\/th><th scope="col">SynGPT-2.0<\/th>/);
  assert.match(html, /The model it is built on is not stated for this use\./, 'SynGPT-2.0 states no intended use');
  assert.match(html, /<a class="built-on-compare" href="\.\/compare\.html\?cards=a">Compare with the base model<\/a>/);
  assert.match(html, /Built on Nowhere-1, which has no card here\./);
  assert.ok(html.includes(BUILT_ON_NOTE.replace('’', '&#x27;')) || html.includes(BUILT_ON_NOTE));
  assert.doesNotMatch(html, /use case/i);
  // While the base result loads, and when it fails.
  const loading = renderToStaticMarkup(h(BuiltOn, { bases: [{ base: bases[0], details: null, error: null, compareHref: null }], functionEntry: V21.use_cases[0], details, depth: 'plain' }));
  assert.match(loading, /Loading the result of SynGPT-2\.0…/);
  const failed = renderToStaticMarkup(h(BuiltOn, { bases: [{ base: bases[0], details: null, error: new Error('x'), compareHref: null }], functionEntry: V21.use_cases[0], details, depth: 'plain' }));
  assert.match(failed, /could not be loaded/);
  assert.equal(renderToStaticMarkup(h(BuiltOn, { bases: [], details, depth: 'plain' })), '');
});

// ------------------------------------------------------------ evidence age

test('the replaces chain and the card context', () => {
  assert.deepEqual(replacesChain(V21, REGISTRY), ['Vantrel-Triage-2.0']);
  assert.deepEqual(replacesChain({ model_version: 'A', replaces: 'B' }, [{ model_version: 'B', replaces: 'A' }]), ['B'], 'a loop ends the chain');
  const context = evidenceAgeContext(V21, V21.use_cases[0], REGISTRY);
  assert.equal(context.configurationId, 'cfg-vantrel-2026-05');
  assert.deepEqual(context.earlierVersions, ['Vantrel-Triage-2.0']);
  assert.equal(evidenceAgeContext(null, null, REGISTRY), null);
});

test('the evaluated configuration and version, in words (CONTRACT.md §28.5)', () => {
  const context = evidenceAgeContext(V21, V21.use_cases[0], REGISTRY);
  assert.deepEqual(evaluatedConfiguration({ configuration_id: 'cfg-vantrel-2026-05' }, context), { state: 'current', text: 'Current configuration (cfg-vantrel-2026-05)' });
  assert.deepEqual(evaluatedConfiguration({ configuration_id: 'cfg-vantrel-2026-01' }, context), {
    state: 'earlier',
    text: 'Earlier configuration (cfg-vantrel-2026-01; current cfg-vantrel-2026-05)'
  });
  assert.deepEqual(evaluatedConfiguration({}, context), { state: 'not_stated', text: 'Not stated' });
  const noRecord = evidenceAgeContext(QUILLARY, QUILLARY.use_cases[0], REGISTRY);
  assert.equal(evaluatedConfiguration({ configuration_id: 'cfg-x' }, noRecord).state, 'not_stated');
  assert.equal(measuredOn({ model_version: 'Vantrel-Triage-2.0' }, context), 'An earlier version (Vantrel Triage 2.0)');
  assert.equal(measuredOn({ model_version: 'SynGPT-2.0' }, context), 'SynGPT-2.0');
  assert.equal(measuredOn({ model_version: 'Vantrel-Triage-2.1' }, context), null);
  assert.equal(measuredOn({ model_version: null }, context), null);
});

test('Study quality shows the evidence age beside the study facts, without changing anything else', () => {
  const context = evidenceAgeContext(V21, V21.use_cases[0], REGISTRY);
  const study = {
    study_id: 'TRIAGE-SIM-2026',
    title: 'Vantrel emergency triage simulation (fictional)',
    design: 'simulation',
    sites: 1,
    conducted_by: 'developer',
    reporting_guideline: 'none',
    guideline_followed: null,
    risk_of_bias: 'unclear',
    model_version: 'Vantrel-Triage-2.0',
    configuration_id: 'cfg-vantrel-2026-01'
  };
  const linked = row({ appraisal: { study, study_adjustment: -0.04, applied: true, terms: null } });
  const facts = studyQuality(linked, 'plain', context).facts;
  assert.deepEqual(facts.slice(-2), [
    { label: 'Evaluated configuration', value: 'Earlier configuration (cfg-vantrel-2026-01; current cfg-vantrel-2026-05)' },
    { label: 'Measured on', value: 'An earlier version (Vantrel Triage 2.0)' }
  ]);
  // Without the card's context (exports, older callers) the study's own id is shown as before.
  assert.deepEqual(studyQuality(linked, 'plain').facts.at(-1), { label: 'Configuration evaluated', value: 'cfg-vantrel-2026-01' });
  const html = renderToStaticMarkup(h(StudyQuality, { row: linked, depth: 'plain', ageContext: context }));
  assert.match(html, /<dt>Evaluated configuration<\/dt><dd>Earlier configuration/);
  assert.doesNotMatch(html, /warning|Weak|Strong/);
});

test('the Summary names the configuration counts across the card, or nothing without them', () => {
  assert.equal(configurationHighlight(null), null);
  assert.equal(configurationHighlight({ current: 0, earlier: 0, not_stated: 0 }), null);
  const mixed = configurationHighlight({ current: 3, earlier: 2, not_stated: 1 });
  assert.equal(mixed.title, 'Measured on an earlier configuration: 2');
  assert.equal(mixed.text, 'Of 6 conditions with a study record: 3 on the current configuration, 2 on an earlier configuration, 1 not stated. Across the card.');
  assert.equal(mixed.tone, 'info');
  assert.equal(configurationHighlight({ current: 8, earlier: 0, not_stated: 0 }).title, 'Evaluated configuration');
  assert.equal(configurationHighlight({ current: 0, earlier: 0, not_stated: 1 }).text, 'Of 1 condition with a study record: 1 not stated. Across the card.');
});
