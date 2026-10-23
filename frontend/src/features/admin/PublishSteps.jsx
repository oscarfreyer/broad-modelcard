import { useEffect, useRef, useState } from 'react';
import Icon from '../../design/Icon.jsx';
import { displayUseCase } from '../../shared/format.js';
import { recordsEntryWords } from './assist.js';
import { effectsPreviewHref, liveAtlasHref, previewHref, safetyPreviewHref } from './atlasLinks.js';
import { hasNoChanges, headline, onlySetting, shiftsByTarget } from './changeSummary.js';
import { versionSummary } from './datasets.js';
import { NamedChanges, RemovalNotice, ShiftSummary } from './ChangesStep.jsx';
import { SelectField, TextAreaField } from './FormFields.jsx';
import ProblemNotice from './ProblemNotice.jsx';
import { MAX_NOTE, modeShort, noteIsReady } from './records.js';
import Sheet from './Sheet.jsx';

function targetLabel(target) {
  if (target?.populationId) {
    return ` for ${target.populationName} (${target.populationId})${target.isLive ? '' : ', a new local population'}`;
  }
  return target ? ` for ${target.model}, ${displayUseCase(target.useCase)}` : '';
}

/**
 * Where a preview opens: the card of a metrics or multimorbidity update, the
 * chosen card of a safety update, and for studies (contract v1.13) the
 * Evidence view of the card whose conditions shift most.
 */
function previewLink(dataset, upload, target, changes) {
  if (dataset.kind === 'safety') return safetyPreviewHref(upload, { target, changes });
  if (dataset.kind === 'effects') return effectsPreviewHref(upload, { target, changes });
  if (dataset.kind === 'studies') {
    return previewHref(upload, { kind: dataset.kind, target: shiftsByTarget(changes)[0]?.target ?? null, view: 'evidence' });
  }
  // A metrics or local results update of one care setting only (contract v1.14) opens at that setting.
  return previewHref(upload, { kind: dataset.kind, target, setting: onlySetting(changes) });
}

/**
 * The change note every publish and restore carries (contract v1.7, X3):
 * required on this page, at most 500 characters, stored on the version and
 * shown in History.
 */
export function ChangeNoteField({ value, onChange, placeholder, label = 'Change note' }) {
  return (
    <TextAreaField
      label={label}
      value={value}
      onChange={onChange}
      max={MAX_NOTE}
      rows={2}
      placeholder={placeholder}
      hint={noteIsReady(value) ? 'Shown with this version in History.' : 'Required: say why, in a sentence. It is shown with this version in History.'}
      className="note-field"
      isRequired
    />
  );
}

/** A card picker for the safety preview: which card the Safety view opens on. */
function PreviewCardPicker({ models, card, onChange }) {
  const model = models.find((entry) => entry.model_version === card?.model) ?? models[0];
  return (
    <div className="form-row is-two preview-card">
      <SelectField
        label="Open the Safety view of"
        value={card?.model ?? ''}
        options={models.map((entry) => ({ value: entry.model_version, label: entry.display_name || entry.model_version }))}
        onChange={(next) => {
          const nextModel = models.find((entry) => entry.model_version === next);
          onChange({ model: next, useCase: nextModel?.default_use_case ?? nextModel?.use_cases[0]?.use_case ?? '' });
        }}
      />
      <SelectField
        label="Function"
        value={card?.useCase ?? ''}
        options={(model?.use_cases ?? []).map((entry) => ({ value: entry.use_case, label: displayUseCase(entry.use_case) }))}
        onChange={(useCase) => onChange({ model: card.model, useCase })}
      />
    </div>
  );
}

/**
 * Preview on atlas: recommended, never forced. A safety update opens the
 * atlas's Safety view on one card: a form entry at the condition and
 * population of its incident; a file names no single card, so the maintainer
 * picks it and the preview opens that card's overview.
 */
export function PreviewStep({ dataset, target, upload, changes = null, models = [], onTargetChange = null }) {
  const isSafety = dataset.kind === 'safety';
  return (
    <>
      <p className="step-text">
        {isSafety
          ? 'See the incidents on the atlas’s Safety view before anyone else does. The atlas marks it as an unpublished preview. The live atlas stays as it is.'
          : dataset.needsPopulation
            ? 'See the atlas with this local population before anyone else does. The atlas marks it as an unpublished preview and rings every condition whose result differs from the default prevalence. The live atlas stays as it is.'
            : 'See the update on the atlas before anyone else does. The atlas marks it as an unpublished preview and rings every condition whose result changes. The live atlas stays as it is.'}
      </p>
      {isSafety && upload.origin !== 'records' && models.length && onTargetChange ? (
        <PreviewCardPicker models={models} card={target} onChange={onTargetChange} />
      ) : null}
      <div className="button-row">
        <a className={upload.previewed ? 'button-tinted' : 'button-filled'} href={previewLink(dataset, upload, target, changes)}>
          <Icon name="preview" size={18} />
          {upload.previewed ? 'Preview again' : 'Preview on atlas'}
        </a>
      </div>
    </>
  );
}

export function PublishSheet({ dataset, target, upload, changes, nextVersion, session, onClose, onPublished }) {
  const isBusy = session.busy === 'publishing';
  const [note, setNote] = useState('');
  const canPublish = noteIsReady(note);
  const send = () =>
    session.publish(note.trim()).then((entry) => {
      if (entry) {
        onClose();
        onPublished?.(entry);
      }
    });
  return (
    <Sheet
      title={`Publish as version ${nextVersion}?`}
      onClose={onClose}
      isBusy={isBusy}
      actions={
        <>
          <button type="button" className="button-plain" disabled={isBusy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button-filled" disabled={isBusy || !canPublish} onClick={send}>
            {isBusy ? 'Publishing…' : `Publish as version ${nextVersion}`}
          </button>
        </>
      }
    >
      <p>
        {dataset.title}
        {targetLabel(dataset.needsTarget || dataset.needsPopulation ? target : null)}, {upload.origin === 'records' ? recordsEntryWords(upload) : `from “${upload.filename}”`}
        {dataset.modes?.length > 1 ? `; ${modeShort(upload.mode, dataset.kind)}` : ''}.
      </p>
      {changes ? (
        <>
          <p className="sheet-summary">{headline(changes)}</p>
          <NamedChanges changes={changes} />
          <RemovalNotice changes={changes} mode={upload.mode ?? 'replace'} />
          {!hasNoChanges(changes) ? <ShiftSummary changes={changes} kind={dataset.kind} compact /> : null}
        </>
      ) : null}
      <p>The atlas shows the new data as soon as it is published. Every earlier version stays in History and can be restored.</p>
      {!upload.previewed && !(changes && hasNoChanges(changes)) ? (
        <p className="admin-notice is-caution">
          <Icon name="preview" size={20} className="admin-notice-icon" />
          <span>
            <strong>Not previewed yet.</strong> <a href={previewLink(dataset, upload, target, changes)}>Preview on atlas</a> first
            to see the changes in place.
          </span>
        </p>
      ) : null}
      <ChangeNoteField
        value={note}
        onChange={setNote}
        placeholder={dataset.kind === 'safety' ? 'e.g. Adds the open incident from incident report IR-2026-031.' : 'e.g. Results of the Northbridge validation study for three conditions.'}
      />
      <ProblemNotice error={session.problem} onRetry={session.problem?.code === 'publish_in_progress' && canPublish ? send : null} />
    </Sheet>
  );
}

/** How a staged update is named in a sentence: its file, or how it was entered. */
export function updateName(upload) {
  if (!upload) return 'the update';
  return upload.origin === 'records' ? `the update ${recordsEntryWords(upload)}` : `“${upload.filename}”`;
}

/**
 * Discard the staged update, at any stage of its check (M1): a plain button,
 * then an inline confirmation in the error voice. The confirmation takes the
 * focus; Keep gives it back. While the request runs the Discard button stays
 * focusable (aria-disabled, so a failure leaves the focus on it beside the
 * page's error notice); after a discard the page announces that the live
 * data did not change and moves the focus to step 2 (DatasetPage).
 */
export function DiscardUpdate({ upload, session, label = 'Discard this update', explain = true }) {
  const [isConfirming, setIsConfirming] = useState(false);
  const confirmRef = useRef(null);
  const triggerRef = useRef(null);
  const returnFocus = useRef(false);
  // Any running request (a discard, a fixed file uploading, a publish) holds the button.
  const isBusy = Boolean(session.busy);
  const isDiscarding = session.busy === 'discarding';
  // The failure line belongs to a discard tried here, not to any other problem on the page.
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    if (isConfirming) {
      confirmRef.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [isConfirming]);
  if (!isConfirming) {
    return (
      <button ref={triggerRef} type="button" className="button-plain" onClick={() => setIsConfirming(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="discard-confirm" role="group" aria-label="Discard this update?">
      <span>
        Discard {updateName(upload)}?{explain ? ' The live data stays as it is.' : ''}
      </span>
      <button
        ref={confirmRef}
        type="button"
        className="button-plain is-destructive"
        aria-disabled={isBusy || undefined}
        onClick={() => {
          if (isBusy) return;
          setAttempted(true);
          session.discard();
        }}
      >
        {isDiscarding ? 'Discarding…' : 'Discard'}
      </button>
      <button
        type="button"
        className="button-plain"
        onClick={() => {
          returnFocus.current = true;
          setAttempted(false);
          setIsConfirming(false);
        }}
      >
        Keep
      </button>
      {attempted && session.problem && !isBusy ? <span className="discard-failed">Not discarded: the notice at the top of the page says why.</span> : null}
    </span>
  );
}

/** Publish: the confirmation sheet, and discarding the update instead. */
export function PublishStep({ dataset, target, upload, changes, nextVersion, session, onPublished }) {
  const [isConfirming, setIsConfirming] = useState(false);
  return (
    <>
      <p className="step-text">
        Publishing makes this the live data as version {nextVersion}. {upload.previewed ? 'You have previewed it on the atlas.' : 'It has not been previewed on the atlas yet.'}
      </p>
      <div className="button-row">
        <button
          type="button"
          className={upload.previewed ? 'button-filled' : 'button-tinted'}
          onClick={() => {
            session.clearProblem();
            setIsConfirming(true);
          }}
        >
          Publish as version {nextVersion}…
        </button>
        <DiscardUpdate upload={upload} session={session} />
      </div>
      {isConfirming ? (
        <PublishSheet
          dataset={dataset}
          target={target}
          upload={upload}
          changes={changes}
          nextVersion={nextVersion}
          session={session}
          onClose={() => setIsConfirming(false)}
          onPublished={onPublished}
        />
      ) : null}
    </>
  );
}

export function RestoreSheet({ published, previousVersion, dataset, session, onClose }) {
  const isBusy = session.busy === 'rolling-back';
  const [note, setNote] = useState('');
  const canRestore = noteIsReady(note);
  return (
    <Sheet
      title={`Restore version ${previousVersion} as version ${published.version_id + 1}?`}
      onClose={onClose}
      isBusy={isBusy}
      actions={
        <>
          <button type="button" className="button-plain" disabled={isBusy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button-filled"
            disabled={isBusy || !canRestore}
            onClick={async () => {
              if (await session.rollback(previousVersion, note.trim())) {
                onClose();
              }
            }}
          >
            {isBusy ? 'Restoring…' : `Restore as version ${published.version_id + 1}`}
          </button>
        </>
      }
    >
      <p>
        {dataset.title} goes back to the data of version {previousVersion}, published as version {published.version_id + 1}. Version{' '}
        {published.version_id} stays in History, so you can restore it later.
      </p>
      <div className="restore-undone">
        <p className="sheet-summary">This takes back version {published.version_id}:</p>
        <ul className="restore-undone-list">
          <li>{versionSummary(published.summary)}</li>
        </ul>
      </div>
      <ChangeNoteField label="Why restore?" value={note} onChange={setNote} placeholder="e.g. The incident was entered on the wrong card." />
      <ProblemNotice error={session.problem} />
    </Sheet>
  );
}

/** After a publish: where to look, and the way back (restore the version before it). */
export function PublishedCard({ dataset, target, published, rolledBack, session }) {
  const [isRestoring, setIsRestoring] = useState(false);
  const previousVersion = published.version_id - 1;
  // The button that led here is gone after a publish or rollback; focus the result instead.
  const titleRef = useRef(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [published.version_id, rolledBack?.version_id]);
  return (
    <section className="admin-card result-card" aria-live="polite">
      <p className="result-glyph" aria-hidden="true">
        <Icon name={rolledBack ? 'undo' : 'check'} size={22} />
      </p>
      {rolledBack ? (
        <>
          <h2 ref={titleRef} tabIndex={-1} className="admin-card-title">Restored: version {rolledBack.version_id} is live</h2>
          <p className="admin-card-text">
            {dataset.title} has the data of version {rolledBack.rollback_of} again. Version {published.version_id} stays in History.
          </p>
          {rolledBack.note ? <p className="version-note"><span className="version-note-label">Note:</span> {rolledBack.note}</p> : null}
        </>
      ) : (
        <>
          <h2 ref={titleRef} tabIndex={-1} className="admin-card-title">Published as version {published.version_id}</h2>
          <p className="admin-card-text">
            {session.publishedChanges ? headline(session.publishedChanges) : versionSummary(published.summary)} The atlas shows it now
            {published.previewed ? '' : '; it was not previewed first'}.
          </p>
          {published.note ? <p className="version-note"><span className="version-note-label">Note:</span> {published.note}</p> : null}
        </>
      )}
      <div className="button-row">
        <a className="button-filled" href={liveAtlasHref(dataset.kind, target)}>
          View on atlas
        </a>
        {!rolledBack && previousVersion ? (
          <button type="button" className="button-plain" onClick={() => setIsRestoring(true)}>
            <Icon name="undo" size={18} />
            Restore version {previousVersion}
          </button>
        ) : null}
      </div>
      {isRestoring ? (
        <RestoreSheet published={published} previousVersion={previousVersion} dataset={dataset} session={session} onClose={() => setIsRestoring(false)} />
      ) : null}
    </section>
  );
}
