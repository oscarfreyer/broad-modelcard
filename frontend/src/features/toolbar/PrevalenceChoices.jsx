import Icon from '../../design/Icon.jsx';
import HelpTip from '../../design/HelpTip.js';
import { DEFAULT_PREVALENCE, LOCAL_SYNTHETIC_NOTE, PREVALENCE_NOTE, populationCoverage } from '../../shared/localPopulation.js';
import useProfile from '../profile/useProfile.js';

/**
 * The prevalence switch inside the Population popover: the default prevalence or one local population, each one button.
 * Choosing switches every read of the atlas at once (one step); the popover
 * then closes. A quiet action makes the choice the profile's default.
 *
 * @param {object} props
 * @param {{ id: string, name: string, codes: number }[]} props.populations `/meta.populations`
 * @param {{ id: string, name: string }|null} props.active the local population in use (null: default)
 * @param {(id: string|null) => void} props.onChoose
 */
export default function PrevalenceChoices({ populations, active, onChoose }) {
  const { profile, store } = useProfile();
  const activeId = active?.id ?? null;
  const savedDefault = profile.defaults?.population ?? null;
  const isSavedDefault = savedDefault === activeId;
  const options = [
    { id: null, title: DEFAULT_PREVALENCE, text: 'The shared baseline for every condition.' },
    ...populations.map((entry) => ({ id: entry.id, title: entry.name, text: populationCoverage(entry) }))
  ];
  return (
    <section className="prevalence-section" aria-labelledby="prevalence-title">
      <div className="page-title-row">
        <h3 id="prevalence-title" className="popover-subtitle">Prevalence</h3>
        <HelpTip label="About Prevalence">
          <p>{PREVALENCE_NOTE}</p>
          <p>{LOCAL_SYNTHETIC_NOTE}</p>
        </HelpTip>
      </div>
      <ul className="prevalence-options">
        {options.map((option) => {
          const isActive = option.id === activeId;
          return (
            <li key={option.id ?? 'default'}>
              <button type="button" className={`prevalence-option${isActive ? ' is-active' : ''}`} aria-pressed={isActive} onClick={() => onChoose(option.id)}>
                <span className="prevalence-option-check" aria-hidden="true">
                  {isActive ? <Icon name="check" size={16} /> : null}
                </span>
                <span className="prevalence-option-copy">
                  <span className="prevalence-option-title">{option.title}</span>
                  {option.text ? <span className="prevalence-option-text">{option.text}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {/* An action while it would change something; then the state it set, not a dimmed button (audit A11). */}
      {isSavedDefault ? (
        <p className="popover-state" role="status">
          <Icon name="check" size={16} />
          Cards open with this prevalence
        </p>
      ) : (
        <button type="button" className="button-tinted" onClick={() => store.setDefaults({ population: activeId })}>
          Open cards with this prevalence
        </button>
      )}
    </section>
  );
}
