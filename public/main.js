const state = {
  task: null,
  displayRows: [],
  scanPollTimer: null
};
const SERIES_TYPES = new Set(['tv', 'anime', 'show']);

const inputDirEl = document.getElementById('inputDir');
const outputDirEl = document.getElementById('outputDir');
const scanBtn = document.getElementById('scanBtn');
const recomputeBtn = document.getElementById('recomputeBtn');
const applyBtn = document.getElementById('applyBtn');
const summaryEl = document.getElementById('summary');
const tbody = document.querySelector('#resultTable tbody');
const resultEl = document.getElementById('result');

async function loadConfig() {
  try {
    const cfg = await requestJson('/api/config');
    if (cfg.inputDir) inputDirEl.value = cfg.inputDir;
    if (cfg.outputDir) outputDirEl.value = cfg.outputDir;
  } catch (_) {
    // ignore config loading failures to keep UI usable
  }
}

function rowHtml(entry) {
  const typeLabel = {
    movie: '电影',
    tv: '电视剧',
    anime: '动画',
    show: '节目'
  };
  const typeOptions = ['movie', 'tv', 'anime', 'show']
    .map((t) => `<option value="${t}" ${entry.edited.type === t ? 'selected' : ''}>${typeLabel[t] || t}</option>`)
    .join('');

  return `
    <tr data-id="${entry.id}" data-kind="${entry.kind}" data-entry-ids="${entry.entryIds ? entry.entryIds.join(',') : entry.id}">
      <td><input type="checkbox" data-key="selected" ${entry.selected ? 'checked' : ''} /></td>
      <td>${entry.sourceName}</td>
      <td><input data-key="title" value="${entry.edited.title || ''}" /></td>
      <td><input data-key="year" value="${entry.edited.year || ''}" /></td>
      <td><select data-key="type">${typeOptions}</select></td>
      <td>${entry.episodeSummary || '-'}</td>
      <td class="path">${entry.target?.fullPath || ''}</td>
      <td>${entry.status || 'pending'} ${entry.reason ? `(${entry.reason})` : ''}</td>
    </tr>
  `;
}

function buildSeriesKey(entry) {
  const year = entry.edited.year || '';
  return `${entry.edited.type}::${entry.edited.title || ''}::${year}`;
}

function summarizeEpisodes(entries) {
  const bySeason = new Map();
  for (const e of entries) {
    const s = e.edited.season || 1;
    const ep = e.edited.episode || 1;
    if (!bySeason.has(s)) bySeason.set(s, []);
    bySeason.get(s).push(ep);
  }
  const parts = [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, eps]) => {
      const uniq = [...new Set(eps)].sort((a, b) => a - b);
      const preview = uniq.slice(0, 4).map((n) => `E${String(n).padStart(2, '0')}`).join(',');
      const more = uniq.length > 4 ? '...' : '';
      return `S${String(season).padStart(2, '0')}(${uniq.length}集:${preview}${more})`;
    });
  return parts.join(' | ');
}

function aggregateStatus(entries) {
  if (entries.some((e) => e.status === 'failed')) return 'partial_failed';
  if (entries.every((e) => e.status === 'success')) return 'success';
  if (entries.every((e) => e.status === 'skipped')) return 'skipped';
  return 'pending';
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function buildDisplayRows(task) {
  const entries = task.entries || [];
  const groups = new Map();
  for (const e of entries) {
    const key = buildSeriesKey(e);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const visited = new Set();
  const rows = [];
  for (const e of entries) {
    if (visited.has(e.id)) continue;
    const key = buildSeriesKey(e);
    const groupEntries = groups.get(key) || [e];
    const shouldGroup = SERIES_TYPES.has(e.edited.type) && groupEntries.length >= 2;
    if (!shouldGroup) {
      visited.add(e.id);
      rows.push({
        ...e,
        kind: 'single',
        episodeSummary: e.edited.season && e.edited.episode ? `S${String(e.edited.season).padStart(2, '0')}E${String(e.edited.episode).padStart(2, '0')}` : '-'
      });
      continue;
    }

    for (const item of groupEntries) visited.add(item.id);
    const first = groupEntries[0];
    rows.push({
      id: `group:${key}`,
      kind: 'group',
      entryIds: groupEntries.map((x) => x.id),
      sourceName: `${groupEntries.length} 集 | 示例: ${first.sourceName}`,
      edited: {
        title: first.edited.title,
        year: first.edited.year,
        type: first.edited.type
      },
      selected: groupEntries.some((x) => x.selected),
      target: first.target,
      status: aggregateStatus(groupEntries),
      reason: '',
      episodeSummary: summarizeEpisodes(groupEntries)
    });
  }
  return rows;
}

function renderTask() {
  if (!state.task) {
    tbody.innerHTML = '';
    summaryEl.textContent = '';
    recomputeBtn.disabled = true;
    applyBtn.disabled = true;
    return;
  }

  state.displayRows = buildDisplayRows(state.task);
  tbody.innerHTML = state.displayRows.map(rowHtml).join('');
  const total = state.task.entries.length;
  const selected = state.task.entries.filter((e) => e.selected).length;
  const scanStatus = state.task.scanStatus || 'completed';
  const applyStatus = state.task.applyStatus || 'idle';

  if (applyStatus === 'running') {
    const done = state.task.applyDone || 0;
    const all = state.task.applyTotal || 0;
    const current = state.task.currentApplyFile || '-';
    const filePercent = all > 0 ? ((done / all) * 100).toFixed(1) : '0.0';
    const doneBytes = (state.task.applyBytesDone || 0) + (state.task.currentApplyFileBytesDone || 0);
    const totalBytes = state.task.applyBytesTotal || 0;
    const bytePercent = totalBytes > 0 ? ((doneBytes / totalBytes) * 100).toFixed(1) : '0.0';
    summaryEl.textContent = `任务ID: ${state.task.id} | 正在执行 ${done}/${all} (${filePercent}%) | 数据进度 ${formatBytes(doneBytes)}/${formatBytes(totalBytes)} (${bytePercent}%) | 当前：${current}`;
    scanBtn.disabled = true;
    recomputeBtn.disabled = true;
    applyBtn.disabled = true;
    return;
  }
  if (applyStatus === 'failed') {
    const err = state.task.applyError || 'unknown error';
    summaryEl.textContent = `任务ID: ${state.task.id} | 执行失败：${err}`;
    scanBtn.disabled = false;
    recomputeBtn.disabled = false;
    applyBtn.disabled = false;
    return;
  }

  if (scanStatus === 'running') {
    const done = state.task.scanDone || 0;
    const all = state.task.scanTotal || 0;
    const current = state.task.currentFile || '-';
    summaryEl.textContent = `任务ID: ${state.task.id} | 正在识别 ${done}/${all} | 当前：${current} | 已展示 ${state.displayRows.length} 行`;
    scanBtn.disabled = true;
    recomputeBtn.disabled = true;
    applyBtn.disabled = true;
    return;
  }
  if (scanStatus === 'failed') {
    const err = state.task.scanError || 'unknown error';
    summaryEl.textContent = `任务ID: ${state.task.id} | 识别失败：${err}`;
    scanBtn.disabled = false;
    recomputeBtn.disabled = true;
    applyBtn.disabled = true;
    return;
  }

  scanBtn.disabled = false;
  summaryEl.textContent = `任务ID: ${state.task.id} | 视频共 ${total} 条，已勾选 ${selected} 条，展示 ${state.displayRows.length} 行`;
  recomputeBtn.disabled = total === 0;
  applyBtn.disabled = total === 0;
}

function stopScanPolling() {
  if (state.scanPollTimer) {
    clearInterval(state.scanPollTimer);
    state.scanPollTimer = null;
  }
}

async function refreshTask(taskId) {
  const task = await requestJson(`/api/tasks/${taskId}`);
  state.task = task;
  renderTask();
  if (task.lastApplyResult && task.applyStatus === 'completed') {
    resultEl.textContent = JSON.stringify(task.lastApplyResult, null, 2);
  }
  if ((task.scanStatus === 'completed' || task.scanStatus === 'failed')
    && (task.applyStatus === 'idle' || task.applyStatus === 'completed' || task.applyStatus === 'failed')) {
    stopScanPolling();
    scanBtn.disabled = false;
  }
}

function startScanPolling(taskId) {
  stopScanPolling();
  state.scanPollTimer = setInterval(async () => {
    try {
      await refreshTask(taskId);
    } catch (_) {
      // keep polling
    }
  }, 1000);
}

function collectEntriesForUpdate() {
  const rows = [...tbody.querySelectorAll('tr[data-id]')];
  const byId = new Map((state.task?.entries || []).map((e) => [e.id, e]));
  const updates = [];
  rows.forEach((row) => {
    const get = (key) => row.querySelector(`[data-key="${key}"]`);
    const common = {
      selected: get('selected').checked,
      title: get('title').value,
      year: get('year').value,
      type: get('type').value
    };
    const ids = (row.dataset.entryIds || '').split(',').filter(Boolean);
    ids.forEach((id) => {
      const original = byId.get(id);
      if (!original) return;
      updates.push({
        id,
        ...common,
        season: original.edited.season,
        episode: original.edited.episode
      });
    });
  });
  return updates;
}

async function requestJson(url, options, timeoutMs = 600000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, { ...(options || {}), signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('请求超时，请缩小扫描目录范围后重试');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || 'request failed');
  }
  return data;
}

scanBtn.addEventListener('click', async () => {
  stopScanPolling();
  resultEl.textContent = '';
  scanBtn.disabled = true;
  summaryEl.textContent = '正在扫描并识别，请稍候...';
  try {
    const resp = await requestJson('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputDir: inputDirEl.value.trim(),
        outputDir: outputDirEl.value.trim()
      })
    }, 600000);
    await refreshTask(resp.taskId);
    startScanPolling(resp.taskId);
  } catch (err) {
    summaryEl.textContent = '';
    alert(err.message);
    scanBtn.disabled = false;
  } finally {
    if (state.task?.scanStatus !== 'running') {
      scanBtn.disabled = false;
    }
  }
});

recomputeBtn.addEventListener('click', async () => {
  if (!state.task) return;
  recomputeBtn.disabled = true;
  try {
    const task = await requestJson(`/api/tasks/${state.task.id}/recompute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: collectEntriesForUpdate() })
    });
    state.task = task;
    renderTask();
  } catch (err) {
    alert(err.message);
  } finally {
    recomputeBtn.disabled = false;
  }
});

applyBtn.addEventListener('click', async () => {
  if (!state.task) return;
  stopScanPolling();
  applyBtn.disabled = true;
  resultEl.textContent = '';
  try {
    await requestJson(`/api/tasks/${state.task.id}/recompute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: collectEntriesForUpdate() })
    });

    const resp = await requestJson(`/api/tasks/${state.task.id}/apply`, {
      method: 'POST'
    });
    await refreshTask(resp.taskId || state.task.id);
    startScanPolling(resp.taskId || state.task.id);
  } catch (err) {
    alert(err.message);
    applyBtn.disabled = false;
  } finally {
    if (state.task?.applyStatus !== 'running') {
      applyBtn.disabled = false;
    }
  }
});

loadConfig();
