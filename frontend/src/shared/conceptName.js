// Display names for atlas concepts (ICD-11, and since contract v1.13 ICD-10-CM and MONDO). The source terms carry layout residue:
// chapters start with their number ("02 Neoplasms") and some categories with
// a hyphen bullet ("- Obesity"). Data and exports keep the terms unchanged.

/** A term without a leading hyphen bullet. */
export function displayTerm(term) {
  return String(term ?? '').replace(/^\s*[-–—]\s+/, '');
}

/** The name to show for a contract Concept. */
export function conceptName(concept) {
  if (!concept) {
    return '';
  }
  const term = displayTerm(concept.pt);
  return concept.level === 0 ? term.replace(/^\d+\s+/, '') : term;
}

/**
 * The code to show beside a concept's name. Conditions show their ICD-11
 * code (in another classification its own code, which is its concept id). Chapters and subchapters carry ICD-11's internal block ids
 * ("BlockL1-1G4"), which mean nothing to a plain reader, so they show only at
 * expert depth; null means "show no code".
 */
export function conceptCode(concept, { isExpert = false } = {}) {
  if (!concept) {
    return null;
  }
  if (concept.level === 2) {
    return concept.icd11_code || concept.concept_id;
  }
  // A chapter by its number at expert depth; a subchapter has no readable
  // code (its id, e.g. BlockL1-1A0, is a linearization id), so its name
  // stands alone (audit A29).
  // MONDO (contract v1.13) has no chapter numbers: its chapter_no is the ring position.
  return isExpert && concept.level === 0 && concept.chapter_no && !String(concept.concept_id || '').startsWith('MONDO:')
    ? `Chapter ${concept.chapter_no}`
    : null;
}
