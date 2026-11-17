import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  status TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS record_history (
  account_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  changed_fields TEXT NOT NULL,
  source TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (account_id, revision)
);

CREATE INDEX IF NOT EXISTS record_history_account ON record_history (account_id, revision);

CREATE TABLE IF NOT EXISTS specs (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  config_version INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  config_json TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spec_versions (
  spec_id TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  config_json TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (spec_id, config_version)
);

CREATE TABLE IF NOT EXISTS spec_state (
  spec_id TEXT PRIMARY KEY,
  required_seq INTEGER NOT NULL DEFAULT 0,
  built_seq INTEGER NOT NULL DEFAULT 0,
  last_build_id TEXT,
  last_build_status TEXT,
  last_build_error TEXT,
  last_build_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  generation INTEGER NOT NULL,
  requested_seq INTEGER NOT NULL,
  snapshot_seq INTEGER,
  built_seq INTEGER,
  status TEXT NOT NULL,
  superseded_by TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  published_at TEXT,
  data_hash TEXT,
  output_digest TEXT,
  rows INTEGER,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS builds_by_spec ON builds (spec_id, started_at);
CREATE INDEX IF NOT EXISTS builds_running ON builds (spec_id, status);

CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  config_version INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  data_hash TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL,
  received_bytes INTEGER,
  received_hash TEXT,
  status TEXT NOT NULL,
  superseded_reason TEXT,
  started_at TEXT NOT NULL,
  stream_started_at TEXT,
  finished_at TEXT,
  started_seq INTEGER NOT NULL,
  finished_seq INTEGER,
  current_generation_at_finish INTEGER,
  client_id TEXT
);

CREATE INDEX IF NOT EXISTS downloads_by_spec ON downloads (spec_id, started_at);

CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  spec_id TEXT,
  account_id TEXT,
  revision INTEGER,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  spec_id TEXT,
  account_id TEXT,
  revision INTEGER,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS outbox_spec ON outbox (spec_id, id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  spec_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS notifications_spec ON notifications (spec_id, id);
`;

export function openDatabase(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec(SCHEMA);
  return db;
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

export function nextSequence(db) {
  const row = db
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('last_seq', '1') " +
        "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) " +
        "RETURNING CAST(value AS INTEGER) AS seq",
    )
    .get();
  return Number(row.seq);
}

export function nextGeneration(db) {
  const row = db
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('last_generation', '1') " +
        "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) " +
        "RETURNING CAST(value AS INTEGER) AS gen",
    )
    .get();
  return Number(row.gen);
}

export function currentSequence(db) {
  return Number(getMeta(db, 'last_seq', '0'));
}

export function transaction(db, fn, { immediate = true } = {}) {
  db.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Surface the original error.
    }
    throw err;
  }
}

export function readSnapshot(db, fn) {
  db.exec('BEGIN');
  try {
    return fn();
  } finally {
    db.exec('COMMIT');
  }
}
