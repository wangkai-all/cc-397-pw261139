import { canonicalJson, httpError, nowIso, randomId, sha256 } from '../lib/util.js';
import { currentSequence } from '../db/schema.js';

/**
 * Server side of the download cache.
 *
 * Protocol:
 *   1. Client POSTs /downloads {specId, generation?} and receives the exact
 *      artifact metadata (generation, dataHash, configVersion, configHash,
 *      expectedBytes) it is about to fetch.
 *   2. Client streams GET /downloads/:id/file.
 *   3. Client POSTs /downloads/:id/complete {receivedHash, receivedBytes}.
 *      The server re-reads the artifact, re-verifies bytes, and rejects the
 *      download if the artifact moved on while it was in flight.
 *
 * The server never trusts the client's claim that it downloaded "the latest".
 * Every download is pinned to a generation, so a result read after the
 * download can check `downloadedGeneration >= servedGeneration`.
 */
export class DownloadService {
  constructor({ db, store, now = nowIso }) {
    this.db = db;
    this.store = store;
    this.now = now;
  }

  create(spec, { generation = null, clientId = null } = {}) {
    const pointer = this.store.readCurrentPointer(spec.id, spec.configVersion, spec.configHash);
    if (!pointer) {
      throw httpError(503, 'no published artifact for this spec', {
        specId: spec.id,
        configVersion: spec.configVersion,
      });
    }
    const requested = generation === null ? Number(pointer.generation) : Number(generation);
    if (!Number.isInteger(requested) || requested <= 0) {
      throw httpError(400, 'generation must be a positive integer');
    }
    const dir = this.store.generationDir(
      spec.id,
      spec.configVersion,
      spec.configHash,
      requested,
    );
    const manifest = this.store.readGenerationManifest(
      spec.id,
      spec.configVersion,
      spec.configHash,
      requested,
    );
    if (!manifest) {
      throw httpError(404, `generation not found: ${requested}`, { dir, generation: requested });
    }
    const id = `dl-${randomId()}`;
    const at = this.now();
    const startedSeq = currentSequence(this.db);
    this.db
      .prepare(
        `INSERT INTO downloads
           (id, spec_id, generation, config_version, config_hash, data_hash, expected_bytes,
            status, started_at, started_seq, client_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        spec.id,
        requested,
        spec.configVersion,
        spec.configHash,
        manifest.dataHash,
        manifest.dataBytes,
        at,
        startedSeq,
        clientId,
      );
    return {
      id,
      specId: spec.id,
      generation: requested,
      currentGeneration: Number(pointer.generation),
      configVersion: spec.configVersion,
      configHash: spec.configHash,
      dataHash: manifest.dataHash,
      expectedBytes: manifest.dataBytes,
      buildId: manifest.build?.buildId ?? null,
      outputDigest: manifest.build?.outputDigest ?? null,
      startedSeq,
      status: 'pending',
      downloadUrl: `/api/downloads/${id}/file`,
      file: manifest.dataFile,
    };
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
    return row ? rowToDownload(row) : null;
  }

  /**
   * Persisted stream progress, so a reconnecting client can resume.
   */
  recordProgress(id, receivedBytes) {
    this.db
      .prepare('UPDATE downloads SET received_bytes = ? WHERE id = ? AND status = ?')
      .run(Number(receivedBytes), id, 'streaming');
    return this.get(id);
  }

  /** Client aborts or connection drops: keep it resumable, not corrupt. */
  markInterrupted(id) {
    this.db
      .prepare(
        "UPDATE downloads SET status = 'interrupted', finished_at = ? WHERE id = ? AND status = 'streaming'",
      )
      .run(this.now(), id);
    return this.get(id);
  }

  resume(id) {
    const download = this.get(id);
    if (!download) throw httpError(404, `download not found: ${id}`);
    if (!['interrupted', 'streaming'].includes(download.status)) {
      throw httpError(409, `download is not resumable (status=${download.status})`, { download });
    }
    // Resuming is only coherent against the same generation. If the artifact
    // moved on, the client must start a new download at the new generation.
    const pointer = this.store.readCurrentPointer(
      download.specId,
      download.configVersion,
      download.configHash,
    );
    const currentGeneration = pointer ? Number(pointer.generation) : null;
    if (currentGeneration !== null && currentGeneration > download.generation) {
      this.markSuperseded(id, 'newer-generation-published');
      throw httpError(409, 'download was superseded mid-flight', {
        download: this.get(id),
        currentGeneration,
      });
    }
    this.db
      .prepare("UPDATE downloads SET status = 'streaming', finished_at = NULL WHERE id = ?")
      .run(id);
    return this.get(id);
  }

  /**
   * Streams the pinned generation's data file. Serving the pinned generation
   * (not whatever is current) is what makes an in-flight download coherent:
   * an invalidation mid-download does not splice two versions together.
   */
  openPinned(id) {
    const download = this.get(id);
    if (!download) throw httpError(404, `download not found: ${id}`);
    if (download.status === 'superseded') {
      throw httpError(409, 'download was superseded mid-flight', { download });
    }
    const manifest = this.store.readGenerationManifest(
      download.specId,
      download.configVersion,
      download.configHash,
      download.generation,
    );
    if (!manifest) {
      throw httpError(410, 'the pinned generation is no longer on disk', { download });
    }
    if (manifest.dataHash !== download.dataHash) {
      throw httpError(410, 'the pinned generation changed under the download', { download });
    }
    const file = this.store.generationDataPath(
      download.specId,
      download.configVersion,
      download.configHash,
      download.generation,
      manifest.dataFile,
    );
    return { download, manifest, file };
  }

  /**
   * Marks the download as actually started. Called when the file response is
   * about to be written, so a download created but never fetched is not
   * mistaken for a completed one.
   */
  markStreaming(id) {
    const at = this.now();
    this.db
      .prepare(
        "UPDATE downloads SET status = 'streaming', stream_started_at = ? WHERE id = ? AND status IN ('pending','streaming')",
      )
      .run(at, id);
    return this.get(id);
  }

  /**
   * Client completion. The server:
   *  - recomputes the hash of the bytes it can see,
   *  - requires the client hash to equal the pinned hash,
   *  - requires the delivered length to equal the manifest length,
   *  - flags the download as superseded if a newer generation was published
   *    while the bytes were in flight. Superseded downloads are *not* rejected
   *    as corrupt: they are honest about being an older version, and the
   *    client must re-download before claiming freshness.
   */
  complete(id, { receivedHash = null, receivedBytes = null } = {}) {
    const download = this.get(id);
    if (!download) throw httpError(404, `download not found: ${id}`);
    if (download.status === 'complete') {
      return { ...download, idempotent: true };
    }
    if (download.status === 'superseded' && download.receivedBytes === null) {
      // Abandoned before any bytes were served: nothing to accept.
      throw httpError(409, 'download was superseded before it started', { download });
    }
    const manifest = this.store.readGenerationManifest(
      download.specId,
      download.configVersion,
      download.configHash,
      download.generation,
    );
    if (!manifest) {
      this.markSuperseded(id, 'generation-missing');
      throw httpError(410, 'the pinned generation is no longer on disk', { download });
    }
    const fileBytes = this.store.readGenerationData(
      download.specId,
      download.configVersion,
      download.configHash,
      download.generation,
      manifest.dataFile,
    );
    const actualHash = sha256(fileBytes);
    const lengthOk = fileBytes.length === download.expectedBytes;
    const hashOk = actualHash === download.dataHash;
    if (receivedHash && receivedHash !== download.dataHash) {
      this.fail(id, 'client-hash-mismatch');
      throw httpError(422, 'client reported a hash that does not match the pinned artifact', {
        expected: download.dataHash,
        received: receivedHash,
      });
    }
    if (receivedBytes !== null && Number(receivedBytes) !== download.expectedBytes) {
      this.fail(id, 'client-length-mismatch');
      throw httpError(422, 'client reported a length that does not match the pinned artifact', {
        expected: download.expectedBytes,
        received: Number(receivedBytes),
      });
    }
    if (!lengthOk || !hashOk) {
      this.fail(id, 'artifact-corrupt');
      throw httpError(500, 'published artifact failed integrity verification', {
        actualHash,
        expectedHash: download.dataHash,
        actualBytes: fileBytes.length,
        expectedBytes: download.expectedBytes,
      });
    }

    const pointer = this.store.readCurrentPointer(
      download.specId,
      download.configVersion,
      download.configHash,
    );
    const currentGeneration = pointer ? Number(pointer.generation) : null;
    const superseded = currentGeneration !== null && currentGeneration > download.generation;
    const at = this.now();
    const finishedSeq = currentSequence(this.db);
    this.db
      .prepare(
        `UPDATE downloads
            SET status = ?, received_bytes = ?, received_hash = ?, finished_at = ?,
                finished_seq = ?, superseded_reason = ?, current_generation_at_finish = ?
          WHERE id = ?`,
      )
      .run(
        superseded ? 'superseded' : 'complete',
        fileBytes.length,
        actualHash,
        at,
        finishedSeq,
        superseded ? 'newer-generation-published' : null,
        currentGeneration,
        id,
      );
    const updated = this.get(id);
    return {
      ...updated,
      superseded,
      currentGeneration,
      repairRequired: superseded,
    };
  }

  /**
   * Called by the server when it publishes a new generation. Downloads that
   * have not started streaming are abandoned immediately: there is no reason to
   * ship bytes that are already known to be behind. A stream that is already
   * in flight is allowed to finish its pinned generation, because those bytes
   * are internally coherent; completion then reports it as superseded and the
   * client must re-download before claiming freshness.
   */
  supersedeOlder(specId, configVersion, configHash, generation) {
    const at = this.now();
    const result = this.db
      .prepare(
        `UPDATE downloads
            SET status = 'superseded', superseded_reason = 'newer-generation-published',
                finished_at = COALESCE(finished_at, ?), current_generation_at_finish = ?
          WHERE spec_id = ? AND config_version = ? AND config_hash = ?
            AND generation < ? AND status = 'pending'`,
      )
      .run(at, generation, specId, configVersion, configHash, generation);
    return Number(result.changes);
  }

  markSuperseded(id, reason) {
    this.db
      .prepare(
        "UPDATE downloads SET status = 'superseded', superseded_reason = ?, finished_at = ? WHERE id = ?",
      )
      .run(reason, this.now(), id);
  }

  fail(id, reason) {
    this.db
      .prepare("UPDATE downloads SET status = 'failed', superseded_reason = ?, finished_at = ? WHERE id = ?")
      .run(reason, this.now(), id);
  }

  list(specId, limit = 50) {
    return this.db
      .prepare('SELECT * FROM downloads WHERE spec_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(specId, limit)
      .map(rowToDownload);
  }

  /**
   * Download-cache view for the UI: does the browser hold bytes that match the
   * currently published generation? If not, it says exactly why.
   */
  status(specId, { generation = null, dataHash = null } = {}) {
    const row = this.db
      .prepare(
        `SELECT * FROM downloads WHERE spec_id = ? AND status IN ('complete','superseded')
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(specId);
    if (!row) {
      return { state: 'none', specId, message: '尚无本地下载' };
    }
    const download = rowToDownload(row);
    return {
      state: download.status === 'complete' ? 'complete' : 'superseded',
      specId,
      download,
      requestedGeneration: generation,
      requestedHash: dataHash,
    };
  }
}

function rowToDownload(row) {
  return {
    id: row.id,
    specId: row.spec_id,
    generation: Number(row.generation),
    configVersion: Number(row.config_version),
    configHash: row.config_hash,
    dataHash: row.data_hash,
    expectedBytes: Number(row.expected_bytes),
    receivedBytes: row.received_bytes === null ? null : Number(row.received_bytes),
    receivedHash: row.received_hash,
    status: row.status,
    supersededReason: row.superseded_reason,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    startedSeq: Number(row.started_seq),
    finishedSeq: row.finished_seq === null ? null : Number(row.finished_seq),
    clientId: row.client_id ?? null,
    currentGenerationAtFinish:
      row.current_generation_at_finish === null || row.current_generation_at_finish === undefined
        ? null
        : Number(row.current_generation_at_finish),
  };
}

export function downloadProof(download) {
  return {
    kind: 'download-proof-v1',
    downloadId: download.id,
    specId: download.specId,
    generation: download.generation,
    configVersion: download.configVersion,
    configHash: download.configHash,
    dataHash: download.dataHash,
    bytes: download.receivedBytes ?? download.expectedBytes,
    status: download.status,
    finishedAt: download.finishedAt,
    hash: sha256(
      canonicalJson({
        kind: 'download-proof-v1',
        downloadId: download.id,
        generation: download.generation,
        dataHash: download.dataHash,
        status: download.status,
      }),
    ),
  };
}
