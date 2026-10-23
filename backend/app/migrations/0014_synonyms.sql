-- Broad Modelcard canonical store, schema version 14 (contract v1.14, CONTRACT.md §31): synonyms of ICD-11 concepts for the
-- plain-language search.
--
-- Filled by the ontology import (python -m app.ontologies.importer, so also
-- npm run demo:build) from the pinned files it already reads: MONDO labels
-- and EXACT synonyms (source `mondo`) and ICD-10-CM index main terms (source
-- `icd10cm_index`), each reaching an ICD-11 level-2 concept through the
-- crosswalk of §23.2 (kinds exact and stem only). Each import replaces its
-- own source's rows in the transaction that replaces its ontology.
--
-- Reference data like `concepts`: no publish, rollback, or upload touches
-- it, and a store without an import has no rows, so its search is what it
-- was before (§9). Nothing here is committed to git.

CREATE TABLE concept_synonyms (
  source       TEXT NOT NULL CHECK (source IN ('mondo', 'icd10cm_index')),
  -- The ICD-11 level-2 concept (concepts.concept_id) the synonym names.
  concept_id   TEXT NOT NULL CHECK (length(concept_id) BETWEEN 1 AND 64),
  -- Case-folded with spacing collapsed: one row per source, concept, and key.
  synonym_key  TEXT NOT NULL,
  synonym      TEXT NOT NULL CHECK (length(synonym) BETWEEN 3 AND 200),
  -- What it was read under, for attribution: the MONDO id or the ICD-10-CM code.
  source_code  TEXT NOT NULL,
  -- Import order within the source; the first of two equal synonyms wins.
  position     INTEGER NOT NULL,
  PRIMARY KEY (source, concept_id, synonym_key)
) WITHOUT ROWID;
