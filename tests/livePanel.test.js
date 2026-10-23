// The live interaction panel (§10 "I5 plugin"): its inputs accept ICD-11 codes and coarse lens values only, its
// view and DOM model show statuses, marks, warnings, safeguards, incidents,
// and the demonstration line, its controller looks up once per change and
// follows new dataset versions, and against a real backend it shows what the
// atlas card shows for the same condition, lens, and version.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { metricRowStatus } from '../frontend/src/design/status.js';
import { aboutResult, lensFallbackSentence } from '../frontend/src/features/details/copy/aboutResult.js';
import { describeSafeguards } from '../frontend/src/features/details/copy/safeguardCopy.js';
import { USE_CASE_REQUIREMENT, rankWarnings } from '../frontend/src/features/details/copy/warningCopy.js';
import { incidentsMark, incidentsMarkWord, openIncidentChip, sortIncidents } from '../frontend/src/features/details/copy/incidentCopy.js';
import { appRootFor, cardHref, createPanelController, errorKind, VERSION_CHECK_MS } from '../frontend/src/embed/panelController.js';
import { lookupBody, missingInput, parseCodes, readPanelInputs } from '../frontend/src/embed/panelInputs.js';
import { DEMO_LINE, findNodes, panelSummary, panelViewModel, renderPanel, textOf } from '../frontend/src/embed/panelView.js';
import { PRESETS, caseFromPreset, codesSettleNow, embedSnippet, matchingPreset, panelAttributes } from '../frontend/src/features/plugin/pluginCase.js';
import { apiClient, startTestBackend } from './support/backend.js';

const attributes = (values) => (name) => values[name] ?? null;
const inputsOf = (values) => readPanelInputs(attributes({ model: 'SynGPT-2.0', 'use-case': 'Clinician Facing CDSS', ...values }));
const resolveHref = (url) => cardHref(url, 'http://localhost:5173/');

// A lookup response as contract v1.8 serves it (CONTRACT.md §19), trimmed.
const INCIDENT = {
  incident_id: 'SI-2026-012',
  model_version: 'SynGPT-2.0',
  use_case: 'Clinician Facing CDSS',
  codes: ['5A11'],
  condition_ids: ['5A11'],
  chapter_id: null,
  lens: { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' },
  incident_type: 'developer_notice_or_recall',
  harm: 'none',
  status: 'open',
  severity: 'serious',
  source_type: 'developer_notice',
  source_reference: 'Fictional notice (synthetic)',
  study_id: null,
  reported_date: '2026-09-25',
  updated_date: null,
  summary: 'Synthetic example: a recalled app version.'
};
const CLOSED = { ...INCIDENT, incident_id: 'SI-2026-004', status: 'closed', severity: null, summary: 'Synthetic example: closed.' };
const RESPONSE = {
  dataset_version: '7',
  synthetic_data_notice: 'All data in Broad Modelcard is synthetic demonstration data.',
  disclaimer: 'Demonstration on synthetic data. Not for clinical use.',
  card: {
    model_version: 'SynGPT-2.0',
    use_case: 'Clinician Facing CDSS',
    display_name: 'SynGPT-2.0',
    kind: 'model',
    card_url: 'atlas.html?model=SynGPT-2.0&use_case=Clinician+Facing+CDSS&age=Age+65%2B'
  },
  lens: { context: 'Clinical', age: 'Age 65+', sex: 'Sex Female', ethnicity: 'All ethnicities' },
  conditions: [
    {
      code: '5A11',
      matched: true,
      concept_id: '5A11',
      pt: 'Type 2 diabetes mellitus',
      icd11_code: '5A11',
      anchor_id: '5A11',
      statuses: { overall: 'strong', performance: 'strong', evidence: 'weak', intended_use: 'in_scope' },
      safety: 'serious',
      warnings: [
        { code: 'clinician_review_required', relevance: 'High' },
        { code: 'wide_confidence_interval', relevance: 'Medium' },
        { code: 'limited_validation_depth', relevance: 'Medium' },
        { code: 'rare_condition_low_support', relevance: 'Low' }
      ],
      safeguards: [
        { id: 'ci-wide', priority: 'Important' },
        { id: 'evidence-weak', priority: 'Important' },
        { id: 'cdss-governance', priority: 'Important' }
      ],
      incidents: [INCIDENT, CLOSED],
      provenance: { source: 'condition', anchor_concept_id: null, rollup: null, lens_fallback: false },
      card_url: 'atlas.html?model=SynGPT-2.0&use_case=Clinician+Facing+CDSS&age=Age+65%2B&concept=5A11'
    },
    {
      code: '8B20',
      matched: true,
      concept_id: '8B20',
      pt: 'Stroke not known if ischaemic or haemorrhagic',
      icd11_code: '8B20',
      anchor_id: '8B20',
      statuses: { overall: 'no_data', performance: 'no_data', evidence: 'no_data', intended_use: null },
      safety: null,
      warnings: [],
      safeguards: [],
      incidents: [],
      provenance: null,
      card_url: 'atlas.html?concept=8B20'
    },
    { code: 'ZZ99', matched: false }
  ],
  combination: null
};

// ---------------------------------------------------------------- inputs

test('the panel takes ICD-11 codes and coarse lens values only; free text is dropped and never kept', () => {
  const inputs = inputsOf({
    codes: 'John Smith, 5a11; born 1950-01-01 GB61 5A11 call 0151 234 567, CA40.0',
    'age-group': 'elderly',
    sex: 'Female',
    ethnicity: 'black',
    depth: 'expert',
    version: 'staged:../../etc'
  });
  assert.deepEqual(inputs.codes, ['5A11', 'GB61', 'CA40.0']);
  assert.ok(inputs.ignored.codes >= 5, 'every word that is not a code is ignored');
  assert.deepEqual(inputs.lens, { age_group: null, sex: 'female', ethnicity: 'black' });
  assert.deepEqual(inputs.ignored.lens, ['age-group']);
  assert.equal(inputs.version, 'live', 'a malformed version is not passed on');
  assert.equal(inputs.depth, 'expert');

  // Nothing of the free text reaches the request or the panel.
  const body = JSON.stringify(lookupBody(inputs));
  const panel = textOf(renderPanel({ phase: 'ready', inputs, view: panelViewModel(RESPONSE, { inputs, resolveHref }) }));
  for (const fragment of ['John', 'Smith', 'born', '1950', '0151', 'elderly']) {
    assert.ok(!body.includes(fragment), `${fragment} stays out of the request`);
    assert.ok(!panel.includes(fragment), `${fragment} is not shown back`);
  }
  assert.match(panel, /entries ignored: not an ICD-11 code/);
  assert.match(panel, /The age group given is not a population group the panel knows, so it shows all patients on that axis/);
  assert.doesNotMatch(panel, /age-group/, 'the attribute name is put in words');

  // The request is the closed CDS Hooks–shaped body (R17).
  assert.deepEqual(lookupBody(inputs), {
    hook: 'broad-modelcard-lookup',
    context: {
      card: { model_version: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS' },
      conditions: ['5A11', 'GB61', 'CA40.0'].map((code) => ({ system: 'http://id.who.int/icd/release/11/mms', code })),
      population: { age_group: null, sex: 'female', ethnicity: 'black' }
    }
  });
  // Card ids with markup are refused; at most 8 codes go out.
  assert.equal(inputsOf({ model: '<img src=x onerror=alert(1)>' }).model, null);
  assert.equal(parseCodes(Array.from({ length: 10 }, (_, index) => `5A1${index}`).join(',')).codes.length, 8);
  assert.deepEqual(parseCodes('NOTE JOHN 1950 0151 BA41.Z 8b20').codes, ['BA41.Z', '8B20']);
  assert.equal(missingInput(inputsOf({ codes: 'diabetes' })), 'codes');
  assert.equal(missingInput(inputsOf({ model: '' , codes: '5A11' })), 'card');
});

// ---------------------------------------------------------------- view and DOM model

test('the panel shows statuses, marks, warnings, safeguards, incidents, links, and the disclaimer', () => {
  const inputs = inputsOf({ codes: '5A11,8B20,ZZ99', 'age-group': '65+', sex: 'female' });
  const view = panelViewModel(RESPONSE, { inputs, resolveHref, updatedAt: new Date(2026, 9, 12, 14, 32) });
  const [diabetes, stroke, unknown] = view.conditions;

  assert.deepEqual(view.card, {
    name: 'SynGPT-2.0',
    kind: 'Model',
    functionName: 'Clinician Facing CDSS',
    href: 'http://localhost:5173/atlas.html?model=SynGPT-2.0&use_case=Clinician+Facing+CDSS&age=Age+65%2B'
  });
  // Worded as on the atlas card since R3: the lens, then the prevalence.
  assert.equal(view.population, 'Age 65+, Female, default prevalence');
  assert.deepEqual(diabetes.statuses, { overall: 'strong', performance: 'strong', evidence: 'weak', intended_use: 'in_scope' });
  assert.equal(diabetes.safety, 'serious');
  assert.equal(diabetes.openIncidentText, '1 open serious incident');
  assert.deepEqual(diabetes.incidents.map((incident) => incident.id), ['SI-2026-012'], 'closed incidents are counted, not listed');
  assert.equal(diabetes.closedIncidents, 1);
  assert.equal(diabetes.requirement.title, 'Clinician review required');
  assert.deepEqual(diabetes.warnings.map((warning) => warning.title), ['High uncertainty', 'Limited validation depth']);
  assert.equal(diabetes.moreWarnings, 1);
  assert.deepEqual(diabetes.safeguards.map((safeguard) => safeguard.title), ['Tighten uncertainty monitoring', 'Strengthen validation depth']);
  assert.equal(diabetes.moreSafeguards, 1);
  assert.equal(diabetes.href, 'http://localhost:5173/atlas.html?model=SynGPT-2.0&use_case=Clinician+Facing+CDSS&age=Age+65%2B&concept=5A11');

  // A condition without a row is No data on every view, Intended use included (V1).
  assert.deepEqual(stroke.statuses, { overall: 'no_data', performance: 'no_data', evidence: 'no_data', intended_use: 'no_data' });
  assert.equal(stroke.safety, 'no_incidents', 'never green, never "safe"');
  assert.match(stroke.about, /No result for Stroke not known/);
  assert.deepEqual(unknown, { matched: false, code: 'ZZ99' });
  assert.deepEqual(view.combination, { stored: false }, 'two matched conditions without a stored row');

  const tree = renderPanel({ phase: 'ready', inputs, view });
  const text = textOf(tree);
  assert.ok(text.includes(DEMO_LINE));
  assert.equal(DEMO_LINE, 'Demonstration, synthetic data, not for clinical use');
  assert.match(text, /Dataset version 7, Updated 14:32/);
  assert.match(text, /ZZ99: not one of the ICD-11 conditions on this card/);
  assert.match(text, /\+1 more warning on the full card/);
  assert.match(text, /Developer notice or recall/);
  assert.match(text, /1 open serious incident/, 'the card header chip\'s words');
  assert.match(text, /Updated 25 Sept? 2026|Reported 25 Sept? 2026/);
  assert.doesNotMatch(text, /live monitoring|certified|approved/i);
  // Safeguards carry no priority word: the warnings hold the one severity scale, as on the condition card (A28).
  assert.doesNotMatch(text, /Important|Critical|Routine/);
  assert.ok(!('priority' in diabetes.safeguards[0]));

  // Every state is drawn with the shared mark, in the atlas's shapes.
  const marks = findNodes(tree, (node) => node.tag === 'svg' && node.attrs.class === 'status-mark').map((node) => node.attrs['data-status']);
  for (const status of ['strong', 'weak', 'in_scope', 'serious', 'no_data', 'no_incidents']) {
    assert.ok(marks.includes(status), `${status} is drawn`);
  }
  const serious = findNodes(tree, (node) => node.attrs?.['data-status'] === 'serious')[0];
  assert.ok(serious.children.some((child) => /mark-glyph-alert/.test(child.attrs.class)), 'Serious carries the warning glyph');

  // Links open the app's card in a new tab without an opener.
  const links = findNodes(tree, (node) => node.tag === 'a');
  assert.ok(links.length >= 2);
  for (const link of links) {
    assert.equal(link.attrs.rel, 'noopener noreferrer');
    assert.match(link.attrs.href, /^http:\/\/localhost:5173\/atlas\.html\?/);
  }
  assert.ok(links.some((link) => textOf(link) === 'Open the full card'));

  // Expert depth swaps summaries and adds actions; nothing else changes.
  const expert = panelViewModel(RESPONSE, { inputs: { ...inputs, depth: 'expert' }, resolveHref });
  assert.deepEqual(expert.conditions[0].statuses, diabetes.statuses);
  assert.notEqual(expert.conditions[0].warnings[0].text, diabetes.warnings[0].text);
  assert.ok(expert.conditions[0].safeguards[0].actions.length > 0);
});

test('a card without an intended-use statement says so on the Intended use row, not No data (v1.11)', () => {
  const inputs = inputsOf({ codes: '5A11,8B20,ZZ99', 'age-group': '65+', sex: 'female' });
  const response = { ...RESPONSE, card: { ...RESPONSE.card, intended_use_defined: false } };
  const view = panelViewModel(response, { inputs, resolveHref, updatedAt: null });
  const rows = findNodes(renderPanel({ phase: 'ready', view }), (node) => node.attrs?.class === 'p-view');
  const intendedUse = rows.filter((node) => /Intended use/.test(textOf(node)));
  assert.ok(intendedUse.length > 0);
  intendedUse.forEach((node) => assert.match(textOf(node), /Intended use\s*No statement/));
  assert.doesNotMatch(panelSummary({ phase: 'ready', view }), / overall/);

  const stated = panelViewModel(RESPONSE, { inputs, resolveHref, updatedAt: null });
  const statedRows = findNodes(renderPanel({ phase: 'ready', view: stated }), (node) => node.attrs?.class === 'p-view');
  assert.ok(statedRows.every((node) => !/No statement/.test(textOf(node))));
});

test('a glance lands on the answer: requirement once, combination first, an open incident before the grade (S8a)', () => {
  const inputs = inputsOf({ codes: '5A11,8B20,ZZ99', 'age-group': '65+', sex: 'female' });
  const view = panelViewModel(RESPONSE, { inputs, resolveHref });
  const tree = renderPanel({ phase: 'ready', inputs, view });

  // The function's requirement is the card's: said once, under the card, not per condition.
  assert.equal(view.requirement.title, 'Clinician review required');
  const requirements = findNodes(tree, (node) => node.attrs?.class === 'p-requirement');
  assert.equal(requirements.length, 1);
  assert.ok(findNodes(findNodes(tree, (node) => node.attrs?.class === 'p-card')[0], (node) => node.attrs?.class === 'p-requirement').length === 1);

  // An open Serious incident leads its condition, before the overall result (grades unchanged).
  const [diabetes, stroke] = findNodes(tree, (node) => node.attrs?.class === 'p-condition');
  const classes = diabetes.children.map((child) => child.attrs?.class);
  assert.ok(classes.indexOf('p-safety is-alert') > -1 && classes.indexOf('p-safety is-alert') < classes.indexOf('p-lead'), 'Serious before the grade');
  assert.equal(view.conditions[0].statuses.overall, 'strong', 'the grade itself is unchanged');
  // No incident: the quiet line stays under the views.
  const quiet = stroke.children.map((child) => child.attrs?.class);
  assert.ok(quiet.indexOf('p-safety') > quiet.indexOf('p-views'));

  // Links say what they open and carry a key that keeps the focus across renders.
  const links = findNodes(tree, (node) => node.tag === 'a');
  const names = links.map(textOf);
  assert.equal(new Set(names).size, names.length, 'no two links share a name');
  assert.ok(names.includes('Open Type 2 diabetes mellitus on the card'));
  assert.ok(links.every((link) => link.attrs['data-focus-key']));
  assert.equal(textOf(findNodes(tree, (node) => node.attrs?.class === 'p-system')[0]), 'SynGPT-2.0 Model', 'name and kind are two words');

  // Two matched conditions: the combination comes before the single conditions.
  const body = tree.children.map((child) => child.attrs?.class ?? child.tag);
  assert.ok(body.indexOf('p-combination is-absent') < body.indexOf('p-conditions'));

  // Two or more conditions: the open incidents of the case lead, before the combination's grade.
  const caseSafety = findNodes(tree, (node) => node.attrs?.class === 'p-safety is-alert p-case-safety');
  assert.equal(caseSafety.length, 1);
  assert.match(textOf(caseSafety[0]), /^Safety in this caseSerious1 open serious incident: Type 2 diabetes mellitus$/);
  assert.ok(tree.children.indexOf(caseSafety[0]) < body.indexOf('p-combination is-absent'), 'the case safety line comes before the combination');
  const single = renderPanel({ phase: 'ready', inputs, view: { ...view, conditions: view.conditions.slice(0, 1), combination: null } });
  assert.equal(findNodes(single, (node) => node.attrs?.class === 'p-safety is-alert p-case-safety').length, 0, 'one condition: its own line leads');

  // The status region's sentence: the result and any open incident per condition.
  assert.equal(
    panelSummary({ phase: 'ready', view }),
    'SynGPT-2.0, Clinician-Facing CDSS. Type 2 diabetes mellitus: Strong on Overview, 1 open serious incident. Stroke not known if ischaemic or haemorrhagic: No data on Overview. ZZ99 is not on this card.'
  );
  assert.equal(panelSummary({ phase: 'loading', inputs }), null, 'nothing is announced while loading');
  assert.match(panelSummary({ phase: 'error', error: { kind: 'unavailable' } }), /not reachable/);
});

test('incidents read as on the atlas card: closed-only is "No open incidents", none is "No reported incidents"', () => {
  const inputs = inputsOf({ codes: '5A11,8B20' });
  const [diabetes, stroke] = RESPONSE.conditions;
  const closedOnly = { ...RESPONSE, conditions: [{ ...diabetes, safety: null, incidents: [CLOSED] }, stroke] };
  const view = panelViewModel(closedOnly, { inputs, resolveHref });
  const [closed, none] = view.conditions;
  assert.equal(closed.safety, 'no_incidents');
  assert.equal(closed.safetyWord, 'No open incidents');
  assert.deepEqual(closed.incidents, [], 'closed incidents are listed on the full card only');
  assert.equal(none.safetyWord, null, 'the mark\'s own word: No reported incidents');

  const safetyLines = findNodes(renderPanel({ phase: 'ready', inputs, view }), (node) => node.attrs?.class === 'p-safety').map(textOf);
  assert.equal(safetyLines.length, 2);
  assert.match(safetyLines[0], /^SafetyNo open incidents1 closed incident on the full card$/);
  assert.doesNotMatch(safetyLines[0], /No reported incidents/);
  assert.match(safetyLines[1], /^SafetyNo reported incidents$/);

  // Serious first, then Caution, as the card sorts them; the card's type and status words.
  const caution = { ...INCIDENT, incident_id: 'SI-2026-020', severity: 'caution', status: 'mitigated', incident_type: 'performance_drift', updated_date: '2026-10-01' };
  const mixed = panelViewModel(
    { ...RESPONSE, conditions: [{ ...diabetes, incidents: [caution, CLOSED, INCIDENT] }] },
    { inputs: inputsOf({ codes: '5A11' }), resolveHref }
  );
  assert.deepEqual(
    mixed.conditions[0].incidents.map(({ id, mark, type, status }) => [id, mark, type, status]),
    [
      ['SI-2026-012', 'serious', 'Developer notice or recall', 'Open'],
      ['SI-2026-020', 'caution', 'Performance drift', 'Mitigated']
    ]
  );
  assert.match(mixed.conditions[0].incidents[1].date, /^Updated 1 Oct 2026$/);
});

test('the combination: stored result, or No stored combination for two matched conditions', () => {
  const inputs = inputsOf({ codes: '5A11,GB61' });
  const two = { ...RESPONSE, conditions: [RESPONSE.conditions[0], { ...RESPONSE.conditions[0], code: 'GB61', icd11_code: 'GB61', concept_id: 'GB61', anchor_id: 'GB61', pt: 'Chronic kidney disease' }] };
  const absent = panelViewModel(two, { inputs, resolveHref });
  assert.deepEqual(absent.combination, { stored: false });
  assert.match(textOf(renderPanel({ phase: 'ready', inputs, view: absent })), /No stored combination/);

  const stored = panelViewModel(
    {
      ...two,
      combination: {
        combination_key: '5A11+GB61',
        label: 'Type 2 diabetes mellitus + Chronic kidney disease',
        concept_ids: ['5A11', 'GB61'],
        statuses: { overall: 'moderate', performance: 'moderate', evidence: 'moderate', intended_use: 'in_scope' },
        safety: null,
        warnings: [{ code: 'clinician_review_required', relevance: 'High' }, { code: 'multimorbidity_synthetic_demo', relevance: 'Medium' }],
        safeguards: [{ id: 'cdss-governance', priority: 'Important' }],
        provenance: { source: 'multimorbidity', lens_fallback: false },
        card_url: 'atlas.html?mode=multimorbidity&selected=5A11,GB61'
      }
    },
    { inputs, resolveHref }
  );
  assert.equal(stored.combination.stored, true);
  assert.equal(stored.combination.statuses.overall, 'moderate');
  assert.deepEqual(stored.combination.warnings.map((warning) => warning.title), ['Synthetic multimorbidity data']);
  assert.equal(stored.combination.href, 'http://localhost:5173/atlas.html?mode=multimorbidity&selected=5A11,GB61');
  assert.equal(stored.combination.fallback, null);

  // Two codes of one condition (a category and its anchor) are no combination.
  const oneCondition = panelViewModel(
    { ...RESPONSE, conditions: [RESPONSE.conditions[0], { ...RESPONSE.conditions[0], code: '5A11.0', icd11_code: '5A11.0', concept_id: '5A11.0', anchor_id: '5A11' }] },
    { inputs: inputsOf({ codes: '5A11,5A11.0' }), resolveHref }
  );
  assert.equal(oneCondition.combination, null);
});

test('a row that stands in for the exact population says so, as on the card (lens fallback)', () => {
  const inputs = inputsOf({ codes: '5A11,GB61', 'age-group': '65+', sex: 'female' });
  const fallback = { source: 'condition', lens_fallback: true };
  const response = {
    ...RESPONSE,
    conditions: [
      { ...RESPONSE.conditions[0], provenance: fallback },
      { ...RESPONSE.conditions[0], code: 'GB61', icd11_code: 'GB61', concept_id: 'GB61', anchor_id: 'GB61', provenance: { source: 'condition', lens_fallback: false } }
    ],
    combination: {
      label: 'Type 2 diabetes mellitus + Chronic kidney disease',
      concept_ids: ['5A11', 'GB61'],
      statuses: { overall: 'moderate', performance: 'moderate', evidence: 'moderate', intended_use: 'in_scope' },
      warnings: [],
      safeguards: [],
      provenance: { source: 'multimorbidity', lens_fallback: true },
      card_url: null
    }
  };
  const view = panelViewModel(response, { inputs, resolveHref });
  assert.equal(view.conditions[0].fallback, lensFallbackSentence('plain'));
  assert.equal(view.conditions[1].fallback, null);
  assert.equal(view.combination.fallback, lensFallbackSentence('plain'));
  const text = textOf(renderPanel({ phase: 'ready', inputs, view }));
  assert.equal(text.split(lensFallbackSentence('plain')).length - 1, 2);
  const expert = panelViewModel(response, { inputs: { ...inputs, depth: 'expert' }, resolveHref });
  assert.equal(expert.combination.fallback, lensFallbackSentence('expert'));
});

test('every state carries the demonstration line; failures say what happened', () => {
  const inputs = inputsOf({ codes: '5A11' });
  const states = [
    { phase: 'empty', inputs: inputsOf({ codes: '' }), missing: 'codes' },
    { phase: 'empty', inputs: inputsOf({ model: '' }), missing: 'card' },
    { phase: 'loading', inputs },
    { phase: 'error', inputs, error: { kind: 'unavailable' } },
    { phase: 'error', inputs, error: { kind: 'invalid', detail: 'context.conditions: at most 12 codes.' } },
    { phase: 'error', inputs, error: { kind: 'unknown_card' } },
    { phase: 'error', inputs, error: { kind: 'local_only' } },
    { phase: 'ready', inputs, view: panelViewModel(RESPONSE, { inputs, resolveHref }) }
  ];
  const texts = states.map((state) => textOf(renderPanel(state)));
  texts.forEach((text) => assert.ok(text.includes(DEMO_LINE), text.slice(0, 80)));
  assert.match(texts[0], /Add one or more ICD-11 codes/);
  assert.match(texts[1], /Choose an AI system/);
  assert.match(texts[2], /Looking up the card/);
  assert.match(texts[3], /backend is not reachable[\s\S]*npm run dev/);
  assert.match(texts[4], /at most 12 codes/);
  assert.match(texts[5], /has no card for this AI system and function/);
  assert.doesNotMatch(texts.join(' '), /registry/, 'no maintainer jargon on the panel');
  const unknown = textOf(renderPanel({ phase: 'error', inputs: inputsOf({ model: 'Host-Typed-Name-42', 'use-case': 'Some Function', codes: '5A11' }), error: { kind: 'unknown_card' } }));
  assert.doesNotMatch(unknown, /Host-Typed-Name-42|Some Function/, 'names the registry does not know are not shown back');
  assert.equal(renderPanel(states[2]).attrs['aria-busy'], 'true');

  assert.equal(errorKind({ code: 'backend_unavailable', status: 0 }), 'unavailable');
  assert.equal(errorKind({ code: 'invalid_selection', status: 422 }), 'invalid');
  assert.equal(errorKind({ code: 'unknown_use_case', status: 404 }), 'unknown_card');
  assert.equal(errorKind({ code: 'not_found', status: 404 }), 'no_lookup');
  assert.equal(errorKind({ code: 'local_only', status: 403 }), 'local_only');
});

test('card links resolve against the app root, not the embedding page', () => {
  assert.equal(appRootFor('/api/v1', 'http://localhost:5173/some/host/page.html'), 'http://localhost:5173/');
  assert.equal(appRootFor('https://example.test/bmc/api/v1', 'http://other.test/'), 'https://example.test/bmc/');
  assert.equal(cardHref('atlas.html?concept=5A11', 'http://localhost:5173/'), 'http://localhost:5173/atlas.html?concept=5A11');
  assert.equal(cardHref('javascript:alert(1)', 'http://localhost:5173/'), null);
  assert.equal(cardHref(null, 'http://localhost:5173/'), null);
});

// ---------------------------------------------------------------- controller

function fakeTimers() {
  const intervals = new Map();
  let next = 1;
  return {
    setInterval: (fn, ms) => {
      intervals.set(next, { fn, ms });
      return next++;
    },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: () => 0,
    clearTimeout: () => {},
    tick: async () => {
      for (const { fn } of intervals.values()) await fn();
    },
    intervals
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the controller looks up once per change and follows new dataset versions (R15)', async () => {
  let version = '7';
  const calls = { lookup: [], meta: 0 };
  const client = {
    lookup: async (body, options) => {
      calls.lookup.push({ body, options });
      return { ...RESPONSE, dataset_version: version };
    },
    getMeta: async () => {
      calls.meta += 1;
      return { dataset_version: version };
    }
  };
  const timers = fakeTimers();
  const focus = new EventTarget();
  const states = [];
  let clock = Date.UTC(2026, 9, 12, 12, 0);
  const controller = createPanelController({
    createClient: () => client,
    onState: (state) => states.push(state),
    timers,
    win: focus,
    doc: null,
    now: () => new Date(clock),
    pageHref: () => 'http://localhost:5173/plugin.html'
  });

  controller.setInputs(inputsOf({ codes: '5A11' }));
  controller.connect();
  await settle();
  assert.equal(calls.lookup.length, 1, 'connect and the first inputs make one lookup');
  assert.equal(calls.lookup[0].options.version, 'live');
  assert.equal(controller.state.phase, 'ready');
  assert.equal([...timers.intervals.values()][0].ms, VERSION_CHECK_MS);
  assert.ok(VERSION_CHECK_MS <= 15 * 60 * 1000, 'within the 15-minute freshness budget (D5)');

  // Several attribute changes in one task: one lookup.
  controller.setInputs(inputsOf({ codes: '5A11,GB61' }));
  controller.setInputs(inputsOf({ codes: '5A11,GB61', 'age-group': '65+' }));
  await settle();
  assert.equal(calls.lookup.length, 2);
  assert.equal(calls.lookup[1].body.context.population.age_group, '65+');

  // Depth alone re-renders without a request.
  controller.setInputs(inputsOf({ codes: '5A11,GB61', 'age-group': '65+', depth: 'expert' }));
  await settle();
  assert.equal(calls.lookup.length, 2);
  assert.equal(controller.state.view.depth, 'expert');

  // The periodic check: same version, no lookup; a new version, one lookup.
  await timers.tick();
  await settle();
  assert.equal(calls.meta, 1);
  assert.equal(calls.lookup.length, 2);
  version = '8';
  // focus and visibilitychange together, right after the periodic check: merged into it.
  focus.dispatchEvent(new Event('focus'));
  await settle();
  assert.equal(calls.meta, 1, 'a trigger right after a check is merged into it');
  clock += 60 * 1000;
  focus.dispatchEvent(new Event('focus'));
  focus.dispatchEvent(new Event('focus'));
  await settle();
  await settle();
  assert.equal(calls.meta, 2, 'two triggers at once: one /meta read');
  assert.equal(calls.lookup.length, 3, 'focus picks up a publish at once');
  assert.equal(controller.state.view.datasetVersion, '8');

  // The same version again: no lookup, the answer is confirmed.
  clock += 60 * 1000;
  await controller.checkVersion();
  await settle();
  assert.equal(calls.meta, 3);
  assert.equal(calls.lookup.length, 3);

  controller.disconnect();
  assert.equal(timers.intervals.size, 0);
});

test('the controller reports a backend that is down, and retries on focus', async () => {
  let up = false;
  const client = {
    lookup: async () => {
      if (!up) throw Object.assign(new Error('down'), { code: 'backend_unavailable', status: 0 });
      return RESPONSE;
    },
    getMeta: async () => ({ dataset_version: '7' })
  };
  const focus = new EventTarget();
  const controller = createPanelController({ createClient: () => client, onState: () => {}, timers: fakeTimers(), win: focus, doc: null });
  controller.setInputs(inputsOf({ codes: '5A11' }));
  controller.connect();
  await settle();
  assert.equal(controller.state.phase, 'error');
  assert.equal(controller.state.error.kind, 'unavailable');
  up = true;
  focus.dispatchEvent(new Event('focus'));
  await settle();
  assert.equal(controller.state.phase, 'ready');
  controller.disconnect();
});

/** A client whose lookups wait until the test resolves them; aborts reject as fetch does. */
function heldClient({ version = () => '7' } = {}) {
  const pending = [];
  const calls = { lookup: [], meta: [] };
  return {
    pending,
    calls,
    lookup(body, options) {
      calls.lookup.push({ body, options });
      return new Promise((resolve, reject) => {
        const entry = {
          codes: body.context.conditions.map((condition) => condition.code).join('+'),
          resolve: () => resolve({ ...RESPONSE, dataset_version: options.version === 'live' ? version() : options.version })
        };
        pending.push(entry);
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    },
    getMeta: async (params, options) => {
      calls.meta.push(options);
      return { dataset_version: version() };
    }
  };
}

test('going back to the case on screen drops a lookup for another case still in flight', async () => {
  const client = heldClient();
  const controller = createPanelController({ createClient: () => client, onState: () => {}, timers: fakeTimers(), win: null, doc: null });
  controller.setInputs(inputsOf({ codes: '5A11' }));
  controller.connect();
  await settle();
  client.pending.shift().resolve();
  await settle();
  controller.setInputs(inputsOf({ codes: '5A11,GB61' }));
  await settle();
  assert.equal(controller.state.refreshing, true);
  controller.setInputs(inputsOf({ codes: '5A11' }));
  await settle();
  assert.deepEqual(controller.state.inputs.codes, ['5A11']);
  assert.equal(controller.state.refreshing, false, 'nothing is updating any more');
  client.pending.shift().resolve(); // the superseded answer arrives anyway
  await settle();
  assert.equal(controller.state.phase, 'ready');
  assert.deepEqual(controller.state.inputs.codes, ['5A11']);
  assert.equal(client.calls.lookup.length, 2);
  controller.disconnect();
});

test('leaving the page during a refresh does not leave the panel "Updating"; no lookup after it left', async () => {
  let version = '7';
  const client = heldClient({ version: () => version });
  const focus = new EventTarget();
  const controller = createPanelController({ createClient: () => client, onState: () => {}, timers: fakeTimers(), win: focus, doc: null });
  controller.setInputs(inputsOf({ codes: '5A11' }));
  controller.connect();
  await settle();
  client.pending.shift().resolve();
  await settle();
  controller.refresh();
  assert.equal(controller.state.refreshing, true);
  controller.disconnect();
  assert.equal(controller.state.refreshing, false);
  controller.setInputs(inputsOf({ codes: '5A11' }));
  controller.connect();
  await settle();
  assert.equal(controller.state.refreshing, false, 'the same case is on screen; nothing to update');

  // A check that resolves after the panel left starts no lookup.
  version = '8';
  const lookups = client.calls.lookup.length;
  const check = controller.checkVersion();
  controller.disconnect();
  await check;
  await settle();
  assert.equal(client.calls.lookup.length, lookups);
  assert.ok(client.calls.meta.at(-1).signal?.aborted, 'the /meta read is aborted with the panel');
});

test('a staged panel compares live versions with live versions', async () => {
  let version = '7';
  const client = heldClient({ version: () => version });
  const controller = createPanelController({ createClient: () => client, onState: () => {}, timers: fakeTimers(), win: null, doc: null });
  controller.setInputs(inputsOf({ codes: '5A11', version: 'staged:41' }));
  controller.connect();
  await settle();
  client.pending.shift().resolve();
  await settle();
  assert.equal(controller.state.view.datasetVersion, 'staged:41');
  await controller.checkVersion();
  await controller.checkVersion();
  assert.equal(client.calls.lookup.length, 1, 'an unchanged live version is no reason to look up again');
  version = '8';
  await controller.checkVersion();
  await settle();
  assert.equal(client.calls.lookup.length, 2, 'a staged preview follows a live publish (CONTRACT.md §2)');
  controller.disconnect();
});

// ---------------------------------------------------------------- demo page case

test('the demo page passes typed codes on only once the last code is complete (S8a)', () => {
  // A code being typed waits (a pause or leaving the field), so "CA40." is not flagged or looked up half-way.
  for (const partial of ['C', 'CA40', 'CA40.', '5A11, GB6']) assert.equal(codesSettleNow(partial), false, partial);
  for (const done of ['', '5A11,', '5A11, ', '5A11;']) assert.equal(codesSettleNow(done), true, JSON.stringify(done));
});

test('the demo presets are synthetic cases: codes and coarse lens values only', () => {
  for (const preset of PRESETS) {
    // A preset may name a care setting by its code (contract v1.14).
    assert.deepEqual(Object.keys(preset).filter((key) => key !== 'setting').sort(), ['codes', 'id', 'lens', 'model', 'note', 'title', 'useCase']);
    const current = caseFromPreset(preset);
    assert.equal(matchingPreset(current)?.id, preset.id);
    const attrs = panelAttributes(current);
    const inputs = readPanelInputs((name) => attrs[name] ?? null);
    assert.deepEqual(inputs.codes, preset.codes);
    assert.equal(inputs.ignored.codes, 0);
    assert.deepEqual(inputs.ignored.lens, []);
  }
  const edited = { ...caseFromPreset(PRESETS[0]), codesText: '5A11, a note about the patient' };
  assert.equal(matchingPreset(edited)?.id, PRESETS[0].id, 'free text is not part of the case');
  assert.equal(panelAttributes(edited).codes, '5A11');
  const snippet = embedSnippet(caseFromPreset(PRESETS[1]), 'http://localhost:5173/embed/bmc-live-panel.js');
  assert.match(snippet, /<bmc-live-panel\n {2}model="SynGPT-2.0"\n {2}use-case="Clinician Facing CDSS"\n {2}codes="5A11,GB61">/);
});

// ---------------------------------------------------------------- real backend: same as the atlas card

let backend;
let client;

before(async () => {
  backend = await startTestBackend();
  client = apiClient(backend.origin);
});

after(async () => {
  await backend?.stop();
});

const LENS = { '0-17': 'Age 0-17', '18-39': 'Age 18-39', '40-64': 'Age 40-64', '65+': 'Age 65+' };
const SEX = { female: 'Sex Female', male: 'Sex Male' };

/** What the atlas detail card presents for a MetricRow (DetailCard.jsx and ResultSections.jsx). */
function detailCardPresentation(row, incidents) {
  const views = ['overall', 'performance', 'evidence', 'intended_use'];
  const findings = (row?.warnings ?? []).filter((warning) => warning.code !== USE_CASE_REQUIREMENT);
  const requirement = row?.warnings?.find((warning) => warning.code === USE_CASE_REQUIREMENT);
  return {
    statuses: Object.fromEntries(views.map((view) => [view, row ? metricRowStatus(row, view) : 'no_data'])),
    requirement: requirement ? rankWarnings([requirement])[0].title : null,
    warnings: rankWarnings(findings).map((warning) => warning.title),
    safeguards: describeSafeguards(row?.safeguards).map((safeguard) => safeguard.title),
    // DetailCard.jsx's Safety header and chip, IncidentList.js's order (closed ones are on the card only).
    safety: incidentsMark(incidents),
    safetyWord: incidentsMarkWord(incidents),
    openChip: openIncidentChip(incidents)?.text ?? null,
    incidents: sortIncidents(incidents).filter((incident) => incident.severity).map((incident) => incident.incident_id),
    closed: incidents.filter((incident) => !incident.severity).length,
    // The card's About this result says the fallback sentence when the row stands in for the population.
    fallback: row ? aboutResult({ concept: null, row, depth: 'plain' }).includes(lensFallbackSentence('plain')) : false
  };
}

/** Demo pack v2 cases whose only incident is closed (SI-2026-014, SI-2026-004): "No open incidents" on both. */
const CLOSED_ONLY_CASES = [
  { id: 'closed-chapter', model: 'Quillary-Scribe-1.0', useCase: 'Discharge letter generation', codes: ['BA41'], lens: { age_group: null, sex: null, ethnicity: null } },
  { id: 'closed-children', model: 'SynGPT-1.0', useCase: 'Clinician Facing CDSS', codes: ['CA40.0'], lens: { age_group: '0-17', sex: null, ethnicity: null } }
];

/** A stored combination served at a population it has no row for: the all-population row, flagged (CONTRACT.md §8). */
const FALLBACK_CASE = { id: 'combination-fallback', model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS', codes: ['5A11', 'GB61'], lens: { age_group: '65+', sex: 'female', ethnicity: null } };

test('for the demo cases, the panel shows what the atlas card shows (same condition, lens, version)', async () => {
  const { models } = await client.listModels();
  const cards = new Set(models.flatMap((entry) => entry.use_cases.map((useCase) => `${entry.model_version}|${useCase.use_case}`)));
  const cases = [...PRESETS, ...CLOSED_ONLY_CASES, FALLBACK_CASE].filter((preset) => cards.has(`${preset.model}|${preset.useCase}`));
  assert.ok(cases.length >= 2, 'the SynGPT-2.0 cases exist on the seed and the demo store');
  let checked = 0;
  let closedOnly = 0;
  let closedOnlyStored = 0;
  let fallbacks = 0;
  for (const preset of cases) {
    const current = caseFromPreset(preset);
    const attrs = panelAttributes(current);
    const inputs = readPanelInputs((name) => attrs[name] ?? null);
    const response = await client.lookup(lookupBody(inputs));
    const view = panelViewModel(response, { inputs, resolveHref });
    const lens = { age: LENS[inputs.lens.age_group] ?? 'All ages', sex: SEX[inputs.lens.sex] ?? 'All sexes', ethnicity: 'All ethnicities' };
    for (const [index, condition] of response.conditions.entries()) {
      assert.equal(condition.matched, true, `${preset.id}: ${condition.code} matches`);
      const details = await client.getConceptMetrics({ model: preset.model, useCase: preset.useCase, conceptId: condition.concept_id, ...lens });
      assert.equal(details.dataset_version, response.dataset_version);
      const card = detailCardPresentation(details.metrics, details.incidents);
      const panel = view.conditions[index];
      assert.deepEqual(panel.statuses, card.statuses, `${preset.id} ${condition.code} statuses`);
      assert.equal(panel.requirement?.title ?? null, card.requirement);
      assert.deepEqual(panel.warnings.map((warning) => warning.title), card.warnings.slice(0, 2), `${preset.id} ${condition.code} warnings`);
      assert.equal(panel.moreWarnings, Math.max(0, card.warnings.length - 2));
      assert.deepEqual(panel.safeguards.map((safeguard) => safeguard.title), card.safeguards.slice(0, 2));
      assert.equal(panel.moreSafeguards, Math.max(0, card.safeguards.length - 2));
      assert.equal(panel.safety, card.safety, `${preset.id} ${condition.code} safety`);
      assert.equal(panel.safetyWord, card.safetyWord, `${preset.id} ${condition.code} safety word`);
      assert.equal(panel.openIncidentText, card.openChip);
      assert.deepEqual(panel.incidents.map((incident) => incident.id), card.incidents);
      assert.equal(panel.closedIncidents, card.closed);
      assert.equal(panel.fallback !== null, card.fallback, `${preset.id} ${condition.code} lens fallback`);
      if (panel.safetyWord === 'No open incidents') closedOnly += 1;
      // A seed-only store has the card but not demo pack v2's incidents.
      if (CLOSED_ONLY_CASES.includes(preset) && card.closed > 0) closedOnlyStored += 1;
      checked += 1;
    }
    if (response.conditions.length >= 2) {
      const stored = await client.getMultimorbidityCombination({
        model: preset.model,
        useCase: preset.useCase,
        selected: response.conditions.map((condition) => condition.anchor_id),
        ...lens
      });
      if (stored.metrics) {
        const card = detailCardPresentation(stored.metrics, []);
        assert.deepEqual(view.combination.statuses, card.statuses, `${preset.id} combination statuses`);
        assert.deepEqual(view.combination.warnings.map((warning) => warning.title), card.warnings.slice(0, 2));
        assert.deepEqual(view.combination.safeguards.map((safeguard) => safeguard.title), card.safeguards.slice(0, 2));
        assert.equal(view.combination.fallback !== null, card.fallback, `${preset.id} combination lens fallback`);
        if (card.fallback) fallbacks += 1;
      } else {
        assert.deepEqual(view.combination, { stored: false });
      }
    }
  }
  assert.ok(checked >= 3);
  if (closedOnlyStored > 0) {
    assert.ok(closedOnly >= 1, 'a closed-only condition reads "No open incidents" on the panel and the card');
  }
  if (cases.includes(FALLBACK_CASE)) {
    assert.ok(fallbacks >= 1, 'the combination served by lens fallback says so on the panel and the card');
  }
});

test('the panel root resets every inherited text property, so host rules on the element do not reach it (S8a)', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../frontend/src/embed/panel.css', import.meta.url), 'utf8');
  const root = css.match(/\n\.p-panel \{([\s\S]*?)\n\}/)[1];
  for (const property of ['font-family', 'font-size', 'font-style', 'font-variant', 'font-weight', 'line-height', 'color', 'letter-spacing', 'word-spacing', 'text-transform', 'text-indent', 'text-align', 'white-space', 'visibility']) {
    assert.match(root, new RegExp(`\\n\\s*${property}:`), `.p-panel sets ${property}`);
  }
  const page = await readFile(new URL('../frontend/embed-test.html', import.meta.url), 'utf8');
  assert.match(page, /bmc-live-panel[^{]*\{[^}]*text-transform: uppercase/, 'the test page puts a host rule on the element itself');
});

test('the panel keeps the atlas type sizes on any host: px tokens, not rem (the host root font size)', async () => {
  const { readFile } = await import('node:fs/promises');
  const tokens = await readFile(new URL('../frontend/src/styles/tokens.css', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../frontend/src/embed/panel.css', import.meta.url), 'utf8');
  const sizes = [...tokens.matchAll(/(--fs-[a-z0-9]+):\s*([\d.]+)rem/g)];
  assert.ok(sizes.length >= 5);
  for (const [, name, rem] of sizes) {
    assert.match(panel, new RegExp(`${name}: ${Number(rem) * 16}px;`), `${name} is ${Number(rem) * 16}px inside the panel`);
  }
});

test('the built panel script keeps the exports embed/index.js promises', async () => {
  const { readFile } = await import('node:fs/promises');
  const entry = await readFile(new URL('../frontend/src/embed/index.js', import.meta.url), 'utf8');
  const config = await readFile(new URL('../frontend/vite.config.js', import.meta.url), 'utf8');
  assert.match(entry, /export \{ BmcLivePanel, PANEL_TAG \}/);
  // Vite app builds drop entry exports unless the entry signatures are preserved.
  assert.match(config, /preserveEntrySignatures: 'exports-only'/);
});
