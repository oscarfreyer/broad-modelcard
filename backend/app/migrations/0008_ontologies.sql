-- Broad Modelcard canonical store, schema version 8 (contract v1.13): other disease ontologies as projections.
--
-- ICD-11 stays as it is: the `concepts` table is the ontology `icd11`, the
-- default, and the storage key of every result, population, incident, and
-- combination. Other ontologies (ICD-10-CM, MONDO) are alternative
-- hierarchies of the same three-level shape over a crosswalk to the ICD-11
-- atlas. `python -m app.ontologies.importer` (npm run ontologies:import)
-- fills these tables from the pinned releases in
-- scripts/ontologies/sources.json; a store without them serves ICD-11 only.
--
-- They are reference data like `concepts`, not dataset versions: an import
-- replaces one ontology's rows in one transaction, and no publish, rollback,
-- or upload touches them. Nothing here is committed to git: the WHO mapping
-- tables (CC BY-ND 3.0 IGO) are used unmodified at import time only.
--
-- Additive only. All metric data stays synthetic demonstration data.

CREATE TABLE ontologies (
  ontology_id     TEXT PRIMARY KEY CHECK (ontology_id IN ('icd10cm', 'mondo')),
  -- Ring and toolbar order after ICD-11.
  position        INTEGER NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  release         TEXT NOT NULL,
  licence         TEXT NOT NULL,
  attribution     TEXT NOT NULL,
  -- The pinned files the import read: [{id, file, release, sha256, licence, attribution}].
  sources_json    TEXT NOT NULL,
  -- Concept counts per level and conditions per mapping kind (CONTRACT.md §23).
  counts_json     TEXT NOT NULL,
  imported_at     TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE ontology_concepts (
  ontology_id       TEXT NOT NULL REFERENCES ontologies (ontology_id) ON DELETE CASCADE,
  -- Position in the ontology's concept order; derivations iterate in it.
  concept_key       INTEGER NOT NULL,
  concept_id        TEXT NOT NULL CHECK (length(concept_id) BETWEEN 1 AND 64),
  parent_id         TEXT,
  level             INTEGER NOT NULL CHECK (level IN (0, 1, 2)),
  chapter_id        TEXT NOT NULL,
  chapter_no        TEXT,
  block_id          TEXT,
  -- The ontology's own code (ICD-10-CM code, MONDO id); NULL for groupings without one.
  code              TEXT,
  pt                TEXT NOT NULL,
  fsn               TEXT,
  sort_order        INTEGER NOT NULL,
  depth_in_kind     INTEGER CHECK (depth_in_kind IS NULL OR depth_in_kind BETWEEN 1 AND 3),
  metric_anchor_id  TEXT,
  -- Every parent the import holds, primary first (JSON list; MONDO shows the others).
  parents_json      TEXT,
  PRIMARY KEY (ontology_id, concept_key),
  UNIQUE (ontology_id, concept_id)
) WITHOUT ROWID;

-- One row per level-2 concept (CONTRACT.md §23).
CREATE TABLE ontology_mappings (
  ontology_id        TEXT NOT NULL REFERENCES ontologies (ontology_id) ON DELETE CASCADE,
  concept_id         TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('exact', 'stem', 'block', 'parent', 'none')),
  -- The ICD-11 concept (concepts.concept_id) whose result is served: level 2
  -- for exact and stem, level 1 for block, either for parent (what the via
  -- concept's own mapping names); NULL for none.
  target_concept_id  TEXT,
  via_concept_id     TEXT,
  steps              INTEGER CHECK (steps IS NULL OR steps BETWEEN 1 AND 2),
  source             TEXT,
  source_code        TEXT,
  icd11_code         TEXT,
  PRIMARY KEY (ontology_id, concept_id),
  FOREIGN KEY (ontology_id, concept_id) REFERENCES ontology_concepts (ontology_id, concept_id) ON DELETE CASCADE,
  CHECK ((kind = 'none') = (target_concept_id IS NULL)),
  CHECK ((kind = 'parent') = (via_concept_id IS NOT NULL AND steps IS NOT NULL))
) WITHOUT ROWID;
