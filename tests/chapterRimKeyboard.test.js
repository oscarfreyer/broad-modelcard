// The chapter switch around a chapter circle is reachable from the keyboard
// (a long-standing follow-up, closed 2026-10-14): one tab stop on the open
// chapter, arrow keys move along the rim, Enter opens a chapter, and the new
// chapter's ring takes the focus, as on the atlas rim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextChapterId } from '../frontend/src/features/atlas/ringKeyboard.js';

const read = (path) => readFileSync(new URL(`../frontend/src/${path}`, import.meta.url), 'utf8');

test('the chapter switch is a labelled group with one roving tab stop', () => {
  const frame = read('features/atlas/RingFrame.jsx');
  const chapterFrame = frame.slice(frame.indexOf('function ChapterFrame'), frame.indexOf('function RingFrame'));
  assert.doesNotMatch(chapterFrame, /className="ring-rim" aria-hidden="true"/, 'the rim is no longer hidden from assistive tech');
  assert.match(chapterFrame, /className="ring-rim"\s+role="group"\s+aria-label=\{RIM_LABEL\}/);
  assert.match(chapterFrame, /role="button"\s+tabIndex=\{region\.concept_id === rimTabStopId \? 0 : -1\}/);
  assert.match(chapterFrame, /aria-current=\{isCurrent \? 'page' : undefined\}/);
  assert.match(chapterFrame, /nextChapterId\(rimIds, currentId, event\.key\)/);
  assert.match(chapterFrame, /rim\.onOpenChapter\(currentId, 'keyboard'\)/);
});

test('a chapter opened from the switch by keyboard hands the focus to its ring', () => {
  const pane = read('features/atlas/RingPane.jsx');
  assert.match(pane, /rim=\{ring\.rim \? \{ \.\.\.ring\.rim, onOpenChapter: rimOpenChapter \} : null\}/);
  assert.match(pane, /focusChapter\.current = how === 'keyboard' \? chapterId : null;\s+rimOpen\?\.\(chapterId, how\)/);
});

test('the focused rim segment is outlined in the focus blue', () => {
  const css = read('styles/ring.css');
  assert.match(css, /\.ring-rim-segment:focus-visible \.ring-rim-arc \{[^}]*stroke: var\(--focus\);/);
});

test('the rim arrows wrap around the 21 chapters', () => {
  const ids = Array.from({ length: 21 }, (_, index) => `CH-${String(index + 1).padStart(2, '0')}`);
  assert.equal(nextChapterId(ids, 'CH-21', 'ArrowRight'), 'CH-01');
  assert.equal(nextChapterId(ids, 'CH-01', 'ArrowLeft'), 'CH-21');
  assert.equal(nextChapterId(ids, 'CH-14', 'ArrowRight'), 'CH-15');
});
