// Release 0.5, round 1: source-level
// checks for the changes that have no pure function of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../frontend/src/${path}`, import.meta.url), 'utf8');

test('the comparison shows each card’s atlas as on its catalogue tile (U-C)', () => {
  const table = read('features/compare/ComparisonTable.jsx');
  // The same drawing and data as the catalogue tile: CardSnapshot over tile.snapshot.blocks, Overview mode.
  assert.match(table, /<CardSnapshot[\s\S]*?blocks=\{tile\?\.snapshot\?\.blocks\}[\s\S]*?mode=\{SNAPSHOT_MODES\.overview\}/);
  assert.match(read('features/catalogue/CatalogueTile.jsx'), /<CardSnapshot[\s\S]*?blocks=\{tile\.snapshot\?\.blocks\}/);
  // Inside the column heading's link to the card's atlas.
  assert.match(table, /<a className="cmp-card-link" href=\{cardAtlasHref\(card\.card_id, context\)\}>\s*\{snapshots \? <ColumnSnapshot/);
  const app = read('features/compare/CompareApp.jsx');
  assert.match(app, /const geometry = useSnapshotGeometry\(\);/);
  assert.match(app, /snapshots=\{snapshots\}/);
});

test('no dot separators in anything a reader sees: page titles, strings, the panel (U-D)', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const root = new URL('../frontend/', import.meta.url);
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = new URL(name, dir);
      if (statSync(full).isDirectory()) {
        if (!['static-data', 'dist', 'dist-static'].includes(name)) walk(new URL(`${name}/`, dir));
      } else if (/\.(jsx?|html)$/.test(name)) {
        files.push(full);
      }
    }
  };
  walk(root);
  assert.ok(files.length > 100);
  for (const file of files) {
    // Comments may quote a formula (0.35·perf); code and markup may not use the dot.
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
      .join('\n');
    assert.doesNotMatch(code, /·/, file.pathname);
  }
});
