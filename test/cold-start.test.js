import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildFully,
  client,
  makeApp,
  recordInput,
  sha256,
  specInput,
  startServer,
} from './helpers.js';
import { createRecord } from '../src/db/records.js';
import { createSpec, getSpec } from '../src/db/specs.js';
import { resultJson } from './download-util.js';

test('cold start: empty directory yields real artifacts and verified bytes', async () => {
  const { app, dir } = makeApp();
  const server = await startServer(app);
  const api = client(server.url);

  const created = await api.post('/api/records', recordInput({ name: 'A', amountCents: 1000 }));
  assert.equal(created.status, 201);
  await api.post('/api/records', recordInput({ name: 'B', amountCents: 3000, region: 'emea' }));

  const specRes = await api.post('/api/specs', specInput());
  assert.equal(specRes.status, 201);
  const specId = specRes.body.spec.id;
  app.invalidator.tick();
  await app.builder.idle();

  const result = await api.get(`/api/specs/${specId}/result`);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'fresh');
  assert.equal(result.body.proof.fresh, true);
  assert.equal(result.body.result.rowCount, 2);

  const verify = await api.get(`/api/specs/${specId}/verify`);
  assert.equal(verify.body.ok, true);
  assert.equal(verify.body.checks.artifactBytesIntact, true);

  // Real files on disk, not just in-memory rows.
  const spec = getSpec(app.db, specId);
  const versionDir = app.store.versionDir(spec.id, spec.configVersion, spec.configHash);
  assert.ok(fs.existsSync(versionDir), 'version directory exists');
  const pointer = JSON.parse(fs.readFileSync(path.join(versionDir, 'current.json'), 'utf8'));
  const generationDir = path.join(versionDir, `g${pointer.generation}`);
  assert.ok(fs.existsSync(path.join(generationDir, 'manifest.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(generationDir, 'manifest.json'), 'utf8'));
  const dataBytes = fs.readFileSync(path.join(generationDir, manifest.dataFile));
  assert.equal(sha256(dataBytes), manifest.dataHash);
  assert.equal(JSON.parse(dataBytes.toString('utf8')).rowCount, 2);

  // And the served proof's artifact hash equals the bytes on disk.
  assert.equal(result.body.proof.dataHash, sha256(dataBytes));

  // SQLite file also exists, so a restart can reuse it.
  assert.ok(fs.existsSync(path.join(dir, 'app.sqlite')));

  app.server.close();
  app.close();
});

test('records survive a restart and the artifact is still served', async () => {
  const { app, dir } = makeApp();
  const record = createRecord(app.db, recordInput({ name: 'persisted' }), { source: 'seed' });
  const { spec } = createSpec(app.db, specInput());
  await buildFully(app);
  const before = app.store.readVerified(spec.id, spec.configVersion, spec.configHash);
  assert.ok(before);
  app.close();

  const { createApp } = await import('../src/server.js');
  const app2 = createApp({ dataDir: dir, startTimers: false });
  const recordAfter = app2.db
    .prepare('SELECT * FROM accounts WHERE id = ?')
    .get(record.record.id);
  assert.equal(recordAfter.name, 'persisted');
  const specAfter = getSpec(app2.db, spec.id);
  geq(specAfter.configVersion, 1);
  const served = app2.resultService.read(specAfter, { policy: 'strict', autoRepair: false });
  assert.equal(served.status, 'fresh');
  app2.close();
});

function geq(a, b) {
  assert.ok(a >= b, `${a} >= ${b}`);
}

test('nested README doc example: aggregation totals are exact', async () => {
  const { app } = makeApp();
  createRecord(app.db, recordInput({ name: 'x', region: 'apac', amountCents: 100 }), { source: 'seed' });
  createRecord(app.db, recordInput({ name: 'y', region: 'apac', amountCents: 250 }), { source: 'seed' });
  createRecord(app.db, recordInput({ name: 'z', region: 'emea', amountCents: 999 }), { source: 'seed' });
  const { spec } = createSpec(app.db, specInput());
  await buildFully(app);
  const result = app.resultService.read(spec, { policy: 'strict', autoRepair: false });
  assert.equal(result.status, 'fresh');
  const apac = result.artifact.data.rows.find((row) => row.region === 'apac');
  assert.deepEqual(apac, { region: 'apac', count: 2, sum_amount: 350 });
  app.close();
});

void resultJson;
