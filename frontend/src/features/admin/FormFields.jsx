import { useId, useRef } from 'react';
import HelpTip from '../../design/HelpTip.js';
import Icon from '../../design/Icon.jsx';

// Form fields of the Data Library's one-record forms and change notes, in the
// atlas world: Inset Fill wells with 9px corners and no stroke, a Footnote 600
// label above, an optional hint under it, and the field's problem in the error
// voice. Labels use the template's column words, so a problem the backend
// names by column points at the field of the same name.

// A field's hint is its label's help: a
// question mark beside the label, and still the input's description.
function Described({ problem, problemId }) {
  return problem ? (
    <p className="field-problem" id={problemId}>
      {problem}
    </p>
  ) : null;
}

function LabelHelp({ hint, hintId, label }) {
  return hint ? (
    <HelpTip label={`About ${typeof label === 'string' ? label : 'this field'}`} bubbleId={hintId}>
      <p>{hint}</p>
    </HelpTip>
  ) : null;
}

function useDescribed(hint, problem) {
  const hintId = useId();
  const problemId = useId();
  const ids = [hint ? hintId : null, problem ? problemId : null].filter(Boolean).join(' ');
  return { hintId, problemId, describedBy: ids || undefined };
}

/** " (required)" after a label: seen, and read as part of the label. */
export function RequiredMark() {
  return <span className="field-required"> (required)</span>;
}

/** A one-line text, number, or date input. */
export function TextField({ label, value, onChange, hint = null, problem = null, type = 'text', inputMode, placeholder, optional = false, required = false, className = '', maxLength, readOnly = false }) {
  const id = useId();
  const { hintId, problemId, describedBy } = useDescribed(hint, problem);
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <span className="field-label-row">
        <label className="field-label" htmlFor={id}>
          {label}
          {optional ? <span className="field-optional"> (optional)</span> : null}
          {required ? <RequiredMark /> : null}
        </label>
        <LabelHelp hint={hint} hintId={hintId} label={label} />
      </span>
      <input
        id={id}
        className="text-input"
        type={type}
        inputMode={inputMode}
        placeholder={placeholder}
        maxLength={maxLength}
        readOnly={readOnly || undefined}
        value={value}
        aria-required={required || undefined}
        aria-invalid={problem ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      <Described problem={problem} problemId={problemId} />
    </div>
  );
}

/**
 * A select in the atlas look. `options` are { value, label } (or strings);
 * `placeholder` adds an empty first option that cannot be chosen again.
 */
export function SelectField({ label, value, options, onChange, hint = null, problem = null, placeholder = null, optional = false, hideOptional = false, className = '' }) {
  const id = useId();
  const { hintId, problemId, describedBy } = useDescribed(hint, problem);
  const items = options.map((option) => (typeof option === 'string' ? { value: option, label: option } : option));
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <span className="field-label-row">
        <label className="field-label" htmlFor={id}>
          {label}
          {optional && !hideOptional ? <span className="field-optional"> (optional)</span> : null}
        </label>
        <LabelHelp hint={hint} hintId={hintId} label={label} />
      </span>
      <span className="select-wrap">
        <select id={id} value={value} aria-invalid={problem ? true : undefined} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value)}>
          {placeholder !== null ? (
            <option value="" disabled={!optional}>
              {placeholder}
            </option>
          ) : null}
          {items.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={16} className="select-chevron" />
      </span>
      <Described problem={problem} problemId={problemId} />
    </div>
  );
}

/** Spoken only near and over the limit, so a screen reader is not told the count on every keystroke. */
export function countAnnouncement(length, max) {
  if (length > max) {
    return `${(length - max).toLocaleString('en-US')} characters over the limit of ${max.toLocaleString('en-US')}.`;
  }
  return length >= max * 0.9 ? `${(max - length).toLocaleString('en-US')} characters left.` : '';
}

/** A multi-line text with a character count against `max` (announced only near the limit). */
export function TextAreaField({ label, value, onChange, max, hint = null, problem = null, placeholder, rows = 3, className = '', isRequired = false }) {
  const id = useId();
  const countId = useId();
  const { hintId, problemId, describedBy } = useDescribed(hint, problem);
  const length = value.length;
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <span className="field-label-line">
        <span className="field-label-row">
          <label className="field-label" htmlFor={id}>
            {label}
          </label>
          <LabelHelp hint={hint} hintId={hintId} label={label} />
        </span>
        <span className={`field-count tabular${length > max ? ' is-over' : ''}`} id={countId}>
          {length.toLocaleString('en-US')} / {max.toLocaleString('en-US')}
        </span>
        <span className="visually-hidden" role="status">
          {countAnnouncement(length, max)}
        </span>
      </span>
      <textarea
        id={id}
        className="text-input text-area"
        rows={rows}
        placeholder={placeholder}
        value={value}
        aria-invalid={problem || length > max ? true : undefined}
        aria-required={isRequired || undefined}
        aria-describedby={[describedBy, countId].filter(Boolean).join(' ')}
        onChange={(event) => onChange(event.target.value)}
      />
      <Described problem={problem} problemId={problemId} />
    </div>
  );
}

/**
 * A short set of exclusive choices as radio pills (Harm, Status): every
 * option visible at once, the chosen one raised like a segment. Options with
 * a `hint` are explained in the help at the end of the pills, which the
 * group's description also reads out.
 */
export function ChoiceField({ label, value, options, onChange, problem = null }) {
  const name = useId();
  const hints = options.filter((option) => option.hint);
  const hint = hints.length ? hints.map((option) => `${option.label}: ${option.hint}`).join(' ') : null;
  const { hintId, problemId, describedBy } = useDescribed(hint, problem);
  return (
    <fieldset className="field choice-field" aria-describedby={describedBy}>
      <legend className="field-label">{label}</legend>
      <span className="choice-row">
        <span className="choice-pills">
          {options.map((option) => (
            <label key={option.value} className={`choice-pill${value === option.value ? ' is-chosen' : ''}`}>
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
                aria-label={option.label}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </span>
        <LabelHelp hint={hint} hintId={hintId} label={label} />
      </span>
      <Described problem={problem} problemId={problemId} />
    </fieldset>
  );
}

/**
 * A file choice as a real button (as in the upload step's drop zone): the
 * file input stays hidden and out of the tab order, and is emptied after each
 * choice, so choosing the same file again is noticed. `label` is the button's
 * own words and so its name ("Choose the studies file…"): give each file
 * button of a page its own.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {string} props.accept
 * @param {(file: File|null) => void} props.onFile
 */
export function FileButton({ label, accept, onFile, tone = 'tinted', icon = 'upload', disabled = false }) {
  const inputRef = useRef(null);
  return (
    <>
      <button type="button" className={`button-${tone} file-button`} disabled={disabled} onClick={() => inputRef.current?.click()}>
        {icon ? <Icon name={icon} size={16} /> : null}
        {label}
      </button>
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept={accept}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          onFile(event.target.files?.[0] ?? null);
          event.target.value = '';
        }}
      />
    </>
  );
}

/** A titled group of fields in a one-record form (Study, Where, Source, …). */
export function FormGroup({ title, children }) {
  return (
    <fieldset className="form-group">
      <legend className="form-group-title">{title}</legend>
      <div className="form-group-body">{children}</div>
    </fieldset>
  );
}

/**
 * Which stored record a one-record form edits, with the way back to a new one.
 * Its title is focusable, so Edit in the stored list can move the focus there.
 *
 * @param {object} props
 * @param {string} props.title "Editing study NBR-2026-01"
 * @param {string} props.text what publishing the form does
 * @param {string} props.stopLabel "Enter a new study instead"
 */
export function EditingNotice({ title, text, stopLabel, onStop, isBusy }) {
  return (
    <div className="admin-notice is-info editing-notice" role="note">
      <Icon name="info" size={20} className="admin-notice-icon" />
      <span className="admin-notice-text">
        <span className="admin-notice-title" tabIndex={-1}>
          {title}
        </span>
        <span>{text}</span>
      </span>
      <span className="admin-notice-actions">
        <button type="button" className="button-plain" disabled={isBusy} onClick={onStop}>
          {stopLabel}
        </button>
      </span>
    </div>
  );
}
