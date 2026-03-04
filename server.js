const dotenv = require('dotenv');
const express = require('express');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ProxyAgent, setGlobalDispatcher, Agent } = require('undici');

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

  function normalizeParsedEnv(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      const cleanKey = String(k || '').replace(/^\uFEFF/, '').trim();
      if (!cleanKey) continue;
      out[cleanKey] = v;
    }
    return out;
  }

  const utf8Parsed = normalizeParsedEnv(dotenv.parse(raw.toString('utf8')));
  let merged = { ...utf8Parsed };

  try {
    const gbParsed = normalizeParsedEnv(dotenv.parse(new TextDecoder('gb18030').decode(raw)));
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
const aiBaseHost = (() => {
  try {
    return new URL(process.env.AI_API_BASE || '').host;
  } catch {
    return '';
  }
})();
if (upstreamProxy) {
  try {
    setGlobalDispatcher(new ProxyAgent(upstreamProxy));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[WARN] invalid proxy url, fallback to direct fetch: ${err.message}`);
  }
}
const directAgent = new Agent();

function shouldBypassProxyForUrl(url) {
  if (!upstreamProxy) {
    return false;
  }
  const forceBypass = String(process.env.AI_BYPASS_PROXY || '').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(forceBypass)) {
    return true;
  }
  if (forceBypass === '0' || forceBypass === 'false' || forceBypass === 'off') {
    return false;
  }
  try {
    const reqHost = new URL(url).host;
    // Auto bypass for AI_API_BASE host (e.g. domestic relay).
    return Boolean(aiBaseHost) && reqHost === aiBaseHost;
  } catch {
    return false;
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
const ARCHIVE_EXTENSIONS = ['.zip', '.rar', '.7z', '.tar', '.tar.gz', '.tgz', '.tar.xz', '.txz'];
const SUB_ARCHIVE_TMP_DIR = '.easyingest_subs';
const TV_TYPES = new Set(['tv', 'anime', 'show']);
const TYPE_TO_DIR = {
  movie: '电影',
  tv: '电视剧',
  anime: '动画',
  show: '节目'
};
const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS || 8000);
const AI_CIRCUIT_BREAK_MS = Number(process.env.AI_CIRCUIT_BREAK_MS || 15000);
const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 4);
const APPLY_PROGRESS_SAVE_INTERVAL_MS = Number(process.env.APPLY_PROGRESS_SAVE_INTERVAL_MS || 400);
let aiCircuitOpenUntil = 0;
const archiveExtractCache = new Map();

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

function isAIRequestTimeout(err) {
  return /timeout/i.test(String(err?.message || ''));
}

function isAICircuitOpen() {
  return Date.now() < aiCircuitOpenUntil;
}

function openAICircuit() {
  aiCircuitOpenUntil = Date.now() + AI_CIRCUIT_BREAK_MS;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = AI_REQUEST_TIMEOUT_MS) {
  if (shouldBypassProxyForUrl(url)) {
    const directCtrl = new AbortController();
    const directTimer = setTimeout(() => directCtrl.abort(new Error('AI request timeout (direct)')), timeoutMs);
    try {
      return await fetch(url, {
        ...options,
        signal: directCtrl.signal,
        dispatcher: directAgent
      });
    } finally {
      clearTimeout(directTimer);
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('AI request timeout')), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    const canRetryDirect = Boolean(upstreamProxy) && !options.dispatcher;
    if (!canRetryDirect) {
      throw err;
    }
    const directCtrl = new AbortController();
    const directTimer = setTimeout(() => directCtrl.abort(new Error('AI request timeout (direct retry)')), timeoutMs);
    try {
      return await fetch(url, {
        ...options,
        signal: directCtrl.signal,
        dispatcher: directAgent
      });
    } finally {
      clearTimeout(directTimer);
    }
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

  // Normalize full-width wrappers to simplify matching.
  t = t.replace(/[【]/g, '[').replace(/[】]/g, ']');

  // Remove common release wrappers and web/source noise.
  t = t.replace(/\[[^\]]*(?:www|https?|com|net|org|cc|tv|论坛|发布|字幕组|电影|资源)[^\]]*\]/gi, ' ');
  t = t.replace(/\[[^\]]*(?:www\.|https?:\/\/|\.com|\.net|\.org|\.cc|\.tv|最新网址|论坛|字幕组)[^\]]*\]/gi, ' ');
  t = t.replace(/\([^\)]*(?:www\.|https?:\/\/|\.com|\.net|\.org|\.cc|\.tv)[^\)]*\)/gi, ' ');
  t = t.replace(/https?:\/\/\S+/gi, ' ');
  t = t.replace(/www\.[^\s]+/gi, ' ');
  t = t.replace(/\b[A-Za-z0-9-]+\.(?:com|net|org|cc|tv|xyz|top|cn)\b/gi, ' ');
  t = t.replace(/(?:高清)?剧集网发布|剧集网|资源网|最新网址/gi, ' ');

  // Remove resolution/source/codec/audio tags.
  t = t.replace(/\b(?:2160p|1080p|720p|480p|4k|8k)\b/gi, ' ');
  t = t.replace(/\b(?:blu[\s-]?ray|bdrip|webrip|web[\s-]?dl|hdrip|dvdrip|remux)\b/gi, ' ');
  t = t.replace(/\b(?:x264|x265|h264|h265|hevc|avc|10bit|8bit)\b/gi, ' ');
  t = t.replace(/\b(?:aac(?:2\.0)?|ddp?\d(?:\.\d)?|atmos|dts(?:-hd)?|iq|blacktv)\b/gi, ' ');

  // Remove season-pack and subtitle/audio descriptors.
  t = t.replace(/(?:全\s*\d{1,3}\s*[集话話]|完结|完結|全季|全一季|全\d{1,2}季)/gi, ' ');
  t = t.replace(/(?:国语音轨|粤语音轨|国配|粤配|简繁英字幕|简繁字幕|中英字幕|双语字幕|多语字幕)/gi, ' ');

  // Remove frequent Chinese junk words.
  t = t.replace(/(?:中文字幕|中字|双字|原创|原创字幕|高清|超清|蓝光|未删减|完整版|内封|官中|特效字幕)/g, ' ');
  t = t.replace(/\[[\s+\-]*\]/g, ' ');
  t = t.replace(/(?:^|[\s])[-+](?=$|[\s])/g, ' ');

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

  // Scene/fansub naming: "Title - 07 [WebRip ...]"
  const dashBracket = normalizedName.match(/-\s*0?(\d{1,3})\s*\[/);
  if (dashBracket) {
    return { season: 1, episode: Number(dashBracket[1]), pattern: 'dashbracket' };
  }

  // Fansub-like naming: [Group][Title][01][BIG5]...
  const bracketNumbers = [...normalizedName.matchAll(/\[(\d{1,3})\]/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 199);
  if (bracketNumbers.length > 0) {
    return { season: 1, episode: bracketNumbers[0], pattern: 'bracket' };
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

function detectSeasonHint(normalizedName) {
  const sxeSeason = normalizedName.match(/[Ss](\d{1,2})[Ee]\d{1,3}/);
  if (sxeSeason) {
    return Number(sxeSeason[1]);
  }

  const seasonEn = normalizedName.match(/(?:^|[\s._\-\[])(?:season|s)\s*0?(\d{1,2})(?:[\s._\-\]]|$)/i);
  if (seasonEn) {
    return Number(seasonEn[1]);
  }

  const seasonZh = normalizedName.match(/第\s*0?(\d{1,2})\s*季/);
  if (seasonZh) {
    return Number(seasonZh[1]);
  }

  // e.g. "2nd Season", "3rd season"
  const seasonOrdinal = normalizedName.match(/(?:^|[\s._\-\[])(\d{1,2})(?:st|nd|rd|th)\s*season(?:[\s._\-\]]|$)/i);
  if (seasonOrdinal) {
    return Number(seasonOrdinal[1]);
  }

  return null;
}

const EXCLUDED_SCAN_DIR_KEYWORDS = ['云盘缓存文件', '.drive', '@eaDir', '#recycle', '$recycle.bin'];
const NORMALIZED_EXCLUDED_SCAN_DIR_KEYWORDS = EXCLUDED_SCAN_DIR_KEYWORDS
  .map((k) => String(k || '').normalize('NFKC').toLowerCase());
const MIN_SCAN_FILE_SIZE_BYTES = 1 * 1024 * 1024;
const SCAN_IO_TIMEOUT_MS = toSafeInt(process.env.SCAN_IO_TIMEOUT_MS) || 1500;

function withScanTimeout(promise, op, target) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${op} timeout: ${target}`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, SCAN_IO_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function hasExcludedScanPathSegment(targetPath) {
  const parts = path.resolve(targetPath).split(path.sep).filter(Boolean);
  return parts.some((part) => {
    const p = String(part || '').trim().normalize('NFKC').toLowerCase();
    if (p.startsWith('.') && p.length > 1) {
      return true;
    }
    return NORMALIZED_EXCLUDED_SCAN_DIR_KEYWORDS.some((keyword) => p.includes(keyword));
  });
}

async function walkFiles(dir) {
  const out = [];
  const queue = [dir];

  while (queue.length > 0) {
    const current = queue.pop();
    let entries = [];
    try {
      entries = await withScanTimeout(fs.readdir(current, { withFileTypes: true }), 'readdir', current);
    } catch (err) {
      if (err && ['EACCES', 'EPERM', 'ENOENT', 'ETIMEDOUT'].includes(err.code)) {
        await logLine(`[WARN] skip unreadable dir during scan: ${current} (${err.code})`);
        continue;
      }
      throw err;
    }
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
        const ext = path.extname(entry.name).toLowerCase();
        if (!VIDEO_EXTENSIONS.has(ext)) {
          continue;
        }
        let stat = null;
        try {
          stat = await withScanTimeout(fs.stat(full), 'stat', full);
        } catch (err) {
          if (err && ['EACCES', 'EPERM', 'ENOENT', 'ETIMEDOUT'].includes(err.code)) {
            await logLine(`[WARN] skip unreadable file during scan: ${full} (${err.code})`);
            continue;
          }
          throw err;
        }
        if (stat.size < MIN_SCAN_FILE_SIZE_BYTES) {
          continue;
        }
        out.push({ file: full, size: stat.size });
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
  const seasonHint = detectSeasonHint(normalized);
  const hasSeasonPackHint = /(?:全\s*\d{1,3}\s*[集话話]|完结|完結|全季|全\d{1,2}季)/i.test(normalized);

  let type = 'movie';
  if (episodeMeta || seasonHint || hasSeasonPackHint) {
    type = 'tv';
  }

  let titleBase = normalized;
  if (episodeMeta?.pattern === 'sxe') {
    titleBase = titleBase.replace(/[Ss]\d{1,2}[Ee]\d{1,3}.*/, '');
  } else if (episodeMeta?.pattern === 'zh') {
    titleBase = titleBase.replace(/第\s*\d{1,3}\s*[集话話].*/i, '');
  } else if (episodeMeta?.pattern === 'ep') {
    titleBase = titleBase.replace(/(?:^|[\s._-])(?:ep?|e)\s*\d{1,3}.*/i, '');
  } else if (episodeMeta?.pattern === 'dashbracket') {
    titleBase = titleBase.replace(/-\s*0?\d{1,3}\s*\[.*/i, '');
  } else if (episodeMeta?.pattern === 'bracket') {
    titleBase = titleBase.replace(/\[\d{1,3}\].*/i, '');
  } else if (episodeMeta?.pattern === 'index') {
    titleBase = '';
  }
  if (!episodeMeta) {
    titleBase = titleBase
      .replace(/(?:^|[\s._\-\[])(?:season|s)\s*0?\d{1,2}(?:[\s._\-\]]|$)/gi, ' ')
      .replace(/第\s*0?\d{1,2}\s*季/gi, ' ')
      .replace(/(?:全\s*\d{1,3}\s*[集话話]|完结|完結|全季|全\d{1,2}季)/gi, ' ');
  }
  titleBase = titleBase.replace(/(?:19|20)\d{2}.*/, '');
  const cleaned = stripNoiseTokens(titleBase);
  const title = cleaned || (episodeMeta ? '' : stripNoiseTokens(noExt));

  return {
    title,
    year: yearMatch ? Number(yearMatch[0]) : null,
    type,
    season: (episodeMeta || seasonHint) ? Number(seasonHint || episodeMeta?.season || 1) : null,
    episode: episodeMeta ? Number(episodeMeta.episode) : null,
    confidence: 0.4,
    source: 'cleaner'
  };
}

async function parseByAI({
  filename,
  cleanedTitleHint = '',
  folderHintName = '',
  episodeHint = null,
  yearHint = null,
  standardZhTitleHint = ''
}) {
  const apiKey = process.env.AI_API_KEY;
  const apiBase = process.env.AI_API_BASE || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4.1-mini';

  if (!apiKey) {
    return { ...parseByHeuristic(filename), aiTimedOut: false };
  }

  const languageRule =
    TITLE_LANGUAGE === 'en'
      ? 'title 必须使用英文官方名（不要中文译名）。'
      : 'title 必须使用简体中文常用译名（不要英文名）。';
  const prompt = `你是影视文件识别器。根据“清洗后的标题提示 + 原始文件名 + 目录提示”输出严格 JSON，不要输出任何额外文字。\n字段：title(string),year(number|null),type(movie|tv|anime|show),season(number|null),episode(number|null),confidence(0-1)。\n额外规则：${languageRule}\n类型规则：只要作品是动画内容（包含日漫、欧美动画、动画剧集、cartoon、animated series），type 必须返回 anime，不要返回 tv。\n要求：优先基于清洗后的标题提示识别真实作品；忽略网址、分辨率、编码、字幕、原创等噪声。\n若“标准中文名提示”非空，优先使用该名称进行识别与消歧。\n标准中文名提示：${standardZhTitleHint || ''}\n清洗后的标题提示：${cleanedTitleHint || ''}\n目录提示：${folderHintName || ''}\n原始文件名：${filename}\n集数提示：${episodeHint ? `S${episodeHint.season}E${episodeHint.episode}` : ''}\n年份提示：${yearHint || ''}`;

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
      title: cleanName(parsed.title || standardZhTitleHint || cleanedTitleHint || filename.replace(/\.[^.]+$/, '')),
      year: toSafeInt(parsed.year),
      type,
      season: toSafeInt(parsed.season),
      episode: toSafeInt(parsed.episode),
      confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 0.5,
      source: 'ai',
      aiTimedOut: false
    };
  } catch (err) {
    openAICircuit();
    await logLine(`[WARN] AI fallback for ${filename}: ${err.message}`);
    return {
      ...parseByHeuristic(filename),
      source: isAIRequestTimeout(err) ? 'heuristic-timeout' : 'heuristic',
      aiTimedOut: isAIRequestTimeout(err)
    };
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

async function parseSeriesGroupByAI(fileNames, cleanedHints, folderHintName, cleanedFolderHint, fallback, standardZhTitleHint = '') {
  const apiKey = process.env.AI_API_KEY;
  const apiBase = process.env.AI_API_BASE || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4.1-mini';

  if (!apiKey) {
    return {
      title: fallback.title,
      year: fallback.year,
      type: 'tv',
      confidence: 0.4,
      source: 'heuristic-group',
      aiTimedOut: false
    };
  }

  const languageRule =
    TITLE_LANGUAGE === 'en'
      ? 'title 必须使用英文官方名（不要中文译名）。'
      : 'title 必须使用简体中文常用译名（不要英文名）。';

  const prompt = `你是剧集文件名识别器。下面这些文件来自同一部剧集，请输出统一信息。\n输出严格 JSON，不要输出任何额外文字。\n字段：title(string),year(number|null),type(tv|anime|show),confidence(0-1)。\n额外规则：${languageRule}\n类型规则：只要该剧是动画内容（包含日漫、欧美动画、cartoon、animated series），type 必须返回 anime，不要返回 tv。\n识别优先级：优先依据“标准中文名提示”和“清洗后的目录提示”，文件名仅作辅助。\n标准中文名提示：${standardZhTitleHint || ''}\n清洗后的目录提示：${cleanedFolderHint || ''}\n原始剧集目录名：${folderHintName}\n清洗后的文件提示列表：${cleanedHints.join(' | ')}\n原始文件名列表：${fileNames.join(' | ')}`;

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
      title: cleanName(parsed.title || standardZhTitleHint || fallback.title),
      year: toSafeInt(parsed.year),
      type,
      confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 0.7,
      source: 'ai-group',
      aiTimedOut: false
    };
  } catch (err) {
    openAICircuit();
    await logLine(`[WARN] AI group fallback for series: ${err.message}`);
    return {
      title: fallback.title,
      year: fallback.year,
      type: 'tv',
      confidence: 0.4,
      source: isAIRequestTimeout(err) ? 'heuristic-group-timeout' : 'heuristic-group',
      aiTimedOut: isAIRequestTimeout(err)
    };
  }
}

function buildSeriesGroupKey(heuristic) {
  const baseTitle = cleanName(heuristic.title || '').toLowerCase();
  const year = toSafeInt(heuristic.year) || 0;
  const season = toSafeInt(heuristic.season) || 1;
  return `${baseTitle}::${year}::s${season}`;
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

function extractEnglishTitleCandidate(...hints) {
  for (const hint of hints) {
    let t = cleanName(String(hint || ''));
    if (!t) {
      continue;
    }
    t = t
      .replace(/[\[\]\(\)\{\}]/g, ' ')
      .replace(/\b(?:2160p|1080p|720p|480p|4k|8k|x264|x265|h264|h265|hevc|avc|aac|flac|big5|gb|chs|cht|end|complete|batch|mp4|mkv|webrip|web[\s-]?dl|bluray|bdrip|remux)\b/gi, ' ')
      .replace(/\b(?:s\d{1,2}e\d{1,3}|ep?\s*\d{1,3}|season\s*\d{1,2})\b/gi, ' ')
      .replace(/第\s*\d{1,3}\s*[集话話]/gi, ' ');
    t = cleanName(t);
    if (!looksEnglishTitle(t)) {
      continue;
    }
    let words = t.split(/\s+/).filter((w) => /[A-Za-z]/.test(w) && !/^\d+$/.test(w));
    if (words.length >= 2 && /^[A-Z0-9]{2,6}$/.test(words[0])) {
      words = words.slice(1);
    }
    const candidate = cleanName(words.join(' '));
    if (!candidate) {
      continue;
    }
    if (candidate.split(/\s+/).length >= 2) {
      return candidate;
    }
  }
  return '';
}

function isCompleteChineseRecognition(meta) {
  return Boolean(meta && hasChinese(meta.title) && toSafeInt(meta.year));
}

function hasTitleWithoutYear(meta) {
  return Boolean(meta && cleanName(meta.title || '') && !toSafeInt(meta.year));
}

function extractChineseOnlyTitle(text) {
  const raw = cleanName(String(text || ''));
  if (!raw || !hasChinese(raw)) {
    return '';
  }
  const keep = raw
    .replace(/[A-Za-z0-9][A-Za-z0-9 '&:.\-]*/g, ' ')
    .replace(/\b(?:season|s)\s*\d{1,2}\b/gi, ' ')
    .replace(/\b(?:ep?|e)\s*\d{1,3}\b/gi, ' ')
    .replace(/(?:第\s*\d{1,3}\s*[集话話]|第\s*\d{1,2}\s*季)/gi, ' ');
  return cleanName(keep);
}

function normalizeTitleForCompare(text) {
  return cleanName(String(text || ''))
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

function getTypeHintForMetadata(typeHint) {
  if (typeHint === 'movie') return 'movie';
  if (typeHint === 'tv' || typeHint === 'anime' || typeHint === 'show') return 'tv';
  return 'multi';
}

async function inferChineseTitleByMetadata(title, context = {}) {
  const apiKey = process.env.TMDB_API_KEY || '';
  const apiBase = (process.env.TMDB_API_BASE || 'https://api.themoviedb.org/3').replace(/\/$/, '');
  const cleanTitle = cleanName(title || '');
  if (!apiKey || !cleanTitle || hasChinese(cleanTitle)) {
    return null;
  }

  const typeHint = ['movie', 'tv', 'anime', 'show'].includes(context.typeHint) ? context.typeHint : 'tv';
  const yearHint = toSafeInt(context.yearHint);
  const titleNorm = normalizeTitleForCompare(cleanTitle);
  const mediaTypeParam = getTypeHintForMetadata(typeHint);

  const url = new URL(`${apiBase}/search/${mediaTypeParam}`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('query', cleanTitle);
  url.searchParams.set('language', 'zh-CN');
  url.searchParams.set('include_adult', 'false');
  url.searchParams.set('page', '1');

  try {
    const resp = await fetchWithTimeout(url.toString(), { method: 'GET' });
    if (!resp.ok) {
      throw new Error(`TMDB HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    if (results.length === 0) {
      return null;
    }

    const scored = results
      .map((r) => {
        const zhName = cleanName(r?.name || r?.title || '');
        const origName = cleanName(r?.original_name || r?.original_title || '');
        const mediaType = r?.media_type || (mediaTypeParam === 'multi' ? '' : mediaTypeParam);
        const releaseDate = cleanName(r?.first_air_date || r?.release_date || '');
        const releaseYear = toSafeInt(String(releaseDate).slice(0, 4));
        const genreIds = Array.isArray(r?.genre_ids) ? r.genre_ids : [];
        let score = 0;
        if (zhName && hasChinese(zhName)) score += 3;
        const origNorm = normalizeTitleForCompare(origName);
        if (origNorm && (origNorm.includes(titleNorm) || titleNorm.includes(origNorm))) score += 4;
        if (typeHint === 'movie' && mediaType === 'movie') score += 2;
        if ((typeHint === 'tv' || typeHint === 'show' || typeHint === 'anime') && mediaType === 'tv') score += 2;
        if (yearHint && releaseYear && Math.abs(yearHint - releaseYear) <= 1) score += 1;
        if (typeHint === 'anime' && genreIds.includes(16)) score += 2;
        return { zhName, score };
      })
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < 4 || !best.zhName || !hasChinese(best.zhName)) {
      return null;
    }
    return best.zhName;
  } catch (err) {
    await logLine(`[WARN] metadata zh title fallback for ${cleanTitle}: ${err.message}`);
    return null;
  }
}

async function inferYearFromTitleByAI(title, typeHint = 'movie') {
  const apiKey = process.env.AI_API_KEY;
  const apiBase = process.env.AI_API_BASE || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4.1-mini';
  const cleanTitle = cleanName(title || '');

  if (!apiKey || !cleanTitle) {
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

async function inferMetaFromTitleByAI(title, context = {}) {
  const apiKey = process.env.AI_API_KEY;
  const apiBase = process.env.AI_API_BASE || 'https://api.openai.com/v1';
  const model = process.env.AI_META_MODEL || process.env.AI_MODEL || 'gpt-4.1';
  const cleanTitle = cleanName(title || '');
  const safeTypeHint = ['movie', 'tv', 'anime', 'show'].includes(context.typeHint) ? context.typeHint : 'tv';
  const safeYearHint = toSafeInt(context.yearHint);
  const safeFolderHint = cleanName(context.folderHint || '');
  const safeFileNameHint = cleanName(context.fileNameHint || '');
  const safeSeasonHint = toSafeInt(context.seasonHint);
  const safeEpisodeHint = toSafeInt(context.episodeHint);
  const safeEnglishTitle = cleanName(context.englishTitle || '');

  if (!apiKey || !cleanTitle) {
    return { year: null, type: null };
  }

  const prompt = `你是影视元数据校准器。根据标题和上下文，返回最可能的首映年份与类型。\n输出严格 JSON，不要额外文字。\n字段：year(number|null), type(movie|tv|anime|show|null), confidence(0-1)。\n规则：\n1) 如果是动画作品（含日漫、欧美动画、动画剧集），type 必须是 anime，不得返回 tv。\n2) 若信息不足，返回 null，不要猜测。\n3) 同名消歧时优先匹配目录/文件线索与季集线索。\n中文标题：${cleanTitle}\n英文标题线索：${safeEnglishTitle}\n类型线索：${safeTypeHint}\n年份线索：${safeYearHint || ''}\n目录线索：${safeFolderHint}\n文件线索：${safeFileNameHint}\n季号线索：${safeSeasonHint || ''}\n集号线索：${safeEpisodeHint || ''}`;

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
    const confidence = Number(parsed.confidence);
    const year = toSafeInt(parsed.year);
    const type = ['movie', 'tv', 'anime', 'show'].includes(parsed.type) ? parsed.type : null;
    if (Number.isFinite(confidence) && confidence < 0.72) {
      return { year: null, type: null };
    }
    return { year, type };
  } catch (err) {
    openAICircuit();
    await logLine(`[WARN] infer meta fallback for ${cleanTitle}: ${err.message}`);
    return { year: null, type: null };
  }
}

async function inferChineseTitleByAI(title, context = {}) {
  const apiKey = process.env.AI_API_KEY;
  const apiBase = process.env.AI_API_BASE || 'https://api.openai.com/v1';
  const model = process.env.AI_TITLE_MODEL || process.env.AI_MODEL || 'gpt-4.1';
  const cleanTitle = cleanName(title || '');
  const safeTypeHint = ['movie', 'tv', 'anime', 'show'].includes(context.typeHint) ? context.typeHint : 'movie';
  const safeYearHint = toSafeInt(context.yearHint);
  const safeFolderHint = cleanName(context.folderHint || '');
  const safeCleanedFolderHint = cleanName(context.cleanedFolderHint || '');
  const safeFileNameHint = cleanName(context.fileNameHint || '');
  const safeCleanedFileHint = cleanName(context.cleanedFileHint || '');
  const safeSeasonHint = toSafeInt(context.seasonHint);
  const safeEpisodeHint = toSafeInt(context.episodeHint);

  if (!apiKey || !cleanTitle || hasChinese(cleanTitle)) {
    return null;
  }

  const prompt = `你是影视标题标准化助手。请根据“英文标题 + 上下文线索”返回该影视作品最常用的简体中文名称。\n输出严格 JSON，不要输出额外文字。\n字段：title(string|null), confidence(0-1), isLiteralTranslation(boolean)。\n约束：\n1) 仅返回简体中文片名/剧名，不带年份、季号、分辨率、地区等附加信息。\n2) 必须先进行重名消歧：优先匹配与类型、年份、目录线索、季集线索一致的条目。\n3) 禁止按英文单词做字面直译（例如“跳过/摸鱼/洛弗/乐福鞋”这类词面翻译）；若只能得到直译，返回 null。\n4) 对动画作品优先采用中文社区常用正式译名（如豆瓣/Bangumi/B站等常见条目）。\n5) 若置信度不足或无法明确唯一条目，title 返回 null。\n英文标题：${cleanTitle}\n类型线索：${safeTypeHint}\n年份线索：${safeYearHint || ''}\n目录名线索：${safeFolderHint}\n目录清洗线索：${safeCleanedFolderHint}\n文件名线索：${safeFileNameHint}\n文件清洗线索：${safeCleanedFileHint}\n季号线索：${safeSeasonHint || ''}\n集号线索：${safeEpisodeHint || ''}`;

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
    const confidence = Number(parsed.confidence);
    const zhTitle = cleanName(parsed.title || '');
    const isLiteralTranslation = parsed.isLiteralTranslation === true;
    if (!zhTitle || !hasChinese(zhTitle)) {
      return null;
    }
    if (isLiteralTranslation) {
      return null;
    }
    if (Number.isFinite(confidence) && confidence < 0.7) {
      return null;
    }

    const verifyPrompt = `你是影视中文译名审核器。请判断“候选中文名”是否是该作品在中文语境下的常用正式译名，而非英文词面直译。\n输出严格 JSON：{"ok":boolean,"title":string|null,"confidence":number}。\n规则：\n1) 如果候选名不准确或偏直译，ok=false，并给出更准确的 title（若无法确定则 null）。\n2) 如果候选名准确，ok=true，title 返回候选名或同义常用名。\n英文标题：${cleanTitle}\n候选中文名：${zhTitle}\n类型线索：${safeTypeHint}\n年份线索：${safeYearHint || ''}\n目录名线索：${safeFolderHint}\n文件名线索：${safeFileNameHint}`;

    const verifyResp = await fetchWithTimeout(`${apiBase}/chat/completions`, {
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
          { role: 'user', content: verifyPrompt }
        ]
      })
    });
    if (!verifyResp.ok) {
      throw new Error(`AI HTTP ${verifyResp.status}`);
    }
    const verifyData = await verifyResp.json();
    const verifyText = verifyData?.choices?.[0]?.message?.content || '{}';
    const verifyParsed = JSON.parse(verifyText);
    const verifyTitle = cleanName(verifyParsed.title || '');
    const verifyConfidence = Number(verifyParsed.confidence);
    const verifyOk = verifyParsed.ok === true;
    if (!verifyOk) {
      if (verifyTitle && hasChinese(verifyTitle) && (!Number.isFinite(verifyConfidence) || verifyConfidence >= 0.75)) {
        return verifyTitle;
      }
      return null;
    }
    if (!verifyTitle || !hasChinese(verifyTitle)) {
      return zhTitle;
    }
    if (Number.isFinite(verifyConfidence) && verifyConfidence < 0.75) {
      return null;
    }
    return verifyTitle;
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
  const librarySeason = toSafeInt(entry.edited.librarySeason);
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

  const seasonNum = librarySeason || season || 1;
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

const taskSaveQueues = new Map();

async function saveTask(task) {
  const taskId = task.id;
  const file = path.join(TASK_DIR, `${taskId}.json`);
  task.updatedAt = nowISO();
  const data = `${JSON.stringify(task, null, 2)}\n`;
  const tmpFile = `${file}.tmp`;

  const prev = taskSaveQueues.get(taskId) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      await fs.writeFile(tmpFile, data, 'utf8');
      await fs.rename(tmpFile, file);
    });

  taskSaveQueues.set(taskId, next);
  try {
    await next;
  } finally {
    if (taskSaveQueues.get(taskId) === next) {
      taskSaveQueues.delete(taskId);
    }
  }
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
    aiTimeoutCount: 0,
    currentFile: '',
    scanError: '',
    applyStatus: 'idle',
    applyTotal: 0,
    applyDone: 0,
    applyBytesTotal: 0,
    applyBytesDone: 0,
    currentApplyFileBytes: 0,
    currentApplyFileBytesDone: 0,
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
  for (const item of allFiles) {
    if (hasExcludedScanPathSegment(item.file)) {
      continue;
    }
    const ext = path.extname(item.file).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) {
      continue;
    }
    videos.push({ file: item.file, ext, size: item.size });
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
  const metadataZhTitleCache = new Map();

  async function resolveMetadataZhTitle(englishTitle, context = {}) {
    const k = [
      cleanName(englishTitle || '').toLowerCase(),
      context.typeHint || '',
      toSafeInt(context.yearHint) || 0
    ].join('::');
    if (metadataZhTitleCache.has(k)) {
      return metadataZhTitleCache.get(k);
    }
    const p = inferChineseTitleByMetadata(englishTitle, context);
    metadataZhTitleCache.set(k, p);
    return p;
  }

  for (const item of preItems) {
    task.currentFile = item.basename;
    await pushProgress();
    const preferredTitleBase = cleanName(
      item.seriesHintHeuristic.title || item.heuristic.title || item.basename.replace(/\.[^.]+$/, '')
    );
    const hasZh = hasChinese(preferredTitleBase);
    const hasEn = looksEnglishTitle(preferredTitleBase);
    let normalizedTitle = preferredTitleBase;
    let source = 'cleaner';
    const englishOnlyRef = hasEn && !hasZh
      ? preferredTitleBase
      : extractEnglishTitleCandidate(item.seriesHintName, item.basename, item.heuristic.title);

    if (TITLE_LANGUAGE === 'zh') {
      if (hasZh && hasEn) {
        const chineseOnly = extractChineseOnlyTitle(preferredTitleBase);
        if (chineseOnly) {
          normalizedTitle = chineseOnly;
          source = 'cleaner-mixed-zh';
        }
      } else if (!hasZh && hasEn) {
        const zhTitle = await resolveMetadataZhTitle(preferredTitleBase, {
          typeHint: item.heuristic.type,
          yearHint: item.heuristic.year,
          seasonHint: item.heuristic.season,
          episodeHint: item.heuristic.episode
        });
        if (zhTitle) {
          normalizedTitle = zhTitle;
          source = 'metadata-zh';
        }
      }
    }

    const ai = {
      title: normalizedTitle || preferredTitleBase || item.basename.replace(/\.[^.]+$/, ''),
      year: item.heuristic.year || null,
      type: item.heuristic.type || 'movie',
      season: item.heuristic.season || null,
      episode: item.heuristic.episode || null,
      confidence: 0.6,
      source,
      englishRef: englishOnlyRef || null
    };

    const entry = {
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
        librarySeason: ai.season,
        episode: ai.episode
      },
      selected: true,
      status: 'pending',
      reason: '',
      target: null,
      subtitleMappings: []
    };
    task.entries.push(entry);
    task.scanDone += 1;
    recomputeTargets(task);
    try {
      entry.subtitleMappings = await buildSubtitleMappingsForEntry(entry);
    } catch (err) {
      entry.subtitleMappings = [];
      await logLine(`[WARN] subtitle mapping failed ${entry.sourcePath}: ${err.message}`);
    }
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

function getArchiveExt(name) {
  const lower = String(name || '').toLowerCase();
  const matched = ARCHIVE_EXTENSIONS.find((ext) => lower.endsWith(ext));
  return matched || '';
}

async function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (buf) => {
      stdout += String(buf || '');
    });
    child.stderr.on('data', (buf) => {
      stderr += String(buf || '');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const err = new Error(`${command} exited with code ${code}: ${stderr || stdout}`);
      err.code = code;
      reject(err);
    });
  });
}

async function walkSubtitleFiles(rootDir) {
  const out = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (SUBTITLE_EXTENSIONS.has(ext)) {
        out.push(full);
      }
    }
  }
  return out;
}

async function extractArchiveToDir(archivePath, targetDir) {
  const ext = getArchiveExt(path.basename(archivePath));
  const cwd = path.dirname(archivePath);
  const candidates = [];

  if (ext === '.zip') {
    candidates.push({ cmd: 'unzip', args: ['-o', archivePath, '-d', targetDir] });
    candidates.push({ cmd: '7z', args: ['x', '-y', `-o${targetDir}`, archivePath] });
  } else if (ext === '.rar') {
    candidates.push({ cmd: 'unrar', args: ['x', '-o+', archivePath, `${targetDir}${path.sep}`] });
    candidates.push({ cmd: '7z', args: ['x', '-y', `-o${targetDir}`, archivePath] });
  } else if (ext === '.7z') {
    candidates.push({ cmd: '7z', args: ['x', '-y', `-o${targetDir}`, archivePath] });
  } else {
    candidates.push({ cmd: 'tar', args: ['-xf', archivePath, '-C', targetDir] });
    candidates.push({ cmd: '7z', args: ['x', '-y', `-o${targetDir}`, archivePath] });
  }

  let lastErr = null;
  for (const c of candidates) {
    try {
      await runCommand(c.cmd, c.args, cwd);
      return true;
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'ENOENT') {
        continue;
      }
      // Some tools exist but fail on format; try next fallback command.
      continue;
    }
  }
  if (lastErr) {
    await logLine(`[WARN] archive extract failed ${archivePath}: ${lastErr.message}`);
  }
  return false;
}

function matchExtractedSubtitleSuffix(subPath, rootDir, originalBaseName) {
  const ext = path.extname(subPath).toLowerCase();
  if (!SUBTITLE_EXTENSIONS.has(ext)) {
    return null;
  }

  const fileNoExt = path.basename(subPath, ext);
  const exactSuffix = splitSubtitleSuffix(fileNoExt, originalBaseName);
  if (exactSuffix !== null) {
    return { ext, suffix: exactSuffix };
  }

  const rel = path.relative(rootDir, subPath);
  const relParts = rel.split(path.sep).filter(Boolean);
  if (relParts.includes(originalBaseName)) {
    return { ext, suffix: buildSubtitleSuffixFromSubsName(fileNoExt) };
  }

  return null;
}

async function moveFileWithFallback(sourcePath, targetPath, onProgress = null) {
  try {
    await fs.rename(sourcePath, targetPath);
    if (onProgress) {
      const stat = await fs.stat(targetPath);
      await onProgress(stat.size);
    }
    return;
  } catch (err) {
    if (err?.code !== 'EXDEV') {
      throw err;
    }
  }

  const sourceHandle = await fs.open(sourcePath, 'r');
  const targetHandle = await fs.open(targetPath, 'w');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) {
        break;
      }
      await targetHandle.write(buffer, 0, bytesRead, null);
      if (onProgress) {
        await onProgress(bytesRead);
      }
    }
  } catch (err) {
    try {
      await targetHandle.close();
    } catch {}
    try {
      await sourceHandle.close();
    } catch {}
    try {
      await fs.unlink(targetPath);
    } catch {}
    throw err;
  }
  await targetHandle.close();
  await sourceHandle.close();
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

function toStandardSubtitleLanguageCode(rawLanguage) {
  const normalized = String(rawLanguage || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_\-\u4e00-\u9fa5]/g, '');

  if (!normalized) {
    return 'und';
  }

  const mapping = new Map([
    ['english', 'en'], ['eng', 'en'], ['en', 'en'],
    ['chinese', 'zh'], ['chi', 'zh'], ['zho', 'zh'], ['zh', 'zh'], ['中文', 'zh'],
    ['simplified_chinese', 'zh-Hans'], ['chinese_simplified', 'zh-Hans'], ['chs', 'zh-Hans'], ['简体中文', 'zh-Hans'],
    ['traditional_chinese', 'zh-Hant'], ['chinese_traditional', 'zh-Hant'], ['cht', 'zh-Hant'], ['繁体中文', 'zh-Hant'],
    ['japanese', 'ja'], ['jpn', 'ja'], ['ja', 'ja'], ['日语', 'ja'],
    ['korean', 'ko'], ['kor', 'ko'], ['ko', 'ko'], ['韩语', 'ko'],
    ['spanish', 'es'], ['spa', 'es'], ['es', 'es'],
    ['french', 'fr'], ['fra', 'fr'], ['fre', 'fr'], ['fr', 'fr'],
    ['german', 'de'], ['deu', 'de'], ['ger', 'de'], ['de', 'de'],
    ['italian', 'it'], ['ita', 'it'], ['it', 'it'],
    ['portuguese', 'pt'], ['por', 'pt'], ['pt', 'pt'],
    ['brazilian_portuguese', 'pt-BR'], ['portuguese_br', 'pt-BR'], ['pt_br', 'pt-BR'], ['ptbr', 'pt-BR'],
    ['russian', 'ru'], ['rus', 'ru'], ['ru', 'ru'],
    ['arabic', 'ar'], ['ara', 'ar'], ['ar', 'ar'],
    ['turkish', 'tr'], ['tur', 'tr'], ['tr', 'tr'],
    ['thai', 'th'], ['tha', 'th'], ['th', 'th'],
    ['indonesian', 'id'], ['ind', 'id'], ['id', 'id'],
    ['vietnamese', 'vi'], ['vie', 'vi'], ['vi', 'vi'],
    ['dutch', 'nl'], ['nld', 'nl'], ['dut', 'nl'], ['nl', 'nl'],
    ['danish', 'da'], ['dan', 'da'], ['da', 'da'],
    ['swedish', 'sv'], ['swe', 'sv'], ['sv', 'sv'],
    ['norwegian', 'no'], ['nor', 'no'], ['bokmal', 'nb'], ['nb', 'nb'],
    ['finnish', 'fi'], ['fin', 'fi'], ['fi', 'fi'],
    ['polish', 'pl'], ['pol', 'pl'], ['pl', 'pl'],
    ['czech', 'cs'], ['ces', 'cs'], ['cze', 'cs'], ['cs', 'cs'],
    ['greek', 'el'], ['ell', 'el'], ['gre', 'el'], ['el', 'el'],
    ['romanian', 'ro'], ['ron', 'ro'], ['rum', 'ro'], ['ro', 'ro'],
    ['hungarian', 'hu'], ['hun', 'hu'], ['hu', 'hu'],
    ['hebrew', 'he'], ['heb', 'he'], ['he', 'he']
  ]);

  if (mapping.has(normalized)) {
    return mapping.get(normalized);
  }
  return normalized;
}

function buildSubtitleSuffixFromSubsName(fileNameNoExt) {
  const base = cleanName(String(fileNameNoExt || ''));
  if (!base) {
    return '.sub';
  }
  const m = base.match(/^(\d{1,3})\s*[-_ ]\s*(.+)$/);
  const track = m ? m[1] : '';
  const langRaw = m ? m[2] : base;
  const langCode = toStandardSubtitleLanguageCode(langRaw);
  return track ? `.${langCode}.${track}` : `.${langCode}`;
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

  // Handle release packs like Subs/<video-name-no-ext>/*.srt
  const subsEpisodeDir = path.join(sourceDir, 'Subs', originalBaseName);
  let subsNames = [];
  try {
    subsNames = await fs.readdir(subsEpisodeDir);
  } catch (err) {
    if (!err || !['ENOENT', 'ENOTDIR'].includes(err.code)) {
      throw err;
    }
  }
  for (const name of subsNames) {
    const fullPath = path.join(subsEpisodeDir, name);
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) {
      continue;
    }
    const ext = path.extname(name).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.has(ext)) {
      continue;
    }
    const subtitleNoExt = name.slice(0, -ext.length);
    const suffix = buildSubtitleSuffixFromSubsName(subtitleNoExt);
    items.push({ fullPath, ext, suffix });
  }

  // Handle subtitle archives found near source videos.
  const archiveKey = sourceDir;
  let extractedSubtitleItems = archiveExtractCache.get(archiveKey);
  if (!extractedSubtitleItems) {
    extractedSubtitleItems = [];
    let dirNames = [];
    try {
      dirNames = await fs.readdir(sourceDir);
    } catch {
      dirNames = [];
    }
    const archiveNames = dirNames.filter((name) => getArchiveExt(name));
    for (const name of archiveNames) {
      const archivePath = path.join(sourceDir, name);
      const stat = await fs.stat(archivePath).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }
      const extractRoot = path.join(
        sourceDir,
        SUB_ARCHIVE_TMP_DIR,
        `${path.basename(name, path.extname(name))}_${crypto.createHash('sha1').update(archivePath).digest('hex').slice(0, 8)}`
      );
      await fs.mkdir(extractRoot, { recursive: true });
      const ok = await extractArchiveToDir(archivePath, extractRoot);
      if (!ok) {
        continue;
      }
      const subtitles = await walkSubtitleFiles(extractRoot);
      extractedSubtitleItems.push(
        ...subtitles.map((subPath) => ({
          fullPath: subPath,
          extractRoot
        }))
      );
    }
    archiveExtractCache.set(archiveKey, extractedSubtitleItems);
  }
  for (const sub of extractedSubtitleItems) {
    const matched = matchExtractedSubtitleSuffix(sub.fullPath, sub.extractRoot, originalBaseName);
    if (!matched) {
      continue;
    }
    items.push({
      fullPath: sub.fullPath,
      ext: matched.ext,
      suffix: matched.suffix
    });
  }

  // Deduplicate by source path + target suffix.
  const dedup = new Map();
  for (const item of items) {
    const key = `${item.fullPath}::${item.suffix}::${item.ext}`;
    if (!dedup.has(key)) {
      dedup.set(key, item);
    }
  }
  return [...dedup.values()];
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

async function cleanupProcessedEntrySourceDirs(entry, movedSubtitles, inputRootDir) {
  const inputRoot = path.resolve(inputRootDir);
  const sourceParentDir = path.dirname(entry.sourcePath);

  // 1) Remove empty dirs left by subtitle packs, e.g. Subs/<episode-name>/
  for (const sub of movedSubtitles || []) {
    const subtitleSourceParent = path.dirname(sub.from);
    if (isWithinDir(subtitleSourceParent, inputRoot)) {
      await removeEmptyParentDirs(subtitleSourceParent, inputRoot);
    }
  }

  // 2) Remove companion folder that matches original video basename, e.g. <VideoName>/1.jpg
  const companionDir = path.join(sourceParentDir, entry.originalNameNoExt);
  try {
    const stat = await fs.stat(companionDir);
    if (stat.isDirectory() && isWithinDir(companionDir, inputRoot)) {
      const hasVideos = await hasAnyVideoFiles(companionDir);
      if (!hasVideos) {
        await removeAllFilesAndEmptyDirs(companionDir);
      }
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      throw err;
    }
  }
}

async function removeVideoContainerFolderIfExists(entry, inputRootDir) {
  const inputRoot = path.resolve(inputRootDir);
  const sourceParentDir = path.resolve(path.dirname(entry.sourcePath));

  if (!isWithinDir(sourceParentDir, inputRoot)) {
    return false;
  }
  // Never remove the input root directory itself.
  if (sourceParentDir === inputRoot) {
    return false;
  }

  let stat;
  try {
    stat = await fs.stat(sourceParentDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    return false;
  }

  // Keep the container when it still has meaningful media assets:
  // any subtitle file, or video file larger than 10 MB.
  const hasProtectedFiles = await hasLargeVideoOrSubtitleFiles(sourceParentDir);
  if (hasProtectedFiles) {
    return false;
  }

  await removeAllFilesAndEmptyDirs(sourceParentDir);
  try {
    await fs.rmdir(sourceParentDir);
  } catch (err) {
    if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY')) {
      throw err;
    }
  }
  return true;
}

async function buildSubtitleMappingsForEntry(entry) {
  if (!entry?.target?.fullPath) {
    return [];
  }
  const sidecars = await collectSidecarSubtitles(entry);
  if (sidecars.length === 0) {
    return [];
  }
  const sourceParent = path.dirname(entry.sourcePath);
  const videoFinalNoExt = entry.target.fullPath.slice(0, -path.extname(entry.target.fullPath).length);
  return sidecars.map((sub) => {
    const fromRel = path.relative(sourceParent, sub.fullPath) || path.basename(sub.fullPath);
    const toName = path.basename(`${videoFinalNoExt}${sub.suffix}${sub.ext}`);
    return {
      from: fromRel,
      to: toName
    };
  });
}

async function refreshSubtitleMappingsForTask(task) {
  for (const entry of task.entries) {
    try {
      entry.subtitleMappings = await buildSubtitleMappingsForEntry(entry);
    } catch (err) {
      entry.subtitleMappings = [];
      await logLine(`[WARN] subtitle mapping failed ${entry.sourcePath}: ${err.message}`);
    }
  }
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

async function hasLargeVideoOrSubtitleFiles(rootDir) {
  const LARGE_VIDEO_MIN_BYTES = 10 * 1024 * 1024;
  const queue = [path.resolve(rootDir)];
  while (queue.length > 0) {
    const dir = queue.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (SUBTITLE_EXTENSIONS.has(ext)) {
        return true;
      }
      if (!VIDEO_EXTENSIONS.has(ext)) {
        continue;
      }
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isFile() && stat.size > LARGE_VIDEO_MIN_BYTES) {
        return true;
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
  const selectedEntries = task.entries.filter((e) => e.selected && e.status !== 'success');
  task.applyTotal = selectedEntries.length;
  task.applyDone = 0;
  task.applyBytesTotal = selectedEntries.reduce((sum, e) => sum + (toSafeInt(e.size) || 0), 0);
  task.applyBytesDone = 0;
  task.currentApplyFileBytes = 0;
  task.currentApplyFileBytesDone = 0;
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
    if (entry.status === 'success') {
      result.skipped += 1;
      result.details.push({ entryId: entry.id, status: 'skipped', reason: 'already applied' });
      continue;
    }

    try {
      task.currentApplyFile = entry.sourceName;
      task.currentApplyFileBytes = toSafeInt(entry.size) || 0;
      task.currentApplyFileBytesDone = 0;
      await saveTask(task);
      const sourceParentDir = path.dirname(entry.sourcePath);

      // 1) Finalize rename + target structure first.
      const finalPath = await uniquePath(entry.target.fullPath);
      await ensureParentDir(finalPath);

      // 2) Move video file.
      let movedBytesForCurrent = 0;
      let lastSavedAt = Date.now();
      await moveFileWithFallback(entry.sourcePath, finalPath, async (chunkBytes) => {
        movedBytesForCurrent += chunkBytes;
        task.currentApplyFileBytesDone = movedBytesForCurrent;
        const now = Date.now();
        if (now - lastSavedAt >= APPLY_PROGRESS_SAVE_INTERVAL_MS) {
          await saveTask(task);
          lastSavedAt = now;
        }
      });
      task.currentApplyFileBytesDone = task.currentApplyFileBytes;
      const movedSubtitles = await moveSidecarSubtitles(entry, finalPath);
      await cleanupProcessedEntrySourceDirs(entry, movedSubtitles, task.inputDir);

      // 3) Remove the source container folder at the end (if safe).
      const removedContainerDir = await removeVideoContainerFolderIfExists(entry, task.inputDir);
      if (!removedContainerDir && isWithinDir(sourceParentDir, task.inputDir) && sourceParentDir !== path.resolve(task.inputDir)) {
        await removeEmptyParentDirs(sourceParentDir, task.inputDir);
      }
      entry.status = 'success';
      entry.reason = '';
      entry.selected = false;
      entry.appliedPath = finalPath;
      result.success += 1;
      result.details.push({
        entryId: entry.id,
        status: 'success',
        to: finalPath,
        subtitlesMoved: movedSubtitles.length,
        sourceContainerRemoved: removedContainerDir
      });
      task.applyDone += 1;
      task.applyBytesDone += toSafeInt(entry.size) || 0;
      task.currentApplyFileBytes = 0;
      task.currentApplyFileBytesDone = 0;
      await saveTask(task);
    } catch (err) {
      entry.status = 'failed';
      entry.reason = err.message;
      result.failed += 1;
      result.details.push({ entryId: entry.id, status: 'failed', reason: err.message });
      await logLine(`[ERROR] apply failed ${entry.sourcePath}: ${err.message}`);
      task.applyDone += 1;
      task.currentApplyFileBytes = 0;
      task.currentApplyFileBytesDone = 0;
      await saveTask(task);
    }
  }

  task.applyStatus = 'completed';
  task.currentApplyFileBytes = 0;
  task.currentApplyFileBytesDone = 0;
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
      aiTimeoutCount: 0,
      currentFile: '',
      scanError: '',
      applyStatus: 'idle',
      applyTotal: 0,
      applyDone: 0,
      applyBytesTotal: 0,
      applyBytesDone: 0,
      currentApplyFileBytes: 0,
      currentApplyFileBytesDone: 0,
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
      entry.edited.librarySeason = toSafeInt(up.librarySeason) || entry.edited.librarySeason || entry.edited.season || null;
      entry.edited.episode = toSafeInt(up.episode) || null;
      entry.selected = Boolean(up.selected);
    }

    recomputeTargets(task);
    await refreshSubtitleMappingsForTask(task);
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
    const selectedEntries = task.entries.filter((e) => e.selected && e.status !== 'success');
    task.applyTotal = selectedEntries.length;
    task.applyDone = 0;
    task.applyBytesTotal = selectedEntries.reduce((sum, e) => sum + (toSafeInt(e.size) || 0), 0);
    task.applyBytesDone = 0;
    task.currentApplyFileBytes = 0;
    task.currentApplyFileBytesDone = 0;
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
          failedTask.currentApplyFileBytes = 0;
          failedTask.currentApplyFileBytesDone = 0;
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
