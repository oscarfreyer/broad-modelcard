// Where the static build's recorded API answers live (release 0.4). scripts/static/record.mjs writes them and
// api/staticAdapter.js reads them, both through these functions, so a request
// always maps to the same file. Every path is relative to the snapshot's root
// (static-data/ next to the pages) and uses only [A-Za-z0-9._-] and '/', so it
// needs no escaping on any static file server.
//
//   manifest.json                                  what the snapshot holds
//   meta.json, models.json, catalogue.json         /meta, /models, /catalogue
//   studies.json, effects.json                     /studies, /effects (all records; filters are rebuilt)
//   incidents.json                                 /incidents (all records; filters are rebuilt; v1.14)
//   synonyms.json                                  { concept_id: [synonyms] }, the ICD-11 search's (v1.14, §31)
//   atlas/overview.json                            /atlas/overview
//   atlas/chapters/<chapter_id>.json               /atlas/chapters/{chapter_id}
//   atlas/concept-chapters.json                    { chapter_id: [concept ids] }
//   atlas/mappings-<chapter_id>.json               per concept: `mapping`, `other_parents` (other ontologies)
//   compare/rows.json                              the comparison's rows at every scope (concepts and mappings)
//   cards/<card>/<lens>/map-atlas.json             /metrics/map scope=atlas
//   cards/<card>/<lens>/map-<chapter_id>.json      /metrics/map scope=chapter
//   cards/<card>/<lens>/summary-<view>.json        /metrics/summary
//   cards/<card>/<lens>/summary-overall-weighted.json  /metrics/summary weights=prevalence (v1.14, §30)
//   cards/<card>/<lens>/compare.json               the card's comparison facts and cells, every scope
//   cards/<card>/all/concepts-<chapter_id>.json    /metrics/concepts/* of one chapter
//   cards/<card>/all/subgroups-<chapter_id>.json   /metrics/concepts/*/subgroups of the chapter's conditions
//   cards/<card>/all/subgroup-summary.json         /metrics/subgroups/summary (v1.14, §24)
//   cards/<card>/versions.json                     /versions?card= (v1.14, §26.6)
//   cards/<card>/record.json, record-jsonld.json   /cards/record, as JSON and JSON-LD (v1.14, §32)
//   cards/<card>/all/mm/index.json                 the recorded selections
//   cards/<card>/all/mm/candidates-<sel>.json      /multimorbidity/candidates, every scope
//   cards/<card>/all/mm/combination-<sel>.json     /multimorbidity/combination
//
// ICD-11 (the default) uses these paths as they are. Another ontology
// (contract v1.13, CONTRACT.md §23) puts the atlas, compare, and card paths
// under ontologies/<id>/ ("ontologies/mondo/atlas/overview.json"). A specific
// care setting (contract v1.14, CONTRACT.md §29; recorded at all patients in
// ICD-11 only) is a lens folder of its own: "setting-emergency-department"
// in place of "all"; Any setting keeps every path as it was.

export const DEFAULT_LENS = Object.freeze({ age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' });
const LENS_AXES = Object.keys(DEFAULT_LENS);
const ICD11 = 'icd11';
// The Context axis value of Any setting (shared/careSetting.js ANY_SETTING): no folder part.
const ANY_SETTING = 'Clinical';

/** A value as a file-name part: letters, digits, dots, and hyphens ("Age 65+" → "Age-65plus", "MONDO:0005066" → "MONDO-0005066"). */
export function slug(value) {
  return String(value ?? '')
    .replace(/\+/g, 'plus')
    .replace(/[^A-Za-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The folder of one card (AI system × function): "<model>__<function>". */
export function cardKey(model, useCase) {
  return `${slug(model)}__${slug(useCase)}`;
}

/** The lens values that differ from "All …", in axis order: [[axis, value]]. */
export function lensGroups(lens = {}) {
  return LENS_AXES.map((axis) => [axis, lens[axis] || DEFAULT_LENS[axis]]).filter(([axis, value]) => value !== DEFAULT_LENS[axis]);
}

/** The specific care setting of a lens (`setting`, contract v1.14), or null for Any setting. */
export function lensSetting(lens = {}) {
  const setting = lens.setting;
  return setting && setting !== ANY_SETTING ? String(setting) : null;
}

/**
 * The folder of one lens: "all", or one part per chosen group ("age-65plus",
 * "sex-female__ethnicity-black"), then a specific care setting
 * ("setting-emergency-department"; v1.14). Any setting adds nothing.
 */
export function lensKey(lens = {}) {
  const parts = lensGroups(lens).map(([, value]) => slug(value).toLowerCase());
  const setting = lensSetting(lens);
  if (setting) parts.push(`setting-${slug(setting).toLowerCase()}`);
  return parts.length ? parts.join('__') : 'all';
}

/** The folder prefix of an ontology: "" for ICD-11 (or none), "ontologies/<id>/" for another one. */
export function ontologyRoot(ontology) {
  return ontology && ontology !== ICD11 ? `ontologies/${slug(ontology)}/` : '';
}

/**
 * The canonical name of a multimorbidity selection: the distinct ids, sorted,
 * joined with "_" (ids hold only letters, digits, dots, and hyphens). "none"
 * for an empty selection. The order the reader chose them in does not change
 * the recorded answer except its `selected` field, which the adapter restores.
 */
export function selectionKey(selected = []) {
  const ids = [...new Set(selected.filter(Boolean).map(String))].sort();
  return ids.length ? ids.join('_') : 'none';
}

const cardDir = ({ model, useCase, ontology }) => `${ontologyRoot(ontology)}cards/${cardKey(model, useCase)}`;
// The folder of the reads recorded at all patients: "all", or a specific setting's (v1.14).
const settingDir = ({ setting }) => lensKey({ setting });

export const staticPaths = Object.freeze({
  manifest: () => 'manifest.json',
  meta: () => 'meta.json',
  models: () => 'models.json',
  catalogue: () => 'catalogue.json',
  studies: () => 'studies.json',
  effects: () => 'effects.json',
  incidents: () => 'incidents.json',
  synonyms: () => 'synonyms.json',
  atlasOverview: (ontology = null) => `${ontologyRoot(ontology)}atlas/overview.json`,
  chapter: (chapterId, ontology = null) => `${ontologyRoot(ontology)}atlas/chapters/${slug(chapterId)}.json`,
  conceptChapters: (ontology = null) => `${ontologyRoot(ontology)}atlas/concept-chapters.json`,
  conceptMappings: (chapterId, ontology) => `${ontologyRoot(ontology)}atlas/mappings-${slug(chapterId)}.json`,
  comparisonRows: (ontology = null) => `${ontologyRoot(ontology)}compare/rows.json`,
  metricMap: ({ model, useCase, ontology = null, chapterId = null, ...lens }) =>
    `${cardDir({ model, useCase, ontology })}/${lensKey(lens)}/map-${chapterId ? slug(chapterId) : 'atlas'}.json`,
  metricSummary: ({ model, useCase, ontology = null, view = 'overall', weights = null, ...lens }) =>
    `${cardDir({ model, useCase, ontology })}/${lensKey(lens)}/summary-${slug(view)}${weights ? '-weighted' : ''}.json`,
  comparisonCard: ({ model, useCase, ontology = null, ...lens }) => `${cardDir({ model, useCase, ontology })}/${lensKey(lens)}/compare.json`,
  conceptBundle: ({ model, useCase, ontology = null, chapterId, setting = null }) =>
    `${cardDir({ model, useCase, ontology })}/${settingDir({ setting })}/concepts-${slug(chapterId)}.json`,
  subgroupBundle: ({ model, useCase, chapterId, setting = null }) => `${cardDir({ model, useCase })}/${settingDir({ setting })}/subgroups-${slug(chapterId)}.json`,
  subgroupSummary: ({ model, useCase, setting = null }) => `${cardDir({ model, useCase })}/${settingDir({ setting })}/subgroup-summary.json`,
  cardVersions: ({ model, useCase }) => `${cardDir({ model, useCase })}/versions.json`,
  cardRecord: ({ model, useCase, format = 'json' }) => `${cardDir({ model, useCase })}/record${format === 'jsonld' ? '-jsonld' : ''}.json`,
  multimorbidityIndex: ({ model, useCase }) => `${cardDir({ model, useCase })}/all/mm/index.json`,
  multimorbidityCandidates: ({ model, useCase, selected }) => `${cardDir({ model, useCase })}/all/mm/candidates-${selectionKey(selected)}.json`,
  multimorbidityCombination: ({ model, useCase, selected }) => `${cardDir({ model, useCase })}/all/mm/combination-${selectionKey(selected)}.json`
});
