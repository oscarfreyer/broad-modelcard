import { useMemo, useState } from 'react';
import HelpTip from '../../design/HelpTip.js';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import Icon from '../../design/Icon.jsx';
import { HISTORY_KINDS, dateTime, datasetTitle, versionSummary } from './datasets.js';
import { SelectField } from './FormFields.jsx';
import { EVERYTHING, restorePlan, runRestore } from './restore.js';
import ProblemNotice from './ProblemNotice.jsx';
import { ChangeNoteField } from './PublishSteps.jsx';
import { noteIsReady } from './records.js';
import Sheet from './Sheet.jsx';
import { publisherWords } from './workspace.js';

// Every versioned kind as a filter: a select, since eleven choices do not fit one segmented row.
const FILTERS = [{ value: 'all', label: 'All data sets' }, ...HISTORY_KINDS.map((kind) => ({ value: kind, label: datasetTitle(kind) }))];

const UNDONE_SHOWN = 4;

/**
 * The published versions a restore of `kind` to version `versionId` takes back
 * (CONTRACT.md §11, Rollback), newest first, as History lists them: the later
 * versions of the data sets that would change. Data sets that already hold
 * the data of version n again (a later restore brought it back) are left out.
 *
 * @param {{ version_id: number, kind: string|null, rollback_of?: number|null }[]} versions History, newest first
 * @param {number} versionId the version restored
 * @param {string|null} kind the chosen data set, 'all' (Everything), or null while none is chosen
 */
export function restoreUndoes(versions, versionId, kind) {
  return restorePlan(versions, versionId, kind).undone;
}

/** "AI systems & functions and Safety incidents" */
function titlesInWords(kinds) {
  const titles = kinds.map((kind) => datasetTitle(kind));
  return titles.length < 2 ? titles.join('') : `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
}

/** "versions 12 to 13" / "version 12" / "new versions" */
function versionsInWords(first, count) {
  if (!first) return count > 1 ? 'new versions' : 'a new version';
  return count > 1 ? `versions ${first} to ${first + count - 1}` : `version ${first}`;
}

/**
 * Why a restore would change nothing, in one plain sentence:
 * said before the button, which stays disabled.
 */
export function nothingToRestore(plan, choice, versionId) {
  if (choice === EVERYTHING) {
    return `Every data set already holds the data of version ${versionId}, so restoring it would change nothing.`;
  }
  const title = datasetTitle(choice);
  return plan.same.length
    ? `${title} already holds the data of version ${versionId} again (a later restore brought it back), so restoring it would change nothing. Choose Everything or another data set.`
    : `No version after ${versionId} changed ${title}, so restoring it would change nothing. Choose Everything or another data set.`;
}

function UndoneVersions({ plan, choice, versionId }) {
  if (!choice) {
    return null;
  }
  if (!plan.kinds.length) {
    return (
      <p className="restore-undone-none" role="status">
        {nothingToRestore(plan, choice, versionId)}
      </p>
    );
  }
  const shown = plan.undone.slice(0, UNDONE_SHOWN);
  const rest = plan.undone.length - shown.length;
  return (
    <div className="restore-undone">
      <p className="sheet-summary">
        This takes back {plan.undone.length === 1 ? 'one later version' : `${plan.undone.length} later versions`} of {titlesInWords(plan.kinds)}:
      </p>
      <ul className="restore-undone-list">
        {shown.map((version) => (
          <li key={version.version_id}>
            <span className="restore-undone-version tabular">Version {version.version_id}</span>{' '}
            {versionSummary(version.summary)}
            {version.note ? <span className="restore-undone-note"> Note: {version.note}</span> : null}
          </li>
        ))}
      </ul>
      {rest > 0 ? <p className="restore-undone-more">and {rest} earlier {rest === 1 ? 'version' : 'versions'}, listed in History.</p> : null}
      {plan.same.length ? (
        <p className="restore-undone-none">
          {titlesInWords(plan.same)} already {plan.same.length === 1 ? 'holds' : 'hold'} the data of version {versionId} again and {plan.same.length === 1 ? 'stays' : 'stay'} as {plan.same.length === 1 ? 'it is' : 'they are'}.
        </p>
      ) : null}
    </div>
  );
}

const CHOICES = [EVERYTHING, ...HISTORY_KINDS];

export function HistoryRestoreSheet({ entry, nextVersion, versions = [], onClose, onRestored }) {
  const client = useDataClient();
  // Everything by default: "restore version n" undoes every later change.
  const [choice, setChoice] = useState(EVERYTHING);
  const [isBusy, setIsBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [partial, setPartial] = useState([]);
  const [note, setNote] = useState('');
  const plan = useMemo(() => restorePlan(versions, entry.version_id, choice), [entry.version_id, choice, versions]);
  // Everything goes back in one version (every_kind, contract v1.11); one data set is one version too.
  const allAtOnce = choice === EVERYTHING;
  const versionCount = 1;
  const canRestore = plan.kinds.length > 0 && noteIsReady(note);
  const restore = async () => {
    setIsBusy(true);
    setProblem(null);
    const outcome = await runRestore(client, { versionId: entry.version_id, kinds: plan.kinds, note: note.trim(), allAtOnce });
    setIsBusy(false);
    if (outcome.restored.length) {
      onRestored(outcome.restored);
    }
    if (outcome.failed) {
      setPartial((done) => [...done, ...outcome.restored]);
      setProblem(outcome.failed.error);
      return;
    }
    if (!outcome.restored.length) {
      // Every data set already matched (the backend refused each restore).
      setProblem(Object.assign(new Error('Nothing to restore.'), { code: 'rollback_no_change' }));
      return;
    }
    onClose();
  };
  const label = isBusy ? 'Restoring…' : !plan.kinds.length ? 'Nothing to restore' : nextVersion ? `Restore as ${versionsInWords(nextVersion, versionCount)}` : 'Restore';
  return (
    <Sheet
      title={`Restore version ${entry.version_id}?`}
      onClose={onClose}
      isBusy={isBusy}
      actions={
        <>
          <button type="button" className="button-plain" disabled={isBusy} onClick={onClose}>
            {partial.length ? 'Close' : 'Cancel'}
          </button>
          <button type="button" className="button-filled" disabled={isBusy || !canRestore} onClick={restore}>
            {label}
          </button>
        </>
      }
    >
      <p>
        {entry.kind ? `Version ${entry.version_id} changed ${datasetTitle(entry.kind)}. ` : `Version ${entry.version_id} holds every data set. `}
        Restoring publishes its data again as a new version; Everything undoes every later change.
      </p>
      <fieldset className="radio-group restore-choice">
        <legend>What should go back to version {entry.version_id}?</legend>
        {CHOICES.map((option) => {
          const changes = option === choice ? plan.kinds.length > 0 : restorePlan(versions, entry.version_id, option).kinds.length > 0;
          return (
            <label key={option} className="radio-row">
              <input type="radio" name="restore-kind" value={option} checked={choice === option} disabled={isBusy} onChange={() => setChoice(option)} />
              <span>
                {option === EVERYTHING ? 'Everything' : datasetTitle(option)}
                {changes ? null : <span className="radio-row-detail">, nothing to restore</span>}
              </span>
            </label>
          );
        })}
      </fieldset>
      <UndoneVersions plan={plan} choice={choice} versionId={entry.version_id} />
      <p>Every version, including the live one, stays in History, so this can be restored in turn.</p>
      <ChangeNoteField label="Why restore?" value={note} onChange={setNote} placeholder="e.g. Version 9 added an incident by mistake; back to the data before it." />
      {partial.length ? (
        <p className="admin-notice is-info" role="status">
          <Icon name="check" size={20} className="admin-notice-icon" />
          <span>
            Already restored: {partial.map((version) => `version ${version.version_id} (${datasetTitle(version.kind)})`).join(', ')}. The rest stays as it
            was.
          </span>
        </p>
      ) : null}
      <ProblemNotice error={problem} onRetry={problem?.code === 'publish_in_progress' && canRestore ? restore : null} />
    </Sheet>
  );
}

/**
 * History: every published version, newest first, each with its data set,
 * what changed, the maintainer's change note (contract v1.7), and whether it
 * was previewed. Restoring an older version
 * publishes a new one; history is never deleted.
 */
export default function HistoryPage({ versions, onLibraryChange }) {
  const [filter, setFilter] = useState('all');
  const [restoring, setRestoring] = useState(null);
  const [restored, setRestored] = useState(null);
  const liveId = versions?.[0]?.version_id ?? null;
  const shown = useMemo(
    () => (versions ?? []).filter((entry) => filter === 'all' || entry.kind === filter || entry.kind === null),
    [filter, versions]
  );
  return (
    <div className="admin-page">
      <header className="admin-page-header">
        <div className="page-title-row">
          <h1 className="admin-title">History</h1>
          <HelpTip label="About this page">
            <p>Every published version, newest first. Restoring an older version publishes it again as a new version.</p>
          </HelpTip>
        </div>
      </header>
      <SelectField label="Data set" value={filter} options={FILTERS} onChange={setFilter} className="history-filter" />
      {restored?.length ? (
        <div className="admin-notice is-info" role="status">
          <Icon name="check" size={20} className="admin-notice-icon" />
          {restored.length === 1 ? (
            <span>
              Version {restored[0].version_id} is live: {versionSummary(restored[0].summary)}
            </span>
          ) : (
            <span className="admin-notice-text">
              <span>
                Versions {restored[0].version_id} to {restored[restored.length - 1].version_id} are published; version{' '}
                {restored[restored.length - 1].version_id} is live:
              </span>
              <span className="restored-list">
                {restored.map((version) => (
                  <span key={version.version_id}>
                    <span className="tabular">Version {version.version_id}</span>: {versionSummary(version.summary)}
                  </span>
                ))}
              </span>
            </span>
          )}
        </div>
      ) : null}
      {versions === null ? (
        <div className="skeleton-block" aria-busy="true" aria-label="Loading the history">
          <span className="skeleton-line is-wide" />
          <span className="skeleton-line" />
        </div>
      ) : (
        <ol className="admin-list history-list" aria-label="Versions">
          {shown.map((entry) => (
            <li key={entry.version_id} className="admin-row history-row">
              <span className="history-version">
                <span className="history-number tabular">Version {entry.version_id}</span>
                {entry.version_id === liveId ? <span className="live-chip">Live</span> : null}
              </span>
              <span className="admin-row-main">
                <span className="admin-row-title">{versionSummary(entry.summary)}</span>
                {entry.note ? <span className="version-note"><span className="version-note-label">Note:</span> {entry.note}</span> : null}
                <span className="admin-row-text">
                  {entry.kind ? datasetTitle(entry.kind) : 'All data sets'}, {dateTime(entry.published_at)}
                  {entry.upload_id ? (entry.previewed ? ', previewed on the atlas' : ', not previewed') : ''}
                  {publisherWords(entry) ? `, ${publisherWords(entry)}` : ''}
                </span>
              </span>
              {entry.version_id !== liveId ? (
                <button type="button" className="button-plain" aria-label={`Restore version ${entry.version_id}`} onClick={() => setRestoring(entry)}>
                  <Icon name="undo" size={18} />
                  Restore
                </button>
              ) : (
                <span className="history-current muted">Current</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {restoring ? (
        <HistoryRestoreSheet
          entry={restoring}
          nextVersion={liveId ? liveId + 1 : null}
          versions={versions ?? []}
          onClose={() => setRestoring(null)}
          onRestored={(results) => {
            setRestored(results);
            onLibraryChange();
            // The confirmation sits above the list; bring it into view (a restore may start far down History).
            window.scrollTo({ top: 0 });
          }}
        />
      ) : null}
    </div>
  );
}
