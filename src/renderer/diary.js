/* “日记”标签页：日历 + 当天日记。依赖 renderer.js 里的 api / $ / el，activity.js 里的 CATEGORY_CLASS */

const dateText = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 默认打开前一天的日记
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
let diaryDate = dateText(yesterday);
let calYear = yesterday.getFullYear();
let calMonth = yesterday.getMonth() + 1;
let diaryToken = 0;

const minutesLabel = formatMinutes; // 共用 renderer.js 里的实现

/* ---------- 日历 ---------- */

async function loadCalendar() {
  const data = await api.diaryMonth(calYear, calMonth);
  if (data.year !== calYear || data.month !== calMonth) return;
  $('cal-title').textContent = `${calYear}年${calMonth}月`;

  const first = new Date(calYear, calMonth - 1, 1);
  const cells = [];
  for (let i = 0; i < (first.getDay() + 6) % 7; i++) cells.push(el('span', 'cal-blank'));

  for (const [date, info] of Object.entries(data.days)) {
    const day = el('button', 'cal-day', String(Number(date.slice(8))));
    day.type = 'button';
    day.dataset.date = date;
    let note = '没有记录';
    if (info.diary === 'done') { day.classList.add('done'); note = '已有日记'; }
    else if (info.diary === 'running' || info.diary === 'queued') { day.classList.add('busy'); note = '日记生成中'; }
    else if (info.diary === 'error') { day.classList.add('data'); note = '日记生成失败'; }
    else if (info.summaries) { day.classList.add('data'); note = '有记录，还没有日记'; }
    if (date === data.today) day.classList.add('today');
    if (date > data.today) day.disabled = true;
    if (date === diaryDate) day.classList.add('selected');
    day.title = `${date} ${note}`;
    day.setAttribute('aria-label', day.title);
    day.addEventListener('click', () => {
      diaryDate = date;
      for (const other of document.querySelectorAll('.cal-day')) other.classList.toggle('selected', other.dataset.date === date);
      loadDiary();
    });
    cells.push(day);
  }
  $('cal-grid').replaceChildren(...cells);
}

function moveMonth(step) {
  const d = new Date(calYear, calMonth - 1 + step, 1);
  calYear = d.getFullYear();
  calMonth = d.getMonth() + 1;
  loadCalendar();
}
$('cal-prev').addEventListener('click', () => moveMonth(-1));
$('cal-next').addEventListener('click', () => moveMonth(1));

/* ---------- 日记内容 ---------- */

function listSection(title, items, className) {
  const section = el('section', `diary-section ${className || ''}`.trim());
  section.append(el('h3', '', title));
  if (items && items.length) {
    const list = el('ul');
    for (const item of items) list.append(el('li', '', item));
    section.append(list);
  } else {
    section.append(el('p', 'placeholder', '无'));
  }
  return section;
}

function generateButton(label, primary) {
  const button = el('button', primary ? 'primary' : '', label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    await api.diaryGenerate(diaryDate);
  });
  return button;
}

async function loadDiary() {
  const token = ++diaryToken;
  const data = await api.diaryGet(diaryDate);
  if (token !== diaryToken) return;
  const page = $('diary-page');
  const when = new Date(`${diaryDate}T00:00:00`);

  const head = el('header', 'diary-head');
  const title = el('div');
  title.append(el('h2', '', `${when.getFullYear()}年${when.getMonth() + 1}月${when.getDate()}日`), el('p', 'muted', WEEKDAY_NAMES[when.getDay()]));
  head.append(title);
  const nodes = [head];

  if (data.state === 'running' || data.state === 'queued') {
    const note = el('p', 'placeholder');
    note.append(el('span', 'spinner'), document.createTextNode(data.state === 'running' ? '正在生成这一天的日记…' : '这一天的日记正在排队生成…'));
    nodes.push(note);
  } else if (data.state === 'done' && data.entry) {
    const entry = data.entry;
    head.append(generateButton('重新生成'));

    const stats = el('div', 'diary-stats');
    stats.append(el('span', 'chip', `记录了 ${minutesLabel(entry.stats.trackedMinutes)}`));
    for (const name of ['工作', '学习', '娱乐', '社交']) {
      const minutes = entry.stats.byCategory[name];
      if (minutes) stats.append(el('span', `chip cat ${CATEGORY_CLASS[name] || ''}`, `${name} ${minutesLabel(minutes)}`));
    }
    nodes.push(stats);

    const summary = el('section', 'diary-section');
    summary.append(el('h3', '', '简短总结'), el('p', 'diary-summary', entry.summary));
    nodes.push(summary);

    const main = el('section', 'diary-section');
    main.append(el('h3', '', '主要事项'));
    const items = el('ol', 'main-items');
    for (const item of entry.mainItems) {
      const li = el('li');
      li.append(el('strong', '', item.title));
      if (item.detail) li.append(el('p', '', item.detail));
      items.append(li);
    }
    main.append(items);
    nodes.push(main);

    nodes.push(listSection('高光', entry.highlights, 'highlight'));
    nodes.push(listSection('待办', entry.todos, 'todo'));
    nodes.push(listSection('优化建议', entry.suggestions));
    nodes.push(listSection('温馨提示', entry.reminders, 'reminder'));

    if (data.summaries > entry.sourceCount) {
      nodes.push(el('p', 'muted', `这一天后来又多了 ${data.summaries - entry.sourceCount} 段记录，可以点“重新生成”把它们写进日记。`));
    }
    nodes.push(el('p', 'muted diary-foot', `由 ${entry.model} 根据 ${entry.sourceCount} 段 10 分钟汇总生成`));
  } else if (data.state === 'error') {
    nodes.push(el('p', 'placeholder', `这一天的日记生成失败：${(data.entry && data.entry.error) || '未知错误'}`));
    head.append(generateButton('重试'));
  } else if (data.summaries) {
    const isToday = diaryDate === data.today;
    nodes.push(el('p', 'placeholder', isToday
      ? `今天还没过完，目前有 ${data.summaries} 段记录。日记会在明天自动生成，也可以现在先生成一版。`
      : `这一天有 ${data.summaries} 段记录，还没有生成日记。`));
    head.append(generateButton(isToday ? '现在生成' : '生成日记', true));
  } else {
    nodes.push(el('p', 'placeholder', diaryDate > data.today ? '这一天还没到。' : '这一天没有记录，所以没有日记。'));
  }
  page.replaceChildren(...nodes);
}

/* ---------- 打开与刷新 ---------- */

function refreshDiary() {
  loadCalendar();
  loadDiary();
}

document.addEventListener('view-open', (event) => {
  if (event.detail !== 'diary') return;
  // 每次打开都检查一遍：之前没生成日记的日子排队生成
  api.diaryEnsure();
  refreshDiary();
});

let diaryTimer = null;
api.onDiaryChanged(() => {
  if ($('view-diary').hidden) return;
  clearTimeout(diaryTimer);
  diaryTimer = setTimeout(refreshDiary, 300);
});

api.onState((state) => {
  const status = state.diary || { queued: 0, runningDate: null };
  $('diary-busy').hidden = !status.queued;
  $('diary-busy-text').textContent = status.runningDate
    ? `正在生成 ${status.runningDate} 的日记${status.queued > 1 ? `，还有 ${status.queued - 1} 天排队` : ''}`
    : `${status.queued} 天的日记等待生成${state.model.online ? '' : '（等模型上线）'}`;
});
