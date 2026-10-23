import { useCallback, useEffect, useRef, useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import { initialReview } from './assist.js';

/**
 * One study handed to the helper and what it proposed, for one data set
 * (and, for metrics, one card): the study (pasted text or a file), the
 * proposals, and the maintainer's review (records kept, values edited).
 * Nothing here stages or publishes; the page stages the kept records with
 * createRecordsUpload. The study stays in this tab's memory only.
 *
 * @param {object} options
 * @param {'metrics'|'safety'} options.kind
 * @param {{ model: string, useCase: string }|null} options.card the page's card (metrics)
 */
export default function useProposals({ kind, card }) {
  const client = useDataClient();
  const [source, setSource] = useState('text'); // 'text' | 'file'
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [proposals, setProposals] = useState(null);
  const [review, setReview] = useState({ kept: {}, edits: {}, editing: {} });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  // Upload ids staged from these proposals: a failed check is fixed here.
  const [stagedIds, setStagedIds] = useState([]);
  const controller = useRef(null);
  const cardKey = card ? `${card.model}|${card.useCase}` : '';

  const clear = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setProposals(null);
    setReview({ kept: {}, edits: {}, editing: {} });
    setProblem(null);
    setBusy(false);
  }, []);

  // Another card starts again: proposals belong to the card they were made for.
  useEffect(() => {
    clear();
    setText('');
    setFile(null);
    setStagedIds([]);
  }, [kind, cardKey, clear]);

  useEffect(() => () => controller.current?.abort(), []);

  const propose = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setProblem(null);
    try {
      const study = source === 'file' ? { file } : { text };
      const result = await client.proposeRecords(
        { kind, ...study, modelVersion: kind === 'metrics' ? card?.model : undefined, useCase: kind === 'metrics' ? card?.useCase : undefined },
        { signal: current.signal }
      );
      if (!current.signal.aborted) {
        setProposals(result);
        setReview(initialReview(result));
      }
    } catch (error) {
      if (!current.signal.aborted && error?.name !== 'AbortError') {
        setProblem(error);
      }
    } finally {
      if (controller.current === current) {
        controller.current = null;
        setBusy(false);
      }
    }
  }, [card?.model, card?.useCase, client, file, kind, source, text]);

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
  }, []);

  const toggleKept = (id) => setReview((current) => ({ ...current, kept: { ...current.kept, [id]: !current.kept[id] } }));
  const setEditing = (id, isEditing) => setReview((current) => ({ ...current, editing: { ...current.editing, [id]: isEditing } }));
  const setEdit = (id, patch) =>
    setReview((current) => ({ ...current, edits: { ...current.edits, [id]: { ...(current.edits[id] ?? {}), ...patch } } }));
  const undoEdits = (id) =>
    setReview((current) => {
      const edits = { ...current.edits };
      delete edits[id];
      return { ...current, edits };
    });

  return {
    source,
    setSource,
    text,
    setText,
    file,
    setFile,
    proposals,
    review,
    busy,
    problem,
    clearProblem: () => setProblem(null),
    propose,
    cancel,
    clear,
    toggleKept,
    setEditing,
    setEdit,
    undoEdits,
    stagedIds,
    markStaged: (uploadId) => setStagedIds((ids) => (ids.includes(uploadId) ? ids : [...ids, uploadId]))
  };
}
