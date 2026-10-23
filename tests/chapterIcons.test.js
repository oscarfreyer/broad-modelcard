// D7: the chapter icons are Healthicons, vendored as path data with their
// source, commit, and MIT licence named (no npm package).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHAPTER_ICONS } from '../frontend/src/design/chapterIcons.js';
import { chapterIconKey, chapterShortLabel } from '../frontend/src/features/atlas/layout/chapterLabels.js';

const CHAPTERS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '22'];
const root = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('every atlas chapter has its own Healthicons glyph', () => {
  assert.deepEqual(Object.keys(CHAPTER_ICONS).sort(), CHAPTERS);
  for (const chapterNo of CHAPTERS) {
    const icon = CHAPTER_ICONS[chapterIconKey({ chapter_no: chapterNo })];
    assert.ok(icon, chapterNo);
    assert.match(icon.source, /^outline(?:-24px)?\/[a-z]+\/[\w-]+\.svg$/, `${chapterNo}: an outline icon, with its source file`);
    assert.match(icon.viewBox, /^0 0 (24 24|48 48)$/);
    assert.ok(icon.paths.length && icon.paths.every((path) => /^M[\d.\s,MLHVCSQTAZmlhvcsqtaz-]+$/.test(path.d)), `${chapterNo}: path data only`);
    assert.ok(chapterShortLabel({ chapter_no: chapterNo }));
  }
  assert.equal(new Set(Object.values(CHAPTER_ICONS).map((icon) => icon.source)).size, CHAPTERS.length, 'no icon twice');
  assert.equal(chapterIconKey({ chapter_no: '2' }), '02');
});

test('the vendored icons name their source, commit, and licence, and the notice carries the MIT text', () => {
  const module = readFileSync(new URL('../frontend/src/design/chapterIcons.js', import.meta.url), 'utf8');
  assert.match(module, /github\.com\/resolvetosavelives\/healthicons/);
  assert.match(module, /Commit: {2}36887b268d2cb61f8d91622ad459bdf07910c2b0/);
  assert.match(module, /Licence: MIT/);
  const notices = root('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /## Healthicons/);
  assert.match(notices, /Copyright \(c\) 2021 Resolve to Save Lives/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  const pkg = JSON.parse(root('package.json'));
  assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((name) => /healthicons/i.test(name)), 'no npm package');
  // The ring draws them filled with currentColor inside the chapter badge.
  const icon = readFileSync(new URL('../frontend/src/features/atlas/ChapterIcon.jsx', import.meta.url), 'utf8');
  assert.match(icon, /<g fill="currentColor">/);
});
