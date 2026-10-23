import { useId } from 'react';
import Icon from '../../design/Icon.jsx';
import { displayUseCase } from '../../shared/format.js';
import {
  DROP_REASONS,
  EVIDENCE_GRADES,
  creditsStoredValues,
  FIELD_ORDER,
  displayValue,
  editKind,
  editText,
  editedRecord,
  fieldLabel,
  fieldsForReading,
  labelledOptions,
  proposalProblems,
  recordTitle,
  sourceWords
} from './assist.js';
import CodePicker from './CodePicker.jsx';
import { SelectField, TextAreaField, TextField } from './FormFields.jsx';
import { MetricField } from './MetricRowForm.jsx';
import { MAX_SUMMARY, METRIC_FIELDS } from './records.js';

const METRIC_FIELD_BY_KEY = Object.fromEntries(METRIC_FIELDS.map((field) => [field.key, field]));

/**
 * An edit field's hint: the source ("the accuracy was 0.83, Results, page 2")
 * and, for an uncertain field, "Check: …" in the same amber treatment as the
 * reading view, on its own line.
 */
function fieldHint(field) {
  const source = sourceWords(field?.source);
  if (!field?.uncertain) return source;
  return (
    <>
      {source ? (
        <>
          {source}
          <br />
        </>
      ) : null}
      <span className="proposal-check">
        <Icon name="warning" size={14} className="proposal-check-icon" />
        Check: {field.reason ?? 'the helper is not sure of this value.'}
      </span>
    </>
  );
}

/** Whether the maintainer changed a field (a code for its own label is no change). */
function isEdited(kind, entry, edits, key) {
  return Boolean(edits && key in edits && String(edits[key] ?? '').trim() !== editText(kind, key, entry.record[key]));
}

/** One field of a proposal while it is edited: the S3 form field for its type. */
function EditField({ kind, fieldKey, entry, edits, problem, onEdit, models, meta }) {
  const field = entry.fields?.[fieldKey];
  const value = edits && fieldKey in edits ? edits[fieldKey] : editText(kind, fieldKey, entry.record[fieldKey]);
  const hint = fieldHint(field);
  const label = fieldLabel(fieldKey);
  const type = editKind(kind, fieldKey);
  const set = (next) => onEdit({ [fieldKey]: next });
  if (type === 'condition' || type === 'conditions') {
    const raw = String(value ?? '');
    if (/^chapter\b/i.test(raw.trim())) {
      return <TextField label={label} value={raw} hint={hint} problem={problem} onChange={set} />;
    }
    const names = new Map((edits?.__conditions ?? entry.conditions ?? []).map((condition) => [condition.code, condition.name]));
    const codes = raw
      .split(';')
      .map((code) => code.trim())
      .filter(Boolean)
      .map((code) => ({ code, name: names.get(code) ?? code }));
    return (
      <div className="is-wide">
        <CodePicker
          label={label}
          single={type === 'condition'}
          topLevelOnly={type === 'condition'}
          value={codes}
          hint={hint}
          problem={problem}
          onChange={(next) => onEdit({ [fieldKey]: next.map((condition) => condition.code).join('; '), __conditions: next })}
        />
      </div>
    );
  }
  if (type === 'lens') {
    const options = meta?.axes?.[fieldKey] ?? [];
    return <SelectField label={label} value={value} options={options.includes(value) ? options : [value, ...options]} hint={hint} problem={problem} onChange={set} />;
  }
  if (type === 'card') {
    const list = models ?? [];
    if (fieldKey === 'model_version') {
      const options = list.map((model) => ({ value: model.model_version, label: model.display_name ?? model.model_version }));
      return <SelectField label={label} value={value} options={options.some((option) => option.value === value) ? options : [{ value, label: value }, ...options]} hint={hint} problem={problem} onChange={set} />;
    }
    const chosen = edits?.model_version ?? entry.record.model_version;
    const model = list.find((candidate) => candidate.model_version === chosen);
    const options = (model?.use_cases ?? []).map((useCase) => ({ value: useCase.use_case, label: displayUseCase(useCase.use_case) }));
    return <SelectField label={label} value={value} options={options.some((option) => option.value === value) ? options : [{ value, label: displayUseCase(value) }, ...options]} hint={hint} problem={problem} onChange={set} />;
  }
  if (kind === 'metrics' && METRIC_FIELD_BY_KEY[fieldKey]) {
    return <MetricField field={METRIC_FIELD_BY_KEY[fieldKey]} value={value} problem={problem} hint={hint} onChange={set} />;
  }
  if (type === 'incident_type' || type === 'harm' || type === 'status' || type === 'source_type') {
    return <SelectField label={label} value={value} options={labelledOptions(type)} placeholder="Choose" hint={hint} problem={problem} onChange={set} />;
  }
  if (type === 'grade') {
    return <SelectField label={label} value={value} options={EVIDENCE_GRADES} placeholder="None" optional hideOptional hint={hint} problem={problem} onChange={set} />;
  }
  if (type === 'date') {
    return <TextField label={label} type="date" value={value} hint={hint} problem={problem} onChange={set} />;
  }
  if (type === 'summary') {
    return <TextAreaField label={label} value={value} max={MAX_SUMMARY} hint={hint} problem={problem} onChange={set} className="is-wide" />;
  }
  return <TextField label={label} value={value} hint={hint} problem={problem} onChange={set} className={fieldKey === 'source' || fieldKey === 'source_reference' ? 'is-wide' : ''} />;
}

/** The fields of one proposal as the S3 form fields, in template order. */
function ProposalEditor({ id, kind, entry, edits, helper, models, meta }) {
  const problems = proposalProblems(kind, entry, edits);
  // A field with a problem is offered even when the proposal left it out (Validation type for evidence).
  const keys = (FIELD_ORDER[kind] ?? []).filter((key) => key in entry.record || key in problems);
  return (
    <div className="proposal-editor">
      <div className="form-row is-three">
        {keys.map((key) => (
          <EditField
            key={key}
            kind={kind}
            fieldKey={key}
            entry={entry}
            edits={edits}
            problem={problems[key] ?? null}
            onEdit={(patch) => helper.setEdit(id, patch)}
            models={models}
            meta={meta}
          />
        ))}
      </div>
      <div className="button-row">
        <button type="button" className="button-tinted" onClick={() => helper.setEditing(id, false)}>
          Done
        </button>
        {edits ? (
          <button type="button" className="button-plain" onClick={() => helper.undoEdits(id)}>
            Undo my edits
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One proposed record: Keep, its title, then the values the study states,
 * each with its source and, when the helper is unsure, "Check: …". Values
 * kept from the stored row or set by default fold into one line per origin.
 */
export default function ProposalRecord({ id, kind, entry, kept, edits, isEditing, helper, models, meta }) {
  const checkboxId = useId();
  const record = editedRecord(kind, entry, edits);
  const { title, detail } = recordTitle(kind, record, edits?.__conditions ?? entry.conditions);
  const { shown, folded } = fieldsForReading(kind, { ...entry, record });
  const uncertain = Object.values(entry.fields ?? {}).filter((field) => field.uncertain).length;
  const problems = Object.keys(proposalProblems(kind, entry, edits)).length;
  const mixed = creditsStoredValues(kind, entry);
  return (
    <li className={`proposal${kept ? '' : ' is-unticked'}`}>
      <div className="proposal-head">
        <input id={checkboxId} type="checkbox" className="proposal-keep" checked={kept} onChange={() => helper.toggleKept(id)} />
        <label htmlFor={checkboxId} className="proposal-title-block">
          <span className="proposal-title">{title}</span>
          <span className="proposal-detail">{kept ? detail : `Not staged: ${detail}`}</span>
        </label>
        {uncertain ? (
          <span className="check-pill">
            <Icon name="warning" size={14} />
            {uncertain} to check
          </span>
        ) : null}
        {kept ? (
          <button type="button" className="button-plain proposal-edit" onClick={() => helper.setEditing(id, !isEditing)} aria-expanded={isEditing}>
            {isEditing ? 'Close' : 'Edit values'}
          </button>
        ) : null}
      </div>
      {!kept ? null : isEditing ? (
        <ProposalEditor id={id} kind={kind} entry={entry} edits={edits} helper={helper} models={models} meta={meta} />
      ) : (
        <>
          <dl className="proposal-fields">
            {shown.map(({ key, value, field }) => (
              <div key={key} className={`proposal-field${field.uncertain ? ' is-uncertain' : ''}`}>
                <dt>{fieldLabel(key)}</dt>
                <dd>
                  <span className="proposal-value">
                    {displayValue(key, value)}
                    {isEdited(kind, entry, edits, key) ? <span className="edited-tag">Edited</span> : null}
                  </span>
                  {sourceWords(field.source) ? <span className="proposal-source">{sourceWords(field.source)}</span> : null}
                  {field.origin === 'search' ? <span className="proposal-source">Found by name in the atlas</span> : null}
                  {field.uncertain ? (
                    <span className="proposal-check">
                      <Icon name="warning" size={14} className="proposal-check-icon" />
                      Check: {field.reason ?? 'the helper is not sure of this value.'}
                    </span>
                  ) : null}
                  {field.origin === 'generated' && field.reason && !field.uncertain ? <span className="proposal-source">{field.reason}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
          {folded.map((group) => (
            <p key={group.origin} className="proposal-folded">
              <span className="proposal-folded-label">
                {group.origin === 'store' && mixed ? `${group.label}, credited to this study if staged` : group.label}:
              </span>{' '}
              {group.items.map((item) => `${fieldLabel(item.key)} ${displayValue(item.key, item.value)}`).join('; ')}
            </p>
          ))}
          {problems ? <p className="field-problem">Open “Edit values” to fix {problems === 1 ? 'one value' : `${problems} values`}.</p> : null}
        </>
      )}
    </li>
  );
}

/** A dropped item: why it was left out, what was proposed, and its source. Never guessed. */
export function LeftOutItem({ item }) {
  const values = Object.entries(item.values ?? {}).filter(([, value]) => value !== null && value !== '');
  return (
    <li className="proposal is-left-out">
      <div className="proposal-head">
        <span className="proposal-title-block">
          <span className="proposal-title">{DROP_REASONS[item.reason] ?? item.reason}</span>
          <span className="proposal-detail">{item.detail}</span>
        </span>
      </div>
      {values.length ? (
        <p className="proposal-folded">
          <span className="proposal-folded-label">Proposed:</span> {values.map(([key, value]) => `${fieldLabel(key)} ${Array.isArray(value) ? value.join(', ') : displayValue(key, value)}`).join('; ')}
        </p>
      ) : null}
      {sourceWords(item.source) ? <p className="proposal-folded">{sourceWords(item.source)}</p> : null}
    </li>
  );
}
