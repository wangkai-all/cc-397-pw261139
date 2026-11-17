import { canonicalJson, sha256 } from '../lib/util.js';
import { matchesFilter } from '../lib/spec.js';
import { MEASURES } from '../lib/dimensions.js';

/**
 * Fields whose value can change the output of a spec:
 *   - every field the spec groups by,
 *   - every field it filters on,
 *   - the numeric field behind any of its measures.
 *
 * Name and notes are intentionally absent: editing them must not invalidate a
 * cache that cannot observe them.
 */
export function dependencyFields(spec) {
  const fields = new Set([...spec.config.groupBy, ...spec.config.filters.map((f) => f.field)]);
  for (const measure of spec.config.measures) {
    const def = MEASURES[measure.id];
    if (def?.field) fields.add(def.field);
  }
  return [...fields].sort();
}

/**
 * Digest of the source slice this spec can observe, including which records
 * currently fall inside its filters. Two equal digests imply the same output
 * (absent code changes). Record ids are included so that adding/removing a
 * record with identical values still changes the digest where it matters.
 */
export function relevantSourceDigest(spec, records) {
  const fields = dependencyFields(spec);
  const relevant = records
    .filter((record) => !record.deleted && matchesFilter(record, spec.config.filters))
    .map((record) => {
      const values = {};
      for (const field of fields) values[field] = record[field];
      return canonicalJson({ id: record.id, values });
    })
    .sort();
  return {
    digest: sha256(relevant.join('\n')),
    relevantRecordCount: relevant.length,
    fields,
  };
}

/**
 * Decides whether a record revision can affect a spec. `before` and `after` are
 * full record snapshots including a `deleted` flag (null on the absent side).
 */
export function recordChangeAffectsSpec(spec, before, after) {
  const filters = spec.config.filters;
  const wasLive = Boolean(before) && !before.deleted;
  const isLive = Boolean(after) && !after.deleted;

  if (wasLive !== isLive) {
    // Appearing/disappearing only matters if the record is (or was) in scope.
    const stoodInScope = wasLive && matchesFilter(before, filters);
    const standsInScope = isLive && matchesFilter(after, filters);
    if (stoodInScope || standsInScope) {
      return { affected: true, reason: 'presence' };
    }
    return { affected: false, reason: 'outside-filter' };
  }
  if (!wasLive) {
    return { affected: false, reason: 'already-absent' };
  }

  const inBefore = matchesFilter(before, filters);
  const inAfter = matchesFilter(after, filters);
  if (inBefore !== inAfter) {
    return { affected: true, reason: 'membership' };
  }
  if (!inBefore && !inAfter) {
    return { affected: false, reason: 'outside-filter' };
  }
  const changed = [];
  for (const field of dependencyFields(spec)) {
    if (before[field] !== after[field]) changed.push(field);
  }
  if (changed.length > 0) {
    return { affected: true, reason: 'field', fields: changed.sort() };
  }
  return { affected: false, reason: 'no-relevant-field' };
}
