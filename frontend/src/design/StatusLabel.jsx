import StatusMark from './StatusMark.js';
import { displayFor } from './status.js';

/**
 * Status as a word plus its mark; meaning never rests on colour alone.
 *
 * @param {object} props
 * @param {string} props.status display key (contract status, intended-use level, or interface state)
 * @param {string|null} [props.grade] A–F letter, shown at expert depth only
 * @param {'regular'|'large'} [props.size]
 * @param {boolean} [props.toned] colour the word in its status tone
 */
export default function StatusLabel({ status, grade = null, size = 'regular', toned = false, children }) {
  const display = displayFor(status);
  return (
    <span className={`status-label status-label-${size}${toned ? ` is-toned tone-${display.tone}` : ''}`}>
      <StatusMark status={status} size={size === 'large' ? 14 : 12} />
      <span className="status-word">{children ?? display.label}</span>
      {grade ? (
        <span className="grade-chip" title={`Grade ${grade}`}>
          <span className="visually-hidden">grade </span>
          {grade}
        </span>
      ) : null}
    </span>
  );
}
