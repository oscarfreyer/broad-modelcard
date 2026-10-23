-- Broad Modelcard canonical store, schema version 6 (contract v1.11): intended use becomes optional.
--
-- * use_case_variants.intended_use_defined: whether the configuration (a card)
--   has an intended-use statement. NULL means it has one (the seed and every
--   registry set written before v1.11), 0 means it has none; the registry
--   upload stores 0 for "No" and NULL otherwise, so a filled template uploads
--   unchanged. For a card without a statement the API serves every
--   intended-use field as null and scores its rows without the intended-use
--   term (CONTRACT.md §4.4).
--
-- A metric row without an intended-use value (blank intended-use cells in an
-- upload) needs no schema change: metric_rows and mm_rows keep their NOT NULL
-- intended_use_level, and such a row is stored with the empty level '' (with
-- in_intended_use 0 and a NULL coverage), which the API serves as null
-- (app/schema/contract.py NO_INTENDED_USE_LEVEL). Rebuilding the two largest
-- tables to drop NOT NULL was not worth it for one marker value.
--
-- Additive only; existing content sets keep NULL and stay as they were. All
-- data is synthetic demonstration data.

ALTER TABLE use_case_variants ADD COLUMN intended_use_defined INTEGER
  CHECK (intended_use_defined IS NULL OR intended_use_defined = 0);
