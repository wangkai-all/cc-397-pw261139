const state = {
  catalog: null,
  records: [],
  specs: [],
  seq: 0,
  policyInput: 'watermark',
  notifications: [],
  invalidatorStats: null,
  sse: null,
  sseDesired: true,
  autoRefresh: true,
  specViews: new Map(),
  downloads: new Map(),
  busy: new Set(),
  filterStatus: '',
  search: '',
};

const el = (id) => document.getElementById(id);
const labels = {};

function dimLabel(field, value) {
  const dim = state.catalog?.dimensions?.find((d) => d.id === field);
  const found = dim?.values?.find((v) => v.value === value);
  return found ? found.label : value;
}
function dimName(field) {
  return state.catalog?.dimensions?.find((d) => d.id === field)?.label ?? field;
}
function measureName(id) {
  return state.catalog?.measures?.find((m) => m.id === id)?.label ?? id;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function short(hash, n = 12) {
  if (!hash) return '—';
  return hash.slice(0, n);
}

function timeLabel(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    const error = new Error(payload?.error ?? `HTTP ${res.status}`);
    error.status = res.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  el('toast-root').append(node);
  setTimeout(() => node.remove(), 4200);
}

function log(message, kind = '') {
  const li = document.createElement('li');
  if (kind) li.className = kind;
  li.innerHTML = `<time>${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</time>${escapeHtml(message)}`;
  const feed = el('log-feed');
  feed.prepend(li);
  while (feed.children.length > 60) feed.lastChild.remove();
}

function setBusy(key, busy) {
  if (busy) state.busy.add(key);
  else state.busy.delete(key);
  renderSpecs();
}

// ---------------------------------------------------------------- loading

async function loadAll() {
  const [catalog, recordsPayload, specsPayload, stats] = await Promise.all([
    api('/catalog'),
    api('/records'),
    api('/specs'),
    api('/invalidator/stats'),
  ]);
  state.catalog = catalog;
  state.records = recordsPayload.records;
  state.seq = recordsPayload.seq;
  state.specs = specsPayload.specs;
  state.invalidatorStats = stats;
  renderAll();
}

async function reloadRecords() {
  const payload = await api('/records');
  state.records = payload.records;
  state.seq = payload.seq;
  renderRecords();
  renderStatusStrip();
}

async function reloadSpecs() {
  const payload = await api('/specs');
  state.specs = payload.specs;
  renderSpecs();
  renderStatusStrip();
}

async function loadResult(specId, { quiet = false } = {}) {
  const policy = state.policyInput;
  try {
    const payload = await api(`/specs/${specId}/result?policy=${encodeURIComponent(policy)}`);
    state.specViews.set(specId, { kind: 'fresh', payload, at: Date.now() });
  } catch (err) {
    if (err.status === 409 || err.status === 503) {
      state.specViews.set(specId, { kind: 'stale', payload: err.payload, at: Date.now() });
    } else {
      state.specViews.set(specId, { kind: 'error', payload: err.payload ?? { error: err.message }, at: Date.now() });
      if (!quiet) log(`读取结果失败：${err.message}`, 'error');
    }
  }
  renderSpecs();
}

async function loadDownloads(specId) {
  const payload = await api(`/specs/${specId}/downloads`);
  state.downloads.set(specId, payload.downloads[0] ?? null);
  return payload.downloads[0] ?? null;
}

async function loadNotifications() {
  const payload = await api('/notifications?limit=40');
  state.notifications = payload.notifications;
  renderNotifications();
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderRecords();
  renderSpecs();
  renderStatusStrip();
  renderNotifications();
  for (const spec of state.specs) loadResult(spec.id, { quiet: true });
  for (const spec of state.specs) loadDownloads(spec.id).catch(() => {});
}

function renderStatusStrip() {
  el('seq-badge').textContent = String(state.seq);
  el('pending-badge').textContent = String(state.invalidatorStats?.pending ?? '–');
  const badge = el('sse-badge');
  badge.textContent = state.sse ? '已连接' : '已断开';
  badge.className = state.sse ? 'on' : 'off';
  const dirty = state.specs.filter((s) => s.requiredSeq > s.builtSeq).length;
  document.title = `${dirty > 0 ? `(${dirty}) ` : ''}修订可证明的物化缓存`;
}

function renderRecords() {
  const body = el('records-body');
  const filtered = state.records.filter((r) => {
    if (state.filterStatus && r.status !== state.filterStatus) return false;
    if (state.search && !r.name.toLowerCase().includes(state.search.toLowerCase())) return false;
    return true;
  });
  el('record-count').textContent = `${filtered.length} / ${state.records.length} 条`;
  if (filtered.length === 0) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty">没有匹配的记录</div></td></tr>`;
    return;
  }
  body.innerHTML = filtered
    .map(
      (r) => `
      <tr data-id="${escapeHtml(r.id)}">
        <td class="name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>
        <td>${escapeHtml(dimLabel('region', r.region))}</td>
        <td>${escapeHtml(dimLabel('status', r.status))}</td>
        <td>${escapeHtml(dimLabel('category', r.category))}</td>
        <td class="num">${r.amountCents.toLocaleString('zh-CN')}</td>
        <td class="num"><span class="rev-badge">r${r.revision}</span></td>
        <td>
          <div class="row-actions">
            <button class="tiny" data-action="edit" data-id="${escapeHtml(r.id)}">编辑</button>
            <button class="tiny danger" data-action="delete" data-id="${escapeHtml(r.id)}">删除</button>
          </div>
        </td>
      </tr>`,
    )
    .join('');
}

function renderNotifications() {
  const feed = el('notification-feed');
  const items = [...state.notifications].reverse();
  el('notif-count').textContent = items.length ? `${items.length} 条` : '';
  if (items.length === 0) {
    feed.innerHTML = `<li class="empty">暂无通知</li>`;
    return;
  }
  feed.innerHTML = items
    .slice(0, 40)
    .map((n) => {
      const spec = state.specs.find((s) => s.id === n.specId);
      const name = spec ? spec.name : n.specId;
      if (n.kind === 'cache-invalidated') {
        const p = n.payload;
        return `<li class="invalidated">#${n.changeSeq} 失效 ${escapeHtml(name)} · ${escapeHtml(p.accountId)} r${p.revision} · ${escapeHtml(p.reason)}${p.changedFields?.length ? ` (${escapeHtml(p.changedFields.join(','))})` : ''}</li>`;
      }
      if (n.kind === 'spec-config-changed') {
        return `<li class="invalidated">#${n.changeSeq} 配置 → ${escapeHtml(name)} v${n.payload.configVersion}</li>`;
      }
      return `<li>#${n.changeSeq} ${escapeHtml(n.kind)} ${escapeHtml(name)}</li>`;
    })
    .join('');
}

function specCardHtml(spec) {
  const view = state.specViews.get(spec.id);
  const download = state.downloads.get(spec.id) ?? null;
  const busy = state.busy.has(spec.id);
  const dirty = spec.requiredSeq > spec.builtSeq;
  const fresh = view?.kind === 'fresh';
  const cardClass = fresh ? 'fresh' : 'stale';
  const statusBadge = busy
    ? `<span class="badge neutral">重建中…</span>`
    : fresh
      ? `<span class="badge ok">已证明最新</span>`
      : view?.kind === 'stale'
        ? `<span class="badge warn">需要重建</span>`
        : view?.kind === 'error'
          ? `<span class="badge err">读取失败</span>`
          : `<span class="badge neutral">读取中…</span>`;

  const configChips = [
    ...spec.config.groupBy.map((f) => `<span class="chip">分组 ${escapeHtml(dimName(f))}</span>`),
    ...spec.config.filters.map(
      (f) => `<span class="chip">筛选 ${escapeHtml(dimName(f.field))}=${escapeHtml(f.values.map((v) => dimLabel(f.field, v)).join('/'))}</span>`,
    ),
    ...spec.config.measures.map((m) => `<span class="chip">${escapeHtml(measureName(m.id))}</span>`),
  ].join('');

  const payload = view?.payload;
  const proof = view?.kind === 'fresh' ? payload.proof : view?.payload?.proof ?? null;
  const proofHtml = proof ? renderProof(proof) : `<div class="empty">尚未构建</div>`;

  const resultHtml =
    view?.kind === 'fresh'
      ? renderResultTable(payload.result)
      : view?.kind === 'stale'
        ? `<div class="empty">${escapeHtml(staleMessage(view.payload?.reason))}</div>`
        : '';

  const downloadHtml = renderDownloadRow(spec, download);

  return `
    <article class="spec-card ${cardClass}" data-spec="${escapeHtml(spec.id)}">
      <div class="spec-head">
        <div class="spec-title">
          <strong>${escapeHtml(spec.name)}</strong>
          <span class="meta">${escapeHtml(spec.id)} · v${spec.configVersion} · ${escapeHtml(short(spec.configHash))}</span>
        </div>
        <div class="spec-actions">
          ${statusBadge}
          <button class="tiny" data-action="refresh-result" data-id="${escapeHtml(spec.id)}" ${busy ? 'disabled' : ''}>读取</button>
          <button class="tiny" data-action="verify" data-id="${escapeHtml(spec.id)}">校验</button>
          <button class="tiny" data-action="rebuild" data-id="${escapeHtml(spec.id)}" ${busy ? 'disabled' : ''}>重建</button>
          <button class="tiny" data-action="edit-spec" data-id="${escapeHtml(spec.id)}">配置</button>
          <button class="tiny" data-action="deps" data-id="${escapeHtml(spec.id)}">依赖</button>
          <button class="tiny" data-action="download" data-id="${escapeHtml(spec.id)}">下载</button>
        </div>
      </div>
      <div class="spec-body">
        <div class="spec-config">${configChips}</div>
        <div class="proof-grid">${proofHtml}</div>
        ${resultHtml}
        ${downloadHtml}
      </div>
    </article>`;
}

function staleMessage(reason) {
  switch (reason) {
    case 'source-watermark-ahead':
      return '源记录已修订，现有物化结果不再代表当前数据。已自动排入重建队列。';
    case 'full-verify-mismatch':
      return '全量校验发现物化结果与源数据不一致（通知可能丢失）。已自动排入重建队列。';
    case 'newer-artifact-exists':
      return '存在比当前证明更新的物化产物，正在切换。';
    case 'config-version-changed':
    case 'config-hash-changed':
      return '聚合配置已修改，旧结果属于历史命名空间。';
    case 'unbuilt':
      return '尚未构建。';
    case 'no-artifact':
      return '没有可用的物化产物。';
    default:
      return '结果不是最新版本。';
  }
}

function renderProof(proof) {
  const freshBadge = proof.fresh
    ? `<span class="badge ok">版本证明有效</span>`
    : `<span class="badge warn">${escapeHtml(proof.staleReason ?? 'stale')}</span>`;
  return `
    <div><dt>证明</dt><dd>${freshBadge}</dd></div>
    <div><dt>校验方式</dt><dd>${escapeHtml(proof.verification)}</dd></div>
    <div><dt>代次</dt><dd>g${escapeHtml(proof.generation)}</dd></div>
    <div><dt>构建</dt><dd>${escapeHtml(short(proof.buildId, 22))}</dd></div>
    <div><dt>构建水位</dt><dd>seq ${escapeHtml(proof.builtSeq)} / 要求 ${escapeHtml(proof.requiredSeq)}</dd></div>
    <div><dt>读取序号</dt><dd>seq ${escapeHtml(proof.readSeq)}</dd></div>
    <div><dt>输出摘要</dt><dd class="hash">${escapeHtml(short(proof.outputDigest, 20))}</dd></div>
    <div><dt>源摘要（依赖切片）</dt><dd class="hash">${escapeHtml(short(proof.depsDigest, 20))}</dd></div>
    <div><dt>产物哈希</dt><dd class="hash">${escapeHtml(short(proof.dataHash, 20))}</dd></div>
    <div><dt>证明哈希</dt><dd class="hash">${escapeHtml(short(proof.proofHash, 20))}</dd></div>
    <div><dt>行数</dt><dd>${escapeHtml(proof.rowCount ?? '—')}</dd></div>
    <div><dt>配置版本</dt><dd>v${escapeHtml(proof.configVersion)}</dd></div>`;
}

function renderResultTable(result) {
  if (!result || !result.rows) return '';
  const columns = result.columns ?? [];
  const head = columns
    .map((col) => `<th class="${col === 'count' || col.includes('amount') ? 'num' : ''}">${escapeHtml(result.columnLabels?.[col] ?? col)}</th>`)
    .join('');
  const body = result.rows
    .map(
      (row) =>
        `<tr>${columns
          .map((col) => {
            const raw = row[col];
            const isDimension = ['region', 'status', 'category'].includes(col);
            const val = isDimension ? dimLabel(col, raw) : Number(raw).toLocaleString('zh-CN');
            return `<td class="${isDimension ? '' : 'num'}">${escapeHtml(val)}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  return `
    <div class="result-wrap">
      <table class="result-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${body || `<tr><td colspan="${columns.length}"><div class="empty">无数据行</div></td></tr>`}</tbody>
      </table>
    </div>`;
}

function renderDownloadRow(spec, download) {
  const statusText = download
    ? `${download.status} · g${download.generation} · ${download.receivedBytes ?? 0}/${download.expectedBytes} B`
    : '浏览器尚未下载';
  const mismatch =
    download && download.status === 'superseded'
      ? `<span class="badge warn">下载已过期</span>`
      : download && download.status === 'complete'
        ? `<span class="badge ok">下载哈希一致</span>`
        : '';
  return `
    <div class="download-row">
      <span>浏览器缓存：${escapeHtml(statusText)}</span>
      ${mismatch}
      <span class="hash">${download ? escapeHtml(short(download.dataHash, 16)) : ''}</span>
      <div class="progress"><i data-progress="${escapeHtml(spec.id)}"></i></div>
    </div>`;
}

function renderSpecs() {
  const list = el('spec-list');
  if (state.specs.length === 0) {
    list.innerHTML = `<div class="empty">还没有聚合定义。点击「新增聚合」创建第一个。</div>`;
    return;
  }
  list.innerHTML = state.specs.map(specCardHtml).join('');
  for (const [specId, download] of state.downloads) {
    const bar = document.querySelector(`[data-progress="${specId}"]`);
    if (!bar || !download) continue;
    const pct = download.expectedBytes
      ? Math.round(((download.receivedBytes ?? 0) / download.expectedBytes) * 100)
      : 0;
    bar.style.width = `${download.status === 'complete' ? 100 : pct}%`;
  }
}

// ---------------------------------------------------------------- actions

async function saveRecord(id) {
  const form = el('modal-root').querySelector('form');
  const data = Object.fromEntries(new FormData(form).entries());
  data.amountCents = Number(data.amountCents);
  const existing = state.records.find((r) => r.id === id);
  try {
    if (id) {
      const payload = await api(`/records/${id}`, {
        method: 'PATCH',
        body: { ...data, expectedRevision: existing.revision },
      });
      log(
        payload.noop
          ? `记录 ${id} 无变化`
          : `记录 ${id} 修订 → r${payload.revision}，字段 ${payload.changedFields.join(',')}`,
      );
      toast(payload.noop ? '没有字段变化' : `已修订到 r${payload.revision}`);
    } else {
      const payload = await api('/records', { method: 'POST', body: data });
      log(`新增记录 ${payload.record.id}`);
      toast('记录已创建');
    }
    closeModal();
    await Promise.all([reloadRecords(), reloadSpecs(), loadNotifications()]);
    await Promise.all(state.specs.map((s) => loadResult(s.id, { quiet: true })));
  } catch (err) {
    if (err.status === 409) {
      toast('修订冲突：记录已被其他操作修改，已刷新最新内容', 'warn');
      await reloadRecords();
    } else {
      toast(err.message, 'error');
    }
  }
}

async function removeRecord(id) {
  const record = state.records.find((r) => r.id === id);
  if (!record) return;
  if (!confirm(`删除记录「${record.name}」？`)) return;
  try {
    await api(`/records/${id}`, { method: 'DELETE', body: { expectedRevision: record.revision } });
    log(`删除记录 ${id}`);
    await Promise.all([reloadRecords(), reloadSpecs(), loadNotifications()]);
    await Promise.all(state.specs.map((s) => loadResult(s.id, { quiet: true })));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openRecordModal(record) {
  const isEdit = Boolean(record);
  const root = el('modal-root');
  root.hidden = false;
  root.innerHTML = `
    <div class="modal">
      <h3>${isEdit ? `编辑记录 r${record.revision}` : '新增记录'}</h3>
      <form class="form-grid" onsubmit="return false">
        <label class="full">名称
          <input name="name" required maxlength="120" value="${escapeHtml(record?.name ?? '')}" />
        </label>
        <label>区域
          <select name="region">${optionsFor('region', record?.region)}</select>
        </label>
        <label>状态
          <select name="status">${optionsFor('status', record?.status)}</select>
        </label>
        <label>品类
          <select name="category">${optionsFor('category', record?.category)}</select>
        </label>
        <label>金额（分）
          <input name="amountCents" type="number" min="0" step="100" required value="${record?.amountCents ?? 100000}" />
        </label>
        <label class="full">备注
          <textarea name="notes">${escapeHtml(record?.notes ?? '')}</textarea>
        </label>
      </form>
      <div class="modal-actions">
        <button type="button" data-action="close-modal">取消</button>
        <button type="button" class="primary" data-action="save-record" data-id="${record?.id ?? ''}">保存</button>
      </div>
    </div>`;
}

function optionsFor(field, selected) {
  const dim = state.catalog?.dimensions?.find((d) => d.id === field);
  return (dim?.values ?? [])
    .map((v) => `<option value="${v.value}" ${v.value === selected ? 'selected' : ''}>${escapeHtml(v.label)}</option>`)
    .join('');
}

function openSpecModal(spec) {
  const isEdit = Boolean(spec);
  const config = spec?.config ?? { groupBy: ['region'], filters: [], measures: [{ id: 'count' }] };
  const root = el('modal-root');
  root.hidden = false;
  root.innerHTML = `
    <div class="modal">
      <h3>${isEdit ? '修改聚合配置' : '新增聚合'}</h3>
      <form class="form-grid" onsubmit="return false">
        <label class="full">名称
          <input name="name" required maxlength="80" value="${escapeHtml(spec?.name ?? '')}" />
        </label>
        <label class="full">描述
          <input name="description" maxlength="500" value="${escapeHtml(spec?.description ?? '')}" />
        </label>
        <label class="full">分组字段（最多 2 个）
          <select name="groupBy" multiple size="3">
            ${state.catalog.dimensions
              .map((d) => `<option value="${d.id}" ${config.groupBy.includes(d.id) ? 'selected' : ''}>${escapeHtml(d.label)}</option>`)
              .join('')}
          </select>
        </label>
        <label class="full">指标
          <select name="measures" multiple size="5">
            ${state.catalog.measures
              .map((m) => `<option value="${m.id}" ${config.measures.some((x) => x.id === m.id) ? 'selected' : ''}>${escapeHtml(m.label)}</option>`)
              .join('')}
          </select>
        </label>
        <label class="full">筛选条件（JSON，可留空）
          <textarea name="filters" spellcheck="false">${escapeHtml(JSON.stringify(config.filters, null, 2))}</textarea>
        </label>
      </form>
      <p class="hint">修改会提升配置版本，生成新的缓存命名空间；旧产物保留为历史版本。</p>
      <div class="modal-actions">
        <button type="button" data-action="close-modal">取消</button>
        <button type="button" class="primary" data-action="save-spec" data-id="${spec?.id ?? ''}">保存</button>
      </div>
    </div>`;
}

function readSpecForm() {
  const form = el('modal-root').querySelector('form');
  const data = new FormData(form);
  const groupBy = Array.from(form.querySelector('[name="groupBy"]').selectedOptions).map((o) => o.value);
  const measures = Array.from(form.querySelector('[name="measures"]').selectedOptions).map((o) => ({ id: o.value }));
  let filters = [];
  const raw = String(data.get('filters') ?? '').trim();
  if (raw) {
    try {
      filters = JSON.parse(raw);
    } catch {
      throw new Error('筛选条件不是合法 JSON');
    }
  }
  return {
    name: String(data.get('name')),
    description: String(data.get('description') ?? ''),
    config: { groupBy, filters, measures },
  };
}

async function saveSpec(id) {
  let body;
  try {
    body = readSpecForm();
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  if (body.config.groupBy.length === 0) return toast('至少选择一个分组字段', 'error');
  if (body.config.measures.length === 0) return toast('至少选择一个指标', 'error');
  try {
    const payload = await api(id ? `/specs/${id}` : '/specs', {
      method: id ? 'PATCH' : 'POST',
      body,
    });
    log(`${id ? '更新' : '创建'}聚合 ${payload.spec.id}（配置 v${payload.spec.configVersion}）`);
    closeModal();
    await Promise.all([reloadSpecs(), loadNotifications()]);
    await loadResult(payload.spec.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function rebuild(specId, { simulate = {} } = {}) {
  setBusy(specId, true);
  try {
    const outcome = await api(`/specs/${specId}/build`, { method: 'POST', body: simulate });
    if (outcome.ok) {
      log(`重建完成 g${outcome.generation} · seq ${outcome.builtSeq} · ${outcome.rows} 行`);
      toast(`已重建 g${outcome.generation}`);
    } else if (outcome.reason === 'superseded') {
      log(`重建被更新代次 g${outcome.supersededBy} 取代`, 'error');
      toast(`旧重建完成较晚，已丢弃（较新代次 g${outcome.supersededBy} 保留）`, 'warn');
    } else {
      log(`重建未完成：${outcome.reason} ${outcome.error ?? ''}`, 'error');
      toast(`重建未完成：${outcome.reason}`, 'warn');
    }
    await Promise.all([reloadSpecs(), loadNotifications()]);
    await loadResult(specId);
    await loadDownloads(specId);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(specId, false);
  }
}

async function verify(specId) {
  try {
    const payload = await api(`/specs/${specId}/verify`);
    const failed = Object.entries(payload.checks).filter(([, ok]) => !ok).map(([k]) => k);
    if (payload.ok) {
      log(`全量校验通过 ${specId} · 输出 ${short(payload.live.outputDigest)}`);
      toast('全量校验通过：产物与源数据一致');
    } else {
      log(`全量校验失败 ${specId}：${failed.join(',')}`, 'error');
      toast(`校验未通过：${failed.join(',')}`, 'error');
    }
    showVerifyModal(payload);
    await loadResult(specId);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function showVerifyModal(payload) {
  const root = el('modal-root');
  root.hidden = false;
  const checks = Object.entries(payload.checks)
    .map(([key, ok]) => `<li>${ok ? '✅' : '❌'} <code>${escapeHtml(key)}</code></li>`)
    .join('');
  root.innerHTML = `
    <div class="modal">
      <h3>全量校验 · ${escapeHtml(payload.status)}</h3>
      <ul class="feed">${checks}</ul>
      <pre class="small" style="white-space:pre-wrap; font-family:var(--mono); font-size:11px; background:var(--bg-raised); padding:10px; border-radius:8px; border:1px solid var(--border); overflow:auto; max-height:300px;">${escapeHtml(JSON.stringify({ live: payload.live, artifact: payload.artifact, proof: payload.proof }, null, 2))}</pre>
      <div class="modal-actions"><button type="button" class="primary" data-action="close-modal">关闭</button></div>
    </div>`;
}

async function showDependencies(specId) {
  try {
    const payload = await api(`/specs/${specId}/dependencies`);
    const rows = payload.affectedRecords
      .map((r) => `<li>${escapeHtml(r.id)} <span class="muted">r${r.revision}</span> ${escapeHtml(JSON.stringify(r.values))}</li>`)
      .join('');
    const root = el('modal-root');
    root.hidden = false;
    root.innerHTML = `
      <div class="modal">
        <h3>依赖与受影响缓存</h3>
        <p class="small muted">依赖字段：${payload.fields.map((f) => `<span class="chip">${escapeHtml(f)}</span>`).join(' ')}<br/>
        当前落入筛选范围的记录：${payload.affectedCount} 条 · 水位 seq ${payload.state.builtSeq}/${payload.state.requiredSeq} ${payload.state.dirty ? '（待重建）' : '（最新）'}</p>
        <ol class="feed" style="max-height:260px">${rows || '<li class="empty">无匹配记录</li>'}</ol>
        <div class="modal-actions"><button type="button" class="primary" data-action="close-modal">关闭</button></div>
      </div>`;
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function startDownload(specId) {
  try {
    const created = await api(`/specs/${specId}/downloads`, { method: 'POST', body: {} });
    log(`开始下载 ${created.id} · g${created.generation} · ${created.expectedBytes} B`);
    const res = await fetch(created.downloadUrl);
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const bar = document.querySelector(`[data-progress="${specId}"]`);
      if (bar && created.expectedBytes) bar.style.width = `${Math.round((received / created.expectedBytes) * 100)}%`;
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const receivedHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const completed = await api(`/downloads/${created.id}/complete`, {
      method: 'POST',
      body: { receivedHash, receivedBytes: received },
    });
    state.downloads.set(specId, completed.download);
    if (completed.download.status === 'superseded') {
      log(`下载 g${created.generation} 在途中失效，需重新下载 g${completed.download.currentGenerationAtFinish}`, 'error');
      toast('下载期间产生了新版本，本地缓存已过期，请重新下载', 'warn');
    } else {
      log(`下载完成并校验哈希 ${short(receivedHash)}`);
      toast('下载完成，哈希与物化产物一致');
    }
    renderSpecs();
    await loadResult(specId, { quiet: true });
  } catch (err) {
    toast(err.message, 'error');
    log(`下载失败：${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------- SSE + controls

function connectSse() {
  if (state.sse) state.sse.close();
  if (!state.sseDesired) {
    renderStatusStrip();
    return;
  }
  const source = new EventSource('/events');
  source.addEventListener('hello', () => {
    state.sse = source;
    renderStatusStrip();
  });
  source.addEventListener('invalidation', (event) => {
    const data = JSON.parse(event.data);
    if (!state.autoRefresh) return;
    log(`收到失效通知 #${data.notification.changeSeq} · ${data.notification.specId}`, '');
    loadNotifications().catch(() => {});
    reloadSpecs().catch(() => {});
    loadResult(data.notification.specId, { quiet: true });
    if (data.notification.specId) loadDownloads(data.notification.specId).catch(() => {});
  });
  source.addEventListener('artifact-published', (event) => {
    const data = JSON.parse(event.data);
    if (!state.autoRefresh) return;
    log(`新产物发布 ${data.specId} g${data.generation}`);
    loadResult(data.specId, { quiet: true });
    loadDownloads(data.specId).catch(() => {});
  });
  source.onerror = () => {
    state.sse = null;
    renderStatusStrip();
    setTimeout(() => {
      if (state.sseDesired && !state.sse) connectSse();
    }, 1500);
  };
}

async function dropNotifications() {
  try {
    const payload = await api('/invalidator/pause', { method: 'POST' });
    state.invalidatorStats = { ...(state.invalidatorStats ?? {}), paused: true };
    state.sseDesired = false;
    if (state.sse) {
      state.sse.close();
      state.sse = null;
    }
    log(`已断开失效通知（游标 ${payload.cursor}）；源写入继续，水位线不会被消费`, 'error');
    toast('失效通知已断开：此时修订会累积在持久队列中，读取时通过水位线/全量校验发现', 'warn');
    renderStatusStrip();
    await Promise.all([reloadSpecs(), loadNotifications()]);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function restoreNotifications() {
  state.sseDesired = true;
  connectSse();
  try {
    const payload = await api('/invalidator/resume', { method: 'POST' });
    state.invalidatorStats = payload.stats;
    log(`恢复失效通知：处理 ${payload.eventsProcessed} 条积压事件`);
    toast('通知流已恢复，积压失效已应用');
    await Promise.all([reloadSpecs(), loadNotifications()]);
    await Promise.all(state.specs.map((s) => loadResult(s.id)));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function closeModal() {
  const root = el('modal-root');
  root.hidden = true;
  root.innerHTML = '';
}

function bindEvents() {
  el('btn-refresh').addEventListener('click', () => loadAll().catch((e) => toast(e.message, 'error')));
  el('btn-new-record').addEventListener('click', () => openRecordModal(null));
  el('btn-new-spec').addEventListener('click', () => openSpecModal(null));
  el('record-filter-status').addEventListener('change', (e) => {
    state.filterStatus = e.target.value;
    renderRecords();
  });
  el('record-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderRecords();
  });
  el('read-policy').addEventListener('change', (e) => {
    state.policyInput = e.target.value;
    for (const spec of state.specs) loadResult(spec.id, { quiet: true });
  });
  el('btn-drop-notifications').addEventListener('click', dropNotifications);
  el('btn-restore-notifications').addEventListener('click', restoreNotifications);
  el('btn-rebuild-all').addEventListener('click', async () => {
    for (const spec of state.specs) await rebuild(spec.id);
  });
  el('btn-verify-all').addEventListener('click', async () => {
    for (const spec of state.specs) await verify(spec.id);
  });
  el('auto-refresh').addEventListener('change', (e) => {
    state.autoRefresh = e.target.checked;
  });

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) {
      if (event.target.id === 'modal-root') closeModal();
      return;
    }
    const { action, id } = target.dataset;
    switch (action) {
      case 'edit':
        openRecordModal(state.records.find((r) => r.id === id));
        break;
      case 'delete':
        removeRecord(id);
        break;
      case 'save-record':
        saveRecord(id || null);
        break;
      case 'save-spec':
        saveSpec(id || null);
        break;
      case 'close-modal':
        closeModal();
        break;
      case 'refresh-result':
        setBusy(id, true);
        loadResult(id).finally(() => setBusy(id, false));
        break;
      case 'verify':
        verify(id);
        break;
      case 'rebuild':
        rebuild(id);
        break;
      case 'edit-spec':
        openSpecModal(state.specs.find((s) => s.id === id));
        break;
      case 'deps':
        showDependencies(id);
        break;
      case 'download':
        startDownload(id);
        break;
      default:
        break;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
}

async function boot() {
  bindEvents();
  try {
    await loadAll();
    connectSse();
    log('已加载源记录、聚合定义与失效通知');
    setInterval(() => {
      api('/invalidator/stats')
        .then((stats) => {
          state.invalidatorStats = stats;
          renderStatusStrip();
        })
        .catch(() => {});
    }, 3000);
  } catch (err) {
    toast(`加载失败：${err.message}`, 'error');
  }
}

boot();
