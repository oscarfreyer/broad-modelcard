-- Broad Modelcard canonical store, schema version 2: staged uploads (Track A3).
--
-- An upload is a CSV/XLSX file for one data set kind (and, for metrics and
-- multimorbidity, one model and use case). Checking it produces a report; a
-- valid upload is written as a content set that no version lists yet (the
-- staged set). Publishing adds a dataset version that lists it. Only one
-- upload per data set can be staged (checking, invalid, or valid) at a time.
--
-- All data is synthetic demonstration data. Never upload patient data.

CREATE TABLE uploads (
  -- [A-Za-z0-9_-]{1,64} (openapi.json UploadIdPath).
  upload_id          TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence')),
  -- Target of metrics and multimorbidity uploads; NULL for the other kinds.
  model_version      TEXT,
  use_case           TEXT,
  filename           TEXT NOT NULL,
  file_format        TEXT NOT NULL CHECK (file_format IN ('csv', 'xlsx')),
  status             TEXT NOT NULL CHECK (status IN ('checking', 'invalid', 'valid', 'published', 'discarded', 'superseded')),
  progress           REAL NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  created_at         TEXT NOT NULL,
  checked_at         TEXT,
  -- ValidationReport (openapi.json) once the check has finished.
  report_json        TEXT,
  -- The staged content set of a valid upload.
  set_id             INTEGER REFERENCES content_sets (set_id),
  -- Set by the first staged read (version=staged:<upload_id>).
  previewed          INTEGER NOT NULL DEFAULT 0 CHECK (previewed IN (0, 1)),
  published_version  INTEGER REFERENCES dataset_versions (version_id),
  superseded_by      TEXT,
  CHECK ((kind IN ('metrics', 'multimorbidity')) = (model_version IS NOT NULL AND use_case IS NOT NULL))
);

CREATE UNIQUE INDEX uploads_one_staged_per_data_set
  ON uploads (kind, COALESCE(model_version, ''), COALESCE(use_case, ''))
  WHERE status IN ('checking', 'invalid', 'valid');

CREATE INDEX uploads_created ON uploads (created_at);
