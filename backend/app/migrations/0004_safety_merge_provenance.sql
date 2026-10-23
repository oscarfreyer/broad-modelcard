-- bmc: foreign-keys-off
--
-- Broad Modelcard canonical store, schema version 4 (contract v1.7): safety incidents, merge uploads, row
-- provenance, and change notes.
--
-- The kind CHECK constraints of dataset_versions, content_sets, and uploads
-- gain 'safety'. SQLite cannot change a CHECK constraint in place, so these
-- three tables are rebuilt with the documented procedure (create the new
-- table, copy, drop the old one, rename the new one). The first line asks the
-- migration runner (app/db.py) to turn foreign key enforcement off for this
-- migration and to run PRAGMA foreign_key_check before it commits; the
-- rebuild keeps every row and id, so every reference stays valid.
--
-- Additive otherwise: content sets stay immutable, and existing rows keep
-- their meaning.
--
-- * dataset_versions.note: the maintainer's change note (at most 500
--   characters), given on publish or rollback.
-- * uploads.mode ('replace' or 'merge') and uploads.origin ('file' or
--   'records', the JSON records upload).
-- * provenance_sources: interned (source, study, source date) triples.
--   set_provenance: each content set's default source; a set without one is
--   the seed's ("Seed (synthetic, version 1)", provenance_id 1).
--   metric_row_provenance, prevalence_provenance: per-row sources that differ
--   from their set's default (sparse side tables).
-- * safety_incidents, safety_incident_conditions: the safety data set, one
--   global content set of incidents keyed by incident_id. Each incident names
--   a configuration, a lens, and either ICD-11 codes (stored with their
--   depth-1 anchor conditions) or one chapter.
--
-- All data is synthetic demonstration data. Never store patient data here.

-- ------------------------------------------------- dataset_versions (rebuild)

CREATE TABLE dataset_versions_v4 (
  version_id   INTEGER PRIMARY KEY CHECK (version_id > 0),
  kind         TEXT CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence', 'safety')),
  created_at   TEXT NOT NULL,
  summary      TEXT NOT NULL,
  upload_id    TEXT,
  rollback_of  INTEGER REFERENCES dataset_versions (version_id),
  previewed    INTEGER NOT NULL DEFAULT 0 CHECK (previewed IN (0, 1)),
  note         TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500)
);
INSERT INTO dataset_versions_v4 (version_id, kind, created_at, summary, upload_id, rollback_of, previewed)
  SELECT version_id, kind, created_at, summary, upload_id, rollback_of, previewed FROM dataset_versions;
DROP TABLE dataset_versions;
ALTER TABLE dataset_versions_v4 RENAME TO dataset_versions;

-- ----------------------------------------------------- content_sets (rebuild)

CREATE TABLE content_sets_v4 (
  set_id         INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence', 'safety')),
  model_version  TEXT,
  use_case       TEXT,
  source         TEXT NOT NULL,
  source_sha256  TEXT,
  generated_at   TEXT,
  meta_json      TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  CHECK ((kind IN ('metrics', 'multimorbidity')) = (model_version IS NOT NULL AND use_case IS NOT NULL))
);
INSERT INTO content_sets_v4 (set_id, kind, model_version, use_case, source, source_sha256, generated_at, meta_json, created_at)
  SELECT set_id, kind, model_version, use_case, source, source_sha256, generated_at, meta_json, created_at FROM content_sets;
DROP TABLE content_sets;
ALTER TABLE content_sets_v4 RENAME TO content_sets;

-- ---------------------------------------------------------- uploads (rebuild)

CREATE TABLE uploads_v4 (
  upload_id          TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence', 'safety')),
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
  CHECK ((kind IN ('metrics', 'multimorbidity')) = (model_version IS NOT NULL AND use_case IS NOT NULL)),
  CHECK (mode = 'replace' OR kind IN ('metrics', 'prevalence', 'safety'))
);
INSERT INTO uploads_v4 (
  upload_id, kind, model_version, use_case, filename, file_format, status, progress, created_at, checked_at,
  report_json, set_id, previewed, published_version, superseded_by
)
  SELECT upload_id, kind, model_version, use_case, filename, file_format, status, progress, created_at, checked_at,
         report_json, set_id, previewed, published_version, superseded_by
  FROM uploads;
DROP TABLE uploads;
ALTER TABLE uploads_v4 RENAME TO uploads;

CREATE UNIQUE INDEX uploads_one_staged_per_data_set
  ON uploads (kind, COALESCE(model_version, ''), COALESCE(use_case, ''))
  WHERE status IN ('checking', 'invalid', 'valid');

CREATE INDEX uploads_created ON uploads (created_at);

-- --------------------------------------------------------------- provenance

CREATE TABLE provenance_sources (
  provenance_id  INTEGER PRIMARY KEY,
  source         TEXT NOT NULL,
  study          TEXT,
  -- ISO date YYYY-MM-DD of the study or report.
  source_date    TEXT
);

-- provenance_id 1 is the seed's source; sets without a default use it.
INSERT INTO provenance_sources (provenance_id, source, study, source_date)
  VALUES (1, 'Seed (synthetic, version 1)', NULL, NULL);

CREATE TABLE set_provenance (
  set_id         INTEGER PRIMARY KEY REFERENCES content_sets (set_id),
  provenance_id  INTEGER NOT NULL REFERENCES provenance_sources (provenance_id)
);

-- Sets that came from an upload before schema version 4 read as that upload.
INSERT INTO provenance_sources (source, study, source_date)
  SELECT DISTINCT 'Upload ' || u.filename, NULL, substr(cs.created_at, 1, 10)
  FROM content_sets cs JOIN uploads u ON cs.source = 'upload:' || u.upload_id
  WHERE cs.kind IN ('metrics', 'prevalence');
INSERT INTO set_provenance (set_id, provenance_id)
  SELECT cs.set_id, (
    SELECT MIN(p.provenance_id) FROM provenance_sources p
    WHERE p.source = 'Upload ' || u.filename AND p.study IS NULL AND p.source_date = substr(cs.created_at, 1, 10)
  )
  FROM content_sets cs JOIN uploads u ON cs.source = 'upload:' || u.upload_id
  WHERE cs.kind IN ('metrics', 'prevalence');

CREATE TABLE metric_row_provenance (
  set_id         INTEGER NOT NULL,
  combo_idx      INTEGER NOT NULL,
  concept_id     TEXT NOT NULL,
  provenance_id  INTEGER NOT NULL REFERENCES provenance_sources (provenance_id),
  PRIMARY KEY (set_id, combo_idx, concept_id),
  FOREIGN KEY (set_id, combo_idx, concept_id) REFERENCES metric_rows (set_id, combo_idx, concept_id)
) WITHOUT ROWID;

CREATE TABLE prevalence_provenance (
  set_id         INTEGER NOT NULL,
  code           TEXT NOT NULL,
  provenance_id  INTEGER NOT NULL REFERENCES provenance_sources (provenance_id),
  PRIMARY KEY (set_id, code),
  FOREIGN KEY (set_id, code) REFERENCES prevalence_tiers (set_id, code)
) WITHOUT ROWID;

-- ------------------------------------------------------------------- safety

CREATE TABLE safety_incidents (
  set_id            INTEGER NOT NULL REFERENCES content_sets (set_id),
  incident_id       TEXT NOT NULL,
  position          INTEGER NOT NULL,
  model_version     TEXT NOT NULL,
  use_case          TEXT NOT NULL,
  -- The chapter an incident covers as a whole; NULL when it names codes.
  chapter_id        TEXT REFERENCES concepts (concept_id),
  age_lens          TEXT NOT NULL,
  sex_lens          TEXT NOT NULL,
  ethnicity_lens    TEXT NOT NULL,
  incident_type     TEXT NOT NULL CHECK (incident_type IN (
                      'harmful_recommendation', 'fabricated_content', 'subgroup_bias', 'performance_drift',
                      'developer_notice_or_recall', 'other')),
  harm              TEXT NOT NULL CHECK (harm IN ('occurred', 'possible', 'none')),
  status            TEXT NOT NULL CHECK (status IN ('open', 'mitigated', 'closed')),
  source_type       TEXT NOT NULL CHECK (source_type IN ('study', 'incident_report', 'developer_notice')),
  source_reference  TEXT NOT NULL,
  study_id          TEXT,
  reported_date     TEXT NOT NULL,
  updated_date      TEXT,
  summary           TEXT NOT NULL,
  PRIMARY KEY (set_id, incident_id),
  UNIQUE (set_id, position)
) WITHOUT ROWID;

-- The ICD-11 codes of an incident as given, with the depth-1 condition each
-- maps to (its metric anchor), in the given order.
CREATE TABLE safety_incident_conditions (
  set_id        INTEGER NOT NULL,
  incident_id   TEXT NOT NULL,
  member_index  INTEGER NOT NULL,
  code          TEXT NOT NULL,
  concept_id    TEXT NOT NULL REFERENCES concepts (concept_id),
  PRIMARY KEY (set_id, incident_id, member_index),
  FOREIGN KEY (set_id, incident_id) REFERENCES safety_incidents (set_id, incident_id)
) WITHOUT ROWID;
