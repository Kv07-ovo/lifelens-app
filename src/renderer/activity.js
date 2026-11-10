/* “动态”标签页：热力图 + 时间线 + 软件标签 + 筛选。依赖 renderer.js 里的 api / $ / el */

const CATEGORY_CLASS = { 工作: 'cat-work', 学习: 'cat-study', 娱乐: 'cat-fun', 社交: 'cat-social' };
const PAGE_SIZE = 12;

const filter = { project: '', apps: [], from: null, to: null };
let nextBefore = null;
let hasMore = false;
let loading = false;
let queryToken = 0;
let selectedSlot = null;
let activityOpened = false;

/* ---------- 标签页切换 ---------- */

function showView(name) {
  for (const tab of document.querySelectorAll('.tab[data-view]')) {
    const active = tab.dataset.view === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    $(`view-${tab.dataset.view}`).hidden = !active;
  }
  if (name === 'activity' && !activityOpened) {
    activityOpened = true;
    refreshActivity(true);
  }
  // 日记、看板各自监听这个事件，在每次被打开时刷新
  document.dispatchEvent(new CustomEvent('view-open', { detail: name }));
}

for (const tab of document.querySelectorAll('.tab[data-view]')) {
  tab.addEventListener('click', () => showView(tab.dataset.view));
}

/* ---------- 一条汇总的展示（热力图详情和时间线共用） ---------- */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function renderSummary(entry, compact) {
  const box = el('article', 'summary');

  const head = el('div', 'meta');
  head.append(el('time', '', `${entry.date} ${entry.slot}`));
  head.append(el('span', `chip cat ${CATEGORY_CLASS[entry.category] || ''}`, entry.category));
  if (entry.device) head.append(el('span', 'chip', `来自 ${entry.device}`)); // 其他设备同步过来的记录
  box.append(head);

  const project = el('button', 'project', entry.project);
  project.type = 'button';
  project.title = '只看这个项目';
  project.addEventListener('click', () => {
    $('f-project').value = entry.project;
    applyFilters();
  });
  box.append(project);

  const description = el('p', `description${compact ? ' compact' : ''}`, entry.description);
  box.append(description);

  if (entry.apps && entry.apps.length) {
    const tags = el('div', 'tags');
    for (const app of entry.apps) tags.append(appTag(app));
    box.append(tags);
  }

  if (entry.todos && entry.todos.length) {
    const todo = el('div', 'todos');
    todo.append(el('h3', '', '可能遗漏的待办'));
    const list = el('ul');
    for (const item of entry.todos) list.append(el('li', '', item));
    todo.append(list);
    box.append(todo);
  }
  return box;
}

function appTag(name, count) {
  const active = filter.apps.some((a) => a.toLowerCase() === name.toLowerCase());
  const tag = el('button', `tag${active ? ' active' : ''}`, count ? `${name} · ${count}` : name);
  tag.type = 'button';
  tag.setAttribute('aria-pressed', String(active));
  tag.addEventListener('click', () => toggleApp(name));
  return tag;
}

/* ---------- 热力图 ---------- */

const STATE_TEXT = {
  running: '正在汇总…',
  queued: '排队等待汇总',
  waiting: '等这段时间的截图分析完再汇总',
  error: '汇总失败',
  skipped: '这段时间的截图没能分析出内容',
  none: '没有记录',
  current: '当前这 10 分钟还没结束',
  future: '',
};

async function loadHeatmap() {
  const columns = await api.heatmap();
  const nodes = columns.map((column) => {
    const col = el('div', 'heat-col');
    col.append(el('span', 'heat-hour', pad2(column.hour)));
    for (const cell of column.cells) {
      const dot = el('button', 'dot');
      dot.type = 'button';
      dot.dataset.id = cell.id;
      if (cell.state === 'done') dot.classList.add(CATEGORY_CLASS[cell.category] || 'st-none');
      else if (['running', 'queued', 'waiting'].includes(cell.state)) dot.classList.add('st-pending');
      else if (cell.state === 'error') dot.classList.add('st-error');
      else if (cell.state === 'current') dot.classList.add('st-current');
      else dot.classList.add('st-none');
      if (cell.state === 'running') dot.classList.add('st-running');
      if (cell.state === 'future') dot.disabled = true;
      if (cell.id === selectedSlot) dot.classList.add('selected');
      const what = cell.state === 'done' ? `${cell.category} · ${cell.project}` : STATE_TEXT[cell.state];
      dot.title = `${column.date} ${cell.label}${what ? `\n${what}` : ''}`;
      dot.setAttribute('aria-label', dot.title);
      dot.addEventListener('click', () => selectSlot(cell, column.date));
      col.append(dot);
    }
    return col;
  });
  $('heatmap').replaceChildren(...nodes);
}

async function selectSlot(cell, date) {
  selectedSlot = cell.id;
  for (const dot of document.querySelectorAll('#heatmap .dot')) {
    dot.classList.toggle('selected', dot.dataset.id === cell.id);
  }
  const detail = $('slot-detail');
  if (cell.state === 'done' || cell.state === 'error') {
    const entry = await api.getSummary(cell.id);
    if (selectedSlot !== cell.id) return;
    if (entry && entry.status === 'done') {
      detail.replaceChildren(renderSummary(entry, false));
      return;
    }
    const lines = [el('p', 'slot-time', `${date} ${cell.label}`), el('p', 'placeholder', `汇总失败：${(entry && entry.error) || '未知错误'}`)];
    detail.replaceChildren(...lines);
    return;
  }
  const note = el('p', 'placeholder');
  if (['running', 'queued', 'waiting'].includes(cell.state)) {
    note.append(el('span', 'spinner'), document.createTextNode(STATE_TEXT[cell.state]));
  } else {
    note.textContent = STATE_TEXT[cell.state];
  }
  detail.replaceChildren(el('p', 'slot-time', `${date} ${cell.label}`), note);
}

/* ---------- 筛选项：项目下拉、软件标签 ---------- */

async function loadFacets() {
  const { projects, apps } = await api.summaryFacets();

  const select = $('f-project');
  const current = filter.project;
  const all = el('option', '', '全部项目');
  all.value = '';
  const options = projects.map((p) => {
    const option = el('option', '', `${p.name}（${p.count}）`);
    option.value = p.name;
    return option;
  });
  select.replaceChildren(all, ...options);
  select.value = projects.some((p) => p.name === current) ? current : '';

  $('app-tags').replaceChildren(...apps.map((a) => appTag(a.name, a.count)));
  $('app-empty').hidden = apps.length > 0;
}

function renderActiveApps() {
  const chips = filter.apps.map((name) => {
    const tag = el('button', 'tag active', `${name} ×`);
    tag.type = 'button';
    tag.title = '取消这个软件筛选';
    tag.addEventListener('click', () => toggleApp(name));
    return tag;
  });
  $('f-apps').replaceChildren(...chips);
}

function toggleApp(name) {
  const key = name.toLowerCase();
  if (filter.apps.some((a) => a.toLowerCase() === key)) filter.apps = filter.apps.filter((a) => a.toLowerCase() !== key);
  else filter.apps = [...filter.apps, name];
  applyFilters();
}

function applyFilters() {
  filter.project = $('f-project').value;
  filter.from = $('f-from').value ? new Date($('f-from').value).getTime() : null;
  filter.to = $('f-to').value ? new Date($('f-to').value).getTime() : null;
  renderActiveApps();
  loadFacets();
  loadFeed(true);
}

$('f-project').addEventListener('change', applyFilters);
$('f-from').addEventListener('change', applyFilters);
$('f-to').addEventListener('change', applyFilters);
$('filters').addEventListener('submit', (event) => event.preventDefault());
$('f-clear').addEventListener('click', () => {
  $('f-project').value = '';
  $('f-from').value = '';
  $('f-to').value = '';
  filter.apps = [];
  applyFilters();
});

/* ---------- 时间线：向下滚动加载更多 ---------- */

async function loadFeed(reset) {
  if (loading && !reset) return;
  const token = ++queryToken;
  loading = true;
  $('feed-more').hidden = false;
  try {
    const result = await api.querySummaries({ ...filter, before: reset ? null : nextBefore, limit: PAGE_SIZE });
    if (token !== queryToken) return; // 筛选条件又变了，丢弃这次结果
    const items = result.items.map((entry) => {
      const li = el('li', 'glass feed-item');
      li.append(renderSummary(entry, true));
      return li;
    });
    if (reset) {
      $('feed-list').replaceChildren(...items);
      $('feed').scrollTop = 0;
      const filtered = filter.project || filter.apps.length || filter.from || filter.to;
      $('f-count').textContent = filtered ? `共 ${result.total} 段` : '';
      $('feed-empty').hidden = result.total > 0;
      $('feed-empty').textContent = filtered
        ? '没有符合筛选条件的记录。'
        : '还没有汇总。应用运行满 10 分钟、并且本地模型在线后，这里会出现每 10 分钟的活动。';
    } else {
      $('feed-list').append(...items);
    }
    nextBefore = result.nextBefore;
    hasMore = result.hasMore;
  } finally {
    if (token === queryToken) {
      loading = false;
      $('feed-more').hidden = true;
      // 第一页没填满可视区域时接着加载
      if (hasMore && $('feed').scrollHeight <= $('feed').clientHeight + 40) loadFeed(false);
    }
  }
}

$('feed').addEventListener('scroll', () => {
  const feed = $('feed');
  if (hasMore && !loading && feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 240) loadFeed(false);
});

/* ---------- 刷新 ---------- */

function refreshActivity(resetFeed) {
  loadHeatmap();
  loadFacets();
  // 用户正在往下翻时间线时不打断他，只有停在顶部才刷新列表
  if (resetFeed || $('feed').scrollTop < 40) loadFeed(true);
}

let refreshTimer = null;
api.onSummariesChanged(() => {
  if (!activityOpened) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshActivity(false), 400);
});

// 热力图按当前时间排列，每分钟对一次，保证跨过 10 分钟边界后列会前移
setInterval(() => {
  if (activityOpened && !$('view-activity').hidden) loadHeatmap();
}, 60000);
