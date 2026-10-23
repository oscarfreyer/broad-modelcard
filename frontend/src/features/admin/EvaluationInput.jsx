import { useState } from 'react';
import { FileButton, TextAreaField } from './FormFields.jsx';
import { MAX_EVALUATION_BYTES, evaluationExample, readEvaluationFile } from './evaluations.js';

/**
 * An evaluation results file as text (contract v1.14, §32.2): the JSON a
 * benchmark or harness run writes, in the format bmc-evaluation-results/1. A
 * file fills the text (at most 1 MB; a larger one is refused, never cut
 * short); the example starts one for the card given.
 *
 * @param {object} props
 * @param {{ content: string, filename: string|null }} props.value
 * @param {(next: { content: string, filename: string|null }) => void} props.onChange
 * @param {{ modelVersion?: string, useCase?: string, configurationId?: string }} [props.card] for the example
 * @param {string} [props.label]
 */
export default function EvaluationInput({ value, onChange, card = {}, label = 'Evaluation results (JSON)' }) {
  const [fileProblem, setFileProblem] = useState(null);
  const readFile = async (file) => {
    if (!file) return;
    const read = await readEvaluationFile(file);
    setFileProblem(read.problem ?? null);
    if (read.content !== undefined) onChange({ content: read.content, filename: read.filename });
  };
  return (
    <div className="evaluation-input">
      <div className="model-card-input-head">
        <FileButton label="Open a results file…" tone="plain" icon={null} accept=".json,application/json" onFile={readFile} />
        <button type="button" className="button-plain" onClick={() => onChange({ content: evaluationExample(card), filename: null })}>
          Start from the example
        </button>
      </div>
      {fileProblem ? (
        <p className="field-problem" role="alert">
          {fileProblem}
        </p>
      ) : null}
      <TextAreaField
        label={label}
        value={value.content}
        onChange={(content) => onChange({ ...value, content })}
        rows={8}
        max={MAX_EVALUATION_BYTES}
        className="model-card-text"
        hint="Format bmc-evaluation-results/1: the card, the configuration evaluated, the benchmark, the run date, who ran it, and one result per ICD-11 code. Aggregate synthetic results only."
      />
    </div>
  );
}
