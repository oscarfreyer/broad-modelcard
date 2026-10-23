import { useCallback, useId, useMemo, useRef, useState } from 'react';
import Icon from '../../design/Icon.jsx';
import HelpTip from '../../design/HelpTip.js';
import useDismiss from '../../design/useDismiss.js';
import { ICD11, mappingSourceAttribution, ontologyAttribution, ontologyDescription } from '../../shared/ontology.js';
import useProfile from '../profile/useProfile.js';

/**
 * The Classification choice (contract v1.13, CONTRACT.md §23): the
 * disease hierarchy the atlas is drawn in. ICD-11 is the standard and the
 * default; ICD-10-CM and MONDO, when the data holds them, show the ICD-11
 * results their conditions map to. Shown only when `/meta.ontologies` lists
 * more than ICD-11. Choosing one redraws the atlas in one step and keeps the
 * card, view, lens, and prevalence. The popover credits every classification
 * and the mapping tables (THIRD_PARTY_NOTICES.md).
 *
 * @param {object} props
 * @param {object[]} props.ontologies `/meta.ontologies`
 * @param {string} props.value the chosen id ('icd11' by default)
 * @param {(id: string) => void} props.onChange
 */
export default function ClassificationPopover({ ontologies, value, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const refs = useMemo(() => [buttonRef, panelRef], []);
  const close = useCallback(() => setIsOpen(false), []);
  useDismiss(isOpen, refs, close);
  const panelId = useId();
  const titleId = useId();
  const { profile, store } = useProfile();
  const active = ontologies.find((entry) => entry.id === value) ?? ontologies[0];
  const isOther = active.id !== ICD11;
  const savedDefault = profile.defaults?.ontology ?? ICD11;
  const mappingCredit = mappingSourceAttribution(ontologies.find((entry) => entry.sources?.some((source) => source.id === 'who-mapping')));
  const choose = (id) => {
    if (id !== active.id) {
      onChange(id);
    }
    setIsOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="toolbar-popover-anchor is-classification">
      <button
        ref={buttonRef}
        type="button"
        className={`toolbar-button toolbar-classification${isOther ? ' is-filtered' : ''}`}
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-label={`Classification: ${active.name}`}
        title={isOther ? `Shown in ${active.name}; results are mapped from ICD-11` : 'Classification: ICD-11, the standard'}
        onClick={() => setIsOpen((current) => !current)}
      >
        <Icon name="classification" size={18} />
        <span className="toolbar-button-text">{active.name}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {isOpen ? (
        <div ref={panelRef} id={panelId} className="popover classification-popover" role="dialog" aria-labelledby={titleId}>
          <div className="page-title-row">
            <h2 id={titleId} className="popover-title">Classification</h2>
            <HelpTip label="About Classification">
              <p>The disease hierarchy the atlas is drawn in. Results are stored in ICD-11; another classification shows the ICD-11 result each condition maps to.</p>
            </HelpTip>
          </div>
          <ul className="prevalence-options">
            {ontologies.map((entry) => {
              const isActive = entry.id === active.id;
              return (
                <li key={entry.id}>
                  <button type="button" className={`prevalence-option${isActive ? ' is-active' : ''}`} aria-pressed={isActive} onClick={() => choose(entry.id)}>
                    <span className="prevalence-option-check" aria-hidden="true">
                      {isActive ? <Icon name="check" size={16} /> : null}
                    </span>
                    <span className="prevalence-option-copy">
                      <span className="prevalence-option-title">{entry.name}</span>
                      <span className="prevalence-option-text">{ontologyDescription(entry)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="popover-foot classification-credits">
            {ontologies.map((entry) => (
              <p key={entry.id}>{ontologyAttribution(entry)}</p>
            ))}
            {mappingCredit ? <p>{mappingCredit}</p> : null}
          </div>
          {savedDefault === active.id ? (
            <p className="popover-state" role="status">
              <Icon name="check" size={16} />
              Cards open in this classification
            </p>
          ) : (
            <button type="button" className="button-tinted" onClick={() => store.setDefaults({ ontology: isOther ? active.id : null })}>
              Open cards in this classification
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
