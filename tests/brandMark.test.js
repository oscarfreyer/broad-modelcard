// The brand mark: a ring of bubbles derived from
// the atlas, one source of truth (design/brandMark.js) for every header, the
// live panel, the model card, and the favicon of every page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_COLORS, BRAND_SMALL_MAX, BRAND_VIEWBOX, brandBubbles, brandFaviconHref, brandMarkSvg } from '../frontend/src/design/brandMark.js';

const FRONTEND = fileURLToPath(new URL('../frontend/', import.meta.url));
const read = (relative) => readFileSync(path.join(FRONTEND, relative), 'utf8');

test('the mark is a ring of separate bubbles of varied sizes around an open centre, no stroke and no centre dot', () => {
  for (const size of [16, 32, 64]) {
    const bubbles = brandBubbles(size);
    const centre = BRAND_VIEWBOX / 2;
    assert.ok(bubbles.length >= 6 && bubbles.length <= 20, `${size}px: ${bubbles.length} bubbles`);
    assert.ok(new Set(bubbles.map((bubble) => bubble.r)).size >= 4, `${size}px: varied sizes`);
    // Inside the view box, none overlapping, none at the centre.
    for (const bubble of bubbles) {
      assert.ok(bubble.cx - bubble.r >= 0 && bubble.cx + bubble.r <= BRAND_VIEWBOX && bubble.cy - bubble.r >= 0 && bubble.cy + bubble.r <= BRAND_VIEWBOX);
      assert.ok(Math.hypot(bubble.cx - centre, bubble.cy - centre) - bubble.r > 2, 'the centre stays open');
    }
    for (let i = 0; i < bubbles.length; i += 1) {
      for (let j = i + 1; j < bubbles.length; j += 1) {
        const [a, b] = [bubbles[i], bubbles[j]];
        assert.ok(Math.hypot(a.cx - b.cx, a.cy - b.cy) > a.r + b.r + 0.3, `${size}px: bubbles ${i} and ${j} stay apart`);
      }
    }
    // A few in the strong green, the rest quiet.
    const green = bubbles.filter((bubble) => bubble.tone === 'strong').length;
    assert.ok(green >= 2 && green < bubbles.length / 2, `${size}px: ${green} green`);
    // At 16 px every bubble is at least a pixel and a half across.
    assert.ok(Math.min(...bubbles.map((bubble) => bubble.r)) * 2 * (size / BRAND_VIEWBOX) >= 1.5, `${size}px stays legible`);
  }
  assert.equal(brandBubbles(BRAND_SMALL_MAX), brandBubbles(16), 'the small mark up to 20 px');
  const svg = brandMarkSvg(32);
  assert.doesNotMatch(svg, /stroke/);
  assert.equal((svg.match(/<circle /g) || []).length, brandBubbles(32).length);
  assert.ok(svg.includes(BRAND_COLORS.strong));
});

test('every page carries the small mark as its favicon', () => {
  const pages = readdirSync(FRONTEND).filter((name) => name.endsWith('.html'));
  assert.ok(pages.length >= 5);
  for (const name of pages) {
    const icon = read(name).match(/<link rel="icon" href="([^"]+)" \/>/);
    assert.ok(icon, name);
    assert.equal(icon[1], brandFaviconHref(), `${name} favicon`);
  }
});

test('every header draws the one mark; the retired target ring is gone', () => {
  // One header on every page draws the mark.
  const sites = ['src/design/AppHeader.jsx'];
  assert.match(read('src/design/AppHeader.jsx'), /<BrandMark\b/);
  assert.match(read('src/embed/panelView.js'), /brandBubbles\(size\)/, 'the live panel');
  assert.match(read('src/features/label/DeveloperLabel.js'), /brandBubbles\(BRAND\)/, 'the model card');
  // The thick green ring with a dark centre dot ("looks military") is nowhere.
  const retired = /strokeWidth="5"|stroke-width: 5;|p-brand-ring|label-brand-ring|p-brand-dot|label-brand-dot/;
  for (const file of [...sites, 'src/embed/panelView.js', 'src/embed/panel.css', 'src/features/label/DeveloperLabel.js', 'src/styles/label.css']) {
    assert.doesNotMatch(read(file), retired, file);
  }
});

test('the brand colours equal their design tokens in styles/tokens.css (B15)', async () => {
  // The tokens the literal brand colours stand for.
  const BRAND_TOKENS = { strong: '--tone-strong', quiet: '--mark-quiet' };
  const tokens = read('src/styles/tokens.css');
  for (const [tone, token] of Object.entries(BRAND_TOKENS)) {
    const match = tokens.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
    assert.ok(match, `${token} is defined in tokens.css`);
    assert.equal(BRAND_COLORS[tone].toLowerCase(), match[1].toLowerCase(), `${tone} = ${token}`);
  }
  assert.deepEqual(Object.keys(BRAND_TOKENS).sort(), Object.keys(BRAND_COLORS).sort());
  // The PDF's page corners take the --card token, not a literal white.
  const exporter = read('src/features/label/labelExport.js');
  assert.doesNotMatch(exporter, /#ffffff/i);
  assert.match(exporter, /getPropertyValue\('--card'\)/);
});
