-- Broad Modelcard canonical store, schema version 3: registry entry fields
-- (contract v1.5).
--
-- Additive only: nullable columns on the registry tables. Existing content
-- sets (the seed import, earlier uploads) keep NULL in every new column and
-- stay as they were; a content set is never changed after it is written.
--
-- * models (one AI system, a "registry entry"): kind ('model' or 'product';
--   NULL is served as 'model'), AI type, developer, release date (ISO
--   YYYY-MM-DD), a short description, and built_on_json, a JSON list of model
--   versions of the same registry set that a product is built on.
-- * use_case_variants (one configuration, AI system × function): the function
--   category and four developer declarations (shown as "Declared by the
--   developer", never verified by Broad Modelcard).
--
-- All data is synthetic demonstration data, with fictional developers.

ALTER TABLE models ADD COLUMN kind TEXT CHECK (kind IS NULL OR kind IN ('model', 'product'));
ALTER TABLE models ADD COLUMN ai_type TEXT;
ALTER TABLE models ADD COLUMN developer TEXT;
ALTER TABLE models ADD COLUMN release_date TEXT;
ALTER TABLE models ADD COLUMN description TEXT;
ALTER TABLE models ADD COLUMN built_on_json TEXT;

ALTER TABLE use_case_variants ADD COLUMN function_category TEXT;
ALTER TABLE use_case_variants ADD COLUMN declared_intended_purpose TEXT;
ALTER TABLE use_case_variants ADD COLUMN declared_regulatory_status TEXT;
ALTER TABLE use_case_variants ADD COLUMN declared_contact TEXT;
ALTER TABLE use_case_variants ADD COLUMN declared_documentation_url TEXT;
