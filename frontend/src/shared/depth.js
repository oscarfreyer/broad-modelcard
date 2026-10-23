// The explanation depth: plain words by default, the
// technical detail and A–F grades one switch away. The atlas's condition and
// combination cards and the comparison share these words.

export const DEFAULT_DEPTH = 'plain';
export const DEPTHS = Object.freeze(['plain', 'expert']);

export const DEPTH_OPTIONS = Object.freeze([
  { value: 'plain', label: 'Plain', title: 'Plain-language explanations' },
  { value: 'expert', label: 'Expert', title: 'Technical detail and A–F grades' }
]);

/** A depth from a URL or a stored default, or null when it is none of DEPTHS. */
export function depthOf(value) {
  return DEPTHS.includes(value) ? value : null;
}
