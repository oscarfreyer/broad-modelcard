import { useMemo } from 'react';
import { conceptMetricsQuery, filtersKey, metricParams } from '../../api/queryKeys.js';
import useClientQuery from '../../api/useClientQuery.js';
import { AUDIENCE_READS, audienceSummary, carefulChapters } from './audienceModel.js';

// The catalogue at the page's version, as the model card reads it (one read for every tile).
const CATALOGUE_KEY = 'catalogue|page-version';

const shown = (query, key) => ({ data: key && query.dataKey === key ? query.data : null, error: key ? query.error : null });

/**
 * The reads behind the reader's audience summary (CONTRACT.md §30.2), each
 * only when that preset needs it, and the summary built from them. Every
 * read is an existing data-client operation with its own cache key, so the
 * Summary's own reads (the Evidence summary, the condition card of a
 * chapter) are shared rather than repeated. `enabled` false reads nothing.
 *
 * @param {object} input
 * @param {string|null} input.audience the reader's preset
 * @param {boolean} input.enabled the Summary is on screen at atlas level
 * @param {object|null} input.filters the filters of the map on screen
 * @param {object|null} input.entry ModelEntry on screen
 * @param {object|null} input.functionEntry UseCaseEntry on screen
 * @param {object|null} input.system systemDetails() of the card
 * @param {string|null} input.resultFor who the results are for
 * @param {boolean} input.hasIntendedUse
 * @param {Record<string, string>} input.chapterLabels chapter id → name
 */
export default function useAudienceSummary({ audience, enabled, filters, entry, functionEntry, system, resultFor, hasIntendedUse, chapterLabels }) {
  const needs = enabled && filters ? AUDIENCE_READS[audience] ?? [] : [];
  const need = (name) => needs.includes(name);
  const key = filters ? filtersKey(filters) : null;
  const cardId = filters ? `${filters.model}|${filters.useCase}` : null;

  const summaryKey = need('summary') ? `summary|${key}|overall` : null;
  const summary = useClientQuery(summaryKey, (client, options) => client.getMetricSummary({ ...metricParams(filters), view: 'overall' }, options));
  const weightedKey = need('weighted') ? `summary|${key}|overall|weights:prevalence` : null;
  const weighted = useClientQuery(weightedKey, (client, options) =>
    client.getMetricSummary({ ...metricParams(filters), view: 'overall', weights: 'prevalence' }, options)
  );
  // The Summary's Evidence view reads the same key.
  const evidenceKey = need('evidence') ? `summary|${key}|evidence` : null;
  const evidence = useClientQuery(evidenceKey, (client, options) => client.getMetricSummary({ ...metricParams(filters), view: 'evidence' }, options));
  const catalogue = useClientQuery(need('tile') ? CATALOGUE_KEY : null, (client, options) => client.getCatalogue({}, options));
  const studiesKey = need('studies') && filters ? `studies|${filters.model}` : null;
  const studies = useClientQuery(studiesKey, (client, options) => client.listStudies({ model: filters.model }, options));
  const effectsKey = need('effects') && filters ? `effects|${cardId}` : null;
  const effects = useClientQuery(effectsKey, (client, options) => client.listEffects({ model: filters.model, useCase: filters.useCase }, options));
  const incidentsKey = need('incidents') && filters ? `incidents|${cardId}` : null;
  const incidents = useClientQuery(incidentsKey, (client, options) => client.listSafetyIncidents({ model: filters.model, useCase: filters.useCase }, options));
  const versionsKey = need('versions') && filters ? `versions|card:${cardId}` : null;
  const versions = useClientQuery(versionsKey, (client, options) => client.listDatasetVersions({ card: cardId }, options));
  const meta = useClientQuery(need('instance') ? 'meta' : null, (client, options) => client.getMeta({}, options));

  // The patient's warnings: the condition card of the chapter with the most Weak or No data results.
  const summaryShown = shown(summary, summaryKey);
  const weakest = need('chapterCard') && summaryShown.data ? carefulChapters(summaryShown.data, chapterLabels)[0]?.id ?? null : null;
  const chapterQuery = weakest ? conceptMetricsQuery(filters, weakest) : null;
  const chapterCard = useClientQuery(chapterQuery?.key ?? null, (client, options) => chapterQuery.fetch(client, options));

  const tileData = catalogue.data?.tiles?.find((tile) => tile.card_id === cardId) ?? null;
  const tile = need('tile') ? { data: catalogue.data ? tileData ?? null : null, error: catalogue.error ?? (catalogue.data && !tileData ? { code: 'missing' } : null) } : null;

  const parts = {
    summary: summaryShown,
    weighted: shown(weighted, weightedKey),
    evidence: shown(evidence, evidenceKey),
    studies: shown(studies, studiesKey),
    effects: shown(effects, effectsKey),
    incidents: shown(incidents, incidentsKey),
    versions: shown(versions, versionsKey),
    chapterCard: shown(chapterCard, chapterQuery?.key ?? null)
  };
  const instance = meta.data?.instance ?? null;

  return useMemo(
    () =>
      needs.length
        ? audienceSummary(audience, { ...parts, tile, entry, functionEntry, system, resultFor, hasIntendedUse, chapterLabels, instance })
        : null,
    // The parts are rebuilt each render from stable query results; their data and errors are the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      audience,
      needs.length,
      entry,
      functionEntry,
      system,
      resultFor,
      hasIntendedUse,
      chapterLabels,
      instance,
      tile?.data,
      tile?.error,
      ...Object.values(parts).flatMap((part) => [part.data, part.error])
    ]
  );
}
