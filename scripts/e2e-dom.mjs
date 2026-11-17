#!/usr/bin/env node
/**
 * DOM end-to-end check.
 *
 * jsdom does not execute `<script type="module">`, so this harness loads the
 * real index.html, installs the browser APIs the app uses (fetch, EventSource,
 * crypto.subtle) pointed at a live server seeded from an empty directory, and
 * then executes the real public/app.js in that window. Everything asserted
 * below is rendered by app.js itself from real HTTP responses.
 *
 *   node scripts/e2e-dom.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createApp } from '../src/server.js';
import { SEED_SPECS, buildSeedRecords } from '../src/seed.js';
import { createRecord } from '../src/db/records.js';
import { createSpec } from '../src/db/specs.js';

const outDir = path.join(process.cwd(), 'artifacts-e2e');
fs.mkdirSync(outDir, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-dom-'));

const app = createApp({ dataDir, startTimers: true, verifyIntervalMs: 500 });
const { url } = await app.listen(0);
for (const record of buildSeedRecords({ count: 18 })) {
  createRecord(app.db, record, { source: 'seed' });
}
for (const spec of SEED_SPECS) createSpec(app.db, spec, { source: 'seed' });
app.invalidator.tick();
await app.builder.idle();
console.log(`server: ${url}\ndata:   ${dataDir}`);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => errors.push(String(err)));
virtualConsole.on('error', (...args) => errors.push(args.join(' ')));

const html = fs.readFileSync(path.join(process.cwd(), 'public/index.html'), 'utf8');
const dom = new JSDOM(html, {
  url,
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;

// --- browser API shims wired to the live server ---
window.fetch = (input, init) => {
  const target = typeof input === 'string' && input.startsWith('/') ? url + input : input;
  return fetch(target, init);
};
Object.defineProperty(window, 'crypto', {
  configurable: true,
  value: { subtle: crypto.subtle, getRandomValues: (array) => crypto.getRandomValues(array) },
});

class EventSourceShim {
  constructor(target) {
    this.url = new URL(target, url).toString();
    this.listeners = new Map();
    this.readyState = 0;
    this.onerror = null;
    this._closed = false;
    this._connect();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  _emit(type, data) {
    // Real EventSource dispatches in a later task, after the caller has had a
    // chance to attach listeners. Match that so `hello` is not missed.
    setTimeout(() => {
      for (const fn of this.listeners.get(type) ?? []) fn({ data });
    }, 0);
  }
  async _connect() {
    try {
      const res = await fetch(this.url);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      this.readyState = 1;
      for (;;) {
        if (this._closed) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const eventLine = raw.split('\n').find((line) => line.startsWith('event: '));
          const dataLine = raw.split('\n').find((line) => line.startsWith('data: '));
          if (eventLine && dataLine) this._emit(eventLine.slice(7).trim(), dataLine.slice(6));
        }
      }
    } catch {
      if (!this._closed && this.onerror) this.onerror(new Error('sse-failed'));
    }
  }
  close() {
    this._closed = true;
    this.readyState = 2;
  }
}
window.EventSource = EventSourceShim;

window.eval(fs.readFileSync(path.join(process.cwd(), 'public/app.js'), 'utf8'));

// --- helpers ---
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => window.document.querySelector(sel)?.textContent ?? '';
const count = (sel) => window.document.querySelectorAll(sel).length;
const rows = () => [...window.document.querySelectorAll('#records-body tr')];
async function settle(ms = 400) {
  await wait(250);
  await fetch(`${url}/api/builder/idle`, { method: 'POST' });
  await wait(ms);
}
async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fn()) return true;
    } catch {
      // keep polling
    }
    await wait(80);
  }
  return false;
}
function openModal(action, dataId) {
  const btn = window.document.querySelector(
    `[data-action="${action}"]${dataId ? `[data-id="${dataId}"]` : ''}`,
  );
  btn.click();
}
function modalInput(name) {
  return window.document.querySelector(`.modal [name="${name}"]`);
}

try {
  await waitFor(() => count('.spec-card') === 3, 10_000);
  check('页面加载并渲染 3 个聚合卡片', count('.spec-card') === 3, String(count('.spec-card')));
  check('记录表渲染种子记录', count('#records-body tr') >= 15, String(count('#records-body tr')));
  await waitFor(() => /已连接/.test(text('#sse-badge')), 5000);
  check('SSE 状态为已连接', /已连接/.test(text('#sse-badge')), text('#sse-badge'));

  await waitFor(() => count('.badge.ok') >= 3, 8000);
  check('所有聚合初始为已证明最新', count('.badge.ok') >= 3, `${count('.badge.ok')}/3`);
  const proof = window.document.querySelector('.spec-card').textContent;
  check('证明显示构建水位', /构建水位/.test(proof));
  check('证明显示输出摘要', /输出摘要/.test(proof));
  check('证明显示证明哈希', /证明哈希/.test(proof));
  check('证明显示产物哈希', /产物哈希/.test(proof));

  const cardTextBefore = window.document.querySelector('.spec-card').textContent;
  const rowId = rows()[0].dataset.id;
  openModal('edit', rowId);
  await waitFor(() => documentHasSelector('.modal'));
  modalInput('amountCents').value = '7654300';
  await waitFor(() => window.document.querySelector('.modal [data-action="save-record"]'));
  window.document.querySelector('.modal [data-action="save-record"]').click();
  await waitFor(() => !documentHasSelector('.modal'), 8000);
  await settle(700);

  const updatedRow = rows().find((r) => r.dataset.id === rowId);
  check('记录修订号在 UI 中变为 r2', /r2/.test(updatedRow.textContent), updatedRow.textContent.slice(0, 60));
  await waitFor(() => count('.badge.ok') >= 3, 8000);
  check('修订后所有聚合重新证明为最新', count('.badge.ok') >= 3, `${count('.badge.ok')}/3`);
  const cardTextAfter = window.document.querySelector('.spec-card').textContent;
  check('证明内容随修订变化', cardTextAfter !== cardTextBefore);

  openModal('deps', undefined);
  await waitFor(() => documentHasSelector('.modal'));
  const depsText = window.document.querySelector('.modal').textContent;
  check('依赖视图列出依赖字段', /amountCents/.test(depsText));
  check('依赖视图报告受影响记录', /当前落入筛选范围的记录/.test(depsText));
  window.document.querySelector('.modal [data-action="close-modal"]').click();

  const genBefore = generationOfFirstCard();
  openModal('rebuild', undefined);
  await settle(900);
  const genAfter = generationOfFirstCard();
  check('手动重建推进代次', genAfter > genBefore, `${genBefore} -> ${genAfter}`);

  openModal('download', undefined);
  const downloaded = await waitFor(
    () => /下载哈希一致/.test(text('.spec-card .download-row')),
    12_000,
  );
  check('下载完成并显示哈希一致', downloaded, text('.spec-card .download-row').replace(/\s+/g, ' '));
  check('下载状态为 complete', /complete/.test(text('.spec-card .download-row')));

  window.document.querySelector('#btn-drop-notifications').click();
  await settle(500);
  check('断开通知写入日志', /已断开失效通知/.test(text('#log-feed')));
  check('通知徽标显示已断开', /已断开/.test(text('#sse-badge')), text('#sse-badge'));

  const row2 = rows()[1];
  openModal('edit', row2.dataset.id);
  await waitFor(() => documentHasSelector('.modal'));
  modalInput('amountCents').value = '42424200';
  window.document.querySelector('.modal [data-action="save-record"]').click();
  await waitFor(() => !documentHasSelector('.modal'), 8000);
  await settle(600);

  window.document.querySelector('#btn-restore-notifications').click();
  await settle(1000);
  await waitFor(() => count('.badge.ok') >= 3, 9000);
  check('恢复通知后所有聚合重新证明为最新', count('.badge.ok') >= 3, `${count('.badge.ok')}/3`);

  const policy = window.document.querySelector('#read-policy');
  policy.value = 'strict';
  policy.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(900);
  check('严格策略显示 full 校验', /full/.test(text('.spec-card .proof-grid')));

  openModal('verify', undefined);
  await waitFor(() => documentHasSelector('.modal'));
  const verifyText = window.document.querySelector('.modal').textContent;
  check('校验弹窗展示全量校验', /全量校验/.test(verifyText));
  check('校验弹窗展示通过项', /✅/.test(verifyText));
  window.document.querySelector('.modal [data-action="close-modal"]').click();

  window.document.querySelector('#btn-new-spec').click();
  await waitFor(() => documentHasSelector('.modal'));
  modalInput('name').value = '浏览器新增的聚合';
  window.document.querySelector('.modal [data-action="save-spec"]').click();
  await waitFor(() => !documentHasSelector('.modal'), 8000);
  await settle(900);
  check('通过 UI 新增聚合后出现第 4 张卡片', count('.spec-card') === 4, String(count('.spec-card')));

  fs.writeFileSync(path.join(outDir, 'rendered.html'), window.document.documentElement.outerHTML);
  const state = await (await fetch(`${url}/api/state`)).json();
  check('服务端状态包含 4 个聚合', state.specs.length === 4, String(state.specs.length));
  check(
    '每个聚合都有 64 位发布摘要',
    state.specs.every((spec) => spec.publishedOutputDigest?.length === 64),
  );
  check('无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (err) {
  check('DOM 端到端脚本未抛异常', false, String(err?.stack ?? err));
  fs.writeFileSync(
    path.join(outDir, 'error.html'),
    window.document.documentElement.outerHTML,
  );
} finally {
  dom.window.close();
  app.close();
  await new Promise((r) => setTimeout(r, 200));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

function documentHasSelector(sel) {
  return Boolean(window.document.querySelector(sel));
}

function generationOfFirstCard() {
  const card = window.document.querySelector('.spec-card');
  const dt = [...card.querySelectorAll('dt')].find((n) => n.textContent.includes('代次'));
  return Number(dt?.nextElementSibling?.textContent?.replace('g', ''));
}

function failedCount() {
  return results.filter((r) => !r.ok).length;
}
