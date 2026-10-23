// The label dialog gives focus back to the button that opened it
// (features/label/dialogFocus.js), so Esc, Close, or the backdrop do not drop
// keyboard users on <body>, and its Esc does not also step back in the atlas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rememberOpener } from '../frontend/src/features/label/dialogFocus.js';

function fakeDocument() {
  const doc = { body: { isConnected: true, focus() {} }, activeElement: null };
  doc.activeElement = doc.body;
  const element = (name) => {
    const node = {
      name,
      isConnected: true,
      focus() {
        doc.activeElement = node;
      }
    };
    return node;
  };
  return { doc, element };
}

test('focus returns to the control that opened the dialog', () => {
  const { doc, element } = fakeDocument();
  const labelButton = element('Label');
  labelButton.focus();
  const returnFocus = rememberOpener(doc);
  // The dialog takes focus, then React unmounts it and focus falls to <body>.
  element('Close').focus();
  doc.activeElement = doc.body;
  returnFocus();
  assert.equal(doc.activeElement, labelButton);
});

test('focus is left alone when the opener is gone or nothing had focus', () => {
  const { doc, element } = fakeDocument();
  const removed = element('Label');
  removed.focus();
  const returnToRemoved = rememberOpener(doc);
  removed.isConnected = false;
  doc.activeElement = doc.body;
  returnToRemoved();
  assert.equal(doc.activeElement, doc.body);

  doc.activeElement = doc.body;
  const returnToBody = rememberOpener(doc);
  const other = element('Search');
  other.focus();
  returnToBody();
  assert.equal(doc.activeElement, other, 'an opener of <body> does not steal focus later');
});

test('the label dialog restores focus on unmount and keeps Esc to itself', () => {
  // The JSX is not loadable under node --test; pin the wiring in its source.
  const source = readFileSync(new URL('../frontend/src/features/label/LabelDialog.jsx', import.meta.url), 'utf8');
  assert.match(source, /const returnFocus = rememberOpener\(document\)/);
  assert.match(source, /return \(\) => \{\s*if \(dialog\?\.open\) \{\s*dialog\.close\(\);\s*\}\s*unlockScroll\(\);\s*returnFocus\(\);/, 'unmount closes the native dialog, then refocuses');
  assert.match(source, /event\.key === 'Escape'\) \{\s*event\.preventDefault\(\);/, 'Esc is marked handled so the atlas does not also step back');
  assert.doesNotMatch(source, /onClose=\{onClose\}/, 'closing does not wait for the frame-timed native close event');
});

test('a modal dialog keeps the page behind it still until the last lock goes (A24)', async () => {
  const { lockPageScroll } = await import('../frontend/src/features/label/dialogFocus.js');
  const classes = new Set();
  const doc = { documentElement: { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } } };
  const first = lockPageScroll(doc);
  const second = lockPageScroll(doc);
  assert.ok(classes.has('has-modal'));
  first();
  first();
  assert.ok(classes.has('has-modal'), 'one release per lock; the second dialog still holds the page');
  second();
  assert.ok(!classes.has('has-modal'));
  const css = readFileSync(new URL('../frontend/src/styles/base.css', import.meta.url), 'utf8');
  assert.match(css, /html\.has-modal \{\s*overflow: hidden;/);
  const label = readFileSync(new URL('../frontend/src/styles/label.css', import.meta.url), 'utf8');
  assert.match(label, /\.label-dialog \{[^}]*overscroll-behavior: contain;/);
  const dialog = readFileSync(new URL('../frontend/src/features/label/LabelDialog.jsx', import.meta.url), 'utf8');
  assert.match(dialog, /const unlockScroll = lockPageScroll\(document\);/);
});
