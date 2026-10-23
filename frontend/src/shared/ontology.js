// The classification the atlas is drawn in (contract v1.13, CONTRACT.md §23):
// ICD-11, the standard and the storage key of every result, or another
// ontology the store imported (ICD-10-CM, MONDO), whose conditions show the
// ICD-11 result they map to. Framework-free, so the node tests can check it.

export const ICD11 = 'icd11';

const ONTOLOGY_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** ICD-11 as /meta lists it, for data that predates contract v1.13 (an older static snapshot). */
export const ICD11_ENTRY = Object.freeze({
  id: ICD11,
  name: 'ICD-11',
  release: null,
  licence: 'CC BY-ND 3.0 IGO',
  attribution: 'ICD-11 for Mortality and Morbidity Statistics (MMS), World Health Organization',
  is_default: true,
  counts: null,
  mapping_counts: null,
  sources: []
});

export function isOntologyId(value) {
  return typeof value === 'string' && ONTOLOGY_ID.test(value);
}

/** The ontology a read names: null for ICD-11 (or none), so ICD-11 reads stay as they were. */
export function otherOntology(id) {
  return id && id !== ICD11 ? id : null;
}

/** `/meta.ontologies`, or ICD-11 alone when the data does not list any. */
export function ontologyList(meta) {
  const listed = meta?.ontologies;
  return Array.isArray(listed) && listed.length ? listed : [ICD11_ENTRY];
}

const formatCount = (value) => Number(value || 0).toLocaleString('en-US');

/** The share of an ontology's conditions with an ICD-11 mapping, 0–100, or null for ICD-11. */
export function mappedShare(entry) {
  const counts = entry?.mapping_counts;
  if (!counts) {
    return null;
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return total ? Math.round(((total - (counts.none ?? 0)) / total) * 100) : 0;
}

/** One line on an ontology for the Classification choice. */
export function ontologyDescription(entry) {
  const conditions = entry?.counts?.conditions;
  if (!entry || entry.id === ICD11) {
    return `The standard: every result is stored in ICD-11${conditions ? `. ${formatCount(conditions)} conditions` : ''}.`;
  }
  const share = mappedShare(entry);
  const parent = entry.mapping_counts?.parent ? ', some through a parent' : '';
  return `${conditions ? `${formatCount(conditions)} conditions; ` : ''}${share}% show an ICD-11 result${parent}. The others read No mapping.`;
}

/** A licence without its note: "CC BY-ND 3.0 IGO (used unmodified at import)" → "CC BY-ND 3.0 IGO". */
const licenceName = (licence) => String(licence || '').replace(/\s*\(.*\)\s*$/, '');

/** "Mondo Disease Ontology, Monarch Initiative (…), CC BY 4.0.": who to credit for an ontology (its attribution names it). */
export function ontologyAttribution(entry) {
  if (!entry) {
    return '';
  }
  return `${entry.attribution}, ${licenceName(entry.licence)}.`;
}

/** The WHO mapping tables an ontology was resolved through, when its sources name them. */
export function mappingSourceAttribution(entry) {
  const who = entry?.sources?.find((source) => source.id === 'who-mapping');
  return who ? `Mappings: ${who.attribution}, ${licenceName(who.licence)}, used unmodified.` : '';
}

/** Next to the synthetic-data notice: which classification is shown, and that its results come from ICD-11. */
export function ontologyNotice(entry) {
  return entry && entry.id !== ICD11 ? `Shown in ${entry.name}; results are mapped from ICD-11.` : '';
}

/** Why Multimorbidity is off in another ontology. */
export const NO_COMBINATIONS_TEXT = 'Combinations are stored in ICD-11 codes. Switch the classification to ICD-11 to build one.';

function icd11Words(target) {
  if (!target) {
    return 'ICD-11';
  }
  return target.level === 1 ? `the ICD-11 subchapter ${target.pt}` : `ICD-11 ${target.code ? `${target.code} ` : ''}${target.pt}`;
}

/**
 * The one short line the condition card names a mapping with:
 * "Mapped from ICD-11 5A11 Type 2 diabetes mellitus", "Through MONDO parent
 * Diabetes mellitus: mapped from ICD-11 5A14 …", "No ICD-11 mapping, so no
 * result is shown". Null for ICD-11 and for chapters and blocks (rollups).
 *
 * @param {object|null} mapping contract ConceptMapping
 * @param {string} ontologyName
 */
export function mappingSentence(mapping, ontologyName) {
  if (!mapping) {
    return null;
  }
  if (mapping.kind === 'none') {
    return 'No ICD-11 mapping, so no result is shown.';
  }
  const from = `mapped from ${icd11Words(mapping.icd11)}`;
  if (mapping.kind === 'parent' && mapping.via) {
    return `Through ${ontologyName} parent ${mapping.via.pt}: ${from}.`;
  }
  return `${from.replace(/^m/, 'M')}.`;
}

const SOURCE_WORDS = {
  'who-icd10-icd11': 'WHO ICD-10 to ICD-11 table',
  'mondo-icd11-foundation': 'MONDO cross-reference to the ICD-11 Foundation',
  'mondo-icd10cm': 'MONDO cross-reference to ICD-10-CM, then the WHO table',
  'mondo-icd10who': 'MONDO cross-reference to ICD-10, then the WHO table'
};

const KIND_WORDS = {
  exact: 'the same code',
  stem: 'its parent code',
  block: 'the subchapter of its code'
};

/** The expert line on how a mapping was made: its source, the codes, and the kind. */
export function mappingDetail(mapping) {
  if (!mapping || mapping.kind === 'none' || !mapping.source) {
    return null;
  }
  const kind = mapping.kind === 'parent' ? `inherited ${mapping.steps === 1 ? 'one step' : `${mapping.steps} steps`} up` : null;
  const source = SOURCE_WORDS[mapping.source] ?? mapping.source;
  const codes = [mapping.source_code, mapping.icd11_code].filter(Boolean).join(' → ');
  const matched = mapping.kind !== 'parent' && mapping.icd11 && mapping.icd11_code && mapping.icd11_code !== mapping.icd11.code
    ? `; matched in the atlas by ${KIND_WORDS[mapping.kind] ?? mapping.kind}`
    : '';
  return `Source: ${source}${codes ? ` (${codes})` : ''}${matched}${kind ? `; ${kind}` : ''}.`;
}
