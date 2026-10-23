import Icon from '../../design/Icon.jsx';
import StatusMark from '../../design/StatusMark.js';
import { isHelperEntry } from './assist.js';
import { previewHref } from './atlasLinks.js';
import { hasNoChanges, moreRows, namedRows, removals, rowNoun, settingChanges, shiftTotal, shiftsByTarget, shiftsByView, statusWord } from './changeSummary.js';
import { count } from './datasets.js';

const ROW_FIGURES = ['changed', 'added', 'removed', 'unchanged'];

function NameList({ title, names }) {
  if (!names?.length) {
    return null;
  }
  return (
    <div className="change-names">
      <p className="change-names-title">{title}</p>
      <p>{names.join(', ')}</p>
    </div>
  );
}

const NAMED_KINDS = [
  { key: 'changed', title: 'Changed' },
  { key: 'added', title: 'Added' }
];

/**
 * The rows behind the counts, by name (contract v1.4 `rows.samples`): up to
 * five per kind, then "and N more". Removed rows are named in the removal
 * notice. Registry uploads list their AI systems and cards instead.
 */
export function NamedChanges({ changes }) {
  if (changes?.kind === 'models') {
    return null;
  }
  const lists = NAMED_KINDS.map((kind) => ({ ...kind, named: namedRows(changes, kind.key) })).filter((kind) => kind.named);
  // Rows of specific care settings (contract v1.14, §29), counted per setting.
  const bySetting = settingChanges(changes);
  if (!lists.length && !bySetting.length) {
    return null;
  }
  return (
    <div className="named-changes">
      {bySetting.length ? (
        <div className="change-names">
          <p className="change-names-title">By care setting</p>
          <ul className="named-list">
            {bySetting.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {lists.map(({ key, title, named }) => (
        <div key={key} className="change-names">
          <p className="change-names-title">{title}</p>
          <ul className="named-list">
            {named.names.map((name) => (
              <li key={name}>{name}</li>
            ))}
            {named.more ? <li className="muted">and {moreRows(named.more, changes.kind)}</li> : null}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** What publishing deletes, in the caution voice (nothing when nothing is removed). */
export function RemovalNotice({ changes, mode = 'replace' }) {
  const removed = removals(changes, { mode });
  if (!removed.length) {
    return null;
  }
  const [, many] = rowNoun(changes);
  return (
    <div className="admin-notice is-caution" role="note">
      <Icon name="warning" size={20} className="admin-notice-icon" />
      <div className="admin-notice-text">
        <p className="admin-notice-title">This update removes data</p>
        {removed.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p>
          {mode === 'merge'
            ? `Only the ${many} marked Remove leave; everything else stays.`
            : `${many[0].toUpperCase()}${many.slice(1)} missing from the file leave the live data when you publish.`}{' '}
          Every earlier version can be restored from History.
        </p>
      </div>
    </div>
  );
}

/**
 * Condition status changes grouped by metric view, each as "Moderate → Weak"
 * with real status dots. With `preview`, every row links to a condition in
 * the preview; the compact form (confirmation sheet) has no links.
 */
function ShiftList({ changes, preview = null, compact = false }) {
  const groups = shiftsByView(changes);
  return (
    <div className={`shift-groups${compact ? ' is-compact' : ''}`}>
      {groups.map((group) => (
        <section key={group.viewId} className="shift-group" aria-label={group.label}>
          <h4 className={`shift-view tint-${group.viewId}`}>
            <Icon name={group.viewId} size={18} />
            {group.label}
          </h4>
          <ul className="admin-list">
            {group.shifts.map((shift) => (
              <li key={`${shift.from}-${shift.to}`} className="admin-row shift-row">
                <span className="shift-count tabular">{count(shift.count)}</span>
                <span className="shift-move">
                  <span className="shift-word">
                    <StatusMark status={shift.from} /> {statusWord(shift.from)}
                  </span>
                  <Icon name="chevronRight" size={16} className="shift-arrow" label="to" />
                  <span className="shift-word">
                    <StatusMark status={shift.to} /> {statusWord(shift.to)}
                  </span>
                </span>
                {preview && shift.sampleIds.length ? (
                  <a
                    className="button-plain shift-open"
                    aria-label={`Show a condition that moves from ${statusWord(shift.from)} to ${statusWord(shift.to)} on ${group.label}, in the preview`}
                    href={previewHref(preview.upload, { kind: preview.kind, target: preview.target, view: group.viewId, conceptId: shift.sampleIds[0] })}
                  >
                    Show one
                    <Icon name="chevronRight" size={16} />
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * Status shifts, split by AI system and function when one upload shifts several
 * (prevalence, and a local population against the default, CONTRACT.md §21).
 * Each card's "Show one" opens the preview on that card.
 */
export function ShiftSummary({ changes, kind, upload = null, target = null, compact = false }) {
  const groups = kind === 'prevalence' || kind === 'population' || kind === 'studies' ? shiftsByTarget(changes) : [];
  if (!groups.length) {
    return <ShiftList changes={changes} preview={upload ? { upload, kind, target } : null} compact={compact} />;
  }
  return (
    <div className={`target-groups${compact ? ' is-compact' : ''}`}>
      {groups.map((group) => (
        <section key={group.label} className="target-group" aria-label={group.label}>
          <h4 className="target-title">
            {group.label}
            <span className="target-count muted">
              {count(group.total)} {group.total === 1 ? 'change' : 'changes'}
            </span>
          </h4>
          <ShiftList changes={group.changes} preview={upload ? { upload, kind, target: group.target } : null} compact={compact} />
        </section>
      ))}
    </div>
  );
}

/**
 * Merge rows kept out because the stored row comes from a newer study
 * (contract v1.7 note `newer_study_kept`, D9): repeated here so the change
 * figures are not misread as the whole file.
 */
function NewerStudyNotice({ upload }) {
  const group = upload?.report?.notes?.find((note) => note.code === 'newer_study_kept');
  if (!group) {
    return null;
  }
  return (
    <p className="admin-notice is-info" role="note">
      <Icon name="info" size={20} className="admin-notice-icon" />
      <span>
        <strong>The newer study stays for {count(group.count)} {group.count === 1 ? 'row' : 'rows'}.</strong> They come from an older
        study than the stored data, so publishing leaves the stored values as they are. The Check step names them.
      </span>
    </p>
  );
}

/**
 * Changes: what publishing would do, in two units. Spreadsheet rows as big
 * counts (removals called out), then condition status changes in the atlas's
 * status words, each opening the preview on a condition that moves.
 */
export default function ChangesStep({ dataset, target, upload, changes }) {
  if (!changes) {
    return (
      <div className="skeleton-block" aria-busy="true" aria-label="Loading the changes">
        <span className="skeleton-line is-wide" />
        <span className="skeleton-line" />
      </div>
    );
  }
  const mode = upload?.mode ?? 'replace';
  const fromForm = upload?.origin === 'records';
  const fromHelper = fromForm && isHelperEntry(upload);
  if (hasNoChanges(changes)) {
    return (
      <>
        <p className="step-text">
          <strong>No changes.</strong> {fromHelper ? 'What you staged from the helper matches' : fromForm ? 'What you entered matches' : 'This file matches'} the live data exactly, so
          publishing it would change nothing. Discard it, or enter a different update.
        </p>
        <NewerStudyNotice upload={upload} />
      </>
    );
  }
  const total = shiftTotal(changes);
  const [one, many] = rowNoun(changes);
  const caption =
    mode === 'merge'
      ? `Only the ${many} ${fromHelper ? 'the helper proposed and you staged' : fromForm ? 'you entered' : 'in your file'}, compared with the live data (version ${changes.base_version}). Every other ${one} stays as it is.`
      : `Spreadsheet ${many} compared with the live data (version ${changes.base_version}).`;
  return (
    <>
      <dl className="figure-row" aria-label={`${many[0].toUpperCase()}${many.slice(1)} compared with the live data`}>
        {ROW_FIGURES.map((key) => (
          <div key={key} className={`figure-cell${key === 'removed' && changes.rows.removed ? ' is-caution' : ''}`}>
            <dt className="figure-unit">
              {many} {key}
            </dt>
            <dd className="figure">{count(changes.rows[key])}</dd>
          </div>
        ))}
      </dl>
      <p className="figure-caption">{caption}</p>

      <NamedChanges changes={changes} />

      <NewerStudyNotice upload={upload} />

      <RemovalNotice changes={changes} mode={mode} />

      <NameList title="AI systems added" names={changes.models?.added} />
      <NameList title="AI systems changed" names={changes.models?.changed} />
      <NameList title="Cards added (AI system / function)" names={changes.use_cases?.added} />

      {total ? (
        <>
          <h3 className="step-subtitle">
            {count(total)} condition status {total === 1 ? 'change' : 'changes'} on the atlas
          </h3>
          {dataset.shiftScope ? <p className="step-text muted">{dataset.shiftScope} Open one to see it in the preview.</p> : null}
          <ShiftSummary changes={changes} kind={dataset.kind} upload={upload} target={target} />
        </>
      ) : changes.kind === 'safety' ? (
        <p className="step-text muted">
          Safety incidents never change a result. On the atlas’s Safety view, the conditions they name are marked Serious or
          Caution; preview it in the next step.
        </p>
      ) : changes.kind === 'effects' ? (
        <p className="step-text muted">
          Effects never change a result or a grade. They appear on the condition card of their AI system and conditions;
          preview it in the next step.
        </p>
      ) : changes.kind === 'studies' ? (
        <p className="step-text muted">
          No condition changes its status for all patients. Results that name these studies may still move their evidence
          score; the condition card shows how.
        </p>
      ) : (
        <p className="step-text muted">No condition changes its status for all patients.</p>
      )}
    </>
  );
}
