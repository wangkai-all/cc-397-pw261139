import test from 'node:test';
import assert from 'node:assert/strict';

import { client, makeApp, recordInput, specInput, buildFully, startServer } from './helpers.js';
import { createRecord, updateRecord } from '../src/db/records.js';
import { createSpec, getSpec } from '../src/db/specs.js';

test('paused invalidation: reads fail closed, then recover on resume', async () => {
  const { app } = makeApp({ verifyIntervalMs: 60_000 });
  const server = await startServer(app);
  const api = client(server.url);
  const rec = await api.post('/api/records', recordInput({ amountCents: 1000 }));
  const specId = (await api.post('/api/specs', specInput())).body.spec.id;
  await buildFully(app);

  const before = await api.get(`/api/specs/${specId}/result`);
  assert.equal(before.body.status, 'fresh');

  app.invalidator.pause();
  const paused = await api.post('/api/invalidator/pause');
  assert.equal(paused.body.paused, true);

  // A revision lands while the consumer is disconnected.
  await api.patch(`/api/records/${rec.body.record.id}`, { amountCents: 880000 });
  await new Promise((r) => setTimeout(r, 300));

  // Watermark-only policy must not serve the pre-revision bytes as fresh: the
  // outbox lag proves the dirty marks are incomplete.
  const during = await api.get(`/api/specs/${specId}/result`);
  assert.equal(during.status, 409);
  assert.equal(during.body.status, 'stale');
  assert.equal(during.body.proof.fresh, false);
  assert.equal(during.body.proof.staleReason, 'full-verify-mismatch');
  assert.ok(during.body.proof.invalidationLag > 0);

  // Resume consumption: the pending event is applied, a rebuild happens, and
  // reads become fresh with the new value.
  const resumed = await api.post('/api/invalidator/resume');
  assert.equal(resumed.body.paused, false);
  await app.builder.idle();
  const after = await api.get(`/api/specs/${specId}/result`);
  assert.equal(after.status, 200);
  assert.equal(after.body.status, 'fresh');
  const row = after.body.result.rows.find((r) => r.region === 'apac');
  assert.equal(row.sum_amount, 880000);

  app.server.close();
  app.close();
});

test('fully lost events (cursor advanced without applying) are healed by the sweeper', async () => {
  const { app } = makeApp();
  const rec = createRecord(app.db, recordInput({ amountCents: 1000 }), { source: 'seed' });
  const { spec } = createSpec(app.db, specInput());
  await buildFully(app);
  const good = app.resultService.read(spec, { policy: 'strict', autoRepair: false });
  assert.equal(good.status, 'fresh');

  updateRecord(app.db, rec.record.id, { amountCents: 123456 }, { source: 'test' });

  // Drop every pending event without applying it, exactly like a consumer that
  // crashed after committing its cursor.
  app.invalidator.tick({ simulateDrop: true });
  assert.equal(app.resultService.invalidationLag(), 0, 'nothing left for the consumer');

  // The read path's own full verify is the only thing that can catch this.
  const read = app.resultService.read(spec, { policy: 'strict', autoRepair: false });
  assert.equal(read.status, 'stale');
  assert.equal(read.reason, 'full-verify-mismatch');

  // A manual build restores correctness.
  await app.builder.runOnce(spec.id, { reason: 'recovery' });
  const healed = app.resultService.read(spec, { policy: 'strict', autoRepair: false });
  assert.equal(healed.status, 'fresh');
  assert.equal(healed.artifact.data.rows[0].sum_amount, 123456);
  app.close();
});

test('an out-of-filter create does not dirty the spec', async () => {
  const { app } = makeApp();
  createRecord(
    app.db,
    recordInput({ name: 'in', status: 'active', amountCents: 1000 }),
    { source: 'seed' },
  );
  const { spec } = createSpec(
    app.db,
    specInput({ filters: [{ field: 'status', values: ['active'] }] }),
  );
  await buildFully(app);
  const genBefore = app.store.readVerified(spec.id, spec.configVersion, spec.configHash)
    .pointer.generation;

  createRecord(
    app.db,
    recordInput({ name: 'out', status: 'archived', amountCents: 5000 }),
    { source: 'seed' },
  );
  app.invalidator.tick();
  await app.builder.idle();

  const genAfter = app.store.readVerified(spec.id, spec.configVersion, spec.configHash)
    .pointer.generation;
  assert.equal(genAfter, genBefore, 'invisible insert caused no rebuild');

  // But moving that record into scope must invalidate.
  const out = app.db.prepare("SELECT id FROM accounts WHERE status = 'archived'").get();
  updateRecord(app.db, out.id, { status: 'active' }, { source: 'test' });
  app.invalidator.tick();
  await app.builder.idle();
  const read = app.resultService.read(getSpec(app.db, spec.id), {
    policy: 'strict',
    autoRepair: false,
  });
  assert.equal(read.status, 'fresh');
  assert.equal(read.artifact.data.rows[0].count, 2);
  app.close();
});
