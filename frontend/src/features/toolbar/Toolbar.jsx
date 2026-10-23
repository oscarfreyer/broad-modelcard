import { memo, useMemo } from 'react';
import Icon from '../../design/Icon.jsx';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import { SEARCH_SHORTCUT, SEARCH_SHORTCUT_ARIA } from '../../design/shortcut.js';
import { ATLAS_VIEWS, NO_STATEMENT_TEXT } from '../../design/status.js';
import { kindLabel, systemKind, systemOptionGroups } from '../../shared/aiSystem.js';
import { displayUseCase } from '../../shared/format.js';
import CardLabelButton from '../label/CardLabelButton.jsx';
import TrackToggle from '../profile/TrackToggle.jsx';
import ClassificationPopover from './ClassificationPopover.jsx';
import PopulationPopover from './PopulationPopover.jsx';

const VIEW_TITLES = {
  safety: 'Where safety incidents are reported. Incidents never change a result on the other views.'
};
const VIEW_OPTIONS = ATLAS_VIEWS.map((view) => ({ value: view.id, label: view.label, title: VIEW_TITLES[view.id] }));
/** Without an intended-use statement the Intended use view stays visible, disabled, and says why. */
const VIEW_OPTIONS_WITHOUT_STATEMENT = VIEW_OPTIONS.map((option) =>
  option.value === 'intended_use' ? { ...option, disabled: true, reason: NO_STATEMENT_TEXT } : option
);

function kindTitle(entry) {
  return systemKind(entry) === 'product'
    ? 'Product: an AI system packaged for a clinical purpose, which may be built on models.'
    : 'Model: a general AI model.';
}

/**
 * A native select styled as part of the page title. A hidden copy of the
 * current label sizes it, so it is as wide as its value, not its longest option.
 * Options come as groups; a group without a label is a plain list.
 *
 * @param {{ label: string|null, options: { value: string, label: string }[] }[]} props.groups
 */
function TitlePicker({ label, value, groups, onChange, className = '' }) {
  const current = groups.flatMap((group) => group.options).find((option) => option.value === value)?.label ?? value;
  const renderOptions = (options) =>
    options.map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ));
  return (
    <span className={`title-picker${className ? ` ${className}` : ''}`}>
      <span className="title-picker-sizer" aria-hidden="true">{current}</span>
      <select aria-label={label} title={current} value={value} onChange={(event) => onChange(event.target.value)}>
        {groups.map((group) =>
          group.label ? (
            <optgroup key={group.label} label={group.label}>
              {renderOptions(group.options)}
            </optgroup>
          ) : (
            renderOptions(group.options)
          )
        )}
      </select>
      <Icon name="chevronDown" size={16} className="title-picker-chevron" />
    </span>
  );
}

/**
 * The card's toolbar, under the shared header (AppHeader.jsx):
 * the page title, the AI system over its Model or Product tag and its
 * function, with Track and Label for the card on screen. Then the view (four metrics and Safety), the
 * Classification (contract v1.13; only when the data holds more than ICD-11),
 * Population (with the care setting, contract v1.14, and the prevalence switch
 * when the data holds local populations), and search.
 * The mode (Conditions, Multimorbidity) changes what the ring draws, so it
 * sits in the ring tile's header (RingPane.jsx; audit A10).
 *
 * @param {object} props
 * @param {ReturnType<import('../../app/useModelSelection.js').default>} props.selection
 * @param {boolean} [props.hasIntendedUse] the card on screen has an intended-use statement
 * @param {string|null} [props.compareHref] "Compare with…": this card on the comparison page (R4); null hides it
 */
function Toolbar({ selection, viewId, onViewChange, onOpenSearch, hasIntendedUse = true, compareHref = null }) {
  const systemGroups = useMemo(() => systemOptionGroups(selection.entries), [selection.entries]);
  const functionGroups = useMemo(
    () => [{ label: null, options: selection.useCaseOptions.map((useCase) => ({ value: useCase, label: displayUseCase(useCase) })) }],
    [selection.useCaseOptions]
  );
  const entry = selection.entries?.find((candidate) => candidate.model_version === selection.modelVersion) ?? null;
  const systemName =
    systemGroups.flatMap((group) => group.options).find((option) => option.value === selection.modelVersion)?.label ??
    selection.modelVersion ??
    '';
  const functionName = selection.useCase ? displayUseCase(selection.useCase) : '';
  return (
    <header className="toolbar">
      <div className="toolbar-title">
        {/* The page title as text; the pickers beside it are its visible form. */}
        <h1 className="visually-hidden">
          {systemName}
          {functionName ? `, ${functionName}` : ''}
        </h1>
        <div className="toolbar-heading">
          <TitlePicker
            label="AI system"
            className="is-system"
            value={selection.modelVersion}
            groups={systemGroups}
            onChange={selection.setModelVersion}
          />
          <span className="visually-hidden">, </span>
          <span className="toolbar-subtitle">
            {entry ? (
              <span className="kind-tag" title={kindTitle(entry)}>
                {kindLabel(entry)}
              </span>
            ) : null}
            <TitlePicker
              label="Function"
              className="is-function"
              value={selection.useCase}
              groups={functionGroups}
              onChange={selection.setUseCase}
            />
          </span>
        </div>
        <div className="toolbar-card-actions">
          <TrackToggle
            modelVersion={selection.modelVersion}
            useCase={selection.useCase}
            name={entry ? `${entry.display_name || entry.model_version}, ${displayUseCase(selection.useCase)}` : null}
            variant="toolbar"
          />
          <CardLabelButton modelVersion={selection.modelVersion} useCase={selection.useCase} population={selection.activePopulation} />
        </div>
      </div>

      <SegmentedControl label="View" options={hasIntendedUse ? VIEW_OPTIONS : VIEW_OPTIONS_WITHOUT_STATEMENT} value={viewId} onChange={onViewChange} className="toolbar-metric" />

      <div className="toolbar-actions">
        <div className="toolbar-choices">
          {(selection.ontologies?.length ?? 0) > 1 ? (
            <ClassificationPopover ontologies={selection.ontologies} value={selection.ontology} onChange={selection.setOntology} />
          ) : null}
          <PopulationPopover
            lens={selection.lens}
            options={selection.lensOptions}
            onChange={selection.setLensValue}
            lockedNote={selection.lensLockedNote ?? null}
            setting={
              selection.settingOptions?.length
                ? {
                    value: selection.setting,
                    options: selection.settingOptions,
                    stored: selection.cardSettings,
                    onChange: selection.setSetting,
                    lockedNote: selection.settingLockedNote ?? null
                  }
                : null
            }
            prevalence={
              selection.populations?.length
                ? { populations: selection.populations, active: selection.activePopulation, onChange: selection.setPopulation }
                : null
            }
          />
          {compareHref ? (
            <a className="toolbar-button toolbar-compare" href={compareHref} title="Compare with other cards, chapter by chapter">
              <Icon name="compare" size={18} />
              <span className="visually-hidden">Compare with…</span>
            </a>
          ) : null}
        </div>
        <button
          type="button"
          className="toolbar-button toolbar-search"
          onClick={onOpenSearch}
          aria-label="Search"
          aria-keyshortcuts={SEARCH_SHORTCUT_ARIA}
        >
          <Icon name="search" size={18} />
          <span className="toolbar-button-text">Search</span>
          <kbd className="shortcut">{SEARCH_SHORTCUT}</kbd>
        </button>
      </div>
    </header>
  );
}

export default memo(Toolbar);
