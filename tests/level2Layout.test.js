// Chapter circle layout: every concept gets a seat inside the band, seats
// never overlap, and dense chapters pack fast enough for a first-visit
// drill-down.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildChapterStructure } from '../frontend/src/features/atlas/atlasStructure.js';
import { MODELCARD_INNER_RADIUS as INNER, MODELCARD_OUTER_RADIUS as OUTER } from '../frontend/src/features/atlas/layout/atlasGeometry.js';
import { buildLevel2ModelFromPayload, createLevel2LayoutPayload } from '../frontend/src/features/atlas/layout/level2Layout.js';
import { apiClient, startTestBackend } from './support/backend.js';

const GAP = 0.5;

let backend;
let payloadsPromise = null;
before(async () => {
  backend = await startTestBackend();
});
after(() => backend?.stop());

function chapterPayloads() {
  payloadsPromise ??= (async () => {
    const client = apiClient(backend.origin);
    const meta = await client.getMeta();
    const payloads = [];
    for (const chapter of meta.chapters) {
      const detail = await client.getChapter({ chapterId: chapter.concept_id });
      payloads.push({ chapterNo: chapter.chapter_no, count: detail.concepts.length, payload: createLevel2LayoutPayload(buildChapterStructure(detail)) });
    }
    return payloads;
  })();
  return payloadsPromise.then((payloads) => [...payloads]);
}

test('every chapter packs all concepts inside the band without overlap', async () => {
  for (const { chapterNo, count, payload } of await chapterPayloads()) {
    const model = buildLevel2ModelFromPayload(payload);
    assert.equal(model.tiles.length, count, `chapter ${chapterNo} seats every concept`);
    const tiles = model.tiles;
    for (const tile of tiles) {
      const distance = Math.hypot(tile.x - 500, tile.y - 500);
      assert.ok(distance - tile.r >= INNER - 1e-6 && distance + tile.r <= OUTER + 1e-6, `chapter ${chapterNo}: ${tile.id} stays in the band`);
    }
    const sorted = [...tiles].sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length && sorted[j].x - sorted[i].x < 60; j += 1) {
        const a = sorted[i];
        const b = sorted[j];
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r + GAP - 1e-6, `chapter ${chapterNo}: ${a.id} and ${b.id} overlap`);
      }
    }
  }
});

test('the densest chapters pack within the drill-down budget', async () => {
  const dense = (await chapterPayloads()).sort((a, b) => b.count - a.count).slice(0, 4);
  for (const { chapterNo, payload } of dense) {
    buildLevel2ModelFromPayload(payload);
    const start = performance.now();
    buildLevel2ModelFromPayload(payload);
    const elapsed = performance.now() - start;
    // Generous for slow CI machines; a regression to the old full rescan took seconds.
    assert.ok(elapsed < 250, `chapter ${chapterNo} packed in ${Math.round(elapsed)} ms`);
  }
});
