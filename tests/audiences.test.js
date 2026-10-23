// Release 0.5 phase Q5 (G7, G12; CONTRACT.md §30): the five
// audience presets and their condition-card layouts, the audience summaries
// (each figure equals the figure of the read it comes from), the guide "How
// to read a card" (shown once per browser, reopenable, one source of words),
// the data client's audience reads, and the static demo's words for them.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApiAdapter } from '../frontend/src/api/apiAdapter.js';
import { createDataClient } from '../frontend/src/api/dataClient.js';
import { STATIC_REASONS, STATIC_UNAVAILABLE, createStaticAdapter } from '../frontend/src/api/staticAdapter.js';
import { withProfileDefaults } from '../frontend/src/app/profileDefaults.js';
import { parseStartupParams } from '../frontend/src/app/startupParams.js';
import { legendMeaning } from '../frontend/src/features/atlas/legendEntries.js';
import {
  DECLARED,
  GUIDE_STEPS,
  NO_DATA_MEANING,
  NOT_SAFE_MEANING,
  SYNTHETIC_NOT_CLINICAL,
  guideMark,
  shouldShowGuide
} from '../frontend/src/features/guide/guideCopy.js';
import { AUDIENCES, AUDIENCE_IDS, audiencePreset, cardLayout } from '../frontend/src/features/profile/audience.js';
import { AUDIENCE_CHOICES } from '../frontend/src/features/profile/defaultsModel.js';
import { createProfileStore, normalizeDefaults, normalizeProfile, profileFile } from '../frontend/src/features/profile/profile.js';
import AudienceSummary from '../frontend/src/features/summary/AudienceSummary.js';
import {
  AUDIENCE_READS,
  NO_DATA_DECLARATIONS,
  audienceSummary,
  incidentsByMonth,
  incidentStatusCounts,
  sharesText,
  studyMix
} from '../frontend/src/features/summary/audienceModel.js';
import { startTestBackend } from './support/backend.js';

// ---------------------------------------------------------------- presets

test('five presets: Clinician, Patient, Procurement and governance, Regulator, Payer', () => {
  assert.deepEqual(AUDIENCES.map((entry) => entry.label), ['Clinician', 'Patient', 'Procurement and governance', 'Regulator', 'Payer']);
  assert.deepEqual(AUDIENCE_IDS, ['clinician', 'patient', 'procurement', 'regulator', 'payer']);
  assert.deepEqual(AUDIENCE_CHOICES.map((entry) => entry.value), ['', ...AUDIENCE_IDS], '"Your defaults" offers every preset');
  for (const id of AUDIENCE_IDS) {
    assert.equal(normalizeDefaults({ audience: id }).audience, id, `${id} is kept in the profile`);
    assert.equal(audiencePreset(id).view, 'overall');
  }
  assert.equal(audiencePreset('regulator').depth, 'expert');
  assert.equal(audiencePreset('payer').depth, 'expert');
  assert.deepEqual(normalizeDefaults({ audience: 'insurer' }), {}, 'an unknown preset is dropped');
});

test('a preset sets where a card starts: depth, view, and the sections it opens first', () => {
  const entry = parseStartupParams('?model=SynGPT-2.0&use_case=Clinician%20Facing%20CDSS');
  for (const [audience, depth] of [['regulator', 'expert'], ['payer', 'expert'], ['clinician', 'plain']]) {
    const state = withProfileDefaults(entry, { audience });
    assert.equal(state.depth, depth, audience);
    assert.equal(state.view, 'overall', audience);
    assert.equal(state.audience, audience);
  }
  assert.equal(withProfileDefaults(entry, { audience: 'payer', depth: 'plain' }).depth, 'plain', 'an explicit depth wins');
  assert.deepEqual(cardLayout('regulator').lead, ['incidents', 'studyQuality']);
  assert.deepEqual(cardLayout('payer').lead, ['effects']);
  assert.equal(cardLayout('regulator').hideExpertFacts, false);
  assert.equal(cardLayout('payer').openAssessment, false);
  // A link that carries atlas state opens exactly what it names; the preset still decides the order of sections.
  const shared = withProfileDefaults(parseStartupParams('?view=performance'), { audience: 'regulator' });
  assert.equal(shared.view, 'performance');
  assert.equal(shared.depth, null);
  assert.equal(shared.audience, 'regulator');
});

// ------------------------------------------------------------------ guide

test('the guide has four steps and takes the marks’ words from the legend', () => {
  assert.deepEqual(GUIDE_STEPS.map((step) => step.id), ['ring', 'marks', 'condition', 'population']);
  const marks = GUIDE_STEPS.find((step) => step.id === 'marks').marks;
  for (const key of ['no_data', 'out_of_scope', 'serious', 'caution', 'no_incidents']) {
    assert.ok(marks.includes(key), key);
    assert.equal(guideMark(key).meaning, legendMeaning(key), `${key}: one source of words`);
  }
  assert.equal(NO_DATA_MEANING, legendMeaning('no_data'));
  assert.equal(NOT_SAFE_MEANING, legendMeaning('no_incidents'));
  const population = GUIDE_STEPS.find((step) => step.id === 'population').text;
  assert.match(population, /setting/);
  assert.match(population, /local population/);
});

function memoryStorage() {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)) };
}

test('the guide shows once per browser, stays reopenable, and is never exported', () => {
  const storage = memoryStorage();
  const store = createProfileStore({ storage, target: null });
  assert.equal(shouldShowGuide(store.get()), true, 'first atlas visit');
  assert.equal(shouldShowGuide(store.get(), { isPreview: true }), false, 'never in a staged preview');
  store.markGuideSeen();
  assert.equal(store.get().guide_seen, true);
  assert.equal(shouldShowGuide(store.get()), false, 'closed once: not again');
  const reloaded = createProfileStore({ storage, target: null });
  assert.equal(shouldShowGuide(reloaded.get()), false, 'remembered across reloads');
  assert.ok(!('guide_seen' in profileFile(reloaded.get())), 'per browser, not in the export');
  assert.equal(normalizeProfile({ ...reloaded.get(), guide_seen: 'yes' }).guide_seen, undefined, 'only true counts');
  const before = reloaded.get();
  reloaded.markGuideSeen();
  assert.equal(reloaded.get(), before, 'marking it again changes nothing');
});

// -------------------------------------------------------------- fixtures

const CHAPTERS = { 'CH-01': 'Infections', 'CH-02': 'Neoplasms', 'CH-11': 'Circulatory system' };
const read = (data) => ({ data, error: null });
const counts = (strong, moderate, weak, noData, outOfScope = 0) => ({ strong, moderate, weak, no_data: noData, out_of_scope: outOfScope });
const SUMMARY = {
  dataset_version: '37',
  view: 'overall',
  total: 100,
  counts: counts(30, 40, 20, 8, 2),
  chapters: [
    { chapter_id: 'CH-01', total: 30, counts: counts(10, 10, 6, 4) },
    { chapter_id: 'CH-02', total: 40, counts: counts(10, 20, 4, 4, 2) },
    { chapter_id: 'CH-11', total: 30, counts: counts(10, 10, 10, 0) }
  ]
};
const WEIGHTED = { ...SUMMARY, weighted_distribution: { strong: 0.2753, moderate: 0.5227, weak: 0.1871, out_of_scope: 0, no_data: 0.0149 } };
const EVIDENCE = { ...SUMMARY, view: 'evidence', counts: counts(12, 30, 50, 8) };
const TILE = {
  card_id: 'SynGPT-2.0|Clinician Facing CDSS',
  safety: { serious: 2, caution: 1, open: 3, mitigated: 2, closed: 2 },
  last_updated: { version: 37, at: '2026-10-22T09:00:00Z' }
};
const ENTRY = { model_version: 'SynGPT-2.0', display_name: 'SynGPT 2.0' };
const DECLARED_FUNCTION = {
  use_case: 'Clinician Facing CDSS',
  function_category: 'decision_support',
  configuration: { configuration_id: 'cfg-2026-09', configuration_date: '2026-09-01' },
  declarations: {
    declared_intended_purpose: 'Suggests differential diagnoses to clinicians',
    declared_regulatory_status: 'Not assessed (demonstration)',
    declared_documentation_url: 'https://docs.example/syngpt',
    declared_data_use: 'Uses the visit note only',
    declared_data_location: 'Servers in the hospital',
    declared_retention: '30 days',
    declared_privacy_contact: 'privacy@synthetica.example'
  }
};
const BARE_FUNCTION = { use_case: 'Discharge letter generation', function_category: 'documentation', declarations: null };
const STUDIES = {
  studies: [
    { study_id: 'S-1', title: 'One', design: 'retrospective', conducted_by: 'developer', risk_of_bias: 'high' },
    { study_id: 'S-2', title: 'Two', design: 'prospective', conducted_by: 'independent', risk_of_bias: 'low' },
    { study_id: 'S-3', title: 'Three', design: 'benchmark', conducted_by: 'developer', risk_of_bias: 'some_concerns' }
  ]
};
const INCIDENTS = {
  incidents: [
    { incident_id: 'SI-4', status: 'open', reported_date: '2026-10-06', incident_type: 'fabricated_content' },
    { incident_id: 'SI-3', status: 'open', reported_date: '2026-08-04', incident_type: 'harmful_recommendation' },
    { incident_id: 'SI-2', status: 'mitigated', reported_date: '2026-03-16', incident_type: 'subgroup_bias' },
    { incident_id: 'SI-1', status: 'closed', reported_date: '2025-12-09', incident_type: 'harmful_recommendation' },
    { incident_id: 'SI-0', status: 'closed', reported_date: '2025-12-20', incident_type: 'other' }
  ]
};
const VERSIONS = {
  versions: [
    { version_id: 37, published_at: '2026-10-22T09:00:00Z', kind: 'models', summary: 'AI systems & functions: 13 rows changed.' },
    { version_id: 36, published_at: '2026-10-22T08:59:00Z', kind: 'safety', summary: 'Safety incidents: 4 incidents added.' },
    { version_id: 1, published_at: '2026-10-22T08:00:00Z', kind: null, summary: 'Initial import.' }
  ]
};
const EFFECTS = {
  effects: [
    {
      effect_id: 'E-1', study_id: 'RCT-1', outcome: 'Time to treatment', effect_measure: 'mean_difference', estimate: -14, ci_low: -21, ci_high: -7,
      unit: 'minutes', direction: 'lower_is_better', comparator: 'Usual triage'
    }
  ]
};
const BASE = { tile: read(TILE), entry: ENTRY, functionEntry: DECLARED_FUNCTION, resultFor: 'All patients, default prevalence', hasIntendedUse: true, chapterLabels: CHAPTERS };
const allText = (model) => [...model.lines.map((line) => `${line.label} ${line.text}`), ...model.more.flatMap((group) => group.items), model.notice].join(' ');

test('each preset reads only what it shows', () => {
  assert.deepEqual(Object.keys(AUDIENCE_READS), AUDIENCE_IDS);
  assert.ok(AUDIENCE_READS.procurement.includes('weighted') && AUDIENCE_READS.payer.includes('weighted'));
  assert.ok(!AUDIENCE_READS.clinician.includes('weighted') && !AUDIENCE_READS.patient.includes('weighted'), 'the weighted read only where it is shown');
  assert.deepEqual(AUDIENCE_READS.regulator, ['incidents', 'versions']);
  assert.equal(audienceSummary(null, BASE), null);
  assert.equal(audienceSummary('nurse', BASE), null);
});

test('Clinician: where to be careful, from the summary and the tile', () => {
  const model = audienceSummary('clinician', { ...BASE, summary: read(SUMMARY) });
  assert.equal(model.title, 'Where to be careful');
  assert.equal(model.facts.weak, SUMMARY.counts.weak);
  assert.equal(model.facts.noData, SUMMARY.counts.no_data);
  assert.equal(model.facts.outOfScope, SUMMARY.counts.out_of_scope);
  assert.equal(model.facts.openIncidents, TILE.safety.open);
  assert.deepEqual(model.facts.careful, [
    { id: 'CH-11', weakOrNoData: 10 },
    { id: 'CH-01', weakOrNoData: 10 },
    { id: 'CH-02', weakOrNoData: 8 }
  ], 'most Weak or No data first, ties by name');
  assert.equal(model.lines[0].text, 'Circulatory system (10 conditions), Infections (10), Neoplasms (8).');
  assert.equal(model.lines[0].targetId, 'CH-11', 'the line opens the first chapter');
  assert.equal(model.lines[1].text, '3 open: 2 serious, 1 caution.');
  assert.equal(model.lines[2].text, '2 conditions (2%), most in Neoplasms.');
  assert.equal(model.lines[3].text, BASE.resultFor, 'the population line');
  assert.ok(model.lines.length <= 6);
  const withoutStatement = audienceSummary('clinician', { ...BASE, hasIntendedUse: false, summary: read(SUMMARY) });
  assert.equal(withoutStatement.lines[2].text, 'No intended-use statement, so nothing is out of scope.');
  const quiet = audienceSummary('clinician', { ...BASE, tile: read({ ...TILE, safety: { serious: 0, caution: 0, open: 0, mitigated: 0, closed: 1 } }), summary: read(SUMMARY) });
  assert.equal(quiet.lines[1].text, `None open. No reported incidents: ${NOT_SAFE_MEANING}.`, 'never "safe"');
});

test('Patient: plain words in three parts, data protection as declared', () => {
  const chapterCard = read({
    concept: { concept_id: 'CH-11' },
    metrics: { warnings: [{ code: 'clinician_review_required', relevance: 'High' }, { code: 'limited_validation_depth', relevance: 'Medium', share: { count: 4, total: 10 } }] }
  });
  const model = audienceSummary('patient', { ...BASE, summary: read(SUMMARY), chapterCard, instance: { organisation: 'Northbridge General (fictional)', data_protection_note: 'Ask the ward about how we use AI.' } });
  const byId = Object.fromEntries(model.lines.map((line) => [line.id, line]));
  assert.equal(byId.used.label, 'How it is used in care');
  assert.match(byId.used.text, /^SynGPT 2\.0 helps with decision support \(Clinician-Facing CDSS\)\. The developer says: “Suggests differential diagnoses to clinicians\.” /);
  assert.ok(byId.used.text.endsWith(DECLARED));
  assert.equal(byId.incidents.label, 'What can go wrong');
  assert.equal(model.facts.openIncidents, TILE.safety.open);
  assert.equal(model.facts.weakOrNoData, SUMMARY.counts.weak + SUMMARY.counts.no_data);
  assert.equal(byId.weak.text, 'For 28 of 100 conditions (28%), the results are weak or there is no data.');
  assert.deepEqual(model.facts.warnings, ['limited_validation_depth', 'clinician_review_required'], 'findings first, the function’s requirement last');
  assert.equal(byId.data.label, 'Your data');
  assert.equal(byId.data.text, `Uses the visit note only. ${DECLARED}`);
  assert.deepEqual(model.facts.declarations, ['declared_data_use', 'declared_data_location', 'declared_retention', 'declared_privacy_contact']);
  assert.equal(byId.note.label, 'Note from Northbridge General (fictional)', 'the organisation’s own note, apart from the developer’s');
  assert.equal(model.notice, SYNTHETIC_NOT_CLINICAL);
  assert.equal(SYNTHETIC_NOT_CLINICAL, 'Demonstration on synthetic data, not for clinical use.');
  assert.ok(allText(model).includes(`No data: ${NO_DATA_MEANING}.`), 'the guide’s words');
});

test('Patient without declarations says so, and nothing reads as safe or approved', () => {
  const model = audienceSummary('patient', { ...BASE, functionEntry: BARE_FUNCTION, summary: read(SUMMARY), instance: null });
  const data = model.lines.find((line) => line.id === 'data');
  assert.equal(data.text, NO_DATA_DECLARATIONS);
  assert.equal(NO_DATA_DECLARATIONS, 'The developer has not declared how patient data is handled.');
  assert.ok(!model.lines.some((line) => line.id === 'note'));
  assert.match(model.lines[0].text, /The developer has not stated what it is for\./);
  for (const audience of AUDIENCE_IDS) {
    const text = allText(
      audienceSummary(audience, { ...BASE, summary: read(SUMMARY), weighted: read(WEIGHTED), evidence: read(EVIDENCE), studies: read(STUDIES), incidents: read(INCIDENTS), versions: read(VERSIONS), effects: read(EFFECTS) })
    );
    assert.doesNotMatch(text.replace(/does not mean (it is )?safe/g, ''), /\bsafe\b|\bapproved\b|\bcertified\b/i, audience);
    assert.doesNotMatch(text, /use case/i, `${audience}: "Function", never "use case"`);
  }
});

test('Procurement and governance: population fit and compliance', () => {
  const model = audienceSummary('procurement', { ...BASE, weighted: read(WEIGHTED), studies: read(STUDIES) });
  assert.deepEqual(model.facts.shares, WEIGHTED.weighted_distribution);
  assert.equal(model.lines[0].label, 'Population fit');
  assert.equal(model.lines[0].text, `${sharesText(WEIGHTED.weighted_distribution)}, weighted by how common each condition is, for ${BASE.resultFor}.`);
  assert.equal(sharesText(WEIGHTED.weighted_distribution), '28% strong, 52% moderate, 19% weak, 1% no data');
  assert.equal(model.lines[0].strip.label, sharesText(WEIGHTED.weighted_distribution));
  assert.match(model.lines[1].text, /^Not assessed \(demonstration\)\. Declared by the developer, not checked\.$/);
  assert.equal(model.lines[1].href, 'https://docs.example/syngpt');
  assert.deepEqual(studyMix(STUDIES.studies), { total: 3, conductors: { developer: 2, independent: 1 }, risk: { high: 1, low: 1, some_concerns: 1 } });
  assert.equal(model.facts.studies, STUDIES.studies.length);
  assert.equal(model.lines[2].text, '3 studies of this AI system: 2 by the developer, 1 by an independent group. Risk of bias: 1 low, 1 some concerns, 1 high.');
  assert.equal(model.facts.openIncidents, TILE.safety.open);
  assert.equal(model.lines[4].text, 'cfg-2026-09, 1 September 2026');
  assert.equal(model.facts.lastUpdated, TILE.last_updated.version);
  assert.equal(model.lines[5].text, 'Version 37, 22 Oct 2026');
  assert.ok(model.lines.length <= 6);
});

test('Regulator: incidents over time, changes, configuration, lineage', () => {
  const lineage = { replaces: { label: 'SynGPT 1.0' }, replacedBy: [] };
  const model = audienceSummary('regulator', { ...BASE, incidents: read(INCIDENTS), versions: read(VERSIONS), system: { lineage } });
  assert.deepEqual(incidentsByMonth(INCIDENTS.incidents).map(({ month, count }) => [month, count]), [
    ['2025-12', 2], ['2026-03', 1], ['2026-08', 1], ['2026-10', 1]
  ]);
  assert.equal(model.lines[0].text, 'Dec 2025: 2, Mar 2026: 1, Aug 2026: 1, Oct 2026: 1');
  assert.deepEqual(incidentStatusCounts(INCIDENTS.incidents), { open: 2, mitigated: 1, closed: 2 });
  assert.equal(model.lines[1].text, '2 open, 1 mitigated, 2 closed.');
  assert.deepEqual(model.facts.versions, [37, 36, 1]);
  assert.equal(model.facts.latestVersion, TILE.last_updated.version, 'the newest change is the tile’s last update');
  assert.equal(model.lines[2].text, '3 published versions changed it; the latest is version 37, 22 Oct 2026.');
  assert.equal(model.lines[4].text, 'Replaces SynGPT 1.0.');
  assert.ok(model.more.find((group) => group.id === 'incidents').items[0].includes('(SI-4)'), 'newest first, as served');
});

test('Payer: effects first, then evidence quality and population fit', () => {
  const model = audienceSummary('payer', { ...BASE, effects: read(EFFECTS), evidence: read(EVIDENCE), studies: read(STUDIES), weighted: read(WEIGHTED) });
  assert.deepEqual(model.lines.map((line) => line.id), ['effects', 'evidence', 'studies', 'fit']);
  assert.match(model.lines[0].text, /^1 effect from 1 study\. Time to treatment: Better with the AI system than usual triage: about 14 minutes less\. Not part of any grade\.$/);
  assert.deepEqual(model.facts.evidence, EVIDENCE.counts, 'the Summary’s Evidence counts');
  assert.equal(model.lines[1].text, '12 strong, 30 moderate, 50 weak, 8 no data, of 100 conditions.');
  assert.deepEqual(model.facts.shares, WEIGHTED.weighted_distribution);
  const none = audienceSummary('payer', { ...BASE, effects: read({ effects: [] }), evidence: read(EVIDENCE), studies: read({ studies: [] }), weighted: read(WEIGHTED) });
  assert.equal(none.lines[0].text, 'None recorded for this card. Grades cover predictive performance only.');
  assert.equal(none.lines[2].text, 'No study records for this AI system.');
});

test('a read the static demo did not record says so in words; loading and failures too', () => {
  // Since Q9 the static demo records these reads; a population it does not hold still says so.
  const unrecorded = { data: null, error: { code: STATIC_UNAVAILABLE, detail: STATIC_REASONS.population } };
  const model = audienceSummary('procurement', { ...BASE, weighted: unrecorded, studies: { data: null, error: null } });
  assert.equal(model.lines[0].text, STATIC_REASONS.population);
  assert.equal(model.lines[0].strip, null);
  assert.equal(model.lines[2].text, 'Loading…');
  const regulator = audienceSummary('regulator', { ...BASE, incidents: { data: null, error: { code: STATIC_UNAVAILABLE, detail: STATIC_REASONS.version } }, versions: { data: null, error: { code: 'backend_unavailable' } } });
  assert.equal(regulator.lines[0].text, STATIC_REASONS.version);
  assert.equal(regulator.lines[2].text, 'Could not be loaded. Try again later.');
});

test('the block renders its lines and More; the synthetic-data notice is the header badge\'s', () => {
  const model = audienceSummary('clinician', { ...BASE, summary: read(SUMMARY) });
  const closed = renderToStaticMarkup(createElement(AudienceSummary, { summary: model }));
  assert.match(closed, /Reading as Clinician/);
  assert.match(closed, /Where to be careful/);
  assert.match(closed, /aria-expanded="false"[^>]*>More</);
  // Closed, the body is rendered hidden, so aria-controls always names an element.
  assert.match(closed, /aria-controls="([^"]+)"[^>]*>More<\/button><div id="\1" class="audience-more-body" hidden="">/);
  assert.doesNotMatch(closed, /Demonstration on synthetic data, not for clinical use\./);
  const open = renderToStaticMarkup(createElement(AudienceSummary, { summary: model, defaultOpen: true, onOpen: () => {}, onChange: () => {}, onOpenGuide: () => {} }));
  assert.match(open, /Chapters with Weak or No data results/);
  assert.match(open, /Infections: 6 weak, 4 no data, of 30/);
  assert.match(open, /How to read a card/);
  assert.match(open, /Change role in Settings/);
  assert.match(open, /class="audience-line-body is-link"/, 'a line that names a chapter opens it');
});

// ------------------------------------------------------------ data client

function recordingClient(respond = () => ({})) {
  const requests = [];
  const fetchMock = async (input) => {
    const url = new URL(input, 'http://localhost');
    requests.push(url);
    return new Response(JSON.stringify(respond(url)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { client: createDataClient(createApiAdapter({ fetch: fetchMock })), requests };
}

test('the data client’s audience reads leave every other URL as it was', async () => {
  const { client, requests } = recordingClient();
  const card = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' };
  await client.getMetricSummary({ ...card, view: 'overall' });
  assert.ok(!requests.at(-1).searchParams.has('weights'));
  await client.getMetricSummary({ ...card, view: 'overall', weights: 'prevalence' });
  assert.equal(requests.at(-1).searchParams.get('weights'), 'prevalence');
  await client.listDatasetVersions({});
  assert.equal(requests.at(-1).search, '');
  await client.listDatasetVersions({ card: 'SynGPT-2.0|Clinician Facing CDSS', after: 30 });
  assert.equal(requests.at(-1).searchParams.get('card'), 'SynGPT-2.0|Clinician Facing CDSS');
  assert.equal(requests.at(-1).searchParams.get('after'), '30');
  await client.listSafetyIncidents(card);
  assert.equal(requests.at(-1).pathname, '/api/v1/incidents');
  assert.deepEqual(Object.fromEntries(requests.at(-1).searchParams), { model: 'SynGPT-2.0', use_case: 'Clinician Facing CDSS' });
});

test('the static demo serves the audience reads it recorded (Q9) and refuses the rest in words', async () => {
  const files = {
    'cards/M__U/all/summary-overall-weighted.json': WEIGHTED,
    'incidents.json': { dataset_version: '44', incidents: [{ incident_id: 'I-1', model_version: 'M', use_case: 'U' }, { incident_id: 'I-2', model_version: 'N', use_case: 'U' }] },
    'cards/M__U/versions.json': { dataset_version: '44', versions: [{ version_id: 44 }, { version_id: 3 }] }
  };
  const adapter = createStaticAdapter({
    fetch: async (url) => {
      const path = url.replace(/^static-data\//, '');
      return path in files ? { ok: true, status: 200, json: async () => structuredClone(files[path]) } : { ok: false, status: 404 };
    }
  });
  assert.deepEqual(await adapter.getMetricSummary({ model: 'M', useCase: 'U', view: 'overall', weights: 'prevalence' }), WEIGHTED);
  assert.deepEqual((await adapter.listSafetyIncidents({ model: 'M', useCase: 'U' })).incidents.map((entry) => entry.incident_id), ['I-1']);
  assert.deepEqual((await adapter.listDatasetVersions({ card: 'M|U', after: 3 })).versions, [{ version_id: 44 }]);
  await assert.rejects(adapter.listDatasetVersions({}), (error) => error.code === STATIC_UNAVAILABLE && error.detail === STATIC_REASONS.versions);
  await assert.rejects(
    adapter.getMetricSummary({ model: 'M', useCase: 'U', view: 'overall', weights: 'prevalence', population: 'northbridge-region' }),
    (error) => error.code === STATIC_UNAVAILABLE && error.detail === STATIC_REASONS.population
  );
});

// ------------------------------------------- the same figures as the reads

let backend;
let client;
before(async () => {
  backend = await startTestBackend();
  client = createDataClient(createApiAdapter({ baseUrl: `${backend.origin}/api/v1` }));
});
after(() => backend?.stop());

test('every summary figure equals the read it comes from (real backend)', async () => {
  const card = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' };
  const cardId = `${card.model}|${card.useCase}`;
  const lens = { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };
  const [summary, weighted, evidence, catalogue, studies, effects, incidents, versions, models] = await Promise.all([
    client.getMetricSummary({ ...card, ...lens, view: 'overall' }),
    client.getMetricSummary({ ...card, ...lens, view: 'overall', weights: 'prevalence' }),
    client.getMetricSummary({ ...card, ...lens, view: 'evidence' }),
    client.getCatalogue(),
    client.listStudies({ model: card.model }),
    client.listEffects(card),
    client.listSafetyIncidents(card),
    client.listDatasetVersions({ card: cardId }),
    client.listModels()
  ]);
  const tile = catalogue.tiles.find((entry) => entry.card_id === cardId);
  const entry = models.models.find((model) => model.model_version === card.model);
  const functionEntry = entry.use_cases.find((variant) => variant.use_case === card.useCase);
  const input = {
    summary: read(summary), weighted: read(weighted), evidence: read(evidence), tile: read(tile), studies: read(studies), effects: read(effects),
    incidents: read(incidents), versions: read(versions), entry, functionEntry, hasIntendedUse: functionEntry.intended_use_defined !== false,
    resultFor: 'All patients, default prevalence', chapterLabels: {}
  };
  const clinician = audienceSummary('clinician', input).facts;
  // The Summary's counts at the all-population lens equal the catalogue tile's (CONTRACT.md §17).
  assert.equal(clinician.weak, tile.distribution.overall.weak);
  assert.equal(clinician.noData, tile.distribution.overall.no_data);
  assert.equal(clinician.total, catalogue.condition_count);
  assert.equal(clinician.openIncidents, tile.safety.open);
  const patient = audienceSummary('patient', input).facts;
  assert.equal(patient.weakOrNoData, summary.counts.weak + summary.counts.no_data);
  const procurement = audienceSummary('procurement', input).facts;
  assert.deepEqual(procurement.shares, weighted.weighted_distribution);
  assert.equal(procurement.lastUpdated, tile.last_updated.version);
  assert.equal(procurement.studies, studies.studies.length);
  const regulator = audienceSummary('regulator', input).facts;
  assert.equal(regulator.latestVersion, tile.last_updated.version, 'the version feed’s newest change is the tile’s last update');
  assert.deepEqual(regulator.incidentStatuses, { open: tile.safety.open, mitigated: tile.safety.mitigated, closed: tile.safety.closed });
  const payer = audienceSummary('payer', input).facts;
  assert.deepEqual(payer.evidence, { ...evidence.counts });
  assert.deepEqual(payer.effects, effects.effects.map((effect) => effect.effect_id));
  // The weighted read is the plain one plus its shares.
  const { weighted_distribution: shares, ...plain } = weighted;
  assert.deepEqual(plain, summary);
  assert.ok(Math.abs(Object.values(shares).reduce((sum, value) => sum + value, 0) - 1) < 0.001);
});
