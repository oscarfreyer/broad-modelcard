// Stable ordering of ICD-11 concepts for layouts and lists.

function conceptOrder(concept) {
  if (!concept) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (Number.isFinite(concept.sort_order)) {
    return concept.sort_order;
  }
  return Number.MAX_SAFE_INTEGER;
}

export function sortConcepts(a, b) {
  const orderDelta = conceptOrder(a) - conceptOrder(b);
  if (orderDelta !== 0) {
    return orderDelta;
  }
  return String(a?.concept_id || '').localeCompare(String(b?.concept_id || ''));
}

export function sortConditionsByName(a, b) {
  const nameDelta = String(a?.pt || '').localeCompare(String(b?.pt || ''));
  if (nameDelta !== 0) {
    return nameDelta;
  }
  return sortConcepts(a, b);
}

function chapterNoValue(concept) {
  const text = String(concept?.chapter_no || concept?.icd11_code || '').trim();
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function sortChapterConcepts(a, b) {
  const chapterDelta = chapterNoValue(a) - chapterNoValue(b);
  if (chapterDelta !== 0) {
    return chapterDelta;
  }
  return sortConcepts(a, b);
}
