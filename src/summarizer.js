/**
 * 每 10 分钟一次的活动汇总。
 *
 * 一个“时间段”（slot）是按整点对齐的 10 分钟：18:00–18:10、18:10–18:20 ...
 * 汇总只用文字：把这 10 分钟内每张截图的分析结果，加上上一个时间段的汇总，交给本地模型，
 * 让它输出结构化的 JSON（项目名称、分类、描述、软件列表、待办）。
 *
 * 存储：<dataDir>/2026-11/summaries/2026-11-10.json   ← 每天一个文件
 */
const fs = require('fs/promises');
const path = require('path');
const storage = require('./storage');
const { requestJson, OfflineError } = require('./analyzer');

const SLOT_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CATEGORIES = ['娱乐', '工作', '学习', '社交'];
const MAX_ATTEMPTS = 3; // 一个时间段累计失败这么多次后不再自动重试
const PREVIOUS_WINDOW_MS = 30 * 60 * 1000; // “上一个时间段”最多往前找这么久

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['project', 'category', 'description', 'apps', 'todos'],
  properties: {
    project: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    description: { type: 'string' },
    apps: { type: 'array', items: { type: 'string' } },
    todos: { type: 'array', items: { type: 'string' } },
  },
};

function slotStart(time) {
  const d = new Date(time);
  d.setMinutes(Math.floor(d.getMinutes() / 10) * 10, 0, 0);
  return d.getTime();
}

function slotId(start) {
  const p = storage.parts(new Date(start));
  return `${p.date.replace(/-/g, '')}-${p.hour}${p.clock.slice(3, 5)}`;
}

const clock = (ms) => storage.parts(new Date(ms)).clock.slice(0, 5);

function dayFile(dataDir, start) {
  const p = storage.parts(new Date(start));
  return path.join(dataDir, p.month, 'summaries', `${p.date}.json`);
}

async function readDay(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data && Array.isArray(data.summaries)) return data;
  } catch {
    /* 不存在或损坏都当作空 */
  }
  return null;
}

/* ---------- 调用模型 ---------- */

function buildPrompt(start, records, previous) {
  const lines = [];
  let last = '';
  for (const r of records) {
    const text = (r.sentences && r.sentences.length ? r.sentences.join('') : String(r.activity || '')).replace(/\s+/g, ' ');
    if (!text || text === last) continue; // 连续完全相同的记录只保留一条
    last = text;
    lines.push(`[${String(r.time || '').slice(11)}] ${text}`);
  }

  const previousText = previous
    ? `上一个时间段（${clock(previous.start)}–${clock(previous.end)}）的汇总：\n` +
      `项目名称：${previous.project}\n分类：${previous.category}\n` +
      `使用的软件：${(previous.apps || []).join('、') || '无'}\n` +
      `描述：${String(previous.description || '').slice(0, 700)}`
    : '没有上一个时间段的汇总。';

  return (
    `下面是用户在 ${storage.parts(new Date(start)).date} ${clock(start)}–${clock(start + SLOT_MS)} 这 10 分钟内的屏幕活动记录。` +
    `每条记录是对某一时刻屏幕截图的分析（约每 20 秒一条，共 ${records.length} 条）：\n\n` +
    `${lines.join('\n')}\n\n${previousText}\n\n` +
    '请结合上一个时间段的汇总，总结用户这 10 分钟在做什么。只输出一个 JSON 对象，不要输出任何其他文字，字段如下：\n' +
    '- project：用户正在做的项目名称，写成“动词+《名称》”的形式，要包含具体的游戏名、电视剧名、正在开发的软件名、正在写的文章名等，' +
    '例如 "玩《荒野大镖客》"、"写《2026年中报告》"、"开发《LifeLens》"。' +
    '如果和上一个时间段是同一件事，必须使用与上一个时间段完全相同的项目名称。\n' +
    '- category：用户当前行为的分类，只能是 "娱乐"、"工作"、"学习"、"社交" 四者之一。\n' +
    '- description：具体描述，1000 字左右。按时间顺序写清楚用户做了什么、用了什么、进展到哪一步、和上一个时间段相比有什么变化。\n' +
    '- apps：这 10 分钟里用到的软件名称列表，例如 ["Visual Studio Code", "Chrome", "微信"]。\n' +
    '- todos：用户可能遗漏的重要待办事项列表（例如没回复的消息、没保存的文件、报错没处理、提到但没做的事）；没有就输出空数组 []。'
  );
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const text = String(item == null ? '' : item).trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** 从模型回答里取出 JSON 对象 */
function extractJson(answer) {
  let text = Array.isArray(answer) ? answer.map((part) => part.text || '').join('') : String(answer || '');
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const first = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (first < 0 || lastBrace <= first) throw new Error('模型没有返回 JSON');
  try {
    return JSON.parse(text.slice(first, lastBrace + 1));
  } catch (err) {
    throw new Error(`模型返回的 JSON 无法解析：${err.message}`);
  }
}

/** 校验并规范化一条 10 分钟汇总 */
function parseAnswer(answer) {
  const data = extractJson(answer);
  const project = String(data.project || '').trim();
  const description = String(data.description || '').trim();
  const category = CATEGORIES.find((c) => String(data.category || '').includes(c));
  if (!project) throw new Error('模型返回的结果缺少项目名称');
  if (!category) throw new Error(`模型返回了不认识的分类：${data.category}`);
  if (!description) throw new Error('模型返回的结果缺少描述');
  return { project, category, description, apps: cleanList(data.apps), todos: cleanList(data.todos) };
}

/**
 * 让模型按 JSON Schema 输出，返回 { answer, model, ms }。10 分钟汇总和日记都用它。
 */
async function chatJson(config, detectedModel, prompt, schemaName, schema, maxTokens) {
  const model = config.model || detectedModel || 'default';
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: Math.max(config.maxTokens, maxTokens),
    temperature: 0.3,
    stream: false,
    response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
  };
  if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
  const options = {
    method: 'POST',
    apiKey: config.apiKey,
    timeoutMs: Math.max(config.requestTimeoutSec, 600) * 1000,
  };

  const started = Date.now();
  let data;
  try {
    data = await requestJson(`${config.baseUrl}/chat/completions`, { ...options, body });
  } catch (err) {
    // 有的服务不认识 response_format：去掉它再试一次，靠提示词约束输出
    if (err instanceof OfflineError || !/^HTTP 4/.test(err.message)) throw err;
    const { response_format: _dropped, ...plain } = body;
    data = await requestJson(`${config.baseUrl}/chat/completions`, { ...options, body: plain });
  }
  const answer = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return { answer, model: (data && data.model) || model, ms: Date.now() - started };
}

async function callModel(config, detectedModel, prompt) {
  // 1000 字的描述需要更大的输出上限
  const reply = await chatJson(config, detectedModel, prompt, 'activity_summary', SCHEMA, 3000);
  return { ...parseAnswer(reply.answer), model: reply.model, ms: reply.ms };
}

/* ---------- 汇总器 ---------- */

/**
 * getConfig()            当前配置
 * getModelName()         探测到的模型名
 * withModel(fn)          与截图分析共用一把锁，保证同一时间只给本地模型发一个请求
 * isAnalysisQueued(id)   某条截图记录是否还在等待分析
 * onChange()             汇总状态或结果变化时通知界面
 */
/**
 * getExtraRoots() 返回其他设备同步过来的数据目录 [{ dir, device }]，只读，和本机的汇总合并在一起用。
 */
function createSummarizer({ getConfig, getModelName, withModel, isAnalysisQueued, onChange, getExtraRoots = () => [] }) {
  const index = new Map(); // id -> 轻量信息（不含描述），用于热力图、筛选
  const pending = new Map(); // id -> { id, start, state: 'queued' | 'waiting' }
  let queue = []; // 等待汇总的时间段 id，从旧到新
  let runningId = null;
  let working = false;
  let lastScan = 0;
  let generation = 0; // 数据目录变化时 +1，让进行中的旧任务结果作废
  let chain = Promise.resolve();

  const locked = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  // file = 这条汇总所在的文件；device 只有来自其他设备时才有值
  const light = (e, file, device) => ({
    file: file || dayFile(getConfig().dataDir, e.startMs),
    device: device || null,
    id: e.id,
    start: e.startMs,
    end: e.startMs + SLOT_MS,
    status: e.status,
    attempts: e.attempts || 0,
    project: e.project || '',
    category: e.category || '',
    apps: e.apps || [],
    date: storage.parts(new Date(e.startMs)).date,
    todoCount: (e.todos || []).length,
    recordCount: e.recordCount || 0,
  });

  const stateFile = () => path.join(getConfig().dataDir, 'summary-state.json');

  async function loadRoot(root, device, into) {
    const months = (await fs.readdir(root).catch(() => [])).filter((n) => /^\d{4}-\d{2}$/.test(n));
    for (const month of months) {
      const dir = path.join(root, month, 'summaries');
      const names = (await fs.readdir(dir).catch(() => [])).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
      for (const name of names) {
        const file = path.join(dir, name);
        const data = await readDay(file);
        for (const entry of (data && data.summaries) || []) {
          // 其他设备上失败或跳过的时间段对本机没有意义，只合并成功的
          if (device && entry.status !== 'done') continue;
          into.set(entry.id, light(entry, file, device));
        }
      }
    }
  }

  async function loadIndex() {
    const fresh = new Map();
    // 先读其他设备的，再读本机的：同一个时间段两边都有时以本机为准
    for (const extra of getExtraRoots()) await loadRoot(extra.dir, extra.device, fresh);
    await loadRoot(getConfig().dataDir, null, fresh);
    index.clear();
    for (const [id, info] of fresh) index.set(id, info);
  }

  function writeEntry(dataDir, entry) {
    return locked(async () => {
      const file = dayFile(dataDir, entry.startMs);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const data = (await readDay(file)) || { version: 1, date: storage.parts(new Date(entry.startMs)).date, summaries: [] };
      data.summaries = data.summaries.filter((s) => s.id !== entry.id);
      data.summaries.push(entry);
      data.summaries.sort((a, b) => a.startMs - b.startMs);
      data.updatedAt = storage.localIso(new Date());
      data.count = data.summaries.length;
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmp, file);
    });
  }

  async function loadEntries(ids) {
    const byFile = new Map();
    for (const id of ids) {
      const info = index.get(id);
      if (!info) continue;
      if (!byFile.has(info.file)) byFile.set(info.file, new Set());
      byFile.get(info.file).add(id);
    }
    const found = new Map();
    for (const [file, wanted] of byFile) {
      const data = await locked(() => readDay(file));
      for (const entry of (data && data.summaries) || []) {
        if (wanted.has(entry.id)) found.set(entry.id, { ...entry, device: index.get(entry.id).device });
      }
    }
    return ids.map((id) => found.get(id)).filter(Boolean);
  }

  /** 找出已经结束、但还没汇总的时间段，放进队列。full = 从上次确认处理完的位置开始完整扫描 */
  async function scan(full) {
    const config = getConfig();
    if (!config.analysisEnabled) return;
    const gen = generation;
    const now = Date.now();
    const currentSlot = slotStart(now);

    let from;
    if (full) {
      const saved = await fs.readFile(stateFile(), 'utf8').then(JSON.parse).catch(() => null);
      from = (saved && Number(saved.scannedThroughMs)) || 0;
    } else {
      // 平时只需要看最近一小段，以及那些还在等截图分析完成的时间段
      const waiting = [...pending.values()].filter((p) => p.state === 'waiting').map((p) => p.start);
      from = Math.min(lastScan - 2 * SLOT_MS, ...waiting);
    }

    const files = (await storage.listHourFiles(config.dataDir)).filter((file) => {
      const hourStart = storage.hourFileStart(file);
      return hourStart + HOUR_MS > from && hourStart < currentSlot;
    });

    for (const file of files) {
      const data = await storage.readHourFile(file);
      if (gen !== generation) return;
      const slots = new Map();
      for (const record of (data && data.records) || []) {
        const start = slotStart(new Date(record.timestamp).getTime());
        if (Number.isNaN(start) || start >= currentSlot || start + SLOT_MS <= from) continue;
        if (!slots.has(start)) slots.set(start, []);
        slots.get(start).push(record);
      }
      for (const [start, records] of slots) {
        const id = slotId(start);
        if (id === runningId) continue;
        const done = index.get(id);
        // 只有本机已经处理过才跳过；别的设备碰巧有同一时间段的汇总不影响本机汇总自己的记录
        if (done && !done.device && (done.status !== 'error' || done.attempts >= MAX_ATTEMPTS)) continue;
        // 这个时间段里还有截图在排队等分析：先等它们分析完
        const waiting = records.some((r) => r.status === 'pending' && isAnalysisQueued(r.id));
        pending.set(id, { ...pending.get(id), id, start, state: waiting ? 'waiting' : 'queued' });
      }
    }

    queue = [...pending.values()]
      .filter((p) => p.state === 'queued')
      .sort((a, b) => a.start - b.start)
      .map((p) => p.id);
    lastScan = now;

    // 记下“这之前都处理完了”，下次启动不用从头扫
    const earliest = Math.min(currentSlot, ...[...pending.values()].map((p) => p.start));
    await fs.mkdir(config.dataDir, { recursive: true }).catch(() => {});
    await fs.writeFile(stateFile(), JSON.stringify({ scannedThroughMs: earliest, scannedThrough: storage.localIso(new Date(earliest)) }, null, 2), 'utf8').catch(() => {});
    onChange();
  }

  function findPrevious(start) {
    let best = null;
    for (const info of index.values()) {
      if (info.status !== 'done' || info.end > start || start - info.end > PREVIOUS_WINDOW_MS) continue;
      if (!best || info.start > best.start) best = info;
    }
    return best;
  }

  async function summarize(id) {
    const config = getConfig();
    const gen = generation;
    const { start } = pending.get(id);
    const base = {
      id,
      startMs: start,
      start: storage.localIso(new Date(start)),
      end: storage.localIso(new Date(start + SLOT_MS)),
      date: storage.parts(new Date(start)).date,
      slot: `${clock(start)}–${clock(start + SLOT_MS)}`,
    };

    const hour = await storage.readHourFile(storage.hourFile(config.dataDir, new Date(start)));
    const records = ((hour && hour.records) || []).filter(
      (r) => r.status === 'done' && r.activity && slotStart(new Date(r.timestamp).getTime()) === start
    );

    let entry;
    if (!records.length) {
      // 这 10 分钟的截图都没能分析出来，没有可汇总的内容
      entry = { ...base, status: 'skipped', recordCount: 0, generatedAt: storage.localIso(new Date()) };
    } else {
      const previousInfo = findPrevious(start);
      const [previous] = previousInfo ? await loadEntries([previousInfo.id]) : [];
      const prompt = buildPrompt(start, records, previous ? { ...previous, start: previous.startMs, end: previous.startMs + SLOT_MS } : null);
      const result = await withModel(() => callModel(config, getModelName(), prompt));
      entry = {
        ...base,
        status: 'done',
        project: result.project,
        category: result.category,
        description: result.description,
        apps: result.apps,
        todos: result.todos,
        recordCount: records.length,
        previousId: previous ? previous.id : null,
        model: result.model,
        generatedAt: storage.localIso(new Date()),
        analysisMs: result.ms,
        error: null,
      };
    }
    if (gen !== generation) return;
    await writeEntry(config.dataDir, entry);
    index.set(id, light(entry));
  }

  async function pump() {
    if (working || !getConfig().analysisEnabled) return;
    working = true;
    const gen = generation;
    try {
      while (queue.length && gen === generation) {
        const id = queue.shift();
        const job = pending.get(id);
        if (!job) continue;
        runningId = id;
        onChange();
        try {
          await summarize(id);
          if (gen === generation) pending.delete(id);
        } catch (err) {
          if (gen !== generation) break;
          if (err instanceof OfflineError) {
            queue.unshift(id); // 模型没上线：留在队列里，下次再试
            break;
          }
          job.tries = (job.tries || 0) + 1;
          if (job.tries < 2) {
            queue.unshift(id);
          } else {
            const attempts = ((index.get(id) || {}).attempts || 0) + 1;
            const entry = {
              id,
              startMs: job.start,
              start: storage.localIso(new Date(job.start)),
              end: storage.localIso(new Date(job.start + SLOT_MS)),
              date: storage.parts(new Date(job.start)).date,
              slot: `${clock(job.start)}–${clock(job.start + SLOT_MS)}`,
              status: 'error',
              attempts,
              error: err.message,
              generatedAt: storage.localIso(new Date()),
            };
            await writeEntry(getConfig().dataDir, entry).catch(() => {});
            index.set(id, light(entry));
            pending.delete(id);
          }
        } finally {
          runningId = null;
          onChange();
        }
      }
    } finally {
      working = false;
      onChange();
    }
  }

  /* ---------- 给界面用的查询 ---------- */

  function cellState(id) {
    if (id === runningId) return 'running';
    if (pending.has(id)) return pending.get(id).state; // queued / waiting
    const info = index.get(id);
    return info ? info.status : 'none'; // done / error / skipped / none
  }

  return {
    /** 启动或数据目录变化时调用：重建索引并完整扫描一次 */
    async reload() {
      generation += 1;
      pending.clear();
      queue = [];
      await loadIndex();
      await scan(true).catch(() => {});
      pump();
    },

    /** 只读取已有的汇总索引，不扫描、不调用模型、不写任何文件 */
    load: loadIndex,

    /** 定时调用：发现新结束的时间段并处理 */
    async tick() {
      await scan(false).catch(() => {});
      pump();
    },

    status() {
      const states = [...pending.values()];
      return {
        runningId,
        queued: states.filter((p) => p.state === 'queued').length + (runningId && !pending.has(runningId) ? 1 : 0),
        waiting: states.filter((p) => p.state === 'waiting').length,
      };
    },

    /** 最近 hours 个小时的热力图格子，按小时分列，每列 6 个 10 分钟 */
    heatmap(hours) {
      const now = Date.now();
      const currentSlot = slotStart(now);
      const firstHour = new Date(now);
      firstHour.setMinutes(0, 0, 0);
      const origin = firstHour.getTime() - (hours - 1) * HOUR_MS;
      const columns = [];
      for (let h = 0; h < hours; h++) {
        const hourStart = origin + h * HOUR_MS;
        const cells = [];
        for (let i = 0; i < 6; i++) {
          const start = hourStart + i * SLOT_MS;
          const id = slotId(start);
          const info = index.get(id);
          cells.push({
            id,
            start,
            label: `${clock(start)}–${clock(start + SLOT_MS)}`,
            state: start > currentSlot ? 'future' : start === currentSlot ? 'current' : cellState(id),
            category: info ? info.category : '',
            project: info ? info.project : '',
          });
        }
        columns.push({ hour: new Date(hourStart).getHours(), date: storage.parts(new Date(hourStart)).date, cells });
      }
      return columns;
    },

    async get(id) {
      const [entry] = await loadEntries([id]);
      return entry || null;
    },

    /** 时间线分页查询，从新到旧。filter: { project, apps[], from, to }（from/to 为毫秒） */
    async query({ project, apps, from, to, before, limit } = {}) {
      const wantedApps = (apps || []).map((a) => String(a).toLowerCase());
      const size = Math.min(100, Math.max(1, Number(limit) || 20));
      const matches = [...index.values()]
        .filter((info) => info.status === 'done')
        .filter((info) => !project || info.project === project)
        .filter((info) => !wantedApps.length || wantedApps.every((a) => info.apps.some((x) => x.toLowerCase() === a)))
        .filter((info) => !from || info.end > from)
        .filter((info) => !to || info.start < to)
        .filter((info) => !before || info.start < before)
        .sort((a, b) => b.start - a.start);
      const page = matches.slice(0, size);
      return {
        items: await loadEntries(page.map((info) => info.id)),
        total: matches.length,
        hasMore: matches.length > size,
        nextBefore: page.length ? page[page.length - 1].start : null,
      };
    },

    /** [from, to) 内已完成汇总的轻量信息（不含描述），从旧到新。看板统计用 */
    lightRange(from, to) {
      return [...index.values()]
        .filter((info) => info.status === 'done' && info.start >= from && info.start < to)
        .sort((a, b) => a.start - b.start);
    },

    /** [from, to) 内已完成汇总的完整内容，从旧到新。写日记用 */
    fullRange(from, to) {
      return loadEntries(this.lightRange(from, to).map((info) => info.id));
    },

    /** 有汇总的日期 -> 汇总条数 */
    doneDates() {
      const dates = new Map();
      for (const info of index.values()) {
        if (info.status === 'done') dates.set(info.date, (dates.get(info.date) || 0) + 1);
      }
      return dates;
    },

    /** 还有时间段在排队或等待汇总的日期 */
    pendingDates() {
      return new Set([...pending.values()].map((p) => storage.parts(new Date(p.start)).date));
    },

    /** 所有出现过的项目名称和软件，用于筛选 */
    facets() {
      const projects = new Map();
      const apps = new Map();
      for (const info of index.values()) {
        if (info.status !== 'done') continue;
        const p = projects.get(info.project) || { name: info.project, count: 0, last: 0 };
        p.count += 1;
        p.last = Math.max(p.last, info.start);
        projects.set(info.project, p);
        for (const app of info.apps) {
          const key = app.toLowerCase();
          const a = apps.get(key) || { name: app, count: 0 };
          a.count += 1;
          apps.set(key, a);
        }
      }
      return {
        projects: [...projects.values()].sort((a, b) => b.last - a.last),
        apps: [...apps.values()].sort((a, b) => b.count - a.count),
      };
    },
  };
}

module.exports = { createSummarizer, chatJson, extractJson, parseAnswer, slotStart, slotId, CATEGORIES, SLOT_MS };
