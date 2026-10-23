// The demo page's case: a card, ICD-11 codes, coarse
// population groups, and the explanation depth. Synthetic presets only; the
// page has no field for free text, and the codes field passes only what reads
// as an ICD-11 code (embed/panelInputs.js) to the panel.
import { LENS_CHOICES, parseCodes } from '../../embed/panelInputs.js';
import { lensValueWords } from '../../shared/format.js';
import { CARE_SETTINGS, ANY_SETTING_LABEL } from '../../shared/careSetting.js';

/** Synthetic cases on the demo data (backend/demo, pack v2). Codes and coarse lens values only. */
export const PRESETS = Object.freeze([
  {
    id: 'diabetes-older-women',
    title: 'Type 2 diabetes, 65+, female',
    note: 'One condition at a specific population',
    model: 'SynGPT-2.0',
    useCase: 'Clinician Facing CDSS',
    codes: ['5A11'],
    lens: { age_group: '65+', sex: 'female', ethnicity: null }
  },
  {
    id: 'diabetes-kidney',
    title: 'Type 2 diabetes + chronic kidney disease',
    note: 'A stored combination',
    model: 'SynGPT-2.0',
    useCase: 'Clinician Facing CDSS',
    codes: ['5A11', 'GB61'],
    lens: { age_group: null, sex: null, ethnicity: null }
  },
  {
    id: 'melanoma-recall',
    title: 'Melanoma of skin',
    note: 'A card with an open Serious safety incident',
    model: 'DoAIHaveCancer-1.0',
    useCase: 'Skin lesion CDSS',
    codes: ['2C30'],
    lens: { age_group: null, sex: null, ethnicity: null }
  },
  {
    id: 'triage-stroke-older',
    title: 'Stroke at triage, 65+',
    note: 'A product at a specific population: No data',
    model: 'Vantrel-Triage-2.1',
    useCase: 'Emergency department triage',
    codes: ['8B20'],
    lens: { age_group: '65+', sex: null, ethnicity: null }
  },
  {
    id: 'triage-stroke-emergency',
    title: 'Stroke at triage, emergency department',
    note: 'A result measured in one care setting',
    model: 'Vantrel-Triage-2.1',
    useCase: 'Emergency department triage',
    codes: ['8B20'],
    lens: { age_group: '65+', sex: null, ethnicity: null },
    setting: 'emergency_department'
  }
]);

/** The case the page opens with: the first preset. */
export const DEFAULT_CASE = Object.freeze(caseFromPreset(PRESETS[0]));

/** The case a preset sets. */
export function caseFromPreset(preset, depth = 'plain', population = null) {
  return {
    model: preset.model,
    useCase: preset.useCase,
    codesText: preset.codes.join(', '),
    lens: { ...preset.lens },
    // The code of a care setting (contract v1.14), or null for any setting.
    setting: preset.setting ?? null,
    depth,
    population
  };
}

/** The preset the case equals, or null once anything was edited. */
export function matchingPreset(current) {
  const { codes } = parseCodes(current.codesText);
  return (
    PRESETS.find(
      (preset) =>
        preset.model === current.model &&
        preset.useCase === current.useCase &&
        preset.codes.join(',') === codes.join(',') &&
        (preset.setting ?? null) === (current.setting ?? null) &&
        Object.keys(LENS_CHOICES).every((field) => (preset.lens[field] ?? null) === (current.lens[field] ?? null))
    ) ?? null
  );
}

/** Select options for the care setting (contract v1.14): "Any setting" first, then the settings by code. */
export function settingOptions() {
  return [{ value: '', label: ANY_SETTING_LABEL }, ...CARE_SETTINGS.map((setting) => ({ value: setting.code, label: setting.value }))];
}

/** Select options for a lens field: "All …" first, then the coarse groups. */
export function lensOptions(field) {
  const all = { age_group: 'All ages', sex: 'All sexes', ethnicity: 'All ethnicities' }[field];
  return [{ value: '', label: all }, ...Object.entries(LENS_CHOICES[field]).map(([value, label]) => ({ value, label: lensValueWords(label) }))];
}

/**
 * The attributes the demo page sets on <bmc-live-panel>: only codes that read
 * as ICD-11 codes and the coarse lens values. Empty values are left out.
 */
export function panelAttributes(current) {
  const { codes } = parseCodes(current.codesText);
  const attributes = { model: current.model, 'use-case': current.useCase, codes: codes.join(','), depth: current.depth };
  if (current.lens.age_group) attributes['age-group'] = current.lens.age_group;
  if (current.lens.sex) attributes.sex = current.lens.sex;
  if (current.lens.ethnicity) attributes.ethnicity = current.lens.ethnicity;
  // A care setting by its code (contract v1.14); any setting is left out.
  if (current.setting) attributes.setting = current.setting;
  // A local prevalence (contract v1.10): the panel names it, as the atlas does.
  if (current.population) attributes.population = current.population;
  return attributes;
}

const escapeAttribute = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The markup a host page uses for this case (shown under "Embed it"). */
export function embedSnippet(current, scriptSrc = 'bmc-live-panel.js') {
  const attributes = Object.entries(panelAttributes(current))
    .filter(([name, value]) => value && !(name === 'depth' && value === 'plain'))
    .map(([name, value]) => `  ${name}="${escapeAttribute(value)}"`)
    .join('\n');
  return `<script type="module" src="${scriptSrc}"></script>\n<bmc-live-panel\n${attributes}>\n</bmc-live-panel>`;
}

/**
 * Whether typed codes pass on at once: an empty field, or one that ends in a
 * separator (comma, semicolon, space), so the last code is complete. Anything
 * else waits for a pause or for the field to lose focus (PluginApp.jsx), so a
 * code being typed ("CA40.") is neither flagged nor looked up half-way.
 */
export function codesSettleNow(text) {
  return text === '' || /[,;\s]$/.test(text);
}
