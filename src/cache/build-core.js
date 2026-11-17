import { canonicalJson, httpError, sha256 } from '../lib/util.js';
import { aggregate, outputDigest } from '../lib/spec.js';
import { currentSequence } from '../db/schema.js';
import { getSpecState, specBody } from '../db/specs.js';
import { dependencyFields, relevantSourceDigest } from './dependencies.js';

export function readAllRecords(db) {
  return db
    .prepare('SELECT * FROM accounts WHERE deleted_at IS NULL ORDER BY id')
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      region: row.region,
      status: row.status,
      category: row.category,
      amountCents: Number(row.amount_cents),
      notes: row.notes,
      revision: Number(row.revision),
    }));
}

export function computeSourceDigest(records) {
  const entries = records.map((record) =>
    canonicalJson({
      id: record.id,
      revision: record.revision,
      content: canonicalJson({
        name: record.name,
        region: record.region,
        status: record.status,
        category: record.category,
        amountCents: record.amountCents,
        notes: record.notes,
      }),
    }),
  );
  return {
    sourceDigest: sha256(entries.join('\n')),
    recordCount: records.length,
    revisionSum: records.reduce((sum, record) => sum + record.revision, 0),
  };
}

/**
 * Reads a consistent snapshot plus everything needed to describe it. SQLite
 * gives us a stable read view for the duration of one transaction, so records,
 * sequence and spec state cannot disagree with each other.
 */
export function snapshotForBuild(db, spec) {
  db.exec('BEGIN');
  try {
    const snapshotSeq = currentSequence(db);
    const records = readAllRecords(db);
    const source = computeSourceDigest(records);
    const deps = relevantSourceDigest(spec, records);
    const state = getSpecState(db, spec.id);
    return {
      snapshotSeq,
      records,
      sourceDigest: source.sourceDigest,
      recordCount: source.recordCount,
      depsDigest: deps.digest,
      relevantRecordCount: deps.relevantRecordCount,
      dependencyFields: deps.fields,
      requiredSeqAtSnapshot: state.requiredSeq,
    };
  } finally {
    db.exec('COMMIT');
  }
}

export function runAggregation(spec, records) {
  const result = aggregate(records, spec.config);
  return { result, outputDigest: outputDigest(result) };
}

/**
 * A proof is recomputed at read time from the authoritative tables, never
 * copied from whatever the builder happened to see.
 */
export function makeVersionProof(db, spec, artifact, { verifyLevel = 'watermark' } = {}) {
  const readSeq = currentSequence(db);
  const state = getSpecState(db, spec.id);
  const build = artifact.manifest.build ?? {};
  const proof = {
    kind: 'result-proof-v1',
    specId: spec.id,
    specName: spec.name,
    specDigest: specBody(spec).digest,
    configVersion: spec.configVersion,
    configHash: spec.configHash,
    cacheKey: spec.cacheKey,
    generation: Number(artifact.pointer.generation),
    buildId: build.buildId ?? artifact.manifest.generation,
    snapshotSeq: build.snapshotSeq ?? null,
    builtSeq: build.builtSeq ?? null,
    sourceDigest: build.sourceDigest ?? null,
    depsDigest: build.depsDigest ?? artifact.manifest.depsDigest ?? null,
    outputDigest: build.outputDigest ?? null,
    dataHash: artifact.dataHash,
    rowCount: artifact.data?.rowCount ?? null,
    readSeq,
    requiredSeq: state.requiredSeq,
    watermarkBuiltSeq: state.builtSeq,
    fresh: false,
    verifyLevel,
    staleReason: null,
  };
  const freshness = evaluateFreshness(spec, proof, state);
  proof.fresh = freshness.fresh;
  proof.staleReason = freshness.reason;
  proof.proofHash = sha256(canonicalJson(proofForHash(proof)));
  return proof;
}

function proofForHash(proof) {
  const { readSeq, verifyLevel, staleReason, ...rest } = proof;
  return rest;
}

export function evaluateFreshness(spec, proof, state) {
  if (proof.configVersion !== spec.configVersion) {
    return { fresh: false, reason: 'config-version-changed' };
  }
  if (proof.configHash !== spec.configHash) {
    return { fresh: false, reason: 'config-hash-changed' };
  }
  if (proof.builtSeq === null || proof.builtSeq === undefined) {
    return { fresh: false, reason: 'unbuilt' };
  }
  if (Number(state.requiredSeq) > Number(proof.builtSeq)) {
    return { fresh: false, reason: 'source-watermark-ahead' };
  }
  if (Number(proof.requiredSeq) > Number(proof.builtSeq)) {
    return { fresh: false, reason: 'source-watermark-ahead' };
  }
  if (Number(state.builtSeq) !== Number(proof.builtSeq)) {
    return { fresh: false, reason: 'newer-artifact-exists' };
  }
  return { fresh: true, reason: null };
}

export function fullVerify(db, spec) {
  const snapshot = snapshotForBuild(db, spec);
  const { result, outputDigest: digest } = runAggregation(spec, snapshot.records);
  return {
    digest,
    depsDigest: snapshot.depsDigest,
    result,
    snapshotSeq: snapshot.snapshotSeq,
  };
}

export function assertFreshness(proof, { allowStale = false, context }) {
  if (proof.fresh || allowStale) return;
  throw httpError(409, 'materialized result is stale relative to source records', {
    context,
    proof,
  });
}

export { dependencyFields };
