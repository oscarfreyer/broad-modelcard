// The plain-language interpreter for the static build (contract v1.14,
// CONTRACT.md §31): a port of backend/app/services/interpret.py, with the same
// vocabularies and rules, over the recorded /models, /meta axes, and the
// static search (api/staticSearch.js). backend/tests/fixtures/interpret_rule_cases.json
// holds cases both run (backend/tests/test_interpret.py, tests/plainSearch.test.js),
// so the two answer alike. Framework-free.

import { wordsOf } from './staticSearch.js';

export const KIND_ORDER = Object.freeze(['system', 'function', 'condition', 'sex', 'age', 'ethnicity', 'setting']);
const SINGLE_VALUED = ['system', 'function', 'sex', 'age', 'ethnicity', 'setting'];
export const MAX_CONDITIONS = 3;
const MAX_QUERY = 200;
const MAX_WINDOW = 6;

// The care settings of the Context axis (contract v1.14, CONTRACT.md §29; phase Q3).
export const SETTINGS = Object.freeze(['Emergency department', 'Intensive care', 'Inpatient ward', 'Outpatient clinic', 'Primary care']);
const AGE_GROUPS = [['Age 0-17', 0, 17], ['Age 18-39', 18, 39], ['Age 40-64', 40, 64], ['Age 65+', 65, 200]];

const AGE_WORDS = {
  'Age 0-17': [
    'children', 'child', 'paediatric', 'pediatric', 'paediatrics', 'pediatrics', 'kids', 'kid', 'teenager',
    'teenagers', 'teens', 'adolescent', 'adolescents', 'infant', 'infants', 'baby', 'babies', 'newborn',
    'newborns', 'toddler', 'toddlers', 'minors', 'young children'
  ],
  'Age 18-39': ['young adult', 'young adults'],
  'Age 40-64': ['middle aged', 'middle age', 'midlife'],
  'Age 65+': [
    'older', 'elderly', 'the elderly', 'senior', 'seniors', 'older adult', 'older adults', 'older people',
    'older patients', 'geriatric', 'pensioners', 'retirees'
  ]
};
const SEX_WORDS = {
  'Sex Female': ['women', 'woman', 'female', 'females', 'girl', 'girls', 'ladies'],
  'Sex Male': ['men', 'man', 'male', 'males', 'boy', 'boys', 'gentlemen']
};
export const SEX_LABELS = Object.freeze({ 'Sex Female': 'Women', 'Sex Male': 'Men' });
const ETHNICITY_WORDS = {
  'Ethnicity White': ['white', 'caucasian', 'caucasians'],
  'Ethnicity Black': ['black', 'african american', 'african americans'],
  'Ethnicity Hispanic': ['hispanic', 'hispanics', 'latino', 'latinos', 'latina', 'latinas', 'latinx'],
  'Ethnicity Asian': ['asian', 'asians', 'south asian', 'east asian'],
  'Ethnicity Other': ['other ethnicity', 'other ethnicities', 'mixed ethnicity']
};
const SETTING_WORDS = {
  'Emergency department': ['emergency', 'emergency department', 'emergency departments', 'emergency room', 'ed', 'accident and emergency', 'casualty'],
  'Intensive care': ['icu', 'itu', 'intensive care', 'intensive care unit', 'critical care'],
  'Inpatient ward': ['ward', 'wards', 'inpatient', 'inpatients', 'hospital ward', 'hospitalised', 'hospitalized'],
  'Outpatient clinic': ['outpatient', 'outpatients', 'clinic', 'clinics', 'outpatient clinic', 'ambulatory'],
  'Primary care': ['primary care', 'gp', 'gps', 'general practice', 'general practitioner', 'family practice', 'family doctor', 'family medicine']
};
// [phrases, texts in the function's name, function categories]
const FUNCTION_WORDS = [
  [['triage'], ['triage'], ['triage']],
  [['discharge', 'discharge letter', 'discharge letters', 'discharge summary', 'discharge summaries'], ['discharge'], []],
  [['documentation', 'scribe', 'clinical notes', 'note writing'], [], ['documentation']],
  [['radiology', 'imaging', 'x ray', 'x rays', 'radiograph', 'radiographs'], ['radiolog'], []],
  [['image analysis'], [], ['image_analysis']],
  [['skin', 'skin lesion', 'skin lesions', 'dermatology', 'moles'], ['skin'], []],
  [['decision support', 'clinical decision support', 'cdss', 'diagnosis support'], [], ['decision_support']],
  [['patient communication', 'patient messages'], [], ['patient_communication']],
  [['administrative', 'administration'], [], ['administrative']]
];

const STOPWORDS = new Set(
  `a an the in on at of for to from by about among into during within who whom that which whose are is was were be
  been being have has had do does did how what when where why show shows me my our we i you please results result
  performance perform performs performing accuracy model models system systems ai tool tools patient patients people
  person persons population populations case cases care using use used setting settings data evidence evaluated
  evaluation there any all it its this these those than as treated treating diagnosed suffering presenting present
  admitted visit visits seen like such s age aged year years old does how well works work`.split(/\s+/).filter(Boolean)
);
const SPLITTERS = new Set(['and', 'with', 'or', 'plus', 'vs', 'versus']);
const GENERIC = new Set([
  'disease', 'diseases', 'disorder', 'disorders', 'syndrome', 'syndromes', 'condition', 'conditions', 'problem',
  'problems', 'illness', 'illnesses', 'other', 'specified', 'unspecified', 'chronic', 'acute'
]);
const SEPARATOR = /[,;/?!]/;
const VERSION_SUFFIX = /[\s_-]*v?\d+(?:\.\d+)*$/i;
const CODE = /(?<![0-9A-Za-z.])([0-9A-Za-z]{4}(?:\.[0-9A-Za-z]{1,4})?)(?![0-9A-Za-z])/g;
const AGE_PATTERNS = [
  ['exact', /\b(\d{1,3})(?:\s*-\s*|\s+)?(?:years?|yrs?)(?:\s*-\s*|\s+)olds?\b/g],
  ['exact', /\b(\d{1,3})(?:\s*-\s*|\s+)(?:years?|yrs?)\s+of\s+age\b/g],
  ['exact', /\b(\d{1,3})\s*(?:yo|y\/o)\b/g],
  ['range', /\b(?:aged?|ages)\s+(\d{1,3})\s*(?:-|to)\s*(\d{1,3})\b/g],
  ['from', /\b(?:aged?\s+)?(\d{1,3})\s*\+/g],
  ['above', /\b(?:over|above|older than)\s+(\d{1,3})\b/g],
  ['from', /\bat least\s+(\d{1,3})\b/g],
  ['below', /\b(?:under|below|younger than)\s+(\d{1,3})\b/g],
  ['exact', /\baged?\s+(\d{1,3})\b/g]
];
const AE = /\ba\s*&\s*e\b/g;

/** Letters and digits only, lower case: "SynGPT-2.0" and "syngpt 2.0" are both "syngpt20". */
export function compact(text) {
  return wordsOf(String(text ?? '').toLowerCase()).join('');
}

function ageGroup(low, high) {
  const found = AGE_GROUPS.find(([, start, end]) => start <= low && high <= end);
  return found ? found[0] : null;
}

function phraseTable(groups) {
  const table = new Map();
  Object.entries(groups).forEach(([value, phrases]) => {
    phrases.forEach((phrase) => {
      const key = wordsOf(phrase.toLowerCase()).join(' ');
      if (!table.has(key)) table.set(key, value);
    });
  });
  return table;
}

const AGE_TABLE = phraseTable(AGE_WORDS);
const SEX_TABLE = phraseTable(SEX_WORDS);
const ETHNICITY_TABLE = phraseTable(ETHNICITY_WORDS);
const SETTING_TABLE = phraseTable(SETTING_WORDS);
const FUNCTION_TABLE = new Map();
FUNCTION_WORDS.forEach(([phrases, texts, categories]) => {
  phrases.forEach((phrase) => {
    const key = wordsOf(phrase).join(' ');
    if (!FUNCTION_TABLE.has(key)) FUNCTION_TABLE.set(key, [texts, categories]);
  });
});
const VOCABULARY_WORDS = new Set(
  [AGE_TABLE, SEX_TABLE, ETHNICITY_TABLE, SETTING_TABLE, FUNCTION_TABLE].flatMap((table) => [...table.keys()].flatMap((phrase) => phrase.split(' ')))
);

function nameKeys(name) {
  const keys = [];
  const stem = compact(name.replace(VERSION_SUFFIX, ''));
  if (stem.length >= 4) keys.push(stem);
  const words = name.replace(/_/g, ' ').replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  const first = words.length ? compact(words[0]) : '';
  if (first.length >= 4 && !/^\d+$/.test(first)) keys.push(first);
  return [compact(name), keys];
}

/**
 * What the interpreter can recognize: the registry and the lens axes (interpret.py `Vocabulary`).
 *
 * @param {{ systems: Array<{ modelVersion: string, label: string, useCases: string[], categories: Array<string|null> }>,
 *   defaultModelVersion: string|null, ages: string[], sexes: string[], ethnicities: string[], settings?: string[], replaced?: string[] }} input
 */
export function createVocabulary({ systems, defaultModelVersion = null, ages = [], sexes = [], ethnicities = [], settings = SETTINGS, replaced = [] }) {
  const replacedSet = new Set(replaced);
  const exact = new Map();
  const families = new Map();
  const ordered = [...systems.filter((system) => replacedSet.has(system.modelVersion)), ...systems.filter((system) => !replacedSet.has(system.modelVersion))];
  const push = (map, key, system) => {
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(system)) map.get(key).push(system);
  };
  ordered.forEach((system) => {
    [system.modelVersion, system.label].forEach((name) => {
      const [key, familyKeys] = nameKeys(name);
      push(exact, key, system);
      familyKeys.forEach((familyKey) => push(families, familyKey, system));
    });
  });
  const names = new Map();
  exact.forEach((entries, key) => names.set(key, entries.length === 1 ? entries[0] : null));
  families.forEach((entries, key) => {
    if (!names.has(key)) names.set(key, entries[entries.length - 1]);
  });
  const useCaseNames = [];
  systems.forEach((system) => system.useCases.forEach((name) => {
    if (!useCaseNames.includes(name)) useCaseNames.push(name);
  }));
  return {
    systems,
    defaultModelVersion,
    ages,
    sexes,
    ethnicities,
    settings,
    systemNamed: (text) => names.get(compact(text)) ?? null,
    byVersion: (modelVersion) => systems.find((system) => system.modelVersion === modelVersion) ?? null,
    useCaseNames: () => useCaseNames,
    functionCards(texts, categories) {
      const cards = [];
      systems.forEach((system) => {
        system.useCases.forEach((useCase, index) => {
          const name = useCase.toLowerCase();
          const category = system.categories[index];
          if (texts.some((text) => name.includes(text)) || (category != null && categories.includes(category))) cards.push([system, useCase]);
        });
      });
      return cards;
    }
  };
}

/** The vocabulary of a listModels answer and the /meta axes (interpret.py `vocabulary_of`). */
export function vocabularyOf(models, axes) {
  const entries = models?.models ?? [];
  const notAll = (values) => (values ?? []).filter((value) => !value.startsWith('All'));
  return createVocabulary({
    systems: entries.map((model) => ({
      modelVersion: model.model_version,
      label: model.display_name || model.model_version,
      useCases: (model.use_cases ?? []).map((entry) => entry.use_case),
      categories: (model.use_cases ?? []).map((entry) => entry.function_category ?? null)
    })),
    defaultModelVersion: models?.default_model_version || entries[0]?.model_version || null,
    ages: notAll(axes?.age),
    sexes: notAll(axes?.sex),
    ethnicities: notAll(axes?.ethnicity),
    // The specific care settings: the Context axis after its first value, Clinical (Any setting, §29).
    settings: (axes?.context ?? []).slice(1),
    replaced: entries.filter((model) => (model.replaced_by ?? []).length).map((model) => model.model_version)
  });
}

/** Lower case character by character, so positions in the result are positions in the text. */
function lowerKeepingPositions(text) {
  return [...text].map((char) => (char.toLowerCase().length === 1 ? char.toLowerCase() : char)).join('');
}

function tokensOf(lower) {
  return [...lower.matchAll(/[0-9a-z]+/g)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length, taken: false }));
}

function coveredTokens(tokens, start, end) {
  const covered = [];
  tokens.forEach((token, index) => {
    if (token.start >= start && token.end <= end) covered.push(index);
  });
  return covered;
}

function* windows(count, longest) {
  for (let size = Math.min(longest, count); size > 0; size -= 1) {
    for (let first = 0; first <= count - size; first += 1) yield [first, first + size - 1];
  }
}

/**
 * The concept a condition chip names: a synonym names its concept as a whole, so a subcategory
 * found by one opens as its condition (interpret.py `condition_concept`).
 */
function conditionConcept(match, conceptById) {
  if (match.match !== 'synonym') return match.concept;
  const concept = match.concept;
  if ((concept.depth_in_kind || 1) > 1 && concept.metric_anchor_id) return conceptById(concept.metric_anchor_id) ?? concept;
  return concept;
}

/**
 * The interpretation of a query: `{ query, chips, unrecognized }` (CONTRACT.md §31).
 *
 * @param {string} query
 * @param {ReturnType<typeof createVocabulary>} vocabulary
 * @param {ReturnType<import('./staticSearch.js').createSearchIndex>} index the ICD-11 search index
 * @param {(conceptId: string) => object|null} conceptById the concept record of an id
 */
export function interpretQuery(query, vocabulary, index, conceptById) {
  const text = String(query ?? '').split(/\s+/).filter(Boolean).join(' ').slice(0, MAX_QUERY);
  const lower = lowerKeepingPositions(text);
  const tokens = tokensOf(lower);
  let chips = [];
  const leftovers = [];
  const free = (first, last) => tokens.slice(first, last + 1).every((token) => !token.taken);
  const take = (first, last) => tokens.slice(first, last + 1).forEach((token) => { token.taken = true; });
  const phrase = (first, last) => tokens.slice(first, last + 1).map((token) => token.text).join(' ');
  const raw = (first, last) => lower.slice(tokens[first].start, tokens[last].end);
  const add = (kind, value, label, first, last, extra = {}, span = null) => {
    const [start, end] = span ?? [tokens[first].start, tokens[last].end];
    chips.push({ kind, value, label, start, end, extra });
    take(first, last);
  };
  // At most three distinct conditions (§31.2): a repeat takes its words without a chip,
  // and a further condition is unrecognized.
  const conditionIds = new Set();
  const addCondition = (concept, first, last, extra) => {
    if (conditionIds.has(concept.concept_id)) {
      take(first, last);
    } else if (conditionIds.size >= MAX_CONDITIONS) {
      leftovers.push([first, last]);
      take(first, last);
    } else {
      conditionIds.add(concept.concept_id);
      add('condition', concept.concept_id, '', first, last, { ...extra, concept });
    }
  };

  // 1. Codes, ages, and A&E in the raw text.
  for (const match of text.matchAll(CODE)) {
    const code = match[1];
    if (!/\d/.test(code[2])) continue;
    const concept = index.codeMatch(code);
    const start = match.index + match[0].indexOf(code);
    const covered = coveredTokens(tokens, start, start + code.length);
    if (!concept || !covered.length || !free(covered[0], covered[covered.length - 1])) continue;
    addCondition(concept, covered[0], covered[covered.length - 1], { match: 'code' });
  }
  for (const [kind, pattern] of AGE_PATTERNS) {
    for (const match of lower.matchAll(pattern)) {
      const covered = coveredTokens(tokens, match.index, match.index + match[0].length);
      if (!covered.length || !free(covered[0], covered[covered.length - 1])) continue;
      const numbers = match.slice(1).filter((group) => group !== undefined).map(Number);
      const [low, high] = {
        exact: () => [numbers[0], numbers[0]],
        range: () => [Math.min(...numbers), Math.max(...numbers)],
        from: () => [numbers[0], 200],
        above: () => [numbers[0] + 1, 200],
        below: () => [0, Math.max(0, numbers[0] - 1)]
      }[kind]();
      const value = ageGroup(low, high);
      const [first, last] = [covered[0], covered[covered.length - 1]];
      if (value !== null && vocabulary.ages.includes(value)) {
        add('age', value, value, first, last, {}, [match.index, match.index + match[0].length]);
      } else {
        leftovers.push([first, last]);
        take(first, last);
      }
    }
  }
  for (const match of lower.matchAll(AE)) {
    const covered = coveredTokens(tokens, match.index, match.index + match[0].length);
    if (covered.length && free(covered[0], covered[covered.length - 1]) && vocabulary.settings.includes('Emergency department')) {
      add('setting', 'Emergency department', 'Emergency department', covered[0], covered[covered.length - 1], {}, [match.index, match.index + match[0].length]);
    }
  }

  // 2. AI systems.
  for (const [first, last] of windows(tokens.length, MAX_WINDOW)) {
    if (!free(first, last)) continue;
    const system = vocabulary.systemNamed(tokens.slice(first, last + 1).map((token) => token.text).join(''));
    if (system) add('system', system.modelVersion, system.label, first, last);
  }

  // 3. Condition names (two or more words, one a vocabulary word) that are exactly a preferred term or a synonym.
  for (const [first, last] of windows(tokens.length, MAX_WINDOW)) {
    if (last === first || !free(first, last)) continue;
    if (STOPWORDS.has(tokens[first].text) || STOPWORDS.has(tokens[last].text)) continue;
    if (!tokens.slice(first, last + 1).some((token) => VOCABULARY_WORDS.has(token.text))) continue;
    const [best] = index.conditions(raw(first, last), { limit: 1 });
    if (best && best.matchedTerm != null && wordsOf(best.matchedTerm.toLowerCase()).join(' ') === phrase(first, last)) {
      addCondition(conditionConcept(best, conceptById), first, last, { match: best.match, matchedTerm: best.matchedTerm });
    }
  }

  // 4. Functions, settings, and the lens words, longest first.
  const tables = [['function', FUNCTION_TABLE], ['setting', SETTING_TABLE], ['age', AGE_TABLE], ['sex', SEX_TABLE], ['ethnicity', ETHNICITY_TABLE]];
  const useCaseNames = new Map(vocabulary.useCaseNames().map((name) => [wordsOf(name.toLowerCase()).join(' '), name]));
  for (const [first, last] of windows(tokens.length, MAX_WINDOW)) {
    if (!free(first, last)) continue;
    const key = phrase(first, last);
    if (useCaseNames.has(key)) {
      add('function', useCaseNames.get(key), useCaseNames.get(key), first, last, { exact: true });
      continue;
    }
    for (const [kind, table] of tables) {
      if (!table.has(key)) continue;
      const value = table.get(key);
      if (kind === 'function') {
        add('function', '', '', first, last, { words: value });
      } else if (kind === 'setting') {
        if (vocabulary.settings.includes(value)) add('setting', value, value, first, last);
      } else {
        const allowed = { age: vocabulary.ages, sex: vocabulary.sexes, ethnicity: vocabulary.ethnicities }[kind];
        if (allowed.includes(value)) add(kind, value, SEX_LABELS[value] ?? value.replace(/^Ethnicity /, ''), first, last);
      }
      break;
    }
  }

  // 5. Conditions in what is left.
  const segmentConditions = (segment) => {
    if (!segment.length) return;
    for (let size = Math.min(segment.length, MAX_WINDOW); size > 0; size -= 1) {
      for (let offset = 0; offset <= segment.length - size; offset += 1) {
        const window = segment.slice(offset, offset + size);
        const [first, last] = [window[0], window[window.length - 1]];
        const words = window.map((position) => tokens[position].text);
        if (STOPWORDS.has(words[0]) || STOPWORDS.has(words[words.length - 1])) continue;
        if (size === 1 && (words[0].length < 3 || GENERIC.has(words[0]))) continue;
        const [best] = index.conditions(raw(first, last), { limit: 1, exactOnly: size === 1 });
        if (!best) continue;
        addCondition(conditionConcept(best, conceptById), first, last, { match: best.match, matchedTerm: best.matchedTerm });
        segmentConditions(segment.slice(0, offset));
        segmentConditions(segment.slice(offset + size));
        return;
      }
    }
  };
  segmentsOf(text, tokens).forEach(segmentConditions);

  // Functions: simple words to a function (with the system's, when one is named).
  const systems = new Set(chips.filter((chip) => chip.kind === 'system').map((chip) => chip.value));
  const system = systems.size === 1 ? vocabulary.byVersion([...systems][0]) : null;
  const spanOf = (chip) => {
    const covered = coveredTokens(tokens, chip.start, chip.end);
    return [covered[0], covered[covered.length - 1]];
  };
  chips = chips.filter((chip) => {
    if (chip.kind !== 'function') return true;
    const useCase = functionValue(chip, system, vocabulary);
    if (useCase === null) {
      leftovers.push(spanOf(chip));
      return false;
    }
    chip.value = useCase;
    chip.label = useCase;
    return true;
  });

  // Two different values for one kind cancel.
  const final = [];
  SINGLE_VALUED.forEach((kind) => {
    const ofKind = chips.filter((chip) => chip.kind === kind);
    if (new Set(ofKind.map((chip) => chip.value)).size > 1) {
      ofKind.forEach((chip) => leftovers.push(spanOf(chip)));
    } else if (ofKind.length) {
      final.push(ofKind[0]);
    }
  });
  final.push(...chips.filter((chip) => chip.kind === 'condition'));
  final.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.start - b.start);

  return {
    query: text,
    chips: final.map((chip) => chipBody(chip, text)),
    unrecognized: unrecognizedRuns(text, tokens, leftovers)
  };
}

function functionValue(chip, system, vocabulary) {
  if (chip.extra.exact) {
    return !system || system.useCases.includes(chip.value) ? chip.value : null;
  }
  const [texts, categories] = chip.extra.words;
  let cards = vocabulary.functionCards(texts, categories);
  if (system) {
    cards = cards.filter(([entry]) => entry.modelVersion === system.modelVersion);
  } else if (vocabulary.defaultModelVersion) {
    cards = [...cards].sort((a, b) => (a[0].modelVersion === vocabulary.defaultModelVersion ? 0 : 1) - (b[0].modelVersion === vocabulary.defaultModelVersion ? 0 : 1));
  }
  return cards.length ? cards[0][1] : null;
}

function segmentsOf(text, tokens) {
  const segments = [];
  let current = [];
  tokens.forEach((token, position) => {
    if (position && SEPARATOR.test(text.slice(tokens[position - 1].end, token.start))) {
      if (current.length) segments.push(current);
      current = [];
    }
    if (token.taken || SPLITTERS.has(token.text)) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push(position);
  });
  if (current.length) segments.push(current);
  return segments;
}

function unrecognizedRuns(text, tokens, leftovers) {
  const marked = new Set();
  leftovers.forEach(([first, last]) => {
    for (let position = first; position <= last; position += 1) marked.add(position);
  });
  const runs = [];
  tokens.forEach((token, position) => {
    const unknown = marked.has(position) || (!token.taken && !STOPWORDS.has(token.text) && !SPLITTERS.has(token.text));
    if (!unknown) return;
    const previous = runs[runs.length - 1];
    if (previous && previous[1] === position - 1 && !SEPARATOR.test(text.slice(tokens[position - 1].end, token.start))) {
      previous[1] = position;
    } else {
      runs.push([position, position]);
    }
  });
  return runs.map(([first, last]) => text.slice(tokens[first].start, tokens[last].end));
}

function chipBody(chip, text) {
  const body = { kind: chip.kind, value: chip.value, label: chip.label, matched_text: text.slice(chip.start, chip.end) };
  if (chip.kind === 'condition') {
    const concept = chip.extra.concept;
    body.label = concept.pt.replace(/^[- ]+/, '').trim();
    body.code = concept.icd11_code || concept.concept_id;
    body.pt = concept.pt;
    body.match = chip.extra.match ?? 'term';
    if (body.match === 'synonym' && chip.extra.matchedTerm) body.matched_term = chip.extra.matchedTerm;
    body.concept = concept;
  }
  return body;
}
