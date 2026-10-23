// Decisions of 2026-10-21 in the frontend: card names without "|" or
// "," in the developer's submission form (CONTRACT.md §11.1), and Not
// appraised on the Evidence view (§22), in words only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptySubmitForm, submitProblems } from '../frontend/src/features/admin/submitForm.js';
import {
  NOT_APPRAISED_MEANING,
  appraisalCounts,
  appraisalHighlight,
  isNotAppraised
} from '../frontend/src/features/atlas/appraisalMark.js';
import { decodeMetricMap } from '../frontend/src/features/atlas/decodeMetricMap.js';

const source = (path) => readFileSync(new URL(`../frontend/src/${path}`, import.meta.url), 'utf8');

const COLUMNS = ['concept_id', 'evidence_status', 'evidence_grade', 'child_count'];
const MAP = {
  columns: COLUMNS,
  rows: [
    ['BLK-1', 'moderate', 'C', 3],
    ['2C30', 'weak', 'D', null],
    ['2C31', 'strong', 'B', null],
    ['2C32', 'no_data', null, null]
  ],
  appraisal: ['includes_linked', 'linked', null, null]
};

test('Not appraised marks graded results without a study record, on the Evidence view only', () => {
  const rows = decodeMetricMap(MAP);
  assert.equal(isNotAppraised(rows.get('2C31'), 'evidence'), true);
  assert.equal(isNotAppraised(rows.get('2C30'), 'evidence'), false, 'linked');
  assert.equal(isNotAppraised(rows.get('BLK-1'), 'evidence'), false, 'a subchapter holding a linked condition');
  assert.equal(isNotAppraised(rows.get('2C32'), 'evidence'), false, 'No data has no grade to appraise');
  for (const view of ['overall', 'performance', 'intended_use', 'safety']) {
    assert.equal(isNotAppraised(rows.get('2C31'), view), false, view);
  }
  assert.equal(isNotAppraised(rows.get('2C31'), 'evidence', { isCombinationMode: true }), false);
  assert.equal(isNotAppraised(rows.get('2C31'), 'evidence', { isLoading: true }), false);
  // A map without the array: no row is linked, so every graded row is not appraised.
  const plain = decodeMetricMap({ ...MAP, appraisal: undefined });
  assert.equal(isNotAppraised(plain.get('2C30'), 'evidence'), true);
});

test('the counts behind the Summary', () => {
  const rows = decodeMetricMap(MAP);
  const conditions = ['2C30', '2C31', '2C32'].map((concept_id) => ({ concept_id }));
  assert.deepEqual(appraisalCounts(conditions, rows), { graded: 2, linked: 1 });
  assert.deepEqual(appraisalHighlight({ graded: 2, linked: 1 }), {
    id: 'appraisal',
    tone: 'not_appraised',
    title: 'Study appraisal for 1 of 2 graded',
    text: `1 condition is Not appraised: ${NOT_APPRAISED_MEANING}.`,
    targetId: null
  });
  assert.equal(appraisalHighlight({ graded: 2365, linked: 0 }).text, 'None of the 2,365 graded conditions has a study record behind its grade.');
  assert.equal(appraisalHighlight({ graded: 0, linked: 0 }), null);
});

test('Not appraised has no mark on the visual card, only words', () => {
  assert.doesNotMatch(source('features/atlas/RingView.jsx'), /RingAppraisalMarks/);
  assert.doesNotMatch(source('features/atlas/RingBubbles.jsx'), /notAppraisedTick|bubble-unappraised/);
  assert.doesNotMatch(source('styles/marks.css'), /bubble-unappraised/);
  for (const file of ['features/atlas/RingLegend.jsx', 'features/atlas/HoverCard.jsx', 'features/summary/SummaryPanel.jsx']) {
    assert.doesNotMatch(source(file), /AppraisalGlyph|NOT_APPRAISED/, file);
  }
  // Named in words: the Summary's card and the condition card's Study quality.
  assert.match(source('features/details/copy/studyCopy.js'), /Not appraised: no study record is linked to this result\./);
});

const NEW_SYSTEM = { ...emptySubmitForm('Dev'), modelVersion: 'Tide-2', displayName: 'Tide 2', useCase: 'Sepsis early warning', resultsFile: { name: 'r.csv' } };

test('the submission form refuses | and , in the AI system and function names', () => {
  assert.deepEqual(submitProblems(NEW_SYSTEM), {});
  for (const useCase of ['Sepsis | triage', 'Sepsis, triage']) {
    assert.equal(submitProblems({ ...NEW_SYSTEM, useCase }).useCase, 'Use a name without | or ,.');
  }
  for (const modelVersion of ['Tide|2', 'Tide,2']) {
    assert.ok(submitProblems({ ...NEW_SYSTEM, modelVersion }).modelVersion);
  }
  // The display name may hold both: it is not part of a card id.
  assert.deepEqual(submitProblems({ ...NEW_SYSTEM, displayName: 'Tide | 2, sepsis' }), {});
});
