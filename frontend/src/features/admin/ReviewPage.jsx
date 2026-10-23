import { useCallback, useEffect, useRef, useState } from 'react';
import HelpTip from '../../design/HelpTip.js';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import Icon from '../../design/Icon.jsx';
import { previewHref } from './atlasLinks.js';
import ChangesStep from './ChangesStep.jsx';
import { headline } from './changeSummary.js';
import { DATASETS, dateTime, datasetTitle } from './datasets.js';
import { focusNode } from './focus.js';
import { ChangeNoteField } from './PublishSteps.jsx';
import EvaluationProposals from './EvaluationProposals.jsx';
import ProblemNotice from './ProblemNotice.jsx';
import Sheet from './Sheet.jsx';
import SubmissionParts from './SubmissionParts.jsx';
import { SUBMISSION_STATUS_WORDS, isChecking, submissionReady, systemName } from './submissions.js';
import { noteIsReady } from './records.js';

const DECIDED_SHOWN = 8;

function previewTarget(upload, submission) {
  const target = upload.target ?? {};
  if (target.use_case) return { model: target.model_version, useCase: target.use_case };
  return { model: target.model_version ?? submission.model_version, useCase: null };
}

/**
 * What each valid part would change (getUploadChanges), read once per part
 * while its submission is open: a headline beside the part and, on request,
 * the data set page's own change summary (ChangesStep) under it, so a
 * custodian reads the rows and status changes without leaving the queue. A
 * read that fails (anything but an abort) is kept per part, with a retry.
 */
function usePartChanges(uploads) {
  const client = useDataClient();
  const [byId, setById] = useState({});
  const [failed, setFailed] = useState({});
  const [attempt, setAttempt] = useState(0);
  // Evaluation results (contract v1.14, §32.2) change nothing themselves: no change summary to read.
  const validIds = (uploads ?? []).filter((upload) => upload.status === 'valid' && upload.kind !== 'evaluation_results').map((upload) => upload.upload_id);
  const key = validIds.join(',');
  useEffect(() => {
    const controller = new AbortController();
    key.split(',').filter(Boolean).forEach((uploadId) => {
      client.getUploadChanges({ uploadId }, { signal: controller.signal }).then(
        (changes) => {
          setById((current) => ({ ...current, [uploadId]: changes }));
          setFailed((current) => (current[uploadId] ? { ...current, [uploadId]: null } : current));
        },
        (error) => {
          if (error?.name === 'AbortError' || controller.signal.aborted) return;
          setFailed((current) => ({ ...current, [uploadId]: error }));
        }
      );
    });
    return () => controller.abort();
  }, [client, key, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { changes: byId, failed, retry };
}

function PartChangesFull({ upload, submission, changes }) {
  const dataset = DATASETS[upload.kind] ?? { kind: upload.kind, title: datasetTitle(upload.kind), shiftScope: null };
  return (
    <div className="part-changes-body">
      <ChangesStep dataset={dataset} target={previewTarget(upload, submission)} upload={upload} changes={changes} />
    </div>
  );
}

/** Proposed performance metrics of a narrow model card part, staged into the same submission on request. */
function CardProposals({ upload, submission, onStaged }) {
  const client = useDataClient();
  const [proposals, setProposals] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  useEffect(() => {
    if (upload.status !== 'valid') return undefined;
    const controller = new AbortController();
    client.getModelCardProposals({ uploadId: upload.upload_id }, { signal: controller.signal }).then(setProposals, (error) => {
      if (error?.name !== 'AbortError' && !controller.signal.aborted) setProblem(error);
    });
    return () => controller.abort();
  }, [client, upload.status, upload.upload_id]);
  if (problem) return <ProblemNotice error={problem} onDismiss={() => setProblem(null)} />;
  if (!proposals) return null;
  const count = proposals.batches.reduce((sum, batch) => sum + batch.records.length, 0);
  if (!count) return <p className="admin-row-text">The card proposes no results (none names an ICD-11 condition).</p>;
  const stage = async () => {
    setBusy(true);
    try {
      for (const batch of proposals.batches) {
        await client.createRecordsUpload({
          kind: 'metrics',
          modelVersion: batch.model_version,
          useCase: batch.use_case,
          records: batch.records,
          submissionId: submission.status === 'submitted' ? submission.submission_id : undefined,
          replaceStaged: true
        });
      }
      onStaged();
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card-proposals">
      <p className="admin-row-text">
        The card proposes {count} {count === 1 ? 'result' : 'results'} for ICD-11 conditions
        {proposals.skipped.length ? `; ${proposals.skipped.length} skipped` : ''}. Staged as performance metrics, they are checked like any other part.
      </p>
      <button type="button" className="button-tinted" disabled={busy} onClick={stage}>
        {busy ? 'Staging…' : 'Stage as performance metrics'}
      </button>
    </div>
  );
}

/** The records an evaluation results part proposes (contract v1.14, §32.2), staged into the same submission on request. */
function EvaluationPart({ upload, submission, systemName, onStaged }) {
  const client = useDataClient();
  const [proposals, setProposals] = useState(null);
  const [problem, setProblem] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    client.getEvaluationProposals({ uploadId: upload.upload_id }, { signal: controller.signal }).then(setProposals, (error) => {
      if (error?.name !== 'AbortError' && !controller.signal.aborted) setProblem(error);
    });
    return () => controller.abort();
  }, [client, upload.upload_id]);
  if (problem) return <ProblemNotice error={problem} onDismiss={() => setProblem(null)} />;
  if (!proposals) return <p className="admin-row-text">Reading the proposed records…</p>;
  return (
    <div className="part-changes-body">
      <EvaluationProposals proposals={proposals} submissionId={submission.submission_id} systemName={systemName} onStaged={onStaged} />
    </div>
  );
}

/** "Return this submission?": returning discards every part, so it is confirmed first. */
function ReturnSheet({ name, parts, isBusy, onClose, onReturn }) {
  return (
    <Sheet
      title="Return this submission?"
      onClose={onClose}
      isBusy={isBusy}
      actions={
        <>
          <button type="button" className="button-plain" disabled={isBusy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button-filled is-destructive" disabled={isBusy} onClick={onReturn}>
            {isBusy ? 'Returning…' : 'Return with note'}
          </button>
        </>
      }
    >
      <p>
        {name}: {parts === 1 ? 'its one part is' : `its ${parts} parts are`} discarded and nothing is published. The developer sees your note and can submit again.
      </p>
    </Sheet>
  );
}

/**
 * Custodian review (CONTRACT.md §26): the queue of developer
 * submissions; each opens with its parts' checks and change summaries,
 * previews on the atlas, then Accept (publishes every part, one version
 * each, with the note) or Return with a note.
 */
export default function ReviewPage({ models = null, workspace, onLibraryChange }) {
  const client = useDataClient();
  const [list, setList] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [open, setOpen] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const [result, setResult] = useState(null);
  const [shownChanges, setShownChanges] = useState(null);
  const [isConfirmingReturn, setIsConfirmingReturn] = useState(false);
  // Accept and Return act only on the submission chosen in the queue, never on one still shown while another loads.
  const shown = open?.submission_id === openId ? open : null;
  const parts = usePartChanges(shown?.uploads);
  // The live registry's display name; a new AI system keeps its model version here: reading its
  // staged entry would be a staged read, which marks the part previewed (CONTRACT.md §2).
  const name = shown ? systemName(shown.model_version, models) : '';
  const resultRef = useRef(null);

  const reload = useCallback(async () => {
    try {
      const all = await client.listSubmissions({});
      setList(all);
      setOpenId((current) => current ?? all.find((entry) => entry.status === 'submitted')?.submission_id ?? null);
    } catch (error) {
      setProblem(error);
    }
  }, [client]);
  useEffect(() => {
    reload();
  }, [reload]);

  // A note, an open change summary, or a confirmation belongs to one submission.
  useEffect(() => {
    setNote('');
    setShownChanges(null);
    setIsConfirmingReturn(false);
  }, [openId]);

  useEffect(() => {
    if (!openId) {
      setOpen(null);
      return undefined;
    }
    let cancelled = false;
    let timer = null;
    const load = async () => {
      try {
        const next = await client.getSubmission({ submissionId: openId });
        if (cancelled) return;
        setOpen(next);
        if (isChecking(next)) timer = window.setTimeout(load, 700);
      } catch (error) {
        if (!cancelled) setProblem(error);
      }
    };
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, openId, result]);

  // After Accept or Return the buttons are gone: the focus moves to the line that says what happened.
  useEffect(() => {
    if (result?.action === 'accept' || result?.action === 'return') focusNode(resultRef.current);
  }, [result]);

  const decide = async (action) => {
    if (!shown) return;
    setBusy(action);
    setProblem(null);
    try {
      const call = action === 'accept' ? client.acceptSubmission : client.returnSubmission;
      const decided = await call({ submissionId: shown.submission_id, note: note.trim(), publisherName: workspace?.name || undefined });
      setIsConfirmingReturn(false);
      setResult({ action, submission: decided });
      setNote('');
      setOpen(decided);
      await reload();
      onLibraryChange?.();
    } catch (error) {
      setIsConfirmingReturn(false);
      setProblem(error);
    } finally {
      setBusy(null);
    }
  };

  const waiting = (list ?? []).filter((entry) => entry.status === 'submitted');
  const decidedAll = (list ?? []).filter((entry) => entry.status !== 'submitted');
  const decided = decidedAll.slice(0, DECIDED_SHOWN);
  const ready = submissionReady(shown);

  const row = (entry) => (
    <li key={entry.submission_id}>
      <button
        type="button"
        className={`admin-row queue-row${entry.submission_id === openId ? ' is-current' : ''}`}
        aria-current={entry.submission_id === openId ? 'true' : undefined}
        onClick={() => {
          setOpenId(entry.submission_id);
          setResult(null);
        }}
      >
        <span className="admin-row-main">
          <span className="admin-row-title">{systemName(entry.model_version, models)}</span>
          <span className="admin-row-text">
            {entry.developer_name}, {dateTime(entry.created_at)}, {entry.uploads.length} {entry.uploads.length === 1 ? 'part' : 'parts'}
          </span>
        </span>
        <span className={`queue-status is-${entry.status}`}>{SUBMISSION_STATUS_WORDS[entry.status]}</span>
      </button>
    </li>
  );

  return (
    <div className="admin-page">
      <header className="admin-page-header">
        <div className="page-title-row">
          <h1 className="admin-title">Submissions</h1>
          <HelpTip label="About this page">
            <p>Nothing a developer submits is published until you accept it.</p>
          </HelpTip>
        </div>
        <p className="admin-subtitle">{list ? `${waiting.length} waiting for review` : 'Loading…'}</p>
      </header>
      {problem ? <ProblemNotice error={problem} onDismiss={() => setProblem(null)} /> : null}

      <section className="admin-card" aria-labelledby="queue-title">
        <h2 id="queue-title" className="admin-card-title">Waiting</h2>
        {waiting.length ? <ul className="admin-list queue-list">{waiting.map(row)}</ul> : <p className="admin-card-text muted">No submission is waiting.</p>}
        {decided.length ? (
          <details className="queue-decided">
            <summary>Decided ({decidedAll.length})</summary>
            {decidedAll.length > DECIDED_SHOWN ? <p className="admin-card-text muted">The {DECIDED_SHOWN} most recent.</p> : null}
            <ul className="admin-list queue-list">{decided.map(row)}</ul>
          </details>
        ) : null}
      </section>

      {openId && !shown ? (
        <div className="skeleton-block" aria-busy="true" aria-label="Loading the submission">
          <span className="skeleton-line is-wide" />
          <span className="skeleton-line" />
        </div>
      ) : null}

      {shown ? (
        <section className="admin-card review-card" aria-labelledby="review-title">
          <h2 id="review-title" className="admin-card-title">
            {name} <span className={`queue-status is-${shown.status}`}>{SUBMISSION_STATUS_WORDS[shown.status]}</span>
          </h2>
          <p className="admin-card-text">
            {name !== shown.model_version ? `${shown.model_version}. ` : ''}Submitted by {shown.developer_name}, {dateTime(shown.created_at)}.
            {shown.note ? <> Note: “{shown.note}”</> : null}
          </p>
          {shown.custodian_note ? (
            <p className="version-note">
              <span className="version-note-label">{shown.status === 'accepted' ? 'Accepted' : 'Returned'}:</span> {shown.custodian_note}
              {shown.decided_by ? ` (${shown.decided_by})` : ''}
              {shown.published_versions.length ? `, versions ${shown.published_versions.join(', ')}` : ''}
            </p>
          ) : null}
          <SubmissionParts
            uploads={shown.uploads}
            systemName={(modelVersion) => (modelVersion === shown.model_version ? name : systemName(modelVersion, models))}
            below={(upload) =>
              upload.kind === 'evaluation_results' && upload.status === 'valid' && shown.status === 'submitted'
                ? {
                    id: `changes-${upload.upload_id}`,
                    shown: shownChanges === upload.upload_id,
                    content: (
                      <EvaluationPart
                        upload={upload}
                        submission={shown}
                        systemName={(modelVersion) => (modelVersion === shown.model_version ? name : systemName(modelVersion, models))}
                        onStaged={() => setResult({ action: 'staged', submission: shown })}
                      />
                    )
                  }
                : parts.changes[upload.upload_id]
                ? {
                    id: `changes-${upload.upload_id}`,
                    shown: shownChanges === upload.upload_id,
                    content: <PartChangesFull upload={upload} submission={shown} changes={parts.changes[upload.upload_id]} />
                  }
                : null
            }
            actions={(upload) =>
              upload.kind === 'evaluation_results' ? (
                upload.status === 'valid' && shown.status === 'submitted' ? (
                  <div className="part-actions">
                    <span className="part-changes">Publishes nothing itself</span>
                    <button
                      type="button"
                      className="button-plain"
                      aria-expanded={shownChanges === upload.upload_id}
                      aria-controls={`changes-${upload.upload_id}`}
                      onClick={() => setShownChanges((current) => (current === upload.upload_id ? null : upload.upload_id))}
                    >
                      <Icon name={shownChanges === upload.upload_id ? 'chevronUp' : 'chevronDown'} size={16} />
                      {shownChanges === upload.upload_id ? 'Hide the proposed records' : 'Show the proposed records'}
                    </button>
                  </div>
                ) : null
              ) : upload.status === 'valid' ? (
                <div className="part-actions">
                  {parts.changes[upload.upload_id] ? (
                    <>
                      <span className="part-changes">{headline(parts.changes[upload.upload_id])}</span>
                      <button
                        type="button"
                        className="button-plain"
                        aria-expanded={shownChanges === upload.upload_id}
                        aria-controls={`changes-${upload.upload_id}`}
                        onClick={() => setShownChanges((current) => (current === upload.upload_id ? null : upload.upload_id))}
                      >
                        <Icon name={shownChanges === upload.upload_id ? 'chevronUp' : 'chevronDown'} size={16} />
                        {shownChanges === upload.upload_id ? 'Hide the changes' : 'Show the changes'}
                      </button>
                    </>
                  ) : parts.failed[upload.upload_id] ? (
                    <>
                      <span className="part-changes">Could not read the changes</span>
                      <button type="button" className="button-plain" onClick={parts.retry}>
                        <Icon name="retry" size={16} />
                        Try again
                      </button>
                    </>
                  ) : null}
                  <a className="button-plain" href={previewHref(upload, { kind: upload.kind, target: previewTarget(upload, shown) })}>
                    <Icon name="preview" size={16} />
                    Preview
                  </a>
                  {upload.kind === 'model_cards' && shown.status === 'submitted' ? (
                    <CardProposals upload={upload} submission={shown} onStaged={() => setResult({ action: 'staged', submission: shown })} />
                  ) : null}
                </div>
              ) : null
            }
          />
          {shown.status === 'submitted' ? (
            <div className="review-decision">
              <ChangeNoteField
                label="Note to the developer"
                value={note}
                onChange={setNote}
                placeholder="e.g. Checked against the study record; published."
              />
              <p className="field-hint">
                Accepting publishes every part, one version each, as Custodian review{workspace?.name ? ` by ${workspace.name}` : ''}. Returning discards the parts.
              </p>
              <div className="form-actions button-row">
                <button type="button" className="button-filled" disabled={!ready || !noteIsReady(note) || Boolean(busy)} onClick={() => decide('accept')}>
                  <Icon name="check" size={18} />
                  {busy === 'accept' ? 'Publishing…' : 'Accept and publish'}
                </button>
                <button type="button" className="button-plain is-destructive" disabled={!noteIsReady(note) || Boolean(busy)} onClick={() => setIsConfirmingReturn(true)}>
                  <Icon name="undo" size={18} />
                  Return with note
                </button>
                {!ready ? <span className="field-hint">{isChecking(shown) ? 'Checking the parts…' : 'Every part must pass its check first.'}</span> : null}
              </div>
            </div>
          ) : null}
          {result?.action === 'accept' && result.submission.submission_id === shown.submission_id ? (
            <p className="admin-notice is-info" role="status" ref={resultRef}>
              <Icon name="check" size={20} className="admin-notice-icon" />
              <span>Published as versions {result.submission.published_versions.join(', ')}.</span>
            </p>
          ) : null}
          {result?.action === 'return' && result.submission.submission_id === shown.submission_id ? (
            <p className="admin-notice is-info" role="status" ref={resultRef}>
              <Icon name="check" size={20} className="admin-notice-icon" />
              <span>Returned to the developer with your note. Its parts were discarded; nothing was published.</span>
            </p>
          ) : null}
        </section>
      ) : null}
      {isConfirmingReturn && shown ? (
        <ReturnSheet
          name={name}
          parts={shown.uploads.length}
          isBusy={busy === 'return'}
          onClose={() => setIsConfirmingReturn(false)}
          onReturn={() => decide('return')}
        />
      ) : null}
    </div>
  );
}

