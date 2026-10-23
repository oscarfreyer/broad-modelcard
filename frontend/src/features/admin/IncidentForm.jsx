import { useMemo, useState } from 'react';
import Icon from '../../design/Icon.jsx';
import StatusLabel from '../../design/StatusLabel.jsx';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import { conceptName } from '../../shared/conceptName.js';
import { displayUseCase, lensOptions } from '../../shared/format.js';
import CodePicker from './CodePicker.jsx';
import { ChoiceField, EditingNotice, FormGroup, SelectField, TextAreaField, TextField } from './FormFields.jsx';
import {
  HARMS,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  MAX_SUMMARY,
  SOURCE_TYPES,
  changedIncidentId,
  incidentProblems,
  incidentRecord,
  incidentSeverity
} from './records.js';

const SCOPES = [
  { value: 'codes', label: 'Conditions' },
  { value: 'chapter', label: 'A whole chapter' }
];

const SEVERITY_TEXT = {
  serious: 'The atlas’s Safety view marks the named conditions Serious: the incident is open and harm occurred or could have, or it is a developer notice or recall.',
  caution: 'The atlas’s Safety view marks the named conditions Caution: an open incident without harm, or a mitigated one.'
};

/** How the atlas will mark the incident, as the maintainer fills it in. */
function SeverityLine({ form }) {
  if (!form.status || (form.status === 'open' && !form.harm && form.incidentType !== 'developer_notice_or_recall')) {
    return <p className="severity-line muted">Choose the harm and status to see how the atlas marks it.</p>;
  }
  const severity = incidentSeverity(form);
  if (!severity) {
    return <p className="severity-line">A closed incident is listed on the card but not marked on the atlas.</p>;
  }
  return (
    <p className="severity-line" aria-live="polite">
      <StatusLabel status={severity} toned />
      <span>{SEVERITY_TEXT[severity]}</span>
    </p>
  );
}

/**
 * An ID other than the form's own (from an older form state): it may name a
 * stored incident, and publishing would replace it. When the stored IDs are
 * known the note says whether it does. Edit in the list of stored incidents
 * is the way to change one (it fills in every stored value).
 */
function ChangingNotice({ incidentId, isStored = null }) {
  return (
    <p className="admin-notice is-caution changing-notice" role="note">
      <Icon name="warning" size={20} className="admin-notice-icon" />
      <span>
        <strong>
          {isStored ? `${incidentId} is a stored incident: publishing replaces it` : `If ${incidentId} is stored, publishing replaces it`}
        </strong>{' '}
        with this form, field by field. To change a stored incident, choose Edit in the list above: it fills in every stored value.
      </span>
    </p>
  );
}

/**
 * "Report one safety incident": one incident in the
 * template's fields, staged as a records upload (always a merge) and then
 * checked like any file. The form state lives with the page, so it stays
 * filled while the maintainer fixes what the check finds.
 *
 * @param {object} props
 * @param {object} props.form state from emptyIncident()
 * @param {(next: object) => void} props.onChange
 * @param {object[]} props.models live registry (listModels().models)
 * @param {object|null} props.meta getMeta() (axes, chapters)
 * @param {(records: object[]) => void} props.onSubmit
 * @param {boolean} props.isBusy
 * @param {() => void} props.onReset a fresh form
 * @param {string[]|null} [props.storedIds] every stored incident's ID, once read
 */
export default function IncidentForm({ form, onChange, models, meta, onSubmit, isBusy, onReset, storedIds = null }) {
  const [showProblems, setShowProblems] = useState(false);
  const problems = useMemo(() => incidentProblems(form), [form]);
  const shown = showProblems ? problems : {};
  const set = (patch) => onChange({ ...form, ...patch });
  const model = models.find((entry) => entry.model_version === form.model) ?? null;
  const useCases = model?.use_cases.map((entry) => entry.use_case) ?? [];
  const chapters = (meta?.chapters ?? []).map((chapter) => ({ value: chapter.chapter_no, label: `${chapter.chapter_no} ${conceptName(chapter)}` }));
  const axes = meta?.axes ?? null;
  const summaryLength = form.summary.trim().length;
  const changing = changedIncidentId(form);
  const editing = Boolean(form.editing?.id) && form.incidentId === form.editing.id;

  return (
    <form
      className="record-form"
      aria-label="Report one safety incident"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (Object.keys(problems).length) {
          setShowProblems(true);
          // Focus the first field that needs an answer once its problem is drawn.
          const formNode = event.currentTarget;
          window.setTimeout(() => formNode.querySelector('[aria-invalid="true"], fieldset[aria-describedby] input')?.focus(), 0);
          return;
        }
        setShowProblems(false);
        onSubmit([incidentRecord(form)]);
      }}
    >
      {editing ? (
        <EditingNotice
          title={`Editing incident ${form.editing.id}`}
          text="The form holds every stored value. Publishing replaces the stored incident; change its Status to reopen, mitigate, or close it."
          stopLabel="Report a new incident instead"
          isBusy={isBusy}
          onStop={() => {
            setShowProblems(false);
            onReset();
          }}
        />
      ) : null}
      <FormGroup title="Card">
        <div className="form-row is-two">
          <SelectField
            label="AI system"
            value={form.model}
            options={models.map((entry) => ({ value: entry.model_version, label: entry.display_name || entry.model_version }))}
            placeholder="Choose an AI system"
            problem={shown.card && !form.model ? shown.card : null}
            onChange={(next) => {
              const nextModel = models.find((entry) => entry.model_version === next);
              const nextUseCases = nextModel?.use_cases.map((entry) => entry.use_case) ?? [];
              set({ model: next, useCase: nextUseCases.includes(form.useCase) ? form.useCase : nextModel?.default_use_case ?? nextUseCases[0] ?? '' });
            }}
          />
          <SelectField
            label="Function"
            value={form.useCase}
            options={useCases.map((useCase) => ({ value: useCase, label: displayUseCase(useCase) }))}
            placeholder="Choose a function"
            problem={shown.card && form.model && !form.useCase ? shown.card : null}
            onChange={(next) => set({ useCase: next })}
          />
        </div>
      </FormGroup>

      <FormGroup title="Where">
        <SegmentedControl size="small" label="The incident concerns" options={SCOPES} value={form.scope} onChange={(scope) => set({ scope })} />
        {form.scope === 'chapter' ? (
          <SelectField
            label="Chapter"
            value={form.chapterNo}
            options={chapters}
            placeholder="Choose a chapter"
            hint="Every condition of the chapter is marked."
            problem={shown.where ?? null}
            onChange={(chapterNo) => set({ chapterNo })}
          />
        ) : (
          <CodePicker
            label="ICD-11 codes"
            value={form.codes}
            onChange={(codes) => set({ codes })}
            hint="A subcategory counts for its top-level condition."
            problem={shown.where ?? null}
          />
        )}
      </FormGroup>

      <FormGroup title="Population">
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
      </FormGroup>

      <FormGroup title="What happened">
        <SelectField
          label="Incident type"
          value={form.incidentType}
          options={INCIDENT_TYPES}
          placeholder="Choose the type"
          problem={shown.incidentType ?? null}
          onChange={(incidentType) => set({ incidentType })}
        />
        <div className="form-row is-two">
          <ChoiceField label="Harm" value={form.harm} options={HARMS} problem={shown.harm ?? null} onChange={(harm) => set({ harm })} />
          <ChoiceField label="Status" value={form.status} options={INCIDENT_STATUSES} problem={shown.status ?? null} onChange={(status) => set({ status })} />
        </div>
        <SeverityLine form={form} />
      </FormGroup>

      <FormGroup title="Source">
        <div className="form-row is-two">
          <SelectField label="Source type" value={form.sourceType} options={SOURCE_TYPES} problem={shown.sourceType ?? null} onChange={(sourceType) => set({ sourceType })} />
          {form.sourceType === 'study' ? (
            <TextField label="Study ID" value={form.studyId} placeholder="e.g. NBR-2026-01" maxLength={64} problem={shown.studyId ?? null} onChange={(studyId) => set({ studyId })} />
          ) : null}
        </div>
        <TextField
          label="Source reference"
          value={form.sourceReference}
          placeholder="e.g. Incident report IR-2026-031 (fictional)"
          maxLength={200}
          problem={shown.sourceReference ?? null}
          onChange={(sourceReference) => set({ sourceReference })}
        />
        <div className="form-row is-two">
          <TextField label="Reported date" type="date" value={form.reportedDate} problem={shown.reportedDate ?? null} onChange={(reportedDate) => set({ reportedDate })} />
          <TextField
            label="Updated date"
            type="date"
            optional
            hint={
              editing
                ? `When the incident last changed: set it to today for this change (not before ${form.editing.lastDate}).`
                : 'When the incident last changed. Leave empty for a new report.'
            }
            value={form.updatedDate}
            problem={shown.updatedDate ?? null}
            onChange={(updatedDate) => set({ updatedDate })}
          />
        </div>
      </FormGroup>

      <FormGroup title="Summary">
        <TextAreaField
          label="What happened, in a sentence or two"
          value={form.summary}
          max={MAX_SUMMARY}
          placeholder="e.g. Synthetic example: dosing advice ignored reduced kidney function in two reviewed cases."
          hint="Synthetic and aggregate only. Never patient details or real patient data."
          problem={shown.summary ?? null}
          onChange={(summary) => set({ summary })}
        />
        <ChoiceField
          label="Recorded by"
          value={form.recordScope ?? 'public'}
          options={[
            { value: 'public', label: 'Public', hint: 'a public report' },
            { value: 'hospital', label: 'This hospital', hint: 'kept when a public release is imported' }
          ]}
          onChange={(recordScope) => set({ recordScope })}
        />
        {/* The ID is never typed: a new incident gets the next free one, a stored one keeps its own (Edit in the list). */}
        <TextField
          label="Incident ID"
          value={form.incidentId}
          maxLength={64}
          readOnly
          hint={
            editing
              ? 'The stored incident’s ID: publishing replaces that incident.'
              : 'The next free ID, given by the Data Library. To change a stored incident, use Edit in the list above.'
          }
          problem={shown.incidentId ?? null}
          className="is-narrow"
          onChange={(incidentId) => set({ incidentId })}
        />
        {changing ? <ChangingNotice incidentId={changing} isStored={storedIds ? storedIds.includes(changing) : null} /> : null}
      </FormGroup>

      <div className="button-row form-actions">
        <button type="submit" className="button-filled" disabled={isBusy || summaryLength > MAX_SUMMARY}>
          {isBusy ? 'Checking…' : editing ? 'Check this change' : 'Check this incident'}
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
          Start a new incident
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
