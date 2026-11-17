import { canonicalJson, httpError, nowIso, sha256 } from '../lib/util.js';
import { aggregate, outputDigest, specDigest } from '../lib/spec.js';
import { currentSequence } from '../db/schema.js';
import { getSpecState } from '../db/specs.js';
import {
  evaluateFreshness,
  makeVersionProof,
  readAllRecords,
  runAggregation,
} from './build-core.js';
import { relevantSourceDigest } from './dependencies.js';

/**
 * Read policy. Two independent checks protect readers:
 *
 * 1. Watermark (cheap, every read): the durable `requiredSeq` for the spec must
 *    be <= the `builtSeq` stamped into the artifact, and the artifact's
 *    namespace must equal the live config namespace. This catches every
 *    *delivered* invalidation, including losses on the builder side, because
 *    the watermark lives in the same transactional store as the records.
 *
 * 2. Full verify (expensive, bounded interval): re-aggregate from the source
 *    and compare digests. This is the backstop for an invalidation that never
 *    reached the database at all (e.g. a crashed writer after commit, or an
 *    out-of-band edit). A full verify result is cached per (spec, source
 *    version) so N readers cost one aggregation.
 *
 * `policy=strict` forces a full verify on every read. `policy=watermark`
 * refuses stale bytes but may serve stale-on-the-wire data until the verify
 * interval elapses. Freshness is never claimed without one of the two checks.
 */
export class ResultService {
  constructor({ db, store, builder = null, verifyIntervalMs = 2_000, clock = () => Date.now() }) {
    this.db = db;
    this.store = store;
    this.builder = builder;
    this.verifyIntervalMs = verifyIntervalMs;
    this.clock = clock;
    this.verifyMemo = new Map();
  }

  /**
   * Returns the materialized result with a version proof, or a structured
   * 'stale' response (never silently-stale bytes).
   */
  read(spec, { policy = 'watermark', autoRepair = true } = {}) {
    if (!['watermark', 'strict'].includes(policy)) {
      throw httpError(400, `unknown read policy: ${policy}`);
    }
    const artifact = this.store.readVerified(spec.id, spec.configVersion, spec.configHash);
    if (!artifact) {
      if (autoRepair && this.builder) {
        this.builder.requestBuild(spec.id, { reason: 'cache-miss' });
      }
      return {
        status: 'miss',
        reason: 'no-artifact',
        httpStatus: 503,
        specId: spec.id,
        configVersion: spec.configVersion,
        configHash: spec.configHash,
        repairScheduled: Boolean(autoRepair && this.builder),
      };
    }

    const proof = this.buildProof(spec, artifact, policy);
    if (proof.fresh) {
      return {
        status: 'fresh',
        httpStatus: 200,
        artifact,
        proof,
      };
    }

    if (autoRepair && this.builder) {
      this.builder.requestBuild(spec.id, { reason: `read-stale:${proof.staleReason}` });
    }
    return {
      status: 'stale',
      reason: proof.staleReason,
      httpStatus: 409,
      specId: spec.id,
      artifact,
      proof,
      repairScheduled: Boolean(autoRepair && this.builder),
    };
  }

  buildProof(spec, artifact, policy) {
    const proof = makeVersionProof(this.db, spec, artifact, {
      verifyLevel: policy === 'strict' ? 'live' : 'watermark',
    });
    if (!proof.fresh) return proof;

    const now = this.clock();
    const artifactKey = `${spec.id}|${spec.configVersion}|${spec.configHash}|${artifact.pointer.generation}`;
    const memo = this.verifyMemo.get(artifactKey);
    // If the invalidation log has unconsumed events, the durable watermark is
    // known to be behind: it cannot certify anything until those are applied.
    // This is what makes "notifications disconnected" fail closed immediately
    // instead of only after the verify interval.
    const lagging = this.invalidationLag();
    let needVerify;
    if (policy === 'strict' || lagging > 0) {
      needVerify = true;
    } else {
      const seq = currentSequence(this.db);
      needVerify =
        !memo ||
        now - memo.at > this.verifyIntervalMs ||
        memo.readSeq !== seq ||
        memo.sourceDigest !== proof.sourceDigest;
    }

    if (!needVerify && memo) {
      proof.verification = 'watermark+cached-verify';
      proof.verifiedAt = memo.verifiedAt;
      proof.fullDigestMatch = memo.match;
      if (!memo.match) {
        proof.fresh = false;
        proof.staleReason = 'full-verify-mismatch';
      }
      proof.proofHash = sha256(canonicalJson(proofForHash(proof)));
      return proof;
    }

    const records = readAllRecords(this.db);
    const deps = relevantSourceDigest(spec, records);
    const { result, outputDigest: digest } = runAggregation(spec, records);
    const match = digest === proof.outputDigest && deps.digest === proof.depsDigest;
    const verifiedAt = now;
    this.verifyMemo.set(artifactKey, {
      at: now,
      verifiedAt,
      readSeq: currentSequence(this.db),
      sourceDigest: proof.sourceDigest,
      match,
      digest,
      depsDigest: deps.digest,
      lagging,
    });
    proof.verification = lagging > 0 ? 'full:invalidation-lag' : 'full';
    proof.invalidationLag = lagging;
    proof.verifiedAt = new Date(verifiedAt).toISOString();
    proof.fullDigestMatch = match;
    proof.fresh = match;
    proof.staleReason = match ? null : 'full-verify-mismatch';
    if (!match) {
      proof.verifiedDigest = digest;
      proof.verifiedDepsDigest = deps.digest;
      proof.rowCount = result.rowCount;
    }
    proof.proofHash = sha256(canonicalJson(proofForHash(proof)));
    return proof;
  }

  /**
   * Number of outbox events the invalidation consumer has not applied yet.
   * Non-zero means the dirty marks are provably incomplete.
   */
  invalidationLag() {
    const cursor = Number(
      this.db.prepare("SELECT value FROM meta WHERE key = 'invalidator.outbox_cursor'").get()
        ?.value ?? 0,
    );
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM outbox WHERE id > ?')
      .get(cursor);
    return Number(row.n);
  }

  invalidateMemo() {
    this.verifyMemo.clear();
  }

  /**
   * Full verification endpoint: recompute and compare against the published
   * artifact, returning byte-level evidence.
   */
  verify(spec) {
    const artifact = this.store.readVerified(spec.id, spec.configVersion, spec.configHash);
    if (!artifact) {
      return {
        status: 'missing',
        ok: false,
        specId: spec.id,
        configVersion: spec.configVersion,
        configHash: spec.configHash,
      };
    }
    const records = readAllRecords(this.db);
    const deps = relevantSourceDigest(spec, records);
    const { result, outputDigest: digest } = runAggregation(spec, records);
    const proof = makeVersionProof(this.db, spec, artifact, { verifyLevel: 'live' });
    const checks = {
      artifactBytesIntact: artifact.dataHash === artifact.manifest.dataHash,
      outputDigestMatches:
        digest === artifact.manifest.build?.outputDigest &&
        digest === artifact.data.proof?.outputDigest,
      depsDigestMatches: deps.digest === artifact.manifest.build?.depsDigest,
      watermarkSatisfied:
        Number(getSpecState(this.db, spec.id).requiredSeq) <= Number(proof.builtSeq),
      configNamespaceCurrent:
        artifact.manifest.configVersion === spec.configVersion &&
        artifact.manifest.configHash === spec.configHash,
      proofFresh: evaluateFreshness(spec, proof, getSpecState(this.db, spec.id)).fresh,
    };
    const ok = Object.values(checks).every(Boolean);
    return {
      status: ok ? 'verified' : 'mismatch',
      ok,
      specId: spec.id,
      checks,
      proof: {
        ...proof,
        fresh: ok,
        staleReason: ok ? null : proof.staleReason ?? 'verify-mismatch',
        verification: 'live',
        fullDigestMatch: digest === proof.outputDigest,
      },
      live: {
        outputDigest: digest,
        depsDigest: deps.digest,
        rowCount: result.rowCount,
        matchedRecordCount: result.matchedRecordCount,
        rows: result.rows,
      },
      artifact: {
        generation: artifact.pointer.generation,
        dataHash: artifact.dataHash,
        bytes: artifact.bytes,
        outputDigest: artifact.manifest.build?.outputDigest,
        depsDigest: artifact.manifest.build?.depsDigest,
        rowCount: artifact.data.rowCount,
        createdAt: artifact.manifest.createdAt,
      },
    };
  }
}

function proofForHash(proof) {
  const {
    readSeq,
    verifyLevel,
    verification,
    verifiedAt,
    invalidationLag,
    fullDigestMatch,
    verifiedDigest,
    verifiedDepsDigest,
    staleReason,
    proofHash,
    ...rest
  } = proof;
  return rest;
}

export { currentSequence };
