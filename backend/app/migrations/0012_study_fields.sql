-- Broad Modelcard canonical store, schema version 12 (contract v1.14, CONTRACT.md §22): optional study fields.
--
-- * Applicability concerns (PROBAST+AI style overall judgement: low, high,
--   unclear) with optional notes.
-- * The appraisal tool (PROBAST+AI, APPRAISE-AI, QUADAS-AI, other) and, for a
--   tool that scores, its score (0 to 100). A score needs a tool.
-- * The setting category (emergency department, intensive care, inpatient
--   ward, outpatient clinic, primary care, mixed), beside the free-text
--   setting.
-- * The configuration evaluated (a label such as cfg-2026-03; not checked
--   against the registry).
--
-- Every column is nullable: existing studies, and files without the columns,
-- keep every value as it was. None of the fields enters a grade, signal,
-- status, warning, or score. ADD COLUMN keeps every row and id, so no table is
-- rebuilt.
--
-- All data is synthetic demonstration data. Never store patient data here.

ALTER TABLE studies ADD COLUMN applicability TEXT CHECK (applicability IN ('low', 'high', 'unclear'));
ALTER TABLE studies ADD COLUMN applicability_notes TEXT;
ALTER TABLE studies ADD COLUMN quality_tool TEXT CHECK (quality_tool IN ('probast_ai', 'appraise_ai', 'quadas_ai', 'other'));
ALTER TABLE studies ADD COLUMN quality_score REAL
  CHECK (quality_score IS NULL OR (quality_score BETWEEN 0 AND 100 AND quality_tool IS NOT NULL));
ALTER TABLE studies ADD COLUMN setting_category TEXT CHECK (setting_category IN (
  'emergency_department', 'intensive_care', 'inpatient_ward', 'outpatient_clinic', 'primary_care', 'mixed'));
ALTER TABLE studies ADD COLUMN configuration_id TEXT;
