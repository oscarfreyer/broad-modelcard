import { forwardRef, useId } from 'react';
import Icon from '../../design/Icon.jsx';
import { FILTER_LABELS, SORT_LABELS } from './catalogueModel.js';
import { FILTER_KEYS, activeFilterCount } from './catalogueState.js';

// What an unset filter reads, so each control names itself.
const ANY = {
  functionName: 'All functions',
  category: 'All categories',
  kind: 'Models and products',
  aiType: 'All AI types',
  developer: 'All developers',
  status: 'Any stage'
};

/** The filters drawn as menus: the AI system is found with the search instead. */
const MENU_KEYS = FILTER_KEYS.filter((key) => key !== 'system');

function PillSelect({ label, value, isSet, onChange, children }) {
  return (
    <label className={`cat-filter${isSet ? ' is-set' : ''}`}>
      <span className="visually-hidden">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <Icon name="chevronDown" size={14} className="cat-filter-chevron" />
    </label>
  );
}

/**
 * The text search first, then one row of filters (they combine with the
 * search and with each other) and the sort. Option lists come from the
 * loaded tiles; every change is client-side. The AI system filter has no
 * menu (the search finds a system by name); when "Other functions of this
 * system" or a shared link sets it, it shows as a chip that removes it.
 *
 * @param {object} props
 * @param {Record<string, { value: string, label: string, count: number }[]>} props.options
 * @param {Record<string, string|null>} props.filters
 * @param {string} props.query the text search
 * @param {string} props.sort
 * @param {string[]} props.sorts available sorts
 * @param {(key: string, value: string|null) => void} props.onFilter
 * @param {(query: string) => void} props.onQuery
 * @param {(sort: string) => void} props.onSort
 * @param {() => void} props.onClear
 * @param {boolean} [props.newest] "Newest versions only" is on (contract v1.14)
 * @param {((newest: boolean) => void)|null} [props.onNewest] null hides the choice (no AI system replaces another)
 */
const FilterBar = forwardRef(function FilterBar({ options, filters, query, sort, sorts, onFilter, onQuery, onSort, onClear, newest = false, onNewest = null }, ref) {
  const searchId = useId();
  const setCount = activeFilterCount(filters) + (query.trim() ? 1 : 0) + (newest ? 1 : 0);
  const system = filters.system ? options.system?.find((choice) => choice.value === filters.system) : null;
  return (
    <div className="cat-filters" role="group" aria-label="Find, filter, and sort the cards" ref={ref}>
      <div className="cat-search">
        <label htmlFor={searchId} className="visually-hidden">
          Find an AI system, function, or developer
        </label>
        <Icon name="search" size={16} className="cat-search-icon" />
        <input
          id={searchId}
          type="search"
          className="cat-search-input"
          placeholder="Find an AI system, function, or developer"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              onQuery('');
            }
          }}
        />
      </div>
      {filters.system ? (
        <button type="button" className="cat-filter-chip" onClick={() => onFilter('system', null)}>
          <span>
            <span className="visually-hidden">{FILTER_LABELS.system}: </span>
            {system?.label ?? filters.system}
          </span>
          <Icon name="close" size={14} />
          <span className="visually-hidden">, remove this filter</span>
        </button>
      ) : null}
      {MENU_KEYS.map((key) => {
        const choices = options[key] ?? [];
        const value = filters[key] ?? '';
        // A value from a shared URL that this catalogue does not hold stays visible.
        const missing = value && !choices.some((choice) => choice.value === value);
        return (
          <PillSelect key={key} label={FILTER_LABELS[key]} value={value} isSet={Boolean(value)} onChange={(next) => onFilter(key, next || null)}>
            <option value="">{ANY[key]}</option>
            {/* A choice that would show no card with the other filters stays listed, but cannot be picked. */}
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value} disabled={choice.count === 0 && choice.value !== value}>
                {choice.label} ({choice.count})
              </option>
            ))}
            {missing ? <option value={value}>{value} (0)</option> : null}
          </PillSelect>
        );
      })}
      {/* Hides the cards of AI systems that a newer version replaces (§28.2). */}
      {onNewest ? (
        <button type="button" className={`cat-filter-toggle${newest ? ' is-set' : ''}`} aria-pressed={newest} onClick={() => onNewest(!newest)}>
          {newest ? <Icon name="check" size={14} /> : null}
          Newest versions only
        </button>
      ) : null}
      <span className="cat-filters-divider" aria-hidden="true" />
      <PillSelect label="Sort" value={sort} isSet={false} onChange={onSort}>
        {sorts.map((option) => (
          <option key={option} value={option}>
            Sort: {SORT_LABELS[option]}
          </option>
        ))}
      </PillSelect>
      {setCount ? (
        <button type="button" className="button-plain cat-filters-clear" onClick={onClear}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
});

export default FilterBar;
