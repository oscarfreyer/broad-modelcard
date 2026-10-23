import { DISPLAY, normalizeCounts } from './status.js';

/**
 * A slim proportional bar of status counts. Each segment wears its state's
 * mark as a band (styles/marks.css): fills for results, the barred grey for
 * Out of scope, the outlined light grey for No data.
 *
 * @param {object} props
 * @param {Record<string, number>} props.counts
 * @param {number} props.total
 * @param {string[]} props.keys display keys in order
 */
export default function StatusStrip({ counts: served, total, keys }) {
  if (!total) {
    return null;
  }
  const counts = normalizeCounts(served);
  const parts = keys.filter((key) => (counts[key] ?? 0) > 0);
  const label = parts.map((key) => `${counts[key].toLocaleString('en-US')} ${DISPLAY[key].label.toLowerCase()}`).join(', ');
  return (
    <span className="status-strip" role="img" aria-label={label}>
      {parts.map((key) => (
        <span
          key={key}
          data-status={key}
          className={`status-strip-part strip-${DISPLAY[key].form} tone-${DISPLAY[key].tone}`}
          style={{ flexGrow: counts[key] }}
        />
      ))}
    </span>
  );
}
