// Chapter icons of the other classifications (contract v1.13, CONTRACT.md
// §13, §23): a small hand-written assignment of each ICD-10-CM and MONDO
// chapter to the Healthicons glyph of the ICD-11 chapter it is closest to
// (design/chapterIcons.js, keyed by ICD-11 chapter number). UI hints keyed by
// chapter concept id, not ontology data. Authored short names stay ICD-11
// only: other chapters take a short label made from their title.

/** Chapter concept id → ICD-11 chapter number whose icon it shows. */
export const ONTOLOGY_CHAPTER_ICONS = Object.freeze({
  // ICD-10-CM (disease chapters 1–17 and 19)
  'CM-CH-01': '01', // Certain infectious and parasitic diseases
  'CM-CH-02': '02', // Neoplasms
  'CM-CH-03': '03', // Blood and immune mechanism
  'CM-CH-04': '05', // Endocrine, nutritional and metabolic
  'CM-CH-05': '06', // Mental, behavioral and neurodevelopmental
  'CM-CH-06': '08', // Nervous system
  'CM-CH-07': '09', // Eye and adnexa
  'CM-CH-08': '10', // Ear and mastoid process
  'CM-CH-09': '11', // Circulatory system
  'CM-CH-10': '12', // Respiratory system
  'CM-CH-11': '13', // Digestive system
  'CM-CH-12': '14', // Skin and subcutaneous tissue
  'CM-CH-13': '15', // Musculoskeletal system and connective tissue
  'CM-CH-14': '16', // Genitourinary system
  'CM-CH-15': '18', // Pregnancy, childbirth and the puerperium
  'CM-CH-16': '19', // Perinatal period
  'CM-CH-17': '20', // Congenital malformations
  'CM-CH-19': '22', // Injury, poisoning
  // MONDO (backend/app/ontologies/mondo.py CHAPTERS, in ring order)
  'MONDO:0045024': '02', // cancer or benign tumor
  'MONDO:7770010': '01', // disease of primarily extrinsic mechanism
  'MONDO:0002025': '06', // psychiatric disorder
  'MONDO:0100081': '07', // sleep disorder
  'MONDO:0700003': '18', // obstetric disorder
  'MONDO:0005066': '05', // metabolic disease
  'MONDO:0005570': '03', // hematologic disorder
  'MONDO:0005046': '04', // immune system disorder
  'MONDO:0005151': '05', // endocrine system disorder
  'MONDO:0005071': '08', // nervous system disorder
  'MONDO:0024458': '09', // disorder of visual system
  'MONDO:0002022': '09', // disorder of orbital region
  'MONDO:0002409': '10', // auditory system disorder
  'MONDO:0024623': '10', // otorhinolaryngologic disease
  'MONDO:0004995': '11', // cardiovascular disorder
  'MONDO:0005087': '12', // respiratory system disorder
  'MONDO:0004335': '13', // digestive system disorder
  'MONDO:0006858': '13', // mouth disorder
  'MONDO:0002051': '14', // integumentary system disorder
  'MONDO:0002081': '15', // musculoskeletal system disorder
  'MONDO:0003900': '15', // connective tissue disorder
  'MONDO:0002118': '16', // urinary system disorder
  'MONDO:0005039': '16', // reproductive system disorder
  'MONDO:0002657': '16', // breast disorder
  'MONDO:0002254': '20', // syndromic disease
  'MONDO:7770007': '20', // disease by developmental or physiological process
  'MONDO:7770008': '22' // disease by etiologic mechanism
});

/**
 * Whether a chapter concept is an ICD-11 chapter (`CH-05`). Concepts without
 * an id (layout tests, placeholders) count as ICD-11.
 */
export function isIcd11Chapter(chapterConcept) {
  const id = String(chapterConcept?.concept_id || '');
  return !id || id.startsWith('CH-');
}

/** Whether a chapter belongs to a classification with chapter numbers (ICD-11, ICD-10-CM). MONDO's chapter_no is its ring position. */
export function hasChapterNumber(chapterConcept) {
  return isIcd11Chapter(chapterConcept) || String(chapterConcept?.concept_id || '').startsWith('CM-CH-');
}
