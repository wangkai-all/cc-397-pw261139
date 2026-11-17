import test from 'node:test';
import assert from 'node:assert/strict';

import { makeApp, recordInput, specInput } from './helpers.js';
import { createRecord, updateRecord } from '../src/db/records.js';
import { createSpec, getSpec, getSpecState } from '../src/db/specs.js';

test('revision during an in-flight rebuild: the build is superseded and a follow-up build wins', async () => {
  const { app } = makeApp();
  const rec = createRecord(app.db, recordInput({ name: 'a', amountCents: 1000 }), { source: 'seed' });
  const { spec } = createSpec(app.db, specInput());
  app.invalidator.tick();
  await app.builder.idle();
  assert.equal(app.resultService.read(spec, { policy: 'strict', autoRepair: false }).status, 'fresh');

  // Start a slow build. It snapshots r1 and then sleeps.
  const slow = app.builder.runOnce(spec.id, {
    reason: 'test-slow',
    simulate: { afterSnapshotDelayMs: 250 },
  });

  await new Promise((r) => setTimeout(r, 60));
  // While it is running, the record is revised. The slow build's snapshot is
  // already stale, so its result must NOT become the served version.
  updateRecord(app.db, rec.record.id, { amountCents: 99000 }, { source: 'test' });
  app.invalidator.tick();
  await app.builder.idle();
  const slowOutcome = await slow;

  assert.equal(slowOutcome.ok, true);
  assert.equal(slowOutcome.stillStale, true, 'slow build reports remaining work');

  // The pump rebuilt after the slow build with the newer watermark.
  await app.builder.idle();
  const state = getSpecState(app.db, spec.id);
  assert.ok(state.requiredSeq <= state.builtSeq, 'watermark caught up');
  const read = app.resultService.read(spec, { policy: 'strict', autoRepair: false });
  assert.equal(read.status, 'fresh');
  const row = read.artifact.data.rows.find((r) => r.region === 'apac');
  assert.equal(row.sum_amount, 99000, 'served value reflects the later revision');
  app.close();
});

test('an older build finishing late cannot overwrite a newer generation', async () => {
  const { app } = makeApp();
  createRecord(app.db, recordInput({ name: 'a', amountCents: 1000 }), { source: 'seed' });
  const { spec } = createSpec(app.db, specInput());
  app.invalidator.tick();
  await app.builder.idle();
  const baseline = app.store.readVerified(spec.id, spec.configVersion, spec.configHash);

  // Builder A (a separate process in production) snapshots generation GA and
  // then stalls before publish.
  const slow = app.builder.runOnce(spec.id, {
    reason: 'slow-A',
    simulate: { afterSnapshotDelayMs: 350 },
  });
  await new Promise((r) => setTimeout(r, 60));

  // A second builder instance shares the same database and artifact root.
  const { createApp } = await import('../src/server.js');
  const app2 = createApp({ dataDir: app.dataDir, startTimers: false });
  createRecord(app2.db, recordInput({ name: 'b', region: 'emea', amountCents: 5000 }), {
    source: 'seed',
  });
  app2.invalidator.tick();
  await app2.builder.idle();
  const newest = app.store.readVerified(spec.id, spec.configVersion, spec.configHash);
  assert.ok(newest.pointer.generation > baseline.pointer.generation, 'builder B published');

  // Now A finally reaches publish. It must lose the generation race.
  const slowOutcome = await slow;
  assert.equal(slowOutcome.ok, false);
  assert.equal(slowOutcome.reason, 'superseded');
  const after = app.store.readVerified(spec.id, spec.configVersion, spec.configHash);
  assert.equal(after.dataHash, newest.dataHash, 'served bytes are still the newer build');

  const builds = app.db
    .prepare('SELECT * FROM builds WHERE spec_id = ? ORDER BY generation')
    .all(spec.id);
  assert.ok(builds.some((b) => b.status === 'superseded'), 'the late build is recorded as superseded');

  const verify = app2.resultService.verify(getSpec(app2.db, spec.id));
  assert.equal(verify.ok, true);
  app2.close();
  app.close();
});

test('config change during a build retargets the namespace; old build cannot advance the watermark', async () => {
  const { app } = makeApp();
  createRecord(app.db, recordInput({ name: 'a', amountCents: 1000 }), { source: 'seed' });
  const { spec } = createSpec(app.db, specInput());
  app.invalidator.tick();
  await app.builder.idle();

  const slow = app.builder.runOnce(spec.id, {
    reason: 'old-config',
    simulate: { afterSnapshotDelayMs: 250 },
  });
  await new Promise((r) => setTimeout(r, 50));

  const { updateSpec } = await import('../src/db/specs.js');
  const updated = updateSpec(app.db, spec.id, {
    config: {
      groupBy: ['region', 'status'],
      filters: [],
      measures: [{ id: 'count' }, { id: 'sum_amount' }],
    },
  });
  assert.equal(updated.spec.configVersion, 2);
  app.invalidator.tick();
  const oldOutcome = await slow;
  assert.equal(oldOutcome.ok, true);

  // The old build published into the historical namespace only.
  const currentSpec = getSpec(app.db, spec.id);
  assert.equal(currentSpec.configVersion, 2);
  const state = getSpecState(app.db, spec.id);
  assert.ok(
    state.requiredSeq > oldOutcome.builtSeq || state.builtSeq >= oldOutcome.builtSeq,
    'watermark bookkeeping stays consistent',
  );
  await app.builder.idle();

  // The current namespace has its own verified artifact with the new config.
  const read = app.resultService.read(currentSpec, { policy: 'strict', autoRepair: false });
  assert.equal(read.status, 'fresh');
  assert.deepEqual(read.artifact.data.columns, ['region', 'status', 'count', 'sum_amount']);
  const buildStatus = app.db
    .prepare("SELECT status FROM builds WHERE id = ?")
    .get(oldOutcome.buildId);
  assert.equal(buildStatus.status, 'published');
  app.close();
});

test('a failed build never replaces a good artifact; the pump heals it', async () => {
  const { app } = makeApp();
  const rec = createRecord(app.db, recordInput({ name: 'a', amountCents: 1000 }), { source: 'seed' });
  const { spec } = createSpec(app.db, specInput());
  app.invalidator.tick();
  await app.builder.idle();
  const good = app.store.readVerified(spec.id, spec.configVersion, spec.configHash);

  updateRecord(app.db, rec.record.id, { amountCents: 7777 }, { source: 'test' });
  app.invalidator.tick();
  await app.builder.idle();
  const healed = app.store.readVerified(spec.id, spec.configVersion, spec.configHash);
  assert.ok(healed.pointer.generation > good.pointer.generation);

  // A subsequent failed build must leave the (now current) good bytes intact.
  const failing = await app.builder.runOnce(spec.id, {
    reason: 'failing',
    simulate: { failWith: 'simulated disk failure' },
  });
  assert.equal(failing.ok, false);
  assert.match(failing.error, /simulated disk failure/);

  const still = app.store.readVerified(spec.id, spec.configVersion, spec.configHash);
  assert.equal(still.pointer.generation, healed.pointer.generation);
  assert.equal(still.dataHash, healed.dataHash);
  const read = app.resultService.read(spec, { policy: 'watermark', autoRepair: false });
  assert.equal(read.status, 'fresh', 'the good artifact is still served');
  const buildRow = app.db.prepare('SELECT status FROM builds WHERE id = ?').get(failing.buildId);
  assert.equal(buildRow.status, 'failed');
  app.close();
});

test('corrupt artifact bytes are refused and rebuilt rather than served', async () => {
  const { app } = makeApp();
  createRecord(app.db, recordInput({ name: 'a', amountCents: 1000 }), { source: 'seed' });
  const { spec } = createSpec(app.db, specInput());
  app.invalidator.tick();
  await app.builder.idle();
  const artifact = app.store.readVerified(spec.id, spec.configVersion, spec.configHash);
  const dir = app.store.generationDir(
    spec.id,
    spec.configVersion,
    spec.configHash,
    artifact.pointer.generation,
  );
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.writeFileSync(path.join(dir, artifact.manifest.dataFile), '{"tampered":true}');

  assert.equal(app.store.readVerified(spec.id, spec.configVersion, spec.configHash), null);
  const read = app.resultService.read(spec, { policy: 'watermark', autoRepair: true });
  assert.equal(read.status, 'miss');
  await app.builder.idle();
  const healed = app.resultService.read(spec, { policy: 'strict', autoRepair: false });
  assert.equal(healed.status, 'fresh');
  assert.equal(healed.artifact.manifest.build.outputDigest, artifact.manifest.build.outputDigest);
  app.close();
});
