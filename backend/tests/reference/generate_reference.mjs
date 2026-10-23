// Generate parity fixtures from the reference client (tag v0.2.0-alpha.1).
//
//   node generate_reference.mjs --src <extracted tag dir> --seed <backend/seed> --out <dir>
//
// <extracted tag dir> holds `src/` and `package.json` from
// `git archive v0.2.0-alpha.1 src package.json` (tests/conftest.py does this).
// Writes <out>/reference.json with expected derivation outputs, and
// <out>/fallback_tables/, a reduced copy of the tables in which demographic
// lens combinations are missing so the fallback paths (CONTRACT.md §7, §8)
// are exercised. All data is synthetic.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SEED = 20261008;
const CONCEPT_CASES_PER_VARIANT = 300;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  for (const key of ['src', 'seed', 'out']) {
    if (!args[key]) {
      throw new Error(`Missing --${key}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const SRC = path.resolve(args.src);
// The seed: byte for byte the JSON files the tagged client fetched under data/tables/.
const TABLES = path.resolve(args.seed);
const OUT = path.resolve(args.out);
fs.mkdirSync(OUT, { recursive: true });

const fileUrl = (...parts) => pathToFileURL(path.join(...parts)).href;
const { buildTableDataset } = await import(fileUrl(SRC, 'src/data/tableDataset.js'));
const grading = await import(fileUrl(SRC, 'src/utils/grading.js'));
const { getOverallTier } = await import(fileUrl(SRC, 'src/utils/overallTier.js'));
const details = await loadDetailsPanelRules();

// The warning catalog and safeguard rules live inside DetailsPanel.jsx. The
// span between WARNING_RELEVANCE_ORDER and slugify() is plain JS (no JSX), so
// it is extracted verbatim into a module.
async function loadDetailsPanelRules() {
  const source = fs.readFileSync(path.join(SRC, 'src/components/DetailsPanel.jsx'), 'utf8');
  const start = source.indexOf('const WARNING_RELEVANCE_ORDER');
  const end = source.indexOf('function slugify(');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Could not locate the warning and safeguard rules in DetailsPanel.jsx');
  }
  const module = [
    `import { GRADE_COLORS, VALIDATION_TYPE_LABELS, isEvidenceWeakGrade, normalizeValidationType, performanceGradeFromPerf } from '${fileUrl(SRC, 'src/utils/grading.js')}';`,
    `import { getOverallTier } from '${fileUrl(SRC, 'src/utils/overallTier.js')}';`,
    source.slice(start, end),
    'export { WARNING_CATALOG, warningMeta, rankWarnings, buildSafeguards };'
  ].join('\n');
  const target = path.join(OUT, '_details_panel_rules.mjs');
  fs.writeFileSync(target, module);
  return import(pathToFileURL(target).href);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const tablesPath = (runtimePath) => path.join(TABLES, runtimePath.replace(/^data\/tables\//, ''));

const baseData = readJson(path.join(TABLES, 'atlas-base.json'));
const prevalenceData = readJson(path.join(TABLES, 'prevalence_by_code.json'));
const modelRegistry = readJson(path.join(TABLES, 'model-registry.json'));

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AXES = baseData.metric_axes;
const LENSES = [];
AXES.age_lens.forEach((age) => {
  AXES.sex_lens.forEach((sex) => {
    AXES.ethnicity_lens.forEach((ethnicity) => {
      LENSES.push({ age, sex, ethnicity });
    });
  });
});
const ALL_LENS = { age: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' };
const OLDER_LENS = { age: 'Age 65+', sex: 'All sexes', ethnicity: 'All ethnicities' };
const VIEW_MODES = {
  overall: 'Overall',
  performance: 'Performance',
  evidence: 'Evidence',
  intended_use: 'Intended use'
};

const concepts = baseData.concepts;
const conceptById = new Map(concepts.map((concept) => [concept.concept_id, concept]));
const rollupConcepts = concepts.filter((concept) => concept.level < 2);
const depthOneConditions = concepts.filter((concept) => concept.level === 2 && concept.depth_in_kind === 1);
const deeperConcepts = concepts.filter((concept) => concept.level === 2 && concept.depth_in_kind > 1);

const pick = (rng, items) => items[Math.floor(rng() * items.length)];
const filtersFor = (useCase, lens) => ({
  task_mode: useCase,
  context: 'Clinical',
  age_lens: lens.age,
  sex_lens: lens.sex,
  ethnicity_lens: lens.ethnicity
});

function serialize(row, useCase) {
  if (!row) {
    return null;
  }
  const overall = getOverallTier(row);
  const overallFromRow = grading.overallGradeFromRow(row);
  return {
    concept_id: row.concept_id,
    lens: row.lens,
    perf: row.perf,
    ci_low: row.ci_low,
    ci_high: row.ci_high,
    evidence_grade: row.evidence_grade,
    n_samples: row.n_samples,
    n_sites: row.n_sites,
    n_studies: row.n_studies,
    peer_reviewed_studies: row.peer_reviewed_studies,
    validation_type: row.validation_type,
    in_intended_use: row.in_intended_use,
    intended_use_coverage: row.intended_use_coverage,
    intended_use_level: row.intended_use_level,
    warnings: row.warnings,
    condition_ids: row.condition_ids ?? null,
    combination_label: row.combination_label ?? null,
    performance_grade: grading.performanceGradeFromPerf(row.perf),
    overall: { reason: overall.reason, grade: overall.grade, score: overall.score },
    overall_from_row: overallFromRow ? { grade: overallFromRow.grade, score: overallFromRow.score } : null,
    ranked_warnings: details.rankWarnings(row.warnings).map((warning) => [warning.code, warning.relevance]),
    safeguards: details.buildSafeguards(row, { task_mode: useCase }).map((item) => [item.id, item.priority])
  };
}

function buildDataset(registry, variant, metricsPayload, multimorbidityPayload) {
  return buildTableDataset({
    baseData,
    prevalenceData,
    modelRegistry: registry,
    modelMetricsData: metricsPayload,
    multimorbidityMetricsData: multimorbidityPayload,
    activeModelVersion: variant.model_version,
    activeUseCase: variant.use_case
  });
}

function singleDiseaseCases(dataset, useCase, rng, rollupLenses) {
  const get = (conceptId, lens) => dataset.getMetricRow(conceptId, filtersFor(useCase, lens));
  const rollups = [];
  rollupConcepts.forEach((concept) => {
    rollupLenses.forEach((lens) => {
      rollups.push({ concept_id: concept.concept_id, lens, row: serialize(get(concept.concept_id, lens), useCase) });
    });
  });
  const cases = [];
  for (let i = 0; i < CONCEPT_CASES_PER_VARIANT; i += 1) {
    const concept = rng() < 0.6 ? pick(rng, depthOneConditions) : pick(rng, deeperConcepts);
    const lens = pick(rng, LENSES);
    cases.push({ concept_id: concept.concept_id, lens, row: serialize(get(concept.concept_id, lens), useCase) });
  }
  return { rollups, cases };
}

function ancestorsOf(conceptId) {
  const result = [];
  let concept = conceptById.get(conceptById.get(conceptId)?.parent_id);
  while (concept) {
    result.push(concept.concept_id);
    concept = conceptById.get(concept.parent_id);
  }
  return result;
}

function multimorbidityCases(dataset, payload, useCase, rng) {
  if (!payload) {
    return null;
  }
  const inCombination = new Set(payload.combinations.flatMap((combination) => combination.condition_ids));
  const unrelated = depthOneConditions.find((concept) => !inCombination.has(concept.concept_id)).concept_id;
  const paths = new Map();
  const addPath = (ids) => paths.set(JSON.stringify(ids), ids);
  addPath([]);
  payload.combinations.forEach((combination, index) => {
    const ids = combination.condition_ids;
    for (let size = 1; size <= ids.length; size += 1) {
      addPath(ids.slice(0, size));
    }
    addPath([...ids].reverse());
    if (index < 6) {
      const deeper = deeperConcepts.find((concept) => concept.metric_anchor_id === ids[0]);
      if (deeper) {
        addPath([deeper.concept_id, ...ids.slice(1)]);
      }
      addPath([ids[0], unrelated]);
      addPath([conceptById.get(ids[0]).parent_id, ...ids]);
      addPath([ids[0], ids[0], ...ids.slice(1)]);
    }
  });
  addPath([unrelated]);

  const rowLenses = [ALL_LENS, OLDER_LENS, pick(rng, LENSES)];
  const randomLens = pick(rng, LENSES);
  const results = [];
  paths.forEach((selection) => {
    const candidates = dataset.getMultimorbidityCandidateIds(selection);
    const rows = rowLenses.map((lens) => ({
      lens,
      row: serialize(dataset.getMultimorbidityRow(selection, filtersFor(useCase, lens)), useCase)
    }));
    const displayIds = new Set();
    [...candidates, ...selection].forEach((conceptId) => {
      if (!conceptById.has(conceptId)) {
        return;
      }
      displayIds.add(conceptId);
      ancestorsOf(conceptId).forEach((ancestorId) => displayIds.add(ancestorId));
    });
    const displayLenses = selection.length === 0 ? [ALL_LENS, randomLens] : [ALL_LENS];
    const display = [];
    displayIds.forEach((conceptId) => {
      Object.entries(VIEW_MODES).forEach(([view, viewMode]) => {
        displayLenses.forEach((lens) => {
          const row = dataset.getMultimorbidityDisplayRow(conceptId, selection, filtersFor(useCase, lens), viewMode);
          display.push({ concept_id: conceptId, view, lens, row: serialize(row, useCase) });
        });
      });
    });
    results.push({ selection, candidates, rows, display });
  });
  return { has_data: dataset.hasMultimorbidityData, paths: results };
}

function variantFixture(registry, variant, tablesRoot, rng, rollupLenses) {
  const metricsPayload = readJson(path.join(tablesRoot, variant.metrics_file.replace(/^data\/tables\//, '')));
  const multimorbidityPayload = variant.multimorbidity_metrics_file
    ? readJson(path.join(tablesRoot, variant.multimorbidity_metrics_file.replace(/^data\/tables\//, '')))
    : null;
  const dataset = buildDataset(registry, variant, metricsPayload, multimorbidityPayload);
  return {
    model_version: variant.model_version,
    use_case: variant.use_case,
    ...singleDiseaseCases(dataset, variant.use_case, rng, rollupLenses),
    multimorbidity: multimorbidityCases(dataset, multimorbidityPayload, variant.use_case, rng),
    has_multimorbidity_data: dataset.hasMultimorbidityData,
    // summarizeDataset(): the `summary` of the dataset export.
    summary: dataset.metrics
  };
}

function registryVariants(registry) {
  return registry.models.flatMap((model) =>
    model.use_case_variants.map((variant) => ({
      model_version: model.model_version,
      use_case: variant.use_case,
      metrics_file: variant.metrics_file,
      multimorbidity_metrics_file: variant.multimorbidity_metrics_file || null
    }))
  );
}

// ------------------------------------------------------------ fallback tables

// Keep only some lens combinations so that requests for the others fall back.
const FALLBACK_REDUCTIONS = [
  {
    use_case: 'Clinician Facing CDSS',
    name: 'specific-lenses-only',
    keep: (combo) => combo.age_lens !== 'All ages' && combo.sex_lens !== 'All sexes' && combo.ethnicity_lens !== 'All ethnicities'
  },
  {
    use_case: 'Discharge letter generation',
    name: 'female-specific-lenses-only',
    keep: (combo) => combo.age_lens !== 'All ages' && combo.sex_lens === 'Sex Female' && combo.ethnicity_lens !== 'All ethnicities'
  }
];
const FALLBACK_MODEL = 'SynGPT-2.0';

function writeFallbackTables() {
  const root = path.join(OUT, 'fallback_tables');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'models'), { recursive: true });
  fs.copyFileSync(path.join(TABLES, 'atlas-base.json'), path.join(root, 'atlas-base.json'));
  fs.copyFileSync(path.join(TABLES, 'prevalence_by_code.json'), path.join(root, 'prevalence_by_code.json'));

  const model = modelRegistry.models.find((entry) => entry.model_version === FALLBACK_MODEL);
  const variants = FALLBACK_REDUCTIONS.map((reduction) => {
    const source = model.use_case_variants.find((variant) => variant.use_case === reduction.use_case);
    const metrics = readJson(tablesPath(source.metrics_file));
    const kept = metrics.combo_definitions
      .map((combo, index) => ({ combo, index }))
      .filter(({ combo }) => reduction.keep(combo));
    const reducedMetrics = {
      ...metrics,
      combo_count: kept.length,
      combo_definitions: kept.map(({ combo }) => combo),
      rows_by_condition_id: Object.fromEntries(
        Object.entries(metrics.rows_by_condition_id).map(([conditionId, rows]) => [
          conditionId,
          kept.map(({ index }) => rows[index])
        ])
      )
    };
    const metricsFile = `data/tables/models/fallback-${reduction.name}.metrics.json`;
    fs.writeFileSync(path.join(root, metricsFile.replace(/^data\/tables\//, '')), JSON.stringify(reducedMetrics));

    // Multimorbidity rows for the same lenses, borrowed from the first
    // condition's single-disease rows (any valid tuple exercises the logic).
    const multimorbidity = readJson(tablesPath(source.multimorbidity_metrics_file));
    const reducedMultimorbidity = {
      ...multimorbidity,
      combo_count: kept.length,
      combo_definitions: kept.map(({ combo }) => combo),
      combinations: multimorbidity.combinations.map((combination) => ({
        ...combination,
        rows: kept.map(({ index }) => metrics.rows_by_condition_id[combination.condition_ids[0]][index])
      }))
    };
    const multimorbidityFile = `data/tables/models/fallback-${reduction.name}.multimorbidity.metrics.json`;
    fs.writeFileSync(path.join(root, multimorbidityFile.replace(/^data\/tables\//, '')), JSON.stringify(reducedMultimorbidity));
    return { use_case: reduction.use_case, metrics_file: metricsFile, multimorbidity_metrics_file: multimorbidityFile };
  });

  const registry = {
    ...modelRegistry,
    default_model_version: FALLBACK_MODEL,
    models: [{ ...model, use_case_variants: variants }]
  };
  fs.writeFileSync(path.join(root, 'model-registry.json'), JSON.stringify(registry, null, 2));
  return { root, registry };
}

// ------------------------------------------------------------------------ main

const rng = mulberry32(SEED);
const fixtures = {
  meta: {
    reference: 'v0.2.0-alpha.1',
    generated_at: new Date().toISOString(),
    node: process.version,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    seed: SEED
  }
};

const probe = buildDataset(modelRegistry, registryVariants(modelRegistry)[0],
  readJson(tablesPath(registryVariants(modelRegistry)[0].metrics_file)), null);
fixtures.prevalence = Object.fromEntries(probe.concepts.map((concept) => [concept.concept_id, concept.prevalence_score ?? null]));

// Block and chapter prevalence as src/App.jsx (lines 128-176) computes it.
{
  const childByParent = {};
  probe.concepts.forEach((concept) => {
    if (!concept.parent_id) {
      return;
    }
    (childByParent[concept.parent_id] ||= []).push(concept.concept_id);
  });
  const byId = Object.fromEntries(probe.concepts.map((concept) => [concept.concept_id, concept]));
  const memo = {};
  const visit = (conceptId) => {
    if (Object.prototype.hasOwnProperty.call(memo, conceptId)) {
      return memo[conceptId];
    }
    const concept = byId[conceptId];
    if (!concept) {
      return null;
    }
    if (concept.level === 2) {
      memo[conceptId] = concept.prevalence_score ?? null;
      return memo[conceptId];
    }
    let sum = 0;
    let count = 0;
    (childByParent[conceptId] || []).forEach((id) => {
      const prevalence = visit(id);
      if (prevalence == null) {
        return;
      }
      sum += prevalence;
      count += 1;
    });
    memo[conceptId] = count ? sum / count : null;
    return memo[conceptId];
  };
  probe.concepts.forEach((concept) => visit(concept.concept_id));
  fixtures.display_prevalence = memo;
}

fixtures.collation = {
  preferred_terms: [...new Set(concepts.map((concept) => concept.pt))].sort((a, b) => a.localeCompare(b)),
  concept_ids: concepts.map((concept) => concept.concept_id).sort((a, b) => a.localeCompare(b))
};

// ------------------------------------------------------------------ search

// Search lives inside the App component (src/App.jsx: searchableConcepts and
// handleSearchSubmit), so it cannot be imported. It is copied here; the source
// check below fails generation if the tagged code differs from the copy.
const SEARCH_QUERIES = [
  '1A03.1',
  '5A1',
  'diabetes',
  'DiAbEtEs',
  '  asthma  ',
  '  1c43 ',
  'CH-05',
  'BLK-01',
  'ICD-11 category 1A0',
  'Escherichia coli infection',
  'e',
  'zzqxj'
];
{
  const appSource = fs.readFileSync(path.join(SRC, 'src/App.jsx'), 'utf8');
  for (const fragment of [
    'const MAX_SEARCH_MATCHES = 80;',
    'conceptCode: String(concept.icd11_code || concept.concept_id).toLowerCase(),',
    'haystack: `${concept.pt} ${concept.fsn} ${concept.concept_id}`.toLowerCase()',
    'const query = searchValue.trim();',
    'const normalized = query.toLowerCase();',
    'return entry.conceptCode.includes(normalized) || entry.haystack.includes(normalized);',
    'return a.level - b.level;',
    'return a.pt.localeCompare(b.pt);',
    'const trimmedMatches = matches.slice(0, MAX_SEARCH_MATCHES);'
  ]) {
    if (!appSource.includes(fragment)) {
      throw new Error(`src/App.jsx search differs from the copy in generate_reference.mjs: ${fragment}`);
    }
  }
}

function referenceSearch(datasetConcepts, rawQuery) {
  const MAX_SEARCH_MATCHES = 80;
  const searchableConcepts = datasetConcepts.map((concept) => ({
    concept,
    conceptCode: String(concept.icd11_code || concept.concept_id).toLowerCase(),
    haystack: `${concept.pt} ${concept.fsn} ${concept.concept_id}`.toLowerCase()
  }));
  const query = rawQuery.trim();
  const normalized = query.toLowerCase();
  const matches = searchableConcepts
    .filter((entry) => {
      return entry.conceptCode.includes(normalized) || entry.haystack.includes(normalized);
    })
    .map((entry) => entry.concept)
    .sort((a, b) => {
      if (a.level !== b.level) {
        return a.level - b.level;
      }
      return a.pt.localeCompare(b.pt);
    });
  const trimmedMatches = matches.slice(0, MAX_SEARCH_MATCHES);
  return { raw: rawQuery, query, total: matches.length, concept_ids: trimmedMatches.map((concept) => concept.concept_id) };
}

fixtures.search = SEARCH_QUERIES.map((rawQuery) => referenceSearch(probe.concepts, rawQuery));

const rollupLenses = () => [ALL_LENS, OLDER_LENS, pick(rng, LENSES), pick(rng, LENSES)];
fixtures.variants = registryVariants(modelRegistry).map((variant) => {
  process.stdout.write(`reference: ${variant.model_version} / ${variant.use_case}\n`);
  return variantFixture(modelRegistry, variant, TABLES, rng, rollupLenses());
});

const fallback = writeFallbackTables();
fixtures.fallback_variants = registryVariants(fallback.registry).map((variant) => {
  process.stdout.write(`reference (fallback): ${variant.model_version} / ${variant.use_case}\n`);
  return variantFixture(fallback.registry, variant, fallback.root, rng, [
    ALL_LENS,
    OLDER_LENS,
    { age: 'Age 18-39', sex: 'Sex Male', ethnicity: 'All ethnicities' },
    pick(rng, LENSES)
  ]);
});

fs.writeFileSync(path.join(OUT, 'reference.json'), JSON.stringify(fixtures));
process.stdout.write(`wrote ${path.join(OUT, 'reference.json')}\n`);
