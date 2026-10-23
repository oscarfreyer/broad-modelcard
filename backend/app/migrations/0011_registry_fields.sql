-- Broad Modelcard canonical store, schema version 11 (contract v1.14, CONTRACT.md §28): configuration records, version
-- lineage, what a card's figures measure, data-protection declarations, and
-- the instance's data-protection note.
--
-- Additive only: nullable columns. Existing content sets (the seed import,
-- earlier uploads) keep NULL in every new column and stay as they were; a
-- content set is never changed after it is written, and every read of a store
-- without the new values is byte for byte what it was under contract v1.13.
--
-- * models (one AI system): replaces, the model version of the same registry
--   set this AI system supersedes (its predecessor). replaced_by is derived.
-- * use_case_variants (one card, AI system × function):
--   - the configuration record: a label and date, a summary of the prompt
--     (never the full prompt) and its optional SHA-256, retrieval, tools (a
--     JSON list of names), sampling settings, and fine-tuning;
--   - performance_measure and reference_standard: what the card's figures
--     measure, against which reference;
--   - four data-protection declarations (shown as declared by the developer,
--     never verified).
-- * instance_profile: an optional data-protection note of the organisation
--   that runs this copy (a hospital's own note).
--
-- All data is synthetic demonstration data, with fictional developers. Never
-- store patient data here.

ALTER TABLE models ADD COLUMN replaces TEXT;

ALTER TABLE use_case_variants ADD COLUMN configuration_id TEXT;
ALTER TABLE use_case_variants ADD COLUMN configuration_date TEXT;
ALTER TABLE use_case_variants ADD COLUMN prompt_summary TEXT;
ALTER TABLE use_case_variants ADD COLUMN prompt_sha256 TEXT;
ALTER TABLE use_case_variants ADD COLUMN retrieval TEXT;
ALTER TABLE use_case_variants ADD COLUMN tools_json TEXT;
ALTER TABLE use_case_variants ADD COLUMN sampling_temperature REAL
  CHECK (sampling_temperature IS NULL OR sampling_temperature BETWEEN 0 AND 2);
ALTER TABLE use_case_variants ADD COLUMN sampling_top_p REAL
  CHECK (sampling_top_p IS NULL OR sampling_top_p BETWEEN 0 AND 1);
ALTER TABLE use_case_variants ADD COLUMN sampling_max_output_tokens INTEGER
  CHECK (sampling_max_output_tokens IS NULL OR sampling_max_output_tokens >= 1);
ALTER TABLE use_case_variants ADD COLUMN fine_tuning TEXT;
ALTER TABLE use_case_variants ADD COLUMN performance_measure TEXT;
ALTER TABLE use_case_variants ADD COLUMN reference_standard TEXT;
ALTER TABLE use_case_variants ADD COLUMN declared_data_use TEXT;
ALTER TABLE use_case_variants ADD COLUMN declared_data_location TEXT;
ALTER TABLE use_case_variants ADD COLUMN declared_retention TEXT;
ALTER TABLE use_case_variants ADD COLUMN declared_privacy_contact TEXT;

ALTER TABLE instance_profile ADD COLUMN data_protection_note TEXT
  CHECK (data_protection_note IS NULL OR length(data_protection_note) BETWEEN 1 AND 500);
