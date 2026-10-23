-- bmc: foreign-keys-off
--
-- Broad Modelcard canonical store, schema version 5 (contract v1.10): local populations.
--
-- A local population is a named local prevalence set: commonness tiers for some
-- ICD-11 codes, which replace the default tiers for the reads that name the
-- population (an overlay; codes the population does not list keep the default
-- tier). A dataset version lists at most one content set per population id, as
-- it lists one metrics set per card. Aggregate data only.
--
-- The kind CHECK constraints of dataset_versions, content_sets, and uploads
-- gain 'population'. SQLite cannot change a CHECK constraint in place, so the
-- three tables are rebuilt with the documented procedure (create the new
-- table, copy, drop the old one, rename the new one), as in migration 0004.
-- The first line asks the migration runner (app/db.py) to turn foreign key
-- enforcement off for this migration and to run PRAGMA foreign_key_check
-- before it commits; the rebuild keeps every row and id.
--
-- Additive otherwise:
-- * content_sets.population_id: the population a 'population' set belongs to
--   (NULL for every other kind).
-- * population_sets: the display name of each population set. Its tiers are
--   stored like a prevalence set's (prevalence_sets, prevalence_tiers,
--   prevalence_provenance), keyed by the set id.
-- * uploads.population_id, uploads.population_name: the target of a
--   population upload. One upload per population can be staged.
--
-- All data is synthetic demonstration data. Never store patient data here.

-- ------------------------------------------------- dataset_versions (rebuild)

CREATE TABLE dataset_versions_v5 (
  version_id   INTEGER PRIMARY KEY CHECK (version_id > 0),
  kind         TEXT CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population')),
  created_at   TEXT NOT NULL,
  summary      TEXT NOT NULL,
  upload_id    TEXT,
  rollback_of  INTEGER REFERENCES dataset_versions (version_id),
  previewed    INTEGER NOT NULL DEFAULT 0 CHECK (previewed IN (0, 1)),
  note         TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500)
);
INSERT INTO dataset_versions_v5 (version_id, kind, created_at, summary, upload_id, rollback_of, previewed, note)
  SELECT version_id, kind, created_at, summary, upload_id, rollback_of, previewed, note FROM dataset_versions;
DROP TABLE dataset_versions;
ALTER TABLE dataset_versions_v5 RENAME TO dataset_versions;

-- ----------------------------------------------------- content_sets (rebuild)

CREATE TABLE content_sets_v5 (
  set_id         INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population')),
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
INSERT INTO content_sets_v5 (set_id, kind, model_version, use_case, source, source_sha256, generated_at, meta_json, created_at)
  SELECT set_id, kind, model_version, use_case, source, source_sha256, generated_at, meta_json, created_at FROM content_sets;
DROP TABLE content_sets;
ALTER TABLE content_sets_v5 RENAME TO content_sets;

-- ---------------------------------------------------------- uploads (rebuild)

CREATE TABLE uploads_v5 (
  upload_id          TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population')),
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
  CHECK (mode = 'replace' OR kind IN ('metrics', 'prevalence', 'safety'))
);
INSERT INTO uploads_v5 (
  upload_id, kind, model_version, use_case, filename, file_format, status, progress, created_at, checked_at,
  report_json, set_id, previewed, published_version, superseded_by, mode, origin
)
  SELECT upload_id, kind, model_version, use_case, filename, file_format, status, progress, created_at, checked_at,
         report_json, set_id, previewed, published_version, superseded_by, mode, origin
  FROM uploads;
DROP TABLE uploads;
ALTER TABLE uploads_v5 RENAME TO uploads;

CREATE UNIQUE INDEX uploads_one_staged_per_data_set
  ON uploads (kind, COALESCE(model_version, ''), COALESCE(use_case, ''), COALESCE(population_id, ''))
  WHERE status IN ('checking', 'invalid', 'valid');

CREATE INDEX uploads_created ON uploads (created_at);

-- -------------------------------------------------------------- populations

CREATE TABLE population_sets (
  set_id  INTEGER PRIMARY KEY REFERENCES content_sets (set_id),
  name    TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80)
);
