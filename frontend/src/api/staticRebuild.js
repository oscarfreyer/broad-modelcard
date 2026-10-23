// Rebuilds API answers from the static snapshot's compact files (release 0.4). Only structure is rebuilt here, never a
// grade or a status:
//
// - A condition card (getConceptMetrics) is recorded per chapter: its
//   `concept` and `path` come from the chapter file, which holds every
//   concept of the chapter; its `metrics` row is stored once per distinct row
//   of the chapter (deeper categories, and in another ontology every concept
//   mapped to the same ICD-11 condition, serve the same row with their own
//   `concept_id`); its `mapping` and `other_parents` (another ontology,
//   CONTRACT.md §23) come from the ontology's mappings file, shared by every
//   card. Everything else (incidents, effects) is stored as served.
// - Across groups (getConceptSubgroups, CONTRACT.md §24) is recorded per
//   chapter for its conditions: each result is stored once per distinct
//   value, its `lens`, `axis`, and `group` come from the bundle's group list.
// - A multimorbidity answer is recorded once per set of conditions; only its
//   `selected` field follows the order the reader chose them in.
// - A selection the snapshot does not hold contains no stored combination
//   (the recorder records every subset of every stored combination), so it
//   gets the contract's empty answer from a recorded template.
// - Study and effect lists are recorded whole; a filter is applied here.
//   So are the safety incidents (contract v1.14, CONTRACT.md §30); a card's
//   change history (§26.6) is recorded per card, and `after` is applied here.
//
// scripts/static/record.mjs checks every rebuilt answer against the API's
// own answer when it records, so a change in the contract fails the recording.

/** Every concept of a chapter answer (getChapter) by id. */
export function chapterConceptsById(chapterAnswer) {
  const byId = new Map();
  [chapterAnswer.chapter, ...(chapterAnswer.blocks || []), ...(chapterAnswer.concepts || [])].forEach((concept) => {
    if (concept) byId.set(concept.concept_id, concept);
  });
  return byId;
}

/** The chapter → concept ids index (concept-chapters.json) turned around: concept id → chapter id. */
export function chapterOfConcept(index) {
  const byConcept = new Map();
  Object.entries(index || {}).forEach(([chapterId, conceptIds]) => conceptIds.forEach((conceptId) => byConcept.set(conceptId, chapterId)));
  return byConcept;
}

/** A concept's path: the chapter first, then each parent, then the concept itself. */
export function conceptPath(conceptId, byId) {
  const path = [];
  const seen = new Set();
  let concept = byId.get(conceptId);
  while (concept && !seen.has(concept.concept_id)) {
    seen.add(concept.concept_id);
    path.unshift(concept);
    concept = concept.parent_id ? byId.get(concept.parent_id) : null;
  }
  return path;
}

// The fields of a ConceptMetrics answer that the bundle does not store per entry.
const REBUILT_KEYS = new Set(['dataset_version', 'concept', 'path', 'metrics', 'ontology']);
// The concept-level fields of another ontology, the same for every card (mappings file).
export const MAPPING_KEYS = Object.freeze(['mapping', 'other_parents']);

/**
 * Collects the condition cards of one chapter into its bundle. `add` takes
 * a ConceptMetrics answer; `bundle` is the file to write, `mappings` the
 * concept-level fields of another ontology (empty for ICD-11).
 */
export function createConceptBundle(datasetVersion, ontology = null) {
  const bundle = { dataset_version: datasetVersion, ...(ontology ? { ontology } : {}), rows: [], concepts: {} };
  const mappings = {};
  const rowIndex = new Map();
  return {
    add(answer) {
      const conceptId = answer.concept.concept_id;
      const entry = {};
      Object.entries(answer).forEach(([key, value]) => {
        if (REBUILT_KEYS.has(key)) return;
        if (MAPPING_KEYS.includes(key)) {
          mappings[conceptId] = { ...mappings[conceptId], [key]: value };
          return;
        }
        entry[key] = value;
      });
      if (answer.metrics) {
        const { concept_id: rowConcept, ...row } = answer.metrics;
        const text = JSON.stringify(row);
        if (!rowIndex.has(text)) {
          rowIndex.set(text, bundle.rows.length);
          bundle.rows.push(row);
        }
        entry.m = rowIndex.get(text);
        if (rowConcept !== conceptId) entry.c = rowConcept;
      } else {
        entry.m = null;
      }
      bundle.concepts[conceptId] = entry;
    },
    bundle,
    mappings
  };
}

/**
 * The ConceptMetrics answer of one concept.
 *
 * @param {{ dataset_version: string, ontology?: object, rows: object[], concepts: Record<string, object> }} bundle
 * @param {object} chapterAnswer the chapter's getChapter answer
 * @param {string} conceptId
 * @param {Record<string, object>|null} [mappings] the chapter's mappings file (another ontology)
 * @returns {object|null} null when the bundle does not hold the concept
 */
export function conceptMetricsAnswer(bundle, chapterAnswer, conceptId, mappings = null) {
  const entry = bundle?.concepts?.[conceptId];
  const byId = chapterConceptsById(chapterAnswer);
  const concept = byId.get(conceptId);
  if (!entry || !concept) {
    return null;
  }
  const { m, c, ...rest } = entry;
  const metrics = m === null || m === undefined ? null : { concept_id: c ?? conceptId, ...bundle.rows[m] };
  return {
    dataset_version: bundle.dataset_version,
    concept,
    path: conceptPath(conceptId, byId),
    metrics,
    ...rest,
    ...(mappings?.[conceptId] ?? {}),
    ...(bundle.ontology ? { ontology: bundle.ontology } : {})
  };
}

// Across groups (CONTRACT.md §24): a SubgroupResult as one array, values in this order.
const SUBGROUP_FIELDS = Object.freeze([
  'has_result',
  'perf',
  'ci_low',
  'ci_high',
  'performance_grade',
  'evidence_grade',
  'overall',
  'status',
  'intended_use_level',
  'safety',
  'provenance',
  'difference',
  // Contract v1.14 (§24): the patients or cases and the sites of the group.
  'n_samples',
  'n_sites'
]);
const ABSENT = 0; // a field the result does not have (`difference` on all_patients)

/** Collects the Across groups answers of one chapter's conditions of one card into its bundle. */
export function createSubgroupBundle(datasetVersion) {
  const bundle = { dataset_version: datasetVersion, filters: null, groups: null, entries: [], concepts: {} };
  const entryIndex = new Map();
  const encode = (result) => {
    const values = SUBGROUP_FIELDS.map((field) => (field in result ? [result[field]] : ABSENT));
    const text = JSON.stringify(values);
    if (!entryIndex.has(text)) {
      entryIndex.set(text, bundle.entries.length);
      bundle.entries.push(values);
    }
    return entryIndex.get(text);
  };
  return {
    add(answer) {
      bundle.filters ??= answer.filters;
      bundle.groups ??= [answer.all_patients, ...answer.groups].map(({ axis, group, lens }) => ({ axis, group, lens }));
      bundle.concepts[answer.concept.concept_id] = [answer.all_patients, ...answer.groups].map(encode);
    },
    bundle
  };
}

function decodeSubgroup(values, { axis, group, lens }) {
  const result = { axis, group, lens };
  SUBGROUP_FIELDS.forEach((field, index) => {
    if (values[index] !== ABSENT) result[field] = values[index][0];
  });
  return result;
}

/**
 * The ConceptSubgroups answer of one concept, or null when the bundle does
 * not hold it (only conditions are recorded).
 */
export function conceptSubgroupsAnswer(bundle, chapterAnswer, conceptId) {
  const indexes = bundle?.concepts?.[conceptId];
  const concept = chapterConceptsById(chapterAnswer).get(conceptId);
  if (!indexes || !concept) {
    return null;
  }
  const [all, ...groups] = indexes.map((entryIndex, position) => decodeSubgroup(bundle.entries[entryIndex], bundle.groups[position]));
  return { dataset_version: bundle.dataset_version, concept, filters: bundle.filters, all_patients: all, groups };
}

/** listStudies with its `model` filter, from the recorded list of every study. */
export function studiesAnswer(recorded, { model } = {}) {
  return model ? { ...recorded, studies: recorded.studies.filter((study) => study.model_version === model) } : recorded;
}

/** getStudy from the recorded list, or null for an id the version lacks. */
export function studyAnswer(recorded, studyId) {
  const study = recorded.studies.find((entry) => entry.study_id === studyId);
  return study ? { dataset_version: recorded.dataset_version, study } : null;
}

/** listEffects with its `model` and `use_case` filters, from the recorded list of every effect. */
export function effectsAnswer(recorded, { model, useCase } = {}) {
  if (!model) return recorded;
  return {
    ...recorded,
    effects: recorded.effects.filter((effect) => effect.model_version === model && (!useCase || effect.use_case === useCase))
  };
}

/** listSafetyIncidents with its `model` and `use_case` filters, from the recorded list of every incident (newest first, kept). */
export function incidentsAnswer(recorded, { model, useCase } = {}) {
  if (!model && !useCase) return recorded;
  return {
    ...recorded,
    incidents: recorded.incidents.filter((incident) => (!model || incident.model_version === model) && (!useCase || incident.use_case === useCase))
  };
}

/** listDatasetVersions with `card` (recorded per card) and its `after` filter: only versions newer than `after`. */
export function cardVersionsAnswer(recorded, { after } = {}) {
  if (after === undefined || after === null || after === '') return recorded;
  const floor = Number(after);
  return { ...recorded, versions: recorded.versions.filter((entry) => Number(entry.version_id) > floor) };
}

/** A recorded multimorbidity answer with `selected` in the reader's order. */
export function withSelection(answer, selected) {
  return { ...answer, selected: [...selected] };
}

/**
 * The combination key the API gives a selection: the distinct ids, in locale
 * order, joined with "+" (CONTRACT.md §8); null below two ids, which make no
 * combination. The ids the atlas sends are already depth-1 anchors.
 */
export function combinationKey(selected) {
  const ids = [...new Set(selected)].sort((a, b) => a.localeCompare(b));
  return ids.length >= 2 ? ids.join('+') : null;
}

/**
 * The answer for a selection the snapshot does not hold: it is in no stored
 * combination, so it has no candidates, no display rows, and no stored row.
 *
 * @param {object} template a recorded answer for such a selection (candidates of one scope, or the combination)
 * @param {string[]} selected the reader's selection
 */
export function emptySelectionAnswer(template, selected) {
  const answer = { ...template, selected: [...selected], combination_key: combinationKey(selected) };
  if ('candidate_ids' in answer) {
    answer.candidate_ids = [];
  }
  if (answer.display) {
    answer.display = { ...answer.display, rows: [] };
  }
  if ('metrics' in answer) {
    answer.metrics = null;
    answer.combination_label = null;
  }
  return answer;
}
