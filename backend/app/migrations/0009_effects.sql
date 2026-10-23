-- bmc: foreign-keys-off
--
-- Broad Modelcard canonical store, schema version 9 (contract v1.13, CONTRACT.md §27): intervention effects.
--
-- An effect record states what using an AI system changed for patients or for
-- care (an outcome, against a comparator), as measured by one study that
-- compared care with and without the system: the effect measure, estimate,
-- confidence interval, which direction is better, and the design-specific
-- risk-of-bias appraisal (RoB 2 for randomized trials, ROBINS-I otherwise).
-- The data set 'effects' is one global content set keyed by effect_id, like
-- 'safety' and 'studies'. An effect names its study (studies.study_id of the
-- version's studies set, checked at upload) and its card (model version and
-- function), and the conditions it concerns: ICD-11 codes stored with their
-- depth-1 anchor conditions, or one whole chapter, as safety incidents do.
-- Effects never enter a grade.
--
-- The kind CHECK constraints of dataset_versions, content_sets, and uploads
-- gain 'effects', and uploads may merge effects. SQLite cannot change a CHECK
-- constraint in place, so the three tables are rebuilt with the documented
-- procedure (create the new table, copy, drop the old one, rename the new one),
-- as in migrations 0004, 0005, and 0007. The first line asks the migration
-- runner (app/db.py) to turn foreign key enforcement off for this migration and
-- to run PRAGMA foreign_key_check before it commits; the rebuild keeps every
-- row and id.
--
-- Renumbered from 0010 to 0009 at the R5 merge (no store outside scratch
-- copies had applied it); R5's local results and roles follow as 0010, whose
-- rebuilds keep the kind 'effects'.
--
-- All data is synthetic demonstration data. Never store patient data here.

-- ------------------------------------------------- dataset_versions (rebuild)

CREATE TABLE dataset_versions_v9e (
  version_id   INTEGER PRIMARY KEY CHECK (version_id > 0),
  kind         TEXT CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population', 'studies', 'effects')),
  created_at   TEXT NOT NULL,
  summary      TEXT NOT NULL,
  upload_id    TEXT,
  rollback_of  INTEGER REFERENCES dataset_versions (version_id),
  previewed    INTEGER NOT NULL DEFAULT 0 CHECK (previewed IN (0, 1)),
  note         TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500)
);
INSERT INTO dataset_versions_v9e (version_id, kind, created_at, summary, upload_id, rollback_of, previewed, note)
  SELECT version_id, kind, created_at, summary, upload_id, rollback_of, previewed, note FROM dataset_versions;
DROP TABLE dataset_versions;
ALTER TABLE dataset_versions_v9e RENAME TO dataset_versions;

-- ----------------------------------------------------- content_sets (rebuild)

CREATE TABLE content_sets_v9e (
  set_id         INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population', 'studies', 'effects')),
  model_version  TEXT,
  use_case       TEXT,
  source         TEXT NOT NULL,
  source_sha256  TEXT,
  generated_at   TEXT,
  meta_json      TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  population_id  TEXT,
  CHECK ((kind IN ('metrics', 'multimorbidity')) = (model_version IS NOT NULL AND use_case IS NOT NULL)),
  CHECK ((kind = 'population') = (population_id IS NOT NULL))
);
INSERT INTO content_sets_v9e (set_id, kind, model_version, use_case, source, source_sha256, generated_at, meta_json, created_at, population_id)
  SELECT set_id, kind, model_version, use_case, source, source_sha256, generated_at, meta_json, created_at, population_id FROM content_sets;
DROP TABLE content_sets;
ALTER TABLE content_sets_v9e RENAME TO content_sets;

-- ---------------------------------------------------------- uploads (rebuild)

CREATE TABLE uploads_v9e (
  upload_id          TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population', 'studies', 'effects')),
  model_version      TEXT,
  use_case           TEXT,
  filename           TEXT NOT NULL,
  file_format        TEXT NOT NULL CHECK (file_format IN ('csv', 'xlsx')),
  status             TEXT NOT NULL CHECK (status IN ('checking', 'invalid', 'valid', 'published', 'discarded', 'superseded')),
  progress           REAL NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  created_at         TEXT NOT NULL,
  checked_at         TEXT,
  report_json        TEXT,
  set_id             INTEGER REFERENCES content_sets (set_id),
  previewed          INTEGER NOT NULL DEFAULT 0 CHECK (previewed IN (0, 1)),
  published_version  INTEGER REFERENCES dataset_versions (version_id),
  superseded_by      TEXT,
  mode               TEXT NOT NULL DEFAULT 'replace' CHECK (mode IN ('replace', 'merge')),
  origin             TEXT NOT NULL DEFAULT 'file' CHECK (origin IN ('file', 'records')),
  population_id      TEXT,
  population_name    TEXT,
  CHECK ((kind IN ('metrics', 'multimorbidity')) = (model_version IS NOT NULL AND use_case IS NOT NULL)),
  CHECK ((kind = 'population') = (population_id IS NOT NULL AND population_name IS NOT NULL)),
  CHECK (mode = 'replace' OR kind IN ('metrics', 'prevalence', 'safety', 'studies', 'effects'))
);
INSERT INTO uploads_v9e (
  upload_id, kind, model_version, use_case, filename, file_format, status, progress, created_at, checked_at,
  report_json, set_id, previewed, published_version, superseded_by, mode, origin, population_id, population_name
)
  SELECT upload_id, kind, model_version, use_case, filename, file_format, status, progress, created_at, checked_at,
         report_json, set_id, previewed, published_version, superseded_by, mode, origin, population_id, population_name
  FROM uploads;
DROP TABLE uploads;
ALTER TABLE uploads_v9e RENAME TO uploads;

CREATE UNIQUE INDEX uploads_one_staged_per_data_set
  ON uploads (kind, COALESCE(model_version, ''), COALESCE(use_case, ''), COALESCE(population_id, ''))
  WHERE status IN ('checking', 'invalid', 'valid');

CREATE INDEX uploads_created ON uploads (created_at);

-- ------------------------------------------------------------------ effects

CREATE TABLE effects (
  set_id             INTEGER NOT NULL REFERENCES content_sets (set_id),
  effect_id          TEXT NOT NULL,
  position           INTEGER NOT NULL,
  -- The study that measured the effect (a study_id of the studies set the
  -- upload was checked against; not a foreign key, as data sets change apart).
  study_id           TEXT NOT NULL,
  model_version      TEXT NOT NULL,
  use_case           TEXT NOT NULL,
  -- ICD-11 codes as given and their depth-1 anchor conditions, both JSON
  -- arrays in the same order; or one whole chapter and two empty arrays.
  codes_json         TEXT NOT NULL,
  condition_ids_json TEXT NOT NULL,
  chapter_id         TEXT,
  outcome            TEXT NOT NULL,
  outcome_type       TEXT NOT NULL CHECK (outcome_type IN ('benefit', 'harm', 'process')),
  population         TEXT NOT NULL,
  comparator         TEXT NOT NULL,
  effect_measure     TEXT NOT NULL CHECK (effect_measure IN (
                       'risk_ratio', 'odds_ratio', 'hazard_ratio', 'risk_difference', 'mean_difference',
                       'standardized_mean_difference')),
  estimate           REAL NOT NULL,
  ci_low             REAL NOT NULL,
  ci_high            REAL NOT NULL,
  unit               TEXT,
  direction          TEXT NOT NULL CHECK (direction IN ('higher_is_better', 'lower_is_better')),
  follow_up          TEXT,
  appraisal_tool     TEXT NOT NULL CHECK (appraisal_tool IN ('rob2', 'robins_i')),
  judgement          TEXT NOT NULL CHECK (judgement IN ('low', 'some_concerns', 'high', 'critical', 'unclear')),
  notes              TEXT,
  PRIMARY KEY (set_id, effect_id),
  UNIQUE (set_id, position),
  CHECK (ci_low <= estimate AND estimate <= ci_high),
  CHECK (effect_measure NOT IN ('risk_ratio', 'odds_ratio', 'hazard_ratio') OR ci_low > 0),
  CHECK (judgement <> 'critical' OR appraisal_tool = 'robins_i'),
  CHECK ((chapter_id IS NULL) <> (codes_json = '[]'))
) WITHOUT ROWID;
