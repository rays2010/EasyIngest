const dotenv = require('dotenv');
const express = require('express');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

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

async function walkFiles(dir) {
  const out = [];
  const queue = [dir];

  while (queue.length > 0) {
    const current = queue.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
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
  const seasonEpisode = normalized.match(/[Ss](\d{1,2})[Ee](\d{1,2})/);

  let type = 'movie';
  if (seasonEpisode) {
    type = 'tv';
  }

  const title = cleanName(
    normalized
      .replace(/[Ss]\d{1,2}[Ee]\d{1,2}.*/, '')
      .replace(/(?:19|20)\d{2}.*/, '')
  ) || cleanName(noExt);

  return {
    title,
    year: yearMatch ? Number(yearMatch[0]) : null,
    type,
    season: seasonEpisode ? Number(seasonEpisode[1]) : null,
    episode: seasonEpisode ? Number(seasonEpisode[2]) : null,
    confidence: 0.4,
    source: 'heuristic'
  };
}

async function parseByAI(filename) {
  const apiKey = process.env.AI_API_KEY;
  const apiBase = process.env.AI_API_BASE || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4.1-mini';

  if (!apiKey) {
    return parseByHeuristic(filename);
  }

  const languageRule =
    TITLE_LANGUAGE === 'en'
      ? 'title 必须使用英文官方名（不要中文译名）。'
      : 'title 必须使用简体中文常用译名（不要英文名）。';
  const prompt = `你是视频文件名识别器。根据文件名输出严格 JSON，不要输出任何额外文字。\n字段：title(string),year(number|null),type(movie|tv|anime|show),season(number|null),episode(number|null),confidence(0-1)。\n额外规则：${languageRule}\n文件名：${filename}`;

  try {
    const resp = await fetch(`${apiBase}/chat/completions`, {
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
      title: cleanName(parsed.title || filename.replace(/\.[^.]+$/, '')),
      year: toSafeInt(parsed.year),
      type,
      season: toSafeInt(parsed.season),
      episode: toSafeInt(parsed.episode),
      confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 0.5,
      source: 'ai'
    };
  } catch (err) {
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

async function parseSeriesGroupByAI(fileNames, folderHintName, fallback) {
  const apiKey = process.env.AI_API_KEY;
  const apiBase = process.env.AI_API_BASE || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4.1-mini';

  if (!apiKey) {
    return {
      title: fallback.title,
      year: fallback.year,
      type: fallback.type || 'tv',
      confidence: 0.4,
      source: 'heuristic-group'
    };
  }

  const languageRule =
    TITLE_LANGUAGE === 'en'
      ? 'title 必须使用英文官方名（不要中文译名）。'
      : 'title 必须使用简体中文常用译名（不要英文名）。';

  const prompt = `你是剧集文件名识别器。下面这些文件来自同一部剧集，请输出统一信息。\n输出严格 JSON，不要输出任何额外文字。\n字段：title(string),year(number|null),type(tv|anime|show),confidence(0-1)。\n额外规则：${languageRule}\n识别优先级：优先依据“剧集目录名”，文件名仅作辅助。\n剧集目录名：${folderHintName}\n文件名列表：${fileNames.join(' | ')}`;

  try {
    const resp = await fetch(`${apiBase}/chat/completions`, {
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
    await logLine(`[WARN] AI group fallback for series: ${err.message}`);
    return {
      title: fallback.title,
      year: fallback.year,
      type: fallback.type || 'tv',
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

  if (!apiKey || !cleanTitle) {
    return null;
  }

  const safeTypeHint = ['movie', 'tv', 'anime', 'show'].includes(typeHint) ? typeHint : 'movie';
  const prompt = `你是影视年份查询器。根据给定标题推断最可能的“影视作品”首映年份，返回严格 JSON，不要输出额外文字。\n字段：year(number|null)。\n限定：只考虑电影/电视剧/动画/综艺/纪录片等影视作品；不要参考小说、漫画、游戏、音乐专辑等同名内容。\n若存在重名，优先选择最广为人知且与给定类型最匹配的影视条目。\n标题：${cleanTitle}\n类型：${safeTypeHint}`;

  try {
    const resp = await fetch(`${apiBase}/chat/completions`, {
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
    await logLine(`[WARN] infer year fallback for ${cleanTitle}: ${err.message}`);
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

async function createTask({ inputDir, outputDir }) {
  const allFiles = await walkFiles(inputDir);
  const videos = [];

  for (const file of allFiles) {
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

  async function resolveYearByTitle(title, typeHint) {
    const k = `${cleanName(title || '').toLowerCase()}::${typeHint || ''}`;
    if (yearByTitleCache.has(k)) {
      return yearByTitleCache.get(k);
    }
    const y = await inferYearFromTitleByAI(title, typeHint);
    yearByTitleCache.set(k, y);
    return y;
  }

  for (const [key, groupItems] of seriesGroups.entries()) {
    if (groupItems.length < 2) {
      continue;
    }
    const fallback = groupItems[0].seriesHintHeuristic;
    const folderHintName = groupItems[0].seriesHintName;
    const aiGroup = await parseSeriesGroupByAI(groupItems.map((g) => g.basename), folderHintName, fallback);
    seriesGroupMeta.set(key, aiGroup);
  }

  const entries = [];
  for (const item of preItems) {
    const groupKey = buildSeriesGroupKey(item.seriesHintHeuristic);
    const groupMeta = seriesGroupMeta.get(groupKey);
    const aiSingle = groupMeta ? null : await parseByAI(item.basename);
    const localNameSource = groupMeta ? item.seriesHintHeuristic : item.heuristic;
    const keepLocalName = isCompleteChineseRecognition(localNameSource);
    const ai = groupMeta
      ? {
          title: keepLocalName ? localNameSource.title : groupMeta.title,
          year: keepLocalName ? localNameSource.year : groupMeta.year,
          type: groupMeta.type,
          season: item.heuristic.season || groupMeta.season || null,
          episode: item.heuristic.episode || groupMeta.episode || null,
          confidence: groupMeta.confidence,
          source: groupMeta.source
        }
      : {
          title: keepLocalName ? localNameSource.title : aiSingle.title,
          year: keepLocalName ? localNameSource.year : aiSingle.year,
          type: aiSingle.type,
          season: item.heuristic.season || aiSingle.season || null,
          episode: item.heuristic.episode || aiSingle.episode || null,
          confidence: aiSingle.confidence,
          source: aiSingle.source
        };

    if (hasTitleWithoutYear(localNameSource)) {
      const inferredYear = await resolveYearByTitle(localNameSource.title, ai.type);
      if (inferredYear) {
        ai.year = inferredYear;
      }
    }

    entries.push({
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
  }

  const task = {
    id: crypto.randomUUID(),
    inputDir,
    outputDir,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    entries
  };

  recomputeTargets(task);
  await saveTask(task);
  return task;
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
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
    await fs.rename(sub.fullPath, target);
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

  for (const entry of task.entries) {
    if (!entry.selected) {
      result.skipped += 1;
      entry.status = 'skipped';
      entry.reason = 'not selected';
      result.details.push({ entryId: entry.id, status: 'skipped', reason: 'not selected' });
      continue;
    }

    try {
      const sourceParentDir = path.dirname(entry.sourcePath);
      const finalPath = await uniquePath(entry.target.fullPath);
      await ensureParentDir(finalPath);
      await fs.rename(entry.sourcePath, finalPath);
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
    } catch (err) {
      entry.status = 'failed';
      entry.reason = err.message;
      result.failed += 1;
      result.details.push({ entryId: entry.id, status: 'failed', reason: err.message });
      await logLine(`[ERROR] apply failed ${entry.sourcePath}: ${err.message}`);
    }
  }

  if (!(await hasAnyVideoFiles(task.inputDir))) {
    await removeAllFilesAndEmptyDirs(task.inputDir);
    await logLine(`[INFO] cleaned non-video leftovers under ${task.inputDir}`);
  }

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
    const task = await createTask({ inputDir, outputDir });
    await logLine(`[INFO] task created ${task.id} entries=${task.entries.length}`);
    return res.json(task);
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
    const result = await applyTask(task);
    await logLine(`[INFO] task applied ${task.id} success=${result.success} failed=${result.failed}`);
    return res.json(result);
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
