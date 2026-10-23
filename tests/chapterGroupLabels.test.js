// E11: the chapter view's subchapter names are never cropped and never
// scaled. Every block name around each of the 21 chapter circles is drawn at
// one calm size per ring, the atlas chapter labels' size (13 px on a 1280×800
// and a 1440×900 screen, never larger than the atlas labels), on one line,
// clear of the chapter switch rim; a name that does not fit its arc at that
// size is left out, never shrunk or grown. The switch rim and the names open
// their full title at once.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildChapterStructure } from '../frontend/src/features/atlas/atlasStructure.js';
import { buildAtlasStructure } from '../frontend/src/features/atlas/atlasStructure.js';
import {
  CHAPTER_RIM_RADIUS,
  CHAPTER_RIM_WIDTH,
  GROUP_LABEL_RADIUS,
  groupLabelFont,
  groupLabelSpan,
  labelEm,
  planChapterLabels,
  planGroupLabel,
  quantizeScale
} from '../frontend/src/features/atlas/arcLabels.js';
import { ATLAS_LAYOUT_MODES, buildLevelOneModel } from '../frontend/src/features/atlas/layout/atlasLayout.js';
import { buildLevel2ModelFromPayload, createLevel2LayoutPayload } from '../frontend/src/features/atlas/layout/level2Layout.js';
import { groupShortLabel, groupShortNames } from '../frontend/src/features/atlas/layout/groupLabels.js';
import { apiClient, startTestBackend } from './support/backend.js';

const read = (relative) => readFileSync(new URL(`../frontend/src/${relative}`, import.meta.url), 'utf8');
// CSS px per SVG unit of the ring as measured in Chrome (atlasReading.test.js; ring width / 960).
const FLOOR_SCALES = { '1280×800': quantizeScale(0.6083), '1440×900': quantizeScale(0.7333) };
const SMALL_SCALES = { '1280×700': quantizeScale(0.5708), '375×812': quantizeScale(0.3656), '1024×768': quantizeScale(0.4167) };
// Since 2026-10-15 a subchapter's sector is at least as wide as its short
// name at the largest label size (level2Layout.js labelMinimumAngle), so no
// name is left out on any ring that draws labels; before, a few were on small
// rings (shown on hover and in the card).
const LEFT_OUT_ON_SMALL_RINGS = new Set();

let backend;
let groupsPromise = null;
before(async () => {
  backend = await startTestBackend();
});
after(() => backend?.stop());

function chapterGroups() {
  groupsPromise ??= (async () => {
    const client = apiClient(backend.origin);
    const meta = await client.getMeta();
    const all = [];
    for (const chapter of meta.chapters) {
      const detail = await client.getChapter({ chapterId: chapter.concept_id });
      const model = buildLevel2ModelFromPayload(createLevel2LayoutPayload(buildChapterStructure(detail)));
      model.groups.forEach((group) => all.push({ chapterNo: chapter.chapter_no, group }));
    }
    return all;
  })();
  return groupsPromise;
}

test('one size per ring, never larger than the atlas chapter labels, clear of the rim, never cut or scaled', async () => {
  const groups = await chapterGroups();
  assert.ok(groups.length > 100, `${groups.length} blocks shown`);
  assert.equal(new Set(groups.map(({ chapterNo }) => chapterNo)).size, 21);
  const overview = await apiClient(backend.origin).getAtlasOverview();
  const structure = buildAtlasStructure(overview);
  const atlas = buildLevelOneModel({
    chapterConcepts: structure.chapterConcepts,
    blocksByChapterId: structure.blocksByChapterId,
    conditionsByBlockId: structure.topLevelConditionsByBlockId,
    conceptPrevalenceById: structure.conceptPrevalenceById,
    layoutMode: ATLAS_LAYOUT_MODES[0]
  });
  const rimInner = CHAPTER_RIM_RADIUS - CHAPTER_RIM_WIDTH / 2;
  for (const [viewport, scale] of Object.entries({ ...FLOOR_SCALES, ...SMALL_SCALES })) {
    const font = groupLabelFont(scale);
    // Never larger than the atlas's own chapter labels on a ring of the same size.
    const atlasFont = Math.min(...[...planChapterLabels(atlas.regions, scale).values()].map((plan) => plan.font));
    assert.ok(font <= atlasFont + 1e-9, `${viewport}: ${font.toFixed(1)} units ≤ atlas ${atlasFont.toFixed(1)}`);
    // A full line height above the baseline stays inside the circle's label band, 8 units clear of the rim.
    assert.ok(GROUP_LABEL_RADIUS + font <= rimInner - 8, `${viewport}: label top ${GROUP_LABEL_RADIUS + font} clear of the rim at ${rimInner}`);
    const sizes = new Set();
    for (const { chapterNo, group } of groups) {
      const label = groupShortLabel(group);
      const plan = planGroupLabel({ ...group, label }, scale);
      if (!plan) {
        assert.ok(viewport in SMALL_SCALES && LEFT_OUT_ON_SMALL_RINGS.has(label), `${viewport}, chapter ${chapterNo}: "${label}" is drawn`);
        assert.ok(labelEm(label) * font > groupLabelSpan(group) * GROUP_LABEL_RADIUS, `${label} is left out only because it does not fit`);
        continue;
      }
      sizes.add(plan.font);
      assert.equal(plan.text, label, 'drawn whole, never shortened or given an ellipsis');
      assert.ok(labelEm(label) * plan.font <= groupLabelSpan(group) * GROUP_LABEL_RADIUS + 1e-6, `${chapterNo}: ${label} fits its arc`);
      assert.doesNotMatch(label, /…/);
    }
    assert.equal(sizes.size, 1, `${viewport}: one size for every name`);
    if (viewport in FLOOR_SCALES) {
      assert.ok(font * scale >= 13 - 1e-9 && font * scale <= 13.5, `${viewport}: ${(font * scale).toFixed(1)} px`);
    }
  }
});

test('short names are authored for the blocks shown, plain, and the small blocks read "Other"', async () => {
  const groups = await chapterGroups();
  const names = groupShortNames();
  const shown = new Set(groups.map(({ group }) => group.id));
  for (const { group } of groups) {
    if (group.id.startsWith('OTHER-')) {
      assert.equal(groupShortLabel(group), 'Other');
      assert.equal(group.label_full, 'Other subchapters', 'the full name stays for the tip');
    } else {
      assert.ok(names[group.id], `${group.id} (${group.label}) has a short name`);
    }
  }
  for (const [id, name] of Object.entries(names)) {
    assert.ok(shown.has(id), `${id} is a block the chapter view shows`);
    assert.ok(name.length <= 20 && !/\.$/.test(name), `${id}: ${name}`);
  }
  // A block without an entry keeps its title.
  assert.equal(groupShortLabel({ id: 'BLK-X', label: 'Some title' }), 'Some title');
});

test('the chapter view has no sector bands, a thick icon rim, instant tips, and a thin selection ring', () => {
  const frame = read('features/atlas/RingFrame.jsx');
  const chapterFrame = frame.slice(frame.indexOf('function ChapterFrame'), frame.indexOf('function RingFrame'));
  assert.doesNotMatch(chapterFrame, /<title>/, 'no native tooltip (it opens after a delay)');
  assert.doesNotMatch(frame, /sector-a|sector-b/);
  assert.match(chapterFrame, /onPointerEnter=\{\(\) => onTip\?\.\(rimTip\(region, isCurrent\), 'hover'\)\}/);
  assert.match(chapterFrame, /onPointerEnter=\{\(\) => onTip\?\.\(groupTip\(group\), 'hover'\)\}/);
  assert.match(chapterFrame, /<ChapterIcon\s+icon=\{region\.icon\}/);
  const css = read('styles/ring.css');
  assert.match(css, /\.ring-rim-arc \{[^}]*stroke-width: 24;/);
  assert.doesNotMatch(css, /\.ring-sector\.sector-[ab]/);
  // The scale is the ring's layout width, not its box mid-animation (a chapter grows in with a scale transform).
  assert.match(frame, /svg\.clientWidth \|\| svg\.getBoundingClientRect\(\)\.width/);
  // The tip is shown on pointer entry, with no delay (≤ 150 ms).
  const view = read('features/atlas/RingView.jsx');
  assert.doesNotMatch(view.slice(view.indexOf('const showFrameTip'), view.indexOf('const tiles =')), /setTimeout/);
  // Selection: a thin white gap and a 2 px blue ring that hugs the bubble.
  assert.match(css, /\.bubble-halo \{[^}]*stroke: var\(--accent\);[^}]*stroke-width: 2;/);
  assert.match(css, /\.bubble-halo-gap \{[^}]*stroke: var\(--card\);[^}]*stroke-width: 4;/);
  assert.match(view, /const HALO_GAP = 3\.75;/);
});
