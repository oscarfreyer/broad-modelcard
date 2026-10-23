import Icon from '../../design/Icon.jsx';
import HelpTip from '../../design/HelpTip.js';
import { ANY_SETTING, ANY_SETTING_LABEL, NO_DATA_STORED, NOT_IN_STATIC_DEMO } from '../../shared/careSetting.js';

/**
 * The Setting choice inside the Population popover (contract v1.14, CONTRACT.md
 * §29): Any setting, or one care setting whose results alone are shown. A
 * setting the card stores no results for stays choosable and says so; every
 * condition then reads No data. Choosing applies at once, like the groups.
 *
 * The static demo (release 0.5) records only the settings each card
 * stores: the others are listed but cannot be chosen, marked as not in the
 * static demo, and in another classification none can be (`lockedNote`).
 *
 * @param {object} props
 * @param {string|null} props.value the chosen setting's axis value (null: Any setting)
 * @param {string[]} props.options the specific settings `/meta` offers
 * @param {string[]} props.stored the settings the card on screen stores rows for
 * @param {(value: string|null) => void} props.onChange
 * @param {boolean} [props.isStatic] the static demo: only stored settings can be chosen
 * @param {string|null} [props.lockedNote] the static demo's reason no setting can be chosen now
 */
export default function SettingChoice({ value, options, stored, onChange, isStatic = false, lockedNote = null }) {
  const hasNone = Boolean(value) && !stored.includes(value);
  const optionLabel = (option) => {
    if (stored.includes(option)) return option;
    return `${option} (${isStatic ? NOT_IN_STATIC_DEMO : NO_DATA_STORED})`;
  };
  // What a setting does is in the help; why this choice reads No data or cannot be made is state, so it stays in view.
  const help = `Any setting shows every result. A specific setting shows only results measured there.${isStatic ? ' This static demo holds the settings each card stores, for all patients.' : ''}`;
  const note = lockedNote ?? (hasNone ? `This card stores no results for ${value}, so every condition reads No data.` : null);
  return (
    <section className="setting-section" aria-labelledby="setting-title">
      <div className="page-title-row setting-title-row">
        <span id="setting-title" className="field-label">Setting</span>
        <HelpTip label="About Setting">
          <p>{help}</p>
        </HelpTip>
      </div>
      <label className="field">
        <span className="select-wrap">
          <select
            value={value ?? ANY_SETTING}
            aria-labelledby="setting-title"
            aria-describedby={note ? 'setting-note' : undefined}
            disabled={Boolean(lockedNote)}
            onChange={(event) => onChange(event.target.value === ANY_SETTING ? null : event.target.value)}
          >
            <option value={ANY_SETTING}>{ANY_SETTING_LABEL}</option>
            {options.map((option) => (
              <option key={option} value={option} disabled={isStatic && !stored.includes(option)}>
                {optionLabel(option)}
              </option>
            ))}
          </select>
          <Icon name="chevronDown" size={14} className="select-chevron" />
        </span>
      </label>
      {note ? <p id="setting-note" className="popover-note">{note}</p> : null}
    </section>
  );
}
