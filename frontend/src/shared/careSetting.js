// The care setting (contract v1.14, CONTRACT.md §29): a lens
// axis beside age, sex, and ethnicity. `Clinical`, the Context axis's first
// value, is shown as "Any setting" and holds every result stored without a
// setting. A specific setting reads only the results stored for it: where
// a card stores none, the answer is No data, never the Any-setting result.
//
// The specific settings are the first five study setting categories (§22),
// so one vocabulary serves the lens, the studies, the atlas URL (`setting`,
// by code), and the live panel's lookup (`context.setting`, by code).
// React-free: the panel bundle imports it.

/** The Context axis value of Any setting (what the API calls it). */
export const ANY_SETTING = 'Clinical';
export const ANY_SETTING_LABEL = 'Any setting';

/** The specific care settings, in axis order: the code (URL, lookup) and the axis value (reads). */
export const CARE_SETTINGS = Object.freeze([
  Object.freeze({ code: 'emergency_department', value: 'Emergency department' }),
  Object.freeze({ code: 'intensive_care', value: 'Intensive care' }),
  Object.freeze({ code: 'inpatient_ward', value: 'Inpatient ward' }),
  Object.freeze({ code: 'outpatient_clinic', value: 'Outpatient clinic' }),
  Object.freeze({ code: 'primary_care', value: 'Primary care' })
]);

const BY_CODE = new Map(CARE_SETTINGS.map((setting) => [setting.code, setting.value]));
const BY_VALUE = new Map(CARE_SETTINGS.map((setting) => [setting.value, setting.code]));

/** A specific setting's axis value, or null for Any setting and for anything else. */
export function specificSetting(value) {
  return BY_VALUE.has(value) ? value : null;
}

/** The axis value of a setting code (`emergency_department` → "Emergency department"), or null. */
export function settingOfCode(code) {
  return BY_CODE.get(code) ?? null;
}

/** The code of a specific setting's axis value, or null. */
export function codeOfSetting(value) {
  return BY_VALUE.get(value) ?? null;
}

/** What the UI calls a setting: "Any setting" for Clinical or none, else its name. */
export function settingLabel(value) {
  return specificSetting(value) ?? ANY_SETTING_LABEL;
}

/**
 * The settings a card stores rows for (listModels' `settings`, absent: Any
 * setting only), as axis values.
 *
 * @param {{ settings?: string[] }|null|undefined} useCaseEntry a listModels use case entry
 * @returns {string[]}
 */
export function storedSettings(useCaseEntry) {
  return Array.isArray(useCaseEntry?.settings) && useCaseEntry.settings.length ? useCaseEntry.settings : [ANY_SETTING];
}

/** The legend's and chip's words for a specific setting on screen ('' for Any setting). */
export function settingNotice(value) {
  const setting = specificSetting(value);
  return setting ? `Setting: ${setting}. Only results measured there; a condition without one reads No data.` : '';
}

/** The words beside a setting the card stores no results for, in a setting choice. */
export const NO_DATA_STORED = 'No data stored';

/** The same in the static demo, which records only the settings a card stores (release 0.5). */
export const NOT_IN_STATIC_DEMO = 'not in the static demo';

/** The static demo's words when a setting was asked for on a card that stores none there (Q9). */
export function staticSettingNotice(value) {
  const setting = specificSetting(value) ?? value;
  return `This static demo holds ${setting} only for the cards that store results there, so this card shows Any setting.`;
}

/** The condition card when the chosen setting has no result for the condition. */
export const NO_DATA_FOR_SETTING = 'No data for this setting';

/** The label of the Any-setting result shown on request beside a specific setting. */
export function anySettingResultLabel(value) {
  const setting = specificSetting(value);
  return setting ? `Any setting, not specific to ${setting}` : ANY_SETTING_LABEL;
}

/** Whether a card stores any row at a specific setting (Any setting: always). */
export function storesSetting(useCaseEntry, value) {
  const setting = specificSetting(value);
  return !setting || storedSettings(useCaseEntry).includes(setting);
}
