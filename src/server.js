import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { openDatabase, currentSequence, nextGeneration, transaction } from './db/schema.js';
import {
  createSpec,
  getSpec,
  listSpecs,
  requireSpec,
  specBody,
  specVersions,
  updateSpec,
  catalogBody,
  getSpecState,
} from './db/specs.js';
import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecordHistory,
  listRecords,
  recordBodyForClient,
  updateRecord,
} from './db/records.js';
import { ArtifactStore } from './store/artifacts.js';
import { CacheBuilder, listBuilds } from './cache/builder.js';
import { Invalidator, listNotifications } from './cache/invalidator.js';
import { ResultService } from './cache/result-service.js';
import { DownloadService, downloadProof } from './cache/downloads.js';
import { dependencyFields } from './cache/dependencies.js';
import {
  HttpError,
  clampInt,
  httpError,
  readJsonBody,
  sendJson,
  sendText,
} from './lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createApp({
  dataDir = process.env.DATA_DIR ?? path.join(__dirname, '..', 'data'),
  dbFile = null,
  verifyIntervalMs = 2000,
  builderDelays = {},
  invalidatorLossRate = 0,
  startTimers = true,
} = {}) {
  const databaseFile = dbFile ?? path.join(dataDir, 'app.sqlite');
  const db = openDatabase(databaseFile);
  const store = new ArtifactStore(dataDir);
  const subscribers = new Set();

  const builder = new CacheBuilder({
    db,
    store,
    delays: builderDelays,
    hooks: {
      onPublished: (event) => {
        downloads.supersedeOlder(
          event.specId,
          event.configVersion,
          event.configHash,
          event.generation,
        );
        broadcast({ type: 'artifact-published', ...event });
      },
    },
  });

  const resultService = new ResultService({ db, store, builder, verifyIntervalMs });
  const downloads = new DownloadService({ db, store });
  const invalidator = new Invalidator({
    db,
    builder,
    lossRate: invalidatorLossRate,
    notify: (notification) => broadcast({ type: 'invalidation', notification }),
  });

  const app = {
    db,
    store,
    builder,
    invalidator,
    resultService,
    downloads,
    dataDir,
    dbFile: databaseFile,
    close() {
      clearInterval(invalidationTimer);
      builder.close();
      for (const res of subscribers) {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
      subscribers.clear();
      db.close();
    },
  };

  function broadcast(event) {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of subscribers) {
      try {
        res.write(payload);
      } catch {
        subscribers.delete(res);
      }
    }
  }

  let invalidationTimer = null;
  if (startTimers) {
    invalidationTimer = setInterval(() => {
      try {
        invalidator.tick();
      } catch (err) {
        console.error('invalidator tick failed:', err);
      }
    }, 250);
    invalidationTimer.unref?.();
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      await route(req, res);
    } catch (err) {
      handleError(res, err);
    } finally {
      if (process.env.REQUEST_LOG) {
        console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  });

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method ?? 'GET';

    if (pathname.startsWith('/api/')) {
      return apiRoute(req, res, url, pathname, method);
    }
    if (pathname === '/events') {
      return eventStream(req, res);
    }
    return staticRoute(req, res, pathname, method);
  }

  async function apiRoute(req, res, url, pathname, method) {
    const parts = pathname.split('/').filter(Boolean); // ['api', ...]

    if (pathname === '/api/health' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        seq: currentSequence(db),
        dataDir,
        dbFile: databaseFile,
        specs: listSpecs(db).length,
        records: listRecords(db).length,
        subscribers: subscribers.size,
      });
    }

    if (pathname === '/api/catalog' && method === 'GET') {
      return sendJson(res, 200, catalogBody());
    }

    if (pathname === '/api/state' && method === 'GET') {
      return sendJson(res, 200, {
        seq: currentSequence(db),
        records: listRecords(db).map(recordBodyForClient),
        specs: listSpecs(db).map((spec) => specWithState(spec)),
      });
    }

    // ---- records ----
    if (parts[1] === 'records') {
      if (parts.length === 2 && method === 'GET') {
        const includeDeleted = url.searchParams.get('includeDeleted') === '1';
        return sendJson(res, 200, {
          records: listRecords(db, { includeDeleted }).map(recordBodyForClient),
          seq: currentSequence(db),
        });
      }
      if (parts.length === 2 && method === 'POST') {
        const body = await readJsonBody(req);
        const created = createRecord(db, body, { source: 'web' });
        invalidator.tick();
        return sendJson(res, 201, {
          record: recordBodyForClient(created.record),
          seq: created.seq,
        });
      }
      if (parts.length === 3 && method === 'GET') {
        const record = getRecord(db, parts[2]);
        if (!record) throw httpError(404, 'record not found');
        return sendJson(res, 200, {
          record: recordBodyForClient(record),
          history: listRecordHistory(db, parts[2]),
        });
      }
      if (parts.length === 3 && (method === 'PATCH' || method === 'PUT')) {
        const body = await readJsonBody(req);
        const { expectedRevision, ...patch } = body;
        const result = updateRecord(db, parts[2], patch, {
          source: 'web',
          expectedRevision,
        });
        invalidator.tick();
        return sendJson(res, result.noop ? 200 : 200, {
          record: recordBodyForClient(result.record),
          changedFields: result.changedFields,
          noop: result.noop,
          seq: result.seq,
          revision: result.record.revision,
        });
      }
      if (parts.length === 3 && method === 'DELETE') {
        const body = await readJsonBody(req).catch(() => ({}));
        const result = deleteRecord(db, parts[2], {
          source: 'web',
          expectedRevision: body.expectedRevision,
        });
        invalidator.tick();
        return sendJson(res, 200, {
          record: recordBodyForClient(result.record),
          noop: result.noop,
          seq: result.seq,
        });
      }
      if (parts.length === 4 && parts[3] === 'history' && method === 'GET') {
        return sendJson(res, 200, { history: listRecordHistory(db, parts[2]) });
      }
    }

    // ---- specs ----
    if (parts[1] === 'specs') {
      if (parts.length === 2 && method === 'GET') {
        return sendJson(res, 200, { specs: listSpecs(db).map((spec) => specWithState(spec)) });
      }
      if (parts.length === 2 && method === 'POST') {
        const body = await readJsonBody(req);
        const created = createSpec(db, body);
        invalidator.tick();
        builder.requestBuild(created.spec.id, { seq: created.changeSeq, reason: 'spec-created' });
        await builder.idle();
        return sendJson(res, 201, { spec: specWithState(created.spec) });
      }
      const specId = parts[2];
      if (parts.length === 3 && method === 'GET') {
        const spec = requireSpec(db, specId);
        return sendJson(res, 200, {
          spec: specWithState(spec),
          versions: specVersions(db, specId),
          builds: listBuilds(db, specId, 20),
          downloads: downloads.list(specId, 20),
        });
      }
      if (parts.length === 3 && (method === 'PATCH' || method === 'PUT')) {
        const body = await readJsonBody(req);
        const updated = updateSpec(db, specId, body);
        invalidator.tick();
        if (updated.configChanged) {
          builder.requestBuild(specId, { seq: updated.changeSeq, reason: 'spec-config' });
        }
        await builder.idle();
        return sendJson(res, 200, { spec: specWithState(updated.spec) });
      }
      if (parts.length === 4 && parts[3] === 'result' && method === 'GET') {
        const spec = requireSpec(db, specId);
        const policy = url.searchParams.get('policy') ?? 'watermark';
        const autoRepair = url.searchParams.get('autoRepair') !== '0';
        const outcome = resultService.read(spec, { policy, autoRepair });
        if (outcome.status === 'fresh') {
          return sendJson(
            res,
            200,
            {
              status: 'fresh',
              spec: specBody(spec),
              proof: outcome.proof,
              result: outcome.artifact.data,
              generation: Number(outcome.artifact.pointer.generation),
              etag: `"${outcome.proof.dataHash}"`,
            },
            { ETag: `"${outcome.proof.dataHash}"` },
          );
        }
        return sendJson(res, outcome.httpStatus, {
          status: outcome.status,
          reason: outcome.reason,
          spec: specBody(spec),
          proof: outcome.proof ?? null,
          repairScheduled: outcome.repairScheduled ?? false,
        });
      }
      if (parts.length === 4 && parts[3] === 'verify' && method === 'GET') {
        const spec = requireSpec(db, specId);
        return sendJson(res, 200, resultService.verify(spec));
      }
      if (parts.length === 4 && parts[3] === 'dependencies' && method === 'GET') {
        const spec = requireSpec(db, specId);
        return sendJson(res, 200, dependenciesView(spec));
      }
      if (parts.length === 4 && parts[3] === 'builds' && method === 'GET') {
        requireSpec(db, specId);
        return sendJson(res, 200, { builds: listBuilds(db, specId, 50) });
      }
      if (parts.length === 4 && parts[3] === 'build' && method === 'POST') {
        const spec = requireSpec(db, specId);
        const body = await readJsonBody(req);
        const simulate = {
          afterSnapshotDelayMs: clampInt(body.afterSnapshotDelayMs ?? 0, 0, 60_000, 0),
          publishDelayMs: clampInt(body.publishDelayMs ?? 0, 0, 60_000, 0),
          failWith: body.failWith ? String(body.failWith) : undefined,
        };
        builder.requestBuild(specId, { reason: 'manual' });
        const outcome = await builder.runOnce(specId, { reason: 'manual', simulate });
        return sendJson(res, outcome.ok ? 200 : 202, outcome);
      }
      if (parts.length === 4 && parts[3] === 'downloads' && method === 'GET') {
        requireSpec(db, specId);
        return sendJson(res, 200, {
          downloads: downloads.list(specId, 50),
          status: downloads.status(specId, {
            generation: url.searchParams.get('generation'),
            dataHash: url.searchParams.get('dataHash'),
          }),
        });
      }
      if (parts.length === 4 && parts[3] === 'downloads' && method === 'POST') {
        const spec = requireSpec(db, specId);
        const body = await readJsonBody(req);
        const created = downloads.create(spec, {
          generation: body.generation ?? null,
          clientId: body.clientId ?? null,
        });
        return sendJson(res, 201, created);
      }
    }

    // ---- downloads ----
    if (parts[1] === 'downloads' && parts[2]) {
      const id = parts[2];
      if (parts.length === 3 && method === 'GET') {
        const download = downloads.get(id);
        if (!download) throw httpError(404, 'download not found');
        return sendJson(res, 200, { download, proof: downloadProof(download) });
      }
      if (parts.length === 4 && parts[3] === 'file' && method === 'GET') {
        return streamDownload(req, res, id);
      }
      if (parts.length === 4 && parts[3] === 'complete' && method === 'POST') {
        const body = await readJsonBody(req);
        const result = downloads.complete(id, {
          receivedHash: body.receivedHash ?? null,
          receivedBytes: body.receivedBytes ?? null,
        });
        return sendJson(res, 200, { download: result, proof: downloadProof(result) });
      }
      if (parts.length === 4 && parts[3] === 'resume' && method === 'POST') {
        const result = downloads.resume(id);
        return sendJson(res, 200, { download: result });
      }
      if (parts.length === 4 && parts[3] === 'abort' && method === 'POST') {
        const result = downloads.markInterrupted(id);
        return sendJson(res, 200, { download: result });
      }
    }

    // ---- notifications / invalidation ----
    if (pathname === '/api/notifications' && method === 'GET') {
      return sendJson(res, 200, {
        notifications: listNotifications(db, {
          afterId: Number(url.searchParams.get('afterId') ?? 0),
          specId: url.searchParams.get('specId') || null,
          limit: clampInt(url.searchParams.get('limit') ?? 200, 1, 1000, 200),
        }),
        seq: currentSequence(db),
      });
    }

    if (pathname === '/api/invalidator/tick' && method === 'POST') {
      const body = await readJsonBody(req);
      const events = invalidator.tick({ simulateDrop: Boolean(body.simulateDrop) });
      await builder.idle();
      return sendJson(res, 200, { events, stats: invalidator.stats, paused: invalidator.paused });
    }

    if (pathname === '/api/invalidator/pause' && method === 'POST') {
      invalidator.pause();
      broadcast({ type: 'invalidator-paused' });
      return sendJson(res, 200, { paused: true, cursor: invalidator.getCursor() });
    }

    if (pathname === '/api/invalidator/resume' && method === 'POST') {
      invalidator.resume();
      const events = invalidator.tick();
      await builder.idle();
      broadcast({ type: 'invalidator-resumed' });
      return sendJson(res, 200, {
        paused: false,
        eventsProcessed: events.length,
        stats: invalidator.stats,
      });
    }

    if (pathname === '/api/invalidator/stats' && method === 'GET') {
      return sendJson(res, 200, {
        ...invalidator.stats,
        paused: invalidator.paused,
        cursor: invalidator.getCursor(),
        pending: Number(
          db
            .prepare("SELECT COUNT(*) AS n FROM outbox WHERE id > ?")
            .get(invalidator.getCursor()).n,
        ),
      });
    }

    if (pathname === '/api/heartbeat' && method === 'GET') {
      // Lets the client prove the source is still progressing even when the
      // notification channel is down.
      return sendJson(res, 200, {
        seq: currentSequence(db),
        paused: invalidator.paused,
        pending: Number(
          db
            .prepare("SELECT COUNT(*) AS n FROM outbox WHERE id > ?")
            .get(invalidator.getCursor()).n,
        ),
        specs: listSpecs(db).map((spec) => {
          const state = getSpecState(db, spec.id);
          return {
            id: spec.id,
            requiredSeq: state.requiredSeq,
            builtSeq: state.builtSeq,
            dirty: state.requiredSeq > state.builtSeq,
          };
        }),
      });
    }

    if (pathname === '/api/builder/idle' && method === 'POST') {
      await builder.idle();
      return sendJson(res, 200, { ok: true });
    }

    throw httpError(404, `unknown API route: ${method} ${pathname}`);
  }

  function specWithState(spec) {
    const state = getSpecState(db, spec.id);
    const artifact = store.readVerified(spec.id, spec.configVersion, spec.configHash);
    return {
      ...specBody(spec, {
        requiredSeq: state.requiredSeq,
        builtSeq: state.builtSeq,
        lastBuildId: state.lastBuildId,
        lastBuildStatus: state.lastBuildStatus,
        lastBuildError: state.lastBuildError,
        lastBuildAt: state.lastBuildAt,
        materialized: Boolean(artifact),
        publishedGeneration: artifact ? Number(artifact.pointer.generation) : null,
        publishedOutputDigest: artifact?.manifest.build?.outputDigest ?? null,
        publishedDataHash: artifact?.dataHash ?? null,
      }),
    };
  }

  function dependenciesView(spec) {
    const records = listRecords(db);
    const fields = dependencyFields(spec);
    const affected = records
      .filter((record) =>
        spec.config.filters.every((filter) => filter.values.includes(record[filter.field])),
      )
      .map((record) => ({
        id: record.id,
        revision: record.revision,
        matches: true,
        values: Object.fromEntries(fields.map((field) => [field, record[field]])),
      }));
    const state = getSpecState(db, spec.id);
    return {
      specId: spec.id,
      fields,
      filters: spec.config.filters,
      groupBy: spec.config.groupBy,
      measures: spec.config.measures,
      affectedRecords: affected,
      affectedCount: affected.length,
      state: {
        requiredSeq: state.requiredSeq,
        builtSeq: state.builtSeq,
        dirty: state.requiredSeq > state.builtSeq,
      },
      seq: currentSequence(db),
    };
  }

  function streamDownload(req, res, id) {
    const { download, manifest, file } = downloads.openPinned(id);
    const bytes = fs.readFileSync(file);
    downloads.markStreaming(id);
    const total = bytes.length;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(total),
      'Cache-Control': 'no-store',
      'X-Artifact-Generation': String(download.generation),
      'X-Artifact-Data-Hash': download.dataHash,
      'X-Spec-Version': `${download.configVersion}:${download.configHash}`,
      'X-Download-Id': download.id,
      'X-Build-Id': manifest.build?.buildId ?? '',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    // Chunked delivery so the UI can exercise mid-download invalidation
    // without buffering tens of megabytes.
    const chunkSize = 64 * 1024;
    let offset = 0;
    const tick = () => {
      if (res.writableEnded || res.destroyed) {
        downloads.recordProgress(id, offset);
        return;
      }
      if (offset >= total) {
        res.end(() => downloads.recordProgress(id, total));
        return;
      }
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, total));
      offset += chunk.length;
      downloads.recordProgress(id, offset);
      const ok = res.write(chunk);
      if (ok) setImmediate(tick);
      else res.once('drain', tick);
    };
    res.on('close', () => {
      if (!res.writableEnded) downloads.markInterrupted(id);
    });
    tick();
  }

  function eventStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ seq: currentSequence(db) })}\n\n`);
    subscribers.add(res);
    const keepalive = setInterval(() => {
      if (res.writableEnded) return;
      res.write(': keepalive\n\n');
    }, 15_000);
    keepalive.unref?.();
    req.on('close', () => {
      clearInterval(keepalive);
      subscribers.delete(res);
    });
  }

  function staticRoute(req, res, pathname, method) {
    if (method !== 'GET' && method !== 'HEAD') {
      throw httpError(405, 'method not allowed');
    }
    let relative = pathname === '/' ? '/index.html' : pathname;
    const resolved = path.resolve(PUBLIC_DIR, `.${relative}`);
    if (!resolved.startsWith(PUBLIC_DIR)) {
      throw httpError(403, 'forbidden');
    }
    let file = resolved;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(PUBLIC_DIR, 'index.html');
    }
    if (!fs.existsSync(file)) throw httpError(404, 'not found');
    const ext = path.extname(file);
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : body);
  }

  function handleError(res, err) {
    const status = err instanceof HttpError ? err.statusCode : err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, status, {
      error: err.message ?? 'internal error',
      detail: err.detail ?? null,
    });
  }

  app.server = server;
  app.listen = (port = 0, host = '127.0.0.1') =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        const address = server.address();
        resolve({ port: address.port, host, url: `http://${host}:${address.port}` });
      });
    });

  return app;
}

/**
 * CLI entrypoint: `node src/server.js [dataDir] [port]`.
 * Starts the builder + invalidator loops and serves the UI.
 */
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const port = Number(process.env.PORT ?? process.argv[3] ?? 4173);
  const dataDir = process.argv[2] ?? process.env.DATA_DIR ?? path.join(__dirname, '..', 'data');
  const app = createApp({ dataDir });
  const info = await app.listen(port, process.env.HOST ?? '127.0.0.1');
  console.log(`revision-proof-cache listening on ${info.url}`);
  console.log(`data directory: ${dataDir}`);
  console.log('empty directory? run: npm run seed   (or use the UI to create records)');
  const shutdown = () => {
    console.log('\nshutting down…');
    app.server.close();
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
