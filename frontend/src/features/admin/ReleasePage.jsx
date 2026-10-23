import { useEffect, useRef, useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import Icon from '../../design/Icon.jsx';
import { dateTime, versionSummary } from './datasets.js';
import { focusNode } from './focus.js';
import { FileButton } from './FormFields.jsx';
import { ChangeNoteField } from './PublishSteps.jsx';
import ProblemNotice from './ProblemNotice.jsx';
import { noteIsReady } from './records.js';
import { publisherFields } from './workspace.js';

const CHANGE_ROWS = [
  ['models', 'AI systems'],
  ['metrics', 'Performance metrics'],
  ['multimorbidity', 'Multimorbidity'],
  ['prevalence', 'Prevalence codes'],
  ['studies', 'Public studies'],
  ['safety', 'Public incidents'],
  ['effects', 'Effects on outcomes'],
  ['model_cards', 'Narrow model cards']
];

const KEEP_WORDS = [
  ['populations', 'local populations'],
  ['local_results', 'local results sets'],
  ['hospital_studies', 'hospital studies'],
  ['hospital_incidents', 'hospital incidents']
];

function ImportResult({ result }) {
  if (result.status === 'invalid') {
    return (
      <div className="admin-notice is-error" role="alert">
        <Icon name="warning" size={20} className="admin-notice-icon" />
        <span>
          <strong>This file cannot be imported.</strong> {result.problems.map((entry) => entry.message).join(' ')}
        </span>
      </div>
    );
  }
  const keeps = KEEP_WORDS.filter(([key]) => result.keeps?.[key]).map(([key, words]) => `${result.keeps[key]} ${words}`);
  return (
    <>
      <p className="admin-card-text">
        Release of <strong>{result.release.organisation}</strong>, its version {result.release.dataset_version}, made {dateTime(result.release.created_at)}.
      </p>
      <table className="release-table">
        <caption className="visually-hidden">What publishing changes in the public layers</caption>
        <thead>
          <tr>
            <th scope="col">Public data</th>
            <th scope="col" className="tabular">Added</th>
            <th scope="col" className="tabular">Changed</th>
            <th scope="col" className="tabular">Removed</th>
          </tr>
        </thead>
        <tbody>
          {CHANGE_ROWS.map(([key, label]) => {
            const counts = result.changes?.[key] ?? { added: 0, changed: 0, removed: 0 };
            return (
              <tr key={key}>
                <th scope="row">{label}</th>
                <td className="tabular">{counts.added}</td>
                <td className="tabular">{counts.changed}</td>
                <td className="tabular">{counts.removed}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="admin-card-text">
        <Icon name="check" size={16} className="inline-icon" /> Kept as they are: {keeps.length ? keeps.join(', ') : 'nothing local yet'}.
      </p>
      {result.notes.length ? (
        <ul className="template-note-list">
          {result.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * Public releases (CONTRACT.md §26). A public instance exports
 * its public layers as one bundle; a hospital version imports it, checks it,
 * sees what changes, and publishes it as one version that keeps every local
 * layer (local populations and results, hospital studies and incidents).
 */
export default function ReleasePage({ onLibraryChange }) {
  const client = useDataClient();
  const [instance, setInstance] = useState(null);
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [published, setPublished] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const publishedRef = useRef(null);

  useEffect(() => {
    if (published) focusNode(publishedRef.current);
  }, [published]);

  /**
   * Another file replaces the one checked: its result and any publish notice
   * go, and the import checked from the old file is discarded, so Publish can
   * only ever publish the file on screen.
   */
  const chooseFile = (next) => {
    if (!next) return;
    if (result?.import_id) {
      client.discardReleaseImport({ importId: result.import_id }).catch(() => {});
    }
    setFile(next);
    setResult(null);
    setPublished(null);
    setNote('');
    setProblem(null);
  };

  useEffect(() => {
    client.getMeta({}, { version: 'live' }).then((meta) => setInstance(meta.instance ?? { kind: 'public' }), setProblem);
  }, [client]);

  const check = async () => {
    setBusy('check');
    setProblem(null);
    setPublished(null);
    try {
      setResult(await client.importPublicRelease({ file }));
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(null);
    }
  };
  const publish = async () => {
    setBusy('publish');
    setProblem(null);
    try {
      setPublished(await client.publishReleaseImport({ importId: result.import_id, note: note.trim(), ...publisherFields() }));
      setResult(null);
      setFile(null);
      setNote('');
      onLibraryChange?.();
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(null);
    }
  };
  const discard = async () => {
    setBusy('discard');
    try {
      await client.discardReleaseImport({ importId: result.import_id });
      setResult(null);
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(null);
    }
  };

  const isHospital = instance?.kind === 'hospital';
  return (
    <div className="admin-page">
      <header className="admin-page-header">
        <h1 className="admin-title">Public release</h1>
        <p className="admin-subtitle">
          {instance ? (isHospital ? 'This is a hospital version: import the public service’s release.' : 'This is a public service: export its public data as a release.') : 'Loading…'}
        </p>
      </header>
      {problem ? <ProblemNotice error={problem} onDismiss={() => setProblem(null)} /> : null}

      {instance && !isHospital ? (
        <section className="admin-card" aria-labelledby="export-title">
          <h2 id="export-title" className="admin-card-title">Export</h2>
          <p className="admin-card-text">
            One file with the live public data: AI systems and functions, performance metrics, multimorbidity, prevalence, public studies and incidents, effects, and narrow model cards, with a manifest and checksums. Local populations and anything a hospital adds never leave.
          </p>
          <div className="button-row">
            <a className="button-filled" href={client.getReleaseExportUrl()} download>
              <Icon name="download" size={18} />
              Download the release
            </a>
          </div>
          <p className="field-hint">To import one, set this copy to Hospital version under Instance.</p>
        </section>
      ) : null}

      {instance && isHospital ? (
        <section className="admin-card" aria-labelledby="import-title">
          <h2 id="import-title" className="admin-card-title">Import</h2>
          <p className="admin-card-text">The release replaces the public data in one version. Your local populations, local results, hospital studies, and hospital incidents stay.</p>
          <div className="file-field-row">
            <FileButton label={file ? 'Choose another release file…' : 'Choose the release file…'} accept=".gz,application/gzip" onFile={chooseFile} />
            {file ? <span className="file-field-name">{file.name}</span> : null}
            <button type="button" className="button-filled" disabled={!file || Boolean(busy)} onClick={check}>
              {busy === 'check' ? 'Checking…' : 'Check'}
            </button>
          </div>
          {result ? <ImportResult result={result} /> : null}
          {result?.status === 'valid' ? (
            <>
              <ChangeNoteField label="Change note" value={note} onChange={setNote} placeholder="e.g. Public release of 1 November." />
              <div className="form-actions button-row">
                <button type="button" className="button-filled" disabled={!noteIsReady(note) || Boolean(busy)} onClick={publish}>
                  {busy === 'publish' ? 'Publishing…' : 'Publish the release'}
                </button>
                <button type="button" className="button-plain" disabled={Boolean(busy)} onClick={discard}>
                  Discard
                </button>
              </div>
            </>
          ) : null}
          {published ? (
            <p className="admin-notice is-info" role="status" ref={publishedRef}>
              <Icon name="check" size={20} className="admin-notice-icon" />
              <span>
                <strong>Version {published.version_id} is live.</strong> {versionSummary(published.summary)}
              </span>
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
