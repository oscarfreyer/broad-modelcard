// The card record download (contract v1.14, CONTRACT.md §32.1): words and the
// file name. React-free, so the tests can read it.

/** What the Summary footer says about the card record. */
export const CARD_RECORD_COPY = Object.freeze({
  button: 'Card record (JSON)',
  busy: 'Preparing the card record…',
  hint: 'This card for other systems, about 20 KB: statuses per chapter, studies, incidents. Synthetic data, not a certification.'
});

const slug = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** `broad-modelcard-card-record-<ai system>-<function>.json`, in plain file-name characters. */
export function cardRecordFilename(model, useCase) {
  const parts = [slug(model), slug(useCase)].filter(Boolean);
  return `broad-modelcard-card-record${parts.length ? `-${parts.join('-')}` : ''}.json`;
}
