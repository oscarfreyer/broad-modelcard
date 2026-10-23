// The live interaction page's CDS Hooks mode (contract v1.14, CONTRACT.md §33):
// the request built from the synthetic case, and the returned cards in words.
// React-free, so the tests can read it. Synthetic patients only: the request
// holds a made-up patient id, a birth date chosen from the age group, the sex,
// and condition codes; nothing else from the page.
import { LENS_CHOICES, parseCodes } from '../../embed/panelInputs.js';

export const ICD11_SYSTEM = 'http://id.who.int/icd/release/11/mms';
export const ICD10CM_SYSTEM = 'http://hl7.org/fhir/sid/icd-10-cm';
export const CODE_SYSTEMS = Object.freeze([
  { value: 'icd11', label: 'ICD-11', system: ICD11_SYSTEM },
  { value: 'icd10cm', label: 'ICD-10-CM', system: ICD10CM_SYSTEM }
]);
const MAX_CDS_CONDITIONS = 12;
export const ICD10CM_EXAMPLE = 'E11.9, I10, J44.9';
const ICD10CM_CODE = /^[A-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?$/;
// A birth date per coarse age group: the patient is this old on any day of the year (born on 1 January).
const AGE_OF_GROUP = { '0-17': 10, '18-39': 30, '40-64': 52, '65+': 74 };

export const INDICATOR_WORDS = Object.freeze({ critical: 'Critical', warning: 'Warning', info: 'Info' });

/** ICD-10-CM codes from the codes field (as parseCodes does for ICD-11), up to the service's limit. */
export function parseIcd10cmCodes(value) {
  return parseCodes(value, { pattern: ICD10CM_CODE, max: MAX_CDS_CONDITIONS });
}

/** The codes of the case in the code system chosen; the service takes up to 12 in either. */
export function cdsCodes(codesText, codeSystem) {
  return codeSystem === 'icd10cm' ? parseIcd10cmCodes(codesText) : parseCodes(codesText, { max: MAX_CDS_CONDITIONS });
}

/** A synthetic birth date for the age group (null for all ages), relative to `today`. */
export function syntheticBirthDate(ageGroup, today = new Date()) {
  const age = AGE_OF_GROUP[ageGroup];
  return age === undefined ? null : `${today.getFullYear() - age}-01-01`;
}

/**
 * The CDS Hooks 2.0 patient-view request for the case: a FHIR Patient (birth
 * date from the age group, gender from the sex) and a Bundle of Condition
 * resources, one per code, plus the card, setting, and local population in
 * the service's extension. Ethnicity is not part of it.
 */
export function cdsRequest(current, { codeSystem = 'icd11', hookInstance = 'demo-request', today = new Date() } = {}) {
  const { codes } = cdsCodes(current.codesText, codeSystem);
  const system = CODE_SYSTEMS.find((entry) => entry.value === codeSystem)?.system ?? ICD11_SYSTEM;
  const patient = { resourceType: 'Patient', id: 'synthetic-patient-1' };
  const birthDate = syntheticBirthDate(current.lens?.age_group, today);
  if (birthDate) patient.birthDate = birthDate;
  if (current.lens?.sex) patient.gender = current.lens.sex;
  const extension = { card_id: `${current.model}|${current.useCase}` };
  if (current.setting) extension.setting = current.setting;
  if (current.population) extension.population = current.population;
  return {
    hook: 'patient-view',
    hookInstance,
    context: { patientId: 'synthetic-patient-1' },
    prefetch: {
      patient,
      conditions: {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: codes.map((code, index) => ({
          resource: { resourceType: 'Condition', id: `synthetic-condition-${index + 1}`, code: { coding: [{ system, code }] }, subject: { reference: 'Patient/synthetic-patient-1' } }
        }))
      }
    },
    extension: { 'broad-modelcard': extension }
  };
}

/** What the request says about the patient, in words (the population line of the CDS mode). */
export function requestPatientWords(current) {
  const parts = [];
  if (current.lens?.age_group) parts.push(`born ${syntheticBirthDate(current.lens.age_group)} (${LENS_CHOICES.age_group[current.lens.age_group]})`);
  if (current.lens?.sex) parts.push(`gender ${current.lens.sex}`);
  return parts.length ? parts.join(', ') : 'no birth date or gender (all patients)';
}

/**
 * A card's detail as paragraphs of text runs: the service writes short
 * markdown with **bold** and *italic* only. Everything else is shown as text.
 *
 * @returns {Array<Array<{ text: string, strong?: boolean, em?: boolean }>>}
 */
export function detailParagraphs(detail) {
  return String(detail ?? '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => {
      const runs = [];
      const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
      let last = 0;
      for (const match of paragraph.matchAll(pattern)) {
        if (match.index > last) runs.push({ text: paragraph.slice(last, match.index) });
        runs.push(match[1] !== undefined ? { text: match[1], strong: true } : { text: match[2], em: true });
        last = match.index + match[0].length;
      }
      if (last < paragraph.length) runs.push({ text: paragraph.slice(last) });
      return runs;
    });
}
