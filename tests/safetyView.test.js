// The Safety view, safety incidents on the card, row sources, and the
// catalogue's Safety tab (CONTRACT.md §11.3, §17, §18). Incidents behave like warnings: only
// conditions with an open or mitigated incident are marked, Serious or
// Caution, with glyph and word; everything else reads "No reported
// incidents" in the neutral mark, never green and never "safe".
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { markShapes } from '../frontend/src/design/StatusMark.js';
import {
  ATLAS_VIEWS,
  DISPLAY,
  SAFETY_MEANING,
  VIEWS,
  countStatuses,
  keysForView,
  mapRowStatus,
  metricRowStatus,
  ringKeyEntries,
  ringStatus,
  viewLabel
} from '../frontend/src/design/status.js';
import { safetyTallies, tallyText } from '../frontend/src/features/atlas/safetyTally.js';
import { parseStartupParams } from '../frontend/src/app/startupParams.js';
import { openIncidents, safetyLead } from '../frontend/src/features/catalogue/catalogueModel.js';
import { buildConceptCardFile } from '../frontend/src/features/details/conceptCardExport.js';
import { aboutResult, dataSourceSentence, SYNTHETIC_NOTE } from '../frontend/src/features/details/copy/aboutResult.js';
import {
  describeIncident,
  exportIncidents,
  incidentsMark,
  incidentsMarkWord,
  openIncidentChip,
  sortIncidents
} from '../frontend/src/features/details/copy/incidentCopy.js';
import IncidentList from '../frontend/src/features/details/IncidentList.js';
import { deriveHighlights, safetyDisplayCounts } from '../frontend/src/features/summary/summaryHighlights.js';
import { BACKEND_DIR, pythonPath } from '../scripts/backendServer.mjs';
import { apiClient, startTestBackend } from './support/backend.js';

const SRC = fileURLToPath(new URL('../frontend/src/', import.meta.url));
const read = (relative) => readFileSync(path.join(SRC, relative), 'utf8');
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
// "safe" may only appear to say that no report does not mean safe.
const assertNoSafeClaim = (words, where) => {
  for (const match of words.matchAll(/[^.]*\bsafe\b[^.]*/gi)) {
    assert.match(match[0], /does not mean|not evidence of safety/i, `${where}: "${match[0].trim()}"`);
  }
};

const ALL = { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };

function incident(overrides = {}) {
  return {
    incident_id: 'SI-T-1',
    model_version: 'Alpha-2',
    use_case: 'Clinician Facing CDSS',
    codes: ['BA00'],
    condition_ids: ['BA00'],
    chapter_id: null,
    lens: ALL,
    incident_type: 'harmful_recommendation',
    harm: 'possible',
    status: 'open',
    severity: 'serious',
    source_type: 'incident_report',
    source_reference: 'Fictional incident report IR-1 (synthetic)',
    study_id: null,
    reported_date: '2026-08-04',
    updated_date: '2026-09-12',
    summary: 'Synthetic example: a fictional incident.',
    ...overrides
  };
}

// ------------------------------------------------------------ vocabulary

test('Safety is a fifth atlas view, not a metric view', () => {
  assert.deepEqual(ATLAS_VIEWS.map((view) => view.id), ['overall', 'performance', 'evidence', 'intended_use', 'safety']);
  assert.equal(VIEWS.length, 4, 'the metric views (card sections, change summary) stay four');
  assert.equal(viewLabel('safety'), 'Safety');
  assert.deepEqual(keysForView('safety'), ['serious', 'caution', 'no_incidents']);
  assert.equal(parseStartupParams('?view=safety').view, 'safety', 'a shared URL reopens the Safety view');
  const toolbar = read('features/toolbar/Toolbar.jsx');
  assert.match(toolbar, /ATLAS_VIEWS\.map/);
});

test('the map safety column marks Serious and Caution; everything else is No reported incidents', () => {
  assert.equal(mapRowStatus({ safety: 'serious', overall_status: 'strong' }, 'safety'), 'serious');
  assert.equal(mapRowStatus({ safety: 'caution' }, 'safety'), 'caution');
  assert.equal(mapRowStatus({ safety: null, overall_status: 'strong' }, 'safety'), 'no_incidents');
  assert.equal(mapRowStatus(null, 'safety'), 'no_incidents');
  // Overview draws an open incident over the result; the result
  // underneath and the other views ignore the column: incidents never change a result.
  assert.equal(mapRowStatus({ safety: 'serious', overall_status: 'strong' }, 'overall'), 'serious');
  assert.equal(mapRowStatus({ safety: 'serious', overall_status: 'strong' }, 'overall', { withSafety: false }), 'strong');
  assert.equal(mapRowStatus({ safety: 'serious', performance_status: 'strong' }, 'performance'), 'strong');
  assert.equal(mapRowStatus({ safety: 'caution', evidence_status: 'weak' }, 'evidence'), 'weak');
  assert.equal(ringStatus(null, 'safety', { isLoading: true }), 'loading');
  assert.equal(ringStatus(null, 'safety', { isCombinationMode: true }), 'no_combination');
  assert.equal(metricRowStatus({ status: { overall: 'strong' } }, 'safety'), 'no_incidents');
  assert.deepEqual(countStatuses([{ safety: 'serious' }, { safety: null }, { safety: 'caution' }, null], 'safety'), {
    serious: 1,
    caution: 1,
    no_incidents: 2
  });
});

test('Safety marks: glyph and word for Serious and Caution, a neutral mark otherwise, never green', () => {
  assert.equal(DISPLAY.serious.label, 'Serious');
  assert.equal(DISPLAY.caution.label, 'Caution');
  assert.equal(DISPLAY.no_incidents.label, 'No reported incidents');
  assert.equal(DISPLAY.no_incidents.tone, 'absent');
  assert.notEqual(DISPLAY.no_incidents.form, 'fill');
  assert.equal(DISPLAY.serious.tone, 'weak', 'coral');
  assert.equal(DISPLAY.caution.tone, 'moderate', 'amber');
  for (const status of ['serious', 'caution']) {
    const shapes = markShapes(status, { cx: 6, cy: 6, r: 5 });
    assert.ok(shapes.some((shape) => /mark-glyph-alert/.test(shape.props.className)), `${status} carries the "!" glyph`);
  }
  const quiet = markShapes('no_incidents', { cx: 6, cy: 6, r: 5 });
  assert.equal(quiet.length, 1);
  assert.doesNotMatch(quiet[0].props.className, /tone-strong/);
  for (const words of Object.values(SAFETY_MEANING)) {
    assertNoSafeClaim(words, 'ring key');
  }
  // Loading and No reported incidents stay apart: different fills, and only the quiet mark has an edge.
  const tokens = read('styles/tokens.css');
  const marks = read('styles/marks.css');
  const hex = (name) => tokens.match(new RegExp(`--${name}: (#[0-9a-f]{6})`, 'i'))[1];
  const lightness = (value) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  assert.ok(lightness(hex('mark-pale')) - lightness(hex('mark-quiet')) >= 0.06, 'Loading is clearly paler than No reported incidents');
  assert.match(marks, /\.mark-quiet \{[^}]*stroke: var\(--mark-quiet-edge\)/);
  assert.match(marks, /\.mark-pale \{[^}]*stroke: none/);
  assert.doesNotMatch(marks.match(/\.mark-quiet \{[^}]*\}/)[0], /tone-strong/);
  assert.match(marks, /\.strip-quiet/);
});

test('the ring key explains the Safety marks drawn, worst first, and no absence forms', () => {
  const tiles = [{ concept_id: 'A' }, { concept_id: 'B' }, { concept_id: 'C' }];
  const rows = new Map([
    ['A', { safety: 'caution', overall_status: 'no_data' }],
    ['B', { safety: null, overall_status: 'no_data' }],
    ['C', { safety: 'serious' }]
  ]);
  assert.deepEqual(ringKeyEntries({ tiles, rowsById: rows, viewId: 'safety' }), {
    absences: [],
    safety: ['serious', 'caution', 'no_incidents'],
    hasCores: false
  });
  assert.deepEqual(ringKeyEntries({ tiles: tiles.slice(1, 2), rowsById: rows, viewId: 'safety' }).safety, ['no_incidents']);
  assert.match(read('features/atlas/legendEntries.js'), /SAFETY_MEANING\[key\]/);
  assert.match(read('features/atlas/RingLegend.jsx'), /A subchapter shows its worst mark\./);
});

// ------------------------------------------------------- centre and summary

test('centre counts and Summary use safety_counts', () => {
  const counts = safetyDisplayCounts({ serious: 3, caution: 5, none: 2392 });
  assert.deepEqual(counts, { serious: 3, caution: 5, no_incidents: 2392 });
  const groups = [
    { id: 'CH-11', label: 'Circulatory system', total: 120, counts: { serious: 2, caution: 0, no_incidents: 118 } },
    { id: 'CH-06', label: 'Mental disorders', total: 300, counts: { serious: 0, caution: 5, no_incidents: 295 } },
    { id: 'CH-05', label: 'Endocrine', total: 90, counts: { serious: 1, caution: 0, no_incidents: 89 } },
    { id: 'CH-01', label: 'Infections', total: 200, counts: { serious: 0, caution: 0, no_incidents: 200 } }
  ];
  const highlights = deriveHighlights({ viewId: 'safety', total: 2400, counts, groups });
  assert.equal(highlights[0].title, '3 conditions with a serious incident');
  assert.equal(highlights[0].tone, 'serious');
  assert.deepEqual(highlights[0].strip.keys, ['serious', 'caution', 'no_incidents']);
  assert.match(highlights[0].text, /5 with a caution incident/);
  assert.match(highlights[0].text, /, of 2,400\.$/);
  // Areas with incidents, worst first, each opening its chapter; none for clean chapters.
  assert.deepEqual(highlights.slice(1).map((item) => [item.targetId, item.tone]), [
    ['CH-11', 'serious'],
    ['CH-05', 'serious'],
    ['CH-06', 'caution']
  ]);
  for (const item of highlights) {
    assert.notEqual(item.tone, 'strong');
    assertNoSafeClaim(`${item.title}. ${item.text}`, item.id);
  }

  const caution = deriveHighlights({ viewId: 'safety', total: 10, counts: { serious: 0, caution: 2, no_incidents: 8 }, groups: [] });
  assert.equal(caution[0].title, '2 conditions with a caution incident');

  const none = deriveHighlights({ viewId: 'safety', total: 2400, counts: { serious: 0, caution: 0, no_incidents: 2400 }, population: 'Age 0–17' });
  assert.equal(none.length, 1);
  assert.equal(none[0].title, 'No reported incidents');
  assert.equal(none[0].tone, 'no_incidents');
  assert.match(none[0].text, /for Age 0–17/);
  assert.match(none[0].text, /Not evidence of safety\./);
  assertNoSafeClaim(none[0].text, 'no incidents');
});

test('the hover card tallies a subchapter\'s marked conditions', () => {
  const rows = new Map([
    ['c1', { safety: 'serious' }],
    ['c2', { safety: 'caution' }],
    ['c3', { safety: null }],
    ['c4', { safety: null }]
  ]);
  const tallies = safetyTallies({ B1: [{ concept_id: 'c1' }, { concept_id: 'c2' }, { concept_id: 'c3' }], B2: [{ concept_id: 'c4' }] }, rows);
  assert.deepEqual([...tallies.keys()], ['B1'], 'only subchapters with a marked condition');
  assert.deepEqual(tallies.get('B1'), { serious: 1, caution: 1, total: 3 });
  assert.equal(tallyText(tallies.get('B1')), '2 of its 3 conditions marked: 1 with a serious incident, 1 with a caution incident');
  const hover = read('features/atlas/HoverCard.jsx');
  assert.match(hover, /tallyText\(tally\)/);
  assert.match(hover, /StatusLabel status=\{status\}/);
});

// ------------------------------------------------------------ the card

test('incident copy: severity order, header chip, worst mark, closed without a mark', () => {
  const list = [
    incident({ incident_id: 'closed', status: 'closed', severity: null }),
    incident({ incident_id: 'caution', status: 'mitigated', severity: 'caution', harm: 'occurred' }),
    incident({ incident_id: 'serious' }),
    incident({ incident_id: 'open-caution', status: 'open', severity: 'caution', harm: 'none' })
  ];
  assert.deepEqual(sortIncidents(list).map((item) => item.incident_id), ['serious', 'caution', 'open-caution', 'closed']);
  assert.equal(incidentsMark(list), 'serious');
  assert.equal(incidentsMark([list[1]]), 'caution');
  assert.equal(incidentsMark([list[0]]), 'no_incidents', 'a closed incident is not coloured');
  assert.equal(incidentsMark([]), 'no_incidents');
  // The chip counts open incidents only (a mitigated one is Caution on the ring, not open).
  assert.deepEqual(openIncidentChip(list), { tone: 'serious', text: '2 open incidents, 1 serious' });
  assert.deepEqual(openIncidentChip([list[3]]), { tone: 'caution', text: '1 open caution incident' });
  assert.deepEqual(openIncidentChip([list[2]]), { tone: 'serious', text: '1 open serious incident' });
  assert.equal(openIncidentChip([list[0], list[1]]), null);

  const chapterWide = describeIncident(incident({ codes: [], condition_ids: [], chapter_id: 'CH-06', lens: { ...ALL, ethnicity: 'Ethnicity Black' } }), {
    chapterName: (id) => (id === 'CH-06' ? 'Mental, behavioural or neurodevelopmental disorders' : null)
  });
  assert.equal(chapterWide.population, 'Black');
  assert.equal(chapterWide.facts.find((fact) => fact.label === 'Applies to').value, 'the whole chapter Mental, behavioural or neurodevelopmental disorders, Black');
  const study = describeIncident(incident({ source_type: 'study', study_id: 'AUD-1', source_reference: 'Fictional audit (synthetic)' }));
  assert.equal(study.source, 'Study: Fictional audit (synthetic), study AUD-1');
  assert.equal(study.reported, '4 Aug 2026');
});

test('the Safety incidents section renders at plain and expert depth', () => {
  const list = [
    incident({ incident_id: 'SI-closed', status: 'closed', severity: null, incident_type: 'fabricated_content' }),
    incident({ incident_id: 'SI-serious', lens: { ...ALL, age: 'Age 65+' } }),
    incident({ incident_id: 'SI-mitigated', status: 'mitigated', severity: 'caution', incident_type: 'performance_drift', updated_date: null })
  ];
  const plain = renderToStaticMarkup(createElement(IncidentList, { incidents: list, depth: 'plain' }));
  const rows = plain.match(/<li[^>]*data-severity="([a-z]+)"/g).map((row) => row.match(/data-severity="([a-z]+)"/)[1]);
  assert.deepEqual(rows, ['serious', 'caution', 'closed']);
  assert.match(plain, /data-status="serious"/);
  assert.match(plain, /data-status="caution"/);
  // Closed: listed with a neutral chip, no mark, not coloured.
  const closedRow = plain.match(/<li[^>]*data-severity="closed"[\s\S]*?<\/li>/)[0];
  assert.doesNotMatch(closedRow, /status-mark|tone-weak|tone-moderate/);
  assert.match(closedRow, /priority-chip tone-absent">Closed</);
  const plainText = text(plain);
  assert.match(plainText, /Serious Harmful or incorrect recommendation/);
  assert.match(plainText, /Open, Age 65\+/);
  assert.match(plainText, /Incident report: Fictional incident report IR-1 \(synthetic\)\. Reported 4 Aug 2026, updated 12 Sept? 2026\./);
  assert.match(plainText, /Mitigated: steps were taken/);
  // What the severities mean is the section heading's help, not a note under the list.
  assert.doesNotMatch(plainText, /Closed: listed, no mark/);
  assert.match(readFileSync(new URL('../frontend/src/features/details/DetailCard.jsx', import.meta.url), 'utf8'), /SEVERITY_NOTE\.plain\)/);
  assert.doesNotMatch(plainText, /Harm possible/, 'harm is an expert fact');

  const expert = text(renderToStaticMarkup(createElement(IncidentList, { incidents: list, depth: 'expert' })));
  assert.match(expert, /Incident SI-serious/);
  assert.match(expert, /Harm Harm possible/);
  assert.match(expert, /Applies to BA00, Age 65\+/);
  assert.match(expert, /Updated Not updated since/);
  assert.doesNotMatch(expert, /Severity is derived/, 'in the heading\'s help');

  for (const depth of ['plain', 'expert']) {
    const empty = renderToStaticMarkup(createElement(IncidentList, { incidents: [], depth }));
    assert.match(empty, /data-status="no_incidents"/);
    assert.match(text(empty), /No reported incidents/);
    assertNoSafeClaim(text(empty), `empty ${depth}`);
    assertNoSafeClaim(text(renderToStaticMarkup(createElement(IncidentList, { incidents: list, depth }))), depth);
  }

  const card = read('features/details/DetailCard.jsx');
  assert.match(card, /<IncidentList /);
  assert.match(card, /incident-jump tone-\$\{incidentChip\.tone\}/);
  assert.match(card, /<StatusMark status=\{incidentChip\.tone\}/);
  assert.match(card, /headerStatus = incidentsMark\(incidents\)/);
});

test('the row source reads in About this result, never as real evidence', () => {
  assert.equal(dataSourceSentence(null, 'plain'), null);
  assert.equal(
    dataSourceSentence({ source: 'Seed (synthetic, version 1)', study: null, date: null }, 'plain'),
    'Source: Seed (synthetic, version 1).'
  );
  const study = { source: 'Northbridge multisite validation (fictional)', study: 'NBR-2026-01', date: '2026-09-15' };
  assert.match(
    dataSourceSentence(study, 'plain'),
    /^Source: Northbridge multisite validation \(fictional\) \(study NBR-2026-01, 15 Sept? 2026\), synthetic\.$/
  );
  assert.equal(dataSourceSentence(study, 'expert'), 'Row source: Northbridge multisite validation (fictional); study NBR-2026-01; source date 2026-09-15.');
  const sentences = aboutResult({ concept: { level: 2, preferred_term: 'X' }, row: { provenance: { source: 'condition', lens_fallback: false, data_source: study } }, depth: 'plain' });
  assert.match(sentences.at(-2), /^Source: /);
  assert.equal(sentences.at(-1), SYNTHETIC_NOTE);
});

test('the card export lists the incidents and the row source', () => {
  const conceptExport = {
    exported_at: '2026-10-12T10:00:00Z',
    audience_view: 'patient',
    concept: { code: 'BA00', block: 'B', name: 'Essential hypertension', hierarchy: ['C', 'B', 'Essential hypertension'] },
    context: { model: 'Alpha-2', use_case: 'Clinician Facing CDSS', population: ALL },
    model_card: { provenance: { source: 'condition', lens_fallback: false, data_source: { source: 'Seed (synthetic, version 1)', study: null, date: null } } },
    warnings: [],
    safeguards: [],
    synthetic_data_notice: 'Synthetic.'
  };
  const card = buildConceptCardFile(conceptExport, { incidents: [incident({ status: 'closed', severity: null }), incident({ incident_id: 'SI-2' })] });
  assert.deepEqual(card.safety_incidents.map((item) => [item.incident_id, item.severity_word]), [['SI-2', 'Serious'], ['SI-T-1', 'Closed']]);
  assert.equal(card.model_card.details.data_source.source, 'Seed (synthetic, version 1)');
  assert.deepEqual(buildConceptCardFile(conceptExport).safety_incidents, []);
  assert.deepEqual(Object.keys(exportIncidents([incident()])[0]), [
    'incident_id', 'severity', 'severity_word', 'incident_type', 'status', 'harm', 'applies_to', 'source', 'reported_date', 'updated_date', 'summary'
  ]);
  const pdf = read('features/details/conceptCardExport.js');
  assert.match(pdf, /writeSectionTitle\('Safety incidents'\)/);
});

// --------------------------------------------------------------- catalogue

test('catalogue Safety tiles lead with open counts, where the marks are, and mitigated and closed quietly after them', () => {
  const tile = (safety, blocks) => ({ card_id: 'A|F', safety, ...(blocks ? { snapshot: { blocks } } : {}) });
  assert.deepEqual(safetyLead(tile({ serious: 1, caution: 2, open: 3, mitigated: 1, closed: 2 })), {
    rows: [{ status: 'serious', count: 1 }, { status: 'caution', count: 2 }],
    quiet: null,
    span: null,
    settled: '1 mitigated, 2 closed',
    mitigated: '1 mitigated incident is marked Caution on the ring.'
  });
  assert.deepEqual(safetyLead(tile({ serious: 0, caution: 1, open: 1, mitigated: 0, closed: 0 })).rows, [{ status: 'caution', count: 1 }]);
  assert.deepEqual(safetyLead(tile({ serious: 0, caution: 0, open: 0, mitigated: 1, closed: 0 })), {
    rows: [],
    quiet: 'No open incidents',
    span: null,
    settled: '1 mitigated',
    mitigated: '1 mitigated incident is marked Caution on the ring.'
  });
  assert.deepEqual(safetyLead(tile({ serious: 0, caution: 0, open: 0, mitigated: 0, closed: 0 })), {
    rows: [],
    quiet: 'No reported incidents',
    span: null,
    settled: null,
    mitigated: null
  });
  // One incident can mark many subchapters: the line says how many (A7).
  const blocks = [{ id: 'B1', safety: 'caution' }, { id: 'B2', safety: 'serious' }, { id: 'B3', safety: null }, { id: 'B4' }];
  assert.equal(safetyLead(tile({ serious: 1, caution: 0, open: 1, mitigated: 0, closed: 0 }, blocks)).span, 'across 2 subchapters');
  assert.equal(safetyLead(tile({ serious: 1, caution: 0, open: 1, mitigated: 0, closed: 0 }, blocks.slice(0, 1))).span, 'across 1 subchapter');
  assert.equal(openIncidents({ card_id: 'old' }), null);
  const source = read('features/catalogue/CatalogueTile.jsx');
  assert.match(source, /<StatusMark status=\{status\} size=\{14\} \/>/);
  assert.match(source, /<StatusMark status="no_incidents" \/>/);
});

// ------------------------------------------------------ against the demo pack

let backend = null;
let demoDir = null;

before(async () => {
  backend = await startTestBackend();
  const catalogue = await apiClient(backend.origin).getCatalogue();
  if (catalogue.tiles.some((tile) => tile.safety?.open > 0)) {
    return;
  }
  await backend.stop();
  demoDir = mkdtempSync(path.join(tmpdir(), 'bmc-demo-'));
  const db = path.join(demoDir, 'demo.sqlite');
  const result = spawnSync(pythonPath(), ['-m', 'app.demo', 'build', '--db', db, '--uploads-dir', path.join(demoDir, 'uploads'), '--quiet'], {
    cwd: BACKEND_DIR,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  backend = await startTestBackend({ db });
});
after(async () => {
  await backend?.stop();
  if (demoDir) rmSync(demoDir, { recursive: true, force: true });
});

const CARD = { model: 'SynGPT-2.0', useCase: 'Clinician Facing CDSS' };

test('demo pack: the Safety view marks match the summary, and the lens rule holds', async () => {
  const client = apiClient(backend.origin);
  const overview = await client.getAtlasOverview();
  const conditionIds = new Set(overview.conditions.map((concept) => concept.concept_id));
  for (const lens of [ALL, { ...ALL, age: 'Age 0-17' }, { ...ALL, age: 'Age 65+' }]) {
    const [map, summary] = await Promise.all([
      client.getMetricMap({ ...CARD, ...lens, scope: 'atlas' }),
      client.getMetricSummary({ ...CARD, ...lens, view: 'safety' })
    ]);
    const column = map.columns.indexOf('safety');
    const counts = { serious: 0, caution: 0, no_incidents: 0 };
    for (const row of map.rows) {
      if (conditionIds.has(row[0])) counts[mapRowStatus({ safety: row[column] }, 'safety')] += 1;
    }
    assert.deepEqual(counts, safetyDisplayCounts(summary.safety_counts), `${lens.age}: the ring and the centre count the same`);
  }
  // SI-2026-001 (Age 65+, BA00 and BD11, open, harm possible) is Serious for All ages and Age 65+, not for Age 0-17.
  const at = async (age) => (await client.getConceptMetrics({ ...CARD, ...ALL, age, conceptId: 'BA00' })).incidents.map((item) => item.incident_id);
  assert.ok((await at('All ages')).includes('SI-2026-001'));
  assert.ok((await at('Age 65+')).includes('SI-2026-001'));
  assert.ok(!(await at('Age 0-17')).includes('SI-2026-001'));
  const card = await client.getConceptMetrics({ ...CARD, ...ALL, conceptId: 'BA00' });
  assert.equal(incidentsMark(card.incidents), 'serious');
  assert.equal(openIncidentChip(card.incidents).tone, 'serious');
});

test('demo pack: row sources and catalogue safety counts', async () => {
  const client = apiClient(backend.origin);
  const merged = await client.getConceptMetrics({ ...CARD, ...ALL, conceptId: '5A11' });
  assert.equal(merged.metrics.provenance.data_source.study, 'NBR-2026-01');
  assert.match(dataSourceSentence(merged.metrics.provenance.data_source, 'plain'), /, synthetic\.$/);
  const seed = await client.getConceptMetrics({ model: 'SynGPT-1.0', useCase: 'Clinician Facing CDSS', ...ALL, conceptId: '5A11' });
  assert.equal(seed.metrics.provenance.data_source.source, 'Seed (synthetic, version 1)');

  const catalogue = await client.getCatalogue();
  const tile = catalogue.tiles.find((entry) => entry.card_id === 'SynGPT-2.0|Clinician Facing CDSS');
  const counts = openIncidents(tile);
  assert.equal(counts.open, counts.serious + counts.caution);
  assert.ok(counts.serious >= 1 && counts.caution >= 1 && counts.mitigated >= 1);
  assert.ok(safetyLead(tile).rows.length === 2);
});

test('the card export takes incidents only from the read for the current filters', () => {
  const app = readFileSync(fileURLToPath(new URL('../frontend/src/app/AtlasApp.jsx', import.meta.url)), 'utf8');
  const handler = app.slice(app.indexOf('const handleExportConcept'), app.indexOf('// Load failures'));
  assert.match(handler, /currentDetails\.incidents/);
  assert.doesNotMatch(handler, /shownDetails/, 'a refreshing card keeps the previous read on screen; its incidents must not reach the export');
  const card = read('features/details/DetailCard.jsx');
  assert.equal((card.match(/disabled=\{isRefreshing\} onClick=\{\(\) => onExport\(/g) ?? []).length, 2, 'both export buttons wait while the card refreshes');
  assert.match(app, /isRefreshing=\{!currentDetails\}/);
});

test('closed incidents only: the card reads "No open incidents", never "No reported incidents"', () => {
  const closed = [incident({ incident_id: 'SI-closed', status: 'closed', severity: null })];
  assert.equal(incidentsMark(closed), 'no_incidents', 'the neutral mark, not coloured');
  assert.equal(incidentsMarkWord(closed), 'No open incidents');
  assert.equal(incidentsMarkWord([]), null, 'no incidents at all keeps the mark’s own word');
  assert.equal(DISPLAY.no_incidents.label, 'No reported incidents');
  assert.equal(incidentsMarkWord([incident()]), null, 'a marked incident keeps Serious');
  for (const depth of ['plain', 'expert']) {
    const html = renderToStaticMarkup(createElement(IncidentList, { incidents: closed, depth }));
    const words = text(html);
    assert.match(words, /No open incidents/);
    assert.doesNotMatch(words, /No reported incidents/);
    assert.match(html, /data-severity="closed"/, 'the closed incident is still listed');
    assertNoSafeClaim(words, `closed only ${depth}`);
  }
  const card = read('features/details/DetailCard.jsx');
  assert.match(card, /headerWord = isSafetyView\(viewId\) \? incidentsMarkWord\(incidents\)/);
  assert.match(card, /<StatusLabel status=\{headerStatus\} size="large" toned>\s*\{headerWord\}/);
});

test('off the Safety view a reported incident still reads in the hover card, without changing the result', async () => {
  const { incidentHint } = await import('../frontend/src/features/atlas/safetyTally.js');
  const condition = { level: 2 };
  const block = { level: 1 };
  const serious = { overall_status: 'strong', safety: 'serious' };
  assert.deepEqual(incidentHint(serious, condition, 'performance'), {
    status: 'serious',
    text: 'A serious safety incident is reported. Select it to read it; it does not change this result.'
  });
  // On Overview the incident's mark is drawn, so the line names the result underneath.
  assert.deepEqual(incidentHint(serious, condition, 'overall'), {
    status: 'serious',
    result: 'Strong',
    text: 'An open serious safety incident is reported, so its mark shows here. The result underneath is Strong; incidents never change it.'
  });
  assert.equal(incidentHint({ safety: 'caution' }, block, 'performance').text, 'Holds conditions with a caution safety incident. The Safety view marks them.');
  // The Safety view's own mark says it; Multimorbidity and unmarked rows say nothing.
  assert.equal(incidentHint(serious, condition, 'safety'), null);
  assert.equal(incidentHint(serious, condition, 'overall', { isCombinationMode: true }), null);
  assert.equal(incidentHint({ overall_status: 'strong', safety: null }, condition, 'overall'), null);
  assert.equal(incidentHint(null, condition, 'evidence'), null);
});
