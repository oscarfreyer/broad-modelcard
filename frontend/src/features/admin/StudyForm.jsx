import { useMemo, useState } from 'react';
import Icon from '../../design/Icon.jsx';
import { ChoiceField, EditingNotice, FormGroup, SelectField, TextAreaField, TextField } from './FormFields.jsx';
import {
  APPLICABILITY,
  GUIDELINE_FOLLOWED,
  QUALITY_TOOLS,
  SETTING_CATEGORIES,
  MAX_STUDY_NOTES,
  MAX_STUDY_TEXT,
  MAX_STUDY_TITLE,
  REPORTING_GUIDELINES,
  RISKS_OF_BIAS,
  STUDY_CONDUCTORS,
  STUDY_DESIGNS,
  STUDY_SCOPES,
  adjustmentWords,
  studyProblems,
  studyRecord
} from './studies.js';

const YES_NO = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' }
];

/**
 * "Enter one study" (contract v1.13, CONTRACT.md §22): one study record in
 * the template's fields, staged as a records upload (a merge) and then
 * checked like any file. Metric rows link to it through their Study column.
 *
 * @param {object} props
 * @param {object} props.form state from emptyStudy()
 * @param {(next: object) => void} props.onChange
 * @param {object[]} props.models live registry (listModels().models)
 * @param {object|null} props.meta getMeta() (evidence_study_adjustments)
 * @param {(records: object[]) => void} props.onSubmit
 * @param {boolean} props.isBusy
 * @param {() => void} props.onReset
 * @param {string[]|null} [props.storedIds] every stored study's ID, once read
 */
export default function StudyForm({ form, onChange, models, meta, onSubmit, isBusy, onReset, storedIds = null }) {
  const [showProblems, setShowProblems] = useState(false);
  const problems = useMemo(() => studyProblems(form), [form]);
  const shown = showProblems ? problems : {};
  const set = (patch) => onChange({ ...form, ...patch });
  const editing = Boolean(form.editing?.id) && form.studyId === form.editing.id;
  const replaces = !editing && storedIds?.includes(form.studyId.trim());
  const effect = adjustmentWords(form, meta?.evidence_study_adjustments ?? null);
  const hasGuideline = form.guideline && form.guideline !== 'none';

  return (
    <form
      className="record-form"
      aria-label="Enter one study"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (Object.keys(problems).length) {
          setShowProblems(true);
          const formNode = event.currentTarget;
          window.setTimeout(() => formNode.querySelector('[aria-invalid="true"], fieldset[aria-describedby] input')?.focus(), 0);
          return;
        }
        setShowProblems(false);
        onSubmit([studyRecord(form)]);
      }}
    >
      {editing ? (
        <EditingNotice
          title={`Editing study ${form.editing.id}`}
          text="The form holds every stored value. Publishing replaces the stored study."
          stopLabel="Enter a new study instead"
          isBusy={isBusy}
          onStop={() => {
            setShowProblems(false);
            onReset();
          }}
        />
      ) : null}
      <FormGroup title="Study">
        <div className="form-row is-two">
          <TextField
            label="Study ID"
            value={form.studyId}
            placeholder="e.g. NBR-2026-01"
            maxLength={64}
            readOnly={editing}
            hint={editing ? 'The stored study’s ID: publishing replaces that study.' : 'Metric rows link to the study when their Study column holds this ID.'}
            problem={shown.studyId ?? null}
            onChange={(studyId) => set({ studyId })}
          />
          <TextField label="Publication date" type="date" value={form.publicationDate} problem={shown.publicationDate ?? null} onChange={(publicationDate) => set({ publicationDate })} />
        </div>
        {replaces ? (
          <p className="admin-notice is-caution" role="note">
            <Icon name="warning" size={20} className="admin-notice-icon" />
            <span>
              <strong>{form.studyId.trim()} is a stored study: publishing replaces it</strong> with this form. To change it, choose Edit in the list above.
            </span>
          </p>
        ) : null}
        <TextField label="Title" value={form.title} placeholder="e.g. Northbridge multisite validation (fictional)" maxLength={MAX_STUDY_TITLE} problem={shown.title ?? null} onChange={(title) => set({ title })} />
        <div className="form-row is-two">
          <SelectField label="Design" value={form.design} options={STUDY_DESIGNS} placeholder="Choose the design" problem={shown.design ?? null} onChange={(design) => set({ design })} />
          <SelectField label="Conducted by" value={form.conductedBy} options={STUDY_CONDUCTORS} placeholder="Choose who ran it" problem={shown.conductedBy ?? null} onChange={(conductedBy) => set({ conductedBy })} />
        </div>
      </FormGroup>

      <FormGroup title="Where and whom">
        <TextField
          label="Setting"
          value={form.setting}
          placeholder="e.g. Emergency department, tertiary hospital"
          maxLength={MAX_STUDY_TEXT}
          problem={shown.setting ?? null}
          onChange={(setting) => set({ setting })}
        />
        <SelectField
          label="Setting category"
          value={form.settingCategory ?? ''}
          options={SETTING_CATEGORIES}
          placeholder="Not stated"
          optional
          onChange={(settingCategory) => set({ settingCategory })}
        />
        <div className="form-row is-three">
          <TextField label="Sites" inputMode="numeric" value={form.sites} problem={shown.sites ?? null} onChange={(sites) => set({ sites })} />
          <TextField label="Patients" inputMode="numeric" hint="Patients or cases, as a count." value={form.patients} problem={shown.patients ?? null} onChange={(patients) => set({ patients })} />
          <ChoiceField label="Peer reviewed" value={form.peerReviewed} options={YES_NO} problem={shown.peerReviewed ?? null} onChange={(peerReviewed) => set({ peerReviewed })} />
        </div>
        <TextField
          label="Population"
          value={form.population}
          placeholder="e.g. Adults with suspected sepsis (synthetic)"
          maxLength={MAX_STUDY_TEXT}
          problem={shown.population ?? null}
          onChange={(population) => set({ population })}
        />
      </FormGroup>

      <FormGroup title="Quality">
        <div className="form-row is-two">
          <SelectField
            label="Reporting guideline"
            value={form.guideline}
            options={REPORTING_GUIDELINES}
            placeholder="Choose a guideline, or None"
            problem={shown.guideline ?? null}
            onChange={(guideline) => set({ guideline, followed: guideline === 'none' ? '' : form.followed })}
          />
          {hasGuideline ? (
            <ChoiceField label="Guideline followed" value={form.followed} options={GUIDELINE_FOLLOWED} problem={shown.followed ?? null} onChange={(followed) => set({ followed })} />
          ) : null}
        </div>
        <ChoiceField label="Risk of bias" value={form.risk} options={RISKS_OF_BIAS} problem={shown.risk ?? null} onChange={(risk) => set({ risk })} />
        <TextAreaField
          label="Risk-of-bias notes (optional)"
          value={form.riskNotes}
          max={MAX_STUDY_NOTES}
          rows={2}
          placeholder="e.g. Analysis: no external test set."
          hint="Per domain if you have them, e.g. from PROBAST+AI."
          problem={shown.riskNotes ?? null}
          onChange={(riskNotes) => set({ riskNotes })}
        />
        {effect ? <p className="severity-line">{effect}</p> : null}
        {/* Contract v1.14 (§22): optional, shown with the study, never graded. */}
        <SelectField
          label="Applicability concerns"
          value={form.applicability ?? ''}
          options={APPLICABILITY}
          placeholder="Not stated"
          optional
          hint="How far the study’s patients, setting, and outcome differ from the intended use."
          onChange={(applicability) => set({ applicability })}
        />
        <TextAreaField
          label="Applicability notes (optional)"
          value={form.applicabilityNotes ?? ''}
          max={MAX_STUDY_NOTES}
          rows={2}
          placeholder="e.g. One unit’s patients only."
          problem={shown.applicabilityNotes ?? null}
          onChange={(applicabilityNotes) => set({ applicabilityNotes })}
        />
        <div className="form-row is-two">
          <SelectField
            label="Appraisal tool"
            value={form.qualityTool ?? ''}
            options={QUALITY_TOOLS}
            placeholder="None named"
            optional
            onChange={(qualityTool) => set({ qualityTool })}
          />
          <TextField
            label="Appraisal score"
            optional
            inputMode="decimal"
            value={form.qualityScore ?? ''}
            placeholder="0 to 100"
            hint="For a tool that scores, e.g. APPRAISE-AI."
            problem={shown.qualityScore ?? null}
            onChange={(qualityScore) => set({ qualityScore })}
          />
        </div>
        <p className="field-hint">These describe the study only. They never change a grade.</p>
      </FormGroup>

      <FormGroup title="Evaluation">
        <TextAreaField
          label="Evaluation conditions"
          value={form.conditions}
          max={MAX_STUDY_NOTES}
          rows={2}
          placeholder="e.g. Reference standard, period, data source."
          problem={shown.conditions ?? null}
          onChange={(conditions) => set({ conditions })}
        />
        <div className="form-row is-two">
          <SelectField
            label="AI system evaluated"
            value={form.model}
            options={models.map((entry) => ({ value: entry.model_version, label: entry.display_name || entry.model_version }))}
            placeholder="None named"
            optional
            onChange={(model) => set({ model })}
          />
          <TextField label="Source URL" optional type="url" value={form.sourceUrl} placeholder="https://studies.example/…" maxLength={500} problem={shown.sourceUrl ?? null} onChange={(sourceUrl) => set({ sourceUrl })} />
        </div>
        <TextField
          label="Configuration evaluated"
          optional
          value={form.configurationId ?? ''}
          placeholder="e.g. cfg-2026-03"
          maxLength={64}
          hint="The AI system’s configuration the study evaluated, as the developer names it."
          problem={shown.configurationId ?? null}
          onChange={(configurationId) => set({ configurationId })}
        />
        {/* Contract v1.13 (§26): a hospital evaluation names its local population; its local results name the study. */}
        <div className="form-row is-two">
          <ChoiceField label="Scope" value={form.scope ?? 'public'} options={STUDY_SCOPES} onChange={(scope) => set({ scope, localPopulation: scope === 'public' ? '' : form.localPopulation })} />
          {form.scope === 'hospital' ? (
            <SelectField
              label="Local population"
              value={form.localPopulation ?? ''}
              options={(meta?.populations ?? []).map((entry) => ({ value: entry.id, label: entry.name }))}
              placeholder={meta?.populations?.length ? 'Choose the population' : 'Publish a local population first'}
              problem={shown.localPopulation ?? null}
              onChange={(localPopulation) => set({ localPopulation })}
            />
          ) : null}
        </div>
      </FormGroup>

      <div className="button-row form-actions">
        <button type="submit" className="button-filled" disabled={isBusy}>
          {isBusy ? 'Checking…' : editing ? 'Check this change' : 'Check this study'}
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
          Start a new study
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
