import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import Icon from '../../design/Icon.jsx';
import StatusLabel from '../../design/StatusLabel.jsx';
import { viewLabel } from '../../design/status.js';
import { lockPageScroll, rememberOpener } from '../label/dialogFocus.js';
import { conceptCode, conceptName } from '../../shared/conceptName.js';
import { searchWords } from './searchWords.js';

const LEVEL_WORDS = { 0: 'Chapter', 1: 'Subchapter', 2: 'Condition' };

/** The toolbar's Search button: where the focus goes back when ⌘K opened the palette from nowhere. */
const SEARCH_BUTTON = '.toolbar-search';

/**
 * The ⌘K search palette, mounted while open. Results update as you type;
 * arrow keys move, Enter opens, Esc closes.
 *
 * @param {object} props
 * @param {ReturnType<import('./useConceptSearch.js').default>} props.search
 * @param {boolean} props.isMultimorbidityMode
 * @param {(concept: object) => string|null} [props.statusFor] a result's mark as the ring draws it, or null (searchMarks.js)
 * @param {string} [props.viewId] the view the marks describe
 * @param {string} [props.classification] the name of the classification on screen (ICD-11 by default)
 * @param {import('react').ReactNode} [props.interpretation] the interpretation row (contract v1.14, §31), shown above the results
 */
export default function SearchPalette({ search, isMultimorbidityMode, statusFor = null, viewId = 'overall', classification = 'ICD-11', interpretation = null }) {
  if (!search.isOpen) {
    return null;
  }
  return (
    <PaletteDialog
      search={search}
      isMultimorbidityMode={isMultimorbidityMode}
      statusFor={statusFor}
      viewId={viewId}
      words={searchWords(isMultimorbidityMode ? 'ICD-11' : classification, isMultimorbidityMode)}
      interpretation={interpretation}
    />
  );
}

/**
 * A native modal <dialog> (showModal): the page behind it is inert, so Tab
 * stays inside, and the page does not scroll. When it goes away, the focus
 * returns to the control that opened it, or to the toolbar's Search button
 * when ⌘K was pressed with nothing focused (dialogFocus.js, as the model card
 * and Your defaults do).
 */
function PaletteDialog({ search, isMultimorbidityMode, statusFor, viewId, words, interpretation }) {
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    const hasOpener = opener && opener !== document.body && opener !== document.documentElement;
    const returnFocus = hasOpener ? rememberOpener(document) : () => document.querySelector(SEARCH_BUTTON)?.focus();
    const unlockScroll = lockPageScroll(document);
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      if (dialog?.open) {
        dialog.close();
      }
      unlockScroll();
      returnFocus();
    };
  }, []);

  const { matches } = search;
  useEffect(() => setActiveIndex(0), [matches]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((current) => (current + step + matches.length) % matches.length);
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      search.choose(matches[activeIndex]);
    } else if (event.key === 'Escape') {
      // Esc closes the palette only: the atlas's own Esc (step back) skips handled keys.
      event.preventDefault();
      search.close();
    }
  };

  const query = search.query.trim();
  let status = null;
  if (!query) {
    status = (
      <p className="palette-hint">{words.hint}</p>
    );
  } else if (search.error) {
    status = <p className="palette-hint is-error">Search failed: {search.error.message}. Try again in a moment.</p>;
  } else if (!search.isPending && !matches.length && interpretation) {
    // The words were read as chips above; no single name holds them all.
    status = <p className="palette-hint">No condition name holds all these words. Apply what was read above, or search part of a name.</p>;
  } else if (!search.isPending && !matches.length) {
    status = (
      <div className="palette-empty">
        <p className="palette-empty-title">No matches for “{query}”</p>
        <p className="palette-hint">{words.empty}</p>
      </div>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      className="palette"
      aria-label={words.dialog}
      onCancel={(event) => {
        event.preventDefault();
        search.close();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          search.close();
        }
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog itself.
        if (event.target === dialogRef.current) search.close();
      }}
    >
      <div className="palette-body">
        <div className="palette-field">
          <Icon name="search" size={20} />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={matches.length > 0}
            aria-controls={listId}
            aria-activedescendant={matches.length ? `${listId}-${activeIndex}` : undefined}
            aria-autocomplete="list"
            aria-label={words.field}
            placeholder={words.field}
            value={search.query}
            maxLength={200}
            onChange={(event) => search.setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="shortcut">esc</kbd>
        </div>
        {interpretation}
        {status}
        {matches.length ? (
          <>
            <p className="palette-count" aria-live="polite">
              {search.total > matches.length ? `First ${matches.length} of ${search.total.toLocaleString('en-US')} matches` : `${search.total} ${search.total === 1 ? 'match' : 'matches'}`}
              {statusFor && !isMultimorbidityMode ? `, each with its ${viewLabel(viewId)} mark, as on the ring` : ''}
            </p>
            <ul ref={listRef} id={listId} className="palette-results" role="listbox" aria-label="Search results">
              {matches.map((match, index) => {
                const isEnabled = search.canChoose(match);
                const status = statusFor ? statusFor(match) : null;
                return (
                  <li
                    key={match.concept_id}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    aria-disabled={!isEnabled}
                    className={`palette-result${index === activeIndex ? ' is-active' : ''}${isEnabled ? '' : ' is-disabled'}${status ? ' has-status' : ''}`}
                    onPointerMove={() => setActiveIndex(index)}
                    onClick={() => search.choose(match)}
                  >
                    <span className="palette-result-name">{conceptName(match)}</span>
                    <span className="palette-result-code">{conceptCode(match) ?? ''}</span>
                    <span className="palette-result-path">
                      {match.match === 'synonym' && match.matched_term ? (
                        <span className="palette-result-synonym">also known as {match.matched_term}, </span>
                      ) : null}
                      {LEVEL_WORDS[match.level] ?? 'Concept'}
                      {match.pathLabel && match.level > 0 ? ` in ${match.pathLabel.split(' > ').slice(0, -1).join(' › ')}` : ''}
                      {isEnabled ? '' : ', combinations use conditions only'}
                    </span>
                    {status ? (
                      <span className="palette-result-status">
                        <span className="visually-hidden">, </span>
                        <StatusLabel status={status} />
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </div>
    </dialog>
  );
}
