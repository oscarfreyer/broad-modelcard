-- bmc: foreign-keys-off
--
-- Broad Modelcard canonical store, schema version 15 (contract v1.14, CONTRACT.md §32.2): evaluation results uploads.
--
-- An evaluation results upload is the output of a benchmark or evaluation
-- harness run outside the product, as one JSON file (format
-- bmc-evaluation-results/1) for one card. It is checked in the background
-- like a narrow model card, but it is not a data set: it never gets a content
-- set and never publishes. A valid one offers proposed records (a benchmark
-- study record and one metrics merge record per result) that a maintainer or
-- custodian stages as ordinary records uploads.
--
-- The uploads table gains the kind 'evaluation_results' (its target is the
-- card the file names; NULL while the file names none, for example when it
-- cannot be read) and JSON file format for it. The kind and file-format
-- CHECK constraints change, so the table is rebuilt with the documented
-- procedure (create the new table, copy, drop the old one, rename the new
-- one), as in migrations 0004, 0005, 0007, 0009, and 0010. The first line asks
-- the migration runner (app/db.py) to turn foreign key enforcement off for this
-- migration and to run PRAGMA foreign_key_check before it commits; the rebuild
-- keeps every row and id. No other table changes.
--
-- All data is synthetic demonstration data. Never store patient data here.

CREATE TABLE uploads_v15 (
  upload_id          TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN (
                       'models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population', 'studies', 'effects',
                       'local_metrics', 'model_cards', 'evaluation_results')),
  model_version      TEXT,
  use_case           TEXT,
  filename           TEXT NOT NULL,
  file_format        TEXT NOT NULL CHECK (file_format IN ('csv', 'xlsx', 'json', 'md')),
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
  submission_id      TEXT REFERENCES submissions (submission_id),
  CHECK (kind = 'evaluation_results'
         OR (kind IN ('metrics', 'multimorbidity', 'local_metrics')) = (model_version IS NOT NULL AND use_case IS NOT NULL)),
  CHECK ((kind = 'population') = (population_id IS NOT NULL AND population_name IS NOT NULL)),
  CHECK (kind <> 'local_metrics' OR population_id IS NOT NULL),
  CHECK (kind <> 'model_cards' OR model_version IS NOT NULL),
  CHECK ((file_format IN ('json', 'md')) = (kind IN ('model_cards', 'evaluation_results'))),
  CHECK (kind <> 'evaluation_results' OR (file_format = 'json' AND set_id IS NULL AND mode = 'replace')),
  CHECK (mode = 'replace' OR kind IN ('metrics', 'prevalence', 'safety', 'studies', 'effects', 'local_metrics', 'models', 'model_cards'))
);
INSERT INTO uploads_v15 (
  upload_id, kind, model_version, use_case, filename, file_format, status, progress, created_at, checked_at,
  report_json, set_id, previewed, published_version, superseded_by, mode, origin, population_id, population_name, submission_id
)
  SELECT upload_id, kind, model_version, use_case, filename, file_format, status, progress, created_at, checked_at,
         report_json, set_id, previewed, published_version, superseded_by, mode, origin, population_id, population_name, submission_id
  FROM uploads;
DROP TABLE uploads;
ALTER TABLE uploads_v15 RENAME TO uploads;

-- The indexes of migration 0010, unchanged: one staged upload per data set
-- (and card, population, or AI system) outside submissions, and one per data
-- set in a submission. An evaluation results upload counts per card.
CREATE UNIQUE INDEX uploads_one_staged_per_data_set
  ON uploads (kind, COALESCE(model_version, ''), COALESCE(use_case, ''), COALESCE(population_id, ''))
  WHERE status IN ('checking', 'invalid', 'valid') AND submission_id IS NULL;

CREATE UNIQUE INDEX uploads_one_staged_per_submission_data_set
  ON uploads (submission_id, kind, COALESCE(model_version, ''), COALESCE(use_case, ''), COALESCE(population_id, ''))
  WHERE status IN ('checking', 'invalid', 'valid') AND submission_id IS NOT NULL;

CREATE INDEX uploads_created ON uploads (created_at);
CREATE INDEX uploads_submission ON uploads (submission_id);
