import { useId, useRef, useState } from 'react';
import Icon from '../../design/Icon.jsx';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import { recordsEntryWords } from './assist.js';
import { dateTime } from './datasets.js';
import { MODE_WORDS } from './records.js';

const ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const STATUS_WORDS = {
  checking: 'being checked',
  invalid: 'has problems to fix',
  valid: 'ready to publish'
};

const RECORD_WORDS = {
  incident: { tab: 'Report one incident', what: 'this incident' },
  metricRow: { tab: 'Enter one row', what: 'this row' },
  study: { tab: 'Enter one study', what: 'this study' },
  effect: { tab: 'Enter one effect', what: 'this effect' }
};

const ENTRY_WORDS = {
  records: (upload) => recordsEntryWords(upload).replace(/^./, (letter) => letter.toUpperCase()),
  file: (upload) => `“${upload.filename}”, uploaded`
};

/** The rule that applies to every upload, in the caution voice. */
function PatientDataNotice() {
  return (
    <p className="admin-notice is-caution">
      <Icon name="shield" size={20} className="admin-notice-icon" />
      <span>
        <strong>Never upload patient data.</strong> Files and forms may hold aggregate, synthetic demonstration data only: no
        patient-level records and no real patient data.
      </span>
    </p>
  );
}

/**
 * A drop zone with a file button (CSV or Excel unless `accept` and `prompt`
 * say otherwise). Files dropped or chosen go to `onFile`; the parent decides
 * whether they replace a waiting update.
 */
export function FilePicker({ onFile, disabled, label = 'Choose a file', tone = 'filled', accept = ACCEPT, prompt = 'Drop a CSV or Excel file here, or' }) {
  const inputRef = useRef(null);
  const [isOver, setIsOver] = useState(false);
  const take = (files) => {
    const file = files?.[0];
    if (file && !disabled) {
      onFile(file);
    }
  };
  return (
    <div
      className={`drop-zone${isOver ? ' is-over' : ''}${disabled ? ' is-disabled' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setIsOver(false);
        take(event.dataTransfer?.files);
      }}
    >
      <Icon name="upload" size={28} className="drop-zone-icon" />
      <p className="drop-zone-text">{prompt}</p>
      <button type="button" className={`button-${tone}`} disabled={disabled} onClick={() => inputRef.current?.click()}>
        {label}
      </button>
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept={accept}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          take(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
}

/**
 * "How should this file change the data?" (contract v1.7, CONTRACT.md §11.2):
 * add or change rows (merge), or replace the whole data set. Each choice
 * says in one sentence what happens to the rows the file does not name.
 */
function ModeChoice({ dataset, mode, onChange, disabled = false }) {
  const name = useId();
  if (!dataset.modes || dataset.modes.length < 2) {
    return null;
  }
  const text = {
    merge: dataset.mergeHelp,
    replace: dataset.replaceHelp
  };
  return (
    <fieldset className="mode-choice" disabled={disabled}>
      <legend className="step-subtitle">How should this file change the data?</legend>
      {dataset.modes.map((option) => (
        <label key={option} className={`mode-option${mode === option ? ' is-chosen' : ''}`}>
          <input type="radio" name={name} value={option} checked={mode === option} onChange={() => onChange(option)} />
          <span className="mode-option-text">
            <span className="mode-option-title">{MODE_WORDS[option].title}</span>
            <span className="mode-option-help">{text[option]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function ReplacePrompt({ session }) {
  const { upload, pendingReplace, busy } = session;
  const existing = pendingReplace.existing ?? upload;
  const incoming = pendingReplace.fromHelper
    ? 'the helper’s proposals'
    : pendingReplace.records
      ? 'what you entered in the form'
      : `“${pendingReplace.file.name}”`;
  return (
    <div className="replace-prompt" role="alert">
      <p className="replace-prompt-title">Replace the update that is waiting?</p>
      <p className="step-text">
        {existing ? `“${existing.filename}” is waiting (${STATUS_WORDS[existing.status] ?? existing.status}). ` : 'Another update is waiting for this data set. '}
        Only one update per data set can wait at a time. Replacing it keeps the live data as it is.
      </p>
      <div className="button-row">
        <button type="button" className="button-filled" disabled={busy === 'uploading'} onClick={() => session.send(pendingReplace, true)}>
          Replace with {incoming}
        </button>
        <button type="button" className="button-plain" onClick={session.cancelReplace}>
          Keep the waiting update
        </button>
      </div>
    </div>
  );
}

/**
 * Enter the update: the one-record form (where the data set has one) or a
 * file, with the merge-or-replace choice; the file that is waiting; and the
 * replace prompt when a new update arrives while one is staged.
 *
 * @param {object} props
 * @param {object} props.dataset
 * @param {object} props.session useStagedUpload()
 * @param {string|null} props.disabledReason
 * @param {'replace'|'merge'} props.mode the file's mode
 * @param {(mode: string) => void} props.onModeChange
 * @param {'record'|'study'|'file'} props.entry
 * @param {(entry: string) => void} props.onEntryChange
 * @param {React.ReactNode} [props.recordForm] the data set's one-record form
 * @param {React.ReactNode} [props.studyHelper] the study helper ("From a study"), where the data set has a form
 */
export default function UploadStep({ dataset, session, disabledReason, mode, onModeChange, entry, onEntryChange, recordForm = null, studyHelper = null }) {
  const { upload, pendingReplace, busy } = session;
  if (pendingReplace) {
    return <ReplacePrompt session={session} />;
  }
  const words = RECORD_WORDS[dataset.recordForm] ?? null;
  const hasForm = Boolean(words && recordForm);
  const showForm = hasForm && entry === 'record';
  const showHelper = hasForm && Boolean(studyHelper) && entry === 'study';
  return (
    <>
      <PatientDataNotice />
      {upload ? (
        <p className="step-text">
          {ENTRY_WORDS[upload.origin === 'records' ? 'records' : 'file'](upload)} {dateTime(upload.created_at)},{' '}
          {STATUS_WORDS[upload.status] ?? upload.status}. A new {hasForm ? 'entry or file' : 'file'} replaces it.
        </p>
      ) : null}
      {disabledReason ? <p className="step-text muted">{disabledReason}</p> : null}
      {hasForm ? (
        <SegmentedControl
          size="small"
          label="Enter the update"
          options={[
            { value: 'record', label: words.tab },
            ...(studyHelper ? [{ value: 'study', label: 'From a study' }] : []),
            { value: 'file', label: 'Upload a file' }
          ]}
          value={entry}
          onChange={onEntryChange}
          className="entry-switch"
        />
      ) : null}
      {showForm ? (
        recordForm
      ) : showHelper ? (
        studyHelper
      ) : (
        <>
          <ModeChoice dataset={dataset} mode={mode} onChange={onModeChange} disabled={Boolean(disabledReason)} />
          <FilePicker
            disabled={Boolean(disabledReason) || busy === 'uploading'}
            label={busy === 'uploading' ? 'Uploading…' : upload ? 'Choose a new file' : 'Choose a file'}
            onFile={(file) => session.send({ file, mode }, false)}
          />
        </>
      )}
    </>
  );
}
