import { useState } from 'react';
import SegmentedControl from '../../design/SegmentedControl.jsx';
import { FileButton, TextAreaField } from './FormFields.jsx';
import { MAX_CARD_BYTES, modelCardExample, readModelCardFile } from './submissions.js';

const FORMATS = [
  { value: 'json', label: 'JSON' },
  { value: 'markdown', label: 'Markdown' }
];

/**
 * A narrow model card as text (contract v1.13, §26): JSON in the prototype's
 * schema (Hugging Face style, with a `model-index`), or Markdown with simple
 * front matter. A file fills the text (at most 1 MB; a larger one is refused,
 * never cut short); the example starts a JSON card.
 *
 * @param {object} props
 * @param {{ format: 'json'|'markdown', content: string, filename: string|null }} props.value
 * @param {(next: object) => void} props.onChange
 * @param {string} [props.modelVersion] for the example
 */
export default function ModelCardInput({ value, onChange, modelVersion = '' }) {
  const [fileProblem, setFileProblem] = useState(null);
  const readFile = async (file) => {
    if (!file) return;
    const read = await readModelCardFile(file);
    setFileProblem(read.problem ?? null);
    if (read.card) onChange(read.card);
  };
  return (
    <div className="model-card-input">
      <div className="model-card-input-head">
        <SegmentedControl label="Format" options={FORMATS} value={value.format} onChange={(format) => onChange({ ...value, format })} size="small" />
        <FileButton label="Open a card file…" tone="plain" icon={null} accept=".json,.md,.markdown,application/json,text/markdown" onFile={readFile} />
        {value.format === 'json' ? (
          <button type="button" className="button-plain" onClick={() => onChange({ format: 'json', content: modelCardExample(modelVersion || 'Example-1.0'), filename: null })}>
            Start from the example
          </button>
        ) : null}
      </div>
      {fileProblem ? (
        <p className="field-problem" role="alert">
          {fileProblem}
        </p>
      ) : null}
      <TextAreaField
        label={value.format === 'json' ? 'Card (JSON)' : 'Card (Markdown)'}
        value={value.content}
        onChange={(content) => onChange({ ...value, content })}
        rows={8}
        max={MAX_CARD_BYTES}
        className="model-card-text"
        hint={
          value.format === 'json'
            ? 'Name, version, license, intended use, limitations, training data, and results as a model-index. Results with icd11_codes can become proposed performance metrics.'
            : 'Kept as text. Front matter: only flat key: value lines and simple lists are read; convert anything else to JSON.'
        }
      />
    </div>
  );
}
