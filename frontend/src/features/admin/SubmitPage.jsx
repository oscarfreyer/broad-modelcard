import { useEffect, useRef, useState } from 'react';
import HelpTip from '../../design/HelpTip.js';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import Icon from '../../design/Icon.jsx';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import { AI_TYPE_LABELS, FUNCTION_CATEGORY_LABELS, KIND_LABELS } from '../../shared/aiSystem.js';
import { displayUseCase } from '../../shared/format.js';
import { focusPageTitle } from './focus.js';
import { FileButton, SelectField, TextAreaField, TextField } from './FormFields.jsx';
import ModelCardInput from './ModelCardInput.jsx';
import EvaluationInput from './EvaluationInput.jsx';
import ProblemNotice from './ProblemNotice.jsx';
import RegistryEntryFields from './RegistryEntryFields.jsx';
import StepCard from './StepCard.jsx';
import SubmissionParts from './SubmissionParts.jsx';
import { PART_WORDS, SUBMISSION_STATUS_WORDS, isChecking, systemName } from './submissions.js';
import { emptySubmitForm, problemSummary, runSubmission, submissionParts, submissionTarget, submitProblems } from './submitForm.js';
import { dateTime } from './datasets.js';

const options = (labels) => Object.entries(labels).map(([value, label]) => ({ value, label }));

/** One optional file of the submission: a button named for its file, the file chosen, and its template. */
function FileField({ label, chooseLabel, hint, file, onChange, templateUrl }) {
  return (
    <div className="field file-field">
      <span className="field-label">
        {label} <span className="field-optional">(optional)</span>
      </span>
      <span className="file-field-row">
        <FileButton label={file ? `Choose another ${chooseLabel} file…` : `Choose the ${chooseLabel} file…`} accept=".csv,.xlsx" onFile={(next) => next && onChange(next)} />
        {file ? <span className="file-field-name">{file.name}</span> : null}
        {templateUrl ? (
          <a className="button-plain" href={templateUrl} download>
            <Icon name="download" size={16} />
            Template<span className="visually-hidden"> for the {chooseLabel} file</span>
          </a>
        ) : null}
      </span>
      <p className="field-hint">{hint}</p>
    </div>
  );
}

/**
 * Developer submission (CONTRACT.md §26): one guided form for
 * an AI system's entry, its narrow model card, study records, and performance
 * metrics. Submitting opens a submission and stages each part in it; nothing
 * is published until a custodian accepts it. A part that fails to send leaves
 * the submission open: Submit again sends the rest into the same one.
 */
export default function SubmitPage({ models, workspace }) {
  const client = useDataClient();
  const [form, setForm] = useState(() => emptySubmitForm(workspace?.name));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [showProblems, setShowProblems] = useState(false);
  const [submission, setSubmission] = useState(null);
  // A submission a failed attempt left open, and its parts as the server holds them.
  const [opened, setOpened] = useState(null);
  const [openedParts, setOpenedParts] = useState(null);
  const [earlier, setEarlier] = useState(null);
  const formRef = useRef(null);
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const systems = models ?? [];
  const chosen = systems.find((entry) => entry.model_version === form.existing) ?? null;
  const { modelVersion, useCase } = submissionTarget(form, systems);
  const problems = submitProblems(form);
  const shown = showProblems ? problems : {};
  const reopens = Boolean(opened) && opened.modelVersion === modelVersion;

  useEffect(() => {
    let cancelled = false;
    client.listSubmissions({}).then(
      (list) => !cancelled && setEarlier(list),
      () => !cancelled && setEarlier([])
    );
    return () => {
      cancelled = true;
    };
  }, [client, submission?.submission_id]);

  // Follow the parts' checks until they are done; a reply after "New submission" is dropped.
  useEffect(() => {
    if (!submission || !isChecking(submission)) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await client.getSubmission({ submissionId: submission.submission_id });
        if (!cancelled) setSubmission(next);
      } catch (error) {
        if (!cancelled) setProblem(error);
      }
    }, 700);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, submission]);

  const submit = async () => {
    if (Object.keys(problems).length) {
      setShowProblems(true);
      // The first field that needs an answer, else the line that says a part is missing.
      window.setTimeout(() => formRef.current?.querySelector('[aria-invalid="true"], .submit-problem')?.focus(), 0);
      return;
    }
    setShowProblems(false);
    setBusy(true);
    setProblem(null);
    const outcome = await runSubmission(client, form, { opened, systems });
    if (outcome.error) {
      setOpened(outcome.opened);
      setProblem(outcome.error);
      // Show what the submission holds so far, so the developer knows what Submit sends again.
      if (outcome.opened) {
        try {
          setOpenedParts((await client.getSubmission({ submissionId: outcome.opened.submissionId })).uploads);
        } catch {
          setOpenedParts(null);
        }
      }
      setBusy(false);
      return;
    }
    try {
      setSubmission(await client.getSubmission({ submissionId: outcome.opened.submissionId }));
      setOpened(null);
      setOpenedParts(null);
      focusPageTitle();
    } catch (error) {
      setOpened(outcome.opened);
      setProblem(error);
    } finally {
      setBusy(false);
    }
  };

  if (submission) {
    const checking = isChecking(submission);
    const failing = submission.uploads.some((upload) => upload.status === 'invalid');
    const name = systemName(submission.model_version, systems, form.system === 'new' ? form.displayName.trim() : null);
    return (
      <div className="admin-page">
        <header className="admin-page-header">
          <h1 className="admin-title" tabIndex={-1}>
            Submitted for review
          </h1>
          <p className="admin-subtitle">
            {name}, by {submission.developer_name}, {dateTime(submission.created_at)}
          </p>
        </header>
        <section className="admin-card result-card" aria-live="polite">
          <p className="result-glyph" aria-hidden="true">
            <Icon name={failing ? 'warning' : 'check'} size={22} />
          </p>
          <h2 className="admin-card-title">{checking ? 'Checking your parts…' : failing ? 'Some parts need a fix' : 'Waiting for a custodian'}</h2>
          <p className="admin-card-text">
            {failing
              ? 'A custodian cannot accept a submission while a part needs a fix. Start a new submission with the corrected file.'
              : 'Nothing is published yet. A custodian reviews it in Custodian review and accepts it or returns it with a note.'}
          </p>
          <SubmissionParts uploads={submission.uploads} systemName={(version) => (version === submission.model_version ? name : systemName(version, systems))} />
          <div className="form-actions button-row">
            <button
              type="button"
              className="button-tinted"
              onClick={() => {
                setSubmission(null);
                setForm(emptySubmitForm(form.developerName));
                focusPageTitle();
              }}
            >
              New submission
            </button>
          </div>
        </section>
      </div>
    );
  }

  const willSend = submissionParts(form);
  return (
    <div className="admin-page" ref={formRef}>
      <header className="admin-page-header">
        <div className="page-title-row">
          <h1 className="admin-title" tabIndex={-1}>
            Submit an AI system
          </h1>
          <HelpTip label="About this page">
            <p>For review by a custodian. Nothing here is published until they accept it.</p>
          </HelpTip>
        </div>
      </header>
      {problem ? <ProblemNotice error={problem} onDismiss={() => setProblem(null)} /> : null}
      {reopens ? (
        <div className="admin-notice is-info" role="status">
          <Icon name="info" size={20} className="admin-notice-icon" />
          <div className="admin-notice-text">
            <p className="admin-notice-title">Your submission is open, but not every part was sent.</p>
            <p>
              Submit again to send {willSend.filter((part) => !opened.sent[part]).map((part) => PART_WORDS[part]).join(', ') || 'the changed parts'} into the same submission. Already
              sent:
            </p>
            {openedParts ? <SubmissionParts uploads={openedParts} systemName={(version) => systemName(version, systems, version === modelVersion ? form.displayName.trim() : null)} /> : null}
          </div>
        </div>
      ) : null}
      <ol className="step-list" aria-label="Submission">
        <li>
          <StepCard number={1} state="current" title="AI system" summary={modelVersion ? `${modelVersion}, ${displayUseCase(useCase)}` : null} defaultOpen>
            <div className="record-form">
              <TextField
                label="Your name or organisation"
                required
                value={form.developerName}
                maxLength={80}
                placeholder="e.g. Tidewell Analytics (fictional)"
                problem={shown.developerName ?? (form.developerName ? problems.developerName ?? null : null)}
                onChange={(developerName) => set({ developerName })}
              />
              <SegmentedControl
                label="AI system"
                options={[
                  { value: 'new', label: 'A new AI system' },
                  { value: 'existing', label: 'One already listed' }
                ]}
                value={form.system}
                onChange={(system) => set({ system })}
                size="small"
              />
              {form.system === 'existing' ? (
                <div className="form-row is-two">
                  <SelectField
                    label="AI system"
                    value={form.existing}
                    options={systems.map((entry) => ({ value: entry.model_version, label: entry.display_name || entry.model_version }))}
                    placeholder="Choose the AI system"
                    problem={shown.existing ?? null}
                    onChange={(existing) => set({ existing, existingFunction: '' })}
                  />
                  {chosen ? (
                    <SelectField
                      label="Function of the performance metrics"
                      value={useCase}
                      options={chosen.use_cases.map((entry) => ({ value: entry.use_case, label: displayUseCase(entry.use_case) }))}
                      onChange={(existingFunction) => set({ existingFunction })}
                    />
                  ) : null}
                </div>
              ) : (
                <>
                  <div className="form-row is-two">
                    <TextField
                      label="Model version"
                      required
                      value={form.modelVersion}
                      maxLength={64}
                      placeholder="e.g. Tidewell-Sepsis-1.0"
                      problem={shown.modelVersion ?? (form.modelVersion ? problems.modelVersion ?? null : null)}
                      onChange={(next) => set({ modelVersion: next })}
                    />
                    <TextField label="Display name" required value={form.displayName} maxLength={200} placeholder="e.g. Tidewell Sepsis 1.0" problem={shown.displayName ?? null} onChange={(displayName) => set({ displayName })} />
                  </div>
                  <div className="form-row is-two">
                    <TextField label="Function" required value={form.useCase} maxLength={120} placeholder="e.g. Sepsis early warning" problem={shown.useCase ?? null} onChange={(next) => set({ useCase: next })} />
                    <SelectField label="Function category" optional value={form.category} options={options(FUNCTION_CATEGORY_LABELS)} placeholder="Not given" onChange={(category) => set({ category })} />
                  </div>
                  <div className="form-row is-two">
                    <SelectField label="Kind" value={form.kind} options={options(KIND_LABELS)} onChange={(kind) => set({ kind })} />
                    <SelectField label="AI type" optional value={form.aiType} options={options(AI_TYPE_LABELS)} placeholder="Not given" onChange={(aiType) => set({ aiType })} />
                  </div>
                  <TextField label="Developer organisation" optional value={form.organisation} maxLength={200} placeholder="Fictional names only" onChange={(organisation) => set({ organisation })} />
                  <TextAreaField label="Description" value={form.description} max={280} rows={2} onChange={(description) => set({ description })} />
                  <TextAreaField label="Declared intended purpose" value={form.purpose} max={500} rows={2} hint="Shown as declared by the developer, never as checked." onChange={(purpose) => set({ purpose })} />
                  {/* Contract v1.14 (§28): optional; a filled field is checked as the registry upload checks it. */}
                  <RegistryEntryFields
                    entry={form.entry}
                    onChange={(patch) => set({ entry: { ...form.entry, ...patch } })}
                    problems={problems}
                    systems={systems}
                    modelVersion={form.modelVersion}
                  />
                </>
              )}
            </div>
          </StepCard>
        </li>
        <li>
          <StepCard number={2} state="ready" title="Narrow model card" summary={form.card.content.trim() ? `${form.card.format === 'json' ? 'JSON' : 'Markdown'} card added` : 'Optional'} defaultOpen>
            <p className="step-text">Your own model card of this AI system. Readers see it under About this AI system; results with ICD-11 codes can become proposed performance metrics for the custodian.</p>
            <ModelCardInput value={form.card} onChange={(card) => set({ card })} modelVersion={modelVersion} />
          </StepCard>
        </li>
        <li>
          <StepCard number={3} state="ready" title="Studies and performance metrics" summary={[form.studiesFile?.name, form.resultsFile?.name].filter(Boolean).join(', ') || 'Optional'} defaultOpen>
            <div className="record-form">
              <FileField
                label="Studies"
                chooseLabel="studies"
                file={form.studiesFile}
                onChange={(studiesFile) => set({ studiesFile })}
                templateUrl={client.getTemplateUrl({ kind: 'studies', format: 'xlsx' })}
                hint="One row per study: design, setting, guideline, risk of bias. Added to the studies, never replacing them."
              />
              <FileField
                label={`Performance metrics${useCase ? ` for ${displayUseCase(useCase)}` : ''}`}
                chooseLabel="performance metrics"
                file={form.resultsFile}
                onChange={(resultsFile) => set({ resultsFile })}
                templateUrl={client.getTemplateUrl({ kind: 'metrics', format: 'xlsx' })}
                hint={form.system === 'new' ? 'The performance metrics of the new card. Conditions you leave out read No data.' : 'Only the rows you change; each needs Source, Study, and Source date.'}
              />
            </div>
          </StepCard>
        </li>
        <li>
          <StepCard
            number={4}
            state="ready"
            title="Evaluation results"
            summary={form.evaluation.content.trim() ? `${form.evaluation.filename ?? 'JSON'} added` : 'Optional'}
            defaultOpen={false}
          >
            <p className="step-text">
              The output of a benchmark or evaluation harness you ran, as JSON. The custodian sees the benchmark study and the results it proposes, and stages
              what they accept as records of this submission.
            </p>
            <EvaluationInput value={form.evaluation} onChange={(evaluation) => set({ evaluation })} card={{ modelVersion, useCase }} />
          </StepCard>
        </li>
        <li>
          <StepCard number={5} state={Object.keys(problems).length ? 'waiting' : 'current'} title="Submit" summary={null} defaultOpen>
            <TextAreaField label="Note to the custodian" value={form.note} max={500} rows={2} placeholder="e.g. New system; the study is under review." onChange={(note) => set({ note })} />
            <p className="step-text muted">Aggregate synthetic data only. Never patient-level or real patient data.</p>
            <div className="form-actions button-row">
              <button type="button" className="button-filled" disabled={busy} onClick={submit}>
                <Icon name="upload" size={18} />
                {busy ? 'Submitting…' : reopens ? 'Submit the rest' : 'Submit for review'}
              </button>
            </div>
            {showProblems && Object.keys(problems).length ? (
              <p className="field-problem submit-problem" role="alert" tabIndex={-1}>
                {problemSummary(problems)}
              </p>
            ) : null}
          </StepCard>
        </li>
      </ol>
      {earlier?.length ? (
        <section className="admin-card" aria-labelledby="earlier-title">
          <h2 id="earlier-title" className="admin-card-title">Submissions</h2>
          <ul className="admin-list">
            {earlier.slice(0, 6).map((entry) => (
              <li key={entry.submission_id} className="admin-row">
                <span className="admin-row-main">
                  <span className="admin-row-title">{systemName(entry.model_version, systems)}</span>
                  <span className="admin-row-text">
                    {entry.developer_name}, {dateTime(entry.created_at)}, {SUBMISSION_STATUS_WORDS[entry.status]}
                    {entry.custodian_note ? `: “${entry.custodian_note}”` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
