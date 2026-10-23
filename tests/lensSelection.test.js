// A demographic lens from the URL is only sent once the axes from /meta hold
// every value (app/lensSelection.js, used by useModelSelection.js), so
// `atlas.html?age=Age%2099` never fires a metrics request with the bogus lens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStartupParams } from '../frontend/src/app/startupParams.js';
import { fitLens, isLensSendable, withDefaults } from '../frontend/src/app/lensSelection.js';

const AXES = Object.freeze({
  context: ['Primary care'],
  age: ['All ages', 'Age 0-17', 'Age 18-39', 'Age 40-64', 'Age 65+'],
  sex: ['All sexes', 'Female', 'Male'],
  ethnicity: ['All ethnicities', 'Group A', 'Group B']
});
const ALL = { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };

test('a bogus URL lens is never sendable, before or after the axes load', () => {
  const lens = withDefaults(parseStartupParams('?age=Age%2099&sex=Female').lens);
  assert.deepEqual(lens, { age: 'Age 99', sex: 'Female', ethnicity: 'All ethnicities' });
  assert.equal(isLensSendable(lens, null), false, 'unchecked before /meta');
  // The render right after /meta arrives, before the correcting effect ran:
  assert.equal(isLensSendable(lens, AXES), false, 'the axes do not hold "Age 99"');
  const fitted = fitLens(lens, AXES);
  assert.deepEqual(fitted, { age: 'All ages', sex: 'Female', ethnicity: 'All ethnicities' }, 'only the bogus value falls back');
  assert.equal(isLensSendable(fitted, AXES), true);
});

test('a valid URL lens waits for the axes, then is sent unchanged', () => {
  const lens = withDefaults({ age: 'Age 65+', sex: null, ethnicity: 'Group B' });
  assert.equal(isLensSendable(lens, null), false);
  assert.equal(isLensSendable(lens, AXES), true);
  assert.equal(fitLens(lens, AXES), lens, 'no change keeps the same object (no extra render)');
});

test('the all-population lens is sendable at once', () => {
  assert.equal(isLensSendable(ALL, null), true);
  assert.equal(isLensSendable(ALL, AXES), true);
  assert.equal(isLensSendable(ALL, { age: [], sex: [], ethnicity: [] }), true, '"All …" needs no axis entry');
  assert.equal(fitLens(ALL, null), ALL);
});

test('an axis /meta does not list cannot hold a filter value', () => {
  const lens = withDefaults({ sex: 'Female' });
  const partial = { age: AXES.age, ethnicity: AXES.ethnicity };
  assert.equal(isLensSendable(lens, partial), false);
  assert.deepEqual(fitLens(lens, partial), ALL, 'it falls back to "All …" instead of staying stuck');
});

test('useModelSelection gates its filters on the checked lens', () => {
  const source = readFileSync(new URL('../frontend/src/app/useModelSelection.js', import.meta.url), 'utf8');
  assert.match(source, /isLensSendable\(lens, axes\)/);
  assert.doesNotMatch(source, /Boolean\(axes\) \|\|/, 'axes alone no longer confirm the lens');
});
