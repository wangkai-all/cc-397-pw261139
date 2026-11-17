#!/usr/bin/env node
/**
 * End-to-end demonstration of the invalidation contract. Prints every step so
 * the behavior is observable from a terminal, not just in tests.
 *
 *   node scripts/demo.js [workDir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createRecord, updateRecord, deleteRecord } from '../src/db/records.js';
import { createSpec, getSpec, getSpecState } from '../src/db/specs.js';
import { configHash } from '../src/lib/spec.js';

const workDir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-demo-'));
const dataDir = path.join(workDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const line = (label, value = '') => console.log(`  ${label.padEnd(22)} ${value}`);

const app = createApp({ dataDir, startTimers: false, verifyIntervalMs: 0 });
const specInput = {
  name: '按区域汇总收入',
  description: '掩饰例：显示区域收入合计与记录数',
  config: {
    groupBy: ['region'],
    filters: [{ field: 'status', values: ['active', 'paused'] }],
    measures: [{ id: 'count' }, { id: 'sum_amount' }],
  },
};

console.log(`\n=== 1. 冷启动：空目录 → 真实聚合与缓存文件 ===\ndata dir: ${dataDir}`);
const apac1 = createRecord(
  app.db,
  { name: '亚太客户甲', region: 'apac', status: 'active', category: 'services', amountCents: 120_000 },
  { source: 'seed' },
);
createRecord(
  app.db,
  { name: '欧非客户乙', region: 'emea', status: 'active', category: 'subscription', amountCents: 80_000 },
  { source: 'seed' },
);
createRecord(
  app.db,
  { name: '美洲客户丙', region: 'amer', status: 'archived', category: 'hardware', amountCents: 45_000 },
  { source: 'seed' },
);
const { spec } = createSpec(app.db, specInput);
app.invalidator.tick();
await app.builder.idle();

const artifactPath = app.store.versionDir(spec.id, spec.configVersion, spec.configHash);
line('spec id', spec.id);
line('config version', `v${spec.configVersion}`);
line('cache key', spec.cacheKey);
line('artifact dir', artifactPath);
line('files on disk', fs.readdirSync(artifactPath).join(', '));

let specNow = getSpec(app.db, spec.id);
let read = app.resultService.read(specNow, { policy: 'strict', autoRepair: false });
line('read status', read.status);
line('output digest', read.proof.outputDigest.slice(0, 24) + '…');
line('source digest', read.proof.depsDigest.slice(0, 24) + '…');
line('rows', JSON.stringify(read.artifact.data.rows));

console.log('\n=== 2. 修订一个被依赖的字段 ===');
updateRecord(app.db, apac1.record.id, { amountCents: 500_000 }, { source: 'demo' });
app.invalidator.tick();
let state = getSpecState(app.db, spec.id);
line('watermark after tick', `required=${state.requiredSeq} built=${state.builtSeq} (dirty)`);
read = app.resultService.read(specNow, { policy: 'watermark', autoRepair: false });
line('read before rebuild', `${read.status} (${read.reason ?? 'fresh'})`);
await app.builder.idle();
read = app.resultService.read(specNow, { policy: 'strict', autoRepair: false });
line('read after rebuild', read.status);
line('new output digest', read.proof.outputDigest.slice(0, 24) + '…');
line('apac sum', read.artifact.data.rows.find((r) => r.region === 'apac').sum_amount);

console.log('\n=== 3. 修订一个未被依赖的字段（名称） ===');
const before = app.store.readVerified(specNow.id, specNow.configVersion, specNow.configHash);
updateRecord(app.db, apac1.record.id, { name: '亚太客户甲（更名）' }, { source: 'demo' });
app.invalidator.tick();
await app.builder.idle();
const after = app.store.readVerified(specNow.id, specNow.configVersion, specNow.configHash);
line('generation before/after', `g${before.pointer.generation} / g${after.pointer.generation}`);
line('same bytes', String(before.dataHash === after.dataHash));

console.log('\n=== 4. 丢失失效通知 ===');
app.invalidator.pause();
updateRecord(app.db, apac1.record.id, { amountCents: 999_999 }, { source: 'demo' });
read = app.resultService.read(specNow, { policy: 'watermark', autoRepair: false });
line('read while disconnected', `${read.status} (${read.reason})`);
line('invalidation lag', String(read.proof.invalidationLag));
line('served bytes changed?', 'no — 拒绝返回已确认过期的旧数据');
app.invalidator.resume();
app.invalidator.tick();
await app.builder.idle();
read = app.resultService.read(specNow, { policy: 'strict', autoRepair: false });
line('read after resume', read.status);
line('apac sum now', read.artifact.data.rows.find((r) => r.region === 'apac').sum_amount);

console.log('\n=== 5. 重建中再次修订 ===');
const slowBuild = app.builder.runOnce(spec.id, {
  reason: 'demo-slow',
  simulate: { afterSnapshotDelayMs: 120 },
});
await new Promise((r) => setTimeout(r, 30));
updateRecord(app.db, apac1.record.id, { amountCents: 1_111_111 }, { source: 'demo' });
app.invalidator.tick();
const slowOutcome = await slowBuild;
await app.builder.idle();
line('slow build outcome', `${slowOutcome.ok ? 'published' : slowOutcome.reason} (stillStale=${slowOutcome.stillStale})`);
line('follow-up build', 'pump rebuilt from the newer snapshot');
read = app.resultService.read(specNow, { policy: 'strict', autoRepair: false });
line('served apac sum', read.artifact.data.rows.find((r) => r.region === 'apac').sum_amount);

console.log('\n=== 6. 下载缓存与版本证明 ===');
const download = app.downloads.create(specNow);
line('download id', download.id);
line('pinned generation', `g${download.generation}`);
line('expected bytes', String(download.expectedBytes));
const pinned = app.downloads.openPinned(download.id);
const bytes = fs.readFileSync(pinned.file);
app.downloads.markStreaming(download.id);
// Revision mid-download; pinned bytes are still served coherently.
updateRecord(app.db, apac1.record.id, { amountCents: 2_222_222 }, { source: 'demo' });
app.invalidator.tick();
await app.builder.idle();
const crypto = await import('node:crypto');
const receivedHash = crypto.createHash('sha256').update(bytes).digest('hex');
const completed = app.downloads.complete(download.id, {
  receivedHash,
  receivedBytes: bytes.length,
});
line('download status', completed.status);
line('superseded', String(completed.superseded));
line('current generation', String(completed.currentGeneration));
line('proof', completed.repairRequired ? '客户端必须重新下载后才可声称最新' : '与最新代次一致');

console.log('\n=== 7. 改变聚合配置 ===');
const { updateSpec } = await import('../src/db/specs.js');
const updated = updateSpec(app.db, spec.id, {
  config: {
    groupBy: ['region', 'category'],
    filters: [],
    measures: [{ id: 'count' }, { id: 'avg_amount' }],
  },
});
app.invalidator.tick();
await app.builder.idle();
line('config version', `v${updated.spec.configVersion}`);
line('new cache key', updated.spec.cacheKey);
line('old namespace kept', String(fs.existsSync(artifactPath)));
read = app.resultService.read(getSpec(app.db, spec.id), { policy: 'strict', autoRepair: false });
line('new columns', JSON.stringify(read.artifact.data.columns));

console.log('\n=== 8. 全量校验（字节级） ===');
const verify = app.resultService.verify(getSpec(app.db, spec.id));
line('verify ok', String(verify.ok));
for (const [name, ok] of Object.entries(verify.checks)) line(name, ok ? '✅' : '❌');
line('artifact output digest', verify.artifact.outputDigest.slice(0, 24) + '…');
line('live output digest', verify.live.outputDigest.slice(0, 24) + '…');

void deleteRecord;
void configHash;
console.log(`\n完成。数据目录保留在 ${dataDir}（可重复运行 node scripts/demo.js ${workDir}）。\n`);
app.close();
