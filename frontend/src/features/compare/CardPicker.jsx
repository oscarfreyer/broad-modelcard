import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Icon from '../../design/Icon.jsx';
import useDismiss from '../../design/useDismiss.js';
import { functionCategoryLabel, kindLabel } from '../../shared/aiSystem.js';
import { displayUseCase } from '../../shared/format.js';
import { MAX_CARDS } from './compareState.js';
import { matchesQuery } from '../catalogue/catalogueModel.js';

/**
 * Catalogue tiles grouped by AI system, in catalogue order, matching a query
 * over the system's name, the function, and the developer, the way the
 * catalogue's own search matches it (every word, accents folded).
 *
 * @returns {{ system: object, modelVersion: string, tiles: object[] }[]}
 */
export function pickerGroups(tiles, query = '') {
  const groups = new Map();
  for (const tile of tiles ?? []) {
    if (!matchesQuery(tile, query)) continue;
    if (!groups.has(tile.model_version)) {
      groups.set(tile.model_version, { system: tile.system ?? {}, modelVersion: tile.model_version, tiles: [] });
    }
    groups.get(tile.model_version).tiles.push(tile);
  }
  return [...groups.values()];
}

/**
 * "Add a card": a popover over the catalogue's cards, grouped by AI system.
 * A chosen card is marked; when the comparison is full, the others say why
 * they cannot be added.
 *
 * @param {object} props
 * @param {object[]|null} props.tiles catalogue tiles (null while loading)
 * @param {string[]} props.cards the chosen card ids
 * @param {(cardId: string) => void} props.onAdd
 * @param {boolean} [props.startOpen]
 */
export default function CardPicker({ tiles, cards, onAdd, startOpen = false }) {
  const [isOpen, setIsOpen] = useState(startOpen);
  const [query, setQuery] = useState('');
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const refs = useMemo(() => [buttonRef, panelRef], []);
  const close = useCallback(() => setIsOpen(false), []);
  useDismiss(isOpen, refs, close);
  const panelId = useId();
  const isFull = cards.length >= MAX_CARDS;
  const groups = useMemo(() => pickerGroups(tiles, query), [tiles, query]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const add = (cardId) => {
    onAdd(cardId);
    // The fourth card fills the comparison: nothing more to pick.
    if (cards.length + 1 >= MAX_CARDS) {
      setIsOpen(false);
      buttonRef.current?.focus();
    }
  };

  return (
    <div className="cmp-picker">
      <button
        ref={buttonRef}
        type="button"
        className="button-tinted cmp-add"
        aria-expanded={isOpen}
        aria-controls={panelId}
        disabled={isFull}
        title={isFull ? `Compare at most ${MAX_CARDS} cards. Remove one to add another.` : undefined}
        onClick={() => setIsOpen((open) => !open)}
      >
        <Icon name="plus" size={16} />
        Add a card
      </button>
      {isOpen ? (
        <div ref={panelRef} id={panelId} className="cmp-picker-panel" role="dialog" aria-label="Add a card to the comparison">
          <label className="cmp-picker-search">
            <Icon name="search" size={16} />
            <span className="visually-hidden">Find an AI system, function, or developer</span>
            <input
              ref={inputRef}
              type="search"
              value={query}
              placeholder="Find an AI system or function"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {!tiles ? (
            <p className="cmp-picker-note">Loading the cards…</p>
          ) : groups.length === 0 ? (
            <p className="cmp-picker-note">No card matches “{query.trim()}”.</p>
          ) : (
            <ul className="cmp-picker-groups">
              {groups.map((group) => (
                <li key={group.modelVersion} className="cmp-picker-group">
                  <p className="cmp-picker-system">
                    <span className="cmp-picker-system-name">{group.system.display_name || group.modelVersion}</span>
                    <span className="kind-tag">{kindLabel(group.system)}</span>
                  </p>
                  <ul className="cmp-picker-options">
                    {group.tiles.map((tile) => {
                      const chosen = cards.includes(tile.card_id);
                      const blocked = !chosen && isFull;
                      return (
                        <li key={tile.card_id}>
                          <button
                            type="button"
                            className={`cmp-picker-option${chosen ? ' is-chosen' : ''}`}
                            disabled={chosen || blocked}
                            onClick={() => add(tile.card_id)}
                          >
                            <span className="cmp-picker-function">{displayUseCase(tile.use_case)}</span>
                            <span className="cmp-picker-meta">
                              {chosen ? 'In the comparison' : tile.function_category ? functionCategoryLabel(tile.function_category) : 'No category stated'}
                            </span>
                            {chosen ? <Icon name="check" size={16} className="cmp-picker-check" /> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          <p className="cmp-picker-foot">{isFull ? `The comparison is full: ${MAX_CARDS} cards. Remove one to add another.` : `Choose up to ${MAX_CARDS} cards.`}</p>
        </div>
      ) : null}
    </div>
  );
}
