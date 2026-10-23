// The status palettes and their non-text contrast. Reads the tokens from
// styles/tokens.css and checks WCAG contrast ratios of relative luminance:
// - Overview, Performance, and Evidence share one muted palette (teal green, warm yellow, soft coral), so only warnings pop;
// - Safety incidents are the vivid members of the yellow and coral families:
//   the same hue as their result, clearly higher chroma;
// - Intended use's scope scale uses the Strong teal;
// - every grey that draws an edge, a bar, or a dot, and every fill's edge,
//   at least 3:1 on white and on the grouped ground;
// - the glyphs on a mark at least 3:1 on its disc.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const tokensCss = readFileSync(fileURLToPath(new URL('../frontend/src/styles/tokens.css', import.meta.url)), 'utf8');

function token(name) {
  const match = tokensCss.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  assert.ok(match, `${name} is a six-digit hex colour in tokens.css`);
  return match[1].toLowerCase();
}

const MATRICES = {
  normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]]
};

const toLinear = (channel) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance of a hex colour as seen with the given vision. */
export function luminance(hex, vision = 'normal') {
  const rgb = [1, 3, 5].map((index) => toLinear(parseInt(hex.slice(index, index + 2), 16)));
  const seen = MATRICES[vision].map((row) => Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])));
  return 0.2126 * seen[0] + 0.7152 * seen[1] + 0.0722 * seen[2];
}

export function contrast(a, b, vision = 'normal') {
  const [x, y] = [luminance(a, vision), luminance(b, vision)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const VISIONS = Object.keys(MATRICES);

/** Hue in degrees and chroma (max minus min channel, 0 to 1) of a hex colour. */
function hueChroma(hex) {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  return { hue: (hue + 360) % 360, chroma: delta };
}

const hueDistance = (a, b) => {
  const d = Math.abs(hueChroma(a).hue - hueChroma(b).hue);
  return Math.min(d, 360 - d);
};

const RESULTS = ['--tone-strong', '--tone-moderate', '--tone-weak'];

test('Overview, Performance, and Evidence share one muted palette: teal green, warm yellow, soft coral', () => {
  const [strong, moderate, weak] = RESULTS.map(token);
  assert.ok(hueChroma(strong).hue >= 155 && hueChroma(strong).hue <= 185, `Strong leans teal: ${hueChroma(strong).hue.toFixed(0)}`);
  assert.ok(hueChroma(moderate).hue >= 38 && hueChroma(moderate).hue <= 52, `Moderate is a warm yellow: ${hueChroma(moderate).hue.toFixed(0)}`);
  assert.ok(hueChroma(weak).hue >= 345 || hueChroma(weak).hue <= 10, `Weak is coral: ${hueChroma(weak).hue.toFixed(0)}`);
  for (const hex of [strong, moderate, weak]) {
    assert.ok(hueChroma(hex).chroma <= 0.55, `${hex} stays muted`);
  }
  // Weak and Out of scope stay apart under every simulation.
  for (const vision of VISIONS) {
    assert.ok(contrast(weak, token('--mark-barred'), vision) >= 1.4, `${vision}: Weak–Out of scope`);
  }
});

test('Safety incidents are the vivid members of the yellow and coral families', () => {
  for (const [alertName, resultName] of [['--alert-caution', '--tone-moderate'], ['--alert-serious', '--tone-weak']]) {
    const [alert, result] = [token(alertName), token(resultName)];
    assert.ok(hueDistance(alert, result) <= 10, `${alertName} in the family of ${resultName}: ${hueDistance(alert, result).toFixed(0)} degrees`);
    assert.ok(hueChroma(alert).chroma - hueChroma(result).chroma >= 0.3, `${alertName} pops out of ${resultName}`);
  }
  assert.ok(hueDistance(token('--alert-caution'), token('--alert-serious')) >= 30);
});

test('edges, bars, and dots reach 3:1 on white and on the grouped ground; fills stay light', () => {
  const grounds = [token('--card'), token('--bg')];
  const edges = [
    '--mark-outline',
    '--mark-barred-edge',
    '--mark-bar',
    '--mark-dot',
    '--mark-quiet-edge',
    '--tone-strong-edge',
    '--tone-moderate-edge',
    '--tone-weak-edge',
    '--alert-caution-edge',
    '--alert-serious-edge'
  ];
  for (const name of edges) {
    for (const ground of grounds) {
      assert.ok(contrast(token(name), ground) >= 3, `${name} on ${ground}: ${contrast(token(name), ground).toFixed(2)}`);
    }
  }
  // The absence fills stay light (a narrow card is a quiet field, audit A18).
  for (const name of ['--mark-barred', '--mark-outline-fill', '--mark-quiet', '--mark-pale']) {
    assert.ok(luminance(token(name)) >= 0.6, `${name} stays light`);
  }
});

test('the glyph on a mark reads at 3:1 on its disc', () => {
  assert.ok(contrast(token('--mark-bar'), token('--mark-barred')) >= 3, 'Out of scope bar');
  assert.ok(contrast(token('--ink'), token('--alert-caution')) >= 3, 'Caution "!"');
  assert.ok(contrast(token('--card'), token('--alert-serious')) >= 3, 'Serious "!"');
});

test('the scope scale uses the Strong teal, with 3:1 edges, a readable ink, and a distinct Partly in scope', () => {
  for (const name of ['--scope-in-edge', '--scope-partly-edge']) {
    for (const ground of [token('--card'), token('--bg')]) {
      assert.ok(contrast(token(name), ground) >= 3, `${name} on ${ground}`);
    }
  }
  assert.ok(contrast(token('--scope-in-ink'), token('--card')) >= 4.5, 'scope ink on white');
  assert.ok(contrast(token('--scope-in-ink'), token('--scope-in-zone')) >= 4.5, 'scope ink on its zone');
  assert.equal(token('--scope-in'), token('--tone-strong'), 'In scope is the Strong teal');
  assert.ok(hueDistance(token('--scope-partly'), token('--tone-strong')) <= 10, 'Partly in scope is a pale teal');
  assert.ok(luminance(token('--scope-partly')) - luminance(token('--scope-in')) >= 0.3, 'Partly in scope is clearly paler than In scope');
  // Never a warning colour, and apart from Out of scope.
  for (const name of ['--alert-caution', '--alert-serious']) {
    assert.ok(hueDistance(token('--scope-in'), token(name)) >= 60, `In scope vs ${name}`);
  }
  for (const vision of VISIONS) {
    assert.ok(contrast(token('--scope-in'), token('--mark-barred'), vision) >= 2, `${vision}: In scope–Out of scope`);
  }
});

