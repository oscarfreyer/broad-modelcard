import Icon from '../../design/Icon.jsx';
import '../../styles/label.css';
import { cardId } from './profile.js';
import useProfile from './useProfile.js';

/**
 * Tracks one card in the per-browser profile ("My systems"). The catalogue
 * tile and the atlas toolbar use the same toggle and the same profile.
 *
 * @param {object} props
 * @param {string} props.modelVersion
 * @param {string} props.useCase
 * @param {string} [props.name] the card's name, for the accessible label
 * @param {'tile'|'toolbar'} [props.variant]
 * @param {(tracked: boolean) => void} [props.onChange] after the profile changed (the catalogue's My systems offers Undo)
 */
export default function TrackToggle({ modelVersion, useCase, name = null, variant = 'tile', onChange = null }) {
  const { profile, store } = useProfile();
  const id = cardId(modelVersion, useCase);
  if (!id) {
    return null;
  }
  const isTracked = profile.tracked.includes(id);
  const label = isTracked ? 'Tracking' : 'Track';
  const title = isTracked
    ? 'In My systems. Press to stop tracking this card. The list is kept in this browser.'
    : 'Add this card to My systems. The list is kept in this browser.';
  return (
    <button
      type="button"
      className={`track-toggle is-${variant}${isTracked ? ' is-on' : ''}${variant === 'toolbar' ? ' toolbar-button' : ''}`}
      aria-pressed={isTracked}
      title={title}
      onClick={() => {
        store.setTracked(id, !isTracked);
        onChange?.(!isTracked);
      }}
    >
      <Icon name={isTracked ? 'check' : 'plus'} size={variant === 'toolbar' ? 15 : 16} />
      {/* The accessible name starts with the visible word (label in name) and adds the card. */}
      <span className="track-toggle-text">{label}</span>
      <span className="visually-hidden">{name ? ` ${name}` : ' this card'}</span>
    </button>
  );
}
