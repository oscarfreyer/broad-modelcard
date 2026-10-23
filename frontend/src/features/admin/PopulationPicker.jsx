import { useState } from 'react';
import { useDataClient } from '../../api/DataClientProvider.jsx';
import Icon from '../../design/Icon.jsx';
import { SelectField, TextField } from './FormFields.jsx';
import ProblemNotice from './ProblemNotice.jsx';
import { ChangeNoteField } from './PublishSteps.jsx';
import { liveAtlasHref } from './atlasLinks.js';
import { MAX_POPULATION_NAME, NEW_POPULATION, draftProblems, removalText, suggestPopulationId } from './populations.js';
import { noteIsReady } from './records.js';
import Sheet from './Sheet.jsx';
import { count } from './datasets.js';
import { publisherFields } from './workspace.js';

const WAITING_WORDS = { checking: 'update being checked', invalid: 'update needs a fix', valid: 'update ready to publish' };

/** Removal with a required change note (removePopulation, CONTRACT.md §21). */
function RemovePopulationSheet({ population, nextVersion, onClose, onRemoved }) {
  const client = useDataClient();
  const [note, setNote] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const canRemove = noteIsReady(note);
  const remove = async () => {
    setIsBusy(true);
    setProblem(null);
    try {
      const entry = await client.removePopulation({ populationId: population.id, note: note.trim(), ...publisherFields() });
      onRemoved(entry);
      onClose();
    } catch (error) {
      setProblem(error);
    } finally {
      setIsBusy(false);
    }
  };
  return (
    <Sheet
      title={`Remove ${population.name}?`}
      onClose={onClose}
      isBusy={isBusy}
      actions={
        <>
          <button type="button" className="button-plain" disabled={isBusy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button-filled is-destructive" disabled={isBusy || !canRemove} onClick={remove}>
            {isBusy ? 'Removing…' : `Remove as version ${nextVersion}`}
          </button>
        </>
      }
    >
      <p>{removalText(population, nextVersion)}</p>
      <ChangeNoteField label="Why remove it?" value={note} onChange={setNote} placeholder="e.g. The Northbridge pilot ended; readers go back to the default prevalence." />
      <ProblemNotice error={problem} onRetry={problem?.code === 'publish_in_progress' && canRemove ? remove : null} />
    </Sheet>
  );
}

/**
 * Which local population an update is for: a live one (its list is
 * replaced), one waiting as a staged upload, or a new one with its id and
 * name. A live population can be removed here, with a change note.
 *
 * @param {object} props
 * @param {ReturnType<typeof import('./populations.js').populationChoices>} props.choices
 * @param {{ choice: string, draft: { id: string, name: string, idEdited?: boolean } }} props.state
 * @param {(state: object) => void} props.onChange
 * @param {number} props.nextVersion
 * @param {(entry: object) => void} props.onRemoved
 */
export default function PopulationPicker({ choices, state, onChange, nextVersion, onRemoved }) {
  const [isRemoving, setIsRemoving] = useState(false);
  const chosen = choices.find((entry) => entry.id === state.choice) ?? null;
  const isNew = state.choice === NEW_POPULATION;
  const takenIds = choices.filter((entry) => entry.isLive).map((entry) => entry.id);
  const problems = isNew ? draftProblems(state.draft, takenIds) : { id: null, name: null };
  const typed = { id: Boolean(state.draft.id), name: Boolean(state.draft.name) };
  const options = [
    ...choices.map((entry) => ({
      value: entry.id,
      label: `${entry.name}${entry.isLive ? '' : ' (new, not published)'}${entry.upload ? `, ${WAITING_WORDS[entry.upload.status] ?? entry.upload.status}` : ''}`
    })),
    { value: NEW_POPULATION, label: 'New local population…' }
  ];
  const setDraft = (patch) => {
    const draft = { ...state.draft, ...patch };
    if ('name' in patch && !state.draft.idEdited) {
      draft.id = suggestPopulationId(patch.name);
    }
    onChange({ ...state, draft });
  };

  return (
    <section className="admin-card target-card population-card" aria-labelledby="population-title">
      <h2 id="population-title" className="admin-card-title">Local population</h2>
      <p className="admin-card-text">
        Each file holds the commonness tiers of one local population. A new population is added when you publish; a file for a live one
        replaces its whole list.
      </p>
      <div className="target-fields">
        <SelectField label="Population" value={state.choice} options={options} onChange={(choice) => onChange({ ...state, choice })} />
      </div>
      {isNew ? (
        <div className="target-fields population-draft">
          <TextField
            label="Name readers see"
            value={state.draft.name}
            maxLength={MAX_POPULATION_NAME + 20}
            placeholder="Northbridge region (fictional)"
            problem={typed.name ? problems.name : null}
            hint={!typed.name || !problems.name ? `At most ${MAX_POPULATION_NAME} characters. A fictional name: the data is synthetic.` : null}
            onChange={(name) => setDraft({ name })}
          />
          <TextField
            label="Id in links"
            value={state.draft.id}
            maxLength={60}
            placeholder="northbridge-region"
            problem={typed.id ? problems.id : null}
            hint={!typed.id || !problems.id ? 'Lowercase letters, digits, and hyphens. It goes into the atlas link as population=…' : null}
            onChange={(id) => onChange({ ...state, draft: { ...state.draft, id: id.toLowerCase(), idEdited: true } })}
          />
        </div>
      ) : chosen ? (
        <dl className="population-facts">
          <div>
            <dt>Id</dt>
            <dd className="code">{chosen.id}</dd>
          </div>
          <div>
            <dt>Codes listed</dt>
            <dd className="tabular">{chosen.codes == null ? 'Not published yet' : count(chosen.codes)}</dd>
          </div>
        </dl>
      ) : null}
      {chosen?.isLive ? (
        <div className="button-row population-actions">
          <a className="button-plain" href={liveAtlasHref('population', { populationId: chosen.id })}>
            <Icon name="ring" size={18} />
            Open the atlas with it
          </a>
          <button type="button" className="button-plain is-destructive" onClick={() => setIsRemoving(true)}>
            Remove population…
          </button>
        </div>
      ) : null}
      {isRemoving && chosen ? (
        <RemovePopulationSheet population={chosen} nextVersion={nextVersion} onClose={() => setIsRemoving(false)} onRemoved={onRemoved} />
      ) : null}
    </section>
  );
}
