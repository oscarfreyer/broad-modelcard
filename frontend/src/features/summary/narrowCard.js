// The developer's own narrow model card (contract v1.13, CONTRACT.md §26) as plain values, for "About this AI system" and the model card.
// Like the declarations, it is the developer's statement and never checked;
// its results become ICD-11 results only after a custodian publishes them.

export const NARROW_CARD_NOTE = 'The developer’s own model card, as published here. Not checked.';

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @param {object|null} card contract NarrowModelCard
 * @returns {null|{ title: string, format: string, note: string, items: { id: string, label: string, value: string }[], results: string|null }}
 */
export function narrowCardItems(card) {
  if (!card) return null;
  const title = [text(card.name) || card.model_version, text(card.version)].filter(Boolean).join(' ');
  const items = [
    ['intended_use', 'Intended use'],
    ['limitations', 'Limitations'],
    ['training_data', 'Training data'],
    ['licence', 'Licence'],
    ['date', 'Date']
  ].flatMap(([id, label]) => (text(card[id]) ? [{ id, label, value: text(card[id]) }] : []));
  const count = Array.isArray(card.results) ? card.results.length : 0;
  return {
    title,
    format: card.source_format === 'markdown' ? 'Markdown' : 'JSON',
    note: NARROW_CARD_NOTE,
    items,
    results: count ? `${count} reported ${count === 1 ? 'result' : 'results'}; on the atlas only once reviewed.` : null
  };
}

/** The model card's one reference line, or '' without a card. */
export function narrowCardReference(card) {
  const items = narrowCardItems(card);
  return items ? `Developer’s model card: ${items.title} (${items.format}), not checked.` : '';
}
