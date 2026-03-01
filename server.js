const dotenv = require('dotenv');
const express = require('express');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { ProxyAgent, setGlobalDispatcher } = require('undici');

function looksMojibake(text) {
  if (typeof text !== 'string') {
    return false;
  }
  return text.includes('�') || /[\u0400-\u04FF]/.test(text);
}

function loadEnvWithEncodingFallback() {
  const envPath = path.join(process.cwd(), '.env');
  let raw;

  try {
    raw = fsSync.readFileSync(envPath);
  } catch {
    dotenv.config();
    return;
  }

  const utf8Parsed = dotenv.parse(raw.toString('utf8'));
  let merged = { ...utf8Parsed };

  try {
    const gbParsed = dotenv.parse(new TextDecoder('gb18030').decode(raw));
    for (const key of Object.keys(gbParsed)) {
      const utf8Value = utf8Parsed[key];
      const gbValue = gbParsed[key];
      if (!utf8Value || (looksMojibake(utf8Value) && !looksMojibake(gbValue))) {
        merged[key] = gbValue;
      }
    }
  } catch {
    // Keep UTF-8 parse when gb18030 decoding is unavailable.
  }

  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvWithEncodingFallback();

const upstreamProxy =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.ALL_PROXY ||
  '';
if (upstreamProxy) {
  try {
    setGlobalDispatcher(new ProxyAgent(upstreamProxy));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[WARN] invalid proxy url, fallback to direct fetch: ${err.message}`);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const WORK_DIR = process.cwd();
const TASK_DIR = path.join(WORK_DIR, 'tasks');
const LOG_DIR = path.join(WORK_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const DEFAULT_INPUT_DIR = process.env.INPUT_HOST_DIR || process.env.INPUT_DIR || '';
const DEFAULT_OUTPUT_DIR = process.env.OUTPUT_HOST_DIR || process.env.OUTPUT_DIR || '';
const TITLE_LANGUAGE = (process.env.TITLE_LANGUAGE || 'zh').toLowerCase();
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.sub', '.vtt']);
const TV_TYPES = new Set(['tv', 'anime', 'show']);
const TYPE_TO_DIR = {
  movie: '电影',
  tv: '电视剧',
  anime: '动画',
  show: '节目'
};
const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS || 8000);
const AI_CIRCUIT_BREAK_MS = Number(process.env.AI_CIRCUIT_BREAK_MS || 300000);
const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 4);
let aiCircuitOpenUntil = 0;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(WORK_DIR, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    inputDir: DEFAULT_INPUT_DIR,
    outputDir: DEFAULT_OUTPUT_DIR
  });
});

function nowISO() {
  return new Date().toISOString();
}

function isAICircuitOpen() {
  return Date.now() < aiCircuitOpenUntil;
}

function openAICircuit() {
  aiCircuitOpenUntil = Date.now() + AI_CIRCUIT_BREAK_MS;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = AI_REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('AI request timeout')), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, worker) {
  const arr = Array.isArray(items) ? items : [];
  const out = new Array(arr.length);
  const cap = Math.max(1, Number(limit) || 1);
  let idx = 0;

  async function run() {
    while (idx < arr.length) {
      const current = idx;
      idx += 1;
      out[current] = await worker(arr[current], current);
    }
  }

  const runners = [];
  const n = Math.min(cap, arr.length);
  for (let i = 0; i < n; i += 1) {
    runners.push(run());
  }
  await Promise.all(runners);
  return out;
}

async function ensureDirs() {
  await fs.mkdir(TASK_DIR, { recursive: true });
  await fs.mkdir(LOG_DIR, { recursive: true });
}

async function logLine(message) {
  const line = `${nowISO()} ${message}\n`;
  await fs.appendFile(LOG_FILE, line, 'utf8');
}

function toSafeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function cleanName(name) {
  return name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripNoiseTokens(text) {
  let t = String(text || '');

  // Remove common release wrappers and web/source noise.
  t = t.replace(/\[[^\]]*(?:www|https?|com|net|org|cc|tv|论坛|发布|字幕组|电影|资源)[^\]]*\]/gi, ' ');
  t = t.replace(/\[[^\]]*(?:www\.|https?:\/\/|\.com|\.net|\.org|\.cc|\.tv|最新网址|论坛|字幕组)[^\]]*\]/gi, ' ');
  t = t.replace(/\([^\)]*(?:www\.|https?:\/\/|\.com|\.net|\.org|\.cc|\.tv)[^\)]*\)/gi, ' ');
  t = t.replace(/https?:\/\/\S+/gi, ' ');
  t = t.replace(/www\.[^\s]+/gi, ' ');
  t = t.replace(/\b[A-Za-z0-9-]+\.(?:com|net|org|cc|tv|xyz|top|cn)\b/gi, ' ');

  // Remove resolution/source/codec/audio tags.
  t = t.replace(/\b(?:2160p|1080p|720p|480p|4k|8k)\b/gi, ' ');
  t = t.replace(/\b(?:blu[\s-]?ray|bdrip|webrip|web[\s-]?dl|hdrip|dvdrip|remux)\b/gi, ' ');
  t = t.replace(/\b(?:x264|x265|h264|h265|hevc|avc|10bit|8bit)\b/gi, ' ');
  t = t.replace(/\b(?:aac(?:2\.0)?|ddp?\d(?:\.\d)?|atmos|dts(?:-hd)?)\b/gi, ' ');

  // Remove frequent Chinese junk words.
  t = t.replace(/(?:中文字幕|中字|双字|原创|原创字幕|高清|超清|蓝光|未删减|完整版|内封|官中|特效字幕)/g, ' ');

  return cleanName(t.replace(/[._]/g, ' '));
}

function detectEpisodeMeta(normalizedName) {
  const sxe = normalizedName.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
  if (sxe) {
    return { season: Number(sxe[1]), episode: Number(sxe[2]), pattern: 'sxe' };
  }

  const zhEpisode = normalizedName.match(/第\s*(\d{1,3})\s*[集话話]/i);
  if (zhEpisode) {
    return { season: 1, episode: Number(zhEpisode[1]), pattern: 'zh' };
  }

  const ep = normalizedName.match(/(?:^|[\s._-])(?:ep?|e)\s*(\d{1,3})(?:[\s._-]|$)/i);
  if (ep) {
    return { season: 1, episode: Number(ep[1]), pattern: 'ep' };
  }

  const pureIndex = normalizedName.trim().match(/^0*(\d{1,3})$/);
  if (pureIndex) {
    const n = Number(pureIndex[1]);
    if (n > 0 && n <= 199) {
      return { season: 1, episode: n, pattern: 'index' };
    }
  }

  return null;
}

const EXCLUDED_SCAN_DIR_KEYWORDS = ['云盘缓存文件'];
const MIN_SCAN_FILE_SIZE_BYTES = 1 * 1024 * 1024;

function hasExcludedScanPathSegment(targetPath) {
  const parts = path.resolve(targetPath).split(path.sep).filter(Boolean);
  return parts.some((part) => {
    const p = String(part || '').trim();
    return EXCLUDED_SCAN_DIR_KEYWORDS.some((keyword) => p.includes(keyword));
  });
}

async function walkFiles(dir) {
  const out = [];
  const queue = [dir];

  while (queue.length > 0) {
    const current = queue.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (hasExcludedScanPathSegment(full)) {
          continue;
        }
        queue.push(full);
      } else if (entry.isFile()) {
        if (hasExcludedScanPathSegment(full)) {
          continue;
        }
        const stat = await fs.stat(full);
        if (stat.size < MIN_SCAN_FILE_SIZE_BYTES) {
          continue;
        }
        out.push(full);
      }
    }
  }
  return out;
}

function parseByHeuristic(filename) {
  const noExt = filename.replace(/\.[^.]+$/, '');
  const normalized = noExt.replace(/[._]/g, ' ');
  const yearMatch = normalized.match(/(?:19|20)\d{2}/);
  const episodeMeta = detectEpisodeMeta(normalized);

  let type = 'movie';
  if (episodeMeta) {
    type = 'tv';
  }

  let titleBase = normalized;
  if (episodeMeta?.pattern === 'sxe') {
    titleBase = titleBase.replace(/[Ss]\d{1,2}[Ee]\d{1,3}.*/, '');
  } else if (episodeMeta?.pattern === 'zh') {
    titleBase = titleBase.replace(/第\s*\d{1,3}\s*[集话話].*/i, '');
  } else if (episodeMeta?.pattern === 'ep') {
    titleBase = titleBase.replace(/(?:^|[\s._-])(?:ep?|e)\s*\d{1,3}.*/i, '');
  } else if (episodeMeta?.pattern === 'index') {
    titleBase = '';
  }
  titleBase = titleBase.replace(/(?:19|20)\d{2}.*/, '');
  const cleaned = stripNoiseTokens(titleBase);
  const title = cleaned || (episodeMeta ? '' : stripNoiseTokens(noExt));

  return {
    title,
    year: yearMatch ? Number(yearMatch[0]) : null,
    type,
    season: episodeMeta ? Number(episodeMeta.season) : null,
    episode: episodeMeta ? Number(episodeMeta.episode) : null,
    confidence: 0.4,
    source: 'cleaner'
  };
}

async function parseByAI({ filename, cleanedTitleHint = '', folderHintName = '', episodeHint = null, yearHint = null }) {
  const apiKey = process.env.AI_API_KEY;
  const apiBase = process.env.AI_API_BASE || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4.1-mini';

  if (!apiKey || isAICircuitOpen()) {
    return parseByHeuristic(filename);
  }

  const languageRule =
    TITLE_LANGUAGE === 'en'
      ? 'title 必须使用英文官方名（不要中文译名）。'
      : 'title 必须使用简体中文常用译名（不要英文名）。';
  const prompt = `你是影视文件识别器。根据“清洗后的标题提示 + 原始文件名 + 目录提示”输出严格 JSON，不要输出任何额外文字。\n字段：title(string),year(number|null),type(movie|tv|anime|show),season(number|null),episode(number|null),confidence(0-1)。\n额外规则：${languageRule}\n要求：优先基于清洗后的标题提示识别真实作品；忽略网址、分辨率、编码、字幕、原创等噪声。\n清洗后的标题提示：${cleanedTitleHint || ''}\n目录提示：${folderHintName || ''}\n原始文件名：${filename}\n集数提示：${episodeHint ? `S${episodeHint.season}E${episodeHint.episode}` : ''}\n年份提示：${yearHint || ''}`;

  try {
    const resp = await fetchWithTimeout(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: '返回 JSON 对象，不要 markdown。' },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!resp.ok) {
      throw new Error(`AI HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(text);

    const type = ['movie', 'tv', 'anime', 'show'].includes(parsed.type)
      ? parsed.type
      : 'movie';

    return {
      title: cleanName(parsed.title || cleanedTitleHint || filename.replace(/\.[^.]+$/, '')),
      year: toSafeInt(parsed.year),
      type,
      season: toSafeInt(parsed.season),
      episode: toSafeInt(parsed.episode),
      confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 0.5,
      source: 'ai'
    };
  } catch (err) {
    openAICircuit();
    await logLine(`[WARN] AI fallback for ${filename}: ${err.message}`);
    return parseByHeuristic(filename);
  }
}

function isSeasonFolderName(name) {
  const normalized = String(name || '').trim();
  return /^(season\s*\d{1,2}|s\d{1,2})$/i.test(normalized);
}

function detectSeriesHintName(filePath, inputDir) {
  const inputAbs = path.resolve(inputDir);
  const parentAbs = path.dirname(path.resolve(filePath));
  const rel = path.relative(inputAbs, parentAbs);
  if (rel.startsWith('..')) {
    return path.basename(parentAbs);
  }
  const parts = rel.split(path.sep).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (!isSeasonFolderName(parts[i])) {
      return parts[i];
    }
  }
  return parts[0] || path.basename(parentAbs);
}

async function parseSeriesGroupByAI(fileNames, cleanedHints, folderHintName, cleanedFolderHint, fallback) {
  const apiKey = process.env.AI_API_KEY;
  const apiBase = process.env.AI_API_BASE || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4.1-mini';

  if (!apiKey || isAICircuitOpen()) {
    return {
      title: fallback.title,
      year: fallback.year,
      type: 'tv',
      confidence: 0.4,
      source: 'heuristic-group'
    };
  }

  const languageRule =
    TITLE_LANGUAGE === 'en'
      ? 'title 必须使用英文官方名（不要中文译名）。'
      : 'title 必须使用简体中文常用译名（不要英文名）。';

  const prompt = `你是剧集文件名识别器。下面这些文件来自同一部剧集，请输出统一信息。\n输出严格 JSON，不要输出任何额外文字。\n字段：title(string),year(number|null),type(tv|anime|show),confidence(0-1)。\n额外规则：${languageRule}\n识别优先级：优先依据“清洗后的目录提示”，文件名仅作辅助。\n清洗后的目录提示：${cleanedFolderHint || ''}\n原始剧集目录名：${folderHintName}\n清洗后的文件提示列表：${cleanedHints.join(' | ')}\n原始文件名列表：${fileNames.join(' | ')}`;

  try {
    const resp = await fetchWithTimeout(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: '返回 JSON 对象，不要 markdown。' },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!resp.ok) {
      throw new Error(`AI HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(text);
    const type = ['tv', 'anime', 'show'].includes(parsed.type) ? parsed.type : 'tv';

    return {
      title: cleanName(parsed.title || fallback.title),
      year: toSafeInt(parsed.year),
      type,
      confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 0.7,
      source: 'ai-group'
    };
  } catch (err) {
    openAICircuit();
    await logLine(`[WARN] AI group fallback for series: ${err.message}`);
    return {
      title: fallback.title,
      year: fallback.year,
      type: 'tv',
      confidence: 0.4,
      source: 'heuristic-group'
    };
  }
}

function buildSeriesGroupKey(heuristic) {
  const baseTitle = cleanName(heuristic.title || '').toLowerCase();
  const year = toSafeInt(heuristic.year) || 0;
  return `${baseTitle}::${year}`;
}

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text || '');
}

function looksEnglishTitle(text) {
  if (!text || hasChinese(text)) {
    return false;
  }
  return /[A-Za-z]/.test(text);
}

function isCompleteChineseRecognition(meta) {
  return Boolean(meta && hasChinese(meta.title) && toSafeInt(meta.year));
}

function hasTitleWithoutYear(meta) {
  return Boolean(meta && cleanName(meta.title || '') && !toSafeInt(meta.year));
}

async function inferYearFromTitleByAI(title, typeHint = 'movie') {
  const apiKey = process.env.AI_API_KEY;
  const apiBase = process.env.AI_API_BASE || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4.1-mini';
  const cleanTitle = cleanName(title || '');

  if (!apiKey || !cleanTitle || isAICircuitOpen()) {
    return null;
  }

  const safeTypeHint = ['movie', 'tv', 'anime', 'show'].includes(typeHint) ? typeHint : 'movie';
  const prompt = `你是影视年份查询器。根据给定标题推断最可能的“影视作品”首映年份，返回严格 JSON，不要输出额外文字。\n字段：year(number|null)。\n限定：只考虑电影/电视剧/动画/综艺/纪录片等影视作品；不要参考小说、漫画、游戏、音乐专辑等同名内容。\n若存在重名，优先选择最广为人知且与给定类型最匹配的影视条目。\n标题：${cleanTitle}\n类型：${safeTypeHint}`;

  try {
    const resp = await fetchWithTimeout(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: '返回 JSON 对象，不要 markdown。' },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!resp.ok) {
      throw new Error(`AI HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(text);
    return toSafeInt(parsed.year);
  } catch (err) {
    openAICircuit();
    await logLine(`[WARN] infer year fallback for ${cleanTitle}: ${err.message}`);
    return null;
  }
}

async function inferChineseTitleByAI(title, typeHint = 'movie', yearHint = null) {
  const apiKey = process.env.AI_API_KEY;
  const apiBase = process.env.AI_API_BASE || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4.1-mini';
  const cleanTitle = cleanName(title || '');
  const safeTypeHint = ['movie', 'tv', 'anime', 'show'].includes(typeHint) ? typeHint : 'movie';
  const safeYearHint = toSafeInt(yearHint);

  if (!apiKey || !cleanTitle || hasChinese(cleanTitle) || isAICircuitOpen()) {
    return null;
  }

  const prompt = `你是影视标题标准化助手。请根据给定英文标题，返回该影视作品最常用、最正式的简体中文名称。\n输出严格 JSON，不要输出额外文字。\n字段：title(string|null)。\n约束：\n1) 仅返回简体中文片名/剧名。\n2) 若无法确定，返回 null。\n3) 不要添加年份、季号、分辨率、地区等附加信息。\n标题：${cleanTitle}\n类型：${safeTypeHint}\n年份（可为空）：${safeYearHint || ''}`;

  try {
    const resp = await fetchWithTimeout(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: '返回 JSON 对象，不要 markdown。' },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!resp.ok) {
      throw new Error(`AI HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(text);
    const zhTitle = cleanName(parsed.title || '');
    if (!zhTitle || !hasChinese(zhTitle)) {
      return null;
    }
    return zhTitle;
  } catch (err) {
    openAICircuit();
    await logLine(`[WARN] infer chinese title fallback for ${cleanTitle}: ${err.message}`);
    return null;
  }
}

function buildTargetForEntry(entry, groupSize, outputDir) {
  const ext = entry.ext;
  const title = cleanName(entry.edited.title || entry.originalNameNoExt) || entry.originalNameNoExt;
  const year = toSafeInt(entry.edited.year);
  const type = ['movie', 'tv', 'anime', 'show'].includes(entry.edited.type) ? entry.edited.type : 'movie';
  const season = toSafeInt(entry.edited.season);
  const episode = toSafeInt(entry.edited.episode);
  const yearPart = year ? ` (${year})` : '';

  const categoryDir = TYPE_TO_DIR[type] || '待确认';

  if (type === 'movie') {
    const fileName = `${title}${yearPart}${ext}`;
    const fullPath = path.join(outputDir, categoryDir, fileName);
    return { categoryDir, fileName, fullPath, mode: 'single' };
  }

  if (TV_TYPES.has(type) && !season && !episode && groupSize < 2) {
    const fileName = `${title}${yearPart}${ext}`;
    const fullPath = path.join(outputDir, categoryDir, fileName);
    return { categoryDir, fileName, fullPath, mode: 'single' };
  }

  const seasonNum = season || 1;
  const episodeNum = episode || 1;
  const seasonLabel = `S${String(seasonNum).padStart(2, '0')}`;
  const showFolder = `${title}`;
  const fileName = `${title} - S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}${ext}`;
  const fullPath = path.join(outputDir, categoryDir, showFolder, seasonLabel, fileName);
  return { categoryDir, fileName, fullPath, mode: 'series' };
}

function recomputeTargets(task) {
  const keyCount = new Map();
  for (const entry of task.entries) {
    const t = entry.edited.type;
    const title = cleanName(entry.edited.title || '');
    const year = toSafeInt(entry.edited.year) || 0;
    const key = `${t}::${title}::${year}`;
    keyCount.set(key, (keyCount.get(key) || 0) + 1);
  }

  for (const entry of task.entries) {
    const t = entry.edited.type;
    const title = cleanName(entry.edited.title || '');
    const year = toSafeInt(entry.edited.year) || 0;
    const key = `${t}::${title}::${year}`;
    const groupSize = keyCount.get(key) || 1;
    entry.target = buildTargetForEntry(entry, groupSize, task.outputDir);
  }
}

async function readTask(taskId) {
  const file = path.join(TASK_DIR, `${taskId}.json`);
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

async function saveTask(task) {
  const file = path.join(TASK_DIR, `${task.id}.json`);
  task.updatedAt = nowISO();
  await fs.writeFile(file, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
}

async function createTask({ inputDir, outputDir, taskId = crypto.randomUUID(), onProgress = null }) {
  const task = {
    id: taskId,
    inputDir,
    outputDir,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    entries: [],
    scanStatus: 'running',
    scanTotal: 0,
    scanDone: 0,
    currentFile: '',
    scanError: '',
    applyStatus: 'idle',
    applyTotal: 0,
    applyDone: 0,
    currentApplyFile: '',
    applyError: '',
    lastApplyResult: null
  };

  async function pushProgress() {
    if (onProgress) {
      await onProgress(task);
    }
  }

  const allFiles = await walkFiles(inputDir);
  const videos = [];
  for (const file of allFiles) {
    if (hasExcludedScanPathSegment(file)) {
      continue;
    }
    const stat = await fs.stat(file);
    const ext = path.extname(file).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext) || stat.size <= 0) {
      continue;
    }
    videos.push({ file, ext, size: stat.size });
  }

  const preItems = videos.map((item) => {
    const basename = path.basename(item.file);
    const heuristic = parseByHeuristic(basename);
    const seriesHintName = detectSeriesHintName(item.file, inputDir);
    const seriesHintHeuristic = parseByHeuristic(seriesHintName);
    return { ...item, basename, heuristic, seriesHintName, seriesHintHeuristic };
  });
  task.scanTotal = preItems.length;
  await pushProgress();

  const seriesGroups = new Map();
  for (const item of preItems) {
    if (!item.heuristic.season || !item.heuristic.episode) {
      continue;
    }
    const key = buildSeriesGroupKey(item.seriesHintHeuristic);
    if (!seriesGroups.has(key)) {
      seriesGroups.set(key, []);
    }
    seriesGroups.get(key).push(item);
  }

  const seriesGroupMeta = new Map();
  const yearByTitleCache = new Map();
  const zhTitleCache = new Map();

  async function resolveYearByTitle(title, typeHint) {
    const k = `${cleanName(title || '').toLowerCase()}::${typeHint || ''}`;
    if (yearByTitleCache.has(k)) {
      return yearByTitleCache.get(k);
    }
    const p = inferYearFromTitleByAI(title, typeHint);
    yearByTitleCache.set(k, p);
    return p;
  }

  async function resolveChineseTitle(title, typeHint, yearHint) {
    const k = `${cleanName(title || '').toLowerCase()}::${typeHint || ''}::${toSafeInt(yearHint) || 0}`;
    if (zhTitleCache.has(k)) {
      return zhTitleCache.get(k);
    }
    const p = inferChineseTitleByAI(title, typeHint, yearHint);
    zhTitleCache.set(k, p);
    return p;
  }

  for (const [key, groupItems] of [...seriesGroups.entries()]) {
    if (groupItems.length < 2) {
      continue;
    }
    task.currentFile = `分组识别：${groupItems[0].seriesHintName || groupItems[0].basename}`;
    await pushProgress();
    const fallback = groupItems[0].seriesHintHeuristic;
    const folderHintName = groupItems[0].seriesHintName;
    const cleanedHints = groupItems.map((g) => g.heuristic.title || '').filter(Boolean);
    const cleanedFolderHint = fallback.title || '';
    const aiGroup = await parseSeriesGroupByAI(
      groupItems.map((g) => g.basename),
      cleanedHints,
      folderHintName,
      cleanedFolderHint,
      fallback
    );
    seriesGroupMeta.set(key, aiGroup);
  }

  for (const item of preItems) {
    task.currentFile = item.basename;
    await pushProgress();

    const groupKey = buildSeriesGroupKey(item.seriesHintHeuristic);
    const groupMeta = seriesGroupMeta.get(groupKey);
    const aiSingle = groupMeta
      ? null
      : await parseByAI({
          filename: item.basename,
          cleanedTitleHint: item.heuristic.title,
          folderHintName: item.seriesHintName,
          episodeHint: item.heuristic.season && item.heuristic.episode
            ? { season: item.heuristic.season, episode: item.heuristic.episode }
            : null,
          yearHint: item.heuristic.year
        });
    const ai = groupMeta
      ? {
          title: groupMeta.title || item.seriesHintHeuristic.title || item.heuristic.title || item.originalNameNoExt,
          year: groupMeta.year || item.heuristic.year || null,
          type: groupMeta.type,
          season: item.heuristic.season || groupMeta.season || null,
          episode: item.heuristic.episode || groupMeta.episode || null,
          confidence: groupMeta.confidence,
          source: groupMeta.source
        }
      : {
          title: aiSingle.title || item.heuristic.title || item.originalNameNoExt,
          year: aiSingle.year || item.heuristic.year || null,
          type: aiSingle.type,
          season: item.heuristic.season || aiSingle.season || null,
          episode: item.heuristic.episode || aiSingle.episode || null,
          confidence: aiSingle.confidence,
          source: aiSingle.source
        };

    if (hasTitleWithoutYear(ai)) {
      const inferredYear = await resolveYearByTitle(ai.title, ai.type);
      if (inferredYear) {
        ai.year = inferredYear;
      }
    }

    if (TITLE_LANGUAGE === 'zh' && looksEnglishTitle(ai.title)) {
      const zhTitle = await resolveChineseTitle(ai.title, ai.type, ai.year);
      if (zhTitle) {
        ai.title = zhTitle;
      }
    }

    task.entries.push({
      id: crypto.randomUUID(),
      sourcePath: item.file,
      sourceName: item.basename,
      originalNameNoExt: item.basename.replace(/\.[^.]+$/, ''),
      ext: item.ext,
      size: item.size,
      ai,
      edited: {
        title: ai.title,
        year: ai.year,
        type: ai.type,
        season: ai.season,
        episode: ai.episode
      },
      selected: true,
      status: 'pending',
      reason: '',
      target: null
    });
    task.scanDone += 1;
    recomputeTargets(task);
    await pushProgress();
  }

  task.scanStatus = 'completed';
  task.currentFile = '';
  recomputeTargets(task);
  await pushProgress();
  return task;
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function moveFileWithFallback(sourcePath, targetPath) {
  try {
    await fs.rename(sourcePath, targetPath);
    return;
  } catch (err) {
    if (err?.code !== 'EXDEV') {
      throw err;
    }
  }

  await fs.copyFile(sourcePath, targetPath);
  await fs.unlink(sourcePath);
}

async function uniquePath(destPath) {
  try {
    await fs.access(destPath);
  } catch {
    return destPath;
  }

  const ext = path.extname(destPath);
  const noExt = destPath.slice(0, -ext.length);

  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${noExt} (${i})${ext}`;
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }

  throw new Error(`Cannot find unique filename for ${destPath}`);
}

function isWithinDir(targetPath, baseDir) {
  const target = path.resolve(targetPath);
  const base = path.resolve(baseDir);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

async function removeEmptyParentDirs(startDir, stopDir) {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);

  while (current !== stop && isWithinDir(current, stop)) {
    let entries;
    try {
      entries = await fs.readdir(current);
    } catch {
      break;
    }

    if (entries.length > 0) {
      break;
    }

    await fs.rmdir(current);
    current = path.dirname(current);
  }
}

function splitSubtitleSuffix(fileName, originalBaseName) {
  if (fileName === `${originalBaseName}`) {
    return '';
  }
  if (fileName.startsWith(`${originalBaseName}.`)) {
    return fileName.slice(originalBaseName.length);
  }
  return null;
}

async function collectSidecarSubtitles(entry) {
  const sourceDir = path.dirname(entry.sourcePath);
  const originalBaseName = entry.originalNameNoExt;
  const items = [];
  const names = await fs.readdir(sourceDir);
  for (const name of names) {
    const fullPath = path.join(sourceDir, name);
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) {
      continue;
    }
    const ext = path.extname(name).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.has(ext)) {
      continue;
    }
    const subtitleNoExt = name.slice(0, -ext.length);
    const suffix = splitSubtitleSuffix(subtitleNoExt, originalBaseName);
    if (suffix === null) {
      continue;
    }
    items.push({ fullPath, ext, suffix });
  }
  return items;
}

async function moveSidecarSubtitles(entry, videoFinalPath) {
  const sidecars = await collectSidecarSubtitles(entry);
  if (sidecars.length === 0) {
    return [];
  }
  const videoFinalNoExt = videoFinalPath.slice(0, -path.extname(videoFinalPath).length);
  const moved = [];
  for (const sub of sidecars) {
    const target = await uniquePath(`${videoFinalNoExt}${sub.suffix}${sub.ext}`);
    await ensureParentDir(target);
    await moveFileWithFallback(sub.fullPath, target);
    moved.push({ from: sub.fullPath, to: target });
  }
  return moved;
}

async function removeAllFilesAndEmptyDirs(rootDir) {
  const stack = [path.resolve(rootDir)];
  const dirs = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    dirs.push(dir);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        await fs.unlink(full);
      }
    }
  }
  dirs.sort((a, b) => b.length - a.length);
  for (const dir of dirs) {
    if (dir === path.resolve(rootDir)) {
      continue;
    }
    try {
      await fs.rmdir(dir);
    } catch {
      // ignore non-empty or already removed directories
    }
  }
}

async function hasAnyVideoFiles(rootDir) {
  const queue = [path.resolve(rootDir)];
  while (queue.length > 0) {
    const dir = queue.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (VIDEO_EXTENSIONS.has(ext)) {
          return true;
        }
      }
    }
  }
  return false;
}

async function applyTask(task) {
  const result = {
    taskId: task.id,
    executedAt: nowISO(),
    success: 0,
    failed: 0,
    skipped: 0,
    details: []
  };

  task.applyStatus = 'running';
  task.applyTotal = task.entries.filter((e) => e.selected).length;
  task.applyDone = 0;
  task.currentApplyFile = '';
  task.applyError = '';
  await saveTask(task);

  for (const entry of task.entries) {
    if (!entry.selected) {
      result.skipped += 1;
      entry.status = 'skipped';
      entry.reason = 'not selected';
      result.details.push({ entryId: entry.id, status: 'skipped', reason: 'not selected' });
      continue;
    }

    try {
      task.currentApplyFile = entry.sourceName;
      await saveTask(task);
      const sourceParentDir = path.dirname(entry.sourcePath);
      const finalPath = await uniquePath(entry.target.fullPath);
      await ensureParentDir(finalPath);
      await moveFileWithFallback(entry.sourcePath, finalPath);
      const movedSubtitles = await moveSidecarSubtitles(entry, finalPath);
      if (isWithinDir(sourceParentDir, task.inputDir) && sourceParentDir !== path.resolve(task.inputDir)) {
        await removeEmptyParentDirs(sourceParentDir, task.inputDir);
      }
      entry.status = 'success';
      entry.reason = '';
      entry.appliedPath = finalPath;
      result.success += 1;
      result.details.push({
        entryId: entry.id,
        status: 'success',
        to: finalPath,
        subtitlesMoved: movedSubtitles.length
      });
      task.applyDone += 1;
      await saveTask(task);
    } catch (err) {
      entry.status = 'failed';
      entry.reason = err.message;
      result.failed += 1;
      result.details.push({ entryId: entry.id, status: 'failed', reason: err.message });
      await logLine(`[ERROR] apply failed ${entry.sourcePath}: ${err.message}`);
      task.applyDone += 1;
      await saveTask(task);
    }
  }

  task.applyStatus = 'completed';
  task.currentApplyFile = '';
  task.applyError = '';
  task.lastApplyResult = result;
  await saveTask(task);
  const resultFile = path.join(TASK_DIR, `${task.id}.result.json`);
  await fs.writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

app.post('/api/scan', async (req, res) => {
  try {
    const inputDir = (req.body?.inputDir || DEFAULT_INPUT_DIR || '').trim();
    const outputDir = (req.body?.outputDir || DEFAULT_OUTPUT_DIR || '').trim();

    if (!inputDir || !outputDir) {
      return res.status(400).json({ error: 'inputDir and outputDir are required (body or .env)' });
    }

    await ensureDirs();
    const taskId = crypto.randomUUID();
    const initialTask = {
      id: taskId,
      inputDir,
      outputDir,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      entries: [],
      scanStatus: 'running',
      scanTotal: 0,
      scanDone: 0,
      currentFile: '',
      scanError: '',
      applyStatus: 'idle',
      applyTotal: 0,
      applyDone: 0,
      currentApplyFile: '',
      applyError: '',
      lastApplyResult: null
    };
    await saveTask(initialTask);

    (async () => {
      try {
        const task = await createTask({
          inputDir,
          outputDir,
          taskId,
          onProgress: async (t) => saveTask(t)
        });
        await logLine(`[INFO] task created ${task.id} entries=${task.entries.length}`);
      } catch (err) {
        try {
          const failedTask = await readTask(taskId);
          failedTask.scanStatus = 'failed';
          failedTask.currentFile = '';
          failedTask.scanError = err.message;
          await saveTask(failedTask);
        } catch {
          // ignore secondary errors while reporting failure
        }
        await logLine(`[ERROR] async /api/scan failed: ${err.message}`);
      }
    })();

    return res.json({ taskId });
  } catch (err) {
    await logLine(`[ERROR] /api/scan failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/:id', async (req, res) => {
  try {
    const task = await readTask(req.params.id);
    return res.json(task);
  } catch (err) {
    return res.status(404).json({ error: 'task not found' });
  }
});

app.post('/api/tasks/:id/recompute', async (req, res) => {
  try {
    const task = await readTask(req.params.id);
    if (task.scanStatus === 'running') {
      return res.status(409).json({ error: 'scan is still running' });
    }
    if (task.applyStatus === 'running') {
      return res.status(409).json({ error: 'apply is still running' });
    }
    const updates = req.body?.entries || [];

    const byId = new Map(task.entries.map((e) => [e.id, e]));
    for (const up of updates) {
      const entry = byId.get(up.id);
      if (!entry) {
        continue;
      }

      entry.edited.title = cleanName(String(up.title || entry.edited.title));
      entry.edited.year = toSafeInt(up.year) || null;
      entry.edited.type = ['movie', 'tv', 'anime', 'show'].includes(up.type) ? up.type : entry.edited.type;
      entry.edited.season = toSafeInt(up.season) || null;
      entry.edited.episode = toSafeInt(up.episode) || null;
      entry.selected = Boolean(up.selected);
    }

    recomputeTargets(task);
    await saveTask(task);
    return res.json(task);
  } catch (err) {
    await logLine(`[ERROR] recompute failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/apply', async (req, res) => {
  try {
    const task = await readTask(req.params.id);
    if (task.scanStatus === 'running') {
      return res.status(409).json({ error: 'scan is still running' });
    }
    if (task.applyStatus === 'running') {
      return res.status(409).json({ error: 'apply is still running' });
    }

    task.applyStatus = 'running';
    task.applyTotal = task.entries.filter((e) => e.selected).length;
    task.applyDone = 0;
    task.currentApplyFile = '';
    task.applyError = '';
    task.lastApplyResult = null;
    await saveTask(task);

    (async () => {
      try {
        const latest = await readTask(task.id);
        const result = await applyTask(latest);
        await logLine(`[INFO] task applied ${task.id} success=${result.success} failed=${result.failed}`);
      } catch (err) {
        try {
          const failedTask = await readTask(task.id);
          failedTask.applyStatus = 'failed';
          failedTask.currentApplyFile = '';
          failedTask.applyError = err.message;
          await saveTask(failedTask);
        } catch {
          // ignore secondary errors while reporting failure
        }
        await logLine(`[ERROR] apply failed: ${err.message}`);
      }
    })();

    return res.json({ taskId: task.id });
  } catch (err) {
    await logLine(`[ERROR] apply failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  await ensureDirs();
  // eslint-disable-next-line no-console
  console.log(`EasyIngest UI running at http://localhost:${PORT}`);
});
