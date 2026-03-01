const state = {
  task: null,
  displayRows: []
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
  const typeOptions = ['movie', 'tv', 'anime', 'show']
    .map((t) => `<option value="${t}" ${entry.edited.type === t ? 'selected' : ''}>${t}</option>`)
    .join('');

  return `
    <tr data-id="${entry.id}" data-kind="${entry.kind}" data-entry-ids="${entry.entryIds ? entry.entryIds.join(',') : entry.id}">
      <td><input type="checkbox" data-key="selected" ${entry.selected ? 'checked' : ''} /></td>
      <td>${entry.sourceName}</td>
      <td><input data-key="title" value="${entry.edited.title || ''}" /></td>
      <td><input data-key="year" value="${entry.edited.year || ''}" /></td>
      <td><select data-key="type">${typeOptions}</select></td>
      <td>${entry.sourceLabel || '-'}</td>
      <td>${entry.episodeSummary || '-'}</td>
      <td class="path">${entry.target?.fullPath || ''}</td>
      <td>${entry.status || 'pending'} ${entry.reason ? `(${entry.reason})` : ''}</td>
    </tr>
  `;
}

function sourceToLabel(source) {
  if (source === 'ai' || source === 'ai-group') {
    return 'AI';
  }
  if (source === 'heuristic' || source === 'heuristic-group') {
    return '本地算法';
  }
  return source || '-';
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
        sourceLabel: sourceToLabel(e.ai?.source),
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
      sourceLabel: sourceToLabel(first.ai?.source),
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
  summaryEl.textContent = `任务ID: ${state.task.id} | 视频共 ${total} 条，已勾选 ${selected} 条，展示 ${state.displayRows.length} 行`;

  recomputeBtn.disabled = false;
  applyBtn.disabled = false;
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

async function requestJson(url, options) {
  const resp = await fetch(url, options);
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || 'request failed');
  }
  return data;
}

scanBtn.addEventListener('click', async () => {
  resultEl.textContent = '';
  scanBtn.disabled = true;
  try {
    const task = await requestJson('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputDir: inputDirEl.value.trim(),
        outputDir: outputDirEl.value.trim()
      })
    });
    state.task = task;
    renderTask();
  } catch (err) {
    alert(err.message);
  } finally {
    scanBtn.disabled = false;
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
  applyBtn.disabled = true;
  resultEl.textContent = '';
  try {
    await requestJson(`/api/tasks/${state.task.id}/recompute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: collectEntriesForUpdate() })
    });

    const result = await requestJson(`/api/tasks/${state.task.id}/apply`, {
      method: 'POST'
    });
    resultEl.textContent = JSON.stringify(result, null, 2);

    const task = await requestJson(`/api/tasks/${state.task.id}`);
    state.task = task;
    renderTask();
  } catch (err) {
    alert(err.message);
  } finally {
    applyBtn.disabled = false;
  }
});

loadConfig();
