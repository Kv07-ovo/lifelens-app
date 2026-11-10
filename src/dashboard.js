/**
 * 看板统计：按天 / 周 / 月 / 年，把 10 分钟汇总聚合成各种图表要用的数据。
 * 每条汇总代表 10 分钟。输入是汇总的轻量信息（时间、项目、分类、软件、待办数、截图数）。
 */
const { CATEGORIES } = require('./summarizer');

const SLOT_MIN = 10;
const HOUR_MS = 60 * 60 * 1000;
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const pad = (n) => String(n).padStart(2, '0');
const weekdayIndex = (d) => (d.getDay() + 6) % 7; // 周一 = 0

/** 某个周期包含 anchor 的那一段：[start, end)，以及标题和每个柱子的定义 */
function periodRange(period, anchor) {
  const a = new Date(anchor);
  const y = a.getFullYear();
  const m = a.getMonth();
  const d = a.getDate();
  if (period === 'week') {
    const start = new Date(y, m, d - weekdayIndex(a));
    const end = new Date(y, m, d - weekdayIndex(a) + 7);
    const last = new Date(end.getTime() - 1);
    return {
      start: start.getTime(),
      end: end.getTime(),
      label: `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 – ${last.getMonth() + 1}月${last.getDate()}日`,
      buckets: WEEKDAYS.map((name, i) => {
        const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        return { label: name, title: `${day.getMonth() + 1}月${day.getDate()}日 ${name}` };
      }),
      bucketOf: (t) => weekdayIndex(new Date(t)),
    };
  }
  if (period === 'month') {
    const days = new Date(y, m + 1, 0).getDate();
    return {
      start: new Date(y, m, 1).getTime(),
      end: new Date(y, m + 1, 1).getTime(),
      label: `${y}年${m + 1}月`,
      buckets: Array.from({ length: days }, (_, i) => ({ label: String(i + 1), title: `${m + 1}月${i + 1}日 ${WEEKDAYS[weekdayIndex(new Date(y, m, i + 1))]}` })),
      bucketOf: (t) => new Date(t).getDate() - 1,
    };
  }
  if (period === 'year') {
    return {
      start: new Date(y, 0, 1).getTime(),
      end: new Date(y + 1, 0, 1).getTime(),
      label: `${y}年`,
      buckets: Array.from({ length: 12 }, (_, i) => ({ label: `${i + 1}月`, title: `${y}年${i + 1}月` })),
      bucketOf: (t) => new Date(t).getMonth(),
    };
  }
  return {
    start: new Date(y, m, d).getTime(),
    end: new Date(y, m, d + 1).getTime(),
    label: `${y}年${m + 1}月${d}日 ${WEEKDAYS[weekdayIndex(a)]}`,
    buckets: Array.from({ length: 24 }, (_, i) => ({ label: pad(i), title: `${pad(i)}:00–${pad(i)}:59` })),
    bucketOf: (t) => new Date(t).getHours(),
  };
}

/** 往前 / 往后翻一个周期后的锚点时间 */
function shiftAnchor(period, anchor, step) {
  const a = new Date(anchor);
  if (period === 'week') return new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7 * step).getTime();
  if (period === 'month') return new Date(a.getFullYear(), a.getMonth() + step, 1).getTime();
  if (period === 'year') return new Date(a.getFullYear() + step, 0, 1).getTime();
  return new Date(a.getFullYear(), a.getMonth(), a.getDate() + step).getTime();
}

const emptyCategories = () => Object.fromEntries(CATEGORIES.map((c) => [c, 0]));

function dominant(byCategory) {
  let best = null;
  for (const c of CATEGORIES) if (byCategory[c] > 0 && (!best || byCategory[c] > byCategory[best])) best = c;
  return best;
}

/**
 * lightRange(from, to) -> 该时间范围内的汇总轻量信息，从旧到新
 */
function buildDashboard(lightRange, period, anchor) {
  const range = periodRange(period, anchor);
  const infos = lightRange(range.start, range.end);
  const previous = periodRange(period, shiftAnchor(period, anchor, -1));
  const previousMinutes = Math.round(lightRange(previous.start, previous.end).reduce((sum, info) => sum + info.minutes, 0));

  const byCategory = emptyCategories();
  const trend = range.buckets.map((b) => ({ ...b, total: 0, ...emptyCategories() }));
  const hourly = Array.from({ length: 24 }, (_, h) => ({ label: pad(h), title: `${pad(h)}:00–${pad(h)}:59`, total: 0, ...emptyCategories() }));
  const weekHour = WEEKDAYS.map(() => new Array(24).fill(0)); // [周几][小时] = 分钟
  const projects = new Map();
  const apps = new Map();
  const activeDays = new Set();
  let todoCount = 0;
  let recordCount = 0;

  // 连续专注：同一个项目、时间上首尾相接的若干个 10 分钟算一段
  const sessions = [];
  let run = null;
  let switches = 0;
  let previousInfo = null;

  for (const info of infos) {
    const when = new Date(info.start);
    const category = CATEGORIES.includes(info.category) ? info.category : null;
    if (category) {
      byCategory[category] += info.minutes;
      trend[range.bucketOf(info.start)][category] += info.minutes;
      hourly[when.getHours()][category] += info.minutes;
    }
    trend[range.bucketOf(info.start)].total += info.minutes;
    hourly[when.getHours()].total += info.minutes;
    weekHour[weekdayIndex(when)][when.getHours()] += info.minutes;
    activeDays.add(info.date);
    todoCount += info.todoCount || 0;
    recordCount += info.recordCount || 0;

    const project = projects.get(info.project) || { name: info.project, minutes: 0, byCategory: emptyCategories(), days: new Set() };
    project.minutes += info.minutes;
    if (category) project.byCategory[category] += info.minutes;
    project.days.add(info.date);
    projects.set(info.project, project);

    for (const app of info.apps || []) {
      const key = app.toLowerCase();
      const item = apps.get(key) || { name: app, count: 0, byCategory: emptyCategories() };
      item.count += 1;
      if (category) item.byCategory[category] += 1;
      apps.set(key, item);
    }

    const contiguous = previousInfo && info.start - previousInfo.end <= 0;
    if (run && contiguous && run.project === info.project) {
      run.minutes += info.minutes;
      run.end = info.end;
    } else {
      if (previousInfo && contiguous && previousInfo.project !== info.project) switches += 1;
      run = { project: info.project, category, start: info.start, end: info.end, minutes: info.minutes };
      sessions.push(run);
    }
    previousInfo = info;
  }

  const trackedMinutes = Math.round(infos.reduce((sum, info) => sum + info.minutes, 0));

  // 每段的活跃分钟数带小数，累加完之后统一取整再输出
  for (const name of CATEGORIES) byCategory[name] = Math.round(byCategory[name]);
  for (const bucket of [...trend, ...hourly]) {
    for (const name of CATEGORIES) bucket[name] = Math.round(bucket[name]);
    bucket.total = CATEGORIES.reduce((sum, name) => sum + bucket[name], 0);
  }
  for (const row of weekHour) row.forEach((value, i) => { row[i] = Math.round(value); });
  for (const project of projects.values()) project.minutes = Math.round(project.minutes);
  for (const session of sessions) session.minutes = Math.round(session.minutes);
  const projectList = [...projects.values()]
    .map((p) => ({ name: p.name, minutes: p.minutes, category: dominant(p.byCategory), days: p.days.size }))
    .sort((a, b) => b.minutes - a.minutes);
  const appList = [...apps.values()]
    .map((a) => ({ name: a.name, count: a.count, category: dominant(a.byCategory) }))
    .sort((a, b) => b.count - a.count);
  const longest = sessions.slice().sort((a, b) => b.minutes - a.minutes).slice(0, 6);
  const sessionMinutes = sessions.map((s) => s.minutes);

  // 当天的时间轴：144 个格子，每格 10 分钟
  let dayStrip = null;
  if (period === 'day') {
    const cells = new Map(infos.map((info) => [Math.round((info.start - range.start) / (SLOT_MIN * 60000)), info]));
    dayStrip = Array.from({ length: 144 }, (_, i) => {
      const info = cells.get(i);
      const time = `${pad(Math.floor(i / 6))}:${pad((i % 6) * 10)}`;
      return info ? { time, category: info.category, project: info.project } : { time, category: null, project: null };
    });
  }

  return {
    period,
    anchor,
    label: range.label,
    start: range.start,
    end: range.end,
    previousAnchor: shiftAnchor(period, anchor, -1),
    nextAnchor: shiftAnchor(period, anchor, 1),
    hasData: infos.length > 0,
    totals: {
      trackedMinutes,
      previousMinutes,
      activeDays: activeDays.size,
      projectCount: projectList.length,
      appCount: appList.length,
      todoCount,
      recordCount,
      switches,
      sessionCount: sessions.length,
      longestSession: longest[0] || null,
      averageSession: sessionMinutes.length ? Math.round(sessionMinutes.reduce((a, b) => a + b, 0) / sessionMinutes.length) : 0,
      topCategory: dominant(byCategory),
      firstStart: infos.length ? infos[0].start : null,
      lastEnd: infos.length ? infos[infos.length - 1].end : null,
    },
    byCategory: CATEGORIES.map((name) => ({ name, minutes: byCategory[name] })),
    trend,
    hourly,
    weekHour,
    weekdays: WEEKDAYS,
    projects: projectList.slice(0, 10),
    apps: appList.slice(0, 12),
    sessions: longest,
    dayStrip,
  };
}

module.exports = { buildDashboard, periodRange, shiftAnchor, HOUR_MS };
