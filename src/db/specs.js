import { canonicalJson, httpError, nowIso, sha256 } from '../lib/util.js';
import { cacheKeyFor, configHash, normalizeConfig, specDigest } from '../lib/spec.js';
import { dimensionCatalog, measureCatalog } from '../lib/dimensions.js';
import { nextSequence, transaction } from './schema.js';

function rowToSpec(row) {
  if (!row) return null;
  return {
    id: row.id,
    seq: Number(row.seq),
    name: row.name,
    description: row.description,
    configVersion: Number(row.config_version),
    configHash: row.config_hash,
    config: JSON.parse(row.config_json),
    cacheKey: row.cache_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function specBody(spec, extra = {}) {
  return {
    id: spec.id,
    seq: spec.seq,
    name: spec.name,
    description: spec.description,
    configVersion: spec.configVersion,
    configHash: spec.configHash,
    config: spec.config,
    cacheKey: spec.cacheKey,
    digest: specDigest(spec),
    createdAt: spec.createdAt,
    updatedAt: spec.updatedAt,
    ...extra,
  };
}

export function validateSpecInput(input, { partial = false } = {}) {
  const out = {};
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (name.length < 1 || name.length > 80) {
      throw httpError(400, 'name must be between 1 and 80 characters');
    }
    out.name = name;
  } else if (!partial) {
    throw httpError(400, 'name is required');
  }
  if (input.description !== undefined) {
    const description = String(input.description ?? '');
    if (description.length > 500) throw httpError(400, 'description is too long');
    out.description = description;
  }
  if (input.config !== undefined) {
    out.config = normalizeConfig(input.config);
  } else if (!partial) {
    throw httpError(400, 'config is required');
  }
  return out;
}

export function getSpec(db, id) {
  return rowToSpec(db.prepare('SELECT * FROM specs WHERE id = ?').get(id));
}

export function requireSpec(db, id) {
  const spec = getSpec(db, id);
  if (!spec) throw httpError(404, `spec not found: ${id}`);
  return spec;
}

export function listSpecs(db) {
  return db.prepare('SELECT * FROM specs ORDER BY seq').all().map(rowToSpec);
}

export function getSpecState(db, specId) {
  const row = db.prepare('SELECT * FROM spec_state WHERE spec_id = ?').get(specId);
  if (!row) {
    return {
      specId,
      requiredSeq: 0,
      builtSeq: 0,
      lastBuildId: null,
      lastBuildStatus: null,
      lastBuildError: null,
      lastBuildAt: null,
      updatedAt: null,
    };
  }
  return {
    specId: row.spec_id,
    requiredSeq: Number(row.required_seq),
    builtSeq: Number(row.built_seq),
    lastBuildId: row.last_build_id,
    lastBuildStatus: row.last_build_status,
    lastBuildError: row.last_build_error,
    lastBuildAt: row.last_build_at,
    updatedAt: row.updated_at,
  };
}

export function ensureSpecState(db, specId) {
  db.prepare(
    `INSERT INTO spec_state (spec_id, required_seq, built_seq, updated_at)
     VALUES (?, 0, 0, ?)
     ON CONFLICT(spec_id) DO NOTHING`,
  ).run(specId, nowIso());
}

/**
 * Marks the spec as needing a rebuild at or beyond `seq`. Never lowers the bar:
 * a late, lower sequence says nothing about data a concurrent writer already
 * announced.
 */
export function markSpecDirty(db, specId, seq, detail = {}) {
  const at = nowIso();
  db.prepare(
    `INSERT INTO spec_state (spec_id, required_seq, built_seq, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(spec_id) DO UPDATE SET
       required_seq = MAX(required_seq, excluded.required_seq),
       updated_at = excluded.updated_at`,
  ).run(specId, seq, at);
  const state = getSpecState(db, specId);
  return state;
}

function bumpSpecSeq(db) {
  return Number(db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM specs').get().next);
}

function cryptoRandom() {
  return Math.random().toString(36).slice(2, 10);
}

export function createSpec(db, input, { source = 'web' } = {}) {
  const fields = validateSpecInput(input, { partial: false });
  const hash = configHash(fields.config);
  const at = nowIso();
  const id = `spec-${cryptoRandom()}`;
  return transaction(db, () => {
    const seq = bumpSpecSeq(db);
    const configVersion = 1;
    const cacheKey = cacheKeyFor(id, configVersion, hash);
    db.prepare(
      `INSERT INTO specs
         (id, seq, name, description, config_version, config_hash, config_json, cache_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      seq,
      fields.name,
      fields.description ?? '',
      configVersion,
      hash,
      canonicalJson(fields.config),
      cacheKey,
      at,
      at,
    );
    db.prepare(
      `INSERT INTO spec_versions (spec_id, config_version, config_hash, config_json, cache_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, configVersion, hash, canonicalJson(fields.config), cacheKey, at);
    ensureSpecState(db, id);
    const changeSeq = nextSequence(db);
    db.prepare(
      `INSERT INTO changes (seq, kind, spec_id, account_id, revision, detail, created_at)
       VALUES (?, 'spec-config', ?, NULL, NULL, ?, ?)`,
    ).run(changeSeq, id, canonicalJson({ configVersion, configHash: hash, source }), at);
    // A new spec must be materialized even if no records change later.
    markSpecDirty(db, id, changeSeq);
    db.prepare(
      `INSERT INTO outbox (seq, kind, spec_id, account_id, revision, payload, created_at)
       VALUES (?, 'spec-changed', ?, NULL, NULL, ?, ?)`,
    ).run(changeSeq, id, canonicalJson({ configVersion, configHash: hash }), at);
    return { spec: getSpec(db, id), changeSeq };
  });
}

/**
 * Any config change bumps configVersion and produces a brand new cache key,
 * even if the new config happens to hash back to a hash seen before. That
 * guarantees a stale builder can never publish into the namespace a reader
 * of the current version is reading.
 */
export function updateSpec(db, id, input, { source = 'web' } = {}) {
  const fields = validateSpecInput(input, { partial: true });
  const at = nowIso();
  return transaction(db, () => {
    const current = requireSpec(db, id);
    let nextVersion = current.configVersion;
    let nextHash = current.configHash;
    let nextConfig = current.config;
    let nextCacheKey = current.cacheKey;
    let configChanged = false;
    if (fields.config) {
      nextHash = configHash(fields.config);
      if (nextHash !== current.configHash) {
        configChanged = true;
        nextVersion = current.configVersion + 1;
        nextConfig = fields.config;
        nextCacheKey = cacheKeyFor(id, nextVersion, nextHash);
        db.prepare(
          `INSERT INTO spec_versions (spec_id, config_version, config_hash, config_json, cache_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, nextVersion, nextHash, canonicalJson(nextConfig), nextCacheKey, at);
      }
    }
    db.prepare(
      `UPDATE specs
          SET name = ?, description = ?, config_version = ?, config_hash = ?, config_json = ?,
              cache_key = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      fields.name ?? current.name,
      fields.description ?? current.description,
      nextVersion,
      nextHash,
      canonicalJson(nextConfig),
      nextCacheKey,
      at,
      id,
    );
    ensureSpecState(db, id);
    if (!configChanged) {
      return { spec: getSpec(db, id), changeSeq: null, configChanged: false };
    }
    const changeSeq = nextSequence(db);
    db.prepare(
      `INSERT INTO changes (seq, kind, spec_id, account_id, revision, detail, created_at)
       VALUES (?, 'spec-config', ?, NULL, NULL, ?, ?)`,
    ).run(
      changeSeq,
      id,
      canonicalJson({
        configVersion: nextVersion,
        previousConfigVersion: current.configVersion,
        configHash: nextHash,
        previousConfigHash: current.configHash,
        source,
      }),
      at,
    );
    markSpecDirty(db, id, changeSeq);
    db.prepare(
      `INSERT INTO outbox (seq, kind, spec_id, account_id, revision, payload, created_at)
       VALUES (?, 'spec-changed', ?, NULL, NULL, ?, ?)`,
    ).run(
      changeSeq,
      id,
      canonicalJson({
        configVersion: nextVersion,
        previousConfigVersion: current.configVersion,
        configHash: nextHash,
      }),
      at,
    );
    return { spec: getSpec(db, id), changeSeq, configChanged: true };
  });
}

export function specVersions(db, id) {
  return db
    .prepare('SELECT * FROM spec_versions WHERE spec_id = ? ORDER BY config_version DESC')
    .all(id)
    .map((row) => ({
      specId: row.spec_id,
      configVersion: Number(row.config_version),
      configHash: row.config_hash,
      config: JSON.parse(row.config_json),
      cacheKey: row.cache_key,
      createdAt: row.created_at,
    }));
}

export function catalogBody() {
  return { dimensions: dimensionCatalog(), measures: measureCatalog() };
}

export function specFingerprint(spec) {
  return sha256(
    canonicalJson({
      id: spec.id,
      configVersion: spec.configVersion,
      configHash: spec.configHash,
    }),
  );
}
