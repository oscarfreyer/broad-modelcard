// The model card (once the "developer label") and the card
// snapshot: the snapshot is the atlas in miniature (every
// subchapter where the atlas ring puts it, in its Overview or Safety mark);
// for every card of a demo store, the model card's figures equal
// /metrics/summary (Overview, all-population lens) at the same dataset
// version; the declarations sit in their own block; neither says
// "certified" or "approved".
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NO_STATEMENT_TEXT, keysForView } from '../frontend/src/design/status.js';
import { buildAtlasStructure } from '../frontend/src/features/atlas/atlasStructure.js';
import { ATLAS_LAYOUT_MODES, buildLevelOneModel } from '../frontend/src/features/atlas/layout/atlasLayout.js';
import CardSnapshot from '../frontend/src/features/label/CardSnapshot.js';
import DeveloperLabel from '../frontend/src/features/label/DeveloperLabel.js';
import { LABEL_NOTICE, buildLabelModel, formatShare, labelFileStem } from '../frontend/src/features/label/labelModel.js';
import { SNAPSHOT_MODES, cachedSnapshotGeometry, snapshotGeometry, snapshotMarks, snapshotStatus } from '../frontend/src/features/label/snapshot.js';
import { wrapText } from '../frontend/src/features/label/textWrap.js';
import { BACKEND_DIR, pythonPath } from '../scripts/backendServer.mjs';
import { apiClient, startTestBackend } from './support/backend.js';

const ALL_POPULATION = { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };
const CLAIMS = /\b(certified|certificate|approved|verified)\b/i;

// ---------------------------------------------------------------- snapshot marks

test('a snapshot bubble shows the Overview rule (D10) or the Safety mark', () => {
  const overview = (block, hasIntendedUse = true) => snapshotStatus(block, SNAPSHOT_MODES.overview, { hasIntendedUse });
  const safety = (block) => snapshotStatus(block, SNAPSHOT_MODES.safety);
  // (a) an incident first, (b) out of scope only with a statement, (c) the grade, (d) No data.
  assert.equal(overview({ overview: 'strong', safety: 'serious' }), 'serious');
  assert.equal(overview({ overview: 'out_of_scope', safety: 'caution' }), 'caution');
  assert.equal(overview({ overview: 'out_of_scope', safety: null }), 'out_of_scope');
  assert.equal(overview({ overview: 'out_of_scope', safety: null }, false), 'no_data', 'no statement, no scope');
  assert.equal(overview({ overview: 'moderate', safety: null }), 'moderate');
  assert.equal(overview({ overview: 'no_data', safety: null }), 'no_data');
  assert.equal(overview({ overview: 'not_validated', safety: null }), 'no_data', 'one missing state (D5)');
  assert.equal(overview(null), 'no_data');
  // Safety: the incident where it is, the neutral mark elsewhere (never a result, never green).
  assert.equal(safety({ overview: 'strong', safety: 'serious' }), 'serious');
  assert.equal(safety({ overview: 'strong', safety: 'caution' }), 'caution');
  assert.equal(safety({ overview: 'strong', safety: null }), 'no_incidents');
  assert.equal(safety(null), 'no_incidents');
});

test('label text wraps inside its column', () => {
  const lines = wrapText('Suggests differential diagnoses and next steps to clinicians, who make every decision (fictional).', 292, 13);
  assert.ok(lines.length >= 2);
  const url = wrapText('http://127.0.0.1:5173/atlas.html?model=Corvessa-Skin-Review-1.2&use_case=Skin+lesion+CDSS', 200, 13);
  assert.ok(url.length >= 2, 'a long link breaks between characters');
  assert.equal(url.join(''), 'http://127.0.0.1:5173/atlas.html?model=Corvessa-Skin-Review-1.2&use_case=Skin+lesion+CDSS');
  assert.equal(wrapText('One two three four five six seven', 60, 13, { maxLines: 2 }).length, 2);
  assert.match(wrapText('One two three four five six seven', 60, 13, { maxLines: 2 })[1], /…$/);
  assert.equal(formatShare(0, 2400), '0%');
  assert.equal(formatShare(4, 2400), '<1%');
  assert.equal(formatShare(1499, 2400), '62%');
});

// ---------------------------------------------------------------- a demo store

let backend;
let demoDir = null;
let overview = null;
let geometry = null;

/** The scratch store when it holds the demo pack (products, safety incidents), else a demo store built into a temporary folder. */
before(async () => {
  backend = await startTestBackend();
  const catalogue = await apiClient(backend.origin).getCatalogue();
  if (catalogue.tiles.some((tile) => tile.system.kind === 'product') && catalogue.tiles.some((tile) => tile.safety?.open > 0)) {
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

async function atlasGeometry() {
  if (!geometry) {
    overview = await apiClient(backend.origin).getAtlasOverview();
    geometry = snapshotGeometry(overview);
  }
  return geometry;
}

test('the snapshot places every subchapter exactly where the atlas ring does, computed once per structure', async () => {
  const shape = await atlasGeometry();
  const structure = buildAtlasStructure(overview);
  const atlas = buildLevelOneModel({
    chapterConcepts: structure.chapterConcepts,
    blocksByChapterId: structure.blocksByChapterId,
    conditionsByBlockId: structure.topLevelConditionsByBlockId,
    conceptPrevalenceById: structure.conceptPrevalenceById,
    layoutMode: ATLAS_LAYOUT_MODES[0]
  });
  assert.equal(shape.seats.size, overview.blocks.length);
  assert.equal(shape.seats.size, atlas.tiles.length);
  for (const tile of atlas.tiles) {
    const seat = shape.seats.get(tile.concept_id);
    assert.ok(seat, tile.concept_id);
    assert.ok(Math.abs(seat.x - tile.x) <= 0.05 && Math.abs(seat.y - tile.y) <= 0.05 && Math.abs(seat.r - tile.r) <= 0.05, tile.concept_id);
  }
  // One computation per structure, shared by every tile.
  assert.equal(snapshotGeometry(overview), shape);
  assert.equal(cachedSnapshotGeometry(overview), shape);
  assert.equal(cachedSnapshotGeometry({ blocks: [] }), null);
  // The view box is square around the atlas centre, so the open middle stays in the middle.
  const [x, y, w, h] = shape.viewBox.split(' ').map(Number);
  assert.equal(w, h);
  assert.equal(x + w / 2, 500);
  assert.equal(y + h / 2, 500);
});

test('each tile draws one mark per subchapter: Overview on Performance, incidents where they are on Safety', async () => {
  const shape = await atlasGeometry();
  const catalogue = await apiClient(backend.origin).getCatalogue();
  const withIncident = catalogue.tiles.find((tile) => tile.snapshot.blocks.some((block) => block.safety));
  assert.ok(withIncident, 'the demo pack has an incident');
  for (const tile of [catalogue.tiles[0], withIncident]) {
    const hasIntendedUse = tile.intended_use_defined !== false;
    const marks = snapshotMarks(tile.snapshot.blocks, shape, SNAPSHOT_MODES.overview, { hasIntendedUse });
    assert.equal(marks.length, shape.seats.size);
    const performance = renderToStaticMarkup(createElement(CardSnapshot, { geometry: shape, blocks: tile.snapshot.blocks, hasIntendedUse, decorative: true }));
    assert.equal((performance.match(/<circle class="mark /g) || []).length, shape.seats.size, tile.card_id);
    assert.match(performance, /aria-hidden="true"/);
    assert.doesNotMatch(performance, /data-status="not_validated"/);
    if (!hasIntendedUse) assert.doesNotMatch(performance, /data-status="out_of_scope"/);
  }
  const safety = renderToStaticMarkup(createElement(CardSnapshot, { geometry: shape, blocks: withIncident.snapshot.blocks, mode: SNAPSHOT_MODES.safety }));
  const where = withIncident.snapshot.blocks.filter((block) => block.safety);
  for (const block of where) {
    const seat = shape.seats.get(block.id);
    // The incident mark sits at its subchapter at the subchapter's own size: never enlarged, no zone around it.
    assert.match(safety, new RegExp(`<circle class="mark mark-alert[^"]*" cx="${seat.x}" cy="${seat.y}" r="${seat.r}" data-status="${block.safety}"`), block.id);
  }
  assert.doesNotMatch(safety, /snapshot-halo/);
  assert.doesNotMatch(safety, /data-status="(strong|moderate|weak|out_of_scope|no_data)"/, 'never a result on Safety, never green');
  assert.equal((safety.match(/data-status="no_incidents"/g) || []).length, shape.seats.size - where.length);
  assert.match(safety, /role="img" aria-label="Safety incidents by ICD-11 subchapter, as on the atlas ring: /);
  // Before the structure arrives: a placeholder of the same size, no marks.
  const loading = renderToStaticMarkup(createElement(CardSnapshot, { geometry: null, blocks: withIncident.snapshot.blocks, size: 224 }));
  assert.match(loading, /class="snapshot-placeholder"/);
  assert.match(loading, /width="224" height="224"/);
  assert.doesNotMatch(loading, /class="mark /);
});

test('for every card, the model card figures equal /metrics/summary at the same dataset version', async () => {
  const client = apiClient(backend.origin);
  const geometry = await atlasGeometry();
  const catalogue = await client.getCatalogue();
  assert.ok(catalogue.tiles.some((tile) => tile.system.kind === 'product'), 'a demo store with products');
  let withIncidents = 0;
  for (const tile of catalogue.tiles) {
    const model = buildLabelModel(tile, catalogue, { pageUrl: 'http://127.0.0.1:5173/' });
    const summary = await client.getMetricSummary({ model: tile.model_version, useCase: tile.use_case, view: 'overall', ...ALL_POPULATION });
    assert.equal(summary.dataset_version, catalogue.dataset_version, tile.card_id);
    assert.equal(model.datasetVersion, catalogue.dataset_version);
    assert.equal(model.total, summary.total, tile.card_id);
    // The D5 vocabulary: one missing state; a card without a statement has no Out of scope row (D8).
    const keys = keysForView('overall', { hasIntendedUse: tile.intended_use_defined !== false });
    assert.deepEqual(
      model.rows.map((row) => [row.status, row.count]),
      keys.map((status) => [status, summary.counts[status] ?? 0]),
      tile.card_id
    );
    assert.ok(!('not_validated' in summary.counts) || summary.counts.not_validated === 0, `${tile.card_id}: no Not validated count`);
    assert.equal(model.rows.reduce((sum, row) => sum + row.count, 0), catalogue.condition_count);
    if (tile.intended_use_defined === false) {
      assert.equal(summary.counts.out_of_scope ?? 0, 0, `${tile.card_id}: nothing out of scope without a statement`);
      assert.equal(model.noStatement, NO_STATEMENT_TEXT);
    } else {
      assert.equal(model.noStatement, null);
    }

    // The rendered label carries the same figures, the version, the link, and the notice.
    const markup = renderToStaticMarkup(createElement(DeveloperLabel, { model, geometry }));
    for (const row of model.rows) {
      assert.match(markup, new RegExp(`data-status="${row.status}" data-count="${row.count}"`), `${tile.card_id} ${row.status}`);
    }
    assert.match(markup, />Dataset version</);
    assert.ok(markup.includes(`>${catalogue.dataset_version}<`));
    assert.ok(markup.replace(/<[^>]+>/g, '').includes(LABEL_NOTICE.slice(0, 30)));
    assert.ok(markup.includes('atlas.html'));
    assert.doesNotMatch(markup.replace(/<[^>]+>/g, ' '), CLAIMS, `${tile.card_id}: no certification wording`);
    assert.match(labelFileStem(model), new RegExp(`-model-card-v${catalogue.dataset_version}$`));
    // The sheet says what it is, never "label"; its snapshot is the card's atlas in miniature.
    assert.match(markup, /<title[^>]*>Model card for /);
    assert.match(markup, />Model card</);
    assert.doesNotMatch(markup.replace(/<[^>]+>/g, ' '), /\b(Label|Overall)\b|[Nn]ot validated/);
    assert.equal((markup.match(/<svg class="card-snapshot is-overview"/g) || []).length, 1);
    if (model.noStatement) assert.ok(markup.includes(NO_STATEMENT_TEXT), `${tile.card_id}: the D8 line`);

    // Open safety incidents are left out when the catalogue carries none, never shown as 0;
    // with contract v1.7 every tile has them, read from the final tile shape.
    if (!tile.safety) {
      assert.equal(model.incidents, null);
      assert.doesNotMatch(markup, /Open safety incidents/);
    } else {
      assert.equal(model.incidents.serious, tile.safety.serious, tile.card_id);
      assert.equal(model.incidents.caution, tile.safety.caution, tile.card_id);
      assert.equal(model.incidents.open, tile.safety.open, `${tile.card_id}: serious + caution = open`);
      assert.match(markup, /Open safety incidents/);
      if (tile.safety.open) {
        assert.match(markup, new RegExp(`data-status="serious" data-count="${tile.safety.serious}"`));
        assert.match(markup, new RegExp(`data-status="caution" data-count="${tile.safety.caution}"`));
      } else {
        // None open: one quiet mark and "None open", not "0 serious, 0 caution" (S8a).
        assert.match(markup, /data-status="no_incidents" data-count="0"/);
        assert.match(markup, />None open</);
        assert.doesNotMatch(markup, /data-status="serious"/);
      }
      withIncidents += tile.safety.open > 0 ? 1 : 0;
    }
  }
  assert.ok(withIncidents > 0, 'the demo pack has cards with open incidents');
});

test('developer declarations sit only in the separate "Declared by the developer" block', async () => {
  const catalogue = await apiClient(backend.origin).getCatalogue();
  const declared = catalogue.tiles.filter((tile) => tile.declarations && Object.values(tile.declarations).some(Boolean));
  assert.ok(declared.length > 0, 'the demo pack declares something');
  for (const tile of declared) {
    const model = buildLabelModel(tile, catalogue);
    const markup = renderToStaticMarkup(createElement(DeveloperLabel, { model }));
    const block = markup.match(/<g class="label-declared">([\s\S]*?)<\/g>/);
    assert.ok(block, tile.card_id);
    assert.match(block[1], /Declared by the developer/);
    assert.match(block[1], /not checked/);
    // Compare text without tags and spaces: the label wraps lines into separate <text> elements.
    const flat = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, '');
    const inside = flat(block[1]);
    // The text description (<desc>) reads the whole label in order, the declarations under their own heading.
    const desc = markup.match(/<desc[^>]*>([\s\S]*?)<\/desc>/)[1];
    assert.ok(desc.indexOf('Declared by the developer') < desc.indexOf(`${model.declarations[0].label}:`), 'declarations follow their heading');
    assert.match(desc, /Declared by the developer\. The developer&#x27;s own statements, not checked\./);
    const outside = flat(markup.replace(block[0], '').replace(/<desc[\s\S]*?<\/desc>/, ''));
    for (const declaration of model.declarations) {
      const value = flat(declaration.value);
      // Long values are clipped to four lines; their start is always shown.
      assert.ok(inside.includes(value.slice(0, 40)), `${tile.card_id} ${declaration.key} in the block`);
      assert.ok(!outside.includes(value.slice(0, 40)), `${tile.card_id} ${declaration.key} not outside the block`);
    }
    assert.doesNotMatch(block[1].replace(/<[^>]+>/g, ' ').replace(/Not assessed/g, ''), CLAIMS);
  }
});

test('the label never cuts its card link, breaks it at separators, and reads as text (S8a)', async () => {
  const { breakWord, wrapText } = await import('../frontend/src/features/label/textWrap.js');
  const url = 'http://localhost:5223/atlas.html?model=SynGPT-2.0&use_case=Clinician+Facing+CDSS&view=overall&population=northbridge-region';
  const fits = (value) => value.length <= 40;
  const pieces = breakWord(url, fits);
  assert.equal(pieces.join(''), url, 'nothing is lost');
  assert.ok(pieces.every(fits));
  assert.ok(pieces.slice(0, -1).every((piece) => /[/?&=,:]$/.test(piece)), `breaks after separators: ${pieces.join(' | ')}`);
  assert.ok(!wrapText(url, 200, 13).join('').includes('…'));

  const catalogue = await apiClient(backend.origin).getCatalogue();
  const tile = catalogue.tiles[0];
  const model = buildLabelModel(tile, { ...catalogue, population: { id: 'northbridge-region', name: 'Northbridge region (fictional)' } }, { pageUrl: 'http://localhost:5223/' });
  const markup = renderToStaticMarkup(createElement(DeveloperLabel, { model }));
  const link = markup.match(/<a class="label-card-link" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
  assert.ok(link, 'the card link is a real link in the SVG');
  assert.equal(link[1].replace(/&amp;/g, '&'), model.cardUrl);
  const shown = link[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
  // The link reads "Open this card", with a short host-and-page line under it (A24);
  // the PDF prints the full address under the picture.
  assert.equal(shown, 'Open this card');
  assert.ok(markup.includes('>localhost:5223/atlas.html<'), 'the short form of the link is shown');
  const printed = [...markup.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]).join(' ');
  assert.ok(!printed.includes('use_case='), 'the raw query is not printed on the card (the description keeps it)');
  const exportSource = readFileSync(new URL('../frontend/src/features/label/labelExport.js', import.meta.url), 'utf8');
  assert.match(exportSource, /breakWord\(model\.cardUrl, fits\)/, 'the PDF keeps the full card address');
  // The synthetic badge sits at the top; the whole label is in its description.
  assert.ok(markup.indexOf('Synthetic data') < markup.indexOf('label-title'));
  assert.match(markup, /aria-labelledby="label-[^"]+-title label-[^"]+-desc"/);
  assert.match(markup, /<desc[^>]*>[^<]*Overview of 2,400 conditions[^<]*Not a certification, approval, or clinical evidence\.<\/desc>/);
});

test('a card link on this machine says it opens only here; the incident row is placed by measured width (S8a)', async () => {
  const { isLocalLink, LOCAL_LINK_NOTE } = await import('../frontend/src/features/label/labelModel.js');
  assert.equal(isLocalLink('http://localhost:5223/atlas.html'), true);
  assert.equal(isLocalLink('http://127.0.0.1:8000/atlas.html'), true);
  assert.equal(isLocalLink('https://modelcards.example.org/atlas.html'), false);
  const catalogue = await apiClient(backend.origin).getCatalogue();
  const tile = catalogue.tiles.find((item) => item.safety?.open) ?? catalogue.tiles[0];
  const local = renderToStaticMarkup(createElement(DeveloperLabel, { model: buildLabelModel(tile, catalogue, { pageUrl: 'http://localhost:5223/' }) }));
  assert.ok(local.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').includes('A local link: it opens on the computer'));
  const hosted = renderToStaticMarkup(createElement(DeveloperLabel, { model: buildLabelModel(tile, catalogue, { pageUrl: 'https://modelcards.example.org/' }) }));
  assert.ok(!hosted.includes(LOCAL_LINK_NOTE.slice(0, 20)));
  // Two-digit counts still fit: every incident word starts after the previous one ends.
  const model = buildLabelModel({ ...tile, safety: { serious: 12, caution: 34, open: 46, mitigated: 0, closed: 0 } }, catalogue);
  const markup = renderToStaticMarkup(createElement(DeveloperLabel, { model }));
  const xs = [...markup.matchAll(/<text class="label-row-word" x="([\d.]+)"[^>]*>(\d+ (?:serious|caution))<\/text>/g)].map((m) => Number(m[1]));
  assert.equal(xs.length, 2);
  assert.ok(xs[1] - xs[0] >= 80, `caution starts after "12 serious" (${xs})`);
  assert.ok(xs[1] + 75 <= 340, `and ends inside the sheet (${xs})`);
});
