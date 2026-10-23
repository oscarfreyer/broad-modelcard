import { useEffect, useId, useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import Icon from '../../design/Icon.jsx';
import { displayUseCase } from '../../shared/format.js';
import { proposalRows, stageEvaluation, studyLine } from './evaluations.js';
import ProblemNotice from './ProblemNotice.jsx';

const PART_WORDS = { study: 'Studies', metrics: 'Performance metrics' };

/**
 * The records an evaluation results upload proposes (contract v1.14, §32.2):
 * one benchmark study and one performance row per result. The reviewer ticks
 * what to stage; the study goes first, then the rows that name it, each as
 * its own update with the usual check, review, and publish. Nothing is
 * published from here. With `submissionId` the records join that submission.
 */
export default function EvaluationProposals({ proposals, submissionId = null, systemName = (version) => version, onStaged = () => {} }) {
  const client = useDataClient();
  const rows = proposalRows(proposals);
  const [includeStudy, setIncludeStudy] = useState(true);
  const [ticked, setTicked] = useState(() => new Set(rows.map((row) => row.index)));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [conflicts, setConflicts] = useState(null);
  const tableId = useId();
  const studyId = useId();

  // New proposals (another file) start with everything ticked again.
  useEffect(() => {
    setIncludeStudy(true);
    setTicked(new Set(proposalRows(proposals).map((row) => row.index)));
    setOutcome(null);
    setConflicts(null);
  }, [proposals]);

  const toggle = (index) =>
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  const allTicked = ticked.size === rows.length;
  const count = (includeStudy ? 1 : 0) + ticked.size;
  const card = `${systemName(proposals.metrics.model_version)}, ${displayUseCase(proposals.metrics.use_case)}`;

  const stage = async (replaceStaged = []) => {
    setBusy(true);
    setProblem(null);
    const parts = replaceStaged.length ? replaceStaged : ['study', 'metrics'];
    const recordIndexes = parts.includes('metrics') ? [...ticked] : [];
    const result = await stageEvaluation(client, proposals, {
      includeStudy: includeStudy && parts.includes('study'),
      recordIndexes,
      submissionId: submissionId ?? undefined,
      replaceStaged
    });
    setBusy(false);
    // The rows staged are counted now: the upload's own count arrives with its check.
    const created = result.created.map((entry) => ({ ...entry, rows: entry.part === 'metrics' ? recordIndexes.length : null }));
    const staged = [...(outcome?.created ?? []), ...created];
    setOutcome(staged.length ? { created: staged } : null);
    setConflicts(result.conflicts.length ? result.conflicts : null);
    if (result.error) setProblem(result.error);
    if (result.created.length) onStaged(result.created);
  };

  return (
    <div className="evaluation-proposals">
      {proposals.notes?.length ? (
        <ul className="template-note-list" aria-label="Notes from the check">
          {proposals.notes.map((group) => (
            <li key={group.code}>
              <strong>{group.message}</strong> {group.examples?.[0]?.problem ?? ''} {group.fix}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="evaluation-study">
        <input id={studyId} type="checkbox" className="proposal-keep" checked={includeStudy} onChange={() => setIncludeStudy((value) => !value)} />
        <label htmlFor={studyId} className="proposal-title-block">
          <span className="proposal-title">Benchmark study: {proposals.study.title}</span>
          <span className="proposal-detail">{studyLine(proposals.study)}</span>
        </label>
      </div>
      <div className="evaluation-results-head">
        <p className="admin-card-text">
          {rows.length} {rows.length === 1 ? 'result' : 'results'} for {card}, as performance rows that name the study.
        </p>
        <button type="button" className="button-plain" aria-controls={tableId} onClick={() => setTicked(allTicked ? new Set() : new Set(rows.map((row) => row.index)))}>
          {allTicked ? 'Untick all' : 'Tick all'}
        </button>
      </div>
      <div className="evaluation-table-wrap">
        <table className="issue-table evaluation-table" id={tableId}>
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Stage</span>
              </th>
              <th scope="col">Code</th>
              <th scope="col">Group</th>
              <th scope="col">Value</th>
              <th scope="col">Cases</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.index} className={ticked.has(row.index) ? '' : 'is-unticked'}>
                <td>
                  <input
                    type="checkbox"
                    className="proposal-keep"
                    checked={ticked.has(row.index)}
                    onChange={() => toggle(row.index)}
                    aria-label={`Stage ${row.code}, ${row.group}`}
                  />
                </td>
                <td>
                  {row.code}
                  {row.code !== row.conceptId ? <span className="muted"> → {row.conceptId}</span> : null}
                </td>
                <td>{row.group}</td>
                <td className="issue-value">
                  {row.value}
                  {row.interval ? <span className="muted"> ({row.interval})</span> : null}
                </td>
                <td className="issue-value">{row.cases}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {problem ? <ProblemNotice error={problem} onDismiss={() => setProblem(null)} /> : null}
      {conflicts ? (
        <div className="replace-prompt" role="alert">
          <p className="replace-prompt-title">Replace the update that is waiting?</p>
          <p className="step-text">
            {conflicts.map((part) => PART_WORDS[part]).join(' and ')} {conflicts.length === 1 ? 'already has' : 'already have'} an update waiting
            {submissionId ? ' in this submission' : ''}. Only one can wait; replacing it keeps the live data as it is.
          </p>
          <div className="button-row">
            <button type="button" className="button-filled" disabled={busy} onClick={() => stage(conflicts)}>
              {busy ? 'Staging…' : 'Replace it'}
            </button>
            <button type="button" className="button-plain" disabled={busy} onClick={() => setConflicts(null)}>
              Keep the waiting update
            </button>
          </div>
        </div>
      ) : null}
      <div className="button-row">
        <button type="button" className="button-tinted" disabled={busy || !count || Boolean(conflicts)} onClick={() => stage()}>
          <Icon name="upload" size={16} />
          {busy ? 'Staging…' : `Stage ${count} ${count === 1 ? 'record' : 'records'}`}
        </button>
      </div>
      {outcome ? (
        <p className="admin-notice is-info" role="status">
          <Icon name="check" size={20} className="admin-notice-icon" />
          <span>
            Staged{' '}
            {outcome.created
              .map(({ part, upload, rows }) => {
                if (part === 'study') return 'the study under Studies';
                const n = upload.report?.row_count ?? rows;
                return `${n} ${n === 1 ? 'row' : 'rows'} under Performance metrics`;
              })
              .join(' and ')}
            {submissionId ? ' in this submission' : ''}. Nothing is published yet:{' '}
            {submissionId ? 'accepting the submission publishes them.' : 'publish the study first, then the rows that name it.'}
          </span>
        </p>
      ) : null}
    </div>
  );
}
