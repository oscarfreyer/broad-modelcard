import { useId, useState } from 'react';
import Icon from '../../design/Icon.jsx';

// Exactly one step reads "Next"; `ready` steps are open but not the next action.
const STATE_WORDS = { done: 'Done', current: 'Next', ready: '', waiting: 'Waiting', fix: 'Needs a fix', working: 'Checking' };

function StepGlyph({ state, number }) {
  if (state === 'done') {
    return (
      <span className="step-glyph is-done" aria-hidden="true">
        <Icon name="check" size={16} />
      </span>
    );
  }
  if (state === 'fix') {
    return (
      <span className="step-glyph is-fix" aria-hidden="true">
        <Icon name="warning" size={16} />
      </span>
    );
  }
  return (
    <span className={`step-glyph is-${state}`} aria-hidden="true">
      {number}
    </span>
  );
}

/**
 * One step of a data set page. Finished and waiting steps fold to their
 * header and a one-line summary; the header unfolds them. The step that
 * needs the maintainer next is open.
 *
 * @param {object} props
 * @param {number} props.number position in the flow (the order carries meaning)
 * @param {'done'|'current'|'ready'|'waiting'|'fix'|'working'} props.state
 * @param {string} [props.word] replaces the state word (e.g. "Recommended")
 * @param {string} props.title
 * @param {React.ReactNode} [props.summary] one line shown when folded
 * @param {boolean} [props.defaultOpen]
 */
export default function StepCard({ number, state, title, summary = null, defaultOpen, word, children }) {
  const isOpenByState = defaultOpen ?? (state === 'current' || state === 'ready' || state === 'fix' || state === 'working');
  const [override, setOverride] = useState(null);
  const isOpen = override ?? isOpenByState;
  const bodyId = useId();
  const canFold = Boolean(children);
  return (
    <section className={`step-card is-${state}${isOpen ? ' is-open' : ''}`} aria-label={`Step ${number}: ${title}`}>
      <h2 className="step-heading">
        <button
          type="button"
          className="step-header"
          aria-expanded={canFold ? isOpen : undefined}
          aria-controls={canFold ? bodyId : undefined}
          disabled={!canFold}
          onClick={() => setOverride(!isOpen)}
        >
          <StepGlyph state={state} number={number} />
          <span className="step-title">{title}</span>
          <span className="step-state">{word ?? STATE_WORDS[state]}</span>
          {canFold ? <Icon name="chevronDown" size={18} className="step-chevron" /> : null}
        </button>
      </h2>
      {summary && !isOpen ? <p className="step-summary">{summary}</p> : null}
      {canFold ? (
        <div className="step-body-frame" id={bodyId} hidden={!isOpen}>
          <div className="step-body">{children}</div>
        </div>
      ) : null}
    </section>
  );
}
