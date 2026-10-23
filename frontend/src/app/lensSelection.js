// The demographic lens against the axes `/meta` offers. A lens can come from
// the URL before the axes have loaded; it is only sent once every value is
// one the axes hold ("All …" always is), so a bogus `?age=` never reaches a
// metrics request (the backend would answer 422 `invalid_lens`).
import { ALL_LENS } from './startupParams.js';

const AXES = Object.keys(ALL_LENS);

function isOffered(axis, value, axes) {
  return value === ALL_LENS[axis] || (Array.isArray(axes?.[axis]) && axes[axis].includes(value));
}

/** A lens with "All …" for every axis it leaves open. */
export function withDefaults(lens) {
  return Object.fromEntries(AXES.map((axis) => [axis, lens?.[axis] || ALL_LENS[axis]]));
}

/**
 * The lens with every value the axes do not offer reset to "All …". Returns
 * the same object when nothing changes. Without axes, nothing can be checked
 * yet and the lens is returned as it is.
 */
export function fitLens(lens, axes) {
  if (!axes) {
    return lens;
  }
  const next = Object.fromEntries(AXES.map((axis) => [axis, isOffered(axis, lens[axis], axes) ? lens[axis] : ALL_LENS[axis]]));
  return AXES.every((axis) => next[axis] === lens[axis]) ? lens : next;
}

/** Whether the lens may be sent: every value is offered by the axes (all "All …" before they load). */
export function isLensSendable(lens, axes) {
  return AXES.every((axis) => (axes ? isOffered(axis, lens?.[axis], axes) : lens?.[axis] === ALL_LENS[axis]));
}

/**
 * The lens with at most one population group: the static demo records each
 * group alone, so a group on one axis resets the others to
 * "All …". `axis` is the axis just chosen, which wins; without it the first
 * axis with a group is kept. Returns the same object when nothing changes.
 */
export function withOneGroup(lens, axis = null) {
  const chosen = axis && lens[axis] && lens[axis] !== ALL_LENS[axis] ? axis : AXES.find((name) => lens[name] && lens[name] !== ALL_LENS[name]);
  const next = Object.fromEntries(AXES.map((name) => [name, name === chosen ? lens[name] : ALL_LENS[name]]));
  return AXES.every((name) => next[name] === lens[name]) ? lens : next;
}

/**
 * The lens the static demo shows (release 0.4): one population group
 * at a time in ICD-11 (withOneGroup), and all patients only in another
 * classification, which the snapshot records at the default lens alone.
 * Returns the same object when nothing changes, and ALL_LENS itself when the
 * classification resets it.
 */
export function staticLens(lens, { axis = null, isOtherOntology = false } = {}) {
  if (isOtherOntology) {
    return AXES.every((name) => (lens?.[name] ?? ALL_LENS[name]) === ALL_LENS[name]) ? lens : ALL_LENS;
  }
  return withOneGroup(lens, axis);
}

/** The words for a population choice the static demo does not offer in another classification (R7). */
export const STATIC_OTHER_ONTOLOGY_LENS_NOTE = 'In this static demo, classifications other than ICD-11 show all patients only. Switch to ICD-11 to choose a group.';

/** The words for a population choice the static demo does not offer at a care setting (release 0.5, Q9). */
export const STATIC_SETTING_LENS_NOTE = 'In this static demo, a care setting shows all patients only. Choose Any setting to choose a group.';

/** The words for a care setting the static demo does not offer in another classification (release 0.5, Q9). */
export const STATIC_SETTING_ONTOLOGY_NOTE = 'In this static demo, care settings are shown in ICD-11 only. Switch to ICD-11 to choose one.';
