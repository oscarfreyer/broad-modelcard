import { useCallback, useId, useMemo, useRef, useState } from 'react';
import Icon from '../../design/Icon.jsx';
import HelpTip from '../../design/HelpTip.js';
import useDismiss from '../../design/useDismiss.js';
import PrevalenceChoices from './PrevalenceChoices.jsx';
import { IS_STATIC_BUILD } from '../../shared/staticBuild.js';
import SettingChoice from './SettingChoice.jsx';

const AXES = [
  { key: 'age', label: 'Age', all: 'All ages' },
  { key: 'sex', label: 'Sex', all: 'All sexes' },
  { key: 'ethnicity', label: 'Ethnicity', all: 'All ethnicities' }
];

/** "Age 65+" → "65+", "Sex Female" → "Female", for the button summary. */
function shortLens(value, axisLabel) {
  return String(value).replace(new RegExp(`^${axisLabel}\\s+`, 'i'), '');
}

/** "Northbridge region (fictional)" → "Northbridge region": the button is short; the ring pane and Summary name it in full. */
function shortPopulationName(name) {
  return String(name || '').replace(/\s*\([^)]*\)\s*$/, '');
}

/** Button text: "All patients", or the chosen lenses joined. */
function populationSummary(lens) {
  const chosen = AXES.filter((axis) => lens?.[axis.key] && lens[axis.key] !== axis.all).map((axis) =>
    axis.key === 'age' ? `Age ${shortLens(lens.age, 'Age')}` : shortLens(lens[axis.key], axis.label)
  );
  return chosen.length ? chosen.join(', ') : 'All patients';
}

/**
 * One Population control for who the results are for: the three demographic
 * lenses and, when the data holds local populations (contract v1.10), the
 * prevalence: default or local, switched in one step. The button names a
 * specific care setting and a local prevalence; the ring pane names it in full.
 *
 * @param {object} props
 * @param {{ age: string, sex: string, ethnicity: string }} props.lens
 * @param {{ age: string[], sex: string[], ethnicity: string[] }} props.options
 * @param {(axis: string, value: string) => void} props.onChange
 * @param {{ populations: object[], active: { id: string, name: string }|null, onChange: (id: string|null) => void }|null} [props.prevalence]
 * @param {string|null} [props.lockedNote] the static demo's reason the groups cannot be chosen now (R7); the choices stay visible, disabled
 * @param {{ value: string|null, options: string[], stored: string[], onChange: (value: string|null) => void, lockedNote?: string|null }|null} [props.setting]
 *   the care setting (contract v1.14, §29): null for Any setting. In the static demo only the settings the card
 *   stores can be chosen, and `lockedNote` says why none can be now (another classification)
 */
export default function PopulationPopover({ lens, options, onChange, prevalence = null, lockedNote = null, setting = null }) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const refs = useMemo(() => [buttonRef, panelRef], []);
  const close = useCallback(() => setIsOpen(false), []);
  useDismiss(isOpen, refs, close);
  const panelId = useId();
  const isFiltered = AXES.some((axis) => lens[axis.key] !== axis.all);
  const chosenSetting = setting?.value ?? null;
  const local = prevalence?.active ?? null;
  const hasPrevalence = Boolean(prevalence?.populations?.length);
  const choosePrevalence = (id) => {
    if (id !== (local?.id ?? null)) {
      prevalence.onChange(id);
    }
    setIsOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="toolbar-popover-anchor">
      <button
        ref={buttonRef}
        type="button"
        className={`toolbar-button${isFiltered || local || chosenSetting ? ' is-filtered' : ''}`}
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-label={`Population: ${populationSummary(lens)}${chosenSetting ? `; setting ${chosenSetting}` : ''}${local ? `; local prevalence ${local.name}` : ''}`}
        title={[chosenSetting ? `Setting: ${chosenSetting}` : null, local ? `Local prevalence: ${local.name}` : null].filter(Boolean).join('; ') || undefined}
        onClick={() => setIsOpen((current) => !current)}
      >
        <Icon name="population" size={18} />
        <span className="toolbar-button-text">{populationSummary(lens)}</span>
        {/* A specific care setting by name (v1.14); hidden on narrow screens like the local prevalence. */}
        {chosenSetting ? <span className="toolbar-button-text toolbar-button-local toolbar-button-setting">, {chosenSetting}</span> : null}
        {/* The local prevalence in use, by name (audit A11). */}
        {local ? <span className="toolbar-button-text toolbar-button-local">, {shortPopulationName(local.name)}</span> : null}
        <Icon name="chevronDown" size={14} />
      </button>
      {isOpen ? (
        <div ref={panelRef} id={panelId} className="popover population-popover" role="dialog" aria-label="Population">
          <div className="page-title-row">
            <h2 className="popover-title">Population</h2>
            {/* True for every card: a card that stores only All patients (as the pack-v1 products do) reads No data at a specific group. */}
            <HelpTip label="About Population">
              <p>Results for one group of patients. A wider group without stored results is worked out from its narrower groups; a group with no results reads No data.</p>
              {IS_STATIC_BUILD && !lockedNote ? (
                <p>This static demo holds one group at a time: choosing one resets the others to All. Condition details are for all patients only.</p>
              ) : null}
            </HelpTip>
          </div>
          {/* Why the groups cannot be chosen now is state, not an explanation: it stays in view. */}
          {IS_STATIC_BUILD && lockedNote ? <p className="popover-note">{lockedNote}</p> : null}
          {AXES.map((axis) => (
            <label key={axis.key} className="field">
              <span className="field-label">{axis.label}</span>
              <span className="select-wrap">
                <select value={lens[axis.key]} disabled={Boolean(lockedNote)} onChange={(event) => onChange(axis.key, event.target.value)}>
                  {(options[axis.key] || []).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <Icon name="chevronDown" size={14} className="select-chevron" />
              </span>
            </label>
          ))}
          {isFiltered && !lockedNote ? (
            <button type="button" className="button-tinted" onClick={() => AXES.forEach((axis) => onChange(axis.key, axis.all))}>
              Show all patients
            </button>
          ) : null}
          {setting?.options?.length ? (
            <SettingChoice
              value={chosenSetting}
              options={setting.options}
              stored={setting.stored}
              onChange={setting.onChange}
              isStatic={IS_STATIC_BUILD}
              lockedNote={setting.lockedNote ?? null}
            />
          ) : null}
          {hasPrevalence ? <PrevalenceChoices populations={prevalence.populations} active={local} onChoose={choosePrevalence} /> : null}
        </div>
      ) : null}
    </div>
  );
}
