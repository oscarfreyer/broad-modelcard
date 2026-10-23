// The audience summaries at the top of the atlas Summary (release 0.5; CONTRACT.md §30.2): one short block per preset, built only
// from figures other reads already serve, so a preset changes what comes
// first, never what a figure says. Nothing here
// ranks a card against another or says that a system is safe or approved.
//
// Each builder takes the reads (any may still be loading, null, or have
// failed) and returns
//   { lines: [{ id, label, text, tone?, strip?, targetId?, href? }],
//     more: [{ id, title, items: string[] }], facts }
// `lines` is the short block (about six lines at plain depth); `more` the
// details behind it; `facts` the figures it shows, so the tests can compare
// each one with its source. React-free for the tests; AudienceSummary.js
// draws it.
import { DISPLAY } from '../../design/status.js';
import { functionCategoryPhrase, formatReleaseDate, systemName } from '../../shared/aiSystem.js';
import { displayUseCase } from '../../shared/format.js';
import { CONDUCTOR_PHRASES, DESIGN_LABELS, RISK_OF_BIAS_LABELS } from '../details/copy/studyCopy.js';
import { INCIDENT_STATUS_LABELS, INCIDENT_TYPE_LABELS } from '../details/copy/incidentCopy.js';
import { effectNumbers, effectSentence } from '../details/copy/effectCopy.js';
import { rankWarnings, USE_CASE_REQUIREMENT } from '../details/copy/warningCopy.js';
import { DECLARED, NO_DATA_MEANING, NOT_SAFE_MEANING, OUT_OF_SCOPE_MEANING, SYNTHETIC_NOT_CLINICAL } from '../guide/guideCopy.js';
import { audienceLabel } from '../profile/audience.js';

export const AUDIENCE_TITLES = Object.freeze({
  clinician: 'Where to be careful',
  patient: 'In plain words',
  procurement: 'Population fit and compliance',
  regulator: 'Post-market facts',
  payer: 'Effects and evidence'
});

const RESULT_KEYS = ['strong', 'moderate', 'weak', 'no_data', 'out_of_scope'];
export const LOADING = 'Loading…';
export const FAILED = 'Could not be loaded. Try again later.';
export const NO_DATA_DECLARATIONS = 'The developer has not declared how patient data is handled.';

const count = (value) => Number(value || 0).toLocaleString('en-US');
const plural = (n, one, many) => `${count(n)} ${n === 1 ? one : many}`;
// A share that rounds to 0 but is not empty reads "<1" (as the label's formatShare does).
const percentOf = (share) => (share > 0 && share < 0.005 ? '<1' : String(Math.round(share * 100)));
const percent = (part, whole) => (whole > 0 ? percentOf(part / whole) : '0');
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * What a read gives a line: its data, or the words for loading or a failure.
 * A read the static demo did not record says so (its `detail`).
 *
 * @param {{ data?: any, error?: object|null }|null|undefined} read
 */
export function readState(read) {
  if (read?.error) {
    return { data: null, message: read.error.code === 'static_unavailable' && read.error.detail ? read.error.detail : FAILED };
  }
  if (read?.data == null) {
    return { data: null, message: LOADING };
  }
  return { data: read.data, message: null };
}

/** Chapters by Weak plus No data results, most first (ties by name), with their counts. */
export function carefulChapters(summary, chapterLabels = {}) {
  return (summary?.chapters ?? [])
    .map((entry) => ({
      id: entry.chapter_id,
      label: chapterLabels?.[entry.chapter_id] ?? entry.chapter_id,
      total: entry.total,
      weak: entry.counts?.weak ?? 0,
      noData: entry.counts?.no_data ?? 0,
      outOfScope: entry.counts?.out_of_scope ?? 0
    }))
    .filter((entry) => entry.weak + entry.noData > 0)
    .sort((a, b) => b.weak + b.noData - (a.weak + a.noData) || a.label.localeCompare(b.label));
}

/** Chapters with Out of scope results, most first (ties by name). */
function outOfScopeChapters(summary, chapterLabels = {}) {
  return (summary?.chapters ?? [])
    .map((entry) => ({ id: entry.chapter_id, label: chapterLabels?.[entry.chapter_id] ?? entry.chapter_id, outOfScope: entry.counts?.out_of_scope ?? 0 }))
    .filter((entry) => entry.outOfScope > 0)
    .sort((a, b) => b.outOfScope - a.outOfScope || a.label.localeCompare(b.label));
}

/** The catalogue tile's safety counts (open by severity, every incident by status). */
function tileSafety(tile) {
  const safety = tile?.safety ?? null;
  return safety
    ? { open: safety.open ?? 0, serious: safety.serious ?? 0, caution: safety.caution ?? 0, mitigated: safety.mitigated ?? 0, closed: safety.closed ?? 0 }
    : null;
}

const safetyTone = (safety) => (safety?.serious ? 'serious' : safety?.caution ? 'caution' : 'no_incidents');

/** "3 open: 2 serious, 1 caution." or the no-incident sentence (never "safe"). */
function openIncidentsText(safety, { plain = false } = {}) {
  if (!safety.open) {
    return plain ? 'No safety problem is reported as open. That does not mean it is safe.' : `None open. No reported incidents: ${NOT_SAFE_MEANING}.`;
  }
  if (plain) {
    return `${plural(safety.open, 'safety problem is', 'safety problems are')} open${safety.serious ? ` (${count(safety.serious)} serious)` : ''}. The condition cards describe them.`;
  }
  const parts = [safety.serious ? `${count(safety.serious)} serious` : null, safety.caution ? `${count(safety.caution)} caution` : null].filter(Boolean);
  return `${count(safety.open)} open: ${parts.join(', ')}.`;
}

/** The weighted shares as "28% strong, 52% moderate, …" in result order, leaving out zero shares. */
export function sharesText(shares) {
  return RESULT_KEYS.filter((key) => (shares?.[key] ?? 0) > 0)
    .map((key) => `${percentOf(shares[key])}% ${DISPLAY[key].label.toLowerCase()}`)
    .join(', ');
}

/** A strip of the weighted shares (the strip takes counts; shares in basis points keep the proportions). */
function sharesStrip(shares) {
  const counts = Object.fromEntries(RESULT_KEYS.map((key) => [key, Math.round((shares?.[key] ?? 0) * 10000)]));
  return { counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0), keys: RESULT_KEYS, label: sharesText(shares) };
}

/** The conductor mix and risk-of-bias levels of a list of studies. */
export function studyMix(studies = []) {
  const conductors = {};
  const risk = {};
  studies.forEach((study) => {
    if (study.conducted_by) conductors[study.conducted_by] = (conductors[study.conducted_by] ?? 0) + 1;
    if (study.risk_of_bias) risk[study.risk_of_bias] = (risk[study.risk_of_bias] ?? 0) + 1;
  });
  return { total: studies.length, conductors, risk };
}

function studyMixText(mix) {
  if (!mix.total) {
    return 'No study records for this AI system.';
  }
  const by = ['developer', 'independent', 'hospital']
    .filter((key) => mix.conductors[key])
    .map((key) => `${count(mix.conductors[key])} by ${CONDUCTOR_PHRASES[key]}`)
    .join(', ');
  const risk = ['low', 'some_concerns', 'high', 'unclear']
    .filter((key) => mix.risk[key])
    .map((key) => `${count(mix.risk[key])} ${RISK_OF_BIAS_LABELS[key].toLowerCase()}`)
    .join(', ');
  return `${plural(mix.total, 'study', 'studies')} of this AI system${by ? `: ${by}` : ''}.${risk ? ` Risk of bias: ${risk}.` : ''}`;
}

function studyItems(studies = []) {
  return studies.map(
    (study) =>
      `${study.study_id}: ${study.title} (${DESIGN_LABELS[study.design] ?? study.design}, by ${CONDUCTOR_PHRASES[study.conducted_by] ?? study.conducted_by}, risk of bias ${String(
        RISK_OF_BIAS_LABELS[study.risk_of_bias] ?? study.risk_of_bias
      ).toLowerCase()})`
  );
}

/** "cfg-2026-09, 1 September 2026", or null when the card states no configuration. */
function configurationText(functionEntry) {
  const record = functionEntry?.configuration ?? null;
  const id = text(record?.configuration_id);
  if (!id) return null;
  const date = formatReleaseDate(record?.configuration_date);
  return date ? `${id}, ${date}` : id;
}

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

function dateText(iso, format = DAY) {
  if (!iso) return null;
  const date = new Date(String(iso).length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(date.getTime()) ? null : format.format(date);
}

/** The tile's last update as "Version 37, 22 Oct 2026". */
function lastUpdatedText(tile) {
  const updated = tile?.last_updated;
  if (!updated) return null;
  const at = dateText(updated.at);
  return `Version ${updated.version}${at ? `, ${at}` : ''}`;
}

/** Incidents by the month they were reported, oldest first: [{ month: 'YYYY-MM', label, count }]. */
export function incidentsByMonth(incidents = []) {
  const months = new Map();
  incidents.forEach((incident) => {
    const month = String(incident.reported_date ?? '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(month)) months.set(month, (months.get(month) ?? 0) + 1);
  });
  return [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, total]) => ({ month, label: dateText(`${month}-01`, MONTH), count: total }));
}

/** Every incident by status: { open, mitigated, closed }. */
export function incidentStatusCounts(incidents = []) {
  return Object.fromEntries(['open', 'mitigated', 'closed'].map((status) => [status, incidents.filter((entry) => entry.status === status).length]));
}

/** The plain warnings of a condition card (here a chapter's), the function's requirement last, at most `limit`. */
export function plainWarnings(conceptMetrics, limit = 2) {
  const ranked = rankWarnings(conceptMetrics?.metrics?.warnings ?? []);
  const findings = ranked.filter((warning) => warning.code !== USE_CASE_REQUIREMENT);
  const requirement = ranked.filter((warning) => warning.code === USE_CASE_REQUIREMENT);
  return [...findings, ...requirement].slice(0, limit).map((warning) => ({ code: warning.code, text: warning.patientSummary ?? warning.title }));
}

const DATA_FIELDS = [
  { id: 'declared_data_use', label: 'What data it uses' },
  { id: 'declared_data_location', label: 'Where the data is kept' },
  { id: 'declared_retention', label: 'How long it is kept' },
  { id: 'declared_privacy_contact', label: 'Questions about your data' }
];

/** The four data-protection declarations given, in order, or [] (contract v1.14, §28.1). */
export function dataDeclarations(functionEntry) {
  const declarations = functionEntry?.declarations ?? null;
  return DATA_FIELDS.map((field) => ({ ...field, value: text(declarations?.[field.id]) })).filter((field) => field.value);
}

/** "End with a full stop." */
const sentence = (value) => (/[.!?]$/.test(value) ? value : `${value}.`);

// ------------------------------------------------------------- the five builders

function clinician({ summary, tile, hasIntendedUse = true, resultFor, chapterLabels }) {
  const summaryState = readState(summary);
  const tileState = readState(tile);
  const counts = summaryState.data?.counts ?? null;
  const total = summaryState.data?.total ?? 0;
  const chapters = carefulChapters(summaryState.data, chapterLabels);
  const safety = tileSafety(tileState.data);
  let careful = summaryState.message;
  if (counts && counts.no_data === total) {
    careful = `Every condition reads No data here: ${NO_DATA_MEANING}.`;
  } else if (counts && !chapters.length) {
    careful = 'No condition reads Weak or No data here.';
  } else if (counts) {
    careful = `${chapters
      .slice(0, 3)
      .map((entry, index) => {
        const n = entry.weak + entry.noData;
        return `${entry.label} (${count(n)}${index === 0 ? (n === 1 ? ' condition' : ' conditions') : ''})`;
      })
      .join(', ')}.`;
  }
  const outside = outOfScopeChapters(summaryState.data, chapterLabels);
  const out = counts?.out_of_scope ?? 0;
  const lines = [
    { id: 'careful', label: 'Most Weak or No data', text: careful, tone: 'weak', targetId: chapters[0]?.id ?? null },
    { id: 'incidents', label: 'Open safety incidents', text: safety ? openIncidentsText(safety) : tileState.message, tone: safetyTone(safety) },
    hasIntendedUse
      ? {
          id: 'out-of-scope',
          label: 'Out of scope',
          text: counts ? (out ? `${plural(out, 'condition', 'conditions')} (${percent(out, total)}%)${outside[0] ? `, most in ${outside[0].label}` : ''}.` : 'None.') : summaryState.message,
          tone: 'out_of_scope',
          targetId: outside[0]?.id ?? null
        }
      : { id: 'out-of-scope', label: 'Out of scope', text: 'No intended-use statement, so nothing is out of scope.', tone: 'out_of_scope' },
    { id: 'for', label: 'Results for', text: resultFor ?? LOADING, tone: 'population' }
  ];
  const more = counts
    ? [
        {
          id: 'chapters',
          title: 'Chapters with Weak or No data results',
          items: chapters.slice(0, 8).map((entry) => `${entry.label}: ${count(entry.weak)} weak, ${count(entry.noData)} no data, of ${count(entry.total)}`)
        },
        {
          id: 'meaning',
          title: 'What the words mean',
          items: [
            `No data: ${NO_DATA_MEANING}.`,
            ...(hasIntendedUse ? [`Out of scope: ${OUT_OF_SCOPE_MEANING}.`] : []),
            'These count results. On the Overview ring an open incident’s mark shows in place of a result.'
          ]
        }
      ].filter((group) => group.items.length)
    : [];
  return {
    lines,
    more,
    facts: {
      weak: counts?.weak ?? null,
      noData: counts?.no_data ?? null,
      outOfScope: hasIntendedUse ? counts?.out_of_scope ?? null : null,
      total: summaryState.data ? total : null,
      careful: chapters.slice(0, 3).map((entry) => ({ id: entry.id, weakOrNoData: entry.weak + entry.noData })),
      openIncidents: safety?.open ?? null,
      serious: safety?.serious ?? null
    }
  };
}

function patient({ summary, tile, entry, functionEntry, chapterCard, chapterLabels, instance }) {
  const summaryState = readState(summary);
  const tileState = readState(tile);
  const name = systemName(entry, 'This AI system');
  const category = functionCategoryPhrase(functionEntry?.function_category);
  const fn = displayUseCase(functionEntry?.use_case ?? '');
  const purpose = text(functionEntry?.declarations?.declared_intended_purpose);
  const safety = tileSafety(tileState.data);
  const counts = summaryState.data?.counts ?? null;
  const total = summaryState.data?.total ?? 0;
  const weakOrNone = counts ? (counts.weak ?? 0) + (counts.no_data ?? 0) : null;
  const chapters = carefulChapters(summaryState.data, chapterLabels);
  const warnings = chapterCard?.data && chapterCard.data.concept?.concept_id === chapters[0]?.id ? plainWarnings(chapterCard.data) : [];
  const declared = dataDeclarations(functionEntry);
  const use = declared.find((field) => field.id === 'declared_data_use');
  const note = text(instance?.data_protection_note);
  const lines = [
    {
      id: 'used',
      label: 'How it is used in care',
      text: `${name} helps with ${category ?? fn}${category && fn ? ` (${fn})` : ''}. ${
        purpose ? `The developer says: “${sentence(purpose)}” ${DECLARED}` : 'The developer has not stated what it is for.'
      }`,
      tone: 'info'
    },
    {
      id: 'incidents',
      label: 'What can go wrong',
      text: safety ? openIncidentsText(safety, { plain: true }) : tileState.message,
      tone: safetyTone(safety)
    },
    {
      id: 'weak',
      label: 'Where it is weak',
      text: counts ? `For ${count(weakOrNone)} of ${count(total)} conditions (${percent(weakOrNone, total)}%), the results are weak or there is no data.` : summaryState.message,
      tone: 'weak'
    },
    ...(warnings.length
      ? [{ id: 'warnings', label: `Warnings in ${chapters[0].label}`, text: warnings.map((warning) => warning.text).join(' '), tone: 'weak', targetId: chapters[0].id }]
      : []),
    {
      id: 'data',
      label: 'Your data',
      text: declared.length ? `${use ? sentence(use.value) : `${declared[0].label}: ${sentence(declared[0].value)}`} ${DECLARED}` : NO_DATA_DECLARATIONS,
      tone: 'info'
    },
    ...(note ? [{ id: 'note', label: `Note from ${text(instance?.organisation) || 'the organisation'}`, text: note, tone: 'info' }] : [])
  ];
  const more = [
    ...(declared.length
      ? [{ id: 'data', title: 'Your data, as the developer declares it', items: [...declared.map((field) => `${field.label}: ${field.value}`), DECLARED] }]
      : []),
    { id: 'meaning', title: 'What the words mean', items: [`No data: ${NO_DATA_MEANING}.`, `No reported incidents: ${NOT_SAFE_MEANING}.`] }
  ];
  return {
    lines,
    more,
    facts: {
      openIncidents: safety?.open ?? null,
      weakOrNoData: weakOrNone,
      total: summaryState.data ? total : null,
      warnings: warnings.map((warning) => warning.code),
      declarations: declared.map((field) => field.id),
      instanceNote: note || null
    }
  };
}

function populationFitLine(weighted, resultFor) {
  const state = readState(weighted);
  const shares = state.data?.weighted_distribution ?? null;
  return {
    line: {
      id: 'fit',
      label: 'Population fit',
      text: shares ? `${sharesText(shares)}, weighted by how common each condition is, for ${resultFor ?? 'this population'}.` : state.message,
      tone: 'population',
      strip: shares ? sharesStrip(shares) : null
    },
    shares
  };
}

function procurement({ weighted, tile, functionEntry, studies, resultFor }) {
  const fit = populationFitLine(weighted, resultFor);
  const tileState = readState(tile);
  const studiesState = readState(studies);
  const declarations = functionEntry?.declarations ?? null;
  const status = text(declarations?.declared_regulatory_status);
  const docs = text(declarations?.declared_documentation_url);
  const href = /^https?:\/\/[^\s]+$/i.test(docs) ? docs : null;
  const mix = studiesState.data ? studyMix(studiesState.data.studies ?? []) : null;
  const safety = tileSafety(tileState.data);
  const counts = readState(weighted).data?.counts ?? null;
  const lines = [
    fit.line,
    {
      id: 'regulatory',
      label: 'Regulatory status',
      text: status ? `${sentence(status)} ${DECLARED}` : 'Not declared by the developer.',
      tone: 'info',
      href,
      hrefText: href ? 'Documentation' : null
    },
    { id: 'studies', label: 'Evidence', text: mix ? studyMixText(mix) : studiesState.message, tone: 'info' },
    { id: 'incidents', label: 'Open safety incidents', text: safety ? openIncidentsText(safety) : tileState.message, tone: safetyTone(safety) },
    { id: 'configuration', label: 'Configuration', text: configurationText(functionEntry) ?? 'Not stated.', tone: 'info' },
    { id: 'updated', label: 'Card updated', text: tileState.data ? lastUpdatedText(tileState.data) ?? 'Not known.' : tileState.message, tone: 'info' }
  ];
  const more = [
    ...(counts
      ? [{ id: 'unweighted', title: 'Counted by condition instead (each counts once)', items: RESULT_KEYS.filter((key) => counts[key]).map((key) => `${DISPLAY[key].label}: ${count(counts[key])}`) }]
      : []),
    ...(studiesState.data?.studies?.length ? [{ id: 'studies', title: 'Studies of this AI system', items: studyItems(studiesState.data.studies) }] : [])
  ];
  return {
    lines,
    more,
    facts: {
      shares: fit.shares,
      studies: mix ? mix.total : null,
      conductors: mix?.conductors ?? null,
      riskOfBias: mix?.risk ?? null,
      openIncidents: safety?.open ?? null,
      lastUpdated: tileState.data?.last_updated?.version ?? null
    }
  };
}

function regulator({ incidents, versions, functionEntry, system }) {
  const incidentsState = readState(incidents);
  const versionsState = readState(versions);
  const list = incidentsState.data?.incidents ?? null;
  const months = list ? incidentsByMonth(list) : [];
  const statuses = list ? incidentStatusCounts(list) : null;
  const changes = versionsState.data?.versions ?? null;
  const latest = changes?.[0] ?? null;
  const lineage = system?.lineage ?? null;
  const lineageText = lineage
    ? [lineage.replaces ? `Replaces ${lineage.replaces.label}.` : null, lineage.replacedBy.length ? `Replaced by ${lineage.replacedBy.map((item) => item.label).join(', ')}.` : null]
        .filter(Boolean)
        .join(' ')
    : 'No earlier or later version recorded.';
  const lines = [
    {
      id: 'incidents-time',
      label: 'Incidents by month reported',
      text: list ? (months.length ? months.map((entry) => `${entry.label}: ${entry.count}`).join(', ') : `None reported. No reported incidents: ${NOT_SAFE_MEANING}.`) : incidentsState.message,
      tone: 'info'
    },
    {
      id: 'incidents-now',
      label: 'Incidents by status now',
      text: statuses ? `${count(statuses.open)} open, ${count(statuses.mitigated)} mitigated, ${count(statuses.closed)} closed.` : incidentsState.message,
      // Serious when an open incident is serious, as the other audiences' safety lines are.
      tone: list?.some((entry) => entry.status === 'open' && entry.severity === 'serious') ? 'serious' : statuses?.open ? 'caution' : 'no_incidents'
    },
    {
      id: 'changes',
      label: 'Changes to this card',
      text: changes
        ? changes.length
          ? `${plural(changes.length, 'published version', 'published versions')} changed it; the latest is version ${latest.version_id}${dateText(latest.published_at) ? `, ${dateText(latest.published_at)}` : ''}.`
          : 'No published version changed it.'
        : versionsState.message,
      tone: 'info'
    },
    { id: 'configuration', label: 'Configuration', text: configurationText(functionEntry) ?? 'Not stated.', tone: 'info' },
    { id: 'lineage', label: 'Versions of the AI system', text: lineageText, tone: 'info' }
  ];
  const more = [
    ...(list?.length
      ? [{
          id: 'incidents',
          title: 'Incidents, newest first',
          items: list.map(
            (incident) =>
              `${dateText(incident.reported_date) ?? incident.reported_date}, ${INCIDENT_STATUS_LABELS[incident.status] ?? incident.status}, ${
                INCIDENT_TYPE_LABELS[incident.incident_type] ?? incident.incident_type
              } (${incident.incident_id})`
          )
        }]
      : []),
    ...(changes?.length
      ? [{
          id: 'versions',
          title: 'Versions that changed this card, newest first',
          items: changes.map((entry) => `Version ${entry.version_id}${dateText(entry.published_at) ? `, ${dateText(entry.published_at)}` : ''}: ${entry.summary}`)
        }]
      : [])
  ];
  return {
    lines,
    more,
    facts: {
      incidentsByMonth: months.map(({ month, count: total }) => ({ month, count: total })),
      incidentStatuses: statuses,
      versions: changes ? changes.map((entry) => entry.version_id) : null,
      latestVersion: latest?.version_id ?? null
    }
  };
}

function payer({ effects, evidence, studies, weighted, resultFor }) {
  const effectsState = readState(effects);
  const evidenceState = readState(evidence);
  const studiesState = readState(studies);
  const list = effectsState.data?.effects ?? null;
  const studyIds = list ? [...new Set(list.map((effect) => effect.study_id))] : [];
  let effectsText = effectsState.message;
  if (list && !list.length) {
    effectsText = 'None recorded for this card. Grades cover predictive performance only.';
  } else if (list) {
    effectsText = `${plural(list.length, 'effect', 'effects')} from ${plural(studyIds.length, 'study', 'studies')}. ${list
      .slice(0, 2)
      .map((effect) => `${effect.outcome}: ${effectSentence(effect)}`)
      .join(' ')} Not part of any grade.`;
  }
  const counts = evidenceState.data?.counts ?? null;
  const total = evidenceState.data?.total ?? 0;
  const mix = studiesState.data ? studyMix(studiesState.data.studies ?? []) : null;
  const fit = populationFitLine(weighted, resultFor);
  const lines = [
    { id: 'effects', label: 'Effects on outcomes', text: effectsText, tone: 'info' },
    {
      id: 'evidence',
      label: 'Evidence grades',
      text: counts
        ? `${RESULT_KEYS.filter((key) => counts[key]).map((key) => `${count(counts[key])} ${DISPLAY[key].label.toLowerCase()}`).join(', ')}, of ${count(total)} conditions.`
        : evidenceState.message,
      tone: 'info',
      strip: counts ? { counts, total, keys: RESULT_KEYS } : null
    },
    { id: 'studies', label: 'Studies', text: mix ? studyMixText(mix) : studiesState.message, tone: 'info' },
    fit.line
  ];
  const more = list?.length
    ? [{ id: 'effects', title: 'Effects on outcomes', items: list.map((effect) => `${effect.outcome}: ${effectSentence(effect)} ${effectNumbers(effect)}. Study ${effect.study_id}.`) }]
    : [];
  return {
    lines,
    more,
    facts: {
      effects: list ? list.map((effect) => effect.effect_id) : null,
      evidence: counts ? Object.fromEntries(RESULT_KEYS.map((key) => [key, counts[key] ?? 0])) : null,
      studies: mix ? mix.total : null,
      shares: fit.shares
    }
  };
}

const BUILDERS = { clinician, patient, procurement, regulator, payer };

/** Which reads a preset needs (useAudienceSummary.js reads only these). */
export const AUDIENCE_READS = Object.freeze({
  clinician: Object.freeze(['summary', 'tile']),
  patient: Object.freeze(['summary', 'tile', 'chapterCard', 'instance']),
  procurement: Object.freeze(['weighted', 'tile', 'studies']),
  regulator: Object.freeze(['incidents', 'versions']),
  payer: Object.freeze(['effects', 'evidence', 'studies', 'weighted'])
});

/**
 * The audience summary for a preset, or null without one.
 *
 * @param {string|null} audience
 * @param {object} input the reads (`{ data, error }` each) and card facts the builders take
 */
export function audienceSummary(audience, input = {}) {
  const build = BUILDERS[audience];
  if (!build) {
    return null;
  }
  return {
    audience,
    audienceLabel: audienceLabel(audience),
    title: AUDIENCE_TITLES[audience],
    ...build(input),
    notice: SYNTHETIC_NOT_CLINICAL
  };
}
