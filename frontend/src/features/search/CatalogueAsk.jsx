import { useId, useMemo, useState } from 'react';
import useClientQuery from '../../api/useClientQuery.js';
import Icon from '../../design/Icon.jsx';
import { IS_STATIC_BUILD } from '../../shared/staticBuild.js';
import InterpretationRow from './InterpretationRow.jsx';
import { applyPlan, atlasHrefOfPlan, canCombine } from './interpretation.js';
import useInterpretation from './useInterpretation.js';

const NO_ENTRIES = Object.freeze([]);

/**
 * The catalogue's Ask field (contract v1.14, CONTRACT.md §31): a plain-language
 * query read as chips; "Open in the atlas" opens the atlas with them in its URL
 * (the card, the lens, the setting, and the first condition or the combination).
 *
 * @param {object} props
 * @param {(href: string) => void} [props.navigate] opens a URL (tests pass their own)
 */
export default function CatalogueAsk({ navigate = (href) => window.location.assign(href) }) {
  const inputId = useId();
  const [query, setQuery] = useState('');
  const registry = useClientQuery('models', (client, options) => client.listModels({}, options));
  const entries = registry.data?.models ?? NO_ENTRIES;
  const interpretation = useInterpretation({ query, enabled: true });
  const plan = useMemo(() => applyPlan(interpretation.chips, entries, null), [entries, interpretation.chips]);
  const isShown = Boolean(query.trim()) && (interpretation.chips.length > 0 || interpretation.removedCount > 0 || interpretation.origin === 'helper');
  const open = ({ combine }) => navigate(atlasHrefOfPlan(plan, { combine }));

  return (
    <section className="cat-ask" aria-labelledby={`${inputId}-label`}>
      <form
        className="cat-ask-form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (interpretation.chips.length) open({ combine: false });
        }}
      >
        <label id={`${inputId}-label`} htmlFor={inputId} className="cat-ask-label">
          Ask the atlas
        </label>
        <div className="cat-ask-field">
          <Icon name="search" size={18} />
          <input
            id={inputId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="For example: heart failure in older women in the emergency department"
            maxLength={200}
            autoComplete="off"
            spellCheck="false"
          />
        </div>
      </form>
      {isShown ? (
        <InterpretationRow
          interpretation={interpretation}
          entries={entries}
          onApply={open}
          canCombine={canCombine(plan, entries, null)}
          applyLabel="Open in the atlas"
          offerHelper={!IS_STATIC_BUILD}
        />
      ) : query.trim() && !interpretation.isPending && !interpretation.error ? (
        <p className="cat-ask-hint">Nothing recognized yet. Name an AI system, a condition, a group such as older women, or a care setting.</p>
      ) : null}
      {interpretation.error ? (
        <p className="cat-ask-hint is-error" role="alert">
          The words could not be read: {interpretation.error.detail ?? interpretation.error.message}
        </p>
      ) : null}
    </section>
  );
}
