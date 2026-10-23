import { useEffect, useRef, useState } from 'react';
import HelpTip from '../../design/HelpTip.js';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import Icon from '../../design/Icon.jsx';
import { displayUseCase } from '../../shared/format.js';
import { focusNode } from './focus.js';
import { SelectField } from './FormFields.jsx';
import ModelCardInput from './ModelCardInput.jsx';
import { ChangeNoteField } from './PublishSteps.jsx';
import ProblemNotice from './ProblemNotice.jsx';
import { noteIsReady } from './records.js';
import { partState, stageProposalBatches, systemName } from './submissions.js';
import { publisherFields } from './workspace.js';

const EMPTY_CARD = Object.freeze({ format: 'json', content: '', filename: null });

/**
 * Narrow model cards (CONTRACT.md §26): a developer's own model
 * card per AI system, in JSON or Markdown. Check it, look at the results it
 * proposes (staged as performance metrics for review, never published from
 * here), and publish the card with a note. Everything on the page belongs to
 * the AI system chosen: choosing another starts again.
 */
export default function ModelCardsPage({ models, onLibraryChange }) {
  const client = useDataClient();
  const systems = models ?? [];
  const [system, setSystem] = useState('');
  const [current, setCurrent] = useState(null);
  const [card, setCard] = useState(EMPTY_CARD);
  const [upload, setUpload] = useState(null);
  const [proposals, setProposals] = useState(null);
  const [staged, setStaged] = useState(null);
  // Cards whose performance metrics already have an update waiting: asked about before replacing.
  const [conflicts, setConflicts] = useState(null);
  const [published, setPublished] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const publishedRef = useRef(null);
  const modelVersion = system || systems[0]?.model_version || '';
  // The AI system on the page now: a card sent for another one before a switch is not shown here.
  const systemRef = useRef(modelVersion);
  systemRef.current = modelVersion;

  useEffect(() => {
    if (!modelVersion) return undefined;
    const controller = new AbortController();
    setCurrent(null);
    client.getNarrowModelCard({ modelVersion }, { version: 'live', signal: controller.signal }).then(
      (body) => setCurrent(body.narrow_model_card),
      (error) => {
        if (error?.name !== 'AbortError' && !controller.signal.aborted) setProblem(error);
      }
    );
    return () => controller.abort();
  }, [client, modelVersion, published]);

  // Follow the card's check; a response for an upload no longer on the page is dropped.
  useEffect(() => {
    if (!upload || upload.status !== 'checking') return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await client.getUpload({ uploadId: upload.upload_id });
        if (cancelled) return;
        setUpload(next);
        if (next.status === 'valid') {
          const proposed = await client.getModelCardProposals({ uploadId: next.upload_id });
          if (!cancelled) setProposals(proposed);
        }
      } catch (error) {
        if (!cancelled) setProblem(error);
      }
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, upload]);

  useEffect(() => {
    if (published) focusNode(publishedRef.current);
  }, [published]);

  const chooseSystem = (next) => {
    setSystem(next);
    setCard(EMPTY_CARD);
    setUpload(null);
    setProposals(null);
    setStaged(null);
    setConflicts(null);
    setPublished(null);
    setNote('');
    setProblem(null);
  };

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
      setStaged(null);
      setConflicts(null);
      setPublished(null);
      const created = await client.createModelCardUpload({ modelVersion, format: card.format, content: card.content, filename: card.filename ?? undefined, replaceStaged: true });
      if (systemRef.current === modelVersion) setUpload(created);
    });
  const stage = (batches, replaceStaged) =>
    run('stage', async () => {
      const outcome = await stageProposalBatches(client, batches, { replaceStaged });
      setStaged((done) => [...(done ?? []), ...outcome.created]);
      setConflicts(outcome.conflicts.length ? outcome.conflicts : null);
      if (outcome.created.length) onLibraryChange?.();
      if (outcome.error) throw outcome.error;
    });
  const publish = () =>
    run('publish', async () => {
      setPublished(await client.publishUpload({ uploadId: upload.upload_id, previewed: false, note: note.trim(), ...publisherFields() }));
      setUpload(null);
      setNote('');
      onLibraryChange?.();
    });

  const state = partState(upload);
  const proposed = proposals ? proposals.batches.reduce((sum, batch) => sum + batch.records.length, 0) : 0;
  const allStaged = Boolean(staged?.length) && !conflicts;
  const cardWords = (batch) => `${systemName(batch.model_version, systems)}, ${displayUseCase(batch.use_case)}`;
  return (
    <div className="admin-page">
      <header className="admin-page-header">
        <div className="page-title-row">
          <h1 className="admin-title">Narrow model cards</h1>
          <HelpTip label="About this page">
            <p>The developers’ own model cards, shown under About this AI system. Never checked for truth.</p>
          </HelpTip>
        </div>
      </header>
      {problem ? <ProblemNotice error={problem} onDismiss={() => setProblem(null)} /> : null}
      <section className="admin-card" aria-label="AI system">
        <SelectField
          label="AI system"
          value={modelVersion}
          options={systems.map((entry) => ({ value: entry.model_version, label: entry.display_name || entry.model_version }))}
          onChange={chooseSystem}
        />
        <p className="admin-card-text muted">
          {current ? `Published card: ${current.name}${current.version ? ` ${current.version}` : ''} (${current.source_format === 'json' ? 'JSON' : 'Markdown'}, ${current.results.length} results).` : 'No narrow model card is published for this AI system.'}
        </p>
      </section>
      <section className="admin-card" aria-label="Card">
        <ModelCardInput value={card} onChange={setCard} modelVersion={modelVersion} />
        <div className="form-actions button-row">
          <button type="button" className="button-filled" disabled={!card.content.trim() || Boolean(busy)} onClick={check}>
            {busy === 'check' ? 'Sending…' : 'Check the card'}
          </button>
          {upload ? <span className={`part-state is-${state.tone}`}>{state.word}</span> : null}
        </div>
        {upload?.report ? (
          <ul className="template-note-list">
            {[...(upload.report.errors ?? []), ...(upload.report.notes ?? [])].map((group) => (
              <li key={group.code}>
                <strong>{group.message}</strong> {group.examples?.[0]?.problem ?? ''} {group.fix}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {upload?.status === 'valid' ? (
        <section className="admin-card" aria-labelledby="card-publish-title">
          <h2 id="card-publish-title" className="admin-card-title">Results and publish</h2>
          {proposals ? (
            <p className="admin-card-text">
              {proposed
                ? `The card proposes ${proposed} ${proposed === 1 ? 'result' : 'results'} for ICD-11 conditions. Stage them as performance metrics to check, preview, and publish them there; nothing is published from here.`
                : 'The card proposes no results (none names an ICD-11 condition).'}
            </p>
          ) : null}
          {proposed && !conflicts ? (
            <div className="button-row">
              <button type="button" className="button-tinted" disabled={Boolean(busy) || allStaged} onClick={() => stage(proposals.batches, false)}>
                {allStaged ? 'Staged under Performance metrics' : busy === 'stage' ? 'Staging…' : 'Stage as performance metrics'}
              </button>
            </div>
          ) : null}
          {conflicts ? (
            <div className="replace-prompt" role="alert">
              <p className="replace-prompt-title">Replace the update that is waiting?</p>
              <p className="step-text">
                Performance metrics of {conflicts.map(cardWords).join(', ')} already {conflicts.length === 1 ? 'has' : 'have'} an update waiting. Only one can wait per card;
                replacing it keeps the live data as it is.
              </p>
              <div className="button-row">
                <button type="button" className="button-filled" disabled={Boolean(busy)} onClick={() => stage(conflicts, true)}>
                  {busy === 'stage' ? 'Staging…' : 'Replace with the card’s results'}
                </button>
                <button type="button" className="button-plain" disabled={Boolean(busy)} onClick={() => setConflicts(null)}>
                  Keep the waiting update
                </button>
              </div>
            </div>
          ) : null}
          <ChangeNoteField value={note} onChange={setNote} placeholder="e.g. The developer’s card of 1 October." />
          <div className="form-actions button-row">
            <button type="button" className="button-filled" disabled={!noteIsReady(note) || Boolean(busy)} onClick={publish}>
              <Icon name="check" size={18} />
              {busy === 'publish' ? 'Publishing…' : 'Publish the card'}
            </button>
          </div>
        </section>
      ) : null}
      {published ? (
        <p className="admin-notice is-info" role="status" ref={publishedRef}>
          <Icon name="check" size={20} className="admin-notice-icon" />
          <span>Version {published.version_id} is live with the card.</span>
        </p>
      ) : null}
    </div>
  );
}
