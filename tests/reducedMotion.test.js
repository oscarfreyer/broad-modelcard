// Reduced motion (audit B10): one intentional rule per stylesheet bundle
// instead of blanket 1 ms overrides, and scripted smooth scrolls that check
// prefers-reduced-motion. The atlas bundle (styles/responsive.css) is handled
// with the atlas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../frontend/src/', import.meta.url));
const read = (relative) => readFileSync(`${SRC}${relative}`, 'utf8');
const BLANKET = /animation-duration:\s*1ms\s*!important|transition-duration:\s*1ms\s*!important/;
const reducedBlocks = (css) => css.split('@media (prefers-reduced-motion: reduce)').length - 1;

test('the Data Library has one intentional reduced-motion rule: nothing moves, states still show', () => {
  const admin = read('styles/admin.css');
  assert.doesNotMatch(admin, BLANKET);
  assert.equal(reducedBlocks(admin), 1);
  const rule = admin.slice(admin.indexOf('@media (prefers-reduced-motion: reduce)'));
  for (const selector of ['.step-body', '.sheet[open]', '.step-glyph.is-working', '.step-chevron', '.progress-fill']) {
    assert.ok(rule.slice(0, 600).includes(selector), selector);
  }
  // Every animation in admin.css is switched off in that rule.
  const animated = [...admin.matchAll(/\n([^\n{}]+)\{[^}]*\banimation:\s*(?!none)[^;]+;/g)].map((match) => match[1].trim());
  for (const selector of animated) {
    assert.ok(rule.slice(0, 600).includes(selector), `${selector} has no reduced-motion override`);
  }
});

test('the live panel has no motion, so it carries no blanket override', () => {
  for (const file of ['embed/panel.css', 'styles/marks.css']) {
    const css = read(file);
    assert.doesNotMatch(css, BLANKET, file);
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /\banimation\s*:|\btransition\s*:|@keyframes/, `${file} stays without motion`);
  }
});

test('skeletons and the catalogue hold still under reduced motion', () => {
  assert.match(read('styles/base.css'), /prefers-reduced-motion: reduce\) \{\s*\.skeleton-line,\s*\.skeleton-dot \{\s*animation: none;/);
  assert.match(read('styles/catalogue.css'), /prefers-reduced-motion: reduce\) \{\s*\.cat-skeleton-ring \{\s*animation: none;/);
});

test('scripted smooth scrolls check prefers-reduced-motion', async () => {
  const { scrollBehavior } = await import('../frontend/src/shared/motion.js');
  const previous = globalThis.window;
  try {
    globalThis.window = { matchMedia: (query) => ({ matches: query === '(prefers-reduced-motion: reduce)' }) };
    assert.equal(scrollBehavior(), 'auto');
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    assert.equal(scrollBehavior(), 'smooth');
  } finally {
    globalThis.window = previous;
  }
  for (const file of ['features/catalogue/CatalogueApp.jsx', 'features/plugin/PluginApp.jsx']) {
    const source = read(file);
    assert.doesNotMatch(source, /behavior: 'smooth'/, file);
    assert.match(source, /behavior: scrollBehavior\(\)/, file);
  }
});
