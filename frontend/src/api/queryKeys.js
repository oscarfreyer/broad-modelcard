// Cache keys for data-client reads. Two reads with equal keys must return
// equal data, so every request parameter belongs in the key. A local
// population (contract v1.10) and another ontology than ICD-11 (v1.13) are
// part of the key when they are set; without them the keys are exactly what
// they were before. So is a specific care setting (v1.14, CONTRACT.md §29).

import { otherOntology } from '../shared/ontology.js';

/** `|setting:<value>` for a specific care setting (v1.14), '' for Any setting. */
function settingKey(filters) {
  return filters.setting ? `|setting:${filters.setting}` : '';
}

export function filtersKey(filters) {
  if (!filters) {
    return null;
  }
  const parts = [filters.model, filters.useCase, filters.age, filters.sex, filters.ethnicity];
  if (filters.setting) {
    parts.push(`setting:${filters.setting}`);
  }
  if (filters.population) {
    parts.push(`population:${filters.population}`);
  }
  if (otherOntology(filters.ontology)) {
    parts.push(`ontology:${filters.ontology}`);
  }
  return parts.join('|');
}

/** Params shared by every metric-scoped read; `setting` (v1.14), `population` (v1.10), and `ontology` (v1.13) only when set. */
export function metricParams(filters) {
  const params = {
    model: filters.model,
    useCase: filters.useCase,
    age: filters.age,
    sex: filters.sex,
    ethnicity: filters.ethnicity
  };
  if (filters.setting) {
    params.setting = filters.setting;
  }
  if (filters.population) {
    params.population = filters.population;
  }
  if (otherOntology(filters.ontology)) {
    params.ontology = filters.ontology;
  }
  return params;
}

/**
 * One chapter of the atlas (getChapter); a local population (v1.10) sizes its
 * circles, and another ontology (v1.13) is another hierarchy, so both are
 * part of the key when set.
 */
export function chapterQueryKey(chapterId, population = null, ontology = null) {
  const other = otherOntology(ontology);
  return `chapter|${chapterId}${population ? `|population:${population}` : ''}${other ? `|ontology:${other}` : ''}`;
}

export function conceptMetricsQuery(filters, conceptId) {
  if (!filters || !conceptId) {
    return null;
  }
  return {
    key: `concept|${filtersKey(filters)}|${conceptId}`,
    fetch: (client, options) => client.getConceptMetrics({ ...metricParams(filters), conceptId }, options)
  };
}

/**
 * Across groups (contract v1.13, CONTRACT.md §24): one read lists every
 * one-group lens, so the key has no lens and a lens switch reuses the answer.
 * The card, a specific care setting (v1.14: groups are compared within it), and
 * a local population are part of the key.
 */
export function conceptSubgroupsQuery(filters, conceptId) {
  if (!filters || !conceptId) {
    return null;
  }
  const params = { model: filters.model, useCase: filters.useCase, conceptId };
  if (filters.setting) {
    params.setting = filters.setting;
  }
  if (filters.population) {
    params.population = filters.population;
  }
  // Another classification (contract v1.13, §23): the concept ids are its own, so it is part of the key.
  const ontology = otherOntology(filters.ontology);
  if (ontology) {
    params.ontology = ontology;
  }
  return {
    key: `subgroups|${filters.model}|${filters.useCase}${settingKey(filters)}${filters.population ? `|population:${filters.population}` : ''}${ontology ? `|ontology:${ontology}` : ''}|${conceptId}`,
    fetch: (client, options) => client.getConceptSubgroups(params, options)
  };
}

/**
 * The group summary (contract v1.14, CONTRACT.md §24): one read per card and
 * population (and care setting, v1.14), with no lens and no classification in the
 * key (it always counts ICD-11 conditions), so neither a lens nor a classification
 * switch reads it again.
 */
export function subgroupSummaryQuery(filters) {
  if (!filters) {
    return null;
  }
  const params = { model: filters.model, useCase: filters.useCase };
  if (filters.setting) {
    params.setting = filters.setting;
  }
  if (filters.population) {
    params.population = filters.population;
  }
  return {
    key: `subgroup-summary|${filters.model}|${filters.useCase}${settingKey(filters)}${filters.population ? `|population:${filters.population}` : ''}`,
    fetch: (client, options) => client.getSubgroupSummary(params, options)
  };
}

export function combinationQuery(filters, selectedIds) {
  if (!filters || !selectedIds || selectedIds.length < 2) {
    return null;
  }
  return {
    key: `combination|${filtersKey(filters)}|${selectedIds.join(',')}`,
    fetch: (client, options) => client.getMultimorbidityCombination({ ...metricParams(filters), selected: selectedIds }, options)
  };
}

/**
 * The catalogue (contract v1.6). One response holds every tile; filters and
 * sorts work on it without another request. `version` is 'live' (default)
 * or 'staged:<upload_id>'; a live key carries the dataset version the caller
 * last saw (from /meta), so a publish makes a new key. `population` (v1.10)
 * reads the tiles for a local population and is part of the key when set.
 */
export function catalogueQuery({ version = 'live', datasetVersion = null, population = null } = {}) {
  return {
    key: `catalogue|${version}|${datasetVersion ?? ''}${population ? `|population:${population}` : ''}`,
    fetch: (client, options) => client.getCatalogue(population ? { population } : {}, { ...options, version })
  };
}

/**
 * Each selected condition's own row (the existing concept read, one per
 * condition), so the combination can be compared with each condition alone
 * (audit A19). Only for a set of two or more; never for a preview's live side.
 */
export function singlesQuery(filters, selectedIds) {
  if (!filters || selectedIds.length < 2) {
    return null;
  }
  return {
    key: `singles|${filtersKey(filters)}|${selectedIds.join(',')}`,
    fetch: async (client, options) => {
      // A condition that cannot be read shows no row of its own; an aborted
      // read (the selection changed) aborts the whole set, so it is never
      // cached as a set without rows.
      const reads = await Promise.all(
        selectedIds.map((conceptId) =>
          client.getConceptMetrics({ ...metricParams(filters), conceptId }, options).catch((error) => {
            if (error?.name === 'AbortError' || options?.signal?.aborted) throw error;
            return null;
          })
        )
      );
      return Object.fromEntries(selectedIds.map((id, index) => [id, reads[index]?.metrics ?? null]));
    }
  };
}
