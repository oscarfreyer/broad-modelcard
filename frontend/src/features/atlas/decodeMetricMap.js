/**
 * Decode a columnar contract MetricMap into concept id → row object. A map
 * read in another ontology (contract v1.13) carries `mapping`, an array of
 * crosswalk kinds aligned with `rows`; each row then has `mapping` (null for
 * blocks and chapters). ICD-11 maps have no such array, and their rows no key.
 * A read for a local population with local results for the card (v1.13, §26)
 * carries `layer` the same way: each row has `layer` (local, includes_local, or null).
 * A map with at least one row resting on a study record (2026-10-21, §22) carries
 * `appraisal`: each row has `appraisal` (linked, includes_linked, or null); without
 * the array no row has the key, and every row reads as not appraised.
 */
export function decodeMetricMap(map) {
  const rowsById = new Map();
  if (!map) {
    return rowsById;
  }
  const { columns, rows, mapping, layer, appraisal } = map;
  rows.forEach((values, index) => {
    const row = {};
    columns.forEach((column, columnIndex) => {
      row[column] = values[columnIndex];
    });
    if (mapping) {
      row.mapping = mapping[index] ?? null;
    }
    if (layer) {
      // Contract v1.13 (CONTRACT.md §26): local, includes_local, or null for a local population's read.
      row.layer = layer[index] ?? null;
    }
    if (appraisal) {
      row.appraisal = appraisal[index] ?? null;
    }
    rowsById.set(row.concept_id, row);
  });
  return rowsById;
}
