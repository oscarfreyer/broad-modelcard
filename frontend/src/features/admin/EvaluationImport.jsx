import { useEffect, useId, useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import Icon from '../../design/Icon.jsx';
import EvaluationInput from './EvaluationInput.jsx';
import EvaluationProposals from './EvaluationProposals.jsx';
import { evaluationState } from './evaluations.js';
import ProblemNotice from './ProblemNotice.jsx';

const EMPTY = Object.freeze({ content: '', filename: null });

/** The check's problems and notes, each with its first example and fix. */
export function ReportList({ report }) {
  const groups = [...(report?.errors ?? []), ...(report?.notes ?? [])];
  if (!groups.length) return null;
  return (
    <ul className="template-note-list">
      {groups.map((group) => (
        <li key={group.code}>
          <strong>{group.message}</strong> {group.examples?.[0]?.problem ?? ''} {group.fix}
        </li>
      ))}
    </ul>
  );
}

/**
 * Import evaluation results (contract v1.14, CONTRACT.md §32.2) on the
 * Performance metrics page: the JSON of a benchmark or harness run is checked
 * like any upload, and its proposed records (a benchmark study and one row
 * per result) are staged on request. Nothing is published from here: the
 * study and the rows wait under Studies and Performance metrics.
 *
 * @param {object} props
 * @param {{ model: string, useCase: string }|null} props.target the page's card, for the example
 * @param {object[]} props.models the registry, for names and the card's configuration
 * @param {(created: object[]) => void} props.onStaged
 */
export default function EvaluationImport({ target, models, onStaged }) {
  const client = useDataClient();
  const [isOpen, setIsOpen] = useState(false);
  const [value, setValue] = useState(EMPTY);
  const [upload, setUpload] = useState(null);
  const [proposals, setProposals] = useState(null);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const regionId = useId();
  const entry = (models ?? []).find((model) => model.model_version === target?.model) ?? null;
  const variant = entry?.use_cases?.find((item) => item.use_case === target?.useCase) ?? null;
  const exampleCard = {
    modelVersion: target?.model,
    useCase: target?.useCase,
    configurationId: variant?.configuration?.configuration_id ?? 'cfg-example-1'
  };
  const systemName = (version) => (models ?? []).find((model) => model.model_version === version)?.display_name || version;

  // Follow the check.
  useEffect(() => {
    if (!upload || upload.status !== 'checking') return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await client.getUpload({ uploadId: upload.upload_id });
        if (!cancelled) setUpload(next);
      } catch (error) {
        if (!cancelled) setProblem(error);
      }
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, upload]);

  // Once the file is valid, read what it proposes (once per upload).
  const validId = upload?.status === 'valid' ? upload.upload_id : null;
  useEffect(() => {
    if (!validId) return undefined;
    const controller = new AbortController();
    client.getEvaluationProposals({ uploadId: validId }, { signal: controller.signal }).then(setProposals, (error) => {
      if (error?.name !== 'AbortError' && !controller.signal.aborted) setProblem(error);
    });
    return () => controller.abort();
  }, [client, validId]);

  const run = async (name, action) => {
    setBusy(name);
    setProblem(null);
    try {
      await action();
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(null);
    }
  };
  const check = () =>
    run('check', async () => {
      setProposals(null);
      setUpload(await client.createEvaluationUpload({ content: value.content, filename: value.filename ?? undefined, replaceStaged: true }));
    });
  const clear = () =>
    run('clear', async () => {
      if (upload && ['checking', 'invalid', 'valid'].includes(upload.status)) {
        await client.discardUpload({ uploadId: upload.upload_id });
      }
      setUpload(null);
      setProposals(null);
      setValue(EMPTY);
    });

  const state = evaluationState(upload);
  return (
    <section className="admin-card evaluation-import" aria-labelledby={`${regionId}-title`}>
      <div className="evaluation-import-head">
        <span className="evaluation-import-titles">
          <h2 id={`${regionId}-title`} className="admin-card-title">
            Import evaluation results
          </h2>
          <span className="admin-card-text muted">From a benchmark or evaluation harness run outside Broad Modelcard, as JSON.</span>
        </span>
        <button type="button" className="button-plain" aria-expanded={isOpen} aria-controls={regionId} onClick={() => setIsOpen((open) => !open)}>
          <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={16} />
          {isOpen ? 'Hide' : 'Open'}
        </button>
      </div>
      <div id={regionId} hidden={!isOpen} className="evaluation-import-body">
        {isOpen ? (
          <>
            <p className="step-text">
              The file names its card, the configuration it evaluated, and one result per ICD-11 code. After the check you tick which records to stage: a benchmark
              study and one performance row per result. Each then goes through check, review, and publish like any update.
            </p>
            <EvaluationInput value={value} onChange={setValue} card={exampleCard} />
            <div className="form-actions button-row">
              <button type="button" className="button-filled" disabled={!value.content.trim() || Boolean(busy)} onClick={check}>
                {busy === 'check' ? 'Sending…' : 'Check the results'}
              </button>
              {upload ? <span className={`part-state is-${state.tone}`}>{state.word}</span> : null}
              {upload ? (
                <button type="button" className="button-plain" disabled={Boolean(busy)} onClick={clear}>
                  {busy === 'clear' ? 'Clearing…' : 'Clear'}
                </button>
              ) : null}
            </div>
            {problem ? <ProblemNotice error={problem} onDismiss={() => setProblem(null)} /> : null}
            {upload?.status === 'invalid' ? <ReportList report={upload.report} /> : null}
            {proposals ? <EvaluationProposals proposals={proposals} systemName={systemName} onStaged={onStaged} /> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
