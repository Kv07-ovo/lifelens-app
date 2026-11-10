/**
 * 日记：把某一天所有的 10 分钟汇总再汇总一次（二阶汇总）。
 *
 * 存储：<dataDir>/2026-11/diary/2026-11-10.json   ← 每天一个文件
 * 内容：简短总结、主要事项（3 件）、高光、待办、优化建议、温馨提示
 */
const fs = require('fs/promises');
const path = require('path');
const storage = require('./storage');
const { OfflineError } = require('./analyzer');
const { chatJson, extractJson, CATEGORIES } = require('./summarizer');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

const stringList = { type: 'array', items: { type: 'string' } };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'main_items', 'highlights', 'todos', 'suggestions', 'reminders'],
  properties: {
    summary: { type: 'string' },
    main_items: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail'],
        properties: { title: { type: 'string' }, detail: { type: 'string' } },
      },
    },
    highlights: stringList,
    todos: stringList,
    suggestions: stringList,
    reminders: stringList,
  },
};

const today = () => storage.parts(new Date()).date;

function dayStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

const dayEnd = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d + 1).getTime();
};

function diaryFile(dataDir, date) {
  return path.join(dataDir, date.slice(0, 7), 'diary', `${date}.json`);
}

const minutesText = (minutes) => (minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`);

/** 这一天的基础统计：各分类时长、各项目时长、用到的软件 */
function dayStats(entries) {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const projects = new Map();
  const apps = new Map();
  for (const e of entries) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 10;
    projects.set(e.project, (projects.get(e.project) || 0) + 10);
    for (const app of e.apps || []) apps.set(app, (apps.get(app) || 0) + 1);
  }
  const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  return {
    trackedMinutes: entries.length * 10,
    byCategory,
    projects: sorted(projects).map(([name, minutes]) => ({ name, minutes })),
    apps: sorted(apps).map(([name, count]) => ({ name, count })),
  };
}

function buildPrompt(date, entries, stats) {
  const lines = entries.map((e) => {
    const todos = e.todos && e.todos.length ? `；可能遗漏的待办：${e.todos.join('、')}` : '';
    return `[${e.slot}]（${e.category}）${e.project}：${String(e.description || '').replace(/\s+/g, ' ').slice(0, 220)}${todos}`;
  });
  const categoryText = CATEGORIES.filter((c) => stats.byCategory[c]).map((c) => `${c} ${minutesText(stats.byCategory[c])}`).join('，');
  const projectText = stats.projects.slice(0, 8).map((p) => `${p.name}（${minutesText(p.minutes)}）`).join('，');

  return (
    `下面是用户在 ${date} 这一天的电脑使用记录，每一条是一个 10 分钟时间段的汇总（共 ${entries.length} 条，按时间顺序）：\n\n` +
    `${lines.join('\n')}\n\n` +
    `这一天的统计：一共记录了 ${minutesText(stats.trackedMinutes)}。按分类：${categoryText}。按项目：${projectText}。\n\n` +
    '请根据以上内容，以第二人称（“你”）为用户写一篇当天的日记式回顾。只输出一个 JSON 对象，不要输出任何其他文字，字段如下：\n' +
    '- summary：简短总结，100 到 200 字，概括这一天是怎么过的。\n' +
    '- main_items：这一天做的最主要的三件事，恰好 3 项，按重要程度排序；每项包含 title（事项名称，尽量沿用记录里的项目名称）和 detail（做了什么、进展如何，50 到 100 字）。\n' +
    '- highlights：高光时刻，1 到 3 条，这一天里值得肯定的进展、成果或专注的时段。\n' +
    '- todos：待办事项，从记录中整理出还没完成或可能遗漏的事情；没有就输出 []。\n' +
    '- suggestions：优化建议，1 到 3 条，针对时间分配、专注程度、工作方式给出具体可执行的建议。\n' +
    '- reminders：温馨提示，1 到 3 条，关于休息、健康、作息等方面的贴心提醒。'
  );
}

function cleanList(value) {
  return (Array.isArray(value) ? value : []).map((item) => String(item == null ? '' : item).trim()).filter(Boolean);
}

function parseDiary(answer) {
  const data = extractJson(answer);
  const summary = String(data.summary || '').trim();
  if (!summary) throw new Error('模型返回的日记缺少总结');
  const mainItems = (Array.isArray(data.main_items) ? data.main_items : [])
    .map((item) =>
      typeof item === 'string'
        ? { title: item.trim(), detail: '' }
        : { title: String((item && item.title) || '').trim(), detail: String((item && item.detail) || '').trim() }
    )
    .filter((item) => item.title)
    .slice(0, 3);
  if (!mainItems.length) throw new Error('模型返回的日记缺少主要事项');
  return {
    summary,
    mainItems,
    highlights: cleanList(data.highlights),
    todos: cleanList(data.todos),
    suggestions: cleanList(data.suggestions),
    reminders: cleanList(data.reminders),
  };
}

/**
 * getExtraRoots() 返回其他设备同步过来的数据目录 [{ dir, device }]，只读。
 */
function createDiary({ getConfig, getModelName, withModel, summarizer, onChange, getExtraRoots = () => [] }) {
  const index = new Map(); // date -> { status, attempts, sourceCount, file, device, highlight, todos }
  let queue = []; // 等待生成的日期，从旧到新
  let runningDate = null;
  let working = false;
  let generation = 0;

  // highlight / todos 是给“每日一行索引”用的摘要
  const light = (entry, file, device) => ({
    status: entry.status,
    attempts: entry.attempts || 0,
    sourceCount: entry.sourceCount || 0,
    file,
    device: device || null,
    highlight: (entry.highlights && entry.highlights[0]) || '',
    todos: entry.todos || [],
  });

  async function loadRoot(root, device, into) {
    const months = (await fs.readdir(root).catch(() => [])).filter((n) => /^\d{4}-\d{2}$/.test(n));
    for (const month of months) {
      const dir = path.join(root, month, 'diary');
      const names = (await fs.readdir(dir).catch(() => [])).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
      for (const name of names) {
        const file = path.join(dir, name);
        const entry = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
        if (!entry || !entry.date || (device && entry.status !== 'done')) continue;
        // 同一天两台设备都写了日记时，用依据的汇总条数更多的那篇；一样多则后读到的（本机）优先
        const existing = into.get(entry.date);
        if (existing && existing.status === 'done' && (entry.status !== 'done' || (entry.sourceCount || 0) < existing.sourceCount)) continue;
        into.set(entry.date, light(entry, file, device));
      }
    }
  }

  async function loadIndex() {
    const fresh = new Map();
    for (const extra of getExtraRoots()) await loadRoot(extra.dir, extra.device, fresh);
    await loadRoot(getConfig().dataDir, null, fresh);
    index.clear();
    for (const [date, info] of fresh) index.set(date, info);
  }

  async function write(dataDir, entry) {
    const file = diaryFile(dataDir, entry.date);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry, null, 2), 'utf8');
    await fs.rename(tmp, file);
    index.set(entry.date, light(entry, file, null));
  }

  const readEntry = (date) => {
    const info = index.get(date);
    if (!info) return Promise.resolve(null);
    return fs.readFile(info.file, 'utf8').then(JSON.parse).then((entry) => ({ ...entry, device: info.device }), () => null);
  };

  async function generate(date) {
    const config = getConfig();
    const gen = generation;
    const entries = await summarizer.fullRange(dayStart(date), dayEnd(date));
    if (!entries.length) throw new Error('这一天没有可用的 10 分钟汇总');
    const stats = dayStats(entries);
    const prompt = buildPrompt(date, entries, stats);
    const reply = await withModel(() => chatJson(config, getModelName(), prompt, 'daily_diary', SCHEMA, 3000));
    const diary = parseDiary(reply.answer);
    if (gen !== generation) return;
    await write(config.dataDir, {
      version: 1,
      date,
      status: 'done',
      ...diary,
      stats,
      sourceCount: entries.length,
      model: reply.model,
      generatedAt: storage.localIso(new Date()),
      analysisMs: reply.ms,
      attempts: 0,
      error: null,
    });
  }

  async function pump() {
    if (working || !getConfig().analysisEnabled) return;
    working = true;
    const gen = generation;
    const tries = new Map();
    try {
      while (queue.length && gen === generation) {
        const date = queue.shift();
        runningDate = date;
        onChange();
        try {
          await generate(date);
        } catch (err) {
          if (gen !== generation) break;
          if (err instanceof OfflineError) {
            queue.unshift(date); // 模型没上线：留着下次再试
            break;
          }
          tries.set(date, (tries.get(date) || 0) + 1);
          if (tries.get(date) < 2) {
            queue.unshift(date);
          } else {
            const attempts = ((index.get(date) || {}).attempts || 0) + 1;
            await write(getConfig().dataDir, {
              version: 1,
              date,
              status: 'error',
              attempts,
              error: err.message,
              generatedAt: storage.localIso(new Date()),
            }).catch(() => {});
          }
        } finally {
          runningDate = null;
          onChange();
        }
      }
    } finally {
      working = false;
      onChange();
    }
  }

  function stateOf(date) {
    if (date === runningDate) return 'running';
    if (queue.includes(date)) return 'queued';
    const info = index.get(date);
    return info ? info.status : 'none'; // done / error / none
  }

  return {
    async reload() {
      generation += 1;
      queue = [];
      await loadIndex();
    },

    /** 找出还没有日记的过去日期（今天还没过完，不自动生成），排队生成 */
    ensure() {
      if (!getConfig().analysisEnabled) return;
      const now = today();
      const stillSummarizing = summarizer.pendingDates();
      for (const date of [...summarizer.doneDates().keys()].sort()) {
        if (date >= now || stillSummarizing.has(date) || date === runningDate || queue.includes(date)) continue;
        const info = index.get(date);
        if (info && (info.status === 'done' || info.attempts >= MAX_ATTEMPTS)) continue;
        queue.push(date);
      }
      queue.sort();
      onChange();
      pump();
    },

    /** 手动生成或重新生成某一天（包括今天） */
    request(date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date === runningDate) return;
      queue = [date, ...queue.filter((d) => d !== date)];
      onChange();
      pump();
    },

    status() {
      return { runningDate, queued: queue.length + (runningDate ? 1 : 0) };
    },

    /** 某个月每一天的情况，给日历用。month 为 1-12 */
    month(year, month) {
      const counts = summarizer.doneDates();
      const days = {};
      const total = new Date(year, month, 0).getDate();
      for (let d = 1; d <= total; d++) {
        const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        days[date] = { summaries: counts.get(date) || 0, diary: stateOf(date) };
      }
      return { year, month, today: today(), days };
    },

    /** 已生成日记的日期，从旧到新 */
    doneDates() {
      return [...index.entries()].filter(([, info]) => info.status === 'done').map(([date]) => date).sort();
    },

    /** [fromDate, toDate] 之间已生成的日记全文，从旧到新。问答检索用 */
    async entriesBetween(fromDate, toDate) {
      const out = [];
      for (const date of this.doneDates().filter((d) => d >= fromDate && d <= toDate)) {
        const entry = await readEntry(date);
        if (entry && entry.status === 'done') out.push(entry);
      }
      return out;
    },

    /** 只重新读取索引（同步拉到新数据后调用），不动排队中的任务 */
    load: loadIndex,

    /** date -> { highlight, todos }，给每日一行索引用 */
    brief(date) {
      const info = index.get(date);
      return info && info.status === 'done' ? { highlight: info.highlight, todos: info.todos } : null;
    },

    async get(date) {
      const state = stateOf(date);
      const summaries = summarizer.doneDates().get(date) || 0;
      const base = { date, state, summaries, today: today() };
      if (state !== 'done' && state !== 'error') return base;
      return { ...base, entry: await readEntry(date) };
    },
  };
}

module.exports = { createDiary, parseDiary, dayStats };
