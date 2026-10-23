-- Broad Modelcard canonical store, schema version 1.
--
-- Layout:
--   * Atlas structure (concepts, axes, lens combinations) is static reference
--     data imported once from atlas-base.json.
--   * Updatable data lives in immutable *content sets*: one model registry, one
--     prevalence table, one metrics table per model/use case, and one optional
--     multimorbidity table per model/use case.
--   * A dataset version is a list of content sets (version_content_sets). The
--     live version is the highest version_id. Publishing or rolling back adds a
--     version that points at new or earlier sets; nothing is overwritten.
--
-- All data is synthetic demonstration data. Never store patient data here.

-- ---------------------------------------------------------------- versions

CREATE TABLE dataset_versions (
  version_id   INTEGER PRIMARY KEY CHECK (version_id > 0),
  -- Data set kind changed by this version; NULL for the initial import, which
  -- covers every kind.
  kind         TEXT CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence')),
  created_at   TEXT NOT NULL,
  summary      TEXT NOT NULL,
  upload_id    TEXT,
  rollback_of  INTEGER REFERENCES dataset_versions (version_id),
  previewed    INTEGER NOT NULL DEFAULT 0 CHECK (previewed IN (0, 1))
);

CREATE TABLE content_sets (
  set_id         INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('models', 'metrics', 'multimorbidity', 'prevalence')),
  model_version  TEXT,
  use_case       TEXT,
  -- Where the content came from: 'legacy_json:<path>' or 'upload:<upload_id>'.
  source         TEXT NOT NULL,
  source_sha256  TEXT,
  generated_at   TEXT,
  -- Remaining source header fields, kept for traceability (JSON object).
  meta_json      TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  CHECK ((kind IN ('metrics', 'multimorbidity')) = (model_version IS NOT NULL AND use_case IS NOT NULL))
);

CREATE TABLE version_content_sets (
  version_id  INTEGER NOT NULL REFERENCES dataset_versions (version_id),
  set_id      INTEGER NOT NULL REFERENCES content_sets (set_id),
  PRIMARY KEY (version_id, set_id)
) WITHOUT ROWID;

-- Source files of the one-time legacy JSON import, used to make the import
-- idempotent.
CREATE TABLE legacy_import_sources (
  path        TEXT PRIMARY KEY,
  sha256      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL
) WITHOUT ROWID;

-- ------------------------------------------------------------------- atlas

CREATE TABLE atlas_meta (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE concepts (
  -- Position in atlas-base.json. Derivations iterate concepts in this order.
  concept_key       INTEGER PRIMARY KEY,
  concept_id        TEXT NOT NULL UNIQUE,
  parent_id         TEXT REFERENCES concepts (concept_id),
  level             INTEGER NOT NULL CHECK (level IN (0, 1, 2)),
  chapter_id        TEXT NOT NULL,
  chapter           TEXT,
  specialty         TEXT,
  chapter_no        TEXT,
  "group"           TEXT,
  subgroup          TEXT,
  block_id          TEXT,
  fsn               TEXT,
  pt                TEXT NOT NULL,
  -- Source value; level-2 concepts are re-scored from the prevalence tier.
  prevalence_score  REAL,
  icd11_code        TEXT,
  semantic_tag      TEXT,
  sort_order        INTEGER,
  depth_in_kind     INTEGER,
  is_high_depth     INTEGER CHECK (is_high_depth IN (0, 1)),
  metric_anchor_id  TEXT,
  -- Position in top_level_condition_ids, NULL when not a top-level condition.
  top_level_position INTEGER UNIQUE
);

CREATE INDEX concepts_parent ON concepts (parent_id);
CREATE INDEX concepts_chapter ON concepts (chapter_id, level);

-- Metric axes from atlas-base.json, in source order.
CREATE TABLE axis_values (
  axis      TEXT NOT NULL CHECK (axis IN ('task_mode', 'context', 'age_lens', 'sex_lens', 'ethnicity_lens', 'model_version')),
  position  INTEGER NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (axis, position),
  UNIQUE (axis, value)
) WITHOUT ROWID;

-- Every demographic lens combination. combo_idx = age_idx*18 + sex_idx*6 +
-- eth_idx with the axes in source order (CONTRACT.md §4.1).
CREATE TABLE lens_combos (
  combo_idx       INTEGER PRIMARY KEY,
  context         TEXT NOT NULL,
  age_lens        TEXT NOT NULL,
  sex_lens        TEXT NOT NULL,
  ethnicity_lens  TEXT NOT NULL,
  UNIQUE (context, age_lens, sex_lens, ethnicity_lens)
);

-- -------------------------------------------------------------- prevalence

CREATE TABLE prevalence_sets (
  set_id     INTEGER PRIMARY KEY REFERENCES content_sets (set_id),
  min_score  REAL NOT NULL,
  max_score  REAL NOT NULL
);

CREATE TABLE prevalence_tiers (
  set_id  INTEGER NOT NULL REFERENCES prevalence_sets (set_id),
  code    TEXT NOT NULL,
  tier    TEXT NOT NULL CHECK (tier IN ('very_rare', 'rare', 'uncommon', 'common', 'very_common')),
  PRIMARY KEY (set_id, code)
) WITHOUT ROWID;

-- ---------------------------------------------------------- model registry

CREATE TABLE registry_sets (
  set_id                 INTEGER PRIMARY KEY REFERENCES content_sets (set_id),
  default_model_version  TEXT
);

CREATE TABLE models (
  set_id             INTEGER NOT NULL REFERENCES registry_sets (set_id),
  model_version      TEXT NOT NULL,
  position           INTEGER NOT NULL,
  model_name         TEXT,
  model_release      TEXT,
  display_name       TEXT NOT NULL,
  status             TEXT NOT NULL,
  default_use_case   TEXT,
  effects_json       TEXT,
  capabilities_json  TEXT,
  PRIMARY KEY (set_id, model_version),
  UNIQUE (set_id, position)
) WITHOUT ROWID;

CREATE TABLE use_case_variants (
  set_id         INTEGER NOT NULL,
  model_version  TEXT NOT NULL,
  use_case       TEXT NOT NULL,
  position       INTEGER NOT NULL,
  -- Legacy JSON paths, kept for traceability only.
  legacy_metrics_file                 TEXT,
  legacy_multimorbidity_metrics_file  TEXT,
  PRIMARY KEY (set_id, model_version, use_case),
  UNIQUE (set_id, model_version, position),
  FOREIGN KEY (set_id, model_version) REFERENCES models (set_id, model_version)
) WITHOUT ROWID;

-- ------------------------------------------------------------ metric tuples

-- Distinct warning lists, in stored order. Rows reference them by id.
CREATE TABLE warning_sets (
  warning_set_id  INTEGER PRIMARY KEY,
  codes_json      TEXT NOT NULL UNIQUE
);

-- Lens combinations a metrics or multimorbidity set defines, in source order.
-- Derivations fall back across lenses only when a combination is not defined
-- here (CONTRACT.md §7).
CREATE TABLE set_combos (
  set_id     INTEGER NOT NULL REFERENCES content_sets (set_id),
  position   INTEGER NOT NULL,
  combo_idx  INTEGER NOT NULL REFERENCES lens_combos (combo_idx),
  PRIMARY KEY (set_id, position),
  UNIQUE (set_id, combo_idx)
) WITHOUT ROWID;

-- Single-disease source tuples: one row per set × lens combination × top-level
-- condition, with the 13 row_format fields stored as given (no normalization).
CREATE TABLE metric_rows (
  set_id                 INTEGER NOT NULL REFERENCES content_sets (set_id),
  combo_idx              INTEGER NOT NULL REFERENCES lens_combos (combo_idx),
  concept_id             TEXT NOT NULL REFERENCES concepts (concept_id),
  perf                   REAL,
  ci_low                 REAL,
  ci_high                REAL,
  evidence_grade         TEXT CHECK (evidence_grade IN ('A', 'B', 'C', 'D', 'E', 'F')),
  n_samples              INTEGER,
  n_sites                INTEGER,
  n_studies              INTEGER,
  peer_reviewed_studies  INTEGER,
  validation_type        TEXT,
  in_intended_use        INTEGER NOT NULL CHECK (in_intended_use IN (0, 1)),
  intended_use_coverage  REAL,
  intended_use_level     TEXT NOT NULL,
  warning_set_id         INTEGER NOT NULL REFERENCES warning_sets (warning_set_id),
  PRIMARY KEY (set_id, combo_idx, concept_id)
) WITHOUT ROWID;

-- ----------------------------------------------------------- multimorbidity

CREATE TABLE mm_combinations (
  set_id           INTEGER NOT NULL REFERENCES content_sets (set_id),
  position         INTEGER NOT NULL,
  -- Canonical unordered key: anchor ids, deduplicated, sorted, joined by '+'.
  combination_key  TEXT NOT NULL,
  -- Stored label as given (may be NULL or empty).
  label            TEXT,
  PRIMARY KEY (set_id, position),
  UNIQUE (set_id, combination_key)
) WITHOUT ROWID;

-- Condition ids of each combination, in stored order.
CREATE TABLE mm_combination_conditions (
  set_id        INTEGER NOT NULL,
  position      INTEGER NOT NULL,
  member_index  INTEGER NOT NULL,
  concept_id    TEXT NOT NULL REFERENCES concepts (concept_id),
  PRIMARY KEY (set_id, position, member_index),
  FOREIGN KEY (set_id, position) REFERENCES mm_combinations (set_id, position)
) WITHOUT ROWID;

CREATE INDEX mm_combination_conditions_concept ON mm_combination_conditions (set_id, concept_id);

CREATE TABLE mm_rows (
  set_id                 INTEGER NOT NULL,
  position               INTEGER NOT NULL,
  combo_idx              INTEGER NOT NULL REFERENCES lens_combos (combo_idx),
  perf                   REAL,
  ci_low                 REAL,
  ci_high                REAL,
  evidence_grade         TEXT CHECK (evidence_grade IN ('A', 'B', 'C', 'D', 'E', 'F')),
  n_samples              INTEGER,
  n_sites                INTEGER,
  n_studies              INTEGER,
  peer_reviewed_studies  INTEGER,
  validation_type        TEXT,
  in_intended_use        INTEGER NOT NULL CHECK (in_intended_use IN (0, 1)),
  intended_use_coverage  REAL,
  intended_use_level     TEXT NOT NULL,
  warning_set_id         INTEGER NOT NULL REFERENCES warning_sets (warning_set_id),
  PRIMARY KEY (set_id, position, combo_idx),
  FOREIGN KEY (set_id, position) REFERENCES mm_combinations (set_id, position)
) WITHOUT ROWID;
