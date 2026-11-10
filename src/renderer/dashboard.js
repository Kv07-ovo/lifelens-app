/* “看板”标签页：按天 / 周 / 月 / 年的多维度图表。依赖 renderer.js 的 api / $ / el，activity.js 的 CATEGORY_CLASS */

const CATEGORY_ORDER = ['工作', '学习', '娱乐', '社交']; // 固定顺序，颜色跟着分类走，不随排名变
const SVG_NS = 'http://www.w3.org/2000/svg';

let dashPeriod = 'day';
let dashAnchor = Date.now();
let dashToken = 0;

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  return node;
}

function duration(minutes) {
  if (!minutes) return '0 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes / 60} 小时`;
}

const shortDuration = (minutes) => (minutes < 60 ? `${minutes}分` : `${+(minutes / 60).toFixed(1)}时`);
const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '0%');
const hm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const md = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

function card(title, subtitle, className) {
  const box = el('section', `glass chart-card ${className || ''}`.trim());
  const head = el('div', 'chart-head');
  head.append(el('h3', '', title));
  if (subtitle) head.append(el('span', 'muted', subtitle));
  box.append(head);
  return box;
}

function legend(names) {
  const list = el('ul', 'legend');
  for (const name of names) {
    const item = el('li');
    item.append(el('i', `swatch ${CATEGORY_CLASS[name]}`), document.createTextNode(name));
    list.append(item);
  }
  return list;
}

const emptyNote = (text) => el('p', 'placeholder chart-empty', text || '这段时间没有数据');

/* ---------- 指标卡 ---------- */

function statTiles(data) {
  const t = data.totals;
  const tiles = el('div', 'tiles');
  const tile = (label, value, note) => {
    const box = el('div', 'glass tile');
    box.append(el('span', 'tile-label', label), el('strong', 'tile-value', value));
    if (note) box.append(el('span', 'tile-note', note));
    tiles.append(box);
  };

  let delta = '';
  if (t.previousMinutes) {
    const diff = t.trackedMinutes - t.previousMinutes;
    delta = diff === 0 ? '与上一周期持平' : `比上一周期${diff > 0 ? '多' : '少'} ${duration(Math.abs(diff))}`;
  } else if (t.trackedMinutes) {
    delta = '上一周期没有记录';
  }
  tile('记录时长', duration(t.trackedMinutes), delta);

  const top = data.byCategory.find((c) => c.name === t.topCategory);
  tile('最主要的活动', t.topCategory || '—', top ? `${duration(top.minutes)}，占 ${percent(top.minutes, t.trackedMinutes)}` : '');
  tile('项目数', String(t.projectCount), t.appCount ? `用到 ${t.appCount} 个软件` : '');
  tile('最长连续专注', t.longestSession ? duration(t.longestSession.minutes) : '—', t.longestSession ? t.longestSession.project : '');
  tile('项目切换', `${t.switches} 次`, t.averageSession ? `平均每段专注 ${duration(t.averageSession)}` : '');
  tile('可能遗漏的待办', `${t.todoCount} 条`, data.period === 'day' ? (t.firstStart ? `活动时间 ${hm(t.firstStart)}–${hm(t.lastEnd)}` : '') : `${t.activeDays} 天有记录`);
  return tiles;
}

/* ---------- 分类占比（环形图） ---------- */

function categoryDonut(data) {
  const box = card('时间花在哪', '各类活动的时长占比');
  const total = data.totals.trackedMinutes;
  const parts = data.byCategory.filter((c) => c.minutes > 0);
  if (!parts.length) {
    box.append(emptyNote());
    return box;
  }

  const wrap = el('div', 'donut-wrap');
  const size = 190;
  const radius = 72;
  const width = 26;
  const circumference = 2 * Math.PI * radius;
  const gap = parts.length > 1 ? 3 : 0; // 相邻扇区之间留一条缝
  const chart = svg('svg', { viewBox: `0 0 ${size} ${size}`, class: 'donut', role: 'img', 'aria-label': '各类活动时长占比' });
  let offset = 0;
  for (const part of parts) {
    const length = (part.minutes / total) * circumference;
    const arc = svg('circle', {
      cx: size / 2,
      cy: size / 2,
      r: radius,
      fill: 'none',
      'stroke-width': width,
      'stroke-dasharray': `${Math.max(0, length - gap)} ${circumference}`,
      'stroke-dashoffset': -offset,
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
      class: `arc ${CATEGORY_CLASS[part.name]}`,
    });
    arc.dataset.tip = `${part.name}\n${duration(part.minutes)}（${percent(part.minutes, total)}）`;
    chart.append(arc);
    offset += length;
  }
  const center = svg('text', { x: size / 2, y: size / 2 - 4, 'text-anchor': 'middle', class: 'donut-value' });
  center.textContent = shortDuration(total);
  const caption = svg('text', { x: size / 2, y: size / 2 + 18, 'text-anchor': 'middle', class: 'donut-caption' });
  caption.textContent = '总记录时长';
  chart.append(center, caption);
  wrap.append(chart);

  // 图例直接带数值，颜色之外还有文字可读
  const list = el('ul', 'donut-legend');
  for (const name of CATEGORY_ORDER) {
    const part = data.byCategory.find((c) => c.name === name);
    const item = el('li');
    item.append(el('i', `swatch ${CATEGORY_CLASS[name]}`), el('span', 'name', name), el('span', 'value', duration(part.minutes)), el('span', 'share', percent(part.minutes, total)));
    list.append(item);
  }
  wrap.append(list);
  box.append(wrap);
  return box;
}

/* ---------- 堆叠柱状图（趋势 / 一天中的时段） ---------- */

function stackedColumns(title, subtitle, buckets, className) {
  const box = card(title, subtitle, className);
  const max = Math.max(...buckets.map((b) => b.total));
  if (!max) {
    box.append(emptyNote());
    return box;
  }
  // 纵轴取一个“整”的上限
  const steps = [10, 20, 30, 60, 120, 180, 240, 360, 480, 720, 960, 1440, 2880, 4320, 7200, 14400, 28800, 43200];
  const top = steps.find((s) => s >= max) || max;

  const plot = el('div', 'col-plot');
  const axis = el('div', 'col-axis');
  for (const value of [top, top / 2, 0]) axis.append(el('span', '', value ? shortDuration(value) : '0'));
  const area = el('div', 'col-area');
  for (const line of [0, 50, 100]) {
    const grid = el('i', 'grid-line');
    grid.style.bottom = `${line}%`;
    area.append(grid);
  }
  const columns = el('div', 'cols');
  const every = Math.ceil(buckets.length / 12); // 柱子多时隔几个才标一次刻度
  buckets.forEach((bucket, i) => {
    const col = el('div', 'col');
    const stack = el('div', 'col-stack');
    stack.style.height = `${(bucket.total / top) * 100}%`;
    for (const name of CATEGORY_ORDER) {
      if (!bucket[name]) continue;
      const seg = el('i', `seg ${CATEGORY_CLASS[name]}`);
      seg.style.flexGrow = String(bucket[name]);
      stack.append(seg);
    }
    col.append(stack);
    const tick = el('span', 'col-label', i % every === 0 ? bucket.label : '');
    col.append(tick);
    const lines = CATEGORY_ORDER.filter((name) => bucket[name]).map((name) => `${name} ${duration(bucket[name])}`);
    col.dataset.tip = bucket.total ? `${bucket.title}\n共 ${duration(bucket.total)}\n${lines.join('\n')}` : `${bucket.title}\n没有记录`;
    columns.append(col);
  });
  area.append(columns);
  plot.append(axis, area);
  box.append(plot, legend(CATEGORY_ORDER));
  return box;
}

/* ---------- 横向条形图（项目、软件） ---------- */

function barList(title, subtitle, rows, colored) {
  const box = card(title, subtitle);
  if (!rows.length) {
    box.append(emptyNote());
    return box;
  }
  const max = Math.max(...rows.map((r) => r.value));
  const list = el('ol', 'bars');
  for (const row of rows) {
    const item = el('li', 'bar-row');
    item.append(el('span', 'bar-name', row.name));
    const track = el('span', 'bar-track');
    const fill = el('i', `bar-fill ${colored && row.category ? CATEGORY_CLASS[row.category] : 'neutral'}`);
    fill.style.width = `${Math.max(2, (row.value / max) * 100)}%`;
    track.append(fill);
    item.append(track, el('span', 'bar-value', row.valueText));
    item.dataset.tip = row.tip;
    list.append(item);
  }
  box.append(list);
  if (colored) box.append(legend(CATEGORY_ORDER));
  return box;
}

/* ---------- 活跃时段热力图（星期 × 小时） ---------- */

function weekHourHeat(data) {
  const box = card('活跃时段', '一周里每天每个小时的记录时长，颜色越亮时间越长');
  const max = Math.max(...data.weekHour.flat());
  if (!max) {
    box.append(emptyNote());
    return box;
  }
  const grid = el('div', 'wh-grid');
  grid.append(el('span'));
  for (let h = 0; h < 24; h++) grid.append(el('span', 'wh-hour', h % 3 === 0 ? String(h).padStart(2, '0') : ''));
  data.weekHour.forEach((row, d) => {
    grid.append(el('span', 'wh-day', data.weekdays[d]));
    row.forEach((minutes, h) => {
      const cell = el('i', 'wh-cell');
      if (minutes) cell.style.setProperty('--v', String(0.18 + 0.82 * (minutes / max)));
      cell.dataset.tip = `${data.weekdays[d]} ${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59\n${minutes ? duration(minutes) : '没有记录'}`;
      grid.append(cell);
    });
  });
  box.append(grid);
  const scale = el('div', 'wh-scale');
  scale.append(el('span', 'muted', '少'));
  for (const v of [0.18, 0.4, 0.6, 0.8, 1]) {
    const cell = el('i', 'wh-cell');
    cell.style.setProperty('--v', String(v));
    scale.append(cell);
  }
  scale.append(el('span', 'muted', `多（最多 ${duration(max)}）`));
  box.append(scale);
  return box;
}

/* ---------- 当天时间轴 ---------- */

function dayStrip(data) {
  const box = card('当天时间轴', '每一格是 10 分钟，颜色表示活动类型');
  if (!data.hasData) {
    box.append(emptyNote());
    return box;
  }
  const strip = el('div', 'strip');
  for (const cell of data.dayStrip) {
    const node = el('i', `strip-cell ${cell.category ? CATEGORY_CLASS[cell.category] : ''}`.trim());
    node.dataset.tip = cell.category ? `${cell.time}\n${cell.category} · ${cell.project}` : `${cell.time}\n没有记录`;
    strip.append(node);
  }
  const hours = el('div', 'strip-hours');
  for (let h = 0; h <= 24; h += 3) hours.append(el('span', '', String(h).padStart(2, '0')));
  box.append(strip, hours, legend(CATEGORY_ORDER));
  return box;
}

/* ---------- 最长的专注时段 ---------- */

function focusSessions(data) {
  const box = card('最长的连续专注', '同一个项目不间断的时间段');
  if (!data.sessions.length) {
    box.append(emptyNote());
    return box;
  }
  const list = el('ol', 'sessions');
  for (const session of data.sessions) {
    const item = el('li');
    item.append(el('i', `swatch ${CATEGORY_CLASS[session.category] || ''}`));
    const text = el('div', 'session-text');
    text.append(el('strong', '', session.project));
    const when = data.period === 'day' ? `${hm(session.start)}–${hm(session.end)}` : `${md(session.start)} ${hm(session.start)}–${hm(session.end)}`;
    text.append(el('span', 'muted', `${when} · ${session.category || ''}`));
    item.append(text, el('span', 'session-value', duration(session.minutes)));
    list.append(item);
  }
  box.append(list);
  return box;
}

/* ---------- 组装 ---------- */

const TREND_TITLE = {
  day: ['一天的节奏', '每个小时的记录时长'],
  week: ['一周的节奏', '每天的记录时长'],
  month: ['一个月的节奏', '每天的记录时长'],
  year: ['一年的节奏', '每个月的记录时长'],
};

async function loadDashboard() {
  const token = ++dashToken;
  const data = await api.dashboard(dashPeriod, dashAnchor);
  if (token !== dashToken) return;
  $('dash-label').textContent = data.label;
  $('dash-next').disabled = data.nextAnchor > Date.now();
  $('dash-prev').dataset.anchor = data.previousAnchor;
  $('dash-next').dataset.anchor = data.nextAnchor;

  const body = $('dash-body');
  if (!data.hasData) {
    const empty = el('p', 'glass card placeholder', `${data.label} 没有记录。可以用上面的箭头切换到别的时间，或者换一个统计周期。`);
    body.replaceChildren(empty);
    return;
  }

  const grid = el('div', 'chart-grid');
  const [trendTitle, trendSub] = TREND_TITLE[data.period];
  grid.append(categoryDonut(data));
  grid.append(stackedColumns(trendTitle, trendSub, data.trend, 'wide'));
  if (data.period === 'day') grid.append(Object.assign(dayStrip(data), { className: 'glass chart-card full' }));
  grid.append(
    barList('项目专注时间', '花在每个项目上的时长，颜色是它的主要活动类型',
      data.projects.map((p) => ({
        name: p.name,
        value: p.minutes,
        valueText: shortDuration(p.minutes),
        category: p.category,
        tip: `${p.name}\n${duration(p.minutes)}（${percent(p.minutes, data.totals.trackedMinutes)}）${p.days > 1 ? `\n出现在 ${p.days} 天` : ''}`,
      })), true)
  );
  grid.append(
    barList('软件出现次数', '每个软件出现在多少个 10 分钟时间段里',
      data.apps.map((a) => ({
        name: a.name,
        value: a.count,
        valueText: `${a.count} 次`,
        tip: `${a.name}\n出现 ${a.count} 次，约 ${duration(a.count * 10)}${a.category ? `\n主要用于${a.category}` : ''}`,
      })), false)
  );
  grid.append(focusSessions(data));
  if (data.period !== 'day') {
    grid.append(stackedColumns('一天中的时段分布', '把这段时间里每天同一个小时的时长加在一起', data.hourly, 'wide'));
    grid.append(weekHourHeat(data));
  }

  body.replaceChildren(statTiles(data), grid);
}

/* ---------- 周期切换与翻页 ---------- */

for (const tab of document.querySelectorAll('.tab[data-period]')) {
  tab.addEventListener('click', () => {
    dashPeriod = tab.dataset.period;
    for (const other of document.querySelectorAll('.tab[data-period]')) other.classList.toggle('active', other === tab);
    loadDashboard();
  });
}
$('dash-prev').addEventListener('click', () => { dashAnchor = Number($('dash-prev').dataset.anchor); loadDashboard(); });
$('dash-next').addEventListener('click', () => { dashAnchor = Number($('dash-next').dataset.anchor); loadDashboard(); });
$('dash-now').addEventListener('click', () => { dashAnchor = Date.now(); loadDashboard(); });

document.addEventListener('view-open', (event) => {
  if (event.detail === 'dashboard') loadDashboard();
});

let dashTimer = null;
api.onSummariesChanged(() => {
  if ($('view-dashboard').hidden) return;
  clearTimeout(dashTimer);
  dashTimer = setTimeout(loadDashboard, 1500);
});

/* ---------- 悬停提示 ---------- */

const tip = $('tip');
$('view-dashboard').addEventListener('mousemove', (event) => {
  const target = event.target.closest('[data-tip]');
  if (!target) {
    tip.hidden = true;
    return;
  }
  tip.textContent = target.dataset.tip;
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  const x = Math.min(event.clientX + 14, window.innerWidth - box.width - 8);
  const y = event.clientY + 18 + box.height > window.innerHeight ? event.clientY - box.height - 10 : event.clientY + 18;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
});
$('view-dashboard').addEventListener('mouseleave', () => { tip.hidden = true; });
