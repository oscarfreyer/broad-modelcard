// The live panel's content, as plain data: a view
// model from the lookup response, then a DOM model (`{ tag, attrs, children }`
// trees) that dom.js turns into elements. Pure and React-free, so node tests
// read exactly what the panel shows.
//
// The panel speaks the atlas card's language: statuses through status.js and
// the one mark per state (design/markShapes.js), warnings and safeguards
// through the card's copy modules (features/details/copy/), the same
// requirement line, and the same ranking; incidents through the card's
// incident copy (features/details/copy/incidentCopy.js), in the card's order.
import { BRAND_COLORS, BRAND_VIEWBOX, brandBubbles } from '../design/brandMark.js';
import { markShapes } from '../design/markShapes.js';
import { INTENDED_USE_LEVELS, NO_STATEMENT_TEXT, STATUS_ORDER, displayFor, hasIntendedUseStatement } from '../design/status.js';
import { aboutResult, lensFallbackSentence } from '../features/details/copy/aboutResult.js';
import { describeSafeguards } from '../features/details/copy/safeguardCopy.js';
import { USE_CASE_REQUIREMENT, rankWarnings, warningScope } from '../features/details/copy/warningCopy.js';
import { kindLabel } from '../shared/aiSystem.js';
import { displayTerm } from '../shared/conceptName.js';
import { displayUseCase } from '../shared/format.js';
import {
  describeIncident,
  incidentsMarkWord,
  latestIncidentDate,
  openIncidentChip,
  sortIncidents
} from '../features/details/copy/incidentCopy.js';
import { LENS_CHOICES } from './panelInputs.js';
import { resultPopulationLabel } from '../shared/resultPopulation.js';
import { settingOfCode } from '../shared/careSetting.js';

/** Always on the panel, in every state (K10, R18). */
export const DEMO_LINE = 'Demonstration, synthetic data, not for clinical use';

/** The views under the Overview lead, in the card's order. */
export const PANEL_VIEWS = Object.freeze([
  { id: 'performance', label: 'Performance' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'intended_use', label: 'Intended use' }
]);

/** How many warnings and safeguards each block shows before "+n more". */
export const TOP_WARNINGS = 2;
export const TOP_SAFEGUARDS = 2;

// ---------------------------------------------------------------------------
// View model

/**
 * The display key of a lookup status for one view, by the card's rules: an
 * unknown or missing status is No data on every view, including Intended use
 * (status.js, "One rule for no row").
 */
export function lookupStatus(statuses, viewId) {
  const value = statuses?.[viewId];
  if (viewId === 'intended_use') {
    return INTENDED_USE_LEVELS.includes(value) ? value : 'no_data';
  }
  return STATUS_ORDER.includes(value) ? value : 'no_data';
}

/** Safety display key: Serious or Caution, else the neutral mark (never green). */
export function safetyStatus(mark) {
  return mark === 'serious' || mark === 'caution' ? mark : 'no_incidents';
}

function statusesOf(statuses) {
  return Object.fromEntries(['overall', ...PANEL_VIEWS.map((view) => view.id)].map((viewId) => [viewId, lookupStatus(statuses, viewId)]));
}

/**
 * Warnings and safeguards as the atlas card presents them: the function's
 * policy (clinician review) once as the requirement, the other warnings
 * ranked by relevance, safeguards in API order.
 */
export function presentFindings({ warnings, safeguards, source }, depth) {
  const expert = depth === 'expert';
  const requirement = (warnings || []).find((warning) => warning.code === USE_CASE_REQUIREMENT);
  const requirementCopy = requirement ? rankWarnings([requirement])[0] : null;
  const ranked = rankWarnings((warnings || []).filter((warning) => warning.code !== USE_CASE_REQUIREMENT)).map((warning) => ({
    code: warning.code,
    title: warning.title,
    text: expert ? warning.expertSummary : warning.patientSummary,
    relevance: warning.relevance,
    scope: warningScope(warning, source)
  }));
  const described = describeSafeguards(safeguards).map((safeguard) => ({
    id: safeguard.id,
    title: safeguard.title,
    text: expert ? safeguard.expertSummary : safeguard.patientSummary,
    actions: expert ? safeguard.actions : []
  }));
  return {
    requirement: requirementCopy ? { title: requirementCopy.title, text: expert ? requirementCopy.expertSummary : requirementCopy.patientSummary } : null,
    warnings: ranked.slice(0, TOP_WARNINGS),
    moreWarnings: Math.max(0, ranked.length - TOP_WARNINGS),
    safeguards: described.slice(0, TOP_SAFEGUARDS),
    moreSafeguards: Math.max(0, described.length - TOP_SAFEGUARDS)
  };
}

function hasNoResult(statuses) {
  return Object.values(statuses).every((status) => status === 'no_data');
}

function conditionModel(condition, { depth, resolveHref }) {
  if (!condition?.matched) {
    return { matched: false, code: String(condition?.code ?? '') };
  }
  const statuses = statusesOf(condition.statuses);
  const name = displayTerm(condition.pt) || condition.code;
  const all = condition.incidents || [];
  // The card's order (Serious, Caution, then closed); the panel lists the
  // marked ones and counts the closed ones, which the full card lists.
  const incidents = sortIncidents(all).map((incident) => describeIncident(incident));
  const shown = incidents.filter((incident) => incident.mark);
  const noResult = hasNoResult(statuses);
  return {
    matched: true,
    code: condition.icd11_code || condition.code,
    name,
    statuses,
    safety: safetyStatus(condition.safety),
    // "No open incidents" when only closed incidents apply, as on the card.
    safetyWord: incidentsMarkWord(all),
    // In the words of the card header chip, e.g. "1 open serious incident"; null when none is open.
    openIncidentText: openIncidentChip(all)?.text ?? null,
    closedIncidents: incidents.length - shown.length,
    incidents: shown.map((incident) => ({
      id: incident.id,
      mark: incident.mark,
      type: incident.type,
      status: incident.status,
      date: latestIncidentDate(incident),
      summary: incident.summary
    })),
    noResult,
    about: noResult ? aboutResult({ concept: { pt: name, level: 2 }, row: null, depth })[0] : null,
    fallback: fallbackOf(condition.provenance, depth),
    ...presentFindings({ warnings: condition.warnings, safeguards: condition.safeguards, source: condition.provenance?.source }, depth),
    href: resolveHref(condition.card_url)
  };
}

/** The card's lens fallback sentence when the row stands in for the exact population, else null. */
function fallbackOf(provenance, depth) {
  return provenance?.lens_fallback ? lensFallbackSentence(depth) : null;
}

/**
 * The combination, when the matched codes name at least two distinct
 * conditions (depth-1 anchors: CA40 and CA40.0 are one condition), as the
 * lookup decides it (CONTRACT.md §19).
 */
function combinationModel(combination, conditions, { depth, resolveHref }) {
  const anchors = new Set(conditions.filter((condition) => condition?.matched).map((condition) => condition.anchor_id ?? condition.concept_id ?? condition.code));
  if (anchors.size < 2) {
    return null;
  }
  if (!combination) {
    return { stored: false };
  }
  return {
    stored: true,
    label: combination.label || (combination.concept_ids || []).join(' + '),
    statuses: statusesOf(combination.statuses),
    // No safety line: a combination has no incidents of its own (the
    // incidents of its conditions show on their blocks), as in Multimorbidity.
    fallback: fallbackOf(combination.provenance, depth),
    ...presentFindings({ warnings: combination.warnings, safeguards: combination.safeguards, source: combination.provenance?.source }, depth),
    href: resolveHref(combination.card_url)
  };
}

/**
 * Who the case's results are for before the answer arrives (loading, error),
 * in the words the answer uses: "Age 65+, Female, default prevalence".
 */
export function populationLine(inputs) {
  const chosen = inputs?.lens ?? {};
  const sex = LENS_CHOICES.sex[chosen.sex];
  const ethnicity = LENS_CHOICES.ethnicity[chosen.ethnicity];
  return resultPopulationLabel(
    {
      age: LENS_CHOICES.age_group[chosen.age_group] ?? 'All ages',
      sex: sex ? `Sex ${sex}` : 'All sexes',
      ethnicity: ethnicity ? `Ethnicity ${ethnicity}` : 'All ethnicities'
    },
    // The answer names the local population; until then, only that it is one.
    inputs?.population ? { id: inputs.population, name: 'local prevalence' } : null,
    { setting: settingOfCode(inputs?.setting) }
  );
}

const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** "14:32" for the time the panel last confirmed its answer. */
export function formatUpdatedTime(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? TIME.format(date) : null;
}

/**
 * The panel's view model for a lookup response.
 *
 * @param {object} response the lookup response (R17)
 * @param {object} options
 * @param {object} options.inputs readPanelInputs() result
 * @param {(url: string|null|undefined) => string|null} options.resolveHref resolves a relative card link
 * @param {Date|null} [options.updatedAt]
 */
export function panelViewModel(response, { inputs, resolveHref = () => null, updatedAt = null }) {
  const depth = inputs?.depth === 'expert' ? 'expert' : 'plain';
  const card = response?.card ?? {};
  // A card without an intended-use statement (v1.11) says so on its Intended use row, not No data.
  const flag = (block) => (block?.statuses && !hasIntendedUseStatement(card) ? { ...block, noStatement: true } : block);
  const conditions = (response?.conditions || []).map((condition) => flag(conditionModel(condition, { depth, resolveHref })));
  const combination = flag(combinationModel(response?.combination, response?.conditions || [], { depth, resolveHref }));
  // The function's policy (clinician review) is a fact of the card, not of a
  // condition: the panel says it once, under the card, as the atlas card does
  // under its title.
  const requirement = [...conditions, combination].find((block) => block?.requirement)?.requirement ?? null;
  return {
    depth,
    card: {
      name: card.display_name || card.model_version || inputs?.model || '',
      kind: card.kind ? kindLabel(card) : null,
      functionName: card.use_case || inputs?.useCase || '',
      href: resolveHref(card.card_url)
    },
    // Who the answer is for, worded as on the atlas card (resultPopulation.js).
    population: response?.lens
      ? resultPopulationLabel(response.lens, response.population ?? null, { setting: response.lens.context ?? null })
      : populationLine(inputs),
    requirement,
    conditions,
    combination,
    datasetVersion: response?.dataset_version ?? null,
    updated: formatUpdatedTime(updatedAt),
    ignored: { codes: inputs?.ignored?.codes ?? 0, lens: inputs?.ignored?.lens ?? [] }
  };
}

// ---------------------------------------------------------------------------
// DOM model

/** A DOM model node. `attrs.class` is the class list; children are nodes or text. */
export function h(tag, attrs, ...children) {
  return { tag, attrs: attrs || {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== '') };
}

const SVG_ATTRIBUTE = { className: 'class' };

/** The one mark of a state as an inline SVG icon (same shapes as StatusMark). */
export function markNode(status, size = 12) {
  const half = size / 2;
  return h(
    'svg',
    { class: 'status-mark', width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true', focusable: 'false', 'data-status': status },
    markShapes(status, { cx: half, cy: half, r: half - 1 }).map((shape) =>
      h(shape.type, Object.fromEntries(Object.entries(shape.props).map(([name, value]) => [SVG_ATTRIBUTE[name] ?? name, value])))
    )
  );
}

// Interface icons: the same 24-unit paths as design/Icon.jsx (which is React).
const ICON_PATHS = {
  warning: ['M12 4.25 20.5 19H3.5z', 'M12 10v4M12 16.5v.5'],
  shield: ['M12 3.75 18.75 6v5.5c0 4-2.5 7-6.75 8.75C7.75 18.5 5.25 15.5 5.25 11.5V6z'],
  externalLink: ['M13.75 4.75h5.5v5.5M19.25 4.75l-8 8', 'M17.25 13.75v5.5H4.75V6.75h5.5'],
  info: ['M12 11v5.25M12 7.75v.5']
};

export function iconNode(name, size = 16) {
  return h(
    'svg',
    { class: `p-icon p-icon-${name}`, width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    name === 'info' ? h('circle', { cx: 12, cy: 12, r: 8.25 }) : null,
    ICON_PATHS[name].map((d) => h('path', { d }))
  );
}

/** The brand mark (design/brandMark.js), at 18 px: the small ring of bubbles. */
function brandMark() {
  const size = 18;
  return h('svg', { class: 'p-brand-mark', width: size, height: size, viewBox: `0 0 ${BRAND_VIEWBOX} ${BRAND_VIEWBOX}`, 'aria-hidden': 'true', focusable: 'false' },
    brandBubbles(size).map(({ cx, cy, r, tone }) => h('circle', { cx, cy, r, fill: BRAND_COLORS[tone] }))
  );
}

function statusWord(status, className = '', word = null) {
  const { label, tone } = displayFor(status);
  return h('span', { class: `p-word tone-${tone}${className ? ` ${className}` : ''}` }, word ?? label);
}

const RELEVANCE_TONE = { High: 'weak', Medium: 'moderate', Low: 'absent' };

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function resultBlock(model, { label }) {
  return [
    h('p', { class: 'p-lead' }, markNode(model.statuses.overall, 16), statusWord(model.statuses.overall, 'p-lead-word'), h('span', { class: 'p-lead-view' }, label)),
    h(
      'ul',
      { class: 'p-views', 'aria-label': 'Results by view' },
      PANEL_VIEWS.map((view) =>
        view.id === 'intended_use' && model.noStatement
          ? h('li', { class: 'p-view', title: NO_STATEMENT_TEXT }, h('span', { class: 'p-view-label' }, view.label), h('span', { class: 'p-word tone-absent' }, 'No statement'))
          : h('li', { class: 'p-view' }, markNode(model.statuses[view.id]), h('span', { class: 'p-view-label' }, view.label), statusWord(model.statuses[view.id]))
      )
    )
  ];
}

/** True when an open (or mitigated) incident marks the condition Serious or Caution. */
function isAlert(model) {
  return model.safety === 'serious' || model.safety === 'caution';
}

/**
 * The condition's safety line. A Serious or Caution mark leads at the size of
 * the overall result, right under the condition's name, so a glance never
 * lands on a good grade above an open incident (incidents never change the
 * grade). No incidents stay a quiet line under the views, never green.
 */
function safetyLine(model) {
  const alert = isAlert(model);
  const parts = [
    markNode(model.safety, alert ? 16 : 12),
    statusWord(model.safety, alert ? 'p-safety-word p-lead-word' : 'p-safety-word', model.safety === 'no_incidents' ? model.safetyWord : null)
  ];
  if (model.safety !== 'no_incidents' && model.openIncidentText) {
    parts.push(h('span', { class: 'p-safety-count' }, model.openIncidentText));
  }
  if (model.safety === 'no_incidents' && model.closedIncidents) {
    parts.push(h('span', { class: 'p-safety-count' }, `${plural(model.closedIncidents, 'closed incident', 'closed incidents')} on the full card`));
  }
  return h('p', { class: alert ? 'p-safety is-alert' : 'p-safety' }, h('span', { class: 'p-view-label' }, 'Safety'), parts);
}

function requirementNode(requirement) {
  if (!requirement) return null;
  return h('p', { class: 'p-requirement' }, iconNode('shield'), h('span', null, h('strong', null, `${requirement.title}.`), ` ${requirement.text}`));
}

const SEVERITY_RANK = { serious: 2, caution: 1 };

/**
 * Two or more conditions: the combination (or its absence) leads, so the
 * case's open incidents are said first, at the lead's size, before any grade:
 * "Safety ! Serious 1 open serious incident, Melanoma of skin".
 */
function caseSafetyNode(conditions) {
  const matched = conditions.filter((condition) => condition.matched);
  const alerts = matched.filter(isAlert).sort((a, b) => SEVERITY_RANK[b.safety] - SEVERITY_RANK[a.safety]);
  if (matched.length < 2 || !alerts.length) return null;
  const worst = alerts[0].safety;
  return h('p', { class: 'p-safety is-alert p-case-safety' },
    h('span', { class: 'p-view-label' }, 'Safety in this case'),
    markNode(worst, 16),
    statusWord(worst, 'p-safety-word p-lead-word'),
    h('span', { class: 'p-safety-count' }, alerts.map((condition) => `${condition.openIncidentText ?? displayFor(condition.safety).label}: ${condition.name}`).join('; '))
  );
}

function findingsBlock(model) {
  const blocks = [];
  if (model.warnings.length) {
    blocks.push(
      h('h4', { class: 'p-group' }, 'Top warnings'),
      h(
        'ul',
        { class: 'p-list' },
        model.warnings.map((warning) =>
          h(
            'li',
            { class: 'p-item' },
            h('span', { class: 'p-item-main' },
              h('span', { class: 'p-item-title' }, warning.title),
              warning.scope ? h('span', { class: 'p-item-scope' }, warning.scope) : null,
              h('span', { class: 'p-item-text' }, warning.text)
            ),
            h('span', { class: `p-chip tone-${RELEVANCE_TONE[warning.relevance] ?? 'absent'}` }, warning.relevance)
          )
        )
      ),
      model.moreWarnings ? h('p', { class: 'p-more' }, `+${plural(model.moreWarnings, 'more warning', 'more warnings')} on the full card`) : null
    );
  }
  if (model.safeguards.length) {
    blocks.push(
      h('h4', { class: 'p-group' }, 'Recommended safeguards'),
      h(
        'ul',
        { class: 'p-list' },
        model.safeguards.map((safeguard) =>
          h(
            'li',
            { class: 'p-item' },
            h('span', { class: 'p-item-main' },
              h('span', { class: 'p-item-title' }, safeguard.title),
              h('span', { class: 'p-item-text' }, safeguard.text),
              safeguard.actions.length ? h('ul', { class: 'p-actions' }, safeguard.actions.map((action) => h('li', null, action))) : null
            )
          )
        )
      ),
      model.moreSafeguards ? h('p', { class: 'p-more' }, `+${plural(model.moreSafeguards, 'more safeguard', 'more safeguards')} on the full card`) : null
    );
  }
  return blocks;
}

function incidentsBlock(incidents) {
  if (!incidents.length) return null;
  return [
    h('h4', { class: 'p-group' }, 'Safety incidents'),
    h(
      'ul',
      { class: 'p-list' },
      incidents.map((incident) =>
        h(
          'li',
          { class: 'p-item p-incident' },
          h('span', { class: 'p-item-main' },
            h('span', { class: 'p-incident-head' }, markNode(incident.mark), statusWord(incident.mark), h('span', { class: 'p-item-title' }, incident.type)),
            h('span', { class: 'p-item-text' }, incident.summary),
            h('span', { class: 'p-item-meta' }, [incident.status, incident.date, incident.id].filter(Boolean).join(', '))
          )
        )
      )
    )
  ];
}

function cardLink(href, text, className, focusKey) {
  if (!href) return null;
  return h('a', { class: className, href, target: '_blank', rel: 'noopener noreferrer', 'data-focus-key': focusKey }, text, iconNode('externalLink', 14));
}

function fallbackNote(text) {
  return text ? h('p', { class: 'p-about p-fallback' }, iconNode('info', 16), h('span', null, text)) : null;
}

function conditionNode(model) {
  if (!model.matched) {
    return h('li', { class: 'p-condition is-unmatched' },
      h('p', { class: 'p-unmatched' }, h('span', { class: 'p-code' }, model.code), ': not one of the ICD-11 conditions on this card.')
    );
  }
  return h(
    'li',
    { class: 'p-condition' },
    h('h3', { class: 'p-cond-name' }, model.name, ' ', h('span', { class: 'p-code' }, model.code)),
    isAlert(model) ? safetyLine(model) : null,
    resultBlock(model, { label: 'Overview' }),
    isAlert(model) ? null : safetyLine(model),
    model.about ? h('p', { class: 'p-about' }, model.about) : null,
    fallbackNote(model.fallback),
    findingsBlock(model),
    incidentsBlock(model.incidents),
    cardLink(model.href, `Open ${model.name} on the card`, 'p-link p-cond-link', `condition:${model.code}`)
  );
}

function combinationNode(model) {
  if (!model) return null;
  if (!model.stored) {
    return h('section', { class: 'p-combination is-absent', 'aria-label': 'Combination' },
      h('p', { class: 'p-lead' }, markNode('no_combination', 16), statusWord('no_combination', 'p-lead-word')),
      h('p', { class: 'p-about' }, 'No result is stored for this exact combination of conditions on this card. Each condition below is shown on its own.')
    );
  }
  return h(
    'section',
    { class: 'p-combination', 'aria-label': 'Stored combination' },
    h('h3', { class: 'p-cond-name' }, model.label),
    h('p', { class: 'p-combination-note' }, 'Stored result for this combination of conditions, not combined from the single results below.'),
    resultBlock(model, { label: 'Overview' }),
    fallbackNote(model.fallback),
    findingsBlock(model),
    cardLink(model.href, 'Open the combination on the card', 'p-link p-cond-link', 'combination')
  );
}

// The lens attributes in words, for the ignored-values note.
const LENS_WORDS = { 'age-group': 'age group', sex: 'sex', ethnicity: 'ethnicity', setting: 'setting' };

function listWords(words) {
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0];
}

function ignoredNote(ignored) {
  const parts = [];
  if (ignored.codes) parts.push(`${plural(ignored.codes, 'entry', 'entries')} ignored: not an ICD-11 code or over the limit of 8 codes`);
  const groups = ignored.lens.filter((name) => name !== 'setting');
  if (groups.length) {
    const words = listWords(groups.map((name) => LENS_WORDS[name] ?? name));
    parts.push(`The ${words} given ${groups.length === 1 ? 'is' : 'are'} not a population group the panel knows, so it shows all patients on ${groups.length === 1 ? 'that axis' : 'those axes'}`);
  }
  // A care setting the panel does not know (contract v1.14) reads as any setting.
  if (ignored.lens.includes('setting')) parts.push('The setting given is not a care setting the panel knows, so it shows any setting');
  return parts.length ? h('p', { class: 'p-ignored' }, iconNode('info', 16), h('span', null, `${parts.join('. ')}.`)) : null;
}

function header() {
  return [
    h('header', { class: 'p-brand' }, brandMark(), h('span', { class: 'p-brand-name' }, 'Broad Modelcard'), h('span', { class: 'p-brand-job' }, 'Where this case sits on the card')),
    h('p', { class: 'p-demo', role: 'note' }, iconNode('warning'), h('strong', null, DEMO_LINE))
  ];
}

function cardHead(card, population, requirement = null) {
  return h('div', { class: 'p-card' },
    h('h2', { class: 'p-system' }, card.name, card.kind ? [' ', h('span', { class: 'p-kind' }, card.kind)] : null),
    card.functionName ? h('p', { class: 'p-function' }, displayUseCase(card.functionName)) : null,
    h('p', { class: 'p-population' }, population),
    requirementNode(requirement)
  );
}

const ERROR_COPY = {
  unavailable: {
    title: 'The Broad Modelcard backend is not reachable',
    text: 'The panel cannot look up this case right now. Start the app, then return to this window.',
    command: 'npm run dev'
  },
  invalid: { title: 'The panel could not read this case', text: 'The lookup rejected the request.' },
  local_only: {
    title: 'The Broad Modelcard API answers this machine only',
    text: 'Serve the page that holds the panel from this machine, through the app’s server, which passes /api on to the backend.'
  },
  unknown_card: {
    title: 'Broad Modelcard has no card for this AI system and function',
    text: 'Check the AI system and function the host page names for this panel.'
  },
  unknown_population: {
    title: 'Broad Modelcard has no such local population',
    text: 'Check the local population the host page names for this panel, or leave it out for the default prevalence.'
  },
  no_lookup: {
    title: 'This backend has no lookup yet',
    text: 'The live panel needs the lookup operation of contract v1.8. Update the backend and try again.'
  },
  failed: { title: 'The lookup did not answer', text: 'Something went wrong while looking up this case.' }
};

/**
 * The panel's DOM model for a controller state.
 *
 * @param {object} state
 * @param {'empty'|'loading'|'ready'|'error'} state.phase
 * @param {object} state.inputs
 * @param {object|null} [state.view] panelViewModel() result (ready, or a refresh in flight)
 * @param {string|null} [state.missing] 'card' or 'codes' (empty)
 * @param {{ kind: string, detail?: string|null }|null} [state.error]
 * @param {boolean} [state.refreshing]
 */
export function renderPanel(state) {
  const { phase, inputs, view, missing, error, refreshing = false } = state;
  const body = [];
  if (phase === 'empty') {
    body.push(
      h('p', { class: 'p-empty' },
        missing === 'card'
          ? 'Choose an AI system and its function: the panel looks the case up on that card.'
          : 'Add one or more ICD-11 codes (for example 5A11) to see where the case sits on this card.'
      ),
      inputs ? ignoredNote(inputs.ignored) : null
    );
  } else if (phase === 'loading' && !view) {
    body.push(
      cardHead({ name: inputs.model, functionName: inputs.useCase }, populationLine(inputs)),
      h('ol', { class: 'p-conditions' },
        inputs.codes.map((code) =>
          h('li', { class: 'p-condition is-loading' }, h('p', { class: 'p-lead' }, markNode('loading', 16), h('span', { class: 'p-code' }, code), h('span', { class: 'p-word tone-absent' }, 'Looking up the card')))
        )
      )
    );
  } else if (phase === 'error') {
    const copy = ERROR_COPY[error?.kind] ?? ERROR_COPY.failed;
    // An unknown card's names are not shown back: the registry does not know
    // them, and they could be anything the host page put in its attributes.
    const knownCard = error?.kind !== 'unknown_card';
    body.push(
      inputs && knownCard ? cardHead({ name: inputs.model, functionName: inputs.useCase }, populationLine(inputs)) : null,
      h('div', { class: 'p-error', role: 'alert' },
        h('p', { class: 'p-error-title' }, iconNode('warning'), copy.title),
        h('p', { class: 'p-error-text' }, error?.detail && error.kind === 'invalid' ? error.detail : copy.text),
        copy.command ? h('code', { class: 'p-command' }, copy.command) : null
      )
    );
  } else if (view) {
    body.push(
      cardHead(view.card, view.population, view.requirement),
      ignoredNote(view.ignored),
      caseSafetyNode(view.conditions),
      // Two or more conditions: the combination answers the case, so it leads.
      combinationNode(view.combination),
      h('ol', { class: 'p-conditions' }, view.conditions.map(conditionNode)),
      h('footer', { class: 'p-foot' },
        refreshing
          ? h('p', { class: 'p-version is-updating' }, h('span', { class: 'p-updating-dot', 'aria-hidden': 'true' }), 'Updating')
          : h('p', { class: 'p-version' },
              view.datasetVersion ? `Dataset version ${view.datasetVersion}` : null,
              view.datasetVersion && view.updated ? ', ' : null,
              view.updated ? `Updated ${view.updated}` : null
            ),
        cardLink(view.card.href, 'Open the full card', 'p-link p-card-link', 'card')
      )
    );
  }
  return h(
    'section',
    { class: `p-panel is-${phase}`, 'aria-label': 'Broad Modelcard live panel', 'aria-busy': phase === 'loading' || refreshing ? 'true' : 'false' },
    header(),
    body
  );
}

/**
 * One sentence for assistive technology when the answer changes (the
 * element's status region): the overall result and any open incident per
 * condition, or what the panel is waiting for. Null while loading.
 */
export function panelSummary(state) {
  const { phase, view, error, missing } = state ?? {};
  if (phase === 'error') return (ERROR_COPY[error?.kind] ?? ERROR_COPY.failed).title;
  if (phase === 'empty') return missing === 'card' ? 'Choose an AI system and its function.' : 'Add an ICD-11 code to look the case up.';
  if (phase !== 'ready' || !view) return null;
  const parts = view.conditions.map((condition) => {
    if (!condition.matched) return `${condition.code} is not on this card`;
    const overall = displayFor(condition.statuses.overall).label;
    const safety = isAlert(condition) ? `, ${condition.openIncidentText ?? displayFor(condition.safety).label}` : '';
    return `${condition.name}: ${overall} on Overview${safety}`;
  });
  if (view.combination?.stored) {
    parts.unshift(`Combination: ${displayFor(view.combination.statuses.overall).label} on Overview`);
  }
  return `${view.card.name}, ${displayUseCase(view.card.functionName)}. ${parts.join('. ')}.`;
}

/** All text of a DOM model, in order (tests, and the element's accessible summary). */
export function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node !== 'object') return String(node);
  return node.children.map(textOf).join('');
}

/** Every node of a DOM model that matches a predicate. */
export function findNodes(node, predicate, found = []) {
  if (node && typeof node === 'object') {
    if (predicate(node)) found.push(node);
    node.children.forEach((child) => findNodes(child, predicate, found));
  }
  return found;
}

