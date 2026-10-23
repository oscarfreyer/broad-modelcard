// User-facing copy for safety incidents (contract v1.7, CONTRACT.md §18). The API sends codes and the derived
// severity; the frontend owns the words. Incidents behave like warnings:
// Serious and Caution are marked, a closed incident is listed without a mark,
// and nothing here ever says "safe". All incidents are synthetic.
//
// One copy for every surface: the atlas card (IncidentList.js, DetailCard.jsx),
// the card exports, and the live plugin panel (embed/panelView.js). Keep it
// React-free: the panel bundle imports it.
import { populationWords } from '../../../shared/format.js';

export const INCIDENT_TYPE_LABELS = Object.freeze({
  harmful_recommendation: 'Harmful or incorrect recommendation',
  fabricated_content: 'Fabricated content',
  subgroup_bias: 'Subgroup bias',
  performance_drift: 'Performance drift',
  developer_notice_or_recall: 'Developer notice or recall',
  other: 'Other'
});

export const INCIDENT_STATUS_LABELS = Object.freeze({ open: 'Open', mitigated: 'Mitigated', closed: 'Closed' });

const STATUS_PLAIN = Object.freeze({
  open: 'Still open: it is being looked into.',
  mitigated: 'Mitigated: steps were taken to reduce the risk, so it stays marked Caution.',
  closed: 'Closed: resolved. Listed for the record, without a mark.'
});

const HARM_LABELS = Object.freeze({ occurred: 'Harm occurred', possible: 'Harm possible', none: 'No harm reported' });

export const SOURCE_TYPE_LABELS = Object.freeze({
  study: 'Study',
  incident_report: 'Incident report',
  developer_notice: 'Developer notice'
});

/** How Serious and Caution are decided, in plain words and in expert terms. */
export const SEVERITY_NOTE = Object.freeze({
  plain:
    'Serious: open, with harm or possible harm, or a recall. Caution: any other open or mitigated incident. Closed: listed, no mark.',
  expert:
    'Severity is derived: Serious = status open and harm occurred or possible, or type developer notice or recall; Caution = any other open incident, or a mitigated one; closed = no severity. An incident applies when each of its lens values is "All …" or equals the requested one. Incidents never change grades, statuses, warnings, or safeguards.'
});

export const NO_INCIDENTS_TEXT = Object.freeze({
  plain: 'None reported for this population. Not evidence of safety.',
  expert: 'No incident of this card applies to this concept at this lens. Absence of reports is not evidence of safety.'
});

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "12 Sep 2026" for an ISO date, or null. */
export function formatIncidentDate(iso) {
  if (!iso) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : DATE.format(date);
}

/** The display key of an incident's mark: Serious, Caution, or null for a closed one (listed, not coloured). */
export function incidentMark(incident) {
  return incident?.severity === 'serious' || incident?.severity === 'caution' ? incident.severity : null;
}

/** The worst mark of a concept's incidents, as a display key ('no_incidents' when none applies). */
export function incidentsMark(incidents = []) {
  const marks = incidents.map(incidentMark);
  if (marks.includes('serious')) return 'serious';
  if (marks.includes('caution')) return 'caution';
  return 'no_incidents';
}

/** The neutral mark's word when incidents are listed but none is marked: all of them are closed. */
export const NO_OPEN_INCIDENTS = 'No open incidents';

export const CLOSED_ONLY_TEXT = Object.freeze({
  plain: 'Every incident reported here is closed: resolved, and listed below for the record without a mark.',
  expert: 'Every incident that applies here is closed, so none carries a severity; they are listed for the record.'
});

/**
 * The word for a concept's Safety mark: the mark's own word, except that the
 * neutral mark reads "No open incidents" when closed incidents are listed
 * ("No reported incidents" stays for a concept without any incident).
 *
 * @returns {string|null} null for the mark's own word
 */
export function incidentsMarkWord(incidents = []) {
  return incidents.length && incidentsMark(incidents) === 'no_incidents' ? NO_OPEN_INCIDENTS : null;
}

/**
 * The open incidents among a concept's incidents (the header chip): count and
 * the worst severity. Mitigated incidents are marked Caution on the ring but
 * are not open, so the chip leaves them out (CONTRACT.md §17, §18).
 */
export function openIncidentSummary(incidents = []) {
  const open = incidents.filter((incident) => incident.status === 'open');
  return {
    count: open.length,
    serious: open.filter((incident) => incident.severity === 'serious').length,
    tone: open.some((incident) => incident.severity === 'serious') ? 'serious' : open.length ? 'caution' : null
  };
}

const SEVERITY_RANK = { serious: 0, caution: 1 };

/** Serious first, then Caution, then closed; the API's newest-first order within each. */
export function sortIncidents(incidents = []) {
  return incidents
    .map((incident, index) => ({ incident, index }))
    .sort((a, b) => (SEVERITY_RANK[a.incident.severity] ?? 2) - (SEVERITY_RANK[b.incident.severity] ?? 2) || a.index - b.index)
    .map(({ incident }) => incident);
}

/** Where an incident applies: the codes, or its whole chapter (by name when known). */
function scopeWords(incident, chapterName) {
  if (incident.chapter_id) {
    return `the whole chapter ${chapterName?.(incident.chapter_id) ?? incident.chapter_id}`;
  }
  return incident.codes?.length ? incident.codes.join(', ') : 'this condition';
}

/**
 * One incident as the card and the exports show it.
 *
 * @param {object} incident contract SafetyIncident
 * @param {{ chapterName?: (chapterId: string) => string|null }} [options]
 * @returns {{ id: string, mark: 'serious'|'caution'|null, severityWord: string, type: string, status: string,
 *   statusText: string, population: string, source: string, reported: string|null, updated: string|null,
 *   summary: string, facts: { label: string, value: string }[] }}
 */
export function describeIncident(incident, { chapterName = null } = {}) {
  const mark = incidentMark(incident);
  const type = INCIDENT_TYPE_LABELS[incident.incident_type] ?? 'Other';
  const sourceType = SOURCE_TYPE_LABELS[incident.source_type] ?? 'Source';
  const source = [
    `${sourceType}: ${incident.source_reference}`,
    incident.study_id ? `study ${incident.study_id}` : null
  ]
    .filter(Boolean)
    .join(', ');
  const reported = formatIncidentDate(incident.reported_date);
  const updated = formatIncidentDate(incident.updated_date);
  return {
    id: incident.incident_id,
    mark,
    severityWord: mark === 'serious' ? 'Serious' : mark === 'caution' ? 'Caution' : 'Closed',
    type,
    status: INCIDENT_STATUS_LABELS[incident.status] ?? incident.status,
    statusText: STATUS_PLAIN[incident.status] ?? '',
    population: populationWords(incident.lens),
    source,
    reported,
    updated,
    summary: incident.summary,
    facts: [
      { label: 'Incident', value: incident.incident_id },
      { label: 'Applies to', value: `${scopeWords(incident, chapterName)}, ${populationWords(incident.lens)}` },
      { label: 'Harm', value: HARM_LABELS[incident.harm] ?? incident.harm },
      { label: 'Status', value: INCIDENT_STATUS_LABELS[incident.status] ?? incident.status },
      { label: 'Source', value: source },
      { label: 'Reported', value: reported ?? 'Not given' },
      { label: 'Updated', value: updated ?? 'Not updated since' }
    ]
  };
}

/**
 * The header chip's words for the open incidents, e.g. "1 open serious
 * incident" or "3 open incidents, 1 serious"; null when none is open.
 */
export function openIncidentChip(incidents = []) {
  const { count, serious, tone } = openIncidentSummary(incidents);
  if (!count) return null;
  const noun = count === 1 ? 'incident' : 'incidents';
  let text;
  if (!serious) {
    text = `${count} open caution ${noun}`;
  } else if (serious === count) {
    text = `${count} open serious ${noun}`;
  } else {
    text = `${count} open ${noun}, ${serious} serious`;
  }
  return { tone, text };
}

/** The newest date of a described incident in words, e.g. "Updated 12 Sep 2026"; null without dates. */
export function latestIncidentDate(item) {
  if (item?.updated) return `Updated ${item.updated}`;
  return item?.reported ? `Reported ${item.reported}` : null;
}

/** The incidents for a card export (JSON and PDF), worst first. */
export function exportIncidents(incidents = []) {
  return sortIncidents(incidents).map((incident) => {
    const described = describeIncident(incident);
    return {
      incident_id: incident.incident_id,
      severity: incident.severity ?? null,
      severity_word: described.severityWord,
      incident_type: described.type,
      status: described.status,
      harm: HARM_LABELS[incident.harm] ?? incident.harm,
      applies_to: { codes: incident.codes ?? [], chapter_id: incident.chapter_id ?? null, population: described.population },
      source: described.source,
      reported_date: incident.reported_date ?? null,
      updated_date: incident.updated_date ?? null,
      summary: incident.summary
    };
  });
}
