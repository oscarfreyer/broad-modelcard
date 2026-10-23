// The eight data sets a maintainer can update, in plain words (CONTRACT.md
// §11, §18, §21, §22, §27). Copy for occasional research staff: what the data is, what one
// row of the spreadsheet holds, and what a change does on the atlas.
//
// `modes` lists the ways a file can change the data set (contract v1.7,
// CONTRACT.md §11.2): 'replace' (the file becomes the data set) and, where the
// backend allows it, 'merge' ("Add or change rows"); `defaultMode` is the one
// a new file starts with: merge wherever it is allowed, so a new file never
// replaces a whole data set unless the maintainer chooses it. `recordForm` names the one-record form of the data
// set ('incident', 'metricRow', 'study', or 'effect'), and `noun` what one record is called.

export const DATASETS = Object.freeze({
  models: {
    kind: 'models',
    title: 'AI systems & functions',
    icon: 'models',
    needsTarget: false,
    about:
      'The AI systems (models or products) and the functions each is evaluated for. One AI system with one function is a card.',
    rows: 'One row per AI system and function.',
    templateNotes: {
      title: 'Optional columns',
      lines: [
        'Kind (Model or Product), AI type, Developer, Release date, Description, and Built on describe the AI system. Give each the same value on every row of that AI system.',
        'Built on is for products only: the model versions they are built on, separated by ";". Each must be a model in the same file.',
        'Function category and the four Declared columns belong to one row, that is one card. Declarations are the developer’s own statements; the atlas shows them as such, never as checked.',
        'Replaces names the earlier version this AI system supersedes, another AI system in the same file. The atlas then links the two versions.',
        'Configuration ID to Fine-tuning describe how one card is deployed: a label and date, a short summary of the prompt (never the full prompt), retrieval, tools (separated by ";"), sampling, and fine-tuning. Performance measure and Reference standard say what the card’s figures measure.',
        'The four data-protection columns (Declared data use, data location, retention, privacy contact) are the developer’s statements, shown as declared.',
        'Leave a cell empty when you do not know the value. Files without these columns stay valid.'
      ]
    },
    shiftScope: null,
    modes: ['replace'],
    defaultMode: 'replace',
    recordForm: null,
    noun: ['row', 'rows'],
    caution:
      'Publish a new function’s performance metrics first, then this list.',
    counts: [
      { key: 'models', label: 'AI systems' },
      { key: 'use_cases', label: 'cards' }
    ],
  },
  metrics: {
    kind: 'metrics',
    title: 'Performance metrics',
    icon: 'sheet',
    needsTarget: true,
    about:
      'Results of one AI system and function per condition and population group: performance, evidence, and intended use.',
    rows: 'One row per condition and population group. A complete file has 216,000 rows: 2,400 conditions × 90 groups.',
    shiftScope: 'Top-level conditions for all patients, for this AI system and function.',
    modes: ['merge', 'replace'],
    defaultMode: 'merge',
    recordForm: 'metricRow',
    noun: ['row', 'rows'],
    replaceHelp:
      'Your file replaces all metrics of this AI system and function; missing rows are removed.',
    mergeHelp:
      'Upload only new or changed rows; others stay. Action “Remove” deletes a row. Each row needs Source, Study, and Source date; rows from an older study are kept out.',
    caution: null,
    counts: [
      { key: 'use_cases', label: 'cards' },
      { key: 'metric_rows', label: 'rows in all' }
    ],
  },
  multimorbidity: {
    kind: 'multimorbidity',
    title: 'Multimorbidity',
    icon: 'combination',
    needsTarget: true,
    about:
      'Results for combinations of two or more conditions, shown in Multimorbidity mode. Missing combinations are never guessed.',
    rows: 'One row per combination of conditions and population group.',
    shiftScope: 'Conditions on the Multimorbidity atlas before anything is selected, for this AI system and function.',
    modes: ['replace'],
    defaultMode: 'replace',
    recordForm: null,
    noun: ['row', 'rows'],
    caution: null,
    counts: [
      { key: 'use_cases', label: 'cards' },
      { key: 'combinations', label: 'combinations' }
    ],
  },
  prevalence: {
    kind: 'prevalence',
    title: 'Prevalence',
    icon: 'prevalence',
    needsTarget: false,
    about:
      'How common each ICD-11 condition is, in five tiers. It sizes bubbles and weighs evidence, so a change can shift results for every AI system.',
    rows: 'One row per ICD-11 code.',
    shiftScope:
      'Top-level conditions for all patients, grouped by AI system and function: one changed code can change a condition’s status for several AI systems.',
    modes: ['merge', 'replace'],
    defaultMode: 'merge',
    recordForm: null,
    noun: ['row', 'rows'],
    replaceHelp:
      'Your file replaces the prevalence data set; missing codes lose their tier.',
    mergeHelp:
      'Upload only new or changed codes; others stay. Action “Remove” clears a code. Each row needs Source, Study, and Source date.',
    caution: null,
    counts: [{ key: 'codes', label: 'ICD-11 codes' }],
  },
  safety: {
    kind: 'safety',
    title: 'Safety incidents',
    icon: 'warning',
    needsTarget: false,
    about:
      'Reported safety incidents per card, marked Serious or Caution on the Safety view. They never change a result; No reported incidents does not mean safe.',
    rows: 'One row per incident.',
    shiftScope: null,
    modes: ['merge', 'replace'],
    defaultMode: 'merge',
    recordForm: 'incident',
    noun: ['incident', 'incidents'],
    replaceHelp:
      'Your file replaces the list of incidents; missing incidents are removed.',
    mergeHelp:
      'Upload only new or changed incidents; others stay. Action “Remove” deletes one.',
    caution: null,
    counts: [
      { key: 'incidents', label: 'incidents' },
      { key: 'open', label: 'open' }
    ],
  },
  population: {
    kind: 'population',
    title: 'Local populations',
    icon: 'population',
    needsTarget: false,
    needsPopulation: true,
    about:
      'Named prevalence sets for a region or service. The atlas can switch to one; it replaces the default tiers for the codes it lists, which can change some results.',
    rows: 'One row per ICD-11 code the population lists; every other condition keeps the default tier.',
    templateNotes: {
      title: 'Aggregate data only',
      lines: [
        'One row per ICD-11 code, with its commonness tier: how common the condition is in the population, never a list of patients or cases.',
        'No column may name or identify a person, a birth date, contact details, encounters, or per-person values. A code may appear only once.',
        'Like every data set here, local populations are synthetic demonstration data. Give a fictional name, for example “Northbridge region (fictional)”.'
      ]
    },
    shiftScope:
      'Top-level conditions for all patients, compared with the default prevalence and grouped by AI system and function.',
    modes: ['replace'],
    defaultMode: 'replace',
    recordForm: null,
    noun: ['row', 'rows'],
    caution: null,
    counts: [
      { key: 'populations', label: 'local populations' },
      { key: 'codes', label: 'ICD-11 codes in all' }
    ],
  },
  studies: {
    kind: 'studies',
    title: 'Studies',
    icon: 'evidence',
    needsTarget: false,
    about:
      'The studies behind performance results: design, setting, who ran them, reporting guideline, and risk of bias. A result links to a study through its Study column; a followed guideline raises its evidence grade, a risk of bias lowers it.',
    rows: 'One row per study.',
    shiftScope: 'Top-level conditions for all patients whose rows name a study, grouped by AI system and function.',
    modes: ['merge', 'replace'],
    defaultMode: 'merge',
    recordForm: 'study',
    noun: ['study', 'studies'],
    replaceHelp: 'Your file replaces the list of studies; missing studies are removed, and their results are graded without a study again.',
    mergeHelp: 'Upload only new or changed studies; others stay. Action “Remove” deletes one.',
    caution: null,
    counts: [{ key: 'studies', label: 'studies' }],
  },
  effects: {
    kind: 'effects',
    title: 'Effects on outcomes',
    icon: 'effect',
    needsTarget: false,
    about:
      'What using an AI system changed for patients or care, from a trial or prospective study under Studies. Shown on the condition card; never part of a grade.',
    rows: 'One row per effect on an outcome.',
    shiftScope: null,
    modes: ['merge', 'replace'],
    defaultMode: 'merge',
    recordForm: 'effect',
    noun: ['effect', 'effects'],
    replaceHelp: 'Your file replaces the list of effects; missing effects are removed.',
    mergeHelp: 'Upload only new or changed effects; others stay. Action “Remove” deletes one.',
    caution: 'Add and publish the study under Studies first.',
    counts: [{ key: 'effects', label: 'effects' }],
  },
  // Contract v1.13 (CONTRACT.md §26): a hospital’s own evaluation results for one card and local population.
  local_metrics: {
    kind: 'local_metrics',
    title: 'Local results',
    icon: 'population',
    needsTarget: true,
    needsLocalPopulation: true,
    about:
      'This hospital’s own evaluation results for one card and one local population. A reader who chooses that population sees each local result in place of the public one; nobody else sees a change.',
    rows: 'One row per condition and population group you evaluated. Every row names, in its Study column, a hospital study of this population.',
    templateNotes: {
      title: 'Before you upload',
      lines: [
        'Add the evaluation under Studies first: Scope Hospital, Local population this one. Each row’s Study column names its Study ID.',
        'List only what you evaluated; every other result stays public.',
        'Aggregate synthetic results only. Never patient-level data.'
      ]
    },
    shiftScope: 'Top-level conditions for all patients, as readers of this local population see them.',
    modes: ['merge', 'replace'],
    defaultMode: 'merge',
    recordForm: 'metricRow',
    noun: ['row', 'rows'],
    replaceHelp: 'Your file replaces this card’s local results for the population; missing rows fall back to the public results.',
    mergeHelp: 'Upload only new or changed rows; others stay. Action “Remove” deletes one. Each row needs Source, Study, and Source date.',
    caution: null,
    counts: [
      { key: 'use_cases', label: 'cards' },
      { key: 'metric_rows', label: 'local rows' }
    ],
  }
});

export const DATASET_ORDER = Object.freeze(['models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population', 'studies', 'effects', 'local_metrics']);

/** Every versioned kind History lists and restores: the data sets, then the narrow model cards (contract v1.13, §26). */
export const HISTORY_KINDS = Object.freeze([...DATASET_ORDER, 'model_cards']);

/** "1 incident" / "3 rows": a count in the data set's own noun. */
export function recordCount(kind, value) {
  const [one, many] = DATASETS[kind]?.noun ?? ['row', 'rows'];
  return plural(value, one, many);
}

export function datasetTitle(kind) {
  if (kind === 'model_cards') return 'Narrow model cards';
  return DATASETS[kind]?.title ?? 'All data sets';
}

// Since contract v1.7 the backend writes version summaries in the UI's words.
// Versions published before v1.7 keep their old summaries ("Models & use
// cases: … 3 models added."), and restores read "Rolled back …"; the page
// shows both in its own words (CONTRACT.md "Vocabulary"; Restore is the
// page's only verb for going back).
const BACKEND_REGISTRY_TITLE = /^Models & use cases(?=:)/;
const BACKEND_ENTRY_COUNT = /\b(\d[\d,]*) models (added|removed)\b/g;
const BACKEND_ROLLBACK = /^Rolled\sback (.+) to version (\d+)\.$/;
// Version 1's summary names the seed's file format ("legacy JSON tables"), which means nothing on this page.
const BACKEND_INITIAL_IMPORT = /^Initial import of the legacy JSON tables/;

/** A backend-written version summary in the page's words. */
export function versionSummary(summary) {
  const text = String(summary ?? '');
  if (BACKEND_INITIAL_IMPORT.test(text)) {
    return 'The first version: the synthetic seed data the app starts with.';
  }
  const rollback = BACKEND_ROLLBACK.exec(text);
  if (rollback) {
    const what = rollback[1].replace(/^models & use cases$/i, DATASETS.models.title);
    return `Restored ${what} to the data of version ${rollback[2]}.`;
  }
  if (!BACKEND_REGISTRY_TITLE.test(text)) {
    return text;
  }
  return text
    .replace(BACKEND_REGISTRY_TITLE, DATASETS.models.title)
    .replace(BACKEND_ENTRY_COUNT, (match, count, change) => `${count} ${count === '1' ? 'AI system' : 'AI systems'} ${change}`);
}

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const DATE_LONG = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * A data set's last change in the sidebar: "v19, 14 Oct" to see, and the
 * same in words for screen readers.
 *
 * @param {{ version: number, updated_at: string }} info
 * @returns {{ short: string, spoken: string }}
 */
export function sidebarChange(info) {
  const date = new Date(info.updated_at);
  const valid = !Number.isNaN(date.getTime());
  return {
    short: `v${info.version}${valid ? `, ${DATE.format(date)}` : ''}`,
    spoken: `Changed in version ${info.version}${valid ? `, ${DATE_LONG.format(date)}` : ''}`
  };
}
const DATE_TIME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function dateTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : DATE_TIME.format(date);
}

/** "12,345" */
export function count(value) {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : '–';
}

/** "1 row" / "12 rows" */
export function plural(value, noun, nouns = `${noun}s`) {
  return `${count(value)} ${value === 1 ? noun : nouns}`;
}
