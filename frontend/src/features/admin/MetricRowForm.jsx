import { useId, useMemo, useState } from 'react';
import { rankWarnings } from '../details/copy/warningCopy.js';
import { ANY_SETTING_LABEL, CARE_SETTINGS } from '../../shared/careSetting.js';
import { displayUseCase, lensOptions } from '../../shared/format.js';
import CodePicker from './CodePicker.jsx';
import { FormGroup, SelectField, TextField } from './FormFields.jsx';
import {
  EVIDENCE_GRADES,
  INTENDED_USE_KEYS,
  INTENDED_USE_LEVELS,
  METRIC_FIELDS,
  METRIC_WARNING_CODES,
  VALIDATION_TYPES,
  evidenceProblems,
  metricRecord,
  metricRowProblems,
  toggleWarning,
  warningList
} from './records.js';

/** A warning code in the condition card's words ("Clinician review required"). */
const warningTitle = (code) => rankWarnings([{ code }])[0].title;

/**
 * Warnings as a list of checkboxes, in the condition card's words; the cell
 * the template has ("a; b") is what the form keeps. A code outside the known
 * list (from a file or the study helper) stays listed and checked.
 */
function WarningChecklist({ label, value, onChange, problem = null, hint = null }) {
  const id = useId();
  const chosen = warningList(value);
  const codes = [...METRIC_WARNING_CODES, ...chosen.filter((code) => !METRIC_WARNING_CODES.includes(code))];
  const describedBy = [hint ? `${id}-hint` : null, problem ? `${id}-problem` : null].filter(Boolean).join(' ') || undefined;
  return (
    <fieldset className="field warning-checklist is-wide" aria-describedby={describedBy} aria-invalid={problem ? true : undefined}>
      <legend className="field-label">{label}</legend>
      {hint ? (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      <span className="warning-options">
        {codes.map((code) => (
          <label key={code} className="warning-option">
            <input type="checkbox" checked={chosen.includes(code)} onChange={(event) => onChange(toggleWarning(value, code, event.target.checked))} />
            <span>
              {warningTitle(code)}
              <span className="warning-code">{code}</span>
            </span>
          </label>
        ))}
      </span>
      {problem ? (
        <p className="field-problem" id={`${id}-problem`}>
          {problem}
        </p>
      ) : null}
    </fieldset>
  );
}

// The care settings of a row (contract v1.14, §29): empty is Any setting.
const SETTING_OPTIONS = CARE_SETTINGS.map((setting) => ({ value: setting.value, label: setting.value }));

/** One of the 13 metric fields as the template has it (also used to edit a helper proposal). */
export function MetricField({ field, value, problem, onChange, hint }) {
  const common = { label: field.label, value, problem, onChange, hint };
  if (field.type === 'grade') {
    return <SelectField {...common} options={EVIDENCE_GRADES} placeholder="None" optional hideOptional />;
  }
  if (field.type === 'validation') {
    return <SelectField {...common} options={VALIDATION_TYPES} placeholder="None" optional hideOptional />;
  }
  if (field.type === 'yes_no') {
    // Empty with Intended-use level too: the row states no intended use (contract v1.11).
    return <SelectField {...common} options={['Yes', 'No']} placeholder="Not stated" optional hideOptional />;
  }
  if (field.type === 'level') {
    return <SelectField {...common} options={INTENDED_USE_LEVELS} placeholder="Not stated" optional hideOptional />;
  }
  if (field.type === 'warnings') {
    return <WarningChecklist label={field.label} value={value} problem={problem} hint={hint ?? 'Tick each warning the study reports for this row.'} onChange={onChange} />;
  }
  return <TextField {...common} inputMode={field.type === 'count' ? 'numeric' : 'decimal'} placeholder={field.hint} />;
}

/**
 * "Enter one row" of performance metrics: one condition and population group
 * of the page's card, the 13 template fields, and the row's source. Staged as
 * a records upload (a merge: every other row of the card stays), then checked
 * like a file. A card without an intended-use statement (`hasIntendedUse`
 * false) does not show the intended-use fields and sends them empty.
 */
export default function MetricRowForm({ form, onChange, target, meta, onSubmit, isBusy, onReset, hasIntendedUse = true }) {
  const [showProblems, setShowProblems] = useState(false);
  const problems = useMemo(() => metricRowProblems(form, { hasIntendedUse }), [form, hasIntendedUse]);
  const fields = hasIntendedUse ? METRIC_FIELDS : METRIC_FIELDS.filter((field) => !INTENDED_USE_KEYS.includes(field.key));
  const shown = showProblems ? problems : {};
  const set = (patch) => onChange({ ...form, ...patch });
  const setValue = (key, value) => onChange({ ...form, values: { ...form.values, [key]: value } });
  const axes = meta?.axes ?? null;
  // Said as soon as Performance has a value (contract v1.11), not only after "Check this row".
  const needsEvidence = Boolean(evidenceProblems(form.values).validation_type);

  return (
    <form
      className="record-form"
      aria-label="Enter one row of performance metrics"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (Object.keys(problems).length) {
          setShowProblems(true);
          const formNode = event.currentTarget;
          window.setTimeout(() => formNode.querySelector('[aria-invalid="true"]')?.focus(), 0);
          return;
        }
        setShowProblems(false);
        onSubmit([metricRecord(form, { hasIntendedUse })]);
      }}
    >
      <p className="step-text">
        One row for {target.model}, {displayUseCase(target.useCase)}. Every other row of this card stays as it is; a row already
        stored for this condition, group, and setting is replaced, unless it comes from a newer study. Fields marked (required) need an answer.
      </p>
      <FormGroup title="Condition and group">
        <CodePicker
          label="ICD-11 code"
          required
          single
          topLevelOnly
          value={form.condition ? [form.condition] : []}
          onChange={(codes) => set({ condition: codes[0] ?? null })}
          hint="Metrics belong to top-level conditions, e.g. 5A11."
          problem={shown.condition ?? null}
        />
        <div className="form-row is-three">
          <SelectField label="Age" value={form.lens.age} options={lensOptions(axes?.age ?? [form.lens.age])} onChange={(age) => set({ lens: { ...form.lens, age } })} />
          <SelectField label="Sex" value={form.lens.sex} options={lensOptions(axes?.sex ?? [form.lens.sex])} onChange={(sex) => set({ lens: { ...form.lens, sex } })} />
          <SelectField
            label="Ethnicity"
            value={form.lens.ethnicity}
            options={lensOptions(axes?.ethnicity ?? [form.lens.ethnicity])}
            onChange={(ethnicity) => set({ lens: { ...form.lens, ethnicity } })}
          />
        </div>
        <div className="form-row is-three">
          <SelectField
            label="Setting"
            value={form.setting ?? ''}
            options={SETTING_OPTIONS}
            placeholder={ANY_SETTING_LABEL}
            optional
            hideOptional
            onChange={(setting) => set({ setting })}
          />
        </div>
        <p className="field-hint">Any setting holds across care settings; a specific setting stores the result for that setting only.</p>
      </FormGroup>

      <FormGroup title="Results">
        <p className="field-hint">
          As the template has them. Leave a field empty when the study does not report it. A Performance value needs its Validation type.{' '}
          {hasIntendedUse
            ? 'Give In intended use and Intended-use level together, or leave both empty when the study states no intended use.'
            : 'This card has no intended-use statement, so the intended-use fields are not asked.'}
        </p>
        <div className="form-row is-three">
          {fields.map((field) => (
            <MetricField
              key={field.key}
              field={field}
              value={form.values[field.key]}
              problem={shown[field.key] ?? null}
              hint={field.key === 'validation_type' && needsEvidence && !shown.validation_type ? 'Needed: Performance has a value.' : undefined}
              onChange={(value) => setValue(field.key, value)}
            />
          ))}
        </div>
      </FormGroup>

      <FormGroup title="Source">
        <TextField
          label="Source"
          required
          value={form.source}
          placeholder="e.g. Northbridge multisite validation (fictional)"
          maxLength={200}
          problem={shown.source ?? null}
          onChange={(source) => set({ source })}
        />
        <div className="form-row is-two">
          <TextField label="Study" required value={form.study} placeholder="e.g. NBR-2026-01" maxLength={64} problem={shown.study ?? null} onChange={(study) => set({ study })} />
          <TextField label="Source date" required type="date" value={form.sourceDate} problem={shown.sourceDate ?? null} onChange={(sourceDate) => set({ sourceDate })} />
        </div>
        <p className="field-hint">Aggregate synthetic results only. Never patient-level or real patient data.</p>
      </FormGroup>

      <div className="button-row form-actions">
        <button type="submit" className="button-filled" disabled={isBusy}>
          {isBusy ? 'Checking…' : 'Check this row'}
        </button>
        <button
          type="button"
          className="button-plain"
          disabled={isBusy}
          onClick={() => {
            setShowProblems(false);
            onReset();
          }}
        >
          Clear the form
        </button>
      </div>
      {showProblems && Object.keys(problems).length ? (
        <p className="field-problem" role="alert">
          {Object.keys(problems).length === 1 ? 'One field still needs an answer.' : `${Object.keys(problems).length} fields still need an answer.`} Nothing was sent.
        </p>
      ) : null}
    </form>
  );
}
