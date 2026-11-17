import { canonicalJson, httpError, sha256 } from './util.js';
import {
  GROUP_FIELDS,
  MEASURES,
  MEASURE_IDS,
  isValidDimension,
  isValidValue,
} from './dimensions.js';

const MAX_GROUP_BY = 2;
const MAX_MEASURES = 5;

function asArray(value, fieldName) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw httpError(400, `${fieldName} must be an array`);
  }
  return value;
}

function normalizeGroupBy(input) {
  const groupBy = asArray(input, 'groupBy');
  if (groupBy.length > MAX_GROUP_BY) {
    throw httpError(400, `groupBy supports at most ${MAX_GROUP_BY} fields`);
  }
  const seen = new Set();
  for (const field of groupBy) {
    if (!isValidDimension(field)) {
      throw httpError(400, `unknown groupBy field: ${field}`);
    }
    if (seen.has(field)) {
      throw httpError(400, `duplicate groupBy field: ${field}`);
    }
    seen.add(field);
  }
  return groupBy;
}

function normalizeFilters(input) {
  const filters = asArray(input, 'filters');
  const seen = new Set();
  const normalized = [];
  for (const filter of filters) {
    if (!filter || typeof filter !== 'object') {
      throw httpError(400, 'each filter must be an object');
    }
    const { field } = filter;
    if (!isValidDimension(field)) {
      throw httpError(400, `unknown filter field: ${field}`);
    }
    if (seen.has(field)) {
      throw httpError(400, `duplicate filter field: ${field}`);
    }
    seen.add(field);
    const values = asArray(filter.values, `filter(${field}).values`);
    if (values.length === 0) {
      throw httpError(400, `filter(${field}) must list at least one value`);
    }
    const unique = [...new Set(values)].sort();
    for (const value of unique) {
      if (!isValidValue(field, value)) {
        throw httpError(400, `invalid value for ${field}: ${value}`);
      }
    }
    normalized.push({ field, values: unique });
  }
  normalized.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  return normalized;
}

function normalizeMeasures(input) {
  const measures = asArray(input, 'measures');
  if (measures.length === 0) {
    throw httpError(400, 'measures must not be empty');
  }
  if (measures.length > MAX_MEASURES) {
    throw httpError(400, `measures supports at most ${MAX_MEASURES} entries`);
  }
  const seen = new Set();
  const normalized = [];
  for (const measure of measures) {
    const id = typeof measure === 'string' ? measure : measure?.id;
    if (!MEASURE_IDS.includes(id)) {
      throw httpError(400, `unknown measure: ${id}`);
    }
    if (seen.has(id)) {
      throw httpError(400, `duplicate measure: ${id}`);
    }
    seen.add(id);
    normalized.push({ id });
  }
  return normalized;
}

/**
 * The material configuration is everything that influences the bytes of a
 * result. Name/description changes do not bump the cache namespace.
 */
export function normalizeConfig(input) {
  if (!input || typeof input !== 'object') {
    throw httpError(400, 'config must be an object');
  }
  return {
    groupBy: normalizeGroupBy(input.groupBy),
    filters: normalizeFilters(input.filters),
    measures: normalizeMeasures(input.measures),
  };
}

export function materialConfig(config) {
  return normalizeConfig(config);
}

export function configHash(config) {
  return sha256(canonicalJson(normalizeConfig(config)));
}

export function cacheKeyFor(specId, configVersion, hash) {
  return `${specId}#v${configVersion}#${hash.slice(0, 12)}`;
}

export function specDigest(spec) {
  return sha256(
    canonicalJson({
      kind: 'aggregate-spec',
      id: spec.id,
      configVersion: spec.configVersion,
      configHash: spec.configHash,
    }),
  );
}

export function matchesFilter(record, filters) {
  for (const filter of filters) {
    if (!filter.values.includes(record[filter.field])) return false;
  }
  return true;
}

export function columnsFor(config) {
  return [...config.groupBy, ...config.measures.map((measure) => measure.id)];
}

export function columnLabels(config) {
  const labels = {};
  for (const field of config.groupBy) {
    // Value labels are rendered per-cell; the column header is the dimension id.
    labels[field] = field;
  }
  for (const measure of config.measures) {
    labels[measure.id] = MEASURES[measure.id].label;
  }
  return labels;
}

function compareGroupRows(a, b, groupBy) {
  for (const field of groupBy) {
    const left = String(a[field]);
    const right = String(b[field]);
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

function computeMeasure(measureId, records) {
  const measure = MEASURES[measureId];
  if (measure.op === 'count') return records.length;
  const values = records.map((record) => Number(record[measure.field]) || 0);
  switch (measure.op) {
    case 'sum':
      return values.reduce((total, value) => total + value, 0);
    case 'avg':
      if (values.length === 0) return 0;
      return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
    case 'min':
      return values.length ? Math.min(...values) : 0;
    case 'max':
      return values.length ? Math.max(...values) : 0;
    default:
      throw new Error(`unsupported measure op: ${measure.op}`);
  }
}

/**
 * Deterministic aggregation used by both the builder and full verification.
 */
export function aggregate(records, config) {
  const normalized = normalizeConfig(config);
  const matching = records.filter((record) => matchesFilter(record, normalized.filters));
  const groups = new Map();
  for (const record of matching) {
    const key = normalized.groupBy.map((field) => String(record[field])).join('\u0001');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const rows = [];
  for (const groupRecords of groups.values()) {
    const row = {};
    for (const field of normalized.groupBy) {
      row[field] = groupRecords[0][field];
    }
    for (const measure of normalized.measures) {
      row[measure.id] = computeMeasure(measure.id, groupRecords);
    }
    rows.push(row);
  }
  rows.sort((a, b) => compareGroupRows(a, b, normalized.groupBy));
  return {
    columns: columnsFor(normalized),
    columnLabels: columnLabels(normalized),
    rows,
    rowCount: rows.length,
    matchedRecordCount: matching.length,
    config: normalized,
  };
}

export function outputDigest(result) {
  return sha256(
    canonicalJson({
      kind: 'aggregate-result',
      columns: result.columns,
      rows: result.rows,
    }),
  );
}

export function assertGroupFields(config) {
  for (const field of config.groupBy) {
    if (!GROUP_FIELDS.includes(field)) {
      throw httpError(400, `invalid group field: ${field}`);
    }
  }
}
