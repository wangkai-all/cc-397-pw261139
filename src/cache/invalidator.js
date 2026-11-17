import { canonicalJson, nowIso } from '../lib/util.js';
import { getSpecState, listSpecs, markSpecDirty } from '../db/specs.js';
import { getMeta, setMeta, transaction } from '../db/schema.js';
import { recordChangeAffectsSpec } from './dependencies.js';

const CURSOR_KEY = 'invalidator.outbox_cursor';

/**
 * Reconstructs the before/after record snapshots for a history revision. The
 * invalidation decision is made from actual data, not from a field list the
 * writer supplied, so it stays correct when a writer forgets to declare what
 * it changed.
 */
function revisionsFor(db, accountId, revision) {
  const afterRow = db
    .prepare('SELECT * FROM record_history WHERE account_id = ? AND revision = ?')
    .get(accountId, revision);
  const beforeRow = db
    .prepare(
      'SELECT * FROM record_history WHERE account_id = ? AND revision < ? ORDER BY revision DESC LIMIT 1',
    )
    .get(accountId, revision);
  return {
    before: beforeRow ? normalizeSnapshot(JSON.parse(beforeRow.snapshot)) : null,
    after: afterRow ? normalizeSnapshot(JSON.parse(afterRow.snapshot)) : null,
  };
}

function normalizeSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    name: snapshot.name,
    region: snapshot.region,
    status: snapshot.status,
    category: snapshot.category,
    amountCents: snapshot.amountCents,
    notes: snapshot.notes,
    deleted: Boolean(snapshot.deleted),
  };
}

/**
 * The invalidation consumer. It runs separately from the builder and the
 * result service and consumes the durable outbox. A crash resumes from the
 * persisted cursor, so each event is applied exactly once; a lost notification
 * is detectable at read time because the watermark is durable and the read
 * path can full-verify.
 */
export class Invalidator {
  constructor({ db, builder = null, notify = null, lossRate = 0 } = {}) {
    this.db = db;
    this.builder = builder;
    this.notify = notify;
    this.lossRate = lossRate;
    this.paused = false;
    this.stats = { processed: 0, dropped: 0, invalidations: 0 };
  }

  /**
   * Simulates a cut notification channel: the consumer stops applying events.
   * The source writes keep appending to the durable outbox, so nothing is lost
   * from the log itself — only the derived dirty marks are missed, which is
   * exactly the failure mode the read path must survive.
   */
  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  getCursor() {
    return Number(getMeta(this.db, CURSOR_KEY, '0'));
  }

  setCursor(value) {
    setMeta(this.db, CURSOR_KEY, value);
  }

  /**
   * Processes all pending events. `simulateDrop` consumes the batch *without*
   * applying it — the deliberate total notification loss used by tests and by
   * the "disconnect notifications" button in the UI.
   */
  tick({ simulateDrop = false } = {}) {
    if (this.paused && !simulateDrop) return [];
    const cursor = this.getCursor();
    const rows = this.db
      .prepare('SELECT * FROM outbox WHERE id > ? ORDER BY id LIMIT 500')
      .all(cursor);
    const results = [];
    for (const row of rows) {
      const dropped = simulateDrop || (this.lossRate > 0 && Math.random() < this.lossRate);
      const outcome = this.applyEvent(row, { dropped });
      if (dropped) this.stats.dropped += 1;
      else this.stats.processed += 1;
      results.push(outcome);
      this.setCursor(Number(row.id));
    }
    if (!simulateDrop && rows.length > 0) {
      // Idempotent recovery: any spec whose durable watermark is behind gets a
      // build requested, even if its individual event was lost.
      this.sweep();
    }
    return results;
  }

  /**
   * Watermark sweep: repairs invalidation loss by comparing each spec's
   * required sequence with its built sequence. Runs on every tick and on a
   * timer in `server.js`.
   */
  sweep() {
    const repaired = [];
    for (const spec of listSpecs(this.db)) {
      const state = getSpecState(this.db, spec.id);
      if (state.requiredSeq > state.builtSeq && this.builder) {
        this.builder.requestBuild(spec.id, { seq: state.requiredSeq, reason: 'watermark-sweep' });
        repaired.push(spec.id);
      }
    }
    return repaired;
  }

  applyEvent(row, { dropped }) {
    const seq = Number(row.seq);
    const payload = JSON.parse(row.payload);
    if (row.kind === 'records-changed') {
      const { before, after } = revisionsFor(this.db, row.account_id, Number(row.revision));
      const affected = [];
      const ignored = [];
      for (const spec of listSpecs(this.db)) {
        const decision = recordChangeAffectsSpec(spec, before, after);
        if (decision.affected) {
          affected.push({
            specId: spec.id,
            reason: decision.reason,
            fields: decision.fields ?? null,
          });
        } else {
          ignored.push({ specId: spec.id, reason: decision.reason });
        }
      }
      if (!dropped) {
        transaction(this.db, () => {
          for (const item of affected) markSpecDirty(this.db, item.specId, seq);
        });
        for (const item of affected) {
          if (this.builder) {
            this.builder.requestBuild(item.specId, {
              seq,
              reason: `record:${row.account_id}@r${row.revision}`,
            });
          }
          const notification = {
            changeSeq: seq,
            kind: 'cache-invalidated',
            specId: item.specId,
            payload: {
              accountId: row.account_id,
              revision: Number(row.revision),
              action: payload.action,
              changedFields: payload.changedFields,
              reason: item.reason,
              requiredSeq: seq,
            },
          };
          this.recordNotification(notification);
        }
        this.stats.invalidations += affected.length;
      }
      return { outboxId: Number(row.id), kind: row.kind, seq, affected, ignored, dropped };
    }

    if (row.kind === 'spec-changed') {
      if (!dropped) {
        markSpecDirty(this.db, row.spec_id, seq);
        if (this.builder) this.builder.requestBuild(row.spec_id, { seq, reason: 'spec-config' });
        this.recordNotification({
          changeSeq: seq,
          kind: 'spec-config-changed',
          specId: row.spec_id,
          payload,
        });
        this.stats.invalidations += 1;
      }
      return {
        outboxId: Number(row.id),
        kind: row.kind,
        seq,
        affected: [{ specId: row.spec_id }],
        dropped,
      };
    }

    return { outboxId: Number(row.id), kind: row.kind, seq, dropped };
  }

  recordNotification({ changeSeq, kind, specId, payload }) {
    const row = this.db
      .prepare(
        `INSERT INTO notifications (change_seq, kind, spec_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(changeSeq, kind, specId, canonicalJson(payload), nowIso());
    if (this.notify) this.notify(notificationRow(row));
    return row;
  }
}

export function notificationRow(row) {
  return {
    id: Number(row.id),
    changeSeq: Number(row.change_seq),
    kind: row.kind,
    specId: row.spec_id,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
  };
}

export function listNotifications(db, { afterId = 0, specId = null, limit = 200 } = {}) {
  const params = [afterId];
  let sql = 'SELECT * FROM notifications WHERE id > ?';
  if (specId) {
    sql += ' AND spec_id = ?';
    params.push(specId);
  }
  sql += ' ORDER BY id LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params).map(notificationRow);
}
