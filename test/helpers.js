import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createApp } from '../src/server.js';

export function tempDir(prefix = 'rpc-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeApp(options = {}) {
  const dir = options.dataDir ?? tempDir();
  const app = createApp({
    dataDir: dir,
    startTimers: false,
    verifyIntervalMs: options.verifyIntervalMs ?? 0,
    builderDelays: options.builderDelays ?? {},
    invalidatorLossRate: options.invalidatorLossRate ?? 0,
  });
  return { app, dir };
}

export async function startServer(app) {
  const info = await app.listen(0);
  return info;
}

export function client(baseUrl) {
  const call = async (method, path, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const payload = text ? JSON.parse(text) : null;
    return { status: res.status, body: payload, headers: res.headers };
  };
  return {
    get: (path) => call('GET', path),
    post: (path, body = {}) => call('POST', path, body),
    patch: (path, body = {}) => call('PATCH', path, body),
    del: (path, body = {}) => call('DELETE', path, body),
    raw: (path) => fetch(baseUrl + path),
  };
}

export function specInput(overrides = {}) {
  return {
    name: overrides.name ?? '测试聚合',
    description: '',
    config: {
      groupBy: overrides.groupBy ?? ['region'],
      filters: overrides.filters ?? [],
      measures: overrides.measures ?? [{ id: 'count' }, { id: 'sum_amount' }],
    },
  };
}

export function recordInput(overrides = {}) {
  return {
    name: overrides.name ?? '记录',
    region: overrides.region ?? 'apac',
    status: overrides.status ?? 'active',
    category: overrides.category ?? 'subscription',
    amountCents: overrides.amountCents ?? 10_000,
    notes: overrides.notes ?? '',
  };
}

export async function buildFully(app) {
  app.invalidator.tick();
  await app.builder.idle();
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function artifactDirFor(app, spec) {
  return app.store.versionDir(spec.id, spec.configVersion, spec.configHash);
}

export async function settle(app, expected = 50) {
  for (let i = 0; i < expected; i += 1) {
    await app.builder.idle();
    await new Promise((r) => setTimeout(r, 5));
  }
}
