// What the model card says, derived from
// one catalogue tile at one dataset version. The figures are the tile's
// Overview distribution at the all-population lens, which equals
// /metrics/summary (view overall) at that version (CONTRACT.md §17; test).
// Developer declarations are kept apart: they are the developer's words,
// never checked, and the model card shows them in their own block.
import { DISPLAY, NO_STATEMENT_TEXT, hasIntendedUseStatement, keysForView } from '../../design/status.js';
import { aiTypeLabel, formatReleaseDate, functionCategoryLabel, kindLabel, systemName } from '../../shared/aiSystem.js';
import { displayUseCase } from '../../shared/format.js';
import { formatUpdated, mitigatedNote, openIncidents } from '../catalogue/catalogueModel.js';
import { cardAbsoluteUrl } from '../catalogue/pageLinks.js';
import { resultPopulationLabel } from '../../shared/resultPopulation.js';
import { instanceLine } from '../../shared/instance.js';
import { narrowCardReference } from '../summary/narrowCard.js';

export const LABEL_NOTICE = 'Demonstration on synthetic data. Not a certification, approval, or clinical evidence.';
export const DECLARATIONS_NOTE = "The developer's own statements, not checked.";
/** Said under a card link that only works on the maintainer's machine (the app runs locally). */
export const LOCAL_LINK_NOTE = 'A local link: it opens on the computer that runs this Broad Modelcard demonstration.';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True when a link points at this machine (the app is local only). */
export function isLocalLink(url) {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

const DECLARATION_FIELDS = [
  ['declared_intended_purpose', 'Intended purpose'],
  ['declared_regulatory_status', 'Regulatory status'],
  ['declared_contact', 'Contact'],
  ['declared_documentation_url', 'Documentation']
];

// Why a Caution mark can show on the ring with no incident open; the catalogue's Safety tiles say it too.
export { mitigatedNote };

/**
 * The model card's one configuration line (contract v1.14, §28.1): "Configuration
 * cfg-2026-09, since 2 June 2025", or null when the card names neither.
 *
 * @param {object|null} configuration tile.configuration
 */
export function configurationLine(configuration) {
  const id = typeof configuration?.configuration_id === 'string' ? configuration.configuration_id.trim() : '';
  const date = formatReleaseDate(configuration?.configuration_date ?? null);
  if (!id && !date) return null;
  return [`Configuration ${id || 'not labelled'}`, date ? `since ${date}` : null].filter(Boolean).join(', ');
}

/** "61%", "<1%" for a small non-zero share, "0%". */
export function formatShare(count, total) {
  if (!total || !count) return '0%';
  const percent = (count / total) * 100;
  return percent < 1 ? '<1%' : `${Math.round(percent)}%`;
}

/**
 * @param {object} tile catalogue tile
 * @param {{ dataset_version: string, condition_count: number, lens: object, population?: { id: string, name: string } }} catalogue
 *   the response it came from; a catalogue read for a local population (contract v1.10) names it, and so does the model card
 * @param {{ pageUrl?: string, instance?: object|null, narrowCard?: object|null, isStatic?: boolean }} [options] the page URL the card
 *   link resolves against; `/meta.instance` and the developer's narrow model card (contract v1.13, §26), when known
 */
export function buildLabelModel(tile, catalogue, { pageUrl = 'http://127.0.0.1/', instance = null, narrowCard = null, isStatic } = {}) {
  const system = tile.system ?? {};
  const total = catalogue.condition_count;
  const overall = tile.distribution?.overall ?? {};
  const datasetVersion = String(catalogue.dataset_version);
  const isPreview = datasetVersion.startsWith('staged:');
  const declarations = DECLARATION_FIELDS.map(([key, label]) => ({ key, label, value: tile.declarations?.[key] ?? null })).filter(
    (entry) => entry.value
  );
  const builtOn = Array.isArray(system.built_on) ? system.built_on : [];
  const facts = [kindLabel(system), aiTypeLabel(system.ai_type), system.developer].filter(Boolean);
  const population = catalogue.population?.id ? { id: catalogue.population.id, name: catalogue.population.name } : null;
  // A card without an intended-use statement has no scope: no Out of scope row, and the sheet says so.
  const hasIntendedUse = hasIntendedUseStatement(tile);
  // Names the overall view, so it opens these figures for every reader (profileDefaults.js).
  const cardUrl = cardAbsoluteUrl(tile, pageUrl, { population: population?.id ?? null, view: 'overall' });
  return {
    cardId: tile.card_id,
    systemName: systemName({ ...system, model_version: tile.model_version }),
    functionName: displayUseCase(tile.use_case),
    functionCategory: functionCategoryLabel(tile.function_category),
    facts,
    release: formatReleaseDate(system.release_date),
    builtOn,
    configuration: configurationLine(tile.configuration ?? null),
    total,
    lens: catalogue.lens,
    // The local population the figures are for; null for the default prevalence (then the model card has no prevalence row).
    population,
    prevalence: population ? `${population.name}, a synthetic local set` : null,
    hasIntendedUse,
    noStatement: hasIntendedUse ? null : NO_STATEMENT_TEXT,
    rows: keysForView('overall', { hasIntendedUse }).map((status) => ({
      status,
      label: DISPLAY[status].label,
      count: overall[status] ?? 0,
      share: formatShare(overall[status] ?? 0, total)
    })),
    // The snapshot's marks: one per subchapter (CONTRACT.md §17, `tile.snapshot.blocks`).
    snapshotBlocks: tile.snapshot?.blocks ?? [],
    overall,
    // Null until the catalogue carries safety counts (S3): the model card then leaves the row out.
    incidents: openIncidents(tile),
    datasetVersion,
    isPreview,
    lastChanged: tile.last_updated
      ? { version: tile.last_updated.version, date: formatUpdated(tile.last_updated.at, { long: true }) }
      : null,
    cardUrl,
    // A reader off this machine cannot open a local link: the model card says so under it.
    cardUrlIsLocal: isLocalLink(cardUrl),
    declarations,
    // Who runs this copy (§26), and the developer's own model card as a reference line under the declarations.
    publishedBy: instanceLine(instance, isStatic === undefined ? undefined : { isStatic }) || null,
    narrowCard: narrowCardReference(narrowCard) || null,
    notice: LABEL_NOTICE
  };
}

/** A file name stem for the model card downloads, e.g. "syngpt-2-0-discharge-letter-generation-model-card-v8". */
export function labelFileStem(model) {
  const slug = `${model.systemName} ${model.functionName}${model.population ? ` ${model.population.id}` : ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'card'}-model-card-v${model.datasetVersion.replace(/[^0-9a-z]+/gi, '-')}`;
}

/**
 * What the model card says, as plain text lines in its reading order: the
 * SVG's description for assistive technology, and the PDF's text layer
 * (searchable and selectable over the drawn sheet).
 *
 * @param {ReturnType<typeof buildLabelModel>} model
 * @returns {string[]}
 */
export function labelText(model) {
  const facts = [...model.facts, model.release ? `Released ${model.release}` : null].filter(Boolean).join(', ');
  const incidents = model.incidents
    ? model.incidents.open
      ? `Open safety incidents: ${model.incidents.serious} serious, ${model.incidents.caution} caution.`
      : 'Open safety incidents: none.'
    : null;
  const mitigated = model.incidents?.mitigated ? mitigatedNote(model.incidents.mitigated) : null;
  return [
    'Broad Modelcard model card. Synthetic data.',
    `${model.systemName}, ${model.functionName}.`,
    facts ? `${facts}.` : null,
    model.builtOn.length ? `Built on ${model.builtOn.join(', ')}.` : null,
    model.configuration ? `${model.configuration}.` : null,
    `Overview of ${model.total.toLocaleString('en-US')} conditions: ${model.rows
      .map((row) => `${row.label} ${row.count.toLocaleString('en-US')} (${row.share})`)
      .join(', ')}.`,
    model.noStatement,
    incidents,
    mitigated,
    `Population: ${resultPopulationLabel(model.lens, model.population, { separator: ', ' })}.`,
    model.prevalence ? `Prevalence: ${model.prevalence}.` : null,
    model.publishedBy ? `Published by: ${model.publishedBy}.` : null,
    `Dataset version ${model.isPreview ? 'unpublished preview, not live' : model.datasetVersion}.`,
    model.lastChanged ? `Card last changed ${model.lastChanged.date} (version ${model.lastChanged.version}).` : null,
    `Card link: ${model.cardUrl}${model.cardUrlIsLocal ? ` (${LOCAL_LINK_NOTE})` : ''}`,
    `Declared by the developer. ${DECLARATIONS_NOTE}`,
    ...(model.declarations.length ? model.declarations.map((entry) => `${entry.label}: ${entry.value}`) : ['Nothing declared.']),
    model.narrowCard,
    model.notice
  ].filter(Boolean);
}
