/* “今日”页：今天的概况、接着上次的来、待办收件箱。依赖 renderer.js 的 api / $ / el，activity.js 的 CATEGORY_CLASS / showView */

const minutesText = formatMinutes; // 共用 renderer.js 里的实现

const clockText = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function categoryChips(byCategory) {
  const row = el('div', 'diary-stats');
  for (const name of ['工作', '学习', '娱乐', '社交']) {
    if (byCategory[name]) row.append(el('span', `chip cat ${CATEGORY_CLASS[name]}`, `${name} ${minutesText(byCategory[name])}`));
  }
  return row;
}

function projectList(projects) {
  const list = el('ol', 'today-projects');
  for (const project of projects) {
    const item = el('li');
    item.append(el('span', '', project.name), el('span', 'muted', minutesText(project.minutes)));
    list.append(item);
  }
  return list;
}

function linkButton(label, onClick) {
  const button = el('button', '', label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function todoItem(todo, closed) {
  const item = el('li', `todo${closed ? ' closed' : ''}`);
  const text = el('div', 'todo-text');
  text.append(el('span', '', todo.text));
  const seen = todo.count > 1 ? `出现过 ${todo.count} 次，最近一次 ${clockText(todo.lastSeen)}` : `出现于 ${clockText(todo.firstSeen)}`;
  text.append(el('span', 'muted', closed ? (todo.status === 'done' ? '已完成' : '已忽略') : seen));
  item.append(text);
  const actions = el('div', 'todo-actions');
  if (closed) {
    actions.append(linkButton('撤销', () => api.setTodo(todo.id, 'open')));
  } else {
    const done = linkButton('完成', () => api.setTodo(todo.id, 'done'));
    done.className = 'primary';
    const ignore = linkButton('忽略', () => api.setTodo(todo.id, 'ignored'));
    ignore.className = 'quiet';
    actions.append(done, ignore);
  }
  item.append(actions);
  return item;
}

async function loadToday() {
  const data = await api.today();

  // 今天
  // 最重要的一个数放在最上面、最大；旁边是时间分配，下面是具体项目
  if (data.today) {
    const hero = el('div', 'today-hero');
    const figure = el('div', 'today-figure');
    figure.append(el('p', 'muted', '今天实际在用电脑'), el('p', 'today-big', minutesText(data.today.minutes)));
    const split = el('div', 'today-split');
    const bar = el('div', 'cat-bar');
    for (const name of ['工作', '学习', '娱乐', '社交']) {
      const minutes = data.today.byCategory[name];
      if (!minutes) continue;
      const seg = el('i', `seg ${CATEGORY_CLASS[name]}`);
      seg.style.flexGrow = String(minutes);
      seg.title = `${name} ${minutesText(minutes)}`;
      bar.append(seg);
    }
    split.append(bar, categoryChips(data.today.byCategory));
    hero.append(figure, split);
    $('today-now').replaceChildren(hero, projectList(data.today.projects));
  } else {
    $('today-now').replaceChildren(
      el('p', 'muted', '今天实际在用电脑'),
      el('p', 'today-big', '—'),
      el('p', 'placeholder', '用上 10 分钟、并且模型在线之后，这里会显示今天的时间分配。')
    );
  }

  // 接着上次的来：没有之前的记录时整块不显示，不留一张空卡片
  $('today-prev').hidden = !data.previous;
  if (data.previous) {
    const p = data.previous;
    const head = el('div', 'section-head');
    head.append(el('h2', '', '接着上次的来'), el('span', 'muted', `${p.label} · 记录了 ${minutesText(p.minutes)}`));
    const prev = [head, el('p', 'muted', `${p.lastAt} 结束时在做的是`), el('p', 'today-last', p.lastProject)];
    if (p.highlight) prev.push(el('p', 'muted', `高光：${p.highlight}`));
    prev.push(projectList(p.projects));
    const actions = el('div', 'card-foot');
    actions.append(el('span'), linkButton(p.hasDiary ? `看${p.label}的日记` : `去生成${p.label}的日记`, () => showView('diary')));
    prev.push(actions);
    $('today-prev').replaceChildren(...prev);
  }

  // 待办收件箱
  const { open, closed } = data.todos;
  $('todo-open').replaceChildren(...open.map((todo) => todoItem(todo, false)));
  $('todo-empty').hidden = open.length > 0;
  $('todo-count').textContent = open.length ? `${open.length} 件待处理` : '';
  $('todo-closed').replaceChildren(...closed.map((todo) => todoItem(todo, true)));
  $('todo-closed-box').hidden = closed.length === 0;

  $('btn-snooze').textContent = data.snoozed ? '恢复今天的提醒' : '今天别再提醒';
  $('btn-snooze').dataset.snoozed = data.snoozed ? '1' : '';
  $('nudge-note').textContent = data.snoozed
    ? '今天不会再弹出提醒，明天自动恢复。'
    : `今天已提醒 ${data.sentToday} 次，每天最多 ${data.maxPerDay} 次。`;
}

$('btn-snooze').addEventListener('click', async () => {
  await api.snoozeNudges(!$('btn-snooze').dataset.snoozed);
  loadToday();
});
$('btn-test-nudge').addEventListener('click', () => api.testNudge());

document.addEventListener('view-open', (event) => {
  if (event.detail === 'today') loadToday();
});

let todayTimer = null;
const refreshTodaySoon = () => {
  if ($('view-today').hidden) return;
  clearTimeout(todayTimer);
  todayTimer = setTimeout(loadToday, 300);
};
api.onTodayChanged(refreshTodaySoon);
api.onSummariesChanged(refreshTodaySoon);
api.onOpenView((name) => showView(name)); // 点击系统通知时，主进程让界面切到对应的页

loadToday(); // “今日”是默认打开的页
