import Icon from '../../design/Icon.jsx';
import { displayUseCase } from '../../shared/format.js';

function Select({ label, value, options, format = (option) => option, onChange }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="select-wrap">
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option} value={option}>
              {format(option)}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={16} className="select-chevron" />
      </span>
    </label>
  );
}

/**
 * AI system × function (a card) for performance metrics and multimorbidity:
 * every template, upload, and check on the page belongs to this pair.
 *
 * @param {object} props
 * @param {object[]} props.models live registry (listModels().models)
 * @param {{ model: string, useCase: string }} props.target
 * @param {(target: { model: string, useCase: string }) => void} props.onChange
 * @param {{ model: string, useCase: string, label: string }[]} props.waiting other targets with a staged update
 */
export default function TargetPicker({ models, target, onChange, waiting }) {
  const model = models.find((entry) => entry.model_version === target.model) ?? models[0];
  const useCases = (model?.use_cases ?? []).map((entry) => entry.use_case);
  return (
    <section className="admin-card target-card" aria-labelledby="target-title">
      <h2 id="target-title" className="admin-card-title">AI system and function</h2>
      <p className="admin-card-text">Each file holds the results of one AI system for one function.</p>
      <div className="target-fields">
        <Select
          label="AI system"
          value={target.model}
          options={models.map((entry) => entry.model_version)}
          onChange={(next) => {
            const nextModel = models.find((entry) => entry.model_version === next);
            const nextUseCases = nextModel?.use_cases.map((entry) => entry.use_case) ?? [];
            onChange({ model: next, useCase: nextUseCases.includes(target.useCase) ? target.useCase : nextModel?.default_use_case ?? nextUseCases[0] });
          }}
        />
        <Select label="Function" value={target.useCase} options={useCases} format={displayUseCase} onChange={(next) => onChange({ model: target.model, useCase: next })} />
      </div>
      {waiting.length ? (
        <div className="target-waiting">
          <p className="target-waiting-label">Updates waiting for other AI systems or functions:</p>
          <ul>
            {waiting.map((entry) => (
              <li key={`${entry.model}|${entry.useCase}`}>
                <button type="button" className="button-plain" onClick={() => onChange({ model: entry.model, useCase: entry.useCase })}>
                  {entry.model}, {displayUseCase(entry.useCase)}
                  <span className="target-waiting-status">{entry.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
