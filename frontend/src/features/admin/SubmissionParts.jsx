import Icon from '../../design/Icon.jsx';
import { displayUseCase } from '../../shared/format.js';
import { PART_WORDS, firstProblem, partState } from './submissions.js';

function partTarget(upload, nameOf) {
  const target = upload.target;
  if (!target?.model_version) return null;
  const name = nameOf ? nameOf(target.model_version) : target.model_version;
  return target.use_case ? `${name}, ${displayUseCase(target.use_case)}` : name;
}

/**
 * The parts of a developer submission (contract v1.13, §26): one row each,
 * what it is, its file, and where its check stands; a part that needs a fix
 * says the first problem. `actions(upload)` adds a part's own buttons;
 * `below(upload)` a region under the part, across its whole width (Custodian
 * review: the part's change summary), as `{ id, shown, content }`: the region
 * is always there once it exists, so a button can name it in aria-controls,
 * and hidden while `shown` is false. `systemName(modelVersion)` names an AI
 * system by its display name.
 */
export default function SubmissionParts({ uploads, actions = null, below = null, systemName = null }) {
  if (!uploads?.length) {
    return <p className="admin-card-text muted">No parts yet.</p>;
  }
  return (
    <ul className="admin-list submission-parts" aria-label="Parts">
      {uploads.map((upload) => {
        const state = partState(upload);
        const problem = upload.status === 'invalid' ? firstProblem(upload) : null;
        const where = partTarget(upload, systemName);
        const under = below ? below(upload) : null;
        return (
          <li key={upload.upload_id} className="admin-row submission-part">
            <Icon name={state.tone === 'fix' ? 'warning' : state.tone === 'ready' || state.tone === 'done' ? 'check' : 'sheet'} size={20} className={`admin-row-icon is-${state.tone}`} />
            <span className="admin-row-main">
              <span className="admin-row-title">
                {PART_WORDS[upload.kind] ?? upload.kind}
                {where ? <span className="submission-part-target">, {where}</span> : null}
              </span>
              <span className="admin-row-text">
                {upload.origin === 'records' ? 'Entered in the form' : `“${upload.filename}”`}, <span className={`part-state is-${state.tone}`}>{state.word}</span>
              </span>
              {problem ? <span className="admin-row-text part-problem">{problem}</span> : null}
            </span>
            {actions ? <div className="submission-part-actions">{actions(upload)}</div> : null}
            {under ? (
              <div className="submission-part-below" id={under.id} hidden={!under.shown}>
                {under.shown ? under.content : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
