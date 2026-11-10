/**
 * 问答：模型自己决定去哪里搜、搜什么、搜哪段时间，最多搜 3 次，然后根据搜到的内容回答。
 *
 * 每一步都只做一件事：
 *   1. 把问题和已有的搜索结果交给模型，让它输出下一步（JSON）：再搜一次，或者可以回答了
 *   2. 如果要搜：在限定的时间范围和条数内做关键词匹配，把结果记下来，回到 1
 *   3. 最后把所有搜索结果交给模型，生成回答
 *
 * 三种数据各有搜索范围上限，避免一次读太多文件：
 *   record  每 20 秒的截图分析   一次最多 24 小时
 *   summary 每 10 分钟的汇总     一次最多 31 天
 *   diary   每天的日记           一次最多 366 天
 */
const storage = require('./storage');
const { requestJson } = require('./analyzer');
const { chatJson, extractJson } = require('./summarizer');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_SEARCHES = 3;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const SOURCES = {
  record: { name: '20 秒截图分析', maxRange: DAY_MS, defaultRange: 2 * HOUR_MS, limit: 12, chars: 160 },
  summary: { name: '10 分钟汇总', maxRange: 31 * DAY_MS, defaultRange: 7 * DAY_MS, limit: 8, chars: 320 },
  diary: { name: '日记', maxRange: 366 * DAY_MS, defaultRange: 30 * DAY_MS, limit: 5, chars: 600 },
};

const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'source', 'keywords', 'from', 'to'],
  properties: {
    action: { type: 'string', enum: ['search', 'answer'] },
    source: { type: 'string', enum: ['record', 'summary', 'diary'] },
    keywords: { type: 'array', items: { type: 'string' } },
    from: { type: 'string' },
    to: { type: 'string' },
  },
};

const stamp = (ms) => {
  const p = storage.parts(new Date(ms));
  return `${p.date} ${p.clock.slice(0, 5)}`;
};

function parseTime(text) {
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(String(text || ''));
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime();
}

/** 把模型给的时间范围整理成合法、且不超过上限的 [from, to) */
function clampRange(source, fromText, toText) {
  const spec = SOURCES[source];
  const now = Date.now();
  let to = parseTime(toText);
  let from = parseTime(fromText);
  if (Number.isNaN(to) || to > now) to = now;
  if (Number.isNaN(from) || from >= to) from = to - spec.defaultRange;
  let clamped = false;
  if (to - from > spec.maxRange) {
    from = to - spec.maxRange; // 太大：保留离结束时间最近的那一段
    clamped = true;
  }
  return { from, to, clamped };
}

/** 关键词匹配：命中的关键词越多越靠前；没给关键词就按时间取最近的 */
function pick(items, keywords, limit) {
  const words = keywords.map((k) => k.toLowerCase());
  const scored = items
    .map((item) => {
      const text = item.text.toLowerCase();
      return { ...item, score: words.length ? words.filter((w) => text.includes(w)).length : 1 };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.time - a.time);
  return { total: scored.length, hits: scored.slice(0, limit).sort((a, b) => a.time - b.time) };
}

function createQa({ getConfig, getModelName, withModel, summarizer, diary, onProgress }) {
  let busy = false;

  /* ---------- 三种数据的搜索 ---------- */

  async function loadItems(source, from, to) {
    if (source === 'summary') {
      const entries = await summarizer.fullRange(from, to);
      return entries.map((e) => ({
        time: e.startMs,
        label: `${e.date} ${e.slot}（${e.category}）${e.project}`,
        body: `${e.description}${e.apps && e.apps.length ? ` 软件：${e.apps.join('、')}` : ''}${e.todos && e.todos.length ? ` 待办：${e.todos.join('、')}` : ''}`,
      }));
    }
    if (source === 'diary') {
      const entries = await diary.entriesBetween(storage.parts(new Date(from)).date, storage.parts(new Date(to - 1)).date);
      return entries.map((e) => ({
        time: parseTime(e.date),
        label: `${e.date} 的日记`,
        body:
          `${e.summary} 主要事项：${e.mainItems.map((i) => `${i.title}（${i.detail}）`).join('；')}` +
          `${e.highlights.length ? ` 高光：${e.highlights.join('；')}` : ''}${e.todos.length ? ` 待办：${e.todos.join('；')}` : ''}`,
      }));
    }
    // record：只读时间范围内的小时文件
    const files = (await storage.listHourFiles(getConfig().dataDir)).filter((file) => {
      const start = storage.hourFileStart(file);
      return start + HOUR_MS > from && start < to;
    });
    const items = [];
    let last = '';
    for (const file of files.reverse()) {
      const data = await storage.readHourFile(file);
      for (const r of (data && data.records) || []) {
        const time = new Date(r.timestamp).getTime();
        const body = String(r.activity || '').replace(/\s+/g, ' ');
        if (r.status !== 'done' || !body || time < from || time >= to || body === last) continue;
        last = body;
        items.push({ time, label: r.time, body });
      }
    }
    return items;
  }

  async function search(step) {
    const source = SOURCES[step.source] ? step.source : 'summary';
    const spec = SOURCES[source];
    const keywords = (Array.isArray(step.keywords) ? step.keywords : [])
      .map((k) => String(k || '').trim())
      .filter(Boolean)
      .slice(0, 6);
    const range = clampRange(source, step.from, step.to);
    const items = (await loadItems(source, range.from, range.to)).map((item) => ({ ...item, text: `${item.label} ${item.body}` }));
    const { total, hits } = pick(items, keywords, spec.limit);
    return {
      source,
      sourceName: spec.name,
      keywords,
      from: stamp(range.from),
      to: stamp(range.to),
      clamped: range.clamped,
      scanned: items.length,
      total,
      results: hits.map((hit) => `[${hit.label}] ${hit.body.slice(0, spec.chars)}`),
    };
  }

  /* ---------- 每日一行索引 ---------- */

  /**
   * 把最近一段时间压成“每天一行”的高密度索引（思路来自 AOCI：固定字段、一行一条、先整体读一遍再去查原文）。
   * 一行的格式：
   *   日期[周几|工作h 学习h 娱乐h 社交h]: P:主要项目和时长 | A:常用软件 | H:当天高光 | T:待办
   * 全部由已有的汇总和日记拼出来，不调用模型。最多 120 天、约 9000 字，超出就丢掉最旧的。
   */
  function buildIndex() {
    const now = Date.now();
    const days = new Map();
    for (const info of summarizer.lightRange(now - 120 * DAY_MS, now)) {
      const day = days.get(info.date) || { hours: {}, projects: new Map(), apps: new Map(), devices: new Set() };
      day.hours[info.category] = (day.hours[info.category] || 0) + info.minutes / 60;
      day.projects.set(info.project, (day.projects.get(info.project) || 0) + info.minutes / 60);
      for (const app of info.apps) day.apps.set(app, (day.apps.get(app) || 0) + 1);
      if (info.device) day.devices.add(info.device);
      days.set(info.date, day);
    }
    const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    const hours = (value) => +value.toFixed(1);
    const lines = [...days.keys()].sort().map((date) => {
      const day = days.get(date);
      const weekday = WEEKDAYS[new Date(parseTime(date)).getDay()].slice(1);
      const cats = [['工作', '工'], ['学习', '学'], ['娱乐', '娱'], ['社交', '社']]
        .filter(([name]) => day.hours[name])
        .map(([name, short]) => `${short}${hours(day.hours[name])}`)
        .join(' ');
      const fields = [
        `P:${top(day.projects, 3).map(([name, h]) => `${name}${hours(h)}h`).join(',')}`,
        `A:${top(day.apps, 4).map(([name]) => name).join(',')}`,
      ];
      const brief = diary.brief(date);
      if (brief && brief.highlight) fields.push(`H:${brief.highlight.slice(0, 40)}`);
      if (brief && brief.todos.length) fields.push(`T:${brief.todos.slice(0, 2).join(';').slice(0, 50)}`);
      if (day.devices.size) fields.push(`D:${[...day.devices].join(',')}`);
      return `${date}[${weekday}|${cats}]: ${fields.join(' | ')}`;
    });
    while (lines.length > 1 && lines.join('\n').length > 9000) lines.shift();
    if (!lines.length) return '';
    return (
      '下面是用户最近每天的活动索引，一天一行。格式：日期[周几|工=工作 学=学习 娱=娱乐 社=社交，数字是小时]: ' +
      'P:主要项目和小时数 | A:常用软件 | H:当天高光 | T:待办 | D:数据来自的其他设备。\n' +
      `${lines.join('\n')}\n\n`
    );
  }

  /* ---------- 提示词 ---------- */

  function describeSearches(searches) {
    if (!searches.length) return '还没有搜索过。';
    return searches
      .map((s, i) => {
        const head =
          `第 ${i + 1} 次搜索：${s.sourceName}，关键词 ${s.keywords.length ? s.keywords.join('、') : '（无，按时间列出）'}，` +
          `时间 ${s.from} 到 ${s.to}${s.clamped ? '（范围超过上限，已自动缩小）' : ''}，` +
          `共 ${s.scanned} 条记录，命中 ${s.total} 条${s.total > s.results.length ? `，下面是其中 ${s.results.length} 条` : ''}：`;
        return `${head}\n${s.results.length ? s.results.join('\n') : '（没有命中）'}`;
      })
      .join('\n\n');
  }

  function describeData() {
    const summaryDates = [...summarizer.doneDates().keys()].sort();
    const diaryDates = diary.doneDates();
    const span = (dates) => (dates.length ? `${dates[0]} 到 ${dates[dates.length - 1]}，共 ${dates.length} 天有数据` : '暂无数据');
    return `summary：${span(summaryDates)}；diary：${span(diaryDates)}；record 的日期范围与 summary 相近。`;
  }

  function describeHistory(history) {
    const turns = (Array.isArray(history) ? history : []).slice(-2);
    if (!turns.length) return '';
    return `之前的对话：\n${turns.map((t) => `用户：${String(t.question).slice(0, 200)}\n助手：${String(t.answer).slice(0, 300)}`).join('\n')}\n\n`;
  }

  function stepPrompt(question, history, searches) {
    const now = new Date();
    const left = MAX_SEARCHES - searches.length;
    return (
      '你是 LifeLens 的问答助手。LifeLens 持续记录用户的电脑使用情况，有三种数据可以搜索：\n' +
      '- record：每 20 秒一次的屏幕截图分析，最细。适合问某个具体时刻在做什么。一次最多搜 24 小时。\n' +
      '- summary：每 10 分钟的汇总，包含项目名称、分类（工作/学习/娱乐/社交）、描述、用到的软件、待办。适合问某一天或几天内做了什么、某个项目或软件。一次最多搜 31 天。\n' +
      '- diary：每天的日记，包含总结、主要事项、高光、待办、建议。适合问较长时间跨度的回顾。一次最多搜 366 天。\n\n' +
      `现在是 ${stamp(now.getTime())}（${WEEKDAYS[now.getDay()]}）。现有数据：${describeData()}\n\n` +
      `${buildIndex()}` +
      '先看上面的每日索引了解全局：它能直接回答的问题（比如某天主要做了什么、各类时间多少）不需要再搜；需要细节时，用索引确定该搜哪几天、用什么项目名或软件名做关键词。\n\n' +
      `${describeHistory(history)}用户的问题：${question}\n\n${describeSearches(searches)}\n\n` +
      `你还可以搜索 ${left} 次。请决定下一步，只输出一个 JSON 对象：\n` +
      '- action："search" 表示再搜一次；"answer" 表示已有内容足够回答，或者这个问题不需要查记录。\n' +
      '- source：要搜的数据，"record"、"summary" 或 "diary"。\n' +
      '- keywords：1 到 5 个搜索关键词，用记录里可能出现的短词（项目名、软件名、人名、主题词），同义词分开列；记录内容是中文。如果想按时间列出这段时间的全部内容，就给空数组 []。\n' +
      '- from、to：搜索的时间范围，格式 "YYYY-MM-DD HH:mm"。范围尽量小，够用就行。\n' +
      '上一次没搜到时，换关键词、换数据种类或换时间范围再试，不要重复同样的搜索。action 为 "answer" 时其余字段可以留空。'
    );
  }

  function answerPrompt(question, history, searches) {
    return (
      `你是 LifeLens 的问答助手，根据用户电脑使用记录里检索到的内容回答问题。现在是 ${stamp(Date.now())}。\n\n` +
      `${buildIndex()}${describeHistory(history)}用户的问题：${question}\n\n检索到的内容：\n${describeSearches(searches)}\n\n` +
      '请根据每日索引和检索到的内容回答。要求：用简洁的中文纯文本，不要用 Markdown；提到具体事情时带上时间；' +
      '如果检索到的内容不足以回答，就直接说明没有找到相关记录，不要编造。'
    );
  }

  /* ---------- 主流程 ---------- */

  async function ask(question, history) {
    const config = getConfig();
    const text = String(question || '').trim();
    if (!text) throw new Error('问题不能为空');
    if (busy) throw new Error('上一个问题还在回答中');
    busy = true;
    const started = Date.now();
    const searches = [];
    try {
      while (searches.length < MAX_SEARCHES) {
        onProgress(searches.length ? '正在判断是否需要继续搜索…' : '正在分析问题…');
        const reply = await withModel(() => chatJson(config, getModelName(), stepPrompt(text, history, searches), 'qa_step', STEP_SCHEMA, 400));
        const step = extractJson(reply.answer);
        if (step.action !== 'search') break;
        const spec = SOURCES[step.source] || SOURCES.summary;
        onProgress(`第 ${searches.length + 1} 次搜索：在${spec.name}里找 ${(step.keywords || []).join('、') || '这段时间的全部内容'}…`);
        searches.push(await search(step));
      }

      onProgress('正在组织回答…');
      const model = config.model || getModelName() || 'default';
      const body = {
        model,
        messages: [{ role: 'user', content: answerPrompt(text, history, searches) }],
        max_tokens: Math.max(config.maxTokens, 1500),
        temperature: 0.3,
        stream: false,
      };
      if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
      const data = await withModel(() =>
        requestJson(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          body,
          apiKey: config.apiKey,
          timeoutMs: Math.max(config.requestTimeoutSec, 600) * 1000,
        })
      );
      let answer = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (Array.isArray(answer)) answer = answer.map((part) => part.text || '').join('');
      answer = String(answer || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      if (!answer) throw new Error('模型没有返回回答');
      return {
        answer,
        model: (data && data.model) || model,
        ms: Date.now() - started,
        searches: searches.map(({ results, ...rest }) => ({ ...rest, shown: results.length, results })),
      };
    } finally {
      busy = false;
    }
  }

  return { ask, buildIndex };
}

module.exports = { createQa, clampRange, pick, parseTime };
