import { useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import Icon from '../../design/Icon.jsx';
import { count, plural } from './datasets.js';
import { DiscardUpdate } from './PublishSteps.jsx';
import { FilePicker } from './UploadStep.jsx';

const SHOWN_EXAMPLES = 5;

/**
 * The examples of one problem group. Rows are named as the spreadsheet
 * numbers them; for a form entry (a records upload, contract v1.7) the field
 * is named instead, and the record only when there are several.
 */
function ExampleTable({ group, fromForm, recordCount }) {
  const [showAll, setShowAll] = useState(false);
  const examples = showAll ? group.examples : group.examples.slice(0, SHOWN_EXAMPLES);
  const hasColumn = group.examples.some((example) => example.column);
  const hasValue = group.examples.some((example) => example.value != null && example.value !== '');
  const showRow = !fromForm || recordCount > 1;
  return (
    <>
      <table className="issue-table">
        <thead>
          <tr>
            {showRow ? <th scope="col">{fromForm ? 'Record' : 'Row'}</th> : null}
            {hasColumn ? <th scope="col">{fromForm ? 'Field' : 'Column'}</th> : null}
            {hasValue ? <th scope="col">Value</th> : null}
            <th scope="col">Problem</th>
          </tr>
        </thead>
        <tbody>
          {examples.map((example, index) => (
            <tr key={`${example.row}-${example.column}-${index}`}>
              {showRow ? (
                <td className="tabular">{example.row === 0 ? 'Whole file' : fromForm ? count((example.record ?? example.row - 2) + 1) : count(example.row)}</td>
              ) : null}
              {hasColumn ? <td>{example.column ?? ''}</td> : null}
              {hasValue ? <td className="issue-value">{example.value ?? ''}</td> : null}
              <td>{example.problem}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {group.examples.length > SHOWN_EXAMPLES ? (
        <button type="button" className="button-plain issue-more" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer examples' : `Show all ${group.examples.length} examples`}
        </button>
      ) : null}
      {group.count > group.examples.length ? (
        <p className="issue-footnote">The marked file lists all {count(group.count)}.</p>
      ) : null}
    </>
  );
}

/** Problems that break the aggregate-only rule (CONTRACT.md §21): named as such, above the backend's message. */
const AGGREGATE_ONLY_CODES = Object.freeze(['patient_level_data']);

/** Such a file is deleted right after its check, so no marked copy is offered (CONTRACT.md §21). */
const isPatientLevelReport = (report) => (report?.errors ?? []).some((group) => AGGREGATE_ONLY_CODES.includes(group.code));

function IssueGroup({ group, isNote, fromForm = false, recordCount = 0 }) {
  const { message, fix } = group;
  const isPatientLevel = AGGREGATE_ONLY_CODES.includes(group.code);
  return (
    <li className={`issue-group${isNote ? ' is-note' : ''}${isPatientLevel ? ' is-patient-level' : ''}`}>
      {isPatientLevel ? (
        <p className="issue-rule">
          <Icon name="shield" size={16} />
          Aggregate data only: this looks like patient-level data, which must never be uploaded.
        </p>
      ) : null}
      <div className="issue-head">
        <span className={`issue-count${isNote ? ' is-note' : ''}`}>{count(group.count)} found</span>
        <p className="issue-message">{message}</p>
      </div>
      <p className="issue-fix">
        <span className="issue-fix-label">How to fix: </span>
        {fix}
      </p>
      {group.examples?.length ? <ExampleTable group={group} fromForm={fromForm} recordCount={recordCount} /> : null}
    </li>
  );
}

function MarkedFileLinks({ uploadId }) {
  const client = useDataClient();
  return (
    <p className="marked-files">
      <Icon name="sheet" size={20} className="admin-row-icon" />
      <span>Your file with each problem marked in a Problems column:</span>
      <a className="button-plain" href={client.getAnnotatedUploadUrl({ uploadId, format: 'xlsx' })} download>
        Excel
      </a>
      <a className="button-plain" href={client.getAnnotatedUploadUrl({ uploadId, format: 'csv' })} download>
        CSV
      </a>
    </p>
  );
}

/** Progress of the check (0–1) as a bar with a percentage. */
function CheckProgress({ upload }) {
  const percent = Math.round((upload.progress ?? 0) * 100);
  return (
    <div className="check-progress">
      <div className="progress" role="progressbar" aria-label={`Checking ${upload.filename}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className="progress-fill" style={{ transform: `scaleX(${Math.max(2, percent) / 100})` }} />
      </div>
      <p className="step-text" aria-live="polite">
        {upload.origin === 'records' ? 'Checking what you entered' : `Checking “${upload.filename}”`}: <span className="tabular">{percent}%</span>.
        Every row is checked against the rules of the atlas{upload.origin === 'records' ? '.' : '; a complete metrics file takes up to 30 seconds.'}
      </p>
    </div>
  );
}

/**
 * Where a form entry with problems is fixed. The form keeps what was entered
 * only while the page holds it; after a reload it is empty, so the step says
 * so and offers to start the form again (refilled when this tab remembers the
 * entry).
 *
 * @param {{ state: 'kept'|'empty'|'lost'|'lostSaved'|'helper'|'helperLost', onRestart: () => void }|null} formEntry
 */
function FormFixText({ formEntry }) {
  const state = formEntry?.state ?? 'kept';
  if (state === 'helper') {
    return (
      <p className="step-text">
        The staged proposals cannot be published yet. Fix the values named below in the helper’s proposals above (they are still
        there; records are counted in the order they were staged), then stage them again.
      </p>
    );
  }
  if (state === 'helperLost') {
    return (
      <>
        <p className="step-text">
          The staged proposals cannot be published yet, and the helper’s proposals are gone from this page (it was reloaded, or
          they were cleared). Propose again from the study, or enter the update with the form, with the fixes named below.
        </p>
        <div className="button-row">
          <button type="button" className="button-tinted" onClick={formEntry.onRestart}>
            Open the study helper
          </button>
        </div>
      </>
    );
  }
  if (state === 'kept') {
    return (
      <p className="step-text">
        What you entered cannot be published yet. Fix the fields named below in the form above (it keeps what you entered),
        then check again.
      </p>
    );
  }
  if (state === 'empty') {
    return (
      <p className="step-text">
        What you entered cannot be published yet. Enter the record again in the form above with the fixes named below, then
        check again.
      </p>
    );
  }
  return (
    <>
      <p className="step-text">
        What you entered cannot be published yet. The page was reloaded since, so the form no longer holds it.{' '}
        {state === 'lostSaved'
          ? 'Start the form again with what you entered, fix the fields named below, and check again.'
          : 'Start the form again, enter the record with the fixes named below, and check again.'}
      </p>
      <div className="button-row">
        <button type="button" className="button-tinted" onClick={formEntry.onRestart}>
          Start the form again
        </button>
      </div>
    </>
  );
}

/** The way out of an update that is still being checked or cannot be published (M1). */
function CheckDiscard({ upload, session, text }) {
  return (
    <div className="check-discard">
      <p className="step-text">{text}</p>
      <div className="button-row">
        <DiscardUpdate upload={upload} session={session} explain={false} />
      </div>
    </div>
  );
}

/**
 * Check: progress while the backend reads every row, then either the
 * problems to fix (grouped, with spreadsheet row numbers and the marked file)
 * or a clean result with any notes. An update that is being checked or
 * needs a fix can be discarded here; a clean one is discarded in Publish.
 *
 * @param {object} props
 * @param {object} props.session useStagedUpload()
 * @param {{ state: string, onRestart: () => void }|null} [props.formEntry] a form entry's form state (records uploads)
 */
export default function CheckStep({ session, formEntry = null }) {
  const { upload } = session;
  if (!upload) {
    return null;
  }
  const discardText = DISCARD_TEXT[upload.status === 'invalid' && upload.origin === 'records' ? 'form' : upload.status];
  // One discard control at a fixed place, kept per upload, so its confirmation
  // (and the focus in it) survives the check finishing while it is open.
  return (
    <>
      <CheckResult session={session} formEntry={formEntry} />
      {discardText ? <CheckDiscard key={upload.upload_id} upload={upload} session={session} text={discardText} /> : null}
    </>
  );
}

const DISCARD_TEXT = Object.freeze({
  checking: 'Wrong file? Discard it and upload another; the live data stays as it is.',
  form: 'Not fixing it now? Discard what you entered; the live data stays as it is.',
  invalid: 'Not fixing it now? Discard this file; the live data stays as it is.'
});

/** What the check found, by status; a status the page does not know shows nothing. */
function CheckResult({ session, formEntry }) {
  const { upload, busy } = session;
  if (upload.status === 'checking') {
    return <CheckProgress upload={upload} />;
  }
  const report = upload.report ?? { row_count: 0, errors: [], notes: [] };
  const problemCount = report.errors.reduce((sum, group) => sum + group.count, 0);
  const fromForm = upload.origin === 'records';
  const groupProps = { fromForm, recordCount: report.row_count };
  if (upload.status === 'invalid' && fromForm) {
    return (
      <>
        <div className="check-result is-fix">
          <p className="figure-line">
            <span className="figure">{count(problemCount)}</span>
            <span className="figure-unit">{problemCount === 1 ? 'problem' : 'problems'}</span>
          </p>
          <FormFixText formEntry={formEntry} />
        </div>
        <ul className="issue-list" aria-label="Problems">
          {report.errors.map((group) => (
            <IssueGroup key={group.code} group={group} {...groupProps} />
          ))}
        </ul>
        {report.notes.length ? (
          <>
            <h3 className="step-subtitle">Notes (they do not block publishing)</h3>
            <ul className="issue-list" aria-label="Notes">
              {report.notes.map((group) => (
                <IssueGroup key={group.code} group={group} isNote {...groupProps} />
              ))}
            </ul>
          </>
        ) : null}
      </>
    );
  }
  if (upload.status === 'invalid') {
    return (
      <>
        <div className="check-result is-fix">
          <p className="figure-line">
            <span className="figure">{count(problemCount)}</span>
            <span className="figure-unit">{problemCount === 1 ? 'problem' : 'problems'}</span>
          </p>
          <p className="step-text">
            “{upload.filename}” cannot be published yet ({plural(report.row_count, 'row')} read). Fix these in your spreadsheet,
            save it, and upload the fixed file. Row numbers are the spreadsheet’s own.
          </p>
        </div>
        {isPatientLevelReport(report) ? (
          <p className="step-text">
            The file was deleted right after the check because it looked like patient-level data, so no marked copy is kept.
            Fix your own copy and upload it again.
          </p>
        ) : (
          <MarkedFileLinks uploadId={upload.upload_id} />
        )}
        <ul className="issue-list" aria-label="Problems">
          {report.errors.map((group) => (
            <IssueGroup key={group.code} group={group} />
          ))}
        </ul>
        {report.notes.length ? (
          <>
            <h3 className="step-subtitle">Notes (they do not block publishing)</h3>
            <ul className="issue-list" aria-label="Notes">
              {report.notes.map((group) => (
                <IssueGroup key={group.code} group={group} isNote />
              ))}
            </ul>
          </>
        ) : null}
        <h3 className="step-subtitle">Upload the fixed file</h3>
        <FilePicker disabled={busy === 'uploading'} label={busy === 'uploading' ? 'Uploading…' : 'Choose the fixed file'} onFile={(file) => session.send({ file, mode: upload.mode ?? 'replace' }, true)} />
      </>
    );
  }
  if (upload.status !== 'valid') {
    return null;
  }
  return (
    <>
      <div className="check-result">
        <p className="step-text">
          <strong>No problems found</strong>{' '}
          {fromForm ? `in what you entered (${plural(report.row_count, 'record')})` : `in ${plural(report.row_count, 'row')} of “${upload.filename}”`}.
          {report.notes.length ? ' The notes below do not block publishing.' : ''}
        </p>
      </div>
      {report.notes.length ? (
        <>
          {fromForm ? null : <MarkedFileLinks uploadId={upload.upload_id} />}
          <ul className="issue-list" aria-label="Notes">
            {report.notes.map((group) => (
              <IssueGroup key={group.code} group={group} isNote {...groupProps} />
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
