import { useState } from 'react';
import useClientQuery from '../../api/useClientQuery.js';
import StatusLabel from '../../design/StatusLabel.jsx';
import { conceptName } from '../../shared/conceptName.js';
import { displayUseCase, populationWords } from '../../shared/format.js';
import { count } from './datasets.js';
import { optionLabel } from './options.js';
import ProblemNotice from './ProblemNotice.jsx';
import { HARMS, INCIDENT_STATUSES, INCIDENT_TYPES } from './records.js';

const SHOWN = 6;
const CONDITIONS_SHOWN = 2;
const SNIPPET = 140;

const HARM_WORDS = { occurred: 'harm occurred', possible: 'harm possible', none: 'no harm' };
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** "4 Aug 2026" from "2026-08-04", read as a calendar day (no time-zone shift). */
export function dayWords(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return match ? DAY.format(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : '';
}

/**
 * One stored incident in the list's words: its mark and status,
 * type and harm, where it applies, its dates, and a short summary.
 *
 * @param {object} incident a StoredIncident (contract v1.11)
 * @param {{ chapter_no: string }[]} [chapters] getMeta().chapters, for a chapter's name
 */
export function incidentRowWords(incident, chapters = []) {
  const status = optionLabel(INCIDENT_STATUSES, incident.status);
  const mark = incident.severity === 'serious' ? `Serious, ${status.toLowerCase()}` : incident.severity === 'caution' ? `Caution, ${status.toLowerCase()}` : status;
  let where;
  if (incident.chapter_no && !(incident.codes ?? []).length) {
    const chapter = chapters.find((entry) => entry.chapter_no === incident.chapter_no);
    where = `Chapter ${incident.chapter_no}${chapter ? `, ${conceptName(chapter)}` : ''}`;
  } else {
    const names = (incident.codes ?? []).map((code, index) => incident.code_names?.[index] ?? code);
    const rest = names.length - CONDITIONS_SHOWN;
    where = names.slice(0, CONDITIONS_SHOWN).join(', ') + (rest > 0 ? ` and ${rest} more` : '');
  }
  const population = populationWords(incident.lens);
  const updated = incident.updated_date ? `, updated ${dayWords(incident.updated_date)}` : '';
  const summary = String(incident.summary ?? '');
  return {
    mark,
    title: `${optionLabel(INCIDENT_TYPES, incident.incident_type)}, ${HARM_WORDS[incident.harm] ?? optionLabel(HARMS, incident.harm)}`,
    where: population === 'All patients' ? where : `${where}, ${population}`,
    dates: `Reported ${dayWords(incident.reported_date)}${updated}`,
    snippet: summary.length > SNIPPET ? `${summary.slice(0, SNIPPET - 1).trimEnd()}…` : summary
  };
}

function IncidentRow({ incident, chapters, isEditing, onEdit }) {
  const words = incidentRowWords(incident, chapters);
  return (
    <li className={`admin-row incident-row${isEditing ? ' is-editing' : ''}`}>
      <span className="incident-row-mark">
        <StatusLabel status={incident.severity ?? 'no_incidents'} toned={Boolean(incident.severity)}>
          {words.mark}
        </StatusLabel>
      </span>
      <span className="admin-row-main">
        <span className="admin-row-title">{words.title}</span>
        <span className="admin-row-text">{words.where}</span>
        {words.snippet ? <span className="incident-row-summary">{words.snippet}</span> : null}
        <span className="incident-row-meta">
          {words.dates}, <span className="tabular">{incident.incident_id}</span>
        </span>
      </span>
      {isEditing ? (
        <span className="incident-row-editing">Editing</span>
      ) : (
        <button type="button" className="button-plain incident-row-edit" aria-label={`Edit incident ${incident.incident_id}`} onClick={() => onEdit(incident)}>
          Edit
        </button>
      )}
    </li>
  );
}

/**
 * The list as drawn (what IncidentList reads, passed in): loading, failed,
 * empty, or the rows with Edit.
 *
 * @param {object} props
 * @param {string|null} props.cardName "SynGPT-2.0, Clinician-Facing CDSS", or null without a card
 * @param {object[]|null} props.incidents StoredIncident objects, newest first; null while loading
 * @param {Error|null} [props.error]
 * @param {() => void} [props.onRetry]
 * @param {object[]} [props.chapters] getMeta().chapters
 * @param {string|null} [props.editingId]
 * @param {boolean} [props.hasWaitingUpdate]
 * @param {(incident: object) => void} props.onEdit
 */
export function IncidentListView({ cardName, incidents, error = null, onRetry = null, chapters = [], editingId = null, hasWaitingUpdate = false, onEdit }) {
  const [showAll, setShowAll] = useState(false);
  const shown = incidents && !showAll ? incidents.slice(0, SHOWN) : incidents;
  // The incident being edited stays in view even when it is further down the list.
  const editing = incidents && !showAll && editingId ? incidents.find((entry) => entry.incident_id === editingId && !shown.includes(entry)) : null;
  const rows = editing ? [...shown, editing] : shown;

  return (
    <section className="incident-list" aria-labelledby="incident-list-title">
      <div className="incident-list-head">
        <h3 id="incident-list-title" className="step-subtitle">
          Stored incidents{cardName ? ` for ${cardName}` : ''}
        </h3>
        {incidents?.length ? <span className="incident-list-count tabular">{count(incidents.length)}</span> : null}
      </div>
      {!cardName ? (
        <p className="step-text muted">Choose the AI system and function in the form to see its stored incidents.</p>
      ) : error && !incidents ? (
        <ProblemNotice error={error} onRetry={onRetry} />
      ) : !incidents ? (
        <div className="skeleton-block" aria-busy="true" aria-label="Loading the stored incidents">
          <span className="skeleton-line is-wide" />
          <span className="skeleton-line" />
        </div>
      ) : !incidents.length ? (
        <p className="incident-list-empty">No incidents stored for this card.</p>
      ) : (
        <>
          <p className="step-text">
            Open, mitigated, and closed, newest first. Edit fills the form below with every stored value; publishing replaces that
            incident, so a closed one can be reopened too.
            {hasWaitingUpdate ? ' An update is waiting for this data set: the list shows the live incidents.' : ''}
          </p>
          <ul className="admin-list incident-rows" aria-label={`Stored incidents for ${cardName}`}>
            {rows.map((incident) => (
              <IncidentRow key={incident.incident_id} incident={incident} chapters={chapters} isEditing={incident.incident_id === editingId} onEdit={onEdit} />
            ))}
          </ul>
          {incidents.length > SHOWN ? (
            <button type="button" className="button-plain incident-list-more" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show the newest only' : `Show all ${count(incidents.length)} incidents`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * The stored incidents of one card (listIncidents, contract v1.11): open, mitigated, and closed, newest first, each with Edit, which
 * fills the incident form with every stored value. The list reads the live
 * version; `refreshKey` changes after a publish or restore, so it reads again.
 *
 * @param {object} props
 * @param {{ model: string, useCase: string }|null} props.card the form's card
 * @param {object[]} props.models live registry, for display names
 * @param {object|null} props.meta getMeta(), for chapter names
 * @param {string|number} props.refreshKey the live version
 * @param {string|null} props.editingId the incident the form edits
 * @param {boolean} props.hasWaitingUpdate a safety update is staged
 * @param {(incident: object) => void} props.onEdit
 */
export default function IncidentList({ card, models = [], meta = null, refreshKey, editingId = null, hasWaitingUpdate = false, onEdit }) {
  const hasCard = Boolean(card?.model && card?.useCase);
  const key = hasCard ? `admin|incidents|${card.model}|${card.useCase}|${refreshKey}` : null;
  const query = useClientQuery(key, (client, options) => client.listIncidents({ model: card.model, useCase: card.useCase }, options));
  const model = models.find((entry) => entry.model_version === card?.model);
  // While a new version loads, the card's previous list stays (no flash after a publish); another card's never shows.
  const cardKey = key ? key.slice(0, key.lastIndexOf('|') + 1) : null;
  const incidents = cardKey && query.dataKey?.startsWith(cardKey) ? query.data?.incidents ?? null : null;
  return (
    <IncidentListView
      cardName={hasCard ? `${model?.display_name || card.model}, ${displayUseCase(card.useCase)}` : null}
      incidents={incidents}
      error={query.error}
      onRetry={query.retry}
      chapters={meta?.chapters ?? []}
      editingId={editingId}
      hasWaitingUpdate={hasWaitingUpdate}
      onEdit={onEdit}
    />
  );
}
