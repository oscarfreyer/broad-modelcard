// "About this result": where a metric row comes from, in plain words or in
// expert terms, from its provenance (CONTRACT.md §5–§8). Describes the
// synthetic data only; never a clinical claim.
import { conceptName } from '../../../shared/conceptName.js';
import { localPrevalenceSentence } from '../../../shared/localPopulation.js';
import { mappingDetail } from '../../../shared/ontology.js';

export const SYNTHETIC_NOTE =
  'Synthetic demonstration data, not clinical evidence; the bands are prototype heuristics.';

const LEVEL_NOUNS = { 0: 'chapter', 1: 'subchapter', 2: 'condition' };

export function levelNoun(level) {
  return LEVEL_NOUNS[level] ?? 'concept';
}

/**
 * The card's sentence for a block or chapter rollup without children for the
 * lens (CONTRACT.md §6, V1): it is presented as No data, never as a summary.
 */
export function emptyRollupSentence(concept) {
  return `No condition in this ${levelNoun(concept?.level)} has results for this population.`;
}

const SOURCE_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * Where a stored row's values come from (contract v1.7, CONTRACT.md §11.3):
 * `provenance.data_source` of a concept read. Seed rows read "Seed
 * (synthetic, version 1)"; uploaded rows name their source, study, and date.
 * Every source is part of the synthetic demonstration data, never real
 * evidence. Null for aggregated rows (rollups, lens fallback).
 *
 * @param {{ source: string, study: string|null, date: string|null }|null|undefined} dataSource
 * @param {'plain'|'expert'} depth
 * @returns {string|null}
 */
export function dataSourceSentence(dataSource, depth) {
  if (!dataSource?.source) {
    return null;
  }
  const date = dataSource.date ? SOURCE_DATE.format(new Date(`${dataSource.date}T00:00:00Z`)) : null;
  if (depth === 'expert') {
    return `Row source: ${dataSource.source}; study ${dataSource.study ?? 'not given'}; source date ${dataSource.date ?? 'not given'}.`;
  }
  const isSeed = /^Seed\b/.test(dataSource.source);
  if (isSeed) {
    return `Source: ${dataSource.source}.`;
  }
  const details = [dataSource.study ? `study ${dataSource.study}` : null, date].filter(Boolean).join(', ');
  return `Source: ${dataSource.source}${details ? ` (${details})` : ''}, synthetic.`;
}

/**
 * The sentence for a row served by lens fallback (CONTRACT.md §7, §8): the exact
 * population has no row, so a related one stands in. The atlas card and the
 * live panel both say it, for single conditions and combinations alike.
 *
 * @param {'plain'|'expert'} depth
 */
export function lensFallbackSentence(depth) {
  return depth === 'expert'
    ? 'Lens fallback: the exact demographic combination is absent, so the row is aggregated over the matching subgroups or the all-population row is served.'
    : 'Worked out from related population groups.';
}

/**
 * @param {object} input
 * @param {object|null} input.concept contract Concept (null for a combination)
 * @param {object|null} input.row contract MetricRow
 * @param {'plain'|'expert'} input.depth
 * @param {{ id: string, name: string }|null} [input.population] the local population the read used (contract v1.10)
 * @param {{ id: string, name: string }|null} [input.ontology] another classification the read used (contract v1.13)
 * @param {object|null} [input.mapping] the concept's ConceptMapping in that classification (conditions only)
 * @returns {string[]} sentences, synthetic note last (after the local prevalence, when one is used)
 */
export function aboutResult({ concept, row, depth, population = null, ontology = null, mapping = null }) {
  const expert = depth === 'expert';
  const name = concept ? conceptName(concept) : 'This combination';
  const local = localPrevalenceSentence(population, depth);
  if (mapping?.kind === 'none') {
    return [
      expert
        ? `${name} has no ICD-11 mapping in ${ontology?.name ?? 'this classification'} (no cross-reference resolves, and no mapped parent within two steps), so no result is shown; results are stored in ICD-11 only.`
        : concept?.level === 2
          ? `${name} has no counterpart in ICD-11, where results are stored, so no result is shown.`
          : `No condition in ${name} has a counterpart in ICD-11, where results are stored, so no result is shown.`,
      SYNTHETIC_NOTE
    ];
  }
  if (!row) {
    return [
      expert
        ? `No metric row is stored or derivable for ${name} with this AI system, function, and population.`
        : `No result for ${name} with this population.`,
      ...(local ? [local] : []),
      SYNTHETIC_NOTE
    ];
  }

  const sentences = [];
  const provenance = row.provenance ?? {};
  const isMappedCondition = Boolean(ontology && mapping);
  if (isMappedCondition) {
    // The row is the ICD-11 row the condition maps to (CONTRACT.md §23); its own provenance follows at expert depth.
    sentences.push(expert ? `Mapped result: the ICD-11 row shown as is. ${mappingDetail(mapping) ?? ''}`.trim() : `Shows the result of the ICD-11 ${mapping.icd11?.level === 1 ? 'subchapter' : 'condition'} it maps to.`);
  }
  if (isMappedCondition && !expert) {
    // Plain words say what the condition shows; the ICD-11 row's own story is for experts.
  } else if (ontology && !mapping && provenance.source === 'rollup' && provenance.rollup?.child_count > 0) {
    const count = provenance.rollup.child_count;
    const noun = levelNoun(concept?.level);
    const isCautious = provenance.rollup.aggregation === 'p20';
    sentences.push(
      expert
        ? `Rollup over the ${count} distinct ICD-11 ${count === 1 ? 'condition' : 'conditions'} that this ${noun}'s conditions map to, each counted once. ${isCautious ? 'Performance is the unweighted 20th percentile (p20); the CI half-width is the weighted mean plus 0.006.' : 'Performance is the prevalence-weighted mean; the CI half-width is the weighted mean of the children.'}`
        : `Summary of the ${count} ICD-11 ${count === 1 ? 'condition' : 'conditions'} its conditions map to, ${isCautious ? 'cautious: 80% score at least this well.' : 'weighted by how common each is.'}`
    );
  } else if (provenance.source === 'rollup' && provenance.rollup?.child_count === 0) {
    const noun = levelNoun(concept?.level);
    sentences.push(
      expert
        ? `Rollup without children: no condition in this ${noun} has a row for this lens, so there is nothing to aggregate. The API serves it as out of scope for parity; it is shown as No data.`
        : `None of its conditions has a result for this population.`
    );
  } else if (provenance.source === 'rollup') {
    const count = provenance.rollup?.child_count ?? 0;
    const noun = levelNoun(concept?.level);
    const isCautious = provenance.rollup?.aggregation === 'p20';
    if (expert) {
      sentences.push(
        `Rollup over ${count} ${count === 1 ? 'condition' : 'conditions'} in this ${noun}. ${isCautious ? 'Performance is the unweighted 20th percentile (p20); the CI half-width is the weighted mean plus 0.006.' : 'Performance is the prevalence-weighted mean; the CI half-width is the weighted mean of the children.'}`
      );
    } else {
      sentences.push(
        `Summary of ${count} ${count === 1 ? 'condition' : 'conditions'}, ${isCautious ? 'cautious: 80% score at least this well.' : 'weighted by how common each is.'}`
      );
    }
  } else if (provenance.source === 'anchor') {
    sentences.push(
      expert
        ? `Inherited from its metric anchor${provenance.anchor_concept_id ? ` ${provenance.anchor_concept_id}` : ''}; deeper categories carry no row of their own.`
        : 'Shows the result of the condition it belongs to.'
    );
  } else if (provenance.source === 'multimorbidity') {
    sentences.push(
      expert
        ? 'Stored multimorbidity row for this exact, unordered set of conditions.'
        : 'Stored for this exact combination, not worked out from single conditions.'
    );
  } else {
    sentences.push(expert ? 'Stored condition-level row.' : 'Stored for this condition.');
  }

  if (provenance.lens_fallback) {
    sentences.push(lensFallbackSentence(depth));
  }
  if (expert && Number.isFinite(row.ci_low) && Number.isFinite(row.ci_high)) {
    sentences.push(`Confidence interval ${row.ci_low.toFixed(3)}–${row.ci_high.toFixed(3)} (width ${(row.ci_high - row.ci_low).toFixed(3)}).`);
  }
  const source = dataSourceSentence(provenance.data_source, depth);
  if (source) {
    sentences.push(source);
  }
  if (local) {
    sentences.push(local);
  }
  sentences.push(SYNTHETIC_NOTE);
  return sentences;
}
