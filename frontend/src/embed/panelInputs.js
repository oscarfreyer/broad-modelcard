// What the live panel accepts: a card,
// ICD-11 codes, coarse population values, and (contract v1.14) a care setting's code. Nothing else. Any attribute
// value that is not one of these is dropped before a request is built and is
// never shown back, because a host could put free text (a note, a name) into
// it by mistake.
import { settingOfCode } from '../shared/careSetting.js';

/** CDS Hooks–style hook name of the lookup body (R17). */
export const LOOKUP_HOOK = 'broad-modelcard-lookup';
export const ICD11_SYSTEM = 'http://id.who.int/icd/release/11/mms';

/** At most this many codes per case; the rest are ignored with a note. */
export const MAX_CODES = 8;

/**
 * ICD-11 MMS codes: a stem of chapter character, letter, digit, and letter or
 * digit (5A11, BA00, 1G40), optionally with an extension after a dot
 * (CA40.0, BA41.Z). The fixed letter and digit positions keep ordinary words
 * and numbers (JOHN, NOTE, 1950) out.
 */
const ICD11_CODE = /^[0-9A-Z][A-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?$/;
/** Registry ids (model_version, use_case): letters, digits, spaces, and . _ + - ( ). */
const REGISTRY_ID = /^[\p{L}\p{N} ._+()-]{1,120}$/u;
const STAGED_VERSION = /^staged:[A-Za-z0-9_-]{1,64}$/;

/** Coarse lens values the lookup takes (R17), with the words the panel shows. */
export const LENS_CHOICES = Object.freeze({
  age_group: Object.freeze({ '0-17': 'Age 0-17', '18-39': 'Age 18-39', '40-64': 'Age 40-64', '65+': 'Age 65+' }),
  sex: Object.freeze({ female: 'Female', male: 'Male' }),
  ethnicity: Object.freeze({ white: 'White', black: 'Black', hispanic: 'Hispanic', asian: 'Asian', other: 'Other' })
});

/** Element attribute → lens field. */
export const LENS_ATTRIBUTES = Object.freeze({ 'age-group': 'age_group', sex: 'sex', ethnicity: 'ethnicity' });

/** Every attribute the element observes. */
export const PANEL_ATTRIBUTES = Object.freeze(['model', 'use-case', 'codes', ...Object.keys(LENS_ATTRIBUTES), 'setting', 'population', 'version', 'depth', 'api-base']);

/** A local population id (contract v1.10, §21), as /meta lists them. */
const POPULATION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const DEFAULT_API_BASE = '/api/v1';

/**
 * A care setting's code (contract v1.14, §29: emergency_department, …), or null for any setting
 * (absent, empty, or "any"). `ignored` is true when a value was given but is not a setting.
 */
export function parseSetting(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === 'any') {
    return { value: null, ignored: false };
  }
  return settingOfCode(text) ? { value: text, ignored: false } : { value: null, ignored: true };
}

function registryId(value) {
  const text = String(value ?? '').trim();
  return REGISTRY_ID.test(text) ? text : null;
}

/**
 * The codes of a `codes` attribute: comma- (or space-) separated ICD-11
 * codes, upper-cased and de-duplicated in order. Anything else counts as
 * ignored, without keeping its text. `pattern` and `max` let the CDS Hooks
 * mode read ICD-10-CM codes and take up to its service's limit.
 *
 * @param {string|null|undefined} value
 * @param {{ pattern?: RegExp, max?: number }} [options]
 * @returns {{ codes: string[], ignored: number }}
 */
export function parseCodes(value, { pattern = ICD11_CODE, max = MAX_CODES } = {}) {
  const codes = [];
  let ignored = 0;
  for (const token of String(value ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const code = token.toUpperCase();
    if (!pattern.test(code)) {
      ignored += 1;
    } else if (!codes.includes(code)) {
      if (codes.length < max) {
        codes.push(code);
      } else {
        ignored += 1;
      }
    }
  }
  return { codes, ignored };
}

/**
 * One coarse lens value, or null for "all" (absent, empty, or not one of the
 * choices). `ignored` is true when a value was given but is not a choice.
 */
export function parseLensValue(field, value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === 'all') {
    return { value: null, ignored: false };
  }
  return Object.prototype.hasOwnProperty.call(LENS_CHOICES[field], text) ? { value: text, ignored: false } : { value: null, ignored: true };
}

/**
 * The panel's inputs from its attributes.
 *
 * @param {(name: string) => string|null} getAttribute
 * @returns {{
 *   model: string|null, useCase: string|null, codes: string[],
 *   lens: { age_group: string|null, sex: string|null, ethnicity: string|null },
 *   setting: string|null,
 *   population: string|null,
 *   ignored: { codes: number, lens: string[] },
 *   version: string, depth: 'plain'|'expert', apiBase: string
 * }}
 * `population` is a local population id (the atlas's local prevalence), or null for the default.
 */
export function readPanelInputs(getAttribute) {
  const { codes, ignored } = parseCodes(getAttribute('codes'));
  const lens = {};
  const ignoredLens = [];
  for (const [attribute, field] of Object.entries(LENS_ATTRIBUTES)) {
    const parsed = parseLensValue(field, getAttribute(attribute));
    lens[field] = parsed.value;
    if (parsed.ignored) ignoredLens.push(attribute);
  }
  // A care setting by its code (v1.14); anything else reads as any setting, like an unknown group.
  const setting = parseSetting(getAttribute('setting'));
  if (setting.ignored) ignoredLens.push('setting');
  const version = String(getAttribute('version') ?? '').trim();
  const population = String(getAttribute('population') ?? '').trim();
  const apiBase = String(getAttribute('api-base') ?? '').trim();
  return {
    model: registryId(getAttribute('model')),
    useCase: registryId(getAttribute('use-case')),
    codes,
    lens,
    setting: setting.value,
    population: POPULATION_ID.test(population) ? population : null,
    ignored: { codes: ignored, lens: ignoredLens },
    version: STAGED_VERSION.test(version) ? version : 'live',
    depth: getAttribute('depth') === 'expert' ? 'expert' : 'plain',
    apiBase: /^(?:https?:\/\/[^\s"'<>]+|\/[^\s"'<>]*)$/.test(apiBase) ? apiBase.replace(/\/+$/, '') : DEFAULT_API_BASE
  };
}

/** Why the panel cannot look anything up yet, or null when it can. */
export function missingInput(inputs) {
  if (!inputs.model || !inputs.useCase) return 'card';
  if (!inputs.codes.length) return 'codes';
  return null;
}

/**
 * The POST /lookup body (R17): CDS Hooks–shaped, codes and coarse lens only,
 * a local population's id when the host names one (contract v1.10), and a
 * care setting's code when it names one (v1.14).
 */
export function lookupBody(inputs) {
  return {
    hook: LOOKUP_HOOK,
    context: {
      card: { model_version: inputs.model, use_case: inputs.useCase },
      conditions: inputs.codes.map((code) => ({ system: ICD11_SYSTEM, code })),
      population: { age_group: inputs.lens.age_group, sex: inputs.lens.sex, ethnicity: inputs.lens.ethnicity },
      ...(inputs.population ? { population_id: inputs.population } : {}),
      ...(inputs.setting ? { setting: inputs.setting } : {})
    }
  };
}

/** A stable key for the request the inputs describe (to skip repeats). */
export function inputsKey(inputs) {
  return JSON.stringify([inputs.apiBase, inputs.version, lookupBody(inputs)]);
}
