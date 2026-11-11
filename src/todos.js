/**
 * 待办收件箱。
 *
 * 每个 10 分钟汇总里，模型都会列出“可能遗漏的待办”。以前它们只埋在记录里没人看；
 * 这里把它们收集起来：同一件事只留一条（去重）、可以勾掉或忽略、没处理的自动带到后面几天。
 *
 * 存储：<dataDir>/todos.json
 * 去重不调用模型，用字符二元组的相似度判断两句话是不是同一件事。
 */
const fs = require('fs/promises');
const path = require('path');

const HOUR_MS = 60 * 60 * 1000;
const SAME = 0.6; // 相似度达到这个值就认为是同一件事
const REOPEN_AFTER_MS = 6 * HOUR_MS; // 勾掉之后隔了这么久又被检测到，说明事情其实没做完，重新打开
const EXPIRE_AFTER_MS = 3 * 24 * HOUR_MS; // 这么久没再出现的待办自动过期，不再显示
const FORGET_CLOSED_AFTER_MS = 30 * 24 * HOUR_MS; // 完成、忽略或过期超过这么久的条目彻底清掉
const REMIND_AFTER_MS = 2 * HOUR_MS; // 出现这么久还没处理，可以提醒一次
const REMIND_AFTER_COUNT = 3; // 或者在这么多个时间段里都被检测到

/** 去掉空白和标点，只留下用来比较的内容 */
function normalize(text) {
  return String(text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(text) {
  const set = new Set();
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
  if (text.length < 2) set.add(text);
  return set;
}

function jaccard(x, y) {
  let common = 0;
  for (const item of x) if (y.has(item)) common += 1;
  return common / (x.size + y.size - common);
}

/**
 * 两句（已规范化的）话有多像，0 到 1。
 * 模型每次的措辞都可能不同，所以取两种重合度的平均：
 *   相邻两个字的组合 —— 对“是不是在说同一个东西”敏感
 *   用到的单个字     —— 不怕语序变化（“把报告补完”和“补完报告”）
 */
function similarity(a, b) {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))) return 0.9;
  return (jaccard(bigrams(a), bigrams(b)) + jaccard(new Set(a), new Set(b))) / 2;
}

function createTodos({ getConfig, onChange }) {
  let items = []; // { id, text, norm, status, firstSeen, lastSeen, count, sources, closedAt, notifiedAt }
  let counter = 0;
  let loaded = false; // 从磁盘读完之前不接受新待办
  let chain = Promise.resolve();

  const file = () => path.join(getConfig().dataDir, 'todos.json');

  function save() {
    const snapshot = JSON.stringify({ version: 1, items }, null, 2);
    const target = file();
    chain = chain
      .then(async () => {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(`${target}.tmp`, snapshot, 'utf8');
        await fs.rename(`${target}.tmp`, target);
      })
      .catch(() => {});
    return chain;
  }

  /** 收一条汇总里的待办，返回有没有变化（不写盘，由调用方统一写） */
  function ingestOne(entry) {
    if (!entry || entry.status !== 'done' || !Array.isArray(entry.todos)) return false;
    let changed = false;
    for (const text of entry.todos) {
      const norm = normalize(text);
      if (norm.length < 2) continue;
      // 取最相似的那一条，而不是第一条够相似的：列表里有几条相近的待办时才不会记到别的条目上
      let match = null;
      let best = SAME;
      for (const item of items) {
        const score = similarity(item.norm, norm);
        if (score >= best && (score > best || !match)) {
          match = item;
          best = score;
        }
      }
      if (!match) {
        items.push({
          id: `t${Date.now().toString(36)}${(counter += 1)}`,
          text: String(text).trim(),
          norm,
          textFrom: entry.id, // 显示的这句话出自哪条汇总；那条汇总被删除时，这条待办也要跟着删
          status: 'open',
          firstSeen: entry.startMs,
          lastSeen: entry.startMs,
          count: 1,
          sources: [entry.id],
          closedAt: null,
          notifiedAt: null,
        });
        changed = true;
        continue;
      }
      if (match.sources.includes(entry.id)) continue;
      match.sources.push(entry.id);
      if (match.sources.length > 200) match.sources.shift();
      match.count += 1;
      match.firstSeen = Math.min(match.firstSeen, entry.startMs);
      match.lastSeen = Math.max(match.lastSeen, entry.startMs);
      // 已经勾掉或过期，但隔了一段时间又被检测到：重新打开。被“忽略”的不再打开——用户明确说过不想看到它
      if ((match.status === 'done' || match.status === 'expired') && entry.startMs - (match.closedAt || 0) > REOPEN_AFTER_MS) {
        match.status = 'open';
        match.closedAt = null;
        match.notifiedAt = null;
      }
      changed = true;
    }
    return changed;
  }

  function expire(now) {
    let changed = false;
    for (const item of items) {
      if (item.status === 'open' && now - item.lastSeen > EXPIRE_AFTER_MS) {
        item.status = 'expired';
        item.closedAt = now;
        changed = true;
      }
    }
    return changed;
  }

  return {
    async load() {
      loaded = false;
      items = [];
      let text = null;
      try {
        text = await fs.readFile(file(), 'utf8');
      } catch (err) {
        // 文件不存在是正常的（第一次用）。其他读取错误（比如被占用）：保持“未加载”，
        // 这样不会接受新待办、也就不会把读不出来的原文件覆盖掉；下次启动或保存设置时会再读
        if (err.code !== 'ENOENT') return;
      }
      if (text !== null) {
        try {
          const data = JSON.parse(text);
          if (data && Array.isArray(data.items)) items = data.items;
        } catch {
          // 内容损坏：把坏文件改名保留，然后从空的收件箱开始
          await fs.rename(file(), `${file()}.corrupt-${Date.now()}`).catch(() => {});
        }
      }
      // 关掉很久的旧条目不再保留：文件不会无限变大，“忽略”也不会永久屏蔽以后相似的新待办
      const now = Date.now();
      items = items.filter((item) => item.status === 'open' || now - (item.closedAt || 0) < FORGET_CLOSED_AFTER_MS);
      loaded = true;
    },

    /**
     * 把 10 分钟汇总里的待办收进来，可以传一条或一批（一批只写一次盘）。同一条汇总重复调用不会重复计数。
     * 还没从磁盘加载完时什么都不做：否则会把“只有新收的这几条”写回去，覆盖掉磁盘上原有的待办。
     */
    ingest(entries) {
      if (!loaded) return false;
      let changed = false;
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        if (ingestOne(entry)) changed = true;
      }
      if (changed) {
        save();
        onChange();
      }
      return changed;
    },

    /** 给界面用：未处理的（最近出现的在前），以及最近处理掉的 */
    list() {
      const now = Date.now();
      if (expire(now)) save();
      const view = ({ norm, sources, ...rest }) => rest;
      return {
        open: items.filter((i) => i.status === 'open').sort((a, b) => b.lastSeen - a.lastSeen).map(view),
        closed: items
          .filter((i) => (i.status === 'done' || i.status === 'ignored') && now - (i.closedAt || 0) < 24 * HOUR_MS)
          .sort((a, b) => b.closedAt - a.closedAt)
          .map(view),
      };
    },

    openCount() {
      return items.filter((i) => i.status === 'open').length;
    },

    /** status: 'done'（做完了）| 'ignored'（不是我的事 / 别再提）| 'open'（撤销） */
    setStatus(id, status) {
      const item = items.find((i) => i.id === id);
      if (!item || !['done', 'ignored', 'open'].includes(status)) return false;
      item.status = status;
      item.closedAt = status === 'open' ? null : Date.now();
      save();
      onChange();
      return true;
    },

    /** 最该提醒的一条：没提醒过，并且已经挂了一阵子或被反复检测到；没有就返回 null */
    dueForReminder(now) {
      expire(now);
      const due = items
        .filter((i) => i.status === 'open' && !i.notifiedAt)
        .filter((i) => i.count >= REMIND_AFTER_COUNT || now - i.firstSeen >= REMIND_AFTER_MS)
        .filter((i) => now - i.lastSeen < 24 * HOUR_MS)
        .sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen)[0];
      return due ? { id: due.id, text: due.text, count: due.count } : null;
    },

    markNotified(id) {
      const item = items.find((i) => i.id === id);
      if (!item) return;
      item.notifiedAt = Date.now();
      save();
    },

    /** 用户删除了一段记录：只来自那些时间段的待办也一并删除（里面可能有敏感内容） */
    forgetSources(slotIds) {
      const gone = new Set(slotIds);
      const before = items.length;
      for (const item of items) {
        // 显示的那句话出自被删的汇总：整条删掉，不能让被删时间段的原文继续留在收件箱里。
        // 之后如果别的时间段再检测到这件事，会用那边的文字重新建一条。
        if (gone.has(item.textFrom || item.sources[0])) item.sources = [];
        else item.sources = item.sources.filter((id) => !gone.has(id));
      }
      items = items.filter((item) => item.sources.length > 0);
      if (items.length !== before) {
        save();
        onChange();
      }
      return before - items.length;
    },
  };
}

module.exports = { createTodos, normalize, similarity };
