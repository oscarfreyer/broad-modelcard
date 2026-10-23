import { useEffect, useRef } from 'react';
import Icon from '../../design/Icon.jsx';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import { displayUseCase } from '../../shared/format.js';
import {
  HELPER_NAME,
  MAX_STUDY_BYTES,
  MAX_STUDY_CHARACTERS,
  acceptAttribute,
  acceptWords,
  describeAssistProblem,
  destinationSentence,
  fileIsAccepted,
  proposalSummary,
  proposedRecords,
  reviewProblems,
  sizeWords,
  stageRequest
} from './assist.js';
import { count, plural } from './datasets.js';
import { TextAreaField } from './FormFields.jsx';
import ProblemNotice from './ProblemNotice.jsx';
import ProposalRecord, { LeftOutItem } from './ProposalRecord.jsx';
import { FilePicker } from './UploadStep.jsx';

const NOUNS = { metrics: ['row', 'rows'], safety: ['incident', 'incidents'] };

/** Helper off: what it is, how to turn it on, and what it would send. Quiet: no filled button. */
function HelperOffNotice({ status, onSetUp }) {
  return (
    <div className="admin-notice is-info helper-off" role="note">
      <Icon name="evidence" size={20} className="admin-notice-icon" />
      <div className="admin-notice-text">
        <p className="admin-notice-title">The study helper is off</p>
        <p>
          {/* The title already says it is off; the API's how-to follows without repeating that. */}
          {String(status?.how_to_enable ?? 'Turn it on with your own API key for a hosted model, or a local model. Uploads and the forms work without it.').replace(/^The helper is off\.\s*/, '')}
        </p>
        {status?.privacy ? (
          <p className="admin-notice-detail">
            <strong>What leaves this computer once it is on: </strong>
            {status.privacy}
          </p>
        ) : null}
        <div className="button-row">
          <button type="button" className="button-tinted" onClick={onSetUp} aria-haspopup="dialog">
            Set up the helper
          </button>
        </div>
      </div>
    </div>
  );
}

/** One study in: pasted text or a file the provider can read. */
function ProposeForm({ kind, card, status, helper, onSettings }) {
  const [one, many] = NOUNS[kind];
  const accepts = status.accepts ?? [];
  const fileProblem = helper.file
    ? !fileIsAccepted(helper.file, accepts)
      ? `The ${status.provider === 'local' ? 'local' : 'hosted'} model reads ${acceptWords(accepts)} files.${status.provider === 'local' ? ' Paste the text of a PDF instead.' : ''}`
      : helper.file.size > MAX_STUDY_BYTES
        ? 'At most 10 MB. Hand the helper the part with the results.'
        : null
    : null;
  const textProblem = helper.text.length > MAX_STUDY_CHARACTERS ? `At most ${count(MAX_STUDY_CHARACTERS)} characters.` : null;
  const ready = helper.source === 'file' ? Boolean(helper.file) && !fileProblem : helper.text.trim().length > 0 && !textProblem;
  return (
    <div className="study-helper">
      <p className="step-text">
        The helper reads one study and proposes {many}
        {kind === 'metrics' && card ? ` for ${card.model}, ${displayUseCase(card.useCase)}` : ''}, each value with the words it comes from.
        You check every {one} before anything is staged, and nothing is published without the usual check, preview, and change note.
      </p>
      <SegmentedControl
        size="small"
        label="Hand over the study"
        options={[
          { value: 'text', label: 'Paste the text' },
          { value: 'file', label: 'Choose a file' }
        ]}
        value={helper.source}
        onChange={helper.setSource}
        className="entry-switch"
      />
      {helper.source === 'text' ? (
        <TextAreaField
          label="Study text"
          value={helper.text}
          onChange={helper.setText}
          max={MAX_STUDY_CHARACTERS}
          rows={8}
          problem={textProblem}
          placeholder="Paste the results section, a table, or an incident report. Synthetic or published text only."
          className="study-text"
        />
      ) : helper.file ? (
        <div className="study-file">
          <Icon name="evidence" size={22} className="study-file-icon" />
          <span className="study-file-text">
            <span className="study-file-name">{helper.file.name}</span>
            <span className="study-file-size">{sizeWords(helper.file.size)}</span>
            {fileProblem ? <span className="field-problem">{fileProblem}</span> : null}
          </span>
          <button type="button" className="button-plain" onClick={() => helper.setFile(null)} disabled={helper.busy}>
            Choose another
          </button>
        </div>
      ) : (
        <FilePicker
          tone="tinted"
          accept={acceptAttribute(accepts)}
          prompt={`Drop one study here (${acceptWords(accepts)}), or`}
          label="Choose a study"
          onFile={helper.setFile}
          disabled={helper.busy}
        />
      )}
      <div className="helper-destination">
        <p>
          {destinationSentence(status)} <span className="muted">Nothing is sent before you press Propose.</span>
        </p>
        <details className="helper-details">
          <summary>What is sent</summary>
          <p>{status.privacy}</p>
        </details>
      </div>
      {helper.problem ? <ProblemNotice error={helper.problem} describe={describeAssistProblem} onDismiss={helper.clearProblem} /> : null}
      <div className="button-row form-actions">
        <button type="button" className="button-filled" disabled={!ready || helper.busy} onClick={helper.propose}>
          {helper.busy ? 'Reading the study…' : `Propose ${many}`}
        </button>
        {helper.busy ? (
          <button type="button" className="button-plain" onClick={helper.cancel}>
            Cancel
          </button>
        ) : (
          <button type="button" className="button-plain" onClick={onSettings} aria-haspopup="dialog">
            Helper settings
          </button>
        )}
      </div>
      {helper.busy ? (
        <p className="field-hint" role="status">
          The model is reading the study. This takes up to 3 minutes; nothing is staged meanwhile.
        </p>
      ) : null}
    </div>
  );
}

/** "From “e1.txt” (text, 812 bytes), read by the hosted model claude-sonnet-5-5, 1 request" */
function provenanceLine(proposals) {
  const input = proposals.input ?? {};
  const what = input.filename ? `From “${input.filename}”` : 'From the pasted text';
  const media = { pdf: 'PDF', text: 'text', csv: 'table', xlsx: 'Excel' }[input.media] ?? input.media;
  const provider = proposals.provider === 'local' ? 'local model' : 'hosted model';
  return `${what} (${media}, ${sizeWords(input.bytes)}), read by the ${provider} ${proposals.model}, ${plural(proposals.requests ?? 0, 'request')}, checked against dataset version ${proposals.dataset_version}`;
}

/** What the helper proposed, ready to review, edit, and stage. */
function ProposalReview({ kind, card, helper, models, meta, onStage, isStaging }) {
  const { proposals, review } = helper;
  const [one, many] = NOUNS[kind];
  const records = proposedRecords(proposals);
  const { uncertainFields } = proposalSummary(proposals);
  const request = stageRequest(proposals, review, { card: kind === 'metrics' ? card : null });
  const problems = reviewProblems(proposals, review);
  const canStage = request.records.length > 0 && !problems.length && !isStaging;
  // "Propose" gives way to the proposals: the focus follows to them (S8).
  const sectionRef = useRef(null);
  useEffect(() => {
    sectionRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section ref={sectionRef} tabIndex={-1} className="proposals" aria-label={`Proposed ${many}`}>
      <dl className="figure-row">
        <div className="figure-cell">
          <dt className="figure-unit">{records.length === 1 ? `${one} proposed` : `${many} proposed`}</dt>
          <dd className="figure">{count(records.length)}</dd>
        </div>
        <div className={`figure-cell${uncertainFields ? ' is-caution' : ''}`}>
          <dt className="figure-unit">{uncertainFields === 1 ? 'field to check' : 'fields to check'}</dt>
          <dd className="figure">{count(uncertainFields)}</dd>
        </div>
        <div className="figure-cell">
          <dt className="figure-unit">left out</dt>
          <dd className="figure">{count(proposals.dropped.length)}</dd>
        </div>
      </dl>
      <p className="figure-caption">{provenanceLine(proposals)}</p>
      {proposals.input?.truncated ? (
        <p className="proposal-check helper-cut" role="note">
          <Icon name="warning" size={14} className="proposal-check-icon" />
          The helper read only the first part of this file (at most 2,000 rows, 100 columns, and 20 sheets of a table, or 200,000
          characters). Values further on were not read: hand it that part separately.
        </p>
      ) : null}

      {records.length ? (
        <ul className="proposal-list" aria-label={`Proposed ${many}`}>
          {records.map(({ id, entry }) => (
            <ProposalRecord
              key={id}
              id={id}
              kind={kind}
              entry={entry}
              kept={Boolean(review.kept[id])}
              edits={review.edits[id]}
              isEditing={Boolean(review.editing[id])}
              helper={helper}
              models={models}
              meta={meta}
            />
          ))}
        </ul>
      ) : (
        <p className="step-text">
          The helper found nothing it could propose{kind === 'metrics' && card ? ` for ${card.model}, ${displayUseCase(card.useCase)}` : ''}. Its reasons are
          below.
        </p>
      )}
      {kind === 'metrics' && records.length ? (
        <p className="field-hint">
          Fields the study does not state keep the stored row’s values, because a staged row replaces the whole row of its condition
          and group. Staged with this study’s source, those values are credited to it too, so each such row asks you to check its Source.
        </p>
      ) : null}

      {proposals.dropped.length ? (
        <>
          <h3 className="step-subtitle">Left out ({count(proposals.dropped.length)})</h3>
          <p className="step-text">The helper never guesses. These were not in the atlas, not for this card, or not allowed, so they are not proposed.</p>
          <ul className="proposal-list" aria-label="Left out">
            {proposals.dropped.map((item, index) => (
              <LeftOutItem key={index} item={item} />
            ))}
          </ul>
        </>
      ) : null}

      {proposals.notes.length ? (
        <>
          <h3 className="step-subtitle">Notes from the helper</h3>
          <ul className="helper-notes">
            {proposals.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="admin-notice is-caution helper-synthetic">
        <Icon name="shield" size={20} className="admin-notice-icon" />
        <span>{proposals.synthetic_data_notice}</span>
      </p>

      <div className="stage-row">
        <p className="step-text">
          <strong>Staging is not publishing.</strong> The kept {many} go to the check below as one update. Nothing is published until you
          review the changes and publish them with a change note.
        </p>
        {problems.length ? (
          <p className="field-problem" role="alert">
            {problems.length === 1 ? `One ${one} has` : `${problems.length} ${many} have`} values to fix before staging.
          </p>
        ) : null}
        <div className="button-row">
          <button type="button" className="button-filled" disabled={!canStage} onClick={() => onStage(request)}>
            {isStaging
              ? 'Staging…'
              : !request.records.length
                ? `Tick the ${many} to stage`
                : helper.stagedIds.length
                  ? `Stage ${plural(request.records.length, one, many)} again`
                  : `Stage ${plural(request.records.length, one, many)} as an update`}
          </button>
          <button
            type="button"
            className="button-plain"
            onClick={() => {
              helper.clear();
              // The proposals give way to the study field: the focus follows (S8).
              window.setTimeout(() => document.querySelector('.study-helper textarea, .study-helper .segment.is-active')?.focus(), 0);
            }}
            disabled={isStaging}
          >
            Start again with another study
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Step 2's "From a study": the study helper (contract v1.9, CONTRACT.md §20).
 * Off, it explains how to turn it on; on, it takes one study, shows what the
 * helper proposes with sources and flags, and stages the kept records as a
 * merge upload through `onStage`. It never publishes.
 */
export default function StudyHelper({ assist, kind, card, helper, models, meta, onStage, isStaging }) {
  const { status } = assist;
  const problemCode = helper.problem?.code;
  const reloadStatus = assist.reload;
  // The helper was turned off or changed elsewhere: show its current state.
  useEffect(() => {
    if (problemCode === 'assist_not_configured' || problemCode === 'assist_unsupported_input') reloadStatus();
  }, [problemCode, reloadStatus]);
  if (!status) {
    return (
      <p className="step-text muted" role="status">
        {assist.error ? `The ${HELPER_NAME.toLowerCase()}’s status could not be read. Uploads and the forms work without it.` : 'Reading the helper’s status…'}
      </p>
    );
  }
  if (!status.enabled) {
    return <HelperOffNotice status={status} onSetUp={assist.open} />;
  }
  if (!status.kinds?.includes(kind)) {
    return <p className="step-text muted">The helper does not propose this data set.</p>;
  }
  if (helper.proposals) {
    return <ProposalReview kind={kind} card={card} helper={helper} models={models} meta={meta} onStage={onStage} isStaging={isStaging} />;
  }
  return <ProposeForm kind={kind} card={card} status={status} helper={helper} onSettings={assist.open} />;
}
