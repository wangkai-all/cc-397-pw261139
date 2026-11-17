import fs from 'node:fs';
import path from 'node:path';
import { nowIso, sha256, sleep } from '../lib/util.js';
import { specDigest } from '../lib/spec.js';
import { currentSequence, nextGeneration, transaction } from '../db/schema.js';
import {
  ensureSpecState,
  getSpec,
  getSpecState,
  listSpecs,
  markSpecDirty,
  specBody,
} from '../db/specs.js';
import { runAggregation, snapshotForBuild } from './build-core.js';

function buildRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    specId: row.spec_id,
    configVersion: Number(row.config_version),
    configHash: row.config_hash,
    generation: Number(row.generation),
    requestedSeq: Number(row.requested_seq),
    snapshotSeq: row.snapshot_seq === null ? null : Number(row.snapshot_seq),
    builtSeq: row.built_seq === null ? null : Number(row.built_seq),
    status: row.status,
    supersededBy: row.superseded_by,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    publishedAt: row.published_at,
    dataHash: row.data_hash,
    outputDigest: row.output_digest,
    rows: row.rows === null ? null : Number(row.rows),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  };
}

export function getBuild(db, id) {
  return buildRow(db.prepare('SELECT * FROM builds WHERE id = ?').get(id));
}

export function listBuilds(db, specId, limit = 20) {
  return db
    .prepare('SELECT * FROM builds WHERE spec_id = ? ORDER BY generation DESC LIMIT ?')
    .all(specId, limit)
    .map(buildRow);
}

/**
 * Multiple builder processes may run concurrently against the same database
 * and artifact root. They are kept correct by two rules:
 *   - every build takes a globally increasing generation before it snapshots;
 *   - publication only happens if no *newer* generation has published yet.
 * So expensive work runs in parallel, while the served bytes always belong to
 * the newest completed build.
 */
export function reapOrphanBuilds(db) {
  const stuck = db.prepare("SELECT id, spec_id FROM builds WHERE status = 'running'").all();
  if (stuck.length === 0) return 0;
  const at = nowIso();
  db.prepare(
    `UPDATE builds
        SET status = 'aborted', error = 'builder restarted before publish', finished_at = ?
      WHERE status = 'running'`,
  ).run(at);
  return stuck.length;
}

/**
 * One builder instance. Work is serialized per spec inside a process, and the
 * partial unique index `builds_one_running` enforces it across processes.
 */
export class CacheBuilder {
  constructor({ db, store, hooks = {}, delays = {}, failureBackoffMs = 1500 } = {}) {
    this.db = db;
    this.store = store;
    this.hooks = hooks;
    this.delays = {
      afterSnapshotMs: Number(delays.afterSnapshotMs ?? 0),
      publishMs: Number(delays.publishMs ?? 0),
    };
    this.failureBackoffMs = failureBackoffMs;
    this.failures = new Map();
    this.running = new Set();
    this.pumpPromise = null;
    this.closed = false;
  }

  /**
   * Push path: an invalidation (or a read-path fallback) marks the watermark
   * and wakes the pump. Idempotent; `requiredSeq` never moves backwards.
   */
  requestBuild(specId, { seq = null, reason = 'requested' } = {}) {
    const spec = getSpec(this.db, specId);
    if (!spec) return { ok: false, reason: 'unknown-spec' };
    ensureSpecState(this.db, specId);
    const at = seq ?? currentSequence(this.db);
    markSpecDirty(this.db, specId, at);
    this.noteInvalidation(specId, at, reason);
    this.schedulePump();
    return { ok: true, specId, seq: at, reason };
  }

  noteInvalidation(specId, seq, reason) {
    this.db
      .prepare(
        `INSERT INTO outbox (seq, kind, spec_id, account_id, revision, payload, created_at)
         VALUES (?, 'invalidation', ?, NULL, NULL, ?, ?)`,
      )
      .run(seq, specId, JSON.stringify({ reason, seq }), nowIso());
  }

  schedulePump() {
    if (this.closed || this.pumpPromise) return this.pumpPromise;
    this.pumpPromise = this.pumpLoop().finally(() => {
      this.pumpPromise = null;
    });
    return this.pumpPromise;
  }

  async pumpLoop() {
    while (!this.closed) {
      let didWork = false;
      for (const spec of listSpecs(this.db)) {
        if (this.closed) return;
        const state = getSpecState(this.db, spec.id);
        const blockedUntil = this.failures.get(spec.id) ?? 0;
        if (blockedUntil > Date.now()) continue;
        if (state.requiredSeq <= state.builtSeq && this.hasServiceableArtifact(spec)) continue;
        if (this.running.has(spec.id)) continue;
        didWork = true;
        const outcome = await this.runOnce(spec.id, { reason: 'invalidation' });
        if (!outcome.ok && outcome.reason === 'failed') {
          // Do not spin on a permanently failing build; the read path and the
          // manual build endpoint can still retry explicitly.
          this.failures.set(spec.id, Date.now() + this.failureBackoffMs);
        } else {
          this.failures.delete(spec.id);
        }
      }
      if (!didWork) return;
      await sleep(0);
    }
  }

  hasServiceableArtifact(spec) {
    return Boolean(this.store.readVerified(spec.id, spec.configVersion, spec.configHash));
  }

  async idle() {
    while (this.pumpPromise) {
      await this.pumpPromise;
    }
  }

  /**
   * Runs one build attempt. If the same spec is already being built, returns
   * `busy`: the in-flight build finishes, then the pump rebuilds with the newer
   * watermark. That is the "revise while rebuilding" path.
   */
  async runOnce(specId, { reason = 'manual', simulate = {} } = {}) {
    if (this.running.has(specId)) {
      return { ok: false, reason: 'busy', specId };
    }
    this.running.add(specId);
    try {
      return await this.executeBuild(specId, { reason, simulate });
    } finally {
      this.running.delete(specId);
      if (!this.closed) this.schedulePump();
    }
  }

  async executeBuild(specId, { reason, simulate }) {
    const spec = getSpec(this.db, specId);
    if (!spec) return { ok: false, reason: 'unknown-spec' };
    ensureSpecState(this.db, specId);
    const startedAt = nowIso();
    const startedMs = Date.now();
    const generation = nextGeneration(this.db);
    const buildId = `build-${specId}-g${generation}`;
    const requestedSeq = getSpecState(this.db, specId).requiredSeq;

    try {
      this.db
        .prepare(
          `INSERT INTO builds
             (id, spec_id, config_version, config_hash, generation, requested_seq, status, started_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
        )
        .run(
          buildId,
          specId,
          spec.configVersion,
          spec.configHash,
          generation,
          requestedSeq,
          startedAt,
        );
    } catch (err) {
      throw err;
    }

    try {
      const snapshot = snapshotForBuild(this.db, spec);
      if (simulate.failWith) throw new Error(simulate.failWith);
      if (this.delays.afterSnapshotMs) await sleep(this.delays.afterSnapshotMs);
      if (simulate.afterSnapshotDelayMs) await sleep(simulate.afterSnapshotDelayMs);

      const { result, outputDigest } = runAggregation(spec, snapshot.records);

      // A config edit during the build retargets the live namespace. This build
      // stays in the namespace it started in, and may not advance the live
      // watermark because its bytes no longer describe the current config.
      const live = getSpec(this.db, specId);
      const sameConfig =
        Boolean(live) &&
        live.configVersion === spec.configVersion &&
        live.configHash === spec.configHash;

      const buildInfo = {
        buildId,
        generation,
        specId,
        specDigest: specDigest(spec),
        configVersion: spec.configVersion,
        configHash: spec.configHash,
        cacheKey: spec.cacheKey,
        snapshotSeq: snapshot.snapshotSeq,
        builtSeq: snapshot.snapshotSeq,
        requiredSeqAtStart: requestedSeq,
        sourceDigest: snapshot.sourceDigest,
        depsDigest: snapshot.depsDigest,
        outputDigest,
        recordCount: snapshot.recordCount,
        relevantRecordCount: snapshot.relevantRecordCount,
        dependencyFields: snapshot.dependencyFields,
        resultRowCount: result.rowCount,
        startedAt,
        durationMs: null,
      };
      const payload = JSON.stringify({
        kind: 'materialized-aggregate-v2',
        proof: buildInfo,
        columns: result.columns,
        columnLabels: result.columnLabels,
        rows: result.rows,
        rowCount: result.rowCount,
        matchedRecordCount: result.matchedRecordCount,
      });
      const dataHash = sha256(payload);

      if (this.delays.publishMs) await sleep(this.delays.publishMs);
      if (simulate.publishDelayMs) await sleep(simulate.publishDelayMs);

      const outcome = this.publishArtifact({ spec, generation, buildInfo, payload });
      const finishedAt = nowIso();

      if (!outcome.published) {
        this.db
          .prepare(
            `UPDATE builds
                SET status = 'superseded', superseded_by = ?, snapshot_seq = ?, built_seq = ?,
                    finished_at = ?, data_hash = ?, output_digest = ?, rows = ?, duration_ms = ?
              WHERE id = ? AND status = 'running'`,
          )
          .run(
            outcome.supersededBy,
            snapshot.snapshotSeq,
            snapshot.snapshotSeq,
            finishedAt,
            dataHash,
            outputDigest,
            result.rowCount,
            Date.now() - startedMs,
            buildId,
          );
        return {
          ok: false,
          reason: 'superseded',
          buildId,
          supersededBy: outcome.supersededBy,
          snapshotSeq: snapshot.snapshotSeq,
        };
      }

      const finalized = transaction(this.db, () => {
        const state = getSpecState(this.db, specId);
        const advance = sameConfig && snapshot.snapshotSeq >= state.builtSeq;
        this.db
          .prepare(
            `UPDATE builds
                SET status = 'published', snapshot_seq = ?, built_seq = ?, finished_at = ?,
                    published_at = ?, data_hash = ?, output_digest = ?, rows = ?, duration_ms = ?
              WHERE id = ? AND status = 'running'`,
          )
          .run(
            snapshot.snapshotSeq,
            snapshot.snapshotSeq,
            finishedAt,
            finishedAt,
            dataHash,
            outputDigest,
            result.rowCount,
            Date.now() - startedMs,
            buildId,
          );
        if (advance) {
          this.db
            .prepare(
              `UPDATE spec_state
                  SET built_seq = ?, last_build_id = ?, last_build_status = 'published',
                      last_build_error = NULL, last_build_at = ?, updated_at = ?
                WHERE spec_id = ?`,
            )
            .run(snapshot.snapshotSeq, buildId, finishedAt, finishedAt, specId);
        } else {
          this.db
            .prepare(
              `UPDATE spec_state
                  SET last_build_id = ?, last_build_status = ?, last_build_at = ?, updated_at = ?
                WHERE spec_id = ?`,
            )
            .run(
              buildId,
              sameConfig ? 'superseded' : 'historical-config',
              finishedAt,
              finishedAt,
              specId,
            );
        }
        return { state: getSpecState(this.db, specId), advanced: advance };
      });

      if (this.hooks.onPublished) {
        this.hooks.onPublished({
          specId,
          buildId,
          generation,
          configVersion: spec.configVersion,
          configHash: spec.configHash,
          outputDigest,
          advanced: finalized.advanced,
          event: 'published',
        });
      }
      return {
        ok: true,
        buildId,
        generation,
        builtSeq: snapshot.snapshotSeq,
        outputDigest,
        rows: result.rowCount,
        advanced: finalized.advanced,
        stillStale: finalized.state.requiredSeq > finalized.state.builtSeq,
      };
    } catch (err) {
      const finishedAt = nowIso();
      this.db
        .prepare(
          `UPDATE builds
              SET status = 'failed', error = ?, finished_at = ?, duration_ms = ?
            WHERE id = ? AND status = 'running'`,
        )
        .run(String(err.message), finishedAt, Date.now() - startedMs, buildId);
      this.db
        .prepare(
          `UPDATE spec_state
              SET last_build_id = ?, last_build_status = 'failed', last_build_error = ?, updated_at = ?
            WHERE spec_id = ?`,
        )
        .run(buildId, String(err.message), finishedAt, specId);
      if (this.hooks.onFailed) this.hooks.onFailed({ specId, buildId, error: err });
      return { ok: false, reason: 'failed', error: String(err.message), buildId };
    }
  }

  /**
   * Publishes only if this build is genuinely newer than what is already
   * published. "Newer" means a later snapshot sequence: a build that started
   * earlier but finished later must not replace bytes computed from more recent
   * data. Generation numbers are a tie-breaker so two builds of the same
   * snapshot still resolve deterministically.
   *
   * The check and the pointer flip happen under a file lock shared by all
   * builder processes, so two builders cannot both publish.
   */
  publishArtifact({ spec, generation, buildInfo, payload }) {
    const versionDir = this.store.versionDir(spec.id, spec.configVersion, spec.configHash);
    fs.mkdirSync(versionDir, { recursive: true });
    const release = acquireLock(path.join(versionDir, '.publish.lock'));
    try {
      const pointer = this.store.readCurrentPointer(
        spec.id,
        spec.configVersion,
        spec.configHash,
      );
      if (pointer) {
        const currentSeq = Number(pointer.snapshotSeq ?? pointer.builtSeq ?? -1);
        const candidateSeq = Number(buildInfo.snapshotSeq);
        const currentGen = Number(pointer.generation);
        if (
          currentSeq > candidateSeq ||
          (currentSeq === candidateSeq && currentGen >= Number(generation))
        ) {
          return { published: false, supersededBy: currentGen };
        }
      }
      this.store.publish({
        specId: spec.id,
        configVersion: spec.configVersion,
        configHash: spec.configHash,
        generation,
        build: { ...buildInfo, durationMs: null },
        data: payload,
      });
      return { published: true, supersededBy: null };
    } finally {
      release();
    }
  }

  close() {
    this.closed = true;
  }
}

function acquireLock(lockPath) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return () => {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // ignore
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const stat = safeStat(lockPath);
      // Only break a lock whose holder is clearly gone; never steal a live one.
      if (stat && Date.now() - stat.mtimeMs > 60_000) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`publish lock timeout: ${lockPath}`);
      }
      sleepSync(20);
    }
  }
}

function sleepSync(ms) {
  // Blocking sleep without a busy loop; this only guards a millisecond-scale
  // filesystem critical section, never a network call.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

export { specBody };
