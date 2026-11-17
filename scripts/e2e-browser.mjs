#!/usr/bin/env node
/**
 * Browser end-to-end check. Requires playwright-core + a chromium build.
 *
 *   npm_config_cache=/tmp/npmcache npx playwright-core install chromium
 *   node scripts/e2e-browser.mjs
 *
 * It starts the server on an empty data directory, drives the real UI, and
 * asserts the version proofs rendered in the DOM. Screenshots are written to
 * ./artifacts-e2e/.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../src/server.js';
import { SEED_SPECS, buildSeedRecords } from '../src/seed.js';
import { createRecord } from '../src/db/records.js';
import { createSpec } from '../src/db/specs.js';

const shotsDir = path.join(process.cwd(), 'artifacts-e2e');
fs.mkdirSync(shotsDir, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-e2e-'));

const app = createApp({ dataDir, startTimers: true, verifyIntervalMs: 1000 });
const { url } = await app.listen(0);
console.log(`server: ${url}  data: ${dataDir}`);

for (const record of buildSeedRecords({ count: 18 })) {
  createRecord(app.db, record, { source: 'seed' });
}
for (const spec of SEED_SPECS) createSpec(app.db, spec, { source: 'seed' });
app.invalidator.tick();
await app.builder.idle();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitIdle() {
  await page.waitForTimeout(350);
  await page.evaluate(() => fetch('/api/builder/idle', { method: 'POST' }));
  await page.waitForTimeout(250);
}

try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.spec-card');
  check('页面加载并渲染聚合卡片', (await page.locator('.spec-card').count()) === 3);
  check('记录表已渲染', (await page.locator('#records-body tr').count()) > 0);
  check(
    '每个聚合都显示“已证明最新”',
    (await page.locator('.badge.ok', { hasText: '已证明最新' }).count()) === 3,
  );
  const proofText = await page.locator('.spec-card').first().innerText();
  check('证明包含输出摘要', /输出摘要/.test(proofText));
  check('证明包含产物哈希', /产物哈希/.test(proofText));
  check('证明包含构建水位', /构建水位/.test(proofText));

  await page.screenshot({ path: path.join(shotsDir, '01-initial.png'), fullPage: true });

  // ---- edit a source record via the modal ----
  const firstRow = page.locator('#records-body tr').first();
  const rowId = await firstRow.getAttribute('data-id');
  const specCardsBefore = await page.locator('.spec-card').first().innerText();
  await firstRow.locator('[data-action="edit"]').click();
  await page.waitForSelector('.modal');
  const amountInput = page.locator('.modal input[name="amountCents"]');
  await amountInput.fill('1234500');
  await page.locator('.modal [data-action="save-record"]').click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await waitIdle();
  await page.waitForTimeout(600);

  const revisedText = await page.locator('#records-body tr', { has: page.locator(`button[data-id="${rowId}"]`) }).innerText();
  check('记录修订号在 UI 中递增', /r2/.test(revisedText), revisedText.split('\n').slice(-2).join(' '));

  const afterEdit = await page.locator('.spec-card').first().innerText();
  check('受影响聚合显示新的输出摘要', afterEdit !== specCardsBefore);
  await page.screenshot({ path: path.join(shotsDir, '02-after-edit.png'), fullPage: true });

  // ---- inspect dependencies ----
  await page.locator('.spec-card').first().locator('[data-action="deps"]').click();
  await page.waitForSelector('.modal');
  const depsText = await page.locator('.modal').innerText();
  check('依赖视图列出依赖字段', /amountCents/.test(depsText));
  check('依赖视图列出受影响记录数', /当前落入筛选范围的记录/.test(depsText));
  await page.locator('.modal [data-action="close-modal"]').click();

  // ---- trigger a rebuild and confirm generation advances ----
  const genBefore = Number(
    (await page.locator('.spec-card').first().locator('dt', { hasText: '代次' }).locator('xpath=following-sibling::dd'  ).innerText()).replace('g', ''),
  );
  await page.locator('.spec-card').first().locator('[data-action="rebuild"]').click();
  await waitIdle();
  await page.waitForTimeout(500);
  const genAfter = Number(
    (await page.locator('.spec-card').first().locator('dt', { hasText: '代次' }).locator('xpath=following-sibling::dd').innerText()).replace('g', ''),
  );
  check('手动重建推进代次', genAfter > genBefore, `${genBefore} -> ${genAfter}`);

  // ---- download cache ----
  await page.locator('.spec-card').first().locator('[data-action="download"]').click();
  await page.waitForTimeout(1200);
  await waitIdle();
  const dlText = await page.locator('.spec-card').first().locator('.download-row').innerText();
  check('下载完成后展示哈希一致', /complete/.test(dlText) && /下载哈希一致/.test(dlText), dlText.replace(/\n/g, ' '));
  await page.screenshot({ path: path.join(shotsDir, '03-download.png'), fullPage: true });

  // ---- disconnect notifications, change data, then recover ----
  await page.locator('#btn-drop-notifications').click();
  await page.waitForTimeout(400);
  const feedAfterDrop = await page.locator('#notification-feed').innerText();
  check('断开通知后仍保留历史通知', feedAfterDrop.length > 0);

  // Change a record while notifications are conceptually lost.
  const secondRow = page.locator('#records-body tr').nth(1);
  await secondRow.locator('[data-action="edit"]').click();
  await page.waitForSelector('.modal');
  await page.locator('.modal input[name="amountCents"]').fill('99999900');
  await page.locator('.modal [data-action="save-record"]').click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForTimeout(400);
  await page.locator('#btn-restore-notifications').click();
  await waitIdle();
  await page.waitForTimeout(800);
  const restoredCards = await page.locator('.badge.ok', { hasText: '已证明最新' }).count();
  check('恢复通知后所有聚合重新证明为最新', restoredCards === 3, `${restoredCards}/3`);
  await page.screenshot({ path: path.join(shotsDir, '04-restored.png'), fullPage: true });

  // ---- strict read policy ----
  await page.selectOption('#read-policy', 'strict');
  await page.waitForTimeout(800);
  const strictProof = await page.locator('.spec-card').first().innerText();
  check('严格策略下校验方式为 full', /full/.test(strictProof));

  // ---- verify endpoint drives a modal with checks ----
  await page.locator('.spec-card').first().locator('[data-action="verify"]').click();
  await page.waitForSelector('.modal');
  const verifyText = await page.locator('.modal').innerText();
  check('校验弹窗显示通过项', /全量校验/.test(verifyText) && /✅/.test(verifyText));
  await page.locator('.modal [data-action="close-modal"]').click();

  // ---- add a new spec through the UI ----
  await page.locator('#btn-new-spec').click();
  await page.waitForSelector('.modal');
  await page.locator('.modal input[name="name"]').fill('浏览器新增的聚合');
  await page.locator('.modal [data-action="save-spec"]').click();
  await page.waitForSelector('.modal', { state: 'detached' });
  await waitIdle();
  await page.waitForTimeout(600);
  check('通过 UI 新增聚合后出现第 4 张卡片', (await page.locator('.spec-card').count()) === 4);
  await page.screenshot({ path: path.join(shotsDir, '05-new-spec.png'), fullPage: true });

  // ---- refresh persistence ----
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.spec-card');
  await waitIdle();
  check('刷新后聚合仍在', (await page.locator('.spec-card').count()) === 4);
  check('刷新后记录仍在', (await page.locator('#records-body tr').count()) > 0);

  check('无浏览器控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('端到端脚本未抛异常', false, String(err));
  await page.screenshot({ path: path.join(shotsDir, 'error.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  app.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('failures:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}
