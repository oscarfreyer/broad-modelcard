// Single data boundary between the UI and its data source.
//
// Components must reach data only through a client created here. Each method
// corresponds to exactly one operation in backend/openapi.json (contract v1);
// tests/apiContract.test.js keeps the two in sync. Semantics are defined in
// backend/CONTRACT.md.
//
// The adapter (api/apiAdapter.js) implements every method against the FastAPI
// backend under /api/v1 and returns the response shapes from the contract.
// Tests may pass their own adapter, e.g. one over a mocked fetch.

/**
 * @typedef {'All ages'|'Age 0-17'|'Age 18-39'|'Age 40-64'|'Age 65+'} AgeLens
 * @typedef {'All sexes'|'Sex Female'|'Sex Male'} SexLens
 * @typedef {'All ethnicities'|'Ethnicity White'|'Ethnicity Black'|'Ethnicity Hispanic'|'Ethnicity Asian'|'Ethnicity Other'} EthnicityLens
 * @typedef {'live'|`staged:${string}`} DatasetVersionRef
 * @typedef {'overall'|'performance'|'evidence'|'intended_use'} MetricView
 * @typedef {MetricView|'safety'} SummaryView getMetricSummary's views; safety counts conditions by safety mark (v1.7)
 * @typedef {'serious'|'caution'} SafetyMark the MetricMap `safety` column and SafetyIncident.severity (v1.7)
 * @typedef {'models'|'metrics'|'multimorbidity'|'prevalence'|'safety'|'population'|'studies'|'effects'|'local_metrics'|'model_cards'} DatasetKind
 * @typedef {'replace'|'merge'} UploadMode merge: only the uploaded rows change (v1.7, CONTRACT.md §11.2)
 *
 * @typedef {object} ReadOptions
 * @property {DatasetVersionRef} [version] Defaults to 'live'.
 * @property {AbortSignal} [signal]
 *
 * @typedef {object} MetricQuery
 * @property {string} model model_version from the registry.
 * @property {string} useCase
 * @property {AgeLens} [age]
 * @property {SexLens} [sex]
 * @property {EthnicityLens} [ethnicity]
 * @property {string} [setting] a specific care setting (v1.14), sent as `context`; absent: Any setting
 * @property {string} [population] a local population id (v1.10); absent: the default population
 */

/**
 * Client method name → contract operationId. The order mirrors openapi.json.
 * Methods take one params object plus ReadOptions where the operation reads data,
 * and return a Promise. getCatalogue has no params, so it also takes its
 * ReadOptions as the only argument: `getCatalogue({ version, signal })`.
 * JSON operations resolve to the contract's response body; exportDataset
 * resolves to a Blob, because the full export exceeds the maximum JavaScript
 * string length and must not be parsed. The two file
 * downloads are URL builders instead: getTemplateUrl and getAnnotatedUploadUrl
 * return the URL as a string, for a plain download link.
 *
 * Contract v1.7 (safety incidents, merge uploads, change notes):
 * - createUpload({ kind, file, modelVersion, useCase, replaceStaged, mode }) takes
 *   `mode: 'replace' | 'merge'` (default replace).
 * - createRecordsUpload({ kind, records, modelVersion, useCase, replaceStaged })
 *   stages JSON records (one object per template row) as a merge upload; report
 *   examples carry `record`, the record's index.
 * - publishUpload({ uploadId, previewed, note }) and rollbackVersion({ versionId,
 *   kind, note }) take an optional change note (at most 500 characters).
 * - getMetricSummary({ ..., view: 'safety' }) counts conditions by safety mark.
 *
 * Contract v1.8 (the live interaction plugin, CONTRACT.md §19):
 * - lookup(body, { version, signal }) POSTs a CDS Hooks–shaped LookupRequest as
 *   given and resolves to the Lookup: per code its statuses, warnings,
 *   safeguards, incidents, provenance, and card link, plus the stored
 *   combination (or null). Unknown keys anywhere are rejected (422); case
 *   inputs travel in the body only, never in the URL.
 *
 * @typedef {object} LookupRequest
 * @property {'broad-modelcard-lookup'} [hook]
 * @property {{
 *   card: { model_version: string, use_case: string },
 *   conditions: Array<{ system?: 'http://id.who.int/icd/release/11/mms', code: string }>,
 *   population?: { age_group?: '0-17'|'18-39'|'40-64'|'65+'|null, sex?: 'female'|'male'|null,
 *     ethnicity?: 'white'|'black'|'hispanic'|'asian'|'other'|null }|null,
 *   population_id?: string|null
 * }} context 1 to 12 conditions; null or absent population values mean the whole population;
 *   population_id (v1.10) names a local population (absent: the default one)
 *
 * Contract v1.9 (assisted data entry, CONTRACT.md §20). The helper proposes,
 * never publishes:
 * - getAssistStatus() resolves to AssistStatus: on or off, provider, model,
 *   base URL, whether a key is set (never the key), accepted inputs, and the
 *   how-to-enable and privacy texts.
 * - configureAssist({ provider, model, baseUrl, apiKey }) turns it on: 'hosted'
 *   with the maintainer's own API key (write-only; omit it to keep the stored
 *   one) or 'local' with an OpenAI-compatible base URL. clearAssist() turns it off.
 * - proposeRecords({ kind, file, text, modelVersion, useCase }) sends one study
 *   (a file, or pasted text) and resolves to AssistProposals: batches of records
 *   with per-field sources and uncertainty, and dropped items with reasons.
 *   Accepting is createRecordsUpload({ kind: batch.kind, modelVersion:
 *   batch.model_version, useCase: batch.use_case, records: accepted.map((r) =>
 *   r.record) }): a staged merge upload that goes through check, change summary,
 *   preview, and publish like any other.
 *
 * Contract v1.10 (local populations, CONTRACT.md §21):
 * - Every read that depends on prevalence takes an optional `population` param,
 *   a local population id from getMeta().populations: getCatalogue({ population }),
 *   getAtlasOverview({ population }), getChapter({ chapterId, population }),
 *   getMetricMap, getMetricSummary, getConceptMetrics, the multimorbidity reads,
 *   and exportConcept (MetricQuery.population), searchConcepts({ q, limit,
 *   population }), and exportDataset({ model, useCase, population }). Its tiers
 *   replace the default ones for that request; the response names it in
 *   `population: { id, name }` (absent for the default) and an unknown id
 *   rejects with code `unknown_population`. getMeta and listModels take none.
 * - lookup names it in the body: `context.population_id`.
 * - createUpload({ kind: 'population', file, populationId, populationName })
 *   stages a local population (replace only); getTemplateUrl({ kind:
 *   'population', filled, populationId }); removePopulation({ populationId,
 *   note }) publishes a version without it.
 * - getMetricMap (and the multimorbidity `display` map) end with the column
 *   `child_count`: a block or chapter row's number of conditions with a row
 *   for the lens, null for other rows. 0 marks a rollup without children,
 *   served as out of scope for parity; present it as No data (CONTRACT.md §6,
 *   §13, V1). decodeMetricMap reads it by name like every column.
 */
/*
 * Contract v1.11:
 * - Intended use is optional: UseCaseEntry and catalogue tiles carry
 *   `intended_use_defined` (absent means true). For a card without a statement
 *   every intended-use field is null (MetricRow, map column, lookup, summary
 *   `intended_use_counts`, tile `distribution.intended_use`), and the overall
 *   score uses getMeta().overall_score_weights_without_intended_use. A row may
 *   also lack intended use on a card that has a statement (null fields).
 * - The status `not_validated` is gone: a row without an evidence grade is
 *   `no_data` on overall and evidence, and distributions have no such key.
 * - getCatalogue() tiles have `snapshot.blocks = [{ id, chapter, overview,
 *   safety }]` (one per subchapter, atlas order), added by the adapter from
 *   the compact wire form (`snapshot_blocks`, `snapshot.overview`,
 *   `snapshot.safety`).
 * - listIncidents({ model, useCase, version }) resolves to `{ dataset_version,
 *   incidents }`: every stored incident (closed ones included), newest first.
 * - rollbackVersion rejects with code `rollback_no_change` (409) when the
 *   restore would change nothing; no version is added. `everyKind: true`
 *   restores every data set in one version (422 `invalid_rollback` with `kind`).
 *
 * Contract v1.13 (studies and appraisal, CONTRACT.md §22):
 * - A data set kind `studies` (DatasetKind): templates, file and records
 *   uploads (replace or merge), history, and rollback like every kind.
 * - listStudies({ model }, { version, signal }) resolves to `{ dataset_version,
 *   studies }`; getStudy({ studyId }) to `{ dataset_version, study }` (404
 *   `unknown_study`). The static build serves both from its recorded list (R7).
 * - getConceptMetrics and exportConcept: a row whose evidence grade a linked
 *   study entered carries `metrics.appraisal` = `{ study, study_adjustment,
 *   applied, terms }` (study and terms null on an aggregated row); absent
 *   otherwise. getMeta() adds `evidence_signal_weights` and
 *   `evidence_study_adjustments` for the explanation.
 *
 * Contract v1.13, phase R3 (Across groups, CONTRACT.md §24):
 * - getConceptSubgroups({ model, useCase, conceptId, population, ontology }, { version,
 *   signal }) resolves to `{ dataset_version, concept, filters, all_patients,
 *   groups, population? }`: the concept at all patients and at each one-group
 *   lens (no lens params), each a SubgroupResult with perf, CI, statuses,
 *   safety, provenance, and on groups `difference: { delta, direction,
 *   flagged, reason }`. getMeta() adds `subgroup_difference` (the published
 *   rule, a prototype heuristic, not a grade). The static build records it
 *   for the ICD-11 conditions and rejects other concepts with `static_unavailable`.
 *   With local results for the population (§24 Layers) every entry adds
 *   `layer`, each difference `compared_with` (reason `layer_differs` when a
 *   local group has no local all-patients result), and the body
 *   `public_all_patients` when all patients is not a public result.
 */
/*
 * Contract v1.13 (ontologies, CONTRACT.md §23):
 * - getAtlasOverview, getChapter, getMetricMap, getMetricSummary,
 *   getConceptMetrics, searchConcepts, and exportConcept take an optional
 *   `ontology` param, an id from getMeta().ontologies ('icd10cm', 'mondo'
 *   when the store imported them). ICD-11 ('icd11', or none) sends nothing,
 *   so those reads are unchanged. The response names it in `ontology: { id,
 *   name }`; an unknown id rejects with code `unknown_ontology`.
 * - In another ontology getMetricMap adds `mapping` (each row's crosswalk
 *   kind: exact, stem, block, parent, none; null for a rollup), which
 *   decodeMetricMap puts on each row; getMetricSummary adds `mapping_counts`;
 *   getConceptMetrics adds `mapping` and `other_parents`; concept records
 *   carry the ontology's own `code` (icd11_code null). Kind `none` is drawn
 *   as No mapping. getMeta() lists `ontologies`, ICD-11 first.
 */
/*
 * Contract v1.13, phase R6 (intervention effects, CONTRACT.md §27):
 * - A data set kind `effects` (DatasetKind): templates, file and records
 *   uploads (replace or merge), history, and rollback like every kind.
 * - listEffects({ model, useCase }, { version, signal }) resolves to
 *   `{ dataset_version, effects }`: every effect of the version in stored
 *   order, each with its `study` record (null when the studies set no longer
 *   holds it). The static build serves it from its recorded list (R7).
 * - getConceptMetrics adds `effects` (the card's effects that concern the
 *   concept) only when there are any; effects never change a grade.
 */
/*
 * Contract v1.13 (comparison, CONTRACT.md §25):
 * - getComparison({ cards, scope, chapterId, age, sex, ethnicity, population,
 *   ontology }, { version, signal }) reads 2 to 4 cards side by side. `cards`
 *   is an array of card ids (`<model_version>|<use_case>`), sent as one
 *   comma-separated `cards` value; `scope` is 'atlas' (one row per chapter)
 *   or 'chapter' (its blocks, each followed by its depth-1 conditions, with
 *   `chapterId`). Each row has one cell per card, `comparable`, `reasons`
 *   ({ code, cards }), and `perf_spread`; the rule is in getMeta().comparison.
 *   Errors: `invalid_cards` (422), `unknown_model` / `unknown_use_case` (404).
 *   The static build computes it from recorded per-card inputs (R7).
 */
/*
 * Contract v1.13 (local results, instance, roles, nested model cards, CONTRACT.md §26):
 * - Data set kinds `local_metrics` (createUpload({ kind: 'local_metrics', file,
 *   modelVersion, useCase, populationId }), or records with populationId) and
 *   `model_cards` (createModelCardUpload({ modelVersion, format: 'json' |
 *   'markdown', content, submissionId })).
 * - A read with `population` of a card with local results serves them:
 *   getMetricMap adds `layer` (local, includes_local, or null per row; decodeMetricMap
 *   puts it on each row), getConceptMetrics marks `metrics.provenance.layer`
 *   'local' and adds `public_metrics`.
 * - getMeta().instance names the instance; updateInstance({ kind, organisation,
 *   maintainedBy, contact }) sets it (v1.14: also dataProtectionNote).
 * - publishUpload, rollbackVersion, removePopulation, and publishReleaseImport take
 *   `role` and `publisherName` (no login); VersionEntry carries publisher_role and
 *   publisher_name. listDatasetVersions({ after }) is the public version feed.
 * - Submissions: createSubmission({ developerName, modelVersion, note }); uploads
 *   join with `submissionId` (createUpload, createRecordsUpload,
 *   createModelCardUpload); listSubmissions({ status }), getSubmission({ submissionId }),
 *   acceptSubmission({ submissionId, note, publisherName }), returnSubmission(...).
 *   publishUpload of a submission's upload rejects with `submission_upload`.
 * - getNarrowModelCard({ modelVersion }) reads an AI system's narrow model card
 *   (or null); getModelCardProposals({ uploadId }) proposes metric records from it.
 * - getReleaseExportUrl() is the URL of the public release bundle (a URL builder);
 *   importPublicRelease({ file }), getReleaseImport({ importId }),
 *   publishReleaseImport({ importId, note, role, publisherName }), discardReleaseImport.
 * - The static build rejects every new method with `static_unavailable`.
 */
/*
 * Decisions of 2026-10-21 (CONTRACT.md §11.1, §17, §22):
 * - getMetricMap adds `appraisal` when at least one row of the answer rests on a
 *   study record: linked (a condition), includes_linked (a result over several
 *   conditions), or null per row; decodeMetricMap puts it on each row. Absent
 *   means no row is linked, so every row reads null: Not appraised.
 * - getMetricSummary adds `appraisal_counts` ({ graded, linked }: depth-1
 *   conditions with an evidence grade, and those linked) when one is linked.
 * - A catalogue tile's `last_updated` also follows the study records its rows link.
 * - createSubmission and registry uploads refuse "|" and "," in a model version or
 *   function (`separator_in_name`). The static build records both new fields.
 */
/*
 * Contract v1.14, release 0.5 phase Q2 (CONTRACT.md §22, §24):
 * - Study gains optional fields, each sent only when stored (never null):
 *   `applicability` (low, high, unclear) and `applicability_notes`,
 *   `quality_tool` (probast_ai, appraise_ai, quadas_ai, other) and
 *   `quality_score` (0–100), `setting_category` (emergency_department,
 *   intensive_care, inpatient_ward, outpatient_clinic, primary_care, mixed), and
 *   `configuration_id`. Never graded. The studies template, the one-study form,
 *   and the embedded `appraisal.study` carry them.
 * - SubgroupResult gains `n_samples` and `n_sites` (null without a row).
 * - getSubgroupSummary({ model, useCase, population, ontology }, { version, signal })
 *   resolves to `{ dataset_version, filters, classification_basis: 'icd11', total,
 *   all_patients_with_result, layered, groups, population? }`: per one-group lens
 *   `with_result`, `no_result`, `compared`, `flagged_higher`, `flagged_lower`, and up
 *   to 5 `flagged` conditions ({ concept_id, code, pt, chapter_id, delta, direction }).
 *   Always over ICD-11 depth-1 conditions; a heuristic, never a grade. The static
 *   build records it per card, at Any setting and at each stored setting (Q9).
 * Contract v1.14, phase Q1 (CONTRACT.md §28, §26.2).
 * Every new field is sent only when given, so earlier data reads as before:
 * - listModels and getCatalogue: a card (UseCaseEntry, CatalogueTile) adds
 *   `configuration` (ConfigurationRecord: configuration_id, configuration_date,
 *   prompt_summary, prompt_sha256, retrieval, tools, sampling_temperature,
 *   sampling_top_p, sampling_max_output_tokens, fine_tuning; every field, null
 *   where not given), `performance_measure`, and `reference_standard`;
 *   `declarations` adds declared_data_use, declared_data_location,
 *   declared_retention, declared_privacy_contact (all four, when one is given).
 * - ModelEntry and CatalogueTile.system add `replaces` (the model version it
 *   supersedes) and the derived `replaced_by` (a list, when not empty).
 * - function_category adds 'patient_communication' and 'administrative'.
 * - getMeta().instance adds `data_protection_note` when set;
 *   updateInstance({ ..., dataProtectionNote }) sets it (left out: cleared).
 */
/*
 * Contract v1.14, phase Q4 (CONTRACT.md §25, §22, §28.5).
 * No new method; every new field is sent only where it applies:
 * - getComparison: reasons `measure_differs`, `measure_unknown` (card level, only when a
 *   card states a performance measure) and `setting_differs` (row level, last). A cell
 *   adds `layer` (local, includes_local, public; a card with local results for the
 *   population, cells with values only) and `setting_category` (its linked study's).
 *   A card adds `performance_measure`, `reference_standard`, `configuration`
 *   ({ configuration_id, configuration_date }) when given, and always
 *   `narrow_model_card` ({ present, submitted_at }) and `conductors`
 *   ({ developer, independent, hospital }). The static build applies the same rule.
 * - getMetricSummary adds `configuration_counts` ({ current, earlier, not_stated })
 *   exactly when it adds `appraisal_counts`. Information only, never a grade.
 * - A studies check may note `configuration_not_in_registry` (non-blocking).
 * - Built on (the condition card) reads the base model's card with the existing
 *   getConceptMetrics; no new read.
 */
/*
 * Contract v1.14, release 0.5 phase Q3 (care settings, CONTRACT.md §29):
 * - The lens reads take an optional `setting`, a specific care setting's axis
 *   value from getMeta().axes.context ('Emergency department', 'Intensive care',
 *   'Inpatient ward', 'Outpatient clinic', 'Primary care'), sent as `context`:
 *   getMetricMap, getMetricSummary, getConceptMetrics, getConceptSubgroups,
 *   getSubgroupSummary, getComparison, the multimorbidity reads, and
 *   exportConcept (MetricQuery.setting). Absent (or 'Clinical', Any setting)
 *   sends nothing, so those reads are unchanged. A specific setting reads only
 *   the rows stored for it: No data where the card stores none, never the
 *   Any-setting result; `filters.context` names it, and an unknown value rejects
 *   with `invalid_lens`.
 * - getMeta().axes.context lists 'Clinical' and the five settings. listModels
 *   use case entries and comparison card facts (`lenses.settings`) carry
 *   `settings`, the settings the card stores rows for, only when one is specific.
 * - lookup: `context.setting` takes a setting's code (emergency_department, …);
 *   the response's `lens.context` names the setting and card links carry `setting`.
 * - Uploads: metrics and local results take an optional Setting column; the
 *   change summary adds `rows.settings` (per specific setting) and `setting` on samples.
 * - The static build offers Any setting only.
 */
/*
 * Contract v1.14, phase Q6 (CONTRACT.md §31, §9, §20):
 * - searchConcepts (ICD-11, when the store imported synonyms) lists concepts
 *   found by a synonym only after every other match; such a result adds
 *   `match: 'synonym'` and `matched_term`. Other results are unchanged.
 * - interpretQuery({ q }, { version, signal }) resolves to `{ query, chips,
 *   unrecognized }`: chips `{ kind, value, label, matched_text }` with kind
 *   system (value: model_version), function (use_case), condition (concept_id;
 *   also code, pt, match 'term'|'synonym'|'code', matched_term, concept), age,
 *   sex, ethnicity (lens values), setting (a Context axis value). Nothing is
 *   applied; the reader applies the chips. The static build interprets with
 *   the same rules over its snapshot (no synonyms, no settings).
 * - interpretQueryWithHelper({ q }) POSTs the query to the configured helper
 *   (409 assist_not_configured when off; the static build rejects it) and
 *   resolves to the same fields plus `provider`, `model`, and `dropped`
 *   ({ kind, value, reason }). Only the query and the vocabularies leave the
 *   machine. Offer it only when getAssistStatus().enabled.
 * Contract v1.14, release 0.5 phase Q5 (audience reads, CONTRACT.md §30):
 * - getMetricSummary({ ..., weights: 'prevalence' }) adds `weighted_distribution`:
 *   each status's share (0–1, 4 decimals) of the prevalence weight of the
 *   depth-1 conditions, at the lens, setting, population, and classification
 *   asked for. Keys follow the view's counts (the five statuses; for
 *   intended_use the levels and no_data; for safety serious, caution, none).
 *   Left out, the read and its URL are unchanged.
 * - listDatasetVersions({ after, card }): `card` is a card id
 *   (`<model_version>|<use_case>`); only the versions that changed that card
 *   (CONTRACT.md §17's rule), newest first; the first is the tile's
 *   `last_updated`. An unknown card gives an empty list.
 * - listSafetyIncidents({ model, useCase }) resolves to `{ dataset_version,
 *   incidents }`: every incident of the version (open, mitigated, closed),
 *   newest first, as the Data Library's listIncidents serves them, as a
 *   public read.
 * - The static build records listSafetyIncidents, the weighted summary (view
 *   overall), and each card's listDatasetVersions with `card`; the
 *   whole feed rejects with `static_unavailable`.
 */
/*
 * Contract v1.14, phase Q7 (CONTRACT.md §32, §33):
 * - getCardRecord({ model, useCase, format }) resolves to the card record
 *   (`format: 'bmc-card-record/1'`): the AI system, the card, linked studies,
 *   effects, public incidents, per-chapter statuses, and the Overview counts at
 *   all patients; `format: 'jsonld'` resolves to the same content as JSON-LD.
 *   The static build records both forms for every card.
 * - getCdsServices() is CDS Hooks discovery; callCdsService(request) POSTs a
 *   CDS Hooks 2.0 patient-view request (FHIR Patient and a Bundle of
 *   Condition resources in ICD-11 MMS or ICD-10-CM; `extension['broad-modelcard']
 *   = { card_id, setting?, population? }`) and resolves to `{ cards }`, one per
 *   condition. A malformed request rejects with code `invalid_cds_request` (400).
 * - createEvaluationUpload({ content, filename, submissionId, replaceStaged })
 *   stages an evaluation results file (format bmc-evaluation-results/1); an
 *   Upload of kind `evaluation_results` that never publishes itself.
 *   getEvaluationProposals({ uploadId }) resolves to `{ study, metrics: { model_version,
 *   use_case, records }, results, notes }`; stage the study, then the metrics
 *   records, with createRecordsUpload.
 */
export const DATA_CLIENT_OPERATIONS = Object.freeze({
  getMeta: 'getMeta',
  listModels: 'listModels',
  getNarrowModelCard: 'getNarrowModelCard',
  listDatasetVersions: 'listDatasetVersions',
  listSafetyIncidents: 'listSafetyIncidents',
  getCatalogue: 'getCatalogue',
  getAtlasOverview: 'getAtlasOverview',
  getChapter: 'getChapter',
  getMetricMap: 'getMetricMap',
  getMetricSummary: 'getMetricSummary',
  getConceptMetrics: 'getConceptMetrics',
  getConceptSubgroups: 'getConceptSubgroups',
  getSubgroupSummary: 'getSubgroupSummary',
  listStudies: 'listStudies',
  getStudy: 'getStudy',
  listEffects: 'listEffects',
  getComparison: 'getComparison',
  getMultimorbidityCandidates: 'getMultimorbidityCandidates',
  getMultimorbidityCombination: 'getMultimorbidityCombination',
  searchConcepts: 'searchConcepts',
  interpretQuery: 'interpretQuery',
  interpretQueryWithHelper: 'interpretQueryWithHelper',
  exportConcept: 'exportConcept',
  exportDataset: 'exportDataset',
  lookup: 'lookup',
  getCardRecord: 'getCardRecord',
  getCdsServices: 'getCdsServices',
  callCdsService: 'callCdsService',
  listDatasets: 'listDatasets',
  getTemplateUrl: 'downloadTemplate',
  createUpload: 'createUpload',
  createRecordsUpload: 'createRecordsUpload',
  getUpload: 'getUpload',
  discardUpload: 'discardUpload',
  getAnnotatedUploadUrl: 'downloadAnnotatedUpload',
  getUploadChanges: 'getUploadChanges',
  publishUpload: 'publishUpload',
  removePopulation: 'removePopulation',
  listIncidents: 'listIncidents',
  listVersions: 'listVersions',
  rollbackVersion: 'rollbackVersion',
  getAssistStatus: 'getAssistStatus',
  configureAssist: 'configureAssist',
  clearAssist: 'clearAssist',
  proposeRecords: 'proposeRecords',
  updateInstance: 'updateInstance',
  createSubmission: 'createSubmission',
  listSubmissions: 'listSubmissions',
  getSubmission: 'getSubmission',
  acceptSubmission: 'acceptSubmission',
  returnSubmission: 'returnSubmission',
  createModelCardUpload: 'createModelCardUpload',
  getModelCardProposals: 'getModelCardProposals',
  createEvaluationUpload: 'createEvaluationUpload',
  getEvaluationProposals: 'getEvaluationProposals',
  getReleaseExportUrl: 'exportPublicRelease',
  importPublicRelease: 'importPublicRelease',
  getReleaseImport: 'getReleaseImport',
  publishReleaseImport: 'publishReleaseImport',
  discardReleaseImport: 'discardReleaseImport'
});

export const DATA_CLIENT_METHODS = Object.freeze(Object.keys(DATA_CLIENT_OPERATIONS));

/** Error raised by adapters; mirrors the contract's problem details. */
export class DataClientError extends Error {
  /**
   * @param {{ status: number, code: string, title: string, detail?: string }} problem
   */
  constructor({ status, code, title, detail }) {
    super(detail ? `${title}: ${detail}` : title);
    this.name = 'DataClientError';
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = detail ?? null;
  }
}

/**
 * Wrap an adapter as the app's data client. Fails fast when the adapter does
 * not implement the full contract, so a missing operation surfaces at startup
 * rather than on first use.
 *
 * @template {Record<string, Function>} A
 * @param {A} adapter
 * @returns {Readonly<A>}
 */
export function createDataClient(adapter) {
  const missing = DATA_CLIENT_METHODS.filter((method) => typeof adapter?.[method] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(`Data client adapter is missing contract methods: ${missing.join(', ')}`);
  }
  const client = {};
  for (const method of DATA_CLIENT_METHODS) {
    client[method] = adapter[method].bind(adapter);
  }
  return Object.freeze(client);
}
