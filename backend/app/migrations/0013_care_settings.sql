-- Broad Modelcard canonical store, schema version 13 (contract v1.14, CONTRACT.md §29): care settings as values of the Context axis.
--
-- The Context axis held one value, Clinical (shown as "Any setting"), and
-- every lens combination was Clinical × age × sex × ethnicity (combo_idx
-- 0–89, CONTRACT.md §4.1). This adds the five specific care settings after it,
-- in the order of app/schema/contract.py CARE_SETTINGS, and their lens
-- combinations: combo_idx = setting position × 90 + the Clinical combo_idx of
-- the same age, sex, and ethnicity. Every existing row, set, and combo_idx is
-- kept, so Any setting reads exactly as before; a metrics or local results
-- set stores a specific setting only where a row for it was uploaded.
--
-- A new store has no axes yet when migrations run (the seed import adds
-- them), so both statements add nothing there; the seed import adds the same
-- values and combinations after the seed's own (app/importers/legacy_json.py,
-- tests/test_care_settings.py checks the two paths agree). A store that holds
-- them already (an import made with this code) is left as it is.
--
-- All data is synthetic demonstration data. Never store patient data here.

INSERT INTO axis_values (axis, position, value)
SELECT 'context', setting.position, setting.value
FROM (
  SELECT 1 AS position, 'Emergency department' AS value
  UNION ALL SELECT 2, 'Intensive care'
  UNION ALL SELECT 3, 'Inpatient ward'
  UNION ALL SELECT 4, 'Outpatient clinic'
  UNION ALL SELECT 5, 'Primary care'
) AS setting
WHERE EXISTS (SELECT 1 FROM axis_values WHERE axis = 'context' AND position = 0 AND value = 'Clinical')
  AND NOT EXISTS (SELECT 1 FROM axis_values WHERE axis = 'context' AND position > 0);

INSERT INTO lens_combos (combo_idx, context, age_lens, sex_lens, ethnicity_lens)
SELECT setting.position * (SELECT COUNT(*) FROM lens_combos WHERE context = 'Clinical') + combo.combo_idx,
       setting.value, combo.age_lens, combo.sex_lens, combo.ethnicity_lens
FROM axis_values AS setting
JOIN lens_combos AS combo ON combo.context = 'Clinical'
WHERE setting.axis = 'context' AND setting.position > 0
  AND NOT EXISTS (SELECT 1 FROM lens_combos WHERE context <> 'Clinical')
ORDER BY setting.position, combo.combo_idx;
