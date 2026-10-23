import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLevelOneModel } from '../frontend/src/features/atlas/layout/atlasLayout.js';

test('scales the disease atlas so the limiting chapter reaches the outer edge', () => {
  const chapters = [
    { concept_id: 'CH-01', level: 0, chapter_no: '01', pt: '01 Chapter one' },
    { concept_id: 'CH-02', level: 0, chapter_no: '02', pt: '02 Chapter two' }
  ];
  const blocksByChapterId = {
    'CH-01': [{ concept_id: 'BL-01', parent_id: 'CH-01', level: 1, pt: 'Block one' }],
    'CH-02': [{ concept_id: 'BL-02', parent_id: 'CH-02', level: 1, pt: 'Block two' }]
  };
  const conditionsByBlockId = {
    'BL-01': Array.from({ length: 180 }, (_, index) => ({
      concept_id: `A-${index}`,
      parent_id: 'BL-01',
      level: 2,
      depth_in_kind: 1,
      prevalence_tier: index % 5 === 0 ? 'very_common' : 'uncommon',
      prevalence_score: index % 5 === 0 ? 0.7 : 0.25
    })),
    'BL-02': Array.from({ length: 60 }, (_, index) => ({
      concept_id: `B-${index}`,
      parent_id: 'BL-02',
      level: 2,
      depth_in_kind: 1,
      prevalence_tier: 'rare',
      prevalence_score: 0.12
    }))
  };
  const prevalenceById = Object.fromEntries(
    Object.values(conditionsByBlockId).flat().map((concept) => [concept.concept_id, concept.prevalence_score])
  );

  const model = buildLevelOneModel({
    chapterConcepts: chapters,
    blocksByChapterId,
    conditionsByBlockId,
    conceptPrevalenceById: prevalenceById,
    layoutMode: 'Disease modelcard'
  });
  const maximumEdge = Math.max(...model.tiles.map((tile) => tile.packed_radius + tile.r));

  assert.ok(model.bubbleScale > 1);
  assert.ok(model.radialExpansion >= 1);
  assert.ok(Math.abs(maximumEdge - 390) < 1e-6);
  assert.ok(model.tiles.every((tile) => tile.packed_radius + tile.r <= 390 + 1e-6));
});
