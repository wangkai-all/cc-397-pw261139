import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { client, makeApp, recordInput, specInput, startServer } from './helpers.js';

test('web UI is served and the API surface it needs is present', async () => {
  const { app } = makeApp();
  const server = await startServer(app);
  const html = await fetch(server.url + '/');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  const body = await html.text();
  assert.match(body, /修订可证明的物化缓存/);
  assert.match(body, /app\.js/);

  const js = await fetch(server.url + '/app.js');
  assert.equal(js.status, 200);
  const css = await fetch(server.url + '/styles.css');
  assert.equal(css.status, 200);

  const health = await fetch(server.url + '/api/health');
  assert.equal(health.status, 200);
  const catalog = await (await fetch(server.url + '/api/catalog')).json();
  assert.ok(catalog.dimensions.length >= 3);
  assert.ok(catalog.measures.some((m) => m.id === 'sum_amount'));

  app.server.close();
  app.close();
});

test('dependency view reports which live records feed a spec', async () => {
  const { app } = makeApp();
  const server = await startServer(app);
  const api = client(server.url);
  await api.post('/api/records', recordInput({ name: 'in', region: 'apac', status: 'active' }));
  await api.post('/api/records', recordInput({ name: 'out', region: 'apac', status: 'archived' }));
  const specId = (
    await api.post(
      '/api/specs',
      specInput({ filters: [{ field: 'status', values: ['active'] }] }),
    )
  ).body.spec.id;

  const deps = await api.get(`/api/specs/${specId}/dependencies`);
  assert.equal(deps.status, 200);
  assert.deepEqual(deps.body.fields, ['amountCents', 'region', 'status']);
  assert.equal(deps.body.affectedCount, 1);
  assert.equal(deps.body.affectedRecords[0].id !== undefined, true);

  app.server.close();
  app.close();
});

test('notifications are queryable after invalidation and include the sequence', async () => {
  const { app } = makeApp();
  const server = await startServer(app);
  const api = client(server.url);
  const rec = await api.post('/api/records', recordInput({}));
  const specId = (await api.post('/api/specs', specInput())).body.spec.id;

  app.invalidator.tick();
  await app.builder.idle();
  await api.patch(`/api/records/${rec.body.record.id}`, { amountCents: 777 });

  const payload = await api.get('/api/notifications');
  assert.equal(payload.status, 200);
  const invalidation = payload.body.notifications.find(
    (n) => n.kind === 'cache-invalidated' && n.specId === specId,
  );
  assert.ok(invalidation, 'invalidation notification exists');
  assert.equal(invalidation.payload.revision, 2);
  assert.equal(invalidation.payload.changedFields.includes('amountCents'), true);

  app.server.close();
  app.close();
});

test('spec config edit bumps the version, creates a new namespace, and rebuilds', async () => {
  const { app } = makeApp();
  const server = await startServer(app);
  const api = client(server.url);
  await api.post('/api/records', recordInput({}));
  const specRes = await api.post('/api/specs', specInput());
  const specId = specRes.body.spec.id;
  assert.equal(specRes.body.spec.configVersion, 1);
  const first = await api.get(`/api/specs/${specId}/result`);
  assert.equal(first.body.proof.configVersion, 1);

  const edited = await api.patch(`/api/specs/${specId}`, {
    config: {
      groupBy: ['region', 'category'],
      filters: [{ field: 'status', values: ['active'] }],
      measures: [{ id: 'count' }, { id: 'avg_amount' }],
    },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.spec.configVersion, 2);

  const second = await api.get(`/api/specs/${specId}/result`);
  assert.equal(second.status, 200);
  assert.equal(second.body.proof.configVersion, 2);
  assert.deepEqual(second.body.result.columns, ['region', 'category', 'count', 'avg_amount']);

  const versions = await api.get(`/api/specs/${specId}`);
  assert.equal(versions.body.versions.length, 2);
  const old = versions.body.versions.find((v) => v.configVersion === 1);
  assert.ok(fs.existsSync(app.store.versionDir(specId, 1, old.configHash)), 'old namespace retained');

  app.server.close();
  app.close();
});

test('revision conflict returns 409 with the current revision', async () => {
  const { app } = makeApp();
  const server = await startServer(app);
  const api = client(server.url);
  const rec = await api.post('/api/records', recordInput({ amountCents: 100 }));
  const ok = await api.patch(`/api/records/${rec.body.record.id}`, {
    amountCents: 200,
    expectedRevision: 1,
  });
  assert.equal(ok.status, 200);

  const conflict = await api.patch(`/api/records/${rec.body.record.id}`, {
    amountCents: 300,
    expectedRevision: 1,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.detail.actualRevision, 2);
  assert.equal(conflict.body.detail.current.amountCents, 200);

  app.server.close();
  app.close();
});

test('spec creation is visible in the state endpoint with watermark', async () => {
  const { app } = makeApp();
  const server = await startServer(app);
  const api = client(server.url);
  await api.post('/api/records', recordInput({}));
  await api.post('/api/specs', specInput());
  const state = await api.get('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.specs.length, 1);
  const spec = state.body.specs[0];
  assert.ok(spec.builtSeq >= spec.requiredSeq);
  assert.equal(spec.materialized, true);
  assert.ok(spec.publishedOutputDigest);
  assert.equal(spec.publishedOutputDigest.length, 64);
  app.server.close();
  app.close();
});
