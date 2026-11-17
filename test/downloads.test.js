import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  buildFully,
  client,
  makeApp,
  recordInput,
  sha256,
  specInput,
  startServer,
} from './helpers.js';
import { createRecord, updateRecord } from '../src/db/records.js';
import { createSpec, getSpec } from '../src/db/specs.js';

async function fetchAll(url) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
}

test('download is pinned to a generation and proves its hash', async () => {
  const { app } = makeApp();
  const server = await startServer(app);
  const api = client(server.url);

  await api.post('/api/records', recordInput({ name: 'a', amountCents: 1000 }));
  const specRes = await api.post('/api/specs', specInput());
  const specId = specRes.body.spec.id;

  const created = await api.post(`/api/specs/${specId}/downloads`);
  assert.equal(created.status, 201);
  assert.equal(created.body.generation, 1);
  assert.ok(created.body.expectedBytes > 0);

  const { res, buf } = await fetchAll(server.url + created.body.downloadUrl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-artifact-generation'), '1');
  assert.equal(res.headers.get('x-artifact-data-hash'), created.body.dataHash);
  assert.equal(buf.length, created.body.expectedBytes);
  assert.equal(sha256(buf), created.body.dataHash);

  const completed = await api.post(`/api/downloads/${created.body.id}/complete`, {
    receivedHash: sha256(buf),
    receivedBytes: buf.length,
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.download.status, 'complete');
  assert.equal(completed.body.download.receivedHash, created.body.dataHash);
  assert.equal(completed.body.proof.dataHash, created.body.dataHash);

  app.server.close();
  app.close();
});

test('client hash mismatch is rejected and the server re-verifies real bytes', async () => {
  const { app } = makeApp();
  const server = await startServer(app);
  const api = client(server.url);
  await api.post('/api/records', recordInput({}));
  const specId = (await api.post('/api/specs', specInput())).body.spec.id;
  const created = await api.post(`/api/specs/${specId}/downloads`);
  const { buf } = await fetchAll(server.url + created.body.downloadUrl);

  const bad = await api.post(`/api/downloads/${created.body.id}/complete`, {
    receivedHash: sha256(Buffer.from('not the bytes')),
    receivedBytes: buf.length,
  });
  assert.equal(bad.status, 422);
  const row = app.db.prepare('SELECT status FROM downloads WHERE id = ?').get(created.body.id);
  assert.equal(row.status, 'failed');

  // A valid completion of the same download is still possible: the server did
  // not corrupt its own copy, only refused the bad client claim.
  const retry = await api.post(`/api/downloads/${created.body.id}/complete`, {
    receivedHash: sha256(buf),
    receivedBytes: buf.length,
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.download.status, 'complete');

  app.server.close();
  app.close();
});

test('invalidation during a download: bytes stay coherent, completion is flagged superseded', async () => {
  const { app } = makeApp();
  const server = await startServer(app);
  const api = client(server.url);
  const rec = await api.post('/api/records', recordInput({ name: 'a', amountCents: 1000 }));
  const specId = (await api.post('/api/specs', specInput())).body.spec.id;

  const created = await api.post(`/api/specs/${specId}/downloads`);
  const { res, buf } = await fetchAll(server.url + created.body.downloadUrl);
  assert.equal(res.headers.get('x-artifact-generation'), '1');
  // A revision lands after the pinned bytes started streaming.
  updateRecord(app.db, rec.body.record.id, { amountCents: 4242 }, { source: 'test' });
  app.invalidator.tick();
  await app.builder.idle();
  assert.equal(sha256(buf), created.body.dataHash);

  const completed = await api.post(`/api/downloads/${created.body.id}/complete`, {
    receivedHash: sha256(buf),
    receivedBytes: buf.length,
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.download.status, 'superseded');
  assert.equal(completed.body.download.superseded, true);
  assert.equal(completed.body.download.currentGeneration, 2);
  assert.equal(completed.body.download.repairRequired, true);

  // The client can now prove its local copy is behind the served version.
  const latest = await api.get(`/api/specs/${specId}/result`);
  assert.equal(latest.body.generation, 2);
  const status = await api.get(`/api/specs/${specId}/downloads`);
  assert.equal(status.body.status.state, 'superseded');

  // Re-downloading at g2 completes cleanly.
  const fresh = await api.post(`/api/specs/${specId}/downloads`);
  assert.equal(fresh.body.generation, 2);
  const second = await fetchAll(server.url + fresh.body.downloadUrl);
  const done = await api.post(`/api/downloads/${fresh.body.id}/complete`, {
    receivedHash: sha256(second.buf),
    receivedBytes: second.buf.length,
  });
  assert.equal(done.body.download.status, 'complete');

  app.server.close();
  app.close();
});

test('an interrupted download can resume only against the same generation', async () => {
  const { app } = makeApp();
  const server = await startServer(app);
  const api = client(server.url);
  await api.post('/api/records', recordInput({}));
  const specId = (await api.post('/api/specs', specInput())).body.spec.id;
  const created = await api.post(`/api/specs/${specId}/downloads`);

  app.downloads.markStreaming(created.body.id);
  app.downloads.recordProgress(created.body.id, 10);
  app.downloads.markInterrupted(created.body.id);
  const resumed = await api.post(`/api/downloads/${created.body.id}/resume`);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.download.status, 'streaming');

  // If the artifact moves on, resume is refused with an explicit reason.
  app.downloads.markInterrupted(created.body.id);
  const only = app.db.prepare('SELECT id FROM accounts LIMIT 1').get();
  updateRecord(app.db, only.id, { amountCents: 1 }, { source: 'test' });
  app.invalidator.tick();
  await app.builder.idle();
  const refused = await api.post(`/api/downloads/${created.body.id}/resume`);
  assert.equal(refused.status, 409);

  app.server.close();
  app.close();
});

test('download of a missing generation is a 404, not a silent fallback', async () => {
  const { app } = makeApp();
  const server = await startServer(app);
  const api = client(server.url);
  await api.post('/api/records', recordInput({}));
  const specId = (await api.post('/api/specs', specInput())).body.spec.id;
  const bad = await api.post(`/api/specs/${specId}/downloads`, { generation: 99 });
  assert.equal(bad.status, 404);
  app.server.close();
  app.close();
});

test('downloaded bytes equal the exact artifact bytes on disk', async () => {
  const { app } = makeApp();
  const server = await startServer(app);
  const api = client(server.url);
  await api.post('/api/records', recordInput({}));
  const specId = (await api.post('/api/specs', specInput())).body.spec.id;
  const created = await api.post(`/api/specs/${specId}/downloads`);
  const { buf } = await fetchAll(server.url + created.body.downloadUrl);
  const spec = getSpec(app.db, specId);
  const artifact = app.store.readVerified(spec.id, spec.configVersion, spec.configHash);
  const dir = app.store.generationDir(
    spec.id,
    spec.configVersion,
    spec.configHash,
    artifact.pointer.generation,
  );
  const fs = await import('node:fs');
  const path = await import('node:path');
  const onDisk = fs.readFileSync(path.join(dir, artifact.manifest.dataFile));
  assert.ok(buf.equals(onDisk));
  const parsed = JSON.parse(buf.toString('utf8'));
  assert.equal(parsed.proof.generation, artifact.pointer.generation);
  assert.equal(parsed.proof.buildId, artifact.manifest.build.buildId);
  void crypto;
  app.server.close();
  app.close();
});

void updateRecord;
void createRecord;
void createSpec;
void buildFully;
