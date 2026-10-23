import Icon from '../../design/Icon.jsx';
import { describeProblem } from './problems.js';

/**
 * A failed request in plain words, in the system's error voice. `describe`
 * turns the error into words (default: the update flow's describeProblem).
 */
export default function ProblemNotice({ error, onRetry = null, onDismiss = null, describe = describeProblem }) {
  if (!error) {
    return null;
  }
  const problem = describe(error);
  return (
    <div className="admin-notice is-error" role="alert">
      <Icon name="warning" size={20} className="admin-notice-icon" />
      <div className="admin-notice-text">
        <p className="admin-notice-title">{problem.title}</p>
        <p>{problem.text}</p>
        {problem.detail ? <p className="admin-notice-detail">{problem.detail}</p> : null}
      </div>
      <div className="admin-notice-actions">
        {onRetry ? (
          <button type="button" className="button-tinted" onClick={onRetry}>
            Try again
          </button>
        ) : null}
        {onDismiss ? (
          <button type="button" className="button-plain" onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
