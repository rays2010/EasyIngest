const filenameEl = document.getElementById('filename');
const folderHintEl = document.getElementById('folderHint');
const debugBtn = document.getElementById('debugBtn');
const debugSummaryEl = document.getElementById('debugSummary');

const stageOriginalEl = document.getElementById('stageOriginal');
const stageCleanedEl = document.getElementById('stageCleaned');
const stageResolvedEl = document.getElementById('stageResolved');
const stageYearEl = document.getElementById('stageYear');
const stageTypeEl = document.getElementById('stageType');
const stageTmdbEl = document.getElementById('stageTmdb');
const rawResultEl = document.getElementById('rawResult');

async function requestJson(url, options = {}) {
  const resp = await fetch(url, options);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
  return data;
}

function formatTmdbStatus(tmdb = {}) {
  const map = {
    'disabled-no-key': '未参与（未配置 TMDB_API_KEY）',
    'skipped-empty-query': '未参与（查询词为空）',
    hit: '已参与（命中）',
    'miss-or-failed': '已参与（未命中或请求失败）'
  };
  const base = map[tmdb.status] || '-';
  const query = tmdb.query ? ` | query: ${tmdb.query}` : '';
  return `${base}${query}`;
}

function setStages(stages = {}, tmdb = {}) {
  stageOriginalEl.textContent = stages.original || '-';
  stageCleanedEl.textContent = stages.cleaned || '-';
  stageResolvedEl.textContent = stages.resolvedTitle || '-';
  stageYearEl.textContent = stages.year || '-';
  stageTypeEl.textContent = stages.type || '-';
  stageTmdbEl.textContent = formatTmdbStatus(tmdb);
}

async function runDebug() {
  const filename = String(filenameEl.value || '').trim();
  const folderHint = String(folderHintEl.value || '').trim();

  if (!filename) {
    debugSummaryEl.textContent = '请输入测试文件名';
    return;
  }

  debugBtn.disabled = true;
  debugSummaryEl.textContent = '识别中...';

  try {
    const result = await requestJson('/api/debug/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, folderHint })
    });

    setStages(result?.debug?.stages || {}, result?.debug?.tmdb || {});
    rawResultEl.textContent = JSON.stringify(result, null, 2);
    debugSummaryEl.textContent = `识别完成，来源: ${result?.result?.source || 'unknown'}，TMDB: ${result?.debug?.tmdb?.status || 'unknown'}`;
  } catch (err) {
    setStages({}, {});
    rawResultEl.textContent = '-';
    debugSummaryEl.textContent = `识别失败: ${err.message}`;
  } finally {
    debugBtn.disabled = false;
  }
}

debugBtn.addEventListener('click', runDebug);
filenameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    runDebug();
  }
});
