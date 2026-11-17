import test from 'node:test';
import assert from 'node:assert/strict';

import { makeApp, recordInput, specInput, buildFully } from './helpers.js';
import { createRecord, updateRecord, deleteRecord, getRecord } from '../src/db/records.js';
import { createSpec, getSpec, getSpecState } from '../src/db/specs.js';

function freshRead(app, spec) {
  return app.resultService.read(spec, { policy: 'watermark', autoRepair: false });
}

test('editing an observed field invalidates the spec that depends on it', async () => {
  const { app } = makeApp();
  const created = createRecord(app.db, recordInput({ name: 'a', amountCents: 1000 }), { source: 'seed' });
  const { spec } = createSpec(app.db, specInput());
  await buildFully(app);
  assert.equal(freshRead(app, spec).status, 'fresh');

  updateRecord(app.db, created.record.id, { amountCents: 5000 }, { source: 'test' });
  app.invalidator.tick();
  await app.builder.idle();

  const state = getSpecState(app.db, spec.id);
  assert.ok(state.requiredSeq > 0, 'watermark advanced');
  assert.ok(state.requiredSeq <= state.builtSeq, 'builder caught up');
  const read = freshRead(app, spec);
  assert.equal(read.status, 'fresh', 'fresh after the delivered invalidation rebuild');
  const row = read.artifact.data.rows.find((r) => r.region === 'apac');
  assert.equal(row.sum_amount, 5000);
  app.close();
});

test('editing a non-observed field does not invalidate anything', async () => {
  const { app } = makeApp();
  const created = createRecord(app.db, recordInput({ name: 'a', amountCents: 1000 }), { source: 'seed' });
  // Spec only groups by region and counts rows; name/notes are invisible.
  const { spec } = createSpec(app.db, specInput({ measures: [{ id: 'count' }] }));
  await buildFully(app);
  const before = app.store.readVerified(spec.id, spec.configVersion, spec.configHash);
  const stateBefore = getSpecState(app.db, spec.id);

  updateRecord(app.db, created.record.id, { name: 'renamed', notes: 'hello' }, { source: 'test' });
  app.invalidator.tick();
  await app.builder.idle();

  const stateAfter = getSpecState(app.db, spec.id);
  assert.equal(stateAfter.requiredSeq, stateBefore.requiredSeq, 'no dirty mark for irrelevant edit');
  const after = app.store.readVerified(spec.id, spec.configVersion, spec.configHash);
  assert.equal(after.pointer.generation, before.pointer.generation, 'no rebuild happened');
  assert.equal(freshRead(app, spec).status, 'fresh');
  app.close();
});

test('filter membership changes invalidate even if the observed value is identical', async () => {
  const { app } = makeApp();
  const created = createRecord(
    app.db,
    recordInput({ name: 'a', status: 'active', amountCents: 1000 }),
    { source: 'seed' },
  );
  const { spec } = createSpec(
    app.db,
    specInput({ filters: [{ field: 'status', values: ['active'] }] }),
  );
  await buildFully(app);
  assert.equal(freshRead(app, spec).artifact.data.rows[0].count, 1);

  // Moving out of the filter changes row count, so this must invalidate.
  updateRecord(app.db, created.record.id, { status: 'archived' }, { source: 'test' });
  app.invalidator.tick();
  await app.builder.idle();
  const read = freshRead(app, spec);
  assert.equal(read.status, 'fresh');
  assert.equal(read.artifact.data.rows.length, 0);
  app.close();
});

test('lost invalidation notification is caught by the read watermark', async () => {
  const { app } = makeApp();
  const created = createRecord(app.db, recordInput({ name: 'a', amountCents: 1000 }), { source: 'seed' });
  const { spec } = createSpec(app.db, specInput());
  await buildFully(app);

  updateRecord(app.db, created.record.id, { amountCents: 2000 }, { source: 'test' });

  // Simulate the invalidation consumer crashing: the outbox row exists but is
  // never applied. No dirty mark is written and no builder runs.
  const cursorBefore = app.invalidator.getCursor();
  app.invalidator.setCursor(
    app.db.prepare('SELECT MAX(id) AS id FROM outbox').get().id,
  );
  const state = getSpecState(app.db, spec.id);
  assert.equal(state.requiredSeq, state.builtSeq, 'no invalidation was applied');
  void cursorBefore;

  // The read path must not trust the clean watermark forever; the periodic
  // full verify catches the drift.
  const read = app.resultService.read(spec, { policy: 'strict', autoRepair: false });
  assert.equal(read.status, 'stale');
  assert.equal(read.reason, 'full-verify-mismatch');
  app.close();
});

test('watermark-only policy fails closed once the durable watermark advances', async () => {
  const { app } = makeApp();
  const created = createRecord(app.db, recordInput({ name: 'a', amountCents: 1000 }), { source: 'seed' });
  const { spec } = createSpec(app.db, specInput());
  await buildFully(app);

  // Writer commits, invalidator is slow: no build happens yet, but the
  // watermark is durably ahead because markSpecDirty is in the write tx path
  // once the consumer runs. Here we simulate the consumer running without the
  // builder being allowed to finish.
  app.builder.requestBuild(spec.id, { seq: 1_000_000, reason: 'test' });
  const read = app.resultService.read(spec, { policy: 'watermark', autoRepair: false });
  assert.equal(read.status, 'stale');
  assert.equal(read.reason, 'source-watermark-ahead');
  app.close();
});

test('delete invalidates and removes the group', async () => {
  const { app } = makeApp();
  const created = createRecord(app.db, recordInput({ name: 'a', amountCents: 1000 }), { source: 'seed' });
  const { spec } = createSpec(app.db, specInput());
  await buildFully(app);
  deleteRecord(app.db, created.record.id, { source: 'test' });
  app.invalidator.tick();
  await app.builder.idle();
  const read = freshRead(app, spec);
  assert.equal(read.status, 'fresh');
  assert.equal(read.artifact.data.rows.length, 0);
  app.close();
});

test('cost model is observable: watermark reads avoid full aggregation', async () => {
  const { app } = makeApp({ verifyIntervalMs: 60_000 });
  for (let i = 0; i < 20; i += 1) {
    createRecord(app.db, recordInput({ name: `r${i}`, amountCents: 100 + i }), { source: 'seed' });
  }
  const { spec } = createSpec(app.db, specInput());
  await buildFully(app);

  app.invalidator.tick();
  await app.builder.idle();
  const first = app.resultService.read(spec, { policy: 'watermark', autoRepair: false });
  assert.equal(first.status, 'fresh');
  assert.equal(first.proof.verification, 'full', 'first read after a build pays for a full verify');

  assert.equal(app.resultService.invalidationLag(), 0, 'no unconsumed invalidation events');
  const second = app.resultService.read(spec, { policy: 'watermark', autoRepair: false });
  assert.equal(second.status, 'fresh');
  assert.equal(second.proof.verification, 'watermark+cached-verify', 'second read is watermark-only');
  app.close();
});
