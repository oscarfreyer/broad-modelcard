import { useMemo, useState } from 'react';
import Icon from '../../design/Icon.jsx';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import { conceptName } from '../../shared/conceptName.js';
import { displayUseCase } from '../../shared/format.js';
import CodePicker from './CodePicker.jsx';
import { ChoiceField, EditingNotice, FormGroup, SelectField, TextAreaField, TextField } from './FormFields.jsx';
import {
  APPRAISAL_TOOLS,
  EFFECT_DIRECTIONS,
  EFFECT_JUDGEMENTS,
  EFFECT_MEASURES,
  MAX_EFFECT_NOTES,
  MAX_EFFECT_TEXT,
  MAX_EFFECT_UNIT,
  MAX_FOLLOW_UP,
  MAX_OUTCOME,
  OUTCOME_TYPES,
  RATIO_MEASURES,
  effectProblems,
  effectRecord,
  effectStudies,
  toolForStudy
} from './effects.js';
import { optionLabel } from './options.js';
import { STUDY_DESIGNS } from './studies.js';

const SCOPES = [
  { value: 'codes', label: 'Conditions' },
  { value: 'chapter', label: 'A whole chapter' }
];

/**
 * "Enter one effect" (contract v1.13, CONTRACT.md §27): one effect on an
 * outcome in the template's fields, staged as a records upload (a merge) and
 * then checked like any file. Never part of a grade.
 *
 * @param {object} props
 * @param {object} props.form state from emptyEffect()
 * @param {(next: object) => void} props.onChange
 * @param {object[]} props.models live registry (listModels().models)
 * @param {object|null} props.meta getMeta() (chapters)
 * @param {object[]|null} props.studies stored studies (listStudies), null while loading
 * @param {(records: object[]) => void} props.onSubmit
 * @param {boolean} props.isBusy
 * @param {() => void} props.onReset
 * @param {string[]|null} [props.storedIds] every stored effect's ID, once read
 */
export default function EffectForm({ form, onChange, models, meta, studies, onSubmit, isBusy, onReset, storedIds = null }) {
  const [showProblems, setShowProblems] = useState(false);
  const problems = useMemo(() => effectProblems(form, studies), [form, studies]);
  const shown = showProblems ? problems : {};
  const set = (patch) => onChange({ ...form, ...patch });
  const model = models.find((entry) => entry.model_version === form.model) ?? null;
  const useCases = model?.use_cases.map((entry) => entry.use_case) ?? [];
  const chapters = (meta?.chapters ?? []).map((chapter) => ({ value: chapter.chapter_no, label: `${chapter.chapter_no} ${conceptName(chapter)}` }));
  const editing = Boolean(form.editing?.id) && form.effectId === form.editing.id;
  const replaces = !editing && storedIds?.includes(form.effectId.trim());
  const eligible = effectStudies(studies);
  const studyOptions = eligible.map((study) => ({ value: study.study_id, label: `${study.study_id}, ${optionLabel(STUDY_DESIGNS, study.design)}` }));
  if (form.studyId && !studyOptions.some((option) => option.value === form.studyId)) {
    // While the studies load, the chosen study is named alone: whether it can carry an effect is not known yet.
    studyOptions.push({ value: form.studyId, label: studies ? `${form.studyId} (not a trial or prospective study)` : form.studyId });
  }
  const isRatio = RATIO_MEASURES.includes(form.measure);

  return (
    <form
      className="record-form"
      aria-label="Enter one effect on an outcome"
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
        onSubmit([effectRecord(form)]);
      }}
    >
      {editing ? (
        <EditingNotice
          title={`Editing effect ${form.editing.id}`}
          text="The form holds every stored value. Publishing replaces the stored effect."
          stopLabel="Enter a new effect instead"
          isBusy={isBusy}
          onStop={() => {
            setShowProblems(false);
            onReset();
          }}
        />
      ) : null}
      <p className="step-text muted">Effects are shown on the condition card and never change a grade.</p>
      <FormGroup title="Effect and study">
        <div className="form-row is-two">
          <TextField
            label="Effect ID"
            value={form.effectId}
            placeholder="e.g. EFF-2026-01"
            maxLength={64}
            readOnly={editing}
            hint={editing ? 'The stored effect’s ID: publishing replaces that effect.' : null}
            problem={shown.effectId ?? null}
            onChange={(effectId) => set({ effectId })}
          />
          <SelectField
            label="Study"
            value={form.studyId}
            options={studyOptions}
            placeholder={studies ? (eligible.length ? 'Choose the study' : 'No trial or prospective study stored yet') : 'Loading the studies…'}
            hint="A randomized trial, prospective study, or real-world deployment from Studies."
            problem={shown.studyId ?? null}
            onChange={(studyId) => set({ studyId, tool: toolForStudy(studies, studyId) || form.tool })}
          />
        </div>
        {replaces ? (
          <p className="admin-notice is-caution" role="note">
            <Icon name="warning" size={20} className="admin-notice-icon" />
            <span>
              <strong>{form.effectId.trim()} is a stored effect: publishing replaces it</strong> with this form. To change it, choose Edit in the list above.
            </span>
          </p>
        ) : null}
      </FormGroup>

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
        <SegmentedControl size="small" label="The effect concerns" options={SCOPES} value={form.scope} onChange={(scope) => set({ scope })} />
        {form.scope === 'chapter' ? (
          <SelectField
            label="Chapter"
            value={form.chapterNo}
            options={chapters}
            placeholder="Choose a chapter"
            hint="Shown on every condition of the chapter."
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

      <FormGroup title="Outcome">
        <TextField label="Outcome" value={form.outcome} placeholder="e.g. Time from arrival to first treatment" maxLength={MAX_OUTCOME} problem={shown.outcome ?? null} onChange={(outcome) => set({ outcome })} />
        <ChoiceField label="Outcome type" value={form.outcomeType} options={OUTCOME_TYPES} problem={shown.outcomeType ?? null} onChange={(outcomeType) => set({ outcomeType })} />
        <TextField
          label="Population"
          value={form.population}
          placeholder="e.g. Adults attending the emergency department (synthetic)"
          maxLength={MAX_EFFECT_TEXT}
          problem={shown.population ?? null}
          onChange={(population) => set({ population })}
        />
        <TextField
          label="Comparator"
          value={form.comparator}
          placeholder="e.g. Usual care without the AI system"
          maxLength={MAX_EFFECT_TEXT}
          problem={shown.comparator ?? null}
          onChange={(comparator) => set({ comparator })}
        />
      </FormGroup>

      <FormGroup title="Result">
        <div className="form-row is-two">
          <SelectField label="Effect measure" value={form.measure} options={EFFECT_MEASURES} placeholder="Choose the measure" problem={shown.measure ?? null} onChange={(measure) => set({ measure })} />
          <SelectField
            label="Direction of benefit"
            value={form.direction}
            options={EFFECT_DIRECTIONS}
            placeholder="Which side is better"
            problem={shown.direction ?? null}
            onChange={(direction) => set({ direction })}
          />
        </div>
        <div className="form-row is-three">
          <TextField label="Estimate" inputMode="decimal" value={form.estimate} problem={shown.estimate ?? null} onChange={(estimate) => set({ estimate })} />
          <TextField label="CI low" inputMode="decimal" value={form.ciLow} problem={shown.ciLow ?? null} onChange={(ciLow) => set({ ciLow })} />
          <TextField label="CI high" inputMode="decimal" value={form.ciHigh} problem={shown.ciHigh ?? null} onChange={(ciHigh) => set({ ciHigh })} />
        </div>
        <p className="step-text muted">
          {isRatio ? 'A ratio: 1 means no effect.' : form.measure ? 'A difference: 0 means no effect.' : 'The 95% confidence interval, AI system against comparator.'}
        </p>
        <div className="form-row is-two">
          <TextField label="Unit" optional value={form.unit} placeholder="e.g. minutes" maxLength={MAX_EFFECT_UNIT} problem={shown.unit ?? null} onChange={(unit) => set({ unit })} />
          <TextField label="Follow-up" optional value={form.followUp} placeholder="e.g. 30 days" maxLength={MAX_FOLLOW_UP} problem={shown.followUp ?? null} onChange={(followUp) => set({ followUp })} />
        </div>
      </FormGroup>

      <FormGroup title="Risk of bias">
        <ChoiceField label="Appraisal tool" value={form.tool} options={APPRAISAL_TOOLS} problem={shown.tool ?? null} onChange={(tool) => set({ tool })} />
        <ChoiceField
          label="Judgement"
          value={form.judgement}
          options={form.tool === 'rob2' ? EFFECT_JUDGEMENTS.filter((option) => option.value !== 'critical') : EFFECT_JUDGEMENTS}
          problem={shown.judgement ?? null}
          onChange={(judgement) => set({ judgement })}
        />
        <TextAreaField
          label="Notes (optional)"
          value={form.notes}
          max={MAX_EFFECT_NOTES}
          rows={2}
          placeholder="e.g. Measurement of the outcome: some concerns."
          hint="Per domain if you have them."
          problem={shown.notes ?? null}
          onChange={(notes) => set({ notes })}
        />
      </FormGroup>

      <div className="button-row form-actions">
        <button type="submit" className="button-filled" disabled={isBusy}>
          {isBusy ? 'Checking…' : editing ? 'Check this change' : 'Check this effect'}
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
          Start a new effect
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
