import { useEffect, useId, useRef, useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import Icon from '../../design/Icon.jsx';
import { displayTerm } from '../../shared/conceptName.js';
import { activeIndex, comboboxKey, shownMatches } from './codePickerKeys.js';
import { RequiredMark } from './FormFields.jsx';

const DEBOUNCE_MS = 120;
const LIMIT = 40;

/**
 * An ICD-11 code picker over the backend search (searchConcepts): type a code
 * or part of a name, choose a result. Only codes the atlas knows can be
 * picked; there is no free-text code. `topLevelOnly` keeps to the 2,400
 * top-level conditions (metrics rows); otherwise any category with a code.
 * Picked codes show as removable tokens; with `single`, a new pick replaces
 * the old one.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {{ code: string, name: string }[]} props.value
 * @param {(next: { code: string, name: string }[]) => void} props.onChange
 * @param {boolean} [props.single]
 * @param {boolean} [props.topLevelOnly]
 * @param {string|null} [props.problem] the field's problem, shown under it
 */
export default function CodePicker({ label, value, onChange, single = false, topLevelOnly = false, problem = null, hint = null, required = false }) {
  const client = useDataClient();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState({ query: '', matches: [], error: null });
  const [active, setActive] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef(null);
  const listId = useId();
  const labelId = useId();
  const problemId = useId();
  const request = useRef(0);
  // Closing on blur waits a moment (a click on an option lands first); focus
  // coming back before then, e.g. after removing a code, cancels it.
  const closeTimer = useRef(null);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useEffect(() => {
    const trimmed = query.trim();
    request.current += 1;
    const id = request.current;
    if (!trimmed) {
      setResult({ query: '', matches: [], error: null });
      return undefined;
    }
    const timer = window.setTimeout(async () => {
      try {
        const response = await client.searchConcepts({ q: trimmed, limit: LIMIT });
        if (id !== request.current) return;
        const matches = response.results
          .filter((concept) => concept.level === 2 && concept.icd11_code && (!topLevelOnly || concept.depth_in_kind === 1))
          .map((concept) => ({ code: concept.icd11_code, name: displayTerm(concept.pt), isTopLevel: concept.depth_in_kind === 1 }));
        setResult({ query: trimmed, matches, error: null });
        setActive(0);
      } catch (error) {
        if (id === request.current) setResult({ query: trimmed, matches: [], error });
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [client, query, topLevelOnly]);

  const isCurrent = result.query === query.trim();
  const matches = isCurrent ? result.matches.filter((match) => !value.some((entry) => entry.code === match.code)) : [];
  // The keyboard and aria-activedescendant only reach the options drawn.
  const shown = shownMatches(matches);
  const current = activeIndex(active, shown.length);
  const showList = isOpen && query.trim() !== '';

  const pick = (match) => {
    if (!match) return;
    onChange(single ? [{ code: match.code, name: match.name }] : [...value, { code: match.code, name: match.name }]);
    setQuery('');
    setIsOpen(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape' && showList) {
      event.preventDefault();
      event.stopPropagation();
      setIsOpen(false);
      return;
    }
    if (event.key === 'Backspace' && !query && value.length && !single) {
      onChange(value.slice(0, -1));
      return;
    }
    const action = comboboxKey(event.key, { active, shownCount: shown.length, isListShown: showList });
    if (action.preventDefault) event.preventDefault();
    if (action.open) setIsOpen(true);
    if (action.active !== undefined) setActive(action.active);
    if (action.pick !== undefined) pick(shown[action.pick]);
  };

  let status = null;
  if (showList && !isCurrent) status = 'Searching…';
  else if (showList && result.error) status = 'The search did not answer. Try again in a moment.';
  else if (showList && !matches.length) status = topLevelOnly ? 'No top-level condition matches. Try the code, e.g. 5A11.' : 'No ICD-11 category matches. Try the code, e.g. 5A11.';

  return (
    <div className="field code-picker">
      <span className="field-label" id={labelId}>
        {label}
        {required ? <RequiredMark /> : null}
      </span>
      {value.length ? (
        <ul className="code-tokens" aria-label={`${label}: chosen`}>
          {value.map((entry) => (
            <li key={entry.code} className="code-token">
              <span className="code-token-code tabular">{entry.code}</span>
              <span className="code-token-name">{entry.name}</span>
              <button
                type="button"
                className="code-token-remove"
                aria-label={`Remove ${entry.code} ${entry.name}`}
                onClick={() => {
                  onChange(value.filter((item) => item.code !== entry.code));
                  // The token and its button leave the page; focus stays in the field.
                  inputRef.current?.focus();
                }}
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="code-search">
        <Icon name="search" size={16} className="code-search-icon" />
        <input
          ref={inputRef}
          className="text-input code-search-input"
          type="text"
          role="combobox"
          aria-labelledby={labelId}
          aria-expanded={showList && shown.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && current !== null ? `${listId}-${current}` : undefined}
          aria-invalid={problem ? true : undefined}
          aria-required={required && !value.length ? true : undefined}
          aria-describedby={problem ? problemId : undefined}
          placeholder={single && value.length ? 'Search to choose another' : 'Code or name, e.g. 5A11 or pneumonia'}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIsOpen(true);
          }}
          onFocus={() => {
            window.clearTimeout(closeTimer.current);
            setIsOpen(true);
          }}
          onBlur={() => {
            closeTimer.current = window.setTimeout(() => setIsOpen(false), 120);
          }}
          onKeyDown={onKeyDown}
        />
        {showList && shown.length ? (
          <ul className="code-results" id={listId} role="listbox" aria-labelledby={labelId}>
            {shown.map((match, index) => (
              <li
                key={match.code}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === current}
                className={`code-result${index === current ? ' is-active' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(match)}
              >
                <span className="code-token-code tabular">{match.code}</span>
                <span className="code-result-name">{match.name}</span>
                {!topLevelOnly && !match.isTopLevel ? <span className="code-result-note">counts for its condition</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {status ? (
        <p className="field-hint" role="status">
          {status}
        </p>
      ) : hint ? (
        <p className="field-hint">{hint}</p>
      ) : null}
      {problem ? (
        <p className="field-problem" id={problemId}>
          {problem}
        </p>
      ) : null}
    </div>
  );
}
