import { FormGroup, SelectField, TextAreaField, TextField } from './FormFields.jsx';
import { ENTRY_LIMITS, TOOL_SEPARATOR } from './registryEntryFields.js';

/**
 * The contract v1.14 registry fields of a new AI system in "Submit an AI
 * system" (CONTRACT.md §28): the version it replaces, its configuration, what
 * its figures measure, and the developer's data-protection declarations.
 * Every field is optional; the checks are the registry upload's
 * (registryEntryFields.js).
 *
 * @param {object} props
 * @param {object} props.entry the form's `entry` (emptyEntryFields())
 * @param {(patch: object) => void} props.onChange
 * @param {Record<string, string>} props.problems the problems to show now
 * @param {object[]} props.systems listModels().models: the AI systems Replaces can name
 * @param {string} props.modelVersion the new AI system's version (left out of Replaces)
 */
export default function RegistryEntryFields({ entry, onChange, problems, systems, modelVersion }) {
  const field = (key) => ({ value: entry[key], problem: problems[key] ?? null, onChange: (value) => onChange({ [key]: value }) });
  const earlier = (systems ?? [])
    .filter((system) => system.model_version !== modelVersion.trim())
    .map((system) => ({ value: system.model_version, label: system.display_name || system.model_version }));
  return (
    <>
      <FormGroup title="Version">
        <SelectField
          label="Replaces"
          optional
          options={earlier}
          placeholder="No earlier version"
          hint="The listed AI system this one supersedes, e.g. its earlier release."
          {...field('replaces')}
        />
      </FormGroup>
      <FormGroup title="Configuration">
        <p className="field-hint">How this function is set up when it is used. A changed configuration later shows as an update of the card.</p>
        <div className="form-row is-two">
          <TextField label="Configuration ID" optional maxLength={64} placeholder="e.g. cfg-2026-09" {...field('configurationId')} />
          <TextField label="Configuration date" optional type="date" {...field('configurationDate')} />
        </div>
        <TextAreaField
          label="Prompt summary"
          max={ENTRY_LIMITS.promptSummary}
          rows={2}
          hint="A short summary of the instructions it is given. Never paste the full prompt."
          {...field('promptSummary')}
        />
        <TextField
          label="Prompt SHA-256"
          optional
          maxLength={64}
          placeholder="64 characters, 0-9 and a-f"
          hint="The checksum of the full prompt, so readers can check it without seeing it."
          {...field('promptSha256')}
        />
        <div className="form-row is-two">
          <TextAreaField label="Retrieval" max={ENTRY_LIMITS.retrieval} rows={2} placeholder="e.g. Local guidelines, updated monthly" {...field('retrieval')} />
          <TextAreaField label="Fine-tuning" max={ENTRY_LIMITS.fineTuning} rows={2} placeholder="e.g. Adapted to ward documentation" {...field('fineTuning')} />
        </div>
        <TextField
          label="Tools"
          optional
          placeholder={`e.g. guideline_search${TOOL_SEPARATOR} lab_lookup`}
          hint={`Names of the tools it can call, separated by "${TOOL_SEPARATOR}" (at most ${ENTRY_LIMITS.tools}).`}
          {...field('tools')}
        />
        <div className="form-row is-three">
          <TextField label="Sampling temperature" optional inputMode="decimal" placeholder="0 to 2" {...field('temperature')} />
          <TextField label="Sampling top-p" optional inputMode="decimal" placeholder="0 to 1" {...field('topP')} />
          <TextField label="Max output tokens" optional inputMode="numeric" placeholder="e.g. 1200" {...field('maxTokens')} />
        </div>
      </FormGroup>
      <FormGroup title="What the figures measure">
        <div className="form-row is-two">
          <TextField label="Performance measure" optional maxLength={ENTRY_LIMITS.measure} placeholder="e.g. Top-3 diagnostic accuracy" {...field('measure')} />
          <TextField label="Reference standard" optional maxLength={ENTRY_LIMITS.referenceStandard} placeholder="e.g. Final diagnosis at discharge" {...field('referenceStandard')} />
        </div>
      </FormGroup>
      <FormGroup title="Data protection">
        <p className="field-hint">Shown as declared by the developer, never as checked.</p>
        <TextAreaField label="Declared data use" max={ENTRY_LIMITS.dataUse} rows={2} placeholder="Which patient data it uses, and whether it is used for training" {...field('dataUse')} />
        <div className="form-row is-three">
          <TextField label="Declared data location" optional maxLength={ENTRY_LIMITS.dataLocation} placeholder="e.g. Hospital servers in the EU" {...field('dataLocation')} />
          <TextField label="Declared retention" optional maxLength={ENTRY_LIMITS.retention} placeholder="e.g. Deleted after 30 days" {...field('retention')} />
          <TextField label="Declared privacy contact" optional maxLength={ENTRY_LIMITS.privacyContact} placeholder="e.g. privacy@developer.example" {...field('privacyContact')} />
        </div>
      </FormGroup>
    </>
  );
}
