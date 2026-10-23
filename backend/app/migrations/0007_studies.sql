-- bmc: foreign-keys-off
--
-- Broad Modelcard canonical store, schema version 7 (contract v1.13, CONTRACT.md §22): studies and their appraisal.
--
-- A study record describes one study behind metric rows: design, setting,
-- sites, patients, peer review, who conducted it, the reporting guideline and
-- whether it was followed, the risk of bias (an overall judgement with optional
-- domain notes), population, evaluation conditions, the model version
-- evaluated, publication date, and an optional source link. The data set
-- 'studies' is one global content set keyed by study_id, like 'safety'. A
-- stored metric row links to a study when its row source's study
-- (provenance_sources.study) equals a study_id of the live set; nothing is
-- stored for the link itself.
--
-- The kind CHECK constraints of dataset_versions, content_sets, and uploads
-- gain 'studies', and uploads may merge studies. SQLite cannot change a CHECK
-- constraint in place, so the three tables are rebuilt with the documented
-- procedure (create the new table, copy, drop the old one, rename the new one),
-- as in migrations 0004 and 0005. The first line asks the migration runner
-- (app/db.py) to turn foreign key enforcement off for this migration and to run
-- PRAGMA foreign_key_check before it commits; the rebuild keeps every row and id.
--
-- Room to grow: later phases add optional effect records of a study (their own
-- table keyed by set_id and study_id) and a study scope or population (new
-- nullable columns); neither is part of this migration.
--
-- All data is synthetic demonstration data. Never store patient data here.

-- ------------------------------------------------- dataset_versions (rebuild)

CREATE TABLE dataset_versions_v7 (
  version_id   INTEGER PRIMARY KEY CHECK (version_id > 0),
  kind         TEXT CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population', 'studies')),
  created_at   TEXT NOT NULL,
  summary      TEXT NOT NULL,
  upload_id    TEXT,
  rollback_of  INTEGER REFERENCES dataset_versions (version_id),
  previewed    INTEGER NOT NULL DEFAULT 0 CHECK (previewed IN (0, 1)),
  note         TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500)
);
INSERT INTO dataset_versions_v7 (version_id, kind, created_at, summary, upload_id, rollback_of, previewed, note)
  SELECT version_id, kind, created_at, summary, upload_id, rollback_of, previewed, note FROM dataset_versions;
DROP TABLE dataset_versions;
ALTER TABLE dataset_versions_v7 RENAME TO dataset_versions;

-- ----------------------------------------------------- content_sets (rebuild)

CREATE TABLE content_sets_v7 (
  set_id         INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population', 'studies')),
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
INSERT INTO content_sets_v7 (set_id, kind, model_version, use_case, source, source_sha256, generated_at, meta_json, created_at, population_id)
  SELECT set_id, kind, model_version, use_case, source, source_sha256, generated_at, meta_json, created_at, population_id FROM content_sets;
DROP TABLE content_sets;
ALTER TABLE content_sets_v7 RENAME TO content_sets;

-- ---------------------------------------------------------- uploads (rebuild)

CREATE TABLE uploads_v7 (
  upload_id          TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population', 'studies')),
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
  CHECK (mode = 'replace' OR kind IN ('metrics', 'prevalence', 'safety', 'studies'))
);
INSERT INTO uploads_v7 (
  upload_id, kind, model_version, use_case, filename, file_format, status, progress, created_at, checked_at,
  report_json, set_id, previewed, published_version, superseded_by, mode, origin, population_id, population_name
)
  SELECT upload_id, kind, model_version, use_case, filename, file_format, status, progress, created_at, checked_at,
         report_json, set_id, previewed, published_version, superseded_by, mode, origin, population_id, population_name
  FROM uploads;
DROP TABLE uploads;
ALTER TABLE uploads_v7 RENAME TO uploads;

CREATE UNIQUE INDEX uploads_one_staged_per_data_set
  ON uploads (kind, COALESCE(model_version, ''), COALESCE(use_case, ''), COALESCE(population_id, ''))
  WHERE status IN ('checking', 'invalid', 'valid');

CREATE INDEX uploads_created ON uploads (created_at);

-- ------------------------------------------------------------------ studies

CREATE TABLE studies (
  set_id                 INTEGER NOT NULL REFERENCES content_sets (set_id),
  study_id               TEXT NOT NULL,
  position               INTEGER NOT NULL,
  title                  TEXT NOT NULL,
  design                 TEXT NOT NULL CHECK (design IN (
                           'vignette', 'simulation', 'benchmark', 'retrospective', 'prospective',
                           'real_world_deployment', 'randomized_trial')),
  setting                TEXT NOT NULL,
  sites                  INTEGER NOT NULL CHECK (sites >= 1),
  patients               INTEGER NOT NULL CHECK (patients >= 0),
  peer_reviewed          INTEGER NOT NULL CHECK (peer_reviewed IN (0, 1)),
  conducted_by           TEXT NOT NULL CHECK (conducted_by IN ('developer', 'independent', 'hospital')),
  reporting_guideline    TEXT NOT NULL CHECK (reporting_guideline IN (
                           'none', 'tripod_ai', 'stard_ai', 'consort_ai', 'decide_ai', 'other')),
  -- NULL exactly when the reporting guideline is 'none'.
  guideline_followed     TEXT CHECK (guideline_followed IN ('yes', 'partly', 'no')),
  risk_of_bias           TEXT NOT NULL CHECK (risk_of_bias IN ('low', 'some_concerns', 'high', 'unclear')),
  risk_of_bias_notes     TEXT,
  population             TEXT NOT NULL,
  evaluation_conditions  TEXT NOT NULL,
  model_version          TEXT,
  publication_date       TEXT NOT NULL,
  source_url             TEXT,
  PRIMARY KEY (set_id, study_id),
  UNIQUE (set_id, position),
  CHECK ((reporting_guideline = 'none') = (guideline_followed IS NULL))
) WITHOUT ROWID;
