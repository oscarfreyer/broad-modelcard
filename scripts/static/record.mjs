// Records the static snapshot for the read-only GitHub Pages build (release 0.4):
//
//   node scripts/static/record.mjs [--store <file>] [--out <dir>] [--port <n>]
//        [--lenses default|one-group] [--ontologies icd11[,mondo][,icd10cm]]
//   npm run static:record
//
// It starts the backend on a private copy of the demo store (default
// backend/data/dashboard-demo.sqlite; build it with `npm run demo:build`),
// calls the contract's read operations for what the static site shows, and
// writes the answers to frontend/static-data/ under the names in
// frontend/src/api/staticPaths.js. What it records:
//
// - /meta, /models, /catalogue, /studies, /effects, /incidents, the ICD-11
//   synonyms (read from the store copy: no read serves them; contract v1.14,
//   CONTRACT.md §31), and in every recorded classification /atlas/overview and
//   every chapter;
// - in ICD-11, per card and lens (the default lens and each one-group lens,
//   G1): the atlas map, every chapter map, the Summary of every view and its
//   prevalence-weighted shares (view overall, v1.14 §30), and the comparison
//   inputs (the card's facts and cells at every scope);
// - in ICD-11, per card at the default lens: every condition card, bundled
//   per chapter; Across groups for every condition (depth 1), bundled per
//   chapter; the group summary (v1.14 §24); and every multimorbidity selection
//   with a stored answer (all subsets of the stored combinations), with
//   empty-answer templates for the rest;
// - in ICD-11, per card and care setting it stores (v1.14 §29), at all
//   patients: the maps, the Summary with its weighted shares, the condition
//   cards, Across groups, and the group summary;
// - per card (v1.14): its change history (/versions?card=, §26.6) and its
//   card record as JSON and JSON-LD (§32);
// - in each other classification (--ontologies, default from
//   BMC_STATIC_ONTOLOGIES, else icd11,mondo,icd10cm; contract v1.13,
//   CONTRACT.md §23), per card at the default lens only: the maps, Summary,
//   comparison inputs, and condition cards. MONDO and ICD-10-CM reach ICD-11
//   through WHO's mapping tables (CC BY-ND 3.0 IGO, used unmodified and
//   attributed); the public demo shows all three.
//
// Every rebuilt answer is compared with the API's own answer: condition cards,
// Across groups, study, effect, incident, and version filters, every
// comparison the recorder reads (and a sample of 3- and 4-card sets in other
// orders), the static search (synonyms included) for fixed query lists, and
// the static interpreter for the 30-query quality set and more, so a
// recording that would serve anything else than the API fails. The live store and the demo store are never opened; the
// copy is deleted afterwards.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKEND_DIR, REPO_ROOT, probeBackend, pythonPath, pythonSetupProblem, spawnBackend, stopProcess, waitForBackend } from '../backendServer.mjs';
import { DEFAULT_LENS, cardKey, lensKey, lensSetting, selectionKey, slug, staticPaths } from '../../frontend/src/api/staticPaths.js';
import {
  cardVersionsAnswer,
  conceptMetricsAnswer,
  conceptSubgroupsAnswer,
  createConceptBundle,
  createSubgroupBundle,
  effectsAnswer,
  emptySelectionAnswer,
  incidentsAnswer,
  studiesAnswer,
  studyAnswer,
  withSelection
} from '../../frontend/src/api/staticRebuild.js';
import { comparisonAnswer, encodeCell, rowSkeleton, scopeKey } from '../../frontend/src/api/staticComparison.js';
import { createSearchIndex } from '../../frontend/src/api/staticSearch.js';
import { interpretQuery, vocabularyOf } from '../../frontend/src/api/staticInterpret.js';

export const STATIC_DATA_DIR = path.join(REPO_ROOT, 'frontend', 'static-data');
const DEFAULT_STORE = path.join(REPO_ROOT, 'backend', 'data', 'dashboard-demo.sqlite');
const DEFAULT_PORT = 8030;
const ICD11 = 'icd11';
// All three for the public demo.
export const DEFAULT_ONTOLOGIES = Object.freeze([ICD11, 'mondo', 'icd10cm']);
const SUMMARY_VIEWS = ['overall', 'performance', 'evidence', 'intended_use', 'safety'];
// The Context axis value of Any setting (CONTRACT.md §29): every other value is a specific setting.
const ANY_SETTING = 'Clinical';
const LENS_AXES = Object.keys(DEFAULT_LENS);
// Queries the static search must answer exactly like the API (CONTRACT.md §9; synonyms since v1.14, §31).
const SEARCH_QUERIES = ['diabetes', 'Diabetes mellitus', '5A11', '5a1', '1A0', 'BA00', 'CH-05', 'heart', 'heart failure', 'cancer', 'neoplasm', 'skin', 'melanoma', 'pneumonia', 'asthma', 'kidney', 'type 2', 'infect', 'fracture', 'pregnan', 'depress', 'schizo', 'covid', 'sepsis', 'stroke', 'hypothyroid', 'block', 'chapter', 'xyz-no-match', 'a', 'heart attack', 'high blood pressure', 'sugar', 'flu', 'kidney stone', 'hay fever', 'lupus', 'gout', 'infarct', 'shingles'];
// The plain-language queries the static interpreter must read exactly like the API (§31), beside the quality set.
const INTERPRET_QUERIES = ['heart attack', 'heart attack in older women in the emergency department', 'SynGPT-2.0 high blood pressure in the ICU', 'diabetes and heart failure in men', 'kidney stone in primary care', 'Parlowe asthma in children', 'Tallyfern coding on the ward', 'flu in teenagers', 'xyz'];
const INTERPRET_FIXTURE = path.join(REPO_ROOT, 'backend', 'tests', 'fixtures', 'interpret_queries.json');
// The same in another classification, with its own codes (CONTRACT.md §23).
const ONTOLOGY_SEARCH_QUERIES = ['diabetes', 'heart failure', 'cancer', 'infect', 'asthma', 'syndrome', 'E11', 'E11.9', 'I50', 'J45', 'C50', '01', '1', 'MONDO:0005', 'mondo:00050', '0005015', 'MONDO:0005148', 'disease', 'xyz-no-match', 'a'];
// The extra comparisons checked against the API per classification: 3- and 4-card sets in shuffled orders.
const COMPARISON_SAMPLE = 12;

/** The classifications to record from a comma-separated list: ICD-11 first, each once. */
export function parseOntologies(value) {
  const ids = String(value || '')
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  if (!ids.length) return [...DEFAULT_ONTOLOGIES];
  ids.forEach((id) => {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new Error(`--ontologies: "${id}" is not an ontology id`);
  });
  if (!ids.includes(ICD11)) throw new Error('--ontologies must include icd11, the standard every result is stored in');
  return [ICD11, ...new Set(ids.filter((id) => id !== ICD11))];
}

export function parseArgs(argv, env = process.env) {
  const options = {
    store: DEFAULT_STORE,
    out: STATIC_DATA_DIR,
    port: DEFAULT_PORT,
    lenses: 'one-group',
    concurrency: 8,
    ontologies: parseOntologies(env.BMC_STATIC_ONTOLOGIES)
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (name === '--store') options.store = path.resolve(value);
    else if (name === '--out') options.out = path.resolve(value);
    else if (name === '--port') options.port = Number(value);
    else if (name === '--lenses') options.lenses = value;
    else if (name === '--concurrency') options.concurrency = Number(value);
    else if (name === '--ontologies') options.ontologies = parseOntologies(value);
    else throw new Error(`Unknown argument ${name}`);
    index += 1;
  }
  if (!['default', 'one-group'].includes(options.lenses)) throw new Error('--lenses is default or one-group');
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('--port is a port number (1–65535)');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('--concurrency is a whole number of at least 1');
  return options;
}

/** The lenses to record: the default lens, then (one-group) each group of each axis alone. */
export function recordedLenses(axes, mode = 'one-group') {
  const lenses = [{ ...DEFAULT_LENS }];
  if (mode === 'one-group') {
    LENS_AXES.forEach((axis) => (axes[axis] || []).filter((value) => value !== DEFAULT_LENS[axis]).forEach((value) => lenses.push({ ...DEFAULT_LENS, [axis]: value })));
  }
  return lenses;
}

/** Every non-empty subset of `ids` with at most `maxSize` members, smallest first. */
export function subsets(ids, maxSize) {
  const result = [];
  const walk = (start, chosen) => {
    if (chosen.length) result.push([...chosen]);
    if (chosen.length === maxSize) return;
    for (let index = start; index < ids.length; index += 1) walk(index + 1, [...chosen, ids[index]]);
  };
  walk(0, []);
  return result.sort((a, b) => a.length - b.length);
}

/** A small seeded random number generator (mulberry32), so the comparison sample is the same at every recording. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function freePort(start) {
  for (let port = start; port < start + 50; port += 1) {
    if ((await probeBackend(port, { timeoutMs: 500 })) === 'none') return port;
  }
  throw new Error(`No free port between ${start} and ${start + 49}.`);
}

/** Runs `task` over `items` with at most `limit` at a time; resolves to the results in order. */
async function pool(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function apiClient(port) {
  const root = `http://127.0.0.1:${port}/api/v1`;
  return async function api(route, params = {}) {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([name, value]) => {
      const text = Array.isArray(value) ? value.join(',') : value == null ? '' : String(value);
      if (text !== '' && !(name in DEFAULT_LENS && text === DEFAULT_LENS[name]) && !(name === 'ontology' && text === ICD11) && !(name === 'context' && text === ANY_SETTING)) {
        search.append(name, text);
      }
    });
    const query = search.toString();
    const response = await fetch(`${root}${route}${query ? `?${query}` : ''}`);
    if (!response.ok) {
      throw new Error(`${route}?${query} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    return response.json();
  };
}

function writer(outDir) {
  let files = 0;
  let bytes = 0;
  const made = new Set();
  return {
    async write(relative, value) {
      const target = path.join(outDir, relative);
      const dir = path.dirname(target);
      if (!made.has(dir)) {
        await mkdir(dir, { recursive: true });
        made.add(dir);
      }
      const text = JSON.stringify(value);
      await writeFile(target, text);
      files += 1;
      bytes += Buffer.byteLength(text);
    },
    read(relative) {
      return JSON.parse(readFileSync(path.join(outDir, relative), 'utf8'));
    },
    get stats() {
      return { files, bytes };
    }
  };
}

export async function directorySize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await directorySize(full) : (await stat(full)).size;
  }
  return total;
}

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const ontologyParam = (ontology) => (ontology === ICD11 ? {} : { ontology });
/** The API's lens parameters of a recorded lens: the groups, and `context` for a specific care setting (v1.14). */
const lensParams = ({ setting = null, ...groups }) => ({ ...groups, ...(lensSetting({ setting }) ? { context: setting } : {}) });
/** The specific care settings a listModels function entry stores rows for (CONTRACT.md §29), in axis order. */
export const specificSettings = (entry) => (Array.isArray(entry?.settings) ? entry.settings.filter((value) => value !== ANY_SETTING) : []);
const fileOntology = (ontology) => (ontology === ICD11 ? null : ontology);
const conceptsOf = (answer) => [answer.chapter, ...answer.blocks, ...answer.concepts];

/** The atlas of one classification: its overview, every chapter, and the concept → chapter index. */
async function recordAtlas(api, out, ontology, chapterList) {
  const params = ontologyParam(ontology);
  const overview = await api('/atlas/overview', params);
  await out.write(staticPaths.atlasOverview(fileOntology(ontology)), overview);
  const chapters = {};
  for (const chapter of chapterList ?? overview.chapters) {
    const answer = await api(`/atlas/chapters/${encodeURIComponent(chapter.concept_id)}`, params);
    chapters[chapter.concept_id] = answer;
    await out.write(staticPaths.chapter(chapter.concept_id, fileOntology(ontology)), answer);
  }
  Object.defineProperty(chapters, 'overview', { value: overview, enumerable: false });
  const names = Object.keys(chapters).map((chapterId) => slug(chapterId).toLowerCase());
  assert.equal(new Set(names).size, names.length, `two ${ontology} chapters share a file name`);
  const index = Object.fromEntries(Object.entries(chapters).map(([chapterId, answer]) => [chapterId, conceptsOf(answer).map((concept) => concept.concept_id)]));
  await out.write(staticPaths.conceptChapters(fileOntology(ontology)), index);
  return chapters;
}

async function recordShared(api, out) {
  const meta = await api('/meta');
  await out.write(staticPaths.meta(), meta);
  await out.write(staticPaths.models(), await api('/models'));
  await out.write(staticPaths.catalogue(), await api('/catalogue'));
  const chapters = await recordAtlas(api, out, ICD11, meta.chapters);
  return { meta, chapters };
}

/**
 * /studies, /effects, and /incidents (v1.14), whole; the filters the static
 * adapter applies are checked against the API.
 */
async function recordWholeLists(api, out, cards) {
  const studies = await api('/studies');
  const effects = await api('/effects');
  const incidents = await api('/incidents');
  await out.write(staticPaths.studies(), studies);
  await out.write(staticPaths.effects(), effects);
  await out.write(staticPaths.incidents(), incidents);
  const models = [...new Set(cards.map((card) => card.model)), 'no-such-model'];
  for (const model of models) {
    assert.deepStrictEqual(studiesAnswer(studies, { model }), await api('/studies', { model }), `studies of ${model} differ`);
    assert.deepStrictEqual(effectsAnswer(effects, { model }), await api('/effects', { model }), `effects of ${model} differ`);
    assert.deepStrictEqual(incidentsAnswer(incidents, { model }), await api('/incidents', { model }), `incidents of ${model} differ`);
  }
  for (const card of cards) {
    assert.deepStrictEqual(effectsAnswer(effects, { model: card.model, useCase: card.useCase }), await api('/effects', { model: card.model, use_case: card.useCase }), `effects of ${card.model} · ${card.useCase} differ`);
    assert.deepStrictEqual(
      incidentsAnswer(incidents, { model: card.model, useCase: card.useCase }),
      await api('/incidents', { model: card.model, use_case: card.useCase }),
      `incidents of ${card.model} · ${card.useCase} differ`
    );
  }
  for (const useCase of new Set(cards.map((card) => card.useCase))) {
    assert.deepStrictEqual(incidentsAnswer(incidents, { useCase }), await api('/incidents', { use_case: useCase }), `incidents of the function ${useCase} differ`);
  }
  for (const study of studies.studies) {
    assert.deepStrictEqual(studyAnswer(studies, study.study_id), await api(`/studies/${encodeURIComponent(study.study_id)}`), `study ${study.study_id} differs`);
  }
  return { studies: studies.studies.length, effects: effects.effects.length, incidents: incidents.incidents.length };
}

/**
 * The ICD-11 synonyms of the store (contract v1.14, CONTRACT.md §31.1), as the
 * search reads them (`load_synonyms`: MONDO first, each once): { concept_id:
 * [synonym, …] }. No read serves them, so they are read from the store copy,
 * read-only; the search and interpreter checks below compare their use with the API.
 */
function readSynonyms(store) {
  const code = [
    'import json, sqlite3, sys',
    `sys.path.insert(0, ${JSON.stringify(BACKEND_DIR)})`,
    'from app.ontologies.synonyms import load_synonyms',
    "conn = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)",
    'found = load_synonyms(conn)',
    'json.dump({concept_id: [text for text, _ in entries] for concept_id, entries in sorted(found.items())}, sys.stdout, ensure_ascii=False)'
  ].join('\n');
  const result = spawnSync(pythonPath(), ['-I', '-c', code, store], { cwd: BACKEND_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Reading the synonyms failed: ${result.stderr.slice(0, 500)}`);
  return JSON.parse(result.stdout);
}

async function checkSearch(api, ontology, chapters, { overview = null, synonyms = null } = {}) {
  const index = createSearchIndex(Object.values(chapters).flatMap(conceptsOf), { isOtherOntology: ontology !== ICD11, ontology: overview?.ontology ?? null, synonyms });
  for (const q of ontology === ICD11 ? SEARCH_QUERIES : ONTOLOGY_SEARCH_QUERIES) {
    for (const limit of [20, 80]) {
      const answer = await api('/search', { q, limit, ...ontologyParam(ontology) });
      assert.deepStrictEqual(index.search(q, limit), answer, `static ${ontology} search differs from the API for "${q}" (limit ${limit})`);
    }
  }
  return index;
}

/**
 * The static interpreter (contract v1.14, CONTRACT.md §31.2) over the recorded
 * registry, axes, and the ICD-11 search with its synonyms, against the API: the
 * 30 queries of the quality set (§31.5) and a few more. Returns how many match.
 */
async function checkInterpreter(api, meta, models, index) {
  const quality = JSON.parse(readFileSync(INTERPRET_FIXTURE, 'utf8')).queries.map((entry) => entry.query);
  const vocabulary = vocabularyOf(models, meta.axes);
  const queries = [...new Set([...quality, ...INTERPRET_QUERIES])];
  for (const q of queries) {
    const own = interpretQuery(q, vocabulary, index, (conceptId) => index.conceptById(conceptId));
    assert.deepStrictEqual(own, await api('/search/interpret', { q }), `the static interpreter differs from the API for "${q}"`);
  }
  return { quality: quality.length, checked: queries.length };
}

function cardsOf(models) {
  const cards = models.models.flatMap((model) =>
    model.use_cases.map((entry) => ({
      model: model.model_version,
      useCase: entry.use_case,
      hasMultimorbidity: Boolean(entry.has_multimorbidity),
      settings: specificSettings(entry)
    }))
  );
  const keys = cards.map((card) => cardKey(card.model, card.useCase).toLowerCase());
  assert.equal(new Set(keys).size, keys.length, 'two cards share a folder name');
  return cards;
}

/**
 * The rings and the Summary of one card at each lens: the atlas map, every
 * chapter map, the summary of every view, and the prevalence-weighted shares
 * of view overall (v1.14, §30.1). A lens may name a specific care setting
 * (`setting`, v1.14 §29), sent as `context`.
 */
async function recordLensReads(api, out, card, ontology, lenses, chapterIds, concurrency) {
  const jobs = lenses.flatMap((lens) => [
    ...[null, ...chapterIds].map((chapterId) => ({ kind: 'map', lens, chapterId })),
    ...SUMMARY_VIEWS.map((view) => ({ kind: 'summary', lens, view })),
    { kind: 'summary', lens, view: 'overall', weights: 'prevalence' }
  ]);
  const base = { model: card.model, useCase: card.useCase, ontology: fileOntology(ontology) };
  await pool(jobs, concurrency, async (job) => {
    const params = { model: card.model, use_case: card.useCase, ...lensParams(job.lens), ...ontologyParam(ontology) };
    if (job.kind === 'map') {
      const answer = await api('/metrics/map', { ...params, scope: job.chapterId ? 'chapter' : 'atlas', chapter_id: job.chapterId });
      await out.write(staticPaths.metricMap({ ...base, chapterId: job.chapterId, ...job.lens }), answer);
    } else {
      const answer = await api('/metrics/summary', { ...params, view: job.view, weights: job.weights });
      await out.write(staticPaths.metricSummary({ ...base, view: job.view, weights: job.weights ?? null, ...job.lens }), answer);
    }
  });
}

/**
 * Every condition card of the card in one classification, bundled per
 * chapter. In another classification the concept-level `mapping` and
 * `other_parents` go to the shared mappings files: written with the first
 * card, and every later card's answers are rebuilt from them.
 */
async function recordConcepts(api, out, card, ontology, chapters, mappingsWritten, concurrency, setting = null) {
  const params = { model: card.model, use_case: card.useCase, ...lensParams({ setting }), ...ontologyParam(ontology) };
  for (const [chapterId, chapter] of Object.entries(chapters)) {
    const ids = conceptsOf(chapter).map((concept) => concept.concept_id);
    const answers = await pool(ids, concurrency, (conceptId) => api(`/metrics/concepts/${encodeURIComponent(conceptId)}`, params));
    const collector = createConceptBundle(answers[0].dataset_version, answers[0].ontology ?? null);
    answers.forEach((answer) => collector.add(answer));
    const mappingsPath = ontology === ICD11 ? null : staticPaths.conceptMappings(chapterId, ontology);
    if (mappingsPath && !mappingsWritten.has(mappingsPath)) {
      await out.write(mappingsPath, collector.mappings);
      mappingsWritten.set(mappingsPath, collector.mappings);
    }
    const mappings = mappingsPath ? mappingsWritten.get(mappingsPath) : null;
    ids.forEach((conceptId, index) => {
      assert.deepStrictEqual(
        conceptMetricsAnswer(collector.bundle, chapter, conceptId, mappings),
        answers[index],
        `rebuilt ${ontology} condition card differs for ${conceptId} on ${card.model} · ${card.useCase}${setting ? ` at ${setting}` : ''}`
      );
    });
    await out.write(staticPaths.conceptBundle({ model: card.model, useCase: card.useCase, ontology: fileOntology(ontology), chapterId, setting }), collector.bundle);
  }
}

/**
 * Across groups (CONTRACT.md §24) of every ICD-11 condition (depth 1), bundled
 * per chapter, and the card's group summary (v1.14), at Any setting or at one
 * specific setting (v1.14 §29: the groups within it).
 */
async function recordSubgroups(api, out, card, chapters, concurrency, setting = null) {
  let count = 0;
  const params = { model: card.model, use_case: card.useCase, ...lensParams({ setting }) };
  for (const [chapterId, chapter] of Object.entries(chapters)) {
    const ids = chapter.concepts.filter((concept) => concept.depth_in_kind === 1).map((concept) => concept.concept_id);
    if (!ids.length) continue;
    const answers = await pool(ids, concurrency, (conceptId) => api(`/metrics/concepts/${encodeURIComponent(conceptId)}/subgroups`, params));
    const collector = createSubgroupBundle(answers[0].dataset_version);
    answers.forEach((answer) => collector.add(answer));
    ids.forEach((conceptId, index) => {
      assert.deepStrictEqual(
        conceptSubgroupsAnswer(collector.bundle, chapter, conceptId),
        answers[index],
        `rebuilt Across groups differs for ${conceptId} on ${card.model} · ${card.useCase}${setting ? ` at ${setting}` : ''}`
      );
    });
    await out.write(staticPaths.subgroupBundle({ model: card.model, useCase: card.useCase, chapterId, setting }), collector.bundle);
    count += ids.length;
  }
  await out.write(staticPaths.subgroupSummary({ model: card.model, useCase: card.useCase, setting }), await api('/metrics/subgroups/summary', params));
  return count;
}

/**
 * A card's change history (v1.14, CONTRACT.md §26.6), with `after` checked
 * against the API, and its card record as JSON and JSON-LD (§32).
 */
async function recordCardFiles(api, out, card) {
  const cardParam = { card: `${card.model}|${card.useCase}` };
  const versions = await api('/versions', cardParam);
  await out.write(staticPaths.cardVersions(card), versions);
  const ids = versions.versions.map((entry) => entry.version_id);
  for (const after of [0, ids[Math.floor(ids.length / 2)], ids[0]].filter((value) => value !== undefined)) {
    assert.deepStrictEqual(cardVersionsAnswer(versions, { after }), await api('/versions', { ...cardParam, after }), `versions of ${cardParam.card} after ${after} differ`);
  }
  for (const format of ['json', 'jsonld']) {
    await out.write(staticPaths.cardRecord({ ...card, format }), await api('/cards/record', { model: card.model, use_case: card.useCase, format: format === 'jsonld' ? format : null }));
  }
}

const isEmptyCandidates = (answer) => answer.candidate_ids.length === 0 && (answer.display?.rows?.length ?? 0) === 0;

async function recordMultimorbidity(api, out, card, chapterIds, conditionIds, concurrency) {
  const base = { model: card.model, use_case: card.useCase };
  const candidatesAt = (selected, chapterId = null) =>
    api('/multimorbidity/candidates', { ...base, selected, scope: chapterId ? 'chapter' : 'atlas', chapter_id: chapterId });
  const allScopes = async (selected) => {
    const answers = await pool([null, ...chapterIds], concurrency, (chapterId) => candidatesAt(selected, chapterId));
    return { atlas: answers[0], chapters: Object.fromEntries(chapterIds.map((chapterId, index) => [chapterId, answers[index + 1]])) };
  };

  // Templates: answers for a selection in no stored combination.
  const none = await allScopes([]);
  const members = none.atlas.candidate_ids;
  const outsider = conditionIds.find((id) => !members.includes(id));
  const partner = members[0] ?? conditionIds.find((id) => id !== outsider);
  const templates = {
    candidates: { atlas: await candidatesAt([outsider]), chapter: await candidatesAt([outsider], chapterIds[0]) },
    combination: await api('/multimorbidity/combination', { ...base, selected: [outsider, partner] })
  };
  assert.ok(isEmptyCandidates(templates.candidates.atlas) && templates.combination.metrics === null, `no empty template for ${card.model}`);

  // Every subset of the members, growing until a whole size holds nothing.
  const recorded = { candidates: [], combinations: [] };
  const record = async (selected, scopes, combination) => {
    const key = selectionKey(selected);
    if (!isEmptyCandidates(scopes.atlas) || Object.values(scopes.chapters).some((answer) => !isEmptyCandidates(answer))) {
      recorded.candidates.push(key);
      await out.write(staticPaths.multimorbidityCandidates({ model: card.model, useCase: card.useCase, selected }), scopes);
    } else {
      assert.deepStrictEqual(emptySelectionAnswer(templates.candidates.atlas, selected), scopes.atlas, `empty candidates differ for ${key}`);
      Object.values(scopes.chapters).forEach((answer) =>
        assert.deepStrictEqual(emptySelectionAnswer(templates.candidates.chapter, selected), answer, `empty chapter candidates differ for ${key}`)
      );
    }
    if (combination) {
      if (combination.metrics !== null) {
        recorded.combinations.push(key);
        await out.write(staticPaths.multimorbidityCombination({ model: card.model, useCase: card.useCase, selected }), combination);
      } else {
        assert.deepStrictEqual(emptySelectionAnswer(templates.combination, selected), combination, `empty combination differs for ${key}`);
      }
    }
  };
  await record([], none, null);
  const sorted = [...members].sort();
  for (let size = 1; size <= sorted.length; size += 1) {
    const level = subsets(sorted, size).filter((selected) => selected.length === size);
    let held = 0;
    for (const selected of level) {
      const scopes = await allScopes(selected);
      const combination = size >= 2 ? await api('/multimorbidity/combination', { ...base, selected }) : null;
      const before = recorded.candidates.length + recorded.combinations.length;
      await record(selected, scopes, combination);
      held += recorded.candidates.length + recorded.combinations.length - before;
      if (size >= 2) {
        // The answer does not depend on the order of the selection, except `selected`.
        const reversed = [...selected].reverse();
        const key = selectionKey(selected);
        const answer = await candidatesAt(reversed);
        const expected = recorded.candidates.includes(key) ? withSelection(scopes.atlas, reversed) : emptySelectionAnswer(templates.candidates.atlas, reversed);
        assert.deepStrictEqual(expected, answer, `candidates depend on the order for ${key}`);
      }
    }
    if (!held && size >= 2) break;
  }
  await out.write(staticPaths.multimorbidityIndex({ model: card.model, useCase: card.useCase }), { ...recorded, templates });
  return recorded;
}

const cardIdOf = (card) => `${card.model}|${card.useCase}`;
const compareParams = (cards, ontology, lens, scope, chapterId) => ({
  cards: cards.map(cardIdOf),
  ...lens,
  ...ontologyParam(ontology),
  ...(scope === 'chapter' ? { scope, chapter_id: chapterId } : {})
});

/**
 * The comparison inputs of one classification (CONTRACT.md §25): the rows of
 * every scope (compare/rows.json) and, per card and lens, the card's facts
 * and cells at every scope (cards/<card>/<lens>/compare.json). Each card is
 * read next to the following one; every answer is rebuilt from the two
 * columns and compared with the API, and a column read twice (once as the
 * partner) must be the same both times, so a cell never depends on the other
 * cards. A sample of 3- and 4-card sets in shuffled orders is checked at the end.
 */
async function recordComparison(api, out, cards, ontology, lenses, chapters, concurrency) {
  const scopes = [{ scope: 'atlas', chapterId: null }, ...Object.keys(chapters).map((chapterId) => ({ scope: 'chapter', chapterId }))];
  const rows = { dataset_version: null, context: null, atlas: null, chapters: {} };
  let calls = 0;
  for (const lens of lenses) {
    const columns = new Map(cards.map((card) => [cardIdOf(card), { dataset_version: null, card: null, cells: {} }]));
    const keep = (column, answer, position, key) => {
      const facts = answer.cards[position];
      const cells = answer.rows.map((row) => encodeCell(row.cells[position]));
      if (column.card) assert.deepStrictEqual(facts, column.card, `comparison facts of ${facts.card_id} depend on the scope or the other card`);
      else column.card = facts;
      if (column.cells[key]) assert.deepStrictEqual(cells, column.cells[key], `comparison cells of ${facts.card_id} depend on the other card (${key})`);
      else column.cells[key] = cells;
      column.dataset_version = answer.dataset_version;
    };
    const jobs = scopes.flatMap((scope) => cards.map((card, index) => ({ ...scope, pair: [card, cards[(index + 1) % cards.length]] })));
    // Rows first (they are the same for every card), then every pair.
    for (const { scope, chapterId } of scopes) {
      const key = scopeKey(scope, chapterId);
      if (key === 'atlas' ? rows.atlas : rows.chapters[key]) continue;
      const answer = await api('/compare', compareParams(cards.slice(0, 2), ontology, lens, scope, chapterId));
      rows.dataset_version = answer.dataset_version;
      rows.context = answer.filters.context;
      if (answer.ontology) rows.ontology = answer.ontology;
      const skeletons = answer.rows.map(rowSkeleton);
      if (scope === 'atlas') rows.atlas = skeletons;
      else rows.chapters[chapterId] = { chapter_pt: answer.filters.chapter_pt, rows: skeletons };
    }
    await pool(jobs, concurrency, async ({ scope, chapterId, pair }) => {
      const answer = await api('/compare', compareParams(pair, ontology, lens, scope, chapterId));
      calls += 1;
      const key = scopeKey(scope, chapterId);
      const skeletons = scope === 'atlas' ? rows.atlas : rows.chapters[chapterId].rows;
      assert.deepStrictEqual(answer.rows.map(rowSkeleton), skeletons, `comparison rows depend on the cards (${key})`);
      const [first, second] = pair.map((card) => columns.get(cardIdOf(card)));
      keep(first, answer, 0, key);
      keep(second, answer, 1, key);
      const rebuilt = comparisonAnswer({
        rows,
        cards: [answer.cards[0], answer.cards[1]].map((card, position) => ({ card, cells: { [key]: answer.rows.map((row) => encodeCell(row.cells[position])) } })),
        scope,
        chapterId,
        lens
      });
      assert.deepStrictEqual(rebuilt, answer, `the static comparison differs from the API for ${pair.map(cardIdOf).join(' + ')} (${ontology}, ${lensKey(lens)}, ${key})`);
    });
    for (const card of cards) {
      const column = columns.get(cardIdOf(card));
      assert.equal(Object.keys(column.cells).length, scopes.length, `missing comparison scopes for ${cardIdOf(card)}`);
      await out.write(staticPaths.comparisonCard({ model: card.model, useCase: card.useCase, ontology: fileOntology(ontology), ...lens }), column);
    }
  }
  await out.write(staticPaths.comparisonRows(fileOntology(ontology)), rows);

  // A sample of larger sets, in shuffled orders, rebuilt from the written files.
  const random = seededRandom(0x5eed + ontology.length);
  const pick = (list) => list[Math.floor(random() * list.length)];
  for (let sample = 0; sample < COMPARISON_SAMPLE && cards.length >= 3; sample += 1) {
    const size = Math.min(cards.length, 3 + (sample % 2));
    const chosen = [...cards].sort(() => random() - 0.5).slice(0, size);
    const lens = pick(lenses);
    const { scope, chapterId } = sample % 3 === 0 ? scopes[0] : pick(scopes);
    const answer = await api('/compare', compareParams(chosen, ontology, lens, scope, chapterId));
    const rebuilt = comparisonAnswer({
      rows: out.read(staticPaths.comparisonRows(fileOntology(ontology))),
      cards: chosen.map((card) => out.read(staticPaths.comparisonCard({ model: card.model, useCase: card.useCase, ontology: fileOntology(ontology), ...lens }))),
      scope,
      chapterId,
      lens
    });
    assert.deepStrictEqual(rebuilt, answer, `the static comparison differs from the API for ${chosen.map(cardIdOf).join(' + ')} (${ontology}, ${lensKey(lens)}, ${scope} ${chapterId ?? ''})`);
    calls += 1;
  }
  return calls;
}

function log(text) {
  process.stdout.write(text);
}

/** Moves a finished recording over the previous one (a copy when the two are on different volumes). */
function replaceDirectory(from, to) {
  rmSync(to, { recursive: true, force: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

export async function record(argv = []) {
  const options = parseArgs(argv);
  const setup = pythonSetupProblem();
  if (setup) throw new Error(setup);
  if (!existsSync(options.store)) {
    throw new Error(`The store ${path.relative(REPO_ROOT, options.store)} does not exist. Build the demo store first (about 50 s):\n  npm run demo:build`);
  }
  const started = Date.now();
  const scratch = mkdtempSync(path.join(tmpdir(), 'bmc-static-'));
  const store = path.join(scratch, 'store.sqlite');
  cpSync(options.store, store);
  const port = await freePort(options.port);
  const env = { ...process.env, BMC_DB: store, BMC_UPLOADS_DIR: path.join(scratch, 'uploads'), BMC_API_PORT: String(port) };
  const child = spawnBackend({ port, env, stdio: 'inherit', args: ['--log-level', 'warning'] });
  try {
    await waitForBackend(port, { child });
    const api = apiClient(port);
    // Recorded next to the store copy and moved into place only when complete,
    // so a failed recording leaves the previous snapshot as it was.
    const recording = path.join(scratch, 'static-data');
    const out = writer(recording);

    const { meta, chapters } = await recordShared(api, out);
    const listed = (meta.ontologies ?? []).map((entry) => entry.id);
    const missing = options.ontologies.filter((id) => id !== ICD11 && !listed.includes(id));
    if (missing.length) {
      throw new Error(
        `The demo store has not imported ${missing.join(', ')} (it lists ${listed.join(', ') || 'ICD-11 only'}). Download the pinned releases and rebuild the store:\n  npm run ontologies:fetch && npm run demo:build\nor record fewer classifications with --ontologies.`
      );
    }
    const synonyms = readSynonyms(store);
    await out.write(staticPaths.synonyms(), synonyms);
    const searchIndex = await checkSearch(api, ICD11, chapters, { synonyms });
    const models = await api('/models');
    const interpreted = await checkInterpreter(api, meta, models, searchIndex);
    const cards = cardsOf(models);
    const records = await recordWholeLists(api, out, cards);
    const lenses = recordedLenses(meta.axes, options.lenses);
    const chapterIds = Object.keys(chapters);
    const conditionIds = Object.values(chapters).flatMap((answer) => answer.concepts.filter((concept) => concept.depth_in_kind === 1).map((concept) => concept.concept_id));
    const multimorbidity = {};
    const atlases = { [ICD11]: chapters };
    for (const ontology of options.ontologies.filter((id) => id !== ICD11)) {
      atlases[ontology] = await recordAtlas(api, out, ontology);
      await checkSearch(api, ontology, atlases[ontology], { overview: atlases[ontology].overview });
    }
    const mappingsWritten = new Map();
    const counts = { subgroups: 0, settingSubgroups: 0, comparisons: 0 };
    for (const card of cards) {
      log(`[static] ${card.model} · ${card.useCase}: rings`);
      await recordLensReads(api, out, card, ICD11, lenses, chapterIds, options.concurrency);
      log(', condition cards');
      await recordConcepts(api, out, card, ICD11, chapters, mappingsWritten, options.concurrency);
      log(', across groups');
      counts.subgroups += await recordSubgroups(api, out, card, chapters, options.concurrency);
      log(', multimorbidity');
      const recorded = await recordMultimorbidity(api, out, card, chapterIds, conditionIds, options.concurrency);
      multimorbidity[cardKey(card.model, card.useCase)] = recorded.combinations.length;
      log(', record and history');
      await recordCardFiles(api, out, card);
      // Contract v1.14 (§29): each care setting the card stores, at all patients in ICD-11.
      for (const setting of card.settings) {
        log(`, ${setting}`);
        await recordLensReads(api, out, card, ICD11, [{ ...DEFAULT_LENS, setting }], chapterIds, options.concurrency);
        await recordConcepts(api, out, card, ICD11, chapters, mappingsWritten, options.concurrency, setting);
        counts.settingSubgroups += await recordSubgroups(api, out, card, chapters, options.concurrency, setting);
      }
      for (const ontology of options.ontologies.filter((id) => id !== ICD11)) {
        log(`, ${ontology}`);
        const ids = Object.keys(atlases[ontology]);
        await recordLensReads(api, out, card, ontology, [{ ...DEFAULT_LENS }], ids, options.concurrency);
        await recordConcepts(api, out, card, ontology, atlases[ontology], mappingsWritten, options.concurrency);
      }
      log(`. ${megabytes(out.stats.bytes)} so far\n`);
    }
    for (const ontology of options.ontologies) {
      log(`[static] comparison inputs, ${ontology}`);
      const ontologyLenses = ontology === ICD11 ? lenses : [{ ...DEFAULT_LENS }];
      counts.comparisons += await recordComparison(api, out, cards, ontology, ontologyLenses, atlases[ontology], options.concurrency);
      log(`. ${megabytes(out.stats.bytes)} so far\n`);
    }

    const manifest = {
      format: 2,
      dataset_version: meta.dataset_version,
      recorded_at: new Date().toISOString(),
      synthetic_data_notice: meta.synthetic_data_notice,
      ontologies: options.ontologies,
      ontology_names: Object.fromEntries((meta.ontologies ?? []).filter((entry) => options.ontologies.includes(entry.id)).map((entry) => [entry.id, entry.name])),
      lenses: lenses.map((lens) => lensKey(lens)),
      details_lens: lensKey(DEFAULT_LENS),
      other_ontology_lenses: [lensKey(DEFAULT_LENS)],
      studies: records.studies,
      effects: records.effects,
      incidents: records.incidents,
      synonyms: Object.values(synonyms).reduce((total, list) => total + list.length, 0),
      interpret_queries_checked: interpreted.checked,
      subgroup_conditions: counts.subgroups,
      comparisons_checked: counts.comparisons,
      // Contract v1.14 (§29): the specific care settings recorded per card, at all patients in ICD-11.
      settings_lens: lensKey(DEFAULT_LENS),
      cards: cards.map((card) => ({
        model: card.model,
        use_case: card.useCase,
        key: cardKey(card.model, card.useCase),
        stored_combinations: multimorbidity[cardKey(card.model, card.useCase)],
        settings: card.settings
      }))
    };
    await out.write(staticPaths.manifest(), manifest);
    replaceDirectory(recording, options.out);
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(
      `[static] Recorded dataset version ${meta.dataset_version} in ${options.ontologies.join(', ')}: ${cards.length} cards × ${lenses.length} lenses (other classifications: all patients), ${cards.reduce((total, card) => total + card.settings.length, 0)} card settings, ${manifest.synonyms} synonyms, ${counts.comparisons} comparisons and ${interpreted.checked} interpretations checked against the API, ${out.stats.files} files, ${megabytes(await directorySize(options.out))}, in ${seconds} s → ${path.relative(REPO_ROOT, options.out)}`
    );
    return manifest;
  } finally {
    await stopProcess(child);
    rmSync(scratch, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  record(process.argv.slice(2)).catch((error) => {
    console.error(`[static] ${error.message}`);
    process.exit(1);
  });
}
