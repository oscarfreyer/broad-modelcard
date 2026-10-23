// Short labels and icon keys for ICD-11 chapters and block headings. UI hints
// keyed by chapter number, not ontology data. Chapters of another
// classification (contract v1.13) take their icon from ontologyChapters.js and
// a short label made from their title.
import { ONTOLOGY_CHAPTER_ICONS, hasChapterNumber, isIcd11Chapter } from './ontologyChapters.js';

const HEADING_STOP_WORDS = new Set(['of', 'the', 'or', 'and', 'to', 'for', 'in', 'on', 'at', 'with', 'without', 'from', 'by']);

const HEADING_GENERIC_WORDS = new Set([
  'disease',
  'diseases',
  'disorder',
  'disorders',
  'condition',
  'conditions',
  'system',
  'systems',
  'process',
  'processes',
  'origin'
]);

const HEADING_LEADING_DROP_WORDS = new Set(['certain', 'other', 'predominantly']);

function toHeadingCase(token) {
  return token
    .split('-')
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : part))
    .join('-');
}

function headingWords(value, stripLeadingChapterNumber = false) {
  let text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return [];
  }

  if (stripLeadingChapterNumber) {
    text = text.replace(/^\d+\s+/, '');
  }

  return text
    .split(/\s+/)
    .map((word) => word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9-]+$/g, ''))
    .filter(Boolean);
}

function buildHeadingLabel(value, { stripLeadingChapterNumber = false } = {}) {
  const sourceWords = headingWords(value, stripLeadingChapterNumber);
  if (!sourceWords.length) {
    return '';
  }

  const compactWords = sourceWords.filter((word) => {
    const lower = word.toLowerCase();
    return !HEADING_STOP_WORDS.has(lower) && !HEADING_GENERIC_WORDS.has(lower);
  });

  const workingWords = (compactWords.length ? compactWords : sourceWords).slice();
  while (workingWords.length > 2 && HEADING_LEADING_DROP_WORDS.has(String(workingWords[0]).toLowerCase())) {
    workingWords.shift();
  }

  const pickedWords = workingWords.slice(0, 2).map(toHeadingCase);
  if (pickedWords.length) {
    return pickedWords.join(' ');
  }

  return sourceWords.slice(0, 2).map(toHeadingCase).join(' ');
}

/**
 * The key of a chapter's icon (design/chapterIcons.js, vendored from
 * Healthicons): its two-digit ICD-11 chapter number. A chapter without an
 * icon of its own gets a plain disc (ChapterIcon.jsx).
 */
export function chapterIconKey(chapterConcept) {
  if (!isIcd11Chapter(chapterConcept)) {
    return ONTOLOGY_CHAPTER_ICONS[chapterConcept.concept_id] ?? '';
  }
  return String(chapterConcept?.chapter_no || '').padStart(2, '0');
}

/**
 * "Chapter 4" for a chapter of a classification with chapter numbers (ICD-11,
 * ICD-10-CM); null for MONDO, whose two-digit chapter_no is only its ring position.
 */
export function chapterNumberLabel(chapterConcept) {
  const chapterNo = String(chapterConcept?.chapter_no || '');
  if (!chapterNo || !hasChapterNumber(chapterConcept)) {
    return null;
  }
  return `Chapter ${Number(chapterNo) || chapterNo}`;
}

/**
 * The deliberate short name of a chapter on the atlas rim (critique round 1,
 * R2): one or two plain words chosen to fit the chapter's arc at 13 px on a
 * 1280 px screen (arcLabels.planChapterLabel; tests/chapterLabels.test.js).
 * The full ICD-11 title is the chapter's accessible name and shows on hover
 * and focus.
 */
export function chapterShortLabel(chapterConcept) {
  if (!isIcd11Chapter(chapterConcept)) {
    return buildHeadingLabel(chapterConcept?.pt);
  }
  const chapterNo = String(chapterConcept?.chapter_no || '').padStart(2, '0');
  const labelByChapterNo = {
    '01': 'Infectious',
    '02': 'Neoplasms',
    '03': 'Blood',
    '04': 'Immune',
    '05': 'Metabolic',
    '06': 'Mental',
    '07': 'Sleep',
    '08': 'Nervous',
    '09': 'Vision',
    '10': 'Ear',
    '11': 'Circulatory',
    '12': 'Respiratory',
    '13': 'Digestive',
    '14': 'Skin',
    '15': 'Bone & joint',
    '16': 'Urogenital',
    '17': 'Sexual health',
    '18': 'Pregnancy',
    '19': 'Perinatal',
    '20': 'Anomalies',
    '22': 'Injuries'
  };
  return labelByChapterNo[chapterNo] || buildHeadingLabel(chapterConcept?.pt, { stripLeadingChapterNumber: true });
}
