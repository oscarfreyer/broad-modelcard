import { Fragment, useId, useRef } from 'react';

/**
 * A segmented control (radio group): one track, the active segment raised.
 * Arrow keys move the selection, as in a native segmented control, and skip
 * disabled segments. A disabled segment stays visible and says why in its
 * tooltip and its accessible description (`reason`).
 *
 * @param {object} props
 * @param {string} props.label accessible name of the group
 * @param {{ value: string, label: string, title?: string, disabled?: boolean, reason?: string }[]} props.options
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 * @param {'regular'|'small'} [props.size]
 */
export default function SegmentedControl({ label, options, value, onChange, size = 'regular', className = '' }) {
  const refs = useRef([]);
  const idBase = useId();
  const activeIndex = Math.max(0, options.findIndex((option) => option.value === value));

  const handleKeyDown = (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) {
      return;
    }
    event.preventDefault();
    let next = activeIndex;
    for (let tries = 0; tries < options.length; tries += 1) {
      next = (next + step + options.length) % options.length;
      if (!options[next].disabled) {
        break;
      }
    }
    if (next === activeIndex || options[next].disabled) {
      return;
    }
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      className={`segmented segmented-${size}${className ? ` ${className}` : ''}`}
      role="radiogroup"
      aria-label={label}
      onKeyDown={handleKeyDown}
    >
      {options.map((option, index) => {
        const isActive = index === activeIndex;
        const reasonId = option.disabled && option.reason ? `${idBase}-${index}-reason` : undefined;
        return (
          <Fragment key={option.value}>
          <button
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-disabled={option.disabled ? true : undefined}
            aria-describedby={reasonId}
            tabIndex={isActive ? 0 : -1}
            className={`segment${isActive ? ' is-active' : ''}${option.disabled ? ' is-disabled' : ''}`}
            title={option.disabled ? option.reason ?? option.title : option.title}
            onClick={() => {
              if (!option.disabled) {
                onChange(option.value);
              }
            }}
          >
            {option.label}
          </button>
          {reasonId ? (
            <span id={reasonId} className="visually-hidden">
              {option.reason}
            </span>
          ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}
