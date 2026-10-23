-- bmc: foreign-keys-off
--
-- Broad Modelcard canonical store, schema version 10 (contract v1.13, CONTRACT.md §26): local evaluation results, the
-- instance profile, role workspaces with developer submissions, and nested
-- narrow model cards.
--
-- * Local results: a data set kind 'local_metrics', one content set per card
--   (model_version, use_case) and local population (population_id). Its rows
--   are stored like a metrics set's (metric_rows, set_combos, the provenance
--   tables), keyed by the set id. A read that names the population serves a
--   local row in place of the public row of the same condition and lens.
-- * Narrow model cards: a data set kind 'model_cards', one global content set
--   with at most one card per AI system (model_cards, keyed by set id and
--   model version). Uploaded as JSON or Markdown (uploads.file_format).
-- * Studies gain scope ('public' or 'hospital') and, for a hospital
--   evaluation, the local population it evaluated. Safety incidents gain
--   scope. Existing rows are public.
-- * Versions record who published them, as a choice without login: the
--   workspace's role and an entered name.
-- * Submissions group a developer's staged uploads; they never publish on
--   their own. Uploads in a submission are exempt from the one staged upload
--   per data set rule (the submission holds at most one per data set).
-- * The instance profile (one row): public service or hospital version, the
--   organisation, and who maintains it.
-- * Public release imports: a hospital instance's checked import of a public
--   release bundle, waiting for its publish.
--
-- The kind CHECK constraints of dataset_versions, content_sets, and uploads
-- change, so the three tables are rebuilt with the documented procedure
-- (create the new table, copy, drop the old one, rename the new one), as in
-- migrations 0004, 0005, 0007, and 0009 (its kind 'effects' is kept). The first line asks the migration runner
-- (app/db.py) to turn foreign key enforcement off for this migration and to run
-- PRAGMA foreign_key_check before it commits; the rebuild keeps every row and id.
--
-- All data is synthetic demonstration data. Never store patient data here.

-- ------------------------------------------------- dataset_versions (rebuild)

CREATE TABLE dataset_versions_v9 (
  version_id      INTEGER PRIMARY KEY CHECK (version_id > 0),
  kind            TEXT CHECK (kind IN (
                    'models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population', 'studies', 'effects',
                    'local_metrics', 'model_cards')),
  created_at      TEXT NOT NULL,
  summary         TEXT NOT NULL,
  upload_id       TEXT,
  rollback_of     INTEGER REFERENCES dataset_versions (version_id),
  previewed       INTEGER NOT NULL DEFAULT 0 CHECK (previewed IN (0, 1)),
  note            TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  -- Who published, as chosen in the Data Library (no login): the workspace's
  -- role and an entered name. NULL for versions from before schema 9.
  publisher_role  TEXT CHECK (publisher_role IN ('developer', 'custodian', 'hospital', 'maintainer')),
  publisher_name  TEXT CHECK (publisher_name IS NULL OR length(publisher_name) BETWEEN 1 AND 80)
);
INSERT INTO dataset_versions_v9 (version_id, kind, created_at, summary, upload_id, rollback_of, previewed, note)
  SELECT version_id, kind, created_at, summary, upload_id, rollback_of, previewed, note FROM dataset_versions;
DROP TABLE dataset_versions;
ALTER TABLE dataset_versions_v9 RENAME TO dataset_versions;

-- ----------------------------------------------------- content_sets (rebuild)

CREATE TABLE content_sets_v9 (
  set_id         INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN (
                   'models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population', 'studies', 'effects',
                   'local_metrics', 'model_cards')),
  model_version  TEXT,
  use_case       TEXT,
  source         TEXT NOT NULL,
  source_sha256  TEXT,
  generated_at   TEXT,
  meta_json      TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  population_id  TEXT,
  CHECK ((kind IN ('metrics', 'multimorbidity', 'local_metrics')) = (model_version IS NOT NULL AND use_case IS NOT NULL)),
  CHECK ((kind IN ('population', 'local_metrics')) = (population_id IS NOT NULL))
);
INSERT INTO content_sets_v9 (set_id, kind, model_version, use_case, source, source_sha256, generated_at, meta_json, created_at, population_id)
  SELECT set_id, kind, model_version, use_case, source, source_sha256, generated_at, meta_json, created_at, population_id FROM content_sets;
DROP TABLE content_sets;
ALTER TABLE content_sets_v9 RENAME TO content_sets;

-- -------------------------------------------------------------- submissions

CREATE TABLE submissions (
  submission_id    TEXT PRIMARY KEY,
  developer_name   TEXT NOT NULL CHECK (length(developer_name) BETWEEN 1 AND 80),
  model_version    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('submitted', 'returned', 'accepted')),
  -- The developer's note to the custodian.
  note             TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  -- The custodian's decision: the note, who decided, when, and the versions an acceptance published.
  custodian_note   TEXT CHECK (custodian_note IS NULL OR length(custodian_note) BETWEEN 1 AND 500),
  decided_by       TEXT,
  decided_at       TEXT,
  versions_json    TEXT NOT NULL DEFAULT '[]'
);

-- ---------------------------------------------------------- uploads (rebuild)

CREATE TABLE uploads_v9 (
  upload_id          TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN (
                       'models', 'metrics', 'multimorbidity', 'prevalence', 'safety', 'population', 'studies', 'effects',
                       'local_metrics', 'model_cards')),
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
  CHECK ((kind IN ('metrics', 'multimorbidity', 'local_metrics')) = (model_version IS NOT NULL AND use_case IS NOT NULL)),
  CHECK ((kind = 'population') = (population_id IS NOT NULL AND population_name IS NOT NULL)),
  CHECK (kind <> 'local_metrics' OR population_id IS NOT NULL),
  CHECK (kind <> 'model_cards' OR model_version IS NOT NULL),
  CHECK ((file_format IN ('json', 'md')) = (kind = 'model_cards')),
  CHECK (mode = 'replace' OR kind IN ('metrics', 'prevalence', 'safety', 'studies', 'effects', 'local_metrics', 'models', 'model_cards'))
);
INSERT INTO uploads_v9 (
  upload_id, kind, model_version, use_case, filename, file_format, status, progress, created_at, checked_at,
  report_json, set_id, previewed, published_version, superseded_by, mode, origin, population_id, population_name
)
  SELECT upload_id, kind, model_version, use_case, filename, file_format, status, progress, created_at, checked_at,
         report_json, set_id, previewed, published_version, superseded_by, mode, origin, population_id, population_name
  FROM uploads;
DROP TABLE uploads;
ALTER TABLE uploads_v9 RENAME TO uploads;

-- One staged upload per data set (and card, population, or AI system),
-- outside submissions; a submission holds at most one per data set too.
CREATE UNIQUE INDEX uploads_one_staged_per_data_set
  ON uploads (kind, COALESCE(model_version, ''), COALESCE(use_case, ''), COALESCE(population_id, ''))
  WHERE status IN ('checking', 'invalid', 'valid') AND submission_id IS NULL;

CREATE UNIQUE INDEX uploads_one_staged_per_submission_data_set
  ON uploads (submission_id, kind, COALESCE(model_version, ''), COALESCE(use_case, ''), COALESCE(population_id, ''))
  WHERE status IN ('checking', 'invalid', 'valid') AND submission_id IS NOT NULL;

CREATE INDEX uploads_created ON uploads (created_at);
CREATE INDEX uploads_submission ON uploads (submission_id);

-- ------------------------------------------------------- studies, incidents

ALTER TABLE studies ADD COLUMN scope TEXT NOT NULL DEFAULT 'public' CHECK (scope IN ('public', 'hospital'));
-- The local population a hospital evaluation evaluated (§21 id); NULL for a public study.
ALTER TABLE studies ADD COLUMN population_id TEXT;

ALTER TABLE safety_incidents ADD COLUMN scope TEXT NOT NULL DEFAULT 'public' CHECK (scope IN ('public', 'hospital'));

-- ---------------------------------------------------------- narrow model cards

CREATE TABLE model_cards (
  set_id          INTEGER NOT NULL REFERENCES content_sets (set_id),
  model_version   TEXT NOT NULL,
  position        INTEGER NOT NULL,
  -- How it was submitted: the prototype's JSON, or Markdown (kept as text).
  source_format   TEXT NOT NULL CHECK (source_format IN ('json', 'markdown')),
  -- The parsed card (openapi.json NarrowModelCard fields), as JSON.
  card_json       TEXT NOT NULL,
  -- The Markdown text as submitted (NULL for JSON).
  markdown        TEXT,
  submitted_at    TEXT NOT NULL,
  PRIMARY KEY (set_id, model_version),
  UNIQUE (set_id, position)
) WITHOUT ROWID;

-- -------------------------------------------------------------- the instance

CREATE TABLE instance_profile (
  profile_id     INTEGER PRIMARY KEY CHECK (profile_id = 1),
  kind           TEXT NOT NULL CHECK (kind IN ('public', 'hospital')),
  organisation   TEXT NOT NULL CHECK (length(organisation) BETWEEN 1 AND 120),
  maintained_by  TEXT NOT NULL CHECK (length(maintained_by) BETWEEN 1 AND 120),
  contact        TEXT CHECK (contact IS NULL OR length(contact) BETWEEN 1 AND 200),
  updated_at     TEXT NOT NULL
);
INSERT INTO instance_profile (profile_id, kind, organisation, maintained_by, contact, updated_at)
  VALUES (1, 'public', 'Broad Modelcard (demonstration)', 'the Broad Modelcard project', NULL, '2026-10-20T00:00:00Z');

-- ---------------------------------------------------- public release imports

CREATE TABLE release_imports (
  import_id          TEXT PRIMARY KEY,
  filename           TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('invalid', 'valid', 'published', 'discarded')),
  -- The check's problems, the release it holds, and what publishing would change (JSON).
  report_json        TEXT NOT NULL,
  published_version  INTEGER REFERENCES dataset_versions (version_id)
);
