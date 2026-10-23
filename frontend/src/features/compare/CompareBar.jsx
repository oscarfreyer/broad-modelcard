import Icon from '../../design/Icon.jsx';
import { displayUseCase } from '../../shared/format.js';
import { MAX_CARDS, MIN_CARDS, compareHref, splitCardId } from './compareState.js';

/**
 * The catalogue's sticky "Compare (n)" action: the cards chosen
 * with Compare on their tiles, a way to clear them, and the way to the
 * comparison page once two are chosen.
 *
 * @param {{ cards: string[], tiles: object[]|null, onClear: () => void }} props
 */
export default function CompareBar({ cards, tiles, onClear }) {
  const names = cards.map((cardId) => {
    const tile = tiles?.find((candidate) => candidate.card_id === cardId);
    const { modelVersion, useCase } = splitCardId(cardId);
    return { cardId, name: tile?.system?.display_name || modelVersion, fn: displayUseCase(useCase) };
  });
  const isReady = cards.length >= MIN_CARDS;
  return (
    <aside className="compare-bar" aria-label="Cards to compare">
      <div className="compare-bar-text">
        <p className="compare-bar-title">
          {isReady ? `${cards.length} of ${MAX_CARDS} cards chosen` : 'Choose one more card to compare'}
        </p>
        <p className="compare-bar-names">{names.map((entry) => `${entry.name} (${entry.fn})`).join(', ')}</p>
      </div>
      <div className="compare-bar-actions">
        <button type="button" className="button-plain" onClick={onClear}>
          Clear
        </button>
        {isReady ? (
          <a className="button-filled compare-bar-go" href={compareHref({ cards })}>
            <Icon name="compare" size={16} />
            Compare ({cards.length})
          </a>
        ) : (
          <span className="button-filled compare-bar-go is-disabled" aria-disabled="true">
            <Icon name="compare" size={16} />
            Compare ({cards.length})
          </span>
        )}
      </div>
    </aside>
  );
}
