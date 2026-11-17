import crypto from 'node:crypto';
import { canonicalJson, httpError, nowIso } from '../lib/util.js';
import { isValidValue } from '../lib/dimensions.js';
import { nextSequence, transaction } from './schema.js';

export const EDITABLE_FIELDS = ['name', 'region', 'status', 'category', 'amountCents', 'notes'];
export const FIELD_LABELS = {
  name: '名称',
  region: '区域',
  status: '状态',
  category: '品类',
  amountCents: '金额（分）',
  notes: '备注',
};

export function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    status: row.status,
    category: row.category,
    amountCents: Number(row.amount_cents),
    notes: row.notes,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
  };
}

export function validateRecordPatch(patch, { partial }) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw httpError(400, 'record must be an object');
  }
  const allowed = new Set(EDITABLE_FIELDS);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) {
      throw httpError(400, `field is not editable: ${key}`);
    }
  }
  const out = {};
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (name.length < 1 || name.length > 120) {
      throw httpError(400, 'name must be between 1 and 120 characters');
    }
    out.name = name;
  } else if (!partial) {
    throw httpError(400, 'name is required');
  }
  if (patch.region !== undefined) {
    if (!isValidValue('region', patch.region)) throw httpError(400, 'invalid region');
    out.region = patch.region;
  } else if (!partial) {
    throw httpError(400, 'region is required');
  }
  if (patch.status !== undefined) {
    if (!isValidValue('status', patch.status)) throw httpError(400, 'invalid status');
    out.status = patch.status;
  } else if (!partial) {
    throw httpError(400, 'status is required');
  }
  if (patch.category !== undefined) {
    if (!isValidValue('category', patch.category)) throw httpError(400, 'invalid category');
    out.category = patch.category;
  } else if (!partial) {
    throw httpError(400, 'category is required');
  }
  if (patch.amountCents !== undefined) {
    const amount = Number(patch.amountCents);
    if (!Number.isInteger(amount) || amount < 0 || amount > 100_000_000_000) {
      throw httpError(400, 'amountCents must be a non-negative integer');
    }
    out.amountCents = amount;
  } else if (!partial) {
    throw httpError(400, 'amountCents is required');
  }
  if (patch.notes !== undefined) {
    const notes = String(patch.notes ?? '');
    if (notes.length > 2000) throw httpError(400, 'notes is too long');
    out.notes = notes;
  }
  return out;
}

export function snapshotOf(record) {
  return canonicalJson({
    name: record.name,
    region: record.region,
    status: record.status,
    category: record.category,
    amountCents: record.amountCents,
    notes: record.notes,
    deleted: Boolean(record.deletedAt),
  });
}

function enqueueOutbox(db, { seq, kind, specId = null, accountId = null, revision = null, payload }) {
  db.prepare(
    `INSERT INTO outbox (seq, kind, spec_id, account_id, revision, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(seq, kind, specId, accountId, revision, canonicalJson(payload), nowIso());
}

function insertHistory(db, record, changedFields, source, at) {
  db.prepare(
    `INSERT OR REPLACE INTO record_history
       (account_id, revision, snapshot, changed_fields, source, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(record.id, record.revision, snapshotOf(record), canonicalJson(changedFields), source, at);
}

function recordChange(db, record, action, changedFields, source, at) {
  const seq = nextSequence(db);
  db.prepare(
    `INSERT INTO changes (seq, kind, spec_id, account_id, revision, detail, created_at)
     VALUES (?, 'record', NULL, ?, ?, ?, ?)`,
  ).run(
    seq,
    record.id,
    record.revision,
    canonicalJson({ action, changedFields, source }),
    at,
  );
  enqueueOutbox(db, {
    seq,
    kind: 'records-changed',
    accountId: record.id,
    revision: record.revision,
    payload: { action, changedFields },
  });
  return seq;
}

export function listRecords(db, { includeDeleted = false } = {}) {
  const sql = includeDeleted
    ? 'SELECT * FROM accounts ORDER BY id'
    : 'SELECT * FROM accounts WHERE deleted_at IS NULL ORDER BY id';
  return db.prepare(sql).all().map(rowToRecord);
}

export function getRecord(db, id) {
  return rowToRecord(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
}

export function requireRecord(db, id) {
  const record = getRecord(db, id);
  if (!record || record.deletedAt) {
    throw httpError(404, `record not found: ${id}`);
  }
  return record;
}

export function listRecordHistory(db, id, limit = 50) {
  return db
    .prepare('SELECT * FROM record_history WHERE account_id = ? ORDER BY revision DESC LIMIT ?')
    .all(id, limit)
    .map((row) => ({
      accountId: row.account_id,
      revision: Number(row.revision),
      snapshot: JSON.parse(row.snapshot),
      changedFields: JSON.parse(row.changed_fields),
      source: row.source,
      recordedAt: row.recorded_at,
    }));
}

export function createRecord(db, input, { source = 'seed', id = undefined } = {}) {
  const fields = validateRecordPatch(input, { partial: false });
  const at = nowIso();
  const recordId = id ?? `acct-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
  return transaction(db, () => {
    if (getRecord(db, recordId)) {
      throw httpError(409, `record already exists: ${recordId}`);
    }
    db.prepare(
      `INSERT INTO accounts
         (id, name, region, status, category, amount_cents, notes, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      recordId,
      fields.name,
      fields.region,
      fields.status,
      fields.category,
      fields.amountCents,
      fields.notes ?? '',
      at,
      at,
    );
    const record = getRecord(db, recordId);
    const changedFields = Object.keys(fields);
    insertHistory(db, record, changedFields, source, at);
    const seq = recordChange(db, record, 'create', changedFields, source, at);
    return { record, seq, noop: false, changedFields };
  });
}

/**
 * Optimistic-concurrency revision update. `expectedRevision` is optional; when
 * supplied the write is rejected with 409 if the row moved on.
 */
export function updateRecord(db, id, patch, { source = 'web', expectedRevision } = {}) {
  const fields = validateRecordPatch(patch, { partial: true });
  const at = nowIso();
  return transaction(db, () => {
    const current = getRecord(db, id);
    if (!current) throw httpError(404, `record not found: ${id}`);
    if (current.deletedAt) throw httpError(409, `record is deleted: ${id}`);
    if (expectedRevision !== undefined && expectedRevision !== null) {
      const expected = Number(expectedRevision);
      if (!Number.isInteger(expected)) {
        throw httpError(400, 'expectedRevision must be an integer');
      }
      if (expected !== current.revision) {
        throw httpError(409, 'revision conflict: record changed since it was read', {
          expectedRevision: expected,
          actualRevision: current.revision,
          current,
        });
      }
    }
    const changedFields = [];
    for (const [key, value] of Object.entries(fields)) {
      const previous = key === 'amountCents' ? current.amountCents : current[key];
      if (previous !== value) changedFields.push(key);
    }
    if (changedFields.length === 0) {
      return { record: current, seq: null, noop: true, changedFields: [] };
    }
    db.prepare(
      `UPDATE accounts
          SET name = ?, region = ?, status = ?, category = ?, amount_cents = ?, notes = ?,
              revision = revision + 1, updated_at = ?
        WHERE id = ?`,
    ).run(
      fields.name ?? current.name,
      fields.region ?? current.region,
      fields.status ?? current.status,
      fields.category ?? current.category,
      fields.amountCents ?? current.amountCents,
      fields.notes ?? current.notes,
      at,
      id,
    );
    const record = getRecord(db, id);
    insertHistory(db, record, changedFields, source, at);
    const seq = recordChange(db, record, 'update', changedFields, source, at);
    return { record, seq, noop: false, changedFields };
  });
}

export function deleteRecord(db, id, { source = 'web', expectedRevision } = {}) {
  const at = nowIso();
  return transaction(db, () => {
    const current = getRecord(db, id);
    if (!current) throw httpError(404, `record not found: ${id}`);
    if (current.deletedAt) {
      return { record: current, seq: null, noop: true };
    }
    if (expectedRevision !== undefined && expectedRevision !== null) {
      if (Number(expectedRevision) !== current.revision) {
        throw httpError(409, 'revision conflict: record changed since it was read', {
          expectedRevision: Number(expectedRevision),
          actualRevision: current.revision,
          current,
        });
      }
    }
    db.prepare(
      'UPDATE accounts SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
    ).run(at, at, id);
    const record = getRecord(db, id);
    insertHistory(db, record, ['deleted'], source, at);
    const seq = recordChange(db, record, 'delete', ['deleted'], source, at);
    return { record, seq, noop: false, changedFields: ['deleted'] };
  });
}

export function recordBodyForClient(record) {
  return { ...record, snapshot: snapshotOf(record) };
}

export function recordEtag(record) {
  return `"r${record.revision}-${record.deletedAt ? 'd' : 'a'}"`;
}
